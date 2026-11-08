use crate::{
    app::limits::MAX_DESKTOP_IPC_MESSAGE_BYTES,
    automation::{
        commands::{
            cancel_scheduled_automation, emit_automation_update, run_automation_blocking,
            set_automation_status_blocking,
        },
        runtime::AutomationSchedulerControl,
    },
    stores::{open_automation_store, to_string},
};
#[cfg(unix)]
use crate::{
    app::limits::{DESKTOP_IPC_IO_TIMEOUT, DESKTOP_IPC_QUEUE_CAPACITY, DESKTOP_IPC_WORKER_COUNT},
    providers::{
        approvals::handle_desktop_provider_approval_request,
        codex_app_server::read_bounded_protocol_line,
    },
    state::managers::ProviderCapabilityBroker,
};
use anyhow::Context;
#[cfg(unix)]
use gyro_core::{
    ipc::{
        acknowledgement_for, AppNotification, DesktopProviderApprovalRequest,
        DesktopProviderApprovalResponse, DESKTOP_PROVIDER_APPROVAL_IPC_SCHEMA_V1,
    },
    AppNotificationKind, CapabilityRequest, CapabilityResponse, PROVIDER_CAPABILITY_IPC_SCHEMA_V1,
};
use gyro_core::{
    ipc::{
        versions_compatible, AutomateAction, AutomateRequest, AutomateResponse, AutomateSummary,
        AUTOMATE_IPC_SCHEMA_V1,
    },
    Automation, AutomationStatus, GyroPaths,
};
use serde::Serialize;
use std::io::Write;
#[cfg(unix)]
use std::{
    fs,
    io::BufReader,
    sync::{mpsc, Arc, Mutex},
};
#[cfg(unix)]
use tauri::Emitter;
use tauri::Manager;
#[cfg(unix)]
use uuid::Uuid;
pub(crate) fn provider_host_ipc_paths(
    mut paths: GyroPaths,
    host_pid: u32,
) -> anyhow::Result<GyroPaths> {
    anyhow::ensure!(host_pid != 0, "invalid Gyro provider host process");
    paths.socket_path = paths.base_dir.join(format!("gyro-{host_pid}.sock"));
    Ok(paths)
}

pub(crate) fn desktop_provider_ipc_paths() -> anyhow::Result<GyroPaths> {
    let paths = GyroPaths::for_current_user()?;
    match std::env::var("GYRO_PROVIDER_HOST_PID") {
        Ok(host_pid) => provider_host_ipc_paths(
            paths,
            host_pid
                .parse()
                .context("invalid Gyro provider host process")?,
        ),
        // Older installed apps still use the public endpoint. An explicit
        // host must never fall back to a different running desktop instance.
        Err(std::env::VarError::NotPresent) => Ok(paths),
        Err(error) => Err(error).context("invalid Gyro provider host process"),
    }
}

pub(crate) fn start_cli_ipc_listener(app: tauri::AppHandle) {
    let paths = match GyroPaths::for_current_user() {
        Ok(paths) => paths,
        Err(error) => {
            eprintln!("could not start Gyro IPC listener: {error}");
            return;
        }
    };

    // The public CLI socket can belong to another desktop instance. Provider
    // helpers must reach the instance that owns their chat and active run.
    let provider_paths = provider_host_ipc_paths(paths.clone(), std::process::id())
        .expect("the current process has a nonzero id");
    start_ipc_listener_at(app.clone(), provider_paths);
    start_ipc_listener_at(app, paths);
}

