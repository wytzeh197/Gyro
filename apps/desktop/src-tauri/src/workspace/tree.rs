use crate::{
    app::limits::{
        MAX_WORKSPACE_WATCH_CACHES, WORKSPACE_CHANGED_EVENT, WORKSPACE_CHANGE_DEBOUNCE,
        WORKSPACE_TREE_MAX_CACHE_AGE,
    },
    git::{branches, read::discover_repository, status_cache::git_dirs},
    state::workspace::{
        WorkspaceChanges, WorkspaceDirectoryStamp, WorkspaceTreeSnapshot, WorkspaceWatchManager,
    },
    stores::to_string,
    workspace::types::{WorkspaceChangedEvent, WorkspaceFile},
    workspace_tree_order,
};
use notify::{
    Config as NotifyConfig, Event as NotifyEvent, RecommendedWatcher, RecursiveMode, Watcher,
};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::atomic::Ordering,
    time::Instant,
};
use tauri::Emitter;
use walkdir::WalkDir;
#[tauri::command]
pub(crate) async fn list_workspace_files(
    app: tauri::AppHandle,
    workspace_path: String,
) -> Result<Vec<WorkspaceFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        super::access::require_root(&app, &workspace_path)?;
        list_workspace_tree_blocking(workspace_path, Some(3))
    })
    .await
    .map_err(|error| format!("workspace file list worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn list_workspace_tree(
    app: tauri::AppHandle,
    workspace_path: String,
    depth: Option<usize>,
) -> Result<Vec<WorkspaceFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        super::access::require_root(&app, &workspace_path)?;
        list_workspace_tree_blocking(workspace_path, depth)
    })
    .await
    .map_err(|error| format!("workspace tree worker failed: {error}"))?
}

pub(crate) fn list_workspace_tree_blocking(
    workspace_path: String,
    depth: Option<usize>,
) -> Result<Vec<WorkspaceFile>, String> {
    let root = PathBuf::from(workspace_path)
        .canonicalize()
        .map_err(to_string)?;
    let max_depth = depth.unwrap_or(4).clamp(1, 8);
    scan_workspace_tree(&root, max_depth).map(|snapshot| snapshot.files)
}

pub(crate) fn scan_workspace_tree(
    root: &Path,
    max_depth: usize,
) -> Result<WorkspaceTreeSnapshot, String> {
    let mut entries = Vec::new();
    let root_metadata = fs::symlink_metadata(root).map_err(to_string)?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err("workspace root is not a regular directory".into());
    }
    let mut directories = vec![WorkspaceDirectoryStamp {
        path: root.to_path_buf(),
        modified: root_metadata.modified().ok(),
        len: root_metadata.len(),
    }];

    for entry in WalkDir::new(root)
        .min_depth(1)
        .max_depth(max_depth)
        .into_iter()
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            name != ".git"
                && (max_depth == 1
                    || !(is_generated_workspace_dir(&name)
                        || matches!(name.as_ref(), "target" | "dist" | "build")))
        })
    {
        // One unreadable folder, or one removed mid-build, leaves a gap in
        // the tree instead of failing the whole listing.
        let Ok(entry) = entry else {
            continue;
        };
        let Ok(path) = entry.path().strip_prefix(root) else {
            continue;
        };
        let kind = if entry.file_type().is_dir() {
            if let Ok(metadata) = entry.metadata() {
                directories.push(WorkspaceDirectoryStamp {
                    path: entry.path().to_path_buf(),
                    modified: metadata.modified().ok(),
                    len: metadata.len(),
                });
            }
            "directory".into()
        } else {
            "file".into()
        };
        entries.push(WorkspaceFile {
            path: path.to_string_lossy().to_string(),
            kind,
            depth: path.components().count(),
        });
    }

    workspace_tree_order::sort(&mut entries);
    Ok(WorkspaceTreeSnapshot {
        files: entries,
        directories,
        scanned_at: Instant::now(),
        generation: 0,
    })
}

