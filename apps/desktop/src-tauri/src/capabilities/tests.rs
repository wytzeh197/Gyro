use super::*;

#[test]
fn approval_guidance_replaces_prior_turn_policy_without_bypassing_broker() {
    let mut request = anthropic_provider_request();
    request.require_command_approval = true;
    let restricted = provider_approval_instructions(&request).join("\n");
    assert!(restricted.contains("fresh, explicit user approval"));
    assert!(restricted.contains("capability broker"));
    assert_eq!(
        restricted
            .matches("Do not ask for duplicate approval in chat")
            .count(),
        1
    );
    assert_eq!(
        restricted
            .matches("capability broker presents any required approval before execution")
            .count(),
        1
    );
    request.require_command_approval = false;
    request.require_file_edit_approval = false;
    request.full_access = true;
    let unrestricted = provider_approval_instructions(&request).join("\n");
    assert!(
        !unrestricted.is_empty(),
        "resume must replace stale instructions"
    );
    assert!(!unrestricted.contains("fresh, explicit user approval"));
    assert!(unrestricted.contains("capability broker"));
}

#[test]
fn full_access_overrides_capability_prompts_and_project_denials() {
    let request = anthropic_provider_request();
    let mut bound = bound_capability_context(&request);
    let current = ProjectCapabilityPolicy::deny_all(bound.workspace_key.clone(), 1);
    for class in current.classes.keys().copied() {
        assert_eq!(
            capability_access_with_full_access(&bound, &current, class, "call", "test", true),
            CapabilityAccess::Allow,
        );
        assert_eq!(
            capability_access_with_full_access(&bound, &current, class, "call", "test", false),
            CapabilityAccess::Deny,
        );
    }
    for mode in [CapabilityRunMode::Plan, CapabilityRunMode::Council] {
        bound.policy.mode = mode;
        assert_eq!(
            capability_access_with_full_access(
                &bound,
                &current,
                CapabilityClass::TerminalExecute,
                "command",
                "pnpm",
                true,
            ),
            CapabilityAccess::Deny,
        );
    }
}

#[test]
fn capability_policy_snapshot_never_outlives_revocation() {
    let request = anthropic_provider_request();
    let mut bound = bound_capability_context(&request);
    let grant = ProjectCapabilityGrant {
        id: Uuid::new_v4(),
        class: CapabilityClass::WorkspaceSensitiveRead,
        scope_kind: "path".into(),
        scope_value: ".env".into(),
        created_at: chrono::Utc::now(),
    };
    bound.policy.grants.push(grant.clone());
    let mut current = ProjectCapabilityPolicy::defaults(bound.workspace_key.clone());
    current.grants.push(grant);
    assert_eq!(
        capability_access_for_call(
            &bound,
            &current,
            CapabilityClass::WorkspaceSensitiveRead,
            "path",
            ".env",
        ),
        CapabilityAccess::Allow
    );

    current.grants.clear();
    assert_eq!(
        capability_access_for_call(
            &bound,
            &current,
            CapabilityClass::WorkspaceSensitiveRead,
            "path",
            ".env",
        ),
        CapabilityAccess::Ask
    );
    current.classes.insert(
        CapabilityClass::WorkspaceSensitiveRead,
        CapabilityAccess::Deny,
    );
    assert_eq!(
        capability_access_for_call(
            &bound,
            &current,
            CapabilityClass::WorkspaceSensitiveRead,
            "path",
            ".env",
        ),
        CapabilityAccess::Deny
    );
}

#[test]
fn capability_diff_and_reload_scopes_are_conservative() {
    let temp = tempfile::tempdir().unwrap();
    assert_eq!(
        effective_capability_class(
            temp.path(),
            CapabilityId::WorkspaceDiff,
            &serde_json::json!({}),
        )
        .unwrap(),
        CapabilityClass::WorkspaceSensitiveRead
    );
    assert_eq!(
        effective_capability_class(
            temp.path(),
            CapabilityId::WorkspaceDiff,
            &serde_json::json!({ "path": "src/main.rs" }),
        )
        .unwrap(),
        CapabilityClass::WorkspaceInspect
    );
    assert_eq!(
        effective_capability_class(
            temp.path(),
            CapabilityId::WorkspaceDiff,
            &serde_json::json!({ "path": ".env.local" }),
        )
        .unwrap(),
        CapabilityClass::WorkspaceSensitiveRead
    );
    assert!(effective_capability_class(
        temp.path(),
        CapabilityId::WorkspaceDiff,
        &serde_json::json!({ "path": "*.env" }),
    )
    .is_err());
    let reload_schema = desktop_capability_tool_schema(CapabilityId::BrowserReload);
    assert!(reload_schema["properties"].as_object().unwrap().is_empty());
    let context_schema = desktop_capability_tool_schema(CapabilityId::WorkspaceContext);
    assert_eq!(context_schema["required"], serde_json::json!([]));
    assert_eq!(context_schema["additionalProperties"], false);
    assert_eq!(
        context_schema["properties"]["section"]["default"],
        "overview"
    );
    assert_eq!(context_schema["properties"]["offset"]["minimum"], 0);
    assert_eq!(context_schema["properties"]["maxBytes"]["default"], 16_384);
    assert!(context_schema["properties"].get("path").is_none());
    let range_schema = desktop_capability_tool_schema(CapabilityId::WorkspaceReadRange);
    assert_eq!(range_schema["required"], serde_json::json!(["path"]));
    let editor_schema = desktop_capability_tool_schema(CapabilityId::WorkspaceReadEditor);
    assert_eq!(editor_schema["required"], serde_json::json!(["path"]));
    assert_eq!(
        editor_schema["properties"]["selectionOnly"]["type"],
        "boolean"
    );
    // Code intelligence reads a file, so a sensitive path upgrades it the
    // same way a workspace read does, and its schemas require positions.
    assert_eq!(
        effective_capability_class(
            temp.path(),
            CapabilityId::CodeDefinition,
            &serde_json::json!({ "path": ".env", "line": 1, "column": 1 }),
        )
        .unwrap(),
        CapabilityClass::WorkspaceSensitiveRead
    );
    assert_eq!(
        capability_grant_scope(
            CapabilityId::CodeSymbols,
            &serde_json::json!({ "path": "src/main.rs" }),
        )
        .unwrap(),
        ("path".to_string(), "src/main.rs".to_string())
    );
    let definition_schema = desktop_capability_tool_schema(CapabilityId::CodeDefinition);
    assert_eq!(
        definition_schema["required"],
        serde_json::json!(["path", "line", "column"])
    );
    let symbols_schema = desktop_capability_tool_schema(CapabilityId::CodeSymbols);
    assert_eq!(symbols_schema["required"], serde_json::json!(["path"]));
    let proposal_schema = desktop_capability_tool_schema(CapabilityId::WorkspaceProposeEdit);
    assert_eq!(
        proposal_schema["required"],
        serde_json::json!(["path", "content"])
    );
    // A long-running task must be startable without holding the turn open,
    // so `background` is offered but never required.
    for id in [
        CapabilityId::WorkspaceRunTask,
        CapabilityId::WorkspaceRunTest,
    ] {
        let task_schema = desktop_capability_tool_schema(id);
        assert_eq!(task_schema["required"], serde_json::json!(["taskId"]));
        assert_eq!(task_schema["properties"]["background"]["type"], "boolean");
    }
}

