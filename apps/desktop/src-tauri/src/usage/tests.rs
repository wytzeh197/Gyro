use super::*;

#[test]
fn ollama_turn_usage_counts_tool_rounds_without_fabricating_missing_counts() {
    let mut usage = OllamaTurnUsage::default();
    assert!(usage.measured().is_none());
    usage.observe(Some(100), Some(20));
    usage.observe(Some(180), Some(30));
    let measured = usage.measured().unwrap();
    assert_eq!(measured.input_tokens, Some(280));
    assert_eq!(measured.output_tokens, Some(50));
    assert_eq!(measured.total_tokens, Some(330));
    usage.observe(None, Some(10));
    assert!(usage.measured().is_none());
    usage.observe(Some(0), Some(0));
    assert!(usage.measured().is_none());
}

#[test]
fn claude_stream_context_usage_counts_cached_input() {
    let (frame, usage) = provider_context_usage_from_claude_stream(&serde_json::json!({
        "type": "result",
        "usage": {
            "input_tokens": 10,
            "cache_creation_input_tokens": 7415,
            "cache_read_input_tokens": 11609,
            "output_tokens": 53
        },
        "modelUsage": {
            "claude-haiku-4-5": { "contextWindow": 200000 }
        }
    }))
    .unwrap();
    assert_eq!(frame, ClaudeUsageFrame::Turn);
    // The window is what the conversation occupies, not what the last
    // request re-sent, so both cache buckets count toward the input.
    assert_eq!(usage.input_tokens, Some(19_034));
    assert_eq!(usage.cached_input_tokens, Some(19_024));
    assert_eq!(usage.total_tokens, Some(19_087));
    assert_eq!(usage.model_context_window, Some(200_000));
}

#[test]
fn claude_stream_context_usage_tracks_assistant_frames() {
    let (frame, usage) = provider_context_usage_from_claude_stream(&serde_json::json!({
        "type": "assistant",
        "message": {
            "usage": { "input_tokens": 10, "cache_read_input_tokens": 500, "output_tokens": 3 }
        }
    }))
    .unwrap();
    assert_eq!(frame, ClaudeUsageFrame::Request);
    assert_eq!(usage.input_tokens, Some(510));
    assert_eq!(usage.model_context_window, None);
}

#[test]
fn claude_usage_deduplicates_message_snapshots_and_latches_final_total() {
    let mut state = StreamingCommandState::new();
    let usage = |output| ProviderContextUsage {
        input_tokens: Some(100),
        cached_input_tokens: Some(80),
        output_tokens: Some(output),
        reasoning_output_tokens: None,
        total_tokens: Some(100 + output),
        model_context_window: None,
        ..ProviderContextUsage::default()
    };
    state.apply_claude_context_usage(ClaudeUsageFrame::Request, usage(10), Some("a"));
    state.apply_claude_context_usage(ClaudeUsageFrame::Request, usage(10), Some("a"));
    assert_eq!(state.billed_usage.as_ref().unwrap().total_tokens, Some(110));
    state.apply_claude_context_usage(ClaudeUsageFrame::Request, usage(20), Some("a"));
    state.apply_claude_context_usage(ClaudeUsageFrame::Request, usage(5), Some("b"));
    assert_eq!(state.billed_usage.as_ref().unwrap().total_tokens, Some(225));
    state.apply_claude_context_usage(ClaudeUsageFrame::Request, usage(10), Some("a"));
    assert_eq!(
        state.billed_usage.as_ref().unwrap().total_tokens,
        Some(225),
        "stale snapshots do not reduce or add spend"
    );
    state.apply_claude_context_usage(ClaudeUsageFrame::Turn, usage(150), None);
    state.apply_claude_context_usage(ClaudeUsageFrame::Request, usage(99), Some("b"));
    assert_eq!(state.billed_usage.as_ref().unwrap().total_tokens, Some(250));
}

