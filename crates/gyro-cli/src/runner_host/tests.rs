use super::*;
use gyro_core::{CapabilityStatus, MutationProposalStatus, SessionOrigin};

fn fixture(approved: bool, mode: CapabilityRunMode) -> (tempfile::TempDir, CliRunnerHost) {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().canonicalize().unwrap();
    let paths = GyroPaths::from_base_dir(workspace.join("private-data"));
    let store = SessionStore::open(paths.clone()).unwrap();
    let session = store
        .create_session(&workspace, SessionOrigin::Cli, "host fixture")
        .unwrap();
    let profile = GyroConfig::default()
        .command_profiles
        .into_iter()
        .find(|p| p.provider_id.as_deref() == Some("anthropic"))
        .unwrap();
    let host = CliRunnerHost {
        paths,
        session,
        profile,
        config: GyroConfig::default(),
        turn: Uuid::new_v4(),
        request_mode: mode,
        cancellation: CancellationToken::default(),
        approved,
        json: true,
        resumed: false,
        streamed: AtomicBool::new(false),
        event_failure: Mutex::new(None),
        spill_copies: Mutex::new(std::collections::HashMap::new()),
        #[cfg(unix)]
        permission_relay: None,
    };
    (root, host)
}

#[test]
fn headless_proposals_apply_only_the_observed_file_version_and_record_decisions() {
    let (_root, host) = fixture(true, CapabilityRunMode::Normal);
    let path = host.session.workspace_path.join("file.txt");
    std::fs::write(&path, "before\n").unwrap();
    let read = local_tools::invoke(
        &host,
        CapabilityId::WorkspaceRead,
        json!({"path":"file.txt"}),
    )
    .unwrap();
    assert_eq!(read.status, CapabilityStatus::Completed);
    let hash = read.result.unwrap().data["contentHash"].clone();
    let edit = local_tools::invoke(
        &host,
        CapabilityId::WorkspaceProposeEdit,
        json!({"path":"file.txt","content":"after\n","expectedHash":hash}),
    )
    .unwrap();
    assert_eq!(edit.status, CapabilityStatus::Completed);
    let edit_data = edit.result.unwrap().data;
    assert_eq!(edit_data["applied"], true);
    let proposal_id = edit_data["proposalId"].as_str().unwrap().parse().unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "after\n");
    let stale = local_tools::invoke(
        &host,
        CapabilityId::WorkspaceProposeEdit,
        json!({"path":"file.txt","content":"stale\n","expectedHash":hash}),
    )
    .unwrap();
    assert_eq!(stale.status, CapabilityStatus::Failed);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "after\n");
    let proposal = host
        .store()
        .unwrap()
        .get_mutation_proposal(proposal_id)
        .unwrap()
        .unwrap();
    assert_eq!(proposal.status, MutationProposalStatus::Applied);
    assert!(host
        .store()
        .unwrap()
        .list_pending_mutation_proposals_all(20)
        .unwrap()
        .is_empty());
    assert!(host
        .store()
        .unwrap()
        .read_events(host.session.id)
        .unwrap()
        .iter()
        .any(|e| e.kind == SessionEventKind::ApprovalRequested));
}

#[test]
fn json_approvals_fail_closed_and_plan_catalog_cannot_write() {
    let (_root, host) = fixture(false, CapabilityRunMode::Normal);
    let response = local_tools::invoke(
        &host,
        CapabilityId::WorkspaceProposeEdit,
        json!({"path":"new.txt","content":"new"}),
    )
    .unwrap();
    assert_eq!(response.result.unwrap().data["applied"], false);
    assert!(!host.session.workspace_path.join("new.txt").exists());
    let (_root, host) = fixture(true, CapabilityRunMode::Plan);
    assert!(!host
        .tool_catalog()
        .descriptors(CapabilityRunMode::Plan)
        .any(|d| d.id == CapabilityId::WorkspaceProposeEdit));
    assert_eq!(
        local_tools::invoke(
            &host,
            CapabilityId::WorkspaceProposeEdit,
            json!({"path":"new.txt","content":"new"})
        )
        .unwrap()
        .status,
        CapabilityStatus::Failed
    );
    assert!(!host.session.workspace_path.join("new.txt").exists());
}

