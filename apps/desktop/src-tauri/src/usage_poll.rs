//! Coalesce account checks and back off without sleeping a worker or retrying
//! every time a chat finishes. Callers serialize access with a shared mutex.
use std::time::{Duration, Instant};

pub(crate) struct UsagePoll<T> {
    cached: Option<(Instant, Result<T, String>)>,
    failures: u32,
}

impl<T: Clone> UsagePoll<T> {
    pub(crate) fn new() -> Self {
        Self {
            cached: None,
            failures: 0,
        }
    }

    pub(crate) fn read(
        &mut self,
        now: Instant,
        fetch: impl FnOnce(&mut Duration) -> Result<T, String>,
    ) -> Result<T, String> {
        if let Some((until, result)) = &self.cached {
            if now < *until {
                return result.clone();
            }
        }
        let mut cooldown = Duration::from_secs(45 * (1 << self.failures.min(4)));
        let result = fetch(&mut cooldown);
        if result.is_ok() {
            self.failures = 0;
            cooldown = Duration::from_secs(45);
        } else {
            self.failures = self.failures.saturating_add(1);
        }
        self.cached = Some((now + cooldown, result.clone()));
        result
    }
}

pub(crate) fn retry_after(
    header: Option<&str>,
    now: chrono::DateTime<chrono::Utc>,
) -> Option<Duration> {
    let header = header?.trim();
    let seconds = header.parse::<u64>().ok().or_else(|| {
        let at = chrono::DateTime::parse_from_rfc2822(header).ok()?;
        Some((at.timestamp() - now.timestamp()).max(1) as u64)
    })?;
    // Bound untrusted server input before adding it to an Instant.
    Some(Duration::from_secs(seconds.clamp(1, 86_400)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        claude_rate_limit_used_percent, provider_usage_windows_from_anthropic_usage,
        usage_refresh_fallback, ProviderUsageSnapshot,
    };

    #[test]
    fn concurrent_callers_share_a_recent_reading() {
        let mut poll = UsagePoll::new();
        let now = Instant::now();
        assert_eq!(poll.read(now, |_| Ok(93)), Ok(93));
        assert_eq!(
            poll.read(now + Duration::from_secs(44), |_| panic!(
                "duplicate request"
            )),
            Ok(93)
        );
        assert_eq!(poll.read(now + Duration::from_secs(45), |_| Ok(94)), Ok(94));
    }

    #[test]
    fn rate_limited_requests_wait_then_recover() {
        let mut poll = UsagePoll::new();
        let now = Instant::now();
        let failed = poll.read(now, |cooldown| {
            *cooldown = Duration::from_secs(120);
            Err("Rate limited".into())
        });
        assert_eq!(
            poll.read(now + Duration::from_secs(119), |_| panic!("early retry")),
            failed
        );
        assert_eq!(
            poll.read(now + Duration::from_secs(120), |_| Ok(95)),
            Ok(95)
        );
        assert_eq!(
            poll.read(now + Duration::from_secs(165), |_| Ok(96)),
            Ok(96)
        );
    }

    #[test]
    fn repeated_failures_back_off_without_a_retry_header() {
        let mut poll: UsagePoll<i32> = UsagePoll::new();
        let now = Instant::now();
        let _ = poll.read(now, |_| Err("Offline".into()));
        let _ = poll.read(now + Duration::from_secs(45), |_| Err("Offline".into()));
        let _ = poll.read(now + Duration::from_secs(134), |_| panic!("early retry"));
        assert_eq!(
            poll.read(now + Duration::from_secs(135), |_| Ok(12)),
            Ok(12)
        );
    }

    #[test]
    fn retry_after_accepts_seconds_and_http_dates() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-09-12T13:00:00Z")
            .unwrap()
            .to_utc();
        assert_eq!(
            retry_after(Some("120"), now),
            Some(Duration::from_secs(120))
        );
        assert_eq!(
            retry_after(Some("Sat, 12 Sep 2026 13:02:00 GMT"), now),
            Some(Duration::from_secs(120))
        );
        assert_eq!(retry_after(Some("invalid"), now), None);
    }
    #[test]
    fn claude_percentage_aliases_do_not_require_utilization() {
        for key in ["usedPercent", "used_percent", "percentUsed", "percent_used"] {
            assert_eq!(
                claude_rate_limit_used_percent(&serde_json::json!({key: 37})),
                Some(37)
            );
            assert_eq!(
                claude_rate_limit_used_percent(&serde_json::json!({key: 1})),
                Some(1)
            );
        }
        assert_eq!(
            claude_rate_limit_used_percent(&serde_json::json!({"utilization": 0.93})),
            Some(93)
        );
        assert_eq!(
            claude_rate_limit_used_percent(
                &serde_json::json!({"utilization": null, "usedPercent": 12})
            ),
            Some(12)
        );
    }

    #[test]
    fn failed_usage_refresh_keeps_cache_age_and_exposes_the_error() {
        let cached = ProviderUsageSnapshot {
            provider_id: "anthropic".into(),
            windows: provider_usage_windows_from_anthropic_usage(&serde_json::json!({
                "five_hour": {"utilization": 93}
            })),
            fetched_at: "2026-09-12T13:00:00Z".into(),
            stale: false,
            error: None,
        };
        let fallback = usage_refresh_fallback(cached.clone(), "Offline".into()).unwrap();
        assert_eq!(fallback.fetched_at, cached.fetched_at);
        assert_eq!(fallback.windows, cached.windows);
        assert!(fallback.stale);
        assert_eq!(fallback.error.as_deref(), Some("Offline"));
        let empty = ProviderUsageSnapshot {
            windows: vec![],
            ..cached
        };
        assert_eq!(
            usage_refresh_fallback(empty, "Offline".into()).unwrap_err(),
            "Offline"
        );
    }
}
