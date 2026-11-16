use super::*;
use serde_json::json;

fn plan() -> CheckPlan {
    CheckPlan {
        id: uuid::Uuid::new_v4().to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
        workspace_revision: 1,
        draft: CheckDraft {
            task: None,
            session_id: uuid::Uuid::new_v4().to_string(),
            preview_url: "http://127.0.0.1:4317".into(),
            command: "node check.mjs".into(),
            browser: None,
            data_changes: "Synthetic in-memory todos".into(),
            files: vec!["todo.mjs".into()],
            criteria: vec![
                CheckCriterion {
                    id: "add-item".into(),
                    requirement: "Add a todo".into(),
                    expected: json!(true),
                    scope: CheckScope::Api,
                },
                CheckCriterion {
                    id: "reject-empty".into(),
                    requirement: "Reject an empty title".into(),
                    expected: json!(true),
                    scope: CheckScope::Api,
                },
            ],
        },
        snapshot: CheckSnapshot {
            workspace: PathBuf::from("/tmp"),
            git_head: None,
            files: vec![],
        },
    }
}
fn output(value: Value) -> ExecutionOutcome {
    ExecutionOutcome {
        termination: ExecutionTermination::Exited { code: Some(0) },
        stdout: value.to_string(),
        stderr: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
        duration_ms: 1,
    }
}
fn observed(mut values: Value) -> Value {
    for value in values.as_array_mut().unwrap() {
        value
            .as_object_mut()
            .unwrap()
            .entry("scope")
            .or_insert(json!("api"));
    }
    json!({"version":2,"previewUrl":"http://127.0.0.1:4317","observations":values})
}

#[test]
fn requirements_are_bounded_and_legacy_drafts_still_load() {
    let mut draft = plan().draft;
    let legacy = serde_json::to_value(&draft).unwrap();
    assert!(legacy.get("task").is_none());
    assert!(serde_json::from_value::<CheckDraft>(legacy)
        .unwrap()
        .task
        .is_none());
    draft.criteria = (0..MAX_CHECK_REQUIREMENTS)
        .map(|i| CheckCriterion {
            id: format!("criterion-{i}"),
            requirement: format!("Requirement {i}"),
            expected: json!(true),
            scope: CheckScope::Command,
        })
        .collect();
    assert!(draft.validate().is_ok());
    draft.criteria.push(CheckCriterion {
        id: "extra".into(),
        requirement: "Extra".into(),
        expected: json!(true),
        scope: CheckScope::Command,
    });
    assert!(draft.validate().is_err());
    draft.criteria.pop();
    draft.task = Some(CheckTaskReference {
        source_turn_id: "not-a-turn".into(),
        previous_plan_id: None,
    });
    assert!(draft.validate().is_err());
}

#[test]
fn eight_requirements_need_eight_independent_observations() {
    let mut p = plan();
    p.draft.criteria = (0..MAX_CHECK_REQUIREMENTS)
        .map(|i| CheckCriterion {
            id: format!("criterion-{i}"),
            requirement: format!("Requirement {i}"),
            expected: json!(true),
            scope: CheckScope::Api,
        })
        .collect();
    let observations: Vec<_> = (0..7)
        .map(|i| {
            json!({
                "criterionId": format!("criterion-{i}"), "actual": true,
                "scope": "api", "evidence": "Synthetic API observation"
            })
        })
        .collect();
    let report = report_from_output(p, output(observed(json!(observations))));
    assert_eq!(
        report
            .results
            .iter()
            .filter(|r| r.status == CheckStatus::Passed)
            .count(),
        7
    );
    assert_eq!(report.results[7].status, CheckStatus::NotChecked);
}

#[test]
fn api_evidence_cannot_pass_a_browser_requirement() {
    let mut p = plan();
    p.draft.criteria[0].scope = CheckScope::Browser;
    let report = report_from_output(
        p,
        output(observed(json!([
            {"criterionId":"add-item","actual":true,"evidence":"POST 201; GET returned title"},
            {"criterionId":"reject-empty","actual":true,"evidence":"POST blank returned 400"}
        ]))),
    );
    assert_eq!(report.results[0].status, CheckStatus::NotChecked);
    assert_eq!(report.results[0].observed_scope, Some(CheckScope::Api));
    assert!(report.results[0].reason.contains("browser interaction"));
    assert!(report.results[0].actual.is_none());
    assert_eq!(report.results[1].status, CheckStatus::Passed);
}

