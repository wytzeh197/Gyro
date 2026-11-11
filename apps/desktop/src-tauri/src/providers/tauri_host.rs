//! Desktop implementation of provider application services.

use super::{
    chat_types::ProviderChatRequest,
    runner::{ProviderHeartbeat, RunEvent, RunnerHost},
};
use crate::{
    capabilities::bridge::{active_provider_approval_nonce, active_provider_capability_context},
    efficiency, provider_accounting, provider_tool_batch,
    state::managers::{ProviderCancellationManager, ProviderCapabilityBroker},
    stores::open_store,
};
use gyro_core::{
    CancellationToken, CapabilityId, CapabilityInvocationContext, CapabilityRequest,
    CapabilityResponse, PROVIDER_CAPABILITY_IPC_SCHEMA_V1,
};
use std::sync::{atomic::AtomicBool, Arc};
use tauri::Manager;
use uuid::Uuid;

pub(crate) struct TauriRunnerHost {
    app: tauri::AppHandle,
    generated_images: std::sync::Mutex<crate::codex_images::GeneratedImages>,
}

impl TauriRunnerHost {
    fn record_memory_context(&self, request: &ProviderChatRequest, resumed: bool) {
        let Some(memory) = &request.project_memory else {
            return;
        };
        let result = (|| -> anyhow::Result<()> {
            let (_, receipt) = memory.render(resumed);
            let Some(turn) = &request.turn_id else {
                return Ok(());
            };
            let store = open_store().map_err(anyhow::Error::msg)?;
            store.record_project_memory_receipt(
                Uuid::parse_str(&request.session_id)?,
                Uuid::parse_str(turn)?,
                &request.provider_id,
                &receipt,
            )
        })();
        if let Err(error) = result {
            eprintln!(
                "Memory context receipt unavailable: {}",
                gyro_core::sanitize_capability_summary(&error.to_string())
            );
        }
    }

    pub(crate) fn new(app: &tauri::AppHandle) -> Self {
        Self {
            app: app.clone(),
            generated_images: std::sync::Mutex::new(Default::default()),
        }
    }
}

impl RunnerHost for TauriRunnerHost {
    fn tool_catalog(&self) -> &dyn gyro_core::provider_runtime::catalog::ToolCatalog {
        &super::catalog::DESKTOP_TOOL_CATALOG
    }
    fn context_sections(
        &self,
        request: &ProviderChatRequest,
        tools: bool,
        images: bool,
    ) -> (String, String) {
        self.record_memory_context(request, false);
        crate::efficiency::capture_prompt(|| {
            super::prompt::provider_context_message_with_capabilities(
                request,
                self.conversation_history(request).as_deref(),
                tools,
                images,
            )
        })
    }
    fn model_context_window(&self, provider: &str, model: Option<&str>) -> Option<u64> {
        crate::provider_context::provider_model_context_window(provider, model)
    }
    fn allow_delegation(&self, request: &ProviderChatRequest) -> bool {
        crate::delegated_agents::request_allows_delegation(request)
            && crate::delegated_agents::can_delegate(&request.session_id)
    }
    fn expand_browser_images(
        &self,
        request: &ProviderChatRequest,
        supports_images: bool,
    ) -> anyhow::Result<ProviderChatRequest> {
        super::retry::with_browser_attachment_images(request, supports_images)
    }
    fn browser_result_image(
        &self,
        paths: &gyro_core::GyroPaths,
        response: &CapabilityResponse,
    ) -> anyhow::Result<Option<String>> {
        crate::capabilities::mcp_server::browser_result_image(paths, response)
    }
    fn provider_command(
        &self,
        program: &str,
        provider_id: &str,
    ) -> anyhow::Result<std::process::Command> {
        super::process::command_for_provider(program, provider_id)
    }
    fn apply_session_environment(
        &self,
        command: &mut std::process::Command,
        request: &ProviderChatRequest,
    ) -> anyhow::Result<()> {
        crate::project_import_continuation::apply_data_home(command, request)
    }
    fn complete_generated_image(
        &self,
        request: &ProviderChatRequest,
        item: &serde_json::Value,
        sessions_dir: &std::path::Path,
    ) -> Option<super::types::ProviderActivity> {
        self.generated_images
            .lock()
            .expect("provider image state poisoned")
            .complete(item, sessions_dir, &request.session_id)
    }
    fn generated_image_reply(&self, text: &str) -> String {
        self.generated_images
            .lock()
            .expect("provider image state poisoned")
            .reply(text)
    }
    fn context_message(
        &self,
        request: &ProviderChatRequest,
        history: Option<&str>,
        turn: gyro_core::provider_runtime::types::PromptTurn,
    ) -> String {
        self.record_memory_context(request, turn.resumed);
        super::prompt::provider_context_message_for_turn(request, history, turn)
    }
    fn reasoning_efforts(&self, provider_id: &str, model_id: Option<&str>) -> Option<Vec<String>> {
        crate::model_catalog::catalog_reasoning_efforts(provider_id, model_id)
    }
    fn claude_capability_tools(&self, mode: super::chat_types::ChatMode) -> String {
        super::cli_args::claude_allowed_capability_tools(
            super::binding::advertised_mcp_capability_tools(
                super::binding::capability_run_mode_for_chat(mode),
            ),
            crate::provider_tool_batch::compact_cli_catalog_active(
                "anthropic",
                &crate::efficiency::config(),
            ),
        )
    }
    fn cancellation(&self, session_id: &str) -> anyhow::Result<CancellationToken> {
        self.app
            .state::<ProviderCancellationManager>()
            .flags
            .lock()
            .map_err(|_| anyhow::anyhow!("provider cancellation state is unavailable"))?
            .get(session_id)
            .map(|control| control.cancellation.clone())
            .ok_or_else(|| anyhow::anyhow!("provider run control is unavailable"))
    }

