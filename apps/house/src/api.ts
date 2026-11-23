import { Hono } from "hono";
import { cors } from "hono/cors";
import { PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { transferSpl } from "@magicblock-labs/ephemeral-rollups-sdk";
import { NETWORK, STATUS, STATUS_NAME, type LotView } from "@penlight/sdk";
import { base, config, deployment, house, log, pl, store } from "./context.js";
import { botName, bots } from "./bots.js";

export const app = new Hono();
app.use("*", cors());

const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));

function lotJson(l: LotView) {
  const winner = l.winner.toBase58();
  const opened = [STATUS.OPENED, STATUS.DELIVERED, STATUS.UNSOLD, STATUS.EXPIRED].includes(l.status as never);
  return json({
    id: l.id,
    address: l.address.toBase58(),
    origin: l.origin === 1 ? "house" : "consigned",
    seller: l.seller.toBase58(),
    status: STATUS_NAME[l.status] ?? String(l.status),
    statusCode: l.status,
    startPrice: l.startPrice,
    floorPrice: l.floorPrice,
    openSlot: l.openSlot,
    durationSlots: l.durationSlots,
    commitment: Buffer.from(l.commitment).toString("hex"),
    hints: l.hints.slice(0, l.hintsRevealed),
    hintPrices: l.hintPrices.slice(0, l.hintsRevealed),
    winner: l.status >= STATUS.SOLD && l.status !== STATUS.EXPIRED && l.status !== STATUS.UNSOLD ? winner : null,
    winnerName: botName(winner),
    paid: l.paid,
    soldSlot: l.soldSlot,
    opened,
    amounts: opened ? l.amounts : null,
    value: opened ? l.valueAtDelivery : null,
    edge: opened && l.paid > 0n ? l.valueAtDelivery - l.paid : null,
    seed: opened ? Buffer.from(l.seed).toString("hex") : null,
    salt: opened ? Buffer.from(l.salt).toString("hex") : null,
  });
}

app.get("/api/health", (c) => c.json({ ok: true, program: deployment.programId, floorActive: store.floorActive() }));
app.get("/api/deployment", (c) => c.json({ ...deployment, teeValidator: NETWORK.teeValidator.toBase58(), bots: bots.map((b) => ({ name: b.name, style: b.style, address: b.key.publicKey.toBase58() })) }));

app.get("/api/lots", (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 40), 200);
  const lots = [...store.lots.values()].sort((a, b) => b.id - a.id).slice(0, limit);
  return c.json(lots.map(lotJson));
});

app.get("/api/lots/:id", (c) => {
  const l = store.lots.get(Number(c.req.param("id")));
  return l ? c.json(lotJson(l)) : c.json({ error: "not found" }, 404);
});

app.get("/api/leaderboard", (c) => {
  const rows = new Map<string, { address: string; name: string | null; lots: number; paid: bigint; value: bigint; edge: bigint }>();
  for (const l of store.lots.values()) {
    if (l.status !== STATUS.DELIVERED && l.status !== STATUS.OPENED) continue;
    const k = l.winner.toBase58();
    const r = rows.get(k) ?? { address: k, name: botName(k), lots: 0, paid: 0n, value: 0n, edge: 0n };
    r.lots++;
    r.paid += l.paid;
    r.value += l.valueAtDelivery;
    r.edge += l.valueAtDelivery - l.paid;
    rows.set(k, r);
  }
  return c.json(json([...rows.values()].sort((a, b) => (b.edge > a.edge ? 1 : b.edge < a.edge ? -1 : 0))));
});

app.get("/api/events", (c) => {
  const since = Number(c.req.query("since") ?? 0);
  return c.json(store.events.filter((e) => e.at > since).slice(-100));
});

app.get("/api/stats", (c) => {
  const lots = [...store.lots.values()];
  const sold = lots.filter((l) => l.status === STATUS.DELIVERED || l.status === STATUS.OPENED);
  const lat = [...store.takeLatencies].sort((a, b) => a - b);
  return c.json(
    json({
      lotsCreated: lots.length ? Math.max(...lots.map((l) => l.id)) + 1 : 0,
      sold: sold.length,
      volume: sold.reduce((s, l) => s + l.paid, 0n),
      factsDisclosed: lots.reduce((s, l) => s + l.hintsRevealed, 0),
      takeMedianMs: lat.length ? lat[Math.floor(lat.length / 2)] : null,
    }),
  );
});

