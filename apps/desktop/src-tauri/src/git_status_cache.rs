//! The Git status read layer: porcelain v2 parsing, the per-repository
//! snapshot cache, and the diff line stats that decorate Source Control.
use super::*;

pub(super) fn git_status_cache() -> &'static Mutex<HashMap<PathBuf, (String, SourceControlStatus)>>
{
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, (String, SourceControlStatus)>>> =
        OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn git_status_stamp(
    repo_root: &Path,
    porcelain: &str,
    files: &[SourceControlFile],
) -> String {
    let mut material = format!("{}\n{}", repo_root.display(), porcelain);
    // Resolve the base even in linked worktrees and when refs are packed.
    material.push_str(&git_main_comparison_base(repo_root).unwrap_or_default());
    for path in [
        Some(".git/HEAD"),
        Some(".git/packed-refs"),
        Some(".git/refs/heads/main"),
        Some(".git/refs/heads/master"),
    ]
    .into_iter()
    .chain(
        files
            .iter()
            .flat_map(|file| [Some(file.path.as_str()), file.original_path.as_deref()]),
    )
    .flatten()
    {
        material.push('\n');
        material.push_str(path);
        match fs::symlink_metadata(repo_root.join(path)) {
            Ok(metadata) => {
                material.push('\t');
                material.push_str(&metadata.len().to_string());
                if let Ok(modified) = metadata.modified() {
                    if let Ok(elapsed) = modified.duration_since(SystemTime::UNIX_EPOCH) {
                        material.push('\t');
                        material.push_str(&elapsed.as_nanos().to_string());
                    }
                }
            }
            Err(_) => material.push_str("\tmissing"),
        }
    }
    content_hash(material.as_bytes())
}

pub(super) fn cached_git_status(repo_root: &Path, stamp: &str) -> Option<SourceControlStatus> {
    let cache = git_status_cache().lock().ok()?;
    let (cached_stamp, status) = cache.get(repo_root)?;
    if cached_stamp != stamp {
        return None;
    }
    let mut status = status.clone();
    status.last_checked_at = Some(chrono::Utc::now().to_rfc3339());
    Some(status)
}

pub(super) fn store_git_status(repo_root: PathBuf, stamp: String, status: SourceControlStatus) {
    let Ok(mut cache) = git_status_cache().lock() else {
        return;
    };
    // A preparation snapshot carries no line stats, so it only ever fills a gap:
    // it must not displace the detailed snapshot whose stamp gates the reuse.
    if !stamp.is_empty() || !cache.contains_key(&repo_root) {
        cache.insert(repo_root.clone(), (stamp, status));
    }
    while cache.len() > MAX_GIT_STATUS_CACHES {
        let oldest = cache
            .keys()
            .find(|path| *path != &repo_root)
            .cloned()
            .or_else(|| cache.keys().next().cloned());
        let Some(path) = oldest else {
            break;
        };
        cache.remove(&path);
    }
}

/// The last snapshot any read stored for this repository.
pub(super) fn last_git_status(repo_root: &Path) -> Option<SourceControlStatus> {
    let cache = git_status_cache().lock().ok()?;
    cache.get(repo_root).map(|(_, status)| status.clone())
}

/// A read that failed says nothing about what changed, so it must never be
/// published as "nothing changed": that emptied Source Control and dropped every
/// file decoration until a later read happened to land. When the read ran out of
/// budget — what a large or iCloud-evicted checkout does — the last snapshot for
/// the repository is returned with the reason attached instead.
pub(super) fn git_status_read_failure(
    repo_root: Option<&Path>,
    error: String,
    transient: bool,
) -> SourceControlStatus {
    let unavailable = |error: String| SourceControlStatus {
        provider: "git".into(),
        available: false,
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        repo_root: None,
        additions: 0,
        deletions: 0,
        stats_partial: false,
        compared_to_main: None,
        files: Vec::new(),
        history: Vec::new(),
        history_error: None,
        last_checked_at: None,
        error: Some(error),
    };
    if transient {
        if let Some(last) = repo_root.and_then(last_git_status) {
            return SourceControlStatus {
                error: Some(format!("{error} — showing the last known changes")),
                ..last
            };
        }
    }
    unavailable(error)
}

pub(super) fn git_status_impl(workspace_path: &str) -> anyhow::Result<SourceControlStatus> {
    inspect_git_status(workspace_path, true)
}

pub(super) fn git_status_for_preparation(
    workspace_path: &str,
) -> anyhow::Result<SourceControlStatus> {
    inspect_git_status(workspace_path, false)
}

pub(super) fn inspect_git_status(
    workspace_path: &str,
    detailed: bool,
) -> anyhow::Result<SourceControlStatus> {
    let deadline = Instant::now()
        + if detailed {
            GIT_STATUS_TIMEOUT
        } else {
            GIT_STATUS_PREPARATION_TIMEOUT
        };
    inspect_git_status_before(workspace_path, detailed, deadline)
}

pub(super) fn inspect_git_status_before(
    workspace_path: &str,
    detailed: bool,
    deadline: Instant,
) -> anyhow::Result<SourceControlStatus> {
    let root = workspace_root(workspace_path)?;
    let mut command = git_command();
    command
        .arg("-C")
        .arg(&root)
        .arg("status")
        .arg("--porcelain=v2")
        .arg("--branch")
        .arg("--untracked-files=normal");
    // The repository is resolved before the read so that a read which cannot
    // finish can still be answered with what the last one saw.
    let repo_root = match git_read::repo_root(&root, deadline) {
        Ok(path) => path.unwrap_or_else(|| root.clone()),
        Err(error) => {
            return Ok(git_status_read_failure(
                Some(&root),
                error.to_string(),
                true,
            ))
        }
    };
    let output = match git_read::run(&command, deadline, 4 * 1024 * 1024) {
        Ok(output) => output,
        Err(error) => {
            return Ok(git_status_read_failure(
                Some(&repo_root),
                error.to_string(),
                true,
            ));
        }
    };
    if !output.succeeded() || output.stdout_truncated {
        let error = bounded_command_error("could not inspect Git status", &output).to_string();
        // Running out of budget is a read failure; a non-zero exit is an answer.
        let transient = matches!(
            &output.termination,
            ExecutionTermination::TimedOut
                | ExecutionTermination::Inactive
                | ExecutionTermination::OutputLimit
        );
        return Ok(git_status_read_failure(Some(&repo_root), error, transient));
    }
    let mut status = parse_git_status_v2(&output.stdout);
    if detailed {
        let stamp = git_status_stamp(&repo_root, &output.stdout, &status.files);
        if let Some(cached) = cached_git_status(&repo_root, &stamp) {
            return Ok(cached);
        }
        apply_git_diff_stats(&repo_root, &mut status);
        match source_control_review::history(&repo_root) {
            Ok(history) => status.history = history,
            Err(error) if !output.stdout.contains("# branch.oid (initial)") => {
                status.history_error = Some(error.to_string());
            }
            Err(_) => {}
        }
        status.repo_root = Some(repo_root.display().to_string());
        status.last_checked_at = Some(chrono::Utc::now().to_rfc3339());
        store_git_status(repo_root, stamp, status.clone());
        return Ok(status);
    }
    status.repo_root = Some(repo_root.display().to_string());
    status.last_checked_at = Some(chrono::Utc::now().to_rfc3339());
    // Kept as the answer for a detailed read that cannot finish, but stored
    // without a stamp so it is never served as a cached detailed snapshot.
    store_git_status(repo_root, String::new(), status.clone());
    Ok(status)
}

pub(super) fn parse_git_status_v2(output: &str) -> SourceControlStatus {
    let mut status = SourceControlStatus {
        provider: "git".into(),
        available: true,
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        repo_root: None,
        additions: 0,
        deletions: 0,
        stats_partial: false,
        compared_to_main: None,
        files: Vec::new(),
        history: Vec::new(),
        history_error: None,
        last_checked_at: None,
        error: None,
    };

    for line in output.lines() {
        if let Some(branch) = line.strip_prefix("# branch.head ") {
            status.branch = Some(branch.to_string());
        } else if let Some(upstream) = line.strip_prefix("# branch.upstream ") {
            status.upstream = Some(upstream.to_string());
        } else if let Some(ab) = line.strip_prefix("# branch.ab ") {
            for part in ab.split_whitespace() {
                if let Some(value) = part.strip_prefix('+') {
                    status.ahead = value.parse().unwrap_or(0);
                } else if let Some(value) = part.strip_prefix('-') {
                    status.behind = value.parse().unwrap_or(0);
                }
            }
        } else if let Some(path) = line.strip_prefix("? ") {
            status.files.push(SourceControlFile {
                path: path.to_string(),
                original_path: None,
                state: "untracked".into(),
                staged: false,
                additions: 0,
                deletions: 0,
            });
        } else if line.starts_with("1 ") {
            let mut parts = line.split_whitespace();
            let _record = parts.next();
            let xy = parts.next().unwrap_or("..");
            let path = parts.nth(6).unwrap_or_default().to_string();
            push_git_status_sides(&mut status.files, xy, path, None);
        } else if line.starts_with("2 ") {
            let mut parts = line.split_whitespace();
            let _record = parts.next();
            let xy = parts.next().unwrap_or("..");
            let _sub = parts.next();
            (0..5).for_each(|_| {
                let _ = parts.next();
            });
            let _score = parts.next();
            let rest = parts.collect::<Vec<_>>().join(" ");
            let mut paths = rest.split('\t');
            let path = paths.next().unwrap_or_default().to_string();
            let original_path = paths.next().map(ToOwned::to_owned);
            push_git_status_sides(&mut status.files, xy, path, original_path);
        } else if line.starts_with("u ") {
            let path = line
                .split_whitespace()
                .last()
                .unwrap_or_default()
                .to_string();
            status.files.push(SourceControlFile {
                path,
                original_path: None,
                state: "conflicted".into(),
                staged: false,
                additions: 0,
                deletions: 0,
            });
        }
    }
    status
}

pub(super) fn git_repo_root(workspace: &Path) -> Option<PathBuf> {
    let mut command = git_command();
    command
        .arg("-C")
        .arg(workspace)
        .args(["rev-parse", "--show-toplevel"]);
    let output = run_bounded_command(
        &command,
        Duration::from_secs(10),
        None,
        64 * 1024,
        64 * 1024,
    )
    .ok()?;
    if !output.succeeded() || output.stdout_truncated {
        return None;
    }
    let path = output.stdout.trim().to_string();
    (!path.is_empty()).then(|| PathBuf::from(path))
}

pub(super) fn apply_git_diff_stats(repo_root: &Path, status: &mut SourceControlStatus) {
    let (tracked, tracked_partial) = git_numstat(repo_root);
    status.stats_partial = tracked_partial;

    for (additions, deletions) in tracked.values() {
        status.additions = status.additions.saturating_add(*additions);
        status.deletions = status.deletions.saturating_add(*deletions);
    }

    let mut untracked_additions = 0usize;
    let mut untracked_counted = 0usize;
    for file in &mut status.files {
        if let Some((additions, deletions)) = tracked.get(&file.path).or_else(|| {
            file.original_path
                .as_ref()
                .and_then(|path| tracked.get(path))
        }) {
            file.additions = *additions;
            file.deletions = *deletions;
        }
        if file.state != "untracked" {
            continue;
        }
        let path = repo_root.join(&file.path);
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            status.stats_partial = true;
            continue;
        };
        if metadata.is_dir() {
            continue;
        }
        if untracked_counted >= MAX_UNTRACKED_LINE_COUNT_FILES
            || metadata.len() > MAX_UNTRACKED_LINE_COUNT_BYTES
        {
            status.stats_partial = true;
            continue;
        }
        untracked_counted += 1;
        let additions = match git_line_counts::untracked_lines(&path) {
            Ok(lines) => lines,
            Err(_) => {
                status.stats_partial = true;
                continue;
            }
        };
        file.additions = additions;
        untracked_additions = untracked_additions.saturating_add(additions);
        status.additions = status.additions.saturating_add(additions);
    }
    let untracked: Vec<SourceControlFile> = status
        .files
        .iter()
        .filter(|file| file.state == "untracked")
        .cloned()
        .collect();
    status.compared_to_main = git_main_comparison::git_main_comparison(
        repo_root,
        &untracked,
        untracked_additions,
        status.stats_partial,
    );
}

