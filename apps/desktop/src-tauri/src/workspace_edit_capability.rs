//! Model-facing workspace edits.
//!
//! Two argument shapes share one mutation path: `gyro_workspace_propose_edit`
//! submits whole-file content, and `gyro_workspace_edit` replaces an exact
//! string inside a file the model already read. Both land in the same proposal
//! store, so the hash guard, atomic replacement, approval review and durable
//! decision are identical; a string edit only removes the need to re-emit an
//! entire file to change three lines of it. Immediate edits preserve the same stale-base guard as reviewed edits.
use crate::{
    app::{
        config::load_config_blocking,
        limits::{MAX_WORKSPACE_FILE_EDIT_BYTES, PROVIDER_CAPABILITY_EVENT},
    },
    capabilities::access::{
        approve_for_me_applies_file_changes, capability_argument_string,
        capability_full_access_enabled,
    },
    delegated_agents,
    ide::task_discovery::content_hash,
    state::{managers::with_ide_evidence, provider_run::BoundProviderCapabilityContext},
    stores::open_store,
    workspace::{files::read_workspace_bytes, types::FileMutationProposalRequest},
    workspace_mutations,
};
use gyro_core::{
    CapabilityId, CapabilityRequest, CapabilityResourceRef, CapabilityRunMode, MutationProposal,
    SessionStore, WorkspaceContextSnapshot,
};
use serde_json::{json, Value};
use std::path::Path;
use tauri::Emitter;
use uuid::Uuid;

const WORKSPACE_EDIT_SCHEMA: &str = "gyro.workspace-edit.v1";
const MISSING_PROPOSAL_BASE: &str = "No proposal was created. For a text replacement, use gyro_workspace_edit with oldString and newString after reading the file. For a whole-file replacement, supply the complete file content and pass contentHash from gyro_workspace_read as expectedHash.";

/// What the caller asked for, so the result can stay honest about it.
enum EditShape {
    /// Whole-file content was supplied by the model.
    Content,
    /// An exact string was replaced in the file on disk.
    Replacement { count: usize, line: u64 },
}

/// Catch inputs that cannot produce an edit before asking for write approval.
/// A path suggestion is only a new spelling of the supplied bound-root operand.
pub(super) fn edit_argument_error(
    workspace: &Path,
    id: CapabilityId,
    arguments: &Value,
) -> Option<String> {
    let path = capability_argument_string(arguments, "path").ok()?;
    let missing_proposal_hash = id == CapabilityId::WorkspaceProposeEdit
        && arguments
            .get("expectedHash")
            .and_then(Value::as_str)
            .is_none();
    let needs_hash_or_create = missing_proposal_hash
        && arguments.get("createIfMissing").and_then(Value::as_bool) != Some(true);
    let proposal_guidance = " For an existing file, copy contentHash from the latest successful read to expectedHash. Use createIfMissing: true only for a new file the user requested.";
    if Path::new(path).is_absolute() {
        let relative = crate::capability_workspace_helpers::relative_path_in_bound_root(
            workspace,
            Path::new(path),
            false,
        );
        let mut message = match relative {
            Ok(relative) => {
                format!("Edit paths must be workspace-relative. Retry with path {relative:?}.")
            }
            Err(_) => {
                let candidate = crate::capability_workspace_helpers::relative_path_in_bound_root(
                    Path::new("/"),
                    Path::new(path),
                    false,
                )
                .ok()
                .filter(|relative| {
                    !gyro_core::capability_path_is_sensitive(relative)
                        && gyro_core::security::assert_path_inside_workspace(
                            workspace,
                            Path::new(relative),
                        )
                        .is_ok_and(|target| {
                            target.is_file()
                                && target
                                    .strip_prefix(workspace)
                                    .ok()
                                    .and_then(Path::to_str)
                                    .is_some_and(|path| {
                                        !gyro_core::capability_path_is_sensitive(path)
                                    })
                        })
                });
                match candidate {
                    Some(relative) => format!("If you meant the Workspace-relative file, retry the edit with path {relative:?} without the leading slash."),
                    None => "Edit paths must be relative to the selected Workspace root, without a leading slash. Use an exact path from the user's request or a Workspace tool result.".into(),
                }
            }
        };
        if needs_hash_or_create {
            message.push_str(proposal_guidance);
        }
        return Some(message);
    }
    if !missing_proposal_hash {
        return None;
    }
    // Creation intent does not make a hash optional when the file already exists.
    let existing = gyro_core::normalize_capability_relative_path(path)
        .ok()
        .and_then(|relative| {
            gyro_core::security::assert_path_inside_workspace(workspace, Path::new(&relative)).ok()
        })
        .is_some_and(|candidate| candidate.exists());
    if existing {
        return Some(format!(
            "An existing file requires expectedHash. {MISSING_PROPOSAL_BASE}"
        ));
    }
    needs_hash_or_create.then(|| {
        format!("The proposal needs expectedHash or explicit file creation.{proposal_guidance}")
    })
}

