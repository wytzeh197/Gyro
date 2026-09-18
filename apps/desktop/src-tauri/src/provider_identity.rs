//! The identity sentence a Gyro-assembled system prompt opens with.
//!
//! Only two runners need this. The vendor CLIs (Claude Code, Codex, Grok, Kimi)
//! build their own prompts and already tell the model what it is; Ollama and the
//! OpenAI-compatible endpoints are the ones Gyro writes the system message for.

use super::*;

/// The sentence a Gyro-driven runner opens its system prompt with.
///
/// Neither an OpenAI-compatible endpoint nor Ollama tells a model what it is:
/// the wire format carries the model id in the request envelope, not in the
/// context the model reads. Asked "what model are you?", a model could only
/// describe the transport it arrived over and had to disclaim the rest. The
/// vendor CLIs answer this themselves; these two runners are the ones Gyro
/// assembles the prompt for, so the identity has to come from here.
///
/// Both names come from the same request the composer chip and the usage ledger
/// read, so the model's answer matches the chip the user is looking at.
pub(super) fn provider_model_identity(request: &ProviderChatRequest, transport: &str) -> String {
    let model_id = request
        .model_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let model_label = request
        .model_label
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let provider = request
        .provider_label
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    // The label is what a person recognizes and the id is what an API call
    // needs, so a model that has both says both rather than making the user
    // guess which one Gyro meant.
    let name = match (model_label, model_id) {
        (Some(label), Some(id)) if label != id => format!("{label} (model id `{id}`)"),
        (Some(label), _) => label.to_string(),
        (None, Some(id)) => format!("`{id}`"),
        (None, None) => "an unnamed model".to_string(),
    };
    match provider {
        Some(provider) => format!("You are {name}, served by {provider} {transport} in Gyro."),
        None => format!("You are {name}, reached {transport} in Gyro."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(
        provider: Option<&str>,
        label: Option<&str>,
        id: Option<&str>,
    ) -> ProviderChatRequest {
        ProviderChatRequest {
            session_id: "ses_1".into(),
            message: "hi".into(),
            turn_id: None,
            provider_id: "deepseek".into(),
            provider_label: provider.map(str::to_string),
            model_id: id.map(str::to_string),
            model_label: label.map(str::to_string),
            reasoning_effort: None,
            require_command_approval: true,
            require_file_edit_approval: true,
            full_access: false,
            suggest_title: false,
            workspace_path: None,
            mode: ChatMode::default(),
            goal: None,
            plan: None,
            attachments: Vec::new(),
            workspace_context: None,
            workspace_check: None,
        }
    }

    /// The reported bug: asked "what model are you?", a model served over the
    /// HTTPS runner could only describe the transport, because nothing in the
    /// prompt named it.
    #[test]
    fn names_the_model_and_the_provider_serving_it() {
        assert_eq!(
            provider_model_identity(
                &request(Some("DeepSeek"), Some("DeepSeek V4.1 Flash"), Some("deepseek-flash")),
                "over an OpenAI-compatible API",
            ),
            "You are DeepSeek V4.1 Flash (model id `deepseek-flash`), served by DeepSeek over an OpenAI-compatible API in Gyro."
        );
    }

    /// A custom endpoint often has no display name for its models, so the id is
    /// the only name there is and must not be printed twice.
    #[test]
    fn falls_back_to_the_model_id_alone() {
        assert_eq!(
            provider_model_identity(
                &request(
                    Some("My gateway"),
                    Some("llama-3.3-70b"),
                    Some("llama-3.3-70b")
                ),
                "over an OpenAI-compatible API",
            ),
            "You are llama-3.3-70b, served by My gateway over an OpenAI-compatible API in Gyro."
        );
        assert_eq!(
            provider_model_identity(
                &request(None, None, Some("qwen3-coder:30b")),
                "and run locally through Ollama",
            ),
            "You are `qwen3-coder:30b`, reached and run locally through Ollama in Gyro."
        );
    }

    /// A model with nothing to go on must still produce a sentence rather than
    /// an empty claim the model would have to interpret.
    #[test]
    fn stays_a_sentence_when_nothing_is_known() {
        assert_eq!(
            provider_model_identity(&request(None, None, None), "over an OpenAI-compatible API"),
            "You are an unnamed model, reached over an OpenAI-compatible API in Gyro."
        );
    }
}
