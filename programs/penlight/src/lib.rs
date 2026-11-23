//! Penlight: sealed lots of real tokens, sold on a falling clock inside a private
//! rollup. The lot discloses true facts as its price falls; the first TAKE pays
//! the price of the block it lands in and owns everything inside.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer as transfer_lamports, Transfer as LamportsTransfer};
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as SplTransfer, ID as TOKEN_PROGRAM_ID};
use ephemeral_rollups_sdk::access_control::{
    instructions::CreateEphemeralPermissionCpi,
    structs::{EphemeralMembersArgs, EphemeralPermission, Member, PERMISSION_SEED, TX_BALANCES_FLAG, TX_LOGS_FLAG, TX_MESSAGE_FLAG},
};
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral, vrf, vrf_callback};
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;
use ephemeral_rollups_sdk::vrf::{
    self as mbvrf,
    consts::program_identity_pubkey,
    instructions::{create_request_randomness_ix_const, RequestRandomnessParams},
    types::SerializableAccountMeta,
};

pub mod clock;
pub mod commitment;
pub mod constants;
pub mod draw;
pub mod error;
pub mod hints;
pub mod oracle;
pub mod rng;
pub mod state;
mod vectors;

use constants::*;
use error::PenlightError;
use state::*;

declare_id!("2gqehWewPNJg9t6XtnniyNk8iuC5p6ew1q4XrNHLopkt");

const PROGRAM_IDENTITY: Pubkey = program_identity_pubkey(&crate::ID);
/// The VRF program signs callbacks with this PDA. Kept in a `const` item so it is
/// derived at compile time; deriving it inside an account constraint runs the
/// ed25519 search on-chain and costs ~265k CU.
const VRF_CALLBACK_IDENTITY: Pubkey = Pubkey::new_from_array(mbvrf::consts::scoped_vrf_identity_const(&crate::ID).0);

#[ephemeral]
#[program]
pub mod penlight {
    use super::*;

    // ───────────────────────────── base layer ─────────────────────────────

    /// Creates the House and its pool ledger.
    pub fn init_house(ctx: Context<InitHouse>, usdc_mint: Pubkey, validator: Pubkey, catalogue: [CatalogueEntry; SLOTS]) -> Result<()> {
        check_catalogue(&catalogue)?;
        let house_key = ctx.accounts.house.key();
        let house = &mut ctx.accounts.house;
        house.authority = ctx.accounts.authority.key();
        house.usdc_mint = usdc_mint;
        house.catalogue = catalogue;
        house.lots_created = 0;
        house.validator = validator;
        house.bump = ctx.bumps.house;
        house.pool_bump = ctx.bumps.pool;
        let pool = &mut ctx.accounts.pool;
        pool.house = house_key;
        pool.reserved = [0; SLOTS];
        pool.bump = ctx.bumps.pool;
        fund_permission_rent(&ctx.accounts.authority, &ctx.accounts.pool.to_account_info(), &ctx.accounts.system_program)
    }

    /// Only before the first lot: every lot reads the catalogue, so it never
    /// changes under a lot.
    pub fn set_catalogue(ctx: Context<SetCatalogue>, catalogue: [CatalogueEntry; SLOTS]) -> Result<()> {
        require!(ctx.accounts.house.lots_created == 0, PenlightError::CatalogueFrozen);
        check_catalogue(&catalogue)?;
        ctx.accounts.house.catalogue = catalogue;
        Ok(())
    }

    /// Hands the pool ledger to the private rollup.
    pub fn delegate_pool(ctx: Context<DelegatePool>) -> Result<()> {
        let house = ctx.accounts.house.key();
        let validator = Some(ctx.accounts.validator.key());
        ctx.accounts.delegate_pool(
            &ctx.accounts.authority,
            &[POOL_SEED, house.as_ref()],
            DelegateConfig { validator, ..Default::default() },
        )?;
        Ok(())
    }

    /// A seller consigns a lot. The commitment binds its contents before anything
    /// else can happen to it.
    pub fn create_lot(
        ctx: Context<CreateLot>,
        commitment: [u8; 32],
        start_price: u64,
        floor_price: u64,
        duration_slots: u64,
    ) -> Result<()> {
        let seller = ctx.accounts.seller.key();
        let (lot_bump, seal_bump) = (ctx.bumps.lot, ctx.bumps.seal);
        init_lot(
            &mut ctx.accounts.house,
            &mut ctx.accounts.lot,
            &mut ctx.accounts.seal,
            seller,
            origin::CONSIGNED,
            commitment,
            start_price,
            floor_price,
            duration_slots,
            lot_bump,
            seal_bump,
        )?;
        fund_permission_rent(&ctx.accounts.payer, &ctx.accounts.lot.to_account_info(), &ctx.accounts.system_program)
    }

