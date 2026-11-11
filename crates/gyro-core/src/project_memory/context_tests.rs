use super::*;
use crate::{provider_runtime::types::ProviderChatRequest, GyroPaths, SessionOrigin, SessionStore};
use serde_json::json;

fn request(session: &crate::Session) -> ProviderChatRequest {
    serde_json::from_value(json!({"sessionId":session.id,"providerId":"openai","message":"Run frontend tests","projectMemory":{"fake":"ignored"}})).unwrap()
}

#[test]
fn root_scoping_disable_and_changed_sources_are_enforced_by_the_host() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    std::fs::create_dir_all(project.join(".gyro")).unwrap();
    let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("private"))).unwrap();
    let session = store
        .create_session(&project, SessionOrigin::Desktop, "memory")
        .unwrap();
    let req = request(&session);
    assert!(
        req.project_memory.is_none(),
        "renderer cannot supply host memory"
    );
    let original = "test command";
    std::fs::write(project.join("package.json"), original).unwrap();
    let metadata = json!({"v":2,"id":"tests","kind":"command","sources":[{"kind":"project-file","path":"package.json","contentHash":crate::mutations::content_hash(original.as_bytes())}]});
    std::fs::write(
        project.join(MEMORY_PATH),
        format!("- Run frontend tests with pnpm test\n  <!-- gyro-memory:{metadata} -->\n"),
    )
    .unwrap();
    let first = prepare_memory_context(&store, &session, &req, None).unwrap();
    assert!(first.render(false).0.contains("pnpm test"));
    std::fs::write(project.join("package.json"), "changed").unwrap();
    assert!(prepare_memory_context(&store, &session, &req, None)
        .unwrap()
        .render(false)
        .0
        .is_empty());
    std::fs::write(project.join("package.json"), original).unwrap();
    store
        .set_project_memory_settings(
            &project.canonicalize().unwrap().to_string_lossy(),
            &MemorySettings {
                enabled: false,
                ..Default::default()
            },
        )
        .unwrap();
    assert!(prepare_memory_context(&store, &session, &req, None)
        .unwrap()
        .render(false)
        .0
        .is_empty());
    let other = temp.path().join("other");
    std::fs::create_dir_all(&other).unwrap();
    let other_session = store
        .create_session(&other, SessionOrigin::Desktop, "other")
        .unwrap();
    assert!(
        prepare_memory_context(&store, &other_session, &request(&other_session), None)
            .unwrap()
            .render(false)
            .0
            .is_empty()
    );
}

#[test]
fn receipts_are_idempotent_content_free_and_bound_to_acknowledged_provider_threads() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(temp.path().join(".gyro")).unwrap();
    std::fs::write(
        temp.path().join(MEMORY_PATH),
        "- Run frontend tests with pnpm test\n",
    )
    .unwrap();
    let paths = GyroPaths::from_base_dir(temp.path().join("private"));
    let store = SessionStore::open(paths.clone()).unwrap();
    let session = store
        .create_session(temp.path(), SessionOrigin::Desktop, "memory")
        .unwrap();
    let receipt = prepare_memory_context(&store, &session, &request(&session), None)
        .unwrap()
        .render(false)
        .1;
    let turn = uuid::Uuid::new_v4();
    let cursor = json!({"kind":"codex-session","sessionId":"provider-thread"});
    store
        .record_project_memory_receipt(session.id, turn, "openai", &receipt)
        .unwrap();
    store
        .record_project_memory_receipt(session.id, turn, "openai", &receipt)
        .unwrap();
    let events = store.read_events(session.id).unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.payload["kind"] == "project-memory-context")
            .count(),
        1
    );
    assert!(
        !serde_json::to_string(&store.project_memory_receipts(session.id).unwrap())
            .unwrap()
            .contains("pnpm test")
    );
    assert!(store
        .previous_project_memory_receipt(session.id, "openai", &cursor)
        .unwrap()
        .is_none());
    store
        .acknowledge_project_memory_receipt(
            session.id,
            turn,
            "openai",
            &cursor,
            &MemoryReceipt::default(),
        )
        .unwrap();
    assert!(
        store
            .previous_project_memory_receipt(session.id, "openai", &cursor)
            .unwrap()
            .is_none(),
        "mismatched receipt cannot acknowledge a different payload"
    );
    store
        .acknowledge_project_memory_receipt(session.id, turn, "openai", &cursor, &receipt)
        .unwrap();
    assert!(store
        .previous_project_memory_receipt(session.id, "anthropic", &cursor)
        .unwrap()
        .is_none());
    assert!(store
        .previous_project_memory_receipt(
            session.id,
            "openai",
            &json!({"kind":"codex-session","sessionId":"different"})
        )
        .unwrap()
        .is_none());
    drop(store);
    let reopened = SessionStore::open(paths).unwrap();
    assert_eq!(
        reopened
            .previous_project_memory_receipt(session.id, "openai", &cursor)
            .unwrap(),
        Some(receipt)
    );
}

