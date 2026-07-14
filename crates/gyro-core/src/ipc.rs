use crate::paths::GyroPaths;
use crate::sessions::SessionWorkspaceMode;
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, BufReader, Write};
use std::path::PathBuf;
use std::time::Duration;

pub const APP_IPC_SCHEMA_V1: &str = "gyro.app-ipc.v1";
pub const DESKTOP_PROVIDER_APPROVAL_IPC_SCHEMA_V1: &str = "gyro.desktop-provider-approval-ipc.v1";

const APP_NOTIFICATION_MAX_FRAME_BYTES: usize = 64 * 1024;
const DESKTOP_PROVIDER_APPROVAL_MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
const APP_NOTIFICATION_IO_TIMEOUT: Duration = Duration::from_millis(750);
const DESKTOP_PROVIDER_APPROVAL_WRITE_TIMEOUT: Duration = Duration::from_secs(2);
const DESKTOP_PROVIDER_APPROVAL_READ_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AppNotificationKind {
    OpenSession,
    AttachSession,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppNotification {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender_version: Option<String>,
    pub kind: AppNotificationKind,
    pub session_id: String,
    pub workspace_path: PathBuf,
    pub workspace_mode: Option<SessionWorkspaceMode>,
    pub branch: Option<String>,
    pub worktree_name: Option<String>,
}

impl AppNotification {
    pub fn new(
        kind: AppNotificationKind,
        session_id: impl Into<String>,
        workspace_path: PathBuf,
    ) -> Self {
        Self {
            schema: Some(APP_IPC_SCHEMA_V1.into()),
            sender_version: Some(env!("CARGO_PKG_VERSION").into()),
            kind,
            session_id: session_id.into(),
            workspace_path,
            workspace_mode: None,
            branch: None,
            worktree_name: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppAcknowledgement {
    pub schema: String,
    pub status: String,
    pub app_version: String,
    pub compatible: bool,
    pub message: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppNotificationResult {
    pub running: bool,
    pub acknowledged: bool,
    pub compatible: bool,
    pub app_version: Option<String>,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopProviderApprovalRequest {
    pub schema: String,
    pub sender_version: String,
    pub session_id: String,
    pub turn_id: Option<String>,
    pub run_nonce: String,
    pub provider_id: String,
    pub provider_label: Option<String>,
    pub tool_name: String,
    pub input: serde_json::Value,
    #[serde(default)]
    pub permission_suggestions: serde_json::Value,
    pub require_command_approval: bool,
    pub require_file_edit_approval: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DesktopProviderApprovalBehavior {
    Allow,
    Deny,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopProviderApprovalResponse {
    pub schema: String,
    pub app_version: String,
    pub compatible: bool,
    pub behavior: DesktopProviderApprovalBehavior,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_input: Option<serde_json::Value>,
}

impl DesktopProviderApprovalResponse {
    pub fn allow(input: serde_json::Value, message: impl Into<String>) -> Self {
        Self {
            schema: DESKTOP_PROVIDER_APPROVAL_IPC_SCHEMA_V1.into(),
            app_version: env!("CARGO_PKG_VERSION").into(),
            compatible: true,
            behavior: DesktopProviderApprovalBehavior::Allow,
            message: message.into(),
            updated_input: Some(input),
        }
    }

    pub fn deny(message: impl Into<String>) -> Self {
        Self {
            schema: DESKTOP_PROVIDER_APPROVAL_IPC_SCHEMA_V1.into(),
            app_version: env!("CARGO_PKG_VERSION").into(),
            compatible: true,
            behavior: DesktopProviderApprovalBehavior::Deny,
            message: message.into(),
            updated_input: None,
        }
    }
}

impl AppNotificationResult {
    fn not_running() -> Self {
        Self {
            running: false,
            acknowledged: false,
            compatible: true,
            app_version: None,
            message: None,
        }
    }
}

pub fn acknowledgement_for(
    notification: &AppNotification,
    app_version: &str,
) -> AppAcknowledgement {
    let schema_compatible = notification
        .schema
        .as_deref()
        .map_or(true, |schema| schema == APP_IPC_SCHEMA_V1);
    let version_compatible = notification
        .sender_version
        .as_deref()
        .map_or(true, |version| versions_compatible(version, app_version));
    let compatible = schema_compatible && version_compatible;
    let message = if compatible {
        "Gyro.app accepted the session handoff.".into()
    } else {
        format!(
            "Gyro CLI {} is not compatible with Gyro.app {app_version}; update both from the same release channel",
            notification.sender_version.as_deref().unwrap_or("unknown")
        )
    };
    AppAcknowledgement {
        schema: APP_IPC_SCHEMA_V1.into(),
        status: if compatible { "ok" } else { "incompatible" }.into(),
        app_version: app_version.into(),
        compatible,
        message,
    }
}

pub fn versions_compatible(left: &str, right: &str) -> bool {
    let Some((left_major, left_minor)) = compatibility_line(left) else {
        return left == right;
    };
    let Some((right_major, right_minor)) = compatibility_line(right) else {
        return left == right;
    };
    if left_major == 0 || right_major == 0 {
        left_major == right_major && left_minor == right_minor
    } else {
        left_major == right_major
    }
}

fn compatibility_line(version: &str) -> Option<(u64, u64)> {
    let mut parts = version.trim_start_matches('v').split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some((major, minor))
}

fn read_bounded_frame<R: BufRead>(reader: &mut R, max_bytes: usize) -> io::Result<Option<Vec<u8>>> {
    let mut frame = Vec::with_capacity(max_bytes.min(8 * 1024));
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "IPC peer closed an unterminated frame",
                ))
            };
        }

        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let chunk_len = newline.unwrap_or(buffer.len());
        if frame
            .len()
            .checked_add(chunk_len)
            .map_or(true, |length| length > max_bytes)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("IPC frame exceeded the {max_bytes}-byte limit"),
            ));
        }
        frame.extend_from_slice(&buffer[..chunk_len]);
        reader.consume(chunk_len + usize::from(newline.is_some()));
        if newline.is_some() {
            if frame.last() == Some(&b'\r') {
                frame.pop();
            }
            return Ok(Some(frame));
        }
    }
}

