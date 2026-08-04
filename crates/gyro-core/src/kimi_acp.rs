use crate::execution::{configure_process_group, terminate_process_group};
use crate::security::redact_secrets;
use crate::CancellationToken;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

const ACP_PROTOCOL_VERSION: u64 = 1;
const ACP_MAX_FRAME_BYTES: usize = 1024 * 1024;
const ACP_MAX_MESSAGES: usize = 50_000;
const ACP_MAX_TOTAL_BYTES: usize = 128 * 1024 * 1024;
const ACP_MAX_STDERR_CHARS: usize = 64 * 1024;
const ACP_MAX_FILE_BYTES: usize = 2 * 1024 * 1024;
const ACP_POLL_INTERVAL: Duration = Duration::from_millis(25);

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
    pub status: String,
}

#[derive(Clone, Debug)]
pub struct KimiAcpRequest {
    pub provider_label: String,
    pub program: OsString,
    pub program_args: Vec<OsString>,
    pub auth_method_ids: Vec<String>,
    pub workspace: PathBuf,
    pub prompt: Vec<Value>,
    /// Prior Gyro-chat turns, used only when the agent cannot reopen its ACP
    /// session (Grok often lacks `session/resume`). Injected into a fresh
    /// `session/new` so multi-turn still has context.
    pub conversation_history_text: Option<String>,
    /// Stdio MCP servers to expose to the agent, in ACP `session/new` form.
    /// Empty leaves the agent with only its own built-in tools.
    pub mcp_servers: Vec<Value>,
    pub model: String,
    pub reasoning_effort: String,
    pub mode: KimiAcpMode,
    pub resume_session_id: Option<String>,
    pub timeout: Duration,
    pub inactivity_timeout: Duration,
    pub cancellation: CancellationToken,
}

