use super::*;

#[test]
fn streaming_state_keeps_the_session_title_off_the_visible_text() {
    let mut state = StreamingCommandState::new();
    state.push_assistant_delta("I'll check the window. GYRO_SESS");
    state.push_assistant_delta("ION_TITLE: Auto compact all providers");
    let shown = state.take_pending_delta();
    assert_eq!(state.assistant_text, "I'll check the window. ");
    assert_eq!(shown, "I'll check the window. ");
    assert!(!shown.contains("GYRO_SESSION_TITLE"));
    assert!(state.captured_session_title.is_none());
    state.close_session_title_hold();
    assert_eq!(
        state.captured_session_title.as_deref(),
        Some("Auto compact all providers")
    );
    assert!(!state.assistant_text.contains("GYRO_SESSION_TITLE"));

    let mut state = StreamingCommandState::new();
    state.push_assistant_delta(
        "GYRO_SESSION_TITLE: Auto compact all providers\nI'll check the window.",
    );
    assert_eq!(
        state.captured_session_title.as_deref(),
        Some("Auto compact all providers")
    );
    assert_eq!(state.assistant_text, "I'll check the window.");
    assert!(!state.take_pending_delta().contains("GYRO_SESSION_TITLE"));
}

#[test]
fn session_titles_come_from_the_user_message_for_every_model() {
    assert_eq!(
        session_title_from_message("please fix the model picker").as_deref(),
        Some("Fix The Model Picker")
    );
    assert_eq!(
        session_title_from_message("can you help me rename API sessions?").as_deref(),
        Some("Help Me Rename API Sessions")
    );
    assert_eq!(
        session_title_from_message("/review the CSS change").as_deref(),
        Some("The CSS Change")
    );
    assert_eq!(
        session_title_from_message("fix the `picker` now").as_deref(),
        Some("Fix The Picker Now")
    );
    assert_eq!(
        session_title_from_message("look\n```\nsecret\n```\nat the bug").as_deref(),
        Some("Look")
    );
    assert_eq!(
        session_title_from_message("one two three four five six seven").as_deref(),
        Some("One Two Three Four Five Six")
    );
    // A numbered or bulleted opening names the task, never the marker.
    assert_eq!(
        session_title_from_message("1. The Workspace needs an upgrade.\n\n2. Tools for AI models.")
            .as_deref(),
        Some("The Workspace Needs An Upgrade")
    );
    assert_eq!(
        session_title_from_message("- fix the picker").as_deref(),
        Some("Fix The Picker")
    );
    assert_eq!(
        session_title_from_message("1) fix the picker").as_deref(),
        Some("Fix The Picker")
    );
    assert!(session_title_from_message("1.").is_none());
    assert!(session_title_from_message("   ").is_none());
    assert!(is_generic_session_title("New chat"));
    assert!(is_generic_session_title("Desktop session"));
    // A marker-only title is never a name the user chose, so the model may
    // still replace it.
    assert!(is_generic_session_title("1"));
    assert!(!is_generic_session_title("Fix The Model Picker"));
}

#[test]
fn streamed_session_title_waits_for_complete_line() {
    assert_eq!(completed_stream_title("GYRO_SESSION_TI", false), None);
    assert_eq!(
        completed_stream_title("GYRO_SESSION_TITLE: Fix split", false),
        None
    );
    assert_eq!(
        completed_stream_title("GYRO_SESSION_TITLE: Fix split layout\nWorking", false),
        Some("Fix split layout".into())
    );
    assert_eq!(
        completed_stream_title("GYRO_SESSION_TITLE: Fix split layout", true),
        Some("Fix split layout".into())
    );
    assert_eq!(
        completed_stream_title("GYRO_SESSION_TITLE: \nWorking", false),
        None
    );
    assert_eq!(
        completed_stream_title("Working without a marker", true),
        None
    );
}

