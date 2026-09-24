use super::*;

pub(super) fn bound_workspace_root_id(
    store: &SessionStore,
    bound: &BoundProviderCapabilityContext,
) -> anyhow::Result<String> {
    let session = store
        .get_session(Uuid::parse_str(&bound.session_id)?)?
        .ok_or_else(|| anyhow::anyhow!("owning session is unavailable"))?;
    session
        .workspace_identity
        .roots
        .iter()
        .find(|root| root.path == bound.workspace)
        .map(|root| root.id.clone())
        .ok_or_else(|| anyhow::anyhow!("selected workspace root is no longer in this session"))
}

pub(super) fn create_file_mutation_proposal_impl(
    request: FileMutationProposalRequest,
) -> anyhow::Result<MutationProposal> {
    let store = open_store().map_err(|error| anyhow::anyhow!(error))?;
    create_file_mutation_proposal_in_store(&store, request, false)
}

pub(super) fn create_file_mutation_proposal_in_store(
    store: &SessionStore,
    request: FileMutationProposalRequest,
    apply_immediately: bool,
) -> anyhow::Result<MutationProposal> {
    create_file_mutation_proposal_at_root(store, request, apply_immediately, None)
}

pub(super) fn create_file_mutation_proposal_at_root(
    store: &SessionStore,
    request: FileMutationProposalRequest,
    apply_immediately: bool,
    root_id: Option<&str>,
) -> anyhow::Result<MutationProposal> {
    let session_id = Uuid::parse_str(&request.session_id)?;
    let turn_id = request
        .turn_id
        .as_deref()
        .map(Uuid::parse_str)
        .transpose()?;
    let session = store
        .get_session(session_id)?
        .ok_or_else(|| anyhow::anyhow!("unknown session {session_id}"))?;
    let root = match root_id {
        Some(id) => session
            .workspace_identity
            .root(id)
            .ok_or_else(|| anyhow::anyhow!("workspace root is not in this session"))?
            .canonicalize()?,
        None => session.workspace_path.canonicalize()?,
    };
    let candidate = validated_workspace_file_target(&root, &request.path)?;
    if candidate.is_dir() {
        anyhow::bail!("mutation proposal path is a directory");
    }
    let content_bytes = request.content.as_bytes();
    if content_bytes.len() > MAX_WORKSPACE_FILE_EDIT_BYTES {
        anyhow::bail!("mutation proposal is too large");
    }
    if content_bytes.contains(&0) {
        anyhow::bail!("binary mutation proposals are not supported");
    }
    let base_exists = candidate.exists();
    let expected_hash = if base_exists {
        let (current, _) =
            read_bounded_regular_file(&candidate, MAX_WORKSPACE_FILE_EDIT_BYTES, "workspace file")?;
        if current.len() > MAX_WORKSPACE_FILE_EDIT_BYTES {
            anyhow::bail!("workspace file is too large to edit in Gyro");
        }
        if current.contains(&0) {
            anyhow::bail!("binary workspace files cannot be edited");
        }
        let current_hash = content_hash(&current);
        if let Some(expected) = request.expected_hash.as_deref() {
            if current_hash != expected {
                anyhow::bail!("file changed on disk; reload before proposing an edit");
            }
        }
        Some(current_hash)
    } else {
        if request.expected_hash.is_some() {
            anyhow::bail!("cannot use an expected hash for a file that does not exist");
        }
        None
    };
    let proposal = store.create_mutation_proposal_at_root(
        session_id,
        turn_id,
        root_id,
        &request.path,
        request.content,
        expected_hash,
        base_exists,
    )?;
    // Full access authorizes this write, but it still goes through the same
    // hash guard, atomic replacement and durable decision as a reviewed edit.
    // Do not emit a pending approval for an already authorized operation.
    if apply_immediately {
        let result = decide_mutation_proposal(store, proposal.id, MutationDecision::Approve)?;
        let _ = store.mark_mutation_proposal_surfaced(proposal.id);
        return Ok(result.proposal);
    }
    let payload = mutation_approval_payload(&proposal, None);
    store.append_event_with_turn_id(
        session_id,
        SessionEventKind::FileEditProposed,
        format!("Proposed {}", proposal.path),
        payload.clone(),
        turn_id,
    )?;
    store.append_event_with_turn_id(
        session_id,
        SessionEventKind::ApprovalRequested,
        format!("Review changes to {}", proposal.path),
        payload,
        turn_id,
    )?;
    let _ = store.mark_mutation_proposal_surfaced(proposal.id);
    Ok(proposal)
}

