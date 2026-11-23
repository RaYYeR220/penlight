//! Which facts a lot discloses, and their exact wording in numbers.
//!
//! Pure: no accounts, no clock. The program calls it inside the enclave with the
//! sealed contents and live oracle values; the SDK runs the same code paths in
//! TypeScript (checked against vectors produced here).
//!
//! Every fact is TRUE for the contents and prices it was rendered with. The VRF
//! seed decides which facts, which tokens they mention, and where bands sit; the
//! seller decides none of it.

use crate::constants::{HINTS, KIND_MEME, SLOTS};
use crate::rng::Stream;

pub const H_COUNT: u8 = 1; // "a kinds of token inside"
pub const H_CONTAINS: u8 = 2; // "contains sym"
pub const H_ABSENT: u8 = 3; // "no sym"
pub const H_MEMES: u8 = 4; // "a memecoins inside"
pub const H_ABOVE: u8 = 5; // "total value is above $a"
pub const H_BELOW: u8 = 6; // "total value is below $a"
pub const H_TOP_SHARE: u8 = 7; // "the largest item is at least a% of the value"
pub const H_TOP_BAND: u8 = 8; // "the largest item is worth $a–$b"
pub const H_ITEM_BAND: u8 = 9; // "the sym inside is worth $a–$b"

pub const NO_SYM: u8 = 255;
const CENT: u64 = 10_000; // micro-dollars

