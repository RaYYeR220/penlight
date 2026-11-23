use anchor_lang::prelude::*;

use crate::clock::ClockParams;
use crate::constants::{HINTS, SLOTS};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, Debug, PartialEq, Eq)]
pub struct CatalogueEntry {
    pub mint: Pubkey,
    /// MagicBlock oracle feed account (also the stored feed id).
    pub feed: Pubkey,
    pub decimals: u8,
    /// Magnitude of the feed-list exponent (price = raw / 10^expo).
    pub expo: u8,
    pub kind: u8,
    pub symbol: [u8; 8],
}

#[account]
#[derive(InitSpace)]
pub struct House {
    pub authority: Pubkey,
    pub usdc_mint: Pubkey,
    pub catalogue: [CatalogueEntry; SLOTS],
    pub lots_created: u64,
    /// The private-rollup (TEE) validator lots and the pool may be delegated to.
    pub validator: Pubkey,
    pub bump: u8,
    pub pool_bump: u8,
}

pub mod origin {
    /// Packed by a seller who knows what is inside.
    pub const CONSIGNED: u8 = 0;
    /// Packed by the seed from the House pool; nobody chose the contents.
    pub const HOUSE: u8 = 1;
}

pub mod status {
    pub const CREATED: u8 = 0;
    pub const SHUFFLING: u8 = 1;
    pub const SHUFFLED: u8 = 2;
    pub const LIVE: u8 = 3;
    pub const SOLD: u8 = 4;
    pub const DELIVERED: u8 = 5;
    pub const EXPIRED: u8 = 6;
    /// Sold and opened; contents public, tokens not yet moved to the winner.
    pub const OPENED: u8 = 7;
    /// Clock ran out; opened, tokens not yet back with the seller.
    pub const UNSOLD: u8 = 8;
}

/// The House pool's private ledger. Pool tokens stay in the pool's own accounts;
/// a House lot is a reservation against them until it is delivered.
#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub house: Pubkey,
    pub reserved: [u64; SLOTS],
    /// Set once the ledger's no-reader permission exists.
    pub private: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, Debug, PartialEq, Eq)]
pub struct HintRecord {
    pub kind: u8,
    pub sym: u8,
    pub a: u64,
    pub b: u64,
    /// The clock slot this fact was due at.
    pub slot: u64,
}

/// Public state of a lot. Everything a bidder needs is here; nothing in here says
/// what is inside until the lot is opened.
#[account]
#[derive(InitSpace)]
pub struct Lot {
    pub house: Pubkey,
    pub seller: Pubkey,
    pub id: u64,
    pub origin: u8,
    pub status: u8,
    /// Set once the seal's permission exists; nothing touches the seal before.
    pub sealed: bool,
    pub packed: bool,
    pub commitment: [u8; 32],
    pub start_price: u64,
    pub floor_price: u64,
    pub duration_slots: u64,
    pub open_slot: u64,
    pub hints_revealed: u8,
    pub hints: [HintRecord; HINTS],
    /// Oracle prices each fact was computed with (public data), so anyone can
    /// re-derive every fact exactly once the lot is opened.
    pub hint_prices: [[u64; SLOTS]; HINTS],
    pub winner: Pubkey,
    pub paid: u64,
    pub sold_slot: u64,
    /// Micro-dollar value of the contents at delivery, from the live oracle.
    pub value_at_delivery: u64,
    pub delivery_prices: [u64; SLOTS],
    /// Published when the lot is opened.
    pub amounts: [u64; SLOTS],
    pub salt: [u8; 32],
    pub seed: [u8; 32],
    pub created_at: i64,
    pub bump: u8,
    pub seal_bump: u8,
}

impl Lot {
    pub fn clock(&self) -> ClockParams {
        ClockParams {
            start_price: self.start_price,
            floor_price: self.floor_price,
            open_slot: self.open_slot,
            duration_slots: self.duration_slots,
        }
    }
}

/// Private state of a lot. Lives in the enclave behind a permission with no
/// readers; only the program touches it.
#[account]
#[derive(InitSpace)]
pub struct Seal {
    pub lot: Pubkey,
    pub salt: [u8; 32],
    pub amounts: [u64; SLOTS],
    pub seed: [u8; 32],
    pub seeded: bool,
    pub bump: u8,
}
