//! House lots are packed by the seed, inside the enclave, from the House's pooled
//! inventory. Nobody — including the House — chooses what goes in.

use crate::constants::{POOL_KINDS_MAX, POOL_KINDS_MIN, POOL_VALUE_MAX, POOL_VALUE_MIN, SLOTS};
use crate::oracle::amount_for_value;
use crate::rng::Stream;

#[derive(Clone, Copy, Debug, Default)]
pub struct PoolSlot {
    pub balance: u64,
    pub decimals: u8,
    pub price_raw: u64,
    pub expo: u8,
}

/// Amounts to move from the pool into a new lot. Each chosen kind gets a
/// random share of a random total value, converted at the live price and capped
/// by what the pool holds. Returns None when the pool cannot form a lot.
pub fn draw(seed: &[u8; 32], pool: &[PoolSlot; SLOTS]) -> Option<[u64; SLOTS]> {
    let mut s = Stream::new(seed, 50);
    let mut available: Vec<usize> = (0..SLOTS).filter(|i| pool[*i].balance > 0 && pool[*i].price_raw > 0).collect();
    if available.is_empty() {
        return None;
    }
    let span = (POOL_KINDS_MAX - POOL_KINDS_MIN + 1) as u64;
    let k = ((POOL_KINDS_MIN as u64 + s.below(span)) as usize).min(available.len());

    // Partial Fisher–Yates: the first k entries become the chosen kinds.
    for i in 0..k {
        let j = i + s.below((available.len() - i) as u64) as usize;
        available.swap(i, j);
    }
    let chosen = &available[..k];

    let target = POOL_VALUE_MIN + s.below(POOL_VALUE_MAX - POOL_VALUE_MIN + 1);
    let weights: Vec<u64> = chosen.iter().map(|_| 1 + s.below(100)).collect();
    let wsum: u64 = weights.iter().sum();

    let mut amounts = [0u64; SLOTS];
    for (idx, &slot) in chosen.iter().enumerate() {
        let share = (target as u128 * weights[idx] as u128 / wsum as u128) as u64;
        let p = &pool[slot];
        let amount = amount_for_value(share, p.decimals, p.price_raw, p.expo)?.min(p.balance);
        amounts[slot] = amount;
    }
    if amounts.iter().all(|a| *a == 0) {
        return None;
    }
    Some(amounts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oracle::value_micros;

    fn pool() -> [PoolSlot; SLOTS] {
        let spec = [(9u8, 7_240_560_000u64, 8u8), (5, 216_220, 10), (6, 12_361_600, 8), (6, 24_106_400, 8),
            (9, 24_439_200, 8), (6, 5_103_070, 8), (6, 132_872_000, 8), (9, 2_569_740, 8)];
        let mut p = [PoolSlot::default(); SLOTS];
        for i in 0..SLOTS {
            p[i] = PoolSlot { balance: u64::MAX / 4, decimals: spec[i].0, price_raw: spec[i].1, expo: spec[i].2 };
        }
        p
    }

    fn seed(n: u64) -> [u8; 32] {
        let mut s = [3u8; 32];
        s[0..8].copy_from_slice(&n.to_le_bytes());
        s
    }

    #[test]
    fn draws_land_in_the_value_band_with_2_to_5_kinds() {
        let p = pool();
        for n in 0..2_000u64 {
            let a = draw(&seed(n), &p).unwrap();
            let kinds = a.iter().filter(|x| **x > 0).count();
            assert!((2..=5).contains(&kinds), "seed {n}: {kinds} kinds");
            let v: u64 = (0..SLOTS).map(|i| value_micros(a[i], p[i].decimals, p[i].price_raw, p[i].expo).unwrap()).sum();
            assert!(v <= POOL_VALUE_MAX && v + 100 >= POOL_VALUE_MIN.saturating_sub(100) , "seed {n}: value {v}");
        }
    }

    #[test]
    fn never_takes_more_than_the_pool_holds() {
        let mut p = pool();
        for s in p.iter_mut() {
            s.balance = 1_000;
        }
        for n in 0..200u64 {
            if let Some(a) = draw(&seed(n), &p) {
                for i in 0..SLOTS {
                    assert!(a[i] <= 1_000);
                }
            }
        }
    }

    #[test]
    fn empty_pool_cannot_draw() {
        let mut p = pool();
        for s in p.iter_mut() {
            s.balance = 0;
        }
        assert!(draw(&seed(1), &p).is_none());
    }
}
