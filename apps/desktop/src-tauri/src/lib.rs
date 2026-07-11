use gyro_core::{
    create_worktree, ipc::AppNotification, logout_account as account_logout,
    refresh_account_session as account_refresh_session, start_account_login as account_start_login,
    stored_account_session as account_stored_session, AccountSessionState, AppNotificationKind,
    Automation, AutomationStatus, AutomationStore, AutomationTriageState, CreateAutomationRequest,
    CreateSessionContext, GyroConfig, GyroPaths, HarnessRunStatus, ProviderDiagnosticsPayload,
    ProviderRunPayload, ProviderSessionBinding, Session, SessionEvent, SessionEventKind,
    SessionOrigin, SessionStore, SessionWorkspaceMode,
};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Emitter;
use uuid::Uuid;
use walkdir::WalkDir;

const MAX_WORKSPACE_FILE_PREVIEW_BYTES: usize = 256 * 1024;
const MAX_WORKSPACE_FILE_EDIT_BYTES: usize = 2 * 1024 * 1024;
const MAX_TERMINAL_OUTPUT_BYTES: usize = 512 * 1024;
const MAX_CHAT_MESSAGE_CHARS: usize = 24_000;
const MAX_CHAT_RESPONSE_CHARS: usize = 64_000;
const MAX_LSP_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_DESKTOP_SESSION_EVENTS_READ: usize = 400;
const CODEX_CHAT_TIMEOUT_SECS: u64 = 180;
const PROVIDER_CHAT_EVENT: &str = "gyro://provider-chat-event";
const PROVIDER_STREAM_FLUSH_INTERVAL: Duration = Duration::from_millis(80);
const TEXT_TRUNCATION_SUFFIX: &str = "...";
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
    additions: usize,
    deletions: usize,
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
    repo_root: Option<String>,
    additions: usize,
    deletions: usize,
    stats_partial: bool,
    files: Vec<SourceControlFile>,
    last_checked_at: Option<String>,
    error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitPathRequest {
    workspace_path: String,
    path: Option<String>,
    staged: Option<bool>,
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
    capabilities: Vec<String>,
}

#[derive(Clone, Default)]
struct TerminalProcessManager {
    processes: Arc<Mutex<HashMap<String, TerminalProcess>>>,
}

#[derive(Clone, Default)]
struct LanguageServerManager {
    processes: Arc<Mutex<HashMap<String, LanguageServerProcess>>>,
}

struct LanguageServerProcess {
    child: Child,
    stdin: ChildStdin,
    messages: mpsc::Receiver<Result<serde_json::Value, String>>,
    next_request_id: u64,
    language_id: String,
    command: String,
}

#[derive(Clone, Default)]
struct DebugAdapterManager {
    processes: Arc<Mutex<HashMap<String, DebugAdapterProcess>>>,
}

struct DebugAdapterProcess {
    child: Child,
    stdin: ChildStdin,
    messages: mpsc::Receiver<Result<serde_json::Value, String>>,
    next_sequence: u64,
    name: String,
    adapter: String,
}

impl Drop for LanguageServerProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for DebugAdapterProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalPaneRequest {
    pane_id: String,
    title: String,
    command: String,
    args: Vec<String>,
    workspace_path: Option<String>,
    workspace_mode: Option<String>,
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
    working_directory: Option<String>,
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
    reasoning_effort: Option<String>,
    #[serde(default)]
    suggest_title: bool,
    workspace_path: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderChatResponse {
    assistant_event: SessionEvent,
    session: Option<Session>,
    session_title: Option<String>,
    status_event: SessionEvent,
    resume_cursor: Option<ProviderResumeCursor>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderResumeCursor {
    kind: String,
    session_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderChatStreamEvent {
    session_id: String,
    turn_id: Option<String>,
    provider_id: String,
    model_id: Option<String>,
    event_id: String,
    phase: String,
    status: Option<String>,
    text_delta: Option<String>,
    message: Option<String>,
    error: Option<String>,
}

struct ProviderRunnerOutput {
    response: String,
    resume_cursor: Option<ProviderResumeCursor>,
    retry_count: u32,
    resumed: bool,
    output_summary: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProviderAdapterKind {
    OpenAiCodex,
    AnthropicClaude,
    ReadinessOnly,
}

#[derive(Clone, Copy, Debug)]
struct ProviderAdapterDescriptor {
    kind: ProviderAdapterKind,
    runner: &'static str,
    auth_owner: &'static str,
    timeout_seconds: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsExportBundle {
    schema: String,
    generated_at: String,
    config_summary: DiagnosticsConfigSummary,
    provider_health: Vec<ProviderHealthCheck>,
    recent_run_diagnostics: Vec<serde_json::Value>,
    sessions: Vec<DiagnosticsSessionSummary>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsConfigSummary {
    telemetry_enabled: bool,
    require_command_approval: bool,
    require_file_edit_approval: bool,
    provider_count: usize,
    enabled_provider_ids: Vec<String>,
    command_profile_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsSessionSummary {
    id: String,
    title: String,
    origin: String,
    workspace_mode: String,
    branch: String,
    provider_id: Option<String>,
    model_id: Option<String>,
    event_count: usize,
    updated_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsExportResult {
    path: String,
    bundle: DiagnosticsExportBundle,
}

struct TerminalProcess {
    request: TerminalPaneRequest,
    working_directory: Option<PathBuf>,
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
async fn list_sessions() -> Result<Vec<Session>, String> {
    tauri::async_runtime::spawn_blocking(list_sessions_blocking)
        .await
        .map_err(|error| format!("session list worker failed: {error}"))?
}

fn list_sessions_blocking() -> Result<Vec<Session>, String> {
    let store = open_store()?;
    store.list_sessions().map_err(to_string)
}

#[tauri::command]
async fn restart_app(app: tauri::AppHandle) -> Result<(), String> {
    app.restart()
}

#[tauri::command]
async fn create_desktop_session(
    workspace_path: String,
    title: String,
    provider_id: Option<String>,
    provider_label: Option<String>,
    model_id: Option<String>,
    model_label: Option<String>,
    reasoning_effort: Option<String>,
) -> Result<Session, String> {
    tauri::async_runtime::spawn_blocking(move || {
        create_desktop_session_blocking(
            workspace_path,
            title,
            provider_id,
            provider_label,
            model_id,
            model_label,
            reasoning_effort,
        )
    })
    .await
    .map_err(|error| format!("desktop session worker failed: {error}"))?
}

fn create_desktop_session_blocking(
    workspace_path: String,
    title: String,
    provider_id: Option<String>,
    provider_label: Option<String>,
    model_id: Option<String>,
    model_label: Option<String>,
    reasoning_effort: Option<String>,
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
                reasoning_effort,
                ..CreateSessionContext::default()
            },
        )
        .map_err(to_string)
}

#[tauri::command]
async fn create_worktree_session(
    workspace_path: String,
    title: String,
    branch: String,
    worktree_name: Option<String>,
    provider_id: Option<String>,
    provider_label: Option<String>,
    model_id: Option<String>,
    model_label: Option<String>,
    reasoning_effort: Option<String>,
) -> Result<Session, String> {
    tauri::async_runtime::spawn_blocking(move || {
        create_worktree_session_blocking(
            workspace_path,
            title,
            branch,
            worktree_name,
            provider_id,
            provider_label,
            model_id,
            model_label,
            reasoning_effort,
        )
    })
    .await
    .map_err(|error| format!("worktree session worker failed: {error}"))?
}

fn create_worktree_session_blocking(
    workspace_path: String,
    title: String,
    branch: String,
    worktree_name: Option<String>,
    provider_id: Option<String>,
    provider_label: Option<String>,
    model_id: Option<String>,
    model_label: Option<String>,
    reasoning_effort: Option<String>,
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
                reasoning_effort,
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
async fn set_session_model(
    session_id: String,
    provider_id: Option<String>,
    provider_label: Option<String>,
    model_id: Option<String>,
    model_label: Option<String>,
    reasoning_effort: Option<String>,
) -> Result<Session, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = open_store()?;
        let session_id = parse_uuid(&session_id)?;
        store
            .update_session_model(
                session_id,
                provider_id,
                provider_label,
                model_id,
                model_label,
                reasoning_effort,
            )
            .map_err(to_string)?
            .ok_or_else(|| "session not found".into())
    })
    .await
    .map_err(|error| format!("session model worker failed: {error}"))?
}

#[tauri::command]
async fn rename_session(session_id: String, title: String) -> Result<Session, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = open_store()?;
        let session_id = parse_uuid(&session_id)?;
        store
            .rename_session(session_id, title)
            .map_err(to_string)?
            .ok_or_else(|| "session not found".into())
    })
    .await
    .map_err(|error| format!("session rename worker failed: {error}"))?
}

#[tauri::command]
async fn delete_session(session_id: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || delete_session_blocking(session_id))
        .await
        .map_err(|error| format!("session delete worker failed: {error}"))?
}

fn delete_session_blocking(session_id: String) -> Result<bool, String> {
    let store = open_store()?;
    let session_id = parse_uuid(&session_id)?;
    store.delete_session(session_id).map_err(to_string)
}

#[tauri::command]
async fn list_automations() -> Result<Vec<Automation>, String> {
    tauri::async_runtime::spawn_blocking(list_automations_blocking)
        .await
        .map_err(|error| format!("automation list worker failed: {error}"))?
}

fn list_automations_blocking() -> Result<Vec<Automation>, String> {
    let store = open_automation_store()?;
    store.list_automations().map_err(to_string)
}

#[tauri::command]
async fn list_due_automations() -> Result<Vec<Automation>, String> {
    tauri::async_runtime::spawn_blocking(list_due_automations_blocking)
        .await
        .map_err(|error| format!("due automation list worker failed: {error}"))?
}

fn list_due_automations_blocking() -> Result<Vec<Automation>, String> {
    let store = open_automation_store()?;
    store.list_due_automations_now().map_err(to_string)
}

#[tauri::command]
async fn create_automation(draft: CreateAutomationRequest) -> Result<Automation, String> {
    tauri::async_runtime::spawn_blocking(move || create_automation_blocking(draft))
        .await
        .map_err(|error| format!("automation create worker failed: {error}"))?
}

fn create_automation_blocking(draft: CreateAutomationRequest) -> Result<Automation, String> {
    let store = open_automation_store()?;
    store.create_automation(draft).map_err(to_string)
}

#[tauri::command]
async fn set_automation_status(
    automation_id: String,
    status: AutomationStatus,
) -> Result<Automation, String> {
    tauri::async_runtime::spawn_blocking(move || {
        set_automation_status_blocking(automation_id, status)
    })
    .await
    .map_err(|error| format!("automation status worker failed: {error}"))?
}

fn set_automation_status_blocking(
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
async fn run_automation(automation_id: String, summary: String) -> Result<Automation, String> {
    tauri::async_runtime::spawn_blocking(move || run_automation_blocking(automation_id, summary))
        .await
        .map_err(|error| format!("automation run worker failed: {error}"))?
}

fn run_automation_blocking(automation_id: String, summary: String) -> Result<Automation, String> {
    let store = open_automation_store()?;
    let automation_id = parse_uuid(&automation_id)?;
    store
        .record_automation_run(automation_id, summary)
        .map_err(to_string)?
        .ok_or_else(|| "automation not found".into())
}

#[tauri::command]
async fn claim_due_automation(
    lease_owner: String,
    lease_seconds: Option<i64>,
) -> Result<Option<Automation>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        claim_due_automation_blocking(lease_owner, lease_seconds)
    })
    .await
    .map_err(|error| format!("automation claim worker failed: {error}"))?
}

fn claim_due_automation_blocking(
    lease_owner: String,
    lease_seconds: Option<i64>,
) -> Result<Option<Automation>, String> {
    let store = open_automation_store()?;
    store
        .claim_due_automation(lease_owner, lease_seconds.unwrap_or(300))
        .map_err(to_string)
}

#[tauri::command]
async fn complete_automation_lease(
    automation_id: String,
    lease_owner: String,
    summary: String,
) -> Result<Automation, String> {
    tauri::async_runtime::spawn_blocking(move || {
        complete_automation_lease_blocking(automation_id, lease_owner, summary)
    })
    .await
    .map_err(|error| format!("automation lease complete worker failed: {error}"))?
}

fn complete_automation_lease_blocking(
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
async fn recover_automation_leases() -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(recover_automation_leases_blocking)
        .await
        .map_err(|error| format!("automation lease recovery worker failed: {error}"))?
}

fn recover_automation_leases_blocking() -> Result<usize, String> {
    let store = open_automation_store()?;
    store
        .recover_expired_automation_leases_now()
        .map_err(to_string)
}

#[tauri::command]
async fn triage_automation(
    automation_id: String,
    triage_state: AutomationTriageState,
) -> Result<Automation, String> {
    tauri::async_runtime::spawn_blocking(move || {
        triage_automation_blocking(automation_id, triage_state)
    })
    .await
    .map_err(|error| format!("automation triage worker failed: {error}"))?
}

