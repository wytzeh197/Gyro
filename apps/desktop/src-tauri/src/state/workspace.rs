//! State workspace.

use crate::workspace::types::{WorkspaceFile, WorkspacePreparationSnapshot};
use notify::RecommendedWatcher;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{atomic::AtomicU64, Arc, Condvar, Mutex},
    time::{Instant, SystemTime},
};
#[derive(Clone, Default)]
pub(crate) struct WorkspaceWatchManager {
    pub(crate) snapshots: Arc<Mutex<HashMap<PathBuf, WorkspaceTreeSnapshot>>>,
    pub(crate) watchers: Arc<Mutex<HashMap<PathBuf, RecommendedWatcher>>>,
    pub(crate) rescan_state: Arc<Mutex<WorkspaceRescanState>>,
    pub(crate) next_generation: Arc<AtomicU64>,
}

#[derive(Default)]
pub(crate) struct WorkspaceRescanState {
    pub(crate) serials: HashMap<PathBuf, u64>,
    pub(crate) active_roots: HashSet<PathBuf>,
    pub(crate) changes: HashMap<PathBuf, WorkspaceChanges>,
}

pub(crate) struct WorkspaceChanges {
    // None indicates a dropped event or a batch too large to address by path.
    pub(crate) paths: Option<HashSet<PathBuf>>,
    pub(crate) branches: bool,
    pub(crate) directory_entries: bool,
    pub(crate) root_entries: bool,
}

impl Default for WorkspaceChanges {
    fn default() -> Self {
        Self {
            paths: Some(HashSet::new()),
            branches: false,
            directory_entries: false,
            root_entries: false,
        }
    }
}

impl WorkspaceChanges {
    pub(crate) fn merge(&mut self, other: Self) {
        self.branches |= other.branches;
        self.directory_entries |= other.directory_entries;
        self.root_entries |= other.root_entries;
        match (&mut self.paths, other.paths) {
            (Some(paths), Some(other)) => {
                paths.extend(other);
                if paths.len() > 256 {
                    self.paths = None;
                }
            }
            _ => self.paths = None,
        }
    }
}

impl WorkspaceRescanState {
    /// Returns true only for the event that needs to start a worker. Later
    /// events for the same workspace update the serial and are coalesced into
    /// that worker's next debounced scan.
    pub(crate) fn request(&mut self, root: PathBuf) -> bool {
        let serial = self.serials.entry(root.clone()).or_default();
        *serial = serial.saturating_add(1);
        self.active_roots.insert(root)
    }

    pub(crate) fn serial(&self, root: &Path) -> Option<u64> {
        self.serials.get(root).copied()
    }

    /// Returns true when an event arrived while a scan was in progress.
    /// Leaving the root active means the already-running worker will debounce
    /// and scan once more instead of spawning another thread.
    pub(crate) fn finish_round(&mut self, root: &Path, serial: u64) -> bool {
        if self.serial(root) != Some(serial) {
            return true;
        }
        self.active_roots.remove(root);
        false
    }

    pub(crate) fn remove(&mut self, root: &Path) {
        self.serials.remove(root);
        self.active_roots.remove(root);
        self.changes.remove(root);
    }
}

#[derive(Clone)]
pub(crate) struct WorkspaceTreeSnapshot {
    pub(crate) files: Vec<WorkspaceFile>,
    pub(crate) directories: Vec<WorkspaceDirectoryStamp>,
    pub(crate) scanned_at: Instant,
    pub(crate) generation: u64,
}

#[derive(Clone, Default)]
pub(crate) struct WorkspacePreparationManager {
    pub(crate) state: Arc<(Mutex<WorkspacePreparationState>, Condvar)>,
}

#[derive(Default)]
pub(crate) struct WorkspacePreparationState {
    pub(crate) in_flight: HashSet<PathBuf>,
    pub(crate) completed: HashMap<PathBuf, (Instant, WorkspacePreparationSnapshot)>,
}

#[derive(Clone)]
pub(crate) struct WorkspaceDirectoryStamp {
    pub(crate) path: PathBuf,
    pub(crate) modified: Option<SystemTime>,
    pub(crate) len: u64,
}
