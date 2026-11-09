import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGwei } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildLadder, gweiOf, validateRequest, worstCaseWei } from "../lib/ladder.js";
import { RISE, decide } from "../lib/policy.js";
import { attach, openJob, report } from "../lib/agent.js";
import { simulate } from "../lib/simulate.js";

const base = { from: "0x6ea08ca8f313d860808ef7431fc72c6fbcf4a72d", to: "0x1111111111111111111111111111111111111111", value: "1", deadline: "2026-11-10T18:00:00Z", capGwei: 200 };
const ladderOf = (cap = 200, floor = 10) => buildLadder(validateRequest({ ...base, capGwei: cap }), { nonce: 7, gas: 21_000n, floorGwei: floor });
const jobOf = (lad, o = {}) => ({ deadline: 1000, lastCallSeconds: 60, targetGwei: 10, stallBlocks: 3, rungs: lad.map((r) => ({ rung: r.rung, maxFeeGwei: gweiOf(r.maxFeePerGas), tipGwei: gweiOf(r.maxPriorityFeePerGas) })), submissions: [], ...o });
const mk = (o) => ({ now: 0, block: 100, baseFeeGwei: 10, senderNonce: 7, jobNonce: 7, mined: null, ...o });

// ───────── the ladder ─────────
test("the ladder: same nonce on every rung, fees and tips rising enough to replace, the top exactly at the cap", () => {
  const lad = ladderOf();
  assert.ok(lad.every((r) => r.tx.nonce === 7 && r.tx.to === base.to));
  assert.equal(gweiOf(lad[0].maxFeePerGas), 10);
  assert.equal(gweiOf(lad[0].maxPriorityFeePerGas), 0);
  assert.equal(gweiOf(lad.at(-1).maxFeePerGas), 200);
  for (let i = 1; i < lad.length; i++) {
    assert.ok(lad[i].maxFeePerGas * 10n >= lad[i - 1].maxFeePerGas * 11n, `rung ${i} max fee +10 %`);
    assert.ok(lad[i].maxPriorityFeePerGas * 10n >= lad[i - 1].maxPriorityFeePerGas * 11n, `rung ${i} tip +10 %`);
  }
  assert.equal(worstCaseWei(lad), 21_000n * parseGwei("200"));
  assert.throws(() => ladderOf(5, 10), /below today's base fee/);
});

test("request validation", () => {
  assert.throws(() => validateRequest({ ...base, to: "0x12" }), /to: an address/);
  assert.throws(() => validateRequest({ ...base, deadline: "tomorrow" }), /deadline: an ISO time/);
  assert.throws(() => validateRequest({ ...base, deadline: "2026-11-10T18:00:00" }), /time zone/);
  assert.throws(() => validateRequest({ ...base, capGwei: 0 }), /capGwei/);
  assert.throws(() => validateRequest({ ...base, targetGwei: 500 }), /targetGwei/);
  assert.throws(() => validateRequest({ ...base, data: "xyz" }), /data: hex/);
  assert.throws(() => validateRequest({ ...base, value: "1.5" }), /value: wei/);
});

// ───────── the decision ─────────
test("calm → the cheapest rung (tip 0); a spike → hold; the last call → send whatever the price", () => {
  const job = jobOf(ladderOf());
  assert.deepEqual([decide(job, mk({})).action, decide(job, mk({})).rung], ["submit", 0]);
  assert.equal(decide(job, mk({ baseFeeGwei: 60 })).action, "hold");
  const d = decide(job, mk({ baseFeeGwei: 60, now: 940 }));
  assert.equal(d.action, "submit");
  assert.equal(d.why, "deadline");
  assert.ok(job.rungs[d.rung].maxFeeGwei >= 60 * RISE ** 3);
  assert.equal(decide(job, mk({ baseFeeGwei: 500, now: 940 })).rung, job.rungs.at(-1).rung, "above the cap: the top rung");
});

test("after sending: wait; replace when priced out, stalled or at the last call; done / superseded / missed", () => {
  const job = jobOf(ladderOf(), { submissions: [{ rung: 0, block: 100 }] });
  assert.equal(decide(job, mk({ block: 101 })).action, "wait");
  assert.deepEqual([decide(job, mk({ block: 101, baseFeeGwei: 14 })).action, decide(job, mk({ block: 101, baseFeeGwei: 14 })).rung], ["replace", 1]);
  assert.equal(decide(job, mk({ block: 103 })).action, "replace");
  assert.equal(decide(job, mk({ block: 101, now: 950 })).why, "deadline");
  assert.equal(decide(job, mk({ mined: { rung: 0, status: "success" } })).action, "done");
  assert.equal(decide(job, mk({ senderNonce: 8 })).action, "superseded");
  assert.equal(decide(job, mk({ now: 1001 })).action, "missed");
});

test("the deadline, simulated: 2,000 random base-fee paths — always included in time when the cap covers the peak, never twice", () => {
  const s = simulate({ rungs: jobOf(ladderOf(400)).rungs, runs: 2000, peakGwei: 390 });
  assert.equal(s.missed, 0);
  assert.equal(s.includedTwice, 0);
  assert.equal(s.includedInTime, 2000);
  // every way of sending happens: at once (calm), after holding (a spike that passes), at the last call (one that lasts)
  assert.ok(s.sentAtOnce > 100 && s.heldThenFavorable > 100 && s.sentAtLastCall > 100, JSON.stringify(s));
  assert.equal(s.byRegime["lasting spike"].sentAtLastCall > s.byRegime["lasting spike"].runs / 2, true);
  assert.ok(s.cheaperThanAtRequest > 500, `waiting paid off in many runs (${s.cheaperThanAtRequest})`);
});

// ───────── signed rungs and the report ─────────
test("attach checks every signed rung against its rung and its signer", async () => {
  const sender = privateKeyToAccount(generatePrivateKey());
  const lad = buildLadder(validateRequest({ ...base, from: sender.address }), { nonce: 3, gas: 21_000n, floorGwei: 10 });
  const store = openJob(mkdtempSync(join(tmpdir(), "gas-")));
  store.save({ request: { from: sender.address }, nonce: 3, rungs: lad.map((r) => ({ rung: r.rung, unsigned: r.tx })), submissions: [] });
  const sign = (tx, who = sender) => who.signTransaction({ ...tx, type: "eip1559" });
  const raws = await Promise.all(lad.map((r) => sign(r.tx)));
  await assert.rejects(attach(store, raws.slice(1)), /expected 8 signed transactions/);
  await assert.rejects(attach(store, [raws[1], raws[0], ...raws.slice(2)]), /rung 0: the signed transaction differs/);
  const other = privateKeyToAccount(generatePrivateKey());
  await assert.rejects(attach(store, await Promise.all(lad.map((r) => sign(r.tx, other)))), /signed by .* not the sender/);
  const job = await attach(store, raws);
  assert.equal(job.state, "held");
  assert.equal(new Set(job.rungs.map((r) => r.hash)).size, lad.length);
});

test("the report: paid vs the base fee at request, wait, deadline", () => {
  const job = { request: { deadline: 1000 }, submissions: [{}], atRequest: { block: 10, time: 100, baseFeeGwei: 60, gasPriceGwei: 61, prosUsd: 0.5 } };
  const r = report(job, { rung: 0, hash: "0x1", block: 19, time: 190, status: "success", gasUsed: "21000", effectiveGasPrice: parseGwei("10").toString() });
  assert.equal(r.paidGwei, 10);
  assert.ok(Math.abs(r.vsRequestPct + 83.333) < 0.01);
  assert.equal(r.waitedBlocks, 9);
  assert.equal(r.deadlineMet, true);
  assert.equal(r.feePros, 0.00021);
});
