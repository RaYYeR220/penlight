"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  CATALOGUE,
  HINT_AT_BPS,
  ORIGIN,
  STATUS,
  TxError,
  appraiseHouseLot,
  boundsFromFacts,
  clockOf,
  describe,
  hintSlot,
  priceAt,
  type Appraisal,
  type ClockParams,
  type LotView,
} from "@penlight/sdk";
import { slotClock, useLot, usePresence, useRollupSlot } from "@/hooks/chain";
import { usePrices, useWho } from "@/hooks/app";
import { usePlayerCtx } from "@/components/player";
import { AddrLink, Badge, BlockCounter, ClockBar, Copy, LivePrice, Num, SigLink, Spinner, WhoLabel, blockOf } from "@/components/ui";
import { CheckList, Contents, explainTake, isOpened, isTaken, useChecks } from "@/components/lot";
import { ceilCent, hex, int, rememberTaken, short, usd } from "@/lib/format";

const symbols = CATALOGUE.map((c) => c.symbol);
const SAMPLES = 6000;

type Take =
  | { kind: "idle" }
  | { kind: "pending"; price: bigint }
  | { kind: "done"; price: bigint; sig: string; ms: number }
  | { kind: "failed"; price: bigint; reason: string; sig?: string };

// ── status line ──
function phase(lot: LotView, slot: bigint): string {
  switch (lot.status) {
    case STATUS.CREATED:
      return lot.sealed ? (lot.origin === ORIGIN.HOUSE || lot.packed ? "requesting the seed" : "waiting for the seller to pack") : "sealing";
    case STATUS.SHUFFLING:
      return "drawing the seed";
    case STATUS.SHUFFLED:
      return lot.packed ? "posting the seal to Solana" : "packing from the seed";
    case STATUS.LIVE:
      return slot > 0n && slot < lot.openSlot ? "opening" : "live";
    case STATUS.SOLD:
      return "taken · opening";
    case STATUS.OPENED:
      return "opened · delivering";
    case STATUS.DELIVERED:
      return "delivered";
    case STATUS.UNSOLD:
      return "not taken · opening";
    case STATUS.EXPIRED:
      return "not taken · returned";
    default:
      return String(lot.status);
  }
}

function StatusLine({ lot, source }: { lot: LotView; source: "rollup" | "solana" | null }) {
  const slot = useRollupSlot(250);
  const seeded = lot.status >= STATUS.SHUFFLED;
  const items: { text: string; ok: boolean }[] = [
    { text: "sealed", ok: lot.sealed },
    { text: source === "solana" ? "record back on Solana" : "in the private rollup", ok: true },
    { text: seeded ? "seed drawn by VRF" : lot.status === STATUS.SHUFFLING ? "seed requested from VRF" : "seed not drawn yet", ok: seeded },
  ];
  const ph = phase(lot, slot);
  return (
    <ul className="statusline small">
      {items.map((i) => (
        <li key={i.text} className={i.ok ? "is-ok" : "is-wait"}>
          {i.text}
          {i.ok ? <span className="ok-mark"> ✓</span> : null}
        </li>
      ))}
      <li className={`phase phase-${lot.status === STATUS.LIVE ? "live" : "other"}`}>
        {lot.status === STATUS.LIVE ? <span className="live-dot" aria-hidden /> : null}
        {ph}
      </li>
    </ul>
  );
}

