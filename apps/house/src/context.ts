import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NETWORK, Penlight, keypairSigner, teeConnection, type Deployment, type LotView } from "@penlight/sdk";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env = (k: string, d: string) => process.env[k] ?? d;

export const config = {
  port: Number(env("PORT", "8787")),
  houseKey: env("HOUSE_KEY", path.join(ROOT, "keys/house.json")),
  botDir: env("BOT_DIR", path.join(ROOT, "keys/bots")),
  dataDir: env("DATA_DIR", path.join(ROOT, ".house-data")),
  baseRpc: env("BASE_RPC", NETWORK.baseRpc),
  /** House lots kept open while someone is on the floor. */
  targetLive: Number(env("TARGET_LIVE", "2")),
  lotDurationSlots: BigInt(env("LOT_DURATION_SLOTS", "4500")),
  startPrice: BigInt(env("START_PRICE", "60000000")),
  floorPrice: BigInt(env("FLOOR_PRICE", "6000000")),
  presenceTtlMs: Number(env("PRESENCE_TTL_MS", "120000")),
  maxLotsPerHour: Number(env("MAX_LOTS_PER_HOUR", "90")),
  faucetUsdc: BigInt(env("FAUCET_USDC", "250")),
  faucetPerHour: Number(env("FAUCET_PER_HOUR", "60")),
  bots: env("BOTS", "on") === "on",
  alwaysOn: env("ALWAYS_ON", "off") === "on",
};

export function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

export function loadOrCreate(p: string): Keypair {
  if (fs.existsSync(p)) return loadKeypair(p);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const k = Keypair.generate();
  fs.writeFileSync(p, JSON.stringify(Array.from(k.secretKey)));
  return k;
}

export const deployment: Deployment = JSON.parse(fs.readFileSync(path.join(ROOT, "packages/sdk/src/deployment.devnet.json"), "utf8"));
export const base = new Connection(config.baseRpc, { commitment: "confirmed" });
export const pl = new Penlight(deployment, base);
export const house = loadKeypair(config.houseKey);

/** Rollup connection authenticated as a keypair, refreshed before the token expires. */
export class ErSession {
  conn!: Connection;
  private expiresAt = 0;
  constructor(readonly key: Keypair) {}
  async get(): Promise<Connection> {
    if (!this.conn || Date.now() > this.expiresAt - 60_000) {
      const s = await teeConnection(this.key.publicKey, keypairSigner(this.key));
      this.conn = s.conn;
      this.expiresAt = s.expiresAt || Date.now() + 10 * 60_000;
    }
    return this.conn;
  }
}

export const houseEr = new ErSession(house);

export interface FeedEvent {
  at: number;
  kind: string;
  lot?: number;
  text: string;
  sig?: string;
}

class Store {
  lots = new Map<number, LotView>();
  finished = new Set<number>();
  presence = new Map<string, number>();
  events: FeedEvent[] = [];
  faucetGiven: Record<string, number> = {};
  faucetTimes: number[] = [];
  lotTimes: number[] = [];
  takeLatencies: number[] = [];
  private file = path.join(config.dataDir, "state.json");

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.faucetGiven = j.faucetGiven ?? {};
      (j.finished ?? []).forEach((id: number) => this.finished.add(id));
    } catch {
      /* first run */
    }
  }
  save() {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ faucetGiven: this.faucetGiven, finished: [...this.finished] }));
  }
  event(e: Omit<FeedEvent, "at">) {
    this.events.push({ at: Date.now(), ...e });
    if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
  }
  floorActive(): boolean {
    if (config.alwaysOn) return true;
    const now = Date.now();
    for (const [k, t] of this.presence) if (now - t > config.presenceTtlMs) this.presence.delete(k);
    return this.presence.size > 0;
  }
}

export const store = new Store();

export const short = (k: PublicKey | string) => {
  const s = typeof k === "string" ? k : k.toBase58();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
};

export const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
