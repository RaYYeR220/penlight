/**
 * The keeper walks every unfinished lot through its lifecycle. Every step it
 * takes is permissionless on-chain; the keeper only saves players the clicks.
 */
import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { CATALOGUE, ORIGIN, STATUS, describe, hintsDue, clockOf, expirySlot, sendAndConfirm, decodeLot, type LotView } from "@penlight/sdk";
import { base, config, house, houseEr, log, pl, short, store } from "./context.js";

const symbols = CATALOGUE.map((c) => c.symbol);
const inFlight = new Set<number>();
const failures = new Map<number, number>();
let lowestOpen = 0;
let created = 0;
let erSlot = 0n;

export function currentSlot() {
  return erSlot;
}

async function act(id: number, label: string, fn: () => Promise<{ signature: string }>) {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  try {
    const r = await fn();
    failures.delete(id);
    return r;
  } catch (e) {
    const n = (failures.get(id) ?? 0) + 1;
    failures.set(id, n);
    if (n % 10 === 1) log(`lot ${id} ${label} failed (${n}):`, (e as Error).message?.slice(0, 160));
  } finally {
    inFlight.delete(id);
  }
}

async function step(lot: LotView) {
  const id = lot.id;
  const er = await houseEr.get();
  const payer = house.publicKey;
  switch (lot.status) {
    case STATUS.CREATED:
      if (!lot.sealed) {
        await act(id, "seal", async () => sendAndConfirm(er, [await pl.sealPermissionIx(payer, lot.address)], [house], { label: "seal_permission" }));
      } else if (lot.origin === ORIGIN.HOUSE || lot.packed) {
        const r = await act(id, "open", async () => sendAndConfirm(er, [await pl.openIx(payer, lot.address)], [house], { label: "open" }));
        if (r) store.event({ kind: "vrf", lot: id, text: `Lot #${id}: seed requested from the VRF oracle inside the enclave`, sig: r.signature });
      }
      return;
    case STATUS.SHUFFLED:
      if (!lot.packed && lot.origin === ORIGIN.HOUSE) {
        const r = await act(id, "pack", async () => sendAndConfirm(er, await pl.packFromPoolIxs(payer, lot.address), [house], { label: "pack_from_pool" }));
        if (r) store.event({ kind: "packed", lot: id, text: `Lot #${id}: packed by the seed from the House pool`, sig: r.signature });
      } else if (lot.packed) {
        const r = await act(id, "go_live", async () => sendAndConfirm(er, [await pl.goLiveIx(payer, lot.address)], [house], { label: "go_live" }));
        if (r) store.event({ kind: "live", lot: id, text: `Lot #${id}: seal posted to Solana, clock opening`, sig: r.signature });
      }
      return;
    case STATUS.LIVE: {
      const c = clockOf(lot);
      if (erSlot >= expirySlot(c)) {
        await act(id, "unseal", async () => sendAndConfirm(er, await pl.unsealIxs(payer, lot.address), [house], { label: "unseal" }));
        return;
      }
      if (hintsDue(c, erSlot) > lot.hintsRevealed) {
        const r = await act(id, "reveal", async () => sendAndConfirm(er, await pl.revealIxs(payer, lot.address), [house], { label: "reveal" }));
        if (r) {
          const fresh = await pl.fetchLot(er, lot.address);
          if (fresh) {
            for (let i = lot.hintsRevealed; i < fresh.hintsRevealed; i++) {
              const h = fresh.hints[i];
              store.event({ kind: "fact", lot: id, text: `Lot #${id}: ${describe({ kind: h.kind, sym: h.sym, a: h.a, b: h.b }, symbols)}`, sig: r.signature });
            }
            store.lots.set(id, fresh);
          }
        }
      }
      return;
    }
    case STATUS.SOLD: {
      store.event({ kind: "sold", lot: id, text: `Lot #${id}: taken by ${short(lot.winner)} for $${(Number(lot.paid) / 1e6).toFixed(2)} on rollup block ${lot.soldSlot}` });
      await act(id, "unseal", async () => sendAndConfirm(er, await pl.unsealIxs(payer, lot.address), [house], { label: "unseal" }));
      return;
    }
    case STATUS.OPENED:
    case STATUS.UNSOLD: {
      const r = await act(id, "deliver", async () => sendAndConfirm(er, await pl.deliverIxs(payer, lot), [house], { label: "deliver" }));
      if (r && lot.status === STATUS.OPENED) {
        const edge = Number(lot.valueAtDelivery - lot.paid) / 1e6;
        store.event({ kind: "opened", lot: id, text: `Lot #${id} opened: worth $${(Number(lot.valueAtDelivery) / 1e6).toFixed(2)}, paid $${(Number(lot.paid) / 1e6).toFixed(2)}, edge ${edge >= 0 ? "+" : "−"}$${Math.abs(edge).toFixed(2)}`, sig: r.signature });
      } else if (r) {
        store.event({ kind: "unsold", lot: id, text: `Lot #${id}: nobody took it; opened and returned`, sig: r.signature });
      }
      return;
    }
    case STATUS.DELIVERED:
    case STATUS.EXPIRED: {
      const r = await act(id, "settle", async () => sendAndConfirm(er, [await pl.settleIx(payer, lot.address)], [house], { label: "settle" }));
      if (r) store.event({ kind: "settled", lot: id, text: `Lot #${id}: final record committed to Solana`, sig: r.signature });
      return;
    }
  }
}

