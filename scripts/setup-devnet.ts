/**
 * One-time devnet setup: catalogue mints, the House, and the House pool inside
 * the private rollup. Idempotent; safe to re-run.
 *
 *   npx tsx scripts/setup-devnet.ts
 */
import {
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  createMint,
  createSyncNativeInstruction,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  createTransferInstruction,
} from "@solana/spl-token";
import { delegateSpl, deriveEphemeralAta, ensureMagicAtaDestinationIx } from "@magicblock-labs/ephemeral-rollups-sdk";
import fs from "node:fs";
import { CATALOGUE, NETWORK, PROGRAM_ID, Penlight, sendAndConfirm, type Deployment } from "@penlight/sdk";
import { DEPLOYMENT_FILE, baseConnection, er, loadKeypair, log, sleep } from "./lib.ts";

const base = baseConnection();
const admin = loadKeypair("~/.config/solana/id.json");
const house = loadKeypair("keys/house.json");

// How much of each twin the House mints for itself, in whole tokens.
const HOUSE_SUPPLY: Record<string, number> = { SOL: 20_000, BONK: 2_000_000_000, WIF: 100_000, JUP: 50_000, JTO: 50_000, PYTH: 200_000, RAY: 10_000, POPCAT: 400_000 };
// How much goes into the pool inside the rollup.
const POOL_TOKENS: Record<string, number> = { SOL: 60, BONK: 600_000_000, WIF: 30_000, JUP: 15_000, JTO: 15_000, PYTH: 60_000, RAY: 3_000, POPCAT: 120_000 };
const USDC_SUPPLY = 50_000_000; // whole tUSDC minted to the House
const USDC_IN_ROLLUP = 50_000; // the House's rollup balance (seller proceeds land here)

