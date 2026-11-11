use anyhow::Result;
use gyro_core::{
    project_memory::{candidate_worthy_request, parse_memory_candidates},
    Session, SessionEvent, SessionStore,
};
use serde_json::json;
use tauri::Emitter;
use uuid::Uuid;

pub(crate) fn capture(
    app: &tauri::AppHandle,
    store: &SessionStore,
    session: &Session,
    request: &gyro_core::provider_runtime::types::ProviderChatRequest,
    turn: Uuid,
    event: &SessionEvent,
    response: &str,
) -> Result<()> {
    if request.internal_purpose.is_some() || !candidate_worthy_request(&request.message) {
        return Ok(());
    }
    let Some(root) = session
        .workspace_identity
        .root(&session.workspace_identity.active_root_id)
    else {
        return Ok(());
    };
    let root = root.canonicalize()?;
    if root.starts_with(&store.paths().base_dir.canonicalize()?) {
        return Ok(());
    }
    let settings = store.project_memory_settings(&root.to_string_lossy())?;
    if !settings.enabled || !settings.suggestions {
        return Ok(());
    }
    let candidates = parse_memory_candidates(response, &request.message)?;
    for (draft, quote) in candidates {
        store.add_project_memory_candidate(
            &root.to_string_lossy(),
            session.id,
            turn,
            event.id,
            &draft,
            &quote,
        )?;
    }
    let _ = app.emit(
        "gyro://project-memory-changed",
        json!({"rootId":session.workspace_identity.active_root_id}),
    );
    Ok(())
}
