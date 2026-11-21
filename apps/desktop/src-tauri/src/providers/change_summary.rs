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
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, Mutex, Weak},
};
use tauri::Manager;
use uuid::Uuid;

#[derive(Eq, Hash, PartialEq)]
struct SummaryBatch {
    workspace: String,
    hashes: Vec<String>,
}

type BatchLocks = Mutex<HashMap<SummaryBatch, Weak<Mutex<()>>>>;
static BATCH_LOCKS: LazyLock<BatchLocks> = LazyLock::new(Mutex::default);

fn batch_lock(workspace: &str, hashes: &[String]) -> Result<Arc<Mutex<()>>, String> {
    let mut key = SummaryBatch {
        workspace: workspace.to_string(),
        hashes: hashes.to_vec(),
    };
    key.hashes.sort_unstable();
    key.hashes.dedup();
    let mut locks = BATCH_LOCKS.lock().map_err(to_string)?;
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    // A larger batch can satisfy the entire request. Partial matches keep
    // their own lock so unrelated diffs can still be summarized in parallel.
    if let Some(lock) = locks
        .iter()
        .filter(|(batch, _)| {
            batch.workspace == key.workspace
                && key
                    .hashes
                    .iter()
                    .all(|hash| batch.hashes.binary_search(hash).is_ok())
        })
        .find_map(|(_, lock)| lock.upgrade())
    {
        return Ok(lock);
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    Ok(lock)
}

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
    summarize_changes(&store, &workspace_key, &request.files, |prompt| {
        run_change_summary_call(&store, &app, &request, prompt)
    })
}

