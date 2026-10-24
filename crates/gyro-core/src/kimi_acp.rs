use crate::acp_usage::{self, AcpContextUsage, AcpProvider, AcpRuntimeInfo, AcpUsageObservation};
use crate::credentials::{
    provider_id_from_program, try_apply_stored_provider_api_key, CredentialPolicy,
};
use crate::execution::{configure_process_group, register_process_group, terminate_process_group};
use crate::security::redact_secrets;
use crate::CancellationToken;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

const ACP_PROTOCOL_VERSION: u64 = 1;
const ACP_MAX_FRAME_BYTES: usize = 1024 * 1024;
// Outgoing prompts include up to 64 MiB of attachments plus base64/JSON
// encoding and context. Keep the untrusted incoming frame limit independent.
const ACP_MAX_REQUEST_BYTES: usize = 128 * 1024 * 1024;
const ACP_MAX_MESSAGES: usize = 50_000;
const ACP_MAX_TOTAL_BYTES: usize = 128 * 1024 * 1024;
const ACP_MAX_STDERR_CHARS: usize = 64 * 1024;
const ACP_MAX_FILE_BYTES: usize = 2 * 1024 * 1024;
const ACP_POLL_INTERVAL: Duration = Duration::from_millis(25);
const KIMI_USAGE_PROBE_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KimiAcpMode {
    Normal,
    Plan,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KimiAcpApprovalKind {
    Command,
    FileChange,
    Other,
}

/// Plan mode blocks file writes. It does not block commands.
///
/// Grok treats `reject_once` on a shell tool as the person declining it and
/// ends the whole turn (`permission_rejected`). Gyro then showed that as
/// Stopped. A local backend check that runs `grok models --help` died that
/// way. File edits stay rejected. Commands use the turn's normal approval
/// policy, which already allows them when command approval is off.
pub fn plan_mode_denies_approval(kind: KimiAcpApprovalKind) -> bool {
    kind == KimiAcpApprovalKind::FileChange
}

/// Sent to the agent when its own decline ended the prompt.
///
/// The agent has already dropped the turn on a rejected permission. One short
/// note lets it route around that call instead of the person losing the rest
/// of the work and having to send the task again.
const DECLINED_TOOL_CONTINUATION: &str = "Gyro declined one tool permission. \
Do not retry that exact action. Continue with the remaining steps of the goal, \
and say plainly what you could not do.";

/// How many times one turn may be re-asked after the agent stopped its own turn.
/// Agents report a declined or failed tool as their own stop, and a turn that
/// does real work can meet more than one.
pub const ACP_AGENT_STOP_RECOVERY_ATTEMPTS: usize = 3;

/// Sent to the agent when its own output limit ended the prompt mid-answer.
///
/// Grok, Kimi and OpenCode all end a long answer at the model's output cap
/// instead of failing it, and ACP reports that as a normal stopped prompt. The
/// turn then looked finished while the text stopped mid-word. Asking the same
/// session to carry on is what turns that into one complete answer.
pub const ACP_OUTPUT_LIMIT_CONTINUATION: &str = "Your previous message stopped at the \
output limit before the answer was finished. Continue from the exact character where \
you stopped, with no preamble and without repeating what you already wrote.";

/// Whether a stop reason means the agent ran out of room rather than finishing.
///
/// ACP names the limit `max_tokens` or `max_turn_requests`; agents built on it
/// spell the same stop with their own casing, underscores, or a word of their
/// own. Matching the shape instead of one literal spelling keeps every agent on
/// this path honest about a cut-off answer.
fn acp_stop_is_output_limit(reason: &str) -> bool {
    let normalized = reason
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    matches!(
        normalized.as_str(),
        "maxtokens"
            | "maxoutputtokens"
            | "maxcompletiontokens"
            | "tokenslimit"
            | "tokenlimit"
            | "length"
            | "maxturnrequests"
            | "maxturns"
            | "turnlimit"
            | "maxsteps"
            | "steplimit"
            | "maxrequests"
            | "requestlimit"
            | "contextlimit"
            | "maxcontexttokens"
    )
}

fn acp_stop_is_end_turn(reason: &str) -> bool {
    let normalized = reason
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    normalized == "endturn"
}

/// A boolean the provider set on this result. Token totals and prose are not a cut.
fn acp_result_marks_output_truncated(result: &Value) -> bool {
    result.get("truncated").and_then(Value::as_bool) == Some(true)
        || result
            .pointer("/_meta/truncated")
            .and_then(Value::as_bool)
            == Some(true)
}

fn acp_result_needs_output_continuation(reason: &str, result: &Value) -> bool {
    acp_stop_is_output_limit(reason)
        || (acp_stop_is_end_turn(reason) && acp_result_marks_output_truncated(result))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KimiAcpApprovalDecision {
    AllowOnce,
    RejectOnce,
    Cancelled,
}

#[derive(Clone, Debug)]
pub struct KimiAcpApprovalRequest {
    pub kind: KimiAcpApprovalKind,
    pub tool_call: Value,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KimiAcpActivity {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub detail: Option<String>,
    /// Lines added and removed, measured from the call's ACP `diff` content.
    pub file_counts: Option<(usize, usize)>,
    pub status: String,
    /// Live occupancy from the agent. Kept separate from billed usage.
    pub context_usage: Option<AcpContextUsage>,
}

#[derive(Clone, Debug)]
pub struct KimiAcpRequest {
    pub provider_label: String,
    pub program: OsString,
    pub program_args: Vec<OsString>,
    pub auth_method_ids: Vec<String>,
    pub workspace: PathBuf,
    pub prompt: Vec<Value>,
    /// Short turn prompt for a successfully reopened session. A failed reopen
    /// still uses `prompt`, which contains the guidance a fresh agent needs.
    pub resumed_prompt: Option<String>,
    /// Prior Gyro-chat turns, used only when the agent cannot reopen its ACP
    /// session (Grok often lacks `session/resume`). Injected into a fresh
    /// `session/new` so multi-turn still has context.
    pub conversation_history_text: Option<String>,
    /// Stdio MCP servers to expose to the agent, in ACP `session/new` form.
    /// Empty leaves the agent with only its own built-in tools.
    pub mcp_servers: Vec<Value>,
    pub model: String,
    /// Override the agent's thinking level only when the user selected one.
    pub reasoning_effort: Option<String>,
    pub mode: KimiAcpMode,
    /// Full access: answer the agent's permission requests with an allow option
    /// without asking anyone. A card that never resolves, or a host that cannot
    /// answer it, must not become a declined tool -- agents end the whole turn
    /// for that, and every step around it is lost.
    pub auto_allow_permissions: bool,
    pub resume_session_id: Option<String>,
    pub timeout: Duration,
    pub inactivity_timeout: Duration,
    pub cancellation: CancellationToken,
    /// Which inherited credentials the agent process may keep. ACP agents run
    /// tool calls as their own children, so this is the point where an agent's
    /// whole subprocess tree stops seeing the user's unrelated secrets.
    pub credentials: CredentialPolicy,
    /// Filled with the agent's session id as soon as the session is open, so a
    /// caller can keep the conversation when the run is stopped or fails before
    /// it returns an output.
    pub opened_session: Option<std::sync::Arc<std::sync::Mutex<Option<String>>>>,
}

#[derive(Clone, Debug)]
pub struct KimiAcpOutput {
    pub response: String,
    pub session_id: String,
    pub stop_reason: String,
    /// The agent stopped because it ran out of room, not because it finished.
    /// The response is real work up to that point, so it is kept and flagged
    /// rather than failed.
    pub truncated: bool,
    pub resumed: bool,
    pub duration_ms: u64,
    /// Compatibility copy of the provider's usage object. Its semantics depend
    /// on the provider; use usage_observation for accounting.
    pub usage: Option<Value>,
    pub usage_observation: AcpUsageObservation,
    /// Occupancy from usage_update, never a billed token reading.
    pub context_usage: Option<AcpContextUsage>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KimiAcpHealthStatus {
    Ready,
    NotInstalled,
    NotLoggedIn,
    Warning,
}

#[derive(Clone, Debug)]
pub struct KimiAcpHealth {
    pub status: KimiAcpHealthStatus,
    pub output: String,
}

struct IncomingFrame {
    value: Value,
    bytes: usize,
}

struct KimiAcpConnection {
    provider_label: String,
    child: crate::process_guard::GuardedChild,
    stdin: ChildStdin,
    incoming: Receiver<Result<IncomingFrame, String>>,
    stderr: Receiver<String>,
    next_id: u64,
    messages: usize,
    total_bytes: usize,
    started_at: Instant,
    last_activity_at: Instant,
    timeout: Duration,
    inactivity_timeout: Duration,
    cancellation: CancellationToken,
    stderr_text: String,
    usage_provider: AcpProvider,
    runtime_info: AcpRuntimeInfo,
    collecting_usage: bool,
    usage_observation: Option<AcpUsageObservation>,
    context_usage: Option<AcpContextUsage>,
    /// Set once a wire frame, rather than a /usage text line, supplied occupancy.
    context_from_wire: bool,
    bound_session_id: Option<String>,
    /// Full access was chosen for this run, so a permission request is answered
    /// with an allow option here and never reaches an approval card.
    auto_allow_permissions: bool,
    /// Set when a permission request was answered with a rejection. Some agents
    /// end the whole prompt for that alone, so the run resumes after it.
    declined_permission: bool,
}

impl Drop for KimiAcpConnection {
    fn drop(&mut self) {
        terminate_process_group(&mut self.child);
    }
}

impl KimiAcpConnection {
    fn start(request: &KimiAcpRequest) -> Result<Self> {
        let mut command = Command::new(&request.program);
        command
            .args(&request.program_args)
            .current_dir(&request.workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if !request.program.to_string_lossy().contains('/') {
            command.env("PATH", crate::cli_path::augmented_gui_path());
        }
        for (key, _) in request.credentials.env_overrides() {
            command.env_remove(key);
        }
        if let Some(provider_id) = provider_id_from_program(&request.program.to_string_lossy()) {
            try_apply_stored_provider_api_key(&mut command, provider_id)?;
        }
        if std::path::Path::new(&request.program)
            .file_name()
            .is_some_and(|name| name == "opencode")
            || request.provider_label == "OpenCode"
        {
            // OpenCode defaults to allowing native tools. Require its ACP
            // permission callbacks so Gyro can apply the user's policy.
            // Agent-specific OpenCode configuration can override this default;
            // live validation is still required before declaring full support.
            command.env("OPENCODE_PERMISSION", r#"{"*":"ask","read":{"*":"ask","*.env":"deny","*.env.*":"deny"},"edit":"ask","bash":"ask","task":"ask","external_directory":"ask"}"#);
        }
        configure_process_group(&mut command);
        let mut child = crate::process_guard::spawn_guarded(&mut command).map_err(|error| {
            anyhow!(
                "start {} through ACP: {error}",
                request.program.to_string_lossy()
            )
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("{} ACP stdin was unavailable", request.provider_label))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("{} ACP stdout was unavailable", request.provider_label))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow!("{} ACP stderr was unavailable", request.provider_label))?;

        let (incoming_sender, incoming) = mpsc::sync_channel(128);
        let reader_provider_label = request.provider_label.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut bytes = Vec::new();
                match (&mut reader)
                    .take((ACP_MAX_FRAME_BYTES + 1) as u64)
                    .read_until(b'\n', &mut bytes)
                {
                    Ok(0) => break,
                    Ok(_) if bytes.len() > ACP_MAX_FRAME_BYTES => {
                        let _ = incoming_sender.send(Err(format!(
                            "{reader_provider_label} ACP frame exceeded its size limit"
                        )));
                        break;
                    }
                    Ok(_) => {
                        while matches!(bytes.last(), Some(b'\n' | b'\r')) {
                            bytes.pop();
                        }
                        if bytes.is_empty() {
                            continue;
                        }
                        let size = bytes.len();
                        let value = serde_json::from_slice(&bytes)
                            .map(|value| IncomingFrame { value, bytes: size })
                            .map_err(|error| {
                                format!("invalid {reader_provider_label} ACP JSON: {error}")
                            });
                        if incoming_sender.send(value).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = incoming_sender.send(Err(format!(
                            "read {reader_provider_label} ACP output: {error}"
                        )));
                        break;
                    }
                }
            }
        });

        let (stderr_sender, stderr_receiver) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let mut reader = stderr;
            let mut collected = String::new();
            let mut buffer = [0_u8; 4096];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        let text = String::from_utf8_lossy(&buffer[..read]);
                        append_bounded(&mut collected, &text, ACP_MAX_STDERR_CHARS);
                    }
                    Err(_) => break,
                }
            }
            let _ = stderr_sender.send(collected);
        });

        // Tracked from here on, where `Drop` owns teardown (which also
        // unregisters it), so app quit can reach a live ACP agent too.
        register_process_group(child.id());
        let now = Instant::now();
        Ok(Self {
            provider_label: request.provider_label.clone(),
            child,
            stdin,
            incoming,
            stderr: stderr_receiver,
            next_id: 1,
            messages: 0,
            total_bytes: 0,
            started_at: now,
            last_activity_at: now,
            timeout: request.timeout,
            inactivity_timeout: request.inactivity_timeout,
            cancellation: request.cancellation.clone(),
            stderr_text: String::new(),
            usage_provider: {
                let program_name = Path::new(&request.program)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default();
                let provider = AcpProvider::from_label(program_name);
                if provider == AcpProvider::Unknown {
                    AcpProvider::from_label(&request.provider_label)
                } else {
                    provider
                }
            },
            runtime_info: AcpRuntimeInfo::default(),
            collecting_usage: false,
            usage_observation: None,
            context_usage: None,
            context_from_wire: false,
            bound_session_id: None,
            auto_allow_permissions: request.auto_allow_permissions,
            declined_permission: false,
        })
    }

    fn begin_usage(&mut self) {
        self.collecting_usage = true;
        // Clear replayed context: a resumed session may send historical updates.
        self.context_usage = None;
        self.context_from_wire = false;
        let observation = acp_usage::normalize_prompt_usage(
            self.usage_provider,
            &Value::Null,
            self.runtime_info.clone(),
        );
        crate::provider_observation::native_acp_usage(&observation);
        self.usage_observation = Some(observation);
    }

    /// Remember occupancy for this turn.
    ///
    /// A frame that does not name a window keeps the size already known.
    /// Unchanged numbers do not publish another activity. `from_wire` marks a
    /// session update so a later /usage text line cannot overwrite it.
    fn note_live_context(
        &mut self,
        mut context: AcpContextUsage,
        from_wire: bool,
    ) -> Option<AcpContextUsage> {
        if !self.collecting_usage {
            return None;
        }
        if context.size == 0 {
            if let Some(previous) = self.context_usage {
                context.size = previous.size;
            }
        }
        if from_wire {
            self.context_from_wire = true;
        }
        if self.context_usage.is_some_and(|current| current == context) {
            return None;
        }
        self.context_usage = Some(context);
        Some(context)
    }

    fn observe_prompt_response(&mut self, message: &Value) {
        let value = message.get("result").unwrap_or(message);
        let mut observation = acp_usage::normalize_prompt_usage(
            self.usage_provider,
            value,
            self.runtime_info.clone(),
        );
        if message.get("error").is_some()
            || value
                .get("stopReason")
                .and_then(Value::as_str)
                .is_some_and(|reason| matches!(reason, "cancelled" | "refusal"))
        {
            observation.interrupted();
        }
        crate::provider_observation::native_acp_usage(&observation);
        self.usage_observation = Some(observation);
    }

    fn interrupted_usage(&mut self) {
        if let Some(observation) = &mut self.usage_observation {
            observation.interrupted();
            crate::provider_observation::native_acp_usage(&observation);
        }
    }

    fn send_request(&mut self, method: &str, params: Value) -> Result<u64> {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        self.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))?;
        Ok(id)
    }

    fn send_notification(&mut self, method: &str, params: Value) -> Result<()> {
        self.send(json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
    }

    fn send_result(&mut self, id: Value, result: Value) -> Result<()> {
        self.send(json!({"jsonrpc": "2.0", "id": id, "result": result}))
    }

    fn send_error(&mut self, id: Value, code: i64, message: &str) -> Result<()> {
        self.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {"code": code, "message": message},
        }))
    }

    fn send(&mut self, value: Value) -> Result<()> {
        let bytes = serde_json::to_vec(&value)?;
        if bytes.len() > ACP_MAX_REQUEST_BYTES {
            anyhow::bail!(
                "{} ACP request exceeded its size limit",
                self.provider_label
            );
        }
        self.stdin.write_all(&bytes)?;
        self.stdin.write_all(b"\n")?;
        self.stdin.flush()?;
        Ok(())
    }

    fn receive(&mut self) -> Result<Value> {
        self.receive_until(None)
    }

    fn receive_until(&mut self, deadline: Option<Instant>) -> Result<Value> {
        loop {
            if self.cancellation.is_cancelled() {
                anyhow::bail!("{} ACP run cancelled", self.provider_label);
            }
            if self.started_at.elapsed() >= self.timeout {
                anyhow::bail!("{} ACP run timed out", self.provider_label);
            }
            if self.last_activity_at.elapsed() >= self.inactivity_timeout {
                anyhow::bail!("{} ACP run became inactive", self.provider_label);
            }
            if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                anyhow::bail!("{} ACP usage query timed out", self.provider_label);
            }
            match self.incoming.recv_timeout(ACP_POLL_INTERVAL) {
                Ok(Ok(frame)) => {
                    self.messages += 1;
                    self.total_bytes = self.total_bytes.saturating_add(frame.bytes);
                    if self.messages > ACP_MAX_MESSAGES || self.total_bytes > ACP_MAX_TOTAL_BYTES {
                        anyhow::bail!(
                            "{} ACP output exceeded its bounded protocol budget",
                            self.provider_label
                        );
                    }
                    self.last_activity_at = Instant::now();
                    return Ok(frame.value);
                }
                Ok(Err(error)) => anyhow::bail!(error),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if let Ok(stderr) = self.stderr.try_recv() {
                        self.stderr_text = stderr;
                    }
                    // The reader may still be delivering the child's final
                    // frame after process exit. Let channel EOF establish that
                    // stdout is drained; inspecting try_wait here can discard
                    // a response (or its parse error) under scheduling load.
                    // Cancellation and the run deadline still bound this wait.
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    let stderr = self
                        .stderr
                        .recv_timeout(Duration::from_millis(100))
                        .unwrap_or_default();
                    anyhow::bail!(
                        "{} ACP closed its protocol stream: {}",
                        self.provider_label,
                        redact_secrets(stderr.trim())
                    );
                }
            }
        }
    }

    fn supports_kimi_usage_probe(&self) -> bool {
        self.usage_provider == AcpProvider::Kimi
            && acp_usage::kimi_code_037_usage_supported(&self.runtime_info)
            && std::env::var_os("KIMI_CODE_LEGACY_FLAG").is_none()
    }

    /// A local command on the exact verified runtime, never a model generation.
    /// Its text stays private to this reader and never reaches chat callbacks.
    fn kimi_usage_probe(
        &mut self,
        session_id: &str,
    ) -> Result<Option<acp_usage::KimiCodeUsageSnapshot>> {
        let id = self.send_request(
            "session/prompt",
            json!({
                "sessionId": session_id, "prompt": [{"type": "text", "text": "/usage"}],
            }),
        )?;
        let deadline = Instant::now() + KIMI_USAGE_PROBE_TIMEOUT;
        let mut report = String::new();
        for _ in 0..128 {
            let message = self.receive_until(Some(deadline))?;
            if message.get("method").is_none()
                && message.get("id").and_then(Value::as_u64) == Some(id)
            {
                return Ok(message
                    .get("result")
                    .filter(|result| {
                        result.get("stopReason").and_then(Value::as_str) == Some("end_turn")
                    })
                    .and_then(|_| acp_usage::parse_kimi_code_037_usage_report(&report)));
            }
            if message.get("method").and_then(Value::as_str) == Some("session/update") {
                let Some(params) = message.get("params") else {
                    continue;
                };
                if params.get("sessionId").and_then(Value::as_str) != Some(session_id) {
                    continue;
                }
                let Some(update) = params.get("update") else {
                    continue;
                };
                if self.collecting_usage {
                    if let Some(context) = acp_usage::live_context_usage(update) {
                        let _ = self.note_live_context(context, true);
                    }
                }
                if update.get("sessionUpdate").and_then(Value::as_str)
                    == Some("agent_message_chunk")
                {
                    let Some(text) = update.pointer("/content/text").and_then(Value::as_str) else {
                        continue;
                    };
                    anyhow::ensure!(
                        report.len().saturating_add(text.len()) <= 4096,
                        "Kimi ACP usage report exceeded its size limit"
                    );
                    report.push_str(text);
                }
            } else if message.get("method").is_some() {
                // Metadata must not execute tools or request approvals. Refuse
                // an unexpected reverse request without invoking chat handlers.
                if let Some(id) = message.get("id") {
                    self.send_error(id.clone(), -32601, "unsupported during usage query")?;
                    anyhow::bail!("Kimi ACP usage query requested an unexpected operation");
                }
            }
        }
        anyhow::bail!("Kimi ACP usage query exceeded its frame limit")
    }
}

