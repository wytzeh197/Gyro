//! Apply the user's existing spend limits consistently across provider runners.

use crate::{
    providers::{chat_types::ProviderChatRequest, streaming::provider_stop_message},
    state::{
        managers::ProviderCancellationManager,
        provider_run::{stop_provider_run, ProviderRunControl, ProviderStopReason},
    },
    stores::open_store,
};
use gyro_core::{GyroConfig, GyroPaths, SessionStore, UsageTokens};
use std::time::{Duration, Instant};
use tauri::Manager;
use uuid::Uuid;
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
        let Some((settled, _)) = self.provider_budget.as_mut() else {
            return;
        };
        let since =
            chrono::Utc::now() - chrono::Duration::hours(i64::from(self.budget_window_hours));
        if let Ok(totals) = store.provider_usage_totals_since(&request.provider_id, since) {
            *settled = totals.total_tokens;
            self.refreshed_at = Instant::now();
            self.observed_requests = requests;
        }
    }

    fn stop_reason(&self, spent: u64, current_total: u64) -> Option<ProviderStopReason> {
        if self.ceiling > 0 && spent > self.ceiling {
            return Some(ProviderStopReason::CallTokenCeiling {
                spent,
                ceiling: self.ceiling,
            });
        }
        // Earlier stages of this turn are already in the rolling ledger.
        if let Some((settled, limit)) = self.provider_budget {
            let used = settled.saturating_add(current_total);
            if used >= limit {
                return Some(ProviderStopReason::ProviderTokenBudget { used, limit });
            }
        }
        None
    }
}

fn new_tokens(tokens: UsageTokens) -> u64 {
    gyro_core::call_ceiling_tokens(
        Some(tokens.input_tokens),
        Some(tokens.cached_input_tokens),
        Some(tokens.output_tokens),
    )
}

fn goal_stop_reason(control: &ProviderRunControl, spent: u64) -> Option<ProviderStopReason> {
    let (before, limit) = (*control.goal_token_budget.lock().ok()?)?;
    let used = before.saturating_add(spent);
    (used >= limit).then_some(ProviderStopReason::GoalTokenBudget { used, limit })
}

