use crate::{
    app::{
        config::load_config_blocking,
        limits::{
            MAX_CHAT_RESPONSE_BYTES, MAX_CHAT_RESPONSE_CHARS, MAX_CODEX_APP_SERVER_ACTIVITIES,
            MAX_CODEX_APP_SERVER_PATCHES, MAX_CODEX_APP_SERVER_PATCH_BYTES,
            MAX_CODEX_APP_SERVER_PROTOCOL_BYTES, MAX_CODEX_APP_SERVER_PROTOCOL_MESSAGES,
            PROVIDER_STREAM_FLUSH_INTERVAL,
        },
    },
    capabilities::bridge::codex_capability_mcp_config_args,
    codex_images, codex_turn_completion, context_compaction, file_patch_counts,
    project_import_continuation, provider_accounting,
    provider_context::{provider_context_usage_from_app_server, ProviderContextUsage},
    provider_reliability,
    providers::{
        approvals::wait_for_provider_approval,
        binding::{local_conversation_history_for_request, provider_approval_instructions},
        chat_types::{ChatMode, ProviderChatRequest},
        cli_args::{
            audit_provider_chat_args, codex_chat_args, codex_model_arg, codex_reasoning_effort_arg,
            provider_chat_cwd,
        },
        codex_app_server::{
            codex_app_server_result, receive_codex_turn_response, spawn_codex_app_server_reader,
            write_codex_app_server_message,
        },
        events::{emit_provider_activity_event, emit_provider_context_usage},
        markers::publish_streamed_session_title,
        process::{
            command_for_provider, configure_provider_process_group, provider_output_summary,
            provider_stream_failure_detail, ProviderProcessGuard,
        },
        prompt::{openai_codex_chat_prompt, provider_context_message_for_turn, PromptTurn},
        stdout::{provider_activities_for_response, recover_streamed_provider_answer},
        streaming::{
            provider_chat_cancelled, provider_run_failure, provider_stop_message,
            run_streaming_command, spawn_provider_chat_heartbeat,
            PROVIDER_CHAT_INACTIVITY_TIMEOUT_SECS, PROVIDER_CHAT_MAX_RUNTIME_SECS,
        },
        types::{ProviderActivity, ProviderResumeCursor, ProviderRunAttempt, ProviderRunnerOutput},
    },
    state::{
        managers::{ProviderCancellationManager, TempFileGuard},
        provider_run::ProviderApprovalDecision,
    },
    text::{push_bounded, sanitize_provider_chat_response, truncate_chars},
    turn_timing,
};
use anyhow::Context;
use gyro_core::{timing, timing::Stage as TimingStage, GyroPaths};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    path::Path,
    process::{ChildStdin, Stdio},
    sync::{atomic::AtomicBool, mpsc, Arc},
    time::{Duration, Instant},
};
use tauri::Manager;
use uuid::Uuid;
pub(crate) fn run_openai_codex_chat(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    resume_cursor: Option<&ProviderResumeCursor>,
    attempt: &mut ProviderRunAttempt,
) -> anyhow::Result<ProviderRunnerOutput> {
    if request.reasoning_effort.is_some()
        && codex_reasoning_effort_arg(
            request.model_id.as_deref(),
            request.reasoning_effort.as_deref(),
        )
        .is_none()
    {
        anyhow::bail!(
            "{} does not support the selected {} reasoning effort in this Gyro runtime.",
            request.model_label.as_deref().unwrap_or("This model"),
            request.reasoning_effort.as_deref().unwrap_or("unknown")
        );
    }
    if gyro_core::provider_capability_support("openai").available
        || request.require_command_approval
        || request.require_file_edit_approval
        || !request.full_access
    {
        return run_openai_codex_app_server_chat(app, request, resume_cursor, attempt);
    }
    let output_path =
        std::env::temp_dir().join(format!("gyro-codex-response-{}.txt", Uuid::new_v4()));
    // Removed on every exit, including the error returns before the read.
    let _output_file = TempFileGuard(output_path.clone());
    let cwd = provider_chat_cwd(request.workspace_path.as_deref())?;
    let can_resume = resume_cursor.is_some_and(|cursor| cursor.kind == "codex-session");
    let history = if can_resume {
        None
    } else {
        local_conversation_history_for_request(request)
    };
    let contextual_message = provider_context_message_for_turn(
        request,
        history.as_deref(),
        PromptTurn {
            resumed: can_resume,
            approvals_sent_separately: false,
        },
    );
    let prompt = openai_codex_chat_prompt(
        &contextual_message,
        request.workspace_path.as_deref(),
        request.model_label.as_deref(),
        request.suggest_title,
        request.mode == ChatMode::Normal
            && !request.require_command_approval
            && !request.require_file_edit_approval,
        can_resume,
    );

    gyro_core::provider_observation::native_prompt(&serde_json::json!(prompt));
    let mut process = command_for_provider("codex", "openai")?;
    project_import_continuation::apply_data_home(&mut process, request)?;
    process.current_dir(cwd);
    let speed_config = load_config_blocking().map_err(anyhow::Error::msg)?;
    process.args(gyro_core::fast_mode::cli_args(
        &speed_config,
        "openai",
        request.model_id.as_deref(),
    ));
    let args = codex_chat_args(
        resume_cursor.and_then(|cursor| {
            (cursor.kind == "codex-session").then_some(cursor.session_id.as_str())
        }),
        &output_path,
        request.model_id.as_deref(),
        request.reasoning_effort.as_deref(),
        &request.mode,
        request.require_command_approval,
        request.require_file_edit_approval,
        request.full_access,
        &request.attachments,
        &prompt,
    );
    audit_provider_chat_args(&request.provider_id, &args)?;
    process.args(codex_capability_mcp_config_args(app, request)?);
    process.args(args);

    let mut observed_session_id = None;
    let output = run_streaming_command(
        process,
        None,
        Duration::from_secs(PROVIDER_CHAT_MAX_RUNTIME_SECS),
        Duration::from_secs(PROVIDER_CHAT_INACTIVITY_TIMEOUT_SECS),
        app,
        request,
        &mut observed_session_id,
    );
    attempt.resume_cursor = observed_session_id.map(|session_id| ProviderResumeCursor {
        kind: "codex-session".into(),
        session_id,
    });
    let output = output.map_err(|error| {
        provider_run_failure(
            error,
            "Could not complete OpenAI through Codex CLI. Run `codex login` in Terminal if needed, then try again.",
        )
    })?;
    let last_message = read_bounded_optional_text_file(&output_path, MAX_CHAT_RESPONSE_BYTES)?;
    if output.status_success {
        let response = sanitize_provider_chat_response(last_message.trim());
        if !response.is_empty() {
            let response_chars = response.chars().count();
            let provider_session_id = output.provider_session_id.clone();
            return Ok(ProviderRunnerOutput {
                accounted_usage: None,
                activities: provider_activities_for_response(output.activities, &response),
                context_usage: output.context_usage,
                billed_usage: output.billed_usage,
                rate_limits: output.rate_limits,
                paused_at_tool_budget: false,
                answer_cut_off: false,
                response,
                resume_cursor: provider_session_id
                    .clone()
                    .map(|session_id| ProviderResumeCursor {
                        kind: "codex-session".into(),
                        session_id,
                    }),
                retry_count: 0,
                resumed: resume_cursor.is_some(),
                streamed_text: None,
                output_summary: Some(provider_output_summary(
                    "codex-cli",
                    output.status_label.as_str(),
                    provider_session_id.as_deref(),
                    response_chars,
                )),
            });
        }
        let stdout = sanitize_provider_chat_response(output.stdout.trim());
        if !stdout.is_empty() {
            let response_chars = stdout.chars().count();
            let provider_session_id = output.provider_session_id.clone();
            return Ok(ProviderRunnerOutput {
                accounted_usage: None,
                activities: provider_activities_for_response(output.activities, &stdout),
                context_usage: output.context_usage,
                billed_usage: output.billed_usage,
                rate_limits: output.rate_limits,
                paused_at_tool_budget: false,
                answer_cut_off: false,
                response: stdout,
                resume_cursor: provider_session_id
                    .clone()
                    .map(|session_id| ProviderResumeCursor {
                        kind: "codex-session".into(),
                        session_id,
                    }),
                retry_count: 0,
                resumed: resume_cursor.is_some(),
                streamed_text: None,
                output_summary: Some(provider_output_summary(
                    "codex-cli",
                    output.status_label.as_str(),
                    provider_session_id.as_deref(),
                    response_chars,
                )),
            });
        }
        anyhow::bail!("OpenAI finished, but Codex did not return a chat response.");
    }

    // Exit non-zero after a full streamed answer still completes the turn: the
    // process is done, the user has the reply, and failing here only freezes a
    // chat that already finished.
    let failure_detail = provider_stream_failure_detail(output.stdout.trim(), output.stderr.trim());
    if last_message.trim().is_empty()
        && provider_reliability::is_model_capacity_error(&failure_detail)
    {
        attempt.activities = output.activities.clone();
        anyhow::bail!("{failure_detail}");
    }
    if let Some(response) = recover_streamed_provider_answer(&output, last_message.as_str()) {
        let response_chars = response.chars().count();
        let provider_session_id = output.provider_session_id.clone();
        return Ok(ProviderRunnerOutput {
            accounted_usage: None,
            activities: provider_activities_for_response(output.activities, &response),
            context_usage: output.context_usage,
            billed_usage: output.billed_usage,
            rate_limits: output.rate_limits,
            paused_at_tool_budget: false,
            // Codex writes its final message only once the answer is done, so
            // an answer recovered from the stream alone may be cut off.
            answer_cut_off: last_message.trim().is_empty(),
            response,
            resume_cursor: provider_session_id
                .clone()
                .map(|session_id| ProviderResumeCursor {
                    kind: "codex-session".into(),
                    session_id,
                }),
            retry_count: 0,
            resumed: resume_cursor.is_some(),
            streamed_text: None,
            output_summary: Some(provider_output_summary(
                "codex-cli",
                &format!(
                    "{} (answer kept after non-zero exit)",
                    output.status_label.as_str()
                ),
                provider_session_id.as_deref(),
                response_chars,
            )),
        });
    }

    let stdout = gyro_core::security::redact_secrets(output.stdout.trim());
    let stderr = gyro_core::security::redact_secrets(output.stderr.trim());
    if stdout.is_empty() && stderr.is_empty() {
        anyhow::bail!("OpenAI through Codex exited with {}", output.status_label);
    }
    anyhow::bail!("{}", provider_stream_failure_detail(&stdout, &stderr));
}

