// The decision, as a pure function: same inputs → same answer, so every branch is tested without a chain.
//
//   job     { deadline, targetGwei, lastCallSeconds, rungs: [{ rung, maxFeeGwei, tipGwei }], submissions: [{ rung, at, block }] }
//   market  { now, block, baseFeeGwei, senderNonce, jobNonce, mined: { rung, status } | null }
//
// Rules, in this order:
//   1. a rung was included → done (it is the only one that ever can be: same nonce)
//   2. the sender's nonce moved past the job's without any rung → superseded (the sender sent something else)
//   3. nothing sent yet:
//        last call reached (deadline − margin) → send now, whatever the price: the cheapest rung that still covers
//          the base fee three blocks ahead, else the top rung — the deadline wins over the price
//        base fee ≤ target → send the cheapest rung that covers it now (tip 0 at the floor)
//        otherwise → hold, and say until when
//   4. sent, not included yet:
//        last call reached, or the base fee rose above what the sent rung can pay, or it waited `stallBlocks` blocks →
//          replace with the next rung that covers the base fee (same nonce: a replacement, never a second payment)
//        otherwise → wait for it
// Headroom: under EIP-1559 the base fee can rise at most 12.5 % per block.

export const RISE = 1.125;

export function decide(job, m) {
  const last = job.submissions.at(-1) ?? null;
  const lastCall = job.deadline - job.lastCallSeconds;
  const covering = (blocks, from = 0) => job.rungs.find((r) => r.rung >= from && r.maxFeeGwei >= m.baseFeeGwei * RISE ** blocks) ?? null;
  const top = job.rungs.at(-1);

  if (m.mined) return { action: "done", rung: m.mined.rung, status: m.mined.status, reason: m.mined.status === "success" ? `included (rung ${m.mined.rung})` : `included but reverted (rung ${m.mined.rung})` };
  if (m.senderNonce > m.jobNonce) return { action: "superseded", reason: `the sender's nonce is now ${m.senderNonce}: nonce ${m.jobNonce} was used by another transaction, so none of the rungs can be included` };
  if (m.now > job.deadline) return { action: "missed", reason: "the deadline passed without inclusion" };

  if (!last) {
    if (m.now >= lastCall) {
      const r = covering(3) ?? top;
      return { action: "submit", rung: r.rung, why: "deadline", reason: r === top && r.maxFeeGwei < m.baseFeeGwei * RISE ** 3 ? `last call: the base fee is ${fmt(m.baseFeeGwei)} gwei — sending the top rung (${fmt(top.maxFeeGwei)} gwei, your cap)` : `last call before the deadline: sending at ${fmt(r.maxFeeGwei)} gwei max even though the base fee is ${fmt(m.baseFeeGwei)} gwei` };
    }
    if (m.baseFeeGwei <= job.targetGwei) {
      // the cheapest rung that covers the base fee now: the price paid is base + tip, so no tip "for safety" — if
      // the base fee rises before inclusion, rule 4 replaces it
      const r = covering(0) ?? top;
      return { action: "submit", rung: r.rung, why: "favorable", reason: `the base fee is ${fmt(m.baseFeeGwei)} gwei, at or below the target ${fmt(job.targetGwei)} gwei` };
    }
    return { action: "hold", reason: `the base fee is ${fmt(m.baseFeeGwei)} gwei, above the target ${fmt(job.targetGwei)} gwei — holding; last call at ${new Date(lastCall * 1000).toISOString()}` };
  }

  const sent = job.rungs.find((r) => r.rung === last.rung);
  const pricedOut = sent.maxFeeGwei < m.baseFeeGwei;
  const stalled = m.block - last.block >= job.stallBlocks;
  if (m.now >= lastCall || pricedOut || stalled) {
    const need = m.now >= lastCall ? 3 : 1;
    const next = covering(need, last.rung + 1) ?? job.rungs.find((r) => r.rung > last.rung) ?? null;
    if (!next) return { action: "wait", reason: `rung ${last.rung} is the top of the ladder (your cap) — nothing higher to send` };
    const cause = m.now >= lastCall ? "last call before the deadline" : pricedOut ? `the base fee (${fmt(m.baseFeeGwei)} gwei) rose above what rung ${last.rung} can pay (${fmt(sent.maxFeeGwei)} gwei)` : `not included after ${m.block - last.block} blocks`;
    return { action: "replace", rung: next.rung, why: m.now >= lastCall ? "deadline" : "escalate", reason: `${cause} — replacing with rung ${next.rung} (${fmt(next.maxFeeGwei)} gwei max, same nonce)` };
  }
  return { action: "wait", reason: `rung ${last.rung} sent at block ${last.block}; waiting for inclusion` };
}

const fmt = (x) => (Math.round(x * 1000) / 1000).toString();
