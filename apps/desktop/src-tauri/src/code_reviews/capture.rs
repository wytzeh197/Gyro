use crate::features::scope::root_scope;
use crate::git::read as git_read;
use anyhow::{ensure, Result};
use gyro_core::{
    code_reviews::{
        build_snapshot, reconstruct_recorded_original, write_snapshot, CapturedReviewFile,
        ReviewExclusion, ReviewScope, ReviewSnapshot, SnapshotInput, MAX_REVIEW_FILES,
        MAX_REVIEW_SIDE_BYTES,
    },
    mutations::content_hash,
    MutationProposalStatus, SessionEventKind, SessionStore,
};
use std::{
    collections::{BTreeMap, HashSet},
    path::Path,
    time::{Duration, Instant},
};
use uuid::Uuid;

use super::git_capture::{collect, path_allowed};
pub(super) use super::git_capture::{git, head_oid, manifest, oid};
fn turn_files(
    store: &SessionStore,
    session: Uuid,
    turn: Uuid,
    root: &Path,
    events: &[gyro_core::SessionEvent],
    selected: &HashSet<String>,
) -> Result<(Vec<CapturedReviewFile>, Vec<ReviewExclusion>)> {
    let mut files: BTreeMap<String, CapturedReviewFile> = BTreeMap::new();
    let mut excluded: BTreeMap<String, String> = BTreeMap::new();
    for event in events.iter().filter(|event| event.turn_id == Some(turn)) {
        let Some(changes) = event.payload["fileChanges"].as_array() else {
            continue;
        };
        for change in changes {
            let Some(path) = change["path"].as_str() else {
                continue;
            };
            if !selected.is_empty() && !selected.contains(path) {
                continue;
            }
            let captured = (|| -> Result<CapturedReviewFile> {
                ensure!(path_allowed(path), "sensitive or unsupported file path");
                let proposal_id=event.payload["proposalId"].as_str().ok_or_else(||anyhow::anyhow!("complete historical file content is unavailable; current disk content was not substituted"))?.parse()?;
                let proposal = store
                    .get_mutation_proposal(proposal_id)?
                    .ok_or_else(|| anyhow::anyhow!("historical proposal is unavailable"))?;
                ensure!(
                    proposal.session_id == session
                        && proposal.turn_id == Some(turn)
                        && proposal.workspace_path.canonicalize()? == root
                        && proposal.path == path
                        && proposal.status == MutationProposalStatus::Applied,
                    "historical mutation does not belong to the selected source"
                );
                let patch = change["patch"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("complete historical patch is unavailable"))?;
                let original = reconstruct_recorded_original(
                    &proposal.content,
                    patch,
                    proposal.expected_hash.as_deref(),
                )?;
                ensure!(
                    proposal.content.len() <= MAX_REVIEW_SIDE_BYTES
                        && original
                            .as_ref()
                            .is_none_or(|text| text.len() <= MAX_REVIEW_SIDE_BYTES),
                    "historical file exceeds its size limit"
                );
                for side in original.iter().chain(std::iter::once(&proposal.content)) {
                    ensure!(
                        gyro_core::security::redact_secrets(side) == *side && !side.contains('\0'),
                        "sensitive or binary historical content is excluded"
                    );
                }
                let (original, original_hash) = if let Some(first) = files.get(path) {
                    (first.original.clone(), first.original_hash.clone())
                } else {
                    (original, proposal.expected_hash)
                };
                Ok(CapturedReviewFile {
                    // Historic mutation records did not record executable bits.
                    original_mode: None,
                    modified_mode: None,
                    path: path.into(),
                    original_path: None,
                    original,
                    original_hash,
                    modified_hash: Some(content_hash(proposal.content.as_bytes())),
                    modified: Some(proposal.content),
                    status: "recorded-turn".into(),
                    staged: false,
                })
            })();
            match captured {
                Ok(file) => {
                    if !excluded.contains_key(path) {
                        files.insert(path.into(), file);
                    }
                }
                Err(error) => {
                    files.remove(path);
                    excluded.insert(
                        path.into(),
                        gyro_core::sanitize_capability_summary(&error.to_string()),
                    );
                }
            }
        }
    }
    ensure!(
        files.len() + excluded.len() <= MAX_REVIEW_FILES,
        "turn scope exceeds 64 files; narrow the file scope"
    );
    Ok((
        files.into_values().collect(),
        excluded
            .into_iter()
            .map(|(path, reason)| ReviewExclusion { path, reason })
            .collect(),
    ))
}

