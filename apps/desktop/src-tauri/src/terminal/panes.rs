//! Terminal pane commands and process management.

#[cfg(target_os = "macos")]
use crate::command_execution::run_bounded_command;
use crate::{
    command_execution::refresh_model_terminal_boundary,
    diagnostics::export::user_home_directory,
    project_import_continuation,
    state::managers::ProviderCapabilityResourceManager,
    stores::{parse_uuid, to_string},
    terminal::{
        governance::{release_pane_governance, resolve_pane_governance},
        types::{TerminalPaneRequest, TerminalPaneSnapshot, TerminalProcessManager},
    },
};
use gyro_core::CapabilityResourceRef;
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::{process::Command, time::Duration};
use tauri::Manager;

#[tauri::command]
pub(crate) async fn create_terminal_pane(
    app: tauri::AppHandle,
    manager: tauri::State<'_, TerminalProcessManager>,
    request: TerminalPaneRequest,
) -> Result<TerminalPaneSnapshot, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        create_terminal_pane_blocking(&app, &manager, request)
    })
    .await
    .map_err(|error| format!("terminal create worker failed: {error}"))?
}

pub(crate) fn create_terminal_pane_blocking(
    app: &tauri::AppHandle,
    manager: &TerminalProcessManager,
    mut request: TerminalPaneRequest,
) -> Result<TerminalPaneSnapshot, String> {
    // Governance is resolved here, never taken from the renderer, so the
    // session identity and approval environment an agent CLI inherits always
    // come from persisted backend state.
    request.governance = None;
    request.provider_data_home =
        project_import_continuation::resolve_login_data_home(&request).map_err(to_string)?;
    if request.governed {
        request.governance = Some(resolve_pane_governance(app, &request).map_err(to_string)?);
    }
    let governed_session = request
        .governance
        .as_ref()
        .map(|governance| governance.session_id.clone());
    // Relaunching into an occupied pane id replaces that process, so retire the
    // approval authority it held rather than leaving a dead pane able to
    // approve. `restart` deliberately does not come through here: it reuses the
    // same governance so a restarted pane keeps its session identity.
    let displaced = manager.governed_session(&request.pane_id);
    let result = manager.create(request).map_err(to_string);
    if result.is_ok() {
        if let Some(displaced) =
            displaced.filter(|session| Some(session) != governed_session.as_ref())
        {
            release_pane_governance(app, &displaced);
        }
    }
    if result.is_err() {
        // A pane that never started must not leave approval authority behind.
        if let Some(session_id) = governed_session {
            release_pane_governance(app, &session_id);
        }
    }
    result
}

#[tauri::command]
pub(crate) async fn write_terminal_input(
    manager: tauri::State<'_, TerminalProcessManager>,
    pane_id: String,
    input: String,
) -> Result<TerminalPaneSnapshot, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.write(&pane_id, &input).map_err(to_string))
        .await
        .map_err(|error| format!("terminal input worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn read_terminal_output(
    manager: tauri::State<'_, TerminalProcessManager>,
    pane_id: String,
    known_output_revision: Option<u64>,
) -> Result<TerminalPaneSnapshot, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager
            .read(&pane_id, known_output_revision)
            .map_err(to_string)
    })
    .await
    .map_err(|error| format!("terminal read worker failed: {error}"))?
}

// Query only when splitting; do not run process inspection on every output poll.
pub(crate) fn terminal_current_directory(
    pid: Option<u32>,
    fallback: Option<PathBuf>,
) -> anyhow::Result<PathBuf> {
    if let Some(pid) = pid {
        #[cfg(target_os = "macos")]
        {
            let mut command = Command::new("/usr/sbin/lsof");
            command.args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"]);
            if let Ok(output) =
                run_bounded_command(&command, Duration::from_secs(3), None, 16 * 1024, 4096)
            {
                if output.succeeded() && !output.stdout_truncated {
                    if let Some(path) = output
                        .stdout
                        .lines()
                        .find_map(|line| line.strip_prefix('n'))
                    {
                        let path = PathBuf::from(path);
                        if path.is_dir() {
                            return Ok(path);
                        }
                    }
                }
            }
        }
        #[cfg(target_os = "linux")]
        if let Ok(path) = std::fs::read_link(format!("/proc/{pid}/cwd")) {
            if path.is_dir() {
                return Ok(path);
            }
        }
    }
    fallback.map(Ok).unwrap_or_else(user_home_directory)
}