fn write_json_frame<W: Write, T: Serialize>(
    writer: &mut W,
    value: &T,
    max_bytes: usize,
    description: &str,
) -> Result<()> {
    let payload = serde_json::to_vec(value)?;
    if payload.len() > max_bytes {
        return Err(anyhow!(
            "{description} exceeded the {max_bytes}-byte IPC frame limit"
        ));
    }
    writer.write_all(&payload)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

pub fn notify_running_app(paths: &GyroPaths, notification: &AppNotification) -> Result<bool> {
    let result = notify_running_app_with_status(paths, notification)?;
    Ok(result.running && result.acknowledged && result.compatible)
}

pub fn app_ipc_listener_ready(paths: &GyroPaths) -> Result<bool> {
    #[cfg(unix)]
    {
        Ok(connect_running_app(paths)?.is_some())
    }

    #[cfg(not(unix))]
    {
        let _ = paths;
        Ok(false)
    }
}

pub fn notify_running_app_with_status(
    paths: &GyroPaths,
    notification: &AppNotification,
) -> Result<AppNotificationResult> {
    #[cfg(unix)]
    {
        let Some(mut stream) = connect_running_app(paths)? else {
            return Ok(AppNotificationResult::not_running());
        };
        stream.set_read_timeout(Some(APP_NOTIFICATION_IO_TIMEOUT))?;
        stream.set_write_timeout(Some(APP_NOTIFICATION_IO_TIMEOUT))?;
        write_json_frame(
            &mut stream,
            notification,
            APP_NOTIFICATION_MAX_FRAME_BYTES,
            "app notification",
        )
        .with_context(|| format!("notify app at {}", paths.socket_path.display()))?;
        let acknowledgement = match read_bounded_frame(
            &mut BufReader::new(stream),
            APP_NOTIFICATION_MAX_FRAME_BYTES,
        ) {
            Ok(Some(frame)) => frame,
            Ok(None) => Vec::new(),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                ) =>
            {
                Vec::new()
            }
            Err(error) => return Err(error).context("read Gyro.app acknowledgement"),
        };
        let acknowledgement = std::str::from_utf8(&acknowledgement)
            .context("decode Gyro.app acknowledgement as UTF-8")?
            .trim();
        if acknowledgement.is_empty() {
            return Ok(AppNotificationResult {
                running: true,
                acknowledged: false,
                compatible: true,
                app_version: None,
                message: None,
            });
        }
        if acknowledgement == "ok" {
            return Ok(AppNotificationResult {
                running: true,
                acknowledged: true,
                compatible: true,
                app_version: None,
                message: Some("Legacy Gyro.app acknowledgement received.".into()),
            });
        }
        let acknowledgement = serde_json::from_str::<AppAcknowledgement>(acknowledgement)
            .context("decode Gyro.app acknowledgement")?;
        Ok(AppNotificationResult {
            running: true,
            acknowledged: acknowledgement.status == "ok" || !acknowledgement.compatible,
            compatible: acknowledgement.compatible,
            app_version: Some(acknowledgement.app_version),
            message: Some(acknowledgement.message),
        })
    }

    #[cfg(not(unix))]
    {
        let _ = paths;
        let _ = notification;
        Ok(AppNotificationResult::not_running())
    }
}

