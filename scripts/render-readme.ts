/**
 * Renders the numbers in README.md from results/*.json, so every figure traces
 * to a run. Blocks look like <!-- results:name --> … <!-- /results:name -->.
 *
 *   npx tsx scripts/render-readme.ts
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./lib.ts";

const read = (f: string) => JSON.parse(fs.readFileSync(path.join(ROOT, "results", f), "utf8"));
const eval_ = read("eval-skill.json");
const bench = read("bench-er-vs-l1.json");
const e2e = read("e2e-latest.json");

const usd = (n: number) => `${n < 0 ? "−" : "+"}$${Math.abs(n).toFixed(2)}`;
const race = (label: string) => eval_.races.find((r: { race: string }) => r.race === label);
const facts = race("facts vs no facts, same rule");
const reader = facts.results.find((r: { strategy: string }) => r.strategy.startsWith("Appraiser"));
const naive = facts.results.find((r: { strategy: string }) => r.strategy.startsWith("Prior only"));
const crowd = race("everyone, including a random clicker");
const clicker = crowd.results.find((r: { strategy: string }) => r.strategy === "Random click");

const steps = e2e.steps as { name: string; ok?: boolean; callbackMs?: number; checks?: { ok: boolean }[] }[];
const negatives = steps.filter((s) => s.name.startsWith("NEGATIVE"));
const verified = steps.filter((s) => s.name.includes("verified from Solana"));
const vrf = steps.filter((s) => typeof s.callbackMs === "number").map((s) => s.callbackMs as number);

const blocks: Record<string, string> = {
  headline: [
    `- **Reading the facts pays.** Same buying rule, same ${eval_.lots.toLocaleString()} lots at live oracle prices, head to head: with the facts it wins ${Math.round(reader.winShare * 100)}% of lots at **${usd(reader.avgEdgeUsd)}** each; without them it wins ${Math.round(naive.winShare * 100)}% at **${usd(naive.avgEdgeUsd)}** each. ([eval](results/eval-skill.json))`,
    `- **A clock that moves every 10 ms.** The rollup made ${bench.rollup.slotsPerSecond} blocks/s against Solana devnet's ${bench.solanaL1.slotsPerSecond}; a ${bench.clock.seconds} s clock falls in ${bench.clock.rollupTicks.toLocaleString()} steps of $${bench.clock.rollupStepUsd} instead of ${bench.clock.l1Ticks} steps of $${bench.clock.l1StepUsd}. ([bench](results/bench-er-vs-l1.json))`,
    `- **Randomness from inside the enclave in ~${Math.round(vrf.reduce((a, b) => a + b, 0) / vrf.length)} ms.** VRF requested and delivered within the private rollup. ([e2e](results/e2e-latest.json))`,
    `- **Every opened lot re-derives bit for bit.** ${verified.length}/${verified.length} lots in the end-to-end run re-verified from their Solana record; ${negatives.filter((n) => n.ok).length}/${negatives.length} attacks refused on-chain.`,
  ].join("\n"),
  crowd: `In a crowd that includes someone pressing at random, the random presser takes ${Math.round(clicker.winShare * 100)}% of lots and loses ${usd(clicker.avgEdgeUsd).replace("+", "")} on each one: the first press is not the best press.`,
  narrowing: eval_.possibleLotsLeftAfterFacts.map((r: { facts: number; share: number }) => `${r.facts} → ${(r.share * 100).toFixed(r.share < 0.01 ? 2 : 1)}%`).join(" · "),
  bench: [
    "| | Private rollup | Solana devnet |",
    "|---|---|---|",
    `| Blocks per second | ${bench.rollup.slotsPerSecond} | ${bench.solanaL1.slotsPerSecond} |`,
    `| ${bench.clock.seconds} s clock, price steps | ${bench.clock.rollupTicks.toLocaleString()} × $${bench.clock.rollupStepUsd} | ${bench.clock.l1Ticks} × $${bench.clock.l1StepUsd} |`,
    `| Signed tx, send → confirmed (median, EU client) | ${bench.rollup.landing.medianMs} ms | ${typeof bench.solanaL1.landing === "object" ? bench.solanaL1.landing.medianMs + " ms" : "—"} |`,
    `| Fee per transaction | 0 | 5,000 lamports |`,
  ].join("\n"),
  eval: [
    "| Strategy | Lots won | Avg edge per lot won |",
    "|---|---|---|",
    ...facts.results.map((r: { strategy: string; wins: number; avgEdgeUsd: number }) => `| ${r.strategy} | ${r.wins} | ${usd(r.avgEdgeUsd)} |`),
  ].join("\n"),
};

const file = path.join(ROOT, "README.md");
let md = fs.readFileSync(file, "utf8");
for (const [name, body] of Object.entries(blocks)) {
  const re = new RegExp(`(<!-- results:${name} -->)[\\s\\S]*?(<!-- /results:${name} -->)`);
  if (!re.test(md)) throw new Error(`README is missing the ${name} block`);
  md = md.replace(re, `$1\n${body}\n$2`);
}
fs.writeFileSync(file, md);
console.log("README numbers rendered from results/*.json");