pub(crate) fn start_ipc_listener_at(app: tauri::AppHandle, paths: GyroPaths) {
    std::thread::spawn(move || {
        #[cfg(unix)]
        {
            if let Err(error) = paths.ensure() {
                eprintln!("could not create Gyro IPC directory: {error}");
                return;
            }
            let listener = match bind_cli_ipc_listener(&paths) {
                Ok(Some(listener)) => listener,
                Ok(None) => {
                    eprintln!("Gyro IPC listener is already active");
                    return;
                }
                Err(error) => {
                    eprintln!("could not bind Gyro IPC socket: {error}");
                    return;
                }
            };

            let (sender, receiver) = mpsc::sync_channel(DESKTOP_IPC_QUEUE_CAPACITY);
            let receiver = Arc::new(Mutex::new(receiver));
            for _ in 0..DESKTOP_IPC_WORKER_COUNT {
                let app = app.clone();
                let receiver = Arc::clone(&receiver);
                std::thread::spawn(move || loop {
                    let stream = match receiver.lock() {
                        Ok(receiver) => receiver.recv(),
                        Err(_) => return,
                    };
                    match stream {
                        Ok(stream) => handle_cli_ipc_connection(&app, stream),
                        Err(_) => return,
                    }
                });
            }

            for stream in listener.incoming() {
                let Ok(stream) = stream else {
                    continue;
                };
                if sender.try_send(stream).is_err() {
                    eprintln!("Gyro IPC queue is full; rejecting a connection");
                }
            }
        }
    });
}

#[cfg(unix)]
pub(crate) fn bind_cli_ipc_listener(
    paths: &GyroPaths,
) -> anyhow::Result<Option<std::os::unix::net::UnixListener>> {
    use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
    use std::os::unix::net::{UnixListener, UnixStream};

    // Only retry endpoint races a bounded number of times. A failed request
    // is never replayed here; these probes happen before a listener is bound.
    for _ in 0..3 {
        let listener = match UnixListener::bind(&paths.socket_path) {
            Ok(listener) => listener,
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
                let before = match fs::symlink_metadata(&paths.socket_path) {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error).context("inspect existing Gyro IPC socket"),
                };
                if before.file_type().is_symlink() || !before.file_type().is_socket() {
                    anyhow::bail!(
                        "Gyro IPC path is not a safe Unix socket: {}",
                        paths.socket_path.display()
                    );
                }
                match UnixStream::connect(&paths.socket_path) {
                    Ok(_) => return Ok(None),
                    Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => {
                        // Permission failures and transient resource exhaustion do
                        // not prove the owner exited. Never unlink a live bridge.
                        return Err(error).with_context(|| {
                            format!(
                                "probe existing Gyro IPC socket {}",
                                paths.socket_path.display()
                            )
                        });
                    }
                }
                let after = match fs::symlink_metadata(&paths.socket_path) {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error).context("reinspect existing Gyro IPC socket"),
                };
                if before.dev() != after.dev()
                    || before.ino() != after.ino()
                    || after.file_type().is_symlink()
                    || !after.file_type().is_socket()
                {
                    anyhow::bail!("Gyro IPC socket changed while checking whether it was stale");
                }
                match fs::remove_file(&paths.socket_path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error).context("remove stale Gyro IPC socket"),
                }
                continue;
            }
            Err(error) => {
                return Err(error).with_context(|| format!("bind {}", paths.socket_path.display()))
            }
        };
        fs::set_permissions(&paths.socket_path, fs::Permissions::from_mode(0o600))?;
        return Ok(Some(listener));
    }
    anyhow::bail!(
        "Gyro IPC socket kept changing while binding {}",
        paths.socket_path.display()
    )
}

pub(crate) fn automate_enum_label(value: &impl serde::Serialize) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".into())
}

pub(crate) fn automate_summary(automation: &Automation) -> AutomateSummary {
    AutomateSummary {
        id: automation.id.to_string(),
        title: automation.title.clone(),
        schedule: automate_enum_label(&automation.schedule),
        status: automate_enum_label(&automation.status),
        last_run_at: automation.last_run_at.map(|time| time.to_rfc3339()),
    }
}

/// Resume only continues a paused automation. A completed or current run stays
/// as it is, so resume cannot flip a finished automation back to Current.
pub(crate) fn refuse_unpaused_automation_resume(status: AutomationStatus) -> Result<(), String> {
    if status == AutomationStatus::Paused {
        return Ok(());
    }
    Err(format!(
        "Only a paused automation can be resumed. This one is {}.",
        automate_enum_label(&status)
    ))
}

