use crate::features::scope::root_scope;
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
    project_memory::{
        plan_write, read_project_memory, MemoryDocument, MemoryDraft, MemorySettings, MemorySource,
        MemoryWrite, MEMORY_PATH,
    },
    CapabilityAccess, CapabilityClass,
};
use serde_json::{json, Value};

use tauri::{Emitter, Manager};

#[tauri::command]
pub(crate) async fn project_memory_request(
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
        serde_json::to_vec(&payload)?.len() <= 16 * 1024,
        "memory request is too large"
    );
    let store = open_store().map_err(anyhow::Error::msg)?;
    let (session, root_id, root) = root_scope(&store, session_id, root_id)?;
    let workspace_key = root.to_string_lossy();
    match action {
        "list" => {
            let source = read_project_memory(&root)?;
            let document = MemoryDocument::parse(source.as_deref().unwrap_or_default())?;
            let query = payload["query"].as_str().unwrap_or_default().to_lowercase();
            ensure!(query.len() <= 512, "memory search is too long");
            let offset = payload["offset"].as_u64().unwrap_or(0).min(100_000) as usize;
            let filtered: Vec<_> = document
                .entries
                .iter()
                .filter(|entry| query.is_empty() || entry.text.to_lowercase().contains(&query))
                .collect();
            let entries:Vec<_>=filtered.iter().skip(offset).take(100).map(|entry|json!({"id":entry.id,"text":entry.text,"date":entry.date,"entryHash":entry.entry_hash,"kind":entry.metadata.as_ref().map(|meta|meta.kind).unwrap_or_default(),"status":entry.status,"sourceChanged":entry.source_changed,"paths":entry.metadata.as_ref().map(|meta|meta.paths.as_slice()).unwrap_or_default(),"sources":entry.metadata.as_ref().map(|meta|meta.sources.as_slice()).unwrap_or_default(),"supersedes":entry.metadata.as_ref().and_then(|meta|meta.supersedes.as_ref())})).collect();
            let next = offset + entries.len();
            Ok(
                json!({"rootId":root_id,"roots":session.workspace_identity.roots,"documentHash":source.as_ref().map(|_|&document.document_hash),"entries":entries,"total":filtered.len(),"nextOffset":(next<filtered.len()).then_some(next),"diagnostics":document.diagnostics,"settings":store.project_memory_settings(&workspace_key)?}),
            )
        }
        "settings" => {
            let settings: MemorySettings = serde_json::from_value(payload)?;
            store.set_project_memory_settings(&workspace_key, &settings)?;
            let _ = app.emit("gyro://project-memory-changed", json!({"rootId":root_id}));
            Ok(json!(settings))
        }
        "receipts" => Ok(json!(store.project_memory_receipts(session.id)?)),
        "candidates" => Ok(json!(store.project_memory_candidates(&workspace_key)?)),
        "dismiss" => {
            let id = payload["candidateId"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("suggestion ID is required"))?;
            let revision = payload["revision"]
                .as_u64()
                .ok_or_else(|| anyhow::anyhow!("suggestion revision is required"))?;
            store.decide_project_memory_candidate(&workspace_key, id, revision, "dismissed")?;
            let _ = app.emit("gyro://project-memory-changed", json!({"rootId":root_id}));
            Ok(json!({"status":"dismissed"}))
        }
        "save" | "forget" | "accept" => {
            ensure!(
                payload.get("expectedHash").is_some(),
                "expectedHash is required, including null for a missing file"
            );
            let expected: Option<String> = serde_json::from_value(payload["expectedHash"].clone())?;
            let source = read_project_memory(&root)?;
            let date = chrono::Utc::now().format("%Y-%m-%d").to_string();
            let draft: Option<MemoryDraft> = if action == "save" || action == "accept" {
                Some(serde_json::from_value(payload["draft"].clone())?)
            } else {
                None
            };
            if let Some(draft) = &draft {
                validate_sources(&root, &store.paths().base_dir.canonicalize()?, draft)?;
            }
            let id = payload["id"].as_str();
            let candidate = if action == "accept" {
                Some(
                    store.project_memory_candidate(
                        &workspace_key,
                        payload["candidateId"]
                            .as_str()
                            .ok_or_else(|| anyhow::anyhow!("suggestion ID is required"))?,
                    )?,
                )
            } else {
                None
            };
            let candidate_entry_id = candidate
                .as_ref()
                .map(|candidate| format!("mem_c{}", &candidate.id[..32]));
            if let Some(candidate) = &candidate {
                if candidate.status == "accepted" {
                    return Ok(json!({"status":"accepted"}));
                }
                ensure!(
                    ["pending", "accepting"].contains(&candidate.status.as_str()),
                    "suggestion is no longer pending"
                );
                ensure!(
                    payload["revision"].as_u64() == Some(candidate.revision),
                    "suggestion changed; reload"
                );
                let document = MemoryDocument::parse(source.as_deref().unwrap_or_default())?;
                if let Some(entry) = document
                    .entries
                    .iter()
                    .find(|entry| Some(&entry.id) == candidate_entry_id.as_ref())
                {
                    let expected_draft = draft.as_ref().unwrap();
                    ensure!(
                        entry.text
                            == draft
                                .as_ref()
                                .unwrap()
                                .text
                                .split_whitespace()
                                .collect::<Vec<_>>()
                                .join(" ")
                            && entry.status != gyro_core::project_memory::MemoryStatus::Invalid
                            && entry.metadata.as_ref().is_some_and(|metadata| metadata.kind
                                == expected_draft.kind
                                && metadata.paths == expected_draft.paths
                                && metadata.sources == expected_draft.sources
                                && metadata.supersedes == expected_draft.supersedes),
                        "saved suggestion differs; review the existing memory entry"
                    );
                    store.decide_project_memory_candidate(
                        &workspace_key,
                        &candidate.id,
                        candidate.revision,
                        "accepted",
                    )?;
                    return Ok(json!({"status":"accepted"}));
                }
            }
            let operation = match (action, id, draft.as_ref()) {
                ("forget", Some(id), _) => MemoryWrite::ForgetId { id },
                ("save", Some(id), Some(draft)) => MemoryWrite::Edit {
                    id,
                    date: &date,
                    draft,
                },
                ("save", None, Some(draft)) => MemoryWrite::Add { date: &date, draft },
                ("accept", _, Some(draft)) => MemoryWrite::AddWithId {
                    id: candidate_entry_id.as_deref().unwrap(),
                    date: &date,
                    draft,
                },
                _ => anyhow::bail!("memory entry ID is required"),
            };
            let plan = plan_write(source.as_deref(), expected.as_deref(), operation)?;
            // Human Save is an explicit edit, without impersonating a model
            // turn. Recheck current authority and live editor buffers.
            let (_, _, current_root) = root_scope(&store, session_id, Some(&root_id))?;
            ensure!(current_root == root, "workspace root changed; reload");
            let policy = store
                .get_project_capability_policy(&workspace_key)?
                .with_missing_classes_defaulted();
            ensure!(
                policy.access_for(CapabilityClass::WorkspaceWrite) != CapabilityAccess::Deny,
                "project policy denies memory changes"
            );
            let evidence = app.state::<CapabilityIdeEvidenceManager>();
            let guard = evidence
                .evidence
                .lock()
                .map_err(|_| anyhow::anyhow!("editor evidence is unavailable"))?;
            let dirty = guard.get(&workspace_key).is_some_and(|snapshot| {
                snapshot.buffers.iter().any(|buffer| {
                    buffer["path"].as_str() == Some(MEMORY_PATH)
                        && buffer["dirty"].as_bool() == Some(true)
                })
            });
            drop(guard);
            ensure!(
                !dirty,
                "Project memory has unsaved editor changes; save or revert them first"
            );
            if !root.join(".gyro").is_dir() {
                create_workspace_path_impl(&WorkspacePathCreateRequest {
                    workspace_path: workspace_key.to_string(),
                    path: ".gyro".into(),
                    kind: "directory".into(),
                })?;
            }
            if let Some(candidate) = &candidate {
                store.begin_project_memory_candidate_acceptance(
                    &workspace_key,
                    &candidate.id,
                    candidate.revision,
                    draft.as_ref().unwrap(),
                )?;
            }
            let proposal =
                workspace_mutations::create_file_mutation_proposal_from_snapshot_at_root(
                    &store,
                    FileMutationProposalRequest {
                        session_id: session_id.into(),
                        turn_id: None,
                        path: MEMORY_PATH.into(),
                        content: plan.content,
                        expected_hash: plan.expected_hash,
                    },
                    true,
                    Some(&root_id),
                )?;
            ensure!(
                proposal.status == gyro_core::MutationProposalStatus::Applied,
                "memory edit was not applied"
            );
            if let Some(candidate) = &candidate {
                store.decide_project_memory_candidate(
                    &workspace_key,
                    &candidate.id,
                    candidate.revision + 1,
                    "accepted",
                )?;
            }
            let _ = app.emit("gyro://project-memory-changed", json!({"rootId":root_id}));
            Ok(json!({"status":"applied","proposalId":proposal.id}))
        }
        _ => anyhow::bail!("unknown project-memory action"),
    }
}

fn validate_sources(
    root: &std::path::Path,
    private: &std::path::Path,
    draft: &MemoryDraft,
) -> Result<()> {
    for source in &draft.sources {
        if let MemorySource::ProjectFile {
            path, content_hash, ..
        } = source
        {
            ensure!(
                !root.join(path).starts_with(private),
                "Gyro private data cannot be a project memory source"
            );
            let bytes = gyro_core::project_memory::confined_bytes(root, path, 1024 * 1024)?
                .ok_or_else(|| anyhow::anyhow!("memory source is unavailable"))?;
            ensure!(
                gyro_core::mutations::content_hash(&bytes) == *content_hash,
                "memory source changed; review the current file"
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use gyro_core::SessionStore;
    #[test]
    fn root_authority_refuses_foreign_roots_and_projectless_sessions() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(gyro_core::GyroPaths::from_base_dir(
            temp.path().join("private"),
        ))
        .unwrap();
        let session = store
            .create_session(temp.path(), gyro_core::SessionOrigin::Desktop, "memory")
            .unwrap();
        assert!(root_scope(&store, &session.id.to_string(), Some("foreign-root")).is_err());
        assert!(root_scope(&store, &session.id.to_string(), None).is_ok());
    }
}
