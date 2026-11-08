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
