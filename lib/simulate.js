import { decide } from "./policy.js";

// The policy against many random base-fee paths, one block per second, with a simple and strict inclusion rule:
// a pending rung is included in the first block whose base fee it covers. The fee moves like EIP-1559 (at most
// ±12.5 % per block) with a 10 gwei floor, a bias upward in a spike, and the cap above any peak the path can reach.
// Measures what matters: included before the deadline every time, never twice, and how often waiting paid off.

export function simulate({ rungs, runs = 2000, seed = 42, targetGwei = 12, lastCallSeconds = 60, stallBlocks = 3, peakGwei = 390 } = {}) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const stats = { runs, includedInTime: 0, includedTwice: 0, missed: 0, sentAtOnce: 0, heldThenFavorable: 0, sentAtLastCall: 0, replaced: 0, cheaperThanAtRequest: 0, savedPctSum: 0, worstSecondsBeforeDeadline: Infinity, examples: [] };
  // four regimes, a quarter each: calm near the floor · a spike that decays · a spike that stays (or grows) · volatile
  const REGIMES = [
    { name: "calm", start: () => 10 + rnd() * 2, drift: 0.5, width: 0.1 },
    { name: "decaying spike", start: () => 40 + rnd() * 110, drift: 0.6, width: 0.25 },
    { name: "lasting spike", start: () => 40 + rnd() * 110, drift: 0.45, width: 0.2 },
    { name: "volatile", start: () => 10 + rnd() * 70, drift: 0.5, width: 0.25 },
  ];
  stats.byRegime = Object.fromEntries(REGIMES.map((r) => [r.name, { runs: 0, heldThenFavorable: 0, sentAtLastCall: 0, sentAtOnce: 0, replaced: 0 }]));
  for (let run = 0; run < runs; run++) {
    const regime = REGIMES[Math.floor(rnd() * REGIMES.length)];
    const R = stats.byRegime[regime.name];
    R.runs++;
    let fee = regime.start(), t = 0, block = 0;
    const deadline = 300 + Math.floor(rnd() * 900);
    const job = { deadline, lastCallSeconds, targetGwei, stallBlocks, rungs, submissions: [] };
    const path = [];
    let pending = null, mined = null, inclusions = 0, why = null;
    const atRequest = fee;
    while (t <= deadline + 30) {
      path.push(Math.round(fee * 10) / 10);
      if (pending != null && !mined && rungs[pending].maxFeeGwei >= fee) { mined = { rung: pending, status: "success", t, paid: fee + Math.min(rungs[pending].tipGwei, rungs[pending].maxFeeGwei - fee) }; inclusions++; }
      const d = decide(job, { now: t, block, baseFeeGwei: fee, senderNonce: 7, jobNonce: 7, mined });
      if (d.action === "done") break;
      if (d.action === "submit" || d.action === "replace") {
        job.submissions.push({ rung: d.rung, block });
        pending = d.rung;
        if (d.action === "replace") { stats.replaced++; R.replaced++; }
        else why = t === 0 && d.why === "favorable" ? "at once" : d.why;
      }
      const step = Math.max(-0.125, Math.min(0.125, (rnd() - regime.drift) * regime.width * 2)); // EIP-1559: ≤ ±12.5 % per block
      fee = Math.min(peakGwei, Math.max(10, fee * (1 + step)));
      t++; block++;
    }
    if (!mined || mined.t > deadline) stats.missed++;
    else {
      stats.includedInTime++;
      stats.worstSecondsBeforeDeadline = Math.min(stats.worstSecondsBeforeDeadline, deadline - mined.t);
    }
    if (inclusions > 1) stats.includedTwice++;
    if (why === "at once") { stats.sentAtOnce++; R.sentAtOnce++; }
    else if (why === "favorable") { stats.heldThenFavorable++; R.heldThenFavorable++; }
    else if (why === "deadline") { stats.sentAtLastCall++; R.sentAtLastCall++; }
    if (mined) {
      const pct = ((atRequest - mined.paid) / atRequest) * 100;
      if (pct > 0) stats.cheaperThanAtRequest++;
      stats.savedPctSum += pct;
      if (stats.examples.length < 4 && why !== "at once" && !stats.examples.some((e) => e.why === why && e.regime === regime.name)) stats.examples.push({ run, regime: regime.name, deadline, atRequestGwei: Math.round(atRequest * 10) / 10, paidGwei: Math.round(mined.paid * 10) / 10, includedAt: mined.t, why, path: path.filter((_, i) => i % 5 === 0) });
    }
  }
  stats.averageSavedPct = stats.savedPctSum / runs;
  delete stats.savedPctSum;
  return stats;
}
