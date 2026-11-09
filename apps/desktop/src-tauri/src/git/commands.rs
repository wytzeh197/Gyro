//! Git workspace commands and operations.

use crate::{
    command_execution::{
        bounded_command_error, run_bounded_command, run_command_output,
        run_command_output_with_limits,
    },
    git::{
        branches as git_branch_service,
        branches::git_branch_catalog_impl,
        status_cache::{git_repo_root, git_status_impl},
        types::{
            GitBranchCatalog, GitCheckoutBranchRequest, GitCommitRequest, GitCreateBranchRequest,
            GitLinkedWorktree, GitPathRequest, GitRemoveWorktreeRequest, GitStageRequest,
            GitSyncRequest, GitSyncResult, SourceControlStatus,
        },
    },
    ide::types::IdeCommandOutput,
    providers::process::command_with_gui_path,
    stores::{open_store, parse_uuid, to_string},
    workspace::files::{assert_workspace_entry, workspace_root},
};
use gyro_core::{CancellationToken, Session};
use std::{
    path::Path,
    process::Command,
    time::{Duration, Instant},
};

#[tauri::command]
pub(crate) async fn git_status(workspace_path: String) -> Result<SourceControlStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_status_impl(&workspace_path).map_err(to_string)
    })
    .await
    .map_err(|error| format!("git status worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn git_branches(workspace_path: String) -> Result<GitBranchCatalog, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_branch_catalog_impl(&workspace_path).map_err(to_string)
    })
    .await
    .map_err(|error| format!("git branch worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn git_checkout_branch(
    request: GitCheckoutBranchRequest,
) -> Result<GitBranchCatalog, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_checkout_branch_impl(&request).map_err(to_string)
    })
    .await
    .map_err(|error| format!("git branch checkout worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn git_rename_branch(
    request: GitCheckoutBranchRequest,
) -> Result<GitBranchCatalog, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_rename_branch_impl(&request).map_err(to_string)
    })
    .await
    .map_err(|error| format!("git branch rename worker failed: {error}"))?
}

pub(crate) fn git_rename_branch_impl(
    request: &GitCheckoutBranchRequest,
) -> anyhow::Result<GitBranchCatalog> {
    gyro_core::validate_branch_name(&request.branch)?;
    let root = workspace_root(&request.workspace_path)?;
    let repo_root = git_repo_root(&root)
        .ok_or_else(|| anyhow::anyhow!("the selected folder is not a Git repository"))?;
    let mut command = git_command();
    command
        .arg("-C")
        .arg(&repo_root)
        .args(["branch", "-m", "--"])
        .arg(&request.branch);
    let output = run_bounded_command(
        &command,
        Duration::from_secs(10),
        None,
        64 * 1024,
        64 * 1024,
    );
    git_branch_service::invalidate(&request.workspace_path);
    let output = output?;
    if !output.succeeded() {
        return Err(bounded_command_error("could not rename branch", &output));
    }
    git_branch_catalog_impl(&request.workspace_path)
}

#[tauri::command]
pub(crate) async fn git_remove_worktree(
    request: GitRemoveWorktreeRequest,
) -> Result<GitBranchCatalog, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_remove_worktree_impl(&request).map_err(to_string)
    })
    .await
    .map_err(|error| format!("git worktree removal worker failed: {error}"))?
}

pub(crate) fn sort_branch_catalog_entries(branches: &mut [(i64, String)]) {
    branches.sort_by(|(date_a, branch_a), (date_b, branch_b)| {
        let main_order = (branch_b == "main").cmp(&(branch_a == "main"));
        date_b
            .cmp(date_a)
            .then(main_order)
            .then_with(|| branch_a.cmp(branch_b))
    });
}

pub(crate) fn git_linked_worktrees(repo_root: &Path) -> anyhow::Result<Vec<GitLinkedWorktree>> {
    git_branch_service::linked_worktrees(repo_root, Instant::now() + Duration::from_secs(10))
}