#[cfg(unix)]
#[test]
fn confined_reads_reject_symlinked_directories_files_and_nonregular_sources() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("project");
    let outside = temp.path().join("outside");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("memory.md"), "private").unwrap();
    std::os::unix::fs::symlink(&outside, root.join(".gyro")).unwrap();
    assert!(read_project_memory(&root).is_err());
    std::fs::remove_file(root.join(".gyro")).unwrap();
    std::fs::create_dir(root.join(".gyro")).unwrap();
    std::os::unix::fs::symlink(outside.join("memory.md"), root.join(MEMORY_PATH)).unwrap();
    assert!(read_project_memory(&root).is_err());
    std::fs::remove_file(root.join(MEMORY_PATH)).unwrap();
    assert!(read_project_memory(&root).unwrap().is_none());
    std::fs::create_dir(root.join(MEMORY_PATH)).unwrap();
    assert!(read_project_memory(&root).is_err());
}

#[test]
fn unchanged_memory_costs_zero_bytes_on_continue_and_failed_dispatch_forces_reset() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(temp.path().join(".gyro")).unwrap();
    std::fs::write(
        temp.path().join(MEMORY_PATH),
        "- Run frontend tests with pnpm test\n",
    )
    .unwrap();
    let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("private"))).unwrap();
    let session = store
        .create_session(temp.path(), SessionOrigin::Desktop, "memory")
        .unwrap();
    let receipt = prepare_memory_context(&store, &session, &request(&session), None)
        .unwrap()
        .render(false)
        .1;
    let turn = uuid::Uuid::new_v4();
    let cursor = json!({"kind":"codex-session","sessionId":"provider-thread"});
    store
        .record_project_memory_receipt(session.id, turn, "openai", &receipt)
        .unwrap();
    store
        .acknowledge_project_memory_receipt(session.id, turn, "openai", &cursor, &receipt)
        .unwrap();
    store
        .upsert_provider_session_binding(
            session.id,
            "openai",
            None,
            None,
            None,
            cursor.clone(),
            "ready",
            None,
        )
        .unwrap();
    let mut next = request(&session);
    next.message = "continue".into();
    let prepared = prepare_memory_context(&store, &session, &next, None).unwrap();
    let (text, reused) = prepared.render(true);
    assert!(text.is_empty());
    assert_eq!(reused.supplied_bytes, 0);
    assert_eq!(reused.roots[0].entries.len(), 1);
    assert!(
        prepared.render(false).0.is_empty(),
        "a fresh continuation does not pay to resend irrelevant retained context"
    );
    store
        .invalidate_project_memory_receipt(session.id, "openai")
        .unwrap();
    let failed = prepare_memory_context(&store, &session, &next, None).unwrap();
    assert!(failed.previous.is_none());
    assert!(
        !failed.render(true).0.is_empty(),
        "an unknown resumed thread receives a reset instead of trusting uncertain delivery"
    );
}

#[test]
fn project_memory_sources_cannot_point_into_a_nested_private_store() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(temp.path().join(".gyro")).unwrap();
    let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("private"))).unwrap();
    std::fs::write(temp.path().join("private/reference.txt"), "fixture").unwrap();
    let metadata = json!({"v":2,"id":"private-ref","kind":"command","sources":[{"kind":"project-file","path":"private/reference.txt","contentHash":crate::mutations::content_hash(b"fixture")}]});
    std::fs::write(
        temp.path().join(MEMORY_PATH),
        format!("- Run frontend tests with pnpm test\n  <!-- gyro-memory:{metadata} -->\n"),
    )
    .unwrap();
    let session = store
        .create_session(temp.path(), SessionOrigin::Desktop, "memory")
        .unwrap();
    assert!(
        prepare_memory_context(&store, &session, &request(&session), None)
            .unwrap()
            .render(false)
            .0
            .is_empty()
    );
}

#[test]
fn new_project_chats_share_memory_across_every_executable_provider_and_model() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    std::fs::create_dir_all(project.join(".gyro")).unwrap();
    std::fs::write(
        project.join(MEMORY_PATH),
        "- Run frontend tests with pnpm test\n",
    )
    .unwrap();
    let paths = GyroPaths::from_base_dir(temp.path().join("private"));
    let store = SessionStore::open(paths.clone()).unwrap();
    let providers: Vec<_> = crate::provider_registry()
        .iter()
        .filter(|provider| crate::provider_is_executable(provider.id))
        .map(|provider| provider.id)
        .chain(["custom:memory-fixture"])
        .collect();
    assert!(providers.len() >= 6);
    for provider in providers {
        for model in ["model-a", "model-b"] {
            for mode in ["normal", "plan", "council"] {
                let session = store
                    .create_session(&project, SessionOrigin::Desktop, "New chat")
                    .unwrap();
                let req: ProviderChatRequest = serde_json::from_value(json!({
                    "sessionId":session.id,"providerId":provider,"modelId":model,
                    "message":"Run frontend tests","mode":mode
                }))
                .unwrap();
                let prepared = prepare_memory_context(&store, &session, &req, Some(32768)).unwrap();
                assert!(
                    prepared.previous.is_none(),
                    "new chat must not inherit another chat's receipt"
                );
                let (text, receipt) = prepared.render(false);
                assert_eq!(
                    text.matches("Run frontend tests with pnpm test").count(),
                    1,
                    "{provider}/{model}/{mode}"
                );
                assert!(receipt.supplied_bytes <= DEFAULT_CONTEXT_BYTES);
            }
        }
    }
    // A fresh store connection/chat must also see project notes after restart.
    drop(store);
    let reopened = SessionStore::open(paths).unwrap();
    let session = reopened
        .create_session(&project, SessionOrigin::Cli, "New chat")
        .unwrap();
    assert!(
        prepare_memory_context(&reopened, &session, &request(&session), None)
            .unwrap()
            .render(false)
            .0
            .contains("pnpm test")
    );
}

