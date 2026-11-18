//! Recover rate limits, overloads and stale cursors around one provider turn.
//!
//! This is the host-agnostic retry loop. It owns *when* a turn may be retried
//! and how the acknowledged native cursor is checkpointed; the host owns how a
//! wait is shown (the `wait` callback) and how a single attempt runs
//! (`run_once`). Every retry respects the no-replay rule: once an attempt has
//! published output or dispatched tools, it may continue only inside a durable
//! native session, never by resending the original instruction.

use super::{
    api_config::provider_adapter_for,
    registry::runner_for,
    reliability::{
        is_rate_limit_error, is_transient_provider_error, CAPACITY_RETRY_EXHAUSTED,
        CONTINUATION_UNAVAILABLE, RETRY_EXHAUSTED,
    },
    runners::kimi_acp::{compatible_provider_session_binding, provider_resume_cursor_from_binding},
    support::{is_model_capacity_error, is_stale_resume_error, provider_activities_for_response},
    types::{ProviderChatRequest, ProviderResumeCursor, ProviderRunAttempt, ProviderRunnerOutput},
};
use crate::{provider_retry, ProviderSessionBinding, SessionEventKind, SessionStore};
use std::time::{Duration, Instant};
use uuid::Uuid;

/// Fallback wait when a provider reports capacity or a rate limit without
/// stating its own cooldown.
pub const CAPACITY_RETRY_DELAY: Duration = Duration::from_secs(30);

const CONTINUATION_PREFIX: &str =
    "The previous attempt was interrupted by a temporary provider failure.";

thread_local! {
    static RECOVERY_KIND: std::cell::RefCell<String> = std::cell::RefCell::new("network".into());
    static CYCLE: std::cell::RefCell<String> = const { std::cell::RefCell::new(String::new()) };
}

/// Records why the current thread is recovering ("network", "rate-limit",
/// "model-capacity") so hosts can label the wait they show.
pub fn set_kind(kind: &str) {
    RECOVERY_KIND.with(|value| *value.borrow_mut() = kind.into());
}

pub fn recovery_kind() -> String {
    RECOVERY_KIND.with(|kind| kind.borrow().clone())
}

/// The recovery cycle that groups every retry event of one user send.
pub fn cycle_id() -> String {
    CYCLE.with(|cycle| cycle.borrow().clone())
}

/// Opens a recovery cycle for this thread; nested starts reuse the outer one.
pub struct Cycle(String);
impl Cycle {
    pub fn start() -> Self {
        Self(CYCLE.with(|cycle| {
            if cycle.borrow().is_empty() {
                cycle.replace(Uuid::new_v4().to_string())
            } else {
                cycle.borrow().clone()
            }
        }))
    }
}
impl Drop for Cycle {
    fn drop(&mut self) {
        CYCLE.with(|cycle| {
            cycle.replace(std::mem::take(&mut self.0));
        });
    }
}

pub fn is_continuation(request: &ProviderChatRequest) -> bool {
    request.message.starts_with(CONTINUATION_PREFIX)
}

/// Whether `cursor` names a native conversation the provider itself keeps,
/// so a continuation can resume it without replaying completed work.
pub fn durable_native_cursor(
    request: &ProviderChatRequest,
    cursor: Option<&ProviderResumeCursor>,
) -> bool {
    cursor.is_some_and(|cursor| {
        !cursor.session_id.trim().is_empty()
            && matches!(
                (request.provider_id.as_str(), cursor.kind.as_str()),
                ("openai", "codex-session") | ("anthropic", "claude-session")
            )
    })
}

/// The original request stays unchanged in status events and saved responses.
pub fn continuation_request(request: &ProviderChatRequest) -> ProviderChatRequest {
    if is_continuation(request) {
        return request.clone();
    }
    let mut continuation = request.clone();
    continuation.message = format!(
        "The previous attempt was interrupted by a temporary provider failure. Continue the original task from the saved conversation and current workspace state. Review the prior tool results before acting. Preserve completed edits and do not repeat completed commands or external actions. Check any running command before starting another one. Complete and verify the remaining work. If the task never started, perform the original request.\n\nOriginal request:\n{}",
        request.message
    );
    continuation
}

