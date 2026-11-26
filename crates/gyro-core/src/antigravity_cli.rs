//! Parsers for Google's official Antigravity CLI (`agy`).
//!
//! Gyro launches Antigravity as the unmodified ACP server `agy acp`, limited
//! to Gemini models. It does not wrap `agy -p`. The CLI can still emit the
//! documented print-mode frames below; these parsers recognize them when a
//! process writes them.
//!
//! The frame shapes below are the documented ones:
//!
//! ```text
//! {"event":"step_update","step_update":{"conversation_id":"…","step_index":4,
//!   "state":"ACTIVE","step_type":"agent_response","text_delta":"Hel"}}
//! {"event":"result","result":{"conversation_id":"…","status":"SUCCESS",
//!   "response":"Hello\n","usage":{"input_tokens":…,"output_tokens":…,
//!   "thinking_tokens":…,"cache_read_tokens":…,"total_tokens":…}}}
//! ```
//!
use serde_json::Value;

/// Executable Gyro launches, resolved through the GUI PATH at spawn time.
pub const PROGRAM: &str = "agy";

/// Shown when the CLI is installed but has no signed-in Google account.
pub const SIGN_IN_HINT: &str =
    "Sign in to Antigravity: run `agy` once in a terminal and finish the Google sign-in";

/// What the CLI prints when it has no usable credential.
pub const SIGN_IN_MARKER: &str = "Please sign in";

/// The payload of an `event`-keyed frame, if this frame is one.
///
/// `agy` wraps every frame as `{"event":"<name>","<name>":{…}}`, so matching the
/// documented fields on the envelope alone finds nothing.
pub fn frame(value: &Value) -> Option<(&str, &Value)> {
    let name = value.get("event").and_then(Value::as_str)?;
    let payload = value.get(name)?;
    payload.is_object().then_some((name, payload))
}

