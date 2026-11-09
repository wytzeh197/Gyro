use crate::provider_runtime::{
    host::RunnerHost,
    limits::{PROVIDER_CHAT_INACTIVITY_TIMEOUT_SECS, PROVIDER_CHAT_MAX_RUNTIME_SECS},
    native_args::claude_chat_args,
    prompts::claude_chat_prompt,
    support::{
        audit_provider_chat_args, claude_multimodal_input, is_model_capacity_error,
        provider_activities_for_response, provider_chat_cwd, provider_output_summary,
        provider_run_failure, provider_stream_failure_detail, recover_streamed_provider_answer,
    },
    text::sanitize_provider_chat_response,
    types::{
        ChatMode, PromptTurn, ProviderChatRequest, ProviderResumeCursor, ProviderRunAttempt,
        ProviderRunnerOutput, StreamedText, StreamingCommandOutput,
    },
};
use std::{io::Write, time::Duration};
use uuid::Uuid;
pub fn run_anthropic_claude_chat(
    host: &dyn RunnerHost,
    request: &ProviderChatRequest,
    resume_cursor: Option<&ProviderResumeCursor>,
    attempt: &mut ProviderRunAttempt,
) -> anyhow::Result<ProviderRunnerOutput> {
    let cwd = provider_chat_cwd(request.workspace_path.as_deref())?;
    let can_resume = resume_cursor.is_some_and(|cursor| cursor.kind == "claude-session");
    let history = if can_resume {
        None
    } else {
        host.conversation_history(request)
    };
    let contextual_message = host.context_message(
        request,
        history.as_deref(),
        PromptTurn {
            resumed: can_resume,
            approvals_sent_separately: false,
        },
    );
    let prompt = claude_chat_prompt(
        &contextual_message,
        request.workspace_path.as_deref(),
        request.suggest_title,
        request.mode == ChatMode::Normal,
        can_resume,
    );
    crate::provider_observation::native_prompt(&serde_json::json!(prompt));
    let permission_mcp_config = Some(host.claude_mcp_config(request)?);
    let session_id = resume_cursor
        .and_then(|cursor| (cursor.kind == "claude-session").then_some(cursor.session_id.clone()))
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let mut process = host.prepare_command("claude", "anthropic", request)?;
    process.current_dir(cwd);
    // `--print` exits when the reply ends, and takes native background shells
    // and monitors with it: a dev build started that way died mid-compile and
    // the chat stalled on "I'll report when it finishes". Long work goes
    // through Gyro's model terminal instead, which outlives the process.
    process
        .env("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "1")
        .env("CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND", "1")
        // Claude Code defers every MCP tool behind ToolSearch unless told
        // otherwise. Gyro's tools then arrived as bare names while native
        // Read/Edit/Bash had full schemas, so Claude reached for the natives
        // and the work never showed up in Review, Terminal or Canvas. The
        // whole Gyro list is ~10K tokens (guarded by a test), so load it.
        .env("ENABLE_TOOL_SEARCH", "false")
        // The default one-hour cache writes at 2x input against 1.25x here.
        // Under 1% of request gaps outlast five minutes, and a read renews it.
        .env("FORCE_PROMPT_CACHING_5M", "1");
    let speed_config = host.config()?;
    process.args(crate::fast_mode::cli_args(
        &speed_config,
        "anthropic",
        request.model_id.as_deref(),
    ));
    let mut args = claude_chat_args(
        resume_cursor
            .filter(|cursor| cursor.kind == "claude-session")
            .map(|_| session_id.as_str()),
        &session_id,
        request.model_id.as_deref(),
        request.reasoning_effort.as_deref(),
        &request.mode,
        request.require_command_approval,
        request.require_file_edit_approval,
        request.full_access,
        permission_mcp_config.as_deref(),
        &prompt,
        host.claude_capability_tools(request.mode),
        host.reasoning_efforts("anthropic", request.model_id.as_deref())
            .as_deref(),
    );
    let input_file = if request.attachments.iter().any(|item| item.kind == "image") {
        let mut input = tempfile::NamedTempFile::new()?;
        serde_json::to_writer(
            input.as_file_mut(),
            &claude_multimodal_input(&prompt, &request.attachments)?,
        )?;
        input.as_file_mut().write_all(b"\n")?;
        // Stream JSON replaces the positional prompt, preserving all policy flags.
        args.truncate(args.len() - 2);
        args.extend(["--input-format".into(), "stream-json".into()]);
        Some(input)
    } else {
        None
    };
    audit_provider_chat_args(&request.provider_id, &args)?;
    process.args(args);

    let mut observed_session_id = None;
    let output = host.stream_command(
        process,
        input_file.as_ref().map(|input| input.path()),
        Duration::from_secs(PROVIDER_CHAT_MAX_RUNTIME_SECS),
        Duration::from_secs(PROVIDER_CHAT_INACTIVITY_TIMEOUT_SECS),
        request,
        &mut observed_session_id,
    );
    // Recorded before the error is propagated: a stopped turn is exactly the
    // case where the cursor has to outlive the run. Claude Code writes the
    // conversation to disk before it announces the session id, so an id that
    // reached the stream is one `--resume` can load; an id Gyro only generated
    // is not.
    attempt.resume_cursor = observed_session_id.map(|session_id| ProviderResumeCursor {
        kind: "claude-session".into(),
        session_id,
    });
    let output = output.map_err(|error| {
        provider_run_failure(
            error,
            "Could not complete Anthropic through Claude Code. Run `claude auth login` in Terminal if needed, then try again.",
        )
    })?;
    if let Some(detail) = crate::provider_stream::claude_subscription_access_refusal(&output.stdout)
        .or_else(|| {
            output
                .assistant_text
                .as_deref()
                .and_then(crate::provider_stream::claude_subscription_access_refusal)
        })
    {
        anyhow::bail!("{detail}");
    }
    if output.status_success {
        // Falling back to raw stdout is only sane when the CLI printed prose.
        // Claude Code prints a JSON stream, so the same fallback answered a
        // question with a dump of the transcript the moment the stream shape
        // moved. An unreadable stream is version drift, and saying so is the
        // only response that leads anywhere.
        let parsed_response = output
            .assistant_text
            .as_deref()
            .filter(|text| !text.trim().is_empty());
        if parsed_response.is_none() && output.parsed_stream_json {
            anyhow::bail!(crate::stream_contract_failure("Anthropic", "Claude Code"));
        }
        let response =
            sanitize_provider_chat_response(parsed_response.unwrap_or(output.stdout.trim()));
        if response.is_empty() {
            anyhow::bail!("Anthropic finished, but Claude did not return a chat response.");
        }
        return Ok(claude_runner_output(
            output,
            response,
            session_id,
            resume_cursor.is_some(),
            false,
        ));
    }

    let stdout = crate::security::redact_secrets(output.stdout.trim());
    let stderr = crate::security::redact_secrets(output.stderr.trim());
    // Still matched across both streams: Claude Code reports a rejected sign-in
    // inside the stream rather than on stderr.
    if let Some(detail) = claude_login_failure(&format!("{stdout}{stderr}")) {
        anyhow::bail!("{detail}");
    }
    // Same partial-success path as Codex: a streamed answer outranks a non-zero
    // exit once the process has actually stopped.
    let failure_detail = provider_stream_failure_detail(&stdout, &stderr);
    if is_model_capacity_error(&failure_detail) {
        attempt.activities = output.activities.clone();
        anyhow::bail!("{failure_detail}");
    }
    if let Some(response) = recover_streamed_provider_answer(&output, "") {
        return Ok(claude_runner_output(
            output,
            response,
            session_id,
            resume_cursor.is_some(),
            true,
        ));
    }
    if stdout.is_empty() && stderr.is_empty() {
        anyhow::bail!(
            "Anthropic through Claude exited with {}",
            output.status_label
        );
    }
    anyhow::bail!("{}", provider_stream_failure_detail(&stdout, &stderr));
}

/// Hands on the billing parser's total. Leaving `accounted_usage` empty let the
/// merged `billed_usage` replace it at completion, losing the cache-write bucket.
pub fn claude_runner_output(
    output: StreamingCommandOutput,
    response: String,
    session_id: String,
    resumed: bool,
    answer_cut_off: bool,
) -> ProviderRunnerOutput {
    let status = if answer_cut_off {
        format!("{} (answer kept after non-zero exit)", output.status_label)
    } else {
        output.status_label.clone()
    };
    let output_summary = provider_output_summary(
        "claude-code",
        &status,
        Some(session_id.as_str()),
        response.chars().count(),
    );
    ProviderRunnerOutput {
        accounted_usage: output.accounted_usage,
        activities: provider_activities_for_response(output.activities, &response),
        context_usage: output.context_usage,
        billed_usage: output.billed_usage,
        rate_limits: output.rate_limits,
        paused_at_tool_budget: false,
        answer_cut_off,
        response,
        resume_cursor: Some(ProviderResumeCursor {
            kind: "claude-session".into(),
            session_id,
        }),
        retry_count: 0,
        resumed,
        streamed_text: output.assistant_text.map(|text| StreamedText {
            text,
            blocks: output.text_blocks,
        }),
        output_summary: Some(output_summary),
    }
}

/// Claude Code reports a rejected sign-in inside its stream-json output rather
/// than on stderr, so a failed run reads as a healthy session start for
/// thousands of characters before the 401 appears. Reducing it to one line
/// keeps the stored failure legible and lets it classify as a sign-in problem
/// instead of a generic retry that cannot succeed.
pub const CLAUDE_LOGIN_EXPIRED_DETAIL: &str = "Claude Code rejected this send with 401 authentication_failed, so its stored sign-in is no longer valid. Sign in again and Gyro will resend the message.";

pub fn claude_login_failure(output: &str) -> Option<&'static str> {
    if output.contains("OAuth access token has expired")
        || output.contains("Failed to authenticate")
    {
        return Some(CLAUDE_LOGIN_EXPIRED_DETAIL);
    }
    output
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
        .any(|value| {
            value
                .get("error_status")
                .and_then(serde_json::Value::as_i64)
                == Some(401)
                || value.get("error").and_then(serde_json::Value::as_str)
                    == Some("authentication_failed")
        })
        .then_some(CLAUDE_LOGIN_EXPIRED_DETAIL)
}