#[test]
fn matching_scopes_can_compare_reviewed_observations() {
    for scope in [CheckScope::Api, CheckScope::Browser, CheckScope::Command] {
        let mut p = plan();
        p.draft.criteria[0].scope = scope;
        let report = report_from_output(
            p,
            output(observed(
                json!([{ "criterionId":"add-item","scope":scope,"actual":true,"evidence":"Synthetic assertion output; parser test only" }]),
            )),
        );
        assert_eq!(report.results[0].status, CheckStatus::Passed);
        assert_eq!(report.results[0].observed_scope, Some(scope));
    }
}

#[test]
fn absent_scope_or_old_contract_cannot_produce_a_pass() {
    for version in [1, 2] {
        let report = report_from_output(
            plan(),
            output(
                json!({"version":version,"previewUrl":"http://127.0.0.1:4317","observations":[{"criterionId":"add-item","actual":true,"evidence":"POST 201"}]}),
            ),
        );
        assert!(report
            .results
            .iter()
            .all(|r| r.status == CheckStatus::NotChecked));
    }
    let mut p = plan();
    p.draft.criteria[0].scope = CheckScope::Unspecified;
    assert!(p.draft.validate().is_err());
}

#[test]
fn older_saved_verdicts_are_unchecked_without_matching_reviewed_scope() {
    let report = report_from_output(
        plan(),
        output(observed(
            json!([{"criterionId":"add-item","actual":true,"evidence":"POST 201"}]),
        )),
    );
    let mut saved = serde_json::to_value(&report).unwrap();
    for c in saved["plan"]["draft"]["criteria"].as_array_mut().unwrap() {
        c.as_object_mut().unwrap().remove("scope");
    }
    for r in saved["results"].as_array_mut().unwrap() {
        r.as_object_mut().unwrap().remove("observedScope");
    }
    let mut legacy: CheckReport = serde_json::from_value(saved).unwrap();
    refresh_evidence_scope(&mut legacy);
    assert_eq!(legacy.results[0].status, CheckStatus::NotChecked);
    assert!(legacy.results[0].reason.contains("Earlier report"));
    assert_eq!(legacy.output.unwrap().stdout, report.output.unwrap().stdout);
}

#[test]
fn independently_matches_success_failure_and_missing_evidence() {
    let report = report_from_output(
        plan(),
        output(observed(json!([
            {"criterionId":"add-item","actual":true,"evidence":"POST 201; GET returned title"},
            {"criterionId":"reject-empty","actual":false,"evidence":"POST blank returned 201"}
        ]))),
    );
    assert_eq!(report.results[0].status, CheckStatus::Passed);
    assert_eq!(report.results[1].status, CheckStatus::Failed);
    let report = report_from_output(
        plan(),
        output(observed(json!([
            {"criterionId":"add-item","actual":true,"evidence":"POST 201; GET returned title"}
        ]))),
    );
    assert_eq!(report.results[1].status, CheckStatus::NotChecked);
    assert!(report.results[1].evidence.is_none());
}

#[test]
fn exit_zero_or_a_claim_of_pass_does_not_prove_a_requirement() {
    for value in [
        json!({}),
        json!({"status":"passed"}),
        observed(json!([])),
        observed(json!([{"criterionId":"add-item","actual":true,"evidence":""}])),
    ] {
        assert!(report_from_output(plan(), output(value))
            .results
            .iter()
            .all(|r| r.status == CheckStatus::NotChecked));
    }
}

#[test]
fn malformed_duplicate_unknown_or_wrong_target_observations_are_unchecked() {
    let item = json!({"criterionId":"add-item","actual":true,"evidence":"observed"});
    for value in [
        observed(json!([item, item])),
        observed(json!([{"criterionId":"other","actual":true,"evidence":"observed"}])),
        json!({"version":2,"previewUrl":"http://127.0.0.1:9999","observations":[item]}),
    ] {
        assert!(report_from_output(plan(), output(value))
            .results
            .iter()
            .all(|r| r.status == CheckStatus::NotChecked));
    }
}

#[test]
fn interrupted_failed_or_truncated_output_cannot_pass() {
    let value = observed(json!([{"criterionId":"add-item","actual":true,"evidence":"observed"}]));
    for termination in [
        ExecutionTermination::Cancelled,
        ExecutionTermination::TimedOut,
        ExecutionTermination::OutputLimit,
        ExecutionTermination::Exited { code: Some(1) },
    ] {
        let mut o = output(value.clone());
        o.termination = termination;
        assert!(report_from_output(plan(), o)
            .results
            .iter()
            .all(|r| r.status == CheckStatus::NotChecked));
    }
    let mut o = output(value);
    o.stdout_truncated = true;
    assert!(report_from_output(plan(), o)
        .results
        .iter()
        .all(|r| r.status == CheckStatus::NotChecked));
}

