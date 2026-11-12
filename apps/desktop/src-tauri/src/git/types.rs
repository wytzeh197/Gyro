//! Git types.

use crate::{git::review as source_control_review, ide::types::IdeCommandOutput};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceControlFile {
    pub(crate) path: String,
    pub(crate) original_path: Option<String>,
    pub(crate) state: String,
    pub(crate) staged: bool,
    pub(crate) additions: usize,
    pub(crate) deletions: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MainComparisonStats {
    pub(crate) additions: usize,
    pub(crate) deletions: usize,
    pub(crate) partial: bool,
    pub(crate) files: Vec<SourceControlFile>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceControlStatus {
    pub(crate) read_state: gyro_core::workspace_check::GitReadState,
    pub(crate) stale: bool,
    pub(crate) provider: String,
    /// The requested workspace, whose relative paths this snapshot describes.
    pub(crate) workspace_path: Option<String>,
    pub(crate) available: bool,
    pub(crate) branch: Option<String>,
    pub(crate) upstream: Option<String>,
    /// The branch tracks an upstream the remote no longer has.
    pub(crate) upstream_gone: bool,
    pub(crate) ahead: usize,
    pub(crate) behind: usize,
    /// HEAD points at a commit rather than a branch.
    pub(crate) detached: bool,
    /// A merge, rebase, cherry-pick, revert or bisect left in progress.
    pub(crate) operation: Option<String>,
    pub(crate) stash_count: usize,
    pub(crate) repo_root: Option<String>,
    pub(crate) additions: usize,
    pub(crate) deletions: usize,
    pub(crate) stats_partial: bool,
    /// Preparation has not attempted line counts or commit history yet.
    pub(crate) details_loaded: bool,
    pub(crate) compared_to_main: Option<MainComparisonStats>,
    pub(crate) files: Vec<SourceControlFile>,
    pub(crate) history: Vec<source_control_review::HistoryEntry>,
    pub(crate) history_error: Option<String>,
    pub(crate) last_checked_at: Option<String>,
    pub(crate) error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitBranchCatalog {
    pub(crate) read_state: gyro_core::workspace_check::GitReadState,
    pub(crate) available: bool,
    pub(crate) repo_root: Option<String>,
    pub(crate) current: Option<String>,
    pub(crate) branches: Vec<String>,
    pub(crate) last_commit_at: HashMap<String, i64>,
    pub(crate) tips: Vec<GitBranchTip>,
    pub(crate) latest_commit_at: Option<i64>,
    pub(crate) checked_at: String,
    pub(crate) worktrees: Vec<GitLinkedWorktree>,
    pub(crate) error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitBranchTip {
    pub(crate) name: String,
    pub(crate) reference: String,
    pub(crate) commit: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) symbolic_target: Option<String>,
    pub(crate) committed_at: Option<i64>,
    pub(crate) remote: bool,
    pub(crate) current: bool,
    pub(crate) worktree_path: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitLinkedWorktree {
    pub(crate) branch: String,
    pub(crate) path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitCheckoutBranchRequest {
    pub(crate) workspace_path: String,
    pub(crate) branch: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitRemoveWorktreeRequest {
    pub(crate) workspace_path: String,
    pub(crate) branch: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitPathRequest {
    pub(crate) workspace_path: String,
    pub(crate) path: Option<String>,
    pub(crate) staged: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitStageRequest {
    pub(crate) workspace_path: String,
    pub(crate) path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitCommitRequest {
    pub(crate) workspace_path: String,
    pub(crate) message: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitSyncRequest {
    pub(crate) workspace_path: String,
    /// Push the current branch and record it as upstream when it has none yet.
    #[serde(default)]
    pub(crate) set_upstream: bool,
    #[serde(default)]
    pub(crate) remote: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitCreateBranchRequest {
    pub(crate) workspace_path: String,
    pub(crate) branch: String,
    #[serde(default)]
    pub(crate) start_point: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitSyncResult {
    pub(crate) output: IdeCommandOutput,
    pub(crate) status: SourceControlStatus,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GithubWorkspaceRequest {
    pub(crate) workspace_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GithubWorkflowRunsRequest {
    pub(crate) workspace_path: String,
    #[serde(default)]
    pub(crate) branch: Option<String>,
    #[serde(default)]
    pub(crate) limit: Option<usize>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GithubWorkflowRunRequest {
    pub(crate) workspace_path: String,
    pub(crate) run_id: u64,
    #[serde(default)]
    pub(crate) failed_only: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GithubPullRequestsRequest {
    pub(crate) workspace_path: String,
    #[serde(default)]
    pub(crate) limit: Option<usize>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GithubCreatePullRequestRequest {
    pub(crate) workspace_path: String,
    #[serde(flatten)]
    pub(crate) pull_request: gyro_core::CreatePullRequestRequest,
}
