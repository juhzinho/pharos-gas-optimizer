import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { formatEther, keccak256, parseTransaction, recoverTransactionAddress } from "viem";
import { buildLadder, gweiOf, validateRequest, worstCaseWei } from "./ladder.js";
import { decide } from "./policy.js";
import { feeHistory, snapshot } from "./market.js";

// A job: one transaction to send by a deadline, its fee ladder, and a log written before every action.
//   .gas/<id>/job.json   the request, the market when it was made, the rungs (unsigned, then signed)
//   .gas/<id>/log.jsonl  every tick: block, base fee, the decision and why — the price history the job lived through
// Each tick reads the chain, decides (lib/policy.js) and, when it is time, broadcasts the chosen rung's signed bytes.

const json = (x) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));

export function openJob(dir) {
  mkdirSync(dir, { recursive: true });
  const jf = join(dir, "job.json"), lf = join(dir, "log.jsonl");
  return {
    dir,
    exists: () => existsSync(jf),
    load: () => {
      if (!existsSync(jf)) throw new Error(`no job in ${dir} (create one with: npm run gas -- queue <request.json>)`);
      return JSON.parse(readFileSync(jf, "utf8"));
    },
    save: (job) => writeFileSync(jf, json(job)),
    log: () => (existsSync(lf) ? readFileSync(lf, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    append(e) {
      const fd = openSync(lf, "a");
      try {
        writeSync(fd, `${json({ at: new Date().toISOString(), ...e })}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
  };
}

/** Creates a job: the market now, the sender's next nonce, the gas, the ladder to sign. */
export async function queue(store, raw, { client, lastCallSeconds = 60, stallBlocks = 5 } = {}) {
  const req = validateRequest(raw);
  const now = await snapshot(client);
  if (req.deadline <= now.time + lastCallSeconds) throw new Error(`the deadline is too close: it must be more than ${lastCallSeconds} s after the chain's current time (${new Date(now.time * 1000).toISOString()})`);
  const recent = await feeHistory(client, { blocks: 1024 });
  const floorGwei = Math.min(...recent.map((r) => r.baseFeeGwei));
  const nonce = await client.getTransactionCount({ address: req.from, blockTag: "pending" });
  const est = req.gas ?? (await client.estimateGas({ account: req.from, to: req.to, data: req.data, value: BigInt(req.value) }));
  const gas = req.gas ?? (est * 12n) / 10n;
  const ladder = buildLadder(req, { nonce, gas, floorGwei: Math.min(floorGwei, now.baseFeeGwei) });
  const job = {
    request: { ...req, gas: gas.toString() },
    nonce, gas: gas.toString(), lastCallSeconds, stallBlocks,
    targetGwei: req.targetGwei ?? floorGwei,
    atRequest: { block: now.block, time: now.time, baseFeeGwei: now.baseFeeGwei, gasPriceGwei: now.gasPriceGwei, suggestedTipGwei: now.suggestedTipGwei, prosUsd: now.prosUsd, floorGwei, maxBaseFeeGwei: Math.max(...recent.map((r) => r.baseFeeGwei)) },
    worstCasePros: Number(formatEther(worstCaseWei(ladder))),
    rungs: ladder.map((r) => ({ rung: r.rung, maxFeeGwei: gweiOf(r.maxFeePerGas), tipGwei: gweiOf(r.maxPriorityFeePerGas), unsigned: r.tx, raw: null, hash: null })),
    submissions: [],
    state: "unsigned",
  };
  store.save(job);
  store.append({ type: "queued", block: now.block, baseFeeGwei: now.baseFeeGwei, nonce, gas: gas.toString(), rungs: job.rungs.length });
  return job;
}

/** Stores the signed rungs after checking each one is exactly its rung, signed by the sender. */
export async function attach(store, raws) {
  const job = store.load();
  if (!Array.isArray(raws) || raws.length !== job.rungs.length) throw new Error(`expected ${job.rungs.length} signed transactions, one per rung (got ${Array.isArray(raws) ? raws.length : 0})`);
  for (const [i, raw] of raws.entries()) {
    let tx;
    try {
      tx = parseTransaction(raw);
    } catch {
      throw new Error(`rung ${i}: not a signed transaction`);
    }
    const u = job.rungs[i].unsigned;
    // a zero field (tip 0, value 0, empty data) comes back from parseTransaction as undefined
    const n = (v) => BigInt(v ?? 0n);
    const same = tx.type === "eip1559" && tx.chainId === u.chainId && (tx.nonce ?? 0) === Number(u.nonce) && tx.to?.toLowerCase() === u.to.toLowerCase() && (tx.data ?? "0x") === u.data && n(tx.value) === n(u.value) && n(tx.gas) === n(u.gas) && n(tx.maxFeePerGas) === n(u.maxFeePerGas) && n(tx.maxPriorityFeePerGas) === n(u.maxPriorityFeePerGas);
    if (!same) throw new Error(`rung ${i}: the signed transaction differs from the rung (to, data, value, gas, nonce or fees)`);
    const signer = await recoverTransactionAddress({ serializedTransaction: raw });
    if (signer !== job.request.from) throw new Error(`rung ${i}: signed by ${signer}, not the sender ${job.request.from}`);
    job.rungs[i].raw = raw;
    job.rungs[i].hash = keccak256(raw);
  }
  job.state = "held";
  store.save(job);
  store.append({ type: "signed", rungs: raws.length });
  return job;
}

/** One tick: read, decide, act. `send: false` decides and logs without broadcasting (a dry run). */
export async function tick(store, { client, send = true, log = () => {} } = {}) {
  const job = store.load();
  if (["done", "superseded", "missed"].includes(job.state)) return { job, decision: { action: job.state, reason: "already settled" } };
  if (!job.rungs.every((r) => r.raw)) throw new Error("the rungs are not signed yet (attach or sign them first)");
  const head = await client.getBlock();
  const baseFeeGwei = gweiOf(head.baseFeePerGas ?? 0n);
  const [senderNonce, receipts] = await Promise.all([
    client.getTransactionCount({ address: job.request.from, blockTag: "latest" }),
    // every rung's receipt, not only the ones this agent recorded: a crash between sending and logging cannot fool it
    Promise.all(job.rungs.map((r) => client.getTransactionReceipt({ hash: r.hash }).catch(() => null))),
  ]);
  const minedIdx = receipts.findIndex(Boolean);
  const mined = minedIdx >= 0 ? { rung: job.rungs[minedIdx].rung, status: receipts[minedIdx].status } : null;
  const m = { now: Number(head.timestamp), block: Number(head.number), baseFeeGwei, senderNonce, jobNonce: job.nonce, mined };
  const d = decide({ deadline: job.request.deadline, targetGwei: job.targetGwei, lastCallSeconds: job.lastCallSeconds, stallBlocks: job.stallBlocks, rungs: job.rungs, submissions: job.submissions }, m);
  store.append({ type: "tick", block: m.block, time: m.now, baseFeeGwei, action: d.action, rung: d.rung ?? null, reason: d.reason });

  if (d.action === "done") {
    const rc = receipts[minedIdx];
    const blk = await client.getBlock({ blockNumber: rc.blockNumber });
    job.state = "done";
    job.result = report(job, { rung: mined.rung, hash: rc.transactionHash, block: Number(rc.blockNumber), time: Number(blk.timestamp), status: rc.status, gasUsed: rc.gasUsed.toString(), effectiveGasPrice: rc.effectiveGasPrice.toString() });
    store.save(job);
    store.append({ type: "done", ...job.result });
    return { job, decision: d, market: m };
  }
  if (d.action === "superseded" || d.action === "missed") {
    job.state = d.action;
    store.save(job);
    return { job, decision: d, market: m };
  }
  if ((d.action === "submit" || d.action === "replace") && send) {
    const r = job.rungs.find((x) => x.rung === d.rung);
    store.append({ type: "send", rung: r.rung, hash: r.hash, block: m.block, baseFeeGwei, why: d.why }); // intent before it leaves
    let err = null;
    await client.request({ method: "eth_sendRawTransaction", params: [r.raw] }).catch((e) => (err = String(e.details ?? e.shortMessage ?? e.message).split("\n")[0]));
    if (err && !/already known|known transaction|already imported/i.test(err)) {
      store.append({ type: "send-error", rung: r.rung, error: err });
      log(`rung ${r.rung}: the node refused it — ${err}`);
      return { job, decision: { ...d, error: err }, market: m };
    }
    job.submissions.push({ rung: r.rung, hash: r.hash, block: m.block, time: m.now, baseFeeGwei, why: d.why });
    job.state = "sent";
    store.save(job);
    log(`rung ${r.rung} sent (${d.reason})`);
  }
  return { job, decision: d, market: m };
}

/** Actual price paid vs the price when the transaction was handed over, and vs what others paid then. */
export function report(job, inc) {
  const paid = gweiOf(BigInt(inc.effectiveGasPrice));
  const a = job.atRequest;
  // "the price at request time" = the network's price per gas in the block the job was queued: its base fee (a
  // transaction with no tip pays exactly that). The node's own suggestion (eth_gasPrice) is kept beside it.
  const feePros = (Number(inc.gasUsed) * paid) / 1e9;
  const atRequestPros = (Number(inc.gasUsed) * a.baseFeeGwei) / 1e9;
  return {
    ...inc, paidGwei: paid, feePros, feeUsd: feePros * (a.prosUsd || 0),
    atRequest: { priceGwei: a.baseFeeGwei, nodeSuggestedGwei: a.gasPriceGwei, feePros: atRequestPros },
    vsRequestPct: a.baseFeeGwei ? ((paid - a.baseFeeGwei) / a.baseFeeGwei) * 100 : 0, // negative = paid less than at request
    waitedSeconds: inc.time - a.time, waitedBlocks: inc.block - a.block,
    deadlineMet: inc.time <= job.request.deadline, secondsBeforeDeadline: job.request.deadline - inc.time,
    rungsSent: job.submissions.length,
  };
}
