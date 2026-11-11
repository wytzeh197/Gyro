use super::*;
use crate::{mutations::content_hash, GyroPaths, SessionOrigin, SessionStore};
use serde_json::json;
use uuid::Uuid;

fn snapshot(session: Uuid) -> ReviewSnapshot {
    build_snapshot(SnapshotInput {
        previous_review_id: None,
        previous_findings: vec![],
        selected_paths: vec![],
        source_session_id: session,
        source_turn_id: None,
        root_id: "root-a".into(),
        root_key: "/fixture".into(),
        scope: ReviewScope::Uncommitted,
        base_oid: None,
        head_oid: None,
        request: "Fix the arithmetic".into(),
        context: String::new(),
        memory_receipt: None,
        files: vec![CapturedReviewFile {
            original_mode: Some("100644".into()),
            modified_mode: Some("100644".into()),
            path: "src.rs".into(),
            original_path: None,
            original: Some("fn value() -> i32 {\n  1\n}\n".into()),
            modified: Some("fn value() -> i32 {\n  2\n}\n".into()),
            original_hash: Some(content_hash(b"fn value() -> i32 {\n  1\n}\n")),
            modified_hash: Some(content_hash(b"fn value() -> i32 {\n  2\n}\n")),
            status: "modified".into(),
            staged: false,
        }],
        exclusions: vec![],
        witness_before: "same".into(),
        witness_after: "same".into(),
    })
    .unwrap()
}
fn output() -> serde_json::Value {
    json!({"schema":RESULT_SCHEMA,"summary":"One concrete fault","reviewedFiles":["src.rs"],"findings":[{"path":"src.rs","side":"modified","lineStart":2,"lineEnd":2,"severity":"P1","title":"Wrong return value","explanation":"For the specified arithmetic, returning 2 instead of 1 breaks the caller's result."}],"limitations":[]})
}

#[test]
fn immutable_snapshots_refuse_overwrite_tampering_and_incomplete_payloads() {
    let temp = tempfile::tempdir().unwrap();
    let paths = GyroPaths::from_base_dir(temp.path().join("private"));
    let snapshot = snapshot(Uuid::new_v4());
    write_snapshot(&paths, &snapshot).unwrap();
    assert!(write_snapshot(&paths, &snapshot).is_err());
    let loaded = read_snapshot(&paths, snapshot.id).unwrap();
    assert_eq!(loaded.manifest_hash, snapshot.manifest_hash);
    assert!(pack_review_input(&snapshot, 100).is_err());
    assert!(pack_review_input(&snapshot, 48 * 1024)
        .unwrap()
        .contains("Fix the arithmetic"));
    let target = paths
        .base_dir
        .join("code-review-snapshots")
        .join(snapshot.id.to_string())
        .join("snapshot.json");
    let mut changed = serde_json::to_value(&snapshot).unwrap();
    changed["request"] = json!("tampered");
    std::fs::write(target, serde_json::to_vec(&changed).unwrap()).unwrap();
    assert!(read_snapshot(&paths, snapshot.id).is_err());
}

#[test]
fn result_parser_requires_exact_coverage_and_real_snapshot_anchors() {
    let snapshot = snapshot(Uuid::new_v4());
    let review = Uuid::new_v4();
    let parsed = parse_review_result(review, &snapshot, &output().to_string()).unwrap();
    assert_eq!(parsed.findings.len(), 1);
    assert_eq!(parsed.findings[0].anchor_hash, content_hash(b"  2"));
    for (key, value) in [
        ("path", json!("../outside.rs")),
        ("lineStart", json!(0)),
        ("lineEnd", json!(100)),
        ("side", json!("invented")),
        ("severity", json!("critical")),
    ] {
        let mut invalid = output();
        invalid["findings"][0][key] = value;
        assert!(parse_review_result(review, &snapshot, &invalid.to_string()).is_err());
    }
    for files in [
        json!([]),
        json!(["src.rs", "not-captured.rs"]),
        json!(["src.rs", "src.rs"]),
    ] {
        let mut invalid = output();
        invalid["reviewedFiles"] = files;
        assert!(parse_review_result(review, &snapshot, &invalid.to_string()).is_err());
    }
    assert!(parse_review_result(review, &snapshot, "I found no issues").is_err());
}

