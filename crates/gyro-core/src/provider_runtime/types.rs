//! Provider execution contracts shared by desktop and terminal hosts.
use crate::{UsageTokens, WorkspaceCheckReport, WorkspaceContextSnapshot};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderChatRequest {
    pub session_id: String,
    pub message: String,
    pub turn_id: Option<String>,
    pub provider_id: String,
    pub provider_label: Option<String>,
    pub model_id: Option<String>,
    pub model_label: Option<String>,
    pub reasoning_effort: Option<String>,
    #[serde(default = "default_true")]
    pub require_command_approval: bool,
    #[serde(default = "default_true")]
    pub require_file_edit_approval: bool,
    #[serde(default)]
    pub full_access: bool,
    #[serde(default)]
    pub suggest_title: bool,
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub mode: ChatMode,
    pub goal: Option<SessionGoalContext>,
    pub plan: Option<serde_json::Value>,
    #[serde(default)]
    pub attachments: Vec<ChatAttachmentRequest>,
    #[serde(default)]
    pub workspace_context: Option<WorkspaceContextSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_check: Option<WorkspaceCheckReport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side_chat_context: Option<SideChatContextRequest>,
    /// Set only by Gyro for its own text-only calls. Never read from the UI.
    #[serde(skip)]
    pub internal_purpose: Option<InternalRequestPurpose>,
    /// Host-resolved, root-scoped context. Repository and renderer fields cannot
    /// supply it or turn it into tool authority.
    #[serde(skip)]
    pub project_memory: Option<crate::project_memory::PreparedMemoryContext>,
    /// Only a native coordinator can bind a request to a running journal step.
    #[serde(skip)]
    pub workflow_run_id:Option<uuid::Uuid>,
}

/// Why Gyro itself, rather than the person in the chat, sent a request.
///
/// These calls carry their complete input in the message. They get a minimal
/// prompt with no chat history, chat-only protocols, or browser guidance, and
/// never trigger compaction of the conversation they describe.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InternalRequestPurpose {
    CodeReview,
    WorkflowExtraction,
    ChangeSummary,
    ContextSummary,
    SessionTitle,
}

impl InternalRequestPurpose {
    pub fn label(self) -> &'static str {
        match self {
            Self::CodeReview => "code review",
            Self::WorkflowExtraction => "workflow extraction",
            Self::ChangeSummary => "file-change summary",
            Self::ContextSummary => "conversation checkpoint summary",
            Self::SessionTitle => "chat title",
        }
    }
}

/// The chat a side chat sits beside.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SideChatContextRequest {
    pub session_id: String,
    /// When the side chat's last completed turn read this same chat.
    #[serde(default)]
    pub since: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum ChatMode {
    #[default]
    Normal,
    Plan,
    Council,
}