pub fn run_kimi_acp<Delta, Activity, Approval, WriteFile>(
    request: KimiAcpRequest,
    mut on_delta: Delta,
    mut on_activity: Activity,
    mut on_approval: Approval,
    mut on_write_file: WriteFile,
) -> Result<KimiAcpOutput>
where
    Delta: FnMut(&str),
    Activity: FnMut(&KimiAcpActivity),
    Approval: FnMut(&KimiAcpApprovalRequest) -> Result<KimiAcpApprovalDecision>,
    WriteFile: FnMut(&Path, &str) -> Result<()>,
{
    run_kimi_acp_with_usage_probe(
        request,
        &mut on_delta,
        &mut on_activity,
        &mut on_approval,
        &mut on_write_file,
        true,
    )
}

fn run_kimi_acp_with_usage_probe<Delta, Activity, Approval, WriteFile>(
    mut request: KimiAcpRequest,
    mut on_delta: &mut Delta,
    mut on_activity: &mut Activity,
    mut on_approval: &mut Approval,
    mut on_write_file: &mut WriteFile,
    allow_usage_probe: bool,
) -> Result<KimiAcpOutput>
where
    Delta: FnMut(&str),
    Activity: FnMut(&KimiAcpActivity),
    Approval: FnMut(&KimiAcpApprovalRequest) -> Result<KimiAcpApprovalDecision>,
    WriteFile: FnMut(&Path, &str) -> Result<()>,
{
    let started_at = Instant::now();
    crate::timing::mark(crate::timing::Stage::ProcessStart);
    let mut connection = KimiAcpConnection::start(&request)?;
    crate::timing::mark(crate::timing::Stage::ProcessSpawned);
    let mut response = String::new();
    let mut client_capabilities = json!({
        "fs": {"readTextFile": true, "writeTextFile": true},
        "terminal": false,
    });
    // Grok sends live occupancy only when the client asks for the status line.
    // The capability is the request. Gyro does not run a status-line script.
    if is_grok_acp_program(&request.program) {
        client_capabilities["_meta"] = json!({ "x.ai/statusLine": true });
    }
    let initialize_id = connection.send_request(
        "initialize",
        json!({
            "protocolVersion": ACP_PROTOCOL_VERSION,
            "clientInfo": {"name": "Gyro", "version": env!("CARGO_PKG_VERSION")},
            "clientCapabilities": client_capabilities,
        }),
    )?;
    let initialize = wait_for_response(
        &mut connection,
        initialize_id,
        &request.workspace,
        &mut response,
        &mut on_delta,
        &mut on_activity,
        &mut on_approval,
        &mut on_write_file,
    )?;
    let advertised_auth_methods = initialize
        .get("authMethods")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|method| method.get("id").and_then(Value::as_str))
        .collect::<Vec<_>>();
    let auth_method = request
        .auth_method_ids
        .iter()
        .find(|method| {
            advertised_auth_methods.is_empty() || advertised_auth_methods.contains(&method.as_str())
        })
        .cloned()
        .or_else(|| {
            advertised_auth_methods
                .first()
                .map(|method| (*method).to_string())
        });
    if let Some(auth_method) = auth_method {
        let authenticate_id =
            connection.send_request("authenticate", json!({"methodId": auth_method}))?;
        wait_for_response(
            &mut connection,
            authenticate_id,
            &request.workspace,
            &mut response,
            &mut on_delta,
            &mut on_activity,
            &mut on_approval,
            &mut on_write_file,
        )?;
    }

    // Grok (and some other ACP agents) do not implement every session method
    // Kimi does. Prefer the reopen method the agent advertises; if reopen fails
    // with Method not found, fall back to session/new and inject history.
    let (session_id, resumed, reopened_as_fresh, offered_models) = open_acp_session(
        &mut connection,
        &request,
        &initialize,
        &mut response,
        &mut on_delta,
        &mut on_activity,
        &mut on_approval,
        &mut on_write_file,
    )?;
    connection.bound_session_id = Some(session_id.clone());
    if !allow_usage_probe && request.resume_session_id.is_some() && !resumed {
        anyhow::bail!(
            "{} could not reopen its session after a usage query; no generation was sent",
            request.provider_label
        );
    }
    if let Some(slot) = &request.opened_session {
        if let Ok(mut slot) = slot.lock() {
            *slot = Some(session_id.clone());
        }
    }

    // Grok takes model/effort as process flags. In-session
    // session/set_model and session/set_config_option often return Method not
    // found and must not fail the turn.
    let skip_in_session_config = is_grok_acp_program(&request.program);
    if !skip_in_session_config
        && !request.model.trim().is_empty()
        && !request.model.ends_with("-default")
    {
        let model_id = connection.send_request(
            "session/set_model",
            json!({
                "sessionId": session_id,
                "modelId": acp_model_id(&request.model, &offered_models),
            }),
        )?;
        // An advertised pre-selection model is stale after a successful switch.
        // Restore it only when the switch failed; otherwise retain only a model
        // identity returned by the runtime itself.
        let previous_model = connection.runtime_info.model_id.take();
        let model_result = wait_for_response(
            &mut connection,
            model_id,
            &request.workspace,
            &mut response,
            &mut on_delta,
            &mut on_activity,
            &mut on_approval,
            &mut on_write_file,
        );
        if let Err(error) = model_result {
            connection.runtime_info.model_id = previous_model;
            // An explicit Google model must not silently run the CLI default.
            if provider_id_from_program(&request.program.to_string_lossy())
                .is_some_and(|id| matches!(id, "gemini" | "antigravity"))
                || matches!(
                    request.provider_label.as_str(),
                    "Gemini" | "Google Antigravity"
                )
            {
                anyhow::bail!(
                    "{} could not select model {}: {error}",
                    request.provider_label,
                    request.model
                );
            }
        }
    }
    if !skip_in_session_config && request.reasoning_effort.is_some() {
        let thinking_id = connection.send_request(
            "session/set_config_option",
            json!({
                "sessionId": session_id,
                "configId": "thinking",
                "value": request.reasoning_effort,
            }),
        )?;
        let _ = wait_for_response(
            &mut connection,
            thinking_id,
            &request.workspace,
            &mut response,
            &mut on_delta,
            &mut on_activity,
            &mut on_approval,
            &mut on_write_file,
        );
    }
    if request.mode == KimiAcpMode::Plan {
        let mode_id = connection.send_request(
            "session/set_mode",
            json!({"sessionId": session_id, "modeId": "plan"}),
        )?;
        let _ = wait_for_response(
            &mut connection,
            mode_id,
            &request.workspace,
            &mut response,
            &mut on_delta,
            &mut on_activity,
            &mut on_approval,
            &mut on_write_file,
        );
    }

    crate::timing::mark(crate::timing::Stage::ProtocolReady);
    let mut prompt = std::mem::take(&mut request.prompt);
    if resumed {
        if let Some(short_prompt) = request.resumed_prompt.as_deref() {
            if let Some(text) = prompt.first_mut().and_then(|part| part.get_mut("text")) {
                *text = Value::String(short_prompt.to_string());
            }
        }
    }
    // Gyro sessions are local. Whenever this provider turn is not continuing an
    // open agent session — first turn after a model handoff, failed reopen, or
    // an agent that never supported resume — inject the local transcript so any
    // model can pick up where another left off.
    if !resumed {
        if let Some(history) = request
            .conversation_history_text
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty())
        {
            let reason = if reopened_as_fresh {
                "the agent session could not be reopened"
            } else {
                "this is a fresh agent session for a local Gyro chat handoff"
            };
            prompt.insert(
                0,
                json!({
                    "type": "text",
                    "text": format!(
                        "Prior conversation in this Gyro chat ({reason}, so this is continuity context):\n{history}"
                    ),
                }),
            );
        }
    }

    let usage_baseline = if allow_usage_probe && connection.supports_kimi_usage_probe() {
        match connection.kimi_usage_probe(&session_id) {
            Ok(snapshot) => snapshot,
            Err(_) if !request.cancellation.is_cancelled() => {
                // A timed-out metadata response can arrive late as uncorrelated
                // session/update text. Reopen before the one real generation,
                // so it can never leak into or replace the user's answer.
                drop(connection);
                let mut retry = request;
                retry.resume_session_id = Some(session_id);
                retry.resumed_prompt = None;
                retry.prompt = prompt;
                retry.conversation_history_text = None;
                retry.timeout = retry.timeout.saturating_sub(started_at.elapsed());
                let mut output = run_kimi_acp_with_usage_probe(
                    retry,
                    on_delta,
                    on_activity,
                    on_approval,
                    on_write_file,
                    false,
                )?;
                output.resumed &= resumed;
                output.duration_ms = started_at.elapsed().as_millis().min(u64::MAX as u128) as u64;
                return Ok(output);
            }
            Err(error) => return Err(error),
        }
    } else {
        None
    };

    crate::timing::mark(crate::timing::Stage::PromptSent);
    crate::provider_observation::native_prompt(&json!(prompt));
    connection.begin_usage();
    // The before-probe ran first and begin_usage cleared its replay. A resumed
    // Kimi session can still show that occupancy as soon as the turn starts.
    if let Some(context) = usage_baseline
        .as_ref()
        .and_then(|snapshot| snapshot.context)
    {
        publish_live_context(&mut connection, context, false, on_activity);
    }
    // Do not seed Grok from the serialized prompt. Its JSON character length is
    // not the model's token count. Grok sends that count as `_meta.totalTokens`
    // on the updates that follow. Tool text is not a count and does not fill
    // the meter while those frames are still arriving.
    let prompt_id = connection.send_request(
        "session/prompt",
        json!({"sessionId": session_id, "prompt": prompt}),
    )?;
    connection.declined_permission = false;
    let result = wait_for_response(
        &mut connection,
        prompt_id,
        &request.workspace,
        &mut response,
        &mut on_delta,
        &mut on_activity,
        &mut on_approval,
        &mut on_write_file,
    );
    if request.cancellation.is_cancelled() {
        let _ = connection.send_notification("session/cancel", json!({"sessionId": session_id}));
    }
    if result.is_err() {
        connection.interrupted_usage();
    }
    let mut result = result?;
    // An agent-side cancel drops every step after it, and a rejected permission
    // is reported exactly like the agent's own stop. An output-limit stop is the
    // third shape of the same event: the agent ends the prompt mid-answer and
    // ACP calls it a normal result, so the turn looked finished while the text
    // stopped inside a word. Ask the same session to carry on instead of failing
    // a turn that already did work. One attempt was not enough: a long turn can
    // meet a second stop, and dying there lost every step around it. The attempts
    // are bounded, so a run that keeps stopping still surfaces instead of
    // looping.
    let mut agent_stops = 0usize;
    loop {
        if request.cancellation.is_cancelled() || agent_stops >= ACP_AGENT_STOP_RECOVERY_ATTEMPTS {
            break;
        }
        let stopped = result
            .get("stopReason")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let cut_short = acp_result_needs_output_continuation(stopped, &result);
        if stopped != "cancelled" && !cut_short {
            break;
        }
        agent_stops += 1;
        // Each attempt is judged on its own: a decline during the first one must
        // not make the last one read as a decline too.
        connection.declined_permission = false;
        // A cancelled turn dropped whole steps, so its continuation reads as a
        // new paragraph. An output-limit turn stopped inside a word: joining the
        // halves with nothing between them is what puts that word back together.
        if !cut_short && !response.trim().is_empty() && !response.ends_with('\n') {
            response.push_str("\n\n");
        }
        let continuation = if cut_short {
            ACP_OUTPUT_LIMIT_CONTINUATION
        } else {
            DECLINED_TOOL_CONTINUATION
        };
        crate::provider_observation::native_prompt(&json!(continuation));
        let continuation_id = connection.send_request(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [{"type": "text", "text": continuation}],
            }),
        )?;
        result = wait_for_response(
            &mut connection,
            continuation_id,
            &request.workspace,
            &mut response,
            &mut on_delta,
            &mut on_activity,
            &mut on_approval,
            &mut on_write_file,
        )?;
    }
    // A live frame wins. These prompt fields are last-call context only when
    // that frame never arrived, and only when the contract says the field is
    // one request rather than the summed bill.
    if !connection.context_from_wire {
        let context = match connection.usage_provider {
            AcpProvider::Grok => acp_usage::grok_prompt_context(&result),
            AcpProvider::OpenCode => acp_usage::opencode_prompt_context(&result),
            _ => None,
        };
        if let Some(context) = context {
            publish_live_context(&mut connection, context, false, on_activity);
        }
    }
    if let Some(baseline) = usage_baseline {
        if !request.cancellation.is_cancelled() {
            if let Ok(Some(after)) = connection.kimi_usage_probe(&session_id) {
                // The probe stores a usage_update on the wire. A text line fills
                // occupancy only when that update never arrived, including when
                // the only reading so far is the pre-turn baseline.
                if let Some(context) = after.context {
                    if connection.context_usage.is_none() || !connection.context_from_wire {
                        publish_live_context(&mut connection, context, false, on_activity);
                    }
                }
                let observation = acp_usage::kimi_code_037_usage_delta(
                    baseline,
                    after,
                    connection.runtime_info.clone(),
                );
                crate::provider_observation::native_acp_usage(&observation);
                connection.usage_observation = Some(observation);
            }
        }
    }
    if request.cancellation.is_cancelled() {
        connection.interrupted_usage();
        anyhow::bail!("{} ACP run cancelled", request.provider_label);
    }
    let stop_reason = result
        .get("stopReason")
        .and_then(Value::as_str)
        .filter(|reason| !reason.trim().is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "{} ACP prompt response is missing its stopReason",
                request.provider_label
            )
        })?
        .to_string();
    // A JSON-RPC result only establishes that the prompt request ended.
    // Cancellation and refusal must reach the caller's existing non-success
    // paths, even when the agent streamed text before stopping.
    match stop_reason.as_str() {
        // A Stop the person already asked for is handled above, where the
        // token is already cancelled. This branch is the agent ending the
        // prompt on its own — a declined tool, for example. Setting the
        // shared token here made Gyro report "You stopped this turn."
        "cancelled" => {
            // The continuation above already gave the agent one chance to carry
            // on, so this is a real stop. Say what happened instead of blaming
            // a permission nobody declined.
            anyhow::bail!(
                "{} ended the turn without finishing{}",
                request.provider_label,
                if connection.declined_permission {
                    " because a tool permission was declined"
                } else {
                    ""
                }
            );
        }
        "refusal" => {
            anyhow::bail!("{} ACP agent refused to continue", request.provider_label);
        }
        // Every other reason finished the turn. An output limit did not: the
        // answer is real but unfinished, so it is kept and flagged instead of
        // being reported as a complete answer.
        _ => {}
    }
    let truncated = acp_result_needs_output_continuation(&stop_reason, &result);
    Ok(KimiAcpOutput {
        response: response.trim().to_string(),
        session_id,
        stop_reason,
        truncated,
        resumed,
        duration_ms: started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
        usage: acp_usage::prompt_usage_object(&result),
        usage_observation: connection.usage_observation.take().unwrap_or_else(|| {
            acp_usage::normalize_prompt_usage(
                connection.usage_provider,
                &result,
                connection.runtime_info.clone(),
            )
        }),
        context_usage: connection.context_usage,
    })
}

fn is_grok_acp_program(program: &OsString) -> bool {
    Path::new(program)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == "grok" || name.starts_with("grok-"))
}

/// Whether the agent advertises ACP session reopen via resume or load.
fn acp_session_reopen_methods(initialize: &Value) -> (bool, bool) {
    let caps = initialize.get("agentCapabilities");
    let supports_resume = caps
        .and_then(|value| value.pointer("/sessionCapabilities/resume"))
        .is_some()
        || caps
            .and_then(|value| value.get("sessionCapabilities"))
            .and_then(|value| value.get("resume"))
            .is_some();
    let supports_load = caps
        .and_then(|value| value.get("loadSession"))
        .and_then(Value::as_bool)
        == Some(true)
        || caps
            .and_then(|value| value.get("load_session"))
            .and_then(Value::as_bool)
            == Some(true);
    (supports_resume, supports_load)
}

fn is_acp_method_not_found(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("method not found")
        || normalized.contains("method_not_found")
        || normalized.contains("\"code\":-32601")
        || normalized.contains("code\": -32601")
        || normalized.contains("-32601")
}

/// Open or reopen an ACP session using the methods the agent actually supports.
///
/// Returns `(session_id, resumed, reopened_as_fresh)`.
/// `reopened_as_fresh` is true when a stored cursor could not be reopened and a
/// new session was created instead — the caller should inject transcript history.
#[allow(clippy::too_many_arguments)]
fn open_acp_session<Delta, Activity, Approval, WriteFile>(
    connection: &mut KimiAcpConnection,
    request: &KimiAcpRequest,
    initialize: &Value,
    response: &mut String,
    on_delta: &mut Delta,
    on_activity: &mut Activity,
    on_approval: &mut Approval,
    on_write_file: &mut WriteFile,
) -> Result<(String, bool, bool, Vec<String>)>
where
    Delta: FnMut(&str),
    Activity: FnMut(&KimiAcpActivity),
    Approval: FnMut(&KimiAcpApprovalRequest) -> Result<KimiAcpApprovalDecision>,
    WriteFile: FnMut(&Path, &str) -> Result<()>,
{
    let Some(resume_session_id) = request.resume_session_id.as_deref() else {
        let (session_id, offered_models) = create_acp_session(
            connection,
            request,
            response,
            on_delta,
            on_activity,
            on_approval,
            on_write_file,
        )?;
        return Ok((session_id, false, false, offered_models));
    };

    let (supports_resume, supports_load) = acp_session_reopen_methods(initialize);
    let reopen_payload = json!({
        "sessionId": resume_session_id,
        "cwd": request.workspace,
        "mcpServers": request.mcp_servers,
    });

    // Order: resume when advertised (Kimi-shaped), else load when advertised
    // (Grok-shaped). When neither capability is advertised, try both
    // before falling back — some CLIs omit flags but still implement one.
    let mut methods: Vec<&str> = Vec::new();
    if supports_resume {
        methods.push("session/resume");
    }
    if supports_load {
        methods.push("session/load");
    }
    if methods.is_empty() {
        methods.push("session/resume");
        methods.push("session/load");
    }

    for method in methods {
        let request_id = connection.send_request(method, reopen_payload.clone())?;
        match wait_for_response(
            connection,
            request_id,
            &request.workspace,
            response,
            on_delta,
            on_activity,
            on_approval,
            on_write_file,
        ) {
            Ok(result) => {
                // A reopen answers with the same session shape as session/new,
                // so the model list is there to read when the agent sends it.
                return Ok((
                    resume_session_id.to_string(),
                    true,
                    false,
                    acp_offered_model_ids(&result),
                ));
            }
            Err(error) => {
                let detail = error.to_string();
                let recoverable = is_acp_method_not_found(&detail) || {
                    let lower = detail.to_ascii_lowercase();
                    lower.contains("not found")
                        || lower.contains("expired")
                        || lower.contains("unknown")
                        || lower.contains("unsupported")
                        // Grok refuses to load a session whose saved sandbox
                        // profile differs from this process. A fresh session
                        // keeps the turn; Gyro still has the transcript.
                        || lower.contains("sandbox")
                };
                if recoverable {
                    continue;
                }
                return Err(error);
            }
        }
    }

    // Reopen unavailable — start a fresh ACP session and let the caller inject
    // Gyro's transcript so the second message still has context.
    let (session_id, offered_models) = create_acp_session(
        connection,
        request,
        response,
        on_delta,
        on_activity,
        on_approval,
        on_write_file,
    )?;
    Ok((session_id, false, true, offered_models))
}