#[test]
fn review_transitions_are_revision_guarded_and_model_output_cannot_approve_edits() {
    let temp = tempfile::tempdir().unwrap();
    let paths = GyroPaths::from_base_dir(temp.path().join("private"));
    let store = SessionStore::open(paths.clone()).unwrap();
    let session = store
        .create_session(temp.path(), SessionOrigin::Desktop, "review")
        .unwrap();
    let snapshot = snapshot(session.id);
    let queued = store
        .create_code_review(&snapshot, "ollama", "fixture-model", None)
        .unwrap();
    assert!(store
        .transition_code_review(
            queued.id,
            queued.revision,
            ReviewStatus::Completed,
            None,
            None
        )
        .is_err());
    let capturing = store
        .transition_code_review(
            queued.id,
            queued.revision,
            ReviewStatus::Capturing,
            None,
            None,
        )
        .unwrap();
    assert!(store
        .transition_code_review(
            queued.id,
            queued.revision,
            ReviewStatus::Running,
            None,
            None
        )
        .is_err());
    let running = store
        .transition_code_review(
            queued.id,
            capturing.revision,
            ReviewStatus::Running,
            None,
            None,
        )
        .unwrap();
    let complete = store
        .finish_code_review(
            queued.id,
            running.revision,
            parse_review_result(queued.id, &snapshot, &output().to_string()).unwrap(),
        )
        .unwrap();
    assert_eq!(complete.status, ReviewStatus::Completed);
    assert!(store
        .list_pending_mutation_proposals_all(10)
        .unwrap()
        .is_empty());
    let dismissed = store
        .dismiss_code_review_finding(queued.id, complete.revision, complete.findings[0].id)
        .unwrap();
    assert_eq!(
        dismissed.findings[0].disposition,
        FindingDisposition::Dismissed
    );
    drop(store);
    assert_eq!(
        SessionStore::open(paths)
            .unwrap()
            .code_review(queued.id)
            .unwrap()
            .unwrap()
            .revision,
        dismissed.revision
    );
}

#[test]
fn internal_advisory_ceiling_refuses_native_adapters_resume_and_permission_upgrades() {
    use crate::provider_runtime::{
        advisory::validate_advisory_request,
        types::{
            ChatMode, InternalRequestPurpose, ProviderAdapterKind, ProviderChatRequest,
            ProviderResumeCursor,
        },
    };
    let mut request:ProviderChatRequest=serde_json::from_value(json!({"sessionId":"fixture","providerId":"ollama","message":"Review this snapshot","internalPurpose":"code-review","workflowRunId":"00000000-0000-0000-0000-000000000001"})).unwrap();
    assert!(
        request.internal_purpose.is_none(),
        "renderer cannot supply trusted purpose"
    );
    assert!(
        request.workflow_run_id.is_none(),
        "renderer cannot supply trusted workflow ownership"
    );
    request.internal_purpose = Some(InternalRequestPurpose::CodeReview);
    request.mode = ChatMode::Council;
    assert!(validate_advisory_request(ProviderAdapterKind::Ollama, &request, None).is_ok());
    assert!(validate_advisory_request(ProviderAdapterKind::OpenAiCodex, &request, None).is_err());
    assert!(validate_advisory_request(
        ProviderAdapterKind::Ollama,
        &request,
        Some(&ProviderResumeCursor {
            kind: "parent".into(),
            session_id: "parent".into()
        })
    )
    .is_err());
    request.full_access = true;
    assert!(validate_advisory_request(ProviderAdapterKind::Ollama, &request, None).is_err());
}