    /// The House opens a lot that the seed will pack from its pool.
    pub fn create_house_lot(ctx: Context<CreateHouseLot>, start_price: u64, floor_price: u64, duration_slots: u64) -> Result<()> {
        let authority = ctx.accounts.authority.key();
        let (lot_bump, seal_bump) = (ctx.bumps.lot, ctx.bumps.seal);
        init_lot(
            &mut ctx.accounts.house,
            &mut ctx.accounts.lot,
            &mut ctx.accounts.seal,
            authority,
            origin::HOUSE,
            [0u8; 32],
            start_price,
            floor_price,
            duration_slots,
            lot_bump,
            seal_bump,
        )?;
        fund_permission_rent(&ctx.accounts.authority, &ctx.accounts.lot.to_account_info(), &ctx.accounts.system_program)
    }

    /// Hands the lot and its seal to the private rollup.
    pub fn delegate_lot(ctx: Context<DelegateLot>, id: u64) -> Result<()> {
        let house = ctx.accounts.house.key();
        let lot_key = ctx.accounts.lot.key();
        let validator = Some(ctx.accounts.validator.key());
        ctx.accounts.delegate_lot(
            &ctx.accounts.payer,
            &[LOT_SEED, house.as_ref(), &id.to_le_bytes()],
            DelegateConfig { validator, ..Default::default() },
        )?;
        ctx.accounts.delegate_seal(
            &ctx.accounts.payer,
            &[SEAL_SEED, lot_key.as_ref()],
            DelegateConfig { validator, ..Default::default() },
        )?;
        Ok(())
    }

    // ───────────────────────────── private rollup ─────────────────────────────

    /// Makes the pool ledger unreadable: no members, so only the program sees it.
    pub fn pool_permission(ctx: Context<PoolPermission>) -> Result<()> {
        if permission_exists(&ctx.accounts.permission) {
            ctx.accounts.pool.private = true;
            return Ok(());
        }
        let house = ctx.accounts.pool.house;
        let bump = [ctx.accounts.pool.bump];
        let seeds: &[&[u8]] = &[POOL_SEED, house.as_ref(), &bump];
        CreateEphemeralPermissionCpi {
            payer: ctx.accounts.pool.to_account_info(),
            permissioned_account: ctx.accounts.pool.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            args: EphemeralMembersArgs { is_private: true, members: vec![] },
        }
        .invoke_signed(&[seeds])?;
        ctx.accounts.pool.private = true;
        Ok(())
    }

    /// Locks the seal behind a permission. Consigned lots let their seller read it
    /// (they packed it); House lots have no reader at all.
    pub fn seal_permission(ctx: Context<SealPermission>) -> Result<()> {
        if permission_exists(&ctx.accounts.permission) {
            ctx.accounts.lot.sealed = true;
            return Ok(());
        }
        let lot = &ctx.accounts.lot;
        let members = if lot.origin == origin::CONSIGNED {
            vec![Member { flags: TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG, pubkey: lot.seller }]
        } else {
            vec![]
        };
        let id_bytes = lot.id.to_le_bytes();
        let lot_bump = [lot.bump];
        let lot_seeds: &[&[u8]] = &[LOT_SEED, lot.house.as_ref(), &id_bytes, &lot_bump];
        let lot_key = lot.key();
        let seal_bump = [lot.seal_bump];
        let seal_seeds: &[&[u8]] = &[SEAL_SEED, lot_key.as_ref(), &seal_bump];
        CreateEphemeralPermissionCpi {
            payer: ctx.accounts.lot.to_account_info(),
            permissioned_account: ctx.accounts.seal.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            args: EphemeralMembersArgs { is_private: true, members },
        }
        .invoke_signed(&[lot_seeds, seal_seeds])?;
        ctx.accounts.lot.sealed = true;
        Ok(())
    }

