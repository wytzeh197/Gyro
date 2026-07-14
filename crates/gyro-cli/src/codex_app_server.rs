use anyhow::{anyhow, Context, Result};
use gyro_core::CancellationToken;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const POLL_INTERVAL: Duration = Duration::from_millis(50);
const MAX_STDERR_BYTES: u64 = 64 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ApprovalKind {
    Command,
    FileChange,
    Permissions,
}

impl ApprovalKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::FileChange => "file-change",
            Self::Permissions => "permissions",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ApprovalDecision {
    Accept,
    Decline,
    AppliedByClient,
}

#[derive(Clone, Debug)]
pub(crate) struct ApprovalRequest {
    pub kind: ApprovalKind,
    pub details: Value,
}

#[derive(Clone, Debug)]
pub(crate) struct CodexAppServerRequest {
    pub program: String,
    pub program_args: Vec<String>,
    pub workspace: PathBuf,
    pub prompt: String,
    pub model: Option<String>,
    pub resume_session_id: Option<String>,
    pub require_command_approval: bool,
    pub require_file_edit_approval: bool,
    pub timeout: Duration,
    pub cancellation: CancellationToken,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CodexAppServerOutput {
    pub response: String,
    pub provider_session_id: String,
    pub duration_ms: u64,
    pub resumed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum CodexAppServerOutcome {
    Done(CodexAppServerOutput),
    ApprovalRejected { duration_ms: u64 },
    Cancelled { duration_ms: u64 },
    TimedOut { duration_ms: u64 },
    Failed { message: String, duration_ms: u64 },
}

pub(crate) fn run_codex_app_server<F, G, H>(
    request: CodexAppServerRequest,
    mut on_delta: F,
    mut on_approval: G,
    mut on_session: H,
) -> Result<CodexAppServerOutcome>
where
    F: FnMut(&str),
    G: FnMut(&ApprovalRequest) -> Result<ApprovalDecision>,
    H: FnMut(&str) -> Result<()>,
{
    if request.cancellation.is_cancelled() {
        return Ok(CodexAppServerOutcome::Cancelled { duration_ms: 0 });
    }

    let started_at = Instant::now();
    let deadline = started_at + request.timeout;
    let mut command = Command::new(&request.program);
    command
        .args(&request.program_args)
        .args(["app-server", "--stdio"])
        .current_dir(&request.workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(&mut command);
    let child = command
        .spawn()
        .with_context(|| format!("start {} app-server", request.program))?;
    let mut child = ChildGuard::new(child);
    let mut stdin = child
        .child_mut()
        .stdin
        .take()
        .context("Codex app-server input was unavailable")?;
    let stdout = child
        .child_mut()
        .stdout
        .take()
        .context("Codex app-server output was unavailable")?;
    let stderr = child
        .child_mut()
        .stderr
        .take()
        .context("Codex app-server error output was unavailable")?;
    let messages = spawn_message_reader(stdout);
    let stderr_output = Arc::new(Mutex::new(String::new()));
    spawn_stderr_reader(stderr, Arc::clone(&stderr_output));

    write_message(
        &mut stdin,
        &json!({
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": {
                    "name": "gyro-cli",
                    "title": "Gyro CLI",
                    "version": env!("CARGO_PKG_VERSION"),
                },
                "capabilities": { "experimentalApi": true },
            },
        }),
    )?;
    let initialize = receive_response(&messages, 1, deadline, &request.cancellation, started_at)?;
    if let Some(outcome) = terminal_outcome(&initialize, started_at, &stderr_output) {
        return Ok(outcome);
    }
    protocol_result(&initialize)?;
    write_message(&mut stdin, &json!({ "method": "initialized" }))?;

    let workspace = request.workspace.display().to_string();
    let approval_policy = if request.require_command_approval {
        "untrusted"
    } else {
        "on-request"
    };
    let (sandbox, sandbox_policy) = if request.require_file_edit_approval {
        (
            "read-only",
            json!({ "type": "readOnly", "networkAccess": false }),
        )
    } else {
        (
            "workspace-write",
            json!({
                "type": "workspaceWrite",
                "writableRoots": [workspace],
                "networkAccess": false,
                "excludeTmpdirEnvVar": false,
                "excludeSlashTmp": false,
            }),
        )
    };
    let thread_request = if let Some(thread_id) = request.resume_session_id.as_deref() {
        json!({
            "id": 2,
            "method": "thread/resume",
            "params": {
                "threadId": thread_id,
                "cwd": workspace,
                "model": request.model,
                "approvalPolicy": approval_policy,
                "approvalsReviewer": "user",
                "sandbox": sandbox,
            },
        })
    } else {
        json!({
            "id": 2,
            "method": "thread/start",
            "params": {
                "cwd": workspace,
                "model": request.model,
                "approvalPolicy": approval_policy,
                "approvalsReviewer": "user",
                "sandbox": sandbox,
                "ephemeral": false,
            },
        })
    };
    write_message(&mut stdin, &thread_request)?;
    let thread_response =
        receive_response(&messages, 2, deadline, &request.cancellation, started_at)?;
    if let Some(outcome) = terminal_outcome(&thread_response, started_at, &stderr_output) {
        return Ok(outcome);
    }
    let thread_result = protocol_result(&thread_response)?;
    let thread_id = thread_result
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("Codex app-server did not return a thread id"))?
        .to_string();
    on_session(&thread_id)?;

