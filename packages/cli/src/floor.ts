/**
 * Reading and acting on the Penlight floor: lots, clock prices, facts,
 * appraisals, takes, the faucet and balances. The `penlight` command and the
 * MCP server are both thin layers over this module.
 *
 * Where a lot lives: while it is delegated, its record is in the private rollup
 * (public lot accounts there are readable without a token). Once settled, the
 * final record is back on Solana devnet, owned by the program again.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { Connection, Keypair, PublicKey, type AccountInfo } from "@solana/web3.js";
import {
  CATALOGUE,
  HINTS,
  NETWORK,
  ORIGIN,
  Penlight,
  STATUS,
  STATUS_NAME,
  TxError,
  appraiseHouseLot,
  boundsFromFacts,
  clockOf,
  decodeFeed,
  decodeLot,
  describe,
  expirySlot,
  hintSlot,
  keypairSigner,
  priceAt,
  publicTeeConnection,
  sendAndConfirm,
  teeConnection,
  valueMicros,
  verifyLot,
  type Check,
  type ClockParams,
  type Deployment,
  type FactAt,
  type LotView,
} from "@penlight/sdk";

export { STATUS, STATUS_NAME, HINTS, type Check, type LotView };

// ───────────────────────────── settings ─────────────────────────────

export interface Settings {
  houseUrl: string;
  baseRpc: string;
  teeRpc: string;
  teeWs: string;
}

export function settingsFromEnv(env: NodeJS.ProcessEnv = process.env): Settings {
  const teeRpc = env.PENLIGHT_TEE_RPC ?? NETWORK.teeRpc;
  return {
    houseUrl: (env.PENLIGHT_HOUSE_URL ?? "https://penlight-app.vercel.app/api/house").replace(/\/+$/, ""),
    baseRpc: env.PENLIGHT_BASE_RPC ?? NETWORK.baseRpc,
    teeRpc,
    teeWs: env.PENLIGHT_TEE_WS ?? (env.PENLIGHT_TEE_RPC ? teeRpc.replace(/^http/, "ws") : NETWORK.teeWs),
  };
}

/** The rollup produces a block roughly every 10 ms; used only for "about N seconds" estimates. */
export const ROLLUP_SLOT_MS = 10;

const SYMBOLS = CATALOGUE.map((c) => c.symbol);
/** Fewer surviving draws than this and the appraisal falls back to the value bounds the facts state. */
const MIN_CONSISTENT = 20;
/** Sample budget: a quick pass, then a larger one when later facts leave too few draws standing (under a second). */
const APPRAISAL_SAMPLES = [6_000, 40_000];

/** A problem the user can act on; printed without a stack trace. */
export class UserError extends Error {}

// ───────────────────────────── money and units ─────────────────────────────

export const usd = (micros: bigint): number => Number(micros) / 1e6;

export function usdText(micros: bigint | number): string {
  const n = typeof micros === "bigint" ? usd(micros) : micros;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function signedUsdText(micros: bigint | number): string {
  const n = typeof micros === "bigint" ? usd(micros) : micros;
  return `${n < 0 ? "−" : "+"}${usdText(Math.abs(n))}`;
}

/** "25", "25.5", "$25.50" → micro-dollars. */
export function parseUsd(input: string | number): bigint {
  const s = typeof input === "number" ? input.toFixed(6) : input.trim().replace(/^\$/, "");
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new UserError(`"${input}" is not a dollar amount`);
  const frac = (m[2] ?? "").slice(0, 6).padEnd(6, "0");
  const micros = BigInt(m[1]) * 1_000_000n + BigInt(frac);
  if (micros === 0n) throw new UserError("the amount must be above zero");
  return micros;
}

export function units(amount: bigint, decimals: number): string {
  if (decimals === 0) return amount.toString();
  const s = amount.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

// ───────────────────────────── keys ─────────────────────────────

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? path.join(os.homedir(), p.slice(1)) : p;
}

export function loadKeypair(file: string): Keypair {
  const p = path.resolve(expandHome(file));
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    throw new UserError(`no keypair file at ${p}`);
  }
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  } catch {
    throw new UserError(`${p} is not a Solana keypair file (a JSON array of 64 numbers)`);
  }
}

// ───────────────────────────── lot views ─────────────────────────────

