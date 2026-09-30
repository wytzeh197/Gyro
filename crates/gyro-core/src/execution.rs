use crate::credentials::CredentialPolicy;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::ffi::OsString;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

const EXECUTION_CHANNEL_CAPACITY: usize = 128;
const EXECUTION_READ_CHUNK_BYTES: usize = 8 * 1024;
const EXECUTION_POLL_INTERVAL: Duration = Duration::from_millis(20);
const EXECUTION_TERMINATION_GRACE: Duration = Duration::from_millis(250);
/// How often a terminating process group is checked for having exited, so a
/// group that dies on SIGTERM is not held for the whole grace period.
const EXECUTION_TERMINATION_POLL_INTERVAL: Duration = Duration::from_millis(10);
/// After the child is gone, how long output may stay silent before the
/// readers are abandoned. A descendant that left the process group (setsid,
/// setpgrp, a daemonizing tool) can hold the pipes open indefinitely.
const EXECUTION_READER_SILENCE_GRACE: Duration = Duration::from_millis(250);
/// Hard ceiling on the post-exit drain, for an escaped descendant that keeps
/// writing to the inherited pipes.
const EXECUTION_READER_DRAIN_LIMIT: Duration = Duration::from_secs(5);

/// Process groups spawned for provider runs that have not been reaped yet.
/// Provider children run in their own process group, so they receive no
/// SIGHUP when Gyro quits; the quit path tears them down through
/// [`terminate_live_process_groups`].
static LIVE_PROCESS_GROUPS: Mutex<BTreeSet<i32>> = Mutex::new(BTreeSet::new());

fn live_process_groups() -> MutexGuard<'static, BTreeSet<i32>> {
    LIVE_PROCESS_GROUPS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub fn register_process_group(process_group_id: u32) {
    if let Ok(process_group_id) = i32::try_from(process_group_id) {
        if process_group_id > 0 {
            live_process_groups().insert(process_group_id);
        }
    }
}

pub fn unregister_process_group(process_group_id: u32) {
    if let Ok(process_group_id) = i32::try_from(process_group_id) {
        live_process_groups().remove(&process_group_id);
    }
}

/// Terminate every provider process group that is still running: SIGTERM
/// each one, wait up to `grace` for the groups to disappear, then SIGKILL
/// whatever remains. Meant for app shutdown; safe to call from any thread,
/// never panics, and never holds the registry lock while sleeping.
pub fn terminate_live_process_groups(grace: Duration) {
    let process_groups = live_process_groups().iter().copied().collect::<Vec<_>>();
    terminate_process_groups(&process_groups, grace);
}

#[cfg(unix)]
fn terminate_process_groups(process_groups: &[i32], grace: Duration) {
    if process_groups.is_empty() {
        return;
    }
    // Signals are sent under the registry lock (kill(2) does not block) so a
    // group its owner already reaped and unregistered is never signalled.
    let signal_registered = |process_group: i32, signal: libc::c_int| {
        let registry = live_process_groups();
        if registry.contains(&process_group) {
            unsafe {
                libc::kill(-process_group, signal);
            }
        }
    };
    for process_group in process_groups {
        signal_registered(*process_group, libc::SIGTERM);
    }
    let started_at = Instant::now();
    let mut remaining = process_groups.to_vec();
    loop {
        remaining.retain(|process_group| {
            live_process_groups().contains(process_group) && process_group_exists(*process_group)
        });
        let elapsed = started_at.elapsed();
        if remaining.is_empty() || elapsed >= grace {
            break;
        }
        thread::sleep(EXECUTION_TERMINATION_POLL_INTERVAL.min(grace - elapsed));
    }
    for process_group in &remaining {
        signal_registered(*process_group, libc::SIGKILL);
    }
    let mut registry = live_process_groups();
    for process_group in process_groups {
        registry.remove(process_group);
    }
}

#[cfg(not(unix))]
fn terminate_process_groups(process_groups: &[i32], _grace: Duration) {
    let mut registry = live_process_groups();
    for process_group in process_groups {
        registry.remove(process_group);
    }
}

