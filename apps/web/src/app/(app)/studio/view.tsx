"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { CATALOGUE, STATUS, TxError, commitment, sendAndConfirm } from "@penlight/sdk";
import { usePrices } from "@/hooks/app";
import { deployment, penlight, playerKey, rollupAsPlayer, rollupPublic } from "@/lib/chain";
import { house } from "@/lib/house";
import { hex, int, tokenAmount, usd, valueOf } from "@/lib/format";
import { usePlayerCtx } from "@/components/player";
import { AddrLink, SigLink, Spinner, TokenDot } from "@/components/ui";

const PENDING_KEY = "penlight.consign.v1";
const LENGTHS = [
  { s: 30, slots: 3000n },
  { s: 45, slots: 4500n },
  { s: 60, slots: 6000n },
];

/** A consignment between sealing and packing, kept so a reload can finish it. */
interface Pending {
  owner: string;
  id: number;
  salt: string;
  amounts: string[];
  startPrice: string;
  floorPrice: string;
  durationSlots: string;
  commitment: string;
  createSig?: string;
}

interface Run {
  step: number; // 1..5 active, 6 done
  error?: string;
  errorSig?: string;
  pending: Pending | null;
  packSig?: string;
  packMs?: number;
}

const unhex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const toMicros = (dollars: string) => {
  const n = Number(dollars);
  return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 1e6)) : 0n;
};
const centsStr = (micros: bigint) => (Number(micros / 10_000n) / 100).toFixed(2);

function loadPending(owner: string | null): Pending | null {
  try {
    const p = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null") as Pending | null;
    return p && p.owner === owner ? p : null;
  } catch {
    return null;
  }
}
function savePending(p: Pending | null) {
  try {
    if (p) localStorage.setItem(PENDING_KEY, JSON.stringify(p));
    else localStorage.removeItem(PENDING_KEY);
  } catch {
    /* storage unavailable: the flow still runs, it just can't resume after a reload */
  }
}

async function consign(p: Pending, set: (f: (r: Run) => Run) => void) {
  const pl = penlight();
  const k = playerKey();
  const houseAuthority = new PublicKey(deployment.houseAuthority);
  const salt = unhex(p.salt);
  const amounts = p.amounts.map((a) => BigInt(a));
  const pend = { ...p };
  const update = (step: number, extra: Partial<Run> = {}) => set((r) => ({ ...r, step, pending: { ...pend }, ...extra }));

  // 2. create on Solana + hand to the private rollup; the House pays the base-layer fees
  if (!pend.createSig) {
    update(2);
    for (let attempt = 0; ; attempt++) {
      const lot = pl.lotAddress(pend.id);
      const c = commitment(lot, salt, pl.mints, amounts);
      pend.commitment = hex(c);
      const tx = new Transaction().add(
        await pl.createLotIx({
          payer: houseAuthority,
          seller: k.publicKey,
          id: pend.id,
          commitment: c,
          startPrice: BigInt(pend.startPrice),
          floorPrice: BigInt(pend.floorPrice),
          durationSlots: BigInt(pend.durationSlots),
        }),
        await pl.delegateLotIx(houseAuthority, pend.id),
      );
      tx.feePayer = houseAuthority;
      tx.recentBlockhash = (await pl.base.getLatestBlockhash("confirmed")).blockhash;
      tx.partialSign(k);
      try {
        const r = await house.relay(tx.serialize({ requireAllSignatures: false }).toString("base64"));
        pend.createSig = r.signature;
        savePending(pend);
        break;
      } catch (e) {
        const err = e as Error & { status?: number };
        // Someone else's lot took this number in the meantime: seal again for the next one.
        if (attempt < 3 && /seed|0x7d6|already in use|custom program error: 0x0\b/i.test(err.message)) {
          pend.id = (await pl.houseState()).lotsCreated;
          savePending(pend);
          update(2);
          continue;
        }
        if (err.status === 403) throw new Error("The House relays lots only for players who used the faucet. Get test USDC first.");
        if (err.status === 429) throw new Error("The House has relayed its limit of lots for the hour. Your seal is kept; try again later.");
        if ((err.status ?? 0) >= 500) throw new Error(`The House couldn't relay the lot (it answered ${err.status}). Your seal is kept; try again shortly.`);
        throw err;
      }
    }
  }

  // 3. the keeper makes the seal private inside the enclave
  update(3);
  const address = pl.lotAddress(pend.id);
  for (let i = 0; ; i++) {
    const lot = await pl.fetchLot(rollupPublic(), address).catch(() => null);
    if (lot?.sealed) {
      if (lot.packed) {
        savePending(null);
        update(5);
        break;
      }
      // 4. pack: the tokens move into the lot's own accounts, checked against the seal
      update(4);
      const r = await sendAndConfirm(await rollupAsPlayer(), await pl.packIxs(k.publicKey, address, salt, amounts), [k], { label: "pack", timeoutMs: 20_000 });
      savePending(null);
      update(5, { packSig: r.signature, packMs: r.ms });
      break;
    }
    if (i > 180) throw new Error("The lot hasn't been sealed in the enclave yet. Resume in a minute.");
    await sleep(500);
  }

  // 5. the keeper requests the VRF seed and opens the clock
  for (let i = 0; i < 240; i++) {
    const lot = await pl.fetchLot(rollupPublic(), address).catch(() => null);
    if (lot && lot.status >= STATUS.LIVE) {
      update(6);
      return;
    }
    await sleep(500);
  }
}

