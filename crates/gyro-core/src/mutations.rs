use crate::diff::{summarize_text_diff, TextDiff};
use crate::security::assert_path_inside_workspace;
use crate::sessions::{
    MutationProposal, MutationProposalStatus, SessionEvent, SessionEventKind, SessionStore,
};
use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::fd::AsRawFd;
use std::path::{Component, Path, PathBuf};
use uuid::Uuid;

#[derive(Debug)]
struct MutationDecisionCancelled;

impl std::fmt::Display for MutationDecisionCancelled {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("mutation decision cancelled before the file was replaced")
    }
}

impl std::error::Error for MutationDecisionCancelled {}

const MUTATION_APPROVAL_TTL_HOURS: i64 = 24;
const MAX_PROVIDER_MUTATION_FILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_PROVIDER_MUTATION_TOTAL_BYTES: usize = 8 * 1024 * 1024;
const PROVIDER_MUTATION_JOURNAL_SCHEMA: &str = "gyro.provider-mutation-journal.v1";
const MAX_PROVIDER_MUTATION_JOURNAL_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MutationDecision {
    Approve,
    Reject,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationReview {
    pub proposal: MutationProposal,
    pub diff: TextDiff,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationDecisionResult {
    pub proposal: MutationProposal,
    pub event: SessionEvent,
    pub changed_path: Option<PathBuf>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderFileChange {
    pub path: String,
    pub kind: ProviderFileChangeKind,
    #[serde(default)]
    pub diff: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderFileChangeKind {
    #[serde(rename = "type")]
    pub change_type: String,
    #[serde(default)]
    pub move_path: Option<String>,
}

#[derive(Clone, Debug)]
pub struct PreparedProviderMutationTransaction {
    workspace_path: PathBuf,
    changes: Vec<PreparedProviderMutation>,
}

#[derive(Clone, Debug)]
struct PreparedProviderMutation {
    relative_path: String,
    target: PathBuf,
    expected_hash: Option<String>,
    desired_content: Option<Vec<u8>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderMutationResult {
    pub changed_paths: Vec<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderMutationRecoveryReport {
    pub rolled_back: usize,
    pub finalized: usize,
    pub quarantined: usize,
    pub reconciled_proposals: usize,
    pub skipped: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProviderMutationJournalContext {
    pub session_id: Uuid,
    pub approval_id: Uuid,
}

#[derive(Debug)]
pub struct PendingProviderMutationCommit {
    result: ProviderMutationResult,
    journal_path: PathBuf,
    journal: ProviderMutationJournal,
    _lock: ProviderMutationRecoveryLock,
}

impl PendingProviderMutationCommit {
    pub fn result(&self) -> &ProviderMutationResult {
        &self.result
    }

    pub fn finalize(self) -> Result<ProviderMutationResult> {
        finalize_provider_mutation_journal(&self.journal)?;
        remove_provider_mutation_journal(&self.journal_path)?;
        Ok(self.result)
    }

    pub fn rollback(self) -> Result<()> {
        rollback_provider_mutation_journal(&self.journal)?;
        remove_provider_mutation_journal(&self.journal_path)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderMutationJournal {
    schema: String,
    id: Uuid,
    created_at: DateTime<Utc>,
    session_id: Uuid,
    approval_id: Uuid,
    workspace_path: PathBuf,
    entries: Vec<ProviderMutationJournalEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderMutationJournalEntry {
    relative_path: String,
    target: PathBuf,
    stage: Option<PathBuf>,
    backup: Option<PathBuf>,
    original_hash: Option<String>,
    desired_hash: Option<String>,
}

#[derive(Debug)]
struct ProviderMutationRecoveryLock {
    _file: fs::File,
}

pub fn review_mutation_proposal(proposal: MutationProposal) -> Result<MutationReview> {
    let original = read_original_content(&proposal)?;
    let diff = summarize_text_diff(&original, &proposal.content);
    Ok(MutationReview { proposal, diff })
}

pub fn decide_mutation_proposal(
    store: &SessionStore,
    proposal_id: Uuid,
    decision: MutationDecision,
) -> Result<MutationDecisionResult> {
    decide_mutation_proposal_with_cancellation(store, proposal_id, decision, || false)
}

pub fn decide_mutation_proposal_with_cancellation<F>(
    store: &SessionStore,
    proposal_id: Uuid,
    decision: MutationDecision,
    mut is_cancelled: F,
) -> Result<MutationDecisionResult>
where
    F: FnMut() -> bool,
{
    ensure_mutation_not_cancelled(&mut is_cancelled)?;
    let _mutation_lock =
        acquire_provider_mutation_lock_blocking(&store.paths().mutation_journals_dir)?;
    let proposal = store
        .get_mutation_proposal(proposal_id)?
        .ok_or_else(|| anyhow!("unknown mutation proposal {proposal_id}"))?;
    let proposal = if proposal.status == MutationProposalStatus::Applying {
        reconcile_claimed_mutation_proposal(store, proposal)?
    } else {
        proposal
    };

    match decision {
        MutationDecision::Reject => {
            let proposal = store.resolve_mutation_proposal_status(
                proposal_id,
                MutationProposalStatus::Rejected,
                None,
            )?;
            let event = append_mutation_decision_event(store, &proposal, None)?;
            Ok(MutationDecisionResult {
                proposal,
                event,
                changed_path: None,
            })
        }
        MutationDecision::Approve => {
            if proposal.status == MutationProposalStatus::Applied {
                let event = append_mutation_decision_event(store, &proposal, None)?;
                return Ok(MutationDecisionResult {
                    changed_path: Some(workspace_file_target(&proposal)?),
                    proposal,
                    event,
                });
            }
            if proposal.status != MutationProposalStatus::Pending {
                return Err(anyhow!(
                    "mutation proposal is already {}",
                    proposal.status.as_str()
                ));
            }
            if mutation_approval_expired(proposal.created_at, Utc::now()) {
                let detail = "approval expired; review a new proposal".to_string();
                let proposal = store.resolve_mutation_proposal_status(
                    proposal_id,
                    MutationProposalStatus::Failed,
                    Some(detail.clone()),
                )?;
                let _event =
                    append_mutation_decision_event(store, &proposal, Some(detail.clone()))?;
                return Err(anyhow!("could not apply {}: {detail}", proposal.path));
            }

            let proposal = store.claim_mutation_proposal(proposal_id)?;
            match apply_mutation_proposal(&proposal, &mut is_cancelled) {
                Ok(changed_path) => {
                    let proposal = store.finish_claimed_mutation_proposal(
                        proposal_id,
                        MutationProposalStatus::Applied,
                        None,
                    )?;
                    let event = append_mutation_decision_event(store, &proposal, None)?;
                    Ok(MutationDecisionResult {
                        proposal,
                        event,
                        changed_path: Some(changed_path),
                    })
                }
                Err(error) => {
                    let cancelled = mutation_decision_was_cancelled(&error);
                    let detail = error.to_string();
                    let proposal = store.finish_claimed_mutation_proposal(
                        proposal_id,
                        MutationProposalStatus::Failed,
                        Some(detail.clone()),
                    )?;
                    let _event =
                        append_mutation_decision_event(store, &proposal, Some(detail.clone()))?;
                    if cancelled {
                        return Err(error);
                    }
                    Err(anyhow!("could not apply {}: {detail}", proposal.path))
                }
            }
        }
    }
}

pub fn mutation_decision_was_cancelled(error: &anyhow::Error) -> bool {
    error.downcast_ref::<MutationDecisionCancelled>().is_some()
}

fn mutation_approval_expired(created_at: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    now.signed_duration_since(created_at) > Duration::hours(MUTATION_APPROVAL_TTL_HOURS)
}

pub fn mutation_approval_payload(
    proposal: &MutationProposal,
    error: Option<String>,
) -> serde_json::Value {
    serde_json::json!({
        "schema": "gyro.mutation.v1",
        "kind": "mutation-approval",
        "proposalId": proposal.id,
        "turnId": proposal.turn_id,
        "operation": proposal.operation,
        "path": proposal.path,
        "scope": "workspace-file",
        "risk": "Writes one file inside the selected project",
        "effect": match proposal.operation {
            crate::sessions::MutationProposalOperation::Create => "Create this file on disk",
            crate::sessions::MutationProposalOperation::Update => "Replace this file with the reviewed content",
        },
        "status": proposal.status.as_str(),
        "error": error.or_else(|| proposal.error.clone()),
    })
}

fn append_mutation_decision_event(
    store: &SessionStore,
    proposal: &MutationProposal,
    error: Option<String>,
) -> Result<SessionEvent> {
    store.append_event_with_turn_id(
        proposal.session_id,
        SessionEventKind::SystemEvent,
        match proposal.status {
            MutationProposalStatus::Applied => format!("Applied {}", proposal.path),
            MutationProposalStatus::Rejected => format!("Rejected changes to {}", proposal.path),
            MutationProposalStatus::Failed => format!("Could not apply {}", proposal.path),
            MutationProposalStatus::Applying => format!("Applying {}", proposal.path),
            MutationProposalStatus::Pending => format!("Review changes to {}", proposal.path),
        },
        mutation_approval_payload(proposal, error),
        proposal.turn_id,
    )
}

fn read_original_content(proposal: &MutationProposal) -> Result<String> {
    if !proposal.base_exists {
        return Ok(String::new());
    }
    let candidate = workspace_file_target(proposal)?;
    let bytes = read_bounded_mutation_file(
        &candidate,
        MAX_PROVIDER_MUTATION_FILE_BYTES,
        "mutation target",
    )?;
    if bytes.contains(&0) {
        return Err(anyhow!("mutation target is a binary file"));
    }
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

fn reconcile_claimed_mutation_proposal(
    store: &SessionStore,
    proposal: MutationProposal,
) -> Result<MutationProposal> {
    let target = workspace_file_target(&proposal)?;
    let desired_hash = content_hash(proposal.content.as_bytes());
    let applied = target.is_file()
        && read_bounded_mutation_file(
            &target,
            MAX_PROVIDER_MUTATION_FILE_BYTES,
            "claimed mutation target",
        )
        .is_ok_and(|bytes| content_hash(&bytes) == desired_hash);
    if applied {
        store.finish_claimed_mutation_proposal(proposal.id, MutationProposalStatus::Applied, None)
    } else {
        store.finish_claimed_mutation_proposal(
            proposal.id,
            MutationProposalStatus::Failed,
            Some("mutation application was interrupted; review the current file state".into()),
        )
    }
}

fn recover_claimed_mutation_proposals(store: &SessionStore) -> Result<usize> {
    let proposals = store.list_applying_mutation_proposals()?;
    let mut recovered = 0usize;
    for proposal in proposals {
        let proposal = reconcile_claimed_mutation_proposal(store, proposal)?;
        let detail = proposal.error.clone();
        let _ = append_mutation_decision_event(store, &proposal, detail);
        recovered += 1;
    }
    Ok(recovered)
}

fn apply_mutation_proposal<F>(proposal: &MutationProposal, is_cancelled: &mut F) -> Result<PathBuf>
where
    F: FnMut() -> bool,
{
    ensure_mutation_not_cancelled(is_cancelled)?;
    let candidate = workspace_file_target(proposal)?;
    let desired_hash = content_hash(proposal.content.as_bytes());
    if candidate.exists() {
        if candidate.is_dir() {
            return Err(anyhow!("mutation target became a directory"));
        }
        let current = read_bounded_mutation_file(
            &candidate,
            MAX_PROVIDER_MUTATION_FILE_BYTES,
            "mutation target",
        )?;
        if current.contains(&0) {
            return Err(anyhow!("mutation target became a binary file"));
        }
        let current_hash = content_hash(&current);
        if current_hash == desired_hash {
            ensure_mutation_not_cancelled(is_cancelled)?;
            return Ok(candidate);
        }
        if !proposal.base_exists {
            return Err(anyhow!("a file now exists at the approved create path"));
        }
        if proposal.expected_hash.as_deref() != Some(current_hash.as_str()) {
            return Err(anyhow!(
                "file changed after approval was requested; review a new proposal"
            ));
        }
    } else if proposal.base_exists {
        return Err(anyhow!(
            "file was removed after approval was requested; review a new proposal"
        ));
    }

    atomic_write_workspace_file(&candidate, proposal.content.as_bytes(), is_cancelled)?;
    Ok(candidate)
}

fn ensure_mutation_not_cancelled<F>(is_cancelled: &mut F) -> Result<()>
where
    F: FnMut() -> bool,
{
    if is_cancelled() {
        Err(MutationDecisionCancelled.into())
    } else {
        Ok(())
    }
}

fn workspace_file_target(proposal: &MutationProposal) -> Result<PathBuf> {
    let root = proposal.workspace_path.canonicalize().with_context(|| {
        format!(
            "resolve proposal workspace {}",
            proposal.workspace_path.display()
        )
    })?;
    let candidate = assert_path_inside_workspace(&root, Path::new(&proposal.path))?;
    let parent = candidate
        .parent()
        .ok_or_else(|| anyhow!("workspace file path has no parent"))?;
    let resolved_parent = parent
        .canonicalize()
        .map_err(|_| anyhow!("workspace file parent does not exist"))?;
    if !resolved_parent.starts_with(&root) {
        return Err(anyhow!(
            "workspace file parent resolves outside the workspace"
        ));
    }
    Ok(resolved_parent.join(
        candidate
            .file_name()
            .ok_or_else(|| anyhow!("workspace file path has no file name"))?,
    ))
}

fn atomic_write_workspace_file<F>(path: &Path, content: &[u8], is_cancelled: &mut F) -> Result<()>
where
    F: FnMut() -> bool,
{
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("workspace file path has no parent"))?;
    let temporary = parent.join(format!(
        ".gyro-{}-{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("mutation"),
        Uuid::new_v4()
    ));
    let result = (|| -> Result<()> {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        if let Ok(metadata) = fs::metadata(path) {
            file.set_permissions(metadata.permissions())?;
        }
        for chunk in content.chunks(64 * 1024) {
            ensure_mutation_not_cancelled(is_cancelled)?;
            file.write_all(chunk)?;
        }
        file.flush()?;
        file.sync_all()?;
        ensure_mutation_not_cancelled(is_cancelled)?;
        fs::rename(&temporary, path)?;
        fs::File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn content_hash(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn prepare_provider_mutation_transaction(
    workspace: &Path,
    changes: &[ProviderFileChange],
) -> Result<PreparedProviderMutationTransaction> {
    if changes.is_empty() {
        return Err(anyhow!(
            "provider file approval did not include any changes"
        ));
    }
    let workspace_path = workspace
        .canonicalize()
        .with_context(|| format!("resolve provider workspace {}", workspace.display()))?;
    let mut prepared = Vec::new();
    let mut destinations = HashSet::new();
    let mut total_bytes = 0usize;

    for change in changes {
        let source = provider_mutation_target(&workspace_path, &change.path)?;
        let source_relative = provider_relative_path(&workspace_path, &source)?;
        match change.kind.change_type.as_str() {
            "add" | "create" => {
                if source.exists() {
                    return Err(anyhow!(
                        "provider create target {source_relative} already exists"
                    ));
                }
                ensure_provider_text(change.diff.as_bytes(), &source_relative)?;
                total_bytes = total_bytes.saturating_add(change.diff.len());
                push_provider_mutation(
                    &mut prepared,
                    &mut destinations,
                    source_relative,
                    source,
                    None,
                    Some(change.diff.as_bytes().to_vec()),
                )?;
            }
            "update" => {
                let current = read_provider_mutation_file(&source, &source_relative)?;
                let expected_hash = content_hash(&current);
                let desired =
                    apply_provider_unified_diff(&source_relative, &current, change.diff.as_str())?;
                ensure_provider_text(&desired, &source_relative)?;
                total_bytes = total_bytes.saturating_add(desired.len());
                if let Some(move_path) = change
                    .kind
                    .move_path
                    .as_deref()
                    .map(str::trim)
                    .filter(|path| !path.is_empty())
                {
                    let destination = provider_mutation_target(&workspace_path, move_path)?;
                    let destination_relative =
                        provider_relative_path(&workspace_path, &destination)?;
                    if destination.exists() {
                        return Err(anyhow!(
                            "provider move destination {destination_relative} already exists"
                        ));
                    }
                    push_provider_mutation(
                        &mut prepared,
                        &mut destinations,
                        source_relative,
                        source,
                        Some(expected_hash),
                        None,
                    )?;
                    push_provider_mutation(
                        &mut prepared,
                        &mut destinations,
                        destination_relative,
                        destination,
                        None,
                        Some(desired),
                    )?;
                } else {
                    push_provider_mutation(
                        &mut prepared,
                        &mut destinations,
                        source_relative,
                        source,
                        Some(expected_hash),
                        Some(desired),
                    )?;
                }
            }
            "delete" | "remove" => {
                let current = read_provider_mutation_file(&source, &source_relative)?;
                push_provider_mutation(
                    &mut prepared,
                    &mut destinations,
                    source_relative,
                    source,
                    Some(content_hash(&current)),
                    None,
                )?;
            }
            other => return Err(anyhow!("unsupported provider file change type {other}")),
        }
        if total_bytes > MAX_PROVIDER_MUTATION_TOTAL_BYTES {
            return Err(anyhow!(
                "provider file approval exceeds the {} MiB transaction limit",
                MAX_PROVIDER_MUTATION_TOTAL_BYTES / (1024 * 1024)
            ));
        }
    }

    Ok(PreparedProviderMutationTransaction {
        workspace_path,
        changes: prepared,
    })
}

pub fn prepare_provider_text_replacement_transaction(
    workspace: &Path,
    target: &Path,
    desired: &str,
) -> Result<PreparedProviderMutationTransaction> {
    let workspace_path = workspace
        .canonicalize()
        .with_context(|| format!("resolve provider workspace {}", workspace.display()))?;
    let relative_path = provider_relative_path(&workspace_path, target)?;
    let change = if target.exists() {
        let current = read_provider_mutation_file(target, &relative_path)?;
        let current = String::from_utf8(current)
            .with_context(|| format!("read provider mutation target {relative_path} as UTF-8"))?;
        ProviderFileChange {
            path: relative_path,
            kind: ProviderFileChangeKind {
                change_type: "update".into(),
                move_path: None,
            },
            diff: diffy::create_patch(&current, desired).to_string(),
        }
    } else {
        ProviderFileChange {
            path: relative_path,
            kind: ProviderFileChangeKind {
                change_type: "create".into(),
                move_path: None,
            },
            diff: desired.to_string(),
        }
    };
    prepare_provider_mutation_transaction(&workspace_path, &[change])
}

pub fn prepare_claude_provider_mutation_transaction(
    workspace: &Path,
    tool_name: &str,
    input: &serde_json::Value,
) -> Result<PreparedProviderMutationTransaction> {
    let changes = provider_changes_from_claude_tool(workspace, tool_name, input)?;
    prepare_provider_mutation_transaction(workspace, &changes)
}

fn provider_changes_from_claude_tool(
    workspace: &Path,
    tool_name: &str,
    input: &serde_json::Value,
) -> Result<Vec<ProviderFileChange>> {
    let path = input
        .get("file_path")
        .or_else(|| input.get("filePath"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| anyhow!("Claude file approval did not include a file path"))?;
    let workspace = workspace
        .canonicalize()
        .with_context(|| format!("resolve Claude workspace {}", workspace.display()))?;
    let target = provider_mutation_target(&workspace, path)?;
    let relative_path = provider_relative_path(&workspace, &target)?;
    let (change_type, diff) = match tool_name {
        "Write" => {
            let desired = input
                .get("content")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| anyhow!("Claude Write approval did not include content"))?;
            if target.exists() {
                let current = read_claude_edit_target(&target, &relative_path)?;
                ("update", diffy::create_patch(&current, desired).to_string())
            } else {
                ("add", desired.to_string())
            }
        }
        "Edit" => {
            let current = read_claude_edit_target(&target, &relative_path)?;
            let desired = apply_claude_text_edit(&current, input)?;
            (
                "update",
                diffy::create_patch(&current, &desired).to_string(),
            )
        }
        "MultiEdit" => {
            let current = read_claude_edit_target(&target, &relative_path)?;
            let edits = input
                .get("edits")
                .and_then(serde_json::Value::as_array)
                .ok_or_else(|| anyhow!("Claude MultiEdit approval did not include edits"))?;
            if edits.is_empty() {
                return Err(anyhow!(
                    "Claude MultiEdit approval did not include any edits"
                ));
            }
            let mut desired = current.clone();
            for edit in edits {
                desired = apply_claude_text_edit(&desired, edit)?;
            }
            (
                "update",
                diffy::create_patch(&current, &desired).to_string(),
            )
        }
        "NotebookEdit" => {
            return Err(anyhow!(
                "Claude notebook edits are not supported by Gyro's text transaction"
            ))
        }
        other => return Err(anyhow!("unsupported Claude file tool {other}")),
    };
    Ok(vec![ProviderFileChange {
        path: relative_path,
        kind: ProviderFileChangeKind {
            change_type: change_type.into(),
            move_path: None,
        },
        diff,
    }])
}

fn read_claude_edit_target(path: &Path, relative_path: &str) -> Result<String> {
    let bytes = read_provider_mutation_file(path, relative_path)?;
    String::from_utf8(bytes)
        .with_context(|| format!("Claude edit target {relative_path} is not a UTF-8 text file"))
}

fn apply_claude_text_edit(current: &str, edit: &serde_json::Value) -> Result<String> {
    let old = edit
        .get("old_string")
        .or_else(|| edit.get("oldString"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| anyhow!("Claude Edit approval did not include old_string"))?;
    let new = edit
        .get("new_string")
        .or_else(|| edit.get("newString"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| anyhow!("Claude Edit approval did not include new_string"))?;
    if old.is_empty() {
        return Err(anyhow!("Claude Edit old_string may not be empty"));
    }
    let replace_all = edit
        .get("replace_all")
        .or_else(|| edit.get("replaceAll"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let matches = current.match_indices(old).count();
    if matches == 0 {
        return Err(anyhow!("Claude Edit target changed before approval"));
    }
    if !replace_all && matches != 1 {
        return Err(anyhow!(
            "Claude Edit old_string is not unique; use replace_all or provide more context"
        ));
    }
    if replace_all {
        Ok(current.replace(old, new))
    } else {
        Ok(current.replacen(old, new, 1))
    }
}

pub fn apply_provider_mutation_transaction(
    transaction: &PreparedProviderMutationTransaction,
) -> Result<ProviderMutationResult> {
    apply_provider_mutation_transaction_with_cancellation(transaction, || false)
}

pub fn apply_provider_mutation_transaction_with_cancellation<F>(
    transaction: &PreparedProviderMutationTransaction,
    mut is_cancelled: F,
) -> Result<ProviderMutationResult>
where
    F: FnMut() -> bool,
{
    validate_provider_mutation_transaction(transaction, &mut is_cancelled)?;
    let staged = stage_provider_mutation_transaction(transaction, &mut is_cancelled)?;
    let backups = provider_mutation_backup_paths(transaction);
    commit_provider_mutation_transaction(transaction, &staged, &backups, &mut is_cancelled)?;
    for backup in backups.iter().flatten() {
        let _ = fs::remove_file(backup);
    }
    let _ = sync_provider_mutation_parents(transaction);
    Ok(provider_mutation_result(transaction))
}

pub fn begin_provider_mutation_transaction(
    transaction: &PreparedProviderMutationTransaction,
    journal_dir: &Path,
    context: ProviderMutationJournalContext,
) -> Result<PendingProviderMutationCommit> {
    begin_provider_mutation_transaction_with_cancellation(transaction, journal_dir, context, || {
        false
    })
}

pub fn begin_provider_mutation_transaction_with_cancellation<F>(
    transaction: &PreparedProviderMutationTransaction,
    journal_dir: &Path,
    context: ProviderMutationJournalContext,
    mut is_cancelled: F,
) -> Result<PendingProviderMutationCommit>
where
    F: FnMut() -> bool,
{
    let mutation_lock = acquire_provider_mutation_lock_blocking(journal_dir)?;
    validate_provider_mutation_transaction(transaction, &mut is_cancelled)?;
    let staged = stage_provider_mutation_transaction(transaction, &mut is_cancelled)?;
    let backups = provider_mutation_backup_paths(transaction);
    let journal = ProviderMutationJournal {
        schema: PROVIDER_MUTATION_JOURNAL_SCHEMA.into(),
        id: Uuid::new_v4(),
        created_at: Utc::now(),
        session_id: context.session_id,
        approval_id: context.approval_id,
        workspace_path: transaction.workspace_path.clone(),
        entries: transaction
            .changes
            .iter()
            .enumerate()
            .map(|(index, change)| ProviderMutationJournalEntry {
                relative_path: change.relative_path.clone(),
                target: change.target.clone(),
                stage: staged[index].clone(),
                backup: backups[index].clone(),
                original_hash: change.expected_hash.clone(),
                desired_hash: change.desired_content.as_deref().map(content_hash),
            })
            .collect(),
    };
    let journal_path = provider_mutation_journal_path(journal_dir, journal.id)?;
    write_provider_mutation_journal(&journal_path, &journal).inspect_err(|_error| {
        cleanup_provider_staging(&staged);
    })?;
    let commit_result = validate_provider_mutation_transaction(transaction, &mut is_cancelled)
        .and_then(|()| {
            commit_provider_mutation_transaction(transaction, &staged, &backups, &mut is_cancelled)
        });
    if let Err(error) = commit_result {
        if rollback_provider_mutation_journal(&journal).is_ok() {
            let _ = remove_provider_mutation_journal(&journal_path);
        }
        return Err(error);
    }
    Ok(PendingProviderMutationCommit {
        result: provider_mutation_result(transaction),
        journal_path,
        journal,
        _lock: mutation_lock,
    })
}

fn validate_provider_mutation_transaction<F>(
    transaction: &PreparedProviderMutationTransaction,
    is_cancelled: &mut F,
) -> Result<()>
where
    F: FnMut() -> bool,
{
    ensure_mutation_not_cancelled(is_cancelled)?;
    for change in &transaction.changes {
        validate_prepared_provider_mutation(&transaction.workspace_path, change, is_cancelled)?;
    }
    Ok(())
}

fn stage_provider_mutation_transaction<F>(
    transaction: &PreparedProviderMutationTransaction,
    is_cancelled: &mut F,
) -> Result<Vec<Option<PathBuf>>>
where
    F: FnMut() -> bool,
{
    let mut staged = vec![None; transaction.changes.len()];
    for (index, change) in transaction.changes.iter().enumerate() {
        if let Some(content) = change.desired_content.as_deref() {
            match stage_provider_mutation_file(&change.target, content, is_cancelled) {
                Ok(temporary) => staged[index] = Some(temporary),
                Err(error) => {
                    cleanup_provider_staging(&staged);
                    return Err(error);
                }
            }
        }
    }
    Ok(staged)
}

fn provider_mutation_backup_paths(
    transaction: &PreparedProviderMutationTransaction,
) -> Vec<Option<PathBuf>> {
    transaction
        .changes
        .iter()
        .map(|change| {
            change
                .expected_hash
                .as_ref()
                .map(|_| provider_sibling_path(&change.target, "backup"))
        })
        .collect()
}

fn commit_provider_mutation_transaction<F>(
    transaction: &PreparedProviderMutationTransaction,
    staged: &[Option<PathBuf>],
    backups: &[Option<PathBuf>],
    is_cancelled: &mut F,
) -> Result<()>
where
    F: FnMut() -> bool,
{
    let mut touched = 0usize;
    for (index, change) in transaction.changes.iter().enumerate() {
        if let Err(error) = ensure_mutation_not_cancelled(is_cancelled) {
            let _ = rollback_provider_mutations(transaction, backups, touched);
            cleanup_provider_staging(staged);
            return Err(error);
        }
        if let Some(backup) = backups[index].as_ref() {
            if let Err(error) = fs::rename(&change.target, backup) {
                let _ = rollback_provider_mutations(transaction, backups, touched);
                cleanup_provider_staging(staged);
                return Err(error)
                    .with_context(|| format!("back up approved file {}", change.relative_path));
            }
        }
        touched = index + 1;
        if let Some(temporary) = staged[index].as_ref() {
            if let Err(error) = fs::rename(temporary, &change.target) {
                let _ = rollback_provider_mutations(transaction, backups, touched);
                cleanup_provider_staging(staged);
                return Err(error)
                    .with_context(|| format!("commit approved file {}", change.relative_path));
            }
        }
    }
    if let Err(error) = sync_provider_mutation_parents(transaction) {
        let _ = rollback_provider_mutations(transaction, backups, touched);
        cleanup_provider_staging(staged);
        return Err(error);
    }
    Ok(())
}

fn provider_mutation_result(
    transaction: &PreparedProviderMutationTransaction,
) -> ProviderMutationResult {
    ProviderMutationResult {
        changed_paths: transaction
            .changes
            .iter()
            .map(|change| change.relative_path.clone())
            .collect(),
    }
}

fn push_provider_mutation(
    prepared: &mut Vec<PreparedProviderMutation>,
    destinations: &mut HashSet<PathBuf>,
    relative_path: String,
    target: PathBuf,
    expected_hash: Option<String>,
    desired_content: Option<Vec<u8>>,
) -> Result<()> {
    if !destinations.insert(target.clone()) {
        return Err(anyhow!(
            "provider approval changes {relative_path} more than once"
        ));
    }
    prepared.push(PreparedProviderMutation {
        relative_path,
        target,
        expected_hash,
        desired_content,
    });
    Ok(())
}

fn provider_mutation_target(workspace: &Path, input: &str) -> Result<PathBuf> {
    let input = Path::new(input.trim());
    if input.as_os_str().is_empty() {
        return Err(anyhow!("provider file change path is empty"));
    }
    if !input.is_absolute()
        && input.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(anyhow!("provider file path leaves the selected workspace"));
    }
    if let Ok(metadata) = fs::symlink_metadata(input) {
        if metadata.file_type().is_symlink() {
            return Err(anyhow!("provider file target may not be a symlink"));
        }
        if metadata.is_dir() {
            return Err(anyhow!("provider file target is a directory"));
        }
    }
    let target = if input.is_absolute() {
        input.to_path_buf()
    } else {
        workspace.join(input)
    };
    let parent = target
        .parent()
        .ok_or_else(|| anyhow!("provider file path has no parent"))?;
    let resolved_parent = parent
        .canonicalize()
        .map_err(|_| anyhow!("provider file parent does not exist"))?;
    if !resolved_parent.starts_with(workspace) {
        return Err(anyhow!(
            "provider file parent resolves outside the selected workspace"
        ));
    }
    let file_name = target
        .file_name()
        .ok_or_else(|| anyhow!("provider file path has no file name"))?;
    let target = resolved_parent.join(file_name);
    if !target.starts_with(workspace) {
        return Err(anyhow!(
            "provider file path is outside the selected workspace"
        ));
    }
    if let Ok(metadata) = fs::symlink_metadata(&target) {
        if metadata.file_type().is_symlink() {
            return Err(anyhow!("provider file target may not be a symlink"));
        }
        if metadata.is_dir() {
            return Err(anyhow!("provider file target is a directory"));
        }
    }
    Ok(target)
}

fn provider_relative_path(workspace: &Path, target: &Path) -> Result<String> {
    Ok(target
        .strip_prefix(workspace)
        .map_err(|_| anyhow!("provider file path is outside the selected workspace"))?
        .to_string_lossy()
        .replace('\\', "/"))
}

fn read_provider_mutation_file(path: &Path, relative_path: &str) -> Result<Vec<u8>> {
    let bytes = read_bounded_mutation_file(
        path,
        MAX_PROVIDER_MUTATION_FILE_BYTES,
        &format!("provider mutation target {relative_path}"),
    )?;
    ensure_provider_text(&bytes, relative_path)?;
    Ok(bytes)
}

fn read_bounded_mutation_file(path: &Path, max_bytes: usize, label: &str) -> Result<Vec<u8>> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("open {label} {}", path.display()))?;
    if !file.metadata()?.is_file() {
        return Err(anyhow!("{label} is not a regular file"));
    }
    let mut bytes = Vec::with_capacity(max_bytes.min(8 * 1024));
    Read::by_ref(&mut file)
        .take(max_bytes.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .with_context(|| format!("read {label} {}", path.display()))?;
    if bytes.len() > max_bytes {
        return Err(anyhow!("{label} exceeds the {max_bytes} byte size limit"));
    }
    Ok(bytes)
}

fn ensure_provider_text(content: &[u8], relative_path: &str) -> Result<()> {
    if content.len() > MAX_PROVIDER_MUTATION_FILE_BYTES {
        return Err(anyhow!(
            "provider change for {relative_path} exceeds the {} MiB file limit",
            MAX_PROVIDER_MUTATION_FILE_BYTES / (1024 * 1024)
        ));
    }
    if content.contains(&0) || std::str::from_utf8(content).is_err() {
        return Err(anyhow!(
            "provider change for {relative_path} is not a UTF-8 text file"
        ));
    }
    Ok(())
}

fn apply_provider_unified_diff(relative_path: &str, current: &[u8], diff: &str) -> Result<Vec<u8>> {
    let current = std::str::from_utf8(current)
        .with_context(|| format!("provider update target {relative_path} is not UTF-8"))?;
    let patch_text = if diff.starts_with("--- ") {
        diff.to_string()
    } else {
        format!("--- a/{relative_path}\n+++ b/{relative_path}\n{diff}")
    };
    let patch = diffy::Patch::from_str(&patch_text)
        .with_context(|| format!("parse reviewed patch for {relative_path}"))?;
    diffy::apply(current, &patch)
        .map(String::into_bytes)
        .with_context(|| format!("apply reviewed patch for {relative_path}"))
}

fn validate_prepared_provider_mutation<F>(
    workspace: &Path,
    change: &PreparedProviderMutation,
    is_cancelled: &mut F,
) -> Result<()>
where
    F: FnMut() -> bool,
{
    ensure_mutation_not_cancelled(is_cancelled)?;
    let target = provider_mutation_target(workspace, &change.relative_path)?;
    if target != change.target {
        return Err(anyhow!(
            "provider target {} changed after review",
            change.relative_path
        ));
    }
    match &change.expected_hash {
        Some(expected_hash) => {
            let current = read_provider_mutation_file(&target, &change.relative_path)?;
            if content_hash(&current) != *expected_hash {
                return Err(anyhow!(
                    "{} changed after approval was requested; review the file set again",
                    change.relative_path
                ));
            }
        }
        None if target.exists() => {
            return Err(anyhow!(
                "{} now exists; review the file set again",
                change.relative_path
            ));
        }
        None => {}
    }
    Ok(())
}

fn stage_provider_mutation_file<F>(
    target: &Path,
    content: &[u8],
    is_cancelled: &mut F,
) -> Result<PathBuf>
where
    F: FnMut() -> bool,
{
    let temporary = provider_sibling_path(target, "stage");
    let result = (|| -> Result<()> {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        if let Ok(metadata) = fs::metadata(target) {
            file.set_permissions(metadata.permissions())?;
        }
        for chunk in content.chunks(64 * 1024) {
            ensure_mutation_not_cancelled(is_cancelled)?;
            file.write_all(chunk)?;
        }
        file.flush()?;
        file.sync_all()?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(temporary)
}

fn provider_sibling_path(target: &Path, role: &str) -> PathBuf {
    target
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!(
            ".gyro-{}-{role}-{}",
            target
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("provider-change"),
            Uuid::new_v4()
        ))
}

fn provider_mutation_journal_path(journal_dir: &Path, transaction_id: Uuid) -> Result<PathBuf> {
    fs::create_dir_all(journal_dir).with_context(|| {
        format!(
            "create mutation journal directory {}",
            journal_dir.display()
        )
    })?;
    Ok(journal_dir.join(format!("transaction-{transaction_id}.json")))
}

fn write_provider_mutation_journal(path: &Path, journal: &ProviderMutationJournal) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("provider mutation journal has no parent"))?;
    let bytes = serde_json::to_vec(journal)?;
    if bytes.len() as u64 > MAX_PROVIDER_MUTATION_JOURNAL_BYTES {
        return Err(anyhow!("provider mutation journal exceeds its size limit"));
    }
    let temporary = parent.join(format!(".journal-{}.tmp", Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.flush()?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        fs::File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn remove_provider_mutation_journal(path: &Path) -> Result<()> {
    if path.exists() {
        fs::remove_file(path)
            .with_context(|| format!("remove mutation journal {}", path.display()))?;
    }
    if let Some(parent) = path.parent() {
        fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

pub fn recover_provider_mutation_transactions(
    journal_dir: &Path,
    store: &SessionStore,
) -> Result<ProviderMutationRecoveryReport> {
    if !journal_dir.exists() {
        return Ok(ProviderMutationRecoveryReport::default());
    }
    let Some(_lock) = acquire_provider_mutation_recovery_lock(journal_dir)? else {
        return Ok(ProviderMutationRecoveryReport {
            skipped: true,
            ..ProviderMutationRecoveryReport::default()
        });
    };
    let mut report = ProviderMutationRecoveryReport::default();
    for path in provider_mutation_journal_paths(journal_dir)? {
        match recover_provider_mutation_journal(&path, store) {
            Ok(true) => report.finalized += 1,
            Ok(false) => report.rolled_back += 1,
            Err(error) => {
                let quarantined =
                    quarantine_provider_mutation_journal(&path).with_context(|| {
                        format!(
                        "quarantine provider mutation journal {} after recovery failed: {error:#}",
                        path.display()
                    )
                    })?;
                eprintln!(
                    "provider mutation journal {} requires manual review and was moved to {}: {error:#}",
                    path.display(),
                    quarantined.display()
                );
                report.quarantined += 1;
            }
        }
    }
    report.reconciled_proposals = recover_claimed_mutation_proposals(store)?;
    Ok(report)
}

fn quarantine_provider_mutation_journal(path: &Path) -> Result<PathBuf> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("provider mutation journal has no parent"))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("transaction.json");
    let quarantined = parent.join(format!("quarantined-{file_name}-{}", Uuid::new_v4()));
    fs::rename(path, &quarantined).with_context(|| {
        format!(
            "move provider mutation journal {} to {}",
            path.display(),
            quarantined.display()
        )
    })?;
    fs::File::open(parent)?.sync_all()?;
    Ok(quarantined)
}

fn provider_mutation_journal_paths(journal_dir: &Path) -> Result<Vec<PathBuf>> {
    let mut journal_paths = fs::read_dir(journal_dir)?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("transaction-") && name.ends_with(".json"))
        })
        .collect::<Vec<_>>();
    journal_paths.sort();
    Ok(journal_paths)
}

fn acquire_provider_mutation_recovery_lock(
    journal_dir: &Path,
) -> Result<Option<ProviderMutationRecoveryLock>> {
    acquire_provider_mutation_lock(journal_dir, true)
}

fn acquire_provider_mutation_lock_blocking(
    journal_dir: &Path,
) -> Result<ProviderMutationRecoveryLock> {
    acquire_provider_mutation_lock(journal_dir, false)?
        .ok_or_else(|| anyhow!("provider mutation lock was unexpectedly unavailable"))
}

fn acquire_provider_mutation_lock(
    journal_dir: &Path,
    nonblocking: bool,
) -> Result<Option<ProviderMutationRecoveryLock>> {
    fs::create_dir_all(journal_dir)?;
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(journal_dir.join("recovery.lock"))?;
    #[cfg(unix)]
    {
        let operation = libc::LOCK_EX | if nonblocking { libc::LOCK_NB } else { 0 };
        let status = unsafe { libc::flock(file.as_raw_fd(), operation) };
        if status != 0 {
            let error = std::io::Error::last_os_error();
            let code = error.raw_os_error();
            if code == Some(libc::EWOULDBLOCK) || code == Some(libc::EAGAIN) {
                return Ok(None);
            }
            return Err(error).context("lock provider mutation recovery journal");
        }
    }
    Ok(Some(ProviderMutationRecoveryLock { _file: file }))
}

fn recover_provider_mutation_journal(path: &Path, store: &SessionStore) -> Result<bool> {
    let metadata = fs::metadata(path)?;
    if metadata.len() > MAX_PROVIDER_MUTATION_JOURNAL_BYTES {
        return Err(anyhow!(
            "provider mutation journal {} exceeds its size limit",
            path.display()
        ));
    }
    let journal_bytes = read_bounded_mutation_file(
        path,
        MAX_PROVIDER_MUTATION_JOURNAL_BYTES as usize,
        "provider mutation journal",
    )?;
    let journal: ProviderMutationJournal = serde_json::from_slice(&journal_bytes)
        .with_context(|| format!("read provider mutation journal {}", path.display()))?;
    if journal.schema != PROVIDER_MUTATION_JOURNAL_SCHEMA {
        return Err(anyhow!(
            "unsupported provider mutation journal schema in {}",
            path.display()
        ));
    }
    validate_provider_mutation_journal(&journal)?;
    let applied = provider_mutation_approval_was_applied(store, &journal)?;
    if applied {
        finalize_provider_mutation_journal(&journal)?;
    } else {
        rollback_provider_mutation_journal(&journal)?;
    }
    remove_provider_mutation_journal(path)?;
    Ok(applied)
}

fn validate_provider_mutation_journal(journal: &ProviderMutationJournal) -> Result<()> {
    if journal.schema != PROVIDER_MUTATION_JOURNAL_SCHEMA {
        return Err(anyhow!("unsupported provider mutation journal schema"));
    }
    let workspace = journal.workspace_path.canonicalize().with_context(|| {
        format!(
            "resolve recovery workspace {}",
            journal.workspace_path.display()
        )
    })?;
    if workspace != journal.workspace_path {
        return Err(anyhow!("provider mutation recovery workspace changed"));
    }
    for entry in &journal.entries {
        let target = provider_mutation_target(&workspace, &entry.relative_path)?;
        if target != entry.target {
            return Err(anyhow!(
                "provider mutation target {} changed before recovery",
                entry.relative_path
            ));
        }
        validate_provider_mutation_artifact(&target, entry.stage.as_deref(), "stage")?;
        validate_provider_mutation_artifact(&target, entry.backup.as_deref(), "backup")?;
    }
    Ok(())
}

fn validate_provider_mutation_artifact(
    target: &Path,
    artifact: Option<&Path>,
    role: &str,
) -> Result<()> {
    let Some(artifact) = artifact else {
        return Ok(());
    };
    if artifact.parent() != target.parent() {
        return Err(anyhow!(
            "provider mutation journal contains an unsafe artifact path"
        ));
    }
    let target_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("provider-change");
    let artifact_name = artifact
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow!("provider mutation artifact has an invalid file name"))?;
    if !artifact_name.starts_with(&format!(".gyro-{target_name}-{role}-")) {
        return Err(anyhow!(
            "provider mutation journal contains an unsafe artifact name"
        ));
    }
    if let Ok(metadata) = fs::symlink_metadata(artifact) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(anyhow!("provider mutation recovery artifact is unsafe"));
        }
    }
    Ok(())
}

fn provider_mutation_approval_was_applied(
    store: &SessionStore,
    journal: &ProviderMutationJournal,
) -> Result<bool> {
    if store.get_session(journal.session_id)?.is_none() {
        return Ok(false);
    }
    let approval_id = journal.approval_id.to_string();
    Ok(store
        .read_events(journal.session_id)?
        .into_iter()
        .any(|event| {
            event.kind == SessionEventKind::SystemEvent
                && event
                    .payload
                    .get("kind")
                    .and_then(serde_json::Value::as_str)
                    == Some("provider-tool-approval")
                && event
                    .payload
                    .get("approvalId")
                    .and_then(serde_json::Value::as_str)
                    == Some(approval_id.as_str())
                && event
                    .payload
                    .get("status")
                    .and_then(serde_json::Value::as_str)
                    == Some("applied")
        }))
}

fn rollback_provider_mutation_journal(journal: &ProviderMutationJournal) -> Result<()> {
    validate_provider_mutation_journal(journal)?;
    for entry in journal.entries.iter().rev() {
        if let Some(backup) = entry.backup.as_deref().filter(|path| path.exists()) {
            if entry.target.exists() {
                ensure_recovery_hash(
                    &entry.target,
                    entry.desired_hash.as_deref(),
                    "committed target",
                )?;
                fs::remove_file(&entry.target)?;
            }
            fs::rename(backup, &entry.target)?;
            ensure_recovery_hash(
                &entry.target,
                entry.original_hash.as_deref(),
                "restored target",
            )?;
        } else if let Some(original_hash) = entry.original_hash.as_deref() {
            ensure_recovery_hash(&entry.target, Some(original_hash), "original target")?;
        } else if entry.target.exists() {
            ensure_recovery_hash(
                &entry.target,
                entry.desired_hash.as_deref(),
                "created target",
            )?;
            fs::remove_file(&entry.target)?;
        }
        if let Some(stage) = entry.stage.as_deref().filter(|path| path.exists()) {
            fs::remove_file(stage)?;
        }
    }
    sync_provider_mutation_journal_parents(journal)
}

fn finalize_provider_mutation_journal(journal: &ProviderMutationJournal) -> Result<()> {
    validate_provider_mutation_journal(journal)?;
    for entry in &journal.entries {
        match entry.desired_hash.as_deref() {
            Some(desired_hash) => {
                ensure_recovery_hash(&entry.target, Some(desired_hash), "committed target")?
            }
            None if entry.target.exists() => {
                return Err(anyhow!(
                    "deleted provider target reappeared before journal cleanup"
                ));
            }
            None => {}
        }
        for artifact in [entry.stage.as_deref(), entry.backup.as_deref()]
            .into_iter()
            .flatten()
        {
            if artifact.exists() {
                fs::remove_file(artifact)?;
            }
        }
    }
    sync_provider_mutation_journal_parents(journal)
}

fn sync_provider_mutation_journal_parents(journal: &ProviderMutationJournal) -> Result<()> {
    let parents = journal
        .entries
        .iter()
        .filter_map(|entry| entry.target.parent().map(Path::to_path_buf))
        .collect::<HashSet<_>>();
    for parent in parents {
        fs::File::open(&parent)
            .and_then(|directory| directory.sync_all())
            .with_context(|| format!("sync recovered mutation directory {}", parent.display()))?;
    }
    Ok(())
}

fn ensure_recovery_hash(path: &Path, expected: Option<&str>, label: &str) -> Result<()> {
    let expected = expected.ok_or_else(|| anyhow!("provider journal is missing {label} hash"))?;
    let bytes = read_bounded_mutation_file(path, MAX_PROVIDER_MUTATION_FILE_BYTES, label)?;
    if content_hash(&bytes) != expected {
        return Err(anyhow!(
            "{label} changed before provider mutation recovery; manual review is required"
        ));
    }
    Ok(())
}

fn rollback_provider_mutations(
    transaction: &PreparedProviderMutationTransaction,
    backups: &[Option<PathBuf>],
    touched: usize,
) -> Result<()> {
    for index in (0..touched).rev() {
        let change = &transaction.changes[index];
        if change.target.exists() {
            fs::remove_file(&change.target)?;
        }
        if let Some(backup) = backups[index].as_ref() {
            fs::rename(backup, &change.target)?;
        }
    }
    sync_provider_mutation_parents(transaction)
}

fn cleanup_provider_staging(staged: &[Option<PathBuf>]) {
    for temporary in staged.iter().flatten() {
        let _ = fs::remove_file(temporary);
    }
}

fn sync_provider_mutation_parents(transaction: &PreparedProviderMutationTransaction) -> Result<()> {
    let mut parents = HashSet::new();
    for change in &transaction.changes {
        if let Some(parent) = change.target.parent() {
            parents.insert(parent.to_path_buf());
        }
    }
    for parent in parents {
        fs::File::open(&parent)
            .and_then(|directory| directory.sync_all())
            .with_context(|| format!("sync provider mutation directory {}", parent.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{GyroPaths, SessionOrigin};

    fn proposal_store(temp: &tempfile::TempDir) -> (SessionStore, Uuid) {
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Cli, "mutation")
            .unwrap();
        (store, session.id)
    }

    #[test]
    fn claude_write_and_edit_tools_use_provider_transactions() {
        let temp = tempfile::tempdir().unwrap();
        let write = prepare_claude_provider_mutation_transaction(
            temp.path(),
            "Write",
            &serde_json::json!({
                "file_path": temp.path().join("created.txt"),
                "content": "one\ntwo\n",
            }),
        )
        .unwrap();
        apply_provider_mutation_transaction(&write).unwrap();
        assert_eq!(
            fs::read_to_string(temp.path().join("created.txt")).unwrap(),
            "one\ntwo\n"
        );

        let edit = prepare_claude_provider_mutation_transaction(
            temp.path(),
            "Edit",
            &serde_json::json!({
                "filePath": "created.txt",
                "oldString": "two",
                "newString": "second",
            }),
        )
        .unwrap();
        apply_provider_mutation_transaction(&edit).unwrap();
        assert_eq!(
            fs::read_to_string(temp.path().join("created.txt")).unwrap(),
            "one\nsecond\n"
        );
    }

    #[test]
    fn claude_multi_edit_is_applied_as_one_reviewed_transaction() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("multi.txt"), "alpha beta gamma\n").unwrap();
        let transaction = prepare_claude_provider_mutation_transaction(
            temp.path(),
            "MultiEdit",
            &serde_json::json!({
                "file_path": "multi.txt",
                "edits": [
                    { "old_string": "alpha", "new_string": "one" },
                    { "old_string": "gamma", "new_string": "three" },
                ],
            }),
        )
        .unwrap();

        apply_provider_mutation_transaction(&transaction).unwrap();

        assert_eq!(
            fs::read_to_string(temp.path().join("multi.txt")).unwrap(),
            "one beta three\n"
        );
    }

    #[test]
    fn claude_edit_fails_closed_for_ambiguous_or_unsupported_changes() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("ambiguous.txt"), "same same\n").unwrap();
        let ambiguous = prepare_claude_provider_mutation_transaction(
            temp.path(),
            "Edit",
            &serde_json::json!({
                "file_path": "ambiguous.txt",
                "old_string": "same",
                "new_string": "changed",
            }),
        )
        .unwrap_err();
        assert!(ambiguous.to_string().contains("not unique"));

        let notebook = prepare_claude_provider_mutation_transaction(
            temp.path(),
            "NotebookEdit",
            &serde_json::json!({ "file_path": "ambiguous.txt" }),
        )
        .unwrap_err();
        assert!(notebook.to_string().contains("not supported"));
    }

    #[cfg(unix)]
    #[test]
    fn claude_file_tools_reject_symlink_and_workspace_escapes() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        symlink(outside.path(), temp.path().join("linked.txt")).unwrap();
        let linked = prepare_claude_provider_mutation_transaction(
            temp.path(),
            "Write",
            &serde_json::json!({ "file_path": "linked.txt", "content": "no\n" }),
        )
        .unwrap_err();
        assert!(linked.to_string().contains("symlink"));

        let escaped = prepare_claude_provider_mutation_transaction(
            temp.path(),
            "Write",
            &serde_json::json!({ "file_path": "../outside.txt", "content": "no\n" }),
        )
        .unwrap_err();
        assert!(escaped
            .to_string()
            .contains("leaves the selected workspace"));
    }

    #[test]
    fn approves_new_file_with_a_durable_event() {
        let temp = tempfile::tempdir().unwrap();
        let (store, session_id) = proposal_store(&temp);
        let proposal = store
            .create_mutation_proposal(
                session_id,
                Some(Uuid::new_v4()),
                "created.txt",
                "approved\n",
                None,
                false,
            )
            .unwrap();

        let result = decide_mutation_proposal(&store, proposal.id, MutationDecision::Approve)
            .expect("approve proposal");

        assert_eq!(result.proposal.status, MutationProposalStatus::Applied);
        assert_eq!(
            fs::read_to_string(temp.path().join("created.txt")).unwrap(),
            "approved\n"
        );
        assert_eq!(result.event.payload["schema"], "gyro.mutation.v1");
    }

    #[test]
    fn rejects_without_writing() {
        let temp = tempfile::tempdir().unwrap();
        let (store, session_id) = proposal_store(&temp);
        let proposal = store
            .create_mutation_proposal(session_id, None, "rejected.txt", "no\n", None, false)
            .unwrap();

        let result = decide_mutation_proposal(&store, proposal.id, MutationDecision::Reject)
            .expect("reject proposal");

        assert_eq!(result.proposal.status, MutationProposalStatus::Rejected);
        assert!(!temp.path().join("rejected.txt").exists());
    }

    #[test]
    fn refuses_stale_updates_and_records_failure() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("existing.txt"), "original\n").unwrap();
        let (store, session_id) = proposal_store(&temp);
        let original_hash = content_hash(b"original\n");
        let proposal = store
            .create_mutation_proposal(
                session_id,
                None,
                "existing.txt",
                "proposal\n",
                Some(original_hash),
                true,
            )
            .unwrap();
        fs::write(temp.path().join("existing.txt"), "newer\n").unwrap();

        let error =
            decide_mutation_proposal(&store, proposal.id, MutationDecision::Approve).unwrap_err();

        assert!(error.to_string().contains("file changed"));
        assert_eq!(
            store
                .get_mutation_proposal(proposal.id)
                .unwrap()
                .unwrap()
                .status,
            MutationProposalStatus::Failed
        );
        assert_eq!(
            fs::read_to_string(temp.path().join("existing.txt")).unwrap(),
            "newer\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_escape() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), temp.path().join("link")).unwrap();
        let (store, session_id) = proposal_store(&temp);
        let proposal = store
            .create_mutation_proposal(session_id, None, "link/out.txt", "no\n", None, false)
            .unwrap();

        let error =
            decide_mutation_proposal(&store, proposal.id, MutationDecision::Approve).unwrap_err();

        let error = error.to_string();
        assert!(error.contains("outside") && error.contains("workspace"));
        assert!(!outside.path().join("out.txt").exists());
    }

    #[test]
    fn review_contains_a_bounded_text_diff() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("review.txt"), "before\n").unwrap();
        let (store, session_id) = proposal_store(&temp);
        let proposal = store
            .create_mutation_proposal(
                session_id,
                None,
                "review.txt",
                "after\n",
                Some(content_hash(b"before\n")),
                true,
            )
            .unwrap();

        let review = review_mutation_proposal(proposal).unwrap();
        assert!(review.diff.preview.contains("-before"));
        assert!(review.diff.preview.contains("+after"));
    }

    #[test]
    fn approval_expiry_is_bounded_to_twenty_four_hours() {
        let now = Utc::now();
        assert!(!mutation_approval_expired(now - Duration::hours(23), now));
        assert!(mutation_approval_expired(now - Duration::hours(25), now));
    }

    #[test]
    fn cancellation_removes_the_temporary_file_and_records_the_claim_as_failed() {
        let temp = tempfile::tempdir().unwrap();
        let (store, session_id) = proposal_store(&temp);
        let proposal = store
            .create_mutation_proposal(
                session_id,
                None,
                "cancelled.txt",
                "x".repeat(256 * 1024),
                None,
                false,
            )
            .unwrap();
        let mut checks = 0;

        let error = decide_mutation_proposal_with_cancellation(
            &store,
            proposal.id,
            MutationDecision::Approve,
            || {
                checks += 1;
                checks >= 4
            },
        )
        .unwrap_err();

        assert!(mutation_decision_was_cancelled(&error));
        let proposal = store.get_mutation_proposal(proposal.id).unwrap().unwrap();
        assert_eq!(proposal.status, MutationProposalStatus::Failed);
        assert!(proposal.error.unwrap().contains("cancelled"));
        assert!(!temp.path().join("cancelled.txt").exists());
        assert!(fs::read_dir(temp.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".gyro-")
        }));
    }

    fn provider_change(
        path: &str,
        change_type: &str,
        diff: &str,
        move_path: Option<&str>,
    ) -> ProviderFileChange {
        ProviderFileChange {
            path: path.into(),
            kind: ProviderFileChangeKind {
                change_type: change_type.into(),
                move_path: move_path.map(Into::into),
            },
            diff: diff.into(),
        }
    }

    #[test]
    fn provider_transaction_applies_add_update_and_delete_together() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("update.txt"), "alpha\nbeta\ngamma\n").unwrap();
        fs::write(temp.path().join("delete.txt"), "remove me\n").unwrap();
        let changes = vec![
            provider_change("add.txt", "add", "created\n", None),
            provider_change(
                "update.txt",
                "update",
                "@@ -1,3 +1,3 @@\n alpha\n-beta\n+delta\n gamma\n",
                None,
            ),
            provider_change("delete.txt", "delete", "", None),
        ];

        let transaction = prepare_provider_mutation_transaction(temp.path(), &changes).unwrap();
        let result = apply_provider_mutation_transaction(&transaction).unwrap();

        assert_eq!(
            fs::read_to_string(temp.path().join("add.txt")).unwrap(),
            "created\n"
        );
        assert_eq!(
            fs::read_to_string(temp.path().join("update.txt")).unwrap(),
            "alpha\ndelta\ngamma\n"
        );
        assert!(!temp.path().join("delete.txt").exists());
        assert_eq!(
            result.changed_paths,
            vec!["add.txt", "update.txt", "delete.txt"]
        );
    }

    #[test]
    fn provider_transaction_moves_an_updated_file() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("before.txt"), "old\n").unwrap();
        let changes = vec![provider_change(
            "before.txt",
            "update",
            "@@ -1 +1 @@\n-old\n+new\n",
            Some("after.txt"),
        )];

        let transaction = prepare_provider_mutation_transaction(temp.path(), &changes).unwrap();
        apply_provider_mutation_transaction(&transaction).unwrap();

        assert!(!temp.path().join("before.txt").exists());
        assert_eq!(
            fs::read_to_string(temp.path().join("after.txt")).unwrap(),
            "new\n"
        );
    }

    #[test]
    fn provider_transaction_refuses_stale_file_sets_before_writing() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("first.txt"), "first\n").unwrap();
        fs::write(temp.path().join("second.txt"), "second\n").unwrap();
        let changes = vec![
            provider_change(
                "first.txt",
                "update",
                "@@ -1 +1 @@\n-first\n+changed first\n",
                None,
            ),
            provider_change(
                "second.txt",
                "update",
                "@@ -1 +1 @@\n-second\n+changed second\n",
                None,
            ),
        ];
        let transaction = prepare_provider_mutation_transaction(temp.path(), &changes).unwrap();
        fs::write(temp.path().join("second.txt"), "newer\n").unwrap();

        let error = apply_provider_mutation_transaction(&transaction).unwrap_err();

        assert!(error.to_string().contains("changed after approval"));
        assert_eq!(
            fs::read_to_string(temp.path().join("first.txt")).unwrap(),
            "first\n"
        );
        assert_eq!(
            fs::read_to_string(temp.path().join("second.txt")).unwrap(),
            "newer\n"
        );
    }

    #[test]
    fn provider_transaction_rolls_back_when_cancelled_during_commit() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("first.txt"), "first\n").unwrap();
        fs::write(temp.path().join("second.txt"), "second\n").unwrap();
        let changes = vec![
            provider_change(
                "first.txt",
                "update",
                "@@ -1 +1 @@\n-first\n+changed first\n",
                None,
            ),
            provider_change(
                "second.txt",
                "update",
                "@@ -1 +1 @@\n-second\n+changed second\n",
                None,
            ),
        ];
        let transaction = prepare_provider_mutation_transaction(temp.path(), &changes).unwrap();
        let mut checks = 0usize;

        let error = apply_provider_mutation_transaction_with_cancellation(&transaction, || {
            checks += 1;
            checks >= 7
        })
        .unwrap_err();

        assert!(mutation_decision_was_cancelled(&error));
        assert_eq!(
            fs::read_to_string(temp.path().join("first.txt")).unwrap(),
            "first\n"
        );
        assert_eq!(
            fs::read_to_string(temp.path().join("second.txt")).unwrap(),
            "second\n"
        );
        assert!(fs::read_dir(temp.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".gyro-")
        }));
    }

    #[cfg(unix)]
    #[test]
    fn provider_transaction_rejects_symlink_targets() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        symlink(outside.path(), temp.path().join("linked.txt")).unwrap();

        let error = prepare_provider_mutation_transaction(
            temp.path(),
            &[provider_change(
                "linked.txt",
                "update",
                "@@ -0,0 +1 @@\n+no\n",
                None,
            )],
        )
        .unwrap_err();

        assert!(error.to_string().contains("symlink"));
    }

    #[test]
    fn provider_transaction_rejects_duplicate_and_escaping_targets() {
        let temp = tempfile::tempdir().unwrap();
        let duplicate = prepare_provider_mutation_transaction(
            temp.path(),
            &[
                provider_change("same.txt", "add", "one\n", None),
                provider_change("same.txt", "add", "two\n", None),
            ],
        )
        .unwrap_err();
        assert!(
            duplicate.to_string().contains("already exists")
                || duplicate.to_string().contains("more than once")
        );

        let escape = prepare_provider_mutation_transaction(
            temp.path(),
            &[provider_change("../outside.txt", "add", "no\n", None)],
        )
        .unwrap_err();
        assert!(escape.to_string().contains("leaves the selected workspace"));
    }

    #[test]
    fn provider_transaction_rejects_binary_and_oversized_changes() {
        let temp = tempfile::tempdir().unwrap();
        let binary = prepare_provider_mutation_transaction(
            temp.path(),
            &[provider_change("binary.txt", "add", "bad\0data", None)],
        )
        .unwrap_err();
        assert!(binary.to_string().contains("UTF-8 text file"));

        let oversized = "x".repeat(MAX_PROVIDER_MUTATION_FILE_BYTES + 1);
        let error = prepare_provider_mutation_transaction(
            temp.path(),
            &[provider_change("large.txt", "add", &oversized, None)],
        )
        .unwrap_err();
        assert!(error.to_string().contains("file limit"));
    }

    #[test]
    fn durable_provider_transaction_removes_its_journal_after_success() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let journals = paths.mutation_journals_dir.clone();
        let store = SessionStore::open(paths).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Cli, "durable mutation")
            .unwrap();
        let approval_id = Uuid::new_v4();
        fs::write(temp.path().join("file.txt"), "before\n").unwrap();
        let transaction = prepare_provider_mutation_transaction(
            temp.path(),
            &[provider_change(
                "file.txt",
                "update",
                "@@ -1 +1 @@\n-before\n+after\n",
                None,
            )],
        )
        .unwrap();

        let pending = begin_provider_mutation_transaction(
            &transaction,
            &journals,
            ProviderMutationJournalContext {
                session_id: session.id,
                approval_id,
            },
        )
        .unwrap();
        store
            .append_event(
                session.id,
                SessionEventKind::SystemEvent,
                "Provider file changes applied through Gyro",
                serde_json::json!({
                    "kind": "provider-tool-approval",
                    "approvalId": approval_id,
                    "status": "applied",
                }),
            )
            .unwrap();
        pending.finalize().unwrap();

        assert_eq!(
            fs::read_to_string(temp.path().join("file.txt")).unwrap(),
            "after\n"
        );
        assert!(provider_mutation_journal_paths(&journals)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn recovery_rolls_back_an_interrupted_multi_file_commit() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let journals = paths.mutation_journals_dir.clone();
        let store = SessionStore::open(paths).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Cli, "interrupted mutation")
            .unwrap();
        fs::write(temp.path().join("first.txt"), "first\n").unwrap();
        let transaction = prepare_provider_mutation_transaction(
            temp.path(),
            &[
                provider_change(
                    "first.txt",
                    "update",
                    "@@ -1 +1 @@\n-first\n+changed\n",
                    None,
                ),
                provider_change("second.txt", "add", "created\n", None),
            ],
        )
        .unwrap();
        let pending = begin_provider_mutation_transaction(
            &transaction,
            &journals,
            ProviderMutationJournalContext {
                session_id: session.id,
                approval_id: Uuid::new_v4(),
            },
        )
        .unwrap();
        drop(pending);

        let recovered = recover_provider_mutation_transactions(&journals, &store).unwrap();

        assert_eq!(recovered.rolled_back, 1);
        assert_eq!(recovered.finalized, 0);
        assert!(!recovered.skipped);
        assert_eq!(
            fs::read_to_string(temp.path().join("first.txt")).unwrap(),
            "first\n"
        );
        assert!(!temp.path().join("second.txt").exists());
        assert!(provider_mutation_journal_paths(&journals)
            .unwrap()
            .is_empty());
        assert!(fs::read_dir(temp.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".gyro-")
        }));
    }

    #[test]
    fn recovery_finishes_cleanup_after_a_committed_transaction() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let journals = paths.mutation_journals_dir.clone();
        let store = SessionStore::open(paths).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "committed mutation")
            .unwrap();
        let approval_id = Uuid::new_v4();
        fs::write(temp.path().join("file.txt"), "before\n").unwrap();
        let transaction = prepare_provider_mutation_transaction(
            temp.path(),
            &[provider_change(
                "file.txt",
                "update",
                "@@ -1 +1 @@\n-before\n+after\n",
                None,
            )],
        )
        .unwrap();
        let pending = begin_provider_mutation_transaction(
            &transaction,
            &journals,
            ProviderMutationJournalContext {
                session_id: session.id,
                approval_id,
            },
        )
        .unwrap();
        store
            .append_event(
                session.id,
                SessionEventKind::SystemEvent,
                "Provider file changes applied through Gyro",
                serde_json::json!({
                    "kind": "provider-tool-approval",
                    "approvalId": approval_id,
                    "status": "applied",
                }),
            )
            .unwrap();
        drop(pending);

        let recovered = recover_provider_mutation_transactions(&journals, &store).unwrap();

        assert_eq!(recovered.finalized, 1);
        assert_eq!(recovered.rolled_back, 0);
        assert!(!recovered.skipped);
        assert_eq!(
            fs::read_to_string(temp.path().join("file.txt")).unwrap(),
            "after\n"
        );
        assert!(provider_mutation_journal_paths(&journals)
            .unwrap()
            .is_empty());
        assert!(fs::read_dir(temp.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".gyro-")
        }));
    }

    #[test]
    fn recovery_ignores_unrelated_applied_events() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let journals = paths.mutation_journals_dir.clone();
        let store = SessionStore::open(paths).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "unrelated event")
            .unwrap();
        let approval_id = Uuid::new_v4();
        fs::write(temp.path().join("file.txt"), "before\n").unwrap();
        let transaction = prepare_provider_mutation_transaction(
            temp.path(),
            &[provider_change(
                "file.txt",
                "update",
                "@@ -1 +1 @@\n-before\n+after\n",
                None,
            )],
        )
        .unwrap();
        let pending = begin_provider_mutation_transaction(
            &transaction,
            &journals,
            ProviderMutationJournalContext {
                session_id: session.id,
                approval_id,
            },
        )
        .unwrap();
        store
            .append_event(
                session.id,
                SessionEventKind::SystemEvent,
                "Unrelated event",
                serde_json::json!({
                    "kind": "not-a-provider-approval",
                    "approvalId": approval_id,
                    "status": "applied",
                }),
            )
            .unwrap();
        drop(pending);

        let recovered = recover_provider_mutation_transactions(&journals, &store).unwrap();

        assert_eq!(recovered.rolled_back, 1);
        assert_eq!(
            fs::read_to_string(temp.path().join("file.txt")).unwrap(),
            "before\n"
        );
    }

    #[test]
    fn recovery_rolls_back_when_the_session_was_deleted() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let journals = paths.mutation_journals_dir.clone();
        let store = SessionStore::open(paths).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Cli, "deleted session")
            .unwrap();
        fs::write(temp.path().join("file.txt"), "before\n").unwrap();
        let transaction = prepare_provider_mutation_transaction(
            temp.path(),
            &[provider_change(
                "file.txt",
                "update",
                "@@ -1 +1 @@\n-before\n+after\n",
                None,
            )],
        )
        .unwrap();
        let pending = begin_provider_mutation_transaction(
            &transaction,
            &journals,
            ProviderMutationJournalContext {
                session_id: session.id,
                approval_id: Uuid::new_v4(),
            },
        )
        .unwrap();
        drop(pending);
        assert!(store.delete_session(session.id).unwrap());

        let recovered = recover_provider_mutation_transactions(&journals, &store).unwrap();

        assert_eq!(recovered.rolled_back, 1);
        assert_eq!(
            fs::read_to_string(temp.path().join("file.txt")).unwrap(),
            "before\n"
        );
    }

    #[test]
    fn recovery_preserves_a_stale_target_and_journal_for_manual_review() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let journals = paths.mutation_journals_dir.clone();
        let store = SessionStore::open(paths).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Cli, "stale recovery")
            .unwrap();
        fs::write(temp.path().join("file.txt"), "before\n").unwrap();
        let transaction = prepare_provider_mutation_transaction(
            temp.path(),
            &[provider_change(
                "file.txt",
                "update",
                "@@ -1 +1 @@\n-before\n+after\n",
                None,
            )],
        )
        .unwrap();
        let pending = begin_provider_mutation_transaction(
            &transaction,
            &journals,
            ProviderMutationJournalContext {
                session_id: session.id,
                approval_id: Uuid::new_v4(),
            },
        )
        .unwrap();
        let journal_path = pending.journal_path.clone();
        drop(pending);
        fs::write(temp.path().join("file.txt"), "newer user content\n").unwrap();

        let report = recover_provider_mutation_transactions(&journals, &store).unwrap();

        assert_eq!(report.quarantined, 1);
        assert_eq!(report.finalized, 0);
        assert_eq!(report.rolled_back, 0);
        assert_eq!(
            fs::read_to_string(temp.path().join("file.txt")).unwrap(),
            "newer user content\n"
        );
        assert!(!journal_path.exists());
        let quarantined = fs::read_dir(&journals)
            .unwrap()
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("quarantined-transaction-"))
            })
            .collect::<Vec<_>>();
        assert_eq!(quarantined.len(), 1);
        assert!(fs::read_to_string(&quarantined[0])
            .unwrap()
            .contains("file.txt"));
    }

    #[test]
    fn recovery_reconciles_interrupted_applying_proposals_from_disk_state() {
        let temp = tempfile::tempdir().unwrap();
        let (store, session_id) = proposal_store(&temp);
        let applied = store
            .create_mutation_proposal(session_id, None, "applied.txt", "desired\n", None, false)
            .unwrap();
        let interrupted = store
            .create_mutation_proposal(
                session_id,
                None,
                "interrupted.txt",
                "not-written\n",
                None,
                false,
            )
            .unwrap();
        store.claim_mutation_proposal(applied.id).unwrap();
        store.claim_mutation_proposal(interrupted.id).unwrap();
        fs::write(temp.path().join("applied.txt"), "desired\n").unwrap();

        let report =
            recover_provider_mutation_transactions(&store.paths().mutation_journals_dir, &store)
                .unwrap();

        assert_eq!(report.reconciled_proposals, 2);
        let applied = store.get_mutation_proposal(applied.id).unwrap().unwrap();
        assert_eq!(applied.status, MutationProposalStatus::Applied);
        assert_eq!(applied.error, None);
        let interrupted = store
            .get_mutation_proposal(interrupted.id)
            .unwrap()
            .unwrap();
        assert_eq!(interrupted.status, MutationProposalStatus::Failed);
        assert!(interrupted
            .error
            .unwrap()
            .contains("application was interrupted"));
    }

    #[cfg(unix)]
    #[test]
    fn recovery_skips_while_another_process_holds_the_lock() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let journals = paths.mutation_journals_dir.clone();
        let store = SessionStore::open(paths).unwrap();
        let held_lock = acquire_provider_mutation_recovery_lock(&journals)
            .unwrap()
            .expect("first recovery lock");

        let report = recover_provider_mutation_transactions(&journals, &store).unwrap();

        assert!(report.skipped);
        assert_eq!(report.finalized, 0);
        assert_eq!(report.rolled_back, 0);
        drop(held_lock);
    }
}