    write_message(
        &mut stdin,
        &json!({
            "id": 3,
            "method": "turn/start",
            "params": {
                "threadId": thread_id,
                "input": [{ "type": "text", "text": request.prompt }],
                "cwd": workspace,
                "model": request.model,
                "approvalPolicy": approval_policy,
                "approvalsReviewer": "user",
                "sandboxPolicy": sandbox_policy,
            },
        }),
    )?;

    let mut response = String::new();
    let mut completed_response = String::new();
    let mut file_changes = HashMap::<String, Value>::new();
    let mut turn_started = false;
    loop {
        if request.cancellation.is_cancelled() {
            return Ok(CodexAppServerOutcome::Cancelled {
                duration_ms: elapsed_ms(started_at),
            });
        }
        if Instant::now() >= deadline {
            return Ok(CodexAppServerOutcome::TimedOut {
                duration_ms: elapsed_ms(started_at),
            });
        }
        let message = match messages.recv_timeout(POLL_INTERVAL) {
            Ok(Ok(message)) => message,
            Ok(Err(error)) => {
                return Ok(failed_outcome(error, started_at, &stderr_output));
            }
            Err(RecvTimeoutError::Timeout) => {
                if let Some(status) = child.child_mut().try_wait()? {
                    return Ok(failed_outcome(
                        format!("Codex app-server exited with {status}"),
                        started_at,
                        &stderr_output,
                    ));
                }
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Ok(failed_outcome(
                    "Codex app-server disconnected".into(),
                    started_at,
                    &stderr_output,
                ));
            }
        };

        let method = message.get("method").and_then(Value::as_str);
        if let Some(method) = method.filter(|_| message.get("id").is_some()) {
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            let Some((approval, legacy)) = approval_request(method, params, &file_changes) else {
                write_message(
                    &mut stdin,
                    &json!({
                        "id": message["id"],
                        "error": { "code": -32601, "message": "unsupported Gyro CLI request" },
                    }),
                )?;
                continue;
            };
            let decision = on_approval(&approval)?;
            write_approval_response(
                &mut stdin,
                message["id"].clone(),
                approval.kind,
                decision,
                legacy,
                &approval.details,
            )?;
            if decision == ApprovalDecision::Decline {
                return Ok(CodexAppServerOutcome::ApprovalRejected {
                    duration_ms: elapsed_ms(started_at),
                });
            }
            continue;
        }

        if message.get("id").and_then(Value::as_u64) == Some(3) {
            if let Err(error) = protocol_result(&message) {
                return Ok(failed_outcome(
                    error.to_string(),
                    started_at,
                    &stderr_output,
                ));
            }
            turn_started = true;
            continue;
        }

        let Some(method) = method else {
            continue;
        };
        let params = message.get("params").cloned().unwrap_or(Value::Null);

        match method {
            "item/agentMessage/delta" => {
                if let Some(delta) = params.get("delta").and_then(Value::as_str) {
                    response.push_str(delta);
                    on_delta(delta);
                }
            }
            "item/fileChange/patchUpdated" => {
                if let Some(item_id) = params.get("itemId").and_then(Value::as_str) {
                    file_changes.insert(item_id.to_string(), params);
                }
            }
            "item/started" | "item/completed" => {
                if let Some(item) = params.get("item") {
                    match item.get("type").and_then(Value::as_str) {
                        Some("fileChange") => {
                            if let Some(item_id) = item.get("id").and_then(Value::as_str) {
                                file_changes.insert(item_id.to_string(), item.clone());
                            }
                        }
                        Some("agentMessage") if method == "item/completed" => {
                            if let Some(text) = item.get("text").and_then(Value::as_str) {
                                completed_response = text.to_string();
                            }
                        }
                        _ => {}
                    }
                }
            }
            "turn/completed" => {
                let status = params
                    .pointer("/turn/status")
                    .and_then(Value::as_str)
                    .unwrap_or("failed");
                if status != "completed" {
                    let detail = params
                        .pointer("/turn/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("Codex turn did not complete");
                    return Ok(failed_outcome(detail.into(), started_at, &stderr_output));
                }
                if !turn_started {
                    return Ok(failed_outcome(
                        "Codex app-server completed without starting the turn".into(),
                        started_at,
                        &stderr_output,
                    ));
                }
                let final_response = if completed_response.trim().is_empty() {
                    response.trim()
                } else {
                    completed_response.trim()
                };
                if final_response.is_empty() {
                    return Ok(failed_outcome(
                        "Codex finished without returning a response".into(),
                        started_at,
                        &stderr_output,
                    ));
                }
                return Ok(CodexAppServerOutcome::Done(CodexAppServerOutput {
                    response: final_response.to_string(),
                    provider_session_id: thread_id,
                    duration_ms: elapsed_ms(started_at),
                    resumed: request.resume_session_id.is_some(),
                }));
            }
            _ => {}
        }
    }
}

fn approval_request(
    method: &str,
    mut details: Value,
    file_changes: &HashMap<String, Value>,
) -> Option<(ApprovalRequest, bool)> {
    let (kind, legacy) = match method {
        "item/commandExecution/requestApproval" => (ApprovalKind::Command, false),
        "item/fileChange/requestApproval" => (ApprovalKind::FileChange, false),
        "item/permissions/requestApproval" => (ApprovalKind::Permissions, false),
        "execCommandApproval" => (ApprovalKind::Command, true),
        "applyPatchApproval" => (ApprovalKind::FileChange, true),
        _ => return None,
    };
    if kind == ApprovalKind::FileChange {
        if let Some(item_id) = details.get("itemId").and_then(Value::as_str) {
            if let Some(change) = file_changes.get(item_id) {
                details["change"] = change.clone();
            }
        }
    }
    Some((ApprovalRequest { kind, details }, legacy))
}

fn write_approval_response(
    stdin: &mut ChildStdin,
    request_id: Value,
    kind: ApprovalKind,
    decision: ApprovalDecision,
    legacy: bool,
    details: &Value,
) -> Result<()> {
    let result = if kind == ApprovalKind::Permissions {
        if decision != ApprovalDecision::Decline {
            json!({
                "permissions": details.get("permissions").cloned().unwrap_or_default(),
                "scope": "turn",
                "strictAutoReview": true,
            })
        } else {
            json!({ "permissions": {}, "scope": "turn", "strictAutoReview": true })
        }
    } else {
        let decision = if legacy {
            match decision {
                ApprovalDecision::Accept => "approved",
                ApprovalDecision::Decline => "abort",
                ApprovalDecision::AppliedByClient => "denied",
            }
        } else {
            match decision {
                ApprovalDecision::Accept => "accept",
                ApprovalDecision::Decline => "cancel",
                ApprovalDecision::AppliedByClient => "decline",
            }
        };
        json!({ "decision": decision })
    };
    write_message(stdin, &json!({ "id": request_id, "result": result }))
}

fn receive_response(
    messages: &Receiver<std::result::Result<Value, String>>,
    id: u64,
    deadline: Instant,
    cancellation: &CancellationToken,
    started_at: Instant,
) -> Result<Value> {
    loop {
        if cancellation.is_cancelled() {
            return Ok(
                json!({ "gyroTermination": "cancelled", "durationMs": elapsed_ms(started_at) }),
            );
        }
        if Instant::now() >= deadline {
            return Ok(
                json!({ "gyroTermination": "timed-out", "durationMs": elapsed_ms(started_at) }),
            );
        }
        match messages.recv_timeout(POLL_INTERVAL) {
            Ok(Ok(message)) if message.get("id").and_then(Value::as_u64) == Some(id) => {
                return Ok(message);
            }
            Ok(Ok(_)) => {}
            Ok(Err(error)) => return Err(anyhow!(error)),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                return Err(anyhow!("Codex app-server disconnected"));
            }
        }
    }
}