/// The provisional title from the user's message is not the last word: the
/// model names the chat on the turn that opens it, and its own title line
/// replaces the provisional one.
#[test]
fn the_model_title_replaces_the_provisional_title() {
    let mut state = suggested_title_for_turn("We Drew Our Own Traffic Lights");
    assert!(
        !state.1,
        "the control must be open or the model can never name the chat"
    );
    assert_eq!(
        streamed_title_replacement(
            &mut state,
            "We Drew Our Own Traffic Lights",
            "GYRO_SESSION_TITLE: Traffic Light Bug\nLet me find the drawing code.",
            true,
        )
        .as_deref(),
        Some("Traffic Light Bug")
    );
}

#[test]
fn a_closed_title_control_ignores_later_markers() {
    let mut state = (Some("Kept".to_string()), true);
    assert!(
        streamed_title_replacement(&mut state, "Kept", "GYRO_SESSION_TITLE: Late\n", true)
            .is_none()
    );
}

/// Every provider is asked for a title on the turn that opens the chat, so
/// naming does not depend on which model the user picked.
#[test]
fn every_provider_is_asked_for_a_title_on_the_first_turn() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
    let session = store
        .create_session(temp.path(), SessionOrigin::Desktop, "Untitled chat")
        .unwrap();
    let catalog: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../catalog/model-catalog.json")).unwrap();
    let models = catalog["models"].as_array().unwrap();
    let cases = gyro_core::provider_registry()
        .iter()
        .map(|provider| (provider.id, None))
        .chain(
            models
                .iter()
                .map(|model| (model["providerId"].as_str().unwrap(), model["id"].as_str())),
        )
        .chain([("custom-endpoint", Some("custom-model"))]);
    for (provider, model) in cases {
        let mut request = provider_chat_request_for(&session, temp.path(), provider);
        request.model_id = model.map(str::to_string);
        request.suggest_title = true;
        for resumed in [false, true] {
            let context = provider_context_message_for_turn(
                &request,
                None,
                PromptTurn {
                    resumed,
                    ..PromptTurn::default()
                },
            );
            assert_eq!(
                context
                    .matches(SESSION_TITLE_FIRST_TURN_INSTRUCTION.trim_end())
                    .count(),
                1,
                "{provider}/{model:?} must be asked for exactly one title"
            );
        }
        request.suggest_title = false;
        assert!(!provider_context_message(&request)
            .contains(SESSION_TITLE_FIRST_TURN_INSTRUCTION.trim_end()));
    }
}

#[test]
fn the_title_instruction_is_asked_once_per_turn_not_twice() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
    let session = store
        .create_session(temp.path(), SessionOrigin::Desktop, "Untitled chat")
        .unwrap();
    let mut request = provider_chat_request_for(&session, temp.path(), "anthropic");
    request.suggest_title = true;
    let context = provider_context_message(&request);
    assert_eq!(context.matches("GYRO_SESSION_TITLE").count(), 1);
    assert_eq!(
        claude_chat_prompt(&context, None, true, true, false)
            .matches("GYRO_SESSION_TITLE")
            .count(),
        1
    );
    assert_eq!(
        openai_codex_chat_prompt(&context, None, None, true, true, false)
            .matches("GYRO_SESSION_TITLE")
            .count(),
        1
    );
}

#[test]
fn extracts_hidden_session_title_marker() {
    let extracted =
        extract_session_title_marker("GYRO_SESSION_TITLE: Fix Model Picker\n\nDone.", true);

    assert_eq!(extracted.title.as_deref(), Some("Fix Model Picker"));
    assert_eq!(extracted.message, "Done.");

    // Title application is optional; the protocol token must still leave
    // the visible reply even when the app will not rename the session.
    let stripped_without_apply =
        extract_session_title_marker("GYRO_SESSION_TITLE: Fix Model Picker\n\nDone.", false);
    assert!(stripped_without_apply.title.is_none());
    assert_eq!(stripped_without_apply.message, "Done.");
    assert!(!stripped_without_apply
        .message
        .contains("GYRO_SESSION_TITLE"));
}
