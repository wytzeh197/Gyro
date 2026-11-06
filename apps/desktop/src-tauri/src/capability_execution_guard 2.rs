//! Revalidate the owning chat after a potentially long approval wait.
use super::*;

pub(super) fn rejection(
    app: &tauri::AppHandle,
    store: &SessionStore,
    bound: &BoundProviderCapabilityContext,
    request: &CapabilityRequest,
    cancellation: &CancellationToken,
) -> Option<CapabilityResponse> {
    let (code, message) = validate(store, bound, cancellation).err()?;
    let _ = capability_event(
        app,
        bound,
        request.context.call_id,
        request.capability_id,
        if code == "cancelled" {
            CapabilityStatus::Cancelled
        } else {
            CapabilityStatus::Failed
        },
        &message,
        None,
    );
    Some(CapabilityResponse::failed(
        env!("CARGO_PKG_VERSION"),
        request.context.call_id,
        code,
        message,
    ))
}

pub(super) fn validate(
    store: &SessionStore,
    bound: &BoundProviderCapabilityContext,
    cancellation: &CancellationToken,
) -> Result<(), (&'static str, String)> {
    if cancellation.is_cancelled() || code_mode::cancelled() {
        return Err(("cancelled", "The provider run was cancelled.".into()));
    }
    let session_id = Uuid::parse_str(&bound.session_id)
        .map_err(|error| ("invalid-session", error.to_string()))?;
    let session = store
        .get_session(session_id)
        .map_err(|error| ("storage-unavailable", error.to_string()))?
        .ok_or_else(|| ("missing-session", "The owning chat was deleted.".into()))?;
    let known_root = session
        .workspace_identity
        .roots
        .iter()
        .any(|root| root.path == bound.workspace)
        || (session.workspace_path.as_os_str().is_empty()
            && store
                .paths()
                .sessions_dir
                .join("workspaces")
                .join(session_id.to_string())
                .canonicalize()
                .ok()
                .as_ref()
                == Some(&bound.workspace));
    if session.workspace_identity.revision != bound.workspace_identity_revision || !known_root {
        return Err((
            "workspace-changed",
            "Workspace roots changed while the action was waiting; resume the chat to use the current roots."
                .into(),
        ));
    }
    let current = bound.workspace.canonicalize().map_err(|_| {
        (
            "missing-workspace",
            "The Workspace root is no longer available.".into(),
        )
    })?;
    if current != bound.workspace || !current.is_dir() {
        return Err((
            "workspace-changed",
            "The Workspace root changed on disk.".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retrieving_owned_research_is_inspection_rather_than_another_model_run() {
        assert_eq!(
            effective_capability_class(
                Path::new("/tmp"),
                CapabilityId::ResearchRun,
                &serde_json::json!({"sessionId":Uuid::new_v4()})
            )
            .unwrap(),
            CapabilityClass::WorkspaceInspect
        );
        assert_eq!(
            effective_capability_class(
                Path::new("/tmp"),
                CapabilityId::ResearchRun,
                &serde_json::json!({"question":"inspect parser"})
            )
            .unwrap(),
            CapabilityClass::AgentRun
        );
    }

    fn fixture() -> (
        tempfile::TempDir,
        SessionStore,
        BoundProviderCapabilityContext,
    ) {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("data"))).unwrap();
        let session = store
            .create_session(&workspace, SessionOrigin::Desktop, "guard")
            .unwrap();
        let workspace = workspace.canonicalize().unwrap();
        let workspace_key = workspace.display().to_string();
        let bound = BoundProviderCapabilityContext {
            session_id: session.id.to_string(),
            turn_id: Some(Uuid::new_v4().to_string()),
            provider_id: "ollama".into(),
            workspace,
            workspace_key: workspace_key.clone(),
            workspace_identity_revision: session.workspace_identity.revision,
            allow_delegation: false,
            policy: CapabilityPolicySnapshot::from_policy(
                &ProjectCapabilityPolicy::defaults(workspace_key.clone()),
                CapabilityRunMode::Normal,
            ),
            workspace_context: WorkspaceContextSnapshot::empty(workspace_key.clone()),
            workspace_check: WorkspaceCheckReport::placeholder(workspace_key),
        };
        (temp, store, bound)
    }

    #[test]
    fn stopped_run_cannot_execute_an_approved_action() {
        let (_temp, store, bound) = fixture();
        let cancellation = CancellationToken::default();
        assert!(validate(&store, &bound, &cancellation).is_ok());
        cancellation.cancel();
        assert_eq!(
            validate(&store, &bound, &cancellation).unwrap_err().0,
            "cancelled"
        );
    }

    #[test]
    fn projectless_chat_can_use_its_existing_private_workspace() {
        let (_temp, store, mut bound) = fixture();
        let session = store
            .create_session(Path::new(""), SessionOrigin::Desktop, "scratch")
            .unwrap();
        bound.session_id = session.id.to_string();
        bound.workspace = store.paths().ensure_chat_workspace(session.id).unwrap();
        bound.workspace_identity_revision = session.workspace_identity.revision;
        assert!(validate(&store, &bound, &CancellationToken::default()).is_ok());
    }

    #[test]
    fn deleted_chat_and_missing_root_invalidate_waiting_actions() {
        let (_temp, store, bound) = fixture();
        let cancellation = CancellationToken::default();
        fs::remove_dir(&bound.workspace).unwrap();
        assert_eq!(
            validate(&store, &bound, &cancellation).unwrap_err().0,
            "missing-workspace"
        );
        fs::create_dir(&bound.workspace).unwrap();
        store
            .delete_session(Uuid::parse_str(&bound.session_id).unwrap())
            .unwrap();
        assert_eq!(
            validate(&store, &bound, &cancellation).unwrap_err().0,
            "missing-session"
        );
    }

    #[test]
    fn secondary_root_is_valid_but_a_new_identity_invalidates_waiting_actions() {
        let (temp, store, mut bound) = fixture();
        let secondary = temp.path().join("secondary");
        fs::create_dir(&secondary).unwrap();
        let secondary = secondary.canonicalize().unwrap();
        let primary = bound.workspace.clone();
        let session_id = Uuid::parse_str(&bound.session_id).unwrap();
        let session = store
            .set_workspace_identity(
                session_id,
                &[bound.workspace.clone(), secondary.clone()],
                &secondary,
            )
            .unwrap();
        bound.workspace = secondary;
        bound.workspace_identity_revision = session.workspace_identity.revision;
        let cancellation = CancellationToken::default();
        assert!(validate(&store, &bound, &cancellation).is_ok());
        store
            .set_workspace_identity(session_id, &[primary.clone()], &primary)
            .unwrap();
        assert_eq!(
            validate(&store, &bound, &cancellation).unwrap_err().0,
            "workspace-changed"
        );
    }
}
