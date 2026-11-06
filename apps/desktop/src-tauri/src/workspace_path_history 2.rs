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

/// The top undo entry, still on the stack. Chat uses this so a path card can
/// offer Undo only while that action is the one Cmd+Z would reverse.
pub(crate) fn peek_undo() -> Option<PathHistoryAction> {
    lock().undo.last().cloned()
}

/// What the chat card should say about the current top of the journal.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspacePathUndoPeek {
    /// `created`, `moved`, or `trashed` — the recorded action, not its inverse.
    pub action: &'static str,
    /// Absolute path a person would recognize: the created path, the move
    /// destination, or the path that was sent to the Trash.
    pub path: String,
    /// Button copy, for example `Undo move of notes.md`.
    pub label: String,
}

pub(crate) fn peek_workspace_path_undo() -> Option<WorkspacePathUndoPeek> {
    peek_undo().as_ref().map(describe_undo_peek)
}

fn describe_undo_peek(action: &PathHistoryAction) -> WorkspacePathUndoPeek {
    match action {
        PathHistoryAction::Created { path } => WorkspacePathUndoPeek {
            action: "created",
            path: path.to_string_lossy().into_owned(),
            label: format!("Undo create of {}", entry_name(path)),
        },
        PathHistoryAction::Moved { from, to } => {
            let verb = if from.parent() == to.parent() {
                "rename"
            } else {
                "move"
            };
            WorkspacePathUndoPeek {
                action: "moved",
                path: to.to_string_lossy().into_owned(),
                label: format!("Undo {verb} of {}", entry_name(to)),
            }
        }
        PathHistoryAction::Trashed { original, .. } => WorkspacePathUndoPeek {
            action: "trashed",
            path: original.to_string_lossy().into_owned(),
            label: format!("Undo trash of {}", entry_name(original)),
        },
    }
}

fn entry_name(path: &std::path::Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
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
    fn peek_names_the_top_move_without_removing_it() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        clear();
        record(PathHistoryAction::Moved {
            from: path("/w/drafts/a.txt"),
            to: path("/w/notes.md"),
        });
        assert_eq!(
            peek_workspace_path_undo(),
            Some(WorkspacePathUndoPeek {
                action: "moved",
                path: "/w/notes.md".to_string(),
                label: "Undo move of notes.md".to_string(),
            })
        );
        assert_eq!(
            peek_undo(),
            Some(PathHistoryAction::Moved {
                from: path("/w/drafts/a.txt"),
                to: path("/w/notes.md"),
            })
        );
    }

    #[test]
    fn peek_names_a_same_folder_move_as_a_rename() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        clear();
        record(PathHistoryAction::Moved {
            from: path("/w/draft.md"),
            to: path("/w/notes.md"),
        });
        assert_eq!(
            peek_workspace_path_undo().map(|peek| peek.label),
            Some("Undo rename of notes.md".to_string())
        );
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
