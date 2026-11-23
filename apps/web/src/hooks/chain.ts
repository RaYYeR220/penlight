"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { CATALOGUE, decodeLot, sendAndConfirm, type LotView } from "@penlight/sdk";
import { penlight, playerKey, rollupAsPlayer, rollupPublic } from "@/lib/chain";
import { house, type ApiLot, type FeedEvent } from "@/lib/house";

/**
 * The rollup's slot, estimated between polls at its measured rate (~100/s), so
 * a clock can be drawn every frame without asking the network every frame.
 */
class SlotClock {
  private slot = 0;
  private at = 0;
  private rate = 0.1; // slots per ms
  private started = false;
  start() {
    if (this.started || typeof window === "undefined") return;
    this.started = true;
    const sync = async () => {
      try {
        const t0 = performance.now();
        const s = await rollupPublic().getSlot("confirmed");
        const t1 = performance.now();
        const mid = (t0 + t1) / 2;
        if (this.at > 0 && s > this.slot) {
          const measured = (s - this.slot) / (mid - this.at);
          if (measured > 0.02 && measured < 0.3) this.rate = this.rate * 0.7 + measured * 0.3;
        }
        this.slot = s;
        this.at = mid;
      } catch {
        /* keep extrapolating */
      }
    };
    void sync();
    setInterval(sync, 2000);
  }
  now(): bigint {
    if (!this.at) return 0n;
    return BigInt(Math.floor(this.slot + (performance.now() - this.at) * this.rate));
  }
}
export const slotClock = new SlotClock();

/** Re-renders at most every `everyMs` with the estimated rollup slot. */
export function useRollupSlot(everyMs = 50): bigint {
  const [slot, setSlot] = useState(0n);
  useEffect(() => {
    slotClock.start();
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      if (t - last >= everyMs) {
        last = t;
        setSlot(slotClock.now());
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [everyMs]);
  return slot;
}

/** One lot, live from the rollup (falls back to Solana once it has settled). */
export function useLot(id: number | null) {
  const [lot, setLot] = useState<LotView | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (id === null || Number.isNaN(id)) return;
    const pl = penlight();
    const address = pl.lotAddress(id);
    let alive = true;
    const load = async () => {
      const [r, b] = await Promise.all([
        pl.fetchLot(rollupPublic(), address).catch(() => null),
        pl.base.getAccountInfo(address).catch(() => null),
      ]);
      if (!alive) return;
      const settled = b && b.owner.equals(pl.programId);
      if (r && !settled) setLot(r);
      else if (settled) setLot(decodeLot(address, b!.data));
      else setMissing(true);
    };
    void load();
    const sub = rollupPublic().onAccountChange(address, (acc) => {
      if (alive && acc.owner.equals(pl.programId)) setLot(decodeLot(address, acc.data));
    }, { commitment: "confirmed" });
    const poll = setInterval(load, 1500);
    return () => {
      alive = false;
      clearInterval(poll);
      void rollupPublic().removeAccountChangeListener(sub);
    };
  }, [id]);
  return { lot, missing };
}

export function useLots(everyMs = 2000) {
  const [lots, setLots] = useState<ApiLot[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => house.lots(60).then((l) => alive && setLots(l)).catch(() => {});
    load();
    const t = setInterval(load, everyMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [everyMs]);
  return lots;
}

export function useFeed(everyMs = 2000) {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => house.events(0).then((e) => alive && setEvents(e.slice(-40).reverse())).catch(() => {});
    load();
    const t = setInterval(load, everyMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [everyMs]);
  return events;
}

/** Tells the House someone is on the floor, so it keeps lots open. */
export function usePresence() {
  useEffect(() => {
    let id = sessionStorage.getItem("penlight.presence");
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem("penlight.presence", id);
    }
    const ping = () => house.presence(id!).catch(() => {});
    ping();
    const t = setInterval(ping, 30_000);
    return () => clearInterval(t);
  }, []);
}

export interface Holdings {
  usdc: bigint;
  tokens: bigint[];
}

/** The in-browser player: key, rollup balances, faucet, take. */
export function usePlayer() {
  const [pubkey, setPubkey] = useState<PublicKey | null>(null);
  const [holdings, setHoldings] = useState<Holdings | null>(null);
  const [funding, setFunding] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    setPubkey(playerKey().publicKey);
  }, []);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const pl = penlight();
      const k = playerKey().publicKey;
      const er = await rollupAsPlayer();
      const bal = async (mint: PublicKey) => {
        try {
          return BigInt((await er.getTokenAccountBalance(pl.ata(k, mint))).value.amount);
        } catch {
          return 0n;
        }
      };
      const [usdc, ...tokens] = await Promise.all([bal(pl.usdcMint), ...pl.mints.map(bal)]);
      setHoldings({ usdc, tokens });
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    if (!pubkey) return;
    void refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [pubkey, refresh]);

  const fund = useCallback(async () => {
    setFunding(true);
    try {
      const r = await house.faucet(playerKey().publicKey.toBase58());
      for (let i = 0; i < 20; i++) {
        await new Promise((res) => setTimeout(res, 1000));
        await refresh();
      }
      return r;
    } finally {
      setFunding(false);
    }
  }, [refresh]);

  const take = useCallback(async (lot: LotView, maxPrice: bigint) => {
    const pl = penlight();
    const k = playerKey();
    const er = await rollupAsPlayer();
    const ix = await pl.takeIx(k.publicKey, lot.address, lot.seller, maxPrice);
    const r = await sendAndConfirm(er, [ix], [k], { label: "take", timeoutMs: 15_000 });
    void refresh();
    return r;
  }, [refresh]);

  return { pubkey, holdings, refresh, fund, funding, take };
}

export { CATALOGUE };
