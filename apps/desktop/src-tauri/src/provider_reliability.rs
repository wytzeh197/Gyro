use crate::{
    capabilities::mcp_server::desktop_capability_tool_schema,
    capability_workspace_helpers::workspace_result_byte_limit,
    ollama_runner::validate_compatibility_schema_value,
    provider_tool_batch,
    providers::{
        process::is_stale_resume_error, retry::is_provider_cancellation,
        retry_recovery as provider_retry_recovery,
    },
    state::provider_run::{
        PROVIDER_INTERRUPTED_MARKER, PROVIDER_STALL_MARKER, PROVIDER_STOP_MARKER,
    },
};
use gyro_core::{CapabilityId, GyroConfig, GyroPaths};
pub(super) fn is_transient_provider_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    if is_provider_cancellation(error)
        || error.contains(provider_retry_recovery::CAPACITY_RETRY_EXHAUSTED)
        || error.contains(provider_retry_recovery::RETRY_EXHAUSTED)
        || error.contains(provider_retry_recovery::CONTINUATION_UNAVAILABLE)
        || is_stale_resume_error(error)
        || gyro_core::is_workspace_unavailable_error(error)
        || is_hopeless_provider_timeout(error)
        || [
            "http 400",
            "http 401",
            "http 403",
            "invalid api key",
            "unauthorized",
            "insufficient_quota",
            "quota exceeded",
            "usagelimitexceeded",
            "usage_limit_exceeded",
            "status 402",
            "http 402",
            "payment required",
            "balance exhausted",
            "missing environment variable",
        ]
        .iter()
        .any(|cause| normalized.contains(cause))
    {
        return false;
    }
    normalized.contains("connection reset")
        || normalized.contains("connection refused")
        || normalized.contains("broken pipe")
        || normalized.contains("timed out")
        || normalized.contains("timeout")
        || normalized.contains("temporarily unavailable")
        || is_model_capacity_error(error)
        || is_rate_limit_error(error)
        || normalized.contains("network is unreachable")
        || normalized.contains("could not resolve host")
        || normalized.contains("dns")
        || normalized.contains("eof while")
        || normalized.contains("unexpected eof")
        || [
            "http 408", "http 429", "http 500", "http 502", "http 503", "http 504", "http 529",
        ]
        .iter()
        .any(|status| normalized.contains(status))
}

pub(super) fn is_rate_limit_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    ![
        "insufficient_quota",
        "quota exceeded",
        "usagelimitexceeded",
        "usage_limit_exceeded",
        "payment required",
        "balance exhausted",
        "billing",
        "invalid api key",
    ]
    .iter()
    .any(|cause| normalized.contains(cause))
        && [
            "http 429",
            "rate limit",
            "rate_limit",
            "too many requests",
            "provider cooldown",
        ]
        .iter()
        .any(|cause| normalized.contains(cause))
}

fn is_hopeless_provider_timeout(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("acp run timed out")
        || normalized.contains("acp run became inactive")
        || normalized.contains("exceeded gyro's tool-call limit")
        || normalized.contains("output exceeded")
}

/// Tool rounds one turn may run, as `usageGuard.maxToolRounds` configures it.
///
/// `None` means the user switched the budget off, so the turn keeps working
/// until the model stops asking for tools or the user stops it. An unreadable
/// config is treated the same way: a config-file problem must not silently
/// impose a ceiling, and the spend guards read the same file on their own.
pub(super) fn configured_tool_rounds() -> Option<usize> {
    let config = GyroPaths::for_current_user()
        .ok()
        .and_then(|paths| GyroConfig::load(&paths).ok())?;
    (config.usage_guard.max_tool_rounds > 0).then_some(config.usage_guard.max_tool_rounds)
}

/// Reserve one final response after the work budget so users retain a useful
/// checkpoint instead of a failed turn that invites replaying completed edits.
///
/// The checkpoint is prose the model writes, so it is asked for the user-facing
/// half only -- what is done, what is left. Saying *why* the turn stopped is
/// Gyro's to report: a model told to name the internal budget paraphrases it
/// into a heading like "paused at the tool-round limit", which reads as a
/// product limit the user cannot lift and buries the way out.
const TOOL_BUDGET_CHECKPOINT: &str = "Gyro has stopped offering tools for this turn. Do not call more tools. Give a concise checkpoint: what is verified complete, what remains unfinished, and what to do next. Do not claim the whole task is complete.";

