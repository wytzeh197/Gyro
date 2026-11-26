use crate::{
    app::limits::{CODEX_USAGE_TIMEOUT, PROVIDER_USAGE_UPDATED_EVENT},
    providers::{
        codex_app_server::{
            codex_app_server_result, receive_codex_app_server_response,
            spawn_codex_app_server_reader, write_codex_app_server_message,
        },
        process::command_for_provider,
    },
    stores::{open_store, parse_uuid, to_string},
    usage::types::{
        CodexRateLimitSnapshot, CodexRateLimitsResponse, ProviderRateLimitWindow,
        ProviderUsageSnapshot,
    },
};
use gyro_core::provider_runtime::codex_client::{CodexClient, CodexClientOptions};
use gyro_core::{SessionStore, UsageTotals};
use std::{
    collections::{HashMap, HashSet},
    process::Stdio,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::Emitter;
/// What one chat has cost, read from Gyro's own ledger.
///
/// Unlike `get_provider_usage`, this answers for every provider: it counts what
/// Gyro observed rather than what a CLI is willing to report, so Kimi, xAI, and
/// Gemini sessions get a number too — flagged as estimated where they must be.
#[tauri::command]
pub(crate) async fn get_session_usage_totals(session_id: String) -> Result<UsageTotals, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = open_store()?;
        let session_uuid = parse_uuid(&session_id)?;
        store.session_usage_totals(session_uuid).map_err(to_string)
    })
    .await
    .map_err(|error| format!("session usage worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn get_provider_usage(
    app: tauri::AppHandle,
    provider_id: String,
    fresh: Option<bool>,
) -> Result<ProviderUsageSnapshot, String> {
    let fresh = fresh.unwrap_or_default();
    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        get_provider_usage_blocking(&provider_id, fresh)
    })
    .await
    .map_err(|error| format!("provider usage worker failed: {error}"))??;
    // Other windows share the account, so they take the same reading.
    let _ = app.emit(PROVIDER_USAGE_UPDATED_EVENT, &snapshot);
    Ok(snapshot)
}

/// Read the plan again because a running turn just touched it, and push the
/// result to every window.
///
/// Claude's plan card is whatever Claude Code already emitted in stream-json.
/// A `rate_limit_event` names the window and its reset, and a used percentage
/// only when that frame included one. Gyro does not read Claude Code's stored
/// OAuth token or call the account usage API. The poll behind `fresh` still
/// coalesces bursts so a tool-heavy turn pushes at most one reading a minute.
pub(crate) fn publish_live_provider_usage(app: &tauri::AppHandle, provider_id: &str) {
    spawn_provider_usage_refresh(app, provider_id, true);
}

/// Ask again when a turn settles, even if a mid-turn read started recently.
///
/// The account poll still refuses a second network read inside its fresh
/// window. This only makes sure the settle is not dropped because the turn
/// already asked once.
pub(crate) fn publish_settled_provider_usage(app: &tauri::AppHandle, provider_id: &str) {
    spawn_provider_usage_refresh(app, provider_id, false);
}

pub(crate) fn spawn_provider_usage_refresh(
    app: &tauri::AppHandle,
    provider_id: &str,
    respect_interval: bool,
) {
    if !matches!(provider_id, "anthropic" | "openai" | "xai") {
        return;
    }
    if !claim_provider_usage_refresh(provider_id, respect_interval) {
        return;
    }
    let app = app.clone();
    let provider_id = provider_id.to_string();
    std::thread::spawn(move || {
        if let Ok(snapshot) = get_provider_usage_blocking(&provider_id, true) {
            let _ = app.emit(PROVIDER_USAGE_UPDATED_EVENT, &snapshot);
        }
    });
}

/// How long a pushed reading stays fresh. A second start inside this window
/// is skipped, so a tool-heavy turn still costs at most one push a minute.
pub(crate) const ANTHROPIC_FRESH_USAGE_MAX_AGE: Duration = Duration::from_secs(60);

