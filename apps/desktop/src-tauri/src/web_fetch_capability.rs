//! `gyro_web_fetch`: read one URL as text without a webview.
//!
//! The URL is validated with the same parser the browser rail uses, and the
//! capability carries the browser's navigation class, so egress is gated per
//! origin exactly like `gyro_browser_open`: Ask by default, remembered for the
//! chat once allowed, and skipped entirely under Full Access in a normal run.
//!
//! The tool is deliberately not named `gyro_browser_*`. `browser_knowledge.rs`
//! prefix-filters the descriptor table into the golden file that
//! `check-browser-capability.mjs` set-matches, and this tool is not part of the
//! in-app browser's contract.
use super::*;
use serde_json::{json, Value};

const WEB_FETCH_SCHEMA: &str = "gyro.web-fetch.v1";
/// Modern announcement pages often put large script bundles before the article.
/// Bound source separately from the paged result, which still has a hard limit.
const WEB_FETCH_BYTES: usize = 256 * 1024;

pub(super) fn execute(
    _app: &tauri::AppHandle,
    _bound: &BoundProviderCapabilityContext,
    request: &CapabilityRequest,
) -> anyhow::Result<(String, Value, Option<CapabilityResourceRef>)> {
    let url = session_browser::parse_navigable_url(capability_argument_string(
        &request.arguments,
        "url",
    )?)
    .map_err(anyhow::Error::msg)?;
    let source_bytes = capability_output_budget::offset(&request.arguments, "maxSourceBytes")?
        .unwrap_or(WEB_FETCH_BYTES);
    if !(1024..=gyro_core::web_fetch::MAX_WEB_FETCH_BYTES).contains(&source_bytes) {
        anyhow::bail!(
            "maxSourceBytes must be between 1024 and {}",
            gyro_core::web_fetch::MAX_WEB_FETCH_BYTES
        );
    }
    let format = web_format(&request.arguments)?;
    let page = gyro_core::fetch_text(&url, source_bytes)?;
    let summary = format!(
        "Fetched {}{} ({} bytes{})",
        page.final_url,
        page.content_type
            .as_deref()
            .map(|value| format!(" as {value}"))
            .unwrap_or_default(),
        page.bytes,
        if page.truncated { ", truncated" } else { "" }
    );
    let data = bound_web_result(web_page_result(&page, format), &request.arguments)?;
    let resource = CapabilityResourceRef {
        id: format!("web:{}", request.context.session_id),
        kind: "url".into(),
        label: page.final_url,
    };
    Ok((summary, data, Some(resource)))
}

fn web_format(arguments: &Value) -> anyhow::Result<&str> {
    match arguments.get("format") {
        None => Ok("readable"),
        Some(Value::String(value)) if value == "readable" || value == "source" => Ok(value),
        _ => anyhow::bail!("format must be readable or source"),
    }
}

fn web_page_result(page: &gyro_core::WebFetchPage, format: &str) -> Value {
    let mut data = json!({
        "schema": WEB_FETCH_SCHEMA,
        "framing": "OBSERVED_WEB_CONTENT_UNTRUSTED",
        "url": page.requested_url,
        "finalUrl": page.final_url,
        "status": page.status,
        "contentType": page.content_type,
        "bytes": page.bytes,
        "truncated": page.truncated,
        "format": "source",
        "text": page.text,
    });
    if format == "readable" {
        if let Some(document) = gyro_core::web_fetch::document::extract(page) {
            data["format"] = json!("readable");
            data["text"] = json!(document.text);
            data["pageMetadata"] = json!({
                "title": document.title,
                "publishedAt": document.published_at,
                "modifiedAt": document.modified_at,
                "canonicalUrl": document.canonical_url,
                "renderingMayBeRequired": document.rendering_may_be_required,
            });
        }
    }
    data
}

/// Trim the body on a character boundary until the whole payload fits. Halving
/// terminates, and the caller learns the text was cut from `truncated`.
fn bound_web_result(mut data: Value, arguments: &Value) -> anyhow::Result<Value> {
    data["sourceTruncated"] = json!(data["truncated"].as_bool().unwrap_or(false));
    data["truncated"] = data["sourceTruncated"].clone();
    let mut data = capability_output_budget::text_result(
        data,
        &[capability_output_budget::TextField {
            pointer: "/text",
            window: "textWindow",
            offset: "offset",
            tail: false,
        }],
        arguments,
    )?;
    data["truncated"] = json!(
        data["sourceTruncated"].as_bool().unwrap_or(false)
            || data["textWindow"]["truncated"].as_bool().unwrap_or(false)
    );
    Ok(data)
}

