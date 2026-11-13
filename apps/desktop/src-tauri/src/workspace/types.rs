//! Workspace types.

use crate::{
    git::types::{GitBranchCatalog, SourceControlStatus},
    ide::types::{TaskDefinitionResult, TestTreeItemResult},
};
use gyro_core::{MutationProposal, SessionEvent};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceFile {
    pub(crate) path: String,
    pub(crate) kind: String,
    pub(crate) depth: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceFileContent {
    pub(crate) path: String,
    pub(crate) content: String,
    pub(crate) truncated: bool,
    pub(crate) size_bytes: u64,
    pub(crate) content_hash: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceFileStat {
    pub(crate) path: String,
    pub(crate) kind: String,
    pub(crate) size_bytes: u64,
    pub(crate) content_hash: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceFileWriteRequest {
    pub(crate) workspace_path: String,
    pub(crate) path: String,
    pub(crate) content: String,
    pub(crate) expected_hash: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileMutationProposalRequest {
    pub(crate) session_id: String,
    pub(crate) turn_id: Option<String>,
    pub(crate) path: String,
    pub(crate) content: String,
    pub(crate) expected_hash: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileMutationDecisionRequest {
    pub(crate) proposal_id: String,
    pub(crate) decision: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileMutationDecisionResult {
    pub(crate) proposal: MutationProposal,
    pub(crate) event: SessionEvent,
    pub(crate) file: Option<WorkspaceFileContent>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspacePathCreateRequest {
    pub(crate) workspace_path: String,
    pub(crate) path: String,
    pub(crate) kind: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspacePathRenameRequest {
    pub(crate) workspace_path: String,
    pub(crate) from_path: String,
    pub(crate) to_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspacePathDeleteRequest {
    pub(crate) workspace_path: String,
    pub(crate) path: String,
    pub(crate) expected_hash: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspacePathDuplicateRequest {
    pub(crate) workspace_path: String,
    pub(crate) path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceSearchRequest {
    pub(crate) workspace_path: String,
    pub(crate) query: String,
    pub(crate) globs: Option<Vec<String>>,
    pub(crate) max_results: Option<usize>,
    /// When true, treat `query` as a regex (ripgrep default). UI search leaves
    /// this off so ordinary user typing is fixed-string.
    #[serde(default)]
    pub(crate) regex: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceSearchResult {
    pub(crate) path: String,
    pub(crate) line_number: usize,
    pub(crate) line: String,
    pub(crate) ranges: Vec<WorkspaceSearchRange>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceSearchRange {
    pub(crate) start_column: usize,
    pub(crate) end_column: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspacePreparationRequest {
    pub(crate) workspace_path: String,
    pub(crate) run_id: String,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum GitPreparationCheck {
    Status,
    Branches,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspacePreparationError {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) git_check: Option<GitPreparationCheck>,
    pub(crate) phase: String,
    pub(crate) message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspacePreparationProgress {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) git_state: Option<gyro_core::workspace_check::GitReadState>,
    pub(crate) run_id: String,
    pub(crate) workspace_path: String,
    pub(crate) phase: Option<String>,
    pub(crate) status: String,
    pub(crate) completed_steps: usize,
    pub(crate) total_steps: usize,
    pub(crate) message: String,
    pub(crate) errors: Vec<WorkspacePreparationError>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspacePreparationSnapshot {
    #[serde(flatten)]
    pub(crate) progress: WorkspacePreparationProgress,
    pub(crate) files: Vec<WorkspaceFile>,
    pub(crate) source_control: Option<SourceControlStatus>,
    pub(crate) branches: Option<GitBranchCatalog>,
    pub(crate) tasks: Vec<TaskDefinitionResult>,
    pub(crate) tests: Vec<TestTreeItemResult>,
    pub(crate) watcher_mode: String,
    pub(crate) generation: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceChangedEvent {
    pub(crate) workspace_path: String,
    pub(crate) generation: u64,
    pub(crate) files: Vec<WorkspaceFile>,
}
