//! Model-facing workspace edits.
//!
//! Two argument shapes share one mutation path: `gyro_workspace_propose_edit`
//! submits whole-file content, and `gyro_workspace_edit` replaces an exact
//! string inside a file the model already read. Both land in the same proposal
//! store, so the hash guard, atomic replacement, approval review and durable
//! decision are identical; a string edit only removes the need to re-emit an
//! entire file to change three lines of it.
use super::*;
use serde_json::{json, Value};

const WORKSPACE_EDIT_SCHEMA: &str = "gyro.workspace-edit.v1";

/// What the caller asked for, so the result can stay honest about it.
enum EditShape {
    /// Whole-file content was supplied by the model.
    Content,
    /// An exact string was replaced in the file on disk.
    Replacement { count: usize, line: u64 },
}

pub(super) fn execute(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    request: &CapabilityRequest,
) -> anyhow::Result<(String, Value, Option<CapabilityResourceRef>)> {
    let arguments = &request.arguments;
    let path = gyro_core::normalize_capability_relative_path(capability_argument_string(
        arguments, "path",
    )?)?;
    assert_no_unsaved_editor_changes(app, bound, &path)?;
    let candidate =
        gyro_core::security::assert_path_inside_workspace(&bound.workspace, Path::new(&path))?;
    let config = load_config_blocking().map_err(anyhow::Error::msg)?;
    let apply_immediately =
        bound.policy.mode == CapabilityRunMode::Normal && capability_full_access_enabled(&config);

    let (content, expected_hash, shape) = match request.capability_id {
        CapabilityId::WorkspaceProposeEdit => {
            let content = arguments
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("capability argument `content` is required"))?
                .to_string();
            let expected_hash = arguments
                .get("expectedHash")
                .and_then(Value::as_str)
                .map(str::to_string);
            if candidate.exists() && expected_hash.is_none() {
                anyhow::bail!(
                    "expectedHash is required when proposing changes to an existing file"
                );
            }
            (content, expected_hash, EditShape::Content)
        }
        CapabilityId::WorkspaceEdit => {
            let replacement = string_replacement(&candidate, &path, arguments)?;
            (
                replacement.content,
                Some(replacement.base_hash),
                EditShape::Replacement {
                    count: replacement.count,
                    line: replacement.line,
                },
            )
        }
        other => anyhow::bail!("workspace_edit_capability does not handle {other}"),
    };

    let store = open_store().map_err(anyhow::Error::msg)?;
    let proposal = create_file_mutation_proposal_in_store(
        &store,
        FileMutationProposalRequest {
            session_id: bound.session_id.clone(),
            turn_id: bound.turn_id.clone(),
            path: path.clone(),
            content,
            expected_hash,
        },
        apply_immediately,
    )?;
    emit_proposal_events(app, bound, &proposal);
    let resource = CapabilityResourceRef {
        id: proposal.id.to_string(),
        kind: "proposal".into(),
        label: path.clone(),
    };
    let (summary, data) = match shape {
        EditShape::Content => (
            if apply_immediately {
                format!("Applied changes to {path}")
            } else {
                format!("Proposed changes to {path} for Workspace review")
            },
            bounded_proposal_result(&proposal),
        ),
        EditShape::Replacement { count, line } => {
            let noun = if count == 1 { "edit" } else { "edits" };
            (
                if apply_immediately {
                    format!("Applied {count} {noun} to {path}")
                } else {
                    format!("Proposed {count} {noun} to {path} for Workspace review")
                },
                bounded_edit_result(&proposal, count, line),
            )
        }
    };
    Ok((summary, data, Some(resource)))
}

/// Return the durable outcome without echoing the file body. A full proposal
/// can exceed the tool budget after the mutation has already succeeded, which
/// would incorrectly report failure and encourage the model to repeat a write.
fn bounded_proposal_result(proposal: &MutationProposal) -> Value {
    json!({
        "schema": WORKSPACE_EDIT_SCHEMA,
        "id": proposal.id,
        "proposalId": proposal.id,
        "path": proposal.path,
        "status": proposal.status.as_str(),
        "operation": proposal.operation,
        "expectedHash": proposal.expected_hash,
        "contentHash": content_hash(proposal.content.as_bytes()),
        "error": proposal.error.as_deref().map(gyro_core::sanitize_capability_summary),
    })
}

