//! Retention policy for scan results. This daemon needs one board; 64 entries
//! leave room for multiple boards without retaining a history of passers-by.

use std::collections::HashMap;
use uuid::Uuid;

pub(super) const MAX_DISCOVERED_PERIPHERALS: usize = 64;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum DiscoveryAction {
    Ignore,
    Update,
    Insert,
}

pub(super) fn discovery_action(
    filter: Option<&str>,
    name: Option<&str>,
    known: bool,
    count: usize,
) -> DiscoveryAction {
    if filter.is_some_and(|needle| !name.is_some_and(|name| name.contains(needle))) {
        DiscoveryAction::Ignore
    } else if known {
        DiscoveryAction::Update
    } else if count < MAX_DISCOVERED_PERIPHERALS {
        DiscoveryAction::Insert
    } else {
        DiscoveryAction::Ignore
    }
}

/// Starting another scan ends the lifetime of idle discoveries. Keep connected,
/// connecting and disconnecting devices, including pending command futures.
pub(super) fn remove_idle<T>(
    peripherals: &mut HashMap<Uuid, T>,
    mut is_idle: impl FnMut(&T) -> bool,
) -> Vec<Uuid> {
    let mut removed = Vec::new();
    peripherals.retain(|id, peripheral| {
        if is_idle(peripheral) {
            removed.push(*id);
            false
        } else {
            true
        }
    });
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn repeated_scans_release_idle_handles_and_keep_the_active_board() {
        let board = Uuid::from_u128(1);
        let active = Arc::new(false);
        let mut peripherals = HashMap::from([(board, active.clone())]);
        for scan in 0..100_u128 {
            let idle = Arc::new(true);
            let weak = Arc::downgrade(&idle);
            for advertiser in 0..1_000_u128 {
                let id = Uuid::from_u128(2 + scan * 1_000 + advertiser);
                if discovery_action(
                    Some("Chessnut"),
                    Some("Chessnut Move"),
                    false,
                    peripherals.len(),
                ) == DiscoveryAction::Insert
                {
                    peripherals.insert(id, idle.clone());
                }
            }
            assert_eq!(peripherals.len(), MAX_DISCOVERED_PERIPHERALS);
            drop(idle);
            let removed = remove_idle(&mut peripherals, |idle| **idle);
            assert_eq!(removed.len(), MAX_DISCOVERED_PERIPHERALS - 1);
            assert!(
                weak.upgrade().is_none(),
                "expired discoveries must release their handles"
            );
            assert_eq!(peripherals.len(), 1);
            assert!(Arc::ptr_eq(&peripherals[&board], &active));
        }
    }

    #[test]
    fn filtering_and_capacity_do_not_suppress_updates_for_an_existing_board() {
        for name in [None, Some("Headphones"), Some("Phone")] {
            assert_eq!(
                discovery_action(Some("Chessnut"), name, false, 0),
                DiscoveryAction::Ignore
            );
        }
        assert_eq!(
            discovery_action(Some("Chessnut"), Some("Chessnut Move"), false, 0),
            DiscoveryAction::Insert
        );
        assert_eq!(
            discovery_action(
                Some("Chessnut"),
                Some("Board [Chessnut Move]"),
                true,
                MAX_DISCOVERED_PERIPHERALS
            ),
            DiscoveryAction::Update
        );
        assert_eq!(
            discovery_action(None, None, false, MAX_DISCOVERED_PERIPHERALS),
            DiscoveryAction::Ignore
        );
        assert_eq!(
            discovery_action(None, None, false, 0),
            DiscoveryAction::Insert
        );
    }
}
