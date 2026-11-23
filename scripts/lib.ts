import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NETWORK, Penlight, keypairSigner, teeConnection, type Deployment } from "@penlight/sdk";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEPLOYMENT_FILE = path.join(ROOT, "packages/sdk/src/deployment.devnet.json");

export function loadKeypair(file: string): Keypair {
  const p = file.startsWith("~") ? path.join(os.homedir(), file.slice(1)) : path.isAbsolute(file) ? file : path.join(ROOT, file);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

export function loadOrCreateKeypair(file: string): Keypair {
  const p = path.join(ROOT, file);
  if (fs.existsSync(p)) return loadKeypair(file);
  const k = Keypair.generate();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(Array.from(k.secretKey)));
  return k;
}

export function baseConnection(): Connection {
  return new Connection(process.env.BASE_RPC ?? NETWORK.baseRpc, { commitment: "confirmed", wsEndpoint: process.env.BASE_WS ?? NETWORK.baseWs });
}

export function loadDeployment(): Deployment {
  return JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, "utf8"));
}

export async function er(k: Keypair): Promise<Connection> {
  return (await teeConnection(k.publicKey, keypairSigner(k))).conn;
}

export function client(base = baseConnection()): Penlight {
  return new Penlight(loadDeployment(), base);
}

const t0 = Date.now();
export const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 60_000, everyMs = 200): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(everyMs);
  }
}

export { PublicKey };
