/**
 * Does reading the facts pay? Simulates House lots exactly as the program makes
 * them (same draw, same facts, same clock) at today's oracle prices, and plays
 * strategies against them. Writes results/eval-skill.json.
 *
 *   npx tsx scripts/eval.ts [lots=600] [library=20000]
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Connection } from "@solana/web3.js";
import { CATALOGUE, HINTS, NETWORK, decodeFeed, draw, feedAddress, hintSlot, holds, priceAt, render, valueMicros, type ClockParams, type Fact, type Item, type PoolSlot } from "@penlight/sdk";
import { ROOT, log } from "./lib.ts";

const LOTS = Number(process.argv[2] ?? 600);
const LIBRARY = Number(process.argv[3] ?? 20000);
const CLOCK: ClockParams = { startPrice: 60_000_000n, floorPrice: 6_000_000n, openSlot: 0n, durationSlots: 4500n };
const REACTION_SLOTS = 60n; // ~0.6 s at 10 ms blocks

const items = (amounts: bigint[], prices: bigint[]): Item[] =>
  CATALOGUE.map((c, i) => ({ present: amounts[i] > 0n, kind: c.kind, value: amounts[i] > 0n ? valueMicros(amounts[i], c.decimals, prices[i], c.expo) : 0n }));
const total = (it: Item[]) => it.reduce((s, i) => s + i.value, 0n);

/** First slot ≥ from at which the clock price is ≤ limit (or null if never before `to`). */
function slotForPrice(limit: bigint, from: bigint, to: bigint): bigint | null {
  if (priceAt(CLOCK, from) <= limit) return from;
  const span = CLOCK.startPrice - CLOCK.floorPrice;
  if (limit < CLOCK.floorPrice) return null;
  // price(s) = start - span*s/d  ≤ limit  ⇔  s ≥ (start-limit)*d/span
  let s = ((CLOCK.startPrice - limit) * CLOCK.durationSlots + span - 1n) / span;
  if (s < from) s = from;
  return s < to ? s : null;
}

interface Strategy {
  name: string;
  description: string;
  /** Returns the slot it would take at, or null. */
  decide: (lot: SimLot) => bigint | null;
}

interface SimLot {
  value: bigint;
  facts: Fact[];
  /** Appraisal after k facts (k = 0..5): p10/p50 in micro-dollars. */
  appraisal: { p10: bigint; p50: bigint }[];
  randomSlot: bigint;
}

const factSlots = Array.from({ length: HINTS }, (_, i) => hintSlot(CLOCK, i));
const windowEnd = (k: number) => (k + 1 < HINTS ? factSlots[k + 1] : CLOCK.durationSlots + 1n);
const windowStart = (k: number) => (k === 0 ? 0n : factSlots[k - 1]);

/** Rule: once at least `minFacts` facts are out, take when price ≤ f(appraisal). */
function rule(minFacts: number, f: (a: { p10: bigint; p50: bigint }) => bigint) {
  return (lot: SimLot) => {
    for (let k = minFacts; k <= HINTS; k++) {
      const limit = f(lot.appraisal[k]);
      const from = (k === 0 ? 0n : factSlots[k - 1]) + (k === 0 ? 0n : REACTION_SLOTS);
      const s = slotForPrice(limit, from, k < HINTS ? factSlots[k] + REACTION_SLOTS : CLOCK.durationSlots + 1n);
      if (s !== null) return s;
    }
    return null;
  };
}