#[derive(Clone, Debug)]
pub struct KimiAcpOutput {
    pub response: String,
    pub session_id: String,
    pub stop_reason: String,
    pub resumed: bool,
    pub duration_ms: u64,
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
    child: Child,
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
        configure_process_group(&mut command);
        let mut child = command.spawn().map_err(|error| {
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
                match reader.read_until(b'\n', &mut bytes) {
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
        })
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
        if bytes.len() > ACP_MAX_FRAME_BYTES {
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
                    if let Some(status) = self.child.try_wait()? {
                        anyhow::bail!(
                            "{} ACP exited with {status}: {}",
                            self.provider_label,
                            redact_secrets(self.stderr_text.trim())
                        );
                    }
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
    let started_at = Instant::now();
    let mut connection = KimiAcpConnection::start(&request)?;
    let mut response = String::new();
    let initialize_id = connection.send_request(
        "initialize",
        json!({
            "protocolVersion": ACP_PROTOCOL_VERSION,
            "clientInfo": {"name": "Gyro", "version": env!("CARGO_PKG_VERSION")},
            "clientCapabilities": {
                "fs": {"readTextFile": true, "writeTextFile": true},
                "terminal": false,
            },
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
    let (session_id, resumed, reopened_as_fresh) = open_acp_session(
        &mut connection,
        &request,
        &initialize,
        &mut response,
        &mut on_delta,
        &mut on_activity,
        &mut on_approval,
        &mut on_write_file,
    )?;

    // Grok takes model/effort as process flags (Synara style). In-session
    // session/set_model and session/set_config_option often return Method not
    // found and must not fail the turn.
    let skip_in_session_config = is_grok_acp_program(&request.program);
    if !skip_in_session_config
        && !request.model.trim().is_empty()
        && !request.model.ends_with("-default")
    {
        let model_id = connection.send_request(
            "session/set_model",
            json!({"sessionId": session_id, "modelId": request.model}),
        )?;
        let _ = wait_for_response(
            &mut connection,
            model_id,
            &request.workspace,
            &mut response,
            &mut on_delta,
            &mut on_activity,
            &mut on_approval,
            &mut on_write_file,
        );
    }
    if !skip_in_session_config {
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

    let mut prompt = request.prompt.clone();
    if reopened_as_fresh {
        if let Some(history) = request
            .conversation_history_text
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty())
        {
            prompt.insert(
                0,
                json!({
                    "type": "text",
                    "text": format!(
                        "Prior conversation in this Gyro chat (the agent session could not be reopened, so this is continuity context):\n{history}"
                    ),
                }),
            );
        }
    }

    let prompt_id = connection.send_request(
        "session/prompt",
        json!({"sessionId": session_id, "prompt": prompt}),
    )?;
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
    let result = result?;
    Ok(KimiAcpOutput {
        response: response.trim().to_string(),
        session_id,
        stop_reason: result
            .get("stopReason")
            .and_then(Value::as_str)
            .unwrap_or("end_turn")
            .to_string(),
        resumed,
        duration_ms: started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
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
) -> Result<(String, bool, bool)>
where
    Delta: FnMut(&str),
    Activity: FnMut(&KimiAcpActivity),
    Approval: FnMut(&KimiAcpApprovalRequest) -> Result<KimiAcpApprovalDecision>,
    WriteFile: FnMut(&Path, &str) -> Result<()>,
{
    let Some(resume_session_id) = request.resume_session_id.as_deref() else {
        let session_id = create_acp_session(
            connection,
            request,
            response,
            on_delta,
            on_activity,
            on_approval,
            on_write_file,
        )?;
        return Ok((session_id, false, false));
    };

    let (supports_resume, supports_load) = acp_session_reopen_methods(initialize);
    let reopen_payload = json!({
        "sessionId": resume_session_id,
        "cwd": request.workspace,
        "mcpServers": request.mcp_servers,
    });

    // Order: resume when advertised (Kimi-shaped), else load when advertised
    // (Grok/Synara-shaped). When neither capability is advertised, try both
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
            Ok(_) => {
                return Ok((resume_session_id.to_string(), true, false));
            }
            Err(error) => {
                let detail = error.to_string();
                let recoverable = is_acp_method_not_found(&detail) || {
                    let lower = detail.to_ascii_lowercase();
                    lower.contains("not found")
                        || lower.contains("expired")
                        || lower.contains("unknown")
                        || lower.contains("unsupported")
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
    let session_id = create_acp_session(
        connection,
        request,
        response,
        on_delta,
        on_activity,
        on_approval,
        on_write_file,
    )?;
    Ok((session_id, false, true))
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
) -> Result<String>
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
    result
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| anyhow!("{} ACP did not return a session id", request.provider_label))
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
        if message.get("id").and_then(Value::as_u64) == Some(expected_id) {
            if let Some(error) = message.get("error") {
                let detail = error
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("{} ACP request failed", connection.provider_label));
                anyhow::bail!(redact_secrets(&detail));
            }
            return Ok(message.get("result").cloned().unwrap_or(Value::Null));
        }
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            continue;
        };
        let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
        match method {
            "session/update" => {
                handle_session_update(
                    &params,
                    &connection.provider_label,
                    response,
                    on_delta,
                    on_activity,
                );
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
                } else {
                    on_approval(&request)?
                };
                let option_id = permission_option_id(&params, decision);
                let outcome = if decision == KimiAcpApprovalDecision::Cancelled {
                    json!({"outcome": "cancelled"})
                } else if let Some(option_id) = option_id {
                    json!({"outcome": "selected", "optionId": option_id})
                } else {
                    connection.send_error(
                        id,
                        -32602,
                        &format!(
                            "{} ACP did not offer a safe permission option",
                            connection.provider_label
                        ),
                    )?;
                    continue;
                };
                connection.send_result(id, json!({"outcome": outcome}))?;
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
                status,
            });
        }
        Some("plan") => {
            on_activity(&KimiAcpActivity {
                id: format!("{}-plan", acp_activity_id_slug(provider_label)),
                kind: "plan".into(),
                label: "Updated plan".into(),
                detail: update.get("entries").map(Value::to_string),
                status: "done".into(),
            });
        }
        _ => {}
    }
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
        "read" | "edit" | "delete" | "move" => {
            let verb = match acp_kind {
                "read" => "Read",
                "edit" => "Edit",
                "delete" => "Delete",
                _ => "Move",
            };
            let label = titled(match path.as_deref() {
                Some(path) => format!("{verb} {path}"),
                None => format!("{verb} file"),
            });
            ("file".into(), label, path)
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
    kind.split(|ch: char| ch == '_' || ch == '-')
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

fn permission_option_id(params: &Value, decision: KimiAcpApprovalDecision) -> Option<&str> {
    let wanted = match decision {
        KimiAcpApprovalDecision::AllowOnce => "allow_once",
        KimiAcpApprovalDecision::RejectOnce => "reject_once",
        KimiAcpApprovalDecision::Cancelled => return None,
    };
    params
        .get("options")?
        .as_array()?
        .iter()
        .find(|option| option.get("kind").and_then(Value::as_str) == Some(wanted))?
        .get("optionId")?
        .as_str()
}

fn read_workspace_text_file(workspace: &Path, params: &Value) -> Result<String> {
    let requested = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("ACP file read did not include a path"))?;
    let path = resolve_existing_workspace_path(workspace, requested)?;
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
        conversation_history_text: None,
        // A health probe only checks that the agent starts and authenticates.
        mcp_servers: Vec::new(),
        model: "k3".into(),
        reasoning_effort: "max".into(),
        mode: KimiAcpMode::Normal,
        resume_session_id: None,
        timeout,
        inactivity_timeout: timeout,
        cancellation: CancellationToken::default(),
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
        acp_activity_id_slug, acp_session_reopen_methods, check_kimi_acp_health, classify_approval,
        is_acp_method_not_found, permission_option_id, resolve_workspace_write_path, run_kimi_acp,
        KimiAcpApprovalDecision, KimiAcpApprovalKind, KimiAcpHealthStatus, KimiAcpMode,
        KimiAcpRequest,
    };
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
            conversation_history_text: None,
            mcp_servers: Vec::new(),
            model: "k3".into(),
            reasoning_effort: "max".into(),
            mode: KimiAcpMode::Normal,
            resume_session_id,
            timeout: Duration::from_secs(3),
            inactivity_timeout: Duration::from_secs(3),
            cancellation,
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
        assert_eq!(activities[0].label, "xAI tool");
        assert_eq!(activities[0].id, "call-1");
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
        assert_eq!(activities[0].kind, "file");
        assert_eq!(activities[0].label, "Read README.md");
        assert_eq!(activities[0].detail.as_deref(), Some("README.md"));
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
    *'"method":"session/prompt"'*) printf '%s\n' '{"jsonrpc":"2.0","id":99,"method":"session/request_permission","params":{"toolCall":{"title":"Run command","kind":"execute"},"options":[{"optionId":"always","kind":"allow_always"},{"optionId":"once","kind":"allow_once"},{"optionId":"reject","kind":"reject_once"}]}}' ;;
    *'"id":99'*)
      case "$line" in *'"optionId":"once"'*) ;; *) exit 9 ;; esac
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"text":"resumed"}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","id":6,"result":{"stopReason":"end_turn"}}' ;;
  esac
done
"#,
        );
        let mut approvals = 0;
        let output = run_kimi_acp(
            fixture_request(
                program,
                temp.path().to_path_buf(),
                CancellationToken::default(),
                Some("saved-session".into()),
            ),
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
        assert!(error.contains("invalid Kimi ACP JSON"));

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
