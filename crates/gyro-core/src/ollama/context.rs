use super::{
    ensure_loopback_response_url, normalize_digest, ollama_endpoint, read_metadata,
    OllamaToolChatRequest,
};
use crate::CancellationToken;
use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::Value;
use std::time::Duration;

const GENERATION_HEADROOM_TOKENS: u64 = 2048;

#[derive(Debug, Default)]
pub(crate) struct OllamaContextOverflow {
    prompt_tokens: Option<u64>,
    pub(crate) rejected_allocation: Option<u64>,
}
impl std::fmt::Display for OllamaContextOverflow {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Ollama context cannot fit this request without discarding content. Compact history or select a model with a larger window.")
    }
}
impl std::error::Error for OllamaContextOverflow {}

impl OllamaContextOverflow {
    pub(super) fn from_response_error(value: &Value) -> Option<Self> {
        let Some(message) = value.as_str().map(str::trim) else {
            return Self::from_structured_error(value);
        };
        if message == "the input length exceeds the context length"
            || message.starts_with("the prompt is longer than the context length")
        {
            return Some(Self::default());
        }
        // Some Ollama versions forward llama-server's error envelope as a
        // string inside their own error field.
        let envelope: Value = serde_json::from_str(message).ok()?;
        Self::from_structured_error(envelope.get("error")?)
    }

    fn from_structured_error(value: &Value) -> Option<Self> {
        if value["type"] != "exceed_context_size_error" {
            return None;
        }
        let prompt_tokens = value["n_prompt_tokens"]
            .as_u64()
            .zip(value["n_ctx"].as_u64())
            .and_then(|(prompt, context)| (context > 0 && prompt >= context).then_some(prompt));
        Some(Self {
            prompt_tokens,
            rejected_allocation: None,
        })
    }

    pub(super) fn recovery_window(
        &self,
        allocated: Option<u64>,
        maximum: Option<u64>,
    ) -> Option<u64> {
        let (allocated, maximum) = allocated
            .zip(maximum)
            .filter(|(allocated, maximum)| allocated < maximum)?;
        let Some(prompt) = self.prompt_tokens else {
            return Some(maximum);
        };
        // The tokenizer already established that the unchanged prompt would
        // fill or exceed even the model's maximum allocation.
        if prompt >= maximum {
            return None;
        }
        Some(allocation_step(
            prompt
                .saturating_add(GENERATION_HEADROOM_TOKENS)
                .max(allocated + 1),
            maximum,
        ))
    }
}

fn allocation_step(tokens: u64, maximum: u64) -> u64 {
    tokens
        .checked_next_power_of_two()
        .unwrap_or(maximum)
        .min(maximum)
}

/// The estimate chooses an allocation, never which history to discard. Ollama's
/// tokenizer remains authoritative: truncate/shift are disabled, and only an
/// explicit context rejection permits a bounded retry with a larger window.
pub(super) fn request_context_window(
    request: &OllamaToolChatRequest<'_>,
    content_chars: impl FnOnce() -> usize,
) -> Result<Option<u64>> {
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
    let overhead = GENERATION_HEADROOM_TOKENS
        .saturating_add((request.messages.len() as u64).saturating_mul(64))
        .saturating_add((request.tools.len() as u64).saturating_mul(32));
    // Ollama reloads the model whenever num_ctx changes, so the allocation
    // grows in power-of-two steps: a growing conversation reloads a handful
    // of times instead of once per 4K of history.
    let allocate = |estimate: u64| allocation_step(estimate.max(4096).max(minimum), maximum);
    if allocate(overhead) == maximum {
        return Ok(Some(maximum));
    }
    let tokens = (content_chars() as u64).div_ceil(3);
    Ok(Some(allocate(overhead.saturating_add(tokens))))
}

#[derive(Deserialize)]
struct RunningModels {
    models: Vec<RunningModel>,
}

#[derive(Deserialize)]
struct RunningModel {
    name: String,
    digest: Option<String>,
    context_length: Option<u64>,
    expires_at: Option<DateTime<Utc>>,
}