#[test]
fn re_review_only_resolves_explicit_anchored_unchanged_findings() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("private"))).unwrap();
    let session = store
        .create_session(temp.path(), SessionOrigin::Desktop, "review")
        .unwrap();
    let first = snapshot(session.id);
    let run = store
        .create_code_review(&first, "ollama", "fixture", None)
        .unwrap();
    let run = store
        .transition_code_review(run.id, run.revision, ReviewStatus::Capturing, None, None)
        .unwrap();
    let run = store
        .transition_code_review(run.id, run.revision, ReviewStatus::Running, None, None)
        .unwrap();
    let first_run = store
        .finish_code_review(
            run.id,
            run.revision,
            parse_review_result(run.id, &first, &output().to_string()).unwrap(),
        )
        .unwrap();
    let mut next = snapshot(session.id);
    next.previous_review_id = Some(first_run.id);
    next.previous_findings = first_run.findings.clone();
    let mut resolved = output();
    resolved["findings"] = json!([]);
    resolved["resolutions"] = json!([{"findingId":first_run.findings[0].id,"path":"src.rs","side":"modified","lineStart":2,"lineEnd":2,"explanation":"The captured caller now requires this result."}]);
    let run = store
        .create_code_review(&next, "ollama", "fixture", Some(first_run.id))
        .unwrap();
    let run = store
        .transition_code_review(run.id, run.revision, ReviewStatus::Capturing, None, None)
        .unwrap();
    let run = store
        .transition_code_review(run.id, run.revision, ReviewStatus::Running, None, None)
        .unwrap();
    let parsed = parse_review_result(run.id, &next, &resolved.to_string()).unwrap();
    store
        .finish_code_review(run.id, run.revision, parsed)
        .unwrap();
    let updated = store.code_review(first_run.id).unwrap().unwrap();
    assert_eq!(
        updated.findings[0].disposition,
        FindingDisposition::ResolvedByReview
    );
    assert_eq!(updated.findings[0].resolved_by_review_id, Some(run.id));
    resolved["resolutions"][0]["findingId"] = json!(Uuid::new_v4());
    assert!(parse_review_result(run.id, &next, &resolved.to_string()).is_err());
}

#[test]
fn recorded_original_is_reconstructed_only_with_its_expected_hash() {
    let patch = diffy::create_patch("before\n", "after\n").to_string();
    assert_eq!(
        reconstruct_recorded_original("after\n", &patch, Some(&content_hash(b"before\n"))).unwrap(),
        Some("before\n".into())
    );
    assert!(reconstruct_recorded_original(
        "changed later\n",
        &patch,
        Some(&content_hash(b"before\n"))
    )
    .is_err());
    assert!(reconstruct_recorded_original("after\n", &patch, None).is_err());
}

#[test]
fn deleting_previews_and_shared_reviews_removes_only_unreferenced_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let paths = GyroPaths::from_base_dir(temp.path().join("private"));
    let store = SessionStore::open(paths.clone()).unwrap();
    let session = store
        .create_session(temp.path(), SessionOrigin::Desktop, "review")
        .unwrap();
    let captured = snapshot(session.id);
    write_snapshot(&paths, &captured).unwrap();
    store.register_code_review_capture(&captured).unwrap();
    let first = store
        .create_code_review(&captured, "ollama", "fixture", None)
        .unwrap();
    let second = store
        .create_code_review(&captured, "ollama", "fixture", None)
        .unwrap();
    assert_eq!(
        store
            .discard_code_review_previews(session.id, None)
            .unwrap(),
        0
    );
    assert!(
        store.delete_session(session.id).is_err(),
        "deleting a source cannot orphan an active reviewer"
    );
    let first = store
        .transition_code_review(
            first.id,
            first.revision,
            ReviewStatus::Cancelled,
            None,
            None,
        )
        .unwrap();
    assert!(store
        .delete_code_review(first.id, first.revision)
        .unwrap()
        .is_none());
    assert!(read_snapshot(&paths, captured.id).is_ok());
    let second = store
        .transition_code_review(
            second.id,
            second.revision,
            ReviewStatus::Cancelled,
            None,
            None,
        )
        .unwrap();
    store
        .delete_code_review(second.id, second.revision)
        .unwrap();
    assert!(read_snapshot(&paths, captured.id).is_err());
    let preview = snapshot(session.id);
    write_snapshot(&paths, &preview).unwrap();
    store.register_code_review_capture(&preview).unwrap();
    assert_eq!(
        store
            .discard_code_review_previews(session.id, Some("another-root"))
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .discard_code_review_previews(session.id, None)
            .unwrap(),
        1
    );
    assert!(read_snapshot(&paths, preview.id).is_err());
}

