use crate::{
    execution::{
        run_command, CancellationToken, ExecutionOutcome, ExecutionRequest, ExecutionTermination,
    },
    paths::GyroPaths,
};
use anyhow::{anyhow, Context, Result};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

const GIT_QUERY_TIMEOUT: Duration = Duration::from_secs(5);
const GIT_WORKTREE_TIMEOUT: Duration = Duration::from_secs(60);
const GIT_QUERY_MAX_STDOUT_CHARS: usize = 8 * 1024;
const GIT_WORKTREE_MAX_STDOUT_CHARS: usize = 32 * 1024;
const GIT_MAX_STDERR_CHARS: usize = 32 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorktreeSessionPlan {
    pub git_root: PathBuf,
    pub worktree_path: PathBuf,
    pub branch: String,
    pub worktree_name: String,
}

pub fn create_worktree(
    paths: &GyroPaths,
    workspace_path: impl AsRef<Path>,
    branch: impl Into<String>,
    worktree_name: Option<String>,
) -> Result<WorktreeSessionPlan> {
    paths.ensure()?;
    let branch = branch.into();
    validate_branch_name(&branch)?;
    let workspace = workspace_path.as_ref().canonicalize().with_context(|| {
        format!(
            "resolve workspace path {}",
            workspace_path.as_ref().display()
        )
    })?;
    let git_root = git_top_level(&workspace)?;
    let worktree_name = worktree_name.unwrap_or_else(|| slugify(&branch));
    validate_worktree_name(&worktree_name)?;
    let repo_name = git_root
        .file_name()
        .map(|name| slugify(&name.to_string_lossy()))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "workspace".into());
    let worktree_path = paths.worktrees_dir.join(repo_name).join(&worktree_name);
    if worktree_path.exists() {
        return Err(anyhow!(
            "worktree already exists at {}",
            worktree_path.display()
        ));
    }
    if let Some(parent) = worktree_path.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }

    let output = run_git_command(
        vec![
            OsString::from("-C"),
            git_root.as_os_str().to_os_string(),
            OsString::from("worktree"),
            OsString::from("add"),
            OsString::from("-b"),
            OsString::from(&branch),
            worktree_path.as_os_str().to_os_string(),
            OsString::from("HEAD"),
        ],
        GIT_WORKTREE_TIMEOUT,
        GIT_WORKTREE_MAX_STDOUT_CHARS,
        GIT_MAX_STDERR_CHARS,
    )
    .context("run git worktree add")?;
    if !output.succeeded() {
        return Err(anyhow!(command_error(
            "git worktree add",
            &output,
            GIT_WORKTREE_TIMEOUT,
        )));
    }

    Ok(WorktreeSessionPlan {
        git_root,
        worktree_path,
        branch,
        worktree_name,
    })
}

pub fn git_top_level(workspace: &Path) -> Result<PathBuf> {
    let output = run_git_command(
        vec![
            OsString::from("-C"),
            workspace.as_os_str().to_os_string(),
            OsString::from("rev-parse"),
            OsString::from("--show-toplevel"),
        ],
        GIT_QUERY_TIMEOUT,
        GIT_QUERY_MAX_STDOUT_CHARS,
        GIT_MAX_STDERR_CHARS,
    )
    .context("run git rev-parse --show-toplevel")?;
    if !output.succeeded() {
        return Err(anyhow!(command_error(
            "git rev-parse --show-toplevel",
            &output,
            GIT_QUERY_TIMEOUT,
        )));
    }
    if output.stdout_truncated {
        return Err(anyhow!(
            "git rev-parse --show-toplevel failed: stdout exceeded {GIT_QUERY_MAX_STDOUT_CHARS} characters"
        ));
    }
    let path = output.stdout.trim().to_string();
    if path.is_empty() {
        return Err(anyhow!("workspace is not inside a Git repository"));
    }
    PathBuf::from(path)
        .canonicalize()
        .context("resolve Git repository root")
}

pub fn validate_branch_name(branch: &str) -> Result<()> {
    let is_valid = !branch.is_empty()
        && branch.len() <= 96
        && !branch.starts_with('/')
        && !branch.ends_with('/')
        && !branch.ends_with('.')
        && !branch.contains("..")
        && !branch.contains("@{")
        && branch
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '/' | '-' | '_' | '.'));
    if is_valid {
        Ok(())
    } else {
        Err(anyhow!("invalid worktree branch name"))
    }
}

pub fn validate_worktree_name(name: &str) -> Result<()> {
    let is_valid = !name.is_empty()
        && name.len() <= 80
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'));
    if is_valid {
        Ok(())
    } else {
        Err(anyhow!("invalid worktree name"))
    }
}

