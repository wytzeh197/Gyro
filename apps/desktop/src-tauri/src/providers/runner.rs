//! Synchronous provider dispatch and its application host boundary.

use super::{
    chat_types::ProviderChatRequest,
    types::{ProviderAdapterKind, ProviderResumeCursor, ProviderRunAttempt, ProviderRunnerOutput},
};
use crate::provider_context::ProviderContextUsage;
use gyro_core::{
    CancellationToken, CapabilityId, CapabilityResponse, HarnessRunStatus, UsageTokens,
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

/// Synchronous effects emitted by a runner. The host owns persistence and UI.
pub(crate) enum RunEvent<'a> {
    Chat {
        phase: &'a str,
        status: Option<HarnessRunStatus>,
        delta: Option<String>,
        message: Option<String>,
        error: Option<String>,
    },
    Activity {
        activity: &'a super::types::ProviderActivity,
        sequence: Option<u64>,
    },
    ContextUsage(&'a ProviderContextUsage),
    Tokens(UsageTokens),
    RequestUsage {
        previous: Option<UsageTokens>,
        tokens: UsageTokens,
        window: Option<u64>,
    },
    Title {
        response: &'a str,
        force: bool,
    },
}

pub(crate) struct ProviderHeartbeat {
    stop: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl ProviderHeartbeat {
    pub(crate) fn new(stop: Arc<AtomicBool>, worker: std::thread::JoinHandle<()>) -> Self {
        Self {
            stop,
            worker: Some(worker),
        }
    }
}

impl Drop for ProviderHeartbeat {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            worker.thread().unpark();
            let _ = worker.join();
        }
    }
}

/// Application services supplied to a provider run.

