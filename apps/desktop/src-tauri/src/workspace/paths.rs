use crate::{
    app::limits::{
        MAX_WORKSPACE_FILE_EDIT_BYTES, MAX_WORKSPACE_FILE_PREVIEW_BYTES,
        MAX_WORKSPACE_SEARCH_FALLBACK_BYTES, MAX_WORKSPACE_SEARCH_FALLBACK_FILES,
        WORKSPACE_PATHS_CHANGED_EVENT, WORKSPACE_SEARCH_FALLBACK_TIMEOUT,
    },
    ide::task_discovery::content_hash,
    state::workspace::WorkspaceWatchManager,
    stores::to_string,
    workspace::{
        files::{
            assert_workspace_entry, assert_workspace_path, read_bounded_regular_file,
            stat_workspace_file_impl, workspace_root,
        },
        tree::is_generated_workspace_dir,
        types::{
            WorkspaceFile, WorkspaceFileStat, WorkspacePathCreateRequest,
            WorkspacePathDeleteRequest, WorkspacePathDuplicateRequest, WorkspacePathRenameRequest,
            WorkspaceSearchRequest, WorkspaceSearchResult,
        },
    },
    workspace_path_history,
    workspace_search::{literal_search_ranges, run_workspace_rg_search},
};
use std::{
    path::{Path, PathBuf},
    time::Instant,
};
use tauri::Emitter;
use walkdir::WalkDir;
#[tauri::command]
pub(crate) async fn watch_workspace(
    workspace_path: String,
    manager: tauri::State<'_, WorkspaceWatchManager>,
) -> Result<Vec<WorkspaceFile>, String> {
    // Polling now stats only known directories in the common case. A full walk
    // runs when directory metadata changes or at a bounded reconciliation age.
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.snapshot(&workspace_path))
        .await
        .map_err(|error| format!("workspace watch worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn create_workspace_file(
    app: tauri::AppHandle,
    request: WorkspacePathCreateRequest,
) -> Result<WorkspaceFileStat, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_workspace_lifecycle(
            Some(&app),
            "ui",
            || WorkspacePathChange {
                action: "created",
                path: absolute_workspace_path(&request.workspace_path, &request.path),
                destination: None,
                kind: Some(request.kind.clone()),
                origin: "ui",
            },
            || create_workspace_path_impl(&request),
        )
        .map_err(to_string)
    })
    .await
    .map_err(|error| format!("workspace file create worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn rename_workspace_path(
    app: tauri::AppHandle,
    request: WorkspacePathRenameRequest,
) -> Result<WorkspaceFileStat, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_workspace_lifecycle(
            Some(&app),
            "ui",
            || WorkspacePathChange {
                action: if same_workspace_folder(&request.from_path, &request.to_path) {
                    "renamed"
                } else {
                    "moved"
                },
                path: absolute_workspace_path(&request.workspace_path, &request.from_path),
                destination: Some(absolute_workspace_path(
                    &request.workspace_path,
                    &request.to_path,
                )),
                kind: None,
                origin: "ui",
            },
            || rename_workspace_path_impl(&request),
        )
        .map_err(to_string)
    })
    .await
    .map_err(|error| format!("workspace path rename worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn delete_workspace_path(
    app: tauri::AppHandle,
    request: WorkspacePathDeleteRequest,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_workspace_lifecycle(
            Some(&app),
            "ui",
            || WorkspacePathChange {
                action: "deleted",
                path: absolute_workspace_path(&request.workspace_path, &request.path),
                destination: None,
                kind: None,
                origin: "ui",
            },
            || delete_workspace_path_impl(&request),
        )
        .map_err(to_string)
        .map(|_trashed| true)
    })
    .await
    .map_err(|error| format!("workspace path delete worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn duplicate_workspace_path(
    app: tauri::AppHandle,
    request: WorkspacePathDuplicateRequest,
) -> Result<WorkspaceFileStat, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let stat = duplicate_workspace_path_impl(&request).map_err(to_string)?;
        emit_workspace_path_change(
            &app,
            WorkspacePathChange {
                action: "created",
                path: absolute_workspace_path(&request.workspace_path, &stat.path),
                destination: None,
                kind: Some(stat.kind.clone()),
                origin: "ui",
            },
        );
        Ok(stat)
    })
    .await
    .map_err(|error| format!("workspace path duplicate worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn peek_workspace_path_undo(
) -> Result<Option<workspace_path_history::WorkspacePathUndoPeek>, String> {
    Ok(workspace_path_history::peek_workspace_path_undo())
}

#[tauri::command]
pub(crate) async fn undo_workspace_path(app: tauri::AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let action = undo_workspace_path_impl().map_err(to_string)?;
        if let Some(action) = action {
            emit_workspace_path_change(&app, path_history_change(&action));
            Ok(true)
        } else {
            Ok(false)
        }
    })
    .await
    .map_err(|error| format!("workspace undo worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn redo_workspace_path(app: tauri::AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let action = redo_workspace_path_impl().map_err(to_string)?;
        if let Some(action) = action {
            emit_workspace_path_change(&app, path_history_change(&action));
            Ok(true)
        } else {
            Ok(false)
        }
    })
    .await
    .map_err(|error| format!("workspace redo worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn search_workspace(
    request: WorkspaceSearchRequest,
) -> Result<Vec<WorkspaceSearchResult>, String> {
    tauri::async_runtime::spawn_blocking(move || search_workspace_impl(&request).map_err(to_string))
        .await
        .map_err(|error| format!("workspace search worker failed: {error}"))?
}

/// What one lifecycle call did, in the shape an open editor needs to follow it.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspacePathChange {
    /// `created`, `renamed`, `moved` or `deleted`.
    pub(crate) action: &'static str,
    /// Absolute path the entry had before the change.
    pub(crate) path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) destination: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) kind: Option<String>,
    /// `ui` or `model`: who asked, so a surface can skip work it already did.
    pub(crate) origin: &'static str,
}

