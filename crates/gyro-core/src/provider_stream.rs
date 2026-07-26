use serde_json::Value;
use uuid::Uuid;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderTextChunk {
    Delta(String),
    Snapshot(String),
    Final(String),
}

pub fn extract_provider_session_id(value: &Value) -> Option<String> {
    for key in [
        "session_id",
        "sessionId",
        "conversation_id",
        "conversationId",
        "thread_id",
        "threadId",
    ] {
        if let Some(id) = value.get(key).and_then(Value::as_str) {
            if looks_like_session_id(id) {
                return Some(id.to_string());
            }
        }
    }
    match value {
        Value::Array(items) => items.iter().find_map(extract_provider_session_id),
        Value::Object(map) => map.values().find_map(extract_provider_session_id),
        _ => None,
    }
}

pub fn extract_provider_text_chunk(value: &Value) -> Option<ProviderTextChunk> {
    // Claude Code moved its partial messages inside a `stream_event` envelope,
    // which hid every text delta from the matches below. Nothing extracted the
    // answer, so the chat rendered the raw stream instead. Unwrap the envelope
    // before matching, and read the completed assistant message at the end of
    // the turn as well, so a future change to the partial-message shape costs a
    // live transcript rather than the whole answer.
    if let Some(event) = stream_event_payload(value) {
        return extract_provider_text_chunk(event);
    }
    if let Some(delta) = value.pointer("/delta/text").and_then(Value::as_str) {
        return Some(ProviderTextChunk::Delta(delta.to_string()));
    }
    if let Some(delta) = value.pointer("/message/delta/text").and_then(Value::as_str) {
        return Some(ProviderTextChunk::Delta(delta.to_string()));
    }
    if let Some(delta) = value.get("text_delta").and_then(Value::as_str) {
        return Some(ProviderTextChunk::Delta(delta.to_string()));
    }
    if let Some(delta) = value.get("textDelta").and_then(Value::as_str) {
        return Some(ProviderTextChunk::Delta(delta.to_string()));
    }
    let event_type = value
        .get("type")
        .or_else(|| value.get("event"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if event_type.contains("delta") {
        if let Some(delta) = value.get("delta").and_then(extract_provider_text_value) {
            return Some(ProviderTextChunk::Delta(delta));
        }
        for key in ["text", "content", "message"] {
            if let Some(delta) = value.get(key).and_then(extract_provider_text_value) {
                return Some(ProviderTextChunk::Delta(delta));
            }
        }
    }
    if event_type.contains("partial") {
        for key in ["text", "content", "message"] {
            if let Some(snapshot) = value.get(key).and_then(extract_provider_text_value) {
                return Some(ProviderTextChunk::Snapshot(snapshot));
            }
        }
    }
    if let Some(text) = extract_assistant_message_text(value) {
        return Some(ProviderTextChunk::Final(text));
    }
    if let Some(text) = extract_cli_result_text(value) {
        return Some(ProviderTextChunk::Final(text));
    }
    extract_codex_agent_message_text(value).map(ProviderTextChunk::Final)
}

/// The Anthropic event inside Claude Code's `stream_event` envelope.
fn stream_event_payload(value: &Value) -> Option<&Value> {
    (value.get("type").and_then(Value::as_str) == Some("stream_event"))
        .then(|| value.get("event"))
        .flatten()
        .filter(|event| event.is_object())
}

/// The assistant message a CLI emits once a turn's content is complete.
///
/// Deltas normally carry the answer, so this is a backstop: it is reported as
/// [`ProviderTextChunk::Final`], which callers apply only when nothing streamed.
/// Tool calls and thinking blocks carry no `text`, so they stay out of the reply.
pub fn extract_assistant_message_text(value: &Value) -> Option<String> {
    if value.get("type").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let message = value.get("message")?;
    if message.get("role").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let text = extract_provider_text_value(message.get("content")?)?;
    (!text.trim().is_empty()).then_some(text)
}

/// The final result line a CLI prints when the run succeeded.
///
/// Last resort, below both the deltas and the assistant message: a successful
/// run that reaches this with nothing extracted would otherwise be answered
/// with a dump of its own transcript.
fn extract_cli_result_text(value: &Value) -> Option<String> {
    if value.get("type").and_then(Value::as_str) != Some("result")
        || value.get("is_error").and_then(Value::as_bool) == Some(true)
    {
        return None;
    }
    let text = value.get("result").and_then(Value::as_str)?;
    (!text.trim().is_empty()).then(|| text.to_string())
}

pub fn extract_provider_text_value(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let text = items
                .iter()
                .filter_map(extract_provider_text_value)
                .collect::<String>();
            (!text.is_empty()).then_some(text)
        }
        Value::Object(map) => {
            let item_type = map.get("type").and_then(Value::as_str);
            if matches!(item_type, Some("reasoning" | "reasoning_text")) {
                return None;
            }
            map.get("text")
                .or_else(|| map.get("content"))
                .and_then(extract_provider_text_value)
        }
        _ => None,
    }
}

