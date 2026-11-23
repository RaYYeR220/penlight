/**
 * The clock on the private rollup vs the same clock on Solana L1.
 * Measures block rate on both, the price step a 45 s clock would have, and how
 * long a minimal signed transaction takes to land, from this machine.
 * Writes results/bench-er-vs-l1.json.
 *
 *   npx tsx scripts/bench.ts [samples=20]
 */
import fs from "node:fs";
import path from "node:path";
import { ComputeBudgetProgram, Connection, Keypair } from "@solana/web3.js";
import { NETWORK, sendAndConfirm } from "@penlight/sdk";
import { ROOT, baseConnection, er, loadOrCreateKeypair, log, sleep } from "./lib.ts";

const SAMPLES = Number(process.argv[2] ?? 20);
const CLOCK_SECONDS = 45;
const SPAN_USD = 54; // $60 → $6

async function slotRate(conn: Connection, ms = 10_000) {
  const a = await conn.getSlot("confirmed");
  const t = performance.now();
  await sleep(ms);
  const b = await conn.getSlot("confirmed");
  const dt = (performance.now() - t) / 1000;
  return { slotsPerSecond: +((b - a) / dt).toFixed(2), msPerSlot: +((dt * 1000) / (b - a)).toFixed(2) };
}

async function landing(conn: Connection, signer: Keypair, label: string) {
  const out: { ms: number; slots: number }[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const before = await conn.getSlot("processed");
    const r = await sendAndConfirm(conn, [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: i })], [signer], { label, pollMs: 20 });
    out.push({ ms: r.ms, slots: (r.slot ?? before) - before });
    await sleep(150);
  }
  const ms = out.map((o) => o.ms).sort((a, b) => a - b);
  const slots = out.map((o) => o.slots).sort((a, b) => a - b);
  const med = (v: number[]) => v[Math.floor(v.length / 2)];
  return { samples: SAMPLES, medianMs: med(ms), p90Ms: ms[Math.floor(ms.length * 0.9)], medianSlotsToLand: med(slots) };
}

async function main() {
  const base = baseConnection();
  const bench = loadOrCreateKeypair("keys/bench.json");
  const ebench = await er(bench);
  log("bench key", bench.publicKey.toBase58(), "base balance", await base.getBalance(bench.publicKey));

  const [erRate, l1Rate] = await Promise.all([slotRate(ebench), slotRate(base)]);
  log("rollup", erRate, "L1", l1Rate);
  const erTicks = Math.round(erRate.slotsPerSecond * CLOCK_SECONDS);
  const l1Ticks = Math.round(l1Rate.slotsPerSecond * CLOCK_SECONDS);

  const erLand = await landing(ebench, bench, "rollup");
  log("rollup landing", erLand);
  let l1Land: unknown = "skipped: bench key has no SOL on devnet for fees";
  if ((await base.getBalance(bench.publicKey)) > 200_000) {
    l1Land = await landing(base, bench, "L1");
    log("L1 landing", l1Land);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    measuredFrom: "a single client in Europe over the public internet; wall-clock numbers include network round trips",
    rollup: { endpoint: NETWORK.teeRpc, ...erRate, landing: erLand },
    solanaL1: { endpoint: "devnet", ...l1Rate, landing: l1Land },
    clock: {
      seconds: CLOCK_SECONDS,
      spanUsd: SPAN_USD,
      rollupTicks: erTicks,
      l1Ticks,
      rollupStepUsd: +(SPAN_USD / erTicks).toFixed(4),
      l1StepUsd: +(SPAN_USD / l1Ticks).toFixed(4),
      ratio: +(erTicks / l1Ticks).toFixed(1),
    },
    fees: { rollupPerTx: "0 SOL (gasless)", l1PerTx: "5000 lamports base fee" },
  };
  fs.writeFileSync(path.join(ROOT, "results/bench-er-vs-l1.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out.clock, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