pub(crate) fn claim_provider_usage_refresh(provider_id: &str, respect_interval: bool) -> bool {
    let Ok(mut slots) = provider_usage_refresh_slots().lock() else {
        return false;
    };
    if respect_interval
        && slots
            .get(provider_id)
            .is_some_and(|at| at.elapsed() < ANTHROPIC_FRESH_USAGE_MAX_AGE)
    {
        return false;
    }
    slots.insert(provider_id.to_string(), Instant::now());
    true
}

pub(crate) fn provider_usage_refresh_slots() -> &'static Mutex<HashMap<String, Instant>> {
    static SLOTS: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    SLOTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The plan windows Gyro can state for a provider right now.
///
/// 1. **OpenAI / Codex** — live `account/rateLimits/read` (5h + weekly used %).
/// 2. **xAI / Grok Build** — live `_x.ai/billing` (weekly credit % + reset).
/// 3. **Anthropic / Claude** — windows Claude Code emitted in stream-json
///    (`rate_limit_event`): the window, its reset, and a used percentage only
///    when that frame included one. Gyro does not read Claude Code's OAuth
///    token, keychain entry, `~/.claude/.credentials.json`, or
///    `api.anthropic.com/api/oauth/usage`.
/// 4. **Kimi** — stored windows only. Gyro does not read
///    `~/.kimi-code/credentials`, refresh a token under the Kimi CLI client
///    id, or call `/coding/v1/usages`.
///
/// Gemini has no usage source here; use the ledger for spend.
///
/// `fresh` asks for a reading taken within the last few seconds — set after a
/// turn, whose spend an older cached reading cannot include. Claude and Kimi
/// ignore it: there is no account call to refresh.
pub(crate) fn get_provider_usage_blocking(
    provider_id: &str,
    fresh: bool,
) -> Result<ProviderUsageSnapshot, String> {
    let _ = fresh;
    let live = match provider_id {
        "openai" => fetch_codex_provider_usage(provider_id),
        "xai" => fetch_xai_provider_usage(provider_id),
        "anthropic" => stored_provider_usage(provider_id),
        _ => return stored_provider_usage(provider_id),
    };
    let mut snapshot = match live {
        Ok(snapshot) => {
            remember_provider_rate_limits(provider_id, &snapshot.windows, &snapshot.fetched_at);
            snapshot
        }
        Err(error) => {
            // The popover shows the stale reading and this reason; the log is
            // what explains a poll that keeps failing only inside the app.
            eprintln!(
                "plan usage refresh for {provider_id} failed: {}",
                gyro_core::security::redact_secrets(&error)
            );
            usage_refresh_fallback(stored_provider_usage(provider_id)?, error)?
        }
    };
    snapshot
        .windows
        .sort_by_key(|window| match window.id.as_str() {
            "five-hour" => 0,
            "weekly" => 1,
            _ => 2,
        });
    Ok(snapshot)
}

pub(crate) fn usage_refresh_fallback(
    mut cached: ProviderUsageSnapshot,
    error: String,
) -> Result<ProviderUsageSnapshot, String> {
    if cached.windows.is_empty() {
        return Err(error);
    }
    // Preserve the observation time and explain why the reading is stale.
    cached.stale = true;
    cached.error = Some(error);
    Ok(cached)
}

