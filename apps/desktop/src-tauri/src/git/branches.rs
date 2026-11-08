//! Shared, read-only branch discovery for the desktop and agent tools.
//! Only unfinished reads are shared: a later call always reads fresh refs.
//! Reads stay worktree-specific; invalidations cover their shared Git directory.
use crate::{
    capability_output_budget,
    capability_workspace_helpers::{workspace_result_byte_limit, workspace_result_bytes_schema},
    command_execution::bounded_command_error,
    git::{
        commands::{git_command, sort_branch_catalog_entries},
        read as git_read, status_cache as git_status_cache,
        types::{GitBranchCatalog, GitBranchTip, GitLinkedWorktree},
    },
    ide::task_discovery::content_hash,
    workspace::files::workspace_root,
};
use gyro_core::CapabilityId;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Weak};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

type BranchResult = Result<GitBranchCatalog, ReadError>;

#[derive(Clone, Debug)]
enum ReadError {
    Changed,
    BudgetExpired,
    Failed(String),
}

impl std::fmt::Display for ReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Changed => f.write_str("Branch data changed during inspection; retry to refresh"),
            Self::BudgetExpired => f.write_str("Git branch inspection timed out; retry to refresh"),
            Self::Failed(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for ReadError {}

impl From<String> for ReadError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

#[derive(Default)]
struct Flight {
    common_dir: PathBuf,
    invalidated: AtomicBool,
    result: Mutex<Option<BranchResult>>,
    ready: Condvar,
}

fn flights() -> &'static Mutex<HashMap<PathBuf, Weak<Flight>>> {
    static FLIGHTS: OnceLock<Mutex<HashMap<PathBuf, Weak<Flight>>>> = OnceLock::new();
    FLIGHTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn join(root: &Path) -> anyhow::Result<(Arc<Flight>, bool)> {
    let common_dir = common_dir(root);
    let mut active = flights()
        .lock()
        .map_err(|_| anyhow::anyhow!("branch service unavailable"))?;
    if let Some(flight) = active.get(root).and_then(Weak::upgrade) {
        return Ok((flight, false));
    }
    active.retain(|_, flight| flight.strong_count() > 0);
    let flight = Arc::new(Flight {
        common_dir,
        ..Flight::default()
    });
    active.insert(root.to_owned(), Arc::downgrade(&flight));
    Ok((flight, true))
}

fn finish(root: &Path, flight: &Arc<Flight>, result: BranchResult) -> BranchResult {
    // Detach this read before publishing it. A post-mutation request must never
    // reuse a completed snapshot, even while earlier callers still hold it.
    if let Ok(mut active) = flights().lock() {
        if active
            .get(root)
            .and_then(Weak::upgrade)
            .is_some_and(|entry| Arc::ptr_eq(&entry, flight))
        {
            active.remove(root);
        }
    }
    let result = if flight.invalidated.load(Ordering::Acquire) {
        Err(ReadError::Changed)
    } else {
        result
    };
    *flight
        .result
        .lock()
        .map_err(|_| "branch service unavailable".to_string())? = Some(result.clone());
    flight.ready.notify_all();
    result
}

fn wait(flight: &Flight, deadline: Instant) -> BranchResult {
    let mut result = flight
        .result
        .lock()
        .map_err(|_| "branch service unavailable".to_string())?;
    loop {
        if flight.invalidated.load(Ordering::Acquire) {
            return Err(ReadError::Changed);
        }
        if let Some(result) = result.as_ref() {
            return result.clone();
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(ReadError::BudgetExpired);
        }
        result = flight
            .ready
            .wait_timeout(result, remaining)
            .map_err(|_| "branch service unavailable".to_string())?
            .0;
    }
}

fn common_dir(root: &Path) -> PathBuf {
    git_status_cache::git_dirs(root)
        .and_then(|(_, common)| common.canonicalize().ok())
        .unwrap_or_else(|| root.to_owned())
}

/// A mutation's follow-up read cannot join a read started before that mutation.
pub(crate) fn invalidate(workspace: &str) {
    if let Some((root, _)) = git_read::discover_repository(Path::new(workspace)) {
        let common_dir = common_dir(&root);
        if let Ok(mut active) = flights().lock() {
            active.retain(|_, entry| {
                let Some(flight) = entry.upgrade() else {
                    return false;
                };
                if flight.common_dir != common_dir {
                    return true;
                }
                let _result = flight.result.lock().ok();
                flight.invalidated.store(true, Ordering::Release);
                flight.ready.notify_all();
                false
            });
        }
    }
}

pub(crate) fn git_branch_catalog_impl(workspace: &str) -> anyhow::Result<GitBranchCatalog> {
    git_branch_catalog_before(workspace, Instant::now() + Duration::from_secs(30))
}

pub(crate) fn git_branch_catalog_before(
    workspace: &str,
    deadline: Instant,
) -> anyhow::Result<GitBranchCatalog> {
    anyhow::ensure!(
        Instant::now() < deadline,
        "Git branch inspection timed out; retry to refresh"
    );
    let workspace = workspace_root(workspace)?;
    let Some(root) = git_read::repo_root(&workspace, deadline)? else {
        return Ok(GitBranchCatalog {
            available: false,
            repo_root: None,
            current: None,
            branches: Vec::new(),
            last_commit_at: HashMap::new(),
            tips: Vec::new(),
            latest_commit_at: None,
            checked_at: chrono::Utc::now().to_rfc3339(),
            worktrees: Vec::new(),
            error: Some("The selected folder is not a Git repository.".into()),
        });
    };
    shared_catalog(&root, deadline, read_catalog)
}

fn shared_catalog(
    root: &Path,
    deadline: Instant,
    mut read: impl FnMut(&Path, Instant) -> anyhow::Result<GitBranchCatalog>,
) -> anyhow::Result<GitBranchCatalog> {
    // A foreground request can retry a short preparation read's timeout with
    // its own remaining budget. Repeated mutations still stop after 3 attempts.
    for attempt in 0..3 {
        if Instant::now() >= deadline {
            return Err(ReadError::BudgetExpired.into());
        }
        let (flight, leader) = join(root)?;
        let result = if leader {
            let result = read(root, deadline).map_err(|error| {
                if let Some(error) = error.downcast_ref::<ReadError>() {
                    return error.clone();
                }
                if Instant::now() >= deadline {
                    ReadError::BudgetExpired
                } else {
                    ReadError::Failed(error.to_string())
                }
            });
            finish(root, &flight, result)
        } else {
            wait(&flight, deadline)
        };
        match result {
            Err(ReadError::Changed | ReadError::BudgetExpired)
                if attempt < 2 && Instant::now() < deadline =>
            {
                continue
            }
            result => return result.map_err(anyhow::Error::new),
        }
    }
    Err(ReadError::Changed.into())
}

fn read_catalog(root: &Path, deadline: Instant) -> anyhow::Result<GitBranchCatalog> {
    // One ref pass reads both local and last-fetched remote tips. Worktree
    // porcelain supplies HEAD too, including unborn and detached worktrees.
    let (output, worktrees) = std::thread::scope(|scope| {
        let worktrees = scope.spawn(|| read_worktrees(root, deadline));
        let mut command = git_command();
        command.arg("-C").arg(root).args([
            "for-each-ref",
            "--format=%(refname)%09%(objectname)%09%(committerdate:unix)%09%(symref)",
            "refs/heads/",
            "refs/remotes/",
        ]);
        let output = git_read::run(&command, deadline, 4 * 1024 * 1024);
        (
            output,
            worktrees
                .join()
                .map_err(|_| anyhow::anyhow!("worktree inspection worker failed")),
        )
    });
    let output = output?;
    anyhow::ensure!(
        output.succeeded() && !output.stdout_truncated,
        "{}",
        bounded_command_error("could not list branches", &output)
    );
    let WorktreeCatalog {
        current,
        head_commit,
        others: worktrees,
    } = worktrees??;
    let mut tips = output
        .stdout
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            let reference = fields.next()?;
            let commit = fields.next()?;
            let committed_at = fields.next()?.parse::<i64>().ok();
            let symbolic_target = fields.next().filter(|target| !target.is_empty());
            let (name, remote) = if let Some(name) = reference.strip_prefix("refs/heads/") {
                (name, false)
            } else {
                (reference.strip_prefix("refs/remotes/")?, true)
            };
            if remote && symbolic_target.is_some() {
                return None;
            }
            let is_current = !remote && current.as_deref() == Some(name);
            let worktree_path = if remote {
                None
            } else if is_current {
                Some(root.to_string_lossy().into_owned())
            } else {
                worktrees
                    .iter()
                    .find(|tree| tree.branch == name)
                    .map(|tree| tree.path.clone())
            };
            Some(GitBranchTip {
                name: name.into(),
                reference: reference.into(),
                commit: commit.into(),
                symbolic_target: symbolic_target.map(str::to_owned),
                committed_at,
                remote,
                current: is_current,
                worktree_path,
            })
        })
        .collect::<Vec<_>>();
    validate_current_tip(&tips, current.as_deref(), head_commit.as_deref())?;
    tips.sort_by(|a, b| {
        b.committed_at
            .cmp(&a.committed_at)
            .then(a.remote.cmp(&b.remote))
            .then(a.name.cmp(&b.name))
    });
    let latest_commit_at = tips.iter().filter_map(|tip| tip.committed_at).max();
    let last_commit_at = tips
        .iter()
        .filter(|tip| !tip.remote)
        .filter_map(|tip| tip.committed_at.map(|date| (tip.name.clone(), date)))
        .collect();
    let mut local = tips
        .iter()
        .filter(|tip| !tip.remote)
        .map(|tip| (tip.committed_at.unwrap_or(i64::MIN), tip.name.clone()))
        .collect::<Vec<_>>();
    sort_branch_catalog_entries(&mut local);
    Ok(GitBranchCatalog {
        available: true,
        repo_root: Some(root.to_string_lossy().into_owned()),
        current,
        branches: local.into_iter().map(|(_, branch)| branch).collect(),
        last_commit_at,
        tips,
        latest_commit_at,
        checked_at: chrono::Utc::now().to_rfc3339(),
        worktrees,
        error: None,
    })
}

