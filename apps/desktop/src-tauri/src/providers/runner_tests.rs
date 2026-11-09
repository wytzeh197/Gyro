use super::*;

#[derive(Default)]
struct RecordingHost;

impl RunnerHost for RecordingHost {
    fn tool_catalog(&self) -> &dyn gyro_core::provider_runtime::catalog::ToolCatalog {
        unreachable!("unused fixture service")
    }
    fn context_sections(&self, _: &ProviderChatRequest, _: bool, _: bool) -> (String, String) {
        unreachable!("unused fixture service")
    }
    fn model_context_window(&self, _: &str, _: Option<&str>) -> Option<u64> {
        unreachable!("unused fixture service")
    }
    fn allow_delegation(&self, _: &ProviderChatRequest) -> bool {
        unreachable!("unused fixture service")
    }
    fn expand_browser_images(
        &self,
        _: &ProviderChatRequest,
        _: bool,
    ) -> anyhow::Result<ProviderChatRequest> {
        unreachable!("unused fixture service")
    }
    fn browser_result_image(
        &self,
        _: &gyro_core::GyroPaths,
        _: &gyro_core::CapabilityResponse,
    ) -> anyhow::Result<Option<String>> {
        unreachable!("unused fixture service")
    }
    fn provider_command(&self, _: &str, _: &str) -> anyhow::Result<std::process::Command> {
        unreachable!("unused fixture service")
    }
    fn apply_session_environment(
        &self,
        _: &mut std::process::Command,
        _: &ProviderChatRequest,
    ) -> anyhow::Result<()> {
        unreachable!("unused fixture service")
    }
    fn complete_generated_image(
        &self,
        _: &ProviderChatRequest,
        _: &serde_json::Value,
        _: &std::path::Path,
    ) -> Option<super::super::types::ProviderActivity> {
        unreachable!("unused fixture service")
    }
    fn generated_image_reply(&self, _: &str) -> String {
        unreachable!("unused fixture service")
    }
    fn context_message(
        &self,
        _: &ProviderChatRequest,
        _: Option<&str>,
        _: gyro_core::provider_runtime::types::PromptTurn,
    ) -> String {
        unreachable!("unused fixture service")
    }
    fn reasoning_efforts(&self, _: &str, _: Option<&str>) -> Option<Vec<String>> {
        unreachable!("unused fixture service")
    }
    fn claude_capability_tools(&self, _: super::super::chat_types::ChatMode) -> String {
        unreachable!("unused fixture service")
    }
    fn cancellation(&self, _: &str) -> anyhow::Result<gyro_core::CancellationToken> {
        unreachable!("unused fixture service")
    }
    fn emit(&self, _: &ProviderChatRequest, _: RunEvent<'_>) {
        unreachable!("unused fixture service")
    }
    fn conversation_history(&self, _: &ProviderChatRequest) -> Option<String> {
        unreachable!("unused fixture service")
    }
    fn save_checkpoint(&self, _: &ProviderChatRequest) {
        unreachable!("unused fixture service")
    }
    fn start_heartbeat(
        &self,
        _: ProviderChatRequest,
        _: gyro_core::CancellationToken,
        _: std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> ProviderHeartbeat {
        unreachable!("unused fixture service")
    }
    fn invoke_capability(
        &self,
        _: &str,
        _: gyro_core::CapabilityId,
        _: serde_json::Value,
    ) -> anyhow::Result<gyro_core::CapabilityResponse> {
        unreachable!("unused fixture service")
    }
    fn execute_capabilities(
        &self,
        _: &str,
        _: &[(gyro_core::CapabilityId, serde_json::Value)],
    ) -> anyhow::Result<Vec<gyro_core::CapabilityResponse>> {
        unreachable!("unused fixture service")
    }
    fn acp_mcp_servers(&self, _: &str) -> anyhow::Result<Vec<serde_json::Value>> {
        unreachable!("unused fixture service")
    }
    fn acp_conversation_history(&self, _: &str) -> Option<String> {
        unreachable!("unused fixture service")
    }
    fn request_approval(
        &self,
        _: &ProviderChatRequest,
        _: &str,
        _: serde_json::Value,
        _: Option<gyro_core::PreparedProviderMutationTransaction>,
    ) -> anyhow::Result<crate::state::provider_run::ProviderApprovalDecision> {
        unreachable!("unused fixture service")
    }
    fn stop_message(&self, _: &str) -> String {
        unreachable!("unused fixture service")
    }
    fn stream_command(
        &self,
        _: std::process::Command,
        _: Option<&std::path::Path>,
        _: std::time::Duration,
        _: std::time::Duration,
        _: &ProviderChatRequest,
        _: &mut Option<String>,
    ) -> anyhow::Result<super::super::streaming::StreamingCommandOutput> {
        unreachable!("unused fixture service")
    }
    fn claude_mcp_config(&self, _: &ProviderChatRequest) -> anyhow::Result<String> {
        unreachable!("unused fixture service")
    }
    fn codex_mcp_args(&self, _: &ProviderChatRequest) -> anyhow::Result<Vec<String>> {
        unreachable!("unused fixture service")
    }
    fn is_cancelled(&self, _: &str) -> bool {
        unreachable!("unused fixture service")
    }
    fn request_native_approval(
        &self,
        _: &ProviderChatRequest,
        _: &str,
        _: serde_json::Value,
    ) -> anyhow::Result<crate::state::provider_run::ProviderApprovalDecision> {
        unreachable!("unused fixture service")
    }
}

fn request() -> ProviderChatRequest {
    serde_json::from_value(serde_json::json!({
        "sessionId": "runner-fixture",
        "providerId": "deepseek",
        "message": "continue the acknowledged conversation"
    }))
    .unwrap()
}

#[test]
fn registry_exposes_each_executable_adapter_without_an_application_handle() {
    let kinds = [
        ProviderAdapterKind::OpenAiCodex,
        ProviderAdapterKind::AnthropicClaude,
        ProviderAdapterKind::KimiAcp,
        ProviderAdapterKind::AntigravityCli,
        ProviderAdapterKind::Ollama,
        ProviderAdapterKind::OpenAiCompatible,
    ];
    for kind in kinds {
        let runner = runner_for(kind);
        assert_eq!(runner.kind(), kind);
        assert!(runner.is_executable());
        assert_eq!(
            runner.handles_transient_retries(),
            matches!(
                kind,
                ProviderAdapterKind::Ollama | ProviderAdapterKind::OpenAiCompatible
            )
        );
        if kind != ProviderAdapterKind::OpenAiCodex {
            assert!(runner
                .compact(
                    &RecordingHost,
                    &request(),
                    &ProviderResumeCursor {
                        kind: "fixture".into(),
                        session_id: "fixture".into()
                    }
                )
                .is_none());
        }
    }
}

#[test]
fn readiness_runner_rejects_without_invoking_the_host() {
    let host = RecordingHost::default();
    let mut request = request();
    request.provider_label = Some("Unavailable provider".into());
    let error = runner_for(ProviderAdapterKind::ReadinessOnly)
        .run(&host, &request, None, &mut ProviderRunAttempt::default())
        .unwrap_err();
    assert!(error
        .to_string()
        .starts_with("Unavailable provider is readiness-only"));
}

#[test]
fn image_support_preserves_model_specific_and_ollama_policies() {
    let mut request = request();
    let runner = runner_for(ProviderAdapterKind::OpenAiCompatible);
    request.model_id = Some("deepseek-v4-flash".into());
    assert!(runner.supports_images(&request));
    request.model_id = Some("deepseek-reasoner".into());
    assert!(!runner.supports_images(&request));
    request.provider_id = "ollama".into();
    assert!(!runner_for(ProviderAdapterKind::Ollama).supports_images(&request));
}