    fn emit(&self, request: &ProviderChatRequest, event: RunEvent<'_>) {
        match event {
            RunEvent::Chat {
                phase,
                status,
                delta,
                message,
                error,
            } => {
                if matches!(request.internal_purpose,Some(super::chat_types::InternalRequestPurpose::CodeReview|super::chat_types::InternalRequestPurpose::WorkflowExtraction))
                {
                    if let Some(delta) = delta.as_deref() {
                        crate::features::code_reviews::output::append(&request.session_id, delta);
                    }
                }
                super::events::emit_provider_chat_event(
                    &self.app, request, phase, status, delta, message, error,
                )
            }
            RunEvent::Activity { activity, sequence } => {
                super::events::emit_provider_activity_event(&self.app, request, activity, sequence)
            }
            RunEvent::ContextUsage(usage) => {
                super::events::emit_provider_context_usage(&self.app, request, usage)
            }
            RunEvent::Tokens(tokens) => {
                provider_accounting::emit_turn_tokens(&self.app, request, tokens)
            }
            RunEvent::RequestUsage {
                previous,
                tokens,
                window,
            } => provider_accounting::emit_request_usage(
                &self.app, request, previous, tokens, window,
            ),
            RunEvent::Title { response, force } => {
                super::markers::publish_streamed_session_title(&self.app, request, response, force)
            }
        }
    }

    fn conversation_history(&self, request: &ProviderChatRequest) -> Option<String> {
        super::binding::local_conversation_history_for_request(request)
    }

    fn save_checkpoint(&self, request: &ProviderChatRequest) {
        if let Ok(store) = open_store() {
            let _ = efficiency::save_checkpoint(&self.app, &store, request);
        }
    }

    fn start_heartbeat(
        &self,
        request: ProviderChatRequest,
        cancellation: CancellationToken,
        stop: Arc<AtomicBool>,
    ) -> ProviderHeartbeat {
        super::streaming::spawn_provider_chat_heartbeat(
            self.app.clone(),
            request,
            cancellation,
            stop,
            None,
        )
    }

    fn invoke_capability(
        &self,
        session_id: &str,
        capability: CapabilityId,
        arguments: serde_json::Value,
    ) -> anyhow::Result<CapabilityResponse> {
        invoke_run_capability(&self.app, session_id, capability, arguments)
    }

    fn execute_capabilities(
        &self,
        session_id: &str,
        calls: &[(CapabilityId, serde_json::Value)],
    ) -> anyhow::Result<Vec<CapabilityResponse>> {
        provider_tool_batch::execute(&self.app, session_id, calls)
    }

