//! Synchronous provider effects supplied by the application's host.
use super::types::{
    PromptTurn, ProviderActivity, ProviderAdapterKind, ProviderApprovalDecision,
    ProviderChatRequest, ProviderContextUsage, ProviderResumeCursor, ProviderRunAttempt,
    ProviderRunnerOutput, StreamingCommandOutput,
};
use crate::{CancellationToken, CapabilityId, CapabilityResponse, HarnessRunStatus, UsageTokens};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
/// Synchronous effects emitted by a runner. The host owns persistence and UI.
pub enum RunEvent<'a> {
    Chat {
        phase: &'a str,
        status: Option<HarnessRunStatus>,
        delta: Option<String>,
        message: Option<String>,
        error: Option<String>,
    },
    Activity {
        activity: &'a ProviderActivity,
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

pub struct ProviderHeartbeat {
    stop: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl ProviderHeartbeat {
    pub fn without_worker(stop: Arc<AtomicBool>) -> Self {
        Self { stop, worker: None }
    }
    pub fn new(stop: Arc<AtomicBool>, worker: std::thread::JoinHandle<()>) -> Self {
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

pub trait RunnerHost: Send + Sync {
    fn paths(&self) -> anyhow::Result<crate::GyroPaths> {
        crate::GyroPaths::for_current_user()
    }
    fn config(&self) -> anyhow::Result<crate::GyroConfig> {
        crate::GyroConfig::load(&self.paths()?)
    }
    fn acp_program(
        &self,
        _request: &ProviderChatRequest,
        program: &str,
        args: Vec<std::ffi::OsString>,
    ) -> (std::ffi::OsString, Vec<std::ffi::OsString>) {
        (program.into(), args)
    }
    fn codex_client_options(&self) -> super::codex_client::CodexClientOptions {
        super::codex_client::CodexClientOptions::desktop()
    }
    fn supports_generated_images(&self) -> bool {
        true
    }
    fn tool_catalog(&self) -> &dyn super::catalog::ToolCatalog;
    fn context_sections(
        &self,
        request: &ProviderChatRequest,
        tools: bool,
        images: bool,
    ) -> (String, String);
    fn model_context_window(&self, provider: &str, model: Option<&str>) -> Option<u64>;
    fn allow_delegation(&self, request: &ProviderChatRequest) -> bool;
    fn expand_browser_images(
        &self,
        request: &ProviderChatRequest,
        supports_images: bool,
    ) -> anyhow::Result<ProviderChatRequest>;
    fn browser_result_image(
        &self,
        paths: &crate::GyroPaths,
        response: &CapabilityResponse,
    ) -> anyhow::Result<Option<String>>;
    fn provider_command(
        &self,
        program: &str,
        provider_id: &str,
    ) -> anyhow::Result<std::process::Command>;
    fn apply_session_environment(
        &self,
        command: &mut std::process::Command,
        request: &ProviderChatRequest,
    ) -> anyhow::Result<()>;
    fn prepare_command(
        &self,
        program: &str,
        provider_id: &str,
        request: &ProviderChatRequest,
    ) -> anyhow::Result<std::process::Command> {
        let mut command = self.provider_command(program, provider_id)?;
        self.apply_session_environment(&mut command, request)?;
        Ok(command)
    }
    fn complete_generated_image(
        &self,
        request: &ProviderChatRequest,
        item: &serde_json::Value,
        sessions_dir: &std::path::Path,
    ) -> Option<ProviderActivity>;
    fn generated_image_reply(&self, text: &str) -> String;
    fn context_message(
        &self,
        request: &ProviderChatRequest,
        history: Option<&str>,
        turn: PromptTurn,
    ) -> String;
    fn reasoning_efforts(&self, provider_id: &str, model_id: Option<&str>) -> Option<Vec<String>>;
    fn claude_capability_tools(&self, mode: super::types::ChatMode) -> String;
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
        transaction: Option<crate::PreparedProviderMutationTransaction>,
    ) -> anyhow::Result<ProviderApprovalDecision>;
    fn stop_message(&self, session_id: &str) -> String;
    fn stream_command(
        &self,
        command: std::process::Command,
        stdin_file: Option<&std::path::Path>,
        max_runtime: std::time::Duration,
        inactivity_timeout: std::time::Duration,
        request: &ProviderChatRequest,
        observed_session_id: &mut Option<String>,
    ) -> anyhow::Result<StreamingCommandOutput>;
    fn claude_mcp_config(&self, request: &ProviderChatRequest) -> anyhow::Result<String>;
    fn codex_mcp_args(&self, request: &ProviderChatRequest) -> anyhow::Result<Vec<String>>;
    fn is_cancelled(&self, session_id: &str) -> bool;
    fn request_native_approval(
        &self,
        request: &ProviderChatRequest,
        kind: &str,
        details: serde_json::Value,
    ) -> anyhow::Result<ProviderApprovalDecision>;
}

pub fn emit_provider_chat_event(
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

pub fn emit_provider_activity_event(
    host: &dyn RunnerHost,
    request: &ProviderChatRequest,
    activity: &ProviderActivity,
    sequence: Option<u64>,
) {
    host.emit(request, RunEvent::Activity { activity, sequence });
}

pub fn emit_provider_context_usage(
    host: &dyn RunnerHost,
    request: &ProviderChatRequest,
    usage: &ProviderContextUsage,
) {
    host.emit(request, RunEvent::ContextUsage(usage));
}

pub fn emit_turn_tokens(host: &dyn RunnerHost, request: &ProviderChatRequest, tokens: UsageTokens) {
    host.emit(request, RunEvent::Tokens(tokens));
}

pub fn emit_request_usage(
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

pub fn publish_streamed_session_title(
    host: &dyn RunnerHost,
    request: &ProviderChatRequest,
    response: &str,
    force: bool,
) {
    host.emit(request, RunEvent::Title { response, force });
}

pub fn invoke_run_capability(
    host: &dyn RunnerHost,
    session_id: &str,
    capability: CapabilityId,
    arguments: serde_json::Value,
) -> anyhow::Result<CapabilityResponse> {
    host.invoke_capability(session_id, capability, arguments)
}

pub fn execute_capabilities(
    host: &dyn RunnerHost,
    session_id: &str,
    calls: &[(CapabilityId, serde_json::Value)],
) -> anyhow::Result<Vec<CapabilityResponse>> {
    host.execute_capabilities(session_id, calls)
}

pub trait ProviderRunner: Send + Sync {
    fn kind(&self) -> ProviderAdapterKind;

    fn supports_images(&self, request: &ProviderChatRequest) -> bool;

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

pub fn observe_codex_turn_usage(
    host: &dyn RunnerHost,
    request: &ProviderChatRequest,
    billed: &mut super::accounting::CodexTurnUsage,
    params: &serde_json::Value,
    thread: &str,
    turn: Option<&str>,
) -> Option<ProviderContextUsage> {
    if !super::accounting::codex_usage_matches(params, thread, turn) {
        return None;
    }
    if let Some(tokens) = billed.observe(params) {
        crate::provider_observation::native_usage(tokens);
        emit_turn_tokens(
            host,
            request,
            super::accounting::provider_turn_tokens(request, None),
        );
    }
    let usage = super::accounting::provider_context_usage_from_app_server(params)?;
    emit_provider_context_usage(host, request, &usage);
    Some(usage)
}
