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
    spawn_message_reader(
        stdout,
        stderr.map(spawn_codex_app_server_stderr_tail),
        CodexClientOptions::desktop(),
    )
}

fn spawn_message_reader(
    stdout: ChildStdout,
    stderr_tail: Option<mpsc::Receiver<String>>,
    options: CodexClientOptions,
) -> mpsc::Receiver<Result<serde_json::Value, String>> {
    let (sender, receiver) = mpsc::sync_channel(options.channel_capacity);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let message = match read_protocol_frame(
                &mut reader,
                options.max_frame_bytes,
                options.wire_format,
            ) {
                Ok(Some(line)) => {
                    serde_json::from_slice(&line).map_err(|error| match options.wire_format {
                        CodexWireFormat::Desktop => {
                            format!("Codex app server returned invalid JSON: {error}")
                        }
                        CodexWireFormat::Cli => {
                            format!("Codex app-server returned invalid JSON: {error}")
                        }
                    })
                }
                Ok(None) => Err(match options.wire_format {
                    CodexWireFormat::Desktop => {
                        let tail = stderr_tail
                            .as_ref()
                            .and_then(|tail| tail.recv_timeout(Duration::from_millis(500)).ok())
                            .unwrap_or_default();
                        codex_app_server_closed_message(&tail)
                    }
                    CodexWireFormat::Cli => "Codex app-server closed its output stream".into(),
                }),
                Err(error) => Err(match options.wire_format {
                    CodexWireFormat::Desktop => {
                        format!("could not read the Codex app-server response: {error}")
                    }
                    CodexWireFormat::Cli => error,
                }),
            };
            let stop = message.is_err();
            if sender.send(message).is_err() || stop {
                break;
            }
        }
    });
    receiver
}

pub fn read_bounded_protocol_line<R: BufRead>(
    reader: &mut R,
    max_bytes: usize,
) -> Result<Option<Vec<u8>>, String> {
    read_protocol_frame(reader, max_bytes, CodexWireFormat::Desktop)
}

pub fn read_protocol_frame<R: BufRead>(
    reader: &mut R,
    max_bytes: usize,
    wire: CodexWireFormat,
) -> Result<Option<Vec<u8>>, String> {
    let mut line = Vec::with_capacity(max_bytes.min(8 * 1024));
    loop {
        let available = reader.fill_buf().map_err(|error| match wire {
            CodexWireFormat::Desktop => format!("could not read protocol data: {error}"),
            CodexWireFormat::Cli => {
                format!("could not read Codex app-server protocol data: {error}")
            }
        })?;
        if available.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Err(match wire {
                    CodexWireFormat::Desktop => {
                        "protocol response ended before its newline terminator".into()
                    }
                    CodexWireFormat::Cli => {
                        "Codex app-server closed with an unterminated protocol frame".into()
                    }
                })
            };
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |index| index + 1);
        let payload_len = newline.unwrap_or(consumed);
        if line
            .len()
            .checked_add(payload_len)
            .is_none_or(|length| length > max_bytes)
        {
            return Err(match wire {
                CodexWireFormat::Desktop => {
                    format!("protocol response exceeded the {max_bytes} byte size limit")
                }
                CodexWireFormat::Cli => {
                    format!("Codex app-server frame exceeded the {max_bytes}-byte limit")
                }
            });
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
    write_message(stdin, message, CodexClientOptions::desktop())
}
pub fn write_message(
    stdin: &mut ChildStdin,
    message: &serde_json::Value,
    options: CodexClientOptions,
) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(message).map_err(|error| error.to_string())?;
    if options
        .max_request_bytes
        .is_some_and(|limit| bytes.len() > limit)
    {
        return Err(format!(
            "Codex app-server request exceeded the {}-byte frame limit",
            options.max_request_bytes.unwrap()
        ));
    }
    bytes.push(b'\n');
    stdin
        .write_all(&bytes)
        .and_then(|_| stdin.flush())
        .map_err(|error| match options.wire_format {
            CodexWireFormat::Desktop => {
                format!("could not write to the Codex usage service: {error}")
            }
            CodexWireFormat::Cli => error.to_string(),
        })
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

/// Existing desktop and CLI wire budgets are explicit, rather than silently
/// increasing either host's queue or frame limits during client consolidation.
#[derive(Clone, Copy, Debug)]
pub enum CodexWireFormat {
    Desktop,
    Cli,
}
#[derive(Clone, Copy, Debug)]
pub struct CodexClientOptions {
    pub max_frame_bytes: usize,
    pub channel_capacity: usize,
    pub max_request_bytes: Option<usize>,
    pub wire_format: CodexWireFormat,
    pub service: bool,
}
impl CodexClientOptions {
    pub fn desktop() -> Self {
        Self {
            max_frame_bytes: MAX_CODEX_APP_SERVER_MESSAGE_BYTES,
            channel_capacity: CODEX_APP_SERVER_CHANNEL_CAPACITY,
            max_request_bytes: None,
            wire_format: CodexWireFormat::Desktop,
            service: false,
        }
    }
    pub fn cli() -> Self {
        Self {
            max_frame_bytes: 1024 * 1024,
            channel_capacity: 64,
            max_request_bytes: Some(1024 * 1024),
            wire_format: CodexWireFormat::Cli,
            service: false,
        }
    }
}

