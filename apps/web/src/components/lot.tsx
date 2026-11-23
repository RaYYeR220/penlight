"use client";
import { useMemo } from "react";
import { CATALOGUE, STATUS, TxError, verifyLot, type Check, type LotView } from "@penlight/sdk";
import { penlight } from "@/lib/chain";
import { tokenAmount, unitPrice, usd, valueOf } from "@/lib/format";
import { Edge, TokenDot } from "@/components/ui";

export const OPENED: number[] = [STATUS.OPENED, STATUS.DELIVERED, STATUS.UNSOLD, STATUS.EXPIRED];
export const TAKEN: number[] = [STATUS.SOLD, STATUS.OPENED, STATUS.DELIVERED];
export const isOpened = (l: LotView) => OPENED.includes(l.status);
export const isTaken = (l: LotView) => TAKEN.includes(l.status);

/** What was inside, valued at the oracle prices recorded when it opened. */
export function Contents({ lot }: { lot: LotView }) {
  const rows = CATALOGUE.map((c, i) => ({ c, i, amount: lot.amounts[i] })).filter((r) => r.amount > 0n);
  const taken = isTaken(lot);
  return (
    <div className="contents">
      <div className="table">
        <div className="trow thead" aria-hidden>
          <span className="tcell">Token</span>
          <span className="tcell tnum">Amount</span>
          <span className="tcell tnum hide-sm">Oracle price</span>
          <span className="tcell tnum">Value</span>
        </div>
        {rows.map(({ c, i, amount }) => (
          <div className="trow" key={c.symbol}>
            <span className="tcell tok">
              <TokenDot symbol={c.symbol} />
              <span>{c.symbol}</span>
              <span className="small mute hide-sm">{c.name}</span>
            </span>
            <span className="tcell tnum num">{tokenAmount(amount, c.decimals)}</span>
            <span className="tcell tnum num mute hide-sm">{unitPrice(i, lot.deliveryPrices[i])}</span>
            <span className="tcell tnum num">{usd(valueOf(i, amount, lot.deliveryPrices[i]))}</span>
          </div>
        ))}
      </div>
      <dl className="sums">
        <div>
          <dt>Worth at opening</dt>
          <dd className="num">{usd(lot.valueAtDelivery)}</dd>
        </div>
        {taken ? (
          <>
            <div>
              <dt>Paid</dt>
              <dd className="num">{usd(lot.paid)}</dd>
            </div>
            <div className="sums-edge">
              <dt>Edge</dt>
              <dd>
                <Edge micros={lot.valueAtDelivery - lot.paid} />
              </dd>
            </div>
          </>
        ) : null}
      </dl>
    </div>
  );
}

export function useChecks(lot: LotView | null): Check[] | null {
  return useMemo(() => {
    if (!lot) return null;
    try {
      return verifyLot(penlight(), lot);
    } catch (e) {
      return [{ name: "re-derivation", ok: false, detail: (e as Error).message }];
    }
  }, [lot]);
}

export function CheckList({ checks, open = false }: { checks: Check[]; open?: boolean }) {
  return (
    <ul className="checks">
      {checks.map((c) => (
        <li key={c.name} className={c.ok ? "is-ok" : "is-bad"}>
          <details open={open}>
            <summary>
              <span className="check-mark" aria-hidden>
                {c.ok ? "✓" : "✗"}
              </span>
              <span className="check-name">{c.name[0].toUpperCase() + c.name.slice(1)}</span>
              <span className="vh">{c.ok ? "passed" : "failed"}</span>
            </summary>
            <p className="check-detail num">{c.detail}</p>
          </details>
        </li>
      ))}
    </ul>
  );
}

/** Plain-language reason a TAKE was refused, from the program's error. */
export function explainTake(e: unknown): string {
  const t = e instanceof TxError ? `${e.message}\n${(e.logs ?? []).join("\n")}` : String((e as Error)?.message ?? e);
  if (/WrongStatus|"Custom":6002\b|0x1772/.test(t)) return "Refused: someone else's TAKE landed first. Nothing was charged.";
  if (/PriceAboveLimit|"Custom":6005\b|0x1775/.test(t)) return "Refused: the clock was above your limit in the block it landed in. Nothing was charged.";
  if (/SellerCannotTake|"Custom":6006\b|0x1776|"Custom":2040\b|0x7f8/.test(t)) return "Refused: a seller can't take their own lot.";
  if (/TooEarly|"Custom":6010\b|0x177a/.test(t)) return "Refused: the clock hadn't opened yet.";
  if (/insufficient funds|"Custom":1\}/.test(t)) return "Refused: not enough test USDC at this price.";
  if (/not confirmed in time/.test(t)) return "No confirmation within 15 s. The signature shows what happened.";
  return t.split("\n")[0].slice(0, 180);
}