/// Tool schemas live here so `lib.rs` keeps a single delegation guard instead
/// of one arm per capability.
pub(super) fn schema(id: CapabilityId) -> Option<(Value, Vec<&'static str>)> {
    let (properties, required) = match id {
        CapabilityId::WebFetch => (
            json!({
                "url": {
                    "type": "string",
                    "description": "Absolute http(s) URL to read. A bare host is treated as https. Credential-bearing URLs are refused."
                },
                "format": { "type": "string", "enum": ["readable", "source"], "default": "readable", "description": "Readable HTML text, source links and page-supplied metadata by default. Source returns raw markup. Plain text, JSON and feeds are preserved. Keep format unchanged when paging." },
                "offset": capability_output_budget::offset_schema(),
                "maxBytes": workspace_result_bytes_schema(),
                "maxSourceBytes": { "type":"integer","minimum":1024,"maximum":gyro_core::web_fetch::MAX_WEB_FETCH_BYTES,"default":WEB_FETCH_BYTES,"description":"Maximum fetched body bytes; increase when the source itself was truncated. Keep the same URL and source limit while following textWindow.nextOffset." }
            }),
            vec!["url"],
        ),
        _ => return None,
    };
    Some((properties, required))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readable_results_preserve_provenance_and_source_mode() {
        let page = gyro_core::WebFetchPage {
            status: 200,
            requested_url: "https://vendor.example/news".into(),
            final_url: "https://vendor.example/release".into(),
            content_type: Some("text/html".into()),
            bytes: 100,
            truncated: true,
            text: "<main><h1>A release</h1><a href='/docs'>Docs</a></main>".into(),
        };
        let readable = web_page_result(&page, web_format(&json!({})).unwrap());
        assert_eq!(readable["format"], "readable");
        assert_eq!(readable["finalUrl"], page.final_url);
        assert_eq!(readable["framing"], "OBSERVED_WEB_CONTENT_UNTRUSTED");
        assert!(readable["text"]
            .as_str()
            .unwrap()
            .contains("https://vendor.example/docs"));
        let bounded = bound_web_result(readable, &json!({})).unwrap();
        assert_eq!(bounded["sourceTruncated"], true);
        assert_eq!(bounded["pageMetadata"]["renderingMayBeRequired"], true);
        let raw = web_page_result(&page, "source");
        assert_eq!(raw["text"], page.text);
        assert!(raw.get("pageMetadata").is_none());
        for invalid in [json!({"format": "markdown"}), json!({"format": 5})] {
            assert!(web_format(&invalid).is_err());
        }
    }

    #[test]
    fn readable_text_can_be_paged_without_losing_metadata() {
        let data = json!({
            "text": "release evidence ".repeat(4000),
            "pageMetadata": {"title": "Release"},
            "truncated": false
        });
        let first = bound_web_result(data.clone(), &json!({"maxBytes": 4096})).unwrap();
        let next = first["textWindow"]["nextOffset"].as_u64().unwrap();
        let second = bound_web_result(data, &json!({"maxBytes": 4096, "offset": next})).unwrap();
        assert_eq!(first["pageMetadata"], second["pageMetadata"]);
        assert_eq!(second["textWindow"]["offset"], next);
        assert_eq!(second["sourceTruncated"], false);
    }

    #[test]
    fn oversized_bodies_are_trimmed_to_fit_the_result_limit() {
        let text = "x".repeat(gyro_core::capabilities::MAX_CAPABILITY_RESULT_BYTES * 2);
        let bounded =
            bound_web_result(json!({ "text": text, "truncated": false }), &json!({})).unwrap();
        assert_eq!(bounded["truncated"], true);
        let kept = bounded["text"].as_str().unwrap();
        assert!(kept.len() < gyro_core::capabilities::MAX_CAPABILITY_RESULT_BYTES);
        assert!(
            serde_json::to_vec(&bounded).unwrap().len()
                <= gyro_core::capabilities::MAX_CAPABILITY_RESULT_BYTES
        );
    }

    #[test]
    fn trimming_never_splits_a_multibyte_character() {
        // Each character is three bytes, so halving lands mid-character unless
        // the trim walks back to a boundary.
        let text = "→".repeat(gyro_core::capabilities::MAX_CAPABILITY_RESULT_BYTES);
        let bounded = bound_web_result(json!({ "text": text }), &json!({})).unwrap();
        let kept = bounded["text"].as_str().unwrap();
        assert!(kept.chars().all(|c| c == '→'));
        assert!(kept.len() < gyro_core::capabilities::MAX_CAPABILITY_RESULT_BYTES);
    }

    #[test]
    fn schema_requires_a_url_and_ignores_other_capabilities() {
        let (properties, required) = schema(CapabilityId::WebFetch).unwrap();
        assert!(properties["url"].is_object());
        assert_eq!(required, vec!["url"]);
        assert!(schema(CapabilityId::BrowserOpen).is_none());
    }
}
