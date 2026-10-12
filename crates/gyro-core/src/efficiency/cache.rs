//! Verified OpenAI Chat Completions controls, confined to the official endpoint.
//! https://developers.openai.com/api/docs/guides/prompt-caching (checked 2026-10-12).
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
pub fn apply(payload: &mut Value, endpoint: &url::Url, model: &str, enabled: bool) {
    if !enabled || endpoint.scheme() != "https" || endpoint.host_str() != Some("api.openai.com") {
        return;
    }
    let _measure =
        crate::timing::EfficiencyTimer::start(crate::timing::EfficiencyComponent::CacheControls);
    let stable = payload["messages"]
        .as_array()
        .map(|m| {
            m.iter()
                .filter(|v| matches!(v["role"].as_str(), Some("system" | "developer")))
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let prefix = json!({"instructions":stable,"tools":payload["tools"]});
    let key = format!(
        "gyro:{:x}",
        Sha256::digest(serde_json::to_vec(&prefix).unwrap_or_default())
    );
    payload["prompt_cache_key"] = json!(key);
    if ["gpt-5.6", "gpt-6"]
        .iter()
        .any(|prefix| model == *prefix || model.starts_with(&format!("{prefix}-")))
    {
        payload["prompt_cache_options"] = json!({"mode":"implicit","ttl":"30m"});
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unsupported_hosts_unchanged() {
        let mut p = json!({"messages":[]});
        apply(
            &mut p,
            &url::Url::parse("https://example.com/v1").unwrap(),
            "gpt-6",
            true,
        );
        assert!(p.get("prompt_cache_key").is_none());
    }
    #[test]
    fn task_does_not_change_key() {
        let mut a = json!({"messages":[{"role":"system","content":"stable"},{"role":"user","content":"first"}]});
        let mut b = a.clone();
        b["messages"][1]["content"] = json!("second");
        let url = url::Url::parse("https://api.openai.com/v1").unwrap();
        apply(&mut a, &url, "gpt-6", true);
        apply(&mut b, &url, "gpt-6", true);
        assert_eq!(a["prompt_cache_key"], b["prompt_cache_key"]);
        assert_eq!(a["prompt_cache_options"]["ttl"], "30m");
    }
}
