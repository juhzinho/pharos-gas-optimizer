# Pharos Gas Optimizer

A **SkillEngine skill** for Pharos Pacific that watches the fee market, holds a non-urgent transaction until gas is
favorable, and **always sends it by the deadline** — then reports what was actually paid vs the price when it was
handed over. It never holds a key: the sender signs a small **fee ladder** of the same transaction (same nonce,
rising fees) once, and the agent only chooses which signed rung to broadcast and when — so the transaction can never
run twice.

**Live demo:** https://pharos-gas-optimizer.vercel.app · **Skill:** [skill/pharos-gas-optimizer/SKILL.md](skill/pharos-gas-optimizer/SKILL.md)

```
request + deadline + cap ─▶ ladder: rung 0 = 10 gwei / tip 0 … top = your cap (same nonce) ─▶ signed once
every block:  included → report  ·  nonce used elsewhere → superseded  ·  last call → send now (the deadline wins)
              base fee ≤ target → send the cheapest rung that covers it  ·  above → hold  ·  stuck → next rung
```

## Requirements

| # | Requirement | How it is met |
|---|---|---|
| 01 | Tracks gas price over time and shows recent history | `market` and `GET /api/market` read Pacific: the head block's base fee and the node's suggestions, **1,024 blocks** of base fee / fullness / tip percentiles (`eth_feeHistory`), **30 days** of base fee sampled at 31 blocks, and **what every transaction in those blocks actually paid** vs the base fee. Every job logs the base fee it saw on every tick. The site charts it all ([market.json](public/runs/market.json)). |
| 02 | Accepts a transaction with a deadline and holds it until gas is favorable or the deadline is reached | `queue request.json` (to, value, data, deadline, cap, optional target) → a ladder the sender signs → `watch` holds while the base fee is above the target and sends the cheapest covering rung when it is not. On a fork with an injected spike (60 gwei falling to 10), the job **held for 9 blocks and was sent at the floor** ([fork-proof.json](public/runs/fork-proof.json), scenario B). |
| 03 | Reports the actual gas paid compared with the price at request time | From the receipt's `effectiveGasPrice` vs the base fee in the block the job was queued: B paid **10 gwei vs 60 at request (−83.3 %)**; A (calm) 10 vs 10; C 83.2 vs 80 (+4.0 %, sent at the deadline); D 14.1 vs 10 (+41 %, the base fee rose after sending). Also the fee in PROS, the wait, and the seconds left before the deadline. |
| 04 | Never misses the deadline. It submits at the deadline even if gas is high | From the last call (60 s before the deadline) the rung that covers the base fee three blocks ahead is sent, whatever the price; a rung that stalls or is priced out is replaced by the next one (same nonce). Fork scenario C (80 gwei throughout): **held, sent at the last call, included 50 s before the deadline**. Simulation: **2,000 random base-fee paths, 2,000 included in time, 0 included twice** ([simulation.json](public/runs/simulation.json)). The guarantee holds up to the cap the sender signed; above it the agent says so at once. |

## What Pacific's fee market really looks like ([market.json](public/runs/market.json))

Read from mainnet at block 22,587,090:

- The base fee was **10 gwei in every one of the last 1,024 blocks and at all 31 points over 30 days**. Blocks have
  a 1,000,000,000 gas limit and were at most 0.18 % full, so the EIP-1559 base fee has no reason to rise.
- Yet of **792 transactions** in those blocks, **328 (41.4 %) paid above the base fee** — the 90th percentile paid
  103 gwei, the most 297 gwei — **1.64 PROS paid for nothing** in about 16 minutes, while 464 transactions with tip 0
  were included all the same.

So on Pacific today the optimizer usually sends at once with tip 0 — its saving is not overpaying. The holding and
deadline logic engage when the base fee rises, which is why they are proven on a fork with injected spikes and in a
simulation (both labelled as such).