/// Refresh the committed spend before each provider stage, including a
/// summary, its answer, and any later synthesis on the same turn.
pub(super) fn prepare_call(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    store: &SessionStore,
) -> anyhow::Result<()> {
    let control = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .and_then(|flags| flags.get(&request.session_id).cloned());
    let Some(control) = control else {
        return Ok(());
    };
    let prior = Uuid::parse_str(&request.session_id)
        .ok()
        .zip(
            request
                .turn_id
                .as_deref()
                .and_then(|turn| Uuid::parse_str(turn).ok()),
        )
        .and_then(|(session, turn)| store.direct_turn_usage_tokens(session, turn).ok().flatten());
    if let Ok(mut offset) = control.usage_offset.lock() {
        *offset = prior;
    }
    let spent = prior.map_or(0, new_tokens);
    let ceiling_stop = control.spend_guard.lock().ok().and_then(|mut state| {
        if let Some(guard) = state.as_mut() {
            guard.refresh_budget(store, request, 0);
        } else {
            let config = GyroPaths::for_current_user()
                .ok()
                .and_then(|paths| GyroConfig::load(&paths).ok())
                .map(|config| config.usage_guard)
                .unwrap_or_default();
            let budget = config
                .budgets
                .iter()
                .find(|budget| budget.provider_id == request.provider_id && budget.max_tokens > 0)
                .and_then(|budget| store.budget_state(budget, chrono::Utc::now()).ok());
            *state = Some(TurnSpendGuard::new(&config, budget));
        }
        state.as_ref()?.stop_reason(spent, 0)
    });
    if let Some(reason) = goal_stop_reason(&control, spent).or(ceiling_stop) {
        stop_provider_run(app, &request.session_id, reason);
    }
    if control.cancellation.is_cancelled() {
        anyhow::bail!(provider_stop_message(app, &request.session_id));
    }
    Ok(())
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
    let prior = control.usage_offset.lock().ok().and_then(|offset| *offset);
    let spent = new_tokens(tokens).saturating_add(prior.map_or(0, new_tokens));
    if let Some(reason) = goal_stop_reason(&control, spent) {
        stop_provider_run(app, &request.session_id, reason);
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
        guard.stop_reason(spent, tokens.total_tokens)
    });
    if let Some(reason) = reason {
        stop_provider_run(app, &request.session_id, reason);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        provider_reliability::{is_transient_provider_error, provider_failure_recovery},
        providers::{
            retry::is_provider_cancellation,
            retry_recovery::run_provider_chat_with_retry_using,
            types::{ProviderResumeCursor, ProviderRunnerOutput},
        },
    };
    use gyro_core::{ProviderSessionBinding, SessionOrigin, UsageEntry, UsageOrigin, UsageOutcome};

    fn active_stop(guard: &TurnSpendGuard, tokens: UsageTokens) -> Option<ProviderStopReason> {
        guard.stop_reason(new_tokens(tokens), tokens.total_tokens)
    }

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
                .and_then(|tokens| active_stop(&guard, tokens))
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
            active_stop(
                &guard,
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
            assert_eq!(active_stop(&guard, tokens), None);
        }
        assert!(active_stop(
            &guard,
            tokens.combine(UsageTokens::measured(Some(1), None, Some(0), None, None))
        )
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
        assert_eq!(active_stop(&guard, first), None);
        let total = first.combine(UsageTokens::measured(Some(40), None, Some(20), None, None));
        assert_eq!(
            active_stop(&guard, total),
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
            active_stop(&TurnSpendGuard::new(&disabled, Some(budget)), total),
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
            active_stop(
                &guard,
                UsageTokens::measured(Some(3_000_000), None, Some(1_000_000), None, None)
            ),
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
    fn settled_compaction_counts_toward_turn_goal_and_rolling_limits_once() {
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
        let record = |session_id, turn_id, provider: &str, origin, input| {
            store
                .record_usage(&UsageEntry {
                    session_id,
                    turn_id: Some(turn_id),
                    seat_id: None,
                    provider_id: provider.into(),
                    model_id: None,
                    reasoning_effort: None,
                    origin,
                    outcome: UsageOutcome::Done,
                    tokens: UsageTokens::measured(Some(input), None, Some(0), None, None),
                    wall_ms: 0,
                    retry_count: 0,
                })
                .unwrap();
        };
        record(
            other.id,
            Uuid::new_v4(),
            "openrouter",
            UsageOrigin::Chat,
            900,
        );
        let budget: gyro_core::UsageBudget = serde_json::from_value(serde_json::json!({
            "providerId":"openrouter", "maxTokens":1000
        }))
        .unwrap();
        let mut guard = TurnSpendGuard::new(
            &gyro_core::UsageGuardConfig::default(),
            Some(store.budget_state(&budget, chrono::Utc::now()).unwrap()),
        );
        record(
            own.id,
            turn,
            "openrouter",
            UsageOrigin::ContextCompaction,
            40,
        );
        record(other.id, Uuid::new_v4(), "mistral", UsageOrigin::Chat, 5000);
        let settled = store
            .direct_turn_usage_tokens(own.id, turn)
            .unwrap()
            .unwrap();
        let live = UsageTokens::measured(Some(50), None, Some(0), None, None);
        let spent = new_tokens(settled) + new_tokens(live);
        guard.refresh_budget(&store, &request, 1);
        assert_eq!(guard.stop_reason(spent, live.total_tokens), None);
        record(
            other.id,
            Uuid::new_v4(),
            "openrouter",
            UsageOrigin::Chat,
            30,
        );
        guard.refresh_budget(&store, &request, 2);
        assert_eq!(
            guard.stop_reason(spent, live.total_tokens),
            Some(ProviderStopReason::ProviderTokenBudget {
                used: 1020,
                limit: 1000
            })
        );

        let control = ProviderRunControl::default();
        *control.goal_token_budget.lock().unwrap() = Some((60, 150));
        assert_eq!(goal_stop_reason(&control, new_tokens(live)), None);
        assert_eq!(
            goal_stop_reason(&control, spent),
            Some(ProviderStopReason::GoalTokenBudget {
                used: 150,
                limit: 150
            })
        );
        let config = gyro_core::UsageGuardConfig {
            max_tokens_per_call: 39,
            ..Default::default()
        };
        let call_guard = TurnSpendGuard::new(&config, None);
        assert_eq!(
            call_guard.stop_reason(new_tokens(settled), 0),
            Some(ProviderStopReason::CallTokenCeiling {
                spent: 40,
                ceiling: 39,
            })
        );
    }
}