    /// A seller moves their tokens into the lot's own accounts, checked against
    /// the commitment (which covers every catalogue slot, empty ones included).
    /// remaining_accounts: [seller_ata, lot_ata] for each slot with amount > 0,
    /// in slot order. The rollup does not show this transaction to outsiders.
    pub fn pack<'info>(ctx: Context<'info, Pack<'info>>, salt: [u8; 32], amounts: [u64; SLOTS]) -> Result<()> {
        let lot_key = ctx.accounts.lot.key();
        {
            let lot = &ctx.accounts.lot;
            require!(lot.origin == origin::CONSIGNED && lot.status == status::CREATED && !lot.packed, PenlightError::WrongStatus);
            require!(lot.sealed, PenlightError::NotSealed);
        }
        let present = amounts.iter().filter(|a| **a > 0).count();
        require!(present > 0, PenlightError::EmptyLot);
        let rem = ctx.remaining_accounts;
        require!(rem.len() == present * 2, PenlightError::BadAccounts);
        let mut mints = [Pubkey::default(); SLOTS];
        let mut k = 0usize;
        for i in 0..SLOTS {
            let mint = ctx.accounts.house.catalogue[i].mint;
            mints[i] = mint;
            if amounts[i] == 0 {
                continue;
            }
            let from = &rem[k * 2];
            let to = &rem[k * 2 + 1];
            k += 1;
            let from_acc = Account::<TokenAccount>::try_from(from)?;
            let to_acc = Account::<TokenAccount>::try_from(to)?;
            require_keys_eq!(from_acc.owner, ctx.accounts.seller.key(), PenlightError::BadAccounts);
            require_keys_eq!(to_acc.owner, lot_key, PenlightError::BadAccounts);
            require_keys_eq!(from_acc.mint, mint, PenlightError::BadAccounts);
            require_keys_eq!(to_acc.mint, mint, PenlightError::BadAccounts);
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.key(),
                    SplTransfer { from: from.clone(), to: to.clone(), authority: ctx.accounts.seller.to_account_info() },
                ),
                amounts[i],
            )?;
        }
        let c = commitment::commitment(&lot_key, &salt, &mints, &amounts);
        require!(c == ctx.accounts.lot.commitment, PenlightError::CommitmentMismatch);
        let seal = &mut ctx.accounts.seal;
        seal.salt = salt;
        seal.amounts = amounts;
        ctx.accounts.lot.packed = true;
        Ok(())
    }

    /// Asks the VRF oracle — from inside the enclave — for the seed that decides
    /// which facts the lot will disclose (and, for House lots, what goes in).
    pub fn open(ctx: Context<Open>, client_seed: u8) -> Result<()> {
        {
            let lot = &ctx.accounts.lot;
            require!(lot.status == status::CREATED, PenlightError::WrongStatus);
            require!(lot.sealed, PenlightError::NotSealed);
            require!(lot.origin == origin::HOUSE || lot.packed, PenlightError::WrongStatus);
        }
        let ix = create_request_randomness_ix_const(
            RequestRandomnessParams {
                payer: ctx.accounts.payer.key(),
                oracle_queue: ctx.accounts.oracle_queue.key(),
                callback_program_id: crate::ID,
                callback_discriminator: instruction::OnShuffle::DISCRIMINATOR.to_vec(),
                caller_seed: [client_seed; 32],
                accounts_metas: Some(vec![
                    SerializableAccountMeta { pubkey: ctx.accounts.lot.key(), is_signer: false, is_writable: true },
                    SerializableAccountMeta { pubkey: ctx.accounts.seal.key(), is_signer: false, is_writable: true },
                ]),
                ..Default::default()
            },
            PROGRAM_IDENTITY,
        );
        ctx.accounts.lot.status = status::SHUFFLING;
        ctx.accounts.invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    /// VRF callback. The seed goes into the seal, not the public lot: nobody can
    /// predict the facts before they come out.
    pub fn on_shuffle(ctx: Context<OnShuffle>, randomness: [u8; 32]) -> Result<()> {
        if ctx.accounts.lot.status != status::SHUFFLING || ctx.accounts.seal.seeded {
            msg!("late or duplicate seed ignored");
            return Ok(());
        }
        let house_lot = ctx.accounts.lot.origin == origin::HOUSE;
        let seal = &mut ctx.accounts.seal;
        seal.seed = randomness;
        seal.seeded = true;
        if house_lot {
            seal.salt = rng::derive(&randomness, b"salt");
        }
        ctx.accounts.lot.status = status::SHUFFLED;
        Ok(())
    }

    /// House lots: the seed draws the contents from what the pool has free, and
    /// reserves them. Permissionless.
    /// remaining_accounts: pool_ata × SLOTS, feed × SLOTS.
    pub fn pack_from_pool<'info>(ctx: Context<'info, PackFromPool<'info>>) -> Result<()> {
        let lot_key = ctx.accounts.lot.key();
        {
            let lot = &ctx.accounts.lot;
            require!(lot.origin == origin::HOUSE && lot.status == status::SHUFFLED && !lot.packed, PenlightError::WrongStatus);
        }
        require!(ctx.accounts.pool.private, PenlightError::NotSealed);
        let rem = ctx.remaining_accounts;
        require!(rem.len() == SLOTS * 2, PenlightError::BadAccounts);
        let pool_key = ctx.accounts.pool.key();
        let prices = read_prices(&ctx.accounts.house, &rem[SLOTS..SLOTS * 2])?;

        let mut slots = [draw::PoolSlot::default(); SLOTS];
        let mut mints = [Pubkey::default(); SLOTS];
        for i in 0..SLOTS {
            let e = ctx.accounts.house.catalogue[i];
            mints[i] = e.mint;
            let balance = pool_balance(&rem[i], &pool_key, &e.mint)?;
            let free = balance.saturating_sub(ctx.accounts.pool.reserved[i]);
            slots[i] = draw::PoolSlot { balance: free, decimals: e.decimals, price_raw: prices[i], expo: e.expo };
        }
        let amounts = draw::draw(&ctx.accounts.seal.seed, &slots).ok_or(PenlightError::PoolTooSmall)?;
        let pool = &mut ctx.accounts.pool;
        for i in 0..SLOTS {
            pool.reserved[i] = pool.reserved[i].checked_add(amounts[i]).ok_or(PenlightError::Overflow)?;
        }
        let c = commitment::commitment(&lot_key, &ctx.accounts.seal.salt, &mints, &amounts);
        ctx.accounts.seal.amounts = amounts;
        let lot = &mut ctx.accounts.lot;
        lot.commitment = c;
        lot.packed = true;
        Ok(())
    }

    /// Posts the sealed lot to Solana and starts the clock a moment later.
    /// Permissionless.
    pub fn go_live(ctx: Context<GoLive>) -> Result<()> {
        {
            let lot = &mut ctx.accounts.lot;
            require!(lot.status == status::SHUFFLED && lot.packed, PenlightError::WrongStatus);
            lot.status = status::LIVE;
            lot.open_slot = Clock::get()?.slot + OPEN_DELAY_SLOTS;
        }
        ctx.accounts.lot.exit(&crate::ID)?;
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit(&[ctx.accounts.lot.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Writes every fact that is due into the public lot. Permissionless; the
    /// facts are computed here, inside the enclave, from the seal and live prices.
    /// remaining_accounts: feed × SLOTS.
    pub fn reveal<'info>(ctx: Context<'info, Reveal<'info>>) -> Result<()> {
        let slot = Clock::get()?.slot;
        let clock = ctx.accounts.lot.clock();
        require!(ctx.accounts.lot.status == status::LIVE, PenlightError::WrongStatus);
        let due = clock.hints_due(slot);
        let from = ctx.accounts.lot.hints_revealed;
        require!(due > from, PenlightError::TooEarly);
        let (items, prices) = items_now(&ctx.accounts.house, &ctx.accounts.seal.amounts, ctx.remaining_accounts)?;
        let seed = ctx.accounts.seal.seed;
        let lot = &mut ctx.accounts.lot;
        for i in from as usize..due as usize {
            let f = hints::render(&seed, i, &items);
            lot.hints[i] = HintRecord { kind: f.kind, sym: f.sym, a: f.a, b: f.b, slot: clock.hint_slot(i) };
            lot.hint_prices[i] = prices;
        }
        lot.hints_revealed = due;
        Ok(())
    }

    /// The race. Pays the clock price of the block this lands in and takes the
    /// lot. Payment and title move in this one transaction.
    pub fn take(ctx: Context<Take>, max_price: u64) -> Result<()> {
        let slot = Clock::get()?.slot;
        let usdc = ctx.accounts.house.usdc_mint;
        let lot = &ctx.accounts.lot;
        require!(lot.status == status::LIVE, PenlightError::WrongStatus);
        require!(slot >= lot.open_slot, PenlightError::TooEarly);
        require_keys_neq!(ctx.accounts.buyer.key(), lot.seller, PenlightError::SellerCannotTake);
        let price = lot.clock().price_at(slot);
        require!(price <= max_price, PenlightError::PriceAboveLimit);
        require_keys_eq!(ctx.accounts.buyer_usdc.mint, usdc, PenlightError::BadAccounts);
        require_keys_eq!(ctx.accounts.seller_usdc.mint, usdc, PenlightError::BadAccounts);
        require_keys_eq!(ctx.accounts.seller_usdc.owner, lot.seller, PenlightError::BadAccounts);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                SplTransfer {
                    from: ctx.accounts.buyer_usdc.to_account_info(),
                    to: ctx.accounts.seller_usdc.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            price,
        )?;
        let lot_key = ctx.accounts.lot.key();
        let lot = &mut ctx.accounts.lot;
        lot.winner = ctx.accounts.buyer.key();
        lot.paid = price;
        lot.sold_slot = slot;
        lot.status = status::SOLD;
        emit!(Sold { lot: lot_key, id: lot.id, winner: lot.winner, paid: price, slot });
        Ok(())
    }

    /// Opens a sold lot — or a lot whose clock ran out — inside the enclave:
    /// contents, salt and seed become public and the live oracle values them.
    /// Permissionless. remaining_accounts: feed × SLOTS.
    pub fn unseal<'info>(ctx: Context<'info, Unseal<'info>>) -> Result<()> {
        let slot = Clock::get()?.slot;
        let s = ctx.accounts.lot.status;
        let next = if s == status::SOLD {
            status::OPENED
        } else if s == status::LIVE && slot >= ctx.accounts.lot.clock().expiry_slot() {
            status::UNSOLD
        } else {
            return err!(PenlightError::WrongStatus);
        };
        let seal = &ctx.accounts.seal;
        let (items, prices) = items_now(&ctx.accounts.house, &seal.amounts, ctx.remaining_accounts)?;
        let lot = &mut ctx.accounts.lot;
        lot.amounts = seal.amounts;
        lot.salt = seal.salt;
        lot.seed = seal.seed;
        lot.delivery_prices = prices;
        lot.value_at_delivery = items.iter().map(|i| i.value).sum();
        lot.status = next;
        Ok(())
    }

    /// Moves an opened lot's tokens: to the winner if it sold, back to the seller
    /// if it didn't. House lots pay out of (or release) their pool reservation.
    /// Permissionless.
    /// remaining_accounts: [source_ata, destination_ata] for each slot with an
    /// amount, in slot order (none for an unsold House lot).
    pub fn deliver<'info>(ctx: Context<'info, Deliver<'info>>) -> Result<()> {
        let lot = &ctx.accounts.lot;
        let sold = lot.status == status::OPENED;
        require!(sold || lot.status == status::UNSOLD, PenlightError::WrongStatus);
        let house_lot = lot.origin == origin::HOUSE;
        let amounts = lot.amounts;

        if house_lot {
            let pool = &mut ctx.accounts.pool;
            for i in 0..SLOTS {
                pool.reserved[i] = pool.reserved[i].saturating_sub(amounts[i]);
            }
        }

        let moves = !(house_lot && !sold);
        if moves {
            let (source_owner, dest_owner) = if house_lot {
                (ctx.accounts.pool.key(), lot.winner)
            } else if sold {
                (lot.key(), lot.winner)
            } else {
                (lot.key(), lot.seller)
            };
            let present = amounts.iter().filter(|a| **a > 0).count();
            let rem = ctx.remaining_accounts;
            require!(rem.len() == present * 2, PenlightError::BadAccounts);

            let id_bytes = lot.id.to_le_bytes();
            let lot_bump = [lot.bump];
            let house_key = lot.house;
            let lot_seeds: &[&[u8]] = &[LOT_SEED, house_key.as_ref(), &id_bytes, &lot_bump];
            let pool_bump = [ctx.accounts.pool.bump];
            let pool_seeds: &[&[u8]] = &[POOL_SEED, house_key.as_ref(), &pool_bump];
            let (authority, seeds) = if house_lot {
                (ctx.accounts.pool.to_account_info(), pool_seeds)
            } else {
                (ctx.accounts.lot.to_account_info(), lot_seeds)
            };

            let mut k = 0usize;
            for i in 0..SLOTS {
                if amounts[i] == 0 {
                    continue;
                }
                let from = &rem[k * 2];
                let to = &rem[k * 2 + 1];
                k += 1;
                let mint = ctx.accounts.house.catalogue[i].mint;
                let from_acc = Account::<TokenAccount>::try_from(from)?;
                let to_acc = Account::<TokenAccount>::try_from(to)?;
                require_keys_eq!(from_acc.owner, source_owner, PenlightError::BadAccounts);
                require_keys_eq!(to_acc.owner, dest_owner, PenlightError::BadAccounts);
                require_keys_eq!(from_acc.mint, mint, PenlightError::BadAccounts);
                require_keys_eq!(to_acc.mint, mint, PenlightError::BadAccounts);
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.key(),
                        SplTransfer { from: from.clone(), to: to.clone(), authority: authority.clone() },
                        &[seeds],
                    ),
                    amounts[i],
                )?;
            }
        }
        ctx.accounts.lot.status = if sold { status::DELIVERED } else { status::EXPIRED };
        Ok(())
    }

    /// Commits the finished lot to Solana and returns it there for good.
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        let s = ctx.accounts.lot.status;
        require!(s == status::DELIVERED || s == status::EXPIRED, PenlightError::WrongStatus);
        ctx.accounts.lot.exit(&crate::ID)?;
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.lot.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }
}

