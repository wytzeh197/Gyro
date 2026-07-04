use gyro_core::{
    create_worktree, ipc::AppNotification, AppNotificationKind, Automation, AutomationStatus,
    AutomationStore, AutomationTriageState, CreateAutomationRequest, CreateSessionContext,
    GyroConfig, GyroPaths, Session, SessionEvent, SessionEventKind, SessionOrigin, SessionStore,
    SessionWorkspaceMode,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use uuid::Uuid;
use walkdir::WalkDir;

const MAX_WORKSPACE_FILE_PREVIEW_BYTES: usize = 256 * 1024;
const MAX_TERMINAL_OUTPUT_BYTES: usize = 512 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFile {
    path: String,
    kind: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFileContent {
    path: String,
    content: String,
    truncated: bool,
    size_bytes: u64,
}

#[derive(Default)]
struct TerminalProcessManager {
    processes: Mutex<HashMap<String, TerminalProcess>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalPaneRequest {
    pane_id: String,
    title: String,
    command: String,
    args: Vec<String>,
    workspace_path: Option<String>,
    working_directory: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalPaneSnapshot {
    pane_id: String,
    title: String,
    command: String,
    output: String,
    status: String,
    exit_code: Option<i32>,
    cols: u16,
    rows: u16,
}

struct TerminalProcess {
    request: TerminalPaneRequest,
    stdin: Option<ChildStdin>,
    child: Child,
    output: Arc<Mutex<Vec<u8>>>,
    status: String,
    exit_code: Option<i32>,
    cols: u16,
    rows: u16,
}

impl TerminalProcessManager {
    fn create(&self, request: TerminalPaneRequest) -> anyhow::Result<TerminalPaneSnapshot> {
        let mut processes = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("terminal process manager lock poisoned"))?;
        if let Some(mut existing) = processes.remove(&request.pane_id) {
            let _ = existing.child.kill();
        }
        let mut process = spawn_terminal_process(request)?;
        let snapshot = snapshot_terminal_process(&mut process);
        processes.insert(process.request.pane_id.clone(), process);
        Ok(snapshot)
    }

    fn write(&self, pane_id: &str, input: &str) -> anyhow::Result<TerminalPaneSnapshot> {
        let mut processes = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("terminal process manager lock poisoned"))?;
        let process = processes
            .get_mut(pane_id)
            .ok_or_else(|| anyhow::anyhow!("terminal pane not found"))?;
        if let Some(stdin) = process.stdin.as_mut() {
            stdin.write_all(input.as_bytes())?;
            stdin.flush()?;
        } else {
            anyhow::bail!("terminal pane stdin is closed");
        }
        Ok(snapshot_terminal_process(process))
    }

    fn read(&self, pane_id: &str) -> anyhow::Result<TerminalPaneSnapshot> {
        let mut processes = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("terminal process manager lock poisoned"))?;
        let process = processes
            .get_mut(pane_id)
            .ok_or_else(|| anyhow::anyhow!("terminal pane not found"))?;
        Ok(snapshot_terminal_process(process))
    }

    fn resize(&self, pane_id: &str, cols: u16, rows: u16) -> anyhow::Result<TerminalPaneSnapshot> {
        let mut processes = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("terminal process manager lock poisoned"))?;
        let process = processes
            .get_mut(pane_id)
            .ok_or_else(|| anyhow::anyhow!("terminal pane not found"))?;
        process.cols = cols;
        process.rows = rows;
        Ok(snapshot_terminal_process(process))
    }

    fn stop(&self, pane_id: &str) -> anyhow::Result<TerminalPaneSnapshot> {
        let mut processes = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("terminal process manager lock poisoned"))?;
        let process = processes
            .get_mut(pane_id)
            .ok_or_else(|| anyhow::anyhow!("terminal pane not found"))?;
        let _ = process.child.kill();
        process.stdin = None;
        process.status = "failed".into();
        Ok(snapshot_terminal_process(process))
    }

    fn restart(&self, pane_id: &str) -> anyhow::Result<TerminalPaneSnapshot> {
        let request = {
            let mut processes = self
                .processes
                .lock()
                .map_err(|_| anyhow::anyhow!("terminal process manager lock poisoned"))?;
            let mut process = processes
                .remove(pane_id)
                .ok_or_else(|| anyhow::anyhow!("terminal pane not found"))?;
            let _ = process.child.kill();
            process.request.clone()
        };
        self.create(request)
    }

    fn restore(&self) -> anyhow::Result<Vec<TerminalPaneSnapshot>> {
        let mut processes = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("terminal process manager lock poisoned"))?;
        Ok(processes
            .values_mut()
            .map(snapshot_terminal_process)
            .collect())
    }
}