export type Location = "solana" | "rollup";

export interface Located {
  lot: LotView;
  /** Where the record was read: settled lots are back on Solana, live ones are in the rollup. */
  where: Location;
}

const isSold = (s: number) => s === STATUS.SOLD || s === STATUS.OPENED || s === STATUS.DELIVERED;
const isOpened = (s: number) => s === STATUS.OPENED || s === STATUS.DELIVERED || s === STATUS.UNSOLD || s === STATUS.EXPIRED;
const isPreparing = (s: number) => s === STATUS.CREATED || s === STATUS.SHUFFLING || s === STATUS.SHUFFLED;

export interface FactView {
  n: number;
  text: string;
  /** Rollup slot it was disclosed at. */
  slot: number;
}

export interface ClockView {
  rollupSlot: number;
  openSlot: number;
  phase: "opening" | "falling" | "at floor" | "closing";
  priceNowUsd: number;
  slotsUntilOpen: number;
  slotsUntilFloor: number;
  /** The next fact due, if any remain. */
  nextFact: { n: number; atSlot: number; inSlots: number } | null;
}

export interface LotSummary {
  id: number;
  address: string;
  origin: "house" | "consigned";
  status: string;
  location: Location;
  seller: string;
  startPriceUsd: number;
  floorPriceUsd: number;
  durationSlots: number;
  /** Present while the lot is live. */
  clock: ClockView | null;
  factsDisclosed: number;
  facts: FactView[];
  sale: { winner: string; paidUsd: number; soldSlot: number } | null;
  opened: {
    valueUsd: number;
    /** Value minus price paid; null when nobody took it. */
    edgeUsd: number | null;
    contents: { symbol: string; amount: string; valueUsd: number }[];
  } | null;
  commitment: string;
  explorer: string | null;
}

export interface LotDetail extends LotSummary {
  salt: string | null;
  seed: string | null;
  factPrices: Record<string, string>[];
  deliveryPrices: Record<string, string> | null;
}

/** First rollup slot at which the clock price is at or below `price`, or null if it never gets there. */
export function slotAtPrice(c: ClockParams, price: bigint): bigint | null {
  if (price >= c.startPrice) return c.openSlot;
  if (price < c.floorPrice) return null;
  const span = c.startPrice - c.floorPrice;
  return c.openSlot + ((c.startPrice - price) * c.durationSlots + span - 1n) / span;
}

function clockView(lot: LotView, slot: bigint): ClockView {
  const c = clockOf(lot);
  const end = lot.openSlot + lot.durationSlots;
  const phase = slot < lot.openSlot ? "opening" : slot < end ? "falling" : slot < expirySlot(c) ? "at floor" : "closing";
  const next = lot.hintsRevealed < HINTS ? hintSlot(c, lot.hintsRevealed) : null;
  return {
    rollupSlot: Number(slot),
    openSlot: Number(lot.openSlot),
    phase,
    priceNowUsd: usd(priceAt(c, slot)),
    slotsUntilOpen: slot < lot.openSlot ? Number(lot.openSlot - slot) : 0,
    slotsUntilFloor: slot < end ? Number(end - slot) : 0,
    nextFact: next === null ? null : { n: lot.hintsRevealed + 1, atSlot: Number(next), inSlots: Math.max(0, Number(next - slot)) },
  };
}

const priceMap = (prices: bigint[]) => Object.fromEntries(CATALOGUE.map((c, i) => [c.symbol, prices[i].toString()]));

