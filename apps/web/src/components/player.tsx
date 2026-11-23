"use client";
import "@/lib/polyfill";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { usePlayer } from "@/hooks/chain";
import { playerKey } from "@/lib/chain";
import { house } from "@/lib/house";

type Player = ReturnType<typeof usePlayer>;

export interface Faucet {
  stage: "idle" | "requesting" | "landing" | "done" | "error";
  signature?: string;
  error?: string;
}

interface Ctx extends Omit<Player, "fund" | "funding"> {
  me: string | null;
  faucet: Faucet;
  fund: () => Promise<void>;
  funding: boolean;
}

const PlayerCtx = createContext<Ctx | null>(null);

/** One in-browser player for the whole app: one balance poll, one faucet state. */
export function PlayerProvider({ children }: { children: ReactNode }) {
  const p = usePlayer();
  const { refresh } = p;
  const [faucet, setFaucet] = useState<Faucet>({ stage: "idle" });
  const usdc = useRef<bigint | null>(null);
  useEffect(() => {
    usdc.current = p.holdings?.usdc ?? null;
  }, [p.holdings]);

  const fund = useCallback(async () => {
    setFaucet({ stage: "requesting" });
    try {
      const r = await house.faucet(playerKey().publicKey.toBase58());
      setFaucet({ stage: "landing", signature: r.signature });
      // The private transfer lands in the rollup a few seconds after it settles on Solana.
      for (let i = 0; i < 40; i++) {
        await new Promise((res) => setTimeout(res, 1000));
        await refresh();
        if ((usdc.current ?? 0n) > 0n) break;
      }
      setFaucet({ stage: "done", signature: r.signature });
    } catch (e) {
      const err = e as Error & { status?: number };
      const msg =
        err.status === 409
          ? "This player was funded in the last six hours."
          : err.status === 429
            ? "The faucet is busy. Try again in a few minutes."
            : err.message || "The faucet transfer failed.";
      setFaucet({ stage: "error", error: msg });
    }
  }, [refresh]);

  const value: Ctx = {
    ...p,
    me: p.pubkey?.toBase58() ?? null,
    faucet,
    fund,
    funding: faucet.stage === "requesting" || faucet.stage === "landing",
  };
  return <PlayerCtx.Provider value={value}>{children}</PlayerCtx.Provider>;
}

export function usePlayerCtx(): Ctx {
  const c = useContext(PlayerCtx);
  if (!c) throw new Error("usePlayerCtx outside PlayerProvider");
  return c;
}
