use super::*;
use serde_json::json;
fn definition() -> WorkflowDefinition {
    parse_definition(br#"{"schema":"gyro.workflow.v1","id":"inspect","name":"Inspect","description":"Read a scoped file","inputs":[{"id":"path","label":"File","type":"path","required":true}],"roles":["reader"],"steps":[{"kind":"agent","id":"read","role":"reader","instructions":"Inspect {{input.path}}","requestedAccess":"read-only","output":{"name":"report","required":true}}],"completion":{"requiredOutputs":["report"],"requireReviewCompletion":false,"requireVerificationSuccess":false}}"#).unwrap()
}
#[test]
fn workflow_definitions_are_closed_bounded_and_semantically_valid() {
    let original = definition();
    let bytes = serde_json::to_vec(&original).unwrap();
    assert_eq!(
        definition_hash(&original).unwrap(),
        definition_hash(&parse_definition(&bytes).unwrap()).unwrap()
    );
    for (key, value) in [
        ("schema", json!("gyro.workflow.v9")),
        ("loop", json!(true)),
        ("id", json!("../escape")),
    ] {
        let mut invalid = serde_json::to_value(&original).unwrap();
        invalid[key] = value;
        assert!(parse_definition(&serde_json::to_vec(&invalid).unwrap()).is_err());
    }
    let mut invalid = original.clone();
    invalid.steps.push(invalid.steps[0].clone());
    assert!(validate_definition(&invalid).is_err());
    let mut invalid = original.clone();
    if let WorkflowStep::Agent { instructions, .. } = &mut invalid.steps[0] {
        *instructions = "Read {{input.unknown}}".into();
    }
    assert!(validate_definition(&invalid).is_err());
}
#[test]
fn workflow_inputs_stay_data_and_command_arguments_are_never_shell_joined() {
    let definition = definition();
    let mut inputs = std::collections::BTreeMap::new();
    inputs.insert("path".into(), json!("src/main.rs"));
    validate_inputs(&definition, &inputs).unwrap();
    inputs.insert("path".into(), json!("../private"));
    assert!(validate_inputs(&definition, &inputs).is_err());
    let mut binding = WorkflowBinding {
        definition_id: definition.id.clone(),
        definition_hash: definition_hash(&definition).unwrap(),
        roles: Default::default(),
        commands: Default::default(),
        inputs: Default::default(),
    };
    binding
        .inputs
        .insert("value".into(), json!("$(touch stolen); {{input.other}}"));
    binding.commands.insert(
        "check".into(),
        WorkflowCommandBinding {
            task_id: None,
            task_fingerprint: None,
            program: "printf".into(),
            args: vec!["%s".into(), "{{input.value}}".into()],
        },
    );
    assert_eq!(
        binding.command_argv("check").unwrap(),
        vec!["printf", "%s", "$(touch stolen); {{input.other}}"]
    );
    assert!(parse_template("{{eval(1)}}").is_err());
    assert!(parse_template("oops }}").is_err());
}

#[test]
fn workflow_journal_pins_versions_rejects_replay_and_ignores_late_cancelled_results() {
    let temp = tempfile::tempdir().unwrap();
    let paths = crate::GyroPaths::from_base_dir(temp.path().join("private"));
    let store = crate::SessionStore::open(paths.clone()).unwrap();
    let session = store
        .create_session(temp.path(), crate::SessionOrigin::Desktop, "workflow")
        .unwrap();
    let definition = definition();
    let mut binding = WorkflowBinding {
        definition_id: definition.id.clone(),
        definition_hash: definition_hash(&definition).unwrap(),
        roles: Default::default(),
        commands: Default::default(),
        inputs: Default::default(),
    };
    binding.roles.insert(
        "reader".into(),
        WorkflowRoleBinding {
            provider_id: "fixture-provider".into(),
            model_id: "fixture-model".into(),
            access_ceiling: WorkflowAccess::ReadOnly,
        },
    );
    binding.inputs.insert("path".into(), json!("src/main.rs"));
    let operation = uuid::Uuid::new_v4();
    let queued = store
        .create_workflow_run(
            operation,
            None,
            session.id,
            "root",
            "/fixture",
            &definition,
            &binding,
            crate::UsageOrigin::Automation,
        )
        .unwrap();
    assert_eq!(
        store
            .create_workflow_run(
                operation,
                None,
                session.id,
                "root",
                "/fixture",
                &definition,
                &binding,
                crate::UsageOrigin::Automation
            )
            .unwrap()
            .id,
        queued.id
    );
    let running = store
        .begin_workflow_step(queued.id, queued.revision, 0, session.id, None)
        .unwrap();
    assert!(store
        .begin_workflow_step(queued.id, running.revision, 0, session.id, None)
        .is_err());
    let cancelled = store
        .stop_workflow_run(
            running.id,
            running.revision,
            WorkflowRunStatus::Cancelled,
            "Stopped by you",
        )
        .unwrap();
    assert!(store
        .complete_workflow_step(
            cancelled.id,
            cancelled.revision,
            0,
            "late answer".into(),
            None,
            None
        )
        .is_err());
    drop(store);
    let reopened = crate::SessionStore::open(paths).unwrap();
    assert_eq!(
        reopened.workflow_run(queued.id).unwrap().unwrap().status,
        WorkflowRunStatus::Cancelled
    );
    let mut edited = definition.clone();
    edited.description.push_str(" changed");
    assert!(binding.validate(&edited).is_err());
}

#[test]
fn workflow_saves_guard_creation_deletion_and_external_edits_and_discovery_preserves_newer_versions(
) {
    let definition = definition();
    assert!(plan_definition_write(None, Some("old"), &definition).is_err());
    let plan = plan_definition_write(None, None, &definition).unwrap();
    let hash = crate::mutations::content_hash(plan.content.as_bytes());
    assert!(plan_definition_write(Some(plan.content.as_bytes()), None, &definition).is_err());
    assert!(plan_definition_write(Some(plan.content.as_bytes()), Some(&hash), &definition).is_ok());
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join(".gyro/workflows");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("inspect.json"), plan.content).unwrap();
    std::fs::write(
        directory.join("future.json"),
        "{\"schema\":\"gyro.workflow.v2\"}",
    )
    .unwrap();
    let listings = read_definitions(temp.path(), &temp.path().join("private")).unwrap();
    assert_eq!(listings.len(), 2);
    assert!(listings
        .iter()
        .find(|entry| entry.path.ends_with("future.json"))
        .unwrap()
        .diagnostic
        .is_some());
}