    fn acp_mcp_servers(&self, session_id: &str) -> anyhow::Result<Vec<serde_json::Value>> {
        match (
            active_provider_approval_nonce(&self.app, session_id),
            active_provider_capability_context(&self.app, session_id),
        ) {
            (Ok(nonce), Ok(bound)) => Ok(vec![
                crate::capabilities::bridge::capability_acp_mcp_server(&bound, &nonce)?,
            ]),
            (Err(error), _) | (_, Err(error)) => {
                anyhow::bail!("Gyro tools are unavailable for this turn: {error}")
            }
        }
    }

    fn acp_conversation_history(&self, session_id: &str) -> Option<String> {
        super::process::acp_conversation_history_text(&self.app, session_id)
    }

    fn request_approval(
        &self,
        request: &ProviderChatRequest,
        kind: &str,
        details: serde_json::Value,
        transaction: Option<gyro_core::PreparedProviderMutationTransaction>,
    ) -> anyhow::Result<crate::state::provider_run::ProviderApprovalDecision> {
        super::approvals::wait_for_provider_approval_with_transaction(
            &self.app,
            &crate::state::provider_run::ProviderApprovalContext::from(request),
            kind,
            details,
            transaction,
        )
    }

    fn stop_message(&self, session_id: &str) -> String {
        super::streaming::provider_stop_message(&self.app, session_id)
    }

    fn stream_command(
        &self,
        command: std::process::Command,
        stdin_file: Option<&std::path::Path>,
        max_runtime: std::time::Duration,
        inactivity_timeout: std::time::Duration,
        request: &ProviderChatRequest,
        observed_session_id: &mut Option<String>,
    ) -> anyhow::Result<super::streaming::StreamingCommandOutput> {
        super::streaming::run_streaming_command(
            command,
            stdin_file,
            max_runtime,
            inactivity_timeout,
            &self.app,
            request,
            observed_session_id,
        )
    }

    fn claude_mcp_config(&self, request: &ProviderChatRequest) -> anyhow::Result<String> {
        let nonce = active_provider_approval_nonce(&self.app, &request.session_id)?;
        let context = active_provider_capability_context(&self.app, &request.session_id)?;
        crate::capabilities::bridge::desktop_claude_permission_mcp_config(request, &nonce, &context)
    }

    fn codex_mcp_args(&self, request: &ProviderChatRequest) -> anyhow::Result<Vec<String>> {
        crate::capabilities::bridge::codex_capability_mcp_config_args(&self.app, request)
    }
    fn is_cancelled(&self, session_id: &str) -> bool {
        super::streaming::provider_chat_cancelled(&self.app, session_id)
    }
    fn request_native_approval(
        &self,
        request: &ProviderChatRequest,
        kind: &str,
        details: serde_json::Value,
    ) -> anyhow::Result<crate::state::provider_run::ProviderApprovalDecision> {
        super::approvals::wait_for_provider_approval(&self.app, request, kind, details)
    }
}

pub(crate) fn invoke_run_capability(
    app: &tauri::AppHandle,
    session_id: &str,
    capability_id: CapabilityId,
    arguments: serde_json::Value,
) -> anyhow::Result<CapabilityResponse> {
    let bound = active_provider_capability_context(app, session_id)?;
    Ok(app.state::<ProviderCapabilityBroker>().invoke(
        app,
        CapabilityRequest {
            schema: PROVIDER_CAPABILITY_IPC_SCHEMA_V1.into(),
            sender_version: env!("CARGO_PKG_VERSION").into(),
            context: CapabilityInvocationContext {
                session_id: bound.session_id.clone(),
                turn_id: bound.turn_id.clone(),
                provider_id: bound.provider_id.clone(),
                run_nonce: active_provider_approval_nonce(app, session_id)?,
                call_id: Uuid::new_v4(),
                workspace_key: bound.workspace_key.clone(),
                mode: bound.policy.mode,
                policy_revision: bound.policy.revision,
                workspace_context_revision: bound.workspace_context.revision,
            },
            capability_id,
            arguments,
        },
    ))
}
