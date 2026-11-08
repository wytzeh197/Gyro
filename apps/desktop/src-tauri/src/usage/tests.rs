use super::*;

#[test]
#[ignore = "requires a locally signed-in Claude Code CLI"]
fn live_anthropic_provider_usage_reads_the_current_account() {
    let snapshot = fetch_anthropic_provider_usage("anthropic", false).unwrap();

    assert_eq!(snapshot.provider_id, "anthropic");
    assert!(!snapshot.windows.is_empty());
    for window in &snapshot.windows {
        eprintln!(
            "{} ({}) {:?}% resets {:?}",
            window.id, window.label, window.used_percent, window.resets_at
        );
    }
}

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

/// The shape `/usages` answers with: one entry per metered window, the
/// span in `window`, the reading in `detail`.
#[test]
fn kimi_usages_map_every_window_the_plan_meters() {
    let windows = provider_usage_windows_from_kimi_usages(&serde_json::json!({
        "usage": { "used": 120, "limit": 400 },
        "limits": [
            {
                "name": "Weekly",
                "window": { "duration": 1, "timeUnit": "TIME_UNIT_WEEK" },
                "detail": {
                    "used": 120,
                    "limit": 400,
                    "resetTime": "2026-08-29T00:00:00Z"
                }
            },
            {
                "name": "5-hour",
                "window": { "duration": 300, "timeUnit": "TIME_UNIT_MINUTE" },
                "detail": { "used": "96", "limit": "100" }
            }
        ]
    }));
    // The window a run hits first leads, whatever order the plan listed.
    assert_eq!(windows.len(), 2);
    assert_eq!(windows[0].id, "five-hour");
    assert_eq!(windows[0].label, "5-hour window");
    assert_eq!(windows[0].used_percent, Some(96));
    assert_eq!(windows[0].status, "warning");
    assert_eq!(windows[1].id, "weekly");
    assert_eq!(windows[1].used_percent, Some(30));
    assert_eq!(windows[1].status, "ok");
    assert_eq!(
        windows[1].resets_at.as_deref(),
        Some("2026-08-29T00:00:00Z")
    );
    // The headline allowance is the weekly one, so it is not listed twice.
    assert!(!windows.iter().any(|window| window.label == "Weekly limit"));
}

/// A plan that states only its headline allowance still gets a row: the
/// CLI reads that one as weekly, and an unmetered ceiling as no percentage
/// rather than as zero, which would read as a full allowance.
#[test]
fn kimi_usages_fall_back_to_the_headline_allowance() {
    let windows = provider_usage_windows_from_kimi_usages(&serde_json::json!({
        "usage": { "used": 400, "limit": 400 }
    }));
    assert_eq!(windows.len(), 1);
    assert_eq!(windows[0].id, "weekly");
    assert_eq!(windows[0].label, "Weekly limit");
    assert_eq!(windows[0].status, "exhausted");

    let unbounded = provider_usage_windows_from_kimi_usages(&serde_json::json!({
        "usage": { "used": 12, "limit": 0 }
    }));
    assert_eq!(unbounded[0].used_percent, None);
    assert_eq!(unbounded[0].status, "unknown");

    // Nothing metered is nothing to show, rather than an invented window.
    assert!(provider_usage_windows_from_kimi_usages(&serde_json::json!({})).is_empty());
    assert!(
        provider_usage_windows_from_kimi_usages(&serde_json::json!({ "usage": {} })).is_empty()
    );
}

/// Two allowances can share a span. The name is the only thing telling
/// them apart, so the second is named after it instead of overwriting the
/// first or vanishing.
#[test]
fn kimi_usages_keep_two_allowances_that_share_a_span() {
    let windows = provider_usage_windows_from_kimi_usages(&serde_json::json!({
        "limits": [
            {
                "name": "Plan",
                "window": { "duration": 1, "timeUnit": "TIME_UNIT_WEEK" },
                "detail": { "used": 1, "limit": 10 }
            },
            {
                "name": "K3 Max",
                "window": { "duration": 7, "timeUnit": "TIME_UNIT_DAY" },
                "detail": { "used": 9, "limit": 10 }
            }
        ]
    }));
    assert_eq!(
        windows
            .iter()
            .map(|window| (window.id.as_str(), window.used_percent))
            .collect::<Vec<_>>(),
        vec![("weekly", Some(10)), ("k3-max", Some(90))]
    );
}

#[test]
#[ignore = "requires a locally signed-in Kimi Code CLI"]
fn live_kimi_provider_usage_reads_the_current_account() {
    // The live poll, not the cached fallback around it: a stored row from
    // an earlier build would otherwise pass for a fresh reading.
    let snapshot = fetch_kimi_provider_usage("kimi").unwrap();
    assert_eq!(snapshot.provider_id, "kimi");
    assert!(!snapshot.stale);
    // An account outside the Kimi For Coding membership is metered by
    // nothing: a settled empty reading that says so, never a failure.
    if snapshot.windows.is_empty() {
        assert_eq!(snapshot.error.as_deref(), Some(KIMI_NO_PLAN_LIMITS));
    }
    for window in &snapshot.windows {
        eprintln!(
            "{} ({}) {:?}% resets {:?}",
            window.id, window.label, window.used_percent, window.resets_at
        );
    }
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

/// The account endpoint is the only source that measures a Claude plan
/// window: the chat stream names the window and its reset but never how
/// full it is, which is what left both bars showing an em dash.
#[test]
fn anthropic_account_usage_maps_measured_plan_windows() {
    let windows = provider_usage_windows_from_anthropic_usage(&serde_json::json!({
        "five_hour": {
            "utilization": 64.0,
            "resets_at": "2026-08-04T13:30:00.259542+00:00"
        },
        "seven_day": {
            "utilization": 91.0,
            "resets_at": "2026-08-09T16:59:59.259573+00:00"
        },
        "seven_day_opus": serde_json::Value::Null,
        "seven_day_sonnet": serde_json::Value::Null
    }));
    assert_eq!(windows.len(), 2);
    assert_eq!(windows[0].id, "five-hour");
    assert_eq!(windows[0].label, "5-hour limit");
    assert_eq!(windows[0].used_percent, Some(64));
    assert_eq!(windows[0].status, "ok");
    assert_eq!(
        windows[0].resets_at.as_deref(),
        Some("2026-08-04T13:30:00.259542+00:00")
    );
    assert_eq!(windows[1].id, "weekly");
    assert_eq!(windows[1].label, "Weekly limit");
    assert_eq!(windows[1].used_percent, Some(91));
    assert_eq!(windows[1].status, "warning");
}

/// A plan that meters an Opus-only week says so, and one that meters
/// nothing at all leaves the composer on the streamed windows rather than
/// on bars sitting at zero.
#[test]
fn anthropic_account_usage_only_reports_windows_the_plan_meters() {
    let scoped = provider_usage_windows_from_anthropic_usage(&serde_json::json!({
        "five_hour": { "utilization": 100.0 },
        "seven_day_opus": { "utilization": 12.0 }
    }));
    assert_eq!(
        scoped
            .iter()
            .map(|window| (window.id.as_str(), window.status.as_str()))
            .collect::<Vec<_>>(),
        vec![("five-hour", "exhausted"), ("weekly-opus", "ok")]
    );
    assert!(scoped[0].resets_at.is_none());

    assert!(
        provider_usage_windows_from_anthropic_usage(&serde_json::json!({
            "five_hour": serde_json::Value::Null,
            "extra_usage": { "is_enabled": false }
        }))
        .is_empty()
    );
}