/// A smaller allocation would unload a working runner. Only reuse a live
/// allocation that belongs to the selected local manifest and that Gyro can
/// keep requesting on later rounds. Status is optional on older daemons.
pub(super) fn resident_context_window(
    request: &OllamaToolChatRequest<'_>,
    estimated: Option<u64>,
    model_digest: Option<&str>,
    cancellation: &CancellationToken,
) -> Option<u64> {
    let (estimated, maximum, digest) = (estimated?, request.context_window_tokens?, model_digest?);
    if estimated >= maximum
        || request.minimum_context_window_tokens.is_some()
        || cancellation.is_cancelled()
    {
        return None;
    }
    let endpoint = ollama_endpoint(request.base_url).ok()?;
    let url = endpoint.join("ps").ok()?;
    let response = crate::chat_http::get(&url, cancellation, Duration::from_millis(40)).ok()?;
    ensure_loopback_response_url(response.get_url(), &endpoint).ok()?;
    let running: RunningModels = read_metadata(response.into_reader()).ok()?;
    let soon = Utc::now() + chrono::Duration::seconds(1);
    running.models.into_iter().find_map(|model| {
        let window = model.context_length?;
        (model.name == request.model
            && normalize_digest(model.digest.as_deref()?).eq_ignore_ascii_case(digest)
            && model.expires_at? > soon
            && (estimated < window && window <= maximum)
            && (window == maximum || window.is_power_of_two()))
        .then_some(window)
    })
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

    fn measured_window(request: &OllamaToolChatRequest<'_>) -> Result<Option<u64>> {
        let observation = crate::provider_observation::ChatObservation::for_arrays(
            &request.messages,
            Some(&request.tools),
        );
        request_context_window(request, || observation.content_chars())
    }

    #[test]
    fn small_prompts_do_not_allocate_the_entire_model_window() {
        assert_eq!(
            measured_window(&request(json!({"content":"Hello"}))).unwrap(),
            Some(4096)
        );
        let larger = measured_window(&request(json!({"content":"x".repeat(27000)})))
            .unwrap()
            .unwrap();
        assert!(larger >= 11000 && larger < 40960);
        assert!(larger.is_power_of_two(), "{larger} is not a stable step");
        // Growing history inside one step keeps num_ctx, so no model reload.
        let grown = measured_window(&request(json!({"content":"x".repeat(30000)})))
            .unwrap()
            .unwrap();
        assert_eq!(grown, larger);
        assert_eq!(
            measured_window(&request(json!({"content":"x".repeat(500000)}))).unwrap(),
            Some(40960)
        );
    }
    #[test]
    fn images_do_not_allocate_context_from_base64_bytes_and_tools_are_counted() {
        let mut value = request(json!({"content":"Hello", "images":["x".repeat(1000000)]}));
        assert_eq!(measured_window(&value).unwrap(), Some(4096));
        value
            .tools
            .push(json!({"description":"schema".repeat(10000)}));
        assert!(measured_window(&value).unwrap().unwrap() > 4096);
    }
    #[test]
    fn a_tool_loop_keeps_its_allocated_window_until_the_turn_ends() {
        let mut value = request(json!({"content":"Hello"}));
        value.minimum_context_window_tokens = Some(16384);
        assert_eq!(measured_window(&value).unwrap(), Some(16384));
        // A minimum between steps rounds up to the next step, never down.
        value.minimum_context_window_tokens = Some(20000);
        assert_eq!(measured_window(&value).unwrap(), Some(32768));
        value.minimum_context_window_tokens = Some(81920);
        assert!(measured_window(&value).is_err());
        value.context_window_tokens = None;
        assert_eq!(measured_window(&value).unwrap(), None);
    }

    #[test]
    fn allocation_at_the_model_limit_does_not_need_prompt_measurement() {
        let mut value = request(json!({"content":"Hello"}));
        value.context_window_tokens = Some(4096);
        let measure = || panic!("the window is already fixed");
        assert_eq!(request_context_window(&value, measure).unwrap(), Some(4096));
        value.context_window_tokens = Some(5000);
        value.minimum_context_window_tokens = Some(4097);
        assert_eq!(request_context_window(&value, measure).unwrap(), Some(5000));
    }
}