#[tauri::command]
pub(crate) async fn terminal_pane_working_directory(
    manager: tauri::State<'_, TerminalProcessManager>,
    pane_id: String,
) -> Result<String, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (pid, fallback) = manager.process_directory(&pane_id).map_err(to_string)?;
        terminal_current_directory(pid, fallback)
            .map(|path| path.display().to_string())
            .map_err(to_string)
    })
    .await
    .map_err(|error| format!("terminal directory worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn resize_terminal_pane(
    manager: tauri::State<'_, TerminalProcessManager>,
    pane_id: String,
    cols: u16,
    rows: u16,
) -> Result<TerminalPaneSnapshot, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.resize(&pane_id, cols, rows).map_err(to_string)
    })
    .await
    .map_err(|error| format!("terminal resize worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn terminal_pane_has_foreground_job(
    manager: tauri::State<'_, TerminalProcessManager>,
    pane_id: String,
) -> Result<bool, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.has_foreground_job(&pane_id).map_err(to_string)
    })
    .await
    .map_err(|error| format!("terminal activity worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn stop_terminal_pane(
    manager: tauri::State<'_, TerminalProcessManager>,
    pane_id: String,
) -> Result<TerminalPaneSnapshot, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.stop(&pane_id).map_err(to_string))
        .await
        .map_err(|error| format!("terminal stop worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn stop_model_terminal_resource(
    manager: tauri::State<'_, TerminalProcessManager>,
    resources: tauri::State<'_, ProviderCapabilityResourceManager>,
    session_id: String,
    resource_id: String,
) -> Result<TerminalPaneSnapshot, String> {
    let owned = resources
        .terminals
        .lock()
        .map_err(|_| "terminal capability state is unavailable".to_string())?
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "this chat has no model-owned terminal".to_string())?;
    if owned.session_id != session_id || owned.resource_id != resource_id {
        return Err("terminal resource did not belong to this chat".into());
    }
    let pane_id = owned.pane_id.clone();
    let terminal_manager = manager.inner().clone();
    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        terminal_manager.stop(&pane_id).map_err(to_string)
    })
    .await
    .map_err(|error| format!("model terminal stop worker failed: {error}"))??;
    if let Ok(mut terminals) = resources.terminals.lock() {
        if terminals
            .get(&session_id)
            .is_some_and(|current| current.resource_id == resource_id)
        {
            terminals.remove(&session_id);
        }
    }
    Ok(snapshot)
}

#[tauri::command]
pub(crate) async fn list_active_capability_resources(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<Vec<CapabilityResourceRef>, String> {
    parse_uuid(&session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        list_active_capability_resources_blocking(&app, &session_id)
    })
    .await
    .map_err(|error| format!("capability resource worker failed: {error}"))?
}

pub(crate) fn list_active_capability_resources_blocking(
    app: &tauri::AppHandle,
    session_id: &str,
) -> Result<Vec<CapabilityResourceRef>, String> {
    let resources = app.state::<ProviderCapabilityResourceManager>();
    let terminal = resources
        .terminals
        .lock()
        .map_err(|_| "terminal capability state is unavailable".to_string())?
        .get(session_id)
        .cloned();
    let browser = resources
        .browsers
        .lock()
        .map_err(|_| "browser capability state is unavailable".to_string())?
        .get(session_id)
        .cloned();
    let mut active = Vec::new();
    if let Some(terminal) = terminal {
        let label = app
            .state::<TerminalProcessManager>()
            .title(&terminal.pane_id)
            .map_err(to_string)?;
        active.push(CapabilityResourceRef {
            id: terminal.resource_id,
            kind: "terminal".into(),
            label,
        });
    }
    if let Some(browser) = browser {
        active.push(CapabilityResourceRef {
            id: browser.resource_id,
            kind: "browser".into(),
            label: browser.url,
        });
    }
    Ok(active)
}

#[tauri::command]
pub(crate) async fn close_terminal_pane(
    app: tauri::AppHandle,
    manager: tauri::State<'_, TerminalProcessManager>,
    pane_id: String,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    let governed_session =
        tauri::async_runtime::spawn_blocking(move || manager.close(&pane_id).map_err(to_string))
            .await
            .map_err(|error| format!("terminal close worker failed: {error}"))??;
    if let Some(session_id) = governed_session {
        release_pane_governance(&app, &session_id);
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn restart_terminal_pane(
    app: tauri::AppHandle,
    manager: tauri::State<'_, TerminalProcessManager>,
    pane_id: String,
) -> Result<TerminalPaneSnapshot, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager
            .restart_with(&pane_id, |request| {
                refresh_model_terminal_boundary(&app, request)
            })
            .map_err(to_string)
    })
    .await
    .map_err(|error| format!("terminal restart worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn restore_terminal_panes(
    manager: tauri::State<'_, TerminalProcessManager>,
) -> Result<Vec<TerminalPaneSnapshot>, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.restore().map_err(to_string))
        .await
        .map_err(|error| format!("terminal restore worker failed: {error}"))?
}