pub fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut previous_dash = false;
    for ch in value.chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            previous_dash = false;
        } else if !previous_dash {
            slug.push('-');
            previous_dash = true;
        }
        if slug.len() >= 40 {
            break;
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "worktree".into()
    } else {
        slug
    }
}

fn run_git_command(
    args: Vec<OsString>,
    timeout: Duration,
    max_stdout_chars: usize,
    max_stderr_chars: usize,
) -> Result<ExecutionOutcome> {
    let mut request = ExecutionRequest::new("git");
    request.args = args;
    request.timeout = timeout;
    request.max_stdout_chars = max_stdout_chars;
    request.max_stderr_chars = max_stderr_chars;
    run_command(request, CancellationToken::default(), |_| {})
}

fn command_error(label: &str, output: &ExecutionOutcome, timeout: Duration) -> String {
    let stderr =
        retained_command_output(&output.stderr, output.stderr_truncated, "stderr truncated");
    let stdout =
        retained_command_output(&output.stdout, output.stdout_truncated, "stdout truncated");
    let detail = if stderr.is_empty() {
        stdout.as_str()
    } else {
        stderr.as_str()
    };
    let summary = match &output.termination {
        ExecutionTermination::Exited { .. } => format!("{label} failed"),
        ExecutionTermination::TimedOut => format!("{label} timed out after {timeout:?}"),
        ExecutionTermination::Cancelled => format!("{label} was cancelled"),
        ExecutionTermination::Inactive => format!("{label} stopped after becoming inactive"),
        ExecutionTermination::OutputLimit => format!("{label} exceeded its output limit"),
    };
    if detail.is_empty() {
        summary
    } else {
        format!("{summary}: {detail}")
    }
}

fn retained_command_output(output: &str, truncated: bool, marker: &str) -> String {
    let mut output = output.trim().to_string();
    if truncated {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push('[');
        output.push_str(marker);
        output.push(']');
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_safe_worktree_names() {
        assert!(validate_branch_name("gyro/feature-worktree").is_ok());
        assert!(validate_worktree_name("gyro-feature-worktree").is_ok());
        assert!(validate_branch_name("../escape").is_err());
        assert!(validate_branch_name("bad@{ref}").is_err());
        assert!(validate_worktree_name("../escape").is_err());
    }

    #[test]
    fn slugifies_generated_worktree_names() {
        assert_eq!(slugify("Worktree CLI workspace"), "worktree-cli-workspace");
        assert_eq!(slugify("///"), "worktree");
    }

    #[test]
    fn creates_git_worktree_under_gyro_paths() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init"]);
        run_git(&repo, &["config", "user.email", "gyro@example.test"]);
        run_git(&repo, &["config", "user.name", "Gyro Test"]);
        std::fs::write(repo.join("README.md"), "# test\n").unwrap();
        run_git(&repo, &["add", "README.md"]);
        run_git(&repo, &["commit", "-m", "initial"]);

        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let plan = create_worktree(
            &paths,
            &repo,
            "gyro/test-worktree",
            Some("gyro-test-worktree".into()),
        )
        .unwrap();

        assert_eq!(plan.git_root, repo.canonicalize().unwrap());
        assert_eq!(plan.branch, "gyro/test-worktree");
        assert_eq!(plan.worktree_name, "gyro-test-worktree");
        assert!(plan.worktree_path.exists());

        let output = run_test_git(&plan.worktree_path, &["branch", "--show-current"]);
        assert!(output.succeeded());
        assert_eq!(output.stdout.trim(), "gyro/test-worktree");
    }

    #[test]
    fn timeout_errors_include_the_command_and_limit() {
        let output = ExecutionOutcome {
            termination: ExecutionTermination::TimedOut,
            stdout: "partial output".into(),
            stderr: String::new(),
            stdout_truncated: false,
            stderr_truncated: false,
            duration_ms: 60_000,
        };

        assert_eq!(
            command_error("git worktree add", &output, GIT_WORKTREE_TIMEOUT),
            "git worktree add timed out after 60s: partial output"
        );
    }

    fn run_git(repo: &Path, args: &[&str]) {
        let output = run_test_git(repo, args);
        assert!(
            output.succeeded(),
            "git {:?} failed: {}",
            args,
            output.stderr
        );
    }

    fn run_test_git(repo: &Path, args: &[&str]) -> ExecutionOutcome {
        let mut command_args = vec![OsString::from("-C"), repo.as_os_str().to_os_string()];
        command_args.extend(args.iter().copied().map(OsString::from));
        run_git_command(
            command_args,
            GIT_QUERY_TIMEOUT,
            GIT_QUERY_MAX_STDOUT_CHARS,
            GIT_MAX_STDERR_CHARS,
        )
        .unwrap()
    }
}