pub fn manual_retry_request(
    request: &ProviderChatRequest,
    previous_status: Option<&str>,
    binding: Option<&ProviderSessionBinding>,
) -> ProviderChatRequest {
    let cursor = binding
        .filter(|binding| {
            request.session_id == binding.session_id.to_string()
                && compatible_provider_session_binding((*binding).clone(), request).is_some()
        })
        .and_then(provider_resume_cursor_from_binding);
    if previous_status == Some("failed") && durable_native_cursor(request, cursor.as_ref()) {
        continuation_request(request)
    } else {
        request.clone()
    }
}

pub fn can_resume_transient_after_work(
    request: &ProviderChatRequest,
    attempt: &ProviderRunAttempt,
    error: &str,
) -> bool {
    (is_model_capacity_error(error) || is_rate_limit_error(error))
        && durable_native_cursor(request, attempt.resume_cursor.as_ref())
}

/// Wait out a retry delay in short steps, returning the stop message if the
/// run is stopped meanwhile so a stopped turn never starts another attempt.
pub fn wait_before_retry(
    delay: Duration,
    stopped: &impl Fn() -> Option<String>,
) -> Result<(), String> {
    let deadline = Instant::now() + delay;
    loop {
        if let Some(message) = stopped() {
            return Err(message);
        }
        let now = Instant::now();
        if now >= deadline {
            return Ok(());
        }
        std::thread::sleep((deadline - now).min(Duration::from_millis(50)));
    }
}

/// Checkpoints the attempt's acknowledged cursor as a failed binding.
pub fn persist_failed_attempt(
    store: &SessionStore,
    request: &ProviderChatRequest,
    binding: Option<&ProviderSessionBinding>,
    attempt: &ProviderRunAttempt,
    error: &anyhow::Error,
) {
    let last_error = Some(crate::security::redact_secrets(&error.to_string()));
    match binding {
        Some(binding) => {
            let _ = store.upsert_provider_session_binding(
                binding.session_id,
                binding.provider_id.clone(),
                binding.model_id.clone(),
                binding.model_label.clone(),
                binding.reasoning_effort.clone(),
                attempt
                    .resume_cursor
                    .as_ref()
                    .and_then(|cursor| serde_json::to_value(cursor).ok())
                    .unwrap_or_else(|| binding.resume_cursor_json.clone()),
                "failed",
                last_error,
            );
        }
        // A session's first turn has no binding to carry forward, so the cursor
        // this run created is the only record that the provider conversation
        // exists. Dropping it is what made a stopped first turn restart from
        // nothing on every retry.
        None => {
            let cursor_json = attempt
                .resume_cursor
                .as_ref()
                .and_then(|cursor| serde_json::to_value(cursor).ok());
            if let (Some(cursor_json), Ok(session_id)) =
                (cursor_json, Uuid::parse_str(&request.session_id))
            {
                let _ = store.upsert_provider_session_binding(
                    session_id,
                    request.provider_id.clone(),
                    request.model_id.clone(),
                    request.model_label.clone(),
                    request.reasoning_effort.clone(),
                    cursor_json,
                    "failed",
                    last_error,
                );
            }
        }
    }
}

fn session_uuid(request: &ProviderChatRequest) -> anyhow::Result<Uuid> {
    Uuid::parse_str(&request.session_id).map_err(|error| anyhow::Error::msg(error.to_string()))
}

/// Whether this imported chat must keep its original native conversation.
pub fn import_requires_native_session(
    store: &SessionStore,
    request: &ProviderChatRequest,
) -> anyhow::Result<bool> {
    let id = session_uuid(request)?;
    Ok(store
        .get_session(id)?
        .and_then(|session| session.import_source)
        .is_some_and(|source| !source.fresh_session_requested))
}

/// Refuses a send to an imported chat whose folder or native session is gone.
pub fn check_import_continuation(
    store: &SessionStore,
    request: &ProviderChatRequest,
    cursor: Option<&ProviderResumeCursor>,
) -> anyhow::Result<()> {
    let id = session_uuid(request)?;
    let Some(session) = store.get_session(id)? else {
        return Ok(());
    };
    let Some(source) = session.import_source else {
        return Ok(());
    };
    if !session.workspace_path.is_dir() {
        anyhow::bail!("Locate this imported project's folder before sending a message.");
    }
    if !source.fresh_session_requested && cursor.is_none() {
        return import_resume_unavailable(store, request, "The original provider session is unavailable for the selected model. Retry with its original model, or choose Continue in a new session.");
    }
    Ok(())
}