// ───────────────────────────── helpers ─────────────────────────────

/// A permission counts only if the permission program owns an initialized
/// account at its address — lamports alone can be sent there by anyone.
fn permission_exists(info: &AccountInfo) -> bool {
    *info.owner == PERMISSION_PROGRAM_ID && !info.data_is_empty()
}

fn check_catalogue(catalogue: &[CatalogueEntry; SLOTS]) -> Result<()> {
    for e in catalogue.iter() {
        require!(e.mint != Pubkey::default() && e.feed != Pubkey::default(), PenlightError::BadCatalogue);
        require!(e.decimals <= 12 && e.expo <= 18, PenlightError::BadCatalogue);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn init_lot(
    house: &mut Account<House>,
    lot: &mut Account<Lot>,
    seal: &mut Account<Seal>,
    seller: Pubkey,
    lot_origin: u8,
    commitment: [u8; 32],
    start_price: u64,
    floor_price: u64,
    duration_slots: u64,
    bump: u8,
    seal_bump: u8,
) -> Result<()> {
    require!(floor_price > 0 && start_price > floor_price, PenlightError::BadPrices);
    require!(duration_slots >= 100, PenlightError::BadDuration);
    lot.house = house.key();
    lot.seller = seller;
    lot.id = house.lots_created;
    lot.origin = lot_origin;
    lot.status = status::CREATED;
    lot.commitment = commitment;
    lot.start_price = start_price;
    lot.floor_price = floor_price;
    lot.duration_slots = duration_slots;
    lot.created_at = Clock::get()?.unix_timestamp;
    lot.bump = bump;
    lot.seal_bump = seal_bump;
    seal.lot = lot.key();
    seal.bump = seal_bump;
    house.lots_created = house.lots_created.checked_add(1).ok_or(PenlightError::Overflow)?;
    Ok(())
}

/// An account pays for a permission inside the rollup, so it carries that rent
/// with it when it is delegated.
fn fund_permission_rent<'info>(payer: &Signer<'info>, target: &AccountInfo<'info>, system_program: &Program<'info, System>) -> Result<()> {
    let lamports = ephemeral_rollups_sdk::ephemeral_accounts::rent(EphemeralPermission::size_of(2) as u32);
    transfer_lamports(
        CpiContext::new(system_program.key(), LamportsTransfer { from: payer.to_account_info(), to: target.clone() }),
        lamports,
    )
}

/// Balance of the pool's token account for `mint`. A missing account (never
/// funded, or emptied and closed by the rollup) counts as zero, but only at the
/// pool's canonical address — nobody can hide pool stock behind another account.
fn pool_balance<'a>(info: &'a AccountInfo<'a>, pool: &Pubkey, mint: &Pubkey) -> Result<u64> {
    if info.data_is_empty() || *info.owner != TOKEN_PROGRAM_ID {
        require_keys_eq!(info.key(), get_associated_token_address(pool, mint), PenlightError::BadAccounts);
        return Ok(0);
    }
    let acc = Account::<TokenAccount>::try_from(info)?;
    require_keys_eq!(acc.owner, *pool, PenlightError::BadAccounts);
    require_keys_eq!(acc.mint, *mint, PenlightError::BadAccounts);
    Ok(acc.amount)
}

