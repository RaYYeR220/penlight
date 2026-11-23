/**
 * Rival bidders. Each one reads only what every player can read — the public
 * lot and its facts — and decides with the same appraiser the SDK exports.
 * They never see a seal: the House's own key can't read one either.
 */
import path from "node:path";
import { Keypair, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { transferSpl } from "@magicblock-labs/ephemeral-rollups-sdk";
import { NETWORK, ORIGIN, STATUS, appraiseHouseLot, boundsFromFacts, clockOf, priceAt, sendAndConfirm, type LotView } from "@penlight/sdk";
import { ErSession, base, config, house, loadOrCreate, log, pl, short, store } from "./context.js";
import { currentSlot } from "./keeper.js";

interface Persona {
  name: string;
  style: string;
  minFacts: number;
  /** Price the bot will pay, given the appraisal (micro-dollars). */
  limit: (a: { p10: bigint; p50: bigint; p90: bigint }) => bigint;
}

const PERSONAS: Persona[] = [
  { name: "Marlow", style: "appraiser", minFacts: 2, limit: (a) => (a.p50 * 90n) / 100n },
  { name: "Ines", style: "patient", minFacts: 4, limit: (a) => a.p10 + (a.p50 - a.p10) / 2n },
  { name: "Bram", style: "eager", minFacts: 1, limit: (a) => (a.p50 * 105n) / 100n },
];

interface Bot extends Persona {
  key: Keypair;
  er: ErSession;
  armedAt: Map<number, number>;
}

export const bots: Bot[] = [];
const appraisals = new Map<string, { p10: bigint; p50: bigint; p90: bigint }>();

export function initBots() {
  for (const p of PERSONAS) {
    const key = loadOrCreate(path.join(config.botDir, `${p.name.toLowerCase()}.json`));
    bots.push({ ...p, key, er: new ErSession(key), armedAt: new Map() });
  }
  log("bots:", bots.map((b) => `${b.name}=${short(b.key.publicKey)}`).join(" "));
}

export function botName(address: string): string | null {
  return bots.find((b) => b.key.publicKey.toBase58() === address)?.name ?? null;
}

async function usdcBalance(b: Bot): Promise<bigint> {
  try {
    const er = await b.er.get();
    return BigInt((await er.getTokenAccountBalance(pl.usdcAta(b.key.publicKey))).value.amount);
  } catch {
    return 0n;
  }
}

/** Private top-up from the House into the bot's rollup balance. */
export async function fundBots() {
  for (const b of bots) {
    if ((await usdcBalance(b)) >= 200_000_000n) continue;
    const ixs = await transferSpl(house.publicKey, b.key.publicKey, pl.usdcMint, 1_000_000_000n, {
      visibility: "private",
      fromBalance: "base",
      toBalance: "ephemeral",
      validator: NETWORK.teeValidator,
      payer: house.publicKey,
    });
    const sig = await sendAndConfirmTransaction(base, new Transaction().add(...ixs), [house]);
    log(`funded bot ${b.name}`, sig.slice(0, 12));
  }
}

function appraisal(lot: LotView) {
  const key = `${lot.id}:${lot.hintsRevealed}`;
  let a = appraisals.get(key);
  if (!a) {
    const facts = lot.hints.slice(0, lot.hintsRevealed).map((h, i) => ({ fact: { kind: h.kind, sym: h.sym, a: h.a, b: h.b }, prices: lot.hintPrices[i] }));
    if (lot.origin === ORIGIN.HOUSE) {
      const prices = lot.hintPrices[Math.max(0, lot.hintsRevealed - 1)];
      const r = appraiseHouseLot(facts, prices, 6000);
      if (r.consistent > 20) a = { p10: r.p10, p50: r.p50, p90: r.p90 };
      else {
        // Too few draws survive the facts to read a distribution: fall back to the value bounds the facts state.
        const bnd = boundsFromFacts(facts.map((f) => f.fact));
        const mid = bnd.hi !== null ? (bnd.lo + bnd.hi) / 2n : bnd.lo;
        a = { p10: bnd.lo, p50: mid, p90: bnd.hi ?? mid };
      }
    } else {
      const bnd = boundsFromFacts(facts.map((f) => f.fact));
      a = { p10: bnd.lo, p50: bnd.lo, p90: bnd.hi ?? bnd.lo };
    }
    appraisals.set(key, a);
  }
  return a;
}

export async function botsTick() {
  if (!config.bots || !store.floorActive()) return;
  const slot = currentSlot();
  for (const lot of store.lots.values()) {
    if (lot.status !== STATUS.LIVE || slot < lot.openSlot) continue;
    const a = appraisal(lot);
    if (a.p50 === 0n) continue;
    const price = priceAt(clockOf(lot), slot);
    for (const b of bots) {
      if (lot.hintsRevealed < b.minFacts || lot.seller.equals(b.key.publicKey)) continue;
      const limit = b.limit(a);
      if (price > limit) {
        b.armedAt.delete(lot.id);
        continue;
      }
      // Human-ish reaction time before acting on a price it likes.
      const armed = b.armedAt.get(lot.id);
      if (armed === undefined) {
        b.armedAt.set(lot.id, Date.now() + 300 + Math.floor(Math.random() * 900));
        continue;
      }
      if (Date.now() < armed) continue;
      b.armedAt.delete(lot.id);
      try {
        const er = await b.er.get();
        const r = await sendAndConfirm(er, [await pl.takeIx(b.key.publicKey, lot.address, lot.seller, limit)], [b.key], { label: "take", timeoutMs: 8000 });
        store.takeLatencies.push(r.ms);
        log(`${b.name} took lot ${lot.id} at ≤ $${Number(limit) / 1e6}`);
      } catch {
        // Someone else got there first, or the price moved: that's the game.
      }
      return;
    }
  }
}
