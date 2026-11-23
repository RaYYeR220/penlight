/**
 * The facts a lot discloses — a line-for-line port of programs/penlight/src/hints.rs,
 * checked against vectors the Rust tests write out.
 */
import { HINTS, KIND_MEME, SLOTS } from "./constants.js";
import { Stream } from "./rng.js";

export const H = {
  COUNT: 1,
  CONTAINS: 2,
  ABSENT: 3,
  MEMES: 4,
  ABOVE: 5,
  BELOW: 6,
  TOP_SHARE: 7,
  TOP_BAND: 8,
  ITEM_BAND: 9,
} as const;
export const NO_SYM = 255;
const CENT = 10_000n;

const T_COUNT = 1, T_CONTAINS = 2, T_ABSENT = 3, T_MEMES = 4, T_TOTAL_WIDE = 5, T_TOP_SHARE = 6, T_TOP_BAND = 7, T_ITEM_BAND = 8, T_TOTAL_NARROW = 9;

export interface Item {
  /** micro-dollars */
  value: bigint;
  present: boolean;
  kind: number;
}

export interface Fact {
  kind: number;
  sym: number;
  a: bigint;
  b: bigint;
}

const presentCount = (items: Item[]) => items.filter((i) => i.present).length;
const total = (items: Item[]) => items.reduce((s, i) => (i.present ? s + i.value : s), 0n);

function topIndex(items: Item[]): number | null {
  let best: number | null = null;
  items.forEach((it, i) => {
    if (it.present && (best === null || it.value > items[best].value)) best = i;
  });
  return best;
}

function pickFrom(s: Stream, options: number[]): number {
  return options[Number(s.below(BigInt(options.length)))];
}

export function plan(seed: Uint8Array, items: Item[]): number[] {
  const k = presentCount(items);
  const s = new Stream(seed, 1);
  let tier1 = [T_COUNT, T_MEMES];
  if (k >= 1) tier1.push(T_CONTAINS);
  if (k < SLOTS) tier1.push(T_ABSENT);
  const first = pickFrom(s, tier1);
  tier1 = tier1.filter((t) => t !== first);
  const second = pickFrom(s, tier1);
  const third = k >= 2 ? pickFrom(s, [T_TOTAL_WIDE, T_TOP_SHARE]) : T_TOTAL_WIDE;
  let tier3 = [T_TOP_BAND, T_TOTAL_NARROW];
  if (k >= 2) tier3.push(T_ITEM_BAND);
  const fourth = pickFrom(s, tier3);
  tier3 = tier3.filter((t) => t !== fourth);
  const fifth = pickFrom(s, tier3);
  return [first, second, third, fourth, fifth];
}

const divCeil = (x: bigint, d: bigint) => (x + d - 1n) / d;

function band(x: bigint, widthBps: bigint, s: Stream): [bigint, bigint] {
  const width = (x * widthBps) / 10_000n;
  const offset = width === 0n ? 0n : s.below(width + 1n);
  const lo = x > offset ? x - offset : 0n;
  const hi = lo + width;
  return [(lo / CENT) * CENT, divCeil(hi, CENT) * CENT];
}