pub(super) fn resolve_file_mutation_proposal_impl(
    request: FileMutationDecisionRequest,
) -> anyhow::Result<FileMutationDecisionResult> {
    let store = open_store().map_err(|error| anyhow::anyhow!(error))?;
    let proposal_id = Uuid::parse_str(&request.proposal_id)?;
    let decision = match request.decision.as_str() {
        "approve" => MutationDecision::Approve,
        "reject" => MutationDecision::Reject,
        _ => anyhow::bail!("mutation decision must be approve or reject"),
    };
    let result = decide_mutation_proposal(&store, proposal_id, decision)?;
    let file = result
        .changed_path
        .as_ref()
        .map(|_| {
            read_workspace_file_with_limit(
                &result.proposal.workspace_path.to_string_lossy(),
                &result.proposal.path,
                MAX_WORKSPACE_FILE_EDIT_BYTES,
            )
        })
        .transpose()?;
    Ok(FileMutationDecisionResult {
        proposal: result.proposal,
        event: result.event,
        file,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn full_access_workspace_edit_applies_without_a_pending_approval() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "edit")
            .unwrap();
        let target = temp.path().join("test.txt");
        fs::write(&target, "before").unwrap();
        let request = || FileMutationProposalRequest {
            session_id: session.id.to_string(),
            turn_id: Some(Uuid::new_v4().to_string()),
            path: "test.txt".into(),
            content: "after".into(),
            expected_hash: Some(content_hash(b"before")),
        };
        let proposal = create_file_mutation_proposal_in_store(&store, request(), true).unwrap();
        assert_eq!(proposal.status.as_str(), "applied");
        assert_eq!(fs::read_to_string(&target).unwrap(), "after");
        let events = store.read_recent_events(session.id, 20).unwrap();
        assert!(!events
            .iter()
            .any(|event| event.kind == SessionEventKind::ApprovalRequested));
        assert!(events
            .iter()
            .any(|event| event.payload["status"] == "applied"));
        assert!(create_file_mutation_proposal_in_store(&store, request(), true).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "after");
    }

    #[test]
    fn reviewed_workspace_edit_remains_pending_until_approved() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "edit")
            .unwrap();
        let proposal = create_file_mutation_proposal_in_store(
            &store,
            FileMutationProposalRequest {
                session_id: session.id.to_string(),
                turn_id: Some(Uuid::new_v4().to_string()),
                path: "test.txt".into(),
                content: "review me".into(),
                expected_hash: None,
            },
            false,
        )
        .unwrap();
        assert_eq!(proposal.status.as_str(), "pending");
        assert!(!temp.path().join("test.txt").exists());
        let events = store.read_recent_events(session.id, 20).unwrap();
        assert!(events
            .iter()
            .any(|event| event.kind == SessionEventKind::ApprovalRequested));
    }

    #[test]
    fn reviewed_edit_targets_the_selected_secondary_root() {
        let temp = tempfile::tempdir().unwrap();
        let primary = temp.path().join("primary");
        let secondary = temp.path().join("secondary");
        fs::create_dir_all(&primary).unwrap();
        fs::create_dir_all(&secondary).unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(&primary, SessionOrigin::Desktop, "multi-root edit")
            .unwrap();
        let session = store
            .set_workspace_identity(
                session.id,
                &[primary.clone(), secondary.clone()],
                &secondary,
            )
            .unwrap();
        let root_id = session.workspace_identity.active_root_id.clone();
        let proposal = create_file_mutation_proposal_at_root(
            &store,
            FileMutationProposalRequest {
                session_id: session.id.to_string(),
                turn_id: Some(Uuid::new_v4().to_string()),
                path: "test.txt".into(),
                content: "secondary content".into(),
                expected_hash: None,
            },
            false,
            Some(&root_id),
        )
        .unwrap();
        assert_eq!(proposal.workspace_path, secondary.canonicalize().unwrap());
        decide_mutation_proposal(&store, proposal.id, MutationDecision::Approve).unwrap();
        assert_eq!(
            fs::read_to_string(secondary.join("test.txt")).unwrap(),
            "secondary content"
        );
        assert!(!primary.join("test.txt").exists());
    }

    #[test]
    fn pending_edit_cannot_apply_after_its_root_is_removed() {
        let temp = tempfile::tempdir().unwrap();
        let primary = temp.path().join("primary");
        let secondary = temp.path().join("secondary");
        fs::create_dir_all(&primary).unwrap();
        fs::create_dir_all(&secondary).unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(&primary, SessionOrigin::Desktop, "removed root")
            .unwrap();
        let session = store
            .set_workspace_identity(
                session.id,
                &[primary.clone(), secondary.clone()],
                &secondary,
            )
            .unwrap();
        let proposal = create_file_mutation_proposal_at_root(
            &store,
            FileMutationProposalRequest {
                session_id: session.id.to_string(),
                turn_id: None,
                path: "test.txt".into(),
                content: "not applied".into(),
                expected_hash: None,
            },
            false,
            Some(&session.workspace_identity.active_root_id),
        )
        .unwrap();
        store
            .set_workspace_identity(session.id, &[primary.clone()], &primary)
            .unwrap();
        let error = decide_mutation_proposal(&store, proposal.id, MutationDecision::Approve)
            .unwrap_err()
            .to_string();
        assert!(error.contains("root was removed"), "{error}");
        assert!(!secondary.join("test.txt").exists());
    }
}
