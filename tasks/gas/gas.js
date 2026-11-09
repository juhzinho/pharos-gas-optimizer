#!/usr/bin/env node
// Gas Fee Optimizer for Pharos Pacific: watches the fee market, holds a non-urgent transaction until gas is favorable,
// and always sends it by its deadline — from a ladder of signed rungs (same nonce, rising fees), so the agent never
// holds a key and the transaction can never execute twice.
//   npm run gas -- market                         the fee market now: base fee, fullness, what others really pay
//   npm run gas -- queue request.json             a job: nonce, gas, the ladder to sign (to-sign.json)
//   npm run gas -- attach <dir> --signed s.json   the signed rungs (from a wallet that signs transactions), checked
//   npm run gas -- sign <dir>                     or sign them with SENDER_PRIVATE_KEY from .env (your own key)
//   npm run gas -- watch <dir> [--every 5]        tick until included / superseded (Ctrl+C is safe: run it again)
//   npm run gas -- tick <dir> [--dry]             one decision; --dry decides without broadcasting
//   npm run gas -- status <dir>                   the job, its log and the report (paid vs the price at request)
//   npm run gas -- demo                           the five scenarios on an Anvil fork
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { privateKeyToAccount } from "viem/accounts";
import { serializeTransaction } from "viem";
import { makeClient } from "../../lib/chain.js";
import { feeHistory, paidByOthers, snapshot } from "../../lib/market.js";
import { attach, openJob, queue, tick } from "../../lib/agent.js";

const USAGE = `usage: npm run gas -- market [--gas 21000]
       npm run gas -- queue <request.json> [--dir .gas/<name>]
       npm run gas -- attach <dir> --signed <signed.json>
       npm run gas -- sign <dir>                     (SENDER_PRIVATE_KEY in .env)
       npm run gas -- watch <dir> [--every <seconds>]
       npm run gas -- tick <dir> [--dry]
       npm run gas -- status <dir> [--json]
       npm run gas -- demo`;
