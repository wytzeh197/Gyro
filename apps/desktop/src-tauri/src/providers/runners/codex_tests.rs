use super::*;

#[test]
fn gyro_applied_file_changes_are_not_applied_again_by_codex() {
    assert_eq!(
        codex_provider_approval_response(ProviderApprovalDecision::AppliedByGyro),
        "decline"
    );
    assert_eq!(
        codex_provider_approval_response(ProviderApprovalDecision::Approve),
        "accept"
    );
}

#[test]
fn codex_capability_approvals_are_scoped_to_registered_gyro_tools() {
    let args = codex_capability_tool_approval_args();
    let expected: HashSet<_> = CAPABILITY_DESCRIPTORS
        .iter()
        .map(|descriptor| descriptor.id.provider_tool_name())
        .collect();
    let mut configured = HashSet::new();
    for pair in args.chunks_exact(2) {
        assert_eq!(pair[0], "-c");
        let tool = pair[1]
            .strip_prefix("mcp_servers.gyro_capabilities.tools.")
            .and_then(|value| value.strip_suffix(".approval_mode=\"approve\""))
            .expect("only individual built-in tool approval settings may be overridden");
        assert!(configured.insert(tool));
    }
    assert_eq!(configured, expected);
    assert!(configured.contains("gyro_workspace_get_context"));
    assert!(configured.contains("gyro_workspace_check"));
    assert!(configured.contains("gyro_browser_open"));
}

#[test]
fn codex_usage_windows_follow_reported_duration_instead_of_slot() {
    let windows = provider_usage_windows_from_codex(&CodexRateLimitSnapshot {
        primary: Some(CodexRateLimitWindow {
            used_percent: 29,
            window_duration_mins: Some(10_080),
            resets_at: Some(1_784_489_840),
        }),
        secondary: None,
    });

    assert_eq!(windows.len(), 1);
    assert_eq!(windows[0].id, "weekly");
    assert_eq!(windows[0].label, "Weekly window");
    assert_eq!(windows[0].used_percent, Some(29));
    assert_eq!(windows[0].status, "ok");
    assert!(windows[0]
        .resets_at
        .as_deref()
        .is_some_and(|value| { chrono::DateTime::parse_from_rfc3339(value).is_ok() }));
}

#[test]
fn codex_usage_windows_name_a_plan_only_window_by_its_duration() {
    // The free plan meters one 30-day window and sends it in the primary
    // slot. Calling that "5-hour" would misstate the allowance by 144x.
    let windows = provider_usage_windows_from_codex(&CodexRateLimitSnapshot {
        primary: Some(CodexRateLimitWindow {
            used_percent: 7,
            window_duration_mins: Some(43_200),
            resets_at: None,
        }),
        secondary: None,
    });

    assert_eq!(windows.len(), 1);
    assert_eq!(windows[0].id, "monthly");
    assert_eq!(windows[0].label, "Monthly window");
    assert_eq!(windows[0].used_percent, Some(7));
}

#[test]
fn codex_usage_windows_describe_a_duration_gyro_does_not_name() {
    let windows = provider_usage_windows_from_codex(&CodexRateLimitSnapshot {
        primary: Some(CodexRateLimitWindow {
            used_percent: 3,
            window_duration_mins: Some(180),
            resets_at: None,
        }),
        secondary: Some(CodexRateLimitWindow {
            used_percent: 4,
            window_duration_mins: Some(4_320),
            resets_at: None,
        }),
    });

    assert_eq!(
        windows
            .iter()
            .map(|window| (window.id.as_str(), window.label.as_str()))
            .collect::<Vec<_>>(),
        vec![("3-hour", "3-hour window"), ("3-day", "3-day window")]
    );
}

#[test]
fn codex_usage_windows_are_clamped_ordered_and_deduplicated() {
    let windows = provider_usage_windows_from_codex(&CodexRateLimitSnapshot {
        primary: Some(CodexRateLimitWindow {
            used_percent: 140,
            window_duration_mins: Some(300),
            resets_at: None,
        }),
        secondary: Some(CodexRateLimitWindow {
            used_percent: -5,
            window_duration_mins: Some(10_080),
            resets_at: None,
        }),
    });

    assert_eq!(
        windows
            .iter()
            .map(|window| window.id.as_str())
            .collect::<Vec<_>>(),
        vec!["five-hour", "weekly"]
    );
    assert_eq!(windows[0].used_percent, Some(100));
    assert_eq!(windows[1].used_percent, Some(0));
    // A clamped level still has to describe itself honestly.
    assert_eq!(windows[0].status, "exhausted");
    assert_eq!(windows[1].status, "ok");
}

