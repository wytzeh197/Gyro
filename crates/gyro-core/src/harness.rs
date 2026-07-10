use crate::security::redact_secrets;
use anyhow::{anyhow, Result};
use chrono::{DateTime, Utc};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub const HARNESS_SCHEMA_V1: &str = "gyro.harness.v1";
pub const MAX_HARNESS_EVENT_PAYLOAD_BYTES: usize = 128 * 1024;
pub const MAX_HARNESS_RESUME_CURSOR_BYTES: usize = 16 * 1024;
const MAX_HARNESS_TEXT_CHARS: usize = 4_000;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HarnessRunStatus {
    Queued,
    Running,
    Waiting,
    Blocked,
    Done,
    Failed,
    Cancelled,
}

impl HarnessRunStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Waiting => "waiting",
            Self::Blocked => "blocked",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

impl std::fmt::Display for HarnessRunStatus {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderResumeCursorPayload {
    pub kind: String,
    pub session_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRunPayload {
    pub schema: String,
    pub kind: String,
    pub run_id: Uuid,
    pub attempt_id: Uuid,
    pub surface: String,
    pub status: HarnessRunStatus,
    pub provider_id: String,
    pub provider_label: Option<String>,
    pub model_id: Option<String>,
    pub model_label: Option<String>,
    pub message_preview: Option<String>,
    pub runner: Option<String>,
    pub auth_owner: Option<String>,
    pub resumed: bool,
    pub retry_count: u32,
    pub timeout_seconds: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDiagnosticsPayload {
    pub schema: String,
    pub kind: String,
    pub run_id: Uuid,
    pub attempt_id: Uuid,
    pub provider_id: String,
    pub model_id: Option<String>,
    pub status: HarnessRunStatus,
    pub started_at: DateTime<Utc>,
    pub completed_at: DateTime<Utc>,
    pub duration_ms: u128,
    pub retry_count: u32,
    pub resumed: bool,
    pub timeout_seconds: Option<u64>,
    pub failure_reason: Option<String>,
    pub output_summary: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequestPayload {
    pub schema: String,
    pub kind: String,
    pub run_id: Uuid,
    pub approval_id: Uuid,
    pub surface: String,
    pub request_kind: String,
    pub summary: String,
    pub status: HarnessRunStatus,
    pub approval_required: bool,
    pub policy: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRequestPayload {
    pub schema: String,
    pub kind: String,
    pub run_id: Uuid,
    pub request_id: Uuid,
    pub surface: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub status: HarnessRunStatus,
    pub approval_required: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEditProposalPayload {
    pub schema: String,
    pub kind: String,
    pub run_id: Uuid,
    pub proposal_id: Uuid,
    pub surface: String,
    pub path: String,
    pub operation: String,
    pub content_hash: Option<String>,
    pub status: HarnessRunStatus,
    pub approval_required: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffProposalPayload {
    pub schema: String,
    pub kind: String,
    pub run_id: Uuid,
    pub proposal_id: Uuid,
    pub surface: String,
    pub summary: String,
    pub file_count: usize,
    pub status: HarnessRunStatus,
    pub approval_required: bool,
}

impl ProviderRunPayload {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        run_id: Uuid,
        attempt_id: Uuid,
        surface: impl Into<String>,
        status: HarnessRunStatus,
        provider_id: impl Into<String>,
        provider_label: Option<String>,
        model_id: Option<String>,
        model_label: Option<String>,
        message_preview: Option<String>,
        runner: Option<String>,
        auth_owner: Option<String>,
        resumed: bool,
        retry_count: u32,
        timeout_seconds: Option<u64>,
    ) -> Self {
        Self {
            schema: HARNESS_SCHEMA_V1.into(),
            kind: "provider-run".into(),
            run_id,
            attempt_id,
            surface: surface.into(),
            status,
            provider_id: provider_id.into(),
            provider_label,
            model_id,
            model_label,
            message_preview,
            runner,
            auth_owner,
            resumed,
            retry_count,
            timeout_seconds,
        }
    }
}

impl ProviderDiagnosticsPayload {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        run_id: Uuid,
        attempt_id: Uuid,
        provider_id: impl Into<String>,
        model_id: Option<String>,
        status: HarnessRunStatus,
        started_at: DateTime<Utc>,
        completed_at: DateTime<Utc>,
        retry_count: u32,
        resumed: bool,
        timeout_seconds: Option<u64>,
        failure_reason: Option<String>,
        output_summary: Option<String>,
    ) -> Self {
        let duration_ms = completed_at
            .signed_duration_since(started_at)
            .num_milliseconds()
            .max(0) as u128;
        Self {
            schema: HARNESS_SCHEMA_V1.into(),
            kind: "provider-diagnostics".into(),
            run_id,
            attempt_id,
            provider_id: provider_id.into(),
            model_id,
            status,
            started_at,
            completed_at,
            duration_ms,
            retry_count,
            resumed,
            timeout_seconds,
            failure_reason: failure_reason.map(|value| sanitize_harness_text(&value)),
            output_summary: output_summary.map(|value| sanitize_harness_text(&value)),
        }
    }
}

impl ApprovalRequestPayload {
    pub fn new(
        run_id: Uuid,
        request_kind: impl Into<String>,
        summary: impl Into<String>,
        policy: impl Into<String>,
    ) -> Self {
        Self {
            schema: HARNESS_SCHEMA_V1.into(),
            kind: "approval-request".into(),
            run_id,
            approval_id: Uuid::new_v4(),
            surface: "cli".into(),
            request_kind: request_kind.into(),
            summary: sanitize_harness_text(&summary.into()),
            status: HarnessRunStatus::Waiting,
            approval_required: true,
            policy: policy.into(),
        }
    }
}

impl TerminalRequestPayload {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        run_id: Uuid,
        surface: impl Into<String>,
        command: impl Into<String>,
        args: Vec<String>,
        cwd: Option<String>,
        status: HarnessRunStatus,
    ) -> Self {
        Self {
            schema: HARNESS_SCHEMA_V1.into(),
            kind: "terminal-request".into(),
            run_id,
            request_id: Uuid::new_v4(),
            surface: surface.into(),
            command: sanitize_harness_text(&command.into()),
            args: args
                .into_iter()
                .map(|arg| sanitize_harness_text(&arg))
                .collect(),
            cwd: cwd.map(|value| sanitize_harness_text(&value)),
            status,
            approval_required: true,
        }
    }
}

impl FileEditProposalPayload {
    pub fn new(
        run_id: Uuid,
        surface: impl Into<String>,
        path: impl Into<String>,
        operation: impl Into<String>,
        content_hash: Option<String>,
    ) -> Self {
        Self {
            schema: HARNESS_SCHEMA_V1.into(),
            kind: "file-edit-proposal".into(),
            run_id,
            proposal_id: Uuid::new_v4(),
            surface: surface.into(),
            path: sanitize_harness_text(&path.into()),
            operation: operation.into(),
            content_hash,
            status: HarnessRunStatus::Waiting,
            approval_required: true,
        }
    }
}

impl DiffProposalPayload {
    pub fn new(
        run_id: Uuid,
        surface: impl Into<String>,
        summary: impl Into<String>,
        file_count: usize,
    ) -> Self {
        Self {
            schema: HARNESS_SCHEMA_V1.into(),
            kind: "diff-proposal".into(),
            run_id,
            proposal_id: Uuid::new_v4(),
            surface: surface.into(),
            summary: sanitize_harness_text(&summary.into()),
            file_count,
            status: HarnessRunStatus::Waiting,
            approval_required: true,
        }
    }
}

pub fn harness_payload_value<T>(payload: &T) -> Result<Value>
where
    T: Serialize,
{
    let value = serde_json::to_value(payload)?;
    validate_harness_payload_value(value)
}

pub fn validate_harness_payload_value(payload: Value) -> Result<Value> {
    let encoded = serde_json::to_vec(&payload)?;
    if encoded.len() > MAX_HARNESS_EVENT_PAYLOAD_BYTES {
        return Err(anyhow!(
            "harness event payload cannot exceed {MAX_HARNESS_EVENT_PAYLOAD_BYTES} bytes"
        ));
    }
    Ok(payload)
}

pub fn validate_provider_resume_cursor_value(cursor: Value) -> Result<Value> {
    let encoded = serde_json::to_vec(&cursor)?;
    if encoded.len() > MAX_HARNESS_RESUME_CURSOR_BYTES {
        return Err(anyhow!(
            "provider resume cursor cannot exceed {MAX_HARNESS_RESUME_CURSOR_BYTES} bytes"
        ));
    }
    let object = cursor
        .as_object()
        .ok_or_else(|| anyhow!("provider resume cursor must be an object"))?;
    let kind = object
        .get("kind")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .trim();
    let session_id = object
        .get("sessionId")
        .or_else(|| object.get("session_id"))
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .trim();
    if kind.is_empty() || session_id.is_empty() {
        return Err(anyhow!(
            "provider resume cursor requires kind and sessionId"
        ));
    }
    if kind.chars().count() > 64 || session_id.chars().count() > 256 {
        return Err(anyhow!("provider resume cursor fields are too large"));
    }
    Ok(cursor)
}

pub fn decode_provider_resume_cursor<T>(cursor: Value) -> Result<T>
where
    T: DeserializeOwned,
{
    let cursor = validate_provider_resume_cursor_value(cursor)?;
    serde_json::from_value(cursor).map_err(Into::into)
}

pub fn validate_mutation_approval_policy(kind: &str, approval_required: bool) -> Result<()> {
    match kind {
        "command-request" | "terminal-request" | "file-edit-proposal" | "diff-proposal"
            if !approval_required =>
        {
            Err(anyhow!("{kind} must be approval-gated before execution"))
        }
        _ => Ok(()),
    }
}

pub fn sanitize_harness_text(value: &str) -> String {
    let redacted = redact_secrets(&value.replace('\0', ""));
    if redacted.chars().count() <= MAX_HARNESS_TEXT_CHARS {
        return redacted;
    }
    redacted
        .chars()
        .take(MAX_HARNESS_TEXT_CHARS)
        .collect::<String>()
        + "..."
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_provider_run_payload_with_v1_schema() {
        let run_id = Uuid::new_v4();
        let attempt_id = Uuid::new_v4();
        let payload = ProviderRunPayload::new(
            run_id,
            attempt_id,
            "desktop",
            HarnessRunStatus::Running,
            "openai",
            Some("OpenAI".into()),
            Some("gpt-5.5".into()),
            Some("GPT-5.5".into()),
            Some("hello".into()),
            Some("codex-cli".into()),
            Some("provider-cli".into()),
            true,
            1,
            Some(180),
        );

        let value = harness_payload_value(&payload).unwrap();

        assert_eq!(value["schema"], HARNESS_SCHEMA_V1);
        assert_eq!(value["kind"], "provider-run");
        assert_eq!(value["status"], "running");
        assert_eq!(value["runId"], run_id.to_string());
        assert_eq!(value["attemptId"], attempt_id.to_string());
    }

    #[test]
    fn rejects_oversized_harness_payloads() {
        let payload = serde_json::json!({
            "schema": HARNESS_SCHEMA_V1,
            "kind": "provider-run",
            "large": "a".repeat(MAX_HARNESS_EVENT_PAYLOAD_BYTES),
        });

        let error = validate_harness_payload_value(payload).unwrap_err();

        assert!(error.to_string().contains("harness event payload"));
    }

    #[test]
    fn validates_provider_resume_cursor_shape_and_size() {
        let valid = serde_json::json!({
            "kind": "codex-session",
            "sessionId": Uuid::new_v4().to_string(),
        });
        assert!(validate_provider_resume_cursor_value(valid).is_ok());

        let missing_session = serde_json::json!({ "kind": "codex-session" });
        assert!(validate_provider_resume_cursor_value(missing_session)
            .unwrap_err()
            .to_string()
            .contains("sessionId"));

        let oversized = serde_json::json!({
            "kind": "codex-session",
            "sessionId": "a".repeat(MAX_HARNESS_RESUME_CURSOR_BYTES),
        });
        assert!(validate_provider_resume_cursor_value(oversized).is_err());
    }

    #[test]
    fn redacts_provider_diagnostics() {
        let now = Utc::now();
        let payload = ProviderDiagnosticsPayload::new(
            Uuid::new_v4(),
            Uuid::new_v4(),
            "openai",
            Some("gpt-5.5".into()),
            HarnessRunStatus::Failed,
            now,
            now,
            0,
            false,
            Some(180),
            Some("token=sk-abcdefghijklmnopqrstuvwxyz123456".into()),
            None,
        );
        let value = harness_payload_value(&payload).unwrap();

        assert!(value["failureReason"]
            .as_str()
            .unwrap()
            .contains("[REDACTED]"));
        assert!(!value["failureReason"]
            .as_str()
            .unwrap()
            .contains("abcdefghijklmnopqrstuvwxyz"));
    }

    #[test]
    fn enforces_approval_policy_for_mutations() {
        assert!(validate_mutation_approval_policy("command-request", true).is_ok());
        assert!(validate_mutation_approval_policy("terminal-request", false).is_err());
        assert!(validate_mutation_approval_policy("provider-run", false).is_ok());
    }
}