const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c(1), dim = c(2), green = c(32), red = c(31), yellow = c(33);
const json = (x) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
const usage = (m) => Object.assign(new Error(m), { usage: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (existsSync(".env")) process.loadEnvFile(".env");
const [cmd, arg, ...rest] = process.argv.slice(2);
const flags = {};
try {
  const all = arg?.startsWith("--") ? [arg, ...rest] : rest;
  for (let i = 0; i < all.length; i++) {
    const k = all[i].replace(/^--/, "");
    if (!all[i].startsWith("--")) throw usage(`unexpected argument "${all[i]}"`);
    if (["dry", "json"].includes(k)) { flags[k] = true; continue; }
    if (!["gas", "dir", "signed", "every"].includes(k)) throw usage(`unknown flag --${k}`);
    const v = all[++i];
    if (v == null || v.startsWith("--")) throw usage(`--${k} needs a value`);
    flags[k] = v;
  }
  const pos = arg?.startsWith("--") ? null : arg;
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    process.exit(cmd ? 0 : 2);
  }
  const client = makeClient();
  const jobOf = (dir) => {
    if (!dir || !existsSync(`${dir}/job.json`)) throw usage(`no job at ${dir ?? "(none given)"} — create one with: npm run gas -- queue <request.json>`);
    return openJob(dir);
  };
  const asUsage = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      throw e.usage || /RPC|fetch|timeout|ECONN|429|cu limit/i.test(e.message) ? e : usage(e.message.split("\n")[0]);
    }
  };

  if (cmd === "demo") {
    execFileSync(process.execPath, ["scripts/fork-proof.js"], { stdio: "inherit" });
    process.exit(0);
  }
  if (cmd === "market") {
    const gas = Number(flags.gas ?? 21000);
    if (!Number.isInteger(gas) || gas < 21000) throw usage("--gas: whole units, at least 21,000");
    const now = await snapshot(client);
    const rows = await feeHistory(client, { blocks: 1024, head: BigInt(now.block) });
    const paid = await paidByOthers(client, rows);
    const base = rows.map((r) => r.baseFeeGwei);
    console.log(`\n${bold("Pharos Pacific fee market")} ${dim(`· block ${now.block} · ${new Date(now.time * 1000).toISOString()}`)}\n`);
    console.log(`  base fee now          ${now.baseFeeGwei} gwei   ${dim(`(eth_gasPrice ${now.gasPriceGwei}, suggested tip ${now.suggestedTipGwei})`)}`);
    console.log(`  last 1,024 blocks     base fee ${Math.min(...base)}–${Math.max(...base)} gwei · blocks at most ${(Math.max(...rows.map((r) => r.fullness)) * 100).toFixed(3)} % full`);
    console.log(`  what others paid      ${paid.txs} transactions · ${yellow(`${paid.overpaying} (${(paid.overpayingShare * 100).toFixed(1)} %) above the base fee`)} · ${paid.extraPros.toFixed(4)} PROS more than needed`);
    console.log(`                        effective price p50 ${paid.effective.p50} · p90 ${paid.effective.p90} · max ${paid.effective.max?.toFixed(2)} gwei · ${paid.zeroTipIncluded} included with tip 0`);
    const cost = (g) => `${((gas * g) / 1e9).toFixed(6)} PROS ($${(((gas * g) / 1e9) * now.prosUsd).toFixed(6)})`;
    console.log(`\n  ${gas.toLocaleString("en-US")} gas at the floor (tip 0): ${green(cost(now.baseFeeGwei))} · at others' p90: ${cost(paid.effective.p90 ?? now.baseFeeGwei)}\n`);
    process.exit(0);
  }
  if (cmd === "queue") {
    if (!pos || !existsSync(pos)) throw usage(`queue needs a request file${pos ? ` (not found: ${pos})` : ""}`);
    let raw;
    try {
      raw = JSON.parse(readFileSync(pos, "utf8"));
    } catch (e) {
      throw usage(`${pos} is not valid JSON (${e.message})`);
    }
    const dir = flags.dir ?? `.gas/${Date.now().toString(36)}`;
    if (existsSync(`${dir}/job.json`)) throw usage(`${dir} already holds a job`);
    const job = await asUsage(() => queue(openJob(dir), raw, { client }));
    writeFileSync(`${dir}/to-sign.json`, json(job.rungs.map((r) => ({ rung: r.rung, tx: r.unsigned, unsignedSerialized: serializeTransaction({ ...r.unsigned, type: "eip1559", value: BigInt(r.unsigned.value), gas: BigInt(r.unsigned.gas), maxFeePerGas: BigInt(r.unsigned.maxFeePerGas), maxPriorityFeePerGas: BigInt(r.unsigned.maxPriorityFeePerGas) }) }))));
    console.log(`\n${bold("Job queued")} ${dim(dir)}\n  ${job.request.from} → ${job.request.to} · nonce ${job.nonce} · gas ${Number(job.gas).toLocaleString("en-US")}\n  deadline ${new Date(job.request.deadline * 1000).toISOString()} · target ${job.targetGwei} gwei · base fee now ${job.atRequest.baseFeeGwei} gwei\n`);
    for (const r of job.rungs) console.log(`  rung ${r.rung}  max ${String(r.maxFeeGwei).padEnd(10)} tip ${r.tipGwei} gwei`);
    console.log(`\n  worst case (top rung, all gas used): ${job.worstCasePros.toFixed(6)} PROS\n  sign every rung (${dir}/to-sign.json), then: npm run gas -- attach ${dir} --signed <file>   (or: sign ${dir})`);
    process.exit(0);
  }
  if (!["attach", "sign", "watch", "tick", "status"].includes(cmd)) throw usage(`unknown command “${cmd}”`);
  const store = jobOf(pos);
  if (cmd === "attach" || cmd === "sign") {
    let raws;
    if (cmd === "attach") {
      if (!flags.signed || !existsSync(flags.signed)) throw usage("attach needs --signed <file with a JSON array of signed transactions>");
      try {
        raws = JSON.parse(readFileSync(flags.signed, "utf8"));
      } catch (e) {
        throw usage(`${flags.signed} is not valid JSON (${e.message})`);
      }
    } else {
      if (!/^0x[0-9a-fA-F]{64}$/.test(process.env.SENDER_PRIVATE_KEY ?? "")) throw usage("SENDER_PRIVATE_KEY is not set in .env (0x + 64 hex characters) — see .env.example");
      const acct = privateKeyToAccount(process.env.SENDER_PRIVATE_KEY);
      const job = store.load();
      if (acct.address !== job.request.from) throw usage(`SENDER_PRIVATE_KEY is ${acct.address}, but the job's sender is ${job.request.from}`);
      raws = await Promise.all(job.rungs.map((r) => acct.signTransaction({ ...r.unsigned, type: "eip1559", value: BigInt(r.unsigned.value), gas: BigInt(r.unsigned.gas), maxFeePerGas: BigInt(r.unsigned.maxFeePerGas), maxPriorityFeePerGas: BigInt(r.unsigned.maxPriorityFeePerGas), nonce: Number(r.unsigned.nonce) })));
    }
    await asUsage(() => attach(store, raws));
    console.log(`${raws.length} signed rungs checked (each is exactly its rung, signed by the sender) — the job is held. Next: npm run gas -- watch ${pos}`);
    process.exit(0);
  }
  if (cmd === "status") {
    const job = store.load();
    if (flags.json) { console.log(json({ job, log: store.log() })); process.exit(0); }
    console.log(`\n${bold(job.request.label ?? "Job")} ${dim(pos)} · ${job.state.toUpperCase()}\n  deadline ${new Date(job.request.deadline * 1000).toISOString()} · target ${job.targetGwei} gwei · at request ${job.atRequest.baseFeeGwei} gwei (block ${job.atRequest.block})`);
    for (const e of store.log().filter((x) => x.type !== "tick" || x.action !== "wait").slice(-15)) console.log(dim(`  ${e.at.slice(11, 19)}  ${e.type.padEnd(6)} ${e.block ?? ""} ${e.baseFeeGwei != null ? `${e.baseFeeGwei} gwei` : ""} ${e.action ?? ""} ${e.reason ?? e.error ?? ""}`));
    if (job.result) {
      const r = job.result;
      console.log(`\n  ${green(bold("Included"))} block ${r.block} · rung ${r.rung} · ${r.hash}\n  paid ${bold(`${r.paidGwei} gwei`)} vs ${r.atRequest.priceGwei} gwei at request (${r.vsRequestPct >= 0 ? "+" : ""}${r.vsRequestPct.toFixed(1)} %) · fee ${r.feePros.toFixed(6)} PROS · waited ${r.waitedSeconds} s · ${r.deadlineMet ? green(`${r.secondsBeforeDeadline} s before the deadline`) : red("AFTER the deadline")}`);
    }
    process.exit(0);
  }
  const once = async () => {
    const r = await tick(store, { client, send: !flags.dry, log: (m) => console.log(dim(`  · ${m}`)) });
    const d = r.decision;
    const col = d.action === "done" ? green : d.action === "hold" || d.action === "wait" ? yellow : d.action === "superseded" || d.action === "missed" ? red : bold;
    console.log(`${dim(`block ${r.market?.block ?? "-"} · ${r.market?.baseFeeGwei ?? "-"} gwei`)}  ${col(d.action.toUpperCase())}${d.rung != null ? ` rung ${d.rung}` : ""}  ${d.reason}${flags.dry && ["submit", "replace"].includes(d.action) ? dim("  (dry run: not sent)") : ""}`);
    return d.action;
  };
  if (cmd === "tick") {
    const a = await asUsage(once);
    process.exit(a === "missed" ? 3 : 0);
  }
  const every = Number(flags.every ?? 5);
  if (!(every >= 1 && every <= 600)) throw usage("--every: 1 to 600 seconds");
  for (;;) {
    const a = await asUsage(once);
    if (["done", "superseded", "missed"].includes(a)) process.exit(a === "missed" ? 3 : 0);
    await sleep(every * 1000);
  }
} catch (e) {
  console.error(`error: ${String(e.message).split("\n")[0]}`);
  if (e.usage) console.error(`\n${USAGE}`);
  process.exit(e.usage ? 2 : 1);
}