// ── facts ──
function Facts({ lot }: { lot: LotView }) {
  const slot = useRollupSlot(50);
  const clock = clockOf(lot);
  // Facts already out when the room opened don't animate in.
  const [firstSeen] = useState(lot.hintsRevealed);
  const live = lot.status === STATUS.LIVE;
  const before = lot.status < STATUS.LIVE;
  return (
    <ol className="facts">
      {HINT_AT_BPS.map((bps, i) => {
        const at = `${bps / 100}%`;
        if (i < lot.hintsRevealed) {
          const h = lot.hints[i];
          const block = h.slot > lot.openSlot ? h.slot - lot.openSlot : 0n;
          return (
            <li key={`out-${i}`} className={`fact is-out${i >= firstSeen ? " is-new" : ""}`}>
              <span className="fact-n num">{i + 1}</span>
              <div className="fact-body">
                <p className="fact-text">{describe({ kind: h.kind, sym: h.sym, a: h.a, b: h.b }, symbols)}</p>
                <p className="fact-meta small mute">
                  at {at} · block <Num>{int(block)}</Num>
                </p>
              </div>
            </li>
          );
        }
        let meta: React.ReactNode;
        if (before) meta = <>at {at} of the clock</>;
        else if (live) {
          const due = hintSlot(clock, i);
          meta =
            slot >= due ? (
              <span className="fact-due">
                <Spinner /> due now · the enclave is computing it
              </span>
            ) : (
              <>
                at {at} · in <Num>{slot === 0n ? "…" : int(due - slot)}</Num> blocks
              </>
            );
        } else meta = <>at {at} · never disclosed, the lot was taken first</>;
        return (
          <li key={`wait-${i}`} className="fact is-wait">
            <span className="fact-n num">{i + 1}</span>
            <div className="fact-body">
              <p className="fact-text mute">Sealed</p>
              <p className="fact-meta small mute">{meta}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ── what the facts say ──
function useAppraisal(lot: LotView, prices: bigint[] | null) {
  const [a, setA] = useState<{ facts: number; r: Appraisal } | null>(null);
  const lotRef = useRef(lot);
  const pricesRef = useRef(prices);
  useEffect(() => {
    lotRef.current = lot;
    pricesRef.current = prices;
  });
  const n = lot.hintsRevealed;
  const ready = n > 0 || prices !== null;
  const house = lot.origin === ORIGIN.HOUSE;
  useEffect(() => {
    if (!house || !ready) return;
    // Off the render path: a few thousand candidate draws take a moment.
    const t = setTimeout(() => {
      const l = lotRef.current;
      const facts = l.hints.slice(0, n).map((h, i) => ({ fact: { kind: h.kind, sym: h.sym, a: h.a, b: h.b }, prices: l.hintPrices[i] }));
      const latest = pricesRef.current ?? l.hintPrices[Math.max(0, n - 1)];
      setA({ facts: n, r: appraiseHouseLot(facts, latest, SAMPLES) });
    }, 30);
    return () => clearTimeout(t);
  }, [house, ready, n, lot.id]);
  return a;
}

function RangeBar({ lo, mid, hi, clock, frozen }: { lo: bigint; mid: bigint; hi: bigint; clock: ClockParams; frozen?: bigint }) {
  const slot = useRollupSlot(100);
  const price = frozen ?? (slot === 0n ? clock.startPrice : priceAt(clock, slot));
  const min = Number([lo, price].reduce((a, b) => (a < b ? a : b)));
  const max = Number([hi, price].reduce((a, b) => (a > b ? a : b)));
  const pad = (max - min) * 0.08 || 1;
  const x = (v: bigint) => `${((Number(v) - (min - pad)) / (max - min + 2 * pad)) * 100}%`;
  const below = price < mid;
  const diff = mid > 0n ? Math.abs(Number(price - mid) / Number(mid)) * 100 : 0;
  return (
    <div className="range">
      <div className="range-track">
        <span className="range-band" style={{ left: x(lo), width: `calc(${x(hi)} - ${x(lo)})` }} />
        <span className="range-mid" style={{ left: x(mid) }} />
        <span className={`range-clock ${below ? "is-below" : "is-above"}`} style={{ left: x(price) }}>
          <span className="range-clock-label num">{usd(price)}</span>
        </span>
      </div>
      <div className="range-scale small mute num">
        <span style={{ left: x(lo) }}>{usd(lo, 0)}</span>
        <span style={{ left: x(hi) }}>{usd(hi, 0)}</span>
      </div>
      <p className="range-read">
        {frozen !== undefined ? "Taken" : "The clock is"}{" "}
        <b className={below ? "pos" : "neg"}>
          {diff < 0.5 ? "at" : `${diff.toFixed(0)}% ${below ? "below" : "above"}`}
        </b>{" "}
        the median{price < lo ? ", under the whole range" : price > hi ? ", over the whole range" : ""}.
      </p>
    </div>
  );
}

function FactsSay({ lot, prices }: { lot: LotView; prices: bigint[] | null }) {
  const a = useAppraisal(lot, prices);
  const clock = clockOf(lot);
  const frozen = isTaken(lot) ? lot.paid : undefined;
  if (lot.origin !== ORIGIN.HOUSE) {
    const b = boundsFromFacts(lot.hints.slice(0, lot.hintsRevealed).map((h) => ({ kind: h.kind, sym: h.sym, a: h.a, b: h.b })));
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>What the facts say</h2>
          <span className="small mute">consigned · bounds only</span>
        </div>
        <p className="say-line">
          {b.lo === 0n && b.hi === null ? (
            <span className="mute">No fact bounds the value yet.</span>
          ) : (
            <>
              Worth {b.lo > 0n ? <>at least <b><Num>{usd(b.lo)}</Num></b></> : null}
              {b.lo > 0n && b.hi !== null ? " and " : null}
              {b.hi !== null ? <>at most <b><Num>{usd(b.hi)}</Num></b></> : null}.
            </>
          )}
        </p>
        <p className="small mute">The seller chose what went in, so there is no public draw to weigh against. Only facts about value bound it.</p>
      </section>
    );
  }
  const stale = a && a.facts !== lot.hintsRevealed;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>What the facts say</h2>
        <span className="small mute">{a ? `${a.facts} ${a.facts === 1 ? "fact" : "facts"} · live prices` : "reading…"}</span>
      </div>
      {!a ? (
        <p className="say-line mute">
          <Spinner /> Weighing every lot the House&apos;s draw could have made against the facts…
        </p>
      ) : a.r.consistent < 20 ? (
        <p className="say-line">
          Only <b className="num">{a.r.consistent}</b> of {int(a.r.sampled)} drawable lots fit every fact: too few to read a range from.
        </p>
      ) : (
        <>
          <p className="say-line">
            Worth{" "}
            <b>
              <Num>{usd(a.r.p10)}</Num>–<Num>{usd(a.r.p90)}</Num>
            </b>{" "}
            <span className="mute">(80% range)</span>, median{" "}
            <b>
              <Num>{usd(a.r.p50)}</Num>
            </b>
            {stale ? <> <Spinner /></> : null}
          </p>
          <RangeBar lo={a.r.p10} mid={a.r.p50} hi={a.r.p90} clock={clock} frozen={frozen} />
          <p className="small mute">
            <Num>{int(a.r.consistent)}</Num> of <Num>{int(a.r.sampled)}</Num> lots the House&apos;s public draw could have made still fit every fact.
            {isOpened(lot) && lot.valueAtDelivery > 0n ? (
              <>
                {" "}It opened worth{" "}
                <b>
                  <Num>{usd(lot.valueAtDelivery)}</Num>
                </b>
                .
              </>
            ) : null}
          </p>
        </>
      )}
    </section>
  );
}

// ── the clock ──
function PricePanel({ lot }: { lot: LotView }) {
  const clock = clockOf(lot);
  const seconds = Number(lot.durationSlots) / 100;
  if (lot.status < STATUS.LIVE) {
    return (
      <section className="panel price-panel">
        <span className="eyebrow">Clock price</span>
        <Num className="bigprice">{usd(lot.startPrice)}</Num>
        <p className="small mute">The clock opens once the seal is posted to Solana. It will fall to {usd(lot.floorPrice)} over {int(lot.durationSlots)} blocks (~{seconds.toFixed(0)} s).</p>
        <ClockBar clock={{ ...clock, openSlot: 1n << 62n }} revealed={0} />
      </section>
    );
  }
  if (isTaken(lot)) {
    const block = blockOf(clock, lot.soldSlot);
    return (
      <section className="panel price-panel">
        <span className="eyebrow">Paid</span>
        <Num className="bigprice">{usd(lot.paid)}</Num>
        <div className="price-meta small mute">
          <span>
            the clock price at block <Num>{int(block)}</Num> / {int(lot.durationSlots)}
          </span>
        </div>
        <ClockBar clock={clock} revealed={lot.hintsRevealed} stopAt={lot.soldSlot} />
        <div className="price-ends small mute num">
          <span>{usd(lot.startPrice)}</span>
          <span>{usd(lot.floorPrice)}</span>
        </div>
      </section>
    );
  }
  if (lot.status === STATUS.UNSOLD || lot.status === STATUS.EXPIRED) {
    return (
      <section className="panel price-panel">
        <span className="eyebrow">Clock ran out</span>
        <Num className="bigprice mute">{usd(lot.floorPrice)}</Num>
        <p className="small mute">Nobody took it, even at the floor.</p>
        <ClockBar clock={clock} revealed={lot.hintsRevealed} stopAt={lot.openSlot + lot.durationSlots} />
      </section>
    );
  }
  return (
    <section className="panel price-panel">
      <div className="price-top">
        <span className="eyebrow">Clock price</span>
        <span className="small mute">falls every 10 ms block</span>
      </div>
      <LivePrice clock={clock} className="bigprice" />
      <div className="price-meta small mute">
        <BlockCounter clock={clock} />
        <span className="hide-sm">~{seconds.toFixed(0)} s clock</span>
      </div>
      <ClockBar clock={clock} revealed={lot.hintsRevealed} />
      <div className="price-ends small mute num">
        <span>{usd(lot.startPrice)}</span>
        <span>{usd(lot.floorPrice)}</span>
      </div>
    </section>
  );
}

// ── TAKE ──
function TakeLabel({ clock }: { clock: ClockParams }) {
  const slot = useRollupSlot(16);
  return (
    <>
      Take at <Num>{usd(ceilCent(slot === 0n ? clock.startPrice : priceAt(clock, slot)))}</Num>
    </>
  );
}

function OpensIn({ openSlot }: { openSlot: bigint }) {
  const slot = useRollupSlot(100);
  return <>Opens in {slot === 0n ? "…" : int(openSlot > slot ? openSlot - slot : 0n)} blocks</>;
}

function TakeReceipt({ take }: { take: Take }) {
  if (take.kind === "done")
    return (
      <div className="receipt receipt-ok" role="status">
        <p>
          Your TAKE landed in{" "}
          <b>
            <Num>{int(take.ms)}</Num> ms
          </b>{" "}
          with a limit of <Num>{usd(take.price)}</Num>.
        </p>
        <SigLink sig={take.sig} rollup label="rollup tx" />
      </div>
    );
  if (take.kind === "failed")
    return (
      <div className="receipt receipt-bad" role="alert">
        <p>{take.reason}</p>
        {take.sig ? <SigLink sig={take.sig} rollup label="refused tx" /> : null}
      </div>
    );
  return null;
}

function TakePanel({ lot, take, onTake }: { lot: LotView; take: Take; onTake: () => void }) {
  const p = usePlayerCtx();
  const slot = useRollupSlot(100);
  const clock = clockOf(lot);
  const usdc = p.holdings?.usdc;
  const isSeller = p.me !== null && p.me === lot.seller.toBase58();
  const notOpen = slot > 0n && slot < lot.openSlot;
  const price = slot === 0n ? lot.startPrice : priceAt(clock, slot);
  const short_ = usdc !== undefined && usdc > 0n && usdc < ceilCent(price);

  let button: React.ReactNode;
  if (isSeller) {
    button = (
      <button type="button" className="take" disabled>
        You consigned this lot
      </button>
    );
  } else if (usdc === 0n) {
    button = p.funding ? (
      <button type="button" className="take" disabled>
        <Spinner /> Test USDC landing privately…
      </button>
    ) : (
      <button type="button" className="take take-alt" onClick={() => void p.fund()}>
        Get test USDC first
      </button>
    );
  } else if (take.kind === "pending") {
    button = (
      <button type="button" className="take" disabled aria-busy>
        <Spinner /> Landing in the rollup…
      </button>
    );
  } else if (notOpen) {
    button = (
      <button type="button" className="take" disabled>
        <OpensIn openSlot={lot.openSlot} />
      </button>
    );
  } else {
    button = (
      <button type="button" className="take" onClick={onTake} disabled={usdc === undefined || short_}>
        <TakeLabel clock={clock} />
      </button>
    );
  }

  return (
    <section className="panel take-panel">
      <div className="panel-head">
        <h2>Take it</h2>
        <span className="small mute">first TAKE wins</span>
      </div>
      {button}
      <p className="small mute take-note">
        {isSeller
          ? "A seller can't take their own lot; the program refuses it."
          : "You pay the clock price of the block your TAKE lands in, never more than the price on the button."}
      </p>
      <div className="take-bal small">
        <span className="mute">Your balance</span>
        <span className="num">{usdc === undefined ? "…" : `${usd(usdc).slice(1)} tUSDC`}</span>
      </div>
      {short_ ? <p className="small neg">Not enough test USDC at this price yet. The clock is still falling.</p> : null}
      {p.faucet.stage === "error" && usdc === 0n ? <p className="small neg">{p.faucet.error}</p> : null}
      <TakeReceipt take={take} />
    </section>
  );
}

function TakenPanel({ lot, take }: { lot: LotView; take: Take }) {
  const p = usePlayerCtx();
  const who = useWho(p.me);
  const block = blockOf(clockOf(lot), lot.soldSlot);
  const mine = p.me === lot.winner.toBase58();
  return (
    <section className={`panel taken-panel${mine ? " is-mine" : ""}`}>
      <div className="panel-head">
        <h2>{mine ? "You took it" : "Taken"}</h2>
        <span className="small mute">block {int(block)}</span>
      </div>
      <p className="taken-line">
        {mine ? (
          <span className="who who-you">
            <span>You</span>
          </span>
        ) : (
          <WhoLabel who={who(lot.winner.toBase58())} />
        )}{" "}
        paid{" "}
        <b>
          <Num>{usd(lot.paid)}</Num>
        </b>
        , the clock price at block <Num>{int(block)}</Num>.
      </p>
      {lot.status === STATUS.SOLD ? (
        <p className="small mute">
          <Spinner /> Opening: the enclave is making the contents, salt and seed public.
        </p>
      ) : lot.status === STATUS.OPENED ? (
        <p className="small mute">
          <Spinner /> Delivering the tokens inside to {mine ? "you" : "the buyer"}.
        </p>
      ) : (
        <p className="small mute">Tokens delivered{mine ? " to your rollup balance" : ""}.{mine ? " " : ""}{mine ? <Link href="/collection">Collection →</Link> : null}</p>
      )}
      <TakeReceipt take={take} />
    </section>
  );
}

function UnsoldPanel({ lot }: { lot: LotView }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Not taken</h2>
      </div>
      <p className="small">
        The clock ran out. The lot opened anyway and went back to {lot.origin === ORIGIN.HOUSE ? "the House's pool" : "its seller"}.
      </p>
    </section>
  );
}

function VerifiedPanel({ lot }: { lot: LotView }) {
  const checks = useChecks(lot);
  if (!checks) return null;
  const ok = checks.every((c) => c.ok);
  return (
    <section className={`panel verified ${ok ? "is-ok" : "is-bad"}`}>
      <div className="panel-head">
        <h2 className="verified-mark">{ok ? "Verified ✓" : "Check failed ✗"}</h2>
        <span className="small mute">
          {checks.filter((c) => c.ok).length}/{checks.length} re-derived in this browser
        </span>
      </div>
      <CheckList checks={checks} />
      <Link href={`/verify/${lot.id}`} className="small more">
        Full record and how to check it yourself →
      </Link>
    </section>
  );
}

function RecordPanel({ lot, source }: { lot: LotView; source: "rollup" | "solana" | null }) {
  const p = usePlayerCtx();
  const who = useWho(p.me);
  const seal = hex(lot.commitment);
  return (
    <section className="panel record">
      <div className="panel-head">
        <h2>Record</h2>
        <span className="small mute">{source === "solana" ? "read from Solana" : "read from the rollup"}</span>
      </div>
      <dl className="kv small">
        <div>
          <dt>Seller</dt>
          <dd>{lot.origin === ORIGIN.HOUSE ? "the House (drawn from its pool)" : <WhoLabel who={who(lot.seller.toBase58())} />}</dd>
        </div>
        <div>
          <dt>Seal</dt>
          <dd>
            <span className="num" title={seal}>
              {seal.slice(0, 10)}…{seal.slice(-6)}
            </span>{" "}
            <Copy text={seal} />
          </dd>
        </div>
        <div>
          <dt>Clock</dt>
          <dd className="num">
            {usd(lot.startPrice)} → {usd(lot.floorPrice)} · {int(lot.durationSlots)} blocks
          </dd>
        </div>
        <div>
          <dt>Account</dt>
          <dd className="links">
            <span className="num">{short(lot.address.toBase58())}</span>
            <AddrLink address={lot.address.toBase58()} rollup label="rollup" />
            <AddrLink address={lot.address.toBase58()} label="Solana" />
          </dd>
        </div>
      </dl>
    </section>
  );
}

export function LotRoom({ id }: { id: number }) {
  usePresence();
  const { lot, missing, source } = useLot(Number.isNaN(id) ? null : id);
  const p = usePlayerCtx();
  const { prices } = usePrices();
  const [take, setTake] = useState<Take>({ kind: "idle" });

  if (Number.isNaN(id) || (missing && !lot)) {
    return (
      <div className="wrap">
        <Link href="/floor" className="back small mute">
          ← Floor
        </Link>
        <h1 className="h1">No lot here</h1>
        <p className="lede">There is no lot #{Number.isNaN(id) ? "?" : id} on Solana or in the private rollup yet.</p>
      </div>
    );
  }
  if (!lot) {
    return (
      <div className="wrap">
        <p className="empty">
          <Spinner /> Reading lot #{id} from the private rollup…
        </p>
      </div>
    );
  }

  const onTake = async () => {
    const slot = slotClock.now();
    if (slot === 0n) return;
    const price = ceilCent(priceAt(clockOf(lot), slot));
    setTake({ kind: "pending", price });
    try {
      const r = await p.take(lot, price);
      if (p.me) rememberTaken(p.me, lot.id);
      setTake({ kind: "done", price, sig: r.signature, ms: r.ms });
    } catch (e) {
      setTake({ kind: "failed", price, reason: explainTake(e), sig: e instanceof TxError ? e.signature : undefined });
    }
  };

  const opened = isOpened(lot);
  const taken = isTaken(lot);

  return (
    <div className="wrap lot">
      <div className="lot-head">
        <Link href="/floor" className="back small mute">
          ← Floor
        </Link>
        <div className="lot-title">
          <h1 className="h1">Lot #{lot.id}</h1>
          <Badge tone={lot.origin === ORIGIN.HOUSE ? "plain" : "strong"}>{lot.origin === ORIGIN.HOUSE ? "House" : "Consigned"}</Badge>
        </div>
        <StatusLine lot={lot} source={source} />
      </div>

      <div className="room">
        <div className="room-main">
          <div className="o-1">
            <PricePanel lot={lot} />
          </div>
          {opened ? (
            <section className="panel o-2">
              <div className="panel-head">
                <h2>Inside</h2>
                <span className="small mute">valued at the oracle prices recorded at opening</span>
              </div>
              <Contents lot={lot} />
            </section>
          ) : null}
          <section className="panel o-4">
            <div className="panel-head">
              <h2>Facts</h2>
              <span className="small mute">
                <span className="num">{lot.hintsRevealed}</span>/5 disclosed by the enclave
              </span>
            </div>
            <Facts lot={lot} />
          </section>
          <div className="o-5">
            <FactsSay lot={lot} prices={prices} />
          </div>
        </div>
        <aside className="room-side">
          <div className="o-3">
            {lot.status === STATUS.LIVE ? (
              <TakePanel lot={lot} take={take} onTake={() => void onTake()} />
            ) : taken ? (
              <TakenPanel lot={lot} take={take} />
            ) : lot.status === STATUS.UNSOLD || lot.status === STATUS.EXPIRED ? (
              <UnsoldPanel lot={lot} />
            ) : (
              <section className="panel">
                <div className="panel-head">
                  <h2>Take it</h2>
                </div>
                <button type="button" className="take" disabled>
                  <Spinner /> {phase(lot, 0n)}
                </button>
                <p className="small mute take-note">The clock opens as soon as the seal is posted to Solana.</p>
              </section>
            )}
          </div>
          {opened ? (
            <div className="o-2b">
              <VerifiedPanel lot={lot} />
            </div>
          ) : null}
          <div className="o-6">
            <RecordPanel lot={lot} source={source} />
          </div>
        </aside>
      </div>
    </div>
  );
}

