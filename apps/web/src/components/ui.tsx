"use client";
import type { ReactNode } from "react";
import { HINT_AT_BPS, priceAt, type ClockParams } from "@penlight/sdk";
import { useRollupSlot } from "@/hooks/chain";
import { explorerAddress, explorerTx } from "@/lib/chain";
import { int, short, tokVar, usd } from "@/lib/format";
import type { Who } from "@/hooks/app";

// ── numbers whose changed digits roll ──
function Digit({ d, pos, instant }: { d: number; pos: number; instant: number }) {
  const ms = pos < instant ? 0 : pos === instant ? 90 : 260;
  return (
    <span className="roll-digit" aria-hidden>
      <span className="roll-strip" style={{ transform: `translateY(${-d * 10}%)`, transitionDuration: `${ms}ms` }}>
        {"0123456789".split("").map((n) => (
          <span key={n}>{n}</span>
        ))}
      </span>
    </span>
  );
}

/**
 * Renders `text` with each digit on its own strip, keyed from the right, so
 * only the digits whose value changed move. `instant` rightmost digits swap
 * without a transition (they change faster than a frame).
 */
export function Rolling({ text, instant = 0, className = "" }: { text: string; instant?: number; className?: string }) {
  const chars = text.split("");
  const n = chars.length;
  let digitPos = -1;
  const positions = chars.map((ch) => (ch >= "0" && ch <= "9" ? 1 : 0));
  // position among digits, counted from the right
  const fromRight: number[] = [];
  for (let i = n - 1; i >= 0; i--) {
    if (positions[i]) digitPos++;
    fromRight[i] = digitPos;
  }
  return (
    <span className={`roll num ${className}`}>
      <span className="vh">{text}</span>
      {chars.map((ch, i) => {
        const pos = n - 1 - i;
        if (positions[i]) return <Digit key={`d${pos}`} d={+ch} pos={fromRight[i]} instant={instant} />;
        return (
          <span key={`c${pos}`} className={ch === "." || ch === "," ? "roll-ch roll-punct" : "roll-ch"} aria-hidden>
            {ch}
          </span>
        );
      })}
    </span>
  );
}

/** The clock price, redrawn every frame from the estimated rollup block. */
export function LivePrice({ clock, className = "" }: { clock: ClockParams; className?: string }) {
  const slot = useRollupSlot(16);
  const p = slot === 0n ? clock.startPrice : priceAt(clock, slot);
  return <Rolling text={usd(p)} instant={1} className={className} />;
}

export function blockOf(clock: ClockParams, slot: bigint): bigint {
  if (slot <= clock.openSlot) return 0n;
  const e = slot - clock.openSlot;
  return e > clock.durationSlots ? clock.durationSlots : e;
}

/** "block 1,234 / 4,500" */
export function BlockCounter({ clock }: { clock: ClockParams }) {
  const slot = useRollupSlot(16);
  const b = blockOf(clock, slot);
  return (
    <span className="block-counter">
      block <Num>{int(b)}</Num> <span className="mute">/ {int(clock.durationSlots)}</span>
    </span>
  );
}

/** Progress hairline with a notch at each fact. `stopAt` freezes it (a sold lot). */
export function ClockBar({ clock, revealed, stopAt }: { clock: ClockParams; revealed: number; stopAt?: bigint }) {
  const live = useRollupSlot(50);
  const slot = stopAt && stopAt > 0n ? stopAt : live;
  const d = Number(clock.durationSlots) || 1;
  const frac = Math.min(1, Math.max(0, Number(blockOf(clock, slot)) / d));
  return (
    <div className="clockbar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(frac * 100)} aria-label="Clock progress">
      <div className="clockbar-fill" style={{ transform: `scaleX(${frac})` }} />
      {frac > 0 ? <span className="clockbar-head" style={{ left: `${frac * 100}%` }} /> : null}
      {HINT_AT_BPS.map((bps, i) => (
        <span key={bps} className={`clockbar-notch${i < revealed ? " is-out" : ""}`} style={{ left: `${bps / 100}%` }} />
      ))}
    </div>
  );
}

export function TokenDot({ symbol }: { symbol: string }) {
  return <span className="tokdot" style={{ background: tokVar(symbol) }} aria-hidden />;
}

export function SigLink({ sig, rollup = false, label }: { sig: string; rollup?: boolean; label?: string }) {
  return (
    <a className="sig" href={explorerTx(sig, rollup)} target="_blank" rel="noreferrer" title={sig}>
      {label ? <span className="sig-label">{label}</span> : null}
      <span className="num">{short(sig, 6)}</span>
      <span aria-hidden> ↗</span>
    </a>
  );
}

export function AddrLink({ address, rollup = false, label }: { address: string; rollup?: boolean; label?: ReactNode }) {
  return (
    <a className="sig" href={explorerAddress(address, rollup)} target="_blank" rel="noreferrer" title={address}>
      {label ?? <span className="num">{short(address)}</span>}
      <span aria-hidden> ↗</span>
    </a>
  );
}

export function WhoLabel({ who }: { who: Who | null }) {
  if (!who) return <span className="mute">—</span>;
  return (
    <span className={`who who-${who.kind}`} title={who.address}>
      <span className={who.kind === "player" ? "num" : undefined}>{who.label}</span>
      {who.detail ? <span className="who-detail">{who.detail}</span> : null}
    </span>
  );
}

export function Badge({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "strong" | "pos" | "neg" | "ink" }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

/** A mono figure whose "." and "," sit tight instead of taking a full cell. */
export function Num({ children, className = "" }: { children: string; className?: string }) {
  return (
    <span className={`num ${className}`}>
      {children.split(/([.,])/).map((part, i) =>
        part === "." || part === "," ? (
          <span key={i} className="punct">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </span>
  );
}

export function Edge({ micros }: { micros: bigint | string | null }) {
  if (micros === null) return <span className="mute">—</span>;
  const v = BigInt(micros);
  const sign = v > 0n ? "+" : v < 0n ? "−" : "";
  return <Num className={v >= 0n ? "pos" : "neg"}>{`${sign}${usd(v < 0n ? -v : v)}`}</Num>;
}

export function Spinner() {
  return <span className="spinner" aria-hidden />;
}

export function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  return (
    <button
      type="button"
      className="link-btn"
      onClick={(e) => {
        const el = e.currentTarget;
        void navigator.clipboard?.writeText(text).then(() => {
          el.textContent = "Copied";
          setTimeout(() => (el.textContent = label), 1400);
        });
      }}
    >
      {label}
    </button>
  );
}