#[tauri::command]
fn list_sessions() -> Result<Vec<Session>, String> {
    let store = open_store()?;
    store.list_sessions().map_err(to_string)
}

#[tauri::command]
fn create_desktop_session(workspace_path: String, title: String) -> Result<Session, String> {
    let store = open_store()?;
    store
        .create_session(PathBuf::from(workspace_path), SessionOrigin::Desktop, title)
        .map_err(to_string)
}

#[tauri::command]
fn create_worktree_session(
    workspace_path: String,
    title: String,
    branch: String,
    worktree_name: Option<String>,
) -> Result<Session, String> {
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    let store = SessionStore::open(paths.clone()).map_err(to_string)?;
    let plan = create_worktree(&paths, PathBuf::from(workspace_path), branch, worktree_name)
        .map_err(to_string)?;

    let session = store
        .create_session_with_context(
            &plan.worktree_path,
            SessionOrigin::Desktop,
            title,
            CreateSessionContext {
                workspace_mode: SessionWorkspaceMode::Worktree,
                branch: plan.branch,
                worktree_name: Some(plan.worktree_name),
            },
        )
        .map_err(to_string)?;
    store
        .append_event(
            session.id,
            SessionEventKind::SystemEvent,
            "Worktree session created",
            serde_json::json!({
                "repoPath": plan.git_root,
                "worktreePath": plan.worktree_path,
                "branch": session.branch,
                "worktreeName": session.worktree_name,
            }),
        )
        .map_err(to_string)?;
    store
        .get_session(session.id)
        .map_err(to_string)?
        .ok_or_else(|| "worktree session was not persisted".into())
}

#[tauri::command]
fn rename_session(session_id: String, title: String) -> Result<Session, String> {
    let store = open_store()?;
    let session_id = parse_uuid(&session_id)?;
    store
        .rename_session(session_id, title)
        .map_err(to_string)?
        .ok_or_else(|| "session not found".into())
}

#[tauri::command]
fn delete_session(session_id: String) -> Result<bool, String> {
    let store = open_store()?;
    let session_id = parse_uuid(&session_id)?;
    store.delete_session(session_id).map_err(to_string)
}

#[tauri::command]
fn list_automations() -> Result<Vec<Automation>, String> {
    let store = open_automation_store()?;
    store.list_automations().map_err(to_string)
}

#[tauri::command]
fn list_due_automations() -> Result<Vec<Automation>, String> {
    let store = open_automation_store()?;
    store.list_due_automations_now().map_err(to_string)
}

#[tauri::command]
fn create_automation(draft: CreateAutomationRequest) -> Result<Automation, String> {
    let store = open_automation_store()?;
    store.create_automation(draft).map_err(to_string)
}

#[tauri::command]
fn set_automation_status(
    automation_id: String,
    status: AutomationStatus,
) -> Result<Automation, String> {
    let store = open_automation_store()?;
    let automation_id = parse_uuid(&automation_id)?;
    store
        .set_automation_status(automation_id, status)
        .map_err(to_string)?
        .ok_or_else(|| "automation not found".into())
}

#[tauri::command]
fn run_automation(automation_id: String, summary: String) -> Result<Automation, String> {
    let store = open_automation_store()?;
    let automation_id = parse_uuid(&automation_id)?;
    store
        .record_automation_run(automation_id, summary)
        .map_err(to_string)?
        .ok_or_else(|| "automation not found".into())
}