fn terminal_outcome(
    message: &Value,
    started_at: Instant,
    stderr: &Arc<Mutex<String>>,
) -> Option<CodexAppServerOutcome> {
    match message.get("gyroTermination").and_then(Value::as_str) {
        Some("cancelled") => Some(CodexAppServerOutcome::Cancelled {
            duration_ms: elapsed_ms(started_at),
        }),
        Some("timed-out") => Some(CodexAppServerOutcome::TimedOut {
            duration_ms: elapsed_ms(started_at),
        }),
        Some(other) => Some(failed_outcome(other.into(), started_at, stderr)),
        None => None,
    }
}

fn protocol_result(message: &Value) -> Result<&Value> {
    if let Some(error) = message.get("error") {
        let detail = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown app-server error");
        return Err(anyhow!("Codex app-server error: {detail}"));
    }
    message
        .get("result")
        .ok_or_else(|| anyhow!("Codex app-server response did not include a result"))
}

fn write_message(stdin: &mut ChildStdin, message: &Value) -> Result<()> {
    serde_json::to_writer(&mut *stdin, message)?;
    stdin.write_all(b"\n")?;
    stdin.flush()?;
    Ok(())
}

fn spawn_message_reader(stdout: ChildStdout) -> Receiver<std::result::Result<Value, String>> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let message = line
                .map_err(|error| error.to_string())
                .and_then(|line| serde_json::from_str(&line).map_err(|error| error.to_string()));
            if sender.send(message).is_err() {
                break;
            }
        }
    });
    receiver
}

