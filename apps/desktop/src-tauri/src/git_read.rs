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
    let mut command = git_command();
    command
        .arg("-C")
        .arg(workspace)
        .args(["rev-parse", "--show-toplevel"]);
    let output = run(&command, deadline, 64 * 1024)?;
    if output.succeeded() && !output.stdout_truncated {
        let path = output.stdout.trim();
        return Ok((!path.is_empty()).then(|| PathBuf::from(path)));
    }
    if output.stderr.contains("not a git repository")
        && matches!(output.termination, ExecutionTermination::Exited { .. })
    {
        return Ok(None);
    }
    Err(bounded_command_error(
        "could not locate Git repository",
        &output,
    ))
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
        let stalled = git_status_cache::inspect_git_status_before(
            path,
            false,
            started + Duration::from_millis(250),
        )
        .unwrap();
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(stalled.files, first.files);
        assert!(stalled
            .error
            .as_deref()
            .unwrap()
            .contains("last known changes"));
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
}
