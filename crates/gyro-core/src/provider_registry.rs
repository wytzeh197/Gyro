use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderExecutionKind {
    CodexCli,
    ClaudeCode,
    KimiAcp,
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
        supports_usage: false,
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
        supports_usage: false,
    },
    ProviderDescriptor {
        id: "xai",
        execution_kind: ProviderExecutionKind::ReadinessOnly,
        health_kind: ProviderHealthKind::Environment,
        runner: "readiness-only",
        auth_owner: "provider-env",
        supports_approvals: false,
        supports_images: false,
        supports_resume: false,
        supports_usage: false,
    },
    ProviderDescriptor {
        id: "gemini",
        execution_kind: ProviderExecutionKind::ReadinessOnly,
        health_kind: ProviderHealthKind::Environment,
        runner: "readiness-only",
        auth_owner: "provider-env",
        supports_approvals: false,
        supports_images: false,
        supports_resume: false,
        supports_usage: false,
    },
    ProviderDescriptor {
        id: "cursor",
        execution_kind: ProviderExecutionKind::ReadinessOnly,
        health_kind: ProviderHealthKind::CursorCli,
        runner: "readiness-only",
        auth_owner: "provider-cli",
        supports_approvals: false,
        supports_images: false,
        supports_resume: false,
        supports_usage: false,
    },
    ProviderDescriptor {
        id: "opencode",
        execution_kind: ProviderExecutionKind::ReadinessOnly,
        health_kind: ProviderHealthKind::OpenCodeCli,
        runner: "readiness-only",
        auth_owner: "provider-cli",
        supports_approvals: false,
        supports_images: false,
        supports_resume: false,
        supports_usage: false,
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

#[cfg(test)]
mod tests {
    use super::{provider_descriptor, provider_is_executable, ProviderExecutionKind};

    #[test]
    fn executable_registry_includes_kimi_and_excludes_readiness_only_providers() {
        assert!(provider_is_executable("openai"));
        assert!(provider_is_executable("anthropic"));
        assert!(provider_is_executable("kimi"));
        assert!(!provider_is_executable("xai"));
        assert!(!provider_is_executable("gemini"));
        assert_eq!(
            provider_descriptor("kimi").unwrap().execution_kind,
            ProviderExecutionKind::KimiAcp
        );
    }
}
