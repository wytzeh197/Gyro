//! Kimi Code plan usage: the OAuth sign-in the CLI keeps and the account
//! usage endpoint behind its own usage view.

use super::*;

/// Where Kimi Code writes the OAuth token for the managed account.
///
/// The CLI names each slot after the sign-in it belongs to: `kimi-code` is the
/// default host's, and a self-hosted endpoint gets its own name. Gyro reads the
/// default slot and falls back to the only other one present, so a custom
/// endpoint still resolves without asking for a second sign-in.
pub(crate) const KIMI_CREDENTIALS_DIR: &str = ".kimi-code/credentials";
pub(crate) const KIMI_DEFAULT_CREDENTIALS_FILE: &str = "kimi-code.json";
/// The account endpoint behind Kimi Code's own usage view.
pub(crate) const KIMI_USAGE_URL: &str = "https://api.kimi.com/coding/v1/usages";

/// Ask Kimi what the plan meters, the way Kimi Code asks it.
///
/// The CLI signs in once and keeps an OAuth token; its usage view is a plain
/// `GET /usages` carrying that token. Gyro asks the same endpoint rather than
/// standing up a second sign-in.
///
/// The route this replaces drove `kimi acp` and prompted `/usage`, which only
/// ever reads back the throwaway probe session's own context occupancy — a
/// number that says nothing about the plan, sitting under "Plan usage limits"
/// claiming otherwise.
pub(crate) fn fetch_kimi_provider_usage(
    provider_id: &str,
) -> Result<ProviderUsageSnapshot, String> {
    let token = kimi_oauth_access_token()?;
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(10))
        .build();
    let payload: serde_json::Value = agent
        .get(KIMI_USAGE_URL)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Accept", "application/json")
        .call()
        .map_err(|error| match error {
            ureq::Error::Status(401 | 403, _) => {
                "Kimi Code sign-in was rejected. Run `kimi login` to read your plan usage."
                    .to_string()
            }
            // The endpoint belongs to the Kimi For Coding membership. An
            // account without one is not broken; it has no plan to meter.
            ureq::Error::Status(404, _) => {
                "This Kimi account does not publish plan usage limits.".to_string()
            }
            ureq::Error::Status(status, _) => {
                format!("Kimi could not report plan usage ({status}).")
            }
            other => format!("Kimi could not report plan usage: {other}"),
        })?
        .into_json()
        .map_err(|error| format!("Kimi returned an unreadable usage response: {error}"))?;
    let windows = provider_usage_windows_from_kimi_usages(&payload);
    if windows.is_empty() {
        return Err("Kimi did not report a plan usage window".into());
    }
    Ok(ProviderUsageSnapshot {
        stale: false,
        error: None,
        provider_id: provider_id.into(),
        windows,
        fetched_at: chrono::Utc::now().to_rfc3339(),
    })
}

/// Kimi's sign-in service, which mints an access token from the refresh token
/// the CLI stored, and the client the CLI signs in as. The refresh grant is
/// bound to that client, so Gyro presents the same one.
pub(crate) const KIMI_OAUTH_TOKEN_URL: &str = "https://auth.kimi.com/api/oauth/token";
pub(crate) const KIMI_OAUTH_CLIENT_ID: &str = "17e5f671-d194-4dfb-9706-5516cb48c098";
/// How close to expiry a stored access token counts as already spent.
pub(crate) const KIMI_SIGN_IN_RENEWAL_MARGIN_MS: i64 = 60_000;

/// What the stored Kimi sign-in can offer right now.
pub(crate) enum KimiSignIn {
    /// The stored access token still has life left in it.
    Current(String),
    /// It has not, but the refresh token beside it mints another.
    Renewable(String),
}

/// Renewed sign-in material, as Kimi's token endpoint answers it.
pub(crate) struct KimiSignInRenewal {
    pub(crate) access_token: String,
    pub(crate) refresh_token: String,
    pub(crate) expires_in: i64,
    pub(crate) scope: String,
    pub(crate) token_type: String,
}

