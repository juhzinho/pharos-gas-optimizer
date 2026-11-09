import { makeClient } from "../lib/chain.js";
import { feeHistory, paidByOthers, snapshot } from "../lib/market.js";

// GET /api/market?gas=21000
// Pacific mainnet now: the head block's base fee and the node's suggestions, the last 128 blocks of base fee,
// fullness and tips, what the transactions in them actually paid vs the base fee, and what `gas` units cost at the
// floor (tip 0) vs at what others paid. Cached for 30 s at the edge: the same answer serves everyone in that window.
const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

export default async function handler(req, res) {
  const send = (status, b, cache) => res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": cache ? "public, s-maxage=30, stale-while-revalidate=60" : "no-store" }).end(json(b));
  if (req.method !== "GET") return send(405, { ok: false, error: "GET" });
  const q = new URL(req.url, "http://x").searchParams.get("gas") ?? "21000";
  if (!/^\d{4,8}$/.test(q) || Number(q) < 21000 || Number(q) > 30_000_000) return send(400, { ok: false, error: "gas: 21,000 to 30,000,000" });
  try {
    const client = makeClient();
    const now = await snapshot(client);
    const rows = await feeHistory(client, { blocks: 128, head: BigInt(now.block) });
    const paid = await paidByOthers(client, rows);
    const gas = Number(q);
    const cost = (gwei) => ({ gwei, pros: (gas * gwei) / 1e9, usd: ((gas * gwei) / 1e9) * now.prosUsd });
    return send(200, {
      ok: true, network: "Pharos Pacific Mainnet", checkedAt: new Date().toISOString(), now,
      recent: { from: rows[0].block, to: rows.at(-1).block, rows: rows.map((r) => ({ b: r.block, f: r.baseFeeGwei, u: Math.round(r.fullness * 1e6) / 1e6 })) },
      paid,
      quote: { gas, atFloor: cost(now.baseFeeGwei), atOthersMedian: paid.effective.p50 == null ? null : cost(paid.effective.p50), atOthersP90: paid.effective.p90 == null ? null : cost(paid.effective.p90) },
    }, true);
  } catch (e) {
    const busy = /timeout|ECONN|fetch failed|unreachable|429|rate|cu limit/i.test(e.message);
    return send(busy ? 503 : 500, { ok: false, error: busy ? "The Pharos Pacific RPC is busy right now. Try again in a minute." : e.message.split("\n")[0] });
  }
}
