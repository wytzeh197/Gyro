#[cfg(unix)]
use crate::ipc::cli::provider_host_ipc_paths;
#[cfg(target_os = "macos")]
use crate::window_controls::apply_macos_traffic_light_position;
use crate::{
    automation::runtime::AutomationSchedulerControl,
    ide::types::DebugAdapterManager,
    language_server,
    state::managers::{active_task_runs, ProviderCancellationManager},
    terminal::types::TerminalProcessManager,
    terminal_process,
};
#[cfg(target_os = "macos")]
use anyhow::Context;
use gyro_core::{CancellationToken, GyroPaths};
#[cfg(unix)]
use std::fs;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
use tauri::Manager;
/// Whole-quit budget. Quit runs on the main thread, so no single wedged
/// language server, debug adapter or PTY may hold it longer than this.
pub(crate) const QUIT_DRAIN_DEADLINE: Duration = Duration::from_secs(2);
pub(crate) static QUIT_DRAINED: AtomicBool = AtomicBool::new(false);

pub(crate) fn drain_backend_resources_on_quit(app: &tauri::AppHandle) {
    // Best-effort drain on true quit. Window hide on macOS is intentional and
    // must keep the automation scheduler and terminals alive. ExitRequested and
    // Exit both land here; drain once so quit spends one deadline, not two.
    if QUIT_DRAINED.swap(true, Ordering::SeqCst) {
        return;
    }
    let deadline = Instant::now() + QUIT_DRAIN_DEADLINE;
    if let Ok(mut flags) = app.state::<ProviderCancellationManager>().flags.lock() {
        for control in flags.values() {
            control.cancellation.cancel();
        }
        flags.clear();
    }
    // Cancelled task runs kill their own commands; the wait below lets them.
    if let Ok(runs) = active_task_runs().lock() {
        runs.values().for_each(CancellationToken::cancel);
    }
    app.state::<AutomationSchedulerControl>().wake();
    let mut jobs: Vec<Box<dyn FnOnce() + Send>> = Vec::new();
    // Provider CLIs and task commands run in their own process groups and get
    // no SIGHUP from the app exiting; the process exits right after this drain,
    // before a cancelled runner could reap them itself.
    jobs.push(Box::new(|| {
        gyro_core::terminate_live_process_groups(QUIT_DRAIN_DEADLINE / 2)
    }));
    for pane in app.state::<TerminalProcessManager>().take_all() {
        jobs.push(Box::new(move || {
            terminal_process::terminate_terminal_pane(&pane)
        }));
    }
    let language_servers = app
        .state::<language_server::LanguageServerManager>()
        .inner()
        .clone();
    for server_id in language_servers.server_ids() {
        let manager = language_servers.clone();
        jobs.push(Box::new(move || drop(manager.stop(&server_id))));
    }
    let debug_adapters = app.state::<DebugAdapterManager>().inner().clone();
    let debug_session_ids = debug_adapters
        .processes
        .lock()
        .map(|processes| processes.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    for session_id in debug_session_ids {
        let manager = debug_adapters.clone();
        jobs.push(Box::new(move || drop(manager.stop(&session_id))));
    }
    run_quit_jobs_until(jobs, deadline);
    while Instant::now() < deadline && active_task_runs().lock().is_ok_and(|runs| !runs.is_empty())
    {
        std::thread::sleep(Duration::from_millis(20));
    }
    if let Ok(paths) = GyroPaths::for_current_user() {
        remove_provider_host_ipc_socket(paths, std::process::id());
    }
}

/// Runs each shutdown on its own thread and returns by `deadline` even if some
/// never finish; the process is exiting, so stragglers die with it.
pub(crate) fn run_quit_jobs_until(jobs: Vec<Box<dyn FnOnce() + Send>>, deadline: Instant) {
    let (done, finished) = mpsc::channel::<()>();
    let pending = jobs.len();
    for job in jobs {
        let done = done.clone();
        let _ = std::thread::Builder::new()
            .name("gyro-quit-drain".into())
            .spawn(move || {
                job();
                let _ = done.send(());
            });
    }
    drop(done);
    for _ in 0..pending {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if finished.recv_timeout(remaining).is_err() {
            break;
        }
    }
}

/// The per-PID provider socket belongs to this process alone; the public CLI
/// socket may be taken over by another instance and is left alone.
pub(crate) fn remove_provider_host_ipc_socket(paths: GyroPaths, host_pid: u32) {
    #[cfg(unix)]
    if let Ok(paths) = provider_host_ipc_paths(paths, host_pid) {
        use std::os::unix::fs::FileTypeExt;
        if fs::symlink_metadata(&paths.socket_path).is_ok_and(|meta| meta.file_type().is_socket()) {
            let _ = fs::remove_file(&paths.socket_path);
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn restore_main_window(app: &tauri::AppHandle) -> anyhow::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        apply_macos_traffic_light_position(&window);
        window.unminimize()?;
        window.show()?;
        window.set_focus()?;
        return Ok(());
    }

    let config = app
        .config()
        .app
        .windows
        .first()
        .context("Gyro has no configured main window")?;
    let window = tauri::WebviewWindowBuilder::from_config(app, config)?.build()?;
    apply_macos_traffic_light_position(&window);
    window.show()?;
    window.set_focus()?;
    Ok(())
}
