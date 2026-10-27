//! Recover overloads by continuing an acknowledged native conversation.
use super::*;

pub(super) const CAPACITY_RETRY_DELAY: Duration = Duration::from_secs(30);
pub(super) const CAPACITY_RETRY_EXHAUSTED: &str =
    "The model is still busy after three automatic attempts.";
const CONTINUATION_PREFIX: &str =
    "The previous attempt was interrupted by a temporary provider failure.";

pub(super) fn is_continuation(request: &ProviderChatRequest) -> bool {
    request.message.starts_with(CONTINUATION_PREFIX)
}

pub(super) fn durable_native_cursor(
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
pub(super) fn continuation_request(request: &ProviderChatRequest) -> ProviderChatRequest {
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

pub(super) fn manual_retry_request(
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

pub(super) fn can_resume_capacity_after_work(
    request: &ProviderChatRequest,
    attempt: &ProviderRunAttempt,
    error: &str,
) -> bool {
    provider_reliability::is_model_capacity_error(error)
        && durable_native_cursor(request, attempt.resume_cursor.as_ref())
}

pub(super) fn emit_wait(
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

pub(super) fn emit_started(
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
    if super::context_compaction::summary_stream_muted(&request.session_id) {
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
        "recoveryKind": "model-capacity",
        "retryAt": retry_at.map(|at| at.to_rfc3339()),
        "retryAttempt": retry_attempt,
        "retryMaxAttempts": max_attempts,
        "message": if phase == "retry-wait" {
            "Model is temporarily busy. Continuing shortly."
        } else {
            "Continuing the saved work"
        },
    });
    provider_timeline::observe(app, &request.session_id, None, None).insert_into(&mut payload);
    let _ = app.emit(PROVIDER_CHAT_EVENT, payload);
}

pub(super) fn run_provider_chat_with_retry_using<F>(
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

pub(super) fn run_provider_chat_with_retry_using_with_wait<F>(
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
    let binding_cursor = binding
        .as_ref()
        .and_then(provider_resume_cursor_from_binding);
    project_import_continuation::check_continuation(store, request, binding_cursor.as_ref())?;
    if let Some(stop) = stopped() {
        anyhow::bail!(stop);
    }
    let mut attempt = ProviderRunAttempt {
        resume_cursor: binding_cursor.clone(),
        continuing_work: provider_retry_recovery::is_continuation(request),
        ..Default::default()
    };
    match run_once(binding_cursor.as_ref(), &mut attempt) {
        // The adapter may have recovered from a stale cursor internally.
        // Its actual session outcome governs continuity and accounting.
        Ok(output) => Ok(output),
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
                    || provider_retry_recovery::can_resume_capacity_after_work(
                        request,
                        &attempt,
                        &format!("{error:#}"),
                    ))
                && !matches!(
                    provider_adapter_for(&request.provider_id).kind,
                    ProviderAdapterKind::OpenAiCompatible | ProviderAdapterKind::Ollama
                ) =>
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
                let fallback = if capacity {
                    provider_retry_recovery::CAPACITY_RETRY_DELAY
                } else {
                    gyro_core::provider_retry::transient_retry_delay(retry_index)
                        .unwrap_or(retry_ladder[retry_index])
                };
                let Some(delay) = gyro_core::provider_retry::retry_delay_with_hint(
                    &format!("{last_error:#}"),
                    fallback,
                ) else {
                    break;
                };
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
                if let Err(stop) = wait(
                    delay,
                    retry_index as u32 + 1,
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
                        output.retry_count = (retry_index as u32).saturating_add(1);
                        return Ok(output);
                    }
                    Err(retry_error)
                        if is_transient_provider_error(&format!("{retry_error:#}"))
                            && (!last_attempt.published_output
                                || provider_retry_recovery::can_resume_capacity_after_work(
                                    request,
                                    &last_attempt,
                                    &format!("{retry_error:#}"),
                                ))
                            && retry_index + 1 < retry_ladder.len() =>
                    {
                        last_error = retry_error;
                    }
                    Err(retry_error) => {
                        let retry_error = if retry_index + 1 == retry_ladder.len()
                            && provider_reliability::is_model_capacity_error(&format!(
                                "{retry_error:#}"
                            )) {
                            retry_error.context(provider_retry_recovery::CAPACITY_RETRY_EXHAUSTED)
                        } else {
                            retry_error
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
            persist_failed_provider_attempt(store, request, binding.as_ref(), &attempt, &error);
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
