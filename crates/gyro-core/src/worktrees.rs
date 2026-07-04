use crate::paths::GyroPaths;
use anyhow::{anyhow, Context, Result};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

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

    let output = Command::new("git")
        .arg("-C")
        .arg(&git_root)
        .args(["worktree", "add", "-b", &branch])
        .arg(&worktree_path)
        .arg("HEAD")
        .output()
        .context("run git worktree add")?;
    if !output.status.success() {
        return Err(anyhow!(command_error("git worktree add", output)));
    }

    Ok(WorktreeSessionPlan {
        git_root,
        worktree_path,
        branch,
        worktree_name,
    })
}

pub fn git_top_level(workspace: &Path) -> Result<PathBuf> {
    let output = Command::new("git")
        .arg("-C")
        .arg(workspace)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .context("run git rev-parse --show-toplevel")?;
    if !output.status.success() {
        return Err(anyhow!(command_error(
            "git rev-parse --show-toplevel",
            output,
        )));
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
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

fn command_error(label: &str, output: Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let detail = if stderr.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };
    if detail.is_empty() {
        format!("{label} failed")
    } else {
        format!("{label} failed: {detail}")
    }
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

        let output = Command::new("git")
            .arg("-C")
            .arg(&plan.worktree_path)
            .args(["branch", "--show-current"])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "gyro/test-worktree"
        );
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
