#[cfg(target_os = "macos")]
use crate::run_bounded_command_with_cancellation;
use crate::{
    app::limits::{CODEX_USAGE_TIMEOUT, PROVIDER_USAGE_UPDATED_EVENT},
    claude_usage_cli, codex_app_server_result, command_for_provider,
    diagnostics::export::user_home_directory,
    fetch_kimi_provider_usage, open_store, parse_uuid, receive_codex_app_server_response,
    spawn_codex_app_server_reader, to_string,
    usage::types::{
        CodexRateLimitSnapshot, CodexRateLimitsResponse, ProviderRateLimitWindow,
        ProviderUsageSnapshot,
    },
    usage_poll, write_codex_app_server_message,
};
#[cfg(target_os = "macos")]
use gyro_core::{CancellationToken, ExecutionTermination};
use gyro_core::{SessionStore, UsageTotals};
use std::{
    collections::{HashMap, HashSet},
    fs,
    process::{Command, Stdio},
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
/// Claude Code announces a plan window at the start of each request but never
/// says how full it is, so the announcement is the cue to ask the account API.
/// A new request's occupancy is the same cue: the meter moves during the turn,
/// not only after it. The poll behind `fresh` coalesces bursts, and a second
/// start inside that minute is skipped, so a tool-heavy turn still costs at
/// most one account read a minute.
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
    if !matches!(provider_id, "anthropic" | "openai" | "xai" | "kimi") {
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
/// 3. **Anthropic / Claude** — live `/api/oauth/usage` (5h + weekly used %),
///    falling back to the windows streamed mid-answer, which carry a reset but
///    no percentage.
/// 4. **Kimi** — live `GET /coding/v1/usages` with the CLI's OAuth sign-in.
///    An account outside the Kimi For Coding membership gets nothing back;
///    that is a reading with no windows, not a failure.
///
/// Gemini has no usage source here; use the ledger for spend.
///
/// `fresh` asks for a reading taken within the last few seconds — set after a
/// turn, whose spend an older cached reading cannot include.
pub(crate) fn get_provider_usage_blocking(
    provider_id: &str,
    fresh: bool,
) -> Result<ProviderUsageSnapshot, String> {
    let live = match provider_id {
        "openai" => fetch_codex_provider_usage(provider_id),
        "xai" => fetch_xai_provider_usage(provider_id),
        "anthropic" => fetch_anthropic_provider_usage(provider_id, fresh),
        "kimi" => fetch_kimi_provider_usage(provider_id),
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

/// Where Claude Code keeps the OAuth token Gyro reuses to read plan usage.
///
/// The keychain entry is written by `claude login` and refreshed by the CLI on
/// every run; the file is the same JSON on machines without a keychain.
pub(crate) const CLAUDE_CREDENTIALS_KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
pub(crate) const CLAUDE_CREDENTIALS_FILE: &str = ".claude/.credentials.json";
/// The account endpoint behind Claude Code's own `/usage`.
pub(crate) const ANTHROPIC_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";

/// Read the Claude Code OAuth access token this machine already holds.
///
/// Gyro never asks for a second login: the plan windows belong to the same
/// account the chat runs on, so the token the CLI keeps is the one to use.
pub(crate) fn claude_oauth_access_token() -> Result<String, String> {
    let raw = claude_credentials_json()
        .ok_or_else(|| "Sign in to Claude Code to read your plan usage.".to_string())?;
    claude_oauth_access_token_at(&raw, chrono::Utc::now().timestamp_millis())
}

/// The same, against a fixed clock.
pub(crate) fn claude_oauth_access_token_at(raw: &str, now_ms: i64) -> Result<String, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| "Claude Code credentials could not be read.")?;
    let oauth = parsed.get("claudeAiOauth").unwrap_or(&parsed);
    // A lapsed token is worth reporting plainly: the CLI mints a new one on its
    // next run, so the user's fix is to use Claude rather than debug Gyro.
    //
    // Which fix, though, depends on the refresh token beside it. While that is
    // still good, any Claude turn — including one sent from Gyro — refreshes
    // the access token; once it too has lapsed, nothing short of signing in
    // again will. Telling the two apart is the difference between "keep
    // working" and "go log in", so the message says which one this is.
    let lapsed = |key: &str| {
        oauth
            .get(key)
            .and_then(serde_json::Value::as_i64)
            .is_some_and(|at| at > 0 && at < now_ms)
    };
    if lapsed("expiresAt") {
        return Err(if lapsed("refreshTokenExpiresAt") {
            "Claude Code is signed out. Run `claude auth login` to read your plan usage.".into()
        } else {
            "Claude Code's token has lapsed. Send a Claude message to refresh it.".to_string()
        });
    }
    oauth
        .get("accessToken")
        .and_then(serde_json::Value::as_str)
        .filter(|token| !token.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| "Claude Code credentials do not include an access token.".to_string())
}

pub(crate) fn claude_credentials_json() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("security");
        command.args([
            "find-generic-password",
            "-s",
            CLAUDE_CREDENTIALS_KEYCHAIN_SERVICE,
            "-w",
        ]);
        // Bounded: the usage poll holds its lock across this read, and an
        // unanswered Keychain prompt must not wedge every later poll.
        let timeout = Duration::from_secs(30);
        let cancel = CancellationToken::default();
        if let Ok(output) =
            run_bounded_command_with_cancellation(&command, timeout, None, 64 * 1024, 4096, cancel)
        {
            if matches!(
                output.termination,
                ExecutionTermination::Exited { code: Some(0) }
            ) {
                let raw = output.stdout.trim().to_string();
                if !raw.is_empty() {
                    return Some(raw);
                }
            }
        }
    }
    let path = user_home_directory().ok()?.join(CLAUDE_CREDENTIALS_FILE);
    fs::read_to_string(path).ok()
}

