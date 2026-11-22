//! Agent runs on the user's own server, over SSH.
//!
//! Gyro uploads a small stdlib-only Python runner (`runner/gyro_runner.py`)
//! to `~/.gyro/runner/` and talks to it one verb at a time. Code moves with
//! git: a snapshot of the working tree goes up as `refs/gyro/base/{id}`, and
//! the agent's commit comes back as the branch `gyro/cloud/{id}`.
//!
//! The server keeps the run alive on its own. Gyro can disconnect, quit or
//! sleep, then reattach by byte offset and get every event exactly once.
//!
//! Gyro never reads, copies or syncs a CLI's login. The user signs in on the
//! server in a terminal; `sign_in_status` only learns yes or no.
mod git;

use crate::ssh::{exec::Remote, Options};
use anyhow::{bail, Context, Result};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fmt, path::Path, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    process::{Child, ChildStdout},
};

pub use git::{project_name, Snapshot};

/// The runner, embedded so the app and the server copy always match.
pub const RUNNER: &str = include_str!("../../runner/gyro_runner.py");
const RUNNER_COMMAND: &str = "python3 \"$HOME/.gyro/runner/gyro_runner.py\"";
const INSTALL_COMMAND: &str = "umask 077 && mkdir -p \"$HOME/.gyro/runner\" && chmod 700 \"$HOME/.gyro\" \"$HOME/.gyro/runner\" && cat > \"$HOME/.gyro/runner/.gyro_runner.py.part\" && mv -f \"$HOME/.gyro/runner/.gyro_runner.py.part\" \"$HOME/.gyro/runner/gyro_runner.py\"";
/// Longest event line Gyro accepts. The runner caps output lines at 64K
/// characters, so a JSON line stays well under this.
const MAX_EVENT_LINE: u64 = 1024 * 1024;
const VERB_TIMEOUT: Duration = Duration::from_secs(60);

pub fn runner_sha256() -> String {
    hex(&Sha256::digest(RUNNER.as_bytes()))
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Run ids, project names and CLI ids, as the runner accepts them.
pub fn valid_name(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
}
fn checked(value: &str, what: &str) -> Result<()> {
    if !valid_name(value) {
        bail!("Invalid {what}");
    }
    Ok(())
}
pub fn new_run_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// A refusal from the runner, with its stable code (`busy`, `cli_not_found`…).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunnerError {
    pub code: String,
    pub message: String,
}
impl fmt::Display for RunnerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for RunnerError {}

