// Records the demo's data → public/runs/:
//   market.json      Pacific mainnet, read-only: the head, 1,024 blocks of base fee / fullness / tips, 30 days of base
//                    fee, and what every transaction in those 1,024 blocks actually paid vs the base fee
//   simulation.json  the policy against 2,000 random base-fee paths (lib/simulate.js)
import { writeFile } from "node:fs/promises";
import { makeClient } from "../lib/chain.js";
import { feeHistory, longHistory, paidByOthers, snapshot } from "../lib/market.js";
import { buildLadder, gweiOf, validateRequest } from "../lib/ladder.js";
import { simulate } from "../lib/simulate.js";

const client = makeClient();
const save = (name, x) => writeFile(new URL(`../public/runs/${name}.json`, import.meta.url), JSON.stringify({ recordedAt: new Date().toISOString(), ...x }, null, 2));

const now = await snapshot(client);
const rows = await feeHistory(client, { blocks: 1024, head: BigInt(now.block) });
const long = await longHistory(client, { days: 30 });
const paid = await paidByOthers(client, rows);
const base = rows.map((r) => r.baseFeeGwei);
await save("market", {
  network: "Pharos Pacific Mainnet", now,
  recent: { from: rows[0].block, to: rows.at(-1).block, baseFeeMin: Math.min(...base), baseFeeMax: Math.max(...base), maxFullness: Math.max(...rows.map((r) => r.fullness)), rows: rows.map((r) => ({ b: r.block, f: r.baseFeeGwei, u: Math.round(r.fullness * 1e6) / 1e6, t: r.tipsGwei.map((x) => Math.round(x * 1e4) / 1e4) })) },
  long, paid,
});
console.log(`market: block ${now.block} · base fee ${now.baseFeeGwei} gwei · 1,024 blocks min/max ${Math.min(...base)}/${Math.max(...base)} · 30 d ${[...new Set(long.points.map((p) => p.baseFeeGwei))].join("/")} gwei · ${paid.txs} txs, ${paid.overpaying} paid above the base fee (${(paid.overpayingShare * 100).toFixed(1)} %), ${paid.extraPros.toFixed(4)} PROS extra`);

const lad = buildLadder(validateRequest({ from: "0x6ea08ca8f313d860808ef7431fc72c6fbcf4a72d", to: "0x1111111111111111111111111111111111111111", deadline: "2030-01-01T00:00:00Z", capGwei: 400 }), { nonce: 0, gas: 21_000n, floorGwei: 10 });
const rungs = lad.map((r) => ({ rung: r.rung, maxFeeGwei: gweiOf(r.maxFeePerGas), tipGwei: gweiOf(r.maxPriorityFeePerGas) }));
const sim = simulate({ rungs, runs: 2000, seed: 42, peakGwei: 390 });
await save("simulation", { model: "one block per second; the base fee moves ≤ ±12.5 % per block with a 10 gwei floor, in four regimes (calm, a decaying spike, a lasting spike, volatile); a pending rung is included in the first block whose base fee it covers; target 12 gwei, last call 60 s before the deadline, cap 400 gwei (above any peak, 390)", ladder: rungs, ...sim });
console.log(`simulation: ${sim.includedInTime}/${sim.runs} in time · twice ${sim.includedTwice} · at once ${sim.sentAtOnce} · held ${sim.heldThenFavorable} · last call ${sim.sentAtLastCall} · tightest ${sim.worstSecondsBeforeDeadline} s`);
process.exit(0);