pub(crate) fn git_remove_worktree_impl(
    request: &GitRemoveWorktreeRequest,
) -> anyhow::Result<GitBranchCatalog> {
    gyro_core::validate_branch_name(&request.branch)?;
    let root = workspace_root(&request.workspace_path)?;
    let repo_root = git_repo_root(&root)
        .ok_or_else(|| anyhow::anyhow!("the selected folder is not a Git repository"))?;
    let worktree = git_linked_worktrees(&repo_root)?
        .into_iter()
        .find(|worktree| worktree.branch == request.branch)
        .ok_or_else(|| anyhow::anyhow!("linked worktree not found"))?;
    if root.canonicalize().ok() == Path::new(&worktree.path).canonicalize().ok() {
        return Err(anyhow::anyhow!("cannot remove the active workspace"));
    }

    let mut command = git_command();
    command
        .arg("-C")
        .arg(&repo_root)
        .args(["worktree", "remove"])
        .arg(&worktree.path);
    let output = run_bounded_command(
        &command,
        Duration::from_secs(60),
        Some(Duration::from_secs(30)),
        2 * 1024 * 1024,
        64 * 1024,
    );
    git_branch_service::invalidate(&request.workspace_path);
    let output = output?;
    if !output.succeeded() {
        return Err(bounded_command_error("could not remove worktree", &output));
    }
    git_branch_catalog_impl(&request.workspace_path)
}

pub(crate) fn git_checkout_branch_impl(
    request: &GitCheckoutBranchRequest,
) -> anyhow::Result<GitBranchCatalog> {
    gyro_core::validate_branch_name(&request.branch)?;
    let root = workspace_root(&request.workspace_path)?;
    let repo_root = git_repo_root(&root)
        .ok_or_else(|| anyhow::anyhow!("the selected folder is not a Git repository"))?;
    let catalog = git_branch_catalog_impl(&request.workspace_path)?;
    if !catalog
        .branches
        .iter()
        .any(|branch| branch == &request.branch)
    {
        return Err(anyhow::anyhow!("local branch not found"));
    }
    if catalog.current.as_deref() == Some(request.branch.as_str()) {
        return Ok(catalog);
    }
    // Git refuses switches that would overwrite local changes, while retaining
    // unrelated edits and untracked files without forcing or stashing them.
    let mut switch_command = git_command();
    switch_command
        .arg("-C")
        .arg(&repo_root)
        .arg("switch")
        .arg("--")
        .arg(&request.branch);
    let switched = run_bounded_command(
        &switch_command,
        Duration::from_secs(60),
        Some(Duration::from_secs(30)),
        64 * 1024,
        64 * 1024,
    );
    git_branch_service::invalidate(&request.workspace_path);
    let switched = switched?;
    if !switched.succeeded() {
        return Err(bounded_command_error("could not switch branch", &switched));
    }
    git_branch_catalog_impl(&request.workspace_path)
}