/// Incremental answer text from an `agent_response` step.
pub fn text_delta(value: &Value) -> Option<&str> {
    let (name, payload) = frame(value)?;
    if name != "step_update" {
        return None;
    }
    if payload.get("step_type").and_then(Value::as_str) != Some("agent_response") {
        return None;
    }
    payload
        .get("text_delta")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

fn result_payload(payload: &Value) -> &Value {
    payload
        .get("result")
        .filter(|result| result.is_object())
        .unwrap_or(payload)
}

/// The whole turn's answer, from the `result` frame.
///
/// Callers treat this as a backstop that applies only when nothing streamed.
pub fn final_text(value: &Value) -> Option<&str> {
    let (name, payload) = frame(value)?;
    if name != "result" {
        return None;
    }
    result_payload(payload)
        .get("response")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
}

/// The conversation id a later turn resumes with `--conversation`.
pub fn conversation_id(value: &Value) -> Option<&str> {
    let (_, payload) = frame(value)?;
    result_payload(payload)
        .get("conversation_id")
        .or_else(|| value.get("conversation_id"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
}

/// Token counts reported by a frame, per step or cumulative.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct AntigravityUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub thinking_tokens: u64,
    pub cache_read_tokens: u64,
    pub total_tokens: u64,
}

impl AntigravityUsage {
    pub fn is_empty(&self) -> bool {
        self.total_tokens == 0 && self.input_tokens == 0 && self.output_tokens == 0
    }
}

fn count(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

/// Usage carried by a frame, when it reports any.
pub fn usage(value: &Value) -> Option<AntigravityUsage> {
    let (_, payload) = frame(value)?;
    let usage = result_payload(payload)
        .get("usage")
        .filter(|usage| usage.is_object())?;
    let usage = AntigravityUsage {
        input_tokens: count(usage, "input_tokens"),
        output_tokens: count(usage, "output_tokens"),
        thinking_tokens: count(usage, "thinking_tokens"),
        cache_read_tokens: count(usage, "cache_read_tokens"),
        total_tokens: count(usage, "total_tokens"),
    };
    (!usage.is_empty()).then_some(usage)
}

/// Step usage belongs to this invocation; result usage can include prior turns.
/// Keep the latest report for each step so repeated DONE frames are not billed
/// twice. A resumed run with only cumulative usage cannot prove a turn cost.
pub fn turn_usage(stdout: &str, resumed: bool) -> Option<AntigravityUsage> {
    let mut steps = std::collections::BTreeMap::new();
    let mut total = None;
    for value in stdout
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
    {
        let Some((event, payload)) = frame(&value) else {
            continue;
        };
        let Some(usage) = usage(&value) else { continue };
        if event == "step_update" {
            if let Some(index) = payload.get("step_index").and_then(Value::as_u64) {
                steps.insert(index, usage);
            }
        } else if event == "result" {
            total = Some(usage);
        }
    }
    if steps.is_empty() {
        return if resumed { None } else { total };
    }
    Some(
        steps
            .values()
            .fold(AntigravityUsage::default(), |sum, step| AntigravityUsage {
                input_tokens: sum.input_tokens.saturating_add(step.input_tokens),
                output_tokens: sum.output_tokens.saturating_add(step.output_tokens),
                thinking_tokens: sum.thinking_tokens.saturating_add(step.thinking_tokens),
                cache_read_tokens: sum.cache_read_tokens.saturating_add(step.cache_read_tokens),
                total_tokens: sum.total_tokens.saturating_add(step.total_tokens),
            }),
    )
}

/// Text alone is not proof that a stream completed. Preserve partial text in
/// the UI, but require the CLI's terminal success frame before saving success.
pub fn stream_failure(stdout: &str) -> Option<String> {
    let mut completed = false;
    for value in stdout
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
    {
        if let Some(error) = failure_detail(&value) {
            return Some(error);
        }
        if let Some(("result", payload)) = frame(&value) {
            completed = result_payload(payload)
                .get("status")
                .and_then(Value::as_str)
                .is_some_and(|status| status.eq_ignore_ascii_case("SUCCESS"));
        }
    }
    (!completed).then(|| "Antigravity stopped before reporting a completed result".into())
}

/// The failure detail a `result` frame reports, when the turn did not succeed.
pub fn failure_detail(value: &Value) -> Option<String> {
    let (name, payload) = frame(value)?;
    if name != "result" {
        return None;
    }
    let payload = result_payload(payload);
    let status = payload.get("status").and_then(Value::as_str)?;
    if status.eq_ignore_ascii_case("SUCCESS") {
        return None;
    }
    let detail = payload
        .get("error")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|detail| !detail.is_empty())
        .map(str::to_string);
    Some(detail.unwrap_or_else(|| format!("antigravity run ended with status {status}")))
}

/// Whether CLI output means "installed, but no Google account signed in".
pub fn needs_sign_in(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    text.contains("please sign in")
        || text.contains("not signed in")
        || text.contains("authentication required")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn resumed_usage_counts_this_turn_once_and_truncated_streams_fail() {
        let step = json!({"event":"step_update","step_update":{"step_index":8,"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}).to_string();
        let result = json!({"event":"result","result":{"status":"SUCCESS","usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}}}).to_string();
        let stream = format!("{step}\n{step}\n{result}\n");
        assert_eq!(turn_usage(&stream, true).unwrap().total_tokens, 12);
        assert_eq!(turn_usage(&result, true), None);
        assert_eq!(turn_usage(&result, false).unwrap().total_tokens, 120);
        assert!(stream_failure(&step).is_some());
        assert!(stream_failure(&stream).is_none());
        assert_eq!(
            stream_failure(
                r#"{"event":"result","result":{"status":"ERROR","error":"unavailable"}}"#
            )
            .as_deref(),
            Some("unavailable")
        );
    }

    #[test]
    fn reads_top_level_init_conversation_and_headless_auth_error() {
        assert_eq!(
            conversation_id(
                &json!({"event":"init","conversation_id":"session-1","init":{"cwd":"/tmp"}})
            ),
            Some("session-1")
        );
        assert!(needs_sign_in("Authentication required"));
    }

    fn step(text: &str) -> Value {
        json!({
            "event": "step_update",
            "step_update": {
                "conversation_id": "9ec58bfd-4d67-4f5e-83a5-9d907e9c6b1f",
                "step_index": 1,
                "state": "ACTIVE",
                "step_type": "agent_response",
                "text_delta": text,
            }
        })
    }

    #[test]
    fn streams_agent_response_deltas() {
        assert_eq!(text_delta(&step("Hel")), Some("Hel"));
        // An empty delta is padding, not text to render.
        assert_eq!(text_delta(&step("")), None);
    }

    #[test]
    fn ignores_text_from_other_step_types() {
        let tool = json!({
            "event": "step_update",
            "step_update": {
                "step_type": "tool",
                "tool_name": "run_command",
                "text_delta": "not the answer",
            }
        });
        assert_eq!(text_delta(&tool), None);
    }

    #[test]
    fn reads_final_text_and_usage_from_the_result_frame() {
        let result = json!({
            "event": "result",
            "result": {
                "conversation_id": "055a398f-db14-4c5f-abbb-1bf03f8120a7",
                "status": "SUCCESS",
                "response": "apple\n",
                "num_turns": 1,
                "usage": {
                    "input_tokens": 30384,
                    "output_tokens": 4,
                    "thinking_tokens": 0,
                    "cache_read_tokens": 30214,
                    "total_tokens": 30388,
                }
            }
        });
        assert_eq!(final_text(&result), Some("apple\n"));
        assert_eq!(
            conversation_id(&result),
            Some("055a398f-db14-4c5f-abbb-1bf03f8120a7")
        );
        let usage = usage(&result).expect("usage");
        assert_eq!(usage.input_tokens, 30384);
        assert_eq!(usage.cache_read_tokens, 30214);
        assert_eq!(usage.total_tokens, 30388);
        assert_eq!(failure_detail(&result), None);
    }

    #[test]
    fn conversation_id_survives_on_other_frames() {
        let frame = json!({
            "event": "init",
            "init": { "conversation_id": "42f0a4b0-0000-4000-8000-000000000000" }
        });
        assert_eq!(
            conversation_id(&frame),
            Some("42f0a4b0-0000-4000-8000-000000000000")
        );
    }

    #[test]
    fn reports_a_failed_result_frame() {
        let failed = json!({
            "event": "result",
            "result": { "status": "ERROR", "error": "model unavailable" }
        });
        assert_eq!(
            failure_detail(&failed).as_deref(),
            Some("model unavailable")
        );
        let bare = json!({ "event": "result", "result": { "status": "TIMEOUT" } });
        assert_eq!(
            failure_detail(&bare).as_deref(),
            Some("antigravity run ended with status TIMEOUT")
        );
    }

    #[test]
    fn detects_the_sign_in_requirement() {
        assert!(needs_sign_in(
            "Error: Please sign in to view available models."
        ));
        assert!(!needs_sign_in("gemini-3.7-flash"));
    }

    #[test]
    fn launch_contract_is_the_acp_protocol_not_print_mode() {
        let contract = crate::provider_contract::provider_cli_contract("antigravity")
            .expect("antigravity contract");
        assert_eq!(contract.program, PROGRAM);
        assert_eq!(
            contract.prompt_delivery,
            crate::provider_contract::PromptDelivery::Protocol
        );
        let runtime = crate::provider_runtime::runners::kimi_acp::acp_provider_runtime("antigravity")
            .expect("agy acp");
        assert_eq!(runtime.program, PROGRAM);
        assert_eq!(runtime.args, &["acp"]);
    }
}