/// Validated raw prices for every catalogue slot, in catalogue order.
fn read_prices(house: &House, feeds: &[AccountInfo]) -> Result<[u64; SLOTS]> {
    require!(feeds.len() == SLOTS, PenlightError::BadAccounts);
    let now = Clock::get()?.unix_timestamp;
    let mut out = [0u64; SLOTS];
    for i in 0..SLOTS {
        let f = &feeds[i];
        require_keys_eq!(f.key(), house.catalogue[i].feed, PenlightError::OracleWrongFeed);
        let data = f.try_borrow_data()?;
        let p = oracle::parse_price(f.owner, f.key, &data, now, ORACLE_MAX_AGE_SECS).map_err(|e| match e {
            oracle::OracleFault::WrongFeed => PenlightError::OracleWrongFeed,
            oracle::OracleFault::Unverified => PenlightError::OracleUnverified,
            oracle::OracleFault::Stale => PenlightError::OracleStale,
            oracle::OracleFault::BadValue => PenlightError::OracleBadValue,
        })?;
        out[i] = p.raw;
    }
    Ok(out)
}

fn items_now(house: &House, amounts: &[u64; SLOTS], feeds: &[AccountInfo]) -> Result<([hints::Item; SLOTS], [u64; SLOTS])> {
    let prices = read_prices(house, feeds)?;
    let mut items = [hints::Item::default(); SLOTS];
    for i in 0..SLOTS {
        let e = &house.catalogue[i];
        let value = if amounts[i] == 0 {
            0
        } else {
            oracle::value_micros(amounts[i], e.decimals, prices[i], e.expo).ok_or(PenlightError::Overflow)?
        };
        items[i] = hints::Item { value, present: amounts[i] > 0, kind: e.kind };
    }
    Ok((items, prices))
}

