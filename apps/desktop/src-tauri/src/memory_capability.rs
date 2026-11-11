//! Durable project memory: notes that survive a chat.
//!
//! Memory is a workspace file (`.gyro/memory.md`), not a private database, so
//! every entry is visible, editable, diffable, and deletable by the person who
//! owns the project, and it travels with the workspace. Writes go through the
//! same proposal store as `gyro_workspace_edit`: Full Access in a normal run
//! applies the change immediately, and every other posture produces a
//! reviewable diff.
//!
//! The `.gyro` directory itself is app-owned state, created eagerly the way
//! session events are; the memory file never bypasses review. Plan mode is
//! refused, because writing memory is writing.
use crate::workspace_edit_capability::{assert_no_unsaved_editor_changes, emit_proposal_events};
use crate::{
    app::config::load_config_blocking,
    capabilities::access::{capability_argument_string, capability_full_access_enabled},
    capability_output_budget,
    capability_workspace_helpers::{workspace_result_byte_limit, workspace_result_bytes_schema},
    delegated_agents,
    state::provider_run::BoundProviderCapabilityContext,
    stores::open_store,
    workspace::{
        files::read_bounded_regular_file,
        paths::create_workspace_path_impl,
        types::{FileMutationProposalRequest, WorkspacePathCreateRequest},
    },
    workspace_mutations,
};
use gyro_core::{
    project_memory::{
        plan_write, MemoryDocument, MemoryWrite, MAX_MEMORY_ENTRIES, MAX_MEMORY_FILE_BYTES,
        MEMORY_PATH,
    },
    CapabilityId, CapabilityRequest, CapabilityResourceRef, CapabilityRunMode,
};
use serde_json::{json, Value};
use std::path::Path;

const MEMORY_SCHEMA: &str = "gyro.memory.v1";
const MEMORY_DIRECTORY: &str = ".gyro";

pub(super) fn execute(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    request: &CapabilityRequest,
) -> anyhow::Result<(String, Value, Option<CapabilityResourceRef>)> {
    let arguments = &request.arguments;
    let candidate = gyro_core::security::assert_path_inside_workspace(
        &bound.workspace,
        Path::new(MEMORY_PATH),
    )?;
    let snapshot = read_memory(&candidate)?;
    let content = snapshot.as_deref().unwrap_or_default();
    match request.capability_id {
        CapabilityId::MemoryRead => {
            let data = memory_read_result(content, snapshot.is_some(), arguments)?;
            let total = data["total"].as_u64().unwrap_or(0);
            let summary = if total == 0 {
                format!("Project memory is empty at {MEMORY_PATH}")
            } else {
                format!("Read project memory ({total} entries)")
            };
            Ok((summary, data, None))
        }
        CapabilityId::MemoryWrite => {
            anyhow::ensure!(
                bound
                    .policy
                    .access_for(gyro_core::CapabilityClass::WorkspaceWrite)
                    != gyro_core::CapabilityAccess::Deny,
                "project policy denies memory changes"
            );
            let action = capability_argument_string(arguments, "action")?.to_ascii_lowercase();
            let date = today();
            let operation = match action.as_str() {
                "append" => MemoryWrite::Append {
                    date: &date,
                    text: capability_argument_string(arguments, "text")?,
                },
                "forget" => MemoryWrite::Forget {
                    needle: capability_argument_string(arguments, "match")?,
                },
                other => anyhow::bail!(
                    "capability argument `action` must be `append` or `forget`, not `{other}`"
                ),
            };
            // Bind to the bytes that produced the replacement, never a later read.
            let document = MemoryDocument::parse(content)?;
            let expected_hash = snapshot.as_ref().map(|_| document.document_hash.as_str());
            let plan = plan_write(snapshot.as_deref(), expected_hash, operation)?;
            assert_no_unsaved_editor_changes(app, bound, MEMORY_PATH)?;
            ensure_memory_directory(&bound.workspace, &candidate)?;
            let config = load_config_blocking().map_err(anyhow::Error::msg)?;
            let apply_immediately = bound.policy.mode == CapabilityRunMode::Normal
                && capability_full_access_enabled(&config)
                && delegated_agents::file_edit_ceiling(app, &bound.session_id);
            let store = open_store().map_err(anyhow::Error::msg)?;
            let root_id = workspace_mutations::bound_workspace_root_id(&store, bound)?;
            let proposal =
                workspace_mutations::create_file_mutation_proposal_from_snapshot_at_root(
                    &store,
                    FileMutationProposalRequest {
                        session_id: bound.session_id.clone(),
                        turn_id: bound.turn_id.clone(),
                        path: MEMORY_PATH.to_string(),
                        content: plan.content,
                        expected_hash: plan.expected_hash,
                    },
                    apply_immediately,
                    Some(&root_id),
                )?;
            emit_proposal_events(app, bound, &proposal);
            let entries = memory_entries(&proposal.content)?;
            let summary = if apply_immediately {
                format!("Updated project memory ({action})")
            } else {
                format!("Proposed a project memory {action} for review")
            };
            let resource = CapabilityResourceRef {
                id: proposal.id.to_string(),
                kind: "proposal".into(),
                label: MEMORY_PATH.to_string(),
            };
            Ok((
                summary,
                json!({
                    "schema": MEMORY_SCHEMA,
                    "path": MEMORY_PATH,
                    "action": action,
                    "status": proposal.status.as_str(),
                    "proposalId": proposal.id,
                    "total": entries.len(),
                }),
                Some(resource),
            ))
        }
        other => anyhow::bail!("memory_capability does not handle {other}"),
    }
}

