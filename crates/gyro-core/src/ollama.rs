//! Safe, local-only access to an Ollama runtime.
//!
//! Gyro deliberately does not treat an arbitrary OpenAI-compatible server as
//! local. This module accepts only loopback HTTP endpoints and keeps runtime
//! discovery separate from persisted provider configuration.

use crate::usage::{UsageReason, UsageSource, UsageTokens};
use crate::CancellationToken;
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::io::BufReader;
use std::time::Duration;
use url::{Host, Url};
mod context;
use context::{context_overflow_message, request_context_window, OllamaContextOverflow};

pub const DEFAULT_OLLAMA_BASE_URL: &str = "http://localhost:11434/api";
pub const OLLAMA_CANCELLED_MESSAGE: &str = "Ollama chat cancelled";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
// A streamed local generation, including model load on a CPU host, can sit
// quiet for minutes. The 180s non-stream budget is what dropped those answers.
// This is the longest silence between bytes, not a limit on the whole answer.
const CHAT_IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const MAX_DISCOVERED_MODELS: usize = 100;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaDiscovery {
    pub base_url: String,
    pub models: Vec<OllamaModel>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaModel {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub parameter_size: Option<String>,
    pub quantization_level: Option<String>,
    pub context_window_tokens: Option<u64>,
    pub supports_tools: bool,
    pub supports_images: bool,
}

#[derive(Clone, Debug)]
pub struct OllamaChatRequest<'a> {
    pub base_url: Option<&'a str>,
    pub model: &'a str,
    pub system: &'a str,
    pub user: &'a str,
    pub context_window_tokens: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OllamaChatResponse {
    pub content: String,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub accounted_usage: UsageTokens,
    pub tool_calls: Vec<OllamaToolCall>,
    pub context_window_tokens: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct OllamaToolChatRequest<'a> {
    pub base_url: Option<&'a str>,
    pub model: &'a str,
    pub messages: Vec<serde_json::Value>,
    pub tools: Vec<serde_json::Value>,
    /// The selected model's maximum window. Allocation is sized to the request;
    /// an explicit context rejection may grow it within this limit.
    pub context_window_tokens: Option<u64>,
    /// Keep the allocation stable through one tool loop instead of reloading
    /// the runtime whenever compaction or an exchange makes the prompt smaller.
    pub minimum_context_window_tokens: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OllamaToolCall {
    pub name: String,
    pub arguments: serde_json::Value,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OllamaRuntimeStatus {
    Ready,
    NoModels,
    Unavailable,
}

/// Normalize and validate an Ollama endpoint.
///
/// Endpoints may use any loopback port so users running `OLLAMA_HOST` on a
/// non-default port can still connect. The service API is always rooted at
/// `/api`, and query strings, fragments, credentials, HTTPS, and non-loopback
/// hosts are refused rather than silently following a remote redirect.
pub fn ollama_endpoint(base_url: Option<&str>) -> Result<Url> {
    let raw = base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_OLLAMA_BASE_URL);
    let mut url = Url::parse(raw).context("invalid Ollama endpoint")?;
    if url.scheme() != "http" {
        return Err(anyhow!("Ollama endpoint must use loopback HTTP"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(anyhow!("Ollama endpoint must not include credentials"));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(anyhow!(
            "Ollama endpoint must not include a query or fragment"
        ));
    }
    let loopback = match url.host() {
        Some(Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(host)) => host.is_loopback(),
        Some(Host::Ipv6(host)) => host.is_loopback(),
        None => false,
    };
    if !loopback {
        return Err(anyhow!(
            "Ollama endpoint must be localhost or a loopback address"
        ));
    }
    let path = url.path().trim_end_matches('/');
    if path.is_empty() || path == "/api" {
        url.set_path("/api/");
    } else if !path.starts_with("/api/") {
        return Err(anyhow!("Ollama endpoint path must be /api"));
    } else {
        url.set_path(&format!("{path}/"));
    }
    Ok(url)
}

pub fn discover_ollama_models(base_url: Option<&str>) -> Result<OllamaDiscovery> {
    let endpoint = ollama_endpoint(base_url)?;
    let tags_url = endpoint.join("tags")?;
    let response = agent()
        .get(tags_url.as_str())
        .call()
        .map_err(ollama_http_error)?;
    ensure_loopback_response(&response, &endpoint)?;
    let tags: OllamaTagsResponse = response.into_json().context("invalid Ollama model list")?;
    let models = tags
        .models
        .into_iter()
        .take(MAX_DISCOVERED_MODELS)
        .map(|model| enrich_model(&endpoint, model))
        .collect::<Vec<_>>();
    Ok(OllamaDiscovery {
        base_url: endpoint.as_str().trim_end_matches('/').to_string(),
        models,
    })
}

/// Resolve only the selected model before a turn. Full catalog enrichment is
/// reserved for Settings; unrelated installed models must not delay a send.
pub fn discover_ollama_model(base_url: Option<&str>, model: &str) -> Result<Option<OllamaModel>> {
    discover_ollama_model_with_cancellation(base_url, model, &CancellationToken::default())
}

pub fn discover_ollama_model_with_cancellation(
    base_url: Option<&str>,
    model: &str,
    cancellation: &CancellationToken,
) -> Result<Option<OllamaModel>> {
    let result = discover_selected_model(base_url, model, cancellation);
    if cancellation.is_cancelled() {
        Err(anyhow!(OLLAMA_CANCELLED_MESSAGE))
    } else {
        result
    }
}

fn discover_selected_model(
    base_url: Option<&str>,
    model: &str,
    cancellation: &CancellationToken,
) -> Result<Option<OllamaModel>> {
    if cancellation.is_cancelled() {
        return Err(anyhow!(OLLAMA_CANCELLED_MESSAGE));
    }
    let endpoint = ollama_endpoint(base_url)?;
    let response = crate::chat_http::get(&endpoint.join("tags")?, cancellation, REQUEST_TIMEOUT)
        .map_err(ollama_http_error)?;
    ensure_loopback_response_url(response.get_url(), &endpoint)?;
    let tags: OllamaTagsResponse = read_metadata(response.into_reader())?;
    if cancellation.is_cancelled() {
        return Err(anyhow!(OLLAMA_CANCELLED_MESSAGE));
    }
    let Some(tag) = tags.models.into_iter().find(|tag| tag.name == model) else {
        return Ok(None);
    };
    let show = crate::chat_http::post_with_deadline(
        &endpoint.join("show")?,
        &ureq::json!({ "model": tag.name }),
        cancellation,
        REQUEST_TIMEOUT,
    )
    .ok()
    .and_then(|response| {
        ensure_loopback_response_url(response.get_url(), &endpoint).ok()?;
        read_metadata::<OllamaShowResponse>(response.into_reader()).ok()
    });
    if cancellation.is_cancelled() {
        return Err(anyhow!(OLLAMA_CANCELLED_MESSAGE));
    }
    Ok(Some(model_from_show(tag, show)))
}

fn read_metadata<T: serde::de::DeserializeOwned>(reader: impl std::io::Read) -> Result<T> {
    use std::io::Read;
    const LIMIT: u64 = 4 * 1024 * 1024;
    let mut bytes = Vec::new();
    reader.take(LIMIT + 1).read_to_end(&mut bytes)?;
    anyhow::ensure!(
        bytes.len() as u64 <= LIMIT,
        "Ollama metadata exceeded its size limit"
    );
    serde_json::from_slice(&bytes).context("invalid Ollama metadata")
}

/// Submit one text-only Ollama chat turn. The caller owns session history and
/// capability execution; keeping that state in Gyro is what makes runs
/// resumable even though Ollama itself has no durable conversation cursor.
pub fn ollama_chat(request: OllamaChatRequest<'_>) -> Result<OllamaChatResponse> {
    ollama_chat_with_cancellation(request, &CancellationToken::default())
}

pub fn ollama_chat_with_cancellation(
    request: OllamaChatRequest<'_>,
    cancellation: &CancellationToken,
) -> Result<OllamaChatResponse> {
    ollama_tool_chat_with_progress(
        OllamaToolChatRequest {
            base_url: request.base_url,
            model: request.model,
            messages: vec![
                serde_json::json!({ "role": "system", "content": request.system }),
                serde_json::json!({ "role": "user", "content": request.user }),
            ],
            tools: Vec::new(),
            context_window_tokens: request.context_window_tokens,
            minimum_context_window_tokens: None,
        },
        cancellation,
        |_| {},
    )
}

/// Run a single model turn with optional native function tools. Callers retain
/// the returned assistant/tool messages and decide which tool calls may cross
/// their own approval boundary before asking Ollama for the next turn.
pub fn ollama_tool_chat(request: OllamaToolChatRequest<'_>) -> Result<OllamaChatResponse> {
    ollama_tool_chat_with_progress(request, &CancellationToken::default(), |_| {})
}

/// Stream one Ollama turn, forwarding text deltas as they arrive.
///
/// Cancellation is checked between frames so Stop does not wait out the read
/// timeout. A non-stream JSON body is still accepted so tests and older
/// Ollama builds keep working.
pub fn ollama_tool_chat_with_progress<F>(
    request: OllamaToolChatRequest<'_>,
    cancellation: &CancellationToken,
    on_delta: F,
) -> Result<OllamaChatResponse>
where
    F: FnMut(&str),
{
    let mut window = request_context_window(&request)?;
    crate::provider_retry::stream_response(
        cancellation,
        |mut emit| loop {
            match ollama_tool_chat_once(&request, window, cancellation, &mut emit) {
                Err(error) if error.is::<OllamaContextOverflow>() => {
                    let can_grow = window
                        .zip(request.context_window_tokens)
                        .is_some_and(|(allocated, maximum)| allocated < maximum);
                    if !can_grow || !crate::provider_retry::compatibility_retry() {
                        return Err(error);
                    }
                    // A tokenizer-confirmed rejection happened before any
                    // published output or tool calls. One bounded retry uses
                    // the model's capacity, with identical messages and tools.
                    window = request.context_window_tokens;
                }
                result => return result,
            }
        },
        on_delta,
    )
    .map_err(|error| {
        if cancellation.is_cancelled() {
            anyhow!(OLLAMA_CANCELLED_MESSAGE)
        } else {
            error
        }
    })
}

fn ollama_tool_chat_once<F>(
    request: &OllamaToolChatRequest<'_>,
    window: Option<u64>,
    cancellation: &CancellationToken,
    mut on_delta: F,
) -> Result<OllamaChatResponse>
where
    F: FnMut(&str),
{
    if cancellation.is_cancelled() {
        return Err(anyhow!(OLLAMA_CANCELLED_MESSAGE));
    }
    let model = request.model.trim();
    if model.is_empty() {
        return Err(anyhow!("select an installed Ollama model before sending"));
    }
    let endpoint = ollama_endpoint(request.base_url)?;
    let url = endpoint.join("chat")?;
    let mut payload = ureq::json!({"model": model, "stream": true,
        "messages": request.messages, "tools": request.tools,
        "truncate": false, "shift": false});
    if let Some(window) = window {
        anyhow::ensure!(
            window > 0 && window <= i32::MAX as u64,
            "Ollama model returned an invalid context window"
        );
        payload["options"] = ureq::json!({ "num_ctx": window });
    }
    let mut observation = None;
    let mut receipt = crate::openai_compatible::UsageReceipt::start(cancellation);
    let response = crate::provider_retry::http_response(cancellation, || {
        observation = Some(crate::provider_observation::Request::start(&payload));
        let response = crate::chat_http::post(
            &url,
            "",
            &payload,
            &receipt.transport,
            CHAT_IDLE_TIMEOUT,
            true,
        );
        if matches!(&response, Err(ureq::Error::Status(400..=499, _))) {
            observation.as_mut().unwrap().rejected();
        }
        response
    })
    .map_err(ollama_generation_error)?;
    if (300..400).contains(&response.status()) {
        anyhow::bail!("Ollama redirected the chat request");
    }
    ensure_loopback_response_url(response.get_url(), &endpoint)?;
    let mut is_stream = response.content_type().contains("ndjson");
    let mut reader = BufReader::new(response.into_reader());
    let mut observation = observation.expect("a completed HTTP exchange was observed");
    let mut content = String::new();
    let mut tool_calls = Vec::new();
    let mut input_tokens = None;
    let mut output_tokens = None;
    let mut cached_input_tokens = None;
    let mut thinking_chars = 0usize;
    let mut line = String::new();
    let mut remaining = crate::provider_retry::MAX_CHAT_RESPONSE_BYTES;
    let mut completed = false;
    let mut receipt_completed = false;
    let mut final_usage = false;
    let mut usage_regressed = false;
    let mut terminal_error = None;
    loop {
        if cancellation.is_cancelled() {
            return Err(anyhow!(OLLAMA_CANCELLED_MESSAGE));
        }
        let read =
            match crate::provider_retry::read_chat_line(&mut reader, &mut line, &mut remaining) {
                Ok(read) => read,
                Err(_) if receipt.draining() && !cancellation.is_cancelled() => break,
                Err(error) => return Err(error).context("invalid Ollama chat stream"),
            };
        if read == 0 {
            receipt_completed = true;
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let frame: OllamaChatStreamFrame = match serde_json::from_str(trimmed) {
            Ok(frame) => frame,
            Err(_) if receipt.draining() => break,
            Err(error) => return Err(error).context("invalid Ollama chat response"),
        };
        final_usage |= (completed || frame.done == Some(true))
            && (frame.prompt_eval_count.is_some() || frame.eval_count.is_some());
        // Metrics are cumulative snapshots; a lower snapshot cannot erase
        // consumption already observed or establish a fresh zero receipt.
        usage_regressed |= retain_usage_snapshot(&mut input_tokens, frame.prompt_eval_count);
        usage_regressed |= retain_usage_snapshot(&mut output_tokens, frame.eval_count);
        usage_regressed |= retain_usage_snapshot(&mut cached_input_tokens, frame.prompt_eval_cached_count);
        observation.reported(input_tokens, output_tokens);
        observation.details(cached_input_tokens, None);
        if usage_regressed {
            observation.accounted_usage(regressed_usage(UsageTokens::measured(
                input_tokens, cached_input_tokens, output_tokens, None, None)));
        }
        if let Some(error) = frame.error {
            if content.is_empty()
                && thinking_chars == 0
                && tool_calls.is_empty()
                && context_overflow_message(&error)
            {
                observation.rejected();
                return Err(OllamaContextOverflow.into());
            }
            terminal_error.get_or_insert_with(|| {
                anyhow!("Ollama reported a generation error; no tool calls were executed")
            });
        }
        if frame.done_reason.as_deref() == Some("length") {
            terminal_error.get_or_insert_with(|| anyhow!(
                "Ollama reached its output token limit; the response is incomplete and no tool calls from this response were executed"
            ));
        }
        // Some gateways label NDJSON as JSON. Incomplete frames still require
        // the terminal done marker before any tool call can be used.
        is_stream |= frame.done == Some(false);
        if !completed && terminal_error.is_none() {
            if !frame.message.thinking.is_empty() {
                thinking_chars =
                    thinking_chars.saturating_add(frame.message.thinking.chars().count());
                observation.delta(&frame.message.thinking);
            }
            if !frame.message.content.is_empty() {
                observation.delta(&frame.message.content);
                on_delta(&frame.message.content);
                content.push_str(&frame.message.content);
            }
            for call in frame.message.tool_calls {
                if call.function.name.trim().is_empty() {
                    continue;
                }
                if tool_calls.len() >= crate::provider_retry::MAX_CHAT_TOOL_CALLS {
                    terminal_error = Some(anyhow!(
                        "Ollama returned too many tool calls; no tool calls were executed"
                    ));
                    break;
                }
                tool_calls.push(OllamaToolCall {
                    name: call.function.name,
                    arguments: call.function.arguments,
                });
            }
        }
        completed |= frame.done == Some(true);
        if completed || terminal_error.is_some() {
            receipt.begin(&mut remaining);
        }
    }
    if cancellation.is_cancelled() {
        return Err(anyhow!(OLLAMA_CANCELLED_MESSAGE));
    }
    anyhow::ensure!(
        completed || !is_stream || terminal_error.is_some(),
        "Ollama stream ended before completion; partial tool calls were not executed"
    );
    let content = content.trim().to_string();
    let output_chars = content.chars().count().saturating_add(thinking_chars)
        + tool_calls
            .iter()
            .map(|call| call.name.chars().count() + call.arguments.to_string().chars().count())
            .sum::<usize>();
    let mut accounted_usage = ollama_accounted_usage(
        input_tokens,
        output_tokens,
        cached_input_tokens,
        thinking_chars,
        crate::provider_observation::text_size(&payload).0,
        output_chars,
        receipt_completed && (final_usage || !is_stream),
    );
    if usage_regressed {
        accounted_usage = regressed_usage(accounted_usage);
    }
    observation.accounted_usage(accounted_usage);
    if terminal_error.is_none() || (receipt_completed && completed) {
        observation.complete(input_tokens, output_tokens, output_chars);
    }
    if let Some(error) = terminal_error {
        return Err(error);
    }
    if content.is_empty() && tool_calls.is_empty() {
        return Err(anyhow!("Ollama finished without a text response"));
    }
    Ok(OllamaChatResponse {
        content,
        input_tokens,
        output_tokens,
        accounted_usage,
        tool_calls,
        context_window_tokens: window,
    })
}

fn retain_usage_snapshot(current: &mut Option<u64>, incoming: Option<u64>) -> bool {
    let regressed = current.zip(incoming).is_some_and(|(old, new)| new < old);
    *current = match (*current, incoming) {
        (Some(old), Some(new)) => Some(old.max(new)),
        (old, new) => old.or(new),
    };
    regressed
}

fn regressed_usage(mut tokens: UsageTokens) -> UsageTokens {
    let mut accounting = tokens.effective_accounting();
    accounting.coverage = crate::usage::UsageCoverage::Estimated;
    accounting.reason = Some(crate::usage::UsageReason::InconsistentCounts);
    tokens.accounting = Some(accounting);
    tokens.measured = false;
    tokens
}

fn ollama_accounted_usage(
    input: Option<u64>,
    output: Option<u64>,
    cached: Option<u64>,
    thinking_chars: usize,
    input_chars: usize,
    output_chars: usize,
    receipt_complete: bool,
) -> UsageTokens {
    let mut tokens = if input.is_none() && output.is_none() {
        UsageTokens::estimated(input_chars, output_chars)
    } else {
        let mut tokens = UsageTokens::measured(input, cached, output, None, None);
        if input.is_none() || output.is_none() {
            let estimate = UsageTokens::estimated(input_chars, output_chars);
            if input.is_none() {
                tokens.input_tokens = estimate.input_tokens.max(tokens.input_tokens);
            }
            if output.is_none() {
                tokens.output_tokens = estimate.output_tokens.max(tokens.output_tokens);
            }
            tokens.total_tokens = tokens.input_tokens.saturating_add(tokens.output_tokens);
            if let Some(accounting) = tokens.accounting.as_mut() {
                accounting.source = UsageSource::Mixed;
                accounting.coverage = crate::usage::UsageCoverage::Estimated;
                accounting.reason = Some(UsageReason::MissingUsage);
            }
        }
        tokens
    };
    if thinking_chars > 0 {
        // Ollama's eval_count already includes thinking. No separate tokenizer
        // count is reported, so only the breakdown is a character estimate.
        tokens.reasoning_output_tokens =
            crate::usage::estimate_tokens(thinking_chars).min(tokens.output_tokens);
        if let Some(accounting) = tokens.accounting.as_mut() {
            if accounting.source == UsageSource::Provider {
                accounting.source = UsageSource::Mixed;
            }
            accounting.known.reasoning = false;
        }
        tokens = tokens.partial(UsageReason::ProviderIncomplete);
    }
    if input.is_none() || output.is_none() {
        tokens = tokens.partial(UsageReason::MissingUsage);
    } else if !receipt_complete {
        tokens = tokens.partial(UsageReason::ProviderIncomplete);
    }
    tokens
}

fn agent() -> ureq::Agent {
    // Discovery and health share one pooled agent; generation uses chat_http.
    static AGENT: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
    AGENT
        .get_or_init(|| agent_with_read_timeout(REQUEST_TIMEOUT))
        .clone()
}

/// Short discovery probes have a total deadline; generation uses chat_http.
fn agent_with_read_timeout(read_timeout: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(REQUEST_TIMEOUT)
        .timeout_read(read_timeout)
        .timeout_write(REQUEST_TIMEOUT)
        .timeout(read_timeout)
        .redirects(0)
        .build()
}

fn ensure_loopback_response(response: &ureq::Response, endpoint: &Url) -> Result<()> {
    ensure_loopback_response_url(response.get_url(), endpoint)
}
fn ensure_loopback_response_url(response_url: &str, endpoint: &Url) -> Result<()> {
    let response_url = Url::parse(response_url).context("invalid Ollama response URL")?;
    if response_url.host() != endpoint.host()
        || response_url.port_or_known_default() != endpoint.port_or_known_default()
    {
        return Err(anyhow!(
            "Ollama response left the configured loopback endpoint"
        ));
    }
    Ok(())
}

fn ollama_http_error(error: ureq::Error) -> anyhow::Error {
    match error {
        ureq::Error::Status(status, _) => anyhow!("Ollama returned HTTP {status}"),
        ureq::Error::Transport(error) => {
            anyhow!("could not reach the local Ollama service: {error}")
        }
    }
}

fn ollama_generation_error(error: ureq::Error) -> anyhow::Error {
    match error {
        ureq::Error::Status(400, response) => {
            use std::io::Read;
            let value =
                serde_json::from_reader::<_, serde_json::Value>(response.into_reader().take(8192))
                    .ok();
            if value
                .as_ref()
                .and_then(|value| value.get("error"))
                .is_some_and(context_overflow_message)
            {
                OllamaContextOverflow.into()
            } else {
                anyhow!("Ollama returned HTTP 400")
            }
        }
        error => ollama_http_error(error),
    }
}

#[derive(Deserialize)]
struct OllamaTagsResponse {
    #[serde(default)]
    models: Vec<OllamaTag>,
}

#[derive(Deserialize)]
struct OllamaTag {
    name: String,
    #[serde(default)]
    details: OllamaModelDetails,
}

#[derive(Default, Deserialize)]
struct OllamaModelDetails {
    family: Option<String>,
    parameter_size: Option<String>,
    quantization_level: Option<String>,
}

#[derive(Default, Deserialize)]
struct OllamaShowResponse {
    #[serde(default)]
    capabilities: Vec<String>,
    #[serde(default)]
    model_info: serde_json::Value,
}

#[derive(Default, Deserialize)]
struct OllamaChatStreamFrame {
    #[serde(default)]
    error: Option<serde_json::Value>,
    #[serde(default, deserialize_with = "nullable_message")]
    message: OllamaChatWireMessage,
    #[serde(default)]
    done: Option<bool>,
    #[serde(default)]
    done_reason: Option<String>,
    #[serde(default)]
    prompt_eval_count: Option<u64>,
    #[serde(default)]
    prompt_eval_cached_count: Option<u64>,
    #[serde(default)]
    eval_count: Option<u64>,
}

#[derive(Default, Deserialize)]
struct OllamaChatWireMessage {
    #[serde(default)]
    #[serde(deserialize_with = "nullable_text")]
    content: String,
    #[serde(default, deserialize_with = "nullable_text")]
    thinking: String,
    #[serde(default, deserialize_with = "nullable_calls")]
    tool_calls: Vec<OllamaToolCallWire>,
}

fn nullable_message<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<OllamaChatWireMessage, D::Error> {
    Ok(Option::<OllamaChatWireMessage>::deserialize(deserializer)?.unwrap_or_default())
}
fn nullable_text<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<String, D::Error> {
    Ok(Option::<String>::deserialize(deserializer)?.unwrap_or_default())
}
fn nullable_calls<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Vec<OllamaToolCallWire>, D::Error> {
    Ok(Option::<Vec<OllamaToolCallWire>>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Deserialize)]
struct OllamaToolCallWire {
    function: OllamaToolFunctionWire,
}

#[derive(Deserialize)]
struct OllamaToolFunctionWire {
    #[serde(default)]
    name: String,
    #[serde(default)]
    arguments: serde_json::Value,
}

fn enrich_model(endpoint: &Url, tag: OllamaTag) -> OllamaModel {
    let show = endpoint.join("show").ok().and_then(|url| {
        let response = agent()
            .post(url.as_str())
            .send_json(ureq::json!({ "model": tag.name }));
        let response = response.ok()?;
        ensure_loopback_response(&response, endpoint).ok()?;
        response.into_json::<OllamaShowResponse>().ok()
    });
    model_from_show(tag, show)
}

fn model_from_show(tag: OllamaTag, show: Option<OllamaShowResponse>) -> OllamaModel {
    let fallback_description = tag
        .details
        .family
        .as_deref()
        .map(|family| format!("Local {family} model through Ollama."))
        .unwrap_or_else(|| "Local model through Ollama.".into());
    let supports_tools = show.as_ref().is_some_and(|value| {
        value
            .capabilities
            .iter()
            .any(|capability| capability == "tools")
    });
    let context_window_tokens = show
        .as_ref()
        .and_then(|value| model_context_window(&value.model_info));
    OllamaModel {
        display_name: tag.name.clone(),
        id: tag.name,
        description: if supports_tools {
            format!("{fallback_description} Advertises function calling for governed Gyro tools.")
        } else {
            format!("{fallback_description} Uses Gyro's structured Workspace bridge because native function calling was not verified.")
        },
        parameter_size: tag.details.parameter_size,
        quantization_level: tag.details.quantization_level,
        context_window_tokens,
        supports_tools,
        supports_images: show.as_ref().is_some_and(|value| {
            value
                .capabilities
                .iter()
                .any(|capability| capability == "vision")
        }),
    }
}

fn model_context_window(value: &serde_json::Value) -> Option<u64> {
    let object = value.as_object()?;
    object.iter().find_map(|(key, value)| {
        (key.ends_with("context_length") || key.ends_with("context_length"))
            .then(|| value.as_u64())
            .flatten()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{Shutdown, TcpListener};

    fn read_payload(stream: &mut std::net::TcpStream) -> serde_json::Value {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut reader = BufReader::new(stream);
        let mut header = String::new();
        reader.read_line(&mut header).unwrap();
        let mut length = 0;
        loop {
            header.clear();
            reader.read_line(&mut header).unwrap();
            if header == "\r\n" {
                break;
            }
            if let Some((name, value)) = header.split_once(':') {
                if name.eq_ignore_ascii_case("content-length") {
                    length = value.trim().parse().unwrap();
                }
            }
        }
        let mut body = vec![0; length];
        reader.read_exact(&mut body).unwrap();
        if body.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(&body).unwrap()
        }
    }

    #[test]
    fn a_context_rejection_grows_once_without_discarding_the_prompt_or_tools() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, body) in [
                (
                    400,
                    r#"{"error":"the input length exceeds the context length"}"#,
                ),
                (
                    200,
                    r#"{"message":{"content":"ready"},"done":true,"prompt_eval_count":5,"eval_count":2}"#,
                ),
            ] {
                let (mut stream, _) = listener.accept().unwrap();
                requests.push(read_payload(&mut stream));
                write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
            assert_eq!(requests[0]["options"]["num_ctx"], 4096);
            assert_eq!(requests[1]["options"]["num_ctx"], 32768);
            for key in ["messages", "tools", "model", "truncate", "shift"] {
                assert_eq!(requests[0][key], requests[1][key], "{key}");
            }
            assert_eq!(requests[0]["truncate"], false);
            assert_eq!(requests[0]["shift"], false);
        });
        let _scope = crate::provider_observation::Scope::start();
        let response = ollama_tool_chat_with_progress(OllamaToolChatRequest {
            base_url: Some(&format!("http://{address}/api")), model: "fixture",
            messages: vec![serde_json::json!({"role":"user", "content":"Keep this original request."})],
            tools: vec![serde_json::json!({"function":{"name":"read_file", "parameters":{"type":"object"}}})],
            context_window_tokens: Some(32768), minimum_context_window_tokens: None,
        }, &CancellationToken::default(), |_| {}).unwrap();
        server.join().unwrap();
        assert_eq!(response.context_window_tokens, Some(32768));
        let summary = crate::provider_observation::snapshot().unwrap();
        assert_eq!(
            (summary.requests, summary.rejected, summary.retries),
            (2, 1, 1)
        );
        assert_eq!(summary.tokens.unwrap().total_tokens, 7);
    }

    #[test]
    fn context_errors_never_replay_published_text_or_partial_tool_calls() {
        for first in [
            r#"{"message":{"content":"visible"},"done":false}"#,
            r#"{"message":{"tool_calls":[{"function":{"name":"read_file","arguments":{}}}]},"done":false}"#,
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let body =
                format!("{first}\n{{\"error\":\"the input length exceeds the context length\"}}\n");
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                read_payload(&mut stream);
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            });
            let _scope = crate::provider_observation::Scope::start();
            let result = ollama_tool_chat_with_progress(
                OllamaToolChatRequest {
                    base_url: Some(&format!("http://{address}/api")),
                    model: "fixture",
                    messages: Vec::new(),
                    tools: Vec::new(),
                    context_window_tokens: Some(32768),
                    minimum_context_window_tokens: None,
                },
                &CancellationToken::default(),
                |_| {},
            );
            server.join().unwrap();
            assert!(result.is_err());
            let summary = crate::provider_observation::snapshot().unwrap();
            assert_eq!((summary.requests, summary.retries), (1, 0));
        }
    }

    fn chat_once_from_body(body: String, content_type: &'static str) -> Result<OllamaChatResponse> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(&mut stream);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let mut content_length = 0;
            loop {
                line.clear();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                if let Some((name, value)) = line.split_once(':') {
                    if name.eq_ignore_ascii_case("content-length") {
                        content_length = value.trim().parse().unwrap();
                    }
                }
            }
            reader.read_exact(&mut vec![0; content_length]).unwrap();
            drop(reader);
            write!(stream,
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()).unwrap();
        });
        let response = ollama_tool_chat_once(
            &OllamaToolChatRequest {
                base_url: Some(&format!("http://{address}/api")),
                model: "test",
                messages: Vec::new(),
                tools: Vec::new(),
                context_window_tokens: None,
                minimum_context_window_tokens: None,
            },
            None,
            &CancellationToken::default(),
            |_| {},
        );
        server.join().unwrap();
        response
    }

    #[test]
    fn cache_and_thinking_are_output_subsets_without_double_counting() {
        let _scope = crate::provider_observation::Scope::start();
        let response = chat_once_from_body(concat!(
            "{\"message\":{\"content\":null,\"thinking\":\"reasoning\",\"tool_calls\":null},\"done\":false}\n",
            "{\"message\":{\"content\":\"done\"},\"done\":false,\"prompt_eval_count\":100,\"eval_count\":10}\n",
            "{\"message\":null,\"done\":true,\"prompt_eval_count\":100,\"prompt_eval_cached_count\":80,\"eval_count\":20}\n",
            "{\"done\":true,\"prompt_eval_count\":100,\"prompt_eval_cached_count\":80,\"eval_count\":20}\n"
        ).to_string(), "application/x-ndjson").unwrap();
        assert_eq!(response.content, "done");
        let tokens = response.accounted_usage;
        assert_eq!(
            (
                tokens.input_tokens,
                tokens.output_tokens,
                tokens.cached_input_tokens,
                tokens.total_tokens
            ),
            (100, 20, 80, 120)
        );
        assert_eq!(tokens.reasoning_output_tokens, 3);
        let accounting = tokens.accounting.unwrap();
        assert_eq!(accounting.source, UsageSource::Mixed);
        assert!(accounting.known.cache_read);
        assert!(!accounting.known.reasoning);
        assert!(!tokens.measured);
        assert_eq!(crate::provider_observation::snapshot().unwrap().tokens.unwrap(),
            tokens.with_scope(crate::usage::UsageScope::Turn));
    }

    #[test]
    fn regressing_snapshots_keep_consumption_and_demote_the_collector_receipt() {
        let _scope = crate::provider_observation::Scope::start();
        let response = chat_once_from_body(concat!(
            "{\"message\":{\"content\":\"done\"},\"done\":false,\"prompt_eval_count\":100,\"eval_count\":20,\"prompt_eval_cached_count\":80}\n",
            "{\"done\":true,\"prompt_eval_count\":0,\"eval_count\":0,\"prompt_eval_cached_count\":0}\n"
        ).to_string(), "application/x-ndjson").unwrap();
        assert_eq!(response.accounted_usage.total_tokens, 120);
        assert!(!response.accounted_usage.measured);
        assert_eq!(response.accounted_usage.effective_accounting().coverage, crate::usage::UsageCoverage::Estimated);
        assert_eq!(response.accounted_usage.effective_accounting().reason, Some(UsageReason::InconsistentCounts));
        assert_eq!(crate::provider_observation::snapshot().unwrap().tokens.unwrap(),
            response.accounted_usage.with_scope(crate::usage::UsageScope::Turn));
    }

    #[test]
    fn error_then_final_metrics_preserves_counts_and_refuses_tools() {
        for terminal in [
            "{\"error\":\"generation failed\"}\n",
            "{\"done\":true,\"done_reason\":\"length\"}\n",
        ] {
            let _scope = crate::provider_observation::Scope::start();
            let body = format!(
                "{{\"message\":{{\"tool_calls\":[{{\"function\":{{\"name\":\"write_file\",\"arguments\":{{}}}}}}]}},\"done\":false}}\n{terminal}{{\"done\":true,\"prompt_eval_count\":40,\"eval_count\":5}}\n"
            );
            assert!(chat_once_from_body(body, "application/x-ndjson").is_err());
            let tokens = crate::provider_observation::snapshot()
                .unwrap()
                .tokens
                .unwrap();
            assert_eq!(
                (
                    tokens.input_tokens,
                    tokens.output_tokens,
                    tokens.total_tokens
                ),
                (40, 5, 45)
            );
        }
    }

    #[test]
    fn estimating_a_missing_half_changes_the_total_to_estimated() {
        let tokens = ollama_accounted_usage(None, Some(5), Some(100), 0, 8, 20, true);
        assert_eq!(tokens.input_tokens, 100);
        assert_eq!(tokens.total_tokens, 105);
        assert_eq!(tokens.effective_accounting().coverage, crate::usage::UsageCoverage::Estimated);
        assert!(!tokens.effective_accounting().known.input);
    }

    #[test]
    fn missing_metrics_and_explicit_zero_remain_distinct() {
        let missing = chat_once_from_body(
            "{\"message\":{\"content\":\"done\"},\"done\":true}\n".to_string(),
            "application/x-ndjson",
        )
        .unwrap()
        .accounted_usage;
        assert_eq!(
            missing.accounting.unwrap().source,
            UsageSource::CharacterEstimate
        );
        assert!(!missing.measured);
        let zero = chat_once_from_body(
            "{\"message\":{\"content\":\"done\"},\"done\":true,\"prompt_eval_count\":0,\"prompt_eval_cached_count\":0,\"eval_count\":0}\n".to_string(),"application/x-ndjson"
        ).unwrap().accounted_usage;
        assert_eq!(zero.total_tokens, 0);
        assert!(zero.measured && zero.accounting.unwrap().known.cache_read);
    }

    #[test]
    fn requires_completion_even_when_a_stream_is_mislabeled_as_json() {
        let body = r#"{"message":{"tool_calls":[{"function":{"name":"write_file","arguments":{}}}]},"done":false}"#;
        let error = chat_once_from_body(body.to_string(), "application/json").unwrap_err();
        assert!(error.to_string().contains("stream ended before completion"));

        let complete = format!("{body}\n{{\"done\":true}}\n");
        assert_eq!(
            chat_once_from_body(complete, "application/json")
                .unwrap()
                .tool_calls
                .len(),
            1
        );
    }

    #[test]
    fn refuses_generation_errors_after_partial_tool_calls() {
        let body = concat!(
            "{\"message\":{\"tool_calls\":[{\"function\":{\"name\":\"write_file\",\"arguments\":{}}}]},\"done\":false}\n",
            "{\"error\":\"generation failed\"}\n",
            "{\"done\":true}\n"
        );
        let error = chat_once_from_body(body.to_string(), "application/x-ndjson").unwrap_err();
        assert!(error.to_string().contains("generation error"));
    }

    #[test]
    fn refuses_output_limit_completion_even_with_valid_tool_arguments() {
        for body in [
            concat!(
                "{\"message\":{\"tool_calls\":[{\"function\":{\"name\":\"write_file\",\"arguments\":{}}}]},\"done\":false}\n",
                "{\"done\":true,\"done_reason\":\"length\"}\n"
            ),
            r#"{"message":{"content":"partial answer"},"done":true,"done_reason":"length"}"#,
            r#"{"message":{"tool_calls":[{"function":{"name":"write_file","arguments":{}}}]},"done":true,"done_reason":"length"}"#,
        ] {
            let error = chat_once_from_body(body.to_string(), "application/json").unwrap_err();
            assert!(error.to_string().contains("output token limit"), "{error}");
        }
    }

    #[test]
    fn accepts_tool_calls_with_normal_stop_reason() {
        let body = r#"{"message":{"tool_calls":[{"function":{"name":"read_file","arguments":{"path":"README.md"}}}]},"done":true,"done_reason":"stop"}"#;
        let response = chat_once_from_body(body.to_string(), "application/json").unwrap();
        assert_eq!(response.tool_calls.len(), 1);
        assert_eq!(response.tool_calls[0].name, "read_file");
    }

    #[test]
    fn refuses_excessive_tool_calls() {
        let call = serde_json::json!({"function":{"name":"read_file","arguments":{}}});
        let body = serde_json::json!({
            "message": {"tool_calls": vec![call; crate::provider_retry::MAX_CHAT_TOOL_CALLS + 1]},
            "done": true
        })
        .to_string();
        let error = chat_once_from_body(body, "application/json").unwrap_err();
        assert!(error.to_string().contains("too many tool calls"));
    }

    #[test]
    fn permits_only_loopback_http_endpoints() {
        assert_eq!(
            ollama_endpoint(None).unwrap().as_str(),
            "http://localhost:11434/api/"
        );
        assert!(ollama_endpoint(Some("http://127.0.0.1:11435")).is_ok());
        assert!(ollama_endpoint(Some("http://[::1]:11435/api")).is_ok());
        for endpoint in [
            "https://localhost:11434/api",
            "http://example.com/api",
            "http://user:secret@localhost:11434/api",
            "http://localhost:11434/v1",
        ] {
            assert!(ollama_endpoint(Some(endpoint)).is_err(), "{endpoint}");
        }
    }

    #[test]
    fn reads_context_window_from_model_info() {
        assert_eq!(
            model_context_window(&serde_json::json!({ "llama.context_length": 131072 })),
            Some(131072)
        );
    }

    #[test]
    fn chat_allows_model_loading_longer_than_a_health_probe() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(&mut stream);
            let mut request_line = String::new();
            reader.read_line(&mut request_line).unwrap();
            assert!(request_line.starts_with("POST /api/chat "));
            let mut content_length = 0;
            loop {
                let mut header = String::new();
                reader.read_line(&mut header).unwrap();
                if header == "\r\n" || header.is_empty() {
                    break;
                }
                if let Some((name, value)) = header.split_once(':') {
                    if name.eq_ignore_ascii_case("content-length") {
                        content_length = value.trim().parse().unwrap();
                    }
                }
            }
            let mut body = vec![0; content_length];
            reader.read_exact(&mut body).unwrap();
            drop(reader);
            std::thread::sleep(REQUEST_TIMEOUT + Duration::from_millis(250));
            let body = r#"{"message":{"content":"Local model ready"}}"#;
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let response = ollama_chat(OllamaChatRequest {
            base_url: Some(&format!("http://{address}/api")),
            model: "test-local-model",
            system: "Be concise",
            user: "Hello",
            context_window_tokens: None,
        })
        .unwrap();
        server.join().unwrap();
        assert_eq!(response.content, "Local model ready");
    }

    #[test]
    fn chat_streams_deltas_and_honors_cancel() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(&mut stream);
            let mut request_line = String::new();
            reader.read_line(&mut request_line).unwrap();
            let mut content_length = 0;
            loop {
                let mut header = String::new();
                reader.read_line(&mut header).unwrap();
                if header == "\r\n" || header.is_empty() {
                    break;
                }
                if let Some((name, value)) = header.split_once(':') {
                    if name.eq_ignore_ascii_case("content-length") {
                        content_length = value.trim().parse().unwrap();
                    }
                }
            }
            let mut body = vec![0; content_length];
            reader.read_exact(&mut body).unwrap();
            drop(reader);
            let payload = concat!(
                r#"{"message":{"content":"Hel"},"done":false}"#,
                "\n",
                r#"{"message":{"content":"lo"},"done":true,"prompt_eval_count":3,"eval_count":2}"#,
                "\n"
            );
            let request: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(request["options"]["num_ctx"], 4096);
            assert_eq!(request["truncate"], false);
            assert_eq!(request["shift"], false);
            assert_eq!(request["model"], "test-local-model");
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                payload.len(),
                payload
            )
            .unwrap();
        });
        let mut deltas = Vec::new();
        let response = ollama_tool_chat_with_progress(
            OllamaToolChatRequest {
                base_url: Some(&format!("http://{address}/api")),
                model: "test-local-model",
                messages: vec![serde_json::json!({ "role": "user", "content": "Hi" })],
                tools: Vec::new(),
                context_window_tokens: Some(32768),
                minimum_context_window_tokens: None,
            },
            &CancellationToken::default(),
            |delta| deltas.push(delta.to_string()),
        )
        .unwrap();
        server.join().unwrap();
        assert_eq!(deltas, ["Hel", "lo"]);
        assert_eq!(response.content, "Hello");
        assert_eq!(response.input_tokens, Some(3));
        assert_eq!(response.output_tokens, Some(2));

        let cancellation = CancellationToken::default();
        cancellation.cancel();
        let error = ollama_tool_chat_with_progress(
            OllamaToolChatRequest {
                base_url: Some("http://127.0.0.1:9/api"),
                model: "test-local-model",
                messages: Vec::new(),
                tools: Vec::new(),
                context_window_tokens: None,
                minimum_context_window_tokens: None,
            },
            &cancellation,
            |_| {},
        )
        .unwrap_err()
        .to_string();
        assert_eq!(error, OLLAMA_CANCELLED_MESSAGE);
    }

    #[test]
    fn rejects_invalid_context_windows_before_sending() {
        for window in [0, i32::MAX as u64 + 1, u64::MAX] {
            let error = ollama_tool_chat_once(
                &OllamaToolChatRequest {
                    base_url: Some("http://127.0.0.1:9/api"),
                    model: "test",
                    messages: Vec::new(),
                    tools: Vec::new(),
                    context_window_tokens: Some(window),
                    minimum_context_window_tokens: None,
                },
                Some(window),
                &CancellationToken::default(),
                |_| {},
            )
            .unwrap_err();
            assert_eq!(
                error.to_string(),
                "Ollama model returned an invalid context window"
            );
        }
    }

    #[test]
    fn text_chat_cancellation_closes_an_in_flight_silent_request() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (sent, received) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut reader = BufReader::new(&mut stream);
            let mut header = String::new();
            reader.read_line(&mut header).unwrap();
            let mut length = 0;
            loop {
                header.clear();
                reader.read_line(&mut header).unwrap();
                if header == "\r\n" {
                    break;
                }
                if let Some((name, value)) = header.split_once(':') {
                    if name.eq_ignore_ascii_case("content-length") {
                        length = value.trim().parse().unwrap();
                    }
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let request: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(request["options"]["num_ctx"], 4096);
            sent.send(()).unwrap();
            // No headers or body arrive: cancellation must interrupt the IO,
            // rather than merely rejecting a response minutes later.
            let mut byte = [0];
            assert_eq!(reader.read(&mut byte).unwrap(), 0);
        });
        let cancellation = CancellationToken::default();
        let worker_token = cancellation.clone();
        let (finished, result) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            finished
                .send(ollama_chat_with_cancellation(
                    OllamaChatRequest {
                        base_url: Some(&format!("http://{address}/api")),
                        model: "test-local-model",
                        system: "Be concise",
                        user: "Hello",
                        context_window_tokens: Some(40960),
                    },
                    &worker_token,
                ))
                .unwrap();
        });
        received.recv_timeout(Duration::from_secs(2)).unwrap();
        cancellation.cancel();
        let error = result
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .unwrap_err();
        assert_eq!(error.to_string(), OLLAMA_CANCELLED_MESSAGE);
        worker.join().unwrap();
        server.join().unwrap();
    }

    #[test]
    fn selected_model_discovery_cancels_during_tags_or_show() {
        for hang_on_show in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let (started, ready) = std::sync::mpsc::channel();
            let server = std::thread::spawn(move || {
                if hang_on_show {
                    let (mut stream, _) = listener.accept().unwrap();
                    read_payload(&mut stream);
                    let body = r#"{"models":[{"name":"fixture"}]}"#;
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                }
                let (mut stream, _) = listener.accept().unwrap();
                read_payload(&mut stream);
                started.send(()).unwrap();
                let mut byte = [0];
                assert_eq!(stream.read(&mut byte).unwrap(), 0);
            });
            let token = CancellationToken::default();
            let worker_token = token.clone();
            let (done, result) = std::sync::mpsc::channel();
            let worker = std::thread::spawn(move || {
                done.send(discover_ollama_model_with_cancellation(
                    Some(&format!("http://{address}/api")),
                    "fixture",
                    &worker_token,
                ))
                .unwrap();
            });
            ready.recv_timeout(Duration::from_secs(2)).unwrap();
            token.cancel();
            assert_eq!(
                result
                    .recv_timeout(Duration::from_secs(1))
                    .unwrap()
                    .unwrap_err()
                    .to_string(),
                OLLAMA_CANCELLED_MESSAGE
            );
            worker.join().unwrap();
            server.join().unwrap();
        }
    }

    #[test]
    fn a_send_enriches_only_the_selected_model() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for index in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut reader = BufReader::new(&mut stream);
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                requests.push(line.clone());
                let mut length = 0;
                loop {
                    line.clear();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    if let Some((name, value)) = line.split_once(':') {
                        if name.eq_ignore_ascii_case("content-length") {
                            length = value.trim().parse().unwrap();
                        }
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let response = if index == 0 {
                    serde_json::json!({"models": [{"name": "unused-a"}, {"name": "chosen"}, {"name": "unused-b"}]}).to_string()
                } else {
                    assert_eq!(
                        serde_json::from_slice::<serde_json::Value>(&body).unwrap()["model"],
                        "chosen"
                    );
                    serde_json::json!({"capabilities": ["tools", "vision"], "model_info": {"model.context_length": 32768}}).to_string()
                };
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    response.len(),
                    response
                )
                .unwrap();
            }
            requests
        });
        let model = discover_ollama_model(Some(&format!("http://{address}/api")), "chosen")
            .unwrap()
            .unwrap();
        let requests = server.join().unwrap();
        assert!(requests[0].starts_with("GET /api/tags"));
        assert!(requests[1].starts_with("POST /api/show"));
        assert!(model.supports_tools && model.supports_images);
        assert_eq!(model.context_window_tokens, Some(32768));
    }

    #[test]
    fn discovers_local_models_and_tool_capability() {
        for (capabilities, expected_tools, expected_images) in [
            (vec!["completion"], false, false),
            (vec!["completion", "tools"], true, false),
            (vec!["completion", "vision"], false, true),
            (vec!["completion", "tools", "vision"], true, true),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                for _ in 0..2 {
                    let (mut stream, _) = listener.accept().unwrap();
                    let mut reader = BufReader::new(&mut stream);
                    let mut request_line = String::new();
                    reader.read_line(&mut request_line).unwrap();
                    let mut content_length = 0;
                    loop {
                        let mut header = String::new();
                        reader.read_line(&mut header).unwrap();
                        if header.is_empty() || header == "\r\n" {
                            break;
                        }
                        if let Some((name, value)) = header.split_once(':') {
                            if name.eq_ignore_ascii_case("content-length") {
                                content_length = value.trim().parse().unwrap();
                            }
                        }
                    }
                    let mut request_body = vec![0; content_length];
                    reader.read_exact(&mut request_body).unwrap();
                    drop(reader);
                    let body = if request_line.starts_with("GET /api/tags") {
                        r#"{"models":[{"name":"qwen3-coder:latest","details":{"family":"qwen3","parameter_size":"8B","quantization_level":"Q4"}}]}"#.to_string()
                    } else {
                        serde_json::json!({"capabilities": capabilities, "model_info": {"qwen3.context_length": 32768}}).to_string()
                    };
                    write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .unwrap();
                    stream.flush().unwrap();
                    // Drain a POST body before closing. Otherwise a slow client
                    // can see a broken write and treat `/api/show` as unavailable.
                    let _ = stream.shutdown(Shutdown::Both);
                }
            });
            let discovery = discover_ollama_models(Some(&format!("http://{address}/api"))).unwrap();
            server.join().unwrap();
            assert_eq!(discovery.models.len(), 1);
            assert_eq!(discovery.models[0].id, "qwen3-coder:latest");
            assert_eq!(discovery.models[0].supports_tools, expected_tools);
            assert_eq!(discovery.models[0].supports_images, expected_images);
            assert_eq!(discovery.models[0].context_window_tokens, Some(32768));
        }
    }
}
