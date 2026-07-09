use gyro_core::{
    create_worktree, ipc::AppNotification, logout_account as account_logout,
    refresh_account_session as account_refresh_session, start_account_login as account_start_login,
    stored_account_session as account_stored_session, AccountSessionState, AppNotificationKind,
    Automation, AutomationStatus, AutomationStore, AutomationTriageState, CreateAutomationRequest,
    CreateSessionContext, GyroConfig, GyroPaths, Session, SessionEvent, SessionEventKind,
    SessionOrigin, SessionStore, SessionWorkspaceMode,
};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use uuid::Uuid;
use walkdir::WalkDir;

const MAX_WORKSPACE_FILE_PREVIEW_BYTES: usize = 256 * 1024;
const MAX_WORKSPACE_FILE_EDIT_BYTES: usize = 2 * 1024 * 1024;
const MAX_TERMINAL_OUTPUT_BYTES: usize = 512 * 1024;
const GUI_CLI_PATHS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFile {
    path: String,
    kind: String,
    depth: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFileContent {
    path: String,
    content: String,
    truncated: bool,
    size_bytes: u64,
    content_hash: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFileStat {
    path: String,
    kind: String,
    size_bytes: u64,
    content_hash: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFileWriteRequest {
    workspace_path: String,
    path: String,
    content: String,
    expected_hash: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspacePathCreateRequest {
    workspace_path: String,
    path: String,
    kind: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspacePathRenameRequest {
    workspace_path: String,
    from_path: String,
    to_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspacePathDeleteRequest {
    workspace_path: String,
    path: String,
    expected_hash: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSearchRequest {
    workspace_path: String,
    query: String,
    globs: Option<Vec<String>>,
    max_results: Option<usize>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSearchResult {
    path: String,
    line_number: usize,
    line: String,
    ranges: Vec<WorkspaceSearchRange>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSearchRange {
    start_column: usize,
    end_column: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceControlFile {
    path: String,
    original_path: Option<String>,
    state: String,
    staged: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceControlStatus {
    provider: String,
    available: bool,
    branch: Option<String>,
    upstream: Option<String>,
    ahead: usize,
    behind: usize,
    files: Vec<SourceControlFile>,
    last_checked_at: Option<String>,
    error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitPathRequest {
    workspace_path: String,
    path: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitStageRequest {
    workspace_path: String,
    path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitCommitRequest {
    workspace_path: String,
    message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IdeCommandOutput {
    status: String,
    stdout: String,
    stderr: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskDefinitionResult {
    id: String,
    label: String,
    command: String,
    args: Vec<String>,
    group: String,
    cwd: Option<String>,
    status: String,
    output_channel_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskRunRequest {
    workspace_path: String,
    task_id: String,
    command: String,
    args: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TestTreeItemResult {
    id: String,
    label: String,
    path: Option<String>,
    status: String,
    children: Vec<TestTreeItemResult>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestRunRequest {
    workspace_path: String,
    test_ids: Option<Vec<String>>,
    command: Option<String>,
    args: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LspStartRequest {
    workspace_path: String,
    language_id: String,
    command: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LspRequestPayload {
    server_id: String,
    method: String,
    params: serde_json::Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LspSessionResult {
    server_id: String,
    language_id: String,
    command: String,
    status: String,
    message: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DebugStartRequest {
    workspace_path: Option<String>,
    name: String,
    adapter: String,
    command: Option<String>,
    args: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DebugSendRequest {
    session_id: String,
    request: serde_json::Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DebugSessionResult {
    id: String,
    name: String,
    adapter: String,
    status: String,
    message: Option<String>,
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
    cols: Option<u16>,
    rows: Option<u16>,
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

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderHealthRequest {
    provider_id: String,
    base_url: Option<String>,
    api_key_ref: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderHealthCheck {
    provider_id: String,
    output: String,
    runtime_status: String,
    auth_owner: String,
    auth_command: Option<String>,
    login_command: Option<String>,
    account_label: Option<String>,
    subscription_label: Option<String>,
    provider_mode: Option<String>,
    secret_storage: String,
    privacy_note: String,
    diagnostics_opt_in: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderChatRequest {
    session_id: String,
    message: String,
    turn_id: Option<String>,
    provider_id: String,
    provider_label: Option<String>,
    model_id: Option<String>,
    model_label: Option<String>,
    workspace_path: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderChatResponse {
    assistant_event: SessionEvent,
    status_event: SessionEvent,
}

struct TerminalProcess {
    request: TerminalPaneRequest,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send>,
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
        if process.status == "done" || process.status == "failed" {
            anyhow::bail!("terminal pane stdin is closed");
        }
        process.writer.write_all(input.as_bytes())?;
        process.writer.flush()?;
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
        process.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
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
fn create_desktop_session(
    workspace_path: String,
    title: String,
    provider_id: Option<String>,
    provider_label: Option<String>,
    model_id: Option<String>,
    model_label: Option<String>,
) -> Result<Session, String> {
    let store = open_store()?;
    store
        .create_session_with_context(
            PathBuf::from(workspace_path),
            SessionOrigin::Desktop,
            title,
            CreateSessionContext {
                provider_id,
                provider_label,
                model_id,
                model_label,
                ..CreateSessionContext::default()
            },
        )
        .map_err(to_string)
}

#[tauri::command]
fn create_worktree_session(
    workspace_path: String,
    title: String,
    branch: String,
    worktree_name: Option<String>,
    provider_id: Option<String>,
    provider_label: Option<String>,
    model_id: Option<String>,
    model_label: Option<String>,
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
                provider_id,
                provider_label,
                model_id,
                model_label,
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
fn set_session_model(
    session_id: String,
    provider_id: Option<String>,
    provider_label: Option<String>,
    model_id: Option<String>,
    model_label: Option<String>,
) -> Result<Session, String> {
    let store = open_store()?;
    let session_id = parse_uuid(&session_id)?;
    store
        .update_session_model(
            session_id,
            provider_id,
            provider_label,
            model_id,
            model_label,
        )
        .map_err(to_string)?
        .ok_or_else(|| "session not found".into())
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
fn append_user_message(
    session_id: String,
    message: String,
    turn_id: Option<String>,
) -> Result<SessionEvent, String> {
    let store = open_store()?;
    let session_id = parse_uuid(&session_id)?;
    if let Some(turn_id) = turn_id.as_deref() {
        return store
            .append_user_turn_message_with_turn_id(
                session_id,
                message,
                serde_json::json!({ "surface": "desktop" }),
                parse_uuid(turn_id)?,
            )
            .map_err(to_string);
    }
    store
        .append_user_turn_message(
            session_id,
            message,
            serde_json::json!({ "surface": "desktop" }),
        )
        .map_err(to_string)
}

#[tauri::command]
fn run_provider_chat(request: ProviderChatRequest) -> Result<ProviderChatResponse, String> {
    if request.provider_id != "openai" {
        return Err(format!(
            "{} chat is not wired yet. OpenAI runs through the local Codex login first.",
            request.provider_label.as_deref().unwrap_or("Provider")
        ));
    }

    let store = open_store()?;
    let session_id = parse_uuid(&request.session_id)?;
    let turn_id = request.turn_id.as_deref().map(parse_uuid).transpose()?;
    let response = match run_openai_codex_chat(&request) {
        Ok(response) => response,
        Err(error) => {
            let error = gyro_core::security::redact_secrets(&error.to_string());
            let _ = append_provider_status_event(
                &store,
                session_id,
                &request,
                turn_id,
                "failed",
                Some(error.as_str()),
            );
            return Err(error);
        }
    };
    let status_event =
        append_provider_status_event(&store, session_id, &request, turn_id, "ready", None)
            .map_err(to_string)?;
    let assistant_event = store
        .append_event_with_turn_id(
            session_id,
            SessionEventKind::AssistantMessage,
            response,
            serde_json::json!({
                "kind": "provider-response",
                "providerId": request.provider_id,
                "providerLabel": request.provider_label.as_deref().unwrap_or("OpenAI"),
                "modelId": request.model_id,
                "modelLabel": request.model_label,
                "runner": "codex-cli",
                "authOwner": "chatgpt-local-codex-login",
            }),
            turn_id,
        )
        .map_err(to_string)?;

    Ok(ProviderChatResponse {
        assistant_event,
        status_event,
    })
}

#[tauri::command]
fn append_plan_event(
    session_id: String,
    message: Option<String>,
    payload: serde_json::Value,
) -> Result<SessionEvent, String> {
    let store = open_store()?;
    let session_id = parse_uuid(&session_id)?;
    let turn_id = payload
        .get("turnId")
        .and_then(|value| value.as_str())
        .map(parse_uuid)
        .transpose()?;
    let message = message.unwrap_or_else(|| {
        let action = payload
            .get("action")
            .and_then(|value| value.as_str())
            .unwrap_or("updated")
            .replace('-', " ");
        format!("Plan {action}")
    });
    store
        .append_event_with_turn_id(
            session_id,
            SessionEventKind::PlanUpdated,
            message,
            payload,
            turn_id,
        )
        .map_err(to_string)
}

#[tauri::command]
fn append_editor_event(
    session_id: String,
    event_kind: String,
    message: String,
    payload: serde_json::Value,
) -> Result<SessionEvent, String> {
    let store = open_store()?;
    let session_id = parse_uuid(&session_id)?;
    let kind = match event_kind.as_str() {
        "ai-edit-proposed" => SessionEventKind::FileEditProposed,
        _ => SessionEventKind::SystemEvent,
    };
    store
        .append_event(
            session_id,
            kind,
            message,
            serde_json::json!({
                "kind": event_kind,
                "surface": "desktop-ide",
                "data": payload,
            }),
        )
        .map_err(to_string)
}

#[tauri::command]
fn load_config() -> Result<GyroConfig, String> {
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    GyroConfig::load(&paths).map_err(to_string)
}

#[tauri::command]
fn get_account_session() -> Result<AccountSessionState, String> {
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    account_stored_session(&paths).map_err(to_string)
}

#[tauri::command]
fn start_account_login() -> Result<AccountSessionState, String> {
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    account_start_login(&paths).map_err(to_string)
}

#[tauri::command]
fn refresh_account_session() -> Result<AccountSessionState, String> {
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    account_refresh_session(&paths).map_err(to_string)
}

#[tauri::command]
fn logout_account() -> Result<AccountSessionState, String> {
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    account_logout(&paths).map_err(to_string)
}

#[tauri::command]
fn save_config(config: GyroConfig) -> Result<(), String> {
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    config.save(&paths).map_err(to_string)
}

#[tauri::command]
fn list_workspace_files(workspace_path: String) -> Result<Vec<WorkspaceFile>, String> {
    list_workspace_tree(workspace_path, Some(3))
}

#[tauri::command]
fn list_workspace_tree(
    workspace_path: String,
    depth: Option<usize>,
) -> Result<Vec<WorkspaceFile>, String> {
    let root = PathBuf::from(workspace_path)
        .canonicalize()
        .map_err(to_string)?;
    let max_depth = depth.unwrap_or(4).clamp(1, 8);
    let mut entries = Vec::new();

    for entry in WalkDir::new(&root)
        .min_depth(1)
        .max_depth(max_depth)
        .into_iter()
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            !matches!(
                name.as_ref(),
                ".git" | ".next" | "node_modules" | "target" | "dist" | "build"
            )
        })
        .take(1200)
    {
        let entry = entry.map_err(to_string)?;
        let path = entry.path().strip_prefix(&root).map_err(to_string)?;
        let kind = if entry.file_type().is_dir() {
            "directory".into()
        } else {
            "file".into()
        };
        entries.push(WorkspaceFile {
            path: path.to_string_lossy().to_string(),
            kind,
            depth: path.components().count(),
        });
    }

    entries.sort_by(|a, b| {
        let a_parent = Path::new(&a.path).parent();
        let b_parent = Path::new(&b.path).parent();
        a_parent
            .cmp(&b_parent)
            .then_with(|| a.kind.cmp(&b.kind))
            .then_with(|| a.path.cmp(&b.path))
    });
    Ok(entries)
}

#[tauri::command]
fn read_workspace_file(
    workspace_path: String,
    path: String,
) -> Result<WorkspaceFileContent, String> {
    read_workspace_file_impl(&workspace_path, &path).map_err(to_string)
}

#[tauri::command]
fn read_workspace_file_full(
    workspace_path: String,
    path: String,
) -> Result<WorkspaceFileContent, String> {
    read_workspace_file_with_limit(&workspace_path, &path, MAX_WORKSPACE_FILE_EDIT_BYTES)
        .map_err(to_string)
}

#[tauri::command]
fn stat_workspace_file(workspace_path: String, path: String) -> Result<WorkspaceFileStat, String> {
    stat_workspace_file_impl(&workspace_path, &path).map_err(to_string)
}

#[tauri::command]
fn write_workspace_file(
    request: WorkspaceFileWriteRequest,
) -> Result<WorkspaceFileContent, String> {
    write_workspace_file_impl(&request).map_err(to_string)
}

#[tauri::command]
fn watch_workspace(workspace_path: String) -> Result<Vec<WorkspaceFile>, String> {
    // V1 exposes a normalized snapshot through the command boundary. A long-lived
    // watcher can layer event streaming on the same WorkspaceFile shape later.
    list_workspace_tree(workspace_path, Some(5))
}

#[tauri::command]
fn create_workspace_file(request: WorkspacePathCreateRequest) -> Result<WorkspaceFileStat, String> {
    create_workspace_path_impl(&request).map_err(to_string)
}

#[tauri::command]
fn rename_workspace_path(request: WorkspacePathRenameRequest) -> Result<WorkspaceFileStat, String> {
    rename_workspace_path_impl(&request).map_err(to_string)
}

#[tauri::command]
fn delete_workspace_path(request: WorkspacePathDeleteRequest) -> Result<bool, String> {
    delete_workspace_path_impl(&request).map_err(to_string)
}

#[tauri::command]
fn search_workspace(request: WorkspaceSearchRequest) -> Result<Vec<WorkspaceSearchResult>, String> {
    search_workspace_impl(&request).map_err(to_string)
}

#[tauri::command]
fn git_status(workspace_path: String) -> Result<SourceControlStatus, String> {
    git_status_impl(&workspace_path).map_err(to_string)
}

#[tauri::command]
fn git_diff(request: GitPathRequest) -> Result<IdeCommandOutput, String> {
    let root = workspace_root(&request.workspace_path).map_err(to_string)?;
    let mut command = command_with_gui_path("git");
    command.arg("-C").arg(root).arg("diff").arg("--");
    if let Some(path) = request.path {
        command.arg(path);
    }
    run_command_output(command).map_err(to_string)
}

#[tauri::command]
fn git_stage(request: GitStageRequest) -> Result<SourceControlStatus, String> {
    let root = workspace_root(&request.workspace_path).map_err(to_string)?;
    let path = assert_workspace_path(&root, &request.path).map_err(to_string)?;
    let relative = path.strip_prefix(&root).map_err(to_string)?;
    let mut command = command_with_gui_path("git");
    command
        .arg("-C")
        .arg(&root)
        .arg("add")
        .arg("--")
        .arg(relative);
    run_command_output(command).map_err(to_string)?;
    git_status_impl(&request.workspace_path).map_err(to_string)
}

#[tauri::command]
fn git_unstage(request: GitStageRequest) -> Result<SourceControlStatus, String> {
    let root = workspace_root(&request.workspace_path).map_err(to_string)?;
    let path = assert_workspace_path(&root, &request.path).map_err(to_string)?;
    let relative = path.strip_prefix(&root).map_err(to_string)?;
    let mut command = command_with_gui_path("git");
    command
        .arg("-C")
        .arg(&root)
        .arg("restore")
        .arg("--staged")
        .arg("--")
        .arg(relative);
    run_command_output(command).map_err(to_string)?;
    git_status_impl(&request.workspace_path).map_err(to_string)
}

#[tauri::command]
fn git_commit(request: GitCommitRequest) -> Result<IdeCommandOutput, String> {
    let root = workspace_root(&request.workspace_path).map_err(to_string)?;
    if request.message.trim().is_empty() {
        return Err("commit message is required".into());
    }
    let mut command = command_with_gui_path("git");
    command
        .arg("-C")
        .arg(root)
        .arg("commit")
        .arg("-m")
        .arg(request.message);
    run_command_output(command).map_err(to_string)
}

#[tauri::command]
fn lsp_start(request: LspStartRequest) -> Result<LspSessionResult, String> {
    let root = workspace_root(&request.workspace_path).map_err(to_string)?;
    let command_text = request.command.clone();
    let mut parts = command_text.split_whitespace();
    let command_name = parts
        .next()
        .ok_or_else(|| "language server command is required".to_string())?;
    let mut command = command_with_gui_path(command_name);
    command.arg("--version");
    command.current_dir(root);
    let output = command.output();
    let (status, message) = match output {
        Ok(output) if output.status.success() => (
            "ready".to_string(),
            String::from_utf8_lossy(&output.stdout).trim().to_string(),
        ),
        Ok(output) => (
            "warning".to_string(),
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ),
        Err(error) => ("not-installed".to_string(), error.to_string()),
    };
    Ok(LspSessionResult {
        server_id: format!("{}:{}", request.language_id, command_name),
        language_id: request.language_id,
        command: command_text,
        status,
        message,
    })
}

#[tauri::command]
fn lsp_request(request: LspRequestPayload) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "serverId": request.server_id,
        "method": request.method,
        "params": request.params,
        "status": "not-running",
        "message": "Language server process orchestration is scaffolded for Core IDE V1.",
    }))
}

#[tauri::command]
fn lsp_stop(server_id: String) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "serverId": server_id,
        "status": "stopped",
    }))
}

#[tauri::command]
fn task_discover(workspace_path: String) -> Result<Vec<TaskDefinitionResult>, String> {
    task_discover_impl(&workspace_path).map_err(to_string)
}

#[tauri::command]
fn task_run(request: TaskRunRequest) -> Result<IdeCommandOutput, String> {
    let root = workspace_root(&request.workspace_path).map_err(to_string)?;
    let mut command = command_with_gui_path(&request.command);
    command.current_dir(root).args(request.args);
    let mut output = run_command_output(command).map_err(to_string)?;
    if output.status == "done" {
        output.stdout = format!("task {} completed\n{}", request.task_id, output.stdout);
    }
    Ok(output)
}

#[tauri::command]
fn test_discover(workspace_path: String) -> Result<Vec<TestTreeItemResult>, String> {
    test_discover_impl(&workspace_path).map_err(to_string)
}

#[tauri::command]
fn test_run(request: TestRunRequest) -> Result<IdeCommandOutput, String> {
    let root = workspace_root(&request.workspace_path).map_err(to_string)?;
    let command_name = request.command.unwrap_or_else(|| "cargo".into());
    let args = request.args.unwrap_or_else(|| vec!["test".into()]);
    let mut command = command_with_gui_path(&command_name);
    command.current_dir(root).args(args);
    let mut output = run_command_output(command).map_err(to_string)?;
    if let Some(test_ids) = request.test_ids {
        output.stdout = format!("tests {:?}\n{}", test_ids, output.stdout);
    }
    Ok(output)
}

#[tauri::command]
fn debug_start(request: DebugStartRequest) -> Result<DebugSessionResult, String> {
    if let Some(workspace_path) = request.workspace_path.as_deref() {
        let _ = workspace_root(workspace_path).map_err(to_string)?;
    }
    let command = request.command.as_deref().unwrap_or(&request.adapter);
    let mut probe = command_with_gui_path(command);
    probe.arg("--version");
    if let Some(args) = request.args.as_ref() {
        let _ = args.len();
    }
    let (status, message) = match probe.output() {
        Ok(output) if output.status.success() => (
            "configured".to_string(),
            Some(String::from_utf8_lossy(&output.stdout).trim().to_string()),
        ),
        Ok(output) => (
            "failed".to_string(),
            Some(String::from_utf8_lossy(&output.stderr).trim().to_string()),
        ),
        Err(error) => ("failed".to_string(), Some(error.to_string())),
    };
    Ok(DebugSessionResult {
        id: format!("debug-{}", Uuid::new_v4()),
        name: request.name,
        adapter: request.adapter,
        status,
        message,
    })
}

#[tauri::command]
fn debug_send(request: DebugSendRequest) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "sessionId": request.session_id,
        "status": "not-running",
        "request": request.request,
        "message": "Debug Adapter Protocol bridge is scaffolded for Core IDE V1.",
    }))
}

#[tauri::command]
fn debug_stop(session_id: String) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "sessionId": session_id,
        "status": "stopped",
    }))
}

fn read_workspace_file_impl(
    workspace_path: &str,
    path: &str,
) -> anyhow::Result<WorkspaceFileContent> {
    read_workspace_file_with_limit(workspace_path, path, MAX_WORKSPACE_FILE_PREVIEW_BYTES)
}

fn read_workspace_file_with_limit(
    workspace_path: &str,
    path: &str,
    max_bytes: usize,
) -> anyhow::Result<WorkspaceFileContent> {
    let root = PathBuf::from(workspace_path).canonicalize()?;
    let candidate = gyro_core::security::assert_path_inside_workspace(&root, Path::new(path))?;
    let metadata = std::fs::metadata(&candidate)?;

    if metadata.is_dir() {
        anyhow::bail!("workspace preview path is a directory");
    }

    let mut file = std::fs::File::open(&candidate)?;
    let mut bytes = Vec::with_capacity(max_bytes.min(metadata.len() as usize));
    Read::by_ref(&mut file)
        .take((max_bytes + 1) as u64)
        .read_to_end(&mut bytes)?;
    let truncated = bytes.len() > max_bytes;
    if truncated {
        bytes.truncate(max_bytes);
    }
    if bytes.contains(&0) {
        anyhow::bail!("binary workspace files cannot be previewed");
    }
    let content_hash = content_hash(&bytes);
    let content = String::from_utf8_lossy(&bytes).to_string();

    Ok(WorkspaceFileContent {
        path: path.to_string(),
        content,
        truncated,
        size_bytes: metadata.len(),
        content_hash,
    })
}

fn stat_workspace_file_impl(workspace_path: &str, path: &str) -> anyhow::Result<WorkspaceFileStat> {
    let root = PathBuf::from(workspace_path).canonicalize()?;
    let candidate = gyro_core::security::assert_path_inside_workspace(&root, Path::new(path))?;
    let metadata = std::fs::metadata(&candidate)?;
    let kind = if metadata.is_dir() {
        "directory"
    } else {
        "file"
    }
    .to_string();
    let content_hash =
        if metadata.is_file() && metadata.len() <= MAX_WORKSPACE_FILE_EDIT_BYTES as u64 {
            let bytes = std::fs::read(&candidate)?;
            if bytes.contains(&0) {
                None
            } else {
                Some(content_hash(&bytes))
            }
        } else {
            None
        };

    Ok(WorkspaceFileStat {
        path: path.to_string(),
        kind,
        size_bytes: metadata.len(),
        content_hash,
    })
}

fn write_workspace_file_impl(
    request: &WorkspaceFileWriteRequest,
) -> anyhow::Result<WorkspaceFileContent> {
    let root = PathBuf::from(&request.workspace_path).canonicalize()?;
    let candidate =
        gyro_core::security::assert_path_inside_workspace(&root, Path::new(&request.path))?;
    if candidate.is_dir() {
        anyhow::bail!("workspace write path is a directory");
    }
    let content_bytes = request.content.as_bytes();
    if content_bytes.len() > MAX_WORKSPACE_FILE_EDIT_BYTES {
        anyhow::bail!("workspace file is too large to edit in Gyro");
    }
    if content_bytes.contains(&0) {
        anyhow::bail!("binary workspace files cannot be edited");
    }
    if let Some(expected_hash) = request.expected_hash.as_deref() {
        let current = std::fs::read(&candidate)?;
        if current.contains(&0) {
            anyhow::bail!("binary workspace files cannot be edited");
        }
        let current_hash = content_hash(&current);
        if current_hash != expected_hash {
            anyhow::bail!("file changed on disk; reload before saving");
        }
    }

    std::fs::write(&candidate, content_bytes)?;
    read_workspace_file_with_limit(
        &request.workspace_path,
        &request.path,
        MAX_WORKSPACE_FILE_EDIT_BYTES,
    )
}

fn workspace_root(workspace_path: &str) -> anyhow::Result<PathBuf> {
    PathBuf::from(workspace_path)
        .canonicalize()
        .map_err(anyhow::Error::from)
}

fn assert_workspace_path(root: &Path, path: &str) -> anyhow::Result<PathBuf> {
    gyro_core::security::assert_path_inside_workspace(root, Path::new(path))
}

fn create_workspace_path_impl(
    request: &WorkspacePathCreateRequest,
) -> anyhow::Result<WorkspaceFileStat> {
    let root = workspace_root(&request.workspace_path)?;
    let candidate = assert_workspace_path(&root, &request.path)?;
    if candidate.exists() {
        anyhow::bail!("workspace path already exists");
    }
    match request.kind.as_str() {
        "directory" => std::fs::create_dir_all(&candidate)?,
        "file" => {
            if let Some(parent) = candidate.parent() {
                if !parent.starts_with(&root) {
                    anyhow::bail!("workspace file parent is outside workspace");
                }
                std::fs::create_dir_all(parent)?;
            }
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&candidate)?;
        }
        _ => anyhow::bail!("workspace path kind must be file or directory"),
    }
    stat_workspace_file_impl(&request.workspace_path, &request.path)
}

fn rename_workspace_path_impl(
    request: &WorkspacePathRenameRequest,
) -> anyhow::Result<WorkspaceFileStat> {
    let root = workspace_root(&request.workspace_path)?;
    let from = assert_workspace_path(&root, &request.from_path)?;
    let to = assert_workspace_path(&root, &request.to_path)?;
    if !from.exists() {
        anyhow::bail!("workspace path does not exist");
    }
    if to.exists() {
        anyhow::bail!("target workspace path already exists");
    }
    if let Some(parent) = to.parent() {
        if !parent.starts_with(&root) {
            anyhow::bail!("target parent is outside workspace");
        }
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(from, to)?;
    stat_workspace_file_impl(&request.workspace_path, &request.to_path)
}

fn delete_workspace_path_impl(request: &WorkspacePathDeleteRequest) -> anyhow::Result<bool> {
    let root = workspace_root(&request.workspace_path)?;
    let candidate = assert_workspace_path(&root, &request.path)?;
    if !candidate.exists() {
        anyhow::bail!("workspace path does not exist");
    }
    let metadata = std::fs::metadata(&candidate)?;
    if metadata.is_file() {
        if let Some(expected_hash) = request.expected_hash.as_deref() {
            let bytes = std::fs::read(&candidate)?;
            if bytes.contains(&0) {
                anyhow::bail!("binary workspace files cannot be deleted through hash approval");
            }
            let current_hash = content_hash(&bytes);
            if current_hash != expected_hash {
                anyhow::bail!("file changed on disk; reload before deleting");
            }
        }
        std::fs::remove_file(candidate)?;
        return Ok(true);
    }
    std::fs::remove_dir(candidate)?;
    Ok(true)
}

fn search_workspace_impl(
    request: &WorkspaceSearchRequest,
) -> anyhow::Result<Vec<WorkspaceSearchResult>> {
    let root = workspace_root(&request.workspace_path)?;
    let query = request.query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let max_results = request.max_results.unwrap_or(200).clamp(1, 1000);
    let mut command = command_with_gui_path("rg");
    command
        .current_dir(&root)
        .arg("--line-number")
        .arg("--column")
        .arg("--no-heading")
        .arg("--color")
        .arg("never")
        .arg("--fixed-strings");
    if let Some(globs) = request.globs.as_ref() {
        for glob in globs {
            command.arg("--glob").arg(glob);
        }
    }
    command.arg(query).arg(".");

    match command.output() {
        Ok(output) if output.status.success() || output.status.code() == Some(1) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            Ok(parse_rg_output(&stdout, query, max_results))
        }
        Ok(_) | Err(_) => fallback_search_workspace(&root, query, max_results),
    }
}

fn parse_rg_output(output: &str, query: &str, max_results: usize) -> Vec<WorkspaceSearchResult> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(4, ':');
            let path = parts.next()?.trim_start_matches("./").to_string();
            let line_number = parts.next()?.parse::<usize>().ok()?;
            let start_column = parts.next()?.parse::<usize>().ok()?;
            let text = parts.next().unwrap_or_default().to_string();
            let end_column = start_column + query.chars().count().max(1);
            Some(WorkspaceSearchResult {
                path,
                line_number,
                line: text,
                ranges: vec![WorkspaceSearchRange {
                    start_column,
                    end_column,
                }],
            })
        })
        .take(max_results)
        .collect()
}

fn fallback_search_workspace(
    root: &Path,
    query: &str,
    max_results: usize,
) -> anyhow::Result<Vec<WorkspaceSearchResult>> {
    let mut results = Vec::new();
    for entry in WalkDir::new(root)
        .min_depth(1)
        .max_depth(8)
        .into_iter()
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            !matches!(
                name.as_ref(),
                ".git" | ".next" | "node_modules" | "target" | "dist" | "build"
            )
        })
    {
        let entry = entry?;
        if !entry.file_type().is_file() {
            continue;
        }
        let metadata = entry.metadata()?;
        if metadata.len() > MAX_WORKSPACE_FILE_PREVIEW_BYTES as u64 {
            continue;
        }
        let bytes = std::fs::read(entry.path())?;
        if bytes.contains(&0) {
            continue;
        }
        let content = String::from_utf8_lossy(&bytes);
        for (index, line) in content.lines().enumerate() {
            if let Some(offset) = line.find(query) {
                let path = entry
                    .path()
                    .strip_prefix(root)?
                    .to_string_lossy()
                    .to_string();
                results.push(WorkspaceSearchResult {
                    path,
                    line_number: index + 1,
                    line: line.to_string(),
                    ranges: vec![WorkspaceSearchRange {
                        start_column: offset + 1,
                        end_column: offset + query.len() + 1,
                    }],
                });
                if results.len() >= max_results {
                    return Ok(results);
                }
            }
        }
    }
    Ok(results)
}

fn git_status_impl(workspace_path: &str) -> anyhow::Result<SourceControlStatus> {
    let root = workspace_root(workspace_path)?;
    let mut command = command_with_gui_path("git");
    command
        .arg("-C")
        .arg(root)
        .arg("status")
        .arg("--porcelain=v2")
        .arg("--branch");
    let output = match command.output() {
        Ok(output) => output,
        Err(error) => {
            return Ok(SourceControlStatus {
                provider: "git".into(),
                available: false,
                branch: None,
                upstream: None,
                ahead: 0,
                behind: 0,
                files: Vec::new(),
                last_checked_at: None,
                error: Some(error.to_string()),
            });
        }
    };
    if !output.status.success() {
        return Ok(SourceControlStatus {
            provider: "git".into(),
            available: false,
            branch: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            files: Vec::new(),
            last_checked_at: None,
            error: Some(String::from_utf8_lossy(&output.stderr).to_string()),
        });
    }
    Ok(parse_git_status_v2(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

fn parse_git_status_v2(output: &str) -> SourceControlStatus {
    let mut status = SourceControlStatus {
        provider: "git".into(),
        available: true,
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        files: Vec::new(),
        last_checked_at: None,
        error: None,
    };

    for line in output.lines() {
        if let Some(branch) = line.strip_prefix("# branch.head ") {
            status.branch = Some(branch.to_string());
        } else if let Some(upstream) = line.strip_prefix("# branch.upstream ") {
            status.upstream = Some(upstream.to_string());
        } else if let Some(ab) = line.strip_prefix("# branch.ab ") {
            for part in ab.split_whitespace() {
                if let Some(value) = part.strip_prefix('+') {
                    status.ahead = value.parse().unwrap_or(0);
                } else if let Some(value) = part.strip_prefix('-') {
                    status.behind = value.parse().unwrap_or(0);
                }
            }
        } else if let Some(path) = line.strip_prefix("? ") {
            status.files.push(SourceControlFile {
                path: path.to_string(),
                original_path: None,
                state: "untracked".into(),
                staged: false,
            });
        } else if line.starts_with("1 ") {
            let mut parts = line.split_whitespace();
            let _record = parts.next();
            let xy = parts.next().unwrap_or("..");
            let path = parts.nth(6).unwrap_or_default().to_string();
            status.files.push(SourceControlFile {
                path,
                original_path: None,
                state: git_state_from_xy(xy),
                staged: xy.chars().next().is_some_and(|value| value != '.'),
            });
        } else if line.starts_with("2 ") {
            let mut parts = line.split_whitespace();
            let _record = parts.next();
            let xy = parts.next().unwrap_or("..");
            let _sub = parts.next();
            let _modes_and_hashes = (0..5).for_each(|_| {
                let _ = parts.next();
            });
            let _score = parts.next();
            let rest = parts.collect::<Vec<_>>().join(" ");
            let mut paths = rest.split('\t');
            let path = paths.next().unwrap_or_default().to_string();
            let original_path = paths.next().map(ToOwned::to_owned);
            status.files.push(SourceControlFile {
                path,
                original_path,
                state: "renamed".into(),
                staged: xy.chars().next().is_some_and(|value| value != '.'),
            });
        } else if line.starts_with("u ") {
            let path = line
                .split_whitespace()
                .last()
                .unwrap_or_default()
                .to_string();
            status.files.push(SourceControlFile {
                path,
                original_path: None,
                state: "conflicted".into(),
                staged: false,
            });
        }
    }
    status
}

fn git_state_from_xy(xy: &str) -> String {
    if xy.contains('D') {
        "deleted"
    } else if xy.contains('A') {
        "added"
    } else if xy.contains('R') {
        "renamed"
    } else if xy.contains('U') {
        "conflicted"
    } else {
        "modified"
    }
    .into()
}

fn task_discover_impl(workspace_path: &str) -> anyhow::Result<Vec<TaskDefinitionResult>> {
    let root = workspace_root(workspace_path)?;
    let mut tasks = Vec::new();
    let package_json = root.join("package.json");
    if package_json.exists() {
        let package = std::fs::read_to_string(&package_json)?;
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&package) {
            if let Some(scripts) = value.get("scripts").and_then(|value| value.as_object()) {
                let runner = if root.join("pnpm-lock.yaml").exists() {
                    "pnpm"
                } else {
                    "npm"
                };
                for name in scripts.keys() {
                    let group = if name.contains("test") {
                        "test"
                    } else if name.contains("build") {
                        "build"
                    } else if name.contains("dev") || name.contains("start") {
                        "dev"
                    } else {
                        "custom"
                    };
                    tasks.push(TaskDefinitionResult {
                        id: format!("package:{name}"),
                        label: format!("{runner} {name}"),
                        command: runner.into(),
                        args: vec!["run".into(), name.to_string()],
                        group: group.into(),
                        cwd: None,
                        status: "idle".into(),
                        output_channel_id: Some(format!("task-package-{name}")),
                    });
                }
            }
        }
    }
    if root.join("Cargo.toml").exists() {
        tasks.push(TaskDefinitionResult {
            id: "cargo:build".into(),
            label: "cargo build".into(),
            command: "cargo".into(),
            args: vec!["build".into()],
            group: "build".into(),
            cwd: None,
            status: "idle".into(),
            output_channel_id: Some("task-cargo-build".into()),
        });
        tasks.push(TaskDefinitionResult {
            id: "cargo:test".into(),
            label: "cargo test".into(),
            command: "cargo".into(),
            args: vec!["test".into()],
            group: "test".into(),
            cwd: None,
            status: "idle".into(),
            output_channel_id: Some("task-cargo-test".into()),
        });
    }
    Ok(tasks)
}

fn test_discover_impl(workspace_path: &str) -> anyhow::Result<Vec<TestTreeItemResult>> {
    let tasks = task_discover_impl(workspace_path)?;
    let children = tasks
        .into_iter()
        .filter(|task| task.group == "test")
        .map(|task| TestTreeItemResult {
            id: task.id,
            label: task.label,
            path: None,
            status: "unknown".into(),
            children: Vec::new(),
        })
        .collect::<Vec<_>>();
    Ok(vec![TestTreeItemResult {
        id: "workspace-tests".into(),
        label: "Workspace tests".into(),
        path: None,
        status: "unknown".into(),
        children,
    }])
}

fn run_command_output(mut command: Command) -> anyhow::Result<IdeCommandOutput> {
    let output = command.output()?;
    let stdout = gyro_core::security::redact_secrets(&String::from_utf8_lossy(&output.stdout));
    let stderr = gyro_core::security::redact_secrets(&String::from_utf8_lossy(&output.stderr));
    Ok(IdeCommandOutput {
        status: if output.status.success() {
            "done".into()
        } else {
            "failed".into()
        },
        stdout,
        stderr,
    })
}

fn content_hash(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
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

#[tauri::command]
fn check_provider_health(request: ProviderHealthRequest) -> Result<ProviderHealthCheck, String> {
    ProviderHealthService::default()
        .check(request)
        .map_err(to_string)
}

#[tauri::command]
fn check_provider_auth(provider_id: String) -> Result<ProviderHealthCheck, String> {
    check_provider_health(ProviderHealthRequest {
        provider_id,
        api_key_ref: None,
        base_url: None,
    })
}

#[derive(Default)]
struct ProviderHealthService;

impl ProviderHealthService {
    fn check(&self, request: ProviderHealthRequest) -> anyhow::Result<ProviderHealthCheck> {
        match request.provider_id.as_str() {
            "openai" => self.check_openai(request),
            "anthropic" => self.cli_check(
                "anthropic",
                "provider-cli",
                "claude",
                &["auth", "status"],
                Some("claude auth login"),
                "Provider CLI, OS Keychain, or provider-owned files",
            ),
            "cursor" => self.cli_check(
                "cursor",
                "provider-cli",
                "cursor-agent",
                &["login", "status"],
                Some("cursor-agent login"),
                "Provider CLI, OS Keychain, or provider-owned files",
            ),
            "xai" => Ok(env_provider_health(
                "xai",
                request.api_key_ref.as_deref(),
                &["XAI_API_KEY"],
            )),
            "gemini" => Ok(env_provider_health(
                "gemini",
                request.api_key_ref.as_deref(),
                &[
                    "GEMINI_API_KEY",
                    "GOOGLE_API_KEY",
                    "GOOGLE_APPLICATION_CREDENTIALS",
                ],
            )),
            "opencode" => self.cli_check(
                "opencode",
                "provider-cli",
                "opencode",
                &["auth", "status"],
                Some("opencode auth login"),
                "Provider CLI, OS Keychain, or provider-owned files",
            ),
            _ => anyhow::bail!("unknown provider `{}`", request.provider_id),
        }
    }

    fn check_openai(&self, request: ProviderHealthRequest) -> anyhow::Result<ProviderHealthCheck> {
        if should_skip_codex_login_for_external_env(
            request.base_url.as_deref(),
            request.api_key_ref.as_deref(),
        ) {
            return Ok(env_provider_health(
                "openai",
                request.api_key_ref.as_deref(),
                &["OPENAI_API_KEY"],
            ));
        }

        self.cli_check(
            "openai",
            "provider-cli",
            "codex",
            &["login", "status"],
            Some("codex login --device-auth"),
            "Provider CLI, OS Keychain, or provider-owned files",
        )
    }

    fn cli_check(
        &self,
        provider_id: &str,
        auth_owner: &str,
        command: &str,
        args: &[&str],
        login_command: Option<&str>,
        secret_storage: &str,
    ) -> anyhow::Result<ProviderHealthCheck> {
        let auth_command = std::iter::once(command)
            .chain(args.iter().copied())
            .collect::<Vec<_>>()
            .join(" ");
        let output = match command_output(command, args) {
            Ok(output) => output,
            Err(error) => format!("{command} not installed or unavailable: {error}"),
        };
        let output = gyro_core::security::redact_secrets(&output);
        Ok(ProviderHealthCheck {
            provider_id: provider_id.into(),
            runtime_status: provider_runtime_status_from_output(&output).into(),
            auth_owner: auth_owner.into(),
            auth_command: Some(auth_command),
            login_command: login_command.map(str::to_string),
            account_label: provider_account_label(&output),
            subscription_label: provider_subscription_label(&output),
            provider_mode: provider_mode_label(&output),
            secret_storage: secret_storage.into(),
            privacy_note:
                "Gyro stores readiness summaries only; provider tokens stay outside Gyro.".into(),
            diagnostics_opt_in: false,
            output,
        })
    }
}

fn spawn_terminal_process(request: TerminalPaneRequest) -> anyhow::Result<TerminalProcess> {
    if request.command.trim().is_empty() {
        anyhow::bail!("terminal command cannot be empty");
    }

    let cwd = resolve_terminal_cwd(&request)?;
    let cols = request.cols.unwrap_or(120);
    let rows = request.rows.unwrap_or(32);
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    let mut command = CommandBuilder::new(&request.command);
    command.args(request.args.iter().map(String::as_str));
    if let Some(cwd) = cwd {
        command.cwd(cwd);
    }
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "Gyro");
    command.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    if !request.command.contains('/') {
        command.env("PATH", augmented_gui_path());
    }

    let child = pair.slave.spawn_command(command)?;
    let output = Arc::new(Mutex::new(Vec::new()));
    let reader = pair.master.try_clone_reader()?;
    let writer = pair.master.take_writer()?;
    spawn_terminal_reader(reader, Arc::clone(&output));
    drop(pair.slave);

    Ok(TerminalProcess {
        request,
        master: pair.master,
        writer,
        child,
        output,
        status: "running".into(),
        exit_code: None,
        cols,
        rows,
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

fn should_skip_codex_login_for_external_env(
    base_url: Option<&str>,
    api_key_ref: Option<&str>,
) -> bool {
    let base_url = base_url.unwrap_or_default().trim().to_ascii_lowercase();
    let api_key_ref = api_key_ref.unwrap_or_default().trim().to_ascii_lowercase();
    let external_base_url = !base_url.is_empty()
        && !base_url.contains("api.openai.com")
        && !base_url.contains("chatgpt.com");
    let env_owned_key = api_key_ref.starts_with("provider-env:")
        || api_key_ref.starts_with("env:")
        || api_key_ref.ends_with("_api_key")
        || api_key_ref.contains("api_key");

    external_base_url && env_owned_key
}

fn env_provider_health(
    provider_id: &str,
    api_key_ref: Option<&str>,
    fallback_env_names: &[&str],
) -> ProviderHealthCheck {
    let mut env_names = Vec::new();
    if let Some(env_name) = env_name_from_ref(api_key_ref) {
        env_names.push(env_name);
    }
    for env_name in fallback_env_names {
        if !env_names.iter().any(|candidate| candidate == env_name) {
            env_names.push((*env_name).to_string());
        }
    }

    let present_env = env_names
        .iter()
        .find(|env_name| std::env::var_os(env_name.as_str()).is_some())
        .cloned();
    let output = if let Some(env_name) = present_env.as_deref() {
        format!(
            "{provider_id} provider-env auth available; {env_name} is set; value not read by Gyro."
        )
    } else {
        format!(
            "{provider_id} provider-env auth missing; configure one of {} outside Gyro.",
            env_names.join(", ")
        )
    };

    ProviderHealthCheck {
        provider_id: provider_id.into(),
        runtime_status: if present_env.is_some() {
            "ready".into()
        } else {
            "not-logged-in".into()
        },
        auth_owner: "provider-env".into(),
        auth_command: None,
        login_command: None,
        account_label: None,
        subscription_label: None,
        provider_mode: Some("environment-owned auth".into()),
        secret_storage: "Environment variable or provider SDK store".into(),
        privacy_note: "Gyro stores readiness summaries only; provider tokens stay outside Gyro."
            .into(),
        diagnostics_opt_in: false,
        output,
    }
}

fn env_name_from_ref(api_key_ref: Option<&str>) -> Option<String> {
    let reference = api_key_ref?.trim();
    let candidate = reference
        .strip_prefix("provider-env:")
        .or_else(|| reference.strip_prefix("env:"))
        .unwrap_or(reference)
        .trim();
    if candidate.is_empty() || candidate.contains(':') || candidate.contains('/') {
        None
    } else {
        Some(candidate.to_string())
    }
}

fn provider_runtime_status_from_output(output: &str) -> &'static str {
    let normalized = output.to_ascii_lowercase();
    if normalized.contains("not installed")
        || normalized.contains("command not found")
        || normalized.contains("no such file")
    {
        "not-installed"
    } else if normalized.contains("not authenticated")
        || normalized.contains("not logged in")
        || normalized.contains("logged out")
        || normalized.contains("\"loggedin\": false")
        || normalized.contains("auth required")
    {
        "not-logged-in"
    } else if normalized.contains("authenticated")
        || normalized.contains("logged in")
        || normalized.contains("\"loggedin\": true")
        || normalized.contains("ready")
        || normalized.contains("ok")
    {
        "ready"
    } else if normalized.contains("error")
        || normalized.contains("failed")
        || normalized.contains("invalid")
        || normalized.contains("denied")
    {
        "warning"
    } else {
        "unknown"
    }
}

fn provider_subscription_label(output: &str) -> Option<String> {
    quoted_field(output, "subscriptionType")
        .or_else(|| quoted_field(output, "subscriptionTier"))
        .or_else(|| quoted_field(output, "subscription"))
}

fn provider_account_label(output: &str) -> Option<String> {
    quoted_field(output, "email")
        .or_else(|| quoted_field(output, "account"))
        .or_else(|| quoted_field(output, "user"))
}

fn provider_mode_label(output: &str) -> Option<String> {
    quoted_field(output, "mode").or_else(|| quoted_field(output, "authMode"))
}

fn quoted_field(output: &str, field: &str) -> Option<String> {
    let marker = format!("\"{field}\"");
    let start = output.find(&marker)?;
    let after_marker = &output[start + marker.len()..];
    let colon = after_marker.find(':')?;
    let after_colon = after_marker[colon + 1..].trim_start();
    let after_quote = after_colon.strip_prefix('"')?;
    let end = after_quote.find('"')?;
    Some(after_quote[..end].to_string())
}

fn command_output(command: &str, args: &[&str]) -> Result<String, String> {
    let output = command_with_gui_path(command)
        .args(args)
        .output()
        .map_err(to_string)?;
    let mut combined = String::new();
    combined.push_str(&String::from_utf8_lossy(&output.stdout));
    combined.push_str(&String::from_utf8_lossy(&output.stderr));
    let combined = combined.trim().to_string();

    if output.status.success() {
        Ok(combined)
    } else if combined.is_empty() {
        Err(format!("{command} exited with {}", output.status))
    } else {
        Ok(combined)
    }
}

fn run_openai_codex_chat(request: &ProviderChatRequest) -> anyhow::Result<String> {
    let output_path =
        std::env::temp_dir().join(format!("gyro-codex-response-{}.txt", Uuid::new_v4()));
    let cwd = provider_chat_cwd(request.workspace_path.as_deref())?;
    let prompt = openai_codex_chat_prompt(&request.message, request.workspace_path.as_deref());

    let mut process = command_with_gui_path("codex");
    process
        .arg("exec")
        .arg("--cd")
        .arg(cwd)
        .arg("--skip-git-repo-check")
        .arg("--sandbox")
        .arg("read-only")
        .arg("--output-last-message")
        .arg(&output_path);
    if let Some(model) = codex_model_arg(request.model_id.as_deref()) {
        process.arg("--model").arg(model);
    }
    process.arg(prompt);

    let output = process.output().map_err(|error| {
        anyhow::anyhow!(
            "Could not start OpenAI through Codex CLI. Run `codex login` in Terminal, then try again. {error}"
        )
    })?;
    let last_message = fs::read_to_string(&output_path).unwrap_or_default();
    let _ = fs::remove_file(&output_path);
    if output.status.success() {
        let response = last_message.trim();
        if !response.is_empty() {
            return Ok(response.to_string());
        }
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !stdout.is_empty() {
            return Ok(stdout);
        }
        anyhow::bail!("OpenAI finished, but Codex did not return a chat response.");
    }

    let mut combined = String::new();
    combined.push_str(&String::from_utf8_lossy(&output.stdout));
    combined.push_str(&String::from_utf8_lossy(&output.stderr));
    let combined = gyro_core::security::redact_secrets(combined.trim());
    if combined.is_empty() {
        anyhow::bail!("OpenAI through Codex exited with {}", output.status);
    }
    anyhow::bail!("{}", truncate_error_detail(&combined));
}

fn provider_chat_cwd(workspace_path: Option<&str>) -> anyhow::Result<PathBuf> {
    if let Some(path) = workspace_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        let path = PathBuf::from(path);
        if path.exists() {
            return Ok(path.canonicalize()?);
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        return Ok(PathBuf::from(home));
    }
    std::env::current_dir().map_err(Into::into)
}

fn openai_codex_chat_prompt(message: &str, workspace_path: Option<&str>) -> String {
    let workspace = workspace_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .unwrap_or("no selected workspace");
    format!(
        "Answer as Gyro's chat model.\n\
         Keep replies concise by default: 1-3 short sentences unless the user asks for detail.\n\
         Do not describe the local Codex runner, authentication, system prompts, or implementation details unless asked.\n\
         If the user asks what model you are, answer with the model label only.\n\
         Use the selected workspace only as optional context.\n\
         Do not edit files, start servers, commit, push, or make destructive changes in this chat run.\n\
         Selected workspace: {workspace}\n\n\
         User message:\n{message}"
    )
}

fn codex_model_arg(model_id: Option<&str>) -> Option<String> {
    let model = model_id?.trim();
    if model.is_empty() {
        return None;
    }
    let normalized = model.to_ascii_lowercase();
    if matches!(
        normalized.as_str(),
        "gpt-5.5" | "gpt-5.4" | "gpt-5.4-mini" | "gpt-5"
    ) {
        return None;
    }
    Some(model.to_string())
}

fn append_provider_status_event(
    store: &SessionStore,
    session_id: Uuid,
    request: &ProviderChatRequest,
    turn_id: Option<Uuid>,
    status: &str,
    error: Option<&str>,
) -> anyhow::Result<SessionEvent> {
    let provider_label = request.provider_label.as_deref().unwrap_or("OpenAI");
    store.append_event_with_turn_id(
        session_id,
        SessionEventKind::SystemEvent,
        provider_chat_status_message(status, provider_label),
        serde_json::json!({
            "kind": "provider-status",
            "status": status,
            "error": error,
            "turnId": turn_id.map(|id| id.to_string()),
            "userMessage": request.message.as_str(),
            "providerId": request.provider_id.as_str(),
            "providerLabel": provider_label,
            "modelId": request.model_id.as_deref(),
            "modelLabel": request.model_label.as_deref(),
            "runner": "codex-cli",
            "authOwner": "chatgpt-local-codex-login",
        }),
        turn_id,
    )
}

fn provider_chat_status_message(status: &str, provider_label: &str) -> String {
    match status {
        "failed" => format!("{provider_label} send needs attention"),
        "ready" => format!("{provider_label} answered"),
        "running" => format!("{provider_label} is working"),
        _ => format!("{provider_label} queued this request"),
    }
}

fn truncate_error_detail(value: &str) -> String {
    const MAX_ERROR_DETAIL_CHARS: usize = 4_000;
    if value.chars().count() <= MAX_ERROR_DETAIL_CHARS {
        return value.to_string();
    }
    value
        .chars()
        .take(MAX_ERROR_DETAIL_CHARS)
        .collect::<String>()
        + "…"
}

fn command_with_gui_path(command: &str) -> Command {
    let mut process = Command::new(command);
    if !command.contains('/') {
        process.env("PATH", augmented_gui_path());
    }
    process
}

fn augmented_gui_path() -> String {
    let mut paths: Vec<String> = std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .filter(|path| !path.is_empty())
        .map(ToOwned::to_owned)
        .collect();
    if let Ok(home) = std::env::var("HOME") {
        paths.push(format!("{home}/.local/bin"));
        paths.push(format!("{home}/bin"));
    }
    paths.extend(GUI_CLI_PATHS.iter().map(|path| (*path).to_string()));
    paths.dedup();
    paths.join(":")
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
            process.exit_code = Some(status.exit_code() as i32);
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
            append_editor_event,
            append_plan_event,
            append_user_message,
            claim_due_automation,
            check_provider_auth,
            check_provider_health,
            complete_automation_lease,
            create_automation,
            create_desktop_session,
            create_terminal_pane,
            create_workspace_file,
            create_worktree_session,
            debug_send,
            debug_start,
            debug_stop,
            delete_session,
            delete_workspace_path,
            get_account_session,
            git_commit,
            git_diff,
            git_stage,
            git_status,
            git_unstage,
            list_automations,
            list_due_automations,
            list_sessions,
            list_workspace_files,
            list_workspace_tree,
            load_config,
            logout_account,
            lsp_request,
            lsp_start,
            lsp_stop,
            read_workspace_file,
            read_workspace_file_full,
            read_terminal_output,
            read_session_events,
            recover_automation_leases,
            rename_session,
            rename_workspace_path,
            refresh_account_session,
            resize_terminal_pane,
            restart_terminal_pane,
            restore_terminal_panes,
            run_automation,
            run_provider_chat,
            save_config,
            search_workspace,
            set_session_model,
            set_automation_status,
            stat_workspace_file,
            start_account_login,
            stop_terminal_pane,
            task_discover,
            task_run,
            test_discover,
            test_run,
            triage_automation,
            watch_workspace,
            write_workspace_file,
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
    fn writes_text_file_inside_workspace_with_expected_hash() {
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("app.ts"), "old\n").unwrap();
        let content =
            read_workspace_file_full(workspace.path().to_str().unwrap().into(), "app.ts".into())
                .unwrap();

        let saved = write_workspace_file_impl(&WorkspaceFileWriteRequest {
            workspace_path: workspace.path().to_str().unwrap().into(),
            path: "app.ts".into(),
            content: "new\n".into(),
            expected_hash: Some(content.content_hash),
        })
        .unwrap();

        assert_eq!(saved.content, "new\n");
        assert_eq!(
            std::fs::read_to_string(workspace.path().join("app.ts")).unwrap(),
            "new\n"
        );
    }

    #[test]
    fn rejects_write_outside_workspace() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();

        let error = write_workspace_file_impl(&WorkspaceFileWriteRequest {
            workspace_path: workspace.path().to_str().unwrap().into(),
            path: outside.path().to_str().unwrap().into(),
            content: "nope\n".into(),
            expected_hash: None,
        })
        .unwrap_err();

        assert!(error.to_string().contains("outside workspace"));
    }

    #[test]
    fn rejects_binary_write_content() {
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("bin.txt"), "old\n").unwrap();

        let error = write_workspace_file_impl(&WorkspaceFileWriteRequest {
            workspace_path: workspace.path().to_str().unwrap().into(),
            path: "bin.txt".into(),
            content: "bad\0content".into(),
            expected_hash: None,
        })
        .unwrap_err();

        assert!(error.to_string().contains("binary workspace files"));
    }

    #[test]
    fn rejects_oversized_write_content() {
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("large.txt"), "old\n").unwrap();

        let error = write_workspace_file_impl(&WorkspaceFileWriteRequest {
            workspace_path: workspace.path().to_str().unwrap().into(),
            path: "large.txt".into(),
            content: "a".repeat(MAX_WORKSPACE_FILE_EDIT_BYTES + 1),
            expected_hash: None,
        })
        .unwrap_err();

        assert!(error.to_string().contains("too large"));
    }

    #[test]
    fn rejects_stale_expected_hash() {
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("app.ts"), "old\n").unwrap();
        let content =
            read_workspace_file_full(workspace.path().to_str().unwrap().into(), "app.ts".into())
                .unwrap();
        std::fs::write(workspace.path().join("app.ts"), "external\n").unwrap();

        let error = write_workspace_file_impl(&WorkspaceFileWriteRequest {
            workspace_path: workspace.path().to_str().unwrap().into(),
            path: "app.ts".into(),
            content: "new\n".into(),
            expected_hash: Some(content.content_hash),
        })
        .unwrap_err();

        assert!(error.to_string().contains("changed on disk"));
    }

    #[test]
    fn provider_health_skips_codex_login_for_external_env_auth() {
        assert!(should_skip_codex_login_for_external_env(
            Some("https://gateway.example.test/v1"),
            Some("provider-env:PORTKEY_API_KEY"),
        ));
        assert!(!should_skip_codex_login_for_external_env(
            Some("https://api.openai.com/v1"),
            Some("provider-cli:codex"),
        ));
    }

    #[test]
    fn codex_chat_omits_seeded_display_models() {
        assert_eq!(codex_model_arg(Some("gpt-5.5")), None);
        assert_eq!(codex_model_arg(Some(" gpt-5.4-mini ")), None);
        assert_eq!(codex_model_arg(Some("o4-mini")), Some("o4-mini".into()));
    }

    #[test]
    fn codex_chat_prompt_prefers_concise_answers() {
        let prompt = openai_codex_chat_prompt("WHAT MODEL are you?", Some("/workspace"));

        assert!(prompt.contains("Keep replies concise by default"));
        assert!(prompt.contains("answer with the model label only"));
        assert!(prompt.contains("Do not describe the local Codex runner"));
        assert!(prompt.contains("Selected workspace: /workspace"));
    }

    #[test]
    fn provider_status_event_stores_run_metadata_without_tokens() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "chat session")
            .unwrap();
        let turn_id = Uuid::new_v4();
        let request = ProviderChatRequest {
            session_id: session.id.to_string(),
            message: "hello".into(),
            turn_id: Some(turn_id.to_string()),
            provider_id: "openai".into(),
            provider_label: Some("OpenAI".into()),
            model_id: Some("gpt-5.5".into()),
            model_label: Some("GPT-5.5".into()),
            workspace_path: Some(temp.path().display().to_string()),
        };

        let event = append_provider_status_event(
            &store,
            session.id,
            &request,
            Some(turn_id),
            "ready",
            None,
        )
        .unwrap();

        assert_eq!(event.kind, SessionEventKind::SystemEvent);
        assert_eq!(event.turn_id, Some(turn_id));
        assert_eq!(event.payload["kind"], "provider-status");
        assert_eq!(event.payload["runner"], "codex-cli");
        assert_eq!(event.payload["authOwner"], "chatgpt-local-codex-login");
        assert!(event.payload.get("token").is_none());
    }

    #[test]
    fn provider_health_redacts_secret_output() {
        let redacted = gyro_core::security::redact_secrets(
            "authorization: bearer sk-abcdefghijklmnopqrstuvwxyz123456",
        );

        assert!(redacted.contains("[REDACTED]"));
        assert!(!redacted.contains("abcdefghijklmnopqrstuvwxyz"));
    }

    #[test]
    fn provider_health_parses_runtime_metadata_without_tokens() {
        let output = r#"{"loggedIn":true,"email":"dev@example.test","subscriptionType":"max","token":"sk-abcdefghijklmnopqrstuvwxyz123456"}"#;
        let redacted = gyro_core::security::redact_secrets(output);

        assert_eq!(provider_runtime_status_from_output(&redacted), "ready");
        assert_eq!(
            provider_subscription_label(&redacted).as_deref(),
            Some("max")
        );
        assert_eq!(
            provider_account_label(&redacted).as_deref(),
            Some("dev@example.test")
        );
        assert!(!redacted.contains("abcdefghijklmnopqrstuvwxyz"));
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
                cols: None,
                rows: None,
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
                cols: None,
                rows: None,
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
    fn terminal_manager_uses_real_terminal_environment() {
        let manager = TerminalProcessManager::default();
        manager
            .create(TerminalPaneRequest {
                pane_id: "pane-env".into(),
                title: "Shell".into(),
                command: "sh".into(),
                args: vec![
                    "-c".into(),
                    "printf '%s %s %s' \"$TERM\" \"$COLORTERM\" \"$TERM_PROGRAM\"".into(),
                ],
                workspace_path: None,
                working_directory: None,
                cols: None,
                rows: None,
            })
            .unwrap();

        let snapshot = wait_for_terminal_output(&manager, "pane-env", "xterm-256color");
        assert!(snapshot.output.contains("xterm-256color truecolor Gyro"));
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
                cols: None,
                rows: None,
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