// ───────────────────────────── events ─────────────────────────────

#[event]
pub struct Sold {
    pub lot: Pubkey,
    pub id: u64,
    pub winner: Pubkey,
    pub paid: u64,
    pub slot: u64,
}

// ───────────────────────────── accounts ─────────────────────────────

#[derive(Accounts)]
pub struct InitHouse<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + House::INIT_SPACE, seeds = [HOUSE_SEED, authority.key().as_ref()], bump)]
    pub house: Box<Account<'info, House>>,
    #[account(init, payer = authority, space = 8 + Pool::INIT_SPACE, seeds = [POOL_SEED, house.key().as_ref()], bump)]
    pub pool: Box<Account<'info, Pool>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetCatalogue<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority @ PenlightError::NotHouseAuthority)]
    pub house: Box<Account<'info, House>>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegatePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(has_one = authority @ PenlightError::NotHouseAuthority)]
    pub house: Box<Account<'info, House>>,
    /// CHECK: the pool PDA; delegated as-is.
    #[account(mut, del, seeds = [POOL_SEED, house.key().as_ref()], bump)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: must be the House's private-rollup validator.
    #[account(address = house.validator @ PenlightError::WrongValidator)]
    pub validator: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CreateLot<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub seller: Signer<'info>,
    #[account(mut)]
    pub house: Box<Account<'info, House>>,
    #[account(
        init,
        payer = payer,
        space = 8 + Lot::INIT_SPACE,
        seeds = [LOT_SEED, house.key().as_ref(), &house.lots_created.to_le_bytes()],
        bump
    )]
    pub lot: Box<Account<'info, Lot>>,
    #[account(init, payer = payer, space = 8 + Seal::INIT_SPACE, seeds = [SEAL_SEED, lot.key().as_ref()], bump)]
    pub seal: Box<Account<'info, Seal>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateHouseLot<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority @ PenlightError::NotHouseAuthority)]
    pub house: Box<Account<'info, House>>,
    #[account(
        init,
        payer = authority,
        space = 8 + Lot::INIT_SPACE,
        seeds = [LOT_SEED, house.key().as_ref(), &house.lots_created.to_le_bytes()],
        bump
    )]
    pub lot: Box<Account<'info, Lot>>,
    #[account(init, payer = authority, space = 8 + Seal::INIT_SPACE, seeds = [SEAL_SEED, lot.key().as_ref()], bump)]
    pub seal: Box<Account<'info, Seal>>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(id: u64)]
