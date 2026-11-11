use super::*;

#[test]
fn model_search_keeps_regex_and_glob_semantics() {
    let workspace = tempfile::tempdir().unwrap();
    fs::write(workspace.path().join("match.rs"), "needle\n").unwrap();
    fs::write(workspace.path().join("other.txt"), "needle\n").unwrap();
    let globs = vec!["*.rs".to_string()];
    let results =
        run_workspace_rg_search(workspace.path(), "need.*", Some(&globs), 10, true).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].path, "match.rs");
    assert!(run_workspace_rg_search(workspace.path(), "[", Some(&globs), 10, true).is_err());
}

#[test]
fn model_search_bounds_large_match_sets() {
    let results = (0..100)
        .map(|index| WorkspaceSearchResult {
            path: format!("file-{index}.rs"),
            line_number: index + 1,
            line: "x".repeat(4_000),
            ranges: vec![WorkspaceSearchRange {
                start_column: 1,
                end_column: 2,
            }],
        })
        .collect();
    let (bounded, limited) =
        bound_model_search_results(results, DEFAULT_WORKSPACE_RESULT_BYTES).unwrap();
    assert!(limited);
    assert!(bounded.len() < 100);
    assert!(
        serde_json::to_vec(&bounded).unwrap().len()
            <= gyro_core::capabilities::MAX_CAPABILITY_RESULT_BYTES
    );
}

#[test]
fn internal_summary_requests_carry_only_their_own_input() {
    let mut request = anthropic_provider_request();
    request.mode = ChatMode::Council;
    request.message = "Summarize these diffs.\n\n---\n\n+ added line".into();
    request.workspace_check = None;
    let history = "User: an earlier unrelated question\n\nAssistant: an earlier answer";
    let chat = provider_context_message_with_capabilities(&request, Some(history), true, true);
    assert!(chat.contains(history), "ordinary chats keep their history");

    for purpose in [
        InternalRequestPurpose::ChangeSummary,
        InternalRequestPurpose::ContextSummary,
        InternalRequestPurpose::SessionTitle,
    ] {
        request.internal_purpose = Some(purpose);
        assert_eq!(local_conversation_history_for_request(&request), None);
        let prompt =
            provider_context_message_with_capabilities(&request, Some(history), true, true);
        assert!(!prompt.contains(history), "{purpose:?} leaked chat history");
        assert_eq!(prompt.matches("+ added line").count(), 1, "{purpose:?}");
        assert!(prompt.contains(purpose.label()));
        for chat_only in [
            "GYRO_QUESTIONS",
            "GYRO_TASKS",
            "Selected workspace",
            "Gyro Browser",
        ] {
            assert!(
                !prompt.contains(chat_only),
                "{purpose:?} carried {chat_only}"
            );
        }
        assert!(
            prompt.len() * 4 < chat.len(),
            "{purpose:?} prompt was {} bytes against {} for chat",
            prompt.len(),
            chat.len()
        );
        // Owned runners split the same prompt into a cacheable prefix and a tail.
        let (stable, dynamic) = efficiency::capture_prompt(|| {
            provider_context_message_with_capabilities(&request, None, true, true)
        });
        assert!(stable.starts_with("Gyro internal request:"));
        assert!(dynamic.ends_with("+ added line"));
    }
}

#[test]
fn compact_cli_wrapper_reaches_dispatch_only_when_the_run_serves_it() {
    let temp = tempfile::tempdir().unwrap();
    let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
    let mut context = DesktopProviderCapabilityContext {
        session_id: Uuid::new_v4().to_string(),
        turn_id: Some(Uuid::new_v4().to_string()),
        run_nonce: "test-run-nonce".into(),
        provider_id: "openai".into(),
        workspace_key: temp.path().display().to_string(),
        mode: CapabilityRunMode::Normal,
        allow_delegation: false,
        compact_catalog: true,
        policy_revision: 0,
        workspace_context_revision: 0,
    };
    let text = |result: serde_json::Value| {
        assert_eq!(result["isError"], true);
        result["content"][0]["text"].as_str().unwrap().to_string()
    };
    let valid = serde_json::json!({
        "name": provider_tool_batch::COMPACT_INVOKE,
        "arguments": {
            "name": "gyro_workspace_list",
            "arguments": { "depth": 2 },
        },
    });
    // No host is listening, so reaching dispatch fails closed with this message.
    assert!(
        text(desktop_capability_tool_call(&paths, &context, valid.clone()).unwrap())
            .contains("Gyro tools unavailable")
    );
    for bad in [
        serde_json::json!({ "name": "gyro_workspace_list" }),
        serde_json::json!({ "name": "not_a_tool", "arguments": {} }),
        serde_json::json!({ "name": provider_tool_batch::COMPACT_INVOKE, "arguments": {} }),
    ] {
        let message = text(
            desktop_capability_tool_call(
                &paths,
                &context,
                serde_json::json!({
                    "name": provider_tool_batch::COMPACT_INVOKE,
                    "arguments": bad,
                }),
            )
            .unwrap(),
        );
        assert!(message.contains("invalid-arguments"), "{message}");
        assert!(!message.contains("Gyro tools unavailable"), "{message}");
    }
    // Panes and full-list runs do not recognize the wrapper at all.
    context.compact_catalog = false;
    assert!(desktop_capability_tool_call(&paths, &context, valid).is_err());
}

#[test]
fn compact_cli_allowlists_add_only_the_wrapper() {
    let tools =
        "mcp__gyro_capabilities__gyro_workspace_read,mcp__gyro_capabilities__gyro_tool_catalog";
    assert_eq!(claude_allowed_capability_tools(tools.into(), false), tools);
    assert_eq!(
        claude_allowed_capability_tools(tools.into(), true),
        format!("{tools},mcp__gyro_capabilities__gyro_tool_invoke")
    );
    assert_eq!(claude_allowed_capability_tools(String::new(), true), "");
    assert_eq!(
        codex_compact_invoke_approval_args(),
        [
            "-c".to_string(),
            "mcp_servers.gyro_capabilities.tools.gyro_tool_invoke.approval_mode=\"approve\""
                .to_string(),
        ]
    );
}

#[test]
fn opening_prompt_does_not_repeat_inlined_tool_instructions() {
    let request = anthropic_provider_request();
    let opening = provider_context_message(&request);
    assert!(!opening.contains("Use gyro_workspace_list or gyro_workspace_search"));
    assert!(!opening.contains("gh run watch"));
    assert!(!opening.contains("carry it through authorized edits"));
    assert!(opening.contains("never end with a promise to report later"));
    assert!(opening.contains("gyro_terminal_wait"));
    assert!(opening.contains("gyro_workspace_edit"));
    assert!(opening.contains("knownContentHash"));
    assert!(opening.contains("Reuse current evidence"));
    assert!(opening.contains("compact argument schema"));
    assert!(opening.contains("top-level layout"));
    assert!(!opening.contains("before using a tool whose schema was not inlined"));
}

#[test]
fn owned_turns_share_one_stable_block_across_history_and_check_duration() {
    let mut first = anthropic_provider_request();
    let mut check = WorkspaceCheckReport::placeholder("/tmp/gyro-workspace");
    check.duration_ms = 12;
    first.workspace_check = Some(check);
    let mut second = first.clone();
    second.workspace_check.as_mut().unwrap().duration_ms = 4_000;
    second.message = "edit it again".into();
    let build = |request: &ProviderChatRequest, history: &str| {
        provider_context_message_with_capabilities(request, Some(history), true, false)
    };
    let (stable_a, dynamic_a) =
        efficiency::capture_prompt(|| build(&first, "User: one\n\nAssistant: first answer"));
    let (stable_b, dynamic_b) = efficiency::capture_prompt(|| {
        build(
            &second,
            "User: one\n\nAssistant: a different and longer answer",
        )
    });
    assert!(!stable_a.is_empty());
    assert_eq!(stable_a, stable_b);
    assert_ne!(dynamic_a, dynamic_b);
    assert!(!stable_a.contains("Prior conversation"));
    assert!(!stable_a.contains("Workspace check:"));
    assert!(!stable_a.contains("/tmp/gyro-workspace"));
    assert!(dynamic_a.contains("Workspace check: ready."));
    assert!(dynamic_b.contains("Workspace check: ready."));
    assert!(!dynamic_a.contains(" ms"));
    assert!(dynamic_a.contains("first answer"));
    assert!(dynamic_b.contains("different and longer answer"));
}

#[test]
fn api_failures_do_not_replay_the_entire_tool_loop() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
    let session = store
        .create_session(temp.path(), SessionOrigin::Desktop, "retry")
        .unwrap();
    for provider in ["deepseek", "ollama"] {
        let request = provider_chat_request_for(&session, temp.path(), provider);
        let mut attempts = 0;
        let result = run_provider_chat_with_retry_using(
            &store,
            &request,
            None,
            |_, _| {
                attempts += 1;
                anyhow::bail!("connection reset by peer");
            },
            || None,
        );
        assert!(result.is_err());
        assert_eq!(attempts, 1, "must not replay {provider} tools");
    }
}

#[test]
fn transient_failures_after_visible_output_are_not_replayed() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
    let session = store
        .create_session(temp.path(), SessionOrigin::Desktop, "retry")
        .unwrap();
    let request = provider_chat_request_for(&session, temp.path(), "xai");
    let mut attempts = 0;
    let result = run_provider_chat_with_retry_using(
        &store,
        &request,
        None,
        |_, attempt| {
            attempts += 1;
            attempt.published_output = true;
            anyhow::bail!("connection reset by peer");
        },
        || None,
    );
    assert!(result.is_err());
    assert_eq!(attempts, 1, "a turn that already ran tools must not rerun");
}

#[test]
fn stopping_during_a_retry_delay_starts_no_new_attempt() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
    let session = store
        .create_session(temp.path(), SessionOrigin::Desktop, "retry")
        .unwrap();
    let request = provider_chat_request_for(&session, temp.path(), "xai");
    let mut attempts = 0;
    let stop_checks = std::cell::Cell::new(0);
    let started = Instant::now();
    let error = run_provider_chat_with_retry_using(
        &store,
        &request,
        None,
        |_, _| {
            attempts += 1;
            anyhow::bail!("connection reset by peer");
        },
        || {
            let check = stop_checks.get();
            stop_checks.set(check + 1);
            (check > 0).then(|| ProviderStopReason::User.message())
        },
    )
    .unwrap_err();
    assert_eq!(attempts, 1);
    assert!(is_provider_cancellation(&error.to_string()));
    assert!(started.elapsed() < Duration::from_millis(300));
}

#[test]
fn transient_provider_errors_retry_with_backoff_then_succeed() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
    let session = store
        .create_session(temp.path(), SessionOrigin::Desktop, "retry")
        .unwrap();
    let request = provider_chat_request_for(&session, temp.path(), "xai");
    let mut attempts = 0u32;
    let output = run_provider_chat_with_retry_using(
        &store,
        &request,
        None,
        |cursor, attempt| {
            attempts += 1;
            if attempts < 2 {
                attempt.resume_cursor = Some(ProviderResumeCursor {
                    kind: "xai-acp-session".into(),
                    session_id: "acknowledged-session".into(),
                });
                return Err(anyhow::anyhow!("connection reset by peer")
                    .context("provider transport failed"));
            }
            assert_eq!(cursor.unwrap().session_id, "acknowledged-session");
            Ok(ProviderRunnerOutput {
                accounted_usage: None,
                activities: Vec::new(),
                context_usage: None,
                billed_usage: None,
                rate_limits: Vec::new(),
                paused_at_tool_budget: false,
                answer_cut_off: false,
                response: "recovered".into(),
                resume_cursor: None,
                retry_count: 0,
                resumed: false,
                streamed_text: None,
                output_summary: None,
            })
        },
        || None,
    )
    .unwrap();
    assert_eq!(attempts, 2);
    assert_eq!(output.retry_count, 1);
    assert_eq!(output.response, "recovered");
}

#[test]
fn streaming_state_can_flush_the_first_delta_immediately() {
    let mut state = StreamingCommandState::new();
    state.push_assistant_delta("hi");
    assert!(state.has_pending_delta());
    assert!(state.last_emit_at.is_none());
}

#[test]
fn normal_chat_detects_explicit_plan_requests() {
    for message in [
        "Get started on a plan for how local models can use the Gyro browser.",
        "Create an implementation plan for the provider migration.",
        "Could you plan how we should roll this out?",
        "I need a testing plan before we change anything.",
        "Plan out the safest migration.",
    ] {
        assert!(
            normal_chat_requests_plan(message),
            "expected planning intent: {message}"
        );
    }
}

#[test]
fn normal_chat_does_not_confuse_plan_references_with_plan_requests() {
    for message in [
        "Implement the approved plan.",
        "Implement this plan and verify the result.",
        "Don't make a plan; just fix the bug.",
        "Explain why the current plan failed.",
        "I want to discuss the plan before we continue.",
        "Make sure the plan card stays visible in chat.",
        "The airplane parser is broken.",
    ] {
        assert!(
            !normal_chat_requests_plan(message),
            "unexpected planning intent: {message}"
        );
    }
}

#[test]
fn every_chat_mode_can_ask_clarifying_questions() {
    let mut request = anthropic_provider_request();
    assert!(provider_context_message(&request).contains("GYRO_QUESTIONS:"));
    request.mode = ChatMode::Plan;
    assert!(provider_context_message(&request).contains("GYRO_QUESTIONS:"));
}

#[test]
fn live_plan_reaches_the_model_as_a_checklist_that_normal_turns_can_advance() {
    let mut request = anthropic_provider_request();
    request.plan = Some(serde_json::json!({
        "title": "Ship the rail",
        "content": "# Ship the rail\n\nLong markdown document.",
        "items": [
            {"id": "step-one", "title": "Read the reducer", "status": "complete"},
            {"id": "step-two", "title": "Move the chip", "status": "todo"},
        ],
    }));

    let context = provider_context_message(&request);

    assert!(context.contains("Current Gyro plan — Ship the rail"));
    assert!(context.contains("- [x] Read the reducer (id: step-one)"));
    assert!(context.contains("- [ ] Move the chip (id: step-two)"));
    // The escaped plan document must not ride along as raw JSON.
    assert!(!context.contains("Long markdown document"));
    // Normal-mode turns are the ones that finish steps, so they get the marker.
    assert!(context.contains("GYRO_PLAN_UPDATE:"));
    assert!(context.contains("update-items"));
    assert!(context.contains("Before starting a step"));
    assert!(context.contains("before your next tool call; do not wait for the final answer"));
    assert!(context.contains("Before the final reply, reconcile the checklist"));
    assert!(context.contains("external acceptance blocked"));

    let mut planless = anthropic_provider_request();
    planless.plan = None;
    assert!(!provider_context_message(&planless).contains("GYRO_PLAN_UPDATE:"));
}

#[test]
fn a_met_goal_stays_in_context_and_only_an_active_one_can_be_completed() {
    let mut request = anthropic_provider_request();
    request.goal = Some(SessionGoalContext {
        text: "Ship the plan rail".into(),
        status: "active".into(),
    });

    let active = provider_context_message(&request);
    assert!(active.contains("Active Gyro session goal: Ship the plan rail"));
    assert!(active.contains("GYRO_GOAL_UPDATE:"));
    assert!(active.contains("Gyro starts the next turn itself"));
    assert!(active.contains("Do not ask the user to continue"));
    assert!(active.contains("removes the goal from above the composer"));

    request.goal = Some(SessionGoalContext {
        text: "Ship the plan rail".into(),
        status: "complete".into(),
    });

    let met = provider_context_message(&request);
    assert!(met.contains("already met — do not redo that work"));
    assert!(met.contains("Ship the plan rail"));
    // Nothing to complete twice, so the marker instruction stays away.
    assert!(!met.contains("GYRO_GOAL_UPDATE:"));
}

#[test]
fn a_plan_turn_is_told_the_goal_it_is_planning_toward() {
    // Plan mode used to clear the goal before the turn was built, so the
    // one turn whose whole job is reaching the outcome never heard it.
    let mut request = anthropic_provider_request();
    request.mode = ChatMode::Plan;
    request.goal = Some(SessionGoalContext {
        text: "Ship the plan rail".into(),
        status: "active".into(),
    });

    let planning = provider_context_message(&request);
    assert!(planning.contains("Plan mode is read-only."));
    assert!(planning.contains("Active Gyro session goal: Ship the plan rail"));
}