pub fn request_desktop_provider_approval(
    paths: &GyroPaths,
    request: &DesktopProviderApprovalRequest,
) -> Result<DesktopProviderApprovalResponse> {
    #[cfg(unix)]
    {
        let Some(mut stream) = connect_running_app(paths)? else {
            return Err(anyhow!(
                "Gyro.app is not running; provider approval was denied"
            ));
        };
        stream.set_write_timeout(Some(DESKTOP_PROVIDER_APPROVAL_WRITE_TIMEOUT))?;
        stream.set_read_timeout(Some(DESKTOP_PROVIDER_APPROVAL_READ_TIMEOUT))?;
        write_json_frame(
            &mut stream,
            request,
            DESKTOP_PROVIDER_APPROVAL_MAX_FRAME_BYTES,
            "desktop provider approval request",
        )
        .with_context(|| {
            format!(
                "request provider approval from {}",
                paths.socket_path.display()
            )
        })?;
        let response = read_bounded_frame(
            &mut BufReader::new(stream),
            DESKTOP_PROVIDER_APPROVAL_MAX_FRAME_BYTES,
        )
        .context("read provider approval response from Gyro.app")?
        .ok_or_else(|| anyhow!("Gyro.app closed the provider approval request"))?;
        if response.iter().all(u8::is_ascii_whitespace) {
            return Err(anyhow!("Gyro.app closed the provider approval request"));
        }
        let response: DesktopProviderApprovalResponse = serde_json::from_slice(&response)
            .context("decode provider approval response from Gyro.app")?;
        if response.schema != DESKTOP_PROVIDER_APPROVAL_IPC_SCHEMA_V1 {
            return Err(anyhow!("Gyro.app returned an incompatible approval schema"));
        }
        Ok(response)
    }

    #[cfg(not(unix))]
    {
        let _ = paths;
        let _ = request;
        Err(anyhow!(
            "desktop provider approval IPC is not supported on this platform"
        ))
    }
}

