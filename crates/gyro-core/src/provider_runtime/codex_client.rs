//! Bounded Codex stdio protocol transport and host-aware startup waits.
use super::{
    codex_startup,
    host::RunnerHost,
    limits::{CODEX_APP_SERVER_CHANNEL_CAPACITY, MAX_CODEX_APP_SERVER_MESSAGE_BYTES},
    types::ProviderChatRequest,
};
use std::{
    collections::VecDeque,
    io::{BufRead, BufReader, Read, Write},
    process::{ChildStderr, ChildStdin, ChildStdout},
    sync::mpsc,
    time::{Duration, Instant},
};
/// Bytes of Codex stderr kept so an early exit can say why it happened.
pub const CODEX_APP_SERVER_STDERR_TAIL_BYTES: usize = 4 * 1024;
/// Characters of that tail surfaced in the error shown to the user.
pub const CODEX_APP_SERVER_STDERR_DETAIL_CHARS: usize = 600;

/// Drains Codex stderr (so it can never block on a full pipe) and resolves to
/// its bounded tail once the stream closes.
pub fn spawn_codex_app_server_stderr_tail(stderr: ChildStderr) -> mpsc::Receiver<String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut tail = VecDeque::with_capacity(CODEX_APP_SERVER_STDERR_TAIL_BYTES);
        let mut chunk = [0_u8; 1024];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    tail.extend(&chunk[..read]);
                    let excess = tail
                        .len()
                        .saturating_sub(CODEX_APP_SERVER_STDERR_TAIL_BYTES);
                    tail.drain(..excess);
                }
            }
        }
        let bytes = tail.into_iter().collect::<Vec<_>>();
        let _ = sender.send(String::from_utf8_lossy(&bytes).into_owned());
    });
    receiver
}

pub fn codex_app_server_closed_message(stderr_tail: &str) -> String {
    let detail = stderr_tail
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if detail.is_empty() {
        return "Codex app server closed unexpectedly".into();
    }
    let total = detail.chars().count();
    let detail = if total > CODEX_APP_SERVER_STDERR_DETAIL_CHARS {
        let kept = detail
            .chars()
            .skip(total - CODEX_APP_SERVER_STDERR_DETAIL_CHARS)
            .collect::<String>();
        format!("…{kept}")
    } else {
        detail
    };
    format!("Codex app server closed unexpectedly: {detail}")
}

pub fn spawn_codex_app_server_reader(
    stdout: ChildStdout,
    stderr: Option<ChildStderr>,
) -> mpsc::Receiver<Result<serde_json::Value, String>> {
    let (sender, receiver) = mpsc::sync_channel(CODEX_APP_SERVER_CHANNEL_CAPACITY);
    let stderr_tail = stderr.map(spawn_codex_app_server_stderr_tail);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_bounded_protocol_line(&mut reader, MAX_CODEX_APP_SERVER_MESSAGE_BYTES) {
                Ok(None) => {
                    // A helper that inherited stderr can keep it open after
                    // Codex exits, so never wait long for the tail.
                    let tail = stderr_tail
                        .and_then(|tail| tail.recv_timeout(Duration::from_millis(500)).ok())
                        .unwrap_or_default();
                    let _ = sender.send(Err(codex_app_server_closed_message(&tail)));
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
                            "Codex app server returned invalid JSON: {error}"
                        )));
                        break;
                    }
                },
                Err(error) => {
                    let _ = sender.send(Err(format!(
                        "could not read the Codex app-server response: {error}"
                    )));
                    break;
                }
            }
        }
    });
    receiver
}

pub fn read_bounded_protocol_line<R: BufRead>(
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

pub fn write_codex_app_server_message(
    stdin: &mut ChildStdin,
    message: &serde_json::Value,
) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(message).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    stdin
        .write_all(&bytes)
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("could not write to the Codex usage service: {error}"))
}

pub fn receive_codex_app_server_response(
    messages: &mpsc::Receiver<Result<serde_json::Value, String>>,
    request_id: u64,
    deadline: Instant,
) -> Result<serde_json::Value, String> {
    receive_codex_app_server_response_until(messages, request_id, deadline, || false)
}

/// Wait for one app-server response in short slices so a Stop pressed while
/// Codex is still starting (MCP servers, a slow resume) ends the wait at once.
pub fn receive_codex_app_server_response_until(
    messages: &mpsc::Receiver<Result<serde_json::Value, String>>,
    request_id: u64,
    deadline: Instant,
    cancelled: impl Fn() -> bool,
) -> Result<serde_json::Value, String> {
    loop {
        if cancelled() {
            return Err("Codex request was stopped".into());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("Codex usage request timed out".into());
        }
        let message = match messages.recv_timeout(remaining.min(Duration::from_millis(250))) {
            Ok(message) => message?,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("Codex usage service disconnected".to_string())
            }
        };
        if message.get("id").and_then(serde_json::Value::as_u64) == Some(request_id) {
            return Ok(message);
        }
    }
}

pub fn receive_codex_turn_response(
    host: &dyn RunnerHost,
    request: &ProviderChatRequest,
    messages: &mpsc::Receiver<Result<serde_json::Value, String>>,
    request_id: u64,
    deadline: Instant,
) -> anyhow::Result<serde_json::Value> {
    let cancelled = || host.is_cancelled(&request.session_id);
    codex_startup::receive(messages, request_id, deadline, cancelled).map_err(|error| {
        match host.is_cancelled(&request.session_id) {
            true => anyhow::anyhow!("{}", host.stop_message(&request.session_id)),
            false => anyhow::Error::msg(error),
        }
    })
}

pub fn codex_app_server_result(response: &serde_json::Value) -> Result<serde_json::Value, String> {
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
