use crate::{
    app::limits::MAX_CONCURRENT_PROVIDER_RUNS,
    providers::{
        chat_types::{ChatMode, InternalRequestPurpose, ProviderChatRequest},
        retry::run_provider_chat_with_retry,
    },
    state::{managers::ProviderCancellationManager, provider_run::ProviderRunControl},
    stores::{open_store, to_string},
    usage::guard::UsageContext,
    workspace::files::workspace_root,
};
use gyro_core::{
    build_summary_prompt, fallback_summary, file_review_content_hash, parse_summary_response,
    FileChangeInput, FileChangeSummary, SessionStore, SummarySource, UsageOrigin,
    CHANGE_SUMMARY_SYSTEM_PROMPT, MAX_SUMMARY_FILES,
};
use serde::Deserialize;
use std::{collections::HashMap, sync::Arc};
use tauri::Manager;
use uuid::Uuid;
/// What the end-of-turn review card asks for: one plain sentence per file.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SummarizeFileChangesRequest {
    pub(crate) session_id: String,
    /// The turn whose edits these are, so the call lands on that turn's line in
    /// the usage ledger instead of floating free.
    pub(crate) turn_id: Option<String>,
    pub(crate) workspace_path: String,
    pub(crate) provider_id: String,
    pub(crate) provider_label: Option<String>,
    pub(crate) model_id: Option<String>,
    pub(crate) model_label: Option<String>,
    pub(crate) files: Vec<FileChangeInput>,
}

#[tauri::command]
pub(crate) async fn summarize_file_changes(
    app: tauri::AppHandle,
    request: SummarizeFileChangesRequest,
) -> Result<Vec<FileChangeSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || summarize_file_changes_blocking(app, request))
        .await
        .map_err(|error| format!("change summary worker failed: {error}"))?
}

/// Describe a turn's changed files in one batched provider call.
///
/// The card has to render either way, so every file leaves here with a line:
/// a sentence already bought for this exact content, a sentence from this
/// call, or a count of what moved. A provider that is offline, paused by the
/// budget guard, or busy with the next turn costs the user prose, not their
/// review card, so those are not errors — see `fallback_summary`.
pub(crate) fn summarize_file_changes_blocking(
    app: tauri::AppHandle,
    request: SummarizeFileChangesRequest,
) -> Result<Vec<FileChangeSummary>, String> {
    let store = open_store()?;
    let root = workspace_root(&request.workspace_path).map_err(to_string)?;
    let workspace_key = root.display().to_string();

    let files: Vec<FileChangeInput> = request
        .files
        .iter()
        .filter(|file| !file.path.trim().is_empty())
        .take(MAX_SUMMARY_FILES)
        .cloned()
        .collect();
    if files.is_empty() {
        return Ok(Vec::new());
    }

    // The hash is the identity of the reviewed content: it is what lets a
    // summary be bought once, and what retires it the moment the file moves on.
    let hashes: Vec<String> = files
        .iter()
        .map(|file| file_review_content_hash(&file.path, &file.diff))
        .collect();
    let wanted: Vec<(String, String)> = files
        .iter()
        .zip(&hashes)
        .map(|(file, hash)| (file.path.clone(), hash.clone()))
        .collect();

    let mut resolved: HashMap<String, FileChangeSummary> = store
        .cached_file_change_summaries(&workspace_key, &wanted)
        .map_err(to_string)?
        .into_iter()
        .map(|summary| (summary.path.clone(), summary))
        .collect();

    let pending: Vec<FileChangeInput> = files
        .iter()
        .filter(|file| !resolved.contains_key(&file.path))
        .cloned()
        .collect();

    if !pending.is_empty() {
        let (prompt, requested) = build_summary_prompt(&pending);
        if !requested.is_empty() {
            match run_change_summary_call(&store, &app, &request, prompt) {
                Ok(raw) => {
                    let mut fresh: Vec<FileChangeSummary> = Vec::new();
                    for (path, summary) in parse_summary_response(&raw, &requested) {
                        let Some(index) = files.iter().position(|file| file.path == path) else {
                            continue;
                        };
                        fresh.push(FileChangeSummary {
                            path,
                            content_hash: hashes[index].clone(),
                            summary,
                            source: SummarySource::Provider,
                        });
                    }
                    let _ = store.store_file_change_summaries(&workspace_key, &fresh);
                    for summary in fresh {
                        resolved.insert(summary.path.clone(), summary);
                    }
                }
                Err(error) => eprintln!("could not summarize file changes: {error}"),
            }
        }
    }

    Ok(files
        .into_iter()
        .zip(hashes)
        .map(|(file, content_hash)| {
            resolved.remove(&file.path).unwrap_or_else(|| {
                let summary = fallback_summary(&file.diff, file.additions, file.deletions);
                FileChangeSummary {
                    path: file.path,
                    content_hash,
                    summary,
                    source: SummarySource::Fallback,
                }
            })
        })
        .collect())
}

