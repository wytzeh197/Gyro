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
/// The capability result has a hard 128 KiB limit, so the fetch asks for well
/// under it and still trims if JSON escaping inflates the payload.
const WEB_FETCH_BYTES: usize = 64 * 1024;

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
    let page = gyro_core::fetch_text(&url, WEB_FETCH_BYTES)?;
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
    let data = bound_web_result(json!({
        "schema": WEB_FETCH_SCHEMA,
        "url": page.requested_url,
        "finalUrl": page.final_url,
        "status": page.status,
        "contentType": page.content_type,
        "bytes": page.bytes,
        "truncated": page.truncated,
        "text": page.text,
    }))?;
    let resource = CapabilityResourceRef {
        id: format!("web:{}", request.context.session_id),
        kind: "url".into(),
        label: page.final_url,
    };
    Ok((summary, data, Some(resource)))
}

/// Trim the body on a character boundary until the whole payload fits. Halving
/// terminates, and the caller learns the text was cut from `truncated`.
fn bound_web_result(mut data: Value) -> anyhow::Result<Value> {
    while serde_json::to_vec(&data)?.len() > gyro_core::capabilities::MAX_CAPABILITY_RESULT_BYTES {
        let Some(text) = data.get("text").and_then(Value::as_str) else {
            break;
        };
        if text.is_empty() {
            break;
        }
        let mut keep = text.len() / 2;
        while keep > 0 && !text.is_char_boundary(keep) {
            keep -= 1;
        }
        data["text"] = json!(text[..keep].to_string());
        data["truncated"] = json!(true);
    }
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
                }
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
    fn oversized_bodies_are_trimmed_to_fit_the_result_limit() {
        let text = "x".repeat(gyro_core::capabilities::MAX_CAPABILITY_RESULT_BYTES * 2);
        let bounded = bound_web_result(json!({ "text": text, "truncated": false })).unwrap();
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
        let bounded = bound_web_result(json!({ "text": text })).unwrap();
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