#[tauri::command]
fn claim_due_automation(
    lease_owner: String,
    lease_seconds: Option<i64>,
) -> Result<Option<Automation>, String> {
    let store = open_automation_store()?;
    store
        .claim_due_automation(lease_owner, lease_seconds.unwrap_or(300))
        .map_err(to_string)
}

#[tauri::command]
fn complete_automation_lease(
    automation_id: String,
    lease_owner: String,
    summary: String,
) -> Result<Automation, String> {
    let store = open_automation_store()?;
    let automation_id = parse_uuid(&automation_id)?;
    store
        .complete_automation_lease(automation_id, lease_owner, summary)
        .map_err(to_string)?
        .ok_or_else(|| "automation not found".into())
}

#[tauri::command]
fn recover_automation_leases() -> Result<usize, String> {
    let store = open_automation_store()?;
    store
        .recover_expired_automation_leases_now()
        .map_err(to_string)
}

#[tauri::command]
fn triage_automation(
    automation_id: String,
    triage_state: AutomationTriageState,
) -> Result<Automation, String> {
    let store = open_automation_store()?;
    let automation_id = parse_uuid(&automation_id)?;
    store
        .triage_automation(automation_id, triage_state)
        .map_err(to_string)?
        .ok_or_else(|| "automation not found".into())
}

#[tauri::command]
fn read_session_events(session_id: String) -> Result<Vec<SessionEvent>, String> {
    let store = open_store()?;
    let session_id = parse_uuid(&session_id)?;
    store.read_events(session_id).map_err(to_string)
}

#[tauri::command]
fn append_user_message(session_id: String, message: String) -> Result<SessionEvent, String> {
    let store = open_store()?;
    let session_id = parse_uuid(&session_id)?;
    store
        .append_user_turn_message(
            session_id,
            message,
            serde_json::json!({ "surface": "desktop" }),
        )
        .map_err(to_string)
}

#[tauri::command]
fn load_config() -> Result<GyroConfig, String> {
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    GyroConfig::load(&paths).map_err(to_string)
}

#[tauri::command]
fn save_config(config: GyroConfig) -> Result<(), String> {
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    config.save(&paths).map_err(to_string)
}

#[tauri::command]
fn list_workspace_files(workspace_path: String) -> Result<Vec<WorkspaceFile>, String> {
    let root = PathBuf::from(workspace_path)
        .canonicalize()
        .map_err(to_string)?;
    let mut entries = Vec::new();

    for entry in WalkDir::new(&root)
        .min_depth(1)
        .max_depth(3)
        .into_iter()
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            !matches!(
                name.as_ref(),
                ".git" | "node_modules" | "target" | "dist" | "build"
            )
        })
        .take(400)
    {
        let entry = entry.map_err(to_string)?;
        let path = entry.path().strip_prefix(&root).map_err(to_string)?;
        entries.push(WorkspaceFile {
            path: path.to_string_lossy().to_string(),
            kind: if entry.file_type().is_dir() {
                "directory".into()
            } else {
                "file".into()
            },
        });
    }

    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}

#[tauri::command]
fn read_workspace_file(
    workspace_path: String,
    path: String,
) -> Result<WorkspaceFileContent, String> {
    read_workspace_file_impl(&workspace_path, &path).map_err(to_string)
}

