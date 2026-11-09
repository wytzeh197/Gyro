#[cfg(test)]
use crate::providers::retry::is_provider_cancellation;
#[cfg(test)]
use gyro_core::provider_runtime::reliability::TOOL_BUDGET_CHECKPOINT;
pub(crate) use gyro_core::provider_runtime::reliability::{
    configured_tool_rounds, is_rate_limit_error, is_tool_budget_notice,
    is_transient_provider_error, openai_tools_for_round, provider_failure_recovery,
    readable_provider_error, tools_for_round,
};
pub(crate) use gyro_core::provider_runtime::support::is_model_capacity_error;
use gyro_core::CapabilityId;
pub(crate) fn validate_tool_call(
    name: &str,
    arguments: &serde_json::Value,
) -> Result<CapabilityId, String> {
    gyro_core::provider_runtime::reliability::validate_tool_call(
        &crate::providers::catalog::DESKTOP_TOOL_CATALOG,
        name,
        arguments,
    )
}

pub(crate) fn prepare_tool_call(
    messages: &mut Vec<serde_json::Value>,
    name: &str,
    arguments: &serde_json::Value,
    call_id: Option<&str>,
) -> Option<CapabilityId> {
    gyro_core::provider_runtime::reliability::prepare_tool_call(
        &crate::providers::catalog::DESKTOP_TOOL_CATALOG,
        messages,
        name,
        arguments,
        call_id,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn codex_quota_refusals_do_not_offer_generic_or_automatic_retry() {
        for error in [
            "Quota exceeded. Check your plan and billing details.",
            "Request rejected [Codex error: \"usageLimitExceeded\"]",
            "usage_limit_exceeded; HTTP 429; try again",
        ] {
            let (kind, advice) = provider_failure_recovery(error);
            assert_eq!(kind, "quota-exceeded");
            assert!(advice.contains("may not include this limit"));
            assert!(!is_transient_provider_error(error));
            assert!(!is_rate_limit_error(error));
        }
        assert!(is_rate_limit_error("HTTP 429: too many requests"));
        assert_eq!(
            provider_failure_recovery("insufficient_quota").0,
            "plan-exhausted"
        );
    }
    #[test]
    fn checkpoint_continuations_do_not_accumulate_budget_notices() {
        let tools = vec![serde_json::json!({"type":"function"})];
        let mut messages = Vec::new();
        assert!(tools_for_round(&mut messages, &tools, 1, Some(1)).is_empty());
        messages.push(serde_json::json!({"role":"assistant","content":"partial checkpoint"}));
        let before = messages.clone();
        for _ in 0..3 {
            assert!(tools_for_round(&mut messages, &tools, 1, Some(1)).is_empty());
            assert_eq!(messages, before);
        }
        // Compaction may remove the old instruction; reinstate it when absent.
        messages.remove(0);
        assert!(tools_for_round(&mut messages, &tools, 1, Some(1)).is_empty());
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["content"], "partial checkpoint");
        assert_eq!(messages[1]["content"], TOOL_BUDGET_CHECKPOINT);
    }
    #[test]
    fn checkpoint_catalog_never_reopens_tools_and_is_opt_in() {
        let tools = vec![serde_json::json!({"type":"function","function":{"name":"edit"}})];
        for retain in [false, true] {
            for (round, limit, permitted) in
                [(0, Some(1), true), (1, Some(1), false), (100, None, true)]
            {
                let mut messages = vec![serde_json::json!({"role":"tool","content":"edit result"})];
                let (definitions, allow_calls) =
                    openai_tools_for_round(&mut messages, &tools, round, limit, retain);
                assert_eq!(allow_calls, permitted);
                assert_eq!(
                    definitions,
                    if permitted || retain {
                        tools.clone()
                    } else {
                        Vec::new()
                    }
                );
                assert_eq!(messages[0]["content"], "edit result");
                assert_eq!(messages.len(), if permitted { 1 } else { 2 });
            }
            let (definitions, allow_calls) =
                openai_tools_for_round(&mut Vec::new(), &[], 0, None, retain);
            assert!(definitions.is_empty());
            assert!(!allow_calls);
        }
    }
    #[test]
    fn tool_budget_reserves_checkpoint_without_replaying_tools() {
        let mut messages = vec![serde_json::json!({"role":"tool","content":"edit applied"})];
        let tools = vec![serde_json::json!({"type":"function"})];
        assert_eq!(
            tools_for_round(&mut messages, &tools, 127, Some(128)),
            tools
        );
        assert_eq!(messages.len(), 1);
        assert!(tools_for_round(&mut messages, &tools, 128, Some(128)).is_empty());
        assert_eq!(messages[0]["content"], "edit applied");
        assert!(messages[1]["content"]
            .as_str()
            .unwrap()
            .contains("unfinished"));
        // The model is no longer told to name the internal budget, so it cannot
        // paraphrase it into a product limit the user cannot lift.
        assert!(!messages[1]["content"].as_str().unwrap().contains("round"));
    }

    #[test]
    fn a_raised_budget_keeps_offering_tools_past_the_old_ceiling() {
        let mut messages = Vec::new();
        let tools = vec![serde_json::json!({"type":"function"})];
        assert_eq!(
            tools_for_round(&mut messages, &tools, 128, Some(512)),
            tools
        );
        assert!(messages.is_empty());
        assert!(tools_for_round(&mut messages, &tools, 512, Some(512)).is_empty());
        assert_eq!(messages.len(), 1);
    }

    #[test]
    fn no_budget_never_stops_the_loop() {
        let mut messages = Vec::new();
        let tools = vec![serde_json::json!({"type":"function"})];
        for round in [0, 128, 100_000, usize::MAX - 1] {
            assert_eq!(tools_for_round(&mut messages, &tools, round, None), tools);
        }
        assert!(messages.is_empty());
    }
}

