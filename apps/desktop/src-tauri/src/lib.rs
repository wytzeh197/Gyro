use anyhow::Context;
use base64::Engine as _;
use gyro_core::{
    apply_provider_mutation_transaction_with_cancellation, begin_provider_mutation_transaction,
    create_worktree, decide_mutation_proposal,
    ipc::{
        acknowledgement_for, request_desktop_provider_approval, versions_compatible,
        AppNotification, DesktopProviderApprovalBehavior, DesktopProviderApprovalRequest,
        DesktopProviderApprovalResponse, DESKTOP_PROVIDER_APPROVAL_IPC_SCHEMA_V1,
    },
    logout_account as account_logout, mutation_approval_payload,
    prepare_claude_provider_mutation_transaction, prepare_provider_mutation_transaction,
    prepare_provider_text_replacement_transaction, provider_descriptor,
    recover_provider_mutation_transactions, refresh_account_session as account_refresh_session,
    run_kimi_acp, start_account_login as account_start_login,
    stored_account_session as account_stored_session, AccountSessionState, AppNotificationKind,
    Automation, AutomationRunStatus, AutomationStatus, AutomationStore, AutomationTriageState,
    CancellationToken, CreateAutomationRequest, CreateSessionContext, ExecutionRequest,
    ExecutionStream, ExecutionTermination, GyroConfig, GyroPaths, HarnessRunStatus,
    KimiAcpApprovalDecision, KimiAcpApprovalKind, KimiAcpMode, KimiAcpRequest, MutationDecision,
    MutationProposal, PendingProviderMutationCommit, PreparedProviderMutationTransaction,
    ProviderDiagnosticsPayload, ProviderExecutionKind, ProviderFileChange, ProviderHealthCheck,
    ProviderHealthRequest, ProviderHealthService, ProviderMutationJournalContext,
    ProviderRunPayload, ProviderSessionBinding, Session, SessionEvent, SessionEventKind,
    SessionOrigin, SessionStore, SessionWorkspaceMode,
};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    mpsc, Arc, Condvar, Mutex, OnceLock, Weak,
};
use std::time::{Duration, Instant, SystemTime};
use tauri::{Emitter, Manager};
use tauri_plugin_notification::{NotificationExt, PermissionState};
use uuid::Uuid;
use walkdir::WalkDir;

#[cfg(test)]
use gyro_core::{
    provider_account_label, provider_runtime_status_from_output, provider_subscription_label,
    should_skip_codex_login_for_external_env,
};

const MAX_WORKSPACE_FILE_PREVIEW_BYTES: usize = 256 * 1024;
const MAX_WORKSPACE_FILE_EDIT_BYTES: usize = 2 * 1024 * 1024;
const MAX_TERMINAL_OUTPUT_BYTES: usize = 512 * 1024;
const MAX_TERMINAL_PROCESSES: usize = 32;
const MAX_LANGUAGE_SERVER_PROCESSES: usize = 16;
const MAX_DEBUG_ADAPTER_PROCESSES: usize = 8;
const MAX_CONCURRENT_IDE_COMMANDS: usize = 4;
const MAX_CONCURRENT_PROVIDER_RUNS: usize = 4;
const MAX_CHAT_MESSAGE_CHARS: usize = 24_000;
const MAX_CHAT_RESPONSE_CHARS: usize = 64_000;
const MAX_CHAT_RESPONSE_BYTES: usize = MAX_CHAT_RESPONSE_CHARS * 4 + 4;
const MAX_CHAT_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_CHAT_IMAGES: usize = 4;
const MAX_CHAT_ATTACHMENTS: usize = 16;
const MAX_CHAT_WORKSPACE_ATTACHMENT_BYTES: u64 = 32 * 1024 * 1024;
const MAX_CHAT_ATTACHMENT_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_STORED_CHAT_ATTACHMENTS_PER_SESSION: usize = 16;
const MAX_BROWSER_PREVIEW_DIAGNOSTICS: usize = 8;
const MAX_BROWSER_PREVIEW_DIAGNOSTIC_CHARS: usize = 400;
const MAX_BROWSER_PREVIEW_DIAGNOSTIC_PAYLOAD_CHARS: usize = 8_000;
const BROWSER_PREVIEW_DIAGNOSTIC_TIMEOUT: Duration = Duration::from_secs(4);
const BROWSER_PREVIEW_CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_BROWSER_PREVIEW_CAPTURE_BYTES: usize = 25 * 1024 * 1024;
const MAX_BROWSER_PREVIEW_CAPTURES: usize = 20;
const MAX_CONCURRENT_BROWSER_PREVIEWS: usize = 2;
const MAX_LSP_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_LSP_HEADER_BYTES: usize = 16 * 1024;
const IDE_PROTOCOL_CHANNEL_CAPACITY: usize = 8;
const MAX_IDE_PROTOCOL_MESSAGES_PER_RESPONSE: usize = 32;
const MAX_IDE_PROTOCOL_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_CODEX_APP_SERVER_MESSAGE_BYTES: usize = 1024 * 1024;
const CODEX_APP_SERVER_CHANNEL_CAPACITY: usize = 64;
const MAX_CODEX_APP_SERVER_ACTIVITIES: usize = 256;
const MAX_CODEX_APP_SERVER_PATCHES: usize = 64;
const MAX_CODEX_APP_SERVER_PATCH_BYTES: usize = 256 * 1024;
const MAX_CODEX_APP_SERVER_PROTOCOL_MESSAGES: usize = 50_000;
const MAX_CODEX_APP_SERVER_PROTOCOL_BYTES: usize = 128 * 1024 * 1024;
const MAX_DESKTOP_IPC_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_PERMISSION_MCP_MESSAGE_BYTES: usize = 1024 * 1024;
const DESKTOP_IPC_WORKER_COUNT: usize = 16;
const DESKTOP_IPC_QUEUE_CAPACITY: usize = 64;
const DESKTOP_IPC_IO_TIMEOUT: Duration = Duration::from_secs(5);
const WORKSPACE_TREE_MAX_CACHE_AGE: Duration = Duration::from_secs(30);
const MAX_WORKSPACE_WATCH_CACHES: usize = 8;
const WORKSPACE_SEARCH_FALLBACK_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_WORKSPACE_SEARCH_FALLBACK_FILES: usize = 5_000;
const MAX_WORKSPACE_SEARCH_FALLBACK_BYTES: u64 = 64 * 1024 * 1024;
const MAX_GIT_UNTRACKED_STAT_FILES: usize = 256;
const MAX_GIT_UNTRACKED_STAT_BYTES: usize = 16 * 1024 * 1024;
const GIT_UNTRACKED_STAT_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_DESKTOP_SESSION_EVENTS_READ: usize = 400;
const CODEX_USAGE_TIMEOUT: Duration = Duration::from_secs(10);
const PROVIDER_CHAT_EVENT: &str = "gyro://provider-chat-event";
const PROVIDER_APPROVAL_EVENT: &str = "gyro://provider-approval-event";
const AUTOMATION_UPDATED_EVENT: &str = "gyro://automation-updated";
const PROVIDER_STREAM_FLUSH_INTERVAL: Duration = Duration::from_millis(80);
const PROVIDER_APPROVAL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const AUTOMATION_SCHEDULER_POLL_INTERVAL: Duration = Duration::from_secs(5);
const AUTOMATION_LEASE_SECONDS: i64 = 45 * 60;
const AUTOMATION_LEASE_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(60);
const AUTOMATION_RESULT_MARKER_PREFIX: &str = "<!-- gyro-automation-result:";
const AUTOMATION_RESULT_MARKER_SUFFIX: &str = "-->";
const TEXT_TRUNCATION_SUFFIX: &str = "...";
const GUI_CLI_PATHS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
];

#[derive(Default)]
struct ProviderCancellationManager {
    flags: Mutex<HashMap<String, Arc<ProviderRunControl>>>,
}

#[derive(Default)]
struct ProviderApprovalManager {
    pending: Mutex<HashMap<String, PendingProviderApproval>>,
}

static ATTACHMENT_SESSION_LOCKS: OnceLock<Mutex<HashMap<String, Weak<Mutex<()>>>>> =
    OnceLock::new();
static ACTIVE_IDE_COMMANDS: AtomicUsize = AtomicUsize::new(0);
static ACTIVE_BROWSER_PREVIEWS: AtomicUsize = AtomicUsize::new(0);

struct IdeCommandAdmission;

impl IdeCommandAdmission {
    fn acquire() -> Result<Self, String> {
        ACTIVE_IDE_COMMANDS
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                (active < MAX_CONCURRENT_IDE_COMMANDS).then_some(active + 1)
            })
            .map_err(|_| "too many task or test commands are already running".to_string())?;
        Ok(Self)
    }
}

impl Drop for IdeCommandAdmission {
    fn drop(&mut self) {
        ACTIVE_IDE_COMMANDS.fetch_sub(1, Ordering::AcqRel);
    }
}

struct BrowserPreviewAdmission;

impl BrowserPreviewAdmission {
    fn acquire() -> Result<Self, String> {
        ACTIVE_BROWSER_PREVIEWS
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                (active < MAX_CONCURRENT_BROWSER_PREVIEWS).then_some(active + 1)
            })
            .map_err(|_| "too many browser previews are already being captured".to_string())?;
        Ok(Self)
    }
}

impl Drop for BrowserPreviewAdmission {
    fn drop(&mut self) {
        ACTIVE_BROWSER_PREVIEWS.fetch_sub(1, Ordering::AcqRel);
    }
}

struct HiddenWebviewGuard(tauri::WebviewWindow);

