import anchor, { type Idl } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  ensureMagicAtaDestinationIx,
  permissionPdaFromAccount,
  PERMISSION_PROGRAM_ID,
  EPHEMERAL_VAULT_ID,
  MAGIC_PROGRAM_ID,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import idlJson from "./idl/penlight.json" with { type: "json" };
import { CATALOGUE, HINTS, MAGICBLOCK, NETWORK, PROGRAM_ID, SEEDS, SLOTS, feedAddress } from "./constants.js";
import { type ClockParams } from "./math.js";

const { AnchorProvider, BN, BorshAccountsCoder, Program } = anchor;
type BN = InstanceType<typeof anchor.BN>;
type Program = InstanceType<typeof anchor.Program>;

export const IDL = idlJson as Idl;
const accountsCoder = new BorshAccountsCoder(IDL);

export interface Deployment {
  network: "devnet";
  programId: string;
  houseAuthority: string;
  house: string;
  usdcMint: string;
  /** Catalogue mints in slot order. */
  mints: string[];
}

export interface HintView {
  kind: number;
  sym: number;
  a: bigint;
  b: bigint;
  slot: bigint;
}

export interface LotView {
  address: PublicKey;
  house: PublicKey;
  seller: PublicKey;
  id: number;
  origin: number;
  status: number;
  sealed: boolean;
  packed: boolean;
  commitment: Uint8Array;
  startPrice: bigint;
  floorPrice: bigint;
  durationSlots: bigint;
  openSlot: bigint;
  hintsRevealed: number;
  hints: HintView[];
  hintPrices: bigint[][];
  winner: PublicKey;
  paid: bigint;
  soldSlot: bigint;
  valueAtDelivery: bigint;
  deliveryPrices: bigint[];
  amounts: bigint[];
  salt: Uint8Array;
  seed: Uint8Array;
  createdAt: number;
}

const big = (x: BN | number | bigint) => BigInt(x.toString());

export function decodeLot(address: PublicKey, data: Buffer): LotView {
  const r = accountsCoder.decode("Lot", data);
  return {
    address,
    house: r.house,
    seller: r.seller,
    id: Number(r.id.toString()),
    origin: r.origin,
    status: r.status,
    sealed: r.sealed,
    packed: r.packed,
    commitment: Uint8Array.from(r.commitment),
    startPrice: big(r.start_price),
    floorPrice: big(r.floor_price),
    durationSlots: big(r.duration_slots),
    openSlot: big(r.open_slot),
    hintsRevealed: r.hints_revealed,
    hints: r.hints.map((h: any) => ({ kind: h.kind, sym: h.sym, a: big(h.a), b: big(h.b), slot: big(h.slot) })),
    hintPrices: r.hint_prices.map((row: BN[]) => row.map(big)),
    winner: r.winner,
    paid: big(r.paid),
    soldSlot: big(r.sold_slot),
    valueAtDelivery: big(r.value_at_delivery),
    deliveryPrices: r.delivery_prices.map(big),
    amounts: r.amounts.map(big),
    salt: Uint8Array.from(r.salt),
    seed: Uint8Array.from(r.seed),
    createdAt: Number(r.created_at.toString()),
  };
}

export function clockOf(lot: LotView): ClockParams {
  return { startPrice: lot.startPrice, floorPrice: lot.floorPrice, openSlot: lot.openSlot, durationSlots: lot.durationSlots };
}

const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
const rw = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });

/** Instruction builder and reader for one Penlight deployment. */
export class Penlight {
  readonly programId: PublicKey;
  readonly house: PublicKey;
  readonly houseAuthority: PublicKey;
  readonly usdcMint: PublicKey;
  readonly mints: PublicKey[];
  readonly feeds: PublicKey[];
  readonly program: Program;