export function summarize(x: Located, rollupSlot: bigint | null): LotSummary {
  const l = x.lot;
  const facts = l.hints.slice(0, l.hintsRevealed).map((h, i) => ({
    n: i + 1,
    text: describe({ kind: h.kind, sym: h.sym, a: h.a, b: h.b }, SYMBOLS),
    slot: Number(h.slot),
  }));
  const opened = isOpened(l.status);
  return {
    id: l.id,
    address: l.address.toBase58(),
    origin: l.origin === ORIGIN.HOUSE ? "house" : "consigned",
    status: STATUS_NAME[l.status] ?? String(l.status),
    location: x.where,
    seller: l.seller.toBase58(),
    startPriceUsd: usd(l.startPrice),
    floorPriceUsd: usd(l.floorPrice),
    durationSlots: Number(l.durationSlots),
    clock: l.status === STATUS.LIVE && rollupSlot !== null ? clockView(l, rollupSlot) : null,
    factsDisclosed: l.hintsRevealed,
    facts,
    sale: isSold(l.status) ? { winner: l.winner.toBase58(), paidUsd: usd(l.paid), soldSlot: Number(l.soldSlot) } : null,
    opened: opened
      ? {
          valueUsd: usd(l.valueAtDelivery),
          edgeUsd: isSold(l.status) ? usd(l.valueAtDelivery - l.paid) : null,
          contents: CATALOGUE.flatMap((c, i) =>
            l.amounts[i] > 0n
              ? [{ symbol: c.symbol, amount: units(l.amounts[i], c.decimals), valueUsd: usd(valueMicros(l.amounts[i], c.decimals, l.deliveryPrices[i], c.expo)) }]
              : [],
          ),
        }
      : null,
    commitment: Buffer.from(l.commitment).toString("hex"),
    explorer: x.where === "solana" ? `${NETWORK.explorer}/address/${l.address.toBase58()}?cluster=devnet` : null,
  };
}

export function detail(x: Located, rollupSlot: bigint | null): LotDetail {
  const l = x.lot;
  const opened = isOpened(l.status);
  return {
    ...summarize(x, rollupSlot),
    salt: opened ? Buffer.from(l.salt).toString("hex") : null,
    seed: opened ? Buffer.from(l.seed).toString("hex") : null,
    factPrices: l.hintPrices.slice(0, l.hintsRevealed).map(priceMap),
    deliveryPrices: opened ? priceMap(l.deliveryPrices) : null,
  };
}

// ───────────────────────────── appraisal ─────────────────────────────

export type AppraisalReport =
  | { id: number; status: string; live: false; note: string }
  | {
      id: number;
      status: string;
      live: true;
      origin: "house" | "consigned";
      factsUsed: number;
      /** "draws": sampled from the public draw procedure; "bounds": only what the facts state about value. */
      method: "draws" | "bounds";
      draws: { consistent: number; sampled: number } | null;
      /** Value percentiles across the draws consistent with every fact (method "draws" only). */
      distributionUsd: { p10: number; p50: number; p90: number } | null;
      /** What the facts state about the total outright, at the prices they were computed with. */
      boundsUsd: { atLeast: number | null; atMost: number | null };
      pricedWith: "live oracle prices" | "prices of the latest fact";
      clock: ClockView;
      suggestion: {
        takeAtOrBelowUsd: number | null;
        conservativeUsd: number | null;
        reachedAtSlot: number | null;
        inSlots: number | null;
        text: string;
      };
    };

function notLiveNote(x: Located): string {
  const l = x.lot;
  const s = summarize(x, null);
  if (isPreparing(l.status)) return `Lot #${l.id} is still being prepared (${s.status}); facts and the clock start when it goes live.`;
  if (l.status === STATUS.SOLD) return `Lot #${l.id} was taken for ${usdText(l.paid)} and is being opened.`;
  if (s.opened && s.sale) return `Lot #${l.id} is already opened: worth ${usdText(l.valueAtDelivery)}, taken for ${usdText(l.paid)} (edge ${signedUsdText(l.valueAtDelivery - l.paid)}).`;
  if (s.opened) return `Lot #${l.id} closed unsold and was opened: worth ${usdText(l.valueAtDelivery)}.`;
  return `Lot #${l.id} is not live (${s.status}).`;
}

// ───────────────────────────── the floor ─────────────────────────────

function loadDeployment(): Deployment {
  const file =
    process.env.PENLIGHT_DEPLOYMENT ??
    path.join(path.dirname(createRequire(import.meta.url).resolve("@penlight/sdk")), "deployment.devnet.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Public devnet RPCs drop the odd request; reads get one more try before giving up. */
async function retry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    await new Promise((r) => setTimeout(r, 400));
    return fn();
  }
}

async function getMany(conn: Connection, keys: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]> {
  const out: (AccountInfo<Buffer> | null)[] = [];
  for (let i = 0; i < keys.length; i += 100) out.push(...(await retry(() => conn.getMultipleAccountsInfo(keys.slice(i, i + 100), "confirmed"))));
  return out;
}