#[cfg(test)]
mod automate_resume_guard_tests {
    use super::refuse_unpaused_automation_resume;
    use gyro_core::AutomationStatus;

    #[test]
    fn resume_refuses_completed_and_current_automations() {
        assert!(refuse_unpaused_automation_resume(AutomationStatus::Paused).is_ok());
        let completed = refuse_unpaused_automation_resume(AutomationStatus::Completed).unwrap_err();
        assert!(
            completed.contains("Only a paused automation can be resumed"),
            "{completed}"
        );
        assert!(completed.contains("completed"), "{completed}");
        let current = refuse_unpaused_automation_resume(AutomationStatus::Current).unwrap_err();
        assert!(current.contains("current"), "{current}");
    }
}

/// Queue or pause in the running app. This does not start a provider turn;
/// the desktop scheduler still owns execution and the existing approval policy.
pub(crate) fn handle_automate_ipc(
    app: &tauri::AppHandle,
    request: AutomateRequest,
) -> AutomateResponse {
    let app_version = env!("CARGO_PKG_VERSION");
    if request.schema != AUTOMATE_IPC_SCHEMA_V1
        || !versions_compatible(&request.sender_version, app_version)
    {
        return AutomateResponse {
            schema: AUTOMATE_IPC_SCHEMA_V1.into(),
            app_version: app_version.into(),
            compatible: false,
            status: "incompatible".into(),
            message: format!(
                "Gyro CLI {} is not compatible with Gyro.app {app_version}",
                request.sender_version
            ),
            automations: Vec::new(),
        };
    }
    let parsed_id = match (&request.action, request.automation_id.as_deref()) {
        (AutomateAction::List, _) => None,
        (_, Some(id)) => match uuid::Uuid::parse_str(id.trim()) {
            Ok(id) => Some(id),
            Err(_) => {
                return AutomateResponse::error(app_version, "automation id must be a UUID");
            }
        },
        (_, None) => {
            return AutomateResponse::error(app_version, "automation id is required");
        }
    };
    let outcome = (|| -> Result<(String, Vec<AutomateSummary>), String> {
        match request.action {
            AutomateAction::List => {
                let store = open_automation_store()?;
                let automations = store.list_automations().map_err(to_string)?;
                let shown = automations.iter().take(200).map(automate_summary).collect();
                Ok(("Listed automations.".into(), shown))
            }
            AutomateAction::Run => {
                let id = parsed_id.ok_or_else(|| "automation id is required".to_string())?;
                let automation = run_automation_blocking(id.to_string())?;
                emit_automation_update(app, &automation);
                app.state::<AutomationSchedulerControl>().wake();
                Ok((
                    format!("Queued {}.", automation.title),
                    vec![automate_summary(&automation)],
                ))
            }
            AutomateAction::Pause => {
                let id = parsed_id.ok_or_else(|| "automation id is required".to_string())?;
                let automation =
                    set_automation_status_blocking(id.to_string(), AutomationStatus::Paused)?;
                cancel_scheduled_automation(app, id);
                emit_automation_update(app, &automation);
                app.state::<AutomationSchedulerControl>().wake();
                Ok((
                    format!("Paused {}.", automation.title),
                    vec![automate_summary(&automation)],
                ))
            }
            AutomateAction::Resume => {
                let id = parsed_id.ok_or_else(|| "automation id is required".to_string())?;
                let current = open_automation_store()?
                    .get_automation(id)
                    .map_err(to_string)?
                    .ok_or_else(|| "automation not found".to_string())?;
                refuse_unpaused_automation_resume(current.status)?;
                let automation =
                    set_automation_status_blocking(id.to_string(), AutomationStatus::Current)?;
                emit_automation_update(app, &automation);
                app.state::<AutomationSchedulerControl>().wake();
                Ok((
                    format!("Resumed {}.", automation.title),
                    vec![automate_summary(&automation)],
                ))
            }
        }
    })();
    match outcome {
        Ok((message, automations)) => AutomateResponse {
            schema: AUTOMATE_IPC_SCHEMA_V1.into(),
            app_version: app_version.into(),
            compatible: true,
            status: "ok".into(),
            message,
            automations,
        },
        Err(error) => AutomateResponse::error(app_version, error),
    }
}