#[tauri::command]
pub(crate) async fn set_session_branch(
    session_id: String,
    branch: String,
) -> Result<Session, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = open_store()?;
        let session_id = parse_uuid(&session_id)?;
        store
            .update_session_branch(session_id, branch)
            .map_err(to_string)?
            .ok_or_else(|| "session not found".into())
    })
    .await
    .map_err(|error| format!("session branch worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn git_diff(request: GitPathRequest) -> Result<IdeCommandOutput, String> {
    tauri::async_runtime::spawn_blocking(move || git_diff_blocking(request))
        .await
        .map_err(|error| format!("git diff worker failed: {error}"))?
}

pub(crate) fn git_diff_blocking(request: GitPathRequest) -> Result<IdeCommandOutput, String> {
    let root = workspace_root(&request.workspace_path).map_err(to_string)?;
    // A UI click never runs repository-configured diff or textconv drivers,
    // and the path is held to the workspace like every other Git action.
    let path = match request.path.as_deref() {
        Some(path) => Some(assert_workspace_entry(&root, path).map_err(to_string)?),
        None => None,
    };
    let mut command = git_command();
    command
        .arg("-C")
        .arg(&root)
        .arg("--literal-pathspecs")
        .arg("diff");
    command.args(["--no-ext-diff", "--no-textconv"]);
    if request.staged.unwrap_or(false) {
        command.arg("--cached");
    }
    command.arg("--");
    if let Some(path) = &path {
        command.arg(path.strip_prefix(&root).map_err(to_string)?);
    }
    let cancel = CancellationToken::default();
    run_command_output_with_limits(command, cancel, Duration::from_secs(120), None)
        .map_err(to_string)
}

#[tauri::command]
pub(crate) async fn git_stage(request: GitStageRequest) -> Result<SourceControlStatus, String> {
    tauri::async_runtime::spawn_blocking(move || git_stage_blocking(request))
        .await
        .map_err(|error| format!("git stage worker failed: {error}"))?
}

pub(crate) fn git_stage_blocking(request: GitStageRequest) -> Result<SourceControlStatus, String> {
    let root = workspace_root(&request.workspace_path).map_err(to_string)?;
    let path = assert_workspace_entry(&root, &request.path).map_err(to_string)?;
    let relative = path.strip_prefix(&root).map_err(to_string)?;
    let mut command = git_command();
    command
        .arg("-C")
        .arg(&root)
        .arg("add")
        .arg("--")
        .arg(relative);
    run_git_action(command)?;
    git_status_impl(&request.workspace_path).map_err(to_string)
}

#[tauri::command]
pub(crate) async fn git_unstage(request: GitStageRequest) -> Result<SourceControlStatus, String> {
    tauri::async_runtime::spawn_blocking(move || git_unstage_blocking(request))
        .await
        .map_err(|error| format!("git unstage worker failed: {error}"))?
}

pub(crate) fn git_unstage_blocking(
    request: GitStageRequest,
) -> Result<SourceControlStatus, String> {
    let root = workspace_root(&request.workspace_path).map_err(to_string)?;
    let path = assert_workspace_entry(&root, &request.path).map_err(to_string)?;
    let relative = path.strip_prefix(&root).map_err(to_string)?;
    let mut command = git_command();
    command
        .arg("-C")
        .arg(&root)
        .arg("restore")
        .arg("--staged")
        .arg("--")
        .arg(relative);
    run_git_action(command)?;
    git_status_impl(&request.workspace_path).map_err(to_string)
}

#[tauri::command]
pub(crate) async fn git_discard(request: GitStageRequest) -> Result<SourceControlStatus, String> {
    tauri::async_runtime::spawn_blocking(move || git_discard_blocking(request))
        .await
        .map_err(|error| format!("git discard worker failed: {error}"))?
}

pub(crate) fn git_discard_blocking(
    request: GitStageRequest,
) -> Result<SourceControlStatus, String> {
    let root = workspace_root(&request.workspace_path).map_err(to_string)?;
    let path = assert_workspace_entry(&root, &request.path).map_err(to_string)?;
    let relative = path.strip_prefix(&root).map_err(to_string)?;
    let mut status_command = git_command();
    status_command
        .arg("-C")
        .arg(&root)
        .args(["status", "--porcelain=v1", "--"])
        .arg(relative);
    let status = run_command_output(status_command).map_err(to_string)?;
    let state = status.stdout.lines().next().unwrap_or_default();
    let is_untracked = state.starts_with("??");
    let is_added = state.as_bytes().first() == Some(&b'A');

    if is_added {
        let mut unstage = git_command();
        unstage
            .arg("-C")
            .arg(&root)
            .args(["rm", "--cached", "-f", "--"])
            .arg(relative);
        run_git_action(unstage)?;
    } else if !is_untracked {
        let mut restore = git_command();
        restore.arg("-C").arg(&root).arg("restore");
        if state.as_bytes().first().is_some_and(|value| *value != b' ') {
            restore.args(["--source=HEAD", "--staged", "--worktree"]);
        } else {
            restore.arg("--worktree");
        }
        restore.arg("--").arg(relative);
        run_git_action(restore)?;
    }

    if is_untracked || is_added {
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_dir() => std::fs::remove_dir_all(&path),
            Ok(_) => std::fs::remove_file(&path),
            Err(_) => Ok(()),
        }
        .map_err(to_string)?;
    }
    git_status_impl(&request.workspace_path).map_err(to_string)
}

#[tauri::command]
pub(crate) async fn git_commit(request: GitCommitRequest) -> Result<IdeCommandOutput, String> {
    tauri::async_runtime::spawn_blocking(move || git_commit_blocking(request))
        .await
        .map_err(|error| format!("git commit worker failed: {error}"))?
}