export class Floor {
  readonly pl: Penlight;
  readonly base: Connection;
  /** Unauthenticated rollup view: public accounts only. */
  readonly rollup: Connection;

  constructor(readonly settings: Settings = settingsFromEnv()) {
    this.base = new Connection(settings.baseRpc, "confirmed");
    this.pl = new Penlight(loadDeployment(), this.base);
    this.rollup = publicTeeConnection(settings.teeRpc);
  }

  async lotCount(): Promise<number> {
    return (await retry(() => this.pl.houseState())).lotsCreated;
  }

  async rollupSlot(): Promise<bigint> {
    return BigInt(await retry(() => this.rollup.getSlot("confirmed")));
  }

  /** A lot number or a lot address. */
  address(ref: string | number): PublicKey {
    if (typeof ref === "number" || /^\d+$/.test(ref)) return this.pl.lotAddress(Number(ref));
    try {
      return new PublicKey(ref);
    } catch {
      throw new UserError(`"${ref}" is neither a lot number nor a lot address`);
    }
  }

  /** Reads each lot from Solana if it is owned by the program there (settled, or never delegated), otherwise from the rollup. */
  async locate(addresses: PublicKey[]): Promise<(Located | null)[]> {
    const out: (Located | null)[] = addresses.map(() => null);
    const pending: number[] = [];
    (await getMany(this.base, addresses)).forEach((acc, i) => {
      if (acc && acc.owner.equals(this.pl.programId)) out[i] = { lot: decodeLot(addresses[i], acc.data), where: "solana" };
      else pending.push(i);
    });
    if (pending.length) {
      (await getMany(this.rollup, pending.map((i) => addresses[i]))).forEach((acc, j) => {
        const i = pending[j];
        if (acc && acc.owner.equals(this.pl.programId)) out[i] = { lot: decodeLot(addresses[i], acc.data), where: "rollup" };
      });
    }
    return out;
  }

  async lot(ref: string | number): Promise<Located> {
    const [x] = await this.locate([this.address(ref)]);
    if (!x) {
      const count = await this.lotCount().catch(() => null);
      const range = count === null ? "" : count === 0 ? " (no lots exist yet)" : ` (lots are numbered 0–${count - 1})`;
      throw new UserError(`lot ${ref} was not found on Solana or in the rollup${range}`);
    }
    return x;
  }

  /** The newest `limit` lots, newest first. */
  async lots(limit: number): Promise<Located[]> {
    const count = await this.lotCount();
    const ids: number[] = [];
    for (let id = count - 1; id >= Math.max(0, count - limit); id--) ids.push(id);
    const found = await this.locate(ids.map((id) => this.pl.lotAddress(id)));
    return found.filter((x): x is Located => x !== null);
  }

  /** Live raw oracle prices in catalogue order, or null if any feed can't be read. */
  async prices(): Promise<bigint[] | null> {
    try {
      const infos = await retry(() => this.rollup.getMultipleAccountsInfo(this.pl.feeds, "confirmed"));
      const raw = infos.map((a) => (a ? decodeFeed(a.data)?.raw ?? 0n : 0n));
      return raw.every((p) => p > 0n) ? raw : null;
    } catch {
      return null;
    }
  }

  async verify(ref: string | number): Promise<{ located: Located; checks: Check[] }> {
    const located = await this.lot(ref);
    return { located, checks: verifyLot(this.pl, located.lot) };
  }