  constructor(readonly deployment: Deployment, readonly base: Connection = new Connection(NETWORK.baseRpc, "confirmed")) {
    this.programId = new PublicKey(deployment.programId);
    if (!this.programId.equals(PROGRAM_ID)) throw new Error("deployment does not match the bundled IDL");
    this.house = new PublicKey(deployment.house);
    this.houseAuthority = new PublicKey(deployment.houseAuthority);
    this.usdcMint = new PublicKey(deployment.usdcMint);
    this.mints = deployment.mints.map((m) => new PublicKey(m));
    this.feeds = CATALOGUE.map((c) => feedAddress(c.lazerId));
    const wallet = { publicKey: Keypair.generate().publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t };
    this.program = new Program(IDL, new AnchorProvider(base, wallet as any, {}));
  }

  // ── addresses ──
  lotAddress(id: number | bigint): PublicKey {
    const idb = Buffer.alloc(8);
    idb.writeBigUInt64LE(BigInt(id));
    return PublicKey.findProgramAddressSync([SEEDS.lot, this.house.toBuffer(), idb], this.programId)[0];
  }
  sealAddress(lot: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync([SEEDS.seal, lot.toBuffer()], this.programId)[0];
  }
  poolAddress(): PublicKey {
    return PublicKey.findProgramAddressSync([SEEDS.pool, this.house.toBuffer()], this.programId)[0];
  }
  static houseAddress(authority: PublicKey, programId: PublicKey = PROGRAM_ID): PublicKey {
    return PublicKey.findProgramAddressSync([SEEDS.house, authority.toBuffer()], programId)[0];
  }
  ata(owner: PublicKey, mint: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(mint, owner, true);
  }
  atas(owner: PublicKey): PublicKey[] {
    return this.mints.map((m) => this.ata(owner, m));
  }
  usdcAta(owner: PublicKey): PublicKey {
    return this.ata(owner, this.usdcMint);
  }

  // ── reads ──
  async houseState(): Promise<{ lotsCreated: number; authority: PublicKey }> {
    const acc = await this.base.getAccountInfo(this.house);
    if (!acc) throw new Error("house not found");
    const h = accountsCoder.decode("House", acc.data);
    return { lotsCreated: Number(h.lots_created.toString()), authority: h.authority };
  }

  async fetchLot(conn: Connection, address: PublicKey): Promise<LotView | null> {
    const acc = await conn.getAccountInfo(address, "confirmed");
    if (!acc || !acc.owner.equals(this.programId)) return null;
    return decodeLot(address, acc.data);
  }

  async fetchLots(conn: Connection, ids: number[]): Promise<(LotView | null)[]> {
    const out: (LotView | null)[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const addrs = chunk.map((id) => this.lotAddress(id));
      const infos = await conn.getMultipleAccountsInfo(addrs, "confirmed");
      infos.forEach((acc, j) => out.push(acc && acc.owner.equals(this.programId) ? decodeLot(addrs[j], acc.data) : null));
    }
    return out;
  }

  // ── base layer ──
  async initHouseIx(authority: PublicKey, usdcMint: PublicKey, mints: PublicKey[]): Promise<TransactionInstruction> {
    const catalogue = CATALOGUE.map((c, i) => ({
      mint: mints[i],
      feed: feedAddress(c.lazerId),
      decimals: c.decimals,
      expo: c.expo,
      kind: c.kind,
      symbol: Array.from(Buffer.from(c.symbol.padEnd(8, "\0").slice(0, 8))),
    }));
    return this.program.methods
      .initHouse(usdcMint, NETWORK.teeValidator, catalogue)
      .accountsPartial({ authority, house: Penlight.houseAddress(authority, this.programId), systemProgram: SystemProgram.programId })
      .instruction();
  }

  async delegatePoolIx(authority: PublicKey, validator: PublicKey = NETWORK.teeValidator) {
    return this.program.methods
      .delegatePool()
      .accountsPartial({ authority, house: this.house, pool: this.poolAddress(), validator })
      .instruction();
  }