fn triage_automation_blocking(
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
async fn read_session_events(session_id: String) -> Result<Vec<SessionEvent>, String> {
    tauri::async_runtime::spawn_blocking(move || read_session_events_blocking(session_id))
        .await
        .map_err(|error| format!("session event read worker failed: {error}"))?
}

fn read_session_events_blocking(session_id: String) -> Result<Vec<SessionEvent>, String> {
    let store = open_store()?;
    let session_id = parse_uuid(&session_id)?;
    store
        .read_recent_events(session_id, MAX_DESKTOP_SESSION_EVENTS_READ)
        .map_err(to_string)
}

#[tauri::command]
async fn append_user_message(
    session_id: String,
    message: String,
    turn_id: Option<String>,
) -> Result<SessionEvent, String> {
    let message = validate_chat_message(&message)?;
    tauri::async_runtime::spawn_blocking(move || {
        append_user_message_blocking(session_id, message, turn_id)
    })
    .await
    .map_err(|error| format!("user message worker failed: {error}"))?
}

fn append_user_message_blocking(
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
async fn run_provider_chat(
    app: tauri::AppHandle,
    mut request: ProviderChatRequest,
) -> Result<ProviderChatResponse, String> {
    request.message = validate_chat_message(&request.message)?;

    tauri::async_runtime::spawn_blocking(move || run_provider_chat_blocking(app, request))
        .await
        .map_err(|error| format!("provider chat worker failed: {error}"))?
}

fn run_provider_chat_blocking(
    app: tauri::AppHandle,
    request: ProviderChatRequest,
) -> Result<ProviderChatResponse, String> {
    let store = open_store()?;
    let session_id = parse_uuid(&request.session_id)?;
    let turn_id = request.turn_id.as_deref().map(parse_uuid).transpose()?;
    let run_id = turn_id.unwrap_or_else(Uuid::new_v4);
    let attempt_id = Uuid::new_v4();
    let started_at = chrono::Utc::now();
    let adapter = provider_adapter_for(&request.provider_id);
    emit_provider_chat_event(
        &app,
        &request,
        "started",
        Some(HarnessRunStatus::Running),
        None,
        Some(provider_chat_status_message(
            &HarnessRunStatus::Running,
            request.provider_label.as_deref().unwrap_or("Provider"),
        )),
        None,
    );
    let _ = append_provider_status_event(
        &store,
        session_id,
        &request,
        Some(run_id),
        attempt_id,
        HarnessRunStatus::Running,
        None,
    );

    let binding = store
        .get_provider_session_binding(session_id, &request.provider_id)
        .map_err(to_string)?;
    let runner_output = match run_provider_chat_with_retry(&store, &app, &request, binding) {
        Ok(response) => response,
        Err(error) => {
            let error = gyro_core::security::redact_secrets(&error.to_string());
            let status = if adapter.kind == ProviderAdapterKind::ReadinessOnly {
                HarnessRunStatus::Blocked
            } else {
                HarnessRunStatus::Failed
            };
            let _ = append_provider_status_event(
                &store,
                session_id,
                &request,
                Some(run_id),
                attempt_id,
                status.clone(),
                Some(error.as_str()),
            );
            let _ = append_provider_diagnostics_event(
                &store,
                session_id,
                &request,
                Some(run_id),
                attempt_id,
                status.clone(),
                started_at,
                0,
                false,
                Some(error.as_str()),
                None,
            );
            emit_provider_chat_event(
                &app,
                &request,
                "failed",
                Some(status),
                None,
                None,
                Some(error.clone()),
            );
            return Err(error);
        }
    };
    let title_extraction =
        extract_session_title_marker(&runner_output.response, request.suggest_title);
    let session = if let Some(title) = title_extraction.title.as_deref() {
        store.rename_session(session_id, title).map_err(to_string)?
    } else {
        None
    };
    let resume_cursor_value = runner_output
        .resume_cursor
        .as_ref()
        .map(serde_json::to_value)
        .transpose()
        .map_err(to_string)?;
    if let Some(resume_cursor_value) = resume_cursor_value {
        store
            .upsert_provider_session_binding(
                session_id,
                request.provider_id.clone(),
                request.model_id.clone(),
                request.model_label.clone(),
                request.reasoning_effort.clone(),
                resume_cursor_value,
                "ready",
                None,
            )
            .map_err(to_string)?;
    }
    let status_event = append_provider_status_event(
        &store,
        session_id,
        &request,
        Some(run_id),
        attempt_id,
        HarnessRunStatus::Done,
        None,
    )
    .map_err(to_string)?;
    append_provider_diagnostics_event(
        &store,
        session_id,
        &request,
        Some(run_id),
        attempt_id,
        HarnessRunStatus::Done,
        started_at,
        runner_output.retry_count,
        runner_output.resumed,
        None,
        runner_output.output_summary.as_deref(),
    )
    .map_err(to_string)?;
    let mut assistant_payload = gyro_core::harness_payload_value(&ProviderRunPayload::new(
        run_id,
        attempt_id,
        "desktop",
        HarnessRunStatus::Done,
        request.provider_id.clone(),
        request.provider_label.clone(),
        request.model_id.clone(),
        request.model_label.clone(),
        Some(chat_message_preview(&request.message)),
        Some(adapter.runner.into()),
        Some(adapter.auth_owner.into()),
        runner_output.resumed,
        runner_output.retry_count,
        Some(adapter.timeout_seconds),
    ))
    .map_err(to_string)?;
    if let Some(object) = assistant_payload.as_object_mut() {
        object.insert(
            "reasoningEffort".into(),
            request
                .reasoning_effort
                .clone()
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null),
        );
        object.insert(
            "kind".into(),
            serde_json::Value::String("provider-response".into()),
        );
        object.insert(
            "runKind".into(),
            serde_json::Value::String("provider-run".into()),
        );
        object.insert(
            "resumeCursor".into(),
            runner_output
                .resume_cursor
                .as_ref()
                .map(serde_json::to_value)
                .transpose()
                .map_err(to_string)?
                .unwrap_or(serde_json::Value::Null),
        );
        object.insert(
            "sessionTitle".into(),
            title_extraction
                .title
                .as_ref()
                .map(|title| serde_json::Value::String(title.clone()))
                .unwrap_or(serde_json::Value::Null),
        );
    }
    let assistant_event = store
        .append_event_with_turn_id(
            session_id,
            SessionEventKind::AssistantMessage,
            title_extraction.message,
            assistant_payload,
            Some(run_id),
        )
        .map_err(to_string)?;
    emit_provider_chat_event(
        &app,
        &request,
        "completed",
        Some(HarnessRunStatus::Done),
        None,
        Some(provider_chat_status_message(
            &HarnessRunStatus::Done,
            request.provider_label.as_deref().unwrap_or("Provider"),
        )),
        None,
    );

    Ok(ProviderChatResponse {
        assistant_event,
        session_title: title_extraction.title,
        session,
        status_event,
        resume_cursor: runner_output.resume_cursor,
    })
}

#[tauri::command]
async fn append_plan_event(
    session_id: String,
    message: Option<String>,
    payload: serde_json::Value,
) -> Result<SessionEvent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        append_plan_event_blocking(session_id, message, payload)
    })
    .await
    .map_err(|error| format!("plan event worker failed: {error}"))?
}

fn append_plan_event_blocking(
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
async fn append_editor_event(
    session_id: String,
    event_kind: String,
    message: String,
    payload: serde_json::Value,
) -> Result<SessionEvent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        append_editor_event_blocking(session_id, event_kind, message, payload)
    })
    .await
    .map_err(|error| format!("editor event worker failed: {error}"))?
}

fn append_editor_event_blocking(
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
async fn load_config() -> Result<GyroConfig, String> {
    tauri::async_runtime::spawn_blocking(load_config_blocking)
        .await
        .map_err(|error| format!("config load worker failed: {error}"))?
}

fn load_config_blocking() -> Result<GyroConfig, String> {
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    GyroConfig::load(&paths).map_err(to_string)
}

#[tauri::command]
async fn get_account_session() -> Result<AccountSessionState, String> {
    tauri::async_runtime::spawn_blocking(get_account_session_blocking)
        .await
        .map_err(|error| format!("account session worker failed: {error}"))?
}

fn get_account_session_blocking() -> Result<AccountSessionState, String> {
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    account_stored_session(&paths).map_err(to_string)
}

#[tauri::command]
async fn start_account_login() -> Result<AccountSessionState, String> {
    tauri::async_runtime::spawn_blocking(start_account_login_blocking)
        .await
        .map_err(|error| format!("account login worker failed: {error}"))?
}

fn start_account_login_blocking() -> Result<AccountSessionState, String> {
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    account_start_login(&paths).map_err(to_string)
}

#[tauri::command]
async fn refresh_account_session() -> Result<AccountSessionState, String> {
    tauri::async_runtime::spawn_blocking(refresh_account_session_blocking)
        .await
        .map_err(|error| format!("account refresh worker failed: {error}"))?
}

fn refresh_account_session_blocking() -> Result<AccountSessionState, String> {
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    account_refresh_session(&paths).map_err(to_string)
}

#[tauri::command]
async fn logout_account() -> Result<AccountSessionState, String> {
    tauri::async_runtime::spawn_blocking(logout_account_blocking)
        .await
        .map_err(|error| format!("account logout worker failed: {error}"))?
}

fn logout_account_blocking() -> Result<AccountSessionState, String> {
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    account_logout(&paths).map_err(to_string)
}

#[tauri::command]
async fn save_config(config: GyroConfig) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = GyroPaths::for_current_user().map_err(to_string)?;
        config.save(&paths).map_err(to_string)
    })
    .await
    .map_err(|error| format!("config save worker failed: {error}"))?
}

#[tauri::command]
async fn list_workspace_files(workspace_path: String) -> Result<Vec<WorkspaceFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        list_workspace_tree_blocking(workspace_path, Some(3))
    })
    .await
    .map_err(|error| format!("workspace file list worker failed: {error}"))?
}

#[tauri::command]
async fn list_workspace_tree(
    workspace_path: String,
    depth: Option<usize>,
) -> Result<Vec<WorkspaceFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        list_workspace_tree_blocking(workspace_path, depth)
    })
    .await
    .map_err(|error| format!("workspace tree worker failed: {error}"))?
}

fn list_workspace_tree_blocking(
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
async fn read_workspace_file(
    workspace_path: String,
    path: String,
) -> Result<WorkspaceFileContent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_workspace_file_impl(&workspace_path, &path).map_err(to_string)
    })
    .await
    .map_err(|error| format!("workspace file read worker failed: {error}"))?
}

#[tauri::command]
async fn read_workspace_file_full(
    workspace_path: String,
    path: String,
) -> Result<WorkspaceFileContent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_workspace_file_with_limit(&workspace_path, &path, MAX_WORKSPACE_FILE_EDIT_BYTES)
            .map_err(to_string)
    })
    .await
    .map_err(|error| format!("full workspace file read worker failed: {error}"))?
}

#[tauri::command]
async fn stat_workspace_file(
    workspace_path: String,
    path: String,
) -> Result<WorkspaceFileStat, String> {
    tauri::async_runtime::spawn_blocking(move || {
        stat_workspace_file_impl(&workspace_path, &path).map_err(to_string)
    })
    .await
    .map_err(|error| format!("workspace file stat worker failed: {error}"))?
}

#[tauri::command]
async fn write_workspace_file(
    request: WorkspaceFileWriteRequest,
) -> Result<WorkspaceFileContent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        write_workspace_file_impl(&request).map_err(to_string)
    })
    .await
    .map_err(|error| format!("workspace file write worker failed: {error}"))?
}

#[tauri::command]
async fn watch_workspace(workspace_path: String) -> Result<Vec<WorkspaceFile>, String> {
    // The renderer polls this normalized snapshot while a workspace is active.
    // Hash-based stat checks handle open-file conflicts independently.
    tauri::async_runtime::spawn_blocking(move || {
        list_workspace_tree_blocking(workspace_path, Some(5))
    })
    .await
    .map_err(|error| format!("workspace watch worker failed: {error}"))?
}

#[tauri::command]
async fn create_workspace_file(
    request: WorkspacePathCreateRequest,
) -> Result<WorkspaceFileStat, String> {
    tauri::async_runtime::spawn_blocking(move || {
        create_workspace_path_impl(&request).map_err(to_string)
    })
    .await
    .map_err(|error| format!("workspace file create worker failed: {error}"))?
}

#[tauri::command]
async fn rename_workspace_path(
    request: WorkspacePathRenameRequest,
) -> Result<WorkspaceFileStat, String> {
    tauri::async_runtime::spawn_blocking(move || {
        rename_workspace_path_impl(&request).map_err(to_string)
    })
    .await
    .map_err(|error| format!("workspace path rename worker failed: {error}"))?
}

#[tauri::command]
async fn delete_workspace_path(request: WorkspacePathDeleteRequest) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        delete_workspace_path_impl(&request).map_err(to_string)
    })
    .await
    .map_err(|error| format!("workspace path delete worker failed: {error}"))?
}

#[tauri::command]
async fn search_workspace(
    request: WorkspaceSearchRequest,
) -> Result<Vec<WorkspaceSearchResult>, String> {
    tauri::async_runtime::spawn_blocking(move || search_workspace_impl(&request).map_err(to_string))
        .await
        .map_err(|error| format!("workspace search worker failed: {error}"))?
}

#[tauri::command]
async fn git_status(workspace_path: String) -> Result<SourceControlStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_status_impl(&workspace_path).map_err(to_string)
    })
    .await
    .map_err(|error| format!("git status worker failed: {error}"))?
}

#[tauri::command]
async fn git_diff(request: GitPathRequest) -> Result<IdeCommandOutput, String> {
    tauri::async_runtime::spawn_blocking(move || git_diff_blocking(request))
        .await
        .map_err(|error| format!("git diff worker failed: {error}"))?
}

fn git_diff_blocking(request: GitPathRequest) -> Result<IdeCommandOutput, String> {
    let root = workspace_root(&request.workspace_path).map_err(to_string)?;
    let mut command = command_with_gui_path("git");
    command.arg("-C").arg(root).arg("diff");
    if request.staged.unwrap_or(false) {
        command.arg("--cached");
    }
    command.arg("--");
    if let Some(path) = request.path {
        command.arg(path);
    }
    run_command_output(command).map_err(to_string)
}

#[tauri::command]
async fn git_stage(request: GitStageRequest) -> Result<SourceControlStatus, String> {
    tauri::async_runtime::spawn_blocking(move || git_stage_blocking(request))
        .await
        .map_err(|error| format!("git stage worker failed: {error}"))?
}

fn git_stage_blocking(request: GitStageRequest) -> Result<SourceControlStatus, String> {
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
async fn git_unstage(request: GitStageRequest) -> Result<SourceControlStatus, String> {
    tauri::async_runtime::spawn_blocking(move || git_unstage_blocking(request))
        .await
        .map_err(|error| format!("git unstage worker failed: {error}"))?
}

fn git_unstage_blocking(request: GitStageRequest) -> Result<SourceControlStatus, String> {
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
async fn git_discard(request: GitStageRequest) -> Result<SourceControlStatus, String> {
    tauri::async_runtime::spawn_blocking(move || git_discard_blocking(request))
        .await
        .map_err(|error| format!("git discard worker failed: {error}"))?
}

fn git_discard_blocking(request: GitStageRequest) -> Result<SourceControlStatus, String> {
    let root = workspace_root(&request.workspace_path).map_err(to_string)?;
    let path = assert_workspace_path(&root, &request.path).map_err(to_string)?;
    let relative = path.strip_prefix(&root).map_err(to_string)?;
    let mut status_command = command_with_gui_path("git");
    status_command
        .arg("-C")
        .arg(&root)
        .args(["status", "--porcelain=v1", "--"])
        .arg(relative);
    let status = run_command_output(status_command).map_err(to_string)?;
    let state = status.stdout.lines().next().unwrap_or_default();
    let is_untracked = state.starts_with("??");
    let is_added = state.as_bytes().first() == Some(&b'A');

    if is_added {
        let mut unstage = command_with_gui_path("git");
        unstage
            .arg("-C")
            .arg(&root)
            .args(["rm", "--cached", "-f", "--"])
            .arg(relative);
        run_command_output(unstage).map_err(to_string)?;
    } else if !is_untracked {
        let mut restore = command_with_gui_path("git");
        restore.arg("-C").arg(&root).arg("restore");
        if state.as_bytes().first().is_some_and(|value| *value != b' ') {
            restore.args(["--source=HEAD", "--staged", "--worktree"]);
        } else {
            restore.arg("--worktree");
        }
        restore.arg("--").arg(relative);
        run_command_output(restore).map_err(to_string)?;
    }

    if is_untracked || is_added {
        if path.is_dir() {
            std::fs::remove_dir_all(&path).map_err(to_string)?;
        } else if path.exists() {
            std::fs::remove_file(&path).map_err(to_string)?;
        }
    }
    git_status_impl(&request.workspace_path).map_err(to_string)
}

#[tauri::command]
async fn git_commit(request: GitCommitRequest) -> Result<IdeCommandOutput, String> {
    tauri::async_runtime::spawn_blocking(move || git_commit_blocking(request))
        .await
        .map_err(|error| format!("git commit worker failed: {error}"))?
}

fn git_commit_blocking(request: GitCommitRequest) -> Result<IdeCommandOutput, String> {
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
async fn lsp_start(
    request: LspStartRequest,
    manager: tauri::State<'_, LanguageServerManager>,
) -> Result<LspSessionResult, String> {
    manager.start(request).map_err(to_string)
}

#[tauri::command]
async fn lsp_request(
    request: LspRequestPayload,
    manager: tauri::State<'_, LanguageServerManager>,
) -> Result<serde_json::Value, String> {
    manager.request(request).map_err(to_string)
}

#[tauri::command]
async fn lsp_stop(
    server_id: String,
    manager: tauri::State<'_, LanguageServerManager>,
) -> Result<serde_json::Value, String> {
    manager.stop(&server_id).map_err(to_string)
}

impl LanguageServerManager {
    fn start(&self, request: LspStartRequest) -> anyhow::Result<LspSessionResult> {
        let root = workspace_root(&request.workspace_path)?;
        let command_text = request.command.trim().to_string();
        let mut parts = command_text.split_whitespace();
        let command_name = parts
            .next()
            .ok_or_else(|| anyhow::anyhow!("language server command is required"))?;
        let mut args = parts.map(ToOwned::to_owned).collect::<Vec<_>>();
        if language_server_needs_stdio_arg(command_name) && !args.iter().any(|arg| arg == "--stdio")
        {
            args.push("--stdio".into());
        }

        let mut processes = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("language server manager lock poisoned"))?;
        if let Some((server_id, process)) = processes.iter_mut().find(|(_, process)| {
            process.language_id == request.language_id && process.command == command_text
        }) {
            if process.child.try_wait()?.is_none() {
                return Ok(LspSessionResult {
                    server_id: server_id.clone(),
                    language_id: request.language_id,
                    command: command_text,
                    status: "ready".into(),
                    message: "Language server is already running".into(),
                });
            }
        }

        let mut command = command_with_gui_path(command_name);
        command
            .args(args)
            .current_dir(&root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command.spawn().map_err(|error| {
            anyhow::anyhow!("failed to start language server {command_name}: {error}")
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("language server stdin unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("language server stdout unavailable"))?;
        let mut process = LanguageServerProcess {
            child,
            stdin,
            messages: spawn_lsp_message_reader(stdout),
            next_request_id: 2,
            language_id: request.language_id.clone(),
            command: command_text.clone(),
        };
        let root_uri = workspace_file_uri(&root);
        write_lsp_message(
            &mut process.stdin,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "processId": std::process::id(),
                    "clientInfo": { "name": "Gyro", "version": env!("CARGO_PKG_VERSION") },
                    "rootUri": root_uri,
                    "workspaceFolders": [{ "uri": root_uri, "name": root.file_name().and_then(|name| name.to_str()).unwrap_or("workspace") }],
                    "capabilities": {
                        "workspace": { "workspaceFolders": true, "configuration": true },
                        "textDocument": {
                            "publishDiagnostics": { "relatedInformation": true },
                            "completion": { "completionItem": { "snippetSupport": true } },
                            "hover": { "contentFormat": ["markdown", "plaintext"] },
                            "definition": { "linkSupport": true }
                        }
                    }
                }
            }),
        )?;
        let (initialize_response, startup_messages) =
            receive_lsp_response(&mut process, 1, Duration::from_secs(12))?;
        if let Some(error) = initialize_response.get("error") {
            anyhow::bail!("language server initialize failed: {error}");
        }
        write_lsp_message(
            &mut process.stdin,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "method": "initialized",
                "params": {}
            }),
        )?;
        let capability_count = initialize_response
            .pointer("/result/capabilities")
            .and_then(|value| value.as_object())
            .map(|value| value.len())
            .unwrap_or(0);
        let server_id = format!("{}:{}", request.language_id, Uuid::new_v4());
        processes.insert(server_id.clone(), process);
        Ok(LspSessionResult {
            server_id,
            language_id: request.language_id,
            command: command_text,
            status: "ready".into(),
            message: format!(
                "Initialized with {capability_count} capabilities and {} startup messages",
                startup_messages.len()
            ),
        })
    }

    fn request(&self, request: LspRequestPayload) -> anyhow::Result<serde_json::Value> {
        let mut processes = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("language server manager lock poisoned"))?;
        let process = processes
            .get_mut(&request.server_id)
            .ok_or_else(|| anyhow::anyhow!("language server is not running"))?;
        if let Some(status) = process.child.try_wait()? {
            anyhow::bail!("language server exited with {status}");
        }

        if request.method == "$/gyro/poll" {
            let messages = drain_lsp_messages(process)?;
            return Ok(serde_json::json!({
                "serverId": request.server_id,
                "status": "ok",
                "messages": messages,
            }));
        }

        if lsp_method_is_notification(&request.method) {
            write_lsp_message(
                &mut process.stdin,
                &serde_json::json!({
                    "jsonrpc": "2.0",
                    "method": request.method,
                    "params": request.params,
                }),
            )?;
            let messages = drain_lsp_messages(process)?;
            return Ok(serde_json::json!({
                "serverId": request.server_id,
                "status": "sent",
                "messages": messages,
            }));
        }

        let request_id = process.next_request_id;
        process.next_request_id += 1;
        write_lsp_message(
            &mut process.stdin,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": request.method,
                "params": request.params,
            }),
        )?;
        let (response, messages) =
            receive_lsp_response(process, request_id, Duration::from_secs(15))?;
        Ok(serde_json::json!({
            "serverId": request.server_id,
            "status": if response.get("error").is_some() { "error" } else { "ok" },
            "result": response.get("result").cloned(),
            "error": response.get("error").cloned(),
            "messages": messages,
        }))
    }

    fn stop(&self, server_id: &str) -> anyhow::Result<serde_json::Value> {
        let mut processes = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("language server manager lock poisoned"))?;
        let Some(mut process) = processes.remove(server_id) else {
            return Ok(serde_json::json!({
                "serverId": server_id,
                "status": "stopped",
            }));
        };
        let request_id = process.next_request_id;
        process.next_request_id += 1;
        let _ = write_lsp_message(
            &mut process.stdin,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "shutdown",
                "params": null,
            }),
        );
        let _ = receive_lsp_response(&mut process, request_id, Duration::from_secs(2));
        let _ = write_lsp_message(
            &mut process.stdin,
            &serde_json::json!({ "jsonrpc": "2.0", "method": "exit", "params": null }),
        );
        let _ = process.child.kill();
        let _ = process.child.wait();
        Ok(serde_json::json!({
            "serverId": server_id,
            "status": "stopped",
        }))
    }
}

