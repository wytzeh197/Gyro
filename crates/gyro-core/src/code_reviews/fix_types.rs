use serde::{Deserialize, Serialize};
use uuid::Uuid;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ReviewFixStatus {
    Queued,
    Dispatching,
    Sent,
    Completed,
    Cancelled,
    Blocked,
    Interrupted,
}
impl ReviewFixStatus {
    pub fn active(&self) -> bool {
        matches!(self, Self::Queued | Self::Dispatching | Self::Sent)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewFixIntent {
    pub id: Uuid,
    pub review_id: Uuid,
    pub review_revision: u64,
    pub source_session_id: Uuid,
    pub root_id: String,
    pub root_key: String,
    pub finding_revisions: std::collections::BTreeMap<Uuid, u64>,
    pub target_fingerprint: String,
    pub provider_id: String,
    pub model_id: String,
    pub message: String,
    pub turn_id: Uuid,
    pub status: ReviewFixStatus,
    pub revision: u64,
    pub error: Option<String>,
    pub created_at: String,
}
