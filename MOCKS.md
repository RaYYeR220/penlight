# What is real and what is simulated

Penlight runs on Solana **devnet** and MagicBlock's devnet **Private Ephemeral Rollup** (Intel TDX). Here is exactly where the line sits.

## Real

| Piece | Where | How to check |
|---|---|---|
| The Penlight program | Solana devnet, `2gqehWewPNJg9t6XtnniyNk8iuC5p6ew1q4XrNHLopkt` | Explorer, or `penlight verify <lot>` |
| Lot state, the clock, the facts | MagicBlock Private ER (devnet TEE validator `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`) | Any lot account on the rollup RPC |
| Seals (sha256 commitments) | Posted to Solana before a lot's clock opens | `go_live` commits the lot; the record is on Solana |
| Randomness | MagicBlock VRF, requested and delivered **inside** the private rollup | The `open` → `on_shuffle` callback on each lot |
| Prices | MagicBlock's pricing oracle (Pyth Lazer feeds republished in the rollup), read on-chain at each fact and at opening | Each lot stores the raw prices it used |
| Token custody and transfers | MagicBlock Ephemeral SPL Token: rollup balances, rollup-only token accounts, private deposits, withdrawals back to Solana | Balances move in the same transactions as payments and deliveries |
| Payments | Test USDC moved by SPL transfers inside the rollup | `take` moves the price from buyer to seller in one transaction |
| Rival bidders | Three keypairs run by the House service, deciding with the same public appraiser anyone can import | `GET /api/deployment` lists them; their takes are ordinary transactions |
| The skill eval | Simulates lots with the program's own draw, facts and clock code at live prices | `npx tsx scripts/eval.ts` |

## Simulated or substituted

| Piece | What it is instead | Why |
|---|---|---|
| The tokens inside lots | **Devnet twins** of SOL, BONK, WIF, JUP, JTO, PYTH, RAY and POPCAT: our own SPL mints with the real tokens' decimals, priced by the **real** feeds | Those tokens don't exist on devnet. The prices, and so every value and every edge, are real market data. |
| USDC | A test USDC mint | Same reason |
| The House pool | Inventory the House minted itself | Devnet |
| Mainnet | Not deployed to mainnet | Devnet only for this build; nothing in the program is devnet-specific apart from the catalogue mints |

Nothing in the app shows a number that wasn't read from the chain or computed from chain data.
