//! Direct HTTPS access to OpenAI-compatible chat-completion endpoints.
//!
//! [`crate::ollama`] deliberately refuses anything that is not loopback HTTP,
//! because it talks to a service the user runs on their own machine. This module
//! is the opposite case: it exists so a user can point Gyro at *any* provider
//! that speaks the OpenAI wire format — DeepSeek, Mistral, OpenRouter, Together,
//! Groq, LM Studio, or a private gateway — so it has to accept public hosts.
//!
//! The loopback restriction is replaced by a transport rule rather than dropped:
//! plain HTTP stays available for loopback (LM Studio, vLLM, llama.cpp), and
//! every other host must be HTTPS. Credentials travel in an `Authorization`
//! header, never in the URL, and redirects are refused so a Bearer token cannot
//! be walked to a host the user did not configure.

use crate::usage::{UsageReason, UsageSource, UsageTokens};
use crate::CancellationToken;
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::io::{BufReader, Read};
use std::time::Duration;
use url::{Host, Url};

pub const OPENAI_COMPAT_CANCELLED_MESSAGE: &str = "Provider chat cancelled";
const CHAT_PATH: &str = "chat/completions";
const MODELS_PATH: &str = "models";
// A cold TLS handshake to a distant gateway is not a local socket connect; the
// 5s Ollama budget reported healthy providers as unreachable.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
// A reasoning model can think for minutes before its first token, so this is
// the longest silence tolerated between bytes, not a limit on the whole answer.
const CHAT_IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_DISCOVERED_MODELS: usize = 500;
const MAX_ERROR_BODY_CHARS: usize = 400;

/// Finishing generation and receiving its final usage are separate events.
/// A private transport cancellation lets us bound the receipt phase without
/// cancelling the user's turn. The watchdog is joined on every exit.
pub(crate) struct UsageReceipt {
    pub(crate) transport: CancellationToken,
    control: std::sync::mpsc::Sender<bool>,
    worker: Option<std::thread::JoinHandle<()>>,
    draining: bool,
}
pub(crate) const MAX_USAGE_RECEIPT_BYTES: usize = 64 * 1024;
const USAGE_RECEIPT_TIMEOUT: Duration = Duration::from_secs(2);

impl UsageReceipt {
    pub(crate) fn start(cancellation: &CancellationToken) -> Self {
        let transport = CancellationToken::default();
        let signal = transport.clone();
        let parent = cancellation.clone();
        let (control, commands) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let mut deadline = None;
            loop {
                if parent.is_cancelled()
                    || deadline.is_some_and(|until| std::time::Instant::now() >= until)
                {
                    signal.cancel();
                    break;
                }
                match commands.recv_timeout(Duration::from_millis(10)) {
                    Ok(true) => {
                        deadline.get_or_insert(std::time::Instant::now() + USAGE_RECEIPT_TIMEOUT);
                    }
                    Ok(false) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                }
            }
        });
        Self {
            transport,
            control,
            worker: Some(worker),
            draining: false,
        }
    }
    pub(crate) fn begin(&mut self, remaining: &mut usize) {
        if !self.draining {
            self.draining = true;
            *remaining = (*remaining).min(MAX_USAGE_RECEIPT_BYTES);
            let _ = self.control.send(true);
        }
    }
    pub(crate) fn draining(&self) -> bool {
        self.draining
    }
}
impl Drop for UsageReceipt {
    fn drop(&mut self) {
        let _ = self.control.send(false);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[derive(Clone, Debug)]
pub struct OpenAiCompatChatRequest<'a> {
    pub base_url: &'a str,
    /// Bearer token. Empty is allowed so a keyless loopback server (LM Studio)
    /// works; the header is simply omitted.
    pub api_key: &'a str,
    pub model: &'a str,
    pub messages: Vec<serde_json::Value>,
    pub tools: Vec<serde_json::Value>,
    /// Thinking budget, sent as `reasoning_effort` when the selected model
    /// publishes an effort ramp. Endpoints that do not take the field are why
    /// unsupported explicit effort remains an actionable provider error.
    pub reasoning_effort: Option<&'a str>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpenAiCompatChatResponse {
    pub content: String,
    /// Transport-only reasoning state. Thinking models such as DeepSeek require
    /// this on the assistant message when continuing after a tool result. Keep
    /// it inside the active tool loop, separate from visible text and history.
    pub reasoning_content: Option<String>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    /// Request-scoped counts and their provenance, including provider subsets.
    pub accounted_usage: UsageTokens,
    pub tool_calls: Vec<OpenAiCompatToolCall>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpenAiCompatToolCall {
    /// Provider-assigned call id. OpenAI requires the matching `tool_call_id` on
    /// the tool result message, so a multi-round loop must carry this through.
    pub id: Option<String>,
    pub name: String,
    /// Parsed arguments. The wire format carries these as a JSON *string* split
    /// across streaming frames; fragments are concatenated and parsed here so
    /// callers see the object shape Ollama already returns.
    pub arguments: serde_json::Value,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiCompatDiscovery {
    pub base_url: String,
    pub models: Vec<OpenAiCompatModel>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiCompatModel {
    pub id: String,
    pub display_name: String,
    pub description: String,
}

/// Normalize and validate a user-supplied OpenAI-compatible base URL.
///
/// The base URL is used exactly as configured (including any `/v1` or gateway
/// path prefix); Gyro appends `/chat/completions` and `/models` to it. A query
/// string is preserved because some gateways version their API through it.
pub fn openai_compat_endpoint(base_url: &str) -> Result<Url> {
    let raw = base_url.trim();
    if raw.is_empty() {
        return Err(anyhow!("set a base URL for this provider before sending"));
    }
    let url = Url::parse(raw).context("invalid provider base URL")?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(anyhow!(
            "provider base URL must not embed credentials; Gyro sends the API key as a Bearer header"
        ));
    }
    if url.fragment().is_some() {
        return Err(anyhow!("provider base URL must not include a fragment"));
    }
    match url.scheme() {
        "https" => {}
        "http" => {
            if !openai_compat_host_is_loopback(&url) {
                return Err(anyhow!(
                    "provider base URL must use https; plain http is allowed only for localhost or a loopback address"
                ));
            }
        }
        _ => {
            return Err(anyhow!(
                "provider base URL must use https (plain http is allowed only for loopback)"
            ))
        }
    }
    if url.host().is_none() {
        return Err(anyhow!("provider base URL must include a host"));
    }
    Ok(url)
}

/// True when the endpoint points at the local machine. Health, the model probe,
/// and the "is a key required" decision all hinge on this.
pub fn openai_compat_host_is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(host)) => host.is_loopback(),
        Some(Host::Ipv6(host)) => host.is_loopback(),
        None => false,
    }
}

pub fn openai_compat_tool_chat(
    request: OpenAiCompatChatRequest<'_>,
) -> Result<OpenAiCompatChatResponse> {
    openai_compat_tool_chat_with_progress(request, &CancellationToken::default(), |_| {})
}

/// Stream one chat turn, forwarding text deltas as they arrive.
///
/// Cancellation interrupts pending headers and body reads, including quiet
/// streams. A non-stream JSON body is accepted too: some gateways ignore
/// `stream: true` and answer with a single completion object.
pub fn openai_compat_tool_chat_with_progress<F>(
    request: OpenAiCompatChatRequest<'_>,
    cancellation: &CancellationToken,
    on_delta: F,
) -> Result<OpenAiCompatChatResponse>
where
    F: FnMut(&str),
{
    crate::provider_retry::stream_response(
        cancellation,
        |emit| openai_compat_tool_chat_once(&request, cancellation, emit),
        on_delta,
    )
}

fn openai_compat_tool_chat_once<F>(
    request: &OpenAiCompatChatRequest<'_>,
    cancellation: &CancellationToken,
    on_delta: F,
) -> Result<OpenAiCompatChatResponse>
where
    F: FnMut(&str),
{
    openai_compat_tool_chat_once_with_recovery(
        request,
        cancellation,
        on_delta,
        recover_openrouter_usage,
    )
}

