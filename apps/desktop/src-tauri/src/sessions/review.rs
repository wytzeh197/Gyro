use crate::stores::{open_store, parse_uuid, to_string};
use gyro_core::{FileReviewDecision, SessionEvent, SessionEventKind, FILE_REVIEW_SCHEMA};
use serde::Deserialize;
/// What the user did with one file on the review card.
///
/// Keeping is a reading record, not an apply step: the change is already on
/// disk, and a file nobody marks is unread rather than rejected or pending.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileReviewDecisionRequest {
    pub(crate) session_id: String,
    pub(crate) turn_id: String,
    pub(crate) path: String,
    pub(crate) content_hash: String,
    pub(crate) decision: FileReviewDecision,
}

#[tauri::command]
pub(crate) async fn record_file_review_decision(
    request: FileReviewDecisionRequest,
) -> Result<SessionEvent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = open_store()?;
        let session_id = parse_uuid(&request.session_id)?;
        let turn_id = parse_uuid(&request.turn_id)?;
        store
            .append_event_with_turn_id(
                session_id,
                SessionEventKind::SystemEvent,
                format!("Kept {}", request.path),
                serde_json::json!({
                    "schema": FILE_REVIEW_SCHEMA,
                    "kind": "file-review",
                    "path": request.path,
                    "contentHash": request.content_hash,
                    "decision": request.decision.as_str(),
                }),
                Some(turn_id),
            )
            .map_err(to_string)
    })
    .await
    .map_err(|error| format!("file review worker failed: {error}"))?
}