fn language_server_needs_stdio_arg(command: &str) -> bool {
    let name = Path::new(command)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(command);
    matches!(
        name,
        "typescript-language-server"
            | "vscode-json-language-server"
            | "vscode-css-language-server"
            | "vscode-html-language-server"
    )
}

fn lsp_method_is_notification(method: &str) -> bool {
    method == "initialized"
        || method == "exit"
        || method == "workspace/didChangeConfiguration"
        || method == "workspace/didChangeWatchedFiles"
        || method.starts_with("textDocument/did")
        || method.starts_with("$/")
}

fn spawn_lsp_message_reader(
    stdout: ChildStdout,
) -> mpsc::Receiver<Result<serde_json::Value, String>> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_lsp_message(&mut reader) {
                Ok(message) => {
                    if sender.send(Ok(message)).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let _ = sender.send(Err(error.to_string()));
                    break;
                }
            }
        }
    });
    receiver
}

fn write_lsp_message(writer: &mut impl Write, value: &serde_json::Value) -> anyhow::Result<()> {
    let body = serde_json::to_vec(value)?;
    if body.len() > MAX_LSP_MESSAGE_BYTES {
        anyhow::bail!("language server message exceeds size limit");
    }
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())?;
    writer.write_all(&body)?;
    writer.flush()?;
    Ok(())
}

fn read_lsp_message(reader: &mut impl BufRead) -> anyhow::Result<serde_json::Value> {
    let mut content_length = None;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 {
            anyhow::bail!("language server output closed");
        }
        if header == "\r\n" || header == "\n" {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = Some(value.trim().parse::<usize>()?);
            }
        }
    }
    let content_length =
        content_length.ok_or_else(|| anyhow::anyhow!("missing LSP Content-Length header"))?;
    if content_length > MAX_LSP_MESSAGE_BYTES {
        anyhow::bail!("language server message exceeds size limit");
    }
    let mut body = vec![0; content_length];
    reader.read_exact(&mut body)?;
    Ok(serde_json::from_slice(&body)?)
}

fn receive_lsp_response(
    process: &mut LanguageServerProcess,
    request_id: u64,
    timeout: Duration,
) -> anyhow::Result<(serde_json::Value, Vec<serde_json::Value>)> {
    let deadline = Instant::now() + timeout;
    let mut messages = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            anyhow::bail!("language server request timed out");
        }
        let message = process
            .messages
            .recv_timeout(remaining)
            .map_err(|error| anyhow::anyhow!("language server response failed: {error}"))?
            .map_err(anyhow::Error::msg)?;
        if message.get("id").and_then(|value| value.as_u64()) == Some(request_id) {
            return Ok((message, messages));
        }
        handle_lsp_server_message(process, &message)?;
        messages.push(message);
    }
}

fn drain_lsp_messages(
    process: &mut LanguageServerProcess,
) -> anyhow::Result<Vec<serde_json::Value>> {
    let mut messages = Vec::new();
    for _ in 0..128 {
        let message = match process.messages.try_recv() {
            Ok(message) => message.map_err(anyhow::Error::msg)?,
            Err(mpsc::TryRecvError::Empty) => break,
            Err(mpsc::TryRecvError::Disconnected) => {
                anyhow::bail!("language server output disconnected")
            }
        };
        handle_lsp_server_message(process, &message)?;
        messages.push(message);
    }
    Ok(messages)
}

fn handle_lsp_server_message(
    process: &mut LanguageServerProcess,
    message: &serde_json::Value,
) -> anyhow::Result<()> {
    let Some(id) = message.get("id") else {
        return Ok(());
    };
    let Some(method) = message.get("method").and_then(|value| value.as_str()) else {
        return Ok(());
    };
    let result = if method == "workspace/configuration" {
        let count = message
            .pointer("/params/items")
            .and_then(|value| value.as_array())
            .map(|items| items.len())
            .unwrap_or(0);
        serde_json::Value::Array(vec![serde_json::Value::Null; count])
    } else {
        serde_json::Value::Null
    };
    write_lsp_message(
        &mut process.stdin,
        &serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result }),
    )
}

fn workspace_file_uri(path: &Path) -> String {
    let value = path.to_string_lossy();
    let mut encoded = String::with_capacity(value.len() + 8);
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b':' | b'.' | b'-' | b'_' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    format!("file://{encoded}")
}

#[tauri::command]
async fn task_discover(workspace_path: String) -> Result<Vec<TaskDefinitionResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        task_discover_impl(&workspace_path).map_err(to_string)
    })
    .await
    .map_err(|error| format!("task discover worker failed: {error}"))?
}

#[tauri::command]
async fn task_run(request: TaskRunRequest) -> Result<IdeCommandOutput, String> {
    tauri::async_runtime::spawn_blocking(move || task_run_blocking(request))
        .await
        .map_err(|error| format!("task run worker failed: {error}"))?
}

fn task_run_blocking(request: TaskRunRequest) -> Result<IdeCommandOutput, String> {
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
async fn test_discover(workspace_path: String) -> Result<Vec<TestTreeItemResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        test_discover_impl(&workspace_path).map_err(to_string)
    })
    .await
    .map_err(|error| format!("test discover worker failed: {error}"))?
}

#[tauri::command]
async fn test_run(request: TestRunRequest) -> Result<IdeCommandOutput, String> {
    tauri::async_runtime::spawn_blocking(move || test_run_blocking(request))
        .await
        .map_err(|error| format!("test run worker failed: {error}"))?
}

fn test_run_blocking(request: TestRunRequest) -> Result<IdeCommandOutput, String> {
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
async fn debug_start(
    request: DebugStartRequest,
    manager: tauri::State<'_, DebugAdapterManager>,
) -> Result<DebugSessionResult, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.start(request).map_err(to_string))
        .await
        .map_err(|error| format!("debug start worker failed: {error}"))?
}

#[tauri::command]
async fn debug_send(
    request: DebugSendRequest,
    manager: tauri::State<'_, DebugAdapterManager>,
) -> Result<serde_json::Value, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.send(request).map_err(to_string))
        .await
        .map_err(|error| format!("debug request worker failed: {error}"))?
}

#[tauri::command]
async fn debug_stop(
    session_id: String,
    manager: tauri::State<'_, DebugAdapterManager>,
) -> Result<serde_json::Value, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.stop(&session_id).map_err(to_string))
        .await
        .map_err(|error| format!("debug stop worker failed: {error}"))?
}

impl DebugAdapterManager {
    fn start(&self, request: DebugStartRequest) -> anyhow::Result<DebugSessionResult> {
        let root = request
            .workspace_path
            .as_deref()
            .map(workspace_root)
            .transpose()?;
        let command_text = request
            .command
            .as_deref()
            .unwrap_or(&request.adapter)
            .trim();
        let mut command_parts = command_text.split_whitespace();
        let command_name = command_parts
            .next()
            .ok_or_else(|| anyhow::anyhow!("debug adapter command is required"))?;
        let mut args = command_parts.map(ToOwned::to_owned).collect::<Vec<_>>();
        args.extend(request.args.clone().unwrap_or_default());
        let mut command = command_with_gui_path(command_name);
        command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(root) = root.as_ref() {
            command.current_dir(root);
        }
        let mut child = command.spawn().map_err(|error| {
            anyhow::anyhow!("failed to start debug adapter {command_name}: {error}")
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("debug adapter stdin unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("debug adapter stdout unavailable"))?;
        let mut process = DebugAdapterProcess {
            child,
            stdin,
            messages: spawn_lsp_message_reader(stdout),
            next_sequence: 2,
            name: request.name.clone(),
            adapter: request.adapter.clone(),
        };
        write_lsp_message(
            &mut process.stdin,
            &serde_json::json!({
                "seq": 1,
                "type": "request",
                "command": "initialize",
                "arguments": {
                    "clientID": "gyro",
                    "clientName": "Gyro",
                    "adapterID": request.adapter,
                    "pathFormat": "path",
                    "linesStartAt1": true,
                    "columnsStartAt1": true,
                    "supportsVariableType": true,
                    "supportsVariablePaging": true,
                    "supportsRunInTerminalRequest": false,
                    "supportsMemoryReferences": true,
                    "supportsProgressReporting": true,
                    "supportsInvalidatedEvent": true
                }
            }),
        )?;
        let (response, events) = receive_dap_response(&mut process, 1, Duration::from_secs(12))?;
        if response.get("success").and_then(|value| value.as_bool()) == Some(false) {
            let message = response
                .get("message")
                .and_then(|value| value.as_str())
                .unwrap_or("debug adapter initialize failed");
            anyhow::bail!("{message}");
        }
        let capabilities = response
            .get("body")
            .and_then(|value| value.as_object())
            .map(|body| {
                body.iter()
                    .filter_map(|(key, value)| {
                        value
                            .as_bool()
                            .is_some_and(|value| value)
                            .then_some(key.clone())
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let session_id = format!("debug-{}", Uuid::new_v4());
        let message = Some(format!(
            "Initialized with {} capabilities and {} startup events",
            capabilities.len(),
            events.len()
        ));
        let result = DebugSessionResult {
            id: session_id.clone(),
            name: request.name,
            adapter: request.adapter,
            status: "configured".into(),
            message,
            capabilities,
        };
        self.processes
            .lock()
            .map_err(|_| anyhow::anyhow!("debug adapter manager lock poisoned"))?
            .insert(session_id, process);
        Ok(result)
    }

    fn send(&self, request: DebugSendRequest) -> anyhow::Result<serde_json::Value> {
        let mut processes = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("debug adapter manager lock poisoned"))?;
        let process = processes
            .get_mut(&request.session_id)
            .ok_or_else(|| anyhow::anyhow!("debug session is not running"))?;
        if let Some(status) = process.child.try_wait()? {
            anyhow::bail!("debug adapter exited with {status}");
        }
        let command = request
            .request
            .get("command")
            .and_then(|value| value.as_str())
            .ok_or_else(|| anyhow::anyhow!("debug request command is required"))?;
        if command == "$/gyro/poll" {
            let events = drain_dap_messages(process)?;
            return Ok(redact_json_strings(serde_json::json!({
                "sessionId": request.session_id,
                "name": process.name,
                "adapter": process.adapter,
                "status": "ok",
                "events": events,
            })));
        }
        let sequence = process.next_sequence;
        process.next_sequence += 1;
        write_lsp_message(
            &mut process.stdin,
            &serde_json::json!({
                "seq": sequence,
                "type": "request",
                "command": command,
                "arguments": request.request.get("arguments").cloned().unwrap_or_else(|| serde_json::json!({})),
            }),
        )?;
        let (response, events) = receive_dap_response(process, sequence, Duration::from_secs(20))?;
        Ok(redact_json_strings(serde_json::json!({
            "sessionId": request.session_id,
            "status": if response.get("success").and_then(|value| value.as_bool()) == Some(false) { "error" } else { "ok" },
            "response": response,
            "events": events,
        })))
    }

    fn stop(&self, session_id: &str) -> anyhow::Result<serde_json::Value> {
        let mut processes = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("debug adapter manager lock poisoned"))?;
        let Some(mut process) = processes.remove(session_id) else {
            return Ok(serde_json::json!({ "sessionId": session_id, "status": "stopped" }));
        };
        let sequence = process.next_sequence;
        let _ = write_lsp_message(
            &mut process.stdin,
            &serde_json::json!({
                "seq": sequence,
                "type": "request",
                "command": "disconnect",
                "arguments": { "terminateDebuggee": false }
            }),
        );
        let _ = receive_dap_response(&mut process, sequence, Duration::from_secs(2));
        let _ = process.child.kill();
        let _ = process.child.wait();
        Ok(serde_json::json!({ "sessionId": session_id, "status": "stopped" }))
    }
}

fn receive_dap_response(
    process: &mut DebugAdapterProcess,
    request_sequence: u64,
    timeout: Duration,
) -> anyhow::Result<(serde_json::Value, Vec<serde_json::Value>)> {
    let deadline = Instant::now() + timeout;
    let mut events = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            anyhow::bail!("debug adapter request timed out");
        }
        let message = process
            .messages
            .recv_timeout(remaining)
            .map_err(|error| anyhow::anyhow!("debug adapter response failed: {error}"))?
            .map_err(anyhow::Error::msg)?;
        if message.get("type").and_then(|value| value.as_str()) == Some("response")
            && message.get("request_seq").and_then(|value| value.as_u64()) == Some(request_sequence)
        {
            return Ok((message, events));
        }
        handle_dap_adapter_request(process, &message)?;
        events.push(message);
    }
}

fn drain_dap_messages(process: &mut DebugAdapterProcess) -> anyhow::Result<Vec<serde_json::Value>> {
    let mut messages = Vec::new();
    for _ in 0..128 {
        let message = match process.messages.try_recv() {
            Ok(message) => message.map_err(anyhow::Error::msg)?,
            Err(mpsc::TryRecvError::Empty) => break,
            Err(mpsc::TryRecvError::Disconnected) => {
                anyhow::bail!("debug adapter output disconnected")
            }
        };
        handle_dap_adapter_request(process, &message)?;
        messages.push(message);
    }
    Ok(messages)
}

fn handle_dap_adapter_request(
    process: &mut DebugAdapterProcess,
    message: &serde_json::Value,
) -> anyhow::Result<()> {
    if message.get("type").and_then(|value| value.as_str()) != Some("request") {
        return Ok(());
    }
    let Some(request_sequence) = message.get("seq").and_then(|value| value.as_u64()) else {
        return Ok(());
    };
    let command = message
        .get("command")
        .and_then(|value| value.as_str())
        .unwrap_or("adapterRequest");
    let sequence = process.next_sequence;
    process.next_sequence += 1;
    write_lsp_message(
        &mut process.stdin,
        &serde_json::json!({
            "seq": sequence,
            "type": "response",
            "request_seq": request_sequence,
            "command": command,
            "success": false,
            "message": format!("Gyro does not support adapter request {command} yet")
        }),
    )
}

fn redact_json_strings(mut value: serde_json::Value) -> serde_json::Value {
    fn redact(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::String(text) => {
                *text = gyro_core::security::redact_secrets(text);
            }
            serde_json::Value::Array(items) => items.iter_mut().for_each(redact),
            serde_json::Value::Object(map) => map.values_mut().for_each(redact),
            _ => {}
        }
    }
    redact(&mut value);
    value
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
        .arg(&root)
        .arg("status")
        .arg("--porcelain=v2")
        .arg("--branch")
        .arg("--untracked-files=all");
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
                repo_root: None,
                additions: 0,
                deletions: 0,
                stats_partial: false,
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
            repo_root: None,
            additions: 0,
            deletions: 0,
            stats_partial: false,
            files: Vec::new(),
            last_checked_at: None,
            error: Some(String::from_utf8_lossy(&output.stderr).to_string()),
        });
    }
    let mut status = parse_git_status_v2(&String::from_utf8_lossy(&output.stdout));
    let repo_root = git_repo_root(&root).unwrap_or(root);
    apply_git_diff_stats(&repo_root, &mut status);
    status.repo_root = Some(repo_root.display().to_string());
    status.last_checked_at = Some(chrono::Utc::now().to_rfc3339());
    Ok(status)
}

