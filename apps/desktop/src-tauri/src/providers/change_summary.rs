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
    sync::{Arc, LazyLock, Mutex, TryLockError, Weak},
};
use tauri::Manager;
use uuid::Uuid;

#[derive(Eq, Hash, PartialEq)]
struct SummaryKey {
    workspace: String,
    hash: String,
}

type SummaryLocks = Mutex<HashMap<SummaryKey, Weak<Mutex<()>>>>;
static SUMMARY_LOCKS: LazyLock<SummaryLocks> = LazyLock::new(Mutex::default);

fn summary_locks<'a>(
    workspace: &str,
    missing: &'a [(String, String)],
    requested: &[String],
) -> Result<Vec<(&'a str, Arc<Mutex<()>>)>, String> {
    let mut locks = SUMMARY_LOCKS.lock().map_err(to_string)?;
    locks.retain(|_, lock| lock.strong_count() > 0);
    let mut jobs = Vec::new();
    for (path, hash) in missing.iter().filter(|(path, _)| requested.contains(path)) {
        if jobs.iter().any(|(previous, _)| *previous == path) {
            continue;
        }
        let entry = locks.entry(SummaryKey {
            workspace: workspace.to_string(),
            hash: hash.clone(),
        });
        let lock = entry.or_default();
        let lock = lock.upgrade().unwrap_or_else(|| {
            let strong = Arc::new(Mutex::new(()));
            *lock = Arc::downgrade(&strong);
            strong
        });
        jobs.push((path.as_str(), lock));
    }
    Ok(jobs)
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
    let mut summarize = Some(summarize);
    loop {
        let (mut prompt, mut requested) = build_summary_prompt(pending.iter().copied());
        if requested.is_empty() {
            break;
        }
        // Reserve only files the prompt could fit. If another review already
        // owns some, the remaining files can still be sent without waiting.
        let locks = summary_locks(workspace_key, &missing, &requested)?;
        let mut owned = Vec::new();
        let mut shared = Vec::new();
        for (path, lock) in &locks {
            match lock.try_lock() {
                Ok(guard) => owned.push((*path, guard)),
                Err(TryLockError::Poisoned(error)) => owned.push((*path, error.into_inner())),
                Err(TryLockError::WouldBlock) => shared.push(lock),
            }
        }
        let mut completed = store
            .cached_file_change_summaries(workspace_key, &missing)
            .map_err(to_string)?;
        completed.retain(|summary| !resolved.contains_key(&summary.path));
        if !completed.is_empty() {
            // A result arrived before we reserved its diff. Repack the prompt
            // so trailing files can use the newly available space.
            resolved.extend(
                completed
                    .into_iter()
                    .map(|summary| (summary.path.clone(), summary)),
            );
            pending.retain(|file| !resolved.contains_key(&file.path));
            continue;
        }
        if !shared.is_empty() {
            (prompt, requested) = build_summary_prompt(
                pending
                    .iter()
                    .copied()
                    .filter(|file| owned.iter().any(|(path, _)| *path == file.path)),
            );
        }
        if !requested.is_empty() {
            let run = summarize.take().expect("one summary call per review");
            match run(prompt) {
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
        // Release our diffs before waiting. Two overlapping reviews can each
        // generate different files and then reuse each other's cached results.
        drop(owned);
        if shared.is_empty() {
            break;
        }
        for lock in shared {
            drop(lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner()));
        }
        if summarize.is_none() {
            match store.cached_file_change_summaries(workspace_key, &missing) {
                Ok(completed) => resolved.extend(
                    completed
                        .into_iter()
                        .map(|summary| (summary.path.clone(), summary)),
                ),
                Err(error) => eprintln!("could not reuse file change summaries: {error}"),
            }
            break;
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
    fn overlapping_reviews_share_the_common_diff_and_send_unique_files_in_parallel() {
        let temp = tempfile::tempdir().unwrap();
        let paths = gyro_core::GyroPaths::from_base_dir(temp.path().join("data"));
        let workspace = temp.path().to_str().unwrap();
        let input = |path: &str| FileChangeInput {
            path: path.into(),
            diff: format!("@@\n+change to {path}\n"),
            additions: 1,
            deletions: 0,
        };
        let first = [input("a.rs"), input("b.rs")];
        let second = [input("b.rs"), input("c.rs")];
        let (first_started, first_running) = mpsc::channel();
        let (second_started, second_running) = mpsc::channel();
        let (finish_first, first_released) = mpsc::channel();
        let timeout = Duration::from_secs(5);

        thread::scope(|scope| {
            let first = scope.spawn(|| {
                let store = SessionStore::open(paths.clone()).unwrap();
                summarize_changes(&store, workspace, &first, move |prompt| {
                    assert!(
                        prompt.contains("+change to a.rs") && prompt.contains("+change to b.rs")
                    );
                    first_started.send(()).unwrap();
                    first_released.recv_timeout(timeout).unwrap();
                    Ok(r#"{"a.rs":"Records A.","b.rs":"Records B."}"#.into())
                })
                .unwrap()
            });
            first_running.recv_timeout(timeout).unwrap();

            let second = scope.spawn(|| {
                let store = SessionStore::open(paths.clone()).unwrap();
                summarize_changes(&store, workspace, &second, |prompt| {
                    assert!(prompt.contains("+change to c.rs"));
                    assert!(!prompt.contains("b.rs"));
                    second_started.send(()).unwrap();
                    Ok(r#"{"c.rs":"Records C."}"#.into())
                })
                .unwrap()
            });
            second_running.recv_timeout(timeout).unwrap();
            finish_first.send(()).unwrap();
            let first = first.join().unwrap();
            let second = second.join().unwrap();
            assert_eq!(second.len(), 2);
            assert_eq!(second[0].content_hash, first[1].content_hash);
            assert_eq!(second[0].summary, first[1].summary);
            assert_eq!(second[1].summary, "Records C.");
            assert!(second
                .iter()
                .all(|summary| summary.source == SummarySource::Provider));
        });
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
        let wanted: Vec<_> = files
            .iter()
            .map(|file| {
                (
                    file.path.clone(),
                    file_review_content_hash(&file.path, &file.diff),
                )
            })
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
        let requested: Vec<_> = files.iter().map(|file| file.path.clone()).collect();
        let locks = summary_locks(workspace, &wanted, &requested).unwrap();
        {
            let revised = [
                (
                    files[0].path.clone(),
                    file_review_content_hash(&files[0].path, "@@\n+a later edit\n"),
                ),
                wanted[1].clone(),
            ];
            let revised_locks = summary_locks(workspace, &revised, &requested).unwrap();
            assert!(!Arc::ptr_eq(&locks[0].1, &revised_locks[0].1));
            assert!(Arc::ptr_eq(&locks[1].1, &revised_locks[1].1));
            assert!(!Arc::ptr_eq(
                &locks[1].1,
                &summary_locks("unrelated workspace", &wanted, &requested).unwrap()[1].1,
            ));
        }
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
            while Arc::strong_count(&locks[1].1) < 3 {
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
