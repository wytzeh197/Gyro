use crate::{
    app::limits::{
        MAX_WORKSPACE_WATCH_CACHES, WORKSPACE_CHANGED_EVENT, WORKSPACE_CHANGE_DEBOUNCE,
        WORKSPACE_TREE_MAX_CACHE_AGE,
    },
    state::workspace::{WorkspaceDirectoryStamp, WorkspaceTreeSnapshot, WorkspaceWatchManager},
    to_string,
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
    workspace_path: String,
) -> Result<Vec<WorkspaceFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        list_workspace_tree_blocking(workspace_path, Some(3))
    })
    .await
    .map_err(|error| format!("workspace file list worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn list_workspace_tree(
    workspace_path: String,
    depth: Option<usize>,
) -> Result<Vec<WorkspaceFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
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
            if watcher_active
                || (cached.scanned_at.elapsed() < WORKSPACE_TREE_MAX_CACHE_AGE
                    && cached
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
        let manager = self.clone();
        let mut watcher = RecommendedWatcher::new(
            move |result: notify::Result<NotifyEvent>| {
                if let Ok(event) = result {
                    manager.schedule_rescan(event_root.clone(), event, app.clone());
                }
            },
            NotifyConfig::default(),
        )
        .map_err(to_string)?;
        watcher
            .watch(&watched_root, RecursiveMode::Recursive)
            .map_err(to_string)?;
        self.watchers
            .lock()
            .map_err(|_| "workspace watcher registry is unavailable".to_string())?
            .insert(watched_root, watcher);
        Ok(())
    }

    pub(crate) fn schedule_rescan(&self, root: PathBuf, event: NotifyEvent, app: tauri::AppHandle) {
        if !workspace_watch_event_is_relevant(&root, &event) {
            return;
        }
        let should_start_worker = {
            let Ok(mut rescan_state) = self.rescan_state.lock() else {
                return;
            };
            rescan_state.request(root.clone())
        };
        if !should_start_worker {
            return;
        }
        let manager = self.clone();
        let mut superseded_rounds = 0;
        std::thread::spawn(move || loop {
            std::thread::sleep(WORKSPACE_CHANGE_DEBOUNCE);
            let serial = manager
                .rescan_state
                .lock()
                .ok()
                .and_then(|rescan_state| rescan_state.serial(&root));
            let Some(serial) = serial else {
                return;
            };

            let scanned = scan_workspace_tree(&root, 1);
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
            if let Ok(snapshot) =
                scanned.and_then(|snapshot| manager.cache_snapshot(root.clone(), snapshot))
            {
                let _ = app.emit(
                    WORKSPACE_CHANGED_EVENT,
                    WorkspaceChangedEvent {
                        workspace_path: root.display().to_string(),
                        generation: snapshot.generation,
                        files: snapshot.files,
                    },
                );
            }

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

pub(crate) fn workspace_watch_event_is_relevant(root: &Path, event: &NotifyEvent) -> bool {
    event.paths.is_empty()
        || event.paths.iter().any(|path| {
            let Ok(relative) = path.strip_prefix(root) else {
                return false;
            };
            let mut components = relative.components();
            let Some(first) = components.next() else {
                return true;
            };
            let first = first.as_os_str().to_string_lossy();
            if first == ".git" {
                return false;
            }
            // Dependency and tool caches churn at any depth (`pnpm install`,
            // a test run); only their appearance at the top level counts.
            let mut parents = relative.parent().into_iter().flat_map(Path::components);
            if parents.any(|part| is_generated_workspace_dir(&part.as_os_str().to_string_lossy())) {
                return false;
            }
            // Build output churns on every compile; rescanning and re-running
            // git status for it competes with clicks for the whole build. The
            // folder appearing or vanishing still counts; its contents don't.
            let is_build_output = matches!(first.as_ref(), ".next" | "target" | "dist" | "build");
            !(is_build_output && components.next().is_some())
        })
}