/// Runs one lifecycle call and announces it.
///
/// This is the only place a workspace mutation becomes an event, and both the
/// workspace explorer commands and the model-facing capabilities come through
/// it. A rename or delete performed by a model therefore reaches the explorer
/// and every open editor exactly like the one the user performed by hand.
pub(crate) fn emit_workspace_path_change(app: &tauri::AppHandle, change: WorkspacePathChange) {
    let _ = app.emit(WORKSPACE_PATHS_CHANGED_EVENT, change);
}

pub(crate) fn run_workspace_lifecycle<T>(
    app: Option<&tauri::AppHandle>,
    origin: &'static str,
    change: impl FnOnce() -> WorkspacePathChange,
    operation: impl FnOnce() -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    let outcome = operation()?;
    if let Some(app) = app {
        let mut recorded = change();
        recorded.origin = origin;
        emit_workspace_path_change(app, recorded);
    }
    Ok(outcome)
}

/// The absolute form of a workspace path, whichever form the caller passed.
pub(crate) fn absolute_workspace_path(workspace_path: &str, path: &str) -> String {
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        return candidate.to_string_lossy().into_owned();
    }
    Path::new(workspace_path)
        .join(candidate)
        .to_string_lossy()
        .into_owned()
}

/// A rename keeps its folder, a move changes it.
pub(crate) fn same_workspace_folder(from: &str, to: &str) -> bool {
    Path::new(from).parent() == Path::new(to).parent()
}

/// Where this platform keeps files the user deleted.
pub(crate) fn trash_directory() -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    if cfg!(target_os = "macos") {
        Some(home.join(".Trash"))
    } else if cfg!(target_os = "linux") {
        Some(home.join(".local/share/Trash/files"))
    } else {
        None
    }
}

/// The name a second delete of the same entry gets: `notes 2.md`, `notes 3.md`.
pub(crate) fn unique_trash_destination(directory: &Path, name: &std::ffi::OsStr) -> PathBuf {
    let name = name.to_string_lossy();
    let (stem, extension) = match name.rfind('.') {
        Some(index) if index > 0 => (name[..index].to_string(), name[index..].to_string()),
        _ => (name.to_string(), String::new()),
    };
    let mut candidate = directory.join(name.as_ref());
    let mut attempt = 2;
    while candidate.symlink_metadata().is_ok() {
        candidate = directory.join(format!("{stem} {attempt}{extension}"));
        attempt += 1;
    }
    candidate
}

/// `files.enableTrash`: a delete moves the entry into the trash so it can be
/// recovered, which is what Finder's ⌘⌫ does. Nothing is unlinked for good, and
/// a trash that cannot be reached is an error rather than a silent destroy.
pub(crate) fn move_entry_to_trash(path: &Path) -> anyhow::Result<PathBuf> {
    let directory = trash_directory()
        .ok_or_else(|| anyhow::anyhow!("this platform has no trash for workspace deletes"))?;
    move_entry_into_trash(path, &directory)
}

