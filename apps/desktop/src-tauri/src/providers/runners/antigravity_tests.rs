use super::*;

#[test]
fn approval_guidance_omits_unconnected_gyro_tools_for_antigravity() {
    let mut request = anthropic_provider_request();
    request.provider_id = "antigravity".into();
    request.provider_label = Some("Google Antigravity".into());
    request.model_id = Some("antigravity-default".into());
    request.message = "Use sub-agents to review this change.".into();
    request.require_command_approval = true;
    request.require_file_edit_approval = true;
    for resumed in [false, true] {
        let prompt = provider_context_message_for_turn(
            &request,
            None,
            PromptTurn {
                resumed,
                ..PromptTurn::default()
            },
        );
        assert!(prompt.contains("fresh, explicit user approval before every command"));
        assert!(prompt.contains("fresh, explicit user approval before every file change"));
        assert!(!prompt.contains("Invoke gyro_* capabilities directly"));
        assert!(!prompt.contains("gyro_agent_spawn"));
        assert!(!prompt.contains("Parallel delegation:"));
    }
}