pub(crate) fn git_commit_blocking(request: GitCommitRequest) -> Result<IdeCommandOutput, String> {
    let root = workspace_root(&request.workspace_path).map_err(to_string)?;
    if request.message.trim().is_empty() {
        return Err("commit message is required".into());
    }
    let mut command = git_command();
    command
        .arg("-C")
        .arg(root)
        .arg("commit")
        .arg("-m")
        .arg(request.message);
    let output = run_command_output(command).map_err(to_string);
    git_branch_service::invalidate(&request.workspace_path);
    output
}

#[tauri::command]
pub(crate) async fn git_create_branch(
    request: GitCreateBranchRequest,
) -> Result<GitBranchCatalog, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_create_branch_impl(&request).map_err(to_string)
    })
    .await
    .map_err(|error| format!("git branch creation worker failed: {error}"))?
}

pub(crate) fn git_create_branch_impl(
    request: &GitCreateBranchRequest,
) -> anyhow::Result<GitBranchCatalog> {
    gyro_core::validate_branch_name(&request.branch)?;
    let root = workspace_root(&request.workspace_path)?;
    let repo_root = git_repo_root(&root)
        .ok_or_else(|| anyhow::anyhow!("the selected folder is not a Git repository"))?;
    let catalog = git_branch_catalog_impl(&request.workspace_path)?;
    if catalog
        .branches
        .iter()
        .any(|branch| branch == &request.branch)
    {
        return Err(anyhow::anyhow!("that branch already exists"));
    }
    let mut command = git_command();
    command
        .arg("-C")
        .arg(&repo_root)
        .args(["checkout", "-b"])
        .arg(&request.branch);
    if let Some(start_point) = request
        .start_point
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        gyro_core::validate_branch_name(start_point)?;
        command.arg(start_point);
    }
    let output = run_bounded_command(
        &command,
        Duration::from_secs(30),
        None,
        2 * 1024 * 1024,
        64 * 1024,
    );
    git_branch_service::invalidate(&request.workspace_path);
    let output = output?;
    if !output.succeeded() {
        return Err(anyhow::anyhow!(
            "{}",
            gyro_core::security::redact_secrets(first_error_line(&output.stderr).as_str())
        ));
    }
    git_branch_catalog_impl(&request.workspace_path)
}

#[tauri::command]
pub(crate) async fn git_push(request: GitSyncRequest) -> Result<GitSyncResult, String> {
    tauri::async_runtime::spawn_blocking(move || git_push_blocking(request))
        .await
        .map_err(|error| format!("git push worker failed: {error}"))?
}

pub(crate) fn git_push_blocking(request: GitSyncRequest) -> Result<GitSyncResult, String> {
    let root = workspace_root(&request.workspace_path).map_err(to_string)?;
    let mut command = git_command();
    command.arg("-C").arg(&root).arg("push");
    // A branch created locally has no upstream yet; `--set-upstream` is the
    // difference between "push" working and failing with a hint. The caller
    // says so from the status it is showing, and a branch that turns out to
    // have no upstream anyway is published rather than refused, so the first
    // push of a branch never depends on the panel having refreshed first.
    if request.set_upstream || git_upstream(&root).is_none() {
        let branch = git_current_branch(&root)
            .ok_or_else(|| "could not determine the current branch".to_string())?;
        command
            .arg("--set-upstream")
            .arg(request.remote.as_deref().unwrap_or("origin"))
            .arg(branch);
    }
    let output = run_command_output(command);
    git_branch_service::invalidate(&request.workspace_path);
    let output = output.map_err(to_string)?;
    Ok(GitSyncResult {
        output,
        status: git_status_impl(&request.workspace_path).map_err(to_string)?,
    })
}

#[tauri::command]
pub(crate) async fn git_pull(request: GitSyncRequest) -> Result<GitSyncResult, String> {
    tauri::async_runtime::spawn_blocking(move || git_pull_blocking(request))
        .await
        .map_err(|error| format!("git pull worker failed: {error}"))?
}

