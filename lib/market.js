import { parseAbi } from "viem";
import { PROS_USD } from "./contracts.js";

// The fee market as it really is on Pacific, read from chain:
//   - base fee per block (EIP-1559) and how full blocks are — eth_feeHistory, up to 1,024 blocks per call
//   - the base fee over the past days, sampled at evenly spaced blocks
//   - what transactions actually paid: effective gas price = base fee + the tip each sender chose
// "Gas price" below always means the effective price per gas a transaction pays, in gwei.

const GWEI = 1e9;
const g = (wei) => Number(wei) / GWEI;
const FEED = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]);

/** The head block's fee state, and what a node suggests (eth_gasPrice, eth_maxPriorityFeePerGas). */
export async function snapshot(client) {
  const [head, gasPrice, tip, [, prosUsd]] = await Promise.all([
    client.getBlock(),
    client.getGasPrice(),
    client.request({ method: "eth_maxPriorityFeePerGas" }).then(BigInt).catch(() => 0n),
    client.readContract({ address: PROS_USD, abi: FEED, functionName: "latestRoundData" }).catch(() => [0n, 0n]),
  ]);
  return { block: Number(head.number), time: Number(head.timestamp), baseFeeGwei: g(head.baseFeePerGas ?? 0n), baseFeeWei: (head.baseFeePerGas ?? 0n).toString(), gasPriceGwei: g(gasPrice), suggestedTipGwei: g(tip), gasLimit: Number(head.gasLimit), gasUsed: Number(head.gasUsed), prosUsd: Number(prosUsd) / 1e18 };
}

/**
 * The last `blocks` blocks (≤ 4,096): base fee and fullness per block, tip percentiles, from eth_feeHistory —
 * fetched in windows of 1,024 because that is the most a node serves per call.
 */
export async function feeHistory(client, { blocks = 1024, head } = {}) {
  const newest = head ?? (await client.getBlockNumber());
  const out = [];
  for (let end = newest; out.length < blocks; ) {
    const n = Math.min(1024, blocks - out.length);
    const h = await client.request({ method: "eth_feeHistory", params: [`0x${n.toString(16)}`, `0x${end.toString(16)}`, [10, 50, 90]] });
    const first = Number(BigInt(h.oldestBlock));
    const rows = h.gasUsedRatio.map((ratio, i) => ({ block: first + i, baseFeeGwei: g(BigInt(h.baseFeePerGas[i])), fullness: ratio, tipsGwei: (h.reward?.[i] ?? []).map((x) => g(BigInt(x))) }));
    out.unshift(...rows);
    end = BigInt(first - 1);
    if (first <= 1) break;
  }
  return out.slice(-blocks);
}

/** The base fee at evenly spaced blocks over `days` (block times are read from the blocks, not assumed). */
export async function longHistory(client, { days = 30, points = 31, head } = {}) {
  const top = head ?? (await client.getBlock());
  const probe = await client.getBlock({ blockNumber: top.number - 100_000n });
  const secPerBlock = Number(top.timestamp - probe.timestamp) / 100_000;
  const span = BigInt(Math.round((days * 86400) / secPerBlock));
  const nums = Array.from({ length: points }, (_, i) => top.number - (span * BigInt(points - 1 - i)) / BigInt(points - 1));
  const blocks = await Promise.all(nums.map((n) => client.getBlock({ blockNumber: n })));
  return { secPerBlock, points: blocks.map((b) => ({ block: Number(b.number), time: Number(b.timestamp), baseFeeGwei: g(b.baseFeePerGas ?? 0n), gasUsed: Number(b.gasUsed) })) };
}

/**
 * What senders actually paid in recent blocks: every transaction's effective price vs the base fee of its block.
 * Only blocks with transactions are fetched (feeHistory says which). Returns the overpayment, in gwei and PROS.
 */
export async function paidByOthers(client, rows) {
  const busy = rows.filter((r) => r.fullness > 0).map((r) => r.block);
  // full blocks are heavy for the public gateway: a few at a time
  const blocks = [];
  for (let i = 0; i < busy.length; i += 6) blocks.push(...(await Promise.all(busy.slice(i, i + 6).map((n) => client.getBlock({ blockNumber: BigInt(n), includeTransactions: true })))));
  const txs = [];
  for (const b of blocks) {
    const base = b.baseFeePerGas ?? 0n;
    for (const tx of b.transactions) {
      // effective price: legacy pays gasPrice; EIP-1559 pays base + min(tip, maxFee − base)
      const eff = tx.type === "legacy" || tx.type === "eip2930" ? tx.gasPrice : base + (tx.maxPriorityFeePerGas < tx.maxFeePerGas - base ? tx.maxPriorityFeePerGas : tx.maxFeePerGas - base);
      txs.push({ block: Number(b.number), hash: tx.hash, type: tx.type, effectiveGwei: g(eff), baseFeeGwei: g(base), overGwei: g(eff - base), gasLimit: Number(tx.gas) });
    }
  }
  const over = txs.filter((t) => t.overGwei > 0);
  const hashes = over.map((t) => t.hash);
  // the gas each overpaying transaction really used, to turn gwei into PROS
  const receipts = [];
  for (let i = 0; i < hashes.length; i += 10) receipts.push(...(await Promise.all(hashes.slice(i, i + 10).map((h) => client.getTransactionReceipt({ hash: h })))));
  const extraPros = receipts.reduce((s, r, i) => s + (Number(r.gasUsed) * over[i].overGwei) / GWEI, 0);
  const sorted = txs.map((t) => t.effectiveGwei).sort((a, b) => a - b);
  // how far above the base fee senders went, in bands
  const BANDS = [[0, 0, "the base fee"], [0, 1, "< +1"], [1, 5, "+1–5"], [5, 20, "+5–20"], [20, 50, "+20–50"], [50, 100, "+50–100"], [100, Infinity, "+100 or more"]];
  const histogram = BANDS.map(([lo, hi, label]) => ({ label, count: txs.filter((t) => (lo === 0 && hi === 0 ? t.overGwei === 0 : t.overGwei > lo && t.overGwei <= hi)).length }));
  const q = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
  return {
    blocks: rows.length, blocksWithTxs: busy.length, txs: txs.length, overpaying: over.length,
    overpayingShare: txs.length ? over.length / txs.length : 0, extraPros,
    effective: { p10: q(0.1), p50: q(0.5), p90: q(0.9), max: sorted.at(-1) ?? null },
    zeroTipIncluded: txs.filter((t) => t.overGwei === 0).length,
    histogram,
    worst: [...over].sort((a, b) => b.overGwei - a.overGwei).slice(0, 5).map((t) => ({ hash: t.hash, block: t.block, effectiveGwei: t.effectiveGwei, type: t.type })),
  };
}
