/** Clock, oracle scaling, pool draw and commitment — ports of the program's pure modules. */
import { sha256 } from "@noble/hashes/sha2";
import { PublicKey } from "@solana/web3.js";
import { GRACE_BPS, HINT_AT_BPS, HINTS, SLOTS, USD_DECIMALS } from "./constants.js";
import { Stream } from "./rng.js";

export interface ClockParams {
  startPrice: bigint;
  floorPrice: bigint;
  openSlot: bigint;
  durationSlots: bigint;
}

export function priceAt(c: ClockParams, slot: bigint): bigint {
  if (slot <= c.openSlot || c.durationSlots === 0n) return c.startPrice;
  let elapsed = slot - c.openSlot;
  if (elapsed > c.durationSlots) elapsed = c.durationSlots;
  const span = c.startPrice - c.floorPrice;
  return c.startPrice - (span * elapsed) / c.durationSlots;
}

export function hintSlot(c: ClockParams, index: number): bigint {
  return c.openSlot + (c.durationSlots * BigInt(HINT_AT_BPS[index])) / 10_000n;
}

export function hintsDue(c: ClockParams, slot: bigint): number {
  let due = 0;
  for (let i = 0; i < HINTS; i++) if (slot >= hintSlot(c, i)) due++;
  return due;
}

export function expirySlot(c: ClockParams): bigint {
  return c.openSlot + c.durationSlots + (c.durationSlots * BigInt(GRACE_BPS)) / 10_000n;
}

/** Micro-dollar value of `amount` base units at raw price / 10^expo. */
export function valueMicros(amount: bigint, decimals: number, priceRaw: bigint, expo: number): bigint {
  return (amount * priceRaw * 10n ** BigInt(USD_DECIMALS)) / 10n ** BigInt(decimals + expo);
}

export function amountForValue(micros: bigint, decimals: number, priceRaw: bigint, expo: number): bigint {
  if (priceRaw === 0n) return 0n;
  return (micros * 10n ** BigInt(decimals + expo)) / (priceRaw * 10n ** BigInt(USD_DECIMALS));
}

/** Decode a MagicBlock oracle account (PriceUpdate layout). No validation beyond shape. */
export function decodeFeed(data: Uint8Array): { raw: bigint; publishTime: number; postedSlot: bigint } | null {
  if (data.length < 133) return null;
  const c = data[40] === 1 ? 41 : 42;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    raw: dv.getBigInt64(c + 32, true),
    publishTime: Number(dv.getBigInt64(c + 52, true)),
    postedSlot: dv.getBigUint64(c + 84, true),
  };
}

export interface PoolSlot {
  balance: bigint;
  decimals: number;
  priceRaw: bigint;
  expo: number;
}

const POOL_VALUE_MIN = 8_000_000n;
const POOL_VALUE_MAX = 48_000_000n;
const POOL_KINDS_MIN = 2n;
const POOL_KINDS_MAX = 5n;

export function draw(seed: Uint8Array, pool: PoolSlot[]): bigint[] | null {
  const s = new Stream(seed, 50);
  const available: number[] = [];
  for (let i = 0; i < SLOTS; i++) if (pool[i].balance > 0n && pool[i].priceRaw > 0n) available.push(i);
  if (available.length === 0) return null;
  const span = POOL_KINDS_MAX - POOL_KINDS_MIN + 1n;
  const k = Math.min(Number(POOL_KINDS_MIN + s.below(span)), available.length);
  for (let i = 0; i < k; i++) {
    const j = i + Number(s.below(BigInt(available.length - i)));
    [available[i], available[j]] = [available[j], available[i]];
  }
  const chosen = available.slice(0, k);
  const target = POOL_VALUE_MIN + s.below(POOL_VALUE_MAX - POOL_VALUE_MIN + 1n);
  const weights = chosen.map(() => 1n + s.below(100n));
  const wsum = weights.reduce((a, b) => a + b, 0n);
  const amounts = Array<bigint>(SLOTS).fill(0n);
  chosen.forEach((slot, idx) => {
    const share = (target * weights[idx]) / wsum;
    const p = pool[slot];
    let amount = amountForValue(share, p.decimals, p.priceRaw, p.expo);
    if (amount > p.balance) amount = p.balance;
    amounts[slot] = amount;
  });
  if (amounts.every((a) => a === 0n)) return null;
  return amounts;
}

const DOMAIN = new TextEncoder().encode("penlight-v1");

export function commitment(lot: PublicKey, salt: Uint8Array, mints: PublicKey[], amounts: bigint[]): Uint8Array {
  const parts: Uint8Array[] = [DOMAIN, lot.toBytes(), salt];
  for (let i = 0; i < SLOTS; i++) {
    parts.push(mints[i].toBytes());
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, amounts[i], true);
    parts.push(b);
  }
  const len = parts.reduce((s, p) => s + p.length, 0);
  const buf = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  return sha256(buf);
}