#[test]
fn catalog_reads_are_bounded_and_do_not_expose_private_data_or_unknown_spills() {
    let (_root, host) = fixture(true, CapabilityRunMode::Normal);
    std::fs::write(host.session.workspace_path.join("public.txt"), "public\n").unwrap();
    let listed = local_tools::invoke(&host, CapabilityId::WorkspaceList, json!({})).unwrap();
    assert_eq!(
        listed.status,
        CapabilityStatus::Completed,
        "{:?}",
        listed.error
    );
    let listed = listed.result.unwrap().data;
    assert!(listed["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["path"] == "public.txt"));
    assert!(!listed["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["path"] == "private-data"));
    for path in [
        "../outside",
        ".env",
        "private-data/gyro.sqlite3",
        "spill://workspace-read/read/0000000000000000",
    ] {
        assert_eq!(
            local_tools::invoke(&host, CapabilityId::WorkspaceRead, json!({"path":path}))
                .unwrap()
                .status,
            CapabilityStatus::Failed,
            "{path}"
        );
    }
    std::fs::write(
        host.session.workspace_path.join("large.txt"),
        vec![b'x'; 1024 * 1024 + 1],
    )
    .unwrap();
    assert_eq!(
        local_tools::invoke(
            &host,
            CapabilityId::WorkspaceRead,
            json!({"path":"large.txt"})
        )
        .unwrap()
        .status,
        CapabilityStatus::Failed
    );
    let unicode = "αβγ\n".repeat(400);
    std::fs::write(host.session.workspace_path.join("unicode.txt"), &unicode).unwrap();
    let read = local_tools::invoke(
        &host,
        CapabilityId::WorkspaceRead,
        json!({"path":"unicode.txt","maxBytes":1024}),
    )
    .unwrap()
    .result
    .unwrap()
    .data;
    assert!(read["truncated"].as_bool().unwrap());
    assert!(read["nextLine"].as_u64().unwrap() > 1);
    assert_eq!(
        read["contentHash"],
        gyro_core::mutations::content_hash(unicode.as_bytes())
    );
    assert!(serde_json::to_vec(&read).unwrap().len() < 1024);
    let content = "readable evidence\n".repeat(300);
    std::fs::write(host.session.workspace_path.join("retired.txt"), &content).unwrap();
    let _ = local_tools::invoke(
        &host,
        CapabilityId::WorkspaceRead,
        json!({"path":"retired.txt"}),
    )
    .unwrap();
    let address = host
        .spill_copies
        .lock()
        .unwrap()
        .keys()
        .next()
        .unwrap()
        .clone();
    let recovered = local_tools::invoke(
        &host,
        CapabilityId::WorkspaceRead,
        json!({"path":address,"offset":0}),
    )
    .unwrap()
    .result
    .unwrap()
    .data;
    assert_eq!(recovered["source"], "spill");
    assert_eq!(recovered["content"], &content[..2000]);
    assert_eq!(recovered["nextOffset"], 2000);
}

#[cfg(unix)]
#[test]
fn descriptor_reads_reject_leaf_and_parent_symlink_escapes() {
    use std::os::unix::fs::symlink;
    let (_root, host) = fixture(true, CapabilityRunMode::Normal);
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.txt"), "outside sentinel").unwrap();
    symlink(
        outside.path().join("secret.txt"),
        host.session.workspace_path.join("leaf.txt"),
    )
    .unwrap();
    symlink(outside.path(), host.session.workspace_path.join("parent")).unwrap();
    for path in ["leaf.txt", "parent/secret.txt"] {
        let response =
            local_tools::invoke(&host, CapabilityId::WorkspaceRead, json!({"path":path})).unwrap();
        assert_eq!(response.status, CapabilityStatus::Failed);
        assert!(!response.error.unwrap().message.contains("outside sentinel"));
    }
}

#[test]
fn prepared_write_approval_commits_its_exact_transaction_and_owner() {
    let (_root, host) = fixture(true, CapabilityRunMode::Normal);
    let file = host.session.workspace_path.join("review.txt");
    std::fs::write(&file, "before\n").unwrap();
    let (transaction, details) = gyro_core::mutations::prepare_provider_text_replacement_review(
        &host.session.workspace_path,
        &file,
        "after\n",
    )
    .unwrap();
    assert_eq!(
        host.apply_prepared("file-change", details, Some(transaction))
            .unwrap(),
        ProviderApprovalDecision::AppliedByGyro
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "after\n");
    let events = host.store().unwrap().read_events(host.session.id).unwrap();
    let requested = events
        .iter()
        .find(|e| e.kind == SessionEventKind::ApprovalRequested)
        .unwrap();
    let applied = events
        .iter()
        .find(|e| e.payload["status"] == "applied")
        .unwrap();
    assert_eq!(
        requested.payload["approvalId"],
        applied.payload["approvalId"]
    );
    let other = tempfile::tempdir().unwrap();
    let file = other.path().canonicalize().unwrap().join("other.txt");
    let (transaction, details) = gyro_core::mutations::prepare_provider_text_replacement_review(
        &other.path().canonicalize().unwrap(),
        &file,
        "outside",
    )
    .unwrap();
    assert!(host
        .apply_prepared("file-change", details, Some(transaction))
        .is_err());
    assert!(!file.exists());
    assert!(host
        .invoke_capability(
            &Uuid::new_v4().to_string(),
            CapabilityId::WorkspaceList,
            json!({})
        )
        .is_err());
    host.cancellation.cancel();
    assert!(host.ensure_active().is_err());
}
