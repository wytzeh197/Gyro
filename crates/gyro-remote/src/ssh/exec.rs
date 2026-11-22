//! One-shot and streaming commands on a user's own server, over OpenSSH.
//!
//! Remote commands are fixed strings built from constants and validated
//! identifiers. Anything the user typed (task text, file contents) travels on
//! stdin, never on the command line.
use super::{shell_quote, ssh_failure, Options};
use anyhow::{bail, Context, Result};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
};

/// Most a one-shot command may print before Gyro stops reading it.
const MAX_STDOUT: usize = 8 * 1024 * 1024;
/// Only the tail of stderr is kept, for error messages.
const MAX_STDERR: usize = 8 * 1024;

#[derive(Clone, Debug)]
pub struct Remote {
    options: Options,
    program: PathBuf,
    /// Extra `-o` options placed before the hardened list. OpenSSH takes the
    /// first value it sees, so these win. Tests use it for a private
    /// known_hosts file; the app leaves it empty.
    extra: Vec<String>,
}

#[derive(Debug)]
pub struct Output {
    /// The remote command's exit code. 255 never appears here: that is
    /// OpenSSH's own failure and becomes an error instead.
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

impl Remote {
    pub fn new(options: Options) -> Result<Self> {
        options.validate()?;
        Ok(Self {
            options,
            program: PathBuf::from("/usr/bin/ssh"),
            extra: Vec::new(),
        })
    }
    #[cfg(test)]
    pub(crate) fn with_program(
        options: Options,
        program: &Path,
        extra: Vec<String>,
    ) -> Result<Self> {
        let mut remote = Self::new(options)?;
        remote.program = program.to_path_buf();
        remote.extra = extra;
        Ok(remote)
    }
    pub fn options(&self) -> &Options {
        &self.options
    }
    pub(crate) fn exec_arguments(&self, command: &str) -> Result<Vec<String>> {
        let mut args = self.options.exec_arguments(command)?;
        args.splice(1..1, self.extra.iter().cloned());
        Ok(args)
    }
    /// The value for `GIT_SSH_COMMAND`. Git runs it through `sh` and appends
    /// the destination and `git-upload-pack`/`git-receive-pack` itself.
    pub fn git_ssh_command(&self) -> Result<String> {
        let mut parts = vec![self.program.to_string_lossy().into_owned(), "-T".into()];
        parts.extend(self.extra.iter().cloned());
        parts.extend(self.options.base_arguments(false)?);
        Ok(parts
            .iter()
            .map(|part| shell_quote(part))
            .collect::<Vec<_>>()
            .join(" "))
    }
    /// An ssh:// URL for a path under the remote home directory.
    pub fn git_url(&self, home_relative: &str) -> Result<String> {
        self.options.validate()?;
        if home_relative.starts_with('/')
            || home_relative
                .split('/')
                .any(|part| part.is_empty() || part == "..")
            || !home_relative
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "._-/".contains(c))
        {
            bail!("Invalid remote repository path");
        }
        let host = &self.options.host;
        let host = if host.contains(':') && !host.starts_with('[') {
            format!("[{host}]")
        } else {
            host.clone()
        };
        // User and port come from the ssh arguments, not the URL.
        Ok(format!("ssh://{host}/~/{home_relative}"))
    }
    pub(crate) fn spawn(&self, command: &str) -> Result<Child> {
        Command::new(&self.program)
            .args(self.exec_arguments(command)?)
            .env("SSH_ASKPASS_REQUIRE", "never")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .context("Could not start OpenSSH")
    }
    /// Runs `command`, writes `input` to its stdin, and waits for it.
    pub async fn run(&self, command: &str, input: &[u8], timeout: Duration) -> Result<Output> {
        let mut child = self.spawn(command)?;
        let mut stdin = child.stdin.take().context("SSH input unavailable")?;
        let stdout = child.stdout.take().context("SSH output unavailable")?;
        let stderr = child
            .stderr
            .take()
            .context("SSH error stream unavailable")?;
        let input = input.to_vec();
        let work = async move {
            let write = async move {
                // A remote command that exits early closes the pipe. Its exit
                // code tells the story, so a write error is not one.
                let _ = stdin.write_all(&input).await;
                let _ = stdin.shutdown().await;
                drop(stdin);
            };
            let (_, out, err) = tokio::join!(
                write,
                read_capped(stdout, MAX_STDOUT, false),
                read_capped(stderr, MAX_STDERR, true)
            );
            let status = child.wait().await?;
            anyhow::Ok((status, out?, err?))
        };
        let (status, stdout, stderr) = match tokio::time::timeout(timeout, work).await {
            Ok(result) => result?,
            // Dropping the future drops the child, which kills it.
            Err(_) => bail!("The server did not answer in time"),
        };
        let stderr = String::from_utf8_lossy(&stderr).into_owned();
        if status.code() == Some(255) {
            bail!("{}", connect_failure(&stderr));
        }
        Ok(Output {
            code: status.code(),
            stdout,
            stderr,
        })
    }
}

/// What to tell the user when OpenSSH itself failed (exit 255).
pub(crate) fn connect_failure(stderr: &str) -> &'static str {
    ssh_failure(stderr).unwrap_or(
        "Could not connect over SSH. Check reachability, the SSH service, host trust, and your SSH key.",
    )
}

/// Reads a whole stream, keeping at most `limit` bytes: the head for stdout
/// (a reply past the limit is an error), the tail for stderr.
async fn read_capped(
    mut stream: impl AsyncRead + Unpin,
    limit: usize,
    keep_tail: bool,
) -> Result<Vec<u8>> {
    let mut data = Vec::new();
    // On the heap: a stack array would sit inside every future that awaits
    // this, and debug builds copy those futures around on the stack.
    let mut block = vec![0u8; 16 * 1024];
    let mut over = false;
    loop {
        let n = stream.read(&mut block).await?;
        if n == 0 {
            break;
        }
        if keep_tail {
            data.extend_from_slice(&block[..n]);
            let excess = data.len().saturating_sub(limit);
            if excess > 0 {
                data.drain(..excess);
            }
        } else if data.len() + n > limit {
            over = true; // Keep draining so the remote side is not blocked.
        } else {
            data.extend_from_slice(&block[..n]);
        }
    }
    if over {
        bail!("The server sent more output than expected");
    }
    Ok(data)
}
