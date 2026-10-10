use super::*;

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
        }
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
                self.tokens = Some(self.tokens.map_or(observed, |old|
                    retain_observed_lower_bounds(old, observed)));
            } else {
                self.tokens = self.tokens.map(|tokens| tokens.partial(reason));
            }
            return self.tokens;
        };
        if self.high_water.is_some_and(|old| counts_regressed(total, old)) {
            self.uncertain = Some(UsageReason::InconsistentCounts);
            self.tokens = self.tokens.map(|tokens| tokens.partial(UsageReason::InconsistentCounts));
            return self.tokens;
        }
        self.high_water = Some(total);
        let mut tokens = match self.baseline {
            Some(baseline) => subtract(total, baseline),
            None => {
                self.uncertain = Some(UsageReason::MissingBaseline);
                let Some(last) = params.pointer("/tokenUsage/last").and_then(parse_counts) else {
                    self.tokens = Some(UsageTokens::unavailable(UsageReason::MissingBaseline)
                        .with_scope(UsageScope::Turn));
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
}

fn counts_regressed(total: UsageTokens, old: UsageTokens) -> bool {
    let known = |tokens: UsageTokens| tokens.accounting.map(|metadata| metadata.known).unwrap_or_default();
    let a = known(total);
    let b = known(old);
    (a.input && b.input && total.input_tokens < old.input_tokens)
        || (a.output && b.output && total.output_tokens < old.output_tokens)
        || (a.cache_read && b.cache_read && total.cached_input_tokens < old.cached_input_tokens)
        || (a.cache_write && b.cache_write && total.cache_write_tokens < old.cache_write_tokens)
        || (a.reasoning && b.reasoning && total.reasoning_output_tokens < old.reasoning_output_tokens)
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
    use std::io::{BufRead, Read, Seek, SeekFrom};
    const TAIL_BYTES: u64 = 2 * 1024 * 1024;
    let id = thread.get("id")?.as_str()?;
    let path = std::path::Path::new(thread.get("path")?.as_str()?);
    if !path.is_absolute() || path.extension()?.to_str()? != "jsonl" {
        return None;
    }
    let mut file = std::fs::File::open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() {
        return None;
    }
    let mut first = String::new();
    std::io::BufReader::new((&mut file).take(256 * 1024))
        .read_line(&mut first)
        .ok()?;
    let header: serde_json::Value = serde_json::from_str(&first).ok()?;
    if header.get("type")?.as_str()? != "session_meta"
        || header.pointer("/payload/id")?.as_str()? != id
    {
        return None;
    }
    let offset = metadata.len().saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut tail = Vec::new();
    file.take(TAIL_BYTES).read_to_end(&mut tail).ok()?;
    let mut lines = tail.split(|byte| *byte == b'\n').collect::<Vec<_>>();
    if offset > 0 {
        lines.remove(0);
    } // never parse a truncated leading record
    for line in lines.into_iter().rev() {
        let Ok(event) = serde_json::from_slice::<serde_json::Value>(line) else {
            continue;
        };
        if event.get("type").and_then(serde_json::Value::as_str) == Some("event_msg")
            && event
                .pointer("/payload/type")
                .and_then(serde_json::Value::as_str)
                == Some("token_count")
        {
            if let Some(total) = event.pointer("/payload/info/total_token_usage") {
                return parse_counts(total).filter(|tokens| tokens.measured);
            }
        }
    }
    None
}

fn parse_counts(value: &serde_json::Value) -> Option<UsageTokens> {
    let field = |camel: &str, snake: &str| {
        value.get(camel).or_else(|| value.get(snake)).and_then(serde_json::Value::as_u64)
    };
    let input = field("inputTokens", "input_tokens");
    let output = field("outputTokens", "output_tokens");
    let total = field("totalTokens", "total_tokens");
    if input.is_none() && output.is_none() && total.is_none() {
        return None;
    }
    let cached = field("cachedInputTokens", "cached_input_tokens");
    let reasoning = field("reasoningOutputTokens", "reasoning_output_tokens");
    let mut tokens = UsageTokens::measured(input, cached, output, reasoning, total)
        .with_scope(gyro_core::usage::UsageScope::Session);
    if cached.zip(input).is_some_and(|(cache, input)| cache > input)
        || reasoning.zip(output).is_some_and(|(reasoning, output)| reasoning > output)
    {
        tokens = tokens.partial(gyro_core::usage::UsageReason::InconsistentCounts);
    }
    Some(tokens)
}
fn subtract(total: UsageTokens, baseline: UsageTokens) -> UsageTokens {
    let known = |tokens: UsageTokens| tokens.accounting.map(|metadata| metadata.known).unwrap_or_default();
    let a = known(total);
    let b = known(baseline);
    let delta = |value: u64, old: u64, supplied: bool| supplied.then(|| value.saturating_sub(old));
    let mut tokens = UsageTokens::measured(
        delta(total.input_tokens, baseline.input_tokens, a.input && b.input),
        delta(total.cached_input_tokens, baseline.cached_input_tokens, a.cache_read && b.cache_read),
        delta(total.output_tokens, baseline.output_tokens, a.output && b.output),
        delta(total.reasoning_output_tokens, baseline.reasoning_output_tokens, a.reasoning && b.reasoning),
        Some(total.total_tokens.saturating_sub(baseline.total_tokens)),
    ).with_cache_write(delta(total.cache_write_tokens, baseline.cache_write_tokens, a.cache_write && b.cache_write))
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
    current.cached_input_tokens = current.cached_input_tokens.max(previous.cached_input_tokens);
    current.cache_write_tokens = current.cache_write_tokens.max(previous.cache_write_tokens);
    current.output_tokens = current.output_tokens.max(previous.output_tokens);
    current.reasoning_output_tokens = current.reasoning_output_tokens.max(previous.reasoning_output_tokens);
    current.total_tokens = current.total_tokens.max(previous.total_tokens)
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

pub(super) fn emit_turn_tokens(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    tokens: UsageTokens,
) {
    let offset = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .and_then(|flags| flags.get(&request.session_id).cloned())
        .and_then(|control| control.usage_offset.lock().ok().and_then(|offset| *offset));
    let tokens = delegated_agents::add_tokens(offset, Some(tokens)).unwrap();
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
    if let Err(error) = store.record_usage(&entry) {
        eprintln!(
            "provider call completed but its usage was not recorded: {}",
            gyro_core::security::redact_secrets(&error.to_string())
        );
    }
    // Terminal receipts survive reload even when no assistant answer exists.
    if let Some(turn_id) = entry.turn_id {
        let total = store.task_usage_tokens(session_id, turn_id)
            .ok().flatten().unwrap_or(tokens);
        let _ = store.append_event_with_turn_id(
            session_id, SessionEventKind::SystemEvent, "",
            serde_json::json!({
                "kind": "provider-turn-tokens", "accountingVersion": 1,
                "providerId": request.provider_id, "modelId": request.model_id,
                "turnTokens": total,
                "usageObservations": gyro_core::provider_observation::snapshot()
                    .map(|summary| summary.usage_observations).unwrap_or_default(),
            }), Some(turn_id),
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
        let regressed = usage.observe(&update(250, 15, 250, 15)).unwrap();
        assert_eq!(regressed.total_tokens, next.total_tokens);
        assert_eq!(regressed.accounting.unwrap().coverage, gyro_core::usage::UsageCoverage::Partial);
        assert_eq!(regressed.accounting.unwrap().reason, Some(gyro_core::usage::UsageReason::InconsistentCounts));
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
        let mut current = update(1200,120,200,20);
        current["tokenUsage"]["total"]["cachedInputTokens"] = serde_json::json!(800);
        current["tokenUsage"]["total"]["reasoningOutputTokens"] = serde_json::json!(30);
        let tokens = usage.observe(&current).unwrap();
        assert_eq!(tokens.total_tokens,220);
        let known = tokens.accounting.unwrap().known;
        assert!(!known.cache_read, "the baseline did not supply cached input");
        assert!(!known.reasoning, "the baseline did not supply reasoning");
        assert!(!known.cache_write);
    }

    #[test]
    fn codex_missing_baseline_is_provider_partial_not_a_character_estimate() {
        let mut usage = CodexTurnUsage::new(true);
        let tokens = usage.observe(&update(1200,120,200,20)).unwrap();
        let metadata = tokens.accounting.unwrap();
        assert_eq!(metadata.source,gyro_core::usage::UsageSource::Provider);
        assert_eq!(metadata.scope,gyro_core::usage::UsageScope::Turn);
        assert_eq!(metadata.coverage,gyro_core::usage::UsageCoverage::Partial);
        assert_eq!(metadata.reason,Some(gyro_core::usage::UsageReason::MissingBaseline));
        assert_eq!(tokens.total_tokens,220);
    }

    #[test]
    fn codex_reset_never_replays_or_erases_known_consumption() {
        let mut usage = CodexTurnUsage::new(false);
        assert_eq!(usage.observe(&update(100,10,100,10)).unwrap().total_tokens,110);
        for _ in 0..3 {
            let tokens = usage.observe(&update(20,2,20,2)).unwrap();
            assert_eq!(tokens.total_tokens,110);
            assert_eq!(tokens.accounting.unwrap().coverage,gyro_core::usage::UsageCoverage::Partial);
        }
        assert_eq!(usage.observe(&update(150,15,130,13)).unwrap().total_tokens,165);
        assert_eq!(usage.observe(&update(150,15,130,13)).unwrap().total_tokens,165);
    }

    #[test]
    fn codex_last_without_a_counter_retains_observed_consumption_once() {
        let mut usage = CodexTurnUsage::new(true);
        let frame = serde_json::json!({"tokenUsage":{"last":{
            "inputTokens":100, "outputTokens":10, "cachedInputTokens":80
        }}});
        for _ in 0..3 {
            let tokens = usage.observe(&frame).unwrap();
            assert_eq!(tokens.total_tokens,110);
            assert_eq!(tokens.cached_input_tokens,80);
            assert_eq!(tokens.accounting.unwrap().coverage,gyro_core::usage::UsageCoverage::Partial);
        }
    }

    #[test]
    fn codex_missing_last_cannot_expose_session_totals_as_turn_spend() {
        let mut usage = CodexTurnUsage::new(true);
        let tokens = usage.observe(&serde_json::json!({"tokenUsage":{
            "total":{"inputTokens":1000,"outputTokens":100,"totalTokens":1100}
        }})).unwrap();
        assert!(tokens.is_empty());
        assert_eq!(tokens.accounting.unwrap().coverage,gyro_core::usage::UsageCoverage::Unavailable);
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
