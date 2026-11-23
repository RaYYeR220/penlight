# Penlight MCP server

Lets an agent play Penlight: read the floor, appraise sealed lots from the facts they disclose, take one when the price is right, fund itself with test USDC, and verify any opened lot against its public record.

Penlight sells sealed lots of tokens on a falling price clock inside MagicBlock's private ephemeral rollup on Solana devnet. Five true facts about each lot's contents come out as its price falls; the first take wins and pays the clock price at the slot it lands. The lot is then opened, valued at oracle prices and delivered to the winner.

## Tools

| Tool | Input | Returns |
| --- | --- | --- |
| `list_lots` | `limit` (1–50, default 10) | Newest lots with status, current clock price, facts so far and results; ids of live lots |
| `get_lot` | `id` | One lot in full, including the oracle prices behind each fact and, once opened, contents, salt and seed |
| `appraise_lot` | `id` | p10/p50/p90 value from the facts so far at live prices, the stated bounds, the current clock price, and a plain-language suggestion of the price at which the lot is worth taking and when the clock gets there. Never trades. |
| `take_lot` | `id`, `max_price_usd` | Takes a live lot at the clock price, never above `max_price_usd`. Returns the signature and the price paid. |
| `fund_agent` | none | 250 test USDC from the House faucet, sent privately into the agent's rollup balance |
| `my_holdings` | none | The agent's rollup balances (test USDC and every token a lot can hold), valued at oracle prices |
| `verify_lot` | `id` | Re-derives the seal, every fact, the price paid and the value delivered; each check with `ok` and a detail line |

Only `take_lot` spends anything, and it only ever acts when called. The server also sends MCP clients a short description of the game when they connect.

## Configure your MCP client

Install once from the repository root (`npm install`), then add the server to your MCP client's configuration:

```json
{
  "mcpServers": {
    "penlight": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/penlight/packages/mcp/src/index.ts"],
      "env": {
        "PENLIGHT_HOUSE_URL": "http://35.187.34.216:8787",
        "PENLIGHT_KEYPAIR": "/absolute/path/to/agent.json"
      }
    }
  }
}
```

Both `env` entries are optional:

| Variable | Default |
| --- | --- |
| `PENLIGHT_KEYPAIR` | `~/.penlight/agent.json`, created on first use if it doesn't exist |
| `PENLIGHT_HOUSE_URL` | `http://35.187.34.216:8787`, the House API that runs the faucet |
| `PENLIGHT_BASE_RPC` / `PENLIGHT_TEE_RPC` | Solana devnet and the MagicBlock private rollup |

A fresh agent has no funds. Its first `take_lot` reports where its new keypair was written and asks it to call `fund_agent` first. Balances in the rollup are private, so `my_holdings` reads them through a session signed with the agent's own key.

## How an agent might play

1. `list_lots` to find a live lot.
2. `appraise_lot` on it: compare the clock price to the suggested price, and re-appraise as each fact lands (five per lot, at 15/30/45/60/75% of the clock).
3. `take_lot` with a `max_price_usd` it is comfortable with. A clock runs for well under a minute, so a decision can't wait long.
4. `get_lot` afterwards to see what was inside and the edge, and `verify_lot` to check it.

## Check it works

```sh
npx tsx packages/mcp/test/smoke.ts
```

This starts the server over stdio, lists its tools, and calls `list_lots`, `verify_lot`, `get_lot` and `appraise_lot` against the live devnet deployment. It never takes or funds.