fn spawn_stderr_reader(stderr: impl Read + Send + 'static, output: Arc<Mutex<String>>) {
    thread::spawn(move || {
        let mut bounded = String::new();
        let _ = stderr.take(MAX_STDERR_BYTES).read_to_string(&mut bounded);
        if let Ok(mut output) = output.lock() {
            *output = bounded;
        }
    });
}

fn failed_outcome(
    message: String,
    started_at: Instant,
    stderr: &Arc<Mutex<String>>,
) -> CodexAppServerOutcome {
    let stderr = stderr
        .lock()
        .ok()
        .map(|output| output.trim().to_string())
        .unwrap_or_default();
    let message = if stderr.is_empty() {
        message
    } else {
        format!("{message}: {stderr}")
    };
    CodexAppServerOutcome::Failed {
        message,
        duration_ms: elapsed_ms(started_at),
    }
}

fn elapsed_ms(started_at: Instant) -> u64 {
    started_at.elapsed().as_millis().min(u64::MAX as u128) as u64
}

struct ChildGuard {
    child: Child,
}

impl ChildGuard {
    fn new(child: Child) -> Self {
        Self { child }
    }

    fn child_mut(&mut self) -> &mut Child {
        &mut self.child
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        terminate_process_group(&mut self.child);
    }
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
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
fn configure_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn terminate_process_group(child: &mut Child) {
    let process_group = -(child.id() as i32);
    unsafe {
        libc::kill(process_group, libc::SIGTERM);
    }
    for _ in 0..10 {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    unsafe {
        libc::kill(process_group, libc::SIGKILL);
    }
    let _ = child.wait();
}

#[cfg(not(unix))]
fn terminate_process_group(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn fake_app_server(script_body: &str) -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("fake-codex");
        std::fs::write(&script, script_body).unwrap();
        let mut permissions = std::fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script, permissions).unwrap();
        (temp, script)
    }

