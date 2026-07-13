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
    extract_codex_agent_message_text(value).map(ProviderTextChunk::Final)
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
}
