//! `gyro_git_commit`: stage and commit in one model call.
//!
//! The commit is local, so it is a workspace write (approval by default, never
//! in Plan mode); publishing it is still `gyro_github_push`. Git hooks run as
//! they would for the user. Staging refuses sensitive paths such as `.env`
//! before touching the index, and the commit refuses if anything sensitive is
//! staged, so a secret cannot reach history and then a push by this tool.
use crate::{
    capabilities::access::capability_path_is_sensitive_in_workspace,
    command_execution::run_command_output,
    git::{
        branches as git_branch_service,
        commands::{git_command, run_git_action},
        status_cache::git_repo_root,
    },
    workspace::files::workspace_root,
};
use gyro_core::CapabilityId;
use serde_json::{json, Value};
use std::path::Path;

pub(crate) const MAX_COMMIT_PATHS: usize = 200;
const MAX_COMMIT_MESSAGE_BYTES: usize = 16 * 1024;
const MAX_LISTED_FILES: usize = 100;

pub(crate) fn schema(id: CapabilityId) -> Option<(Value, Vec<&'static str>)> {
    (id == CapabilityId::WorkspaceGitCommit).then(|| {
        (
            json!({
                "message": { "type": "string", "description": "Commit message: a short subject line, then an optional blank line and body." },
                "paths": {
                    "type": "array",
                    "items": { "type": "string" },
                    "maxItems": MAX_COMMIT_PATHS,
                    "description": "Workspace-relative files or folders to stage before committing. Omit to commit what is already staged."
                },
                "all": { "type": "boolean", "description": "Stage every change in the workspace, including new and deleted files, before committing. Not with paths." }
            }),
            vec!["message"],
        )
    })
}

pub(crate) fn execute(workspace: &str, arguments: &Value) -> anyhow::Result<(String, Value)> {
    let message = commit_message(arguments)?;
    let paths = commit_paths(arguments)?;
    let all = arguments
        .get("all")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if all && !paths.is_empty() {
        anyhow::bail!("pass paths or all, not both");
    }
    let root = workspace_root(workspace)?;
    let repo_root = git_repo_root(&root)
        .ok_or_else(|| anyhow::anyhow!("this workspace is not a Git repository"))?;

    if all {
        refuse_sensitive(
            &root,
            &list_z(
                &root,
                &[
                    "ls-files",
                    "--modified",
                    "--others",
                    "--exclude-standard",
                    "-z",
                ],
            )?,
        )?;
        let mut add = git_command();
        add.arg("-C").arg(&root).args(["add", "-A", "--", "."]);
        run_git_action(add).map_err(anyhow::Error::msg)?;
    } else if !paths.is_empty() {
        refuse_sensitive(&root, &paths)?;
        let mut add = git_command();
        add.arg("-C")
            .arg(&root)
            .args(["add", "-A", "--"])
            .args(&paths);
        run_git_action(add).map_err(anyhow::Error::msg)?;
    }

    let staged = list_z(
        &repo_root,
        &["diff", "--cached", "--name-only", "--no-renames", "-z"],
    )?;
    if staged.is_empty() {
        anyhow::bail!("nothing is staged to commit; pass paths or all to stage changes first");
    }
    refuse_sensitive(&repo_root, &staged)?;

    let mut commit = git_command();
    commit
        .arg("-C")
        .arg(&root)
        .args(["commit", "--quiet", "--no-edit", "-m"])
        .arg(&message);
    let output = run_command_output(commit);
    git_branch_service::invalidate(workspace);
    let output = output?;
    if output.status != "done" {
        let detail = [output.stderr.trim(), output.stdout.trim()]
            .into_iter()
            .find(|text| !text.is_empty())
            .unwrap_or("git commit failed");
        anyhow::bail!("git commit failed (staged changes are kept): {detail}");
    }

    let mut head = git_command();
    head.arg("-C")
        .arg(&root)
        .args(["log", "-1", "--format=%H%x00%h%x00%s"]);
    let head = run_git_action(head).map_err(anyhow::Error::msg)?;
    let mut fields = head.stdout.trim_end().splitn(3, '\0');
    let sha = fields.next().unwrap_or_default().to_string();
    let short_sha = fields.next().unwrap_or_default().to_string();
    let subject = fields.next().unwrap_or_default().to_string();
    let mut branch = git_command();
    branch
        .arg("-C")
        .arg(&root)
        .args(["branch", "--show-current"]);
    let branch = run_command_output(branch)
        .ok()
        .map(|output| output.stdout.trim().to_string())
        .filter(|name| !name.is_empty());

    let file_count = staged.len();
    Ok((
        format!(
            "Committed {short_sha} on {} ({file_count} file{})",
            branch.as_deref().unwrap_or("a detached HEAD"),
            if file_count == 1 { "" } else { "s" }
        ),
        json!({
            "sha": sha,
            "shortSha": short_sha,
            "subject": subject,
            "branch": branch,
            "fileCount": file_count,
            "files": staged.into_iter().take(MAX_LISTED_FILES).collect::<Vec<_>>(),
            "filesTruncated": file_count > MAX_LISTED_FILES,
        }),
    ))
}