  async poolPermissionIx(payer: PublicKey) {
    const pool = this.poolAddress();
    return this.program.methods
      .poolPermission()
      .accountsPartial({
        payer,
        pool,
        permission: this.permissionPda(pool),
        permissionProgram: PERMISSION_PROGRAM,
        ephemeralVault: EPHEMERAL_VAULT,
        magicProgram: MAGIC_PROGRAM,
      })
      .instruction();
  }

  async createLotIx(p: { payer: PublicKey; seller: PublicKey; id: number; commitment: Uint8Array; startPrice: bigint; floorPrice: bigint; durationSlots: bigint }) {
    const lot = this.lotAddress(p.id);
    return this.program.methods
      .createLot(Array.from(p.commitment), new BN(p.startPrice.toString()), new BN(p.floorPrice.toString()), new BN(p.durationSlots.toString()))
      .accountsPartial({ payer: p.payer, seller: p.seller, house: this.house, lot, seal: this.sealAddress(lot), systemProgram: SystemProgram.programId })
      .instruction();
  }

  async createHouseLotIx(p: { authority: PublicKey; id: number; startPrice: bigint; floorPrice: bigint; durationSlots: bigint }) {
    const lot = this.lotAddress(p.id);
    return this.program.methods
      .createHouseLot(new BN(p.startPrice.toString()), new BN(p.floorPrice.toString()), new BN(p.durationSlots.toString()))
      .accountsPartial({ authority: p.authority, house: this.house, lot, seal: this.sealAddress(lot), systemProgram: SystemProgram.programId })
      .instruction();
  }

  async delegateLotIx(payer: PublicKey, id: number, validator: PublicKey = NETWORK.teeValidator) {
    const lot = this.lotAddress(id);
    return this.program.methods
      .delegateLot(new BN(id))
      .accountsPartial({ payer, house: this.house, lot, seal: this.sealAddress(lot), validator })
      .instruction();
  }

  // ── private rollup ──
  /** Creates `owner`'s rollup-only token accounts for every catalogue mint (idempotent). */
  prepareAtasIxs(payer: PublicKey, owner: PublicKey, includeUsdc = false): TransactionInstruction[] {
    const mints = includeUsdc ? [...this.mints, this.usdcMint] : this.mints;
    return mints.map((m) => ensureMagicAtaDestinationIx(payer, owner, m));
  }

  async sealPermissionIx(payer: PublicKey, lot: PublicKey) {
    const seal = this.sealAddress(lot);
    return this.program.methods
      .sealPermission()
      .accountsPartial({
        payer,
        lot,
        seal,
        permission: this.permissionPda(seal),
        permissionProgram: PERMISSION_PROGRAM,
        ephemeralVault: EPHEMERAL_VAULT,
        magicProgram: MAGIC_PROGRAM,
      })
      .instruction();
  }

  permissionPda(account: PublicKey): PublicKey {
    return permissionPdaFromAccount(account);
  }

  /**
   * The lot's rollup-only token accounts are created and funded in this one
   * transaction (an empty one would be closed by the rollup), only for the
   * slots that hold something.
   */
  async packIxs(seller: PublicKey, lot: PublicKey, salt: Uint8Array, amounts: bigint[]): Promise<TransactionInstruction[]> {
    const rem: AccountMeta[] = [];
    const ensure: TransactionInstruction[] = [];
    for (let i = 0; i < SLOTS; i++) {
      if (amounts[i] === 0n) continue;
      rem.push(rw(this.ata(seller, this.mints[i])), rw(this.ata(lot, this.mints[i])));
      ensure.push(ensureMagicAtaDestinationIx(seller, lot, this.mints[i]));
    }
    const ix = await this.program.methods
      .pack(Array.from(salt), amounts.map((a) => new BN(a.toString())))
      .accountsPartial({ seller, house: this.house, lot, seal: this.sealAddress(lot), tokenProgram: TOKEN_PROGRAM_ID })
      .remainingAccounts(rem)
      .instruction();
    return [...ensure, ix];
  }