  /**
   * Appraises a live lot from the facts disclosed so far, valued at live oracle
   * prices. House lots are drawn by a public procedure, so the appraisal samples
   * that procedure and keeps the draws every fact allows. Consigned lots were
   * chosen by their seller, so only the value bounds the facts state are used.
   */
  async appraise(x: Located): Promise<AppraisalReport> {
    const l = x.lot;
    const status = STATUS_NAME[l.status] ?? String(l.status);
    if (l.status !== STATUS.LIVE || x.where !== "rollup") return { id: l.id, status, live: false, note: notLiveNote(x) };

    const facts: FactAt[] = l.hints.slice(0, l.hintsRevealed).map((h, i) => ({ fact: { kind: h.kind, sym: h.sym, a: h.a, b: h.b }, prices: l.hintPrices[i] }));
    const [slot, live] = await Promise.all([this.rollupSlot(), this.prices()]);
    const prices = live ?? facts[facts.length - 1]?.prices ?? null;
    if (!prices) throw new UserError("oracle prices can't be read right now and the lot has no facts yet; try again shortly");
    const pricedWith = live ? "live oracle prices" : "prices of the latest fact";

    const bounds = boundsFromFacts(facts.map((f) => f.fact));
    const atLeast = bounds.lo > 0n ? bounds.lo : null;
    const atMost = bounds.hi;

    let draws: { consistent: number; sampled: number } | null = null;
    let dist: { p10: bigint; p50: bigint; p90: bigint } | null = null;
    if (l.origin === ORIGIN.HOUSE) {
      for (const samples of APPRAISAL_SAMPLES) {
        const r = appraiseHouseLot(facts, prices, samples);
        draws = { consistent: r.consistent, sampled: r.sampled };
        if (r.consistent >= MIN_CONSISTENT) {
          dist = { p10: r.p10, p50: r.p50, p90: r.p90 };
          break;
        }
      }
    }
    const method = dist ? "draws" : "bounds";

    const c = clockOf(l);
    const clock = clockView(l, slot);
    const now = priceAt(c, slot);
    // With a distribution, 90% of the median leaves a margin for the spread of
    // what's still possible (or the 10th percentile, when the spread is tighter
    // than that). Without one, only the stated minimum is safe.
    const marginal = dist ? (dist.p50 * 90n) / 100n : null;
    const target = dist ? (marginal! > dist.p10 ? marginal! : dist.p10) : atLeast;
    const conservative = dist ? dist.p10 : atLeast;
    const at = target === null ? null : slotAtPrice(c, target);
    const inSlots = at === null ? null : at > slot ? Number(at - slot) : 0;

    let text = "";
    if (!dist) {
      const stated =
        atLeast !== null && atMost !== null
          ? `the facts put the total between ${usdText(atLeast)} and ${usdText(atMost)}`
          : atLeast !== null
            ? `the facts put the total at ${usdText(atLeast)} or more`
            : atMost !== null
              ? `the facts put the total at ${usdText(atMost)} or less`
              : "the facts so far say nothing about the total";
      text =
        l.origin === ORIGIN.HOUSE
          ? `Too few sampled draws (${draws?.consistent ?? 0} of ${draws?.sampled ?? 0}) fit all ${facts.length} facts to read a distribution, so this goes by what the facts state outright: ${stated}. `
          : `Consigned lots are chosen by their seller, so this goes by what the facts state outright: ${stated}. `;
    }
    const basis = !dist
      ? "the least the facts say the lot is worth"
      : target === marginal
        ? `90% of the median appraisal (${usdText(dist.p50)})`
        : `the 10th percentile of the appraisal (median ${usdText(dist.p50)})`;
    if (target === null) {
      text += "No price is guaranteed by the facts so far, so the appraisal can't vouch for one yet.";
    } else if (now <= target) {
      text += `The clock (${usdText(now)}) is at or below ${usdText(target)}, ${basis}: on the facts so far the appraisal says this lot is worth taking now.`;
    } else if (at === null) {
      text += dist
        ? `The clock bottoms out at ${usdText(l.floorPrice)}, above ${usdText(target)} (${basis}): on the facts so far the lot isn't worth taking at any clock price.`
        : `That minimum is below the clock's floor (${usdText(l.floorPrice)}), so no clock price is covered by it; taking above it is a bet on where in that range the value lies.`;
    } else {
      text += `Worth taking at or below ${usdText(target)}, ${basis}. The clock (now ${usdText(now)}) reaches it at rollup slot ${at}, about ${inSlots} slots (~${(((inSlots ?? 0) * ROLLUP_SLOT_MS) / 1000).toFixed(1)} s) from now.`;
    }
    if (dist && dist.p10 < target!) text += ` At or below ${usdText(dist.p10)} (the 10th percentile) the lot is worth more than you pay in about 9 of 10 draws consistent with the facts.`;
    if (clock.nextFact) {
      const due = clock.nextFact.inSlots === 0 ? "is due now" : `is due in about ${clock.nextFact.inSlots} slots`;
      text += ` Fact ${clock.nextFact.n} of ${HINTS} ${due} and may move the appraisal.`;
    }

    return {
      id: l.id,
      status,
      live: true,
      origin: l.origin === ORIGIN.HOUSE ? "house" : "consigned",
      factsUsed: facts.length,
      method,
      draws,
      distributionUsd: dist ? { p10: usd(dist.p10), p50: usd(dist.p50), p90: usd(dist.p90) } : null,
      boundsUsd: { atLeast: atLeast === null ? null : usd(atLeast), atMost: atMost === null ? null : usd(atMost) },
      pricedWith,
      clock,
      suggestion: {
        takeAtOrBelowUsd: target === null ? null : usd(target),
        conservativeUsd: conservative === null ? null : usd(conservative),
        reachedAtSlot: at === null ? null : Number(at),
        inSlots,
        text,
      },
    };
  }