/// The move itself, against a caller-chosen directory so a test can use a
/// temporary one instead of the user's real trash.
pub(crate) fn move_entry_into_trash(path: &Path, directory: &Path) -> anyhow::Result<PathBuf> {
    std::fs::create_dir_all(directory)?;
    let name = path
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("workspace path has no file name"))?;
    let destination = unique_trash_destination(directory, name);
    if std::fs::rename(path, &destination).is_ok() {
        return Ok(destination);
    }
    // The trash lives on the boot volume: copy across, then drop the original.
    copy_entry(path, &destination)?;
    remove_entry(path)?;
    Ok(destination)
}

pub(crate) fn copy_entry(from: &Path, to: &Path) -> anyhow::Result<()> {
    let metadata = std::fs::symlink_metadata(from)?;
    if metadata.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_entry(&entry.path(), &to.join(entry.file_name()))?;
        }
        return Ok(());
    }
    if metadata.file_type().is_symlink() {
        #[cfg(unix)]
        std::os::unix::fs::symlink(std::fs::read_link(from)?, to)?;
        #[cfg(not(unix))]
        std::fs::copy(from, to)?;
        return Ok(());
    }
    std::fs::copy(from, to)?;
    Ok(())
}

pub(crate) fn remove_entry(path: &Path) -> anyhow::Result<()> {
    if std::fs::symlink_metadata(path)?.is_dir() {
        std::fs::remove_dir_all(path)?;
    } else {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

pub(crate) fn create_workspace_path_impl(
    request: &WorkspacePathCreateRequest,
) -> anyhow::Result<WorkspaceFileStat> {
    let root = workspace_root(&request.workspace_path)?;
    let candidate = assert_workspace_path(&root, &request.path)?;
    if candidate.exists() {
        anyhow::bail!("workspace path already exists");
    }
    match request.kind.as_str() {
        "directory" => std::fs::create_dir_all(&candidate)?,
        "file" => {
            if let Some(parent) = candidate.parent() {
                if !parent.starts_with(&root) {
                    anyhow::bail!("workspace file parent is outside workspace");
                }
                std::fs::create_dir_all(parent)?;
            }
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&candidate)?;
        }
        _ => anyhow::bail!("workspace path kind must be file or directory"),
    }
    workspace_path_history::record(workspace_path_history::PathHistoryAction::Created {
        path: candidate.clone(),
    });
    stat_workspace_file_impl(&request.workspace_path, &request.path)
}

pub(crate) fn rename_workspace_path_impl(
    request: &WorkspacePathRenameRequest,
) -> anyhow::Result<WorkspaceFileStat> {
    let root = workspace_root(&request.workspace_path)?;
    let from = assert_workspace_entry(&root, &request.from_path)?;
    let to = assert_workspace_entry(&root, &request.to_path)?;
    if std::fs::symlink_metadata(&from).is_err() {
        anyhow::bail!("workspace path does not exist");
    }
    if std::fs::symlink_metadata(&to).is_ok() {
        anyhow::bail!("target workspace path already exists");
    }
    if let Some(parent) = to.parent() {
        if !parent.starts_with(&root) {
            anyhow::bail!("target parent is outside workspace");
        }
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(&from, &to)?;
    workspace_path_history::record(workspace_path_history::PathHistoryAction::Moved {
        from: from.clone(),
        to: to.clone(),
    });
    stat_workspace_file_impl(&request.workspace_path, &request.to_path)
}

pub(crate) fn delete_workspace_path_impl(
    request: &WorkspacePathDeleteRequest,
) -> anyhow::Result<PathBuf> {
    let root = workspace_root(&request.workspace_path)?;
    let candidate = assert_workspace_entry(&root, &request.path)?;
    let Ok(metadata) = std::fs::symlink_metadata(&candidate) else {
        anyhow::bail!("workspace path does not exist");
    };
    if metadata.is_symlink() {
        // Moving the link into the trash never loses the content it points at.
        let trashed = move_entry_to_trash(&candidate)?;
        workspace_path_history::record(workspace_path_history::PathHistoryAction::Trashed {
            original: candidate.clone(),
            trashed: trashed.clone(),
        });
        return Ok(trashed);
    }
    if metadata.is_file() {
        if let Some(expected_hash) = request.expected_hash.as_deref() {
            let (bytes, _) = read_bounded_regular_file(
                &candidate,
                MAX_WORKSPACE_FILE_EDIT_BYTES,
                "workspace file",
            )?;
            if bytes.len() > MAX_WORKSPACE_FILE_EDIT_BYTES {
                anyhow::bail!("workspace file is too large for hash-approved deletion");
            }
            if bytes.contains(&0) {
                anyhow::bail!("binary workspace files cannot be deleted through hash approval");
            }
            let current_hash = content_hash(&bytes);
            if current_hash != expected_hash {
                anyhow::bail!("file changed on disk; reload before deleting");
            }
        }
    }
    // A folder travels as one entry, which is also why a non-empty folder can
    // be deleted at all: nothing is unlinked, the whole tree is moved aside.
    let trashed = move_entry_to_trash(&candidate)?;
    workspace_path_history::record(workspace_path_history::PathHistoryAction::Trashed {
        original: candidate.clone(),
        trashed: trashed.clone(),
    });
    Ok(trashed)
}

/// Splits a name into stem and extension, leaving directories alone.
pub(crate) fn split_duplicate_name(file_name: &str, is_directory: bool) -> (String, String) {
    if is_directory {
        return (file_name.to_string(), String::new());
    }
    match file_name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem.to_string(), format!(".{extension}")),
        _ => (file_name.to_string(), String::new()),
    }
}

