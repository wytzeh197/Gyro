use crate::{
    app::limits::{
        MAX_WORKSPACE_PREPARATION_CACHES, WORKSPACE_PREPARATION_CACHE_AGE,
        WORKSPACE_PREPARATION_EVENT, WORKSPACE_PREPARATION_GIT_TIMEOUT,
        WORKSPACE_PREPARATION_WAIT_TIMEOUT,
    },
    git_branch_service::git_branch_catalog_before,
    git_status_cache,
    git_status_cache::git_status_read_failure,
    ide::task_discovery::{task_discover_impl, test_tree_from_tasks},
    state::workspace::{
        WorkspacePreparationManager, WorkspacePreparationState, WorkspaceWatchManager,
    },
    stores::to_string,
    workspace::types::{
        WorkspacePreparationError, WorkspacePreparationProgress, WorkspacePreparationRequest,
        WorkspacePreparationSnapshot,
    },
};
use std::{
    path::{Path, PathBuf},
    sync::mpsc,
    time::Instant,
};
use tauri::Emitter;
impl WorkspacePreparationManager {
    pub(crate) fn prepare(
        &self,
        request: WorkspacePreparationRequest,
        watcher: WorkspaceWatchManager,
        app: tauri::AppHandle,
    ) -> Result<WorkspacePreparationSnapshot, String> {
        let root = PathBuf::from(&request.workspace_path)
            .canonicalize()
            .map_err(to_string)?;
        let (state_lock, state_changed) = &*self.state;
        let mut state = state_lock
            .lock()
            .map_err(|_| "workspace preparation state is unavailable".to_string())?;
        loop {
            prune_workspace_preparation_completed(&mut state);
            if let Some((completed_at, cached)) = state.completed.get(&root) {
                if completed_at.elapsed() <= WORKSPACE_PREPARATION_CACHE_AGE
                    && cached.progress.status == "ready"
                    && cached.progress.errors.is_empty()
                {
                    let mut cached = cached.clone();
                    cached.progress.run_id = request.run_id.clone();
                    let _ = app.emit(WORKSPACE_PREPARATION_EVENT, cached.progress.clone());
                    return Ok(cached);
                }
            }
            if state.in_flight.insert(root.clone()) {
                break;
            }
            let (next, wait) = state_changed
                .wait_timeout(state, WORKSPACE_PREPARATION_WAIT_TIMEOUT)
                .map_err(|_| "workspace preparation state is unavailable".to_string())?;
            state = next;
            if wait.timed_out() && state.in_flight.contains(&root) {
                return Err("workspace preparation timed out".to_string());
            }
        }
        drop(state);

        let result = prepare_workspace_impl(&request, &root, &watcher, &app);
        let mut state = state_lock
            .lock()
            .map_err(|_| "workspace preparation state is unavailable".to_string())?;
        state.in_flight.remove(&root);
        if let Ok(snapshot) = result.as_ref() {
            if snapshot.progress.status == "ready" && snapshot.progress.errors.is_empty() {
                state
                    .completed
                    .insert(root, (Instant::now(), snapshot.clone()));
                prune_workspace_preparation_completed(&mut state);
            } else {
                state.completed.remove(&root);
            }
        }
        state_changed.notify_all();
        result
    }
}

pub(crate) fn prune_workspace_preparation_completed(state: &mut WorkspacePreparationState) {
    state
        .completed
        .retain(|_, (completed_at, _)| completed_at.elapsed() <= WORKSPACE_PREPARATION_CACHE_AGE);
    while state.completed.len() > MAX_WORKSPACE_PREPARATION_CACHES {
        let oldest = state
            .completed
            .iter()
            .min_by_key(|(_, (completed_at, _))| *completed_at)
            .map(|(path, _)| path.clone());
        let Some(path) = oldest else {
            break;
        };
        state.completed.remove(&path);
    }
}

pub(crate) fn emit_workspace_preparation(
    app: &tauri::AppHandle,
    request: &WorkspacePreparationRequest,
    phase: Option<&str>,
    status: &str,
    completed_steps: usize,
    message: impl Into<String>,
    errors: &[WorkspacePreparationError],
) -> WorkspacePreparationProgress {
    let progress = WorkspacePreparationProgress {
        run_id: request.run_id.clone(),
        workspace_path: request.workspace_path.clone(),
        phase: phase.map(str::to_string),
        status: status.to_string(),
        completed_steps,
        total_steps: 5,
        message: message.into(),
        errors: errors.to_vec(),
    };
    let _ = app.emit(WORKSPACE_PREPARATION_EVENT, progress.clone());
    progress
}