fn bounded_edit_result(proposal: &MutationProposal, count: usize, line: u64) -> Value {
    let mut data = bounded_proposal_result(proposal);
    data["replacements"] = json!(count);
    data["line"] = json!(line);
    data
}

#[derive(Debug)]
struct Replacement {
    content: String,
    base_hash: String,
    count: usize,
    line: u64,
}

/// Read the file, prove the match is unambiguous, and compute the new content.
/// Every failure here happens before a proposal exists, so a rejected edit
/// never leaves a reviewable proposal behind.
fn string_replacement(
    candidate: &Path,
    path: &str,
    arguments: &Value,
) -> anyhow::Result<Replacement> {
    if !candidate.exists() {
        anyhow::bail!(
            "{path} does not exist; use gyro_workspace_propose_edit to create a new file"
        );
    }
    let (bytes, _) =
        read_bounded_regular_file(candidate, MAX_WORKSPACE_FILE_EDIT_BYTES, "workspace file")?;
    if bytes.len() > MAX_WORKSPACE_FILE_EDIT_BYTES {
        anyhow::bail!("workspace file is too large to edit in Gyro");
    }
    if bytes.contains(&0) {
        anyhow::bail!("binary workspace files cannot be edited");
    }
    let base_hash = content_hash(&bytes);
    if let Some(expected) = arguments.get("expectedHash").and_then(Value::as_str) {
        if expected != base_hash {
            anyhow::bail!("file changed on disk; re-read it before editing");
        }
    }
    let text =
        String::from_utf8(bytes).map_err(|_| anyhow::anyhow!("{path} is not valid UTF-8 text"))?;
    // Read both strings verbatim: leading indentation and a trailing newline
    // are part of what the model is matching, so neither may be trimmed.
    let old = arguments
        .get("oldString")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("capability argument `oldString` is required"))?;
    let new = arguments
        .get("newString")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            anyhow::anyhow!("capability argument `newString` is required; pass an empty string to delete the match")
        })?;
    if old == new {
        anyhow::bail!("oldString and newString are identical; this edit would change nothing");
    }
    let replace_all = arguments
        .get("replaceAll")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let count = text.matches(old).count();
    if count == 0 {
        anyhow::bail!(
            "oldString was not found in {path}; re-read the file and match it exactly, including indentation"
        );
    }
    if count > 1 && !replace_all {
        anyhow::bail!(
            "oldString matches {count} places in {path}; include more surrounding context or pass replaceAll: true"
        );
    }
    let offset = text.find(old).unwrap_or(0);
    let line = text[..offset].matches('\n').count() as u64 + 1;
    let content = text.replace(old, new);
    if content.len() > MAX_WORKSPACE_FILE_EDIT_BYTES {
        anyhow::bail!("the edited file would exceed the Gyro edit size limit");
    }
    if content.contains('\0') {
        anyhow::bail!("the edited file would contain binary content");
    }
    Ok(Replacement {
        content,
        base_hash,
        count,
        line,
    })
}

/// A proposed edit is meaningless while the user has unsaved changes in the
/// editor, because approving it would silently overwrite what they typed.
/// Shared with the lifecycle tools, which must not delete or move a file the
/// user is still editing.
pub(super) fn assert_no_unsaved_editor_changes(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    path: &str,
) -> anyhow::Result<()> {
    let latest_context = app
        .state::<CapabilityIdeEvidenceManager>()
        .by_workspace
        .lock()
        .map_err(|_| anyhow::anyhow!("IDE evidence state is unavailable"))?
        .get(&bound.workspace_key)
        .cloned()
        .unwrap_or_else(|| bound.workspace_context.clone());
    if latest_context.buffers.iter().any(|buffer| {
        buffer.get("path").and_then(Value::as_str) == Some(path)
            && buffer
                .get("dirty")
                .and_then(Value::as_bool)
                .unwrap_or(false)
    }) {
        anyhow::bail!(
            "the target has unsaved editor changes; save or revert it before proposing an edit"
        );
    }
    Ok(())
}

