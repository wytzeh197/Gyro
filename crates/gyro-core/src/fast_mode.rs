use crate::config::GyroConfig;

/// Keep this model-specific: a fast model name does not imply a Fast mode.
/// OpenAI entries are verified against Codex model metadata; Claude entries
/// follow https://code.claude.com/docs/en/fast-mode.
pub fn supports_fast_mode(provider_id: &str, model_id: Option<&str>) -> bool {
    let Some(model_id) = model_id else {
        return false;
    };
    let model_id = model_id.trim().to_ascii_lowercase();
    match provider_id {
        "openai" => matches!(
            model_id.as_str(),
            "gpt-6.1-sol"
                | "gpt-6-astra"
                | "gpt-6-sol"
                | "gpt-6-luna"
                | "gpt-5.6-sol"
                | "gpt-5.6-terra"
                | "gpt-5.6-luna"
                | "gpt-5.5"
        ),
        "anthropic" => matches!(
            model_id.as_str(),
            "claude-opus-5-5" | "claude-opus-5" | "claude-opus-4-8"
        ),
        _ => false,
    }
}

pub fn enabled(config: &GyroConfig, provider_id: &str, model_id: Option<&str>) -> bool {
    supports_fast_mode(provider_id, model_id)
        && model_id.is_some_and(|model| {
            let key = format!("{provider_id}:{}", model.trim().to_ascii_lowercase());
            config.fast_mode_models.get(&key) == Some(&true)
        })
}

pub fn codex_service_tier(config: &GyroConfig, model_id: Option<&str>) -> &'static str {
    if enabled(config, "openai", model_id) {
        "priority"
    } else {
        "default"
    }
}

/// Explicit standard settings also override a provider CLI's saved Fast mode.
/// This prevents Claude from switching an unsupported selected model to Opus.
pub fn cli_args(config: &GyroConfig, provider_id: &str, model_id: Option<&str>) -> Vec<String> {
    match provider_id {
        "openai" => vec![
            "-c".into(),
            format!("service_tier=\"{}\"", codex_service_tier(config, model_id)),
            "-c".into(),
            "features.fast_mode=true".into(),
        ],
        "anthropic" => vec![
            "--settings".into(),
            serde_json::json!({ "fastMode": enabled(config, provider_id, model_id) }).to_string(),
        ],
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fast_mode_is_model_and_provider_specific_and_defaults_off() {
        let mut config = GyroConfig::default();
        assert!(!enabled(&config, "anthropic", Some("claude-opus-5")));
        config
            .fast_mode_models
            .insert("anthropic:claude-opus-5".into(), true);
        config
            .fast_mode_models
            .insert("anthropic:claude-sonnet-5".into(), true);
        config
            .fast_mode_models
            .insert("openrouter:claude-opus-5".into(), true);
        assert!(enabled(&config, "anthropic", Some("claude-opus-5")));
        assert!(!enabled(&config, "anthropic", Some("claude-opus-4-8")));
        assert!(!enabled(&config, "anthropic", Some("claude-sonnet-5")));
        assert!(!enabled(&config, "openrouter", Some("claude-opus-5")));
        assert!(!supports_fast_mode("anthropic", Some("claude-opus-4-7")));
        assert!(!supports_fast_mode("openai", Some("gpt-unknown")));
        assert!(!supports_fast_mode("xai", Some("grok-4.7")));
    }

    #[test]
    fn native_settings_round_trip_and_apply_to_real_cli_options() {
        let mut config = GyroConfig::default();
        config
            .fast_mode_models
            .insert("openai:gpt-6.1-sol".into(), true);
        config
            .fast_mode_models
            .insert("anthropic:claude-opus-5".into(), true);
        let raw = serde_json::to_value(&config).unwrap();
        assert_eq!(raw["fastModeModels"]["openai:gpt-6.1-sol"], true);
        let restored: GyroConfig = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(
            codex_service_tier(&restored, Some("gpt-6.1-sol")),
            "priority"
        );
        assert_eq!(
            codex_service_tier(&restored, Some("gpt-5.6-sol")),
            "default"
        );
        let args = cli_args(&restored, "anthropic", Some("claude-opus-5"));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&args[1]).unwrap()["fastMode"],
            true
        );
        let args = cli_args(&restored, "anthropic", Some("claude-sonnet-5"));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&args[1]).unwrap()["fastMode"],
            false
        );
        let mut old = raw;
        old.as_object_mut().unwrap().remove("fastModeModels");
        let old: GyroConfig = serde_json::from_value(old).unwrap();
        assert!(old.fast_mode_models.is_empty());
    }
}
