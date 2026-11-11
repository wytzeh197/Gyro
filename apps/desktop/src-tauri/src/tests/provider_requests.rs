use super::{ChatMode, Path, ProviderChatRequest, Session, Uuid};

pub(super) fn anthropic_provider_request() -> ProviderChatRequest {
    ProviderChatRequest {
        session_id: Uuid::new_v4().to_string(),
        message: "edit it".into(),
        turn_id: Some(Uuid::new_v4().to_string()),
        provider_id: "anthropic".into(),
        provider_label: Some("Anthropic".into()),
        model_id: Some("sonnet".into()),
        model_label: Some("Claude Sonnet".into()),
        reasoning_effort: None,
        require_command_approval: true,
        require_file_edit_approval: true,
        full_access: false,
        suggest_title: false,
        workspace_path: Some("/tmp/gyro-workspace".into()),
        mode: ChatMode::Normal,
        goal: None,
        plan: None,
        attachments: Vec::new(),
        workspace_context: None,
        workspace_check: None,
        side_chat_context: None,
        workflow_run_id: None,
        project_memory: None,
        internal_purpose: None,
    }
}

pub(super) fn provider_chat_request_for(
    session: &Session,
    workspace: &Path,
    provider_id: &str,
) -> ProviderChatRequest {
    ProviderChatRequest {
        session_id: session.id.to_string(),
        message: "explain this repo".into(),
        turn_id: Some(Uuid::new_v4().to_string()),
        provider_id: provider_id.into(),
        provider_label: Some("Anthropic".into()),
        model_id: Some("claude-opus-5".into()),
        model_label: Some("Opus 5".into()),
        reasoning_effort: None,
        require_command_approval: false,
        require_file_edit_approval: false,
        full_access: true,
        suggest_title: false,
        workspace_path: Some(workspace.display().to_string()),
        mode: ChatMode::Normal,
        goal: None,
        plan: None,
        attachments: Vec::new(),
        workspace_context: None,
        workspace_check: None,
        side_chat_context: None,
        workflow_run_id: None,
        project_memory: None,
        internal_purpose: None,
    }
}
