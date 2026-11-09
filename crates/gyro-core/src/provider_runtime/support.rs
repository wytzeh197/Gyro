//! Pure request validation and provider output normalization.
use super::{
    limits::{PROVIDER_STALL_MARKER, PROVIDER_STOP_MARKER},
    types::{ChatAttachmentRequest, ProviderContextUsage},
};
use super::{
    text::{sanitize_provider_chat_response, truncate_error_detail},
    types::{ProviderActivity, StreamingCommandOutput},
};
use crate::{GyroConfig, GyroPaths, WORKSPACE_UNAVAILABLE_MESSAGE};
use base64::Engine;
use serde_json::Value;
#[cfg(unix)]
use std::time::Duration;
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    process::{Child, Command},
};
pub fn provider_output_summary(
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
    crate::sanitize_harness_text(&format!(
        "{runner} exited with {status_label}; {response_chars} response chars; {session_state}"
    ))
}

/// The part of one output line that could be the CLI reporting an error.
///
/// Plain text is taken as written. A JSON frame contributes only its error
/// message, and only when it carries one — a transcript frame has no business
/// being tested for a dead cursor just because it names the session it belongs
/// to.
pub fn provider_error_sentence(line: &str) -> Option<String> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    if !line.starts_with('{') {
        return Some(line.to_string());
    }
    let frame = serde_json::from_str::<serde_json::Value>(line).ok()?;
    let error = frame.get("error")?;
    if let Some(message) = error.as_str() {
        return Some(message.to_string());
    }
    error
        .get("message")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

/// The reportable failure from a stream-json run's output.
///
/// Both supported CLIs print a JSON transcript on stdout and their own
/// diagnostics on stderr, so concatenating the two and truncating stored the
/// first few thousand characters of the conversation as the reason the
/// conversation failed. That is unreadable in the timeline, and it is worse
/// than unreadable to the classifiers: `provider_failure_recovery` and
/// `is_stale_resume_error` both match keywords, and a long enough transcript
/// contains every keyword either of them looks for.
///
/// The CLI's own diagnostics come first, then error frames from the stream, and
/// only then the transcript — by which point it is the only thing left to say.
pub fn provider_stream_failure_detail(stdout: &str, stderr: &str) -> String {
    let stderr = stderr.trim();
    if !stderr.is_empty() {
        return truncate_error_detail(stderr);
    }
    let frame_errors = stdout
        .lines()
        .filter_map(provider_error_sentence)
        .filter(|sentence| !sentence.trim().is_empty())
        .collect::<Vec<_>>();
    if !frame_errors.is_empty() {
        return truncate_error_detail(&frame_errors.join("\n"));
    }
    truncate_error_detail(stdout.trim())
}
pub fn provider_chat_cwd(workspace_path: Option<&str>) -> anyhow::Result<PathBuf> {
    if let Some(path) = workspace_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        let path = PathBuf::from(path);
        if path.is_dir() {
            return Ok(path.canonicalize()?);
        }
        anyhow::bail!("{WORKSPACE_UNAVAILABLE_MESSAGE}");
    }
    if let Some(home) = std::env::var_os("HOME") {
        return Ok(PathBuf::from(home));
    }
    std::env::current_dir().map_err(Into::into)
}

/// Check a provider argument vector against its CLI contract before spawning.
///
/// A violation is a Gyro bug rather than a provider outage, so the run stops
/// here with a message that says so. Letting the vector through instead makes
/// the CLI report a downstream symptom — most memorably a missing prompt — that
/// reads like a transient failure and invites an endless retry.
pub fn audit_provider_chat_args(provider_id: &str, args: &[String]) -> anyhow::Result<()> {
    let Some(contract) = crate::provider_cli_contract(provider_id) else {
        return Ok(());
    };
    crate::audit_provider_args(contract, args)
        .map_err(|violation| anyhow::anyhow!("{}", violation.message(provider_id)))
}
pub fn provider_activities_for_response(
    activities: Vec<ProviderActivity>,
    response: &str,
) -> Vec<ProviderActivity> {
    let response = response.trim();
    // Providers stream many intermediate statuses for the same activity id
    // (ACP tool_call → tool_call_update, Claude stream progress, …). Keeping
    // every frame left the durable rail full of "running" ghosts after a turn
    // settled — across Grok, Claude, and Codex. Collapse to the latest state
    // per id in arrival order, then force any still-open work closed: once the
    // provider has answered, nothing is still running.
    let mut order = Vec::<String>::new();
    let mut by_id = HashMap::<String, ProviderActivity>::new();
    for activity in activities {
        if activity.kind == "commentary" && activity.label.trim() == response {
            continue;
        }
        if !by_id.contains_key(&activity.id) {
            order.push(activity.id.clone());
        }
        by_id.insert(activity.id.clone(), activity);
    }
    order
        .into_iter()
        .filter_map(|id| by_id.remove(&id))
        .map(|mut activity| {
            if activity.status == "running" || activity.status == "queued" {
                activity.status = "done".into();
            }
            activity
        })
        .collect()
}

