use super::*;

#[path = "codex_rollout_usage.rs"]
mod codex_rollout_usage;
#[path = "native_accounting.rs"]
mod native_accounting;
pub(super) use native_accounting::ClaudeTurnUsage;

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

/// App-server `last` is request occupancy; `total` is a thread counter.
/// Missing baselines retain observed consumption as a partial lower bound.
/// A regression may be a reset or a delayed update: never guess a new epoch.
pub(super) struct CodexTurnUsage {
    baseline: Option<UsageTokens>,
    high_water: Option<UsageTokens>,
    uncertain: Option<gyro_core::usage::UsageReason>,
    tokens: Option<UsageTokens>,
    thread: Option<serde_json::Value>,
    turn_id: Option<String>,
}
impl CodexTurnUsage {
    pub(super) fn new(resumed: bool) -> Self {
        Self {
            baseline: (!resumed).then(|| {
                UsageTokens::measured(Some(0), Some(0), Some(0), Some(0), Some(0))
                    .with_cache_write(Some(0))
            }),
            high_water: None,
            uncertain: None,
            tokens: None,
            thread: None,
            turn_id: None,
        }
    }
    pub(super) fn bind_thread(&mut self, thread: &serde_json::Value) {
        self.thread = Some(serde_json::json!({"id": thread.get("id"), "path": thread.get("path")}));
    }
    pub(super) fn bind_turn(&mut self, turn: Option<&str>) {
        self.turn_id = turn.map(str::to_string);
    }
    pub(super) fn recover(&mut self) -> Option<UsageTokens> {
        let update = codex_rollout_usage::ending(self.thread.as_ref()?, self.turn_id.as_deref()?)?;
        self.observe(&update)
    }
    pub(super) fn set_baseline(&mut self, baseline: Option<UsageTokens>) {
        if let Some(baseline) = baseline.filter(|tokens| tokens.measured) {
            self.baseline = Some(baseline);
            self.high_water = Some(baseline);
        }
    }
    pub(super) fn observe(&mut self, params: &serde_json::Value) -> Option<UsageTokens> {
        use gyro_core::usage::{UsageReason, UsageScope};
        let Some(total) = params.pointer("/tokenUsage/total").and_then(parse_counts) else {
            let reason = if self.baseline.is_none() {
                UsageReason::MissingBaseline
            } else {
                UsageReason::ProviderIncomplete
            };
            self.uncertain = Some(reason);
            if let Some(last) = params.pointer("/tokenUsage/last").and_then(parse_counts) {
                let observed = last.with_scope(UsageScope::Turn).partial(reason);
                self.tokens = Some(
                    self.tokens
                        .map_or(observed, |old| retain_observed_lower_bounds(old, observed)),
                );
            } else {
                self.tokens = self.tokens.map(|tokens| tokens.partial(reason));
            }
            return self.tokens;
        };
        if self
            .high_water
            .is_some_and(|old| counts_regressed(total, old))
        {
            self.uncertain = Some(UsageReason::InconsistentCounts);
            self.tokens = self
                .tokens
                .map(|tokens| tokens.partial(UsageReason::InconsistentCounts));
            return self.tokens;
        }
        self.high_water = Some(total);
        let mut tokens = match self.baseline {
            Some(baseline) => subtract(total, baseline),
            None => {
                self.uncertain = Some(UsageReason::MissingBaseline);
                let Some(last) = params.pointer("/tokenUsage/last").and_then(parse_counts) else {
                    self.tokens = Some(
                        self.tokens
                            .map_or_else(
                                || UsageTokens::unavailable(UsageReason::MissingBaseline),
                                |tokens| tokens.partial(UsageReason::MissingBaseline),
                            )
                            .with_scope(UsageScope::Turn),
                    );
                    return self.tokens;
                };
                if counts_regressed(total, last) {
                    self.uncertain = Some(UsageReason::InconsistentCounts);
                } else {
                    self.baseline = Some(subtract(total, last));
                }
                last.with_scope(UsageScope::Turn)
            }
        };
        if let Some(reason) = self.uncertain {
            tokens = tokens.partial(reason);
        }
        if let Some(previous) = self.tokens {
            tokens = retain_observed_lower_bounds(previous, tokens);
        }
        self.tokens = Some(tokens.with_scope(UsageScope::Turn));
        self.tokens
    }
    pub(super) fn tokens(&self) -> Option<UsageTokens> {
        self.tokens
    }
    pub(super) fn interrupt(&mut self) -> Option<UsageTokens> {
        let reason = gyro_core::usage::UsageReason::Interrupted;
        self.uncertain = Some(reason);
        self.tokens = self.tokens.map(|tokens| tokens.partial(reason));
        self.tokens
    }
}

