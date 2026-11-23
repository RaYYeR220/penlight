import { CATALOGUE, valueMicros } from "@penlight/sdk";
import { usd } from "@/lib/chain";

export { usd };

export const short = (a: string | { toBase58(): string }, n = 4) => {
  const s = typeof a === "string" ? a : a.toBase58();
  return `${s.slice(0, n)}…${s.slice(-n)}`;
};

/** "+$5.05" / "−$3.50" */
export function usdSigned(micros: bigint | number | string, digits = 2): string {
  const v = BigInt(micros);
  const sign = v > 0n ? "+" : v < 0n ? "−" : "";
  return `${sign}${usd(v < 0n ? -v : v, digits)}`;
}

/** Rounds a micro-dollar price up to the next whole cent. */
export const ceilCent = (micros: bigint) => ((micros + 9_999n) / 10_000n) * 10_000n;

export function tokenAmount(amount: bigint, decimals: number): string {
  const n = Number(amount) / 10 ** decimals;
  if (n === 0) return "0";
  if (n >= 100_000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (n >= 1_000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return n.toLocaleString("en-US", { maximumSignificantDigits: 4 });
}

/** Dollar price of one whole token from a raw oracle price. */
export function unitPrice(slot: number, priceRaw: bigint): string {
  const n = Number(priceRaw) / 10 ** CATALOGUE[slot].expo;
  if (n >= 1) return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${n.toLocaleString("en-US", { maximumSignificantDigits: 4 })}`;
}

export const valueOf = (slot: number, amount: bigint, priceRaw: bigint) =>
  amount > 0n && priceRaw > 0n ? valueMicros(amount, CATALOGUE[slot].decimals, priceRaw, CATALOGUE[slot].expo) : 0n;

export const totalValue = (amounts: bigint[], prices: bigint[]) => amounts.reduce((s, a, i) => s + valueOf(i, a, prices[i] ?? 0n), 0n);

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export const int = (n: bigint | number) => Number(n).toLocaleString("en-US");

export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

export const tokVar = (symbol: string) => `var(--tok-${symbol.toLowerCase()})`;

export const pct = (bps: number) => `${bps / 100}%`;

// ── lots this browser's player took, so their history outlives the House's memory ──
const TAKEN_KEY = "penlight.taken.v1";

export function takenIds(owner: string): number[] {
  try {
    const all = JSON.parse(localStorage.getItem(TAKEN_KEY) ?? "{}") as Record<string, number[]>;
    return Array.isArray(all[owner]) ? all[owner] : [];
  } catch {
    return [];
  }
}

export function rememberTaken(owner: string, id: number) {
  try {
    const all = JSON.parse(localStorage.getItem(TAKEN_KEY) ?? "{}") as Record<string, number[]>;
    const ids = new Set(all[owner] ?? []);
    ids.add(id);
    all[owner] = [...ids].sort((a, b) => b - a).slice(0, 200);
    localStorage.setItem(TAKEN_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable */
  }
}
