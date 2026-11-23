//! MagicBlock pricing oracle (Pyth Lazer republished inside the rollup).
//!
//! Decoded by hand: the feed is owned by the MagicBlock oracle program, so
//! Anchor's typed account would reject it, and a successful decode is not a
//! validation. Checked in order: owner, discriminator, verification level, feed
//! identity (the account address), republisher slot, freshness, value domain.
//! The stored exponent is not trusted; the catalogue carries the feed-list one.

use anchor_lang::prelude::Pubkey;

use crate::constants::{PRICING_ORACLE_PROGRAM, USD_DECIMALS};

pub const PRICE_UPDATE_DISCRIMINATOR: [u8; 8] = [234, 161, 14, 36, 172, 239, 15, 232];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OracleFault {
    WrongFeed,
    Unverified,
    Stale,
    BadValue,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Price {
    /// Raw integer price; real price = raw / 10^expo.
    pub raw: u64,
    pub publish_time: i64,
}

pub fn parse_price(
    owner: &Pubkey,
    key: &Pubkey,
    data: &[u8],
    now: i64,
    max_age: i64,
) -> Result<Price, OracleFault> {
    if *owner != PRICING_ORACLE_PROGRAM {
        return Err(OracleFault::WrongFeed);
    }
    if data.len() < 133 || data[0..8] != PRICE_UPDATE_DISCRIMINATOR {
        return Err(OracleFault::WrongFeed);
    }
    // 8..40 write authority; 40 = verification tag (1 = Full, 0 = Partial + 1 byte).
    let c = match data[40] {
        1 => 41usize,
        0 => return Err(OracleFault::Unverified),
        _ => return Err(OracleFault::WrongFeed),
    };
    if data[c..c + 32] != key.to_bytes() {
        return Err(OracleFault::WrongFeed);
    }
    let raw = i64::from_le_bytes(data[c + 32..c + 40].try_into().unwrap());
    let publish_time = i64::from_le_bytes(data[c + 52..c + 60].try_into().unwrap());
    let posted_slot = u64::from_le_bytes(data[c + 84..c + 92].try_into().unwrap());
    if posted_slot == 0 {
        return Err(OracleFault::Unverified);
    }
    if raw <= 0 {
        return Err(OracleFault::BadValue);
    }
    if publish_time > now.saturating_add(max_age) || now.saturating_sub(publish_time) > max_age {
        return Err(OracleFault::Stale);
    }
    Ok(Price { raw: raw as u64, publish_time })
}

/// Micro-dollar value of `amount` base units of a token with `decimals`, priced at
/// `price.raw / 10^expo`.
pub fn value_micros(amount: u64, decimals: u8, price_raw: u64, expo: u8) -> Option<u64> {
    let num = (amount as u128)
        .checked_mul(price_raw as u128)?
        .checked_mul(10u128.pow(USD_DECIMALS))?;
    let den = 10u128.checked_pow(decimals as u32 + expo as u32)?;
    u64::try_from(num / den).ok()
}

/// Base units of a token worth `micros` micro-dollars (rounded down).
pub fn amount_for_value(micros: u64, decimals: u8, price_raw: u64, expo: u8) -> Option<u64> {
    if price_raw == 0 {
        return None;
    }
    let num = (micros as u128).checked_mul(10u128.checked_pow(decimals as u32 + expo as u32)?)?;
    let den = (price_raw as u128).checked_mul(10u128.pow(USD_DECIMALS))?;
    u64::try_from(num / den).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_bytes(key: &Pubkey, raw: i64, publish: i64, posted: u64, level: u8) -> Vec<u8> {
        let mut d = vec![0u8; 134];
        d[0..8].copy_from_slice(&PRICE_UPDATE_DISCRIMINATOR);
        d[40] = level;
        let c = 41;
        d[c..c + 32].copy_from_slice(&key.to_bytes());
        d[c + 32..c + 40].copy_from_slice(&raw.to_le_bytes());
        d[c + 48..c + 52].copy_from_slice(&8i32.to_le_bytes());
        d[c + 52..c + 60].copy_from_slice(&publish.to_le_bytes());
        d[c + 84..c + 92].copy_from_slice(&posted.to_le_bytes());
        d
    }

    #[test]
    fn accepts_a_fresh_republished_update() {
        let k = Pubkey::new_unique();
        let d = feed_bytes(&k, 7_240_560_000, 1_000, 55, 1);
        let p = parse_price(&PRICING_ORACLE_PROGRAM, &k, &d, 1_010, 60).unwrap();
        assert_eq!(p.raw, 7_240_560_000);
    }

    #[test]
    fn rejects_wrong_owner_wrong_key_placeholder_stale_and_partial() {
        let k = Pubkey::new_unique();
        let good = feed_bytes(&k, 7_240_560_000, 1_000, 55, 1);
        assert_eq!(parse_price(&Pubkey::new_unique(), &k, &good, 1_000, 60), Err(OracleFault::WrongFeed));
        assert_eq!(parse_price(&PRICING_ORACLE_PROGRAM, &Pubkey::new_unique(), &good, 1_000, 60), Err(OracleFault::WrongFeed));
        let placeholder = feed_bytes(&k, 7_240_560_000, 1_000, 0, 1);
        assert_eq!(parse_price(&PRICING_ORACLE_PROGRAM, &k, &placeholder, 1_000, 60), Err(OracleFault::Unverified));
        assert_eq!(parse_price(&PRICING_ORACLE_PROGRAM, &k, &good, 1_061, 60), Err(OracleFault::Stale));
        assert_eq!(parse_price(&PRICING_ORACLE_PROGRAM, &k, &good, 900, 60), Err(OracleFault::Stale));
        let partial = feed_bytes(&k, 7_240_560_000, 1_000, 55, 0);
        assert_eq!(parse_price(&PRICING_ORACLE_PROGRAM, &k, &partial, 1_000, 60), Err(OracleFault::Unverified));
        let zero = feed_bytes(&k, 0, 1_000, 55, 1);
        assert_eq!(parse_price(&PRICING_ORACLE_PROGRAM, &k, &zero, 1_000, 60), Err(OracleFault::BadValue));
    }

    #[test]
    fn values_match_real_feed_scales() {
        // 0.31 SOL at $72.4056 (expo 8)
        assert_eq!(value_micros(310_000_000, 9, 7_240_560_000, 8), Some(22_445_736));
        // 420,000 BONK (5 decimals) at $0.0000216220 (expo 10)
        assert_eq!(value_micros(42_000_000_000, 5, 216_220, 10), Some(9_081_240));
        // round trip
        let amt = amount_for_value(9_081_240, 5, 216_220, 10).unwrap();
        assert!((amt as i128 - 42_000_000_000i128).abs() < 10_000);
    }
}
