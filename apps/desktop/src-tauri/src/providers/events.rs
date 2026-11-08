use crate::{
    app::{
        config::load_config_blocking,
        limits::{MAX_DESKTOP_SESSION_EVENTS_READ, PROVIDER_CHAT_EVENT},
    },
    context_compaction, live_model_context,
    provider_context::{provider_context_usage_with_window, ProviderContextUsage},
    provider_reliability,
    provider_reliability::{provider_failure_recovery, readable_provider_error},
    provider_retry_recovery, provider_session_lifecycle, provider_timeline,
    providers::{
        chat_types::{ChatMode, ProviderChatRequest},
        process::provider_adapter_for,
        runners::kimi_acp::provider_resume_cursor_from_binding,
        types::{ProviderActivity, ProviderChatStreamEvent},
    },
    session_title_stream,
    state::managers::ProviderCancellationManager,
    text::chat_message_preview,
    usage::fetch::publish_live_provider_usage,
};
use gyro_core::{
    timing, timing::Stage as TimingStage, HarnessRunStatus, ProviderDiagnosticsPayload,
    ProviderRunPayload, SessionEvent, SessionEventKind, SessionStore,
};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{Emitter, Manager};
use uuid::Uuid;
pub(crate) fn append_provider_status_event(
    store: &SessionStore,
    session_id: Uuid,
    request: &ProviderChatRequest,
    turn_id: Option<Uuid>,
    attempt_id: Uuid,
    status: HarnessRunStatus,
    error: Option<&str>,
) -> anyhow::Result<SessionEvent> {
    let provider_label = request.provider_label.as_deref().unwrap_or("Provider");
    let adapter = provider_adapter_for(&request.provider_id);
    let payload = ProviderRunPayload::new(
        turn_id.unwrap_or_else(Uuid::new_v4),
        attempt_id,
        "desktop",
        status.clone(),
        request.provider_id.clone(),
        request.provider_label.clone(),
        request.model_id.clone(),
        request.model_label.clone(),
        Some(chat_message_preview(&request.message)),
        Some(adapter.runner.into()),
        Some(adapter.auth_owner.into()),
        false,
        0,
        Some(adapter.timeout_seconds),
    );
    let mut payload = gyro_core::harness_payload_value(&payload)?;
    if let Some(object) = payload.as_object_mut() {
        object.insert(
            "sessionLeaseVersion".into(),
            serde_json::Value::from(provider_session_lifecycle::SESSION_LEASE_VERSION),
        );
        object.insert(
            "reasoningEffort".into(),
            request
                .reasoning_effort
                .clone()
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null),
        );
        object.insert(
            "kind".into(),
            serde_json::Value::String("provider-status".into()),
        );
        object.insert("recoveryOwner".into(), serde_json::json!("backend"));
        let cooldown = gyro_core::provider_cooldown::remaining().max(
            error
                .filter(|error| provider_reliability::is_rate_limit_error(error))
                .and_then(gyro_core::provider_retry::provider_cooldown_hint)
                .unwrap_or_default(),
        );
        if !cooldown.is_zero() {
            object.insert(
                "retryNotBefore".into(),
                serde_json::json!((chrono::Utc::now()
                    + chrono::Duration::from_std(cooldown).unwrap_or_default())
                .to_rfc3339()),
            );
        }

        object.insert(
            "error".into(),
            error
                .map(|error| gyro_core::sanitize_harness_text(&readable_provider_error(error)))
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null),
        );
        if let Some(error) = error {
            let current_attempt = attempt_id.to_string();
            let previous = store
                .read_recent_events(session_id, MAX_DESKTOP_SESSION_EVENTS_READ)
                .ok()
                .and_then(|events| {
                    events
                        .into_iter()
                        .rev()
                        .filter(|event| event.turn_id == turn_id)
                        .take_while(|event| {
                            event
                                .payload
                                .get("attemptId")
                                .and_then(serde_json::Value::as_str)
                                .map_or(true, |id| id == current_attempt)
                        })
                        .find(|event| event.payload.get("recovery").is_some())
                })
                .and_then(|event| event.payload.get("recovery").cloned());
            let continuation = store
                .get_provider_session_binding(session_id, &request.provider_id)
                .ok()
                .flatten()
                .and_then(|binding| provider_resume_cursor_from_binding(&binding))
                .is_some_and(|cursor| {
                    provider_retry_recovery::durable_native_cursor(request, Some(&cursor))
                });
            let mut recovery = previous.unwrap_or_else(|| {
                serde_json::json!({
                    "cycleId": current_attempt, "attemptsUsed": 0, "maxRetries": 3,
                })
            });
            let recovery_state =
                if error.contains(provider_retry_recovery::CONTINUATION_UNAVAILABLE) {
                    "continuation-unavailable"
                } else if error.contains(provider_retry_recovery::RETRY_EXHAUSTED)
                    || error.contains(provider_retry_recovery::CAPACITY_RETRY_EXHAUSTED)
                {
                    recovery["attemptsUsed"] = serde_json::json!(3);
                    "exhausted"
                } else {
                    "failed"
                };
            recovery["state"] = serde_json::json!(recovery_state);
            recovery["continuationAvailable"] = serde_json::json!(continuation);
            object.insert("recovery".into(), recovery);
            let (recovery_kind, recovery_message) = provider_failure_recovery(error);
            object.insert(
                "recoveryKind".into(),
                serde_json::Value::String(recovery_kind.into()),
            );
            object.insert(
                "recoveryMessage".into(),
                serde_json::Value::String(recovery_message.into()),
            );
        }
        object.insert(
            "turnId".into(),
            turn_id
                .map(|id| serde_json::Value::String(id.to_string()))
                .unwrap_or(serde_json::Value::Null),
        );
        object.insert(
            "chatMode".into(),
            serde_json::Value::String(
                if request.mode == ChatMode::Plan {
                    "plan"
                } else {
                    "normal"
                }
                .into(),
            ),
        );
        object.insert(
            "goal".into(),
            serde_json::to_value(
                request
                    .goal
                    .as_ref()
                    .map(|goal| serde_json::json!({"text": goal.text, "status": goal.status})),
            )
            .unwrap_or(serde_json::Value::Null),
        );
        object.insert(
            "plan".into(),
            request.plan.clone().unwrap_or(serde_json::Value::Null),
        );
        object.insert(
            "attachments".into(),
            serde_json::to_value(&request.attachments).unwrap_or_else(|_| serde_json::json!([])),
        );
    }
    store.append_event_with_turn_id(
        session_id,
        SessionEventKind::SystemEvent,
        provider_chat_status_message(&status, provider_label),
        payload,
        turn_id,
    )
}

