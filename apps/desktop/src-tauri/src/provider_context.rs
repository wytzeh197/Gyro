//! Provider-reported context accounting and catalog-window normalization.

#[cfg(test)]
use serde_json::Value;

pub(super) fn provider_model_context_window(
    provider_id: &str,
    model_id: Option<&str>,
) -> Option<u64> {
    if let Some(window) =
        model_id.and_then(|model| crate::live_model_context::known_window(provider_id, model))
    {
        return Some(window);
    }
    catalog_context_window(provider_id, model_id)
}

pub(super) fn catalog_context_window(provider_id: &str, model_id: Option<&str>) -> Option<u64> {
    if let Some(window) = crate::model_catalog::catalog_model_profile(provider_id, model_id)
        .and_then(|profile| profile.context_window_tokens)
    {
        return Some(window);
    }
    gyro_core::provider_runtime::api_config::fallback_context_window(provider_id, model_id)
}

pub(super) fn provider_context_usage_with_window(
    reported: Option<ProviderContextUsage>,
    provider_id: &str,
    model_id: Option<&str>,
) -> Option<ProviderContextUsage> {
    let catalog_window = provider_model_context_window(provider_id, model_id);
    match reported {
        Some(mut usage) => {
            if usage.model_context_window.is_none() {
                usage.model_context_window = catalog_window;
            }
            if usage.estimated || exceeds_context_window(&usage) {
                // A character estimate, a traffic sum, and a multi-call bill
                // are not occupancy. Keep the window and drop the count
                // instead of painting the meter from a number the provider
                // did not report as the window fill.
                usage = ProviderContextUsage {
                    model_context_window: usage.model_context_window,
                    ..ProviderContextUsage::default()
                };
            }
            Some(usage)
        }
        None => catalog_window.map(|window| ProviderContextUsage {
            model_context_window: Some(window),
            ..ProviderContextUsage::default()
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn antigravity_steps_report_their_own_prompt_as_occupancy() {
        let step = serde_json::json!({"event":"step_update","step_update":{"step_index":3,
            "usage":{"input_tokens":30384,"output_tokens":4,"thinking_tokens":2,
            "cache_read_tokens":30214,"total_tokens":30388}}});
        let usage = antigravity_step_occupancy(&step).expect("step occupancy");
        assert_eq!(usage.input_tokens, Some(30384));
        assert_eq!(usage.cached_input_tokens, Some(30214));
        assert_eq!(usage.total_tokens, Some(30388));
        assert_eq!(usage.model_context_window, None);
        // The result frame is cumulative across a resumed conversation.
        let result = serde_json::json!({"event":"result","result":{"status":"SUCCESS",
            "usage":{"input_tokens":90000,"output_tokens":20,"total_tokens":90020}}});
        assert!(antigravity_step_occupancy(&result).is_none());
        let text = serde_json::json!({"event":"step_update","step_update":{"text_delta":"Hi"}});
        assert!(antigravity_step_occupancy(&text).is_none());
    }

    #[test]
    fn api_models_supply_windows_for_usage_and_compaction() {
        for (provider, model, window) in [
            ("anthropic", "claude-opus-5-5", 1_000_000),
            ("anthropic", "claude-opus-5", 1_000_000),
            ("anthropic", "claude-opus-4-8", 1_000_000),
            ("anthropic", "claude-haiku-4-5", 200_000),
            ("deepseek", "deepseek-flash", 1_000_000),
            ("deepseek", "deepseek-v4-pro", 1_000_000),
            ("mistral", "mistral-medium-latest", 256_000),
            ("mistral", "mistral-large-latest", 256_000),
            ("mistral", "mistral-small-latest", 256_000),
            ("mistral", "codestral-latest", 128_000),
            ("openrouter", "anthropic/claude-sonnet-5", 1_000_000),
            ("openrouter", "anthropic/claude-opus-5", 1_000_000),
            ("openrouter", "openai/gpt-6-astra", 1_050_000),
            ("openrouter", "google/gemini-3.8-flash", 1_048_576),
            ("openrouter", "x-ai/grok-4.7", 500_000),
            ("openrouter", "x-ai/grok-4.6", 500_000),
            ("openrouter", "deepseek/deepseek-v4.1-flash", 1_048_576),
            ("openrouter", "moonshotai/kimi-k3", 1_048_576),
            ("openrouter", "moonshotai/kimi-k3.1-pro", 1_048_576),
            ("kimi", "k3.1-pro", 262_144),
            ("kimi", "k3.1-pro-highspeed", 1_048_576),
            ("openrouter", "z-ai/glm-5.3", 1_048_576),
            ("openrouter", "qwen/qwen3.8-max-0902", 1_000_000),
            ("openrouter", "meta-llama/llama-3.3-70b-instruct", 131_072),
        ] {
            let usage = provider_context_usage_with_window(None, provider, Some(model)).unwrap();
            assert_eq!(
                usage.model_context_window,
                Some(window),
                "{provider}/{model}"
            );
            assert_eq!(
                auto_compaction_fill(
                    Some((window * 9).div_ceil(10)),
                    None,
                    usage.model_context_window,
                    90
                ),
                Some(90)
            );
        }
        assert_eq!(
            provider_model_context_window("openrouter", Some("unknown")),
            None
        );
    }

    #[test]
    fn provisioned_runtime_windows_override_offline_baselines() {
        for (provider, model, window) in [
            ("kimi", "k3", 1_048_576),
            ("openai", "gpt-6.1-sol", 475_000),
            ("xai", "grok-4.3", 131_072),
        ] {
            let usage = provider_context_usage_with_window(
                Some(ProviderContextUsage {
                    input_tokens: Some(1_024),
                    model_context_window: Some(window),
                    ..ProviderContextUsage::default()
                }),
                provider,
                Some(model),
            )
            .unwrap();
            assert_eq!(usage.model_context_window, Some(window));
            assert_eq!(usage.input_tokens, Some(1_024));
        }
    }

    #[test]
    fn grok_prompt_usage_is_billed_with_cached_reads_inside_input() {
        let usage = provider_billed_usage_from_acp(&serde_json::json!({
            "inputTokens": 18_177_618u64,
            "cachedReadTokens": 18_036_352u64,
            "cacheCreationTokens": 0,
            "outputTokens": 35_877,
            "reasoningTokens": 33_992,
            "totalTokens": 18_213_495u64
        }))
        .unwrap();
        assert_eq!(usage.input_tokens, Some(18_177_618));
        assert_eq!(usage.cached_input_tokens, Some(18_036_352));
        assert_eq!(usage.output_tokens, Some(35_877));
        assert_eq!(usage.reasoning_output_tokens, Some(33_992));
        assert_eq!(usage.total_tokens, Some(18_213_495));
        assert_eq!(usage.model_context_window, None);
        assert!(provider_billed_usage_from_acp(&serde_json::json!({"outputTokens": 3})).is_none());
    }

    #[test]
    fn live_context_note_replaces_itself_instead_of_stacking() {
        let mut messages = vec![serde_json::json!({"role": "user", "content": "do the task"})];
        refresh_context_checkpoint(&mut messages, Some(54_321), Some(1_200), Some(272_000));
        assert_eq!(messages.len(), 2);
        let note = messages[1]["content"].as_str().unwrap();
        assert!(note.starts_with(CONTEXT_CHECKPOINT_MARKER));
        assert!(note.contains("54321 prompt + 1200 output tokens"));
        assert!(note.contains("272000-token window (79% free)"));
        assert_eq!(messages[0]["content"], "do the task");

        refresh_context_checkpoint(&mut messages, Some(60_000), Some(900), Some(272_000));
        assert_eq!(messages.len(), 2, "the earlier note is rewritten in place");
        let note = messages[1]["content"].as_str().unwrap();
        assert!(note.contains("60000 prompt + 900 output tokens"));
    }

    #[test]
    fn live_context_note_needs_a_measurement_and_names_an_unknown_window() {
        let mut messages = Vec::new();
        refresh_context_checkpoint(&mut messages, None, Some(12), Some(272_000));
        assert!(messages.is_empty(), "an unmeasured request writes no note");

        refresh_context_checkpoint(&mut messages, Some(1_000), None, None);
        let note = messages[0]["content"].as_str().unwrap();
        assert!(note.contains("1000 prompt tokens"));
        assert!(note.contains("no window size known"));

        // A round the provider left unmeasured clears the stale reading
        // instead of leaving a number the model would read as current.
        refresh_context_checkpoint(&mut messages, None, None, None);
        assert!(messages.is_empty());
    }

    fn tool_exchange(round: usize, result_characters: usize) -> Vec<Value> {
        vec![
            serde_json::json!({
                "role": "assistant",
                "content": format!("round {round}"),
                "tool_calls": [{
                    "id": format!("call-{round}"),
                    "type": "function",
                    "function": { "name": "gyro_workspace_read", "arguments": "{}" }
                }]
            }),
            serde_json::json!({
                "role": "tool",
                "tool_call_id": format!("call-{round}"),
                "content": "x".repeat(result_characters)
            }),
        ]
    }

    fn loop_with_exchanges(count: usize, result_characters: usize) -> Vec<Value> {
        let mut messages = vec![
            serde_json::json!({ "role": "system", "content": "identity" }),
            serde_json::json!({ "role": "user", "content": "context" }),
        ];
        for round in 0..count {
            messages.extend(tool_exchange(round, result_characters));
        }
        messages
    }

    /// Every kept tool result still has the assistant call it answers.
    fn assert_calls_and_results_stay_paired(messages: &[Value]) {
        let mut open = std::collections::HashSet::new();
        for message in messages {
            match message_role(message) {
                Some("assistant") => {
                    open.clear();
                    for call in message
                        .get("tool_calls")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                    {
                        if let Some(id) = call.get("id").and_then(Value::as_str) {
                            open.insert(id.to_string());
                        }
                    }
                }
                Some("tool") => {
                    let id = message
                        .get("tool_call_id")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    assert!(
                        open.contains(id),
                        "tool result {id} lost the assistant call it answers"
                    );
                }
                // Image observations can appear between tool results.
                _ => {}
            }
        }
    }

    #[test]
    fn auto_compaction_replaces_the_oldest_exchanges_and_keeps_pairs_intact() {
        let mut messages = loop_with_exchanges(6, 4_000);
        let compaction =
            auto_compact_messages(&mut messages, Some(7_000), Some(100), Some(8_000), 80)
                .expect("a request past the configured share compacts");
        assert_eq!(compaction.percent, 88, "7100 of 8000 is the measured fill");
        assert!(compaction.exchanges >= 1);
        assert_eq!(message_role(&messages[0]), Some("system"));
        assert_eq!(messages[1]["content"], "context");
        let note = messages[2]["content"].as_str().unwrap();
        assert!(note.starts_with(CONTEXT_COMPACTION_MARKER));
        assert!(note.contains("88%"));
        assert!(note.contains(&format!(
            "the {} oldest tool exchanges",
            compaction.exchanges
        )));
        // The newest exchange always survives, and nothing is orphaned.
        assert_eq!(messages.last().unwrap()["tool_call_id"], "call-5");
        assert_calls_and_results_stay_paired(&messages);
        let kept = messages
            .iter()
            .filter(|message| message_role(message) == Some("assistant"))
            .count();
        assert!(
            kept >= 1 && kept < 6,
            "compaction keeps recent work and drops old work, not both or neither"
        );
    }

    #[test]
    fn a_compaction_with_nothing_new_to_drop_reports_nothing_and_keeps_its_note() {
        let mut messages = loop_with_exchanges(6, 4_000);
        auto_compact_messages(&mut messages, Some(7_000), Some(0), Some(8_000), 80)
            .expect("first compaction");
        let compacted = messages.clone();
        assert!(
            auto_compact_messages(&mut messages, Some(7_000), Some(0), Some(8_000), 80).is_none()
        );
        assert_eq!(
            messages, compacted,
            "an already-compacted list is left exactly as it was"
        );
        assert_eq!(
            messages
                .iter()
                .filter(|message| is_context_compaction(message))
                .count(),
            1,
            "the note is rewritten, never stacked"
        );
    }

    #[test]
    fn a_later_compaction_rewrites_the_note_rather_than_stacking_one() {
        let mut messages = loop_with_exchanges(6, 4_000);
        auto_compact_messages(&mut messages, Some(7_000), Some(0), Some(8_000), 80)
            .expect("first compaction");
        messages.extend(tool_exchange(6, 4_000));
        messages.extend(tool_exchange(7, 4_000));
        let compaction =
            auto_compact_messages(&mut messages, Some(7_000), Some(0), Some(8_000), 80)
                .expect("the new rounds cross the share again");
        assert!(compaction.exchanges >= 1);
        assert_eq!(
            messages
                .iter()
                .filter(|message| is_context_compaction(message))
                .count(),
            1
        );
        assert!(is_context_compaction(&messages[2]));
        assert_calls_and_results_stay_paired(&messages);
    }

    #[test]
    fn the_newest_exchange_survives_however_large_it_is() {
        let mut messages = loop_with_exchanges(2, 100);
        messages.extend(tool_exchange(9, 400_000));
        let compaction =
            auto_compact_messages(&mut messages, Some(99_000), Some(0), Some(8_000), 80)
                .expect("an oversized tool result still compacts the rounds before it");
        assert!(compaction.exchanges >= 1);
        assert_eq!(messages.len(), 5);
        assert!(messages[2]["content"]
            .as_str()
            .unwrap()
            .starts_with(CONTEXT_COMPACTION_MARKER));
        assert_eq!(messages[3]["tool_calls"][0]["id"], "call-9");
        assert_eq!(messages[4]["tool_call_id"], "call-9");
        assert_calls_and_results_stay_paired(&messages);
    }

    #[test]
    fn compaction_keeps_the_newest_exchange_with_its_trailing_image_and_checkpoint() {
        let mut messages = loop_with_exchanges(2, 100);
        messages.extend(tool_exchange(9, 400_000));
        messages.push(serde_json::json!({
            "role": "user", "content": "screenshot observation", "images": ["image-data"]
        }));
        refresh_context_checkpoint(&mut messages, Some(99_000), Some(0), Some(8_000));
        auto_compact_messages(&mut messages, Some(99_000), Some(0), Some(8_000), 80)
            .expect("older exchanges can be compacted");
        assert_eq!(messages[3]["tool_calls"][0]["id"], "call-9");
        assert_eq!(messages[4]["tool_call_id"], "call-9");
        assert_eq!(messages[5]["images"][0], "image-data");
        assert_calls_and_results_stay_paired(&messages);
    }

    #[test]
    fn compaction_keeps_all_results_when_images_separate_a_multi_tool_exchange() {
        let mut messages = loop_with_exchanges(2, 100);
        let mut newest = tool_exchange(9, 400_000);
        newest[0]["tool_calls"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "id": "call-10", "type": "function",
                "function": { "name": "gyro_workspace_read", "arguments": "{}" }
            }));
        messages.extend(newest);
        messages.push(serde_json::json!({
            "role": "user", "content": "screenshot observation", "images": ["image-data"]
        }));
        messages.push(serde_json::json!({
            "role": "tool", "tool_call_id": "call-10", "content": "second result"
        }));
        auto_compact_messages(&mut messages, Some(99_000), Some(0), Some(8_000), 80)
            .expect("older exchanges can be compacted");
        assert_eq!(messages[3]["tool_calls"].as_array().unwrap().len(), 2);
        assert_eq!(messages[4]["tool_call_id"], "call-9");
        assert_eq!(messages[6]["tool_call_id"], "call-10");
        assert_calls_and_results_stay_paired(&messages);
    }

    #[test]
    fn a_checkpoint_before_the_only_exchange_does_not_trigger_compaction() {
        let mut messages = loop_with_exchanges(0, 0);
        refresh_context_checkpoint(&mut messages, Some(7_000), Some(0), Some(8_000));
        messages.extend(tool_exchange(1, 400_000));
        let unchanged = messages.clone();
        assert!(
            auto_compact_messages(&mut messages, Some(7_000), Some(0), Some(8_000), 80).is_none()
        );
        assert_eq!(messages, unchanged);
    }

    #[test]
    fn compaction_counts_compatibility_tools_and_keeps_the_newest_result() {
        let mut messages = loop_with_exchanges(0, 0);
        for round in 0..6 {
            messages.push(serde_json::json!({
                "role": "assistant",
                "content": format!(r#"{{"type":"tool","name":"gyro_workspace_read","arguments":{{"path":"file-{round}"}}}}"#)
            }));
            messages.push(serde_json::json!({"role": "user", "content": "x".repeat(4_000)}));
        }
        let compaction =
            auto_compact_messages(&mut messages, Some(7_000), Some(0), Some(8_000), 80)
                .expect("compatibility tool results can be compacted");
        assert!(compaction.exchanges > 0);
        assert!(messages[messages.len() - 2]["content"]
            .as_str()
            .unwrap()
            .contains("file-5"));
        assert_eq!(
            messages.last().unwrap()["content"].as_str().unwrap().len(),
            4_000
        );
    }

    #[test]
    fn encoded_images_are_not_reported_as_estimated_text_tokens() {
        let text = serde_json::json!({"role": "user", "content": "observation"});
        let ollama = serde_json::json!({"role": "user", "content": "observation", "images": ["x".repeat(1_000_000)]});
        let openai = serde_json::json!({"role": "user", "content": [
            {"type": "text", "text": "observation"},
            {"type": "image_url", "image_url": {"url": format!("data:image/png;base64,{}", "x".repeat(1_000_000))}}
        ]});
        assert!(message_size(&ollama).0 - message_size(&text).0 < 100);
        assert!(message_size(&openai).0 < 200);
    }

    #[test]
    fn measured_visual_occupancy_still_prunes_older_image_exchanges() {
        let mut messages = loop_with_exchanges(0, 0);
        for round in 0..3 {
            messages.extend(tool_exchange(round, 10));
            messages.push(serde_json::json!({
                "role": "user", "content": format!("screenshot {round}"), "images": ["x".repeat(100_000)]
            }));
        }
        let compaction =
            auto_compact_messages(&mut messages, Some(7_000), Some(0), Some(8_000), 80)
                .expect("visual occupancy triggers pruning despite small text");
        assert_eq!(compaction.exchanges, 2);
        assert!(
            compaction.characters < 1_000,
            "image bytes are not text token savings"
        );
        assert_eq!(messages[3]["tool_calls"][0]["id"], "call-2");
        assert_eq!(messages.last().unwrap()["content"], "screenshot 2");
        assert_calls_and_results_stay_paired(&messages);
    }

    #[test]
    fn serialized_tool_arguments_and_results_remain_in_the_text_budget() {
        let messages = tool_exchange(0, 4_000);
        assert!(message_size(&messages[0]).0 > 100);
        assert!(message_size(&messages[1]).0 >= 4_000);
    }

    #[test]
    fn one_request_occupancy_uses_that_prompt_and_ignores_a_missing_one() {
        let accounted = gyro_core::usage::UsageTokens::measured(
            Some(1_000),
            Some(40),
            Some(20),
            Some(5),
            Some(1_020),
        );
        let usage = occupancy_from_request(Some(1_000), Some(20), &accounted, Some(0)).unwrap();
        assert_eq!(usage.input_tokens, Some(1_000));
        assert_eq!(usage.output_tokens, Some(20));
        assert_eq!(usage.cached_input_tokens, Some(40));
        assert_eq!(usage.reasoning_output_tokens, Some(5));
        assert_eq!(usage.total_tokens, Some(1_020));
        assert_eq!(usage.model_context_window, None);
        assert!(!usage.estimated);
        assert!(occupancy_from_request(None, Some(20), &accounted, Some(128_000)).is_none());
    }

    #[test]
    fn live_occupancy_accepts_partial_measurements_but_rejects_estimates_and_conflicts() {
        let partial = gyro_core::usage::UsageTokens::measured(Some(100), None, None, None, None);
        assert_eq!(
            occupancy_from_request(Some(100), None, &partial, Some(1000))
                .unwrap()
                .input_tokens,
            Some(100)
        );
        let estimated = gyro_core::usage::UsageTokens::estimated(400, 40);
        assert!(occupancy_from_request(Some(100), Some(10), &estimated, None).is_none());
        let inconsistent =
            gyro_core::usage::UsageTokens::measured(Some(100), None, Some(10), None, Some(5));
        assert!(occupancy_from_request(Some(100), Some(10), &inconsistent, None).is_none());
    }

    #[test]
    fn estimated_traffic_past_the_window_is_not_occupancy() {
        let usage = provider_context_usage_with_window(
            Some(ProviderContextUsage {
                input_tokens: Some(7_515_785),
                total_tokens: Some(7_515_785),
                estimated: true,
                ..ProviderContextUsage::default()
            }),
            "xai",
            Some("grok-4.7"),
        )
        .unwrap();
        assert_eq!(usage.input_tokens, None);
        assert_eq!(usage.output_tokens, None);
        assert_eq!(usage.total_tokens, None);
        assert!(!usage.estimated);
        assert_eq!(usage.model_context_window, Some(256_000));

        let within = provider_context_usage_with_window(
            Some(ProviderContextUsage {
                input_tokens: Some(180_000),
                total_tokens: Some(180_000),
                estimated: true,
                ..ProviderContextUsage::default()
            }),
            "xai",
            Some("grok-4.7"),
        )
        .unwrap();
        assert_eq!(within.input_tokens, None);
        assert_eq!(within.total_tokens, None);
        assert!(!within.estimated);
        assert_eq!(within.model_context_window, Some(256_000));

        let billed = provider_context_usage_with_window(
            Some(ProviderContextUsage {
                input_tokens: Some(7_515_785),
                total_tokens: Some(7_515_785),
                ..ProviderContextUsage::default()
            }),
            "xai",
            Some("grok-4.7"),
        )
        .unwrap();
        assert_eq!(billed.input_tokens, None);
        assert!(!billed.estimated);
        assert_eq!(billed.model_context_window, Some(256_000));
    }

    #[test]
    fn oversized_usage_counters_do_not_overflow_window_validation() {
        assert!(exceeds_context_window(&ProviderContextUsage {
            input_tokens: Some(u64::MAX),
            output_tokens: Some(1),
            model_context_window: Some(8_000),
            ..ProviderContextUsage::default()
        }));
    }

    #[test]
    fn auto_compaction_leaves_a_small_or_unmeasured_request_alone() {
        let mut messages = loop_with_exchanges(6, 4_000);
        let snapshot = messages.clone();
        // Measured below the share.
        assert!(
            auto_compact_messages(&mut messages, Some(5_000), Some(0), Some(8_000), 80).is_none()
        );
        // Switched off in settings.
        assert!(
            auto_compact_messages(&mut messages, Some(7_900), Some(0), Some(8_000), 0).is_none()
        );
        // No window to measure against, which is how a custom endpoint arrives.
        assert!(auto_compact_messages(&mut messages, Some(7_900), Some(0), None, 80).is_none());
        // No measurement yet: the first round of a turn has nothing to report.
        assert!(auto_compact_messages(&mut messages, None, None, Some(8_000), 80).is_none());
        assert_eq!(messages, snapshot);
    }

    fn reading(input: u64, window: u64) -> SessionContextSignal {
        SessionContextSignal {
            provider_id: Some("xai".into()),
            model_id: Some("grok-4.7".into()),
            reading: Some(AutoCompactReading {
                input_tokens: Some(input),
                output_tokens: Some(0),
                model_context_window: Some(window),
            }),
            characters: 0,
            session_compaction: false,
        }
    }

    #[test]
    fn session_auto_compact_uses_a_reported_window_for_any_provider() {
        let full = reading(205_000, 256_000);
        assert!(
            should_auto_compact_session(80, "xai", Some("grok-4.7"), None, &[full.clone()]),
            "205K of a reported 256K window is the default threshold"
        );
        assert!(
            !should_auto_compact_session(
                80,
                "xai",
                Some("grok-4.7"),
                None,
                &[reading(200_000, 256_000)]
            ),
            "just under the share stays"
        );
        assert!(!should_auto_compact_session(
            0,
            "xai",
            Some("grok-4.7"),
            None,
            &[full.clone()]
        ));
        let mut other = full.clone();
        other.provider_id = Some("anthropic".into());
        other.model_id = Some("claude-sonnet-5".into());
        assert!(!should_auto_compact_session(
            80,
            "xai",
            Some("grok-4.7"),
            None,
            &[other]
        ));
    }

    #[test]
    fn session_auto_compact_waits_for_a_new_reading_after_it_already_ran() {
        let full = reading(205_000, 256_000);
        let compacted = SessionContextSignal {
            provider_id: Some("xai".into()),
            model_id: Some("grok-4.7".into()),
            reading: None,
            characters: 0,
            session_compaction: true,
        };
        assert!(!should_auto_compact_session(
            80,
            "xai",
            Some("grok-4.7"),
            None,
            &[full.clone(), compacted.clone()]
        ));
        let still_full = reading(210_000, 256_000);
        assert!(should_auto_compact_session(
            80,
            "xai",
            Some("grok-4.7"),
            None,
            &[full, compacted, still_full]
        ));
    }

    #[test]
    fn session_auto_compact_borrows_the_catalog_when_the_reading_has_no_window() {
        let mut tokens_only = reading(90_000, 1);
        if let Some(reading) = tokens_only.reading.as_mut() {
            reading.model_context_window = None;
        }
        tokens_only.provider_id = Some("custom".into());
        tokens_only.model_id = Some("local-model".into());
        assert!(!should_auto_compact_session(
            80,
            "custom",
            Some("local-model"),
            None,
            &[tokens_only.clone()]
        ));
        assert!(should_auto_compact_session(
            80,
            "custom",
            Some("local-model"),
            Some(100_000),
            &[tokens_only]
        ));
    }

    fn carried(characters: u64) -> SessionContextSignal {
        SessionContextSignal {
            provider_id: Some("xai".into()),
            model_id: Some("grok-4.7".into()),
            reading: None,
            characters,
            session_compaction: false,
        }
    }

    #[test]
    fn session_auto_compact_measures_a_session_that_reports_no_usage() {
        // A CLI adapter that never says how full its window is still stores
        // what it carried, so the transcript is the fill.
        let window = 256_000;
        let under = vec![carried(400_000)];
        assert!(
            !should_auto_compact_session(80, "xai", Some("grok-4.7"), Some(window), &under),
            "100K estimated tokens of 256K is under the share"
        );
        let grown = vec![carried(8_000_000)];
        assert!(
            should_auto_compact_session(80, "xai", Some("grok-4.7"), Some(window), &grown),
            "2M estimated tokens is past 80% of the window"
        );
        assert!(
            !should_auto_compact_session(80, "xai", Some("grok-4.7"), None, &grown),
            "a share of an unknown window is still not a measurement"
        );
    }

    #[test]
    fn session_auto_compact_counts_only_what_follows_the_last_rewrite() {
        let compacted = SessionContextSignal {
            provider_id: Some("xai".into()),
            model_id: Some("grok-4.7".into()),
            reading: None,
            characters: 4_000,
            session_compaction: true,
        };
        let window = 256_000;
        let before = vec![carried(8_000_000), compacted.clone()];
        assert!(
            !should_auto_compact_session(80, "xai", Some("grok-4.7"), Some(window), &before),
            "the rewrite already dropped what came before it"
        );
        let after = vec![carried(8_000_000), compacted, carried(8_000_000)];
        assert!(
            should_auto_compact_session(80, "xai", Some("grok-4.7"), Some(window), &after),
            "the summary plus what followed it fills the window again"
        );
    }
}

pub(crate) use gyro_core::provider_runtime::types::ProviderContextUsage;

#[cfg(test)]
pub(crate) use gyro_core::provider_runtime::accounting::provider_context_usage_from_app_server;

pub(crate) use gyro_core::provider_runtime::context::{
    antigravity_step_occupancy, claude_stream_context_window, exceeds_context_window,
    occupancy_from_request, provider_context_usage_from_codex_exec, should_auto_compact_session,
    AutoCompactReading, SessionContextSignal,
};
#[cfg(test)]
pub(crate) use gyro_core::provider_runtime::context::{
    auto_compact_messages, auto_compaction_fill, is_context_compaction, message_role, message_size,
    provider_context_usage_from_claude_stream, refresh_context_checkpoint, ClaudeUsageFrame,
    OllamaTurnUsage, CONTEXT_CHECKPOINT_MARKER, CONTEXT_COMPACTION_MARKER,
};

/// Compatibility parser for the Grok PromptUsage contract only. Live ACP
/// adapters use the provider-specific normalizer, retaining cache writes and
/// coverage in UsageTokens rather than collapsing them into cached reads.
#[cfg(test)]
pub(super) fn provider_billed_usage_from_acp(usage: &Value) -> Option<ProviderContextUsage> {
    let observation = gyro_core::acp_usage::normalize_prompt_usage(
        gyro_core::acp_usage::AcpProvider::Grok,
        &serde_json::json!({"usage": usage}),
        gyro_core::acp_usage::AcpRuntimeInfo::default(),
    );
    gyro_core::provider_runtime::support::provider_billed_usage_from_acp_tokens(observation.tokens)
}
