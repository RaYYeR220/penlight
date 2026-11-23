# Proof

Everything below is on Solana **devnet** or MagicBlock's devnet **Private Ephemeral Rollup**. Base-layer links open the Solana explorer; rollup transactions open the explorer pointed at the rollup's RPC. Transactions that touch a lot's private seal are not shown to outside readers by the rollup — that is the privacy working; the public lot account and its Solana record show what they did.

## Deployment

| | |
|---|---|
| Program | [`2gqehWewPNJg9t6XtnniyNk8iuC5p6ew1q4XrNHLopkt`](https://explorer.solana.com/address/2gqehWewPNJg9t6XtnniyNk8iuC5p6ew1q4XrNHLopkt?cluster=devnet) |
| House | [`GGb64jL6jdTgiVD2Nyzxf8R3w3vrd79vgwG5ZvCssSCd`](https://explorer.solana.com/address/GGb64jL6jdTgiVD2Nyzxf8R3w3vrd79vgwG5ZvCssSCd?cluster=devnet) |
| Enclave validator (TDX) | `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` at `https://devnet-tee.magicblock.app` |
| VRF queue used (inside the rollup) | `5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc` |
| Pricing oracle | `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd` (feed accounts listed in `packages/sdk/src/constants.ts`) |
| App | https://penlight-app.vercel.app |

## One lot, start to finish (end-to-end run, `results/e2e-latest.json`)

Lot #1 — [`BVxnTgL7eGnQHQec1PUjEozwf8BedDAvHPMPwdQMtbqw`](https://explorer.solana.com/address/BVxnTgL7eGnQHQec1PUjEozwf8BedDAvHPMPwdQMtbqw?cluster=devnet), a House lot.

| Step | Layer | Transaction |
|---|---|---|
| Create the lot | Solana | [`45f4rpfJ…`](https://explorer.solana.com/tx/45f4rpfJZ3Ka3xXTN6Mvjd6cXuPzoSwwZAGym4tBzRztaywRXry8ZECEVZpeEsyd9JWQQn8rrrTif3vWLCnFNtLE?cluster=devnet) |
| Refused: delegate to a validator outside the enclave | Solana | simulation rejected (`WrongValidator`) |
| Delegate lot + seal to the enclave | Solana | [`3nF39brG…`](https://explorer.solana.com/tx/3nF39brGtrQEobxrVkTmg3mgQPRbNqeyMfJ555u4nSnfyCfQCxxG2B3JPsCRVcsiVKAuv4pvVmu655Yhufcgw5nC?cluster=devnet) |
| Refused: draw the seed before the seal is private | Rollup | `4sErwSdZ…` (`NotSealed`) |
| Make the seal private | Rollup | `saK5UWye…` |
| VRF requested inside the rollup (callback ~220 ms later) | Rollup | `3cN1fMXp…` |
| Contents drawn by the seed from the private pool | Rollup | `4E42Ajfr…` |
| Sealed lot committed to Solana, clock opens | Rollup → Solana | `33bNNM5U…` |
| Refused: take before the clock opens | Rollup | `5w1H1eNo…` (`TooEarly`) |
| Facts 1–3 disclosed by the enclave | Rollup | `2mgAPp6b…`, `3TntLfju…`, `QakZvuV3…` |
| Refused: take under the clock price | Rollup | `2RKR7MtV…` (`PriceAboveLimit`) |
| Refused: the seller takes their own lot | Rollup | `ZdhZrZgN…` |
| **TAKE** — paid 28.374 USDC at rollup block 868,707,041, landed in 444 ms | Rollup | `wLCFQnvH…` |
| Opened: worth $25.82, edge −$2.55 | Rollup | `4UAtK1kG…` |
| Delivered to the winner | Rollup | `g4AC96Pr…` |
| Final record committed back to Solana | Rollup → Solana | `5WN3wUdz…` |

Full signatures for every step, plus a consigned lot (#2, resold by its winner, edge +$2.03) and a lot nobody took (#3, opened and returned anyway), are in [`results/e2e-latest.json`](results/e2e-latest.json).

## Check it yourself

```bash
npm install
npx penlight verify 1     # seal, every fact, the price paid, the value — from the Solana record
npx tsx scripts/e2e.ts    # runs three fresh lots and every refusal again
```

Or open https://penlight-app.vercel.app/verify/1.

## The numbers

- [`results/eval-skill.json`](results/eval-skill.json) — reading the facts vs not, 1,000 simulated lots at live prices.
- [`results/bench-er-vs-l1.json`](results/bench-er-vs-l1.json) — block rate, clock resolution and landing time, rollup vs Solana devnet.

## Upstream

While building on SDK 0.18.0 we found that `#[vrf_callback]` derives its identity PDA at runtime (≈265k CU), so callbacks failed; reported with a fix: [magicblock-labs/ephemeral-rollups-sdk#343](https://github.com/magicblock-labs/ephemeral-rollups-sdk/issues/343). Penlight uses the compile-time workaround described there.
