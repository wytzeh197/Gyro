//! The desktop's OpenAI-compatible HTTPS runner.
//!
//! This is the shared runner behind the API-key presets (DeepSeek, Mistral,
//! OpenRouter) and every endpoint a user defines as a `custom:<slug>` provider.
//! It lives beside `lib.rs` rather than inside it because the desktop root is
//! already at its architecture size ceiling, and because this is a self-
//! contained domain: resolve an endpoint and a key from config, then run the
//! same tool loop the local runner does.
//!
//! The loop mirrors `run_ollama_chat` deliberately. Tool calls made through a
//! remote endpoint cross the same capability broker, approval policy, audit
//! path, cancellation flag, and streamed events as a local model's, so the
//! transport is the only thing that differs.

use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use uuid::Uuid;

/// The same budget as the local runner: one turn's tool loop, not a whole task.
const OPENAI_COMPATIBLE_MAX_TOOL_ROUNDS: usize = 128;

/// What an endpoint speaking the OpenAI wire format runs as.
///
/// This is a plain HTTPS call Gyro makes itself, so the credential owner is the
/// SDK rather than a vendor CLI.
pub(super) fn openai_compatible_adapter() -> ProviderAdapterDescriptor {
    ProviderAdapterDescriptor {
        kind: ProviderAdapterKind::OpenAiCompatible,
        runner: "openai-compatible-api",
        auth_owner: "provider-sdk",
        timeout_seconds: PROVIDER_CHAT_INACTIVITY_TIMEOUT_SECS,
    }
}

/// The `kind` a config entry declares for an id the static table cannot answer
/// for. Loading config is the only way to classify a hand-added provider.
pub(super) fn declared_provider_kind(provider_id: &str) -> Option<String> {
    let paths = GyroPaths::for_current_user().ok()?;
    let config = GyroConfig::load(&paths).ok()?;
    config
        .model_providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .and_then(|provider| provider.kind.clone())
}

/// What one message cost, as opposed to how full the context window is.
///
/// A turn that runs tools makes several requests and bills every one of them,
/// so the running total and `ProviderContextUsage` answer different questions:
/// the context reading is the last request's input, which is what sizes the
/// window meter, while this is every request added together, which is what the
/// user pays. Keeping them apart is why a turn that ran ten tools does not read
/// as having overrun a window it never approached.
///
/// Only this runner reports it. The API-key presets and custom endpoints reach
/// their model over Gyro's own HTTPS with no vendor dashboard behind them, so
/// Gyro is the only thing counting; the CLI providers meter their own plans and
/// surface that in Usage instead.
pub(super) fn insert_turn_tokens(
    payload: &mut serde_json::Map<String, serde_json::Value>,
    adapter: &ProviderAdapterDescriptor,
    billed: Option<&ProviderContextUsage>,
) {
    if adapter.kind != ProviderAdapterKind::OpenAiCompatible {
        return;
    }
    let Some(value) = billed.and_then(|usage| serde_json::to_value(usage).ok()) else {
        return;
    };
    payload.insert("turnTokens".into(), value);
}

/// Publish the running total mid-turn, so the working header can count up.
///
/// Emitted after each round of the tool loop rather than once at the end: a
/// turn that runs tools for a minute is exactly the turn whose cost the user
/// wants to watch, and a total that only lands when the turn finishes tells
/// them nothing while it is running.
fn emit_provider_turn_tokens(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    usage: &ProviderContextUsage,
) {
    let _ = app.emit(
        PROVIDER_CHAT_EVENT,
        serde_json::json!({
            "sessionId": request.session_id,
            "turnId": request.turn_id,
            "providerId": request.provider_id,
            "modelId": request.model_id,
            "eventId": Uuid::new_v4().to_string(),
            "sequence": next_provider_event_sequence(app, &request.session_id),
            "phase": "turn-tokens",
            "turnTokens": usage,
        }),
    );
}