#[cfg(test)]
pub(crate) fn compare_workspace_tree_entries(
    a: &WorkspaceFile,
    b: &WorkspaceFile,
) -> std::cmp::Ordering {
    let mut a_components = Path::new(&a.path).components().peekable();
    let mut b_components = Path::new(&b.path).components().peekable();

    loop {
        match (a_components.next(), b_components.next()) {
            (Some(a_component), Some(b_component)) if a_component == b_component => continue,
            (Some(a_component), Some(b_component)) => {
                let a_is_directory = a_components.peek().is_some() || a.kind == "directory";
                let b_is_directory = b_components.peek().is_some() || b.kind == "directory";
                return b_is_directory
                    .cmp(&a_is_directory)
                    .then_with(|| a_component.as_os_str().cmp(b_component.as_os_str()));
            }
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (None, None) => return std::cmp::Ordering::Equal,
        }
    }
}

impl WorkspaceDirectoryStamp {
    pub(crate) fn is_current(&self) -> bool {
        let Ok(metadata) = fs::symlink_metadata(&self.path) else {
            return false;
        };
        !metadata.file_type().is_symlink()
            && metadata.is_dir()
            && metadata.len() == self.len
            && metadata.modified().ok() == self.modified
    }
}

impl WorkspaceWatchManager {
    pub(crate) fn cache_snapshot(
        &self,
        root: PathBuf,
        mut snapshot: WorkspaceTreeSnapshot,
    ) -> Result<WorkspaceTreeSnapshot, String> {
        snapshot.generation = self.next_generation.fetch_add(1, Ordering::AcqRel) + 1;
        // A quiet, watched workspace keeps its old scan time; evicting it
        // would silently drop its watcher while the UI waits for events.
        let watched = self
            .watchers
            .lock()
            .map(|watchers| watchers.keys().cloned().collect::<HashSet<_>>())
            .unwrap_or_default();
        let mut snapshots = self
            .snapshots
            .lock()
            .map_err(|_| "workspace watch cache is unavailable".to_string())?;
        let evicted =
            if !snapshots.contains_key(&root) && snapshots.len() >= MAX_WORKSPACE_WATCH_CACHES {
                snapshots
                    .iter()
                    .min_by_key(|(path, cached)| (watched.contains(*path), cached.scanned_at))
                    .map(|(path, _)| path.clone())
            } else {
                None
            };
        if let Some(path) = evicted.as_ref() {
            snapshots.remove(path);
        }
        snapshots.insert(root, snapshot.clone());
        drop(snapshots);
        if let Some(path) = evicted {
            if let Ok(mut watchers) = self.watchers.lock() {
                watchers.remove(&path);
            }
            if let Ok(mut rescan_state) = self.rescan_state.lock() {
                rescan_state.remove(&path);
            }
        }
        Ok(snapshot)
    }

    pub(crate) fn prime(&self, workspace_path: &str) -> Result<WorkspaceTreeSnapshot, String> {
        let root = PathBuf::from(workspace_path)
            .canonicalize()
            .map_err(to_string)?;
        let snapshot = scan_workspace_tree(&root, 1)?;
        self.cache_snapshot(root, snapshot)
    }

    pub(crate) fn snapshot(&self, workspace_path: &str) -> Result<Vec<WorkspaceFile>, String> {
        let root = PathBuf::from(workspace_path)
            .canonicalize()
            .map_err(to_string)?;
        let cached = self
            .snapshots
            .lock()
            .map_err(|_| "workspace watch cache is unavailable".to_string())?
            .get(&root)
            .cloned();
        if let Some(cached) = cached {
            let watcher_active = self
                .watchers
                .lock()
                .map_err(|_| "workspace watcher registry is unavailable".to_string())?
                .contains_key(&root);
            // A registered watcher is not proof that every event arrived.
            // Bound cache age even while watching so a dropped notification
            // cannot leave the Explorer stale indefinitely.
            if cached.scanned_at.elapsed() < WORKSPACE_TREE_MAX_CACHE_AGE
                && (watcher_active
                    || cached
                        .directories
                        .iter()
                        .all(WorkspaceDirectoryStamp::is_current))
            {
                return Ok(cached.files);
            }
        }

        let snapshot = scan_workspace_tree(&root, 1)?;
        self.cache_snapshot(root, snapshot)
            .map(|snapshot| snapshot.files)
    }