export function render(seed: Uint8Array, index: number, items: Item[]): Fact {
  const template = plan(seed, items)[index];
  const s = new Stream(seed, 10 + index);
  const k = presentCount(items);
  const v = total(items);
  switch (template) {
    case T_COUNT:
      return { kind: H.COUNT, sym: NO_SYM, a: BigInt(k), b: 0n };
    case T_MEMES:
      return { kind: H.MEMES, sym: NO_SYM, a: BigInt(items.filter((i) => i.present && i.kind === KIND_MEME).length), b: 0n };
    case T_CONTAINS: {
      const opts = items.map((it, i) => (it.present ? i : -1)).filter((i) => i >= 0);
      return { kind: H.CONTAINS, sym: pickFrom(s, opts), a: 0n, b: 0n };
    }
    case T_ABSENT: {
      const opts = items.map((it, i) => (!it.present ? i : -1)).filter((i) => i >= 0);
      return { kind: H.ABSENT, sym: pickFrom(s, opts), a: 0n, b: 0n };
    }
    case T_TOTAL_WIDE:
    case T_TOTAL_NARROW: {
      const [lo, span] = template === T_TOTAL_WIDE ? [2000n, 2001n] : [500n, 1001n];
      const d = lo + s.below(span);
      if (s.below(2n) === 0n) {
        const x = (v * (10_000n - d)) / 10_000n;
        return { kind: H.ABOVE, sym: NO_SYM, a: (x / CENT) * CENT, b: 0n };
      }
      const x = (v * (10_000n + d)) / 10_000n;
      return { kind: H.BELOW, sym: NO_SYM, a: divCeil(x, CENT) * CENT, b: 0n };
    }
    case T_TOP_SHARE: {
      const ti = topIndex(items);
      const t = ti === null ? 0n : items[ti].value;
      const pct = v === 0n ? 0n : (t * 100n) / v;
      return { kind: H.TOP_SHARE, sym: NO_SYM, a: (pct / 10n) * 10n, b: 0n };
    }
    case T_TOP_BAND: {
      const ti = topIndex(items);
      const t = ti === null ? 0n : items[ti].value;
      const [a, b] = band(t, 3000n, s);
      return { kind: H.TOP_BAND, sym: NO_SYM, a, b };
    }
    default: {
      const top = topIndex(items);
      const opts = items.map((it, i) => (it.present && i !== top ? i : -1)).filter((i) => i >= 0);
      const j = opts.length === 0 ? (top ?? 0) : pickFrom(s, opts);
      const [a, b] = band(items[j].value, 4000n, s);
      return { kind: H.ITEM_BAND, sym: j, a, b };
    }
  }
}

export function holds(f: Fact, items: Item[]): boolean {
  const k = BigInt(presentCount(items));
  const v = total(items);
  const ti = topIndex(items);
  const t = ti === null ? 0n : items[ti].value;
  switch (f.kind) {
    case H.COUNT: return f.a === k;
    case H.CONTAINS: return f.sym < SLOTS && items[f.sym].present;
    case H.ABSENT: return f.sym < SLOTS && !items[f.sym].present;
    case H.MEMES: return f.a === BigInt(items.filter((i) => i.present && i.kind === KIND_MEME).length);
    case H.ABOVE: return v >= f.a;
    case H.BELOW: return v <= f.a;
    case H.TOP_SHARE: return v === 0n || t * 100n >= f.a * v;
    case H.TOP_BAND: return f.a <= t && t <= f.b;
    case H.ITEM_BAND: return f.sym < SLOTS && items[f.sym].present && f.a <= items[f.sym].value && items[f.sym].value <= f.b;
    default: return false;
  }
}

const usd = (micros: bigint) => {
  const n = Number(micros) / 1e6;
  return n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;
};

/** Human wording for a fact. `symbols` maps slot index → ticker. */
export function describe(f: Fact, symbols: string[]): string {
  const sym = f.sym < symbols.length ? symbols[f.sym] : "?";
  switch (f.kind) {
    case H.COUNT: return `${f.a} ${f.a === 1n ? "kind" : "kinds"} of token inside`;
    case H.CONTAINS: return `Contains ${sym}`;
    case H.ABSENT: return `No ${sym} inside`;
    case H.MEMES: return f.a === 0n ? "No memecoins inside" : `${f.a} ${f.a === 1n ? "memecoin" : "memecoins"} inside`;
    case H.ABOVE: return `Worth more than ${usd(f.a)} in total`;
    case H.BELOW: return `Worth less than ${usd(f.a)} in total`;
    case H.TOP_SHARE: return `The largest item is at least ${f.a}% of the value`;
    case H.TOP_BAND: return `The largest item is worth ${usd(f.a)}–${usd(f.b)}`;
    case H.ITEM_BAND: return `The ${sym} inside is worth ${usd(f.a)}–${usd(f.b)}`;
    default: return "Unknown fact";
  }
}

export { HINTS };