fn counts_regressed(total: UsageTokens, old: UsageTokens) -> bool {
    let known = |tokens: UsageTokens| {
        tokens
            .accounting
            .map(|metadata| metadata.known)
            .unwrap_or_default()
    };
    let a = known(total);
    let b = known(old);
    (a.input && b.input && total.input_tokens < old.input_tokens)
        || (a.output && b.output && total.output_tokens < old.output_tokens)
        || (a.cache_read && b.cache_read && total.cached_input_tokens < old.cached_input_tokens)
        || (a.cache_write && b.cache_write && total.cache_write_tokens < old.cache_write_tokens)
        || (a.reasoning
            && b.reasoning
            && total.reasoning_output_tokens < old.reasoning_output_tokens)
        || total.total_tokens < old.total_tokens
}
/// Match both identities before allowing a notification to affect any meter.
pub(super) fn codex_usage_matches(
    params: &serde_json::Value,
    thread: &str,
    turn: Option<&str>,
) -> bool {
    params.get("threadId").and_then(serde_json::Value::as_str) == Some(thread)
        && turn
            .is_some_and(|id| params.get("turnId").and_then(serde_json::Value::as_str) == Some(id))
}

/// Read only the bounded tail of the exact resumed thread before dispatch.
/// The protocol's optional rollout path is a best-effort source; absent,
/// rotated, malformed or mismatched logs retain the uncertain fallback.
pub(super) fn codex_usage_baseline(thread: &serde_json::Value) -> Option<UsageTokens> {
    parse_counts(&codex_rollout_usage::baseline(thread)?).filter(|tokens| tokens.measured)
}

fn parse_counts(value: &serde_json::Value) -> Option<UsageTokens> {
    let field = |camel: &str, snake: &str| {
        value
            .get(camel)
            .or_else(|| value.get(snake))
            .and_then(serde_json::Value::as_u64)
    };
    let input = field("inputTokens", "input_tokens");
    let output = field("outputTokens", "output_tokens");
    let total = field("totalTokens", "total_tokens");
    if input.is_none() && output.is_none() && total.is_none() {
        return None;
    }
    let cached = field("cachedInputTokens", "cached_input_tokens");
    let reasoning = field("reasoningOutputTokens", "reasoning_output_tokens");
    let write = field("cacheWriteInputTokens", "cache_write_input_tokens");
    let mut tokens = UsageTokens::measured(input, cached, output, reasoning, total)
        .with_cache_write(write)
        .with_scope(gyro_core::usage::UsageScope::Session);
    if cached
        .zip(input)
        .is_some_and(|(cache, input)| cache > input)
        || reasoning
            .zip(output)
            .is_some_and(|(reasoning, output)| reasoning > output)
    {
        tokens = tokens.partial(gyro_core::usage::UsageReason::InconsistentCounts);
    }
    Some(tokens)
}
fn subtract(total: UsageTokens, baseline: UsageTokens) -> UsageTokens {
    let known = |tokens: UsageTokens| {
        tokens
            .accounting
            .map(|metadata| metadata.known)
            .unwrap_or_default()
    };
    let a = known(total);
    let b = known(baseline);
    let delta = |value: u64, old: u64, supplied: bool| supplied.then(|| value.saturating_sub(old));
    let mut tokens = UsageTokens::measured(
        delta(
            total.input_tokens,
            baseline.input_tokens,
            a.input && b.input,
        ),
        delta(
            total.cached_input_tokens,
            baseline.cached_input_tokens,
            a.cache_read && b.cache_read,
        ),
        delta(
            total.output_tokens,
            baseline.output_tokens,
            a.output && b.output,
        ),
        delta(
            total.reasoning_output_tokens,
            baseline.reasoning_output_tokens,
            a.reasoning && b.reasoning,
        ),
        Some(total.total_tokens.saturating_sub(baseline.total_tokens)),
    )
    .with_cache_write(delta(
        total.cache_write_tokens,
        baseline.cache_write_tokens,
        a.cache_write && b.cache_write,
    ))
    .with_scope(gyro_core::usage::UsageScope::Turn);
    if counts_regressed(total, baseline) {
        tokens = tokens.partial(gyro_core::usage::UsageReason::InconsistentCounts);
    } else if !total.measured || !baseline.measured {
        tokens = tokens.partial(gyro_core::usage::UsageReason::ProviderIncomplete);
    }
    tokens
}