pub fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionGoalContext {
    pub text: String,
    pub status: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAttachmentRequest {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub path: String,
    pub relative_path: Option<String>,
    pub mime_type: Option<String>,
    pub size: u64,
    pub content_hash: Option<String>,
    pub modified_at: Option<String>,
    pub preview_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderResumeCursor {
    pub kind: String,
    pub session_id: String,
}

/// What a run learned about the provider's own conversation before it ended.
///
/// A runner only returns a cursor when it produced an answer, so a turn that is
/// stopped or fails used to throw its provider session away — and on a
/// session's first turn there was no earlier binding to fall back on, which
/// made every retry replay the conversation from nothing. The runner records
/// the cursor here the moment the CLI acknowledges the session, so
/// `run_provider_chat_with_retry_using` can persist it even when the run
/// never reached an answer.
///
/// Only set once the provider has acknowledged the session in its own output.
/// A conversation the CLI never wrote cannot be resumed, and a binding pointing
/// at one is worse than no binding at all: it turns a retry that would have
/// worked into a resume failure.
#[derive(Debug, Default)]
pub struct ProviderRunAttempt {
    pub resume_cursor: Option<ProviderResumeCursor>,
    pub tools_dispatched: bool,
    pub mutations_completed: bool,
    /// Set once the attempt showed text or activity in the chat. From then on
    /// generic failures cannot replay the task. An overload can continue only
    /// inside an acknowledged durable native session.
    pub published_output: bool,
    /// Recover inside the same acknowledged native thread without replaying
    /// the original instruction as a new task.
    pub continuing_work: bool,
    /// Already-completed native activity retained when an overload interrupted
    /// the attempt after tools ran.
    pub activities: Vec<ProviderActivity>,
}

#[derive(Debug)]
pub struct ProviderRunnerOutput {
    pub accounted_usage: Option<UsageTokens>,
    pub activities: Vec<ProviderActivity>,
    pub context_usage: Option<ProviderContextUsage>,
    /// What this call billed, for the usage ledger. Absent when the provider
    /// reported nothing, in which case the ledger falls back to an estimate.
    pub billed_usage: Option<ProviderContextUsage>,
    pub rate_limits: Vec<ProviderRateLimitWindow>,
    pub response: String,
    /// The reply is the checkpoint Gyro asked for after the turn's tool-round
    /// budget ran out, not a stop the model chose. The turn still completed, so
    /// the reply is kept and saved; this only decides whether the completion
    /// notice says why the tool loop ended.
    pub paused_at_tool_budget: bool,
    /// The answer was kept after the provider exited with an error before
    /// finishing it, so it may be cut off. Saved as done, with a notice.
    pub answer_cut_off: bool,
    pub resume_cursor: Option<ProviderResumeCursor>,
    pub retry_count: u32,
    pub resumed: bool,
    pub output_summary: Option<String>,
    /// The stream's raw text and block starts, when the runner streamed text.
    /// Saving the reply records where each block sits on the timeline.
    pub streamed_text: Option<StreamedText>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderActivity {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub detail: Option<String>,
    /// The human specifics of the row, when `detail` is a machine identity.
    ///
    /// A tool call has both: `detail` says which tool ran (`Skill`,
    /// `mcp__github__create_issue`) and this says what it ran on (`simplify`).
    /// Without the second slot the row can only show one of them, which is how
    /// a rail of real work came to read "Bash", "Bash", "Bash".
    pub note: Option<String>,
    pub file_counts: Option<(usize, usize)>,
    pub status: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderAdapterKind {
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
pub struct ProviderAdapterDescriptor {
    pub kind: ProviderAdapterKind,
    pub runner: &'static str,
    pub auth_owner: &'static str,
    pub timeout_seconds: u64,
}

/// What a turn consumed of the model's context window.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderContextUsage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_context_window: Option<u64>,
    /// True when the count was inferred from text, not reported by the provider.
    /// That count is dropped before it is published as occupancy.
    #[serde(default, skip_serializing_if = "skip_false")]
    pub estimated: bool,
}

fn skip_false(value: &bool) -> bool {
    !*value
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
pub struct ProviderRateLimitWindow {
    pub id: String,
    pub label: String,
    /// `ok`, `warning`, or `exhausted`.
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_percent: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
}

/// Where one streamed text block began and the tool it followed, if any.
#[derive(Clone, Debug)]
pub struct StreamedTextBlock {
    /// Byte offset into the raw streamed text.
    pub start: usize,
    pub after_activity_id: Option<String>,
}

/// A runner's raw streamed text and its block starts, kept so the saved reply
/// can record where each block belongs on the timeline.
#[derive(Clone, Debug)]
pub struct StreamedText {
    pub text: String,
    pub blocks: Vec<StreamedTextBlock>,
}

pub struct StreamingCommandOutput {
    pub activities: Vec<ProviderActivity>,
    pub context_usage: Option<ProviderContextUsage>,
    /// What the run billed, as opposed to what the context now holds.
    ///
    /// The usage ledger wants the turn-wide total: a turn that called tools
    /// made several requests and paid for each. `context_usage` deliberately
    /// prefers the per-request reading because it answers a different question
    /// — how full the window is — so the billing figure is kept apart.
    pub billed_usage: Option<ProviderContextUsage>,
    /// The billing parser's total, with cache reads and writes still apart.
    /// `billed_usage` merges them for the legacy context display.
    pub accounted_usage: Option<UsageTokens>,
    pub rate_limits: Vec<ProviderRateLimitWindow>,
    pub status_success: bool,
    pub status_label: String,
    pub stdout: String,
    pub stderr: String,
    pub assistant_text: Option<String>,
    pub text_blocks: Vec<StreamedTextBlock>,
    pub parsed_stream_json: bool,
    pub provider_session_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderApprovalDecision {
    Approve,
    Reject,
    AppliedByGyro,
}

/// What the provider thread already holds, so a resumed turn does not pay
/// again for guidance that sits earlier in the same thread.
#[derive(Clone, Copy, Default)]
pub struct PromptTurn {
    /// The provider resumes its own session, which already carries the
    /// standing guidance from the turn that opened it.
    pub resumed: bool,
    /// The runner delivers approval policy out of band (Codex developer
    /// instructions), so repeating it in the prompt is pure cost.
    pub approvals_sent_separately: bool,
}