fn read_workspace_file_impl(
    workspace_path: &str,
    path: &str,
) -> anyhow::Result<WorkspaceFileContent> {
    let root = PathBuf::from(workspace_path).canonicalize()?;
    let candidate = gyro_core::security::assert_path_inside_workspace(&root, Path::new(path))?;
    let metadata = std::fs::metadata(&candidate)?;

    if metadata.is_dir() {
        anyhow::bail!("workspace preview path is a directory");
    }

    let mut file = std::fs::File::open(&candidate)?;
    let mut bytes =
        Vec::with_capacity(MAX_WORKSPACE_FILE_PREVIEW_BYTES.min(metadata.len() as usize));
    Read::by_ref(&mut file)
        .take((MAX_WORKSPACE_FILE_PREVIEW_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    let truncated = bytes.len() > MAX_WORKSPACE_FILE_PREVIEW_BYTES;
    if truncated {
        bytes.truncate(MAX_WORKSPACE_FILE_PREVIEW_BYTES);
    }
    if bytes.contains(&0) {
        anyhow::bail!("binary workspace files cannot be previewed");
    }
    let content = String::from_utf8_lossy(&bytes).to_string();

    Ok(WorkspaceFileContent {
        path: path.to_string(),
        content,
        truncated,
        size_bytes: metadata.len(),
    })
}

#[tauri::command]
fn create_terminal_pane(
    manager: tauri::State<'_, TerminalProcessManager>,
    request: TerminalPaneRequest,
) -> Result<TerminalPaneSnapshot, String> {
    manager.create(request).map_err(to_string)
}

#[tauri::command]
fn write_terminal_input(
    manager: tauri::State<'_, TerminalProcessManager>,
    pane_id: String,
    input: String,
) -> Result<TerminalPaneSnapshot, String> {
    manager.write(&pane_id, &input).map_err(to_string)
}

#[tauri::command]
fn read_terminal_output(
    manager: tauri::State<'_, TerminalProcessManager>,
    pane_id: String,
) -> Result<TerminalPaneSnapshot, String> {
    manager.read(&pane_id).map_err(to_string)
}

#[tauri::command]
fn resize_terminal_pane(
    manager: tauri::State<'_, TerminalProcessManager>,
    pane_id: String,
    cols: u16,
    rows: u16,
) -> Result<TerminalPaneSnapshot, String> {
    manager.resize(&pane_id, cols, rows).map_err(to_string)
}

#[tauri::command]
fn stop_terminal_pane(
    manager: tauri::State<'_, TerminalProcessManager>,
    pane_id: String,
) -> Result<TerminalPaneSnapshot, String> {
    manager.stop(&pane_id).map_err(to_string)
}

#[tauri::command]
fn restart_terminal_pane(
    manager: tauri::State<'_, TerminalProcessManager>,
    pane_id: String,
) -> Result<TerminalPaneSnapshot, String> {
    manager.restart(&pane_id).map_err(to_string)
}

#[tauri::command]
fn restore_terminal_panes(
    manager: tauri::State<'_, TerminalProcessManager>,
) -> Result<Vec<TerminalPaneSnapshot>, String> {
    manager.restore().map_err(to_string)
}

fn spawn_terminal_process(request: TerminalPaneRequest) -> anyhow::Result<TerminalProcess> {
    if request.command.trim().is_empty() {
        anyhow::bail!("terminal command cannot be empty");
    }

    let cwd = resolve_terminal_cwd(&request)?;
    let mut command = Command::new(&request.command);
    command
        .args(&request.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }

    let mut child = command.spawn()?;
    let stdin = child.stdin.take();
    let output = Arc::new(Mutex::new(Vec::new()));
    if let Some(stdout) = child.stdout.take() {
        spawn_terminal_reader(stdout, Arc::clone(&output));
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_terminal_reader(stderr, Arc::clone(&output));
    }

    Ok(TerminalProcess {
        request,
        stdin,
        child,
        output,
        status: "running".into(),
        exit_code: None,
        cols: 120,
        rows: 32,
    })
}

fn resolve_terminal_cwd(request: &TerminalPaneRequest) -> anyhow::Result<Option<PathBuf>> {
    let workspace = request
        .workspace_path
        .as_deref()
        .map(PathBuf::from)
        .map(|path| path.canonicalize())
        .transpose()?;
    let Some(workspace) = workspace else {
        return Ok(None);
    };

    let Some(working_directory) = request.working_directory.as_deref() else {
        return Ok(Some(workspace));
    };
    if working_directory.trim().is_empty() || working_directory == "Workspace" {
        return Ok(Some(workspace));
    }

    let candidate = Path::new(working_directory);
    gyro_core::security::assert_path_inside_workspace(&workspace, candidate).map(Some)
}

fn spawn_terminal_reader<R>(reader: R, output: Arc<Mutex<Vec<u8>>>)
where
    R: Read + Send + 'static,
{
    std::thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut chunk = [0; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(count) => append_terminal_output(&output, &chunk[..count]),
                Err(_) => break,
            }
        }
    });
}