fn openai_compat_tool_chat_once_with_recovery<F, R>(
    request: &OpenAiCompatChatRequest<'_>,
    cancellation: &CancellationToken,
    mut on_delta: F,
    recover_usage: R,
) -> Result<OpenAiCompatChatResponse>
where
    F: FnMut(&str),
    R: FnOnce(&Url, &str, &str, &CancellationToken) -> Option<OpenRouterUsageReceipt>,
{
    if cancellation.is_cancelled() {
        return Err(anyhow!(OPENAI_COMPAT_CANCELLED_MESSAGE));
    }
    let model = request.model.trim();
    if model.is_empty() {
        return Err(anyhow!("select a model for this provider before sending"));
    }
    let endpoint = openai_compat_endpoint(request.base_url)?;
    let url = endpoint_child(&endpoint, CHAT_PATH)?;
    let api_key = request.api_key.trim();

    let identity = crate::api_compatibility::identity(url.as_str(), model, api_key);
    let mut include_usage = crate::api_compatibility::include_usage(identity);
    let initially_include_usage = include_usage;
    let mut observation = None;
    let mut receipt = UsageReceipt::start(cancellation);
    let response = crate::provider_retry::http_response(cancellation, || {
        let payload = chat_payload(
            model,
            &request.messages,
            &request.tools,
            request.reasoning_effort,
            include_usage,
        );
        observation = Some(crate::provider_observation::Request::start(&payload));
        let result = match post_chat(&url, api_key, &payload, &receipt.transport) {
            Err(ureq::Error::Status(400, response)) => {
                observation.as_mut().unwrap().rejected();
                let mut body = String::new();
                let _ = response.into_reader().take(8192).read_to_string(&mut body);
                // Preserve explicitly selected effort and native tools. A generic
                // 400 is not evidence that either option is unsupported.
                if include_usage
                    && crate::api_compatibility::rejects_usage_field(&body)
                    && crate::provider_retry::compatibility_retry()
                {
                    include_usage = false;
                    let payload = chat_payload(
                        model,
                        &request.messages,
                        &request.tools,
                        request.reasoning_effort,
                        false,
                    );
                    observation = Some(crate::provider_observation::Request::start(&payload));
                    post_chat(&url, api_key, &payload, &receipt.transport)
                } else {
                    Err(ureq::Error::Status(
                        400,
                        ureq::Response::new(400, "Bad Request", &body)
                            .expect("valid error response"),
                    ))
                }
            }
            result => result,
        };
        if matches!(&result, Err(ureq::Error::Status(400..=499, _))) {
            observation.as_mut().unwrap().rejected();
        }
        result
    })
    .map_err(|error| {
        if matches!(&error, ureq::Error::Status(400..=499, _)) {
            if let Some(observation) = observation.as_mut() {
                observation.rejected();
            }
        }
        openai_compat_http_error(error)
    })?;
    if initially_include_usage && !include_usage {
        crate::api_compatibility::remember_usage_rejection(identity);
    }
    let mut observation = observation.expect("a completed HTTP exchange was observed");
    if (300..400).contains(&response.status()) {
        return Err(anyhow!(
            "the provider endpoint redirected; configure the canonical base URL instead"
        ));
    }

    let mut state = ChatAccumulator::default();
    let mut reader = BufReader::new(response.into_reader());
    let mut line = String::new();
    let mut saw_stream_frames = false;
    let mut completed = false;
    let mut receipt_completed = false;
    let mut final_usage = false;
    let mut last_frame_had_usage = false;
    let mut terminal_error = None;
    // Gateways that ignore `stream: true` answer with one JSON object, which may
    // be pretty-printed across lines; collect it until EOF.
    let mut buffered_body = String::new();
    let mut remaining = crate::provider_retry::MAX_CHAT_RESPONSE_BYTES;
    loop {
        if cancellation.is_cancelled() {
            return Err(anyhow!(OPENAI_COMPAT_CANCELLED_MESSAGE));
        }
        let read =
            match crate::provider_retry::read_chat_line(&mut reader, &mut line, &mut remaining) {
                Ok(read) => read,
                Err(_) if receipt.draining() && !cancellation.is_cancelled() => break,
                Err(error) => return Err(error).context("invalid provider chat stream"),
            };
        if read == 0 {
            receipt_completed = true;
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(payload) = trimmed.strip_prefix("data:") {
            saw_stream_frames = true;
            let payload = payload.trim();
            if payload == "[DONE]" {
                // The transport marker alone cannot certify a tool generation.
                completed |= state.tool_calls.is_empty();
                receipt_completed = true;
                final_usage |= last_frame_had_usage;
                break;
            }
            if payload.is_empty() {
                continue;
            }
            let frame: WireCompletion = match serde_json::from_str(payload) {
                Ok(frame) => frame,
                Err(_) if receipt.draining() => break,
                Err(error) => return Err(error).context("invalid provider chat response"),
            };
            let already_completed = completed;
            completed |= frame
                .choices
                .iter()
                .any(|choice| choice.index == 0 && choice.finish_reason.is_some());
            last_frame_had_usage = frame.usage.as_ref().is_some_and(WireUsage::has_counts)
                || frame
                    .x_groq
                    .as_ref()
                    .and_then(|groq| groq.usage.as_ref())
                    .is_some_and(WireUsage::has_counts);
            final_usage |= last_frame_had_usage
                && (completed
                    || terminal_error.is_some()
                    || frame.error.is_some()
                    || frame
                        .x_groq
                        .as_ref()
                        .is_some_and(|groq| groq.error.is_some()));
            state.record_usage(&frame);
            state.usage.observe(&mut observation);
            if frame.error.is_some()
                || frame
                    .x_groq
                    .as_ref()
                    .is_some_and(|groq| groq.error.is_some())
            {
                terminal_error.get_or_insert_with(|| {
                    anyhow!("the provider reported a generation error; no tool calls were executed")
                });
            }
            if terminal_error.is_none() && !already_completed {
                for choice in frame.choices.iter().filter(|choice| choice.index == 0) {
                    let message = choice.effective_message();
                    if let Some(reasoning) = &message.reasoning_content {
                        observation.delta(reasoning);
                    }
                    for call in &message.tool_calls {
                        if let Some(function) = &call.function {
                            if let Some(name) = &function.name {
                                observation.delta(name);
                            }
                            if let Some(arguments) = &function.arguments {
                                observation.delta(arguments);
                            }
                        }
                    }
                }
                if let Err(error) = state.apply(frame, &mut |text| {
                    observation.delta(text);
                    on_delta(text);
                }) {
                    terminal_error = Some(error);
                }
            }
            if completed || terminal_error.is_some() {
                receipt.begin(&mut remaining);
            }
        } else if trimmed.starts_with(':') {
            // SSE comment; gateways send these as keep-alives.
        } else if !saw_stream_frames {
            if !buffered_body.is_empty() {
                buffered_body.push('\n');
            }
            buffered_body.push_str(trimmed);
        }
        // Anything else is an SSE field Gyro has no use for (`event:`, `id:`).
    }

    if cancellation.is_cancelled() {
        return Err(anyhow!(OPENAI_COMPAT_CANCELLED_MESSAGE));
    }
    if saw_stream_frames && !completed && terminal_error.is_none() {
        return Err(anyhow!(
            "provider stream ended before completion; partial tool calls were not executed"
        ));
    }
    if !saw_stream_frames {
        let body = buffered_body.trim();
        if body.is_empty() {
            return Err(anyhow!("the provider returned an empty response"));
        }
        let parsed: WireCompletion =
            serde_json::from_str(body).context("invalid provider chat response")?;
        state.record_usage(&parsed);
        state.usage.observe(&mut observation);
        if let Err(error) = state.apply(parsed, &mut |text| {
            observation.delta(text);
            on_delta(text);
        }) {
            terminal_error = Some(error);
        }
        receipt_completed = true;
        final_usage = state.saw_usage;
    }

    // The completed answer survives a missing receipt. Release the original
    // stream/watchdog before a separate, bounded metadata lookup; it is not a
    // new generation and must not enter retry or observation collectors.
    drop(reader);
    drop(receipt);
    if saw_stream_frames
        && completed
        && terminal_error.is_none()
        && !(receipt_completed && final_usage)
        && !state.conflicting_generation_id
    {
        if let Some(id) = state.generation_id.as_deref() {
            if let Some(recovered) = recover_usage(&endpoint, api_key, id, cancellation) {
                receipt_completed = recovered.complete;
                final_usage = recovered.complete;
                state.record_usage(&WireCompletion {
                    usage: Some(recovered.usage),
                    ..Default::default()
                });
                state.usage.observe(&mut observation);
            }
        }
    }
    if cancellation.is_cancelled() {
        return Err(anyhow!(OPENAI_COMPAT_CANCELLED_MESSAGE));
    }

    let content = state.content.trim().to_string();
    let reasoning_content = state.reasoning_content.clone();
    let input_tokens = state.input_tokens;
    let output_tokens = state.output_tokens;
    let output_chars = state.content.chars().count()
        + reasoning_content.as_deref().unwrap_or("").chars().count()
        + state
            .tool_calls
            .iter()
            .map(|call| call.name.chars().count() + call.arguments.chars().count())
            .sum::<usize>();
    let input_chars = crate::provider_observation::text_size(
        &serde_json::json!({"messages": request.messages, "tools": request.tools}),
    )
    .0;
    let accounted_usage =
        state.accounted_usage(input_chars, output_chars, receipt_completed && final_usage);
    observation.accounted_usage(accounted_usage);
    // Accounting completion can precede a failed generation. Preserve the
    // final provider counts before returning an output-limit/error result.
    if receipt_completed && state.saw_usage {
        observation.complete(input_tokens, output_tokens, output_chars);
    } else if terminal_error.is_none() {
        observation.complete(input_tokens, output_tokens, output_chars);
    }
    if let Some(error) = terminal_error {
        return Err(error);
    }
    let tool_calls = state.tool_calls()?;
    if content.is_empty() && tool_calls.is_empty() {
        return Err(anyhow!("the provider finished without a text response"));
    }
    Ok(OpenAiCompatChatResponse {
        content,
        reasoning_content,
        input_tokens,
        output_tokens,
        accounted_usage,
        tool_calls,
    })
}

/// List the models an endpoint advertises, for the health probe and the
/// Settings "Fetch models" button.
pub fn openai_compat_list_models(base_url: &str, api_key: &str) -> Result<OpenAiCompatDiscovery> {
    let endpoint = openai_compat_endpoint(base_url)?;
    let url = endpoint_child(&endpoint, MODELS_PATH)?;
    let api_key = api_key.trim();
    let mut request = agent()
        .get(url.as_str())
        .set("Accept", "application/json")
        .set("User-Agent", USER_AGENT);
    if !api_key.is_empty() {
        request = request.set("Authorization", &format!("Bearer {api_key}"));
    }
    let response = request.call().map_err(openai_compat_http_error)?;
    refuse_redirect(&response, &url)?;
    let body: WireModelList = response
        .into_json()
        .context("invalid provider model list")?;
    // The documented shape is `data`; a few gateways answer with `models`.
    let entries = if body.data.is_empty() {
        body.models
    } else {
        body.data
    };
    let host = endpoint.host_str().unwrap_or("the endpoint").to_string();
    let mut seen = BTreeSet::new();
    let mut models = Vec::new();
    for entry in entries {
        let id = entry
            .id
            .or(entry.name)
            .unwrap_or_default()
            .trim()
            .to_string();
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        models.push(OpenAiCompatModel {
            display_name: id.clone(),
            description: format!("Model served by {host}."),
            id,
        });
        if models.len() >= MAX_DISCOVERED_MODELS {
            break;
        }
    }
    Ok(OpenAiCompatDiscovery {
        base_url: endpoint.as_str().trim_end_matches('/').to_string(),
        models,
    })
}

const USER_AGENT: &str = concat!("gyro/", env!("CARGO_PKG_VERSION"));

fn chat_payload(
    model: &str,
    messages: &[serde_json::Value],
    tools: &[serde_json::Value],
    reasoning_effort: Option<&str>,
    include_optional_fields: bool,
) -> serde_json::Value {
    let mut payload = serde_json::json!({
        "model": model,
        "stream": true,
        "messages": messages,
    });
    if !tools.is_empty() {
        payload["tools"] = serde_json::Value::Array(tools.to_vec());
    }
    if include_optional_fields {
        payload["stream_options"] = serde_json::json!({ "include_usage": true });
    }
    if let Some(effort) = reasoning_effort
        .map(str::trim)
        .filter(|effort| !effort.is_empty())
    {
        payload["reasoning_effort"] = serde_json::Value::String(effort.to_string());
    }
    payload
}

fn post_chat(
    url: &Url,
    api_key: &str,
    payload: &serde_json::Value,
    cancellation: &CancellationToken,
) -> std::result::Result<crate::chat_http::Response, ureq::Error> {
    crate::chat_http::post(
        url,
        api_key,
        payload,
        cancellation,
        CHAT_IDLE_TIMEOUT,
        openai_compat_host_is_loopback(url),
    )
}

/// Append a path segment to the configured base path, preserving any gateway
/// prefix and query string.
fn endpoint_child(base: &Url, suffix: &str) -> Result<Url> {
    let mut url = base.clone();
    let base_path = url.path().trim_end_matches('/').to_string();
    url.set_path(&format!("{base_path}/{}", suffix.trim_start_matches('/')));
    Ok(url)
}

/// A Bearer token must never follow a redirect to a host the user did not
/// configure, so a 3xx is reported instead of followed.
fn refuse_redirect(response: &ureq::Response, url: &Url) -> Result<()> {
    let status = response.status();
    if (300..400).contains(&status) {
        let location = response
            .header("location")
            .map(|value| format!(" to {value}"))
            .unwrap_or_default();
        return Err(anyhow!(
            "the provider endpoint {url} redirected{location}; configure the canonical base URL instead"
        ));
    }
    Ok(())
}

/// One pooled agent per process: an `Agent` owns its connection pool, so
/// building one per probe paid a fresh TCP and TLS handshake every time — and a
/// handshake is one more way a reachable gateway reads as unreachable.
fn agent() -> ureq::Agent {
    static AGENT: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
    AGENT
        .get_or_init(|| {
            ureq::AgentBuilder::new()
                .timeout_connect(CONNECT_TIMEOUT)
                .timeout_read(REQUEST_TIMEOUT)
                .timeout_write(REQUEST_TIMEOUT)
                .timeout(REQUEST_TIMEOUT)
                .redirects(0)
                .build()
        })
        .clone()
}

/// Keep the provider's status and bounded explanation in actionable errors.
fn openai_compat_http_error(error: ureq::Error) -> anyhow::Error {
    match error {
        ureq::Error::Status(status, response) => {
            let detail = response
                .into_string()
                .ok()
                .map(|body| error_message_from_body(&body))
                .filter(|message| !message.is_empty());
            match detail {
                Some(detail) => anyhow!("provider returned HTTP {status}: {detail}"),
                None => anyhow!("provider returned HTTP {status}"),
            }
        }
        ureq::Error::Transport(error) => {
            anyhow!("could not reach the provider endpoint: {error}")
        }
    }
}

/// Pull the human-readable part out of an OpenAI-style error envelope. Keys are
/// never echoed back: the body came from the provider, but a misconfigured
/// gateway can reflect request headers into its errors.
fn error_message_from_body(body: &str) -> String {
    let message = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|error| {
                    error
                        .get("message")
                        .and_then(|message| message.as_str())
                        .or_else(|| error.as_str())
                })
                .or_else(|| value.get("message").and_then(|message| message.as_str()))
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.to_string());
    let collapsed = message.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(MAX_ERROR_BODY_CHARS).collect()
}

#[derive(Default)]
struct ToolCallAccumulator {
    id: Option<String>,
    name: String,
    arguments: String,
}

#[derive(Default)]
struct ChatAccumulator {
    generation_id: Option<String>,
    conflicting_generation_id: bool,
    content: String,
    reasoning_content: Option<String>,
    tool_calls: Vec<ToolCallAccumulator>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    usage: WireUsage,
    saw_usage: bool,
}

impl ChatAccumulator {
    fn record_usage(&mut self, frame: &WireCompletion) {
        if let Some(id) = &frame.id {
            if let Some(previous) = &self.generation_id {
                self.conflicting_generation_id |= previous != id;
            } else {
                self.generation_id = Some(id.clone());
            }
        }
        // Reconcile both envelopes as snapshots of the same request.
        if let Some(usage) = frame.x_groq.as_ref().and_then(|groq| groq.usage.clone()) {
            self.usage.merge(usage);
            self.saw_usage = true;
        }
        if let Some(usage) = frame.usage.clone() {
            self.usage.merge(usage);
            self.saw_usage = true;
        }
        self.saw_usage &= self.usage.has_counts();
        self.input_tokens = self.usage.input();
        self.output_tokens = self.usage.completion_tokens;
    }

    fn accounted_usage(
        &self,
        input_chars: usize,
        output_chars: usize,
        receipt_complete: bool,
    ) -> UsageTokens {
        if !self.saw_usage {
            return UsageTokens::estimated(input_chars, output_chars)
                .partial(UsageReason::MissingUsage);
        }
        let mut tokens = self.usage.tokens();
        let inconsistent =
            tokens.effective_accounting().reason == Some(UsageReason::InconsistentCounts);
        // Estimate only an actually absent half. A total can infer the other
        // half, and an explicit zero never permits a character substitution.
        let input = self
            .input_tokens
            .or_else(|| self.usage.total_tokens?.checked_sub(self.output_tokens?));
        let output = self
            .output_tokens
            .or_else(|| self.usage.total_tokens?.checked_sub(self.input_tokens?));
        if self.usage.total_tokens.is_none() && (input.is_none() || output.is_none()) {
            let estimate = UsageTokens::estimated(input_chars, output_chars);
            if input.is_none() {
                tokens.input_tokens = estimate.input_tokens.max(tokens.input_tokens);
            }
            if output.is_none() {
                tokens.output_tokens = estimate.output_tokens.max(tokens.output_tokens);
            }
            tokens.total_tokens = tokens.input_tokens.saturating_add(tokens.output_tokens);
            tokens = tokens.partial(UsageReason::MissingUsage);
            if let Some(accounting) = tokens.accounting.as_mut() {
                accounting.source = UsageSource::Mixed;
                accounting.coverage = crate::usage::UsageCoverage::Estimated;
            }
        }
        if inconsistent {
            tokens = estimated_inconsistent_usage(tokens);
        } else if !receipt_complete {
            tokens = tokens.partial(UsageReason::ProviderIncomplete);
        }
        tokens
    }

