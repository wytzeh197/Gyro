use super::*;

#[tauri::command]
pub(super) async fn set_session_model(
    session_id: String,
    provider_id: Option<String>,
    provider_label: Option<String>,
    model_id: Option<String>,
    model_label: Option<String>,
    reasoning_effort: Option<String>,
) -> Result<Session, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = open_store()?;
        let session_id = parse_uuid(&session_id)?;
        let previous = store
            .get_session(session_id)
            .map_err(to_string)?
            .ok_or_else(|| "session not found".to_string())?;
        let updated = store
            .update_session_model(
                session_id,
                provider_id,
                provider_label,
                model_id,
                model_label,
                reasoning_effort,
            )
            .map_err(to_string)?
            .ok_or_else(|| "session not found".to_string())?;
        if previous.provider_id != updated.provider_id || previous.model_id != updated.model_id {
            let label = updated
                .model_label
                .as_deref()
                .or(updated.model_id.as_deref())
                .or(updated.provider_label.as_deref());
            let message = match label {
                Some(label) if previous.provider_id.is_some() || previous.model_id.is_some() => {
                    format!("Switched to {label}")
                }
                Some(label) => format!("Model set to {label}"),
                None => "Model selection cleared".to_string(),
            };
            store
                .append_event(
                    session_id,
                    SessionEventKind::SystemEvent,
                    message,
                    serde_json::json!({
                        "kind": "model-switch",
                        "previousProviderId": previous.provider_id,
                        "previousModelId": previous.model_id,
                        "providerId": updated.provider_id,
                        "providerLabel": updated.provider_label,
                        "modelId": updated.model_id,
                        "modelLabel": updated.model_label,
                    }),
                )
                .map_err(to_string)?;
        }
        Ok(updated)
    })
    .await
    .map_err(|error| format!("session model worker failed: {error}"))?
}