#[test]
fn providers_without_reported_usage_still_carry_a_window() {
    // Gemini and Grok run through ACP, which reports no tokens at all. The
    // meter still has to measure against the right window.
    let usage = provider_context_usage_with_window(None, "gemini", Some("gemini-default")).unwrap();
    assert_eq!(usage.model_context_window, Some(1_048_576));
    assert_eq!(usage.input_tokens, None);

    let reported = provider_context_usage_with_window(
        Some(ProviderContextUsage {
            input_tokens: Some(1_000),
            ..ProviderContextUsage::default()
        }),
        "xai",
        Some("grok-4.5"),
    )
    .unwrap();
    assert_eq!(reported.model_context_window, Some(256_000));
    assert_eq!(reported.input_tokens, Some(1_000));
}

/// `codex exec` reports only a running total for the thread, which passes
/// the window after a few turns. The meter keeps the window and falls back
/// to its own estimate rather than reporting tokens the window cannot hold.
#[test]
fn usage_larger_than_the_window_is_treated_as_a_billing_total() {
    let usage = provider_context_usage_with_window(
        Some(ProviderContextUsage {
            input_tokens: Some(29_142_187),
            cached_input_tokens: Some(28_661_248),
            output_tokens: Some(37_749),
            ..ProviderContextUsage::default()
        }),
        "openai",
        Some("gpt-5.4-mini"),
    )
    .unwrap();
    assert_eq!(usage.model_context_window, Some(400_000));
    assert_eq!(usage.input_tokens, None);
    assert_eq!(usage.total_tokens, None);

    // A reading the window can hold is left exactly as reported.
    let intact = provider_context_usage_with_window(
        Some(ProviderContextUsage {
            input_tokens: Some(90_767),
            output_tokens: Some(105),
            total_tokens: Some(90_872),
            ..ProviderContextUsage::default()
        }),
        "openai",
        Some("gpt-5.4-mini"),
    )
    .unwrap();
    assert_eq!(intact.total_tokens, Some(90_872));
}

#[test]
fn claude_rate_limit_events_name_the_window_and_reset() {
    let window = provider_rate_limit_from_claude_stream(&serde_json::json!({
        "type": "rate_limit_event",
        "rate_limit_info": {
            "status": "allowed",
            "resetsAt": 1785157800,
            "rateLimitType": "five_hour",
            "isUsingOverage": false
        }
    }))
    .unwrap();
    assert_eq!(window.id, "five-hour");
    assert_eq!(window.label, "5-hour limit");
    assert_eq!(window.status, "ok");
    // Claude Code never says how much of the window is spent, and a bar
    // filled to an invented level is worse than an unfilled one.
    assert_eq!(window.used_percent, None);
    assert!(window.resets_at.is_some());
}

#[test]
fn rate_limit_windows_keep_the_newest_reading_shortest_first() {
    let mut windows = Vec::new();
    for (raw_type, status) in [
        ("weekly", "allowed"),
        ("five_hour", "allowed"),
        ("five_hour", "rejected"),
    ] {
        let window = provider_rate_limit_from_claude_stream(&serde_json::json!({
            "type": "rate_limit_event",
            "rate_limit_info": { "status": status, "rateLimitType": raw_type }
        }))
        .unwrap();
        merge_provider_rate_limit(&mut windows, window);
    }
    assert_eq!(windows.len(), 2);
    assert_eq!(windows[0].id, "five-hour");
    assert_eq!(windows[0].status, "exhausted");
    assert_eq!(windows[1].id, "weekly");
}

