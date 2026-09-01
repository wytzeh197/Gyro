//! Safe, local-only access to an Ollama runtime.
//!
//! Gyro deliberately does not treat an arbitrary OpenAI-compatible server as
//! local. This module accepts only loopback HTTP endpoints and keeps runtime
//! discovery separate from persisted provider configuration.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use url::{Host, Url};

pub const DEFAULT_OLLAMA_BASE_URL: &str = "http://localhost:11434/api";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
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
}

#[derive(Clone, Debug)]
pub struct OllamaChatRequest<'a> {
    pub base_url: Option<&'a str>,
    pub model: &'a str,
    pub system: &'a str,
    pub user: &'a str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OllamaChatResponse {
    pub content: String,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub tool_calls: Vec<OllamaToolCall>,
}

#[derive(Clone, Debug)]
pub struct OllamaToolChatRequest<'a> {
    pub base_url: Option<&'a str>,
    pub model: &'a str,
    pub messages: Vec<serde_json::Value>,
    pub tools: Vec<serde_json::Value>,
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
    if path.is_empty() {
        url.set_path("/api/");
    } else if path == "/api" {
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

/// Submit one text-only Ollama chat turn. The caller owns session history and
/// capability execution; keeping that state in Gyro is what makes runs
/// resumable even though Ollama itself has no durable conversation cursor.
pub fn ollama_chat(request: OllamaChatRequest<'_>) -> Result<OllamaChatResponse> {
    ollama_tool_chat(OllamaToolChatRequest {
        base_url: request.base_url,
        model: request.model,
        messages: vec![
            serde_json::json!({ "role": "system", "content": request.system }),
            serde_json::json!({ "role": "user", "content": request.user }),
        ],
        tools: Vec::new(),
    })
}

/// Run a single model turn with optional native function tools. Callers retain
/// the returned assistant/tool messages and decide which tool calls may cross
/// their own approval boundary before asking Ollama for the next turn.
pub fn ollama_tool_chat(request: OllamaToolChatRequest<'_>) -> Result<OllamaChatResponse> {
    let model = request.model.trim();
    if model.is_empty() {
        return Err(anyhow!("select an installed Ollama model before sending"));
    }
    let endpoint = ollama_endpoint(request.base_url)?;
    let url = endpoint.join("chat")?;
    let response = agent()
        .post(url.as_str())
        .send_json(ureq::json!({
            "model": model,
            "stream": false,
            "messages": request.messages,
            "tools": request.tools
        }))
        .map_err(ollama_http_error)?;
    ensure_loopback_response(&response, &endpoint)?;
    let response: OllamaChatWireResponse = response
        .into_json()
        .context("invalid Ollama chat response")?;
    let content = response.message.content.trim().to_string();
    let tool_calls = response
        .message
        .tool_calls
        .into_iter()
        .filter_map(|call| {
            (!call.function.name.trim().is_empty()).then_some(OllamaToolCall {
                name: call.function.name,
                arguments: call.function.arguments,
            })
        })
        .collect::<Vec<_>>();
    if content.is_empty() && tool_calls.is_empty() {
        return Err(anyhow!("Ollama finished without a text response"));
    }
    Ok(OllamaChatResponse {
        content,
        input_tokens: response.prompt_eval_count,
        output_tokens: response.eval_count,
        tool_calls,
    })
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(REQUEST_TIMEOUT)
        .timeout_read(REQUEST_TIMEOUT)
        .timeout_write(REQUEST_TIMEOUT)
        .redirects(0)
        .build()
}

fn ensure_loopback_response(response: &ureq::Response, endpoint: &Url) -> Result<()> {
    let response_url = Url::parse(response.get_url()).context("invalid Ollama response URL")?;
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

#[derive(Deserialize)]
struct OllamaChatWireResponse {
    message: OllamaChatWireMessage,
    #[serde(default)]
    prompt_eval_count: Option<u64>,
    #[serde(default)]
    eval_count: Option<u64>,
}

#[derive(Deserialize)]
struct OllamaChatWireMessage {
    #[serde(default)]
    content: String,
    #[serde(default)]
    tool_calls: Vec<OllamaToolCallWire>,
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
    let fallback_description = tag
        .details
        .family
        .as_deref()
        .map(|family| format!("Local {family} model through Ollama."))
        .unwrap_or_else(|| "Local model through Ollama.".into());
    let show = endpoint.join("show").ok().and_then(|url| {
        let response = agent()
            .post(url.as_str())
            .send_json(ureq::json!({ "model": tag.name }));
        let response = response.ok()?;
        ensure_loopback_response(&response, endpoint).ok()?;
        response.into_json::<OllamaShowResponse>().ok()
    });
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
            format!("{fallback_description} Chat only: tool support was not verified.")
        },
        parameter_size: tag.details.parameter_size,
        quantization_level: tag.details.quantization_level,
        context_window_tokens,
        supports_tools,
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
    fn discovers_local_models_and_tool_capability() {
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
                    r#"{"models":[{"name":"qwen3-coder:latest","details":{"family":"qwen3","parameter_size":"8B","quantization_level":"Q4"}}]}"#
                } else {
                    r#"{"capabilities":["completion","tools"],"model_info":{"qwen3.context_length":32768}}"#
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
        assert!(discovery.models[0].supports_tools);
        assert_eq!(discovery.models[0].context_window_tokens, Some(32768));
    }
}