/// Post-turn reads accept a minute-old reading; idle ones hold five. The account
/// endpoint allows few requests per account, and a 45-second poll locked it out.
pub(crate) const ANTHROPIC_FRESH_USAGE_MAX_AGE: Duration = Duration::from_secs(60);
pub(crate) const ANTHROPIC_USAGE_HOLD: Duration = Duration::from_secs(300);

/// Ask the Anthropic account API what the plan windows are actually at.
///
/// The chat stream is not a source for this: Claude Code's `rate_limit_event`
/// names the window and its reset but carries no utilization, which is why the
/// composer sat on two em dashes. `/api/oauth/usage` is the same endpoint the
/// CLI's own `/usage` reads, and it answers with a percentage per window.
pub(crate) fn fetch_anthropic_provider_usage(
    provider_id: &str,
    fresh: bool,
) -> Result<ProviderUsageSnapshot, String> {
    static POLL: OnceLock<Mutex<usage_poll::UsagePoll<ProviderUsageSnapshot>>> = OnceLock::new();
    let mut poll = POLL
        .get_or_init(|| Mutex::new(usage_poll::UsagePoll::holding(ANTHROPIC_USAGE_HOLD)))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let max_age = fresh.then_some(ANTHROPIC_FRESH_USAGE_MAX_AGE);
    poll.read_within(
        Instant::now(),
        max_age,
        |cooldown| match fetch_anthropic_provider_usage_once(provider_id, cooldown) {
            Err(error) if anthropic_usage_needs_cli_refresh(&error) => {
                refresh_anthropic_usage_through_cli(provider_id, cooldown, error)
            }
            other => other,
        },
    )
}

/// A lapsed or refused token is one only the CLI can renew. A rate limit or an
/// outage is not, and asking the CLI then would only repeat the same request.
pub(crate) fn anthropic_usage_needs_cli_refresh(error: &str) -> bool {
    error.starts_with("Claude Code's token has lapsed")
        || error.starts_with("Claude Code sign-in was rejected")
}

