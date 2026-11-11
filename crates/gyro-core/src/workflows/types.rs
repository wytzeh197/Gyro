use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;
pub const WORKFLOW_SCHEMA: &str = "gyro.workflow.v1";
pub const MAX_DEFINITION_BYTES: usize = 256 * 1024;
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowDefinition {
    pub schema: String,
    pub id: String,
    pub name: String,
    pub description: String,
    pub inputs: Vec<WorkflowInput>,
    pub roles: Vec<String>,
    pub steps: Vec<WorkflowStep>,
    pub completion: WorkflowCompletion,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowInput {
    pub id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub input_type: WorkflowInputType,
    #[serde(default)]
    pub required: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WorkflowInputType {
    String,
    Boolean,
    Enum,
    Url,
    Path,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WorkflowAccess {
    ReadOnly,
    Workspace,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkflowStep {
    Agent {
        id: String,
        role: String,
        instructions: String,
        requested_access: WorkflowAccess,
        output: WorkflowOutput,
    },
    Review {
        id: String,
        role: String,
        source_step: String,
        instructions: String,
    },
    Verification {
        id: String,
        command_ref: String,
        instructions: String,
    },
}
impl WorkflowStep {
    pub fn id(&self) -> &str {
        match self {
            Self::Agent { id, .. } | Self::Review { id, .. } | Self::Verification { id, .. } => id,
        }
    }
    pub fn instructions(&self) -> &str {
        match self {
            Self::Agent { instructions, .. }
            | Self::Review { instructions, .. }
            | Self::Verification { instructions, .. } => instructions,
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowOutput {
    pub name: String,
    pub required: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowCompletion {
    pub required_outputs: Vec<String>,
    pub require_review_completion: bool,
    pub require_verification_success: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRoleBinding {
    pub provider_id: String,
    pub model_id: String,
    pub access_ceiling: WorkflowAccess,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowCommandBinding {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_fingerprint: Option<String>,
    pub program: String,
    pub args: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowBinding {
    pub definition_id: String,
    pub definition_hash: String,
    pub roles: BTreeMap<String, WorkflowRoleBinding>,
    pub commands: BTreeMap<String, WorkflowCommandBinding>,
    pub inputs: BTreeMap<String, serde_json::Value>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowAutomationBinding {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuation: Option<WorkflowContinuation>,
    pub source_session_id: Uuid,
    pub root_id: String,
    pub definition: WorkflowDefinition,
    pub binding: WorkflowBinding,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowContinuation {
    pub run_id: Uuid,
    pub revision: u64,
    pub workspace_fingerprint: String,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WorkflowRunStatus {
    Queued,
    Running,
    Waiting,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}
impl WorkflowRunStatus {
    pub fn terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Cancelled | Self::Interrupted
        )
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WorkflowStepStatus {
    Pending,
    Running,
    Completed,
    Waiting,
    Failed,
    Cancelled,
    Interrupted,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowStepAttempt {
    pub step_id: String,
    pub status: WorkflowStepStatus,
    pub session_id: Option<Uuid>,
    pub turn_id: Option<Uuid>,
    pub review_id: Option<Uuid>,
    pub output: Option<String>,
    pub verification_passed: Option<bool>,
    pub review_completed: Option<bool>,
    pub open_findings: usize,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRun {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_run_id: Option<Uuid>,
    pub id: Uuid,
    pub operation_id: Uuid,
    pub revision: u64,
    pub automation_id: Option<Uuid>,
    pub source_session_id: Uuid,
    pub root_id: String,
    pub root_key: String,
    pub origin: crate::UsageOrigin,
    pub definition: WorkflowDefinition,
    pub binding: WorkflowBinding,
    pub status: WorkflowRunStatus,
    pub steps: Vec<WorkflowStepAttempt>,
    pub requirements_met: Option<bool>,
    pub error: Option<String>,
    pub created_at: String,
    pub finished_at: Option<String>,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WorkflowDraftStatus {
    Preview,
    Queued,
    Running,
    Ready,
    Failed,
    Interrupted,
    Cancelled,
}
impl WorkflowDraftStatus {
    pub fn active(self) -> bool {
        matches!(self, Self::Queued | Self::Running)
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowDraft {
    pub id: Uuid,
    pub revision: u64,
    pub source_session_id: Uuid,
    pub root_id: String,
    pub root_key: String,
    pub source_turn_ids: Vec<Uuid>,
    pub source_complete: bool,
    pub input: String,
    pub capture_hash: String,
    pub status: WorkflowDraftStatus,
    pub extraction_session_id: Option<Uuid>,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub definition: Option<WorkflowDefinition>,
    pub error: Option<String>,
    pub created_at: String,
}