pub(crate) fn prepare_workspace_impl(
    request: &WorkspacePreparationRequest,
    root: &Path,
    watcher: &WorkspaceWatchManager,
    app: &tauri::AppHandle,
) -> Result<WorkspacePreparationSnapshot, String> {
    let root_text = root.display().to_string();
    let mut errors = Vec::new();
    emit_workspace_preparation(
        app,
        request,
        Some("catalog"),
        "preparing",
        0,
        "Cataloging workspace",
        &errors,
    );
    let tree = match watcher.prime(&root_text) {
        Ok(tree) => tree,
        Err(error) => {
            errors.push(WorkspacePreparationError {
                phase: "catalog".into(),
                message: error.clone(),
            });
            emit_workspace_preparation(
                app,
                request,
                Some("catalog"),
                "failed",
                1,
                "Workspace catalog failed",
                &errors,
            );
            return Err(error);
        }
    };
    emit_workspace_preparation(
        app,
        request,
        Some("watcher"),
        "preparing",
        1,
        "Starting workspace watcher",
        &errors,
    );

    let watcher_mode = match watcher.ensure_watcher(root, app.clone()) {
        Ok(()) => "event",
        Err(error) => {
            errors.push(WorkspacePreparationError {
                phase: "watcher".into(),
                message: error,
            });
            "polling"
        }
    };
    emit_workspace_preparation(
        app,
        request,
        Some("git"),
        "preparing",
        2,
        "Inspecting Git",
        &errors,
    );

    let git_deadline = Instant::now() + WORKSPACE_PREPARATION_GIT_TIMEOUT;
    let git_root = root_text.clone();
    let branch_root = root_text.clone();
    let task_root = root_text.clone();
    let (git_tx, git_rx) = mpsc::sync_channel(1);
    let (branch_tx, branch_rx) = mpsc::sync_channel(1);
    let task_handle = std::thread::spawn(move || task_discover_impl(&task_root));
    std::thread::spawn(move || {
        let _ = git_tx.send(git_status_cache::inspect_git_status_before(
            &git_root,
            false,
            git_deadline,
        ));
    });
    std::thread::spawn(move || {
        let _ = branch_tx.send(git_branch_catalog_before(&branch_root, git_deadline));
    });

    let remaining_git = || git_deadline.saturating_duration_since(Instant::now());
    let source_control = match git_rx.recv_timeout(remaining_git()) {
        Ok(Ok(status)) => {
            if let Some(error) = &status.error {
                if !error.contains("not a git repository") {
                    errors.push(WorkspacePreparationError {
                        phase: "git".into(),
                        message: error.clone(),
                    });
                }
            }
            Some(status)
        }
        Ok(Err(error)) => {
            errors.push(WorkspacePreparationError {
                phase: "git".into(),
                message: error.to_string(),
            });
            None
        }
        Err(_) => {
            errors.push(WorkspacePreparationError {
                phase: "git".into(),
                message: "Inspecting Git timed out".into(),
            });
            Some(git_status_read_failure(
                Some(root),
                "Inspecting Git timed out".into(),
                true,
            ))
        }
    };
    let branches = match branch_rx.recv_timeout(remaining_git()) {
        Ok(Ok(catalog)) => Some(catalog),
        Ok(Err(error)) => {
            errors.push(WorkspacePreparationError {
                phase: "git".into(),
                message: format!("Branch inspection: {error}"),
            });
            None
        }
        Err(_) => {
            errors.push(WorkspacePreparationError {
                phase: "git".into(),
                message: "Branch inspection timed out".into(),
            });
            None
        }
    };
    emit_workspace_preparation(
        app,
        request,
        Some("tasks"),
        "preparing",
        3,
        "Discovering tasks",
        &errors,
    );

    let tasks = match task_handle
        .join()
        .unwrap_or_else(|_| Err(anyhow::anyhow!("task discovery worker failed")))
    {
        Ok(tasks) => tasks,
        Err(error) => {
            errors.push(WorkspacePreparationError {
                phase: "tasks".into(),
                message: error.to_string(),
            });
            Vec::new()
        }
    };
    // Share the pane's fresh Git view with the next workspace check, so the
    // first chat turn in this workspace reuses it instead of probing again.
    if let Some(status) = source_control
        .as_ref()
        .filter(|status| status.available && status.error.is_none())
    {
        let _ = gyro_core::record_prepared_workspace(
            root,
            gyro_core::WorkspaceGitBrief {
                available: true,
                branch: status.branch.clone(),
                ahead: u32::try_from(status.ahead).unwrap_or(u32::MAX),
                behind: u32::try_from(status.behind).unwrap_or(u32::MAX),
                dirty_count: u32::try_from(status.files.len()).unwrap_or(u32::MAX),
                conflicted: status.files.iter().any(|file| file.state == "conflicted"),
            },
        );
    }
    emit_workspace_preparation(
        app,
        request,
        Some("tests"),
        "preparing",
        4,
        "Discovering tests",
        &errors,
    );
    let tests = test_tree_from_tasks(&tasks);
    let status = if errors.is_empty() {
        "ready"
    } else {
        "degraded"
    };
    let progress = emit_workspace_preparation(
        app,
        request,
        Some("tests"),
        status,
        5,
        if status == "ready" {
            "Workspace ready"
        } else {
            "Workspace ready with warnings"
        },
        &errors,
    );
    Ok(WorkspacePreparationSnapshot {
        progress,
        files: tree.files,
        source_control,
        branches,
        tasks,
        tests,
        watcher_mode: watcher_mode.into(),
        generation: tree.generation,
    })
}

#[tauri::command]
pub(crate) async fn prepare_workspace(
    request: WorkspacePreparationRequest,
    app: tauri::AppHandle,
    watcher: tauri::State<'_, WorkspaceWatchManager>,
    preparation: tauri::State<'_, WorkspacePreparationManager>,
) -> Result<WorkspacePreparationSnapshot, String> {
    let watcher = watcher.inner().clone();
    let preparation = preparation.inner().clone();
    tauri::async_runtime::spawn_blocking(move || preparation.prepare(request, watcher, app))
        .await
        .map_err(|error| format!("workspace preparation worker failed: {error}"))?
}