/// One process, bounded protocol reader, stderr collector and cleanup owner.
/// Callers retain their own request lifecycle and approval callbacks.
pub struct CodexClient {
    child: super::support::ProviderProcessGuard,
    stdin: Option<ChildStdin>,
    messages: Option<mpsc::Receiver<Result<serde_json::Value, String>>>,
    pub stderr_output: std::sync::Arc<std::sync::Mutex<String>>,
}
impl CodexClient {
    pub fn spawn(
        mut command: std::process::Command,
        options: CodexClientOptions,
    ) -> std::io::Result<Self> {
        use std::process::Stdio;
        command
            .args(["app-server", "--stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        super::support::configure_provider_process_group(&mut command);
        let child = if options.service {
            crate::process_guard::spawn_service(&mut command)?
        } else {
            crate::process_guard::spawn_guarded(&mut command)?
        };
        let mut child = super::support::ProviderProcessGuard::new(child);
        let pipe =
            |name: &str| std::io::Error::other(format!("Codex app server {name} is unavailable"));
        let stdin = child.stdin.take().ok_or_else(|| pipe("input"))?;
        let stdout = child.stdout.take().ok_or_else(|| pipe("output"))?;
        let stderr = child.stderr.take().ok_or_else(|| pipe("error output"))?;
        let stderr_output = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let stderr_tail = match options.wire_format {
            CodexWireFormat::Desktop => Some(spawn_codex_app_server_stderr_tail(stderr)),
            CodexWireFormat::Cli => {
                let output = stderr_output.clone();
                std::thread::spawn(move || {
                    // Retain the CLI's first 64 KiB, but drain the rest so a
                    // verbose child cannot stall on its stderr pipe.
                    let mut reader = BufReader::new(stderr);
                    let mut kept = Vec::new();
                    let mut buf = [0u8; 4096];
                    loop {
                        match reader.read(&mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                let take = n.min((64 * 1024usize).saturating_sub(kept.len()));
                                kept.extend_from_slice(&buf[..take]);
                            }
                        }
                    }
                    if let Ok(mut output) = output.lock() {
                        *output = String::from_utf8_lossy(&kept).into_owned();
                    }
                });
                None
            }
        };
        let messages = spawn_message_reader(stdout, stderr_tail, options);
        Ok(Self {
            child,
            stdin: Some(stdin),
            messages: Some(messages),
            stderr_output,
        })
    }
    pub fn take_io(
        &mut self,
    ) -> Result<
        (
            ChildStdin,
            mpsc::Receiver<Result<serde_json::Value, String>>,
        ),
        String,
    > {
        let stdin = self
            .stdin
            .take()
            .ok_or("Codex client input was already taken")?;
        let messages = self
            .messages
            .take()
            .ok_or("Codex client output was already taken")?;
        Ok((stdin, messages))
    }
    pub fn child_mut(&mut self) -> &mut std::process::Child {
        &mut self.child
    }
}

#[cfg(all(test, unix))]
mod client_tests {
    use super::*;

    fn peer(script: &str) -> std::process::Command {
        let mut command = std::process::Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    }

    #[test]
    fn both_wire_formats_enforce_frames_before_decoding() {
        for wire in [CodexWireFormat::Desktop, CodexWireFormat::Cli] {
            let mut exact = std::io::Cursor::new(b"{}\r\n");
            assert_eq!(
                read_protocol_frame(&mut exact, 3, wire).unwrap(),
                Some(b"{}".to_vec())
            );
            let mut oversized = std::io::Cursor::new(b"12345\n");
            assert!(read_protocol_frame(&mut oversized, 4, wire)
                .unwrap_err()
                .contains("limit"));
            let mut partial = std::io::Cursor::new(b"{}");
            assert!(read_protocol_frame(&mut partial, 4, wire).is_err());
        }
    }

    #[test]
    fn rejected_cli_request_does_not_write_a_partial_frame() {
        let mut options = CodexClientOptions::cli();
        options.max_request_bytes = Some(32);
        let mut client =
            CodexClient::spawn(peer("IFS= read -r line; printf '%s\n' \"$line\""), options)
                .unwrap();
        let (mut stdin, messages) = client.take_io().unwrap();
        let oversized = serde_json::json!({"text":"x".repeat(64)});
        assert!(write_message(&mut stdin, &oversized, options)
            .unwrap_err()
            .contains("frame limit"));
        let valid = serde_json::json!({"id":1});
        write_message(&mut stdin, &valid, options).unwrap();
        assert_eq!(
            messages
                .recv_timeout(Duration::from_secs(3))
                .unwrap()
                .unwrap(),
            valid
        );
        assert!(client.take_io().is_err());
    }

    #[test]
    fn cli_stderr_is_bounded_and_drained_without_blocking_protocol() {
        let mut client = CodexClient::spawn(
            peer("head -c 131072 /dev/zero >&2; printf '{\"ready\":true}\n'; sleep 30"),
            CodexClientOptions::cli(),
        )
        .unwrap();
        let (_stdin, messages) = client.take_io().unwrap();
        let captured = client.stderr_output.clone();
        assert_eq!(
            messages
                .recv_timeout(Duration::from_secs(3))
                .unwrap()
                .unwrap()["ready"],
            true
        );
        let started = Instant::now();
        drop(client);
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "client drop must terminate its process group"
        );
        let deadline = Instant::now() + Duration::from_secs(1);
        while captured.lock().unwrap().is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(captured.lock().unwrap().len(), 64 * 1024);
    }
}
