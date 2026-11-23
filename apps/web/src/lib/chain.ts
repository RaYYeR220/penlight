"use client";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import { CATALOGUE, NETWORK, Penlight, type Deployment } from "@penlight/sdk";
import deploymentJson from "@penlight/sdk/deployment.devnet.json";

export const deployment = deploymentJson as Deployment;
export const symbols = CATALOGUE.map((c) => c.symbol);

let _pl: Penlight | null = null;
export function penlight(): Penlight {
  if (!_pl) _pl = new Penlight(deployment, new Connection(NETWORK.baseRpc, "confirmed"));
  return _pl;
}

let _pub: Connection | null = null;
/** Public view of the private rollup: lots, clocks and facts are public accounts. */
export function rollupPublic(): Connection {
  if (!_pub) _pub = new Connection(NETWORK.teeRpc, { commitment: "confirmed", wsEndpoint: NETWORK.teeWs });
  return _pub;
}

// ── the in-browser player key ──
const KEY = "penlight.player.v1";

export function playerKey(): Keypair {
  if (typeof window === "undefined") throw new Error("browser only");
  const raw = window.localStorage.getItem(KEY);
  if (raw) {
    try {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    } catch {
      /* fall through and make a new one */
    }
  }
  const k = Keypair.generate();
  window.localStorage.setItem(KEY, JSON.stringify(Array.from(k.secretKey)));
  return k;
}

export function exportPlayerKey(): string {
  return JSON.stringify(Array.from(playerKey().secretKey));
}

let _auth: { conn: Connection; expiresAt: number; owner: string } | null = null;
/** The rollup as the player: their own balances are readable only through this. */
export async function rollupAsPlayer(): Promise<Connection> {
  const k = playerKey();
  if (_auth && _auth.owner === k.publicKey.toBase58() && Date.now() < _auth.expiresAt - 60_000) return _auth.conn;
  const { token, expiresAt } = await getAuthToken(NETWORK.teeRpc, k.publicKey, async (m: Uint8Array) => nacl.sign.detached(m, k.secretKey));
  const conn = new Connection(`${NETWORK.teeRpc}?token=${token}`, { commitment: "confirmed", wsEndpoint: `${NETWORK.teeWs}?token=${token}` });
  _auth = { conn, expiresAt: expiresAt || Date.now() + 10 * 60_000, owner: k.publicKey.toBase58() };
  return conn;
}

export const explorerTx = (sig: string, rollup = false) =>
  rollup
    ? `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(NETWORK.teeRpc)}`
    : `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const explorerAddress = (a: string | PublicKey, rollup = false) =>
  rollup
    ? `https://explorer.solana.com/address/${a.toString()}?cluster=custom&customUrl=${encodeURIComponent(NETWORK.teeRpc)}`
    : `https://explorer.solana.com/address/${a.toString()}?cluster=devnet`;

export const usd = (micros: bigint | number | string, digits = 2) => {
  const n = Number(micros) / 1e6;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};