impl std::ops::Deref for HiddenWebviewGuard {
    type Target = tauri::WebviewWindow;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl Drop for HiddenWebviewGuard {
    fn drop(&mut self) {
        let _ = self.0.close();
    }
}

#[derive(Clone, Default)]
struct WorkspaceWatchManager {
    snapshots: Arc<Mutex<HashMap<PathBuf, WorkspaceTreeSnapshot>>>,
}

#[derive(Clone)]
struct WorkspaceTreeSnapshot {
    files: Vec<WorkspaceFile>,
    directories: Vec<WorkspaceDirectoryStamp>,
    scanned_at: Instant,
}

#[derive(Clone)]
struct WorkspaceDirectoryStamp {
    path: PathBuf,
    modified: Option<SystemTime>,
    len: u64,
}

struct PendingProviderApproval {
    sender: mpsc::Sender<ProviderApprovalDecision>,
    approval_id: Uuid,
    session_id: Uuid,
    turn_id: Option<Uuid>,
    payload: serde_json::Value,
    file_transaction: Option<PreparedProviderMutationTransaction>,
}

#[derive(Clone, Debug)]
struct ProviderApprovalContext {
    session_id: String,
    turn_id: Option<String>,
    provider_id: String,
    provider_label: Option<String>,
}

impl From<&ProviderChatRequest> for ProviderApprovalContext {
    fn from(request: &ProviderChatRequest) -> Self {
        Self {
            session_id: request.session_id.clone(),
            turn_id: request.turn_id.clone(),
            provider_id: request.provider_id.clone(),
            provider_label: request.provider_label.clone(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProviderApprovalDecision {
    Approve,
    Reject,
    AppliedByGyro,
}

struct ProviderRunControl {
    cancellation: CancellationToken,
    next_event_sequence: AtomicU64,
    approval_nonce: String,
}

impl Default for ProviderRunControl {
    fn default() -> Self {
        Self {
            cancellation: CancellationToken::default(),
            next_event_sequence: AtomicU64::new(0),
            approval_nonce: Uuid::new_v4().to_string(),
        }
    }
}

#[derive(Default)]
struct AutomationSchedulerControl {
    state: Mutex<AutomationSchedulerState>,
    wake: Condvar,
}

#[derive(Default)]
struct AutomationSchedulerState {
    generation: u64,
    running_sessions: HashMap<Uuid, String>,
}

struct AutomationLeaseHeartbeat {
    stopped: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}

struct AutomationSchedulerClock {
    last_effective: chrono::DateTime<chrono::Utc>,
    last_sample: Instant,
}

fn automation_scheduler_effective_now(
    previous: chrono::DateTime<chrono::Utc>,
    monotonic_elapsed: Duration,
    observed_wall: chrono::DateTime<chrono::Utc>,
) -> chrono::DateTime<chrono::Utc> {
    let elapsed = chrono::Duration::from_std(monotonic_elapsed).unwrap_or_default();
    observed_wall.max(previous + elapsed)
}

impl AutomationSchedulerClock {
    fn new(observed_wall: chrono::DateTime<chrono::Utc>) -> Self {
        Self {
            last_effective: observed_wall,
            last_sample: Instant::now(),
        }
    }

    fn now(&mut self) -> chrono::DateTime<chrono::Utc> {
        let sample = Instant::now();
        let effective = automation_scheduler_effective_now(
            self.last_effective,
            sample.duration_since(self.last_sample),
            chrono::Utc::now(),
        );
        self.last_effective = effective;
        self.last_sample = sample;
        effective
    }
}

impl AutomationLeaseHeartbeat {
    fn start(
        paths: GyroPaths,
        automation_id: Uuid,
        lease_owner: String,
        lease_seconds: i64,
        interval: Duration,
    ) -> Self {
        let stopped = Arc::new(AtomicBool::new(false));
        let worker_stopped = stopped.clone();
        let worker = std::thread::spawn(move || {
            let store = match AutomationStore::open(paths) {
                Ok(store) => store,
                Err(error) => {
                    eprintln!("could not start automation lease heartbeat: {error}");
                    return;
                }
            };
            while !worker_stopped.load(Ordering::SeqCst) {
                std::thread::park_timeout(interval);
                if worker_stopped.load(Ordering::SeqCst) {
                    break;
                }
                match store.renew_automation_lease(
                    automation_id,
                    lease_owner.clone(),
                    lease_seconds,
                ) {
                    Ok(Some(_)) => {}
                    Ok(None) => break,
                    Err(error) => eprintln!(
                        "could not renew automation lease {}: {}",
                        automation_id,
                        gyro_core::security::redact_secrets(&error.to_string())
                    ),
                }
            }
        });
        Self {
            stopped,
            worker: Some(worker),
        }
    }

    fn stop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            worker.thread().unpark();
            let _ = worker.join();
        }
    }
}

impl Drop for AutomationLeaseHeartbeat {
    fn drop(&mut self) {
        self.stop();
    }
}

impl AutomationSchedulerControl {
    fn wake(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.generation = state.generation.wrapping_add(1);
            self.wake.notify_all();
        }
    }

    fn generation(&self) -> u64 {
        self.state
            .lock()
            .map(|state| state.generation)
            .unwrap_or_default()
    }

    fn wait_for_change(&self, observed_generation: u64, timeout: Duration) -> u64 {
        let Ok(state) = self.state.lock() else {
            std::thread::sleep(timeout);
            return observed_generation;
        };
        if state.generation != observed_generation {
            return state.generation;
        }
        self.wake
            .wait_timeout_while(state, timeout, |state| {
                state.generation == observed_generation
            })
            .map(|(state, _)| state.generation)
            .unwrap_or(observed_generation)
    }

    fn register(&self, automation_id: Uuid, session_id: String) {
        if let Ok(mut state) = self.state.lock() {
            state.running_sessions.insert(automation_id, session_id);
        }
    }

    fn unregister(&self, automation_id: Uuid) {
        if let Ok(mut state) = self.state.lock() {
            state.running_sessions.remove(&automation_id);
        }
    }

    fn session_for(&self, automation_id: Uuid) -> Option<String> {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.running_sessions.get(&automation_id).cloned())
    }
}

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
struct FileMutationProposalRequest {
    session_id: String,
    turn_id: Option<String>,
    path: String,
    content: String,
    expected_hash: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileMutationDecisionRequest {
    proposal_id: String,
    decision: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileMutationDecisionResult {
    proposal: MutationProposal,
    event: SessionEvent,
    file: Option<WorkspaceFileContent>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderApprovalDecisionRequest {
    approval_id: String,
    decision: String,
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitBranchCatalog {
    available: bool,
    current: Option<String>,
    branches: Vec<String>,
    error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitCheckoutBranchRequest {
    workspace_path: String,
    branch: String,
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
    processes: Arc<Mutex<HashMap<String, Arc<Mutex<LanguageServerProcess>>>>>,
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
    processes: Arc<Mutex<HashMap<String, Arc<Mutex<DebugAdapterProcess>>>>>,
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
    profile_id: Option<String>,
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
    profile_id: Option<String>,
    command: String,
    output: Option<String>,
    output_revision: u64,
    status: String,
    exit_code: Option<i32>,
    workspace_path: Option<String>,
    working_directory: Option<String>,
    cols: u16,
    rows: u16,
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
    #[serde(default = "default_true")]
    require_command_approval: bool,
    #[serde(default = "default_true")]
    require_file_edit_approval: bool,
    #[serde(default)]
    full_access: bool,
    #[serde(default)]
    suggest_title: bool,
    workspace_path: Option<String>,
    #[serde(default)]
    mode: ChatMode,
    goal: Option<SessionGoalContext>,
    plan: Option<serde_json::Value>,
    #[serde(default)]
    attachments: Vec<ChatAttachmentRequest>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum ChatMode {
    #[default]
    Normal,
    Plan,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionGoalContext {
    text: String,
    status: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatAttachmentRequest {
    id: String,
    kind: String,
    name: String,
    path: String,
    relative_path: Option<String>,
    mime_type: Option<String>,
    size: u64,
    content_hash: Option<String>,
    modified_at: Option<String>,
    preview_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrepareChatAttachmentRequest {
    session_id: String,
    path: String,
    workspace_path: Option<String>,
    kind: String,
    #[serde(default, deserialize_with = "deserialize_optional_attachment_bytes")]
    bytes: Option<Vec<u8>>,
    name: Option<String>,
}

fn deserialize_optional_attachment_bytes<'de, D>(
    deserializer: D,
) -> Result<Option<Vec<u8>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct OptionalBytesVisitor;

    impl<'de> serde::de::Visitor<'de> for OptionalBytesVisitor {
        type Value = Option<Vec<u8>>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("an optional bounded byte array")
        }

        fn visit_none<E>(self) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_unit<E>(self) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_some<D2>(self, deserializer: D2) -> Result<Self::Value, D2::Error>
        where
            D2: serde::Deserializer<'de>,
        {
            deserializer.deserialize_seq(BoundedBytesVisitor).map(Some)
        }
    }

    struct BoundedBytesVisitor;

    impl<'de> serde::de::Visitor<'de> for BoundedBytesVisitor {
        type Value = Vec<u8>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(formatter, "at most {MAX_CHAT_IMAGE_BYTES} image bytes")
        }

        fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
        where
            A: serde::de::SeqAccess<'de>,
        {
            let limit = MAX_CHAT_IMAGE_BYTES as usize;
            let mut bytes = Vec::with_capacity(sequence.size_hint().unwrap_or(0).min(limit));
            while let Some(byte) = sequence.next_element::<u8>()? {
                if bytes.len() >= limit {
                    return Err(serde::de::Error::custom(
                        "image attachment exceeds the 10 MB limit",
                    ));
                }
                bytes.push(byte);
            }
            Ok(bytes)
        }
    }

    deserializer.deserialize_option(OptionalBytesVisitor)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedChatAttachment {
    id: String,
    kind: String,
    name: String,
    path: String,
    relative_path: Option<String>,
    mime_type: Option<String>,
    size: u64,
    content_hash: String,
    modified_at: Option<String>,
    available: bool,
    stale: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderChatResponse {
    activity_events: Vec<SessionEvent>,
    assistant_event: SessionEvent,
    session: Option<Session>,
    session_title: Option<String>,
    status_event: SessionEvent,
    resume_cursor: Option<ProviderResumeCursor>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPreviewCheckRequest {
    url: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPreviewCaptureRequest {
    url: String,
    device: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPreviewCapture {
    path: String,
    filename: String,
    width: u32,
    height: u32,
    created_at: String,
}

#[cfg(target_os = "macos")]
struct BrowserPreviewSnapshot {
    png: Vec<u8>,
    width: u32,
    height: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPreviewDiagnostic {
    kind: String,
    message: String,
    source: Option<String>,
    line: Option<u32>,
    column: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPreviewCheck {
    reachable: bool,
    status_code: Option<u16>,
    message: String,
    diagnostics: Vec<BrowserPreviewDiagnostic>,
    diagnostics_supported: bool,
    diagnostics_captured: bool,
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
    sequence: u64,
    phase: String,
    status: Option<String>,
    text_delta: Option<String>,
    activity_id: Option<String>,
    activity_kind: Option<String>,
    activity_label: Option<String>,
    activity_detail: Option<String>,
    activity_status: Option<String>,
    message: Option<String>,
    error: Option<String>,
}

#[derive(Debug)]
struct ProviderRunnerOutput {
    activities: Vec<ProviderActivity>,
    context_usage: Option<ProviderContextUsage>,
    response: String,
    resume_cursor: Option<ProviderResumeCursor>,
    retry_count: u32,
    resumed: bool,
    output_summary: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderContextUsage {
    input_tokens: u64,
    cached_input_tokens: u64,
    output_tokens: u64,
    reasoning_output_tokens: u64,
    total_tokens: u64,
    model_context_window: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ProviderActivity {
    id: String,
    kind: String,
    label: String,
    detail: Option<String>,
    status: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProviderAdapterKind {
    OpenAiCodex,
    AnthropicClaude,
    KimiAcp,
    ReadinessOnly,
}

#[derive(Clone, Copy, Debug)]
struct ProviderAdapterDescriptor {
    kind: ProviderAdapterKind,
    runner: &'static str,
    auth_owner: &'static str,
    timeout_seconds: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ProviderUsageWindow {
    id: String,
    label: String,
    used_percent: i32,
    resets_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ProviderUsageSnapshot {
    provider_id: String,
    windows: Vec<ProviderUsageWindow>,
    fetched_at: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexRateLimitWindow {
    used_percent: i32,
    window_duration_mins: Option<i64>,
    resets_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexRateLimitSnapshot {
    primary: Option<CodexRateLimitWindow>,
    secondary: Option<CodexRateLimitWindow>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexRateLimitsResponse {
    rate_limits: CodexRateLimitSnapshot,
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
    output: Arc<Mutex<TerminalOutputBuffer>>,
    status: String,
    exit_code: Option<i32>,
    cols: u16,
    rows: u16,
    terminated: bool,
}

#[derive(Default)]
struct TerminalOutputBuffer {
    bytes: VecDeque<u8>,
    revision: u64,
}

impl Drop for TerminalProcess {
    fn drop(&mut self) {
        terminate_terminal_process(self);
    }
}

impl TerminalProcessManager {
    fn create(&self, request: TerminalPaneRequest) -> anyhow::Result<TerminalPaneSnapshot> {
        let mut processes = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("terminal process manager lock poisoned"))?;
        if let Some(mut existing) = processes.remove(&request.pane_id) {
            terminate_terminal_process(&mut existing);
        }
        if processes.len() >= MAX_TERMINAL_PROCESSES {
            anyhow::bail!("terminal process limit reached; close a terminal pane first");
        }
        let mut process = spawn_terminal_process(request)?;
        let snapshot = snapshot_terminal_process(&mut process, None);
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
        Ok(snapshot_terminal_process(process, None))
    }

    fn read(
        &self,
        pane_id: &str,
        known_output_revision: Option<u64>,
    ) -> anyhow::Result<TerminalPaneSnapshot> {
        let mut processes = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("terminal process manager lock poisoned"))?;
        let process = processes
            .get_mut(pane_id)
            .ok_or_else(|| anyhow::anyhow!("terminal pane not found"))?;
        Ok(snapshot_terminal_process(process, known_output_revision))
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
        Ok(snapshot_terminal_process(process, None))
    }

    fn has_foreground_job(&self, pane_id: &str) -> anyhow::Result<bool> {
        let mut processes = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("terminal process manager lock poisoned"))?;
        let process = processes
            .get_mut(pane_id)
            .ok_or_else(|| anyhow::anyhow!("terminal pane not found"))?;
        let snapshot = snapshot_terminal_process(process, None);
        if snapshot.status != "running" {
            return Ok(false);
        }

        #[cfg(unix)]
        {
            let shell_pid = process.child.process_id().map(|pid| pid as i32);
            let foreground_pid = process.master.process_group_leader();
            Ok(match (shell_pid, foreground_pid) {
                (Some(shell_pid), Some(foreground_pid)) => foreground_pid != shell_pid,
                _ => true,
            })
        }

        #[cfg(not(unix))]
        Ok(true)
    }

    fn stop(&self, pane_id: &str) -> anyhow::Result<TerminalPaneSnapshot> {
        let mut processes = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("terminal process manager lock poisoned"))?;
        let process = processes
            .get_mut(pane_id)
            .ok_or_else(|| anyhow::anyhow!("terminal pane not found"))?;
        terminate_terminal_process(process);
        process.status = "failed".into();
        Ok(snapshot_terminal_process(process, None))
    }

    fn close(&self, pane_id: &str) -> anyhow::Result<()> {
        let mut process = {
            let mut processes = self
                .processes
                .lock()
                .map_err(|_| anyhow::anyhow!("terminal process manager lock poisoned"))?;
            processes
                .remove(pane_id)
                .ok_or_else(|| anyhow::anyhow!("terminal pane not found"))?
        };
        terminate_terminal_process(&mut process);
        drop(process);
        Ok(())
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
            terminate_terminal_process(&mut process);
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
            .map(|process| snapshot_terminal_process(process, None))
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
    let branch = if workspace_path.trim().is_empty() {
        "main".into()
    } else {
        git_branch_catalog_impl(&workspace_path)
            .ok()
            .and_then(|catalog| catalog.current)
            .unwrap_or_else(|| "main".into())
    };
    store
        .create_session_with_context(
            PathBuf::from(workspace_path),
            SessionOrigin::Desktop,
            title,
            CreateSessionContext {
                branch,
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
#[allow(clippy::too_many_arguments)]
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

#[allow(clippy::too_many_arguments)]
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
async fn delete_session(app: tauri::AppHandle, session_id: String) -> Result<bool, String> {
    let reservation = Arc::new(ProviderRunControl::default());
    {
        let manager = app.state::<ProviderCancellationManager>();
        let mut flags = manager
            .flags
            .lock()
            .map_err(|_| "provider cancellation state is unavailable".to_string())?;
        if flags.contains_key(&session_id) {
            return Err("stop the active provider turn before deleting this session".into());
        }
        flags.insert(session_id.clone(), reservation.clone());
    }
    let worker_session_id = session_id.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || delete_session_blocking(worker_session_id))
            .await
            .map_err(|error| format!("session delete worker failed: {error}"));
    if let Ok(mut flags) = app.state::<ProviderCancellationManager>().flags.lock() {
        if flags
            .get(&session_id)
            .is_some_and(|current| Arc::ptr_eq(current, &reservation))
        {
            flags.remove(&session_id);
        }
    }
    result?
}

fn delete_session_blocking(session_id: String) -> Result<bool, String> {
    let session_id = parse_uuid(&session_id)?;
    let attachment_lock = attachment_session_lock(&session_id.to_string())?;
    let _attachment_guard = attachment_lock
        .lock()
        .map_err(|_| "session attachment lock is unavailable".to_string())?;
    let store = open_store()?;
    let attachments_root = store.paths().sessions_dir.join("attachments");
    cleanup_staged_session_attachments(&attachments_root);
    let staged = stage_session_attachments(&attachments_root, session_id)?;
    match store.delete_session(session_id) {
        Ok(deleted) => {
            drop(store);
            if let Some((_, tombstone)) = staged {
                if let Err(error) = remove_attachment_storage_entry(&tombstone) {
                    eprintln!(
                        "could not finish private attachment cleanup for {session_id}: {error}"
                    );
                }
            }
            Ok(deleted)
        }
        Err(error) => {
            if let Some((original, tombstone)) = staged {
                let _ = fs::rename(tombstone, original);
            }
            Err(to_string(error))
        }
    }
}

fn attachment_session_lock(session_id: &str) -> Result<Arc<Mutex<()>>, String> {
    let locks = ATTACHMENT_SESSION_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks
        .lock()
        .map_err(|_| "attachment lock registry is unavailable".to_string())?;
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(session_id).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(session_id.to_string(), Arc::downgrade(&lock));
    Ok(lock)
}

fn stage_session_attachments(
    attachments_root: &Path,
    session_id: Uuid,
) -> Result<Option<(PathBuf, PathBuf)>, String> {
    let root_metadata = match fs::symlink_metadata(attachments_root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(to_string(error)),
    };
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err("attachment storage is not a safe directory".into());
    }
    let session_dir = attachments_root.join(session_id.to_string());
    let metadata = match fs::symlink_metadata(&session_dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(to_string(error)),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("session attachment storage is not a safe directory".into());
    }
    let tombstone = attachments_root.join(format!(
        ".deleting-{session_id}-{}",
        Uuid::new_v4().simple()
    ));
    fs::rename(&session_dir, &tombstone).map_err(to_string)?;
    Ok(Some((session_dir, tombstone)))
}

fn remove_attachment_storage_entry(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(to_string(error)),
    };
    if metadata.file_type().is_symlink() || metadata.is_file() {
        fs::remove_file(path).map_err(to_string)
    } else if metadata.is_dir() {
        fs::remove_dir_all(path).map_err(to_string)
    } else {
        Err("attachment cleanup target has an unsupported file type".into())
    }
}

fn cleanup_staged_session_attachments(attachments_root: &Path) {
    let Ok(entries) = fs::read_dir(attachments_root) else {
        return;
    };
    for entry in entries.flatten().take(64) {
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with(".deleting-")
        {
            let _ = remove_attachment_storage_entry(&entry.path());
        }
    }
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
async fn create_automation(
    app: tauri::AppHandle,
    draft: CreateAutomationRequest,
) -> Result<Automation, String> {
    let automation =
        tauri::async_runtime::spawn_blocking(move || create_automation_blocking(draft))
            .await
            .map_err(|error| format!("automation create worker failed: {error}"))??;
    emit_automation_update(&app, &automation);
    app.state::<AutomationSchedulerControl>().wake();
    Ok(automation)
}

fn create_automation_blocking(draft: CreateAutomationRequest) -> Result<Automation, String> {
    let store = open_automation_store()?;
    store.create_automation(draft).map_err(to_string)
}

#[tauri::command]
async fn set_automation_status(
    app: tauri::AppHandle,
    automation_id: String,
    status: AutomationStatus,
) -> Result<Automation, String> {
    let parsed_id = parse_uuid(&automation_id)?;
    let should_cancel = status != AutomationStatus::Current;
    let automation = tauri::async_runtime::spawn_blocking(move || {
        set_automation_status_blocking(automation_id, status)
    })
    .await
    .map_err(|error| format!("automation status worker failed: {error}"))??;
    if should_cancel {
        cancel_scheduled_automation(&app, parsed_id);
    }
    emit_automation_update(&app, &automation);
    app.state::<AutomationSchedulerControl>().wake();
    Ok(automation)
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
async fn run_automation(
    app: tauri::AppHandle,
    automation_id: String,
) -> Result<Automation, String> {
    let automation =
        tauri::async_runtime::spawn_blocking(move || run_automation_blocking(automation_id))
            .await
            .map_err(|error| format!("automation queue worker failed: {error}"))??;
    emit_automation_update(&app, &automation);
    app.state::<AutomationSchedulerControl>().wake();
    Ok(automation)
}

fn run_automation_blocking(automation_id: String) -> Result<Automation, String> {
    let store = open_automation_store()?;
    let automation_id = parse_uuid(&automation_id)?;
    store
        .queue_automation_now(automation_id)
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

fn emit_automation_update(app: &tauri::AppHandle, automation: &Automation) {
    if let Err(error) = app.emit(AUTOMATION_UPDATED_EVENT, automation) {
        eprintln!("could not emit automation update: {error}");
    }
}

fn automation_notification_content(
    automation: &Automation,
) -> Option<(&'static str, &'static str)> {
    match automation.run_history.first()?.status {
        AutomationRunStatus::Passed => Some((
            "Gyro automation finished",
            "A scheduled automation completed. Open Gyro to review the result.",
        )),
        AutomationRunStatus::Failed => Some((
            "Gyro automation needs attention",
            "A scheduled automation failed. Open Gyro to review the result.",
        )),
        AutomationRunStatus::Queued
        | AutomationRunStatus::Running
        | AutomationRunStatus::Stopped => None,
    }
}

fn should_show_automation_notification(window_visible: bool, window_focused: bool) -> bool {
    !window_visible || !window_focused
}

fn notification_permission_allows_delivery(permission: PermissionState) -> bool {
    permission == PermissionState::Granted
}

#[tauri::command]
async fn get_notification_permission(app: tauri::AppHandle) -> Result<String, String> {
    app.notification()
        .permission_state()
        .map(|permission| permission.to_string())
        .map_err(to_string)
}

#[tauri::command]
async fn test_notification(app: tauri::AppHandle) -> Result<String, String> {
    let notifications = app.notification();
    let mut permission = notifications.permission_state().map_err(to_string)?;
    if matches!(
        permission,
        PermissionState::Prompt | PermissionState::PromptWithRationale
    ) {
        permission = notifications.request_permission().map_err(to_string)?;
    }
    if !notification_permission_allows_delivery(permission) {
        return Ok(permission.to_string());
    }
    notifications
        .builder()
        .title("Gyro notifications are ready")
        .body("Automation outcomes can now appear while Gyro is in the background.")
        .show()
        .map_err(to_string)?;
    Ok(permission.to_string())
}

fn notify_automation_outcome(app: &tauri::AppHandle, automation: &Automation) {
    let Some((title, body)) = automation_notification_content(automation) else {
        return;
    };
    let (window_visible, window_focused) = app
        .get_webview_window("main")
        .map(|window| {
            (
                window.is_visible().unwrap_or(false),
                window.is_focused().unwrap_or(false),
            )
        })
        .unwrap_or((false, false));
    if !should_show_automation_notification(window_visible, window_focused) {
        return;
    }
    let Ok(permission) = app.notification().permission_state() else {
        return;
    };
    if !notification_permission_allows_delivery(permission) {
        return;
    }
    if let Err(error) = app.notification().builder().title(title).body(body).show() {
        eprintln!("could not show automation notification: {error}");
    }
}

fn cancel_scheduled_automation(app: &tauri::AppHandle, automation_id: Uuid) {
    let Some(session_id) = app
        .state::<AutomationSchedulerControl>()
        .session_for(automation_id)
    else {
        return;
    };
    if let Ok(flags) = app.state::<ProviderCancellationManager>().flags.lock() {
        if let Some(control) = flags.get(&session_id) {
            control.cancellation.cancel();
        }
    }
}

fn start_automation_scheduler(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let paths = match GyroPaths::for_current_user() {
            Ok(paths) => paths,
            Err(error) => {
                eprintln!("could not resolve automation scheduler paths: {error}");
                return;
            }
        };
        let lease_owner = format!("desktop-{}-{}", std::process::id(), Uuid::new_v4());
        let mut observed_generation = app.state::<AutomationSchedulerControl>().generation();
        let mut clock = AutomationSchedulerClock::new(chrono::Utc::now());

        loop {
            let now = clock.now();
            if let Err(error) =
                recover_automation_scheduler_leases_with(&paths, now, |automation| {
                    emit_automation_update(&app, automation);
                    notify_automation_outcome(&app, automation);
                })
            {
                eprintln!("could not recover automation leases: {error}");
            }
            match run_automation_scheduler_once_at_with(&paths, &lease_owner, now, |automation| {
                emit_automation_update(&app, automation);
                execute_claimed_automation(&app, &paths, automation)
            }) {
                Ok(Some(automation)) => {
                    emit_automation_update(&app, &automation);
                    notify_automation_outcome(&app, &automation);
                    continue;
                }
                Ok(None) => {}
                Err(error) => eprintln!("automation scheduler iteration failed: {error}"),
            }
            observed_generation = app
                .state::<AutomationSchedulerControl>()
                .wait_for_change(observed_generation, AUTOMATION_SCHEDULER_POLL_INTERVAL);
        }
    });
}

fn recover_automation_scheduler_leases_with<F>(
    paths: &GyroPaths,
    now: chrono::DateTime<chrono::Utc>,
    mut on_recovered: F,
) -> Result<usize, String>
where
    F: FnMut(&Automation),
{
    let store = AutomationStore::open(paths.clone()).map_err(to_string)?;
    let expired_ids = store
        .list_automations()
        .map_err(to_string)?
        .into_iter()
        .filter(|automation| {
            automation
                .lease_expires_at
                .is_some_and(|expires_at| expires_at <= now)
        })
        .map(|automation| automation.id)
        .collect::<Vec<_>>();
    if expired_ids.is_empty() {
        return Ok(0);
    }

    let recovered = store
        .recover_expired_automation_leases(now)
        .map_err(to_string)?;
    for automation_id in expired_ids {
        let Some(automation) = store.get_automation(automation_id).map_err(to_string)? else {
            continue;
        };
        if automation.lease_owner.is_none() && automation.last_run_at == Some(now) {
            on_recovered(&automation);
        }
    }
    Ok(recovered)
}

#[cfg(test)]
fn run_automation_scheduler_once_with<F>(
    paths: &GyroPaths,
    lease_owner: &str,
    execute: F,
) -> Result<Option<Automation>, String>
where
    F: FnOnce(&Automation) -> Result<String, String>,
{
    run_automation_scheduler_once_at_with(paths, lease_owner, chrono::Utc::now(), execute)
}

fn run_automation_scheduler_once_at_with<F>(
    paths: &GyroPaths,
    lease_owner: &str,
    now: chrono::DateTime<chrono::Utc>,
    execute: F,
) -> Result<Option<Automation>, String>
where
    F: FnOnce(&Automation) -> Result<String, String>,
{
    run_automation_scheduler_once_at_with_heartbeat_interval(
        paths,
        lease_owner,
        now,
        AUTOMATION_LEASE_HEARTBEAT_INTERVAL,
        execute,
    )
}

#[cfg(test)]
fn run_automation_scheduler_once_with_heartbeat_interval<F>(
    paths: &GyroPaths,
    lease_owner: &str,
    heartbeat_interval: Duration,
    execute: F,
) -> Result<Option<Automation>, String>
where
    F: FnOnce(&Automation) -> Result<String, String>,
{
    run_automation_scheduler_once_at_with_heartbeat_interval(
        paths,
        lease_owner,
        chrono::Utc::now(),
        heartbeat_interval,
        execute,
    )
}

fn run_automation_scheduler_once_at_with_heartbeat_interval<F>(
    paths: &GyroPaths,
    lease_owner: &str,
    now: chrono::DateTime<chrono::Utc>,
    heartbeat_interval: Duration,
    execute: F,
) -> Result<Option<Automation>, String>
where
    F: FnOnce(&Automation) -> Result<String, String>,
{
    let store = AutomationStore::open(paths.clone()).map_err(to_string)?;
    let Some(claimed) = store
        .claim_due_automation_at(lease_owner, AUTOMATION_LEASE_SECONDS, now)
        .map_err(to_string)?
    else {
        return Ok(None);
    };

    let heartbeat = AutomationLeaseHeartbeat::start(
        paths.clone(),
        claimed.id,
        lease_owner.to_string(),
        AUTOMATION_LEASE_SECONDS,
        heartbeat_interval,
    );
    let execution_result =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| execute(&claimed)))
            .unwrap_or_else(|_| {
                Err("automation execution panicked and was safely contained".into())
            });
    drop(heartbeat);

    let (status, summary, pause_for_configuration, stop_condition_met) = match execution_result {
        Ok(summary) => match parse_automation_execution_outcome(&claimed, &summary) {
            Ok(outcome) => (
                AutomationRunStatus::Passed,
                outcome.summary,
                false,
                outcome.stop_condition_met,
            ),
            Err(error) => (AutomationRunStatus::Failed, error, false, None),
        },
        Err(error) if error.contains("chat cancelled") => (
            AutomationRunStatus::Stopped,
            "Automation stopped before completion".into(),
            false,
            None,
        ),
        Err(error) => {
            let error = gyro_core::security::redact_secrets(&error);
            let pause = error.starts_with("configuration:");
            (AutomationRunStatus::Failed, error, pause, None)
        }
    };
    let updated = store
        .finish_automation_lease_with_stop_condition(
            claimed.id,
            lease_owner,
            status,
            bounded_automation_summary(&summary),
            stop_condition_met,
        )
        .map_err(to_string)?
        .ok_or_else(|| "claimed automation disappeared before completion".to_string())?;
    if pause_for_configuration {
        return store
            .set_automation_status(updated.id, AutomationStatus::Paused)
            .map_err(to_string);
    }
    Ok(Some(updated))
}

fn execute_claimed_automation(
    app: &tauri::AppHandle,
    paths: &GyroPaths,
    automation: &Automation,
) -> Result<String, String> {
    let workspace_path = resolve_automation_workspace(paths, automation)?;
    let provider_id = automation
        .execution
        .provider_id
        .clone()
        .unwrap_or_else(|| provider_id_for_automation_label(&automation.provider).into());
    if provider_adapter_for(&provider_id).kind == ProviderAdapterKind::ReadinessOnly {
        return Err(format!(
            "configuration: {} cannot execute automation runs",
            automation.provider
        ));
    }
    let provider_label = automation
        .execution
        .provider_label
        .clone()
        .or_else(|| Some(automation.provider.clone()));
    let store = SessionStore::open(paths.clone()).map_err(to_string)?;
    let session = store
        .create_session_with_context(
            &workspace_path,
            SessionOrigin::Desktop,
            format!("Automation: {}", automation.title),
            CreateSessionContext {
                workspace_mode: automation.workspace_mode.clone(),
                branch: automation.branch.clone(),
                worktree_name: automation.worktree_name.clone(),
                provider_id: Some(provider_id.clone()),
                provider_label: provider_label.clone(),
                model_id: automation.execution.model_id.clone(),
                model_label: automation.execution.model_label.clone(),
                reasoning_effort: automation.execution.reasoning_effort.clone(),
            },
        )
        .map_err(to_string)?;
    emit_automation_update(app, automation);
    let message = automation_provider_prompt(automation);
    let user_event = store
        .append_user_turn_message(
            session.id,
            message.clone(),
            serde_json::json!({
                "surface": "automation",
                "automationId": automation.id,
                "schedule": automation.schedule,
            }),
        )
        .map_err(to_string)?;
    let session_id = session.id.to_string();
    let control = Arc::new(ProviderRunControl::default());
    {
        let cancellation_manager = app.state::<ProviderCancellationManager>();
        let mut flags = cancellation_manager
            .flags
            .lock()
            .map_err(|_| "provider cancellation state is unavailable".to_string())?;
        flags.insert(session_id.clone(), control);
    }
    app.state::<AutomationSchedulerControl>()
        .register(automation.id, session_id.clone());

    let request = ProviderChatRequest {
        session_id: session_id.clone(),
        message,
        turn_id: user_event.turn_id.map(|id| id.to_string()),
        provider_id,
        provider_label,
        model_id: automation.execution.model_id.clone(),
        model_label: automation.execution.model_label.clone(),
        reasoning_effort: automation.execution.reasoning_effort.clone(),
        require_command_approval: true,
        require_file_edit_approval: true,
        full_access: false,
        suggest_title: false,
        workspace_path: Some(workspace_path.display().to_string()),
        mode: ChatMode::Normal,
        goal: None,
        plan: None,
        attachments: Vec::new(),
    };
    let result = run_provider_chat_blocking(app.clone(), request)
        .map(|response| response.assistant_event.message);
    app.state::<AutomationSchedulerControl>()
        .unregister(automation.id);
    if let Ok(mut flags) = app.state::<ProviderCancellationManager>().flags.lock() {
        flags.remove(&session_id);
    }
    result
}

fn resolve_automation_workspace(
    paths: &GyroPaths,
    automation: &Automation,
) -> Result<PathBuf, String> {
    let source = automation
        .execution
        .workspace_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "configuration: choose a workspace for this automation".to_string())?;
    let source = PathBuf::from(source).canonicalize().map_err(|_| {
        "configuration: the automation workspace is no longer available".to_string()
    })?;
    if !source.is_dir() {
        return Err("configuration: the automation workspace is not a folder".into());
    }
    if automation.workspace_mode == SessionWorkspaceMode::Local {
        return Ok(source);
    }

    let worktree_name = automation
        .worktree_name
        .as_deref()
        .ok_or_else(|| "configuration: the automation has no worktree name".to_string())?;
    let expected = paths.worktrees_dir.join(worktree_name);
    if expected.exists() {
        let expected = expected
            .canonicalize()
            .map_err(|_| "configuration: the automation worktree is unavailable".to_string())?;
        let root = paths
            .worktrees_dir
            .canonicalize()
            .map_err(|_| "configuration: the Gyro worktree root is unavailable".to_string())?;
        if !expected.starts_with(root) || !expected.is_dir() {
            return Err("configuration: the automation worktree is unsafe".into());
        }
        return Ok(expected);
    }
    create_worktree(
        paths,
        source,
        automation.branch.clone(),
        Some(worktree_name.to_string()),
    )
    .map(|plan| plan.worktree_path)
    .map_err(|error| format!("configuration: could not create automation worktree: {error}"))
}

fn provider_id_for_automation_label(label: &str) -> &'static str {
    let normalized = label.to_ascii_lowercase();
    if normalized.contains("claude") || normalized.contains("anthropic") {
        "anthropic"
    } else {
        "openai"
    }
}

fn automation_provider_prompt(automation: &Automation) -> String {
    match automation.stop_condition.as_deref() {
        Some(condition) => format!(
            "{}\n\nAutomation stop condition: {}\n\nEvaluate the stop condition after completing the work. End your final response with exactly one hidden machine-readable line using one of these forms:\n<!-- gyro-automation-result: {{\"stopConditionMet\":true}} -->\n<!-- gyro-automation-result: {{\"stopConditionMet\":false}} -->\nUse true only when you verified the condition is satisfied. Do not omit this line.",
            automation.prompt, condition,
        ),
        None => automation.prompt.clone(),
    }
}

#[derive(Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
struct AutomationStopConditionVerdict {
    stop_condition_met: bool,
}

#[derive(Debug, Eq, PartialEq)]
struct AutomationExecutionOutcome {
    summary: String,
    stop_condition_met: Option<bool>,
}

fn parse_automation_execution_outcome(
    automation: &Automation,
    response: &str,
) -> Result<AutomationExecutionOutcome, String> {
    if automation.stop_condition.is_none() {
        return Ok(AutomationExecutionOutcome {
            summary: response.trim().to_string(),
            stop_condition_met: None,
        });
    }

    let marker_start = response
        .rfind(AUTOMATION_RESULT_MARKER_PREFIX)
        .ok_or_else(|| {
            "Automation failed closed because the provider did not report a stop-condition verdict"
                .to_string()
        })?;
    let marker_payload_start = marker_start + AUTOMATION_RESULT_MARKER_PREFIX.len();
    let marker_tail = &response[marker_payload_start..];
    let marker_end = marker_tail
        .find(AUTOMATION_RESULT_MARKER_SUFFIX)
        .ok_or_else(|| {
            "Automation failed closed because the provider returned an incomplete stop-condition verdict"
                .to_string()
        })?;
    let trailing = &marker_tail[marker_end + AUTOMATION_RESULT_MARKER_SUFFIX.len()..];
    if !trailing.trim().is_empty() {
        return Err(
            "Automation failed closed because its stop-condition verdict was not the final output"
                .into(),
        );
    }

    let verdict = serde_json::from_str::<AutomationStopConditionVerdict>(
        marker_tail[..marker_end].trim(),
    )
    .map_err(|_| {
        "Automation failed closed because the provider returned an invalid stop-condition verdict"
            .to_string()
    })?;
    let summary = response[..marker_start].trim();
    Ok(AutomationExecutionOutcome {
        summary: if summary.is_empty() {
            "Automation completed and evaluated its stop condition".into()
        } else {
            summary.to_string()
        },
        stop_condition_met: Some(verdict.stop_condition_met),
    })
}

fn bounded_automation_summary(value: &str) -> String {
    truncate_chars(value.trim(), 600)
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
    read_session_events_from_store(&store, session_id).map_err(to_string)
}

fn read_session_events_from_store(
    store: &SessionStore,
    session_id: Uuid,
) -> anyhow::Result<Vec<SessionEvent>> {
    let mut events = store.read_recent_events(session_id, MAX_DESKTOP_SESSION_EVENTS_READ)?;
    let represented_proposals = events
        .iter()
        .filter_map(event_mutation_proposal_id)
        .collect::<HashSet<_>>();
    for proposal in store.list_pending_mutation_proposals(session_id)? {
        if represented_proposals.contains(&proposal.id) {
            continue;
        }
        let recovered = store.append_event_with_turn_id(
            session_id,
            SessionEventKind::ApprovalRequested,
            format!("Review changes to {}", proposal.path),
            mutation_approval_payload(&proposal, None),
            proposal.turn_id,
        )?;
        events.push(recovered);
    }
    Ok(events)
}

fn event_mutation_proposal_id(event: &SessionEvent) -> Option<Uuid> {
    let payload = event.payload.as_object()?;
    if payload.get("kind")?.as_str()? != "mutation-approval" {
        return None;
    }
    Uuid::parse_str(payload.get("proposalId")?.as_str()?).ok()
}

#[tauri::command]
async fn append_user_message(
    session_id: String,
    message: String,
    turn_id: Option<String>,
    #[allow(unused_variables)] attachments: Option<Vec<ChatAttachmentRequest>>,
) -> Result<SessionEvent, String> {
    let message = validate_chat_message(&message)?;
    tauri::async_runtime::spawn_blocking(move || {
        append_user_message_blocking(
            session_id,
            message,
            turn_id,
            attachments.unwrap_or_default(),
        )
    })
    .await
    .map_err(|error| format!("user message worker failed: {error}"))?
}

fn append_user_message_blocking(
    session_id: String,
    message: String,
    turn_id: Option<String>,
    attachments: Vec<ChatAttachmentRequest>,
) -> Result<SessionEvent, String> {
    let store = open_store()?;
    let session_id = parse_uuid(&session_id)?;
    if let Some(turn_id) = turn_id.as_deref() {
        return store
            .append_user_turn_message_with_turn_id(
                session_id,
                message,
                serde_json::json!({ "surface": "desktop", "attachments": attachments }),
                parse_uuid(turn_id)?,
            )
            .map_err(to_string);
    }
    store
        .append_user_turn_message(
            session_id,
            message,
            serde_json::json!({ "surface": "desktop", "attachments": attachments }),
        )
        .map_err(to_string)
}

#[tauri::command]
async fn run_provider_chat(
    app: tauri::AppHandle,
    mut request: ProviderChatRequest,
) -> Result<ProviderChatResponse, String> {
    request.message = validate_chat_message(&request.message)?;
    let session_id = request.session_id.clone();
    {
        let manager = app.state::<ProviderCancellationManager>();
        let mut flags = manager
            .flags
            .lock()
            .map_err(|_| "provider cancellation state is unavailable".to_string())?;
        if flags.contains_key(&session_id) {
            return Err("a provider turn is already running for this session".into());
        }
        if flags.len() >= MAX_CONCURRENT_PROVIDER_RUNS {
            return Err(format!(
                "Gyro can run at most {MAX_CONCURRENT_PROVIDER_RUNS} provider turns at once"
            ));
        }
        flags.insert(session_id.clone(), Arc::new(ProviderRunControl::default()));
    }
    let worker_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_provider_chat_blocking(worker_app, request)
    })
    .await
    .map_err(|error| format!("provider chat worker failed: {error}"));
    app.state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .map(|mut flags| flags.remove(&session_id));
    result?
}

#[tauri::command]
async fn stop_provider_chat(
    session_id: String,
    manager: tauri::State<'_, ProviderCancellationManager>,
) -> Result<(), String> {
    let flags = manager
        .flags
        .lock()
        .map_err(|_| "provider cancellation state is unavailable")?;
    let flag = flags
        .get(&session_id)
        .ok_or_else(|| "no provider turn is running for this session".to_string())?;
    flag.cancellation.cancel();
    Ok(())
}

fn run_provider_chat_blocking(
    app: tauri::AppHandle,
    mut request: ProviderChatRequest,
) -> Result<ProviderChatResponse, String> {
    let store = open_store()?;
    let session_id = parse_uuid(&request.session_id)?;
    let session = store
        .get_session(session_id)
        .map_err(to_string)?
        .ok_or_else(|| "provider chat session no longer exists".to_string())?;
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    let config = GyroConfig::load(&paths).map_err(to_string)?;
    bind_provider_chat_request(&mut request, &session, &config)?;
    request.message = validate_chat_message(&request.message)?;
    validate_chat_context(&request)?;
    let turn_id = request.turn_id.as_deref().map(parse_uuid).transpose()?;
    let run_id = turn_id.unwrap_or_else(Uuid::new_v4);
    if provider_turn_has_unfinished_attempt(&store, session_id, run_id).map_err(to_string)? {
        return Err(
            "this turn has an unfinished provider attempt; start a new turn to avoid replaying tools"
                .into(),
        );
    }
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
            let status = if error.contains("chat cancelled by user") {
                HarnessRunStatus::Cancelled
            } else if adapter.kind == ProviderAdapterKind::ReadinessOnly {
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
                if status == HarnessRunStatus::Cancelled {
                    "cancelled"
                } else {
                    "failed"
                },
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
    let plan_extraction = extract_plan_update_marker(&title_extraction.message);
    let resume_cursor_value = runner_output
        .resume_cursor
        .as_ref()
        .map(serde_json::to_value)
        .transpose()
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
    .unwrap_or_else(|error| {
        serde_json::json!({
            "schema": gyro_core::HARNESS_SCHEMA_V1,
            "kind": "provider-response",
            "runId": run_id,
            "attemptId": attempt_id,
            "status": "done",
            "metadataError": gyro_core::sanitize_harness_text(&error.to_string()),
        })
    });
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
        if let Some(context_usage) = runner_output.context_usage.as_ref() {
            object.insert(
                "contextUsage".into(),
                serde_json::to_value(context_usage).map_err(to_string)?,
            );
        }
    }
    let assistant_event = store
        .append_event_with_turn_id(
            session_id,
            SessionEventKind::AssistantMessage,
            plan_extraction.message,
            assistant_payload,
            Some(run_id),
        )
        .map_err(to_string)?;
    // Persist the response before advancing the provider cursor. The response is
    // the durable source of truth even if cursor metadata cannot be updated.
    if let Some(resume_cursor_value) = resume_cursor_value {
        if let Err(error) = store.upsert_provider_session_binding(
            session_id,
            request.provider_id.clone(),
            request.model_id.clone(),
            request.model_label.clone(),
            request.reasoning_effort.clone(),
            resume_cursor_value,
            "ready",
            None,
        ) {
            eprintln!(
                "provider response was saved but its resume cursor was not: {}",
                gyro_core::security::redact_secrets(&error.to_string())
            );
        }
    }

    // Timeline enrichment is intentionally best-effort after the assistant
    // response is durable. A title, activity, or diagnostics failure must not
    // turn a completed provider request into a duplicate retry.
    let plan_payload = plan_extraction.payload.clone().or_else(|| {
        runner_output
            .activities
            .iter()
            .rev()
            .find_map(kimi_acp_plan_payload)
    });
    let plan_event = plan_payload.and_then(|payload| {
        store
            .append_event_with_turn_id(
                session_id,
                SessionEventKind::PlanUpdated,
                "Provider updated the plan",
                payload,
                Some(run_id),
            )
            .ok()
    });
    let renamed_session = title_extraction
        .title
        .as_deref()
        .and_then(|title| store.rename_session(session_id, title).ok().flatten());
    let session_summary = derive_session_summary(&assistant_event.message);
    let session = session_summary
        .as_deref()
        .and_then(|summary| {
            store
                .update_session_summary(session_id, summary)
                .ok()
                .flatten()
        })
        .or(renamed_session);
    let activity_entries = runner_output
        .activities
        .iter()
        .map(|activity| provider_activity_event_entry(&request, run_id, activity))
        .collect();
    let mut activity_events =
        match store.append_system_events_with_turn_id(session_id, activity_entries) {
            Ok(events) => events,
            Err(error) => {
                eprintln!(
                    "provider response was saved without its activity batch: {}",
                    gyro_core::security::redact_secrets(&error.to_string())
                );
                Vec::new()
            }
        };
    if let Some(plan_event) = plan_event {
        activity_events.push(plan_event);
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
    .unwrap_or_else(|error| {
        eprintln!(
            "provider response was saved without its completion status: {}",
            gyro_core::security::redact_secrets(&error.to_string())
        );
        let mut event = SessionEvent::new(
            session_id,
            SessionEventKind::SystemEvent,
            provider_chat_status_message(
                &HarnessRunStatus::Done,
                request.provider_label.as_deref().unwrap_or("Provider"),
            ),
            serde_json::json!({
                "schema": gyro_core::HARNESS_SCHEMA_V1,
                "kind": "provider-status",
                "status": "done",
                "runId": run_id,
                "attemptId": attempt_id,
                "persistence": "response-only",
            }),
        );
        event.turn_id = Some(run_id);
        event
    });
    let _ = append_provider_diagnostics_event(
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
    );
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
        activity_events,
        assistant_event,
        session_title: title_extraction.title,
        session,
        status_event,
        resume_cursor: runner_output.resume_cursor,
    })
}

fn bind_provider_chat_request(
    request: &mut ProviderChatRequest,
    session: &Session,
    config: &GyroConfig,
) -> Result<(), String> {
    if request.session_id != session.id.to_string() {
        return Err("provider chat session identity did not match stored state".into());
    }
    let provider_id = session
        .provider_id
        .as_deref()
        .ok_or_else(|| "select a provider before starting chat".to_string())?;
    if request.provider_id != provider_id {
        return Err("provider selection changed; refresh the chat and try again".into());
    }
    let provider = config
        .model_providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| "the selected provider is not configured".to_string())?;
    if !provider.enabled {
        return Err("the selected provider is disabled in Gyro settings".into());
    }
    if request.model_id != session.model_id || request.reasoning_effort != session.reasoning_effort
    {
        return Err("model selection changed; refresh the chat and try again".into());
    }

    let workspace = session
        .workspace_path
        .canonicalize()
        .map_err(|_| "the chat workspace is no longer available".to_string())?;
    if !workspace.is_dir() {
        return Err("the chat workspace is not a directory".into());
    }
    if let Some(requested_workspace) = request
        .workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        let requested_workspace = PathBuf::from(requested_workspace)
            .canonicalize()
            .map_err(|_| "the requested workspace is no longer available".to_string())?;
        if requested_workspace != workspace {
            return Err("workspace selection changed; refresh the chat and try again".into());
        }
    }

    // The renderer selects UX state, but native execution authority always comes
    // from persisted backend state. This prevents a stale or compromised renderer
    // from weakening approvals or swapping provider/workspace/model identity.
    request.provider_id = provider_id.to_string();
    request.provider_label = session
        .provider_label
        .clone()
        .or_else(|| Some(provider.display_name.clone()));
    request.model_id = session.model_id.clone();
    request.model_label = session.model_label.clone();
    request.reasoning_effort = session.reasoning_effort.clone();
    request.workspace_path = Some(workspace.display().to_string());
    request.require_command_approval = config.require_command_approval;
    request.require_file_edit_approval = config.require_file_edit_approval;
    request.full_access = config.full_access;
    Ok(())
}

fn validate_chat_context(request: &ProviderChatRequest) -> Result<(), String> {
    if request.attachments.len() > MAX_CHAT_ATTACHMENTS {
        return Err(format!(
            "attach at most {MAX_CHAT_ATTACHMENTS} files per turn"
        ));
    }
    let images = request
        .attachments
        .iter()
        .filter(|attachment| attachment.kind == "image")
        .count();
    if images > MAX_CHAT_IMAGES {
        return Err(format!("attach at most {MAX_CHAT_IMAGES} images per turn"));
    }
    let mut total_bytes = 0_u64;
    for attachment in &request.attachments {
        validate_attachment_name(&attachment.name)?;
        let path = PathBuf::from(&attachment.path);
        let link_metadata = fs::symlink_metadata(&path)
            .map_err(|_| format!("{} is no longer available", attachment.name))?;
        if link_metadata.file_type().is_symlink() || !link_metadata.is_file() {
            return Err(format!("{} is not a file", attachment.name));
        }
        let metadata = path
            .metadata()
            .map_err(|_| format!("{} is no longer available", attachment.name))?;
        if metadata.len() != attachment.size {
            return Err(format!(
                "{} changed after it was attached; remove it and attach the current file",
                attachment.name
            ));
        }
        total_bytes = total_bytes
            .checked_add(metadata.len())
            .ok_or_else(|| "attachment size overflow".to_string())?;
        if total_bytes > MAX_CHAT_ATTACHMENT_TOTAL_BYTES {
            return Err("attachments exceed the 64 MB per-turn limit".into());
        }
        if attachment.kind == "image" && metadata.len() > MAX_CHAT_IMAGE_BYTES {
            return Err(format!("{} exceeds the 10 MB image limit", attachment.name));
        }
        if attachment.kind == "image" {
            let expected_hash = attachment
                .content_hash
                .as_deref()
                .ok_or_else(|| format!("{} is missing its integrity hash", attachment.name))?;
            let canonical = path.canonicalize().map_err(to_string)?;
            let paths = GyroPaths::for_current_user().map_err(to_string)?;
            let attachment_dir = paths
                .sessions_dir
                .join("attachments")
                .join(&request.session_id)
                .canonicalize()
                .map_err(|_| "session attachment storage is unavailable".to_string())?;
            if !canonical.starts_with(&attachment_dir) {
                return Err(format!(
                    "{} is outside this session's private attachment storage",
                    attachment.name
                ));
            }
            let (current, current_size) =
                hash_file_streaming(&canonical, Some(MAX_CHAT_IMAGE_BYTES))?;
            if current_size != attachment.size || current != expected_hash {
                return Err(format!(
                    "{} changed after it was attached; remove it and attach the current file",
                    attachment.name
                ));
            }
        } else if attachment.kind == "workspace-file" {
            if metadata.len() > MAX_CHAT_WORKSPACE_ATTACHMENT_BYTES {
                return Err(format!(
                    "{} exceeds the 32 MB workspace attachment limit",
                    attachment.name
                ));
            }
            let workspace = request
                .workspace_path
                .as_deref()
                .ok_or_else(|| "workspace attachment has no selected workspace".to_string())?;
            let canonical = path.canonicalize().map_err(to_string)?;
            let workspace = PathBuf::from(workspace).canonicalize().map_err(to_string)?;
            if !canonical.starts_with(workspace) {
                return Err(format!(
                    "{} escapes the selected workspace",
                    attachment.name
                ));
            }
            let expected = attachment
                .content_hash
                .as_deref()
                .ok_or_else(|| format!("{} is missing its integrity hash", attachment.name))?;
            let (current, current_size) =
                hash_file_streaming(&canonical, Some(MAX_CHAT_WORKSPACE_ATTACHMENT_BYTES))?;
            if current_size != attachment.size || current != expected {
                return Err(format!(
                    "{} changed after it was attached; remove it and attach the current file",
                    attachment.name
                ));
            }
        } else {
            return Err(format!(
                "{} has an unsupported attachment kind",
                attachment.name
            ));
        }
    }
    Ok(())
}

fn provider_context_message(request: &ProviderChatRequest) -> String {
    let mut context = Vec::new();
    context.push(format!(
        "Gyro chat mode: {}.",
        if request.mode == ChatMode::Plan {
            "plan"
        } else {
            "normal"
        }
    ));
    if request.mode == ChatMode::Plan {
        context.push("Plan mode is read-only. Inspect and reason, but do not mutate files, run mutating commands, or start services.".into());
        context.push("When you create or revise the checklist, include one hidden line before the answer in this exact form: GYRO_PLAN_UPDATE: {\"action\":\"replace\",\"title\":\"Plan\",\"items\":[{\"id\":\"stable-id\",\"title\":\"Step\",\"status\":\"todo\"}]}. Keep the JSON on one line.".into());
        context.push("When the plan is ready for implementation, present the complete plan as polished Markdown with a descriptive heading and clear sections. Gyro displays that response as the Plan document.".into());
    }
    if let Some(goal) = request.goal.as_ref().filter(|goal| goal.status == "active") {
        context.push(format!("Active Gyro session goal: {}", goal.text.trim()));
    }
    if let Some(plan) = request.plan.as_ref() {
        context.push(format!("Current Gyro plan snapshot: {plan}"));
    }
    let references = request
        .attachments
        .iter()
        .filter(|attachment| {
            attachment.kind == "workspace-file" || request.provider_id == "anthropic"
        })
        .map(|attachment| format!("- {} ({})", attachment.name, attachment.path))
        .collect::<Vec<_>>();
    if !references.is_empty() {
        context.push(format!(
            "Explicit user attachments:\n{}",
            references.join("\n")
        ));
    }
    format!(
        "{}\n\nUser message:\n{}",
        context.join("\n"),
        request.message
    )
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
async fn append_chat_context_event(
    session_id: String,
    event_kind: String,
    message: String,
    payload: serde_json::Value,
) -> Result<SessionEvent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = open_store()?;
        let session_id = parse_uuid(&session_id)?;
        let kind = match event_kind.as_str() {
            "goal-updated" => SessionEventKind::GoalUpdated,
            "chat-mode-changed" => SessionEventKind::ChatModeChanged,
            _ => return Err("unsupported chat context event kind".into()),
        };
        store
            .append_event(session_id, kind, message, payload)
            .map_err(to_string)
    })
    .await
    .map_err(|error| format!("chat context event worker failed: {error}"))?
}

#[tauri::command]
async fn prepare_chat_attachment(
    request: PrepareChatAttachmentRequest,
) -> Result<PreparedChatAttachment, String> {
    tauri::async_runtime::spawn_blocking(move || prepare_chat_attachment_blocking(request))
        .await
        .map_err(|error| format!("attachment worker failed: {error}"))?
}

fn prepare_chat_attachment_blocking(
    request: PrepareChatAttachmentRequest,
) -> Result<PreparedChatAttachment, String> {
    let safe_session = if request.session_id == "new" {
        "new".to_string()
    } else {
        parse_uuid(&request.session_id)?.to_string()
    };
    let attachment_lock = attachment_session_lock(&safe_session)?;
    let _attachment_guard = attachment_lock
        .lock()
        .map_err(|_| "session attachment lock is unavailable".to_string())?;
    if safe_session != "new" {
        let store = open_store()?;
        let session_id = parse_uuid(&safe_session)?;
        if store.get_session(session_id).map_err(to_string)?.is_none() {
            return Err("the attachment session no longer exists".into());
        }
    }
    let source = (!request.path.trim().is_empty())
        .then(|| PathBuf::from(request.path.trim()).canonicalize())
        .transpose()
        .map_err(|_| "attachment file is missing or unavailable".to_string())?;
    let metadata = source
        .as_ref()
        .map(|path| path.metadata())
        .transpose()
        .map_err(to_string)?;
    if metadata.as_ref().is_some_and(|value| !value.is_file()) {
        return Err("directories cannot be attached".into());
    }
    let name = request
        .name
        .clone()
        .or_else(|| source.as_ref()?.file_name()?.to_str().map(str::to_string))
        .ok_or_else(|| "attachment name is invalid".to_string())?;
    validate_attachment_name(&name)?;
    let modified_at = metadata
        .as_ref()
        .and_then(|metadata| metadata.modified().ok())
        .map(chrono::DateTime::<chrono::Utc>::from)
        .map(|value| value.to_rfc3339());

    let (path, relative_path, mime_type, size, content_hash) = if request.kind == "image" {
        if metadata
            .as_ref()
            .is_some_and(|metadata| metadata.len() > MAX_CHAT_IMAGE_BYTES)
        {
            return Err("images must be 10 MB or smaller".into());
        }
        let bytes = match request.bytes {
            Some(bytes) => bytes,
            None => read_bounded_regular_file(
                source
                    .as_ref()
                    .ok_or_else(|| "image attachment has no source data".to_string())?,
                MAX_CHAT_IMAGE_BYTES as usize,
                "image attachment",
            )
            .map(|(bytes, _)| bytes)
            .map_err(|_| "attachment file is empty or unreadable".to_string())?,
        };
        if bytes.is_empty() {
            return Err("attachment file is empty or unreadable".into());
        }
        if bytes.len() as u64 > MAX_CHAT_IMAGE_BYTES {
            return Err("images must be 10 MB or smaller".into());
        }
        let extension = Path::new(&name)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let mime = match extension.as_str() {
            "png" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => "image/png",
            "jpg" | "jpeg" if bytes.starts_with(&[0xff, 0xd8, 0xff]) => "image/jpeg",
            "webp" if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") => {
                "image/webp"
            }
            "png" | "jpg" | "jpeg" | "webp" => {
                return Err("image contents do not match the selected file type".into())
            }
            _ => return Err("only PNG, JPEG, and WebP images are supported".into()),
        };
        let safe_extension = match mime {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/webp" => "webp",
            _ => unreachable!("validated image MIME"),
        };
        let content_hash = format!("{:x}", Sha256::digest(&bytes));
        let paths = GyroPaths::for_current_user().map_err(to_string)?;
        paths.ensure().map_err(to_string)?;
        let attachments_root = paths.sessions_dir.join("attachments");
        ensure_private_attachment_directory(&attachments_root)?;
        let attachment_dir = attachments_root.join(&safe_session);
        ensure_private_attachment_directory(&attachment_dir)?;
        // Never incorporate the renderer-provided display name into a filesystem
        // path. Content-addressed native filenames eliminate traversal and make
        // deduplication safe.
        let destination = attachment_dir.join(format!("{content_hash}.{safe_extension}"));
        ensure_attachment_storage_quota(&attachment_dir, &destination, bytes.len() as u64)?;
        write_private_attachment(&destination, &bytes, &content_hash)?;
        if safe_session != "new" {
            if let Some(source) = source.as_ref() {
                let draft_dir = attachments_root.join("new");
                if source.starts_with(&draft_dir) && source != &destination {
                    let _ = fs::remove_file(source);
                }
            }
        }
        (
            destination.display().to_string(),
            None,
            Some(mime.to_string()),
            bytes.len() as u64,
            content_hash,
        )
    } else if request.kind == "workspace-file" {
        let workspace = request
            .workspace_path
            .as_deref()
            .ok_or_else(|| "select a workspace before attaching a file".to_string())?;
        let source = source.ok_or_else(|| "workspace files require a local path".to_string())?;
        let workspace = PathBuf::from(workspace).canonicalize().map_err(to_string)?;
        if !source.starts_with(&workspace) {
            return Err("workspace file must remain inside the selected workspace".into());
        }
        let relative = source
            .strip_prefix(&workspace)
            .map_err(to_string)?
            .display()
            .to_string();
        let (content_hash, size) =
            hash_file_streaming(&source, Some(MAX_CHAT_WORKSPACE_ATTACHMENT_BYTES))?;
        if size == 0 {
            return Err("attachment file is empty or unreadable".into());
        }
        (
            source.display().to_string(),
            Some(relative),
            None,
            size,
            content_hash,
        )
    } else {
        return Err("unsupported attachment kind".into());
    };

    Ok(PreparedChatAttachment {
        id: Uuid::new_v4().to_string(),
        kind: request.kind,
        name,
        path,
        relative_path,
        mime_type,
        size,
        content_hash,
        modified_at,
        available: true,
        stale: false,
    })
}

fn validate_attachment_name(name: &str) -> Result<(), String> {
    let mut components = Path::new(name).components();
    let is_single_component = matches!(components.next(), Some(std::path::Component::Normal(_)))
        && components.next().is_none();
    if !is_single_component || name.chars().count() > 255 || name.chars().any(char::is_control) {
        return Err("attachment name must be a single safe file name".into());
    }
    Ok(())
}

fn ensure_private_attachment_directory(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err("attachment storage path is not a private directory".into());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path).map_err(to_string)?;
        }
        Err(error) => return Err(to_string(error)),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(to_string)?;
    }
    Ok(())
}

fn ensure_attachment_storage_quota(
    directory: &Path,
    destination: &Path,
    incoming_bytes: u64,
) -> Result<(), String> {
    if fs::symlink_metadata(destination).is_ok() {
        return Ok(());
    }
    let mut files = 0usize;
    let mut bytes = 0u64;
    for entry in fs::read_dir(directory).map_err(to_string)? {
        let entry = entry.map_err(to_string)?;
        let name = entry.file_name();
        if name.to_string_lossy().starts_with(".upload-") {
            let _ = remove_attachment_storage_entry(&entry.path());
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(to_string)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("session attachment storage contains an unsafe entry".into());
        }
        files = files.saturating_add(1);
        bytes = bytes
            .checked_add(metadata.len())
            .ok_or_else(|| "attachment storage size overflow".to_string())?;
    }
    if files >= MAX_STORED_CHAT_ATTACHMENTS_PER_SESSION
        || bytes
            .checked_add(incoming_bytes)
            .map_or(true, |total| total > MAX_CHAT_ATTACHMENT_TOTAL_BYTES)
    {
        return Err("session attachment storage limit reached".into());
    }
    Ok(())
}

fn write_private_attachment(path: &Path, bytes: &[u8], expected_hash: &str) -> Result<(), String> {
    if fs::symlink_metadata(path).is_ok() {
        return validate_private_attachment(path, expected_hash);
    }
    let parent = path
        .parent()
        .ok_or_else(|| "attachment destination has no parent directory".to_string())?;
    let temporary = parent.join(format!(".upload-{}", Uuid::new_v4().simple()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).map_err(to_string)?;
    let write_result = file.write_all(bytes).and_then(|_| file.sync_all());
    drop(file);
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary);
        return Err(to_string(error));
    }
    let link_result = fs::hard_link(&temporary, path);
    let _ = fs::remove_file(&temporary);
    match link_result {
        Ok(()) => {
            #[cfg(unix)]
            if let Ok(parent) = fs::File::open(parent) {
                let _ = parent.sync_all();
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            validate_private_attachment(path, expected_hash)
        }
        Err(error) => Err(to_string(error)),
    }
}

fn validate_private_attachment(path: &Path, expected_hash: &str) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(to_string)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("attachment destination is not a regular file".into());
    }
    let (actual_hash, _) = hash_file_streaming(path, Some(MAX_CHAT_IMAGE_BYTES))?;
    if actual_hash != expected_hash {
        return Err("attachment destination already contains different data".into());
    }
    Ok(())
}

fn hash_file_streaming(path: &Path, max_bytes: Option<u64>) -> Result<(String, u64), String> {
    let mut file = fs::File::open(path).map_err(to_string)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let count = file.read(&mut buffer).map_err(to_string)?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .ok_or_else(|| "attachment size overflow".to_string())?;
        if max_bytes.is_some_and(|limit| total > limit) {
            return Err("attachment exceeds the allowed size".into());
        }
        hasher.update(&buffer[..count]);
    }
    Ok((format!("{:x}", hasher.finalize()), total))
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
        GyroConfig::update(&paths, |persisted| {
            *persisted = merge_renderer_config(config, persisted);
            Ok(())
        })
        .map_err(to_string)
    })
    .await
    .map_err(|error| format!("config save worker failed: {error}"))?
}

fn merge_renderer_config(mut incoming: GyroConfig, persisted: &GyroConfig) -> GyroConfig {
    // Account issuer/session state is owned by the native login flow. A renderer
    // settings write must not redirect refresh tokens or forge a signed-in user.
    incoming.account_oidc = persisted.account_oidc.clone();
    incoming.account_session = persisted.account_session.clone();
    incoming
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
    scan_workspace_tree(&root, max_depth).map(|snapshot| snapshot.files)
}

