//! Confirmed model retirements for Gyro's integrations, shared with the picker.
use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Deserialize)]
struct Retirements {
    retirements: Vec<Retirement>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Retirement {
    provider_id: String,
    model_ids: Vec<String>,
    scope: String,
    replacement: String,
}

/// API-key Codex sessions retain models retired only from ChatGPT sign-in.
/// Unknown custom endpoints and independently hosted OpenRouter models remain usable.
pub fn retired_model_replacement(
    provider_id: &str,
    model_id: &str,
    uses_api_key: bool,
) -> Option<&'static str> {
    static FACTS: OnceLock<Retirements> = OnceLock::new();
    FACTS
        .get_or_init(|| {
            serde_json::from_str(include_str!(
                "../../../packages/ui/src/model-retirements.json"
            ))
            .expect("bundled model retirements must parse")
        })
        .retirements
        .iter()
        .find(|entry| {
            entry.provider_id == provider_id
                && entry.model_ids.iter().any(|id| id == model_id.trim())
                && (entry.scope != "codex-chatgpt" || !uses_api_key)
        })
        .map(|entry| entry.replacement.as_str())
}

/// Stop known retired API requests before a provider or tool run is started.
/// Sign-in-only retirements are filtered by the picker; Codex validates its
/// actual authentication route and retains API-key access to those models.
pub fn validate_provider_model(provider_id: &str, model_id: Option<&str>) -> anyhow::Result<()> {
    if let Some(model) = model_id {
        if let Some(replacement) = retired_model_replacement(provider_id, model, true) {
            anyhow::bail!(
                "{provider_id} retired model {model}. Select {replacement} or another available model."
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retired_models_are_scoped_to_the_provider_and_authentication_route() {
        for model in ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"] {
            assert!(retired_model_replacement("openai", model, false).is_some());
            assert_eq!(retired_model_replacement("openai", model, true), None);
            assert!(validate_provider_model("openai", Some(model)).is_ok());
        }
        for model in [
            "deepseek-chat",
            "deepseek-reasoner",
            "deepseek-v4-flash",
            "deepseek-v4-flash-vision-exp",
        ] {
            assert_eq!(
                retired_model_replacement("deepseek", model, true),
                Some("deepseek-flash")
            );
            assert!(validate_provider_model("deepseek", Some(model)).is_err());
            assert!(validate_provider_model("custom:local", Some(model)).is_ok());
        }
        assert!(
            validate_provider_model("openrouter", Some("google/gemini-3-pro-preview")).is_err()
        );
        assert!(validate_provider_model("openrouter", Some("deepseek/deepseek-chat")).is_ok());
        assert!(validate_provider_model("openai", Some("gpt-5.5")).is_ok());
        assert!(validate_provider_model("anthropic", Some("claude-haiku-4-5")).is_ok());
        assert!(validate_provider_model("deepseek", Some("deepseek-v4-pro")).is_ok());
    }
}