    pub(crate) fn ensure_watcher(&self, root: &Path, app: tauri::AppHandle) -> Result<(), String> {
        if self
            .watchers
            .lock()
            .map_err(|_| "workspace watcher registry is unavailable".to_string())?
            .contains_key(root)
        {
            return Ok(());
        }
        let watched_root = root.to_path_buf();
        let event_root = watched_root.clone();
        let external_git_dirs = external_git_watch_dirs(root);
        let event_git_dirs = external_git_dirs.clone();
        let manager = self.clone();
        let mut watcher = RecommendedWatcher::new(
            move |result: notify::Result<NotifyEvent>| {
                // Notify errors mean the snapshot can no longer be trusted.
                // Use the same coalesced rescan path instead of ignoring them.
                let event = result.unwrap_or_else(|_| NotifyEvent::new(notify::EventKind::Any));
                if let Some(changes) = workspace_watch_changes(&event_root, &event, &event_git_dirs)
                {
                    manager.schedule_rescan(event_root.clone(), changes, app.clone());
                }
            },
            NotifyConfig::default(),
        )
        .map_err(to_string)?;
        watcher
            .watch(&watched_root, RecursiveMode::Recursive)
            .map_err(to_string)?;
        for dir in external_git_dirs {
            // Individual metadata roots bound the watch and avoid object/pack churn.
            // If a volume refuses these additional watches, focus/picker reads still catch up.
            let _ = watcher.watch(&dir, RecursiveMode::NonRecursive);
            for name in ["refs", "reftable", "worktrees"] {
                let path = dir.join(name);
                if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.is_dir()) {
                    let _ = watcher.watch(&path, RecursiveMode::Recursive);
                }
            }
        }
        self.watchers
            .lock()
            .map_err(|_| "workspace watcher registry is unavailable".to_string())?
            .insert(watched_root, watcher);
        Ok(())
    }

    fn schedule_rescan(&self, root: PathBuf, changes: WorkspaceChanges, app: tauri::AppHandle) {
        let should_start_worker = {
            let Ok(mut rescan_state) = self.rescan_state.lock() else {
                return;
            };
            rescan_state
                .changes
                .entry(root.clone())
                .or_default()
                .merge(changes);
            rescan_state.request(root.clone())
        };
        if !should_start_worker {
            return;
        }
        let manager = self.clone();
        let mut superseded_rounds = 0;
        let mut changes = WorkspaceChanges::default();
        std::thread::spawn(move || loop {
            std::thread::sleep(WORKSPACE_CHANGE_DEBOUNCE);
            let serial = manager
                .rescan_state
                .lock()
                .ok()
                .and_then(|mut rescan_state| {
                    if let Some(pending) = rescan_state.changes.remove(&root) {
                        changes.merge(pending);
                    }
                    rescan_state.serial(&root)
                });
            let Some(serial) = serial else {
                return;
            };

            // File content and Git metadata changes do not alter the root listing.
            let scanned = changes.root_entries.then(|| scan_workspace_tree(&root, 1));
            let superseded = manager
                .rescan_state
                .lock()
                .map(|rescan_state| rescan_state.serial(&root) != Some(serial))
                .unwrap_or(true);
            // Constant churn (a home-folder workspace) must still publish
            // now and then rather than rescanning forever without emitting.
            if superseded && superseded_rounds < MAX_SUPERSEDED_WORKSPACE_RESCANS {
                superseded_rounds += 1;
                continue;
            }
            superseded_rounds = 0;
            let snapshot = scanned
                .and_then(Result::ok)
                .and_then(|snapshot| manager.cache_snapshot(root.clone(), snapshot).ok());
            let generation = snapshot.as_ref().map_or_else(
                || manager.next_generation.fetch_add(1, Ordering::AcqRel) + 1,
                |snapshot| snapshot.generation,
            );
            let emitted = std::mem::take(&mut changes);
            if emitted.branches {
                // A ref update must supersede a branch read started before it.
                branches::invalidate(&root.to_string_lossy());
            }
            let _ = app.emit(
                WORKSPACE_CHANGED_EVENT,
                WorkspaceChangedEvent {
                    workspace_path: root.display().to_string(),
                    generation,
                    files: snapshot.map(|snapshot| snapshot.files),
                    changed_paths: emitted.paths.map(|paths| {
                        paths
                            .into_iter()
                            .map(|path| path.to_string_lossy().into_owned())
                            .collect()
                    }),
                    branches_changed: emitted.branches,
                    directory_entries_changed: emitted.directory_entries,
                },
            );

            let should_rescan = manager
                .rescan_state
                .lock()
                .map(|mut rescan_state| rescan_state.finish_round(&root, serial))
                .unwrap_or(false);
            if !should_rescan {
                return;
            }
        });
    }
}