## Five situations on a fork ([fork-proof.json](public/runs/fork-proof.json))

`npm run gas -- demo` forks Pacific (block 22,586,910 for the recorded run), sets the fork's base fee per block with
`anvil_setNextBlockBaseFeePerGas`, mines blocks 10 s of chain time apart, and lets a fresh test key sign the ladder:

| | situation | what the agent did | result (real receipt) |
|---|---|---|---|
| A | calm (10 gwei) | sent rung 0 at once (tip 0) | paid 10 vs 10 at request · 590 s to spare |
| B | spike 60 → 10 | held 9 blocks, sent rung 0 at the floor | **paid 10 vs 60 (−83.3 %)** · 500 s to spare |
| C | 80 gwei to the deadline | held, sent at the last call | paid 83.2 vs 80 · **included 50 s before the deadline** |
| D | sent at 10, base fee jumps to 14 | replaced by rung 1 (same nonce) | paid 14.1 · 2 rungs sent, **1 included** |
| E | the sender uses the nonce for another tx | stopped | superseded · 0 rungs included |

## Run it

```bash
npm install
npm run gas -- market                                  # the market now (add --gas 120000 for a quote)
cp request.example.json request.json                   # set from, to, value/data, deadline, capGwei
npm run gas -- queue request.json --dir .gas/sweep     # nonce, gas, the ladder → .gas/sweep/to-sign.json
npm run gas -- sign .gas/sweep                          # with SENDER_PRIVATE_KEY in .env — or sign elsewhere and:
npm run gas -- attach .gas/sweep --signed signed.json   # each rung checked: exactly its rung, signed by the sender
npm run gas -- watch .gas/sweep                         # until included / superseded; Ctrl+C and re-run is safe
npm run gas -- status .gas/sweep                        # the log and the report
npm run gas -- demo                                     # the fork run above (Anvil comes via npm)
npm run web                                             # the demo site on http://localhost:3160
```

`tick --dry` decides without broadcasting. Settings: [.env.example](.env.example). The policy, rung by rung:
[references/policy.md](skill/pharos-gas-optimizer/references/policy.md).

## Design notes

- **Why a ladder.** Fees are part of what is signed, so a transaction signed now cannot be re-priced later. Signing
  the same transaction at a handful of fees up front lets the agent act later without a key; the shared nonce makes
  double execution impossible, and every rung is a valid replacement for the one below (fee and tip +10 % or more).
- **Never fooled.** Every tick checks the receipt of every rung (not only the ones it logged as sent) and the sender's
  nonce, so a crash between sending and logging, or the sender's own wallet using the nonce, is seen at once.
- **Chain time.** The deadline is judged against block timestamps, the same clock the chain uses.
- **Wallet support.** Signing a transaction without sending it (`eth_signTransaction`) is not offered by every
  browser wallet; the CLI's `sign` (your key, locally) and `attach` (signed elsewhere) cover both cases.
- **Gas for the rate limit.** The public RPC rate-limits bursts (HTTP 429): the client backs off and retries, heavy
  block reads go a few at a time, and the API caches its answer for 30 s.

## Tests

```bash
npm test                 # 7 unit tests: the ladder, validation, every policy branch, 2,000 simulated fee paths, attach checks, the report
npm run test:e2e         # 4 live checks on Pacific: market + history, the CLI with a test sender (queue → sign → tick --dry), CLI errors, API
node test/e2e.js --fork  # + the five fork scenarios
```

## Files

- `lib/market.js` — fee history, 30-day samples, what others paid · `lib/ladder.js` — the rungs · `lib/policy.js` — the decision
- `lib/agent.js` — jobs, ticks, the report · `lib/simulate.js` — the 2,000-path simulation · `tasks/gas/gas.js` — the CLI
- `api/market.js` — the live market · `scripts/fork-proof.js` — the five scenarios (`--record` rewrites the proof) · `scripts/record.js` — market + simulation

MIT
