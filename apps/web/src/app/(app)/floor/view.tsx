"use client";
import Link from "next/link";
import { CATALOGUE, describe, type ClockParams } from "@penlight/sdk";
import { useFeed, useLots, usePresence, useRollupSlot } from "@/hooks/chain";
import { useBots, useNow, useStats, useWho, type Bot } from "@/hooks/app";
import { usePlayerCtx } from "@/components/player";
import { Badge, BlockCounter, ClockBar, Edge, LivePrice, SigLink, Spinner, WhoLabel } from "@/components/ui";
import { ago, int, short, usd } from "@/lib/format";
import type { ApiLot, FeedEvent } from "@/lib/house";

const symbols = CATALOGUE.map((c) => c.symbol);

export const apiClock = (l: ApiLot): ClockParams => ({
  startPrice: BigInt(l.startPrice),
  floorPrice: BigInt(l.floorPrice),
  openSlot: BigInt(l.openSlot),
  durationSlots: BigInt(l.durationSlots),
});

/** Transactions the House sends inside the private rollup; the rest land on Solana. */
const ROLLUP_KINDS = new Set(["vrf", "packed", "live", "fact", "opened", "unsold", "settled", "sold"]);

const OPENING_STATE: Record<number, string> = {
  0: "sealing in the enclave",
  1: "drawing the seed by VRF",
  2: "packing and posting the seal",
};

function OpensIn({ clock }: { clock: ClockParams }) {
  const slot = useRollupSlot(100);
  if (slot === 0n || slot >= clock.openSlot) return null;
  return <span className="small mute">opens in {int(clock.openSlot - slot)} blocks</span>;
}

function LiveCard({ lot }: { lot: ApiLot }) {
  const clock = apiClock(lot);
  const last = lot.hints[lot.hints.length - 1];
  return (
    <Link href={`/lot/${lot.id}`} className="lotcard">
      <div className="lotcard-top">
        <span className="lotcard-id">Lot #{lot.id}</span>
        <Badge tone={lot.origin === "house" ? "plain" : "strong"}>{lot.origin === "house" ? "House" : "Consigned"}</Badge>
        <span className="lotcard-facts small mute">
          <span className="num">{lot.hints.length}</span>/5 facts
        </span>
      </div>
      <LivePrice clock={clock} className="lotcard-price" />
      <ClockBar clock={clock} revealed={lot.hints.length} />
      <div className="lotcard-fact small">
        {last ? (
          <>
            <span className="mute">Latest fact · </span>
            {describe({ kind: last.kind, sym: last.sym, a: BigInt(last.a), b: BigInt(last.b) }, symbols)}
          </>
        ) : (
          <span className="mute">First fact at 15% of the clock</span>
        )}
      </div>
      <div className="lotcard-foot">
        <span className="small mute">
          <BlockCounter clock={clock} />
        </span>
        <OpensIn clock={clock} />
        <span className="enter">Enter →</span>
      </div>
    </Link>
  );
}

function RecentRow({ lot, who }: { lot: ApiLot; who: ReturnType<typeof useWho> }) {
  const sold = lot.winner !== null;
  return (
    <Link href={`/lot/${lot.id}`} className="trow recent-row">
      <span className="tcell recent-id">
        Lot #{lot.id}
        <span className="small mute recent-origin">{lot.origin === "house" ? "House" : "Consigned"}</span>
      </span>
      <span className="tcell tnum" data-label="Paid">
        {sold ? usd(lot.paid) : <span className="mute">not taken</span>}
      </span>
      <span className="tcell tnum" data-label="Worth">
        {lot.value !== null ? usd(lot.value) : <span className="mute">opening…</span>}
      </span>
      <span className="tcell tnum" data-label="Edge">
        <Edge micros={lot.edge} />
      </span>
      <span className="tcell recent-who" data-label="Taken by">
        {sold ? <WhoLabel who={who(lot.winner)} /> : <span className="mute">returned</span>}
      </span>
    </Link>
  );
}

function feedText(e: FeedEvent, bots: Bot[], me: string | null) {
  let t = e.text;
  for (const b of bots) t = t.replaceAll(short(b.address), `${b.name} (House bidder)`);
  if (me) t = t.replaceAll(short(me), "you");
  return t;
}