/// Read the Kimi Code OAuth access token this machine already holds, renewing
/// it first where the stored one has run out.
///
/// Kimi's access tokens last a quarter of an hour, so the stored one is almost
/// always spent by the time anything asks for it. The refresh token beside it
/// is the durable half of the sign-in; renewing off that is the ordinary path
/// here rather than a fallback, and it is what any `kimi` run does too.
pub(crate) fn kimi_oauth_access_token() -> Result<String, String> {
    let signed_out = || "Sign in to Kimi Code to read your plan usage.".to_string();
    let path = kimi_credentials_path().ok_or_else(signed_out)?;
    let raw = std::fs::read_to_string(&path).map_err(|_| signed_out())?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    match kimi_sign_in_at(&raw, now_ms)? {
        KimiSignIn::Current(token) => Ok(token),
        KimiSignIn::Renewable(refresh_token) => {
            let renewal = kimi_renew_sign_in(&refresh_token)?;
            let access_token = renewal.access_token.clone();
            // Kimi rotates the refresh token on renewal, which would strand
            // the CLI on one the service no longer honours. Handing the
            // renewal back to the slot it came from keeps the single sign-in
            // shared, exactly as another `kimi` run would leave it. A slot
            // that cannot be written still leaves this reading good, so the
            // usage view is not failed over a bookkeeping problem.
            let _ = store_kimi_sign_in(&path, &renewal, now_ms);
            Ok(access_token)
        }
    }
}

/// The credential slot this machine's Kimi sign-in wrote.
pub(crate) fn kimi_credentials_path() -> Option<PathBuf> {
    let directory = user_home_directory().ok()?.join(KIMI_CREDENTIALS_DIR);
    let default = directory.join(KIMI_DEFAULT_CREDENTIALS_FILE);
    if default.is_file() {
        return Some(default);
    }
    // A sign-in against a custom host writes one differently named slot
    // instead. Only a lone slot is unambiguous, so several are left to the
    // default's absence.
    let mut slots = std::fs::read_dir(&directory)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|kind| kind == "json"));
    let only = slots.next()?;
    slots.next().is_none().then_some(only)
}

/// Read the stored sign-in against a fixed clock.
pub(crate) fn kimi_sign_in_at(raw: &str, now_ms: i64) -> Result<KimiSignIn, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| "Kimi Code credentials could not be read.")?;
    // The CLI writes the server's own snake_case wire shape; other builds have
    // nested it under `token` in camelCase, so each spelling is tried.
    let record = parsed.get("token").unwrap_or(&parsed);
    let field = |names: [&str; 2]| {
        names
            .into_iter()
            .find_map(|name| record.get(name))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    let expiry = ["expires_at", "expiresAt"]
        .into_iter()
        .find_map(|name| record.get(name))
        .and_then(kimi_timestamp_ms);
    // An unstamped token is treated as spent: renewing one that had life left
    // costs a request, while trusting one that had none costs the reading.
    let spent = match expiry {
        Some(at) => at <= now_ms + KIMI_SIGN_IN_RENEWAL_MARGIN_MS,
        None => true,
    };
    match (
        spent,
        field(["access_token", "accessToken"]),
        field(["refresh_token", "refreshToken"]),
    ) {
        (false, Some(access_token), _) => Ok(KimiSignIn::Current(access_token)),
        (_, _, Some(refresh_token)) => Ok(KimiSignIn::Renewable(refresh_token)),
        (true, Some(_), None) => Err(
            "Kimi Code's sign-in has lapsed. Run `kimi login` to read your plan usage.".to_string(),
        ),
        _ => Err("Kimi Code credentials do not include an access token.".to_string()),
    }
}

