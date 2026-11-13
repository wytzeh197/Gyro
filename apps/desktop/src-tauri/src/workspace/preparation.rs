use crate::{
    app::limits::{
        GIT_STATUS_PREPARATION_TIMEOUT, MAX_WORKSPACE_PREPARATION_CACHES,
        WORKSPACE_PREPARATION_CACHE_AGE, WORKSPACE_PREPARATION_EVENT,
        WORKSPACE_PREPARATION_GIT_TIMEOUT, WORKSPACE_PREPARATION_WAIT_TIMEOUT,
    },
    git::{
        branches::git_branch_catalog_before, status_cache as git_status_cache,
        status_cache::git_status_read_failure, types::SourceControlStatus,
    },
    ide::task_discovery::{task_discover_impl, test_tree_from_tasks},
    state::workspace::{
        WorkspacePreparationManager, WorkspacePreparationState, WorkspaceWatchManager,
    },
    stores::to_string,
    workspace::types::{
        GitPreparationCheck, WorkspacePreparationError, WorkspacePreparationProgress,
        WorkspacePreparationRequest, WorkspacePreparationSnapshot,
    },
};
use gyro_core::workspace_check::GitReadState;
use std::{
    path::{Path, PathBuf},
    sync::mpsc,
    time::{Duration, Instant},
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
    git_state: Option<GitReadState>,
) -> WorkspacePreparationProgress {
    let progress = WorkspacePreparationProgress {
        git_state,
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

// Retry only a timed-out read, once, after its supervised process has exited.
// The second attempt spends the remaining shared budget; it never extends it.
fn inspect_preparation_git(
    workspace: &str,
    deadline: Instant,
    mut inspect: impl FnMut(Instant) -> anyhow::Result<SourceControlStatus>,
) -> anyhow::Result<SourceControlStatus> {
    let first_deadline = deadline.min(Instant::now() + GIT_STATUS_PREPARATION_TIMEOUT);
    let mut result = inspect(first_deadline);
    let timed_out = result
        .as_ref()
        .is_ok_and(|status| status.read_state == GitReadState::TimedOut);
    if timed_out && Instant::now() < deadline {
        result = inspect(deadline);
    }
    // Cached snapshots and collector fallbacks must both belong to the
    // requested workspace, including when the caller used a path alias.
    if let Ok(status) = &mut result {
        status.workspace_path = Some(workspace.to_string());
    }
    result
}

fn preparation_git_failure(root: &Path, workspace: &str, error: String) -> SourceControlStatus {
    let mut status = git_status_read_failure(Some(root), error, true);
    status.workspace_path = Some(workspace.to_string());
    status
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
        None,
    );
    let tree = match watcher.prime(&root_text) {
        Ok(tree) => tree,
        Err(error) => {
            errors.push(WorkspacePreparationError {
                git_check: None,
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
                None,
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
        None,
    );

    let watcher_mode = match watcher.ensure_watcher(root, app.clone()) {
        Ok(()) => "event",
        Err(error) => {
            errors.push(WorkspacePreparationError {
                git_check: None,
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
        None,
    );

    let git_deadline = Instant::now() + WORKSPACE_PREPARATION_GIT_TIMEOUT;
    // Leave time for the supervisor to terminate children and deliver their
    // result before the collector expires. Both reads share this deadline.
    let read_deadline = git_deadline - Duration::from_secs(1);
    let git_root = root_text.clone();
    let branch_root = root_text.clone();
    let task_root = root_text.clone();
    let (git_tx, git_rx) = mpsc::sync_channel(1);
    let (branch_tx, branch_rx) = mpsc::sync_channel(1);
    let task_handle = std::thread::spawn(move || task_discover_impl(&task_root));
    std::thread::spawn(move || {
        let _ = git_tx.send(inspect_preparation_git(
            &git_root,
            read_deadline,
            |deadline| git_status_cache::inspect_git_status_before(&git_root, false, deadline),
        ));
    });
    std::thread::spawn(move || {
        let _ = branch_tx.send(git_branch_catalog_before(&branch_root, read_deadline));
    });

    let remaining_git = || git_deadline.saturating_duration_since(Instant::now());
    let source_control = match git_rx.recv_timeout(remaining_git()) {
        Ok(Ok(status)) => {
            if let Some(error) = &status.error {
                if !status.read_state.is_optional() {
                    errors.push(WorkspacePreparationError {
                        git_check: Some(GitPreparationCheck::Status),
                        phase: "git".into(),
                        message: error.clone(),
                    });
                }
            }
            Some(status)
        }
        Ok(Err(error)) => {
            errors.push(WorkspacePreparationError {
                git_check: Some(GitPreparationCheck::Status),
                phase: "git".into(),
                message: error.to_string(),
            });
            Some(preparation_git_failure(root, &root_text, error.to_string()))
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            errors.push(WorkspacePreparationError {
                git_check: Some(GitPreparationCheck::Status),
                phase: "git".into(),
                message: "Inspecting Git timed out".into(),
            });
            let mut status =
                preparation_git_failure(root, &root_text, "Inspecting Git timed out".into());
            status.read_state = GitReadState::TimedOut;
            Some(status)
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            let message = "Git inspection worker stopped; retry preparation".to_string();
            errors.push(WorkspacePreparationError {
                git_check: Some(GitPreparationCheck::Status),
                phase: "git".into(),
                message: message.clone(),
            });
            Some(preparation_git_failure(root, &root_text, message))
        }
    };
    let branches = match branch_rx.recv_timeout(remaining_git()) {
        Ok(Ok(catalog)) => Some(catalog),
        Ok(Err(error)) => {
            errors.push(WorkspacePreparationError {
                git_check: Some(GitPreparationCheck::Branches),
                phase: "git".into(),
                message: format!("Branch inspection: {error}"),
            });
            None
        }
        Err(error) => {
            errors.push(WorkspacePreparationError {
                git_check: Some(GitPreparationCheck::Branches),
                phase: "git".into(),
                message: match error {
                    mpsc::RecvTimeoutError::Timeout => "Branch inspection timed out",
                    mpsc::RecvTimeoutError::Disconnected => {
                        "Branch inspection worker stopped; retry preparation"
                    }
                }
                .into(),
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
        None,
    );

    let tasks = match task_handle
        .join()
        .unwrap_or_else(|_| Err(anyhow::anyhow!("task discovery worker failed")))
    {
        Ok(tasks) => tasks,
        Err(error) => {
            errors.push(WorkspacePreparationError {
                git_check: None,
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
        None,
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
        source_control.as_ref().map(|status| status.read_state),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn status(error: Option<&str>) -> SourceControlStatus {
        let mut status =
            git_status_cache::parse_git_status_v2("# branch.head main\0? pending.txt\0");
        status.error = error.map(str::to_string);
        status.read_state = if error.is_some_and(|error| error.contains("timed out")) {
            GitReadState::TimedOut
        } else if error.is_some() {
            GitReadState::Failed
        } else {
            GitReadState::Ready
        };
        status
    }

    #[test]
    fn preparation_git_retries_timeout_once_with_remaining_budget() {
        let start = Instant::now();
        let deadline = start + Duration::from_secs(7);
        let mut attempts = Vec::new();
        let result = inspect_preparation_git("/workspace", deadline, |budget| {
            attempts.push(budget);
            Ok(status(if attempts.len() == 1 {
                Some("could not inspect Git status timed out")
            } else {
                None
            }))
        })
        .unwrap();
        assert_eq!(attempts.len(), 2);
        assert!(attempts[0] < deadline);
        assert_eq!(attempts[1], deadline);
        assert!(result.error.is_none());
        assert_eq!(result.workspace_path.as_deref(), Some("/workspace"));
        assert_eq!(result.files[0].path, "pending.txt");
    }

    #[test]
    fn preparation_git_does_not_retry_success_or_permanent_failures() {
        for error in [
            None,
            Some("not a git repository"),
            Some("permission denied"),
        ] {
            let mut attempts = 0;
            let result = inspect_preparation_git(
                "/workspace",
                Instant::now() + Duration::from_secs(7),
                |_| {
                    attempts += 1;
                    Ok(status(error))
                },
            )
            .unwrap();
            assert_eq!(attempts, 1);
            assert_eq!(result.error.as_deref(), error);
        }
    }

    #[test]
    fn preparation_git_stops_after_second_timeout_or_expired_budget() {
        for expired in [false, true] {
            let deadline = if expired {
                Instant::now() - Duration::from_millis(1)
            } else {
                Instant::now() + Duration::from_secs(7)
            };
            let mut attempts = 0;
            let result = inspect_preparation_git("/workspace", deadline, |_| {
                attempts += 1;
                Ok(status(Some("Git inspection timed out")))
            })
            .unwrap();
            assert_eq!(attempts, if expired { 1 } else { 2 });
            assert!(result.error.is_some());
        }
    }

    #[test]
    fn preparation_git_does_not_retry_unclassified_errors() {
        for message in ["Git inspection timed out", "workspace is unavailable"] {
            let mut attempts = 0;
            let result = inspect_preparation_git(
                "/workspace",
                Instant::now() + Duration::from_secs(7),
                |_| {
                    attempts += 1;
                    Err(anyhow::anyhow!(message))
                },
            );
            assert_eq!(attempts, 1);
            assert!(result.is_err());
        }
    }

    #[test]
    fn preparation_git_failure_keeps_scoped_last_known_changes() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let mut previous = status(None);
        previous.last_checked_at = Some("previous-read".into());
        git_status_cache::store_git_status(root.clone(), String::new(), previous);
        let failed =
            preparation_git_failure(&root, "/workspace-alias", "Inspecting Git timed out".into());
        assert_eq!(failed.workspace_path.as_deref(), Some("/workspace-alias"));
        assert_eq!(failed.files[0].path, "pending.txt");
        assert_eq!(failed.last_checked_at.as_deref(), Some("previous-read"));
        assert!(failed.error.unwrap().contains("last known changes"));
        let unknown = tempfile::tempdir().unwrap();
        let failed = preparation_git_failure(
            unknown.path(),
            "/new-workspace",
            "Inspecting Git timed out".into(),
        );
        assert!(!failed.available);
        assert!(failed.error.is_some());
        assert_eq!(failed.workspace_path.as_deref(), Some("/new-workspace"));
    }
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