/// Whether any process is still in the group. EPERM means it exists but we
/// may not signal it, which still counts as alive.
#[cfg(unix)]
fn process_group_exists(process_group: i32) -> bool {
    if unsafe { libc::kill(-process_group, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

/// A spawned provider child whose whole process group is torn down when the
/// guard is dropped without the child having been reaped — including when a
/// panic unwinds out of an output callback — so a failed turn cannot leak
/// the provider CLI or its tool children.
struct ProcessGroupChild {
    child: Child,
    settled: bool,
}

impl ProcessGroupChild {
    fn new(child: Child) -> Self {
        register_process_group(child.id());
        Self {
            child,
            settled: false,
        }
    }

    fn terminate(&mut self) {
        if !self.settled {
            self.settled = true;
            terminate_process_group(&mut self.child);
        }
    }

    /// The direct child exited on its own: clear out any descendants left in
    /// its process group and stop tracking it.
    fn finish_after_exit(&mut self) {
        if !self.settled {
            self.settled = true;
            terminate_descendants_after_exit(self.child.id());
            unregister_process_group(self.child.id());
        }
    }
}

impl Drop for ProcessGroupChild {
    fn drop(&mut self) {
        self.terminate();
    }
}

#[derive(Clone, Debug, Default)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
    wake: Arc<tokio::sync::Notify>,
}

impl CancellationToken {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.wake.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub(crate) async fn wait_cancelled(&self) {
        let notified = self.wake.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if !self.is_cancelled() {
            notified.await;
        }
    }
}

#[derive(Clone, Debug)]
pub struct ExecutionRequest {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub current_dir: Option<PathBuf>,
    pub env: Vec<(OsString, Option<OsString>)>,
    /// Optional finite input file; avoids blocking output/cancellation on a
    /// large multimodal message being written to a pipe.
    pub stdin_file: Option<PathBuf>,
    /// Which inherited credentials the child is allowed to keep. Defaults to
    /// `Inherit` so Gyro's own tooling is unaffected; agent-driven runs set a
    /// scrubbed policy explicitly. See `credentials`.
    pub credentials: CredentialPolicy,
    pub timeout: Duration,
    pub inactivity_timeout: Option<Duration>,
    pub max_stdout_chars: usize,
    pub max_stderr_chars: usize,
    pub max_total_output_bytes: usize,
    pub max_output_chunks: usize,
}

impl ExecutionRequest {
    pub fn new(program: impl Into<OsString>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            current_dir: None,
            env: Vec::new(),
            stdin_file: None,
            credentials: CredentialPolicy::Inherit,
            timeout: Duration::from_secs(180),
            inactivity_timeout: None,
            max_stdout_chars: 256_000,
            max_stderr_chars: 64_000,
            max_total_output_bytes: 64 * 1024 * 1024,
            max_output_chunks: 100_000,
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
    OutputLimit,
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
            | ExecutionTermination::Inactive
            | ExecutionTermination::OutputLimit => None,
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
        .stdin(match request.stdin_file.as_ref() {
            Some(path) => Stdio::from(std::fs::File::open(path).context("open execution input")?),
            None => Stdio::null(),
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(current_dir) = request.current_dir.as_ref() {
        command.current_dir(current_dir);
    }
    // Credential scrubbing runs before the request's own overrides so an
    // explicit override still wins: a caller that deliberately passes a secret
    // is making a decision, not leaking one by inheritance.
    for (key, _) in request.credentials.env_overrides() {
        command.env_remove(key);
    }
    for (key, value) in &request.env {
        if let Some(value) = value {
            command.env(key, value);
        } else {
            command.env_remove(key);
        }
    }
    configure_process_group(&mut command);

    crate::timing::mark(crate::timing::Stage::ProcessStart);
    let mut child = ProcessGroupChild::new(
        command
            .spawn()
            .with_context(|| format!("start {}", request.program.to_string_lossy()))?,
    );
    crate::timing::mark(crate::timing::Stage::ProcessSpawned);
    let Some(stdout) = child.child.stdout.take() else {
        child.terminate();
        anyhow::bail!("execution stdout was unavailable");
    };
    let Some(stderr) = child.child.stderr.take() else {
        child.terminate();
        anyhow::bail!("execution stderr was unavailable");
    };
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
    let mut output_budget = OutputBudget {
        total_bytes: 0,
        chunks: 0,
        max_total_bytes: request.max_total_output_bytes,
        max_chunks: request.max_output_chunks,
        exceeded: false,
    };
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
            &mut output_budget,
        ) {
            last_activity_at = Instant::now();
        }
        if output_budget.exceeded {
            child.terminate();
            break ExecutionTermination::OutputLimit;
        }
        if cancellation.is_cancelled() {
            child.terminate();
            break ExecutionTermination::Cancelled;
        }
        if let Some(termination) = execution_timeout_termination(
            started_at.elapsed(),
            last_activity_at.elapsed(),
            request.timeout,
            request.inactivity_timeout,
        ) {
            child.terminate();
            break termination;
        }
        match child.child.try_wait() {
            Ok(Some(status)) => {
                // A background descendant can retain the inherited output pipes after
                // the direct child exits. Tear down any remaining process-group members
                // before waiting for the reader threads so a completed command cannot
                // hang forever.
                child.finish_after_exit();
                break ExecutionTermination::Exited {
                    code: status.code(),
                };
            }
            Ok(None) => {}
            Err(error) => {
                child.terminate();
                return Err(error).context("poll execution process");
            }
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
                &mut output_budget,
            );
            if output_budget.exceeded {
                child.terminate();
                break ExecutionTermination::OutputLimit;
            }
        }
    };

    // Drain until both readers hit EOF. A descendant that escaped the process
    // group can keep the pipes open forever, so the drain is bounded by a
    // silence grace and a hard limit, and unfinished readers are detached
    // rather than joined: they exit on their own once the pipe closes or
    // their next send finds the receiver gone.
    let drain_started_at = Instant::now();
    loop {
        match receiver.recv_timeout(EXECUTION_POLL_INTERVAL) {
            Ok(chunk) => {
                if termination != ExecutionTermination::OutputLimit {
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
                        &mut output_budget,
                    );
                }
                if drain_started_at.elapsed() >= EXECUTION_READER_DRAIN_LIMIT {
                    break;
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {
                if drain_started_at.elapsed() >= EXECUTION_READER_SILENCE_GRACE {
                    break;
                }
            }
        }
    }
    for reader in [stdout_thread, stderr_thread] {
        if reader.is_finished() {
            let _ = reader.join();
        }
    }

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
    output_budget: &mut OutputBudget,
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
            output_budget,
        );
        if output_budget.exceeded {
            break;
        }
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
    output_budget: &mut OutputBudget,
) where
    F: FnMut(&ExecutionChunk),
{
    output_budget.record(&chunk);
    if output_budget.exceeded {
        return;
    }
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

struct OutputBudget {
    total_bytes: usize,
    chunks: usize,
    max_total_bytes: usize,
    max_chunks: usize,
    exceeded: bool,
}

impl OutputBudget {
    fn record(&mut self, chunk: &ExecutionChunk) {
        self.total_bytes = self.total_bytes.saturating_add(chunk.text.len());
        self.chunks = self.chunks.saturating_add(1);
        self.exceeded = self.total_bytes > self.max_total_bytes || self.chunks > self.max_chunks;
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
pub(crate) fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(not(unix))]
pub(crate) fn configure_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn terminate_descendants_after_exit(process_group_id: u32) {
    let process_group = -(process_group_id as i32);
    // ESRCH is the common, zero-cost path when the command left no descendants.
    let had_descendants = unsafe { libc::kill(process_group, libc::SIGTERM) } == 0;
    if had_descendants {
        thread::sleep(EXECUTION_POLL_INTERVAL);
        unsafe {
            libc::kill(process_group, libc::SIGKILL);
        }
    }
}

#[cfg(not(unix))]
fn terminate_descendants_after_exit(_process_group_id: u32) {}

#[cfg(unix)]
pub(crate) fn terminate_process_group(child: &mut std::process::Child) {
    let process_group_id = child.id() as i32;
    unsafe {
        libc::kill(-process_group_id, libc::SIGTERM);
    }
    let started_at = Instant::now();
    let mut child_reaped = false;
    loop {
        if !child_reaped && child.try_wait().ok().flatten().is_some() {
            child_reaped = true;
        }
        // Once the direct child is reaped and no descendant is left in the
        // group there is nothing to escalate against: return immediately
        // instead of paying the whole grace period on every cancel or ACP
        // connection teardown.
        if child_reaped && !process_group_exists(process_group_id) {
            break;
        }
        if started_at.elapsed() >= EXECUTION_TERMINATION_GRACE {
            // The direct child can exit after SIGTERM while a descendant keeps
            // the process group's output pipes open. Follow with SIGKILL after
            // the grace period so cancellation cannot wait on an orphaned
            // provider child.
            unsafe {
                libc::kill(-process_group_id, libc::SIGKILL);
            }
            break;
        }
        thread::sleep(EXECUTION_TERMINATION_POLL_INTERVAL);
    }
    if !child_reaped {
        let _ = child.wait();
    }
    unregister_process_group(child.id());
}

#[cfg(not(unix))]
pub(crate) fn terminate_process_group(child: &mut std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
    unregister_process_group(child.id());
}

#[cfg(test)]
mod tests {
    #[test]
    fn finite_stdin_delivers_large_input_and_eof() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("input.jsonl");
        let bytes = vec![b'x'; 2 * 1024 * 1024];
        std::fs::write(&path, &bytes).unwrap();
        let mut request = super::ExecutionRequest::new("/usr/bin/wc");
        request.args = vec!["-c".into()];
        request.stdin_file = Some(path);
        let outcome =
            super::run_command(request, super::CancellationToken::default(), |_| {}).unwrap();
        assert_eq!(outcome.stdout.trim(), bytes.len().to_string());
        assert_eq!(
            outcome.termination,
            super::ExecutionTermination::Exited { code: Some(0) }
        );
    }

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
    fn scrubbed_run_hides_credentials_from_the_child_process() {
        // Proves the boundary end to end: the policy is not just a computed
        // list, the spawned process genuinely cannot read the secret.
        std::env::set_var("GYRO_TEST_SCRUB_VENDOR_API_KEY", "secret-value");
        std::env::set_var("GYRO_TEST_SCRUB_ALLOWED_API_KEY", "kept-value");
        std::env::set_var("GYRO_TEST_SCRUB_PLAIN", "plain-value");

        let mut request = ExecutionRequest::new("/bin/sh");
        request.args = vec![
            "-c".into(),
            "printf '%s|%s|%s' \"${GYRO_TEST_SCRUB_VENDOR_API_KEY:-absent}\" \
             \"${GYRO_TEST_SCRUB_ALLOWED_API_KEY:-absent}\" \
             \"${GYRO_TEST_SCRUB_PLAIN:-absent}\""
                .into(),
        ];
        request.credentials = CredentialPolicy::Scrubbed {
            allowed: ["GYRO_TEST_SCRUB_ALLOWED_API_KEY".to_string()]
                .into_iter()
                .collect(),
        };

        let outcome = run_command(request, CancellationToken::default(), |_| {}).unwrap();

        assert!(outcome.succeeded());
        assert_eq!(outcome.stdout, "absent|kept-value|plain-value");
    }

    #[test]
    fn explicit_env_override_wins_over_the_scrub() {
        // A caller passing a secret deliberately is making a decision; only
        // inheritance is treated as a leak.
        std::env::set_var("GYRO_TEST_OVERRIDE_API_KEY", "inherited");

        let mut request = ExecutionRequest::new("/bin/sh");
        request.args = vec![
            "-c".into(),
            "printf '%s' \"${GYRO_TEST_OVERRIDE_API_KEY:-absent}\"".into(),
        ];
        request.credentials = CredentialPolicy::scrubbed();
        request.env = vec![(
            "GYRO_TEST_OVERRIDE_API_KEY".into(),
            Some("passed-on-purpose".into()),
        )];

        let outcome = run_command(request, CancellationToken::default(), |_| {}).unwrap();

        assert!(outcome.succeeded());
        assert_eq!(outcome.stdout, "passed-on-purpose");
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
    fn output_budget_terminates_an_unbounded_output_process() {
        let mut request = ExecutionRequest::new("/bin/sh");
        request.args = vec![
            "-c".into(),
            "while :; do printf '0123456789abcdef'; done".into(),
        ];
        request.timeout = Duration::from_secs(5);
        request.max_stdout_chars = 16 * 1024;
        request.max_total_output_bytes = 1024;
        request.max_output_chunks = 1_000;
        let mut streamed_bytes = 0usize;

        let outcome = run_command(request, CancellationToken::default(), |chunk| {
            streamed_bytes = streamed_bytes.saturating_add(chunk.text.len());
        })
        .unwrap();

        assert_eq!(outcome.termination, ExecutionTermination::OutputLimit);
        assert!(outcome.stdout.len() <= 1024);
        assert!(streamed_bytes <= 1024);
        assert!(outcome.duration_ms < 2_000);
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

    #[cfg(unix)]
    #[test]
    fn completed_child_does_not_hang_on_descendant_held_pipes() {
        let mut request = ExecutionRequest::new("/bin/sh");
        request.args = vec![
            "-c".into(),
            "(trap '' TERM; exec sleep 30) & printf 'done'; exit 0".into(),
        ];
        request.timeout = Duration::from_secs(5);

        let outcome = run_command(request, CancellationToken::default(), |_| {}).unwrap();

        assert!(outcome.succeeded());
        assert_eq!(outcome.stdout, "done");
        assert!(outcome.duration_ms < 2_000);
    }

    #[cfg(unix)]
    #[test]
    fn completed_child_does_not_wait_on_pipes_held_by_an_escaped_descendant() {
        // The forked child leaves the process group (as setsid/daemonizing
        // tools do), so the exit-time group teardown cannot reach it, and it
        // keeps stdout/stderr open. The parent only exits once the child has
        // escaped, so the race cannot hide the bug.
        if !std::path::Path::new("/usr/bin/perl").exists() {
            return;
        }
        let mut request = ExecutionRequest::new("/usr/bin/perl");
        request.args = vec![
            "-e".into(),
            "pipe(my $r, my $w) or die; \
             my $pid = fork(); die unless defined $pid; \
             if ($pid) { close $w; <$r>; $| = 1; print \"escaped:$pid\\n\"; exit 0 } \
             close $r; setpgrp(0, 0); close $w; sleep 10;"
                .into(),
        ];
        request.timeout = Duration::from_secs(20);

        let started_at = Instant::now();
        let outcome = run_command(request, CancellationToken::default(), |_| {}).unwrap();
        let elapsed = started_at.elapsed();
        if let Some(pid) = outcome
            .stdout
            .trim()
            .strip_prefix("escaped:")
            .and_then(|pid| pid.parse::<i32>().ok())
        {
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
        }

        assert!(outcome.succeeded(), "{outcome:?}");
        assert!(outcome.stdout.starts_with("escaped:"), "{outcome:?}");
        assert!(
            elapsed < Duration::from_secs(3),
            "run_command waited {elapsed:?} on pipes held by an escaped descendant"
        );
    }

    #[cfg(unix)]
    #[test]
    fn panicking_output_callback_tears_down_the_process_group() {
        let mut request = ExecutionRequest::new("/bin/sh");
        request.args = vec![
            "-c".into(),
            "printf 'pid:%s\\n' \"$$\"; exec sleep 30".into(),
        ];
        request.timeout = Duration::from_secs(20);
        let seen_pid = Arc::new(Mutex::new(None::<i32>));
        let seen_pid_in_callback = seen_pid.clone();

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_command(request, CancellationToken::default(), move |chunk| {
                if let Some(pid) = chunk
                    .text
                    .trim()
                    .strip_prefix("pid:")
                    .and_then(|pid| pid.parse::<i32>().ok())
                {
                    *seen_pid_in_callback.lock().unwrap() = Some(pid);
                    panic!("provider output callback failed");
                }
            })
        }));

        assert!(result.is_err(), "the callback panic should propagate");
        let pid = seen_pid.lock().unwrap().expect("child reported its pid");
        assert!(
            !process_group_exists(pid),
            "the provider process group outlived the panicking run"
        );
        assert!(!live_process_groups().contains(&pid));
    }

    #[cfg(unix)]
    #[test]
    fn run_command_tracks_its_process_group_only_while_it_runs() {
        let mut request = ExecutionRequest::new("/bin/sh");
        request.args = vec!["-c".into(), "printf 'pid:%s\\n' \"$$\"; sleep 0.1".into()];
        let mut tracked_while_running = None;

        let outcome = run_command(request, CancellationToken::default(), |chunk| {
            if let Some(pid) = chunk
                .text
                .trim()
                .strip_prefix("pid:")
                .and_then(|pid| pid.parse::<i32>().ok())
            {
                tracked_while_running = Some((pid, live_process_groups().contains(&pid)));
            }
        })
        .unwrap();

        assert!(outcome.succeeded());
        let (pid, tracked) = tracked_while_running.expect("child reported its pid");
        assert!(tracked, "a running provider group should be registered");
        assert!(!live_process_groups().contains(&pid));
    }

    #[cfg(unix)]
    #[test]
    fn terminate_process_group_returns_as_soon_as_the_group_is_gone() {
        let mut command = Command::new("/bin/sleep");
        command.arg("30");
        configure_process_group(&mut command);
        let mut child = command.spawn().unwrap();
        register_process_group(child.id());

        let started_at = Instant::now();
        terminate_process_group(&mut child);
        let elapsed = started_at.elapsed();

        assert!(
            elapsed < Duration::from_millis(200),
            "terminating an already-dying group took {elapsed:?}"
        );
        assert!(!process_group_exists(child.id() as i32));
        assert!(!live_process_groups().contains(&(child.id() as i32)));
    }

    #[cfg(unix)]
    #[test]
    fn terminating_live_groups_escalates_from_sigterm_to_sigkill() {
        use std::io::{BufRead, BufReader};
        use std::os::unix::process::ExitStatusExt;

        let mut polite = Command::new("/bin/sleep");
        polite.arg("30");
        configure_process_group(&mut polite);
        let mut polite = polite.spawn().unwrap();

        let mut stubborn = Command::new("/bin/sh");
        stubborn
            .args(["-c", "trap '' TERM; echo ready; sleep 30"])
            .stdout(Stdio::piped());
        configure_process_group(&mut stubborn);
        let mut stubborn = stubborn.spawn().unwrap();
        let mut ready = String::new();
        BufReader::new(stubborn.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        assert_eq!(ready.trim(), "ready");

        register_process_group(polite.id());
        register_process_group(stubborn.id());
        let groups = [polite.id() as i32, stubborn.id() as i32];

        let started_at = Instant::now();
        terminate_process_groups(&groups, Duration::from_millis(300));
        assert!(started_at.elapsed() < Duration::from_secs(2));

        assert_eq!(polite.wait().unwrap().signal(), Some(libc::SIGTERM));
        assert_eq!(stubborn.wait().unwrap().signal(), Some(libc::SIGKILL));
        for group in groups {
            assert!(!live_process_groups().contains(&group));
            // The stubborn shell's grandchild is reaped by init, not by us.
            let deadline = Instant::now() + Duration::from_secs(2);
            while process_group_exists(group) && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(10));
            }
            assert!(!process_group_exists(group));
        }
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