/// New files require an explicit tool intent; a failed read must not silently
/// become a reviewable create. Approval and journal application still follow.
fn require_creation_intent(
    workspace: &Path,
    candidate: &Path,
    path: &str,
    arguments: &Value,
) -> anyhow::Result<()> {
    match candidate.symlink_metadata() {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            anyhow::ensure!(arguments.get("createIfMissing").and_then(Value::as_bool) == Some(true),
                "No file exists at {path:?}; no proposal was created. If the user's requested change calls for this new file, retry this same call with createIfMissing: true instead of creating an empty file first. {}",
                crate::capability_workspace_helpers::workspace_path_recovery(workspace, path));
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
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
    assert_editor_document_version(app, bound, &path, arguments)?;
    assert_no_unsaved_editor_changes(app, bound, &path)?;
    let candidate =
        gyro_core::security::assert_path_inside_workspace(&bound.workspace, Path::new(&path))?;
    let config = crate::chat_permissions::for_active_turn(
        app,
        &bound.session_id,
        load_config_blocking().map_err(anyhow::Error::msg)?,
    );
    let apply_immediately = bound.policy.mode == CapabilityRunMode::Normal
        && (capability_full_access_enabled(&config)
            || approve_for_me_applies_file_changes(&config, &bound.provider_id, bound.policy.mode))
        && delegated_agents::file_edit_ceiling(app, &bound.session_id);

    let store = open_store().map_err(anyhow::Error::msg)?;
    let root_id = workspace_mutations::bound_workspace_root_id(&store, bound)?;
    let (proposal, shape) = match request.capability_id {
        CapabilityId::WorkspaceProposeEdit => {
            require_creation_intent(&bound.workspace, &candidate, &path, arguments)?;
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
                anyhow::bail!("An existing file requires expectedHash. {MISSING_PROPOSAL_BASE}");
            }
            let proposal = workspace_mutations::create_file_mutation_proposal_at_root(
                &store,
                FileMutationProposalRequest {
                    session_id: bound.session_id.clone(),
                    turn_id: bound.turn_id.clone(),
                    path: path.clone(),
                    content,
                    expected_hash,
                },
                apply_immediately,
                Some(&root_id),
            )?;
            (proposal, EditShape::Content)
        }
        CapabilityId::WorkspaceEdit => {
            let committed = commit_string_edit(
                &store,
                &bound.session_id,
                bound.turn_id.clone(),
                Some(&root_id),
                &bound.workspace,
                &candidate,
                &path,
                arguments,
                apply_immediately,
            )?;
            (
                committed.proposal,
                EditShape::Replacement {
                    count: committed.count,
                    line: committed.line,
                },
            )
        }
        other => anyhow::bail!("workspace_edit_capability does not handle {other}"),
    };
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
    let mut data = json!({
        "schema": WORKSPACE_EDIT_SCHEMA,
        "id": proposal.id,
        "proposalId": proposal.id,
        "path": proposal.path,
        "status": proposal.status.as_str(),
        "operation": proposal.operation,
        "expectedHash": proposal.expected_hash,
        "contentHash": content_hash(proposal.content.as_bytes()),
        "error": proposal.error.as_deref().map(gyro_core::sanitize_capability_summary),
        "applied": proposal.status == gyro_core::MutationProposalStatus::Applied,
        "approvalRequired": proposal.status == gyro_core::MutationProposalStatus::Pending,
    });
    if proposal.status == gyro_core::MutationProposalStatus::Pending {
        data["nextStep"] = json!("This proposal has not changed the file on disk. Keep its proposalId and wait for user review before verifying this edit; do not resubmit the same edit. Independent work can continue.");
    }
    data
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
    root: &Path,
    candidate: &Path,
    path: &str,
    arguments: &Value,
) -> anyhow::Result<Replacement> {
    if !candidate.exists() {
        anyhow::bail!(
            "{path} does not exist. Recheck the exact workspace-root-relative path in the request and list the root before guessing another location. Use gyro_workspace_propose_edit only if the task actually calls for creating a new file."
        );
    }
    let (bytes, _) = read_workspace_bytes(
        root,
        candidate,
        MAX_WORKSPACE_FILE_EDIT_BYTES,
        "workspace file",
    )?;
    if bytes.len() > MAX_WORKSPACE_FILE_EDIT_BYTES {
        anyhow::bail!("workspace file is too large to edit in Gyro");
    }
    if bytes.contains(&0) {
        anyhow::bail!("binary workspace files cannot be edited");
    }
    let base_hash = content_hash(&bytes);
    if let Some(expected) = arguments.get("expectedHash").and_then(Value::as_str) {
        if expected != base_hash {
            return Err(workspace_mutations::StaleEditBase(
                "file changed on disk; re-read it before editing",
            )
            .into());
        }
    }
    let text =
        String::from_utf8(bytes).map_err(|_| anyhow::anyhow!("{path} is not valid UTF-8 text"))?;
    // The first replacement comes from the top-level arguments; `edits` adds
    // more, applied in order to the result of the previous one. Any failure
    // rejects the whole call, so a partial batch never becomes a proposal.
    let mut steps = vec![(arguments, String::new())];
    if let Some(extra) = arguments.get("edits").filter(|value| !value.is_null()) {
        let extra = extra
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("capability argument `edits` must be an array"))?;
        if extra.len() > MAX_BATCHED_EDITS {
            anyhow::bail!("edits is limited to {MAX_BATCHED_EDITS} replacements per call");
        }
        for (index, step) in extra.iter().enumerate() {
            if !step.is_object() {
                anyhow::bail!("edits[{index}] must be an object");
            }
            steps.push((step, format!("edits[{index}].")));
        }
    }
    let mut content = text;
    let mut count = 0;
    let mut line = 0;
    for (step, label) in steps {
        let (next, matched, matched_line) = replace_exactly(&content, step, &label, path)?;
        if line == 0 {
            line = matched_line;
        }
        content = next;
        count += matched;
    }
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