fn validate_current_tip(
    tips: &[GitBranchTip],
    current: Option<&str>,
    head: Option<&str>,
) -> anyhow::Result<()> {
    let Some(current) = current else {
        return Ok(());
    };
    let tip = tips.iter().find(|tip| !tip.remote && tip.name == current);
    let consistent = match (tip, head) {
        (Some(tip), Some(head)) => tip.commit == head,
        (None, Some(head)) => !head.is_empty() && head.bytes().all(|byte| byte == b'0'),
        _ => false,
    };
    if !consistent {
        return Err(ReadError::Changed.into());
    }
    Ok(())
}

struct WorktreeCatalog {
    current: Option<String>,
    head_commit: Option<String>,
    others: Vec<GitLinkedWorktree>,
}

fn read_worktrees(root: &Path, deadline: Instant) -> anyhow::Result<WorktreeCatalog> {
    let mut command = git_command();
    command
        .arg("-C")
        .arg(root)
        .args(["worktree", "list", "--porcelain", "-z"]);
    let output = git_read::run(&command, deadline, 2 * 1024 * 1024)?;
    anyhow::ensure!(
        output.succeeded() && !output.stdout_truncated,
        "{}",
        bounded_command_error("could not list linked worktrees", &output)
    );
    let mut current = None;
    let mut head_commit = None;
    let mut others = Vec::new();
    let mut path: Option<String> = None;
    let mut branch = None;
    let mut commit = None;
    for field in output.stdout.split('\0').chain(std::iter::once("")) {
        if field.is_empty() {
            if let Some(path) = path.take() {
                let same = Path::new(&path)
                    .canonicalize()
                    .unwrap_or_else(|_| PathBuf::from(&path))
                    == root;
                if same {
                    current = branch.take();
                    head_commit = commit.take();
                } else if let Some(branch) = branch.take() {
                    others.push(GitLinkedWorktree { branch, path });
                }
            }
            branch = None;
            commit = None;
        } else if let Some(value) = field.strip_prefix("worktree ") {
            path = Some(value.to_owned());
        } else if let Some(value) = field.strip_prefix("branch refs/heads/") {
            branch = Some(value.to_owned());
        } else if let Some(value) = field.strip_prefix("HEAD ") {
            commit = Some(value.to_owned());
        }
    }
    Ok(WorktreeCatalog {
        current,
        head_commit,
        others,
    })
}

