import { PublicKey } from "@solana/web3.js";
import idl from "./idl/penlight.json" with { type: "json" };

export const PROGRAM_ID = new PublicKey((idl as { address: string }).address);

export const SLOTS = 8;
export const HINTS = 5;
export const HINT_AT_BPS = [1500, 3000, 4500, 6000, 7500] as const;
export const OPEN_DELAY_SLOTS = 150;
export const GRACE_BPS = 2000;
export const USD_DECIMALS = 6;

export const SEEDS = {
  house: Buffer.from("house"),
  lot: Buffer.from("lot"),
  seal: Buffer.from("seal"),
  pool: Buffer.from("pool"),
} as const;

export const NETWORK = {
  baseRpc: "https://rpc.magicblock.app/devnet",
  baseWs: "wss://rpc.magicblock.app/devnet",
  teeRpc: "https://devnet-tee.magicblock.app",
  teeWs: "wss://devnet-tee.magicblock.app",
  teeValidator: new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo"),
  explorer: "https://explorer.solana.com",
} as const;

export const MAGICBLOCK = {
  ephemeralQueue: new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc"),
  oracleProgram: new PublicKey("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd"),
  delegationProgram: new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"),
  vrfProgram: new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz"),
} as const;

export const KIND_MAJOR = 0;
export const KIND_MEME = 1;
export const KIND_DEFI = 2;

export interface CatalogueSpec {
  symbol: string;
  name: string;
  decimals: number;
  /** Magnitude of the Pyth Lazer feed exponent (price = raw / 10^expo). */
  expo: number;
  lazerId: number;
  kind: number;
}

/** The eight token kinds a lot can hold, in slot order. */
export const CATALOGUE: CatalogueSpec[] = [
  { symbol: "SOL", name: "Solana", decimals: 9, expo: 8, lazerId: 6, kind: KIND_MAJOR },
  { symbol: "BONK", name: "Bonk", decimals: 5, expo: 10, lazerId: 9, kind: KIND_MEME },
  { symbol: "WIF", name: "dogwifhat", decimals: 6, expo: 8, lazerId: 10, kind: KIND_MEME },
  { symbol: "JUP", name: "Jupiter", decimals: 6, expo: 8, lazerId: 92, kind: KIND_DEFI },
  { symbol: "JTO", name: "Jito", decimals: 9, expo: 8, lazerId: 91, kind: KIND_DEFI },
  { symbol: "PYTH", name: "Pyth Network", decimals: 6, expo: 8, lazerId: 3, kind: KIND_DEFI },
  { symbol: "RAY", name: "Raydium", decimals: 6, expo: 8, lazerId: 54, kind: KIND_DEFI },
  { symbol: "POPCAT", name: "Popcat", decimals: 9, expo: 8, lazerId: 130, kind: KIND_MEME },
];

export const USDC = { symbol: "USDC", decimals: 6, lazerId: 7 } as const;

/** MagicBlock oracle feed account for a Pyth Lazer id. */
export function feedAddress(lazerId: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("price_feed"), Buffer.from("pyth-lazer"), Buffer.from(String(lazerId))],
    MAGICBLOCK.oracleProgram,
  )[0];
}

export const STATUS = {
  CREATED: 0,
  SHUFFLING: 1,
  SHUFFLED: 2,
  LIVE: 3,
  SOLD: 4,
  DELIVERED: 5,
  EXPIRED: 6,
  OPENED: 7,
  UNSOLD: 8,
} as const;

export const STATUS_NAME: Record<number, string> = {
  0: "created",
  1: "shuffling",
  2: "shuffled",
  3: "live",
  4: "sold",
  5: "delivered",
  6: "returned",
  7: "opened",
  8: "unsold",
};

export const ORIGIN = { CONSIGNED: 0, HOUSE: 1 } as const;