  wallet(key: Keypair): Wallet {
    return new Wallet(this, key);
  }
}

// ───────────────────────────── a player's wallet ─────────────────────────────

export interface Holding {
  symbol: string;
  mint: string;
  amount: string;
  /** Value at live oracle prices; test USDC counts at $1. Null if prices can't be read. */
  valueUsd: number | null;
}

export interface TakeResult {
  lot: number;
  signature: string;
  paidUsd: number;
  maxUsd: number;
  soldSlot: number;
  confirmMs: number;
}

function explainTakeFailure(e: unknown): string {
  const text = e instanceof TxError ? `${e.message}\n${(e.logs ?? []).join("\n")}` : String((e as Error)?.message ?? e);
  const sig = e instanceof TxError ? ` (signature ${e.signature})` : "";
  if (/"Custom":6002\b|0x1772\b/.test(text)) return `the lot is no longer live: someone took it first, or its clock ran out${sig}`;
  if (/"Custom":6005\b|0x1775\b/.test(text)) return `the clock price is above your max${sig}`;
  if (/"Custom":(6006|2040)\b|0x1776\b|0x7f8\b/.test(text)) return `you are this lot's seller, and a seller can't take their own lot${sig}`;
  if (/"Custom":6010\b|0x177a\b/.test(text)) return `the clock hasn't opened yet${sig}`;
  if (/"Custom":1\}|insufficient funds/i.test(text)) return `not enough test USDC in your rollup balance; use the faucet first${sig}`;
  if (/not confirmed in time/.test(text)) return `the take was sent but not confirmed in time${sig}; check the lot before trying again`;
  return text.slice(0, 400);
}

/** A keypair acting on the rollup with its own auth token, refreshed before it expires. */
export class Wallet {
  private conn: Connection | null = null;
  private expiresAt = 0;

  constructor(readonly floor: Floor, readonly key: Keypair) {}

  get publicKey(): PublicKey {
    return this.key.publicKey;
  }

  async connection(): Promise<Connection> {
    if (!this.conn || Date.now() > this.expiresAt - 60_000) {
      const s = await teeConnection(this.key.publicKey, keypairSigner(this.key), this.floor.settings.teeRpc, this.floor.settings.teeWs);
      this.conn = s.conn;
      this.expiresAt = s.expiresAt || Date.now() + 10 * 60_000;
    }
    return this.conn;
  }

  /** Rollup balances for every catalogue token and test USDC. Private accounts are readable only with this wallet's token. */
  async holdings(): Promise<Holding[]> {
    const pl = this.floor.pl;
    const conn = await this.connection();
    const mints = [...pl.mints, pl.usdcMint];
    const [infos, prices] = await Promise.all([conn.getMultipleAccountsInfo(mints.map((m) => pl.ata(this.publicKey, m)), "confirmed"), this.floor.prices()]);
    const specs = [...CATALOGUE.map((c) => ({ symbol: c.symbol, decimals: c.decimals, expo: c.expo })), { symbol: "USDC", decimals: 6, expo: 0 }];
    return specs.map((s, i) => {
      const data = infos[i]?.data;
      // SPL token account layout: mint (32) · owner (32) · amount (u64 LE) …
      const amount = data && data.length >= 72 ? data.readBigUInt64LE(64) : 0n;
      let valueUsd: number | null;
      if (s.symbol === "USDC") valueUsd = usd(amount);
      else valueUsd = prices ? usd(valueMicros(amount, s.decimals, prices[i], s.expo)) : null;
      return { symbol: s.symbol === "USDC" ? "USDC (test)" : s.symbol, mint: mints[i].toBase58(), amount: units(amount, s.decimals), valueUsd };
    });
  }