pub struct DelegateLot<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub house: Box<Account<'info, House>>,
    /// CHECK: the lot PDA; delegated as-is.
    #[account(mut, del, seeds = [LOT_SEED, house.key().as_ref(), &id.to_le_bytes()], bump)]
    pub lot: UncheckedAccount<'info>,
    /// CHECK: the lot's seal PDA; delegated as-is.
    #[account(mut, del, seeds = [SEAL_SEED, lot.key().as_ref()], bump)]
    pub seal: UncheckedAccount<'info>,
    /// CHECK: must be the House's private-rollup validator, where the seal stays private.
    #[account(address = house.validator @ PenlightError::WrongValidator)]
    pub validator: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct PoolPermission<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub pool: Box<Account<'info, Pool>>,
    /// CHECK: checked by the permission program.
    #[account(mut, seeds = [PERMISSION_SEED, pool.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: fixed program id.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: fixed vault id.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: fixed program id.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SealPermission<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub lot: Box<Account<'info, Lot>>,
    #[account(seeds = [SEAL_SEED, lot.key().as_ref()], bump = lot.seal_bump)]
    pub seal: Box<Account<'info, Seal>>,
    /// CHECK: checked by the permission program.
    #[account(mut, seeds = [PERMISSION_SEED, seal.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: fixed program id.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: fixed vault id.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: fixed program id.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Pack<'info> {
    pub seller: Signer<'info>,
    pub house: Box<Account<'info, House>>,
    #[account(mut, has_one = seller @ PenlightError::BadAccounts, has_one = house @ PenlightError::BadAccounts)]
    pub lot: Box<Account<'info, Lot>>,
    #[account(mut, seeds = [SEAL_SEED, lot.key().as_ref()], bump = lot.seal_bump)]
    pub seal: Box<Account<'info, Seal>>,
    pub token_program: Program<'info, Token>,
}