pub(crate) fn linked_worktrees(
    root: &Path,
    deadline: Instant,
) -> anyhow::Result<Vec<GitLinkedWorktree>> {
    let root = root.canonicalize()?;
    Ok(read_worktrees(&root, deadline)?.others)
}

pub(crate) fn model_branches(workspace: &str, arguments: &Value) -> anyhow::Result<Value> {
    let max_bytes = workspace_result_byte_limit(arguments)?;
    let offset = capability_output_budget::offset(arguments, "offset")?.unwrap_or(0);
    let limit = arguments
        .get("limit")
        .map(|value| {
            value
                .as_u64()
                .filter(|limit| (1..=100).contains(limit))
                .map(|limit| limit as usize)
                .ok_or_else(|| anyhow::anyhow!("limit must be an integer between 1 and 100"))
        })
        .transpose()?
        .unwrap_or(20);
    let scope = arguments
        .get("scope")
        .map(|value| {
            value
                .as_str()
                .filter(|scope| ["all", "local", "remote"].contains(scope))
                .ok_or_else(|| anyhow::anyhow!("scope must be all, local, or remote"))
        })
        .transpose()?
        .unwrap_or("all");
    let query = arguments
        .get("query")
        .map(|value| {
            value
                .as_str()
                .filter(|query| query.chars().count() <= 256)
                .ok_or_else(|| anyhow::anyhow!("query must be a string of at most 256 characters"))
        })
        .transpose()?
        .unwrap_or("")
        .to_lowercase();
    let expected_snapshot = arguments
        .get("snapshotId")
        .map(|value| {
            value
                .as_str()
                .filter(|id| {
                    id.len() == 64
                        && id
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                })
                .ok_or_else(|| {
                    anyhow::anyhow!("snapshotId must be a 64-character lowercase snapshot hash")
                })
        })
        .transpose()?;
    anyhow::ensure!(
        offset == 0 || expected_snapshot.is_some(),
        "snapshotId is required for another page; restart from offset 0"
    );
    let catalog = git_branch_catalog_impl(workspace)?;
    let scoped = catalog
        .tips
        .iter()
        .filter(|tip| scope == "all" || (scope == "remote") == tip.remote)
        .collect::<Vec<_>>();
    let latest_in_scope = scoped.iter().filter_map(|tip| tip.committed_at).max();
    let filtered = scoped
        .into_iter()
        .filter(|tip| tip.name.to_lowercase().contains(&query))
        .collect::<Vec<_>>();
    let latest = filtered.iter().filter_map(|tip| tip.committed_at).max();
    let snapshot_id = content_hash(&serde_json::to_vec(&(
        &catalog.repo_root,
        &catalog.current,
        &catalog.tips,
        scope,
        &query,
    ))?);
    if let Some(expected) = expected_snapshot {
        anyhow::ensure!(
            expected == snapshot_id,
            "Branch list changed; restart from offset 0 without snapshotId"
        );
    }
    let branches = filtered
        .iter()
        .skip(offset)
        .take(limit)
        .map(|tip| {
            let mut value = serde_json::to_value(tip)?;
            value["latest"] = json!(latest.is_some() && tip.committed_at == latest);
            Ok(value)
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    capability_output_budget::array_result(
        json!({
            "schema": "gyro.git-branches.v1", "available": catalog.available,
            "repoRoot": catalog.repo_root, "current": catalog.current, "checkedAt": catalog.checked_at,
            "remoteRefs": "last-fetched", "scope": scope, "latestCommitAt": latest,
            "latestInScopeCommitAt": latest_in_scope, "snapshotId": snapshot_id,
            "total": filtered.len(), "offset": offset, "branches": branches, "error": catalog.error,
        }),
        "branches",
        max_bytes,
    )
}

pub(crate) fn schema(id: CapabilityId) -> Option<(Value, Vec<&'static str>)> {
    (id == CapabilityId::WorkspaceGitBranches).then(|| (json!({
        "query": {"type":"string", "maxLength":256, "description":"Case-insensitive branch-name substring. Latest markers and latestCommitAt apply to matching branches within scope."},
        "scope": {"type":"string", "enum":["all", "local", "remote"], "default":"all"},
        "offset": {"type":"integer", "minimum":0, "description":"Use the previous result's nextOffset together with its snapshotId. Defaults to 0."},
        "limit": {"type":"integer", "minimum":1, "maximum":100, "default":20},
        "snapshotId": {"type":"string", "pattern":"^[0-9a-f]{64}$", "description":"Reuse the previous result's snapshotId with nextOffset. If branches change, restart at offset 0 without snapshotId."},
        "maxBytes": workspace_result_bytes_schema(),
    }), vec![]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        capabilities::mcp_server::desktop_capability_tool_schema,
        git::{commands::git_rename_branch_impl, types::GitCheckoutBranchRequest},
    };
    use gyro_core::CapabilityClass;
    use std::process::Command;

    fn git(root: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().into()
    }

    fn repo() -> tempfile::TempDir {
        let repo = tempfile::tempdir().unwrap();
        git(repo.path(), &["init", "-b", "main"]);
        git(repo.path(), &["config", "user.name", "Branch Test"]);
        git(
            repo.path(),
            &["config", "user.email", "branch@example.test"],
        );
        repo
    }

    fn commit(root: &Path, date: &str) {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["commit", "--allow-empty", "-m", "test tip"])
            .env("GIT_AUTHOR_DATE", date)
            .env("GIT_COMMITTER_DATE", date)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn quality_invalidation_covers_every_worktree_sharing_refs() {
        let repo = repo();
        commit(repo.path(), "2025-01-01T00:00:00Z");
        let trees = tempfile::tempdir().unwrap();
        let linked = trees.path().join("linked");
        git(
            repo.path(),
            &["worktree", "add", "-b", "linked", linked.to_str().unwrap()],
        );
        let linked = linked.canonicalize().unwrap();
        let (old, _) = join(&linked).unwrap();
        let unrelated = tempfile::tempdir().unwrap();
        git(unrelated.path(), &["init", "-b", "main"]);
        let unrelated = unrelated.path().canonicalize().unwrap();
        let (unaffected, _) = join(&unrelated).unwrap();
        invalidate(repo.path().to_str().unwrap());
        let (fresh, leader) = join(&linked).unwrap();
        let (same_unrelated, unrelated_leader) = join(&unrelated).unwrap();
        assert!(!unrelated_leader);
        assert!(Arc::ptr_eq(&unaffected, &same_unrelated));
        let _ = finish(&linked, &old, Err(ReadError::Failed("cleanup".into())));
        let _ = finish(&linked, &fresh, Err(ReadError::Failed("cleanup".into())));
        let _ = finish(
            &unrelated,
            &unaffected,
            Err(ReadError::Failed("cleanup".into())),
        );
        assert!(
            leader,
            "a main-worktree mutation must invalidate linked-worktree reads"
        );
        assert!(!Arc::ptr_eq(&old, &fresh));
    }

    #[test]
    fn quality_local_symbolic_branches_stay_discoverable() {
        let repo = repo();
        commit(repo.path(), "2025-01-01T00:00:00Z");
        git(
            repo.path(),
            &[
                "symbolic-ref",
                "refs/heads/current-release",
                "refs/heads/main",
            ],
        );
        let catalog = git_branch_catalog_impl(repo.path().to_str().unwrap()).unwrap();
        assert!(catalog.branches.contains(&"current-release".into()));
        assert_eq!(
            catalog
                .tips
                .iter()
                .find(|tip| tip.name == "current-release")
                .unwrap()
                .symbolic_target
                .as_deref(),
            Some("refs/heads/main")
        );
    }

    #[test]
    fn quality_invalidated_results_retry_with_a_fixed_budget_and_attempt_limit() {
        let repo = repo();
        commit(repo.path(), "2025-01-01T00:00:00Z");
        let root = repo.path().canonicalize().unwrap();
        let catalog = read_catalog(&root, Instant::now() + Duration::from_secs(5)).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut attempts = 0;
        let result = shared_catalog(&root, deadline, |root, budget| {
            assert_eq!(budget, deadline);
            attempts += 1;
            if attempts == 1 {
                invalidate(root.to_str().unwrap());
            }
            Ok(catalog.clone())
        })
        .unwrap();
        assert_eq!(attempts, 2);
        assert_eq!(result.current.as_deref(), Some("main"));
        attempts = 0;
        let error = shared_catalog(&root, deadline, |root, budget| {
            assert_eq!(budget, deadline);
            attempts += 1;
            invalidate(root.to_str().unwrap());
            Ok(catalog.clone())
        })
        .unwrap_err();
        assert_eq!(attempts, 3);
        assert!(error.to_string().contains("changed during inspection"));
    }

    #[test]
    fn quality_waiting_readers_recover_from_invalidations_and_short_timeouts() {
        for invalidated in [false, true] {
            let repo = repo();
            commit(repo.path(), "2025-01-01T00:00:00Z");
            let root = repo.path().canonicalize().unwrap();
            let expected = read_catalog(&root, Instant::now() + Duration::from_secs(5)).unwrap();
            let stale = expected.clone();
            let (short, _) = join(&root).unwrap();
            let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let attempts = Arc::clone(&calls);
            let workspace = root.clone();
            let reader = std::thread::spawn(move || {
                shared_catalog(
                    &workspace,
                    Instant::now() + Duration::from_secs(5),
                    |_, _| {
                        attempts.fetch_add(1, Ordering::Relaxed);
                        Ok(expected.clone())
                    },
                )
            });
            let deadline = Instant::now() + Duration::from_secs(2);
            while Arc::strong_count(&short) < 2 && Instant::now() < deadline {
                std::thread::yield_now();
            }
            assert!(
                Arc::strong_count(&short) >= 2,
                "reader joined the short request"
            );
            if invalidated {
                invalidate(root.to_str().unwrap());
            } else {
                let _ = finish(&root, &short, Err(ReadError::BudgetExpired));
            }
            assert_eq!(
                reader.join().unwrap().unwrap().current.as_deref(),
                Some("main")
            );
            assert_eq!(calls.load(Ordering::Relaxed), 1);
            if invalidated {
                assert!(matches!(
                    finish(&root, &short, Ok(stale)),
                    Err(ReadError::Changed)
                ));
            }
        }
    }

    #[test]
    fn quality_mixed_head_and_ref_snapshots_retry_instead_of_publishing() {
        let repo = repo();
        commit(repo.path(), "2025-01-01T00:00:00Z");
        let root = repo.path().canonicalize().unwrap();
        let catalog = read_catalog(&root, Instant::now() + Duration::from_secs(5)).unwrap();
        assert!(
            validate_current_tip(&catalog.tips, Some("main"), Some("different commit"))
                .unwrap_err()
                .downcast_ref::<ReadError>()
                .is_some()
        );
        assert!(validate_current_tip(&[], Some("main"), Some("different commit")).is_err());
        let mut attempts = 0;
        let result = shared_catalog(&root, Instant::now() + Duration::from_secs(2), |_, _| {
            attempts += 1;
            if attempts == 1 {
                validate_current_tip(&catalog.tips, Some("main"), Some("different commit"))?;
            }
            Ok(catalog.clone())
        })
        .unwrap();
        assert_eq!(attempts, 2);
        assert_eq!(result.current.as_deref(), Some("main"));
    }

    #[test]
    fn quality_snapshot_arguments_fail_before_touching_the_workspace() {
        for args in [
            json!({"snapshotId":true}),
            json!({"snapshotId":"bad"}),
            json!({"offset":1}),
        ] {
            let error = model_branches("/missing-branch-test-workspace", &args).unwrap_err();
            assert!(error.to_string().contains("snapshotId"));
        }
    }

    #[test]
    fn quality_pages_refuse_changed_snapshots_and_identify_latest_matching_branch() {
        let repo = repo();
        commit(repo.path(), "2025-01-01T00:00:00Z");
        git(repo.path(), &["branch", "release/old"]);
        git(repo.path(), &["switch", "-c", "release/new"]);
        commit(repo.path(), "2025-01-02T00:00:00Z");
        git(repo.path(), &["switch", "-c", "feature/newer"]);
        commit(repo.path(), "2025-01-03T00:00:00Z");
        let path = repo.path().to_str().unwrap();
        let first = model_branches(path, &json!({"query":"release/", "limit":1})).unwrap();
        assert_eq!(first["branches"][0]["latest"], true);
        assert_eq!(first["latestCommitAt"], 1735776000_i64);
        let snapshot = first["snapshotId"].as_str().expect("stable snapshot ID");
        let next = model_branches(
            path,
            &json!({"query":"release/", "offset":1, "snapshotId":snapshot}),
        )
        .unwrap();
        assert_eq!(next["branches"][0]["name"], "release/old");
        git(repo.path(), &["branch", "release/added"]);
        let error = model_branches(
            path,
            &json!({"query":"release/", "offset":1, "snapshotId":snapshot}),
        )
        .unwrap_err();
        assert!(error.to_string().contains("restart"));
    }

    #[test]
    fn branch_catalog_reads_newest_remote_tips_without_changing_the_checkout() {
        let repo = repo();
        let path = repo.path().to_str().unwrap();
        commit(repo.path(), "2025-01-01T00:00:00Z");
        git(repo.path(), &["switch", "-c", "newest"]);
        commit(repo.path(), "2025-01-02T00:00:00Z");
        git(
            repo.path(),
            &["update-ref", "refs/remotes/origin/Heads/v0.1.1", "HEAD"],
        );
        git(
            repo.path(),
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/Heads/v0.1.1",
            ],
        );
        git(repo.path(), &["switch", "main"]);
        git(repo.path(), &["branch", "-D", "newest"]);
        // A local branch can be named like a remote. Full ref names keep them distinct.
        git(repo.path(), &["branch", "origin/Heads/v0.1.1"]);
        let before = git(repo.path(), &["rev-parse", "HEAD"]);
        let catalog = git_branch_catalog_impl(path).unwrap();
        assert_eq!(catalog.current.as_deref(), Some("main"));
        assert_eq!(
            catalog.tips[0].reference,
            "refs/remotes/origin/Heads/v0.1.1"
        );
        assert!(catalog.tips[0].remote);
        assert_eq!(catalog.latest_commit_at, Some(1735776000));
        assert!(!catalog
            .tips
            .iter()
            .any(|tip| tip.reference == "refs/remotes/origin/HEAD"));
        assert!(catalog.branches.contains(&"origin/Heads/v0.1.1".into()));

        let data = model_branches(path, &json!({"query":"V0.1.1"})).unwrap();
        assert_eq!(data["remoteRefs"], "last-fetched");
        assert_eq!(data["branches"][0]["latest"], true);
        assert_eq!(
            data["branches"][0]["reference"],
            "refs/remotes/origin/Heads/v0.1.1"
        );
        assert_eq!(git(repo.path(), &["rev-parse", "HEAD"]), before);
        assert!(!repo.path().join(".git/FETCH_HEAD").exists());

        // Sequential requests must see changes made outside Gyro immediately.
        git(
            repo.path(),
            &["update-ref", "refs/remotes/origin/Heads/v0.1.1", "main"],
        );
        assert_eq!(
            git_branch_catalog_impl(path).unwrap().latest_commit_at,
            Some(1735689600)
        );
    }

    #[test]
    fn branch_catalog_identifies_linked_worktrees_with_spaces_and_newlines() {
        let repo = repo();
        commit(repo.path(), "2025-01-01T00:00:00Z");
        let trees = tempfile::tempdir().unwrap();
        let linked = trees.path().join("linked worktree\nsecond line");
        git(
            repo.path(),
            &[
                "worktree",
                "add",
                "-b",
                "feature/linked",
                linked.to_str().unwrap(),
            ],
        );
        let catalog = git_branch_catalog_impl(linked.to_str().unwrap()).unwrap();
        assert_eq!(catalog.current.as_deref(), Some("feature/linked"));
        assert!(
            catalog
                .tips
                .iter()
                .find(|tip| tip.name == "feature/linked")
                .unwrap()
                .current
        );
        let main = catalog.tips.iter().find(|tip| tip.name == "main").unwrap();
        assert_eq!(
            main.worktree_path.as_deref(),
            repo.path().canonicalize().unwrap().to_str()
        );
        let catalog = git_branch_catalog_impl(repo.path().to_str().unwrap()).unwrap();
        assert_eq!(
            catalog.worktrees[0].path,
            linked.canonicalize().unwrap().to_string_lossy()
        );
    }

    #[test]
    fn branch_catalog_handles_unborn_detached_and_non_git_folders() {
        let repo = repo();
        let path = repo.path().to_str().unwrap();
        let unborn = git_branch_catalog_impl(path).unwrap();
        assert_eq!(unborn.current.as_deref(), Some("main"));
        assert!(unborn.tips.is_empty());
        assert!(unborn.latest_commit_at.is_none());
        commit(repo.path(), "2025-01-01T00:00:00Z");
        git(repo.path(), &["switch", "--detach"]);
        let detached = git_branch_catalog_impl(path).unwrap();
        assert!(detached.current.is_none());
        assert!(detached.tips.iter().all(|tip| !tip.current));
        let folder = tempfile::tempdir().unwrap();
        assert!(
            !git_branch_catalog_impl(folder.path().to_str().unwrap())
                .unwrap()
                .available
        );
        assert!(git_branch_catalog_before(path, Instant::now()).is_err());
    }

    #[test]
    fn overlapping_reads_share_only_unfinished_work_and_respect_invalidation() {
        let repo = repo();
        let root = repo.path().canonicalize().unwrap();
        let (first, leader) = join(&root).unwrap();
        assert!(leader);
        let (second, leader) = join(&root).unwrap();
        assert!(!leader);
        assert!(Arc::ptr_eq(&first, &second));
        invalidate(root.to_str().unwrap());
        let (after_mutation, leader) = join(&root).unwrap();
        assert!(leader);
        assert!(!Arc::ptr_eq(&first, &after_mutation));
        let _ = finish(
            &root,
            &first,
            Err(ReadError::Failed("old read failed".into())),
        );
        assert!(wait(&second, Instant::now() + Duration::from_secs(1))
            .unwrap_err()
            .to_string()
            .contains("changed during inspection"));
        // The old read finishing must not remove its replacement.
        let (joined_new, leader) = join(&root).unwrap();
        assert!(!leader);
        assert!(Arc::ptr_eq(&joined_new, &after_mutation));
        let _ = finish(
            &root,
            &after_mutation,
            Err(ReadError::Failed("new read failed".into())),
        );
        let (retry, leader) = join(&root).unwrap();
        assert!(leader, "a failed or completed read must not be cached");
        let _ = finish(&root, &retry, Err(ReadError::Failed("cleanup".into())));
    }

    #[test]
    fn a_waiting_reader_keeps_its_own_deadline() {
        let started = Instant::now();
        assert!(
            wait(&Flight::default(), started + Duration::from_millis(20))
                .unwrap_err()
                .to_string()
                .contains("timed out")
        );
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn a_refused_branch_mutation_also_detaches_older_reads() {
        let repo = repo();
        commit(repo.path(), "2025-01-01T00:00:00Z");
        git(repo.path(), &["branch", "occupied"]);
        let root = repo.path().canonicalize().unwrap();
        let (old, _) = join(&root).unwrap();
        assert!(git_rename_branch_impl(&GitCheckoutBranchRequest {
            workspace_path: root.to_string_lossy().into_owned(),
            branch: "occupied".into(),
        })
        .is_err());
        let (fresh, leader) = join(&root).unwrap();
        assert!(leader);
        assert!(!Arc::ptr_eq(&old, &fresh));
        assert_eq!(git(repo.path(), &["branch", "--show-current"]), "main");
        let _ = finish(&root, &old, Err(ReadError::Failed("cleanup".into())));
        let _ = finish(&root, &fresh, Err(ReadError::Failed("cleanup".into())));
    }

    #[test]
    fn model_branch_pages_are_bounded_and_mark_ties_without_guessing_a_winner() {
        let repo = repo();
        commit(repo.path(), "2025-01-01T00:00:00Z");
        for i in 0..25 {
            git(
                repo.path(),
                &[
                    "update-ref",
                    &format!("refs/remotes/origin/topic-{i:02}"),
                    "HEAD",
                ],
            );
        }
        let path = repo.path().to_str().unwrap();
        let args = json!({"scope":"remote", "query":"topic", "limit":5, "maxBytes":1024});
        let first = model_branches(path, &args).unwrap();
        assert!(serde_json::to_vec(&first).unwrap().len() <= 1024);
        assert_eq!(first["total"], 25);
        assert!(first["branches"]
            .as_array()
            .unwrap()
            .iter()
            .all(|tip| tip["latest"] == true));
        let mut args = args;
        args["offset"] = first["nextOffset"].clone();
        args["snapshotId"] = first["snapshotId"].clone();
        let next = model_branches(path, &args).unwrap();
        assert_ne!(
            first["branches"][0]["reference"],
            next["branches"][0]["reference"]
        );
        for args in [
            json!({"limit":0}),
            json!({"scope":"guess"}),
            json!({"query":true}),
            json!({"offset":-1}),
        ] {
            assert!(model_branches(path, &args).is_err());
        }
        let schema = desktop_capability_tool_schema(CapabilityId::WorkspaceGitBranches);
        assert_eq!(schema["additionalProperties"], false);
        assert!(schema["properties"]["rootId"].is_object());
        assert_eq!(
            gyro_core::capability_descriptor(CapabilityId::WorkspaceGitBranches).class,
            CapabilityClass::WorkspaceInspect
        );
    }

    #[test]
    #[ignore = "read-only timing probe; set GYRO_BRANCH_BENCH_WORKSPACE"]
    fn benchmark_branch_catalog() {
        let path = std::env::var("GYRO_BRANCH_BENCH_WORKSPACE").unwrap();
        let root = Path::new(&path);
        let mut old = Vec::new();
        let mut shared = Vec::new();
        let mut model = Vec::new();
        for _ in 0..15 {
            let started = Instant::now();
            for args in [
                vec![
                    "for-each-ref",
                    "--format=%(committerdate:unix)%09%(refname:short)",
                    "refs/heads/",
                ],
                vec!["branch", "--show-current"],
                vec!["worktree", "list", "--porcelain"],
            ] {
                let mut command = git_command();
                command.arg("-C").arg(root).args(args);
                assert!(git_read::run(
                    &command,
                    Instant::now() + Duration::from_secs(30),
                    2 * 1024 * 1024
                )
                .unwrap()
                .succeeded());
            }
            old.push(started.elapsed());
            let started = Instant::now();
            assert!(git_branch_catalog_impl(&path).unwrap().available);
            shared.push(started.elapsed());
            let started = Instant::now();
            assert!(model_branches(&path, &json!({"limit":5})).unwrap()["snapshotId"].is_string());
            model.push(started.elapsed());
        }
        old.sort();
        shared.sort();
        model.sort();
        eprintln!(
            "branch discovery median: previous {:?}; shared {:?}; agent {:?} (includes remote tips)",
            old[7], shared[7], model[7]
        );
    }
}
