use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const SNAPSHOT_SCHEMA: &str = "gyro.code-review-snapshot.v1";
pub const RESULT_SCHEMA: &str = "gyro.code-review-result.v1";
pub const MAX_REVIEW_FILES: usize = 64;
pub const MAX_REVIEW_SIDE_BYTES: usize = 1024 * 1024;
pub const MAX_REVIEW_CAPTURE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ReviewScope {
    Uncommitted,
    Branch { base: String },
    Turn { turn_id: Uuid },
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapturedReviewFile {
    pub original_mode: Option<String>,
    pub modified_mode: Option<String>,
    pub path: String,
    pub original_path: Option<String>,
    pub original: Option<String>,
    pub modified: Option<String>,
    pub original_hash: Option<String>,
    pub modified_hash: Option<String>,
    pub status: String,
    pub staged: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewExclusion {
    pub path: String,
    pub reason: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewSnapshot {
    pub previous_review_id: Option<Uuid>,
    pub previous_findings: Vec<ReviewFinding>,
    pub selected_paths: Vec<String>,
    pub schema: String,
    pub id: Uuid,
    pub source_session_id: Uuid,
    pub source_turn_id: Option<Uuid>,
    pub root_id: String,
    pub root_key: String,
    pub scope: ReviewScope,
    pub base_oid: Option<String>,
    pub head_oid: Option<String>,
    pub captured_at: String,
    pub request: String,
    pub request_hash: String,
    pub context: String,
    pub memory_receipt: Option<crate::project_memory::MemoryReceipt>,
    pub files: Vec<CapturedReviewFile>,
    pub exclusions: Vec<ReviewExclusion>,
    pub captured_bytes: usize,
    pub manifest_hash: String,
}
pub struct SnapshotInput {
    pub previous_review_id: Option<Uuid>,
    pub previous_findings: Vec<ReviewFinding>,
    pub selected_paths: Vec<String>,
    pub source_session_id: Uuid,
    pub source_turn_id: Option<Uuid>,
    pub root_id: String,
    pub root_key: String,
    pub scope: ReviewScope,
    pub base_oid: Option<String>,
    pub head_oid: Option<String>,
    pub request: String,
    pub context: String,
    pub memory_receipt: Option<crate::project_memory::MemoryReceipt>,
    pub files: Vec<CapturedReviewFile>,
    pub exclusions: Vec<ReviewExclusion>,
    pub witness_before: String,
    pub witness_after: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ReviewStatus {
    Queued,
    Capturing,
    Running,
    Completed,
    Incomplete,
    Failed,
    Cancelled,
}
impl ReviewStatus {
    pub fn terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Incomplete | Self::Failed | Self::Cancelled
        )
    }
    pub fn may_transition(self, next: Self) -> bool {
        matches!(
            (self, next),
            (
                Self::Queued,
                Self::Capturing | Self::Cancelled | Self::Failed
            ) | (
                Self::Capturing,
                Self::Running | Self::Failed | Self::Cancelled
            ) | (
                Self::Running,
                Self::Completed | Self::Incomplete | Self::Failed | Self::Cancelled
            )
        )
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FindingDisposition {
    Open,
    SentForFix,
    FixClaimed,
    ResolvedByReview,
    Dismissed,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum ReviewSeverity {
    P0,
    P1,
    P2,
    P3,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ReviewSide {
    Original,
    Modified,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewFinding {
    pub resolved_by_review_id: Option<Uuid>,
    pub id: Uuid,
    pub review_id: Uuid,
    pub logical_finding_id: String,
    pub snapshot_id: Uuid,
    pub path: String,
    pub side: ReviewSide,
    pub line_start: usize,
    pub line_end: usize,
    pub anchor_hash: String,
    pub title: String,
    pub severity: ReviewSeverity,
    pub explanation: String,
    pub suggested_resolution: Option<String>,
    pub disposition: FindingDisposition,
    pub revision: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeReviewRun {
    #[serde(default)]
    pub workflow_run_id: Option<Uuid>,
    #[serde(default)]
    pub resolutions: Vec<ReviewResolution>,
    #[serde(default = "default_review_origin")]
    pub origin: crate::UsageOrigin,
    pub id: Uuid,
    pub revision: u64,
    pub source_session_id: Uuid,
    pub review_session_id: Option<Uuid>,
    pub root_id: String,
    pub snapshot_id: Option<Uuid>,
    pub provider_id: String,
    pub model_id: String,
    pub status: ReviewStatus,
    pub summary: Option<String>,
    pub findings: Vec<ReviewFinding>,
    pub limitations: Vec<String>,
    pub supplied_files: usize,
    pub intended_files: usize,
    pub error: Option<String>,
    pub previous_review_id: Option<Uuid>,
    pub created_at: String,
    pub finished_at: Option<String>,
}
fn default_review_origin() -> crate::UsageOrigin {
    crate::UsageOrigin::CodeReview
}
#[derive(Clone, Debug)]
pub struct ParsedReview {
    pub resolutions: Vec<ReviewResolution>,
    pub summary: String,
    pub findings: Vec<ReviewFinding>,
    pub limitations: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewResolution {
    pub finding_id: Uuid,
    pub expected_revision: u64,
    pub previous_anchor_hash: String,
    pub evidence_path: String,
    pub evidence_anchor_hash: String,
    pub explanation: String,
}
