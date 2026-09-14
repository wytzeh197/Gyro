use super::{
    git_command, parse_git_numstat, run_bounded_command, MainComparisonStats, SourceControlFile,
};
use std::path::Path;
use std::time::Duration;

const MAX_COMPARISON_FILES: usize = 400;

// Prefer the fetched remote main; a local main may lag behind many releases.
// Local-only repositories retain their existing comparison behavior.
pub(crate) fn git_main_comparison_base(repo_root: &Path) -> Option<String> {
    for reference in ["refs/remotes/origin/main", "refs/heads/main"] {
        let mut command = git_command();
        command.arg("-C").arg(repo_root).args([
            "rev-parse",
            "--verify",
            &format!("{reference}^{{commit}}"),
        ]);
        let Ok(output) = run_bounded_command(
            &command,
            Duration::from_secs(5),
            Some(Duration::from_secs(5)),
            1024,
            1024,
        ) else {
            continue;
        };
        if output.succeeded() && !output.stdout_truncated {
            return Some(output.stdout.trim().to_owned());
        }
    }
    None
}

pub(crate) fn git_main_comparison(
    repo_root: &Path,
    untracked: &[SourceControlFile],
    untracked_additions: usize,
    partial: bool,
) -> Option<MainComparisonStats> {
    let base = git_main_comparison_base(repo_root)?;
    let mut command = git_command();
    command
        .arg("-C")
        .arg(repo_root)
        .args(["diff", "--numstat", "--no-renames", &base, "--"]);
    let output = run_bounded_command(
        &command,
        Duration::from_secs(15),
        Some(Duration::from_secs(10)),
        4 * 1024 * 1024,
        64 * 1024,
    )
    .ok()?;
    if !output.succeeded() {
        return None;
    }
    let (stats, parse_partial) = parse_git_numstat(&output.stdout);
    let mut files: Vec<SourceControlFile> = stats
        .iter()
        .map(|(path, (additions, deletions))| SourceControlFile {
            path: path.clone(),
            original_path: None,
            state: if *deletions == 0 && *additions > 0 {
                "added".into()
            } else if *additions == 0 && *deletions > 0 {
                "deleted".into()
            } else {
                "modified".into()
            },
            staged: false,
            additions: *additions,
            deletions: *deletions,
        })
        .collect();
    files.sort_by(|left, right| left.path.cmp(&right.path));
    let mut result = MainComparisonStats {
        additions: untracked_additions,
        deletions: 0,
        partial: partial || parse_partial || output.stdout_truncated,
        files: Vec::new(),
    };
    for (additions, deletions) in stats.values() {
        result.additions = result.additions.saturating_add(*additions);
        result.deletions = result.deletions.saturating_add(*deletions);
    }
    for file in untracked {
        if files.iter().any(|existing| existing.path == file.path) {
            continue;
        }
        files.push(file.clone());
    }
    if files.len() > MAX_COMPARISON_FILES {
        files.truncate(MAX_COMPARISON_FILES);
        result.partial = true;
    }
    result.files = files;
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::super::git_status_impl;
    use std::path::Path;
    use std::process::Command;

    #[test]
    fn source_control_main_comparison_includes_committed_and_untracked_changes() {
        let repo = tempfile::tempdir().unwrap();
        init_git_repo(repo.path());
        std::fs::write(repo.path().join("file.txt"), "base\n").unwrap();
        run_git(repo.path(), &["add", "."]);
        run_git(repo.path(), &["commit", "-m", "base"]);
        run_git(repo.path(), &["checkout", "-b", "feature"]);
        std::fs::write(repo.path().join("file.txt"), "base\ncommitted\n").unwrap();
        run_git(repo.path(), &["commit", "-am", "feature"]);
        std::fs::write(repo.path().join("file.txt"), "base\ncommitted\nworking\n").unwrap();
        std::fs::write(repo.path().join("new.txt"), "new\n").unwrap();
        let status = git_status_impl(repo.path().to_str().unwrap()).unwrap();
        assert_eq!(status.additions, 2);
        let comparison = status.compared_to_main.unwrap();
        assert_eq!((comparison.additions, comparison.deletions), (3, 0));
        assert!(!comparison.partial);
        let paths: Vec<_> = comparison
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect();
        assert!(paths.contains(&"file.txt"));
        assert!(paths.contains(&"new.txt"));
        run_git(repo.path(), &["branch", "-D", "main"]);
        let status = git_status_impl(repo.path().to_str().unwrap()).unwrap();
        assert!(status.compared_to_main.is_none());
        assert_eq!(status.additions, 2);
    }

    #[test]
    fn source_control_main_comparison_prefers_remote_and_refreshes_cached_stats() {
        let repo = tempfile::tempdir().unwrap();
        init_git_repo(repo.path());
        std::fs::write(repo.path().join("file.txt"), "base\n").unwrap();
        run_git(repo.path(), &["add", "."]);
        run_git(repo.path(), &["commit", "-m", "base"]);
        run_git(repo.path(), &["checkout", "-b", "feature"]);
        std::fs::write(repo.path().join("file.txt"), "base\nreleased\n").unwrap();
        run_git(repo.path(), &["commit", "-am", "released"]);
        run_git(
            repo.path(),
            &["update-ref", "refs/remotes/origin/main", "HEAD"],
        );
        std::fs::write(repo.path().join("file.txt"), "base\nreleased\nfeature\n").unwrap();
        run_git(repo.path(), &["commit", "-am", "feature"]);
        let status = git_status_impl(repo.path().to_str().unwrap()).unwrap();
        let comparison = status.compared_to_main.unwrap();
        assert_eq!((comparison.additions, comparison.deletions), (1, 0));
        run_git(
            repo.path(),
            &["update-ref", "refs/remotes/origin/main", "HEAD"],
        );
        let status = git_status_impl(repo.path().to_str().unwrap()).unwrap();
        let comparison = status.compared_to_main.unwrap();
        assert_eq!((comparison.additions, comparison.deletions), (0, 0));
    }

    fn init_git_repo(repo: &Path) {
        run_git(repo, &["init", "-b", "main"]);
        run_git(repo, &["config", "user.name", "Gyro Test"]);
        run_git(repo, &["config", "user.email", "gyro@example.test"]);
    }

    fn run_git(repo: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