#[allow(clippy::too_many_arguments)]
fn create_acp_session<Delta, Activity, Approval, WriteFile>(
    connection: &mut KimiAcpConnection,
    request: &KimiAcpRequest,
    response: &mut String,
    on_delta: &mut Delta,
    on_activity: &mut Activity,
    on_approval: &mut Approval,
    on_write_file: &mut WriteFile,
) -> Result<(String, Vec<String>)>
where
    Delta: FnMut(&str),
    Activity: FnMut(&KimiAcpActivity),
    Approval: FnMut(&KimiAcpApprovalRequest) -> Result<KimiAcpApprovalDecision>,
    WriteFile: FnMut(&Path, &str) -> Result<()>,
{
    let new_id = connection.send_request(
        "session/new",
        json!({"cwd": request.workspace, "mcpServers": request.mcp_servers}),
    )?;
    let result = wait_for_response(
        connection,
        new_id,
        &request.workspace,
        response,
        on_delta,
        on_activity,
        on_approval,
        on_write_file,
    )?;
    let session_id = result
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| anyhow!("{} ACP did not return a session id", request.provider_label))?;
    Ok((session_id, acp_offered_model_ids(&result)))
}

/// The model ids this agent says it will accept, as `session/new` listed them.
///
/// An agent names its models however its own config does — Kimi calls its
/// flagship `kimi-code/k3`, not `k3` — so the list is what makes a selection
/// translatable instead of a guess.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpModel {
    pub id: String,
    pub display_name: String,
    pub description: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpModelDiscovery {
    pub models: Vec<AcpModel>,
    pub current_model_id: Option<String>,
}

/// Read both ACP model inventory shapes; metadata never grants model access.
fn acp_model_discovery(session: &Value) -> AcpModelDiscovery {
    let mut models = Vec::<AcpModel>::new();
    let mut append = |option: &Value| {
        let Some(id) = option
            .get("modelId")
            .or_else(|| option.get("value"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty() && id.len() <= 200 && !id.chars().any(char::is_control))
        else {
            return;
        };
        if models.len() >= 500 || models.iter().any(|model| model.id == id) {
            return;
        }
        let label = option
            .get("name")
            .or_else(|| option.get("label"))
            .and_then(Value::as_str)
            .filter(|label| !label.trim().is_empty())
            .unwrap_or(id);
        models.push(AcpModel {
            id: id.into(),
            display_name: redact_secrets(&label.chars().take(160).collect::<String>()),
            description: option
                .get("description")
                .and_then(Value::as_str)
                .map(|text| redact_secrets(&text.chars().take(500).collect::<String>())),
        });
    };
    for option in session
        .pointer("/models/availableModels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        append(option);
    }
    for config in session
        .get("configOptions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|config| {
            config.get("id").and_then(Value::as_str) == Some("model")
                || config.get("category").and_then(Value::as_str) == Some("model")
        })
    {
        for option in config
            .get("options")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(group) = option.get("options").and_then(Value::as_array) {
                for option in group {
                    append(option);
                }
            } else {
                append(option);
            }
        }
    }
    let current_model_id = session
        .pointer("/models/currentModelId")
        .and_then(Value::as_str)
        .or_else(|| {
            session
                .get("configOptions")
                .and_then(Value::as_array)
                .and_then(|options| {
                    options
                        .iter()
                        .find(|option| option.get("id").and_then(Value::as_str) == Some("model"))
                })
                .and_then(|option| option.get("currentValue"))
                .and_then(Value::as_str)
        })
        .filter(|id| models.iter().any(|model| model.id == *id))
        .map(str::to_string);
    AcpModelDiscovery {
        models,
        current_model_id,
    }
}

fn acp_offered_model_ids(session: &Value) -> Vec<String> {
    acp_model_discovery(session)
        .models
        .into_iter()
        .map(|model| model.id)
        .collect()
}

/// Name a selected model the way the agent names it.
///
/// Gyro's catalog ids are its own (`k3`); the agent's are namespaced by the
/// config that defines them (`kimi-code/k3`). Sending Gyro's id verbatim made
/// `session/set_model` fail with "not configured in config.toml", and because
/// that failure is not allowed to end the turn, the run silently continued on
/// whichever model the CLI defaulted to — a different context window than the
/// one the composer was measuring against.
fn acp_model_id(selected: &str, offered: &[String]) -> String {
    if offered.iter().any(|option| option == selected) {
        return selected.to_string();
    }
    offered
        .iter()
        .find(|option| {
            option
                .rsplit('/')
                .next()
                .is_some_and(|leaf| leaf.eq_ignore_ascii_case(selected))
        })
        .cloned()
        // Nothing advertised matches, so the agent is the one who gets to
        // reject it. Rewriting the id further would only invent a new guess.
        .unwrap_or_else(|| selected.to_string())
}

#[cfg(test)]
fn value_json_chars(value: &Value) -> u64 {
    serde_json::to_string(value)
        .map(|text| text.len() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
fn json_field_chars(value: Option<&Value>) -> u64 {
    match value {
        Some(Value::String(text)) => text.len() as u64,
        Some(Value::Null) | None => 0,
        Some(other) => value_json_chars(other),
    }
}

/// Text, or a non-text payload such as an attachment, inside one content block.
#[cfg(test)]
fn content_traffic_chars(content: Option<&Value>) -> u64 {
    let Some(content) = content else {
        return 0;
    };
    if let Some(text) = content.get("text").and_then(Value::as_str) {
        return text.len() as u64;
    }
    if let Some(items) = content.as_array() {
        return items
            .iter()
            .map(|item| content_traffic_chars(Some(item)))
            .fold(0, u64::saturating_add);
    }
    if let Some(data) = content.get("data").and_then(Value::as_str) {
        return data.len() as u64;
    }
    json_field_chars(Some(content))
}

/// Characters in one session update. Not published as context occupancy.
///
/// `tool_call` counts `rawInput` once. The matching update repeats that input
/// and carries the result in `rawOutput` / `content`. `user_message_chunk`
/// repeats the prompt already counted at send. Turn bills are not traffic.
#[cfg(test)]
fn session_update_traffic_chars(update: &Value) -> u64 {
    match update.get("sessionUpdate").and_then(Value::as_str) {
        Some("agent_message_chunk") | Some("agent_thought_chunk") => {
            content_traffic_chars(update.get("content"))
        }
        Some("tool_call") => json_field_chars(update.get("rawInput")),
        Some("tool_call_update") => {
            let output = json_field_chars(update.get("rawOutput"));
            let content = content_traffic_chars(update.get("content"));
            if output == 0 || content == 0 || update.get("rawOutput") == update.get("content") {
                output.max(content)
            } else {
                output.saturating_add(content)
            }
        }
        _ => 0,
    }
}

/// Publish a provider occupancy frame. Tool text is not a token count.
fn publish_observed_context<Activity>(
    connection: &mut KimiAcpConnection,
    params: &Value,
    update: &Value,
    on_activity: &mut Activity,
) where
    Activity: FnMut(&KimiAcpActivity),
{
    // Tool text is not a token count. Leave the meter unchanged until a
    // provider frame names the occupancy.
    if let Some(context) = acp_usage::live_context_usage(update) {
        publish_live_context(connection, context, true, on_activity);
    } else if let Some(context) = acp_usage::grok_frame_context(params) {
        publish_live_context(connection, context, true, on_activity);
    }
}

fn publish_live_context<Activity>(
    connection: &mut KimiAcpConnection,
    context: AcpContextUsage,
    from_wire: bool,
    on_activity: &mut Activity,
) where
    Activity: FnMut(&KimiAcpActivity),
{
    let Some(context) = connection.note_live_context(context, from_wire) else {
        return;
    };
    on_activity(&KimiAcpActivity {
        id: "live-context-usage".into(),
        kind: "context-usage".into(),
        label: "Context usage".into(),
        detail: None,
        file_counts: None,
        status: "running".into(),
        context_usage: Some(context),
    });
}

/// Grok puts the update under `params.update`, or sends the update as `params`.
fn xai_context_update(params: &Value) -> Option<&Value> {
    if let Some(update) = params
        .get("update")
        .filter(|update| update.get("sessionUpdate").is_some())
    {
        return Some(update);
    }
    params.get("sessionUpdate").is_some().then_some(params)
}

/// Ignore a frame that names some other session. A frame that names no session
/// still belongs to this process.
fn announced_session_matches(bound: Option<&str>, params: &Value, update: &Value) -> bool {
    let Some(bound) = bound else {
        return true;
    };
    let announced = ["sessionId", "session_id"].into_iter().find_map(|key| {
        params
            .get(key)
            .or_else(|| update.get(key))
            .and_then(Value::as_str)
    });
    match announced {
        Some(id) => id == bound,
        None => true,
    }
}

#[allow(clippy::too_many_arguments)]
fn wait_for_response<Delta, Activity, Approval, WriteFile>(
    connection: &mut KimiAcpConnection,
    expected_id: u64,
    workspace: &Path,
    response: &mut String,
    on_delta: &mut Delta,
    on_activity: &mut Activity,
    on_approval: &mut Approval,
    on_write_file: &mut WriteFile,
) -> Result<Value>
where
    Delta: FnMut(&str),
    Activity: FnMut(&KimiAcpActivity),
    Approval: FnMut(&KimiAcpApprovalRequest) -> Result<KimiAcpApprovalDecision>,
    WriteFile: FnMut(&Path, &str) -> Result<()>,
{
    loop {
        let message = connection.receive()?;
        // ACP is bidirectional: an incoming request may reuse our outgoing ID.
        // Only a response envelope can complete the request we are waiting for.
        if message.get("method").is_none()
            && message.get("id").and_then(Value::as_u64) == Some(expected_id)
        {
            if connection.collecting_usage {
                // Observe before any error, refusal or cancellation is propagated.
                connection.observe_prompt_response(&message);
            } else if let Some(result) = message.get("result") {
                connection.runtime_info.observe(result);
            }
            if let Some(error) = message.get("error") {
                let mut detail = error
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("{} ACP request failed", connection.provider_label));
                if let Some(data) = error.get("data").filter(|data| !data.is_null()) {
                    let data = redact_secrets(&data.to_string());
                    detail.push_str(": ");
                    detail.extend(data.chars().take(2000));
                }
                anyhow::bail!(redact_secrets(&detail));
            }
            return message.get("result").cloned().ok_or_else(|| {
                anyhow::anyhow!(
                    "{} ACP response is missing its result",
                    connection.provider_label
                )
            });
        }
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            continue;
        };
        let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
        match method {
            "session/update" => {
                if connection.collecting_usage {
                    if let Some(update) = params.get("update") {
                        publish_observed_context(connection, &params, update, on_activity);
                    }
                    // Reopening/loading a session can replay its old replies and
                    // tool activities. They already belong to native history;
                    // rendering them as this turn duplicates saved replies and
                    // can cause later continuation prompts to resend old work.
                    handle_session_update(
                        &params,
                        &connection.provider_label,
                        response,
                        on_delta,
                        on_activity,
                    );
                }
            }
            // Grok's occupancy rail. Notifications only: a request falls through
            // to the unsupported-method error. Chat text stays on session/update.
            "_x.ai/session/update" | "x.ai/session/update" | "x.ai/session_notification"
                if message.get("id").is_none() =>
            {
                if let Some(update) = xai_context_update(&params) {
                    if announced_session_matches(
                        connection.bound_session_id.as_deref(),
                        &params,
                        update,
                    ) {
                        publish_observed_context(connection, &params, update, on_activity);
                    }
                }
            }
            "session/request_permission" => {
                let Some(id) = message.get("id").cloned() else {
                    continue;
                };
                let tool_call = params.get("toolCall").cloned().unwrap_or_else(|| json!({}));
                let request = KimiAcpApprovalRequest {
                    kind: classify_approval(&tool_call),
                    tool_call,
                };
                let decision = if connection.cancellation.is_cancelled() {
                    KimiAcpApprovalDecision::Cancelled
                } else if connection.auto_allow_permissions {
                    // Full access answered this before the request arrived. No
                    // card, no host callback, and no way for a broken card to
                    // turn into a declined tool that ends the turn.
                    KimiAcpApprovalDecision::AllowOnce
                } else {
                    match on_approval(&request) {
                        Ok(decision) => decision,
                        // A turn the person cancelled keeps its own error path.
                        Err(error) if connection.cancellation.is_cancelled() => return Err(error),
                        // A card that cannot be answered declines this one tool.
                        // Ending the turn over it threw away every step around
                        // it, which is the failure this whole path avoids.
                        Err(error) => {
                            on_activity(&KimiAcpActivity {
                                id: "approval-unavailable".into(),
                                kind: "tool".into(),
                                label: "Gyro could not ask for approval".into(),
                                detail: Some(redact_secrets(&error.to_string())),
                                file_counts: None,
                                status: "failed".into(),
                                context_usage: None,
                            });
                            KimiAcpApprovalDecision::RejectOnce
                        }
                    }
                };
                // A rejection is the one answer that can end the agent's whole
                // prompt, so it is remembered: the turn continues after it
                // instead of failing with the work thrown away.
                if decision == KimiAcpApprovalDecision::RejectOnce {
                    connection.declined_permission = true;
                }
                let option_id = permission_option_id(&params, decision);
                let outcome = if let Some(option_id) = option_id {
                    json!({"outcome": "selected", "optionId": option_id})
                } else {
                    // Never answer a permission request with a JSON-RPC error:
                    // agents read that as a broken client and some end the
                    // turn. "cancelled" declines this one call, and the
                    // continuation below picks the turn back up.
                    if decision != KimiAcpApprovalDecision::Cancelled {
                        connection.declined_permission = true;
                    }
                    json!({"outcome": "cancelled"})
                };
                connection.send_result(id, json!({"outcome": outcome}))?;
            }
            "cursor/ask_question" | "cursor/create_plan" => {
                if let Some(id) = message.get("id").cloned() {
                    // These require richer UI than the current approval card.
                    // Explicitly cancel instead of hanging or inventing consent.
                    connection.send_result(id, json!({"outcome": {"outcome": "cancelled"}}))?;
                    on_activity(&KimiAcpActivity {
                        id: "cursor-input-required".into(), kind: "tool".into(),
                        label: "Cursor needs input".into(),
                        detail: Some("Cursor's interactive question or plan was cancelled. Continue with instructions in chat.".into()),
                        file_counts: None,
                        status: "failed".into(),
                        context_usage: None,
                    });
                }
            }
            "fs/read_text_file" => {
                let Some(id) = message.get("id").cloned() else {
                    continue;
                };
                match read_workspace_text_file(workspace, &params) {
                    Ok(content) => connection.send_result(id, json!({"content": content}))?,
                    Err(error) => {
                        connection.send_error(id, -32001, &redact_secrets(&error.to_string()))?
                    }
                }
            }
            "fs/write_text_file" => {
                let Some(id) = message.get("id").cloned() else {
                    continue;
                };
                match prepare_workspace_write(workspace, &params)
                    .and_then(|(path, content)| on_write_file(&path, &content))
                {
                    Ok(()) => connection.send_result(id, json!({}))?,
                    Err(error) => {
                        connection.send_error(id, -32001, &redact_secrets(&error.to_string()))?
                    }
                }
            }
            _ if message.get("id").is_some() => {
                connection.send_error(
                    message.get("id").cloned().unwrap_or(Value::Null),
                    -32601,
                    "ACP client method is not supported by Gyro",
                )?;
            }
            _ => {}
        }
    }
}

fn handle_session_update<Delta, Activity>(
    params: &Value,
    provider_label: &str,
    response: &mut String,
    on_delta: &mut Delta,
    on_activity: &mut Activity,
) where
    Delta: FnMut(&str),
    Activity: FnMut(&KimiAcpActivity),
{
    let Some(update) = params.get("update") else {
        return;
    };
    match update.get("sessionUpdate").and_then(Value::as_str) {
        Some("agent_message_chunk") => {
            if let Some(text) = update
                .get("content")
                .and_then(|content| content.get("text"))
                .and_then(Value::as_str)
            {
                response.push_str(text);
                on_delta(text);
            }
        }
        Some("tool_call") | Some("tool_call_update") => {
            // Grok, Gemini, and Kimi share this ACP path. Prefer a real title,
            // then a kind-derived verb + path/query, and only fall back to
            // "{provider} tool" when nothing more specific is available.
            let default_id = format!("{}-tool", acp_activity_id_slug(provider_label));
            let id = update
                .get("toolCallId")
                .and_then(Value::as_str)
                .unwrap_or(default_id.as_str())
                .to_string();
            let acp_kind = update
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("other");
            let title = update
                .get("title")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|title| !title.is_empty());
            let raw_input = update.get("rawInput");
            let path = acp_raw_input_path(raw_input);
            let query = acp_raw_input_query(raw_input);
            let command = acp_raw_input_command(raw_input);
            let (kind, label, detail) =
                acp_tool_activity_parts(provider_label, acp_kind, title, path, query, command);
            let status = match update.get("status").and_then(Value::as_str) {
                Some("completed") => "done",
                Some("failed") => "failed",
                _ => "running",
            }
            .to_string();
            let detail =
                detail.or_else(|| raw_input.map(|value| redact_secrets(&value.to_string())));
            on_activity(&KimiAcpActivity {
                id,
                kind,
                label,
                detail,
                file_counts: acp_diff_counts(update.get("content")),
                status,
                context_usage: None,
            });
        }
        Some("plan") => {
            on_activity(&KimiAcpActivity {
                id: format!("{}-plan", acp_activity_id_slug(provider_label)),
                kind: "plan".into(),
                label: "Updated plan".into(),
                detail: update.get("entries").map(Value::to_string),
                file_counts: None,
                status: "done".into(),
                context_usage: None,
            });
        }
        _ => {}
    }
}

/// Lines changed by a tool call's ACP `diff` blocks (`oldText` is absent for a
/// new file). Every agent on this path reports edits this way, so counting
/// here covers them all rather than one model at a time.
fn acp_diff_counts(content: Option<&Value>) -> Option<(usize, usize)> {
    let diffs = content?
        .as_array()?
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("diff"))
        .collect::<Vec<_>>();
    if diffs.is_empty() {
        return None;
    }
    diffs.into_iter().try_fold((0, 0), |total, diff| {
        let new = diff.get("newText")?.as_str()?;
        let old = diff.get("oldText").and_then(Value::as_str).unwrap_or("");
        let counts = crate::diff::changed_line_counts(old.as_bytes(), new.as_bytes());
        Some((total.0 + counts.0, total.1 + counts.1))
    })
}

/// Stable id fragment from a provider label (`xAI` → `xai`, `Grok` → `grok`).
fn acp_activity_id_slug(provider_label: &str) -> String {
    let slug = provider_label
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    if slug.is_empty() {
        "acp".into()
    } else {
        slug
    }
}