const MAX_BATCHED_EDITS: usize = 50;

/// Apply one oldString/newString pair. Read both strings verbatim: leading
/// indentation and a trailing newline are part of what the model matches.
fn replace_exactly(
    text: &str,
    step: &Value,
    label: &str,
    path: &str,
) -> anyhow::Result<(String, usize, u64)> {
    let old = step
        .get("oldString")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("capability argument `{label}oldString` is required"))?;
    let new = step.get("newString").and_then(Value::as_str).ok_or_else(|| {
        anyhow::anyhow!("capability argument `{label}newString` is required; pass an empty string to delete the match")
    })?;
    if old == new {
        anyhow::bail!(
            "{label}oldString and {label}newString are identical; this edit would change nothing"
        );
    }
    let replace_all = step
        .get("replaceAll")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let count = text.matches(old).count();
    if count == 0 {
        anyhow::bail!(
            "{label}oldString was not found in {path}; re-read the file and match it exactly, including indentation. No edits in this call were applied"
        );
    }
    if count > 1 && !replace_all {
        anyhow::bail!(
            "{label}oldString matches {count} places in {path}; include more surrounding context or pass replaceAll: true. No edits in this call were applied"
        );
    }
    let offset = text.find(old).unwrap_or(0);
    let line = text[..offset].matches('\n').count() as u64 + 1;
    Ok((text.replace(old, new), count, line))
}

