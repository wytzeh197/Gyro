use super::{capture, notify, start};
use crate::{
    features::scope::root_scope,
    providers::session_lifecycle::ProviderSessionLease,
    state::provider_run::{stop_provider_run, ProviderStopReason},
    stores::open_store,
};
use anyhow::{ensure, Result};
use gyro_core::{workflows::*, SessionStore};
use serde_json::{json, Value};
use uuid::Uuid;
pub(super) fn summary(draft: &WorkflowDraft) -> Value {
    json!({"id":draft.id,"revision":draft.revision,"sourceSessionId":draft.source_session_id,"rootId":draft.root_id,"sourceTurnIds":draft.source_turn_ids,"sourceComplete":draft.source_complete,"captureHash":draft.capture_hash,"capturedBytes":draft.input.len(),"status":draft.status,"extractionSessionId":draft.extraction_session_id,"providerId":draft.provider_id,"modelId":draft.model_id,"definition":draft.definition,"error":draft.error,"createdAt":draft.created_at})
}
#[tauri::command]
pub(crate) async fn workflow_extraction_request(
    app: tauri::AppHandle,
    session_id: Option<String>,
    root_id: Option<String>,
    action: String,
    payload: Option<Value>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        request(
            &app,
            session_id.as_deref(),
            root_id.as_deref(),
            &action,
            payload.unwrap_or_else(|| json!({})),
        )
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}
fn request(
    app: &tauri::AppHandle,
    session_id: Option<&str>,
    root_id: Option<&str>,
    action: &str,
    payload: Value,
) -> Result<Value> {
    ensure!(
        serde_json::to_vec(&payload)?.len() <= 8192,
        "extraction request exceeds its limit"
    );
    let store = open_store().map_err(anyhow::Error::msg)?;
    if action == "list" {
        return Ok(json!(store
            .workflow_drafts(session_id.map(Uuid::parse_str).transpose()?)?
            .iter()
            .map(summary)
            .collect::<Vec<_>>()));
    }
    if matches!(action, "turns" | "capture") {
        let (session, root_id, root) = root_scope(
            &store,
            session_id.ok_or_else(|| anyhow::anyhow!("Choose a source chat"))?,
            root_id,
        )?;
        ensure!(
            store.advisory_session_purpose(session.id)?.is_none(),
            "advisory calls are not source chats for workflow extraction"
        );
        if action == "turns" {
            return capture::turns(&store, session.id);
        }
        let turns: Vec<Uuid> = serde_json::from_value(payload["turnIds"].clone())?;
        let (input, complete) = capture::input(
            &store,
            session.id,
            &turns,
            payload["brief"].as_str().unwrap_or_default(),
        )?;
        let draft = store.create_workflow_draft(
            session.id,
            &root_id,
            &root.to_string_lossy(),
            turns,
            complete,
            input,
        )?;
        notify(app, &draft);
        return Ok(summary(&draft));
    }
    let id: Uuid = serde_json::from_value(payload["draftId"].clone())?;
    let mut draft = store
        .workflow_draft(id)?
        .ok_or_else(|| anyhow::anyhow!("workflow draft is unavailable"))?;
    if let Some(session) = session_id {
        ensure!(
            draft.source_session_id == Uuid::parse_str(session)?,
            "draft belongs to another source chat"
        );
    }
    match action {
        "get" => Ok(summary(&draft)),
        "input" => Ok(json!({"input":draft.input})),
        "output" => Ok(json!({"output":read_draft_output(store.paths(),id)?})),
        "start" => {
            let (_, _, root) = root_scope(
                &store,
                &draft.source_session_id.to_string(),
                Some(&draft.root_id),
            )?;
            ensure!(
                root.to_string_lossy() == draft.root_key,
                "source root changed"
            );
            ensure!(
                draft.source_complete || payload["allowUnproven"].as_bool() == Some(true),
                "Source task is unfinished; explicitly acknowledge that this is an unproven draft"
            );
            let provider = payload["providerId"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Choose an extraction provider"))?;
            let model = payload["modelId"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Choose an extraction model"))?;
            crate::features::code_reviews::execution::validate_reviewer(
                &gyro_core::GyroConfig::load(store.paths())?,
                provider,
                model,
            )?;
            draft = store.queue_workflow_extraction(
                id,
                payload["revision"]
                    .as_u64()
                    .ok_or_else(|| anyhow::anyhow!("draft revision is required"))?,
                payload["captureHash"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("capture hash is required"))?,
                provider,
                model,
            )?;
            notify(app, &draft);
            if draft.status == WorkflowDraftStatus::Queued {
                start(app.clone(), id);
            }
            Ok(summary(&draft))
        }
        "stop" => {
            for _ in 0..3 {
                if !draft.status.active() {
                    break;
                }
                if let Some(session) = draft.extraction_session_id {
                    stop_provider_run(app, &session.to_string(), ProviderStopReason::User);
                }
                match store.stop_workflow_extraction(
                    id,
                    draft.revision,
                    WorkflowDraftStatus::Cancelled,
                    "Stopped by you",
                ) {
                    Ok(next) => {
                        draft = next;
                        break;
                    }
                    Err(_) => {
                        draft = store
                            .workflow_draft(id)?
                            .ok_or_else(|| anyhow::anyhow!("workflow draft is unavailable"))?
                    }
                }
            }
            ensure!(
                !draft.status.active(),
                "extraction changed while stopping; refresh and retry"
            );
            notify(app, &draft);
            Ok(summary(&draft))
        }
        "delete" => {
            ensure!(
                !draft.status.active(),
                "Stop extraction before deleting its draft"
            );
            ensure!(
                ProviderSessionLease::try_acquire(store.paths(), id)?.is_some(),
                "Extraction is still stopping; retry shortly"
            );
            store.delete_workflow_draft(
                id,
                payload["revision"]
                    .as_u64()
                    .ok_or_else(|| anyhow::anyhow!("draft revision is required"))?,
            )?;
            notify(app, &draft);
            Ok(json!({"deleted":true}))
        }
        _ => anyhow::bail!("unknown extraction action"),
    }
}
pub(crate) fn stop_for_source(
    app: &tauri::AppHandle,
    store: &SessionStore,
    source: Uuid,
) -> Result<()> {
    for draft in store.workflow_drafts(Some(source))? {
        if draft.status.active() {
            if let Some(session) = draft.extraction_session_id {
                stop_provider_run(app, &session.to_string(), ProviderStopReason::User);
            }
            let current = store.stop_workflow_extraction(
                draft.id,
                draft.revision,
                WorkflowDraftStatus::Cancelled,
                "Source chat deleted by you",
            )?;
            notify(app, &current);
        }
        ensure!(
            ProviderSessionLease::try_acquire(store.paths(), draft.id)?.is_some(),
            "Extraction is stopping; retry deleting the source chat shortly"
        );
    }
    Ok(())
}