/// Map an ACP tool kind into Gyro's activity contract and a human rail label.
///
/// Returns `(activityKind, label, detail)` where `detail` is the path, query,
/// or command the UI can show next to the verb.
fn acp_tool_activity_parts(
    provider_label: &str,
    acp_kind: &str,
    title: Option<&str>,
    path: Option<String>,
    query: Option<String>,
    command: Option<String>,
) -> (String, String, Option<String>) {
    let titled = |fallback: String| title.map(str::to_string).unwrap_or(fallback);
    match acp_kind {
        "read" | "create" | "edit" | "delete" | "move" => {
            let verb = match acp_kind {
                "read" => "Read",
                "create" => "Create",
                "edit" => "Edit",
                "delete" => "Delete",
                _ => "Move",
            };
            let label = titled(match path.as_deref() {
                Some(path) => format!("{verb} {path}"),
                None => format!("{verb} file"),
            });
            (
                if acp_kind == "read" { "read" } else { "file" }.into(),
                label,
                path,
            )
        }
        "execute" => {
            let label = titled(match command.as_deref() {
                Some(command) => format!("Run {command}"),
                None => "Run command".into(),
            });
            ("command".into(), label, command.or(path))
        }
        "search" => {
            let label = titled(match query.as_deref() {
                Some(query) => format!("Search {query}"),
                None => "Search".into(),
            });
            ("search".into(), label, query.or(path))
        }
        "fetch" => {
            let label = titled(match query.as_deref().or(path.as_deref()) {
                Some(target) => format!("Fetch {target}"),
                None => "Fetch".into(),
            });
            ("search".into(), label, query.or(path))
        }
        "think" => ("tool".into(), titled("Thinking".into()), None),
        other => {
            let label = titled(if other != "other" && other != "tool" {
                humanize_acp_kind(other)
            } else {
                format!("{provider_label} tool")
            });
            ("tool".into(), label, path.or(query).or(command))
        }
    }
}

fn humanize_acp_kind(kind: &str) -> String {
    kind.split(['_', '-'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => format!(
                    "{}{}",
                    first.to_uppercase(),
                    chars.as_str().to_ascii_lowercase()
                ),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn acp_raw_input_path(raw_input: Option<&Value>) -> Option<String> {
    let value = raw_input?;
    if let Some(path) = value
        .as_str()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        // Bare string inputs are usually a path for read/edit.
        if path.contains('/') || path.contains('\\') || path.contains('.') {
            return Some(redact_secrets(path));
        }
    }
    acp_raw_input_string(value, &["path", "file", "filePath", "filename", "target"])
}

fn acp_raw_input_query(raw_input: Option<&Value>) -> Option<String> {
    let value = raw_input?;
    acp_raw_input_string(value, &["query", "pattern", "search", "q", "url", "uri"])
}

fn acp_raw_input_command(raw_input: Option<&Value>) -> Option<String> {
    let value = raw_input?;
    if let Some(command) = value
        .as_str()
        .map(str::trim)
        .filter(|command| !command.is_empty())
    {
        if !command.contains('/') && !command.contains('\\') {
            return Some(redact_secrets(command));
        }
    }
    acp_raw_input_string(value, &["command", "cmd", "shell", "script"])
}

fn acp_raw_input_string(value: &Value, keys: &[&str]) -> Option<String> {
    let object = value.as_object()?;
    for key in keys {
        if let Some(found) = object
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|found| !found.is_empty())
        {
            return Some(redact_secrets(found));
        }
    }
    None
}

fn classify_approval(tool_call: &Value) -> KimiAcpApprovalKind {
    let combined = format!(
        "{} {} {}",
        tool_call
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        tool_call
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        tool_call
            .get("rawInput")
            .map(Value::to_string)
            .unwrap_or_default(),
    )
    .to_ascii_lowercase();
    if ["bash", "shell", "terminal", "command"]
        .iter()
        .any(|part| combined.contains(part))
    {
        KimiAcpApprovalKind::Command
    } else if ["write", "edit", "delete", "move", "file"]
        .iter()
        .any(|part| combined.contains(part))
    {
        KimiAcpApprovalKind::FileChange
    } else {
        KimiAcpApprovalKind::Other
    }
}

/// What an option calls itself, with punctuation folded away: `allow_once`,
/// `allow-once`, `allowOnce` and `Allow once` all read as `allowonce`.
fn permission_option_kind(option: &Value) -> String {
    [
        "kind",
        "optionKind",
        "name",
        "title",
        "label",
        "optionId",
        "id",
    ]
    .iter()
    .filter_map(|key| option.get(*key).and_then(Value::as_str))
    .collect::<Vec<_>>()
    .join(" ")
    .to_ascii_lowercase()
    .chars()
    .filter(|character| character.is_ascii_alphanumeric())
    .collect()
}

/// An option's own id, or its `id` alias.
fn permission_option_id_of(option: &Value) -> Option<&str> {
    option
        .get("optionId")
        .or_else(|| option.get("id"))
        .and_then(Value::as_str)
}

fn permission_option_id(params: &Value, decision: KimiAcpApprovalDecision) -> Option<&str> {
    let options = params.get("options")?.as_array()?;
    let naming = |wanted: &str| {
        options
            .iter()
            .find(|option| permission_option_kind(option).contains(wanted))
            .and_then(permission_option_id_of)
    };
    match decision {
        // The exact kind first, then the same answer in another flavour, then
        // consent under a name nobody predicted. An agent that offers no option
        // Gyro recognises still gets one of the options it offered: replying
        // with an error or a cancellation ends the turn the agent is holding.
        KimiAcpApprovalDecision::AllowOnce => {
            naming("allowonce").or_else(|| naming("allow")).or_else(|| {
                options
                    .iter()
                    .find(|option| {
                        let kind = permission_option_kind(option);
                        !kind.is_empty()
                            && !["reject", "deny", "decline", "cancel", "abort", "dismiss"]
                                .iter()
                                .any(|word| kind.contains(word))
                    })
                    .and_then(permission_option_id_of)
            })
        }
        // A decline only borrows an option that really says no. Cancelling is
        // the honest answer otherwise, and a rejection must never be sent as
        // consent just because the vocabulary was unfamiliar.
        KimiAcpApprovalDecision::RejectOnce => naming("rejectonce")
            .or_else(|| naming("reject"))
            .or_else(|| naming("deny"))
            .or_else(|| naming("decline")),
        KimiAcpApprovalDecision::Cancelled => None,
    }
}

fn read_workspace_text_file(workspace: &Path, params: &Value) -> Result<String> {
    let requested = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("ACP file read did not include a path"))?;
    let path = resolve_existing_workspace_path(workspace, requested)?;
    let canonical_workspace = workspace.canonicalize()?;
    let relative = path.strip_prefix(&canonical_workspace)?;
    if crate::capabilities::capability_path_is_sensitive(&relative.to_string_lossy()) {
        anyhow::bail!("Sensitive files require the governed Gyro workspace-read tool and its access policy; direct ACP reads are disabled for this path");
    }
    let metadata = std::fs::symlink_metadata(&path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        anyhow::bail!("ACP reads require a regular non-symlink file");
    }
    if metadata.len() > ACP_MAX_FILE_BYTES as u64 {
        anyhow::bail!("ACP file exceeds the {} byte limit", ACP_MAX_FILE_BYTES);
    }
    let content = std::fs::read_to_string(&path)?;
    let line = params
        .get("line")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .max(1) as usize;
    let limit = params
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(u64::MAX)
        .min(10_000) as usize;
    Ok(content
        .lines()
        .skip(line.saturating_sub(1))
        .take(limit)
        .collect::<Vec<_>>()
        .join("\n"))
}

fn prepare_workspace_write(workspace: &Path, params: &Value) -> Result<(PathBuf, String)> {
    let requested = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("ACP file write did not include a path"))?;
    let content = params
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("ACP file write did not include text content"))?;
    if content.len() > ACP_MAX_FILE_BYTES {
        anyhow::bail!(
            "ACP file write exceeds the {} byte limit",
            ACP_MAX_FILE_BYTES
        );
    }
    let path = resolve_workspace_write_path(workspace, requested)?;
    Ok((path, content.to_string()))
}

fn resolve_existing_workspace_path(workspace: &Path, requested: &str) -> Result<PathBuf> {
    let workspace = workspace.canonicalize()?;
    let requested = Path::new(requested);
    let candidate = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        workspace.join(requested)
    };
    let resolved = candidate.canonicalize()?;
    if !resolved.starts_with(&workspace) {
        anyhow::bail!("ACP file request escaped the selected workspace");
    }
    Ok(resolved)
}

fn resolve_workspace_write_path(workspace: &Path, requested: &str) -> Result<PathBuf> {
    let workspace = workspace.canonicalize()?;
    let requested = Path::new(requested);
    let candidate = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        workspace.join(requested)
    };
    if let Ok(metadata) = std::fs::symlink_metadata(&candidate) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            anyhow::bail!("ACP writes require a regular non-symlink target");
        }
        let resolved = candidate.canonicalize()?;
        if !resolved.starts_with(&workspace) {
            anyhow::bail!("ACP file write escaped the selected workspace");
        }
        return Ok(resolved);
    }
    let parent = candidate
        .parent()
        .ok_or_else(|| anyhow!("ACP file write has no parent directory"))?
        .canonicalize()?;
    if !parent.starts_with(&workspace) {
        anyhow::bail!("ACP file write escaped the selected workspace");
    }
    let name = candidate
        .file_name()
        .ok_or_else(|| anyhow!("ACP file write has no file name"))?;
    Ok(parent.join(name))
}

pub fn check_kimi_acp_health(program: impl Into<OsString>, timeout: Duration) -> KimiAcpHealth {
    check_acp_health(
        "Kimi",
        program,
        vec![OsString::from("acp")],
        &["login"],
        timeout,
    )
}

/// Metadata only: authenticate and open a session, never send a model prompt.
/// The provider retains credential ownership and every tool request is denied.
pub fn discover_acp_models(
    provider_label: &str,
    program: impl Into<OsString>,
    program_args: Vec<OsString>,
    auth_method_ids: &[&str],
    timeout: Duration,
) -> Result<AcpModelDiscovery> {
    let request = KimiAcpRequest {
        provider_label: provider_label.into(),
        program: program.into(),
        program_args,
        auth_method_ids: auth_method_ids.iter().map(ToString::to_string).collect(),
        workspace: std::env::temp_dir(),
        prompt: Vec::new(),
        resumed_prompt: None,
        conversation_history_text: None,
        mcp_servers: Vec::new(),
        model: String::new(),
        reasoning_effort: None,
        mode: KimiAcpMode::Normal,
        auto_allow_permissions: false,
        resume_session_id: None,
        timeout,
        inactivity_timeout: timeout,
        cancellation: CancellationToken::default(),
        credentials: CredentialPolicy::Inherit,
        opened_session: None,
    };
    let mut connection = KimiAcpConnection::start(&request)?;
    let id = connection.send_request(
        "initialize",
        json!({
            "protocolVersion": ACP_PROTOCOL_VERSION,
            "clientInfo": {"name": "Gyro model discovery", "version": env!("CARGO_PKG_VERSION")},
            "clientCapabilities": {},
        }),
    )?;
    let initialize = wait_for_simple_response(&mut connection, id)?;
    let advertised = initialize
        .get("authMethods")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|method| method.get("id").and_then(Value::as_str))
        .collect::<Vec<_>>();
    if let Some(method) = request
        .auth_method_ids
        .iter()
        .find(|method| advertised.is_empty() || advertised.contains(&method.as_str()))
    {
        let id = connection.send_request("authenticate", json!({"methodId": method}))?;
        wait_for_simple_response(&mut connection, id)?;
    } else if !advertised.is_empty() {
        anyhow::bail!("{provider_label} does not advertise a supported authentication method");
    }
    let id = connection.send_request(
        "session/new",
        json!({
            "cwd": request.workspace,
            "mcpServers": [],
        }),
    )?;
    let session = wait_for_simple_response(&mut connection, id)?;
    Ok(acp_model_discovery(&session))
}

pub fn check_acp_health(
    provider_label: &str,
    program: impl Into<OsString>,
    program_args: Vec<OsString>,
    auth_method_ids: &[&str],
    timeout: Duration,
) -> KimiAcpHealth {
    let request = KimiAcpRequest {
        provider_label: provider_label.into(),
        program: program.into(),
        program_args,
        auth_method_ids: auth_method_ids.iter().map(ToString::to_string).collect(),
        workspace: std::env::temp_dir(),
        prompt: Vec::new(),
        resumed_prompt: None,
        conversation_history_text: None,
        // A health probe only checks that the agent starts and authenticates.
        mcp_servers: Vec::new(),
        model: "k3".into(),
        reasoning_effort: None,
        mode: KimiAcpMode::Normal,
        auto_allow_permissions: false,
        resume_session_id: None,
        timeout,
        inactivity_timeout: timeout,
        cancellation: CancellationToken::default(),
        // Gyro's own auth probe, not an agent run.
        credentials: CredentialPolicy::Inherit,
        opened_session: None,
    };
    let mut connection = match KimiAcpConnection::start(&request) {
        Ok(connection) => connection,
        Err(error) => {
            let detail = redact_secrets(&error.to_string());
            let status = if detail.to_ascii_lowercase().contains("no such file")
                || detail.to_ascii_lowercase().contains("not found")
            {
                KimiAcpHealthStatus::NotInstalled
            } else {
                KimiAcpHealthStatus::Warning
            };
            return KimiAcpHealth {
                status,
                output: detail,
            };
        }
    };
    let result = (|| -> Result<()> {
        let initialize_id = connection.send_request(
            "initialize",
            json!({
                "protocolVersion": ACP_PROTOCOL_VERSION,
                "clientInfo": {"name": "Gyro Health", "version": env!("CARGO_PKG_VERSION")},
                "clientCapabilities": {},
            }),
        )?;
        let initialize = wait_for_simple_response(&mut connection, initialize_id)?;
        let advertised_auth_methods = initialize
            .get("authMethods")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|method| method.get("id").and_then(Value::as_str))
            .collect::<Vec<_>>();
        let auth_method = request
            .auth_method_ids
            .iter()
            .find(|method| {
                advertised_auth_methods.is_empty()
                    || advertised_auth_methods.contains(&method.as_str())
            })
            .cloned()
            .or_else(|| {
                advertised_auth_methods
                    .first()
                    .map(|method| (*method).to_string())
            });
        if let Some(auth_method) = auth_method {
            let authenticate_id =
                connection.send_request("authenticate", json!({"methodId": auth_method}))?;
            wait_for_simple_response(&mut connection, authenticate_id)?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => KimiAcpHealth {
            status: KimiAcpHealthStatus::Ready,
            output: format!(
                "{provider_label} ACP authenticated; provider-owned credential value was not read by Gyro."
            ),
        },
        Err(error) => {
            let output = redact_secrets(&error.to_string());
            let normalized = output.to_ascii_lowercase();
            let status = if normalized.contains("auth")
                || normalized.contains("login")
                || normalized.contains("token")
                || normalized.contains("-32000")
            {
                KimiAcpHealthStatus::NotLoggedIn
            } else {
                KimiAcpHealthStatus::Warning
            };
            KimiAcpHealth { status, output }
        }
    }
}

fn wait_for_simple_response(connection: &mut KimiAcpConnection, expected_id: u64) -> Result<Value> {
    loop {
        let message = connection.receive()?;
        if message.get("method").is_some() {
            if let Some(id) = message.get("id").cloned() {
                connection.send_error(id, -32601, "Metadata checks cannot execute tools")?;
            }
            continue;
        }
        if message.get("id").and_then(Value::as_u64) != Some(expected_id) {
            continue;
        }
        if let Some(error) = message.get("error") {
            anyhow::bail!(error.to_string());
        }
        return Ok(message.get("result").cloned().unwrap_or(Value::Null));
    }
}

fn append_bounded(target: &mut String, text: &str, max_chars: usize) {
    let remaining = max_chars.saturating_sub(target.chars().count());
    target.extend(text.chars().take(remaining));
}

#[cfg(test)]
mod tests {

    use super::{
        acp_activity_id_slug, acp_diff_counts, acp_model_id, acp_offered_model_ids,
        acp_result_marks_output_truncated, acp_result_needs_output_continuation,
        acp_session_reopen_methods, acp_stop_is_output_limit, check_kimi_acp_health,
        classify_approval, is_acp_method_not_found, permission_option_id,
        plan_mode_denies_approval, resolve_workspace_write_path, run_kimi_acp, CredentialPolicy,
        KimiAcpApprovalDecision, KimiAcpApprovalKind, KimiAcpHealthStatus, KimiAcpMode,
        KimiAcpRequest,
    };

    #[test]
    fn google_inventory_accepts_both_acp_shapes_and_rejects_invalid_ids() {
        let result = super::acp_model_discovery(&serde_json::json!({
            "models": {"currentModelId": "gemini-3.8-flash", "availableModels": [
                {"modelId": "gemini-3.8-flash", "name": "Gemini 3.8 Flash"},
                {"modelId": "", "name": "Invalid"}
            ]},
            "configOptions": [{"id": "model", "options": [
                {"value": "gemini-3.8-flash", "name": "Duplicate"},
                {"group": "Other", "options": [{"value": "gemini-3.7-flash", "name": "Gemini 3.7 Flash"}]}
            ]}]
        }));
        assert_eq!(
            result
                .models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["gemini-3.8-flash", "gemini-3.7-flash"]
        );
        assert_eq!(result.current_model_id.as_deref(), Some("gemini-3.8-flash"));
        assert_eq!(result.models[0].display_name, "Gemini 3.8 Flash");
    }

    #[cfg(unix)]
    #[test]
    fn google_discovery_opens_metadata_without_sending_a_prompt() {
        let (_temp, program) = acp_fixture(
            r#"
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"authMethods":[{"id":"gemini-api-key"}]}}' ;;
    *'"method":"authenticate"'*) printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{}}' ;;
    *'"method":"session/new"'*) printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"sessionId":"metadata","models":{"currentModelId":"gemini-3.8-flash","availableModels":[{"modelId":"gemini-3.8-flash","name":"Gemini 3.8 Flash"}]}}}' ;;
    *'"method":"session/prompt"'*) exit 9 ;;
  esac
done
"#,
        );
        let result = super::discover_acp_models(
            "Google Antigravity",
            program,
            vec![],
            &["gemini-api-key"],
            std::time::Duration::from_secs(2),
        )
        .unwrap();
        assert_eq!(result.models[0].id, "gemini-3.8-flash");
    }

    #[cfg(unix)]
    #[test]
    fn google_rejected_model_stops_before_any_prompt() {
        let (temp, program) = acp_fixture(
            r#"
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"authMethods":[{"id":"login"}]}}' ;;
    *'"method":"authenticate"'*) printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{}}' ;;
    *'"method":"session/new"'*) printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"sessionId":"selection"}}' ;;
    *'"method":"session/set_model"'*) printf '%s\n' '{"jsonrpc":"2.0","id":4,"error":{"code":-32602,"message":"Model not available"}}' ;;
    *'"method":"session/prompt"'*) touch unexpected-prompt; exit 9 ;;
  esac
