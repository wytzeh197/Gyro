use crate::config::ModelProviderConfig;
use serde::{Deserialize, Serialize};

/// Provider ids for endpoints the user defines themselves.
///
/// A custom provider cannot live in the static table below because its id is
/// chosen at runtime, so the prefix is what identifies it.
pub const CUSTOM_PROVIDER_PREFIX: &str = "custom:";

/// Config `kind` value that selects the direct HTTPS runner.
pub const OPENAI_COMPATIBLE_KIND: &str = "openai-compatible";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderExecutionKind {
    CodexCli,
    ClaudeCode,
    KimiAcp,
    AcpCli,
    OllamaApi,
    OpenAiCompatibleApi,
    ReadinessOnly,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderSupportTier {
    Supported,
    Experimental,
    ReadinessOnly,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderHealthKind {
    CodexCli,
    ClaudeCli,
    KimiAcp,
    Environment,
    CursorCli,
    OpenCodeCli,
    OllamaApi,
    OpenAiCompatibleApi,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProviderDescriptor {
    pub id: &'static str,
    pub execution_kind: ProviderExecutionKind,
    pub health_kind: ProviderHealthKind,
    pub runner: &'static str,
    pub auth_owner: &'static str,
    pub supports_approvals: bool,
    pub supports_images: bool,
    pub supports_resume: bool,
    pub supports_usage: bool,
    pub support_tier: ProviderSupportTier,
}

const PROVIDERS: &[ProviderDescriptor] = &[
    ProviderDescriptor {
        id: "openai",
        execution_kind: ProviderExecutionKind::CodexCli,
        health_kind: ProviderHealthKind::CodexCli,
        runner: "codex-cli",
        auth_owner: "chatgpt-local-codex-login",
        supports_approvals: true,
        supports_images: true,
        supports_resume: true,
        supports_usage: true,
        support_tier: ProviderSupportTier::Supported,
    },
    ProviderDescriptor {
        id: "anthropic",
        execution_kind: ProviderExecutionKind::ClaudeCode,
        health_kind: ProviderHealthKind::ClaudeCli,
        runner: "claude-code",
        auth_owner: "anthropic-local-claude-login",
        supports_approvals: true,
        supports_images: true,
        supports_resume: true,
        // Streamed plan windows stored for display (no live quota command).
        supports_usage: true,
        support_tier: ProviderSupportTier::Supported,
    },
    ProviderDescriptor {
        id: "kimi",
        execution_kind: ProviderExecutionKind::KimiAcp,
        health_kind: ProviderHealthKind::KimiAcp,
        runner: "kimi-acp",
        auth_owner: "kimi-code-local-login",
        supports_approvals: true,
        supports_images: true,
        supports_resume: true,
        // Usage windows scraped live from `kimi acp` `/usage`.
        supports_usage: true,
        support_tier: ProviderSupportTier::Supported,
    },
    ProviderDescriptor {
        id: "xai",
        execution_kind: ProviderExecutionKind::AcpCli,
        health_kind: ProviderHealthKind::KimiAcp,
        runner: "grok-acp",
        auth_owner: "xai-local-grok-login",
        supports_approvals: true,
        supports_images: true,
        supports_resume: true,
        // Weekly credit window from Grok ACP `_x.ai/billing`.
        supports_usage: true,
        support_tier: ProviderSupportTier::Supported,
    },
    ProviderDescriptor {
        id: "gemini",
        execution_kind: ProviderExecutionKind::AcpCli,
        health_kind: ProviderHealthKind::KimiAcp,
        runner: "gemini-acp",
        auth_owner: "google-local-gemini-login",
        supports_approvals: true,
        supports_images: true,
        supports_resume: true,
        supports_usage: false,
        support_tier: ProviderSupportTier::Supported,
    },
    ProviderDescriptor {
        id: "ollama",
        execution_kind: ProviderExecutionKind::OllamaApi,
        health_kind: ProviderHealthKind::OllamaApi,
        runner: "ollama-api",
        auth_owner: "local-ollama-runtime",
        supports_approvals: true,
        supports_images: false,
        supports_resume: true,
        supports_usage: false,
        support_tier: ProviderSupportTier::Supported,
    },
    ProviderDescriptor {
        id: "cursor",
        execution_kind: ProviderExecutionKind::AcpCli,
        health_kind: ProviderHealthKind::CursorCli,
        runner: "cursor-acp",
        auth_owner: "provider-cli",
        supports_approvals: true,
        supports_images: false,
        supports_resume: true,
        supports_usage: false,
        support_tier: ProviderSupportTier::Experimental,
    },
    ProviderDescriptor {
        id: "opencode",
        execution_kind: ProviderExecutionKind::AcpCli,
        health_kind: ProviderHealthKind::OpenCodeCli,
        runner: "opencode-acp",
        auth_owner: "provider-cli",
        supports_approvals: true,
        supports_images: false,
        supports_resume: true,
        supports_usage: false,
        support_tier: ProviderSupportTier::Experimental,
    },
    // API-key providers that speak the OpenAI wire format directly. Nothing
    // here is bespoke: the descriptor is data the shared HTTPS runner reads, so
    // a fourth preset stays a table entry rather than a new code path.
    ProviderDescriptor {
        id: "deepseek",
        execution_kind: ProviderExecutionKind::OpenAiCompatibleApi,
        health_kind: ProviderHealthKind::OpenAiCompatibleApi,
        runner: "openai-compatible-api",
        auth_owner: "provider-sdk",
        supports_approvals: true,
        // Flash supports image input; the runner checks the selected model.
        supports_images: true,
        supports_resume: true,
        // Token spend lands in the local ledger; there is no plan-window API.
        supports_usage: false,
        support_tier: ProviderSupportTier::Experimental,
    },
    ProviderDescriptor {
        id: "mistral",
        execution_kind: ProviderExecutionKind::OpenAiCompatibleApi,
        health_kind: ProviderHealthKind::OpenAiCompatibleApi,
        runner: "openai-compatible-api",
        auth_owner: "provider-sdk",
        supports_approvals: true,
        supports_images: false,
        supports_resume: true,
        supports_usage: false,
        support_tier: ProviderSupportTier::Experimental,
    },
    ProviderDescriptor {
        id: "openrouter",
        execution_kind: ProviderExecutionKind::OpenAiCompatibleApi,
        health_kind: ProviderHealthKind::OpenAiCompatibleApi,
        runner: "openai-compatible-api",
        auth_owner: "provider-sdk",
        supports_approvals: true,
        supports_images: false,
        supports_resume: true,
        supports_usage: false,
        support_tier: ProviderSupportTier::Experimental,
    },
];

pub fn provider_registry() -> &'static [ProviderDescriptor] {
    PROVIDERS
}

pub fn provider_descriptor(provider_id: &str) -> Option<&'static ProviderDescriptor> {
    PROVIDERS.iter().find(|provider| provider.id == provider_id)
}

pub fn provider_is_executable(provider_id: &str) -> bool {
    provider_descriptor(provider_id)
        .is_some_and(|provider| provider.execution_kind != ProviderExecutionKind::ReadinessOnly)
}

/// True for a provider the user defined rather than one Gyro ships.
pub fn is_custom_provider_id(provider_id: &str) -> bool {
    provider_id.starts_with(CUSTOM_PROVIDER_PREFIX)
}

/// True when this provider runs through the shared OpenAI-compatible client.
///
/// The `custom:` prefix answers for user-defined endpoints; `kind` covers an
/// entry that names an endpoint without using the prefix.
pub fn is_openai_compatible_provider(provider_id: &str, kind: Option<&str>) -> bool {
    is_custom_provider_id(provider_id) || kind == Some(OPENAI_COMPATIBLE_KIND)
}

/// The execution kind for a configured provider.
///
/// [`provider_descriptor`] can only answer for the ids Gyro ships, so anything
/// that decides how to *run* a provider has to resolve through the config entry
/// — a custom provider has no table row to look up.
pub fn execution_kind_for(config: &ModelProviderConfig) -> ProviderExecutionKind {
    if is_openai_compatible_provider(&config.id, config.kind.as_deref()) {
        return ProviderExecutionKind::OpenAiCompatibleApi;
    }
    provider_descriptor(&config.id)
        .map(|descriptor| descriptor.execution_kind)
        .unwrap_or(ProviderExecutionKind::ReadinessOnly)
}

/// Whether a configured provider can run a chat.
///
/// The id-only [`provider_is_executable`] cannot answer for a custom provider,
/// which has no table row; callers holding a config entry must use this.
pub fn provider_is_executable_for(config: &ModelProviderConfig) -> bool {
    execution_kind_for(config) != ProviderExecutionKind::ReadinessOnly
}

/// The health probe for a configured provider, by id and config `kind`.
pub fn health_kind_for(provider_id: &str, kind: Option<&str>) -> Option<ProviderHealthKind> {
    if is_openai_compatible_provider(provider_id, kind) {
        return Some(ProviderHealthKind::OpenAiCompatibleApi);
    }
    provider_descriptor(provider_id).map(|descriptor| descriptor.health_kind)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(id: &str, kind: Option<&str>) -> ModelProviderConfig {
        ModelProviderConfig {
            id: id.into(),
            display_name: id.into(),
            base_url: Some("https://gateway.example.com/v1".into()),
            api_key_ref: String::new(),
            enabled: true,
            default_model_id: None,
            kind: kind.map(str::to_string),
            model_ids: Vec::new(),
        }
    }

    #[test]
    fn executable_registry_includes_acp_providers_and_excludes_readiness_only_providers() {
        assert!(provider_is_executable("openai"));
        assert!(provider_is_executable("anthropic"));
        assert!(provider_is_executable("kimi"));
        assert!(provider_is_executable("xai"));
        assert!(provider_is_executable("gemini"));
        assert!(provider_is_executable("ollama"));
        assert!(provider_is_executable("cursor"));
        assert!(provider_is_executable("opencode"));
        assert!(provider_is_executable("deepseek"));
        assert!(provider_is_executable("mistral"));
        assert!(provider_is_executable("openrouter"));
        assert_eq!(
            provider_descriptor("kimi").unwrap().execution_kind,
            ProviderExecutionKind::KimiAcp
        );
        assert_eq!(
            provider_descriptor("gemini").unwrap().execution_kind,
            ProviderExecutionKind::AcpCli
        );
        assert_eq!(
            provider_descriptor("deepseek").unwrap().execution_kind,
            ProviderExecutionKind::OpenAiCompatibleApi
        );
    }

    #[test]
    fn resolves_custom_and_declared_providers_to_the_https_runner() {
        // A user-defined endpoint has no table row, so the prefix is what
        // decides how it runs.
        assert_eq!(
            execution_kind_for(&config("custom:my-gateway", None)),
            ProviderExecutionKind::OpenAiCompatibleApi
        );
        // An entry may also declare the runner explicitly.
        assert_eq!(
            execution_kind_for(&config("my-gateway", Some(OPENAI_COMPATIBLE_KIND))),
            ProviderExecutionKind::OpenAiCompatibleApi
        );
        assert_eq!(
            execution_kind_for(&config("deepseek", None)),
            ProviderExecutionKind::OpenAiCompatibleApi
        );
        assert_eq!(
            execution_kind_for(&config("ollama", None)),
            ProviderExecutionKind::OllamaApi
        );
        // An unknown id that declares nothing is not a runner.
        assert_eq!(
            execution_kind_for(&config("mystery", None)),
            ProviderExecutionKind::ReadinessOnly
        );
    }

    #[test]
    fn health_probe_follows_the_same_resolution_as_execution() {
        assert_eq!(
            health_kind_for("custom:my-gateway", None),
            Some(ProviderHealthKind::OpenAiCompatibleApi)
        );
        assert_eq!(
            health_kind_for("my-gateway", Some(OPENAI_COMPATIBLE_KIND)),
            Some(ProviderHealthKind::OpenAiCompatibleApi)
        );
        assert_eq!(
            health_kind_for("deepseek", None),
            Some(ProviderHealthKind::OpenAiCompatibleApi)
        );
        assert_eq!(
            health_kind_for("ollama", None),
            Some(ProviderHealthKind::OllamaApi)
        );
        assert_eq!(health_kind_for("mystery", None), None);
    }
}
