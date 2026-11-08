//! Synchronous provider dispatch and its application host boundary.

use super::{
    chat_types::ProviderChatRequest,
    types::{ProviderAdapterKind, ProviderResumeCursor, ProviderRunAttempt, ProviderRunnerOutput},
};

/// Application services supplied to a provider run.
///
/// This adapter call is temporary: each runner replaces it with explicit host
/// callbacks as its application dependencies move behind this boundary.
pub(crate) trait RunnerHost: Send + Sync {
    fn run_legacy(
        &self,
        kind: ProviderAdapterKind,
        request: &ProviderChatRequest,
        resume: Option<&ProviderResumeCursor>,
        attempt: &mut ProviderRunAttempt,
    ) -> anyhow::Result<ProviderRunnerOutput>;
}

pub(crate) trait ProviderRunner: Send + Sync {
    fn kind(&self) -> ProviderAdapterKind;

    fn supports_images(&self, request: &ProviderChatRequest) -> bool {
        crate::openai_compatible_runner::supports_images(request)
    }

    fn is_executable(&self) -> bool {
        true
    }

    fn run(
        &self,
        host: &dyn RunnerHost,
        request: &ProviderChatRequest,
        resume: Option<&ProviderResumeCursor>,
        attempt: &mut ProviderRunAttempt,
    ) -> anyhow::Result<ProviderRunnerOutput> {
        if !self.is_executable() {
            anyhow::bail!(
                "{} is readiness-only in Gyro V1. Chat execution for this provider has not been implemented yet.",
                request.provider_label.as_deref().unwrap_or("Provider")
            );
        }
        host.run_legacy(self.kind(), request, resume, attempt)
    }
}

macro_rules! runner {
    ($name:ident, $kind:ident) => {
        struct $name;
        impl ProviderRunner for $name {
            fn kind(&self) -> ProviderAdapterKind {
                ProviderAdapterKind::$kind
            }
        }
    };
}

runner!(CodexRunner, OpenAiCodex);
runner!(ClaudeRunner, AnthropicClaude);
runner!(AcpRunner, KimiAcp);
runner!(AntigravityRunner, AntigravityCli);
runner!(OllamaRunner, Ollama);
runner!(OpenAiCompatibleRunner, OpenAiCompatible);

struct ReadinessRunner;
impl ProviderRunner for ReadinessRunner {
    fn kind(&self) -> ProviderAdapterKind {
        ProviderAdapterKind::ReadinessOnly
    }

    fn is_executable(&self) -> bool {
        false
    }
}

pub(crate) fn runner_for(kind: ProviderAdapterKind) -> &'static dyn ProviderRunner {
    match kind {
        ProviderAdapterKind::OpenAiCodex => &CodexRunner,
        ProviderAdapterKind::AnthropicClaude => &ClaudeRunner,
        ProviderAdapterKind::KimiAcp => &AcpRunner,
        ProviderAdapterKind::AntigravityCli => &AntigravityRunner,
        ProviderAdapterKind::Ollama => &OllamaRunner,
        ProviderAdapterKind::OpenAiCompatible => &OpenAiCompatibleRunner,
        ProviderAdapterKind::ReadinessOnly => &ReadinessRunner,
    }
}

#[cfg(test)]
#[path = "runner_tests.rs"]
mod tests;
