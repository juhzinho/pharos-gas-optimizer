import { getAddress, isAddress, isHex, parseGwei } from "viem";
import { CHAIN_ID } from "./contracts.js";

// A fee ladder: the SAME transaction (same nonce) signed at rising fees. The agent never holds a key — it only
// chooses which rung to broadcast and when. Because every rung has the same nonce, at most one can ever be included:
// holding, re-sending or escalating can never execute the transaction twice.
//   rung 0  maxFee = the floor (today's base fee), tip 0      — what the transaction costs when gas is calm
//   rung k  maxFee × ~1.6 each step, tip doubling from 0.1 gwei — each one a valid replacement for the one below
//   top     maxFee = the cap the sender accepts                — what the deadline may cost, and no more

const GWEI = 1_000_000_000n;
const TIPS = ["0", "0.1", "0.2", "0.4", "0.8", "1.6", "3.2", "6.4", "12.8", "25.6"];

export function validateRequest(raw) {
  const r = raw ?? {};
  const addr = (k, req = true) => {
    if (r[k] == null && !req) return null;
    if (!isAddress(String(r[k] ?? ""), { strict: false })) throw new Error(`${k}: an address (0x…) is required`);
    return getAddress(String(r[k]).toLowerCase());
  };
  const from = addr("from");
  const to = addr("to");
  const data = r.data ?? "0x";
  if (!isHex(data)) throw new Error("data: hex calldata (0x…)");
  if (!/^\d+$/.test(String(r.value ?? "0"))) throw new Error("value: wei, as a whole number");
  const deadlineMs = Date.parse(String(r.deadline ?? ""));
  if (!Number.isFinite(deadlineMs) || !/Z$|[+-]\d\d:\d\d$/.test(String(r.deadline))) throw new Error("deadline: an ISO time with a time zone, e.g. 2026-11-10T18:00:00Z");
  const capGwei = Number(r.capGwei ?? 200);
  if (!(capGwei >= 1 && capGwei <= 10_000)) throw new Error("capGwei: the most you accept per gas at the deadline, 1 to 10,000 gwei");
  const targetGwei = r.targetGwei == null ? null : Number(r.targetGwei);
  if (targetGwei != null && !(targetGwei > 0 && targetGwei <= capGwei)) throw new Error("targetGwei: a favorable price, above 0 and at most the cap");
  const label = r.label ? String(r.label).slice(0, 80) : null;
  return { from, to, data, value: String(r.value ?? "0"), deadline: Math.floor(deadlineMs / 1000), capGwei, targetGwei, label, gas: r.gas == null ? null : BigInt(r.gas) };
}

/** The rungs, cheapest first. `floorGwei` is the base fee the cheapest rung must still cover. */
export function buildLadder(req, { nonce, gas, floorGwei }) {
  const cap = parseGwei(String(req.capGwei));
  const floor = parseGwei(String(floorGwei));
  if (cap < floor) throw new Error(`the cap (${req.capGwei} gwei) is below today's base fee (${floorGwei} gwei): the transaction could not be included at all`);
  const rungs = [];
  let maxFee = floor;
  for (let k = 0; ; k++) {
    const tip = parseGwei(TIPS[Math.min(k, TIPS.length - 1)]);
    const last = maxFee >= cap || k === TIPS.length - 1;
    const fee = last ? cap : maxFee;
    rungs.push({ rung: k, maxFeePerGas: fee, maxPriorityFeePerGas: tip > fee ? fee : tip });
    if (last) break;
    maxFee = (maxFee * 16n) / 10n;
    // a replacement must raise both the fee and the tip by ≥ 10 %: keep each step well above that
    if ((cap - maxFee) * 10n < cap) maxFee = cap;
  }
  return rungs.map((x) => ({ ...x, tx: { chainId: CHAIN_ID, type: "eip1559", from: req.from, to: req.to, data: req.data, value: BigInt(req.value), nonce, gas, maxFeePerGas: x.maxFeePerGas, maxPriorityFeePerGas: x.maxPriorityFeePerGas } }));
}

export const gweiOf = (wei) => Number(wei) / Number(GWEI);
/** The worst the sender can pay: gas × the top rung's max fee. */
export const worstCaseWei = (ladder) => ladder.at(-1).tx.gas * ladder.at(-1).maxFeePerGas;
