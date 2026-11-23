"use client";
import { useLeaderboard, useWho } from "@/hooks/app";
import { usePlayerCtx } from "@/components/player";
import { Edge, Spinner, WhoLabel } from "@/components/ui";
import { int, usd } from "@/lib/format";

export function LeaderboardView() {
  const rows = useLeaderboard();
  const { me } = usePlayerCtx();
  const who = useWho(me);
  return (
    <div className="wrap">
      <h1 className="h1">Leaderboard</h1>
      <p className="lede">Everyone who took a lot, ranked by total edge: what the lots were worth when they opened, minus what the clock charged.</p>

      <div className="section-title">
        <h2>Players</h2>
        <span className="small mute">House bidders are labelled; they read the same public facts you do</span>
      </div>
      {rows === null ? (
        <p className="empty">
          <Spinner /> Reading the record…
        </p>
      ) : rows.length === 0 ? (
        <p className="small mute pad-y">Nobody has taken a lot yet in this session of the House.</p>
      ) : (
        <div className="table board">
          <div className="trow thead" aria-hidden>
            <span className="tcell">#</span>
            <span className="tcell">Player</span>
            <span className="tcell tnum">Lots</span>
            <span className="tcell tnum col-paid">Paid</span>
            <span className="tcell tnum col-worth">Worth</span>
            <span className="tcell tnum">Edge</span>
          </div>
          {rows.map((r, i) => {
            const w = who(r.address);
            return (
              <div key={r.address} className={`trow${w?.kind === "you" ? " is-you" : ""}`}>
                <span className="tcell rank num">{i + 1}</span>
                <span className="tcell">
                  <WhoLabel who={w} />
                </span>
                <span className="tcell tnum num">{int(r.lots)}</span>
                <span className="tcell tnum num col-paid">{usd(r.paid)}</span>
                <span className="tcell tnum num col-worth">{usd(r.value)}</span>
                <span className="tcell tnum">
                  <Edge micros={r.edge} />
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
