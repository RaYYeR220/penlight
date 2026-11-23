# Review Penlight in five minutes

No wallet, no install, no devnet SOL needed: the app makes a key in your browser and the House pays every fee.

1. **Open https://penlight-app.vercel.app** — the page's object is a live replay of one lot: the ring is the clock, each fact rules out most of what the vault could be. Press **Take** on it to feel the decision.
2. **Open the floor** (`/floor`). Being there tells the House to keep lots open; a fresh one is sealed, drawn by VRF inside the enclave and on the clock within ~10 s. The activity column shows every step with its transaction.
3. **Get test USDC** from the chip in the nav. It arrives as a *private* transfer into your rollup balance (MagicBlock private payments), in a few seconds.
4. **Enter a live lot.** Watch the price fall every 10 ms block and the facts come out at 15/30/45/60/75%. "What the facts say" shows the appraisal the House's own bidders use. Three bidders (Marlow, Ines, Bram) are racing you.
5. **Press TAKE.** It lands in the rollup in well under a second. The lot opens: contents, live value, your edge, and **Verified ✓** — the seal, every fact and the price you paid re-derived in your browser.
6. Optional: **Studio** — consign what you just won as a lot of your own (the House relays the Solana fees). **Collection** — withdraw a token to a normal Solana account.
7. **Verify any lot from a terminal:** `npm install && npx penlight verify 1` (all 7 checks re-derive from the lot's Solana record).

## Where to look in the code

| What | Where |
|---|---|
| Lot lifecycle, permissions, VRF, delivery | `programs/penlight/src/lib.rs` |
| The facts engine (every fact is true; 3,000-lot test) | `programs/penlight/src/hints.rs` |
| House lots packed by the seed | `programs/penlight/src/draw.rs` |
| Oracle reads (owner, feed id, freshness, posted slot) | `programs/penlight/src/oracle.rs` |
| SDK port, bit-for-bit with the program | `packages/sdk/src/facts.ts`, `packages/sdk/test/parity.test.ts` |
| Verifier | `packages/sdk/src/verify.ts` |
| Appraiser (rejection sampling over the public draw) | `packages/sdk/src/appraise.ts` |
| The House (keeper, faucet, relay, bidders) | `apps/house/src` |

## Evidence

- [PROOF.md](PROOF.md) — addresses and one lot's every transaction.
- [CLAIMS.md](CLAIMS.md) — each public claim with how to reproduce it, and what we don't claim.
- [MOCKS.md](MOCKS.md) — what is real and what is a devnet stand-in.
- [CHALLENGE_CHECKLIST.md](CHALLENGE_CHECKLIST.md) — the brief, line by line.