fn parse_git_status_v2(output: &str) -> SourceControlStatus {
    let mut status = SourceControlStatus {
        provider: "git".into(),
        available: true,
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        repo_root: None,
        additions: 0,
        deletions: 0,
        stats_partial: false,
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
                additions: 0,
                deletions: 0,
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
                additions: 0,
                deletions: 0,
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
                additions: 0,
                deletions: 0,
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
                additions: 0,
                deletions: 0,
            });
        }
    }
    status
}

fn git_repo_root(workspace: &Path) -> Option<PathBuf> {
    let mut command = command_with_gui_path("git");
    command
        .arg("-C")
        .arg(workspace)
        .args(["rev-parse", "--show-toplevel"]);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!path.is_empty()).then(|| PathBuf::from(path))
}

fn apply_git_diff_stats(repo_root: &Path, status: &mut SourceControlStatus) {
    let (tracked, tracked_partial) = git_numstat(repo_root);
    status.stats_partial = tracked_partial;

    for (additions, deletions) in tracked.values() {
        status.additions = status.additions.saturating_add(*additions);
        status.deletions = status.deletions.saturating_add(*deletions);
    }

    for file in &mut status.files {
        if let Some((additions, deletions)) = tracked.get(&file.path).or_else(|| {
            file.original_path
                .as_ref()
                .and_then(|path| tracked.get(path))
        }) {
            file.additions = *additions;
            file.deletions = *deletions;
        }
        if file.state == "untracked" {
            let (additions, partial) = untracked_text_additions(repo_root, &file.path);
            file.additions = additions;
            status.additions = status.additions.saturating_add(additions);
            status.stats_partial |= partial;
        }
    }
}

fn git_numstat(repo_root: &Path) -> (HashMap<String, (usize, usize)>, bool) {
    let mut command = command_with_gui_path("git");
    command
        .arg("-C")
        .arg(repo_root)
        .args(["diff", "--numstat", "--no-renames", "HEAD", "--"]);
    let output = match command.output() {
        Ok(output) if output.status.success() => output,
        _ => return git_numstat_without_head(repo_root),
    };
    parse_git_numstat(&String::from_utf8_lossy(&output.stdout))
}

fn git_numstat_without_head(repo_root: &Path) -> (HashMap<String, (usize, usize)>, bool) {
    let mut totals = HashMap::new();
    let mut partial = false;
    for args in [
        &["diff", "--numstat", "--no-renames", "--cached", "--"][..],
        &["diff", "--numstat", "--no-renames", "--"][..],
    ] {
        let mut command = command_with_gui_path("git");
        command.arg("-C").arg(repo_root).args(args);
        let Ok(output) = command.output() else {
            partial = true;
            continue;
        };
        if !output.status.success() {
            partial = true;
            continue;
        }
        let (stats, output_partial) = parse_git_numstat(&String::from_utf8_lossy(&output.stdout));
        partial |= output_partial;
        for (path, (additions, deletions)) in stats {
            let entry = totals.entry(path).or_insert((0usize, 0usize));
            entry.0 = entry.0.saturating_add(additions);
            entry.1 = entry.1.saturating_add(deletions);
        }
    }
    (totals, partial)
}

fn parse_git_numstat(output: &str) -> (HashMap<String, (usize, usize)>, bool) {
    let mut totals = HashMap::new();
    let mut partial = false;
    for line in output.lines() {
        let mut parts = line.splitn(3, '\t');
        let additions = parts.next().unwrap_or_default();
        let deletions = parts.next().unwrap_or_default();
        let path = parts.next().unwrap_or_default();
        if path.is_empty() {
            continue;
        }
        let (Ok(additions), Ok(deletions)) = (additions.parse(), deletions.parse()) else {
            partial = true;
            continue;
        };
        totals.insert(path.to_string(), (additions, deletions));
    }
    (totals, partial)
}

fn untracked_text_additions(repo_root: &Path, relative_path: &str) -> (usize, bool) {
    let path = repo_root.join(relative_path);
    let Ok(metadata) = fs::metadata(&path) else {
        return (0, true);
    };
    if !metadata.is_file() || metadata.len() > MAX_WORKSPACE_FILE_EDIT_BYTES as u64 {
        return (0, metadata.is_file());
    }
    let Ok(bytes) = fs::read(path) else {
        return (0, true);
    };
    if bytes.contains(&0) {
        return (0, false);
    }
    let lines = bytes.iter().filter(|byte| **byte == b'\n').count()
        + usize::from(!bytes.is_empty() && bytes.last() != Some(&b'\n'));
    (lines, false)
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
async fn create_terminal_pane(
    manager: tauri::State<'_, TerminalProcessManager>,
    request: TerminalPaneRequest,
) -> Result<TerminalPaneSnapshot, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.create(request).map_err(to_string))
        .await
        .map_err(|error| format!("terminal create worker failed: {error}"))?
}

#[tauri::command]
async fn write_terminal_input(
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
async fn read_terminal_output(
    manager: tauri::State<'_, TerminalProcessManager>,
    pane_id: String,
) -> Result<TerminalPaneSnapshot, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.read(&pane_id).map_err(to_string))
        .await
        .map_err(|error| format!("terminal read worker failed: {error}"))?
}

#[tauri::command]
async fn resize_terminal_pane(
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
async fn stop_terminal_pane(
    manager: tauri::State<'_, TerminalProcessManager>,
    pane_id: String,
) -> Result<TerminalPaneSnapshot, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.stop(&pane_id).map_err(to_string))
        .await
        .map_err(|error| format!("terminal stop worker failed: {error}"))?
}

#[tauri::command]
async fn restart_terminal_pane(
    manager: tauri::State<'_, TerminalProcessManager>,
    pane_id: String,
) -> Result<TerminalPaneSnapshot, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.restart(&pane_id).map_err(to_string))
        .await
        .map_err(|error| format!("terminal restart worker failed: {error}"))?
}

#[tauri::command]
async fn restore_terminal_panes(
    manager: tauri::State<'_, TerminalProcessManager>,
) -> Result<Vec<TerminalPaneSnapshot>, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.restore().map_err(to_string))
        .await
        .map_err(|error| format!("terminal restore worker failed: {error}"))?
}

#[tauri::command]
async fn check_provider_health(
    request: ProviderHealthRequest,
) -> Result<ProviderHealthCheck, String> {
    tauri::async_runtime::spawn_blocking(move || check_provider_health_blocking(request))
        .await
        .map_err(|error| format!("provider health worker failed: {error}"))?
}

fn check_provider_health_blocking(
    request: ProviderHealthRequest,
) -> Result<ProviderHealthCheck, String> {
    ProviderHealthService::default()
        .check(request)
        .map_err(to_string)
}

#[tauri::command]
async fn check_provider_auth(provider_id: String) -> Result<ProviderHealthCheck, String> {
    tauri::async_runtime::spawn_blocking(move || {
        check_provider_health_blocking(ProviderHealthRequest {
            provider_id,
            api_key_ref: None,
            base_url: None,
        })
    })
    .await
    .map_err(|error| format!("provider auth worker failed: {error}"))?
}

#[tauri::command]
async fn export_diagnostics() -> Result<DiagnosticsExportResult, String> {
    tauri::async_runtime::spawn_blocking(export_diagnostics_blocking)
        .await
        .map_err(|error| format!("diagnostics export worker failed: {error}"))?
}

fn export_diagnostics_blocking() -> Result<DiagnosticsExportResult, String> {
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    paths.ensure().map_err(to_string)?;
    let config = GyroConfig::load(&paths).map_err(to_string)?;
    let store = SessionStore::open(paths.clone()).map_err(to_string)?;
    let sessions = store.list_sessions().map_err(to_string)?;
    let provider_health = collect_provider_health_for_diagnostics(&config);
    let mut recent_run_diagnostics = Vec::new();
    let mut session_summaries = Vec::new();

    for session in sessions.iter().take(25) {
        let events = store.read_events(session.id).unwrap_or_default();
        session_summaries.push(DiagnosticsSessionSummary {
            id: session.id.to_string(),
            title: gyro_core::sanitize_harness_text(&session.title),
            origin: session_origin_label(&session.origin).into(),
            workspace_mode: session_workspace_mode_label(&session.workspace_mode).into(),
            branch: gyro_core::sanitize_harness_text(&session.branch),
            provider_id: session.provider_id.clone(),
            model_id: session.model_id.clone(),
            event_count: events.len(),
            updated_at: session.updated_at.to_rfc3339(),
        });

        for event in events.iter().rev() {
            let Some(payload) = event.payload.as_object() else {
                continue;
            };
            if payload.get("schema").and_then(|value| value.as_str())
                == Some(gyro_core::HARNESS_SCHEMA_V1)
                && payload.get("kind").and_then(|value| value.as_str())
                    == Some("provider-diagnostics")
            {
                recent_run_diagnostics.push(event.payload.clone());
                if recent_run_diagnostics.len() >= 50 {
                    break;
                }
            }
        }
        if recent_run_diagnostics.len() >= 50 {
            break;
        }
    }

    let bundle = DiagnosticsExportBundle {
        schema: gyro_core::HARNESS_SCHEMA_V1.into(),
        generated_at: chrono::Utc::now().to_rfc3339(),
        config_summary: DiagnosticsConfigSummary {
            telemetry_enabled: config.telemetry_enabled,
            require_command_approval: config.require_command_approval,
            require_file_edit_approval: config.require_file_edit_approval,
            provider_count: config.model_providers.len(),
            enabled_provider_ids: config
                .model_providers
                .iter()
                .filter(|provider| provider.enabled)
                .map(|provider| provider.id.clone())
                .collect(),
            command_profile_count: config.command_profiles.len(),
        },
        provider_health,
        recent_run_diagnostics,
        sessions: session_summaries,
    };
    let diagnostics_dir = paths.logs_dir.join("diagnostics");
    fs::create_dir_all(&diagnostics_dir).map_err(to_string)?;
    let file_name = format!(
        "gyro-diagnostics-{}.json",
        chrono::Utc::now().format("%Y%m%dT%H%M%SZ")
    );
    let path = diagnostics_dir.join(file_name);
    let raw = serde_json::to_string_pretty(&bundle).map_err(to_string)?;
    fs::write(&path, format!("{raw}\n")).map_err(to_string)?;

    Ok(DiagnosticsExportResult {
        path: path.display().to_string(),
        bundle,
    })
}

fn collect_provider_health_for_diagnostics(config: &GyroConfig) -> Vec<ProviderHealthCheck> {
    let service = ProviderHealthService::default();
    config
        .model_providers
        .iter()
        .filter_map(|provider| {
            service
                .check(ProviderHealthRequest {
                    provider_id: provider.id.clone(),
                    base_url: provider.base_url.clone(),
                    api_key_ref: Some(provider.api_key_ref.clone()),
                })
                .ok()
        })
        .collect()
}

fn session_origin_label(origin: &SessionOrigin) -> &'static str {
    match origin {
        SessionOrigin::Cli => "cli",
        SessionOrigin::Desktop => "desktop",
    }
}

fn session_workspace_mode_label(mode: &SessionWorkspaceMode) -> &'static str {
    match mode {
        SessionWorkspaceMode::Local => "local",
        SessionWorkspaceMode::Worktree => "worktree",
    }
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
    let command_path = terminal_command_path(&request.command);
    let mut command = CommandBuilder::new(command_path.as_str());
    command.args(request.args.iter().map(String::as_str));
    if let Some(cwd) = cwd.as_ref() {
        command.cwd(cwd);
    }
    configure_terminal_environment(&mut command);
    if !command_path.contains('/') {
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
        working_directory: cwd,
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

fn configure_terminal_environment(command: &mut CommandBuilder) {
    command.env_remove("NO_COLOR");
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "Gyro");
    command.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    command.env("CLICOLOR", "1");
    command.env("CLICOLOR_FORCE", "1");
    command.env("FORCE_COLOR", "1");
}

fn resolve_terminal_cwd(request: &TerminalPaneRequest) -> anyhow::Result<Option<PathBuf>> {
    let workspace = request
        .workspace_path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .map(|path| path.canonicalize())
        .transpose()?;
    let Some(mut workspace) = workspace else {
        return Ok(None);
    };
    if request.workspace_mode.as_deref() != Some("worktree") {
        workspace = terminal_local_workspace(&workspace).unwrap_or(workspace);
    }

    let Some(working_directory) = request.working_directory.as_deref() else {
        return Ok(Some(workspace));
    };
    if working_directory.trim().is_empty() || working_directory == "Workspace" {
        return Ok(Some(workspace));
    }

    let candidate = Path::new(working_directory);
    gyro_core::security::assert_path_inside_workspace(&workspace, candidate).map(Some)
}

