use crate::paths::GyroPaths;
use crate::sessions::SessionWorkspaceMode;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
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
        stream.set_read_timeout(Some(std::time::Duration::from_millis(750)))?;
        stream.set_write_timeout(Some(std::time::Duration::from_millis(750)))?;
        let payload = serde_json::to_vec(notification)?;
        stream
            .write_all(&payload)
            .with_context(|| format!("notify app at {}", paths.socket_path.display()))?;
        stream.write_all(b"\n")?;
        stream.flush()?;
        let mut acknowledgement = String::new();
        if BufReader::new(stream)
            .read_line(&mut acknowledgement)
            .is_err()
        {
            return Ok(false);
        }
        Ok(acknowledgement.trim() == "ok")
    }

    #[cfg(not(unix))]
    {
        let _ = paths;
        let _ = notification;
        Ok(false)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixListener;

    fn notification() -> AppNotification {
        AppNotification {
            kind: AppNotificationKind::OpenSession,
            session_id: "session-1".into(),
            workspace_path: PathBuf::from("/tmp/workspace"),
            workspace_mode: Some(SessionWorkspaceMode::Local),
            branch: Some("main".into()),
            worktree_name: None,
        }
    }

    #[test]
    fn requires_an_app_acknowledgement_before_reporting_handoff_success() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        std::fs::create_dir_all(paths.socket_path.parent().unwrap()).unwrap();
        let listener = UnixListener::bind(&paths.socket_path).unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut request = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut request)
                .unwrap();
            let decoded = serde_json::from_str::<AppNotification>(&request).unwrap();
            assert_eq!(decoded.session_id, "session-1");
            let mut stream = stream;
            stream.write_all(b"ok\n").unwrap();
            stream.flush().unwrap();
        });

        assert!(notify_running_app(&paths, &notification()).unwrap());
        server.join().unwrap();
    }

    #[test]
    fn reports_failed_handoff_when_listener_closes_without_acknowledging() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        std::fs::create_dir_all(paths.socket_path.parent().unwrap()).unwrap();
        let listener = UnixListener::bind(&paths.socket_path).unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut request = String::new();
            BufReader::new(stream).read_line(&mut request).unwrap();
        });

        assert!(!notify_running_app(&paths, &notification()).unwrap());
        server.join().unwrap();
    }
}