const STEPS = [
  "Seal the contents",
  "Create the lot on Solana and hand it to the private rollup",
  "Seal made private inside the enclave",
  "Pack your tokens into the lot",
  "Seed drawn by VRF, clock opening",
];

function Steps({ run }: { run: Run }) {
  const p = run.pending;
  return (
    <ol className="steps">
      {STEPS.map((title, i) => {
        const n = i + 1;
        const state = run.error && run.step === n ? "is-failed" : run.step > n ? "is-done" : run.step === n ? "is-active" : "is-pending";
        return (
          <li key={title} className={`step ${state}`}>
            <span className="step-mark">{state === "is-done" ? "✓" : state === "is-failed" ? "✗" : n}</span>
            <div>
              <p className="step-title">
                {title} {state === "is-active" && !run.error ? <Spinner /> : null}
              </p>
              <div className="step-detail small">
                {n === 1 && p ? (
                  <span className="mute">
                    seal <span className="num">{p.commitment.slice(0, 16)}…</span> for lot #{p.id}
                  </span>
                ) : null}
                {n === 2 && p?.createSig ? (
                  <>
                    <SigLink sig={p.createSig} label="Solana" />
                    <span className="mute">fees paid by the House</span>
                  </>
                ) : null}
                {n === 3 && p && run.step >= 3 ? <AddrLink address={penlight().lotAddress(p.id).toBase58()} rollup label="lot account in the rollup" /> : null}
                {n === 4 && run.packSig ? (
                  <SigLink sig={run.packSig} rollup label={`rollup · ${int(run.packMs ?? 0)} ms`} />
                ) : null}
                {n === 5 && p && run.step >= 5 ? (
                  <Link href={`/lot/${p.id}`} className="inline-link">
                    {run.step >= 6 ? `Lot #${p.id} is live: open the lot room →` : `Lot #${p.id} room →`}
                  </Link>
                ) : null}
                {run.error && run.step === n ? (
                  <>
                    <span className="neg">{run.error}</span>
                    {run.errorSig ? <SigLink sig={run.errorSig} rollup label="refused tx" /> : null}
                  </>
                ) : null}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function StudioView() {
  const player = usePlayerCtx();
  const { prices } = usePrices();
  const h = player.holdings;
  const held = useMemo(() => (h ? CATALOGUE.map((c, i) => ({ c, i, balance: h.tokens[i] ?? 0n })).filter((r) => r.balance > 0n) : []), [h]);
  const [pct, setPct] = useState<Record<number, number>>({});
  const [length, setLength] = useState(1);
  const [start, setStart] = useState<string | null>(null);
  const [floor, setFloor] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [resume, setResume] = useState<Pending | null>(null);

  useEffect(() => {
    if (player.me) setResume(loadPending(player.me));
  }, [player.me]);

  const amounts = CATALOGUE.map((_, i) => {
    const r = held.find((x) => x.i === i);
    if (!r) return 0n;
    const p = pct[i] ?? 0;
    return p >= 100 ? r.balance : (r.balance * BigInt(p)) / 100n;
  });
  const value = prices ? amounts.reduce((s, a, i) => s + valueOf(i, a, prices[i]), 0n) : null;
  const startStr = start ?? (value ? centsStr((value * 14n) / 10n) : "");
  const floorStr = floor ?? (value ? centsStr((value * 3n) / 10n) : "");
  const startMicros = toMicros(startStr);
  const floorMicros = toMicros(floorStr);
  const empty = amounts.every((a) => a === 0n);
  const problem = empty
    ? "Pick at least one token to put in."
    : floorMicros <= 0n
      ? "Set a floor above zero."
      : startMicros <= floorMicros
        ? "The start price has to be above the floor."
        : null;
  const busy = run !== null && run.step < 6 && !run.error;

  const go = (from: Pending | null) => {
    const pending =
      from ??
      ((): Pending => {
        const salt = crypto.getRandomValues(new Uint8Array(32));
        return {
          owner: player.me!,
          id: -1,
          salt: hex(salt),
          amounts: amounts.map(String),
          startPrice: startMicros.toString(),
          floorPrice: floorMicros.toString(),
          durationSlots: LENGTHS[length].slots.toString(),
          commitment: "",
        };
      })();
    setResume(null);
    setRun({ step: 1, pending });
    void (async () => {
      try {
        if (pending.id < 0) {
          // 1. seal: sha256 over the lot address, salt, mints and amounts
          const pl = penlight();
          pending.id = (await pl.houseState()).lotsCreated;
          pending.commitment = hex(commitment(pl.lotAddress(pending.id), unhex(pending.salt), pl.mints, pending.amounts.map((a) => BigInt(a))));
          savePending(pending);
          setRun({ step: 1, pending: { ...pending } });
        }
        await consign(pending, (f) => setRun((r) => f(r ?? { step: 1, pending })));
        void player.refresh();
      } catch (e) {
        setRun((r) => ({
          ...(r ?? { step: 1, pending }),
          error: ((e as Error).message ?? String(e)).split("\n")[0].slice(0, 220),
          errorSig: e instanceof TxError ? e.signature : undefined,
        }));
      }
    })();
  };

  return (
    <div className="wrap">
      <h1 className="h1">Studio</h1>
      <p className="lede">
        Consign a lot from what you hold in the rollup. You choose what goes in and where the clock starts; the seal goes to Solana before the clock opens, and the enclave discloses facts about it on schedule.
      </p>

      {resume && !run ? (
        <div className="notice" style={{ marginTop: 24 }}>
          {resume.createSig ? `Lot #${resume.id} is on Solana but your tokens aren't packed yet.` : "A lot you sealed hasn't been created on Solana yet."}{" "}
          <button type="button" className="link-btn" onClick={() => go(resume)}>
            Finish it
          </button>{" "}
          ·{" "}
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              savePending(null);
              setResume(null);
            }}
          >
            Discard
          </button>
        </div>
      ) : null}

      <div className="studio">
        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>What goes in</h2>
              <span className="small mute">from your rollup balance</span>
            </div>
            {!h ? (
              <p className="small mute">
                <Spinner /> Opening your rollup session…
              </p>
            ) : held.length === 0 ? (
              <p className="small mute">
                You hold no tokens in the rollup yet. Take a lot on the <Link href="/floor" className="inline-link">Floor</Link>; whatever is inside becomes yours to consign here.
              </p>
            ) : (
              held.map(({ c, i, balance }) => {
                const p = pct[i] ?? 0;
                return (
                  <div className="pick" key={c.symbol}>
                    <span className="tok">
                      <TokenDot symbol={c.symbol} />
                      <span>{c.symbol}</span>
                    </span>
                    <div>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={p}
                        disabled={busy}
                        aria-label={`${c.symbol} share of your balance`}
                        onChange={(e) => setPct((x) => ({ ...x, [i]: Number(e.target.value) }))}
                      />
                      <div className="pick-quick small">
                        {[0, 50, 100].map((v) => (
                          <button key={v} type="button" className="link-btn" disabled={busy} onClick={() => setPct((x) => ({ ...x, [i]: v }))}>
                            {v === 0 ? "None" : v === 50 ? "Half" : "All"}
                          </button>
                        ))}
                        <span className="mute">
                          of <span className="num">{tokenAmount(balance, c.decimals)}</span>
                        </span>
                      </div>
                    </div>
                    <span className="pick-amt">
                      <span className="num">{tokenAmount(amounts[i], c.decimals)}</span>
                      <span className="small mute num">{prices ? usd(valueOf(i, amounts[i], prices[i])) : "…"}</span>
                    </span>
                  </div>
                );
              })
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>The clock</h2>
              <span className="small mute">falls every 10 ms block</span>
            </div>
            <div className="form-col">
              <div className="form-row">
                <label>
                  Start price ($)
                  <input className="field" inputMode="decimal" value={startStr} disabled={busy} onChange={(e) => setStart(e.target.value)} />
                </label>
                <label>
                  Floor price ($)
                  <input className="field" inputMode="decimal" value={floorStr} disabled={busy} onChange={(e) => setFloor(e.target.value)} />
                </label>
              </div>
              <div>
                <p className="small mute" style={{ marginBottom: 6 }}>
                  Clock length
                </p>
                <div className="seg" role="group" aria-label="Clock length">
                  {LENGTHS.map((l, i) => (
                    <button key={l.s} type="button" aria-pressed={length === i} disabled={busy} onClick={() => setLength(i)}>
                      {l.s} s
                    </button>
                  ))}
                </div>
              </div>
              <p className="small mute">
                Defaults start at 1.4× and floor at 0.3× today&apos;s value. Facts come out at 15, 30, 45, 60 and 75% of the clock; the seed decides which.
              </p>
            </div>
          </section>
        </div>

        <aside className="studio-side">
          <section className="panel">
            <div className="panel-head">
              <h2>Seal and consign</h2>
            </div>
            <dl className="kv small">
              <div>
                <dt>Value now</dt>
                <dd className="num">{value === null ? "…" : usd(value)}</dd>
              </div>
              <div>
                <dt>Clock</dt>
                <dd className="num">
                  {startMicros > 0n ? usd(startMicros) : "—"} → {floorMicros > 0n ? usd(floorMicros) : "—"} · {LENGTHS[length].s} s
                </dd>
              </div>
            </dl>
            <button
              type="button"
              className="take take-alt"
              style={{ marginTop: 16 }}
              disabled={busy || !!problem || !player.me || !!resume}
              onClick={() => go(null)}
            >
              {busy ? (
                <>
                  <Spinner /> Consigning…
                </>
              ) : (
                "Seal and consign"
              )}
            </button>
            <p className="small mute take-note">
              {problem && held.length > 0 ? problem : "The House pays the Solana fees to create your lot. You sign every step; the seal is checked against what you pack."}
            </p>
          </section>
          {run ? (
            <section className="panel">
              <div className="panel-head">
                <h2>Progress</h2>
                {run.pending && run.pending.id >= 0 ? <span className="small mute">lot #{run.pending.id}</span> : null}
              </div>
              <Steps run={run} />
              {run.error ? (
                <button type="button" className="btn btn-sm" style={{ marginTop: 12 }} onClick={() => go(run.pending)}>
                  Try again
                </button>
              ) : null}
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
