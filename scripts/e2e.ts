/**
 * End-to-end on devnet + the MagicBlock private rollup. Every step is a real
 * transaction; the run writes results/e2e-latest.json.
 *
 *   npx tsx scripts/e2e.ts
 */
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { transferSpl } from "@magicblock-labs/ephemeral-rollups-sdk";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  CATALOGUE,
  NETWORK,
  STATUS,
  TxError,
  clockOf,
  commitment,
  describe,
  hintSlot,
  priceAt,
  publicTeeConnection,
  sendAndConfirm,
  verifyLot,
  type LotView,
  type Penlight,
} from "@penlight/sdk";
import { ROOT, baseConnection, client, er, loadKeypair, loadOrCreateKeypair, log, sleep, waitFor } from "./lib.ts";

const base = baseConnection();
const pl = client(base);
const house = loadKeypair("keys/house.json");
const buyer = loadOrCreateKeypair("keys/e2e-buyer.json");
const buyer2 = loadOrCreateKeypair("keys/e2e-buyer2.json");
const outsider = loadOrCreateKeypair("keys/e2e-outsider.json");
const symbols = CATALOGUE.map((c) => c.symbol);
const record: Record<string, unknown> = { network: "devnet", program: pl.programId.toBase58(), startedAt: new Date().toISOString(), steps: [] as unknown[] };
const steps = record.steps as unknown[];
let failures = 0;

function step(name: string, data: Record<string, unknown>) {
  steps.push({ name, ...data });
  log(name, JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}

/** Anchor custom error numbers (6000 + position in PenlightError). */
const ERROR_CODES: Record<string, number[]> = {
  WrongStatus: [6002],
  BadAccounts: [6003],
  CommitmentMismatch: [6004],
  PriceAboveLimit: [6005],
  // The seller's payment account is also the destination, so Anchor's
  // duplicate-mutable-account rule (2040) can refuse it before our own check.
  SellerCannotTake: [6006, 2040],
  TooEarly: [6010],
};

async function expectError(name: string, code: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    failures++;
    step(`NEGATIVE ${name}`, { ok: false, expected: code, got: "success" });
  } catch (e) {
    const text = e instanceof TxError ? `${e.message}\n${(e.logs ?? []).join("\n")}` : String(e);
    const ok = text.includes(code) || ERROR_CODES[code].some((n) => text.includes(`"Custom":${n}`));
    if (!ok) failures++;
    step(`NEGATIVE ${name}`, { ok, expected: code, error: (e as Error).message?.slice(0, 120), signature: e instanceof TxError ? e.signature : undefined });
  }
}

async function faucet(to: PublicKey, usdc: number) {
  const ixs = await transferSpl(house.publicKey, to, pl.usdcMint, BigInt(usdc) * 1_000_000n, {
    visibility: "private",
    fromBalance: "base",
    toBalance: "ephemeral",
    validator: NETWORK.teeValidator,
    payer: house.publicKey,
  });
  const sig = await sendAndConfirmTransaction(base, new Transaction().add(...ixs), [house]);
  return sig;
}

async function erBalance(conn: Connection, owner: PublicKey, mint: PublicKey): Promise<bigint> {
  try {
    return BigInt((await conn.getTokenAccountBalance(pl.ata(owner, mint))).value.amount);
  } catch {
    return 0n;
  }
}

async function fetchEr(conn: Connection, lot: PublicKey) {
  return (await pl.fetchLot(conn, lot)) as LotView;
}