  async usdcBalance(): Promise<bigint> {
    const pl = this.floor.pl;
    const info = await (await this.connection()).getAccountInfo(pl.usdcAta(this.publicKey), "confirmed");
    return info && info.data.length >= 72 ? info.data.readBigUInt64LE(64) : 0n;
  }

  /**
   * Takes a live lot at the current clock price, refusing locally when the
   * price is above `maxMicros`. The program charges the clock price at the slot
   * the take lands, never more than the max.
   */
  async take(ref: string | number, maxMicros: bigint): Promise<TakeResult> {
    const { pl } = this.floor;
    const x = await this.floor.lot(ref);
    const l = x.lot;
    if (l.status !== STATUS.LIVE || x.where !== "rollup") throw new UserError(`can't take it: ${notLiveNote(x)}`);
    if (l.seller.equals(this.publicKey)) throw new UserError(`you are lot #${l.id}'s seller, and a seller can't take their own lot`);

    const conn = await this.connection();
    const slot = BigInt(await conn.getSlot("confirmed"));
    const c = clockOf(l);
    if (slot < l.openSlot) throw new UserError(`lot #${l.id}'s clock opens in ${l.openSlot - slot} slots, at ${usdText(l.startPrice)}`);
    const now = priceAt(c, slot);
    if (now > maxMicros) {
      const at = slotAtPrice(c, maxMicros);
      const when = at === null ? `it never goes that low (floor ${usdText(l.floorPrice)})` : `it falls to ${usdText(maxMicros)} in about ${at - slot} slots`;
      throw new UserError(`the clock is at ${usdText(now)}, above your max ${usdText(maxMicros)}; ${when}`);
    }
    const balance = await this.usdcBalance();
    if (balance < now) throw new UserError(`your rollup balance is ${usdText(balance)} test USDC and the clock is at ${usdText(now)}; use the faucet first`);

    let sent;
    try {
      sent = await sendAndConfirm(conn, [await pl.takeIx(this.publicKey, l.address, l.seller, maxMicros)], [this.key], { label: "take", timeoutMs: 15_000 });
    } catch (e) {
      throw new UserError(`take failed: ${explainTakeFailure(e)}`);
    }
    const after = await pl.fetchLot(conn, l.address);
    if (!after || !after.winner.equals(this.publicKey)) throw new UserError(`the take confirmed (${sent.signature}) but the lot doesn't name you as winner; check lot #${l.id}`);
    return { lot: l.id, signature: sent.signature, paidUsd: usd(after.paid), maxUsd: usd(maxMicros), soldSlot: Number(after.soldSlot), confirmMs: sent.ms };
  }
}

// ───────────────────────────── the House faucet ─────────────────────────────

/** Asks the House to privately transfer test USDC into `owner`'s rollup balance. */
export async function faucet(owner: PublicKey, houseUrl: string = settingsFromEnv().houseUrl): Promise<{ signature: string; amountUsd: number }> {
  const url = `${houseUrl}/api/faucet`;
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: owner.toBase58() }) });
  } catch {
    throw new UserError(`can't reach the House at ${houseUrl}; set PENLIGHT_HOUSE_URL to its address`);
  }
  const body = (await res.json().catch(() => null)) as { signature?: string; amount?: string; error?: string; message?: string; fundedAt?: number } | null;
  if (res.ok && body?.signature) return { signature: body.signature, amountUsd: Number(body.amount ?? 0) };
  if (res.status === 409) {
    const at = body?.fundedAt ? ` at ${new Date(body.fundedAt).toISOString().replace("T", " ").slice(0, 16)} UTC` : "";
    throw new UserError(`this address was already funded${at}; the faucet gives once every 6 hours`);
  }
  if (res.status === 429) throw new UserError("the faucet is busy; try again in a few minutes");
  throw new UserError(`the House at ${houseUrl} answered ${res.status}: ${body?.error ?? body?.message ?? res.statusText}`);
}