done
"#,
        );
        let mut request = fixture_request(
            program,
            temp.path().to_path_buf(),
            super::CancellationToken::default(),
            None,
        );
        request.provider_label = "Google Antigravity".into();
        request.model = "unavailable-model".into();
        let result = run_kimi_acp(
            request,
            |_| {},
            |_| {},
            |_| Ok(KimiAcpApprovalDecision::RejectOnce),
            |_, _| Ok(()),
        );
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("could not select model"));
        assert!(!temp.path().join("unexpected-prompt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn acp_prompt_accounting_survives_success_cancel_refusal_and_rpc_error() {
        use crate::usage::{UsageCoverage, UsageReason};
        let usage = r#""_meta":{"usage":{"inputTokens":100,"cachedReadTokens":60,"outputTokens":25,"thoughtTokens":5,"totalTokens":125,"modelCalls":2}}"#;
        let completions = [
            (format!(r#"{{"jsonrpc":"2.0","id":6,"result":{{"stopReason":"end_turn",{usage}}}}}"#), false),
            (format!(r#"{{"jsonrpc":"2.0","id":6,"result":{{"stopReason":"cancelled",{usage}}}}}"#), true),
            (format!(r#"{{"jsonrpc":"2.0","id":6,"result":{{"stopReason":"refusal",{usage}}}}}"#), true),
            (r#"{"jsonrpc":"2.0","id":6,"error":{"message":"provider failed","data":{"promptUsage":{"inputTokens":100,"outputTokens":25,"totalTokens":125,"modelCalls":2}}}}"#.into(), true),
        ];
        for (completion, interrupted) in completions {
            let _scope = crate::provider_observation::Scope::start();
            crate::provider_observation::attempt();
            let (temp, program) = completion_fixture(&completion, false);
            let mut request = fixture_request(
                program,
                temp.path().to_path_buf(),
                CancellationToken::default(),
                None,
            );
            request.provider_label = "xAI".into();
            let result = run_kimi_acp(
                request,
                |_| {},
                |_| {},
                |_| Ok(KimiAcpApprovalDecision::RejectOnce),
                |_, _| Ok(()),
            );
            assert_eq!(result.is_err(), interrupted);
            if let Ok(output) = result {
                assert_eq!(output.usage_observation.model_calls, Some(2));
                assert_eq!(output.usage.as_ref().unwrap()["inputTokens"], 100);
            }
            let tokens = crate::provider_observation::snapshot()
                .unwrap()
                .tokens
                .unwrap();
            assert_eq!(tokens.total_tokens, 125);
            let accounting = tokens.effective_accounting();
            assert_eq!(
                accounting.coverage,
                if interrupted {
                    UsageCoverage::Partial
                } else {
                    UsageCoverage::Complete
                }
            );
            if interrupted {
                assert_eq!(accounting.reason, Some(UsageReason::Interrupted));
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn acp_usage_update_is_context_only_in_live_adapter_fixture() {
        let (temp, program) = completion_fixture(
            "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"usage_update\",\"used\":50000,\"size\":100000}}}\n{\"jsonrpc\":\"2.0\",\"id\":6,\"result\":{\"stopReason\":\"end_turn\",\"usage\":{\"inputTokens\":100,\"outputTokens\":25,\"totalTokens\":125}}}", false);
        let mut request = fixture_request(
            program,
            temp.path().to_path_buf(),
            CancellationToken::default(),
            None,
        );
        request.provider_label = "xAI".into();
        let mut live_context = Vec::new();
        let output = run_kimi_acp(
            request,
            |_| {},
            |activity| {
                if let Some(context) = activity.context_usage {
                    live_context.push(context);
                }
            },
            |_| Ok(KimiAcpApprovalDecision::RejectOnce),
            |_, _| Ok(()),
        )
        .unwrap();
        assert_eq!(
            output.context_usage,
            Some(crate::acp_usage::AcpContextUsage {
                used: 50000,
                size: 100000,
                estimated: false,
            })
        );
        assert_eq!(live_context.last().copied(), output.context_usage);
        assert!(
            live_context.iter().all(|reading| !reading.estimated),
            "a usage_update is measured occupancy, and tool text is not a token count"
        );
        // Occupancy is published while the turn is running, and never replaces billed consumption.
        assert_eq!(output.usage_observation.tokens.total_tokens, 125);
    }

    #[cfg(unix)]
    #[test]
    fn grok_status_line_occupancy_ignores_turn_bills_and_preserves_the_window() {
        use std::os::unix::fs::symlink;
        let (temp, script) = acp_fixture(
            r#"
while IFS= read -r line; do
  id=${line#*'"id":'}
  id=${id%%,*}
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' "$line" > initialize-request
      printf '{"jsonrpc":"2.0","id":%s,"result":{"authMethods":[{"id":"login"}]}}\n' "$id" ;;
    *'"method":"authenticate"'*|*'"method":"session/set_model"'*|*'"method":"session/set_config_option"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id" ;;
    *'"method":"session/new"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"sessionId":"grok-session"}}\n' "$id" ;;
    *'"method":"session/prompt"'*)
      printf '%s\n' '{"jsonrpc":"2.0","method":"x.ai/session_notification","params":{"sessionId":"other-session","update":{"sessionUpdate":"session_status","context_window":{"context_tokens":1,"context_window_size":256000},"session_input_tokens":900000}}}'
      printf '%s\n' '{"jsonrpc":"2.0","id":99,"method":"_x.ai/session/update","params":{"update":{"sessionUpdate":"session_status","context_window":{"context_tokens":2,"context_window_size":256000}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"_x.ai/session/update","params":{"sessionId":"grok-session","update":{"sessionUpdate":"session_status","context_window":{"context_tokens":33022,"context_window_size":256000},"session_input_tokens":900000}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"x.ai/session_notification","params":{"sessionId":"grok-session","update":{"sessionUpdate":"response_started","input_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"x.ai/session_notification","params":{"sessionId":"grok-session","update":{"sessionUpdate":"response_started","message_id":"m1","input_tokens":800,"cache_read_input_tokens":20000,"cache_creation_input_tokens":0}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"_x.ai/session/update","params":{"sessionId":"grok-session","update":{"sessionUpdate":"response_completed","message_id":"m1","usage":{"input_tokens":1000,"output_tokens":50,"cache_read_input_tokens":20000,"cache_creation_input_tokens":500,"reasoning_tokens":10}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"x.ai/session_notification","params":{"sessionUpdate":"turn_usage","sessionId":"grok-session","usage":{"input_tokens":329203,"output_tokens":4316}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"_x.ai/session/update","params":{"sessionId":"grok-session","update":{"sessionUpdate":"turn_completed","usage":{"inputTokens":329203,"outputTokens":4316,"totalTokens":333519}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"x.ai/session_notification","params":{"sessionId":"grok-session","sessionUpdate":"auto_compact_started","tokens_used":40000,"context_window":256000}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"_x.ai/session/update","params":{"sessionId":"grok-session","update":{"sessionUpdate":"auto_compact_completed","tokens_after":12000}}}'
      printf '{"jsonrpc":"2.0","id":%s,"result":{"stopReason":"end_turn","_meta":{"totalTokens":333519,"usage":{"inputTokens":329203,"outputTokens":4316,"totalTokens":333519,"modelCalls":13}}}}\n' "$id" ;;
  esac
done
"#,
        );
        let workspace = temp.path().to_path_buf();
        let run = |program: PathBuf| {
            let mut request = fixture_request(
                program,
                workspace.clone(),
                CancellationToken::default(),
                None,
            );
            request.provider_label = "xAI".into();
            let mut live_context = Vec::new();
            let output = run_kimi_acp(
                request,
                |_| {},
                |activity| {
                    if let Some(context) = activity.context_usage {
                        live_context.push(context);
                    }
                },
                |_| Ok(KimiAcpApprovalDecision::RejectOnce),
                |_, _| Ok(()),
            )
            .unwrap();
            (output, live_context)
        };
        let _ = run(script.clone());
        let plain = std::fs::read_to_string(workspace.join("initialize-request")).unwrap();
        assert!(
            !plain.contains("x.ai/statusLine"),
            "only the grok program advertises the status line"
        );
        let program = workspace.join("grok");
        symlink(&script, &program).unwrap();
        let (output, live_context) = run(program);
        let advertised = std::fs::read_to_string(workspace.join("initialize-request")).unwrap();
        assert!(advertised.contains("x.ai/statusLine"));
        assert!(!advertised.contains("incrementalBashOutput"));
        let window = |used| crate::acp_usage::AcpContextUsage {
            used,
            size: 256000,
            estimated: false,
        };
        assert!(
            live_context.iter().all(|reading| !reading.estimated),
            "status frames are measured; the serialized prompt is not occupancy"
        );
        assert_eq!(
            live_context.as_slice(),
            [
                window(33022),
                window(20800),
                window(21500),
                window(40000),
                window(12000)
            ]
        );
        assert_eq!(output.context_usage, Some(window(12000)));
        assert_eq!(output.response, "");
        assert_eq!(output.usage_observation.tokens.total_tokens, 333519);
    }

    #[cfg(unix)]
    #[test]
    fn grok_prompt_total_tokens_fill_context_only_when_they_are_not_the_turn_bill() {
        let accept = r#"{"jsonrpc":"2.0","id":6,"result":{"stopReason":"end_turn","_meta":{"totalTokens":33022,"usage":{"inputTokens":329203,"outputTokens":4316,"totalTokens":333519,"modelCalls":13}}}}"#;
        let reject = r#"{"jsonrpc":"2.0","id":6,"result":{"stopReason":"end_turn","_meta":{"totalTokens":333519,"usage":{"inputTokens":329203,"outputTokens":4316,"totalTokens":333519,"modelCalls":13}}}}"#;
        for (completion, context) in [
            (
                accept,
                Some(crate::acp_usage::AcpContextUsage {
                    used: 33022,
                    size: 0,
                    estimated: false,
                }),
            ),
            (reject, None),
        ] {
            let (temp, program) = completion_fixture(completion, false);
            let mut request = fixture_request(
                program,
                temp.path().into(),
                CancellationToken::default(),
                None,
            );
            request.provider_label = "xAI".into();
            let mut live_context = Vec::new();
            let output = run_kimi_acp(
                request,
                |_| {},
                |activity| {
                    if let Some(context) = activity.context_usage {
                        live_context.push(context);
                    }
                },
                |_| Ok(KimiAcpApprovalDecision::RejectOnce),
                |_, _| Ok(()),
            )
            .unwrap();
            assert_eq!(output.usage_observation.tokens.total_tokens, 333519);
            assert!(
                live_context.iter().all(|reading| reading.used != 333519),
                "the turn bill is not occupancy"
            );
            match context {
                Some(measured) => {
                    assert_eq!(output.context_usage, Some(measured));
                    assert_eq!(live_context.last().copied(), Some(measured));
                    assert!(live_context.iter().all(|reading| !reading.estimated));
                }
                None => {
                    assert_eq!(output.context_usage, None);
                    assert!(live_context.iter().all(|reading| !reading.estimated));
                }
            }
        }
    }

    #[test]
    fn grok_traffic_chars_count_tool_bodies_and_ignore_the_turn_bill() {
        assert_eq!(
            super::session_update_traffic_chars(&json!({
                "sessionUpdate": "tool_call",
                "rawInput": "12345678",
                "rawOutput": "not-yet",
            })),
            8
        );
        assert_eq!(
            super::session_update_traffic_chars(&json!({
                "sessionUpdate": "tool_call_update",
                "rawInput": "DO_NOT_COUNT",
                "rawOutput": "a".repeat(400),
            })),
            400
        );
        assert_eq!(
            super::session_update_traffic_chars(&json!({
                "sessionUpdate": "tool_call_update",
                "rawOutput": "same",
                "content": "same",
            })),
            4
        );
        assert_eq!(
            super::session_update_traffic_chars(&json!({
                "sessionUpdate": "tool_call_update",
                "rawOutput": "out",
                "content": {"type": "text", "text": "view"},
            })),
            7
        );
        assert_eq!(
            super::session_update_traffic_chars(&json!({
                "sessionUpdate": "agent_thought_chunk",
                "content": {"type": "text", "text": "think"},
            })),
            5
        );
        assert_eq!(
            super::session_update_traffic_chars(&json!({
                "sessionUpdate": "user_message_chunk",
                "content": {
                    "data": "x".repeat(100),
                    "mimeType": "image/png",
                    "type": "image"
                },
            })),
            0
        );
        assert_eq!(
            super::session_update_traffic_chars(&json!({
                "sessionUpdate": "turn_completed",
                "usage": {"inputTokens": 7_515_785, "modelCalls": 67},
            })),
            0
        );
    }

    #[cfg(unix)]
    #[test]
    fn grok_traffic_estimate_grows_with_tool_output_until_a_wire_reading() {
        let (temp, program) = acp_fixture(
            r#"
while IFS= read -r line; do
  id=${line#*'"id":'}
  id=${id%%,*}
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"authMethods":[{"id":"login"}]}}\n' "$id" ;;
    *'"method":"authenticate"'*|*'"method":"session/set_model"'*|*'"method":"session/set_config_option"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id" ;;
    *'"method":"session/new"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"sessionId":"grok-session"}}\n' "$id" ;;
    *'"method":"session/prompt"'*)
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"t1","rawInput":"12345678"}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"t1","rawInput":"DO_NOT_COUNT","rawOutput":"aaaaaaaa"}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"_x.ai/session/update","params":{"sessionId":"grok-session","update":{"sessionUpdate":"turn_completed","usage":{"inputTokens":7515785,"modelCalls":67}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"session_status","context_window":{"context_tokens":180000,"context_window_size":500000}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"t2","rawOutput":"bbbbbbbbbbbbbbbb"}}}'
      printf '{"jsonrpc":"2.0","id":%s,"result":{"stopReason":"end_turn","_meta":{"totalTokens":7554536,"usage":{"inputTokens":7515785,"modelCalls":67,"totalTokens":7554536}}}}\n' "$id" ;;
  esac
done
"#,
        );
        let mut request = fixture_request(
            program,
            temp.path().into(),
            CancellationToken::default(),
            None,
        );
        request.provider_label = "xAI".into();
        let mut live_context = Vec::new();
        let output = run_kimi_acp(
            request,
            |_| {},
            |activity| {
                if let Some(context) = activity.context_usage {
                    live_context.push(context);
                }
            },
            |_| Ok(KimiAcpApprovalDecision::RejectOnce),
            |_, _| Ok(()),
        )
        .unwrap();
        assert!(
            live_context.iter().all(|reading| !reading.estimated),
            "tool text is not occupancy"
        );
        assert_eq!(
            output.context_usage,
            Some(crate::acp_usage::AcpContextUsage {
                used: 180_000,
                size: 500_000,
                estimated: false,
            })
        );
        assert_eq!(live_context.last().copied(), output.context_usage);
        assert!(live_context.iter().all(|reading| reading.used != 7_515_785));
        assert_eq!(
            live_context
                .iter()
                .filter(|reading| !reading.estimated)
                .count(),
            1,
            "tool output after the wire reading must not move occupancy"
        );
    }

    #[cfg(unix)]
    #[test]
    fn grok_update_total_tokens_replace_the_character_estimate() {
        let (temp, program) = acp_fixture(
            r#"
while IFS= read -r line; do
  id=${line#*'"id":'}
  id=${id%%,*}
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"authMethods":[{"id":"login"}]}}\n' "$id" ;;
    *'"method":"authenticate"'*|*'"method":"session/set_model"'*|*'"method":"session/set_config_option"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id" ;;
    *'"method":"session/new"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"sessionId":"grok-session"}}\n' "$id" ;;
    *'"method":"session/prompt"'*)
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"t1","rawOutput":"aaaaaaaa"}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"_meta":{"totalTokens":136243,"requestTrimmedTokens":0},"update":{"sessionUpdate":"tool_call_update","toolCallId":"t2","rawOutput":"bbbbbbbbbbbbbbbb"}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"t3","rawOutput":"cccccccccccccccccccccccccccccccc"}}}'
      printf '{"jsonrpc":"2.0","id":%s,"result":{"stopReason":"end_turn","_meta":{"totalTokens":7554536,"usage":{"inputTokens":7515785,"modelCalls":67,"totalTokens":7554536}}}}\n' "$id" ;;
  esac
done
"#,
        );
        let mut request = fixture_request(
            program,
            temp.path().into(),
            CancellationToken::default(),
            None,
        );
        request.provider_label = "xAI".into();
        let mut live_context = Vec::new();
        let output = run_kimi_acp(
            request,
            |_| {},
            |activity| {
                if let Some(context) = activity.context_usage {
                    live_context.push(context);
                }
            },
            |_| Ok(KimiAcpApprovalDecision::RejectOnce),
            |_, _| Ok(()),
        )
        .unwrap();
        let measured = crate::acp_usage::AcpContextUsage {
            used: 136_243,
            size: 0,
            estimated: false,
        };
        assert_eq!(output.context_usage, Some(measured));
        assert_eq!(live_context.last().copied(), Some(measured));
        assert!(live_context.iter().all(|reading| !reading.estimated));
        assert!(live_context.iter().all(|reading| reading.used != 7_554_536));
        assert_eq!(
            live_context
                .iter()
                .filter(|reading| !reading.estimated)
                .count(),
            1,
            "tool text after the prompt total must not move occupancy"
        );
    }

    #[cfg(unix)]
    #[test]
    fn kimi_acp_fixture_reports_unavailable_even_with_text_and_synthetic_usage() {
        use crate::usage::{UsageCoverage, UsageReason};
        let _scope = crate::provider_observation::Scope::start();
        crate::provider_observation::attempt();
        let (temp, program) = completion_fixture(
            r#"{"jsonrpc":"2.0","id":6,"result":{"stopReason":"end_turn","usage":{"inputTokens":100,"outputTokens":20}}}"#,
            false,
        );
        let output = run_kimi_acp(
            fixture_request(
                program,
                temp.path().to_path_buf(),
                CancellationToken::default(),
                None,
            ),
            |_| {},
            |_| {},
            |_| Ok(KimiAcpApprovalDecision::RejectOnce),
            |_, _| Ok(()),
        )
        .unwrap();
        assert!(!output.response.is_empty());
        let accounting = output.usage_observation.tokens.effective_accounting();
        assert_eq!(accounting.coverage, UsageCoverage::Unavailable);
        assert_eq!(accounting.reason, Some(UsageReason::UnsupportedRuntime));
        assert_eq!(
            crate::provider_observation::snapshot()
                .unwrap()
                .tokens
                .unwrap()
                .effective_accounting(),
            accounting
        );
    }

    #[test]
    fn acp_diff_content_counts_changed_lines() {
        let content = serde_json::json!([
            { "type": "content", "content": { "type": "text", "text": "done" } },
            { "type": "diff", "path": "/r/a.rs", "oldText": "a\nb\n", "newText": "a\nc\nd\n" },
            { "type": "diff", "path": "/r/new.rs", "newText": "x\ny\n" }
        ]);
        assert_eq!(acp_diff_counts(Some(&content)), Some((4, 1)));
        let no_diff = serde_json::json!([{ "type": "content" }]);
        assert_eq!(acp_diff_counts(Some(&no_diff)), None);
        assert_eq!(acp_diff_counts(None), None);
    }

    #[test]
    fn direct_acp_reads_refuse_sensitive_files_and_aliases() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join(".env"), "PRIVATE_VALUE=fixture").unwrap();
        std::fs::write(temp.path().join("source.rs"), "first\nsecond\n").unwrap();
        assert!(
            super::read_workspace_text_file(temp.path(), &json!({"path": ".env"}))
                .unwrap_err()
                .to_string()
                .contains("governed")
        );
        assert_eq!(
            super::read_workspace_text_file(
                temp.path(),
                &json!({"path": "source.rs", "line": 2, "limit": 1})
            )
            .unwrap(),
            "second"
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(temp.path().join(".env"), temp.path().join("innocent.txt"))
                .unwrap();
            assert!(
                super::read_workspace_text_file(temp.path(), &json!({"path": "innocent.txt"}))
                    .is_err()
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn oversized_frame_without_newline_fails_before_the_peer_closes() {
        let (temp, program) = acp_fixture(
            "read line\ndd if=/dev/zero bs=1048577 count=1 2>/dev/null | tr '\\000' x\nsleep 10",
        );
        let started = std::time::Instant::now();
        let error = run_kimi_acp(
            fixture_request(
                program,
                temp.path().to_path_buf(),
                CancellationToken::default(),
                None,
            ),
            |_| {},
            |_| {},
            |_| Ok(KimiAcpApprovalDecision::RejectOnce),
            |_, _| Ok(()),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("size limit"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn a_selected_model_is_renamed_to_the_id_the_agent_advertises() {
        let offered = vec![
            "kimi-code/kimi-for-coding".to_string(),
            "kimi-code/k3-256k".to_string(),
            "kimi-code/k3".to_string(),
        ];

        // Gyro's catalog id is the leaf of the agent's namespaced id.
        assert_eq!(acp_model_id("k3", &offered), "kimi-code/k3");
        // An id the agent already speaks is left exactly as it is.
        assert_eq!(
            acp_model_id("kimi-code/k3-256k", &offered),
            "kimi-code/k3-256k"
        );
        // Nothing advertised matches, so the agent gets to reject it itself.
        assert_eq!(acp_model_id("gpt-5.6", &offered), "gpt-5.6");
        // An agent that advertises nothing is sent the selection unchanged.
        assert_eq!(acp_model_id("k3", &[]), "k3");
    }

    #[test]
    fn model_options_are_read_from_the_session_the_agent_opened() {
        let session = serde_json::json!({
            "sessionId": "session_1",
            "configOptions": [
                { "id": "thinking", "options": [{ "value": "high" }] },
                {
                    "id": "model",
                    "currentValue": "kimi-code/k3-256k",
                    "options": [
                        { "value": "kimi-code/k3-256k", "name": "K3-256k" },
                        { "value": "kimi-code/k3", "name": "K3" }
                    ]
                }
            ]
        });

        assert_eq!(
            acp_offered_model_ids(&session),
            vec!["kimi-code/k3-256k".to_string(), "kimi-code/k3".to_string()]
        );
        // An agent that lists no models leaves the selection untranslatable.
        assert!(acp_offered_model_ids(&serde_json::json!({ "sessionId": "s" })).is_empty());
    }

    use crate::CancellationToken;
    use serde_json::json;
    use std::ffi::OsString;
    use std::path::PathBuf;
    use std::time::Duration;

    #[cfg(unix)]
    fn acp_fixture(script: &str) -> (tempfile::TempDir, PathBuf) {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("fake-kimi-acp.sh");
        std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&path, permissions).unwrap();
        (temp, path)
    }

    #[cfg(unix)]
    fn fixture_request(
        program: PathBuf,
        workspace: PathBuf,
        cancellation: CancellationToken,
        resume_session_id: Option<String>,
    ) -> KimiAcpRequest {
        KimiAcpRequest {
            provider_label: "Kimi".into(),
            program: program.into_os_string(),
            program_args: Vec::new(),
            auth_method_ids: vec!["login".into()],
            workspace,
            prompt: vec![json!({"type": "text", "text": "hello"})],
            resumed_prompt: None,
            conversation_history_text: None,
            mcp_servers: Vec::new(),
            model: "k3".into(),
            reasoning_effort: Some("max".into()),
            mode: KimiAcpMode::Normal,
            auto_allow_permissions: false,
            resume_session_id,
            timeout: Duration::from_secs(3),
            inactivity_timeout: Duration::from_secs(3),
            cancellation,
            credentials: CredentialPolicy::for_provider("kimi"),
            opened_session: None,
        }
    }

    #[cfg(unix)]
    fn kimi_code_usage_fixture(mode: &str) -> (tempfile::TempDir, PathBuf) {
        acp_fixture(&format!(
            r#"
starts=0
test ! -f starts || starts=$(cat starts)
starts=$((starts + 1))
printf '%s' "$starts" > starts
queries=0
while IFS= read -r line; do
  id=${{line#*'"id":'}}
  id=${{id%%,*}}
  case "$line" in
    *'"method":"initialize"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{"protocolVersion":1,"agentInfo":{{"name":"Kimi Code CLI","version":"0.37.2"}}}}}}\n' "$id" ;;
    *'"method":"authenticate"'*|*'"method":"session/set_model"'*|*'"method":"session/set_config_option"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{}}}}\n' "$id" ;;
    *'"method":"session/new"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{"sessionId":"same-session"}}}}\n' "$id" ;;
    *'"method":"session/resume"'*|*'"method":"session/load"'*)
      if test '{mode}' = resume-failure && test "$starts" = 2; then
        printf '{{"jsonrpc":"2.0","id":%s,"error":{{"code":-32601,"message":"Method not found"}}}}\n' "$id"
      else
        printf '{{"jsonrpc":"2.0","id":%s,"result":{{"sessionId":"same-session"}}}}\n' "$id"
      fi ;;
    *'"text":"/usage"'*)
      queries=$((queries + 1))
      printf 'query\n' >> queries
      if {{ {{ test '{mode}' = timeout || test '{mode}' = resume-failure; }} && test "$starts" = 1; }} || {{ test '{mode}' = post-timeout && test "$queries" = 2; }}; then
        printf '%s\n' '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"same-session","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"internal report must never leak"}}}}}}}}'
        sleep 10
      elif test '{mode}' = error || {{ test '{mode}' = post-error && test "$queries" = 2; }}; then
        printf '{{"jsonrpc":"2.0","id":%s,"error":{{"code":-32603,"message":"usage query failed"}}}}\n' "$id"
      else
        input=1000
        output=100
        context_text="Context: 99999 tokens"
        if test "$queries" = 2; then
          input=1470
          output=145
          if test '{mode}' = text-context; then
            context_text="Context: 51000 / 262144 tokens (19%)"
          else
            printf '%s\n' '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"same-session","update":{{"sessionUpdate":"usage_update","used":99999,"size":200000}}}}}}'
          fi
        elif test '{mode}' = text-context; then
          context_text="Context: 40000 / 262144 tokens (15%)"
        fi
        printf '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"same-session","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"%s\\nSession total: %s input, %s output"}}}}}}}}\n' "$context_text" "$input" "$output"
        printf '{{"jsonrpc":"2.0","id":%s,"result":{{"stopReason":"end_turn"}}}}\n' "$id"
      fi ;;
    *'"method":"session/prompt"'*)
      printf 'generation\n' >> generations
      printf '%s\n' "$line" >> generation-requests
      printf '%s\n' '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"same-session","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"original answer"}}}}}}}}'
      printf '{{"jsonrpc":"2.0","id":%s,"result":{{"stopReason":"end_turn"}}}}\n' "$id" ;;
  esac
done
"#
        ))
    }

    #[cfg(unix)]
    #[test]
    fn kimi_code_local_usage_queries_recover_real_counts_without_publishing_report_or_generating_again(
    ) {
        let _scope = crate::provider_observation::Scope::start();
        crate::provider_observation::attempt();
        let (temp, program) = kimi_code_usage_fixture("success");
        let mut deltas = String::new();
        let output = run_kimi_acp(
            fixture_request(
                program,
                temp.path().into(),
                CancellationToken::default(),
                None,
            ),
            |text| deltas.push_str(text),
            |_| {},
            |_| panic!("metadata must not request approval"),
            |_, _| panic!("metadata must not write files"),
        )
        .unwrap();
        assert_eq!(output.response, "original answer");
        assert_eq!(deltas, "original answer");
        assert_eq!(
            output.context_usage,
            Some(crate::acp_usage::AcpContextUsage {
                used: 99999,
                size: 200000,
                estimated: false,
            })
        );
        assert_eq!(
            std::fs::read_to_string(temp.path().join("generations")).unwrap(),
            "generation\n"
        );
        assert_eq!(
            std::fs::read_to_string(temp.path().join("queries")).unwrap(),
            "query\nquery\n"
        );
        let tokens = output.usage_observation.tokens;
        assert_eq!(
            (
                tokens.input_tokens,
                tokens.output_tokens,
                tokens.total_tokens
            ),
            (470, 45, 515)
        );
        assert_eq!(
            tokens.effective_accounting().coverage,
            crate::usage::UsageCoverage::Partial
        );
        let summary = crate::provider_observation::snapshot().unwrap();
        assert_eq!(summary.tokens, Some(tokens));
        assert_eq!(
            (summary.requests, summary.provider_attempts, summary.retries),
            (0, 1, 0)
        );
        assert_eq!(summary.usage_observations.len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn kimi_code_usage_text_sets_occupancy_when_no_usage_update_arrives() {
        let (temp, program) = kimi_code_usage_fixture("text-context");
        let mut deltas = String::new();
        let mut live_context = Vec::new();
        let output = run_kimi_acp(
            fixture_request(
                program,
                temp.path().into(),
                CancellationToken::default(),
                None,
            ),
            |text| deltas.push_str(text),
            |activity| {
                if let Some(context) = activity.context_usage {
                    live_context.push(context);
                }
            },
            |_| panic!("metadata must not request approval"),
            |_, _| panic!("metadata must not write files"),
        )
        .unwrap();
        assert_eq!(deltas, "original answer");
        assert_eq!(
            output.context_usage,
            Some(crate::acp_usage::AcpContextUsage {
                used: 51000,
                size: 262144,
                estimated: false,
            })
        );
        assert_eq!(
            live_context,
            vec![
                crate::acp_usage::AcpContextUsage {
                    used: 40000,
                    size: 262144,
                    estimated: false,
                },
                crate::acp_usage::AcpContextUsage {
                    used: 51000,
                    size: 262144,
                    estimated: false,
                },
            ]
        );
        let tokens = output.usage_observation.tokens;
        assert_eq!(
            (
                tokens.input_tokens,
                tokens.output_tokens,
                tokens.total_tokens
            ),
            (470, 45, 515)
        );
    }

    #[cfg(unix)]
    #[test]
    fn kimi_code_usage_query_errors_preserve_the_original_answer_and_unavailable_receipt() {
        for mode in ["error", "post-error"] {
            let (temp, program) = kimi_code_usage_fixture(mode);
            let mut deltas = String::new();
            let output = run_kimi_acp(
                fixture_request(
                    program,
                    temp.path().into(),
                    CancellationToken::default(),
                    None,
                ),
                |text| deltas.push_str(text),
                |_| {},
                |_| panic!("unexpected approval"),
                |_, _| Ok(()),
            )
            .unwrap();
            assert_eq!(output.response, "original answer");
            assert_eq!(deltas, "original answer");
            assert_eq!(
                output
                    .usage_observation
                    .tokens
                    .effective_accounting()
                    .coverage,
                crate::usage::UsageCoverage::Unavailable
            );
            assert_eq!(
                std::fs::read_to_string(temp.path().join("generations")).unwrap(),
                "generation\n"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn kimi_code_usage_query_timeout_reopens_before_the_only_generation_and_cannot_leak_text() {
        let _scope = crate::provider_observation::Scope::start();
        crate::provider_observation::attempt();
        let (temp, program) = kimi_code_usage_fixture("timeout");
        let mut request = fixture_request(
            program,
            temp.path().into(),
            CancellationToken::default(),
            None,
        );
        request.timeout = Duration::from_secs(6);
        let mut deltas = String::new();
        let started = std::time::Instant::now();
        let output = run_kimi_acp(
            request,
            |text| deltas.push_str(text),
            |_| {},
            |_| panic!("unexpected approval"),
            |_, _| Ok(()),
        )
        .unwrap();
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_eq!(
            std::fs::read_to_string(temp.path().join("starts")).unwrap(),
            "2"
        );
        assert_eq!(
            std::fs::read_to_string(temp.path().join("generations")).unwrap(),
            "generation\n"
        );
        assert_eq!(deltas, "original answer");
        assert_eq!(output.response, "original answer");
        assert!(!output.resumed);
        assert_eq!(
            crate::provider_observation::snapshot()
                .unwrap()
                .provider_attempts,
            1
        );
    }

    #[cfg(unix)]
    #[test]
    fn kimi_code_usage_timeout_preserves_the_exact_fresh_handoff_and_resumed_prompt() {
        for resumed in [false, true] {
            let (temp, program) = kimi_code_usage_fixture("timeout");
            let mut request = fixture_request(
                program,
                temp.path().into(),
                CancellationToken::default(),
                resumed.then(|| "same-session".into()),
            );
            request.prompt = vec![json!({"type":"text","text":"full instructions"})];
            request.resumed_prompt = Some("selected short".into());
            request.conversation_history_text = Some("earlier context".into());
            request.timeout = Duration::from_secs(6);
            let output = run_kimi_acp(
                request,
                |_| {},
                |_| {},
                |_| panic!("unexpected approval"),
                |_, _| Ok(()),
            )
            .unwrap();
            assert_eq!(output.resumed, resumed);
            let sent = std::fs::read_to_string(temp.path().join("generation-requests")).unwrap();
            assert_eq!(sent.lines().count(), 1);
            let sent: serde_json::Value = serde_json::from_str(sent.trim()).unwrap();
            let expected = if resumed {
                vec![json!({"type":"text","text":"selected short"})]
            } else {
                vec![
                    json!({"type":"text","text":"Prior conversation in this Gyro chat (this is a fresh agent session for a local Gyro chat handoff, so this is continuity context):\nearlier context"}),
                    json!({"type":"text","text":"full instructions"}),
                ]
            };
            assert_eq!(sent["params"]["prompt"], json!(expected));
        }
    }

    #[cfg(unix)]
    #[test]
    fn kimi_code_usage_timeout_cannot_send_a_resumed_prompt_to_an_unrelated_fresh_session() {
        let (temp, program) = kimi_code_usage_fixture("resume-failure");
        let mut request = fixture_request(
            program,
            temp.path().into(),
            CancellationToken::default(),
            Some("same-session".into()),
        );
        request.timeout = Duration::from_secs(6);
        let result = run_kimi_acp(
            request,
            |_| panic!("unexpected text"),
            |_| {},
            |_| panic!("unexpected approval"),
            |_, _| Ok(()),
        );
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("no generation was sent"));
        assert!(!temp.path().join("generations").exists());
    }

    #[cfg(unix)]
    #[test]
    fn kimi_code_cancellation_during_local_usage_query_never_starts_generation() {
        let (temp, program) = kimi_code_usage_fixture("timeout");
        let cancellation = CancellationToken::default();
        let cancel = cancellation.clone();
        let directory = temp.path().to_path_buf();
        let cancelling = std::thread::spawn(move || {
            for _ in 0..500 {
                if directory.join("queries").exists() {
                    cancel.cancel();
                    return;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            panic!("usage query did not start");
        });
        let started = std::time::Instant::now();
        let mut request = fixture_request(program, temp.path().into(), cancellation, None);
        request.timeout = Duration::from_secs(6);
        let result = run_kimi_acp(
            request,
            |_| panic!("internal report leaked"),
            |_| {},
            |_| panic!("unexpected approval"),
            |_, _| Ok(()),
        );
        cancelling.join().unwrap();
        assert!(result.unwrap_err().to_string().contains("cancelled"));
        // What this proves is that cancellation does not wait for the usage-query timeout (6s).
        // The bound used to be 2s, which a full-suite run on an oversubscribed machine exceeds on
        // scheduling alone — this returns in ~0.2s isolated. 4s keeps the assertion meaningful
        // while measuring behaviour instead of machine load.
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "cancellation waited for the usage query: {:?}",
            started.elapsed()
        );
        assert!(!temp.path().join("generations").exists());
        assert_eq!(
            std::fs::read_to_string(temp.path().join("starts")).unwrap(),
            "1"
        );
    }

    #[cfg(unix)]
    #[test]
    fn kimi_code_cancellation_during_final_usage_query_is_honored_without_replay() {
        let (temp, program) = kimi_code_usage_fixture("post-timeout");
        let cancellation = CancellationToken::default();
        let cancel = cancellation.clone();
        let directory = temp.path().to_path_buf();
        let cancelling = std::thread::spawn(move || {
            for _ in 0..500 {
                if std::fs::read_to_string(directory.join("queries"))
                    .ok()
                    .is_some_and(|text| text.lines().count() == 2)
                {
                    cancel.cancel();
                    return;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            panic!("final usage query did not start");
        });
        let mut deltas = String::new();
        let mut request = fixture_request(program, temp.path().into(), cancellation, None);
        request.timeout = Duration::from_secs(6);
        let result = run_kimi_acp(
            request,
            |text| deltas.push_str(text),
            |_| {},
            |_| panic!("unexpected approval"),
            |_, _| Ok(()),
        );
        cancelling.join().unwrap();
        assert!(result.unwrap_err().to_string().contains("cancelled"));
        assert_eq!(deltas, "original answer");
        assert_eq!(
            std::fs::read_to_string(temp.path().join("generations")).unwrap(),
            "generation\n"
        );
        assert_eq!(
            std::fs::read_to_string(temp.path().join("starts")).unwrap(),
            "1"
        );
    }

    #[cfg(unix)]
    fn completion_fixture(completion: &str, collide: bool) -> (tempfile::TempDir, PathBuf) {
        let permission = if collide {
            r#"printf '%s\n' '{"jsonrpc":"2.0","id":6,"method":"session/request_permission","params":{"toolCall":{"kind":"read","title":"Read project code"},"options":[{"optionId":"yes","kind":"allow_once"}]}}'"#
        } else {
            "finish"
        };
        acp_fixture(&format!(
            r#"
finish() {{
  printf '%s\n' '{{"jsonrpc":"2.0","method":"session/update","params":{{"update":{{"sessionUpdate":"tool_call_update","toolCallId":"read-code","status":"completed"}}}}}}'
  printf '%s\n' '{{"jsonrpc":"2.0","method":"session/update","params":{{"update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"The terminal button opens a terminal."}}}}}}}}'
  printf '%s\n' '{completion}'
}}
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) printf '%s\n' '{{"jsonrpc":"2.0","id":1,"result":{{"authMethods":[{{"id":"login"}}]}}}}' ;;
    *'"method":"authenticate"'*) printf '%s\n' '{{"jsonrpc":"2.0","id":2,"result":{{}}}}' ;;
    *'"method":"session/new"'*) printf '%s\n' '{{"jsonrpc":"2.0","id":3,"result":{{"sessionId":"collision-session"}}}}' ;;
    *'"method":"session/set_model"'*) printf '%s\n' '{{"jsonrpc":"2.0","id":4,"result":{{}}}}' ;;
    *'"method":"session/set_config_option"'*) printf '%s\n' '{{"jsonrpc":"2.0","id":5,"result":{{}}}}' ;;
    *'"method":"session/prompt"'*)
      printf '%s\n' '{{"jsonrpc":"2.0","method":"session/update","params":{{"update":{{"sessionUpdate":"tool_call","toolCallId":"read-code","kind":"read","status":"in_progress"}}}}}}'
      {permission} ;;
    *'"id":6'*)
      case "$line" in *'"optionId":"yes"'*) finish ;; *) exit 7 ;; esac ;;
  esac
done
"#
        ))
    }

    #[cfg(unix)]
    #[test]
    fn screenshot_prompt_can_exceed_incoming_frame_limit() {
        let (temp, program) = completion_fixture(
            r#"{"jsonrpc":"2.0","id":6,"result":{"stopReason":"end_turn"}}"#,
            false,
        );
        let mut request = fixture_request(
            program,
            temp.path().into(),
            CancellationToken::default(),
            None,
        );
        // The reported 1,081,323-byte PNG occupies 1,441,764 base64 bytes.
        request.prompt.push(json!({
            "type": "image", "mimeType": "image/png", "data": "A".repeat(1_441_764),
        }));
        request.timeout = Duration::from_secs(15);
        request.inactivity_timeout = Duration::from_secs(15);
        let output = run_kimi_acp(
            request,
            |_| {},
            |_| {},
            |_| Ok(KimiAcpApprovalDecision::AllowOnce),
            |_, _| Ok(()),
        )
        .unwrap();
        assert_eq!(output.stop_reason, "end_turn");
        assert_eq!(output.response, "The terminal button opens a terminal.");
    }

    #[cfg(unix)]
    #[test]
    fn permission_request_with_prompt_id_does_not_complete_turn() {
        let (temp, program) = completion_fixture(
            r#"{"jsonrpc":"2.0","id":6,"result":{"stopReason":"end_turn"}}"#,
            true,
        );
        let mut approvals = 0;
        let mut activities = Vec::new();
        let output = run_kimi_acp(
            fixture_request(
                program,
                temp.path().into(),
                CancellationToken::default(),
                None,
            ),
            |_| {},
            |activity| activities.push(activity.clone()),
            |_| {
                approvals += 1;
                Ok(KimiAcpApprovalDecision::AllowOnce)
            },
            |_, _| Ok(()),
        )
        .unwrap();
        assert_eq!(approvals, 1, "the colliding request must be answered");
        assert_eq!(output.response, "The terminal button opens a terminal.");
        assert_eq!(output.stop_reason, "end_turn");
        assert_eq!(activities.last().unwrap().status, "done");
    }

    /// Full access must never depend on a card being shown or answered. An agent
    /// that ends its turn over a declined tool would otherwise kill the run with
    /// every step around it.
    #[cfg(unix)]
    #[test]
    fn full_access_answers_permissions_without_an_approval_card() {
        let (temp, program) = completion_fixture(
            r#"{"jsonrpc":"2.0","id":6,"result":{"stopReason":"end_turn"}}"#,
            true,
        );
        let mut request = fixture_request(program, temp.path().into(), Default::default(), None);
        request.auto_allow_permissions = true;
        let mut approvals = 0;
        let output = run_kimi_acp(
            request,
            |_| {},
            |_| {},
            |_| {
                approvals += 1;
                Ok(KimiAcpApprovalDecision::RejectOnce)
            },
            |_, _| Ok(()),
        )
        .unwrap();
        assert_eq!(approvals, 0, "full access must not open a card");
        assert_eq!(output.stop_reason, "end_turn");
        assert_eq!(output.response, "The terminal button opens a terminal.");
    }

    #[cfg(unix)]
    #[test]
    fn malformed_prompt_completion_is_not_reported_as_end_turn() {
        for completion in [
            r#"{"jsonrpc":"2.0","id":6}"#,
            r#"{"jsonrpc":"2.0","id":6,"result":null}"#,
            r#"{"jsonrpc":"2.0","id":6,"result":{}}"#,
            r#"{"jsonrpc":"2.0","id":6,"result":{"stopReason":""}}"#,
        ] {
            let (temp, program) = completion_fixture(completion, false);
            let result = run_kimi_acp(
                fixture_request(
                    program,
                    temp.path().into(),
                    CancellationToken::default(),
                    None,
                ),
                |_| {},
                |_| {},
                |_| Ok(KimiAcpApprovalDecision::AllowOnce),
                |_, _| Ok(()),
            );
            assert!(result.is_err(), "invalid completion accepted: {completion}");
        }
    }

    /// An agent that reports a rejected permission the way the ACP spec says
    /// it must: it ends the prompt with `cancelled`, then answers a second
    /// prompt normally. The turn keeps its streamed text and finishes.
    #[cfg(unix)]
    fn cancel_continuation_fixture() -> (tempfile::TempDir, PathBuf) {
        acp_fixture(
            r#"
prompts=0
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"authMethods":[{"id":"login"}]}}' ;;
    *'"method":"authenticate"'*) printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{}}' ;;
    *'"method":"session/new"'*) printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"sessionId":"declined-session"}}' ;;
    *'"method":"session/set_model"'*|*'"method":"session/set_config_option"'*)
      id=${line#*'"id":'}
      id=${id%%,*}
      printf '%s\n' '{"jsonrpc":"2.0","id":'"$id"',"result":{}}' ;;
    *'"method":"session/prompt"'*)
      id=${line#*'"id":'}
      id=${id%%,*}
      prompts=$((prompts + 1))
      if test "$prompts" -eq 1; then
        printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Before the declined tool."}}}}'
        printf '%s\n' '{"jsonrpc":"2.0","id":'"$id"',"result":{"stopReason":"cancelled"}}'
      else
        printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":" Continued after it."}}}}'
        printf '%s\n' '{"jsonrpc":"2.0","id":'"$id"',"result":{"stopReason":"end_turn"}}'
      fi ;;
  esac
done
"#,
        )
    }

    #[cfg(unix)]
    #[test]
    fn a_cancelled_prompt_continues_the_turn_instead_of_failing_it() {
        let (temp, program) = cancel_continuation_fixture();
        let cancellation = CancellationToken::default();
        let mut streamed = String::new();
        let output = run_kimi_acp(
            fixture_request(program, temp.path().into(), cancellation.clone(), None),
            |text| streamed.push_str(text),
            |_| {},
            |_| Ok(KimiAcpApprovalDecision::AllowOnce),
            |_, _| Ok(()),
        )
        .expect("one cancelled prompt must not fail the turn");
        assert_eq!(output.stop_reason, "end_turn");
        // Both halves are kept: the work before the cancel and the continuation.
        assert!(output.response.contains("Before the declined tool."));
        assert!(output.response.contains("Continued after it."));
        assert!(!cancellation.is_cancelled(), "nobody pressed Stop");
    }

    /// `end_turn` continues only when that same result sets truncated.
    #[cfg(unix)]
    fn end_turn_mark_fixture(kind: &str) -> (tempfile::TempDir, PathBuf) {
        let answer = match kind {
            "join" => {
                r#"if test "$prompts" -eq 1; then
        printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hel"}}}}'
        printf '%s\n' '{"jsonrpc":"2.0","id":'"$id"',"result":{"stopReason":"end_turn","truncated":true}}'
      else
        printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"lo"}}}}'
        printf '%s\n' '{"jsonrpc":"2.0","id":'"$id"',"result":{"stopReason":"end_turn"}}'
      fi"#
            }
            "always" => {
                r#"printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"ab"}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","id":'"$id"',"result":{"stopReason":"end_turn","_meta":{"truncated":true}}}'"#
            }
            _ => {
                r#"if test "$prompts" -eq 1; then
        printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Finished."}}}}'
        printf '%s\n' '{"jsonrpc":"2.0","id":'"$id"',"result":{"stopReason":"end_turn"}}'
      else
        printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"SHOULD NOT CONTINUE"}}}}'
        printf '%s\n' '{"jsonrpc":"2.0","id":'"$id"',"result":{"stopReason":"end_turn"}}'
      fi"#
            }
        };
        let script = r#"
