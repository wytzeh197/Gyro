//! Shared wall-clock budgets for background Git reads. The supervisor kills
//! timed-out children; a later step must not start with a fresh timeout.
use super::*;

pub(super) fn run(
    command: &Command,
    deadline: Instant,
    max_stdout: usize,
) -> anyhow::Result<gyro_core::ExecutionOutcome> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    anyhow::ensure!(
        !remaining.is_zero(),
        "Git inspection timed out; retry to refresh"
    );
    let mut read = Command::new(command.get_program());
    // A stuck fsmonitor hook runs while Git opens the repository, including
    // `rev-parse`, and used to burn the whole status budget. Background reads
    // answer from the files on disk; mutations keep the user's monitor.
    if is_git_program(command.get_program()) {
        read.arg("-c").arg("core.fsmonitor=");
    }
    read.args(command.get_args());
    if let Some(dir) = command.get_current_dir() {
        read.current_dir(dir);
    }
    for (key, value) in command.get_envs() {
        if let Some(value) = value {
            read.env(key, value);
        } else {
            read.env_remove(key);
        }
    }
    // Background status must not refresh/write the index or contend with an
    // explicit stage/commit. This setting is never applied to Git mutations.
    read.env("GIT_OPTIONAL_LOCKS", "0");
    run_bounded_command(&read, remaining, None, max_stdout, 64 * 1024)
}

pub(super) fn repo_root(workspace: &Path, deadline: Instant) -> anyhow::Result<Option<PathBuf>> {
    Ok(repo_root_and_prefix(workspace, deadline)?.map(|(root, _)| root))
}

/// The repository root and the workspace's place inside it (`sub/dir/`, or
/// empty at the root).
///
/// This used to be `git rev-parse`. That process waits on fsmonitor and the
/// index lock, so a stuck hook consumed the status budget and the Environment
/// panel reported "could not locate Git repository timed out". The root is the
/// directory that holds `.git`; the prefix is the same string `--show-prefix`
/// prints. `deadline` still bounds every Git child the caller starts next.
pub(super) fn repo_root_and_prefix(
    workspace: &Path,
    _deadline: Instant,
) -> anyhow::Result<Option<(PathBuf, String)>> {
    Ok(discover_repository(workspace))
}

const GIT_DISCOVERY_DEPTH: usize = 64;

/// Walk parents for a checkout. A `.git` directory or a `gitdir:` file marks
/// the work tree. No Git process is started.
pub(super) fn discover_repository(workspace: &Path) -> Option<(PathBuf, String)> {
    let start = workspace
        .canonicalize()
        .unwrap_or_else(|_| workspace.to_path_buf());
    let mut current = start.clone();
    for _ in 0..GIT_DISCOVERY_DEPTH {
        if is_git_work_tree(&current.join(".git")) {
            let prefix = workspace_prefix(&current, &start);
            return Some((current, prefix));
        }
        if !current.pop() {
            break;
        }
    }
    None
}

fn is_git_program(program: &std::ffi::OsStr) -> bool {
    Path::new(program)
        .file_name()
        .and_then(|name| name.to_str())
        == Some("git")
}

fn is_git_work_tree(dot_git: &Path) -> bool {
    if dot_git.is_dir() {
        return true;
    }
    let mut file = match fs::File::open(dot_git) {
        Ok(file) => file,
        Err(_) => return false,
    };
    let mut buffer = [0u8; 256];
    let count = match std::io::Read::read(&mut file, &mut buffer) {
        Ok(count) => count,
        Err(_) => return false,
    };
    let text = String::from_utf8_lossy(&buffer[..count]);
    let line = text.lines().next().unwrap_or_default().trim();
    line.strip_prefix("gitdir:")
        .is_some_and(|target| !target.trim().is_empty())
}