/// Copies one workspace entry beside itself, choosing a free "copy" name.
pub(crate) fn duplicate_workspace_path_impl(
    request: &WorkspacePathDuplicateRequest,
) -> anyhow::Result<WorkspaceFileStat> {
    let root = workspace_root(&request.workspace_path)?;
    let source = assert_workspace_entry(&root, &request.path)?;
    let metadata = std::fs::symlink_metadata(&source)
        .map_err(|_| anyhow::anyhow!("workspace path does not exist"))?;
    let parent = source
        .parent()
        .ok_or_else(|| anyhow::anyhow!("workspace path has no parent folder"))?;
    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow::anyhow!("workspace path has no name"))?;
    let (stem, extension) = split_duplicate_name(file_name, metadata.is_dir());
    let mut destination = parent.join(format!("{stem} copy{extension}"));
    let mut suffix = 2;
    while std::fs::symlink_metadata(&destination).is_ok() {
        destination = parent.join(format!("{stem} copy {suffix}{extension}"));
        suffix += 1;
        if suffix > 1000 {
            anyhow::bail!("could not find a free name for the duplicate");
        }
    }
    copy_entry(&source, &destination)?;
    workspace_path_history::record(workspace_path_history::PathHistoryAction::Created {
        path: destination.clone(),
    });
    let relative = destination
        .strip_prefix(&root)
        .map_err(|_| anyhow::anyhow!("duplicate landed outside the workspace"))?
        .to_string_lossy()
        .replace('\\', "/");
    stat_workspace_file_impl(&request.workspace_path, &relative)
}

/// Moves a trashed entry back home, recreating a parent folder if it is gone.
pub(crate) fn restore_entry_from_trash(trashed: &Path, original: &Path) -> anyhow::Result<()> {
    if std::fs::symlink_metadata(original).is_ok() {
        anyhow::bail!(
            "cannot restore {}: that path exists again",
            original.display()
        );
    }
    if let Some(parent) = original.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if std::fs::rename(trashed, original).is_err() {
        copy_entry(trashed, original)?;
        remove_entry(trashed)?;
    }
    Ok(())
}

/// Applies the inverse of one journal entry and returns the action that redoes it.
pub(crate) fn apply_path_history_action(
    action: &workspace_path_history::PathHistoryAction,
) -> anyhow::Result<workspace_path_history::PathHistoryAction> {
    use workspace_path_history::PathHistoryAction;
    match action {
        PathHistoryAction::Created { path } => {
            let trashed = move_entry_to_trash(path)?;
            Ok(PathHistoryAction::Trashed {
                original: path.clone(),
                trashed,
            })
        }
        PathHistoryAction::Moved { from, to } => {
            if std::fs::symlink_metadata(to).is_err() {
                anyhow::bail!("cannot undo the move: {} no longer exists", to.display());
            }
            if let Some(parent) = from.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::rename(to, from)?;
            Ok(PathHistoryAction::Moved {
                from: to.clone(),
                to: from.clone(),
            })
        }
        PathHistoryAction::Trashed { original, trashed } => {
            restore_entry_from_trash(trashed, original)?;
            Ok(PathHistoryAction::Trashed {
                original: original.clone(),
                trashed: trashed.clone(),
            })
        }
    }
}

