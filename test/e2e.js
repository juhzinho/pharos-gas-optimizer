// End-to-end, live on Pharos Pacific Mainnet (read-only: the test sender is a fresh key; nothing is broadcast).
//   node test/e2e.js           mainnet checks (~1–2 min)
//   node test/e2e.js --fork    + the five scenarios on an Anvil fork (scripts/fork-proof.js)
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { makeClient } from "../lib/chain.js";
import { feeHistory, longHistory, snapshot } from "../lib/market.js";
import handler from "../api/market.js";

const root = new URL("..", import.meta.url);
const client = makeClient();
const cli = (args, env = {}) => spawnSync(process.execPath, ["tasks/gas/gas.js", ...args], { encoding: "utf8", cwd: root, env: { ...process.env, SENDER_PRIVATE_KEY: "", ...env } });
let failed = 0;
async function check(name, fn) {
  const t = Date.now();
  try {
    await fn();
    console.log(`✓ ${name} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name}\n   ${e.message}`);
  }
}

await check("the market, live: head base fee, 1,024 blocks of history, 30 days sampled", async () => {
  const s = await snapshot(client);
  assert.ok(s.block > 22_000_000 && s.baseFeeGwei > 0 && s.gasLimit > 0);
  const rows = await feeHistory(client, { blocks: 1024, head: BigInt(s.block) });
  assert.equal(rows.length, 1024);
  assert.equal(rows.at(-1).block, s.block);
  assert.ok(rows.every((r, i) => i === 0 || r.block === rows[i - 1].block + 1), "contiguous");
  const l = await longHistory(client, { days: 30 });
  assert.equal(l.points.length, 31);
  assert.ok(l.secPerBlock > 0.5 && l.secPerBlock < 2, String(l.secPerBlock));
});

const senderKey = generatePrivateKey();
await check("CLI on mainnet with a test sender: queue → sign → tick --dry decides to send rung 0 at the floor (nothing broadcast)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gas-e2e-"));
  const sender = privateKeyToAccount(senderKey);
  const req = join(dir, "req.json");
  writeFileSync(req, JSON.stringify({ label: "e2e", from: sender.address, to: "0x1111111111111111111111111111111111111111", value: "0", gas: "21000", deadline: new Date(Date.now() + 3600_000).toISOString().replace(/\.\d+Z$/, "Z"), capGwei: 100 }));
  const job = join(dir, "job");
  const q = cli(["queue", req, "--dir", job]);
  assert.equal(q.status, 0, q.stderr);
  assert.match(q.stdout, /rung 0 {2}max 10 +tip 0 gwei/);
  assert.match(q.stdout, /rung \d+ {2}max 100 +tip/);
  const toSign = JSON.parse(readFileSync(join(job, "to-sign.json"), "utf8"));
  assert.ok(toSign.every((r) => r.tx.nonce === 0 && r.unsignedSerialized.startsWith("0x02")));
  const s = cli(["sign", job], { SENDER_PRIVATE_KEY: generatePrivateKey() });
  assert.equal(s.status, 2);
  assert.match(s.stderr, /but the job's sender is/);
  const ok = cli(["sign", job], { SENDER_PRIVATE_KEY: senderKey });
  assert.equal(ok.status, 0, ok.stderr);
  const d = cli(["tick", job, "--dry"]);
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /SUBMIT rung 0 {2}the base fee is 10 gwei, at or below the target 10 gwei {2}\(dry run: not sent\)/);
  const st = JSON.parse(cli(["status", job, "--json"]).stdout);
  assert.equal(st.job.state, "held");
  assert.equal(st.job.submissions.length, 0);
  assert.ok(st.log.some((e) => e.type === "tick" && e.action === "submit"));
});

await check("CLI mistakes exit 2 with a plain message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gas-bad-"));
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ from: "0x6ea08ca8f313d860808ef7431fc72c6fbcf4a72d", to: "0x1111111111111111111111111111111111111111", deadline: "2020-01-01T00:00:00Z" }));
  const tight = join(dir, "tight.json");
  writeFileSync(tight, JSON.stringify({ from: "0x6ea08ca8f313d860808ef7431fc72c6fbcf4a72d", to: "0x1111111111111111111111111111111111111111", deadline: "2026-01-01T00:00", capGwei: 5 }));
  for (const [args, re] of [[["launch"], /unknown command/], [["queue", "nope.json"], /not found/], [["queue", bad], /deadline is too close/], [["queue", tight], /time zone/], [["tick", join(dir, "x")], /no job at/], [["market", "--gas", "5"], /--gas/], [["market", "--bogus", "1"], /unknown flag/]]) {
    const r = cli(args);
    assert.equal(r.status, 2, `${args.join(" ")} → ${r.status} ${r.stderr}`);
    assert.match(r.stderr, re);
    assert.ok(!/at .*\.js:\d+/.test(r.stderr), "no stack trace");
  }
});

await check("API: the live market, the quote, and a bad gas value", async () => {
  const call = (url, method = "GET") => new Promise((resolve) => handler(Object.assign(async function* () {}(), { method, url }), { writeHead: (status, h) => ({ end: (s) => resolve({ status, h, json: JSON.parse(s) }) }) }));
  const a = await call("/api/market?gas=50000");
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(a.json.recent.rows.length, 128);
  assert.equal(a.json.quote.gas, 50000);
  assert.ok(a.json.quote.atFloor.pros > 0);
  assert.match(a.h["cache-control"], /s-maxage=30/);
  assert.equal((await call("/api/market?gas=12")).status, 400);
  assert.equal((await call("/api/market", "POST")).status, 405);
});

if (process.argv.includes("--fork")) {
  await check("fork: calm, spike, spike to the deadline, priced out, superseded — real receipts", async () => {
    const r = spawnSync(process.execPath, ["scripts/fork-proof.js"], { encoding: "utf8", cwd: root, timeout: 900_000 });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /A\. .*\n.*\n {3}done · paid 10 gwei vs 10 at request/);
    assert.match(r.stdout, /B\. .*\n.*hold.*submit#0.*\n {3}done · paid 10 gwei vs 60 at request \(-83\.3%\)/);
    assert.match(r.stdout, /C\. .*\n.*submit#\d.*\n {3}done · .* before the deadline · rungs sent 1 · included 1/);
    assert.match(r.stdout, /D\. .*\n.*replace#1.*\n {3}done · .*rungs sent 2 · included 1/);
    assert.match(r.stdout, /E\. .*\n.*superseded\n {3}superseded · rungs included 0/);
  });
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
