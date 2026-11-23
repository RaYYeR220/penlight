import { CATALOGUE, STATUS } from "./constants";
import { describe, holds, render, type Item } from "./facts";
import { commitment, priceAt, valueMicros } from "./math";
import { clockOf, type LotView, type Penlight } from "./client";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const symbols = CATALOGUE.map((c) => c.symbol);

function itemsAt(amounts: bigint[], prices: bigint[]): Item[] {
  return CATALOGUE.map((c, i) => ({
    present: amounts[i] > 0n,
    kind: c.kind,
    value: amounts[i] > 0n ? valueMicros(amounts[i], c.decimals, prices[i], c.expo) : 0n,
  }));
}

/**
 * Re-derives everything an opened lot claims from its own public record:
 * the seal, every fact, the price paid, and the value delivered.
 */
export function verifyLot(pl: Penlight, lot: LotView): Check[] {
  const checks: Check[] = [];
  const opened = ([STATUS.DELIVERED, STATUS.EXPIRED, STATUS.OPENED, STATUS.UNSOLD] as number[]).includes(lot.status);
  checks.push({ name: "lot is opened", ok: opened, detail: opened ? "contents, salt and seed are public" : `status ${lot.status}` });
  if (!opened) return checks;

  const c = commitment(lot.address, lot.salt, pl.mints, lot.amounts);
  const sealOk = Buffer.from(c).equals(Buffer.from(lot.commitment));
  checks.push({
    name: "seal matches contents",
    ok: sealOk,
    detail: `sha256(lot‖salt‖mints‖amounts) = ${Buffer.from(c).toString("hex").slice(0, 16)}… vs sealed ${Buffer.from(lot.commitment).toString("hex").slice(0, 16)}…`,
  });

  for (let i = 0; i < lot.hintsRevealed; i++) {
    const h = lot.hints[i];
    const items = itemsAt(lot.amounts, lot.hintPrices[i]);
    const f = render(lot.seed, i, items);
    const same = f.kind === h.kind && f.sym === h.sym && f.a === h.a && f.b === h.b;
    const true_ = holds({ kind: h.kind, sym: h.sym, a: h.a, b: h.b }, items);
    checks.push({
      name: `fact ${i + 1} re-derived`,
      ok: same && true_,
      detail: `"${describe({ kind: h.kind, sym: h.sym, a: h.a, b: h.b }, symbols)}" — ${same ? "same seed, same fact" : "DIFFERENT fact"}; ${true_ ? "true" : "FALSE"} for the contents`,
    });
  }

  if (lot.status === STATUS.DELIVERED || lot.status === STATUS.OPENED) {
    const p = priceAt(clockOf(lot), lot.soldSlot);
    checks.push({
      name: "paid the clock price",
      ok: p === lot.paid,
      detail: `price at rollup slot ${lot.soldSlot} = ${p}, paid ${lot.paid}`,
    });
  }

  const v = itemsAt(lot.amounts, lot.deliveryPrices).reduce((s, i) => s + i.value, 0n);
  checks.push({
    name: "value re-computed",
    ok: v === lot.valueAtDelivery,
    detail: `Σ amount × oracle price = ${v} micro-USD vs recorded ${lot.valueAtDelivery}`,
  });
  return checks;
}
