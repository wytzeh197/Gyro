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

/// One of a provider's plan limits, however Gyro came to hear about it.
///
/// Codex answers `account/rateLimits/read` with a used percentage. Claude Code
/// has no equivalent command and instead announces limits on the chat stream,
/// where it names the window and when it resets but never how much of it is
/// spent. `used_percent` is therefore optional: a bar that invented a fill for
/// the providers that do not measure one would be indistinguishable from a
/// measured bar, and wrong in the case that matters — near the limit.
///
/// Both sources land in this one type so a window means the same thing to the
/// composer whether it was polled, streamed, or replayed from the store.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderRateLimitWindow {
    pub(crate) id: String,
    pub(crate) label: String,
    /// `ok`, `warning`, or `exhausted`.
    pub(crate) status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) used_percent: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) resets_at: Option<String>,
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
