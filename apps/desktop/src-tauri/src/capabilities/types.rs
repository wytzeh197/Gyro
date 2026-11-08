//! Capabilities types.

use gyro_core::{CapabilityApprovalDecision, ProjectCapabilityPolicy, WorkspaceContextSnapshot};
use serde::Deserialize;
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderApprovalDecisionRequest {
    pub(crate) approval_id: String,
    pub(crate) decision: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CapabilityApprovalDecisionRequest {
    pub(crate) approval_id: String,
    pub(crate) session_id: String,
    pub(crate) turn_id: Option<String>,
    pub(crate) decision: CapabilityApprovalDecision,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveProjectCapabilityPolicyRequest {
    pub(crate) workspace_path: String,
    pub(crate) expected_revision: Option<u64>,
    pub(crate) policy: ProjectCapabilityPolicy,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CapabilityIdeEvidenceUpdate {
    pub(crate) workspace_path: String,
    pub(crate) diagnostics: serde_json::Value,
    #[serde(default)]
    pub(crate) context: Option<WorkspaceContextSnapshot>,
}
