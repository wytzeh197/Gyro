//! Non-optional execution ceiling for internal review/extraction purposes.
use super::types::{
    ChatMode, InternalRequestPurpose, ProviderAdapterKind, ProviderChatRequest,
    ProviderResumeCursor,
};
use anyhow::{ensure, Result};

pub fn is_advisory(request: &ProviderChatRequest) -> bool {
    matches!(
        request.internal_purpose,
        Some(InternalRequestPurpose::CodeReview | InternalRequestPurpose::WorkflowExtraction)
    )
}
pub fn validate_advisory_request(
    kind: ProviderAdapterKind,
    request: &ProviderChatRequest,
    resume: Option<&ProviderResumeCursor>,
) -> Result<()> {
    if !is_advisory(request) {
        return Ok(());
    }
    ensure!(matches!(kind,ProviderAdapterKind::Ollama|ProviderAdapterKind::OpenAiCompatible),"this provider has no verified no-tool review/extraction execution path; choose an API or local Ollama model explicitly");
    ensure!(
        request.mode == ChatMode::Council
            && !request.full_access
            && request.require_command_approval
            && request.require_file_edit_approval,
        "advisory request has an invalid execution ceiling"
    );
    ensure!(
        resume.is_none()
            && request.workflow_run_id.is_none()
            && request.side_chat_context.is_none()
            && request.project_memory.is_none()
            && request.attachments.is_empty()
            && request.goal.is_none()
            && request.plan.is_none()
            && !request.suggest_title,
        "advisory requests must use only their frozen input and a fresh provider context"
    );
    Ok(())
}
