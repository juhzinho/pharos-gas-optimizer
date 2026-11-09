// The optimizer on an Anvil fork of Pharos Pacific, block by block, with real receipts.
// Pacific's base fee has been a flat 10 gwei (see public/runs/market.json), so to show holding and the deadline the
// fork's base fee is SET per block with anvil_setNextBlockBaseFeePerGas — an injected fee path, labelled as such.
// Blocks are mined by this script (automine off), 10 s of chain time apart. A fresh test key (fork only) is the sender
// and signs the ladder; the agent only chooses which signed rung to broadcast and when.
//   A  calm:                 base fee at the floor → sent at once, tip 0
//   B  spike, then calm:     queued at 60 gwei → held while it falls → sent at the floor
//   C  spike to the deadline: 80 gwei throughout → held, then sent at the last call → included before the deadline
//   D  priced out in flight: sent at 10, the base fee jumps to 14 → replaced by the next rung (same nonce), included once
//   E  the sender moves on:   the sender uses the nonce for something else → superseded, nothing sent
// Writes .gas-proof/fork-proof.json; with --record, public/runs/fork-proof.json.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createPublicClient, createWalletClient, http, parseGwei, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { startFork } from "../lib/fork.js";
import { CHAIN_ID } from "../lib/contracts.js";

const fork = await startFork({ port: Number(process.env.FORK_PORT ?? 8555) });
process.env.PHAROS_RPC_URL = fork.url;
const { makeClient } = await import("../lib/chain.js");
const { openJob, queue, attach, tick } = await import("../lib/agent.js");

const chain = { id: CHAIN_ID, name: "Pacific fork", nativeCurrency: { name: "PROS", symbol: "PROS", decimals: 18 }, rpcUrls: { default: { http: [fork.url] } } };
const pub = createPublicClient({ chain, transport: http(fork.url, { timeout: 120_000 }) });
const rpc = (method, params = []) => pub.request({ method, params });
const client = makeClient();
const log = (m) => console.log(m);
const DIR = ".gas-proof";
await rm(DIR, { recursive: true, force: true });
const out = { recordedAt: new Date().toISOString(), network: "Anvil fork of Pharos Pacific", note: "test wallet funded on the fork only; the base fee per block is injected (anvil_setNextBlockBaseFeePerGas) to show holding and the deadline — Pacific's own base fee has been a flat 10 gwei", scenarios: [] };

let clock;
/** Mines one block 10 s after the previous one, with the given base fee. */
async function mine(baseGwei) {
  clock += 10;
  await rpc("anvil_setNextBlockBaseFeePerGas", [toHex(parseGwei(String(baseGwei)))]);
  await rpc("evm_setNextBlockTimestamp", [toHex(clock)]);
  await rpc("evm_mine");
}

async function scenario(key, title, fees, { deadlineIn = 600, cap = 200, interfere } = {}) {
  const account = privateKeyToAccount(generatePrivateKey());
  await rpc("anvil_setBalance", [account.address, "0x56BC75E2D63100000"]);
  const wallet = createWalletClient({ account, chain, transport: http(fork.url) });
  await mine(fees[0]);
  const head = await pub.getBlock();
  const store = openJob(`${DIR}/${key}`);
  const request = { label: title, from: account.address, to: "0x1111111111111111111111111111111111111111", value: "1000000000000000", deadline: new Date((Number(head.timestamp) + deadlineIn) * 1000).toISOString().replace(".000Z", "Z"), capGwei: cap };
  const job = await queue(store, request, { client, lastCallSeconds: 60, stallBlocks: 3 });
  const raws = await Promise.all(job.rungs.map((r) => account.signTransaction({ ...r.unsigned, type: "eip1559", value: BigInt(r.unsigned.value), gas: BigInt(r.unsigned.gas), maxFeePerGas: BigInt(r.unsigned.maxFeePerGas), maxPriorityFeePerGas: BigInt(r.unsigned.maxPriorityFeePerGas), nonce: Number(r.unsigned.nonce) })));
  await attach(store, raws);
  const trace = [];
  let res;
  for (let i = 1; i < 200; i++) {
    res = await tick(store, { client });
    trace.push({ block: res.market?.block, time: res.market?.now, baseFeeGwei: res.market?.baseFeeGwei, action: res.decision.action, rung: res.decision.rung ?? null, reason: res.decision.reason });
    if (["done", "superseded", "missed"].includes(res.decision.action)) break;
    if (interfere && i === interfere.atTick) {
      // the sender's own wallet uses the same nonce for something else
      await wallet.sendTransaction({ to: account.address, value: 0n, nonce: job.nonce, maxFeePerGas: parseGwei("150"), maxPriorityFeePerGas: parseGwei("1") });
    }
    await mine(fees[Math.min(i, fees.length - 1)]);
  }
  const final = store.load();
  const s = { key, title, request: { deadline: request.deadline, capGwei: cap, queuedBlock: job.atRequest.block, priceAtRequestGwei: job.atRequest.baseFeeGwei }, ladder: job.rungs.map((r) => ({ rung: r.rung, maxFeeGwei: r.maxFeeGwei, tipGwei: r.tipGwei })), trace, state: final.state, result: final.result ?? null, submissions: final.submissions };
  // only one rung can ever be included: check every rung's receipt
  const included = (await Promise.all(final.rungs.map((r) => pub.getTransactionReceipt({ hash: r.hash }).catch(() => null)))).filter(Boolean);
  s.rungsIncluded = included.length;
  out.scenarios.push(s);
  const r = final.result;
  log(`${key}. ${title}\n   ${trace.filter((t) => t.action !== "wait").map((t) => `${t.baseFeeGwei}g:${t.action}${t.rung != null ? `#${t.rung}` : ""}`).join(" → ")}\n   ${final.state}${r ? ` · paid ${r.paidGwei} gwei vs ${r.atRequest.priceGwei} at request (${r.vsRequestPct >= 0 ? "+" : ""}${r.vsRequestPct.toFixed(1)}%) · ${r.secondsBeforeDeadline} s before the deadline · rungs sent ${r.rungsSent} · included ${s.rungsIncluded}` : ` · rungs included ${s.rungsIncluded}`}`);
}

try {
  await rpc("evm_setAutomine", [false]);
  clock = Number((await pub.getBlock()).timestamp);
  out.forkBlock = Number((await pub.getBlock()).number);
  await scenario("A", "Calm: the base fee is at the floor", [10]);
  await scenario("B", "A spike, then calm: held, sent at the floor", [60, 60, 52, 45, 38, 31, 25, 19, 14, 10, 10]);
  await scenario("C", "A spike that lasts to the deadline: sent at the last call", [80], { deadlineIn: 300 });
  await scenario("D", "Priced out after sending: replaced by the next rung", [10, 14, 14, 14]);
  await scenario("E", "The sender uses the nonce for something else: superseded", [60], { interfere: { atTick: 3 } });
  const target = process.argv.includes("--record") ? "public/runs/fork-proof.json" : `${DIR}/fork-proof.json`;
  await mkdir(DIR, { recursive: true });
  await writeFile(target, JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  log(`wrote ${target}`);
} finally {
  fork.stop();
}
process.exit(0);
