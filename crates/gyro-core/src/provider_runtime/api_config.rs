//! Config-backed provider classification and model image policy.
use super::{
    limits::PROVIDER_CHAT_INACTIVITY_TIMEOUT_SECS,
    support::load_config_blocking,
    types::{ProviderAdapterDescriptor, ProviderAdapterKind, ProviderChatRequest},
};
use crate::{
    is_openai_compatible_provider, provider_accepts_images, provider_descriptor, GyroConfig,
    GyroPaths, ProviderCapabilitySupport, ProviderExecutionKind,
};
/// What an endpoint speaking the OpenAI wire format runs as.
///
/// This is a plain HTTPS call Gyro makes itself, so the credential owner is the
/// SDK rather than a vendor CLI.
pub fn openai_compatible_adapter() -> ProviderAdapterDescriptor {
    ProviderAdapterDescriptor {
        kind: ProviderAdapterKind::OpenAiCompatible,
        runner: "openai-compatible-api",
        auth_owner: "provider-sdk",
        timeout_seconds: PROVIDER_CHAT_INACTIVITY_TIMEOUT_SECS,
    }
}

/// The `kind` a config entry declares for an id the static table cannot answer
/// for. Loading config is the only way to classify a hand-added provider.
pub fn declared_provider_kind(provider_id: &str) -> Option<String> {
    let paths = GyroPaths::for_current_user().ok()?;
    let config = GyroConfig::load(&paths).ok()?;
    config
        .model_providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .and_then(|provider| provider.kind.clone())
}

pub fn configured_capability_support(
    provider_id: &str,
) -> Result<ProviderCapabilitySupport, String> {
    let config = load_config_blocking()?;
    let kind = config
        .model_providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .and_then(|provider| provider.kind.as_deref());
    Ok(crate::provider_capability_support_with_kind(
        provider_id,
        kind,
    ))
}

/// Image support is model-specific for DeepSeek. Ollama vision is discovered
/// per installed model, so this shared check stays false and the Ollama runner
/// decides on its own. Every other provider, including a user-defined endpoint,
/// can receive images.
pub fn supports_images(request: &ProviderChatRequest) -> bool {
    if image_input_enabled(&request.provider_id, request.model_id.as_deref(), None) {
        return true;
    }
    // Known providers are decided above. Only an id with no table row needs
    // the config entry that names an OpenAI-compatible endpoint.
    if provider_descriptor(&request.provider_id).is_some()
        || provider_accepts_images(&request.provider_id)
    {
        return false;
    }
    image_input_enabled(
        &request.provider_id,
        request.model_id.as_deref(),
        declared_provider_kind(&request.provider_id).as_deref(),
    )
}

pub fn image_input_enabled(
    provider_id: &str,
    model_id: Option<&str>,
    declared_kind: Option<&str>,
) -> bool {
    if provider_id == "deepseek" {
        return matches!(
            model_id.map(str::trim),
            Some("deepseek-flash" | "deepseek-v4-flash" | "deepseek-v4-flash-vision-exp")
        );
    }
    if provider_id == "ollama" {
        return false;
    }
    if provider_accepts_images(provider_id) {
        return true;
    }
    declared_kind == Some(crate::OPENAI_COMPATIBLE_KIND)
}

pub fn provider_adapter_for(provider_id: &str) -> ProviderAdapterDescriptor {
    let kind = provider_descriptor(provider_id)
        .is_none()
        .then(|| declared_provider_kind(provider_id))
        .flatten();
    provider_adapter_with_kind(provider_id, kind.as_deref())
}
pub fn provider_adapter_with_kind(
    provider_id: &str,
    declared_kind: Option<&str>,
) -> ProviderAdapterDescriptor {
    let Some(descriptor) = provider_descriptor(provider_id) else {
        // A provider Gyro does not ship. An endpoint the user defined runs over
        // HTTPS; anything else stays readiness-only.
        if is_openai_compatible_provider(provider_id, declared_kind) {
            return openai_compatible_adapter();
        }
        return ProviderAdapterDescriptor {
            kind: ProviderAdapterKind::ReadinessOnly,
            runner: "readiness-only",
            auth_owner: "provider-owned",
            timeout_seconds: 0,
        };
    };
    let kind = match descriptor.execution_kind {
        ProviderExecutionKind::CodexCli => ProviderAdapterKind::OpenAiCodex,
        ProviderExecutionKind::ClaudeCode => ProviderAdapterKind::AnthropicClaude,
        ProviderExecutionKind::KimiAcp => ProviderAdapterKind::KimiAcp,
        ProviderExecutionKind::AntigravityCli => ProviderAdapterKind::AntigravityCli,
        ProviderExecutionKind::AcpCli => ProviderAdapterKind::KimiAcp,
        ProviderExecutionKind::OllamaApi => ProviderAdapterKind::Ollama,
        ProviderExecutionKind::OpenAiCompatibleApi => ProviderAdapterKind::OpenAiCompatible,
        ProviderExecutionKind::ReadinessOnly => ProviderAdapterKind::ReadinessOnly,
    };
    ProviderAdapterDescriptor {
        kind,
        runner: descriptor.runner,
        auth_owner: descriptor.auth_owner,
        timeout_seconds: if kind == ProviderAdapterKind::ReadinessOnly {
            0
        } else {
            super::limits::PROVIDER_CHAT_INACTIVITY_TIMEOUT_SECS
        },
    }
}

