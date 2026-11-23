"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useEnclave } from "@/hooks/chain";
import { exportPlayerKey, explorerAddress } from "@/lib/chain";
import { short, usd } from "@/lib/format";
import { usePlayerCtx } from "@/components/player";
import { Copy, SigLink, Spinner } from "@/components/ui";

const LINKS: [string, string][] = [
  ["/floor", "Floor"],
  ["/studio", "Studio"],
  ["/collection", "Collection"],
  ["/leaderboard", "Leaderboard"],
  ["/verify", "Verify"],
];

function EnclaveStatus() {
  const s = useEnclave();
  const label = s === "attested" ? "Enclave attested" : s === "failed" ? "Enclave not attested" : "Checking enclave";
  const title =
    s === "attested"
      ? "The private rollup's Intel TDX quote checked out in this browser"
      : s === "failed"
        ? "This browser could not verify the private rollup's TDX quote"
        : "Verifying the private rollup's TDX quote";
  return (
    <span className={`enclave enclave-${s}`} title={title}>
      <span className="enclave-dot" aria-hidden />
      <span className="enclave-label">{label}</span>
    </span>
  );
}

function PlayerChip() {
  const p = usePlayerCtx();
  const usdc = p.holdings?.usdc;
  if (!p.me) return <span className="chip chip-quiet">…</span>;
  if (p.funding) {
    return (
      <span className="chip chip-busy" aria-live="polite">
        <Spinner />
        <span>{p.faucet.stage === "requesting" ? "Sending test USDC" : "Landing privately in the rollup"}</span>
      </span>
    );
  }
  if (usdc === 0n) {
    return (
      <button type="button" className="chip chip-cta" onClick={() => void p.fund()}>
        Get test USDC
      </button>
    );
  }
  return (
    <span className="chip" title={p.me}>
      <span className="num">{usdc === undefined ? "—" : usd(usdc).slice(1)}</span>
      <span className="chip-unit">tUSDC</span>
      <span className="chip-sep" aria-hidden />
      <span className="num mute">{short(p.me)}</span>
    </span>
  );
}

function Menu() {
  const p = usePlayerCtx();
  const [open, setOpen] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setShowKey(false);
      }
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (setOpen(false), setShowKey(false));
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button type="button" className="menu-btn" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((o) => !o)}>
        <span aria-hidden>•••</span>
        <span className="vh">Player menu</span>
      </button>
      {open ? (
        <div className="menu-pop" role="menu">
          <div className="menu-head">
            <span className="eyebrow">Player key in this browser</span>
            <span className="num menu-addr">{p.me ? short(p.me, 8) : "…"}</span>
            {p.me ? (
              <span className="menu-row">
                <Copy text={p.me} label="Copy address" />
                <a className="link-btn" href={explorerAddress(p.me)} target="_blank" rel="noreferrer">
                  Solana ↗
                </a>
              </span>
            ) : null}
          </div>
          {p.faucet.signature ? (
            <div className="menu-item-static">
              <span className="mute">Faucet transfer</span> <SigLink sig={p.faucet.signature} />
            </div>
          ) : null}
          {p.faucet.stage === "error" ? <div className="menu-item-static neg">{p.faucet.error}</div> : null}
          {!showKey ? (
            <button type="button" role="menuitem" className="menu-item" onClick={() => setShowKey(true)}>
              Export key
            </button>
          ) : (
            <div className="menu-key">
              <p className="small mute">Anyone holding this secret key controls this player. Devnet only.</p>
              <textarea readOnly className="key-box num" value={exportPlayerKey()} rows={4} onFocus={(e) => e.currentTarget.select()} />
              <Copy text={exportPlayerKey()} label="Copy secret key" />
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function Nav() {
  const path = usePathname();
  return (
    <header className="nav">
      <div className="nav-in">
        <Link href="/floor" className="wordmark">
          Penlight
        </Link>
        <nav className="nav-links" aria-label="Primary">
          {LINKS.map(([href, label]) => {
            const active = path === href || path.startsWith(`${href}/`) || (href === "/floor" && path.startsWith("/lot/"));
            return (
              <Link key={href} href={href} className={`nav-link${active ? " is-active" : ""}`} aria-current={active ? "page" : undefined}>
                {label}
              </Link>
            );
          })}
        </nav>
        <div className="nav-right">
          <EnclaveStatus />
          <PlayerChip />
          <Menu />
        </div>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="foot">
      <div className="foot-in">
        <span>Solana devnet · MagicBlock Private Ephemeral Rollup · VRF · Pyth Lazer prices</span>
      </div>
    </footer>
  );
}