#[test]
fn codex_app_server_errors_are_exposed_without_protocol_details() {
    let error = codex_app_server_result(&serde_json::json!({
        "id": 2,
        "error": { "code": -32603, "message": "Login required" },
    }))
    .unwrap_err();

    assert_eq!(error, "Login required");
}

#[test]
#[ignore = "requires a locally authenticated Codex CLI"]
fn live_codex_provider_usage_reads_the_current_account() {
    let snapshot = get_provider_usage_blocking("openai", false).unwrap();

    assert_eq!(snapshot.provider_id, "openai");
    assert!(!snapshot.windows.is_empty());
    // A window a provider named but did not measure reports no percentage,
    // which is a reading in its own right rather than a failure.
    assert!(snapshot
        .windows
        .iter()
        .filter_map(|window| window.used_percent)
        .all(|used_percent| (0..=100).contains(&used_percent)));
}

#[test]
fn provider_health_skips_codex_login_for_external_env_auth() {
    assert!(should_skip_codex_login_for_external_env(
        Some("https://gateway.example.test/v1"),
        Some("provider-env:PORTKEY_API_KEY"),
    ));
    assert!(!should_skip_codex_login_for_external_env(
        Some("https://api.openai.com/v1"),
        Some("provider-cli:codex"),
    ));
}

#[test]
fn codex_chat_preserves_requested_models_for_authentication_specific_validation() {
    for model in ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "o4-mini"] {
        assert_eq!(codex_model_arg(Some(model)), Some(model.into()));
    }
    assert_eq!(
        codex_model_arg(Some(" gpt-5.4-mini ")),
        Some("gpt-5.4-mini".into())
    );
    assert_eq!(codex_model_arg(Some("gpt-5")), None);
}

#[test]
fn astra_model_and_effort_are_forwarded_to_codex() {
    assert_eq!(
        codex_model_arg(Some("gpt-6-astra")),
        Some("gpt-6-astra".into())
    );
    for effort in ["low", "medium", "high", "xhigh", "max", "ultra"] {
        assert_eq!(
            codex_reasoning_effort_arg(Some("gpt-6-astra"), Some(effort)),
            Some(effort.into())
        );
    }
    assert_eq!(
        codex_reasoning_effort_arg(Some("gpt-6-astra"), Some("invalid")),
        None
    );
    assert_eq!(
        provider_model_context_window("openai", Some("gpt-6-astra")),
        Some(272_000)
    );
    assert_eq!(
        provider_model_context_window("anthropic", Some("claude-fable-5-1")),
        Some(1_000_000)
    );
}

#[test]
fn gpt_6_1_sol_model_and_effort_are_forwarded_to_codex() {
    assert_eq!(
        codex_model_arg(Some("gpt-6.1-sol")),
        Some("gpt-6.1-sol".into())
    );
    for effort in ["low", "medium", "high", "xhigh", "max", "ultra"] {
        assert_eq!(
            codex_reasoning_effort_arg(Some("gpt-6.1-sol"), Some(effort)),
            Some(effort.into())
        );
    }
    assert_eq!(
        codex_reasoning_effort_arg(Some("gpt-6.1-sol"), Some("invalid")),
        None
    );
    assert_eq!(
        provider_model_context_window("openai", Some("gpt-6.1-sol")),
        Some(500_000)
    );
}

#[test]
fn gpt_6_sol_and_luna_efforts_are_forwarded_to_codex() {
    for model in ["gpt-6-sol", "gpt-6-luna", "gpt-5.6-luna"] {
        assert_eq!(codex_model_arg(Some(model)), Some(model.into()));
        for effort in ["low", "medium", "high", "xhigh", "max"] {
            assert_eq!(
                codex_reasoning_effort_arg(Some(model), Some(effort)),
                Some(effort.into())
            );
        }
    }
    assert_eq!(
        codex_reasoning_effort_arg(Some("gpt-6-sol"), Some("ultra")),
        Some("ultra".into())
    );
    assert_eq!(
        codex_reasoning_effort_arg(Some("gpt-6-luna"), Some("ultra")),
        None
    );
    assert_eq!(
        codex_reasoning_effort_arg(Some("gpt-5.6-luna"), Some("ultra")),
        None
    );
}

