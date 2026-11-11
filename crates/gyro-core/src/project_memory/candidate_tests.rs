use super::*;
use serde_json::json;

#[test]
fn suggestions_require_bounded_exact_evidence_and_strict_versioned_payloads() {
    let user = "Remember that we prefer the shared runtime for CLI and desktop.";
    let response = format!(
        "Done.\nGYRO_MEMORY: {}",
        json!({"v":1,"entries":[{"text":"Prefer the shared runtime for CLI and desktop.","kind":"decision","evidenceQuote":"we prefer the shared runtime for CLI and desktop."}]})
    );
    let candidates = parse_memory_candidates(&response, user).unwrap();
    assert_eq!(candidates.len(), 1);
    assert!(parse_memory_candidates(&response, "unrelated user message").is_err());
    assert!(parse_memory_candidates(&response.replace("\"v\":1", "\"v\":2"), user).is_err());
    assert!(parse_memory_candidates("GYRO_MEMORY: {bad}", user).is_err());
    assert!(!candidate_worthy_request("Run the tests"));
    assert!(candidate_worthy_request(user));
}

#[test]
fn candidate_decisions_survive_restart_and_do_not_keep_accepted_text_in_a_hidden_copy() {
    let root = tempfile::tempdir().unwrap();
    let paths = crate::GyroPaths::from_base_dir(root.path().join("private"));
    let store = crate::SessionStore::open(paths.clone()).unwrap();
    let session = store
        .create_session(root.path(), crate::SessionOrigin::Desktop, "memory")
        .unwrap();
    let draft = MemoryDraft {
        text: "Prefer shared runtime".into(),
        kind: MemoryKind::Decision,
        paths: vec![],
        sources: vec![MemorySource::UserEntered],
        supersedes: None,
    };
    let turn = uuid::Uuid::new_v4();
    let event = uuid::Uuid::new_v4();
    store
        .add_project_memory_candidate(
            "project",
            session.id,
            turn,
            event,
            &draft,
            "Prefer shared runtime",
        )
        .unwrap();
    store
        .add_project_memory_candidate(
            "project",
            session.id,
            turn,
            event,
            &draft,
            "Prefer shared runtime",
        )
        .unwrap();
    let candidates = store.project_memory_candidates("project").unwrap();
    assert_eq!(candidates.len(), 1);
    let candidate = &candidates[0];
    assert!(store
        .project_memory_candidate("other-project", &candidate.id)
        .is_err());
    store
        .begin_project_memory_candidate_acceptance(
            "project",
            &candidate.id,
            candidate.revision,
            &draft,
        )
        .unwrap();
    assert!(store
        .begin_project_memory_candidate_acceptance(
            "project",
            &candidate.id,
            candidate.revision,
            &draft
        )
        .is_err());
    drop(store);
    let store = crate::SessionStore::open(paths).unwrap();
    let interrupted = store
        .project_memory_candidate("project", &candidate.id)
        .unwrap();
    assert_eq!(interrupted.status, "accepting");
    assert!(interrupted.draft.is_some());
    store
        .decide_project_memory_candidate("project", &candidate.id, interrupted.revision, "accepted")
        .unwrap();
    store
        .decide_project_memory_candidate("project", &candidate.id, interrupted.revision, "accepted")
        .unwrap();
    let accepted = store
        .project_memory_candidate("project", &candidate.id)
        .unwrap();
    assert!(accepted.draft.is_none() && accepted.evidence_quote.is_none());
    assert_eq!(accepted.status, "accepted");
}
