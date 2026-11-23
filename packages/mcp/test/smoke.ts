/**
 * Smoke test: starts the MCP server over stdio, lists its tools, and calls the
 * read-only ones against the live devnet deployment. Never calls take_lot or
 * fund_agent.
 *
 *   npx tsx packages/mcp/test/smoke.ts
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED = ["list_lots", "get_lot", "appraise_lot", "take_lot", "fund_agent", "my_holdings", "verify_lot"];

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", path.join(pkg, "src/index.ts")],
  cwd: pkg,
  env: process.env as Record<string, string>,
  stderr: "inherit",
});
const client = new Client({ name: "penlight-smoke", version: "0.1.0" });

async function call(name: string, args: Record<string, unknown>) {
  const r = (await client.callTool({ name, arguments: args })) as ToolResult;
  const body = r.content.find((c) => c.type === "text")?.text ?? "";
  assert.ok(!r.isError, `${name} returned an error: ${body}`);
  return JSON.parse(body);
}

async function main() {
  await client.connect(transport);
  const info = client.getServerVersion();
  console.log(`connected to ${info?.name} ${info?.version}`);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  console.log(`tools: ${names.join(", ")}`);
  assert.deepEqual(names, [...EXPECTED].sort());
  for (const t of tools) assert.ok((t.description ?? "").length > 40, `${t.name} needs a description`);

  const list = await call("list_lots", { limit: 10 });
  assert.ok(Array.isArray(list.lots) && list.lots.length > 0, "list_lots returned no lots");
  console.log(`list_lots: ${list.lots.length} lots at rollup slot ${list.rollupSlot}, live: [${list.liveLotIds.join(", ")}]`);
  for (const l of list.lots) {
    const result = l.opened ? `value $${l.opened.valueUsd.toFixed(2)}${l.sale ? ` paid $${l.sale.paidUsd.toFixed(2)}` : ""}` : l.clock ? `clock $${l.clock.priceNowUsd.toFixed(2)}` : "";
    console.log(`  #${l.id} ${l.status.padEnd(9)} ${l.location.padEnd(6)} facts ${l.factsDisclosed} ${result}`);
  }

  type Row = { id: number; location: string; opened: unknown; sale: unknown };
  const settled: Row[] = list.lots.filter((l: Row) => l.location === "solana" && l.opened);
  assert.ok(settled.length > 0, "no settled lot to verify");
  // One lot somebody took (covers the price check) and one that closed unsold, when both exist.
  const picks = [settled.find((l) => l.sale), settled.find((l) => !l.sale)].filter((l): l is Row => !!l);
  for (const l of picks) {
    const v = await call("verify_lot", { id: l.id });
    const passed = v.checks.filter((c: { ok: boolean }) => c.ok).length;
    console.log(`verify_lot #${v.id}: ${passed}/${v.checks.length} checks pass (read from ${v.readFrom})`);
    for (const c of v.checks) console.log(`    ${c.ok ? "✓" : "✗"} ${c.name}`);
    assert.equal(v.allPass, true, `lot ${v.id} failed verification`);
  }

  const lot = await call("get_lot", { id: picks[0].id });
  assert.equal(lot.id, picks[0].id);
  assert.ok(typeof lot.commitment === "string" && lot.commitment.length === 64);
  console.log(`get_lot #${lot.id}: ${lot.status}, ${lot.facts.length} facts, ${lot.opened?.contents.length ?? 0} tokens inside`);

  // Appraising a lot that isn't live explains why instead of failing.
  const a = await call("appraise_lot", { id: picks[0].id });
  assert.equal(a.live, false);
  console.log(`appraise_lot #${a.id}: ${a.note}`);
  for (const id of list.liveLotIds) {
    const live = await call("appraise_lot", { id });
    console.log(`appraise_lot #${id} (live): p50 $${live.valueUsd.p50} · ${live.suggestion.text}`);
  }

  // An unknown lot comes back as a tool error, not a crash.
  const missing = (await client.callTool({ name: "get_lot", arguments: { id: 999_999 } })) as ToolResult;
  assert.equal(missing.isError, true);
  console.log(`get_lot #999999: error as expected (${missing.content[0]?.text})`);

  await client.close();
  console.log("smoke test passed");
}

main().catch(async (e) => {
  console.error("smoke test FAILED:", e instanceof Error ? e.message : e);
  await client.close().catch(() => {});
  process.exitCode = 1;
});