/// Marks an imported chat's native session unavailable and fails the send.
pub fn import_resume_unavailable(
    store: &SessionStore,
    request: &ProviderChatRequest,
    detail: &str,
) -> anyhow::Result<()> {
    let id = session_uuid(request)?;
    if let Some(source) = store
        .get_session(id)?
        .and_then(|session| session.import_source)
    {
        if let Some(binding) =
            store.get_provider_session_binding(id, source.source_kind.provider_id())?
        {
            store.upsert_provider_session_binding(
                id,
                binding.provider_id,
                binding.model_id,
                binding.model_label,
                binding.reasoning_effort,
                binding.resume_cursor_json,
                "import-resume-unavailable",
                Some(detail.to_owned()),
            )?;
        }
    }
    store.append_event(
        id,
        SessionEventKind::SystemEvent,
        detail,
        serde_json::json!({
            "kind": "import-resume-unavailable", "detail": detail,
        }),
    )?;
    anyhow::bail!("{detail}")
}

/// Runs one turn with the default wait: sleep in short steps until stopped.
pub fn run_with_retry<F>(
    store: &SessionStore,
    request: &ProviderChatRequest,
    binding: Option<ProviderSessionBinding>,
    run_once: F,
    stopped: impl Fn() -> Option<String>,
) -> anyhow::Result<ProviderRunnerOutput>
where
    F: FnMut(
        Option<&ProviderResumeCursor>,
        &mut ProviderRunAttempt,
    ) -> anyhow::Result<ProviderRunnerOutput>,
{
    run_with_retry_and_wait(
        store,
        request,
        binding,
        run_once,
        &stopped,
        |delay, _, _, _| wait_before_retry(delay, &stopped),
    )
}