fn terminal_local_workspace(workspace: &Path) -> anyhow::Result<PathBuf> {
    let top_level_output = command_with_gui_path("git")
        .arg("-C")
        .arg(workspace)
        .args(["rev-parse", "--show-toplevel"])
        .output()?;
    if !top_level_output.status.success() {
        return Ok(workspace.to_path_buf());
    }
    let git_top_level =
        PathBuf::from(String::from_utf8_lossy(&top_level_output.stdout).trim()).canonicalize()?;

    let common_dir_output = command_with_gui_path("git")
        .arg("-C")
        .arg(workspace)
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .output()?;
    if !common_dir_output.status.success() {
        return Ok(workspace.to_path_buf());
    }
    let git_common_dir = PathBuf::from(String::from_utf8_lossy(&common_dir_output.stdout).trim());
    let Some(repo_root) = git_common_dir.parent() else {
        return Ok(workspace.to_path_buf());
    };
    let repo_root = repo_root.canonicalize()?;
    if repo_root != git_top_level {
        return Ok(repo_root);
    }
    Ok(workspace.to_path_buf())
}

fn terminal_command_path(command: &str) -> String {
    let command = command.trim();
    if command == "zsh" && Path::new("/bin/zsh").exists() {
        return "/bin/zsh".into();
    }
    command.into()
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

fn run_provider_chat_with_retry(
    store: &SessionStore,
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    binding: Option<ProviderSessionBinding>,
) -> anyhow::Result<ProviderRunnerOutput> {
    let binding_cursor = binding
        .as_ref()
        .and_then(|binding| provider_resume_cursor_from_binding(binding));
    match run_provider_chat_once(app, request, binding_cursor.as_ref()) {
        Ok(mut output) => {
            output.resumed = binding_cursor.is_some();
            Ok(output)
        }
        Err(error) if binding.is_some() && is_stale_resume_error(&error.to_string()) => {
            let session_id =
                parse_uuid(&request.session_id).map_err(|error| anyhow::anyhow!(error))?;
            let _ = store.clear_provider_session_binding(session_id, &request.provider_id);
            let mut output = run_provider_chat_once(app, request, None)?;
            output.retry_count = 1;
            output.resumed = false;
            output.output_summary = Some("stale resume cursor cleared and request retried".into());
            Ok(output)
        }
        Err(error) => {
            if let Some(binding) = binding {
                let _ = store.upsert_provider_session_binding(
                    binding.session_id,
                    binding.provider_id,
                    binding.model_id,
                    binding.model_label,
                    binding.reasoning_effort,
                    binding.resume_cursor_json,
                    "failed",
                    Some(gyro_core::security::redact_secrets(&error.to_string())),
                );
            }
            Err(error)
        }
    }
}

fn run_provider_chat_once(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    resume_cursor: Option<&ProviderResumeCursor>,
) -> anyhow::Result<ProviderRunnerOutput> {
    match provider_adapter_for(&request.provider_id).kind {
        ProviderAdapterKind::OpenAiCodex => run_openai_codex_chat(app, request, resume_cursor),
        ProviderAdapterKind::AnthropicClaude => run_anthropic_claude_chat(app, request, resume_cursor),
        ProviderAdapterKind::ReadinessOnly => anyhow::bail!(
            "{} is readiness-only in Gyro V1. Chat execution for this provider has not been implemented yet.",
            request.provider_label.as_deref().unwrap_or("Provider")
        ),
    }
}

fn provider_resume_cursor_from_binding(
    binding: &ProviderSessionBinding,
) -> Option<ProviderResumeCursor> {
    serde_json::from_value::<ProviderResumeCursor>(binding.resume_cursor_json.clone()).ok()
}

fn run_openai_codex_chat(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    resume_cursor: Option<&ProviderResumeCursor>,
) -> anyhow::Result<ProviderRunnerOutput> {
    if request.reasoning_effort.is_some()
        && codex_reasoning_effort_arg(
            request.model_id.as_deref(),
            request.reasoning_effort.as_deref(),
        )
        .is_none()
    {
        anyhow::bail!(
            "{} does not support the selected {} reasoning effort in this Gyro runtime.",
            request.model_label.as_deref().unwrap_or("This model"),
            request.reasoning_effort.as_deref().unwrap_or("unknown")
        );
    }
    let output_path =
        std::env::temp_dir().join(format!("gyro-codex-response-{}.txt", Uuid::new_v4()));
    let cwd = provider_chat_cwd(request.workspace_path.as_deref())?;
    let prompt = openai_codex_chat_prompt(
        &request.message,
        request.workspace_path.as_deref(),
        request.suggest_title,
    );

    let mut process = command_with_gui_path("codex");
    process.current_dir(cwd);
    process.args(codex_chat_args(
        resume_cursor.and_then(|cursor| {
            (cursor.kind == "codex-session").then_some(cursor.session_id.as_str())
        }),
        &output_path,
        request.model_id.as_deref(),
        request.reasoning_effort.as_deref(),
        &prompt,
    ));

    let output =
        run_streaming_command(process, Duration::from_secs(CODEX_CHAT_TIMEOUT_SECS), app, request)
            .map_err(|error| {
            anyhow::anyhow!(
                "Could not complete OpenAI through Codex CLI. Run `codex login` in Terminal if needed, then try again. {error}"
            )
        })?;
    let last_message = fs::read_to_string(&output_path).unwrap_or_default();
    let _ = fs::remove_file(&output_path);
    if output.status_success {
        let response = sanitize_provider_chat_response(last_message.trim());
        if !response.is_empty() {
            let response_chars = response.chars().count();
            let provider_session_id = output.provider_session_id.clone();
            return Ok(ProviderRunnerOutput {
                response,
                resume_cursor: provider_session_id
                    .clone()
                    .map(|session_id| ProviderResumeCursor {
                        kind: "codex-session".into(),
                        session_id,
                    }),
                retry_count: 0,
                resumed: resume_cursor.is_some(),
                output_summary: Some(provider_output_summary(
                    "codex-cli",
                    output.status_label.as_str(),
                    provider_session_id.as_deref(),
                    response_chars,
                )),
            });
        }
        let stdout = sanitize_provider_chat_response(output.stdout.trim());
        if !stdout.is_empty() {
            let response_chars = stdout.chars().count();
            let provider_session_id = output.provider_session_id.clone();
            return Ok(ProviderRunnerOutput {
                response: stdout,
                resume_cursor: provider_session_id
                    .clone()
                    .map(|session_id| ProviderResumeCursor {
                        kind: "codex-session".into(),
                        session_id,
                    }),
                retry_count: 0,
                resumed: resume_cursor.is_some(),
                output_summary: Some(provider_output_summary(
                    "codex-cli",
                    output.status_label.as_str(),
                    provider_session_id.as_deref(),
                    response_chars,
                )),
            });
        }
        anyhow::bail!("OpenAI finished, but Codex did not return a chat response.");
    }

    let mut combined = String::new();
    combined.push_str(&output.stdout);
    combined.push_str(&output.stderr);
    let combined = gyro_core::security::redact_secrets(combined.trim());
    if combined.is_empty() {
        anyhow::bail!("OpenAI through Codex exited with {}", output.status_label);
    }
    anyhow::bail!("{}", truncate_error_detail(&combined));
}

fn run_anthropic_claude_chat(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    resume_cursor: Option<&ProviderResumeCursor>,
) -> anyhow::Result<ProviderRunnerOutput> {
    let cwd = provider_chat_cwd(request.workspace_path.as_deref())?;
    let prompt = claude_chat_prompt(
        &request.message,
        request.workspace_path.as_deref(),
        request.suggest_title,
    );
    let session_id = resume_cursor
        .and_then(|cursor| (cursor.kind == "claude-session").then_some(cursor.session_id.clone()))
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let mut process = command_with_gui_path("claude");
    process.current_dir(cwd);
    process.args(claude_chat_args(
        resume_cursor
            .filter(|cursor| cursor.kind == "claude-session")
            .map(|_| session_id.as_str()),
        &session_id,
        request.model_id.as_deref(),
        &prompt,
    ));

    let output =
        run_streaming_command(process, Duration::from_secs(CODEX_CHAT_TIMEOUT_SECS), app, request)
            .map_err(|error| {
                anyhow::anyhow!(
                    "Could not complete Anthropic through Claude Code. Run `claude auth login` in Terminal if needed, then try again. {error}"
                )
            })?;
    if output.status_success {
        let response = sanitize_provider_chat_response(
            output
                .assistant_text
                .as_deref()
                .filter(|text| !text.trim().is_empty())
                .unwrap_or(output.stdout.trim()),
        );
        if response.is_empty() {
            anyhow::bail!("Anthropic finished, but Claude did not return a chat response.");
        }
        let response_chars = response.chars().count();
        let provider_session_id = session_id.clone();
        return Ok(ProviderRunnerOutput {
            response,
            resume_cursor: Some(ProviderResumeCursor {
                kind: "claude-session".into(),
                session_id: provider_session_id.clone(),
            }),
            retry_count: 0,
            resumed: resume_cursor.is_some(),
            output_summary: Some(provider_output_summary(
                "claude-code",
                output.status_label.as_str(),
                Some(provider_session_id.as_str()),
                response_chars,
            )),
        });
    }

    let combined =
        gyro_core::security::redact_secrets(format!("{}{}", output.stdout, output.stderr).trim());
    if combined.is_empty() {
        anyhow::bail!(
            "Anthropic through Claude exited with {}",
            output.status_label
        );
    }
    anyhow::bail!("{}", truncate_error_detail(&combined));
}

fn codex_chat_args(
    resume_session_id: Option<&str>,
    output_path: &Path,
    model_id: Option<&str>,
    reasoning_effort: Option<&str>,
    prompt: &str,
) -> Vec<String> {
    let mut args = vec!["exec".into()];
    if resume_session_id.is_some() {
        args.push("resume".into());
    } else {
        args.extend([
            "--skip-git-repo-check".into(),
            "--sandbox".into(),
            "read-only".into(),
        ]);
    }
    args.push("--json".into());
    args.push("--output-last-message".into());
    args.push(output_path.display().to_string());
    if resume_session_id.is_some() {
        args.push("--skip-git-repo-check".into());
    }
    if let Some(model) = codex_model_arg(model_id) {
        args.push("--model".into());
        args.push(model);
    }
    if let Some(effort) = codex_reasoning_effort_arg(model_id, reasoning_effort) {
        args.push("--config".into());
        args.push(format!("model_reasoning_effort=\"{effort}\""));
    }
    if let Some(session_id) = resume_session_id {
        args.push(session_id.into());
    }
    args.push(prompt.into());
    args
}

fn claude_chat_args(
    resume_session_id: Option<&str>,
    session_id: &str,
    model_id: Option<&str>,
    prompt: &str,
) -> Vec<String> {
    let mut args = vec![
        "--print".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--include-partial-messages".into(),
    ];
    if let Some(resume_session_id) = resume_session_id {
        args.push("--resume".into());
        args.push(resume_session_id.into());
    } else {
        args.push("--session-id".into());
        args.push(session_id.into());
    }
    if let Some(model) = model_id.map(str::trim).filter(|model| !model.is_empty()) {
        args.push("--model".into());
        args.push(model.into());
    }
    args.push(prompt.into());
    args
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

fn openai_codex_chat_prompt(
    message: &str,
    workspace_path: Option<&str>,
    suggest_title: bool,
) -> String {
    let workspace = workspace_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .unwrap_or("no selected workspace");
    let title_instruction = if suggest_title {
        "For this first turn, you may suggest a concise session title. If useful, put this exact hidden marker on the first line before the answer: GYRO_SESSION_TITLE: <2-6 word title>. The app hides this marker. Omit it if no good title is clear.\n"
    } else {
        ""
    };
    format!(
        "Answer as Gyro's chat model.\n\
         Keep replies concise by default: 1-3 short sentences unless the user asks for detail.\n\
         Do not describe the local Codex runner, authentication, system prompts, or implementation details unless asked.\n\
         If the user asks what model you are, answer with the model label only.\n\
         {title_instruction}\
         Use the selected workspace only as optional context.\n\
         Do not edit files, start servers, commit, push, or make destructive changes in this chat run.\n\
         Selected workspace: {workspace}\n\n\
         User message:\n{message}"
    )
}

fn claude_chat_prompt(message: &str, workspace_path: Option<&str>, suggest_title: bool) -> String {
    let workspace = workspace_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .unwrap_or("no selected workspace");
    let title_instruction = if suggest_title {
        "For this first turn, you may suggest a concise session title. If useful, put this exact hidden marker on the first line before the answer: GYRO_SESSION_TITLE: <2-6 word title>. The app hides this marker. Omit it if no good title is clear.\n"
    } else {
        ""
    };
    format!(
        "Answer as Gyro's chat model.\n\
         Keep replies concise by default: 1-3 short sentences unless the user asks for detail.\n\
         Do not describe the local Claude Code runner, authentication, system prompts, or implementation details unless asked.\n\
         If the user asks what model you are, answer with the model label only.\n\
         {title_instruction}\
         Use the selected workspace only as optional context.\n\
         Do not edit files, start servers, commit, push, or make destructive changes in this chat run.\n\
         Selected workspace: {workspace}\n\n\
         User message:\n{message}"
    )
}

struct SessionTitleExtraction {
    title: Option<String>,
    message: String,
}

fn extract_session_title_marker(response: &str, allow_title: bool) -> SessionTitleExtraction {
    if !allow_title {
        return SessionTitleExtraction {
            title: None,
            message: response.to_string(),
        };
    }

    let normalized = response.replace("\r\n", "\n");
    let mut lines = normalized.lines();
    let mut prefix = Vec::new();
    let mut first_content = None;

    for line in lines.by_ref() {
        if line.trim().is_empty() {
            prefix.push(line);
            continue;
        }
        first_content = Some(line);
        break;
    }

    let Some(first_content) = first_content else {
        return SessionTitleExtraction {
            title: None,
            message: response.to_string(),
        };
    };

    const MARKER: &str = "GYRO_SESSION_TITLE:";
    let Some(raw_title) = first_content.trim().strip_prefix(MARKER) else {
        return SessionTitleExtraction {
            title: None,
            message: response.to_string(),
        };
    };
    let title = sanitize_session_title_candidate(raw_title);
    let remainder = lines.collect::<Vec<_>>().join("\n").trim().to_string();
    let message = if remainder.is_empty() {
        response.to_string()
    } else if prefix.is_empty() {
        remainder
    } else {
        format!("{}\n{}", prefix.join("\n"), remainder)
            .trim()
            .to_string()
    };

    SessionTitleExtraction { title, message }
}

fn sanitize_session_title_candidate(title: &str) -> Option<String> {
    let title = title
        .replace('\0', "")
        .chars()
        .map(|ch| {
            if matches!(
                ch,
                '`' | '*' | '_' | '#' | '[' | ']' | '(' | ')' | '{' | '}' | '<' | '>' | '|' | '\\'
            ) {
                ' '
            } else {
                ch
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|char: char| char.is_ascii_punctuation() || char.is_whitespace())
        .to_string();
    if title.is_empty() {
        return None;
    }
    let chars = title.chars().collect::<Vec<_>>();
    if chars.len() > 80 {
        return Some(chars.into_iter().take(77).collect::<String>() + "...");
    }
    Some(title)
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

fn codex_reasoning_effort_arg(
    model_id: Option<&str>,
    reasoning_effort: Option<&str>,
) -> Option<String> {
    let effort = reasoning_effort?.trim().to_ascii_lowercase();
    let model = model_id?.trim().to_ascii_lowercase();
    let supported = match model.as_str() {
        "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna" => {
            matches!(
                effort.as_str(),
                "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
            )
        }
        "gpt-5.5" | "gpt-5.4" | "gpt-5.4-mini" | "gpt-5" => {
            matches!(effort.as_str(), "low" | "medium" | "high" | "xhigh")
        }
        _ => false,
    };
    supported.then_some(effort)
}

fn append_provider_status_event(
    store: &SessionStore,
    session_id: Uuid,
    request: &ProviderChatRequest,
    turn_id: Option<Uuid>,
    attempt_id: Uuid,
    status: HarnessRunStatus,
    error: Option<&str>,
) -> anyhow::Result<SessionEvent> {
    let provider_label = request.provider_label.as_deref().unwrap_or("Provider");
    let adapter = provider_adapter_for(&request.provider_id);
    let payload = ProviderRunPayload::new(
        turn_id.unwrap_or_else(Uuid::new_v4),
        attempt_id,
        "desktop",
        status.clone(),
        request.provider_id.clone(),
        request.provider_label.clone(),
        request.model_id.clone(),
        request.model_label.clone(),
        Some(chat_message_preview(&request.message)),
        Some(adapter.runner.into()),
        Some(adapter.auth_owner.into()),
        false,
        0,
        Some(adapter.timeout_seconds),
    );
    let mut payload = gyro_core::harness_payload_value(&payload)?;
    if let Some(object) = payload.as_object_mut() {
        object.insert(
            "reasoningEffort".into(),
            request
                .reasoning_effort
                .clone()
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null),
        );
        object.insert(
            "kind".into(),
            serde_json::Value::String("provider-status".into()),
        );
        object.insert(
            "error".into(),
            error
                .map(gyro_core::sanitize_harness_text)
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null),
        );
        object.insert(
            "turnId".into(),
            turn_id
                .map(|id| serde_json::Value::String(id.to_string()))
                .unwrap_or(serde_json::Value::Null),
        );
    }
    store.append_event_with_turn_id(
        session_id,
        SessionEventKind::SystemEvent,
        provider_chat_status_message(&status, provider_label),
        payload,
        turn_id,
    )
}

fn append_provider_diagnostics_event(
    store: &SessionStore,
    session_id: Uuid,
    request: &ProviderChatRequest,
    turn_id: Option<Uuid>,
    attempt_id: Uuid,
    status: HarnessRunStatus,
    started_at: chrono::DateTime<chrono::Utc>,
    retry_count: u32,
    resumed: bool,
    failure_reason: Option<&str>,
    output_summary: Option<&str>,
) -> anyhow::Result<SessionEvent> {
    let adapter = provider_adapter_for(&request.provider_id);
    let completed_at = chrono::Utc::now();
    let payload = ProviderDiagnosticsPayload::new(
        turn_id.unwrap_or_else(Uuid::new_v4),
        attempt_id,
        request.provider_id.clone(),
        request.model_id.clone(),
        status.clone(),
        started_at,
        completed_at,
        retry_count,
        resumed,
        Some(adapter.timeout_seconds),
        failure_reason.map(str::to_string),
        output_summary.map(str::to_string),
    );
    let mut payload = gyro_core::harness_payload_value(&payload)?;
    if let Some(object) = payload.as_object_mut() {
        object.insert(
            "reasoningEffort".into(),
            request
                .reasoning_effort
                .clone()
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null),
        );
    }
    store.append_event_with_turn_id(
        session_id,
        SessionEventKind::SystemEvent,
        provider_diagnostics_message(&status, request.provider_label.as_deref()),
        payload,
        turn_id,
    )
}

fn provider_chat_status_message(status: &HarnessRunStatus, provider_label: &str) -> String {
    match status {
        HarnessRunStatus::Failed => format!("{provider_label} send needs attention"),
        HarnessRunStatus::Blocked => format!("{provider_label} is not available for chat yet"),
        HarnessRunStatus::Done => format!("{provider_label} answered"),
        HarnessRunStatus::Running => format!("{provider_label} is working"),
        HarnessRunStatus::Waiting => format!("{provider_label} is waiting for approval"),
        HarnessRunStatus::Cancelled => format!("{provider_label} was cancelled"),
        HarnessRunStatus::Queued => format!("{provider_label} queued this request"),
    }
}

fn provider_diagnostics_message(status: &HarnessRunStatus, provider_label: Option<&str>) -> String {
    let provider_label = provider_label.unwrap_or("Provider");
    match status {
        HarnessRunStatus::Done => format!("{provider_label} diagnostics recorded"),
        HarnessRunStatus::Blocked => format!("{provider_label} blocked diagnostics recorded"),
        HarnessRunStatus::Failed => format!("{provider_label} failure diagnostics recorded"),
        _ => format!("{provider_label} queued this request"),
    }
}

fn validate_chat_message(message: &str) -> Result<String, String> {
    let message = message.replace('\0', "").trim().to_string();
    if message.is_empty() {
        return Err("chat message is required".into());
    }
    if message.chars().count() > MAX_CHAT_MESSAGE_CHARS {
        return Err(format!(
            "chat message cannot exceed {MAX_CHAT_MESSAGE_CHARS} characters"
        ));
    }
    Ok(message)
}

fn chat_message_preview(message: &str) -> String {
    let normalized = message.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate_chars(&normalized, 160)
}

fn sanitize_provider_chat_response(response: &str) -> String {
    let redacted = gyro_core::security::redact_secrets(response.trim());
    truncate_chars(&redacted, MAX_CHAT_RESPONSE_CHARS)
}

fn sanitize_provider_text_delta(delta: &str) -> String {
    let redacted = gyro_core::security::redact_secrets(delta);
    truncate_chars(&redacted, MAX_CHAT_RESPONSE_CHARS)
}

fn truncate_error_detail(value: &str) -> String {
    const MAX_ERROR_DETAIL_CHARS: usize = 4_000;
    truncate_chars(value, MAX_ERROR_DETAIL_CHARS)
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.len() <= max_chars {
        return value.to_string();
    }
    let Some((truncate_at, _)) = value.char_indices().nth(max_chars) else {
        return value.to_string();
    };
    format!("{}{}", &value[..truncate_at], TEXT_TRUNCATION_SUFFIX)
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct BoundedPushResult {
    accepted_chars: usize,
    truncated: bool,
}

fn push_bounded(
    target: &mut String,
    target_chars: &mut usize,
    value: &str,
    max_chars: usize,
) -> BoundedPushResult {
    if value.is_empty() {
        return BoundedPushResult::default();
    }
    let remaining_chars = max_chars.saturating_sub(*target_chars);
    let value_chars = value.chars().count();
    if value_chars <= remaining_chars {
        target.push_str(value);
        *target_chars += value_chars;
        return BoundedPushResult {
            accepted_chars: value_chars,
            truncated: false,
        };
    }

    target.extend(value.chars().take(remaining_chars));
    target.push_str(TEXT_TRUNCATION_SUFFIX);
    *target_chars += remaining_chars;
    BoundedPushResult {
        accepted_chars: remaining_chars,
        truncated: true,
    }
}

struct StreamingCommandOutput {
    status_success: bool,
    status_label: String,
    stdout: String,
    stderr: String,
    assistant_text: Option<String>,
    provider_session_id: Option<String>,
}

struct StreamingCommandState {
    stdout_text: String,
    stdout_text_chars: usize,
    stdout_text_truncated: bool,
    assistant_text: String,
    assistant_text_chars: usize,
    assistant_text_truncated: bool,
    pending_delta_chunks: Vec<String>,
    pending_delta_chars: usize,
    provider_session_id: Option<String>,
    last_emit_at: Instant,
}

impl StreamingCommandState {
    fn new() -> Self {
        Self {
            stdout_text: String::new(),
            stdout_text_chars: 0,
            stdout_text_truncated: false,
            assistant_text: String::new(),
            assistant_text_chars: 0,
            assistant_text_truncated: false,
            pending_delta_chunks: Vec::new(),
            pending_delta_chars: 0,
            provider_session_id: None,
            last_emit_at: Instant::now(),
        }
    }

    fn push_stdout(&mut self, line: &str) {
        if self.stdout_text_truncated {
            return;
        }
        self.stdout_text_truncated = push_bounded(
            &mut self.stdout_text,
            &mut self.stdout_text_chars,
            line,
            MAX_CHAT_RESPONSE_CHARS * 4,
        )
        .truncated;
    }

    fn push_assistant_delta(&mut self, delta: &str) {
        if self.assistant_text_truncated {
            return;
        }
        let result = push_bounded(
            &mut self.assistant_text,
            &mut self.assistant_text_chars,
            delta,
            MAX_CHAT_RESPONSE_CHARS,
        );
        self.assistant_text_truncated = result.truncated;
        if result.truncated {
            let mut accepted_delta = delta
                .chars()
                .take(result.accepted_chars)
                .collect::<String>();
            accepted_delta.push_str(TEXT_TRUNCATION_SUFFIX);
            self.push_pending_delta(&accepted_delta);
        } else {
            self.push_pending_delta(delta);
        }
    }

    fn push_assistant_snapshot(&mut self, snapshot: &str) {
        if snapshot.is_empty() {
            return;
        }
        if self.assistant_text.is_empty() {
            self.push_assistant_delta(snapshot);
            return;
        }
        if let Some(delta) = snapshot.strip_prefix(&self.assistant_text) {
            self.push_assistant_delta(delta);
        }
    }

    fn push_pending_delta(&mut self, delta: &str) {
        let max_pending_chars = MAX_CHAT_RESPONSE_CHARS + TEXT_TRUNCATION_SUFFIX.len();
        if delta.is_empty() || self.pending_delta_chars >= max_pending_chars {
            return;
        }
        let remaining_chars = max_pending_chars - self.pending_delta_chars;
        let delta_chars = delta.chars().count();
        if delta_chars <= remaining_chars {
            self.pending_delta_chunks.push(delta.to_string());
            self.pending_delta_chars += delta_chars;
            return;
        }
        let truncated_delta = delta.chars().take(remaining_chars).collect::<String>();
        self.pending_delta_chunks.push(truncated_delta);
        self.pending_delta_chars = max_pending_chars;
    }

    fn take_pending_delta(&mut self) -> String {
        self.pending_delta_chars = 0;
        std::mem::take(&mut self.pending_delta_chunks).join("")
    }

    fn has_pending_delta(&self) -> bool {
        !self.pending_delta_chunks.is_empty()
    }

    fn flush_pending_delta(
        &mut self,
        app: &tauri::AppHandle,
        request: &ProviderChatRequest,
        force: bool,
    ) {
        if !self.has_pending_delta() {
            return;
        }
        if !force && self.last_emit_at.elapsed() < PROVIDER_STREAM_FLUSH_INTERVAL {
            return;
        }
        let delta = self.take_pending_delta();
        self.last_emit_at = Instant::now();
        emit_provider_chat_event(
            app,
            request,
            "delta",
            Some(HarnessRunStatus::Running),
            Some(delta),
            None,
            None,
        );
    }
}

fn run_streaming_command(
    mut command: Command,
    timeout: Duration,
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
) -> anyhow::Result<StreamingCommandOutput> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("provider stdout was unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow::anyhow!("provider stderr was unavailable"))?;
    let (stdout_tx, stdout_rx) = mpsc::channel::<String>();
    let stdout_handle = std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    let _ = stdout_tx.send(line.clone());
                }
                Err(_) => break,
            }
        }
    });
    let stderr_handle = std::thread::spawn(move || {
        let mut buffer = String::new();
        let mut reader = BufReader::new(stderr);
        let _ = reader.read_to_string(&mut buffer);
        buffer
    });

    let started_at = Instant::now();
    let mut stream_state = StreamingCommandState::new();
    let status = loop {
        while let Ok(line) = stdout_rx.try_recv() {
            handle_provider_stdout_line(&line, app, request, &mut stream_state);
        }
        stream_state.flush_pending_delta(app, request, false);
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started_at.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            anyhow::bail!("command timed out after {} seconds", timeout.as_secs());
        }
        std::thread::sleep(Duration::from_millis(40));
    };
    let _ = stdout_handle.join();
    while let Ok(line) = stdout_rx.try_recv() {
        handle_provider_stdout_line(&line, app, request, &mut stream_state);
    }
    stream_state.flush_pending_delta(app, request, true);
    let stderr_text = stderr_handle.join().unwrap_or_default();
    Ok(StreamingCommandOutput {
        status_success: status.success(),
        status_label: status.to_string(),
        stdout: stream_state.stdout_text,
        stderr: stderr_text,
        assistant_text: (!stream_state.assistant_text.trim().is_empty())
            .then_some(stream_state.assistant_text),
        provider_session_id: stream_state.provider_session_id,
    })
}

