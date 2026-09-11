use super::*;

// Keep the scope on the blocking worker: it must not leak across async tasks.
pub(super) fn run_timed_provider_chat(
    app: tauri::AppHandle,
    request: ProviderChatRequest,
    origin: UsageOrigin,
) -> Result<ProviderChatResponse, String> {
    if !timing::enabled() {
        return run_provider_chat_blocking(app, request, origin);
    }
    let session_id = parse_uuid(&request.session_id)?;
    // Legacy callers without a turn ID cannot be correlated with UI events.
    let scope = request
        .turn_id
        .as_deref()
        .map(parse_uuid)
        .transpose()?
        .map(|turn_id| timing::Scope::start(session_id, turn_id));
    let result = run_provider_chat_blocking(app, request, origin);
    if let Some(scope) = &scope {
        scope.finish(match &result {
            Ok(_) => timing::Outcome::Completed,
            Err(error) if is_provider_cancellation(error) => timing::Outcome::Cancelled,
            Err(_) => timing::Outcome::Failed,
        });
    }
    result
}

#[tauri::command]
pub(super) fn timing_diagnostics_enabled() -> bool {
    timing::enabled()
}

#[tauri::command]
pub(super) fn record_frontend_timing(value: timing::FrontendTiming) -> Result<(), String> {
    if !value.valid() {
        return Err("invalid timing measurement".into());
    }
    timing::record_frontend(&value).map_err(|_| "could not save local timing measurement".into())
}

pub(super) fn protocol_item(item: &serde_json::Value, status: &str) {
    let status = if status == "done"
        && (item.get("error").is_some_and(|value| !value.is_null())
            || item.get("status").and_then(serde_json::Value::as_str) == Some("failed")
            || item
                .get("exitCode")
                .and_then(serde_json::Value::as_i64)
                .is_some_and(|code| code != 0))
    {
        "failed"
    } else {
        status
    };
    if let (Some(id), Some(kind)) = (
        item.get("id").and_then(serde_json::Value::as_str),
        item.get("type").and_then(serde_json::Value::as_str),
    ) {
        timing::protocol_item(id, kind, status);
    }
}