fn scan_workspace_tree(root: &Path, max_depth: usize) -> Result<WorkspaceTreeSnapshot, String> {
    let mut entries = Vec::new();
    let root_metadata = fs::symlink_metadata(root).map_err(to_string)?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err("workspace root is not a regular directory".into());
    }
    let mut directories = vec![WorkspaceDirectoryStamp {
        path: root.to_path_buf(),
        modified: root_metadata.modified().ok(),
        len: root_metadata.len(),
    }];

    for entry in WalkDir::new(root)
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
        let path = entry.path().strip_prefix(root).map_err(to_string)?;
        let kind = if entry.file_type().is_dir() {
            let metadata = entry.metadata().map_err(to_string)?;
            directories.push(WorkspaceDirectoryStamp {
                path: entry.path().to_path_buf(),
                modified: metadata.modified().ok(),
                len: metadata.len(),
            });
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

    entries.sort_by(compare_workspace_tree_entries);
    Ok(WorkspaceTreeSnapshot {
        files: entries,
        directories,
        scanned_at: Instant::now(),
    })
}

fn compare_workspace_tree_entries(a: &WorkspaceFile, b: &WorkspaceFile) -> std::cmp::Ordering {
    let mut a_components = Path::new(&a.path).components().peekable();
    let mut b_components = Path::new(&b.path).components().peekable();

    loop {
        match (a_components.next(), b_components.next()) {
            (Some(a_component), Some(b_component)) if a_component == b_component => continue,
            (Some(a_component), Some(b_component)) => {
                let a_is_directory = a_components.peek().is_some() || a.kind == "directory";
                let b_is_directory = b_components.peek().is_some() || b.kind == "directory";
                return b_is_directory
                    .cmp(&a_is_directory)
                    .then_with(|| a_component.as_os_str().cmp(b_component.as_os_str()));
            }
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (None, None) => return std::cmp::Ordering::Equal,
        }
    }
}

impl WorkspaceDirectoryStamp {
    fn is_current(&self) -> bool {
        let Ok(metadata) = fs::symlink_metadata(&self.path) else {
            return false;
        };
        !metadata.file_type().is_symlink()
            && metadata.is_dir()
            && metadata.len() == self.len
            && metadata.modified().ok() == self.modified
    }
}

impl WorkspaceWatchManager {
    fn snapshot(&self, workspace_path: &str) -> Result<Vec<WorkspaceFile>, String> {
        let root = PathBuf::from(workspace_path)
            .canonicalize()
            .map_err(to_string)?;
        let cached = self
            .snapshots
            .lock()
            .map_err(|_| "workspace watch cache is unavailable".to_string())?
            .get(&root)
            .cloned();
        if let Some(cached) = cached {
            if cached.scanned_at.elapsed() < WORKSPACE_TREE_MAX_CACHE_AGE
                && cached
                    .directories
                    .iter()
                    .all(WorkspaceDirectoryStamp::is_current)
            {
                return Ok(cached.files);
            }
        }

        let snapshot = scan_workspace_tree(&root, 5)?;
        let files = snapshot.files.clone();
        let mut snapshots = self
            .snapshots
            .lock()
            .map_err(|_| "workspace watch cache is unavailable".to_string())?;
        if !snapshots.contains_key(&root) && snapshots.len() >= MAX_WORKSPACE_WATCH_CACHES {
            if let Some(oldest) = snapshots
                .iter()
                .min_by_key(|(_, cached)| cached.scanned_at)
                .map(|(path, _)| path.clone())
            {
                snapshots.remove(&oldest);
            }
        }
        snapshots.insert(root, snapshot);
        Ok(files)
    }
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
async fn create_file_mutation_proposal(
    request: FileMutationProposalRequest,
) -> Result<MutationProposal, String> {
    tauri::async_runtime::spawn_blocking(move || {
        create_file_mutation_proposal_impl(request).map_err(to_string)
    })
    .await
    .map_err(|error| format!("file mutation proposal worker failed: {error}"))?
}

#[tauri::command]
async fn resolve_file_mutation_proposal(
    request: FileMutationDecisionRequest,
) -> Result<FileMutationDecisionResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        resolve_file_mutation_proposal_impl(request).map_err(to_string)
    })
    .await
    .map_err(|error| format!("file mutation decision worker failed: {error}"))?
}

#[tauri::command]
async fn resolve_provider_approval(
    app: tauri::AppHandle,
    request: ProviderApprovalDecisionRequest,
) -> Result<SessionEvent, String> {
    let decision = match request.decision.as_str() {
        "approve" => ProviderApprovalDecision::Approve,
        "reject" => ProviderApprovalDecision::Reject,
        _ => return Err("provider approval decision must be approve or reject".into()),
    };
    let pending = app
        .state::<ProviderApprovalManager>()
        .pending
        .lock()
        .map_err(|_| "provider approval state is unavailable".to_string())?
        .remove(&request.approval_id)
        .ok_or_else(|| "this provider approval is no longer pending".to_string())?;
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    let store = SessionStore::open(paths.clone()).map_err(to_string)?;
    let mut payload = pending.payload;
    let mut provider_decision = decision;
    let mut pending_mutation: Option<PendingProviderMutationCommit> = None;
    if decision == ProviderApprovalDecision::Approve {
        if let Some(transaction) = pending.file_transaction.as_ref() {
            match begin_provider_mutation_transaction(
                transaction,
                &paths.mutation_journals_dir,
                ProviderMutationJournalContext {
                    session_id: pending.session_id,
                    approval_id: pending.approval_id,
                },
            ) {
                Ok(commit) => {
                    payload["changedPaths"] =
                        serde_json::to_value(commit.result().changed_paths.clone())
                            .map_err(|error| error.to_string())?;
                    provider_decision = ProviderApprovalDecision::AppliedByGyro;
                    pending_mutation = Some(commit);
                }
                Err(error) => {
                    payload["status"] = serde_json::Value::String("failed".into());
                    payload["error"] = serde_json::Value::String(error.to_string());
                    payload["decidedAt"] =
                        serde_json::Value::String(chrono::Utc::now().to_rfc3339());
                    let event = store.append_event_with_turn_id(
                        pending.session_id,
                        SessionEventKind::SystemEvent,
                        "Provider file changes were not applied",
                        payload,
                        pending.turn_id,
                    );
                    let _ = pending.sender.send(ProviderApprovalDecision::Reject);
                    let event = event.map_err(to_string)?;
                    let _ = app.emit(PROVIDER_APPROVAL_EVENT, event);
                    return Err(format!("The reviewed file set was not applied: {error}"));
                }
            }
        }
    }
    payload["status"] = serde_json::Value::String(
        match provider_decision {
            ProviderApprovalDecision::Approve => "approved",
            ProviderApprovalDecision::Reject => "rejected",
            ProviderApprovalDecision::AppliedByGyro => "applied",
        }
        .into(),
    );
    payload["decidedAt"] = serde_json::Value::String(chrono::Utc::now().to_rfc3339());
    let event = match store.append_event_with_turn_id(
        pending.session_id,
        SessionEventKind::SystemEvent,
        match provider_decision {
            ProviderApprovalDecision::Approve => "Provider action approved",
            ProviderApprovalDecision::Reject => "Provider action rejected",
            ProviderApprovalDecision::AppliedByGyro => "Provider file changes applied through Gyro",
        },
        payload,
        pending.turn_id,
    ) {
        Ok(event) => event,
        Err(error) => {
            let rollback_error = pending_mutation.and_then(|commit| commit.rollback().err());
            let _ = pending.sender.send(ProviderApprovalDecision::Reject);
            return Err(match rollback_error {
                Some(rollback_error) => format!(
                    "record provider approval failed ({error}); rollback also failed: {rollback_error}"
                ),
                None => to_string(error),
            });
        }
    };
    if let Some(commit) = pending_mutation {
        if let Err(error) = commit.finalize() {
            eprintln!("Gyro deferred provider mutation cleanup until restart: {error}");
        }
    }
    pending
        .sender
        .send(provider_decision)
        .map_err(|_| "the provider turn ended before the decision was delivered".to_string())?;
    let _ = app.emit(PROVIDER_APPROVAL_EVENT, event.clone());
    Ok(event)
}

#[tauri::command]
async fn watch_workspace(
    workspace_path: String,
    manager: tauri::State<'_, WorkspaceWatchManager>,
) -> Result<Vec<WorkspaceFile>, String> {
    // Polling now stats only known directories in the common case. A full walk
    // runs when directory metadata changes or at a bounded reconciliation age.
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.snapshot(&workspace_path))
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
async fn git_branches(workspace_path: String) -> Result<GitBranchCatalog, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_branch_catalog_impl(&workspace_path).map_err(to_string)
    })
    .await
    .map_err(|error| format!("git branch worker failed: {error}"))?
}

#[tauri::command]
async fn git_checkout_branch(
    request: GitCheckoutBranchRequest,
) -> Result<GitBranchCatalog, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_checkout_branch_impl(&request).map_err(to_string)
    })
    .await
    .map_err(|error| format!("git branch checkout worker failed: {error}"))?
}

fn git_branch_catalog_impl(workspace_path: &str) -> anyhow::Result<GitBranchCatalog> {
    let root = workspace_root(workspace_path)?;
    let Some(repo_root) = git_repo_root(&root) else {
        return Ok(GitBranchCatalog {
            available: false,
            current: None,
            branches: Vec::new(),
            error: Some("The selected folder is not a Git repository.".into()),
        });
    };
    let mut command = command_with_gui_path("git");
    command.arg("-C").arg(&repo_root).args([
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads/",
    ]);
    let output = run_bounded_command(
        &command,
        Duration::from_secs(10),
        None,
        2 * 1024 * 1024,
        64 * 1024,
    )?;
    if !output.succeeded() {
        return Err(bounded_command_error(
            "could not list local branches",
            &output,
        ));
    }
    let mut branches = output
        .stdout
        .lines()
        .map(str::trim)
        .filter(|branch| !branch.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    branches.sort();
    branches.dedup();
    let mut current_command = command_with_gui_path("git");
    current_command
        .arg("-C")
        .arg(&repo_root)
        .args(["branch", "--show-current"]);
    let current_output = run_bounded_command(
        &current_command,
        Duration::from_secs(10),
        None,
        64 * 1024,
        64 * 1024,
    )?;
    let current = current_output
        .succeeded()
        .then(|| current_output.stdout.trim().to_string());
    let current = current.filter(|branch| !branch.is_empty());
    Ok(GitBranchCatalog {
        available: true,
        current,
        branches,
        error: None,
    })
}

fn git_checkout_branch_impl(
    request: &GitCheckoutBranchRequest,
) -> anyhow::Result<GitBranchCatalog> {
    gyro_core::validate_branch_name(&request.branch)?;
    let root = workspace_root(&request.workspace_path)?;
    let repo_root = git_repo_root(&root)
        .ok_or_else(|| anyhow::anyhow!("the selected folder is not a Git repository"))?;
    let catalog = git_branch_catalog_impl(&request.workspace_path)?;
    if !catalog
        .branches
        .iter()
        .any(|branch| branch == &request.branch)
    {
        return Err(anyhow::anyhow!("local branch not found"));
    }
    if catalog.current.as_deref() == Some(request.branch.as_str()) {
        return Ok(catalog);
    }
    let mut status_command = command_with_gui_path("git");
    status_command
        .arg("-C")
        .arg(&repo_root)
        .args(["status", "--porcelain"]);
    let status = run_bounded_command(
        &status_command,
        Duration::from_secs(10),
        None,
        2 * 1024 * 1024,
        64 * 1024,
    )?;
    if !status.succeeded() {
        return Err(anyhow::anyhow!(
            "could not inspect the workspace before switching branches"
        ));
    }
    if !status.stdout.is_empty() || status.stdout_truncated {
        return Err(anyhow::anyhow!(
            "commit or stash workspace changes before switching branches"
        ));
    }
    let mut switch_command = command_with_gui_path("git");
    switch_command
        .arg("-C")
        .arg(&repo_root)
        .arg("switch")
        .arg("--")
        .arg(&request.branch);
    let switched = run_bounded_command(
        &switch_command,
        Duration::from_secs(60),
        Some(Duration::from_secs(30)),
        64 * 1024,
        64 * 1024,
    )?;
    if !switched.succeeded() {
        return Err(bounded_command_error("could not switch branch", &switched));
    }
    git_branch_catalog_impl(&request.workspace_path)
}

#[tauri::command]
async fn set_session_branch(session_id: String, branch: String) -> Result<Session, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = open_store()?;
        let session_id = parse_uuid(&session_id)?;
        store
            .update_session_branch(session_id, branch)
            .map_err(to_string)?
            .ok_or_else(|| "session not found".into())
    })
    .await
    .map_err(|error| format!("session branch worker failed: {error}"))?
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
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.start(request).map_err(to_string))
        .await
        .map_err(|error| format!("language server start worker failed: {error}"))?
}

#[tauri::command]
async fn lsp_request(
    request: LspRequestPayload,
    manager: tauri::State<'_, LanguageServerManager>,
) -> Result<serde_json::Value, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.request(request).map_err(to_string))
        .await
        .map_err(|error| format!("language server request worker failed: {error}"))?
}

#[tauri::command]
async fn lsp_stop(
    server_id: String,
    manager: tauri::State<'_, LanguageServerManager>,
) -> Result<serde_json::Value, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.stop(&server_id).map_err(to_string))
        .await
        .map_err(|error| format!("language server stop worker failed: {error}"))?
}

impl LanguageServerManager {
    fn start(&self, request: LspStartRequest) -> anyhow::Result<LspSessionResult> {
        let root = workspace_root(&request.workspace_path)?;
        let command_text = request.command.trim().to_string();
        if !language_server_command_is_allowed(&request.language_id, &command_text) {
            anyhow::bail!("language server command is not allowed for this language");
        }
        let mut parts = command_text.split_whitespace();
        let command_name = parts
            .next()
            .ok_or_else(|| anyhow::anyhow!("language server command is required"))?;
        let mut args = parts.map(ToOwned::to_owned).collect::<Vec<_>>();
        if language_server_needs_stdio_arg(command_name) && !args.iter().any(|arg| arg == "--stdio")
        {
            args.push("--stdio".into());
        }

        let existing_processes = {
            let processes = self
                .processes
                .lock()
                .map_err(|_| anyhow::anyhow!("language server manager lock poisoned"))?;
            processes
                .iter()
                .map(|(server_id, process)| (server_id.clone(), process.clone()))
                .collect::<Vec<_>>()
        };
        let mut stale_processes = Vec::new();
        let mut live_processes = 0usize;
        for (server_id, process) in existing_processes {
            let mut process = process
                .lock()
                .map_err(|_| anyhow::anyhow!("language server process lock poisoned"))?;
            if process.child.try_wait()?.is_some() {
                stale_processes.push(server_id);
                continue;
            }
            live_processes += 1;
            if process.language_id == request.language_id && process.command == command_text {
                return Ok(LspSessionResult {
                    server_id,
                    language_id: request.language_id,
                    command: command_text,
                    status: "ready".into(),
                    message: "Language server is already running".into(),
                });
            }
        }
        if !stale_processes.is_empty() {
            let mut processes = self
                .processes
                .lock()
                .map_err(|_| anyhow::anyhow!("language server manager lock poisoned"))?;
            for server_id in stale_processes {
                processes.remove(&server_id);
            }
        }
        if live_processes >= MAX_LANGUAGE_SERVER_PROCESSES {
            anyhow::bail!("language server process limit reached; stop a server first");
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
        let mut processes = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("language server manager lock poisoned"))?;
        if processes.len() >= MAX_LANGUAGE_SERVER_PROCESSES {
            let _ = process.child.kill();
            let _ = process.child.wait();
            anyhow::bail!("language server process limit reached; stop a server first");
        }
        processes.insert(server_id.clone(), Arc::new(Mutex::new(process)));
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
        let process = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("language server manager lock poisoned"))?
            .get(&request.server_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("language server is not running"))?;
        let mut process = process
            .lock()
            .map_err(|_| anyhow::anyhow!("language server process lock poisoned"))?;
        if let Some(status) = process.child.try_wait()? {
            anyhow::bail!("language server exited with {status}");
        }

        if request.method == "$/gyro/poll" {
            let messages = drain_lsp_messages(&mut process)?;
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
            let messages = drain_lsp_messages(&mut process)?;
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
            receive_lsp_response(&mut process, request_id, Duration::from_secs(15))?;
        Ok(serde_json::json!({
            "serverId": request.server_id,
            "status": if response.get("error").is_some() { "error" } else { "ok" },
            "result": response.get("result").cloned(),
            "error": response.get("error").cloned(),
            "messages": messages,
        }))
    }

    fn stop(&self, server_id: &str) -> anyhow::Result<serde_json::Value> {
        let process = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("language server manager lock poisoned"))?
            .remove(server_id);
        let Some(process) = process else {
            return Ok(serde_json::json!({
                "serverId": server_id,
                "status": "stopped",
            }));
        };
        let mut process = process
            .lock()
            .map_err(|_| anyhow::anyhow!("language server process lock poisoned"))?;
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

fn language_server_command_is_allowed(language_id: &str, command: &str) -> bool {
    let normalized = command.split_whitespace().collect::<Vec<_>>().join(" ");
    match language_id {
        "typescript" | "typescriptreact" | "javascript" | "javascriptreact" => {
            normalized == "typescript-language-server --stdio"
        }
        "rust" => normalized == "rust-analyzer",
        "json" => normalized == "vscode-json-language-server --stdio",
        "css" | "scss" | "less" => normalized == "vscode-css-language-server --stdio",
        "html" => normalized == "vscode-html-language-server --stdio",
        _ => false,
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
    let (sender, receiver) = mpsc::sync_channel(IDE_PROTOCOL_CHANNEL_CAPACITY);
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
    let mut header_bytes = 0usize;
    loop {
        let mut header = String::new();
        let remaining = MAX_LSP_HEADER_BYTES.saturating_sub(header_bytes);
        if remaining == 0 {
            anyhow::bail!("language server headers exceed size limit");
        }
        let read = Read::by_ref(reader)
            .take((remaining + 1) as u64)
            .read_line(&mut header)?;
        if read == 0 {
            anyhow::bail!("language server output closed");
        }
        header_bytes = header_bytes.saturating_add(read);
        if header_bytes > MAX_LSP_HEADER_BYTES {
            anyhow::bail!("language server headers exceed size limit");
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
    let mut message_bytes = 0usize;
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
        if messages.len() >= MAX_IDE_PROTOCOL_MESSAGES_PER_RESPONSE {
            anyhow::bail!("language server produced too many messages before its response");
        }
        add_ide_protocol_message_bytes(&mut message_bytes, &message)?;
        messages.push(message);
    }
}

fn drain_lsp_messages(
    process: &mut LanguageServerProcess,
) -> anyhow::Result<Vec<serde_json::Value>> {
    let mut messages = Vec::new();
    let mut message_bytes = 0usize;
    for _ in 0..MAX_IDE_PROTOCOL_MESSAGES_PER_RESPONSE {
        let message = match process.messages.try_recv() {
            Ok(message) => message.map_err(anyhow::Error::msg)?,
            Err(mpsc::TryRecvError::Empty) => break,
            Err(mpsc::TryRecvError::Disconnected) => {
                anyhow::bail!("language server output disconnected")
            }
        };
        handle_lsp_server_message(process, &message)?;
        add_ide_protocol_message_bytes(&mut message_bytes, &message)?;
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
    let _admission = IdeCommandAdmission::acquire()?;
    let root = workspace_root(&request.workspace_path).map_err(to_string)?;
    let task = task_discover_impl(&request.workspace_path)
        .map_err(to_string)?
        .into_iter()
        .find(|task| task.id == request.task_id)
        .ok_or_else(|| "task is no longer present in the workspace".to_string())?;
    if request.command != task.command || request.args != task.args {
        return Err("task definition changed; refresh tasks before running it".into());
    }
    let mut command = command_with_gui_path(&task.command);
    command.current_dir(root).args(&task.args);
    let mut output = run_command_output(command).map_err(to_string)?;
    if output.status == "done" {
        output.stdout = format!("task {} completed\n{}", task.id, output.stdout);
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
    let _admission = IdeCommandAdmission::acquire()?;
    let root = workspace_root(&request.workspace_path).map_err(to_string)?;
    let discovered = task_discover_impl(&request.workspace_path).map_err(to_string)?;
    let requested_ids = request.test_ids.as_deref().unwrap_or_default();
    if requested_ids.len() > 1 {
        return Err("run one native-discovered test task at a time".into());
    }
    let task = if let Some(test_id) = requested_ids.first() {
        discovered
            .into_iter()
            .find(|task| task.group == "test" && task.id == *test_id)
    } else {
        discovered.into_iter().find(|task| task.group == "test")
    }
    .ok_or_else(|| "no native-discovered test task is available".to_string())?;
    if request
        .command
        .as_ref()
        .is_some_and(|command| command != &task.command)
        || request.args.as_ref().is_some_and(|args| args != &task.args)
    {
        return Err("test definition changed; refresh tests before running it".into());
    }
    let mut command = command_with_gui_path(&task.command);
    command.current_dir(root).args(&task.args);
    let mut output = run_command_output(command).map_err(to_string)?;
    output.stdout = format!("tests {:?}\n{}", vec![task.id], output.stdout);
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
        let existing_processes = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("debug adapter manager lock poisoned"))?
            .iter()
            .map(|(session_id, process)| (session_id.clone(), process.clone()))
            .collect::<Vec<_>>();
        let mut stale_processes = Vec::new();
        let mut live_processes = 0usize;
        for (session_id, process) in existing_processes {
            if process
                .lock()
                .map_err(|_| anyhow::anyhow!("debug adapter process lock poisoned"))?
                .child
                .try_wait()?
                .is_some()
            {
                stale_processes.push(session_id);
            } else {
                live_processes += 1;
            }
        }
        if !stale_processes.is_empty() {
            let mut processes = self
                .processes
                .lock()
                .map_err(|_| anyhow::anyhow!("debug adapter manager lock poisoned"))?;
            for session_id in stale_processes {
                processes.remove(&session_id);
            }
        }
        if live_processes >= MAX_DEBUG_ADAPTER_PROCESSES {
            anyhow::bail!("debug adapter process limit reached; stop a debug session first");
        }
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
        if !debug_adapter_command_is_allowed(&request.adapter, command_name, &args) {
            anyhow::bail!("debug adapter command requires a native allowlist entry");
        }
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
        let mut processes = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("debug adapter manager lock poisoned"))?;
        if processes.len() >= MAX_DEBUG_ADAPTER_PROCESSES {
            let _ = process.child.kill();
            let _ = process.child.wait();
            anyhow::bail!("debug adapter process limit reached; stop a debug session first");
        }
        processes.insert(session_id, Arc::new(Mutex::new(process)));
        Ok(result)
    }

    fn send(&self, request: DebugSendRequest) -> anyhow::Result<serde_json::Value> {
        let process = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("debug adapter manager lock poisoned"))?
            .get(&request.session_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("debug session is not running"))?;
        let mut process = process
            .lock()
            .map_err(|_| anyhow::anyhow!("debug adapter process lock poisoned"))?;
        if let Some(status) = process.child.try_wait()? {
            anyhow::bail!("debug adapter exited with {status}");
        }
        let command = request
            .request
            .get("command")
            .and_then(|value| value.as_str())
            .ok_or_else(|| anyhow::anyhow!("debug request command is required"))?;
        if command == "$/gyro/poll" {
            let events = drain_dap_messages(&mut process)?;
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
        let (response, events) =
            receive_dap_response(&mut process, sequence, Duration::from_secs(20))?;
        Ok(redact_json_strings(serde_json::json!({
            "sessionId": request.session_id,
            "status": if response.get("success").and_then(|value| value.as_bool()) == Some(false) { "error" } else { "ok" },
            "response": response,
            "events": events,
        })))
    }

    fn stop(&self, session_id: &str) -> anyhow::Result<serde_json::Value> {
        let process = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("debug adapter manager lock poisoned"))?
            .remove(session_id);
        let Some(process) = process else {
            return Ok(serde_json::json!({ "sessionId": session_id, "status": "stopped" }));
        };
        let mut process = process
            .lock()
            .map_err(|_| anyhow::anyhow!("debug adapter process lock poisoned"))?;
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

fn debug_adapter_command_is_allowed(adapter: &str, command: &str, args: &[String]) -> bool {
    if command.is_empty()
        || command.contains('/')
        || command.contains('\\')
        || args.len() > 32
        || args
            .iter()
            .any(|arg| arg.len() > 4_096 || arg.as_bytes().contains(&0))
    {
        return false;
    }
    #[cfg(test)]
    if adapter == "fake" && command == "python3" {
        return true;
    }
    let allowed = [
        "lldb-dap",
        "codelldb",
        "debugpy-adapter",
        "dlv",
        "js-debug-adapter",
        "vscode-js-debug",
        "netcoredbg",
        "OpenDebugAD7",
    ];
    adapter == command && allowed.contains(&command)
}

fn receive_dap_response(
    process: &mut DebugAdapterProcess,
    request_sequence: u64,
    timeout: Duration,
) -> anyhow::Result<(serde_json::Value, Vec<serde_json::Value>)> {
    let deadline = Instant::now() + timeout;
    let mut events = Vec::new();
    let mut event_bytes = 0usize;
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
        if events.len() >= MAX_IDE_PROTOCOL_MESSAGES_PER_RESPONSE {
            anyhow::bail!("debug adapter produced too many events before its response");
        }
        add_ide_protocol_message_bytes(&mut event_bytes, &message)?;
        events.push(message);
    }
}

fn drain_dap_messages(process: &mut DebugAdapterProcess) -> anyhow::Result<Vec<serde_json::Value>> {
    let mut messages = Vec::new();
    let mut message_bytes = 0usize;
    for _ in 0..MAX_IDE_PROTOCOL_MESSAGES_PER_RESPONSE {
        let message = match process.messages.try_recv() {
            Ok(message) => message.map_err(anyhow::Error::msg)?,
            Err(mpsc::TryRecvError::Empty) => break,
            Err(mpsc::TryRecvError::Disconnected) => {
                anyhow::bail!("debug adapter output disconnected")
            }
        };
        handle_dap_adapter_request(process, &message)?;
        add_ide_protocol_message_bytes(&mut message_bytes, &message)?;
        messages.push(message);
    }
    Ok(messages)
}

fn add_ide_protocol_message_bytes(
    total: &mut usize,
    message: &serde_json::Value,
) -> anyhow::Result<()> {
    *total = total.saturating_add(serde_json::to_vec(message)?.len());
    if *total > MAX_IDE_PROTOCOL_RESPONSE_BYTES {
        anyhow::bail!("IDE protocol response exceeded its aggregate size limit");
    }
    Ok(())
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
    let (mut bytes, size_bytes) =
        read_bounded_regular_file(&candidate, max_bytes, "workspace file")?;
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
        size_bytes,
        content_hash,
    })
}