fn handle_provider_stdout_line(
    line: &str,
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    stream_state: &mut StreamingCommandState,
) {
    stream_state.push_stdout(line);
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
        return;
    };
    if stream_state.provider_session_id.is_none() {
        stream_state.provider_session_id = extract_provider_session_id(&value);
    }
    if let Some(chunk) = extract_provider_text_chunk(&value) {
        match chunk {
            ProviderTextChunk::Delta(delta) => {
                let delta = sanitize_provider_text_delta(&delta);
                if delta.is_empty() {
                    return;
                }
                stream_state.push_assistant_delta(&delta);
            }
            ProviderTextChunk::Snapshot(snapshot) => {
                let snapshot = sanitize_provider_text_delta(&snapshot);
                stream_state.push_assistant_snapshot(&snapshot);
            }
            ProviderTextChunk::Final(text) => {
                if !stream_state.assistant_text.trim().is_empty() {
                    return;
                }
                let text = sanitize_provider_text_delta(&text);
                if text.is_empty() {
                    return;
                }
                stream_state.push_assistant_delta(&text);
            }
        }
        stream_state.flush_pending_delta(app, request, false);
    }
}

fn emit_provider_chat_event(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    phase: &str,
    status: Option<HarnessRunStatus>,
    text_delta: Option<String>,
    message: Option<String>,
    error: Option<String>,
) {
    let payload = ProviderChatStreamEvent {
        session_id: request.session_id.clone(),
        turn_id: request.turn_id.clone(),
        provider_id: request.provider_id.clone(),
        model_id: request.model_id.clone(),
        event_id: Uuid::new_v4().to_string(),
        phase: phase.into(),
        status: status.map(|status| status.as_str().to_string()),
        text_delta,
        message,
        error,
    };
    let _ = app.emit(PROVIDER_CHAT_EVENT, payload);
}

fn extract_provider_session_id(value: &serde_json::Value) -> Option<String> {
    for key in [
        "session_id",
        "sessionId",
        "conversation_id",
        "conversationId",
        "thread_id",
        "threadId",
    ] {
        if let Some(id) = value.get(key).and_then(|item| item.as_str()) {
            if looks_like_session_id(id) {
                return Some(id.to_string());
            }
        }
    }
    match value {
        serde_json::Value::Array(items) => items.iter().find_map(extract_provider_session_id),
        serde_json::Value::Object(map) => map.values().find_map(extract_provider_session_id),
        _ => None,
    }
}

fn looks_like_session_id(value: &str) -> bool {
    let value = value.trim();
    Uuid::parse_str(value).is_ok()
        || (value.len() >= 12
            && value.len() <= 128
            && value
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.')))
}

enum ProviderTextChunk {
    Delta(String),
    Snapshot(String),
    Final(String),
}

#[cfg(test)]
fn extract_provider_text_delta(value: &serde_json::Value) -> Option<String> {
    extract_provider_text_chunk(value).map(|chunk| match chunk {
        ProviderTextChunk::Delta(text)
        | ProviderTextChunk::Snapshot(text)
        | ProviderTextChunk::Final(text) => text,
    })
}

fn extract_provider_text_chunk(value: &serde_json::Value) -> Option<ProviderTextChunk> {
    if let Some(delta) = value.pointer("/delta/text").and_then(|item| item.as_str()) {
        return Some(ProviderTextChunk::Delta(delta.to_string()));
    }
    if let Some(delta) = value
        .pointer("/message/delta/text")
        .and_then(|item| item.as_str())
    {
        return Some(ProviderTextChunk::Delta(delta.to_string()));
    }
    if let Some(delta) = value.get("text_delta").and_then(|item| item.as_str()) {
        return Some(ProviderTextChunk::Delta(delta.to_string()));
    }
    if let Some(delta) = value.get("textDelta").and_then(|item| item.as_str()) {
        return Some(ProviderTextChunk::Delta(delta.to_string()));
    }
    let event_type = value
        .get("type")
        .or_else(|| value.get("event"))
        .and_then(|item| item.as_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if event_type.contains("delta") {
        if let Some(delta) = value.get("delta").and_then(extract_provider_text_value) {
            return Some(ProviderTextChunk::Delta(delta.to_string()));
        }
        for key in ["text", "content", "message"] {
            if let Some(delta) = value.get(key).and_then(extract_provider_text_value) {
                return Some(ProviderTextChunk::Delta(delta));
            }
        }
    }
    if event_type.contains("partial") {
        for key in ["text", "content", "message"] {
            if let Some(snapshot) = value.get(key).and_then(extract_provider_text_value) {
                return Some(ProviderTextChunk::Snapshot(snapshot));
            }
        }
    }
    if let Some(text) = extract_codex_agent_message_text(value) {
        return Some(ProviderTextChunk::Final(text));
    }
    None
}

fn extract_provider_text_value(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) => Some(text.clone()),
        serde_json::Value::Array(items) => {
            let text = items
                .iter()
                .filter_map(extract_provider_text_value)
                .collect::<String>();
            (!text.is_empty()).then_some(text)
        }
        serde_json::Value::Object(map) => {
            let item_type = map.get("type").and_then(|item| item.as_str());
            if matches!(item_type, Some("reasoning" | "reasoning_text")) {
                return None;
            }
            map.get("text")
                .or_else(|| map.get("content"))
                .and_then(extract_provider_text_value)
        }
        _ => None,
    }
}