pub fn fallback_context_window(provider_id: &str, model_id: Option<&str>) -> Option<u64> {
    let model_id = model_id.map(str::trim).unwrap_or_default();
    let window = match provider_id {
        // Codex defaults differ from the API maxima. Runtime reports win.
        // Signed-in catalogs serve 500K for GPT-6.1 Sol. The logged-out
        // bundled catalog still lists 272K for that slug.
        "openai" => match model_id {
            "gpt-6.1-sol" => 500_000,
            "gpt-5.4-mini" => 400_000,
            "" | "gpt-6-astra" | "gpt-6-sol" | "gpt-6-luna" | "gpt-5.6-sol" | "gpt-5.6-terra"
            | "gpt-5.6-luna" | "gpt-5.5" | "gpt-5.4" => 272_000,
            _ => return None,
        },
        "anthropic" => match model_id {
            // Opus 4.7 and later have native 1M context, without a suffix.
            // Explicit runtime restrictions (for example disabling 1M) win.
            "claude-haiku-4-5" => 200_000,
            "" | "claude-fable-5-1" | "claude-fable-5" | "claude-opus-5-5" | "claude-opus-5"
            | "claude-opus-4-8" | "claude-opus-5-5-1m" | "claude-opus-5-1m"
            | "claude-opus-4-8-1m" | "claude-sonnet-5-5" | "claude-sonnet-5"
            | "claude-haiku-5-5" => 1_000_000,
            _ => return None,
        },
        // K3 and K3.1 Pro entitlements depend on the plan; retain the Plus
        // baseline until the runtime reports the session's provisioned window.
        // Highspeed is offered only on Pro and Allegretto, at 1,048,576.
        "kimi" => match model_id {
            "" | "k3" | "k3.1-pro" => 262_144,
            "k3.1-pro-highspeed" => 1_048_576,
            _ => return None,
        },
        "gemini" if matches!(model_id, "" | "gemini-default" | "gemini-3.8-flash") => 1_048_576,
        // Grok Build's served context_window is 256K. 500K is the optional
        // larger window on that CLI, not this baseline. The public API is a
        // different connection and is not this table.
        "xai" => match model_id {
            "" | "grok-4.7" | "grok-4.7-build-fast" | "grok-4.6" | "grok-4.5" => 256_000,
            _ => return None,
        },
        "deepseek" => match model_id {
            "deepseek-flash" | "deepseek-v4-pro" => 1_000_000,
            _ => return None,
        },
        "mistral" => match model_id {
            "mistral-medium-latest" | "mistral-large-latest" | "mistral-small-latest" => 256_000,
            "codestral-latest" => 128_000,
            _ => return None,
        },
        "openrouter" => match model_id {
            "anthropic/claude-sonnet-5" | "anthropic/claude-opus-5" | "qwen/qwen3.8-max-0902" => {
                1_000_000
            }
            "openai/gpt-6-astra" => 1_050_000,
            "google/gemini-3.8-flash"
            | "deepseek/deepseek-v4.1-flash"
            | "moonshotai/kimi-k3"
            | "moonshotai/kimi-k3.1-pro"
            | "z-ai/glm-5.3" => 1_048_576,
            "x-ai/grok-4.7" | "x-ai/grok-4.6" => 500_000,
            "meta-llama/llama-3.3-70b-instruct" => 131_072,
            _ => return None,
        },
        _ => return None,
    };
    Some(window)
}