#[test]
fn codex_chat_prompt_prefers_concise_answers() {
    let prompt = openai_codex_chat_prompt(
        "WHAT MODEL are you?",
        Some("/workspace"),
        Some("GPT-5.6 Sol"),
        true,
        false,
        false,
    );

    assert!(prompt.contains("polished, scannable Markdown"));
    assert!(prompt.contains("bullets or numbered lists"));
    assert!(prompt.contains("each thing on its own bullet"));
    assert!(prompt.contains("Do not repeat the same conclusion"));
    assert!(prompt.contains("selected model label is: GPT-5.6 Sol"));
    assert!(prompt.contains("exactly that selected model label only"));
    assert!(prompt.contains("Do not describe the local Codex runner"));
    assert!(prompt.contains("GYRO_SESSION_TITLE: <2-6 word title>"));
    assert!(prompt.contains("name the session immediately"));
    assert!(!prompt.contains(browser_knowledge::SIDE_PANEL_GUIDE));
    assert!(prompt.contains("Selected workspace: /workspace"));
    assert!(prompt.contains("Do not edit files"));

    let full_access_prompt =
        openai_codex_chat_prompt("fix it", Some("/workspace"), None, false, true, false);
    assert!(full_access_prompt.contains(
        "You may edit files, run commands, and complete requested workspace changes directly."
    ));
    assert!(!full_access_prompt.contains("Do not edit files"));
}

#[test]
fn codex_app_server_policy_keeps_gated_edits_read_only() {
    let workspace = Path::new("/tmp/gyro-workspace");
    let (approval, sandbox, policy) =
        codex_app_server_policy(&ChatMode::Normal, true, true, false, workspace);
    assert_eq!(approval, "untrusted");
    assert_eq!(sandbox, "read-only");
    assert_eq!(policy["type"], "readOnly");
    assert_eq!(policy["networkAccess"], false);

    let (approval, sandbox, policy) =
        codex_app_server_policy(&ChatMode::Normal, false, false, false, workspace);
    assert_eq!(approval, "on-request");
    assert_eq!(sandbox, "workspace-write");
    assert_eq!(policy["type"], "workspaceWrite");
    assert_eq!(policy["writableRoots"][0], "/tmp/gyro-workspace");

    let (approval, sandbox, policy) =
        codex_app_server_policy(&ChatMode::Normal, false, false, true, workspace);
    assert_eq!(approval, "on-request");
    assert_eq!(sandbox, "danger-full-access");
    assert_eq!(policy["type"], "dangerFullAccess");

    let (approval, sandbox, policy) =
        codex_app_server_policy(&ChatMode::Normal, true, false, true, workspace);
    assert_eq!(approval, "untrusted");
    assert_eq!(sandbox, "workspace-write");
    assert_eq!(policy["type"], "workspaceWrite");

    let (approval, sandbox, policy) =
        codex_app_server_policy(&ChatMode::Plan, false, false, false, workspace);
    assert_eq!(approval, "untrusted");
    assert_eq!(sandbox, "read-only");
    assert_eq!(policy["type"], "readOnly");
    assert_eq!(policy["networkAccess"], false);
    assert_eq!(provider_approval_label("command"), "Review command");
    assert!(provider_approval_risk("file-change").contains("workspace patch"));
}