prompts=0
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"authMethods":[{"id":"login"}]}}' ;;
    *'"method":"authenticate"'*) printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{}}' ;;
    *'"method":"session/new"'*) printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"sessionId":"limit-session"}}' ;;
    *'"method":"session/set_model"'*|*'"method":"session/set_config_option"'*)
      id=${line#*'"id":'}
      id=${id%%,*}
      printf '%s\n' '{"jsonrpc":"2.0","id":'"$id"',"result":{}}' ;;
    *'"method":"session/prompt"'*)
      id=${line#*'"id":'}
      id=${id%%,*}
      prompts=$((prompts + 1))
      @ANSWER@ ;;
  esac
done
"#
        .replace("@ANSWER@", answer);
        acp_fixture(&script)
    }

    #[cfg(unix)]
    #[test]
    fn end_turn_with_an_explicit_truncated_mark_continues_and_joins() {
        let (temp, program) = end_turn_mark_fixture("join");
        let output = run_kimi_acp(
            fixture_request(program, temp.path().into(), Default::default(), None),
            |_| {},
            |_| {},
            |_| Ok(KimiAcpApprovalDecision::AllowOnce),
            |_, _| Ok(()),
        )
        .expect("end_turn plus truncated must continue");
        assert_eq!(output.stop_reason, "end_turn");
        assert!(!output.truncated);
        assert!(
            output.response.contains("hello"),
            "halves did not rejoin: {}",
            output.response
        );
    }

    #[cfg(unix)]
    #[test]
    fn end_turn_that_stays_truncated_is_flagged_after_three_continuations() {
        let (temp, program) = end_turn_mark_fixture("always");
        let output = run_kimi_acp(
            fixture_request(program, temp.path().into(), Default::default(), None),
            |_| {},
            |_| {},
            |_| Ok(KimiAcpApprovalDecision::AllowOnce),
            |_, _| Ok(()),
        )
        .expect("the streamed answer is kept");
        assert_eq!(output.stop_reason, "end_turn");
        assert!(output.truncated);
        assert_eq!(output.response.matches("ab").count(), 4, "{}", output.response);
    }

    #[cfg(unix)]
    #[test]
    fn a_plain_end_turn_stays_finished() {
        let (temp, program) = end_turn_mark_fixture("plain");
        let output = run_kimi_acp(
            fixture_request(program, temp.path().into(), Default::default(), None),
            |_| {},
            |_| {},
            |_| Ok(KimiAcpApprovalDecision::AllowOnce),
            |_, _| Ok(()),
        )
        .expect("a plain end_turn is a finished answer");
        assert_eq!(output.stop_reason, "end_turn");
        assert!(!output.truncated);
        assert!(output.response.contains("Finished."));
        assert!(!output.response.contains("SHOULD NOT CONTINUE"));
    }

    /// An agent that ends the prompt at the model's output cap, the way Grok,
    /// Kimi and OpenCode report it: an ordinary result with `max_tokens` and
    /// the text stopping inside a word.
    #[cfg(unix)]
    fn output_limit_fixture(always_limited: bool) -> (tempfile::TempDir, PathBuf) {
        let answer = if always_limited {
            r#"printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Refused at the limit. `reso"}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","id":'"$id"',"result":{"stopReason":"max_tokens"}}'"#
        } else {
            r#"if test "$prompts" -eq 1; then
        printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Refused. `reso"}}}}'
        printf '%s\n' '{"jsonrpc":"2.0","id":'"$id"',"result":{"stopReason":"max_tokens"}}'
      else
        printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"urce resolution fails."}}}}'
        printf '%s\n' '{"jsonrpc":"2.0","id":'"$id"',"result":{"stopReason":"end_turn"}}'
      fi"#
        };
        let script = r#"
prompts=0
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"authMethods":[{"id":"login"}]}}' ;;
    *'"method":"authenticate"'*) printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{}}' ;;
    *'"method":"session/new"'*) printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"sessionId":"limit-session"}}' ;;
    *'"method":"session/set_model"'*|*'"method":"session/set_config_option"'*)
      id=${line#*'"id":'}
      id=${id%%,*}
      printf '%s\n' '{"jsonrpc":"2.0","id":'"$id"',"result":{}}' ;;
    *'"method":"session/prompt"'*)
      id=${line#*'"id":'}
      id=${id%%,*}
      prompts=$((prompts + 1))
      @ANSWER@ ;;
  esac
done
"#
        .replace("@ANSWER@", answer);
        acp_fixture(&script)
    }

    #[cfg(unix)]
    #[test]
    fn an_output_limit_stop_continues_the_answer_instead_of_ending_it() {
        let (temp, program) = output_limit_fixture(false);
        let mut streamed = String::new();
        let output = run_kimi_acp(
            fixture_request(program, temp.path().into(), Default::default(), None),
            |text| streamed.push_str(text),
            |_| {},
            |_| Ok(KimiAcpApprovalDecision::AllowOnce),
            |_, _| Ok(()),
        )
        .expect("an output-limit stop must not end the turn");
        assert_eq!(output.stop_reason, "end_turn");
        assert!(!output.truncated, "the continuation finished the answer");
        // The cut fell inside a word, so the halves join with nothing between
        // them; a paragraph break here would split that word for good.
        assert!(
            output.response.contains("`resource resolution fails."),
            "halves did not rejoin: {}",
            output.response
        );
        assert_eq!(output.response.matches("Refused.").count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn an_agent_that_never_finishes_is_flagged_not_failed() {
        let (temp, program) = output_limit_fixture(true);
        let output = run_kimi_acp(
            fixture_request(program, temp.path().into(), Default::default(), None),
            |_| {},
            |_| {},
            |_| Ok(KimiAcpApprovalDecision::AllowOnce),
            |_, _| Ok(()),
        )
        .expect("the streamed answer is real work and must be kept");
        assert_eq!(output.stop_reason, "max_tokens");
        assert!(
            output.truncated,
            "a turn that never finished must not read as complete"
        );
        assert!(output.response.contains("Refused at the limit."));
    }

    #[test]
    fn every_spelling_of_an_output_limit_is_recognised() {
        for reason in [
            "max_tokens",
            "maxTokens",
            "max_output_tokens",
            "maxTurnRequests",
            "max_turn_requests",
            "length",
            "token_limit",
            "step_limit",
            "context_limit",
        ] {
            assert!(
                acp_stop_is_output_limit(reason),
                "{reason} is an output limit"
            );
        }
        for reason in [
            "end_turn",
            "endTurn",
            "cancelled",
            "canceled",
            "refusal",
            "tool_use",
            "",
        ] {
            assert!(
                !acp_stop_is_output_limit(reason),
                "{reason} is not an output limit"
            );
        }
    }

    #[test]
    fn end_turn_continues_only_when_the_same_result_marks_output_truncated() {
        let marked = json!({"stopReason":"end_turn","truncated":true});
        let meta = json!({"stopReason":"endTurn","_meta":{"truncated":true}});
        let plain = json!({
            "stopReason": "end_turn",
            "truncated": false,
            "_meta": {"totalTokens": 3_000_000, "usage": {"input": 1}}
        });
        assert!(acp_result_needs_output_continuation("end_turn", &marked));
        assert!(acp_result_needs_output_continuation("endTurn", &meta));
        assert!(!acp_result_needs_output_continuation("end_turn", &plain));
        assert!(acp_result_needs_output_continuation("max_tokens", &plain));
        assert!(!acp_result_marks_output_truncated(&json!({
            "stopReason": "end_turn",
            "_meta": {"totalTokens": 9}
        })));
    }

    #[cfg(unix)]
    #[test]
    fn provider_refused_turns_are_not_successful_even_after_text() {
        // `cancelled` left this list on purpose: the runner now asks the same
        // session to carry on first, and only a second cancel surfaces. The
        // continuation test below covers that path.
        for (reason, expected_detail) in [("refusal", "ACP agent refused to continue")] {
            let completion = json!({
                "jsonrpc": "2.0", "id": 6, "result": {"stopReason": reason},
            });
            let (temp, program) = completion_fixture(&completion.to_string(), false);
            let cancellation = CancellationToken::default();
            let mut streamed = String::new();
            let result = run_kimi_acp(
                fixture_request(program, temp.path().into(), cancellation.clone(), None),
                |text| streamed.push_str(text),
                |_| {},
                |_| Ok(KimiAcpApprovalDecision::AllowOnce),
                |_, _| Ok(()),
            );
            assert!(
                !streamed.is_empty(),
                "the partial response must still stream"
            );
            assert!(
                result.is_err(),
                "provider {reason} was incorrectly treated as a completed turn"
            );
            assert!(result.unwrap_err().to_string().contains(expected_detail));
            assert!(
                !cancellation.is_cancelled(),
                "{reason} must not look like the user pressed Stop"
            );
        }
    }

    #[test]
    fn plan_mode_blocks_file_writes_and_lets_commands_through() {
        assert!(plan_mode_denies_approval(KimiAcpApprovalKind::FileChange));
        assert!(!plan_mode_denies_approval(KimiAcpApprovalKind::Command));
        assert!(!plan_mode_denies_approval(KimiAcpApprovalKind::Other));
    }

    #[cfg(unix)]
    #[test]
    fn new_acp_providers_stream_only_after_permission_denial_and_cancel_extension_input() {
        for (provider, auth) in [("Cursor", "cursor_login"), ("OpenCode", "opencode-login")] {
            let script = r#"
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"authMethods":[{"id":"AUTH"}],"agentCapabilities":{}}}' ;;
    *'"method":"authenticate"'*) printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{}}' ;;
    *'"method":"session/new"'*) printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"sessionId":"provider-session"}}' ;;
    *'"method":"session/set_config_option"'*) printf '%s\n' '{"jsonrpc":"2.0","id":4,"error":{"code":-32601,"message":"Method not found"}}' ;;
    *'"method":"session/prompt"'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":"permission","method":"session/request_permission","params":{"toolCall":{"kind":"execute","title":"Run shell command","rawInput":{"command":"touch forbidden"}},"options":[{"optionId":"yes","kind":"allow_once"},{"optionId":"no","kind":"reject_once"}]}}' ;;
    *'"id":"permission"'*)
      case "$line" in *'"optionId":"no"'*) ;; *) exit 7 ;; esac
      printf '%s\n' '{"jsonrpc":"2.0","id":"question","method":"cursor/ask_question","params":{"questions":[]}}' ;;
    *'"id":"question"'*)
      case "$line" in *'"outcome":"cancelled"'*) ;; *) exit 8 ;; esac
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Denied safely."}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","id":5,"result":{"stopReason":"end_turn"}}' ;;
  esac