#[test]
fn memory_refreshes_after_model_switch_and_edits_from_another_chat() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    std::fs::create_dir_all(project.join(".gyro")).unwrap();
    std::fs::write(
        project.join(MEMORY_PATH),
        "- Run frontend tests with pnpm test\n",
    )
    .unwrap();
    let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("private"))).unwrap();
    let session = store
        .create_session(&project, SessionOrigin::Desktop, "First chat")
        .unwrap();
    let mut req = request(&session);
    req.model_id = Some("model-a".into());
    let receipt = prepare_memory_context(&store, &session, &req, None)
        .unwrap()
        .render(false)
        .1;
    let turn = uuid::Uuid::new_v4();
    let cursor = json!({"kind":"codex-session","sessionId":"acknowledged-thread"});
    store
        .record_project_memory_receipt(session.id, turn, "openai", &receipt)
        .unwrap();
    store
        .acknowledge_project_memory_receipt(session.id, turn, "openai", &cursor, &receipt)
        .unwrap();
    store
        .upsert_provider_session_binding(
            session.id,
            "openai",
            Some("model-a".into()),
            None,
            None,
            cursor,
            "ready",
            None,
        )
        .unwrap();
    assert!(prepare_memory_context(&store, &session, &req, None)
        .unwrap()
        .previous
        .is_some());
    req.model_id = Some("model-b".into());
    let switched = prepare_memory_context(&store, &session, &req, None).unwrap();
    assert!(
        switched.previous.is_none(),
        "a different model cannot reuse the previous model's delivery"
    );
    assert!(switched.render(false).0.contains("pnpm test"));
    let source = read_project_memory(&project).unwrap().unwrap();
    let document = MemoryDocument::parse(&source).unwrap();
    let draft = MemoryDraft {
        text: "Run frontend tests with pnpm verify".into(),
        kind: MemoryKind::Command,
        paths: vec![],
        sources: vec![MemorySource::UserEntered],
        supersedes: None,
    };
    let plan = plan_write(
        Some(&source),
        Some(&document.document_hash),
        MemoryWrite::Edit {
            id: &document.entries[0].id,
            date: "2026-11-11",
            draft: &draft,
        },
    )
    .unwrap();
    std::fs::write(project.join(MEMORY_PATH), plan.content).unwrap();
    let second = store
        .create_session(&project, SessionOrigin::Desktop, "Second chat")
        .unwrap();
    for chat in [&session, &second] {
        let text = prepare_memory_context(&store, chat, &request(chat), None)
            .unwrap()
            .render(false)
            .0;
        assert!(text.contains("pnpm verify"));
        assert!(!text.contains("pnpm test"));
    }
}

#[test]
fn council_memory_remains_read_only_and_internal_helpers_stay_isolated() {
    use crate::provider_runtime::types::{ChatMode, InternalRequestPurpose};
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(temp.path().join(".gyro")).unwrap();
    std::fs::write(
        temp.path().join(MEMORY_PATH),
        "- Run frontend tests with pnpm test\n",
    )
    .unwrap();
    let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("private"))).unwrap();
    let session = store
        .create_session(temp.path(), SessionOrigin::Desktop, "Council chat")
        .unwrap();
    let mut req = request(&session);
    req.mode = ChatMode::Council;
    let memory = prepare_memory_context(&store, &session, &req, None).unwrap();
    assert!(memory.render(false).0.contains("pnpm test"));
    assert!(!memory.suggest_candidates);
    assert!(!crate::capabilities::capability_advertised_for_mode(
        crate::CapabilityId::MemoryWrite,
        crate::CapabilityRunMode::Council
    ));
    for purpose in [
        InternalRequestPurpose::CodeReview,
        InternalRequestPurpose::WorkflowExtraction,
        InternalRequestPurpose::ContextSummary,
        InternalRequestPurpose::ChangeSummary,
        InternalRequestPurpose::SessionTitle,
    ] {
        req.internal_purpose = Some(purpose);
        let memory = prepare_memory_context(&store, &session, &req, None).unwrap();
        assert!(memory.render(false).0.is_empty(), "{purpose:?}");
        assert!(!memory.suggest_candidates);
    }
}
