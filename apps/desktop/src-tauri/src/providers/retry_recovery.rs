//! Recover rate limits and overloads inside an acknowledged native conversation.

use crate::{
    app::{config::load_config_blocking, limits::PROVIDER_CHAT_EVENT},
    project_import_continuation, provider_reliability,
    provider_reliability::is_transient_provider_error,
    provider_timeline,
    providers::{
        chat_types::ProviderChatRequest,
        events::next_provider_event_sequence,
        process::{is_stale_resume_error, provider_adapter_for},
        retry::{persist_failed_provider_attempt, wait_before_provider_retry},
        retry_recovery as provider_retry_recovery,
        runner::runner_for,
        runners::kimi_acp::{
            compatible_provider_session_binding, provider_resume_cursor_from_binding,
        },
        stdout::provider_activities_for_response,
        streaming::{provider_chat_cancelled, provider_stop_message},
        types::{ProviderResumeCursor, ProviderRunAttempt, ProviderRunnerOutput},
    },
    stores::{open_store, parse_uuid},
};
use gyro_core::{ProviderSessionBinding, SessionEventKind, SessionStore};
use std::time::Duration;
use tauri::Emitter;
use uuid::Uuid;
pub(crate) const CAPACITY_RETRY_DELAY: Duration = Duration::from_secs(30);
thread_local! {
    static RECOVERY_KIND: std::cell::RefCell<String> = std::cell::RefCell::new("network".into());
    static CYCLE: std::cell::RefCell<String> = const { std::cell::RefCell::new(String::new()) };
}

pub(crate) fn set_kind(kind: &str) {
    RECOVERY_KIND.with(|value| *value.borrow_mut() = kind.into());
}

