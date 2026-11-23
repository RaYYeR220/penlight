//! The seal: sha256 over the lot address, a secret salt, and every slot's mint
//! and amount (empty slots included, so the preimage has one fixed shape).

use anchor_lang::prelude::Pubkey;

use crate::constants::SLOTS;

pub const DOMAIN: &[u8] = b"penlight-v1";

pub fn commitment(lot: &Pubkey, salt: &[u8; 32], mints: &[Pubkey; SLOTS], amounts: &[u64; SLOTS]) -> [u8; 32] {
    let mut pre: Vec<u8> = Vec::with_capacity(DOMAIN.len() + 32 + 32 + SLOTS * 40);
    pre.extend_from_slice(DOMAIN);
    pre.extend_from_slice(lot.as_ref());
    pre.extend_from_slice(salt);
    for i in 0..SLOTS {
        pre.extend_from_slice(mints[i].as_ref());
        pre.extend_from_slice(&amounts[i].to_le_bytes());
    }
    solana_sha256_hasher::hash(&pre).to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn any_change_breaks_the_seal() {
        let lot = Pubkey::new_unique();
        let mints: [Pubkey; SLOTS] = core::array::from_fn(|_| Pubkey::new_unique());
        let amounts = [1, 0, 3, 0, 0, 0, 0, 9];
        let salt = [5u8; 32];
        let c = commitment(&lot, &salt, &mints, &amounts);
        assert_eq!(c, commitment(&lot, &salt, &mints, &amounts));
        let mut a2 = amounts;
        a2[7] = 8;
        assert_ne!(c, commitment(&lot, &salt, &mints, &a2));
        assert_ne!(c, commitment(&lot, &[6u8; 32], &mints, &amounts));
        assert_ne!(c, commitment(&Pubkey::new_unique(), &salt, &mints, &amounts));
    }
}