function Feed() {
  const events = useFeed(2000);
  const bots = useBots();
  const { me } = usePlayerCtx();
  const now = useNow(1000);
  return (
    <ol className="feed">
      {events.length === 0 ? <li className="feed-empty small mute">Every transaction on the floor shows up here.</li> : null}
      {events.slice(0, 24).map((e, i) => (
        <li key={`${e.at}-${i}`} className={`feed-item feed-${e.kind}`}>
          <span className="feed-time num">{ago(e.at, now)}</span>
          <span className="feed-body">
            {e.lot !== undefined ? (
              <Link href={`/lot/${e.lot}`} className="feed-text">
                {feedText(e, bots, me)}
              </Link>
            ) : (
              <span className="feed-text">{feedText(e, bots, me)}</span>
            )}
            {e.sig ? <SigLink sig={e.sig} rollup={ROLLUP_KINDS.has(e.kind)} label={ROLLUP_KINDS.has(e.kind) ? "rollup" : "Solana"} /> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function Stats() {
  const s = useStats();
  const items: [string, string][] = [
    ["Lots", s ? int(s.lotsCreated) : "—"],
    ["Sold", s ? int(s.sold) : "—"],
    ["Volume", s ? usd(s.volume) : "—"],
    ["Facts disclosed", s ? int(s.factsDisclosed) : "—"],
    ["Median TAKE", s?.takeMedianMs ? `${int(s.takeMedianMs)} ms` : "—"],
  ];
  return (
    <dl className="stats">
      {items.map(([k, v]) => (
        <div key={k} className="stat">
          <dt>{k}</dt>
          <dd className="num">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function FloorView() {
  usePresence();
  const lots = useLots(2000);
  const { me } = usePlayerCtx();
  const who = useWho(me);
  const live = (lots ?? []).filter((l) => l.statusCode === 3).sort((a, b) => a.id - b.id);
  const opening = (lots ?? []).filter((l) => l.statusCode <= 2);
  const recent = (lots ?? []).filter((l) => l.statusCode >= 4).slice(0, 14);

  return (
    <div className="wrap floor">
      <section className="floor-head">
        <div>
          <h1 className="h1">Floor</h1>
          <p className="lede">Sealed lots on a falling clock. Each fact narrows what&apos;s inside; the first TAKE pays that block&apos;s price and owns it.</p>
        </div>
        <Stats />
      </section>

      <div className="floor-grid">
        <div className="floor-main">
          <div className="section-title">
            <h2>Live</h2>
            <span className="small mute">{lots ? `${live.length} on the clock` : ""}</span>
          </div>

          {lots === null ? (
            <div className="empty">
              <Spinner /> <span>Reading the floor…</span>
            </div>
          ) : live.length === 0 && opening.length === 0 ? (
            <div className="empty">
              <Spinner />
              <div>
                <p>The House is opening a lot…</p>
                <p className="small mute">Lots appear within about ten seconds of someone being on the floor.</p>
              </div>
            </div>
          ) : (
            <div className="lotgrid">
              {live.map((l) => (
                <LiveCard key={l.id} lot={l} />
              ))}
            </div>
          )}

          {opening.length > 0 ? (
            <ul className="opening">
              {opening.map((l) => (
                <li key={l.id}>
                  <Link href={`/lot/${l.id}`} className="opening-row">
                    <Spinner />
                    <span>Lot #{l.id}</span>
                    <span className="mute">{OPENING_STATE[l.statusCode] ?? l.status}</span>
                    <Badge tone={l.origin === "house" ? "plain" : "strong"}>{l.origin === "house" ? "House" : "Consigned"}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="section-title">
            <h2>Recently opened</h2>
            <span className="small mute">paid · worth at opening · edge</span>
          </div>
          {recent.length === 0 ? (
            <p className="small mute pad-y">Opened lots, their contents and each buyer&apos;s edge land here.</p>
          ) : (
            <div className="table recent">
              <div className="trow thead" aria-hidden>
                <span className="tcell">Lot</span>
                <span className="tcell tnum">Paid</span>
                <span className="tcell tnum">Worth</span>
                <span className="tcell tnum">Edge</span>
                <span className="tcell">Taken by</span>
              </div>
              {recent.map((l) => (
                <RecentRow key={l.id} lot={l} who={who} />
              ))}
            </div>
          )}
        </div>

        <aside className="floor-feed">
          <div className="section-title">
            <h2>Activity</h2>
            <span className="small mute">signed, with receipts</span>
          </div>
          <Feed />
        </aside>
      </div>
    </div>
  );
}
