use crate::{
    app::limits::PROVIDER_CHAT_EVENT,
    delegated_agents, efficiency, provider_context, provider_spend_guard,
    providers::{
        chat_types::ProviderChatRequest,
        events::{emit_provider_context_usage, next_provider_event_sequence},
        types::ProviderRunnerOutput,
    },
    state::managers::ProviderCancellationManager,
    stores::parse_uuid,
    usage::{fetch::remember_provider_rate_limits_in, guard::UsageContext},
};
use gyro_core::{
    timing, CapabilityStatus, SessionEventKind, SessionStore, UsageEntry, UsageOutcome, UsageTokens,
};
use tauri::{Emitter, Manager};
use uuid::Uuid;
#[path = "native_accounting.rs"]
mod native_accounting;
pub(super) use native_accounting::ClaudeTurnUsage;

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
    fn request(
        current: UsageTokens,
        previous_rounds: Option<UsageTokens>,
        observed: Option<(u32, Option<UsageTokens>)>,
        offset: Option<UsageTokens>,
    ) -> Self {
        // The collector commits owned requests on Drop. Inside a callback its
        // total contains earlier attempts only, so add this snapshot once.
        let observed = observed.map(|(requests, previous)| {
            (
                requests,
                Some(previous.map_or(current, |old| old.combine(current))),
            )
        });
        Self::live(
            previous_rounds.map_or(current, |old| old.combine(current)),
            observed,
            offset,
        )
    }

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

/// A stream snapshot covers one owned request; earlier tool rounds remain in
/// the turn bill, while context occupancy uses only this request's counters.
pub(super) fn emit_request_usage(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    previous_rounds: Option<UsageTokens>,
    tokens: UsageTokens,
    window: Option<u64>,
) {
    let known = tokens.effective_accounting().known;
    if let Some(usage) = provider_context::occupancy_from_request(
        known.input.then_some(tokens.input_tokens),
        known.output.then_some(tokens.output_tokens),
        &tokens,
        window,
    ) {
        emit_provider_context_usage(app, request, &usage);
    }
    let offset = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .and_then(|flags| flags.get(&request.session_id).cloned())
        .and_then(|control| control.usage_offset.lock().ok().and_then(|offset| *offset));
    emit_tokens(
        app,
        request,
        TokenEmission::request(
            tokens,
            previous_rounds,
            gyro_core::provider_observation::current_usage(),
            offset,
        ),
    );
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

/// Native processes own their inner generations. Only request-owning adapters
/// with an observed request can report generation and tool-request counters.
fn attach_owned_diagnostics(
    attribution: &mut gyro_core::efficiency::context::Attribution,
    observation: Option<&gyro_core::provider_observation::Summary>,
    owns_requests: bool,
) {
    if !owns_requests {
        attribution.efficiency_events = None;
        return;
    }
    if let Some(summary) = observation.filter(|summary| summary.requests > 0) {
        attribution.generation_attempts =
            Some(gyro_core::efficiency::context::GenerationAttempts {
                started: u64::from(summary.requests),
                completed: u64::from(summary.completed),
                rejected: u64::from(summary.rejected),
                retries: u64::from(summary.retries),
            });
        attribution.tool_class_counts = Some(summary.tool_class_counts.clone());
        attribution.efficiency_events = Some(
            summary
                .context_attribution
                .efficiency_events
                .clone()
                .unwrap_or_default(),
        );
    }
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
            let observation = gyro_core::provider_observation::snapshot();
            let mut attribution = observation
                .as_ref()
                .map(|summary| summary.context_attribution.clone())
                .unwrap_or_default();
            attach_owned_diagnostics(
                &mut attribution,
                observation.as_ref(),
                gyro_core::efficiency::controls(&request.provider_id).owns_requests,
            );
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
                let _ = store.append_event_with_turn_id(session_id,SessionEventKind::SystemEvent,"",serde_json::json!({"kind":"efficiency-receipt","taskId":task,"contextAttribution":attribution,"optimizationOverheadMicros":timing::efficiency_overhead(),"generationRequests":observation.as_ref().map(|s|s.requests.max(s.provider_attempts)),"retryCount":entry.retry_count,"requestedReasoningEffort":request.reasoning_effort,"usageTokens":tokens,"usageAccounting":tokens.effective_accounting(),"estimatedCost":price.and_then(|p|p.price(tokens)),"taskTotals":totals,"subscriptionBilling":!gyro_core::efficiency::controls(&request.provider_id).owns_requests}),Some(turn));
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
    use crate::providers::{
        retry_recovery::run_provider_chat_with_retry_using, types::ProviderResumeCursor,
    };
    use gyro_core::{GyroPaths, SessionOrigin, UsageOrigin};

    #[test]
    fn diagnostics_do_not_turn_native_or_unattempted_runs_into_zeroes() {
        let mut summary = gyro_core::provider_observation::Summary::default();
        summary.provider_attempts = 3;
        let mut attribution = gyro_core::efficiency::context::Attribution::default();
        attach_owned_diagnostics(&mut attribution, Some(&summary), false);
        assert!(attribution.generation_attempts.is_none());
        assert!(attribution.tool_class_counts.is_none());
        attach_owned_diagnostics(&mut attribution, Some(&summary), true);
        assert!(attribution.generation_attempts.is_none());
        assert!(attribution.tool_class_counts.is_none());

        summary.requests = 3;
        summary.completed = 1;
        summary.rejected = 1;
        summary.retries = 1;
        summary.tool_class_counts.insert("workspace-read".into(), 2);
        attach_owned_diagnostics(&mut attribution, Some(&summary), true);
        let generations = attribution.generation_attempts.as_ref().unwrap();
        assert_eq!(
            (
                generations.started,
                generations.completed,
                generations.rejected,
                generations.retries
            ),
            (3, 1, 1, 1)
        );
        assert_eq!(
            attribution
                .tool_class_counts
                .as_ref()
                .unwrap()
                .get("workspace-read"),
            Some(&2)
        );
    }

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
    fn live_request_snapshots_include_active_counts_without_double_counting_earlier_rounds() {
        let tokens = |input| UsageTokens::measured(Some(input), None, Some(0), None, None);
        let previous = tokens(100);
        for active in [20, 30] {
            let emission = TokenEmission::request(
                tokens(active),
                Some(previous),
                Some((2, Some(previous))),
                Some(tokens(5)),
            );
            assert_eq!(emission.display.total_tokens, 105 + active);
            assert_eq!(emission.spend.unwrap().0.total_tokens, 105 + active);
        }
        let first = TokenEmission::request(tokens(20), None, Some((1, None)), None);
        assert_eq!(first.display.total_tokens, 20);
        let completed =
            TokenEmission::live(tokens(30), Some((2, Some(tokens(130)))), Some(tokens(5)));
        assert_eq!(completed.display.total_tokens, 135);
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

pub(crate) use gyro_core::provider_runtime::accounting::{
    codex_usage_baseline, counts_regressed, provider_turn_tokens, subtract, usage_tokens,
    CodexTurnUsage,
};

#[cfg(test)]
use gyro_core::provider_runtime::accounting::parse_counts;

#[cfg(test)]
use gyro_core::provider_runtime::accounting::codex_usage_matches;
