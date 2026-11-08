//! Providers types.

use crate::{
    provider_context::ProviderContextUsage, provider_timeline, reply_segments::StreamedText,
    usage::types::ProviderRateLimitWindow,
};
use gyro_core::UsageTokens;
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderResumeCursor {
    pub(crate) kind: String,
    pub(crate) session_id: String,
}

/// What a run learned about the provider's own conversation before it ended.
///
/// A runner only returns a cursor when it produced an answer, so a turn that is
/// stopped or fails used to throw its provider session away — and on a
/// session's first turn there was no earlier binding to fall back on, which
/// made every retry replay the conversation from nothing. The runner records
/// the cursor here the moment the CLI acknowledges the session, so
/// [`run_provider_chat_with_retry_using`] can persist it even when the run
/// never reached an answer.
///
/// Only set once the provider has acknowledged the session in its own output.
/// A conversation the CLI never wrote cannot be resumed, and a binding pointing
/// at one is worse than no binding at all: it turns a retry that would have
/// worked into a resume failure.
#[derive(Debug, Default)]
pub(crate) struct ProviderRunAttempt {
    pub(crate) resume_cursor: Option<ProviderResumeCursor>,
    pub(crate) tools_dispatched: bool,
    pub(crate) mutations_completed: bool,
    /// Set once the attempt showed text or activity in the chat. From then on
    /// generic failures cannot replay the task. An overload can continue only
    /// inside an acknowledged durable native session.
    pub(crate) published_output: bool,
    /// Recover inside the same acknowledged native thread without replaying
    /// the original instruction as a new task.
    pub(crate) continuing_work: bool,
    /// Already-completed native activity retained when an overload interrupted
    /// the attempt after tools ran.
    pub(crate) activities: Vec<ProviderActivity>,
}

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

#[derive(Debug)]
pub(crate) struct ProviderRunnerOutput {
    pub(crate) accounted_usage: Option<UsageTokens>,
    pub(crate) activities: Vec<ProviderActivity>,
    pub(crate) context_usage: Option<ProviderContextUsage>,
    /// What this call billed, for the usage ledger. Absent when the provider
    /// reported nothing, in which case the ledger falls back to an estimate.
    pub(crate) billed_usage: Option<ProviderContextUsage>,
    pub(crate) rate_limits: Vec<ProviderRateLimitWindow>,
    pub(crate) response: String,
    /// The reply is the checkpoint Gyro asked for after the turn's tool-round
    /// budget ran out, not a stop the model chose. The turn still completed, so
    /// the reply is kept and saved; this only decides whether the completion
    /// notice says why the tool loop ended.
    pub(crate) paused_at_tool_budget: bool,
    /// The answer was kept after the provider exited with an error before
    /// finishing it, so it may be cut off. Saved as done, with a notice.
    pub(crate) answer_cut_off: bool,
    pub(crate) resume_cursor: Option<ProviderResumeCursor>,
    pub(crate) retry_count: u32,
    pub(crate) resumed: bool,
    pub(crate) output_summary: Option<String>,
    /// The stream's raw text and block starts, when the runner streamed text.
    /// Saving the reply records where each block sits on the timeline.
    pub(crate) streamed_text: Option<StreamedText>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProviderActivity {
    pub(crate) id: String,
    pub(crate) kind: String,
    pub(crate) label: String,
    pub(crate) detail: Option<String>,
    /// The human specifics of the row, when `detail` is a machine identity.
    ///
    /// A tool call has both: `detail` says which tool ran (`Skill`,
    /// `mcp__github__create_issue`) and this says what it ran on (`simplify`).
    /// Without the second slot the row can only show one of them, which is how
    /// a rail of real work came to read "Bash", "Bash", "Bash".
    pub(crate) note: Option<String>,
    pub(crate) file_counts: Option<(usize, usize)>,
    pub(crate) status: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProviderAdapterKind {
    OpenAiCodex,
    AnthropicClaude,
    KimiAcp,
    /// Google Antigravity's official CLI (`agy`) in headless stream-json mode.
    AntigravityCli,
    Ollama,
    /// Straight HTTPS to an OpenAI-compatible endpoint: the providers Gyro
    /// ships API-key presets for, and any endpoint the user defines.
    OpenAiCompatible,
    ReadinessOnly,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct ProviderAdapterDescriptor {
    pub(crate) kind: ProviderAdapterKind,
    pub(crate) runner: &'static str,
    pub(crate) auth_owner: &'static str,
    pub(crate) timeout_seconds: u64,
}