pub(super) fn tools_for_round(
    messages: &mut Vec<serde_json::Value>,
    tools: &[serde_json::Value],
    round: usize,
    limit: Option<usize>,
) -> Vec<serde_json::Value> {
    if limit.is_none_or(|limit| round < limit) {
        return tools.to_vec();
    }
    // A length-limited checkpoint may continue at the same round. Keep one
    // instruction in history instead of charging for another copy each time.
    if !messages
        .iter()
        .any(|message| message["role"] == "user" && message["content"] == TOOL_BUDGET_CHECKPOINT)
    {
        messages.push(serde_json::json!({
            "role": "user", "content": TOOL_BUDGET_CHECKPOINT
        }));
    }
    Vec::new()
}

/// The cache-assembly experiment can keep definitions at a prose-only checkpoint.
/// Permission to execute is separate; presence of definitions never lifts a limit.
pub(super) fn openai_tools_for_round(
    messages: &mut Vec<serde_json::Value>,
    tools: &[serde_json::Value],
    round: usize,
    limit: Option<usize>,
    retain_checkpoint_catalog: bool,
) -> (Vec<serde_json::Value>, bool) {
    let offered = tools_for_round(messages, tools, round, limit);
    let allow_calls = !offered.is_empty();
    let definitions = if !allow_calls && retain_checkpoint_catalog {
        tools.to_vec()
    } else {
        offered
    };
    (definitions, allow_calls)
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

/// Whether this text is the round-budget notice rather than a provider fault.
///
/// Matched by its stable phrase, not by keyword: the notice is produced by Gyro
/// and the words in it are ordinary enough to appear in a provider's own text.
pub(super) fn is_tool_budget_notice(error: &str) -> bool {
    error.contains("round budget")
}

fn is_plan_exhausted(normalized: &str) -> bool {
    [
        "status 402",
        "http 402",
        "\"http_status\":402",
        "payment required",
        "balance exhausted",
        "insufficient_quota",
        "credit balance is too low",
        "out of credits",
    ]
    .iter()
    .any(|cause| normalized.contains(cause))
}

/// A provider error as a person reads it.
///
/// Agents wrap API failures as `Internal error: {"http_status":402,"message":
/// "…", "promptUsage":{…}}`. The message is the only part worth showing, and it
/// keeps the status wording the recovery classifier matches on.
pub(super) fn readable_provider_error(error: &str) -> String {
    let Some(start) = error.find('{') else {
        return error.to_string();
    };
    let end = error.rfind('}').map_or(error.len(), |end| end + 1);
    let Some(message) = serde_json::from_str::<serde_json::Value>(&error[start..end])
        .ok()
        .and_then(|frame| {
            frame
                .get("message")
                .or_else(|| frame.pointer("/error/message"))
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|message| !message.is_empty())
                .map(str::to_string)
        })
    else {
        return error.to_string();
    };
    let prefix = error[..start].trim().trim_end_matches(':').trim();
    let tail = error[end..].trim();
    [prefix, message.as_str(), tail]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(": ")
}

