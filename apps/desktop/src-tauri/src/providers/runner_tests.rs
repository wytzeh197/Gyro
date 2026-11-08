use super::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex,
};

#[derive(Default)]
struct RecordingHost {
    calls: AtomicUsize,
    observed: Mutex<Vec<(ProviderAdapterKind, String, Option<String>)>>,
}

impl RunnerHost for RecordingHost {
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
    fn run_legacy(
        &self,
        kind: ProviderAdapterKind,
        request: &ProviderChatRequest,
        resume: Option<&ProviderResumeCursor>,
        attempt: &mut ProviderRunAttempt,
    ) -> anyhow::Result<ProviderRunnerOutput> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        self.observed.lock().unwrap().push((
            kind,
            request.message.clone(),
            resume.map(|cursor| cursor.session_id.clone()),
        ));
        attempt.tools_dispatched = true;
        anyhow::bail!("recorded runner invocation")
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
fn executable_runners_forward_request_resume_and_mutable_attempt() {
    let host = RecordingHost::default();
    let request = request();
    let resume = ProviderResumeCursor {
        kind: "fixture".into(),
        session_id: "owned-conversation".into(),
    };
    let kinds = [
        ProviderAdapterKind::OpenAiCodex,
        ProviderAdapterKind::AnthropicClaude,
        ProviderAdapterKind::KimiAcp,
        ProviderAdapterKind::AntigravityCli,
        ProviderAdapterKind::Ollama,
        ProviderAdapterKind::OpenAiCompatible,
    ];
    for kind in kinds {
        let mut attempt = ProviderRunAttempt::default();
        let error = runner_for(kind)
            .run(&host, &request, Some(&resume), &mut attempt)
            .unwrap_err();
        assert!(error.to_string().contains("recorded runner invocation"));
        assert!(attempt.tools_dispatched);
        assert_eq!(
            host.observed.lock().unwrap().last(),
            Some(&(
                kind,
                request.message.clone(),
                Some(resume.session_id.clone())
            ))
        );
    }
    assert_eq!(host.calls.load(Ordering::Relaxed), kinds.len());
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
    assert_eq!(host.calls.load(Ordering::Relaxed), 0);
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