/// A settled refresh used to reread the store and write that snapshot back
/// after the stream had already recorded a `rate_limit_event`. The replay's
/// `observed_at` ties the row the event just updated, so the replace put the
/// stale status back and deleted windows the event had added.
#[test]
fn claude_rate_limit_event_beats_a_stale_store_reread() {
    let temp = tempfile::tempdir().expect("temp store");
    let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("store")))
        .expect("open store");
    let now = chrono::Utc::now();
    let observed_at = (now - chrono::Duration::seconds(30)).to_rfc3339();
    let resets_at_unix = now.timestamp() + 3 * 60 * 60;
    let resets_at = chrono::DateTime::from_timestamp(resets_at_unix, 0)
        .expect("reset time")
        .to_rfc3339();
    store
        .record_provider_rate_limits(
            "anthropic",
            &[gyro_core::ProviderRateLimitRecord {
                window_id: "five-hour".into(),
                label: "5-hour limit".into(),
                status: "ok".into(),
                used_percent: Some(40),
                resets_at: Some(resets_at),
                observed_at: observed_at.clone(),
            }],
        )
        .expect("seed stale window");

    let stale_five_hour = provider_rate_limit_from_claude_stream(&serde_json::json!({
        "type": "rate_limit_event",
        "rate_limit_info": {
            "status": "allowed",
            "resetsAt": resets_at_unix,
            "rateLimitType": "five_hour",
            "utilization": 0.4
        }
    }))
    .expect("stale five-hour window");
    let fresh = [
        provider_rate_limit_from_claude_stream(&serde_json::json!({
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "approaching_limit",
                "resetsAt": resets_at_unix,
                "rateLimitType": "five_hour"
            }
        }))
        .expect("fresh five-hour window"),
        provider_rate_limit_from_claude_stream(&serde_json::json!({
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "allowed",
                "resetsAt": resets_at_unix + 7 * 24 * 60 * 60,
                "rateLimitType": "weekly"
            }
        }))
        .expect("fresh weekly window"),
    ];
    // The turn records the event, then the reread that started earlier
    // tries to write its captured snapshot back.
    crate::usage::fetch::remember_provider_rate_limits_in(&store, "anthropic", &fresh);
    crate::usage::fetch::remember_polled_provider_rate_limits(
        &store,
        "anthropic",
        &[stale_five_hour],
        &observed_at,
    );

    let stored = store
        .provider_rate_limits("anthropic", now)
        .expect("read windows");
    let five_hour = stored
        .iter()
        .find(|window| window.window_id == "five-hour")
        .expect("five-hour window");
    assert_eq!(five_hour.status, "warning");
    assert_eq!(five_hour.used_percent, Some(40));
    assert!(
        stored.iter().any(|window| window.window_id == "weekly"),
        "the event's weekly window must survive the stale replace"
    );
    assert!(!crate::usage::fetch::usage_poll_replaces_stored_windows(
        "anthropic"
    ));
    assert!(crate::usage::fetch::usage_poll_replaces_stored_windows(
        "openai"
    ));
    assert!(crate::usage::fetch::usage_poll_replaces_stored_windows(
        "xai"
    ));
}

#[test]
fn unknown_rate_limit_windows_still_reach_the_composer() {
    let window = provider_rate_limit_from_claude_stream(&serde_json::json!({
        "type": "rate_limit_event",
        "rate_limit_info": { "status": "warning", "rateLimitType": "monthly_opus" }
    }))
    .unwrap();
    assert_eq!(window.id, "monthly-opus");
    assert_eq!(window.label, "Monthly opus limit");
    assert_eq!(window.status, "warning");
}

#[test]
fn xai_billing_maps_weekly_credit_usage_percent() {
    let windows = provider_usage_windows_from_xai_billing(&serde_json::json!({
        "config": {
            "creditUsagePercent": 46.0,
            "currentPeriod": {
                "type": "USAGE_PERIOD_TYPE_WEEKLY",
                "start": "2026-08-02T14:24:07.516124+00:00",
                "end": "2026-08-09T14:24:07.516124+00:00"
            },
            "billingPeriodEnd": "2026-08-09T14:24:07.516124+00:00"
        },
        "subscription_tier": "SuperGrok"
    }));
    assert_eq!(windows.len(), 1);
    assert_eq!(windows[0].id, "weekly");
    assert_eq!(windows[0].label, "Weekly limit");
    assert_eq!(windows[0].used_percent, Some(46));
    assert_eq!(windows[0].status, "ok");
    assert_eq!(
        windows[0].resets_at.as_deref(),
        Some("2026-08-09T14:24:07.516124+00:00")
    );
}