fn commit_message(arguments: &Value) -> anyhow::Result<String> {
    let message = arguments
        .get("message")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|message| !message.is_empty())
        .ok_or_else(|| anyhow::anyhow!("message is required"))?;
    if message.len() > MAX_COMMIT_MESSAGE_BYTES {
        anyhow::bail!("message is longer than {MAX_COMMIT_MESSAGE_BYTES} bytes");
    }
    if message.contains('\0') {
        anyhow::bail!("message must not contain NUL characters");
    }
    Ok(message.to_string())
}

fn commit_paths(arguments: &Value) -> anyhow::Result<Vec<String>> {
    let Some(values) = arguments.get("paths") else {
        return Ok(Vec::new());
    };
    let values = values
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("paths must be an array of strings"))?;
    if values.len() > MAX_COMMIT_PATHS {
        anyhow::bail!("paths has more than {MAX_COMMIT_PATHS} entries");
    }
    values
        .iter()
        .map(|value| {
            let path = value
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("paths must be an array of strings"))?;
            gyro_core::normalize_capability_relative_path(path)
        })
        .collect()
}

/// Runs a NUL-separated listing command and returns its entries.
fn list_z(root: &Path, args: &[&str]) -> anyhow::Result<Vec<String>> {
    let mut command = git_command();
    command.arg("-C").arg(root).args(args);
    let output = run_git_action(command).map_err(anyhow::Error::msg)?;
    Ok(output
        .stdout
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .map(str::to_string)
        .collect())
}

fn refuse_sensitive(root: &Path, paths: &[String]) -> anyhow::Result<()> {
    for path in paths {
        // A deleted file no longer resolves; its name alone still decides.
        let sensitive = if root.join(path).symlink_metadata().is_ok() {
            capability_path_is_sensitive_in_workspace(root, path)?
        } else {
            gyro_core::capability_path_is_sensitive(path)
        };
        if sensitive {
            anyhow::bail!(
                "refusing to commit {path}: it may hold secrets. Leave it out, or ask the user to commit it themselves"
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    fn repository() -> (tempfile::TempDir, std::path::PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-b", "main"]);
        git(&root, &["config", "user.name", "Gyro Fixture"]);
        git(&root, &["config", "user.email", "fixture@example.test"]);
        git(&root, &["config", "commit.gpgsign", "false"]);
        std::fs::write(root.join("a.txt"), "a\n").unwrap();
        git(&root, &["add", "a.txt"]);
        git(&root, &["commit", "-q", "-m", "init"]);
        (temp, root)
    }

    #[test]
    fn stages_named_paths_and_commits_only_them() {
        let (_temp, root) = repository();
        let workspace = root.to_string_lossy().to_string();
        std::fs::write(root.join("a.txt"), "changed\n").unwrap();
        std::fs::write(root.join("b.txt"), "new\n").unwrap();

        let (summary, data) = execute(
            &workspace,
            &json!({ "message": "Update a", "paths": ["a.txt"] }),
        )
        .unwrap();
        assert!(summary.starts_with("Committed "), "{summary}");
        assert_eq!(data["branch"], "main");
        assert_eq!(data["subject"], "Update a");
        assert_eq!(data["files"], json!(["a.txt"]));
        assert_eq!(git(&root, &["status", "--porcelain"]), "?? b.txt\n");
        assert_eq!(git(&root, &["rev-parse", "HEAD"]).trim(), data["sha"]);
    }

    #[test]
    fn all_stages_new_and_deleted_files() {
        let (_temp, root) = repository();
        let workspace = root.to_string_lossy().to_string();
        std::fs::remove_file(root.join("a.txt")).unwrap();
        std::fs::write(root.join("b.txt"), "new\n").unwrap();

        let (_, data) = execute(&workspace, &json!({ "message": "Swap", "all": true })).unwrap();
        assert_eq!(data["fileCount"], 2);
        assert_eq!(git(&root, &["status", "--porcelain"]), "");
    }

    #[test]
    fn refuses_empty_conflicting_and_secret_commits_without_staging() {
        let (_temp, root) = repository();
        let workspace = root.to_string_lossy().to_string();
        let nothing = execute(&workspace, &json!({ "message": "Nothing" })).unwrap_err();
        assert!(
            nothing.to_string().contains("nothing is staged"),
            "{nothing}"
        );
        assert!(execute(&workspace, &json!({ "message": "  " })).is_err());
        assert!(execute(
            &workspace,
            &json!({ "message": "x", "all": true, "paths": ["a.txt"] })
        )
        .is_err());
        assert!(execute(
            &workspace,
            &json!({ "message": "x", "paths": ["../outside"] })
        )
        .is_err());

        std::fs::write(root.join(".env"), "TOKEN=secret\n").unwrap();
        for arguments in [
            json!({ "message": "Leak", "paths": [".env"] }),
            json!({ "message": "Leak", "all": true }),
        ] {
            let error = execute(&workspace, &arguments).unwrap_err();
            assert!(
                error.to_string().contains("refusing to commit .env"),
                "{error}"
            );
            assert_eq!(git(&root, &["diff", "--cached", "--name-only"]), "");
        }

        // A secret the user staged by hand still blocks this tool's commit.
        git(&root, &["add", "-f", ".env"]);
        assert!(execute(&workspace, &json!({ "message": "Leak" })).is_err());
        assert_eq!(git(&root, &["rev-list", "--count", "HEAD"]).trim(), "1");
    }
}
