//! Imported chats retain their native conversation until the user chooses otherwise.
use super::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ImportedChatState {
    workspace_available: bool,
    resume_unavailable: bool,
}

#[tauri::command]
pub(super) async fn get_imported_chat_state(
    session_id: String,
) -> Result<ImportedChatState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = open_store()?;
        let id = parse_uuid(&session_id)?;
        let session = store
            .get_session(id)
            .map_err(to_string)?
            .ok_or_else(|| "chat no longer exists".to_string())?;
        let binding = session
            .import_source
            .as_ref()
            .filter(|source| !source.fresh_session_requested)
            .map(|source| store.get_provider_session_binding(id, source.source_kind.provider_id()))
            .transpose()
            .map_err(to_string)?
            .flatten();
        let resume_unavailable = session.import_source.as_ref().is_some_and(|source| {
            !source.fresh_session_requested
                && binding.as_ref().map_or(true, |binding| {
                    binding.status == "import-resume-unavailable"
                })
        });
        Ok(ImportedChatState {
            workspace_available: session.workspace_path.is_dir(),
            resume_unavailable,
        })
    })
    .await
    .map_err(|error| format!("imported chat check failed: {error}"))?
}

pub(super) fn apply_data_home(
    process: &mut Command,
    request: &ProviderChatRequest,
) -> anyhow::Result<()> {
    let store = open_store().map_err(anyhow::Error::msg)?;
    let session =
        store.get_session(parse_uuid(&request.session_id).map_err(anyhow::Error::msg)?)?;
    if let Some(session) = session {
        apply_session_data_home(process, &session, request);
    }
    Ok(())
}

pub(super) fn imported_auth_data_home(
    session_id: &str,
    provider_id: &str,
) -> anyhow::Result<Option<(String, String)>> {
    let store = open_store().map_err(anyhow::Error::msg)?;
    imported_auth_data_home_from_store(&store, session_id, provider_id)
}

fn imported_auth_data_home_from_store(
    store: &SessionStore,
    session_id: &str,
    provider_id: &str,
) -> anyhow::Result<Option<(String, String)>> {
    let id = parse_uuid(session_id).map_err(anyhow::Error::msg)?;
    let session = store
        .get_session(id)?
        .ok_or_else(|| anyhow::anyhow!("chat no longer exists"))?;
    let Some(source) = session
        .import_source
        .filter(|source| source.source_kind.provider_id() == provider_id)
    else {
        return Ok(None);
    };
    anyhow::ensure!(
        Path::new(&source.data_home).is_absolute(),
        "imported provider data home must be absolute"
    );
    let variable = match source.source_kind {
        gyro_core::project_import::SourceKind::ClaudeCode => "CLAUDE_CONFIG_DIR",
        gyro_core::project_import::SourceKind::Codex => "CODEX_HOME",
    };
    Ok(Some((variable.into(), source.data_home)))
}

pub(super) fn resolve_login_data_home(
    request: &TerminalPaneRequest,
) -> anyhow::Result<Option<(String, String)>> {
    let Some(session_id) = request.provider_auth_session_id.as_deref() else {
        return Ok(None);
    };
    // Other providers retain their existing login flow, including recovery
    // from a chat that was originally imported from a different provider.
    // Only the exact native login profiles are eligible for a scoped home.
    let Ok(provider_id) = login_provider_id(request) else {
        return Ok(None);
    };
    imported_auth_data_home(session_id, provider_id)
}

fn login_provider_id(request: &TerminalPaneRequest) -> anyhow::Result<&'static str> {
    let provider_id = match (
        request.command.as_str(),
        request
            .args
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .as_slice(),
    ) {
        ("claude", ["auth", "login"]) => "anthropic",
        ("codex", ["login", "--device-auth"]) => "openai",
        _ => {
            anyhow::bail!("Imported sign-in context is only available for provider login commands")
        }
    };
    Ok(provider_id)
}

fn apply_session_data_home(
    process: &mut Command,
    session: &Session,
    request: &ProviderChatRequest,
) {
    if let Some(source) = session
        .import_source
        .as_ref()
        .filter(|source| source.source_kind.provider_id() == request.provider_id)
    {
        let variable = match source.source_kind {
            gyro_core::project_import::SourceKind::ClaudeCode => "CLAUDE_CONFIG_DIR",
            gyro_core::project_import::SourceKind::Codex => "CODEX_HOME",
        };
        process.env(variable, &source.data_home);
    }
}

pub(super) fn requires_native_session(
    store: &SessionStore,
    request: &ProviderChatRequest,
) -> anyhow::Result<bool> {
    let id = parse_uuid(&request.session_id).map_err(anyhow::Error::msg)?;
    Ok(store
        .get_session(id)?
        .and_then(|session| session.import_source)
        .is_some_and(|source| !source.fresh_session_requested))
}