#[vrf]
#[derive(Accounts)]
pub struct Open<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub lot: Box<Account<'info, Lot>>,
    #[account(seeds = [SEAL_SEED, lot.key().as_ref()], bump = lot.seal_bump)]
    pub seal: Box<Account<'info, Seal>>,
    /// CHECK: the VRF oracle queue
    #[account(mut, constraint = oracle_queue.key() == mbvrf::consts::DEFAULT_EPHEMERAL_QUEUE @ PenlightError::BadAccounts)]
    pub oracle_queue: UncheckedAccount<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct OnShuffle<'info> {
    #[account(address = VRF_CALLBACK_IDENTITY)]
    pub vrf_program_identity: Signer<'info>,
    #[account(mut)]
    pub lot: Box<Account<'info, Lot>>,
    #[account(mut, seeds = [SEAL_SEED, lot.key().as_ref()], bump = lot.seal_bump)]
    pub seal: Box<Account<'info, Seal>>,
}

#[derive(Accounts)]
pub struct PackFromPool<'info> {
    pub payer: Signer<'info>,
    pub house: Box<Account<'info, House>>,
    #[account(mut, has_one = house @ PenlightError::BadAccounts)]
    pub lot: Box<Account<'info, Lot>>,
    #[account(mut, seeds = [SEAL_SEED, lot.key().as_ref()], bump = lot.seal_bump)]
    pub seal: Box<Account<'info, Seal>>,
    #[account(mut, seeds = [POOL_SEED, house.key().as_ref()], bump = house.pool_bump)]
    pub pool: Box<Account<'info, Pool>>,
}

#[commit]
#[derive(Accounts)]
pub struct GoLive<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub lot: Box<Account<'info, Lot>>,
}

#[derive(Accounts)]
pub struct Reveal<'info> {
    pub payer: Signer<'info>,
    pub house: Box<Account<'info, House>>,
    #[account(mut, has_one = house @ PenlightError::BadAccounts)]
    pub lot: Box<Account<'info, Lot>>,
    #[account(seeds = [SEAL_SEED, lot.key().as_ref()], bump = lot.seal_bump)]
    pub seal: Box<Account<'info, Seal>>,
}

#[derive(Accounts)]
pub struct Take<'info> {
    pub buyer: Signer<'info>,
    pub house: Box<Account<'info, House>>,
    #[account(mut, has_one = house @ PenlightError::BadAccounts)]
    pub lot: Box<Account<'info, Lot>>,
    #[account(mut, constraint = buyer_usdc.owner == buyer.key() @ PenlightError::BadAccounts)]
    pub buyer_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub seller_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Unseal<'info> {
    pub payer: Signer<'info>,
    pub house: Box<Account<'info, House>>,
    #[account(mut, has_one = house @ PenlightError::BadAccounts)]
    pub lot: Box<Account<'info, Lot>>,
    #[account(seeds = [SEAL_SEED, lot.key().as_ref()], bump = lot.seal_bump)]
    pub seal: Box<Account<'info, Seal>>,
}

#[derive(Accounts)]
pub struct Deliver<'info> {
    pub payer: Signer<'info>,
    pub house: Box<Account<'info, House>>,
    #[account(mut, has_one = house @ PenlightError::BadAccounts)]
    pub lot: Box<Account<'info, Lot>>,
    #[account(mut, seeds = [POOL_SEED, house.key().as_ref()], bump = house.pool_bump)]
    pub pool: Box<Account<'info, Pool>>,
    pub token_program: Program<'info, Token>,
}

#[commit]
#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub lot: Box<Account<'info, Lot>>,
}