fn read_bounded_regular_file(
    path: &Path,
    max_bytes: usize,
    label: &str,
) -> anyhow::Result<(Vec<u8>, u64)> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("open {label} {}", path.display()))?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        anyhow::bail!("{label} is not a regular file");
    }
    let mut bytes = Vec::with_capacity(max_bytes.min(metadata.len() as usize));
    Read::by_ref(&mut file)
        .take(max_bytes.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .with_context(|| format!("read {label} {}", path.display()))?;
    Ok((bytes, metadata.len()))
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
    let content_hash = if metadata.is_file()
        && metadata.len() <= MAX_WORKSPACE_FILE_EDIT_BYTES as u64
    {
        let (bytes, _) =
            read_bounded_regular_file(&candidate, MAX_WORKSPACE_FILE_EDIT_BYTES, "workspace file")?;
        if bytes.len() > MAX_WORKSPACE_FILE_EDIT_BYTES || bytes.contains(&0) {
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
    let candidate = validated_workspace_file_target(&root, &request.path)?;
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
        let (current, _) =
            read_bounded_regular_file(&candidate, MAX_WORKSPACE_FILE_EDIT_BYTES, "workspace file")?;
        if current.len() > MAX_WORKSPACE_FILE_EDIT_BYTES {
            anyhow::bail!("workspace file is too large to edit in Gyro");
        }
        if current.contains(&0) {
            anyhow::bail!("binary workspace files cannot be edited");
        }
        let current_hash = content_hash(&current);
        if current_hash != expected_hash {
            anyhow::bail!("file changed on disk; reload before saving");
        }
    }

    atomic_write_workspace_file(&candidate, content_bytes)?;
    read_workspace_file_with_limit(
        &request.workspace_path,
        &request.path,
        MAX_WORKSPACE_FILE_EDIT_BYTES,
    )
}

fn create_file_mutation_proposal_impl(
    request: FileMutationProposalRequest,
) -> anyhow::Result<MutationProposal> {
    let store = SessionStore::open(GyroPaths::for_current_user()?)?;
    let session_id = Uuid::parse_str(&request.session_id)?;
    let turn_id = request
        .turn_id
        .as_deref()
        .map(Uuid::parse_str)
        .transpose()?;
    let session = store
        .get_session(session_id)?
        .ok_or_else(|| anyhow::anyhow!("unknown session {session_id}"))?;
    let root = session.workspace_path.canonicalize()?;
    let candidate = validated_workspace_file_target(&root, &request.path)?;
    if candidate.is_dir() {
        anyhow::bail!("mutation proposal path is a directory");
    }
    let content_bytes = request.content.as_bytes();
    if content_bytes.len() > MAX_WORKSPACE_FILE_EDIT_BYTES {
        anyhow::bail!("mutation proposal is too large");
    }
    if content_bytes.contains(&0) {
        anyhow::bail!("binary mutation proposals are not supported");
    }
    let base_exists = candidate.exists();
    let expected_hash = if base_exists {
        let (current, _) =
            read_bounded_regular_file(&candidate, MAX_WORKSPACE_FILE_EDIT_BYTES, "workspace file")?;
        if current.len() > MAX_WORKSPACE_FILE_EDIT_BYTES {
            anyhow::bail!("workspace file is too large to edit in Gyro");
        }
        if current.contains(&0) {
            anyhow::bail!("binary workspace files cannot be edited");
        }
        let current_hash = content_hash(&current);
        if let Some(expected) = request.expected_hash.as_deref() {
            if current_hash != expected {
                anyhow::bail!("file changed on disk; reload before proposing an edit");
            }
        }
        Some(current_hash)
    } else {
        if request.expected_hash.is_some() {
            anyhow::bail!("cannot use an expected hash for a file that does not exist");
        }
        None
    };
    let proposal = store.create_mutation_proposal(
        session_id,
        turn_id,
        &request.path,
        request.content,
        expected_hash,
        base_exists,
    )?;
    let payload = mutation_approval_payload(&proposal, None);
    store.append_event_with_turn_id(
        session_id,
        SessionEventKind::FileEditProposed,
        format!("Proposed {}", proposal.path),
        payload.clone(),
        turn_id,
    )?;
    store.append_event_with_turn_id(
        session_id,
        SessionEventKind::ApprovalRequested,
        format!("Review changes to {}", proposal.path),
        payload,
        turn_id,
    )?;
    Ok(proposal)
}

fn resolve_file_mutation_proposal_impl(
    request: FileMutationDecisionRequest,
) -> anyhow::Result<FileMutationDecisionResult> {
    let store = SessionStore::open(GyroPaths::for_current_user()?)?;
    let proposal_id = Uuid::parse_str(&request.proposal_id)?;
    let decision = match request.decision.as_str() {
        "approve" => MutationDecision::Approve,
        "reject" => MutationDecision::Reject,
        _ => anyhow::bail!("mutation decision must be approve or reject"),
    };
    let result = decide_mutation_proposal(&store, proposal_id, decision)?;
    let file = result
        .changed_path
        .as_ref()
        .map(|_| {
            read_workspace_file_with_limit(
                &result.proposal.workspace_path.to_string_lossy(),
                &result.proposal.path,
                MAX_WORKSPACE_FILE_EDIT_BYTES,
            )
        })
        .transpose()?;
    Ok(FileMutationDecisionResult {
        proposal: result.proposal,
        event: result.event,
        file,
    })
}

fn validated_workspace_file_target(root: &Path, path: &str) -> anyhow::Result<PathBuf> {
    let candidate = gyro_core::security::assert_path_inside_workspace(root, Path::new(path))?;
    let parent = candidate
        .parent()
        .ok_or_else(|| anyhow::anyhow!("workspace file path has no parent"))?;
    let resolved_parent = parent
        .canonicalize()
        .map_err(|_| anyhow::anyhow!("workspace file parent does not exist"))?;
    if !resolved_parent.starts_with(root) {
        anyhow::bail!("workspace file parent resolves outside the workspace");
    }
    Ok(resolved_parent.join(
        candidate
            .file_name()
            .ok_or_else(|| anyhow::anyhow!("workspace file path has no file name"))?,
    ))
}

fn atomic_write_workspace_file(path: &Path, content: &[u8]) -> anyhow::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("workspace file path has no parent"))?;
    let temporary = parent.join(format!(
        ".gyro-{}-{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("mutation"),
        Uuid::new_v4()
    ));
    let result = (|| -> anyhow::Result<()> {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        if let Ok(metadata) = fs::metadata(path) {
            file.set_permissions(metadata.permissions())?;
        }
        file.write_all(content)?;
        file.flush()?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        fs::File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
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
            let (bytes, _) = read_bounded_regular_file(
                &candidate,
                MAX_WORKSPACE_FILE_EDIT_BYTES,
                "workspace file",
            )?;
            if bytes.len() > MAX_WORKSPACE_FILE_EDIT_BYTES {
                anyhow::bail!("workspace file is too large for hash-approved deletion");
            }
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

    match run_bounded_command(
        &command,
        Duration::from_secs(30),
        Some(Duration::from_secs(10)),
        8 * 1024 * 1024,
        64 * 1024,
    ) {
        Ok(output) if output.succeeded() || output.exit_code() == Some(1) => {
            Ok(parse_rg_output(&output.stdout, query, max_results))
        }
        Ok(output) => Err(bounded_command_error("workspace search failed", &output)),
        Err(_) => fallback_search_workspace(&root, query, max_results),
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
    let started_at = Instant::now();
    let mut scanned_files = 0usize;
    let mut scanned_bytes = 0u64;
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
        if started_at.elapsed() >= WORKSPACE_SEARCH_FALLBACK_TIMEOUT
            || scanned_files >= MAX_WORKSPACE_SEARCH_FALLBACK_FILES
            || scanned_bytes >= MAX_WORKSPACE_SEARCH_FALLBACK_BYTES
        {
            break;
        }
        let entry = entry?;
        if !entry.file_type().is_file() {
            continue;
        }
        let metadata = entry.metadata()?;
        if metadata.len() > MAX_WORKSPACE_FILE_PREVIEW_BYTES as u64 {
            continue;
        }
        if scanned_bytes.saturating_add(metadata.len()) > MAX_WORKSPACE_SEARCH_FALLBACK_BYTES {
            break;
        }
        scanned_files += 1;
        scanned_bytes = scanned_bytes.saturating_add(metadata.len());
        let (bytes, _) = read_bounded_regular_file(
            entry.path(),
            MAX_WORKSPACE_FILE_PREVIEW_BYTES,
            "workspace search file",
        )?;
        if bytes.len() > MAX_WORKSPACE_FILE_PREVIEW_BYTES {
            continue;
        }
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
    let output = match run_bounded_command(
        &command,
        Duration::from_secs(15),
        Some(Duration::from_secs(10)),
        4 * 1024 * 1024,
        64 * 1024,
    ) {
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
    if !output.succeeded() || output.stdout_truncated {
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
            error: Some(bounded_command_error("could not inspect Git status", &output).to_string()),
        });
    }
    let mut status = parse_git_status_v2(&output.stdout);
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
            (0..5).for_each(|_| {
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
    let output = run_bounded_command(
        &command,
        Duration::from_secs(10),
        None,
        64 * 1024,
        64 * 1024,
    )
    .ok()?;
    if !output.succeeded() || output.stdout_truncated {
        return None;
    }
    let path = output.stdout.trim().to_string();
    (!path.is_empty()).then(|| PathBuf::from(path))
}

fn apply_git_diff_stats(repo_root: &Path, status: &mut SourceControlStatus) {
    let (tracked, tracked_partial) = git_numstat(repo_root);
    status.stats_partial = tracked_partial;

    for (additions, deletions) in tracked.values() {
        status.additions = status.additions.saturating_add(*additions);
        status.deletions = status.deletions.saturating_add(*deletions);
    }

    let untracked_started_at = Instant::now();
    let mut untracked_files = 0usize;
    let mut untracked_bytes = 0usize;
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
            if untracked_files >= MAX_GIT_UNTRACKED_STAT_FILES
                || untracked_bytes >= MAX_GIT_UNTRACKED_STAT_BYTES
                || untracked_started_at.elapsed() >= GIT_UNTRACKED_STAT_TIMEOUT
            {
                status.stats_partial = true;
                continue;
            }
            let (additions, partial, bytes_read) = untracked_text_additions(
                repo_root,
                &file.path,
                MAX_GIT_UNTRACKED_STAT_BYTES - untracked_bytes,
            );
            untracked_files += 1;
            untracked_bytes = untracked_bytes.saturating_add(bytes_read);
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
    let output = match run_bounded_command(
        &command,
        Duration::from_secs(15),
        Some(Duration::from_secs(10)),
        4 * 1024 * 1024,
        64 * 1024,
    ) {
        Ok(output) if output.succeeded() => output,
        _ => return git_numstat_without_head(repo_root),
    };
    let (stats, partial) = parse_git_numstat(&output.stdout);
    (stats, partial || output.stdout_truncated)
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
        let Ok(output) = run_bounded_command(
            &command,
            Duration::from_secs(15),
            Some(Duration::from_secs(10)),
            4 * 1024 * 1024,
            64 * 1024,
        ) else {
            partial = true;
            continue;
        };
        if !output.succeeded() {
            partial = true;
            continue;
        }
        let (stats, output_partial) = parse_git_numstat(&output.stdout);
        partial |= output_partial || output.stdout_truncated;
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

fn untracked_text_additions(
    repo_root: &Path,
    relative_path: &str,
    remaining_bytes: usize,
) -> (usize, bool, usize) {
    let path = repo_root.join(relative_path);
    let Ok(metadata) = fs::metadata(&path) else {
        return (0, true, 0);
    };
    let max_bytes = MAX_WORKSPACE_FILE_EDIT_BYTES.min(remaining_bytes);
    if !metadata.is_file() || metadata.len() > max_bytes as u64 {
        return (0, metadata.is_file(), 0);
    }
    let Ok((bytes, _)) = read_bounded_regular_file(&path, max_bytes, "untracked workspace file")
    else {
        return (0, true, 0);
    };
    if bytes.len() > max_bytes {
        return (0, true, 0);
    }
    if bytes.contains(&0) {
        return (0, false, bytes.len());
    }
    let lines = bytes.iter().filter(|byte| **byte == b'\n').count()
        + usize::from(!bytes.is_empty() && bytes.last() != Some(&b'\n'));
    (lines, false, bytes.len())
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
        let (package, _) =
            read_bounded_regular_file(&package_json, 1024 * 1024, "package manifest")?;
        if package.len() > 1024 * 1024 {
            anyhow::bail!("package manifest exceeds the 1 MiB size limit");
        }
        let package = String::from_utf8(package).context("package manifest is not UTF-8")?;
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

fn run_command_output(command: Command) -> anyhow::Result<IdeCommandOutput> {
    let output = run_bounded_command(
        &command,
        Duration::from_secs(30 * 60),
        Some(Duration::from_secs(5 * 60)),
        2 * 1024 * 1024,
        1024 * 1024,
    )?;
    let mut stdout = gyro_core::security::redact_secrets(&output.stdout);
    let mut stderr = gyro_core::security::redact_secrets(&output.stderr);
    if output.stdout_truncated {
        stdout.push_str("\n[stdout truncated by Gyro]");
    }
    if output.stderr_truncated {
        stderr.push_str("\n[stderr truncated by Gyro]");
    }
    Ok(IdeCommandOutput {
        status: match output.termination {
            ExecutionTermination::Exited { code: Some(0) } => "done",
            ExecutionTermination::Cancelled => "cancelled",
            ExecutionTermination::TimedOut => "timed-out",
            ExecutionTermination::Inactive => "inactive",
            ExecutionTermination::OutputLimit => "output-limit",
            ExecutionTermination::Exited { .. } => "failed",
        }
        .into(),
        stdout,
        stderr,
    })
}

fn run_bounded_command(
    command: &Command,
    timeout: Duration,
    inactivity_timeout: Option<Duration>,
    max_stdout_chars: usize,
    max_stderr_chars: usize,
) -> anyhow::Result<gyro_core::ExecutionOutcome> {
    let mut request = ExecutionRequest::new(command.get_program().to_os_string());
    request.args = command
        .get_args()
        .map(std::ffi::OsStr::to_os_string)
        .collect();
    request.current_dir = command.get_current_dir().map(Path::to_path_buf);
    request.env = command
        .get_envs()
        .map(|(key, value)| (key.to_os_string(), value.map(std::ffi::OsStr::to_os_string)))
        .collect();
    request.timeout = timeout;
    request.inactivity_timeout = inactivity_timeout;
    request.max_stdout_chars = max_stdout_chars;
    request.max_stderr_chars = max_stderr_chars;
    gyro_core::run_command(request, CancellationToken::default(), |_| {})
}

fn bounded_command_error(label: &str, output: &gyro_core::ExecutionOutcome) -> anyhow::Error {
    let reason = match &output.termination {
        ExecutionTermination::Exited { code } => format!("exited with {code:?}"),
        ExecutionTermination::Cancelled => "was cancelled".into(),
        ExecutionTermination::TimedOut => "timed out".into(),
        ExecutionTermination::Inactive => "stopped after no output".into(),
        ExecutionTermination::OutputLimit => "exceeded its output limit".into(),
    };
    let detail = output.stderr.trim();
    if detail.is_empty() {
        anyhow::anyhow!("{label} {reason}")
    } else {
        anyhow::anyhow!("{label} {reason}: {}", truncate_error_detail(detail))
    }
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
async fn terminal_pane_has_foreground_job(
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
async fn close_terminal_pane(
    manager: tauri::State<'_, TerminalProcessManager>,
    pane_id: String,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.close(&pane_id).map_err(to_string))
        .await
        .map_err(|error| format!("terminal close worker failed: {error}"))?
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

#[tauri::command]
async fn check_browser_preview(
    app: tauri::AppHandle,
    request: BrowserPreviewCheckRequest,
) -> Result<BrowserPreviewCheck, String> {
    let capture_request = request.clone();
    let mut check =
        tauri::async_runtime::spawn_blocking(move || check_browser_preview_blocking(request))
            .await
            .map_err(|error| format!("browser preview worker failed: {error}"))??;
    if check.reachable && check.diagnostics_supported {
        match capture_browser_preview_diagnostics(&app, &capture_request.url).await {
            Ok(diagnostics) => {
                check.diagnostics = diagnostics;
                check.diagnostics_captured = true;
            }
            Err(error) => {
                check.message = format!("{} · diagnostics unavailable", check.message);
                eprintln!(
                    "browser preview diagnostics unavailable: {}",
                    gyro_core::security::redact_secrets(&error)
                );
            }
        }
    }
    Ok(check)
}

fn check_browser_preview_blocking(
    request: BrowserPreviewCheckRequest,
) -> Result<BrowserPreviewCheck, String> {
    let url = url::Url::parse(request.url.trim()).map_err(|_| "invalid preview URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("preview URLs must use http or https".into());
    }
    if url.host_str().is_none() {
        return Err("preview URL must include a host".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("preview URLs cannot include credentials".into());
    }
    if !browser_preview_diagnostics_supported(&url) {
        return Err("preview URLs must use localhost or a loopback IP address".into());
    }
    let diagnostics_supported = true;
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(2))
        .timeout_read(Duration::from_secs(2))
        .timeout_write(Duration::from_secs(2))
        .redirects(0)
        .build();
    match agent.get(url.as_str()).call() {
        Ok(response) => Ok(BrowserPreviewCheck {
            reachable: true,
            status_code: Some(response.status()),
            message: format!("Local preview reachable (HTTP {})", response.status()),
            diagnostics: Vec::new(),
            diagnostics_supported,
            diagnostics_captured: false,
        }),
        Err(ureq::Error::Status(status, _)) => Ok(BrowserPreviewCheck {
            reachable: true,
            status_code: Some(status),
            message: format!("Preview server reachable (HTTP {status})"),
            diagnostics: Vec::new(),
            diagnostics_supported,
            diagnostics_captured: false,
        }),
        Err(ureq::Error::Transport(_)) => Ok(BrowserPreviewCheck {
            reachable: false,
            status_code: None,
            message: "Preview unavailable: connection refused, timed out, or offline".into(),
            diagnostics: Vec::new(),
            diagnostics_supported,
            diagnostics_captured: false,
        }),
    }
}

fn browser_preview_diagnostics_supported(url: &url::Url) -> bool {
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    match url.host() {
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

fn browser_preview_capture_script(prefix: &str) -> Result<String, String> {
    let prefix = serde_json::to_string(prefix).map_err(to_string)?;
    Ok(format!(
        r#"(() => {{
  const prefix = {prefix};
  const diagnostics = [];
  const text = (value) => {{
    try {{
      if (value instanceof Error) return value.message || value.name;
      if (typeof value === "string") return value;
      const encoded = JSON.stringify(value);
      return encoded === undefined ? String(value) : encoded;
    }} catch (_) {{
      return String(value);
    }}
  }};
  const record = (kind, values, source, line, column) => {{
    if (diagnostics.length >= {MAX_BROWSER_PREVIEW_DIAGNOSTICS}) return;
    const message = values.map(text).join(" ").slice(0, {MAX_BROWSER_PREVIEW_DIAGNOSTIC_CHARS});
    if (!message) return;
    diagnostics.push({{
      kind,
      message,
      source: typeof source === "string" ? source : null,
      line: Number.isFinite(line) ? line : null,
      column: Number.isFinite(column) ? column : null,
    }});
  }};
  const originalError = console.error.bind(console);
  console.error = (...values) => {{
    record("console-error", values, null, null, null);
    originalError(...values);
  }};
  addEventListener("error", (event) => {{
    record("page-error", [event.message || "Page error"], event.filename, event.lineno, event.colno);
  }}, true);
  addEventListener("unhandledrejection", (event) => {{
    record("unhandled-rejection", [event.reason || "Unhandled promise rejection"], null, null, null);
  }}, true);
  let reported = false;
  const report = () => {{
    if (reported) return;
    reported = true;
    document.title = prefix + JSON.stringify(diagnostics);
  }};
  addEventListener("load", () => setTimeout(report, 750), {{ once: true }});
  setTimeout(report, 3000);
}})();"#
    ))
}

fn sanitize_browser_preview_source(source: Option<String>) -> Option<String> {
    let source = source?.trim().to_string();
    if source.is_empty() {
        return None;
    }
    let sanitized = match url::Url::parse(&source) {
        Ok(url) => url.path().to_string(),
        Err(_) => source,
    };
    Some(truncate_chars(
        &gyro_core::security::redact_secrets(&sanitized),
        MAX_BROWSER_PREVIEW_DIAGNOSTIC_CHARS,
    ))
}

fn parse_browser_preview_diagnostics(
    prefix: &str,
    title: &str,
) -> Option<Vec<BrowserPreviewDiagnostic>> {
    let payload = title.strip_prefix(prefix)?;
    if payload.chars().count() > MAX_BROWSER_PREVIEW_DIAGNOSTIC_PAYLOAD_CHARS {
        return None;
    }
    let diagnostics = serde_json::from_str::<Vec<BrowserPreviewDiagnostic>>(payload).ok()?;
    Some(
        diagnostics
            .into_iter()
            .take(MAX_BROWSER_PREVIEW_DIAGNOSTICS)
            .filter_map(|diagnostic| {
                let message = truncate_chars(
                    &gyro_core::security::redact_secrets(diagnostic.message.trim()),
                    MAX_BROWSER_PREVIEW_DIAGNOSTIC_CHARS,
                );
                if message.is_empty() {
                    return None;
                }
                let kind = match diagnostic.kind.as_str() {
                    "console-error" | "page-error" | "unhandled-rejection" => diagnostic.kind,
                    _ => "page-error".into(),
                };
                Some(BrowserPreviewDiagnostic {
                    kind,
                    message,
                    source: sanitize_browser_preview_source(diagnostic.source),
                    line: diagnostic.line,
                    column: diagnostic.column,
                })
            })
            .collect(),
    )
}

async fn capture_browser_preview_diagnostics(
    app: &tauri::AppHandle,
    raw_url: &str,
) -> Result<Vec<BrowserPreviewDiagnostic>, String> {
    let _admission = BrowserPreviewAdmission::acquire()?;
    let url = url::Url::parse(raw_url.trim()).map_err(|_| "invalid preview URL".to_string())?;
    if !browser_preview_diagnostics_supported(&url) {
        return Err("diagnostics are limited to loopback previews".into());
    }
    let token = Uuid::new_v4();
    let prefix = format!("gyro-browser-diagnostics:{token}:");
    let script = browser_preview_capture_script(&prefix)?;
    let (sender, receiver) = mpsc::channel();
    let callback_prefix = prefix.clone();
    let label = format!("browser-diagnostics-{token}");
    let window = tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::External(url))
        .title("Gyro browser diagnostics")
        .inner_size(1.0, 1.0)
        .visible(false)
        .skip_taskbar(true)
        .incognito(true)
        .devtools(false)
        .on_navigation(browser_preview_diagnostics_supported)
        .initialization_script(script)
        .on_document_title_changed(move |_window, title| {
            if title.starts_with(&callback_prefix) {
                let _ = sender.send(title);
            }
        })
        .build()
        .map_err(|error| format!("could not create diagnostic webview: {error}"))?;
    let window = HiddenWebviewGuard(window);
    let received = tauri::async_runtime::spawn_blocking(move || {
        receiver.recv_timeout(BROWSER_PREVIEW_DIAGNOSTIC_TIMEOUT)
    })
    .await
    .map_err(|error| format!("browser diagnostic worker failed: {error}"))?;
    let _ = window.close();
    let title = received.map_err(|_| "browser diagnostic capture timed out".to_string())?;
    parse_browser_preview_diagnostics(&prefix, &title)
        .ok_or_else(|| "browser diagnostic payload was invalid".to_string())
}

#[tauri::command]
async fn capture_browser_preview(
    app: tauri::AppHandle,
    request: BrowserPreviewCaptureRequest,
) -> Result<BrowserPreviewCapture, String> {
    let _admission = BrowserPreviewAdmission::acquire()?;
    let url = url::Url::parse(request.url.trim()).map_err(|_| "invalid preview URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("preview URL must use http or https and include a host".into());
    }
    if !browser_preview_diagnostics_supported(&url) {
        return Err("screenshots are limited to local loopback previews".into());
    }
    let (width, height) = browser_preview_capture_dimensions(&request.device)?;

    #[cfg(target_os = "macos")]
    {
        let token = Uuid::new_v4();
        let label = format!("browser-capture-{token}");
        let (load_sender, load_receiver) = mpsc::channel();
        let window =
            tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::External(url))
                .title("Gyro browser capture")
                .inner_size(width as f64, height as f64)
                .visible(false)
                .focused(false)
                .skip_taskbar(true)
                .incognito(true)
                .devtools(false)
                .on_navigation(browser_preview_diagnostics_supported)
                .on_page_load(move |_window, payload| {
                    if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                        let _ = load_sender.send(());
                    }
                })
                .build()
                .map_err(|error| format!("could not create browser capture webview: {error}"))?;
        let window = HiddenWebviewGuard(window);

        let loaded = tauri::async_runtime::spawn_blocking(move || {
            load_receiver.recv_timeout(BROWSER_PREVIEW_CAPTURE_TIMEOUT)
        })
        .await
        .map_err(|error| format!("browser capture load worker failed: {error}"))?;
        if loaded.is_err() {
            let _ = window.close();
            return Err("browser preview did not finish loading before capture".into());
        }

        tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(300)))
            .await
            .map_err(|error| format!("browser capture settle worker failed: {error}"))?;
        let snapshot = capture_macos_browser_preview_snapshot(&window).await;
        let _ = window.close();
        let snapshot = snapshot?;
        let paths = GyroPaths::for_current_user().map_err(to_string)?;
        let created_at = chrono::Utc::now();
        tauri::async_runtime::spawn_blocking(move || {
            persist_browser_preview_capture(
                &paths,
                &snapshot.png,
                snapshot.width,
                snapshot.height,
                created_at,
            )
        })
        .await
        .map_err(|error| format!("browser capture writer failed: {error}"))?
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, width, height);
        Err("browser screenshots are currently available on macOS only".into())
    }
}

fn browser_preview_capture_dimensions(device: &str) -> Result<(u32, u32), String> {
    match device {
        "desktop" => Ok((1440, 900)),
        "tablet" => Ok((834, 1112)),
        "mobile" => Ok((390, 844)),
        _ => Err("unknown browser preview device".into()),
    }
}

#[cfg(target_os = "macos")]
async fn capture_macos_browser_preview_snapshot(
    window: &tauri::WebviewWindow,
) -> Result<BrowserPreviewSnapshot, String> {
    let (sender, receiver) = mpsc::channel();
    window
        .with_webview(move |webview| unsafe {
            use block2::RcBlock;
            use objc2::runtime::AnyObject;
            use objc2_app_kit::{
                NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSImage,
            };
            use objc2_foundation::{NSDictionary, NSError};
            use objc2_web_kit::WKWebView;

            let view: &WKWebView = &*webview.inner().cast();
            let completion = RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
                let snapshot = (|| {
                    let image = image
                        .as_ref()
                        .ok_or_else(|| "native browser snapshot returned no image".to_string())?;
                    let tiff = image.TIFFRepresentation().ok_or_else(|| {
                        "native browser snapshot could not be encoded".to_string()
                    })?;
                    let bitmap = NSBitmapImageRep::imageRepWithData(&tiff).ok_or_else(|| {
                        "native browser snapshot could not create a bitmap".to_string()
                    })?;
                    let properties = NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::new();
                    let png = bitmap
                        .representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)
                        .ok_or_else(|| {
                            "native browser snapshot could not create PNG data".to_string()
                        })?;
                    if png.len() > MAX_BROWSER_PREVIEW_CAPTURE_BYTES {
                        return Err("browser screenshot exceeded the capture size limit".into());
                    }
                    Ok(BrowserPreviewSnapshot {
                        png: png.to_vec(),
                        width: bitmap.pixelsWide().max(0) as u32,
                        height: bitmap.pixelsHigh().max(0) as u32,
                    })
                })();
                let _ = sender.send(snapshot);
            });
            view.takeSnapshotWithConfiguration_completionHandler(None, &completion);
        })
        .map_err(|error| format!("could not request native browser snapshot: {error}"))?;

    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(BROWSER_PREVIEW_CAPTURE_TIMEOUT)
            .map_err(|_| "native browser screenshot timed out".to_string())?
    })
    .await
    .map_err(|error| format!("browser screenshot worker failed: {error}"))?
}

fn persist_browser_preview_capture(
    paths: &GyroPaths,
    png: &[u8],
    width: u32,
    height: u32,
    created_at: chrono::DateTime<chrono::Utc>,
) -> Result<BrowserPreviewCapture, String> {
    const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if !png.starts_with(PNG_SIGNATURE) {
        return Err("browser screenshot did not contain valid PNG data".into());
    }
    if png.len() > MAX_BROWSER_PREVIEW_CAPTURE_BYTES {
        return Err("browser screenshot exceeded the capture size limit".into());
    }
    ensure_private_browser_capture_directory(&paths.browser_captures_dir)?;
    let timestamp = created_at.format("%Y%m%dT%H%M%S%3fZ");
    let filename = format!("browser-preview-{timestamp}-{}.png", Uuid::new_v4());
    let path = paths.browser_captures_dir.join(&filename);
    let temporary_path = paths
        .browser_captures_dir
        .join(format!(".gyro-browser-capture-{}.tmp", Uuid::new_v4()));

    let write_result = (|| -> Result<(), String> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary_path).map_err(to_string)?;
        file.write_all(png).map_err(to_string)?;
        file.sync_all().map_err(to_string)?;
        fs::rename(&temporary_path, &path).map_err(to_string)?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary_path);
        return Err(format!("could not save browser screenshot: {error}"));
    }
    if let Err(error) = prune_browser_preview_captures(&paths.browser_captures_dir) {
        let _ = fs::remove_file(&path);
        return Err(error);
    }

    Ok(BrowserPreviewCapture {
        path: path.to_string_lossy().into_owned(),
        filename,
        width,
        height,
        created_at: created_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    })
}

fn ensure_private_browser_capture_directory(directory: &Path) -> Result<(), String> {
    if let Ok(metadata) = fs::symlink_metadata(directory) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("browser capture storage path is unsafe".into());
        }
    } else {
        fs::create_dir_all(directory).map_err(to_string)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).map_err(to_string)?;
    }
    Ok(())
}

fn prune_browser_preview_captures(directory: &Path) -> Result<(), String> {
    let mut captures = fs::read_dir(directory)
        .map_err(to_string)?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let filename = entry.file_name().to_string_lossy().into_owned();
            let file_type = entry.file_type().ok()?;
            (file_type.is_file()
                && filename.starts_with("browser-preview-")
                && filename.ends_with(".png"))
            .then_some((filename, entry.path()))
        })
        .collect::<Vec<_>>();
    captures.sort_by(|left, right| right.0.cmp(&left.0));
    for (_, path) in captures.into_iter().skip(MAX_BROWSER_PREVIEW_CAPTURES) {
        fs::remove_file(path).map_err(to_string)?;
    }
    Ok(())
}

fn check_provider_health_blocking(
    request: ProviderHealthRequest,
) -> Result<ProviderHealthCheck, String> {
    ProviderHealthService.check(request).map_err(to_string)
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
async fn get_provider_usage(provider_id: String) -> Result<ProviderUsageSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || get_provider_usage_blocking(&provider_id))
        .await
        .map_err(|error| format!("provider usage worker failed: {error}"))?
}

fn get_provider_usage_blocking(provider_id: &str) -> Result<ProviderUsageSnapshot, String> {
    if provider_id != "openai" {
        return Err("this provider does not expose a supported quota source".into());
    }

    let mut process = command_with_gui_path("codex");
    process
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = process
        .spawn()
        .map_err(|error| format!("could not start the Codex usage service: {error}"))?;
    let result = (|| {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Codex usage service input is unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Codex usage service output is unavailable".to_string())?;
        let messages = spawn_codex_app_server_reader(stdout);
        let deadline = Instant::now() + CODEX_USAGE_TIMEOUT;

        write_codex_app_server_message(
            &mut stdin,
            &serde_json::json!({
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": {
                        "name": "gyro",
                        "title": "Gyro",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                    "capabilities": { "experimentalApi": true },
                },
            }),
        )?;
        let initialize = receive_codex_app_server_response(&messages, 1, deadline)?;
        codex_app_server_result(&initialize)?;

        write_codex_app_server_message(
            &mut stdin,
            &serde_json::json!({ "method": "initialized" }),
        )?;
        write_codex_app_server_message(
            &mut stdin,
            &serde_json::json!({
                "id": 2,
                "method": "account/rateLimits/read",
            }),
        )?;
        let response = receive_codex_app_server_response(&messages, 2, deadline)?;
        let payload = codex_app_server_result(&response)?;
        let response: CodexRateLimitsResponse = serde_json::from_value(payload)
            .map_err(|error| format!("Codex returned an unsupported usage response: {error}"))?;
        Ok(ProviderUsageSnapshot {
            provider_id: provider_id.into(),
            windows: provider_usage_windows_from_codex(&response.rate_limits),
            fetched_at: chrono::Utc::now().to_rfc3339(),
        })
    })();
    let _ = child.kill();
    let _ = child.wait();
    result
}

fn spawn_codex_app_server_reader(
    stdout: ChildStdout,
) -> mpsc::Receiver<Result<serde_json::Value, String>> {
    let (sender, receiver) = mpsc::sync_channel(CODEX_APP_SERVER_CHANNEL_CAPACITY);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_bounded_protocol_line(&mut reader, MAX_CODEX_APP_SERVER_MESSAGE_BYTES) {
                Ok(None) => {
                    let _ = sender.send(Err("Codex usage service closed unexpectedly".into()));
                    break;
                }
                Ok(Some(line)) => match serde_json::from_slice(&line) {
                    Ok(message) => {
                        if sender.send(Ok(message)).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = sender.send(Err(format!(
                            "Codex usage service returned invalid JSON: {error}"
                        )));
                        break;
                    }
                },
                Err(error) => {
                    let _ = sender.send(Err(format!(
                        "could not read the Codex usage response: {error}"
                    )));
                    break;
                }
            }
        }
    });
    receiver
}

fn read_bounded_protocol_line<R: BufRead>(
    reader: &mut R,
    max_bytes: usize,
) -> Result<Option<Vec<u8>>, String> {
    let mut line = Vec::with_capacity(max_bytes.min(8 * 1024));
    loop {
        let available = reader
            .fill_buf()
            .map_err(|error| format!("could not read protocol data: {error}"))?;
        if available.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Err("protocol response ended before its newline terminator".into())
            };
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |index| index + 1);
        let payload_len = newline.unwrap_or(consumed);
        if line.len().saturating_add(payload_len) > max_bytes {
            return Err(format!(
                "protocol response exceeded the {max_bytes} byte size limit"
            ));
        }
        line.extend_from_slice(&available[..payload_len]);
        reader.consume(consumed);
        if newline.is_some() {
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(Some(line));
        }
    }
}

fn write_codex_app_server_message(
    stdin: &mut ChildStdin,
    message: &serde_json::Value,
) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(message).map_err(to_string)?;
    bytes.push(b'\n');
    stdin
        .write_all(&bytes)
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("could not write to the Codex usage service: {error}"))
}

fn receive_codex_app_server_response(
    messages: &mpsc::Receiver<Result<serde_json::Value, String>>,
    request_id: u64,
    deadline: Instant,
) -> Result<serde_json::Value, String> {
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("Codex usage request timed out".into());
        }
        let message = messages
            .recv_timeout(remaining)
            .map_err(|error| match error {
                mpsc::RecvTimeoutError::Timeout => "Codex usage request timed out".to_string(),
                mpsc::RecvTimeoutError::Disconnected => {
                    "Codex usage service disconnected".to_string()
                }
            })??;
        if message.get("id").and_then(serde_json::Value::as_u64) == Some(request_id) {
            return Ok(message);
        }
    }
}

fn codex_app_server_result(response: &serde_json::Value) -> Result<serde_json::Value, String> {
    if let Some(error) = response.get("error") {
        return Err(error
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Codex could not load account usage")
            .to_string());
    }
    response
        .get("result")
        .cloned()
        .ok_or_else(|| "Codex usage response did not include a result".into())
}

fn provider_usage_windows_from_codex(
    snapshot: &CodexRateLimitSnapshot,
) -> Vec<ProviderUsageWindow> {
    let mut windows = Vec::new();
    let mut seen = HashSet::new();
    for (window, fallback_id, fallback_label) in [
        (snapshot.primary.as_ref(), "five-hour", "5-hour window"),
        (snapshot.secondary.as_ref(), "weekly", "Weekly window"),
    ] {
        let Some(window) = window else {
            continue;
        };
        let (id, label) = match window.window_duration_mins {
            Some(300) => ("five-hour", "5-hour window"),
            Some(10_080) => ("weekly", "Weekly window"),
            _ => (fallback_id, fallback_label),
        };
        if !seen.insert(id) {
            continue;
        }
        windows.push(ProviderUsageWindow {
            id: id.into(),
            label: label.into(),
            used_percent: window.used_percent.clamp(0, 100),
            resets_at: window
                .resets_at
                .and_then(|timestamp| chrono::DateTime::from_timestamp(timestamp, 0))
                .map(|timestamp| timestamp.to_rfc3339()),
        });
    }
    windows.sort_by_key(|window| if window.id == "five-hour" { 0 } else { 1 });
    windows
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
    let service = ProviderHealthService;
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
    let output = Arc::new(Mutex::new(TerminalOutputBuffer::default()));
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
        terminated: false,
    })
}

fn terminate_terminal_process(process: &mut TerminalProcess) {
    if process.terminated {
        return;
    }
    #[cfg(unix)]
    let process_groups = {
        let shell_group = process.child.process_id().map(|pid| pid as i32);
        let foreground_group = process.master.process_group_leader();
        let mut groups = [foreground_group, shell_group]
            .into_iter()
            .flatten()
            .filter(|group| *group > 1)
            .collect::<Vec<_>>();
        groups.sort_unstable();
        groups.dedup();
        for group in &groups {
            // PTY jobs can outlive their shell. Signal both the current
            // foreground job and the shell process group before reaping.
            unsafe {
                libc::kill(-*group, libc::SIGHUP);
                libc::kill(-*group, libc::SIGTERM);
            }
        }
        groups
    };
    let _ = process.child.kill();
    #[cfg(unix)]
    {
        std::thread::sleep(Duration::from_millis(25));
        for group in process_groups {
            unsafe {
                if libc::kill(-group, 0) == 0 {
                    libc::kill(-group, libc::SIGKILL);
                }
            }
        }
    }
    if let Ok(status) = process.child.wait() {
        process.exit_code = Some(status.exit_code() as i32);
        process.terminated = true;
    }
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
    if request.working_directory.as_deref() == Some("Home") {
        return Ok(Some(user_home_directory()?));
    }
    let workspace = request
        .workspace_path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .map(|path| path.canonicalize())
        .transpose()?;
    let Some(mut workspace) = workspace else {
        return Ok(Some(user_home_directory()?));
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

fn user_home_directory() -> anyhow::Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("user home directory is unavailable"))?;
    Ok(home.canonicalize().unwrap_or(home))
}