/// `--show-prefix`: empty at the work tree root, otherwise a `/`-separated
/// relative path with a trailing slash.
fn workspace_prefix(repo_root: &Path, workspace: &Path) -> String {
    let Ok(relative) = workspace.strip_prefix(repo_root) else {
        return String::new();
    };
    if relative.as_os_str().is_empty() {
        return String::new();
    }
    let mut prefix = String::new();
    for component in relative.components() {
        if !prefix.is_empty() {
            prefix.push('/');
        }
        prefix.push_str(&component.as_os_str().to_string_lossy());
    }
    prefix.push('/');
    prefix
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn git_read_deadline_stops_children_and_prevents_later_steps() {
        let mut slow = Command::new("sh");
        slow.args(["-c", "sleep 5"]);
        let started = Instant::now();
        let deadline = started + Duration::from_millis(80);
        let result = run(&slow, deadline, 1024).unwrap();
        assert!(matches!(result.termination, ExecutionTermination::TimedOut));
        assert!(started.elapsed() < Duration::from_secs(2));
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("must-not-start");
        let mut next = Command::new("touch");
        next.arg(&marker);
        assert!(run(&next, deadline, 1024).is_err());
        assert!(!marker.exists());
    }
    #[test]
    fn git_read_timeout_keeps_changes_and_next_read_recovers() {
        use std::os::unix::fs::PermissionsExt;
        let repo = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .arg("-C")
                .arg(repo.path())
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "-b", "main"]);
        git(&["config", "user.name", "Gyro Test"]);
        git(&["config", "user.email", "gyro@example.test"]);
        fs::write(repo.path().join("tracked.txt"), "before\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-m", "base"]);
        fs::write(repo.path().join("tracked.txt"), "after\n").unwrap();
        let path = repo.path().to_str().unwrap();
        let first = git_status_impl(path).unwrap();
        assert!(first.files.iter().any(|file| file.path == "tracked.txt"));
        let monitor = repo.path().join(".git/slow-monitor");
        fs::write(&monitor, "#!/bin/sh\nsleep 5\n").unwrap();
        fs::set_permissions(&monitor, fs::Permissions::from_mode(0o700)).unwrap();
        git(&["config", "core.fsmonitor", monitor.to_str().unwrap()]);
        let started = Instant::now();
        let read = git_status_cache::inspect_git_status_before(
            path,
            false,
            started + Duration::from_millis(250),
        )
        .unwrap();
        // Background reads pass `-c core.fsmonitor=`, so this hook must not
        // run or consume the budget that used to surface as a locate timeout.
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "stuck fsmonitor stalled the read for {:?}",
            started.elapsed()
        );
        assert!(read.error.is_none(), "{:?}", read.error);
        assert!(read
            .files
            .iter()
            .any(|file| { file.path == "tracked.txt" && file.state == "modified" }));
        git(&["config", "--unset", "core.fsmonitor"]);
        let recovered = git_status_for_preparation(path).unwrap();
        assert!(recovered.available);
        assert!(recovered.error.is_none());
        assert!(recovered
            .files
            .iter()
            .any(|file| file.path == "tracked.txt"));
        assert!(git_branch_catalog_before(path, Instant::now())
            .unwrap_err()
            .to_string()
            .contains("timed out"));
    }

    #[test]
    fn git_reads_disable_optional_index_writes_without_changing_caller() {
        let mut command = Command::new("sh");
        command.args(["-c", "printf %s \"$GIT_OPTIONAL_LOCKS\""]);
        let result = run(&command, Instant::now() + Duration::from_secs(2), 1024).unwrap();
        assert_eq!(result.stdout, "0");
        assert!(command
            .get_envs()
            .all(|(key, _)| key != "GIT_OPTIONAL_LOCKS"));
    }

    #[test]
    fn discover_repository_finds_checkouts_without_spending_the_git_budget() {
        let repo = tempfile::tempdir().unwrap();
        let root = repo.path();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .arg("-C")
                .arg(root)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "-b", "main"]);
        git(&["config", "user.name", "Gyro Test"]);
        git(&["config", "user.email", "gyro@example.test"]);
        fs::create_dir(root.join("app")).unwrap();
        fs::write(root.join("app/lib.rs"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-m", "base"]);

        let canonical = root.canonicalize().unwrap();
        let (found, prefix) = discover_repository(root).unwrap();
        assert_eq!(found, canonical);
        assert_eq!(prefix, "");
        let (found, prefix) = discover_repository(&root.join("app")).unwrap();
        assert_eq!(found, canonical);
        assert_eq!(prefix, "app/");

        // A stray file named `.git` is not a checkout, so the parent repo wins.
        fs::create_dir(root.join("app/nested")).unwrap();
        fs::write(root.join("app/nested/.git"), "not a pointer\n").unwrap();
        let (found, prefix) = discover_repository(&root.join("app/nested")).unwrap();
        assert_eq!(found, canonical);
        assert_eq!(prefix, "app/nested/");

        // A nested checkout is its own work tree, not the repository above it.
        let vendor = root.join("vendor");
        fs::create_dir_all(vendor.join("src")).unwrap();
        let output = Command::new("git")
            .arg("-C")
            .arg(&vendor)
            .args(["init", "-b", "main"])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let (found, prefix) = discover_repository(&vendor.join("src")).unwrap();
        assert_eq!(found, vendor.canonicalize().unwrap());
        assert_eq!(prefix, "src/");

        // A linked worktree's `.git` is a `gitdir:` file. Discovery still
        // answers after the budget is gone, because it never starts Git.
        let parent = tempfile::tempdir().unwrap();
        let linked = parent.path().join("linked");
        git(&["worktree", "add", "-b", "feature", linked.to_str().unwrap()]);
        fs::create_dir(linked.join("sub")).unwrap();
        let linked_root = linked.canonicalize().unwrap();
        let (found, prefix) = repo_root_and_prefix(&linked.join("sub"), Instant::now())
            .unwrap()
            .unwrap();
        assert_eq!(found, linked_root);
        assert_eq!(prefix, "sub/");
        assert_eq!(git_status_cache::git_repo_root(&linked), Some(linked_root));

        let outside = tempfile::tempdir().unwrap();
        assert!(discover_repository(outside.path()).is_none());
        assert!(repo_root_and_prefix(outside.path(), Instant::now())
            .unwrap()
            .is_none());
    }
}
