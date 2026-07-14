use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

const EXECUTION_CHANNEL_CAPACITY: usize = 128;
const EXECUTION_READ_CHUNK_BYTES: usize = 8 * 1024;
const EXECUTION_POLL_INTERVAL: Duration = Duration::from_millis(20);
const EXECUTION_TERMINATION_GRACE: Duration = Duration::from_millis(250);

#[derive(Clone, Debug, Default)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

#[derive(Clone, Debug)]
pub struct ExecutionRequest {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub current_dir: Option<PathBuf>,
    pub env: Vec<(OsString, Option<OsString>)>,
    pub timeout: Duration,
    pub inactivity_timeout: Option<Duration>,
    pub max_stdout_chars: usize,
    pub max_stderr_chars: usize,
}

impl ExecutionRequest {
    pub fn new(program: impl Into<OsString>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            current_dir: None,
            env: Vec::new(),
            timeout: Duration::from_secs(180),
            inactivity_timeout: None,
            max_stdout_chars: 256_000,
            max_stderr_chars: 64_000,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExecutionStream {
    Stdout,
    Stderr,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutionChunk {
    pub stream: ExecutionStream,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case", tag = "kind")]
pub enum ExecutionTermination {
    Exited { code: Option<i32> },
    Cancelled,
    TimedOut,
    Inactive,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionOutcome {
    pub termination: ExecutionTermination,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub duration_ms: u64,
}

impl ExecutionOutcome {
    pub fn succeeded(&self) -> bool {
        self.termination == (ExecutionTermination::Exited { code: Some(0) })
    }

    pub fn exit_code(&self) -> Option<i32> {
        match self.termination {
            ExecutionTermination::Exited { code } => code,
            ExecutionTermination::Cancelled
            | ExecutionTermination::TimedOut
            | ExecutionTermination::Inactive => None,
        }
    }
}

pub fn run_command<F>(
    request: ExecutionRequest,
    cancellation: CancellationToken,
    mut on_chunk: F,
) -> Result<ExecutionOutcome>
where
    F: FnMut(&ExecutionChunk),
{
    if cancellation.is_cancelled() {
        return Ok(ExecutionOutcome {
            termination: ExecutionTermination::Cancelled,
            stdout: String::new(),
            stderr: String::new(),
            stdout_truncated: false,
            stderr_truncated: false,
            duration_ms: 0,
        });
    }
    let mut command = Command::new(&request.program);
    command
        .args(&request.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(current_dir) = request.current_dir.as_ref() {
        command.current_dir(current_dir);
    }
    for (key, value) in &request.env {
        if let Some(value) = value {
            command.env(key, value);
        } else {
            command.env_remove(key);
        }
    }
    configure_process_group(&mut command);

    let mut child = command
        .spawn()
        .with_context(|| format!("start {}", request.program.to_string_lossy()))?;
    let stdout = child
        .stdout
        .take()
        .context("execution stdout was unavailable")?;
    let stderr = child
        .stderr
        .take()
        .context("execution stderr was unavailable")?;
    let (sender, receiver) = mpsc::sync_channel(EXECUTION_CHANNEL_CAPACITY);
    let stdout_thread = spawn_reader(stdout, ExecutionStream::Stdout, sender.clone());
    let stderr_thread = spawn_reader(stderr, ExecutionStream::Stderr, sender.clone());
    drop(sender);

    let started_at = Instant::now();
    let mut last_activity_at = Instant::now();
    let mut stdout_text = String::new();
    let mut stderr_text = String::new();
    let mut stdout_chars = 0usize;
    let mut stderr_chars = 0usize;
    let mut stdout_truncated = false;
    let mut stderr_truncated = false;
    let termination = loop {
        if drain_chunks(
            &receiver,
            &mut on_chunk,
            &mut stdout_text,
            &mut stderr_text,
            &mut stdout_chars,
            &mut stderr_chars,
            request.max_stdout_chars,
            request.max_stderr_chars,
            &mut stdout_truncated,
            &mut stderr_truncated,
        ) {
            last_activity_at = Instant::now();
        }
        if cancellation.is_cancelled() {
            terminate_process_group(&mut child);
            break ExecutionTermination::Cancelled;
        }
        if let Some(termination) = execution_timeout_termination(
            started_at.elapsed(),
            last_activity_at.elapsed(),
            request.timeout,
            request.inactivity_timeout,
        ) {
            terminate_process_group(&mut child);
            break termination;
        }
        if let Some(status) = child.try_wait()? {
            break ExecutionTermination::Exited {
                code: status.code(),
            };
        }
        if let Ok(chunk) = receiver.recv_timeout(EXECUTION_POLL_INTERVAL) {
            last_activity_at = Instant::now();
            handle_chunk(
                chunk,
                &mut on_chunk,
                &mut stdout_text,
                &mut stderr_text,
                &mut stdout_chars,
                &mut stderr_chars,
                request.max_stdout_chars,
                request.max_stderr_chars,
                &mut stdout_truncated,
                &mut stderr_truncated,
            );
        }
    };

    while let Ok(chunk) = receiver.recv_timeout(EXECUTION_POLL_INTERVAL) {
        handle_chunk(
            chunk,
            &mut on_chunk,
            &mut stdout_text,
            &mut stderr_text,
            &mut stdout_chars,
            &mut stderr_chars,
            request.max_stdout_chars,
            request.max_stderr_chars,
            &mut stdout_truncated,
            &mut stderr_truncated,
        );
    }
    let _ = stdout_thread.join();
    let _ = stderr_thread.join();

    Ok(ExecutionOutcome {
        termination,
        stdout: stdout_text,
        stderr: stderr_text,
        stdout_truncated,
        stderr_truncated,
        duration_ms: started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
    })
}

fn execution_timeout_termination(
    elapsed: Duration,
    inactive_for: Duration,
    max_runtime: Duration,
    inactivity_timeout: Option<Duration>,
) -> Option<ExecutionTermination> {
    if elapsed >= max_runtime {
        return Some(ExecutionTermination::TimedOut);
    }
    inactivity_timeout
        .filter(|timeout| inactive_for >= *timeout)
        .map(|_| ExecutionTermination::Inactive)
}

fn spawn_reader<R>(
    mut reader: R,
    stream: ExecutionStream,
    sender: SyncSender<ExecutionChunk>,
) -> thread::JoinHandle<()>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut buffer = [0u8; EXECUTION_READ_CHUNK_BYTES];
        let mut pending = Vec::new();
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    if !pending.is_empty()
                        && !send_text_chunk(
                            &sender,
                            stream,
                            String::from_utf8_lossy(&pending).into_owned(),
                        )
                    {
                        return;
                    }
                    break;
                }
                Ok(count) => {
                    pending.extend_from_slice(&buffer[..count]);
                    if !flush_complete_utf8(&mut pending, stream, &sender) {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    })
}

fn flush_complete_utf8(
    pending: &mut Vec<u8>,
    stream: ExecutionStream,
    sender: &SyncSender<ExecutionChunk>,
) -> bool {
    loop {
        match std::str::from_utf8(pending) {
            Ok(text) => {
                let text = text.to_string();
                pending.clear();
                return send_text_chunk(sender, stream, text);
            }
            Err(error) => {
                let valid_up_to = error.valid_up_to();
                if valid_up_to > 0 {
                    let text = String::from_utf8_lossy(&pending[..valid_up_to]).into_owned();
                    pending.drain(..valid_up_to);
                    if !send_text_chunk(sender, stream, text) {
                        return false;
                    }
                }
                let Some(invalid_len) = error.error_len() else {
                    return true;
                };
                pending.drain(..invalid_len);
                if !send_text_chunk(sender, stream, "\u{fffd}".into()) {
                    return false;
                }
            }
        }
    }
}

fn send_text_chunk(
    sender: &SyncSender<ExecutionChunk>,
    stream: ExecutionStream,
    text: String,
) -> bool {
    text.is_empty() || sender.send(ExecutionChunk { stream, text }).is_ok()
}

#[allow(clippy::too_many_arguments)]
fn drain_chunks<F>(
    receiver: &Receiver<ExecutionChunk>,
    on_chunk: &mut F,
    stdout: &mut String,
    stderr: &mut String,
    stdout_chars: &mut usize,
    stderr_chars: &mut usize,
    max_stdout_chars: usize,
    max_stderr_chars: usize,
    stdout_truncated: &mut bool,
    stderr_truncated: &mut bool,
) -> bool
where
    F: FnMut(&ExecutionChunk),
{
    let mut received = false;
    while let Ok(chunk) = receiver.try_recv() {
        received = true;
        handle_chunk(
            chunk,
            on_chunk,
            stdout,
            stderr,
            stdout_chars,
            stderr_chars,
            max_stdout_chars,
            max_stderr_chars,
            stdout_truncated,
            stderr_truncated,
        );
    }
    received
}

#[allow(clippy::too_many_arguments)]
fn handle_chunk<F>(
    chunk: ExecutionChunk,
    on_chunk: &mut F,
    stdout: &mut String,
    stderr: &mut String,
    stdout_chars: &mut usize,
    stderr_chars: &mut usize,
    max_stdout_chars: usize,
    max_stderr_chars: usize,
    stdout_truncated: &mut bool,
    stderr_truncated: &mut bool,
) where
    F: FnMut(&ExecutionChunk),
{
    on_chunk(&chunk);
    match chunk.stream {
        ExecutionStream::Stdout => {
            *stdout_truncated |= push_bounded(stdout, stdout_chars, &chunk.text, max_stdout_chars)
        }
        ExecutionStream::Stderr => {
            *stderr_truncated |= push_bounded(stderr, stderr_chars, &chunk.text, max_stderr_chars)
        }
    }
}

fn push_bounded(
    target: &mut String,
    current_chars: &mut usize,
    text: &str,
    max_chars: usize,
) -> bool {
    if *current_chars >= max_chars {
        return !text.is_empty();
    }
    let remaining = max_chars - *current_chars;
    let text_chars = text.chars().count();
    if text_chars <= remaining {
        target.push_str(text);
        *current_chars += text_chars;
        return false;
    }
    target.extend(text.chars().take(remaining));
    *current_chars = max_chars;
    true
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(not(unix))]
fn configure_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn terminate_process_group(child: &mut std::process::Child) {
    let process_group = -(child.id() as i32);
    unsafe {
        libc::kill(process_group, libc::SIGTERM);
    }
    let started_at = Instant::now();
    let mut child_reaped = false;
    while started_at.elapsed() < EXECUTION_TERMINATION_GRACE {
        if !child_reaped && child.try_wait().ok().flatten().is_some() {
            child_reaped = true;
        }
        thread::sleep(EXECUTION_POLL_INTERVAL);
    }
    // The direct child can exit after SIGTERM while a descendant keeps the
    // process group's output pipes open. Always follow with SIGKILL after the
    // grace period so cancellation cannot wait on an orphaned provider child.
    unsafe {
        libc::kill(process_group, libc::SIGKILL);
    }
    if !child_reaped {
        let _ = child.wait();
    }
}

#[cfg(not(unix))]
fn terminate_process_group(child: &mut std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{self, Cursor};

    struct ByteReader(Cursor<Vec<u8>>);

    impl Read for ByteReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let count = buffer.len().min(1);
            self.0.read(&mut buffer[..count])
        }
    }

    #[test]
    fn reader_preserves_unicode_split_across_os_chunks() {
        let expected = "héllo 🌍";
        let (sender, receiver) = mpsc::sync_channel(16);
        let reader = spawn_reader(
            ByteReader(Cursor::new(expected.as_bytes().to_vec())),
            ExecutionStream::Stdout,
            sender,
        );
        reader.join().unwrap();
        let output = receiver
            .try_iter()
            .map(|chunk| chunk.text)
            .collect::<String>();

        assert_eq!(output, expected);
        assert!(!output.contains('\u{fffd}'));
    }

    #[test]
    fn streams_output_in_order_and_bounds_retained_diagnostics() {
        let mut request = ExecutionRequest::new("/bin/sh");
        request.args = vec![
            "-c".into(),
            "printf 'one\\ntwo\\n'; printf 'failure-detail' >&2".into(),
        ];
        request.max_stdout_chars = 5;
        request.max_stderr_chars = 7;
        let mut chunks = String::new();

        let outcome = run_command(request, CancellationToken::default(), |chunk| {
            if chunk.stream == ExecutionStream::Stdout {
                chunks.push_str(&chunk.text);
            }
        })
        .unwrap();

        assert!(outcome.succeeded());
        assert_eq!(chunks, "one\ntwo\n");
        assert_eq!(outcome.stdout, "one\nt");
        assert_eq!(outcome.stderr, "failure");
        assert!(outcome.stdout_truncated);
        assert!(outcome.stderr_truncated);
    }

    #[test]
    fn cancellation_stops_the_process_group_and_preserves_partial_output() {
        let mut request = ExecutionRequest::new("/bin/sh");
        request.args = vec![
            "-c".into(),
            "trap 'exit 0' TERM; (trap '' TERM; exec sleep 30) & printf 'started\\n'; wait".into(),
        ];
        request.timeout = Duration::from_secs(5);
        let cancellation = CancellationToken::default();
        let cancellation_from_stream = cancellation.clone();

        let outcome = run_command(request, cancellation, move |chunk| {
            if chunk.text.contains("started") {
                cancellation_from_stream.cancel();
            }
        })
        .unwrap();

        assert_eq!(outcome.termination, ExecutionTermination::Cancelled);
        assert!(outcome.stdout.contains("started"));
        assert!(outcome.duration_ms < 2_000);
    }

    #[test]
    fn cancellation_before_start_never_spawns_the_command() {
        let request = ExecutionRequest::new("/definitely/missing/gyro-provider");
        let cancellation = CancellationToken::default();
        cancellation.cancel();

        let outcome = run_command(request, cancellation, |_| {}).unwrap();

        assert_eq!(outcome.termination, ExecutionTermination::Cancelled);
        assert_eq!(outcome.duration_ms, 0);
    }

    #[test]
    fn timeout_stops_long_running_processes() {
        let mut request = ExecutionRequest::new("/bin/sh");
        request.args = vec!["-c".into(), "sleep 30".into()];
        request.timeout = Duration::from_millis(80);

        let outcome = run_command(request, CancellationToken::default(), |_| {}).unwrap();

        assert_eq!(outcome.termination, ExecutionTermination::TimedOut);
        assert!(outcome.duration_ms < 2_000);
    }

    #[test]
    fn inactivity_timeout_stops_silent_processes() {
        let mut request = ExecutionRequest::new("/bin/sh");
        request.args = vec!["-c".into(), "sleep 30".into()];
        request.timeout = Duration::from_secs(5);
        request.inactivity_timeout = Some(Duration::from_millis(80));

        let outcome = run_command(request, CancellationToken::default(), |_| {}).unwrap();

        assert_eq!(outcome.termination, ExecutionTermination::Inactive);
        assert!(outcome.duration_ms < 2_000);
    }

    #[test]
    fn recent_output_keeps_a_long_active_process_alive() {
        assert_eq!(
            execution_timeout_termination(
                Duration::from_secs(60 * 60),
                Duration::from_secs(2),
                Duration::from_secs(24 * 60 * 60),
                Some(Duration::from_secs(30 * 60)),
            ),
            None
        );
        assert_eq!(
            execution_timeout_termination(
                Duration::from_secs(60 * 60),
                Duration::from_secs(30 * 60),
                Duration::from_secs(24 * 60 * 60),
                Some(Duration::from_secs(30 * 60)),
            ),
            Some(ExecutionTermination::Inactive)
        );
    }
}