async function main() {
  const tee = new Connection(NETWORK.teeRpc, "confirmed");
  const infos = await tee.getMultipleAccountsInfo(CATALOGUE.map((c) => feedAddress(c.lazerId)));
  const prices = infos.map((a) => decodeFeed(a!.data)!.raw);
  log("prices", CATALOGUE.map((c, i) => `${c.symbol}=${prices[i]}`).join(" "));
  const pool: PoolSlot[] = CATALOGUE.map((c, i) => ({ balance: 1n << 60n, decimals: c.decimals, priceRaw: prices[i], expo: c.expo }));

  // The prior: draws the public procedure can make, nothing else.
  const library: Item[][] = [];
  for (let n = 0; n < LIBRARY; n++) library.push(items(draw(randomBytes(32), pool)!, prices));
  const libValues = library.map(total);
  log(`library of ${LIBRARY} draws built`);

  const quant = (vals: bigint[], q: number) => {
    const s = [...vals].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0n;
  };
  const prior = { p10: quant(libValues, 0.1), p50: quant(libValues, 0.5) };

  const lots: SimLot[] = [];
  let consistentSum = [0, 0, 0, 0, 0, 0];
  for (let n = 0; n < LOTS; n++) {
    const seed = randomBytes(32);
    const it = items(draw(seed, pool)!, prices);
    const facts = Array.from({ length: HINTS }, (_, i) => render(seed, i, it));
    const appraisal = [prior];
    let alive = library.map((_, j) => j);
    for (let k = 1; k <= HINTS; k++) {
      alive = alive.filter((j) => holds(facts[k - 1], library[j]));
      consistentSum[k] += alive.length;
      const vals = alive.map((j) => libValues[j]);
      appraisal.push(vals.length >= 10 ? { p10: quant(vals, 0.1), p50: quant(vals, 0.5) } : appraisal[k - 1]);
    }
    lots.push({ value: total(it), facts, appraisal, randomSlot: BigInt(Math.floor(Math.random() * 4501)) });
  }
  log(`${LOTS} lots simulated`);

  const strategies: Strategy[] = [
    { name: "Random click", description: "presses TAKE at a uniformly random moment of the clock", decide: (l) => l.randomSlot },
    { name: "Prior only (naive baseline)", description: "same 0.90 × median rule as the appraiser, but ignores every fact (uses the median of all possible lots)", decide: rule(0, () => (prior.p50 * 90n) / 100n) },
    { name: "Eager (reads 1 fact)", description: "after the first fact, takes at ≤ 1.05 × the fact-conditioned median", decide: rule(1, (a) => (a.p50 * 105n) / 100n) },
    { name: "Appraiser (reads facts)", description: "after two facts, takes at ≤ 0.90 × the fact-conditioned median", decide: rule(2, (a) => (a.p50 * 90n) / 100n) },
    { name: "Patient (reads 4+ facts)", description: "after four facts, takes at ≤ p10 + ½(median − p10)", decide: rule(4, (a) => a.p10 + (a.p50 - a.p10) / 2n) },
  ];

  const solo = strategies.map((s) => {
    let takes = 0, edge = 0n, positive = 0;
    for (const l of lots) {
      const slot = s.decide(l);
      if (slot === null) continue;
      takes++;
      const e = l.value - priceAt(CLOCK, slot);
      edge += e;
      if (e > 0n) positive++;
    }
    return {
      strategy: s.name,
      description: s.description,
      lotsTaken: takes,
      takeRate: +(takes / LOTS).toFixed(3),
      avgEdgeUsd: takes ? +(Number(edge) / takes / 1e6).toFixed(2) : 0,
      edgePerLotOfferedUsd: +(Number(edge) / LOTS / 1e6).toFixed(2),
      positiveEdgeRate: takes ? +(positive / takes).toFixed(3) : 0,
    };
  });

  // Races: the same lots, first press wins.
  const byName = (n: string) => strategies.find((s) => s.name.startsWith(n))!;
  function runRace(label: string, racers: Strategy[]) {
    const rows = racers.map((s) => ({ strategy: s.name, wins: 0, edge: 0n }));
    let unsold = 0;
    for (const l of lots) {
      let best: { i: number; slot: bigint } | null = null;
      racers.forEach((s, i) => {
        const slot = s.decide(l);
        if (slot !== null && (best === null || slot < best.slot)) best = { i, slot };
      });
      if (!best) {
        unsold++;
        continue;
      }
      const b = best as { i: number; slot: bigint };
      rows[b.i].wins++;
      rows[b.i].edge += l.value - priceAt(CLOCK, b.slot);
    }
    return {
      race: label,
      unsold,
      results: rows.map((r) => ({ strategy: r.strategy, wins: r.wins, winShare: +(r.wins / LOTS).toFixed(3), avgEdgeUsd: r.wins ? +(Number(r.edge) / r.wins / 1e6).toFixed(2) : 0, totalEdgeUsd: +(Number(r.edge) / 1e6).toFixed(2) })),
    };
  }
  const races = [
    runRace("everyone, including a random clicker", strategies.slice(0, 5)),
    runRace("facts vs no facts, same rule", [byName("Prior only"), byName("Appraiser")]),
    runRace("patient reader vs no facts", [byName("Prior only"), byName("Patient")]),
    runRace("the three fact-readers", [byName("Eager"), byName("Appraiser"), byName("Patient")]),
  ];

  const out = {
    generatedAt: new Date().toISOString(),
    lots: LOTS,
    priorLibrary: LIBRARY,
    clock: { startUsd: 60, floorUsd: 6, durationSlots: 4500, factsAtPercent: [15, 30, 45, 60, 75] },
    reactionSlots: Number(REACTION_SLOTS),
    oraclePrices: Object.fromEntries(CATALOGUE.map((c, i) => [c.symbol, prices[i].toString()])),
    averageTrueValueUsd: +(Number(lots.reduce((s, l) => s + l.value, 0n)) / LOTS / 1e6).toFixed(2),
    possibleLotsLeftAfterFacts: consistentSum.slice(1).map((s, k) => ({ facts: k + 1, share: +(s / LOTS / LIBRARY).toFixed(4) })),
    solo,
    races,
    notes: [
      "Solo: one strategy against the clock alone. Waiting always gets cheaper, so patience pays trivially here; rivals are what make timing a decision.",
      "Races: every strategy watches the same lot; the earliest press takes it at that block's price.",
      `Reaction delay after each fact: ${REACTION_SLOTS} blocks (~${Number(REACTION_SLOTS) * 10} ms).`,
    ],
  };
  fs.mkdirSync(path.join(ROOT, "results"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "results/eval-skill.json"), JSON.stringify(out, null, 2));
  console.table(out.solo);
  for (const r of races) {
    console.log(`
${r.race} (unsold ${r.unsold})`);
    console.table(r.results);
  }
  console.log(out.possibleLotsLeftAfterFacts);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