/// One chat turn against an OpenAI-compatible endpoint.
pub(super) fn run_openai_compatible_chat(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
) -> anyhow::Result<ProviderRunnerOutput> {
    let label = request.provider_label.as_deref().unwrap_or("This provider");
    if request.attachments.iter().any(|attachment| {
        !matches!(
            attachment.kind.as_str(),
            "ide-snapshot" | "browser-snapshot"
        )
    }) {
        anyhow::bail!(
            "{label} currently accepts Browser and Editor snapshots; remove other attachments and retry."
        );
    }
    let cancellation = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .map_err(|_| anyhow::anyhow!("provider cancellation state is unavailable"))?
        .get(&request.session_id)
        .map(|control| control.cancellation.clone())
        .ok_or_else(|| anyhow::anyhow!("provider run control is unavailable"))?;
    if cancellation.is_cancelled() {
        anyhow::bail!("{PROVIDER_STOP_MARKER}: cancelled before {label} started");
    }
    let paths = GyroPaths::for_current_user()?;
    let config = GyroConfig::load(&paths)?;
    let provider = config
        .model_providers
        .iter()
        .find(|provider| provider.id == request.provider_id)
        .ok_or_else(|| anyhow::anyhow!("{label} is not configured"))?;
    let base_url = provider
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!("set a base URL for {label} in Gyro settings before sending")
        })?;
    // Validated before the heartbeat starts so an unusable endpoint costs no
    // background work and no tool round.
    let endpoint = openai_compat_endpoint(base_url)?;
    let api_key = provider_api_key_value(&provider.id);
    if api_key.is_none() && !openai_compat_host_is_loopback(&endpoint) {
        let env_hint = provider_api_key_env_name(&provider.id)
            .map(|name| format!(", or set {name}"))
            .unwrap_or_default();
        anyhow::bail!(
            "no API key is stored for {label}. Add one in Settings > Providers{env_hint}."
        );
    }
    let api_key = api_key.unwrap_or_default();
    let model = request
        .model_id
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .ok_or_else(|| anyhow::anyhow!("select a model for {label} before sending"))?;
    // Only a model that publishes an effort ramp gets one selected in the UI, so
    // an absent effort here means "this endpoint has no such dial", not "the
    // user chose the default".
    let reasoning_effort = request
        .reasoning_effort
        .as_deref()
        .map(str::trim)
        .filter(|effort| !effort.is_empty())
        .map(str::to_string);
    let run_mode = capability_run_mode_for_chat(request.mode);
    let identity = provider_model_identity(request, "over an OpenAI-compatible API");
    let system = if request.mode == ChatMode::Council {
        format!("{identity} Respond in concise Markdown. This Council seat is advisory-only; do not call tools or claim to have executed files, commands, browser actions, or edits.")
    } else {
        format!("{identity} Respond in concise Markdown. Use Gyro tools when they are needed; every tool call is enforced by Gyro's existing approval policy. Never claim an action succeeded until its tool result confirms it.")
    };
    let user = provider_context_message_with_capabilities(
        request,
        local_conversation_history_for_request(request).as_deref(),
        true,
        false,
    );
    let mut messages = vec![
        serde_json::json!({ "role": "system", "content": system }),
        serde_json::json!({ "role": "user", "content": user }),
    ];
    let tools = advertised_capability_descriptors(run_mode)
        .map(|descriptor| {
            serde_json::json!({
                "type": "function",
                "function": {
                    "name": descriptor.id.provider_tool_name(),
                    "description": descriptor.description,
                    "parameters": desktop_capability_tool_schema(descriptor.id),
                }
            })
        })
        .collect::<Vec<_>>();
    let heartbeat_stop = Arc::new(AtomicBool::new(false));
    let heartbeat = spawn_provider_chat_heartbeat(
        app.clone(),
        request.clone(),
        cancellation.clone(),
        heartbeat_stop.clone(),
    );
    let mut response = None;
    let run_result = (|| {
        let mut turn_usage = OllamaTurnUsage::default();
        for round in 0..=OPENAI_COMPATIBLE_MAX_TOOL_ROUNDS {
            if cancellation.is_cancelled() {
                anyhow::bail!("{PROVIDER_STOP_MARKER}: cancelled during {label} response");
            }
            let round_tools = provider_reliability::tools_for_round(
                &mut messages,
                &tools,
                round,
                OPENAI_COMPATIBLE_MAX_TOOL_ROUNDS,
            );
            let tools_offered = !round_tools.is_empty();
            let turn = openai_compat_tool_chat_with_progress(
                OpenAiCompatChatRequest {
                    base_url,
                    api_key: api_key.as_str(),
                    model,
                    messages: messages.clone(),
                    tools: round_tools,
                    reasoning_effort: reasoning_effort.as_deref(),
                },
                &cancellation,
                |delta| {
                    emit_provider_chat_event(
                        app,
                        request,
                        "delta",
                        Some(HarnessRunStatus::Running),
                        Some(delta.to_string()),
                        None,
                        None,
                    );
                },
            )
            .map_err(|error| {
                if error.to_string().contains(OPENAI_COMPAT_CANCELLED_MESSAGE)
                    || cancellation.is_cancelled()
                {
                    anyhow::anyhow!("{PROVIDER_STOP_MARKER}: cancelled during {label} response")
                } else {
                    error
                }
            })?;
            turn_usage.observe(turn.input_tokens, turn.output_tokens);
            if let Some(measured) = turn_usage.measured() {
                emit_provider_turn_tokens(app, request, &measured);
            }
            anyhow::ensure!(
                tools_offered || turn.tool_calls.is_empty(),
                "{label} returned tool calls although no tools were offered"
            );
            if turn.tool_calls.is_empty() {
                response = Some(turn);
                break;
            }
            // OpenAI expects the assistant's calls echoed back with `arguments`
            // as a JSON *string*, and every result tagged with the id it
            // answers. The client parsed those strings into values, so they are
            // re-serialized here.
            let mut calls = Vec::new();
            for call in &turn.tool_calls {
                let arguments = match &call.arguments {
                    serde_json::Value::String(raw) => raw.clone(),
                    other => serde_json::to_string(other)?,
                };
                // A provider that omits the id still needs a stable one, or the
                // result cannot be matched to the call it answers.
                let id = call
                    .id
                    .clone()
                    .unwrap_or_else(|| Uuid::new_v4().to_string());
                calls.push((id, call.name.clone(), arguments, call.arguments.clone()));
            }
            let tool_calls = calls
                .iter()
                .map(|(id, name, arguments, _)| {
                    serde_json::json!({
                        "id": id,
                        "type": "function",
                        "function": { "name": name, "arguments": arguments }
                    })
                })
                .collect::<Vec<_>>();
            messages.push(serde_json::json!({
                "role": "assistant",
                "content": turn.content,
                "tool_calls": tool_calls,
            }));
            for (tool_call_id, name, _arguments, parsed) in calls {
                let Some(capability_id) = provider_reliability::prepare_tool_call(
                    &mut messages,
                    &name,
                    &parsed,
                    Some(&tool_call_id),
                ) else {
                    continue;
                };
                let capability_response =
                    invoke_run_capability(app, &request.session_id, capability_id, parsed)?;
                messages.push(serde_json::json!({
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": serde_json::to_string(&capability_response)?,
                }));
            }
        }
        let response = response.ok_or_else(|| {
            anyhow::anyhow!("{label} exceeded Gyro's tool-call limit for one turn")
        })?;
        if cancellation.is_cancelled() {
            anyhow::bail!("{PROVIDER_STOP_MARKER}: cancelled during {label} response");
        }
        let response_chars = response.content.chars().count();
        Ok(ProviderRunnerOutput {
            activities: provider_activities_for_response(Vec::new(), &response.content),
            context_usage: Some(ProviderContextUsage {
                input_tokens: response.input_tokens,
                output_tokens: response.output_tokens,
                total_tokens: response
                    .input_tokens
                    .zip(response.output_tokens)
                    .map(|(input, output)| input + output),
                // The endpoint reports no window, and a guessed one would
                // misreport how full the context is.
                model_context_window: None,
                ..ProviderContextUsage::default()
            }),
            billed_usage: turn_usage.measured(),
            rate_limits: Vec::new(),
            response: response.content,
            resume_cursor: None,
            retry_count: 0,
            resumed: false,
            streamed_text: None,
            output_summary: Some(provider_output_summary(
                "openai-compatible-api",
                "completed",
                None,
                response_chars,
            )),
        })
    })();
    heartbeat_stop.store(true, Ordering::Relaxed);
    let _ = heartbeat.join();
    run_result
}