done
"#.replace("AUTH", auth);
            let (temp, program) = acp_fixture(&script);
            let mut request = fixture_request(
                program,
                temp.path().into(),
                CancellationToken::default(),
                None,
            );
            request.provider_label = provider.into();
            request.auth_method_ids = vec![auth.into()];
            request.model = "provider-default".into();
            let mut permissions = 0;
            let result = run_kimi_acp(
                request,
                |_| {},
                |_| {},
                |approval| {
                    assert_eq!(approval.kind, KimiAcpApprovalKind::Command);
                    permissions += 1;
                    Ok(KimiAcpApprovalDecision::RejectOnce)
                },
                |_, _| panic!("Denied command must not write a file"),
            )
            .unwrap();
            assert_eq!(permissions, 1);
            assert_eq!(result.response, "Denied safely.");
            assert!(!temp.path().join("forbidden").exists());
        }
    }

    #[test]
    fn classifies_kimi_tool_approvals() {
        assert_eq!(
            classify_approval(&json!({"title": "Run Bash", "rawInput": {"command": "git status"}})),
            KimiAcpApprovalKind::Command
        );
        assert_eq!(
            classify_approval(&json!({"title": "Edit file", "rawInput": {"path": "src/lib.rs"}})),
            KimiAcpApprovalKind::FileChange
        );
    }

    #[test]
    fn selects_only_one_shot_permission_options() {
        let params = json!({"options": [
            {"optionId": "always", "kind": "allow_always"},
            {"optionId": "once", "kind": "allow_once"},
            {"optionId": "no", "kind": "reject_once"}
        ]});
        assert_eq!(
            permission_option_id(&params, KimiAcpApprovalDecision::AllowOnce),
            Some("once")
        );
        assert_eq!(
            permission_option_id(&params, KimiAcpApprovalDecision::RejectOnce),
            Some("no")
        );
    }

    #[test]
    fn answers_a_permission_request_whose_option_names_gyro_does_not_know() {
        // Consent under an unfamiliar label still gets an answer. A request Gyro
        // could not answer used to become a cancelled tool, and the agent ended
        // the whole turn for it.
        let unfamiliar = json!({"options": [
            {"optionId": "yes-proceed", "name": "Proceed"},
            {"optionId": "no-stop", "name": "Stop here"}
        ]});
        assert_eq!(
            permission_option_id(&unfamiliar, KimiAcpApprovalDecision::AllowOnce),
            Some("yes-proceed")
        );
        // A decline never borrows an option that reads as consent.
        assert_eq!(
            permission_option_id(&unfamiliar, KimiAcpApprovalDecision::RejectOnce),
            None
        );
        // The id alone tells the two sides apart.
        let ids_only = json!({"options": [
            {"optionId": "reject_once"},
            {"optionId": "allow_always"}
        ]});
        assert_eq!(
            permission_option_id(&ids_only, KimiAcpApprovalDecision::AllowOnce),
            Some("allow_always")
        );
        // A cancel option is never read as consent either.
        let with_abort = json!({"options": [
            {"optionId": "abort", "kind": "cancel"},
            {"optionId": "ok", "kind": "fine"}
        ]});
        assert_eq!(
            permission_option_id(&with_abort, KimiAcpApprovalDecision::AllowOnce),
            Some("ok")
        );
    }

    #[test]
    fn workspace_write_rejects_parent_escape() {
        let temp = tempfile::tempdir().unwrap();
        assert!(resolve_workspace_write_path(temp.path(), "../outside.txt").is_err());
    }

    #[test]
    fn activity_id_slug_follows_the_provider_label() {
        assert_eq!(acp_activity_id_slug("xAI"), "xai");
        assert_eq!(acp_activity_id_slug("Kimi"), "kimi");
        assert_eq!(acp_activity_id_slug("Gemini"), "gemini");
        assert_eq!(acp_activity_id_slug("  "), "acp");
    }

    #[test]
    fn acp_reopen_methods_read_initialize_capabilities() {
        let (resume, load) = acp_session_reopen_methods(&json!({
            "agentCapabilities": {
                "loadSession": true,
                "sessionCapabilities": {}
            }
        }));
        assert!(!resume);
        assert!(load);

        let (resume, load) = acp_session_reopen_methods(&json!({
            "agentCapabilities": {
                "sessionCapabilities": { "resume": {} }
            }
        }));
        assert!(resume);
        assert!(!load);

        let (resume, load) = acp_session_reopen_methods(&json!({}));
        assert!(!resume);
        assert!(!load);
    }

    #[test]
    fn method_not_found_is_detected() {
        assert!(is_acp_method_not_found("Method not found"));
        assert!(is_acp_method_not_found(
            r#"{"code":-32601,"message":"Method not found"}"#
        ));
        assert!(!is_acp_method_not_found("rate limit exceeded"));
    }

    #[cfg(unix)]
    #[test]
    fn runs_fresh_acp_session_and_streams_text_and_activity() {
        let (temp, program) = acp_fixture(
            r#"
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"authMethods":[{"id":"login"}]}}' ;;
    *'"method":"authenticate"'*) printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{}}' ;;
    *'"method":"session/new"'*) printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"sessionId":"fresh-session"}}' ;;
    *'"method":"session/set_model"'*) printf '%s\n' '{"jsonrpc":"2.0","id":4,"result":{}}' ;;
    *'"method":"session/set_config_option"'*) printf '%s\n' '{"jsonrpc":"2.0","id":5,"result":{}}' ;;
    *'"method":"session/prompt"'*)
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"tool-1","title":"Inspect files","kind":"read","status":"in_progress"}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello from K3"}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","id":6,"result":{"stopReason":"end_turn"}}' ;;
  esac