async function runLot(opts: {
  label: string;
  seller: Keypair;
  sellerEr: Connection;
  houseEr: Connection;
  buyer?: Keypair;
  buyerEr?: Connection;
  consign?: { amounts: bigint[] };
  durationSlots: bigint;
  takeAtHint?: number;
  negatives?: boolean;
}) {
  const { label, houseEr } = opts;
  const id = (await pl.houseState()).lotsCreated;
  const lot = pl.lotAddress(id);
  step(`${label}: lot address`, { id, lot: lot.toBase58() });

  // ── base layer: create + delegate ──
  let salt: Uint8Array | null = null;
  if (opts.consign) {
    salt = randomBytes(32);
    const c = commitment(lot, salt, pl.mints, opts.consign.amounts);
    const tx = new Transaction().add(
      await pl.createLotIx({ payer: house.publicKey, seller: opts.seller.publicKey, id, commitment: c, startPrice: 40_000_000n, floorPrice: 4_000_000n, durationSlots: opts.durationSlots }),
      await pl.delegateLotIx(house.publicKey, id),
    );
    const sig = await sendAndConfirmTransaction(base, tx, [house, opts.seller]);
    step(`${label}: create_lot + delegate (base)`, { sig, commitment: Buffer.from(c).toString("hex") });
  } else {
    const tx = new Transaction().add(
      await pl.createHouseLotIx({ authority: house.publicKey, id, startPrice: 60_000_000n, floorPrice: 6_000_000n, durationSlots: opts.durationSlots }),
      await pl.delegateLotIx(house.publicKey, id),
    );
    const sig = await sendAndConfirmTransaction(base, tx, [house]);
    step(`${label}: create_house_lot + delegate (base)`, { sig });
  }
  await waitFor("lot in rollup", async () => (await pl.fetchLot(houseEr, lot)) !== null, 30_000, 300);

  // ── rollup: seal permission ──
  const perm = await sendAndConfirm(houseEr, [await pl.sealPermissionIx(house.publicKey, lot)], [house], { label: "seal_permission" });
  step(`${label}: seal_permission`, { sig: perm.signature, ms: perm.ms });

  if (opts.consign && salt) {
    if (opts.negatives) {
      const wrong = [...opts.consign.amounts];
      const j = wrong.findIndex((a) => a > 0n);
      wrong[j] = wrong[j] - 1n;
      await expectError(`${label}: pack with contents that differ from the seal`, "CommitmentMismatch", async () =>
        sendAndConfirm(opts.sellerEr, await pl.packIxs(opts.seller.publicKey, lot, salt!, wrong), [opts.seller], { label: "pack" }),
      );
    }
    const r = await sendAndConfirm(opts.sellerEr, await pl.packIxs(opts.seller.publicKey, lot, salt, opts.consign.amounts), [opts.seller], { label: "pack" });
    step(`${label}: pack (seller)`, { sig: r.signature, ms: r.ms });
  }

  // ── VRF inside the enclave ──
  const vrf = await sendAndConfirm(houseEr, [await pl.openIx(house.publicKey, lot)], [house], { label: "open" });
  const t = Date.now();
  await waitFor("VRF callback", async () => (await fetchEr(houseEr, lot)).status === STATUS.SHUFFLED, 30_000, 50);
  step(`${label}: VRF requested in the rollup, callback landed`, { sig: vrf.signature, callbackMs: Date.now() - t });

  if (!opts.consign) {
    const r = await sendAndConfirm(houseEr, await pl.packFromPoolIxs(house.publicKey, lot), [house], { label: "pack_from_pool" });
    step(`${label}: pack_from_pool (contents drawn by the seed)`, { sig: r.signature, ms: r.ms });
  }

  const live = await sendAndConfirm(houseEr, [await pl.goLiveIx(house.publicKey, lot)], [house], { label: "go_live" });
  let view = await fetchEr(houseEr, lot);
  step(`${label}: go_live (seal committed to Solana)`, { sig: live.signature, openSlot: view.openSlot, commitment: Buffer.from(view.commitment).toString("hex") });

  if (opts.negatives && opts.buyer && opts.buyerEr) {
    await expectError(`${label}: take before the clock opens`, "TooEarly", async () =>
      sendAndConfirm(opts.buyerEr!, [await pl.takeIx(opts.buyer!.publicKey, lot, view.seller, 1_000_000_000n)], [opts.buyer!], { label: "take" }),
    );
    await expectError(`${label}: reveal before the first fact is due`, "TooEarly", async () =>
      sendAndConfirm(houseEr, await pl.revealIxs(house.publicKey, lot), [house], { label: "reveal" }),
    );
  }

  // ── privacy ──
  const pub = publicTeeConnection();
  const outsiderEr = await er(outsider);
  const sealSeen = await outsiderEr.getAccountInfo(pl.sealAddress(lot)).catch(() => null);
  const poolSeen = await outsiderEr.getAccountInfo(pl.poolAddress()).catch(() => null);
  const lotSeen = await pub.getAccountInfo(lot).catch(() => null);
  step(`${label}: privacy`, {
    outsiderReadsSeal: sealSeen ? `visible (${sealSeen.data.length} bytes, nonzero=${sealSeen.data.some((b) => b !== 0)})` : "hidden",
    outsiderReadsPoolLedger: poolSeen ? `visible (${poolSeen.data.length} bytes, nonzero=${poolSeen.data.some((b) => b !== 0)})` : "hidden",
    anyoneReadsLot: lotSeen ? "public" : "hidden",
  });

  // ── clock + facts ──
  const takeAt = opts.takeAtHint ?? -1;
  const factsToWait = opts.buyer ? Math.max(takeAt, 1) : 5;
  for (let i = 0; i < factsToWait; i++) {
    if (view.hintsRevealed > i) {
      const h = view.hints[i];
      step(`${label}: fact ${i + 1}`, { text: describe({ kind: h.kind, sym: h.sym, a: h.a, b: h.b }, symbols), slot: h.slot, note: "came out with the previous reveal" });
      continue;
    }
    const due = hintSlot(clockOf(view), i);
    await waitFor(`fact ${i + 1} due`, async () => (await houseEr.getSlot("confirmed")) >= Number(due), 120_000, 100);
    const r = await sendAndConfirm(houseEr, await pl.revealIxs(house.publicKey, lot), [house], { label: "reveal" });
    view = await fetchEr(houseEr, lot);
    const h = view.hints[i];
    step(`${label}: fact ${i + 1}`, { text: describe({ kind: h.kind, sym: h.sym, a: h.a, b: h.b }, symbols), slot: h.slot, sig: r.signature, ms: r.ms });
  }

  if (!opts.buyer || !opts.buyerEr) {
    // Nobody takes it: wait out the clock and the grace period.
    await waitFor("expiry", async () => {
      const s = BigInt(await houseEr.getSlot("confirmed"));
      return s >= view.openSlot + view.durationSlots + (view.durationSlots * 2000n) / 10_000n;
    }, 180_000, 200);
    const u = await sendAndConfirm(houseEr, await pl.unsealIxs(house.publicKey, lot), [house], { label: "unseal" });
    view = await fetchEr(houseEr, lot);
    step(`${label}: unsold, opened anyway`, { sig: u.signature, status: view.status, value: view.valueAtDelivery });
    const d = await sendAndConfirm(houseEr, await pl.deliverIxs(house.publicKey, view), [house], { label: "deliver" });
    view = await fetchEr(houseEr, lot);
    step(`${label}: returned`, { sig: d.signature, status: view.status });
  } else {
    const buyerEr = opts.buyerEr;
    const b = opts.buyer;
    if (opts.negatives) {
      const slot = BigInt(await buyerEr.getSlot("confirmed"));
      const p = priceAt(clockOf(view), slot);
      await expectError(`${label}: take with a limit under the clock price`, "PriceAboveLimit", async () =>
        sendAndConfirm(buyerEr, [await pl.takeIx(b.publicKey, lot, view.seller, p / 2n)], [b], { label: "take" }),
      );
      if (!opts.consign) {
        const houseView = view;
        await expectError(`${label}: the seller takes their own lot`, "SellerCannotTake", async () =>
          sendAndConfirm(houseEr, [await pl.takeIx(house.publicKey, lot, houseView.seller, 1_000_000_000n)], [house], { label: "take" }),
        );
      }
    }
    const before = await erBalance(buyerEr, b.publicKey, pl.usdcMint);
    const sendSlot = BigInt(await buyerEr.getSlot("processed"));
    const tk = await sendAndConfirm(buyerEr, [await pl.takeIx(b.publicKey, lot, view.seller, view.startPrice)], [b], { label: "take" });
    view = await fetchEr(buyerEr, lot);
    const after = await erBalance(buyerEr, b.publicKey, pl.usdcMint);
    step(`${label}: TAKE`, {
      sig: tk.signature,
      ms: tk.ms,
      paid: view.paid,
      soldSlot: view.soldSlot,
      slotsFromSendToLand: view.soldSlot - sendSlot,
      clockPriceAtThatSlot: priceAt(clockOf(view), view.soldSlot),
      buyerUsdcDelta: after - before,
    });

    const u = await sendAndConfirm(houseEr, await pl.unsealIxs(house.publicKey, lot), [house], { label: "unseal" });
    view = await fetchEr(houseEr, lot);
    const contents = view.amounts.map((a, i) => (a > 0n ? `${Number(a) / 10 ** CATALOGUE[i].decimals} ${symbols[i]}` : null)).filter(Boolean);
    step(`${label}: unseal`, {
      sig: u.signature,
      contents,
      valueUsd: Number(view.valueAtDelivery) / 1e6,
      paidUsd: Number(view.paid) / 1e6,
      edgeUsd: (Number(view.valueAtDelivery) - Number(view.paid)) / 1e6,
    });
    const d = await sendAndConfirm(houseEr, await pl.deliverIxs(house.publicKey, view), [house], { label: "deliver" });
    const got = await Promise.all(pl.mints.map((m) => erBalance(buyerEr, b.publicKey, m)));
    step(`${label}: deliver`, { sig: d.signature, ms: d.ms, buyerHolds: got.map((g, i) => (g > 0n ? `${symbols[i]}=${g}` : null)).filter(Boolean) });
  }

  const st = await sendAndConfirm(houseEr, [await pl.settleIx(house.publicKey, lot)], [house], { label: "settle" });
  const onBase = await waitFor("lot back on Solana", async () => pl.fetchLot(base, lot), 90_000, 1000);
  const checks = verifyLot(pl, onBase);
  checks.forEach((c) => {
    if (!c.ok) failures++;
  });
  step(`${label}: settled + verified from Solana`, { sig: st.signature, status: onBase.status, checks });
  return { lot, view: onBase };
}