fn memory_read_result(content: &str, exists: bool, arguments: &Value) -> anyhow::Result<Value> {
    let mut entries = memory_entries(content)?;
    if let Some(query) = arguments["query"].as_str() {
        anyhow::ensure!(query.len() <= 512, "memory search is too long");
        let query = query.to_lowercase();
        entries.retain(|entry| {
            entry["text"]
                .as_str()
                .is_some_and(|text| text.to_lowercase().contains(&query))
        });
    }
    let mut data =
        json!({"schema":MEMORY_SCHEMA,"path":MEMORY_PATH,"exists":exists,"total":entries.len()});
    if arguments["raw"].as_bool().unwrap_or(false) {
        // Raw text already contains every parsed entry; return one format.
        data["raw"] = json!(content);
        capability_output_budget::text_result(
            data,
            &[capability_output_budget::TextField {
                pointer: "/raw",
                window: "rawWindow",
                offset: "offset",
                tail: false,
            }],
            arguments,
        )
    } else {
        let offset = capability_output_budget::offset(arguments, "offset")?.unwrap_or(0);
        let limit = capability_output_budget::page_limit(arguments, 20, MAX_MEMORY_ENTRIES)?;
        data["offset"] = json!(offset);
        data["entries"] = json!(entries
            .into_iter()
            .skip(offset)
            .take(limit)
            .collect::<Vec<_>>());
        capability_output_budget::array_result(
            data,
            "entries",
            workspace_result_byte_limit(arguments)?,
        )
    }
}

fn read_memory(candidate: &Path) -> anyhow::Result<Option<String>> {
    let (bytes, _) =
        match read_bounded_regular_file(candidate, MAX_MEMORY_FILE_BYTES, "project memory") {
            Ok(value) => value,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
            {
                return Ok(None)
            }
            Err(error) => return Err(error),
        };
    if bytes.len() > MAX_MEMORY_FILE_BYTES {
        anyhow::bail!("project memory is too large to read in Gyro");
    }
    if bytes.contains(&0) {
        anyhow::bail!("project memory is not a text file");
    }
    Ok(Some(String::from_utf8(bytes).map_err(|_| {
        anyhow::anyhow!("project memory is not UTF-8 text")
    })?))
}

/// The `.gyro` directory is app state, so it is created before the file is
/// proposed; the file itself still goes through the proposal lane.
fn ensure_memory_directory(workspace: &Path, candidate: &Path) -> anyhow::Result<()> {
    if candidate.parent().is_some_and(|parent| parent.is_dir()) {
        return Ok(());
    }
    create_workspace_path_impl(&WorkspacePathCreateRequest {
        workspace_path: workspace.to_string_lossy().to_string(),
        path: MEMORY_DIRECTORY.to_string(),
        kind: "directory".to_string(),
    })?;
    Ok(())
}

fn memory_entries(content: &str) -> anyhow::Result<Vec<Value>> {
    Ok(MemoryDocument::parse(content)?
        .entries
        .into_iter()
        .filter(|entry| entry.status != gyro_core::project_memory::MemoryStatus::Invalid)
        .map(|entry| json!({ "date": entry.date, "text": entry.text, "id": entry.id, "status": entry.status }))
        .collect())
}

