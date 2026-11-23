#!/usr/bin/env -S npx tsx
/**
 * Penlight MCP server (stdio). Lets an agent read the floor, appraise lots
 * from their disclosed facts, take a lot, fund itself and verify results.
 *
 *   PENLIGHT_KEYPAIR     the agent's keypair file (default ~/.penlight/agent.json, created on first use)
 *   PENLIGHT_HOUSE_URL   House API base for the faucet (default https://penlight-app.vercel.app/api/house)
 */
import "./stdout-guard.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Floor, UserError, detail, expandHome, faucet, loadKeypair, parseUsd, summarize, type Wallet } from "@penlight/cli";

const INSTRUCTIONS = `Penlight sells sealed lots of Solana tokens on a falling price clock, inside MagicBlock's private ephemeral rollup on devnet.

How a lot works:
- Its price falls in a straight line from a start price to a floor over its clock (one rollup slot is about 10 ms; a whole clock is typically under a minute).
- Five true facts about the hidden contents are disclosed at 15%, 30%, 45%, 60% and 75% of the clock. Every fact is guaranteed true and can be checked once the lot is opened.
- The first take wins and pays the clock price at the rollup slot it lands. Then the lot is opened, its contents are valued at live oracle prices and delivered to the winner. Edge = value - price paid.
- All money is devnet test tokens; prices are in US dollars.

Typical flow: list_lots -> appraise_lot on a live lot -> decide -> take_lot. Call fund_agent once before your first take. verify_lot re-derives an opened lot's seal, facts, price and value from its public record. Nothing here trades on its own: only take_lot spends.`;

const server = new McpServer({ name: "penlight", version: "0.1.0" }, { instructions: INSTRUCTIONS });
const floor = new Floor();

// ───────────────────────────── the agent's wallet ─────────────────────────────

const DEFAULT_KEY = path.join(os.homedir(), ".penlight", "agent.json");
let wallet: { w: Wallet; file: string } | null = null;

/** The agent's wallet; creates a keypair at the default path on first use. */
function agentWallet(): { w: Wallet; file: string; created: boolean } {
  if (wallet) return { ...wallet, created: false };
  const configured = process.env.PENLIGHT_KEYPAIR;
  const file = path.resolve(expandHome(configured ?? DEFAULT_KEY));
  let key: Keypair;
  let created = false;
  if (fs.existsSync(file)) key = loadKeypair(file);
  else if (configured) throw new UserError(`PENLIGHT_KEYPAIR points to ${file}, which doesn't exist`);
  else {
    key = Keypair.generate();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(Array.from(key.secretKey)), { mode: 0o600 });
    created = true;
  }
  wallet = { w: floor.wallet(key), file };
  return { ...wallet, created };
}

// ───────────────────────────── helpers ─────────────────────────────

const text = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2);

function run<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return { content: [{ type: "text" as const, text: text(await fn(args)) }] };
    } catch (e) {
      const message = e instanceof UserError ? e.message : `unexpected error: ${(e as Error)?.message ?? e}`;
      return { content: [{ type: "text" as const, text: message }], isError: true };
    }
  };
}

const lotId = z.number().int().min(0).describe("Lot number (lots are numbered from 0 in order of creation).");

// ───────────────────────────── tools ─────────────────────────────