fn binding(definition: &WorkflowDefinition) -> WorkflowBinding {
    WorkflowBinding {
        definition_id: definition.id.clone(),
        definition_hash: definition_hash(definition).unwrap(),
        roles: std::collections::BTreeMap::from([(
            "reader".into(),
            WorkflowRoleBinding {
                provider_id: "fixture-provider".into(),
                model_id: "fixture-model".into(),
                access_ceiling: WorkflowAccess::ReadOnly,
            },
        )]),
        commands: Default::default(),
        inputs: std::collections::BTreeMap::from([("path".into(), json!("src/main.rs"))]),
    }
}
#[test]
fn workflow_root_exclusion_and_dispatch_authority_survive_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let paths = crate::GyroPaths::from_base_dir(temp.path().join("private"));
    let store = crate::SessionStore::open(paths.clone()).unwrap();
    let source = store
        .create_session(temp.path(), crate::SessionOrigin::Desktop, "source")
        .unwrap();
    let recipe = definition();
    let bindings = binding(&recipe);
    let run = store
        .create_workflow_run(
            uuid::Uuid::new_v4(),
            None,
            source.id,
            "root",
            "/fixture",
            &recipe,
            &bindings,
            crate::UsageOrigin::Automation,
        )
        .unwrap();
    assert!(store
        .create_workflow_run(
            uuid::Uuid::new_v4(),
            None,
            source.id,
            "root",
            "/fixture",
            &recipe,
            &bindings,
            crate::UsageOrigin::Chat
        )
        .is_err());
    let running = store
        .begin_workflow_step(run.id, run.revision, 0, source.id, None)
        .unwrap();
    assert_eq!(
        store
            .validate_workflow_dispatch(
                run.id,
                source.id,
                "fixture-provider",
                Some("fixture-model"),
                "/fixture"
            )
            .unwrap(),
        WorkflowAccess::ReadOnly
    );
    for (session, provider, model, root) in [
        (
            uuid::Uuid::new_v4(),
            "fixture-provider",
            Some("fixture-model"),
            "/fixture",
        ),
        (source.id, "other", Some("fixture-model"), "/fixture"),
        (source.id, "fixture-provider", Some("other"), "/fixture"),
        (source.id, "fixture-provider", None, "/fixture"),
        (
            source.id,
            "fixture-provider",
            Some("fixture-model"),
            "/other",
        ),
    ] {
        assert!(store
            .validate_workflow_dispatch(run.id, session, provider, model, root)
            .is_err());
    }
    assert_eq!(
        store.workflow_dispatch_origin(source.id).unwrap(),
        Some(crate::UsageOrigin::Automation)
    );
    assert!(store
        .complete_workflow_step(
            run.id,
            running.revision,
            0,
            "answer".into(),
            None,
            Some(true)
        )
        .is_err());
    let done = store
        .complete_workflow_step(run.id, running.revision, 0, "answer".into(), None, None)
        .unwrap();
    assert_eq!(done.requirements_met, Some(true));
    assert!(store
        .validate_workflow_dispatch(
            run.id,
            source.id,
            "fixture-provider",
            Some("fixture-model"),
            "/fixture"
        )
        .is_err());
    drop(store);
    let reopened = crate::SessionStore::open(paths).unwrap();
    assert!(reopened
        .active_workflow_for_root("/fixture")
        .unwrap()
        .is_none());
    let summaries = reopened.workflow_run_summaries().unwrap();
    assert!(summaries[0].get("binding").is_none());
    assert!(summaries[0]["steps"][0].get("output").is_none());
}
#[test]
fn workflow_private_binding_and_extraction_are_cas_guarded_and_never_replayed() {
    let temp = tempfile::tempdir().unwrap();
    let paths = crate::GyroPaths::from_base_dir(temp.path().join("private"));
    let store = crate::SessionStore::open(paths.clone()).unwrap();
    let source = store
        .create_session(temp.path(), crate::SessionOrigin::Desktop, "source")
        .unwrap();
    let recipe = definition();
    let bindings = binding(&recipe);
    assert_eq!(
        store
            .save_workflow_binding("/fixture", &recipe, &bindings, 0)
            .unwrap(),
        1
    );
    assert!(store
        .save_workflow_binding("/fixture", &recipe, &bindings, 0)
        .is_err());
    assert!(store
        .workflow_binding("/other", &recipe.id)
        .unwrap()
        .is_none());
    let draft = store
        .create_workflow_draft(
            source.id,
            "root",
            "/fixture",
            vec![uuid::Uuid::new_v4()],
            false,
            "frozen evidence".into(),
        )
        .unwrap();
    assert!(store
        .queue_workflow_extraction(
            draft.id,
            draft.revision,
            "wrong",
            "fixture-provider",
            "fixture-model"
        )
        .is_err());
    let queued = store
        .queue_workflow_extraction(
            draft.id,
            draft.revision,
            &draft.capture_hash,
            "fixture-provider",
            "fixture-model",
        )
        .unwrap();
    assert_eq!(
        store
            .queue_workflow_extraction(
                draft.id,
                draft.revision,
                &draft.capture_hash,
                "fixture-provider",
                "fixture-model"
            )
            .unwrap()
            .revision,
        queued.revision
    );
    assert!(store
        .queue_workflow_extraction(
            draft.id,
            draft.revision,
            &draft.capture_hash,
            "other",
            "fixture-model"
        )
        .is_err());
    assert!(store
        .start_workflow_extraction(draft.id, queued.revision, source.id)
        .is_err());
    let child = store
        .create_subagent_session(
            temp.path(),
            crate::SessionOrigin::Desktop,
            "extraction",
            crate::CreateSessionContext {
                provider_id: Some("fixture-provider".into()),
                model_id: Some("fixture-model".into()),
                ..Default::default()
            },
            source.id,
        )
        .unwrap();
    let running = store
        .start_workflow_extraction(draft.id, queued.revision, child.id)
        .unwrap();
    assert_eq!(
        store.advisory_session_purpose(child.id).unwrap(),
        Some(crate::provider_runtime::types::InternalRequestPurpose::WorkflowExtraction)
    );
    let stopped = store
        .stop_workflow_extraction(
            draft.id,
            running.revision,
            WorkflowDraftStatus::Cancelled,
            "Stopped",
        )
        .unwrap();
    assert!(store
        .finish_workflow_extraction(draft.id, running.revision, recipe)
        .is_err());
    assert_eq!(
        store
            .queue_workflow_extraction(
                draft.id,
                draft.revision,
                &draft.capture_hash,
                "fixture-provider",
                "fixture-model"
            )
            .unwrap()
            .status,
        WorkflowDraftStatus::Cancelled
    );
    drop(store);
    let reopened = crate::SessionStore::open(paths).unwrap();
    assert_eq!(
        reopened.workflow_draft(draft.id).unwrap().unwrap().revision,
        stopped.revision
    );
}
#[test]
fn explicit_continuation_preserves_completed_prefix_and_rejects_changed_recipe_or_live_attempt() {
    let temp = tempfile::tempdir().unwrap();
    let store =
        crate::SessionStore::open(crate::GyroPaths::from_base_dir(temp.path().join("private")))
            .unwrap();
    let source = store
        .create_session(temp.path(), crate::SessionOrigin::Desktop, "source")
        .unwrap();
    let mut recipe = definition();
    let mut second = recipe.steps[0].clone();
    if let WorkflowStep::Agent { id, output, .. } = &mut second {
        *id = "second".into();
        output.name = "second-report".into();
    }
    recipe.steps.push(second);
    let bindings = binding(&recipe);
    let first = store
        .create_workflow_run(
            uuid::Uuid::new_v4(),
            None,
            source.id,
            "root",
            "/fixture",
            &recipe,
            &bindings,
            crate::UsageOrigin::Chat,
        )
        .unwrap();
    let running = store
        .begin_workflow_step(first.id, first.revision, 0, source.id, None)
        .unwrap();
    let acknowledged = store
        .complete_workflow_step(
            first.id,
            running.revision,
            0,
            "Acknowledged output".into(),
            None,
            None,
        )
        .unwrap();
    let stopped = store
        .stop_workflow_run(
            first.id,
            acknowledged.revision,
            WorkflowRunStatus::Interrupted,
            "Host restarted",
        )
        .unwrap();
    let next = store
        .create_workflow_run(
            uuid::Uuid::new_v4(),
            None,
            source.id,
            "root",
            "/fixture",
            &recipe,
            &bindings,
            crate::UsageOrigin::Chat,
        )
        .unwrap();
    assert!(store
        .inherit_completed_workflow_steps(next.id, first.id, stopped.revision - 1)
        .is_err());
    let continued = store
        .inherit_completed_workflow_steps(next.id, first.id, stopped.revision)
        .unwrap();
    assert_eq!(
        continued.steps[0].output.as_deref(),
        Some("Acknowledged output")
    );
    assert_eq!(continued.steps[1].status, WorkflowStepStatus::Pending);
    assert_eq!(continued.previous_run_id, Some(first.id));
    assert!(store
        .begin_workflow_step(next.id, continued.revision, 0, source.id, None)
        .is_err());
    assert!(store
        .begin_workflow_step(next.id, continued.revision, 1, source.id, None)
        .is_ok());
    assert_eq!(
        store.workflow_run(first.id).unwrap().unwrap().status,
        WorkflowRunStatus::Interrupted
    );
    assert!(store
        .delete_workflow_run(first.id, stopped.revision)
        .is_err());
    assert!(store
        .delete_workflow_run(next.id, continued.revision)
        .is_err());
}
#[test]
fn failed_verification_never_becomes_requirements_met_even_when_not_declared_required() {
    let temp = tempfile::tempdir().unwrap();
    let store =
        crate::SessionStore::open(crate::GyroPaths::from_base_dir(temp.path().join("private")))
            .unwrap();
    let session = store
        .create_session(temp.path(), crate::SessionOrigin::Desktop, "source")
        .unwrap();
    let mut recipe = definition();
    recipe.steps.push(WorkflowStep::Verification {
        id: "verify".into(),
        command_ref: "test".into(),
        instructions: "Verify the result".into(),
    });
    assert!(!recipe.completion.require_verification_success);
    let mut bindings = binding(&recipe);
    bindings.commands.insert(
        "test".into(),
        WorkflowCommandBinding {
            task_id: None,
            task_fingerprint: None,
            program: "cargo".into(),
            args: vec!["test".into()],
        },
    );
    let run = store
        .create_workflow_run(
            uuid::Uuid::new_v4(),
            None,
            session.id,
            "root",
            "/fixture",
            &recipe,
            &bindings,
            crate::UsageOrigin::Chat,
        )
        .unwrap();
    let running = store
        .begin_workflow_step(run.id, run.revision, 0, session.id, None)
        .unwrap();
    let agent = store
        .complete_workflow_step(
            run.id,
            running.revision,
            0,
            "Reported output".into(),
            None,
            None,
        )
        .unwrap();
    let verifying = store
        .begin_workflow_step(run.id, agent.revision, 1, session.id, None)
        .unwrap();
    let complete = store
        .complete_workflow_step(
            run.id,
            verifying.revision,
            1,
            "Exit code 1".into(),
            None,
            Some(false),
        )
        .unwrap();
    assert_eq!(complete.status, WorkflowRunStatus::Completed);
    assert_eq!(complete.requirements_met, Some(false));
}