pub(crate) fn undo_workspace_path_impl(
) -> anyhow::Result<Option<workspace_path_history::PathHistoryAction>> {
    let Some(action) = workspace_path_history::pop_undo() else {
        return Ok(None);
    };
    match apply_path_history_action(&action) {
        Ok(reversed) => {
            workspace_path_history::push_redo(reversed);
            Ok(Some(action))
        }
        Err(error) => {
            workspace_path_history::push_undo(action);
            Err(error)
        }
    }
}

pub(crate) fn redo_workspace_path_impl(
) -> anyhow::Result<Option<workspace_path_history::PathHistoryAction>> {
    let Some(action) = workspace_path_history::pop_redo() else {
        return Ok(None);
    };
    match apply_path_history_action(&action) {
        Ok(reversed) => {
            workspace_path_history::push_undo(reversed);
            Ok(Some(action))
        }
        Err(error) => {
            workspace_path_history::push_redo(action);
            Err(error)
        }
    }
}

/// The explorer-facing shape of an undone or redone journal entry.
pub(crate) fn path_history_change(
    action: &workspace_path_history::PathHistoryAction,
) -> WorkspacePathChange {
    use workspace_path_history::PathHistoryAction;
    match action {
        PathHistoryAction::Created { path } => WorkspacePathChange {
            action: "deleted",
            path: path.to_string_lossy().into_owned(),
            destination: None,
            kind: None,
            origin: "ui",
        },
        PathHistoryAction::Moved { from, to } => WorkspacePathChange {
            action: "moved",
            path: to.to_string_lossy().into_owned(),
            destination: Some(from.to_string_lossy().into_owned()),
            kind: None,
            origin: "ui",
        },
        PathHistoryAction::Trashed { original, .. } => WorkspacePathChange {
            action: "created",
            path: original.to_string_lossy().into_owned(),
            destination: None,
            kind: None,
            origin: "ui",
        },
    }
}

pub(crate) fn search_workspace_impl(
    request: &WorkspaceSearchRequest,
) -> anyhow::Result<Vec<WorkspaceSearchResult>> {
    let root = workspace_root(&request.workspace_path)?;
    let query = request.query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let max_results = request.max_results.unwrap_or(200).clamp(1, 1000);
    // UI search keeps fixed strings so ordinary typing is not treated as regex.
    // Model capability search calls ripgrep directly and reports regex errors.
    let use_regex = request.regex.unwrap_or(false);
    match run_workspace_rg_search(&root, query, request.globs.as_ref(), max_results, use_regex) {
        Ok(results) => Ok(results),
        // Agents sometimes send patterns that are invalid regex. Fall back to a
        // literal search so the capability returns matches instead of an error
        // that short-circuits the whole turn.
        Err(_) if use_regex => {
            run_workspace_rg_search(&root, query, request.globs.as_ref(), max_results, false)
                .or_else(|_| fallback_search_workspace(&root, query, max_results))
        }
        Err(_) => fallback_search_workspace(&root, query, max_results),
    }
}

