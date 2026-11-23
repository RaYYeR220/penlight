# Claims, and how each one is backed

Every public statement about Penlight, tagged by how you can check it.

- **REPRODUCIBLE** — a script in this repo regenerates it.
- **VERIFIED-LIVE** — check it on devnet / the rollup right now.
- **MODELED** — the output of a simulation; the model is in the repo.
- **NOT-CLAIMED** — things we deliberately do not say.

| Claim | Tier | Evidence | Reproduce |
|---|---|---|---|
| A lot's contents are bound by a sha256 seal on Solana before its clock opens | VERIFIED-LIVE | Each lot's `commitment`; `go_live` commits the lot before `open_slot` | `penlight verify <id>` |
| The seal and the House pool ledger cannot be read from outside the enclave | VERIFIED-LIVE | `results/e2e-latest.json` → privacy steps (outsider reads come back hidden) | `npx tsx scripts/e2e.ts` |
| The lot's facts are chosen by VRF randomness drawn inside the private rollup | VERIFIED-LIVE | `open` requests from the rollup's VRF queue; `on_shuffle` writes the seed to the private seal | `scripts/e2e.ts` (callback timing) |
| Every disclosed fact is true and re-derives bit for bit from the opened lot | REPRODUCIBLE | `verifyLot` recomputes each fact from seed, contents and the stored prices | `penlight verify <id>`; `cargo test` (3,000 random lots) |
| The TAKE pays exactly the clock price of the rollup block it lands in | VERIFIED-LIVE | `paid == price_at(sold_slot)` check in `verifyLot` | `penlight verify <id>` |
| House lots are packed by the seed, not by the House | VERIFIED-LIVE | `pack_from_pool` draws from the private pool with the seed; the pool ledger has no readers | `programs/penlight/src/draw.rs`, e2e |
| Same rule, with vs without the facts: +$5.05 vs −$3.50 per lot won (N=1,000) | MODELED | `results/eval-skill.json` | `npx tsx scripts/eval.ts 1000 20000` |
| The clock on the rollup moves in 4,497 steps over 45 s vs 194 on Solana devnet | REPRODUCIBLE | `results/bench-er-vs-l1.json` | `npx tsx scripts/bench.ts` |
| VRF callback lands ~220 ms after the request inside the rollup | REPRODUCIBLE | `results/e2e-latest.json` | `npx tsx scripts/e2e.ts` |
| Attacks are refused on-chain (wrong validator, reading before sealing, early take, under-limit take, self-take, tampered pack) | REPRODUCIBLE | `results/e2e-latest.json` → NEGATIVE steps | `npx tsx scripts/e2e.ts` |
| Winnings leave the rollup to a normal Solana token account | VERIFIED-LIVE | Collection → Withdraw; Ephemeral SPL Token shuttle withdrawal | — |

## Not claimed

- **Mainnet.** Penlight runs on devnet; the tokens are devnet twins priced by real feeds (see [MOCKS.md](MOCKS.md)).
- **That the TEE cannot be broken.** Privacy rests on Intel TDX and MagicBlock's enclave; the client verifies the endpoint's attestation, and the SDK's attestation check does not yet authenticate the endpoint itself (upstream issue #158).
- **That bidders are humans.** Three rival bidders run by the House are labelled everywhere they appear.
- **A profitable strategy.** The eval shows that reading facts beats ignoring them under one simple rule; it does not show anyone a guaranteed profit.
- **That deposits are private on the base layer.** Moving tokens into the rollup shows the mint and amount on Solana; which lot they end up in does not show.