server.registerTool(
  "list_lots",
  {
    title: "List lots",
    description:
      "List the newest Penlight lots, newest first, with each lot's status, current clock price (for live lots), the facts disclosed so far, and the result once opened (price paid, value, edge). Live lots are the ones you can take; their ids are also listed in liveLotIds.",
    inputSchema: { limit: z.number().int().min(1).max(50).default(10).describe("How many of the newest lots to return (1-50).") },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  run(async ({ limit }: { limit: number }) => {
    const [lots, slot] = await Promise.all([floor.lots(limit), floor.rollupSlot()]);
    const views = lots.map((x) => summarize(x, slot));
    return { rollupSlot: Number(slot), liveLotIds: views.filter((v) => v.status === "live").map((v) => v.id), lots: views };
  }),
);

server.registerTool(
  "get_lot",
  {
    title: "Get a lot",
    description:
      "Everything public about one lot: clock (start, floor, current price, next fact due), every disclosed fact with the oracle prices it was computed at, the sale, and once opened the contents, salt and seed. Read from Solana if the lot has settled there, otherwise from the rollup.",
    inputSchema: { id: lotId },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  run(async ({ id }: { id: number }) => {
    const [x, slot] = await Promise.all([floor.lot(id), floor.rollupSlot()]);
    return detail(x, slot);
  }),
);

server.registerTool(
  "appraise_lot",
  {
    title: "Appraise a live lot",
    description:
      "Appraise a live lot from the facts disclosed so far, at live oracle prices. For house lots it samples the public procedure that drew the contents and keeps only draws consistent with every fact, giving p10/p50/p90 of the value; consigned lots only get the value bounds their facts state. Returns the current clock price and a plain-language suggestion of the price at or below which the appraisal says the lot is worth taking, and when the clock gets there. Re-appraise after each new fact. This never trades.",
    inputSchema: { id: lotId },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  run(async ({ id }: { id: number }) => floor.appraise(await floor.lot(id))),
);

server.registerTool(
  "take_lot",
  {
    title: "Take a lot",
    description:
      "Buy a live lot now. Pays the current clock price, never more than max_price_usd, from the agent's test-USDC balance in the rollup; the first take wins and it can't be undone. Refuses without sending if the clock is still above max_price_usd, the lot isn't live, or the balance is short. Returns the transaction signature and the price paid. The agent's wallet is the keypair at PENLIGHT_KEYPAIR (default ~/.penlight/agent.json, created on first use; call fund_agent before the first take).",
    inputSchema: {
      id: lotId,
      max_price_usd: z.number().positive().describe("The most you are willing to pay, in US dollars. The take pays the clock price at the slot it lands, which is never above this."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  run(async ({ id, max_price_usd }: { id: number; max_price_usd: number }) => {
    const { w, file, created } = agentWallet();
    if (created) {
      throw new UserError(
        `No agent wallet existed, so a new one was created at ${file} (address ${w.publicKey.toBase58()}). It holds nothing yet: call fund_agent, then take again.`,
      );
    }
    const r = await w.take(id, parseUsd(max_price_usd));
    return { ...r, buyer: w.publicKey.toBase58(), note: "The lot is now opened and its contents delivered to the buyer; follow it with get_lot." };
  }),
);

server.registerTool(
  "fund_agent",
  {
    title: "Fund the agent",
    description:
      "Ask the House faucet for test USDC: a private transfer into the agent's rollup balance (250 test USDC, once every 6 hours per address). It can take a few seconds to show in my_holdings. Creates the agent wallet first if it doesn't exist.",
    inputSchema: {},
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
  },
  run(async () => {
    const { w, file, created } = agentWallet();
    const r = await faucet(w.publicKey, floor.settings.houseUrl);
    return { address: w.publicKey.toBase58(), keypairFile: file, walletCreated: created, ...r, note: "Funds land in the rollup balance within a few seconds." };
  }),
);

server.registerTool(
  "my_holdings",
  {
    title: "My holdings",
    description:
      "The agent's balances in the rollup: test USDC and every token a lot can hold, each with its value at live oracle prices. These balances are private; only the agent's own signed session can read them. Creates the agent wallet first if it doesn't exist.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  run(async () => {
    const { w, file } = agentWallet();
    const balances = await w.holdings();
    const totalUsd = balances.reduce((s, b) => s + (b.valueUsd ?? 0), 0);
    return { address: w.publicKey.toBase58(), keypairFile: file, balances, totalUsd };
  }),
);

server.registerTool(
  "verify_lot",
  {
    title: "Verify a lot",
    description:
      "Re-derive an opened lot from its public record: the seal matches the contents, every fact re-derives from the seed and is true for the contents, the price paid is the clock price at the slot of the take, and the recorded value is the sum of amount × oracle price. Each check comes back with ok and a detail line. Lots that haven't been opened yet can't be verified.",
    inputSchema: { id: lotId },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  run(async ({ id }: { id: number }) => {
    const { located, checks } = await floor.verify(id);
    const l = located.lot;
    return {
      id: l.id,
      address: l.address.toBase58(),
      readFrom: located.where === "solana" ? "Solana devnet (settled record)" : "the private rollup (not settled yet)",
      opened: checks[0]?.ok === true,
      allPass: checks.every((c) => c.ok),
      checks,
    };
  }),
);

await server.connect(new StdioServerTransport());
console.error("penlight MCP server ready on stdio");
