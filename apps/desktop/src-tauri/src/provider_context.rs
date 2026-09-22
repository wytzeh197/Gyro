//! Provider-reported context accounting and catalog-window normalization.

use serde::Serialize;
use serde_json::Value;

/// What a turn consumed of the model's context window.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProviderContextUsage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) cached_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reasoning_output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) total_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) model_context_window: Option<u64>,
}

#[derive(Default)]
pub(super) struct OllamaTurnUsage {
    requests: usize,
    incomplete: bool,
    input: u64,
    output: u64,
}

impl OllamaTurnUsage {
    pub(super) fn observe(&mut self, input: Option<u64>, output: Option<u64>) {
        self.requests += 1;
        if let (Some(input), Some(output)) = (input, output) {
            self.input = self.input.saturating_add(input);
            self.output = self.output.saturating_add(output);
        } else {
            self.incomplete = true;
        }
    }

    pub(super) fn measured(&self) -> Option<ProviderContextUsage> {
        (self.requests > 0 && !self.incomplete).then(|| ProviderContextUsage {
            input_tokens: Some(self.input),
            output_tokens: Some(self.output),
            total_tokens: Some(self.input.saturating_add(self.output)),
            ..ProviderContextUsage::default()
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ClaudeUsageFrame {
    Request,
    Turn,
}

pub(super) fn provider_context_usage_from_app_server(
    params: &Value,
) -> Option<ProviderContextUsage> {
    let token_usage = params.get("tokenUsage")?;
    let last = token_usage.get("last")?;
    Some(ProviderContextUsage {
        input_tokens: Some(last.get("inputTokens")?.as_u64()?),
        cached_input_tokens: last.get("cachedInputTokens").and_then(Value::as_u64),
        output_tokens: last.get("outputTokens").and_then(Value::as_u64),
        reasoning_output_tokens: last.get("reasoningOutputTokens").and_then(Value::as_u64),
        total_tokens: last.get("totalTokens").and_then(Value::as_u64),
        model_context_window: token_usage
            .get("modelContextWindow")
            .and_then(Value::as_u64),
    })
}

pub(super) fn provider_context_usage_from_codex_exec(
    value: &Value,
) -> Option<ProviderContextUsage> {
    if value.get("type").and_then(Value::as_str) != Some("turn.completed") {
        return None;
    }
    let usage = value.get("usage")?;
    Some(ProviderContextUsage {
        input_tokens: Some(usage.get("input_tokens")?.as_u64()?),
        cached_input_tokens: usage.get("cached_input_tokens").and_then(Value::as_u64),
        output_tokens: usage.get("output_tokens").and_then(Value::as_u64),
        reasoning_output_tokens: usage.get("reasoning_output_tokens").and_then(Value::as_u64),
        total_tokens: usage.get("total_tokens").and_then(Value::as_u64),
        model_context_window: usage
            .get("model_context_window")
            .or_else(|| value.get("model_context_window"))
            .and_then(Value::as_u64),
    })
}

pub(super) fn provider_context_usage_from_claude_stream(
    value: &Value,
) -> Option<(ClaudeUsageFrame, ProviderContextUsage)> {
    let frame_type = value.get("type").and_then(Value::as_str)?;
    let (frame, usage) = match frame_type {
        "result" => (ClaudeUsageFrame::Turn, value.get("usage")?),
        "assistant" => (
            ClaudeUsageFrame::Request,
            value.get("message")?.get("usage")?,
        ),
        _ => return None,
    };
    let field = |key: &str| usage.get(key).and_then(Value::as_u64);
    let fresh_input = field("input_tokens")?;
    let cache_creation = field("cache_creation_input_tokens").unwrap_or_default();
    let cache_read = field("cache_read_input_tokens").unwrap_or_default();
    let input_tokens = fresh_input + cache_creation + cache_read;
    let output_tokens = field("output_tokens").unwrap_or_default();
    Some((
        frame,
        ProviderContextUsage {
            input_tokens: Some(input_tokens),
            cached_input_tokens: Some(cache_creation + cache_read),
            output_tokens: Some(output_tokens),
            reasoning_output_tokens: None,
            total_tokens: Some(input_tokens + output_tokens),
            model_context_window: claude_stream_context_window(value),
        },
    ))
}

fn claude_stream_context_window(value: &Value) -> Option<u64> {
    value
        .get("modelUsage")?
        .as_object()?
        .values()
        .find_map(|entry| entry.get("contextWindow").and_then(Value::as_u64))
}

pub(super) fn provider_model_context_window(
    provider_id: &str,
    model_id: Option<&str>,
) -> Option<u64> {
    let model_id = model_id.map(str::trim).unwrap_or_default();
    let window = match provider_id {
        "openai" => match model_id {
            "gpt-6-astra" => 272_000,
            "gpt-5.4-mini" => 400_000,
            _ => 1_050_000,
        },
        "anthropic" => match model_id {
            "claude-haiku-4-5" => 200_000,
            _ => 1_000_000,
        },
        "kimi" | "gemini" => 1_000_000,
        "xai" => match model_id {
            "grok-4.7" | "grok-4.6" | "" => 500_000,
            _ => 131_072,
        },
        _ => return None,
    };
    Some(window)
}

fn exceeds_context_window(usage: &ProviderContextUsage) -> bool {
    let Some(window) = usage.model_context_window.filter(|window| *window > 0) else {
        return false;
    };
    let occupied = usage
        .total_tokens
        .unwrap_or_default()
        .max(usage.input_tokens.unwrap_or_default() + usage.output_tokens.unwrap_or_default());
    occupied > window
}

pub(super) fn provider_context_usage_with_window(
    reported: Option<ProviderContextUsage>,
    provider_id: &str,
    model_id: Option<&str>,
) -> Option<ProviderContextUsage> {
    let catalog_window = provider_model_context_window(provider_id, model_id);
    match reported {
        Some(mut usage) => {
            if usage.model_context_window.is_none() {
                usage.model_context_window = catalog_window;
            }
            if exceeds_context_window(&usage) {
                usage = ProviderContextUsage {
                    model_context_window: usage.model_context_window,
                    ..ProviderContextUsage::default()
                };
            }
            Some(usage)
        }
        None => catalog_window.map(|window| ProviderContextUsage {
            model_context_window: Some(window),
            ..ProviderContextUsage::default()
        }),
    }
}
