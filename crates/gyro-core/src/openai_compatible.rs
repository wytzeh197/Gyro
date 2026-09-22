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

use crate::CancellationToken;
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::io::BufReader;
use std::time::Duration;
use url::{Host, Url};

pub const OPENAI_COMPAT_CANCELLED_MESSAGE: &str = "Provider chat cancelled";
const CHAT_PATH: &str = "chat/completions";
const MODELS_PATH: &str = "models";
// A cold TLS handshake to a distant gateway is not a local socket connect; the
// 5s Ollama budget reported healthy providers as unreachable.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
// A reasoning model can think for minutes before its first token.
const CHAT_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const MAX_DISCOVERED_MODELS: usize = 500;
const MAX_ERROR_BODY_CHARS: usize = 400;

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
    /// the 400 retry below drops it.
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
/// Cancellation is checked between frames so Stop does not wait out the read
/// timeout. A non-stream JSON body is accepted too: some gateways ignore
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
    mut on_delta: F,
) -> Result<OpenAiCompatChatResponse>
where
    F: FnMut(&str),
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
    let agent = chat_agent();

    // `stream_options.include_usage` is the only way to get token counts from a
    // streamed OpenAI response, and `reasoning_effort` the only way to ask for a
    // thinking budget, but both are newer fields and strict gateways reject the
    // whole request over either. Retrying once without them keeps usage display
    // and effort on capable servers and keeps the run working on the others: a
    // turn that answers without the requested effort beats a turn that 400s.
    let response = crate::provider_retry::http_response(cancellation, || {
        match post_chat(
            &agent,
            &url,
            api_key,
            &chat_payload(
                model,
                &request.messages,
                &request.tools,
                request.reasoning_effort,
                true,
            ),
        ) {
            Ok(response) => Ok(response),
            Err(ureq::Error::Status(400, _)) => post_chat(
                &agent,
                &url,
                api_key,
                &chat_payload(model, &request.messages, &request.tools, None, false),
            ),
            Err(error) => Err(error),
        }
    })
    .map_err(openai_compat_http_error)?;
    refuse_redirect(&response, &url)?;

    let mut state = ChatAccumulator::default();
    let mut reader = BufReader::new(response.into_reader());
    let mut line = String::new();
    let mut saw_stream_frames = false;
    let mut completed = false;
    // Gateways that ignore `stream: true` answer with one JSON object, which may
    // be pretty-printed across lines; collect it until EOF.
    let mut buffered_body = String::new();
    let mut remaining = crate::provider_retry::MAX_CHAT_RESPONSE_BYTES;
    loop {
        if cancellation.is_cancelled() {
            return Err(anyhow!(OPENAI_COMPAT_CANCELLED_MESSAGE));
        }
        let read = crate::provider_retry::read_chat_line(&mut reader, &mut line, &mut remaining)
            .context("invalid provider chat stream")?;
        if read == 0 {
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
                completed = true;
                break;
            }
            if payload.is_empty() {
                continue;
            }
            let frame: WireCompletion =
                serde_json::from_str(payload).context("invalid provider chat response")?;
            completed |= frame
                .choices
                .iter()
                .any(|choice| choice.index == 0 && choice.finish_reason.is_some());
            state.apply(frame, &mut on_delta)?;
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

    if saw_stream_frames && !completed {
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
        state.apply(parsed, &mut on_delta)?;
    }

    let content = state.content.trim().to_string();
    let reasoning_content = state.reasoning_content.take();
    let input_tokens = state.input_tokens;
    let output_tokens = state.output_tokens;
    let tool_calls = state.tool_calls()?;
    if content.is_empty() && tool_calls.is_empty() {
        return Err(anyhow!("the provider finished without a text response"));
    }
    Ok(OpenAiCompatChatResponse {
        content,
        reasoning_content,
        input_tokens,
        output_tokens,
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
        if let Some(effort) = reasoning_effort
            .map(str::trim)
            .filter(|effort| !effort.is_empty())
        {
            payload["reasoning_effort"] = serde_json::Value::String(effort.to_string());
        }
    }
    payload
}

fn post_chat(
    agent: &ureq::Agent,
    url: &Url,
    api_key: &str,
    payload: &serde_json::Value,
) -> std::result::Result<ureq::Response, ureq::Error> {
    let mut request = agent
        .post(url.as_str())
        .set("Accept", "text/event-stream")
        .set("User-Agent", USER_AGENT)
        // Identity keeps the body as raw SSE lines; a compressed stream is
        // decoded in blocks, which would hold back the tokens this exists to
        // stream.
        .set("Accept-Encoding", "identity");
    if !api_key.is_empty() {
        request = request.set("Authorization", &format!("Bearer {api_key}"));
    }
    request.send_json(payload)
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

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout_read(REQUEST_TIMEOUT)
        .timeout_write(REQUEST_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .redirects(0)
        .build()
}

fn chat_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout_read(CHAT_TIMEOUT)
        .timeout_write(CHAT_TIMEOUT)
        .timeout(CHAT_TIMEOUT)
        .redirects(0)
        .build()
}

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
    content: String,
    reasoning_content: Option<String>,
    tool_calls: Vec<ToolCallAccumulator>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
}

impl ChatAccumulator {
    fn apply<F>(&mut self, frame: WireCompletion, on_delta: &mut F) -> Result<()>
    where
        F: FnMut(&str),
    {
        anyhow::ensure!(
            frame.error.is_none(),
            "the provider reported a generation error; no tool calls were executed"
        );
        if let Some(usage) = frame.usage {
            if usage.prompt_tokens.is_some() {
                self.input_tokens = usage.prompt_tokens;
            }
            if usage.completion_tokens.is_some() {
                self.output_tokens = usage.completion_tokens;
            }
        }
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
    #[serde(default)]
    error: Option<serde_json::Value>,
    #[serde(default)]
    choices: Vec<WireChoice>,
    #[serde(default)]
    usage: Option<WireUsage>,
}

#[derive(Default, Deserialize)]
struct WireChoice {
    #[serde(default)]
    index: usize,
    #[serde(default)]
    finish_reason: Option<String>,
    /// Streaming frames carry the text under `delta`.
    #[serde(default)]
    delta: WireMessage,
    /// A non-streamed completion carries the same shape under `message`.
    #[serde(default)]
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
    #[serde(default)]
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

#[derive(Default, Deserialize)]
struct WireUsage {
    #[serde(default)]
    prompt_tokens: Option<u64>,
    #[serde(default)]
    completion_tokens: Option<u64>,
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
        body: &'static str,
    ) -> (SocketAddr, std::thread::JoinHandle<RecordedRequest>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            stream
                .write_all(http_response(status, content_type, body).as_bytes())
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
            for attempt in 0..2 {
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
            reasoning_effort: None,
        })
        .unwrap();
        let bodies = server.join().unwrap();
        assert_eq!(response.content, "ok");
        let first: serde_json::Value = serde_json::from_str(&bodies[0]).unwrap();
        let second: serde_json::Value = serde_json::from_str(&bodies[1]).unwrap();
        assert!(first.get("stream_options").is_some());
        assert!(second.get("stream_options").is_none());
        // A keyless loopback server must not be handed an empty Bearer header.
        assert!(second.get("tools").is_none());
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