fn summarize_changes(
    store: &SessionStore,
    workspace_key: &str,
    files: &[FileChangeInput],
    summarize: impl FnOnce(String) -> Result<String, String>,
) -> Result<Vec<FileChangeSummary>, String> {
    let files: Vec<&FileChangeInput> = files
        .iter()
        .filter(|file| !file.path.trim().is_empty())
        .take(MAX_SUMMARY_FILES)
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
        .cached_file_change_summaries(workspace_key, &wanted)
        .map_err(to_string)?
        .into_iter()
        .map(|summary| (summary.path.clone(), summary))
        .collect();

    let missing: Vec<_> = wanted
        .into_iter()
        .filter(|(path, _)| !resolved.contains_key(path))
        .collect();
    let mut pending: Vec<_> = files
        .iter()
        .copied()
        .filter(|file| !resolved.contains_key(&file.path))
        .collect();
    let (mut prompt, mut requested) = build_summary_prompt(pending.iter().copied());
    if !requested.is_empty() {
        // Offer only the diffs in this prompt to concurrent readers. Byte
        // limits may exclude some of the outstanding files from this batch.
        let prompt_hashes: Vec<_> = missing
            .iter()
            .filter(|(path, _)| requested.contains(path))
            .map(|(_, hash)| hash.clone())
            .collect();
        let lock = batch_lock(workspace_key, &prompt_hashes)?;
        let _batch = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let completed = store
            .cached_file_change_summaries(workspace_key, &missing)
            .map_err(to_string)?;
        if !completed.is_empty() {
            resolved.extend(
                completed
                    .into_iter()
                    .map(|summary| (summary.path.clone(), summary)),
            );
            pending.retain(|file| !resolved.contains_key(&file.path));
            (prompt, requested) = build_summary_prompt(pending);
        }
        if !requested.is_empty() {
            match summarize(prompt) {
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
                    let _ = store.store_file_change_summaries(workspace_key, &fresh);
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
                    path: file.path.clone(),
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
        project_memory: None,
        internal_purpose: Some(InternalRequestPurpose::ChangeSummary),
    };
    let origin = store
        .workflow_dispatch_origin(Uuid::parse_str(&request.session_id).map_err(to_string)?)
        .map_err(to_string)?
        .filter(|origin| matches!(origin, UsageOrigin::Automation | UsageOrigin::AgentSession))
        .unwrap_or(UsageOrigin::ChangeSummary);

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
        UsageContext::new(origin),
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::mpsc,
        thread,
        time::{Duration, Instant},
    };

    #[test]
    fn concurrent_chats_buy_one_summary_for_the_same_changes() {
        assert_concurrent_chats_share_summaries(false);
    }

    #[test]
    fn concurrent_chats_share_the_in_flight_batch_covering_their_cache_misses() {
        assert_concurrent_chats_share_summaries(true);
    }

    #[test]
    fn a_diff_omitted_by_the_prompt_budget_can_be_summarized_concurrently() {
        let temp = tempfile::tempdir().unwrap();
        let paths = gyro_core::GyroPaths::from_base_dir(temp.path().join("data"));
        let workspace = temp.path().to_str().unwrap();
        let mut files: Vec<_> = (0..8)
            .map(|index| FileChangeInput {
                path: format!("large-{index}.rs"),
                diff: "+kind\n".repeat(1000),
                additions: 1000,
                deletions: 0,
            })
            .collect();
        let tail = FileChangeInput {
            path: "tail.rs".into(),
            diff: "@@\n+later file\n".into(),
            additions: 1,
            deletions: 0,
        };
        files.push(tail.clone());
        let (started, running) = mpsc::channel();
        let (finish, released) = mpsc::channel();
        let (tail_finished, tail_result) = mpsc::channel();
        let timeout = Duration::from_secs(5);
        thread::scope(|scope| {
            let original = scope.spawn(|| {
                let store = SessionStore::open(paths.clone()).unwrap();
                summarize_changes(&store, workspace, &files, move |prompt| {
                    assert!(prompt.contains("large-7.rs"));
                    assert!(!prompt.contains("tail.rs"));
                    started.send(()).unwrap();
                    released.recv_timeout(timeout).unwrap();
                    Ok("{}".into())
                })
                .unwrap()
            });
            running.recv_timeout(timeout).unwrap();
            scope.spawn(|| {
                let store = SessionStore::open(paths.clone()).unwrap();
                let summary = summarize_changes(&store, workspace, &[tail], |prompt| {
                    assert!(prompt.contains("+later file"));
                    Ok(r#"{"tail.rs":"Records the later change."}"#.into())
                })
                .unwrap();
                tail_finished.send(summary).unwrap();
            });
            let summary = tail_result.recv_timeout(timeout).unwrap();
            finish.send(()).unwrap();
            assert_eq!(summary[0].source, SummarySource::Provider);
            assert_eq!(
                original.join().unwrap().last().unwrap().source,
                SummarySource::Fallback
            );
        });
    }

    fn assert_concurrent_chats_share_summaries(one_already_cached: bool) {
        let temp = tempfile::tempdir().unwrap();
        let paths = gyro_core::GyroPaths::from_base_dir(temp.path().join("data"));
        let store = SessionStore::open(paths.clone()).unwrap();
        let workspace = temp.path().to_str().unwrap();
        let files = [
            FileChangeInput {
                path: "a.rs".into(),
                diff: "@@\n+first change\n".into(),
                additions: 1,
                deletions: 0,
            },
            FileChangeInput {
                path: "b.rs".into(),
                diff: "@@\n+second change\n".into(),
                additions: 1,
                deletions: 0,
            },
        ];
        let hashes: Vec<_> = files
            .iter()
            .map(|file| file_review_content_hash(&file.path, &file.diff))
            .collect();
        let previous = FileChangeInput {
            path: "previous.rs".into(),
            diff: "@@\n+previous change\n".into(),
            additions: 1,
            deletions: 0,
        };
        let previous_summary = FileChangeSummary {
            path: previous.path.clone(),
            content_hash: file_review_content_hash(&previous.path, &previous.diff),
            summary: "Records the previous change.".into(),
            source: SummarySource::Provider,
        };
        store
            .store_file_change_summaries(workspace, std::slice::from_ref(&previous_summary))
            .unwrap();
        let batch = batch_lock(workspace, &hashes).unwrap();
        let changed = file_review_content_hash(&files[0].path, "@@\n+a later edit\n");
        assert!(!Arc::ptr_eq(
            &batch,
            &batch_lock(workspace, &[hashes[1].clone(), changed]).unwrap(),
        ));
        assert!(!Arc::ptr_eq(
            &batch,
            &batch_lock("unrelated workspace", &hashes).unwrap(),
        ));
        let (started, running) = mpsc::channel();
        let (finish, released) = mpsc::channel();
        let timeout = Duration::from_secs(5);

        thread::scope(|scope| {
            let original = scope.spawn(|| {
                let store = SessionStore::open(paths.clone()).unwrap();
                summarize_changes(&store, workspace, &files, move |prompt| {
                    assert!(prompt.contains("+first change") && prompt.contains("+second change"));
                    started.send(()).unwrap();
                    released.recv_timeout(timeout).unwrap();
                    Ok(r#"{"a.rs":"Records the first change.","b.rs":"Records the second change."}"#.into())
                })
                .unwrap()
            });
            running.recv_timeout(timeout).unwrap();

            let other = scope.spawn(|| {
                let store = SessionStore::open(paths.clone()).unwrap();
                let review = [
                    files[1].clone(),
                    if one_already_cached {
                        previous.clone()
                    } else {
                        files[0].clone()
                    },
                ];
                summarize_changes(&store, workspace, &review, |_| {
                    panic!("the in-flight result should have been reused")
                })
                .unwrap()
            });
            let deadline = Instant::now() + timeout;
            // The second request must reach the locked batch before the first
            // gets its reply. A sequential cache hit cannot pass this check.
            while Arc::strong_count(&batch) < 3 {
                assert!(
                    Instant::now() < deadline,
                    "second request did not join the batch"
                );
                thread::sleep(Duration::from_millis(1));
            }
            finish.send(()).unwrap();
            let first = original.join().unwrap();
            let second = other.join().unwrap();
            assert_eq!(first.len(), 2);
            assert_eq!(second.len(), 2);
            let expected = [
                &first[1],
                if one_already_cached {
                    &previous_summary
                } else {
                    &first[0]
                },
            ];
            for (first, second) in expected.into_iter().zip(&second) {
                assert_eq!(first.path, second.path);
                assert_eq!(first.content_hash, second.content_hash);
                assert_eq!(first.summary, second.summary);
                assert_eq!(second.source, SummarySource::Provider);
            }
        });
    }
}