#[test]
fn goal_marker_is_captured_and_never_shown_in_the_bubble() {
    let stripped = strip_hidden_control_markers(
        "GYRO_GOAL_UPDATE: {\"status\":\"complete\"}\n\nThe rail is shipped.",
    );

    assert_eq!(stripped.message, "The rail is shipped.");
    assert_eq!(
        stripped
            .goal_update
            .as_ref()
            .and_then(|update| update.get("status"))
            .and_then(serde_json::Value::as_str),
        Some("complete")
    );
}

#[test]
fn the_last_valid_goal_checkpoint_wins_without_leaking_control_text() {
    let stripped = strip_hidden_control_markers(
            "Draft.GYRO_GOAL_UPDATE: {\"status\":\"continue\",\"progress\":\"Code ready\",\"nextAction\":\"Run checks\"}\nGYRO_GOAL_UPDATE: {\"status\":\"complete\",\"progress\":\"Checks passed\"}\nGYRO_GOAL_UPDATE: {\"status\":\"invalid\"}\nFinished."
        );
    assert_eq!(stripped.goal_update.as_ref().unwrap()["status"], "complete");
    assert_eq!(
        stripped.goal_update.as_ref().unwrap()["progress"],
        "Checks passed"
    );
    assert!(!stripped.message.contains(GYRO_GOAL_UPDATE_MARKER));
}

#[test]
fn agent_completion_markers_are_hidden_validated_and_kept_separate_from_goals() {
    let stripped = strip_hidden_control_markers(
            "Progress.GYRO_AGENT_UPDATE: {\"status\":\"continue\",\"reason\":\"Tests remain\"}\n\nParser updated."
        );
    assert_eq!(
        stripped.agent_update.as_ref().unwrap()["status"],
        "continue"
    );
    assert_eq!(
        stripped.agent_update.as_ref().unwrap()["reason"],
        "Tests remain"
    );
    assert!(!stripped.message.contains(GYRO_AGENT_UPDATE_MARKER));
    assert!(stripped.goal_update.is_none());
    let invalid = strip_hidden_control_markers(
        "GYRO_AGENT_UPDATE: {\"status\":\"approved\"}\nRead the report.",
    );
    assert!(invalid.agent_update.is_none());
    assert_eq!(invalid.message, "Read the report.");
}

#[test]
fn gated_provider_context_requires_a_question_for_each_action() {
    let mut request = anthropic_provider_request();
    request.provider_id = "openai".into();
    request.require_command_approval = true;
    request.require_file_edit_approval = true;

    let context = provider_context_message(&request);

    assert!(context.contains("before every command or executable tool action"));
    assert!(context.contains("including commands that appear read-only or trusted"));
    assert!(context.contains("before every file change"));
    assert!(context.contains("never infer approval"));
}

#[test]
fn command_lines_split_without_a_shell() {
    let (command, args) =
        parse_command_line("  pnpm  run test --filter \"@gyro-dev/ui\" ").unwrap();
    assert_eq!(command, "pnpm");
    assert_eq!(args, vec!["run", "test", "--filter", "@gyro-dev/ui"]);

    let (command, args) = parse_command_line("./scripts/run.sh 'one two'").unwrap();
    assert_eq!(command, "./scripts/run.sh");
    assert_eq!(args, vec!["one two"]);

    assert!(parse_command_line("   ").is_err());
    assert!(parse_command_line("echo \"unclosed").is_err());
}

#[test]
fn saved_commands_round_trip_into_the_discovered_catalog() {
    let workspace = tempfile::tempdir().unwrap();
    let workspace_path = workspace.path().display().to_string();
    std::fs::write(
        workspace.path().join("package.json"),
        r#"{"scripts":{"test":"vitest"}}"#,
    )
    .unwrap();

    let tasks = custom_task_create_impl(&CustomTaskCreateRequest {
        workspace_path: workspace_path.clone(),
        command_line: "pnpm run smoke --reporter dot".into(),
        label: Some("Smoke".into()),
        group: Some("test".into()),
        cwd: None,
    })
    .unwrap();
    let saved = tasks
        .iter()
        .find(|task| task.source == "custom")
        .expect("saved command is discoverable");
    assert_eq!(saved.id, "custom:Smoke");
    assert_eq!(saved.command, "pnpm");
    assert_eq!(saved.args, vec!["run", "smoke", "--reporter", "dot"]);
    assert_eq!(saved.group, "test");
    assert!(tasks.iter().any(|task| task.id == "package:test"));
    assert!(workspace.path().join(".gyro/tasks.json").is_file());

    let remaining = custom_task_delete_impl(&CustomTaskDeleteRequest {
        workspace_path: workspace_path.clone(),
        task_id: "custom:Smoke".into(),
    })
    .unwrap();
    assert!(remaining.iter().all(|task| task.source != "custom"));
}

#[test]
fn package_scripts_keep_later_names_and_split_checks_from_tests() {
    let workspace = tempfile::tempdir().unwrap();
    let names: Vec<String> = (0..45).map(|index| format!("task-{index:02}")).collect();
    let mut scripts = names
        .iter()
        .map(|name| format!("\"{name}\": \"echo {name}\""))
        .collect::<Vec<_>>();
    scripts.push("\"test\": \"vitest\"".into());
    scripts.push("\"test:reliability\": \"vitest reliability\"".into());
    scripts.push("\"release:check\": \"node check.js\"".into());
    scripts.push("\"test:local-check-browser\": \"node browser.js\"".into());
    std::fs::write(
        workspace.path().join("package.json"),
        format!("{{\"scripts\":{{{}}}}}", scripts.join(",")),
    )
    .unwrap();
    std::fs::write(
        workspace.path().join("pnpm-lock.yaml"),
        "lockfileVersion: 9\n",
    )
    .unwrap();

    let tasks = task_discover_impl(&workspace.path().display().to_string()).unwrap();
    let by_id = |id: &str| tasks.iter().find(|task| task.id == id).unwrap();
    assert!(tasks.iter().any(|task| task.id == "package:task-44"));
    assert_eq!(by_id("package:test").group, "test");
    assert_eq!(by_id("package:test").role, "primary");
    assert_eq!(by_id("package:test:reliability").group, "test");
    assert_eq!(by_id("package:test:reliability").role, "variant");
    assert_eq!(by_id("package:release:check").group, "check");
    assert_eq!(by_id("package:test:local-check-browser").group, "test");
}

#[test]
fn python_pytest_is_offered_only_when_the_project_asks() {
    let bare = tempfile::tempdir().unwrap();
    std::fs::write(
        bare.path().join("pyproject.toml"),
        "[project]\nname = \"bare\"\n",
    )
    .unwrap();
    let bare_tasks = task_discover_impl(&bare.path().display().to_string()).unwrap();
    assert!(bare_tasks.iter().all(|task| task.id != "python:pytest"));

    let tested = tempfile::tempdir().unwrap();
    std::fs::write(
        tested.path().join("pyproject.toml"),
        "[project]\nname = \"tested\"\n[tool.pytest.ini_options]\n",
    )
    .unwrap();
    std::fs::write(tested.path().join("uv.lock"), "").unwrap();
    let tasks = task_discover_impl(&tested.path().display().to_string()).unwrap();
    let pytest = tasks
        .iter()
        .find(|task| task.id == "python:pytest")
        .unwrap();
    assert_eq!(pytest.command, "uv");
    assert_eq!(pytest.args, vec!["run", "pytest"]);
}

#[test]
fn truncates_large_text_preview() {
    let workspace = tempfile::tempdir().unwrap();
    let large = "a".repeat(MAX_WORKSPACE_FILE_PREVIEW_BYTES + 16);
    std::fs::write(workspace.path().join("large.txt"), large).unwrap();

    let content =
        read_workspace_file_impl(workspace.path().to_str().unwrap(), "large.txt").unwrap();

    assert!(content.truncated);
    assert_eq!(content.content.len(), MAX_WORKSPACE_FILE_PREVIEW_BYTES);
    assert_eq!(
        content.size_bytes,
        (MAX_WORKSPACE_FILE_PREVIEW_BYTES + 16) as u64
    );
}

#[test]
fn rejects_binary_write_content() {
    let workspace = tempfile::tempdir().unwrap();
    std::fs::write(workspace.path().join("bin.txt"), "old\n").unwrap();

    let error = write_workspace_file_impl(&WorkspaceFileWriteRequest {
        workspace_path: workspace.path().to_str().unwrap().into(),
        path: "bin.txt".into(),
        content: "bad\0content".into(),
        expected_hash: None,
    })
    .unwrap_err();

    assert!(error.to_string().contains("binary workspace files"));
}

#[test]
fn rejects_oversized_write_content() {
    let workspace = tempfile::tempdir().unwrap();
    std::fs::write(workspace.path().join("large.txt"), "old\n").unwrap();

    let error = write_workspace_file_impl(&WorkspaceFileWriteRequest {
        workspace_path: workspace.path().to_str().unwrap().into(),
        path: "large.txt".into(),
        content: "a".repeat(MAX_WORKSPACE_FILE_EDIT_BYTES + 1),
        expected_hash: None,
    })
    .unwrap_err();

    assert!(error.to_string().contains("too large"));
}

#[test]
fn rejects_stale_expected_hash() {
    let workspace = tempfile::tempdir().unwrap();
    std::fs::write(workspace.path().join("app.ts"), "old\n").unwrap();
    let content = read_workspace_file_with_limit(
        workspace.path().to_str().unwrap(),
        "app.ts",
        MAX_WORKSPACE_FILE_EDIT_BYTES,
    )
    .unwrap();
    std::fs::write(workspace.path().join("app.ts"), "external\n").unwrap();

    let error = write_workspace_file_impl(&WorkspaceFileWriteRequest {
        workspace_path: workspace.path().to_str().unwrap().into(),
        path: "app.ts".into(),
        content: "new\n".into(),
        expected_hash: Some(content.content_hash),
    })
    .unwrap_err();

    assert!(error.to_string().contains("changed on disk"));
}

#[test]
fn validates_supported_chat_video_containers() {
    let mp4 = b"\0\0\0\x18ftypisom\0\0\0\0isom";
    let webm = [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81];

    assert_eq!(
        validated_chat_media_type("clip.mp4", true, mp4).unwrap(),
        ("video/mp4", "mp4")
    );
    assert_eq!(
        validated_chat_media_type("clip.webm", true, &webm).unwrap(),
        ("video/webm", "webm")
    );
    assert!(validated_chat_media_type("clip.mp4", true, b"not a video")
        .unwrap_err()
        .contains("do not match"));
    assert!(validated_chat_media_type("image.png", true, b"\x89PNG\r\n\x1a\n").is_err());

    // macOS screen recordings use the `qt  ` brand; legacy QuickTime files
    // may lead with a `wide` padding atom.
    let screen_recording = b"\0\0\0\x14ftypqt  \0\0\0\0";
    let legacy_mov = b"\0\0\0\x08wide\0\0\0\0mdat";
    assert_eq!(
        validated_chat_media_type("Screen Recording.mov", true, screen_recording).unwrap(),
        ("video/quicktime", "mov")
    );
    assert_eq!(
        validated_chat_media_type("legacy.MOV", true, legacy_mov).unwrap(),
        ("video/quicktime", "mov")
    );
    assert!(validated_chat_media_type("fake.mov", true, b"\0\0\0\x08junkjunk").is_err());
    // A JPEG saved as .png, or a paste with no extension, is still a JPEG.
    let jpeg = [0xff, 0xd8, 0xff, 0xe0];
    assert_eq!(
        validated_chat_media_type("photo.png", false, &jpeg).unwrap(),
        ("image/jpeg", "jpg")
    );
    assert_eq!(
        validated_chat_media_type("pasted", false, &jpeg).unwrap(),
        ("image/jpeg", "jpg")
    );
    assert!(validated_chat_media_type("scan.tiff", false, b"II*\0").is_err());
}

#[test]
fn gui_cli_paths_include_latest_nvm_node_bin() {
    let home = tempfile::tempdir().unwrap();
    let node_versions = home.path().join(".nvm/versions/node");
    std::fs::create_dir_all(node_versions.join("v22.23.1/bin")).unwrap();
    std::fs::create_dir_all(node_versions.join("v24.11.0/bin")).unwrap();
    std::fs::create_dir_all(node_versions.join("v9.9.9/bin")).unwrap();

    let paths = user_cli_paths(home.path());
    let nvm_paths = paths
        .iter()
        .filter(|path| path.contains(".nvm/versions/node"))
        .collect::<Vec<_>>();

    assert_eq!(nvm_paths.len(), 3);
    assert!(nvm_paths[0].ends_with("v24.11.0/bin"));
    assert!(nvm_paths[1].ends_with("v22.23.1/bin"));
    assert!(nvm_paths[2].ends_with("v9.9.9/bin"));
    assert!(paths.iter().any(|path| path.ends_with(".volta/bin")));
    assert!(paths.iter().any(|path| path.ends_with(".asdf/shims")));
    assert!(paths.iter().any(|path| path.ends_with(".grok/bin")));
    assert!(paths.iter().any(|path| path.ends_with(".kimi-code/bin")));
    assert!(paths.iter().any(|path| path.ends_with(".npm-global/bin")));
    assert!(paths.iter().any(|path| path.ends_with(".cursor/bin")));
}

#[test]
fn all_catalog_context_windows_and_cli_efforts_match_verified_metadata() {
    let facts: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../scripts/fixtures/model-metadata.json"
    ))
    .unwrap();
    let published: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../catalog/model-catalog.json")).unwrap();
    for row in facts["models"].as_array().unwrap() {
        let provider = row[0].as_str().unwrap();
        let model = row[1].as_str().unwrap();
        let window = provider_model_context_window(provider, Some(model));
        // A model added through the remote catalog has no bundled facts;
        // the installed catalog supplies them, so verify the entry instead.
        let catalog_entry = published["models"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["providerId"] == provider && entry["id"] == model);
        if let (None, Some(entry)) = (window, catalog_entry) {
            assert_eq!(
                entry["contextWindowTokens"].as_u64(),
                row[2].as_u64(),
                "{provider}/{model} catalog context"
            );
            assert_eq!(
                entry["supportedReasoningEfforts"], row[3],
                "{provider}/{model} catalog efforts"
            );
            if let Some(default) = row.get(4) {
                assert_eq!(
                    &entry["defaultReasoningEffort"], default,
                    "{provider}/{model} catalog default effort"
                );
            }
            continue;
        }
        assert_eq!(window, row[2].as_u64(), "{provider}/{model} context");
        for effort in ["low", "medium", "high", "xhigh", "max", "ultra", "invalid"] {
            let actual = match provider {
                "openai" => codex_reasoning_effort_arg(Some(model), Some(effort)),
                "anthropic" => claude_reasoning_effort_arg(Some(model), Some(effort)),
                "xai" => grok_reasoning_effort_arg(Some(model), Some(effort)),
                _ => continue,
            };
            let expected = row[3]
                .as_array()
                .unwrap()
                .iter()
                .any(|value| value.as_str() == Some(effort))
                .then(|| effort.to_string());
            assert_eq!(actual, expected, "{provider}/{model} effort {effort}");
        }
    }
}

#[test]
fn catalog_models_unknown_to_this_release_forward_their_effort() {
    for effort in ["low", "medium", "high", "xhigh", "max", "ultra"] {
        assert_eq!(
            codex_reasoning_effort_arg(Some("gpt-7-nova"), Some(effort)),
            Some(effort.into())
        );
    }
    assert_eq!(
        codex_reasoning_effort_arg(Some("gpt-7-nova"), Some("invalid")),
        None
    );
}