pub(super) fn compatible_binding(
    store: &SessionStore,
    binding: ProviderSessionBinding,
    request: &ProviderChatRequest,
) -> Option<ProviderSessionBinding> {
    // Older transcripts omit the model. Their native session still determines
    // provider continuity; a selected provider model must not discard its ID.
    let source = parse_uuid(&request.session_id)
        .ok()
        .and_then(|id| store.get_session(id).ok().flatten())
        .and_then(|session| session.import_source);
    if binding.model_id.is_none()
        && binding.provider_id == request.provider_id
        && source.is_some_and(|source| {
            !source.fresh_session_requested
                && source.source_kind.provider_id() == binding.provider_id
                && binding
                    .resume_cursor_json
                    .get("sessionId")
                    .and_then(serde_json::Value::as_str)
                    == Some(source.source_session_id.as_str())
        })
    {
        return Some(binding);
    }
    compatible_provider_session_binding(binding, request)
}

pub(super) fn check_continuation(
    store: &SessionStore,
    request: &ProviderChatRequest,
    cursor: Option<&ProviderResumeCursor>,
) -> anyhow::Result<()> {
    let id = parse_uuid(&request.session_id).map_err(anyhow::Error::msg)?;
    let Some(session) = store.get_session(id)? else {
        return Ok(());
    };
    let Some(source) = session.import_source else {
        return Ok(());
    };
    if !session.workspace_path.is_dir() {
        anyhow::bail!("Locate this imported project's folder before sending a message.");
    }
    if !source.fresh_session_requested && cursor.is_none() {
        return unavailable(store, request, "The original provider session is unavailable for the selected model. Retry with its original model, or choose Continue in a new session.");
    }
    Ok(())
}

