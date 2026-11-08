use serde_json::Value;

/// Keep the structured category: a friendly message alone may omit the cause.
pub(super) fn failure_message(params: &Value) -> String {
    let error = &params["turn"]["error"];
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("Codex turn did not complete");
    match error.get("codexErrorInfo").filter(|info| !info.is_null()) {
        Some(info) => format!("{message} [Codex error: {info}]"),
        None => message.to_string(),
    }
}

/// Only the provider's matching turn-completion notification closes a run.
/// A completed message (including a preview/Canvas artifact) is intermediate
/// output and may be followed by a long verification command.
pub(super) fn completion_status<'a>(
    method: &str,
    params: &'a Value,
    thread_id: &str,
    turn_id: Option<&str>,
) -> Option<&'a str> {
    if method != "turn/completed" {
        return None;
    }
    if params
        .get("threadId")
        .and_then(Value::as_str)
        .is_some_and(|id| id != thread_id)
    {
        return None;
    }
    if let (Some(expected), Some(actual)) =
        (turn_id, params.pointer("/turn/id").and_then(Value::as_str))
    {
        if actual != expected {
            return None;
        }
    }
    Some(
        params
            .pointer("/turn/status")
            .and_then(Value::as_str)
            .unwrap_or("failed"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn failure_preserves_structured_quota_category_even_with_generic_copy() {
        let message = failure_message(&json!({"turn":{"error":{
            "message":"Request rejected",
            "codexErrorInfo":"usageLimitExceeded"
        }}}));
        assert!(message.contains("Request rejected"));
        assert!(message.contains("usageLimitExceeded"));
        assert_eq!(
            failure_message(&json!({"turn":{"error":{
                "message":"Disconnected", "codexErrorInfo":null
            }}})),
            "Disconnected"
        );
        assert_eq!(failure_message(&json!({})), "Codex turn did not complete");
    }

    #[test]
    fn artifacts_and_quiet_verification_do_not_complete_a_turn() {
        let artifact = json!({"threadId":"thread", "item":{
            "type":"agentMessage",
            "text":"GYRO_ARTIFACTS: {\"items\":[{\"id\":\"preview\",\"kind\":\"preview\",\"title\":\"Preview\",\"url\":\"http://127.0.0.1:1420\"}]}"
        }});
        assert_eq!(
            completion_status("item/completed", &artifact, "thread", Some("turn")),
            None
        );
        // Silence after the artifact is not a notification. Later tool work and
        // the final message must still be accepted before the turn closes.
        for method in ["item/started", "item/completed", "item/agentMessage/delta"] {
            assert_eq!(
                completion_status(method, &json!({}), "thread", Some("turn")),
                None
            );
        }
        assert_eq!(
            completion_status(
                "turn/completed",
                &json!({"threadId":"thread", "turn":{"id":"turn","status":"completed"}}),
                "thread",
                Some("turn")
            ),
            Some("completed")
        );
    }

    #[test]
    fn completion_is_scoped_and_preserves_failure_and_interrupt_statuses() {
        for status in ["completed", "failed", "interrupted"] {
            let params = json!({"threadId":"thread", "turn":{"id":"turn","status":status}});
            assert_eq!(
                completion_status("turn/completed", &params, "thread", Some("turn")),
                Some(status)
            );
            assert_eq!(
                completion_status("turn/completed", &params, "other", Some("turn")),
                None
            );
            assert_eq!(
                completion_status("turn/completed", &params, "thread", Some("other")),
                None
            );
        }
        assert_eq!(
            completion_status("turn/completed", &json!({}), "thread", None),
            Some("failed")
        );
    }
}