pub(crate) fn read_bounded_optional_text_file(
    path: &Path,
    max_bytes: usize,
) -> anyhow::Result<String> {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => return Err(error).with_context(|| format!("open {}", path.display())),
    };
    let mut bytes = Vec::with_capacity(max_bytes.min(8 * 1024));
    Read::by_ref(&mut file)
        .take((max_bytes + 1) as u64)
        .read_to_end(&mut bytes)
        .with_context(|| format!("read {}", path.display()))?;
    if bytes.len() > max_bytes {
        anyhow::bail!("provider response file exceeded the {max_bytes} byte limit");
    }
    String::from_utf8(bytes).context("provider response file was not UTF-8")
}

pub(crate) fn run_openai_codex_app_server_chat(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    resume_cursor: Option<&ProviderResumeCursor>,
    attempt: &mut ProviderRunAttempt,
) -> anyhow::Result<ProviderRunnerOutput> {
    let cwd = provider_chat_cwd(request.workspace_path.as_deref())?;
    let can_resume = resume_cursor.is_some_and(|cursor| cursor.kind == "codex-session");
    let history = if can_resume {
        None
    } else {
        local_conversation_history_for_request(request)
    };
    // Approval policy rides in developerInstructions on thread start/resume.
    let contextual_message = provider_context_message_for_turn(
        request,
        history.as_deref(),
        PromptTurn {
            resumed: can_resume,
            approvals_sent_separately: true,
        },
    );
    let prompt = openai_codex_chat_prompt(
        &contextual_message,
        request.workspace_path.as_deref(),
        request.model_label.as_deref(),
        request.suggest_title,
        request.mode == ChatMode::Normal,
        can_resume,
    );
    let mut process = command_for_provider("codex", "openai")?;
    let capability_args = codex_capability_mcp_config_args(app, request)?;
    project_import_continuation::apply_data_home(&mut process, request)?;
    let speed_config = load_config_blocking().map_err(anyhow::Error::msg)?;
    process.args(gyro_core::fast_mode::cli_args(
        &speed_config,
        "openai",
        request.model_id.as_deref(),
    ));
    process
        .current_dir(&cwd)
        .args(capability_args)
        .args(["-c", "features.multi_agent=false"])
        .args(["-c", codex_images::config_arg(&request.mode)])
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_provider_process_group(&mut process);
    timing::mark(TimingStage::ProcessStart);
    let child = gyro_core::process_guard::spawn_guarded(&mut process)
        .map_err(|error| anyhow::anyhow!("could not start Codex app server: {error}"))?;
    timing::mark(TimingStage::ProcessSpawned);
    let mut child = ProviderProcessGuard::new(child);
    let cancellation = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .and_then(|flags| flags.get(&request.session_id).cloned())
        .map(|control| control.cancellation.clone())
        .unwrap_or_default();
    let heartbeat_stop = Arc::new(AtomicBool::new(false));
    let heartbeat = spawn_provider_chat_heartbeat(
        app.clone(),
        request.clone(),
        cancellation,
        heartbeat_stop.clone(),
        None,
    );
    let mut billed = provider_accounting::CodexTurnUsage::new(can_resume);
    let mut provider_completed = false;
    let mut result = (|| -> anyhow::Result<ProviderRunnerOutput> {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("Codex app server input is unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("Codex app server output is unavailable"))?;
        let messages = spawn_codex_app_server_reader(stdout, child.stderr.take());
        let deadline = Instant::now() + Duration::from_secs(PROVIDER_CHAT_MAX_RUNTIME_SECS);

        write_codex_app_server_message(
            &mut stdin,
            &serde_json::json!({
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": {
                        "name": "gyro",
                        "title": "Gyro",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                    "capabilities": { "experimentalApi": true },
                },
            }),
        )
        .map_err(anyhow::Error::msg)?;
        let initialize = receive_codex_turn_response(app, request, &messages, 1, deadline)?;
        codex_app_server_result(&initialize).map_err(anyhow::Error::msg)?;
        write_codex_app_server_message(&mut stdin, &serde_json::json!({ "method": "initialized" }))
            .map_err(anyhow::Error::msg)?;

        let resume_id = resume_cursor.and_then(|cursor| {
            (cursor.kind == "codex-session").then_some(cursor.session_id.as_str())
        });
        let model = codex_model_arg(request.model_id.as_deref());
        let approval_instructions = provider_approval_instructions(request).join("\n");
        let approval_instructions =
            (!approval_instructions.is_empty()).then_some(approval_instructions);
        let (approval_policy, sandbox_mode, sandbox_policy) = codex_app_server_policy(
            &request.mode,
            request.require_command_approval,
            request.require_file_edit_approval,
            request.full_access,
            &cwd,
        );
        let thread_request = if let Some(thread_id) = resume_id {
            serde_json::json!({
                "id": 2,
                "method": "thread/resume",
                "params": {
                    "threadId": thread_id,
                    "cwd": cwd,
                    "model": model,
                    "approvalPolicy": approval_policy,
                    "approvalsReviewer": "user",
                    "sandbox": sandbox_mode,
                    "developerInstructions": approval_instructions,
                },
            })
        } else {
            serde_json::json!({
                "id": 2,
                "method": "thread/start",
                "params": {
                    "cwd": cwd,
                    "model": model,
                    "approvalPolicy": approval_policy,
                    "approvalsReviewer": "user",
                    "sandbox": sandbox_mode,
                    "developerInstructions": approval_instructions,
                    "ephemeral": false,
                },
            })
        };
        write_codex_app_server_message(&mut stdin, &thread_request).map_err(anyhow::Error::msg)?;
        let thread_response = receive_codex_turn_response(app, request, &messages, 2, deadline)?;
        let thread_result =
            codex_app_server_result(&thread_response).map_err(anyhow::Error::msg)?;
        let thread_id = thread_result
            .pointer("/thread/id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("Codex did not return a thread id"))?
            .to_string();
        // The thread exists from here on, so a turn that is stopped or fails
        // below still leaves a cursor the retry can resume.
        attempt.resume_cursor = Some(ProviderResumeCursor {
            kind: "codex-session".into(),
            session_id: thread_id.clone(),
        });

        timing::mark(TimingStage::ProtocolReady);
        billed.bind_thread(&thread_result["thread"]);
        if can_resume {
            billed.set_baseline(provider_accounting::codex_usage_baseline(
                &thread_result["thread"],
            ));
        }
        gyro_core::provider_observation::native_prompt(&serde_json::json!(prompt));
        let mut input = vec![serde_json::json!({ "type": "text", "text": prompt })];
        for attachment in request
            .attachments
            .iter()
            .filter(|item| item.kind == "image")
        {
            input.push(serde_json::json!({
                "type": "localImage",
                "path": attachment.path,
            }));
        }
        let mut turn_params = serde_json::json!({
            "threadId": thread_id,
            "input": input,
            "cwd": cwd,
            "model": model,
            "serviceTier": gyro_core::fast_mode::codex_service_tier(&speed_config, request.model_id.as_deref()),
            "approvalPolicy": approval_policy,
            "approvalsReviewer": "user",
            "sandboxPolicy": sandbox_policy,
        });
        if let Some(effort) = codex_reasoning_effort_arg(
            request.model_id.as_deref(),
            request.reasoning_effort.as_deref(),
        ) {
            turn_params["effort"] = serde_json::Value::String(effort);
        }
        write_codex_app_server_message(
            &mut stdin,
            &serde_json::json!({
                "id": 3,
                "method": "turn/start",
                "params": turn_params,
            }),
        )
        .map_err(anyhow::Error::msg)?;

        let mut response_text = String::new();
        let mut response_text_chars = 0_usize;
        let mut response_text_truncated = false;
        timing::mark(TimingStage::PromptSent);
        let mut commentary_stream = CodexAppServerCommentaryStream::new();
        let mut completed_message = String::new();
        let mut generated_images = codex_images::GeneratedImages::default();
        let mut activities = Vec::new();
        let mut completed_activity_ids = HashSet::new();
        let mut patches = HashMap::<String, serde_json::Value>::new();
        let mut context_usage = None;
        let mut pending_usage = None;
        let mut provider_turn_id = None;
        let mut turn_started = false;
        let mut protocol_messages = 0usize;
        let mut protocol_bytes = 0usize;
        loop {
            if provider_chat_cancelled(app, &request.session_id) {
                anyhow::bail!("{}", provider_stop_message(app, &request.session_id));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                anyhow::bail!("Codex app server turn timed out");
            }
            // Quiet tools often produce no protocol frames for long stretches.
            // The pipe is still open (Disconnected would fire), so silence is
            // not completion — only max runtime, cancel, and real disconnect end
            // the turn.
            let message = match messages.recv_timeout(remaining.min(Duration::from_millis(250))) {
                Ok(message) => message.map_err(anyhow::Error::msg)?,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    flush_codex_app_server_commentary(
                        app,
                        request,
                        &mut commentary_stream,
                        &activities,
                        false,
                    );
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    anyhow::bail!("Codex app server disconnected")
                }
            };
            protocol_messages = protocol_messages.saturating_add(1);
            protocol_bytes = protocol_bytes.saturating_add(serde_json::to_vec(&message)?.len());
            if protocol_messages > MAX_CODEX_APP_SERVER_PROTOCOL_MESSAGES
                || protocol_bytes > MAX_CODEX_APP_SERVER_PROTOCOL_BYTES
            {
                anyhow::bail!("Codex app server exceeded its protocol activity budget");
            }
            let method = message.get("method").and_then(serde_json::Value::as_str);
            if let Some(method) = method.filter(|_| message.get("id").is_some()) {
                let params = message.get("params").cloned().unwrap_or_default();
                handle_codex_app_server_request(
                    app, request, &mut stdin, &message, method, &params, &patches,
                )?;
                continue;
            }
            if message.get("id").and_then(serde_json::Value::as_u64) == Some(3) {
                let result = codex_app_server_result(&message).map_err(anyhow::Error::msg)?;
                provider_turn_id = result
                    .pointer("/turn/id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string);
                billed.bind_turn(provider_turn_id.as_deref());
                turn_started = true;
                if let Some(params) = pending_usage.take() {
                    context_usage = provider_accounting::observe_codex_turn_usage(
                        app,
                        request,
                        &mut billed,
                        &params,
                        &thread_id,
                        provider_turn_id.as_deref(),
                    )
                    .or(context_usage);
                }
                continue;
            }
            let Some(method) = method else { continue };
            let params = message.get("params").cloned().unwrap_or_default();
            match method {
                "thread/tokenUsage/updated" => {
                    if !turn_started {
                        if params.get("threadId").and_then(serde_json::Value::as_str)
                            == Some(&thread_id)
                        {
                            pending_usage = Some(params);
                        }
                    } else {
                        context_usage = provider_accounting::observe_codex_turn_usage(
                            app,
                            request,
                            &mut billed,
                            &params,
                            &thread_id,
                            provider_turn_id.as_deref(),
                        )
                        .or(context_usage);
                    }
                }
                "thread/compacted" => {
                    let activity =
                        context_compaction::codex_context_compaction_activity(&params, "done");
                    record_codex_app_server_activity(
                        app,
                        request,
                        &mut activities,
                        &mut completed_activity_ids,
                        activity,
                    );
                }
                "item/agentMessage/delta" => {
                    if let Some(delta) = params.get("delta").and_then(serde_json::Value::as_str) {
                        if !response_text_truncated {
                            let pushed = push_bounded(
                                &mut response_text,
                                &mut response_text_chars,
                                delta,
                                MAX_CHAT_RESPONSE_CHARS,
                            );
                            response_text_truncated = pushed.truncated;
                        }
                        publish_streamed_session_title(app, request, &response_text, false);
                        commentary_stream.push_delta(
                            &mut activities,
                            params.get("itemId").and_then(serde_json::Value::as_str),
                            delta,
                        );
                        flush_codex_app_server_commentary(
                            app,
                            request,
                            &mut commentary_stream,
                            &activities,
                            false,
                        );
                    }
                }
                "item/fileChange/patchUpdated" => {
                    if let Some(item_id) = params.get("itemId").and_then(serde_json::Value::as_str)
                    {
                        // A `fileChange` item can start before its patch is
                        // available. The later patchUpdated notification is
                        // authoritative; retaining the empty start payload
                        // loses the paths and makes the UI fall back to the
                        // whole workspace diff.
                        insert_codex_app_server_patch(&mut patches, item_id, params.clone())?;
                    }
                }
                "item/started" => {
                    if let Some(item) = params.get("item") {
                        turn_timing::protocol_item(item, "running");
                        match item.get("type").and_then(serde_json::Value::as_str) {
                            Some("imageGeneration")
                                if codex_images::GeneratedImages::accepts(
                                    &params,
                                    &thread_id,
                                    provider_turn_id.as_deref(),
                                ) =>
                            {
                                emit_provider_activity_event(
                                    app,
                                    request,
                                    &codex_images::GeneratedImages::started(item),
                                    None,
                                );
                            }
                            Some("fileChange") => {
                                if let Some(item_id) =
                                    item.get("id").and_then(serde_json::Value::as_str)
                                {
                                    insert_codex_app_server_patch(
                                        &mut patches,
                                        item_id,
                                        serde_json::json!({
                                            "itemId": item_id,
                                            "changes": item.get("changes").cloned().unwrap_or_default(),
                                        }),
                                    )?;
                                }
                            }
                            Some("contextCompaction") => emit_provider_activity_event(
                                app,
                                request,
                                &context_compaction::codex_context_compaction_activity(
                                    &params, "running",
                                ),
                                None,
                            ),
                            _ => {}
                        }
                    }
                }
                "item/completed" => {
                    if let Some(item) = params.get("item") {
                        turn_timing::protocol_item(item, "done");
                        match item.get("type").and_then(serde_json::Value::as_str) {
                            Some("imageGeneration")
                                if codex_images::GeneratedImages::accepts(
                                    &params,
                                    &thread_id,
                                    provider_turn_id.as_deref(),
                                ) =>
                            {
                                let paths = GyroPaths::for_current_user()?;
                                if let Some(activity) = generated_images.complete(
                                    item,
                                    &paths.sessions_dir,
                                    &request.session_id,
                                ) {
                                    record_codex_app_server_activity(
                                        app,
                                        request,
                                        &mut activities,
                                        &mut completed_activity_ids,
                                        activity,
                                    );
                                }
                            }
                            Some("agentMessage") => {
                                let text = item.get("text").and_then(serde_json::Value::as_str);
                                if let Some(text) = text {
                                    publish_streamed_session_title(app, request, text, true);
                                    completed_message =
                                        truncate_chars(text, MAX_CHAT_RESPONSE_CHARS);
                                }
                                commentary_stream.complete_message(
                                    &mut activities,
                                    item.get("id").and_then(serde_json::Value::as_str),
                                    text,
                                );
                                flush_codex_app_server_commentary(
                                    app,
                                    request,
                                    &mut commentary_stream,
                                    &activities,
                                    true,
                                );
                                commentary_stream.finish_message();
                            }
                            Some("commandExecution") => {
                                let activity = codex_item_activity(item, "command", "Ran command");
                                record_codex_app_server_activity(
                                    app,
                                    request,
                                    &mut activities,
                                    &mut completed_activity_ids,
                                    activity,
                                );
                            }
                            Some("fileChange") => {
                                let patch = item
                                    .get("id")
                                    .and_then(serde_json::Value::as_str)
                                    .and_then(|item_id| patches.get(item_id));
                                for activity in codex_file_change_activities(item, patch) {
                                    record_codex_app_server_activity(
                                        app,
                                        request,
                                        &mut activities,
                                        &mut completed_activity_ids,
                                        activity,
                                    );
                                }
                            }
                            Some("reasoning") => {
                                if let Some(activity) = codex_reasoning_activity(item) {
                                    record_codex_app_server_activity(
                                        app,
                                        request,
                                        &mut activities,
                                        &mut completed_activity_ids,
                                        activity,
                                    );
                                }
                            }
                            Some("contextCompaction") => {
                                let activity =
                                    context_compaction::codex_context_compaction_activity(
                                        &params, "done",
                                    );
                                record_codex_app_server_activity(
                                    app,
                                    request,
                                    &mut activities,
                                    &mut completed_activity_ids,
                                    activity,
                                );
                            }
                            _ => {}
                        }
                    }
                }
                "turn/completed" => {
                    if !turn_started {
                        continue;
                    }
                    let Some(status) = codex_turn_completion::completion_status(
                        method,
                        &params,
                        &thread_id,
                        provider_turn_id.as_deref(),
                    ) else {
                        continue;
                    };
                    commentary_stream.complete_message(&mut activities, None, None);
                    flush_codex_app_server_commentary(
                        app,
                        request,
                        &mut commentary_stream,
                        &activities,
                        true,
                    );
                    commentary_stream.finish_message();
                    if status != "completed" {
                        attempt.activities = activities.clone();
                        let detail = codex_turn_completion::failure_message(&params);
                        anyhow::bail!("{detail}");
                    }
                    provider_completed = true;
                    break;
                }
                _ => {}
            }
        }
        if !turn_started {
            anyhow::bail!("Codex did not start the requested turn");
        }
        let response = sanitize_provider_chat_response(if completed_message.trim().is_empty() {
            response_text.trim()
        } else {
            completed_message.trim()
        });
        let response = generated_images.reply(&response);
        if response.is_empty() {
            anyhow::bail!("OpenAI finished, but Codex did not return a chat response.");
        }
        let response_chars = response.chars().count();
        Ok(ProviderRunnerOutput {
            accounted_usage: billed.tokens(),
            activities: provider_activities_for_response(activities, &response),
            // Last-request occupancy is not the turn's billed usage.
            billed_usage: None,
            context_usage,
            rate_limits: Vec::new(),
            paused_at_tool_budget: false,
            answer_cut_off: false,
            response,
            resume_cursor: Some(ProviderResumeCursor {
                kind: "codex-session".into(),
                session_id: thread_id.clone(),
            }),
            retry_count: 0,
            resumed: resume_id.is_some(),
            streamed_text: None,
            output_summary: Some(provider_output_summary(
                "codex-app-server",
                "completed",
                Some(&thread_id),
                response_chars,
            )),
        })
    })();
    drop(heartbeat);
    drop(child);
    if let Some(tokens) = billed.recover() {
        gyro_core::provider_observation::native_usage(tokens);
        if let Ok(output) = &mut result {
            output.accounted_usage = Some(tokens);
        }
        provider_accounting::emit_turn_tokens(app, request, tokens);
    }
    if result.is_err() && !provider_completed {
        if let Some(tokens) = billed.interrupt() {
            gyro_core::provider_observation::native_usage(tokens);
            provider_accounting::emit_turn_tokens(app, request, tokens);
        }
    }
    result
}

/// Execute Codex's explicit `thread/compact/start` request against a persisted
/// thread. A new app-server process is intentional: normal chat turns use the
/// same short-lived connection and resume the durable Codex thread each time.
pub(crate) fn run_openai_codex_context_compaction(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    resume_cursor: &ProviderResumeCursor,
) -> anyhow::Result<Option<ProviderContextUsage>> {
    let cwd = provider_chat_cwd(request.workspace_path.as_deref())?;
    let mut process = command_for_provider("codex", "openai")?;
    project_import_continuation::apply_data_home(&mut process, request)?;
    process
        .current_dir(&cwd)
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_provider_process_group(&mut process);
    let child = gyro_core::process_guard::spawn_guarded(&mut process)
        .map_err(|error| anyhow::anyhow!("could not start Codex app server: {error}"))?;
    let mut child = ProviderProcessGuard::new(child);
    let result = (|| -> anyhow::Result<Option<ProviderContextUsage>> {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("Codex app server input is unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("Codex app server output is unavailable"))?;
        let messages = spawn_codex_app_server_reader(stdout, child.stderr.take());
        let deadline = Instant::now() + Duration::from_secs(PROVIDER_CHAT_MAX_RUNTIME_SECS);

        write_codex_app_server_message(
            &mut stdin,
            &serde_json::json!({
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": {
                        "name": "gyro",
                        "title": "Gyro",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                    "capabilities": { "experimentalApi": true },
                },
            }),
        )
        .map_err(anyhow::Error::msg)?;
        let initialize = receive_codex_turn_response(app, request, &messages, 1, deadline)?;
        codex_app_server_result(&initialize).map_err(anyhow::Error::msg)?;
        write_codex_app_server_message(&mut stdin, &serde_json::json!({ "method": "initialized" }))
            .map_err(anyhow::Error::msg)?;

        let model = codex_model_arg(request.model_id.as_deref());
        let approval_instructions = provider_approval_instructions(request).join("\n");
        let approval_instructions =
            (!approval_instructions.is_empty()).then_some(approval_instructions);
        let (approval_policy, sandbox_mode, _) = codex_app_server_policy(
            &request.mode,
            request.require_command_approval,
            request.require_file_edit_approval,
            request.full_access,
            &cwd,
        );
        write_codex_app_server_message(
            &mut stdin,
            &serde_json::json!({
                "id": 2,
                "method": "thread/resume",
                "params": {
                    "threadId": resume_cursor.session_id,
                    "cwd": cwd,
                    "model": model,
                    "approvalPolicy": approval_policy,
                    "approvalsReviewer": "user",
                    "sandbox": sandbox_mode,
                    "developerInstructions": approval_instructions,
                },
            }),
        )
        .map_err(anyhow::Error::msg)?;
        let thread_response = receive_codex_turn_response(app, request, &messages, 2, deadline)?;
        let thread_result =
            codex_app_server_result(&thread_response).map_err(anyhow::Error::msg)?;
        let thread_id = thread_result
            .pointer("/thread/id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("Codex did not return a thread id"))?;

        write_codex_app_server_message(
            &mut stdin,
            &serde_json::json!({
                "id": 3,
                "method": "thread/compact/start",
                "params": { "threadId": thread_id },
            }),
        )
        .map_err(anyhow::Error::msg)?;

        let mut request_confirmed = false;
        let mut compaction_completed = false;
        // Codex re-measures the thread after replacing its history. Keeping
        // that reading lets the composer meter drop instead of showing the
        // pre-compaction fill until the next turn reports.
        let mut context_usage = None;
        let mut protocol_messages = 0usize;
        let mut protocol_bytes = 0usize;
        loop {
            if provider_chat_cancelled(app, &request.session_id) {
                anyhow::bail!("{}", provider_stop_message(app, &request.session_id));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                anyhow::bail!("Codex context compaction timed out");
            }
            let message = match messages.recv_timeout(remaining.min(Duration::from_millis(250))) {
                Ok(message) => message.map_err(anyhow::Error::msg)?,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    anyhow::bail!("Codex app server disconnected")
                }
            };
            protocol_messages = protocol_messages.saturating_add(1);
            protocol_bytes = protocol_bytes.saturating_add(serde_json::to_vec(&message)?.len());
            if protocol_messages > MAX_CODEX_APP_SERVER_PROTOCOL_MESSAGES
                || protocol_bytes > MAX_CODEX_APP_SERVER_PROTOCOL_BYTES
            {
                anyhow::bail!("Codex app server exceeded its protocol activity budget");
            }
            if message.get("id").and_then(serde_json::Value::as_u64) == Some(3) {
                codex_app_server_result(&message).map_err(anyhow::Error::msg)?;
                request_confirmed = true;
                if compaction_completed {
                    break;
                }
                continue;
            }
            let method = message.get("method").and_then(serde_json::Value::as_str);
            let params = message.get("params").cloned().unwrap_or_default();
            match method {
                Some("thread/tokenUsage/updated") => {
                    if let Some(usage) = provider_context_usage_from_app_server(&params) {
                        emit_provider_context_usage(app, request, &usage);
                        context_usage = Some(usage);
                    }
                }
                Some("thread/compacted") => {
                    compaction_completed = true;
                    if request_confirmed {
                        break;
                    }
                }
                Some("item/completed") => {
                    if params
                        .pointer("/item/type")
                        .and_then(serde_json::Value::as_str)
                        == Some("contextCompaction")
                    {
                        compaction_completed = true;
                        if request_confirmed {
                            break;
                        }
                    }
                }
                // Older app-server versions complete the compact operation as
                // a turn. The response confirms it is this request, so accept
                // a successful terminal turn only after that acknowledgement.
                Some("turn/completed") if request_confirmed => {
                    let status = params
                        .pointer("/turn/status")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("failed");
                    if status == "completed" {
                        break;
                    }
                    let detail = params
                        .pointer("/turn/error/message")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("Codex context compaction did not complete");
                    anyhow::bail!("{detail}");
                }
                _ => {}
            }
        }
        // The fresh reading can trail the completion notice; wait briefly for
        // it rather than persisting a result the meter cannot use.
        let usage_deadline = Instant::now() + Duration::from_millis(750);
        while context_usage.is_none() {
            let remaining = usage_deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            let Ok(Ok(message)) = messages.recv_timeout(remaining) else {
                break;
            };
            if message.get("method").and_then(serde_json::Value::as_str)
                == Some("thread/tokenUsage/updated")
            {
                let params = message.get("params").cloned().unwrap_or_default();
                if let Some(usage) = provider_context_usage_from_app_server(&params) {
                    emit_provider_context_usage(app, request, &usage);
                    context_usage = Some(usage);
                }
            }
        }
        Ok(context_usage)
    })();
    drop(child);
    result
}

pub(crate) fn codex_app_server_policy(
    mode: &ChatMode,
    require_command_approval: bool,
    require_file_edit_approval: bool,
    full_access: bool,
    cwd: &Path,
) -> (&'static str, &'static str, serde_json::Value) {
    gyro_core::codex_execution_policy(
        matches!(mode, ChatMode::Plan | ChatMode::Council),
        require_command_approval,
        require_file_edit_approval,
        full_access,
        cwd,
    )
}

// Codex uses agentMessage for both progress updates and the final answer. Keep
// each live message in the activity timeline; the final matching commentary is
// removed when the durable assistant response is assembled.
#[derive(Debug)]
pub(crate) struct CodexAppServerActiveCommentary {
    pub(crate) activity_index: usize,
    pub(crate) chars: usize,
    pub(crate) truncated: bool,
}

#[derive(Debug)]
pub(crate) struct CodexAppServerCommentaryStream {
    pub(crate) active: Option<CodexAppServerActiveCommentary>,
    pub(crate) dirty: bool,
    pub(crate) last_emit_at: Option<Instant>,
    pub(crate) next_fallback_id: u64,
}

impl CodexAppServerCommentaryStream {
    pub(crate) fn new() -> Self {
        Self {
            active: None,
            dirty: false,
            last_emit_at: None,
            next_fallback_id: 0,
        }
    }

    pub(crate) fn push_delta(
        &mut self,
        activities: &mut Vec<ProviderActivity>,
        item_id: Option<&str>,
        delta: &str,
    ) {
        if delta.is_empty() {
            return;
        }
        let Some(active) = self.ensure_active(activities, item_id) else {
            return;
        };
        if active.truncated {
            return;
        }
        let Some(activity) = activities.get_mut(active.activity_index) else {
            return;
        };
        let pushed = push_bounded(
            &mut activity.label,
            &mut active.chars,
            delta,
            MAX_CHAT_RESPONSE_CHARS,
        );
        active.truncated = pushed.truncated;
        self.dirty |= pushed.accepted_chars > 0;
    }

    pub(crate) fn complete_message(
        &mut self,
        activities: &mut Vec<ProviderActivity>,
        item_id: Option<&str>,
        text: Option<&str>,
    ) {
        if self.active.is_none() && text.map_or(true, str::is_empty) {
            return;
        }
        let Some(active) = self.ensure_active(activities, item_id) else {
            return;
        };
        let Some(activity) = activities.get_mut(active.activity_index) else {
            return;
        };
        if let Some(text) = text {
            activity.label = truncate_chars(text, MAX_CHAT_RESPONSE_CHARS);
            active.chars = activity.label.chars().count();
            active.truncated = text.chars().count() > MAX_CHAT_RESPONSE_CHARS;
        }
        activity.status = "done".into();
        self.dirty |= !activity.label.is_empty();
    }

    pub(crate) fn finish_message(&mut self) {
        self.active = None;
        self.dirty = false;
    }

    pub(crate) fn take_snapshot(
        &mut self,
        activities: &[ProviderActivity],
        force: bool,
    ) -> Option<(ProviderActivity, u64)> {
        if !self.dirty
            || (!force
                && self
                    .last_emit_at
                    .is_some_and(|at| at.elapsed() < PROVIDER_STREAM_FLUSH_INTERVAL))
        {
            return None;
        }
        let active = self.active.as_ref()?;
        let activity = activities.get(active.activity_index)?.clone();
        if activity.label.is_empty() {
            return None;
        }
        self.dirty = false;
        self.last_emit_at = Some(Instant::now());
        Some((activity, active.activity_index as u64))
    }

    pub(crate) fn ensure_active<'a>(
        &'a mut self,
        activities: &mut Vec<ProviderActivity>,
        item_id: Option<&str>,
    ) -> Option<&'a mut CodexAppServerActiveCommentary> {
        if self.active.is_none() {
            if activities.len() >= MAX_CODEX_APP_SERVER_ACTIVITIES {
                return None;
            }
            let id = item_id
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| {
                    let id = format!("codex-commentary-{}", self.next_fallback_id);
                    self.next_fallback_id = self.next_fallback_id.saturating_add(1);
                    id
                });
            let activity_index = activities.len();
            activities.push(ProviderActivity {
                id,
                kind: "commentary".into(),
                label: String::new(),
                detail: None,
                file_counts: None,
                note: None,
                status: "running".into(),
            });
            self.active = Some(CodexAppServerActiveCommentary {
                activity_index,
                chars: 0,
                truncated: false,
            });
        }
        self.active.as_mut()
    }
}

