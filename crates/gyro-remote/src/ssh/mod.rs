//! Native OpenSSH transport. Keys and SSH configuration remain owned by OpenSSH.
mod config;
pub mod exec;
mod server;
pub mod stream;
use anyhow::{bail, Context, Result};
pub use config::config_hosts;
use serde::{Deserialize, Serialize};
pub use server::Server;
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, BufReader},
    process::{Child, Command},
};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub host: String,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub identity_file: Option<String>,
    /// Optional location for a host using a non-default Gyro data directory.
    #[serde(default)]
    pub socket_path: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedHost {
    pub id: String,
    pub name: String,
    pub options: Options,
}
impl Options {
    pub fn validate(&self) -> Result<()> {
        if self.host.is_empty()
            || self.host.len() > 255
            || self.host.starts_with('-')
            || !self
                .host
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "._-:[]%".contains(c))
        {
            bail!("Enter a hostname, IP address, or SSH config alias (without user@ or a port)");
        }
        if let Some(user) = &self.user {
            if user.is_empty()
                || user.len() > 128
                || user.starts_with('-')
                || !user
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
            {
                bail!("Enter a valid SSH username");
            }
        }
        if self.port == Some(0) {
            bail!("SSH port must be between 1 and 65535");
        }
        for path in [&self.identity_file, &self.socket_path]
            .into_iter()
            .flatten()
        {
            if path.is_empty() || path.len() > 2048 || path.chars().any(|c| c.is_control()) {
                bail!("Invalid SSH file path");
            }
        }
        if self
            .socket_path
            .as_ref()
            .is_some_and(|p| !p.starts_with('/'))
        {
            bail!("The remote socket path must be absolute");
        }
        Ok(())
    }
    /// The hardened option list shared by every SSH use: the Gyro socket, the
    /// runner exec channel, git transport and the sign-in terminal. It ends
    /// with user, port and identity, and never contains the destination.
    pub(crate) fn base_arguments(&self, tty: bool) -> Result<Vec<String>> {
        self.validate()?;
        // Explicit options take precedence over user config. Never spawn a shell
        // locally or interpolate destinations into the remote command.
        let mut args = Vec::new();
        for option in [
            "BatchMode=yes",
            "StrictHostKeyChecking=yes",
            "ConnectTimeout=12",
            "ConnectionAttempts=1",
            "ServerAliveInterval=15",
            "ServerAliveCountMax=3",
            "ForwardAgent=no",
            "ForwardX11=no",
            "PermitLocalCommand=no",
            "ClearAllForwardings=yes",
            "ControlMaster=no",
            "ControlPath=none",
            "RemoteCommand=none",
            if tty {
                "RequestTTY=yes"
            } else {
                "RequestTTY=no"
            },
            "ForkAfterAuthentication=no",
            "SessionType=default",
        ] {
            args.extend(["-o".into(), option.into()]);
        }
        if let Some(user) = &self.user {
            args.extend(["-l".into(), user.clone()]);
        }
        if let Some(port) = self.port {
            args.extend(["-p".into(), port.to_string()]);
        }
        if let Some(path) = &self.identity_file {
            args.extend([
                "-i".into(),
                path.clone(),
                "-o".into(),
                "IdentitiesOnly=yes".into(),
            ]);
        }
        Ok(args)
    }
    pub fn arguments(&self) -> Result<Vec<String>> {
        let mut args = vec!["-T".into()];
        args.extend(self.base_arguments(false)?);
        args.push(self.host.clone());
        let target = match &self.socket_path {
            Some(path) => shell_quote(path),
            None => "\"$HOME/Library/Application Support/Gyro/remote-access/ssh.sock\"".into(),
        };
        args.push(format!("p={target}; if [ ! -S \"$p\" ]; then printf '%s\\n' 'Gyro SSH service is unavailable. Open an updated Gyro app and turn on Remote access on the host Mac.' >&2; exit 69; fi; exec /usr/bin/nc -U \"$p\""));
        Ok(args)
    }
    /// Runs one fixed remote command with no terminal. Callers build `command`
    /// only from constants and validated identifiers; data goes over stdin.
    pub fn exec_arguments(&self, command: &str) -> Result<Vec<String>> {
        let mut args = vec!["-T".into()];
        args.extend(self.base_arguments(false)?);
        args.extend(["--".into(), self.host.clone(), command.into()]);
        Ok(args)
    }
    /// Runs a remote command in a real terminal, for a CLI's own sign-in flow.
    /// The user types into it; Gyro never reads the CLI's credential files.
    pub fn terminal_arguments(&self, command: &str) -> Result<Vec<String>> {
        let mut args = vec!["-t".into()];
        args.extend(self.base_arguments(true)?);
        args.extend(["--".into(), self.host.clone(), command.into()]);
        Ok(args)
    }
}
/// Plain-language reasons for an OpenSSH failure, from its stderr. Shared by
/// the Gyro socket and the server runner.
pub(crate) fn ssh_failure(captured: &str) -> Option<&'static str> {
    ssh_trust_failure(captured).or_else(|| {
        if captured.contains("Could not resolve hostname") {
            Some("SSH hostname could not be resolved. Check the address or SSH config alias.")
        } else if captured.contains("Connection refused") {
            Some("SSH connection refused. Enable Remote Login on the host and check the port.")
        } else {
            None
        }
    })
}
fn ssh_trust_failure(captured: &str) -> Option<&'static str> {
    if captured.contains("Host key verification failed")
        || captured.contains("REMOTE HOST IDENTIFICATION HAS CHANGED")
    {
        Some("SSH host key is not trusted or has changed. Verify this host with ssh in Terminal, then connect again.")
    } else if captured.contains("Permission denied") || captured.contains("sign_and_send_pubkey") {
        Some("SSH authentication failed. Load your key into ssh-agent, or choose an identity file. Password-only authentication is not supported.")
    } else {
        None
    }
}
pub(crate) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub struct Connection {
    pub client: Arc<stream::Client>,
    child: Mutex<Option<Child>>,
    stderr: Arc<Mutex<Vec<u8>>>,
}
impl Connection {
    pub async fn connect(options: &Options, client_id: Uuid) -> Result<Arc<Self>> {
        Self::launch(Path::new("/usr/bin/ssh"), options.arguments()?, client_id).await
    }
    pub(crate) async fn launch(
        program: &Path,
        arguments: Vec<String>,
        client_id: Uuid,
    ) -> Result<Arc<Self>> {
        let mut child = Command::new(program)
            .args(arguments)
            .env("SSH_ASKPASS_REQUIRE", "never")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .context("Could not start OpenSSH")?;
        let input = child.stdin.take().context("SSH input unavailable")?;
        let output = child.stdout.take().context("SSH output unavailable")?;
        let stderr = Arc::new(Mutex::new(Vec::new()));
        let captured = stderr.clone();
        let errors = child
            .stderr
            .take()
            .context("SSH error stream unavailable")?;
        tokio::spawn(async move {
            let mut reader = BufReader::new(errors);
            let mut block = [0u8; 1024];
            while let Ok(n) = reader.read(&mut block).await {
                if n == 0 {
                    break;
                }
                if let Ok(mut text) = captured.lock() {
                    text.extend_from_slice(&block[..n]);
                    let excess = text.len().saturating_sub(4096);
                    if excess > 0 {
                        text.drain(..excess);
                    }
                }
            }
        });
        let client = stream::Client::open(output, input, client_id).await?;
        let connection = Arc::new(Self {
            client: client.clone(),
            child: Mutex::new(Some(child)),
            stderr,
        });
        // A failed stream can remain listed as a saved connection. Retire its
        // SSH child immediately instead of waiting for manual reconnection.
        let closed = Arc::downgrade(&connection);
        tokio::spawn(async move {
            client.closed().await;
            if let Some(connection) = closed.upgrade() {
                connection.close();
            }
        });
        Ok(connection)
    }
    pub async fn hello(&self) -> Result<serde_json::Value> {
        let result = tokio::time::timeout(
            Duration::from_secs(25),
            self.client.request(crate::Request {
                id: Uuid::new_v4(),
                lease: None,
                operation: crate::Operation::Hello,
            }),
        )
        .await;
        match result {
            Ok(Ok(response)) => response.into_result().map_err(anyhow::Error::msg),
            _ => {
                // Give the stderr drain one scheduling turn after process EOF.
                tokio::task::yield_now().await;
                let captured = self
                    .stderr
                    .lock()
                    .map(|e| String::from_utf8_lossy(&e).to_string())
                    .unwrap_or_default();
                let message = if captured.contains("Gyro SSH service is unavailable")
                    || captured.contains("connect failed")
                    || captured.contains("No such file or directory")
                {
                    ssh_trust_failure(&captured).unwrap_or(
                        "Gyro SSH service is unavailable. Open an updated Gyro app and turn on Remote access on the host Mac.",
                    )
                } else {
                    ssh_failure(&captured).unwrap_or(
                        "Could not connect over SSH. Check reachability, Remote Login, host trust, and your SSH key.",
                    )
                };
                self.close();
                bail!("{message}")
            }
        }
    }
    pub fn close(&self) {
        self.client.close();
        if let Ok(mut slot) = self.child.lock() {
            if let Some(mut child) = slot.take() {
                let _ = child.start_kill();
            }
        }
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests;