/// A non-zero CLI exit that still produced a real streamed answer.
///
/// Several provider CLIs exit non-zero after tool errors the model already
/// recovered from, or after writing a full answer. Treating those as total
/// failure tore down a finished chat and left the desktop in "failed" while the
/// user already had the reply. Cancel, timeout, and empty streams still fail.
pub fn recover_streamed_provider_answer(
    output: &StreamingCommandOutput,
    last_message: &str,
) -> Option<String> {
    if output.status_success {
        return None;
    }
    let candidates = [
        output.assistant_text.as_deref().unwrap_or(""),
        last_message,
        // Raw stdout only when the CLI did not speak stream-json; a JSON dump is
        // not an answer the user should see as a completed chat.
        if output.parsed_stream_json {
            ""
        } else {
            output.stdout.as_str()
        },
    ];
    candidates.into_iter().find_map(|candidate| {
        let response = sanitize_provider_chat_response(candidate.trim());
        (!response.is_empty()).then_some(response)
    })
}

/// Wrap a run failure with the provider's sign-in hint, unless it was a stop.
///
/// The hint earns its place on a run that died on its own, where a lapsed CLI
/// login is the usual cause. On a stop it is noise: being told to sign in again
/// because the turn was stopped buries the one line that says what happened.
pub fn provider_run_failure(error: anyhow::Error, hint: &str) -> anyhow::Error {
    let message = error.to_string();
    if message.contains(PROVIDER_STOP_MARKER) || message.contains(PROVIDER_STALL_MARKER) {
        return error;
    }
    anyhow::anyhow!("{hint} {error}")
}
pub fn is_model_capacity_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    (normalized.contains("model is at capacity")
        || normalized.contains("model at capacity")
        || normalized.contains("model is temporarily at capacity")
        || normalized.contains("overloaded_error")
        || normalized.contains("model is overloaded"))
        && ![
            "size limit",
            "tool-call limit",
            "output exceeded",
            "http 401",
            "http 403",
            "unauthorized",
            "authentication",
            "insufficient_quota",
            "http 402",
            "status 402",
            "payment required",
            "balance exhausted",
        ]
        .iter()
        .any(|cause| normalized.contains(cause))
}
pub fn claude_multimodal_input(
    prompt: &str,
    attachments: &[ChatAttachmentRequest],
) -> anyhow::Result<serde_json::Value> {
    let mut content = vec![serde_json::json!({"type": "text", "text": prompt})];
    for attachment in attachments.iter().filter(|item| item.kind == "image") {
        let bytes = std::fs::read(&attachment.path)?;
        content.push(serde_json::json!({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": attachment.mime_type.as_deref().unwrap_or("image/png"),
                "data": base64::engine::general_purpose::STANDARD.encode(bytes),
            }
        }));
    }
    Ok(serde_json::json!({"type": "user", "message": {"role": "user", "content": content}}))
}
pub fn load_config_blocking() -> Result<GyroConfig, String> {
    let paths = GyroPaths::for_current_user().map_err(|error| error.to_string())?;
    GyroConfig::load(&paths).map_err(|error| error.to_string())
}

