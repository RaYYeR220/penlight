"use client";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { decodeFeed } from "@penlight/sdk";
import { deployment, penlight, rollupPublic } from "@/lib/chain";
import { house, type LeaderRow } from "@/lib/house";
import { short } from "@/lib/format";

// ── live oracle prices (raw, catalogue order), shared by every component ──
let prices: bigint[] | null = null;
let pricesAt = 0;
const priceSubs = new Set<() => void>();
let priceTimer: ReturnType<typeof setInterval> | null = null;

async function loadPrices() {
  try {
    const pl = penlight();
    const infos = await rollupPublic().getMultipleAccountsInfo(pl.feeds, "confirmed");
    const next = infos.map((a) => (a ? (decodeFeed(a.data)?.raw ?? 0n) : 0n));
    if (next.some((p) => p > 0n)) {
      prices = next;
      pricesAt = Date.now();
      priceSubs.forEach((f) => f());
    }
  } catch {
    /* keep the last prices */
  }
}

function subscribePrices(f: () => void) {
  priceSubs.add(f);
  if (!priceTimer) {
    void loadPrices();
    priceTimer = setInterval(loadPrices, 5000);
  }
  return () => {
    priceSubs.delete(f);
    if (priceSubs.size === 0 && priceTimer) {
      clearInterval(priceTimer);
      priceTimer = null;
    }
  };
}

/** Live oracle prices from the rollup's price feeds (Pyth Lazer, republished by MagicBlock). */
export function usePrices(): { prices: bigint[] | null; at: number } {
  const p = useSyncExternalStore(subscribePrices, () => prices, () => null);
  return { prices: p, at: pricesAt };
}

// ── the House's rival bidders ──
export interface Bot {
  name: string;
  style: string;
  address: string;
}
let botsPromise: Promise<Bot[]> | null = null;
function loadBots() {
  if (!botsPromise) botsPromise = house.deployment().then((d) => d.bots).catch(() => ((botsPromise = null), []));
  return botsPromise;
}

export function useBots(): Bot[] {
  const [bots, setBots] = useState<Bot[]>([]);
  useEffect(() => {
    let alive = true;
    void loadBots().then((b) => alive && setBots(b));
    return () => {
      alive = false;
    };
  }, []);
  return bots;
}

export interface Who {
  label: string;
  kind: "you" | "bot" | "house" | "player";
  detail?: string;
  address: string;
}

/** Labels an address: you, one of the House's bidders by name, the House, or a short address. */
export function useWho(me: string | null) {
  const bots = useBots();
  return useCallback(
    (address: string | null | undefined): Who | null => {
      if (!address) return null;
      if (me && address === me) return { label: "you", kind: "you", address };
      const b = bots.find((x) => x.address === address);
      if (b) return { label: b.name, kind: "bot", detail: `House bidder · ${b.style}`, address };
      if (address === deployment.houseAuthority || address === deployment.house) return { label: "the House", kind: "house", address };
      return { label: short(address), kind: "player", address };
    },
    [bots, me],
  );
}

// ── House API polls ──
function usePoll<T>(load: () => Promise<T>, everyMs: number): T | null {
  const [v, setV] = useState<T | null>(null);
  useEffect(() => {
    let alive = true;
    const run = () => load().then((x) => alive && setV(x)).catch(() => {});
    run();
    const t = setInterval(run, everyMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [load, everyMs]);
  return v;
}

const loadStats = () => house.stats();
const loadBoard = () => house.leaderboard();

export const useStats = (everyMs = 4000) => usePoll(loadStats, everyMs);
export const useLeaderboard = (everyMs = 5000): LeaderRow[] | null => usePoll(loadBoard, everyMs);

/** Wall-clock time, re-rendered every `everyMs`. */
export function useNow(everyMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