/// Let `claude -p /usage` renew the token, then read the account again.
///
/// The command makes no model request, so it costs nothing against the plan.
/// When the endpoint still refuses, the levels the command printed are a live
/// reading in their own right.
pub(crate) fn refresh_anthropic_usage_through_cli(
    provider_id: &str,
    cooldown: &mut Duration,
    original: String,
) -> Result<ProviderUsageSnapshot, String> {
    let cli_windows = match claude_usage_cli::read_claude_usage_via_cli() {
        Ok(windows) => windows,
        Err(cli_error) => {
            eprintln!("Claude usage through the CLI failed: {cli_error}");
            return Err(original);
        }
    };
    fetch_anthropic_provider_usage_once(provider_id, cooldown).or_else(|_| {
        Ok(ProviderUsageSnapshot {
            stale: false,
            error: None,
            provider_id: provider_id.into(),
            windows: cli_windows,
            fetched_at: chrono::Utc::now().to_rfc3339(),
        })
    })
}

pub(crate) fn fetch_anthropic_provider_usage_once(
    provider_id: &str,
    cooldown: &mut Duration,
) -> Result<ProviderUsageSnapshot, String> {
    let token = claude_oauth_access_token()?;
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(10))
        .build();
    let response = agent
        .get(ANTHROPIC_USAGE_URL)
        .set("Authorization", &format!("Bearer {token}"))
        .set("anthropic-beta", "oauth-2025-04-20")
        .set("Content-Type", "application/json")
        .call()
        .map_err(|error| match error {
            ureq::Error::Status(401 | 403, _) => {
                // The stored token had not lapsed by its own clock, so a refusal
                // here means it is no longer a valid sign-in — revoked, or from
                // an account that has since signed out. Another Claude turn will
                // not mint a good one; only signing in again will.
                "Claude Code sign-in was rejected. Run `claude auth login` to read your plan usage."
                    .to_string()
            }
            ureq::Error::Status(429, response) => {
                if let Some(retry) = usage_poll::retry_after(response.header("Retry-After"), chrono::Utc::now()) {
                    *cooldown = (*cooldown).max(retry);
                }
                format!("Claude usage checks are temporarily rate-limited. Gyro will retry automatically after {} seconds.", cooldown.as_secs())
            }
            ureq::Error::Status(status, _) => {
                format!("Anthropic usage request failed (HTTP {status}).")
            }
            ureq::Error::Transport(_) => {
                "Anthropic usage is unreachable right now (offline?).".to_string()
            }
        })?;
    let payload: serde_json::Value = response
        .into_json()
        .map_err(|_| "Anthropic usage response could not be read.".to_string())?;
    let windows = provider_usage_windows_from_anthropic_usage(&payload);
    if windows.is_empty() {
        return Err("Anthropic reported no plan usage window for this account.".into());
    }
    Ok(ProviderUsageSnapshot {
        stale: false,
        error: None,
        provider_id: provider_id.into(),
        windows,
        fetched_at: chrono::Utc::now().to_rfc3339(),
    })
}

/// Map the account payload onto Gyro plan windows.
///
/// Every window is optional and a plan only carries the ones it meters, so an
/// absent key is left out rather than rendered as an empty bar. Model-scoped
/// weekly limits (Opus, Sonnet) only appear on plans that have them.
pub(crate) fn provider_usage_windows_from_anthropic_usage(
    payload: &serde_json::Value,
) -> Vec<ProviderRateLimitWindow> {
    let mut windows = anthropic_usage_windows_by_key(payload);
    // Accounts can return both shapes with only some keyed windows populated.
    // Resolve each window independently so a measured weekly key cannot hide
    // a measured session limit in the list.
    for incoming in anthropic_usage_windows_from_limits(payload) {
        if let Some(existing) = windows.iter_mut().find(|window| window.id == incoming.id) {
            if existing.used_percent.is_none() {
                *existing = incoming;
            }
        } else {
            windows.push(incoming);
        }
    }
    windows
}

