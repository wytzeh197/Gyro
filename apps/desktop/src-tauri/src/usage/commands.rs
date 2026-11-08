use crate::{open_store, to_string};
use gyro_core::{GyroConfig, GyroPaths, UsageTotals};
use serde::Serialize;
/// What one provider has spent, measured by Gyro rather than reported by it.
///
/// Windows match plan meters (5-hour session + weekly), not a calendar day, so
/// the measured panel lines up with Claude/Codex allowance cards. Providers
/// without a quota API still get both rows from local spend.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderLedgerSummary {
    pub(crate) provider_id: String,
    /// Rolling 5 hours — same window as Claude/Codex session limits.
    pub(crate) five_hour: UsageTotals,
    /// Rolling 24 hours — daily pace against the weekly/100% limit.
    pub(crate) day: UsageTotals,
    /// Rolling 7 days — same window as weekly plan limits.
    pub(crate) week: UsageTotals,
    /// Present only when a budget is configured for this provider.
    pub(crate) budget: Option<gyro_core::BudgetState>,
    /// Daily denominator for the percentages when no budget is set.
    pub(crate) daily_reference_tokens: u64,
}

#[tauri::command]
pub(crate) async fn get_provider_usage_ledger(
    provider_id: String,
) -> Result<ProviderLedgerSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = open_store()?;
        let now = chrono::Utc::now();
        let five_hour = store
            .provider_usage_totals_since(&provider_id, now - chrono::Duration::hours(5))
            .map_err(to_string)?;
        let day = store
            .provider_usage_totals_since(&provider_id, now - chrono::Duration::hours(24))
            .map_err(to_string)?;
        let week = store
            .provider_usage_totals_since(&provider_id, now - chrono::Duration::days(7))
            .map_err(to_string)?;
        let guard = GyroPaths::for_current_user()
            .ok()
            .and_then(|paths| GyroConfig::load(&paths).ok())
            .map(|config| config.usage_guard)
            .unwrap_or_default();
        let budget = guard
            .budgets
            .iter()
            .find(|budget| budget.provider_id == provider_id && budget.max_tokens > 0)
            .and_then(|budget| store.budget_state(budget, now).ok());
        Ok(ProviderLedgerSummary {
            budget,
            daily_reference_tokens: guard.daily_reference_tokens,
            day,
            five_hour,
            provider_id,
            week,
        })
    })
    .await
    .map_err(|error| format!("provider usage ledger worker failed: {error}"))?
}

/// The current hold and every budget, for the UI to show and act on.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageSafetySnapshot {
    pub(crate) pause: gyro_core::PauseState,
    /// Only budgets with a cap. An unconfigured provider has nothing to show.
    pub(crate) budgets: Vec<gyro_core::BudgetState>,
}

#[tauri::command]
pub(crate) async fn get_usage_safety_snapshot() -> Result<UsageSafetySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = GyroPaths::for_current_user().map_err(to_string)?;
        let config = GyroConfig::load(&paths).map_err(to_string)?;
        let store = open_store()?;
        let now = chrono::Utc::now();
        let mut budgets = Vec::new();
        for budget in config
            .usage_guard
            .budgets
            .iter()
            .filter(|budget| budget.max_tokens > 0)
        {
            match store.budget_state(budget, now) {
                Ok(state) => budgets.push(state),
                Err(error) => eprintln!(
                    "budget for {} could not be measured: {}",
                    budget.provider_id,
                    gyro_core::security::redact_secrets(&error.to_string())
                ),
            }
        }
        // An expired auto-resume is not a pause, and the UI should not show one.
        let pause = if config.usage_guard.pause.is_active_at(now) {
            config.usage_guard.pause.clone()
        } else {
            gyro_core::PauseState::default()
        };
        Ok(UsageSafetySnapshot { budgets, pause })
    })
    .await
    .map_err(|error| format!("usage safety worker failed: {error}"))?
}

/// Set or clear one provider's spend budget.
///
/// Its own command rather than part of `save_config`: the guard block is
/// preserved natively on a renderer save so an unrelated settings write cannot
/// erase budgets or resume a pause, which means budgets need an explicit door.
/// A zero cap removes the budget rather than storing a limit of nothing.
#[tauri::command]
pub(crate) async fn set_provider_budget(
    provider_id: String,
    max_tokens: u64,
    window_hours: Option<u32>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = GyroPaths::for_current_user().map_err(to_string)?;
        GyroConfig::update(&paths, |persisted| {
            gyro_core::set_provider_budget(
                &mut persisted.usage_guard.budgets,
                &provider_id,
                max_tokens,
                window_hours,
            );
            Ok(())
        })
        .map_err(to_string)
    })
    .await
    .map_err(|error| format!("budget worker failed: {error}"))?
}

/// Hold or resume every provider run.
///
/// Separate from `save_config` so a pause survives an unrelated settings write,
/// and so stopping runs is a single call rather than a read-modify-write of the
/// whole config from the renderer.
#[tauri::command]
pub(crate) async fn set_usage_paused(
    paused: bool,
    scope: Option<gyro_core::PauseScope>,
) -> Result<bool, String> {
    let scope = scope.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let paths = GyroPaths::for_current_user().map_err(to_string)?;
        GyroConfig::update(&paths, |persisted| {
            persisted.usage_guard.pause = if paused {
                gyro_core::PauseState::manual(scope)
            } else {
                gyro_core::PauseState::default()
            };
            Ok(())
        })
        .map_err(to_string)?;
        Ok(paused)
    })
    .await
    .map_err(|error| format!("usage pause worker failed: {error}"))?
}
