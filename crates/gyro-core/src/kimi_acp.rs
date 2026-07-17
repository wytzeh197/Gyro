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
const GUI_CLI_PATHS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
];

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
    pub program: OsString,
    pub program_args: Vec<OsString>,
    pub workspace: PathBuf,
    pub prompt: Vec<Value>,
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
            command.env("PATH", augmented_gui_path());
        }
        configure_process_group(&mut command);
        let mut child = command
            .spawn()
            .map_err(|error| anyhow!("start {} acp: {error}", request.program.to_string_lossy()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("Kimi ACP stdin was unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("Kimi ACP stdout was unavailable"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow!("Kimi ACP stderr was unavailable"))?;

        let (incoming_sender, incoming) = mpsc::sync_channel(128);
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut bytes = Vec::new();
                match reader.read_until(b'\n', &mut bytes) {
                    Ok(0) => break,
                    Ok(_) if bytes.len() > ACP_MAX_FRAME_BYTES => {
                        let _ = incoming_sender
                            .send(Err("Kimi ACP frame exceeded its size limit".into()));
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
                            .map_err(|error| format!("invalid Kimi ACP JSON: {error}"));
                        if incoming_sender.send(value).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = incoming_sender.send(Err(format!("read Kimi ACP output: {error}")));
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
            anyhow::bail!("Kimi ACP request exceeded its size limit");
        }
        self.stdin.write_all(&bytes)?;
        self.stdin.write_all(b"\n")?;
        self.stdin.flush()?;
        Ok(())
    }

    fn receive(&mut self) -> Result<Value> {
        loop {
            if self.cancellation.is_cancelled() {
                anyhow::bail!("Kimi ACP run cancelled");
            }
            if self.started_at.elapsed() >= self.timeout {
                anyhow::bail!("Kimi ACP run timed out");
            }
            if self.last_activity_at.elapsed() >= self.inactivity_timeout {
                anyhow::bail!("Kimi ACP run became inactive");
            }
            match self.incoming.recv_timeout(ACP_POLL_INTERVAL) {
                Ok(Ok(frame)) => {
                    self.messages += 1;
                    self.total_bytes = self.total_bytes.saturating_add(frame.bytes);
                    if self.messages > ACP_MAX_MESSAGES || self.total_bytes > ACP_MAX_TOTAL_BYTES {
                        anyhow::bail!("Kimi ACP output exceeded its bounded protocol budget");
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
                            "Kimi ACP exited with {status}: {}",
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
                        "Kimi ACP closed its protocol stream: {}",
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
    let resumed = request.resume_session_id.is_some();
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
    wait_for_response(
        &mut connection,
        initialize_id,
        &request.workspace,
        &mut response,
        &mut on_delta,
        &mut on_activity,
        &mut on_approval,
        &mut on_write_file,
    )?;
    let authenticate_id = connection.send_request("authenticate", json!({"methodId": "login"}))?;
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

    let session_id = if let Some(session_id) = request.resume_session_id.as_deref() {
        let resume_id = connection.send_request(
            "session/resume",
            json!({"sessionId": session_id, "cwd": request.workspace, "mcpServers": []}),
        )?;
        wait_for_response(
            &mut connection,
            resume_id,
            &request.workspace,
            &mut response,
            &mut on_delta,
            &mut on_activity,
            &mut on_approval,
            &mut on_write_file,
        )?;
        session_id.to_string()
    } else {
        let new_id = connection.send_request(
            "session/new",
            json!({"cwd": request.workspace, "mcpServers": []}),
        )?;
        let result = wait_for_response(
            &mut connection,
            new_id,
            &request.workspace,
            &mut response,
            &mut on_delta,
            &mut on_activity,
            &mut on_approval,
            &mut on_write_file,
        )?;
        result
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| anyhow!("Kimi ACP did not return a session id"))?
            .to_string()
    };

    let model_id = connection.send_request(
        "session/set_model",
        json!({"sessionId": session_id, "modelId": request.model}),
    )?;
    wait_for_response(
        &mut connection,
        model_id,
        &request.workspace,
        &mut response,
        &mut on_delta,
        &mut on_activity,
        &mut on_approval,
        &mut on_write_file,
    )?;
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
    if request.mode == KimiAcpMode::Plan {
        let mode_id = connection.send_request(
            "session/set_mode",
            json!({"sessionId": session_id, "modeId": "plan"}),
        )?;
        wait_for_response(
            &mut connection,
            mode_id,
            &request.workspace,
            &mut response,
            &mut on_delta,
            &mut on_activity,
            &mut on_approval,
            &mut on_write_file,
        )?;
    }

    let prompt_id = connection.send_request(
        "session/prompt",
        json!({"sessionId": session_id, "prompt": request.prompt}),
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
                    .unwrap_or("Kimi ACP request failed");
                anyhow::bail!(redact_secrets(detail));
            }
            return Ok(message.get("result").cloned().unwrap_or(Value::Null));
        }
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            continue;
        };
        let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
        match method {
            "session/update" => {
                handle_session_update(&params, response, on_delta, on_activity);
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
                        "Kimi ACP did not offer a safe permission option",
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
            let id = update
                .get("toolCallId")
                .and_then(Value::as_str)
                .unwrap_or("kimi-tool")
                .to_string();
            let label = update
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Kimi tool")
                .to_string();
            let kind = update
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string();
            let status = match update.get("status").and_then(Value::as_str) {
                Some("completed") => "done",
                Some("failed") => "failed",
                _ => "running",
            }
            .to_string();
            let detail = update
                .get("rawInput")
                .map(|value| redact_secrets(&value.to_string()));
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
                id: "kimi-plan".into(),
                kind: "plan".into(),
                label: "Updated plan".into(),
                detail: update.get("entries").map(Value::to_string),
                status: "done".into(),
            });
        }
        _ => {}
    }
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
    let request = KimiAcpRequest {
        program: program.into(),
        program_args: vec![OsString::from("acp")],
        workspace: std::env::temp_dir(),
        prompt: Vec::new(),
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
        wait_for_simple_response(&mut connection, initialize_id)?;
        let authenticate_id =
            connection.send_request("authenticate", json!({"methodId": "login"}))?;
        wait_for_simple_response(&mut connection, authenticate_id)?;
        Ok(())
    })();
    match result {
        Ok(()) => KimiAcpHealth {
            status: KimiAcpHealthStatus::Ready,
            output: "Kimi Code ACP authenticated; provider-owned token value was not read by Gyro."
                .into(),
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

fn augmented_gui_path() -> OsString {
    let mut paths = GUI_CLI_PATHS.iter().map(PathBuf::from).collect::<Vec<_>>();
    if let Some(current) = std::env::var_os("PATH") {
        for path in std::env::split_paths(&current) {
            if !paths.iter().any(|candidate| candidate == &path) {
                paths.push(path);
            }
        }
    }
    std::env::join_paths(paths).unwrap_or_else(|_| OsString::from(GUI_CLI_PATHS.join(":")))
}

fn append_bounded(target: &mut String, text: &str, max_chars: usize) {
    let remaining = max_chars.saturating_sub(target.chars().count());
    target.extend(text.chars().take(remaining));
}

#[cfg(test)]
mod tests {
    use super::{
        check_kimi_acp_health, classify_approval, permission_option_id,
        resolve_workspace_write_path, run_kimi_acp, KimiAcpApprovalDecision, KimiAcpApprovalKind,
        KimiAcpHealthStatus, KimiAcpMode, KimiAcpRequest,
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
            program: program.into_os_string(),
            program_args: Vec::new(),
            workspace,
            prompt: vec![json!({"type": "text", "text": "hello"})],
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
