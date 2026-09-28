use super::*;

pub(super) fn usage_tokens(usage: &ProviderContextUsage) -> UsageTokens {
    UsageTokens::measured(
        usage.input_tokens,
        usage.cached_input_tokens,
        usage.output_tokens,
        usage.reasoning_output_tokens,
        usage.total_tokens,
    )
}

pub(super) fn has_dispatched_tools(app: &tauri::AppHandle, session_id: &str) -> bool {
    app.state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .and_then(|flags| flags.get(session_id).cloned())
        .is_some_and(|control| {
            control
                .capability_calls
                .lock()
                .map_or(true, |calls| !calls.is_empty())
        })
}

/// App-server `last` describes context occupancy; `total` is cumulative across
/// the provider thread. Derive a turn delta and deduplicate repeated updates.
/// Old resumed threads may not supply a pre-turn baseline: retain the observed
/// first request plus later deltas, explicitly estimated in that case.
pub(super) struct CodexTurnUsage {
    baseline: Option<UsageTokens>,
    high_water: Option<UsageTokens>,
    uncertain: bool,
    tokens: Option<UsageTokens>,
}
impl CodexTurnUsage {
    pub(super) fn new(resumed: bool) -> Self {
        Self {
            baseline: (!resumed).then(UsageTokens::default),
            high_water: None,
            uncertain: false,
            tokens: None,
        }
    }
    pub(super) fn observe(&mut self, params: &serde_json::Value) -> Option<UsageTokens> {
        let total = parse_counts(params.pointer("/tokenUsage/total")?)?;
        if self.high_water.is_some_and(|old| {
            total.input_tokens < old.input_tokens || total.output_tokens < old.output_tokens
        }) {
            self.uncertain = true;
            if let Some(tokens) = self.tokens.as_mut() {
                tokens.measured = false;
            }
            return self.tokens;
        }
        self.high_water = Some(total);
        let baseline = match self.baseline {
            Some(baseline) => baseline,
            None => {
                let last = parse_counts(params.pointer("/tokenUsage/last")?)?;
                let baseline = subtract(total, last);
                self.baseline = Some(baseline);
                self.uncertain = true;
                baseline
            }
        };
        let mut tokens = subtract(total, baseline);
        tokens.measured = !self.uncertain;
        self.tokens = Some(tokens);
        self.tokens
    }
    pub(super) fn tokens(&self) -> Option<UsageTokens> {
        self.tokens
    }
}
fn parse_counts(value: &serde_json::Value) -> Option<UsageTokens> {
    Some(UsageTokens::measured(
        Some(value.get("inputTokens")?.as_u64()?),
        value
            .get("cachedInputTokens")
            .and_then(serde_json::Value::as_u64),
        Some(value.get("outputTokens")?.as_u64()?),
        value
            .get("reasoningOutputTokens")
            .and_then(serde_json::Value::as_u64),
        value.get("totalTokens").and_then(serde_json::Value::as_u64),
    ))
}
fn subtract(total: UsageTokens, baseline: UsageTokens) -> UsageTokens {
    UsageTokens::measured(
        Some(total.input_tokens.saturating_sub(baseline.input_tokens)),
        Some(
            total
                .cached_input_tokens
                .saturating_sub(baseline.cached_input_tokens),
        ),
        Some(total.output_tokens.saturating_sub(baseline.output_tokens)),
        Some(
            total
                .reasoning_output_tokens
                .saturating_sub(baseline.reasoning_output_tokens),
        ),
        Some(total.total_tokens.saturating_sub(baseline.total_tokens)),
    )
}

/// One turn's billed tokens, or the same clearly marked estimate the ledger
/// uses when a provider reports no counts. Share this with the response event
/// so the number under the answer agrees with the session total.
pub(super) fn provider_turn_tokens(
    request: &ProviderChatRequest,
    output: Option<&ProviderRunnerOutput>,
) -> UsageTokens {
    if let Some(tokens) = output
        .and_then(|output| output.accounted_usage)
        .or_else(|| gyro_core::provider_observation::snapshot().and_then(|summary| summary.tokens))
    {
        return tokens;
    }
    output
        .and_then(|output| output.billed_usage.as_ref())
        .map(|usage| {
            UsageTokens::measured(
                usage.input_tokens,
                usage.cached_input_tokens,
                usage.output_tokens,
                usage.reasoning_output_tokens,
                usage.total_tokens,
            )
        })
        .filter(|tokens| !tokens.is_empty())
        .unwrap_or_else(|| {
            UsageTokens::estimated(
                request.message.chars().count(),
                output.map_or(0, |output| output.response.chars().count()),
            )
        })
}

