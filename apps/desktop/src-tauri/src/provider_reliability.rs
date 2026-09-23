use super::*;

pub(super) fn is_transient_provider_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    if is_provider_cancellation(error)
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
        || normalized.contains("try again")
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
pub(super) fn tools_for_round(
    messages: &mut Vec<serde_json::Value>,
    tools: &[serde_json::Value],
    round: usize,
    limit: Option<usize>,
) -> Vec<serde_json::Value> {
    if limit.is_none_or(|limit| round < limit) {
        return tools.to_vec();
    }
    messages.push(serde_json::json!({
        "role": "user",
        "content": "Gyro has stopped offering tools for this turn. Do not call more tools. Give a concise checkpoint: what is verified complete, what remains unfinished, and what to do next. Do not claim the whole task is complete."
    }));
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
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
    if error.contains(PROVIDER_STOP_MARKER) {
        return if normalized.contains("per-call ceiling") {
            (
                "spend-ceiling",
                "Gyro stopped this turn at its per-call token ceiling. Ask for a smaller piece of the work, or raise `usageGuard.maxTokensPerCall` in config.json.",
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
    if normalized.contains("missing environment variable") {
        return (
            "provider-config",
            "The provider CLI's own configuration asks for an environment variable that is not set. Fix that CLI config or pick a different profile; retrying will not help.",
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
) -> Result<CapabilityId, &'static str> {
    let id = CapabilityId::from_provider_tool_name(name).ok_or(
        "Unknown Gyro tool. Choose a tool from the supplied tool list. No action was executed.",
    )?;
    if !arguments.is_object() {
        return Err("Tool arguments must be a JSON object. Correct the arguments and try again. No action was executed.");
    }
    Ok(id)
}

#[cfg(test)]
mod tool_validation_tests {
    use super::*;
    #[test]
    fn malformed_calls_can_be_repaired_without_execution() {
        assert!(validate_tool_call("invented_tool", &serde_json::json!({})).is_err());
        let name = CapabilityId::BrowserScreenshot.provider_tool_name();
        assert!(validate_tool_call(name, &serde_json::json!("{partial")).is_err());
        assert!(validate_tool_call(name, &serde_json::json!({})).is_ok());
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
}