pub(crate) struct Cycle(String);
impl Cycle {
    pub(crate) fn start() -> Self {
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

pub(crate) fn wait_for_shared_cooldown(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
) -> anyhow::Result<()> {
    let waited = std::cell::Cell::new(false);
    gyro_core::provider_cooldown::wait(
        || {
            provider_chat_cancelled(app, &request.session_id)
                .then(|| provider_stop_message(app, &request.session_id))
        },
        |delay| {
            waited.set(true);
            set_kind("rate-limit");
            emit_wait(
                app,
                request,
                delay,
                gyro_core::provider_retry::retries_used(),
                3,
            );
        },
    )
    .map_err(anyhow::Error::msg)?;
    if waited.get() {
        emit_started(app, request, gyro_core::provider_retry::retries_used(), 3);
    }
    Ok(())
}

pub(crate) fn cooldown_scope(store: &SessionStore, request: &ProviderChatRequest) -> String {
    // Configured endpoints and imported native login homes identify separate
    // profiles without reading or persisting the credential itself.
    use sha2::{Digest, Sha256};
    let endpoint = load_config_blocking().ok().and_then(|config| {
        config
            .model_providers
            .into_iter()
            .find(|provider| provider.id == request.provider_id)
            .and_then(|provider| provider.base_url)
    });
    let profile = Uuid::parse_str(&request.session_id)
        .ok()
        .and_then(|id| store.get_session(id).ok().flatten())
        .and_then(|session| session.import_source)
        .filter(|source| source.source_kind.provider_id() == request.provider_id)
        .map(|source| source.data_home)
        .unwrap_or_default();
    let namespace = serde_json::json!([request.provider_id, endpoint, request.model_id]);
    format!(
        "{:x}/{:x}",
        Sha256::digest(namespace.to_string().as_bytes()),
        Sha256::digest(profile.as_bytes())
    )
}
const CONTINUATION_PREFIX: &str =
    "The previous attempt was interrupted by a temporary provider failure.";

pub(crate) fn is_continuation(request: &ProviderChatRequest) -> bool {
    request.message.starts_with(CONTINUATION_PREFIX)
}

pub(crate) fn durable_native_cursor(
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
pub(crate) fn continuation_request(request: &ProviderChatRequest) -> ProviderChatRequest {
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

pub(crate) fn manual_retry_request(
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

pub(crate) fn can_resume_transient_after_work(
    request: &ProviderChatRequest,
    attempt: &ProviderRunAttempt,
    error: &str,
) -> bool {
    (provider_reliability::is_model_capacity_error(error)
        || provider_reliability::is_rate_limit_error(error))
        && durable_native_cursor(request, attempt.resume_cursor.as_ref())
}

pub(crate) fn emit_wait(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    delay: Duration,
    retry_attempt: u32,
    max_attempts: u32,
) {
    let retry_at = chrono::Utc::now() + chrono::Duration::from_std(delay).unwrap_or_default();
    emit_retry_event(
        app,
        request,
        "retry-wait",
        "waiting",
        retry_attempt,
        max_attempts,
        Some(retry_at),
    );
}

pub(crate) fn emit_started(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    retry_attempt: u32,
    max_attempts: u32,
) {
    emit_retry_event(
        app,
        request,
        "retry-started",
        "running",
        retry_attempt,
        max_attempts,
        None,
    );
}

fn emit_retry_event(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    phase: &str,
    status: &str,
    retry_attempt: u32,
    max_attempts: u32,
    retry_at: Option<chrono::DateTime<chrono::Utc>>,
) {
    if crate::context_compaction::summary_stream_muted(&request.session_id) {
        return;
    }
    let mut payload = serde_json::json!({
        "sessionId": request.session_id,
        "turnId": request.turn_id,
        "providerId": request.provider_id,
        "modelId": request.model_id,
        "eventId": Uuid::new_v4().to_string(),
        "sequence": next_provider_event_sequence(app, &request.session_id),
        "phase": phase,
        "status": status,
        "recoveryKind": RECOVERY_KIND.with(|kind| kind.borrow().clone()),
        "recovery": {
            "cycleId": CYCLE.with(|cycle| cycle.borrow().clone()),
            "state": if phase == "retry-wait" { "waiting" } else { "retrying" },
            "attemptsUsed": retry_attempt,
            "maxRetries": max_attempts,
            "retryAt": retry_at.map(|at| at.to_rfc3339()),
        },
        "retryAt": retry_at.map(|at| at.to_rfc3339()),
        "retryAttempt": retry_attempt,
        "retryMaxAttempts": max_attempts,
        "message": if phase == "retry-wait" {
            "Waiting for the provider to continue"
        } else {
            "Continuing the saved work"
        },
    });
    provider_timeline::observe(app, &request.session_id, None, None).insert_into(&mut payload);
    if let (Ok(store), Ok(session), Some(turn)) = (
        open_store(),
        Uuid::parse_str(&request.session_id),
        request
            .turn_id
            .as_deref()
            .and_then(|id| Uuid::parse_str(id).ok()),
    ) {
        let continuation = store
            .get_provider_session_binding(session, &request.provider_id)
            .ok()
            .flatten()
            .and_then(|binding| provider_resume_cursor_from_binding(&binding))
            .is_some_and(|cursor| durable_native_cursor(request, Some(&cursor)));
        payload["recovery"]["continuationAvailable"] = serde_json::json!(continuation);
        let mut stored = payload.clone();
        stored["kind"] = serde_json::json!("provider-status");
        stored["nativeRetry"] = serde_json::json!(phase == "retry-wait");
        let _ = store.append_event_with_turn_id(
            session,
            SessionEventKind::SystemEvent,
            payload["message"].as_str().unwrap_or_default(),
            stored,
            Some(turn),
        );
    }
    let _ = app.emit(PROVIDER_CHAT_EVENT, payload);
}

pub(crate) fn run_provider_chat_with_retry_using<F>(
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
    run_provider_chat_with_retry_using_with_wait(
        store,
        request,
        binding,
        run_once,
        &stopped,
        |delay, _, _, _| wait_before_provider_retry(delay, &stopped),
    )
}

pub(crate) fn run_provider_chat_with_retry_using_with_wait<F>(
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
    let _budget = gyro_core::provider_retry::RetryScope::start();
    let _cycle = Cycle::start();
    let retries_at_start = gyro_core::provider_retry::retries_used();
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
    project_import_continuation::check_continuation(store, request, binding_cursor.as_ref())?;
    if let Some(stop) = stopped() {
        anyhow::bail!(stop);
    }
    let mut attempt = ProviderRunAttempt {
        resume_cursor: binding_cursor.clone(),
        continuing_work: provider_retry_recovery::is_continuation(request) || saved_work,
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
            persist_failed_provider_attempt(store, request, binding.as_ref(), &attempt, &error);
            Err(error)
        }
        Err(error)
            if project_import_continuation::requires_native_session(store, request)?
                && is_stale_resume_error(&format!("{error:#}")) =>
        {
            project_import_continuation::unavailable(store, request,
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
                && gyro_core::provider_retry::take_retry()
                && stopped().is_none()
                && is_stale_resume_error(&format!("{error:#}")) =>
        {
            let session_id =
                parse_uuid(&request.session_id).map_err(|error| anyhow::anyhow!(error))?;
            let _ = store.clear_provider_session_binding(session_id, &request.provider_id);
            let mut fresh_attempt = ProviderRunAttempt::default();
            match run_once(None, &mut fresh_attempt) {
                Ok(mut output) => {
                    output.resumed = false;
                    output.retry_count = output.retry_count.saturating_add(1);
                    Ok(output)
                }
                Err(retry_error) => {
                    persist_failed_provider_attempt(
                        store,
                        request,
                        None,
                        &fresh_attempt,
                        &retry_error,
                    );
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
                    || provider_retry_recovery::can_resume_transient_after_work(
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
            let retry_ladder = gyro_core::provider_retry::transient_retry_delays();
            for retry_index in 0..retry_ladder.len() {
                // A provider that states its own cooldown outranks our backoff:
                // the HTTPS runners read `Retry-After`, and a CLI reports the
                // same instruction as text.
                let capacity =
                    provider_reliability::is_model_capacity_error(&format!("{last_error:#}"));
                let rate_limit =
                    provider_reliability::is_rate_limit_error(&format!("{last_error:#}"));
                set_kind(if capacity {
                    "model-capacity"
                } else if rate_limit {
                    "rate-limit"
                } else {
                    "network"
                });
                let fallback = if capacity || rate_limit {
                    provider_retry_recovery::CAPACITY_RETRY_DELAY
                } else {
                    gyro_core::provider_retry::transient_retry_delay(retry_index)
                        .unwrap_or(retry_ladder[retry_index])
                };
                if rate_limit {
                    gyro_core::provider_cooldown::observe_error(
                        &format!("{last_error:#}"),
                        gyro_core::provider_retry::provider_cooldown_hint(&format!(
                            "{last_error:#}"
                        ))
                        .unwrap_or(fallback),
                    );
                }
                let Some(delay) = gyro_core::provider_retry::retry_delay_with_hint(
                    &format!("{last_error:#}"),
                    fallback,
                ) else {
                    break;
                };
                if !gyro_core::provider_retry::take_retry() {
                    break;
                }
                if let Some(stop) = stopped() {
                    let stop = last_error.context(stop);
                    persist_failed_provider_attempt(
                        store,
                        request,
                        binding.as_ref(),
                        &last_attempt,
                        &stop,
                    );
                    return Err(stop);
                }
                // Checkpoint the acknowledged cursor before the wait as well
                // as on terminal failure, so a restart cannot erase it.
                persist_failed_provider_attempt(
                    store,
                    request,
                    binding.as_ref(),
                    &last_attempt,
                    &last_error,
                );
                if let Err(stop) = wait(
                    delay,
                    gyro_core::provider_retry::retries_used(),
                    retry_ladder.len() as u32,
                    capacity,
                ) {
                    let stop = last_error.context(stop);
                    persist_failed_provider_attempt(
                        store,
                        request,
                        binding.as_ref(),
                        &last_attempt,
                        &stop,
                    );
                    return Err(stop);
                }
                if let Some(stop) = stopped() {
                    let stop = last_error.context(stop);
                    persist_failed_provider_attempt(
                        store,
                        request,
                        binding.as_ref(),
                        &last_attempt,
                        &stop,
                    );
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
                        output.retry_count = gyro_core::provider_retry::retries_used()
                            .saturating_sub(retries_at_start);
                        return Ok(output);
                    }
                    Err(retry_error)
                        if is_transient_provider_error(&format!("{retry_error:#}"))
                            && (!last_attempt.published_output
                                || provider_retry_recovery::can_resume_transient_after_work(
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
                            && provider_reliability::is_model_capacity_error(&format!(
                                "{retry_error:#}"
                            ))
                        {
                            retry_error.context(provider_retry_recovery::CAPACITY_RETRY_EXHAUSTED)
                        } else {
                            if is_transient_provider_error(&format!("{retry_error:#}"))
                                && retry_index + 1 == retry_ladder.len()
                            {
                                retry_error.context(RETRY_EXHAUSTED)
                            } else {
                                retry_error
                            }
                        };
                        persist_failed_provider_attempt(
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
            if gyro_core::provider_retry::retries_used() >= 3 {
                last_error = last_error.context(RETRY_EXHAUSTED);
            }
            persist_failed_provider_attempt(
                store,
                request,
                binding.as_ref(),
                &last_attempt,
                &last_error,
            );
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
            persist_failed_provider_attempt(store, request, binding.as_ref(), &attempt, &error);
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        provider_reliability::provider_failure_recovery,
        providers::{
            chat_types::ChatMode, events::append_provider_status_event,
            retry::is_provider_cancellation, types::ProviderActivity,
        },
        state::provider_run::ProviderStopReason,
    };
    use gyro_core::{GyroPaths, HarnessRunStatus, SessionOrigin};

    #[test]
    fn manual_retry_does_not_inherit_exhausted_metadata_from_an_older_cycle() {
        let (_temp, store, request) = setup("openai");
        let session = Uuid::parse_str(&request.session_id).unwrap();
        let turn = request
            .turn_id
            .as_deref()
            .and_then(|id| Uuid::parse_str(id).ok());
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        append_provider_status_event(
            &store,
            session,
            &request,
            turn,
            first,
            HarnessRunStatus::Running,
            None,
        )
        .unwrap();
        let old = append_provider_status_event(
            &store,
            session,
            &request,
            turn,
            first,
            HarnessRunStatus::Failed,
            Some(RETRY_EXHAUSTED),
        )
        .unwrap();
        assert_eq!(old.payload["recovery"]["attemptsUsed"], 3);
        append_provider_status_event(
            &store,
            session,
            &request,
            turn,
            second,
            HarnessRunStatus::Running,
            None,
        )
        .unwrap();
        let next = append_provider_status_event(
            &store,
            session,
            &request,
            turn,
            second,
            HarnessRunStatus::Failed,
            Some("rate limit exceeded; retry after 90s"),
        )
        .unwrap();
        assert_eq!(next.payload["recovery"]["attemptsUsed"], 0);
        assert_eq!(next.payload["recovery"]["cycleId"], second.to_string());
        assert_ne!(
            next.payload["recovery"]["cycleId"],
            old.payload["recovery"]["cycleId"]
        );
    }

    #[test]
    fn a_saved_failed_turn_without_its_cursor_never_dispatches() {
        let (_temp, store, request) = setup("openai");
        let session = Uuid::parse_str(&request.session_id).unwrap();
        let turn = request
            .turn_id
            .as_deref()
            .and_then(|id| Uuid::parse_str(id).ok());
        store.append_event_with_turn_id(session, SessionEventKind::SystemEvent, "Edited file",
            serde_json::json!({"kind":"capability-call", "schema":"gyro.capability.v1", "status":"completed"}), turn).unwrap();
        store
            .append_event_with_turn_id(
                session,
                SessionEventKind::SystemEvent,
                "Rate limit reached",
                serde_json::json!({"kind":"provider-status", "status":"failed"}),
                turn,
            )
            .unwrap();
        let error = run_provider_chat_with_retry_using_with_wait(
            &store,
            &request,
            None,
            |_, _| panic!("must not replay a saved failed turn without its cursor"),
            || None,
            |_, _, _, _| Ok(()),
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains(CONTINUATION_UNAVAILABLE));
    }

    #[test]
    fn rate_limit_after_edit_resumes_the_acknowledged_conversation_once() {
        let (temp, store, request) = setup("openai");
        let target = temp.path().join("completed.txt");
        let mut calls = 0;
        let mut edits = 0;
        let mut waits = Vec::new();
        let result = run_provider_chat_with_retry_using_with_wait(
            &store,
            &request,
            None,
            |cursor, attempt| {
                calls += 1;
                if calls == 1 {
                    edits += 1;
                    std::fs::write(&target, "completed work").unwrap();
                    attempt.published_output = true;
                    attempt.resume_cursor = Some(ProviderResumeCursor {
                        kind: "codex-session".into(),
                        session_id: "saved-after-edit".into(),
                    });
                    anyhow::bail!("rate limit exceeded. Please try again in 1.783s.");
                }
                assert!(attempt.continuing_work);
                assert_eq!(cursor.unwrap().session_id, "saved-after-edit");
                assert_eq!(std::fs::read_to_string(&target).unwrap(), "completed work");
                Ok(output(Vec::new()))
            },
            || None,
            |delay, _, _, _| {
                waits.push(delay);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(calls, 2);
        assert_eq!(edits, 1);
        assert_eq!(result.retry_count, 1);
        assert_eq!(waits, vec![Duration::from_millis(1783)]);
    }

    #[test]
    fn missing_cursor_after_work_cannot_start_a_fresh_task() {
        let (_temp, store, request) = setup("openai");
        let mut calls = 0;
        let error = run_provider_chat_with_retry_using_with_wait(
            &store,
            &request,
            None,
            |_, attempt| {
                calls += 1;
                attempt.published_output = true;
                anyhow::bail!("rate limit exceeded; try again in 1s")
            },
            || None,
            |_, _, _, _| panic!("unsafe retry"),
        )
        .unwrap_err();
        assert_eq!(calls, 1);
        assert_eq!(
            provider_failure_recovery(&format!("{error:#}")).0,
            "continuation-unavailable"
        );
    }

    #[test]
    fn rate_limit_exhaustion_is_terminal_for_every_retry_owner() {
        let (_temp, store, request) = setup("openai");
        let mut calls = 0;
        let error = run_provider_chat_with_retry_using_with_wait(
            &store,
            &request,
            None,
            |_, _| {
                calls += 1;
                anyhow::bail!("rate_limit_exceeded; try again in 0s")
            },
            || None,
            |_, _, _, _| Ok(()),
        )
        .unwrap_err();
        assert_eq!(calls, 4);
        let text = format!("{error:#}");
        assert_eq!(provider_failure_recovery(&text).0, "retry-exhausted");
        assert!(!is_transient_provider_error(&text));
    }

    #[test]
    fn a_nested_worker_cannot_reset_a_spent_recovery_budget() {
        let _budget = gyro_core::provider_retry::RetryScope::start();
        assert!(gyro_core::provider_retry::take_retry());
        assert!(gyro_core::provider_retry::take_retry());
        let (_temp, store, request) = setup("openai");
        let mut calls = 0;
        let error = run_provider_chat_with_retry_using_with_wait(
            &store,
            &request,
            None,
            |_, _| {
                calls += 1;
                anyhow::bail!("rate limit exceeded; try again in 0s")
            },
            || None,
            |_, _, _, _| Ok(()),
        )
        .unwrap_err();
        assert_eq!(calls, 2);
        assert!(format!("{error:#}").contains(RETRY_EXHAUSTED));
        assert_eq!(gyro_core::provider_retry::retries_used(), 3);
    }

    #[test]
    fn rate_limits_are_explicit_but_billing_and_generic_try_again_are_not_transient() {
        assert!(is_transient_provider_error("rate limit exceeded"));
        assert!(is_transient_provider_error("rate_limit_exceeded"));
        assert!(is_transient_provider_error("too many requests"));
        assert!(!is_transient_provider_error(
            "insufficient_quota; try again"
        ));
        assert!(!is_transient_provider_error("bad tool argument; try again"));
    }

    fn setup(provider: &str) -> (tempfile::TempDir, SessionStore, ProviderChatRequest) {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "retry")
            .unwrap();
        let request = ProviderChatRequest {
            session_id: session.id.to_string(),
            message: "edit the app and verify it".into(),
            turn_id: Some(Uuid::new_v4().to_string()),
            provider_id: provider.into(),
            provider_label: Some(provider.into()),
            model_id: None,
            model_label: None,
            reasoning_effort: None,
            require_command_approval: false,
            require_file_edit_approval: false,
            full_access: true,
            suggest_title: false,
            workspace_path: Some(temp.path().display().to_string()),
            mode: ChatMode::Normal,
            goal: None,
            plan: None,
            attachments: Vec::new(),
            workspace_context: None,
            workspace_check: None,
            side_chat_context: None,
            workflow_run_id: None,
        project_memory: None,            internal_purpose: None,
        };
        (temp, store, request)
    }

    fn output(activities: Vec<ProviderActivity>) -> ProviderRunnerOutput {
        ProviderRunnerOutput {
            accounted_usage: None,
            activities,
            context_usage: None,
            billed_usage: None,
            rate_limits: Vec::new(),
            response: "verified".into(),
            paused_at_tool_budget: false,
            answer_cut_off: false,
            resume_cursor: None,
            retry_count: 0,
            resumed: true,
            output_summary: None,
            streamed_text: None,
        }
    }

    #[test]
    fn provider_cooldown_beyond_automatic_wait_does_not_restart_the_runner() {
        for error in [
            "HTTP 429: retry after 90 seconds",
            "HTTP 429: try again in 1 hour",
            "Selected model is at capacity. Retry after 90 seconds.",
        ] {
            let (_temp, store, request) = setup("openai");
            let mut calls = 0;
            let mut waits = Vec::new();
            let result = run_provider_chat_with_retry_using_with_wait(
                &store,
                &request,
                None,
                |_, _| {
                    calls += 1;
                    anyhow::bail!("{error}");
                },
                || None,
                |delay, _, _, _| {
                    waits.push(delay);
                    Ok(())
                },
            );
            assert!(format!("{:#}", result.unwrap_err()).contains(error));
            assert_eq!(
                calls, 1,
                "must not retry before the stated cooldown: {error}"
            );
            assert!(waits.is_empty(), "long cooldowns remain actionable errors");
        }
    }

    #[test]
    fn provider_cooldown_sets_the_wait_for_rate_limits_and_capacity_errors() {
        for (error, expected) in [
            ("HTTP 429: retry after 500ms", Duration::from_millis(500)),
            ("HTTP 429: try again in 0.5 min", Duration::from_secs(30)),
            (
                "Selected model is at capacity. Retry after 2 seconds.",
                Duration::from_secs(2),
            ),
        ] {
            let (_temp, store, request) = setup("openai");
            let mut calls = 0;
            let mut waits = Vec::new();
            let result = run_provider_chat_with_retry_using_with_wait(
                &store,
                &request,
                None,
                |_, _| {
                    calls += 1;
                    if calls == 1 {
                        anyhow::bail!("{error}");
                    }
                    Ok(output(Vec::new()))
                },
                || None,
                |delay, _, _, _| {
                    waits.push(delay);
                    Ok(())
                },
            )
            .unwrap();
            assert_eq!(calls, 2);
            assert_eq!(waits, vec![expected], "{error}");
            assert_eq!(result.retry_count, 1);
        }
    }

    #[test]
    fn failed_native_retry_continues_without_changing_the_original_request() {
        for (provider, kind) in [("openai", "codex-session"), ("anthropic", "claude-session")] {
            let (_temp, store, request) = setup(provider);
            let session = Uuid::parse_str(&request.session_id).unwrap();
            let binding = store
                .upsert_provider_session_binding(
                    session,
                    provider,
                    request.model_id.clone(),
                    request.model_label.clone(),
                    None,
                    serde_json::json!({"kind":kind,"sessionId":"saved"}),
                    "failed",
                    Some("model is at capacity".into()),
                )
                .unwrap();
            let original = request.message.clone();
            let retry = manual_retry_request(&request, Some("failed"), Some(&binding));
            assert!(retry.message.contains("do not repeat completed commands"));
            assert!(retry.message.ends_with(&original));
            assert_eq!(request.message, original);
            assert_eq!(
                manual_retry_request(&request, None, Some(&binding)).message,
                original
            );
            assert_eq!(
                manual_retry_request(&request, Some("failed"), None).message,
                original
            );
        }
    }

    #[test]
    fn overload_after_a_tool_resumes_same_thread_and_preserves_completed_work() {
        let (_temp, store, request) = setup("openai");
        let activity = ProviderActivity {
            id: "edit".into(),
            kind: "file".into(),
            label: "Edited file".into(),
            detail: Some("app.ts".into()),
            note: None,
            file_counts: None,
            status: "done".into(),
        };
        let mut calls = 0;
        let mut edits = 0;
        let mut waits = Vec::new();
        let result = run_provider_chat_with_retry_using_with_wait(
            &store,
            &request,
            None,
            |cursor, attempt| {
                calls += 1;
                if calls == 1 {
                    edits += 1;
                    attempt.published_output = true;
                    attempt.activities.push(activity.clone());
                    attempt.resume_cursor = Some(ProviderResumeCursor {
                        kind: "codex-session".into(),
                        session_id: "saved".into(),
                    });
                    anyhow::bail!("Selected model is at capacity. Please try a different model.");
                }
                assert_eq!(cursor.unwrap().session_id, "saved");
                assert!(attempt.continuing_work);
                let continued = continuation_request(&request);
                assert!(continued.message.contains("Review the prior tool results"));
                Ok(output(Vec::new()))
            },
            || None,
            |delay, attempt, max, capacity| {
                assert!(capacity);
                waits.push((delay, attempt, max));
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(calls, 2);
        assert_eq!(edits, 1);
        assert_eq!(waits, vec![(CAPACITY_RETRY_DELAY, 1, 3)]);
        assert_eq!(result.activities.len(), 1);
        assert_eq!(result.activities[0].id, "edit");
        assert_eq!(result.retry_count, 1);
    }

    #[test]
    fn sustained_native_overload_has_three_cancellable_waits_and_keeps_its_cursor() {
        let (_temp, store, request) = setup("openai");
        let mut calls = 0;
        let mut waits = Vec::new();
        let result = run_provider_chat_with_retry_using_with_wait(
            &store,
            &request,
            None,
            |cursor, attempt| {
                calls += 1;
                if calls > 1 {
                    assert_eq!(cursor.unwrap().session_id, "saved");
                    assert!(attempt.continuing_work);
                }
                attempt.published_output = true;
                attempt.resume_cursor = Some(ProviderResumeCursor {
                    kind: "codex-session".into(),
                    session_id: "saved".into(),
                });
                anyhow::bail!("Selected model is at capacity. Please try a different model.")
            },
            || None,
            |delay, _, _, capacity| {
                assert!(capacity);
                waits.push(delay);
                Ok(())
            },
        );
        let error = format!("{:#}", result.unwrap_err());
        assert_eq!(
            provider_failure_recovery(&error).0,
            "model-capacity-exhausted"
        );
        assert!(!is_transient_provider_error(&error));
        assert_eq!(calls, 4);
        assert_eq!(waits, vec![CAPACITY_RETRY_DELAY; 3]);
        let binding = store
            .get_provider_session_binding(Uuid::parse_str(&request.session_id).unwrap(), "openai")
            .unwrap()
            .unwrap();
        assert_eq!(
            provider_resume_cursor_from_binding(&binding)
                .unwrap()
                .session_id,
            "saved"
        );
    }

    #[test]
    fn stop_during_capacity_wait_dispatches_no_continuation() {
        let (_temp, store, request) = setup("openai");
        let mut calls = 0;
        let result = run_provider_chat_with_retry_using_with_wait(
            &store,
            &request,
            None,
            |_, attempt| {
                calls += 1;
                attempt.published_output = true;
                attempt.resume_cursor = Some(ProviderResumeCursor {
                    kind: "codex-session".into(),
                    session_id: "saved".into(),
                });
                anyhow::bail!("Selected model is at capacity. Please try a different model.")
            },
            || None,
            |_, _, _, _| Err(ProviderStopReason::User.message()),
        );
        assert!(is_provider_cancellation(&format!(
            "{:#}",
            result.unwrap_err()
        )));
        assert_eq!(calls, 1);
    }

    #[test]
    fn published_work_without_supported_cursor_and_api_loops_never_replay() {
        for provider in ["openai", "anthropic", "deepseek", "ollama", "xai"] {
            let (_temp, store, request) = setup(provider);
            let mut calls = 0;
            let result = run_provider_chat_with_retry_using_with_wait(
                &store,
                &request,
                None,
                |_, attempt| {
                    calls += 1;
                    attempt.published_output = true;
                    anyhow::bail!("Selected model is at capacity. Please try a different model.")
                },
                || None,
                |_, _, _, _| panic!("unsafe replay"),
            );
            assert!(result.is_err());
            assert_eq!(calls, 1);
        }
    }

    #[test]
    fn continuation_never_falls_back_to_a_fresh_provider_session() {
        let (_temp, store, request) = setup("openai");
        let mut calls = 0;
        let result = run_provider_chat_with_retry_using_with_wait(
            &store,
            &request,
            None,
            |cursor, attempt| {
                calls += 1;
                if calls == 1 {
                    attempt.published_output = true;
                    attempt.resume_cursor = Some(ProviderResumeCursor {
                        kind: "codex-session".into(),
                        session_id: "saved".into(),
                    });
                    anyhow::bail!("Selected model is at capacity. Please try a different model.")
                }
                assert_eq!(cursor.unwrap().session_id, "saved");
                anyhow::bail!("Could not resume session: not found")
            },
            || None,
            |_, _, _, _| Ok(()),
        );
        assert!(result.is_err());
        assert_eq!(calls, 2);
    }

    #[test]
    fn failed_continuation_startup_preserves_the_last_acknowledged_cursor() {
        for (provider, kind) in [("openai", "codex-session"), ("anthropic", "claude-session")] {
            for recover in [true, false] {
                let (_temp, store, request) = setup(provider);
                let mut calls = 0;
                let mut edits = 0;
                let result = run_provider_chat_with_retry_using_with_wait(
                    &store,
                    &request,
                    None,
                    |cursor, attempt| {
                        calls += 1;
                        if calls == 1 {
                            edits += 1;
                            attempt.published_output = true;
                            attempt.resume_cursor = Some(ProviderResumeCursor {
                                kind: kind.into(),
                                session_id: "acknowledged-child".into(),
                            });
                            anyhow::bail!(
                                "Selected model is at capacity. Please try a different model."
                            );
                        }
                        assert_eq!(cursor.unwrap().session_id, "acknowledged-child");
                        assert!(attempt.continuing_work);
                        if calls >= 3 && recover {
                            return Ok(output(Vec::new()));
                        }
                        // The native adapter can fail before observing an ID.
                        attempt.resume_cursor = None;
                        anyhow::bail!("connection reset before session acknowledgement");
                    },
                    || None,
                    |_, _, _, _| Ok(()),
                );
                assert_eq!(edits, 1, "completed work is never replayed");
                if recover {
                    assert_eq!(result.unwrap().retry_count, 2);
                    assert_eq!(calls, 3);
                } else {
                    assert!(result.is_err());
                    assert_eq!(calls, 4, "retries stay bounded");
                    let binding = store
                        .get_provider_session_binding(
                            Uuid::parse_str(&request.session_id).unwrap(),
                            provider,
                        )
                        .unwrap()
                        .unwrap();
                    assert_eq!(
                        provider_resume_cursor_from_binding(&binding)
                            .unwrap()
                            .session_id,
                        "acknowledged-child",
                        "manual recovery retains the conversation"
                    );
                }
            }
        }
    }
}

pub(crate) use gyro_core::provider_runtime::reliability::{
    CAPACITY_RETRY_EXHAUSTED, CONTINUATION_UNAVAILABLE, RETRY_EXHAUSTED,
};