/// Append one provider call to the usage ledger.
///
/// Best-effort on purpose: a ledger write that fails must never turn a
/// completed provider turn into an error the user sees.
pub(super) fn record_provider_usage(
    store: &SessionStore,
    request: &ProviderChatRequest,
    usage_context: UsageContext,
    output: Option<&ProviderRunnerOutput>,
    outcome: UsageOutcome,
    wall_ms: u64,
) {
    // Before the early return below: a run can name a plan limit and still fail
    // to produce a usable session id, and that reading is the one worth keeping.
    if let Some(output) = output {
        remember_provider_rate_limits_in(store, &request.provider_id, &output.rate_limits);
    }
    let Ok(session_id) = parse_uuid(&request.session_id) else {
        return;
    };
    let tokens = provider_turn_tokens(request, output);
    let entry = UsageEntry {
        session_id,
        turn_id: request
            .turn_id
            .as_deref()
            .and_then(|turn_id| parse_uuid(turn_id).ok()),
        seat_id: usage_context.seat_id,
        provider_id: request.provider_id.clone(),
        model_id: request.model_id.clone(),
        reasoning_effort: request.reasoning_effort.clone(),
        origin: usage_context.origin,
        outcome,
        tokens,
        wall_ms,
        retry_count: output
            .map_or(0, |output| output.retry_count)
            .max(gyro_core::provider_observation::snapshot().map_or(0, |summary| summary.retries)),
    };
    if let Err(error) = store.record_usage(&entry) {
        eprintln!(
            "provider call completed but its usage was not recorded: {}",
            gyro_core::security::redact_secrets(&error.to_string())
        );
    }
}

pub(super) fn bind_timing(app: &tauri::AppHandle, session_id: &str) {
    if let Some(control) = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .and_then(|flags| flags.get(session_id).cloned())
    {
        if let Ok(mut handle) = control.timing.lock() {
            *handle = timing::capture();
        }
    }
}

pub(super) fn tool_timing(call_id: Uuid, status: CapabilityStatus) {
    let status = match status {
        CapabilityStatus::Running => "running",
        CapabilityStatus::Completed => "done",
        CapabilityStatus::Failed | CapabilityStatus::Denied => "failed",
        CapabilityStatus::Cancelled => "cancelled",
        _ => return,
    };
    timing::broker_tool(&format!("broker:{call_id}"), status);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejected_http_requests_do_not_fall_back_to_prompt_token_estimates() {
        let _scope = gyro_core::provider_observation::Scope::start();
        let request: ProviderChatRequest = serde_json::from_value(serde_json::json!({
            "sessionId": Uuid::new_v4(), "providerId": "openrouter", "message": "x".repeat(4000)
        }))
        .unwrap();
        {
            let mut observed = gyro_core::provider_observation::Request::start(
                &serde_json::json!({"messages": request.message}),
            );
            observed.rejected();
        }
        let tokens = provider_turn_tokens(&request, None);
        assert!(tokens.is_empty());
        assert!(!tokens.measured);
    }
    fn update(input: u64, output: u64, last_input: u64, last_output: u64) -> serde_json::Value {
        serde_json::json!({"tokenUsage": {
            "total": {"inputTokens": input, "outputTokens": output, "totalTokens": input + output},
            "last": {"inputTokens": last_input, "outputTokens": last_output, "totalTokens": last_input + last_output}
        }})
    }
    #[test]
    fn codex_uses_all_requests_and_deduplicates_cumulative_updates() {
        let mut usage = CodexTurnUsage::new(false);
        usage.observe(&update(100, 10, 100, 10));
        let final_reading = update(350, 25, 250, 15);
        let tokens = usage.observe(&final_reading).unwrap();
        assert_eq!(tokens.total_tokens, 375);
        assert!(tokens.measured);
        assert_eq!(usage.observe(&final_reading), Some(tokens));
    }
    #[test]
    fn resumed_usage_excludes_history_and_marks_missing_baseline_and_resets() {
        let mut usage = CodexTurnUsage::new(true);
        let first = usage.observe(&update(1100, 150, 100, 10)).unwrap();
        assert_eq!(first.total_tokens, 110);
        assert!(!first.measured);
        let next = usage.observe(&update(1350, 165, 250, 15)).unwrap();
        assert_eq!(next.total_tokens, 375);
        assert_eq!(usage.observe(&update(250, 15, 250, 15)).unwrap(), next);
    }
    #[test]
    fn stale_cursor_is_not_replayed_after_output_or_stop() {
        for published in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let store =
                SessionStore::open(GyroPaths::from_base_dir(temp.path().join("store"))).unwrap();
            let session = store
                .create_session(temp.path(), SessionOrigin::Desktop, "retry boundary")
                .unwrap();
            let binding = store
                .upsert_provider_session_binding(
                    session.id,
                    "openai",
                    None,
                    None,
                    None,
                    serde_json::json!({"kind": "codex-session", "sessionId": "old"}),
                    "ready",
                    None,
                )
                .unwrap();
            let request: ProviderChatRequest = serde_json::from_value(serde_json::json!({
                "sessionId": session.id, "providerId": "openai", "message": "continue"
            }))
            .unwrap();
            let stopped = std::cell::Cell::new(false);
            let mut calls = 0;
            let result = run_provider_chat_with_retry_using(
                &store,
                &request,
                Some(binding),
                |_, attempt| {
                    calls += 1;
                    attempt.published_output = published;
                    attempt.resume_cursor = Some(ProviderResumeCursor {
                        kind: "codex-session".into(),
                        session_id: "latest".into(),
                    });
                    stopped.set(!published);
                    anyhow::bail!("Could not resume session: not found")
                },
                || stopped.get().then(|| "stopped".to_string()),
            );
            assert!(result.is_err());
            assert_eq!(calls, 1);
            let saved = store
                .get_provider_session_binding(session.id, "openai")
                .unwrap()
                .unwrap();
            assert_eq!(saved.resume_cursor_json["sessionId"], "latest");
        }
    }
}