    fn apply<F>(&mut self, frame: WireCompletion, on_delta: &mut F) -> Result<()>
    where
        F: FnMut(&str),
    {
        anyhow::ensure!(
            frame.error.is_none()
                && !frame
                    .x_groq
                    .as_ref()
                    .is_some_and(|groq| groq.error.is_some()),
            "the provider reported a generation error; no tool calls were executed"
        );
        self.record_usage(&frame);

        // Choices are alternative answers, not parallel work. Mixing them can
        // execute mutually exclusive edits and corrupt tool-call indexes.
        for choice in frame.choices.into_iter().filter(|choice| choice.index == 0) {
            // A terminal marker can still represent an incomplete generation.
            // Even syntactically valid arguments in that answer are unsafe to
            // execute: later tool calls or parameters may have been cut off.
            match choice.finish_reason.as_deref() {
                Some("length") => anyhow::bail!(
                    "the provider reached its output token limit; the response is incomplete and no tool calls from this response were executed"
                ),
                Some("content_filter") => anyhow::bail!(
                    "the provider filtered the response; no tool calls from this response were executed"
                ),
                Some("error" | "cancelled" | "canceled") => anyhow::bail!(
                    "the provider reported an interrupted generation; no tool calls from this response were executed"
                ),
                _ => {}
            }
            let message = choice.effective_message();
            if let Some(reasoning) = &message.reasoning_content {
                self.reasoning_content
                    .get_or_insert_with(String::new)
                    .push_str(reasoning);
            }
            if let Some(content) = message.text().filter(|text| !text.is_empty()) {
                on_delta(&content);
                self.content.push_str(&content);
            }
            for call in &message.tool_calls {
                let slot = self.slot_for(call)?;
                if let Some(id) = call.id.as_deref().filter(|id| !id.trim().is_empty()) {
                    slot.id = Some(id.to_string());
                }
                if let Some(function) = &call.function {
                    if let Some(name) = function
                        .name
                        .as_deref()
                        .filter(|name| !name.trim().is_empty())
                    {
                        slot.name = name.to_string();
                    }
                    if let Some(arguments) = &function.arguments {
                        slot.arguments.push_str(arguments);
                    }
                }
            }
        }
        Ok(())
    }

    /// Streaming frames address tool calls by `index`. A gateway that omits the
    /// index can still correlate fragments by id. Only a new id (or a named
    /// call without an id) starts a new slot.
    fn slot_for(&mut self, call: &WireToolCall) -> Result<&mut ToolCallAccumulator> {
        match call.index {
            Some(index) => {
                anyhow::ensure!(
                    index < crate::provider_retry::MAX_CHAT_TOOL_CALLS,
                    "provider returned too many tool calls; no tool calls were executed"
                );
                while self.tool_calls.len() <= index {
                    self.tool_calls.push(ToolCallAccumulator::default());
                }
                Ok(&mut self.tool_calls[index])
            }
            None => {
                if let Some(index) = call
                    .id
                    .as_deref()
                    .filter(|id| !id.trim().is_empty())
                    .and_then(|id| {
                        self.tool_calls
                            .iter()
                            .position(|slot| slot.id.as_deref() == Some(id))
                    })
                {
                    return Ok(&mut self.tool_calls[index]);
                }
                let names_call = call.id.is_some()
                    || call
                        .function
                        .as_ref()
                        .and_then(|function| function.name.as_deref())
                        .is_some_and(|name| !name.trim().is_empty());
                if names_call || self.tool_calls.is_empty() {
                    anyhow::ensure!(
                        self.tool_calls.len() < crate::provider_retry::MAX_CHAT_TOOL_CALLS,
                        "provider returned too many tool calls; no tool calls were executed"
                    );
                    self.tool_calls.push(ToolCallAccumulator::default());
                }
                Ok(self
                    .tool_calls
                    .last_mut()
                    .expect("a tool call slot was just ensured"))
            }
        }
    }

    fn tool_calls(self) -> Result<Vec<OpenAiCompatToolCall>> {
        let mut tool_calls = Vec::new();
        for call in self.tool_calls {
            let name = call.name.trim().to_string();
            if name.is_empty() {
                continue;
            }
            tool_calls.push(OpenAiCompatToolCall {
                id: call.id.filter(|id| !id.trim().is_empty()),
                name,
                arguments: parse_tool_arguments(&call.arguments),
            });
        }
        Ok(tool_calls)
    }
}

/// An empty argument string means "no arguments"; unparseable fragments are kept
/// verbatim so the caller can report them rather than silently running a tool
/// with dropped input.
fn parse_tool_arguments(raw: &str) -> serde_json::Value {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return serde_json::json!({});
    }
    serde_json::from_str(trimmed).unwrap_or_else(|_| serde_json::Value::String(trimmed.to_string()))
}

#[derive(Default, Deserialize)]
struct WireCompletion {
    // Non-string ids remain ignorable for custom OpenAI-compatible gateways.
    #[serde(default, deserialize_with = "optional_generation_id")]
    id: Option<String>,
    #[serde(default)]
    error: Option<serde_json::Value>,
    #[serde(default, deserialize_with = "nullable_vec")]
    choices: Vec<WireChoice>,
    #[serde(default)]
    usage: Option<WireUsage>,
    #[serde(default)]
    x_groq: Option<WireGroq>,
}

#[derive(Default, Deserialize)]
struct WireGroq {
    #[serde(default)]
    usage: Option<WireUsage>,
    #[serde(default)]
    error: Option<serde_json::Value>,
}

fn nullable_vec<'de, D, T>(deserializer: D) -> std::result::Result<Vec<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Option::<Vec<T>>::deserialize(deserializer)?.unwrap_or_default())
}
fn nullable_message<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<WireMessage, D::Error> {
    Ok(Option::<WireMessage>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Default, Deserialize)]
struct WireChoice {
    #[serde(default)]
    index: usize,
    #[serde(default)]
    finish_reason: Option<String>,
    /// Streaming frames carry the text under `delta`.
    #[serde(default, deserialize_with = "nullable_message")]
    delta: WireMessage,
    /// A non-streamed completion carries the same shape under `message`.
    #[serde(default, deserialize_with = "nullable_message")]
    message: WireMessage,
}

impl WireChoice {
    fn effective_message(&self) -> &WireMessage {
        if self.message.is_empty() {
            &self.delta
        } else {
            &self.message
        }
    }
}

#[derive(Default, Deserialize)]
struct WireMessage {
    #[serde(default)]
    content: Option<WireContent>,
    #[serde(default)]
    reasoning_content: Option<String>,
    #[serde(default, deserialize_with = "nullable_vec")]
    tool_calls: Vec<WireToolCall>,
}

impl WireMessage {
    fn is_empty(&self) -> bool {
        self.content.is_none() && self.reasoning_content.is_none() && self.tool_calls.is_empty()
    }

    /// The answer text, with any thinking trace left out.
    fn text(&self) -> Option<String> {
        self.content.as_ref().map(WireContent::text)
    }
}

/// What a completion puts in `content`.
///
/// Plain endpoints send a string. A model answering with a thinking budget
/// sends an array of typed chunks instead — Mistral switches shape the moment
/// `reasoning_effort` is `high` — and a `content: Option<String>` field failed
/// to deserialize the whole frame, so the answer silently vanished. Accept both
/// and keep only the text: the thinking trace is the model's scratch space, not
/// part of the reply Gyro renders or feeds back as history.
#[derive(Deserialize)]
#[serde(untagged)]
enum WireContent {
    Text(String),
    Chunks(Vec<WireContentChunk>),
}

impl WireContent {
    fn text(&self) -> String {
        match self {
            Self::Text(text) => text.clone(),
            Self::Chunks(chunks) => chunks
                .iter()
                .filter_map(|chunk| chunk.text.as_deref())
                .collect(),
        }
    }
}

/// One entry of a chunked `content` array. A thinking chunk carries its trace
/// under another key, so ignoring everything but `text` drops it by shape
/// rather than by naming each vendor's spelling of "thinking".
#[derive(Deserialize)]
struct WireContentChunk {
    #[serde(default)]
    text: Option<String>,
}

#[derive(Default, Deserialize)]
struct WireToolCall {
    #[serde(default)]
    index: Option<usize>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<WireFunction>,
}