    #[test]
    fn app_server_streams_output_and_routes_specific_approvals() {
        let (temp, script) = fake_app_server(
            r#"#!/bin/sh
test "$1" = "app-server" || exit 21
test "$2" = "--stdio" || exit 22
IFS= read -r initialize
printf '%s\n' '{"id":1,"result":{}}'
IFS= read -r initialized
IFS= read -r thread
case "$thread" in *'"approvalPolicy":"untrusted"'*'"sandbox":"read-only"'*) ;; *) exit 26 ;; esac
printf '%s\n' '{"id":2,"result":{"thread":{"id":"thread-test"}}}'
IFS= read -r turn
case "$turn" in *'"approvalPolicy":"untrusted"'*'"type":"readOnly"'*) ;; *) exit 27 ;; esac
printf '%s\n' '{"id":3,"result":{"turn":{"id":"turn-test"}}}'
printf '%s\n' '{"id":3,"method":"item/commandExecution/requestApproval","params":{"itemId":"command-1","command":"printf hello","cwd":"/tmp","reason":"test command"}}'
IFS= read -r command_decision
case "$command_decision" in *'"decision":"accept"'*) ;; *) exit 23 ;; esac
printf '%s\n' '{"method":"item/fileChange/patchUpdated","params":{"itemId":"file-1","changes":[{"path":"created.txt","kind":{"type":"add"},"diff":"hello\n"}]}}'
printf '%s\n' '{"id":42,"method":"item/fileChange/requestApproval","params":{"itemId":"file-1","reason":"test file"}}'
IFS= read -r file_decision
case "$file_decision" in *'"decision":"decline"'*) ;; *) exit 24 ;; esac
printf '%s\n' '{"method":"item/agentMessage/delta","params":{"delta":"done"}}'
printf '%s\n' '{"method":"item/completed","params":{"item":{"type":"agentMessage","text":"done"}}}'
printf '%s\n' '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}'
"#,
        );
        let mut approvals = Vec::new();
        let mut streamed = String::new();
        let outcome = run_codex_app_server(
            CodexAppServerRequest {
                program: script.display().to_string(),
                program_args: Vec::new(),
                workspace: temp.path().to_path_buf(),
                prompt: "test".into(),
                model: None,
                resume_session_id: None,
                require_command_approval: true,
                require_file_edit_approval: true,
                timeout: Duration::from_secs(5),
                cancellation: CancellationToken::default(),
            },
            |delta| streamed.push_str(delta),
            |approval| {
                approvals.push(approval.clone());
                Ok(if approval.kind == ApprovalKind::FileChange {
                    ApprovalDecision::AppliedByClient
                } else {
                    ApprovalDecision::Accept
                })
            },
            |_| Ok(()),
        )
        .unwrap();

        let CodexAppServerOutcome::Done(output) = outcome else {
            panic!("unexpected outcome: {outcome:?}");
        };
        assert_eq!(output.response, "done");
        assert_eq!(output.provider_session_id, "thread-test");
        assert_eq!(streamed, "done");
        assert_eq!(approvals.len(), 2);
        assert_eq!(approvals[0].kind, ApprovalKind::Command);
        assert_eq!(approvals[1].kind, ApprovalKind::FileChange);
        assert_eq!(
            approvals[1].details["change"]["changes"][0]["path"],
            "created.txt"
        );
    }

    #[test]
    fn app_server_reports_the_thread_before_a_provider_crash() {
        let (temp, script) = fake_app_server(
            r#"#!/bin/sh
IFS= read -r initialize
printf '%s\n' '{"id":1,"result":{}}'
IFS= read -r initialized
IFS= read -r thread
printf '%s\n' '{"id":2,"result":{"thread":{"id":"thread-before-crash"}}}'
IFS= read -r turn
exit 9
"#,
        );
        let mut sessions = Vec::new();

        let outcome = run_codex_app_server(
            CodexAppServerRequest {
                program: script.display().to_string(),
                program_args: Vec::new(),
                workspace: temp.path().to_path_buf(),
                prompt: "test".into(),
                model: None,
                resume_session_id: None,
                require_command_approval: true,
                require_file_edit_approval: true,
                timeout: Duration::from_secs(5),
                cancellation: CancellationToken::default(),
            },
            |_| {},
            |_| Ok(ApprovalDecision::Decline),
            |session_id| {
                sessions.push(session_id.to_string());
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(sessions, vec!["thread-before-crash"]);
        assert!(matches!(outcome, CodexAppServerOutcome::Failed { .. }));
    }

    #[test]
    fn app_server_sends_cancel_when_an_action_is_rejected() {
        let (temp, script) = fake_app_server(
            r#"#!/bin/sh
IFS= read -r initialize
printf '%s\n' '{"id":1,"result":{}}'
IFS= read -r initialized
IFS= read -r thread
printf '%s\n' '{"id":2,"result":{"thread":{"id":"thread-test"}}}'
IFS= read -r turn
printf '%s\n' '{"id":3,"result":{}}'
printf '%s\n' '{"id":41,"method":"item/commandExecution/requestApproval","params":{"command":"rm file"}}'
IFS= read -r decision
case "$decision" in *'"decision":"cancel"'*) exit 0 ;; *) exit 25 ;; esac
"#,
        );
        let outcome = run_codex_app_server(
            CodexAppServerRequest {
                program: script.display().to_string(),
                program_args: Vec::new(),
                workspace: temp.path().to_path_buf(),
                prompt: "test".into(),
                model: None,
                resume_session_id: None,
                require_command_approval: true,
                require_file_edit_approval: true,
                timeout: Duration::from_secs(5),
                cancellation: CancellationToken::default(),
            },
            |_| {},
            |_| Ok(ApprovalDecision::Decline),
            |_| Ok(()),
        )
        .unwrap();

        assert!(matches!(
            outcome,
            CodexAppServerOutcome::ApprovalRejected { .. }
        ));
    }
}
