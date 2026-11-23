/**
 * Appraising a sealed lot from the facts it has disclosed.
 *
 * House lots are drawn by a public procedure (math.draw) from a seed nobody
 * knows. So the honest prior is "any draw the procedure can make", and every
 * fact rules some of those out. We sample draws, keep the ones consistent with
 * every fact (at the prices each fact was computed with), and read the value
 * distribution off what survives. Plain rejection sampling: no model, no tuning.
 */
import { CATALOGUE, SLOTS } from "./constants";
import { holds, type Fact, type Item } from "./facts";
import { draw, valueMicros, type PoolSlot } from "./math";

export interface Appraisal {
  /** Draws consistent with every fact. */
  consistent: number;
  sampled: number;
  /** Micro-dollars at current prices. */
  mean: bigint;
  p10: bigint;
  p50: bigint;
  p90: bigint;
}

export interface FactAt {
  fact: Fact;
  /** Raw oracle prices (catalogue order) the fact was computed with. */
  prices: bigint[];
}

function itemsFor(amounts: bigint[], prices: bigint[]): Item[] {
  return CATALOGUE.map((c, i) => ({
    present: amounts[i] > 0n,
    kind: c.kind,
    value: amounts[i] > 0n ? valueMicros(amounts[i], c.decimals, prices[i], c.expo) : 0n,
  }));
}

function randomSeed(): Uint8Array {
  const s = new Uint8Array(32);
  globalThis.crypto.getRandomValues(s);
  return s;
}

/**
 * @param facts   facts disclosed so far, each with the prices it used
 * @param prices  current raw prices, catalogue order (what you'd value it at now)
 * @param samples how many candidate draws to try
 */
export function appraiseHouseLot(facts: FactAt[], prices: bigint[], samples = 4000): Appraisal {
  // Draws are made at the prices of the moment the lot was packed; the first
  // fact's prices are the closest public record of that moment.
  const drawPrices = facts[0]?.prices ?? prices;
  const pool: PoolSlot[] = CATALOGUE.map((c, i) => ({
    balance: 1n << 60n,
    decimals: c.decimals,
    priceRaw: drawPrices[i],
    expo: c.expo,
  }));
  const values: bigint[] = [];
  for (let n = 0; n < samples; n++) {
    const amounts = draw(randomSeed(), pool);
    if (!amounts) continue;
    let ok = true;
    for (const f of facts) {
      if (!holds(f.fact, itemsFor(amounts, f.prices))) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    values.push(itemsFor(amounts, prices).reduce((s, i) => s + i.value, 0n));
  }
  values.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const q = (p: number) => (values.length ? values[Math.min(values.length - 1, Math.floor(p * values.length))] : 0n);
  const mean = values.length ? values.reduce((s, v) => s + v, 0n) / BigInt(values.length) : 0n;
  return { consistent: values.length, sampled: samples, mean, p10: q(0.1), p50: q(0.5), p90: q(0.9) };
}

/**
 * Consigned lots have no public draw procedure — the seller chose them. Here we
 * only bound the total from the facts that speak about value.
 */
export function boundsFromFacts(facts: Fact[]): { lo: bigint; hi: bigint | null } {
  let lo = 0n;
  let hi: bigint | null = null;
  for (const f of facts) {
    if (f.kind === 5) lo = f.a > lo ? f.a : lo; // above
    if (f.kind === 6) hi = hi === null || f.a < hi ? f.a : hi; // below
    if (f.kind === 8 || f.kind === 9) lo = f.a > lo ? f.a : lo; // a band of one item bounds the total from below
    if (f.kind === 7 && f.a > 0n) {
      // top item ≥ a% of total ⇒ total ≤ top·100/a; without the top value this is only useful with a top band
      const band = facts.find((g) => g.kind === 8);
      if (band) {
        const cap = (band.b * 100n) / f.a;
        hi = hi === null || cap < hi ? cap : hi;
      }
    }
  }
  return { lo, hi };
}

export { SLOTS };