#[cfg(unix)]
fn connect_running_app(paths: &GyroPaths) -> Result<Option<std::os::unix::net::UnixStream>> {
    use std::io::ErrorKind;
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    use std::os::unix::net::UnixStream;

    let metadata = match std::fs::symlink_metadata(&paths.socket_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("inspect app socket {}", paths.socket_path.display()))
        }
    };
    if !metadata.file_type().is_socket() {
        return Err(anyhow!(
            "app IPC path {} is not a Unix socket; remove it before retrying",
            paths.socket_path.display()
        ));
    }

    match UnixStream::connect(&paths.socket_path) {
        Ok(stream) => Ok(Some(stream)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) if error.kind() == ErrorKind::ConnectionRefused => {
            remove_stale_app_socket(&paths.socket_path, metadata.dev(), metadata.ino())?;
            Ok(None)
        }
        Err(error) => Err(error)
            .with_context(|| format!("connect to Gyro.app at {}", paths.socket_path.display())),
    }
}

#[cfg(unix)]
fn remove_stale_app_socket(
    path: &std::path::Path,
    expected_device: u64,
    expected_inode: u64,
) -> Result<()> {
    use std::io::ErrorKind;
    use std::os::unix::fs::{FileTypeExt, MetadataExt};

    let current = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("inspect stale app socket {}", path.display()))
        }
    };
    if current.file_type().is_socket()
        && current.dev() == expected_device
        && current.ino() == expected_inode
    {
        std::fs::remove_file(path)
            .with_context(|| format!("remove stale app socket {}", path.display()))?;
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Cursor, Write};
    use std::os::unix::net::UnixListener;

    fn notification() -> AppNotification {
        AppNotification {
            schema: Some(APP_IPC_SCHEMA_V1.into()),
            sender_version: Some(env!("CARGO_PKG_VERSION").into()),
            kind: AppNotificationKind::OpenSession,
            session_id: "session-1".into(),
            workspace_path: PathBuf::from("/tmp/workspace"),
            workspace_mode: Some(SessionWorkspaceMode::Local),
            branch: Some("main".into()),
            worktree_name: None,
        }
    }

    fn provider_approval_request() -> DesktopProviderApprovalRequest {
        DesktopProviderApprovalRequest {
            schema: DESKTOP_PROVIDER_APPROVAL_IPC_SCHEMA_V1.into(),
            sender_version: env!("CARGO_PKG_VERSION").into(),
            session_id: "session-1".into(),
            turn_id: Some("turn-1".into()),
            run_nonce: "run-nonce-1".into(),
            provider_id: "anthropic".into(),
            provider_label: Some("Anthropic".into()),
            tool_name: "Write".into(),
            input: serde_json::json!({ "file_path": "test.txt", "content": "hello\n" }),
            permission_suggestions: serde_json::json!([]),
            require_command_approval: true,
            require_file_edit_approval: true,
        }
    }

    #[test]
    fn bounded_frame_reads_incrementally_and_strips_crlf() {
        let input = Cursor::new(b"{\"status\":\"ok\"}\r\ntrailing".to_vec());
        let mut reader = BufReader::with_capacity(3, input);

        let frame = read_bounded_frame(&mut reader, 32).unwrap().unwrap();

        assert_eq!(frame, br#"{"status":"ok"}"#);
    }

    #[test]
    fn bounded_frame_rejects_oversized_unterminated_input() {
        let input = Cursor::new(vec![b'x'; 129]);
        let mut reader = BufReader::with_capacity(7, input);

        let error = read_bounded_frame(&mut reader, 128).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("128-byte limit"));
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

    #[test]
    fn rejects_oversized_unterminated_app_acknowledgement() {
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
            let mut stream = stream;
            stream
                .write_all(&vec![b'x'; APP_NOTIFICATION_MAX_FRAME_BYTES + 1])
                .unwrap();
            stream.flush().unwrap();
        });

        let error = notify_running_app_with_status(&paths, &notification()).unwrap_err();

        assert!(format!("{error:#}").contains("IPC frame exceeded"));
        server.join().unwrap();
    }

    #[test]
    fn stale_socket_is_removed_before_reporting_the_app_stopped() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        std::fs::create_dir_all(paths.socket_path.parent().unwrap()).unwrap();
        let listener = UnixListener::bind(&paths.socket_path).unwrap();
        drop(listener);
        assert!(paths.socket_path.exists());

        let ready = app_ipc_listener_ready(&paths).unwrap();

        assert!(!ready);
        assert!(!paths.socket_path.exists());
    }

    #[test]
    fn non_socket_ipc_path_is_preserved_and_reported() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        std::fs::create_dir_all(paths.socket_path.parent().unwrap()).unwrap();
        std::fs::write(&paths.socket_path, "do not remove\n").unwrap();

        let error = app_ipc_listener_ready(&paths).unwrap_err();

        assert!(error.to_string().contains("is not a Unix socket"));
        assert_eq!(
            std::fs::read_to_string(&paths.socket_path).unwrap(),
            "do not remove\n"
        );
    }

    #[test]
    fn compatibility_uses_semver_major_or_pre_one_minor_lines() {
        assert!(versions_compatible("0.1.0-alpha.1", "0.1.9"));
        assert!(!versions_compatible("0.1.0", "0.2.0"));
        assert!(versions_compatible("1.4.0", "1.9.0"));
        assert!(!versions_compatible("1.4.0", "2.0.0"));
        assert!(versions_compatible("custom", "custom"));
        assert!(!versions_compatible("custom", "other"));
    }

    #[test]
    fn acknowledgement_reports_both_versions_when_incompatible() {
        let mut notification = notification();
        notification.sender_version = Some("0.2.0".into());
        let acknowledgement = acknowledgement_for(&notification, "0.1.0-alpha.20");

        assert!(!acknowledgement.compatible);
        assert_eq!(acknowledgement.status, "incompatible");
        assert!(acknowledgement.message.contains("0.2.0"));
        assert!(acknowledgement.message.contains("0.1.0-alpha.20"));
    }

    #[test]
    fn detailed_notification_reads_versioned_acknowledgement() {
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
            let notification = serde_json::from_str::<AppNotification>(&request).unwrap();
            let acknowledgement = acknowledgement_for(&notification, env!("CARGO_PKG_VERSION"));
            let mut stream = stream;
            serde_json::to_writer(&mut stream, &acknowledgement).unwrap();
            stream.write_all(b"\n").unwrap();
            stream.flush().unwrap();
        });

        let result = notify_running_app_with_status(&paths, &notification()).unwrap();
        assert!(result.running);
        assert!(result.acknowledged);
        assert!(result.compatible);
        assert_eq!(
            result.app_version.as_deref(),
            Some(env!("CARGO_PKG_VERSION"))
        );
        server.join().unwrap();
    }

    #[test]
    fn desktop_provider_approval_round_trips_over_the_app_socket() {
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
            let request = serde_json::from_str::<DesktopProviderApprovalRequest>(&request).unwrap();
            assert_eq!(request.tool_name, "Write");
            let response = DesktopProviderApprovalResponse::deny("Not this time");
            let mut stream = stream;
            serde_json::to_writer(&mut stream, &response).unwrap();
            stream.write_all(b"\n").unwrap();
            stream.flush().unwrap();
        });

        let response =
            request_desktop_provider_approval(&paths, &provider_approval_request()).unwrap();

        assert_eq!(response.behavior, DesktopProviderApprovalBehavior::Deny);
        assert_eq!(response.message, "Not this time");
        server.join().unwrap();
    }

    #[test]
    fn desktop_provider_approval_protocol_uses_camel_case_fields() {
        let value = serde_json::to_value(provider_approval_request()).unwrap();
        assert_eq!(value["schema"], DESKTOP_PROVIDER_APPROVAL_IPC_SCHEMA_V1);
        assert_eq!(value["toolName"], "Write");
        assert_eq!(value["requireFileEditApproval"], true);
        assert!(value.get("tool_name").is_none());
    }
}