#[test]
fn codex_app_server_commentary_streams_cumulative_snapshots_with_missing_ids() {
    let mut stream = CodexAppServerCommentaryStream::new();
    let mut activities = Vec::new();

    stream.push_delta(&mut activities, None, "I’ll inspect");
    let (first, first_sequence) = stream
        .take_snapshot(&activities, false)
        .expect("first commentary token is not held for the flush interval");
    assert_eq!(first.id, "codex-commentary-0");
    assert_eq!(first.label, "I’ll inspect");
    assert_eq!(first.status, "running");
    assert_eq!(first_sequence, 0);
    stream.dirty = true;
    stream.last_emit_at = Some(Instant::now());
    assert!(stream.take_snapshot(&activities, false).is_none());

    stream.push_delta(&mut activities, None, " the project.");
    let (cumulative, cumulative_sequence) = stream
        .take_snapshot(&activities, true)
        .expect("cumulative commentary snapshot");
    assert_eq!(cumulative.id, first.id);
    assert_eq!(cumulative.label, "I’ll inspect the project.");
    assert_eq!(cumulative_sequence, first_sequence);

    stream.complete_message(
        &mut activities,
        None,
        Some("I’ll inspect the project first."),
    );
    let (completed, completed_sequence) = stream
        .take_snapshot(&activities, true)
        .expect("completed commentary snapshot");
    assert_eq!(completed.id, first.id);
    assert_eq!(completed.label, "I’ll inspect the project first.");
    assert_eq!(completed.status, "done");
    assert_eq!(completed_sequence, first_sequence);
    stream.finish_message();

    stream.push_delta(&mut activities, None, "Next update.");
    assert_eq!(activities[1].id, "codex-commentary-1");
}

#[test]
fn codex_app_server_commentary_preserves_activity_order_and_dedupes_final() {
    let mut stream = CodexAppServerCommentaryStream::new();
    let mut activities = Vec::new();
    let mut commentary_sequences = Vec::new();
    let mut complete_commentary = |stream: &mut CodexAppServerCommentaryStream,
                                   activities: &mut Vec<ProviderActivity>,
                                   item_id: Option<&str>,
                                   text: &str| {
        stream.push_delta(activities, item_id, text);
        stream.complete_message(activities, item_id, Some(text));
        let (_, sequence) = stream
            .take_snapshot(activities, true)
            .expect("completed commentary");
        commentary_sequences.push(sequence);
        stream.finish_message();
    };

    complete_commentary(
        &mut stream,
        &mut activities,
        Some("opening-message"),
        "I’ll inspect first.",
    );
    activities.push(ProviderActivity {
        id: "command-1".into(),
        kind: "command".into(),
        label: "Searched project".into(),
        detail: None,
        file_counts: None,
        note: None,
        status: "done".into(),
    });
    complete_commentary(
        &mut stream,
        &mut activities,
        None,
        "I found the relevant code.",
    );
    activities.push(ProviderActivity {
        id: "command-2".into(),
        kind: "command".into(),
        label: "Ran tests".into(),
        detail: None,
        file_counts: None,
        note: None,
        status: "done".into(),
    });
    complete_commentary(
        &mut stream,
        &mut activities,
        Some("final-message"),
        "The timeline is fixed.",
    );

    assert_eq!(commentary_sequences, vec![0, 2, 4]);
    assert_eq!(
        activities
            .iter()
            .map(|activity| (activity.kind.as_str(), activity.label.as_str()))
            .collect::<Vec<_>>(),
        vec![
            ("commentary", "I’ll inspect first."),
            ("command", "Searched project"),
            ("commentary", "I found the relevant code."),
            ("command", "Ran tests"),
            ("commentary", "The timeline is fixed."),
        ]
    );

    let retained = provider_activities_for_response(activities, "The timeline is fixed.");
    assert_eq!(retained.len(), 4);
    assert_eq!(retained[0].label, "I’ll inspect first.");
    assert_eq!(retained[2].label, "I found the relevant code.");
    assert!(retained
        .iter()
        .all(|activity| activity.label != "The timeline is fixed."));
}

#[test]
fn parses_codex_app_server_context_usage() {
    let usage = provider_context_usage_from_app_server(&serde_json::json!({
        "tokenUsage": {
            "last": {
                "inputTokens": 42137,
                "cachedInputTokens": 40000,
                "outputTokens": 812,
                "reasoningOutputTokens": 205,
                "totalTokens": 42949
            },
            "modelContextWindow": 128000
        }
    }))
    .unwrap();
    assert_eq!(usage.input_tokens, Some(42_137));
    assert_eq!(usage.model_context_window, Some(128_000));
}

#[test]
fn parses_codex_exec_context_usage() {
    let usage = provider_context_usage_from_codex_exec(&serde_json::json!({
        "type": "turn.completed",
        "usage": {
            "input_tokens": 42137,
            "cached_input_tokens": 40000,
            "output_tokens": 812,
            "reasoning_output_tokens": 205,
            "total_tokens": 42949,
            "model_context_window": 128000
        }
    }))
    .unwrap();
    assert_eq!(usage.input_tokens, Some(42_137));
    assert_eq!(usage.model_context_window, Some(128_000));
}