fn terminal_local_workspace(workspace: &Path) -> anyhow::Result<PathBuf> {
    let mut top_level_command = command_with_gui_path("git");
    top_level_command
        .arg("-C")
        .arg(workspace)
        .args(["rev-parse", "--show-toplevel"]);
    let top_level_output = run_bounded_command(
        &top_level_command,
        Duration::from_secs(10),
        None,
        64 * 1024,
        64 * 1024,
    )?;
    if !top_level_output.succeeded() || top_level_output.stdout_truncated {
        return Ok(workspace.to_path_buf());
    }
    let git_top_level = PathBuf::from(top_level_output.stdout.trim()).canonicalize()?;

    let mut common_dir_command = command_with_gui_path("git");
    common_dir_command.arg("-C").arg(workspace).args([
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
    ]);
    let common_dir_output = run_bounded_command(
        &common_dir_command,
        Duration::from_secs(10),
        None,
        64 * 1024,
        64 * 1024,
    )?;
    if !common_dir_output.succeeded() || common_dir_output.stdout_truncated {
        return Ok(workspace.to_path_buf());
    }
    let git_common_dir = PathBuf::from(common_dir_output.stdout.trim());
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

fn run_provider_chat_with_retry(
    store: &SessionStore,
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    binding: Option<ProviderSessionBinding>,
) -> anyhow::Result<ProviderRunnerOutput> {
    run_provider_chat_with_retry_using(store, request, binding, |resume_cursor| {
        run_provider_chat_once(app, request, resume_cursor)
    })
}

fn run_provider_chat_with_retry_using<F>(
    store: &SessionStore,
    request: &ProviderChatRequest,
    binding: Option<ProviderSessionBinding>,
    mut run_once: F,
) -> anyhow::Result<ProviderRunnerOutput>
where
    F: FnMut(Option<&ProviderResumeCursor>) -> anyhow::Result<ProviderRunnerOutput>,
{
    let binding_cursor = binding
        .as_ref()
        .and_then(provider_resume_cursor_from_binding);
    match run_once(binding_cursor.as_ref()) {
        Ok(mut output) => {
            output.resumed = binding_cursor.is_some();
            Ok(output)
        }
        Err(error) if binding.is_some() && is_stale_resume_error(&error.to_string()) => {
            let session_id =
                parse_uuid(&request.session_id).map_err(|error| anyhow::anyhow!(error))?;
            let _ = store.clear_provider_session_binding(session_id, &request.provider_id);
            Err(error.context(
                "the stale provider cursor was cleared; retry explicitly to avoid replaying tools",
            ))
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
        ProviderAdapterKind::KimiAcp => run_kimi_acp_chat(app, request, resume_cursor),
        ProviderAdapterKind::ReadinessOnly => anyhow::bail!(
            "{} is readiness-only in Gyro V1. Chat execution for this provider has not been implemented yet.",
            request.provider_label.as_deref().unwrap_or("Provider")
        ),
    }
}

fn run_kimi_acp_chat(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    resume_cursor: Option<&ProviderResumeCursor>,
) -> anyhow::Result<ProviderRunnerOutput> {
    let workspace = provider_chat_cwd(request.workspace_path.as_deref())?;
    let cancellation = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .map_err(|_| anyhow::anyhow!("provider cancellation state is unavailable"))?
        .get(&request.session_id)
        .map(|control| control.cancellation.clone())
        .ok_or_else(|| anyhow::anyhow!("provider run control is unavailable"))?;
    let mut prompt = vec![serde_json::json!({
        "type": "text",
        "text": provider_context_message(request),
    })];
    for attachment in &request.attachments {
        if attachment.kind == "image" {
            let bytes = fs::read(&attachment.path)
                .with_context(|| format!("read image attachment {}", attachment.name))?;
            if bytes.len() > MAX_CHAT_IMAGE_BYTES as usize {
                anyhow::bail!("{} exceeds the image attachment limit", attachment.name);
            }
            prompt.push(serde_json::json!({
                "type": "image",
                "data": base64::engine::general_purpose::STANDARD.encode(bytes),
                "mimeType": attachment.mime_type.as_deref().unwrap_or("application/octet-stream"),
            }));
        } else if attachment.kind == "workspace-file" {
            let content = fs::read_to_string(&attachment.path)
                .with_context(|| format!("read workspace attachment {}", attachment.name))?;
            prompt.push(serde_json::json!({
                "type": "resource",
                "resource": {
                    "uri": format!("file://{}", attachment.path),
                    "mimeType": attachment.mime_type.as_deref().unwrap_or("text/plain"),
                    "text": content,
                },
            }));
        }
    }

    let activities = Arc::new(Mutex::new(Vec::<ProviderActivity>::new()));
    let activity_sink = activities.clone();
    let approved_file_writes = Arc::new(AtomicUsize::new(0));
    let approval_write_tokens = approved_file_writes.clone();
    let write_tokens = approved_file_writes.clone();
    let approval_context = ProviderApprovalContext::from(request);
    let plan_mode = request.mode == ChatMode::Plan;
    let require_command_approval = request.require_command_approval;
    let require_file_approval = request.require_file_edit_approval;
    let output = run_kimi_acp(
        KimiAcpRequest {
            program: "kimi".into(),
            program_args: vec!["acp".into()],
            workspace: workspace.clone(),
            prompt,
            model: request.model_id.clone().unwrap_or_else(|| "k3".into()),
            reasoning_effort: request
                .reasoning_effort
                .clone()
                .unwrap_or_else(|| "max".into()),
            mode: if plan_mode {
                KimiAcpMode::Plan
            } else {
                KimiAcpMode::Normal
            },
            resume_session_id: resume_cursor
                .filter(|cursor| cursor.kind == "kimi-acp-session")
                .map(|cursor| cursor.session_id.clone()),
            timeout: Duration::from_secs(PROVIDER_CHAT_INACTIVITY_TIMEOUT_SECS),
            inactivity_timeout: Duration::from_secs(PROVIDER_CHAT_INACTIVITY_TIMEOUT_SECS),
            cancellation: cancellation.clone(),
        },
        |delta| {
            emit_provider_chat_event(
                app,
                request,
                "delta",
                Some(HarnessRunStatus::Running),
                Some(delta.to_string()),
                None,
                None,
            );
        },
        |activity| {
            let activity = ProviderActivity {
                id: activity.id.clone(),
                kind: activity.kind.clone(),
                label: activity.label.clone(),
                detail: activity.detail.clone(),
                status: activity.status.clone(),
            };
            emit_provider_activity_event(app, request, &activity);
            if let Ok(mut sink) = activity_sink.lock() {
                sink.push(activity);
            }
        },
        |approval| {
            if plan_mode
                && matches!(
                    approval.kind,
                    KimiAcpApprovalKind::Command | KimiAcpApprovalKind::FileChange
                )
            {
                return Ok(KimiAcpApprovalDecision::RejectOnce);
            }
            let approval_type = match approval.kind {
                KimiAcpApprovalKind::Command => "command",
                KimiAcpApprovalKind::FileChange => "file-change",
                KimiAcpApprovalKind::Other => "permissions",
            };
            let auto_allow = match approval.kind {
                KimiAcpApprovalKind::Command => !require_command_approval,
                KimiAcpApprovalKind::FileChange => !require_file_approval,
                KimiAcpApprovalKind::Other => !require_command_approval && !require_file_approval,
            };
            let allowed = if auto_allow {
                true
            } else {
                wait_for_provider_approval_with_transaction(
                    app,
                    &approval_context,
                    approval_type,
                    sanitize_provider_approval_details(approval.tool_call.clone()),
                    None,
                )? != ProviderApprovalDecision::Reject
            };
            if allowed && approval.kind == KimiAcpApprovalKind::FileChange {
                approval_write_tokens.fetch_add(1, Ordering::SeqCst);
            }
            Ok(if allowed {
                KimiAcpApprovalDecision::AllowOnce
            } else {
                KimiAcpApprovalDecision::RejectOnce
            })
        },
        |target, content| {
            if plan_mode {
                anyhow::bail!("Kimi file writes are disabled in plan mode");
            }
            if write_tokens
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |tokens| {
                    tokens.checked_sub(1)
                })
                .is_err()
            {
                anyhow::bail!("Kimi requested an unapproved workspace write");
            }
            let transaction =
                prepare_provider_text_replacement_transaction(&workspace, target, content)?;
            apply_provider_mutation_transaction_with_cancellation(&transaction, || {
                cancellation.is_cancelled()
            })?;
            Ok(())
        },
    )?;
    let activities = activities
        .lock()
        .map_err(|_| anyhow::anyhow!("Kimi activity state is unavailable"))?
        .clone();
    let response = gyro_core::sanitize_harness_text(&output.response);
    Ok(ProviderRunnerOutput {
        activities,
        context_usage: None,
        response: response.clone(),
        resume_cursor: Some(ProviderResumeCursor {
            kind: "kimi-acp-session".into(),
            session_id: output.session_id.clone(),
        }),
        retry_count: 0,
        resumed: output.resumed,
        output_summary: Some(provider_output_summary(
            "kimi-acp",
            &output.stop_reason,
            Some(&output.session_id),
            response.chars().count(),
        )),
    })
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
    if request.require_command_approval
        || request.require_file_edit_approval
        || !request.full_access
    {
        return run_openai_codex_app_server_chat(app, request, resume_cursor);
    }
    let output_path =
        std::env::temp_dir().join(format!("gyro-codex-response-{}.txt", Uuid::new_v4()));
    let cwd = provider_chat_cwd(request.workspace_path.as_deref())?;
    let contextual_message = provider_context_message(request);
    let prompt = openai_codex_chat_prompt(
        &contextual_message,
        request.workspace_path.as_deref(),
        request.model_label.as_deref(),
        request.suggest_title,
        request.mode == ChatMode::Normal
            && !request.require_command_approval
            && !request.require_file_edit_approval,
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
        &request.mode,
        request.require_command_approval,
        request.require_file_edit_approval,
        request.full_access,
        &request.attachments,
        &prompt,
    ));

    let output =
        run_streaming_command(
            process,
            Duration::from_secs(PROVIDER_CHAT_MAX_RUNTIME_SECS),
            Duration::from_secs(PROVIDER_CHAT_INACTIVITY_TIMEOUT_SECS),
            app,
            request,
        )
        .map_err(|error| {
            anyhow::anyhow!(
                "Could not complete OpenAI through Codex CLI. Run `codex login` in Terminal if needed, then try again. {error}"
            )
        })?;
    let last_message_result =
        read_bounded_optional_text_file(&output_path, MAX_CHAT_RESPONSE_BYTES);
    let _ = fs::remove_file(&output_path);
    let last_message = last_message_result?;
    if output.status_success {
        let response = sanitize_provider_chat_response(last_message.trim());
        if !response.is_empty() {
            let response_chars = response.chars().count();
            let provider_session_id = output.provider_session_id.clone();
            return Ok(ProviderRunnerOutput {
                activities: provider_activities_for_response(output.activities, &response),
                context_usage: output.context_usage,
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
                activities: provider_activities_for_response(output.activities, &stdout),
                context_usage: output.context_usage,
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

fn read_bounded_optional_text_file(path: &Path, max_bytes: usize) -> anyhow::Result<String> {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => return Err(error).with_context(|| format!("open {}", path.display())),
    };
    let mut bytes = Vec::with_capacity(max_bytes.min(8 * 1024));
    Read::by_ref(&mut file)
        .take((max_bytes + 1) as u64)
        .read_to_end(&mut bytes)
        .with_context(|| format!("read {}", path.display()))?;
    if bytes.len() > max_bytes {
        anyhow::bail!("provider response file exceeded the {max_bytes} byte limit");
    }
    String::from_utf8(bytes).context("provider response file was not UTF-8")
}

fn run_openai_codex_app_server_chat(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    resume_cursor: Option<&ProviderResumeCursor>,
) -> anyhow::Result<ProviderRunnerOutput> {
    let cwd = provider_chat_cwd(request.workspace_path.as_deref())?;
    let contextual_message = provider_context_message(request);
    let prompt = openai_codex_chat_prompt(
        &contextual_message,
        request.workspace_path.as_deref(),
        request.model_label.as_deref(),
        request.suggest_title,
        request.mode == ChatMode::Normal,
    );
    let mut process = command_with_gui_path("codex");
    process
        .current_dir(&cwd)
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    configure_provider_process_group(&mut process);
    let child = process
        .spawn()
        .map_err(|error| anyhow::anyhow!("could not start Codex app server: {error}"))?;
    let mut child = ProviderProcessGuard::new(child);
    let result = (|| -> anyhow::Result<ProviderRunnerOutput> {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("Codex app server input is unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("Codex app server output is unavailable"))?;
        let messages = spawn_codex_app_server_reader(stdout);
        let deadline = Instant::now() + Duration::from_secs(PROVIDER_CHAT_MAX_RUNTIME_SECS);

        write_codex_app_server_message(
            &mut stdin,
            &serde_json::json!({
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": {
                        "name": "gyro",
                        "title": "Gyro",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                    "capabilities": { "experimentalApi": true },
                },
            }),
        )
        .map_err(anyhow::Error::msg)?;
        let initialize = receive_codex_app_server_response(&messages, 1, deadline)
            .map_err(anyhow::Error::msg)?;
        codex_app_server_result(&initialize).map_err(anyhow::Error::msg)?;
        write_codex_app_server_message(&mut stdin, &serde_json::json!({ "method": "initialized" }))
            .map_err(anyhow::Error::msg)?;

        let resume_id = resume_cursor.and_then(|cursor| {
            (cursor.kind == "codex-session").then_some(cursor.session_id.as_str())
        });
        let model = codex_model_arg(request.model_id.as_deref());
        let (approval_policy, sandbox_mode, sandbox_policy) = codex_app_server_policy(
            &request.mode,
            request.require_command_approval,
            request.require_file_edit_approval,
            request.full_access,
            &cwd,
        );
        let thread_request = if let Some(thread_id) = resume_id {
            serde_json::json!({
                "id": 2,
                "method": "thread/resume",
                "params": {
                    "threadId": thread_id,
                    "cwd": cwd,
                    "model": model,
                    "approvalPolicy": approval_policy,
                    "approvalsReviewer": "user",
                    "sandbox": sandbox_mode,
                },
            })
        } else {
            serde_json::json!({
                "id": 2,
                "method": "thread/start",
                "params": {
                    "cwd": cwd,
                    "model": model,
                    "approvalPolicy": approval_policy,
                    "approvalsReviewer": "user",
                    "sandbox": sandbox_mode,
                    "ephemeral": false,
                },
            })
        };
        write_codex_app_server_message(&mut stdin, &thread_request).map_err(anyhow::Error::msg)?;
        let thread_response = receive_codex_app_server_response(&messages, 2, deadline)
            .map_err(anyhow::Error::msg)?;
        let thread_result =
            codex_app_server_result(&thread_response).map_err(anyhow::Error::msg)?;
        let thread_id = thread_result
            .pointer("/thread/id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("Codex did not return a thread id"))?
            .to_string();

        let mut input = vec![serde_json::json!({ "type": "text", "text": prompt })];
        for attachment in request
            .attachments
            .iter()
            .filter(|item| item.kind == "image")
        {
            input.push(serde_json::json!({
                "type": "localImage",
                "path": attachment.path,
            }));
        }
        let mut turn_params = serde_json::json!({
            "threadId": thread_id,
            "input": input,
            "cwd": cwd,
            "model": model,
            "approvalPolicy": approval_policy,
            "approvalsReviewer": "user",
            "sandboxPolicy": sandbox_policy,
        });
        if let Some(effort) = codex_reasoning_effort_arg(
            request.model_id.as_deref(),
            request.reasoning_effort.as_deref(),
        ) {
            turn_params["effort"] = serde_json::Value::String(effort);
        }
        write_codex_app_server_message(
            &mut stdin,
            &serde_json::json!({
                "id": 3,
                "method": "turn/start",
                "params": turn_params,
            }),
        )
        .map_err(anyhow::Error::msg)?;

        let mut response_text = String::new();
        let mut response_text_chars = 0_usize;
        let mut response_text_truncated = false;
        let mut pending_delta = String::new();
        let mut last_delta_emit = Instant::now();
        let mut completed_message = String::new();
        let mut activities = Vec::new();
        let mut patches = HashMap::<String, serde_json::Value>::new();
        let mut context_usage = None;
        let mut turn_started = false;
        let mut last_protocol_activity = Instant::now();
        let mut protocol_messages = 0usize;
        let mut protocol_bytes = 0usize;
        loop {
            if provider_chat_cancelled(app, &request.session_id) {
                anyhow::bail!("chat cancelled by user");
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                anyhow::bail!("Codex app server turn timed out");
            }
            let inactivity_remaining = Duration::from_secs(PROVIDER_CHAT_INACTIVITY_TIMEOUT_SECS)
                .saturating_sub(last_protocol_activity.elapsed());
            if inactivity_remaining.is_zero() {
                anyhow::bail!("Codex app server stopped producing protocol activity");
            }
            let message = match messages.recv_timeout(
                remaining
                    .min(inactivity_remaining)
                    .min(Duration::from_millis(250)),
            ) {
                Ok(message) => message.map_err(anyhow::Error::msg)?,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    flush_codex_app_server_delta(
                        app,
                        request,
                        &mut pending_delta,
                        &mut last_delta_emit,
                        false,
                    );
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    anyhow::bail!("Codex app server disconnected")
                }
            };
            last_protocol_activity = Instant::now();
            protocol_messages = protocol_messages.saturating_add(1);
            protocol_bytes = protocol_bytes.saturating_add(serde_json::to_vec(&message)?.len());
            if protocol_messages > MAX_CODEX_APP_SERVER_PROTOCOL_MESSAGES
                || protocol_bytes > MAX_CODEX_APP_SERVER_PROTOCOL_BYTES
            {
                anyhow::bail!("Codex app server exceeded its protocol activity budget");
            }
            let method = message.get("method").and_then(serde_json::Value::as_str);
            if let Some(method) = method.filter(|_| message.get("id").is_some()) {
                let params = message.get("params").cloned().unwrap_or_default();
                handle_codex_app_server_request(
                    app, request, &mut stdin, &message, method, &params, &patches,
                )?;
                continue;
            }
            if message.get("id").and_then(serde_json::Value::as_u64) == Some(3) {
                codex_app_server_result(&message).map_err(anyhow::Error::msg)?;
                turn_started = true;
                continue;
            }
            let Some(method) = method else { continue };
            let params = message.get("params").cloned().unwrap_or_default();
            match method {
                "thread/tokenUsage/updated" => {
                    if let Some(usage) = provider_context_usage_from_app_server(&params) {
                        context_usage = Some(usage);
                    }
                }
                "item/agentMessage/delta" => {
                    if let Some(delta) = params.get("delta").and_then(serde_json::Value::as_str) {
                        if !response_text_truncated {
                            let pushed = push_bounded(
                                &mut response_text,
                                &mut response_text_chars,
                                delta,
                                MAX_CHAT_RESPONSE_CHARS,
                            );
                            response_text_truncated = pushed.truncated;
                            if pushed.accepted_chars > 0 {
                                pending_delta.extend(delta.chars().take(pushed.accepted_chars));
                                flush_codex_app_server_delta(
                                    app,
                                    request,
                                    &mut pending_delta,
                                    &mut last_delta_emit,
                                    false,
                                );
                            }
                        }
                    }
                }
                "item/fileChange/patchUpdated" => {
                    if let Some(item_id) = params.get("itemId").and_then(serde_json::Value::as_str)
                    {
                        if patches
                            .get(item_id)
                            .and_then(|patch| patch.get("changes"))
                            .is_none()
                        {
                            insert_codex_app_server_patch(&mut patches, item_id, params.clone())?;
                        }
                    }
                }
                "item/started" => {
                    if let Some(item) = params.get("item") {
                        if item.get("type").and_then(serde_json::Value::as_str)
                            == Some("fileChange")
                        {
                            if let Some(item_id) =
                                item.get("id").and_then(serde_json::Value::as_str)
                            {
                                insert_codex_app_server_patch(
                                    &mut patches,
                                    item_id,
                                    serde_json::json!({
                                        "itemId": item_id,
                                        "changes": item.get("changes").cloned().unwrap_or_default(),
                                    }),
                                )?;
                            }
                        }
                    }
                }
                "item/completed" => {
                    if let Some(item) = params.get("item") {
                        match item.get("type").and_then(serde_json::Value::as_str) {
                            Some("agentMessage") => {
                                if let Some(text) =
                                    item.get("text").and_then(serde_json::Value::as_str)
                                {
                                    completed_message =
                                        truncate_chars(text, MAX_CHAT_RESPONSE_CHARS);
                                }
                            }
                            Some("commandExecution") => {
                                let activity = codex_item_activity(item, "command", "Ran command");
                                if activities.len() < MAX_CODEX_APP_SERVER_ACTIVITIES {
                                    emit_provider_activity_event(app, request, &activity);
                                    activities.push(activity);
                                }
                            }
                            Some("fileChange") => {
                                let activity = codex_item_activity(item, "file", "Updated files");
                                if activities.len() < MAX_CODEX_APP_SERVER_ACTIVITIES {
                                    emit_provider_activity_event(app, request, &activity);
                                    activities.push(activity);
                                }
                            }
                            _ => {}
                        }
                    }
                }
                "turn/completed" => {
                    flush_codex_app_server_delta(
                        app,
                        request,
                        &mut pending_delta,
                        &mut last_delta_emit,
                        true,
                    );
                    let status = params
                        .pointer("/turn/status")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("failed");
                    if status != "completed" {
                        let detail = params
                            .pointer("/turn/error/message")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("Codex turn did not complete");
                        anyhow::bail!("{detail}");
                    }
                    break;
                }
                _ => {}
            }
        }
        if !turn_started {
            anyhow::bail!("Codex did not start the requested turn");
        }
        let response = sanitize_provider_chat_response(if completed_message.trim().is_empty() {
            response_text.trim()
        } else {
            completed_message.trim()
        });
        if response.is_empty() {
            anyhow::bail!("OpenAI finished, but Codex did not return a chat response.");
        }
        let response_chars = response.chars().count();
        Ok(ProviderRunnerOutput {
            activities: provider_activities_for_response(activities, &response),
            context_usage,
            response,
            resume_cursor: Some(ProviderResumeCursor {
                kind: "codex-session".into(),
                session_id: thread_id.clone(),
            }),
            retry_count: 0,
            resumed: resume_id.is_some(),
            output_summary: Some(provider_output_summary(
                "codex-app-server",
                "completed",
                Some(&thread_id),
                response_chars,
            )),
        })
    })();
    drop(child);
    result
}

fn codex_app_server_policy(
    mode: &ChatMode,
    require_command_approval: bool,
    require_file_edit_approval: bool,
    full_access: bool,
    cwd: &Path,
) -> (&'static str, &'static str, serde_json::Value) {
    let approval_policy = if *mode == ChatMode::Plan || require_command_approval {
        "untrusted"
    } else if !full_access {
        "never"
    } else {
        "on-request"
    };
    if *mode == ChatMode::Plan || require_file_edit_approval {
        return (
            approval_policy,
            "read-only",
            serde_json::json!({ "type": "readOnly", "networkAccess": false }),
        );
    }
    (
        approval_policy,
        "workspace-write",
        serde_json::json!({
            "type": "workspaceWrite",
            "writableRoots": [cwd],
            "networkAccess": false,
            "excludeTmpdirEnvVar": false,
            "excludeSlashTmp": false
        }),
    )
}

fn flush_codex_app_server_delta(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    pending_delta: &mut String,
    last_emit: &mut Instant,
    force: bool,
) {
    if pending_delta.is_empty() || (!force && last_emit.elapsed() < PROVIDER_STREAM_FLUSH_INTERVAL)
    {
        return;
    }
    let delta = std::mem::take(pending_delta);
    *last_emit = Instant::now();
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

fn insert_codex_app_server_patch(
    patches: &mut HashMap<String, serde_json::Value>,
    item_id: &str,
    patch: serde_json::Value,
) -> anyhow::Result<()> {
    if !patches.contains_key(item_id) && patches.len() >= MAX_CODEX_APP_SERVER_PATCHES {
        anyhow::bail!(
            "Codex returned more than {MAX_CODEX_APP_SERVER_PATCHES} file-change records"
        );
    }
    let encoded_size = serde_json::to_vec(&patch)?.len();
    if encoded_size > MAX_CODEX_APP_SERVER_PATCH_BYTES {
        anyhow::bail!(
            "Codex file-change record exceeded the {MAX_CODEX_APP_SERVER_PATCH_BYTES} byte limit"
        );
    }
    patches.insert(item_id.to_string(), patch);
    Ok(())
}

fn codex_item_activity(
    item: &serde_json::Value,
    kind: &str,
    fallback_label: &str,
) -> ProviderActivity {
    let id = item
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(fallback_label)
        .to_string();
    let label = item
        .get("command")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback_label)
        .to_string();
    let status = item
        .get("status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("done")
        .to_string();
    ProviderActivity {
        id,
        kind: kind.into(),
        label,
        detail: None,
        status,
    }
}

fn handle_codex_app_server_request(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    stdin: &mut ChildStdin,
    message: &serde_json::Value,
    method: &str,
    params: &serde_json::Value,
    patches: &HashMap<String, serde_json::Value>,
) -> anyhow::Result<()> {
    let request_id = message
        .get("id")
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("Codex approval request did not include an id"))?;
    let (decision, response) = match method {
        "item/commandExecution/requestApproval" => {
            let decision = if request.require_command_approval {
                wait_for_provider_approval(app, request, "command", params.clone())?
            } else {
                ProviderApprovalDecision::Approve
            };
            let response = codex_provider_approval_response(decision);
            (decision, serde_json::json!({ "decision": response }))
        }
        "item/fileChange/requestApproval" => {
            let mut details = params.clone();
            if let Some(item_id) = params.get("itemId").and_then(serde_json::Value::as_str) {
                if let Some(patch) = patches.get(item_id) {
                    details["patch"] = patch.clone();
                }
            }
            let decision = if request.require_file_edit_approval {
                wait_for_provider_approval(app, request, "file-change", details)?
            } else {
                ProviderApprovalDecision::Approve
            };
            let response = codex_provider_approval_response(decision);
            (decision, serde_json::json!({ "decision": response }))
        }
        "item/permissions/requestApproval" => {
            let decision = wait_for_provider_approval(app, request, "permissions", params.clone())?;
            let response = if decision != ProviderApprovalDecision::Reject {
                serde_json::json!({
                    "permissions": params.get("permissions").cloned().unwrap_or_default(),
                    "scope": "turn",
                    "strictAutoReview": true,
                })
            } else {
                serde_json::json!({
                    "permissions": {},
                    "scope": "turn",
                    "strictAutoReview": true,
                })
            };
            (decision, response)
        }
        _ => {
            write_codex_app_server_message(
                stdin,
                &serde_json::json!({
                    "id": request_id,
                    "error": { "code": -32601, "message": "unsupported Gyro client request" }
                }),
            )
            .map_err(anyhow::Error::msg)?;
            return Ok(());
        }
    };
    let _ = decision;
    write_codex_app_server_message(
        stdin,
        &serde_json::json!({ "id": request_id, "result": response }),
    )
    .map_err(anyhow::Error::msg)
}

fn codex_provider_approval_response(decision: ProviderApprovalDecision) -> &'static str {
    match decision {
        ProviderApprovalDecision::Approve => "accept",
        ProviderApprovalDecision::Reject | ProviderApprovalDecision::AppliedByGyro => "decline",
    }
}

fn wait_for_provider_approval(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    approval_type: &str,
    details: serde_json::Value,
) -> anyhow::Result<ProviderApprovalDecision> {
    let file_transaction = if approval_type == "file-change" {
        let workspace_path = request
            .workspace_path
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("provider file approval has no selected workspace"))?;
        let changes = details
            .pointer("/patch/changes")
            .or_else(|| details.pointer("/change/changes"))
            .cloned()
            .ok_or_else(|| {
                anyhow::anyhow!("provider file approval did not include the reviewed file set")
            })?;
        let changes: Vec<ProviderFileChange> =
            serde_json::from_value(changes).context("decode reviewed provider file changes")?;
        Some(prepare_provider_mutation_transaction(
            Path::new(workspace_path),
            &changes,
        )?)
    } else {
        None
    };
    wait_for_provider_approval_with_transaction(
        app,
        &ProviderApprovalContext::from(request),
        approval_type,
        details,
        file_transaction,
    )
}

fn wait_for_provider_approval_with_transaction(
    app: &tauri::AppHandle,
    context: &ProviderApprovalContext,
    approval_type: &str,
    details: serde_json::Value,
    file_transaction: Option<PreparedProviderMutationTransaction>,
) -> anyhow::Result<ProviderApprovalDecision> {
    let approval_id = Uuid::new_v4();
    let session_id = Uuid::parse_str(&context.session_id)?;
    let turn_id = context
        .turn_id
        .as_deref()
        .map(Uuid::parse_str)
        .transpose()?;
    let command = details
        .get("command")
        .and_then(serde_json::Value::as_str)
        .map(gyro_core::sanitize_harness_text);
    let reason = details
        .get("reason")
        .and_then(serde_json::Value::as_str)
        .map(gyro_core::sanitize_harness_text);
    let payload = serde_json::json!({
        "schema": "gyro.provider-approval.v1",
        "kind": "provider-tool-approval",
        "approvalId": approval_id,
        "approvalType": approval_type,
        "providerId": context.provider_id,
        "providerLabel": context.provider_label,
        "command": command,
        "cwd": details.get("cwd"),
        "reason": reason,
        "details": details,
        "status": "pending",
        "risk": provider_approval_risk(approval_type),
    });
    let store = open_store().map_err(anyhow::Error::msg)?;
    let event = store.append_event_with_turn_id(
        session_id,
        SessionEventKind::ApprovalRequested,
        provider_approval_label(approval_type),
        payload.clone(),
        turn_id,
    )?;
    let (sender, receiver) = mpsc::channel();
    app.state::<ProviderApprovalManager>()
        .pending
        .lock()
        .map_err(|_| anyhow::anyhow!("provider approval state is unavailable"))?
        .insert(
            approval_id.to_string(),
            PendingProviderApproval {
                sender,
                approval_id,
                session_id,
                turn_id,
                payload: payload.clone(),
                file_transaction,
            },
        );
    let _ = app.emit(PROVIDER_APPROVAL_EVENT, event);
    let approval_key = approval_id.to_string();
    let started_at = Instant::now();
    loop {
        match receiver.recv_timeout(Duration::from_millis(250)) {
            Ok(decision) => {
                remove_pending_provider_approval(app, &approval_key);
                return Ok(decision);
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                remove_pending_provider_approval(app, &approval_key);
                record_provider_approval_terminal_event(
                    app,
                    &store,
                    session_id,
                    turn_id,
                    payload,
                    "failed",
                    "Provider approval channel closed",
                )?;
                anyhow::bail!("provider approval channel closed")
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if started_at.elapsed() >= PROVIDER_APPROVAL_TIMEOUT {
            remove_pending_provider_approval(app, &approval_key);
            record_provider_approval_terminal_event(
                app,
                &store,
                session_id,
                turn_id,
                payload,
                "expired",
                "Provider approval expired",
            )?;
            anyhow::bail!("provider approval expired after 15 minutes");
        }
        if provider_chat_cancelled(app, &context.session_id) {
            remove_pending_provider_approval(app, &approval_key);
            record_provider_approval_terminal_event(
                app,
                &store,
                session_id,
                turn_id,
                payload,
                "cancelled",
                "Provider approval cancelled",
            )?;
            anyhow::bail!("chat cancelled by user");
        }
    }
}

fn remove_pending_provider_approval(app: &tauri::AppHandle, approval_key: &str) {
    if let Ok(mut pending) = app.state::<ProviderApprovalManager>().pending.lock() {
        pending.remove(approval_key);
    }
}

fn record_provider_approval_terminal_event(
    app: &tauri::AppHandle,
    store: &SessionStore,
    session_id: Uuid,
    turn_id: Option<Uuid>,
    mut payload: serde_json::Value,
    status: &str,
    message: &str,
) -> anyhow::Result<()> {
    payload["status"] = serde_json::Value::String(status.into());
    let event = store.append_event_with_turn_id(
        session_id,
        SessionEventKind::SystemEvent,
        message,
        payload,
        turn_id,
    )?;
    let _ = app.emit(PROVIDER_APPROVAL_EVENT, event);
    Ok(())
}

fn provider_approval_label(approval_type: &str) -> &'static str {
    match approval_type {
        "command" => "Review command",
        "file-change" => "Review provider file changes",
        _ => "Review provider permissions",
    }
}

fn provider_approval_risk(approval_type: &str) -> &'static str {
    match approval_type {
        "command" => "Runs a command in the selected project",
        "file-change" => "Allows the provider to apply the displayed workspace patch",
        _ => "Expands provider access for this turn",
    }
}

fn desktop_claude_approval_type(tool_name: &str) -> &'static str {
    match tool_name {
        "Bash" | "KillShell" => "command",
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => "file-change",
        _ => "permissions",
    }
}

fn sanitize_provider_approval_details(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::String(value) => {
            serde_json::Value::String(gyro_core::security::redact_secrets(&value))
        }
        serde_json::Value::Array(values) => serde_json::Value::Array(
            values
                .into_iter()
                .map(sanitize_provider_approval_details)
                .collect(),
        ),
        serde_json::Value::Object(values) => serde_json::Value::Object(
            values
                .into_iter()
                .map(|(key, value)| (key, sanitize_provider_approval_details(value)))
                .collect(),
        ),
        value => value,
    }
}

fn desktop_claude_approval_details(
    request: &DesktopProviderApprovalRequest,
    workspace_path: &Path,
) -> serde_json::Value {
    let command = request
        .input
        .get("command")
        .and_then(serde_json::Value::as_str)
        .map(|command| truncate_chars(&gyro_core::security::redact_secrets(command), 12_000));
    let reason = request
        .input
        .get("description")
        .or_else(|| request.input.get("reason"))
        .and_then(serde_json::Value::as_str)
        .map(|reason| truncate_chars(&gyro_core::security::redact_secrets(reason), 2_000));
    let file_path = request
        .input
        .get("file_path")
        .or_else(|| request.input.get("filePath"))
        .and_then(serde_json::Value::as_str);
    let input_summary = match desktop_claude_approval_type(&request.tool_name) {
        "file-change" => serde_json::json!({
            "filePath": file_path,
            "operation": request.tool_name,
            "contentBytes": request
                .input
                .get("content")
                .and_then(serde_json::Value::as_str)
                .map(str::len),
            "editCount": request
                .input
                .get("edits")
                .and_then(serde_json::Value::as_array)
                .map(Vec::len)
                .or_else(|| (request.tool_name == "Edit").then_some(1)),
            "replaceAll": request
                .input
                .get("replace_all")
                .or_else(|| request.input.get("replaceAll"))
                .and_then(serde_json::Value::as_bool),
        }),
        "command" => serde_json::json!({
            "command": command.clone(),
            "cwd": workspace_path,
        }),
        _ => serde_json::json!({
            "keys": request
                .input
                .as_object()
                .map(|input| input.keys().take(32).cloned().collect::<Vec<_>>())
                .unwrap_or_default(),
        }),
    };
    let permission_suggestions = serde_json::to_string(&sanitize_provider_approval_details(
        request.permission_suggestions.clone(),
    ))
    .ok()
    .map(|value| truncate_chars(&value, 8_000));
    sanitize_provider_approval_details(serde_json::json!({
        "toolName": request.tool_name,
        "input": input_summary,
        "permissionSuggestions": permission_suggestions,
        "command": command,
        "cwd": workspace_path,
        "reason": reason,
        "patch": {
            "changes": file_path
                .map(|path| vec![serde_json::json!({ "path": path })])
                .unwrap_or_default(),
        },
    }))
}

fn record_provider_approval_failure(
    app: &tauri::AppHandle,
    context: &ProviderApprovalContext,
    approval_type: &str,
    details: serde_json::Value,
    error: &str,
) {
    let Ok(session_id) = Uuid::parse_str(&context.session_id) else {
        return;
    };
    let turn_id = context
        .turn_id
        .as_deref()
        .and_then(|turn_id| Uuid::parse_str(turn_id).ok());
    let payload = serde_json::json!({
        "schema": "gyro.provider-approval.v1",
        "kind": "provider-tool-approval",
        "approvalId": Uuid::new_v4(),
        "approvalType": approval_type,
        "providerId": context.provider_id,
        "providerLabel": context.provider_label,
        "details": details,
        "status": "failed",
        "risk": provider_approval_risk(approval_type),
        "error": gyro_core::sanitize_harness_text(error),
    });
    let Ok(store) = open_store() else {
        return;
    };
    if let Ok(event) = store.append_event_with_turn_id(
        session_id,
        SessionEventKind::ApprovalRequested,
        "Provider action could not be reviewed",
        payload,
        turn_id,
    ) {
        let _ = app.emit(PROVIDER_APPROVAL_EVENT, event);
    }
}

fn handle_desktop_provider_approval_request(
    app: &tauri::AppHandle,
    request: DesktopProviderApprovalRequest,
) -> DesktopProviderApprovalResponse {
    if request.schema != DESKTOP_PROVIDER_APPROVAL_IPC_SCHEMA_V1
        || !versions_compatible(&request.sender_version, env!("CARGO_PKG_VERSION"))
    {
        let mut response = DesktopProviderApprovalResponse::deny(
            "The Claude approval helper does not match this Gyro.app version.",
        );
        response.compatible = false;
        return response;
    }
    if request.provider_id != "anthropic" {
        return DesktopProviderApprovalResponse::deny(
            "Gyro rejected a provider approval request from an unexpected provider.",
        );
    }
    let session_id = match Uuid::parse_str(&request.session_id) {
        Ok(session_id) => session_id,
        Err(_) => {
            return DesktopProviderApprovalResponse::deny(
                "Gyro rejected a provider approval request with an invalid session.",
            )
        }
    };
    if request
        .turn_id
        .as_deref()
        .map(Uuid::parse_str)
        .transpose()
        .is_err()
    {
        return DesktopProviderApprovalResponse::deny(
            "Gyro rejected a provider approval request with an invalid turn.",
        );
    }
    let store = match open_store() {
        Ok(store) => store,
        Err(error) => return DesktopProviderApprovalResponse::deny(error),
    };
    let config = match GyroPaths::for_current_user().and_then(|paths| GyroConfig::load(&paths)) {
        Ok(config) => config,
        Err(error) => return DesktopProviderApprovalResponse::deny(error.to_string()),
    };
    let session = match store.get_session(session_id) {
        Ok(Some(session)) => session,
        Ok(None) => {
            return DesktopProviderApprovalResponse::deny(
                "Gyro could not find the chat that requested this approval.",
            )
        }
        Err(error) => return DesktopProviderApprovalResponse::deny(error.to_string()),
    };
    if session.provider_id.as_deref() != Some("anthropic") {
        return DesktopProviderApprovalResponse::deny(
            "Gyro rejected an approval request for a chat using another provider.",
        );
    }
    let active_run_matches = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .map(|flags| provider_run_approval_matches(&flags, &request.session_id, &request.run_nonce))
        .unwrap_or(false);
    if !active_run_matches {
        return DesktopProviderApprovalResponse::deny(
            "Gyro rejected an approval request that was not issued by the active provider run.",
        );
    }
    let approval_type = desktop_claude_approval_type(&request.tool_name);
    let required = match approval_type {
        "command" => config.require_command_approval,
        "file-change" => config.require_file_edit_approval,
        _ => config.require_command_approval || config.require_file_edit_approval,
    };
    if !required {
        return DesktopProviderApprovalResponse::allow(
            request.input,
            "Gyro allowed this action under the current permissions.",
        );
    }
    let details = desktop_claude_approval_details(&request, &session.workspace_path);
    let context = ProviderApprovalContext {
        session_id: request.session_id.clone(),
        turn_id: request.turn_id.clone(),
        provider_id: request.provider_id.clone(),
        provider_label: session.provider_label.clone(),
    };
    let file_transaction = if approval_type == "file-change" {
        match prepare_claude_provider_mutation_transaction(
            &session.workspace_path,
            &request.tool_name,
            &request.input,
        ) {
            Ok(transaction) => Some(transaction),
            Err(error) => {
                record_provider_approval_failure(
                    app,
                    &context,
                    approval_type,
                    details,
                    &error.to_string(),
                );
                return DesktopProviderApprovalResponse::deny(format!(
                    "Gyro could not safely review this file change: {}",
                    gyro_core::sanitize_harness_text(&error.to_string())
                ));
            }
        }
    } else {
        None
    };
    match wait_for_provider_approval_with_transaction(
        app,
        &context,
        approval_type,
        details,
        file_transaction,
    ) {
        Ok(decision) => desktop_claude_approval_response(decision, request.input),
        Err(error) => DesktopProviderApprovalResponse::deny(format!(
            "Gyro could not complete this approval: {}",
            gyro_core::sanitize_harness_text(&error.to_string())
        )),
    }
}

fn desktop_claude_approval_response(
    decision: ProviderApprovalDecision,
    input: serde_json::Value,
) -> DesktopProviderApprovalResponse {
    match decision {
        ProviderApprovalDecision::Approve => DesktopProviderApprovalResponse::allow(
            input,
            "Gyro approved this provider action.",
        ),
        ProviderApprovalDecision::AppliedByGyro => DesktopProviderApprovalResponse::deny(
            "Gyro already applied the reviewed file changes atomically. Re-read the files and continue without retrying the write.",
        ),
        ProviderApprovalDecision::Reject => DesktopProviderApprovalResponse::deny(
            "The user rejected this provider action in Gyro.",
        ),
    }
}

fn run_anthropic_claude_chat(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    resume_cursor: Option<&ProviderResumeCursor>,
) -> anyhow::Result<ProviderRunnerOutput> {
    let cwd = provider_chat_cwd(request.workspace_path.as_deref())?;
    let contextual_message = provider_context_message(request);
    let prompt = claude_chat_prompt(
        &contextual_message,
        request.workspace_path.as_deref(),
        request.suggest_title,
        request.mode != ChatMode::Plan,
    );
    let permission_mcp_config = if request.mode != ChatMode::Plan && !request.full_access {
        let approval_nonce = active_provider_approval_nonce(app, &request.session_id)?;
        Some(desktop_claude_permission_mcp_config(
            request,
            &approval_nonce,
        )?)
    } else {
        None
    };
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
        &request.mode,
        request.require_command_approval,
        request.require_file_edit_approval,
        request.full_access,
        permission_mcp_config.as_deref(),
        &prompt,
    ));

    let output =
        run_streaming_command(
            process,
            Duration::from_secs(PROVIDER_CHAT_MAX_RUNTIME_SECS),
            Duration::from_secs(PROVIDER_CHAT_INACTIVITY_TIMEOUT_SECS),
            app,
            request,
        )
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
            activities: provider_activities_for_response(output.activities, &response),
            context_usage: None,
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