#[test]
fn compact_native_resume_prompts_keep_live_state_and_protocols_across_providers() {
    let temp = tempfile::tempdir().unwrap();
    let attachment = temp.path().join("output.txt");
    fs::write(&attachment, "Explicit captured output").unwrap();
    for provider in [
        "openai",
        "anthropic",
        "kimi",
        "xai",
        "gemini",
        "cursor",
        "opencode",
    ] {
        let mut request = anthropic_provider_request();
        request.provider_id = provider.into();
        request.reasoning_effort = Some("max".into());
        request.message =
            "Use subagents to continue the authorized workspace implementation".into();
        request.workspace_check = Some(WorkspaceCheckReport::placeholder("/tmp/gyro-workspace"));
        request.goal = Some(SessionGoalContext {
            text: "Finish the requested change".into(),
            status: "active".into(),
        });
        request.plan = Some(
            serde_json::json!({"title": "Current plan", "items": [{"id": "step-1", "title": "Verify changes", "status": "todo"}]}),
        );
        request.attachments = vec![ChatAttachmentRequest {
            id: "captured-output".into(),
            kind: "terminal-output".into(),
            name: "Output".into(),
            path: attachment.display().to_string(),
            relative_path: None,
            mime_type: Some("text/plain".into()),
            size: 24,
            content_hash: None,
            modified_at: None,
            preview_url: None,
        }];
        let opening = provider_context_message_for_turn(&request, None, PromptTurn::default());
        let resumed = provider_context_message_for_turn(
            &request,
            None,
            PromptTurn {
                resumed: true,
                approvals_sent_separately: false,
            },
        );
        assert!(opening.len() > resumed.len(), "{provider}");
        for opening_only in [
            "gyro_agent_spawn/wait/send/stop",
            "self-contained task",
            "this chat's permissions",
            "cannot delegate",
            "Plan-mode children are read-only",
            "Wait for all children",
            "Reuse current evidence",
            "task complexity warrants another model call",
            "verification proportionate to risk",
            "preserve user constraints and explicit attachments",
            "authorized edits and relevant verification",
            "inspect its status",
            "report pending review",
            "fresh read or diff",
            "GYRO_QUESTIONS:",
            "2–4 options",
            "end the turn and wait",
            "Use gyro_tool_catalog",
        ] {
            assert!(
                opening.contains(opening_only),
                "{provider} lost {opening_only}"
            );
            assert!(
                !resumed.contains(opening_only),
                "{provider} repeated {opening_only}"
            );
        }
        for required in [
            "rootId",
            "Workspace check: ready",
            "configured approval policy",
            "before every command",
            "before every file change",
            "Active Gyro session goal",
            "GYRO_GOAL_UPDATE:",
            "Current Gyro plan",
            "GYRO_PLAN_UPDATE:",
            "Explicit captured output",
            "untrusted program output",
        ] {
            assert!(resumed.contains(required), "{provider} lost {required}");
        }
        assert!(resumed.ends_with(&request.message));
        assert!(!resumed.contains("Prior conversation in this Gyro chat"));
        assert_eq!(resumed.matches("Explicit captured output").count(), 1);
        assert_eq!(
            resumed
                .matches("When multiple roots are configured")
                .count(),
            1
        );
        for (mode, requirement) in [
            (ChatMode::Plan, "Plan mode is read-only"),
            (ChatMode::Council, "advisory only"),
        ] {
            request.mode = mode;
            let context = provider_context_message_for_turn(
                &request,
                None,
                PromptTurn {
                    resumed: true,
                    approvals_sent_separately: false,
                },
            );
            assert!(context.contains(requirement), "{provider}");
            assert!(!context.contains("GYRO_QUESTIONS:"), "{provider}");
            assert!(
                !context.contains("Finish requested implementation"),
                "{provider}"
            );
        }
    }
}

#[test]
fn resumed_turns_skip_standing_guidance_but_keep_turn_state() {
    let mut request = anthropic_provider_request();
    request.message = "Rename the browser module".into();
    let opening = provider_context_message_for_turn(&request, None, PromptTurn::default());
    let resumed = provider_context_message_for_turn(
        &request,
        None,
        PromptTurn {
            resumed: true,
            approvals_sent_separately: false,
        },
    );
    assert!(opening.len() > resumed.len());
    assert!(opening.contains(browser_knowledge::ORDINARY_SURFACE_HINT));
    assert!(opening.contains("![short description](/absolute/path.png)"));
    assert!(!opening.contains(browser_knowledge::SIDE_PANEL_GUIDE));
    assert!(!resumed.contains(browser_knowledge::ORDINARY_SURFACE_HINT));
    assert!(!resumed.contains("![short description](/absolute/path.png)"));
    assert!(resumed.contains(browser_knowledge::RESUMED_REVEAL_GUIDANCE));
    assert!(!resumed.contains("never end with a promise to report later"));
    assert!(!resumed.contains("do not ask the user to paste files you can read"));
    assert!(!resumed.contains("a bare filename names a root file"));
    for guard in [
        "preserve user-supplied paths exactly",
        "a failed read never authorizes creation",
        "Read-only and edit-path limits also cover proposals",
        "rootId",
    ] {
        assert!(resumed.contains(guard), "Resume lost {guard}");
    }
    assert!(resumed.contains("configured approval policy"));
    assert!(resumed.ends_with("User message:\nRename the browser module"));
    // Naming browser code is not a browse request.
    assert!(!opening.contains(browser_knowledge::GUIDE));

    let codex = provider_context_message_for_turn(
        &request,
        None,
        PromptTurn {
            resumed: true,
            approvals_sent_separately: true,
        },
    );
    assert!(!codex.contains("configured approval policy"));

    let claude_resumed = claude_chat_prompt("next", Some("/tmp/project"), false, true, true);
    assert!(!claude_resumed.contains("GYRO_ARTIFACTS:"));
    assert!(!claude_resumed.contains("![short description](/absolute/path.png)"));
    // A resumed turn is never asked to name the session again; the opening
    // turn is, so every provider titles the chat it starts.
    assert!(claude_resumed.contains("Do not write a GYRO_SESSION_TITLE line"));
    assert!(!claude_resumed.contains("name the session immediately"));
    let claude_opening = claude_chat_prompt("start", Some("/tmp/project"), true, true, false);
    assert!(claude_opening.contains("GYRO_SESSION_TITLE: <2-6 word title>"));
    assert!(claude_opening.contains("name the session immediately"));
    assert!(claude_opening.contains("![short description](/absolute/path.png)"));
    assert!(claude_resumed.contains("must follow Gyro's permission decisions"));
    let codex_resumed =
        openai_codex_chat_prompt("next", Some("/workspace"), Some("GPT"), false, false, true);
    assert!(!codex_resumed.contains("polished, scannable Markdown"));
    assert!(!codex_resumed.contains("![short description](/absolute/path.png)"));
    assert!(codex_resumed.contains("Do not edit files"));
    assert!(codex_resumed.contains("selected model label is: GPT"));
}

#[test]
fn provider_chat_command_args_use_resume_contracts() {
    let output_path = PathBuf::from("/tmp/gyro-last-message.txt");
    let image = ChatAttachmentRequest {
        id: "image-1".into(),
        kind: "image".into(),
        name: "screen.png".into(),
        path: "/tmp/screen.png".into(),
        relative_path: None,
        mime_type: Some("image/png".into()),
        size: 128,
        content_hash: None,
        modified_at: None,
        preview_url: None,
    };
    let fresh_codex = codex_chat_args(
        None,
        &output_path,
        Some("gpt-5.6-sol"),
        Some("max"),
        &ChatMode::Normal,
        true,
        true,
        false,
        std::slice::from_ref(&image),
        "hello",
    );
    assert_eq!(fresh_codex[0], "exec");
    assert!(fresh_codex.contains(&"--sandbox".to_string()));
    assert!(fresh_codex.contains(&"read-only".to_string()));
    assert!(fresh_codex.contains(&"--json".to_string()));
    assert!(fresh_codex.contains(&"--output-last-message".to_string()));
    assert!(fresh_codex.contains(&"gpt-5.6-sol".to_string()));
    assert!(fresh_codex.contains(&"model_reasoning_effort=\"max\"".to_string()));
    assert!(fresh_codex
        .windows(2)
        .any(|args| args == ["--image", "/tmp/screen.png"]));
    assert_eq!(
        fresh_codex[fresh_codex.len() - 2..],
        ["--".to_string(), "hello".to_string()]
    );
    assert_eq!(fresh_codex.last(), Some(&"hello".to_string()));

    let full_access_codex = codex_chat_args(
        None,
        &output_path,
        None,
        None,
        &ChatMode::Normal,
        false,
        false,
        true,
        &[],
        "edit it",
    );
    assert!(full_access_codex.contains(&"--dangerously-bypass-approvals-and-sandbox".to_string()));
    assert!(!full_access_codex.contains(&"read-only".to_string()));

    let resumed_codex = codex_chat_args(
        Some("019f4612-7e58-7412-9fe9-5f0d6cb29c8e"),
        &output_path,
        None,
        None,
        &ChatMode::Normal,
        true,
        true,
        false,
        &[],
        "again",
    );
    assert_eq!(
        resumed_codex[..3],
        [
            "exec".to_string(),
            "resume".to_string(),
            "--json".to_string()
        ]
    );
    for args in [&fresh_codex, &resumed_codex] {
        assert!(
            args.windows(2)
                .any(|pair| pair == ["-c", "features.multi_agent=false"]),
            "only Gyro-owned delegation should be available"
        );
    }
    assert!(resumed_codex.contains(&"--skip-git-repo-check".to_string()));
    assert!(resumed_codex
        .windows(2)
        .any(|args| args == ["--config", "sandbox_mode=\"read-only\""]));
    assert!(!resumed_codex.contains(&"--sandbox".to_string()));
    assert!(resumed_codex.ends_with(&["--".to_string(), "again".to_string()]));

    for resume_session_id in [None, Some("019f4612-7e58-7412-9fe9-5f0d6cb29c8e")] {
        let plan_codex = codex_chat_args(
            resume_session_id,
            &output_path,
            None,
            None,
            &ChatMode::Plan,
            false,
            false,
            false,
            &[],
            "inspect only",
        );
        let expected_read_only_args = if resume_session_id.is_some() {
            ["--config", "sandbox_mode=\"read-only\""]
        } else {
            ["--sandbox", "read-only"]
        };
        assert!(plan_codex
            .windows(2)
            .any(|args| args == expected_read_only_args));
        if resume_session_id.is_some() {
            assert!(!plan_codex.contains(&"--sandbox".to_string()));
        }
        assert!(!plan_codex.contains(&"--dangerously-bypass-approvals-and-sandbox".to_string()));
    }

    let fresh_claude = claude_chat_args(
        None,
        "019f4612-7e58-7412-9fe9-5f0d6cb29c8e",
        Some("sonnet"),
        Some("xhigh"),
        &ChatMode::Normal,
        true,
        true,
        false,
        Some("{\"mcpServers\":{}}"),
        "hello",
    );
    assert!(fresh_claude.contains(&"--print".to_string()));
    assert!(fresh_claude.contains(&"stream-json".to_string()));
    assert!(fresh_claude.contains(&"--include-partial-messages".to_string()));
    // `--print --output-format stream-json` is rejected without `--verbose`.
    assert!(fresh_claude.contains(&"--verbose".to_string()));
    assert!(fresh_claude.contains(&"--session-id".to_string()));
    assert!(fresh_claude.contains(&"--mcp-config".to_string()));
    assert!(fresh_claude.contains(&"--permission-prompt-tool".to_string()));
    assert!(fresh_claude.contains(&"mcp__gyro_approval__approve".to_string()));
    assert!(fresh_claude
        .windows(2)
        .any(|args| args == ["--permission-mode", "manual"]));
    assert!(!fresh_claude.contains(&"--dangerously-skip-permissions".to_string()));
    assert!(fresh_claude
        .windows(2)
        .any(|args| args == ["--model", "sonnet"]));
    assert!(fresh_claude
        .windows(2)
        .any(|args| args == ["--effort", "xhigh"]));
    assert_eq!(fresh_claude.last(), Some(&"hello".to_string()));
    // Native tools that would route around Gyro's surfaces stay off,
    // most visibly claude.ai publishing in place of Gyro Canvas.
    let disallowed = fresh_claude
        .windows(2)
        .find(|args| args[0] == "--disallowedTools")
        .map(|args| args[1].split(',').collect::<Vec<_>>())
        .expect("Claude runs always disallow some native tools");
    for tool in [
        "Agent",
        "Task",
        "Artifact",
        "DesignSync",
        "ScheduleWakeup",
        "EnterWorktree",
    ] {
        assert!(disallowed.contains(&tool), "{tool} must stay disallowed");
    }
    // Native file and shell tools remain: they are approval-gated and the
    // fallback when a Gyro bridge is unavailable.
    for tool in ["Read", "Edit", "Bash"] {
        assert!(!disallowed.contains(&tool), "{tool} must stay available");
    }

    let auto_approve_claude = claude_chat_args(
        None,
        "019f4612-7e58-7412-9fe9-5f0d6cb29c8e",
        None,
        None,
        &ChatMode::Normal,
        false,
        false,
        false,
        Some("{\"mcpServers\":{}}"),
        "edit it",
    );
    assert!(auto_approve_claude.contains(&"--permission-prompt-tool".to_string()));
    assert!(auto_approve_claude
        .windows(2)
        .any(|args| args == ["--permission-mode", "auto"]));
    assert!(!auto_approve_claude.contains(&"--dangerously-skip-permissions".to_string()));

    let full_access_claude = claude_chat_args(
        None,
        "019f4612-7e58-7412-9fe9-5f0d6cb29c8e",
        None,
        None,
        &ChatMode::Normal,
        false,
        false,
        true,
        None,
        "edit it",
    );
    assert!(full_access_claude.contains(&"--dangerously-skip-permissions".to_string()));
    // `--allowedTools` is variadic, so the prompt must sit behind an option
    // terminator or the CLI parses it as another tool name.
    assert_eq!(
        full_access_claude.iter().rev().take(2).collect::<Vec<_>>(),
        vec![&"edit it".to_string(), &"--".to_string()]
    );

    let resumed_claude = claude_chat_args(
        Some("019f4612-7e58-7412-9fe9-5f0d6cb29c8e"),
        "unused",
        None,
        Some("ultra"),
        &ChatMode::Plan,
        false,
        false,
        false,
        Some("{\"mcpServers\":{}}"),
        "again",
    );
    assert!(resumed_claude.contains(&"--resume".to_string()));
    assert!(resumed_claude.contains(&"plan".to_string()));
    // `ultra` is a GPT-5.6 level Claude Code rejects, so it is dropped
    // rather than passed through to fail the run.
    assert!(!resumed_claude.contains(&"--effort".to_string()));
    assert!(resumed_claude.contains(&"--mcp-config".to_string()));
    assert!(resumed_claude.contains(&"--strict-mcp-config".to_string()));
    assert_eq!(
        resumed_claude.iter().rev().take(2).collect::<Vec<_>>(),
        vec![&"again".to_string(), &"--".to_string()]
    );
}

#[test]
fn every_provider_arg_vector_satisfies_its_cli_contract() {
    for (provider_id, label, args) in every_provider_chat_arg_vector() {
        let contract =
            gyro_core::provider_cli_contract(provider_id).expect("provider declares a contract");

        assert_eq!(
            gyro_core::audit_provider_args(contract, &args),
            Ok(()),
            "{label} builds an argument vector its CLI would misread: {args:?}"
        );
    }
}

/// Verify the installed provider CLIs still accept the argument vectors
/// Gyro builds.
///
/// This launches the real CLIs, so it is opt-in rather than part of the
/// default suite:
///
/// ```text
/// cargo test -p gyro-desktop -- --ignored provider_arg_vectors
/// ```
///
/// It is the only check that catches drift on the CLI's side of the
/// contract — an undocumented flag disappearing, or a new rule about which
/// flags must appear together. A provider whose CLI is not installed is
/// skipped rather than failed.
#[test]
#[ignore = "launches the installed provider CLIs"]
fn provider_arg_vectors_are_accepted_by_the_installed_clis() {
    let mut checked = 0usize;
    let mut skipped = Vec::new();

    for (provider_id, label, args) in every_provider_chat_arg_vector() {
        let contract =
            gyro_core::provider_cli_contract(provider_id).expect("provider declares a contract");
        let probe = gyro_core::probe_provider_args(
            contract.program,
            &args,
            gyro_core::PROVIDER_ARG_PROBE_TIMEOUT,
        )
        .expect("probe runs");

        match probe {
            gyro_core::ArgAcceptance::Accepted => checked += 1,
            gyro_core::ArgAcceptance::Unavailable { .. } => skipped.push(label),
            gyro_core::ArgAcceptance::Rejected { message } => panic!(
                "`{}` rejected the {label} argument vector: {message}\nargs: {args:?}",
                contract.program
            ),
        }
    }

    assert!(
        checked > 0,
        "no provider CLI was available to verify (skipped: {skipped:?})"
    );
}

