//! Bounded, redacted HTTPS fetch for the model-facing `gyro_web_fetch` tool.
//!
//! This is the shared HTTPS stack the provider adapters use: the same `ureq`
//! agent shape and the same retry wrapper in `provider_retry`. It exists so a
//! model can read a URL without a webview, and it is deliberately narrow — GET
//! only, text-ish content types only, a hard byte ceiling, secret redaction,
//! and a bounded redirect chain whose final URL is always reported.
use crate::security::redact_secrets;
use anyhow::{anyhow, Result};
use std::io::Read;
use std::time::Duration;
use url::Url;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// A redirect chain is followed, unlike the provider adapters which refuse one
/// outright because they carry a credential. Here there is no credential to
/// leak, and http→https promotion is ordinary; the final URL is reported so a
/// reviewer can always see where the request landed.
const MAX_REDIRECTS: u32 = 5;
/// Absolute ceiling for one fetch. The capability asks for less than this.
pub const MAX_WEB_FETCH_BYTES: usize = 512 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct WebFetchPage {
    pub status: u16,
    pub requested_url: String,
    pub final_url: String,
    pub content_type: Option<String>,
    /// Bytes of body kept, before redaction.
    pub bytes: usize,
    pub truncated: bool,
    pub text: String,
}

/// Fetch a text-like document. The caller has already decided that this URL is
/// one the user allows; this function still refuses any scheme but http(s).
pub fn fetch_text(url: &Url, max_bytes: usize) -> Result<WebFetchPage> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(anyhow!("web fetch needs an http or https URL"));
    }
    let max_bytes = max_bytes.clamp(1, MAX_WEB_FETCH_BYTES);
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout_read(REQUEST_TIMEOUT)
        .timeout_write(REQUEST_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .redirects(MAX_REDIRECTS)
        .build();
    let response =
        crate::provider_retry::http_response(&crate::CancellationToken::default(), || {
            agent.get(url.as_str()).call()
        })
        .map_err(http_error)?;
    let status = response.status();
    let final_url = response.get_url().to_string();
    let content_type = response
        .header("content-type")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(value) = content_type.as_deref() {
        if !content_type_is_text(value) {
            return Err(anyhow!(
                "{final_url} returned {value}; gyro_web_fetch only reads text, JSON, XML, or JavaScript"
            ));
        }
    }
    // Read one byte past the ceiling so truncation is reported, not guessed.
    let mut bytes = Vec::with_capacity(max_bytes.min(64 * 1024));
    response
        .into_reader()
        .take(max_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| anyhow!("could not read the response body: {error}"))?;
    let truncated = bytes.len() > max_bytes;
    bytes.truncate(max_bytes);
    let kept = bytes.len();
    let text = redact_secrets(&String::from_utf8_lossy(&bytes));
    Ok(WebFetchPage {
        status,
        requested_url: url.to_string(),
        final_url,
        content_type,
        bytes: kept,
        truncated,
        text,
    })
}

fn content_type_is_text(value: &str) -> bool {
    let essence = value
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    essence.starts_with("text/")
        || essence == "application/json"
        || essence == "application/x-ndjson"
        || essence == "application/xml"
        || essence == "application/javascript"
        || essence == "application/x-javascript"
        || essence.ends_with("+json")
        || essence.ends_with("+xml")
}

fn http_error(error: ureq::Error) -> anyhow::Error {
    match error {
        ureq::Error::Status(status, response) => {
            let location = response
                .header("location")
                .map(|value| format!(" (redirect to {value})"))
                .unwrap_or_default();
            anyhow!("the server returned HTTP {status}{location}")
        }
        ureq::Error::Transport(error) => anyhow!("could not reach the server: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;

    /// Serve one canned response, then stop. Enough to exercise the client
    /// without a network dependency in the test suite.
    fn serve_once(response: Vec<u8>) -> (Url, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut request = [0u8; 2048];
                let _ = stream.read(&mut request);
                let _ = stream.write_all(&response);
                let _ = stream.flush();
            }
        });
        (
            Url::parse(&format!("http://{address}/page")).unwrap(),
            handle,
        )
    }

    fn text_response(content_type: &str, body: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    #[test]
    fn fetch_returns_redacted_text_and_reports_the_final_url() {
        let (url, server) = serve_once(text_response(
            "text/plain; charset=utf-8",
            "hello OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456",
        ));
        let page = fetch_text(&url, MAX_WEB_FETCH_BYTES).unwrap();
        server.join().unwrap();
        assert_eq!(page.status, 200);
        assert_eq!(page.requested_url, url.to_string());
        assert_eq!(page.final_url, url.to_string());
        assert_eq!(
            page.content_type.as_deref(),
            Some("text/plain; charset=utf-8")
        );
        assert!(page.text.contains("hello"), "{}", page.text);
        assert!(page.text.contains("[REDACTED]"), "{}", page.text);
        assert!(!page.text.contains("sk-abcdefghijklmnopqrstuvwxyz123456"));
        assert!(!page.truncated);
    }

    #[test]
    fn fetch_truncates_a_body_past_the_ceiling_and_says_so() {
        let body = "a".repeat(500);
        let (url, server) = serve_once(text_response("text/plain", &body));
        let page = fetch_text(&url, 64).unwrap();
        server.join().unwrap();
        assert_eq!(page.bytes, 64);
        assert!(page.truncated);
        assert_eq!(page.text.chars().count(), 64);
    }

    #[test]
    fn fetch_refuses_a_binary_content_type() {
        let (url, server) = serve_once(text_response("application/pdf", "%PDF-1.7"));
        let error = fetch_text(&url, MAX_WEB_FETCH_BYTES)
            .unwrap_err()
            .to_string();
        server.join().unwrap();
        assert!(error.contains("only reads text"), "{error}");
    }

    #[test]
    fn fetch_refuses_a_non_http_scheme_before_any_request() {
        let url = Url::parse("file:///etc/passwd").unwrap();
        let error = fetch_text(&url, MAX_WEB_FETCH_BYTES)
            .unwrap_err()
            .to_string();
        assert!(error.contains("http or https"), "{error}");
    }

    #[test]
    fn text_content_types_are_recognised_by_essence() {
        for value in [
            "text/html",
            "text/html; charset=UTF-8",
            "application/json",
            "application/ld+json",
            "application/atom+xml",
            "application/javascript",
        ] {
            assert!(content_type_is_text(value), "{value}");
        }
        for value in [
            "application/pdf",
            "image/png",
            "application/octet-stream",
            "font/woff2",
        ] {
            assert!(!content_type_is_text(value), "{value}");
        }
    }
}
