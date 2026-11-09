#[cfg(test)]
use gyro_core::provider_runtime::{
    runners::openai_compatible::{
        assistant_tool_message, continue_owned_output_limit, openai_compat_tool_unsupported,
        user_content, OwnedOutputLimit,
    },
    types::{ChatAttachmentRequest, ProviderChatRequest},
};
#[cfg(test)]
use std::fs;
#[cfg(test)]
mod image_tests {
    use super::*;
    use base64::Engine;

    #[test]
    fn a_text_only_length_finish_joins_three_times_then_stays_cut_off() {
        let mut joined = String::new();
        let mut attempts = 0usize;
        for chunk in ["hel", "lo wor", "ld"] {
            assert!(matches!(
                continue_owned_output_limit(chunk, true, true, &mut joined, &mut attempts),
                OwnedOutputLimit::Continue
            ));
        }
        assert_eq!(attempts, 3);
        assert_eq!(joined, "hello world");
        match continue_owned_output_limit("!", true, true, &mut joined, &mut attempts) {
            OwnedOutputLimit::Finish(text) => assert_eq!(text, "hello world!"),
            other => panic!("expected the capped answer, got {other:?}"),
        }
    }

    #[test]
    fn a_finished_continuation_joins_without_a_newline_and_tool_calls_proceed() {
        let mut joined = String::new();
        let mut attempts = 0usize;
        assert!(matches!(
            continue_owned_output_limit("par", true, true, &mut joined, &mut attempts),
            OwnedOutputLimit::Continue
        ));
        match continue_owned_output_limit("tial", false, true, &mut joined, &mut attempts) {
            OwnedOutputLimit::Finish(text) => assert_eq!(text, "partial"),
            other => panic!("expected a joined finish, got {other:?}"),
        }
        let mut joined = String::new();
        assert!(matches!(
            continue_owned_output_limit("call", true, false, &mut joined, &mut attempts),
            OwnedOutputLimit::Proceed
        ));
        assert!(joined.is_empty());
        assert!(matches!(
            continue_owned_output_limit("done", false, true, &mut joined, &mut attempts),
            OwnedOutputLimit::Proceed
        ));
    }

    #[test]
    fn structured_bridge_fallback_requires_an_explicit_tool_rejection() {
        assert!(openai_compat_tool_unsupported(&anyhow::anyhow!(
            "provider returned HTTP 400: tools are not supported"
        )));
        assert!(openai_compat_tool_unsupported(&anyhow::anyhow!(
            "provider returned HTTP 422: function calling unavailable"
        )));
        assert!(!openai_compat_tool_unsupported(&anyhow::anyhow!(
            "provider returned HTTP 401: invalid API key"
        )));
        assert!(!openai_compat_tool_unsupported(&anyhow::anyhow!(
            "provider returned HTTP 400: invalid reasoning effort"
        )));
        for error in [
            "provider returned HTTP 400: invalid tool schema: unsupported field type",
            "provider returned HTTP 400: unsupported tools schema",
            "provider returned HTTP 400: tool messages require a matching tool_call_id",
            "provider returned HTTP 422: function call arguments are invalid",
        ] {
            assert!(!openai_compat_tool_unsupported(&anyhow::anyhow!(error)));
        }
        assert!(openai_compat_tool_unsupported(&anyhow::anyhow!(
            "provider returned HTTP 400: 'tools' is not supported by this model"
        )));
    }

    #[test]
    fn tool_follow_up_replays_reasoning_without_publishing_it_as_text() {
        let calls = vec![serde_json::json!({
            "id": "workspace-read", "type": "function",
            "function": {"name": "gyro_workspace_read_file", "arguments": "{}"}
        })];
        let message =
            assistant_tool_message("Reading the file.", Some("opaque state"), calls.clone());
        assert_eq!(message["content"], "Reading the file.");
        assert_eq!(message["reasoning_content"], "opaque state");
        assert_eq!(message["tool_calls"], serde_json::json!(calls));
        assert!(assistant_tool_message("", None, calls.clone())
            .get("reasoning_content")
            .is_none());
        assert_eq!(
            assistant_tool_message("", Some(""), calls)["reasoning_content"],
            ""
        );
    }

    #[test]
    fn deepseek_vision_is_model_specific() {
        for (model, expected) in [
            ("deepseek-flash", true),
            ("deepseek-v4-flash", true),
            ("deepseek-v4-flash-vision-exp", true),
            ("deepseek-v4-pro", false),
            ("deepseek-chat", false),
        ] {
            let request: ProviderChatRequest = serde_json::from_value(serde_json::json!({
                "sessionId": "test", "providerId": "deepseek", "modelId": model,
                "message": "describe this", "mode": "normal"
            }))
            .unwrap();
            assert_eq!(supports_images(&request), expected, "{model}");
        }
        for provider in [
            "cursor",
            "opencode",
            "mistral",
            "openrouter",
            "custom:gateway",
            "xai",
            "anthropic",
        ] {
            let request: ProviderChatRequest = serde_json::from_value(serde_json::json!({
                "sessionId": "test", "providerId": provider, "modelId": "any",
                "message": "describe this", "mode": "normal"
            }))
            .unwrap();
            assert!(supports_images(&request), "{provider}");
        }
        let ollama: ProviderChatRequest = serde_json::from_value(serde_json::json!({
            "sessionId": "test", "providerId": "ollama", "modelId": "llava",
            "message": "describe this", "mode": "normal"
        }))
        .unwrap();
        assert!(!supports_images(&ollama));
        assert!(image_input_enabled(
            "my-gateway",
            None,
            Some(gyro_core::OPENAI_COMPATIBLE_KIND)
        ));
        assert!(!image_input_enabled("my-gateway", None, None));
        assert!(!image_input_enabled(
            "ollama",
            Some("llava"),
            Some(gyro_core::OPENAI_COMPATIBLE_KIND)
        ));
    }

    #[test]
    fn image_content_delivers_bytes_and_preserves_text_only_requests() {
        assert_eq!(
            user_content("hello", &[]).unwrap(),
            serde_json::json!("hello")
        );
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("capture.png");
        let bytes = b"\x89PNG\r\n\x1a\n";
        fs::write(&path, bytes).unwrap();
        let mut attachment: ChatAttachmentRequest = serde_json::from_value(serde_json::json!({
            "id": "image", "kind": "image", "name": "capture.png",
            "path": path, "mimeType": "image/png", "size": bytes.len()
        }))
        .unwrap();
        let content = user_content("describe this", &[attachment.clone()]).unwrap();
        assert_eq!(content[0]["text"], "describe this");
        assert_eq!(content[1]["type"], "image_url");
        assert_eq!(
            content[1]["image_url"]["url"],
            format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            )
        );
        attachment.mime_type = Some("image/svg+xml".into());
        assert!(user_content("describe this", &[attachment.clone()]).is_err());
        attachment.mime_type = Some("image/png".into());
        fs::remove_file(path).unwrap();
        assert!(user_content("describe this", &[attachment]).is_err());
    }
}

pub(crate) use gyro_core::provider_runtime::api_config::{
    configured_capability_support, supports_images,
};

#[cfg(test)]
use gyro_core::provider_runtime::api_config::image_input_enabled;
