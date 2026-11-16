//! Preserve user-visible output when a provider fails or the user stops it.
//!
//! A commentary event does not claim completion, consume the final-message
//! deduplication slot, or enter model conversation history on the next send.

use crate::{
    provider_timeline::PartialResponse, providers::chat_types::ProviderChatRequest,
    state::managers::ProviderCancellationManager, stores::open_store,
};
use gyro_core::{SessionEvent, SessionEventKind, SessionStore};
use tauri::Manager;
use uuid::Uuid;

pub(crate) fn preserve(app: &tauri::AppHandle, request: &ProviderChatRequest, status: &str) {
    if request.internal_purpose.is_some() || !matches!(status, "failed" | "cancelled") {
        return;
    }
    let control = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .and_then(|flags| flags.get(&request.session_id).cloned());
    let Some(control) = control else { return };
    let partial = control
        .timeline
        .lock()
        .ok()
        .and_then(|mut timeline| timeline.take_partial_response());
    let Some(partial) = partial else { return };
    // No run registry or timeline lock is held during database/file I/O.
    let result = open_store()
        .map_err(anyhow::Error::msg)
        .and_then(|store| persist(&store, request, status, partial));
    if let Err(error) = result {
        if let Ok(mut timeline) = control.timeline.lock() {
            timeline.retry_partial_response();
        }
        // A failed recovery write must not suppress the original terminal frame.
        eprintln!(
            "could not preserve interrupted provider output: {}",
            gyro_core::security::redact_secrets(&error.to_string())
        );
    }
}

fn persist(
    store: &SessionStore,
    request: &ProviderChatRequest,
    status: &str,
    partial: PartialResponse,
) -> anyhow::Result<SessionEvent> {
    let session = Uuid::parse_str(&request.session_id)?;
    let turn = request
        .turn_id
        .as_deref()
        .map(Uuid::parse_str)
        .transpose()?;
    let mut payload = serde_json::json!({
        "kind": "provider-activity",
        "activityKind": "commentary",
        "activityId": format!("partial-response:{}", Uuid::new_v4()),
        "partialResponse": true,
        "status": status,
        "providerId": request.provider_id,
        "modelId": request.model_id,
        "turnId": turn,
    });
    partial.position.insert_into(&mut payload);
    if let Some(segments) = partial.segments {
        payload["timelineSegments"] = segments;
    }
    store.append_event_with_turn_id(
        session,
        SessionEventKind::SystemEvent,
        partial.message,
        payload,
        turn,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider_timeline::TimelinePosition;
    use gyro_core::{GyroPaths, SessionOrigin};

    fn partial(message: &str) -> PartialResponse {
        PartialResponse {
            message: format!("Partial response (interrupted):\n\n{message}"),
            position: TimelinePosition {
                timeline_order: 3,
                timeline_created_at: chrono::Utc::now().to_rfc3339(),
            },
            segments: None,
        }
    }

    #[test]
    fn interrupted_output_survives_reopen_without_claiming_the_retry_response() {
        for status in ["failed", "cancelled"] {
            let temp = tempfile::tempdir().unwrap();
            let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
            let store = SessionStore::open(paths.clone()).unwrap();
            let session = store
                .create_session(temp.path(), SessionOrigin::Desktop, "Recovery")
                .unwrap();
            let turn = Uuid::new_v4();
            let request: ProviderChatRequest = serde_json::from_value(serde_json::json!({
                "sessionId": session.id, "turnId": turn,
                "providerId": "openai", "message": "Explain this file",
            }))
            .unwrap();
            store
                .append_user_turn_message_with_turn_id(
                    session.id,
                    "Explain this file",
                    serde_json::json!({}),
                    turn,
                )
                .unwrap();
            store
                .append_event_with_turn_id(
                    session.id,
                    SessionEventKind::SystemEvent,
                    status,
                    serde_json::json!({"kind":"provider-status", "status":status}),
                    Some(turn),
                )
                .unwrap();
            persist(
                &store,
                &request,
                status,
                partial("The first part of the answer."),
            )
            .unwrap();
            assert_eq!(
                store
                    .latest_provider_status_for_turn(session.id, turn)
                    .unwrap()
                    .as_deref(),
                Some(status)
            );
            drop(store);

            let store = SessionStore::open(paths).unwrap();
            let recovered = store.read_events(session.id).unwrap();
            let partial = recovered
                .iter()
                .find(|event| event.payload["partialResponse"] == true)
                .unwrap();
            assert_eq!(partial.kind, SessionEventKind::SystemEvent);
            assert_eq!(partial.payload["status"], status);
            assert!(partial.message.contains("Partial response (interrupted)"));
            assert!(partial.message.ends_with("The first part of the answer."));
            assert!(store.read_context_events(session.id).unwrap().is_empty());

            store
                .append_event_with_turn_id(
                    session.id,
                    SessionEventKind::AssistantMessage,
                    "The completed answer.",
                    serde_json::json!({"kind":"provider-response"}),
                    Some(turn),
                )
                .unwrap();
            let events = store.read_events(session.id).unwrap();
            assert_eq!(
                events
                    .iter()
                    .filter(|event| event.kind == SessionEventKind::AssistantMessage)
                    .count(),
                1
            );
            assert_eq!(
                events
                    .iter()
                    .filter(|event| event.payload["partialResponse"] == true)
                    .count(),
                1
            );
            assert_eq!(
                store
                    .latest_provider_status_for_turn(session.id, turn)
                    .unwrap()
                    .as_deref(),
                Some(status)
            );
        }
    }
}