/// Surface the proposal to the chat that made it. The store keeps the durable
/// record; these events are what the Workspace review rail reacts to. Shared
/// with the memory tools, which queue proposals through the same lane.
pub(super) fn emit_proposal_events(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    proposal: &MutationProposal,
) {
    let proposal_id = proposal.id.to_string();
    let Ok(store) = open_store() else {
        return;
    };
    let Ok(session_id) = Uuid::parse_str(&bound.session_id) else {
        return;
    };
    let Ok(events) = store.read_recent_events(session_id, 16) else {
        return;
    };
    for event in events.into_iter().filter(|event| {
        event.payload.get("proposalId").and_then(Value::as_str) == Some(proposal_id.as_str())
    }) {
        let _ = app.emit(PROVIDER_CAPABILITY_EVENT, event);
    }
}

/// Tool schemas live here so `lib.rs` keeps a single delegation guard instead
/// of one arm per capability.
pub(super) fn schema(id: CapabilityId) -> Option<(Value, Vec<&'static str>)> {
    let (properties, required) = match id {
        CapabilityId::WorkspaceProposeEdit => (
            json!({
                "path": { "type": "string" },
                "content": { "type": "string" },
                "expectedHash": { "type": "string" }
            }),
            vec!["path", "content"],
        ),
        CapabilityId::WorkspaceEdit => (
            json!({
                "path": { "type": "string" },
                "oldString": {
                    "type": "string",
                    "description": "Exact text to replace, copied from the file including indentation. It must match exactly once unless replaceAll is true."
                },
                "newString": {
                    "type": "string",
                    "description": "Replacement text. Pass an empty string to delete the matched text."
                },
                "replaceAll": {
                    "type": "boolean",
                    "description": "Replace every occurrence instead of failing when oldString is ambiguous."
                },
                "expectedHash": {
                    "type": "string",
                    "description": "Optional guard: fail unless the file still hashes to this value. Prefer re-reading the file instead."
                }
            }),
            vec!["path", "oldString", "newString"],
        ),
        _ => return None,
    };
    Some((properties, required))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn large_proposals_return_the_durable_outcome_within_the_tool_budget() {
        for apply_immediately in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let store =
                SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
            let session = store
                .create_session(temp.path(), SessionOrigin::Desktop, "large edit")
                .unwrap();
            let content = "line with quoted text: \"hello\"\n".repeat(10_000);
            let proposal = create_file_mutation_proposal_in_store(
                &store,
                FileMutationProposalRequest {
                    session_id: session.id.to_string(),
                    turn_id: Some(Uuid::new_v4().to_string()),
                    path: "large.txt".into(),
                    content: content.clone(),
                    expected_hash: None,
                },
                apply_immediately,
            )
            .unwrap();
            // This is the former wire payload, which fails after the write.
            assert!(gyro_core::validate_capability_result_data(
                serde_json::to_value(&proposal).unwrap()
            )
            .is_err());
            for data in [
                bounded_proposal_result(&proposal),
                bounded_edit_result(&proposal, 1, 1),
            ] {
                let data =
                    gyro_core::validate_capability_result_data(redact_json_strings(data)).unwrap();
                assert_eq!(data["proposalId"], proposal.id.to_string());
                assert_eq!(
                    data["status"],
                    if apply_immediately {
                        "applied"
                    } else {
                        "pending"
                    }
                );
                assert_eq!(data["contentHash"], content_hash(content.as_bytes()));
                assert!(data.get("content").is_none());
            }
            let target = temp.path().join("large.txt");
            if apply_immediately {
                assert_eq!(fs::read_to_string(target).unwrap(), content);
            } else {
                assert!(!target.exists());
            }
        }
    }

    fn workspace_with_file(content: &str) -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("sample.ts");
        fs::write(&target, content).unwrap();
        (temp, target)
    }

    fn arguments(old: &str, new: &str, replace_all: bool) -> Value {
        json!({ "oldString": old, "newString": new, "replaceAll": replace_all })
    }

    #[test]
    fn unique_match_is_replaced_and_reports_its_line() {
        let (_temp, target) = workspace_with_file("one\ntwo\nthree\n");
        let replacement =
            string_replacement(&target, "sample.ts", &arguments("two", "TWO", false)).unwrap();
        assert_eq!(replacement.content, "one\nTWO\nthree\n");
        assert_eq!(replacement.count, 1);
        assert_eq!(replacement.line, 2);
        assert_eq!(replacement.base_hash, content_hash(b"one\ntwo\nthree\n"));
    }

    #[test]
    fn absent_match_is_rejected_before_any_proposal_exists() {
        let (_temp, target) = workspace_with_file("one\ntwo\n");
        let error = string_replacement(&target, "sample.ts", &arguments("nope", "x", false))
            .unwrap_err()
            .to_string();
        assert!(error.contains("was not found in sample.ts"), "{error}");
    }

    #[test]
    fn ambiguous_match_requires_replace_all() {
        let (_temp, target) = workspace_with_file("dup\ndup\n");
        let error = string_replacement(&target, "sample.ts", &arguments("dup", "x", false))
            .unwrap_err()
            .to_string();
        assert!(error.contains("matches 2 places"), "{error}");
        let replacement =
            string_replacement(&target, "sample.ts", &arguments("dup", "x", true)).unwrap();
        assert_eq!(replacement.content, "x\nx\n");
        assert_eq!(replacement.count, 2);
        assert_eq!(replacement.line, 1);
    }

    #[test]
    fn empty_new_string_deletes_the_match() {
        let (_temp, target) = workspace_with_file("keep\ndrop\nkeep\n");
        let replacement =
            string_replacement(&target, "sample.ts", &arguments("drop\n", "", false)).unwrap();
        assert_eq!(replacement.content, "keep\nkeep\n");
    }

    #[test]
    fn deleting_an_indented_line_takes_its_indentation_with_it() {
        let (_temp, target) = workspace_with_file("a\n    indented\nb\n");
        let replacement = string_replacement(
            &target,
            "sample.ts",
            &arguments("    indented\n", "", false),
        )
        .unwrap();
        assert_eq!(replacement.content, "a\nb\n");
        assert_eq!(replacement.line, 2);
    }

    #[test]
    fn stale_expected_hash_and_no_op_edits_are_rejected() {
        let (_temp, target) = workspace_with_file("one\n");
        let stale = json!({
            "oldString": "one",
            "newString": "two",
            "expectedHash": content_hash(b"something else")
        });
        let error = string_replacement(&target, "sample.ts", &stale)
            .unwrap_err()
            .to_string();
        assert!(error.contains("changed on disk"), "{error}");

        let no_op = arguments("one", "one", false);
        let error = string_replacement(&target, "sample.ts", &no_op)
            .unwrap_err()
            .to_string();
        assert!(error.contains("identical"), "{error}");
    }

    #[test]
    fn missing_file_is_rejected_with_the_create_tool_named() {
        let temp = tempfile::tempdir().unwrap();
        let error = string_replacement(
            &temp.path().join("absent.ts"),
            "absent.ts",
            &arguments("a", "b", false),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("gyro_workspace_propose_edit"), "{error}");
    }

    #[test]
    fn schemas_require_the_arguments_each_tool_needs() {
        let (properties, required) = schema(CapabilityId::WorkspaceEdit).unwrap();
        assert!(properties["oldString"].is_object());
        assert!(properties["newString"].is_object());
        assert_eq!(required, vec!["path", "oldString", "newString"]);
        let (_, required) = schema(CapabilityId::WorkspaceProposeEdit).unwrap();
        assert_eq!(required, vec!["path", "content"]);
        assert!(schema(CapabilityId::WorkspaceList).is_none());
    }
}