async function main() {
  log("house authority", house.publicKey.toBase58(), "program", PROGRAM_ID.toBase58());
  const bal = await base.getBalance(house.publicKey);
  if (bal < 1.4 * LAMPORTS_PER_SOL) {
    const top = Math.round(1.6 * LAMPORTS_PER_SOL - bal);
    await sendAndConfirmTransaction(base, new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: house.publicKey, lamports: top })), [admin]);
    log("funded house with", top / LAMPORTS_PER_SOL, "SOL");
  }

  let dep: Deployment | null = fs.existsSync(DEPLOYMENT_FILE) ? JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, "utf8")) : null;
  if (dep && dep.programId !== PROGRAM_ID.toBase58()) {
    // New program build: keep the mints, re-derive the House.
    dep = { ...dep, programId: PROGRAM_ID.toBase58(), house: Penlight.houseAddress(house.publicKey).toBase58() };
    fs.writeFileSync(DEPLOYMENT_FILE, JSON.stringify(dep, null, 2) + "\n");
  }
  if (dep && dep.mints[0] === NATIVE_MINT.toBase58()) {
    // Rollup-only token accounts cannot hold the native mint; SOL is a twin like the rest.
    const m = await createMint(base, house, house.publicKey, null, 9);
    dep.mints[0] = m.toBase58();
    fs.writeFileSync(DEPLOYMENT_FILE, JSON.stringify(dep, null, 2) + "\n");
    log("mint SOL twin", m.toBase58());
  }
  if (!dep) {
    const mints: string[] = [];
    for (const c of CATALOGUE) {
      const m = await createMint(base, house, house.publicKey, null, c.decimals);
      mints.push(m.toBase58());
      log("mint", c.symbol, m.toBase58());
    }
    const usdc = await createMint(base, house, house.publicKey, null, 6);
    log("mint tUSDC", usdc.toBase58());
    dep = {
      network: "devnet",
      programId: PROGRAM_ID.toBase58(),
      houseAuthority: house.publicKey.toBase58(),
      house: Penlight.houseAddress(house.publicKey).toBase58(),
      usdcMint: usdc.toBase58(),
      mints,
    };
    fs.writeFileSync(DEPLOYMENT_FILE, JSON.stringify(dep, null, 2) + "\n");
    log("wrote", DEPLOYMENT_FILE);
  }

  const pl = new Penlight(dep, base);
  if (!(await base.getAccountInfo(pl.house))) {
    const ix = await pl.initHouseIx(house.publicKey, pl.usdcMint, pl.mints);
    const sig = await sendAndConfirmTransaction(base, new Transaction().add(ix), [house]);
    log("init_house", sig);
  }
  const poolInfo = await base.getAccountInfo(pl.poolAddress());
  if (poolInfo && poolInfo.owner.equals(PROGRAM_ID)) {
    const sig = await sendAndConfirmTransaction(base, new Transaction().add(await pl.delegatePoolIx(house.publicKey)), [house]);
    log("delegate_pool", sig);
    await sleep(3000);
  }

  // Base balances for the House.
  log("house account", pl.house.toBase58());
  for (let i = 0; i < CATALOGUE.length; i++) {
    const c = CATALOGUE[i];
    const ata = await getOrCreateAssociatedTokenAccount(base, house, pl.mints[i], house.publicKey);
    if (ata.amount === 0n) {
      await mintTo(base, house, pl.mints[i], ata.address, house, BigInt(HOUSE_SUPPLY[c.symbol]) * 10n ** BigInt(c.decimals));
      log("minted", c.symbol);
    }
  }
  const usdcAta = await getOrCreateAssociatedTokenAccount(base, house, pl.usdcMint, house.publicKey);
  if (usdcAta.amount === 0n) {
    await mintTo(base, house, pl.usdcMint, usdcAta.address, house, BigInt(USDC_SUPPLY) * 10n ** 6n);
    log("minted tUSDC");
  }

  // Move into the rollup: House balances for each catalogue mint + USDC.
  const ehouse = await er(house);
  const erBal = async (owner: PublicKey, mint: PublicKey) => {
    try {
      return BigInt((await ehouse.getTokenAccountBalance(pl.ata(owner, mint))).value.amount);
    } catch {
      return 0n;
    }
  };
  const deposits: [PublicKey, bigint][] = CATALOGUE.map((c, i) => [pl.mints[i], BigInt(Math.round(POOL_TOKENS[c.symbol] * 10 ** Math.min(c.decimals, 6))) * 10n ** BigInt(Math.max(c.decimals - 6, 0))]);
  deposits.push([pl.usdcMint, BigInt(USDC_IN_ROLLUP) * 10n ** 6n]);
  const pool = pl.poolAddress();
  for (const [mint, amount] of deposits) {
    const [eata] = deriveEphemeralAta(house.publicKey, mint);
    const eataInfo = await base.getAccountInfo(eata);
    if (eataInfo && eataInfo.owner.equals(new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"))) continue;
    const ixs = await delegateSpl(house.publicKey, mint, amount, {
      validator: NETWORK.teeValidator,
      payer: house.publicKey,
      initIfMissing: true,
      initVaultIfMissing: true,
      initAtasIfMissing: true,
    });
    const sig = await sendAndConfirmTransaction(base, new Transaction().add(...ixs), [house]);
    log("deposited into rollup", mint.toBase58().slice(0, 6), amount.toString(), sig.slice(0, 16));
  }
  await sleep(3000);

  // The pool: rollup-only token accounts owned by the pool PDA, funded by the House.
  await sendAndConfirm(ehouse, [await pl.poolPermissionIx(house.publicKey)], [house], { label: "pool permission" });
  log("pool ledger is private");
  for (let i = 0; i < CATALOGUE.length; i++) {
    const have = await erBal(pool, pl.mints[i]);
    const houseHas = await erBal(house.publicKey, pl.mints[i]);
    if (have > 0n || houseHas === 0n) continue;
    const r = await sendAndConfirm(
      ehouse,
      [
        ensureMagicAtaDestinationIx(house.publicKey, pool, pl.mints[i]),
        createTransferInstruction(pl.ata(house.publicKey, pl.mints[i]), pl.ata(pool, pl.mints[i]), house.publicKey, houseHas),
      ],
      [house],
      { label: `fund pool ${CATALOGUE[i].symbol}` },
    );
    log("funded pool", CATALOGUE[i].symbol, r.signature.slice(0, 16), `${r.ms} ms`);
  }
  for (let i = 0; i < CATALOGUE.length; i++) log("pool", CATALOGUE[i].symbol.padEnd(6), (await erBal(pool, pl.mints[i])).toString());
  log("house rollup tUSDC", (await erBal(house.publicKey, pl.usdcMint)).toString());
  log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