// Templates (what the plan picks); a template renders to one hint kind.
const T_COUNT: u8 = 1;
const T_CONTAINS: u8 = 2;
const T_ABSENT: u8 = 3;
const T_MEMES: u8 = 4;
const T_TOTAL_WIDE: u8 = 5;
const T_TOP_SHARE: u8 = 6;
const T_TOP_BAND: u8 = 7;
const T_ITEM_BAND: u8 = 8;
const T_TOTAL_NARROW: u8 = 9;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Item {
    /// Micro-dollar value at render time; 0 means the slot is empty.
    pub value: u64,
    pub present: bool,
    pub kind: u8,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Fact {
    pub kind: u8,
    pub sym: u8,
    pub a: u64,
    pub b: u64,
}

fn present_count(items: &[Item; SLOTS]) -> usize {
    items.iter().filter(|i| i.present).count()
}

fn top_index(items: &[Item; SLOTS]) -> Option<usize> {
    let mut best: Option<usize> = None;
    for (i, it) in items.iter().enumerate() {
        if it.present && best.map_or(true, |b| it.value > items[b].value) {
            best = Some(i);
        }
    }
    best
}

fn total(items: &[Item; SLOTS]) -> u64 {
    items.iter().filter(|i| i.present).map(|i| i.value).sum()
}

fn pick_from(stream: &mut Stream, options: &[u8]) -> u8 {
    options[stream.below(options.len() as u64) as usize]
}

/// The five templates for a lot, decided by the seed and the shape of the
/// contents (never by values, which move with the market).
pub fn plan(seed: &[u8; 32], items: &[Item; SLOTS]) -> [u8; HINTS] {
    let k = present_count(items);
    let mut s = Stream::new(seed, 1);

    let mut tier1: Vec<u8> = vec![T_COUNT, T_MEMES];
    if k >= 1 {
        tier1.push(T_CONTAINS);
    }
    if k < SLOTS {
        tier1.push(T_ABSENT);
    }
    let first = pick_from(&mut s, &tier1);
    tier1.retain(|t| *t != first);
    let second = pick_from(&mut s, &tier1);

    let third = if k >= 2 { pick_from(&mut s, &[T_TOTAL_WIDE, T_TOP_SHARE]) } else { T_TOTAL_WIDE };

    let mut tier3: Vec<u8> = vec![T_TOP_BAND, T_TOTAL_NARROW];
    if k >= 2 {
        tier3.push(T_ITEM_BAND);
    }
    let fourth = pick_from(&mut s, &tier3);
    tier3.retain(|t| *t != fourth);
    let fifth = pick_from(&mut s, &tier3);

    [first, second, third, fourth, fifth]
}

/// Render fact `index` for these contents at these values.
pub fn render(seed: &[u8; 32], index: usize, items: &[Item; SLOTS]) -> Fact {
    let template = plan(seed, items)[index];
    let mut s = Stream::new(seed, 10 + index as u8);
    let k = present_count(items);
    let v = total(items);

    match template {
        T_COUNT => Fact { kind: H_COUNT, sym: NO_SYM, a: k as u64, b: 0 },
        T_MEMES => {
            let m = items.iter().filter(|i| i.present && i.kind == KIND_MEME).count();
            Fact { kind: H_MEMES, sym: NO_SYM, a: m as u64, b: 0 }
        }
        T_CONTAINS => {
            let opts: Vec<u8> = (0..SLOTS as u8).filter(|i| items[*i as usize].present).collect();
            Fact { kind: H_CONTAINS, sym: pick_from(&mut s, &opts), a: 0, b: 0 }
        }
        T_ABSENT => {
            let opts: Vec<u8> = (0..SLOTS as u8).filter(|i| !items[*i as usize].present).collect();
            Fact { kind: H_ABSENT, sym: pick_from(&mut s, &opts), a: 0, b: 0 }
        }
        T_TOTAL_WIDE | T_TOTAL_NARROW => {
            // d in basis points: wide 2000–4000, narrow 500–1500.
            let (lo_bps, span_bps) = if template == T_TOTAL_WIDE { (2_000u64, 2_001u64) } else { (500, 1_001) };
            let d = lo_bps + s.below(span_bps);
            if s.below(2) == 0 {
                let x = (v as u128 * (10_000 - d) as u128 / 10_000) as u64;
                Fact { kind: H_ABOVE, sym: NO_SYM, a: x / CENT * CENT, b: 0 }
            } else {
                let x = (v as u128 * (10_000 + d) as u128 / 10_000) as u64;
                Fact { kind: H_BELOW, sym: NO_SYM, a: x.div_ceil(CENT) * CENT, b: 0 }
            }
        }
        T_TOP_SHARE => {
            let t = top_index(items).map(|i| items[i].value).unwrap_or(0);
            let pct = if v == 0 { 0 } else { t as u128 * 100 / v as u128 } as u64;
            Fact { kind: H_TOP_SHARE, sym: NO_SYM, a: pct / 10 * 10, b: 0 }
        }
        T_TOP_BAND => {
            let t = top_index(items).map(|i| items[i].value).unwrap_or(0);
            let (a, b) = band(t, 3_000, &mut s);
            Fact { kind: H_TOP_BAND, sym: NO_SYM, a, b }
        }
        _ => {
            // T_ITEM_BAND: a present item that is not the largest.
            let top = top_index(items);
            let opts: Vec<u8> = (0..SLOTS as u8)
                .filter(|i| items[*i as usize].present && Some(*i as usize) != top)
                .collect();
            let j = if opts.is_empty() { top.unwrap_or(0) as u8 } else { pick_from(&mut s, &opts) };
            let (a, b) = band(items[j as usize].value, 4_000, &mut s);
            Fact { kind: H_ITEM_BAND, sym: j, a, b }
        }
    }
}

/// A band of width `width_bps` of `x` that contains `x`, with its position drawn
/// from the stream, rounded outward to cents.
fn band(x: u64, width_bps: u64, s: &mut Stream) -> (u64, u64) {
    let width = (x as u128 * width_bps as u128 / 10_000) as u64;
    let offset = if width == 0 { 0 } else { s.below(width + 1) };
    let lo = x.saturating_sub(offset);
    let hi = lo.saturating_add(width);
    (lo / CENT * CENT, hi.div_ceil(CENT) * CENT)
}

/// True if `fact` holds for `items`. Used by tests and by `verify`.
pub fn holds(fact: &Fact, items: &[Item; SLOTS]) -> bool {
    let k = present_count(items) as u64;
    let v = total(items);
    match fact.kind {
        H_COUNT => fact.a == k,
        H_CONTAINS => (fact.sym as usize) < SLOTS && items[fact.sym as usize].present,
        H_ABSENT => (fact.sym as usize) < SLOTS && !items[fact.sym as usize].present,
        H_MEMES => fact.a == items.iter().filter(|i| i.present && i.kind == KIND_MEME).count() as u64,
        H_ABOVE => v >= fact.a,
        H_BELOW => v <= fact.a,
        H_TOP_SHARE => {
            let t = top_index(items).map(|i| items[i].value).unwrap_or(0) as u128;
            v == 0 || t * 100 >= fact.a as u128 * v as u128
        }
        H_TOP_BAND => {
            let t = top_index(items).map(|i| items[i].value).unwrap_or(0);
            fact.a <= t && t <= fact.b
        }
        H_ITEM_BAND => {
            let j = fact.sym as usize;
            j < SLOTS && items[j].present && fact.a <= items[j].value && items[j].value <= fact.b
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{KIND_DEFI, KIND_MAJOR};

    const KINDS: [u8; SLOTS] = [KIND_MAJOR, KIND_MEME, KIND_MEME, KIND_DEFI, KIND_DEFI, KIND_DEFI, KIND_DEFI, KIND_MEME];

    fn lot(values: [u64; SLOTS]) -> [Item; SLOTS] {
        let mut items = [Item::default(); SLOTS];
        for i in 0..SLOTS {
            items[i] = Item { value: values[i], present: values[i] > 0, kind: KINDS[i] };
        }
        items
    }

    fn seed(n: u64) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0..8].copy_from_slice(&n.to_le_bytes());
        s
    }

    #[test]
    fn every_fact_is_true_across_many_lots() {
        let mut gen = Stream::new(&[42u8; 32], 99);
        for n in 0..3_000u64 {
            let mut values = [0u64; SLOTS];
            let k = 1 + gen.below(SLOTS as u64) as usize;
            for _ in 0..k {
                let j = gen.below(SLOTS as u64) as usize;
                values[j] = 10_000 + gen.below(40_000_000);
            }
            let items = lot(values);
            for i in 0..HINTS {
                let f = render(&seed(n), i, &items);
                assert!(holds(&f, &items), "fact {i} false for seed {n}: {f:?} {values:?}");
            }
        }
    }

    #[test]
    fn plan_never_repeats_a_template() {
        for n in 0..2_000u64 {
            let items = lot([22_445_736, 9_081_240, 0, 9_160_000, 0, 0, 0, 0]);
            let p = plan(&seed(n), &items);
            for i in 0..HINTS {
                for j in (i + 1)..HINTS {
                    assert_ne!(p[i], p[j], "seed {n}: {p:?}");
                }
            }
        }
    }

    #[test]
    fn single_item_lots_never_ask_for_impossible_facts() {
        for n in 0..500u64 {
            let items = lot([0, 0, 0, 0, 5_000_000, 0, 0, 0]);
            for i in 0..HINTS {
                assert!(holds(&render(&seed(n), i, &items), &items));
            }
        }
    }

    #[test]
    fn full_lots_never_claim_an_absent_token() {
        for n in 0..500u64 {
            let items = lot([1_000_000; SLOTS]);
            for i in 0..HINTS {
                let f = render(&seed(n), i, &items);
                assert_ne!(f.kind, H_ABSENT);
                assert!(holds(&f, &items));
            }
        }
    }

    #[test]
    fn negative_control_wrong_contents_fail() {
        // A fact rendered for one lot must not silently hold for a different lot.
        let a = lot([22_445_736, 9_081_240, 0, 9_160_000, 0, 0, 0, 0]);
        let b = lot([0, 0, 13_840_000, 0, 12_620_000, 4_110_000, 4_400_000, 0]);
        let mut contradicted = 0;
        for n in 0..200u64 {
            for i in 0..HINTS {
                if !holds(&render(&seed(n), i, &a), &b) {
                    contradicted += 1;
                }
            }
        }
        assert!(contradicted > 500, "facts should discriminate between lots, got {contradicted}");
    }

    #[test]
    fn same_seed_same_facts() {
        let items = lot([22_445_736, 9_081_240, 0, 9_160_000, 0, 0, 0, 0]);
        for i in 0..HINTS {
            assert_eq!(render(&seed(7), i, &items), render(&seed(7), i, &items));
        }
    }
}
