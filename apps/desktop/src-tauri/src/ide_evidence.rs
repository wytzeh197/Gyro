//! Live IDE evidence shared by the chat capability bridge.
//!
//! The Workspace shell pushes what the IDE is showing — open buffers, tabs,
//! selection, diagnostics, test failures and the active output channel — so a
//! model-facing capability can answer without an editor round trip.
//!
//! A snapshot carries the text of every open buffer, which makes it expensive
//! to copy and cheap to borrow. This cache therefore owns one snapshot per
//! project and hands out references under its lock, and it caps how many
//! projects it keeps: opening a project used to leave every earlier project's
//! buffer text alive for the life of the process.

use std::collections::{HashMap, VecDeque};

use super::WorkspaceContextSnapshot;

/// How many projects keep live evidence at once. A turn reads one, and a few
/// more cover switching between panes before the shell pushes again.
pub(super) const EVIDENCE_WORKSPACE_CAPACITY: usize = 8;

pub(super) struct IdeEvidenceCache {
    entries: HashMap<String, WorkspaceContextSnapshot>,
    /// Most recently stored key last, so eviction takes the front.
    order: VecDeque<String>,
    capacity: usize,
}

impl Default for IdeEvidenceCache {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            capacity: EVIDENCE_WORKSPACE_CAPACITY,
        }
    }
}

impl IdeEvidenceCache {
    pub(super) fn get(&self, workspace_key: &str) -> Option<&WorkspaceContextSnapshot> {
        self.entries.get(workspace_key)
    }

    /// Stores one project's evidence and evicts the least recently updated
    /// project once the cap is reached. The entry just written is never the
    /// one dropped, so a push for a new project always lands.
    pub(super) fn store(&mut self, workspace_key: String, snapshot: WorkspaceContextSnapshot) {
        self.touch(&workspace_key);
        self.entries.insert(workspace_key.clone(), snapshot);
        while self.entries.len() > self.capacity {
            let Some(coldest) = self.order.pop_front() else {
                break;
            };
            if coldest == workspace_key {
                // Requeue and stop rather than evicting the newest evidence.
                self.order.push_back(coldest);
                break;
            }
            self.entries.remove(&coldest);
        }
    }

    /// Borrows one project's evidence for mutation, seeding it from the turn
    /// snapshot when the shell has not pushed anything for that project yet.
    pub(super) fn entry_mut(
        &mut self,
        workspace_key: &str,
        seed: impl FnOnce() -> WorkspaceContextSnapshot,
    ) -> &mut WorkspaceContextSnapshot {
        if self.entries.contains_key(workspace_key) {
            self.touch(workspace_key);
        } else {
            self.store(workspace_key.to_string(), seed());
        }
        self.entries
            .get_mut(workspace_key)
            .expect("evidence was stored above")
    }

    fn touch(&mut self, workspace_key: &str) {
        self.order.retain(|existing| existing != workspace_key);
        self.order.push_back(workspace_key.to_string());
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.len()
    }

    #[cfg(test)]
    fn keys(&self) -> Vec<&str> {
        self.entries.keys().map(String::as_str).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(workspace_key: &str) -> WorkspaceContextSnapshot {
        WorkspaceContextSnapshot::empty(workspace_key)
    }

    #[test]
    fn evidence_is_capped_in_update_order() {
        let mut cache = IdeEvidenceCache {
            capacity: 2,
            ..IdeEvidenceCache::default()
        };
        cache.store("a".into(), snapshot("a"));
        cache.store("b".into(), snapshot("b"));
        // Touching "a" makes "b" the coldest entry.
        assert!(cache.get("a").is_some());
        cache.store("a".into(), snapshot("a"));
        cache.store("c".into(), snapshot("c"));
        assert_eq!(cache.len(), 2);
        let keys = cache.keys();
        assert!(keys.contains(&"a") && keys.contains(&"c"));
        assert!(!keys.contains(&"b"));
    }

    #[test]
    fn entry_mut_seeds_then_promotes() {
        let mut cache = IdeEvidenceCache {
            capacity: 2,
            ..IdeEvidenceCache::default()
        };
        cache.store("a".into(), snapshot("a"));
        cache.store("b".into(), snapshot("b"));
        // Seeding a third project evicts the coldest, then mutating "a"
        // protects it from the next eviction.
        {
            let seeded = cache.entry_mut("c", || snapshot("c"));
            seeded.revision = seeded.revision.saturating_add(1);
        }
        {
            let promoted = cache.entry_mut("a", || snapshot("a"));
            promoted.revision = promoted.revision.saturating_add(1);
        }
        cache.store("d".into(), snapshot("d"));
        let keys = cache.keys();
        assert_eq!(cache.len(), 2);
        assert!(keys.contains(&"a") && keys.contains(&"d"));
        assert_eq!(cache.get("a").unwrap().revision, 1);
    }
}