/// The runner error code behind `error`, if the runner refused the request.
pub fn runner_error_code(error: &anyhow::Error) -> Option<&str> {
    error.downcast_ref::<RunnerError>().map(|e| e.code.as_str())
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct CliProbe {
    pub id: String,
    pub binary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version_argv: Option<Vec<String>>,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct CliPresence {
    pub id: String,
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Doctor {
    pub runner_version: String,
    pub runner_sha256: String,
    pub os: String,
    pub distro: Option<String>,
    pub arch: String,
    pub python: String,
    pub git: Option<String>,
    pub home_free_bytes: u64,
    pub npm: Value,
    pub clis: Vec<CliPresence>,
}
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
pub struct SignInRule {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit: Option<i32>,
    #[serde(rename = "match", skip_serializing_if = "Option::is_none")]
    pub matches: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub not_match: Option<String>,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct SignInCheck {
    pub argv: Vec<String>,
    pub signed_in: SignInRule,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<u32>,
}
/// Only a verdict. The status command's output can hold account emails, so
/// it never leaves the server.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct SignInStatus {
    pub found: bool,
    pub signed_in: Option<bool>,
    #[serde(default)]
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitAuthor {
    pub name: String,
    pub email: String,
}
/// What the runner's `start` verb takes. `argv` holds one `"{task}"` element,
/// which the runner swaps for the task text without a shell.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct StartSpec {
    pub id: String,
    pub project: String,
    pub cli: String,
    pub base_ref: String,
    pub task: String,
    pub argv: Vec<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idle_seconds: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_log_bytes: Option<u64>,
    pub allow_parallel: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_author: Option<GitAuthor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit_message: Option<String>,
}
/// A run request before Gyro has pushed the base. `launch` fills in the rest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunRequest {
    pub cli: String,
    pub task: String,
    pub argv: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub timeout_seconds: Option<u32>,
    pub idle_seconds: Option<u32>,
    pub allow_parallel: bool,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct Started {
    pub id: String,
    pub pid: u32,
    pub base_commit: String,
    pub result_branch: String,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RunState {
    Starting,
    Running,
    Committing,
    Done,
    Failed,
    Timeout,
    Stopped,
    Lost,
}
impl RunState {
    pub fn is_terminal(self) -> bool {
        !matches!(self, Self::Starting | Self::Running | Self::Committing)
    }
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct RunStatus {
    pub id: String,
    pub project: String,
    pub cli: String,
    pub state: RunState,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub ended_at: Option<u64>,
    pub base_commit: String,
    pub result_branch: String,
    pub exit_code: Option<i32>,
    pub result_commit: Option<String>,
    pub changed: Option<bool>,
    pub reason: Option<String>,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct RunSummary {
    pub id: String,
    pub project: String,
    pub cli: String,
    pub state: RunState,
    pub reason: Option<String>,
    pub created_at: u64,
    pub ended_at: Option<u64>,
    pub exit_code: Option<i32>,
    pub result_branch: String,
    pub changed: Option<bool>,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RunEvent {
    /// One line of the agent's combined output, with tokens redacted.
    Out {
        line: String,
        #[serde(default)]
        cut: bool,
    },
    State {
        state: RunState,
    },
    /// The log hit its size cap; later output was dropped.
    Truncated,
    End {
        state: RunState,
        reason: Option<String>,
        exit_code: Option<i32>,
        result_commit: Option<String>,
        changed: Option<bool>,
    },
    /// A kind from a newer runner. Skipped, but its bytes still count.
    #[serde(other)]
    Unknown,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Event {
    /// Milliseconds since the epoch, on the server's clock.
    pub at: u64,
    /// Byte offset just past this event. Reattach from here to continue.
    pub offset: u64,
    pub event: RunEvent,
}
#[derive(Deserialize)]
struct EventLine {
    t: u64,
    #[serde(flatten)]
    event: RunEvent,
}

/// Signs that a run failed because the CLI is signed out on the server,
/// from the phase 0 checks. A catalog entry can override these later.
pub fn needs_sign_in(cli: &str, event: &RunEvent) -> bool {
    match (cli, event) {
        ("codex", RunEvent::Out { line, .. }) => {
            line.contains("turn.failed") && line.contains("401")
        }
        ("claude", RunEvent::Out { line, .. }) => line.contains("Not logged in"),
        ("cursor", RunEvent::Out { line, .. }) => line.contains("Authentication required"),
        ("gemini", RunEvent::End { exit_code, .. }) => *exit_code == Some(41),
        _ => false,
    }
}

/// A live `attach`. Dropping it closes the SSH channel; the run carries on.
pub struct Attach {
    child: Child,
    reader: BufReader<ChildStdout>,
    stderr: tokio::task::JoinHandle<Vec<u8>>,
    offset: u64,
    line: Vec<u8>,
}
impl Attach {
    pub fn offset(&self) -> u64 {
        self.offset
    }
    /// The next event, or `None` when the stream ends. After an `end` event
    /// the runner closes the stream. If it closes without one, the connection
    /// dropped: attach again from `offset()`.
    pub async fn next(&mut self) -> Result<Option<Event>> {
        self.line.clear();
        let read = (&mut self.reader)
            .take(MAX_EVENT_LINE)
            .read_until(b'\n', &mut self.line)
            .await?;
        if read == 0 || self.line.last() != Some(&b'\n') {
            if read as u64 >= MAX_EVENT_LINE {
                bail!("The server sent an event line that is too long");
            }
            // A partial line means the channel dropped mid-write. Its
            // bytes are read again on the next attach.
            return self.finish().await.map(|_| None);
        }
        let value: Value = serde_json::from_slice(&self.line)
            .context("The server sent an event Gyro could not read")?;
        if value.get("ok") == Some(&Value::Bool(false)) {
            return Err(refusal(&value).into());
        }
        let line: EventLine = serde_json::from_value(value)
            .context("The server sent an event Gyro could not read")?;
        self.offset += read as u64;
        Ok(Some(Event {
            at: line.t,
            offset: self.offset,
            event: line.event,
        }))
    }
    async fn finish(&mut self) -> Result<()> {
        let status = self.child.wait().await?;
        if status.code() == Some(255) {
            let stderr = (&mut self.stderr).await.unwrap_or_default();
            bail!(
                "{}",
                crate::ssh::exec::connect_failure(&String::from_utf8_lossy(&stderr))
            );
        }
        Ok(())
    }
    pub fn close(mut self) {
        let _ = self.child.start_kill();
    }
}

fn refusal(value: &Value) -> RunnerError {
    let text = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .chars()
            .take(500)
            .collect::<String>()
    };
    RunnerError {
        code: text("error"),
        message: text("message"),
    }
}

/// Parses the runner's one-line JSON reply.
pub(crate) fn parse_reply(code: Option<i32>, stdout: &[u8], stderr: &str) -> Result<Value> {
    let text = String::from_utf8_lossy(stdout);
    let last = text.lines().rev().find(|line| !line.trim().is_empty());
    if let Some(value) = last.and_then(|line| serde_json::from_str::<Value>(line).ok()) {
        match value.get("ok") {
            Some(Value::Bool(true)) if code == Some(0) => return Ok(value),
            Some(Value::Bool(false)) => return Err(refusal(&value).into()),
            _ => {}
        }
    }
    if code == Some(127)
        || stderr.contains("python3: not found")
        || stderr.contains("python3: command not found")
    {
        bail!("Python 3 is not installed on the server. Install python3 (3.8 or newer) and try again.");
    }
    if stderr.contains("can't open file") && stderr.contains("gyro_runner.py") {
        return Err(RunnerError {
            code: "runner_missing".into(),
            message: "The Gyro runner is not installed on the server".into(),
        }
        .into());
    }
    let hint: String = stderr
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default()
        .chars()
        .take(200)
        .collect();
    if hint.is_empty() {
        bail!("The Gyro runner on the server failed (exit {code:?})");
    }
    bail!("The Gyro runner on the server failed: {hint}")
}

fn decode<T: DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value)
        .context("The Gyro runner sent a reply this version of Gyro cannot read")
}

/// One saved SSH host, seen as a place to run agents.
pub struct RunnerHost {
    remote: Remote,
}

#[derive(Clone, Debug)]
pub struct Installed {
    /// True when this call uploaded a new runner.
    pub uploaded: bool,
    pub doctor: Doctor,
}

impl RunnerHost {
    pub fn new(options: Options) -> Result<Self> {
        Ok(Self {
            remote: Remote::new(options)?,
        })
    }
    #[cfg(test)]
    pub(crate) fn with_remote(remote: Remote) -> Self {
        Self { remote }
    }
    pub fn remote(&self) -> &Remote {
        &self.remote
    }

    async fn verb(
        &self,
        verb: &str,
        args: &[&str],
        input: Option<&Value>,
        timeout: Duration,
    ) -> Result<Value> {
        for arg in args {
            if !(valid_name(arg) || *arg == "--from" || *arg == "--keep-branch") {
                bail!("Invalid runner argument");
            }
        }
        let mut command = format!("{RUNNER_COMMAND} {verb}");
        for arg in args {
            command.push(' ');
            command.push_str(arg);
        }
        let input = match input {
            Some(value) => serde_json::to_vec(value)?,
            None => Vec::new(),
        };
        let output = self.remote.run(&command, &input, timeout).await?;
        parse_reply(output.code, &output.stdout, &output.stderr)
    }

    /// Makes sure the server has this app's runner, uploading it if not.
    pub async fn ensure_runner(&self) -> Result<Installed> {
        let expected = runner_sha256();
        match self.doctor(&[]).await {
            Ok(doctor) if doctor.runner_sha256 == expected => {
                return Ok(Installed {
                    uploaded: false,
                    doctor,
                })
            }
            Ok(_) => {}
            Err(error) if runner_error_code(&error) == Some("runner_missing") => {}
            Err(error) => return Err(error),
        }
        let output = self
            .remote
            .run(INSTALL_COMMAND, RUNNER.as_bytes(), VERB_TIMEOUT)
            .await?;
        if output.code != Some(0) {
            bail!("Could not install the Gyro runner in ~/.gyro on the server");
        }
        let doctor = self.doctor(&[]).await?;
        if doctor.runner_sha256 != expected {
            bail!("The Gyro runner on the server does not match this app after installing it");
        }
        Ok(Installed {
            uploaded: true,
            doctor,
        })
    }
    pub async fn doctor(&self, clis: &[CliProbe]) -> Result<Doctor> {
        let timeout = VERB_TIMEOUT + Duration::from_secs(15 * clis.len() as u64);
        decode(
            self.verb("doctor", &[], Some(&json!({ "clis": clis })), timeout)
                .await?,
        )
    }
    pub async fn sign_in_status(&self, check: &SignInCheck) -> Result<SignInStatus> {
        let timeout = Duration::from_secs(u64::from(check.timeout_seconds.unwrap_or(20)) + 30);
        decode(
            self.verb("status", &[], Some(&serde_json::to_value(check)?), timeout)
                .await?,
        )
    }
    /// Creates the bare repo for `project` if it is missing.
    pub async fn prepare(&self, project: &str) -> Result<String> {
        checked(project, "project name")?;
        let reply = self
            .verb(
                "prepare",
                &[],
                Some(&json!({ "project": project })),
                VERB_TIMEOUT,
            )
            .await?;
        reply
            .get("remote_path")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .context("The Gyro runner did not say where the project repo is")
    }
    fn repo_url(&self, project: &str) -> Result<String> {
        checked(project, "project name")?;
        self.remote.git_url(&format!(".gyro/repos/{project}.git"))
    }
    /// Snapshots the working tree (commits, staged, unstaged and untracked
    /// files, minus .gitignore) and pushes it as `refs/gyro/base/{id}`. The
    /// user's index, working tree, branches and stash are left alone.
    pub async fn push_base(&self, repo: &Path, project: &str, run_id: &str) -> Result<Snapshot> {
        checked(run_id, "run id")?;
        let snapshot = git::snapshot(repo).await?;
        git::push(
            &snapshot.root,
            &self.repo_url(project)?,
            &self.remote.git_ssh_command()?,
            &snapshot.commit,
            &format!("refs/gyro/base/{run_id}"),
        )
        .await?;
        Ok(snapshot)
    }
    pub async fn start(&self, spec: &StartSpec) -> Result<Started> {
        checked(&spec.id, "run id")?;
        decode(
            self.verb(
                "start",
                &[],
                Some(&serde_json::to_value(spec)?),
                VERB_TIMEOUT,
            )
            .await?,
        )
    }
    /// Prepare, snapshot, push and start, in that order.
    pub async fn launch(&self, repo: &Path, run_id: &str, request: &RunRequest) -> Result<Started> {
        checked(run_id, "run id")?;
        checked(&request.cli, "CLI id")?;
        let snapshot = git::snapshot(repo).await?;
        let project = project_name(&snapshot.root);
        self.prepare(&project).await?;
        git::push(
            &snapshot.root,
            &self.repo_url(&project)?,
            &self.remote.git_ssh_command()?,
            &snapshot.commit,
            &format!("refs/gyro/base/{run_id}"),
        )
        .await?;
        self.start(&StartSpec {
            id: run_id.into(),
            project,
            cli: request.cli.clone(),
            base_ref: format!("refs/gyro/base/{run_id}"),
            task: request.task.clone(),
            argv: request.argv.clone(),
            env: request.env.clone(),
            timeout_seconds: request.timeout_seconds,
            idle_seconds: request.idle_seconds,
            max_log_bytes: None,
            allow_parallel: request.allow_parallel,
            git_author: None,
            commit_message: None,
        })
        .await
    }
    /// Streams events from byte `from` on. A runner refusal (`no_run`,
    /// `bad_offset`) arrives as the first `next()` error.
    pub async fn attach(&self, run_id: &str, from: u64) -> Result<Attach> {
        checked(run_id, "run id")?;
        let mut command = format!("{RUNNER_COMMAND} attach {run_id}");
        if from > 0 {
            command.push_str(&format!(" --from {from}"));
        }
        let mut child = self.remote.spawn(&command)?;
        drop(child.stdin.take());
        let stdout = child.stdout.take().context("SSH output unavailable")?;
        let mut errors = child
            .stderr
            .take()
            .context("SSH error stream unavailable")?;
        let stderr = tokio::spawn(async move {
            let mut tail = Vec::new();
            let mut block = [0u8; 4096];
            while let Ok(n) = errors.read(&mut block).await {
                if n == 0 {
                    break;
                }
                tail.extend_from_slice(&block[..n]);
                let excess = tail.len().saturating_sub(4096);
                tail.drain(..excess);
            }
            tail
        });
        Ok(Attach {
            child,
            reader: BufReader::new(stdout),
            stderr,
            offset: from,
            line: Vec::new(),
        })
    }
    pub async fn show(&self, run_id: &str) -> Result<RunStatus> {
        checked(run_id, "run id")?;
        decode(self.verb("show", &[run_id], None, VERB_TIMEOUT).await?)
    }
    pub async fn stop(&self, run_id: &str) -> Result<RunStatus> {
        checked(run_id, "run id")?;
        decode(self.verb("stop", &[run_id], None, VERB_TIMEOUT).await?)
    }
    pub async fn list(&self) -> Result<Vec<RunSummary>> {
        let reply = self.verb("list", &[], None, VERB_TIMEOUT).await?;
        decode(reply.get("runs").cloned().unwrap_or(Value::Null))
    }
    /// Removes the run's worktree, logs and base ref on the server.
    pub async fn cleanup(&self, run_id: &str, keep_branch: bool) -> Result<()> {
        checked(run_id, "run id")?;
        let args: &[&str] = if keep_branch {
            &[run_id, "--keep-branch"]
        } else {
            &[run_id]
        };
        self.verb("cleanup", args, None, VERB_TIMEOUT).await?;
        Ok(())
    }
    /// Fetches `gyro/cloud/{id}` into the local repo as a branch of the same
    /// name, and returns its commit. Nothing is checked out or merged.
    pub async fn fetch_result(&self, repo: &Path, project: &str, run_id: &str) -> Result<String> {
        checked(run_id, "run id")?;
        let branch = format!("refs/heads/gyro/cloud/{run_id}");
        git::fetch(
            repo,
            &self.repo_url(project)?,
            &self.remote.git_ssh_command()?,
            &branch,
        )
        .await
    }
}

/// What Gyro keeps on the Mac about a run, so it can reattach after a
/// restart. No task text, output or credentials.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServerRun {
    pub id: String,
    pub host_id: String,
    pub project: String,
    pub repo: String,
    pub cli: String,
    pub state: RunState,
    /// Byte offset of the last event Gyro has handled.
    pub offset: u64,
    pub result_branch: String,
    #[serde(default)]
    pub result_commit: Option<String>,
    pub created_at: u64,
}

#[cfg(test)]
mod e2e_tests;
#[cfg(test)]
mod tests;