#[test]
fn provider_stream_parsers_extract_cursor_and_text() {
    let session_id = "019f4612-7e58-7412-9fe9-5f0d6cb29c8e";
    let nested = serde_json::json!({
        "type": "session.started",
        "data": { "sessionId": session_id }
    });
    assert_eq!(
        extract_provider_session_id(&nested).as_deref(),
        Some(session_id)
    );

    assert_eq!(
        extract_provider_text_delta(&serde_json::json!({
            "type": "content_block_delta",
            "delta": { "text": "hel" }
        }))
        .as_deref(),
        Some("hel")
    );
    assert_eq!(
        extract_provider_text_delta(&serde_json::json!({
            "type": "partial_message",
            "text": "lo"
        }))
        .as_deref(),
        Some("lo")
    );
    assert_eq!(
        extract_provider_text_delta(&serde_json::json!({
            "type": "response.output_text.delta",
            "delta": " there"
        }))
        .as_deref(),
        Some(" there")
    );
    assert_eq!(
        extract_provider_text_delta(&serde_json::json!({
            "type": "response.output_text.delta",
            "delta": { "text": " from object" }
        }))
        .as_deref(),
        Some(" from object")
    );
    assert_eq!(
        extract_provider_text_delta(&serde_json::json!({
            "type": "partial_message",
            "content": [
                { "type": "text", "text": "hel" },
                { "type": "text", "text": "lo" }
            ]
        }))
        .as_deref(),
        Some("hello")
    );
    assert_eq!(
        extract_provider_text_delta(&serde_json::json!({
            "type": "item.completed",
            "item": {
                "type": "agent_message",
                "text": "ok"
            }
        }))
        .as_deref(),
        Some("ok")
    );
    assert_eq!(
        extract_provider_text_delta(&serde_json::json!({
            "type": "item.completed",
            "item": {
                "type": "message",
                "role": "assistant",
                "content": [
                    { "type": "output_text", "text": "array " },
                    { "type": "output_text", "text": "content" }
                ]
            }
        }))
        .as_deref(),
        Some("array content")
    );
    assert_eq!(
        extract_provider_text_delta(&serde_json::json!({
            "type": "item.completed",
            "item": {
                "type": "reasoning",
                "text": "hidden"
            }
        })),
        None
    );
}

#[test]
fn provider_stream_parsers_extract_live_activity_and_commentary() {
    let command = extract_provider_activity(&serde_json::json!({
        "type": "item.completed",
        "item": {
            "id": "item_1",
            "type": "command_execution",
            "command": "/bin/zsh -lc \"rg --files packages/ui\""
        }
    }))
    .expect("command activity");
    assert_eq!(command.id, "item_1");
    assert_eq!(command.kind, "command");
    assert_eq!(command.label, "Listed files");
    assert_eq!(command.status, "done");

    let compaction = extract_provider_activity(&serde_json::json!({
        "type": "item.completed",
        "item": {
            "id": "compact_1",
            "type": "context_compaction"
        }
    }))
    .expect("context compaction activity");
    assert_eq!(compaction.id, "compact_1");
    assert_eq!(compaction.kind, "context");
    assert_eq!(compaction.label, "Compacted context");
    assert_eq!(compaction.status, "done");

    let started_compaction = context_compaction::codex_context_compaction_activity(
        &serde_json::json!({
            "turnId": "turn_1",
            "item": { "id": "compact_1", "type": "contextCompaction" }
        }),
        "running",
    );
    let completed_compaction = context_compaction::codex_context_compaction_activity(
        &serde_json::json!({ "threadId": "thread_1", "turnId": "turn_1" }),
        "done",
    );
    assert_eq!(started_compaction.id, completed_compaction.id);
    assert_eq!(started_compaction.label, "Compacting context");
    assert_eq!(completed_compaction.label, "Compacted context");

    let reasoning = codex_reasoning_activity(&serde_json::json!({
        "id": "rs_1",
        "type": "reasoning",
        "summary": [
            { "type": "summary_text", "text": "**Inspecting the repo**\n\nFirst look." },
            "**Checking file sizes**\n\nThe largest assets are screenshots."
        ]
    }))
    .expect("reasoning activity");
    assert_eq!(reasoning.kind, "reasoning");
    assert_eq!(reasoning.label, "Checking file sizes");
    assert!(codex_reasoning_activity(&serde_json::json!({
        "id": "rs_2",
        "type": "reasoning",
        "summary": []
    }))
    .is_none());

    let commentary = extract_provider_commentary_activity(&serde_json::json!({
        "type": "item.completed",
        "item": {
            "id": "message_1",
            "type": "agent_message",
            "text": "I’ll inspect the workspace first."
        }
    }))
    .expect("commentary activity");
    assert_eq!(commentary.id, "message_1");
    assert_eq!(commentary.kind, "commentary");
    assert_eq!(commentary.label, "I’ll inspect the workspace first.");
    let titled = extract_provider_commentary_activity(&serde_json::json!({
        "type": "item.completed",
        "item": {
            "id": "message_2",
            "type": "agent_message",
            "text": "GYRO_SESSION_TITLE: Fix popover\nI’m checking the popover styles."
        }
    }))
    .expect("a stray title line keeps its narration");
    assert_eq!(titled.label, "I’m checking the popover styles.");
    assert!(extract_provider_commentary_activity(&serde_json::json!({
        "type": "item.completed",
        "item": {
            "id": "message_3",
            "type": "agent_message",
            "text": "GYRO_SESSION_TITLE: Fix popover"
        }
    }))
    .is_none());

    let retained = provider_activities_for_response(
        vec![commentary.clone(), command.clone()],
        "I’ll inspect the workspace first.",
    );
    assert_eq!(retained, vec![command]);
}

/// Claude Code tools used to land as three identical "Bash" rows. The
/// completed assistant message carries the command; reclassify it so the
/// rail can show "Ran command · pnpm test", and keep a free-form note when
/// the primary slot is only a machine tool id (Skill, MCP, …).
#[test]
fn tool_use_activities_carry_specifics_not_just_the_tool_name() {
    let bash = extract_provider_activity(&serde_json::json!({
        "type": "content_block_start",
        "content_block": {
            "type": "tool_use",
            "id": "toolu_bash",
            "name": "Bash",
            "input": { "command": "pnpm test", "description": "Run the suite" }
        }
    }))
    .expect("bash tool use");
    assert_eq!(bash.kind, "command");
    assert_eq!(bash.detail.as_deref(), Some("pnpm test"));
    assert_eq!(bash.note.as_deref(), Some("Run the suite"));
    assert_eq!(bash.label, "Ran command");

    let skill = extract_provider_activity(&serde_json::json!({
        "type": "item.completed",
        "item": {
            "id": "toolu_skill",
            "type": "tool_use",
            "name": "Skill",
            "input": { "skill": "simplify" }
        }
    }))
    .expect("skill tool use");
    assert_eq!(skill.kind, "tool");
    assert_eq!(skill.detail.as_deref(), Some("Skill"));
    assert_eq!(skill.note.as_deref(), Some("simplify"));

    let read = extract_provider_activity(&serde_json::json!({
        "event": {
            "type": "content_block_start",
            "content_block": {
                "type": "tool_use",
                "id": "toolu_read",
                "name": "Read",
                "input": { "file_path": "packages/ui/src/chat-run.ts" }
            }
        },
        "type": "stream_event"
    }))
    .expect("read tool use");
    assert_eq!(read.kind, "read");
    assert_eq!(read.detail.as_deref(), Some("packages/ui/src/chat-run.ts"));
    assert!(read.label.contains("chat-run.ts"));

    let write = extract_provider_activity(&serde_json::json!({
        "event": {
            "type": "content_block_start",
            "content_block": {
                "type": "tool_use",
                "id": "toolu_write",
                "name": "Write",
                "input": { "file_path": "packages/ui/src/chat-run.ts" }
            }
        },
        "type": "stream_event"
    }))
    .expect("write tool use");
    assert_eq!(write.kind, "file");

    // A finished assistant message may carry several tool_use blocks; each
    // becomes its own rail beat with the input filled in.
    let packed = extract_provider_activities(&serde_json::json!({
        "type": "assistant",
        "message": {
            "content": [
                { "type": "text", "text": "On it." },
                {
                    "type": "tool_use",
                    "id": "toolu_1",
                    "name": "Bash",
                    "input": { "command": "rg note packages/ui" }
                },
                {
                    "type": "tool_use",
                    "id": "toolu_2",
                    "name": "Skill",
                    "input": { "skill": "simplify" }
                }
            ]
        }
    }));
    assert_eq!(packed.len(), 2);
    assert_eq!(packed[0].kind, "command");
    assert_eq!(packed[0].detail.as_deref(), Some("rg note packages/ui"));
    assert_eq!(packed[1].kind, "tool");
    assert_eq!(packed[1].note.as_deref(), Some("simplify"));

    // Persisted session events keep the note so a reload still shows it.
    let (_label, payload, _) =
        provider_activity_event_entry(&anthropic_provider_request(), Uuid::nil(), 0, &skill);
    assert_eq!(payload["note"], "simplify");
    assert_eq!(payload["detail"], "Skill");
    assert_eq!(payload["tool"], "Skill");
}

/// Intermediate tool frames from every provider used to pile up as
/// separate "running" rows that stayed open after the turn settled.
/// Collapse by id and close open work so the durable rail matches reality.
#[test]
fn provider_activities_collapse_and_settle_open_work() {
    let activities = vec![
        ProviderActivity {
            id: "tool-1".into(),
            kind: "tool".into(),
            label: "Search codebase".into(),
            detail: Some("stop|abort".into()),
            file_counts: None,
            note: None,
            status: "running".into(),
        },
        ProviderActivity {
            id: "tool-1".into(),
            kind: "tool".into(),
            label: "Search codebase".into(),
            detail: Some("stop|abort".into()),
            file_counts: None,
            note: None,
            status: "running".into(),
        },
        ProviderActivity {
            id: "tool-2".into(),
            kind: "command".into(),
            label: "Run rg".into(),
            detail: Some("rg stop".into()),
            file_counts: None,
            note: None,
            status: "done".into(),
        },
        ProviderActivity {
            id: "tool-3".into(),
            kind: "read".into(),
            label: "Read App.tsx".into(),
            detail: Some("apps/desktop/src/App.tsx".into()),
            file_counts: None,
            note: None,
            status: "running".into(),
        },
    ];
    let retained = provider_activities_for_response(activities, "All set.");
    assert_eq!(retained.len(), 3);
    assert_eq!(retained[0].id, "tool-1");
    assert_eq!(retained[0].status, "done");
    assert_eq!(retained[1].id, "tool-2");
    assert_eq!(retained[1].status, "done");
    assert_eq!(retained[2].id, "tool-3");
    assert_eq!(retained[2].status, "done");
}

#[test]
fn streaming_state_appends_only_new_partial_snapshot_text() {
    let mut state = StreamingCommandState::new();
    state.push_assistant_snapshot("hel");
    state.push_assistant_snapshot("hello");
    state.push_assistant_snapshot("hello");

    assert_eq!(state.assistant_text, "hello");
    assert_eq!(state.take_pending_delta(), "hello");
}

#[test]
fn a_held_marker_prefix_is_not_split_by_the_same_boundary_twice() {
    // After a tool call, the reply's first token `G` is held as a possible
    // `GYRO_SESSION_TITLE:` prefix. The boundary was already handled for
    // it; the next chunk must join it, not flush it as its own block.
    let mut state = StreamingCommandState::new();
    state.push_assistant_delta("Running the checks:");
    assert!(state.take_text_boundary(true, 3));
    state.note_intervening_work();
    state.push_assistant_delta("G");
    assert!(state.session_title_hold == "G");
    assert!(!state.take_text_boundary(true, 3));
    state.push_assistant_delta("YRO_PLAN_UPDATE: {}\nDone.");
    assert_eq!(
        state.assistant_text,
        "Running the checks:\n\nGYRO_PLAN_UPDATE: {}\nDone."
    );
    assert_eq!(
        strip_hidden_control_markers(&state.assistant_text).message,
        "Running the checks:\n\nDone."
    );
    // New timeline work is a new boundary again.
    assert!(state.take_text_boundary(true, 4));
    assert!(!state.take_text_boundary(false, 5));
}

#[test]
fn streaming_state_keeps_plan_text_after_a_tool_block() {
    // The regression: the first text block after a tool call was separated
    // by the display, and every later snapshot then failed to line up with
    // the decorated buffer, freezing the message where a plan document
    // starts.
    let mut state = StreamingCommandState::new();
    state.push_assistant_delta("Let me look at the code.");
    state.note_intervening_work();
    state.push_assistant_delta("# Plan\n\nStep one");
    state.push_assistant_snapshot("# Plan\n\nStep one\n\nStep two");

    assert_eq!(
        state.assistant_text,
        "Let me look at the code.\n\n# Plan\n\nStep one\n\nStep two"
    );
}

#[test]
fn streaming_state_ignores_the_completed_message_of_an_earlier_block() {
    // The tool call opens a new block, then the provider reports the
    // message it just finished. That repeat must not be appended again.
    let mut state = StreamingCommandState::new();
    state.push_assistant_delta("Let me look at the code.");
    state.note_intervening_work();
    state.push_assistant_final("Let me look at the code.");

    assert_eq!(state.assistant_text, "Let me look at the code.");
}

#[test]
fn streaming_state_applies_the_completed_message_to_a_short_stream() {
    let mut state = StreamingCommandState::new();
    state.push_assistant_delta("The plan starts here and stops");
    state.push_assistant_final("The plan starts here and stops only when every step is listed.");

    assert_eq!(
        state.assistant_text,
        "The plan starts here and stops only when every step is listed."
    );
}

#[test]
fn streaming_state_does_not_clip_a_long_answer_at_the_stored_limit() {
    let mut state = StreamingCommandState::new();
    let body = "a".repeat(MAX_CHAT_RESPONSE_CHARS + 1_000);
    state.push_assistant_delta(&body);

    assert_eq!(state.assistant_text.chars().count(), body.chars().count());
    assert!(!state.assistant_text_truncated);
}

#[test]
fn streaming_state_splits_large_stdout_batches_without_losing_the_tail() {
    let mut state = StreamingCommandState::new();
    let batch = (0..2_048)
        .map(|index| format!("{{\"frame\":{index}}}\n"))
        .collect::<String>();

    let lines = state.take_stdout_lines(&batch);
    assert_eq!(lines.len(), 2_048);
    assert_eq!(lines.first().map(String::as_str), Some("{\"frame\":0}\n"));
    assert_eq!(lines.last().map(String::as_str), Some("{\"frame\":2047}\n"));
    assert!(state.stdout_line_buffer.is_empty());

    let lines = state.take_stdout_lines("partial");
    assert!(lines.is_empty());
    assert_eq!(
        state.take_stdout_lines(" frame\n"),
        vec!["partial frame\n".to_string()]
    );
    assert!(state.stdout_line_buffer.is_empty());

    // A large frame (a capability result) survives; an oversize one is
    // dropped whole and its tail is not mistaken for the next frame.
    let large = format!("{{\"result\":\"{}\"}}\n", "x".repeat(1024 * 1024));
    assert_eq!(state.take_stdout_lines(&large), vec![large.clone()]);
    let oversize = "y".repeat(MAX_PROVIDER_STDOUT_FRAME_BYTES + 1);
    assert!(state.take_stdout_lines(&oversize).is_empty());
    assert!(state.take_stdout_lines("tail").is_empty());
    assert_eq!(
        state.take_stdout_lines("tail\n{\"next\":1}\n"),
        vec!["{\"next\":1}\n".to_string()]
    );
}

#[test]
fn streaming_state_stops_emitting_after_response_cap() {
    let mut state = StreamingCommandState::new();
    // The live transcript is bounded separately from the stored message, so
    // the cap that stops the rail is the streaming bound, not 64k.
    state.push_assistant_delta(&"a".repeat(MAX_LIVE_RESPONSE_CHARS + 32));

    assert!(state.assistant_text_truncated);
    assert!(state.has_pending_delta());
    let capped_text = state.assistant_text.clone();
    assert_eq!(state.take_pending_delta(), capped_text);

    state.push_assistant_delta("ignored");

    assert_eq!(state.assistant_text, capped_text);
    assert!(!state.has_pending_delta());
}