pub(crate) fn capture(
    store: &SessionStore,
    session_id: &str,
    root_id: Option<&str>,
    scope: ReviewScope,
    selected_paths: Vec<String>,
    brief: Option<String>,
    context_window: Option<u64>,
    previous_review_id: Option<Uuid>,
) -> Result<ReviewSnapshot> {
    let (session, root_id, root) = root_scope(store, session_id, root_id)?;
    let previous_findings = if let Some(id) = previous_review_id {
        let previous = store
            .code_review(id)?
            .ok_or_else(|| anyhow::anyhow!("previous review is unavailable"))?;
        ensure!(
            previous.source_session_id == session.id
                && previous.root_id == root_id
                && previous.status.terminal(),
            "previous review is unavailable for this source"
        );
        previous.findings
    } else {
        vec![]
    };
    ensure!(
        selected_paths.len() <= 64 && selected_paths.iter().all(|path| path_allowed(path)),
        "invalid selected review paths"
    );
    let selected: HashSet<_> = selected_paths.into_iter().collect();
    let private = store.paths().base_dir.canonicalize()?;
    ensure!(
        selected
            .iter()
            .all(|path| !root.join(path).starts_with(&private)),
        "Gyro private data is outside review scope"
    );
    let events = store.read_events(session.id)?;
    let source_turn = if let ReviewScope::Turn { turn_id } = scope {
        Some(turn_id)
    } else {
        None
    };
    let original_request = events.iter().rev().find(|event| {
        event.kind == SessionEventKind::UserMessage
            && source_turn.is_none_or(|turn| event.turn_id == Some(turn))
    });
    if let Some(turn) = source_turn {
        ensure!(
            original_request.is_some(),
            "complete turn history is outside the available bounded history"
        );
        ensure!(
            store
                .latest_provider_status_for_turn(session.id, turn)?
                .as_deref()
                != Some("running"),
            "wait for this turn to finish before capturing a historical review"
        );
    }
    let request = brief
        .filter(|brief| !brief.trim().is_empty())
        .or_else(|| original_request.map(|event| event.message.clone()))
        .ok_or_else(|| anyhow::anyhow!("Provide a review brief before capturing changes"))?;
    let request = gyro_core::security::redact_secrets(&request);
    let mut memory_session = session.clone();
    memory_session
        .workspace_identity
        .roots
        .retain(|candidate| candidate.id == root_id);
    memory_session.workspace_identity.active_root_id = root_id.clone();
    let mut memory_request: gyro_core::provider_runtime::types::ProviderChatRequest =
        serde_json::from_value(
            serde_json::json!({"sessionId":session.id,"providerId":"snapshot-context","message":request}),
        )?;
    memory_request.goal = crate::session_goal::stored_or_unsaved_goal(&events, None);
    let memory = gyro_core::project_memory::prepare_memory_context(
        store,
        &memory_session,
        &memory_request,
        context_window,
    )?;
    let (mut context, memory_receipt) = memory.render(false);
    if let Some(goal) = &memory_request.goal {
        context.push_str(&format!("\nCaptured goal (reference): {}", goal.text));
    }
    context = gyro_core::security::redact_secrets(&context);
    let deadline = Instant::now() + Duration::from_secs(30);
    let (base, head, files, exclusions, witness_before, witness_after) = if let Some(turn) =
        source_turn
    {
        let (files, exclusions) = turn_files(store, session.id, turn, &root, &events, &selected)?;
        let witness = content_hash(&serde_json::to_vec(&(&files, &exclusions))?);
        (None, None, files, exclusions, witness.clone(), witness)
    } else {
        ensure!(
            git_read::repo_root(&root, deadline)?.as_deref() == Some(root.as_path()),
            "Select the Git repository root for working-tree or branch review"
        );
        let head = head_oid(&root, deadline)?;
        let base = if let ReviewScope::Branch { base } = &scope {
            gyro_core::validate_branch_name(base)?;
            let base_oid = oid(&root, base, deadline)?;
            let head_oid = head
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("branch has no committed tip"))?;
            Some(
                git(&root, &["merge-base", &base_oid, head_oid], deadline, 1024)?
                    .trim()
                    .to_string(),
            )
        } else {
            head.clone()
        };
        let (files, exclusions) = collect(
            &root,
            &scope,
            base.as_deref(),
            head.as_deref(),
            &selected,
            &private,
            deadline,
        )?;
        let witness_before = content_hash(&serde_json::to_vec(&(&files, &exclusions))?);
        let (verify_files, verify_exclusions) = collect(
            &root,
            &scope,
            base.as_deref(),
            head.as_deref(),
            &selected,
            &private,
            deadline,
        )?;
        ensure!(
            head_oid(&root, deadline)? == head,
            "Capture changed; retry capture"
        );
        let witness_after =
            content_hash(&serde_json::to_vec(&(&verify_files, &verify_exclusions))?);
        (base, head, files, exclusions, witness_before, witness_after)
    };
    ensure!(
        !files.is_empty() || !exclusions.is_empty(),
        "No changes in the selected scope"
    );
    let snapshot = build_snapshot(SnapshotInput {
        previous_review_id,
        previous_findings,
        selected_paths: {
            let mut paths: Vec<_> = selected.into_iter().collect();
            paths.sort();
            paths
        },
        source_session_id: session.id,
        source_turn_id: source_turn,
        root_id,
        root_key: root.to_string_lossy().into_owned(),
        scope,
        base_oid: base,
        head_oid: head,
        request,
        context,
        memory_receipt: Some(memory_receipt),
        files,
        exclusions,
        witness_before,
        witness_after,
    })?;
    write_snapshot(store.paths(), &snapshot)?;
    if let Err(error) = store.register_code_review_capture(&snapshot) {
        let _ = gyro_core::code_reviews::delete_snapshot_artifact(store.paths(), snapshot.id);
        return Err(error);
    }
    Ok(snapshot)
}