pub(super) fn git_numstat(repo_root: &Path) -> (HashMap<String, (usize, usize)>, bool) {
    let mut command = git_command();
    command
        .arg("-C")
        .arg(repo_root)
        .args(["diff", "--numstat", "--no-renames", "HEAD", "--"]);
    let output = match run_bounded_command(
        &command,
        Duration::from_secs(15),
        Some(Duration::from_secs(10)),
        4 * 1024 * 1024,
        64 * 1024,
    ) {
        Ok(output) if output.succeeded() => output,
        _ => return git_numstat_without_head(repo_root),
    };
    let (stats, partial) = parse_git_numstat(&output.stdout);
    (stats, partial || output.stdout_truncated)
}

pub(super) fn git_numstat_without_head(
    repo_root: &Path,
) -> (HashMap<String, (usize, usize)>, bool) {
    let mut totals = HashMap::new();
    let mut partial = false;
    for args in [
        &["diff", "--numstat", "--no-renames", "--cached", "--"][..],
        &["diff", "--numstat", "--no-renames", "--"][..],
    ] {
        let mut command = git_command();
        command.arg("-C").arg(repo_root).args(args);
        let Ok(output) = run_bounded_command(
            &command,
            Duration::from_secs(15),
            Some(Duration::from_secs(10)),
            4 * 1024 * 1024,
            64 * 1024,
        ) else {
            partial = true;
            continue;
        };
        if !output.succeeded() {
            partial = true;
            continue;
        }
        let (stats, output_partial) = parse_git_numstat(&output.stdout);
        partial |= output_partial || output.stdout_truncated;
        for (path, (additions, deletions)) in stats {
            let entry = totals.entry(path).or_insert((0usize, 0usize));
            entry.0 = entry.0.saturating_add(additions);
            entry.1 = entry.1.saturating_add(deletions);
        }
    }
    (totals, partial)
}

