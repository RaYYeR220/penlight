//! Writes cross-language test vectors (run: PENLIGHT_VECTORS=path cargo test vectors).

#[cfg(test)]
mod tests {
    use crate::constants::{HINTS, KIND_DEFI, KIND_MAJOR, KIND_MEME, SLOTS};
    use crate::draw::{draw, PoolSlot};
    use crate::hints::{plan, render, Item};
    use crate::rng::Stream;
    use anchor_lang::prelude::Pubkey;

    const KINDS: [u8; SLOTS] = [KIND_MAJOR, KIND_MEME, KIND_MEME, KIND_DEFI, KIND_DEFI, KIND_DEFI, KIND_DEFI, KIND_MEME];

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    #[test]
    fn vectors() {
        let Ok(path) = std::env::var("PENLIGHT_VECTORS") else { return };
        let mut gen = Stream::new(&[9u8; 32], 7);
        let mut out = String::from("{\"facts\":[");
        for n in 0..300u64 {
            let mut seed = [0u8; 32];
            for c in seed.chunks_mut(8) {
                c.copy_from_slice(&gen.next_u64().to_le_bytes());
            }
            let mut items = [Item::default(); SLOTS];
            let k = 1 + gen.below(SLOTS as u64) as usize;
            for _ in 0..k {
                let j = gen.below(SLOTS as u64) as usize;
                items[j] = Item { value: 5_000 + gen.below(60_000_000), present: true, kind: KINDS[j] };
            }
            for j in 0..SLOTS {
                items[j].kind = KINDS[j];
            }
            let p = plan(&seed, &items);
            let facts: Vec<String> = (0..HINTS)
                .map(|i| {
                    let f = render(&seed, i, &items);
                    format!("{{\"kind\":{},\"sym\":{},\"a\":\"{}\",\"b\":\"{}\"}}", f.kind, f.sym, f.a, f.b)
                })
                .collect();
            let its: Vec<String> = items.iter().map(|i| format!("{{\"value\":\"{}\",\"present\":{},\"kind\":{}}}", i.value, i.present, i.kind)).collect();
            if n > 0 {
                out.push(',');
            }
            out.push_str(&format!("{{\"seed\":\"{}\",\"items\":[{}],\"plan\":{:?},\"facts\":[{}]}}", hex(&seed), its.join(","), p, facts.join(",")));
        }
        out.push_str("],\"draws\":[");
        let spec = [(9u8, 7_240_560_000u64, 8u8), (5, 216_220, 10), (6, 12_361_600, 8), (6, 24_106_400, 8),
            (9, 24_439_200, 8), (6, 5_103_070, 8), (6, 132_872_000, 8), (9, 2_569_740, 8)];
        for n in 0..100u64 {
            let mut seed = [0u8; 32];
            for c in seed.chunks_mut(8) {
                c.copy_from_slice(&gen.next_u64().to_le_bytes());
            }
            let mut pool = [PoolSlot::default(); SLOTS];
            for i in 0..SLOTS {
                let bal = if gen.below(5) == 0 { 0 } else { gen.below(1u64 << 50) };
                pool[i] = PoolSlot { balance: bal, decimals: spec[i].0, price_raw: spec[i].1, expo: spec[i].2 };
            }
            let a = draw(&seed, &pool);
            let ps: Vec<String> = pool.iter().map(|p| format!("{{\"balance\":\"{}\",\"decimals\":{},\"priceRaw\":\"{}\",\"expo\":{}}}", p.balance, p.decimals, p.price_raw, p.expo)).collect();
            let amts = match a {
                Some(v) => format!("[{}]", v.iter().map(|x| format!("\"{x}\"")).collect::<Vec<_>>().join(",")),
                None => "null".into(),
            };
            if n > 0 {
                out.push(',');
            }
            out.push_str(&format!("{{\"seed\":\"{}\",\"pool\":[{}],\"amounts\":{}}}", hex(&seed), ps.join(","), amts));
        }
        out.push_str("],\"commitments\":[");
        for n in 0..5u8 {
            let lot = Pubkey::new_from_array([n + 1; 32]);
            let mints: [Pubkey; SLOTS] = core::array::from_fn(|i| Pubkey::new_from_array([n + 10 + i as u8; 32]));
            let amounts: [u64; SLOTS] = core::array::from_fn(|i| (i as u64 + 1) * 1_000 * n as u64);
            let salt = [n + 100; 32];
            let c = crate::commitment::commitment(&lot, &salt, &mints, &amounts);
            if n > 0 {
                out.push(',');
            }
            out.push_str(&format!(
                "{{\"lot\":\"{}\",\"salt\":\"{}\",\"mints\":[{}],\"amounts\":[{}],\"commitment\":\"{}\"}}",
                lot, hex(&salt),
                mints.iter().map(|m| format!("\"{m}\"")).collect::<Vec<_>>().join(","),
                amounts.iter().map(|x| format!("\"{x}\"")).collect::<Vec<_>>().join(","),
                hex(&c)
            ));
        }
        out.push_str("]}");
        std::fs::write(path, out).unwrap();
    }
}
