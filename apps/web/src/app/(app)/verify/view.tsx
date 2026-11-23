"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useLots } from "@/hooks/chain";

export function VerifyView() {
  const router = useRouter();
  const [id, setId] = useState("");
  const lots = useLots(5000);
  const opened = (lots ?? []).filter((l) => l.opened).slice(0, 16);
  return (
    <div className="wrap">
      <h1 className="h1">Verify a lot</h1>
      <p className="lede">Every opened lot re-derives from its own public record. Nothing here trusts the House: it reads the lot account and recomputes.</p>
      <form
        className="verify-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (/^\d+$/.test(id.trim())) router.push(`/verify/${id.trim()}`);
        }}
      >
        <label className="vh" htmlFor="lot-id">
          Lot number
        </label>
        <input id="lot-id" className="field" inputMode="numeric" placeholder="Lot number, e.g. 12" value={id} onChange={(e) => setId(e.target.value)} />
        <button type="submit" className="btn btn-ink" disabled={!/^\d+$/.test(id.trim())}>
          Verify
        </button>
      </form>
      {opened.length > 0 ? (
        <div className="chips">
          {opened.map((l) => (
            <Link key={l.id} href={`/verify/${l.id}`} className="num">
              #{l.id}
            </Link>
          ))}
        </div>
      ) : null}

      <div className="verify-grid">
        <section className="panel">
          <div className="panel-head">
            <h2>What gets checked</h2>
          </div>
          <ul className="bullet small">
            <li>
              <b>The seal.</b> sha256 over the lot, its salt, every mint and every amount, against the commitment posted to Solana before the clock opened.
            </li>
            <li>
              <b>Every fact.</b> Re-rendered from the VRF seed, the contents and the oracle prices the enclave recorded when it disclosed it, and checked true.
            </li>
            <li>
              <b>The price paid.</b> The clock is a pure function of the rollup block: the price at the block the TAKE landed in must equal what was charged.
            </li>
            <li>
              <b>The value.</b> Each amount times the oracle price recorded at opening, summed, against the value on record.
            </li>
          </ul>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>From a terminal</h2>
          </div>
          <pre className="term num">{`npm install\nnpx penlight verify 12`}</pre>
          <p className="small mute" style={{ marginTop: 12 }}>
            The CLI reads the same record from Solana and runs the same checks with the same SDK, with no app in between.
          </p>
        </section>
      </div>
    </div>
  );
}
