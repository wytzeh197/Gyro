use crate::{
    providers::{
        chat_types::{ProviderChatRequest, ProviderChatResponse},
        retry::is_provider_cancellation,
        run::run_provider_chat_blocking_in_lease,
        session_lifecycle::ProviderSessionLease,
    },
    stores::parse_uuid,
};
use gyro_core::{timing, UsageOrigin};
// Keep the scope on the blocking worker: it must not leak across async tasks.
pub(super) fn run_timed_provider_chat(
    app: tauri::AppHandle,
    request: ProviderChatRequest,
    origin: UsageOrigin,
) -> Result<ProviderChatResponse, String> {
    run_timed_provider_chat_in_lease(app, request, origin, None)
}

pub(super) fn run_timed_provider_chat_in_lease(
    app: tauri::AppHandle,
    request: ProviderChatRequest,
    origin: UsageOrigin,
    lease: Option<&ProviderSessionLease>,
) -> Result<ProviderChatResponse, String> {
    if !timing::enabled() {
        return run_provider_chat_blocking_in_lease(app, request, origin, lease);
    }
    let session_id = parse_uuid(&request.session_id)?;
    // Legacy callers without a turn ID cannot be correlated with UI events.
    let scope = request
        .turn_id
        .as_deref()
        .map(parse_uuid)
        .transpose()?
        .map(|turn_id| timing::Scope::start(session_id, turn_id));
    let result = run_provider_chat_blocking_in_lease(app, request, origin, lease);
    if let Some(scope) = &scope {
        scope.finish(match &result {
            Ok(_) => timing::Outcome::Completed,
            Err(error) if is_provider_cancellation(error) => timing::Outcome::Cancelled,
            Err(_) => timing::Outcome::Failed,
        });
    }
    result
}

#[tauri::command]
pub(super) fn timing_diagnostics_enabled() -> bool {
    timing::enabled()
}

#[tauri::command]
pub(super) async fn record_frontend_timing(value: timing::FrontendTiming) -> Result<(), String> {
    if !value.valid() {
        return Err("invalid timing measurement".into());
    }
    if !timing::enabled() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || timing::record_frontend(&value))
        .await
        .map_err(|_| "timing worker failed".to_string())?
        .map_err(|_| "could not save local timing measurement".into())
}

#[tauri::command]
pub(super) async fn record_surface_timing(value: timing::UiTiming) -> Result<(), String> {
    if !value.valid() {
        return Err("invalid surface timing measurement".into());
    }
    if !timing::enabled() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || timing::record_surface(&value))
        .await
        .map_err(|_| "surface timing worker failed".to_string())?
        .map_err(|_| "could not save local surface timing measurement".into())
}