pub(crate) trait RunnerHost: Send + Sync {
    fn cancellation(&self, session_id: &str) -> anyhow::Result<CancellationToken>;
    fn emit(&self, request: &ProviderChatRequest, event: RunEvent<'_>);
    fn conversation_history(&self, request: &ProviderChatRequest) -> Option<String>;
    fn save_checkpoint(&self, request: &ProviderChatRequest);
    fn start_heartbeat(
        &self,
        request: ProviderChatRequest,
        cancellation: CancellationToken,
        stop: Arc<AtomicBool>,
    ) -> ProviderHeartbeat;
    fn invoke_capability(
        &self,
        session_id: &str,
        capability: CapabilityId,
        arguments: serde_json::Value,
    ) -> anyhow::Result<CapabilityResponse>;
    fn execute_capabilities(
        &self,
        session_id: &str,
        calls: &[(CapabilityId, serde_json::Value)],
    ) -> anyhow::Result<Vec<CapabilityResponse>>;
    fn acp_mcp_servers(&self, session_id: &str) -> anyhow::Result<Vec<serde_json::Value>>;
    fn acp_conversation_history(&self, session_id: &str) -> Option<String>;
    fn request_approval(
        &self,
        request: &ProviderChatRequest,
        kind: &str,
        details: serde_json::Value,
        transaction: Option<gyro_core::PreparedProviderMutationTransaction>,
    ) -> anyhow::Result<crate::state::provider_run::ProviderApprovalDecision>;
    fn stop_message(&self, session_id: &str) -> String;
    fn stream_command(
        &self,
        command: std::process::Command,
        stdin_file: Option<&std::path::Path>,
        max_runtime: std::time::Duration,
        inactivity_timeout: std::time::Duration,
        request: &ProviderChatRequest,
        observed_session_id: &mut Option<String>,
    ) -> anyhow::Result<super::streaming::StreamingCommandOutput>;
    fn claude_mcp_config(&self, request: &ProviderChatRequest) -> anyhow::Result<String>;
    fn codex_mcp_args(&self, request: &ProviderChatRequest) -> anyhow::Result<Vec<String>>;
    fn is_cancelled(&self, session_id: &str) -> bool;
    fn request_native_approval(
        &self,
        request: &ProviderChatRequest,
        kind: &str,
        details: serde_json::Value,
    ) -> anyhow::Result<crate::state::provider_run::ProviderApprovalDecision>;
}

pub(crate) fn emit_provider_chat_event(
    host: &dyn RunnerHost,
    request: &ProviderChatRequest,
    phase: &str,
    status: Option<HarnessRunStatus>,
    delta: Option<String>,
    message: Option<String>,
    error: Option<String>,
) {
    host.emit(
        request,
        RunEvent::Chat {
            phase,
            status,
            delta,
            message,
            error,
        },
    );
}

pub(crate) fn emit_provider_activity_event(
    host: &dyn RunnerHost,
    request: &ProviderChatRequest,
    activity: &super::types::ProviderActivity,
    sequence: Option<u64>,
) {
    host.emit(request, RunEvent::Activity { activity, sequence });
}

pub(crate) fn emit_provider_context_usage(
    host: &dyn RunnerHost,
    request: &ProviderChatRequest,
    usage: &ProviderContextUsage,
) {
    host.emit(request, RunEvent::ContextUsage(usage));
}

pub(crate) fn emit_turn_tokens(
    host: &dyn RunnerHost,
    request: &ProviderChatRequest,
    tokens: UsageTokens,
) {
    host.emit(request, RunEvent::Tokens(tokens));
}

pub(crate) fn emit_request_usage(
    host: &dyn RunnerHost,
    request: &ProviderChatRequest,
    previous: Option<UsageTokens>,
    tokens: UsageTokens,
    window: Option<u64>,
) {
    host.emit(
        request,
        RunEvent::RequestUsage {
            previous,
            tokens,
            window,
        },
    );
}

pub(crate) fn publish_streamed_session_title(
    host: &dyn RunnerHost,
    request: &ProviderChatRequest,
    response: &str,
    force: bool,
) {
    host.emit(request, RunEvent::Title { response, force });
}

pub(crate) fn invoke_run_capability(
    host: &dyn RunnerHost,
    session_id: &str,
    capability: CapabilityId,
    arguments: serde_json::Value,
) -> anyhow::Result<CapabilityResponse> {
    host.invoke_capability(session_id, capability, arguments)
}

pub(crate) fn execute_capabilities(
    host: &dyn RunnerHost,
    session_id: &str,
    calls: &[(CapabilityId, serde_json::Value)],
) -> anyhow::Result<Vec<CapabilityResponse>> {
    host.execute_capabilities(session_id, calls)
}

pub(crate) fn observe_codex_turn_usage(
    host: &dyn RunnerHost,
    request: &ProviderChatRequest,
    billed: &mut crate::provider_accounting::CodexTurnUsage,
    params: &serde_json::Value,
    thread: &str,
    turn: Option<&str>,
) -> Option<ProviderContextUsage> {
    if !crate::provider_accounting::codex_usage_matches(params, thread, turn) {
        return None;
    }
    if let Some(tokens) = billed.observe(params) {
        gyro_core::provider_observation::native_usage(tokens);
        emit_turn_tokens(
            host,
            request,
            crate::provider_accounting::provider_turn_tokens(request, None),
        );
    }
    let usage = crate::provider_context::provider_context_usage_from_app_server(params)?;
    emit_provider_context_usage(host, request, &usage);
    Some(usage)
}

pub(crate) trait ProviderRunner: Send + Sync {
    fn kind(&self) -> ProviderAdapterKind;

    fn supports_images(&self, request: &ProviderChatRequest) -> bool {
        crate::openai_compatible_runner::supports_images(request)
    }

    fn is_executable(&self) -> bool {
        true
    }

    fn handles_transient_retries(&self) -> bool {
        false
    }

    fn run(
        &self,
        host: &dyn RunnerHost,
        request: &ProviderChatRequest,
        resume: Option<&ProviderResumeCursor>,
        attempt: &mut ProviderRunAttempt,
    ) -> anyhow::Result<ProviderRunnerOutput>;

    fn compact(
        &self,
        _host: &dyn RunnerHost,
        _request: &ProviderChatRequest,
        _resume: &ProviderResumeCursor,
    ) -> Option<anyhow::Result<Option<ProviderContextUsage>>> {
        None
    }
}

macro_rules! runner {
    ($name:ident, $kind:ident, $run:expr $(, $extra:item)*) => {
        struct $name;
        impl ProviderRunner for $name {
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
