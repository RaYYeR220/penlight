import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, type Signer } from "@solana/web3.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import { NETWORK } from "./constants.js";

export type SignMessage = (message: Uint8Array) => Promise<Uint8Array>;

export function keypairSigner(k: Keypair): SignMessage {
  return async (m) => nacl.sign.detached(m, k.secretKey);
}

/** A connection to the private rollup, authenticated as `owner`. */
export async function teeConnection(owner: PublicKey, signMessage: SignMessage, rpc: string = NETWORK.teeRpc, ws: string = NETWORK.teeWs) {
  const { token, expiresAt } = await getAuthToken(rpc, owner, signMessage);
  const conn = new Connection(`${rpc}?token=${token}`, { commitment: "confirmed", wsEndpoint: `${ws}?token=${token}` });
  return { conn, token, expiresAt };
}

/** Unauthenticated view of the rollup: public accounts only. */
export function publicTeeConnection(rpc: string = NETWORK.teeRpc) {
  return new Connection(rpc, "confirmed");
}

export interface SentTx {
  signature: string;
  /** Milliseconds from send to confirmed status. */
  ms: number;
  slot?: number;
}

export class TxError extends Error {
  constructor(message: string, public readonly signature: string, public readonly logs?: string[]) {
    super(message);
  }
}

/**
 * Sign and send `ixs`, then poll the signature status until it is confirmed.
 * Polling (instead of a websocket confirm) keeps the measured latency honest on a
 * 10 ms rollup.
 */
export async function sendAndConfirm(
  conn: Connection,
  ixs: TransactionInstruction[],
  signers: Signer[],
  opts: { feePayer?: PublicKey; skipPreflight?: boolean; pollMs?: number; timeoutMs?: number; label?: string } = {},
): Promise<SentTx> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = opts.feePayer ?? signers[0].publicKey;
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(...signers);
  return sendSignedAndConfirm(conn, tx, opts);
}

export async function sendSignedAndConfirm(
  conn: Connection,
  tx: Transaction,
  opts: { skipPreflight?: boolean; pollMs?: number; timeoutMs?: number; label?: string } = {},
): Promise<SentTx> {
  const start = performance.now();
  const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: opts.skipPreflight ?? true, maxRetries: 0 });
  const poll = opts.pollMs ?? 25;
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  let lastResend = Date.now();
  for (;;) {
    const st = (await conn.getSignatureStatuses([signature])).value[0];
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
      const ms = Math.round(performance.now() - start);
      if (st.err) {
        const full = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 1, commitment: "confirmed" }).catch(() => null);
        throw new TxError(`${opts.label ?? "transaction"} failed: ${JSON.stringify(st.err)}`, signature, full?.meta?.logMessages ?? undefined);
      }
      return { signature, ms, slot: st.slot };
    }
    if (Date.now() > deadline) throw new TxError(`${opts.label ?? "transaction"} not confirmed in time`, signature);
    if (Date.now() - lastResend > 2_000) {
      lastResend = Date.now();
      conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, poll));
  }
}
