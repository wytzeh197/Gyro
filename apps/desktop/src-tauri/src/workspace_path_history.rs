//! Undo/redo journal for workspace path lifecycle operations.
//!
//! The explorer and the model-facing capabilities both execute the same Rust
//! helpers in `lib.rs`, so recording inside those helpers gives the whole app
//! one history: a rename performed by a model can be undone from the UI, and a
//! delete performed by hand can be undone by a model.

use std::path::PathBuf;
use std::sync::Mutex;

/// The bounded number of operations the journal keeps.
const HISTORY_LIMIT: usize = 100;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum PathHistoryAction {
    /// A file or folder was created (or restored) at `path`.
    Created { path: PathBuf },
    /// An entry moved from `from` to `to`; `from` may be in another folder.
    Moved { from: PathBuf, to: PathBuf },
    /// An entry was moved to the Trash from `original` and now lives at `trashed`.
    Trashed { original: PathBuf, trashed: PathBuf },
}

#[derive(Default)]
struct History {
    undo: Vec<PathHistoryAction>,
    redo: Vec<PathHistoryAction>,
}

static HISTORY: Mutex<History> = Mutex::new(History {
    undo: Vec::new(),
    redo: Vec::new(),
});

fn lock() -> std::sync::MutexGuard<'static, History> {
    HISTORY.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Records a completed operation and invalidates the redo stack.
pub(crate) fn record(action: PathHistoryAction) {
    let mut history = lock();
    history.undo.push(action);
    if history.undo.len() > HISTORY_LIMIT {
        history.undo.remove(0);
    }
    history.redo.clear();
}

pub(crate) fn pop_undo() -> Option<PathHistoryAction> {
    lock().undo.pop()
}

pub(crate) fn pop_redo() -> Option<PathHistoryAction> {
    lock().redo.pop()
}

pub(crate) fn push_undo(action: PathHistoryAction) {
    let mut history = lock();
    history.undo.push(action);
    if history.undo.len() > HISTORY_LIMIT {
        history.undo.remove(0);
    }
}

pub(crate) fn push_redo(action: PathHistoryAction) {
    let mut history = lock();
    history.redo.push(action);
    if history.redo.len() > HISTORY_LIMIT {
        history.redo.remove(0);
    }
}

/// Drops the journal, for example when the workspace root changes.
pub(crate) fn clear() {
    let mut history = lock();
    history.undo.clear();
    history.redo.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn path(value: &str) -> PathBuf {
        PathBuf::from(value)
    }

    #[test]
    fn record_and_pop_round_trip() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        clear();
        record(PathHistoryAction::Moved {
            from: path("/w/a.txt"),
            to: path("/w/b.txt"),
        });
        assert_eq!(
            pop_undo(),
            Some(PathHistoryAction::Moved {
                from: path("/w/a.txt"),
                to: path("/w/b.txt"),
            })
        );
        assert_eq!(pop_undo(), None);
    }

    #[test]
    fn recording_clears_redo() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        clear();
        push_redo(PathHistoryAction::Created {
            path: path("/w/a.txt"),
        });
        record(PathHistoryAction::Created {
            path: path("/w/b.txt"),
        });
        assert_eq!(pop_redo(), None);
    }

    #[test]
    fn history_is_bounded() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        clear();
        for index in 0..(HISTORY_LIMIT + 5) {
            record(PathHistoryAction::Created {
                path: path(&format!("/w/{index}.txt")),
            });
        }
        let mut count = 0;
        while pop_undo().is_some() {
            count += 1;
        }
        assert_eq!(count, HISTORY_LIMIT);
    }
}