done
"#,
        );
        let mut deltas = Vec::new();
        let mut activities = Vec::new();
        let output = run_kimi_acp(
            fixture_request(
                program,
                temp.path().to_path_buf(),
                CancellationToken::default(),
                None,
            ),
            |delta| deltas.push(delta.to_string()),
            |activity| activities.push(activity.clone()),
            |_| Ok(KimiAcpApprovalDecision::RejectOnce),
            |_, _| Ok(()),
        )
        .unwrap();
        assert_eq!(output.session_id, "fresh-session");
        assert_eq!(output.response, "hello from K3");
        assert_eq!(deltas, ["hello from K3"]);
        assert_eq!(activities[0].id, "tool-1");
        assert!(!output.resumed);
    }

    /// A model handoff starts with no provider resume cursor. Local history
    /// must still be injected so the new model can continue the Gyro session.
    #[cfg(unix)]
    #[test]
    fn fresh_session_injects_local_history_for_model_handoff() {
        let (temp, program) = acp_fixture(
            r#"
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"authMethods":[{"id":"login"}],"agentCapabilities":{}}}' ;;
    *'"method":"authenticate"'*) printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{}}' ;;
    *'"method":"session/new"'*) printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"sessionId":"handoff-session"}}' ;;
    *'"method":"session/set_model"'*) printf '%s\n' '{"jsonrpc":"2.0","id":4,"result":{}}' ;;
    *'"method":"session/set_config_option"'*) printf '%s\n' '{"jsonrpc":"2.0","id":5,"result":{}}' ;;
    *'"method":"session/prompt"'*)
      case "$line" in
        *short\ resumed\ context*) exit 9 ;;
        *Prior\ conversation*)
          printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"handoff-aware reply"}}}}'
          ;;
        *)
          printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"missing history"}}}}'
          ;;
      esac
      printf '%s\n' '{"jsonrpc":"2.0","id":6,"result":{"stopReason":"end_turn"}}' ;;
  esac
done
"#,
        );
        let mut request = fixture_request(
            program,
            temp.path().to_path_buf(),
            CancellationToken::default(),
            None,
        );
        request.provider_label = "xAI".into();
        request.conversation_history_text =
            Some("User: fix the split close\n\nAssistant: looking into it".into());
        let output = run_kimi_acp(
            request,
            |_| {},
            |_| {},
            |_| Ok(KimiAcpApprovalDecision::RejectOnce),
            |_, _| Ok(()),
        )
        .unwrap();
        assert_eq!(output.session_id, "handoff-session");
        assert!(!output.resumed);
        assert_eq!(output.response, "handoff-aware reply");
    }

    /// Grok-shaped agents often reject session/resume with Method not found.
    /// The turn must still complete via session/new with injected history.
    #[cfg(unix)]
    #[test]
    fn reopen_falls_back_to_new_when_resume_is_unsupported() {
        let (temp, program) = acp_fixture(
            r#"
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"authMethods":[{"id":"login"}],"agentCapabilities":{}}}' ;;
    *'"method":"authenticate"'*) printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{}}' ;;
    *'"method":"session/resume"'*) printf '%s\n' '{"jsonrpc":"2.0","id":3,"error":{"code":-32601,"message":"Method not found"}}' ;;
    *'"method":"session/load"'*) printf '%s\n' '{"jsonrpc":"2.0","id":4,"error":{"code":-32601,"message":"Method not found"}}' ;;
    *'"method":"session/new"'*) printf '%s\n' '{"jsonrpc":"2.0","id":5,"result":{"sessionId":"fresh-after-failed-reopen"}}' ;;
    *'"method":"session/set_model"'*) printf '%s\n' '{"jsonrpc":"2.0","id":6,"result":{}}' ;;
    *'"method":"session/set_config_option"'*) printf '%s\n' '{"jsonrpc":"2.0","id":7,"result":{}}' ;;
    *'"method":"session/prompt"'*)
      case "$line" in
        *short\ resumed\ context*) exit 9 ;;
        *Prior\ conversation*)
          printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"history-aware reply"}}}}'
          ;;
        *)
          printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"missing history"}}}}'
          ;;
      esac
      printf '%s\n' '{"jsonrpc":"2.0","id":8,"result":{"stopReason":"end_turn"}}' ;;
  esac
done
"#,
        );
        let mut request = fixture_request(
            program,
            temp.path().to_path_buf(),
            CancellationToken::default(),
            Some("stale-session".into()),
        );
        request.provider_label = "xAI".into();
        request.conversation_history_text = Some("User: hello\n\nAssistant: hi there".into());
        request.resumed_prompt = Some("short resumed context".into());
        let output = run_kimi_acp(
            request,
            |_| {},
            |_| {},
            |_| Ok(KimiAcpApprovalDecision::RejectOnce),
            |_, _| Ok(()),
        )
        .unwrap();
        assert_eq!(output.session_id, "fresh-after-failed-reopen");
        assert!(!output.resumed);
        assert_eq!(output.response, "history-aware reply");
    }

    /// Unlabeled ACP tool calls must inherit the running provider's name, so a
    /// Grok turn never surfaces the leftover "Kimi tool" fallback this adapter
    /// used when it only served Moonshot.
    #[cfg(unix)]
    #[test]
    fn unlabeled_tool_activity_uses_the_provider_label() {
        let (temp, program) = acp_fixture(
            r#"
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"authMethods":[{"id":"login"}]}}' ;;
    *'"method":"authenticate"'*) printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{}}' ;;
    *'"method":"session/new"'*) printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"sessionId":"xai-session"}}' ;;
    *'"method":"session/set_model"'*) printf '%s\n' '{"jsonrpc":"2.0","id":4,"result":{}}' ;;
    *'"method":"session/set_config_option"'*) printf '%s\n' '{"jsonrpc":"2.0","id":5,"result":{}}' ;;
    *'"method":"session/prompt"'*)
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"call-1","kind":"other","status":"in_progress"}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"done"}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","id":6,"result":{"stopReason":"end_turn"}}' ;;
  esac
done
"#,
        );
        let mut activities = Vec::new();
        let mut request = fixture_request(
            program,
            temp.path().to_path_buf(),
            CancellationToken::default(),
            None,
        );
        request.provider_label = "xAI".into();
        request.model = "grok-4.5".into();
        run_kimi_acp(
            request,
            |_| {},
            |activity| activities.push(activity.clone()),
            |_| Ok(KimiAcpApprovalDecision::RejectOnce),
            |_, _| Ok(()),
        )
        .unwrap();
        // A turn also publishes a live context-usage row, so the tool call is no longer
        // `activities[0]`; find it by the id it was called with.
        let tool = activities
            .iter()
            .find(|activity| activity.id == "call-1")
            .expect("the tool call is published");
        assert_eq!(tool.label, "xAI tool");
        assert!(!activities
            .iter()
            .any(|activity| activity.label.contains("Kimi")));
    }

    /// Kind + rawInput should beat the bare "{provider} tool" fallback so the
    /// rail can show "Read README.md" instead of four identical "xAI tool" rows.
    #[cfg(unix)]
    #[test]
    fn tool_activity_uses_kind_and_path_when_title_is_missing() {
        let (temp, program) = acp_fixture(
            r#"
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"authMethods":[{"id":"login"}]}}' ;;
    *'"method":"authenticate"'*) printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{}}' ;;
    *'"method":"session/new"'*) printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"sessionId":"xai-session"}}' ;;
    *'"method":"session/set_model"'*) printf '%s\n' '{"jsonrpc":"2.0","id":4,"result":{}}' ;;
    *'"method":"session/set_config_option"'*) printf '%s\n' '{"jsonrpc":"2.0","id":5,"result":{}}' ;;
    *'"method":"session/prompt"'*)
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"call-read","kind":"read","status":"completed","rawInput":{"path":"README.md"}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"done"}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","id":6,"result":{"stopReason":"end_turn"}}' ;;
  esac
done
"#,
        );
        let mut activities = Vec::new();
        let mut request = fixture_request(
            program,
            temp.path().to_path_buf(),
            CancellationToken::default(),
            None,
        );
        request.provider_label = "xAI".into();
        run_kimi_acp(
            request,
            |_| {},
            |activity| activities.push(activity.clone()),
            |_| Ok(KimiAcpApprovalDecision::RejectOnce),
            |_, _| Ok(()),
        )
        .unwrap();
        // The live context-usage row published while traffic is estimated is not the tool call;
        // assert on the activity that actually carries the tool kind.
        let tool = activities
            .iter()
            .find(|activity| activity.kind != "context-usage")
            .expect("the tool call is published");
        assert_eq!(tool.kind, "read");
        assert_eq!(tool.label, "Read README.md");
        assert_eq!(tool.detail.as_deref(), Some("README.md"));
    }

    #[test]
    fn create_activity_is_file_work() {
        let (kind, label, detail) = super::acp_tool_activity_parts(
            "Kimi",
            "create",
            None,
            Some("src/new.ts".into()),
            None,
            None,
        );
        assert_eq!(kind, "file");
        assert_eq!(label, "Create src/new.ts");
        assert_eq!(detail.as_deref(), Some("src/new.ts"));
    }

    #[cfg(unix)]
    #[test]
    fn unset_effort_uses_agent_default_without_config_call() {
        let (temp, program) = acp_fixture(
            r#"
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"authMethods":[{"id":"login"}]}}' ;;
    *'"method":"authenticate"'*) printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{}}' ;;
    *'"method":"session/new"'*) printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"sessionId":"default-effort"}}' ;;
    *'"method":"session/set_model"'*) printf '%s\n' '{"jsonrpc":"2.0","id":4,"result":{}}' ;;
    *'"method":"session/set_config_option"'*) exit 9 ;;
    *'"method":"session/prompt"'*)
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"ready"}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","id":5,"result":{"stopReason":"end_turn"}}' ;;
  esac
done
"#,
        );
        let mut request = fixture_request(
            program,
            temp.path().to_path_buf(),
            CancellationToken::default(),
            None,
        );
        request.reasoning_effort = None;
        let output = run_kimi_acp(
            request,
            |_| {},
            |_| {},
            |_| Ok(KimiAcpApprovalDecision::RejectOnce),
            |_, _| Ok(()),
        )
        .unwrap();
        assert_eq!(output.response, "ready");
    }

    #[cfg(unix)]
    #[test]
    fn resumed_history_replay_is_not_rendered_or_saved_as_the_new_response() {
        let (temp, program) = acp_fixture(
            r#"
    while IFS= read -r line; do
      case "$line" in
        *'"method":"initialize"'*) printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"agentCapabilities":{"loadSession":true}}}' ;;
        *'"method":"authenticate"'*) printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{}}' ;;
        *'"method":"session/load"'*)
          printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Old reply replayed from history."}}}}'
          printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"old-call","title":"Old read","kind":"read","status":"completed"}}}'
          printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{}}' ;;
        *'"method":"session/set_model"'*) printf '%s\n' '{"jsonrpc":"2.0","id":4,"result":{}}' ;;
        *'"method":"session/set_config_option"'*) printf '%s\n' '{"jsonrpc":"2.0","id":5,"result":{}}' ;;
        *'"method":"session/prompt"'*)
          case "$line" in *'Prior conversation'*|*'full opening context'*) exit 9 ;; esac
          case "$line" in *'short resumed context'*'explicit attachment'*) ;; *) exit 9 ;; esac
          printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"new-call","title":"New read","kind":"read","status":"completed"}}}'
          printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"New reply."}}}}'
          printf '%s\n' '{"jsonrpc":"2.0","id":6,"result":{"stopReason":"end_turn"}}' ;;
      esac
    done
    "#,
        );
        let mut request = fixture_request(
            program,
            temp.path().to_path_buf(),
            CancellationToken::default(),
            Some("saved-session".into()),
        );
        request.prompt[0]["text"] = "full opening context".into();
        request.prompt.push(json!({"type": "resource", "resource": {"uri": "file:///fixture", "text": "explicit attachment"}}));
        request.resumed_prompt = Some("short resumed context".into());
        request.conversation_history_text =
            Some("This local history must not be sent on resume".into());
        let mut deltas = String::new();
        let mut activities = Vec::new();
        let output = run_kimi_acp(
            request,
            |delta| deltas.push_str(delta),
            |activity| activities.push(activity.clone()),
            |_| Ok(KimiAcpApprovalDecision::RejectOnce),
            |_, _| Ok(()),
        )
        .unwrap();
        assert!(output.resumed);
        assert_eq!(output.response, "New reply.");
        assert_eq!(deltas, "New reply.");
        assert_eq!(activities.len(), 1);
        assert_eq!(activities[0].label, "New read");
    }

    #[cfg(unix)]
    #[test]
    fn resumes_session_and_returns_only_one_shot_permission() {
        let (temp, program) = acp_fixture(
            r#"
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{}}' ;;
    *'"method":"authenticate"'*) printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{}}' ;;
    *'"method":"session/resume"'*) printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{}}' ;;
    *'"method":"session/set_model"'*) printf '%s\n' '{"jsonrpc":"2.0","id":4,"result":{}}' ;;
    *'"method":"session/set_config_option"'*) printf '%s\n' '{"jsonrpc":"2.0","id":5,"result":{}}' ;;
    *'"method":"session/prompt"'*)
      case "$line" in *short\ resumed\ context*) ;; *) exit 9 ;; esac
      printf '%s\n' '{"jsonrpc":"2.0","id":99,"method":"session/request_permission","params":{"toolCall":{"title":"Run command","kind":"execute"},"options":[{"optionId":"always","kind":"allow_always"},{"optionId":"once","kind":"allow_once"},{"optionId":"reject","kind":"reject_once"}]}}' ;;
    *'"id":99'*)
      case "$line" in *'"optionId":"once"'*) ;; *) exit 9 ;; esac
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"text":"resumed"}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","id":6,"result":{"stopReason":"end_turn"}}' ;;
  esac
done
"#,
        );
        let mut approvals = 0;
        let mut request = fixture_request(
            program,
            temp.path().to_path_buf(),
            CancellationToken::default(),
            Some("saved-session".into()),
        );
        request.resumed_prompt = Some("short resumed context".into());
        let output = run_kimi_acp(
            request,
            |_| {},
            |_| {},
            |_| {
                approvals += 1;
                Ok(KimiAcpApprovalDecision::AllowOnce)
            },
            |_, _| Ok(()),
        )
        .unwrap();
        assert!(output.resumed);
        assert_eq!(output.session_id, "saved-session");
        assert_eq!(approvals, 1);
    }

    #[cfg(unix)]
    #[test]
    fn malformed_frame_fails_closed_and_missing_binary_is_not_installed() {
        let (temp, program) = acp_fixture("read line\nprintf '%s\\n' '{bad json'");
        let error = run_kimi_acp(
            fixture_request(
                program,
                temp.path().to_path_buf(),
                CancellationToken::default(),
                None,
            ),
            |_| {},
            |_| {},
            |_| Ok(KimiAcpApprovalDecision::RejectOnce),
            |_, _| Ok(()),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("invalid Kimi ACP JSON"), "{error}");

        let (temp, program) = acp_fixture(
            "read line\nprintf '{\\\"payload\\\":\\\"'\ndd if=/dev/zero bs=1048577 count=1 2>/dev/null | tr '\\000' x\nprintf '\\\"}\\n'",
        );
        let oversized = run_kimi_acp(
            fixture_request(
                program,
                temp.path().to_path_buf(),
                CancellationToken::default(),
                None,
            ),
            |_| {},
            |_| {},
            |_| Ok(KimiAcpApprovalDecision::RejectOnce),
            |_, _| Ok(()),
        )
        .unwrap_err()
        .to_string();
        assert!(oversized.contains("size limit"));

        let health = check_kimi_acp_health(
            OsString::from("/definitely/missing/gyro-kimi"),
            Duration::from_millis(100),
        );
        assert_eq!(health.status, KimiAcpHealthStatus::NotInstalled);
    }

    #[test]
    fn acp_gui_path_includes_provider_cli_install_locations() {
        let path = crate::cli_path::augmented_gui_path();
        assert!(
            path.contains(".local/bin") || path.contains("/.local/bin"),
            "expected ~/.local/bin on ACP PATH, got {path}"
        );
        assert!(
            path.contains(".grok/bin"),
            "expected ~/.grok/bin on ACP PATH so Dock-launched health finds Grok, got {path}"
        );
        assert!(
            path.contains(".kimi-code/bin"),
            "expected ~/.kimi-code/bin on ACP PATH, got {path}"
        );
        assert!(
            path.contains(".npm-global/bin") || path.contains(".cursor/bin"),
            "expected npm/cursor install locations on ACP PATH, got {path}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_interrupts_an_unresponsive_acp_turn() {
        let (temp, program) = acp_fixture(
            r#"
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{}}' ;;
    *'"method":"authenticate"'*) printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{}}' ;;
    *'"method":"session/new"'*) printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"sessionId":"cancel-session"}}' ;;
    *'"method":"session/set_model"'*) printf '%s\n' '{"jsonrpc":"2.0","id":4,"result":{}}' ;;
    *'"method":"session/set_config_option"'*) printf '%s\n' '{"jsonrpc":"2.0","id":5,"result":{}}' ;;
    *'"method":"session/prompt"'*) sleep 10 ;;
  esac
done
"#,
        );
        let cancellation = CancellationToken::default();
        let cancel_from_thread = cancellation.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            cancel_from_thread.cancel();
        });
        let error = run_kimi_acp(
            fixture_request(program, temp.path().to_path_buf(), cancellation, None),
            |_| {},
            |_| {},
            |_| Ok(KimiAcpApprovalDecision::RejectOnce),
            |_, _| Ok(()),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("cancelled"));
    }
}