/// New snapshots can omit previously observed buckets. Keep their numeric
/// lower bounds while the latest snapshot's known flags remain conservative.
fn retain_observed_lower_bounds(previous: UsageTokens, mut current: UsageTokens) -> UsageTokens {
    current.input_tokens = current.input_tokens.max(previous.input_tokens);
    current.cached_input_tokens = current
        .cached_input_tokens
        .max(previous.cached_input_tokens);
    current.cache_write_tokens = current.cache_write_tokens.max(previous.cache_write_tokens);
    current.output_tokens = current.output_tokens.max(previous.output_tokens);
    current.reasoning_output_tokens = current
        .reasoning_output_tokens
        .max(previous.reasoning_output_tokens);
    current.total_tokens = current
        .total_tokens
        .max(previous.total_tokens)
        .max(current.input_tokens.saturating_add(current.output_tokens));
    current
}

pub(super) fn set_usage_offset(app: &tauri::AppHandle, session: &str, tokens: Option<UsageTokens>) {
    if let Some(control) = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .and_then(|flags| flags.get(session).cloned())
    {
        if let Ok(mut offset) = control.usage_offset.lock() {
            *offset = tokens;
        }
    }
}

struct TokenEmission {
    display: UsageTokens,
    spend: Option<(UsageTokens, u32)>,
}

impl TokenEmission {
    fn live(
        tokens: UsageTokens,
        observed: Option<(u32, Option<UsageTokens>)>,
        offset: Option<UsageTokens>,
    ) -> Self {
        // API retries belong to the collector even when the runner retained
        // only successfully returned rounds.
        let tokens = observed
            .filter(|(requests, _)| *requests > 0)
            .and_then(|(_, tokens)| tokens)
            .unwrap_or(tokens);
        let worker_tokens = observed.and_then(|(_, tokens)| tokens).unwrap_or(tokens);
        Self {
            display: delegated_agents::add_tokens(offset, Some(tokens)).unwrap(),
            spend: Some((
                delegated_agents::add_tokens(offset, Some(worker_tokens)).unwrap(),
                observed.map_or(0, |(requests, _)| requests),
            )),
        }
    }

    fn task(tokens: UsageTokens) -> Self {
        // The worker receipts were checked while running. This cumulative
        // display reading may also include child receipts in the ledger, so
        // feeding it back into the live guard would count those children twice.
        Self {
            display: tokens,
            spend: None,
        }
    }
}

pub(super) fn emit_turn_tokens(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    tokens: UsageTokens,
) {
    let observed = gyro_core::provider_observation::current_usage();
    let offset = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .and_then(|flags| flags.get(&request.session_id).cloned())
        .and_then(|control| control.usage_offset.lock().ok().and_then(|offset| *offset));
    emit_tokens(app, request, TokenEmission::live(tokens, observed, offset));
}

pub(super) fn emit_task_tokens(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    tokens: UsageTokens,
) {
    emit_tokens(app, request, TokenEmission::task(tokens));
}

fn emit_tokens(app: &tauri::AppHandle, request: &ProviderChatRequest, emission: TokenEmission) {
    if let Some((tokens, requests)) = emission.spend {
        provider_spend_guard::observe(app, request, tokens, requests);
    }
    let tokens = emission.display;
    delegated_agents::observe_tokens(app, request, tokens);
    let _ = app.emit(
        PROVIDER_CHAT_EVENT,
        serde_json::json!({
            "sessionId": request.session_id,
            "turnId": request.turn_id,
            "providerId": request.provider_id,
            "modelId": request.model_id,
            "eventId": Uuid::new_v4().to_string(),
            "sequence": next_provider_event_sequence(app, &request.session_id),
            "phase": "turn-tokens",
            "turnTokens": tokens,
        }),
    );
}