app.post("/api/presence", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = String(body.id ?? "").slice(0, 64);
  if (id) store.presence.set(id, Date.now());
  return c.json({ active: store.floorActive() });
});

// ── faucet: a private transfer of test USDC into the caller's rollup balance ──
app.post("/api/faucet", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  let owner: PublicKey;
  try {
    owner = new PublicKey(String(body.owner));
  } catch {
    return c.json({ error: "owner must be a public key" }, 400);
  }
  const k = owner.toBase58();
  if (store.faucetGiven[k] && Date.now() - store.faucetGiven[k] < 6 * 3_600_000) return c.json({ error: "already funded", fundedAt: store.faucetGiven[k] }, 409);
  const hourAgo = Date.now() - 3_600_000;
  store.faucetTimes = store.faucetTimes.filter((t) => t > hourAgo);
  if (store.faucetTimes.length >= config.faucetPerHour) return c.json({ error: "faucet is busy, try again in a few minutes" }, 429);
  store.faucetTimes.push(Date.now());
  // Claim the slot before awaiting, so parallel requests for one owner can't all pass.
  store.faucetGiven[k] = Date.now();
  try {
    const ixs = await transferSpl(house.publicKey, owner, pl.usdcMint, config.faucetUsdc * 1_000_000n, {
      visibility: "private",
      fromBalance: "base",
      toBalance: "ephemeral",
      validator: NETWORK.teeValidator,
      payer: house.publicKey,
    });
    const signature = await sendAndConfirmTransaction(base, new Transaction().add(...ixs), [house]);
    store.faucetGiven[k] = Date.now();
    store.save();
    store.event({ kind: "faucet", text: `Private transfer of ${config.faucetUsdc} test USDC into a new player's rollup balance`, sig: signature });
    return c.json({ signature, amount: config.faucetUsdc.toString() });
  } catch (e) {
    delete store.faucetGiven[k];
    log("faucet failed", (e as Error).message);
    return c.json({ error: "faucet transfer failed" }, 502);
  }
});

// ── relay: the House pays base-layer fees for a player's consign transaction ──
// Anchor's Program camelCases instruction names; accept either spelling.
const DISC = (name: string) => {
  const camel = name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  const ix = pl.program.idl.instructions.find((i) => i.name === name || i.name === camel) as { discriminator: number[] } | undefined;
  if (!ix) throw new Error(`instruction ${name} not in IDL`);
  return Buffer.from(ix.discriminator);
};
const relayTimes = new Map<string, number[]>();
let relayGlobal: number[] = [];
const RELAY_PER_CLIENT_HOUR = 20;
const RELAY_GLOBAL_HOUR = 40;