pub(crate) const MAX_SUPERSEDED_WORKSPACE_RESCANS: u32 = 8;

fn external_git_watch_dirs(root: &Path) -> Vec<PathBuf> {
    let mut directories = Vec::new();
    if let Some((git_dir, common_dir)) =
        discover_repository(root).and_then(|(repo, _)| git_dirs(&repo))
    {
        if !git_dir.join("HEAD").is_file() || !common_dir.join("objects").is_dir() {
            return directories;
        }
        for directory in [git_dir, common_dir] {
            if let Ok(path) = directory.canonicalize() {
                if !path.starts_with(root) && !directories.contains(&path) {
                    directories.push(path);
                }
            }
        }
    }
    directories
}

/// Folder names that only ever hold installed dependencies or tool caches.
pub(crate) fn is_generated_workspace_dir(name: &str) -> bool {
    matches!(
        name,
        ".next"
            | "node_modules"
            | "__pycache__"
            | ".venv"
            | ".turbo"
            | ".nuxt"
            | ".svelte-kit"
            | ".parcel-cache"
            | ".pytest_cache"
            | ".mypy_cache"
            | ".ruff_cache"
            | ".gradle"
            | "DerivedData"
    )
}

#[cfg(test)]
pub(crate) fn workspace_watch_event_is_relevant(root: &Path, event: &NotifyEvent) -> bool {
    workspace_watch_changes(root, event, &[]).is_some()
}

