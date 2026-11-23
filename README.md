# Penlight

**Sealed lots of real tokens, sold on a falling clock inside a private rollup.**

A lot is a sealed vault of tokens. Its price falls every 10 ms rollup block. As it falls, the lot discloses true facts about what's inside: facts that randomness chose and the enclave computed, never the seller. The first person to press **TAKE** pays the price of the block it lands in and owns everything inside. Then the lot opens: exact contents, live value, and the buyer's edge to the cent.

Packs sell you odds. Penlight sells you the box: sealed on Solana before the clock starts, hinted by randomness nobody controls, priced by you.

**Live:** https://penlight-app.vercel.app · **Verify any lot:** https://penlight-app.vercel.app/verify · **Review in 5 minutes:** [JUDGES.md](JUDGES.md) · [PROOF.md](PROOF.md) · [CLAIMS.md](CLAIMS.md)

Built on Solana and MagicBlock: **Private Ephemeral Rollups** (Intel TDX), **VRF inside the rollup**, the **pricing oracle**, and **Ephemeral SPL Token** custody.

## What the numbers say

<!-- results:headline -->
- **Reading the facts pays.** Same buying rule, same 1,000 lots at live oracle prices, head to head: with the facts it wins 52% of lots at **+$5.05** each; without them it wins 48% at **−$3.50** each. ([eval](results/eval-skill.json))
- **A clock that moves every 10 ms.** The rollup made 99.93 blocks/s against Solana devnet's 4.32; a 45 s clock falls in 4,497 steps of $0.012 instead of 194 steps of $0.2784. ([bench](results/bench-er-vs-l1.json))
- **Randomness from inside the enclave in ~221 ms.** VRF requested and delivered within the private rollup. ([e2e](results/e2e-latest.json))
- **Every opened lot re-derives bit for bit.** 3/3 lots in the end-to-end run re-verified from their Solana record; 10/10 attacks refused on-chain.
<!-- /results:headline -->

## How a lot works

```mermaid
sequenceDiagram
    participant S as Solana (devnet)
    participant R as Private rollup (TDX)
    participant P as Players
    S->>S: create lot + sha256 seal of the contents
    S->>R: delegate lot and its seal to the enclave validator
    R->>R: seal made private (no readers), tokens packed
    R->>R: VRF seed requested and delivered inside the rollup
    R->>S: sealed lot committed to Solana, clock opens
    loop every 10 ms block
        R->>P: price falls; at 15/30/45/60/75% a fact is disclosed
    end
    P->>R: TAKE — pays this block's price, takes title (one transaction)
    R->>R: unseal: contents, salt, seed and oracle value made public
    R->>P: tokens delivered to the winner
    R->>S: final record committed and returned to Solana
```

1. **Seal.** A seller (or the House) creates a lot on Solana with a sha256 commitment over every token slot. House lots are packed later by the VRF seed from a private pool, so nobody chooses what goes in, not even the House.
2. **Enclave.** The lot and its private *seal* move into MagicBlock's Private Ephemeral Rollup. The seal holds the salt, the amounts and the seed behind a permission with no readers. The tokens sit in accounts only the enclave program can move.
3. **Randomness.** The lot asks the VRF oracle for a seed **from inside the rollup**. The seed decides which facts the lot will disclose, which tokens they mention, and where value bands sit. It's written to the private seal, so nobody can predict the facts.
4. **Clock.** The sealed lot is committed to Solana, then the clock opens. The price is a pure function of the rollup slot: it falls every 10 ms block.
5. **Facts.** At 15, 30, 45, 60 and 75% of the clock, anyone can ask the program to disclose the next fact. The enclave computes it from the sealed contents and **live oracle prices**, and records the prices it used.
6. **TAKE.** Payment and title move in one rollup transaction, at the clock price of the block it lands in.
7. **Open.** Contents, salt and seed become public; the oracle values what was inside; the tokens go to the winner. The final record is committed back to Solana, where anyone can re-derive every fact, the seal and the price paid.

Possible lots left after each fact, in the eval: <!-- results:narrowing -->
1 → 39.9% · 2 → 16.1% · 3 → 10.6% · 4 → 2.9% · 5 → 0.66%
<!-- /results:narrowing -->

## Why this needs a private rollup

| | Plain Solana program | Penlight on MagicBlock |
|---|---|---|
| Hidden contents | Account data is public; "encrypted" contents need the seller to come back and reveal | The seal lives in the enclave; the program discloses facts on schedule; nobody can read ahead |
| A clock you can race | ~400 ms slots, priority fees decide who's first | 10 ms blocks, gasless; the price is that block's price |
| Fair randomness | VRF result is public the moment it lands | Seed lands in the private seal; facts are unpredictable until they come out |
| Moving tokens | Fees on every transfer | Payment and delivery inside the rollup, settle back to Solana |