fn extract_codex_agent_message_text(value: &serde_json::Value) -> Option<String> {
    let event_type = value
        .get("type")
        .or_else(|| value.get("event"))
        .and_then(|item| item.as_str())
        .unwrap_or_default();
    if event_type != "item.completed" {
        return None;
    }
    let item = value.get("item")?;
    let item_type = item.get("type").and_then(|item| item.as_str())?;
    let role = item.get("role").and_then(|item| item.as_str());
    if item_type != "agent_message"
        && item_type != "assistant_message"
        && !(item_type == "message" && role == Some("assistant"))
    {
        return None;
    }
    item.get("text")
        .or_else(|| item.get("content"))
        .and_then(extract_provider_text_value)
}

fn provider_adapter_for(provider_id: &str) -> ProviderAdapterDescriptor {
    match provider_id {
        "openai" => ProviderAdapterDescriptor {
            kind: ProviderAdapterKind::OpenAiCodex,
            runner: "codex-cli",
            auth_owner: "chatgpt-local-codex-login",
            timeout_seconds: CODEX_CHAT_TIMEOUT_SECS,
        },
        "anthropic" => ProviderAdapterDescriptor {
            kind: ProviderAdapterKind::AnthropicClaude,
            runner: "claude-code",
            auth_owner: "anthropic-local-claude-login",
            timeout_seconds: CODEX_CHAT_TIMEOUT_SECS,
        },
        "xai" | "gemini" => ProviderAdapterDescriptor {
            kind: ProviderAdapterKind::ReadinessOnly,
            runner: "readiness-only",
            auth_owner: "provider-env",
            timeout_seconds: 0,
        },
        _ => ProviderAdapterDescriptor {
            kind: ProviderAdapterKind::ReadinessOnly,
            runner: "readiness-only",
            auth_owner: "provider-owned",
            timeout_seconds: 0,
        },
    }
}

fn provider_output_summary(
    runner: &str,
    status_label: &str,
    provider_session_id: Option<&str>,
    response_chars: usize,
) -> String {
    let session_state = if provider_session_id.is_some() {
        "cursor recorded"
    } else {
        "no cursor"
    };
    gyro_core::sanitize_harness_text(&format!(
        "{runner} exited with {status_label}; {response_chars} response chars; {session_state}"
    ))
}

