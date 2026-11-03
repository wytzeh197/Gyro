//! Verified cache controls, confined to the official endpoints they are documented for.
//! https://developers.openai.com/api/docs/guides/prompt-caching (checked 2026-10-12).
//! https://openrouter.ai/docs/features/prompt-caching (checked 2026-11-02).
use serde_json::{json, Value};
pub fn apply(payload: &mut Value, endpoint: &url::Url, model: &str, enabled: bool) {
    if !enabled || endpoint.scheme() != "https" {
        return;
    }
    let host = super::cache_plan::host_of(endpoint);
    let openrouter_claude = host == "openrouter.ai" && model.starts_with("anthropic/");
    if !openrouter_claude && !super::cache_plan::KEY_HOSTS.contains(&host) {
        return;
    }
    let _measure =
        crate::timing::EfficiencyTimer::start(crate::timing::EfficiencyComponent::CacheControls);
    if openrouter_claude {
        // Claude routes cache nothing unless asked. OpenRouter keeps this one
        // breakpoint on the last cacheable block as the conversation grows.
        payload["cache_control"] = json!({"type": "ephemeral"});
        return;
    }
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
            assert!(p.get("cache_control").is_none(), "{host}");
        }
    }

    #[test]
    fn openrouter_claude_routes_ask_for_automatic_caching() {
        let url = url::Url::parse("https://openrouter.ai/api/v1").unwrap();
        let mut p = json!({"messages": [{"role": "system", "content": "stable"}]});
        apply(&mut p, &url, "anthropic/claude-sonnet-5.5", true);
        assert_eq!(p["cache_control"], json!({"type": "ephemeral"}));
        assert!(p.get("prompt_cache_key").is_none());
        assert!(p.get("prompt_cache_options").is_none());
        assert_eq!(
            p["messages"][0],
            json!({"role": "system", "content": "stable"})
        );
    }

    #[test]
    fn the_openrouter_marker_stays_on_verified_routes() {
        for (endpoint, model, enabled) in [
            (
                "https://openrouter.ai/api/v1",
                "deepseek/deepseek-v4-pro",
                true,
            ),
            ("https://openrouter.ai/api/v1", "openai/gpt-6", true),
            (
                "https://openrouter.ai/api/v1",
                "anthropic/claude-sonnet-5.5",
                false,
            ),
            (
                "http://openrouter.ai/api/v1",
                "anthropic/claude-sonnet-5.5",
                true,
            ),
            (
                "https://api.deepseek.com/v1",
                "anthropic/claude-sonnet-5.5",
                true,
            ),
            (
                "https://api.mistral.ai/v1",
                "anthropic/claude-sonnet-5.5",
                true,
            ),
            (
                "https://example.com/v1",
                "anthropic/claude-sonnet-5.5",
                true,
            ),
        ] {
            let mut p = json!({"messages": []});
            apply(&mut p, &url::Url::parse(endpoint).unwrap(), model, enabled);
            assert!(p.get("cache_control").is_none(), "{endpoint} {model}");
        }
    }
}