/// One metered provider call for a whole turn's worth of files.
pub(crate) fn run_change_summary_call(
    store: &SessionStore,
    app: &tauri::AppHandle,
    request: &SummarizeFileChangesRequest,
    prompt: String,
) -> Result<String, String> {
    // A summarizer must not touch the workspace it is describing. Council mode
    // is Gyro's existing shape for exactly that — deny-all at the capability
    // gate, no tools, no approvals — so this borrows it rather than inventing a
    // weaker policy of its own.
    let summary_request = ProviderChatRequest {
        session_id: request.session_id.clone(),
        message: format!("{CHANGE_SUMMARY_SYSTEM_PROMPT}\n\n---\n\n{prompt}"),
        turn_id: request.turn_id.clone(),
        provider_id: request.provider_id.clone(),
        provider_label: request
            .provider_label
            .clone()
            .or_else(|| Some(request.provider_id.clone())),
        model_id: request.model_id.clone(),
        model_label: request.model_label.clone(),
        reasoning_effort: None,
        require_command_approval: true,
        require_file_edit_approval: true,
        full_access: false,
        suggest_title: false,
        workspace_path: Some(request.workspace_path.clone()),
        mode: ChatMode::Council,
        goal: None,
        plan: None,
        attachments: Vec::new(),
        workspace_context: None,
        workspace_check: None,
        side_chat_context: None,
        workflow_run_id: None,
        project_memory: None,        internal_purpose: Some(InternalRequestPurpose::ChangeSummary),
    };

    // The runners read their cancellation control out of this map, and the chat
    // command refuses a second run for the same session. Reserving here means a
    // message sent during the (short) summary call is refused rather than run
    // twice; skipping when the session is already busy means the next turn
    // always wins over a description of the last one.
    {
        let manager = app.state::<ProviderCancellationManager>();
        let mut flags = manager
            .flags
            .lock()
            .map_err(|_| "provider cancellation state is unavailable".to_string())?;
        if flags.contains_key(&request.session_id) {
            return Err("the session is busy, so the change summary was skipped".into());
        }
        if flags.len() >= MAX_CONCURRENT_PROVIDER_RUNS {
            return Err("too many provider runs are active for a change summary".into());
        }
        flags.insert(
            request.session_id.clone(),
            Arc::new(ProviderRunControl::default()),
        );
    }
    let result = run_provider_chat_with_retry(
        store,
        app,
        &summary_request,
        None,
        UsageContext::new(store.workflow_dispatch_origin(Uuid::parse_str(&request.session_id).map_err(to_string)?).map_err(to_string)?.filter(|origin|matches!(origin,UsageOrigin::Automation|UsageOrigin::AgentSession)).unwrap_or(UsageOrigin::ChangeSummary)),
    )
    .map(|output| output.response)
    .map_err(|error| gyro_core::security::redact_secrets(&error.to_string()));
    app.state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .map(|mut flags| flags.remove(&request.session_id));
    result
}
