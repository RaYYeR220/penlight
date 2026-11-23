//! The falling clock. Price is a pure function of the rollup slot, so a TAKE pays
//! exactly the price of the block it lands in and every client can draw the same
//! clock without asking anyone.

use crate::constants::{GRACE_BPS, HINTS, HINT_AT_BPS};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClockParams {
    pub start_price: u64,
    pub floor_price: u64,
    pub open_slot: u64,
    pub duration_slots: u64,
}

impl ClockParams {
    /// Linear fall from `start_price` to `floor_price` over `duration_slots`, then
    /// flat at the floor. Before the open slot the price is the start price.
    pub fn price_at(&self, slot: u64) -> u64 {
        if slot <= self.open_slot || self.duration_slots == 0 {
            return self.start_price;
        }
        let elapsed = (slot - self.open_slot).min(self.duration_slots) as u128;
        let span = self.start_price.saturating_sub(self.floor_price) as u128;
        let drop = span * elapsed / self.duration_slots as u128;
        self.start_price - drop as u64
    }

    /// Slot at which fact `index` comes out.
    pub fn hint_slot(&self, index: usize) -> u64 {
        debug_assert!(index < HINTS);
        self.open_slot + self.duration_slots * HINT_AT_BPS[index] / 10_000
    }

    /// How many facts are due at `slot`.
    pub fn hints_due(&self, slot: u64) -> u8 {
        let mut due = 0u8;
        for i in 0..HINTS {
            if slot >= self.hint_slot(i) {
                due += 1;
            }
        }
        due
    }

    /// First slot at which an unsold lot can be returned.
    pub fn expiry_slot(&self) -> u64 {
        self.open_slot + self.duration_slots + self.duration_slots * GRACE_BPS / 10_000
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clock() -> ClockParams {
        ClockParams { start_price: 60_000_000, floor_price: 6_000_000, open_slot: 1_000, duration_slots: 4_500 }
    }

    #[test]
    fn starts_at_start_price_and_lands_on_floor() {
        let c = clock();
        assert_eq!(c.price_at(0), 60_000_000);
        assert_eq!(c.price_at(1_000), 60_000_000);
        assert_eq!(c.price_at(1_000 + 4_500), 6_000_000);
        assert_eq!(c.price_at(1_000 + 9_000), 6_000_000);
    }

    #[test]
    fn falls_every_block() {
        let c = clock();
        let mut last = c.price_at(1_000);
        for s in 1_001..=5_500 {
            let p = c.price_at(s);
            assert!(p < last, "price must strictly fall at slot {s}");
            last = p;
        }
    }

    #[test]
    fn halfway_is_halfway() {
        let c = clock();
        assert_eq!(c.price_at(1_000 + 2_250), 33_000_000);
    }

    #[test]
    fn hints_come_out_in_order() {
        let c = clock();
        assert_eq!(c.hints_due(1_000), 0);
        assert_eq!(c.hint_slot(0), 1_000 + 675);
        assert_eq!(c.hints_due(1_000 + 675), 1);
        assert_eq!(c.hints_due(1_000 + 3_375), 5);
        assert_eq!(c.hints_due(u64::MAX / 2), 5);
    }

    #[test]
    fn expiry_after_grace() {
        assert_eq!(clock().expiry_slot(), 1_000 + 4_500 + 900);
    }
}
