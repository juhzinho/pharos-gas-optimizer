---
name: pharos-gas-optimizer
description: Time a non-urgent transaction on Pharos Pacific Mainnet for the lowest gas within a deadline. Watches the fee market (base fee per block, how full blocks are, what other senders really pay on top), holds the transaction while gas is above the target, always sends it by the deadline, and reports the price actually paid vs the price when it was handed over. The sender signs a small fee ladder of the same transaction (same nonce, rising fees) once; the agent only chooses which signed rung to broadcast and when, so it never holds a key and the transaction can never run twice. Use for "send this when gas is cheap", "by Friday at the latest", "what is gas on Pharos now", "am I overpaying gas" on Pharos.
license: MIT
metadata:
  author: juhzinho
  version: "1.0.0"
  chain: "Pharos Pacific Mainnet (1672)"
---

# Pharos Gas Optimizer

A Skill for an agent that sends transactions that can wait — sweeps, rebalances, payouts, claims — at the best
price it can get before a deadline the user sets, and never after it.

```
request + deadline + cap ─▶ ladder (same nonce, maxFee floor → cap, tip 0 → …) ─▶ sender signs every rung once
every tick:  included? → done  ·  nonce used elsewhere? → superseded  ·  nothing sent:  last call → send (deadline wins)
             base fee ≤ target → send the cheapest covering rung  ·  else hold   ·  sent: priced out / stalled / last call → next rung
```

## What it knows about Pacific (read from chain, see `market`)

The base fee is EIP-1559 and has sat at **10 gwei** — blocks have a 1,000,000,000 gas limit and are a tiny fraction
full, so it has no reason to rise. What varies is the tip senders add: in recent blocks roughly a third to a half of
transactions paid above the base fee, some 100+ gwei, while transactions with tip 0 were included all the same. On
Pacific today the agent therefore usually sends at once with tip 0 — the saving is not overpaying; the holding and
the deadline logic engage when the base fee rises (shown on a fork with injected spikes).

## How to run it

The executable lives in the repository root (`tasks/gas/gas.js`). From there:

```bash
npm install
npm run gas -- market                                   # the fee market now, and what others really pay
npm run gas -- queue request.json --dir .gas/sweep      # a job: nonce, gas, the ladder → .gas/sweep/to-sign.json
npm run gas -- sign .gas/sweep                          # SENDER_PRIVATE_KEY (or attach rungs signed elsewhere)
npm run gas -- watch .gas/sweep                         # ticks until included or superseded; Ctrl+C and re-run is safe
npm run gas -- status .gas/sweep                        # the log and the report: paid vs the price at request
npm run gas -- demo                                     # five scenarios on an Anvil fork
```

`request.json`: `{ from, to, value (wei), data, deadline (ISO with zone), capGwei (most per gas you accept at the
deadline), targetGwei (optional; default the recent floor), gas (optional) }`. Exit codes: `0` ok · `3` the deadline
was missed (only possible above the cap) · `2` a mistake in the input · `1` the chain or RPC failed.
Details: [references/policy.md](references/policy.md).

## Rules for the agent

1. **Never hold a key.** The sender signs the ladder; the agent broadcasts signed bytes. `sign` exists for a sender
   running the tool themselves.
2. The deadline beats the price: from the last call the transaction goes out at whatever the base fee is, up to the
   cap. If the base fee exceeds the cap, say so at once — the deadline cannot be guaranteed above it.
3. Report every decision with its reason (held because…, sent because…), and at the end the price paid vs the price
   at request, the wait, and how long before the deadline it landed.
4. If the sender's nonce moves on (they sent something else), stop and say the job is superseded; never re-queue
   silently with a new nonce.