#[derive(Default, Deserialize)]
struct WireFunction {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

// Generation receipts use the model's native tokenizer, matching stream usage.
// The legacy tokens_prompt/tokens_completion and monetary cache_discount/usage
// fields are deliberately ignored.
// https://openrouter.ai/docs/api/api-reference/generations/get-request-&-usage-metadata-for-a-generation
const OPENROUTER_RECEIPT_TIMEOUT: Duration = Duration::from_secs(2);

fn valid_openrouter_generation_id(id: &str) -> bool {
    id.len() <= 128
        && id.strip_prefix("gen-").is_some_and(|suffix| {
            !suffix.is_empty()
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

fn optional_generation_id<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(value
        .as_str()
        .filter(|id| valid_openrouter_generation_id(id))
        .map(str::to_owned))
}

fn optional_receipt_count<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<u64>, D::Error> {
    Ok(serde_json::Value::deserialize(deserializer)?.as_u64())
}

fn openrouter_generation_endpoint(endpoint: &Url, id: &str) -> Option<Url> {
    // An OpenRouter-looking model/id on a custom gateway grants no permission
    // to send its credentials to OpenRouter or to invent a gateway endpoint.
    if endpoint.scheme() != "https"
        || endpoint.host_str() != Some("openrouter.ai")
        || endpoint.port_or_known_default() != Some(443)
        || endpoint.path().trim_end_matches('/') != "/api/v1"
        || !valid_openrouter_generation_id(id)
    {
        return None;
    }
    let mut url = endpoint_child(endpoint, "generation").ok()?;
    let query: Vec<_> = url
        .query_pairs()
        .filter(|(key, _)| key != "id")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    url.query_pairs_mut()
        .clear()
        .extend_pairs(query)
        .append_pair("id", id);
    Some(url)
}

struct OpenRouterUsageReceipt {
    usage: WireUsage,
    complete: bool,
}

#[derive(Deserialize)]
struct WireOpenRouterGenerationResponse {
    data: WireOpenRouterGeneration,
}

#[derive(Deserialize)]
struct WireOpenRouterGeneration {
    id: String,
    cancelled: Option<bool>,
    finish_reason: Option<String>,
    #[serde(default, deserialize_with = "optional_receipt_count")]
    native_tokens_prompt: Option<u64>,
    #[serde(default, deserialize_with = "optional_receipt_count")]
    native_tokens_completion: Option<u64>,
    #[serde(default, deserialize_with = "optional_receipt_count")]
    native_tokens_cached: Option<u64>,
    #[serde(default, deserialize_with = "optional_receipt_count")]
    native_tokens_reasoning: Option<u64>,
}

impl WireOpenRouterGeneration {
    fn receipt(self, expected_id: &str) -> Option<OpenRouterUsageReceipt> {
        if self.id != expected_id
            || (self.native_tokens_prompt.is_none() && self.native_tokens_completion.is_none())
        {
            return None;
        }
        let total_tokens = self
            .native_tokens_prompt
            .zip(self.native_tokens_completion)
            .and_then(|(input, output)| input.checked_add(output));
        let complete = self.cancelled == Some(false)
            && matches!(self.finish_reason.as_deref(), Some("stop" | "tool_calls"))
            && total_tokens.is_some();
        Some(OpenRouterUsageReceipt {
            complete,
            usage: WireUsage {
                prompt_tokens: self.native_tokens_prompt,
                completion_tokens: self.native_tokens_completion,
                total_tokens,
                prompt_tokens_details: self.native_tokens_cached.map(|cached_tokens| {
                    WireTokenDetails {
                        cached_tokens: Some(cached_tokens),
                        ..Default::default()
                    }
                }),
                completion_tokens_details: self.native_tokens_reasoning.map(|reasoning_tokens| {
                    WireTokenDetails {
                        reasoning_tokens: Some(reasoning_tokens),
                        ..Default::default()
                    }
                }),
                ..Default::default()
            },
        })
    }
}

fn recover_openrouter_usage(
    endpoint: &Url,
    key: &str,
    id: &str,
    cancellation: &CancellationToken,
) -> Option<OpenRouterUsageReceipt> {
    let url = openrouter_generation_endpoint(endpoint, id)?;
    read_openrouter_receipt(&url, key, id, cancellation, OPENROUTER_RECEIPT_TIMEOUT)
}

fn read_openrouter_receipt(
    url: &Url,
    key: &str,
    id: &str,
    cancellation: &CancellationToken,
    timeout: Duration,
) -> Option<OpenRouterUsageReceipt> {
    if cancellation.is_cancelled() {
        return None;
    }
    // Reuse a bounded runtime pool: dropping a per-lookup runtime can wait
    // indefinitely for platform DNS. No reader/watchdog is spawned per receipt;
    // dropping the lookup future cancels its headers/body and closes the client.
    static RUNTIME: std::sync::OnceLock<Option<tokio::runtime::Runtime>> =
        std::sync::OnceLock::new();
    let runtime = RUNTIME
        .get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(1)
                .max_blocking_threads(1)
                .thread_name("gyro-usage-receipt")
                .enable_all()
                .build()
                .ok()
        })
        .as_ref()?;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(timeout)
        .timeout(timeout);
    let builder = if openai_compat_host_is_loopback(url) {
        builder.no_proxy()
    } else {
        builder
    };
    let client = builder.build().ok()?;
    runtime.block_on(async {
        let lookup = async {
            let mut request = client
                .get(url.as_str())
                .header("Accept", "application/json")
                .header("Accept-Encoding", "identity")
                .header("User-Agent", USER_AGENT);
            if !key.is_empty() {
                request = request.bearer_auth(key);
            }
            let mut response = request.send().await.ok()?;
            if response.status() != reqwest::StatusCode::OK
                || response
                    .content_length()
                    .is_some_and(|length| length > MAX_USAGE_RECEIPT_BYTES as u64)
            {
                return None;
            }
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await.ok()? {
                if chunk.len() > MAX_USAGE_RECEIPT_BYTES - body.len() {
                    return None;
                }
                body.extend_from_slice(&chunk);
            }
            let parsed: WireOpenRouterGenerationResponse = serde_json::from_slice(&body).ok()?;
            parsed.data.receipt(id)
        };
        tokio::select! {
            biased;
            _ = cancellation.wait_cancelled() => None,
            result = tokio::time::timeout(timeout, lookup) => result.ok().flatten(),
        }
    })
}

#[derive(Clone, Default, Deserialize)]
struct WireUsage {
    // Contradictory snapshots remain unverified even after later increases.
    #[serde(skip)]
    regressed: bool,
    #[serde(default)]
    prompt_tokens: Option<u64>,
    #[serde(default)]
    completion_tokens: Option<u64>,
    #[serde(default)]
    total_tokens: Option<u64>,
    #[serde(default)]
    prompt_cache_hit_tokens: Option<u64>,
    #[serde(default)]
    prompt_cache_miss_tokens: Option<u64>,
    #[serde(default)]
    prompt_tokens_details: Option<WireTokenDetails>,
    #[serde(default)]
    completion_tokens_details: Option<WireTokenDetails>,
}
#[derive(Clone, Default, Deserialize)]
struct WireTokenDetails {
    cached_tokens: Option<u64>,
    cache_write_tokens: Option<u64>,
    reasoning_tokens: Option<u64>,
}
/// Keep the largest observed snapshot, never add it twice or erase it with a
/// smaller receipt. An absent field supplies no evidence of a regression.
fn retain_usage_lower_bound(current: &mut Option<u64>, incoming: Option<u64>) -> bool {
    match (*current, incoming) {
        (Some(previous), Some(next)) => {
            *current = Some(previous.max(next));
            next < previous
        }
        (None, Some(next)) => {
            *current = Some(next);
            false
        }
        _ => false,
    }
}

fn estimated_inconsistent_usage(mut tokens: UsageTokens) -> UsageTokens {
    tokens = tokens.partial(UsageReason::InconsistentCounts);
    if let Some(accounting) = tokens.accounting.as_mut() {
        accounting.coverage = crate::usage::UsageCoverage::Estimated;
    }
    tokens
}

impl WireTokenDetails {
    fn merge(&mut self, other: Self) -> bool {
        let cached = retain_usage_lower_bound(&mut self.cached_tokens, other.cached_tokens);
        let written =
            retain_usage_lower_bound(&mut self.cache_write_tokens, other.cache_write_tokens);
        let reasoning =
            retain_usage_lower_bound(&mut self.reasoning_tokens, other.reasoning_tokens);
        cached || written || reasoning
    }
}
impl WireUsage {
    fn has_counts(&self) -> bool {
        self.input().is_some() || self.completion_tokens.is_some() || self.total_tokens.is_some()
            || self.cached().is_some() || self.cache_write().is_some() || self.reasoning().is_some()
    }
    fn merge(&mut self, other: Self) {
        // Compare normalized aliases too: switching from DeepSeek's cache split
        // to prompt_tokens/cached_tokens must not hide a smaller snapshot.
        self.regressed |= other.regressed
            || [
                (self.input(), other.input()),
                (self.cached(), other.cached()),
                (self.snapshot_total(), other.snapshot_total()),
            ]
            .into_iter()
            .any(|(previous, next)| previous.zip(next).is_some_and(|(a, b)| b < a));
        // These are request snapshots, never additive deltas.
        for (current, incoming) in [
            (&mut self.prompt_tokens, other.prompt_tokens),
            (&mut self.completion_tokens, other.completion_tokens),
            (&mut self.total_tokens, other.total_tokens),
            (&mut self.prompt_cache_hit_tokens, other.prompt_cache_hit_tokens),
            (&mut self.prompt_cache_miss_tokens, other.prompt_cache_miss_tokens),
        ] {
            self.regressed |= retain_usage_lower_bound(current, incoming);
        }
        for (current, incoming) in [
            (&mut self.prompt_tokens_details, other.prompt_tokens_details),
            (
                &mut self.completion_tokens_details,
                other.completion_tokens_details,
            ),
        ] {
            if let Some(incoming) = incoming {
                self.regressed |= current
                    .get_or_insert_with(WireTokenDetails::default)
                    .merge(incoming);
            }
        }
    }
    fn snapshot_total(&self) -> Option<u64> {
        let sum = self
            .input()
            .zip(self.completion_tokens)
            .and_then(|(a, b)| a.checked_add(b));
        self.total_tokens.into_iter().chain(sum).max()
    }
    fn input(&self) -> Option<u64> {
        let cache_split = self
            .prompt_cache_hit_tokens
            .zip(self.prompt_cache_miss_tokens)
            .and_then(|(hit, miss)| hit.checked_add(miss));
        self.prompt_tokens.into_iter().chain(cache_split).max()
    }
    fn cached(&self) -> Option<u64> {
        self.prompt_tokens_details
            .as_ref()
            .and_then(|detail| detail.cached_tokens)
            .into_iter()
            .chain(self.prompt_cache_hit_tokens)
            .max()
    }
    fn reasoning(&self) -> Option<u64> {
        self.completion_tokens_details
            .as_ref()
            .and_then(|detail| detail.reasoning_tokens)
    }
    fn cache_write(&self) -> Option<u64> {
        self.prompt_tokens_details
            .as_ref()
            .and_then(|detail| detail.cache_write_tokens)
    }
    fn tokens(&self) -> UsageTokens {
        let input = self
            .input()
            .or_else(|| self.total_tokens?.checked_sub(self.completion_tokens?));
        let output = self
            .completion_tokens
            .or_else(|| self.total_tokens?.checked_sub(self.input()?));
        let tokens = UsageTokens::measured(
            input,
            self.cached(),
            output,
            self.reasoning(),
            self.total_tokens,
        )
        .with_cache_write(self.cache_write());
        let cache_split = self
            .prompt_cache_hit_tokens
            .zip(self.prompt_cache_miss_tokens)
            .and_then(|(hit, miss)| hit.checked_add(miss));
        if self.regressed
            || self
                .prompt_tokens
                .zip(cache_split)
                .is_some_and(|(prompt, split)| prompt != split)
            || self
                .cached()
                .zip(self.prompt_cache_hit_tokens)
                .is_some_and(|(a, b)| a != b)
            || self
                .prompt_cache_hit_tokens
                .zip(self.prompt_cache_miss_tokens)
                .is_some_and(|(hit, miss)| hit.checked_add(miss).is_none())
            || input
                .zip(self.cached())
                .is_some_and(|(input, cached)| cached > input)
            || input
                .zip(self.cache_write())
                .is_some_and(|(input, written)| written > input)
            || output
                .zip(self.reasoning())
                .is_some_and(|(output, reasoning)| reasoning > output)
        {
            estimated_inconsistent_usage(tokens)
        } else {
            tokens
        }
    }
    fn observe(&self, observation: &mut crate::provider_observation::Request) {
        observation.details(self.cached(), self.reasoning());
        observation.reported(self.input(), self.completion_tokens);
        observation.reported_total(self.total_tokens);
        observation.cache_write_details(self.cache_write());
        if self.regressed {
            // Early cancellation/parse errors still retain both the lower bound
            // and the contradiction; they must not reconstruct Complete usage.
            observation.accounted_usage(self.tokens());
        }
    }
}

#[derive(Default, Deserialize)]
struct WireModelList {
    #[serde(default)]
    data: Vec<WireModelEntry>,
    #[serde(default)]
    models: Vec<WireModelEntry>,
}

#[derive(Default, Deserialize)]
struct WireModelEntry {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, Read, Write};
    use std::net::{SocketAddr, TcpListener, TcpStream};

    #[test]
    fn openrouter_receipt_endpoint_preserves_origin_and_rejects_custom_gateways() {
        let endpoint = openai_compat_endpoint(
            "https://openrouter.ai:443/api/v1/?tenant=test&id=old",
        )
        .unwrap();
        let receipt = openrouter_generation_endpoint(&endpoint, "gen-example-123").unwrap();
        assert_eq!(receipt.origin(), endpoint.origin());
        assert_eq!(receipt.path(), "/api/v1/generation");
        assert_eq!(receipt.query(), Some("tenant=test&id=gen-example-123"));
        for base in [
            "https://openrouter.ai.example/api/v1",
            "https://gateway.example/api/v1",
            "https://openrouter.ai:8443/api/v1",
            "https://openrouter.ai/private/api/v1",
            "http://127.0.0.1/api/v1",
        ] {
            assert!(openrouter_generation_endpoint(
                &openai_compat_endpoint(base).unwrap(),
                "gen-example"
            )
            .is_none());
        }
        for id in ["", "gen-", "chatcmpl-example", "gen-a?other=1", "gen-a/b"] {
            assert!(openrouter_generation_endpoint(&endpoint, id).is_none());
        }
        assert!(openrouter_generation_endpoint(
            &endpoint,
            &format!("gen-{}", "a".repeat(125))
        )
        .is_none());
        // A non-string gateway id must not change its formerly valid response.
        let frame: WireCompletion = serde_json::from_value(serde_json::json!({
            "id": {"private": 1}, "choices": []
        }))
        .unwrap();
        assert!(frame.id.is_none());
    }

    fn normalized_openrouter_receipt(value: serde_json::Value) -> Option<OpenRouterUsageReceipt> {
        serde_json::from_value::<WireOpenRouterGenerationResponse>(value)
            .ok()?
            .data
            .receipt("gen-fixture")
    }

    #[test]
    fn openrouter_receipt_normalizes_only_native_numeric_counts_and_preserves_zero() {
        let recovered = normalized_openrouter_receipt(serde_json::json!({"data": {
            "id": "gen-fixture", "cancelled": false, "finish_reason": "stop",
            "native_tokens_prompt": 100, "native_tokens_completion": 25,
            "native_tokens_cached": 60, "native_tokens_reasoning": 5,
            "tokens_prompt": 999, "tokens_completion": 888,
            "usage": 0.01, "cache_discount": 0.005
        }})).unwrap();
        let tokens = recovered.usage.tokens();
        assert!(recovered.complete);
        assert_eq!((tokens.input_tokens, tokens.output_tokens, tokens.total_tokens), (100, 25, 125));
        assert_eq!((tokens.cached_input_tokens, tokens.reasoning_output_tokens), (60, 5));
        assert!(!tokens.accounting.unwrap().known.cache_write);

        let zero = normalized_openrouter_receipt(serde_json::json!({"data": {
            "id": "gen-fixture", "cancelled": false, "finish_reason": "tool_calls",
            "native_tokens_prompt": 0, "native_tokens_completion": 0,
            "native_tokens_cached": 0, "native_tokens_reasoning": 0
        }})).unwrap();
        assert!(zero.complete);
        assert!(zero.usage.tokens().measured);
        assert_eq!(zero.usage.tokens().total_tokens, 0);
        assert!(zero.usage.tokens().accounting.unwrap().known.cache_read);

        let partial = normalized_openrouter_receipt(serde_json::json!({"data": {
            "id": "gen-fixture", "cancelled": false, "finish_reason": "stop",
            "native_tokens_prompt": 10, "native_tokens_completion": null,
            "native_tokens_cached": "8", "native_tokens_reasoning": -1,
            "tokens_completion": 999, "cache_discount": 0.1
        }})).unwrap();
        assert!(!partial.complete);
        assert_eq!(partial.usage.completion_tokens, None);
        assert_eq!(partial.usage.total_tokens, None);
        assert_eq!(partial.usage.cached(), None);
        assert_eq!(partial.usage.reasoning(), None);
        for cancelled in [true, false] {
            let receipt = normalized_openrouter_receipt(serde_json::json!({"data": {
                "id": "gen-fixture", "cancelled": cancelled, "finish_reason": "length",
                "native_tokens_prompt": 10, "native_tokens_completion": 2
            }})).unwrap();
            assert!(!receipt.complete);
        }
        for data in [
            serde_json::json!({"id":"gen-other","native_tokens_prompt":10}),
            serde_json::json!({"id":"gen-fixture","tokens_prompt":10,"tokens_completion":2}),
            serde_json::json!({"id":"gen-fixture","native_tokens_cached":2}),
        ] {
            assert!(normalized_openrouter_receipt(serde_json::json!({"data":data})).is_none());
        }
    }

