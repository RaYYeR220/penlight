use anchor_lang::prelude::*;

pub const HOUSE_SEED: &[u8] = b"house";
pub const LOT_SEED: &[u8] = b"lot";
pub const SEAL_SEED: &[u8] = b"seal";
pub const POOL_SEED: &[u8] = b"pool";

/// Number of token kinds a lot can hold. Every lot carries one slot per kind so
/// the shape of its transactions never depends on what is inside.
pub const SLOTS: usize = 8;
/// Facts a lot discloses while its clock runs.
pub const HINTS: usize = 5;
/// Where on the clock each fact comes out, in basis points of the clock length.
pub const HINT_AT_BPS: [u64; HINTS] = [1_500, 3_000, 4_500, 6_000, 7_500];

/// The clock opens this many rollup blocks after the lot's seal is sent to Solana.
pub const OPEN_DELAY_SLOTS: u64 = 150;
/// After the clock reaches its floor it waits this share of its length before the
/// lot can be returned unsold.
pub const GRACE_BPS: u64 = 2_000;

/// Oldest oracle publish time accepted, in seconds.
pub const ORACLE_MAX_AGE_SECS: i64 = 60;
/// Values are kept in micro-dollars.
pub const USD_DECIMALS: u32 = 6;

/// Pool lots: total value drawn uniformly in this band (micro-dollars).
pub const POOL_VALUE_MIN: u64 = 8_000_000;
pub const POOL_VALUE_MAX: u64 = 48_000_000;
pub const POOL_KINDS_MIN: u8 = 2;
pub const POOL_KINDS_MAX: u8 = 5;

pub const PRICING_ORACLE_PROGRAM: Pubkey = pubkey!("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");

/// Catalogue entry kinds, used by some facts ("2 memecoins inside").
pub const KIND_MAJOR: u8 = 0;
pub const KIND_MEME: u8 = 1;
pub const KIND_DEFI: u8 = 2;