pub(super) fn unavailable(
    store: &SessionStore,
    request: &ProviderChatRequest,
    detail: &str,
) -> anyhow::Result<()> {
    let id = parse_uuid(&request.session_id).map_err(anyhow::Error::msg)?;
    if let Some(source) = store
        .get_session(id)?
        .and_then(|session| session.import_source)
    {
        if let Some(binding) =
            store.get_provider_session_binding(id, source.source_kind.provider_id())?
        {
            store.upsert_provider_session_binding(
                id,
                binding.provider_id,
                binding.model_id,
                binding.model_label,
                binding.reasoning_effort,
                binding.resume_cursor_json,
                "import-resume-unavailable",
                Some(detail.to_owned()),
            )?;
        }
    }
    store.append_event(
        id,
        SessionEventKind::SystemEvent,
        detail,
        serde_json::json!({
            "kind": "import-resume-unavailable", "detail": detail,
        }),
    )?;
    anyhow::bail!("{detail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imported_auth_scope_comes_from_persisted_matching_provider_metadata() {
        use gyro_core::project_import::SourceKind;
        for kind in [SourceKind::ClaudeCode, SourceKind::Codex] {
            let (_temp, store, session, _) = imported(kind);
            let scope = imported_auth_data_home_from_store(
                &store,
                &session.id.to_string(),
                kind.provider_id(),
            )
            .unwrap()
            .unwrap();
            assert_eq!(scope.1, session.import_source.unwrap().data_home);
            assert_eq!(
                scope.0,
                if kind == SourceKind::Codex {
                    "CODEX_HOME"
                } else {
                    "CLAUDE_CONFIG_DIR"
                }
            );
            assert!(
                imported_auth_data_home_from_store(&store, &session.id.to_string(), "kimi")
                    .unwrap()
                    .is_none()
            );
        }
    }

    #[test]
    fn imported_login_context_is_limited_to_the_existing_cli_sign_in_profiles() {
        for (command, args, provider) in [
            ("claude", vec!["auth", "login"], "anthropic"),
            ("codex", vec!["login", "--device-auth"], "openai"),
        ] {
            let request = TerminalPaneRequest {
                command: command.into(),
                args: args.into_iter().map(str::to_owned).collect(),
                ..Default::default()
            };
            assert_eq!(login_provider_id(&request).unwrap(), provider);
        }
        let request = TerminalPaneRequest {
            command: "sh".into(),
            args: vec!["-c".into(), "echo arbitrary".into()],
            provider_auth_session_id: Some("untrusted".into()),
            ..Default::default()
        };
        assert!(login_provider_id(&request).is_err());
        assert!(resolve_login_data_home(&request).unwrap().is_none());
        let request: TerminalPaneRequest = serde_json::from_value(serde_json::json!({"paneId":"login", "title":"Login", "command":"claude", "args":["auth","login"],"providerDataHome":["CLAUDE_CONFIG_DIR","/untrusted"]})).unwrap();
        assert!(request.provider_data_home.is_none());
        assert!(resolve_login_data_home(&request).unwrap().is_none());
    }
    use chrono::Utc;
    #[test]
    fn existing_desktop_chats_keep_their_retry_behavior() {
        let temp = tempfile::tempdir().unwrap();
        let store =
            SessionStore::open(GyroPaths::from_base_dir(temp.path().to_path_buf())).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "ordinary chat")
            .unwrap();
        let request: ProviderChatRequest = serde_json::from_value(serde_json::json!({
            "sessionId": session.id, "message": "hello", "providerId": "anthropic"
        }))
        .unwrap();
        assert!(!requires_native_session(&store, &request).unwrap());
        assert!(check_continuation(&store, &request, None).is_ok());
        assert!(
            imported_auth_data_home_from_store(&store, &session.id.to_string(), "anthropic")
                .unwrap()
                .is_none()
        );
    }

    fn imported(
        kind: gyro_core::project_import::SourceKind,
    ) -> (
        tempfile::TempDir,
        SessionStore,
        Session,
        ProviderChatRequest,
    ) {
        use gyro_core::project_import::{NormalizedProjectImport, ProjectImportCandidate};
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("gyro"))).unwrap();
        let native_id = Uuid::new_v4().to_string();
        let now = Utc::now();
        let candidate = ProjectImportCandidate {
            id: Uuid::new_v4().to_string(),
            source_kind: kind,
            source_session_id: native_id,
            data_home: temp.path().to_string_lossy().into_owned(),
            transcript_path: temp
                .path()
                .join("source.jsonl")
                .to_string_lossy()
                .into_owned(),
            workspace_path: temp.path().to_string_lossy().into_owned(),
            title: "Imported chat".into(),
            created_at: now,
            updated_at: now,
            model_id: Some("original-model".into()),
            archived: false,
            workspace_available: true,
            event_count: 1,
            diagnostics: vec![],
            existing_session_id: None,
        };
        let event = SessionEvent::new(
            Uuid::nil(),
            SessionEventKind::UserMessage,
            "Hello",
            serde_json::json!({}),
        );
        let session = store
            .import_project_session(NormalizedProjectImport {
                candidate,
                events: vec![event],
                diagnostics: vec![],
            })
            .unwrap()
            .session;
        let request = serde_json::from_value(serde_json::json!({
            "sessionId": session.id, "message": "Continue", "providerId": kind.provider_id(),
            "modelId": "original-model", "turnId": Uuid::new_v4(),
        }))
        .unwrap();
        (temp, store, session, request)
    }

    #[test]
    fn both_providers_keep_the_native_id_and_never_silently_start_fresh() {
        use gyro_core::project_import::SourceKind;
        for kind in [SourceKind::ClaudeCode, SourceKind::Codex] {
            let (_temp, store, session, request) = imported(kind);
            let binding = store
                .get_provider_session_binding(session.id, kind.provider_id())
                .unwrap()
                .unwrap();
            let expected = session
                .import_source
                .as_ref()
                .unwrap()
                .source_session_id
                .clone();
            let mut attempts = 0;
            let result = run_provider_chat_with_retry_using(
                &store,
                &request,
                Some(binding),
                |cursor, _| {
                    attempts += 1;
                    assert_eq!(cursor.unwrap().session_id, expected);
                    assert_eq!(cursor.unwrap().kind, kind.cursor_kind());
                    Err(anyhow::anyhow!("session not found"))
                },
                || None,
            );
            assert!(result
                .unwrap_err()
                .to_string()
                .contains("Continue in a new session"));
            assert_eq!(attempts, 1);
            let kept = store
                .get_provider_session_binding(session.id, kind.provider_id())
                .unwrap()
                .unwrap();
            assert_eq!(kept.resume_cursor_json["sessionId"], expected);
            assert_eq!(kept.status, "import-resume-unavailable");
        }
    }

    #[test]
    fn missing_cursor_requires_the_explicit_fresh_session_action() {
        let (_temp, store, session, request) =
            imported(gyro_core::project_import::SourceKind::Codex);
        store
            .clear_all_provider_session_bindings(session.id)
            .unwrap();
        assert!(check_continuation(&store, &request, None).is_err());
        store.continue_import_in_new_session(session.id).unwrap();
        assert!(check_continuation(&store, &request, None).is_ok());
        assert!(!requires_native_session(&store, &request).unwrap());
    }

    #[test]
    fn older_imports_without_model_metadata_keep_their_native_session() {
        let (_temp, store, session, request) =
            imported(gyro_core::project_import::SourceKind::Codex);
        let mut binding = store
            .get_provider_session_binding(session.id, "openai")
            .unwrap()
            .unwrap();
        binding.model_id = None;
        assert!(compatible_binding(&store, binding.clone(), &request).is_some());
        let mut other_provider = request.clone();
        other_provider.provider_id = "anthropic".into();
        assert!(compatible_binding(&store, binding, &other_provider).is_none());
    }

    #[test]
    fn both_provider_runners_receive_the_original_data_home() {
        use gyro_core::project_import::SourceKind;
        for (kind, variable) in [
            (SourceKind::ClaudeCode, "CLAUDE_CONFIG_DIR"),
            (SourceKind::Codex, "CODEX_HOME"),
        ] {
            let (_temp, _store, session, request) = imported(kind);
            let mut process = Command::new("provider-test");
            apply_session_data_home(&mut process, &session, &request);
            let expected = std::ffi::OsStr::new(&session.import_source.as_ref().unwrap().data_home);
            assert_eq!(
                process
                    .get_envs()
                    .find(|(name, _)| *name == std::ffi::OsStr::new(variable))
                    .unwrap()
                    .1,
                Some(expected)
            );
        }
    }
}
