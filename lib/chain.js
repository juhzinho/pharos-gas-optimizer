import { createPublicClient, http } from "viem";
import { PACIFIC_RPC } from "./contracts.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A Pacific client: JSON-RPC batching (many calls in one HTTP request), multicall for reads, and a small in-flight
 * limit on HTTP requests. Every read of a plan is pinned to one block number.
 */
export function makeClient({ rpc = process.env.PHAROS_RPC_URL ?? PACIFIC_RPC } = {}) {
  const gate = gateFor(rpc);
  const base = http(rpc, { timeout: 15_000, retryCount: 3, retryDelay: 500, batch: { batchSize: 40, wait: 12 }, fetchFn: (url, init) => gate(() => fetch(url, init)) });
  const transport = (opts) => {
    const t = base(opts);
    return {
      ...t,
      // The public endpoint balances over several nodes: right after a block is produced, a node that is a moment
      // behind answers "block is not available" for it. That is not a failure of the call: ask again shortly.
      async request(args) {
        for (let attempt = 0; ; attempt++) {
          try {
            return await t.request(args);
          } catch (e) {
            // also the gateway's rate limit (429 "cu limit exceeded"): back off and ask again
            const text = String(e?.details ?? e?.message ?? "");
            const limited = e?.status === 429 || /cu limit|too fast/i.test(text);
            if (attempt >= (limited ? 6 : 4) || !(limited || /block is not available/i.test(text))) throw e;
            await sleep(limited ? 600 * 2 ** attempt : 400 * (attempt + 1));
          }
        }
      },
    };
  };
  return createPublicClient({ transport, batch: { multicall: { wait: 16, batchSize: 4096 } } });
}

// The public Pacific RPC sits behind a gateway that stalls bursts of parallel requests (20 at once → ~10 s each,
// then errors), while a few at a time answer in well under a second. So every client of one endpoint shares a
// small in-flight limit; JSON-RPC batching keeps the number of requests low in the first place.
const MAX_IN_FLIGHT = Number(process.env.PHAROS_RPC_CONCURRENCY ?? 2);
const gates = new Map();
function gateFor(rpc) {
  if (gates.has(rpc)) return gates.get(rpc);
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= MAX_IN_FLIGHT || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  const gate = (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
  gates.set(rpc, gate);
  return gate;
}