/// Runs one turn, retrying transient failures through the shared ladder.
///
/// `wait(delay, retries_used, max_retries, capacity)` is called before every
/// retry; returning `Err(stop)` abandons the turn with that stop message.
pub fn run_with_retry_and_wait<F>(
    store: &SessionStore,
    request: &ProviderChatRequest,
    binding: Option<ProviderSessionBinding>,
    mut run_once: F,
    stopped: impl Fn() -> Option<String>,
    mut wait: impl FnMut(Duration, u32, u32, bool) -> Result<(), String>,
) -> anyhow::Result<ProviderRunnerOutput>
where
    F: FnMut(
        Option<&ProviderResumeCursor>,
        &mut ProviderRunAttempt,
    ) -> anyhow::Result<ProviderRunnerOutput>,
{
    let _budget = provider_retry::RetryScope::start();
    let _cycle = Cycle::start();
    let retries_at_start = provider_retry::retries_used();
    let binding_cursor = binding
        .as_ref()
        .and_then(provider_resume_cursor_from_binding);
    // A manual resend can arrive after the previous worker has gone away.
    // Saved tool receipts still prohibit replay when its cursor was lost.
    let saved_events = Uuid::parse_str(&request.session_id)
        .ok()
        .and_then(|session| store.read_events(session).ok())
        .unwrap_or_default();
    let saved_failure = saved_events.iter().any(|event| {
        event.turn_id.map(|id| id.to_string()).as_deref() == request.turn_id.as_deref()
            && event
                .payload
                .get("kind")
                .and_then(serde_json::Value::as_str)
                == Some("provider-status")
            && event
                .payload
                .get("status")
                .and_then(serde_json::Value::as_str)
                == Some("failed")
    });
    let saved_work = saved_failure
        && saved_events.iter().any(|event| {
            event.turn_id.map(|id| id.to_string()).as_deref() == request.turn_id.as_deref()
                && event
                    .payload
                    .get("schema")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|schema| {
                        matches!(schema, "gyro.capability.v1" | "gyro.mutation.v1")
                    })
        });
    if (saved_work || is_continuation(request))
        && !durable_native_cursor(request, binding_cursor.as_ref())
    {
        anyhow::bail!(CONTINUATION_UNAVAILABLE);
    }
    check_import_continuation(store, request, binding_cursor.as_ref())?;
    if let Some(stop) = stopped() {
        anyhow::bail!(stop);
    }
    let mut attempt = ProviderRunAttempt {
        resume_cursor: binding_cursor.clone(),
        continuing_work: is_continuation(request) || saved_work,
        ..Default::default()
    };
    match run_once(binding_cursor.as_ref(), &mut attempt) {
        // The adapter may have recovered from a stale cursor internally.
        // Its actual session outcome governs continuity and accounting.
        Ok(output) => Ok(output),
        Err(error)
            if is_stale_resume_error(&format!("{error:#}"))
                && (attempt.published_output || attempt.continuing_work) =>
        {
            let error = error.context(CONTINUATION_UNAVAILABLE);
            persist_failed_attempt(store, request, binding.as_ref(), &attempt, &error);
            Err(error)
        }
        Err(error)
            if import_requires_native_session(store, request)?
                && is_stale_resume_error(&format!("{error:#}")) =>
        {
            import_resume_unavailable(store, request,
                "The original provider session could not be resumed. Retry, or choose Continue in a new session to use the imported history.")?;
            Err(error)
        }
        // A dead provider cursor is not a user-visible failure: clear it and
        // immediately retry once without resume. Local history is injected by
        // the runners when resume is absent, so continuity stays in Gyro.
        Err(error)
            if binding.is_some()
                && !attempt.published_output
                && !attempt.continuing_work
                && provider_retry::take_retry()
                && stopped().is_none()
                && is_stale_resume_error(&format!("{error:#}")) =>
        {
            let session_id = session_uuid(request)?;
            let _ = store.clear_provider_session_binding(session_id, &request.provider_id);
            let mut fresh_attempt = ProviderRunAttempt::default();
            match run_once(None, &mut fresh_attempt) {
                Ok(mut output) => {
                    output.resumed = false;
                    output.retry_count = output.retry_count.saturating_add(1);
                    Ok(output)
                }
                Err(retry_error) => {
                    persist_failed_attempt(store, request, None, &fresh_attempt, &retry_error);
                    Err(retry_error.context(
                        "the stale provider cursor was cleared and a fresh attempt also failed",
                    ))
                }
            }
        }
        // Brief network blips should not surface as "xAI send needs attention"
        // when a short backoff retry succeeds.
        Err(error)
            if is_transient_provider_error(&format!("{error:#}"))
                && (!attempt.published_output
                    || can_resume_transient_after_work(
                        request,
                        &attempt,
                        &format!("{error:#}"),
                    ))
                && !runner_for(provider_adapter_for(&request.provider_id).kind)
                    .handles_transient_retries() =>
        {
            let mut last_error = error;
            let mut last_attempt = attempt;
            let mut recovered_activities = Vec::new();
            // The same ladder the HTTPS runners use, so a rate-limited CLI and a
            // rate-limited endpoint wait alike.
            let retry_ladder = provider_retry::transient_retry_delays();
            for retry_index in 0..retry_ladder.len() {
                // A provider that states its own cooldown outranks our backoff:
                // the HTTPS runners read `Retry-After`, and a CLI reports the
                // same instruction as text.
                let capacity = is_model_capacity_error(&format!("{last_error:#}"));
                let rate_limit = is_rate_limit_error(&format!("{last_error:#}"));
                set_kind(if capacity {
                    "model-capacity"
                } else if rate_limit {
                    "rate-limit"
                } else {
                    "network"
                });
                let fallback = if capacity || rate_limit {
                    CAPACITY_RETRY_DELAY
                } else {
                    provider_retry::transient_retry_delay(retry_index)
                        .unwrap_or(retry_ladder[retry_index])
                };
                if rate_limit {
                    crate::provider_cooldown::observe_error(
                        &format!("{last_error:#}"),
                        provider_retry::provider_cooldown_hint(&format!("{last_error:#}"))
                            .unwrap_or(fallback),
                    );
                }
                let Some(delay) =
                    provider_retry::retry_delay_with_hint(&format!("{last_error:#}"), fallback)
                else {
                    break;
                };
                if !provider_retry::take_retry() {
                    break;
                }
                if let Some(stop) = stopped() {
                    let stop = last_error.context(stop);
                    persist_failed_attempt(store, request, binding.as_ref(), &last_attempt, &stop);
                    return Err(stop);
                }
                // Checkpoint the acknowledged cursor before the wait as well
                // as on terminal failure, so a restart cannot erase it.
                persist_failed_attempt(
                    store,
                    request,
                    binding.as_ref(),
                    &last_attempt,
                    &last_error,
                );
                if let Err(stop) = wait(
                    delay,
                    provider_retry::retries_used(),
                    retry_ladder.len() as u32,
                    capacity,
                ) {
                    let stop = last_error.context(stop);
                    persist_failed_attempt(store, request, binding.as_ref(), &last_attempt, &stop);
                    return Err(stop);
                }
                if let Some(stop) = stopped() {
                    let stop = last_error.context(stop);
                    persist_failed_attempt(store, request, binding.as_ref(), &last_attempt, &stop);
                    return Err(stop);
                }
                let cursor = last_attempt
                    .resume_cursor
                    .clone()
                    .or_else(|| binding_cursor.clone());
                let continuing_work = last_attempt.continuing_work || last_attempt.published_output;
                recovered_activities.append(&mut last_attempt.activities);
                last_attempt = ProviderRunAttempt {
                    resume_cursor: cursor.clone(),
                    tools_dispatched: last_attempt.tools_dispatched,
                    mutations_completed: last_attempt.mutations_completed,
                    published_output: false,
                    continuing_work,
                    activities: Vec::new(),
                };
                let outcome = run_once(cursor.as_ref(), &mut last_attempt);
                // A failed startup may emit no session ID and clear the
                // adapter's cursor. Keep the last acknowledged conversation
                // for continuations; losing it must never replay saved work
                // in a fresh native session on the following retry.
                if outcome.is_err() && continuing_work && last_attempt.resume_cursor.is_none() {
                    last_attempt.resume_cursor = cursor;
                }
                match outcome {
                    Ok(mut output) => {
                        recovered_activities.append(&mut output.activities);
                        output.activities = provider_activities_for_response(
                            recovered_activities,
                            &output.response,
                        );
                        output.retry_count =
                            provider_retry::retries_used().saturating_sub(retries_at_start);
                        return Ok(output);
                    }
                    Err(retry_error)
                        if is_transient_provider_error(&format!("{retry_error:#}"))
                            && (!last_attempt.published_output
                                || can_resume_transient_after_work(
                                    request,
                                    &last_attempt,
                                    &format!("{retry_error:#}"),
                                ))
                            && retry_index + 1 < retry_ladder.len() =>
                    {
                        last_error = retry_error;
                    }
                    Err(retry_error) => {
                        let retry_error = if is_stale_resume_error(&format!("{retry_error:#}"))
                            && continuing_work
                        {
                            retry_error.context(CONTINUATION_UNAVAILABLE)
                        } else if retry_index + 1 == retry_ladder.len()
                            && is_model_capacity_error(&format!("{retry_error:#}"))
                        {
                            retry_error.context(CAPACITY_RETRY_EXHAUSTED)
                        } else if is_transient_provider_error(&format!("{retry_error:#}"))
                            && retry_index + 1 == retry_ladder.len()
                        {
                            retry_error.context(RETRY_EXHAUSTED)
                        } else {
                            retry_error
                        };
                        persist_failed_attempt(
                            store,
                            request,
                            binding.as_ref(),
                            &last_attempt,
                            &retry_error,
                        );
                        return Err(retry_error);
                    }
                }
            }
            if provider_retry::retries_used() >= 3 {
                last_error = last_error.context(RETRY_EXHAUSTED);
            }
            persist_failed_attempt(store, request, binding.as_ref(), &last_attempt, &last_error);
            Err(last_error)
        }
        Err(error) => {
            let error = if (attempt.published_output || attempt.continuing_work)
                && is_transient_provider_error(&format!("{error:#}"))
                && !durable_native_cursor(request, attempt.resume_cursor.as_ref())
            {
                error.context(CONTINUATION_UNAVAILABLE)
            } else {
                error
            };
            persist_failed_attempt(store, request, binding.as_ref(), &attempt, &error);
            Err(error)
        }
    }
}
