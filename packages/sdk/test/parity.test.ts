import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { plan, render, holds, type Item } from "../src/facts.ts";
import { draw, commitment } from "../src/math.ts";

const v = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));
const unhex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

test("facts match the program bit for bit", () => {
  assert.equal(v.facts.length, 300);
  for (const c of v.facts) {
    const seed = unhex(c.seed);
    const items: Item[] = c.items.map((i: any) => ({ value: BigInt(i.value), present: i.present, kind: i.kind }));
    assert.deepEqual(plan(seed, items), c.plan, `plan for ${c.seed}`);
    for (let i = 0; i < 5; i++) {
      const f = render(seed, i, items);
      const want = c.facts[i];
      assert.deepEqual(
        { kind: f.kind, sym: f.sym, a: f.a.toString(), b: f.b.toString() },
        { kind: want.kind, sym: want.sym, a: want.a, b: want.b },
        `fact ${i} for ${c.seed}`,
      );
      assert.ok(holds(f, items));
    }
  }
});

test("pool draws match the program", () => {
  for (const c of v.draws) {
    const pool = c.pool.map((p: any) => ({ balance: BigInt(p.balance), decimals: p.decimals, priceRaw: BigInt(p.priceRaw), expo: p.expo }));
    const got = draw(unhex(c.seed), pool);
    assert.deepEqual(got?.map(String) ?? null, c.amounts);
  }
});

test("commitments match the program", () => {
  for (const c of v.commitments) {
    const got = commitment(new PublicKey(c.lot), unhex(c.salt), c.mints.map((m: string) => new PublicKey(m)), c.amounts.map(BigInt));
    assert.equal(Buffer.from(got).toString("hex"), c.commitment);
  }
});