pub(crate) fn git_pull_blocking(request: GitSyncRequest) -> Result<GitSyncResult, String> {
    let root = workspace_root(&request.workspace_path).map_err(to_string)?;
    let mut command = git_command();
    // `--ff-only` keeps a button press from silently producing a merge commit or
    // a rebase; a diverged branch surfaces as an error the user can act on.
    command.arg("-C").arg(&root).args(["pull", "--ff-only"]);
    let output = run_command_output(command);
    git_branch_service::invalidate(&request.workspace_path);
    let output = output.map_err(to_string)?;
    Ok(GitSyncResult {
        output,
        status: git_status_impl(&request.workspace_path).map_err(to_string)?,
    })
}

#[tauri::command]
pub(crate) async fn git_fetch(request: GitSyncRequest) -> Result<GitSyncResult, String> {
    tauri::async_runtime::spawn_blocking(move || git_fetch_blocking(request))
        .await
        .map_err(|error| format!("git fetch worker failed: {error}"))?
}

pub(crate) fn git_fetch_blocking(request: GitSyncRequest) -> Result<GitSyncResult, String> {
    let root = workspace_root(&request.workspace_path).map_err(to_string)?;
    let mut command = git_command();
    command
        .arg("-C")
        .arg(&root)
        .args(["fetch", "--prune"])
        .arg(request.remote.as_deref().unwrap_or("origin"));
    let output = run_command_output(command);
    git_branch_service::invalidate(&request.workspace_path);
    let output = output.map_err(to_string)?;
    // The point of fetching from the UI is refreshed ahead/behind counts.
    Ok(GitSyncResult {
        output,
        status: git_status_impl(&request.workspace_path).map_err(to_string)?,
    })
}

pub(crate) fn git_current_branch(root: &Path) -> Option<String> {
    let mut command = git_command();
    command
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--abbrev-ref", "HEAD"]);
    let output = run_bounded_command(
        &command,
        Duration::from_secs(10),
        None,
        64 * 1024,
        64 * 1024,
    )
    .ok()?;
    if !output.succeeded() {
        return None;
    }
    let branch = output.stdout.trim().to_string();
    // Detached HEAD reports "HEAD", which is not a pushable branch name.
    (!branch.is_empty() && branch != "HEAD").then_some(branch)
}

/// The remote branch the current one tracks, where it tracks one.
pub(crate) fn git_upstream(root: &Path) -> Option<String> {
    let mut command = git_command();
    command
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    let output = run_bounded_command(
        &command,
        Duration::from_secs(10),
        None,
        64 * 1024,
        64 * 1024,
    )
    .ok()?;
    if !output.succeeded() {
        return None;
    }
    let upstream = output.stdout.trim().to_string();
    (!upstream.is_empty()).then_some(upstream)
}

/// A `git` invocation that can never stall waiting to be answered.
///
/// Every git command here runs behind a button in a window, where there is no
/// terminal to answer on. Left to itself git would sit waiting for a username
/// on a push whose credentials have lapsed, and the press would hang until the
/// inactivity timeout rather than say what went wrong. Refusing the prompt
/// turns that wait into git's own error, which names the remote and the cause.
pub(crate) fn git_command() -> Command {
    let mut command = command_with_gui_path("git");
    command.env("GIT_TERMINAL_PROMPT", "0");
    command
}

/// Run a git command that must either do the thing or say why it did not.
///
/// `run_command_output` reports a non-zero exit as data rather than as a
/// failure, which suits a terminal pane but not a button: a stage that git
/// refused would refresh the panel unchanged and read as a press that did
/// nothing. This turns the exit code back into an error carrying git's own
/// first line, which is what the panel puts in front of the user.
pub(crate) fn run_git_action(command: Command) -> Result<IdeCommandOutput, String> {
    let output = run_command_output(command).map_err(to_string)?;
    if output.status == "done" {
        return Ok(output);
    }
    Err(git_action_error(&output))
}

/// What to tell the user about a git command that did not succeed.
pub(crate) fn git_action_error(output: &IdeCommandOutput) -> String {
    let spoken = [output.stderr.as_str(), output.stdout.as_str()]
        .into_iter()
        .map(str::trim)
        .find(|text| !text.is_empty());
    match spoken {
        Some(text) => first_error_line(text),
        // A command killed for running too long, or for saying too much, exits
        // without explaining itself; its termination is the only account there
        // is of it.
        None => format!("the git command {}", output.status),
    }
}

pub(crate) fn first_error_line(stderr: &str) -> String {
    stderr
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("the git command failed")
        .to_string()
}