pub(super) fn provider_failure_recovery(error: &str) -> (&'static str, &'static str) {
    if error.contains(provider_retry_recovery::CONTINUATION_UNAVAILABLE) {
        return ("continuation-unavailable", "Completed work is preserved. The saved provider conversation is unavailable; automatic replay was stopped.");
    }
    if error.contains(provider_retry_recovery::RETRY_EXHAUSTED) {
        return ("retry-exhausted", "Automatic recovery has ended. Retry to continue the saved conversation when the provider is ready.");
    }
    let normalized = error.to_ascii_lowercase();
    // Checked first: the turn completed, so nothing below -- least of all the
    // retry fallback -- describes it.
    if is_tool_budget_notice(error) {
        return (
            "tool-budget",
            "Send the next step, or raise `usageGuard.maxToolRounds` in config.json.",
        );
    }
    // Same footing: the turn completed with an answer the provider may not
    // have finished, so it gets a continue, not a failure.
    if error.contains("may be cut off") {
        return (
            "partial-answer",
            "Press Continue to have it pick up where it stopped.",
        );
    }
    // Before the keyword branches, which would read a stall as a network or
    // timeout problem with advice that does not fit.
    if error.contains(PROVIDER_STALL_MARKER) {
        return (
            "stalled",
            "The provider stopped responding, so Gyro ended the turn. Send again to continue.",
        );
    }
    // Checked next: a stop is not a failure, and every branch below reads it
    // as one. The ceiling case in particular must not be offered a plain retry,
    // which would run into the same ceiling and stop in the same place.
    // A declined tool ends the provider turn. That is not the person pressing
    // Stop, and it must not be offered as a generic crash retry.
    if normalized.contains("tool permission was declined") {
        return (
            "permission-declined",
            "A tool was declined, so the provider ended the turn. Send again to continue.",
        );
    }
    // The same stop without a decline behind it. The runner already asked the
    // session once to carry on, so this is the agent's final word on the turn;
    // the reply above it is saved and nothing here was a crash.
    if normalized.contains("ended the turn without finishing") {
        return (
            "turn-stopped",
            "The provider stopped its own turn. Send again to continue from here.",
        );
    }
    if error.contains(PROVIDER_STOP_MARKER) {
        return if normalized.contains("repeated unchanged tool results") {
            ("no-progress", "Gyro paused repeated work. Review the saved checkpoint, then send a changed approach to resume; completed work is preserved.")
        } else if normalized.contains("per-call ceiling") {
            (
                "spend-ceiling",
                "Gyro stopped this turn at its per-call token ceiling. Ask for a smaller piece of the work, or raise `usageGuard.maxTokensPerCall` in config.json.",
            )
        } else if normalized.contains("rolling token budget") {
            (
                "spend-ceiling",
                "This provider's token budget is spent. Wait for its rolling window to free up, or adjust the provider budget in usage settings.",
            )
        } else {
            ("stopped", "You stopped this turn. Send again to continue.")
        };
    }
    // An interrupted turn never reached the provider's own error handling, so
    // none of the keyword branches below can say anything true about it. It is
    // also the one failure that is always worth sending again.
    // A budget checkpoint is not a failure -- the turn completed and its reply
    // is saved -- so it is classified by its own stable phrase rather than by
    // the retry keywords below, which would offer a plain resend.
    if error.contains(PROVIDER_INTERRUPTED_MARKER) {
        return (
            "interrupted",
            "Gyro closed while this turn was running. Send it again to continue the conversation.",
        );
    }
    // Checked first: an argument failure is definitive, and it is the one class
    // where retrying cannot possibly help. Reporting it as a generic retry is
    // what left an unusable provider looking like a flaky one.
    if gyro_core::is_cli_argument_error(error) {
        return (
            "cli-contract",
            "This provider's CLI does not accept the command Gyro built, which usually means its version changed. Update Gyro and the provider CLI; retrying will not help.",
        );
    }
    // Also definitive: an empty balance or an exhausted plan fails every resend
    // the same way, and a resend can first spend a long tool loop reaching the
    // same refusal (one Grok turn ran 71 model calls before its 402).
    if is_plan_exhausted(&normalized) {
        return (
            "plan-exhausted",
            "This provider's plan or credit balance is used up. Top it up or switch provider; retrying will fail the same way.",
        );
    }
    if [
        "quota exceeded",
        "usagelimitexceeded",
        "usage_limit_exceeded",
    ]
    .iter()
    .any(|cause| normalized.contains(cause))
    {
        return (
            "quota-exceeded",
            "The provider rejected this turn because of a usage or credit limit. Reported plan windows may not include this limit. Check usage with the provider or switch provider; retry after the restriction is resolved.",
        );
    }
    if normalized.contains("missing environment variable") {
        return (
            "provider-config",
            "The provider CLI's own configuration asks for an environment variable that is not set. Fix that CLI config or pick a different profile; retrying will not help.",
        );
    }
    if normalized.contains("organization has disabled claude subscription access") {
        return (
            "provider-config",
            "Ask your organization administrator to enable Claude Code subscription access, or explicitly configure API-key access in Settings > Providers.",
        );
    }
    if normalized.contains("macos keychain") {
        // Skip a second copy when the reader already told the person to
        // unlock and send again. A bare Keychain refusal still needs it.
        return (
            "provider-config",
            if normalized.contains("unlock your mac") {
                ""
            } else {
                "Unlock your Mac and allow Gyro to read the saved credential, then send again."
            },
        );
    }
    if normalized.contains("offline")
        || normalized.contains("network is unreachable")
        || normalized.contains("connection refused")
        || normalized.contains("could not resolve host")
        || normalized.contains("dns")
    {
        return (
            "offline",
            "Check your internet connection, then retry this message.",
        );
    }
    // Checked before the generic authentication branch: an expired sign-in is
    // the one auth failure Gyro can walk someone out of, so it needs a kind of
    // its own. The surface offers sign-in for it instead of a health re-check,
    // which a stale token still passes.
    if normalized.contains("authentication_failed")
        || normalized.contains("oauth access token has expired")
        || normalized.contains("failed to authenticate")
        || normalized.contains("\"error_status\":401")
        || normalized.contains("401 unauthorized")
    {
        return (
            "login-expired",
            "This provider's sign-in expired. Sign in again and Gyro will resend your message.",
        );
    }
    if normalized.contains("http 401")
        || normalized.contains("http 403")
        || normalized.contains("unauthorized")
        || normalized.contains("authentication")
        || normalized.contains("not logged in")
        || normalized.contains("login required")
        || normalized.contains("credential")
    {
        return (
            "authentication",
            "Reconnect this provider, then retry the message.",
        );
    }
    // Model availability is temporary and distinct from the output/tool
    // capacity branch below. Keep the recovery structured so the UI does not
    // have to interpret a provider's urgent wording as an action requirement.
    if error.contains(provider_retry_recovery::CAPACITY_RETRY_EXHAUSTED) {
        return (
            "model-capacity-exhausted",
            "Your work is saved. Retry when you are ready to continue.",
        );
    }
    if is_model_capacity_error(error) {
        return (
            "model-capacity",
            "Your conversation is saved. You can retry or choose another model.",
        );
    }
    if normalized.contains("http 429")
        || normalized.contains("rate limit")
        || normalized.contains("too many requests")
    {
        return (
            "rate-limit",
            "Wait for the provider limit to reset, then retry.",
        );
    }
    if normalized.contains("size limit")
        || normalized.contains("tool-call limit")
        || normalized.contains("output exceeded")
    {
        return ("capacity", "This turn exceeded a provider output or tool budget. Continue with a smaller step; repeating the same request may hit the same limit.");
    }
    (
        "retry",
        "Retry the message. Gyro will preserve the conversation context.",
    )
}