fn is_stale_resume_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("not found")
        || normalized.contains("no such session")
        || normalized.contains("unknown session")
        || normalized.contains("missing thread")
        || normalized.contains("could not resume")
        || normalized.contains("resume")
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
        working_directory: process
            .working_directory
            .as_ref()
            .map(|path| path.display().to_string()),
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
        .manage(LanguageServerManager::default())
        .manage(DebugAdapterManager::default())
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
            export_diagnostics,
            get_account_session,
            git_commit,
            git_diff,
            git_discard,
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
            restart_app,
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
    fn lsp_json_rpc_framing_round_trips() {
        let value = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "textDocument/hover",
            "params": { "line": 4 }
        });
        let mut framed = Vec::new();
        write_lsp_message(&mut framed, &value).unwrap();

        let decoded = read_lsp_message(&mut BufReader::new(framed.as_slice())).unwrap();

        assert_eq!(decoded, value);
        assert!(String::from_utf8_lossy(&framed).starts_with("Content-Length: "));
    }

    #[test]
    fn lsp_json_rpc_framing_accepts_case_insensitive_header() {
        let body = br#"{"jsonrpc":"2.0","method":"initialized","params":{}}"#;
        let framed = format!("content-length: {}\r\n\r\n", body.len())
            .into_bytes()
            .into_iter()
            .chain(body.iter().copied())
            .collect::<Vec<_>>();

        let decoded = read_lsp_message(&mut BufReader::new(framed.as_slice())).unwrap();

        assert_eq!(decoded["method"], "initialized");
    }

    #[test]
    fn workspace_file_uri_encodes_spaces_without_losing_path_shape() {
        let uri = workspace_file_uri(Path::new("/tmp/Gyro Workspace/src/main.ts"));

        assert_eq!(uri, "file:///tmp/Gyro%20Workspace/src/main.ts");
    }

    #[test]
    fn lsp_notification_detection_covers_document_lifecycle() {
        assert!(lsp_method_is_notification("textDocument/didOpen"));
        assert!(lsp_method_is_notification("textDocument/didChange"));
        assert!(lsp_method_is_notification("$/cancelRequest"));
        assert!(!lsp_method_is_notification("textDocument/hover"));
    }

    #[test]
    fn dap_json_rpc_framing_round_trips() {
        let value = serde_json::json!({
            "seq": 4,
            "type": "request",
            "command": "threads",
            "arguments": {}
        });
        let mut framed = Vec::new();
        write_lsp_message(&mut framed, &value).unwrap();

        let decoded = read_lsp_message(&mut BufReader::new(framed.as_slice())).unwrap();

        assert_eq!(decoded, value);
    }

    #[test]
    fn debug_adapter_manager_runs_request_lifecycle() {
        if command_with_gui_path("python3")
            .arg("--version")
            .output()
            .map(|output| !output.status.success())
            .unwrap_or(true)
        {
            return;
        }
        let workspace = tempfile::tempdir().unwrap();
        let adapter_path = workspace.path().join("fake_adapter.py");
        std::fs::write(
            &adapter_path,
            r#"import json, sys

def read_message():
    length = None
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return None
        if line in (b'\r\n', b'\n'):
            break
        if line.lower().startswith(b'content-length:'):
            length = int(line.split(b':', 1)[1].strip())
    return json.loads(sys.stdin.buffer.read(length))

def send(message):
    body = json.dumps(message).encode()
    sys.stdout.buffer.write(f'Content-Length: {len(body)}\r\n\r\n'.encode() + body)
    sys.stdout.buffer.flush()

while True:
    message = read_message()
    if message is None:
        break
    command = message.get('command', '')
    body = {'supportsConfigurationDoneRequest': True} if command == 'initialize' else {'threads': [{'id': 1, 'name': 'main'}]}
    send({'seq': message['seq'] + 100, 'type': 'response', 'request_seq': message['seq'], 'command': command, 'success': True, 'body': body})
    if command == 'disconnect':
        break
"#,
        )
        .unwrap();
        let manager = DebugAdapterManager::default();
        let session = manager
            .start(DebugStartRequest {
                workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                name: "Fake debug".into(),
                adapter: "fake".into(),
                command: Some(format!("python3 {}", adapter_path.display())),
                args: None,
            })
            .unwrap();

        assert_eq!(session.status, "configured");
        assert!(session
            .capabilities
            .contains(&"supportsConfigurationDoneRequest".to_string()));
        let response = manager
            .send(DebugSendRequest {
                session_id: session.id.clone(),
                request: serde_json::json!({ "command": "threads" }),
            })
            .unwrap();
        assert_eq!(response["response"]["body"]["threads"][0]["name"], "main");
        assert_eq!(manager.stop(&session.id).unwrap()["status"], "stopped");
    }

    #[test]
    fn debug_adapter_payloads_redact_secrets_recursively() {
        let value = redact_json_strings(serde_json::json!({
            "output": "Authorization: Bearer super-secret-value",
            "nested": ["OPENAI_API_KEY=sk-test-secret"]
        }));

        assert!(!value.to_string().contains("super-secret-value"));
        assert!(!value.to_string().contains("sk-test-secret"));
    }

    #[test]
    fn git_discard_restores_tracked_files_and_removes_untracked_files() {
        let workspace = tempfile::tempdir().unwrap();
        run_git(workspace.path(), &["init"]);
        run_git(
            workspace.path(),
            &["config", "user.email", "gyro@example.test"],
        );
        run_git(workspace.path(), &["config", "user.name", "Gyro Tests"]);
        std::fs::write(workspace.path().join("tracked.txt"), "original\n").unwrap();
        run_git(workspace.path(), &["add", "tracked.txt"]);
        run_git(workspace.path(), &["commit", "-m", "initial"]);
        std::fs::write(workspace.path().join("tracked.txt"), "changed\n").unwrap();

        git_discard_blocking(GitStageRequest {
            workspace_path: workspace.path().to_string_lossy().to_string(),
            path: "tracked.txt".into(),
        })
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(workspace.path().join("tracked.txt")).unwrap(),
            "original\n"
        );

        std::fs::write(workspace.path().join("untracked.txt"), "temporary\n").unwrap();
        git_discard_blocking(GitStageRequest {
            workspace_path: workspace.path().to_string_lossy().to_string(),
            path: "untracked.txt".into(),
        })
        .unwrap();
        assert!(!workspace.path().join("untracked.txt").exists());
    }

    #[test]
    fn language_server_manager_initializes_rust_analyzer_when_available() {
        if command_with_gui_path("rust-analyzer")
            .arg("--version")
            .output()
            .map(|output| !output.status.success())
            .unwrap_or(true)
        {
            return;
        }
        let workspace = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(workspace.path().join("src")).unwrap();
        std::fs::write(
            workspace.path().join("Cargo.toml"),
            "[package]\nname = \"lsp-check\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )
        .unwrap();
        std::fs::write(workspace.path().join("src/lib.rs"), "pub fn ready() {}\n").unwrap();
        let manager = LanguageServerManager::default();

        let session = manager
            .start(LspStartRequest {
                workspace_path: workspace.path().to_string_lossy().to_string(),
                language_id: "rust".into(),
                command: "rust-analyzer".into(),
            })
            .unwrap();

        assert_eq!(session.status, "ready");
        assert!(session.message.contains("capabilities"));
        assert_eq!(
            manager.stop(&session.server_id).unwrap()["status"],
            "stopped"
        );
    }

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
        let content = read_workspace_file_with_limit(
            workspace.path().to_str().unwrap(),
            "app.ts",
            MAX_WORKSPACE_FILE_EDIT_BYTES,
        )
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
        let content = read_workspace_file_with_limit(
            workspace.path().to_str().unwrap(),
            "app.ts",
            MAX_WORKSPACE_FILE_EDIT_BYTES,
        )
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
        let prompt = openai_codex_chat_prompt("WHAT MODEL are you?", Some("/workspace"), true);

        assert!(prompt.contains("Keep replies concise by default"));
        assert!(prompt.contains("answer with the model label only"));
        assert!(prompt.contains("Do not describe the local Codex runner"));
        assert!(prompt.contains("GYRO_SESSION_TITLE:"));
        assert!(prompt.contains("Selected workspace: /workspace"));
    }

    #[test]
    fn provider_chat_command_args_use_resume_contracts() {
        let output_path = PathBuf::from("/tmp/gyro-last-message.txt");
        let fresh_codex = codex_chat_args(
            None,
            &output_path,
            Some("gpt-5.6-sol"),
            Some("max"),
            "hello",
        );
        assert_eq!(fresh_codex[0], "exec");
        assert!(fresh_codex.contains(&"--sandbox".to_string()));
        assert!(fresh_codex.contains(&"read-only".to_string()));
        assert!(fresh_codex.contains(&"--json".to_string()));
        assert!(fresh_codex.contains(&"--output-last-message".to_string()));
        assert!(fresh_codex.contains(&"gpt-5.6-sol".to_string()));
        assert!(fresh_codex.contains(&"model_reasoning_effort=\"max\"".to_string()));
        assert_eq!(fresh_codex.last(), Some(&"hello".to_string()));

        let resumed_codex = codex_chat_args(
            Some("019f4612-7e58-7412-9fe9-5f0d6cb29c8e"),
            &output_path,
            None,
            None,
            "again",
        );
        assert_eq!(
            resumed_codex[..3],
            [
                "exec".to_string(),
                "resume".to_string(),
                "--json".to_string()
            ]
        );
        assert!(resumed_codex.contains(&"--skip-git-repo-check".to_string()));
        assert!(resumed_codex.ends_with(&[
            "019f4612-7e58-7412-9fe9-5f0d6cb29c8e".to_string(),
            "again".to_string()
        ]));

        let fresh_claude = claude_chat_args(
            None,
            "019f4612-7e58-7412-9fe9-5f0d6cb29c8e",
            Some("sonnet"),
            "hello",
        );
        assert!(fresh_claude.contains(&"--print".to_string()));
        assert!(fresh_claude.contains(&"stream-json".to_string()));
        assert!(fresh_claude.contains(&"--include-partial-messages".to_string()));
        assert!(fresh_claude.contains(&"--session-id".to_string()));
        assert!(fresh_claude.ends_with(&["sonnet".to_string(), "hello".to_string()]));

        let resumed_claude = claude_chat_args(
            Some("019f4612-7e58-7412-9fe9-5f0d6cb29c8e"),
            "unused",
            None,
            "again",
        );
        assert!(resumed_claude.contains(&"--resume".to_string()));
        assert!(resumed_claude.ends_with(&[
            "019f4612-7e58-7412-9fe9-5f0d6cb29c8e".to_string(),
            "again".to_string()
        ]));
    }

    #[test]
    fn provider_adapter_registry_keeps_xai_and_gemini_readiness_only() {
        let openai = provider_adapter_for("openai");
        assert_eq!(openai.kind, ProviderAdapterKind::OpenAiCodex);
        assert_eq!(openai.runner, "codex-cli");

        let anthropic = provider_adapter_for("anthropic");
        assert_eq!(anthropic.kind, ProviderAdapterKind::AnthropicClaude);
        assert_eq!(anthropic.runner, "claude-code");

        for provider_id in ["xai", "gemini"] {
            let adapter = provider_adapter_for(provider_id);
            assert_eq!(adapter.kind, ProviderAdapterKind::ReadinessOnly);
            assert_eq!(adapter.runner, "readiness-only");
            assert_eq!(adapter.auth_owner, "provider-env");
        }
    }

    #[test]
    fn provider_stream_parsers_extract_cursor_and_text() {
        let session_id = "019f4612-7e58-7412-9fe9-5f0d6cb29c8e";
        let nested = serde_json::json!({
            "type": "session.started",
            "data": { "sessionId": session_id }
        });
        assert_eq!(
            extract_provider_session_id(&nested).as_deref(),
            Some(session_id)
        );

        assert_eq!(
            extract_provider_text_delta(&serde_json::json!({
                "type": "content_block_delta",
                "delta": { "text": "hel" }
            }))
            .as_deref(),
            Some("hel")
        );
        assert_eq!(
            extract_provider_text_delta(&serde_json::json!({
                "type": "partial_message",
                "text": "lo"
            }))
            .as_deref(),
            Some("lo")
        );
        assert_eq!(
            extract_provider_text_delta(&serde_json::json!({
                "type": "response.output_text.delta",
                "delta": " there"
            }))
            .as_deref(),
            Some(" there")
        );
        assert_eq!(
            extract_provider_text_delta(&serde_json::json!({
                "type": "response.output_text.delta",
                "delta": { "text": " from object" }
            }))
            .as_deref(),
            Some(" from object")
        );
        assert_eq!(
            extract_provider_text_delta(&serde_json::json!({
                "type": "partial_message",
                "content": [
                    { "type": "text", "text": "hel" },
                    { "type": "text", "text": "lo" }
                ]
            }))
            .as_deref(),
            Some("hello")
        );
        assert_eq!(
            extract_provider_text_delta(&serde_json::json!({
                "type": "item.completed",
                "item": {
                    "type": "agent_message",
                    "text": "ok"
                }
            }))
            .as_deref(),
            Some("ok")
        );
        assert_eq!(
            extract_provider_text_delta(&serde_json::json!({
                "type": "item.completed",
                "item": {
                    "type": "message",
                    "role": "assistant",
                    "content": [
                        { "type": "output_text", "text": "array " },
                        { "type": "output_text", "text": "content" }
                    ]
                }
            }))
            .as_deref(),
            Some("array content")
        );
        assert_eq!(
            extract_provider_text_delta(&serde_json::json!({
                "type": "item.completed",
                "item": {
                    "type": "reasoning",
                    "text": "hidden"
                }
            })),
            None
        );
    }

    #[test]
    fn streaming_state_appends_only_new_partial_snapshot_text() {
        let mut state = StreamingCommandState::new();
        state.push_assistant_snapshot("hel");
        state.push_assistant_snapshot("hello");
        state.push_assistant_snapshot("hello");

        assert_eq!(state.assistant_text, "hello");
        assert_eq!(state.take_pending_delta(), "hello");
    }

    #[test]
    fn streaming_state_stops_emitting_after_response_cap() {
        let mut state = StreamingCommandState::new();
        state.push_assistant_delta(&"a".repeat(MAX_CHAT_RESPONSE_CHARS + 32));

        assert!(state.assistant_text_truncated);
        assert!(state.has_pending_delta());
        let capped_text = state.assistant_text.clone();
        assert_eq!(state.take_pending_delta(), capped_text);

        state.push_assistant_delta("ignored");

        assert_eq!(state.assistant_text, capped_text);
        assert!(!state.has_pending_delta());
    }

    #[test]
    fn provider_resume_cursor_decodes_from_binding() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "chat session")
            .unwrap();
        let binding = store
            .upsert_provider_session_binding(
                session.id,
                "anthropic",
                Some("sonnet".into()),
                Some("Claude Sonnet".into()),
                None,
                serde_json::json!({
                    "kind": "claude-session",
                    "sessionId": "019f4612-7e58-7412-9fe9-5f0d6cb29c8e",
                }),
                "ready",
                None,
            )
            .unwrap();

        let cursor = provider_resume_cursor_from_binding(&binding).unwrap();
        assert_eq!(cursor.kind, "claude-session");
        assert_eq!(cursor.session_id, "019f4612-7e58-7412-9fe9-5f0d6cb29c8e");
    }

    #[test]
    fn stale_resume_errors_are_retryable() {
        assert!(is_stale_resume_error("Could not resume session: not found"));
        assert!(is_stale_resume_error("missing thread for provider"));
        assert!(!is_stale_resume_error("rate limit exceeded"));
    }

    #[test]
    fn extracts_hidden_session_title_marker() {
        let extracted =
            extract_session_title_marker("GYRO_SESSION_TITLE: Fix Model Picker\n\nDone.", true);

        assert_eq!(extracted.title.as_deref(), Some("Fix Model Picker"));
        assert_eq!(extracted.message, "Done.");

        let untouched =
            extract_session_title_marker("GYRO_SESSION_TITLE: Fix Model Picker\n\nDone.", false);
        assert!(untouched.title.is_none());
        assert!(untouched.message.contains("GYRO_SESSION_TITLE"));
    }

    #[test]
    fn provider_text_delta_sanitization_preserves_stream_spacing() {
        assert_eq!(sanitize_provider_text_delta(" hello "), " hello ");
        assert_eq!(sanitize_provider_chat_response(" hello "), "hello");
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
            reasoning_effort: Some("high".into()),
            suggest_title: false,
            workspace_path: Some(temp.path().display().to_string()),
        };

        let event = append_provider_status_event(
            &store,
            session.id,
            &request,
            Some(turn_id),
            Uuid::new_v4(),
            HarnessRunStatus::Done,
            None,
        )
        .unwrap();

        assert_eq!(event.kind, SessionEventKind::SystemEvent);
        assert_eq!(event.turn_id, Some(turn_id));
        assert_eq!(event.payload["kind"], "provider-status");
        assert_eq!(event.payload["schema"], gyro_core::HARNESS_SCHEMA_V1);
        assert_eq!(event.payload["runId"], turn_id.to_string());
        assert_eq!(event.payload["status"], "done");
        assert_eq!(event.payload["reasoningEffort"], "high");
        assert_eq!(event.payload["runner"], "codex-cli");
        assert_eq!(event.payload["authOwner"], "chatgpt-local-codex-login");
        assert!(event.payload.get("token").is_none());
        assert!(event.payload.get("userMessage").is_none());
        assert_eq!(event.payload["messagePreview"], "hello");
    }

    #[test]
    fn chat_message_validation_bounds_input() {
        assert_eq!(
            validate_chat_message("  hello\0 ").unwrap(),
            "hello".to_string()
        );
        assert!(validate_chat_message(" ").is_err());
        assert!(validate_chat_message(&"a".repeat(MAX_CHAT_MESSAGE_CHARS + 1)).is_err());
    }

    #[test]
    fn provider_chat_response_is_redacted_and_bounded() {
        let response = format!(
            "token=sk-abcdefghijklmnopqrstuvwxyz123456 {}",
            "a".repeat(MAX_CHAT_RESPONSE_CHARS + 32)
        );
        let sanitized = sanitize_provider_chat_response(&response);

        assert!(sanitized.contains("[REDACTED]"));
        assert!(!sanitized.contains("abcdefghijklmnopqrstuvwxyz"));
        assert!(sanitized.chars().count() <= MAX_CHAT_RESPONSE_CHARS + 3);
    }

    #[test]
    fn truncate_chars_keeps_multibyte_boundaries() {
        assert_eq!(truncate_chars("ééé", 2), "éé...");

        let mut streamed = String::new();
        let mut streamed_chars = 0;
        assert_eq!(
            push_bounded(&mut streamed, &mut streamed_chars, "é", 2),
            BoundedPushResult {
                accepted_chars: 1,
                truncated: false,
            }
        );
        assert_eq!(
            push_bounded(&mut streamed, &mut streamed_chars, "é", 2),
            BoundedPushResult {
                accepted_chars: 1,
                truncated: false,
            }
        );
        assert_eq!(
            push_bounded(&mut streamed, &mut streamed_chars, "é", 2),
            BoundedPushResult {
                accepted_chars: 0,
                truncated: true,
            }
        );

        assert_eq!(streamed, "éé...");
        assert_eq!(streamed_chars, 2);
    }

    #[test]
    fn terminal_cwd_ignores_blank_workspace_path() {
        let request = TerminalPaneRequest {
            pane_id: "blank-workspace".into(),
            title: "Shell".into(),
            command: "zsh".into(),
            args: Vec::new(),
            workspace_path: Some("   ".into()),
            workspace_mode: None,
            working_directory: None,
            cols: None,
            rows: None,
        };

        assert_eq!(resolve_terminal_cwd(&request).unwrap(), None);
    }

    #[test]
    fn terminal_local_cwd_uses_source_repo_for_gyro_worktree() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init"]);
        run_git(&repo, &["config", "user.email", "gyro@example.test"]);
        run_git(&repo, &["config", "user.name", "Gyro Test"]);
        std::fs::write(repo.join("README.md"), "# test\n").unwrap();
        run_git(&repo, &["add", "README.md"]);
        run_git(&repo, &["commit", "-m", "initial"]);

        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let plan = create_worktree(
            &paths,
            &repo,
            "gyro/terminal-cwd",
            Some("gyro-terminal-cwd".into()),
        )
        .unwrap();

        let local_request = TerminalPaneRequest {
            pane_id: "local-cwd".into(),
            title: "Shell".into(),
            command: "zsh".into(),
            args: Vec::new(),
            workspace_path: Some(plan.worktree_path.display().to_string()),
            workspace_mode: Some("local".into()),
            working_directory: Some("Workspace".into()),
            cols: None,
            rows: None,
        };
        assert_eq!(
            resolve_terminal_cwd(&local_request).unwrap(),
            Some(repo.canonicalize().unwrap())
        );

        let worktree_request = TerminalPaneRequest {
            workspace_mode: Some("worktree".into()),
            ..local_request
        };
        assert_eq!(
            resolve_terminal_cwd(&worktree_request).unwrap(),
            Some(plan.worktree_path.canonicalize().unwrap())
        );
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
                workspace_mode: None,
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
    fn terminal_shell_profile_uses_system_zsh_fallback() {
        if Path::new("/bin/zsh").exists() {
            assert_eq!(terminal_command_path("zsh"), "/bin/zsh");
        }
        assert_eq!(terminal_command_path("sh"), "sh");
    }

    #[test]
    fn terminal_manager_starts_interactive_zsh_profile() {
        if !Path::new("/bin/zsh").exists() {
            return;
        }
        let manager = TerminalProcessManager::default();
        let snapshot = manager
            .create(TerminalPaneRequest {
                pane_id: "pane-zsh".into(),
                title: "Shell".into(),
                command: "zsh".into(),
                args: vec!["-il".into()],
                workspace_path: None,
                workspace_mode: None,
                working_directory: None,
                cols: None,
                rows: None,
            })
            .unwrap();
        assert_eq!(snapshot.status, "running");

        manager
            .write("pane-zsh", "printf zsh-ready\\nexit\\n")
            .unwrap();
        let snapshot = wait_for_terminal_output(&manager, "pane-zsh", "zsh-ready");
        assert!(snapshot.output.contains("zsh-ready"));
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
                workspace_mode: None,
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
                workspace_mode: None,
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
    fn terminal_environment_enables_color_and_removes_no_color() {
        let mut command = CommandBuilder::new("sh");
        command.env("NO_COLOR", "1");

        configure_terminal_environment(&mut command);

        assert!(command.get_env("NO_COLOR").is_none());
        assert_eq!(
            command.get_env("TERM").and_then(|value| value.to_str()),
            Some("xterm-256color")
        );
        assert_eq!(
            command
                .get_env("COLORTERM")
                .and_then(|value| value.to_str()),
            Some("truecolor")
        );
        assert_eq!(
            command
                .get_env("CLICOLOR_FORCE")
                .and_then(|value| value.to_str()),
            Some("1")
        );
        assert_eq!(
            command
                .get_env("FORCE_COLOR")
                .and_then(|value| value.to_str()),
            Some("1")
        );
    }

    #[test]
    fn terminal_manager_preserves_ansi_color_sequences() {
        let manager = TerminalProcessManager::default();
        manager
            .create(TerminalPaneRequest {
                pane_id: "pane-color".into(),
                title: "Shell".into(),
                command: "sh".into(),
                args: vec![
                    "-c".into(),
                    "printf '\\033[35mYOLO\\033[0m \\033[36m/model\\033[0m'".into(),
                ],
                workspace_path: None,
                workspace_mode: None,
                working_directory: None,
                cols: None,
                rows: None,
            })
            .unwrap();

        let snapshot = wait_for_terminal_output(&manager, "pane-color", "YOLO");
        assert!(snapshot.output.contains("\u{1b}[35mYOLO\u{1b}[0m"));
        assert!(snapshot.output.contains("\u{1b}[36m/model\u{1b}[0m"));
        assert_eq!(snapshot.status, "done");
    }

    #[test]
    fn terminal_snapshot_keeps_resolved_working_directory() {
        let workspace = tempfile::tempdir().unwrap();
        let manager = TerminalProcessManager::default();
        manager
            .create(TerminalPaneRequest {
                pane_id: "pane-cwd".into(),
                title: "Shell".into(),
                command: "sh".into(),
                args: vec!["-c".into(), "pwd".into()],
                workspace_path: Some(workspace.path().display().to_string()),
                workspace_mode: Some("local".into()),
                working_directory: None,
                cols: None,
                rows: None,
            })
            .unwrap();

        let snapshot = wait_for_terminal_output(
            &manager,
            "pane-cwd",
            &workspace.path().display().to_string(),
        );
        assert_eq!(
            snapshot.working_directory.as_deref(),
            Some(workspace.path().canonicalize().unwrap().to_str().unwrap())
        );
    }

    #[test]
    fn git_status_reports_clean_and_live_line_stats() {
        let repo = tempfile::tempdir().unwrap();
        init_git_repo(repo.path());
        fs::write(repo.path().join("tracked.txt"), "alpha\nbeta\n").unwrap();
        fs::write(repo.path().join("old.txt"), "rename me\n").unwrap();
        run_git(repo.path(), &["add", "."]);
        run_git(repo.path(), &["commit", "-m", "base"]);

        let clean = git_status_impl(repo.path().to_str().unwrap()).unwrap();
        assert!(clean.available);
        assert!(clean.files.is_empty());
        assert_eq!((clean.additions, clean.deletions), (0, 0));

        fs::write(repo.path().join("tracked.txt"), "alpha\ngamma\ndelta\n").unwrap();
        fs::write(repo.path().join("new.txt"), "one\ntwo\n").unwrap();
        run_git(repo.path(), &["mv", "old.txt", "renamed.txt"]);

        let changed = git_status_impl(repo.path().to_str().unwrap()).unwrap();
        assert_eq!(changed.branch.as_deref(), Some("main"));
        assert_eq!(
            changed.repo_root.as_deref(),
            repo.path().canonicalize().unwrap().to_str()
        );
        assert!(changed.additions >= 5);
        assert!(changed.deletions >= 2);
        assert!(changed.files.iter().any(|file| file.path == "tracked.txt"));
        assert!(changed
            .files
            .iter()
            .any(|file| file.path == "new.txt" && file.additions == 2));
        assert!(changed.files.iter().any(|file| file.state == "renamed"));
        assert!(!changed.stats_partial);
    }

    #[test]
    fn git_status_handles_unborn_binary_large_and_non_git_workspaces() {
        let repo = tempfile::tempdir().unwrap();
        init_git_repo(repo.path());
        fs::write(repo.path().join("staged.txt"), "first\nsecond\n").unwrap();
        run_git(repo.path(), &["add", "staged.txt"]);
        fs::write(repo.path().join("untracked.txt"), "third\n").unwrap();
        fs::write(repo.path().join("binary.bin"), [0, 1, 2, 3]).unwrap();
        fs::write(
            repo.path().join("large.txt"),
            vec![b'x'; MAX_WORKSPACE_FILE_EDIT_BYTES + 1],
        )
        .unwrap();

        let status = git_status_impl(repo.path().to_str().unwrap()).unwrap();
        assert!(status.available);
        assert!(status.additions >= 3);
        assert!(status.stats_partial);
        assert!(status
            .files
            .iter()
            .any(|file| file.path == "binary.bin" && file.additions == 0));
        assert!(status
            .files
            .iter()
            .any(|file| file.path == "large.txt" && file.additions == 0));

        let folder = tempfile::tempdir().unwrap();
        let unavailable = git_status_impl(folder.path().to_str().unwrap()).unwrap();
        assert!(!unavailable.available);
        assert_eq!((unavailable.additions, unavailable.deletions), (0, 0));
    }

    #[test]
    fn git_status_parser_marks_conflicts() {
        let status = parse_git_status_v2(
            "# branch.head main\nu UU N... 100644 100644 100644 100644 a b c conflicted.txt\n",
        );
        assert!(status
            .files
            .iter()
            .any(|file| file.path == "conflicted.txt" && file.state == "conflicted"));
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
                workspace_mode: None,
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

    fn init_git_repo(repo: &Path) {
        run_git(repo, &["init", "-b", "main"]);
        run_git(repo, &["config", "user.name", "Gyro Test"]);
        run_git(repo, &["config", "user.email", "gyro@example.test"]);
    }

    fn run_git(repo: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