#[test]
fn codex_protocol_reader_accepts_frames_larger_than_four_megabytes() {
    // Rich tool results and resumed histories can exceed the former
    // 4 MiB cap. Such a frame must reach the JSON decoder rather than
    // turning a normal chat send into a generic retry failure.
    let payload_len = 4 * 1024 * 1024 + 1;
    let mut frame = vec![b'x'; payload_len];
    frame.push(b'\n');
    let mut reader = BufReader::new(std::io::Cursor::new(frame));

    assert_eq!(
        read_bounded_protocol_line(&mut reader, MAX_CODEX_APP_SERVER_MESSAGE_BYTES)
            .unwrap()
            .unwrap()
            .len(),
        payload_len
    );
}

#[test]
fn codex_patch_accumulator_is_bounded() {
    let mut patches = HashMap::new();
    for index in 0..MAX_CODEX_APP_SERVER_PATCHES {
        insert_codex_app_server_patch(
            &mut patches,
            &format!("patch-{index}"),
            serde_json::json!({ "changes": [] }),
        )
        .unwrap();
    }
    assert!(insert_codex_app_server_patch(
        &mut patches,
        "one-too-many",
        serde_json::json!({ "changes": [] }),
    )
    .is_err());
    assert!(insert_codex_app_server_patch(
        &mut HashMap::new(),
        "oversized",
        serde_json::json!({ "changes": "x".repeat(MAX_CODEX_APP_SERVER_PATCH_BYTES) }),
    )
    .is_err());
}

#[test]
fn codex_file_change_activity_keeps_only_reported_paths() {
    let item = serde_json::json!({
        "id": "change-1",
        "type": "fileChange",
        "status": "completed",
    });
    let patch = serde_json::json!({
        "changes": [
            { "path": "packages/ui/src/chat-run.ts", "diff": "@@ -1 +1,2 @@\n-old\n+new\n+added\n" },
            { "path": "packages/ui/src/surfaces.tsx" },
        ],
    });

    let activities = codex_file_change_activities(&item, Some(&patch));

    assert_eq!(
        activities
            .iter()
            .filter_map(|activity| activity.detail.as_deref())
            .collect::<Vec<_>>(),
        vec![
            "packages/ui/src/chat-run.ts",
            "packages/ui/src/surfaces.tsx",
        ],
    );
    assert_eq!(activities[0].file_counts, Some((2, 1)));
    assert_eq!(activities[1].file_counts, None);
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
    let session = store
        .create_session(temp.path(), SessionOrigin::Desktop, "counts")
        .unwrap();
    let request = provider_chat_request_for(&session, temp.path(), "openai");
    let (_, payload, _) =
        provider_activity_event_entry(&request, Uuid::new_v4(), 0, &activities[0]);
    assert_eq!(payload["additions"], 2);
    assert_eq!(payload["deletions"], 1);
    assert!(codex_file_change_activities(&item, None).is_empty());
}

#[test]
fn codex_early_exit_reports_the_tail_of_its_stderr() {
    assert_eq!(
        codex_app_server_closed_message(" \n"),
        "Codex app server closed unexpectedly"
    );
    assert_eq!(
        codex_app_server_closed_message(
            "Error: model_providers contains reserved built-in provider IDs: `openai`.\nin `model_providers`\n"
        ),
        "Codex app server closed unexpectedly: Error: model_providers contains reserved built-in provider IDs: `openai`. in `model_providers`"
    );
    let long = format!("{}final cause", "noise ".repeat(400));
    let message = codex_app_server_closed_message(&long);
    assert!(message.ends_with("final cause"));
    assert!(message.contains('…'));
    assert!(message.chars().count() < 700);
}

#[test]
fn codex_early_exit_includes_stderr_from_the_real_process() {
    let mut child = Command::new("/bin/sh")
        .args(["-c", "echo 'fatal: bad config' >&2; exit 1"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let messages = spawn_codex_app_server_reader(child.stdout.take().unwrap(), child.stderr.take());
    let error = messages
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap_err();
    let _ = child.wait();
    assert_eq!(
        error,
        "Codex app server closed unexpectedly: fatal: bad config"
    );
}
