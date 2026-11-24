//! The local git side of a server run: snapshot, push the base, fetch the
//! result. The user's index, working tree, branches and stash are never
//! touched; the only local change is a fetched `gyro/cloud/{id}` branch.
use anyhow::{bail, ensure, Context, Result};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::process::Command;

/// Variables that would point git at another repo, index or transport.
const CLEARED_ENV: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_SSH_VARIANT",
    "GIT_PROXY_COMMAND",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_EXEC_PATH",
];
const AUTHOR: &str = "Gyro";
const AUTHOR_EMAIL: &str = "runner@gyro.invalid";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    /// The repository's top-level directory.
    pub root: PathBuf,
    /// A commit holding the working tree as it is now. Its parent is HEAD,
    /// when there is one.
    pub commit: String,
    pub head: Option<String>,
}

fn git(dir: &Path) -> Command {
    let mut command = Command::new("git");
    for name in CLEARED_ENV {
        command.env_remove(name);
    }
    command
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_VARIANT", "ssh")
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "protocol.allow=never",
            "-c",
            "protocol.ssh.allow=always",
        ])
        .stdin(Stdio::null())
        .kill_on_drop(true);
    command
}

async fn output(mut command: Command, what: &str) -> Result<String> {
    let output = command
        .output()
        .await
        .with_context(|| format!("Could not run git to {what}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let hint: String = stderr
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or_default()
            .chars()
            .take(300)
            .collect();
        bail!("Could not {what}: {hint}");
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

/// A temporary index, removed when dropped.
struct TempIndex(PathBuf);
impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let _ = std::fs::remove_file(self.0.with_extension("index.lock"));
    }
}

/// Commits the working tree, as `git add -A` would see it, without touching
/// the user's index. Unstaged and untracked files are included; ignored
/// files are not.
pub async fn snapshot(repo: &Path) -> Result<Snapshot> {
    let mut command = git(repo);
    command.args(["rev-parse", "--show-toplevel"]);
    let root = PathBuf::from(output(command, "find the git repository").await?);
    let mut command = git(&root);
    command.args(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    let head = output(command, "read HEAD")
        .await
        .ok()
        .filter(|s| !s.is_empty());
    let mut command = git(&root);
    command.args(["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    let index = PathBuf::from(output(command, "find the git index").await?);

    let temp = TempIndex(std::env::temp_dir().join(format!(
        "gyro-snapshot-{}.index",
        uuid::Uuid::new_v4().simple()
    )));
    if index.exists() {
        // Starting from the real index keeps stat data, so `add -A` only
        // reads files that changed.
        use std::os::unix::fs::OpenOptionsExt;
        let mut source = std::fs::File::open(&index).context("Could not read the git index")?;
        let mut target = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp.0)
            .context("Could not create a temporary git index")?;
        std::io::copy(&mut source, &mut target).context("Could not copy the git index")?;
    }
    let mut command = git(&root);
    command
        .env("GIT_INDEX_FILE", &temp.0)
        .args(["add", "-A", "--", "."]);
    output(command, "collect changed files").await?;
    let mut command = git(&root);
    command.env("GIT_INDEX_FILE", &temp.0).arg("write-tree");
    let tree = output(command, "write the snapshot").await?;

    let mut command = git(&root);
    command
        .env("GIT_AUTHOR_NAME", AUTHOR)
        .env("GIT_AUTHOR_EMAIL", AUTHOR_EMAIL)
        .env("GIT_COMMITTER_NAME", AUTHOR)
        .env("GIT_COMMITTER_EMAIL", AUTHOR_EMAIL)
        .args(["commit-tree", &tree, "-m", "Gyro snapshot"]);
    if let Some(head) = &head {
        command.args(["-p", head]);
    }
    let commit = output(command, "write the snapshot commit").await?;
    Ok(Snapshot { root, commit, head })
}

pub async fn push(
    root: &Path,
    url: &str,
    ssh_command: &str,
    commit: &str,
    target: &str,
) -> Result<()> {
    if !commit.chars().all(|c| c.is_ascii_hexdigit()) || !target.starts_with("refs/gyro/base/") {
        bail!("Invalid push");
    }
    let mut command = git(root);
    command.env("GIT_SSH_COMMAND", ssh_command).args([
        "push",
        "--no-verify",
        "--quiet",
        "--",
        url,
        &format!("{commit}:{target}"),
    ]);
    output(command, "send the project to the server").await?;
    Ok(())
}

/// Fetches `branch` (a full `refs/heads/gyro/cloud/…` ref) to the same name
/// and returns the commit it now points at.
pub async fn fetch(
    repo: &Path,
    url: &str,
    ssh_command: &str,
    branch: &str,
    expected: &str,
) -> Result<String> {
    if !branch.starts_with("refs/heads/gyro/cloud/") {
        bail!("Invalid result branch");
    }
    ensure!(
        matches!(expected.len(), 40 | 64) && expected.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "Invalid result commit"
    );
    let mut command = git(repo);
    command.env("GIT_SSH_COMMAND", ssh_command).args([
        "fetch",
        "--no-tags",
        "--quiet",
        "--no-write-fetch-head",
        "--",
        url,
        branch,
    ]);
    output(command, "fetch the result from the server").await?;

    let mut command = git(repo);
    command.args(["cat-file", "-t", expected]);
    ensure!(
        output(command, "read the recorded result commit").await? == "commit",
        "The recorded result is not a Git commit"
    );

    // Fetching the object first lets us create the exact branch once. A retry
    // is harmless, while a pre-existing branch with local edits stays intact.
    let mut create = git(repo);
    create.args([
        "update-ref",
        "--no-deref",
        branch,
        expected,
        &"0".repeat(expected.len()),
    ]);
    if output(create, "create the result branch").await.is_ok() {
        return Ok(expected.into());
    }
    let mut command = git(repo);
    command.args(["rev-parse", "--verify", &format!("{branch}^{{commit}}")]);
    let current = output(command, "read the existing result branch").await?;
    ensure!(
        current == expected,
        "The result branch already has a different commit on this Mac"
    );
    Ok(current)
}

/// A stable server-side name for a local repo: its folder name plus a short
/// hash of its path, so two clones named `app` do not share a repo.
pub fn project_name(root: &Path) -> String {
    let base: String = root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .take(40)
        .collect();
    let base = if base.starts_with(|c: char| c.is_ascii_alphanumeric()) {
        base
    } else {
        format!("p{base}")
    };
    let digest = Sha256::digest(root.to_string_lossy().as_bytes());
    let hash: String = digest.iter().take(5).map(|b| format!("{b:02x}")).collect();
    format!("{base}-{hash}")
}