#[test]
fn streaming_state_caps_retained_provider_activities() {
    let mut state = StreamingCommandState::new();
    for index in 0..(MAX_CODEX_APP_SERVER_ACTIVITIES + 8) {
        state.push_activity(ProviderActivity {
            id: format!("activity-{index}"),
            kind: "command".into(),
            label: "Ran command".into(),
            detail: None,
            file_counts: None,
            note: None,
            status: "done".into(),
        });
    }
    assert_eq!(state.activities.len(), MAX_CODEX_APP_SERVER_ACTIVITIES);
}

#[test]
fn streaming_state_places_new_commentary_after_intervening_activity() {
    let commentary = |label: &str| ProviderActivity {
        id: "commentary-1".into(),
        kind: "commentary".into(),
        label: label.into(),
        detail: None,
        file_counts: None,
        note: None,
        status: "done".into(),
    };
    let mut state = StreamingCommandState::new();

    state.push_activity(commentary("I’ll inspect first."));
    state.push_activity(ProviderActivity {
        id: "command-1".into(),
        kind: "command".into(),
        label: "Ran command".into(),
        detail: None,
        file_counts: None,
        note: None,
        status: "done".into(),
    });
    let continuation = state
        .push_activity(commentary("I’ll inspect first.Now I’ll edit it."))
        .expect("new commentary suffix");

    assert_eq!(continuation.label, "Now I’ll edit it.");
    assert_eq!(state.activities[0].label, "I’ll inspect first.");
    assert_eq!(state.activities[1].kind, "command");
    assert_eq!(state.activities[2], continuation);
    assert_eq!(state.activity_sequence(&state.activities[0]), 0);
    assert_eq!(state.activity_sequence(&state.activities[1]), 1);
    assert_eq!(state.activity_sequence(&continuation), 2);
}

#[test]
fn provider_resume_cursor_decodes_from_binding() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
    let session = store
        .create_session(temp.path(), SessionOrigin::Desktop, "chat session")
        .unwrap();
    let binding = store
        .upsert_provider_session_binding(
            session.id,
            "anthropic",
            Some("sonnet".into()),
            Some("Claude Sonnet".into()),
            None,
            serde_json::json!({
                "kind": "claude-session",
                "sessionId": "019f4612-7e58-7412-9fe9-5f0d6cb29c8e",
            }),
            "ready",
            None,
        )
        .unwrap();

    let cursor = provider_resume_cursor_from_binding(&binding).unwrap();
    assert_eq!(cursor.kind, "claude-session");
    assert_eq!(cursor.session_id, "019f4612-7e58-7412-9fe9-5f0d6cb29c8e");
}

#[test]
fn stale_resume_errors_are_retryable() {
    assert!(is_stale_resume_error("Could not resume session: not found"));
    assert!(is_stale_resume_error("missing thread for provider"));
    assert!(is_stale_resume_error("Method not found"));
    assert!(!is_stale_resume_error("rate limit exceeded"));
    // Claude Code's own wording, which reads as "found" rather than "not
    // found" and needs its own clause to classify.
    assert!(is_stale_resume_error(
        "No conversation found with session ID: 019f707c-bfec-71d1-88bb-248537d625bb"
    ));
}

#[test]
fn a_failed_transcript_is_not_read_as_a_dead_cursor() {
    // Every frame names its session, and a tool that touched a missing path
    // supplies "no such file". Matched across the whole blob these two read
    // as a stale cursor, and clearing the binding over it is what lost the
    // conversation a retry was supposed to resume.
    let transcript = concat!(
        r#"{"type":"system","subtype":"init","session_id":"019f707c-bfec-71d1-88bb-248537d625bb","tools":["Bash"]}"#,
        "\n",
        r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"cat: config.toml: No such file or directory"}]}}"#,
        "\n",
        r#"{"type":"result","subtype":"error_during_execution"}"#,
    );
    assert!(is_stale_resume_error("session not found"));
    assert!(!is_stale_resume_error(transcript));
}

#[test]
fn a_stale_cursor_still_classifies_beside_transcript_noise() {
    // The sentence arrives on stderr, after the stream has already printed
    // frames. Per-line classification has to still find it.
    let output = concat!(
        r#"{"type":"system","subtype":"init","session_id":"019f707c-bfec-71d1-88bb-248537d625bb"}"#,
        "\n",
        "No conversation found with session ID: 019f707c-bfec-71d1-88bb-248537d625bb",
    );
    assert!(is_stale_resume_error(output));
}

#[test]
fn stream_failures_report_the_cli_error_not_the_transcript() {
    let transcript = concat!(
        r#"{"type":"system","subtype":"init","session_id":"abc","tools":["Bash"]}"#,
        "\n",
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"working on it"}]}}"#,
    );
    // stderr is the CLI speaking for itself and outranks the transcript.
    assert_eq!(
        provider_stream_failure_detail(transcript, "Error: credit balance is too low"),
        "Error: credit balance is too low"
    );
    // With no stderr, an error frame in the stream is next.
    let with_error_frame = format!(
        "{transcript}\n{}",
        r#"{"type":"error","error":{"message":"model gpt-5.6-sol is not supported"}}"#
    );
    assert_eq!(
        provider_stream_failure_detail(&with_error_frame, ""),
        "model gpt-5.6-sol is not supported"
    );
    // Only when the stream says nothing about the failure does the
    // transcript stand in for it.
    assert_eq!(
        provider_stream_failure_detail(transcript, ""),
        transcript.trim()
    );
}

#[test]
fn a_streamed_answer_survives_a_nonzero_cli_exit() {
    let failed =
        |assistant: Option<&str>, parsed_json: bool, stdout: &str| StreamingCommandOutput {
            activities: Vec::new(),
            context_usage: None,
            billed_usage: None,
            accounted_usage: None,
            rate_limits: Vec::new(),
            status_success: false,
            status_label: "exit status: 1".into(),
            stdout: stdout.into(),
            stderr: "tool failed after the answer".into(),
            assistant_text: assistant.map(str::to_string),
            text_blocks: Vec::new(),
            parsed_stream_json: parsed_json,
            provider_session_id: Some("sess-1".into()),
        };

    assert_eq!(
        recover_streamed_provider_answer(
            &failed(Some("Here is the fix you asked for."), true, ""),
            "",
        ),
        Some("Here is the fix you asked for.".into()),
        "a real streamed answer must complete the turn even when the CLI exits 1",
    );

    let success = StreamingCommandOutput {
        status_success: true,
        ..failed(Some("already succeeded"), true, "")
    };
    assert_eq!(
        recover_streamed_provider_answer(&success, ""),
        None,
        "successful exits use the normal success path, not recovery",
    );

    assert_eq!(
        recover_streamed_provider_answer(
            &failed(None, true, r#"{"type":"assistant","message":"noise"}"#),
            "",
        ),
        None,
        "a JSON stream dump is not an answer the user should keep",
    );

    assert_eq!(
        recover_streamed_provider_answer(&failed(None, true, ""), "Codex last message."),
        Some("Codex last message.".into()),
    );
}

#[test]
fn every_catalog_provider_resolves_a_context_window() {
    assert_eq!(
        provider_model_context_window("anthropic", Some("claude-haiku-4-5")),
        Some(200_000)
    );
    assert_eq!(
        provider_model_context_window("openai", Some("gpt-5.4-mini")),
        Some(400_000)
    );
    assert_eq!(
        provider_model_context_window("xai", Some("grok-4.7")),
        Some(256_000)
    );
    assert_eq!(
        provider_model_context_window("xai", Some("grok-4.7-build-fast")),
        Some(256_000)
    );
    assert_eq!(
        provider_model_context_window("xai", Some("grok-4.6")),
        Some(256_000)
    );
    assert_eq!(
        provider_model_context_window("xai", Some("grok-4.5")),
        Some(256_000)
    );
    assert_eq!(
        provider_model_context_window("openai", Some("gpt-5.6-sol")),
        Some(272_000)
    );
    assert_eq!(provider_model_context_window("kimi", None), Some(262_144));
    for provider_id in ["openai", "anthropic", "kimi", "gemini", "xai"] {
        assert!(provider_model_context_window(provider_id, None).is_some());
    }
}

#[test]
fn provider_failures_have_specific_recovery_guidance() {
    assert_eq!(
        provider_failure_recovery("network is unreachable").0,
        "offline"
    );
    assert_eq!(
        provider_failure_recovery("authentication required").0,
        "authentication"
    );
    assert_eq!(
        provider_failure_recovery("rate limit exceeded").0,
        "rate-limit"
    );
    assert_eq!(provider_failure_recovery("provider crashed").0, "retry");
    let (kind, message) =
        provider_failure_recovery("xAI ended this turn because a tool permission was declined");
    assert_eq!(kind, "permission-declined");
    assert!(message.contains("declined"));
}

/// The tool-round notice is classified as its own kind, not as a failure.
///
/// It rides the *completion* status of a turn that succeeded, so the kind
/// is what the transcript keys on to explain why the tool loop ended
/// without painting the turn as broken or offering a plain resend.
#[test]
fn a_tool_budget_pause_is_not_a_failure() {
    let (kind, message) = provider_failure_recovery(PROVIDER_TOOL_BUDGET_NOTICE);
    assert_eq!(kind, "tool-budget");
    // The fix, not just the fact: the budget is a setting.
    assert!(message.contains("maxToolRounds"), "unhelpful: {message}");
    // One short clause. The rest of the news is the reply above it.
    assert!(message.len() < 90, "too long: {message}");
    // Nothing here may read as a crash: the reply above it is the model's
    // checkpoint and is saved like any other answer.
    assert!(!is_provider_cancellation(PROVIDER_TOOL_BUDGET_NOTICE));
    assert!(is_transient_provider_error(PROVIDER_TOOL_BUDGET_NOTICE) == false);
}

/// A stall is Gyro's call, not the user's: it reads as a failure with its
/// own advice, never as a stop and never as a network problem.
#[test]
fn a_stalled_run_is_reported_as_stalled_not_stopped() {
    let error = ProviderStopReason::Stalled { silent_minutes: 30 }.message();
    assert!(!is_provider_cancellation(&error));
    assert!(!is_transient_provider_error(&error));
    let (kind, message) = provider_failure_recovery(&error);
    assert_eq!(kind, "stalled");
    assert!(message.contains("Send again"), "unhelpful: {message}");
    // The sign-in hint is for runs that died on their own.
    let wrapped = provider_run_failure(anyhow::anyhow!("{error}"), "Sign in again.");
    assert!(!wrapped.to_string().contains("Sign in"));
}

/// Silence ends a run only past the limit, and never while a tool or an
/// approval is what the run is waiting on.
#[test]
fn only_unexplained_silence_counts_as_a_stall() {
    let limit = Duration::from_secs(30 * 60);
    assert!(!provider_run_stalled(
        Duration::from_secs(29 * 60),
        limit,
        false
    ));
    assert!(provider_run_stalled(limit, limit, false));
    assert!(!provider_run_stalled(
        Duration::from_secs(3 * 60 * 60),
        limit,
        true
    ));
}

/// Quiet means every frame since the last heartbeat was a heartbeat.
#[test]
fn only_heartbeats_let_a_run_go_quiet() {
    let start = Instant::now();
    let beat = PROVIDER_CHAT_HEARTBEAT_INTERVAL;
    let mut clock = ProviderQuietClock::new(start);

    assert_eq!(clock.tick(10, false, start), Duration::ZERO);
    assert_eq!(clock.tick(11, false, start + beat), beat);
    assert_eq!(clock.tick(12, false, start + beat * 2), beat * 2);

    // Anything else took a number in between, so that was progress.
    assert_eq!(clock.tick(20, false, start + beat * 3), Duration::ZERO);
    assert_eq!(clock.tick(21, false, start + beat * 4), beat);
}

/// A long tool or an unanswered approval is not the run going quiet, and the
/// wait does not count against it once the run picks back up.
#[test]
fn waiting_on_something_else_does_not_count_as_quiet() {
    let start = Instant::now();
    let beat = PROVIDER_CHAT_HEARTBEAT_INTERVAL;
    let mut clock = ProviderQuietClock::new(start);

    assert_eq!(clock.tick(1, true, start), Duration::ZERO);
    assert_eq!(clock.tick(2, true, start + beat * 30), Duration::ZERO);
    assert_eq!(clock.tick(3, false, start + beat * 31), beat);
}

/// The note only appears once the quiet is long enough to mean something.
#[test]
fn a_short_quiet_is_not_reported() {
    let notice = PROVIDER_CHAT_QUIET_NOTICE;
    assert_eq!(provider_quiet_seconds(Duration::ZERO), None);
    assert_eq!(
        provider_quiet_seconds(notice - Duration::from_secs(1)),
        None
    );
    assert_eq!(provider_quiet_seconds(notice), Some(notice.as_secs()));
}

/// Frames from before this field keep their shape on the wire.
#[test]
fn a_frame_only_carries_quiet_seconds_when_quiet() {
    let frame = |quiet_seconds| ProviderChatStreamEvent {
        session_id: "session".into(),
        turn_id: None,
        provider_id: "provider".into(),
        model_id: None,
        event_id: "event".into(),
        sequence: 1,
        timeline: provider_timeline::TimelinePosition {
            timeline_order: 1,
            timeline_created_at: "2026-11-02T00:00:00Z".into(),
        },
        timeline_segments: None,
        activity_sequence: None,
        phase: "heartbeat".into(),
        status: None,
        text_delta: None,
        activity_id: None,
        activity_kind: None,
        activity_label: None,
        activity_detail: None,
        activity_note: None,
        additions: None,
        deletions: None,
        activity_status: None,
        message: None,
        error: None,
        recovery_kind: None,
        quiet_seconds,
    };
    let idle = serde_json::to_value(frame(None)).expect("serializes");
    assert!(idle.get("quietSeconds").is_none());
    let quiet = serde_json::to_value(frame(Some(360))).expect("serializes");
    assert_eq!(quiet["quietSeconds"], 360);
}

/// A tool counts as running by its latest state, not its first.
#[test]
fn a_finished_tool_is_not_counted_as_running() {
    let activity = |id: &str, status: &str| ProviderActivity {
        id: id.into(),
        kind: "command".into(),
        label: "Run".into(),
        detail: None,
        note: None,
        file_counts: None,
        status: status.into(),
    };
    let mut state = StreamingCommandState::new();
    assert!(!state.has_running_tool());
    state.activities.push(activity("a", "running"));
    assert!(state.has_running_tool());
    state.activities.push(activity("a", "done"));
    assert!(!state.has_running_tool());
    state.activities.push(activity("b", "queued"));
    assert!(state.has_running_tool());
}

/// An answer kept after a non-zero exit completes the turn, flagged as
/// possibly cut off rather than as a failure.
#[test]
fn a_possibly_cut_off_answer_is_not_a_failure() {
    let (kind, message) = provider_failure_recovery(PROVIDER_CUT_OFF_NOTICE);
    assert_eq!(kind, "partial-answer");
    assert!(message.contains("Continue"), "unhelpful: {message}");
    assert!(!is_provider_cancellation(PROVIDER_CUT_OFF_NOTICE));
    assert!(!is_transient_provider_error(PROVIDER_CUT_OFF_NOTICE));
}

/// A stop is not a failure, and the two stops do not have the same fix.
///
/// The ceiling stop is the one that matters: it used to arrive as a bare
/// "was cancelled" advising a retry, which ran into the same ceiling and
/// stopped in the same place. It has to name the ceiling instead.
#[test]
fn a_stopped_turn_is_told_apart_from_a_failed_one() {
    let (kind, message) = provider_failure_recovery(&ProviderStopReason::User.message());
    assert_eq!(kind, "stopped");
    assert!(message.contains("Send again"), "unhelpful: {message}");

    let ceiling = ProviderStopReason::CallTokenCeiling {
        spent: 2_400_000,
        ceiling: 2_000_000,
    };
    let (kind, message) = provider_failure_recovery(&ceiling.message());
    assert_eq!(kind, "spend-ceiling");
    assert!(message.contains("maxTokensPerCall"), "unhelpful: {message}");
    // The figures belong in the error itself, so the chat can say how far
    // past the ceiling the turn got rather than only that it passed one.
    assert!(ceiling.message().contains("2400000"));
    assert!(ceiling.message().contains("2000000"));

    for stop in [ProviderStopReason::User, ceiling] {
        assert!(is_provider_cancellation(&stop.message()));
        // The sign-in hint every runner wraps a dead run in is wrong here:
        // nothing about a stop is fixed by signing in again.
        let wrapped = provider_run_failure(
            anyhow::anyhow!("{}", stop.message()),
            "Could not complete Anthropic through Claude Code.",
        );
        assert_eq!(wrapped.to_string(), stop.message());
    }

    // A run that died on its own still gets the hint.
    let failed = provider_run_failure(anyhow::anyhow!("exit status: 1"), "Sign in again.");
    assert_eq!(failed.to_string(), "Sign in again. exit status: 1");
    assert!(!is_provider_cancellation(&failed.to_string()));
}

#[test]
fn expired_sign_ins_are_recovered_by_signing_in_again() {
    // Both lines are what `claude` actually emits on a dead login: the
    // retry notice arrives mid-stream as JSON, the plain sentence at the
    // end. Neither can be fixed by retrying, so they must not classify as
    // `retry`, and they must stay distinct from `authentication` so the
    // surface offers sign-in rather than a health re-check.
    for error in [
            r#"{"type":"system","subtype":"api_retry","attempt":1,"error_status":401,"error":"authentication_failed"}"#,
            "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.",
            CLAUDE_LOGIN_EXPIRED_DETAIL,
        ] {
            let (kind, message) = provider_failure_recovery(error);
            assert_eq!(kind, "login-expired", "misclassified: {error}");
            assert!(message.contains("Sign in again"), "unhelpful: {message}");
        }

    // A login that was never established is a different problem with a
    // different fix, so it keeps the generic authentication kind.
    assert_eq!(
        provider_failure_recovery("not logged in").0,
        "authentication"
    );
}

#[test]
fn a_rejected_sign_in_replaces_the_raw_stream_dump() {
    // The 401 sits far inside an otherwise healthy-looking stream, which is
    // why the stored failure used to be thousands of characters of session
    // setup with the cause buried in the middle.
    let stream = format!(
        "{}\n{}\n{}",
        r#"{"type":"system","subtype":"init","tools":["Bash","Read","Write"],"model":"claude-opus-5"}"#,
        r#"{"type":"system","subtype":"status","status":"requesting"}"#,
        r#"{"type":"system","subtype":"api_retry","attempt":2,"error_status":401,"error":"authentication_failed"}"#,
    );
    assert_eq!(
        claude_login_failure(&stream),
        Some(CLAUDE_LOGIN_EXPIRED_DETAIL)
    );

    // A healthy stream and an unrelated failure must not be reported as a
    // sign-in problem, or Gyro sends people to log in over a real bug.
    assert_eq!(
        claude_login_failure(r#"{"type":"system","subtype":"init","model":"claude-opus-5"}"#),
        None
    );
    assert_eq!(claude_login_failure("error: connection refused"), None);
}

#[test]
fn a_failed_turn_streams_the_recovery_kind_it_stores() {
    // Provider health is corrected from the live stream, so the classified
    // kind has to travel with the failure. Sending only the raw error would
    // leave the surfaces re-deriving it, and Settings kept claiming a
    // verified sign-in exactly because nothing told it otherwise.
    let recovery_kind = |error: &str| provider_failure_recovery(error).0;
    assert_eq!(recovery_kind(CLAUDE_LOGIN_EXPIRED_DETAIL), "login-expired");
    assert_eq!(recovery_kind("network is unreachable"), "offline");

    // Only failures carry an error, so a healthy phase stays unclassified
    // and cannot demote a working provider.
    let no_error: Option<&str> = None;
    assert_eq!(no_error.map(recovery_kind), None);
}

#[test]
fn cli_argument_failures_are_not_reported_as_retryable() {
    // Both messages came from `claude` rejecting a command Gyro built.
    // Telling someone to retry these sends them into a loop that cannot
    // succeed, so they must classify as a version mismatch instead.
    for error in [
            "Error: Input must be provided either through stdin or as a prompt argument when using --print",
            "Error: When using --print, --output-format=stream-json requires --verbose",
        ] {
            let (kind, message) = provider_failure_recovery(error);
            assert_eq!(kind, "cli-contract", "misclassified: {error}");
            assert!(message.contains("version changed"));
        }

    // The audit's own message must classify the same way, so a vector Gyro
    // rejects before spawning reads identically to one the CLI rejects.
    let violation = gyro_core::ArgContractViolation::UnterminatedPrompt.message("anthropic");
    assert_eq!(provider_failure_recovery(&violation).0, "cli-contract");
}

#[test]
fn stale_resume_binding_is_cleared_and_retried_without_cursor() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
    let session = store
        .create_session(temp.path(), SessionOrigin::Desktop, "resume recovery")
        .unwrap();
    let binding = store
        .upsert_provider_session_binding(
            session.id,
            "openai",
            Some("gpt-5.5".into()),
            Some("GPT-5.5".into()),
            None,
            serde_json::json!({
                "kind": "codex-session",
                "sessionId": "stale-provider-session",
            }),
            "ready",
            None,
        )
        .unwrap();
    let request = ProviderChatRequest {
        session_id: session.id.to_string(),
        message: "continue".into(),
        turn_id: Some(Uuid::new_v4().to_string()),
        provider_id: "openai".into(),
        provider_label: Some("OpenAI".into()),
        model_id: Some("gpt-5.5".into()),
        model_label: Some("GPT-5.5".into()),
        reasoning_effort: None,
        require_command_approval: true,
        require_file_edit_approval: true,
        full_access: false,
        suggest_title: false,
        workspace_path: Some(temp.path().display().to_string()),
        mode: ChatMode::Normal,
        goal: None,
        plan: None,
        attachments: Vec::new(),
        workspace_context: None,
        workspace_check: None,
        side_chat_context: None,
        workflow_run_id: None,
        project_memory: None,
        internal_purpose: None,
    };
    let mut attempts = Vec::new();
    let output = run_provider_chat_with_retry_using(
        &store,
        &request,
        Some(binding),
        |resume_cursor, _attempt| {
            attempts.push(resume_cursor.map(|cursor| cursor.session_id.clone()));
            if resume_cursor.is_some() {
                anyhow::bail!("Could not resume session: not found");
            }
            Ok(ProviderRunnerOutput {
                accounted_usage: None,
                activities: Vec::new(),
                context_usage: None,
                billed_usage: None,
                rate_limits: Vec::new(),
                paused_at_tool_budget: false,
                answer_cut_off: false,
                response: "Recovered".into(),
                resume_cursor: None,
                retry_count: 0,
                resumed: false,
                streamed_text: None,
                output_summary: None,
            })
        },
        || None,
    )
    .unwrap();

    // First attempt used the dead cursor; the automatic recovery attempt
    // starts clean so local history can carry the thread.
    assert_eq!(attempts, vec![Some("stale-provider-session".into()), None]);
    assert_eq!(output.response, "Recovered");
    assert!(!output.resumed);
    assert_eq!(output.retry_count, 1);
    assert!(store
        .get_provider_session_binding(session.id, "openai")
        .unwrap()
        .is_none());
}

#[test]
fn model_handoff_skips_incompatible_provider_binding() {
    let binding = ProviderSessionBinding {
        session_id: Uuid::new_v4(),
        provider_id: "xai".into(),
        model_id: Some("grok-4".into()),
        model_label: Some("Grok 4".into()),
        reasoning_effort: None,
        resume_cursor_json: serde_json::json!({
            "kind": "xai-acp-session",
            "sessionId": "old-model-session",
        }),
        status: "ready".into(),
        last_error: None,
        updated_at: chrono::Utc::now(),
    };
    let request = ProviderChatRequest {
        session_id: binding.session_id.to_string(),
        message: "continue with the new model".into(),
        turn_id: Some(Uuid::new_v4().to_string()),
        provider_id: "xai".into(),
        provider_label: Some("xAI".into()),
        model_id: Some("grok-4.5".into()),
        model_label: Some("Grok 4.5".into()),
        reasoning_effort: None,
        require_command_approval: true,
        require_file_edit_approval: true,
        full_access: false,
        suggest_title: false,
        workspace_path: None,
        mode: ChatMode::Normal,
        goal: None,
        plan: None,
        attachments: Vec::new(),
        workspace_context: None,
        workspace_check: None,
        side_chat_context: None,
        workflow_run_id: None,
        project_memory: None,
        internal_purpose: None,
    };
    assert!(compatible_provider_session_binding(binding.clone(), &request).is_none());
    let same_model = ProviderChatRequest {
        model_id: Some("grok-4".into()),
        model_label: Some("Grok 4".into()),
        ..request
    };
    assert!(compatible_provider_session_binding(binding, &same_model).is_some());
}

/// A session's first turn is the case `provider_failure_recovery` used to
/// lie about: with no earlier binding to fall back on, a stopped turn threw
/// away the provider session it had just created, and "Gyro will preserve
/// the conversation context" meant replaying from nothing.
#[test]
fn stopped_first_turn_persists_its_provider_cursor_for_the_retry() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
    let session = store
        .create_session(temp.path(), SessionOrigin::Desktop, "first turn stop")
        .unwrap();
    let request = provider_chat_request_for(&session, temp.path(), "anthropic");

    // The turn is stopped after Claude Code acknowledged the session, so
    // the run knows a resumable conversation exists.
    let stop = run_provider_chat_with_retry_using(
        &store,
        &request,
        None,
        |_, attempt| {
            attempt.resume_cursor = Some(ProviderResumeCursor {
                kind: "claude-session".into(),
                session_id: "claude-first-turn".into(),
            });
            anyhow::bail!("{}", ProviderStopReason::User.message())
        },
        || None,
    )
    .unwrap_err();
    assert!(is_provider_cancellation(&stop.to_string()));

    let binding = store
        .get_provider_session_binding(session.id, "anthropic")
        .unwrap()
        .expect("a stopped first turn must leave a resumable binding");
    assert_eq!(binding.status, "failed");
    assert_eq!(
        provider_resume_cursor_from_binding(&binding)
            .map(|cursor| cursor.session_id)
            .as_deref(),
        Some("claude-first-turn")
    );

    // The retry now resumes that conversation instead of starting a new one.
    let mut resumed_from = None;
    run_provider_chat_with_retry_using(
        &store,
        &request,
        Some(binding),
        |resume_cursor, _attempt| {
            resumed_from = resume_cursor.map(|cursor| cursor.session_id.clone());
            Ok(ProviderRunnerOutput {
                accounted_usage: None,
                activities: Vec::new(),
                context_usage: None,
                billed_usage: None,
                rate_limits: Vec::new(),
                paused_at_tool_budget: false,
                answer_cut_off: false,
                response: "Continued".into(),
                resume_cursor: None,
                retry_count: 0,
                resumed: false,
                streamed_text: None,
                output_summary: None,
            })
        },
        || None,
    )
    .unwrap();
    assert_eq!(resumed_from.as_deref(), Some("claude-first-turn"));
}