#[cfg(test)]
mod tool_validation_tests {
    use super::*;
    #[test]
    fn observation_size_hints_are_repaired_before_schema_validation() {
        use serde_json::json;
        for id in [
            CapabilityId::WorkspaceRead,
            CapabilityId::WorkspaceReadRange,
        ] {
            for value in [json!(null), json!(-1), json!(0), json!(512), json!(200000)] {
                let arguments = json!({"path":"styles.css","maxBytes":value});
                assert_eq!(
                    validate_tool_call(id.provider_tool_name(), &arguments),
                    Ok(id)
                );
                // Validation leaves the original call intact; execution applies
                // the same shared helper to select the effective byte budget.
                assert_eq!(arguments["maxBytes"], value);
            }
            for value in [json!("4096"), json!(1.5), json!(true)] {
                assert!(validate_tool_call(
                    id.provider_tool_name(),
                    &json!({"path":"styles.css","maxBytes":value})
                )
                .is_err());
            }
        }
        for arguments in [
            json!({"maxBytes":0}),
            json!({"path":42,"maxBytes":0}),
            json!({"path":"styles.css","line":0,"maxBytes":0}),
            json!({"path":"styles.css","extra":true,"maxBytes":0}),
        ] {
            assert!(validate_tool_call(
                CapabilityId::WorkspaceRead.provider_tool_name(),
                &arguments
            )
            .is_err());
        }
    }

