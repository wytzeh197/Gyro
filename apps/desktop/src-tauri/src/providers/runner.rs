//! Synchronous provider dispatch and its application host boundary.

use super::{
    chat_types::ProviderChatRequest,
    types::{ProviderAdapterKind, ProviderResumeCursor, ProviderRunAttempt, ProviderRunnerOutput},
};
use crate::provider_context::ProviderContextUsage;
pub(crate) use gyro_core::provider_runtime::host::{
    emit_provider_activity_event, emit_provider_chat_event, emit_provider_context_usage,
    emit_request_usage, emit_turn_tokens, execute_capabilities, invoke_run_capability,
    publish_streamed_session_title, ProviderHeartbeat, ProviderRunner, RunEvent, RunnerHost,
};

macro_rules! runner {
    ($name:ident, $kind:ident, $run:expr $(, $extra:item)*) => {
        struct $name;
        impl ProviderRunner for $name {
            fn supports_images(&self, request: &ProviderChatRequest) -> bool { crate::openai_compatible_runner::supports_images(request) }
            fn kind(&self) -> ProviderAdapterKind {
                ProviderAdapterKind::$kind
            }
            fn run(
                &self,
                host: &dyn RunnerHost,
                request: &ProviderChatRequest,
                resume: Option<&ProviderResumeCursor>,
                attempt: &mut ProviderRunAttempt,
            ) -> anyhow::Result<ProviderRunnerOutput> {
                ($run)(host, request, resume, attempt)
            }
            $($extra)*
        }
    };
}

struct CodexRunner;
impl ProviderRunner for CodexRunner {
    fn supports_images(&self, request: &ProviderChatRequest) -> bool {
        crate::openai_compatible_runner::supports_images(request)
    }
    fn kind(&self) -> ProviderAdapterKind {
        ProviderAdapterKind::OpenAiCodex
    }
    fn run(
        &self,
        host: &dyn RunnerHost,
        request: &ProviderChatRequest,
        resume: Option<&ProviderResumeCursor>,
        attempt: &mut ProviderRunAttempt,
    ) -> anyhow::Result<ProviderRunnerOutput> {
        super::runners::codex::run_openai_codex_chat(host, request, resume, attempt)
    }
    fn compact(
        &self,
        host: &dyn RunnerHost,
        request: &ProviderChatRequest,
        resume: &ProviderResumeCursor,
    ) -> Option<anyhow::Result<Option<ProviderContextUsage>>> {
        Some(super::runners::codex::run_openai_codex_context_compaction(
            host, request, resume,
        ))
    }
}
runner!(
    ClaudeRunner,
    AnthropicClaude,
    super::runners::claude::run_anthropic_claude_chat
);
runner!(
    AcpRunner,
    KimiAcp,
    super::runners::kimi_acp::run_kimi_acp_chat
);
runner!(
    AntigravityRunner,
    AntigravityCli,
    super::runners::antigravity::run_antigravity_chat
);
runner!(
    OllamaRunner,
    Ollama,
    |host, request, _resume, _attempt| crate::ollama_runner::run_ollama_chat(host, request),
    fn handles_transient_retries(&self) -> bool {
        true
    }
);
runner!(
    OpenAiCompatibleRunner,
    OpenAiCompatible,
    |host, request, _resume, _attempt| crate::openai_compatible_runner::run_openai_compatible_chat(
        host, request
    ),
    fn handles_transient_retries(&self) -> bool {
        true
    }
);

struct ReadinessRunner;
impl ProviderRunner for ReadinessRunner {
    fn supports_images(&self, request: &ProviderChatRequest) -> bool {
        crate::openai_compatible_runner::supports_images(request)
    }
    fn kind(&self) -> ProviderAdapterKind {
        ProviderAdapterKind::ReadinessOnly
    }
    fn is_executable(&self) -> bool {
        false
    }
    fn run(
        &self,
        _host: &dyn RunnerHost,
        request: &ProviderChatRequest,
        _resume: Option<&ProviderResumeCursor>,
        _attempt: &mut ProviderRunAttempt,
    ) -> anyhow::Result<ProviderRunnerOutput> {
        anyhow::bail!("{} is readiness-only in Gyro V1. Chat execution for this provider has not been implemented yet.", request.provider_label.as_deref().unwrap_or("Provider"))
    }
}

pub(crate) fn runner_for(kind: ProviderAdapterKind) -> &'static dyn ProviderRunner {
    let runner: &dyn ProviderRunner = match kind {
        ProviderAdapterKind::OpenAiCodex => &CodexRunner,
        ProviderAdapterKind::AnthropicClaude => &ClaudeRunner,
        ProviderAdapterKind::KimiAcp => &AcpRunner,
        ProviderAdapterKind::AntigravityCli => &AntigravityRunner,
        ProviderAdapterKind::Ollama => &OllamaRunner,
        ProviderAdapterKind::OpenAiCompatible => &OpenAiCompatibleRunner,
        ProviderAdapterKind::ReadinessOnly => &ReadinessRunner,
    };
    debug_assert_eq!(runner.kind(), kind);
    runner
}

#[cfg(test)]
#[path = "runner_tests.rs"]
mod tests;