/// The guard on the fix. Claude Code writes its session file before it
/// announces the session id, so a run killed before that announcement has
/// no conversation on disk. Binding one anyway would turn a retry that
/// works today into `--resume` failing on a session that never existed.
#[test]
fn a_run_that_never_reached_the_provider_leaves_no_binding() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
    let session = store
        .create_session(temp.path(), SessionOrigin::Desktop, "early stop")
        .unwrap();
    let request = provider_chat_request_for(&session, temp.path(), "anthropic");

    run_provider_chat_with_retry_using(
        &store,
        &request,
        None,
        |_, _attempt| anyhow::bail!("{}", ProviderStopReason::User.message()),
        || None,
    )
    .unwrap_err();

    assert!(store
        .get_provider_session_binding(session.id, "anthropic")
        .unwrap()
        .is_none());

    // And if a cursor ever does point at a conversation the CLI never
    // wrote, Claude Code's own wording has to read as a stale cursor so the
    // retry clears it instead of failing the same way forever.
    assert!(is_stale_resume_error(
        "No conversation found with session ID: 350b1bb9-d560-4f27-b851-37554f139fcc"
    ));
}

#[test]
fn strips_control_markers_glued_mid_line_after_tool_preambles() {
    // Reproduces the live transcript where successive Claude text blocks
    // glued together and left GYRO_SESSION_TITLE visible in the bubble.
    let raw = "Now the edits.Now the desktop handler:Now add the dependency to the composer-action callback:GYRO_SESSION_TITLE: Create branch from picker\n\nAdded a **New branch…** entry at the top of the branch picker.";
    let extracted = extract_session_title_marker(raw, true);
    assert_eq!(
        extracted.title.as_deref(),
        Some("Create branch from picker")
    );
    assert!(!extracted.message.contains("GYRO_SESSION_TITLE"));
    assert!(extracted.message.contains("Added a **New branch…** entry"));
    // Glued sentence boundaries are repaired so preambles stay readable.
    assert!(extracted.message.contains("edits.\n\nNow the desktop"));
}

#[test]
fn repairs_glued_blocks_when_the_next_block_is_markdown_bold() {
    let repaired = repair_glued_assistant_blocks(
        "matches what Gyro actually is.**Gyro is a local-first workspace.**",
    );
    assert!(repaired.contains("is.\n\n**Gyro is a local-first"));
    assert!(!repaired.contains("is.**Gyro"));
}

#[test]
fn strips_artifact_markers_glued_mid_line() {
    let raw = "Good question — let me verify rather than assume.GYRO_ARTIFACTS: {\"items\":[{\"id\":\"rebuild-desktop\",\"kind\":\"command\",\"title\":\"Rebuild to see the fixed meter\",\"command\":\"pnpm desktop:install-local\"}]}\n\nYes for Claude — the meter is fixed.";
    let extracted = extract_chat_artifact_marker(raw);
    assert_eq!(extracted.items.len(), 1);
    assert_eq!(extracted.items[0]["id"], "rebuild-desktop");
    assert!(!extracted.message.contains("GYRO_ARTIFACTS"));
    assert!(extracted.message.starts_with("Good question"));
    assert!(extracted.message.contains("Yes for Claude"));
}

#[test]
fn strips_question_markers_into_structured_payload() {
    let raw = "A few decisions first.\nGYRO_QUESTIONS: {\"questions\":[{\"question\":\"Which release?\",\"options\":[{\"label\":\"Stable\",\"recommended\":true},{\"label\":\"Alpha\"}]}]}";
    let stripped = strip_hidden_control_markers(raw);
    assert_eq!(stripped.message, "A few decisions first.");
    let questions = stripped.questions.expect("questions payload");
    assert_eq!(questions["questions"][0]["question"], "Which release?");
    assert_eq!(questions["questions"][0]["options"][0]["recommended"], true);
    let broken = strip_hidden_control_markers("Ask.\nGYRO_QUESTIONS: {not json");
    assert_eq!(broken.message, "Ask.");
    assert!(broken.questions.is_none());
}

#[test]
fn streaming_state_separates_text_blocks_after_tool_activity() {
    let mut state = StreamingCommandState::new();
    state.push_assistant_delta("Now the edits.");
    state.note_intervening_work();
    state.push_assistant_delta("Now the desktop handler:");
    state.note_intervening_work();
    state.push_assistant_delta(
        "GYRO_SESSION_TITLE: Create branch from picker\n\nAdded a branch action.",
    );

    assert_eq!(
        state.captured_session_title.as_deref(),
        Some("Create branch from picker")
    );
    assert_eq!(
        state.assistant_text,
        "Now the edits.\n\nNow the desktop handler:\n\nAdded a branch action."
    );
    assert!(!state.assistant_text.contains("GYRO_SESSION_TITLE"));
    assert!(!state.take_pending_delta().contains("GYRO_SESSION_TITLE"));
}

#[test]
fn derives_a_bounded_plain_text_summary_from_the_real_response() {
    let summary = derive_session_summary(
        "## Result\n\nInspected `src/main.rs` and fixed the startup path.\n\n- Tests pass.",
    )
    .unwrap();
    assert_eq!(
        summary,
        "Result Inspected src/main.rs and fixed the startup path. Tests pass."
    );
    assert!(derive_session_summary(" \n\n").is_none());
    assert!(
        derive_session_summary(&"word ".repeat(200))
            .unwrap()
            .chars()
            .count()
            <= 423
    );
}

#[test]
fn extracts_structured_plan_update_marker() {
    let extracted = extract_plan_update_marker(
            "GYRO_PLAN_UPDATE: {\"action\":\"replace\",\"items\":[{\"id\":\"one\",\"title\":\"Inspect\",\"status\":\"todo\"}]}\n\nHere is the plan.",
        );
    assert_eq!(extracted.payload.as_ref().unwrap()["action"], "replace");
    assert_eq!(extracted.message, "Here is the plan.");
}

