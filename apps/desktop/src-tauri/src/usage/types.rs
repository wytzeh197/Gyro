//! Usage types.

use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderUsageSnapshot {
    pub(crate) provider_id: String,
    pub(crate) windows: Vec<ProviderRateLimitWindow>,
    pub(crate) fetched_at: String,
    pub(crate) stale: bool,
    pub(crate) error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexRateLimitWindow {
    pub(crate) used_percent: i32,
    pub(crate) window_duration_mins: Option<i64>,
    pub(crate) resets_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexRateLimitSnapshot {
    pub(crate) primary: Option<CodexRateLimitWindow>,
    pub(crate) secondary: Option<CodexRateLimitWindow>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexRateLimitsResponse {
    pub(crate) rate_limits: CodexRateLimitSnapshot,
}

pub(crate) use gyro_core::provider_runtime::types::ProviderRateLimitWindow;
