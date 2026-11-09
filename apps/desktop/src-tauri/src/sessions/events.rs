use crate::{
    goal_runner, session_goal,
    state::provider_run::{stop_provider_run, ProviderStopReason},
    stores::{open_store, parse_uuid, to_string},
};
use gyro_core::{SessionEvent, SessionEventKind};
#[tauri::command]
pub(crate) async fn append_plan_event(
    session_id: String,
    message: Option<String>,
    payload: serde_json::Value,
) -> Result<SessionEvent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        append_plan_event_blocking(session_id, message, payload)
    })
    .await
    .map_err(|error| format!("plan event worker failed: {error}"))?
}

pub(crate) fn append_plan_event_blocking(
    session_id: String,
    message: Option<String>,
    payload: serde_json::Value,
) -> Result<SessionEvent, String> {
    let store = open_store()?;
    let session_id = parse_uuid(&session_id)?;
    let turn_id = payload
        .get("turnId")
        .and_then(|value| value.as_str())
        .map(parse_uuid)
        .transpose()?;
    let message = message.unwrap_or_else(|| {
        let action = payload
            .get("action")
            .and_then(|value| value.as_str())
            .unwrap_or("updated")
            .replace('-', " ");
        format!("Plan {action}")
    });
    store
        .append_event_with_turn_id(
            session_id,
            SessionEventKind::PlanUpdated,
            message,
            payload,
            turn_id,
        )
        .map_err(to_string)
}

#[tauri::command]
pub(crate) async fn append_chat_context_event(
    app: tauri::AppHandle,
    session_id: String,
    event_kind: String,
    message: String,
    payload: serde_json::Value,
) -> Result<SessionEvent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = open_store()?;
        let session_id = parse_uuid(&session_id)?;
        let (kind, message, payload) = match event_kind.as_str() {
            "goal-updated" => {
                if payload.get("action").and_then(serde_json::Value::as_str) == Some("pause") {
                    stop_provider_run(&app, &session_id.to_string(), ProviderStopReason::User);
                    return goal_runner::pause(&store, session_id);
                }
                let current = session_goal::stored_session_goal(
                    &store.read_context_events(session_id).map_err(to_string)?,
                );
                let (message, payload) = session_goal::goal_change(&payload, current.as_ref())?;
                (SessionEventKind::GoalUpdated, message, payload)
            }
            "chat-mode-changed" => (SessionEventKind::ChatModeChanged, message, payload),
            _ => return Err("unsupported chat context event kind".into()),
        };
        store
            .append_event(session_id, kind, message, payload)
            .map_err(to_string)
    })
    .await
    .map_err(|error| format!("chat context event worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn append_editor_event(
    session_id: String,
    event_kind: String,
    message: String,
    payload: serde_json::Value,
) -> Result<SessionEvent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        append_editor_event_blocking(session_id, event_kind, message, payload)
    })
    .await
    .map_err(|error| format!("editor event worker failed: {error}"))?
}

pub(crate) fn append_editor_event_blocking(
    session_id: String,
    event_kind: String,
    message: String,
    payload: serde_json::Value,
) -> Result<SessionEvent, String> {
    let store = open_store()?;
    let session_id = parse_uuid(&session_id)?;
    let kind = match event_kind.as_str() {
        "ai-edit-proposed" => SessionEventKind::FileEditProposed,
        _ => SessionEventKind::SystemEvent,
    };
    store
        .append_event(
            session_id,
            kind,
            message,
            serde_json::json!({
                "kind": event_kind,
                "surface": "desktop-ide",
                "data": payload,
            }),
        )
        .map_err(to_string)
}