#[test]
fn snapshot_detects_edits_deletions_and_stays_stale() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("todo.mjs"), "working").unwrap();
    let mut p = plan();
    p.snapshot = snapshot(temp.path(), &p.draft.files).unwrap();
    let mut report = not_checked(p, "denied");
    refresh_freshness(&mut report);
    assert!(!report.stale);
    fs::write(temp.path().join("todo.mjs"), "broken").unwrap();
    refresh_freshness(&mut report);
    assert!(report.stale);
    fs::write(temp.path().join("todo.mjs"), "working").unwrap();
    refresh_freshness(&mut report);
    assert!(report.stale);
    fs::remove_file(temp.path().join("todo.mjs")).unwrap();
    refresh_freshness(&mut report);
    assert!(report.stale);
}

#[test]
fn rejects_unsafe_targets_paths_and_ambiguous_requirements() {
    for url in [
        "https://example.com",
        "http://127.0.0.1.evil.test",
        "http://user:password@localhost",
        "file:///tmp/a",
    ] {
        let mut p = plan();
        p.draft.preview_url = url.into();
        assert!(p.draft.validate().is_err());
    }
    let mut p = plan();
    p.draft.criteria[1].id = "add-item".into();
    assert!(p.draft.validate().is_err());
    let temp = tempfile::tempdir().unwrap();
    assert!(snapshot(temp.path(), &["../escape".into()]).is_err());
    #[cfg(unix)]
    {
        fs::write(temp.path().join("source"), "source").unwrap();
        std::os::unix::fs::symlink("source", temp.path().join("link")).unwrap();
        assert!(snapshot(temp.path(), &["link".into()]).is_err());
    }
}

#[test]
fn local_report_round_trips_without_storing_source_files() {
    let temp = tempfile::tempdir().unwrap();
    let report = not_checked(plan(), "User denied the action; no command ran.");
    save_report(temp.path(), &report).unwrap();
    let path = temp.path().join(format!("{}.json", report.plan.id));
    let saved: CheckReport = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(saved.results[0].status, CheckStatus::NotChecked);
    assert!(saved.output.is_none());
}

#[cfg(target_os = "macos")]
#[test]
fn controlled_todo_check_end_to_end_uses_the_real_sandbox_and_runner() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("workspace");
    fs::create_dir(&root).unwrap();
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/fixtures/gyro-check");
    let files: Vec<String> = ["todo.mjs", "server.mjs", "check.mjs", "index.html"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    for file in &files {
        fs::copy(source.join(file), root.join(file)).unwrap();
    }
    let mut p = plan();
    p.draft.files = files;
    p.snapshot = snapshot(&root, &p.draft.files).unwrap();
    let home = dirs::home_dir().unwrap();
    let private = temp.path().join("private");
    for (variant, statuses) in [
        ("working", [CheckStatus::Passed, CheckStatus::Passed]),
        ("broken", [CheckStatus::Passed, CheckStatus::Failed]),
        (
            "broken-form",
            [CheckStatus::NotChecked, CheckStatus::Passed],
        ),
        (
            "unavailable",
            [CheckStatus::NotChecked, CheckStatus::NotChecked],
        ),
    ] {
        p.draft.criteria[0].scope = if variant == "broken-form" {
            CheckScope::Browser
        } else {
            CheckScope::Api
        };
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        p.draft.preview_url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        drop(listener);
        p.draft.command = format!("node check.mjs {variant}");
        let output = run_check(&p, &home, &private, CancellationToken::default()).unwrap();
        let report = report_from_output(p.clone(), output);
        assert_eq!(
            [
                report.results[0].status.clone(),
                report.results[1].status.clone()
            ],
            statuses,
            "{variant}: {:?}",
            report.output
        );
        save_report(&temp.path().join("reports"), &report).unwrap();
    }
    p.draft.command = "touch should-not-exist".into();
    let cancellation = CancellationToken::default();
    cancellation.cancel();
    let cancelled = run_check(&p, &home, &private, cancellation).unwrap();
    assert_eq!(cancelled.termination, ExecutionTermination::Cancelled);
    assert!(!root.join("should-not-exist").exists());
    // Approval binds the selected source files, not just the command text.
    fs::write(root.join("todo.mjs"), "changed after plan review").unwrap();
    assert!(run_check(&p, &home, &private, CancellationToken::default()).is_err());
    assert!(!root.join("should-not-exist").exists());
}