/// Trade the refresh token for a fresh access token.
pub(crate) fn kimi_renew_sign_in(refresh_token: &str) -> Result<KimiSignInRenewal, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(10))
        .build();
    let payload: serde_json::Value = agent
        .post(KIMI_OAUTH_TOKEN_URL)
        .set("Accept", "application/json")
        .send_form(&[
            ("client_id", KIMI_OAUTH_CLIENT_ID),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
        ])
        .map_err(|error| match error {
            // A refused grant is a sign-in that has ended, not a fault: the
            // refresh token has been spent, revoked, or has outlived its own
            // window. Only signing in again mints another.
            ureq::Error::Status(400 | 401 | 403, _) => {
                "Kimi Code's sign-in has lapsed. Run `kimi login` to read your plan usage."
                    .to_string()
            }
            ureq::Error::Status(status, _) => {
                format!("Kimi could not renew the sign-in ({status}).")
            }
            other => format!("Kimi could not renew the sign-in: {other}"),
        })?
        .into_json()
        .map_err(|error| format!("Kimi returned an unreadable sign-in response: {error}"))?;
    kimi_sign_in_renewal(&payload, refresh_token)
}

/// Read the token endpoint's answer.
pub(crate) fn kimi_sign_in_renewal(
    payload: &serde_json::Value,
    previous_refresh_token: &str,
) -> Result<KimiSignInRenewal, String> {
    let text = |key: &str| {
        payload
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    Ok(KimiSignInRenewal {
        access_token: text("access_token")
            .ok_or("Kimi's sign-in renewal did not include an access token.")?,
        // A renewal that rotates nothing keeps the refresh token it was given.
        refresh_token: text("refresh_token").unwrap_or_else(|| previous_refresh_token.to_string()),
        // An unstated lifetime is no lifetime: the next reading renews again
        // rather than trusting a span the service never promised.
        expires_in: kimi_int(payload.get("expires_in"))
            .unwrap_or_default()
            .max(0),
        scope: text("scope").unwrap_or_default(),
        token_type: text("token_type").unwrap_or_else(|| "Bearer".to_string()),
    })
}

/// Hand a renewed sign-in back to the slot the CLI reads.
///
/// Same wire shape, same private file, same write-to-temporary-then-rename the
/// CLI itself uses, so a renewal Gyro made is indistinguishable from one made
/// by `kimi` — and a half-written file never replaces a good one.
pub(crate) fn store_kimi_sign_in(
    path: &Path,
    renewal: &KimiSignInRenewal,
    now_ms: i64,
) -> Result<(), String> {
    let body = serde_json::json!({
        "access_token": renewal.access_token,
        "refresh_token": renewal.refresh_token,
        "expires_at": now_ms / 1_000 + renewal.expires_in,
        "scope": renewal.scope,
        "token_type": renewal.token_type,
        "expires_in": renewal.expires_in,
    });
    let mut text = serde_json::to_string_pretty(&body).map_err(to_string)?;
    text.push('\n');
    let directory = path
        .parent()
        .ok_or("Kimi credentials are not in a directory")?;
    let temporary = directory.join(format!(".gyro-kimi-sign-in-{}.tmp", Uuid::new_v4()));
    let written = (|| -> Result<(), String> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(to_string)?;
        file.write_all(text.as_bytes()).map_err(to_string)?;
        file.sync_all().map_err(to_string)?;
        fs::rename(&temporary, path).map_err(to_string)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written
}

/// A moment Kimi may have written as epoch seconds, epoch millis, or a date.
pub(crate) fn kimi_timestamp_ms(value: &serde_json::Value) -> Option<i64> {
    if let Some(text) = value.as_str() {
        return chrono::DateTime::parse_from_rfc3339(text)
            .ok()
            .map(|moment| moment.timestamp_millis());
    }
    let number = kimi_int(Some(value))?;
    // Seconds and milliseconds are told apart by scale: an epoch in seconds
    // stays ten digits until the year 5138.
    Some(if number.abs() < 100_000_000_000 {
        number * 1_000
    } else {
        number
    })
}

/// A count Kimi may have sent as a number or as a string.
pub(crate) fn kimi_int(value: Option<&serde_json::Value>) -> Option<i64> {
    match value? {
        serde_json::Value::Number(number) => number.as_f64().map(|value| value.trunc() as i64),
        serde_json::Value::String(text) => text
            .trim()
            .parse::<f64>()
            .ok()
            .map(|value| value.trunc() as i64),
        _ => None,
    }
}

/// How many minutes a Kimi usage window spans.
pub(crate) fn kimi_window_minutes(window: &serde_json::Value) -> Option<i64> {
    let duration = kimi_int(window.get("duration"))?;
    let unit = match window.get("timeUnit").and_then(serde_json::Value::as_str)? {
        "TIME_UNIT_MINUTE" => 1,
        "TIME_UNIT_HOUR" => 60,
        "TIME_UNIT_DAY" => 1_440,
        "TIME_UNIT_WEEK" => 10_080,
        _ => return None,
    };
    (duration > 0).then_some(duration * unit)
}

/// One metered window, as Gyro shows it.
pub(crate) fn kimi_usage_window(
    id: String,
    label: String,
    detail: &serde_json::Value,
) -> Option<ProviderRateLimitWindow> {
    let used = kimi_int(detail.get("used"));
    let limit = kimi_int(detail.get("limit"));
    if used.is_none() && limit.is_none() {
        return None;
    }
    // A window with no ceiling is metered but unbounded. The row still belongs
    // in the list; the percentage it cannot honestly claim is left off.
    let used_percent = match (used, limit) {
        (Some(used), Some(limit)) if limit > 0 => Some(
            (used as f64 / limit as f64 * 100.0)
                .round()
                .clamp(0.0, 100.0) as i32,
        ),
        _ => None,
    };
    Some(ProviderRateLimitWindow {
        id,
        label,
        status: used_percent.map_or("unknown", plan_window_status).into(),
        used_percent,
        resets_at: detail
            .get("resetTime")
            .and_then(serde_json::Value::as_str)
            .filter(|moment| !moment.is_empty())
            .map(str::to_string),
    })
}

/// Read Kimi's `/usages` answer into the windows Gyro shows.
///
/// Every window the plan meters arrives in `limits`, each one a `window` of
/// `{duration, timeUnit}` beside a `detail` of `{used, limit, resetTime}`. The
/// plan's headline allowance arrives separately as `usage`, with no window of
/// its own — the CLI reads that one as weekly, and so does this.
pub(crate) fn provider_usage_windows_from_kimi_usages(
    payload: &serde_json::Value,
) -> Vec<ProviderRateLimitWindow> {
    let mut windows: Vec<(i64, ProviderRateLimitWindow)> = Vec::new();
    let mut seen = HashSet::new();
    for entry in payload
        .get("limits")
        .and_then(serde_json::Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let Some(minutes) = entry.get("window").and_then(kimi_window_minutes) else {
            continue;
        };
        let name = entry
            .get("name")
            .and_then(serde_json::Value::as_str)
            .filter(|name| !name.is_empty());
        let (mut id, mut label) = plan_window_identity(minutes);
        // Two allowances can share a span — a per-model cap beside the plan's
        // own. Where that happens the name is the only thing telling them
        // apart, so the second one is named after it rather than dropped.
        if seen.contains(&id) {
            let Some(name) = name else { continue };
            id = name.to_lowercase().replace(' ', "-");
            label = name.to_string();
        }
        if !seen.insert(id.clone()) {
            continue;
        }
        let detail = entry.get("detail").unwrap_or(entry);
        if let Some(window) = kimi_usage_window(id, label, detail) {
            windows.push((minutes, window));
        }
    }
    if !seen.contains("weekly") {
        if let Some(window) = payload
            .get("usage")
            .and_then(|usage| kimi_usage_window("weekly".into(), "Weekly limit".into(), usage))
        {
            windows.push((10_080, window));
        }
    }
    // The window a run hits first is the one worth reading first.
    windows.sort_by_key(|(minutes, _)| *minutes);
    windows.into_iter().map(|(_, window)| window).collect()
}