#[derive(Debug)]
struct CommittedEdit {
    proposal: MutationProposal,
    count: usize,
    line: u64,
}

/// Preserve the caller's observed base, including in full-access mode. A
/// matching string alone cannot establish that an intervening edit was safe.
fn commit_string_edit(
    store: &SessionStore,
    session_id: &str,
    turn_id: Option<String>,
    root_id: Option<&str>,
    root: &Path,
    candidate: &Path,
    path: &str,
    arguments: &Value,
    apply_immediately: bool,
) -> anyhow::Result<CommittedEdit> {
    let replacement = string_replacement(root, candidate, path, arguments)?;
    let proposal = workspace_mutations::create_file_mutation_proposal_at_root(
        store,
        FileMutationProposalRequest {
            session_id: session_id.to_string(),
            turn_id,
            path: path.to_string(),
            content: replacement.content,
            expected_hash: Some(replacement.base_hash),
        },
        apply_immediately,
        root_id,
    )?;
    Ok(CommittedEdit {
        proposal,
        count: replacement.count,
        line: replacement.line,
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
    let dirty = with_ide_evidence(app, bound, |latest| {
        anyhow::ensure!(
            latest.buffers_complete,
            "Editor buffer coverage is incomplete; close extra tabs before editing"
        );
        Ok(latest.buffers.iter().any(|buffer| {
            buffer.get("path").and_then(Value::as_str) == Some(path)
                && buffer
                    .get("dirty")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
        }))
    })?;
    if dirty {
        anyhow::bail!(
            "the target has unsaved editor changes; save or revert it before proposing an edit"
        );
    }
    Ok(())
}

fn assert_editor_document_version(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    path: &str,
    arguments: &Value,
) -> anyhow::Result<()> {
    let Some(expected) = arguments.get("documentVersion") else {
        return Ok(());
    };
    let expected = expected
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("documentVersion must be text"))?;
    with_ide_evidence(app, bound, |latest| {
        check_editor_document_version(latest, path, expected)
    })
}

fn check_editor_document_version(
    context: &WorkspaceContextSnapshot,
    path: &str,
    expected: &str,
) -> anyhow::Result<()> {
    let mut versions = context
        .buffers
        .iter()
        .filter(|buffer| buffer["path"].as_str() == Some(path))
        .filter_map(|buffer| buffer["documentVersion"].as_str())
        .peekable();
    anyhow::ensure!(
        versions.peek().is_some(),
        "No live editor version is available for this path. For a disk edit, read the file with gyro_workspace_read, use its contentHash as expectedHash, and omit documentVersion. For a live-editor edit, read the current buffer first."
    );
    anyhow::ensure!(
        versions.any(|version| version == expected),
        "Editor document version changed. Read the current buffer with gyro_workspace_read_editor and use its documentVersion before retrying."
    );
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
    const DOCUMENT_VERSION: &str =
        "Optional live-editor guard. Use only a documentVersion returned by gyro_workspace_read_editor for this path. Omit for disk edits.";
    let (properties, required) = match id {
        CapabilityId::WorkspaceProposeEdit => (
            json!({
                "path": { "type": "string", "description": "Exact path relative to the workspace root. Preserve paths supplied by the user. A missing file is created only when the task calls for a new file; a failed read alone does not justify creation." },
                "content": { "type": "string", "description": "Complete new file content, replacing the whole file." },
                "createIfMissing": { "type": "boolean", "default": false, "description": "Required true to propose creating a missing file. Set only when the user's task calls for a new file at this exact path, not to work around a failed read of an existing file." },
                "expectedHash": { "type": "string", "description": "Required for an existing file: contentHash from a prior read, rejected if the file changed since. Omit for a new file." },
                "documentVersion": { "type": "string", "description": DOCUMENT_VERSION }
            }),
            vec!["path", "content"],
        ),
        CapabilityId::WorkspaceEdit => (
            json!({
                "path": { "type": "string", "description": "Workspace-relative path of an existing file." },
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
                "edits": {
                    "type": "array",
                    "maxItems": MAX_BATCHED_EDITS,
                    "items": {
                        "type": "object",
                        "properties": {
                            "oldString": { "type": "string" },
                            "newString": { "type": "string" },
                            "replaceAll": { "type": "boolean" }
                        },
                        "required": ["oldString", "newString"],
                        "additionalProperties": false
                    },
                    "description": "More replacements in this file, applied in order after the first one. Use this instead of separate calls for several changes to one file. If any fails, none apply."
                },
                "expectedHash": {
                    "type": "string",
                    "description": "Optional guard from a prior read. An immediate edit still applies when this hash is stale but oldString matches the current file. A reviewed edit fails until the file is read again."
                },
                "documentVersion": { "type": "string", "description": DOCUMENT_VERSION }
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
    use crate::{
        ide::debug::redact_json_strings,
        workspace_mutations::create_file_mutation_proposal_in_store,
    };

    #[test]
    fn edit_input_feedback_points_to_the_exact_bound_path_and_read_hash() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap().join("workspace");
        let propose = |arguments: Value| {
            edit_argument_error(&root, CapabilityId::WorkspaceProposeEdit, &arguments)
        };
        let edit =
            |arguments: Value| edit_argument_error(&root, CapabilityId::WorkspaceEdit, &arguments);
        let input = json!({"path": root.join("src/main.mjs"), "content": "new"});
        let message = propose(input.clone()).unwrap();
        assert!(message.contains("Retry with path \"src/main.mjs\""));
        assert!(
            message.contains("copy contentHash from the latest successful read to expectedHash")
        );
        assert!(!edit(input).unwrap().contains("expectedHash"));

        for path in [
            root.with_file_name("workspace-other").join("secret.rs"),
            root.join("src/../secret.rs"),
        ] {
            let message = propose(json!({"path": path})).unwrap();
            assert!(!message.contains("secret.rs"));
            assert!(!message.contains("Retry with path"));
            assert!(message.contains("without a leading slash"));
            assert!(message
                .contains("copy contentHash from the latest successful read to expectedHash"));
        }
        assert!(propose(json!({"path": "src/main.mjs"}))
            .unwrap()
            .contains("expectedHash"));
        assert!(propose(json!({"path": "src/main.mjs", "expectedHash": "from-read"})).is_none());
        assert!(propose(json!({"path": "src/new.mjs", "createIfMissing": true})).is_none());
        assert!(edit(json!({"path": "src/main.mjs"})).is_none());

        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/main.mjs"), "export const value = 0;\n").unwrap();
        fs::write(root.join(".env"), "fixture\n").unwrap();
        let extra_slash = edit(json!({"path": "/src/main.mjs"})).unwrap();
        assert!(extra_slash.contains("retry the edit with path \"src/main.mjs\""));
        assert!(!edit(json!({"path": "/.env"})).unwrap().contains(".env"));
    }

    #[test]
    fn create_intent_without_a_hash_points_existing_files_to_exact_replacement() {
        let workspace = tempfile::tempdir().unwrap();
        fs::create_dir(workspace.path().join("src")).unwrap();
        let target = workspace.path().join("src/main.mjs");
        fs::write(&target, "export const value = 0;\n").unwrap();
        let propose = |arguments: Value| {
            edit_argument_error(
                workspace.path(),
                CapabilityId::WorkspaceProposeEdit,
                &arguments,
            )
        };
        let mut arguments =
            json!({"path": "src/main.mjs", "content": "1", "createIfMissing": true});
        let error = propose(arguments.clone()).unwrap();
        assert!(error.contains("No proposal was created"));
        assert!(error.contains("gyro_workspace_edit with oldString and newString"));
        assert!(error.contains("contentHash from gyro_workspace_read as expectedHash"));
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "export const value = 0;\n"
        );
        arguments["path"] = "src\\main.mjs".into();
        assert_eq!(propose(arguments.clone()).as_deref(), Some(error.as_str()));
        arguments.as_object_mut().unwrap().remove("createIfMissing");
        assert_eq!(propose(arguments.clone()).as_deref(), Some(error.as_str()));

        arguments["createIfMissing"] = true.into();
        arguments["path"] = "src/new.mjs".into();
        assert!(propose(arguments.clone()).is_none());
        arguments["path"] = "src/main.mjs".into();
        arguments["expectedHash"] = "from-read".into();
        assert!(propose(arguments).is_none());
    }
    use gyro_core::{GyroPaths, SessionOrigin};
    use std::{fs, path::PathBuf};

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
                assert_eq!(data["applied"], apply_immediately);
                assert_eq!(data["approvalRequired"], !apply_immediately);
                if apply_immediately {
                    assert!(data.get("nextStep").is_none());
                } else {
                    assert!(data["nextStep"]
                        .as_str()
                        .unwrap()
                        .contains("has not changed the file on disk"));
                }
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
        let target = temp.path().canonicalize().unwrap().join("sample.ts");
        fs::write(&target, content).unwrap();
        (temp, target)
    }

    fn arguments(old: &str, new: &str, replace_all: bool) -> Value {
        json!({ "oldString": old, "newString": new, "replaceAll": replace_all })
    }

    #[test]
    fn unique_match_is_replaced_and_reports_its_line() {
        let (_temp, target) = workspace_with_file("one\ntwo\nthree\n");
        let replacement = string_replacement(
            target.parent().unwrap(),
            &target,
            "sample.ts",
            &arguments("two", "TWO", false),
        )
        .unwrap();
        assert_eq!(replacement.content, "one\nTWO\nthree\n");
        assert_eq!(replacement.count, 1);
        assert_eq!(replacement.line, 2);
        assert_eq!(replacement.base_hash, content_hash(b"one\ntwo\nthree\n"));
    }

    #[test]
    fn batched_edits_apply_in_order_or_not_at_all() {
        let (_temp, target) = workspace_with_file("one\ntwo\nthree\n");
        let root = target.parent().unwrap();
        let replacement = string_replacement(
            root,
            &target,
            "sample.ts",
            &json!({
                "oldString": "two", "newString": "TWO",
                "edits": [
                    { "oldString": "three", "newString": "3" },
                    { "oldString": "TWO\n3", "newString": "2\n3" }
                ]
            }),
        )
        .unwrap();
        assert_eq!(replacement.content, "one\n2\n3\n");
        assert_eq!(replacement.count, 3);
        assert_eq!(replacement.line, 2);

        let error = string_replacement(
            root,
            &target,
            "sample.ts",
            &json!({
                "oldString": "one", "newString": "ONE",
                "edits": [{ "oldString": "missing", "newString": "x" }]
            }),
        )
        .unwrap_err()
        .to_string();
        assert!(
            error.contains("edits[0].oldString was not found"),
            "{error}"
        );
        assert!(error.contains("No edits in this call were applied"));
        assert_eq!(fs::read_to_string(&target).unwrap(), "one\ntwo\nthree\n");

        for bad in [
            json!("x"),
            json!(["x"]),
            json!(vec![
                json!({"oldString":"o","newString":"O"});
                MAX_BATCHED_EDITS + 1
            ]),
        ] {
            let mut args = arguments("one", "ONE", false);
            args["edits"] = bad;
            assert!(string_replacement(root, &target, "sample.ts", &args).is_err());
        }
    }

    #[test]
    fn absent_match_is_rejected_before_any_proposal_exists() {
        let (_temp, target) = workspace_with_file("one\ntwo\n");
        let error = string_replacement(
            target.parent().unwrap(),
            &target,
            "sample.ts",
            &arguments("nope", "x", false),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("was not found in sample.ts"), "{error}");
    }

    #[test]
    fn ambiguous_match_requires_replace_all() {
        let (_temp, target) = workspace_with_file("dup\ndup\n");
        let error = string_replacement(
            target.parent().unwrap(),
            &target,
            "sample.ts",
            &arguments("dup", "x", false),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("matches 2 places"), "{error}");
        let replacement = string_replacement(
            target.parent().unwrap(),
            &target,
            "sample.ts",
            &arguments("dup", "x", true),
        )
        .unwrap();
        assert_eq!(replacement.content, "x\nx\n");
        assert_eq!(replacement.count, 2);
        assert_eq!(replacement.line, 1);
    }

    #[test]
    fn empty_new_string_deletes_the_match() {
        let (_temp, target) = workspace_with_file("keep\ndrop\nkeep\n");
        let replacement = string_replacement(
            target.parent().unwrap(),
            &target,
            "sample.ts",
            &arguments("drop\n", "", false),
        )
        .unwrap();
        assert_eq!(replacement.content, "keep\nkeep\n");
    }

    #[test]
    fn deleting_an_indented_line_takes_its_indentation_with_it() {
        let (_temp, target) = workspace_with_file("a\n    indented\nb\n");
        let replacement = string_replacement(
            target.parent().unwrap(),
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
        let error = string_replacement(target.parent().unwrap(), &target, "sample.ts", &stale)
            .unwrap_err()
            .to_string();
        assert!(error.contains("changed on disk"), "{error}");

        let no_op = arguments("one", "one", false);
        let error = string_replacement(target.parent().unwrap(), &target, "sample.ts", &no_op)
            .unwrap_err()
            .to_string();
        assert!(error.contains("identical"), "{error}");
    }

    #[test]
    fn missing_file_requires_explicit_creation_and_keeps_existing_paths_distinct() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path();
        fs::create_dir(workspace.join("src")).unwrap();
        fs::write(workspace.join("test.mjs"), "original\n").unwrap();
        let target = workspace.join("src/test.mjs");
        for arguments in [json!({}), json!({"createIfMissing":false})] {
            let error = require_creation_intent(workspace, &target, "src/test.mjs", &arguments)
                .unwrap_err()
                .to_string();
            assert!(error.contains("no proposal was created"));
            assert!(error.contains("createIfMissing: true"));
            assert!(error.contains("workspace root: \"test.mjs\""));
        }
        require_creation_intent(
            workspace,
            &target,
            "src/test.mjs",
            &json!({"createIfMissing":true}),
        )
        .unwrap();
        assert!(
            !target.exists(),
            "validation must not create a file or apply an approval"
        );
        assert_eq!(
            fs::read_to_string(workspace.join("test.mjs")).unwrap(),
            "original\n"
        );
        require_creation_intent(
            workspace,
            &workspace.join("test.mjs"),
            "test.mjs",
            &json!({}),
        )
        .unwrap();
    }

    #[test]
    fn missing_file_is_rejected_with_the_create_tool_named() {
        let temp = tempfile::tempdir().unwrap();
        let error = string_replacement(
            &temp.path().canonicalize().unwrap(),
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

    #[test]
    fn editor_document_version_rejects_changed_or_missing_buffers() {
        let mut context = WorkspaceContextSnapshot::empty("/tmp/workspace");
        context.buffers = vec![json!({"path":"src/main.rs", "documentVersion":"v2"})];
        check_editor_document_version(&context, "src/main.rs", "v2").unwrap();
        let stale = check_editor_document_version(&context, "src/main.rs", "v1")
            .unwrap_err()
            .to_string();
        assert!(stale.contains("Editor document version changed"));
        assert!(stale.contains("gyro_workspace_read_editor"));
        let missing = check_editor_document_version(&context, "src/other.rs", "v2")
            .unwrap_err()
            .to_string();
        assert!(missing.contains("No live editor version is available"));
        assert!(missing.contains("use its contentHash as expectedHash"));
        assert!(missing.contains("omit documentVersion"));
    }

    fn session_for(dir: &std::path::Path) -> (SessionStore, String) {
        let store = SessionStore::open(GyroPaths::from_base_dir(dir.join("Gyro"))).unwrap();
        let session = store
            .create_session(dir, SessionOrigin::Desktop, "edit")
            .unwrap();
        (store, session.id.to_string())
    }

    #[test]
    fn immediate_edits_reject_a_sibling_that_moved_the_read_hash() {
        let temp = tempfile::tempdir().unwrap();
        let (store, session_id) = session_for(temp.path());
        let target = temp.path().canonicalize().unwrap().join("sample.ts");
        let original = "alpha\nbeta\n";
        fs::write(&target, original).unwrap();
        let hash = content_hash(original.as_bytes());
        let first = commit_string_edit(
            &store,
            &session_id,
            None,
            None,
            target.parent().unwrap(),
            &target,
            "sample.ts",
            &json!({
                "oldString": "alpha",
                "newString": "ALPHA",
                "expectedHash": hash
            }),
            true,
        )
        .unwrap();
        assert_eq!(first.proposal.status.as_str(), "applied");
        let second = commit_string_edit(
            &store,
            &session_id,
            None,
            None,
            target.parent().unwrap(),
            &target,
            "sample.ts",
            &json!({
                "oldString": "beta",
                "newString": "BETA",
                "expectedHash": hash
            }),
            true,
        )
        .unwrap_err();
        assert!(second.to_string().contains("changed on disk"));
        assert_eq!(fs::read_to_string(&target).unwrap(), "ALPHA\nbeta\n");
    }

    #[test]
    fn reviewed_edit_still_rejects_a_stale_hash() {
        let temp = tempfile::tempdir().unwrap();
        let (store, session_id) = session_for(temp.path());
        let target = temp.path().canonicalize().unwrap().join("sample.ts");
        fs::write(&target, "alpha\n").unwrap();
        let error = commit_string_edit(
            &store,
            &session_id,
            None,
            None,
            target.parent().unwrap(),
            &target,
            "sample.ts",
            &json!({
                "oldString": "alpha",
                "newString": "BETA",
                "expectedHash": content_hash(b"other")
            }),
            false,
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("changed on disk"), "{error}");
        assert_eq!(fs::read_to_string(&target).unwrap(), "alpha\n");
    }

    #[test]
    fn immediate_edit_stops_when_the_matched_text_is_gone() {
        let temp = tempfile::tempdir().unwrap();
        let (store, session_id) = session_for(temp.path());
        let target = temp.path().canonicalize().unwrap().join("sample.ts");
        fs::write(&target, "alpha\n").unwrap();
        let error = commit_string_edit(
            &store,
            &session_id,
            None,
            None,
            target.parent().unwrap(),
            &target,
            "sample.ts",
            &json!({
                "oldString": "before",
                "newString": "after",
                "expectedHash": content_hash(b"alpha\n")
            }),
            true,
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("was not found"), "{error}");
        assert_eq!(fs::read_to_string(&target).unwrap(), "alpha\n");
    }
}
