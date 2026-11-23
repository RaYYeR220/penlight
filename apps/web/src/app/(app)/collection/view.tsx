"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { AccountLayout, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { isMagicAtaTokenAccount, withdrawSpl } from "@magicblock-labs/ephemeral-rollups-sdk";
import { CATALOGUE, STATUS_NAME, type LotView } from "@penlight/sdk";
import type { ApiLot } from "@/lib/house";
import { useLots } from "@/hooks/chain";
import { usePrices } from "@/hooks/app";
import { penlight, playerKey, rollupAsPlayer, rollupPublic } from "@/lib/chain";
import { house } from "@/lib/house";
import { takenIds, tokenAmount, totalValue, usd, valueOf } from "@/lib/format";
import { usePlayerCtx } from "@/components/player";
import { AddrLink, Edge, Num, SigLink, Spinner, TokenDot } from "@/components/ui";

/** The private rollup's enclave validator: withdrawals settle out of it. */
const VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
/** Base-layer lamports a withdrawal needs: fees plus the Solana token account's rent. */
const FEES_PER_KIND = 6_000_000;

type W =
  | { stage: "idle" }
  | { stage: "fees" }
  | { stage: "signing"; sponsorSig?: string }
  | { stage: "landing"; sig: string; sponsorSig?: string }
  | { stage: "done"; sig: string; ata: string; amount: string | null; sponsorSig?: string }
  | { stage: "error"; error: string; sponsorSig?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Won {
  id: number;
  paid: bigint;
  value: bigint | null;
  edge: bigint | null;
  status: string;
}

const OPENED_CODES = [5, 6, 7, 8];

/**
 * Lots this player took: the House's list, plus any lot this browser took that the
 * House no longer lists, read straight from Solana (or the rollup, before it settles).
 */
function useWon(me: string | null, apiLots: ApiLot[] | null): Won[] {
  const [fromChain, setFromChain] = useState<LotView[]>([]);
  const listed = (apiLots ?? []).map((l) => l.id).join(",");
  const loaded = apiLots !== null;
  useEffect(() => {
    if (!me || !loaded) return;
    const have = new Set(listed ? listed.split(",").map(Number) : []);
    const ids = takenIds(me).filter((id) => !have.has(id));
    if (!ids.length) return;
    let alive = true;
    void (async () => {
      const pl = penlight();
      const onBase = await pl.fetchLots(pl.base, ids).catch(() => ids.map(() => null));
      const rest = ids.filter((_, i) => !onBase[i]);
      const inRollup = rest.length ? await pl.fetchLots(rollupPublic(), rest).catch(() => rest.map(() => null)) : [];
      const lots = [...onBase, ...inRollup].filter((l): l is LotView => !!l && l.winner.toBase58() === me);
      if (alive) setFromChain(lots);
    })();
    return () => {
      alive = false;
    };
  }, [me, listed, loaded]);
  const rows: Won[] = (apiLots ?? [])
    .filter((l) => me && l.winner === me)
    .map((l) => ({ id: l.id, paid: BigInt(l.paid), value: l.value !== null ? BigInt(l.value) : null, edge: l.edge !== null ? BigInt(l.edge) : null, status: l.status }));
  for (const l of fromChain) {
    if (rows.some((r) => r.id === l.id)) continue;
    const opened = OPENED_CODES.includes(l.status);
    rows.push({ id: l.id, paid: l.paid, value: opened ? l.valueAtDelivery : null, edge: opened ? l.valueAtDelivery - l.paid : null, status: STATUS_NAME[l.status] ?? String(l.status) });
  }
  return rows.sort((a, b) => b.id - a.id);
}

/** The player's ordinary Solana token accounts for the catalogue: where withdrawals land. */
function useOnSolana(owner: string | null, bump: number) {
  const [rows, setRows] = useState<{ slot: number; ata: string; amount: bigint }[] | null>(null);
  useEffect(() => {
    if (!owner) return;
    let alive = true;
    const load = async () => {
      const pl = penlight();
      const o = new PublicKey(owner);
      const atas = pl.mints.map((m) => getAssociatedTokenAddressSync(m, o));
      const infos = await pl.base.getMultipleAccountsInfo(atas, "confirmed").catch(() => null);
      if (!alive || !infos) return;
      setRows(
        infos
          .map((info, slot) => ({ slot, ata: atas[slot].toBase58(), amount: info && info.data.length >= 165 ? AccountLayout.decode(info.data).amount : 0n }))
          .filter((r) => r.amount > 0n),
      );
    };
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [owner, bump]);
  return rows;
}

/** One token's way out. Its state lives in the page, so the receipt stays after the rollup balance reaches zero. */
function Withdraw({ slot, amount, w, setW, onDone }: { slot: number; amount: bigint; w: W; setW: (w: W) => void; onDone: () => void }) {
  const c = CATALOGUE[slot];

  const run = async () => {
    const pl = penlight();
    const k = playerKey();
    const owner = k.publicKey;
    const mint = pl.mints[slot];
    let sponsorSig: string | undefined;
    try {
      setW({ stage: "fees" });
      let lamports = await pl.base.getBalance(owner, "confirmed");
      if (lamports < FEES_PER_KIND) {
        try {
          sponsorSig = (await house.sponsorWithdraw(owner.toBase58())).signature;
        } catch (e) {
          const err = e as Error & { status?: number };
          throw new Error(
            err.status === 403
              ? "The House covers Solana fees only for tokens won in a lot by a player who used the faucet."
              : err.status === 409
                ? "The House already covered this player's Solana fees in the last 12 hours, and the balance is too low for another withdrawal."
                : `Solana fees: ${err.message}`,
          );
        }
        for (let i = 0; i < 20 && lamports < FEES_PER_KIND; i++) {
          await sleep(750);
          lamports = await pl.base.getBalance(owner, "confirmed");
        }
      }
      setW({ stage: "signing", sponsorSig });
      const er = await rollupAsPlayer();
      const info = await er.getAccountInfo(pl.ata(owner, mint));
      if (!info) throw new Error(`No ${c.symbol} in your rollup balance.`);
      const ixs = await withdrawSpl(owner, mint, amount, {
        validator: VALIDATOR,
        payer: owner,
        magicAtaSource: isMagicAtaTokenAccount(info.data),
        initAtasIfMissing: true,
      });
      const sig = await sendAndConfirmTransaction(pl.base, new Transaction().add(...ixs), [k], { commitment: "confirmed" });
      setW({ stage: "landing", sig, sponsorSig });
      const ata = getAssociatedTokenAddressSync(mint, owner);
      for (let i = 0; i < 45; i++) {
        const b = await pl.base.getTokenAccountBalance(ata, "confirmed").catch(() => null);
        if (b && b.value.amount !== "0") {
          setW({ stage: "done", sig, ata: ata.toBase58(), amount: b.value.amount, sponsorSig });
          onDone();
          return;
        }
        await sleep(1000);
      }
      setW({ stage: "done", sig, ata: ata.toBase58(), amount: null, sponsorSig });
      onDone();
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      setW({ stage: "error", error: msg.split("\n")[0].slice(0, 220), sponsorSig });
    }
  };

  const busy = w.stage === "fees" || w.stage === "signing" || w.stage === "landing";
  return (
    <div className="withdraw-cell">
      {w.stage === "done" || (amount === 0n && w.stage !== "error") ? null : (
        <button type="button" className="btn btn-sm" disabled={busy || amount === 0n} onClick={() => void run()}>
          {busy ? <Spinner /> : null}
          {w.stage === "fees"
            ? "Covering Solana fees"
            : w.stage === "signing"
              ? "Withdrawing"
              : w.stage === "landing"
                ? "Landing on Solana"
                : w.stage === "error"
                  ? "Try again"
                  : "Withdraw to Solana"}
        </button>
      )}
      {w.stage !== "idle" && "sponsorSig" in w && w.sponsorSig ? <SigLink sig={w.sponsorSig} label="fees from the House" /> : null}
      {(w.stage === "landing" || w.stage === "done") && <SigLink sig={w.sig} label="withdrawal" />}
      {w.stage === "done" ? (
        <span className="small">
          {w.amount ? (
            <>
              <b>On Solana ✓</b> <span className="num">{tokenAmount(BigInt(w.amount), c.decimals)}</span> {c.symbol} in{" "}
              <AddrLink address={w.ata} />
            </>
          ) : (
            <>
              Sent. The Solana account <AddrLink address={w.ata} /> hasn&apos;t shown the balance yet.
            </>
          )}
        </span>
      ) : null}
      {w.stage === "error" ? <span className="small neg">{w.error}</span> : null}
    </div>
  );
}

export function CollectionView() {
  const p = usePlayerCtx();
  const { prices } = usePrices();
  const lots = useLots(4000);
  const h = p.holdings;
  const [ws, setWs] = useState<Record<number, W>>({});
  const [bump, setBump] = useState(0);
  const onSolana = useOnSolana(p.me, bump);
  const held = h ? CATALOGUE.map((c, i) => ({ c, i, amount: h.tokens[i] ?? 0n })).filter((r) => r.amount > 0n || (ws[r.i] && ws[r.i].stage !== "idle")) : [];
  const worth = h && prices ? totalValue(h.tokens, prices) : null;
  const won = useWon(p.me, lots);
  const paid = won.reduce((s, l) => s + l.paid, 0n);
  const value = won.reduce((s, l) => s + (l.value ?? 0n), 0n);
  const edge = won.reduce((s, l) => s + (l.edge ?? 0n), 0n);

  return (
    <div className="wrap">
      <h1 className="h1">Collection</h1>
      <p className="lede">What you hold inside the private rollup, the lots you took, and the way out to Solana.</p>

      <div className="section-title">
        <h2>Holdings</h2>
        <span className="small mute">{worth !== null ? <>tokens worth <Num>{usd(worth)}</Num> at live prices</> : "in the private rollup"}</span>
      </div>
      {!h ? (
        <p className="empty">
          <Spinner /> Opening your rollup session…
        </p>
      ) : (
        <div className="table holdings">
          <div className="trow thead" aria-hidden>
            <span className="tcell">Token</span>
            <span className="tcell tnum">Amount</span>
            <span className="tcell tnum">Value now</span>
            <span className="tcell tnum">Move</span>
          </div>
          <div className="trow">
            <span className="tcell tok">
              <TokenDot symbol="usdc" />
              <span>tUSDC</span>
              <span className="small mute hide-sm">test USDC</span>
            </span>
            <span className="tcell tnum num">{usd(h.usdc).slice(1)}</span>
            <span className="tcell tnum num">{usd(h.usdc)}</span>
            <span className="tcell tnum small mute">{h.usdc === 0n ? <button type="button" className="link-btn" onClick={() => void p.fund()} disabled={p.funding}>{p.funding ? "Landing…" : "Get test USDC"}</button> : "pays for TAKEs"}</span>
          </div>
          {held.map(({ c, i, amount }) => (
            <div className="trow" key={c.symbol}>
              <span className="tcell tok">
                <TokenDot symbol={c.symbol} />
                <span>{c.symbol}</span>
                <span className="small mute hide-sm">{c.name}</span>
              </span>
              <span className="tcell tnum num">{tokenAmount(amount, c.decimals)}</span>
              <span className="tcell tnum num">{prices ? usd(valueOf(i, amount, prices[i])) : "…"}</span>
              <Withdraw
                slot={i}
                amount={amount}
                w={ws[i] ?? { stage: "idle" }}
                setW={(w) => setWs((x) => ({ ...x, [i]: w }))}
                onDone={() => {
                  void p.refresh();
                  setBump((b) => b + 1);
                }}
              />
            </div>
          ))}
          {held.length === 0 ? (
            <p className="small mute pad-y">
              No tokens yet. Take a lot on the <Link href="/floor" className="inline-link">Floor</Link>; what&apos;s inside lands here when it opens.
            </p>
          ) : null}
        </div>
      )}
      {held.length > 0 ? (
        <p className="small mute pad-y">Withdrawing moves a token from the rollup back to a normal Solana token account you own. The House covers the devnet SOL for fees on tokens you won.</p>
      ) : null}

      {onSolana && onSolana.length > 0 ? (
        <>
          <div className="section-title">
            <h2>On Solana</h2>
            <span className="small mute">withdrawn to your own token accounts</span>
          </div>
          <div className="table holdings">
            {onSolana.map((r) => {
              const c = CATALOGUE[r.slot];
              return (
                <div className="trow" key={r.ata}>
                  <span className="tcell tok">
                    <TokenDot symbol={c.symbol} />
                    <span>{c.symbol}</span>
                    <span className="small mute hide-sm">{c.name}</span>
                  </span>
                  <span className="tcell tnum num">{tokenAmount(r.amount, c.decimals)}</span>
                  <span className="tcell tnum num">{prices ? usd(valueOf(r.slot, r.amount, prices[r.slot])) : "…"}</span>
                  <span className="tcell tnum">
                    <AddrLink address={r.ata} label={<span className="sig-label">token account</span>} />
                  </span>
                </div>
              );
            })}
          </div>
        </>
      ) : null}

      <div className="section-title">
        <h2>Lots you took</h2>
        {won.length > 0 ? (
          <span className="small mute">
            total edge <Edge micros={edge} />
          </span>
        ) : null}
      </div>
      {won.length === 0 ? (
        <p className="small mute pad-y">Lots you take show up here with what you paid, what they were worth and your edge.</p>
      ) : (
        <div className="table won">
          <div className="trow thead" aria-hidden>
            <span className="tcell">Lot</span>
            <span className="tcell tnum">Paid</span>
            <span className="tcell tnum col-worth">Worth</span>
            <span className="tcell tnum">Edge</span>
            <span className="tcell tnum">Status</span>
          </div>
          {won.map((l) => (
            <Link href={`/lot/${l.id}`} className="trow" key={l.id}>
              <span className="tcell">Lot #{l.id}</span>
              <span className="tcell tnum num">{usd(l.paid)}</span>
              <span className="tcell tnum num col-worth">{l.value !== null ? usd(l.value) : "…"}</span>
              <span className="tcell tnum">
                <Edge micros={l.edge} />
              </span>
              <span className="tcell tnum small mute">{l.status}</span>
            </Link>
          ))}
          <div className="trow total-row">
            <span className="tcell">Total</span>
            <span className="tcell tnum num">{usd(paid)}</span>
            <span className="tcell tnum num col-worth">{usd(value)}</span>
            <span className="tcell tnum">
              <Edge micros={edge} />
            </span>
            <span className="tcell" />
          </div>
        </div>
      )}
    </div>
  );
}
