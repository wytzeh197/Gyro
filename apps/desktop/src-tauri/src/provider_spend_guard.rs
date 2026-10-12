//! Apply the user's existing spend limits consistently across provider runners.
use super::*;

pub(super) struct TurnSpendGuard {
    ceiling: u64,
    provider_budget: Option<(u64, u64)>,
    budget_window_hours: u32,
    refreshed_at: Instant,
    observed_requests: u32,
}

impl TurnSpendGuard {
    fn new(config: &gyro_core::UsageGuardConfig, budget: Option<gyro_core::BudgetState>) -> Self {
        Self {
            ceiling: if config.enabled {
                config.max_tokens_per_call
            } else {
                0
            },
            budget_window_hours: budget
                .as_ref()
                .map_or(24, |budget| budget.window_hours.max(1)),
            refreshed_at: Instant::now(),
            observed_requests: 0,
            provider_budget: config
                .enabled
                .then_some(budget)
                .flatten()
                .filter(|budget| budget.max_tokens > 0)
                .map(|budget| (budget.used_tokens, budget.max_tokens)),
        }
    }

    fn refresh_budget(
        &mut self,
        store: &SessionStore,
        request: &ProviderChatRequest,
        requests: u32,
    ) {
        if self.provider_budget.is_none()
            || (requests == self.observed_requests
                && self.refreshed_at.elapsed() < Duration::from_secs(1))
        {
            return;
        }
        let Some((session, turn)) = Uuid::parse_str(&request.session_id).ok().zip(
            request
                .turn_id
                .as_deref()
                .and_then(|turn| Uuid::parse_str(turn).ok()),
        ) else {
            return;
        };
        let since =
            chrono::Utc::now() - chrono::Duration::hours(i64::from(self.budget_window_hours));
        if let Ok(other) =
            store.provider_usage_outside_turn_since(&request.provider_id, since, session, turn)
        {
            if let Some((spent, _)) = self.provider_budget.as_mut() {
                *spent = other.total_tokens;
            }
            self.refreshed_at = Instant::now();
            self.observed_requests = requests;
        }
    }

    fn stop_reason(&self, tokens: UsageTokens) -> Option<ProviderStopReason> {
        let spent = gyro_core::call_ceiling_tokens(
            Some(tokens.input_tokens),
            Some(tokens.cached_input_tokens),
            Some(tokens.output_tokens),
        );
        if self.ceiling > 0 && spent > self.ceiling {
            return Some(ProviderStopReason::CallTokenCeiling {
                spent,
                ceiling: self.ceiling,
            });
        }
        if let Some((before_turn, limit)) = self.provider_budget {
            let used = before_turn.saturating_add(tokens.total_tokens);
            if used >= limit {
                return Some(ProviderStopReason::ProviderTokenBudget { used, limit });
            }
        }
        None
    }
}

/// Resolve once before generation, retaining the baseline through retries and
/// delegation continuations. Ledger writes at the end of earlier continuations
/// must not cause their tokens to be counted twice against the rolling budget.
pub(super) fn bind(app: &tauri::AppHandle, request: &ProviderChatRequest, store: &SessionStore) {
    let control = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .and_then(|flags| flags.get(&request.session_id).cloned());
    let Some(control) = control else { return };
    let Ok(mut state) = control.spend_guard.lock() else {
        return;
    };
    if state.is_some() {
        return;
    }
    let guard = GyroPaths::for_current_user()
        .ok()
        .and_then(|paths| GyroConfig::load(&paths).ok())
        .map(|config| config.usage_guard)
        .unwrap_or_default();
    let budget = guard
        .budgets
        .iter()
        .find(|budget| budget.provider_id == request.provider_id && budget.max_tokens > 0)
        .and_then(|budget| store.budget_state(budget, chrono::Utc::now()).ok());
    *state = Some(TurnSpendGuard::new(&guard, budget));
}

