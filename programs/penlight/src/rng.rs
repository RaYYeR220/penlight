//! Deterministic draws from a VRF seed. Every consumer (the program, the SDK, the
//! eval) expands the seed the same way: sha256(seed ‖ tag ‖ counter_le).

pub struct Stream {
    seed: [u8; 32],
    tag: u8,
    counter: u32,
}

impl Stream {
    pub fn new(seed: &[u8; 32], tag: u8) -> Self {
        Self { seed: *seed, tag, counter: 0 }
    }

    pub fn next_u64(&mut self) -> u64 {
        let out = solana_sha256_hasher::hashv(&[&self.seed, &[self.tag], &self.counter.to_le_bytes()]).to_bytes();
        self.counter += 1;
        u64::from_le_bytes(out[0..8].try_into().unwrap())
    }

    /// Uniform in [0, n). n must be > 0.
    pub fn below(&mut self, n: u64) -> u64 {
        // Rejection sampling keeps the draw unbiased for any n.
        let zone = u64::MAX - (u64::MAX % n);
        loop {
            let v = self.next_u64();
            if v < zone {
                return v % n;
            }
        }
    }
}

pub fn derive(seed: &[u8; 32], label: &[u8]) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[seed, label]).to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_seed_same_stream() {
        let s = [7u8; 32];
        let mut a = Stream::new(&s, 1);
        let mut b = Stream::new(&s, 1);
        for _ in 0..10 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
        let mut c = Stream::new(&s, 2);
        assert_ne!(Stream::new(&s, 1).next_u64(), c.next_u64());
    }

    #[test]
    fn below_stays_in_range() {
        let mut a = Stream::new(&[1u8; 32], 9);
        for n in 1..50u64 {
            assert!(a.below(n) < n);
        }
    }
}
