//! The Git status read layer: porcelain v2 parsing, the per-repository
//! snapshot cache, and the diff line stats that decorate Source Control.
use super::*;

pub(super) fn git_status_cache() -> &'static Mutex<HashMap<PathBuf, (String, SourceControlStatus)>>
{
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, (String, SourceControlStatus)>>> =
        OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `files` are relative to `workspace`, which is the cache key; `repo_root`
/// locates the refs the main comparison is measured against.
pub(super) fn git_status_stamp(
    repo_root: &Path,
    workspace: &Path,
    porcelain: &str,
    files: &[SourceControlFile],
    deadline: Instant,
) -> String {
    let mut material = format!(
        "{}\n{}\n{}",
        repo_root.display(),
        workspace.display(),
        porcelain
    );
    // The main comparison base is stamped by its ref files instead of a
    // `rev-parse` per read, so a cache hit costs the status read alone. Linked
    // worktrees keep refs in the common directory, packing rewrites
    // `packed-refs`, and a reftable repository rewrites `tables.list`.
    let mut stamped: Vec<(&str, PathBuf)> = Vec::new();
    match git_dirs(repo_root) {
        Some((git_dir, common_dir)) => {
            stamped.push(("HEAD", git_dir.join("HEAD")));
            for name in [
                "packed-refs",
                "refs/remotes/origin/main",
                "refs/heads/main",
                "refs/heads/master",
                "reftable/tables.list",
            ] {
                stamped.push((name, common_dir.join(name)));
            }
        }
        None => {
            material.push_str(&git_main_comparison_base(repo_root, deadline).unwrap_or_default())
        }
    }
    stamped.extend(
        files
            .iter()
            .flat_map(|file| [Some(file.path.as_str()), file.original_path.as_deref()])
            .flatten()
            .map(|path| (path, workspace.join(path))),
    );
    for (label, path) in stamped {
        material.push('\n');
        material.push_str(label);
        match fs::symlink_metadata(path) {
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
        upstream_gone: false,
        ahead: 0,
        behind: 0,
        detached: false,
        operation: None,
        stash_count: 0,
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
    // The repository is resolved before the read so that a read which cannot
    // finish can still be answered with what the last one saw.
    let (repo_root, prefix) = match git_read::repo_root_and_prefix(&root, deadline) {
        Ok(found) => found.unwrap_or_else(|| (root.clone(), String::new())),
        Err(error) => {
            return Ok(git_status_read_failure(
                Some(&root),
                error.to_string(),
                true,
            ))
        }
    };
    // `-z` keeps paths verbatim: no C-quoting, and a rename's two paths stay
    // separate fields even when they contain spaces or tabs.
    let mut command = git_command();
    command
        .arg("-C")
        .arg(&root)
        .arg("status")
        .arg("--porcelain=v2")
        .arg("-z")
        .arg("--branch")
        .arg("--untracked-files=normal");
    // Porcelain paths are repository-relative from any directory, but stage,
    // discard, review and the Explorer resolve them against the workspace
    // folder, so a subfolder workspace reads its own subtree only.
    if !prefix.is_empty() {
        command.args(["--", "."]);
    }
    let output = match git_read::run(&command, deadline, 4 * 1024 * 1024) {
        Ok(output) => output,
        Err(error) => {
            return Ok(git_status_read_failure(
                Some(&root),
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
        return Ok(git_status_read_failure(Some(&root), error, transient));
    }
    let mut status = parse_git_status_v2(&output.stdout);
    relativize_git_status_paths(&mut status.files, &prefix);
    // Read on every pass rather than cached: the stamp does not cover the
    // files these come from, and they are a handful of metadata reads.
    let repository_state = git_repository_state(&repo_root);
    repository_state.apply(&mut status);
    if detailed {
        let stamp = git_status_stamp(&repo_root, &root, &output.stdout, &status.files, deadline);
        if let Some(mut cached) = cached_git_status(&root, &stamp) {
            repository_state.apply(&mut cached);
            return Ok(cached);
        }
        apply_git_diff_stats(&root, &mut status, deadline);
        match source_control_review::history(&repo_root, deadline) {
            Ok(history) => status.history = history,
            Err(error) if !output.stdout.contains("# branch.oid (initial)") => {
                status.history_error = Some(error.to_string());
            }
            Err(_) => {}
        }
        status.repo_root = Some(repo_root.display().to_string());
        status.last_checked_at = Some(chrono::Utc::now().to_rfc3339());
        // A step that ran out of the shared budget left partial decorations:
        // kept as a last known answer, never served as a cache hit.
        let stamp = if Instant::now() < deadline {
            stamp
        } else {
            String::new()
        };
        store_git_status(root, stamp, status.clone());
        return Ok(status);
    }
    status.repo_root = Some(repo_root.display().to_string());
    status.last_checked_at = Some(chrono::Utc::now().to_rfc3339());
    // Kept as the answer for a detailed read that cannot finish, but stored
    // without a stamp so it is never served as a cached detailed snapshot.
    store_git_status(root, String::new(), status.clone());
    Ok(status)
}

/// Rewrites repository-relative porcelain paths relative to a subfolder
/// workspace. A rename whose source lies outside it keeps no original path.
fn relativize_git_status_paths(files: &mut Vec<SourceControlFile>, prefix: &str) {
    if prefix.is_empty() {
        return;
    }
    files.retain_mut(|file| {
        let Some(path) = file.path.strip_prefix(prefix) else {
            return false;
        };
        file.path = path.to_string();
        file.original_path = file
            .original_path
            .as_deref()
            .and_then(|original| original.strip_prefix(prefix))
            .map(str::to_string);
        !file.path.is_empty()
    });
}

pub(super) fn parse_git_status_v2(output: &str) -> SourceControlStatus {
    let mut status = SourceControlStatus {
        provider: "git".into(),
        available: true,
        branch: None,
        upstream: None,
        upstream_gone: false,
        ahead: 0,
        behind: 0,
        detached: false,
        operation: None,
        stash_count: 0,
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

    // Reads `status --porcelain=v2 -z`: every record ends in NUL and a rename's
    // original path is the next field. Paths are the last field of a record
    // and may contain spaces, so records split on a fixed field count. Text
    // without NULs is read as newline records whose rename paths are split by
    // a tab, as `status` prints without `-z`.
    let nul_separated = output.contains('\0');
    let records: Vec<&str> = if nul_separated {
        output.split('\0').collect()
    } else {
        output.lines().collect()
    };
    let mut records = records.into_iter();
    let mut saw_ahead_behind = false;
    while let Some(line) = records.next() {
        if let Some(branch) = line.strip_prefix("# branch.head ") {
            status.detached = branch == "(detached)";
            status.branch = Some(branch.to_string());
        } else if let Some(upstream) = line.strip_prefix("# branch.upstream ") {
            status.upstream = Some(upstream.to_string());
        } else if let Some(ab) = line.strip_prefix("# branch.ab ") {
            saw_ahead_behind = true;
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
            // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            let fields: Vec<&str> = line.splitn(9, ' ').collect();
            if let [_, xy, _, _, _, _, _, _, path] = fields[..] {
                push_git_status_sides(&mut status.files, xy, path.to_string(), None);
            }
        } else if line.starts_with("2 ") {
            // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>
            // followed by the <origPath> field.
            let original_field = if nul_separated { records.next() } else { None };
            let fields: Vec<&str> = line.splitn(10, ' ').collect();
            if let [_, xy, _, _, _, _, _, _, _, path] = fields[..] {
                let (path, original_path) = match original_field {
                    Some(original) => (path, Some(original)),
                    None => path
                        .split_once('\t')
                        .map_or((path, None), |(path, original)| (path, Some(original))),
                };
                push_git_status_sides(
                    &mut status.files,
                    xy,
                    path.to_string(),
                    original_path.map(ToOwned::to_owned),
                );
            }
        } else if line.starts_with("u ") {
            // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
            let fields: Vec<&str> = line.splitn(11, ' ').collect();
            if let [_, _, _, _, _, _, _, _, _, _, path] = fields[..] {
                status.files.push(SourceControlFile {
                    path: path.to_string(),
                    original_path: None,
                    state: "conflicted".into(),
                    staged: false,
                    additions: 0,
                    deletions: 0,
                });
            }
        }
        // `!` (ignored) records are never requested and carry nothing to show.
    }
    // Porcelain v2 omits `branch.ab` exactly when the upstream is configured but
    // its ref is missing — the remote branch was deleted, usually by a merge.
    status.upstream_gone = status.upstream.is_some() && !saw_ahead_behind;
    status
}

/// Repository state that `git status --porcelain` does not report: an
/// operation left in progress and the stash depth.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct GitRepositoryState {
    pub(super) operation: Option<&'static str>,
    pub(super) stash_count: usize,
}

impl GitRepositoryState {
    fn apply(&self, status: &mut SourceControlStatus) {
        status.operation = self.operation.map(str::to_string);
        status.stash_count = self.stash_count;
    }
}

/// The per-worktree git directory and the shared common directory. A linked
/// worktree's `.git` is a file pointing at `.git/worktrees/<name>`, whose
/// `commondir` points back at the main repository's `.git`.
pub(super) fn git_dirs(repo_root: &Path) -> Option<(PathBuf, PathBuf)> {
    let dot_git = repo_root.join(".git");
    let git_dir = if dot_git.is_dir() {
        dot_git
    } else {
        let pointer = fs::read_to_string(&dot_git).ok()?;
        let target = PathBuf::from(pointer.trim().strip_prefix("gitdir:")?.trim());
        if target.is_absolute() {
            target
        } else {
            repo_root.join(target)
        }
    };
    let common_dir = match fs::read_to_string(git_dir.join("commondir")) {
        Ok(pointer) => {
            let target = PathBuf::from(pointer.trim());
            if target.is_absolute() {
                target
            } else {
                git_dir.join(target)
            }
        }
        Err(_) => git_dir.clone(),
    };
    Some((git_dir, common_dir))
}

pub(super) fn git_repository_state(repo_root: &Path) -> GitRepositoryState {
    let Some((git_dir, common_dir)) = git_dirs(repo_root) else {
        return GitRepositoryState::default();
    };
    // Checked in the order git itself reports them: a rebase that stopped on a
    // conflicting pick also leaves CHERRY_PICK_HEAD behind.
    let operation = [
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
        ("MERGE_HEAD", "merge"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
        ("BISECT_LOG", "bisect"),
    ]
    .into_iter()
    .find(|(marker, _)| git_dir.join(marker).exists())
    .map(|(_, operation)| operation);
    // Each stash entry is one line of the stash reflog, shared by all worktrees.
    let stash_count = fs::read_to_string(common_dir.join("logs/refs/stash"))
        .map(|log| log.lines().filter(|line| !line.trim().is_empty()).count())
        .unwrap_or(0);
    GitRepositoryState {
        operation,
        stash_count,
    }
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

/// Decorates workspace-relative `status.files` with line counts. Every Git
/// read here shares the caller's `deadline` instead of starting a fresh
/// timeout per step.
pub(super) fn apply_git_diff_stats(
    workspace: &Path,
    status: &mut SourceControlStatus,
    deadline: Instant,
) {
    let (tracked, tracked_partial) = git_numstat(workspace, deadline);
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
        let path = workspace.join(&file.path);
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
        workspace,
        &untracked,
        untracked_additions,
        status.stats_partial,
        deadline,
    );
}

/// Background `diff --numstat` flags: verbatim NUL-terminated paths relative
/// to the workspace (`-C`), and no user diff drivers on a background read.
pub(super) const GIT_NUMSTAT_ARGS: [&str; 7] = [
    "diff",
    "--numstat",
    "-z",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--relative",
];

pub(super) fn git_numstat(
    workspace: &Path,
    deadline: Instant,
) -> (HashMap<String, (usize, usize)>, bool) {
    let mut command = git_command();
    command
        .arg("-C")
        .arg(workspace)
        .args(GIT_NUMSTAT_ARGS)
        .args(["HEAD", "--"]);
    let output = match git_read::run(&command, deadline, 4 * 1024 * 1024) {
        Ok(output) if output.succeeded() => output,
        _ => return git_numstat_without_head(workspace, deadline),
    };
    let (stats, partial) = parse_git_numstat(&output.stdout);
    (stats, partial || output.stdout_truncated)
}

pub(super) fn git_numstat_without_head(
    workspace: &Path,
    deadline: Instant,
) -> (HashMap<String, (usize, usize)>, bool) {
    let mut totals = HashMap::new();
    let mut partial = false;
    for args in [&["--cached", "--"][..], &["--"][..]] {
        let mut command = git_command();
        command
            .arg("-C")
            .arg(workspace)
            .args(GIT_NUMSTAT_ARGS)
            .args(args);
        let Ok(output) = git_read::run(&command, deadline, 4 * 1024 * 1024) else {
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

/// Reads `--numstat -z` records (`added<TAB>deleted<TAB>path<NUL>`), or
/// newline records when the text carries no NUL.
pub(super) fn parse_git_numstat(output: &str) -> (HashMap<String, (usize, usize)>, bool) {
    let mut totals = HashMap::new();
    let mut partial = false;
    let records: Vec<&str> = if output.contains('\0') {
        output.split('\0').collect()
    } else {
        output.lines().collect()
    };
    for line in records {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn git(repo: &Path, args: &[&str]) -> std::process::Output {
        Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .unwrap()
    }

    fn run_git(repo: &Path, args: &[&str]) {
        let output = git(repo, args);
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn init_git_repo(repo: &Path) {
        run_git(repo, &["init", "-b", "main"]);
        run_git(repo, &["config", "user.name", "Gyro Test"]);
        run_git(repo, &["config", "user.email", "gyro@example.test"]);
    }

    fn file<'a>(status: &'a SourceControlStatus, path: &str) -> &'a SourceControlFile {
        status
            .files
            .iter()
            .find(|file| file.path == path)
            .unwrap_or_else(|| panic!("{path} missing from {:?}", status.files))
    }

    #[test]
    fn git_status_keeps_spaced_renamed_unicode_and_conflicted_paths_whole() {
        let repo = tempfile::tempdir().unwrap();
        let root = repo.path();
        init_git_repo(root);
        fs::write(root.join("my file.txt"), "one\n").unwrap();
        fs::write(root.join("old name.txt"), "rename me\n").unwrap();
        fs::write(root.join("both edited.txt"), "base\n").unwrap();
        run_git(root, &["add", "."]);
        run_git(root, &["commit", "-m", "base"]);
        run_git(root, &["checkout", "-b", "other"]);
        fs::write(root.join("both edited.txt"), "other\n").unwrap();
        run_git(root, &["commit", "-am", "other"]);
        run_git(root, &["checkout", "main"]);
        fs::write(root.join("both edited.txt"), "main\n").unwrap();
        run_git(root, &["commit", "-am", "main"]);
        assert!(!git(root, &["merge", "other"]).status.success());

        fs::write(root.join("my file.txt"), "one\ntwo\nthree\n").unwrap();
        run_git(root, &["mv", "old name.txt", "new name.txt"]);
        fs::write(root.join("ünï code.txt"), "a\nb\n").unwrap();

        let status = git_status_impl(root.to_str().unwrap()).unwrap();
        let spaced = file(&status, "my file.txt");
        assert_eq!((spaced.state.as_str(), spaced.additions), ("modified", 2));
        let renamed = file(&status, "new name.txt");
        assert_eq!(renamed.state, "renamed");
        assert_eq!(renamed.original_path.as_deref(), Some("old name.txt"));
        let unicode = file(&status, "ünï code.txt");
        assert_eq!(
            (unicode.state.as_str(), unicode.additions),
            ("untracked", 2)
        );
        assert_eq!(file(&status, "both edited.txt").state, "conflicted");
        assert_eq!(status.files.len(), 4, "{:?}", status.files);
    }

    #[test]
    fn git_status_in_a_subfolder_reports_workspace_relative_paths_and_live_stats() {
        let repo = tempfile::tempdir().unwrap();
        let root = repo.path();
        init_git_repo(root);
        fs::create_dir(root.join("app")).unwrap();
        fs::write(root.join("app/lib.rs"), "one\n").unwrap();
        fs::write(root.join("top.txt"), "top\n").unwrap();
        run_git(root, &["add", "."]);
        run_git(root, &["commit", "-m", "base"]);
        run_git(root, &["checkout", "-b", "feature"]);
        fs::write(root.join("app/lib.rs"), "one\ntwo\n").unwrap();
        fs::write(root.join("app/new file.rs"), "new\n").unwrap();
        fs::write(root.join("top.txt"), "top\nchanged\n").unwrap();
        let workspace = root.join("app");
        let workspace_path = workspace.to_str().unwrap().to_string();

        let status = git_status_impl(&workspace_path).unwrap();
        assert_eq!(
            status.repo_root.as_deref(),
            root.canonicalize().unwrap().to_str()
        );
        assert_eq!(file(&status, "lib.rs").additions, 1);
        assert_eq!(file(&status, "new file.rs").additions, 1);
        // Outside the workspace: nothing here could stage or review it.
        assert_eq!(status.files.len(), 2, "{:?}", status.files);
        assert_eq!((status.additions, status.deletions), (2, 0));
        let mut compared: Vec<_> = status
            .compared_to_main
            .as_ref()
            .unwrap()
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect();
        compared.sort();
        assert_eq!(compared, ["lib.rs", "new file.rs"]);

        // Same porcelain, new content: the stamp must see the workspace file.
        fs::write(root.join("app/lib.rs"), "one\ntwo\nthree\n").unwrap();
        let refreshed = git_status_impl(&workspace_path).unwrap();
        assert_eq!(file(&refreshed, "lib.rs").additions, 2);

        // The reported path is what stage resolves against the workspace.
        let staged = git_stage_blocking(GitStageRequest {
            workspace_path: workspace_path.clone(),
            path: "lib.rs".into(),
        })
        .unwrap();
        assert!(staged
            .files
            .iter()
            .any(|file| file.path == "lib.rs" && file.staged));
    }

    #[test]
    fn git_status_shares_one_deadline_and_never_caches_a_partial_read() {
        use std::os::unix::fs::PermissionsExt;
        let repo = tempfile::tempdir().unwrap();
        let root = repo.path();
        init_git_repo(root);
        fs::write(root.join("tracked.txt"), "alpha\n").unwrap();
        run_git(root, &["add", "."]);
        run_git(root, &["commit", "-m", "base"]);
        fs::write(root.join("tracked.txt"), "alpha\nbeta\n").unwrap();
        // The status read's own hook calls are quick; every later one — the
        // line-stat diffs — stalls well past the whole budget.
        let monitor = root.join(".git/slow-diff-monitor");
        fs::write(
            &monitor,
            "#!/bin/sh\ncount=\"$(dirname \"$0\")/monitor-calls\"\n\
             echo x >> \"$count\"\n\
             [ \"$(wc -l < \"$count\")\" -gt 2 ] && sleep 5\nexit 1\n",
        )
        .unwrap();
        fs::set_permissions(&monitor, fs::Permissions::from_mode(0o700)).unwrap();
        run_git(
            root,
            &["config", "core.fsmonitor", monitor.to_str().unwrap()],
        );
        let path = root.to_str().unwrap();

        let started = Instant::now();
        let stalled =
            inspect_git_status_before(path, true, started + Duration::from_millis(1500)).unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "took {:?}",
            started.elapsed()
        );
        assert!(stalled.available);
        assert!(stalled.stats_partial);

        run_git(root, &["config", "--unset", "core.fsmonitor"]);
        let recovered = git_status_impl(path).unwrap();
        assert!(!recovered.stats_partial);
        assert_eq!(file(&recovered, "tracked.txt").additions, 1);
    }

    #[test]
    fn git_status_cache_sees_main_move_in_a_linked_worktree() {
        let repo = tempfile::tempdir().unwrap();
        let root = repo.path();
        init_git_repo(root);
        fs::write(root.join("file.txt"), "base\n").unwrap();
        run_git(root, &["add", "."]);
        run_git(root, &["commit", "-m", "base"]);
        let parent = tempfile::tempdir().unwrap();
        let linked = parent.path().join("linked");
        run_git(
            root,
            &["worktree", "add", "-b", "feature", linked.to_str().unwrap()],
        );
        fs::write(linked.join("file.txt"), "base\nfeature\n").unwrap();
        run_git(&linked, &["commit", "-am", "feature"]);
        let path = linked.to_str().unwrap();

        let before = git_status_impl(path).unwrap();
        let comparison = before.compared_to_main.unwrap();
        assert_eq!((comparison.additions, comparison.deletions), (1, 0));
        run_git(root, &["update-ref", "refs/heads/main", "feature"]);
        let after = git_status_impl(path).unwrap();
        let comparison = after.compared_to_main.unwrap();
        assert_eq!((comparison.additions, comparison.deletions), (0, 0));
    }

    #[test]
    fn git_status_parser_reads_nul_records_verbatim() {
        let status = parse_git_status_v2(
            "# branch.head main\0\
             1 .M N... 100644 100644 100644 aaaa bbbb my  file.txt\0\
             2 R. N... 100644 100644 100644 aaaa bbbb R100 new\tname.txt\0old name.txt\0\
             u UU N... 100644 100644 100644 100644 a b c both edited.txt\0\
             ? caf\u{e9} note.txt\0\
             ! ignored dir/\0",
        );
        let files: Vec<_> = status
            .files
            .iter()
            .map(|file| {
                (
                    file.path.as_str(),
                    file.original_path.as_deref(),
                    file.state.as_str(),
                )
            })
            .collect();
        assert_eq!(
            files,
            vec![
                ("my  file.txt", None, "modified"),
                ("new\tname.txt", Some("old name.txt"), "renamed"),
                ("both edited.txt", None, "conflicted"),
                ("caf\u{e9} note.txt", None, "untracked"),
            ]
        );
    }
}
