use crate::{
    app::limits::DESKTOP_SHELL_SESSION_PAGE, launch_integrity, to_string, warm_store_pools,
    SessionStoreLease,
};
use gyro_core::{
    logout_account as account_logout, refresh_account_session as account_refresh_session,
    start_account_login as account_start_login, stored_account_session as account_stored_session,
    AccountSessionState, GyroConfig, GyroPaths, SessionStore,
};
use serde::Serialize;
#[tauri::command]
pub(crate) async fn load_config() -> Result<GyroConfig, String> {
    tauri::async_runtime::spawn_blocking(load_config_blocking)
        .await
        .map_err(|error| format!("config load worker failed: {error}"))?
}

pub(crate) fn load_config_blocking() -> Result<GyroConfig, String> {
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    GyroConfig::load(&paths).map_err(to_string)
}

/// Warm local storage so the shell can open the chat UI while this finishes.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WarmDesktopShellReport {
    pub(crate) ready: bool,
    pub(crate) session_count: usize,
    pub(crate) provider_count: usize,
    /// How many pooled SQLite handles were opened during warm-up.
    pub(crate) session_pool_warmed: usize,
    pub(crate) automation_pool_warmed: usize,
    /// Milliseconds spent in the blocking warm-up worker.
    pub(crate) elapsed_ms: u64,
    /// Result of `pragma quick_check` (`ok` or error text). Best-effort.
    pub(crate) integrity: String,
}

#[tauri::command]
pub(crate) async fn warm_desktop_shell() -> Result<WarmDesktopShellReport, String> {
    tauri::async_runtime::spawn_blocking(warm_desktop_shell_blocking)
        .await
        .map_err(|error| format!("desktop shell warm worker failed: {error}"))?
}

pub(crate) fn warm_desktop_shell_blocking() -> Result<WarmDesktopShellReport, String> {
    let started = std::time::Instant::now();
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    paths.ensure().map_err(to_string)?;

    // Config first so provider count is available even if store warm fails later.
    let config = GyroConfig::load(&paths).map_err(to_string)?;

    // Index maintenance and pool prefill run here so the first interactive
    // list_sessions / create_session is already hot. The integrity scan does
    // not: see `launch_integrity`.
    let store = SessionStore::open(paths.clone()).map_err(to_string)?;
    store.maintain().map_err(to_string)?;
    let session_count = store
        .list_sessions_limited(Some(DESKTOP_SHELL_SESSION_PAGE))
        .map_err(to_string)?
        .len();
    // Return this handle into the pool via Drop semantics by wrapping lease.
    {
        let _lease = SessionStoreLease { store: Some(store) };
    }

    let (session_pool_warmed, automation_pool_warmed) = warm_store_pools(&paths)?;

    // The scan runs beside the launch, so nothing below waits on it.
    launch_integrity::defer_launch_integrity_check(paths.clone());
    let integrity = launch_integrity::launch_integrity_status();

    Ok(WarmDesktopShellReport {
        ready: true,
        session_count,
        provider_count: config.model_providers.len(),
        session_pool_warmed,
        automation_pool_warmed,
        elapsed_ms: started.elapsed().as_millis() as u64,
        integrity,
    })
}

#[tauri::command]
pub(crate) async fn get_account_session() -> Result<AccountSessionState, String> {
    tauri::async_runtime::spawn_blocking(get_account_session_blocking)
        .await
        .map_err(|error| format!("account session worker failed: {error}"))?
}

pub(crate) fn get_account_session_blocking() -> Result<AccountSessionState, String> {
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    account_stored_session(&paths).map_err(to_string)
}

#[tauri::command]
pub(crate) async fn start_account_login() -> Result<AccountSessionState, String> {
    tauri::async_runtime::spawn_blocking(start_account_login_blocking)
        .await
        .map_err(|error| format!("account login worker failed: {error}"))?
}

pub(crate) fn start_account_login_blocking() -> Result<AccountSessionState, String> {
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    account_start_login(&paths).map_err(to_string)
}

#[tauri::command]
pub(crate) async fn refresh_account_session() -> Result<AccountSessionState, String> {
    tauri::async_runtime::spawn_blocking(refresh_account_session_blocking)
        .await
        .map_err(|error| format!("account refresh worker failed: {error}"))?
}

pub(crate) fn refresh_account_session_blocking() -> Result<AccountSessionState, String> {
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    account_refresh_session(&paths).map_err(to_string)
}

#[tauri::command]
pub(crate) async fn logout_account() -> Result<AccountSessionState, String> {
    tauri::async_runtime::spawn_blocking(logout_account_blocking)
        .await
        .map_err(|error| format!("account logout worker failed: {error}"))?
}

pub(crate) fn logout_account_blocking() -> Result<AccountSessionState, String> {
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    account_logout(&paths).map_err(to_string)
}

#[tauri::command]
pub(crate) async fn save_config(config: GyroConfig) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = GyroPaths::for_current_user().map_err(to_string)?;
        GyroConfig::update(&paths, |persisted| {
            *persisted = merge_renderer_config(config, persisted);
            Ok(())
        })
        .map_err(to_string)
    })
    .await
    .map_err(|error| format!("config save worker failed: {error}"))?
}

pub(crate) fn merge_renderer_config(
    mut incoming: GyroConfig,
    persisted: &GyroConfig,
) -> GyroConfig {
    // Account issuer/session state is owned by the native login flow. A renderer
    // settings write must not redirect refresh tokens or forge a signed-in user.
    incoming.account_oidc = persisted.account_oidc.clone();
    incoming.account_session = persisted.account_session.clone();
    // Usage guards are owned natively. Settings edits them through
    // `set_provider_budget` and `set_usage_paused` rather than by saving the
    // whole config, so the renderer never has a guard block worth trusting: a
    // save that omitted it would fill it from serde defaults, silently
    // resuming a paused Gyro and erasing every budget.
    incoming.usage_guard = persisted.usage_guard.clone();
    incoming.efficiency = persisted.efficiency.clone();
    incoming
}