pub(crate) fn flush_codex_app_server_commentary(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    commentary_stream: &mut CodexAppServerCommentaryStream,
    activities: &[ProviderActivity],
    force: bool,
) {
    if let Some((activity, sequence)) = commentary_stream.take_snapshot(activities, force) {
        emit_provider_activity_event(app, request, &activity, Some(sequence));
    }
}

pub(crate) fn insert_codex_app_server_patch(
    patches: &mut HashMap<String, serde_json::Value>,
    item_id: &str,
    patch: serde_json::Value,
) -> anyhow::Result<()> {
    if !patches.contains_key(item_id) && patches.len() >= MAX_CODEX_APP_SERVER_PATCHES {
        anyhow::bail!(
            "Codex returned more than {MAX_CODEX_APP_SERVER_PATCHES} file-change records"
        );
    }
    let encoded_size = serde_json::to_vec(&patch)?.len();
    if encoded_size > MAX_CODEX_APP_SERVER_PATCH_BYTES {
        anyhow::bail!(
            "Codex file-change record exceeded the {MAX_CODEX_APP_SERVER_PATCH_BYTES} byte limit"
        );
    }
    patches.insert(item_id.to_string(), patch);
    Ok(())
}

pub(crate) fn codex_item_activity(
    item: &serde_json::Value,
    kind: &str,
    fallback_label: &str,
) -> ProviderActivity {
    let id = item
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(fallback_label)
        .to_string();
    let label = item
        .get("command")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback_label)
        .to_string();
    let status = item
        .get("status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("done")
        .to_string();
    ProviderActivity {
        id,
        kind: kind.into(),
        label,
        detail: None,
        file_counts: None,
        note: None,
        status,
    }
}