pub(crate) fn provider_turn_has_unfinished_attempt(
    store: &SessionStore,
    session_id: Uuid,
    turn_id: Uuid,
) -> anyhow::Result<bool> {
    // Prefer the durable turn-status index so a long session cannot hide a
    // still-running attempt behind the recent-event read window.
    if let Some(status) = store.latest_provider_status_for_turn(session_id, turn_id)? {
        return Ok(matches!(status.as_str(), "running" | "waiting" | "queued"));
    }
    let last_status = store
        .read_recent_events(session_id, MAX_DESKTOP_SESSION_EVENTS_READ)?
        .into_iter()
        .filter(|event| {
            event.turn_id == Some(turn_id)
                && event
                    .payload
                    .get("kind")
                    .and_then(serde_json::Value::as_str)
                    == Some("provider-status")
        })
        .filter_map(|event| {
            event
                .payload
                .get("status")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .next_back();
    Ok(matches!(
        last_status.as_deref(),
        Some("running" | "waiting" | "queued")
    ))
}

pub(crate) fn provider_activity_event_entry(
    request: &ProviderChatRequest,
    turn_id: Uuid,
    timeline_sequence: u64,
    activity: &ProviderActivity,
) -> (String, serde_json::Value, Option<Uuid>) {
    // `detail` carries different material per kind — a shell command, a path, a
    // tool id — so a reader has to know the kind to know what it is holding.
    // Naming the field as well makes the contract explicit, and lets an adapter
    // that has both a path and a human note send them separately: `note` is the
    // second slot that carries the specifics of a named tool. The renderer
    // prefers these and falls back to `detail`, so older persisted events keep
    // rendering unchanged.
    let detail = activity.detail.as_deref();
    let named_detail = |wanted: &str| {
        if activity.kind == wanted {
            detail
        } else {
            None
        }
    };
    let payload = serde_json::json!({
        "kind": "provider-activity",
        "activityId": activity.id,
        "activityKind": activity.kind,
        "additions": activity.file_counts.map(|counts| counts.0),
        "deletions": activity.file_counts.map(|counts| counts.1),
        "label": activity.label,
        "detail": activity.detail,
        // Specifics behind a machine tool id (Bash command, skill name, path).
        "note": activity.note,
        "status": activity.status,
        "command": named_detail("command"),
        "path": named_detail("file").or_else(|| named_detail("read")),
        "tool": named_detail("tool"),
        "query": named_detail("search"),
        "providerId": request.provider_id,
        "modelId": request.model_id,
        "timelineSequence": timeline_sequence,
        "turnId": turn_id,
    });
    (activity.label.clone(), payload, Some(turn_id))
}

pub(crate) fn kimi_acp_plan_payload(activity: &ProviderActivity) -> Option<serde_json::Value> {
    if activity.kind != "plan" {
        return None;
    }
    let entries = serde_json::from_str::<serde_json::Value>(activity.detail.as_deref()?).ok()?;
    let items = entries
        .as_array()?
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let title = entry
                .get("title")
                .or_else(|| entry.get("content"))
                .or_else(|| entry.get("label"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("Plan step");
            let status = match entry
                .get("status")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("todo")
            {
                "completed" | "done" | "complete" => "complete",
                "in_progress" | "in-progress" | "running" => "in-progress",
                "blocked" => "blocked",
                _ => "todo",
            };
            serde_json::json!({
                "id": entry
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("kimi-plan-{index}")),
                "title": title,
                "status": status,
            })
        })
        .collect::<Vec<_>>();
    Some(serde_json::json!({
        "action": "replace",
        "title": "Plan",
        "providerId": "kimi",
        "items": items,
    }))
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn append_provider_diagnostics_event(
    store: &SessionStore,
    session_id: Uuid,
    request: &ProviderChatRequest,
    turn_id: Option<Uuid>,
    attempt_id: Uuid,
    status: HarnessRunStatus,
    started_at: chrono::DateTime<chrono::Utc>,
    retry_count: u32,
    resumed: bool,
    failure_reason: Option<&str>,
    output_summary: Option<&str>,
) -> anyhow::Result<SessionEvent> {
    let adapter = provider_adapter_for(&request.provider_id);
    let completed_at = chrono::Utc::now();
    let payload = ProviderDiagnosticsPayload::new(
        turn_id.unwrap_or_else(Uuid::new_v4),
        attempt_id,
        request.provider_id.clone(),
        request.model_id.clone(),
        status.clone(),
        started_at,
        completed_at,
        retry_count,
        resumed,
        Some(adapter.timeout_seconds),
        failure_reason.map(str::to_string),
        output_summary.map(str::to_string),
    );
    let mut payload = gyro_core::harness_payload_value(&payload)?;
    if let Some(object) = payload.as_object_mut() {
        object.insert(
            "reasoningEffort".into(),
            request
                .reasoning_effort
                .clone()
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null),
        );
    }
    store.append_event_with_turn_id(
        session_id,
        SessionEventKind::SystemEvent,
        provider_diagnostics_message(&status, request.provider_label.as_deref()),
        payload,
        turn_id,
    )
}

pub(crate) fn provider_chat_status_message(
    status: &HarnessRunStatus,
    provider_label: &str,
) -> String {
    match status {
        HarnessRunStatus::Failed => format!("{provider_label} send needs attention"),
        HarnessRunStatus::Blocked => format!("{provider_label} is not available for chat yet"),
        HarnessRunStatus::Done => format!("{provider_label} answered"),
        HarnessRunStatus::Running => format!("{provider_label} is working"),
        HarnessRunStatus::Waiting => format!("{provider_label} is waiting for approval"),
        HarnessRunStatus::Cancelled => format!("{provider_label} was cancelled"),
        HarnessRunStatus::Queued => format!("{provider_label} queued this request"),
    }
}

pub(crate) fn provider_diagnostics_message(
    status: &HarnessRunStatus,
    provider_label: Option<&str>,
) -> String {
    let provider_label = provider_label.unwrap_or("Provider");
    match status {
        HarnessRunStatus::Done => format!("{provider_label} diagnostics recorded"),
        HarnessRunStatus::Blocked => format!("{provider_label} blocked diagnostics recorded"),
        HarnessRunStatus::Failed => format!("{provider_label} failure diagnostics recorded"),
        _ => format!("{provider_label} queued this request"),
    }
}

pub(crate) fn emit_provider_chat_event(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    phase: &str,
    status: Option<HarnessRunStatus>,
    text_delta: Option<String>,
    message: Option<String>,
    error: Option<String>,
) {
    emit_provider_chat_event_with_timeline(
        app, request, phase, status, text_delta, message, error, None,
    );
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn emit_provider_chat_event_with_timeline(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    phase: &str,
    status: Option<HarnessRunStatus>,
    text_delta: Option<String>,
    message: Option<String>,
    error: Option<String>,
    timeline: Option<provider_timeline::TimelinePosition>,
) {
    emit_provider_chat_frame(
        app, request, phase, status, text_delta, message, error, timeline, None,
    );
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn emit_provider_chat_frame(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    phase: &str,
    status: Option<HarnessRunStatus>,
    text_delta: Option<String>,
    message: Option<String>,
    error: Option<String>,
    timeline: Option<provider_timeline::TimelinePosition>,
    quiet_seconds: Option<u64>,
) {
    if context_compaction::summary_stream_muted(&request.session_id) {
        return;
    }
    session_title_stream::observe(app, request, phase, text_delta.as_deref());
    if phase == "delta" && text_delta.as_ref().is_some_and(|text| !text.is_empty()) {
        timing::mark(TimingStage::FirstActivity);
        timing::mark(TimingStage::FirstToken);
        gyro_core::provider_observation::native_delta(text_delta.as_deref().unwrap_or_default());
    }
    let payload = ProviderChatStreamEvent {
        session_id: request.session_id.clone(),
        turn_id: request.turn_id.clone(),
        provider_id: request.provider_id.clone(),
        model_id: request.model_id.clone(),
        event_id: Uuid::new_v4().to_string(),
        sequence: next_provider_event_sequence(app, &request.session_id),
        timeline: timeline.unwrap_or_else(|| {
            provider_timeline::observe(
                app,
                &request.session_id,
                None,
                text_delta.as_deref().filter(|_| phase == "delta"),
            )
        }),
        timeline_segments: None,
        activity_sequence: None,
        phase: phase.into(),
        status: status.map(|status| status.as_str().to_string()),
        text_delta,
        activity_id: None,
        activity_kind: None,
        activity_label: None,
        activity_detail: None,
        activity_note: None,
        additions: None,
        deletions: None,
        activity_status: None,
        recovery_kind: error
            .as_deref()
            .map(|error| provider_failure_recovery(error).0.to_string()),
        message,
        error,
        quiet_seconds,
    };
    let _ = app.emit(PROVIDER_CHAT_EVENT, payload);
}

pub(crate) fn emit_provider_context_usage(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    usage: &ProviderContextUsage,
) {
    if context_compaction::summary_stream_muted(&request.session_id) {
        return;
    }
    // All adapters reach this boundary, including Codex app-server and ACP.
    // The shared poll coalesces context frames and respects account cooldowns.
    publish_live_provider_usage(app, &request.provider_id);
    let context_window_source = if usage.model_context_window.is_some() {
        "runtime"
    } else {
        "catalog"
    };
    // This runs on every usage frame, and reading the config touches the disk.
    // Most frames report no window, and those have nothing to record.
    if usage.model_context_window.is_some() && request.model_id.is_some() {
        let base_url = load_config_blocking().ok().and_then(|config| {
            config
                .model_providers
                .into_iter()
                .find(|provider| provider.id == request.provider_id)
                .and_then(|provider| provider.base_url)
        });
        live_model_context::observe_runtime(
            &request.provider_id,
            request.model_id.as_deref(),
            base_url.as_deref(),
            usage.model_context_window,
        );
    }
    let usage = provider_context_usage_with_window(
        Some(usage.clone()),
        &request.provider_id,
        request.model_id.as_deref(),
    );
    let _ = app.emit(
        PROVIDER_CHAT_EVENT,
        serde_json::json!({
            "sessionId": request.session_id,
            "turnId": request.turn_id,
            "providerId": request.provider_id,
            "modelId": request.model_id,
            "eventId": Uuid::new_v4().to_string(),
            "sequence": next_provider_event_sequence(app, &request.session_id),
            "phase": "context-usage",
            "contextUsage": usage,
            "contextWindowSource": context_window_source,
        }),
    );
}

pub(crate) fn emit_provider_activity_event(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    activity: &ProviderActivity,
    activity_sequence: Option<u64>,
) {
    if context_compaction::summary_stream_muted(&request.session_id) {
        return;
    }
    timing::mark(TimingStage::FirstActivity);
    if !matches!(activity.kind.as_str(), "commentary" | "reasoning") {
        timing::tool(&activity.id, &activity.status);
    }
    let (timeline, timeline_segments) =
        provider_timeline::activity(app, &request.session_id, activity);
    let payload = ProviderChatStreamEvent {
        session_id: request.session_id.clone(),
        turn_id: request.turn_id.clone(),
        provider_id: request.provider_id.clone(),
        model_id: request.model_id.clone(),
        event_id: Uuid::new_v4().to_string(),
        sequence: next_provider_event_sequence(app, &request.session_id),
        timeline,
        timeline_segments,
        activity_sequence,
        phase: "activity".into(),
        status: Some(HarnessRunStatus::Running.as_str().to_string()),
        text_delta: None,
        activity_id: Some(activity.id.clone()),
        activity_kind: Some(activity.kind.clone()),
        activity_label: Some(activity.label.clone()),
        activity_detail: activity.detail.clone(),
        activity_note: activity.note.clone(),
        additions: activity.file_counts.map(|counts| counts.0),
        deletions: activity.file_counts.map(|counts| counts.1),
        activity_status: Some(activity.status.clone()),
        message: None,
        error: None,
        recovery_kind: None,
        quiet_seconds: None,
    };
    let _ = app.emit(PROVIDER_CHAT_EVENT, payload);
}

/// Monotonic sequence for provider stream events on a session.
///
/// Prefer the active run control so sequences reset cleanly per turn. If the
/// control is briefly unavailable (lock poison, race on tear-down), fall back to
/// a process-wide counter rather than returning `0` for every frame — a stream
/// of zeros made the desktop drop every event after the first and the rail
/// looked finished while the backend was still emitting.
pub(crate) fn next_provider_event_sequence(app: &tauri::AppHandle, session_id: &str) -> u64 {
    static ORPHAN_PROVIDER_EVENT_SEQUENCE: AtomicU64 = AtomicU64::new(1 << 48);
    app.state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .and_then(|flags| flags.get(session_id).cloned())
        .map(|control| control.next_event_sequence.fetch_add(1, Ordering::Relaxed))
        .unwrap_or_else(|| ORPHAN_PROVIDER_EVENT_SEQUENCE.fetch_add(1, Ordering::Relaxed))
}

/// The sequence the run's next frame would take, without taking it. `None` once
/// the run control is gone, when there is no run left to be quiet.
pub(crate) fn peek_provider_event_sequence(
    app: &tauri::AppHandle,
    session_id: &str,
) -> Option<u64> {
    app.state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .and_then(|flags| flags.get(session_id).cloned())
        .map(|control| control.next_event_sequence.load(Ordering::Relaxed))
}