pub(super) fn observe_codex_turn_usage(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    billed: &mut CodexTurnUsage,
    params: &serde_json::Value,
    thread: &str,
    turn: Option<&str>,
) -> Option<ProviderContextUsage> {
    if !codex_usage_matches(params, thread, turn) {
        return None;
    }
    if let Some(tokens) = billed.observe(params) {
        gyro_core::provider_observation::native_usage(tokens);
        emit_turn_tokens(app, request, provider_turn_tokens(request, None));
    }
    let usage = provider_context_usage_from_app_server(params)?;
    emit_provider_context_usage(app, request, &usage);
    Some(usage)
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
    match store.record_usage(&entry) {
        Ok(id) => {
            let cfg = efficiency::config();
            let attribution = gyro_core::provider_observation::snapshot()
                .map(|s| s.context_attribution)
                .unwrap_or_default();
            let price = if gyro_core::efficiency::controls(&request.provider_id).owns_requests
                && request.provider_id != "ollama"
            {
                request.model_id.as_deref().and_then(|model| {
                    gyro_core::efficiency::pricing::snapshot(
                        &cfg.prices,
                        &request.provider_id,
                        model,
                        &chrono::Utc::now().format("%Y-%m-%d").to_string(),
                    )
                })
            } else {
                None
            };
            let _ = store.record_efficiency_metadata(id, price, &attribution);
            if let Some(turn) = entry.turn_id {
                let task = efficiency::checkpoint(
                    store,
                    session_id,
                    request.workspace_path.as_deref().unwrap_or(""),
                    0,
                )
                .map(|c| c.task_id)
                .unwrap_or(session_id);
                let _ = store.link_efficiency_task(task, session_id, turn);
                let totals = store.efficiency_task_totals(task).ok();
                let _ = store.append_event_with_turn_id(session_id,SessionEventKind::SystemEvent,"",serde_json::json!({"kind":"efficiency-receipt","taskId":task,"contextAttribution":attribution,"optimizationOverheadMicros":timing::efficiency_overhead(),"generationRequests":gyro_core::provider_observation::snapshot().map(|s|s.requests.max(s.provider_attempts)),"estimatedCost":price.and_then(|p|p.price(tokens)),"taskTotals":totals,"subscriptionBilling":!gyro_core::efficiency::controls(&request.provider_id).owns_requests}),Some(turn));
            }
        }
        Err(error) => eprintln!(
            "Provider usage recording failed: {}",
            gyro_core::security::redact_secrets(&error.to_string())
        ),
    }
    // Terminal receipts survive reload even when no assistant answer exists.
    if let Some(turn_id) = entry.turn_id {
        let total = store
            .task_usage_tokens(session_id, turn_id)
            .ok()
            .flatten()
            .unwrap_or(tokens);
        let _ = store.append_event_with_turn_id(
            session_id,
            SessionEventKind::SystemEvent,
            "",
            serde_json::json!({
                "kind": "provider-turn-tokens", "accountingVersion": 1,
                "providerId": request.provider_id, "modelId": request.model_id,
                "turnTokens": total,
                "usageObservations": gyro_core::provider_observation::snapshot()
                    .map(|summary| summary.usage_observations).unwrap_or_default(),
            }),
            Some(turn_id),
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
    fn task_totals_display_children_once_without_rebilling_them_to_the_live_guard() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("data"))).unwrap();
        let parent = store
            .create_session(temp.path(), SessionOrigin::Desktop, "parent")
            .unwrap();
        let child = store
            .create_session(temp.path(), SessionOrigin::Desktop, "child")
            .unwrap();
        let prior = store
            .create_session(temp.path(), SessionOrigin::Desktop, "prior")
            .unwrap();
        let turn = Uuid::new_v4();
        let child_turn = Uuid::new_v4();
        for (session_id, turn_id, amount) in [
            (prior.id, Uuid::new_v4(), 600),
            (parent.id, turn, 100),
            (child.id, child_turn, 200),
        ] {
            store
                .record_usage(&UsageEntry {
                    session_id,
                    turn_id: Some(turn_id),
                    seat_id: None,
                    provider_id: "openrouter".into(),
                    model_id: None,
                    reasoning_effort: None,
                    origin: UsageOrigin::Chat,
                    outcome: UsageOutcome::Done,
                    tokens: UsageTokens::measured(Some(amount), None, Some(0), None, None),
                    wall_ms: 0,
                    retry_count: 0,
                })
                .unwrap();
        }
        store
            .link_usage_turn(child.id, child_turn, parent.id, turn)
            .unwrap();
        let task = store.task_usage_tokens(parent.id, turn).unwrap().unwrap();
        let outside = store
            .provider_usage_outside_turn_since(
                "openrouter",
                chrono::Utc::now() - chrono::Duration::hours(24),
                parent.id,
                turn,
            )
            .unwrap();
        assert_eq!(task.total_tokens, 300);
        assert_eq!(outside.total_tokens, 800);
        let display = TokenEmission::task(task);
        assert_eq!(display.display.total_tokens, 300);
        assert!(
            display.spend.is_none(),
            "child spend is already in the outside-turn ledger"
        );
        let live = TokenEmission::live(
            UsageTokens::measured(Some(100), None, Some(0), None, None),
            None,
            None,
        );
        assert_eq!(
            outside.total_tokens + live.spend.unwrap().0.total_tokens,
            900
        );
    }

    #[test]
    fn live_emissions_include_interrupted_retries_and_continuation_offsets_once() {
        let _scope = gyro_core::provider_observation::Scope::start();
        {
            let mut interrupted =
                gyro_core::provider_observation::Request::start(&serde_json::json!("prompt"));
            interrupted.reported(Some(60), Some(10));
        }
        {
            let mut completed =
                gyro_core::provider_observation::Request::start(&serde_json::json!("prompt"));
            completed.complete(Some(40), Some(10), 0);
        }
        let successful_round = UsageTokens::measured(Some(40), None, Some(10), None, None);
        let prior_continuation = UsageTokens::measured(Some(20), Some(10), Some(10), None, None);
        let emission = TokenEmission::live(
            successful_round,
            gyro_core::provider_observation::current_usage(),
            Some(prior_continuation),
        );
        assert_eq!(emission.display.total_tokens, 150);
        let (spend, requests) = emission.spend.unwrap();
        assert_eq!((requests, spend.total_tokens), (2, 150));
        assert_eq!(
            gyro_core::call_ceiling_tokens(
                Some(spend.input_tokens),
                Some(spend.cached_input_tokens),
                Some(spend.output_tokens),
            ),
            140
        );
        assert!(
            !spend.measured,
            "the interrupted retry remains explicitly partial"
        );
    }

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
    fn screenshot_codex_receipt_differences_cached_subsets_once() {
        let _scope = gyro_core::provider_observation::Scope::start();
        let mut usage = CodexTurnUsage::new(true);
        usage.set_baseline(parse_counts(&serde_json::json!({
            "inputTokens": 1_754_476,
            "cachedInputTokens": 1_681_792,
            "outputTokens": 3_430,
            "reasoningOutputTokens": 676,
            "totalTokens": 1_757_906
        })));
        let reading = serde_json::json!({"tokenUsage": {"total": {
            "inputTokens": 3_588_533,
            "cachedInputTokens": 3_468_160,
            "outputTokens": 6_550,
            "reasoningOutputTokens": 1_722,
            "totalTokens": 3_595_083
        }}});
        for _ in 0..3 {
            let tokens = usage.observe(&reading).unwrap();
            assert_eq!(tokens.input_tokens, 1_834_057);
            assert_eq!(tokens.cached_input_tokens, 1_786_368);
            assert_eq!(tokens.output_tokens, 3_120);
            assert_eq!(tokens.reasoning_output_tokens, 1_046);
            assert_eq!(tokens.total_tokens, 1_837_177);
            assert_eq!(
                tokens.total_tokens,
                tokens.input_tokens + tokens.output_tokens
            );
            assert!(tokens.measured);
            let metadata = tokens.accounting.unwrap();
            assert_eq!(metadata.scope, gyro_core::usage::UsageScope::Turn);
            assert!(metadata.known.cache_read && metadata.known.reasoning);
            gyro_core::provider_observation::native_usage(tokens);
            assert_eq!(
                gyro_core::provider_observation::current_usage().unwrap().1,
                Some(tokens)
            );
            assert_eq!(
                gyro_core::provider_observation::snapshot().unwrap().tokens,
                Some(tokens)
            );
        }
    }

    #[test]
    fn resumed_usage_excludes_history_and_marks_missing_baseline_and_resets() {
        let mut usage = CodexTurnUsage::new(true);
        let first = usage.observe(&update(1100, 150, 100, 10)).unwrap();
        assert_eq!(first.total_tokens, 110);
        assert!(!first.measured);
        let next = usage.observe(&update(1350, 165, 250, 15)).unwrap();
        assert_eq!(next.total_tokens, 375);
        let regressed = usage.observe(&update(250, 15, 250, 15)).unwrap();
        assert_eq!(regressed.total_tokens, next.total_tokens);
        assert_eq!(
            regressed.accounting.unwrap().coverage,
            gyro_core::usage::UsageCoverage::Partial
        );
        assert_eq!(
            regressed.accounting.unwrap().reason,
            Some(gyro_core::usage::UsageReason::InconsistentCounts)
        );
    }

    #[test]
    fn resumed_usage_uses_verified_baseline_even_when_first_update_covers_many_requests() {
        let mut usage = CodexTurnUsage::new(true);
        usage.set_baseline(parse_counts(
            &serde_json::json!({"inputTokens": 1000, "outputTokens": 100, "totalTokens": 1100}),
        ));
        let tokens = usage.observe(&update(1600, 160, 200, 20)).unwrap();
        assert_eq!(tokens.total_tokens, 660);
        assert!(tokens.measured);
        assert_eq!(usage.observe(&update(1600, 160, 200, 20)), Some(tokens));
        let stale = usage.observe(&update(1500, 150, 100, 10)).unwrap();
        assert_eq!(stale.total_tokens, 660);
        assert!(!stale.measured);
        assert_eq!(
            usage
                .observe(&update(1700, 170, 100, 10))
                .unwrap()
                .total_tokens,
            770
        );
    }

    #[test]
    fn usage_notifications_must_belong_to_both_the_thread_and_turn() {
        let p = serde_json::json!({"threadId": "thread", "turnId": "turn"});
        assert!(codex_usage_matches(&p, "thread", Some("turn")));
        assert!(!codex_usage_matches(&p, "other", Some("turn")));
        assert!(!codex_usage_matches(&p, "thread", Some("other")));
        assert!(!codex_usage_matches(&p, "thread", None));
    }

    #[test]
    fn bounded_rollout_baseline_validates_identity_and_ignores_partial_tail() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout.jsonl");
        let thread = serde_json::json!({"id": "test-thread", "path": path});
        let mut file = std::fs::File::create(&path).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({"type": "session_meta", "payload": {"id": "test-thread"}})
        )
        .unwrap();
        // A large rollout is scanned from its tail, not loaded in full.
        writeln!(file, "{}", " ".repeat(3 * 1024 * 1024)).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({"type":"event_msg", "payload":{
                "type":"token_count", "info":{"total_token_usage":{
                    "input_tokens":24949, "cached_input_tokens":13056,
                    "output_tokens":181, "total_tokens":25130
                }}
            }})
        )
        .unwrap();
        write!(file, "{{incomplete").unwrap();
        file.flush().unwrap();
        let baseline = codex_usage_baseline(&thread).unwrap();
        assert_eq!(baseline.total_tokens, 25130);
        assert_eq!(baseline.cached_input_tokens, 13056);
        assert!(codex_usage_baseline(&serde_json::json!({"id":"other", "path":path})).is_none());
        let mut usage = CodexTurnUsage::new(true);
        usage.set_baseline(Some(baseline));
        let tokens = usage
            .observe(&update(3_904_230, 15_889, 138_062, 199))
            .unwrap();
        assert_eq!(
            tokens.total_tokens, 3_894_989,
            "regression for the audited screenshot"
        );
        assert!(tokens.measured);
    }

    #[test]
    fn empty_or_missing_rollouts_do_not_invent_a_baseline() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.jsonl");
        std::fs::write(&path, "").unwrap();
        assert!(codex_usage_baseline(&serde_json::json!({"id":"test", "path":path})).is_none());
        assert!(codex_usage_baseline(&serde_json::json!({"id":"test"})).is_none());
    }

    #[test]
    fn codex_absent_breakdowns_stay_unknown_after_a_verified_baseline() {
        let mut usage = CodexTurnUsage::new(true);
        usage.set_baseline(parse_counts(&serde_json::json!({
            "inputTokens":1000, "outputTokens":100, "totalTokens":1100
        })));
        let mut current = update(1200, 120, 200, 20);
        current["tokenUsage"]["total"]["cachedInputTokens"] = serde_json::json!(800);
        current["tokenUsage"]["total"]["reasoningOutputTokens"] = serde_json::json!(30);
        let tokens = usage.observe(&current).unwrap();
        assert_eq!(tokens.total_tokens, 220);
        let known = tokens.accounting.unwrap().known;
        assert!(
            !known.cache_read,
            "the baseline did not supply cached input"
        );
        assert!(!known.reasoning, "the baseline did not supply reasoning");
        assert!(!known.cache_write);
    }

    #[test]
    fn codex_missing_baseline_is_provider_partial_not_a_character_estimate() {
        let mut usage = CodexTurnUsage::new(true);
        let tokens = usage.observe(&update(1200, 120, 200, 20)).unwrap();
        let metadata = tokens.accounting.unwrap();
        assert_eq!(metadata.source, gyro_core::usage::UsageSource::Provider);
        assert_eq!(metadata.scope, gyro_core::usage::UsageScope::Turn);
        assert_eq!(metadata.coverage, gyro_core::usage::UsageCoverage::Partial);
        assert_eq!(
            metadata.reason,
            Some(gyro_core::usage::UsageReason::MissingBaseline)
        );
        assert_eq!(tokens.total_tokens, 220);
    }

    #[test]
    fn codex_reset_never_replays_or_erases_known_consumption() {
        let mut usage = CodexTurnUsage::new(false);
        assert_eq!(
            usage
                .observe(&update(100, 10, 100, 10))
                .unwrap()
                .total_tokens,
            110
        );
        for _ in 0..3 {
            let tokens = usage.observe(&update(20, 2, 20, 2)).unwrap();
            assert_eq!(tokens.total_tokens, 110);
            assert_eq!(
                tokens.accounting.unwrap().coverage,
                gyro_core::usage::UsageCoverage::Partial
            );
        }
        assert_eq!(
            usage
                .observe(&update(150, 15, 130, 13))
                .unwrap()
                .total_tokens,
            165
        );
        assert_eq!(
            usage
                .observe(&update(150, 15, 130, 13))
                .unwrap()
                .total_tokens,
            165
        );
    }

    #[test]
    fn codex_last_without_a_counter_retains_observed_consumption_once() {
        let mut usage = CodexTurnUsage::new(true);
        let frame = serde_json::json!({"tokenUsage":{"last":{
            "inputTokens":100, "outputTokens":10, "cachedInputTokens":80
        }}});
        for _ in 0..3 {
            let tokens = usage.observe(&frame).unwrap();
            assert_eq!(tokens.total_tokens, 110);
            assert_eq!(tokens.cached_input_tokens, 80);
            assert_eq!(
                tokens.accounting.unwrap().coverage,
                gyro_core::usage::UsageCoverage::Partial
            );
        }
    }

    #[test]
    fn codex_cache_writes_are_differenced_once_and_remain_input_subsets() {
        let mut usage = CodexTurnUsage::new(true);
        usage.set_baseline(parse_counts(&serde_json::json!({
            "input_tokens":1000, "cached_input_tokens":700, "cache_write_input_tokens":100,
            "output_tokens":100, "total_tokens":1100
        })));
        let reading = serde_json::json!({"tokenUsage":{"total":{
            "inputTokens":1400, "cachedInputTokens":950, "cacheWriteInputTokens":160,
            "outputTokens":140, "totalTokens":1540
        }}});
        for _ in 0..3 {
            let tokens = usage.observe(&reading).unwrap();
            assert_eq!(tokens.total_tokens, 440);
            assert_eq!(tokens.input_tokens, 400);
            assert_eq!(tokens.cached_input_tokens, 250);
            assert_eq!(tokens.cache_write_tokens, 60);
            assert!(tokens.measured && tokens.effective_accounting().known.cache_write);
        }
        let invalid = parse_counts(&serde_json::json!({
            "inputTokens":100, "cachedInputTokens":80, "cacheWriteInputTokens":30,
            "outputTokens":10, "totalTokens":110
        }))
        .unwrap();
        assert!(!invalid.measured);
        assert_eq!(
            invalid.effective_accounting().reason,
            Some(gyro_core::usage::UsageReason::InconsistentCounts)
        );
    }

    #[test]
    fn codex_missing_last_cannot_expose_session_totals_as_turn_spend() {
        let mut usage = CodexTurnUsage::new(true);
        let tokens = usage
            .observe(&serde_json::json!({"tokenUsage":{
                "total":{"inputTokens":1000,"outputTokens":100,"totalTokens":1100}
            }}))
            .unwrap();
        assert!(tokens.is_empty());
        assert_eq!(
            tokens.accounting.unwrap().coverage,
            gyro_core::usage::UsageCoverage::Unavailable
        );
    }

    #[test]
    fn codex_missing_last_retains_previously_observed_request_without_a_baseline() {
        let mut usage = CodexTurnUsage::new(true);
        let first = usage
            .observe(&serde_json::json!({"tokenUsage":{"last":{
                "inputTokens":100,"outputTokens":10,"cachedInputTokens":80
            }}}))
            .unwrap();
        assert_eq!(first.total_tokens, 110);
        let counter_only = serde_json::json!({"tokenUsage":{"total":{
            "inputTokens":1000,"outputTokens":100,"totalTokens":1100
        }}});
        for _ in 0..3 {
            let tokens = usage.observe(&counter_only).unwrap();
            assert_eq!(tokens.total_tokens, 110);
            assert_eq!(tokens.cached_input_tokens, 80);
            assert_eq!(
                tokens.effective_accounting().coverage,
                gyro_core::usage::UsageCoverage::Partial
            );
            assert_eq!(
                tokens.effective_accounting().reason,
                Some(gyro_core::usage::UsageReason::MissingBaseline)
            );
        }
    }

    #[test]
    fn codex_interruption_preserves_observed_consumption_without_claiming_full_coverage() {
        let _scope = gyro_core::provider_observation::Scope::start();
        let mut usage = CodexTurnUsage::new(false);
        let complete = usage.observe(&update(100, 10, 100, 10)).unwrap();
        assert!(complete.measured);
        let tokens = usage.interrupt().unwrap();
        assert_eq!(tokens.total_tokens, 110);
        assert_eq!(
            tokens.effective_accounting().coverage,
            gyro_core::usage::UsageCoverage::Partial
        );
        assert_eq!(
            tokens.effective_accounting().reason,
            Some(gyro_core::usage::UsageReason::Interrupted)
        );
        gyro_core::provider_observation::native_usage(tokens);
        assert_eq!(
            gyro_core::provider_observation::snapshot().unwrap().tokens,
            Some(tokens)
        );
        assert_eq!(usage.interrupt(), Some(tokens));
        assert!(CodexTurnUsage::new(true).interrupt().is_none());
    }

    #[test]
    fn cancelled_codex_recovers_exact_native_receipt_when_stream_notifications_were_lost() {
        use std::io::Write;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("rollout.jsonl");
        let thread = serde_json::json!({"id":"thread", "path":path});
        let mut file = std::fs::File::create(&path).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({"type":"session_meta","payload":{"id":"thread"}})
        )
        .unwrap();
        let baseline = serde_json::json!({"input_tokens":65_483_350,"cached_input_tokens":64_101_248,
            "output_tokens":259_309,"reasoning_output_tokens":151_032,"total_tokens":65_742_659});
        writeln!(
            file,
            "{}",
            serde_json::json!({"type":"event_msg","payload":{
            "type":"token_count","info":{"total_token_usage":baseline}}})
        )
        .unwrap();
        file.flush().unwrap();
        let mut usage = CodexTurnUsage::new(true);
        usage.bind_thread(&thread);
        usage.bind_turn(Some("cancelled-turn"));
        usage.set_baseline(codex_usage_baseline(&thread));
        assert!(usage.tokens().is_none());
        for event in [
            serde_json::json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"cancelled-turn"}}),
            serde_json::json!({"type":"turn_context","payload":{"turn_id":"cancelled-turn"}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"token_count","info":{
                "total_token_usage":{"input_tokens":65_761_407,"cached_input_tokens":64_377_856,
                    "output_tokens":259_452,"reasoning_output_tokens":151_032,"total_tokens":66_020_859},
                "last_token_usage":{"input_tokens":278_057,"cached_input_tokens":276_608,
                    "output_tokens":143,"reasoning_output_tokens":0,"total_tokens":278_200}}}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"cancelled-turn"}}),
        ] {
            writeln!(file, "{event}").unwrap();
        }
        file.flush().unwrap();
        let recovered = usage.recover().unwrap();
        assert_eq!(recovered.total_tokens, 278_200);
        assert_eq!(recovered.input_tokens, 278_057);
        assert_eq!(recovered.cached_input_tokens, 276_608);
        assert_eq!(recovered.output_tokens, 143);
        assert_eq!(recovered.reasoning_output_tokens, 0);
        assert_eq!(
            usage.recover(),
            Some(recovered),
            "recovery replaces, never adds another request"
        );
        assert_eq!(usage.interrupt().unwrap().total_tokens, 278_200);
        usage.bind_turn(Some("another-turn"));
        assert!(usage.recover().is_none());
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