#[test]
fn plan_updates_keep_later_completion_and_blocked_reports() {
    let first = serde_json::json!({"action":"update-items","items":[
        {"id":"verify","status":"in-progress"},
        {"id":"acceptance","status":"todo"}
    ]});
    let final_update = serde_json::json!({"action":"update-items","items":[
        {"id":"verify","status":"complete"},
        {"id":"acceptance","status":"blocked","detail":"Requires native packaged-app acceptance"}
    ]});
    for separator in ["\n", ""] {
        let response = format!(
                "GYRO_PLAN_UPDATE: {first}{separator}GYRO_PLAN_UPDATE: {final_update}\nVerified the build. Native acceptance remains."
            );
        let extracted = strip_hidden_control_markers(&response);
        assert_eq!(
            extracted.plan_updates,
            vec![first.clone(), final_update.clone()]
        );
        assert_eq!(
            extracted.message,
            "Verified the build. Native acceptance remains."
        );
    }
}

#[test]
fn plan_updates_retain_commentary_and_ignore_tool_output() {
    let update = |id: &str, status: &str| {
        serde_json::json!({
            "action":"update-items","items":[{"id":id,"status":status}]
        })
    };
    let activity = |kind: &str, payload: serde_json::Value| ProviderActivity {
        id: kind.into(),
        kind: kind.into(),
        label: format!("GYRO_PLAN_UPDATE: {payload}"),
        detail: None,
        note: None,
        file_counts: None,
        status: "done".into(),
    };
    let first = update("implement", "complete");
    let working = update("verify", "in-progress");
    let final_update = update("verify", "complete");
    assert_eq!(
        completed_plan_updates(
            &[
                activity("commentary", first.clone()),
                activity("tool", update("acceptance", "complete")),
                activity("commentary", working.clone()),
            ],
            vec![final_update.clone()],
        ),
        vec![first, working, final_update],
    );
    assert!(completed_plan_updates(&[], vec![]).is_empty());
}

#[test]
fn extracts_bounded_chat_artifacts_and_hides_the_marker() {
    let response = "GYRO_ARTIFACTS: {\"items\":[{\"id\":\"choice\",\"kind\":\"decision\",\"title\":\"Choose\",\"options\":[{\"id\":\"a\",\"label\":\"A\"}]}]}\n\nPick the best option.";
    let extracted = extract_chat_artifact_marker(response);
    assert_eq!(extracted.items.len(), 1);
    assert_eq!(extracted.items[0]["kind"], "decision");
    assert_eq!(extracted.message, "Pick the best option.");
}

#[test]
fn retains_intermediate_artifacts_until_the_final_reply() {
    let preview = |id: &str, title: &str| {
        serde_json::json!({
            "id": id, "kind": "preview", "title": title,
            "url": "http://127.0.0.1:1420"
        })
    };
    let activity = |kind: &str, items: Vec<serde_json::Value>| ProviderActivity {
        id: "artifact-note".into(),
        kind: kind.into(),
        label: format!("GYRO_ARTIFACTS: {}", serde_json::json!({"items": items})),
        detail: None,
        note: None,
        file_counts: None,
        status: "done".into(),
    };
    let final_reply = extract_chat_artifact_marker("Verified the fix. Tests pass.");
    assert_eq!(final_reply.message, "Verified the fix. Tests pass.");
    let artifacts = completed_chat_artifacts(
        &[
            activity("commentary", vec![preview("preview", "First version")]),
            activity("commentary", vec![preview("preview", "Revised version")]),
            activity("tool", vec![preview("untrusted", "Tool output")]),
        ],
        vec![
            preview("preview", "Final version"),
            preview("report", "Result"),
        ],
    );
    assert_eq!(artifacts.len(), 2);
    assert_eq!(artifacts[0]["title"], "Final version");
    assert_eq!(artifacts[1]["id"], "report");
    let many = (0..20)
        .map(|index| {
            activity(
                "commentary",
                vec![preview(&format!("preview-{index}"), "Preview")],
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        completed_chat_artifacts(&many, Vec::new()).len(),
        MAX_CHAT_ARTIFACTS
    );
}

#[test]
fn rejects_unknown_or_incomplete_chat_artifacts() {
    let extracted = extract_chat_artifact_marker(
            "GYRO_ARTIFACTS: {\"items\":[{\"id\":\"bad\",\"kind\":\"html\",\"title\":\"Unsafe\"},{\"id\":\"empty\",\"kind\":\"decision\",\"title\":\"Empty\",\"options\":[]}]}\nVisible response.",
        );
    assert!(extracted.items.is_empty());
    assert_eq!(extracted.message, "Visible response.");
}

#[test]
fn chat_artifact_canvas_preserves_content_and_rejects_invalid_formats() {
    let artifact = serde_json::json!({"id":"draft", "kind":"canvas", "title":"Draft", "format":"code", "content":"  const n = 1;\n"});
    assert!(valid_chat_artifact(&artifact));
    let response = format!("GYRO_ARTIFACTS: {{\"items\":[{artifact}]}}\nReady.");
    let extracted = extract_chat_artifact_marker(&response);
    assert_eq!(extracted.items[0]["content"], "  const n = 1;\n");
    assert_eq!(extracted.message.trim(), "Ready.");
    let mut html = artifact.clone();
    html["format"] = serde_json::json!("html");
    assert!(valid_chat_artifact(&html));
    for format in ["javascript", ""] {
        let mut invalid = artifact.clone();
        invalid["format"] = serde_json::json!(format);
        assert!(!valid_chat_artifact(&invalid));
    }
    for content in [" ".to_string(), "x".repeat(12_001)] {
        let mut invalid = artifact.clone();
        invalid["content"] = serde_json::json!(content);
        assert!(!valid_chat_artifact(&invalid));
    }
}

#[test]
fn provider_text_delta_sanitization_preserves_stream_spacing() {
    assert_eq!(sanitize_provider_text_delta(" hello "), " hello ");
    assert_eq!(sanitize_provider_chat_response(" hello "), "hello");
}

#[test]
fn provider_status_event_stores_run_metadata_without_tokens() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
    let session = store
        .create_session(temp.path(), SessionOrigin::Desktop, "chat session")
        .unwrap();
    let turn_id = Uuid::new_v4();
    let request = ProviderChatRequest {
        session_id: session.id.to_string(),
        message: "hello".into(),
        turn_id: Some(turn_id.to_string()),
        provider_id: "openai".into(),
        provider_label: Some("OpenAI".into()),
        model_id: Some("gpt-5.5".into()),
        model_label: Some("GPT-5.5".into()),
        reasoning_effort: Some("high".into()),
        require_command_approval: true,
        require_file_edit_approval: true,
        full_access: false,
        suggest_title: false,
        workspace_path: Some(temp.path().display().to_string()),
        mode: ChatMode::Normal,
        goal: None,
        plan: None,
        attachments: Vec::new(),
        workspace_context: None,
        workspace_check: None,
        side_chat_context: None,
        workflow_run_id: None,
        project_memory: None,
        internal_purpose: None,
    };

    let event = append_provider_status_event(
        &store,
        session.id,
        &request,
        Some(turn_id),
        Uuid::new_v4(),
        HarnessRunStatus::Done,
        None,
    )
    .unwrap();

    assert_eq!(event.kind, SessionEventKind::SystemEvent);
    assert_eq!(event.turn_id, Some(turn_id));
    assert_eq!(event.payload["kind"], "provider-status");
    assert_eq!(event.payload["schema"], gyro_core::HARNESS_SCHEMA_V1);
    assert_eq!(event.payload["runId"], turn_id.to_string());
    assert_eq!(event.payload["status"], "done");
    assert_eq!(event.payload["reasoningEffort"], "high");
    assert_eq!(event.payload["runner"], "codex-cli");
    assert_eq!(event.payload["authOwner"], "chatgpt-local-codex-login");
    assert!(event.payload.get("token").is_none());
    assert!(event.payload.get("userMessage").is_none());
    assert_eq!(event.payload["messagePreview"], "hello");
}

#[test]
fn chat_message_validation_bounds_input() {
    assert_eq!(
        validate_chat_message("  hello\0 ").unwrap(),
        "hello".to_string()
    );
    assert!(validate_chat_message(" ").is_err());
    assert!(validate_chat_message(&"a".repeat(MAX_CHAT_MESSAGE_CHARS + 1)).is_err());
}

#[test]
fn native_provider_binding_owns_execution_authority() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
    let session = store
        .create_session_with_context(
            temp.path(),
            SessionOrigin::Desktop,
            "bound provider",
            CreateSessionContext {
                provider_id: Some("openai".into()),
                provider_label: Some("OpenAI".into()),
                model_id: Some("gpt-5.6-sol".into()),
                model_label: Some("GPT-5.6 Sol".into()),
                reasoning_effort: Some("high".into()),
                ..CreateSessionContext::default()
            },
        )
        .unwrap();
    let mut config = GyroConfig {
        require_command_approval: true,
        require_file_edit_approval: true,
        full_access: true,
        ..GyroConfig::default()
    };
    config
        .model_providers
        .iter_mut()
        .find(|provider| provider.id == "openai")
        .unwrap()
        .enabled = true;
    let mut request = ProviderChatRequest {
        session_id: session.id.to_string(),
        message: "inspect it".into(),
        turn_id: Some(Uuid::new_v4().to_string()),
        provider_id: "openai".into(),
        provider_label: Some("forged label".into()),
        model_id: Some("gpt-5.6-sol".into()),
        model_label: Some("forged model".into()),
        reasoning_effort: Some("high".into()),
        require_command_approval: false,
        require_file_edit_approval: false,
        full_access: true,
        suggest_title: false,
        workspace_path: None,
        mode: ChatMode::Normal,
        goal: None,
        plan: None,
        attachments: Vec::new(),
        workspace_context: None,
        workspace_check: None,
        side_chat_context: None,
        workflow_run_id: None,
        project_memory: None,
        internal_purpose: None,
    };

    bind_provider_chat_request(&mut request, &session, &config, store.paths()).unwrap();

    assert!(request.require_command_approval);
    assert!(request.require_file_edit_approval);
    assert!(!request.full_access);
    assert_eq!(request.provider_label.as_deref(), Some("OpenAI"));
    assert_eq!(request.model_label.as_deref(), Some("GPT-5.6 Sol"));
    assert_eq!(
        PathBuf::from(request.workspace_path.as_deref().unwrap()),
        temp.path().canonicalize().unwrap()
    );

    // A projectless session keeps its public workspace empty, but tools
    // execute inside a private, stable directory owned by that chat.
    let mut projectless = session.clone();
    projectless.workspace_path = PathBuf::new();
    request.workspace_path = None;
    bind_provider_chat_request(&mut request, &projectless, &config, store.paths()).unwrap();
    let scratch = PathBuf::from(request.workspace_path.as_ref().unwrap());
    assert!(scratch.is_dir());
    assert_eq!(
        scratch,
        store.paths().ensure_chat_workspace(session.id).unwrap()
    );
    assert!(projectless.workspace_path.as_os_str().is_empty());

    request.provider_id = "anthropic".into();
    assert!(
        bind_provider_chat_request(&mut request, &session, &config, store.paths())
            .unwrap_err()
            .contains("provider selection changed")
    );
}