    fn openrouter_stream_fixture(
        stream_body: &str,
        metadata_status: &str,
        metadata_body: &str,
    ) -> (Result<OpenAiCompatChatResponse>, Vec<RecordedRequest>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let responses = [
            http_response("200 OK", "text/event-stream", stream_body),
            http_response(metadata_status, "application/json", metadata_body),
        ];
        let server = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for response in responses {
                let deadline = std::time::Instant::now() + Duration::from_secs(5);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(std::time::Instant::now() < deadline, "fixture request missing");
                            std::thread::sleep(Duration::from_millis(2));
                        }
                        Err(error) => panic!("{error}"),
                    }
                };
                stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                requests.push(read_request(&mut stream));
                let _ = stream.write_all(response.as_bytes());
            }
            requests
        });
        let result = openai_compat_tool_chat_once_with_recovery(
            &OpenAiCompatChatRequest {
                base_url: &format!("http://{address}/api/v1?tenant=test"),
                api_key: " receipt-test-key ",
                model: "test",
                messages: vec![serde_json::json!({"role":"user","content":"prompt"})],
                tools: vec![],
                reasoning_effort: None,
            },
            &CancellationToken::default(),
            |_| {},
            // Fixture transport only: production always checks the configured
            // canonical OpenRouter origin before allowing this bounded GET.
            |endpoint, key, id, cancellation| {
                let mut url = endpoint_child(endpoint, "generation").unwrap();
                url.query_pairs_mut().append_pair("id", id);
                read_openrouter_receipt(&url, key, id, cancellation, OPENROUTER_RECEIPT_TIMEOUT)
            },
        );
        (result, server.join().unwrap())
    }

    const OPENROUTER_PARTIAL_STREAM: &str = concat!(
        "data: {\"id\":\"gen-fixture\",\"choices\":[{\"delta\":{\"content\":\"answer\",\"reasoning_content\":\"state\",\"tool_calls\":[{\"index\":0,\"id\":\"call\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{}\"}}]}}],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":1}}\n",
        "data: {\"id\":\"gen-fixture\",\"choices\":[{\"finish_reason\":\"tool_calls\"}]}\n",
        "data: [DONE]\n"
    );

    #[test]
    fn openrouter_receipt_recovers_completed_stream_without_a_second_generation_or_double_counting() {
        let _scope = crate::provider_observation::Scope::start();
        let (result, sent) = openrouter_stream_fixture(
            OPENROUTER_PARTIAL_STREAM,
            "200 OK",
            r#"{"data":{"id":"gen-fixture","cancelled":false,"finish_reason":"tool_calls","native_tokens_prompt":50,"native_tokens_completion":10,"native_tokens_cached":8,"native_tokens_reasoning":3}}"#,
        );
        let response = result.unwrap();
        assert_eq!(response.content, "answer");
        assert_eq!(response.reasoning_content.as_deref(), Some("state"));
        assert_eq!(response.tool_calls.len(), 1);
        assert_eq!(response.tool_calls[0].arguments, serde_json::json!({}));
        assert_eq!((response.input_tokens, response.output_tokens), (Some(50), Some(10)));
        assert_eq!(response.accounted_usage.total_tokens, 60);
        assert_eq!(response.accounted_usage.cached_input_tokens, 8);
        assert_eq!(response.accounted_usage.reasoning_output_tokens, 3);
        assert!(response.accounted_usage.measured);
        assert_eq!(response.accounted_usage.accounting.unwrap().scope, crate::usage::UsageScope::Request);
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[1].request_line, "GET /api/v1/generation?tenant=test&id=gen-fixture HTTP/1.1");
        assert!(sent[1].body.is_empty());
        assert_eq!(sent[0].header("authorization"), sent[1].header("authorization"));
        assert_eq!(sent[1].header("authorization").as_deref(), Some("Bearer receipt-test-key"));
        let observed = crate::provider_observation::snapshot().unwrap();
        assert_eq!((observed.requests, observed.completed, observed.retries), (1, 1, 0));
        assert_eq!(
            observed.tokens.unwrap(),
            response.accounted_usage.with_scope(crate::usage::UsageScope::Turn)
        );
    }

    #[test]
    fn openrouter_receipt_failure_preserves_response_and_existing_partial_counts() {
        for (status, body) in [
            ("404 Not Found", r#"{"error":{"message":"not ready"}}"#),
            ("500 Internal Server Error", "{}"),
            ("200 OK", "invalid json"),
            ("200 OK", r#"{"data":{"id":"gen-other","native_tokens_prompt":999}}"#),
        ] {
            let (result, sent) = openrouter_stream_fixture(OPENROUTER_PARTIAL_STREAM, status, body);
            let response = result.unwrap();
            assert_eq!(response.content, "answer");
            assert_eq!(response.tool_calls.len(), 1);
            assert_eq!((response.input_tokens, response.output_tokens), (Some(9), Some(1)));
            assert_eq!(response.accounted_usage.total_tokens, 10);
            assert!(!response.accounted_usage.measured);
            assert_eq!(response.accounted_usage.accounting.unwrap().reason, Some(UsageReason::ProviderIncomplete));
            assert_eq!(sent.len(), 2);
        }
        let (result, _) = openrouter_stream_fixture(
            OPENROUTER_PARTIAL_STREAM,
            "200 OK",
            r#"{"data":{"id":"gen-fixture","cancelled":false,"finish_reason":"stop","native_tokens_prompt":50}}"#,
        );
        let response = result.unwrap();
        assert_eq!((response.input_tokens, response.output_tokens), (Some(50), Some(1)));
        assert!(!response.accounted_usage.measured);
    }

    #[test]
    fn openrouter_receipt_skips_final_usage_missing_ids_conflicting_ids_and_generation_errors() {
        for body in [
            "data: {\"id\":\"gen-fixture\",\"choices\":[{\"delta\":{\"content\":\"done\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":0,\"completion_tokens\":0}}\ndata: [DONE]\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"done\"},\"finish_reason\":\"stop\"}]}\ndata: [DONE]\n",
            "data: {\"id\":\"gen-one\",\"choices\":[{\"delta\":{\"content\":\"done\"}}]}\ndata: {\"id\":\"gen-two\",\"choices\":[{\"finish_reason\":\"stop\"}]}\ndata: [DONE]\n",
            "data: {\"id\":\"gen-fixture\",\"choices\":[{\"delta\":{\"content\":\"partial\"},\"finish_reason\":\"length\"}],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":1}}\ndata: [DONE]\n",
            "data: {\"id\":\"gen-fixture\",\"error\":{\"message\":\"failed\"},\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":1}}\ndata: [DONE]\n",
            "{\"id\":\"gen-fixture\",\"choices\":[{\"message\":{\"content\":\"json answer\"}}]}",
        ] {
            let _scope = crate::provider_observation::Scope::start();
            let (address, server) = serve_once("200 OK", "text/event-stream", body);
            let result = openai_compat_tool_chat_once_with_recovery(
                &OpenAiCompatChatRequest {
                    base_url: &format!("http://{address}/v1"),
                    api_key: "",
                    model: "test",
                    messages: vec![],
                    tools: vec![],
                    reasoning_effort: None,
                },
                &CancellationToken::default(),
                |_| {},
                |_, _, _, _| panic!("this response must not fetch a generation receipt"),
            );
            server.join().unwrap();
            if body.contains("length") || body.contains("\"error\"") {
                assert!(result.is_err());
                let tokens = crate::provider_observation::snapshot().unwrap().tokens.unwrap();
                assert_eq!((tokens.input_tokens, tokens.output_tokens), (7, 1));
            } else {
                assert!(result.is_ok());
            }
        }
        // Exercise the production origin gate with an otherwise eligible id.
        let response = accounting_fixture(
            "data: {\"id\":\"gen-fixture\",\"choices\":[{\"delta\":{\"content\":\"gateway answer\"},\"finish_reason\":\"stop\"}]}\ndata: [DONE]\n"
        ).unwrap();
        assert_eq!(response.content, "gateway answer");
        assert_eq!((response.input_tokens, response.output_tokens), (None, None));
    }

    #[test]
    fn openrouter_receipt_refuses_redirects_and_bounds_body_bytes() {
        let sink = TcpListener::bind("127.0.0.1:0").unwrap();
        sink.set_nonblocking(true).unwrap();
        for response in [
            format!("HTTP/1.1 302 Found\r\nLocation: http://{}/stolen\r\nContent-Length: 0\r\n\r\n", sink.local_addr().unwrap()),
            format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", MAX_USAGE_RECEIPT_BYTES + 1),
            format!("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{}\r\n0\r\n\r\n", MAX_USAGE_RECEIPT_BYTES + 1, " ".repeat(MAX_USAGE_RECEIPT_BYTES + 1)),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = Url::parse(&format!("http://{}/generation?id=gen-fixture", listener.local_addr().unwrap())).unwrap();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let sent = read_request(&mut stream);
                let _ = stream.write_all(response.as_bytes());
                sent
            });
            assert!(read_openrouter_receipt(&url, "receipt-test-key", "gen-fixture", &CancellationToken::default(), Duration::from_secs(1)).is_none());
            assert_eq!(server.join().unwrap().header("authorization").as_deref(), Some("Bearer receipt-test-key"));
            assert!(matches!(sink.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock));
        }
    }

    #[test]
    fn openrouter_receipt_deadline_and_cancellation_close_silent_headers_and_bodies() {
        for (headers, stop) in [(false, false), (true, false), (false, true), (true, true)] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = Url::parse(&format!("http://{}/generation?id=gen-fixture", listener.local_addr().unwrap())).unwrap();
            let (started, ready) = std::sync::mpsc::channel();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let _ = read_request(&mut stream);
                if headers {
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n").unwrap();
                }
                started.send(()).unwrap();
                let closed = stream.read(&mut [0]);
                assert!(matches!(closed, Ok(0)) || closed.is_err());
            });
            let cancellation = CancellationToken::default();
            let signal = cancellation.clone();
            let cancel = std::thread::spawn(move || {
                ready.recv().unwrap();
                if stop {
                    signal.cancel();
                }
            });
            let began = std::time::Instant::now();
            assert!(read_openrouter_receipt(&url, "", "gen-fixture", &cancellation, Duration::from_millis(100)).is_none());
            assert!(began.elapsed() < Duration::from_secs(1));
            cancel.join().unwrap();
            server.join().unwrap();
        }
    }

    #[test]
    fn openrouter_receipt_cancelled_stream_retains_partial_usage_without_a_lookup() {
        let _scope = crate::provider_observation::Scope::start();
        let (address, server) = serve_once(
            "200 OK", "text/event-stream",
            "data: {\"id\":\"gen-fixture\",\"choices\":[{\"delta\":{\"content\":\"partial\"}}],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":1}}\n"
        );
        let cancellation = CancellationToken::default();
        let result = openai_compat_tool_chat_once_with_recovery(
            &OpenAiCompatChatRequest {
                base_url: &format!("http://{address}/v1"),
                api_key: "",
                model: "test",
                messages: vec![],
                tools: vec![],
                reasoning_effort: None,
            },
            &cancellation,
            |_| cancellation.cancel(),
            |_, _, _, _| panic!("cancelled generation must not fetch a receipt"),
        );
        server.join().unwrap();
        assert_eq!(result.unwrap_err().to_string(), OPENAI_COMPAT_CANCELLED_MESSAGE);
        let tokens = crate::provider_observation::snapshot().unwrap().tokens.unwrap();
        assert_eq!((tokens.input_tokens, tokens.output_tokens), (7, 1));
        assert!(!tokens.measured);
        assert_eq!(tokens.accounting.unwrap().reason, Some(UsageReason::Interrupted));
    }

    #[test]
    fn wire_usage_preserves_totals_and_subset_counts_across_frames() {
        let _scope = crate::provider_observation::Scope::start();
        {
            let mut observation =
                crate::provider_observation::Request::start(&serde_json::json!([]));
            for frame in [
                serde_json::json!({"prompt_tokens": 100, "prompt_tokens_details": {"cached_tokens": 80}}),
                serde_json::json!({"completion_tokens": 20, "completion_tokens_details": {"reasoning_tokens": 5}, "total_tokens": 150}),
                serde_json::json!({"total_tokens": 150}),
            ] {
                serde_json::from_value::<WireUsage>(frame)
                    .unwrap()
                    .observe(&mut observation);
            }
            observation.complete(None, None, 0);
        }
        let tokens = crate::provider_observation::snapshot()
            .unwrap()
            .tokens
            .unwrap();
        assert_eq!(tokens.input_tokens, 100);
        assert_eq!(tokens.output_tokens, 20);
        assert_eq!(tokens.cached_input_tokens, 80);
        assert_eq!(tokens.reasoning_output_tokens, 5);
        assert_eq!(tokens.total_tokens, 150);
        assert!(tokens.measured);
    }

    fn accounting_fixture(body: &str) -> Result<OpenAiCompatChatResponse> {
        let (address, server) = serve_once("200 OK", "text/event-stream", body);
        let result = openai_compat_tool_chat_once(
            &OpenAiCompatChatRequest {
                base_url: &format!("http://{address}/v1"),
                api_key: "",
                model: "test",
                messages: vec![serde_json::json!({"role":"user","content":"prompt"})],
                tools: vec![],
                reasoning_effort: None,
            },
            &CancellationToken::default(),
            |_| {},
        );
        server.join().unwrap();
        result
    }

    #[test]
    fn wire_usage_regressions_retain_lower_bounds_and_stay_estimated() {
        let baseline = serde_json::json!({
            "prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120,
            "prompt_cache_hit_tokens": 60, "prompt_cache_miss_tokens": 40,
            "prompt_tokens_details": {"cached_tokens": 60, "cache_write_tokens": 30},
            "completion_tokens_details": {"reasoning_tokens": 5}
        });
        for incoming in [
            serde_json::json!({"prompt_tokens": 0}),
            serde_json::json!({"completion_tokens": 0}),
            serde_json::json!({"total_tokens": 0}),
            serde_json::json!({"prompt_cache_hit_tokens": 0}),
            serde_json::json!({"prompt_cache_miss_tokens": 0}),
            serde_json::json!({"prompt_tokens_details": {"cached_tokens": 0}}),
            serde_json::json!({"prompt_tokens_details": {"cache_write_tokens": 0}}),
            serde_json::json!({"completion_tokens_details": {"reasoning_tokens": 0}}),
        ] {
            let mut usage: WireUsage = serde_json::from_value(baseline.clone()).unwrap();
            usage.merge(serde_json::from_value(incoming).unwrap());
            let tokens = usage.tokens();
            assert_eq!((tokens.input_tokens, tokens.output_tokens, tokens.total_tokens), (100, 20, 120));
            assert_eq!((tokens.cached_input_tokens, tokens.cache_write_tokens, tokens.reasoning_output_tokens), (60, 30, 5));
            assert_eq!((usage.prompt_cache_hit_tokens, usage.prompt_cache_miss_tokens), (Some(60), Some(40)));
            assert!(!tokens.measured);
            assert_eq!(tokens.accounting.unwrap().coverage, crate::usage::UsageCoverage::Estimated);
            assert_eq!(tokens.accounting.unwrap().reason, Some(UsageReason::InconsistentCounts));

            // Repeated/later snapshots cannot erase the contradiction.
            usage.merge(serde_json::from_value(baseline.clone()).unwrap());
            assert_eq!(usage.tokens(), tokens);
            let mut state = ChatAccumulator::default();
            state.record_usage(&WireCompletion {
                usage: Some(usage),
                ..Default::default()
            });
            for final_receipt in [true, false] {
                let accounted = state.accounted_usage(0, 0, final_receipt);
                assert_eq!(accounted, tokens);
            }
        }
        let mut unchanged: WireUsage = serde_json::from_value(baseline).unwrap();
        unchanged.merge(WireUsage::default());
        assert!(unchanged.tokens().measured);
        assert_eq!(unchanged.tokens().accounting.unwrap().reason, None);
    }

    #[test]
    fn wire_usage_regressions_across_cache_aliases_cannot_reduce_inclusive_counts() {
        let mut usage: WireUsage = serde_json::from_value(serde_json::json!({
            "prompt_cache_hit_tokens": 60, "prompt_cache_miss_tokens": 40,
            "completion_tokens": 20
        })).unwrap();
        usage.merge(serde_json::from_value(serde_json::json!({
            "prompt_tokens": 90, "prompt_tokens_details": {"cached_tokens": 40}
        })).unwrap());
        let tokens = usage.tokens();
        assert_eq!((tokens.input_tokens, tokens.cached_input_tokens, tokens.total_tokens), (100, 60, 120));
        assert!(!tokens.measured);
        assert_eq!(tokens.accounting.unwrap().coverage, crate::usage::UsageCoverage::Estimated);
        assert_eq!(tokens.accounting.unwrap().reason, Some(UsageReason::InconsistentCounts));
    }

    #[test]
    fn wire_usage_regressions_in_final_stream_receipts_preserve_consumption_on_success_and_error() {
        let baseline = serde_json::json!({
            "prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120,
            "prompt_tokens_details": {"cached_tokens": 60, "cache_write_tokens": 30},
            "completion_tokens_details": {"reasoning_tokens": 5}
        });
        let zero = serde_json::json!({
            "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0,
            "prompt_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 0},
            "completion_tokens_details": {"reasoning_tokens": 0}
        });
        for (receipt, failed) in [
            (serde_json::json!({"usage":zero}), false),
            (serde_json::json!({"x_groq":{"usage":zero}}), false),
            (serde_json::json!({"usage":zero, "error":{"message":"failed"}}), true),
        ] {
            let _scope = crate::provider_observation::Scope::start();
            let response = accounting_fixture(&format!(
                "data: {}\ndata: {receipt}\ndata: [DONE]\n",
                serde_json::json!({
                    "choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}],
                    "usage":baseline
                })
            ));
            let tokens = if failed {
                assert!(response.is_err());
                crate::provider_observation::snapshot().unwrap().tokens.unwrap()
            } else {
                let response = response.unwrap();
                assert_eq!(response.content, "answer");
                assert_eq!((response.input_tokens, response.output_tokens), (Some(100), Some(20)));
                response.accounted_usage
            };
            assert_eq!((tokens.input_tokens, tokens.output_tokens, tokens.total_tokens), (100, 20, 120));
            assert_eq!((tokens.cached_input_tokens, tokens.cache_write_tokens, tokens.reasoning_output_tokens), (60, 30, 5));
            assert!(!tokens.measured);
            assert_eq!(tokens.accounting.unwrap().coverage, crate::usage::UsageCoverage::Estimated);
            assert_eq!(tokens.accounting.unwrap().reason, Some(UsageReason::InconsistentCounts));
        }
    }

    #[test]
    fn wire_usage_regressions_remain_estimated_when_the_stream_is_cancelled() {
        let _scope = crate::provider_observation::Scope::start();
        let (address, server) = serve_once(
            "200 OK", "text/event-stream",
            concat!(
                "data: {\"choices\":[{\"delta\":{\"content\":\"start\"}}],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":20,\"total_tokens\":120,\"prompt_tokens_details\":{\"cache_write_tokens\":30}}}\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"cancel\"}}],\"usage\":{\"prompt_tokens\":0,\"completion_tokens\":0,\"total_tokens\":0,\"prompt_tokens_details\":{\"cache_write_tokens\":0}}}\n"
            )
        );
        let cancellation = CancellationToken::default();
        let result = openai_compat_tool_chat_once(
            &OpenAiCompatChatRequest {
                base_url: &format!("http://{address}/v1"),
                api_key: "",
                model: "test",
                messages: vec![],
                tools: vec![],
                reasoning_effort: None,
            },
            &cancellation,
            |text| {
                if text == "cancel" {
                    cancellation.cancel();
                }
            },
        );
        server.join().unwrap();
        assert_eq!(result.unwrap_err().to_string(), OPENAI_COMPAT_CANCELLED_MESSAGE);
        let tokens = crate::provider_observation::snapshot().unwrap().tokens.unwrap();
        assert_eq!((tokens.input_tokens, tokens.output_tokens, tokens.total_tokens, tokens.cache_write_tokens), (100, 20, 120, 30));
        assert!(!tokens.measured);
        assert_eq!(tokens.accounting.unwrap().coverage, crate::usage::UsageCoverage::Estimated);
        assert_eq!(tokens.accounting.unwrap().reason, Some(UsageReason::InconsistentCounts));
    }

    #[test]
    fn openrouter_receipt_regression_cannot_replace_observed_consumption_with_complete_zero() {
        let (result, _) = openrouter_stream_fixture(
            OPENROUTER_PARTIAL_STREAM,
            "200 OK",
            r#"{"data":{"id":"gen-fixture","cancelled":false,"finish_reason":"tool_calls","native_tokens_prompt":0,"native_tokens_completion":0}}"#,
        );
        let response = result.unwrap();
        assert_eq!(response.content, "answer");
        assert_eq!((response.input_tokens, response.output_tokens), (Some(9), Some(1)));
        assert_eq!(response.accounted_usage.total_tokens, 10);
        assert!(!response.accounted_usage.measured);
        assert_eq!(response.accounted_usage.accounting.unwrap().coverage, crate::usage::UsageCoverage::Estimated);
        assert_eq!(response.accounted_usage.accounting.unwrap().reason, Some(UsageReason::InconsistentCounts));
    }

    #[test]
    fn deepseek_cache_counts_are_inclusive_and_preserve_explicit_zero() {
        for value in [
            serde_json::json!({"prompt_tokens":100,"prompt_cache_hit_tokens":80,"prompt_cache_miss_tokens":20,"completion_tokens":25}),
            serde_json::json!({"prompt_cache_hit_tokens":80,"prompt_cache_miss_tokens":20,"completion_tokens":25}),
        ] {
            let usage: WireUsage = serde_json::from_value(value).unwrap();
            let tokens = usage.tokens();
            assert_eq!(
                (
                    tokens.input_tokens,
                    tokens.cached_input_tokens,
                    tokens.total_tokens
                ),
                (100, 80, 125)
            );
            assert!(tokens.accounting.unwrap().known.cache_read);
        }
        let zero: WireUsage = serde_json::from_value(serde_json::json!({
            "prompt_tokens":0,"prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":0,"completion_tokens":0,"total_tokens":0
        })).unwrap();
        assert!(zero.tokens().measured);
        assert_eq!(zero.tokens().total_tokens, 0);
        let inconsistent: WireUsage = serde_json::from_value(serde_json::json!({
            "prompt_tokens":90,"prompt_cache_hit_tokens":80,"prompt_cache_miss_tokens":20,"completion_tokens":25
        })).unwrap();
        assert_eq!(
            inconsistent.tokens().accounting.unwrap().reason,
            Some(UsageReason::InconsistentCounts)
        );
    }

    #[test]
    fn cumulative_cache_and_reasoning_frames_replace_then_tool_rounds_add() {
        let first = accounting_fixture(concat!(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"read_file\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n",
            "data: {\"choices\":null,\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":20,\"total_tokens\":120,\"prompt_tokens_details\":{\"cached_tokens\":60,\"cache_write_tokens\":20},\"completion_tokens_details\":{\"reasoning_tokens\":5}}}\n",
            "data: {\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":20,\"total_tokens\":120,\"prompt_tokens_details\":{\"cached_tokens\":60,\"cache_write_tokens\":20}}}\n",
            "data: [DONE]\n"
        )).unwrap();
        assert_eq!(first.tool_calls.len(), 1);
        assert_eq!(
            (
                first.accounted_usage.total_tokens,
                first.accounted_usage.cache_write_tokens,
                first.accounted_usage.reasoning_output_tokens
            ),
            (120, 20, 5)
        );
        assert!(first.accounted_usage.accounting.unwrap().known.cache_write);
        let second = accounting_fixture(concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"done\",\"tool_calls\":null},\"finish_reason\":\"stop\"}]}\n",
            "data: {\"x_groq\":{\"usage\":{\"prompt_tokens\":140,\"completion_tokens\":20,\"total_tokens\":160}}}\n",
            "data: [DONE]\n"
        )).unwrap();
        let turn = first
            .accounted_usage
            .combine(second.accounted_usage)
            .with_scope(crate::usage::UsageScope::Turn);
        assert_eq!(
            (turn.input_tokens, turn.output_tokens, turn.total_tokens),
            (240, 40, 280)
        );
        assert!(!turn.accounting.unwrap().known.cache_write);
    }

    #[test]
    fn terminal_errors_drain_provider_usage_and_refuse_partial_tools() {
        for terminal in [
            "data: {\"choices\":[{\"finish_reason\":\"length\"}]}\n",
            "data: {\"error\":{\"message\":\"failed\"}}\n",
            "data: {\"x_groq\":{\"error\":{\"message\":\"failed\"}}}\n",
        ] {
            let _scope = crate::provider_observation::Scope::start();
            let result = accounting_fixture(&format!(
                "data: {{\"choices\":[{{\"delta\":{{\"tool_calls\":[{{\"index\":0,\"function\":{{\"name\":\"write_file\",\"arguments\":\"{{}}\"}}}}]}}}}]}}\n{terminal}data: {{\"x_groq\":{{\"usage\":{{\"prompt_tokens\":40,\"completion_tokens\":5,\"total_tokens\":45}}}}}}\ndata: [DONE]\n"
            ));
            assert!(result.is_err());
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
    fn estimated_missing_halves_never_claim_a_reported_lower_bound() {
        let mut state = ChatAccumulator::default();
        let frame: WireCompletion = serde_json::from_value(serde_json::json!({
            "usage": { "prompt_tokens_details": {"cached_tokens": 20, "cache_write_tokens": 5},
                "completion_tokens_details": {"reasoning_tokens": 9} }
        })).unwrap();
        state.record_usage(&frame);
        let tokens = state.accounted_usage(80, 40, true);
        assert_eq!((tokens.input_tokens, tokens.output_tokens, tokens.total_tokens), (25, 10, 35));
        assert_eq!(tokens.effective_accounting().coverage, crate::usage::UsageCoverage::Estimated);
        assert_eq!(tokens.effective_accounting().source, UsageSource::Mixed);
        assert!(!tokens.effective_accounting().known.input && !tokens.effective_accounting().known.output);
        assert_eq!((tokens.cached_input_tokens, tokens.cache_write_tokens, tokens.reasoning_output_tokens), (20, 5, 9));
    }

    #[test]
    fn missing_usage_is_estimated_and_a_zero_receipt_stays_zero() {
        let missing = accounting_fixture("data: {\"choices\":[{\"delta\":{\"content\":\"done\"},\"finish_reason\":\"stop\"}]}\ndata: [DONE]\n").unwrap();
        assert!(!missing.accounted_usage.measured);
        assert_eq!(
            missing.accounted_usage.accounting.unwrap().source,
            UsageSource::CharacterEstimate
        );
        assert_eq!(
            missing.accounted_usage.accounting.unwrap().reason,
            Some(UsageReason::MissingUsage)
        );
        let zero = accounting_fixture("data: {\"choices\":[{\"delta\":{\"content\":\"done\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":0,\"completion_tokens\":0,\"total_tokens\":0}}\ndata: [DONE]\n").unwrap();
        assert_eq!(zero.accounted_usage.total_tokens, 0);
        assert!(zero.accounted_usage.measured);
    }

    #[test]
    fn usage_receipt_is_time_bounded_and_stop_remains_responsive() {
        for stop in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let (release, released) = std::sync::mpsc::channel();
            let (started, ready) = std::sync::mpsc::channel();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let _request = read_request(&mut stream);
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 10000\r\n\r\ndata: {{\"choices\":[{{\"delta\":{{\"content\":\"partial\"}},\"finish_reason\":\"length\"}}]}}\n").unwrap();
                stream.flush().unwrap();
                started.send(()).unwrap();
                let _ = released.recv_timeout(Duration::from_secs(6));
            });
            let cancellation = CancellationToken::default();
            let signal = cancellation.clone();
            let cancel = std::thread::spawn(move || {
                ready.recv().unwrap();
                if stop {
                    signal.cancel();
                }
            });
            let began = std::time::Instant::now();
            let result = openai_compat_tool_chat_once(
                &OpenAiCompatChatRequest {
                    base_url: &format!("http://{address}/v1"),
                    api_key: "",
                    model: "test",
                    messages: vec![],
                    tools: vec![],
                    reasoning_effort: None,
                },
                &cancellation,
                |_| {},
            );
            release.send(()).unwrap();
            server.join().unwrap();
            cancel.join().unwrap();
            let error = result.unwrap_err().to_string();
            if stop {
                assert!(cancellation.is_cancelled());
                assert!(began.elapsed() < Duration::from_secs(1));
            } else {
                assert!(error.contains("output token limit"), "{error}");
                assert!(began.elapsed() < Duration::from_secs(5));
            }
        }
    }

    #[test]
    fn a_preterminal_usage_snapshot_cannot_claim_final_coverage() {
        let response = accounting_fixture(concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"start\"}}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":1}}\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\" done\"},\"finish_reason\":\"stop\"}]}\n",
            "data: [DONE]\n"
        )).unwrap();
        assert_eq!(response.accounted_usage.total_tokens, 11);
        assert!(!response.accounted_usage.measured);
        assert_eq!(
            response.accounted_usage.accounting.unwrap().reason,
            Some(UsageReason::ProviderIncomplete)
        );
    }

    #[test]
    fn done_marker_without_generation_finish_cannot_authorize_tools() {
        let result = accounting_fixture(concat!(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"write_file\",\"arguments\":\"{}\"}}]}}]}\n",
            "data: [DONE]\n"
        ));
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("before completion"));
    }

    struct RecordedRequest {
        request_line: String,
        headers: String,
        body: String,
    }

    impl RecordedRequest {
        fn header(&self, name: &str) -> Option<String> {
            self.headers.lines().find_map(|line| {
                let (key, value) = line.split_once(':')?;
                key.eq_ignore_ascii_case(name)
                    .then(|| value.trim().to_string())
            })
        }
    }

    fn read_request(stream: &mut TcpStream) -> RecordedRequest {
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut request_line = String::new();
        reader.read_line(&mut request_line).unwrap();
        let request_line = request_line.trim().to_string();
        let mut headers = String::new();
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
            headers.push_str(&header);
        }
        let mut body = vec![0; content_length];
        reader.read_exact(&mut body).unwrap();
        RecordedRequest {
            request_line,
            headers,
            body: String::from_utf8(body).unwrap(),
        }
    }

    fn http_response(status: &str, content_type: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    /// Serve one request, returning the address plus a handle that yields what
    /// the client actually sent.
    fn serve_once(
        status: &'static str,
        content_type: &'static str,
        body: &str,
    ) -> (SocketAddr, std::thread::JoinHandle<RecordedRequest>) {
        let body = body.to_string();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            stream
                .write_all(http_response(status, content_type, &body).as_bytes())
                .unwrap();
            stream.flush().unwrap();
            request
        });
        (address, handle)
    }

    #[test]
    fn refuses_out_of_range_tool_indexes_without_allocating_slots() {
        for index in [crate::provider_retry::MAX_CHAT_TOOL_CALLS, usize::MAX] {
            let mut state = ChatAccumulator::default();
            let call = WireToolCall {
                index: Some(index),
                ..Default::default()
            };
            assert!(state.slot_for(&call).is_err());
            assert!(state.tool_calls.is_empty());
        }
    }

    #[test]
    fn caps_unindexed_tool_calls_but_accepts_argument_continuations() {
        let mut state = ChatAccumulator::default();
        let new_call = WireToolCall {
            id: Some("call".to_string()),
            ..Default::default()
        };
        for _ in 0..crate::provider_retry::MAX_CHAT_TOOL_CALLS {
            state.slot_for(&new_call).unwrap();
        }
        assert!(state.slot_for(&WireToolCall::default()).is_ok());
        assert!(state.slot_for(&new_call).is_err());
        assert_eq!(
            state.tool_calls.len(),
            crate::provider_retry::MAX_CHAT_TOOL_CALLS
        );
    }

    #[test]
    fn repeated_unindexed_call_ids_correlate_interleaved_argument_fragments() {
        let mut state = ChatAccumulator::default();
        for frame in [
            serde_json::json!({"choices":[{"delta":{"tool_calls":[
                {"id":"read-a","function":{"name":"read_file","arguments":"{\"path\":"}},
                {"id":"read-b","function":{"name":"read_file","arguments":"{\"path\":"}}
            ]}}]}),
            serde_json::json!({"choices":[{"delta":{"tool_calls":[
                {"id":"read-a","function":{"arguments":"\"a.txt\"}"}},
                {"id":"read-b","function":{"arguments":"\"b.txt\"}"}}
            ]}}]}),
        ] {
            state
                .apply(serde_json::from_value(frame).unwrap(), &mut |_| {})
                .unwrap();
        }
        let calls = state.tool_calls().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].id.as_deref(), Some("read-a"));
        assert_eq!(calls[0].arguments, serde_json::json!({"path":"a.txt"}));
        assert_eq!(calls[1].id.as_deref(), Some("read-b"));
        assert_eq!(calls[1].arguments, serde_json::json!({"path":"b.txt"}));
    }

    #[test]
    fn alternative_completion_choices_cannot_add_or_replace_workspace_actions() {
        let mut state = ChatAccumulator::default();
        let frame = serde_json::json!({"choices":[
            {"index":0,"message":{"content":"Reading.","reasoning_content":"read state", "tool_calls":[
                {"index":0,"id":"read","function":{"name":"read_file","arguments":"{}"}}
            ]}},
            {"index":1,"message":{"content":"Writing.","reasoning_content":"write state", "tool_calls":[
                {"index":0,"id":"write","function":{"name":"write_file","arguments":"{}"}}
            ]}}
        ]});
        let mut deltas = Vec::new();
        state
            .apply(serde_json::from_value(frame).unwrap(), &mut |text| {
                deltas.push(text.to_owned())
            })
            .unwrap();
        assert_eq!(deltas, ["Reading."]);
        assert_eq!(state.reasoning_content.as_deref(), Some("read state"));
        let calls = state.tool_calls().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "read_file");
        assert_eq!(calls[0].id.as_deref(), Some("read"));
    }

    #[test]
    fn generation_error_after_tool_fragments_cannot_return_a_successful_turn() {
        let (address, server) = serve_once(
            "200 OK",
            "text/event-stream",
            concat!(
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"write_file\",\"arguments\":\"{}\"}}]}}]}\n\n",
                "data: {\"error\":{\"message\":\"generation failed\"}}\n\n",
                "data: [DONE]\n",
            ),
        );
        let result = openai_compat_tool_chat(OpenAiCompatChatRequest {
            base_url: &format!("http://{address}/v1"),
            api_key: "",
            model: "test",
            messages: Vec::new(),
            tools: Vec::new(),
            reasoning_effort: None,
        });
        server.join().unwrap();
        assert!(result.unwrap_err().to_string().contains("generation error"));
    }

    #[test]
    fn refuses_incomplete_terminal_reasons_even_with_valid_tool_arguments() {
        for (content_type, body, expected) in [
            (
                "text/event-stream",
                concat!(
                    "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"edit\",\"function\":{\"name\":\"write_file\",\"arguments\":\"{}\"}}]}}]}\n\n",
                    "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\n",
                    "data: [DONE]\n",
                ),
                "output token limit",
            ),
            (
                "text/event-stream",
                concat!(
                    "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"write_file\",\"arguments\":\"{}\"}}]}}]}\n\n",
                    "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"content_filter\"}]}\n\n",
                    "data: [DONE]\n",
                ),
                "filtered the response",
            ),
            (
                "application/json",
                r#"{"choices":[{"message":{"tool_calls":[{"id":"edit","function":{"name":"write_file","arguments":"{}"}}]},"finish_reason":"length"}]}"#,
                "output token limit",
            ),
            (
                "application/json",
                r#"{"choices":[{"message":{"content":"partial answer"},"finish_reason":"length"}]}"#,
                "output token limit",
            ),
        ] {
            let (address, server) = serve_once("200 OK", content_type, body);
            let error = openai_compat_tool_chat(OpenAiCompatChatRequest {
                base_url: &format!("http://{address}/v1"),
                api_key: "",
                model: "test",
                messages: Vec::new(),
                tools: Vec::new(),
                reasoning_effort: None,
            })
            .unwrap_err();
            server.join().unwrap();
            assert!(error.to_string().contains(expected), "{error}");
        }
    }

    #[test]
    fn accepts_successful_tool_completion_when_an_alternative_hits_its_limit() {
        let mut state = ChatAccumulator::default();
        state.apply(serde_json::from_value(serde_json::json!({
            "choices": [
                {"index": 0, "finish_reason": "tool_calls", "message": {
                    "tool_calls": [{"id": "read", "function": {"name": "read_file", "arguments": "{}"}}]
                }},
                {"index": 1, "finish_reason": "length", "message": {"content": "alternative"}}
            ]
        })).unwrap(), &mut |_| {}).unwrap();
        let calls = state.tool_calls().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "read_file");
    }

    #[test]
    fn requires_https_except_for_loopback_hosts() {
        assert_eq!(
            openai_compat_endpoint("https://api.deepseek.com/v1")
                .unwrap()
                .as_str(),
            "https://api.deepseek.com/v1"
        );
        for endpoint in [
            "https://openrouter.ai/api/v1",
            "http://localhost:1234/v1",
            "http://127.0.0.1:1234/v1",
            "http://[::1]:1234/v1",
        ] {
            assert!(openai_compat_endpoint(endpoint).is_ok(), "{endpoint}");
        }
        for endpoint in [
            // A public or LAN host over plain http would put the Bearer token on
            // the wire in clear text.
            "http://api.deepseek.com/v1",
            "http://192.168.1.10:1234/v1",
            "https://user:secret@example.com/v1",
            "https://example.com/v1#fragment",
            "ftp://example.com/v1",
            "   ",
        ] {
            assert!(openai_compat_endpoint(endpoint).is_err(), "{endpoint}");
        }
    }

    #[test]
    fn joins_paths_onto_the_configured_base_url() {
        let endpoint = openai_compat_endpoint("https://api.deepseek.com/v1/").unwrap();
        assert_eq!(
            endpoint_child(&endpoint, CHAT_PATH).unwrap().as_str(),
            "https://api.deepseek.com/v1/chat/completions"
        );
        // A bare host still lands the documented path rather than replacing it.
        let endpoint = openai_compat_endpoint("https://gateway.example.com").unwrap();
        assert_eq!(
            endpoint_child(&endpoint, CHAT_PATH).unwrap().as_str(),
            "https://gateway.example.com/chat/completions"
        );
        // A gateway that versions through the query string keeps it.
        let endpoint =
            openai_compat_endpoint("https://gateway.example.com/openai?api-version=2024-10-21")
                .unwrap();
        assert_eq!(
            endpoint_child(&endpoint, MODELS_PATH).unwrap().as_str(),
            "https://gateway.example.com/openai/models?api-version=2024-10-21"
        );
    }

    #[test]
    fn streams_deltas_and_accumulates_fragmented_tool_calls() {
        let (address, server) = serve_once(
            "200 OK",
            "text/event-stream",
            concat!(
                ": keep-alive\n",
                "\n",
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"state \"}}]}\n",
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"continued\"}}]}\n",
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hel\"}}]}\n",
                "\n",
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"lo\"}}]}\n",
                "\n",
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"pa\"}}]}}]}\n",
                "\n",
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"th\\\":\\\"a.txt\\\"}\"}}]}}]}\n",
                "\n",
                "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n",
                "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":11,\"completion_tokens\":7}}\n",
                "\n",
                "data: [DONE]\n",
            ),
        );
        let mut deltas = Vec::new();
        let response = openai_compat_tool_chat_with_progress(
            OpenAiCompatChatRequest {
                base_url: &format!("http://{address}/v1"),
                api_key: "sk-test-key",
                model: "deepseek-chat",
                messages: vec![serde_json::json!({ "role": "user", "content": "Hi" })],
                tools: vec![serde_json::json!({ "type": "function" })],
                reasoning_effort: None,
            },
            &CancellationToken::default(),
            |delta| deltas.push(delta.to_string()),
        )
        .unwrap();
        let recorded = server.join().unwrap();

        assert_eq!(deltas, ["Hel", "lo"]);
        assert_eq!(response.content, "Hello");
        assert_eq!(
            response.reasoning_content.as_deref(),
            Some("state continued")
        );
        assert_eq!(response.input_tokens, Some(11));
        assert_eq!(response.output_tokens, Some(7));
        assert_eq!(response.tool_calls.len(), 1);
        assert_eq!(response.tool_calls[0].name, "read_file");
        assert_eq!(response.tool_calls[0].id.as_deref(), Some("call_1"));
        assert_eq!(
            response.tool_calls[0].arguments,
            serde_json::json!({ "path": "a.txt" })
        );

        assert_eq!(recorded.request_line, "POST /v1/chat/completions HTTP/1.1");
        assert_eq!(
            recorded.header("authorization").as_deref(),
            Some("Bearer sk-test-key")
        );
        let sent: serde_json::Value = serde_json::from_str(&recorded.body).unwrap();
        assert_eq!(sent["model"], "deepseek-chat");
        assert_eq!(sent["stream"], true);
        assert_eq!(sent["stream_options"]["include_usage"], true);
        assert_eq!(sent["tools"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn retries_without_stream_options_when_a_gateway_rejects_them() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let mut bodies = Vec::new();
            for attempt in 0..3 {
                let (mut stream, _) = listener.accept().unwrap();
                bodies.push(read_request(&mut stream).body);
                let response = if attempt == 0 {
                    http_response(
                        "400 Bad Request",
                        "application/json",
                        r#"{"error":{"message":"unknown field stream_options"}}"#,
                    )
                } else {
                    http_response(
                        "200 OK",
                        "text/event-stream",
                        "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n",
                    )
                };
                stream.write_all(response.as_bytes()).unwrap();
                stream.flush().unwrap();
            }
            bodies
        });
        let response = openai_compat_tool_chat(OpenAiCompatChatRequest {
            base_url: &format!("http://{address}/v1"),
            api_key: "",
            model: "local-model",
            messages: Vec::new(),
            tools: Vec::new(),
            reasoning_effort: Some("high"),
        })
        .unwrap();
        openai_compat_tool_chat(OpenAiCompatChatRequest {
            base_url: &format!("http://{address}/v1"),
            api_key: "",
            model: "local-model",
            messages: Vec::new(),
            tools: Vec::new(),
            reasoning_effort: Some("high"),
        })
        .unwrap();
        let bodies = server.join().unwrap();
        assert_eq!(response.content, "ok");
        let first: serde_json::Value = serde_json::from_str(&bodies[0]).unwrap();
        let second: serde_json::Value = serde_json::from_str(&bodies[1]).unwrap();
        assert!(first.get("stream_options").is_some());
        assert!(second.get("stream_options").is_none());
        assert_eq!(second["reasoning_effort"], "high");
        let third: serde_json::Value = serde_json::from_str(&bodies[2]).unwrap();
        assert!(third.get("stream_options").is_none());
        assert_eq!(third["reasoning_effort"], "high");
        // A keyless loopback server must not be handed an empty Bearer header.
        assert!(second.get("tools").is_none());
    }

    #[test]
    fn generic_bad_requests_fail_without_removing_selected_options() {
        let (address, server) = serve_once(
            "400 Bad Request",
            "application/json",
            r#"{"error":{"message":"unknown model"}}"#,
        );
        let error = openai_compat_tool_chat(OpenAiCompatChatRequest {
            base_url: &format!("http://{address}/v1"),
            api_key: "",
            model: "missing-model",
            messages: Vec::new(),
            tools: Vec::new(),
            reasoning_effort: Some("high"),
        })
        .unwrap_err();
        let sent: serde_json::Value = serde_json::from_str(&server.join().unwrap().body).unwrap();
        assert_eq!(sent["reasoning_effort"], "high");
        assert!(error.to_string().contains("unknown model"));
    }

    #[test]
    fn accepts_a_gateway_that_ignores_streaming() {
        let (address, server) = serve_once(
            "200 OK",
            "application/json",
            r#"{"choices":[{"message":{"content":"plain answer"}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}"#,
        );
        let mut deltas = Vec::new();
        let response = openai_compat_tool_chat_with_progress(
            OpenAiCompatChatRequest {
                base_url: &format!("http://{address}/v1"),
                api_key: "k",
                model: "m",
                messages: Vec::new(),
                tools: Vec::new(),
                reasoning_effort: None,
            },
            &CancellationToken::default(),
            |delta| deltas.push(delta.to_string()),
        )
        .unwrap();
        server.join().unwrap();
        assert_eq!(deltas, ["plain answer"]);
        assert_eq!(response.content, "plain answer");
        assert_eq!(response.input_tokens, Some(3));
        assert_eq!(response.output_tokens, Some(2));
    }

    /// A thinking budget only means something if it reaches the endpoint, and
    /// only the request body can prove it did.
    #[test]
    fn retries_http_failure_with_completed_tool_results_intact() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for index in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                requests.push(read_request(&mut stream).body);
                let response = if index == 0 {
                    "HTTP/1.1 503 Busy\r\nRetry-After: 0\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string()
                } else {
                    http_response(
                        "200 OK",
                        "application/json",
                        r#"{"choices":[{"message":{"content":"Recovered"}}]}"#,
                    )
                };
                stream.write_all(response.as_bytes()).unwrap();
            }
            requests
        });
        let response = openai_compat_tool_chat(OpenAiCompatChatRequest {
            base_url: &format!("http://{address}/v1"), api_key: "", model: "test",
            messages: vec![serde_json::json!({"role":"tool","tool_call_id":"already-applied","content":"edit complete"})],
            tools: vec![], reasoning_effort: None,
        }).unwrap();
        let requests = server.join().unwrap();
        assert_eq!(response.content, "Recovered");
        assert_eq!(requests[0], requests[1]);
        assert!(requests[1].contains("already-applied"));
    }

    #[test]
    fn recovers_silent_stream_disconnect_with_tool_results_intact() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for index in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                requests.push(read_request(&mut stream).body);
                let response = if index == 0 {
                    http_response(
                        "200 OK",
                        "text/event-stream",
                        "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"thinking\"}}]}\n",
                    )
                } else {
                    http_response(
                        "200 OK",
                        "application/json",
                        r#"{"choices":[{"message":{"content":"Recovered"}}]}"#,
                    )
                };
                stream.write_all(response.as_bytes()).unwrap();
            }
            requests
        });
        let response = openai_compat_tool_chat(OpenAiCompatChatRequest {
            base_url: &format!("http://{address}/v1"), api_key: "", model: "test",
            messages: vec![serde_json::json!({"role":"tool","tool_call_id":"already-applied","content":"edit complete"})],
            tools: vec![], reasoning_effort: None,
        }).unwrap();
        let requests = server.join().unwrap();
        assert_eq!(response.content, "Recovered");
        assert_eq!(requests[0], requests[1]);
        assert!(requests[1].contains("already-applied"));
    }

    #[test]
    fn rejects_truncated_tool_stream_and_accepts_finish_reason() {
        for (body, succeeds) in [
            ("data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n", false),
            ("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"}},{\"index\":1,\"finish_reason\":\"stop\"}]}\n", false),
            ("data: {\"choices\":[{\"delta\":{\"content\":\"complete\"},\"finish_reason\":\"stop\"}]}\n", true),
        ] {
            let (address, server) = serve_once("200 OK", "text/event-stream", body);
            let response = openai_compat_tool_chat(OpenAiCompatChatRequest {
                base_url: &format!("http://{address}/v1"), api_key: "", model: "test",
                messages: vec![], tools: vec![], reasoning_effort: None,
            });
            server.join().unwrap();
            assert_eq!(response.is_ok(), succeeds);
            if let Err(error) = response { assert!(error.to_string().contains("before completion")); }
        }
    }

    #[test]
    fn nonstream_tool_completion_preserves_reasoning_state() {
        let (address, server) = serve_once(
            "200 OK",
            "application/json",
            r#"{"choices":[{"message":{"content":null,"reasoning_content":"opaque state","tool_calls":[{"id":"read","function":{"name":"read_file","arguments":"{\"path\":\"README.md\"}"}}]}}]}"#,
        );
        let mut deltas = Vec::new();
        let response = openai_compat_tool_chat_with_progress(
            OpenAiCompatChatRequest {
                base_url: &format!("http://{address}/v1"),
                api_key: "",
                model: "test",
                messages: vec![],
                tools: vec![],
                reasoning_effort: None,
            },
            &CancellationToken::default(),
            |text| deltas.push(text.to_owned()),
        )
        .unwrap();
        server.join().unwrap();
        assert_eq!(response.reasoning_content.as_deref(), Some("opaque state"));
        assert!(response.content.is_empty());
        assert!(deltas.is_empty());
        assert_eq!(
            response.tool_calls[0].arguments,
            serde_json::json!({"path":"README.md"})
        );
    }

    #[test]
    fn sends_the_requested_reasoning_effort() {
        let (address, server) = serve_once(
            "200 OK",
            "text/event-stream",
            "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n",
        );
        let response = openai_compat_tool_chat(OpenAiCompatChatRequest {
            base_url: &format!("http://{address}/v1"),
            api_key: "k",
            model: "deepseek-flash",
            messages: Vec::new(),
            tools: Vec::new(),
            reasoning_effort: Some("max"),
        })
        .unwrap();
        let body = server.join().unwrap().body;
        assert_eq!(response.content, "ok");
        let sent: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(sent["reasoning_effort"], "max");
    }

    /// An effort a model does not publish must not travel as an empty string,
    /// which some gateways reject outright rather than ignore.
    #[test]
    fn omits_reasoning_effort_when_none_is_selected() {
        let (address, server) = serve_once(
            "200 OK",
            "text/event-stream",
            "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n",
        );
        openai_compat_tool_chat(OpenAiCompatChatRequest {
            base_url: &format!("http://{address}/v1"),
            api_key: "k",
            model: "m",
            messages: Vec::new(),
            tools: Vec::new(),
            reasoning_effort: Some("   "),
        })
        .unwrap();
        let sent: serde_json::Value = serde_json::from_str(&server.join().unwrap().body).unwrap();
        assert!(sent.get("reasoning_effort").is_none());
    }

    /// Mistral answers a `reasoning_effort: high` turn with an array of typed
    /// chunks instead of a string. Before `WireContent` that frame failed to
    /// deserialize and the answer was dropped on the floor, so the turn came
    /// back empty with no error to explain it.
    #[test]
    fn reads_a_chunked_content_answer_and_drops_the_thinking_trace() {
        let (address, server) = serve_once(
            "200 OK",
            "application/json",
            r#"{"choices":[{"message":{"content":[{"type":"thinking","thinking":[{"type":"text","text":"let me count"}]},{"type":"text","text":"391"}]}}]}"#,
        );
        let mut deltas = Vec::new();
        let response = openai_compat_tool_chat_with_progress(
            OpenAiCompatChatRequest {
                base_url: &format!("http://{address}/v1"),
                api_key: "k",
                model: "mistral-medium-latest",
                messages: Vec::new(),
                tools: Vec::new(),
                reasoning_effort: Some("high"),
            },
            &CancellationToken::default(),
            |delta| deltas.push(delta.to_string()),
        )
        .unwrap();
        server.join().unwrap();
        assert_eq!(response.content, "391");
        assert_eq!(deltas, ["391"]);
    }

    #[test]
    fn reports_provider_error_messages_without_the_key() {
        let (address, server) = serve_once(
            "401 Unauthorized",
            "application/json",
            r#"{"error":{"message":"Incorrect API key provided"}}"#,
        );
        let error = openai_compat_tool_chat(OpenAiCompatChatRequest {
            base_url: &format!("http://{address}/v1"),
            api_key: "sk-secret-value",
            model: "m",
            messages: Vec::new(),
            tools: Vec::new(),
            reasoning_effort: None,
        })
        .unwrap_err()
        .to_string();
        server.join().unwrap();
        assert_eq!(
            error,
            "provider returned HTTP 401: Incorrect API key provided"
        );
        assert!(!error.contains("sk-secret-value"));
    }

    #[test]
    fn refuses_to_follow_redirects_with_a_bearer_token() {
        let (address, server) = serve_once("302 Found", "text/plain", "");
        let error = openai_compat_tool_chat(OpenAiCompatChatRequest {
            base_url: &format!("http://{address}/v1"),
            api_key: "sk-test",
            model: "m",
            messages: Vec::new(),
            tools: Vec::new(),
            reasoning_effort: None,
        })
        .unwrap_err()
        .to_string();
        server.join().unwrap();
        assert!(error.contains("redirected"), "{error}");
    }

    #[test]
    fn lists_models_and_tolerates_the_models_key() {
        let (address, server) = serve_once(
            "200 OK",
            "application/json",
            r#"{"data":[{"id":"deepseek-chat"},{"id":"deepseek-reasoner"},{"id":"deepseek-chat"},{"name":"legacy-name"}]}"#,
        );
        let discovery =
            openai_compat_list_models(&format!("http://{address}/v1"), "sk-test").unwrap();
        let recorded = server.join().unwrap();
        assert_eq!(recorded.request_line, "GET /v1/models HTTP/1.1");
        assert_eq!(
            recorded.header("authorization").as_deref(),
            Some("Bearer sk-test")
        );
        assert_eq!(
            discovery
                .models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["deepseek-chat", "deepseek-reasoner", "legacy-name"]
        );
        assert_eq!(discovery.base_url, format!("http://{address}/v1"));

        let (address, server) = serve_once(
            "200 OK",
            "application/json",
            r#"{"models":[{"id":"local-llama"}]}"#,
        );
        let discovery = openai_compat_list_models(&format!("http://{address}/v1"), "").unwrap();
        let recorded = server.join().unwrap();
        assert!(recorded.header("authorization").is_none());
        assert_eq!(discovery.models[0].id, "local-llama");
    }

    #[test]
    fn honors_cancellation_before_touching_the_network() {
        let cancellation = CancellationToken::default();
        cancellation.cancel();
        let error = openai_compat_tool_chat_with_progress(
            OpenAiCompatChatRequest {
                base_url: "https://api.deepseek.com/v1",
                api_key: "sk-test",
                model: "deepseek-chat",
                messages: Vec::new(),
                tools: Vec::new(),
                reasoning_effort: None,
            },
            &cancellation,
            |_| {},
        )
        .unwrap_err()
        .to_string();
        assert_eq!(error, OPENAI_COMPAT_CANCELLED_MESSAGE);
    }

    #[test]
    fn rejects_an_empty_model_before_sending() {
        let error = openai_compat_tool_chat(OpenAiCompatChatRequest {
            base_url: "https://api.deepseek.com/v1",
            api_key: "sk-test",
            model: "  ",
            messages: Vec::new(),
            tools: Vec::new(),
            reasoning_effort: None,
        })
        .unwrap_err()
        .to_string();
        assert!(error.contains("select a model"), "{error}");
    }

    #[test]
    fn parses_tool_arguments_that_arrive_unparseable() {
        assert_eq!(parse_tool_arguments(""), serde_json::json!({}));
        assert_eq!(
            parse_tool_arguments("{\"a\":1}"),
            serde_json::json!({ "a": 1 })
        );
        // Truncated fragments stay visible instead of becoming an empty object.
        assert_eq!(
            parse_tool_arguments("{\"a\":"),
            serde_json::Value::String("{\"a\":".into())
        );
    }
}
