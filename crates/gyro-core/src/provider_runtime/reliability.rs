//! Shared provider retry classification and bounded tool-loop policy.
use super::limits::PROVIDER_STOP_MARKER;
pub fn is_provider_cancellation(error: &str) -> bool {
    error.contains(PROVIDER_STOP_MARKER)
}
pub const CAPACITY_RETRY_EXHAUSTED: &str =
    "The model is still busy after three automatic attempts.";

pub const RETRY_EXHAUSTED: &str = "Automatic retries exhausted.";

pub const CONTINUATION_UNAVAILABLE: &str = "Saved provider continuation is unavailable.";

use super::{
    catalog::{validate_compatibility_schema_value, ToolCatalog},
    limits::{PROVIDER_INTERRUPTED_MARKER, PROVIDER_STALL_MARKER},
    support::{is_model_capacity_error, is_stale_resume_error},
    tool_batch as provider_tool_batch,
};
use crate::{CapabilityId, GyroConfig, GyroPaths};
pub fn is_transient_provider_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    if is_provider_cancellation(error)
        || error.contains(CAPACITY_RETRY_EXHAUSTED)
        || error.contains(RETRY_EXHAUSTED)
        || error.contains(CONTINUATION_UNAVAILABLE)
        || is_stale_resume_error(error)
        || crate::is_workspace_unavailable_error(error)
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

pub fn is_rate_limit_error(error: &str) -> bool {
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

pub fn is_hopeless_provider_timeout(error: &str) -> bool {
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
pub fn configured_tool_rounds() -> Option<usize> {
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
pub const TOOL_BUDGET_CHECKPOINT: &str = "Gyro has stopped offering tools for this turn. Do not call more tools. Give a concise checkpoint: what is verified complete, what remains unfinished, and what to do next. Do not claim the whole task is complete.";

pub fn tools_for_round(
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
pub fn openai_tools_for_round(
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

/// Whether this text is the round-budget notice rather than a provider fault.
///
/// Matched by its stable phrase, not by keyword: the notice is produced by Gyro
/// and the words in it are ordinary enough to appear in a provider's own text.
pub fn is_tool_budget_notice(error: &str) -> bool {
    error.contains("round budget")
}

pub fn is_plan_exhausted(normalized: &str) -> bool {
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
pub fn readable_provider_error(error: &str) -> String {
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

pub fn provider_failure_recovery(error: &str) -> (&'static str, &'static str) {
    if error.contains(CONTINUATION_UNAVAILABLE) {
        return ("continuation-unavailable", "Completed work is preserved. The saved provider conversation is unavailable; automatic replay was stopped.");
    }
    if error.contains(RETRY_EXHAUSTED) {
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
    if crate::is_cli_argument_error(error) {
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
    if error.contains(CAPACITY_RETRY_EXHAUSTED) {
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
pub fn validate_tool_call(
    catalog: &dyn ToolCatalog,
    name: &str,
    arguments: &serde_json::Value,
) -> Result<CapabilityId, String> {
    let id = CapabilityId::from_provider_tool_name(name).ok_or(
        "Unknown Gyro tool. Choose a tool from the supplied tool list. No action was executed.",
    )?;
    if !arguments.is_object() {
        return Err("Tool arguments must be a JSON object. Correct the arguments and try again. No action was executed.".into());
    }
    let schema = catalog.schema(id);
    let mut normalized = std::borrow::Cow::Borrowed(arguments);
    // Validate the same effective observation budget the broker will use.
    // Only advertised size hints are repaired; paths, ranges, and mutation
    // arguments still have to satisfy their original schema.
    if schema["properties"].get("maxBytes").is_some() && arguments.get("maxBytes").is_some() {
        let budget = catalog
            .observation_byte_limit(arguments)
            .map_err(|error| error.to_string())?;
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

pub fn prepare_tool_call(
    catalog: &dyn ToolCatalog,
    messages: &mut Vec<serde_json::Value>,
    name: &str,
    arguments: &serde_json::Value,
    call_id: Option<&str>,
) -> Option<CapabilityId> {
    match validate_tool_call(catalog, name, arguments) {
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