/// The long-standing shape: one object per window, keyed by its name.
pub(crate) fn anthropic_usage_windows_by_key(
    payload: &serde_json::Value,
) -> Vec<ProviderRateLimitWindow> {
    let mut windows: Vec<ProviderRateLimitWindow> = [
        ("five_hour", "five-hour", "5-hour limit"),
        ("seven_day", "weekly", "Weekly limit"),
        ("seven_day_opus", "weekly-opus", "Weekly · Opus"),
        ("seven_day_sonnet", "weekly-sonnet", "Weekly · Sonnet"),
    ]
    .into_iter()
    .filter_map(|(key, id, label)| {
        let window = payload.get(key)?;
        let used_percent = window
            .get("utilization")
            .and_then(serde_json::Value::as_f64)
            .map(|value| value.round().clamp(0.0, 100.0) as i32)?;
        let status = match used_percent {
            100 => "exhausted",
            80..=99 => "warning",
            _ => "ok",
        };
        Some(ProviderRateLimitWindow {
            id: id.into(),
            label: label.into(),
            status: status.into(),
            used_percent: Some(used_percent),
            resets_at: window
                .get("resets_at")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
        })
    })
    .collect();
    // The 5-hour session only opens with the first message after the last one
    // closed, and until then the account reports it as null. Beside a measured
    // week that null is still a window the plan meters. Leaving it out made the
    // row vanish whenever Claude sat idle. It is not a measurement of zero:
    // the level stays absent until the account reports a utilization.
    let session_idle = payload.get("five_hour").is_some_and(|window| {
        window.is_null()
            || window
                .get("utilization")
                .and_then(serde_json::Value::as_f64)
                .is_none()
    });
    if session_idle && windows.iter().any(|window| window.id == "weekly") {
        windows.insert(
            0,
            ProviderRateLimitWindow {
                id: "five-hour".into(),
                label: "5-hour limit".into(),
                status: "ok".into(),
                used_percent: None,
                resets_at: None,
            },
        );
    }
    windows
}

/// The newer `limits` list the same response also carries.
///
/// Only read when the keyed windows are missing, so a response that drops the
/// old keys still yields a reading instead of "no plan usage window".
pub(crate) fn anthropic_usage_windows_from_limits(
    payload: &serde_json::Value,
) -> Vec<ProviderRateLimitWindow> {
    let Some(limits) = payload.get("limits").and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };
    limits
        .iter()
        .filter_map(|limit| {
            let (id, label) = match limit.get("kind").and_then(serde_json::Value::as_str)? {
                "session" => ("five-hour", "5-hour limit"),
                "weekly_all" => ("weekly", "Weekly limit"),
                "weekly_opus" => ("weekly-opus", "Weekly · Opus"),
                "weekly_sonnet" => ("weekly-sonnet", "Weekly · Sonnet"),
                _ => return None,
            };
            let used_percent = limit
                .get("percent")
                .and_then(serde_json::Value::as_f64)
                .map(|value| value.round().clamp(0.0, 100.0) as i32)?;
            Some(ProviderRateLimitWindow {
                id: id.into(),
                label: label.into(),
                status: plan_window_status(used_percent).into(),
                used_percent: Some(used_percent),
                resets_at: limit
                    .get("resets_at")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
            })
        })
        .collect()
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
    let mut process = command_for_provider("codex", "openai").map_err(to_string)?;
    process
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = gyro_core::process_guard::spawn_service(&mut process)
        .map_err(|error| format!("could not start the Codex usage service: {error}"))?;
    let result = (|| {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Codex usage service input is unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Codex usage service output is unavailable".to_string())?;
        let messages = spawn_codex_app_server_reader(stdout, child.stderr.take());
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
    let _ = child.kill();
    let _ = child.wait();
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