async function main() {
  log("program", pl.programId.toBase58(), "house", pl.house.toBase58());
  // Tiny SOL for base-layer signatures the players make (seller of a consigned lot).
  for (const k of [buyer, buyer2, outsider]) {
    if ((await base.getBalance(k.publicKey)) < 0.005 * LAMPORTS_PER_SOL) {
      await sendAndConfirmTransaction(base, new Transaction().add(SystemProgram.transfer({ fromPubkey: house.publicKey, toPubkey: k.publicKey, lamports: 0.01 * LAMPORTS_PER_SOL })), [house]);
    }
  }
  const houseEr = await er(house);
  const buyerEr = await er(buyer);
  const buyer2Er = await er(buyer2);

  for (const [k, conn, name] of [[buyer, buyerEr, "buyer"], [buyer2, buyer2Er, "buyer2"]] as [Keypair, Connection, string][]) {
    if ((await erBalance(conn, k.publicKey, pl.usdcMint)) < 100_000_000n) {
      const sig = await faucet(k.publicKey, 500);
      await waitFor(`${name} faucet`, async () => (await erBalance(conn, k.publicKey, pl.usdcMint)) > 0n, 60_000, 500);
      step(`faucet: private transfer of 500 tUSDC into ${name}'s rollup balance`, { sig, balance: await erBalance(conn, k.publicKey, pl.usdcMint) });
    }
  }

  const a = await runLot({ label: "A house lot", seller: house, sellerEr: houseEr, houseEr, buyer, buyerEr, durationSlots: 3000n, takeAtHint: 3, negatives: true });

  // B: the winner flips what they won into a lot of their own.
  const won = a.view.amounts;
  await runLot({ label: "B consigned flip", seller: buyer, sellerEr: buyerEr, houseEr, buyer: buyer2, buyerEr: buyer2Er, consign: { amounts: won }, durationSlots: 2000n, takeAtHint: 2, negatives: true });

  // C: nobody takes it.
  await runLot({ label: "C unsold house lot", seller: house, sellerEr: houseEr, houseEr, durationSlots: 400n });

  record.finishedAt = new Date().toISOString();
  record.failures = failures;
  fs.mkdirSync(path.join(ROOT, "results"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "results/e2e-latest.json"), JSON.stringify(record, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  log(failures === 0 ? "ALL GREEN" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e, e?.logs);
  process.exit(1);
});