pub(super) fn observe(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    tokens: UsageTokens,
    requests: u32,
) {
    let control = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .and_then(|flags| flags.get(&request.session_id).cloned());
    let Some(control) = control else { return };
    if control.cancellation.is_cancelled() {
        return;
    }
    let reason = control.spend_guard.lock().ok().and_then(|mut state| {
        let guard = state.as_mut()?;
        if guard.provider_budget.is_some()
            && (requests != guard.observed_requests
                || guard.refreshed_at.elapsed() >= Duration::from_secs(1))
        {
            if let Ok(store) = open_store() {
                guard.refresh_budget(&store, request, requests);
            }
        }
        guard.stop_reason(tokens)
    });
    if let Some(reason) = reason {
        stop_provider_run(app, &request.session_id, reason);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multi_request_api_turn_stops_before_another_generation() {
        let config = gyro_core::UsageGuardConfig {
            max_tokens_per_call: 100,
            ..Default::default()
        };
        let guard = TurnSpendGuard::new(&config, None);
        let _observations = gyro_core::provider_observation::Scope::start();
        let mut generations = 0;
        for _ in 0..3 {
            if gyro_core::provider_observation::snapshot()
                .and_then(|summary| summary.tokens)
                .and_then(|tokens| guard.stop_reason(tokens))
                .is_some()
            {
                break;
            }
            generations += 1;
            let mut request = gyro_core::provider_observation::Request::start(
                &serde_json::json!({"messages": "prompt"}),
            );
            request.complete(Some(60), Some(10), 0);
        }
        assert_eq!(generations, 2);
        assert_eq!(
            guard.stop_reason(
                gyro_core::provider_observation::snapshot()
                    .unwrap()
                    .tokens
                    .unwrap()
            ),
            Some(ProviderStopReason::CallTokenCeiling {
                spent: 140,
                ceiling: 100
            })
        );
    }

    #[test]
    fn cached_context_and_repeated_usage_frames_do_not_spend_twice() {
        let config = gyro_core::UsageGuardConfig {
            max_tokens_per_call: 100,
            ..Default::default()
        };
        let guard = TurnSpendGuard::new(&config, None);
        let tokens = UsageTokens::measured(Some(10_000), Some(9_950), Some(50), None, None);
        for _ in 0..4 {
            assert_eq!(guard.stop_reason(tokens), None);
        }
        assert!(guard
            .stop_reason(tokens.combine(UsageTokens::measured(Some(1), None, Some(0), None, None)))
            .is_some());
    }

    #[test]
    fn rolling_budget_includes_this_turn_and_preserves_its_initial_baseline() {
        let budget = gyro_core::BudgetState {
            provider_id: "openrouter".into(),
            used_tokens: 900,
            max_tokens: 1_000,
            percent: 90,
            level: gyro_core::BudgetLevel::Notify,
            window_hours: 24,
            window_resets_at: chrono::Utc::now(),
            has_estimates: false,
        };
        let guard = TurnSpendGuard::new(
            &gyro_core::UsageGuardConfig::default(),
            Some(budget.clone()),
        );
        let first = UsageTokens::measured(Some(20), Some(10), Some(20), None, None);
        assert_eq!(guard.stop_reason(first), None);
        let total = first.combine(UsageTokens::measured(Some(40), None, Some(20), None, None));
        assert_eq!(
            guard.stop_reason(total),
            Some(ProviderStopReason::ProviderTokenBudget {
                used: 1_000,
                limit: 1_000
            })
        );
        let disabled = gyro_core::UsageGuardConfig {
            enabled: false,
            ..Default::default()
        };
        assert_eq!(
            TurnSpendGuard::new(&disabled, Some(budget)).stop_reason(total),
            None
        );
    }

    #[test]
    fn zero_ceiling_remains_disabled() {
        let config = gyro_core::UsageGuardConfig {
            max_tokens_per_call: 0,
            ..Default::default()
        };
        let guard = TurnSpendGuard::new(&config, None);
        assert_eq!(
            guard.stop_reason(UsageTokens::measured(
                Some(3_000_000),
                None,
                Some(1_000_000),
                None,
                None
            )),
            None
        );
    }

    #[test]
    fn rolling_budget_stop_is_not_offered_as_a_user_cancel_or_plain_retry() {
        let message = ProviderStopReason::ProviderTokenBudget {
            used: 1_001,
            limit: 1_000,
        }
        .message();
        assert!(is_provider_cancellation(&message));
        assert!(!is_transient_provider_error(&message));
        let (kind, recovery) = provider_failure_recovery(&message);
        assert_eq!(kind, "spend-ceiling");
        assert!(recovery.contains("rolling window"));
        assert!(!recovery.contains("You stopped"));
    }

    #[test]
    fn successful_fresh_fallback_keeps_the_adapters_actual_resume_status() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("data"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "resume")
            .unwrap();
        let request: ProviderChatRequest = serde_json::from_value(serde_json::json!({
            "sessionId": session.id, "providerId": "xai", "message": "continue"
        }))
        .unwrap();
        let binding = ProviderSessionBinding {
            session_id: session.id,
            provider_id: "xai".into(),
            model_id: None,
            model_label: None,
            reasoning_effort: None,
            resume_cursor_json: serde_json::json!({"kind":"xai-acp-session", "sessionId":"stale-session"}),
            status: "ready".into(),
            last_error: None,
            updated_at: chrono::Utc::now(),
        };
        let result = run_provider_chat_with_retry_using(
            &store,
            &request,
            Some(binding),
            |cursor, _| {
                assert!(cursor.is_some());
                Ok(ProviderRunnerOutput {
                    accounted_usage: None,
                    activities: Vec::new(),
                    context_usage: None,
                    billed_usage: None,
                    rate_limits: Vec::new(),
                    paused_at_tool_budget: false,
                    answer_cut_off: false,
                    response: "fresh session answer".into(),
                    resume_cursor: Some(ProviderResumeCursor {
                        kind: "xai-acp-session".into(),
                        session_id: "fresh-session".into(),
                    }),
                    retry_count: 0,
                    resumed: false,
                    streamed_text: None,
                    output_summary: None,
                })
            },
            || None,
        )
        .unwrap();
        assert!(!result.resumed);
        assert_eq!(result.resume_cursor.unwrap().session_id, "fresh-session");
    }

    #[test]
    fn rolling_budget_refresh_counts_other_chats_without_rebilling_own_continuations() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("data"))).unwrap();
        let own = store
            .create_session(temp.path(), SessionOrigin::Desktop, "own")
            .unwrap();
        let other = store
            .create_session(temp.path(), SessionOrigin::Desktop, "other")
            .unwrap();
        let turn = Uuid::new_v4();
        let request: ProviderChatRequest = serde_json::from_value(serde_json::json!({
            "sessionId": own.id, "turnId": turn, "providerId": "openrouter", "message": "work"
        }))
        .unwrap();
        let record = |session_id, turn_id, provider: &str, input| {
            store
                .record_usage(&UsageEntry {
                    session_id,
                    turn_id: Some(turn_id),
                    seat_id: None,
                    provider_id: provider.into(),
                    model_id: None,
                    reasoning_effort: None,
                    origin: UsageOrigin::Chat,
                    outcome: UsageOutcome::Done,
                    tokens: UsageTokens::measured(Some(input), None, Some(0), None, None),
                    wall_ms: 0,
                    retry_count: 0,
                })
                .unwrap();
        };
        record(other.id, Uuid::new_v4(), "openrouter", 900);
        let budget: gyro_core::UsageBudget = serde_json::from_value(serde_json::json!({
            "providerId":"openrouter", "maxTokens":1000
        }))
        .unwrap();
        let mut guard = TurnSpendGuard::new(
            &gyro_core::UsageGuardConfig::default(),
            Some(store.budget_state(&budget, chrono::Utc::now()).unwrap()),
        );
        record(own.id, turn, "openrouter", 40);
        record(other.id, Uuid::new_v4(), "mistral", 5000);
        let live = UsageTokens::measured(Some(80), None, Some(0), None, None);
        guard.refresh_budget(&store, &request, 1);
        assert_eq!(guard.stop_reason(live), None);
        record(other.id, Uuid::new_v4(), "openrouter", 30);
        guard.refresh_budget(&store, &request, 2);
        assert_eq!(
            guard.stop_reason(live),
            Some(ProviderStopReason::ProviderTokenBudget {
                used: 1010,
                limit: 1000
            })
        );
    }
}
