"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { STATUS_NAME, clockOf, decodeLot, type LotView } from "@penlight/sdk";
import { penlight, rollupPublic } from "@/lib/chain";
import { hex, int, usd } from "@/lib/format";
import { useWho } from "@/hooks/app";
import { usePlayerCtx } from "@/components/player";
import { CheckList, Contents, isOpened, isTaken, useChecks } from "@/components/lot";
import { AddrLink, Copy, Spinner, WhoLabel, blockOf } from "@/components/ui";

type Read = { lot: LotView; source: "Solana" | "the private rollup" } | { lot: null; error: string };

async function readLot(id: number): Promise<Read> {
  const pl = penlight();
  const address = pl.lotAddress(id);
  const b = await pl.base.getAccountInfo(address, "confirmed");
  if (b && b.owner.equals(pl.programId)) return { lot: decodeLot(address, b.data), source: "Solana" };
  const r = await pl.fetchLot(rollupPublic(), address);
  if (r) return { lot: r, source: "the private rollup" };
  return { lot: null, error: `There is no lot #${id} on Solana or in the private rollup.` };
}

function HexRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <span className="num hexbox">{value}</span> <Copy text={value} />
      </dd>
    </div>
  );
}

export function VerifyLot({ id }: { id: number }) {
  const [read, setRead] = useState<Read | null>(null);
  const { me } = usePlayerCtx();
  const who = useWho(me);

  useEffect(() => {
    if (Number.isNaN(id)) return;
    let alive = true;
    let t: ReturnType<typeof setTimeout>;
    const load = async () => {
      const r = await readLot(id).catch((e) => ({ lot: null, error: (e as Error).message }) as Read);
      if (!alive) return;
      setRead(r);
      // Until it opens there is nothing to re-derive; keep reading.
      if (!r.lot || !isOpened(r.lot) || ("source" in r && r.source !== "Solana")) t = setTimeout(load, 3000);
    };
    void load();
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [id]);

  const lot = read?.lot ?? null;
  const checks = useChecks(lot && isOpened(lot) ? lot : null);
  const ok = checks?.every((c) => c.ok) ?? false;

  return (
    <div className="wrap">
      <Link href="/verify" className="back small mute">
        ← Verify
      </Link>
      <div className="lot-title" style={{ marginTop: 10 }}>
        <h1 className="h1">Lot #{Number.isNaN(id) ? "?" : id}</h1>
        {checks ? <span className={`badge ${ok ? "badge-pos" : "badge-neg"}`}>{ok ? "Verified ✓" : "Check failed ✗"}</span> : null}
      </div>

      {Number.isNaN(id) ? (
        <p className="lede">That isn&apos;t a lot number.</p>
      ) : !read ? (
        <p className="empty" style={{ marginTop: 24 }}>
          <Spinner /> Reading the lot account…
        </p>
      ) : !lot ? (
        <p className="lede">{"error" in read ? read.error : null}</p>
      ) : (
        <>
          <p className="lede">
            Read from {"source" in read ? read.source : ""} · status <b>{STATUS_NAME[lot.status] ?? lot.status}</b> · <Link href={`/lot/${lot.id}`} className="inline-link">lot room</Link>
          </p>
          {!isOpened(lot) ? (
            <div className="notice" style={{ marginTop: 24 }}>
              Not opened yet. The seal is posted, but the contents, salt and seed stay inside the enclave until someone takes the lot or its clock runs out. This page re-checks every few seconds.
            </div>
          ) : null}

          <div className="verify-grid">
            <div className="stack">
              {checks ? (
                <section className={`panel verified ${ok ? "is-ok" : "is-bad"}`}>
                  <div className="panel-head">
                    <h2 className="verified-mark">{ok ? "Verified ✓" : "Check failed ✗"}</h2>
                    <span className="small mute">
                      {checks.filter((c) => c.ok).length}/{checks.length} re-derived in this browser
                    </span>
                  </div>
                  <CheckList checks={checks} open />
                </section>
              ) : null}
              {isOpened(lot) ? (
                <section className="panel">
                  <div className="panel-head">
                    <h2>Contents</h2>
                    <span className="small mute">at the oracle prices recorded at opening</span>
                  </div>
                  <Contents lot={lot} />
                </section>
              ) : null}
            </div>

            <div className="stack">
              <section className="panel">
                <div className="panel-head">
                  <h2>Seal</h2>
                  <span className="small mute">posted before the clock opened</span>
                </div>
                <dl className="kv small">
                  <HexRow label="Commitment" value={hex(lot.commitment)} />
                  {isOpened(lot) ? <HexRow label="Salt" value={hex(lot.salt)} /> : null}
                  {isOpened(lot) ? <HexRow label="VRF seed" value={hex(lot.seed)} /> : null}
                  <div>
                    <dt>Account</dt>
                    <dd className="links">
                      <AddrLink address={lot.address.toBase58()} label="Solana" />
                      <AddrLink address={lot.address.toBase58()} rollup label="rollup" />
                    </dd>
                  </div>
                </dl>
              </section>
              {isTaken(lot) ? (
                <section className="panel">
                  <div className="panel-head">
                    <h2>Sale</h2>
                  </div>
                  <dl className="kv small">
                    <div>
                      <dt>Buyer</dt>
                      <dd>
                        <WhoLabel who={who(lot.winner.toBase58())} />
                      </dd>
                    </div>
                    <div>
                      <dt>Paid</dt>
                      <dd className="num">{usd(lot.paid)}</dd>
                    </div>
                    <div>
                      <dt>Block</dt>
                      <dd className="num">
                        {int(blockOf(clockOf(lot), lot.soldSlot))} of {int(lot.durationSlots)} · rollup slot {lot.soldSlot.toString()}
                      </dd>
                    </div>
                    <div>
                      <dt>Clock</dt>
                      <dd className="num">
                        {usd(lot.startPrice)} → {usd(lot.floorPrice)}
                      </dd>
                    </div>
                  </dl>
                </section>
              ) : null}
              <section className="panel">
                <div className="panel-head">
                  <h2>Run it yourself</h2>
                </div>
                <pre className="term num">{`npx penlight verify ${lot.id}`}</pre>
                <p className="small mute" style={{ marginTop: 12 }}>
                  Same SDK, same checks, straight from Solana.
                </p>
              </section>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
