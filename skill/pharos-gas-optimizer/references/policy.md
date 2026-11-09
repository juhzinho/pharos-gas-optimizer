# The policy (lib/policy.js — a pure function)

Inputs per tick: chain time, block number, base fee, the sender's confirmed nonce, and whether any rung is included.

| order | situation | action |
|---|---|---|
| 1 | a rung's receipt exists (every rung is checked, not only the recorded ones) | **done** |
| 2 | the sender's nonce is past the job's, no rung included | **superseded** — nothing can be included any more |
| 3 | chain time past the deadline | **missed** (only reachable when the base fee stayed above the cap) |
| 4 | nothing sent, chain time ≥ deadline − 60 s (last call) | **send** the cheapest rung covering the base fee × 1.125³, else the top rung |
| 5 | nothing sent, base fee ≤ target | **send** the cheapest rung covering the base fee now (tip 0 at the floor) |
| 6 | nothing sent, base fee > target | **hold** |
| 7 | sent; last call reached, or the base fee rose above the sent rung's max fee, or 5 blocks without inclusion | **replace** with the next rung that covers it (same nonce) |
| 8 | sent, none of the above | **wait** |

1.125 is the most an EIP-1559 base fee can rise per block.

## The ladder

`maxFee` from the floor (the lowest base fee in the last 1,024 blocks, or the current one if lower) rising ×1.6 per
rung up to the cap; tips 0, 0.1, 0.2, 0.4 … gwei. Each rung raises both by well over 10 %, so it is a valid
replacement for the one below in geth-style transaction pools. Same nonce on every rung: at most one is ever included.

## The report

`paid` = the receipt's `effectiveGasPrice`; `at request` = the base fee in the block the job was queued (what a
transaction with no tip paid then); also the node's own `eth_gasPrice` at request, the wait in blocks and seconds,
and the seconds left before the deadline.

## Proof

- Fork (`npm run gas -- demo`, `public/runs/fork-proof.json`): base fee injected per block with
  `anvil_setNextBlockBaseFeePerGas`; real receipts.
- Simulation (`public/runs/simulation.json`): 2,000 random base-fee paths through the same `decide()`.
- Market (`public/runs/market.json`, `GET /api/market`): Pacific mainnet, read-only.