fn today() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

/// Tool schemas live here so `lib.rs` keeps a single delegation guard instead
/// of one arm per capability.
pub(super) fn schema(id: CapabilityId) -> Option<(Value, Vec<&'static str>)> {
    let (properties, required) = match id {
        CapabilityId::MemoryRead => (
            json!({
                "raw": { "type": "boolean", "description": "Return raw file text instead of parsed entries." },
                "query": {"type":"string","maxLength":512,"description":"Return only entries containing this text; prefer a focused query over reading the whole memory file."},
                "offset": capability_output_budget::offset_schema(),
                "limit": { "type":"integer","minimum":1,"maximum":MAX_MEMORY_ENTRIES,"default":20 },
                "maxBytes": workspace_result_bytes_schema()
            }),
            vec![],
        ),
        CapabilityId::MemoryWrite => (
            json!({
                "action": {
                    "type": "string",
                    "enum": ["append", "forget"],
                    "description": "append adds one entry; forget removes the single entry matching `match`."
                },
                "text": { "type": "string", "description": "The entry to remember, as one line. Required for append." },
                "match": { "type": "string", "description": "Text that identifies exactly one existing entry. Required for forget." }
            }),
            vec!["action"],
        ),
        _ => return None,
    };
    Some((properties, required))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capability_workspace_helpers::DEFAULT_WORKSPACE_RESULT_BYTES;

    #[test]
    fn reading_memory_distinguishes_absent_empty_and_invalid_files() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("memory.md");
        assert_eq!(read_memory(&target).unwrap(), None);
        std::fs::write(&target, "").unwrap();
        assert_eq!(read_memory(&target).unwrap(), Some(String::new()));
        for invalid in [vec![0], vec![0xff], vec![b'x'; MAX_MEMORY_FILE_BYTES + 1]] {
            std::fs::write(&target, invalid).unwrap();
            assert!(read_memory(&target).is_err());
        }
        assert!(read_memory(temp.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn reading_memory_refuses_symlinks_including_dangling_ones() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.md");
        let target = temp.path().join("memory.md");
        std::fs::write(&source, "- note").unwrap();
        std::os::unix::fs::symlink(&source, &target).unwrap();
        assert!(read_memory(&target).is_err());
        std::fs::remove_file(source).unwrap();
        assert!(read_memory(&target).is_err());
    }

    #[test]
    fn memory_raw_and_entry_pages_are_not_duplicated_or_lost() {
        let content = (0..200)
            .map(|index| format!("- 2026-10-11 — entry {index} {}\n", "x".repeat(400)))
            .collect::<String>();
        let raw = memory_read_result(&content, true, &json!({"raw":true})).unwrap();
        assert!(raw.get("entries").is_none());
        assert_eq!(raw["rawWindow"]["truncated"], true);
        assert!(serde_json::to_vec(&raw).unwrap().len() <= DEFAULT_WORKSPACE_RESULT_BYTES);
        let first = memory_read_result(&content, true, &json!({})).unwrap();
        assert_eq!(first["returned"], 20);
        assert_eq!(first["nextOffset"], 20);
        let second =
            memory_read_result(&content, true, &json!({"offset":first["nextOffset"]})).unwrap();
        assert!(second["entries"][0]["text"]
            .as_str()
            .unwrap()
            .starts_with("entry 20 "));
    }

    #[test]
    fn explicit_memory_page_limit_is_not_silently_capped_at_fifty() {
        let content = (0..200)
            .map(|index| format!("- entry {index}\n"))
            .collect::<String>();
        let page =
            memory_read_result(&content, true, &json!({"limit":200,"maxBytes":131072})).unwrap();
        assert_eq!(page["returned"], 200);
        assert_eq!(page["hasMore"], false);
        for limit in [json!(0), json!(201), json!("200"), json!(1.5)] {
            assert!(memory_read_result(&content, true, &json!({"limit":limit})).is_err());
        }
    }

    #[test]
    fn schemas_require_the_arguments_each_tool_needs() {
        let (properties, required) = schema(CapabilityId::MemoryWrite).unwrap();
        assert!(properties["action"].is_object());
        assert_eq!(required, vec!["action"]);
        let (_, required) = schema(CapabilityId::MemoryRead).unwrap();
        assert!(required.is_empty());
        assert!(schema(CapabilityId::WorkspaceRead).is_none());
    }
}
