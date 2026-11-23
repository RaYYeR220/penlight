# Solana Blitz v10 — Entertainment Finance: the brief, line by line

| The brief asks for | Penlight | Evidence |
|---|---|---|
| Integrate MagicBlock's Ephemeral Rollup, Private ER or VRF | All three, each load-bearing: the lot lives in a **Private ER** (TDX), its clock runs on the rollup's 10 ms blocks, its seed comes from **VRF requested inside the rollup** | `programs/penlight/src/lib.rs` (`delegate_lot`, `seal_permission`, `open`/`on_shuffle`); [PROOF.md](PROOF.md) |
| "Games are becoming markets": trade, collect, compete, win assets you own | Lots of real (devnet-twin) tokens priced by real feeds; the winner owns the tokens and can withdraw them to Solana or consign them again | `/collection` (withdraw), `/studio` (consign) |
| Idea: *"Storage wars — bid on a sealed vault of collectibles with only a few hints about what's inside, highest bid opens it"* | A sealed vault on a falling clock — the Dutch form of "highest bid wins", raced in real time — whose hints are chosen by VRF and disclosed by the enclave, not written by the seller | the lot room, `/lot/[id]` |
| Zero-fee transactions | Every action on a lot is gasless inside the rollup; the House relays the few Solana fees a player needs | `results/bench-er-vs-l1.json` |
| VRF | Requested from the rollup's VRF queue, delivered in ~220 ms, written to the private seal; decides the facts and, for House lots, the contents | `results/e2e-latest.json` |
| Privacy (Private ER) | Seal and pool ledger behind permissions with no readers; token balances readable only by their owner; refusals if anything touches a seal before it is private | e2e privacy steps; CLAIMS.md |
| Skill games with prize pools / trading competitions | Reading the facts measurably pays: same rule, +$5.05 vs −$3.50 per lot won; a leaderboard of realized edge | `results/eval-skill.json`, `/leaderboard` |
| Judged on creativity | Disclosure as a market mechanic: the price and the information fall together, and a player decides when they know enough | landing replay; lot room |
| Judged on technical depth | Commit-before-clock seals; VRF in the enclave; enclave-computed facts that re-derive bit for bit; private pool reservations; Magic ATAs; validator-pinned delegation; 22 program tests + cross-language parity; an MCP server; an upstream SDK fix | README "Run it"; [ephemeral-rollups-sdk#343](https://github.com/magicblock-labs/ephemeral-rollups-sdk/issues/343) |
| Judged on showcasing what's possible on Solana | A 45 s clock in 4,497 steps of $0.012 (vs 194 steps on L1); judge-run demo with no wallet; final records on Solana | `results/bench-er-vs-l1.json`; JUDGES.md |
| Submission: program address, GitHub, demo, explorer link | Program `2gqehWewPNJg9t6XtnniyNk8iuC5p6ew1q4XrNHLopkt`; this repo; https://penlight-app.vercel.app; explorer links in PROOF.md | — |
| On-chain activity strengthens a submission (delegations, VRF, private payments) | Every lot = 2 delegations + 1 VRF request; every new player = 1 private payment (faucet) | House activity feed; program account history |