  async openIx(payer: PublicKey, lot: PublicKey, clientSeed = Math.floor(Math.random() * 255)) {
    return this.program.methods
      .open(clientSeed)
      .accountsPartial({ payer, lot, seal: this.sealAddress(lot), oracleQueue: MAGICBLOCK.ephemeralQueue })
      .instruction();
  }

  async packFromPoolIxs(payer: PublicKey, lot: PublicKey): Promise<TransactionInstruction[]> {
    const pool = this.poolAddress();
    const rem: AccountMeta[] = [...this.atas(pool).map(ro), ...this.feeds.map(ro)];
    const ix = await this.program.methods
      .packFromPool()
      .accountsPartial({ payer, house: this.house, lot, seal: this.sealAddress(lot), pool })
      .remainingAccounts(rem)
      .instruction();
    return [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ix];
  }

  async goLiveIx(payer: PublicKey, lot: PublicKey) {
    return this.program.methods.goLive().accountsPartial({ payer, lot }).instruction();
  }

  async revealIxs(payer: PublicKey, lot: PublicKey): Promise<TransactionInstruction[]> {
    const ix = await this.program.methods
      .reveal()
      .accountsPartial({ payer, house: this.house, lot, seal: this.sealAddress(lot) })
      .remainingAccounts(this.feeds.map(ro))
      .instruction();
    return [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix];
  }

  async takeIx(buyer: PublicKey, lot: PublicKey, seller: PublicKey, maxPrice: bigint) {
    return this.program.methods
      .take(new BN(maxPrice.toString()))
      .accountsPartial({
        buyer,
        house: this.house,
        lot,
        buyerUsdc: this.usdcAta(buyer),
        sellerUsdc: this.usdcAta(seller),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  }

  async unsealIxs(payer: PublicKey, lot: PublicKey): Promise<TransactionInstruction[]> {
    const ix = await this.program.methods
      .unseal()
      .accountsPartial({ payer, house: this.house, lot, seal: this.sealAddress(lot) })
      .remainingAccounts(this.feeds.map(ro))
      .instruction();
    return [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ix];
  }

  /**
   * Moves an opened lot's tokens. `lot` must already be opened (its amounts are
   * public); the destination accounts are created in the same transaction.
   */
  async deliverIxs(payer: PublicKey, lot: LotView): Promise<TransactionInstruction[]> {
    const sold = lot.status === 7;
    const houseLot = lot.origin === 1;
    const source = houseLot ? this.poolAddress() : lot.address;
    const dest = sold ? lot.winner : lot.seller;
    const rem: AccountMeta[] = [];
    const ensure: TransactionInstruction[] = [];
    if (sold || !houseLot) {
      for (let i = 0; i < SLOTS; i++) {
        if (lot.amounts[i] === 0n) continue;
        rem.push(rw(this.ata(source, this.mints[i])), rw(this.ata(dest, this.mints[i])));
        ensure.push(ensureMagicAtaDestinationIx(payer, dest, this.mints[i]));
      }
    }
    const ix = await this.program.methods
      .deliver()
      .accountsPartial({ payer, house: this.house, lot: lot.address, pool: this.poolAddress(), tokenProgram: TOKEN_PROGRAM_ID })
      .remainingAccounts(rem)
      .instruction();
    return [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...ensure, ix];
  }

  async settleIx(payer: PublicKey, lot: PublicKey) {
    return this.program.methods.settle().accountsPartial({ payer, lot }).instruction();
  }
}

const PERMISSION_PROGRAM = PERMISSION_PROGRAM_ID;
const EPHEMERAL_VAULT = EPHEMERAL_VAULT_ID;
const MAGIC_PROGRAM = MAGIC_PROGRAM_ID;

export { HINTS };
