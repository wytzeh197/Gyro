//! Verified OpenAI Chat Completions controls, confined to the official endpoint.
//! https://developers.openai.com/api/docs/guides/prompt-caching (checked 2026-10-12).
use serde_json::{json, Value};
pub fn apply(payload: &mut Value, endpoint: &url::Url, model: &str, enabled: bool) {
    if !enabled
        || endpoint.scheme() != "https"
        || !super::cache_plan::KEY_HOSTS.contains(&super::cache_plan::host_of(endpoint))
    {
        return;
    }
    let _measure =
        crate::timing::EfficiencyTimer::start(crate::timing::EfficiencyComponent::CacheControls);
    payload["prompt_cache_key"] = json!(super::cache_plan::openai_prefix_key(payload));
    if let Some(options) = super::cache_plan::openai_cache_options(model) {
        payload["prompt_cache_options"] = options;
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

    /// Route-level proof that moving the derivation into `cache_plan` did not move the wire bytes.
    /// If this ever fails, every prompt cache the fleet holds goes cold on the next request.
    #[test]
    fn key_is_byte_identical_to_the_legacy_derivation() {
        use sha2::{Digest, Sha256};
        let mut p = json!({
            "messages": [
                {"role": "system", "content": "stable"},
                {"role": "developer", "content": "also stable"},
                {"role": "user", "content": "turn"}
            ],
            "tools": [{"type": "function", "function": {"name": "t"}}]
        });
        let url = url::Url::parse("https://api.openai.com/v1").unwrap();
        apply(&mut p, &url, "gpt-6", true);
        let stable: Vec<Value> = p["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| matches!(v["role"].as_str(), Some("system" | "developer")))
            .cloned()
            .collect();
        let legacy = format!(
            "gyro:{:x}",
            Sha256::digest(
                serde_json::to_vec(&json!({"instructions":stable,"tools":p["tools"]}))
                    .unwrap_or_default()
            )
        );
        assert_eq!(p["prompt_cache_key"], json!(legacy));
    }

    #[test]
    fn options_keep_the_same_model_prefixes() {
        let url = url::Url::parse("https://api.openai.com/v1").unwrap();
        for (model, shaped) in [
            ("gpt-6", true),
            ("gpt-6-mini", true),
            ("gpt-5.6", true),
            ("gpt-5.6-turbo", true),
            ("gpt-4o", false),
            ("gpt-5", false),
        ] {
            let mut p = json!({"messages": []});
            apply(&mut p, &url, model, true);
            assert_eq!(p.get("prompt_cache_options").is_some(), shaped, "{model}");
        }
    }

    #[test]
    fn plain_http_is_never_shaped() {
        let mut p = json!({"messages": []});
        apply(
            &mut p,
            &url::Url::parse("http://api.openai.com/v1").unwrap(),
            "gpt-6",
            true,
        );
        assert!(p.get("prompt_cache_key").is_none());
    }

    #[test]
    fn disabled_leaves_the_body_alone() {
        let mut p = json!({"messages": []});
        apply(
            &mut p,
            &url::Url::parse("https://api.openai.com/v1").unwrap(),
            "gpt-6",
            false,
        );
        assert!(p.get("prompt_cache_key").is_none());
        assert!(p.get("prompt_cache_options").is_none());
    }

    #[test]
    fn compatible_hosts_gain_no_cache_field() {
        for host in [
            "https://api.deepseek.com/v1",
            "https://api.mistral.ai/v1",
            "https://openrouter.ai/api/v1",
        ] {
            let mut p = json!({"messages": [{"role": "system", "content": "stable"}]});
            apply(&mut p, &url::Url::parse(host).unwrap(), "gpt-6", true);
            assert!(p.get("prompt_cache_key").is_none(), "{host}");
            assert!(p.get("prompt_cache_options").is_none(), "{host}");
        }
    }
}