/// Invalid tool names/arguments have not executed anything. Return a tool
/// error to the model so it can correct its request without losing the run.
pub(super) fn validate_tool_call(
    name: &str,
    arguments: &serde_json::Value,
) -> Result<CapabilityId, String> {
    let id = CapabilityId::from_provider_tool_name(name).ok_or(
        "Unknown Gyro tool. Choose a tool from the supplied tool list. No action was executed.",
    )?;
    if !arguments.is_object() {
        return Err("Tool arguments must be a JSON object. Correct the arguments and try again. No action was executed.".into());
    }
    let schema = desktop_capability_tool_schema(id);
    let mut normalized = std::borrow::Cow::Borrowed(arguments);
    // Validate the same effective observation budget the broker will use.
    // Only advertised size hints are repaired; paths, ranges, and mutation
    // arguments still have to satisfy their original schema.
    if schema["properties"].get("maxBytes").is_some() && arguments.get("maxBytes").is_some() {
        let budget = workspace_result_byte_limit(arguments).map_err(|error| error.to_string())?;
        normalized.to_mut()["maxBytes"] = serde_json::json!(budget);
    }
    validate_compatibility_schema_value(&normalized, &schema, "arguments")
        .map_err(|error| {
            let catalog = if provider_tool_batch::inline_tool_schema(id) {
                String::new()
            } else {
                format!(
                    " Call gyro_tool_catalog with prefix {} for the full schema.",
                    provider_tool_batch::catalog_prefix(id)
                )
            };
            format!(
                "Invalid Gyro tool arguments: {error}.{catalog} Correct the arguments and try again. No action was executed."
            )
        })?;
    Ok(id)
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

pub(super) fn prepare_tool_call(
    messages: &mut Vec<serde_json::Value>,
    name: &str,
    arguments: &serde_json::Value,
    call_id: Option<&str>,
) -> Option<CapabilityId> {
    match validate_tool_call(name, arguments) {
        Ok(id) => Some(id),
        Err(error) => {
            let mut reply = serde_json::json!({"role":"tool", "content":error});
            if let Some(id) = call_id {
                reply["tool_call_id"] = id.into();
            } else {
                reply["tool_name"] = name.into();
            }
            messages.push(reply);
            None
        }
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

pub(crate) use gyro_core::provider_runtime::support::is_model_capacity_error;
