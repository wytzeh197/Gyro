use super::{
    files::verify_selected_sources, read_project_memory, select_memory, MemoryBudget,
    MemoryDocument, MemoryQuery, PreparedMemoryContext, DEFAULT_CONTEXT_BYTES, MAX_CONTEXT_BYTES,
    MAX_CONTEXT_ENTRIES,
};
use crate::{CapabilityAccess, CapabilityClass, Session, SessionStore};
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemorySettings {
    pub enabled: bool,
    pub suggestions: bool,
    pub max_bytes: usize,
    pub max_entries: usize,
}
impl Default for MemorySettings {
    fn default() -> Self {
        Self {
            enabled: true,
            suggestions: true,
            max_bytes: DEFAULT_CONTEXT_BYTES,
            max_entries: 4,
        }
    }
}
impl MemorySettings {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            (128..=MAX_CONTEXT_BYTES).contains(&self.max_bytes)
                && (1..=MAX_CONTEXT_ENTRIES).contains(&self.max_entries),
            "invalid project-memory context budget"
        );
        Ok(())
    }
}

/// Resolve exclusively the persisted session's authorized roots. A renderer's
/// workspace path is never used as memory read authority.
pub fn prepare_memory_context(
    store: &SessionStore,
    session: &Session,
    request: &crate::provider_runtime::types::ProviderChatRequest,
    context_window: Option<u64>,
) -> Result<PreparedMemoryContext> {
    let mut prepared = PreparedMemoryContext {
        max_bytes: DEFAULT_CONTEXT_BYTES,
        ..Default::default()
    };
    // User-facing Council models receive read-only project context too.
    // Internal purpose and advisory-session ownership define isolation.
    if request.internal_purpose.is_some()
        || store.advisory_session_purpose(session.id)?.is_some()
        || session.workspace_path.as_os_str().is_empty()
    {
        return Ok(prepared);
    }
    ensure!(
        request.session_id == session.id.to_string(),
        "memory context session mismatch"
    );
    if let Some(binding) = store.get_provider_session_binding(session.id, &request.provider_id)? {
        if binding.status == "ready" && binding.model_id == request.model_id {
            prepared.previous = store.previous_project_memory_receipt(
                session.id,
                &request.provider_id,
                &binding.resume_cursor_json,
            )?;
        }
    }
    let mut roots: Vec<_> = session.workspace_identity.roots.iter().collect();
    roots.sort_by_key(|root| root.id != session.workspace_identity.active_root_id);
    let mut remaining_entries = 4usize;
    let mut remaining_bytes = DEFAULT_CONTEXT_BYTES;
    let mut overall_budget = MemoryBudget::default().bounded(context_window);
    let mut cache = HashMap::new();
    let private = store.paths().base_dir.canonicalize()?;
    for root in roots {
        let canonical = match root.path.canonicalize() {
            Ok(path) => path,
            Err(_) => continue,
        };
        // Never read private scratch workspaces or account/provider stores.
        if canonical.starts_with(&private) {
            continue;
        }
        let workspace_key = canonical.to_string_lossy();
        let policy = store
            .get_project_capability_policy(&workspace_key)?
            .with_missing_classes_defaulted();
        // Automatic context cannot bypass a project's Ask or Deny policy.
        if policy.access_for(CapabilityClass::WorkspaceInspect) != CapabilityAccess::Allow {
            continue;
        }
        let settings = store.project_memory_settings(&workspace_key)?;
        if root.id == session.workspace_identity.active_root_id {
            overall_budget = MemoryBudget {
                max_bytes: settings.max_bytes,
                max_entries: settings.max_entries,
            }
            .bounded(context_window);
            remaining_entries = overall_budget.max_entries;
            remaining_bytes = overall_budget.max_bytes;
        }
        if !settings.enabled {
            continue;
        }
        if root.id == session.workspace_identity.active_root_id
            && session.parent_session_id.is_none()
            && request.mode == crate::provider_runtime::types::ChatMode::Normal
            && settings.suggestions
            && super::candidate_worthy_request(&request.message)
        {
            prepared.suggest_candidates = true;
        }
        settings.validate()?;
        let budget = MemoryBudget {
            max_bytes: settings.max_bytes.min(remaining_bytes),
            max_entries: settings.max_entries.min(remaining_entries),
        }
        .bounded(context_window);
        let source = match read_project_memory(&canonical) {
            Ok(Some(source)) => source,
            Ok(None) => String::new(),
            Err(_) => continue,
        };
        let mut document = match MemoryDocument::parse(&source) {
            Ok(doc) => doc,
            Err(_) => continue,
        };
        let paths: Vec<_> = request
            .attachments
            .iter()
            .filter_map(|a| a.relative_path.clone())
            .take(20)
            .collect();
        let title = request
            .goal
            .as_ref()
            .map(|goal| goal.text.as_str())
            .unwrap_or_default();
        let query = format!(
            "{}\n{}\n{}",
            request.message,
            title,
            request
                .plan
                .as_ref()
                .and_then(|p| p["title"].as_str())
                .unwrap_or_default()
        );
        let label = canonical.file_name().unwrap_or_default().to_string_lossy();
        let selection = loop {
            let mut selection = select_memory(
                &document,
                MemoryQuery {
                    root_id: &root.id,
                    root_label: &label,
                    request: &query,
                    paths: &paths,
                    requested_ids: &[],
                    budget,
                },
            );
            // A valid fact already in this provider thread need not be
            // invalidated and resent just because the next message is
            // "continue" or an unrelated question. Keep a bounded receipt of
            // retained context; a fresh dispatch never sends these entries.
            if let Some(previous_root) = prepared.previous.as_ref().and_then(|previous| {
                previous
                    .roots
                    .iter()
                    .find(|previous| previous.root_id == root.id)
            }) {
                for receipt in &previous_root.entries {
                    if selection.entries.len() >= budget.max_entries {
                        break;
                    }
                    if selection.entries.iter().any(|entry| entry.id == receipt.id) {
                        continue;
                    }
                    if let Some(entry) = document.entries.iter().find(|entry| {
                        entry.id == receipt.id
                            && entry.entry_hash == receipt.entry_hash
                            && entry.status == super::MemoryStatus::Active
                            && !entry.source_changed
                    }) {
                        selection
                            .entries
                            .push(super::selection::SelectedMemoryEntry {
                                id: entry.id.clone(),
                                key: receipt.key.clone(),
                                entry_hash: entry.entry_hash.clone(),
                                text: entry.text.split_whitespace().collect::<Vec<_>>().join(" "),
                                reason: "retained",
                            });
                    }
                }
            }
            let ids: Vec<_> = selection
                .entries
                .iter()
                .map(|entry| entry.id.clone())
                .collect();
            if !verify_selected_sources(&mut document, &canonical, &private, &ids, &mut cache) {
                break selection;
            }
        };
        remaining_entries = remaining_entries.saturating_sub(selection.entries.len());
        remaining_bytes = remaining_bytes.saturating_sub(
            selection
                .entries
                .iter()
                .filter(|entry| entry.reason != "retained")
                .map(|entry| entry.text.len() + entry.key.len() + 7)
                .sum::<usize>()
                + selection.root_label.len()
                + 3,
        );
        prepared.selections.push(selection);
    }
    // The renderer reserves its own single header and applies the final global
    // cap, including root labels and invalidations, across all authorized roots.
    prepared.max_bytes = overall_budget.max_bytes;
    Ok(prepared)
}