#[test]
fn queued_fix_intents_link_real_turns_and_cannot_resolve_findings_or_replay_after_stop() {
    let temp = tempfile::tempdir().unwrap();
    let paths = GyroPaths::from_base_dir(temp.path().join("private"));
    let store = SessionStore::open(paths.clone()).unwrap();
    let source = store
        .create_session(temp.path(), SessionOrigin::Desktop, "source")
        .unwrap();
    let capture = snapshot(source.id);
    let queued = store
        .create_code_review(&capture, "ollama", "fixture-model", None)
        .unwrap();
    let capturing = store
        .transition_code_review(
            queued.id,
            queued.revision,
            ReviewStatus::Capturing,
            None,
            None,
        )
        .unwrap();
    let running = store
        .transition_code_review(
            queued.id,
            capturing.revision,
            ReviewStatus::Running,
            None,
            None,
        )
        .unwrap();
    let review = store
        .finish_code_review(
            queued.id,
            running.revision,
            parse_review_result(queued.id, &capture, &output().to_string()).unwrap(),
        )
        .unwrap();
    let intent = ReviewFixIntent {
        id: Uuid::new_v4(),
        review_id: review.id,
        review_revision: review.revision,
        source_session_id: source.id,
        root_id: review.root_id.clone(),
        root_key: "/fixture".into(),
        finding_revisions: std::collections::BTreeMap::from([(
            review.findings[0].id,
            review.findings[0].revision,
        )]),
        target_fingerprint: "witness".into(),
        provider_id: "fixture-provider".into(),
        model_id: "fixture-model".into(),
        message: "Inspect the selected finding".into(),
        turn_id: Uuid::new_v4(),
        status: ReviewFixStatus::Queued,
        revision: 1,
        error: None,
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    let saved = store.queue_review_fixes(intent.clone()).unwrap();
    assert_eq!(
        store.queue_review_fixes(intent.clone()).unwrap().turn_id,
        saved.turn_id
    );
    assert!(store
        .delete_code_review(review.id, review.revision)
        .is_err());
    let dispatching = store
        .transition_review_fix(saved.id, saved.revision, ReviewFixStatus::Dispatching, None)
        .unwrap();
    let sent = store
        .transition_review_fix(saved.id, dispatching.revision, ReviewFixStatus::Sent, None)
        .unwrap();
    let marked = store.code_review(review.id).unwrap().unwrap();
    assert_eq!(
        marked.findings[0].disposition,
        FindingDisposition::SentForFix
    );
    // Human dismissal wins while the implementing turn runs.
    store
        .dismiss_code_review_finding(review.id, marked.revision, marked.findings[0].id)
        .unwrap();
    let done = store
        .transition_review_fix(sent.id, sent.revision, ReviewFixStatus::Completed, None)
        .unwrap();
    assert_eq!(
        store.code_review(review.id).unwrap().unwrap().findings[0].disposition,
        FindingDisposition::Dismissed
    );
    assert!(store
        .transition_review_fix(done.id, done.revision, ReviewFixStatus::Dispatching, None)
        .is_err());
    drop(store);
    let reopened = SessionStore::open(paths).unwrap();
    assert_eq!(
        reopened
            .review_fix_intent(saved.id)
            .unwrap()
            .unwrap()
            .turn_id,
        intent.turn_id
    );
}

#[test]
fn queued_fix_does_not_dispatch_after_a_finding_changes() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("private"))).unwrap();
    let source = store
        .create_session(temp.path(), SessionOrigin::Desktop, "source")
        .unwrap();
    let capture = snapshot(source.id);
    let queued = store
        .create_code_review(&capture, "ollama", "fixture-model", None)
        .unwrap();
    let capturing = store
        .transition_code_review(
            queued.id,
            queued.revision,
            ReviewStatus::Capturing,
            None,
            None,
        )
        .unwrap();
    let running = store
        .transition_code_review(
            queued.id,
            capturing.revision,
            ReviewStatus::Running,
            None,
            None,
        )
        .unwrap();
    let review = store
        .finish_code_review(
            queued.id,
            running.revision,
            parse_review_result(queued.id, &capture, &output().to_string()).unwrap(),
        )
        .unwrap();
    let intent = store
        .queue_review_fixes(ReviewFixIntent {
            id: Uuid::new_v4(),
            review_id: review.id,
            review_revision: review.revision,
            source_session_id: source.id,
            root_id: review.root_id.clone(),
            root_key: "/fixture".into(),
            finding_revisions: std::collections::BTreeMap::from([(
                review.findings[0].id,
                review.findings[0].revision,
            )]),
            target_fingerprint: "witness".into(),
            provider_id: "fixture".into(),
            model_id: "model".into(),
            message: "Fix selection".into(),
            turn_id: Uuid::new_v4(),
            status: ReviewFixStatus::Queued,
            revision: 1,
            error: None,
            created_at: chrono::Utc::now().to_rfc3339(),
        })
        .unwrap();
    store
        .dismiss_code_review_finding(review.id, review.revision, review.findings[0].id)
        .unwrap();
    assert!(store
        .transition_review_fix(
            intent.id,
            intent.revision,
            ReviewFixStatus::Dispatching,
            None
        )
        .is_err());
    let stopped = store
        .transition_review_fix(intent.id, intent.revision, ReviewFixStatus::Cancelled, None)
        .unwrap();
    assert!(store
        .transition_review_fix(stopped.id, stopped.revision, ReviewFixStatus::Sent, None)
        .is_err());
}
#[test]
fn fix_claim_requires_an_applied_change_in_the_linked_turn_and_finding_path() {
    for changed in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let store =
            SessionStore::open(GyroPaths::from_base_dir(temp.path().join("private"))).unwrap();
        let source = store
            .create_session(temp.path(), SessionOrigin::Desktop, "source")
            .unwrap();
        let capture = snapshot(source.id);
        let queued = store
            .create_code_review(&capture, "ollama", "fixture-model", None)
            .unwrap();
        let capturing = store
            .transition_code_review(
                queued.id,
                queued.revision,
                ReviewStatus::Capturing,
                None,
                None,
            )
            .unwrap();
        let running = store
            .transition_code_review(
                queued.id,
                capturing.revision,
                ReviewStatus::Running,
                None,
                None,
            )
            .unwrap();
        let review = store
            .finish_code_review(
                queued.id,
                running.revision,
                parse_review_result(queued.id, &capture, &output().to_string()).unwrap(),
            )
            .unwrap();
        let intent = store
            .queue_review_fixes(ReviewFixIntent {
                id: Uuid::new_v4(),
                review_id: review.id,
                review_revision: review.revision,
                source_session_id: source.id,
                root_id: review.root_id.clone(),
                root_key: temp
                    .path()
                    .canonicalize()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                finding_revisions: std::collections::BTreeMap::from([(
                    review.findings[0].id,
                    review.findings[0].revision,
                )]),
                target_fingerprint: "witness".into(),
                provider_id: "fixture".into(),
                model_id: "model".into(),
                message: "Fix selected finding".into(),
                turn_id: Uuid::new_v4(),
                status: ReviewFixStatus::Queued,
                revision: 1,
                error: None,
                created_at: chrono::Utc::now().to_rfc3339(),
            })
            .unwrap();
        let dispatch = store
            .transition_review_fix(
                intent.id,
                intent.revision,
                ReviewFixStatus::Dispatching,
                None,
            )
            .unwrap();
        let sent = store
            .transition_review_fix(intent.id, dispatch.revision, ReviewFixStatus::Sent, None)
            .unwrap();
        let path = if changed { "src.rs" } else { "unrelated.rs" };
        let proposal = store
            .create_mutation_proposal(source.id, Some(intent.turn_id), path, "fixed", None, false)
            .unwrap();
        crate::decide_mutation_proposal(&store, proposal.id, crate::MutationDecision::Approve)
            .unwrap();
        store
            .transition_review_fix(intent.id, sent.revision, ReviewFixStatus::Completed, None)
            .unwrap();
        let result = store.code_review(review.id).unwrap().unwrap();
        assert_eq!(
            result.findings[0].disposition,
            if changed {
                FindingDisposition::FixClaimed
            } else {
                FindingDisposition::SentForFix
            }
        );
        assert!(result.findings[0].resolved_by_review_id.is_none());
    }
}
