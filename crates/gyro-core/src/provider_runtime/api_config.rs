//! Config-backed provider classification and model image policy.
use super::{
    limits::PROVIDER_CHAT_INACTIVITY_TIMEOUT_SECS,
    support::load_config_blocking,
    types::{ProviderAdapterDescriptor, ProviderAdapterKind, ProviderChatRequest},
};
use crate::{
    provider_accepts_images, provider_descriptor, GyroConfig, GyroPaths, ProviderCapabilitySupport,
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
