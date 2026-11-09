//! Providers types.

use crate::provider_timeline;
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderChatStreamEvent {
    pub(crate) session_id: String,
    pub(crate) turn_id: Option<String>,
    pub(crate) provider_id: String,
    pub(crate) model_id: Option<String>,
    pub(crate) event_id: String,
    pub(crate) sequence: u64,
    #[serde(flatten)]
    pub(crate) timeline: provider_timeline::TimelinePosition,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) timeline_segments: Option<serde_json::Value>,
    pub(crate) activity_sequence: Option<u64>,
    pub(crate) phase: String,
    pub(crate) status: Option<String>,
    pub(crate) text_delta: Option<String>,
    pub(crate) activity_id: Option<String>,
    pub(crate) activity_kind: Option<String>,
    pub(crate) activity_label: Option<String>,
    pub(crate) activity_detail: Option<String>,
    /// The specifics behind a machine identity — see [`ProviderActivity::note`].
    pub(crate) activity_note: Option<String>,
    pub(crate) additions: Option<usize>,
    pub(crate) deletions: Option<usize>,
    pub(crate) activity_status: Option<String>,
    pub(crate) message: Option<String>,
    pub(crate) error: Option<String>,
    /// How the failure can be repaired, classified by
    /// [`provider_failure_recovery`].
    ///
    /// The stored status event already carries this, but the live surfaces read
    /// the stream. Sending it here is what lets a send the provider rejected
    /// over its own sign-in correct the provider's health immediately, instead
    /// of leaving Settings claiming a verified connection.
    pub(crate) recovery_kind: Option<String>,
    /// Set on a heartbeat once the run has shown nothing for a while. See
    /// [`ProviderQuietClock`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) quiet_seconds: Option<u64>,
}

pub(crate) use gyro_core::provider_runtime::types::{
    ProviderActivity, ProviderAdapterKind, ProviderResumeCursor, ProviderRunAttempt,
    ProviderRunnerOutput,
};