app.post("/api/relay", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  // The proxy in front of the House appends the real client address last.
  const ip = c.req.header("x-forwarded-for")?.split(",").pop()?.trim() || "local";
  const hourAgo = Date.now() - 3_600_000;
  const mine = (relayTimes.get(ip) ?? []).filter((t) => t > hourAgo);
  relayGlobal = relayGlobal.filter((t) => t > hourAgo);
  if (mine.length >= RELAY_PER_CLIENT_HOUR || relayGlobal.length >= RELAY_GLOBAL_HOUR) return c.json({ error: "relay limit reached" }, 429);
  // Every attempt counts against the caller; only valid ones against the global budget.
  mine.push(Date.now());
  relayTimes.set(ip, mine);
  let tx: Transaction;
  try {
    tx = Transaction.from(Buffer.from(String(body.tx), "base64"));
  } catch {
    return c.json({ error: "bad transaction" }, 400);
  }
  if (!tx.feePayer?.equals(house.publicKey)) return c.json({ error: "fee payer must be the House" }, 400);
  // Exactly [create_lot, delegate_lot] and nothing else: no compute-budget or
  // priority-fee instructions, so the House's cost is the fixed rent and base fee.
  const create = DISC("create_lot");
  const delegate = DISC("delegate_lot");
  const ixs = tx.instructions;
  if (ixs.length !== 2 || !ixs.every((ix) => ix.programId.equals(pl.programId))) return c.json({ error: "only [create_lot, delegate_lot] is relayed" }, 400);
  const [ci, di] = ixs;
  if (!ci.data.subarray(0, 8).equals(create) || !di.data.subarray(0, 8).equals(delegate)) return c.json({ error: "only [create_lot, delegate_lot] is relayed" }, 400);
  // create_lot: payer = House, seller = a different signer. delegate_lot: payer = House, same lot.
  if (!ci.keys[0].pubkey.equals(house.publicKey) || ci.keys[1].pubkey.equals(house.publicKey)) return c.json({ error: "bad create_lot accounts" }, 400);
  if (!di.keys[0].pubkey.equals(house.publicKey) || !di.keys[2].pubkey.equals(ci.keys[3].pubkey)) return c.json({ error: "bad delegate_lot accounts" }, 400);
  // Only players who came in through the faucet can have the House pay for a lot.
  if (!store.faucetGiven[ci.keys[1].pubkey.toBase58()]) return c.json({ error: "get test USDC from the faucet first" }, 403);
  relayGlobal.push(Date.now());
  try {
    tx.partialSign(house);
    if (!tx.verifySignatures()) return c.json({ error: "missing signatures" }, 400);
    const signature = await base.sendRawTransaction(tx.serialize());
    await base.confirmTransaction(signature, "confirmed");
    store.event({ kind: "consigned", text: "A player consigned a lot of their own", sig: signature });
    return c.json({ signature });
  } catch (e) {
    return c.json({ error: (e as Error).message.slice(0, 200) }, 502);
  }
});

// ── withdrawal sponsor: a little devnet SOL so a browser player can pay the
//    base-layer fees of moving what they WON out of the rollup to Solana ──
const sponsorByIp = new Map<string, number[]>();
let sponsorTimes: number[] = [];
app.post("/api/sponsor-withdraw", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  let owner: PublicKey;
  try {
    owner = new PublicKey(String(body.owner));
  } catch {
    return c.json({ error: "owner must be a public key" }, 400);
  }
  const k = owner.toBase58();
  const ip = c.req.header("x-forwarded-for")?.split(",").pop()?.trim() || "local";
  const hourAgo = Date.now() - 3_600_000;
  const mine = (sponsorByIp.get(ip) ?? []).filter((t) => t > hourAgo);
  sponsorTimes = sponsorTimes.filter((t) => t > hourAgo);
  if (mine.length >= 3 || sponsorTimes.length >= 20) return c.json({ error: "sponsor is busy, try again later" }, 429);
  if (Date.now() - (store.sponsored[k] ?? 0) < 12 * 3_600_000) return c.json({ error: "already sponsored recently" }, 409);
  // Only for tokens this player actually won: count the kinds across their delivered lots.
  const kinds = new Set<number>();
  for (const l of store.lots.values()) {
    if (l.status !== STATUS.DELIVERED || !l.winner.equals(owner)) continue;
    l.amounts.forEach((a, i) => a > 0n && kinds.add(i));
  }
  if (kinds.size === 0) return c.json({ error: "nothing won to withdraw yet" }, 403);
  // Claim every limit before the first await, so parallel requests can't slip through.
  const now = Date.now();
  store.sponsored[k] = now;
  mine.push(now);
  sponsorByIp.set(ip, mine);
  sponsorTimes.push(now);
  const release = () => {
    delete store.sponsored[k];
    mine.splice(mine.indexOf(now), 1);
    sponsorTimes.splice(sponsorTimes.indexOf(now), 1);
  };
  if ((await base.getBalance(house.publicKey)) < 500_000_000) {
    release();
    return c.json({ error: "sponsor is out of devnet SOL for now" }, 503);
  }
  store.save();
  const lamports = kinds.size * 5_000_000 + 1_000_000;
  try {
    const { SystemProgram } = await import("@solana/web3.js");
    const signature = await sendAndConfirmTransaction(base, new Transaction().add(SystemProgram.transfer({ fromPubkey: house.publicKey, toPubkey: owner, lamports })), [house]);
    return c.json({ signature, lamports, kinds: kinds.size });
  } catch (e) {
    release();
    store.save();
    return c.json({ error: (e as Error).message.slice(0, 160) }, 502);
  }
});
