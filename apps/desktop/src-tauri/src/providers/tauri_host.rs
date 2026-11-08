//! Desktop implementation of provider application services.

use super::{
    chat_types::ProviderChatRequest,
    runner::RunnerHost,
    runners::{
        antigravity::run_antigravity_chat, claude::run_anthropic_claude_chat,
        codex::run_openai_codex_chat, kimi_acp::run_kimi_acp_chat,
    },
    types::{ProviderAdapterKind, ProviderResumeCursor, ProviderRunAttempt, ProviderRunnerOutput},
};

pub(crate) struct TauriRunnerHost {
    app: tauri::AppHandle,
}

impl TauriRunnerHost {
    pub(crate) fn new(app: &tauri::AppHandle) -> Self {
        Self { app: app.clone() }
    }
}

impl RunnerHost for TauriRunnerHost {
    fn run_legacy(
        &self,
        kind: ProviderAdapterKind,
        request: &ProviderChatRequest,
        resume: Option<&ProviderResumeCursor>,
        attempt: &mut ProviderRunAttempt,
    ) -> anyhow::Result<ProviderRunnerOutput> {
        match kind {
            ProviderAdapterKind::OpenAiCodex => {
                run_openai_codex_chat(&self.app, request, resume, attempt)
            }
            ProviderAdapterKind::AnthropicClaude => {
                run_anthropic_claude_chat(&self.app, request, resume, attempt)
            }
            ProviderAdapterKind::KimiAcp => run_kimi_acp_chat(&self.app, request, resume, attempt),
            ProviderAdapterKind::AntigravityCli => {
                run_antigravity_chat(&self.app, request, resume, attempt)
            }
            ProviderAdapterKind::Ollama => crate::ollama_runner::run_ollama_chat(&self.app, request),
            ProviderAdapterKind::OpenAiCompatible => {
                crate::openai_compatible_runner::run_openai_compatible_chat(&self.app, request)
            }
            ProviderAdapterKind::ReadinessOnly => anyhow::bail!(
                "{} is readiness-only in Gyro V1. Chat execution for this provider has not been implemented yet.",
                request.provider_label.as_deref().unwrap_or("Provider")
            ),
        }
    }
}