pub fn extract_codex_agent_message_text(value: &Value) -> Option<String> {
    let event_type = value
        .get("type")
        .or_else(|| value.get("event"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if event_type != "item.completed" {
        return None;
    }
    let item = value.get("item")?;
    let item_type = item.get("type").and_then(Value::as_str)?;
    let role = item.get("role").and_then(Value::as_str);
    if item_type != "agent_message"
        && item_type != "assistant_message"
        && !(item_type == "message" && role == Some("assistant"))
    {
        return None;
    }
    item.get("text")
        .or_else(|| item.get("content"))
        .and_then(extract_provider_text_value)
}

fn looks_like_session_id(value: &str) -> bool {
    let value = value.trim();
    Uuid::parse_str(value).is_ok()
        || (value.len() >= 12
            && value.len() <= 128
            && value
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.')))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_delta_snapshot_final_and_nested_session_identity() {
        assert_eq!(
            extract_provider_text_chunk(&serde_json::json!({"delta": {"text": "hi"}})),
            Some(ProviderTextChunk::Delta("hi".into()))
        );
        assert_eq!(
            extract_provider_text_chunk(&serde_json::json!({
                "type": "content_block_partial",
                "content": [{"type": "text", "text": "snapshot"}]
            })),
            Some(ProviderTextChunk::Snapshot("snapshot".into()))
        );
        assert_eq!(
            extract_provider_text_chunk(&serde_json::json!({
                "type": "item.completed",
                "item": {"type": "agent_message", "text": "done"}
            })),
            Some(ProviderTextChunk::Final("done".into()))
        );
        assert_eq!(
            extract_provider_session_id(&serde_json::json!({
                "nested": {"sessionId": "019f5a51-d9dc-7423-89fa-8f92cfe4d727"}
            })),
            Some("019f5a51-d9dc-7423-89fa-8f92cfe4d727".into())
        );
    }

    /// Lines copied from a real `claude --print --output-format stream-json
    /// --include-partial-messages` run on 2.1.218, which wraps the Anthropic
    /// events in a `stream_event` envelope. Read as a whole turn, because the
    /// failure this covers was not a wrong answer but no answer at all: every
    /// line parsed to `None` and the chat rendered the transcript itself.
    #[test]
    fn reads_a_claude_turn_through_the_stream_event_envelope() {
        let turn = [
            r#"{"type":"system","subtype":"init","cwd":"/tmp","session_id":"7f8c1f92-8195-46c7-a982-aaf32a040b61"}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"pine"}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"apple"}}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"pineapple"}]},"session_id":"7f8c1f92-8195-46c7-a982-aaf32a040b61"}"#,
            r#"{"type":"stream_event","event":{"type":"message_stop"}}"#,
            r#"{"type":"result","subtype":"success","is_error":false,"result":"pineapple"}"#,
        ]
        .into_iter()
        .map(|line| serde_json::from_str::<Value>(line).expect("valid line"))
        .collect::<Vec<_>>();

        let streamed = turn
            .iter()
            .filter_map(|line| match extract_provider_text_chunk(line) {
                Some(ProviderTextChunk::Delta(delta)) => Some(delta),
                _ => None,
            })
            .collect::<String>();
        assert_eq!(
            streamed, "pineapple",
            "deltas did not reassemble the answer"
        );

        // Both backstops carry the same answer on their own, so a turn that
        // streams nothing still resolves to the reply instead of the raw stream.
        let finals = turn
            .iter()
            .filter_map(|line| match extract_provider_text_chunk(line) {
                Some(ProviderTextChunk::Final(text)) => Some(text),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            finals,
            vec!["pineapple".to_string(), "pineapple".to_string()]
        );
    }

    #[test]
    fn keeps_tool_calls_thinking_and_failures_out_of_the_reply() {
        // Everything a turn streams that is not the answer. Any of these
        // leaking would put tool arguments or private reasoning in the chat.
        for line in [
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"src\"}"}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"considering"}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"Read"}}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"file body"}]}}"#,
            // A failed run's result line is the error text, not a reply; the
            // caller reports the failure instead of answering with it.
            r#"{"type":"result","subtype":"success","is_error":true,"result":"Failed to authenticate. API Error: 401"}"#,
        ] {
            let value = serde_json::from_str::<Value>(line).expect("valid line");
            assert_eq!(
                extract_provider_text_chunk(&value),
                None,
                "leaked into the reply: {line}"
            );
        }
    }
}
