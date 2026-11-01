//! Observe raw deltas from every provider, including ACP and owned API runners.
//! Native runners that already extract titles still use the same rename guard.
use super::*;

#[derive(Default)]
pub(super) struct SessionTitleStream {
    hold: String,
    complete: bool,
}

impl SessionTitleStream {
    fn push(&mut self, delta: &str, finished: bool) -> Option<String> {
        if self.complete {
            return None;
        }
        let parsed = take_visible_stream_text(&mut self.hold, delta, finished);
        // Keep only a partial marker/title, never the growing conversation.
        // A malformed unterminated title must not grow this buffer indefinitely.
        if parsed.title.is_some() || finished || self.hold.len() > 1024 {
            self.complete = true;
            self.hold.clear();
        }
        parsed.title
    }
}

pub(super) fn observe(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    phase: &str,
    delta: Option<&str>,
) {
    if !request.suggest_title || !matches!(phase, "delta" | "completed") {
        return;
    }
    let Some(control) = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .and_then(|flags| flags.get(&request.session_id).cloned())
    else {
        return;
    };
    let title = control
        .title_stream
        .lock()
        .ok()
        .and_then(|mut stream| stream.push(delta.unwrap_or_default(), phase == "completed"));
    if let Some(title) = title {
        publish_streamed_session_title(
            app,
            request,
            &format!("{GYRO_SESSION_TITLE_MARKER} {title}\n"),
            true,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_title_json_bridge_names_each_action_without_weakening_validation() {
        for action in [
            r#"{"type":"catalog","prefix":"gyro_workspace_read"}"#,
            r#"{"type":"tool","name":"gyro_workspace_read","arguments":{"path":"README.md"}}"#,
            r#"{"type":"final","content":"Done."}"#,
        ] {
            let mut value: serde_json::Value = serde_json::from_str(action).unwrap();
            assert!(parse_ollama_compatibility_action(action)
                .unwrap()
                .1
                .is_none());
            value["session_title"] = serde_json::json!("Inspect workspace files");
            let (_, title) = parse_ollama_compatibility_action(&value.to_string()).unwrap();
            assert_eq!(title.as_deref(), Some("Inspect workspace files"));
            value["unexpected"] = serde_json::json!(true);
            assert!(parse_ollama_compatibility_action(&value.to_string()).is_err());
        }
        for title in [
            serde_json::json!(""),
            serde_json::json!(123),
            serde_json::Value::Null,
        ] {
            let action =
                serde_json::json!({"type":"final","content":"Done.","session_title":title});
            assert!(parse_ollama_compatibility_action(&action.to_string())
                .unwrap()
                .1
                .is_none());
        }
        let instructions = ollama_compatibility_system("Model identity.");
        assert!(instructions.contains("session_title"));
        assert!(instructions.contains("first JSON action"));
    }

    #[test]
    fn session_title_arrives_before_turn_completion_at_every_chunk_boundary() {
        let text = "GYRO_SESSION_TITLE: Fix café layout\nInspecting the files.";
        for split in text.char_indices().map(|(index, _)| index) {
            let mut stream = SessionTitleStream::default();
            let first = stream.push(&text[..split], false);
            let second = stream.push(&text[split..], false);
            assert_eq!(first.or(second).as_deref(), Some("Fix café layout"));
            assert!(stream
                .push("GYRO_SESSION_TITLE: Second title\n", false)
                .is_none());
        }
    }

    #[test]
    fn session_title_waits_for_newline_or_completed_response() {
        let mut stream = SessionTitleStream::default();
        assert!(stream.push("GYRO_SESSION_TITLE: Fix", false).is_none());
        assert!(stream.push(" layout", false).is_none());
        assert_eq!(stream.push("", true).as_deref(), Some("Fix layout"));
    }

    #[test]
    fn session_title_stream_does_not_retain_the_conversation() {
        let mut stream = SessionTitleStream::default();
        for _ in 0..100 {
            assert!(stream.push("Ordinary commentary. ", false).is_none());
            assert!(stream.hold.is_empty());
        }
        assert!(stream.push("GYRO_SESSION_TITLE: ", false).is_none());
        assert!(stream.push(&"x".repeat(1024), false).is_none());
        assert!(stream.hold.is_empty());
        assert!(stream.push("\n", false).is_none());
    }
}
