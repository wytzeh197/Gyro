use super::OllamaToolChatRequest;
use anyhow::Result;
use serde_json::Value;

#[derive(Debug)]
pub(super) struct OllamaContextOverflow;
impl std::fmt::Display for OllamaContextOverflow {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Ollama context cannot fit this request without discarding content. Compact history or select a model with a larger window.")
    }
}
impl std::error::Error for OllamaContextOverflow {}

pub(super) fn context_overflow_message(value: &Value) -> bool {
    value.as_str().is_some_and(|message| {
        let message = message.trim();
        message == "the input length exceeds the context length"
            || message.starts_with("the prompt is longer than the context length")
    })
}

/// The estimate chooses an allocation, never which history to discard. Ollama's
/// tokenizer remains authoritative: truncate/shift are disabled, and only an
/// explicit context rejection permits a bounded retry at the model's maximum.
pub(super) fn request_context_window(request: &OllamaToolChatRequest<'_>) -> Result<Option<u64>> {
    let Some(maximum) = request.context_window_tokens else {
        return Ok(None);
    };
    anyhow::ensure!(
        maximum > 0 && maximum <= i32::MAX as u64,
        "Ollama model returned an invalid context window"
    );
    let minimum = request.minimum_context_window_tokens.unwrap_or(0);
    anyhow::ensure!(
        minimum <= maximum,
        "Ollama minimum context exceeds the model window"
    );
    let characters = request
        .messages
        .iter()
        .chain(&request.tools)
        .map(|value| crate::provider_observation::text_size(value).0 as u64)
        .fold(0u64, u64::saturating_add);
    let estimate = characters
        .div_ceil(3)
        .saturating_add(2048)
        .saturating_add((request.messages.len() as u64).saturating_mul(64))
        .saturating_add((request.tools.len() as u64).saturating_mul(32));
    let allocation = estimate
        .max(4096)
        .max(minimum)
        .div_ceil(4096)
        .saturating_mul(4096);
    Ok(Some(allocation.min(maximum)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn request(text: Value) -> OllamaToolChatRequest<'static> {
        OllamaToolChatRequest {
            base_url: None,
            model: "fixture",
            messages: vec![text],
            tools: Vec::new(),
            context_window_tokens: Some(40960),
            minimum_context_window_tokens: None,
        }
    }
    #[test]
    fn small_prompts_do_not_allocate_the_entire_model_window() {
        assert_eq!(
            request_context_window(&request(json!({"content":"Hello"}))).unwrap(),
            Some(4096)
        );
        let larger = request_context_window(&request(json!({"content":"x".repeat(27000)})))
            .unwrap()
            .unwrap();
        assert!(larger >= 11000 && larger < 40960);
        assert_eq!(
            request_context_window(&request(json!({"content":"x".repeat(500000)}))).unwrap(),
            Some(40960)
        );
    }
    #[test]
    fn images_do_not_allocate_context_from_base64_bytes_and_tools_are_counted() {
        let mut value = request(json!({"content":"Hello", "images":["x".repeat(1000000)]}));
        assert_eq!(request_context_window(&value).unwrap(), Some(4096));
        value
            .tools
            .push(json!({"description":"schema".repeat(10000)}));
        assert!(request_context_window(&value).unwrap().unwrap() > 4096);
    }
    #[test]
    fn a_tool_loop_keeps_its_allocated_window_until_the_turn_ends() {
        let mut value = request(json!({"content":"Hello"}));
        value.minimum_context_window_tokens = Some(16384);
        assert_eq!(request_context_window(&value).unwrap(), Some(16384));
        value.minimum_context_window_tokens = Some(81920);
        assert!(request_context_window(&value).is_err());
        value.context_window_tokens = None;
        assert_eq!(request_context_window(&value).unwrap(), None);
    }
}