/// Ask Grok Build for the real plan window (weekly credit usage + reset).
///
/// Grok exposes this on ACP as `_x.ai/billing` after `authenticate` with the
/// cached OIDC token — not on the public inference API. The TUI's
/// "Weekly limit: 46%" is exactly `creditUsagePercent` from that response.
pub(crate) fn fetch_xai_provider_usage(provider_id: &str) -> Result<ProviderUsageSnapshot, String> {
    let mut process = command_for_provider("grok", "xai").map_err(to_string)?;
    process
        .args([
            "--no-auto-update",
            "--permission-mode",
            "default",
            "agent",
            "--no-leader",
            "stdio",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = gyro_core::process_guard::spawn_service(&mut process)
        .map_err(|error| format!("could not start the Grok usage service: {error}"))?;
    let result = (|| {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Grok usage service input is unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Grok usage service output is unavailable".to_string())?;
        let messages = spawn_codex_app_server_reader(stdout, child.stderr.take());
        // Auth + billing is usually quick; allow a bit more than Codex for spawn.
        let deadline = Instant::now() + Duration::from_secs(20);

        write_codex_app_server_message(
            &mut stdin,
            &serde_json::json!({
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": 1,
                    "clientInfo": {
                        "name": "gyro",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                    "clientCapabilities": {},
                },
            }),
        )?;
        let initialize = receive_codex_app_server_response(&messages, 1, deadline)?;
        if initialize.get("error").is_some() {
            let _ = codex_app_server_result(&initialize)?;
        }

        write_codex_app_server_message(
            &mut stdin,
            &serde_json::json!({
                "id": 2,
                "method": "authenticate",
                "params": {
                    "methodId": if gyro_core::provider_has_api_key("xai") {
                        "xai.api_key"
                    } else {
                        "cached_token"
                    }
                },
            }),
        )?;
        let auth = receive_codex_app_server_response(&messages, 2, deadline)?;
        if auth.get("error").is_some() {
            return Err(auth
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("Grok authentication failed")
                .to_string());
        }

        write_codex_app_server_message(
            &mut stdin,
            &serde_json::json!({
                "id": 3,
                "method": "_x.ai/billing",
                "params": {},
            }),
        )?;
        let response = receive_codex_app_server_response(&messages, 3, deadline)?;
        let payload = codex_app_server_result(&response)?;
        let windows = provider_usage_windows_from_xai_billing(&payload);
        if windows.is_empty() {
            return Err("Grok billing did not report a plan usage window".into());
        }
        Ok(ProviderUsageSnapshot {
            stale: false,
            error: None,
            provider_id: provider_id.into(),
            windows,
            fetched_at: chrono::Utc::now().to_rfc3339(),
        })
    })();
    let _ = child.kill();
    let _ = child.wait();
    result
}

/// Map Grok's `_x.ai/billing` payload onto Gyro plan windows.
pub(crate) fn provider_usage_windows_from_xai_billing(
    payload: &serde_json::Value,
) -> Vec<ProviderRateLimitWindow> {
    let config = payload.get("config").unwrap_or(payload);
    let used_percent = config
        .get("creditUsagePercent")
        .and_then(serde_json::Value::as_f64)
        .map(|value| value.round().clamp(0.0, 100.0) as i32);
    let period = config.get("currentPeriod");
    let period_type = period
        .and_then(|value| value.get("type"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let (id, label) = match period_type {
        "USAGE_PERIOD_TYPE_WEEKLY" | "WEEKLY" | "weekly" => ("weekly", "Weekly limit"),
        "USAGE_PERIOD_TYPE_MONTHLY" | "MONTHLY" | "monthly" => ("monthly", "Monthly limit"),
        "USAGE_PERIOD_TYPE_FIVE_HOUR" | "USAGE_PERIOD_TYPE_5_HOUR" | "FIVE_HOUR" | "five_hour" => {
            ("five-hour", "5-hour limit")
        }
        _ => {
            // SuperGrok Build currently ships a weekly credit window; fall back
            // to weekly so an unknown type still surfaces as a plan card.
            ("weekly", "Weekly limit")
        }
    };
    let resets_at = period
        .and_then(|value| value.get("end"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            config
                .get("billingPeriodEnd")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        });
    let Some(used_percent) = used_percent else {
        return Vec::new();
    };
    vec![ProviderRateLimitWindow {
        id: id.into(),
        label: label.into(),
        status: plan_window_status(used_percent).into(),
        used_percent: Some(used_percent),
        resets_at,
    }]
}

/// Replay a provider's last known windows, expired ones already dropped.
pub(crate) fn stored_provider_usage(provider_id: &str) -> Result<ProviderUsageSnapshot, String> {
    let store = open_store()?;
    let windows = store
        .provider_rate_limits(provider_id, chrono::Utc::now())
        .map_err(to_string)?;
    Ok(ProviderUsageSnapshot {
        stale: false,
        error: None,
        provider_id: provider_id.into(),
        fetched_at: windows
            .iter()
            .map(|window| window.observed_at.clone())
            .max()
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
        windows: windows
            .into_iter()
            .map(|window| ProviderRateLimitWindow {
                id: window.window_id,
                label: window.label,
                status: window.status,
                used_percent: window.used_percent,
                resets_at: window.resets_at,
            })
            .collect(),
    })
}

/// Store a complete poll reading, so the next session starts informed.
///
/// A poll names every window the account meters, so it replaces what was there
/// rather than merging into it — otherwise a window the plan dropped (or one
/// Gyro used to mis-name) would be replayed as real on the next failed poll.
///
/// Best-effort by design: a limit Gyro could not write down must never be the
/// reason a provider call or its usage row fails.
pub(crate) fn remember_provider_rate_limits(
    provider_id: &str,
    windows: &[ProviderRateLimitWindow],
    observed_at: &str,
) {
    if windows.is_empty() {
        return;
    }
    let store = match open_store() {
        Ok(store) => store,
        Err(error) => {
            warn_unrecorded_rate_limits(&error);
            return;
        }
    };
    if let Err(error) = store.replace_provider_rate_limits(
        provider_id,
        &provider_rate_limit_records(windows, observed_at),
    ) {
        warn_unrecorded_rate_limits(&error.to_string());
    }
}

/// The stored shape of a set of windows, all observed at the same moment.
pub(crate) fn provider_rate_limit_records(
    windows: &[ProviderRateLimitWindow],
    observed_at: &str,
) -> Vec<gyro_core::ProviderRateLimitRecord> {
    windows
        .iter()
        .map(|window| gyro_core::ProviderRateLimitRecord {
            window_id: window.id.clone(),
            label: window.label.clone(),
            status: window.status.clone(),
            used_percent: window.used_percent,
            resets_at: window.resets_at.clone(),
            observed_at: observed_at.to_string(),
        })
        .collect()
}

/// What a turn reported mid-answer, for callers already holding the store open.
///
/// A stream names only the windows that turn touched, so this merges: the
/// windows it did not mention are still real and keep their last reading.
pub(crate) fn remember_provider_rate_limits_in(
    store: &SessionStore,
    provider_id: &str,
    windows: &[ProviderRateLimitWindow],
) {
    if windows.is_empty() {
        return;
    }
    let records = provider_rate_limit_records(windows, &chrono::Utc::now().to_rfc3339());
    if let Err(error) = store.record_provider_rate_limits(provider_id, &records) {
        warn_unrecorded_rate_limits(&error.to_string());
    }
}

pub(crate) fn warn_unrecorded_rate_limits(error: &str) {
    eprintln!(
        "provider reported a plan limit that was not recorded: {}",
        gyro_core::security::redact_secrets(error)
    );
}

pub(crate) fn fetch_codex_provider_usage(
    provider_id: &str,
) -> Result<ProviderUsageSnapshot, String> {
    let process = command_for_provider("codex", "openai").map_err(to_string)?;
    let mut options = CodexClientOptions::desktop();
    options.service = true;
    let mut child = CodexClient::spawn(process, options)
        .map_err(|error| format!("could not start the Codex usage service: {error}"))?;
    let result = (|| {
        let (mut stdin, messages) = child.take_io()?;
        let deadline = Instant::now() + CODEX_USAGE_TIMEOUT;

        write_codex_app_server_message(
            &mut stdin,
            &serde_json::json!({
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": {
                        "name": "gyro",
                        "title": "Gyro",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                    "capabilities": { "experimentalApi": true },
                },
            }),
        )?;
        let initialize = receive_codex_app_server_response(&messages, 1, deadline)?;
        codex_app_server_result(&initialize)?;

        write_codex_app_server_message(
            &mut stdin,
            &serde_json::json!({ "method": "initialized" }),
        )?;
        write_codex_app_server_message(
            &mut stdin,
            &serde_json::json!({
                "id": 2,
                "method": "account/rateLimits/read",
            }),
        )?;
        let response = receive_codex_app_server_response(&messages, 2, deadline)?;
        let payload = codex_app_server_result(&response)?;
        let response: CodexRateLimitsResponse = serde_json::from_value(payload)
            .map_err(|error| format!("Codex returned an unsupported usage response: {error}"))?;
        Ok(ProviderUsageSnapshot {
            stale: false,
            error: None,
            provider_id: provider_id.into(),
            windows: provider_usage_windows_from_codex(&response.rate_limits),
            fetched_at: chrono::Utc::now().to_rfc3339(),
        })
    })();
    drop(child);
    result
}

/// The state a plan window is in, read off how full it is.
///
/// Providers report a level, not a state, so the state is derived. The
/// thresholds match the ones the composer colours by.
pub(crate) fn plan_window_status(used_percent: i32) -> &'static str {
    match used_percent {
        100.. => "exhausted",
        80..=99 => "warning",
        _ => "ok",
    }
}

/// Name a plan window after the span it actually meters.
///
/// An account meters whatever its plan sells: 5-hour and weekly on Codex's
/// paid tiers, a single monthly window on the free one, whatever Kimi's
/// membership carries. Naming a window after the slot it arrived in
/// ("primary") turned a 30-day allowance into a row labelled "5-hour window",
/// so the duration is the only thing that gets to name it.
pub(crate) fn plan_window_identity(minutes: i64) -> (String, String) {
    match minutes {
        300 => ("five-hour".into(), "5-hour window".into()),
        10_080 => ("weekly".into(), "Weekly window".into()),
        1_440 => ("daily".into(), "Daily window".into()),
        43_200 => ("monthly".into(), "Monthly window".into()),
        _ if minutes % 10_080 == 0 => {
            let weeks = minutes / 10_080;
            (format!("{weeks}-week"), format!("{weeks}-week window"))
        }
        _ if minutes % 1_440 == 0 => {
            let days = minutes / 1_440;
            (format!("{days}-day"), format!("{days}-day window"))
        }
        _ if minutes % 60 == 0 => {
            let hours = minutes / 60;
            (format!("{hours}-hour"), format!("{hours}-hour window"))
        }
        _ => (
            format!("{minutes}-minute"),
            format!("{minutes}-minute window"),
        ),
    }
}

pub(crate) fn provider_usage_windows_from_codex(
    snapshot: &CodexRateLimitSnapshot,
) -> Vec<ProviderRateLimitWindow> {
    let mut windows = Vec::new();
    let mut seen = HashSet::new();
    for (window, fallback_id, fallback_label) in [
        (snapshot.primary.as_ref(), "five-hour", "5-hour window"),
        (snapshot.secondary.as_ref(), "weekly", "Weekly window"),
    ] {
        let Some(window) = window else {
            continue;
        };
        let (id, label) = match window.window_duration_mins {
            Some(minutes) if minutes > 0 => plan_window_identity(minutes),
            // Only a window that never said how long it runs falls back to the
            // slot it arrived in.
            _ => (fallback_id.to_string(), fallback_label.to_string()),
        };
        if !seen.insert(id.clone()) {
            continue;
        }
        let used_percent = window.used_percent.clamp(0, 100);
        windows.push(ProviderRateLimitWindow {
            id,
            label,
            status: plan_window_status(used_percent).into(),
            used_percent: Some(used_percent),
            resets_at: window
                .resets_at
                .and_then(|timestamp| chrono::DateTime::from_timestamp(timestamp, 0))
                .map(|timestamp| timestamp.to_rfc3339()),
        });
    }
    windows.sort_by_key(|window| if window.id == "five-hour" { 0 } else { 1 });
    windows
}