/// Turn a Codex app-server file-change record into path-specific activity.
///
/// A workspace is shared by every chat pane, so a pathless “Updated files” row
/// has no reliable way to claim the current Git diff. Codex provides exact
/// paths in the accumulated patch; retain those instead of attributing every
/// dirty file to this turn.
pub(crate) fn codex_file_change_activities(
    item: &serde_json::Value,
    patch: Option<&serde_json::Value>,
) -> Vec<ProviderActivity> {
    let id = item
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("file-change");
    let status = item
        .get("status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("done");
    let changes = patch
        .and_then(|patch| patch.get("changes"))
        .or_else(|| item.get("changes"))
        .and_then(serde_json::Value::as_array);

    changes
        .into_iter()
        .flatten()
        .filter_map(|change| {
            let path = change.get("path")?.as_str()?.trim();
            (!path.is_empty()).then_some((path, change))
        })
        .enumerate()
        .map(|(index, (path, change))| {
            let path = truncate_chars(path, 1_024);
            ProviderActivity {
                id: format!("{id}-file-{index}"),
                kind: "file".into(),
                label: format!("Updated {path}"),
                detail: Some(path),
                file_counts: change
                    .get("diff")
                    .and_then(serde_json::Value::as_str)
                    .and_then(file_patch_counts::from_unified_diff),
                note: None,
                status: status.into(),
            }
        })
        .collect()
}

/// The headline of a Codex reasoning summary, as a muted status beat.
///
/// Codex writes each summary part as a bold headline over prose
/// (`**Checking file sizes**\n\n…`). Only the headline reaches the rail: it says
/// what the model is doing, while the prose underneath is its reasoning and
/// stays out of the transcript. An empty summary — most items when summaries
/// are off — produces nothing rather than a blank row.
pub(crate) fn codex_reasoning_activity(item: &serde_json::Value) -> Option<ProviderActivity> {
    let summary = item.get("summary")?.as_array()?;
    let label = summary.iter().rev().find_map(|part| {
        part.as_str()
            .or_else(|| part.get("text").and_then(serde_json::Value::as_str))
            .and_then(reasoning_summary_headline)
    })?;
    let id = item
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("reasoning");
    Some(ProviderActivity {
        id: format!("reasoning-{id}"),
        kind: "reasoning".into(),
        label,
        detail: None,
        file_counts: None,
        note: None,
        status: "done".into(),
    })
}

pub(crate) fn reasoning_summary_headline(text: &str) -> Option<String> {
    let first = text.lines().map(str::trim).find(|line| !line.is_empty())?;
    let headline = first
        .trim_start_matches("**")
        .split("**")
        .next()
        .unwrap_or(first)
        .trim();
    (!headline.is_empty()).then(|| headline.chars().take(80).collect())
}

pub(crate) fn record_codex_app_server_activity(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    activities: &mut Vec<ProviderActivity>,
    completed_activity_ids: &mut HashSet<String>,
    activity: ProviderActivity,
) {
    if activities.len() >= MAX_CODEX_APP_SERVER_ACTIVITIES
        || !completed_activity_ids.insert(activity.id.clone())
    {
        return;
    }
    emit_provider_activity_event(app, request, &activity, Some(activities.len() as u64));
    activities.push(activity);
}

pub(crate) fn handle_codex_app_server_request(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    stdin: &mut ChildStdin,
    message: &serde_json::Value,
    method: &str,
    params: &serde_json::Value,
    patches: &HashMap<String, serde_json::Value>,
) -> anyhow::Result<()> {
    let request_id = message
        .get("id")
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("Codex approval request did not include an id"))?;
    let (decision, response) = match method {
        "item/commandExecution/requestApproval" => {
            let decision = if request.require_command_approval {
                wait_for_provider_approval(app, request, "command", params.clone())?
            } else {
                ProviderApprovalDecision::Approve
            };
            let response = codex_provider_approval_response(decision);
            (decision, serde_json::json!({ "decision": response }))
        }
        "item/fileChange/requestApproval" => {
            let mut details = params.clone();
            if let Some(item_id) = params.get("itemId").and_then(serde_json::Value::as_str) {
                if let Some(patch) = patches.get(item_id) {
                    details["patch"] = patch.clone();
                }
            }
            let decision = if request.require_file_edit_approval {
                wait_for_provider_approval(app, request, "file-change", details)?
            } else {
                ProviderApprovalDecision::Approve
            };
            let response = codex_provider_approval_response(decision);
            (decision, serde_json::json!({ "decision": response }))
        }
        "item/permissions/requestApproval" => {
            let decision = wait_for_provider_approval(app, request, "permissions", params.clone())?;
            let response = if decision != ProviderApprovalDecision::Reject {
                serde_json::json!({
                    "permissions": params.get("permissions").cloned().unwrap_or_default(),
                    "scope": "turn",
                    "strictAutoReview": true,
                })
            } else {
                serde_json::json!({
                    "permissions": {},
                    "scope": "turn",
                    "strictAutoReview": true,
                })
            };
            (decision, response)
        }
        _ => {
            write_codex_app_server_message(
                stdin,
                &serde_json::json!({
                    "id": request_id,
                    "error": { "code": -32601, "message": "unsupported Gyro client request" }
                }),
            )
            .map_err(anyhow::Error::msg)?;
            return Ok(());
        }
    };
    let _ = decision;
    write_codex_app_server_message(
        stdin,
        &serde_json::json!({ "id": request_id, "result": response }),
    )
    .map_err(anyhow::Error::msg)
}

pub(crate) fn codex_provider_approval_response(decision: ProviderApprovalDecision) -> &'static str {
    match decision {
        ProviderApprovalDecision::Approve => "accept",
        ProviderApprovalDecision::Reject | ProviderApprovalDecision::AppliedByGyro => "decline",
    }
}