    #[test]
    fn malformed_calls_can_be_repaired_without_execution() {
        assert!(validate_tool_call("invented_tool", &serde_json::json!({})).is_err());
        let name = CapabilityId::BrowserScreenshot.provider_tool_name();
        assert!(validate_tool_call(name, &serde_json::json!("{partial")).is_err());
        assert!(validate_tool_call(name, &serde_json::json!({})).is_ok());
        assert!(
            validate_tool_call("gyro_workspace_read_file", &serde_json::json!({"path": 42}))
                .is_err()
        );
        assert!(validate_tool_call(
            CapabilityId::WorkspaceRead.provider_tool_name(),
            &serde_json::json!({})
        )
        .unwrap_err()
        .contains("missing required"));
        let mut messages = vec![serde_json::json!({"role":"tool","content":"prior edit applied"})];
        assert!(
            prepare_tool_call(&mut messages, name, &serde_json::json!("{"), Some("call-2"))
                .is_none()
        );
        assert_eq!(messages[0]["content"], "prior edit applied");
        assert_eq!(messages[1]["tool_call_id"], "call-2");
        assert!(
            prepare_tool_call(&mut messages, name, &serde_json::json!({}), Some("call-3"))
                .is_some()
        );
        assert_eq!(messages.len(), 2);
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    use crate::state::provider_run::ProviderStopReason;

    const GROK_402: &str = r#"Internal error: {"http_status":402,"message":"API error (status 402 Payment Required): Grok Build usage balance exhausted","promptUsage":{"inputTokens":18177618,"modelCalls":71}}"#;

    #[test]
    fn an_exhausted_balance_is_named_and_never_retried() {
        assert_eq!(provider_failure_recovery(GROK_402).0, "plan-exhausted");
        assert!(!is_transient_provider_error(GROK_402));
        assert_eq!(
            provider_failure_recovery("Error: insufficient_quota for this key").0,
            "plan-exhausted"
        );
    }

    #[test]
    fn a_cli_config_gap_is_not_offered_a_retry() {
        let error = "Missing environment variable: `DEEPSEEK_API_KEY`.";
        assert_eq!(provider_failure_recovery(error).0, "provider-config");
        assert!(!is_transient_provider_error(error));
    }

    #[test]
    fn model_availability_is_distinct_from_a_turn_output_budget() {
        for error in [
            "Selected model is at capacity. Please try a different model.",
            "The model is temporarily at capacity.",
            "API error: overloaded_error",
        ] {
            let (kind, message) = provider_failure_recovery(error);
            assert_eq!(kind, "model-capacity");
            assert!(message.contains("conversation is saved"));
            assert!(is_transient_provider_error(error));
        }
        for permanent in [
            "HTTP 401: model is at capacity",
            "HTTP 403: model is at capacity",
            "HTTP 402: model is at capacity",
            "authentication failed: model is at capacity",
            "output exceeded its size limit: model is at capacity",
        ] {
            assert!(!is_model_capacity_error(permanent));
            assert!(!is_transient_provider_error(permanent));
        }
        assert_eq!(
            provider_failure_recovery("output exceeded its size limit").0,
            "capacity"
        );
        assert_eq!(
            provider_failure_recovery("HTTP 402: model is at capacity").0,
            "plan-exhausted"
        );
        assert_eq!(
            provider_failure_recovery("HTTP 401: model is at capacity").0,
            "authentication"
        );
    }

    #[test]
    fn access_restrictions_get_actionable_recovery_without_automatic_retry() {
        let refusal = gyro_core::provider_stream::CLAUDE_SUBSCRIPTION_ACCESS_DETAIL;
        assert_eq!(provider_failure_recovery(refusal).0, "provider-config");
        assert!(!is_transient_provider_error(refusal));
        let keychain = "Gyro could not read the saved credential from macOS Keychain without user interaction.";
        assert!(provider_failure_recovery(keychain).1.contains("Unlock"));
        assert!(!is_transient_provider_error(keychain));
        let already_actionable = "Gyro could not read the saved credential from macOS Keychain without user interaction. Unlock your Mac and allow Gyro to access this credential, then send again.";
        assert_eq!(
            provider_failure_recovery(already_actionable).0,
            "provider-config"
        );
        assert_eq!(provider_failure_recovery(already_actionable).1, "");
        assert!(!is_transient_provider_error(already_actionable));
    }

    #[test]
    fn an_agent_json_error_reads_as_its_message() {
        assert_eq!(
            readable_provider_error(GROK_402),
            "Internal error: API error (status 402 Payment Required): Grok Build usage balance exhausted"
        );
        assert_eq!(
            readable_provider_error("connection reset by peer"),
            "connection reset by peer"
        );
        assert_eq!(
            readable_provider_error("bad frame {not json}"),
            "bad frame {not json}"
        );
    }
    #[test]
    fn repeated_work_pause_requires_explicit_resume_and_is_not_a_user_stop() {
        let message = ProviderStopReason::NoProgress.message();
        assert!(!is_transient_provider_error(&message));
        assert!(is_provider_cancellation(&message));
        let (kind, detail) = provider_failure_recovery(&message);
        assert_eq!(kind, "no-progress");
        assert!(detail.contains("checkpoint"));
        assert!(!detail.contains("You stopped"));
    }
}