#[allow(clippy::too_many_arguments)]
fn codex_chat_args(
    resume_session_id: Option<&str>,
    output_path: &Path,
    model_id: Option<&str>,
    reasoning_effort: Option<&str>,
    mode: &ChatMode,
    require_command_approval: bool,
    require_file_edit_approval: bool,
    full_access: bool,
    attachments: &[ChatAttachmentRequest],
    prompt: &str,
) -> Vec<String> {
    let mut args = vec!["exec".into()];
    let full_access = *mode == ChatMode::Normal
        && full_access
        && !require_command_approval
        && !require_file_edit_approval;
    if resume_session_id.is_some() {
        args.push("resume".into());
    } else {
        args.push("--skip-git-repo-check".into());
        if full_access {
            args.push("--dangerously-bypass-approvals-and-sandbox".into());
        } else {
            args.extend(["--sandbox".into(), "read-only".into()]);
        }
    }
    args.push("--json".into());
    args.push("--output-last-message".into());
    args.push(output_path.display().to_string());
    if resume_session_id.is_some() {
        args.push("--skip-git-repo-check".into());
        if full_access {
            args.push("--dangerously-bypass-approvals-and-sandbox".into());
        } else {
            // `codex exec resume` does not accept the top-level `--sandbox`
            // option. Apply the same read-only policy through its supported
            // config override so Plan mode and approval-gated resumes start.
            args.extend(["--config".into(), "sandbox_mode=\"read-only\"".into()]);
        }
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
    for attachment in attachments.iter().filter(|item| item.kind == "image") {
        args.push("--image".into());
        args.push(attachment.path.clone());
    }
    // `codex exec --image <FILE>...` is variadic. Without an option terminator,
    // Clap can consume the chat prompt as another image path and then fall back
    // to an empty stdin stream.
    args.push("--".into());
    args.push(prompt.into());
    args
}

#[allow(clippy::too_many_arguments)]
fn claude_chat_args(
    resume_session_id: Option<&str>,
    session_id: &str,
    model_id: Option<&str>,
    mode: &ChatMode,
    require_command_approval: bool,
    require_file_edit_approval: bool,
    full_access: bool,
    permission_mcp_config: Option<&str>,
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
    if *mode == ChatMode::Plan {
        args.push("--permission-mode".into());
        args.push("plan".into());
    } else if let Some(permission_mcp_config) = permission_mcp_config {
        args.extend([
            "--setting-sources".into(),
            "".into(),
            "--mcp-config".into(),
            permission_mcp_config.into(),
            "--strict-mcp-config".into(),
            "--permission-prompt-tool".into(),
            "mcp__gyro_approval__approve".into(),
            "--allowedTools".into(),
            "mcp__gyro_approval__approve".into(),
            "--permission-mode".into(),
            "default".into(),
        ]);
    } else if full_access && !require_command_approval && !require_file_edit_approval {
        args.push("--dangerously-skip-permissions".into());
    }
    args.push(prompt.into());
    args
}

fn active_provider_approval_nonce(
    app: &tauri::AppHandle,
    session_id: &str,
) -> anyhow::Result<String> {
    app.state::<ProviderCancellationManager>()
        .flags
        .lock()
        .map_err(|_| anyhow::anyhow!("provider run state is unavailable"))?
        .get(session_id)
        .map(|control| control.approval_nonce.clone())
        .ok_or_else(|| anyhow::anyhow!("provider approval has no active run"))
}

fn provider_run_approval_matches(
    flags: &HashMap<String, Arc<ProviderRunControl>>,
    session_id: &str,
    approval_nonce: &str,
) -> bool {
    !approval_nonce.is_empty()
        && flags
            .get(session_id)
            .is_some_and(|control| control.approval_nonce == approval_nonce)
}

fn desktop_claude_permission_mcp_config(
    request: &ProviderChatRequest,
    approval_nonce: &str,
) -> anyhow::Result<String> {
    let executable = std::env::current_exe().context("resolve Gyro desktop permission bridge")?;
    serde_json::to_string(&serde_json::json!({
        "mcpServers": {
            "gyro_approval": {
                "type": "stdio",
                "command": executable,
                "args": ["provider-permission-server"],
                "env": {
                    "GYRO_DESKTOP_PERMISSION_SESSION_ID": request.session_id,
                    "GYRO_DESKTOP_PERMISSION_TURN_ID": request.turn_id.as_deref().unwrap_or(""),
                    "GYRO_DESKTOP_PERMISSION_RUN_NONCE": approval_nonce,
                    "GYRO_DESKTOP_PERMISSION_PROVIDER_ID": request.provider_id,
                    "GYRO_DESKTOP_PERMISSION_PROVIDER_LABEL": request.provider_label.as_deref().unwrap_or("Anthropic"),
                    "GYRO_DESKTOP_PERMISSION_REQUIRE_COMMAND": request.require_command_approval.to_string(),
                    "GYRO_DESKTOP_PERMISSION_REQUIRE_FILE": request.require_file_edit_approval.to_string(),
                }
            }
        }
    }))
    .context("encode Gyro desktop permission bridge config")
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
    model_label: Option<&str>,
    suggest_title: bool,
    allow_mutations: bool,
) -> String {
    let workspace = workspace_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .unwrap_or("no selected workspace");
    let model_label = model_label
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .unwrap_or("OpenAI model");
    let title_instruction = if suggest_title {
        "For this first turn, you may suggest a concise session title. If useful, put this exact hidden marker on the first line before the answer: GYRO_SESSION_TITLE: <2-6 word title>. The app hides this marker. Omit it if no good title is clear.\n"
    } else {
        ""
    };
    let mutation_instruction = if allow_mutations {
        "You may edit files, run commands, and complete requested workspace changes directly. Gyro applies approved file changes through its own guarded transaction. If a native file-change callback is declined, re-read the affected files before reporting the outcome: the user may have rejected it, or Gyro may already have applied the reviewed change. Report the actual on-disk state and do not claim failure from the callback decision alone."
    } else {
        "Do not edit files, start servers, commit, push, or make destructive changes in this chat run."
    };
    format!(
        "Answer as Gyro's chat model.\n\
         Keep replies concise, but structure informational answers as polished, scannable Markdown.\n\
         Start with the direct answer. Use short paragraphs, and use bullets or numbered lists when there are three or more distinct items, steps, or comparisons.\n\
         When the user asks for multiple named things, put each thing on its own bullet even if there are only two.\n\
         Use bold text sparingly for the terms that help scanning. Do not repeat the same conclusion in multiple forms.\n\
         Do not describe the local Codex runner, authentication, system prompts, or implementation details unless asked.\n\
         Your selected model label is: {model_label}.\n\
         If the user asks what model you are, answer with exactly that selected model label only.\n\
         {title_instruction}\
         Use the selected workspace only as optional context.\n\
         {mutation_instruction}\n\
         Selected workspace: {workspace}\n\n\
         User message:\n{message}"
    )
}

fn claude_chat_prompt(
    message: &str,
    workspace_path: Option<&str>,
    suggest_title: bool,
    allow_actions: bool,
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
    let action_instruction = if allow_actions {
        "Use tools when they are needed to complete the user's request. Commands and file changes must follow Gyro's permission decisions. If Gyro reports that it already applied reviewed file changes, do not retry the write; re-read the files and continue. Do not commit, push, or perform destructive actions unless the user explicitly asks.\n"
    } else {
        "Stay in planning mode. Do not edit files, run mutating commands, start servers, commit, push, or make destructive changes.\n"
    };
    format!(
        "Answer as Gyro's chat model.\n\
         Keep replies concise, but structure informational answers as polished, scannable Markdown.\n\
         Start with the direct answer. Use short paragraphs, and use bullets or numbered lists when there are three or more distinct items, steps, or comparisons.\n\
         When the user asks for multiple named things, put each thing on its own bullet even if there are only two.\n\
         Use bold text sparingly for the terms that help scanning. Do not repeat the same conclusion in multiple forms.\n\
         Do not describe the local Claude Code runner, authentication, system prompts, or implementation details unless asked.\n\
         If the user asks what model you are, answer with the model label only.\n\
         {title_instruction}\
         Use the selected workspace only as optional context.\n\
         {action_instruction}\
         Selected workspace: {workspace}\n\n\
         User message:\n{message}"
    )
}

struct SessionTitleExtraction {
    title: Option<String>,
    message: String,
}

struct PlanUpdateExtraction {
    payload: Option<serde_json::Value>,
    message: String,
}

fn extract_plan_update_marker(response: &str) -> PlanUpdateExtraction {
    let mut payload = None;
    let mut lines = Vec::new();
    for line in response.lines() {
        if let Some(encoded) = line.trim().strip_prefix("GYRO_PLAN_UPDATE:") {
            if payload.is_none() {
                payload = serde_json::from_str::<serde_json::Value>(encoded.trim())
                    .ok()
                    .filter(|value| value.is_object());
            }
            continue;
        }
        lines.push(line);
    }
    PlanUpdateExtraction {
        payload,
        message: lines.join("\n").trim().to_string(),
    }
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

fn derive_session_summary(response: &str) -> Option<String> {
    const MAX_SUMMARY_CHARS: usize = 420;
    let plain = response
        .lines()
        .map(str::trim)
        .filter(|line| {
            !line.is_empty()
                && !line.starts_with("GYRO_SESSION_TITLE:")
                && !line.starts_with("GYRO_PLAN_UPDATE:")
        })
        .map(|line| {
            line.trim_start_matches(['#', '-', '*', '>'])
                .trim()
                .replace('`', "")
        })
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if plain.is_empty() {
        return None;
    }
    let mut summary = plain.chars().take(MAX_SUMMARY_CHARS).collect::<String>();
    if plain.chars().count() > MAX_SUMMARY_CHARS {
        if let Some(boundary) = summary.rfind(char::is_whitespace) {
            summary.truncate(boundary);
        }
        summary.push_str("...");
    }
    Some(summary)
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
        if let Some(error) = error {
            let (recovery_kind, recovery_message) = provider_failure_recovery(error);
            object.insert(
                "recoveryKind".into(),
                serde_json::Value::String(recovery_kind.into()),
            );
            object.insert(
                "recoveryMessage".into(),
                serde_json::Value::String(recovery_message.into()),
            );
        }
        object.insert(
            "turnId".into(),
            turn_id
                .map(|id| serde_json::Value::String(id.to_string()))
                .unwrap_or(serde_json::Value::Null),
        );
        object.insert(
            "chatMode".into(),
            serde_json::Value::String(
                if request.mode == ChatMode::Plan {
                    "plan"
                } else {
                    "normal"
                }
                .into(),
            ),
        );
        object.insert(
            "goal".into(),
            serde_json::to_value(
                request
                    .goal
                    .as_ref()
                    .map(|goal| serde_json::json!({"text": goal.text, "status": goal.status})),
            )
            .unwrap_or(serde_json::Value::Null),
        );
        object.insert(
            "plan".into(),
            request.plan.clone().unwrap_or(serde_json::Value::Null),
        );
        object.insert(
            "attachments".into(),
            serde_json::to_value(&request.attachments).unwrap_or_else(|_| serde_json::json!([])),
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

fn provider_turn_has_unfinished_attempt(
    store: &SessionStore,
    session_id: Uuid,
    turn_id: Uuid,
) -> anyhow::Result<bool> {
    let last_status = store
        .read_recent_events(session_id, MAX_DESKTOP_SESSION_EVENTS_READ)?
        .into_iter()
        .filter(|event| {
            event.turn_id == Some(turn_id)
                && event
                    .payload
                    .get("kind")
                    .and_then(serde_json::Value::as_str)
                    == Some("provider-status")
        })
        .filter_map(|event| {
            event
                .payload
                .get("status")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .next_back();
    Ok(last_status.as_deref() == Some("running"))
}

fn provider_failure_recovery(error: &str) -> (&'static str, &'static str) {
    let normalized = error.to_ascii_lowercase();
    if normalized.contains("offline")
        || normalized.contains("network is unreachable")
        || normalized.contains("connection refused")
        || normalized.contains("could not resolve host")
        || normalized.contains("dns")
    {
        return (
            "offline",
            "Check your internet connection, then retry this message.",
        );
    }
    if normalized.contains("unauthorized")
        || normalized.contains("authentication")
        || normalized.contains("not logged in")
        || normalized.contains("login required")
        || normalized.contains("credential")
    {
        return (
            "authentication",
            "Reconnect this provider, then retry the message.",
        );
    }
    if normalized.contains("rate limit") || normalized.contains("too many requests") {
        return (
            "rate-limit",
            "Wait for the provider limit to reset, then retry.",
        );
    }
    (
        "retry",
        "Retry the message. Gyro will preserve the conversation context.",
    )
}

fn provider_activity_event_entry(
    request: &ProviderChatRequest,
    turn_id: Uuid,
    activity: &ProviderActivity,
) -> (String, serde_json::Value, Option<Uuid>) {
    let payload = serde_json::json!({
        "kind": "provider-activity",
        "activityId": activity.id,
        "activityKind": activity.kind,
        "label": activity.label,
        "detail": activity.detail,
        "status": activity.status,
        "providerId": request.provider_id,
        "modelId": request.model_id,
        "turnId": turn_id,
    });
    (activity.label.clone(), payload, Some(turn_id))
}

fn kimi_acp_plan_payload(activity: &ProviderActivity) -> Option<serde_json::Value> {
    if activity.kind != "plan" {
        return None;
    }
    let entries = serde_json::from_str::<serde_json::Value>(activity.detail.as_deref()?).ok()?;
    let items = entries
        .as_array()?
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let title = entry
                .get("title")
                .or_else(|| entry.get("content"))
                .or_else(|| entry.get("label"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("Plan step");
            let status = match entry
                .get("status")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("todo")
            {
                "completed" | "done" | "complete" => "complete",
                "in_progress" | "in-progress" | "running" => "in-progress",
                "blocked" => "blocked",
                _ => "todo",
            };
            serde_json::json!({
                "id": entry
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("kimi-plan-{index}")),
                "title": title,
                "status": status,
            })
        })
        .collect::<Vec<_>>();
    Some(serde_json::json!({
        "action": "replace",
        "title": "Plan",
        "providerId": "kimi",
        "items": items,
    }))
}

#[allow(clippy::too_many_arguments)]
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
    activities: Vec<ProviderActivity>,
    context_usage: Option<ProviderContextUsage>,
    status_success: bool,
    status_label: String,
    stdout: String,
    stderr: String,
    assistant_text: Option<String>,
    provider_session_id: Option<String>,
}

struct StreamingCommandState {
    activities: Vec<ProviderActivity>,
    context_usage: Option<ProviderContextUsage>,
    stdout_text: String,
    stdout_text_chars: usize,
    stdout_text_truncated: bool,
    assistant_text: String,
    assistant_text_chars: usize,
    assistant_text_truncated: bool,
    pending_delta_chunks: Vec<String>,
    pending_delta_chars: usize,
    provider_session_id: Option<String>,
    stdout_line_buffer: String,
    last_emit_at: Instant,
}

impl StreamingCommandState {
    fn new() -> Self {
        Self {
            activities: Vec::new(),
            context_usage: None,
            stdout_text: String::new(),
            stdout_text_chars: 0,
            stdout_text_truncated: false,
            assistant_text: String::new(),
            assistant_text_chars: 0,
            assistant_text_truncated: false,
            pending_delta_chunks: Vec::new(),
            pending_delta_chars: 0,
            provider_session_id: None,
            stdout_line_buffer: String::new(),
            last_emit_at: Instant::now(),
        }
    }

    fn push_activity(&mut self, activity: ProviderActivity) -> bool {
        if let Some(existing) = self
            .activities
            .iter_mut()
            .find(|existing| existing.id == activity.id)
        {
            if *existing == activity {
                return false;
            }
            *existing = activity;
            return true;
        }
        if self.activities.len() >= MAX_CODEX_APP_SERVER_ACTIVITIES {
            return false;
        }
        self.activities.push(activity);
        true
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

    fn take_stdout_lines(&mut self, chunk: &str) -> Vec<String> {
        self.push_stdout(chunk);
        self.stdout_line_buffer.push_str(chunk);
        let mut lines = Vec::new();
        while let Some(newline) = self.stdout_line_buffer.find('\n') {
            lines.push(self.stdout_line_buffer.drain(..=newline).collect());
        }
        if self.stdout_line_buffer.chars().count() > MAX_CHAT_RESPONSE_CHARS * 4 {
            self.stdout_line_buffer.clear();
        }
        lines
    }

    fn take_final_stdout_line(&mut self) -> Option<String> {
        (!self.stdout_line_buffer.is_empty()).then(|| std::mem::take(&mut self.stdout_line_buffer))
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

const PROVIDER_CHAT_MAX_RUNTIME_SECS: u64 = 24 * 60 * 60;
const PROVIDER_CHAT_INACTIVITY_TIMEOUT_SECS: u64 = 30 * 60;

fn run_streaming_command(
    command: Command,
    max_runtime: Duration,
    inactivity_timeout: Duration,
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
) -> anyhow::Result<StreamingCommandOutput> {
    let run_control = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .map_err(|_| anyhow::anyhow!("provider cancellation state is unavailable"))?
        .get(&request.session_id)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("provider turn reservation was lost"))?;
    let mut execution = ExecutionRequest::new(command.get_program().to_os_string());
    execution.args = command.get_args().map(|arg| arg.to_os_string()).collect();
    execution.current_dir = command.get_current_dir().map(Path::to_path_buf);
    execution.env = command
        .get_envs()
        .map(|(key, value)| (key.to_os_string(), value.map(|value| value.to_os_string())))
        .collect();
    execution.timeout = max_runtime;
    execution.inactivity_timeout = Some(inactivity_timeout);
    execution.max_stdout_chars = MAX_CHAT_RESPONSE_CHARS * 4;
    execution.max_stderr_chars = MAX_CHAT_RESPONSE_CHARS;
    let mut stream_state = StreamingCommandState::new();
    let outcome = gyro_core::run_command(execution, run_control.cancellation.clone(), |chunk| {
        if chunk.stream == ExecutionStream::Stdout {
            for line in stream_state.take_stdout_lines(&chunk.text) {
                handle_provider_stdout_line(&line, app, request, &mut stream_state);
            }
            stream_state.flush_pending_delta(app, request, false);
        }
    })?;
    if let Some(line) = stream_state.take_final_stdout_line() {
        handle_provider_stdout_line(&line, app, request, &mut stream_state);
    }
    stream_state.flush_pending_delta(app, request, true);
    match outcome.termination {
        ExecutionTermination::Cancelled => anyhow::bail!("chat cancelled by user"),
        ExecutionTermination::TimedOut => {
            anyhow::bail!(
                "provider reached the maximum runtime of {} seconds",
                max_runtime.as_secs()
            )
        }
        ExecutionTermination::Inactive => {
            anyhow::bail!(
                "no provider activity was received for {} seconds",
                inactivity_timeout.as_secs()
            )
        }
        ExecutionTermination::OutputLimit => {
            anyhow::bail!("provider exceeded Gyro's output activity limit")
        }
        ExecutionTermination::Exited { .. } => {}
    }
    let status_label = outcome
        .exit_code()
        .map(|code| format!("exit status: {code}"))
        .unwrap_or_else(|| "terminated by signal".into());
    Ok(StreamingCommandOutput {
        activities: stream_state.activities,
        context_usage: stream_state.context_usage,
        status_success: outcome.succeeded(),
        status_label,
        stdout: stream_state.stdout_text,
        stderr: outcome.stderr,
        assistant_text: (!stream_state.assistant_text.trim().is_empty())
            .then_some(stream_state.assistant_text),
        provider_session_id: stream_state.provider_session_id,
    })
}

fn provider_chat_cancelled(app: &tauri::AppHandle, session_id: &str) -> bool {
    app.state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .and_then(|flags| flags.get(session_id).cloned())
        .is_some_and(|control| control.cancellation.is_cancelled())
}

fn handle_provider_stdout_line(
    line: &str,
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    stream_state: &mut StreamingCommandState,
) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
        return;
    };
    if stream_state.provider_session_id.is_none() {
        stream_state.provider_session_id = extract_provider_session_id(&value);
    }
    if let Some(context_usage) = provider_context_usage_from_codex_exec(&value) {
        stream_state.context_usage = Some(context_usage);
    }
    if let Some(commentary) = extract_provider_commentary_activity(&value) {
        if stream_state.push_activity(commentary.clone()) {
            emit_provider_activity_event(app, request, &commentary);
        }
        return;
    }
    if let Some(activity) = extract_provider_activity(&value) {
        if stream_state.push_activity(activity.clone()) {
            emit_provider_activity_event(app, request, &activity);
        }
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

fn provider_context_usage_from_app_server(
    params: &serde_json::Value,
) -> Option<ProviderContextUsage> {
    let token_usage = params.get("tokenUsage")?;
    let last = token_usage.get("last")?;
    Some(ProviderContextUsage {
        input_tokens: last.get("inputTokens")?.as_u64()?,
        cached_input_tokens: last
            .get("cachedInputTokens")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or_default(),
        output_tokens: last
            .get("outputTokens")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or_default(),
        reasoning_output_tokens: last
            .get("reasoningOutputTokens")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or_default(),
        total_tokens: last
            .get("totalTokens")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or_default(),
        model_context_window: token_usage
            .get("modelContextWindow")
            .and_then(serde_json::Value::as_u64),
    })
}

fn provider_context_usage_from_codex_exec(
    value: &serde_json::Value,
) -> Option<ProviderContextUsage> {
    if value.get("type").and_then(serde_json::Value::as_str) != Some("turn.completed") {
        return None;
    }
    let usage = value.get("usage")?;
    Some(ProviderContextUsage {
        input_tokens: usage.get("input_tokens")?.as_u64()?,
        cached_input_tokens: usage
            .get("cached_input_tokens")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or_default(),
        output_tokens: usage
            .get("output_tokens")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or_default(),
        reasoning_output_tokens: usage
            .get("reasoning_output_tokens")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or_default(),
        total_tokens: usage
            .get("total_tokens")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or_default(),
        model_context_window: usage
            .get("model_context_window")
            .or_else(|| value.get("model_context_window"))
            .and_then(serde_json::Value::as_u64),
    })
}

fn extract_provider_commentary_activity(value: &serde_json::Value) -> Option<ProviderActivity> {
    let text = extract_codex_agent_message_text(value)?;
    if text.contains("GYRO_SESSION_TITLE:") {
        return None;
    }
    let item = value.get("item")?;
    let id = item
        .get("id")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| format!("commentary-{}", Uuid::new_v4()));
    Some(ProviderActivity {
        id,
        kind: "commentary".into(),
        label: sanitize_provider_text_delta(&text),
        detail: None,
        status: "done".into(),
    })
}

fn extract_provider_activity(value: &serde_json::Value) -> Option<ProviderActivity> {
    let event_type = value
        .get("type")
        .and_then(|item| item.as_str())
        .unwrap_or("");
    let nested_event = value.get("event").unwrap_or(value);
    let nested_type = nested_event
        .get("type")
        .and_then(|item| item.as_str())
        .unwrap_or(event_type);
    let item = value
        .get("item")
        .or_else(|| nested_event.get("item"))
        .or_else(|| nested_event.get("content_block"))?;
    let item_type = item.get("type").and_then(|value| value.as_str())?;
    let id = item
        .get("id")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .or_else(|| {
            nested_event
                .get("index")
                .and_then(|value| value.as_u64())
                .map(|index| format!("{item_type}-{index}"))
        })
        .unwrap_or_else(|| format!("{item_type}-{}", Uuid::new_v4()));
    let status = if event_type.contains("started")
        || nested_type.contains("start")
        || item.get("status").and_then(|value| value.as_str()) == Some("in_progress")
    {
        "running"
    } else if event_type.contains("failed")
        || nested_type.contains("error")
        || item.get("status").and_then(|value| value.as_str()) == Some("failed")
    {
        "failed"
    } else {
        "done"
    };

    let (kind, label, detail) = match item_type {
        "command_execution" | "command" => {
            let command = json_string_or_joined(item.get("command"))?;
            (
                "command".to_string(),
                command_activity_label(&command),
                Some(command),
            )
        }
        "file_change" | "file_edit" => {
            let path = provider_activity_path(item).unwrap_or_else(|| "workspace files".into());
            ("file".to_string(), format!("Updated {path}"), Some(path))
        }
        "mcp_tool_call" | "tool_use" | "tool_call" => {
            let name = item
                .get("name")
                .or_else(|| item.get("tool"))
                .and_then(|value| value.as_str())
                .unwrap_or("tool");
            (
                "tool".to_string(),
                format!("Used {}", humanize_activity_name(name)),
                Some(name.to_string()),
            )
        }
        "web_search" | "web_search_call" => {
            ("search".to_string(), "Searched the web".to_string(), None)
        }
        _ => return None,
    };

    Some(ProviderActivity {
        id,
        kind,
        label,
        detail,
        status: status.into(),
    })
}

fn json_string_or_joined(value: Option<&serde_json::Value>) -> Option<String> {
    match value? {
        serde_json::Value::String(value) => Some(value.clone()),
        serde_json::Value::Array(values) => {
            let joined = values
                .iter()
                .filter_map(|value| value.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            (!joined.is_empty()).then_some(joined)
        }
        _ => None,
    }
}

fn command_activity_label(command: &str) -> String {
    let normalized = command.to_ascii_lowercase();
    if normalized.contains("rg --files")
        || normalized.contains("find ")
        || normalized.contains(" ls ")
        || normalized.starts_with("ls ")
    {
        return "Listed files".into();
    }
    if normalized.contains(" rg ") || normalized.contains("rg -") || normalized.starts_with("rg ") {
        return "Searched project".into();
    }
    if normalized.contains("cat ")
        || normalized.contains("sed -n")
        || normalized.contains("head ")
        || normalized.contains("tail ")
    {
        if let Some(path) = command
            .split_whitespace()
            .rev()
            .map(|part| part.trim_matches(|ch: char| "'\";,()".contains(ch)))
            .find(|part| {
                part.contains('.') && !part.starts_with('-') && !part.chars().all(char::is_numeric)
            })
        {
            let file_name = Path::new(path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(path);
            return format!("Read {file_name}");
        }
        return "Read project files".into();
    }
    "Ran command".into()
}

fn provider_activity_path(item: &serde_json::Value) -> Option<String> {
    item.get("path")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .or_else(|| {
            item.get("changes")
                .and_then(|value| value.as_array())
                .and_then(|changes| changes.first())
                .and_then(|change| change.get("path"))
                .and_then(|value| value.as_str())
                .map(str::to_string)
        })
}

fn humanize_activity_name(value: &str) -> String {
    value
        .split(['_', '-'])
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn provider_activities_for_response(
    activities: Vec<ProviderActivity>,
    response: &str,
) -> Vec<ProviderActivity> {
    let response = response.trim();
    activities
        .into_iter()
        .filter(|activity| activity.kind != "commentary" || activity.label.trim() != response)
        .collect()
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
        sequence: next_provider_event_sequence(app, &request.session_id),
        phase: phase.into(),
        status: status.map(|status| status.as_str().to_string()),
        text_delta,
        activity_id: None,
        activity_kind: None,
        activity_label: None,
        activity_detail: None,
        activity_status: None,
        message,
        error,
    };
    let _ = app.emit(PROVIDER_CHAT_EVENT, payload);
}

fn emit_provider_activity_event(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    activity: &ProviderActivity,
) {
    let payload = ProviderChatStreamEvent {
        session_id: request.session_id.clone(),
        turn_id: request.turn_id.clone(),
        provider_id: request.provider_id.clone(),
        model_id: request.model_id.clone(),
        event_id: Uuid::new_v4().to_string(),
        sequence: next_provider_event_sequence(app, &request.session_id),
        phase: "activity".into(),
        status: Some(HarnessRunStatus::Running.as_str().to_string()),
        text_delta: None,
        activity_id: Some(activity.id.clone()),
        activity_kind: Some(activity.kind.clone()),
        activity_label: Some(activity.label.clone()),
        activity_detail: activity.detail.clone(),
        activity_status: Some(activity.status.clone()),
        message: None,
        error: None,
    };
    let _ = app.emit(PROVIDER_CHAT_EVENT, payload);
}

fn next_provider_event_sequence(app: &tauri::AppHandle, session_id: &str) -> u64 {
    app.state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .and_then(|flags| flags.get(session_id).cloned())
        .map(|control| control.next_event_sequence.fetch_add(1, Ordering::SeqCst))
        .unwrap_or_default()
}

fn extract_provider_session_id(value: &serde_json::Value) -> Option<String> {
    gyro_core::extract_provider_session_id(value)
}

type ProviderTextChunk = gyro_core::ProviderTextChunk;

#[cfg(test)]
fn extract_provider_text_delta(value: &serde_json::Value) -> Option<String> {
    extract_provider_text_chunk(value).map(|chunk| match chunk {
        ProviderTextChunk::Delta(text)
        | ProviderTextChunk::Snapshot(text)
        | ProviderTextChunk::Final(text) => text,
    })
}

fn extract_provider_text_chunk(value: &serde_json::Value) -> Option<ProviderTextChunk> {
    gyro_core::extract_provider_text_chunk(value)
}

fn extract_codex_agent_message_text(value: &serde_json::Value) -> Option<String> {
    gyro_core::extract_codex_agent_message_text(value)
}

fn provider_adapter_for(provider_id: &str) -> ProviderAdapterDescriptor {
    let Some(descriptor) = provider_descriptor(provider_id) else {
        return ProviderAdapterDescriptor {
            kind: ProviderAdapterKind::ReadinessOnly,
            runner: "readiness-only",
            auth_owner: "provider-owned",
            timeout_seconds: 0,
        };
    };
    let kind = match descriptor.execution_kind {
        ProviderExecutionKind::CodexCli => ProviderAdapterKind::OpenAiCodex,
        ProviderExecutionKind::ClaudeCode => ProviderAdapterKind::AnthropicClaude,
        ProviderExecutionKind::KimiAcp => ProviderAdapterKind::KimiAcp,
        ProviderExecutionKind::ReadinessOnly => ProviderAdapterKind::ReadinessOnly,
    };
    ProviderAdapterDescriptor {
        kind,
        runner: descriptor.runner,
        auth_owner: descriptor.auth_owner,
        timeout_seconds: if kind == ProviderAdapterKind::ReadinessOnly {
            0
        } else {
            PROVIDER_CHAT_INACTIVITY_TIMEOUT_SECS
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
    let resume_identity = normalized.contains("resume")
        || normalized.contains("session")
        || normalized.contains("thread");
    let missing_identity = normalized.contains("not found")
        || normalized.contains("no such")
        || normalized.contains("unknown")
        || normalized.contains("missing")
        || normalized.contains("expired")
        || normalized.contains("could not resume");
    resume_identity && missing_identity
}

fn command_with_gui_path(command: &str) -> Command {
    let mut process = Command::new(command);
    if !command.contains('/') {
        process.env("PATH", augmented_gui_path());
    }
    process
}

struct ProviderProcessGuard {
    child: Child,
}

impl ProviderProcessGuard {
    fn new(child: Child) -> Self {
        Self { child }
    }
}

impl std::ops::Deref for ProviderProcessGuard {
    type Target = Child;

    fn deref(&self) -> &Self::Target {
        &self.child
    }
}

impl std::ops::DerefMut for ProviderProcessGuard {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.child
    }
}

impl Drop for ProviderProcessGuard {
    fn drop(&mut self) {
        terminate_provider_process_group(&mut self.child);
    }
}

#[cfg(unix)]
fn configure_provider_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
}

#[cfg(not(unix))]
fn configure_provider_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn terminate_provider_process_group(child: &mut Child) {
    let process_group = -(child.id() as i32);
    unsafe {
        libc::kill(process_group, libc::SIGTERM);
    }
    for _ in 0..10 {
        let _ = child.try_wait();
        let group_exists = unsafe { libc::kill(process_group, 0) } == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
        if !group_exists {
            let _ = child.wait();
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    unsafe {
        libc::kill(process_group, libc::SIGKILL);
    }
    let _ = child.wait();
}

#[cfg(not(unix))]
fn terminate_provider_process_group(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn augmented_gui_path() -> String {
    let mut paths = std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| user_cli_paths(&home))
        .unwrap_or_default();
    paths.extend(
        std::env::var("PATH")
            .unwrap_or_default()
            .split(':')
            .filter(|path| !path.is_empty())
            .map(ToOwned::to_owned),
    );
    paths.extend(GUI_CLI_PATHS.iter().map(|path| (*path).to_string()));
    let mut seen = HashSet::new();
    paths.retain(|path| seen.insert(path.clone()));
    paths.join(":")
}

fn user_cli_paths(home: &Path) -> Vec<String> {
    let mut paths = vec![
        home.join(".local/bin"),
        home.join("bin"),
        home.join(".volta/bin"),
        home.join(".asdf/shims"),
        home.join(".local/share/mise/shims"),
        home.join(".bun/bin"),
        home.join(".cargo/bin"),
    ];
    let nvm_versions = home.join(".nvm/versions/node");
    let mut nvm_bins = fs::read_dir(nvm_versions)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();
    nvm_bins.sort_by_key(|path| std::cmp::Reverse(node_version_key(path)));
    paths.extend(nvm_bins.into_iter().map(|path| path.join("bin")));
    paths
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

fn node_version_key(path: &Path) -> (u64, u64, u64) {
    let version = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .trim_start_matches('v');
    let mut parts = version
        .split('.')
        .map(|part| part.parse::<u64>().unwrap_or_default());
    (
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
    )
}

fn spawn_terminal_reader<R>(reader: R, output: Arc<Mutex<TerminalOutputBuffer>>)
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

fn append_terminal_output(output: &Arc<Mutex<TerminalOutputBuffer>>, bytes: &[u8]) {
    if bytes.is_empty() {
        return;
    }
    let Ok(mut output) = output.lock() else {
        return;
    };
    output.revision = output.revision.wrapping_add(1).max(1);
    if bytes.len() >= MAX_TERMINAL_OUTPUT_BYTES {
        output.bytes.clear();
        output.bytes.extend(
            bytes[bytes.len() - MAX_TERMINAL_OUTPUT_BYTES..]
                .iter()
                .copied(),
        );
        return;
    }
    let overflow = output
        .bytes
        .len()
        .saturating_add(bytes.len())
        .saturating_sub(MAX_TERMINAL_OUTPUT_BYTES);
    if overflow > 0 {
        output.bytes.drain(..overflow);
    }
    output.bytes.extend(bytes.iter().copied());
}

fn snapshot_terminal_process(
    process: &mut TerminalProcess,
    known_output_revision: Option<u64>,
) -> TerminalPaneSnapshot {
    match process.child.try_wait() {
        Ok(Some(status)) => {
            process.exit_code = Some(status.exit_code() as i32);
            process.terminated = true;
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

    let (output, output_revision) = process
        .output
        .lock()
        .map(|value| snapshot_terminal_output(&value, known_output_revision))
        .unwrap_or((None, 0));
    TerminalPaneSnapshot {
        pane_id: process.request.pane_id.clone(),
        title: process.request.title.clone(),
        profile_id: process.request.profile_id.clone(),
        command: std::iter::once(process.request.command.as_str())
            .chain(process.request.args.iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join(" "),
        output,
        output_revision,
        status: process.status.clone(),
        exit_code: process.exit_code,
        workspace_path: process.request.workspace_path.clone(),
        working_directory: process
            .working_directory
            .as_ref()
            .map(|path| path.display().to_string()),
        cols: process.cols,
        rows: process.rows,
    }
}

fn snapshot_terminal_output(
    output: &TerminalOutputBuffer,
    known_output_revision: Option<u64>,
) -> (Option<String>, u64) {
    let text = (known_output_revision != Some(output.revision))
        .then(|| terminal_output_text(&output.bytes));
    (text, output.revision)
}

fn terminal_output_text(output: &VecDeque<u8>) -> String {
    let (first, second) = output.as_slices();
    if second.is_empty() {
        return String::from_utf8_lossy(first).into_owned();
    }
    let mut bytes = Vec::with_capacity(output.len());
    bytes.extend_from_slice(first);
    bytes.extend_from_slice(second);
    String::from_utf8_lossy(&bytes).into_owned()
}

struct DesktopProviderPermissionContext {
    session_id: String,
    turn_id: Option<String>,
    run_nonce: String,
    provider_id: String,
    provider_label: Option<String>,
    require_command_approval: bool,
    require_file_edit_approval: bool,
}

impl DesktopProviderPermissionContext {
    fn from_env() -> anyhow::Result<Self> {
        Ok(Self {
            session_id: desktop_permission_env("GYRO_DESKTOP_PERMISSION_SESSION_ID")?,
            turn_id: std::env::var("GYRO_DESKTOP_PERMISSION_TURN_ID")
                .ok()
                .filter(|value| !value.trim().is_empty()),
            run_nonce: desktop_permission_env("GYRO_DESKTOP_PERMISSION_RUN_NONCE")?,
            provider_id: desktop_permission_env("GYRO_DESKTOP_PERMISSION_PROVIDER_ID")?,
            provider_label: std::env::var("GYRO_DESKTOP_PERMISSION_PROVIDER_LABEL")
                .ok()
                .filter(|value| !value.trim().is_empty()),
            require_command_approval: desktop_permission_env_bool(
                "GYRO_DESKTOP_PERMISSION_REQUIRE_COMMAND",
            )?,
            require_file_edit_approval: desktop_permission_env_bool(
                "GYRO_DESKTOP_PERMISSION_REQUIRE_FILE",
            )?,
        })
    }
}

fn desktop_permission_env(name: &str) -> anyhow::Result<String> {
    std::env::var(name)
        .with_context(|| format!("missing desktop provider permission context {name}"))
}

fn desktop_permission_env_bool(name: &str) -> anyhow::Result<bool> {
    match desktop_permission_env(name)?.as_str() {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => anyhow::bail!("invalid desktop provider permission flag {name}"),
    }
}

fn desktop_permission_tool_call(
    paths: &GyroPaths,
    context: &DesktopProviderPermissionContext,
    params: serde_json::Value,
) -> anyhow::Result<serde_json::Value> {
    if params.get("name").and_then(serde_json::Value::as_str) != Some("approve") {
        anyhow::bail!("unknown Gyro desktop approval tool");
    }
    let arguments = params.get("arguments").cloned().unwrap_or_default();
    let tool_name = arguments
        .get("tool_name")
        .or_else(|| arguments.get("toolName"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let input = arguments
        .get("input")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let request = DesktopProviderApprovalRequest {
        schema: DESKTOP_PROVIDER_APPROVAL_IPC_SCHEMA_V1.into(),
        sender_version: env!("CARGO_PKG_VERSION").into(),
        session_id: context.session_id.clone(),
        turn_id: context.turn_id.clone(),
        run_nonce: context.run_nonce.clone(),
        provider_id: context.provider_id.clone(),
        provider_label: context.provider_label.clone(),
        tool_name,
        input: input.clone(),
        permission_suggestions: arguments
            .get("permission_suggestions")
            .or_else(|| arguments.get("permissionSuggestions"))
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
        require_command_approval: context.require_command_approval,
        require_file_edit_approval: context.require_file_edit_approval,
    };
    let response = request_desktop_provider_approval(paths, &request).unwrap_or_else(|error| {
        DesktopProviderApprovalResponse::deny(format!(
            "Gyro denied this provider action because desktop approval was unavailable: {}",
            gyro_core::sanitize_harness_text(&error.to_string())
        ))
    });
    let permission_result = match response.behavior {
        DesktopProviderApprovalBehavior::Allow => serde_json::json!({
            "behavior": "allow",
            "updatedInput": response.updated_input.unwrap_or(input),
            "message": response.message,
        }),
        DesktopProviderApprovalBehavior::Deny => serde_json::json!({
            "behavior": "deny",
            "message": response.message,
        }),
    };
    Ok(serde_json::json!({
        "content": [{
            "type": "text",
            "text": serde_json::to_string(&permission_result)?,
        }],
        "isError": false,
    }))
}

fn write_desktop_mcp_message(
    output: &mut impl Write,
    message: &serde_json::Value,
) -> anyhow::Result<()> {
    write_bounded_json_line(output, message, MAX_PERMISSION_MCP_MESSAGE_BYTES)
        .map_err(anyhow::Error::msg)
}

pub fn run_provider_permission_server() -> anyhow::Result<()> {
    let context = DesktopProviderPermissionContext::from_env()?;
    let paths = GyroPaths::for_current_user()?;
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    let mut stdin = stdin.lock();
    while let Some(line) = read_bounded_protocol_line(&mut stdin, MAX_PERMISSION_MCP_MESSAGE_BYTES)
        .map_err(anyhow::Error::msg)?
    {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let request: serde_json::Value = match serde_json::from_slice(&line) {
            Ok(request) => request,
            Err(error) => {
                write_desktop_mcp_message(
                    &mut stdout,
                    &serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": null,
                        "error": { "code": -32700, "message": error.to_string() },
                    }),
                )?;
                continue;
            }
        };
        let Some(method) = request.get("method").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let Some(id) = request.get("id").cloned() else {
            continue;
        };
        let result = match method {
            "initialize" => Ok(serde_json::json!({
                "protocolVersion": request
                    .pointer("/params/protocolVersion")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("2024-11-05"),
                "capabilities": { "tools": {} },
                "serverInfo": {
                    "name": "gyro-desktop-approval",
                    "version": env!("CARGO_PKG_VERSION"),
                },
            })),
            "ping" => Ok(serde_json::json!({})),
            "tools/list" => Ok(serde_json::json!({
                "tools": [{
                    "name": "approve",
                    "description": "Ask Gyro.app to approve or reject one Claude Code tool action.",
                    "inputSchema": {
                        "type": "object",
                        "additionalProperties": true,
                    },
                }],
            })),
            "tools/call" => desktop_permission_tool_call(
                &paths,
                &context,
                request.get("params").cloned().unwrap_or_default(),
            ),
            _ => Err(anyhow::anyhow!("unsupported MCP method `{method}`")),
        };
        match result {
            Ok(result) => write_desktop_mcp_message(
                &mut stdout,
                &serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            )?,
            Err(error) => write_desktop_mcp_message(
                &mut stdout,
                &serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {
                        "code": -32603,
                        "message": gyro_core::sanitize_harness_text(&error.to_string()),
                    },
                }),
            )?,
        }
    }
    Ok(())
}

pub fn run_entrypoint() {
    if std::env::args().nth(1).as_deref() == Some("provider-permission-server") {
        if let Err(error) = run_provider_permission_server() {
            eprintln!(
                "Gyro desktop permission bridge failed: {}",
                gyro_core::sanitize_harness_text(&error.to_string())
            );
            std::process::exit(1);
        }
        return;
    }
    run();
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(TerminalProcessManager::default())
        .manage(LanguageServerManager::default())
        .manage(DebugAdapterManager::default())
        .manage(ProviderCancellationManager::default())
        .manage(ProviderApprovalManager::default())
        .manage(WorkspaceWatchManager::default())
        .manage(AutomationSchedulerControl::default())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            restore_main_window(app.handle())?;
            let paths = GyroPaths::for_current_user()?;
            let store = SessionStore::open(paths.clone())?;
            recover_provider_mutation_transactions(&paths.mutation_journals_dir, &store)?;
            start_cli_ipc_listener(app.handle().clone());
            start_automation_scheduler(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Err(error) = window.hide() {
                    eprintln!("could not hide Gyro window: {error}");
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            append_chat_context_event,
            append_editor_event,
            append_plan_event,
            append_user_message,
            claim_due_automation,
            check_provider_auth,
            check_browser_preview,
            check_provider_health,
            capture_browser_preview,
            complete_automation_lease,
            close_terminal_pane,
            create_automation,
            create_desktop_session,
            create_file_mutation_proposal,
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
            get_notification_permission,
            get_provider_usage,
            git_commit,
            git_branches,
            git_checkout_branch,
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
            prepare_chat_attachment,
            restart_app,
            recover_automation_leases,
            rename_session,
            rename_workspace_path,
            refresh_account_session,
            resize_terminal_pane,
            resolve_file_mutation_proposal,
            resolve_provider_approval,
            restart_terminal_pane,
            restore_terminal_panes,
            run_automation,
            run_provider_chat,
            save_config,
            search_workspace,
            set_session_model,
            set_session_branch,
            set_automation_status,
            stat_workspace_file,
            start_account_login,
            stop_terminal_pane,
            stop_provider_chat,
            terminal_pane_has_foreground_job,
            task_discover,
            task_run,
            test_discover,
            test_notification,
            test_run,
            triage_automation,
            watch_workspace,
            write_workspace_file,
            write_terminal_input
        ])
        .build(tauri::generate_context!())
        .expect("error while building Gyro");

    app.run(|app, event| {
        if run_event_wakes_automation_scheduler(&event) {
            app.state::<AutomationSchedulerControl>().wake();
        }
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen {
            has_visible_windows,
            ..
        } = &event
        {
            if !*has_visible_windows {
                if let Err(error) = restore_main_window(app) {
                    eprintln!("could not reopen Gyro window: {error}");
                }
            }
        }
    });
}

fn run_event_wakes_automation_scheduler(event: &tauri::RunEvent) -> bool {
    matches!(event, tauri::RunEvent::Resumed)
}

#[cfg(target_os = "macos")]
fn restore_main_window(app: &tauri::AppHandle) -> anyhow::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
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
    window.show()?;
    window.set_focus()?;
    Ok(())
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
fn bind_cli_ipc_listener(
    paths: &GyroPaths,
) -> anyhow::Result<Option<std::os::unix::net::UnixListener>> {
    use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
    use std::os::unix::net::{UnixListener, UnixStream};

    let bind = || UnixListener::bind(&paths.socket_path);
    let listener = match bind() {
        Ok(listener) => listener,
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
            let before = fs::symlink_metadata(&paths.socket_path)
                .with_context(|| format!("inspect {}", paths.socket_path.display()))?;
            if before.file_type().is_symlink() || !before.file_type().is_socket() {
                anyhow::bail!(
                    "Gyro IPC path is not a safe Unix socket: {}",
                    paths.socket_path.display()
                );
            }
            if UnixStream::connect(&paths.socket_path).is_ok() {
                return Ok(None);
            }
            let after = fs::symlink_metadata(&paths.socket_path)
                .with_context(|| format!("reinspect {}", paths.socket_path.display()))?;
            if before.dev() != after.dev()
                || before.ino() != after.ino()
                || after.file_type().is_symlink()
                || !after.file_type().is_socket()
            {
                anyhow::bail!("Gyro IPC socket changed while checking whether it was stale");
            }
            fs::remove_file(&paths.socket_path)
                .with_context(|| format!("remove stale {}", paths.socket_path.display()))?;
            bind().with_context(|| format!("bind {}", paths.socket_path.display()))?
        }
        Err(error) => {
            return Err(error).with_context(|| format!("bind {}", paths.socket_path.display()))
        }
    };
    fs::set_permissions(&paths.socket_path, fs::Permissions::from_mode(0o600))?;
    Ok(Some(listener))
}

#[cfg(unix)]
fn handle_cli_ipc_connection(app: &tauri::AppHandle, stream: std::os::unix::net::UnixStream) {
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

fn write_bounded_json_line(
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_tree_entries_are_sorted_depth_first() {
        let mut files = vec![
            WorkspaceFile {
                path: "root.txt".into(),
                kind: "file".into(),
                depth: 1,
            },
            WorkspaceFile {
                path: "apps/desktop".into(),
                kind: "directory".into(),
                depth: 2,
            },
            WorkspaceFile {
                path: "docs".into(),
                kind: "directory".into(),
                depth: 1,
            },
            WorkspaceFile {
                path: "apps/a.ts".into(),
                kind: "file".into(),
                depth: 2,
            },
            WorkspaceFile {
                path: "apps".into(),
                kind: "directory".into(),
                depth: 1,
            },
            WorkspaceFile {
                path: "Cargo.toml".into(),
                kind: "file".into(),
                depth: 1,
            },
            WorkspaceFile {
                path: "apps/desktop/main.ts".into(),
                kind: "file".into(),
                depth: 3,
            },
            WorkspaceFile {
                path: "apps/z.ts".into(),
                kind: "file".into(),
                depth: 2,
            },
        ];

        files.sort_by(compare_workspace_tree_entries);

        assert_eq!(
            files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            vec![
                "apps",
                "apps/desktop",
                "apps/desktop/main.ts",
                "apps/a.ts",
                "apps/z.ts",
                "docs",
                "Cargo.toml",
                "root.txt",
            ]
        );
    }

    fn anthropic_provider_request() -> ProviderChatRequest {
        ProviderChatRequest {
            session_id: Uuid::new_v4().to_string(),
            message: "edit it".into(),
            turn_id: Some(Uuid::new_v4().to_string()),
            provider_id: "anthropic".into(),
            provider_label: Some("Anthropic".into()),
            model_id: Some("sonnet".into()),
            model_label: Some("Claude Sonnet".into()),
            reasoning_effort: None,
            require_command_approval: true,
            require_file_edit_approval: true,
            full_access: false,
            suggest_title: false,
            workspace_path: Some("/tmp/gyro-workspace".into()),
            mode: ChatMode::Normal,
            goal: None,
            plan: None,
            attachments: Vec::new(),
        }
    }

    #[test]
    fn gyro_applied_file_changes_are_not_applied_again_by_codex() {
        assert_eq!(
            codex_provider_approval_response(ProviderApprovalDecision::AppliedByGyro),
            "decline"
        );
        assert_eq!(
            codex_provider_approval_response(ProviderApprovalDecision::Approve),
            "accept"
        );
    }

    #[test]
    fn gyro_applied_file_changes_are_not_applied_again_by_claude() {
        let response = desktop_claude_approval_response(
            ProviderApprovalDecision::AppliedByGyro,
            serde_json::json!({ "file_path": "src/main.rs" }),
        );

        assert_eq!(response.behavior, DesktopProviderApprovalBehavior::Deny);
        assert!(response.updated_input.is_none());
        assert!(response.message.contains("already applied"));
    }

    #[test]
    fn desktop_claude_mcp_config_uses_the_installed_binary_and_gated_context() {
        let request = anthropic_provider_request();
        let config: serde_json::Value = serde_json::from_str(
            &desktop_claude_permission_mcp_config(&request, "test-run-nonce").unwrap(),
        )
        .unwrap();
        let server = &config["mcpServers"]["gyro_approval"];

        assert!(server["command"]
            .as_str()
            .is_some_and(|command| !command.trim().is_empty()));
        assert_eq!(
            server["args"],
            serde_json::json!(["provider-permission-server"])
        );
        assert_eq!(
            server["env"]["GYRO_DESKTOP_PERMISSION_SESSION_ID"],
            request.session_id
        );
        assert_eq!(
            server["env"]["GYRO_DESKTOP_PERMISSION_REQUIRE_FILE"],
            "true"
        );
        assert_eq!(
            server["env"]["GYRO_DESKTOP_PERMISSION_RUN_NONCE"],
            "test-run-nonce"
        );
    }

    #[test]
    fn provider_approval_nonce_is_bound_to_the_active_session_run() {
        let session_id = Uuid::new_v4().to_string();
        let control = Arc::new(ProviderRunControl::default());
        let expected_nonce = control.approval_nonce.clone();
        let flags = HashMap::from([(session_id.clone(), control)]);

        assert!(provider_run_approval_matches(
            &flags,
            &session_id,
            &expected_nonce
        ));
        assert!(!provider_run_approval_matches(
            &flags,
            &session_id,
            "forged-nonce"
        ));
        assert!(!provider_run_approval_matches(&flags, &session_id, ""));
        assert!(!provider_run_approval_matches(
            &flags,
            "another-session",
            &expected_nonce
        ));
    }

    #[test]
    fn desktop_claude_prompt_allows_approved_actions_but_plan_mode_stays_read_only() {
        let actionable = claude_chat_prompt("edit it", Some("/tmp/project"), false, true);
        assert!(actionable.contains("must follow Gyro's permission decisions"));
        assert!(actionable.contains("do not retry the write"));
        assert!(!actionable.contains("Stay in planning mode"));

        let plan = claude_chat_prompt("plan it", Some("/tmp/project"), false, false);
        assert!(plan.contains("Stay in planning mode"));
        assert!(plan.contains("Do not edit files"));
    }

    #[test]
    fn desktop_claude_approval_events_summarize_large_file_content() {
        let request = DesktopProviderApprovalRequest {
            schema: DESKTOP_PROVIDER_APPROVAL_IPC_SCHEMA_V1.into(),
            sender_version: env!("CARGO_PKG_VERSION").into(),
            session_id: Uuid::new_v4().to_string(),
            turn_id: Some(Uuid::new_v4().to_string()),
            run_nonce: "test-run-nonce".into(),
            provider_id: "anthropic".into(),
            provider_label: Some("Anthropic".into()),
            tool_name: "Write".into(),
            input: serde_json::json!({
                "file_path": "large.txt",
                "content": format!("secret-provider-token{}", "x".repeat(200_000)),
            }),
            permission_suggestions: serde_json::json!([]),
            require_command_approval: true,
            require_file_edit_approval: true,
        };

        let details = desktop_claude_approval_details(&request, Path::new("/tmp/project"));
        let encoded = serde_json::to_vec(&details).unwrap();

        assert!(encoded.len() < 32 * 1024);
        assert_eq!(details["patch"]["changes"][0]["path"], "large.txt");
        assert_eq!(details["input"]["operation"], "Write");
        assert_eq!(details["input"]["contentBytes"], 200_021);
        assert!(!String::from_utf8(encoded)
            .unwrap()
            .contains("secret-provider-token"));
    }

    #[test]
    fn desktop_claude_permission_child_fails_closed_without_the_app() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let context = DesktopProviderPermissionContext {
            session_id: Uuid::new_v4().to_string(),
            turn_id: Some(Uuid::new_v4().to_string()),
            run_nonce: "test-run-nonce".into(),
            provider_id: "anthropic".into(),
            provider_label: Some("Anthropic".into()),
            require_command_approval: true,
            require_file_edit_approval: true,
        };

        let result = desktop_permission_tool_call(
            &paths,
            &context,
            serde_json::json!({
                "name": "approve",
                "arguments": {
                    "tool_name": "Bash",
                    "input": { "command": "echo hello" },
                },
            }),
        )
        .unwrap();
        let permission: serde_json::Value =
            serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();

        assert_eq!(permission["behavior"], "deny");
        assert!(permission["message"]
            .as_str()
            .unwrap()
            .contains("approval was unavailable"));
    }

    #[cfg(unix)]
    #[test]
    fn desktop_claude_permission_child_forwards_tool_context_to_the_app() {
        use std::os::unix::net::UnixListener;

        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        std::fs::create_dir_all(paths.socket_path.parent().unwrap()).unwrap();
        let listener = UnixListener::bind(&paths.socket_path).unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut line = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut line)
                .unwrap();
            let request: DesktopProviderApprovalRequest = serde_json::from_str(&line).unwrap();
            assert_eq!(request.provider_id, "anthropic");
            assert_eq!(request.tool_name, "Write");
            assert_eq!(request.input["file_path"], "src/main.rs");
            let mut stream = stream;
            serde_json::to_writer(
                &mut stream,
                &DesktopProviderApprovalResponse::deny("Reviewed and rejected"),
            )
            .unwrap();
            stream.write_all(b"\n").unwrap();
            stream.flush().unwrap();
        });
        let context = DesktopProviderPermissionContext {
            session_id: Uuid::new_v4().to_string(),
            turn_id: Some(Uuid::new_v4().to_string()),
            run_nonce: "test-run-nonce".into(),
            provider_id: "anthropic".into(),
            provider_label: Some("Anthropic".into()),
            require_command_approval: true,
            require_file_edit_approval: true,
        };

        let result = desktop_permission_tool_call(
            &paths,
            &context,
            serde_json::json!({
                "name": "approve",
                "arguments": {
                    "tool_name": "Write",
                    "input": { "file_path": "src/main.rs", "content": "fn main() {}\n" },
                },
            }),
        )
        .unwrap();
        let permission: serde_json::Value =
            serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();

        assert_eq!(permission["behavior"], "deny");
        assert_eq!(permission["message"], "Reviewed and rejected");
        server.join().unwrap();
    }

    #[test]
    fn codex_usage_windows_follow_reported_duration_instead_of_slot() {
        let windows = provider_usage_windows_from_codex(&CodexRateLimitSnapshot {
            primary: Some(CodexRateLimitWindow {
                used_percent: 29,
                window_duration_mins: Some(10_080),
                resets_at: Some(1_784_489_840),
            }),
            secondary: None,
        });

        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].id, "weekly");
        assert_eq!(windows[0].label, "Weekly window");
        assert_eq!(windows[0].used_percent, 29);
        assert!(windows[0]
            .resets_at
            .as_deref()
            .is_some_and(|value| { chrono::DateTime::parse_from_rfc3339(value).is_ok() }));
    }

    #[test]
    fn codex_usage_windows_are_clamped_ordered_and_deduplicated() {
        let windows = provider_usage_windows_from_codex(&CodexRateLimitSnapshot {
            primary: Some(CodexRateLimitWindow {
                used_percent: 140,
                window_duration_mins: Some(300),
                resets_at: None,
            }),
            secondary: Some(CodexRateLimitWindow {
                used_percent: -5,
                window_duration_mins: Some(10_080),
                resets_at: None,
            }),
        });

        assert_eq!(
            windows
                .iter()
                .map(|window| window.id.as_str())
                .collect::<Vec<_>>(),
            vec!["five-hour", "weekly"]
        );
        assert_eq!(windows[0].used_percent, 100);
        assert_eq!(windows[1].used_percent, 0);
    }

    #[test]
    fn codex_app_server_errors_are_exposed_without_protocol_details() {
        let error = codex_app_server_result(&serde_json::json!({
            "id": 2,
            "error": { "code": -32603, "message": "Login required" },
        }))
        .unwrap_err();

        assert_eq!(error, "Login required");
    }

    #[test]
    #[ignore = "requires a locally authenticated Codex CLI"]
    fn live_codex_provider_usage_reads_the_current_account() {
        let snapshot = get_provider_usage_blocking("openai").unwrap();

        assert_eq!(snapshot.provider_id, "openai");
        assert!(!snapshot.windows.is_empty());
        assert!(snapshot
            .windows
            .iter()
            .all(|window| (0..=100).contains(&window.used_percent)));
    }

    #[test]
    fn browser_preview_check_reports_reachable_http_and_rejects_other_schemes() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request);
            stream
                .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                .unwrap();
        });

        let reachable = check_browser_preview_blocking(BrowserPreviewCheckRequest {
            url: format!("http://{address}/health"),
        })
        .unwrap();
        server.join().unwrap();
        assert!(reachable.reachable);
        assert_eq!(reachable.status_code, Some(204));
        assert!(reachable.message.contains("HTTP 204"));
        assert!(reachable.diagnostics_supported);
        assert!(!reachable.diagnostics_captured);
        assert!(reachable.diagnostics.is_empty());

        let rejected = check_browser_preview_blocking(BrowserPreviewCheckRequest {
            url: "file:///tmp/private".into(),
        })
        .unwrap_err();
        assert!(rejected.contains("http or https"));
        let rejected = check_browser_preview_blocking(BrowserPreviewCheckRequest {
            url: "https://example.com".into(),
        })
        .unwrap_err();
        assert!(rejected.contains("localhost or a loopback"));
        let rejected = check_browser_preview_blocking(BrowserPreviewCheckRequest {
            url: "http://user:secret@localhost:3000".into(),
        })
        .unwrap_err();
        assert!(rejected.contains("credentials"));
        assert!(!browser_preview_diagnostics_supported(
            &url::Url::parse("https://example.com").unwrap()
        ));
        assert!(browser_preview_diagnostics_supported(
            &url::Url::parse("http://[::1]:3000").unwrap()
        ));
    }

    #[test]
    fn browser_preview_diagnostics_are_bounded_redacted_and_query_free() {
        let prefix = "gyro-browser-diagnostics:test:";
        let script = browser_preview_capture_script(prefix).unwrap();
        assert!(script.contains("console.error"));
        assert!(script.contains("unhandledrejection"));
        assert!(script.contains(prefix));
        assert!(!script.contains("__TAURI__"));

        let payload = serde_json::json!([
            {
                "kind": "console-error",
                "message": "request failed api_key=sk-browser-secret",
                "source": "http://localhost:3000/src/app.ts?token=private#frame",
                "line": 12,
                "column": 4
            },
            {
                "kind": "unexpected",
                "message": "fallback kind",
                "source": null,
                "line": null,
                "column": null
            }
        ]);
        let title = format!("{prefix}{payload}");
        let diagnostics = parse_browser_preview_diagnostics(prefix, &title).unwrap();
        assert_eq!(diagnostics.len(), 2);
        assert_eq!(diagnostics[0].kind, "console-error");
        assert!(!diagnostics[0].message.contains("sk-browser-secret"));
        assert_eq!(diagnostics[0].source.as_deref(), Some("/src/app.ts"));
        assert_eq!(diagnostics[1].kind, "page-error");
    }

    #[test]
    fn browser_preview_capture_dimensions_are_fixed_and_validated() {
        assert_eq!(
            browser_preview_capture_dimensions("desktop").unwrap(),
            (1440, 900)
        );
        assert_eq!(
            browser_preview_capture_dimensions("tablet").unwrap(),
            (834, 1112)
        );
        assert_eq!(
            browser_preview_capture_dimensions("mobile").unwrap(),
            (390, 844)
        );
        assert!(browser_preview_capture_dimensions("watch").is_err());
    }

    #[test]
    fn browser_preview_captures_are_private_and_pruned() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let png = b"\x89PNG\r\n\x1a\nlocal-preview";
        let start = chrono::Utc::now();
        let mut latest = None;
        for offset in 0..(MAX_BROWSER_PREVIEW_CAPTURES + 2) {
            latest = Some(
                persist_browser_preview_capture(
                    &paths,
                    png,
                    390,
                    844,
                    start + chrono::Duration::milliseconds(offset as i64),
                )
                .unwrap(),
            );
        }

        let captures = fs::read_dir(&paths.browser_captures_dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".png"))
            .collect::<Vec<_>>();
        assert_eq!(captures.len(), MAX_BROWSER_PREVIEW_CAPTURES);
        assert!(Path::new(&latest.unwrap().path).exists());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let directory_mode = fs::metadata(&paths.browser_captures_dir)
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            let capture_mode = captures[0].metadata().unwrap().permissions().mode() & 0o777;
            assert_eq!(directory_mode, 0o700);
            assert_eq!(capture_mode, 0o600);
        }
    }

    #[test]
    fn browser_preview_capture_rejects_invalid_png_data() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let error =
            persist_browser_preview_capture(&paths, b"not an image", 1440, 900, chrono::Utc::now())
                .unwrap_err();
        assert!(error.contains("valid PNG"));
        assert!(!paths.browser_captures_dir.exists());
    }

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
    fn lsp_json_rpc_framing_rejects_oversized_headers() {
        let framed = format!("X-Fill: {}", "x".repeat(MAX_LSP_HEADER_BYTES + 1));
        let error = read_lsp_message(&mut BufReader::new(framed.as_bytes())).unwrap_err();
        assert!(error.to_string().contains("headers exceed size limit"));
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
    fn workspace_watch_cache_reuses_stable_tree_and_invalidates_on_directory_change() {
        let workspace = tempfile::tempdir().unwrap();
        let nested = workspace.path().join("nested");
        fs::create_dir(&nested).unwrap();
        fs::write(nested.join("first.txt"), "one\n").unwrap();
        let manager = WorkspaceWatchManager::default();

        let first = manager
            .snapshot(workspace.path().to_str().unwrap())
            .unwrap();
        let cached = manager
            .snapshot(workspace.path().to_str().unwrap())
            .unwrap();
        assert_eq!(
            first.iter().map(|file| &file.path).collect::<Vec<_>>(),
            cached.iter().map(|file| &file.path).collect::<Vec<_>>()
        );

        fs::remove_dir_all(&nested).unwrap();
        fs::write(workspace.path().join("second.txt"), "two\n").unwrap();
        let changed = manager
            .snapshot(workspace.path().to_str().unwrap())
            .unwrap();
        assert!(changed.iter().any(|file| file.path == "second.txt"));
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
    fn prepares_and_revalidates_workspace_chat_attachments() {
        let workspace = tempfile::tempdir().unwrap();
        let file = workspace.path().join("context.txt");
        std::fs::write(&file, "context\n").unwrap();
        let prepared = prepare_chat_attachment_blocking(PrepareChatAttachmentRequest {
            session_id: "new".into(),
            path: file.display().to_string(),
            workspace_path: Some(workspace.path().display().to_string()),
            kind: "workspace-file".into(),
            bytes: None,
            name: None,
        })
        .unwrap();
        assert_eq!(prepared.relative_path.as_deref(), Some("context.txt"));
        assert!(!prepared.content_hash.is_empty());

        let request = ProviderChatRequest {
            session_id: Uuid::new_v4().to_string(),
            message: "inspect it".into(),
            turn_id: None,
            provider_id: "openai".into(),
            provider_label: None,
            model_id: None,
            model_label: None,
            reasoning_effort: None,
            require_command_approval: true,
            require_file_edit_approval: true,
            full_access: false,
            suggest_title: false,
            workspace_path: Some(workspace.path().display().to_string()),
            mode: ChatMode::Plan,
            goal: None,
            plan: None,
            attachments: vec![ChatAttachmentRequest {
                id: prepared.id,
                kind: prepared.kind,
                name: prepared.name,
                path: prepared.path,
                relative_path: prepared.relative_path,
                mime_type: None,
                size: prepared.size,
                content_hash: Some(prepared.content_hash),
                modified_at: prepared.modified_at,
                preview_url: None,
            }],
        };
        validate_chat_context(&request).unwrap();
        std::fs::write(&file, "changed\n").unwrap();
        assert!(validate_chat_context(&request)
            .unwrap_err()
            .contains("changed after"));
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
    fn gui_cli_paths_include_latest_nvm_node_bin() {
        let home = tempfile::tempdir().unwrap();
        let node_versions = home.path().join(".nvm/versions/node");
        std::fs::create_dir_all(node_versions.join("v22.23.1/bin")).unwrap();
        std::fs::create_dir_all(node_versions.join("v24.11.0/bin")).unwrap();
        std::fs::create_dir_all(node_versions.join("v9.9.9/bin")).unwrap();

        let paths = user_cli_paths(home.path());
        let nvm_paths = paths
            .iter()
            .filter(|path| path.contains(".nvm/versions/node"))
            .collect::<Vec<_>>();

        assert_eq!(nvm_paths.len(), 3);
        assert!(nvm_paths[0].ends_with("v24.11.0/bin"));
        assert!(nvm_paths[1].ends_with("v22.23.1/bin"));
        assert!(nvm_paths[2].ends_with("v9.9.9/bin"));
        assert!(paths.iter().any(|path| path.ends_with(".volta/bin")));
        assert!(paths.iter().any(|path| path.ends_with(".asdf/shims")));
    }

    #[test]
    fn codex_chat_omits_seeded_display_models() {
        assert_eq!(codex_model_arg(Some("gpt-5.5")), None);
        assert_eq!(codex_model_arg(Some(" gpt-5.4-mini ")), None);
        assert_eq!(codex_model_arg(Some("o4-mini")), Some("o4-mini".into()));
    }

    #[test]
    fn codex_chat_prompt_prefers_concise_answers() {
        let prompt = openai_codex_chat_prompt(
            "WHAT MODEL are you?",
            Some("/workspace"),
            Some("GPT-5.6 Sol"),
            true,
            false,
        );

        assert!(prompt.contains("polished, scannable Markdown"));
        assert!(prompt.contains("bullets or numbered lists"));
        assert!(prompt.contains("each thing on its own bullet"));
        assert!(prompt.contains("Do not repeat the same conclusion"));
        assert!(prompt.contains("selected model label is: GPT-5.6 Sol"));
        assert!(prompt.contains("exactly that selected model label only"));
        assert!(prompt.contains("Do not describe the local Codex runner"));
        assert!(prompt.contains("GYRO_SESSION_TITLE:"));
        assert!(prompt.contains("Selected workspace: /workspace"));
        assert!(prompt.contains("Do not edit files"));

        let full_access_prompt =
            openai_codex_chat_prompt("fix it", Some("/workspace"), None, false, true);
        assert!(full_access_prompt.contains(
            "You may edit files, run commands, and complete requested workspace changes directly."
        ));
        assert!(!full_access_prompt.contains("Do not edit files"));
    }

    #[test]
    fn provider_chat_command_args_use_resume_contracts() {
        let output_path = PathBuf::from("/tmp/gyro-last-message.txt");
        let image = ChatAttachmentRequest {
            id: "image-1".into(),
            kind: "image".into(),
            name: "screen.png".into(),
            path: "/tmp/screen.png".into(),
            relative_path: None,
            mime_type: Some("image/png".into()),
            size: 128,
            content_hash: None,
            modified_at: None,
            preview_url: None,
        };
        let fresh_codex = codex_chat_args(
            None,
            &output_path,
            Some("gpt-5.6-sol"),
            Some("max"),
            &ChatMode::Normal,
            true,
            true,
            false,
            std::slice::from_ref(&image),
            "hello",
        );
        assert_eq!(fresh_codex[0], "exec");
        assert!(fresh_codex.contains(&"--sandbox".to_string()));
        assert!(fresh_codex.contains(&"read-only".to_string()));
        assert!(fresh_codex.contains(&"--json".to_string()));
        assert!(fresh_codex.contains(&"--output-last-message".to_string()));
        assert!(fresh_codex.contains(&"gpt-5.6-sol".to_string()));
        assert!(fresh_codex.contains(&"model_reasoning_effort=\"max\"".to_string()));
        assert!(fresh_codex
            .windows(2)
            .any(|args| args == ["--image", "/tmp/screen.png"]));
        assert_eq!(
            fresh_codex[fresh_codex.len() - 2..],
            ["--".to_string(), "hello".to_string()]
        );
        assert_eq!(fresh_codex.last(), Some(&"hello".to_string()));

        let full_access_codex = codex_chat_args(
            None,
            &output_path,
            None,
            None,
            &ChatMode::Normal,
            false,
            false,
            true,
            &[],
            "edit it",
        );
        assert!(
            full_access_codex.contains(&"--dangerously-bypass-approvals-and-sandbox".to_string())
        );
        assert!(!full_access_codex.contains(&"read-only".to_string()));

        let resumed_codex = codex_chat_args(
            Some("019f4612-7e58-7412-9fe9-5f0d6cb29c8e"),
            &output_path,
            None,
            None,
            &ChatMode::Normal,
            true,
            true,
            false,
            &[],
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
        assert!(resumed_codex
            .windows(2)
            .any(|args| args == ["--config", "sandbox_mode=\"read-only\""]));
        assert!(!resumed_codex.contains(&"--sandbox".to_string()));
        assert!(resumed_codex.ends_with(&["--".to_string(), "again".to_string()]));

        for resume_session_id in [None, Some("019f4612-7e58-7412-9fe9-5f0d6cb29c8e")] {
            let plan_codex = codex_chat_args(
                resume_session_id,
                &output_path,
                None,
                None,
                &ChatMode::Plan,
                false,
                false,
                false,
                &[],
                "inspect only",
            );
            let expected_read_only_args = if resume_session_id.is_some() {
                ["--config", "sandbox_mode=\"read-only\""]
            } else {
                ["--sandbox", "read-only"]
            };
            assert!(plan_codex
                .windows(2)
                .any(|args| args == expected_read_only_args));
            if resume_session_id.is_some() {
                assert!(!plan_codex.contains(&"--sandbox".to_string()));
            }
            assert!(!plan_codex.contains(&"--dangerously-bypass-approvals-and-sandbox".to_string()));
        }

        let fresh_claude = claude_chat_args(
            None,
            "019f4612-7e58-7412-9fe9-5f0d6cb29c8e",
            Some("sonnet"),
            &ChatMode::Normal,
            true,
            true,
            false,
            Some("{\"mcpServers\":{}}"),
            "hello",
        );
        assert!(fresh_claude.contains(&"--print".to_string()));
        assert!(fresh_claude.contains(&"stream-json".to_string()));
        assert!(fresh_claude.contains(&"--include-partial-messages".to_string()));
        assert!(fresh_claude.contains(&"--session-id".to_string()));
        assert!(fresh_claude.contains(&"--mcp-config".to_string()));
        assert!(fresh_claude.contains(&"--permission-prompt-tool".to_string()));
        assert!(fresh_claude.contains(&"mcp__gyro_approval__approve".to_string()));
        assert!(!fresh_claude.contains(&"--dangerously-skip-permissions".to_string()));
        assert!(fresh_claude
            .windows(2)
            .any(|args| args == ["--model", "sonnet"]));
        assert_eq!(fresh_claude.last(), Some(&"hello".to_string()));

        let auto_approve_claude = claude_chat_args(
            None,
            "019f4612-7e58-7412-9fe9-5f0d6cb29c8e",
            None,
            &ChatMode::Normal,
            false,
            false,
            false,
            Some("{\"mcpServers\":{}}"),
            "edit it",
        );
        assert!(auto_approve_claude.contains(&"--permission-prompt-tool".to_string()));
        assert!(!auto_approve_claude.contains(&"--dangerously-skip-permissions".to_string()));

        let full_access_claude = claude_chat_args(
            None,
            "019f4612-7e58-7412-9fe9-5f0d6cb29c8e",
            None,
            &ChatMode::Normal,
            false,
            false,
            true,
            None,
            "edit it",
        );
        assert!(full_access_claude.contains(&"--dangerously-skip-permissions".to_string()));

        let resumed_claude = claude_chat_args(
            Some("019f4612-7e58-7412-9fe9-5f0d6cb29c8e"),
            "unused",
            None,
            &ChatMode::Plan,
            false,
            false,
            false,
            Some("{\"mcpServers\":{}}"),
            "again",
        );
        assert!(resumed_claude.contains(&"--resume".to_string()));
        assert!(resumed_claude.contains(&"plan".to_string()));
        assert!(!resumed_claude.contains(&"--mcp-config".to_string()));
        assert_eq!(resumed_claude.last(), Some(&"again".to_string()));
    }

    #[test]
    fn codex_app_server_policy_keeps_gated_edits_read_only() {
        let workspace = Path::new("/tmp/gyro-workspace");
        let (approval, sandbox, policy) =
            codex_app_server_policy(&ChatMode::Normal, true, true, false, workspace);
        assert_eq!(approval, "untrusted");
        assert_eq!(sandbox, "read-only");
        assert_eq!(policy["type"], "readOnly");
        assert_eq!(policy["networkAccess"], false);

        let (approval, sandbox, policy) =
            codex_app_server_policy(&ChatMode::Normal, false, false, false, workspace);
        assert_eq!(approval, "never");
        assert_eq!(sandbox, "workspace-write");
        assert_eq!(policy["type"], "workspaceWrite");
        assert_eq!(policy["writableRoots"][0], "/tmp/gyro-workspace");

        let (approval, sandbox, policy) =
            codex_app_server_policy(&ChatMode::Plan, false, false, false, workspace);
        assert_eq!(approval, "untrusted");
        assert_eq!(sandbox, "read-only");
        assert_eq!(policy["type"], "readOnly");
        assert_eq!(policy["networkAccess"], false);
        assert_eq!(provider_approval_label("command"), "Review command");
        assert!(provider_approval_risk("file-change").contains("workspace patch"));
    }

    #[test]
    fn provider_adapter_registry_executes_kimi_and_keeps_readiness_only_entries() {
        let openai = provider_adapter_for("openai");
        assert_eq!(openai.kind, ProviderAdapterKind::OpenAiCodex);
        assert_eq!(openai.runner, "codex-cli");

        let anthropic = provider_adapter_for("anthropic");
        assert_eq!(anthropic.kind, ProviderAdapterKind::AnthropicClaude);
        assert_eq!(anthropic.runner, "claude-code");

        let kimi = provider_adapter_for("kimi");
        assert_eq!(kimi.kind, ProviderAdapterKind::KimiAcp);
        assert_eq!(kimi.runner, "kimi-acp");

        for provider_id in ["xai", "gemini"] {
            let adapter = provider_adapter_for(provider_id);
            assert_eq!(adapter.kind, ProviderAdapterKind::ReadinessOnly);
            assert_eq!(adapter.runner, "readiness-only");
            assert_eq!(adapter.auth_owner, "provider-env");
        }
    }

    #[test]
    fn kimi_acp_plan_activity_maps_to_the_existing_plan_payload() {
        let payload = kimi_acp_plan_payload(&ProviderActivity {
            id: "kimi-plan".into(),
            kind: "plan".into(),
            label: "Updated plan".into(),
            detail: Some(
                serde_json::json!([
                    {"content": "Inspect", "status": "in_progress"},
                    {"title": "Implement", "status": "completed"}
                ])
                .to_string(),
            ),
            status: "done".into(),
        })
        .unwrap();
        assert_eq!(payload["action"], "replace");
        assert_eq!(payload["items"][0]["title"], "Inspect");
        assert_eq!(payload["items"][0]["status"], "in-progress");
        assert_eq!(payload["items"][1]["status"], "complete");
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
    fn provider_stream_parsers_extract_live_activity_and_commentary() {
        let command = extract_provider_activity(&serde_json::json!({
            "type": "item.completed",
            "item": {
                "id": "item_1",
                "type": "command_execution",
                "command": "/bin/zsh -lc \"rg --files packages/ui\""
            }
        }))
        .expect("command activity");
        assert_eq!(command.id, "item_1");
        assert_eq!(command.kind, "command");
        assert_eq!(command.label, "Listed files");
        assert_eq!(command.status, "done");

        let commentary = extract_provider_commentary_activity(&serde_json::json!({
            "type": "item.completed",
            "item": {
                "id": "message_1",
                "type": "agent_message",
                "text": "I’ll inspect the workspace first."
            }
        }))
        .expect("commentary activity");
        assert_eq!(commentary.id, "message_1");
        assert_eq!(commentary.kind, "commentary");
        assert_eq!(commentary.label, "I’ll inspect the workspace first.");

        let retained = provider_activities_for_response(
            vec![commentary.clone(), command.clone()],
            "I’ll inspect the workspace first.",
        );
        assert_eq!(retained, vec![command]);
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
    fn streaming_state_caps_retained_provider_activities() {
        let mut state = StreamingCommandState::new();
        for index in 0..(MAX_CODEX_APP_SERVER_ACTIVITIES + 8) {
            state.push_activity(ProviderActivity {
                id: format!("activity-{index}"),
                kind: "command".into(),
                label: "Ran command".into(),
                detail: None,
                status: "done".into(),
            });
        }
        assert_eq!(state.activities.len(), MAX_CODEX_APP_SERVER_ACTIVITIES);
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
    fn parses_codex_app_server_context_usage() {
        let usage = provider_context_usage_from_app_server(&serde_json::json!({
            "tokenUsage": {
                "last": {
                    "inputTokens": 42137,
                    "cachedInputTokens": 40000,
                    "outputTokens": 812,
                    "reasoningOutputTokens": 205,
                    "totalTokens": 42949
                },
                "modelContextWindow": 128000
            }
        }))
        .unwrap();
        assert_eq!(usage.input_tokens, 42_137);
        assert_eq!(usage.model_context_window, Some(128_000));
    }

    #[test]
    fn parses_codex_exec_context_usage() {
        let usage = provider_context_usage_from_codex_exec(&serde_json::json!({
            "type": "turn.completed",
            "usage": {
                "input_tokens": 42137,
                "cached_input_tokens": 40000,
                "output_tokens": 812,
                "reasoning_output_tokens": 205,
                "total_tokens": 42949,
                "model_context_window": 128000
            }
        }))
        .unwrap();
        assert_eq!(usage.input_tokens, 42_137);
        assert_eq!(usage.model_context_window, Some(128_000));
    }

    #[test]
    fn provider_failures_have_specific_recovery_guidance() {
        assert_eq!(
            provider_failure_recovery("network is unreachable").0,
            "offline"
        );
        assert_eq!(
            provider_failure_recovery("authentication required").0,
            "authentication"
        );
        assert_eq!(
            provider_failure_recovery("rate limit exceeded").0,
            "rate-limit"
        );
        assert_eq!(provider_failure_recovery("provider crashed").0, "retry");
    }

    #[test]
    fn stale_resume_binding_is_cleared_without_replaying_the_request() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "resume recovery")
            .unwrap();
        let binding = store
            .upsert_provider_session_binding(
                session.id,
                "openai",
                Some("gpt-5.5".into()),
                Some("GPT-5.5".into()),
                None,
                serde_json::json!({
                    "kind": "codex-session",
                    "sessionId": "stale-provider-session",
                }),
                "ready",
                None,
            )
            .unwrap();
        let request = ProviderChatRequest {
            session_id: session.id.to_string(),
            message: "continue".into(),
            turn_id: Some(Uuid::new_v4().to_string()),
            provider_id: "openai".into(),
            provider_label: Some("OpenAI".into()),
            model_id: Some("gpt-5.5".into()),
            model_label: Some("GPT-5.5".into()),
            reasoning_effort: None,
            require_command_approval: true,
            require_file_edit_approval: true,
            full_access: false,
            suggest_title: false,
            workspace_path: Some(temp.path().display().to_string()),
            mode: ChatMode::Normal,
            goal: None,
            plan: None,
            attachments: Vec::new(),
        };
        let mut attempts = Vec::new();
        let error =
            run_provider_chat_with_retry_using(&store, &request, Some(binding), |resume_cursor| {
                attempts.push(resume_cursor.map(|cursor| cursor.session_id.clone()));
                if resume_cursor.is_some() {
                    anyhow::bail!("Could not resume session: not found");
                }
                Ok(ProviderRunnerOutput {
                    activities: Vec::new(),
                    context_usage: None,
                    response: "Recovered".into(),
                    resume_cursor: None,
                    retry_count: 0,
                    resumed: false,
                    output_summary: None,
                })
            })
            .unwrap_err();

        assert_eq!(attempts, vec![Some("stale-provider-session".into())]);
        assert!(error
            .to_string()
            .contains("retry explicitly to avoid replaying tools"));
        assert!(store
            .get_provider_session_binding(session.id, "openai")
            .unwrap()
            .is_none());
    }

    #[test]
    fn pending_approval_is_restored_into_the_timeline_once() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "approval restore")
            .unwrap();
        let proposal = store
            .create_mutation_proposal(
                session.id,
                Some(Uuid::new_v4()),
                "restored.txt",
                "pending\n",
                None,
                false,
            )
            .unwrap();

        let first = read_session_events_from_store(&store, session.id).unwrap();
        let second = read_session_events_from_store(&store, session.id).unwrap();
        let matching = |events: &[SessionEvent]| {
            events
                .iter()
                .filter(|event| event_mutation_proposal_id(event) == Some(proposal.id))
                .count()
        };
        assert_eq!(matching(&first), 1);
        assert_eq!(matching(&second), 1);
        assert_eq!(
            second
                .iter()
                .find(|event| event_mutation_proposal_id(event) == Some(proposal.id))
                .unwrap()
                .kind,
            SessionEventKind::ApprovalRequested
        );
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
    fn derives_a_bounded_plain_text_summary_from_the_real_response() {
        let summary = derive_session_summary(
            "## Result\n\nInspected `src/main.rs` and fixed the startup path.\n\n- Tests pass.",
        )
        .unwrap();
        assert_eq!(
            summary,
            "Result Inspected src/main.rs and fixed the startup path. Tests pass."
        );
        assert!(derive_session_summary(" \n\n").is_none());
        assert!(
            derive_session_summary(&"word ".repeat(200))
                .unwrap()
                .chars()
                .count()
                <= 423
        );
    }

    #[test]
    fn extracts_structured_plan_update_marker() {
        let extracted = extract_plan_update_marker(
            "GYRO_PLAN_UPDATE: {\"action\":\"replace\",\"items\":[{\"id\":\"one\",\"title\":\"Inspect\",\"status\":\"todo\"}]}\n\nHere is the plan.",
        );
        assert_eq!(extracted.payload.as_ref().unwrap()["action"], "replace");
        assert_eq!(extracted.message, "Here is the plan.");
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
            require_command_approval: true,
            require_file_edit_approval: true,
            full_access: false,
            suggest_title: false,
            workspace_path: Some(temp.path().display().to_string()),
            mode: ChatMode::Normal,
            goal: None,
            plan: None,
            attachments: Vec::new(),
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
    fn native_provider_binding_owns_execution_authority() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session_with_context(
                temp.path(),
                SessionOrigin::Desktop,
                "bound provider",
                CreateSessionContext {
                    provider_id: Some("openai".into()),
                    provider_label: Some("OpenAI".into()),
                    model_id: Some("gpt-5.6-sol".into()),
                    model_label: Some("GPT-5.6 Sol".into()),
                    reasoning_effort: Some("high".into()),
                    ..CreateSessionContext::default()
                },
            )
            .unwrap();
        let mut config = GyroConfig {
            require_command_approval: true,
            require_file_edit_approval: true,
            ..GyroConfig::default()
        };
        config
            .model_providers
            .iter_mut()
            .find(|provider| provider.id == "openai")
            .unwrap()
            .enabled = true;
        let mut request = ProviderChatRequest {
            session_id: session.id.to_string(),
            message: "inspect it".into(),
            turn_id: Some(Uuid::new_v4().to_string()),
            provider_id: "openai".into(),
            provider_label: Some("forged label".into()),
            model_id: Some("gpt-5.6-sol".into()),
            model_label: Some("forged model".into()),
            reasoning_effort: Some("high".into()),
            require_command_approval: false,
            require_file_edit_approval: false,
            full_access: true,
            suggest_title: false,
            workspace_path: None,
            mode: ChatMode::Normal,
            goal: None,
            plan: None,
            attachments: Vec::new(),
        };

        bind_provider_chat_request(&mut request, &session, &config).unwrap();

        assert!(request.require_command_approval);
        assert!(request.require_file_edit_approval);
        assert_eq!(request.provider_label.as_deref(), Some("OpenAI"));
        assert_eq!(request.model_label.as_deref(), Some("GPT-5.6 Sol"));
        assert_eq!(
            PathBuf::from(request.workspace_path.as_deref().unwrap()),
            temp.path().canonicalize().unwrap()
        );

        request.provider_id = "anthropic".into();
        assert!(bind_provider_chat_request(&mut request, &session, &config)
            .unwrap_err()
            .contains("provider selection changed"));
    }

    #[test]
    fn renderer_config_cannot_replace_native_account_state() {
        let mut persisted = GyroConfig::default();
        persisted.account_session.signed_in = true;
        persisted.account_session.user_id = Some("native-user".into());
        let mut incoming = persisted.clone();
        incoming.telemetry_enabled = true;
        incoming.account_oidc.issuer_url = "https://attacker.invalid".into();
        incoming.account_session.user_id = Some("forged-user".into());

        let merged = merge_renderer_config(incoming, &persisted);

        assert!(merged.telemetry_enabled);
        assert_eq!(merged.account_oidc, persisted.account_oidc);
        assert_eq!(merged.account_session, persisted.account_session);
    }

    #[test]
    fn attachment_names_cannot_become_paths_or_prompt_controls() {
        assert!(validate_attachment_name("screen.png").is_ok());
        for unsafe_name in [
            "pivot/../../../../config.json",
            "../config.json",
            ".",
            "line\nbreak.png",
        ] {
            assert!(
                validate_attachment_name(unsafe_name).is_err(),
                "{unsafe_name}"
            );
        }
    }

    #[test]
    fn protocol_line_reader_rejects_oversized_unterminated_frames() {
        let mut oversized = BufReader::new(std::io::Cursor::new(vec![b'x'; 33]));
        assert!(read_bounded_protocol_line(&mut oversized, 32)
            .unwrap_err()
            .contains("size limit"));

        let mut framed = BufReader::new(std::io::Cursor::new(b"{\"ok\":true}\r\nnext\n"));
        assert_eq!(
            read_bounded_protocol_line(&mut framed, 32).unwrap(),
            Some(br#"{"ok":true}"#.to_vec())
        );
        assert_eq!(
            read_bounded_protocol_line(&mut framed, 32).unwrap(),
            Some(b"next".to_vec())
        );

        let mut unterminated = BufReader::new(std::io::Cursor::new(b"{\"ok\":true}"));
        assert!(read_bounded_protocol_line(&mut unterminated, 32)
            .unwrap_err()
            .contains("newline terminator"));
    }

    #[cfg(unix)]
    #[test]
    fn ipc_bind_preserves_live_socket_and_replaces_only_stale_socket() {
        use std::os::unix::fs::{FileTypeExt, MetadataExt};
        use std::os::unix::net::UnixListener;

        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        paths.ensure().unwrap();
        let live = UnixListener::bind(&paths.socket_path).unwrap();
        let live_inode = fs::symlink_metadata(&paths.socket_path).unwrap().ino();

        assert!(bind_cli_ipc_listener(&paths).unwrap().is_none());
        assert_eq!(
            fs::symlink_metadata(&paths.socket_path).unwrap().ino(),
            live_inode
        );

        drop(live);
        let rebound = bind_cli_ipc_listener(&paths).unwrap().unwrap();
        assert!(fs::symlink_metadata(&paths.socket_path)
            .unwrap()
            .file_type()
            .is_socket());
        drop(rebound);
    }

    #[cfg(unix)]
    #[test]
    fn ipc_bind_refuses_to_remove_non_socket_targets() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        paths.ensure().unwrap();
        fs::write(&paths.socket_path, b"do not remove").unwrap();

        assert!(bind_cli_ipc_listener(&paths)
            .unwrap_err()
            .to_string()
            .contains("not a safe Unix socket"));
        assert_eq!(fs::read(&paths.socket_path).unwrap(), b"do not remove");
    }

    #[test]
    fn codex_patch_accumulator_is_bounded() {
        let mut patches = HashMap::new();
        for index in 0..MAX_CODEX_APP_SERVER_PATCHES {
            insert_codex_app_server_patch(
                &mut patches,
                &format!("patch-{index}"),
                serde_json::json!({ "changes": [] }),
            )
            .unwrap();
        }
        assert!(insert_codex_app_server_patch(
            &mut patches,
            "one-too-many",
            serde_json::json!({ "changes": [] }),
        )
        .is_err());
        assert!(insert_codex_app_server_patch(
            &mut HashMap::new(),
            "oversized",
            serde_json::json!({ "changes": "x".repeat(MAX_CODEX_APP_SERVER_PATCH_BYTES) }),
        )
        .is_err());
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
            profile_id: Some("shell".into()),
            command: "zsh".into(),
            args: Vec::new(),
            workspace_path: Some("   ".into()),
            workspace_mode: None,
            working_directory: None,
            cols: None,
            rows: None,
        };

        assert_eq!(
            resolve_terminal_cwd(&request).unwrap(),
            Some(user_home_directory().unwrap())
        );
    }

    #[test]
    fn terminal_home_cwd_ignores_workspace_path() {
        let request = TerminalPaneRequest {
            pane_id: "home-workspace".into(),
            title: "Codex".into(),
            profile_id: Some("codex".into()),
            command: "codex".into(),
            args: Vec::new(),
            workspace_path: Some("/tmp/gyro-workspace".into()),
            workspace_mode: None,
            working_directory: Some("Home".into()),
            cols: None,
            rows: None,
        };

        assert_eq!(
            resolve_terminal_cwd(&request).unwrap(),
            Some(user_home_directory().unwrap())
        );
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
            profile_id: Some("shell".into()),
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
                profile_id: Some("shell".into()),
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
        assert!(snapshot
            .output
            .as_deref()
            .unwrap_or_default()
            .contains("hello"));
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
                profile_id: Some("shell".into()),
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
        assert_eq!(snapshot.profile_id.as_deref(), Some("shell"));

        let idle = (0..40).any(|_| {
            let idle = !manager.has_foreground_job("pane-zsh").unwrap();
            if !idle {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            idle
        });
        assert!(idle, "login zsh should settle at an idle prompt");

        manager
            .write("pane-zsh", "printf zsh-ready\\nexit\\n")
            .unwrap();
        let snapshot = wait_for_terminal_output(&manager, "pane-zsh", "zsh-ready");
        assert!(snapshot
            .output
            .as_deref()
            .unwrap_or_default()
            .contains("zsh-ready"));
    }

    #[cfg(unix)]
    #[test]
    fn terminal_manager_distinguishes_idle_shell_from_foreground_job() {
        let manager = TerminalProcessManager::default();
        manager
            .create(TerminalPaneRequest {
                pane_id: "pane-activity".into(),
                title: "Shell".into(),
                profile_id: Some("shell".into()),
                command: "sh".into(),
                args: Vec::new(),
                workspace_path: None,
                workspace_mode: None,
                working_directory: None,
                cols: None,
                rows: None,
            })
            .unwrap();

        let idle = (0..20).any(|_| {
            let idle = !manager.has_foreground_job("pane-activity").unwrap();
            if !idle {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            idle
        });
        assert!(idle, "interactive shell should settle at an idle prompt");

        manager.write("pane-activity", "sleep 5\n").unwrap();
        let busy = (0..20).any(|_| {
            let busy = manager.has_foreground_job("pane-activity").unwrap();
            if !busy {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            busy
        });
        assert!(busy, "foreground shell command should require confirmation");
        manager.stop("pane-activity").unwrap();
    }

    #[test]
    fn terminal_manager_writes_input_and_resizes() {
        let manager = TerminalProcessManager::default();
        manager
            .create(TerminalPaneRequest {
                pane_id: "pane-input".into(),
                title: "Shell".into(),
                profile_id: Some("shell".into()),
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
        assert!(snapshot
            .output
            .as_deref()
            .unwrap_or_default()
            .contains("out:ok"));
        assert_eq!(snapshot.status, "done");
    }

    #[test]
    fn terminal_manager_uses_real_terminal_environment() {
        let manager = TerminalProcessManager::default();
        manager
            .create(TerminalPaneRequest {
                pane_id: "pane-env".into(),
                title: "Shell".into(),
                profile_id: Some("shell".into()),
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
        assert!(snapshot
            .output
            .as_deref()
            .unwrap_or_default()
            .contains("xterm-256color truecolor Gyro"));
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
                profile_id: Some("shell".into()),
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
        let output = snapshot.output.as_deref().unwrap_or_default();
        assert!(output.contains("\u{1b}[35mYOLO\u{1b}[0m"));
        assert!(output.contains("\u{1b}[36m/model\u{1b}[0m"));
        assert_eq!(snapshot.status, "done");
    }

    #[test]
    fn terminal_snapshot_keeps_project_and_resolved_working_directory() {
        let workspace = tempfile::tempdir().unwrap();
        let workspace_path = workspace.path().display().to_string();
        let manager = TerminalProcessManager::default();
        manager
            .create(TerminalPaneRequest {
                pane_id: "pane-cwd".into(),
                title: "Shell".into(),
                profile_id: Some("shell".into()),
                command: "sh".into(),
                args: vec!["-c".into(), "pwd".into()],
                workspace_path: Some(workspace_path.clone()),
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
        assert_eq!(snapshot.workspace_path.as_deref(), Some(&*workspace_path));
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
    fn git_branch_catalog_switches_clean_branches_and_refuses_dirty_workspaces() {
        let repo = tempfile::tempdir().unwrap();
        init_git_repo(repo.path());
        fs::write(repo.path().join("tracked.txt"), "main\n").unwrap();
        run_git(repo.path(), &["add", "."]);
        run_git(repo.path(), &["commit", "-m", "base"]);
        run_git(repo.path(), &["branch", "feature/picker"]);

        let workspace_path = repo.path().to_str().unwrap().to_string();
        let catalog = git_branch_catalog_impl(&workspace_path).unwrap();
        assert_eq!(catalog.current.as_deref(), Some("main"));
        assert_eq!(catalog.branches, vec!["feature/picker", "main"]);

        let switched = git_checkout_branch_impl(&GitCheckoutBranchRequest {
            workspace_path: workspace_path.clone(),
            branch: "feature/picker".into(),
        })
        .unwrap();
        assert_eq!(switched.current.as_deref(), Some("feature/picker"));

        fs::write(repo.path().join("tracked.txt"), "dirty\n").unwrap();
        let error = git_checkout_branch_impl(&GitCheckoutBranchRequest {
            workspace_path,
            branch: "main".into(),
        })
        .unwrap_err();
        assert!(error.to_string().contains("commit or stash"));
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
    fn scheduler_iteration_finishes_one_claimed_run_without_duplicates() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let store = AutomationStore::open(paths.clone()).unwrap();
        let automation = store
            .create_automation(CreateAutomationRequest {
                title: "Scheduled smoke".into(),
                prompt: "Run checks".into(),
                schedule: gyro_core::AutomationSchedule::Hourly,
                project: "Gyro".into(),
                provider: "Codex".into(),
                branch: "main".into(),
                workspace_mode: SessionWorkspaceMode::Local,
                worktree_name: None,
                stop_condition: None,
                next_run_at: Some(chrono::Utc::now() - chrono::Duration::minutes(1)),
                execution: gyro_core::AutomationExecutionContext::default(),
            })
            .unwrap();

        let completed = run_automation_scheduler_once_with(&paths, "worker-one", |_| {
            Ok("All checks passed".into())
        })
        .unwrap()
        .unwrap();
        assert_eq!(completed.id, automation.id);
        assert_eq!(completed.last_result, "All checks passed");
        assert_eq!(completed.run_history[0].status, AutomationRunStatus::Passed);
        assert!(completed.lease_owner.is_none());
        assert!(
            run_automation_scheduler_once_with(&paths, "worker-two", |_| {
                panic!("a completed lease must not execute twice")
            })
            .unwrap()
            .is_none()
        );
    }

    #[test]
    fn scheduler_machine_enforces_stop_condition_verdicts() {
        let met_temp = tempfile::tempdir().unwrap();
        let met_paths = GyroPaths::from_base_dir(met_temp.path().join("Gyro"));
        create_due_stop_condition_automation(&met_paths);
        let completed = run_automation_scheduler_once_with(&met_paths, "met-worker", |_| {
            Ok(
                "Checks are green.\n\n<!-- gyro-automation-result: {\"stopConditionMet\":true} -->"
                    .into(),
            )
        })
        .unwrap()
        .unwrap();
        assert_eq!(completed.status, AutomationStatus::Completed);
        assert_eq!(completed.last_result, "Checks are green.");
        assert!(completed.next_run_at.is_none());
        assert_eq!(completed.run_history[0].stop_condition_met, Some(true));

        let pending_temp = tempfile::tempdir().unwrap();
        let pending_paths = GyroPaths::from_base_dir(pending_temp.path().join("Gyro"));
        create_due_stop_condition_automation(&pending_paths);
        let pending = run_automation_scheduler_once_with(
            &pending_paths,
            "pending-worker",
            |_| {
                Ok("One check still fails.\n<!-- gyro-automation-result: {\"stopConditionMet\":false} -->"
                    .into())
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(pending.status, AutomationStatus::Current);
        assert_eq!(pending.run_history[0].stop_condition_met, Some(false));
        assert!(pending.next_run_at.is_some());

        let missing_temp = tempfile::tempdir().unwrap();
        let missing_paths = GyroPaths::from_base_dir(missing_temp.path().join("Gyro"));
        create_due_stop_condition_automation(&missing_paths);
        let failed = run_automation_scheduler_once_with(&missing_paths, "missing-worker", |_| {
            Ok("The provider forgot the verdict".into())
        })
        .unwrap()
        .unwrap();
        assert_eq!(failed.status, AutomationStatus::Current);
        assert_eq!(failed.run_history[0].status, AutomationRunStatus::Failed);
        assert_eq!(failed.run_history[0].stop_condition_met, None);
        assert!(failed.last_result.contains("failed closed"));
    }

    #[test]
    fn scheduler_wake_generation_cannot_be_lost_before_or_during_wait() {
        let control = Arc::new(AutomationSchedulerControl::default());
        let before_wake = control.generation();
        control.wake();
        let started = Instant::now();
        let after_early_wake =
            control.wait_for_change(before_wake, std::time::Duration::from_secs(1));
        assert_ne!(after_early_wake, before_wake);
        assert!(started.elapsed() < std::time::Duration::from_millis(100));

        let (ready_tx, ready_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let waiting_control = control.clone();
        let observed = control.generation();
        let waiter = std::thread::spawn(move || {
            ready_tx.send(()).unwrap();
            let generation =
                waiting_control.wait_for_change(observed, std::time::Duration::from_secs(5));
            done_tx.send(generation).unwrap();
        });
        ready_rx.recv().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(25));
        control.wake();
        let generation = done_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap();
        assert_ne!(generation, observed);
        waiter.join().unwrap();
    }

    #[test]
    fn scheduler_clock_keeps_due_work_visible_after_a_backward_wall_change() {
        let initial = chrono::Utc::now();
        let backward_wall = initial - chrono::Duration::hours(2);
        let effective = automation_scheduler_effective_now(
            initial,
            std::time::Duration::from_secs(3 * 60),
            backward_wall,
        );
        assert_eq!(effective, initial + chrono::Duration::minutes(3));
        assert_eq!(
            automation_scheduler_effective_now(
                effective,
                std::time::Duration::from_secs(60),
                initial + chrono::Duration::hours(5),
            ),
            initial + chrono::Duration::hours(5)
        );

        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let store = AutomationStore::open(paths.clone()).unwrap();
        let automation = store
            .create_automation(CreateAutomationRequest {
                title: "Clock correction smoke".into(),
                prompt: "Run once after the clock changes".into(),
                schedule: gyro_core::AutomationSchedule::Hourly,
                project: "Gyro".into(),
                provider: "Codex".into(),
                branch: "main".into(),
                workspace_mode: SessionWorkspaceMode::Local,
                worktree_name: None,
                stop_condition: None,
                next_run_at: Some(initial + chrono::Duration::minutes(2)),
                execution: gyro_core::AutomationExecutionContext::default(),
            })
            .unwrap();

        let completed =
            run_automation_scheduler_once_at_with(&paths, "clock-worker", effective, |_| {
                Ok("Clock-safe run completed".into())
            })
            .unwrap()
            .unwrap();
        assert_eq!(completed.id, automation.id);
        assert_eq!(completed.run_history[0].status, AutomationRunStatus::Passed);
        assert!(completed
            .last_run_at
            .is_some_and(|ran_at| ran_at >= effective));
        assert!(run_automation_scheduler_once_at_with(
            &paths,
            "duplicate-worker",
            effective,
            |_| panic!("a backward clock change must not duplicate the run"),
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn scheduler_heartbeat_renews_a_long_run_and_stops_before_completion() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let store = AutomationStore::open(paths.clone()).unwrap();
        let automation = store
            .create_automation(CreateAutomationRequest {
                title: "Long-running approval".into(),
                prompt: "Wait for approval".into(),
                schedule: gyro_core::AutomationSchedule::Hourly,
                project: "Gyro".into(),
                provider: "Codex".into(),
                branch: "main".into(),
                workspace_mode: SessionWorkspaceMode::Local,
                worktree_name: None,
                stop_condition: None,
                next_run_at: Some(chrono::Utc::now() - chrono::Duration::minutes(1)),
                execution: gyro_core::AutomationExecutionContext::default(),
            })
            .unwrap();

        let completed = run_automation_scheduler_once_with_heartbeat_interval(
            &paths,
            "heartbeat-worker",
            std::time::Duration::from_millis(10),
            |claimed| {
                let initial_expiry = claimed.lease_expires_at.unwrap();
                for _ in 0..50 {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                    let current = AutomationStore::open(paths.clone())
                        .unwrap()
                        .get_automation(automation.id)
                        .unwrap()
                        .unwrap();
                    if current
                        .lease_expires_at
                        .is_some_and(|expiry| expiry > initial_expiry)
                    {
                        return Ok("Approval completed".into());
                    }
                }
                panic!("lease heartbeat did not extend the active run");
            },
        )
        .unwrap()
        .unwrap();

        assert_eq!(completed.run_history[0].status, AutomationRunStatus::Passed);
        assert!(completed.lease_owner.is_none());
        assert!(completed.lease_expires_at.is_none());
    }

    #[test]
    fn resumed_run_event_explicitly_wakes_the_scheduler() {
        assert!(run_event_wakes_automation_scheduler(
            &tauri::RunEvent::Resumed
        ));
        assert!(!run_event_wakes_automation_scheduler(
            &tauri::RunEvent::Ready
        ));
    }

    #[test]
    fn stop_condition_parser_rejects_malformed_or_non_final_verdicts() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let automation = create_due_stop_condition_automation(&paths);

        assert!(parse_automation_execution_outcome(
            &automation,
            "Done\n<!-- gyro-automation-result: {not-json} -->"
        )
        .unwrap_err()
        .contains("invalid"));
        assert!(parse_automation_execution_outcome(
            &automation,
            "<!-- gyro-automation-result: {\"stopConditionMet\":true} -->\nextra"
        )
        .unwrap_err()
        .contains("final output"));

        let prompt = automation_provider_prompt(&automation);
        assert!(prompt.contains("Use true only when you verified"));
        assert!(prompt.contains("\"stopConditionMet\":false"));
    }

    #[test]
    fn scheduler_pauses_configuration_failures_instead_of_retrying_forever() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let store = AutomationStore::open(paths.clone()).unwrap();
        store
            .create_automation(CreateAutomationRequest {
                title: "Missing workspace".into(),
                prompt: "Run checks".into(),
                schedule: gyro_core::AutomationSchedule::Heartbeat,
                project: "Missing".into(),
                provider: "Codex".into(),
                branch: "main".into(),
                workspace_mode: SessionWorkspaceMode::Local,
                worktree_name: None,
                stop_condition: None,
                next_run_at: Some(chrono::Utc::now() - chrono::Duration::minutes(1)),
                execution: gyro_core::AutomationExecutionContext::default(),
            })
            .unwrap();

        let failed = run_automation_scheduler_once_with(&paths, "worker", |_| {
            Err("configuration: choose a workspace for this automation".into())
        })
        .unwrap()
        .unwrap();
        assert_eq!(failed.status, AutomationStatus::Paused);
        assert!(failed.next_run_at.is_none());
        assert_eq!(failed.run_history[0].status, AutomationRunStatus::Failed);
        assert!(failed.last_result.contains("choose a workspace"));
    }

    #[test]
    fn scheduler_recovers_an_interrupted_lease_once_before_retrying() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let store = AutomationStore::open(paths.clone()).unwrap();
        store
            .create_automation(CreateAutomationRequest {
                title: "Interrupted run".into(),
                prompt: "Run checks".into(),
                schedule: gyro_core::AutomationSchedule::Hourly,
                project: "Gyro".into(),
                provider: "Codex".into(),
                branch: "main".into(),
                workspace_mode: SessionWorkspaceMode::Local,
                worktree_name: None,
                stop_condition: None,
                next_run_at: Some(chrono::Utc::now() - chrono::Duration::minutes(1)),
                execution: gyro_core::AutomationExecutionContext::default(),
            })
            .unwrap();
        store
            .claim_due_automation("crashed-worker", 30)
            .unwrap()
            .unwrap();
        let recovery_time = chrono::Utc::now() + chrono::Duration::minutes(1);
        let mut outcomes = Vec::new();

        assert_eq!(
            recover_automation_scheduler_leases_with(&paths, recovery_time, |automation| {
                outcomes.push(automation.clone());
            })
            .unwrap(),
            1
        );
        assert_eq!(outcomes.len(), 1);
        assert_eq!(
            outcomes[0].run_history[0].status,
            AutomationRunStatus::Failed
        );
        assert!(outcomes[0].lease_owner.is_none());
        assert!(
            run_automation_scheduler_once_with(&paths, "replacement-worker", |_| {
                panic!("recovery backoff must prevent an immediate duplicate run")
            })
            .unwrap()
            .is_none()
        );
        assert_eq!(
            recover_automation_scheduler_leases_with(&paths, recovery_time, |_| {
                panic!("an interrupted lease must only be recovered once")
            })
            .unwrap(),
            0
        );
    }

    #[test]
    fn automation_notifications_are_private_and_only_cover_actionable_outcomes() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let store = AutomationStore::open(paths.clone()).unwrap();
        let automation = store
            .create_automation(CreateAutomationRequest {
                title: "Private customer incident".into(),
                prompt: "Inspect /secret/workspace and summarize confidential files".into(),
                schedule: gyro_core::AutomationSchedule::Manual,
                project: "Secret workspace".into(),
                provider: "Codex".into(),
                branch: "main".into(),
                workspace_mode: SessionWorkspaceMode::Local,
                worktree_name: None,
                stop_condition: None,
                next_run_at: Some(chrono::Utc::now() - chrono::Duration::minutes(1)),
                execution: gyro_core::AutomationExecutionContext {
                    workspace_path: Some("/secret/workspace".into()),
                    ..Default::default()
                },
            })
            .unwrap();
        let completed = run_automation_scheduler_once_with(&paths, "worker", |_| {
            Ok("Confidential result".into())
        })
        .unwrap()
        .unwrap();

        let (title, body) = automation_notification_content(&completed).unwrap();
        let notification = format!("{title} {body}");
        assert!(!notification.contains(&automation.title));
        assert!(!notification.contains(&automation.prompt));
        assert!(!notification.contains("/secret/workspace"));

        let mut stopped = completed.clone();
        stopped.run_history[0].status = AutomationRunStatus::Stopped;
        assert!(automation_notification_content(&stopped).is_none());
        let mut running = completed;
        running.run_history[0].status = AutomationRunStatus::Running;
        assert!(automation_notification_content(&running).is_none());
    }

    #[test]
    fn automation_notifications_defer_to_the_focused_app() {
        assert!(!should_show_automation_notification(true, true));
        assert!(should_show_automation_notification(true, false));
        assert!(should_show_automation_notification(false, false));
        assert!(should_show_automation_notification(false, true));
    }

    #[test]
    fn automation_notifications_require_explicit_native_permission() {
        assert!(notification_permission_allows_delivery(
            PermissionState::Granted
        ));
        assert!(!notification_permission_allows_delivery(
            PermissionState::Denied
        ));
        assert!(!notification_permission_allows_delivery(
            PermissionState::Prompt
        ));
        assert!(!notification_permission_allows_delivery(
            PermissionState::PromptWithRationale
        ));
    }

    fn create_due_stop_condition_automation(paths: &GyroPaths) -> Automation {
        AutomationStore::open(paths.clone())
            .unwrap()
            .create_automation(CreateAutomationRequest {
                title: "Stop-condition smoke".into(),
                prompt: "Run checks".into(),
                schedule: gyro_core::AutomationSchedule::Hourly,
                project: "Gyro".into(),
                provider: "Codex".into(),
                branch: "main".into(),
                workspace_mode: SessionWorkspaceMode::Local,
                worktree_name: None,
                stop_condition: Some("All checks pass".into()),
                next_run_at: Some(chrono::Utc::now() - chrono::Duration::minutes(1)),
                execution: gyro_core::AutomationExecutionContext::default(),
            })
            .unwrap()
    }

    #[test]
    fn terminal_manager_stops_running_process() {
        let manager = TerminalProcessManager::default();
        manager
            .create(TerminalPaneRequest {
                pane_id: "pane-stop".into(),
                title: "Shell".into(),
                profile_id: Some("shell".into()),
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

    #[test]
    fn terminal_output_retains_only_the_newest_bytes() {
        let output = Arc::new(Mutex::new(TerminalOutputBuffer::default()));
        append_terminal_output(
            &output,
            &vec![b'a'; MAX_TERMINAL_OUTPUT_BYTES.saturating_sub(4)],
        );
        append_terminal_output(&output, b"12345678");

        let output_guard = output.lock().unwrap();
        let retained = output_guard.bytes.iter().copied().collect::<Vec<_>>();
        assert_eq!(retained.len(), MAX_TERMINAL_OUTPUT_BYTES);
        assert_eq!(output_guard.revision, 2);
        assert!(retained[..retained.len() - 8]
            .iter()
            .all(|byte| *byte == b'a'));
        assert_eq!(&retained[retained.len() - 8..], b"12345678");
        drop(output_guard);

        let oversized = vec![b'z'; MAX_TERMINAL_OUTPUT_BYTES + 32];
        append_terminal_output(&output, &oversized);
        let output_guard = output.lock().unwrap();
        let retained = output_guard.bytes.iter().copied().collect::<Vec<_>>();
        assert_eq!(retained, oversized[32..]);
        assert_eq!(output_guard.revision, 3);
    }

    #[test]
    fn terminal_output_revision_skips_unchanged_payloads() {
        let output = Arc::new(Mutex::new(TerminalOutputBuffer::default()));
        append_terminal_output(&output, b"hello");

        let output_guard = output.lock().unwrap();
        let (initial, revision) = snapshot_terminal_output(&output_guard, None);
        let (unchanged, unchanged_revision) =
            snapshot_terminal_output(&output_guard, Some(revision));

        assert_eq!(initial.as_deref(), Some("hello"));
        assert!(unchanged.is_none());
        assert_eq!(unchanged_revision, revision);
    }

    #[test]
    fn terminal_manager_close_removes_backend_state() {
        let manager = TerminalProcessManager::default();
        manager
            .create(TerminalPaneRequest {
                pane_id: "pane-close".into(),
                title: "Shell".into(),
                profile_id: Some("shell".into()),
                command: "sh".into(),
                args: vec!["-c".into(), "sleep 5".into()],
                workspace_path: None,
                workspace_mode: None,
                working_directory: None,
                cols: None,
                rows: None,
            })
            .unwrap();

        assert!(manager.processes.lock().unwrap().contains_key("pane-close"));
        manager.close("pane-close").unwrap();

        assert!(!manager.processes.lock().unwrap().contains_key("pane-close"));
        assert!(manager.restore().unwrap().is_empty());
        assert!(manager.read("pane-close", None).is_err());
    }

    #[test]
    fn native_process_allowlists_reject_renderer_command_substitution() {
        assert!(language_server_command_is_allowed("rust", "rust-analyzer"));
        assert!(!language_server_command_is_allowed("rust", "sh -c whoami"));
        assert!(debug_adapter_command_is_allowed(
            "lldb-dap",
            "lldb-dap",
            &[]
        ));
        assert!(!debug_adapter_command_is_allowed(
            "sh",
            "sh",
            &["-c".into()]
        ));

        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(
            workspace.path().join("package.json"),
            r#"{"scripts":{"safe":"echo safe"}}"#,
        )
        .unwrap();
        let error = task_run_blocking(TaskRunRequest {
            workspace_path: workspace.path().display().to_string(),
            task_id: "package:safe".into(),
            command: "sh".into(),
            args: vec!["-c".into(), "whoami".into()],
        })
        .unwrap_err();
        assert!(error.contains("task definition changed"));
    }

    #[test]
    fn private_attachment_storage_is_quota_limited_and_staged_for_deletion() {
        let root = tempfile::tempdir().unwrap();
        let session_id = Uuid::new_v4();
        let session_dir = root.path().join(session_id.to_string());
        std::fs::create_dir(&session_dir).unwrap();
        for index in 0..MAX_STORED_CHAT_ATTACHMENTS_PER_SESSION {
            std::fs::write(session_dir.join(format!("{index}.png")), b"x").unwrap();
        }
        let error = ensure_attachment_storage_quota(&session_dir, &session_dir.join("next.png"), 1)
            .unwrap_err();
        assert!(error.contains("storage limit"));

        let (original, tombstone) = stage_session_attachments(root.path(), session_id)
            .unwrap()
            .unwrap();
        assert!(!original.exists());
        assert!(tombstone.exists());
        remove_attachment_storage_entry(&tombstone).unwrap();
        assert!(!tombstone.exists());
    }

    #[test]
    fn browser_navigation_policy_rejects_credentials_and_non_http_schemes() {
        assert!(browser_preview_diagnostics_supported(
            &url::Url::parse("http://127.0.0.1:3000/").unwrap()
        ));
        assert!(!browser_preview_diagnostics_supported(
            &url::Url::parse("http://user@127.0.0.1:3000/").unwrap()
        ));
        assert!(!browser_preview_diagnostics_supported(
            &url::Url::parse("file://localhost/tmp/private").unwrap()
        ));
    }

    #[test]
    fn workspace_watch_cache_evicts_old_roots() {
        let parent = tempfile::tempdir().unwrap();
        let manager = WorkspaceWatchManager::default();
        for index in 0..=MAX_WORKSPACE_WATCH_CACHES {
            let root = parent.path().join(format!("workspace-{index}"));
            std::fs::create_dir(&root).unwrap();
            manager.snapshot(root.to_str().unwrap()).unwrap();
        }
        assert_eq!(
            manager.snapshots.lock().unwrap().len(),
            MAX_WORKSPACE_WATCH_CACHES
        );
    }

    fn wait_for_terminal_output(
        manager: &TerminalProcessManager,
        pane_id: &str,
        expected: &str,
    ) -> TerminalPaneSnapshot {
        for _ in 0..20 {
            let snapshot = manager.read(pane_id, None).unwrap();
            if snapshot
                .output
                .as_deref()
                .unwrap_or_default()
                .contains(expected)
                && snapshot.status != "running"
            {
                return snapshot;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        manager.read(pane_id, None).unwrap()
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