#[cfg(unix)]
#[test]
fn sensitive_symlink_targets_require_approval_and_live_text_stays_out_of_metadata() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    fs::create_dir_all(workspace.join(".ssh")).unwrap();
    fs::write(workspace.join(".env"), "private contents").unwrap();
    fs::write(workspace.join(".ssh/config"), "private configuration").unwrap();
    fs::write(workspace.join("main.rs"), "ordinary code").unwrap();
    fs::write(temp.path().join("outside.txt"), "outside").unwrap();
    symlink(".env", workspace.join("public.txt")).unwrap();
    symlink(".ssh", workspace.join("assets")).unwrap();
    symlink("main.rs", workspace.join("source.rs")).unwrap();
    symlink(temp.path().join("outside.txt"), workspace.join("escape")).unwrap();

    for id in [
        CapabilityId::WorkspaceRead,
        CapabilityId::WorkspaceReadRange,
        CapabilityId::WorkspaceReadEditor,
        CapabilityId::CodeDefinition,
        CapabilityId::CodeReferences,
        CapabilityId::CodeHover,
        CapabilityId::CodeSymbols,
        CapabilityId::WorkspaceGitBlame,
        CapabilityId::WorkspaceGitShow,
        CapabilityId::WorkspaceGitLog,
        CapabilityId::WorkspaceDiff,
    ] {
        for path in ["public.txt", "assets/config"] {
            assert_eq!(
                effective_capability_class(&workspace, id, &serde_json::json!({ "path": path }))
                    .unwrap(),
                CapabilityClass::WorkspaceSensitiveRead,
                "{id}: {path}"
            );
        }
    }
    assert_eq!(
        effective_capability_class(
            &workspace,
            CapabilityId::WorkspaceRead,
            &serde_json::json!({ "path": "source.rs" }),
        )
        .unwrap(),
        CapabilityClass::WorkspaceInspect
    );
    assert!(effective_capability_class(
        &workspace,
        CapabilityId::WorkspaceRead,
        &serde_json::json!({ "path": "escape" }),
    )
    .is_err());

    let mut context = WorkspaceContextSnapshot::empty(workspace.display().to_string());
    context.selection = Some(serde_json::json!({
        "path": "public.txt", "text": "private contents",
    }));
    context.buffers = vec![
        serde_json::json!({ "path": "assets/config", "content": "private configuration" }),
        serde_json::json!({ "path": "source.rs", "content": "unsaved ordinary code" }),
    ];
    normalize_workspace_context_paths(&workspace, &mut context).unwrap();
    assert_eq!(
        context.selection.as_ref().unwrap()["text"],
        "private contents"
    );
    assert_eq!(context.buffers[0]["content"], "private configuration");
    assert_eq!(context.buffers[1]["content"], "unsaved ordinary code");
    let metadata = workspace_context_metadata(&context);
    assert!(metadata.selection.as_ref().unwrap().get("text").is_none());
    assert!(metadata.buffers[0].get("content").is_none());
    assert!(metadata.buffers[1].get("content").is_none());
}

#[test]
fn capability_child_fails_closed_without_the_desktop_host() {
    let temp = tempfile::tempdir().unwrap();
    let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
    let context = DesktopProviderCapabilityContext {
        session_id: Uuid::new_v4().to_string(),
        turn_id: Some(Uuid::new_v4().to_string()),
        run_nonce: "test-run-nonce".into(),
        provider_id: "openai".into(),
        workspace_key: temp.path().display().to_string(),
        mode: CapabilityRunMode::Normal,
        allow_delegation: false,
        compact_catalog: false,
        policy_revision: 0,
        workspace_context_revision: 0,
    };
    let result = desktop_capability_tool_call(
        &paths,
        &context,
        serde_json::json!({
            "name": "gyro_workspace_list",
            "arguments": { "depth": 2 },
        }),
    )
    .unwrap();
    assert_eq!(result["isError"], true);
    assert!(result["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("Gyro tools unavailable"));
}