fn workspace_watch_changes(
    root: &Path,
    event: &NotifyEvent,
    external_git_dirs: &[PathBuf],
) -> Option<WorkspaceChanges> {
    if event.need_rescan() || event.paths.is_empty() {
        return Some(WorkspaceChanges {
            paths: None,
            branches: true,
            directory_entries: true,
            root_entries: true,
        });
    }
    // Read-only operations must not trigger a fresh Git or editor read.
    use notify::event::{AccessKind, AccessMode, ModifyKind};
    if matches!(
        event.kind,
        notify::EventKind::Access(
            AccessKind::Read | AccessKind::Open(_) | AccessKind::Close(AccessMode::Read)
        )
    ) {
        return None;
    }
    let mut changes = WorkspaceChanges::default();
    let mut relevant = false;
    let git_dir = root.join(".git");
    let may_change_entries = !matches!(
        event.kind,
        notify::EventKind::Modify(ModifyKind::Data(_) | ModifyKind::Metadata(_))
    );
    for path in &event.paths {
        let git_path = path.strip_prefix(&git_dir).ok().or_else(|| {
            external_git_dirs
                .iter()
                .find_map(|dir| path.strip_prefix(dir).ok())
        });
        if let Some(tail) = git_path {
            let worktree_change = tail.strip_prefix("worktrees").is_ok_and(|path| {
                path.components().count() < 2
                    || matches!(
                        path.file_name().and_then(|name| name.to_str()),
                        Some("HEAD" | "gitdir" | "locked" | "commondir")
                    )
            });
            let branch_change = tail.as_os_str().is_empty()
                || matches!(
                    tail.to_str(),
                    Some("HEAD" | "packed-refs" | "config" | "config.worktree")
                )
                || tail.starts_with("refs")
                || tail.starts_with("reftable")
                || worktree_change;
            relevant |= branch_change || tail == Path::new("index");
            changes.branches |= branch_change;
            continue;
        }
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        // Keep generated caches and top-level build output from invalidating the workspace.
        let mut parents = relative.parent().into_iter().flat_map(Path::components);
        if parents.any(|part| is_generated_workspace_dir(&part.as_os_str().to_string_lossy())) {
            continue;
        }
        let mut parts = relative.components();
        if let Some(first) = parts.next() {
            if matches!(
                first.as_os_str().to_str(),
                Some("target" | "dist" | "build")
            ) && parts.next().is_some()
            {
                continue;
            }
        }
        relevant = true;
        changes.directory_entries |= may_change_entries;
        changes.root_entries |= may_change_entries && relative.components().count() <= 1;
        if let Some(paths) = &mut changes.paths {
            paths.insert(relative.to_path_buf());
            if paths.len() > 256 {
                changes.paths = None;
            }
        }
    }
    relevant.then_some(changes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_watch_routes_linked_git_metadata_and_file_changes_separately() {
        let workspace = tempfile::tempdir().unwrap();
        let root = workspace.path().canonicalize().unwrap();
        let main = root.join("main");
        let linked = root.join("linked");
        let common = main.join(".git");
        let linked_metadata = common.join("worktrees/linked");
        fs::create_dir_all(common.join("objects")).unwrap();
        fs::create_dir_all(&linked_metadata).unwrap();
        fs::create_dir_all(&linked).unwrap();
        fs::write(
            linked.join(".git"),
            format!("gitdir: {}\n", linked_metadata.display()),
        )
        .unwrap();
        fs::write(linked_metadata.join("HEAD"), "ref: refs/heads/feature\n").unwrap();
        fs::write(linked_metadata.join("commondir"), "../..\n").unwrap();

        let dirs = external_git_watch_dirs(&linked);
        assert_eq!(dirs, vec![linked_metadata.clone(), common.clone()]);
        let git = NotifyEvent::new(notify::EventKind::Any).add_path(common.join("refs/heads/main"));
        let mut changed = workspace_watch_changes(&linked, &git, &dirs).unwrap();
        assert!(changed.branches);
        assert!(changed.paths.as_ref().unwrap().is_empty());
        assert!(!changed.directory_entries && !changed.root_entries);

        let worktree =
            NotifyEvent::new(notify::EventKind::Any).add_path(common.join("worktrees/other/HEAD"));
        assert!(
            workspace_watch_changes(&linked, &worktree, &dirs)
                .unwrap()
                .branches
        );
        let index =
            NotifyEvent::new(notify::EventKind::Any).add_path(linked_metadata.join("index"));
        assert!(
            !workspace_watch_changes(&linked, &index, &dirs)
                .unwrap()
                .branches
        );

        let files = NotifyEvent::new(notify::EventKind::Any)
            .add_path(linked.join("src/before.rs"))
            .add_path(linked.join("lib/after.rs"))
            .add_path(common.join("objects/ignored"));
        changed.merge(workspace_watch_changes(&linked, &files, &dirs).unwrap());
        assert!(changed.branches);
        assert!(changed.directory_entries && !changed.root_entries);
        assert_eq!(
            changed.paths.unwrap(),
            HashSet::from([
                PathBuf::from("src/before.rs"),
                PathBuf::from("lib/after.rs")
            ])
        );
    }

    #[test]
    fn workspace_watch_skips_directory_reads_for_content_edits() {
        use notify::event::{DataChange, ModifyKind};
        let root = Path::new("/workspace");
        let content = NotifyEvent::new(notify::EventKind::Modify(ModifyKind::Data(
            DataChange::Content,
        )))
        .add_path(root.join("README.md"));
        let content = workspace_watch_changes(root, &content, &[]).unwrap();
        assert!(!content.directory_entries && !content.root_entries);
        assert!(content.paths.unwrap().contains(Path::new("README.md")));

        let unknown = NotifyEvent::new(notify::EventKind::Any).add_path(root.join("README.md"));
        let unknown = workspace_watch_changes(root, &unknown, &[]).unwrap();
        assert!(unknown.directory_entries && unknown.root_entries);
    }
}