#[cfg(unix)]
pub(crate) fn handle_cli_ipc_connection(
    app: &tauri::AppHandle,
    stream: std::os::unix::net::UnixStream,
) {
    let _ = stream.set_read_timeout(Some(DESKTOP_IPC_IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(DESKTOP_IPC_IO_TIMEOUT));
    let mut reader = BufReader::new(stream);
    let Ok(Some(frame)) = read_bounded_protocol_line(&mut reader, MAX_DESKTOP_IPC_MESSAGE_BYTES)
    else {
        return;
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&frame) else {
        return;
    };
    if value.get("schema").and_then(serde_json::Value::as_str) == Some(AUTOMATE_IPC_SCHEMA_V1) {
        let response = match serde_json::from_value::<AutomateRequest>(value) {
            Ok(request) => handle_automate_ipc(app, request),
            Err(error) => AutomateResponse::error(
                env!("CARGO_PKG_VERSION"),
                format!("Gyro could not read that automate command: {error}"),
            ),
        };
        let _ = write_bounded_json_line(reader.get_mut(), &response, MAX_DESKTOP_IPC_MESSAGE_BYTES);
        return;
    }
    if value.get("schema").and_then(serde_json::Value::as_str)
        == Some(DESKTOP_PROVIDER_APPROVAL_IPC_SCHEMA_V1)
    {
        let response = match serde_json::from_value::<DesktopProviderApprovalRequest>(value) {
            Ok(request) => handle_desktop_provider_approval_request(app, request),
            Err(error) => DesktopProviderApprovalResponse::deny(format!(
                "Gyro could not decode the provider approval request: {}",
                gyro_core::sanitize_harness_text(&error.to_string())
            )),
        };
        let _ = write_bounded_json_line(reader.get_mut(), &response, MAX_DESKTOP_IPC_MESSAGE_BYTES);
        return;
    }
    if value.get("schema").and_then(serde_json::Value::as_str)
        == Some(PROVIDER_CAPABILITY_IPC_SCHEMA_V1)
    {
        let response = match serde_json::from_value::<CapabilityRequest>(value) {
            Ok(request) => app.state::<ProviderCapabilityBroker>().invoke(app, request),
            Err(error) => CapabilityResponse::failed(
                env!("CARGO_PKG_VERSION"),
                Uuid::nil(),
                "invalid-request",
                error.to_string(),
            ),
        };
        let _ = write_bounded_json_line(reader.get_mut(), &response, MAX_DESKTOP_IPC_MESSAGE_BYTES);
        return;
    }
    let Ok(notification) = serde_json::from_value::<AppNotification>(value) else {
        return;
    };
    let acknowledgement = acknowledgement_for(&notification, env!("CARGO_PKG_VERSION"));
    if matches!(
        &notification.kind,
        AppNotificationKind::OpenSession | AppNotificationKind::AttachSession
    ) && acknowledgement.compatible
    {
        let _ = app.emit("gyro://app-notification", notification);
    }
    let _ = write_bounded_json_line(
        reader.get_mut(),
        &acknowledgement,
        MAX_DESKTOP_IPC_MESSAGE_BYTES,
    );
}

pub(crate) fn write_bounded_json_line(
    writer: &mut impl Write,
    value: &impl Serialize,
    max_bytes: usize,
) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(to_string)?;
    if bytes.len() > max_bytes {
        return Err(format!(
            "IPC response exceeded the {max_bytes} byte size limit"
        ));
    }
    writer
        .write_all(&bytes)
        .and_then(|_| writer.write_all(b"\n"))
        .and_then(|_| writer.flush())
        .map_err(to_string)
}