fn append_terminal_output(output: &Arc<Mutex<Vec<u8>>>, bytes: &[u8]) {
    let Ok(mut output) = output.lock() else {
        return;
    };
    output.extend_from_slice(bytes);
    if output.len() > MAX_TERMINAL_OUTPUT_BYTES {
        let overflow = output.len() - MAX_TERMINAL_OUTPUT_BYTES;
        output.drain(0..overflow);
    }
}

fn snapshot_terminal_process(process: &mut TerminalProcess) -> TerminalPaneSnapshot {
    match process.child.try_wait() {
        Ok(Some(status)) => {
            process.stdin = None;
            process.exit_code = status.code();
            process.status = if status.success() {
                "done".into()
            } else {
                "failed".into()
            };
        }
        Ok(None) => {
            if process.status != "failed" {
                process.status = "running".into();
            }
        }
        Err(_) => {
            process.stdin = None;
            process.status = "failed".into();
        }
    }

    let output = process
        .output
        .lock()
        .map(|value| String::from_utf8_lossy(&value).to_string())
        .unwrap_or_default();
    TerminalPaneSnapshot {
        pane_id: process.request.pane_id.clone(),
        title: process.request.title.clone(),
        command: std::iter::once(process.request.command.as_str())
            .chain(process.request.args.iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join(" "),
        output,
        status: process.status.clone(),
        exit_code: process.exit_code,
        cols: process.cols,
        rows: process.rows,
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(TerminalProcessManager::default())
        .setup(|app| {
            start_cli_ipc_listener(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            append_user_message,
            claim_due_automation,
            complete_automation_lease,
            create_automation,
            create_desktop_session,
            create_terminal_pane,
            create_worktree_session,
            delete_session,
            list_automations,
            list_due_automations,
            list_sessions,
            list_workspace_files,
            load_config,
            read_workspace_file,
            read_terminal_output,
            read_session_events,
            recover_automation_leases,
            rename_session,
            resize_terminal_pane,
            restart_terminal_pane,
            restore_terminal_panes,
            run_automation,
            save_config,
            set_automation_status,
            stop_terminal_pane,
            triage_automation,
            write_terminal_input
        ])
        .run(tauri::generate_context!())
        .expect("error while running Gyro");
}

fn open_store() -> Result<SessionStore, String> {
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    SessionStore::open(paths).map_err(to_string)
}

fn open_automation_store() -> Result<AutomationStore, String> {
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    AutomationStore::open(paths).map_err(to_string)
}

fn parse_uuid(value: &str) -> Result<Uuid, String> {
    Uuid::parse_str(value).map_err(to_string)
}

fn to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn start_cli_ipc_listener(app: tauri::AppHandle) {
    let paths = match GyroPaths::for_current_user() {
        Ok(paths) => paths,
        Err(error) => {
            eprintln!("could not start Gyro IPC listener: {error}");
            return;
        }
    };

    std::thread::spawn(move || {
        #[cfg(unix)]
        {
            use std::os::unix::net::UnixListener;

            if paths.socket_path.exists() {
                let _ = std::fs::remove_file(&paths.socket_path);
            }
            if let Err(error) = paths.ensure() {
                eprintln!("could not create Gyro IPC directory: {error}");
                return;
            }

            let listener = match UnixListener::bind(&paths.socket_path) {
                Ok(listener) => listener,
                Err(error) => {
                    eprintln!("could not bind Gyro IPC socket: {error}");
                    return;
                }
            };

            for stream in listener.incoming() {
                let Ok(stream) = stream else {
                    continue;
                };
                let mut reader = BufReader::new(stream);
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    continue;
                }
                let Ok(notification) = serde_json::from_str::<AppNotification>(line.trim()) else {
                    continue;
                };
                if matches!(
                    &notification.kind,
                    AppNotificationKind::OpenSession | AppNotificationKind::AttachSession
                ) {
                    let _ = app.emit("gyro://app-notification", notification);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_text_file_inside_workspace() {
        let workspace = tempfile::tempdir().unwrap();
        let source_dir = workspace.path().join("src");
        std::fs::create_dir_all(&source_dir).unwrap();
        std::fs::write(source_dir.join("app.ts"), "export const value = 1;\n").unwrap();

        let content =
            read_workspace_file_impl(workspace.path().to_str().unwrap(), "src/app.ts").unwrap();

        assert_eq!(content.path, "src/app.ts");
        assert_eq!(content.content, "export const value = 1;\n");
        assert!(!content.truncated);
        assert_eq!(content.size_bytes, 24);
    }

    #[test]
    fn truncates_large_text_preview() {
        let workspace = tempfile::tempdir().unwrap();
        let large = "a".repeat(MAX_WORKSPACE_FILE_PREVIEW_BYTES + 16);
        std::fs::write(workspace.path().join("large.txt"), large).unwrap();

        let content =
            read_workspace_file_impl(workspace.path().to_str().unwrap(), "large.txt").unwrap();

        assert!(content.truncated);
        assert_eq!(content.content.len(), MAX_WORKSPACE_FILE_PREVIEW_BYTES);
        assert_eq!(
            content.size_bytes,
            (MAX_WORKSPACE_FILE_PREVIEW_BYTES + 16) as u64
        );
    }

    #[test]
    fn rejects_file_outside_workspace() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();

        let error = read_workspace_file_impl(
            workspace.path().to_str().unwrap(),
            outside.path().to_str().unwrap(),
        )
        .unwrap_err();

        assert!(error.to_string().contains("outside workspace"));
    }

    #[test]
    fn terminal_manager_runs_command_and_captures_output() {
        let manager = TerminalProcessManager::default();
        let snapshot = manager
            .create(TerminalPaneRequest {
                pane_id: "pane-test".into(),
                title: "Shell".into(),
                command: "sh".into(),
                args: vec!["-c".into(), "printf hello".into()],
                workspace_path: None,
                working_directory: None,
            })
            .unwrap();
        assert_eq!(snapshot.status, "running");

        let snapshot = wait_for_terminal_output(&manager, "pane-test", "hello");
        assert!(snapshot.output.contains("hello"));
        assert_eq!(snapshot.status, "done");
    }

    #[test]
    fn terminal_manager_writes_input_and_resizes() {
        let manager = TerminalProcessManager::default();
        manager
            .create(TerminalPaneRequest {
                pane_id: "pane-input".into(),
                title: "Shell".into(),
                command: "sh".into(),
                args: vec!["-c".into(), "read line; printf out:$line".into()],
                workspace_path: None,
                working_directory: None,
            })
            .unwrap();

        manager.write("pane-input", "ok\n").unwrap();
        let resized = manager.resize("pane-input", 90, 24).unwrap();
        assert_eq!(resized.cols, 90);
        assert_eq!(resized.rows, 24);

        let snapshot = wait_for_terminal_output(&manager, "pane-input", "out:ok");
        assert!(snapshot.output.contains("out:ok"));
        assert_eq!(snapshot.status, "done");
    }

    #[test]
    fn terminal_manager_stops_running_process() {
        let manager = TerminalProcessManager::default();
        manager
            .create(TerminalPaneRequest {
                pane_id: "pane-stop".into(),
                title: "Shell".into(),
                command: "sh".into(),
                args: vec!["-c".into(), "sleep 5".into()],
                workspace_path: None,
                working_directory: None,
            })
            .unwrap();

        let snapshot = manager.stop("pane-stop").unwrap();

        assert_eq!(snapshot.status, "failed");
    }

    fn wait_for_terminal_output(
        manager: &TerminalProcessManager,
        pane_id: &str,
        expected: &str,
    ) -> TerminalPaneSnapshot {
        for _ in 0..20 {
            let snapshot = manager.read(pane_id).unwrap();
            if snapshot.output.contains(expected) && snapshot.status != "running" {
                return snapshot;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        manager.read(pane_id).unwrap()
    }
}