#[test]
fn protocol_line_reader_rejects_oversized_unterminated_frames() {
    let mut oversized = BufReader::new(std::io::Cursor::new(vec![b'x'; 33]));
    assert!(read_bounded_protocol_line(&mut oversized, 32)
        .unwrap_err()
        .contains("size limit"));

    let mut framed = BufReader::new(std::io::Cursor::new(b"{\"ok\":true}\r\nnext\n"));
    assert_eq!(
        read_bounded_protocol_line(&mut framed, 32).unwrap(),
        Some(br#"{"ok":true}"#.to_vec())
    );
    assert_eq!(
        read_bounded_protocol_line(&mut framed, 32).unwrap(),
        Some(b"next".to_vec())
    );

    let mut unterminated = BufReader::new(std::io::Cursor::new(b"{\"ok\":true}"));
    assert!(read_bounded_protocol_line(&mut unterminated, 32)
        .unwrap_err()
        .contains("newline terminator"));
}

#[test]
fn provider_chat_response_is_redacted_and_bounded() {
    let response = format!(
        "token=sk-abcdefghijklmnopqrstuvwxyz123456 {}",
        "a".repeat(MAX_CHAT_RESPONSE_CHARS + 32)
    );
    let sanitized = sanitize_provider_chat_response(&response);

    assert!(sanitized.contains("[REDACTED]"));
    assert!(!sanitized.contains("abcdefghijklmnopqrstuvwxyz"));
    assert!(sanitized.chars().count() <= MAX_CHAT_RESPONSE_CHARS + 3);
}

#[test]
fn truncate_chars_keeps_multibyte_boundaries() {
    assert_eq!(truncate_chars("ééé", 2), "éé...");

    let mut streamed = String::new();
    let mut streamed_chars = 0;
    assert_eq!(
        push_bounded(&mut streamed, &mut streamed_chars, "é", 2),
        BoundedPushResult {
            accepted_chars: 1,
            truncated: false,
        }
    );
    assert_eq!(
        push_bounded(&mut streamed, &mut streamed_chars, "é", 2),
        BoundedPushResult {
            accepted_chars: 1,
            truncated: false,
        }
    );
    assert_eq!(
        push_bounded(&mut streamed, &mut streamed_chars, "é", 2),
        BoundedPushResult {
            accepted_chars: 0,
            truncated: true,
        }
    );

    assert_eq!(streamed, "éé...");
    assert_eq!(streamed_chars, 2);
}

#[test]
fn provider_health_redacts_secret_output() {
    let redacted = gyro_core::security::redact_secrets(
        "authorization: bearer sk-abcdefghijklmnopqrstuvwxyz123456",
    );

    assert!(redacted.contains("[REDACTED]"));
    assert!(!redacted.contains("abcdefghijklmnopqrstuvwxyz"));
}

#[test]
fn provider_health_parses_runtime_metadata_without_tokens() {
    let output = r#"{"loggedIn":true,"email":"dev@example.test","subscriptionType":"max","token":"sk-abcdefghijklmnopqrstuvwxyz123456"}"#;
    let redacted = gyro_core::security::redact_secrets(output);

    assert_eq!(provider_runtime_status_from_output(&redacted), "ready");
    assert_eq!(
        provider_subscription_label(&redacted).as_deref(),
        Some("max")
    );
    assert_eq!(
        provider_account_label(&redacted).as_deref(),
        Some("dev@example.test")
    );
    assert!(!redacted.contains("abcdefghijklmnopqrstuvwxyz"));
}

#[test]
fn governance_args_are_kept_out_of_the_displayed_command() {
    // The bridge config is a large JSON blob; surfacing it as the pane's
    // command would make the CLI surface unreadable.
    let manager = TerminalProcessManager::default();
    manager
        .create(TerminalPaneRequest {
            pane_id: "pane-governed-display".into(),
            title: "Claude".into(),
            profile_id: Some("claude".into()),
            command: "sh".into(),
            args: vec!["-c".into(), "true".into()],
            governance: Some(PaneGovernance {
                session_id: "session".into(),
                provider_id: "anthropic".into(),
                env: Vec::new(),
                args: vec!["--mcp-config".into(), "{\"huge\":true}".into()],
            }),
            ..Default::default()
        })
        .unwrap();

    let snapshot = manager.read("pane-governed-display", None).unwrap();

    assert_eq!(snapshot.command, "sh -c true");
    assert_eq!(snapshot.governed_session_id.as_deref(), Some("session"));
    assert_eq!(snapshot.governed_provider_id.as_deref(), Some("anthropic"));
}

#[test]
fn scheduler_iteration_finishes_one_claimed_run_without_duplicates() {
    let temp = tempfile::tempdir().unwrap();
    let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
    let store = AutomationStore::open(paths.clone()).unwrap();
    let automation = store
        .create_automation(CreateAutomationRequest {
            title: "Scheduled smoke".into(),
            prompt: "Run checks".into(),
            schedule: gyro_core::AutomationSchedule::Hourly,
            project: "Gyro".into(),
            provider: "Codex".into(),
            branch: "main".into(),
            workspace_mode: SessionWorkspaceMode::Local,
            worktree_name: None,
            stop_condition: None,
            next_run_at: Some(chrono::Utc::now() - chrono::Duration::minutes(1)),
            execution: gyro_core::AutomationExecutionContext::default(),
        })
        .unwrap();

    let completed =
        run_automation_scheduler_once_with(
            &paths,
            "worker-one",
            |_| Ok("All checks passed".into()),
        )
        .unwrap()
        .unwrap();
    assert_eq!(completed.id, automation.id);
    assert_eq!(completed.last_result, "All checks passed");
    assert_eq!(completed.run_history[0].status, AutomationRunStatus::Passed);
    assert!(completed.lease_owner.is_none());
    assert!(
        run_automation_scheduler_once_with(&paths, "worker-two", |_| {
            panic!("a completed lease must not execute twice")
        })
        .unwrap()
        .is_none()
    );
}

#[test]
fn scheduler_machine_enforces_stop_condition_verdicts() {
    let met_temp = tempfile::tempdir().unwrap();
    let met_paths = GyroPaths::from_base_dir(met_temp.path().join("Gyro"));
    create_due_stop_condition_automation(&met_paths);
    let completed = run_automation_scheduler_once_with(&met_paths, "met-worker", |_| {
        Ok(
            "Checks are green.\n\n<!-- gyro-automation-result: {\"stopConditionMet\":true} -->"
                .into(),
        )
    })
    .unwrap()
    .unwrap();
    assert_eq!(completed.status, AutomationStatus::Completed);
    assert_eq!(completed.last_result, "Checks are green.");
    assert!(completed.next_run_at.is_none());
    assert_eq!(completed.run_history[0].stop_condition_met, Some(true));

    let pending_temp = tempfile::tempdir().unwrap();
    let pending_paths = GyroPaths::from_base_dir(pending_temp.path().join("Gyro"));
    create_due_stop_condition_automation(&pending_paths);
    let pending = run_automation_scheduler_once_with(&pending_paths, "pending-worker", |_| {
        Ok(
            "One check still fails.\n<!-- gyro-automation-result: {\"stopConditionMet\":false} -->"
                .into(),
        )
    })
    .unwrap()
    .unwrap();
    assert_eq!(pending.status, AutomationStatus::Current);
    assert_eq!(pending.run_history[0].stop_condition_met, Some(false));
    assert!(pending.next_run_at.is_some());

    let missing_temp = tempfile::tempdir().unwrap();
    let missing_paths = GyroPaths::from_base_dir(missing_temp.path().join("Gyro"));
    create_due_stop_condition_automation(&missing_paths);
    let failed = run_automation_scheduler_once_with(&missing_paths, "missing-worker", |_| {
        Ok("The provider forgot the verdict".into())
    })
    .unwrap()
    .unwrap();
    assert_eq!(failed.status, AutomationStatus::Current);
    assert_eq!(failed.run_history[0].status, AutomationRunStatus::Failed);
    assert_eq!(failed.run_history[0].stop_condition_met, None);
    assert!(failed.last_result.contains("failed closed"));
}

#[test]
fn scheduler_wake_generation_cannot_be_lost_before_or_during_wait() {
    let control = Arc::new(AutomationSchedulerControl::default());
    let before_wake = control.generation();
    control.wake();
    let started = Instant::now();
    let after_early_wake = control.wait_for_change(before_wake, std::time::Duration::from_secs(1));
    assert_ne!(after_early_wake, before_wake);
    assert!(started.elapsed() < std::time::Duration::from_millis(100));

    let (ready_tx, ready_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let waiting_control = control.clone();
    let observed = control.generation();
    let waiter = std::thread::spawn(move || {
        ready_tx.send(()).unwrap();
        let generation =
            waiting_control.wait_for_change(observed, std::time::Duration::from_secs(5));
        done_tx.send(generation).unwrap();
    });
    ready_rx.recv().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(25));
    control.wake();
    let generation = done_rx
        .recv_timeout(std::time::Duration::from_secs(1))
        .unwrap();
    assert_ne!(generation, observed);
    waiter.join().unwrap();
}

#[test]
fn scheduler_clock_keeps_due_work_visible_after_a_backward_wall_change() {
    let initial = chrono::Utc::now();
    let backward_wall = initial - chrono::Duration::hours(2);
    let effective = automation_scheduler_effective_now(
        initial,
        std::time::Duration::from_secs(3 * 60),
        backward_wall,
    );
    assert_eq!(effective, initial + chrono::Duration::minutes(3));
    assert_eq!(
        automation_scheduler_effective_now(
            effective,
            std::time::Duration::from_secs(60),
            initial + chrono::Duration::hours(5),
        ),
        initial + chrono::Duration::hours(5)
    );

    let temp = tempfile::tempdir().unwrap();
    let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
    let store = AutomationStore::open(paths.clone()).unwrap();
    let automation = store
        .create_automation(CreateAutomationRequest {
            title: "Clock correction smoke".into(),
            prompt: "Run once after the clock changes".into(),
            schedule: gyro_core::AutomationSchedule::Hourly,
            project: "Gyro".into(),
            provider: "Codex".into(),
            branch: "main".into(),
            workspace_mode: SessionWorkspaceMode::Local,
            worktree_name: None,
            stop_condition: None,
            next_run_at: Some(initial + chrono::Duration::minutes(2)),
            execution: gyro_core::AutomationExecutionContext::default(),
        })
        .unwrap();

    let completed =
        run_automation_scheduler_once_at_with(&paths, "clock-worker", effective, |_| {
            Ok("Clock-safe run completed".into())
        })
        .unwrap()
        .unwrap();
    assert_eq!(completed.id, automation.id);
    assert_eq!(completed.run_history[0].status, AutomationRunStatus::Passed);
    assert!(completed
        .last_run_at
        .is_some_and(|ran_at| ran_at >= effective));
    assert!(run_automation_scheduler_once_at_with(
        &paths,
        "duplicate-worker",
        effective,
        |_| panic!("a backward clock change must not duplicate the run"),
    )
    .unwrap()
    .is_none());
}

#[test]
fn scheduler_heartbeat_renews_a_long_run_and_stops_before_completion() {
    let temp = tempfile::tempdir().unwrap();
    let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
    let store = AutomationStore::open(paths.clone()).unwrap();
    let automation = store
        .create_automation(CreateAutomationRequest {
            title: "Long-running approval".into(),
            prompt: "Wait for approval".into(),
            schedule: gyro_core::AutomationSchedule::Hourly,
            project: "Gyro".into(),
            provider: "Codex".into(),
            branch: "main".into(),
            workspace_mode: SessionWorkspaceMode::Local,
            worktree_name: None,
            stop_condition: None,
            next_run_at: Some(chrono::Utc::now() - chrono::Duration::minutes(1)),
            execution: gyro_core::AutomationExecutionContext::default(),
        })
        .unwrap();

    let completed = run_automation_scheduler_once_with_heartbeat_interval(
        &paths,
        "heartbeat-worker",
        std::time::Duration::from_millis(10),
        |claimed| {
            let initial_expiry = claimed.lease_expires_at.unwrap();
            for _ in 0..50 {
                std::thread::sleep(std::time::Duration::from_millis(10));
                let current = AutomationStore::open(paths.clone())
                    .unwrap()
                    .get_automation(automation.id)
                    .unwrap()
                    .unwrap();
                if current
                    .lease_expires_at
                    .is_some_and(|expiry| expiry > initial_expiry)
                {
                    return Ok("Approval completed".into());
                }
            }
            panic!("lease heartbeat did not extend the active run");
        },
    )
    .unwrap()
    .unwrap();

    assert_eq!(completed.run_history[0].status, AutomationRunStatus::Passed);
    assert!(completed.lease_owner.is_none());
    assert!(completed.lease_expires_at.is_none());
}

#[test]
fn resumed_run_event_explicitly_wakes_the_scheduler() {
    assert!(run_event_wakes_automation_scheduler(
        &tauri::RunEvent::Resumed
    ));
    assert!(!run_event_wakes_automation_scheduler(
        &tauri::RunEvent::Ready
    ));
}

#[test]
fn stop_condition_parser_rejects_malformed_or_non_final_verdicts() {
    let temp = tempfile::tempdir().unwrap();
    let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
    let automation = create_due_stop_condition_automation(&paths);

    assert!(parse_automation_execution_outcome(
        &automation,
        "Done\n<!-- gyro-automation-result: {not-json} -->"
    )
    .unwrap_err()
    .contains("invalid"));
    assert!(parse_automation_execution_outcome(
        &automation,
        "<!-- gyro-automation-result: {\"stopConditionMet\":true} -->\nextra"
    )
    .unwrap_err()
    .contains("final output"));

    let prompt = automation_provider_prompt(&automation);
    assert!(prompt.contains("Use true only when you verified"));
    assert!(prompt.contains("\"stopConditionMet\":false"));
}

#[test]
fn scheduler_recovers_an_interrupted_lease_once_before_retrying() {
    let temp = tempfile::tempdir().unwrap();
    let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
    let store = AutomationStore::open(paths.clone()).unwrap();
    store
        .create_automation(CreateAutomationRequest {
            title: "Interrupted run".into(),
            prompt: "Run checks".into(),
            schedule: gyro_core::AutomationSchedule::Hourly,
            project: "Gyro".into(),
            provider: "Codex".into(),
            branch: "main".into(),
            workspace_mode: SessionWorkspaceMode::Local,
            worktree_name: None,
            stop_condition: None,
            next_run_at: Some(chrono::Utc::now() - chrono::Duration::minutes(1)),
            execution: gyro_core::AutomationExecutionContext::default(),
        })
        .unwrap();
    store
        .claim_due_automation("crashed-worker", 30)
        .unwrap()
        .unwrap();
    let recovery_time = chrono::Utc::now() + chrono::Duration::minutes(1);
    let mut outcomes = Vec::new();

    assert_eq!(
        recover_automation_scheduler_leases_with(&paths, recovery_time, |automation| {
            outcomes.push(automation.clone());
        })
        .unwrap(),
        1
    );
    assert_eq!(outcomes.len(), 1);
    assert_eq!(
        outcomes[0].run_history[0].status,
        AutomationRunStatus::Failed
    );
    assert!(outcomes[0].lease_owner.is_none());
    assert!(
        run_automation_scheduler_once_with(&paths, "replacement-worker", |_| {
            panic!("recovery backoff must prevent an immediate duplicate run")
        })
        .unwrap()
        .is_none()
    );
    assert_eq!(
        recover_automation_scheduler_leases_with(&paths, recovery_time, |_| {
            panic!("an interrupted lease must only be recovered once")
        })
        .unwrap(),
        0
    );
}

#[test]
fn automation_notifications_are_private_and_only_cover_actionable_outcomes() {
    let temp = tempfile::tempdir().unwrap();
    let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
    let store = AutomationStore::open(paths.clone()).unwrap();
    let automation = store
        .create_automation(CreateAutomationRequest {
            title: "Private customer incident".into(),
            prompt: "Inspect /secret/workspace and summarize confidential files".into(),
            schedule: gyro_core::AutomationSchedule::Manual,
            project: "Secret workspace".into(),
            provider: "Codex".into(),
            branch: "main".into(),
            workspace_mode: SessionWorkspaceMode::Local,
            worktree_name: None,
            stop_condition: None,
            next_run_at: Some(chrono::Utc::now() - chrono::Duration::minutes(1)),
            execution: gyro_core::AutomationExecutionContext {
                workflow_binding: None,
                calendar: None,
                workspace_path: Some("/secret/workspace".into()),
                ..Default::default()
            },
        })
        .unwrap();
    let completed =
        run_automation_scheduler_once_with(&paths, "worker", |_| Ok("Confidential result".into()))
            .unwrap()
            .unwrap();

    let (title, body) = automation_notification_content(&completed).unwrap();
    let notification = format!("{title} {body}");
    assert!(!notification.contains(&automation.title));
    assert!(!notification.contains(&automation.prompt));
    assert!(!notification.contains("/secret/workspace"));

    let mut stopped = completed.clone();
    stopped.run_history[0].status = AutomationRunStatus::Stopped;
    assert!(automation_notification_content(&stopped).is_none());
    let mut running = completed;
    running.run_history[0].status = AutomationRunStatus::Running;
    assert!(automation_notification_content(&running).is_none());
}

#[test]
fn native_process_allowlists_reject_renderer_command_substitution() {
    assert!(language_server::language_server_command_is_allowed(
        "rust",
        "rust-analyzer"
    ));
    assert!(!language_server::language_server_command_is_allowed(
        "rust",
        "sh -c whoami"
    ));
    assert!(debug_adapter_command_is_allowed(
        "lldb-dap",
        "lldb-dap",
        &[]
    ));
    assert!(!debug_adapter_command_is_allowed(
        "sh",
        "sh",
        &["-c".into()]
    ));

    let workspace = tempfile::tempdir().unwrap();
    std::fs::write(
        workspace.path().join("package.json"),
        r#"{"scripts":{"safe":"echo safe"}}"#,
    )
    .unwrap();
    let error = task_run_blocking(TaskRunRequest {
        workspace_path: workspace.path().display().to_string(),
        task_id: "package:safe".into(),
        command: "sh".into(),
        args: vec!["-c".into(), "whoami".into()],
    })
    .unwrap_err();
    assert!(error.contains("task definition changed"));
}

#[test]
fn attaching_a_stored_draft_image_again_protects_it_from_eviction() {
    let root = tempfile::tempdir().unwrap();
    for index in 0..MAX_STORED_DRAFT_ATTACHMENTS {
        let path = root.path().join(format!("{index}.png"));
        std::fs::write(&path, b"x").unwrap();
        age_attachment(&path, 1_000 + index as u64);
    }
    let reused = root
        .path()
        .join(format!("{}.png", MAX_STORED_DRAFT_ATTACHMENTS - 1));

    make_room_in_draft_attachments(root.path(), &reused, 1).unwrap();
    make_room_in_draft_attachments(root.path(), &root.path().join("next.png"), 1).unwrap();

    assert!(reused.exists());
    assert!(!root
        .path()
        .join(format!("{}.png", MAX_STORED_DRAFT_ATTACHMENTS - 2))
        .exists());
}

#[test]
fn exact_stats_handle_binary_files_and_many_untracked_files() {
    let repo = tempfile::tempdir().unwrap();
    init_git_repo(repo.path());
    std::fs::write(repo.path().join("image.bin"), [0u8, 1, 2]).unwrap();
    run_git(repo.path(), &["add", "."]);
    run_git(repo.path(), &["commit", "-m", "base"]);
    std::fs::write(repo.path().join("image.bin"), [0u8, 3, 4]).unwrap();
    std::fs::create_dir(repo.path().join("new-directory")).unwrap();
    for index in 0..450 {
        std::fs::write(
            repo.path().join(format!("new-directory/new-{index}.txt")),
            "new\n",
        )
        .unwrap();
    }
    let status = git_status_impl(repo.path().to_str().unwrap()).unwrap();
    assert_eq!(status.additions, 450);
    assert!(!status.stats_partial);
    // Untracked files stay out of the main comparison; only the tracked
    // binary change is listed, and it has no line counts.
    let comparison = status.compared_to_main.unwrap();
    assert_eq!((comparison.additions, comparison.deletions), (0, 0));
    assert!(!comparison.partial);
    assert_eq!(comparison.files.len(), 1);
    assert_eq!(comparison.files[0].path, "image.bin");
    let (_, malformed) = parse_git_numstat("invalid\t1\tfile.txt");
    assert!(malformed);
}

#[test]
fn every_tool_schema_is_consistent_and_scoped() {
    for descriptor in gyro_core::CAPABILITY_DESCRIPTORS {
        let name = descriptor.id.provider_tool_name();
        let schema = desktop_capability_tool_schema(descriptor.id);
        let properties = schema["properties"].as_object().unwrap();
        for required in schema["required"].as_array().into_iter().flatten() {
            let required = required.as_str().unwrap();
            assert!(
                properties.contains_key(required),
                "{name} requires undeclared {required}"
            );
        }
        for (parameter, property) in properties {
            assert!(
                property.get("type").is_some() || property.get("enum").is_some(),
                "{name}.{parameter} has no type"
            );
        }
        if name.starts_with("gyro_browser_") {
            assert!(
                !properties.contains_key("rootId"),
                "{name} is not bound to a workspace root"
            );
        }
    }
    let diff = desktop_capability_tool_schema(CapabilityId::WorkspaceDiff);
    assert!(!diff["required"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|required| required == "path"));
}