pub fn provider_billed_usage_from_acp_tokens(
    tokens: crate::usage::UsageTokens,
) -> Option<ProviderContextUsage> {
    let accounting = tokens.effective_accounting();
    if !accounting.known.input {
        return None;
    }
    Some(ProviderContextUsage {
        input_tokens: Some(tokens.input_tokens),
        cached_input_tokens: accounting
            .known
            .cache_read
            .then_some(tokens.cached_input_tokens),
        output_tokens: accounting.known.output.then_some(tokens.output_tokens),
        reasoning_output_tokens: accounting
            .known
            .reasoning
            .then_some(tokens.reasoning_output_tokens),
        total_tokens: Some(tokens.total_tokens),
        model_context_window: None,
        ..ProviderContextUsage::default()
    })
}
pub fn sanitize_provider_approval_details(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::String(value) => {
            serde_json::Value::String(crate::security::redact_secrets(&value))
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

pub struct ProviderProcessGuard {
    pub child: crate::process_guard::GuardedChild,
}

impl ProviderProcessGuard {
    /// Registered so quitting Gyro tears the group down: it runs in its own
    /// process group and gets no SIGHUP from the app exiting.
    pub fn new(child: crate::process_guard::GuardedChild) -> Self {
        crate::register_process_group(child.id());
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
        crate::unregister_process_group(self.child.id());
    }
}

#[cfg(unix)]
pub fn configure_provider_process_group(command: &mut Command) {
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
pub fn configure_provider_process_group(_command: &mut Command) {}

#[cfg(unix)]
pub fn terminate_provider_process_group(child: &mut Child) {
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
pub fn terminate_provider_process_group(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}
/// Deletes a temporary file when dropped.
pub struct TempFileGuard(pub PathBuf);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub fn image_generation_activity(
    item: &Value,
    label: &str,
    status: &str,
    note: Option<String>,
) -> ProviderActivity {
    ProviderActivity {
        id: item
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("image-generation")
            .into(),
        kind: "tool".into(),
        label: label.into(),
        detail: Some("image_generation".into()),
        note,
        file_counts: None,
        status: status.into(),
    }
}

pub fn generated_image_event_matches(
    params: &serde_json::Value,
    thread: &str,
    turn: Option<&str>,
) -> bool {
    params.get("threadId").and_then(serde_json::Value::as_str) == Some(thread)
        && turn.is_some_and(|turn| {
            params.get("turnId").and_then(serde_json::Value::as_str) == Some(turn)
        })
}

pub fn protocol_item(item: &serde_json::Value, status: &str) {
    let status = if status == "done"
        && (item.get("error").is_some_and(|value| !value.is_null())
            || item.get("status").and_then(serde_json::Value::as_str) == Some("failed")
            || item
                .get("exitCode")
                .and_then(serde_json::Value::as_i64)
                .is_some_and(|code| code != 0))
    {
        "failed"
    } else {
        status
    };
    if let (Some(id), Some(kind)) = (
        item.get("id").and_then(serde_json::Value::as_str),
        item.get("type").and_then(serde_json::Value::as_str),
    ) {
        crate::timing::protocol_item(id, kind, status);
    }
}
pub fn codex_context_compaction_activity(
    params: &serde_json::Value,
    status: &str,
) -> ProviderActivity {
    let identity = params
        .get("turnId")
        .or_else(|| params.pointer("/item/id"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("turn");
    ProviderActivity {
        id: format!("context-compaction-{identity}"),
        kind: "context".into(),
        label: if status == "running" {
            "Compacting context".into()
        } else {
            "Compacted context".into()
        },
        detail: Some(
            "Summarized earlier conversation to keep the thread within the model context window."
                .into(),
        ),
        file_counts: None,
        note: None,
        status: status.into(),
    }
}

pub fn efficiency_config() -> crate::efficiency::Config {
    load_config_blocking()
        .map(|c| c.efficiency)
        .unwrap_or_default()
}

/// Whether an error means the stored provider cursor is dead.
///
/// A true stale-resume error is one short sentence from the CLI. A failed
/// stream-json run, however, arrives here as its entire transcript: every frame
/// carries a session id, which is one half of the test below, and any tool that
/// touched a missing path contributes "no such file", which is the other. Read
/// together across thousands of unrelated characters they looked exactly like a
/// dead cursor, so an ordinary failure cleared the binding and the conversation
/// it pointed at could no longer be resumed.
///
/// Classifying sentence by sentence is what keeps the two halves from meeting.
pub fn is_stale_resume_error(error: &str) -> bool {
    error
        .lines()
        .filter_map(provider_error_sentence)
        .any(|sentence| is_stale_resume_sentence(&sentence))
}

pub fn is_stale_resume_sentence(sentence: &str) -> bool {
    // Long enough for any CLI's error sentence, short enough that a pasted
    // transcript or a file dump cannot qualify as one.
    const MAX_RESUME_ERROR_SENTENCE_CHARS: usize = 400;
    if sentence.chars().count() > MAX_RESUME_ERROR_SENTENCE_CHARS {
        return false;
    }
    let normalized = sentence.to_ascii_lowercase();
    // Grok ACP returns bare "Method not found" when session/resume is not
    // implemented — treat that as a dead cursor so Retry starts clean.
    if normalized.contains("method not found")
        || normalized.contains("method_not_found")
        || normalized.contains("-32601")
    {
        return true;
    }
    let resume_identity = normalized.contains("resume")
        || normalized.contains("session")
        || normalized.contains("thread");
    let missing_identity = normalized.contains("not found")
        || normalized.contains("no such")
        || normalized.contains("unknown")
        || normalized.contains("missing")
        || normalized.contains("expired")
        || normalized.contains("could not resume")
        // Claude Code's own wording for a session id it cannot load: "No
        // conversation found with session ID: <id>". It reads as a match for
        // "found" rather than "not found", so without this the cursor was
        // never cleared and every retry failed the same way.
        || normalized.contains("no conversation");
    resume_identity && missing_identity
}
