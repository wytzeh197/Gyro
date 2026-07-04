use crate::paths::GyroPaths;
use crate::sessions::SessionWorkspaceMode;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AppNotificationKind {
    OpenSession,
    AttachSession,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppNotification {
    pub kind: AppNotificationKind,
    pub session_id: String,
    pub workspace_path: PathBuf,
    pub workspace_mode: Option<SessionWorkspaceMode>,
    pub branch: Option<String>,
    pub worktree_name: Option<String>,
}

pub fn notify_running_app(paths: &GyroPaths, notification: &AppNotification) -> Result<bool> {
    #[cfg(unix)]
    {
        use std::os::unix::net::UnixStream;

        if !paths.socket_path.exists() {
            return Ok(false);
        }

        let mut stream = match UnixStream::connect(&paths.socket_path) {
            Ok(stream) => stream,
            Err(_) => return Ok(false),
        };
        let payload = serde_json::to_vec(notification)?;
        stream
            .write_all(&payload)
            .with_context(|| format!("notify app at {}", paths.socket_path.display()))?;
        stream.write_all(b"\n")?;
        Ok(true)
    }

    #[cfg(not(unix))]
    {
        let _ = paths;
        let _ = notification;
        Ok(false)
    }
}
