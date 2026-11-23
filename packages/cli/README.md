# penlight

The Penlight floor from a terminal. Watch lots fall, read their facts as they come out, appraise them, take one, and check any opened lot against its public record.

Penlight sells sealed lots of tokens on a falling price clock inside MagicBlock's private ephemeral rollup. Each lot discloses five true facts about what's inside as its price falls; the first take wins and pays the clock price at the slot it lands. Afterwards the lot is opened, its contents are valued at oracle prices and delivered, and the final record settles back to Solana.

## Run it

From the repository root:

```sh
npm install
npx penlight lots
```

or, without the bin link, `npm run penlight -w @penlight/cli -- lots`.

## Commands

| Command | What it does |
| --- | --- |
| `penlight lots [--limit N]` | Newest lots (10 by default): status, current clock price, facts so far, and the result once opened (paid, value, edge). |
| `penlight lot <id>` | One lot in full: clock, every fact with the slot it came out at, sale, contents, salt and seed. |
| `penlight verify <id\|address>` | Re-derives an opened lot from its public record and prints each check. Exits 1 if any check fails. |
| `penlight appraise [id]` | Appraises a live lot from the facts disclosed so far, at live oracle prices, and says at what clock price it is worth taking. With no id, appraises every live lot. |
| `penlight take <id> --max <usd> --key <path>` | Takes a live lot at the current clock price, never paying more than `--max`. |
| `penlight faucet --key <path>` | Asks the House for 250 test USDC, sent privately into your rollup balance. |
| `penlight holdings --key <path>` | Your rollup balances, valued at oracle prices. |

`--key` is a standard Solana keypair file (a JSON array of 64 numbers). `take` and `holdings` use it to open a signed session with the rollup, since balances there are private to their owner; `faucet` only sends the public key.

## Verify

`verify` is the command for anyone who wants to check the House's work. It reads the lot from Solana once it has settled (from the rollup before that) and re-derives, from nothing but the public record:

- the seal: `sha256(lot ‖ salt ‖ mints ‖ amounts)` equals the commitment posted before the clock opened;
- every fact: re-rendered from the lot's seed and the oracle prices recorded with it, and true for the contents;
- the price: the clock price at the slot of the take equals what the winner paid;
- the value: Σ amount × oracle price equals the recorded value.

```
$ penlight verify 0
Lot #0 E9bTTgP22yqAptqmdE3ky4FfCHYMXrgt8s1FKXqzGZBX
read from Solana devnet (settled record) · delivered · worth $24.53 · paid $27.44

  ✓ lot is opened          contents, salt and seed are public
  ✓ seal matches contents  sha256(lot‖salt‖mints‖amounts) = 5178264f4a19662c… vs sealed 5178264f4a19662c…
  ✓ fact 1 re-derived      "Contains WIF" — same seed, same fact; true for the contents
  ✓ fact 2 re-derived      "1 memecoin inside" — same seed, same fact; true for the contents
  ✓ fact 3 re-derived      "The largest item is at least 20% of the value" — same seed, same fact; true for the contents
  ✓ paid the clock price   price at rollup slot 868747972 = 27438000, paid 27438000
  ✓ value re-computed      Σ amount × oracle price = 24531412 micro-USD vs recorded 24531412

All 7 checks pass. Seal, facts, price and value all re-derive from the public record.
https://explorer.solana.com/address/E9bTTgP22yqAptqmdE3ky4FfCHYMXrgt8s1FKXqzGZBX?cluster=devnet
```

## Appraise

House lots are drawn from the House pool by a public procedure and a seed nobody knows in advance. The appraisal samples that procedure, keeps only the draws every disclosed fact allows (each at the oracle prices it was computed with), and values what survives at live prices: p10, p50 and p90. When later facts leave too few draws standing, it falls back to what the facts state outright about the total. Consigned lots were chosen by their seller, so only those stated bounds count.

The suggested price is 90% of the median (or the 10th percentile, when the spread is tighter than that), along with the rollup slot at which the clock reaches it. A clock lasts well under a minute, and every new fact can move the appraisal.

## Configuration

| Variable | Default |
| --- | --- |
| `PENLIGHT_HOUSE_URL` | `http://35.187.34.216:8787`, the House API that runs the faucet |
| `PENLIGHT_BASE_RPC` | Solana devnet RPC |
| `PENLIGHT_TEE_RPC` | MagicBlock private rollup RPC |
| `PENLIGHT_DEPLOYMENT` | the devnet deployment bundled with `@penlight/sdk` |

Money is shown in dollars of test USDC. Rollup slots are about 10 ms each.

## As a library

`@penlight/cli` also exports the layer the commands are built on (`Floor`, `Wallet`, `faucet`, `summarize`, `detail`), which the Penlight MCP server uses too.