<!-- results:bench -->
| | Private rollup | Solana devnet |
|---|---|---|
| Blocks per second | 99.93 | 4.32 |
| 45 s clock, price steps | 4,497 × $0.012 | 194 × $0.2784 |
| Signed tx, send → confirmed (median, EU client) | 452 ms | 893 ms |
| Fee per transaction | 0 | 5,000 lamports |
<!-- /results:bench -->

## Reading the facts

The House packs its lots with a public procedure from a secret seed, so the honest prior is "any lot the procedure can make". Each fact rules some of those out. The SDK's appraiser keeps the candidates consistent with every fact and reads a value range off what survives. The House's rival bidders use it, and so can anyone.

<!-- results:eval -->
| Strategy | Lots won | Avg edge per lot won |
|---|---|---|
| Prior only (naive baseline) | 480 | −$3.50 |
| Appraiser (reads facts) | 520 | +$5.05 |
<!-- /results:eval -->

<!-- results:crowd -->
In a crowd that includes someone pressing at random, the random presser takes 54% of lots and loses −<!-- results:crowd -->7.35 on each one: the first press is not the best press.
<!-- /results:crowd -->

## Verify any lot yourself

```bash
npm install
npx penlight verify 5
```

`verify` reads the lot's final record from Solana and re-derives:

- the seal: sha256 over the lot, salt, mints and amounts, against the commitment posted before the clock opened;
- every fact, from the seed, the contents and the oracle prices it was computed with;
- the price paid, from the clock at the block the TAKE landed in;
- the value, from the amounts and the oracle prices at opening.

## Packages

| Path | What |
|---|---|
| `programs/penlight` | The Anchor program (Rust): lots, seals, clock, facts, VRF, pool, delivery |
| `packages/sdk` | TypeScript client: instruction builders, rollup connections, the facts engine, the appraiser, `verifyLot` |
| `packages/cli` | `penlight` — browse, appraise, take and verify lots from a terminal |
| `packages/mcp` | An MCP server, so agents can read lots, appraise them and bid |
| `apps/house` | The House: keeps lots moving, runs the faucet, relays a player's first base-layer fees, fields three rival bidders |
| `apps/web` | The app |
| `scripts` | Devnet setup, the end-to-end run, the eval, the benchmark |

## Run it

```bash
# program tests (facts, clock, oracle, pool draw, seal)
cargo test -p penlight --lib
# SDK parity with the program (300 fact cases, 100 draws, seals)
npm test
# full lifecycle on devnet + the private rollup (writes results/e2e-latest.json)
npx tsx scripts/e2e.ts
# the eval and the benchmark
npx tsx scripts/eval.ts 1000 20000
npx tsx scripts/bench.ts
```

## Program

Devnet program: `2gqehWewPNJg9t6XtnniyNk8iuC5p6ew1q4XrNHLopkt` · House `GGb64jL6jdTgiVD2Nyzxf8R3w3vrd79vgwG5ZvCssSCd` · enclave validator `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`

| Instruction | Where | What |
|---|---|---|
| `init_house`, `delegate_pool` | Solana | House config, catalogue, private pool ledger |
| `create_lot` / `create_house_lot` | Solana | A lot with its seal |
| `delegate_lot` | Solana | Hand lot + seal to the enclave validator (pinned) |
| `seal_permission`, `pool_permission` | Rollup | Make the seal / pool ledger unreadable |
| `pack` / `pack_from_pool` | Rollup | Seller packs against the seal / the seed draws from the pool |
| `open` → `on_shuffle` | Rollup | VRF request and callback, inside the rollup |
| `go_live` | Rollup → Solana | Commit the sealed lot, start the clock |
| `reveal` | Rollup | Disclose every fact that is due |
| `take` | Rollup | Pay the clock price, take title |
| `unseal`, `deliver` | Rollup | Open the lot, move the tokens |
| `settle` | Rollup → Solana | Commit the final record and return it to Solana |

## Honest limits

- **Devnet, with twin tokens.** The tokens in lots are devnet twins of real tokens, priced by real feeds. See [MOCKS.md](MOCKS.md).
- **Trust in the enclave.** Privacy rests on Intel TDX and MagicBlock's TEE validator. The app checks the endpoint's attestation; the SDK's check does not yet authenticate the endpoint itself.
- **Deposits show on Solana.** Moving tokens into the rollup shows the mint and amount on the base layer; which lot they end up in doesn't.
- **Rival bidders are bots.** Three of them, run by the House and labelled wherever they appear.
- **Account limits.** The rollup accepts 38 account keys per transaction today, which is why lots hold up to eight token kinds and packing is split from opening.

Every claim above is tagged with its evidence in [CLAIMS.md](CLAIMS.md).

## License

MIT