pub(crate) fn fallback_search_workspace(
    root: &Path,
    query: &str,
    max_results: usize,
) -> anyhow::Result<Vec<WorkspaceSearchResult>> {
    let mut results = Vec::new();
    let started_at = Instant::now();
    let mut scanned_files = 0usize;
    let mut scanned_bytes = 0u64;
    for entry in WalkDir::new(root)
        .min_depth(1)
        .max_depth(8)
        .into_iter()
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            !(is_generated_workspace_dir(&name)
                || matches!(name.as_ref(), ".git" | "target" | "dist" | "build"))
        })
    {
        if started_at.elapsed() >= WORKSPACE_SEARCH_FALLBACK_TIMEOUT
            || scanned_files >= MAX_WORKSPACE_SEARCH_FALLBACK_FILES
            || scanned_bytes >= MAX_WORKSPACE_SEARCH_FALLBACK_BYTES
        {
            break;
        }
        // Unreadable entries are skipped; the fallback is best-effort.
        let Ok(entry) = entry else {
            continue;
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.len() > MAX_WORKSPACE_FILE_PREVIEW_BYTES as u64 {
            continue;
        }
        if scanned_bytes.saturating_add(metadata.len()) > MAX_WORKSPACE_SEARCH_FALLBACK_BYTES {
            break;
        }
        scanned_files += 1;
        scanned_bytes = scanned_bytes.saturating_add(metadata.len());
        let Ok((bytes, _)) = read_bounded_regular_file(
            entry.path(),
            MAX_WORKSPACE_FILE_PREVIEW_BYTES,
            "workspace search file",
        ) else {
            continue;
        };
        if bytes.len() > MAX_WORKSPACE_FILE_PREVIEW_BYTES {
            continue;
        }
        if bytes.contains(&0) {
            continue;
        }
        let content = String::from_utf8_lossy(&bytes);
        for (index, line) in content.lines().enumerate() {
            if line.contains(query) {
                let path = entry
                    .path()
                    .strip_prefix(root)?
                    .to_string_lossy()
                    .to_string();
                results.push(WorkspaceSearchResult {
                    path,
                    line_number: index + 1,
                    line: line.to_string(),
                    ranges: literal_search_ranges(line, query),
                });
                if results.len() >= max_results {
                    return Ok(results);
                }
            }
        }
    }
    Ok(results)
}

/// Deleting a workspace entry must always land in a trash, whichever volume it
/// stood on. These drive the move against a temporary directory so the user's
/// real trash is never involved.
#[cfg(test)]
mod workspace_trash_tests {

    use crate::workspace::paths::{
        absolute_workspace_path, copy_entry, move_entry_into_trash, remove_entry,
        same_workspace_folder, unique_trash_destination,
    };
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("gyro-trash-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn a_second_delete_keeps_the_extension_and_counts_up() {
        let trash = scratch("names");
        let name = std::ffi::OsStr::new("notes.md");

        let first = unique_trash_destination(&trash, name);
        assert_eq!(first.file_name().unwrap(), std::ffi::OsStr::new("notes.md"));
        std::fs::write(&first, b"one").unwrap();

        let second = unique_trash_destination(&trash, name);
        assert_eq!(
            second.file_name().unwrap(),
            std::ffi::OsStr::new("notes 2.md")
        );
        std::fs::write(&second, b"two").unwrap();

        let third = unique_trash_destination(&trash, name);
        assert_eq!(
            third.file_name().unwrap(),
            std::ffi::OsStr::new("notes 3.md")
        );

        std::fs::remove_dir_all(&trash).unwrap();
    }

    #[test]
    fn a_non_empty_folder_is_trashed_as_one_entry() {
        let root = scratch("folder");
        let trash = root.join("trash");
        let folder = root.join("project");
        std::fs::create_dir_all(folder.join("nested")).unwrap();
        std::fs::write(folder.join("nested").join("file.txt"), b"kept").unwrap();

        let destination = move_entry_into_trash(&folder, &trash).unwrap();

        assert!(!folder.exists(), "the deleted folder is gone from the tree");
        assert_eq!(
            std::fs::read(destination.join("nested").join("file.txt")).unwrap(),
            b"kept",
            "the whole tree survives the delete"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_tree_can_be_copied_across_volumes_before_it_is_dropped() {
        let root = scratch("copy");
        let source = root.join("source");
        std::fs::create_dir_all(source.join("inner")).unwrap();
        std::fs::write(source.join("inner").join("a.txt"), b"a").unwrap();
        let destination = root.join("elsewhere");

        copy_entry(&source, &destination).unwrap();
        remove_entry(&source).unwrap();

        assert!(!source.exists());
        assert_eq!(
            std::fs::read(destination.join("inner").join("a.txt")).unwrap(),
            b"a"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_rename_inside_one_folder_is_not_a_move() {
        assert!(same_workspace_folder("/w/src/lib.rs", "/w/src/main.rs"));
        assert!(!same_workspace_folder("/w/src/lib.rs", "/w/tests/lib.rs"));
    }

    #[test]
    fn a_relative_path_resolves_against_the_workspace_root() {
        assert_eq!(absolute_workspace_path("/w", "src/lib.rs"), "/w/src/lib.rs");
        assert_eq!(
            absolute_workspace_path("/w", "/elsewhere/lib.rs"),
            "/elsewhere/lib.rs"
        );
    }
}
