//! Local definition editing. Saving never starts extraction, a model or a job.
use super::scope::root_scope;
use crate::{
    state::managers::CapabilityIdeEvidenceManager,
    stores::open_store,
    workspace::{
        paths::create_workspace_path_impl,
        types::{FileMutationProposalRequest, WorkspacePathCreateRequest},
    },
    workspace_mutations,
};
use anyhow::{ensure, Result};
use gyro_core::{
    project_memory::confined_bytes,
    workflows::{parse_definition, plan_definition_write, read_definitions, MAX_DEFINITION_BYTES},
    CapabilityAccess, CapabilityClass, MutationProposalStatus,
};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

#[tauri::command]
pub(crate) async fn workflow_definition_request(
    app: tauri::AppHandle,
    session_id: String,
    root_id: Option<String>,
    action: String,
    payload: Option<Value>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        request(
            &app,
            &session_id,
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
    session_id: &str,
    root_id: Option<&str>,
    action: &str,
    payload: Value,
) -> Result<Value> {
    ensure!(
        serde_json::to_vec(&payload)?.len() <= MAX_DEFINITION_BYTES + 8192,
        "workflow request exceeds its limit"
    );
    let store = open_store().map_err(anyhow::Error::msg)?;
    let (session, root_id, root) = root_scope(&store, session_id, root_id)?;
    let workspace = root.to_string_lossy();
    let private = store.paths().base_dir.canonicalize()?;
    match action {
        "list" => Ok(
            json!({"rootId":root_id,"roots":session.workspace_identity.roots,"definitions":read_definitions(&root,&private)?}),
        ),
        "read" => {
            let path = payload["path"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Choose a workflow"))?;
            let listing = read_definitions(&root, &private)?;
            ensure!(
                listing.iter().any(|item| item.path == path),
                "workflow is outside the selected library"
            );
            let bytes = confined_bytes(&root, path, MAX_DEFINITION_BYTES)?
                .ok_or_else(|| anyhow::anyhow!("workflow is unavailable"))?;
            let definition = parse_definition(&bytes)?;
            ensure!(
                path == format!(".gyro/workflows/{}.json", definition.id),
                "workflow ID no longer matches this filename"
            );
            Ok(
                json!({"definition":definition,"content":String::from_utf8(bytes.clone())?,"expectedHash":gyro_core::mutations::content_hash(&bytes)}),
            )
        }
        "validate" => {
            let definition = parse_definition(&serde_json::to_vec(&payload["definition"])?)?;
            Ok(
                json!({"definition":definition,"hash":gyro_core::workflows::definition_hash(&definition)?}),
            )
        }
        "save" => {
            let definition = parse_definition(&serde_json::to_vec(&payload["definition"])?)?;
            let path = format!(".gyro/workflows/{}.json", definition.id);
            ensure!(
                payload.get("expectedHash").is_some(),
                "expectedHash is required, including null for a new definition"
            );
            let expected: Option<String> = serde_json::from_value(payload["expectedHash"].clone())?;
            let current = confined_bytes(&root, &path, MAX_DEFINITION_BYTES)?;
            let plan = plan_definition_write(current.as_deref(), expected.as_deref(), &definition)?;
            let policy = store
                .get_project_capability_policy(&workspace)?
                .with_missing_classes_defaulted();
            ensure!(
                policy.access_for(CapabilityClass::WorkspaceWrite) != CapabilityAccess::Deny,
                "project policy denies workflow changes"
            );
            let evidence = app.state::<CapabilityIdeEvidenceManager>();
            let guard = evidence
                .evidence
                .lock()
                .map_err(|_| anyhow::anyhow!("editor evidence is unavailable"))?;
            let dirty = guard.get(&workspace).is_some_and(|snapshot| {
                snapshot.buffers.iter().any(|buffer| {
                    buffer["path"].as_str() == Some(&path)
                        && buffer["dirty"].as_bool() == Some(true)
                })
            });
            drop(guard);
            ensure!(
                !dirty,
                "Workflow has unsaved editor changes; save or revert them first"
            );
            for directory in [".gyro", ".gyro/workflows"] {
                if !root.join(directory).is_dir() {
                    create_workspace_path_impl(&WorkspacePathCreateRequest {
                        workspace_path: workspace.to_string(),
                        path: directory.into(),
                        kind: "directory".into(),
                    })?;
                }
            }
            let (_, _, current_root) = root_scope(&store, session_id, Some(&root_id))?;
            ensure!(current_root == root, "workspace changed; reload");
            let proposal =
                workspace_mutations::create_file_mutation_proposal_from_snapshot_at_root(
                    &store,
                    FileMutationProposalRequest {
                        session_id: session_id.into(),
                        turn_id: None,
                        path: plan.path,
                        content: plan.content,
                        expected_hash: plan.expected_hash,
                    },
                    true,
                    Some(&root_id),
                )?;
            ensure!(
                proposal.status == MutationProposalStatus::Applied,
                "workflow save was not applied"
            );
            let _ = app.emit(
                "gyro://workflow-definitions-changed",
                json!({"sessionId":session_id,"rootId":root_id}),
            );
            Ok(json!({"status":"saved","hash":gyro_core::workflows::definition_hash(&definition)?}))
        }
        _ => anyhow::bail!("unknown workflow definition action"),
    }
}
