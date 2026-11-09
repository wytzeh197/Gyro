use crate::provider_runtime::{
    host::{emit_provider_activity_event, RunnerHost},
    limits::{PROVIDER_CHAT_INACTIVITY_TIMEOUT_SECS, PROVIDER_CHAT_MAX_RUNTIME_SECS},
    support::{
        audit_provider_chat_args, provider_activities_for_response, provider_chat_cwd,
        provider_output_summary, provider_stream_failure_detail, recover_streamed_provider_answer,
    },
    types::{
        ChatMode, PromptTurn, ProviderActivity, ProviderChatRequest, ProviderResumeCursor,
        ProviderRunAttempt, ProviderRunnerOutput, StreamedText,
    },
};
use std::time::Duration;
/// Conversation cursor kind for `agy`'s `--conversation` id.
pub(crate) const ANTIGRAVITY_CURSOR_KIND: &str = "antigravity-conversation";

/// Shown when the official CLI is missing from this machine.

/// Google Antigravity through Google's official CLI (`agy`).
///
/// One process per turn. `agy -p <prompt> --output-format stream-json` writes
/// `step_update` frames while it works and a `result` frame when it stops, and
/// the conversation id those frames carry is what the next turn resumes with
/// `--conversation`, so an Antigravity thread keeps its context without Gyro
/// replaying the transcript.
///
/// Headless runs have no approval channel, so Gyro's posture maps onto the
/// CLI's own `--sandbox` / `--mode` / `--dangerously-skip-permissions` flags
/// rather than a per-call dialog. That is why the provider descriptor reports
/// no approval support.
pub fn run_antigravity_chat(
    host: &dyn RunnerHost,
    request: &ProviderChatRequest,
    resume_cursor: Option<&ProviderResumeCursor>,
    attempt: &mut ProviderRunAttempt,
) -> anyhow::Result<ProviderRunnerOutput> {
    let cwd = provider_chat_cwd(request.workspace_path.as_deref())?;
    let can_resume = resume_cursor.is_some_and(|cursor| cursor.kind == ANTIGRAVITY_CURSOR_KIND);
    let history = if can_resume {
        None
    } else {
        host.conversation_history(request)
    };
    let prompt = host.context_message(
        request,
        history.as_deref(),
        PromptTurn {
            resumed: can_resume,
            approvals_sent_separately: false,
        },
    );
    crate::provider_observation::native_prompt(&serde_json::json!(prompt));

    // A headless run cannot ask, so the posture has to be decided up front:
    // only an unconditional full-access send gets the CLI's permission bypass.
    let full_access = request.full_access
        && !request.require_command_approval
        && !request.require_file_edit_approval;
    let mode = crate::antigravity_cli::execution_mode(
        matches!(request.mode, ChatMode::Plan | ChatMode::Council),
        request.require_command_approval,
        request.require_file_edit_approval,
    );
    if mode == crate::antigravity_cli::AntigravityMode::Plan && request.mode == ChatMode::Normal {
        let activity = ProviderActivity {
            id: "antigravity-read-only".into(),
            kind: "tool".into(),
            label: "Antigravity is planning with read-only access".into(),
            detail: Some("Antigravity cannot show per-tool approval dialogs. Choose Approve for me to allow workspace edits, or Full access for unrestricted tools.".into()),
            file_counts: None,
            note: None,
            status: "completed".into(),
        };
        emit_provider_activity_event(host, request, &activity, None);
    }
    let conversation_id = resume_cursor.and_then(|cursor| {
        (cursor.kind == ANTIGRAVITY_CURSOR_KIND).then_some(cursor.session_id.as_str())
    });
    let args = crate::antigravity_cli::chat_args(
        request.model_id.as_deref(),
        request.reasoning_effort.as_deref(),
        mode,
        full_access,
        conversation_id,
        &prompt,
    );
    audit_provider_chat_args(&request.provider_id, &args)?;

    let mut process = host.prepare_command(
        crate::antigravity_cli::PROGRAM,
        &request.provider_id,
        request,
    )?;
    process.current_dir(cwd);
    process.args(args);

    let mut observed_session_id = None;
    let output = host
        .stream_command(
            process,
            None,
            Duration::from_secs(PROVIDER_CHAT_MAX_RUNTIME_SECS),
            Duration::from_secs(PROVIDER_CHAT_INACTIVITY_TIMEOUT_SECS),
            request,
            &mut observed_session_id,
        )
        .map_err(|error| {
            // Only a missing binary earns the install instructions; every other
            // failure already says what went wrong.
            let detail = error.to_string();
            if detail.contains("No such file") || detail.contains("not found") {
                anyhow::anyhow!(
                    "{}",
                    crate::install_hint("antigravity").unwrap_or_else(|| {
                        "The Antigravity CLI (`agy`) is not installed.".to_string()
                    })
                )
            } else {
                error
            }
        });

    // Recorded before any failure propagates: a stopped or failed turn still
    // leaves a conversation the next message can continue.
    if let Some(conversation_id) = observed_session_id.clone() {
        attempt.resume_cursor = Some(ProviderResumeCursor {
            kind: ANTIGRAVITY_CURSOR_KIND.into(),
            session_id: conversation_id,
        });
    }
    let output = output?;
    let provider_session_id = observed_session_id.clone().unwrap_or_default();
    let accounted_usage = antigravity_accounted_usage(&output.stdout, can_resume);

    let stdout = crate::security::redact_secrets(output.stdout.trim());
    let stderr = crate::security::redact_secrets(output.stderr.trim());
    if crate::antigravity_cli::needs_sign_in(&format!("{stdout}{stderr}")) {
        anyhow::bail!("{}", crate::antigravity_cli::SIGN_IN_HINT);
    }
    if !output.status_success {
        attempt.activities = output.activities.clone();
        anyhow::bail!(
            "Antigravity exited with {}: {}",
            output.status_label,
            provider_stream_failure_detail(&stdout, &stderr)
        );
    }
    if let Some(detail) = antigravity_stream_failure(&stdout) {
        attempt.activities = output.activities.clone();
        anyhow::bail!("{detail}");
    }

    if let Some(response) = recover_streamed_provider_answer(&output, "") {
        let response_chars = response.chars().count();
        return Ok(ProviderRunnerOutput {
            accounted_usage,
            activities: provider_activities_for_response(output.activities, &response),
            context_usage: output.context_usage,
            billed_usage: output.billed_usage,
            rate_limits: output.rate_limits,
            paused_at_tool_budget: false,
            answer_cut_off: false,
            response,
            resume_cursor: observed_session_id.map(|session_id| ProviderResumeCursor {
                kind: ANTIGRAVITY_CURSOR_KIND.into(),
                session_id,
            }),
            retry_count: 0,
            resumed: can_resume,
            streamed_text: output.assistant_text.clone().map(|text| StreamedText {
                text,
                blocks: output.text_blocks.clone(),
            }),
            output_summary: Some(provider_output_summary(
                "agy",
                output.status_label.as_str(),
                Some(provider_session_id.as_str()),
                response_chars,
            )),
        });
    }
    if stdout.is_empty() && stderr.is_empty() {
        anyhow::bail!("Antigravity exited with {}", output.status_label);
    }
    anyhow::bail!("{}", provider_stream_failure_detail(&stdout, &stderr));
}

/// This turn's token counts, excluding prior turns in a resumed conversation.
pub fn antigravity_accounted_usage(stdout: &str, resumed: bool) -> Option<crate::UsageTokens> {
    let usage = crate::antigravity_cli::turn_usage(stdout, resumed)?;
    Some(crate::UsageTokens {
        input_tokens: usage.input_tokens,
        cached_input_tokens: usage.cache_read_tokens,
        cache_write_tokens: 0,
        output_tokens: usage.output_tokens,
        reasoning_output_tokens: usage.thinking_tokens,
        total_tokens: usage.total_tokens,
        measured: true,
        accounting: None,
    })
}

/// The `result` frame's own failure detail, if the turn did not succeed.
pub(crate) fn antigravity_stream_failure(stdout: &str) -> Option<String> {
    crate::antigravity_cli::stream_failure(stdout)
}