/** One pass over every lot that is not finished yet. */
export async function tick() {
  const er = await houseEr.get();
  const state = await pl.houseState();
  created = state.lotsCreated;
  erSlot = BigInt(await er.getSlot("confirmed"));
  while (store.finished.has(lowestOpen) && lowestOpen < created) lowestOpen++;
  const ids: number[] = [];
  for (let id = lowestOpen; id < created; id++) if (!store.finished.has(id)) ids.push(id);
  if (!ids.length) return;

  const addrs = ids.map((id) => pl.lotAddress(id));
  const [erInfos, baseInfosAll] = await Promise.all([
    er.getMultipleAccountsInfo(addrs, "confirmed"),
    base.getMultipleAccountsInfo(addrs, "confirmed"),
  ]);
  const missing: number[] = [];
  erInfos.forEach((acc, j) => {
    const id = ids[j];
    // Owned by the program on Solana = not delegated (never was, or settled back).
    const onBase = baseInfosAll[j]?.owner.equals(pl.programId);
    if (acc && acc.owner.equals(pl.programId) && !onBase) {
      const lot = decodeLot(addrs[j], acc.data);
      store.lots.set(id, lot);
      void step(lot);
    } else missing.push(j);
  });
  if (missing.length) {
    // Not in the rollup: either not delegated yet, or settled back to Solana.
    missing.forEach((j) => {
      const acc = baseInfosAll[j];
      const id = ids[j];
      if (!acc) return;
      if (acc.owner.equals(pl.programId)) {
        const lot = decodeLot(addrs[j], acc.data);
        store.lots.set(id, lot);
        if (lot.status === STATUS.DELIVERED || lot.status === STATUS.EXPIRED) {
          store.finished.add(id);
          store.save();
        } else if (lot.status === STATUS.CREATED) {
          // Created but never delegated (a dropped relay). Delegate it so it can proceed.
          void act(id, "delegate", async () => ({ signature: await sendAndConfirmTransaction(base, new Transaction().add(await pl.delegateLotIx(house.publicKey, id)), [house]) }));
        }
      }
    });
  }
}

/**
 * On start, read every finished lot's final record from Solana so the floor,
 * the feed and the leaderboard keep their history across restarts.
 */
export async function backfill() {
  const created = (await pl.houseState()).lotsCreated;
  const ids = Array.from({ length: created }, (_, i) => i);
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const addrs = chunk.map((id) => pl.lotAddress(id));
    const infos = await base.getMultipleAccountsInfo(addrs, "confirmed");
    infos.forEach((acc, j) => {
      if (!acc || !acc.owner.equals(pl.programId)) return;
      const lot = decodeLot(addrs[j], acc.data);
      if (lot.status === STATUS.DELIVERED || lot.status === STATUS.EXPIRED) {
        store.lots.set(chunk[j], lot);
        store.finished.add(chunk[j]);
      }
    });
  }
  store.save();
  log(`backfilled ${store.lots.size} finished lots from Solana`);
}

export async function createHouseLot() {
  const id = (await pl.houseState()).lotsCreated;
  const tx = new Transaction().add(
    await pl.createHouseLotIx({ authority: house.publicKey, id, startPrice: config.startPrice, floorPrice: config.floorPrice, durationSlots: config.lotDurationSlots }),
    await pl.delegateLotIx(house.publicKey, id),
  );
  const sig = await sendAndConfirmTransaction(base, tx, [house]);
  store.lotTimes.push(Date.now());
  store.event({ kind: "created", lot: id, text: `Lot #${id} created on Solana and handed to the private rollup`, sig });
  log(`created house lot ${id}`);
  return id;
}

/** Keep `targetLive` House lots on the floor while someone is watching. */
export async function schedule() {
  if (!store.floorActive()) return;
  const hourAgo = Date.now() - 3_600_000;
  store.lotTimes = store.lotTimes.filter((t) => t > hourAgo);
  if (store.lotTimes.length >= config.maxLotsPerHour) return;
  let open = 0;
  for (const [id, lot] of store.lots) {
    if (store.finished.has(id) || lot.origin !== ORIGIN.HOUSE) continue;
    if (lot.status <= STATUS.LIVE) open++;
  }
  const last = store.lotTimes[store.lotTimes.length - 1] ?? 0;
  if (open < config.targetLive && Date.now() - last > 12_000) await createHouseLot();
}