pub(super) fn parse_git_numstat(output: &str) -> (HashMap<String, (usize, usize)>, bool) {
    let mut totals = HashMap::new();
    let mut partial = false;
    for line in output.lines() {
        let mut parts = line.splitn(3, '\t');
        let additions = parts.next().unwrap_or_default();
        let deletions = parts.next().unwrap_or_default();
        let path = parts.next().unwrap_or_default();
        if path.is_empty() {
            continue;
        }
        // Git's binary marker means no text line counts, not missing data.
        if additions == "-" && deletions == "-" {
            totals.insert(path.to_string(), (0, 0));
            continue;
        }
        let (Ok(additions), Ok(deletions)) = (additions.parse(), deletions.parse()) else {
            partial = true;
            continue;
        };
        totals.insert(path.to_string(), (additions, deletions));
    }
    (totals, partial)
}

/// Porcelain v2 reports two statuses per file: X for the index and Y for the
/// working tree. A file can carry both — staged edits plus newer unstaged ones
/// — so each side becomes its own row, which is how VS Code lists the file
/// under both "Staged Changes" and "Changes".
pub(super) fn push_git_status_sides(
    files: &mut Vec<SourceControlFile>,
    xy: &str,
    path: String,
    original_path: Option<String>,
) {
    let mut codes = xy.chars();
    let index = codes.next().unwrap_or('.');
    let worktree = codes.next().unwrap_or('.');
    if index != '.' {
        files.push(SourceControlFile {
            path: path.clone(),
            original_path: original_path.clone(),
            state: git_state_from_code(index),
            staged: true,
            additions: 0,
            deletions: 0,
        });
    }
    if worktree != '.' || index == '.' {
        files.push(SourceControlFile {
            path,
            original_path,
            state: git_state_from_code(worktree),
            staged: false,
            additions: 0,
            deletions: 0,
        });
    }
}

pub(super) fn git_state_from_code(code: char) -> String {
    match code {
        'D' => "deleted",
        'A' => "added",
        'R' | 'C' => "renamed",
        'U' => "conflicted",
        _ => "modified",
    }
    .into()
}
