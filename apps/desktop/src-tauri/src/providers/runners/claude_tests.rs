use super::*;

#[test]
fn gyro_applied_file_changes_are_not_applied_again_by_claude() {
    let response = desktop_claude_approval_response(
        ProviderApprovalDecision::AppliedByGyro,
        serde_json::json!({ "file_path": "src/main.rs" }),
    );

    assert_eq!(response.behavior, DesktopProviderApprovalBehavior::Deny);
    assert!(response.updated_input.is_none());
    assert!(response.message.contains("already applied"));
}

#[test]
fn desktop_claude_mcp_config_uses_the_installed_binary_and_gated_context() {
    let request = anthropic_provider_request();
    let bound = bound_capability_context(&request);
    let config: serde_json::Value = serde_json::from_str(
        &desktop_claude_permission_mcp_config(&request, "test-run-nonce", &bound).unwrap(),
    )
    .unwrap();
    let server = &config["mcpServers"]["gyro_approval"];

    assert!(server["command"]
        .as_str()
        .is_some_and(|command| !command.trim().is_empty()));
    assert_eq!(
        server["args"],
        serde_json::json!(["provider-permission-server"])
    );
    assert_eq!(
        server["env"]["GYRO_DESKTOP_PERMISSION_SESSION_ID"],
        request.session_id
    );
    assert_eq!(
        server["env"]["GYRO_DESKTOP_PERMISSION_REQUIRE_FILE"],
        "true"
    );
    assert_eq!(
        server["env"]["GYRO_DESKTOP_PERMISSION_RUN_NONCE"],
        "test-run-nonce"
    );
    let capabilities = &config["mcpServers"]["gyro_capabilities"];
    for bridge in [server, capabilities] {
        assert_eq!(
            bridge["env"]["GYRO_PROVIDER_HOST_PID"],
            std::process::id().to_string()
        );
    }
    assert_eq!(
        capabilities["args"],
        serde_json::json!(["provider-capability-server"])
    );
    assert_eq!(
        capabilities["env"]["GYRO_CAPABILITY_SESSION_ID"],
        request.session_id
    );
    assert_eq!(
        capabilities["env"]["GYRO_CAPABILITY_RUN_NONCE"],
        "test-run-nonce"
    );
    assert_eq!(
        capabilities["env"]["GYRO_CAPABILITY_WORKSPACE_CONTEXT_REVISION"],
        "0"
    );
    assert_eq!(
        capabilities["env"]["GYRO_CAPABILITY_ALLOW_DELEGATION"],
        "false"
    );
}

#[test]
fn desktop_claude_prompt_allows_approved_actions_but_plan_mode_stays_read_only() {
    let actionable = claude_chat_prompt("edit it", Some("/tmp/project"), false, true, false);
    assert!(actionable.contains("must follow Gyro's permission decisions"));
    assert!(actionable.contains("do not retry the write"));
    assert!(!actionable.contains(browser_knowledge::SIDE_PANEL_GUIDE));
    assert!(!actionable.contains("Stay in planning mode"));

    let plan = claude_chat_prompt("plan it", Some("/tmp/project"), false, false, false);
    assert!(plan.contains("Stay in planning mode"));
    assert!(plan.contains("Do not edit files"));
}

#[test]
fn desktop_claude_approval_events_summarize_large_file_content() {
    let request = DesktopProviderApprovalRequest {
        schema: DESKTOP_PROVIDER_APPROVAL_IPC_SCHEMA_V1.into(),
        sender_version: env!("CARGO_PKG_VERSION").into(),
        session_id: Uuid::new_v4().to_string(),
        turn_id: Some(Uuid::new_v4().to_string()),
        run_nonce: "test-run-nonce".into(),
        provider_id: "anthropic".into(),
        provider_label: Some("Anthropic".into()),
        tool_name: "Write".into(),
        input: serde_json::json!({
            "file_path": "large.txt",
            "content": format!("secret-provider-token{}", "x".repeat(200_000)),
        }),
        permission_suggestions: serde_json::json!([]),
        require_command_approval: true,
        require_file_edit_approval: true,
    };

    let details = desktop_claude_approval_details(&request, Path::new("/tmp/project"));
    let encoded = serde_json::to_vec(&details).unwrap();

    assert!(encoded.len() < 32 * 1024);
    assert_eq!(details["patch"]["changes"][0]["path"], "large.txt");
    assert_eq!(details["input"]["operation"], "Write");
    assert_eq!(details["input"]["contentBytes"], 200_021);
    assert!(!String::from_utf8(encoded)
        .unwrap()
        .contains("secret-provider-token"));
}

#[test]
fn desktop_claude_permission_child_fails_closed_without_the_app() {
    let temp = tempfile::tempdir().unwrap();
    let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
    let context = DesktopProviderPermissionContext {
        session_id: Uuid::new_v4().to_string(),
        turn_id: Some(Uuid::new_v4().to_string()),
        run_nonce: "test-run-nonce".into(),
        provider_id: "anthropic".into(),
        provider_label: Some("Anthropic".into()),
        require_command_approval: true,
        require_file_edit_approval: true,
    };

    let result = desktop_permission_tool_call(
        &paths,
        &context,
        serde_json::json!({
            "name": "approve",
            "arguments": {
                "tool_name": "Bash",
                "input": { "command": "echo hello" },
            },
        }),
    )
    .unwrap();
    let permission: serde_json::Value =
        serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();

    assert_eq!(permission["behavior"], "deny");
    assert!(permission["message"]
        .as_str()
        .unwrap()
        .contains("approval was unavailable"));
}

#[cfg(unix)]
#[test]
fn desktop_claude_permission_child_forwards_tool_context_to_the_app() {
    use std::os::unix::net::UnixListener;

    let temp = tempfile::tempdir().unwrap();
    let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
    std::fs::create_dir_all(paths.socket_path.parent().unwrap()).unwrap();
    let listener = UnixListener::bind(&paths.socket_path).unwrap();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut line = String::new();
        BufReader::new(stream.try_clone().unwrap())
            .read_line(&mut line)
            .unwrap();
        let request: DesktopProviderApprovalRequest = serde_json::from_str(&line).unwrap();
        assert_eq!(request.provider_id, "anthropic");
        assert_eq!(request.tool_name, "Write");
        assert_eq!(request.input["file_path"], "src/main.rs");
        let mut stream = stream;
        serde_json::to_writer(
            &mut stream,
            &DesktopProviderApprovalResponse::deny("Reviewed and rejected"),
        )
        .unwrap();
        stream.write_all(b"\n").unwrap();
        stream.flush().unwrap();
    });
    let context = DesktopProviderPermissionContext {
        session_id: Uuid::new_v4().to_string(),
        turn_id: Some(Uuid::new_v4().to_string()),
        run_nonce: "test-run-nonce".into(),
        provider_id: "anthropic".into(),
        provider_label: Some("Anthropic".into()),
        require_command_approval: true,
        require_file_edit_approval: true,
    };

    let result = desktop_permission_tool_call(
        &paths,
        &context,
        serde_json::json!({
            "name": "approve",
            "arguments": {
                "tool_name": "Write",
                "input": { "file_path": "src/main.rs", "content": "fn main() {}\n" },
            },
        }),
    )
    .unwrap();
    let permission: serde_json::Value =
        serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();

    assert_eq!(permission["behavior"], "deny");
    assert_eq!(permission["message"], "Reviewed and rejected");
    server.join().unwrap();
}

#[test]
fn a_lapsed_claude_token_names_the_fix_its_refresh_token_still_allows() {
    let now = 1_000_000_000_000i64;
    let credentials = |expires: i64, refresh_expires: i64| {
        serde_json::json!({
            "claudeAiOauth": {
                "accessToken": "token-value",
                "expiresAt": expires,
                "refreshTokenExpiresAt": refresh_expires,
            }
        })
        .to_string()
    };

    assert_eq!(
        claude_oauth_access_token_at(&credentials(now + 1, now + 2), now).unwrap(),
        "token-value"
    );
    // The access token lapsed but the refresh token has not: using Claude
    // at all is enough, and Gyro should not send the user to a login page.
    assert_eq!(
        claude_oauth_access_token_at(&credentials(now - 1, now + 2), now).unwrap_err(),
        "Claude Code's token has lapsed. Send a Claude message to refresh it."
    );
    // Both lapsed, so nothing short of signing in again will help.
    assert_eq!(
        claude_oauth_access_token_at(&credentials(now - 2, now - 1), now).unwrap_err(),
        "Claude Code is signed out. Run `claude auth login` to read your plan usage."
    );
}

/// Claude runs load every Gyro tool up front (`ENABLE_TOOL_SEARCH=false`),
/// so the advertised list is paid on each fresh session. Measured at
/// ~38 KB (~9.5K tokens) for Normal mode; growth past this budget should be
/// a deliberate choice, e.g. switching to `auto:N` deferral.
#[test]
fn eagerly_loaded_claude_tool_list_stays_within_budget() {
    const BUDGET_BYTES: usize = 64 * 1024;
    for mode in [
        CapabilityRunMode::Normal,
        CapabilityRunMode::Plan,
        CapabilityRunMode::Council,
    ] {
        let tools: Vec<serde_json::Value> = advertised_capability_descriptors(mode)
            .map(|descriptor| {
                serde_json::json!({
                    "name": descriptor.id.provider_tool_name(),
                    "description": provider_tool_batch::advertised_description(
                        descriptor.id,
                        descriptor.description,
                    ),
                    "inputSchema": provider_tool_batch::advertised_tool_parameters(descriptor.id),
                })
            })
            .collect();
        let bytes = serde_json::to_string(&tools).unwrap().len();
        assert!(
                bytes <= BUDGET_BYTES,
                "{mode:?} advertises {} tools in {bytes} bytes, over the {BUDGET_BYTES}-byte eager-load budget",
                tools.len(),
            );
    }
}

#[test]
fn claude_five_minute_cache_frames_count_writes_apart_from_reads() {
    // Usage blocks as the Claude CLI printed them with FORCE_PROMPT_CACHING_5M=1.
    let usage = serde_json::json!({
        "input_tokens": 2,
        "cache_creation_input_tokens": 2977,
        "cache_read_input_tokens": 658,
        "cache_creation": {
            "ephemeral_5m_input_tokens": 2977,
            "ephemeral_1h_input_tokens": 0
        },
        "output_tokens": 4,
        "service_tier": "standard"
    });
    let mut parser = provider_accounting::ClaudeTurnUsage::default();
    parser.observe(&serde_json::json!({
        "type": "assistant",
        "message": { "id": "msg_1", "stop_reason": null, "usage": usage }
    }));
    parser.observe(&serde_json::json!({
        "type": "result",
        "subtype": "success",
        "is_error": false,
        "usage": usage
    }));
    let tokens = parser.tokens().expect("usage should be accounted");
    assert_eq!(tokens.input_tokens, 3_637);
    assert_eq!(tokens.cached_input_tokens, 658);
    assert_eq!(tokens.cache_write_tokens, 2_977);
    assert_eq!(tokens.output_tokens, 4);
    assert!(tokens.effective_accounting().known.cache_write);
}

#[test]
fn claude_runs_keep_cache_reads_and_writes_apart() {
    let mut parser = provider_accounting::ClaudeTurnUsage::default();
    parser.observe(&serde_json::json!({
        "type": "result",
        "subtype": "success",
        "usage": {
            "input_tokens": 10,
            "cache_read_input_tokens": 900,
            "cache_creation_input_tokens": 90,
            "output_tokens": 5
        }
    }));
    let accounted = parser.tokens();
    for answer_cut_off in [false, true] {
        let tokens = claude_runner_output(
            StreamingCommandOutput {
                activities: Vec::new(),
                context_usage: None,
                billed_usage: Some(ProviderContextUsage {
                    input_tokens: Some(1_000),
                    cached_input_tokens: Some(990),
                    output_tokens: Some(5),
                    total_tokens: Some(1_005),
                    ..Default::default()
                }),
                accounted_usage: accounted,
                rate_limits: Vec::new(),
                status_success: !answer_cut_off,
                status_label: "exit status: 0".into(),
                stdout: String::new(),
                stderr: String::new(),
                assistant_text: Some("done".into()),
                text_blocks: Vec::new(),
                parsed_stream_json: true,
                provider_session_id: Some("sess-1".into()),
            },
            "done".into(),
            "sess-1".into(),
            false,
            answer_cut_off,
        )
        .accounted_usage
        .expect("the parser's total reaches the runner output");
        assert_eq!(tokens.input_tokens, 1_000);
        assert_eq!(tokens.cached_input_tokens, 900);
        assert_eq!(tokens.cache_write_tokens, 90);
        assert!(tokens.effective_accounting().known.cache_write);
    }
}

/// A tool-using turn re-sends the conversation on every request, so the
/// closing frame's totals are a multiple of the window. The meter has to
/// keep the last request's occupancy and take only the window from the close.
#[test]
fn claude_turn_totals_never_replace_the_last_request() {
    let mut state = StreamingCommandState::new();
    for cache_read in [40_000_u64, 88_000] {
        let (frame, usage) = provider_context_usage_from_claude_stream(&serde_json::json!({
            "type": "assistant",
            "message": {
                "usage": {
                    "input_tokens": 12,
                    "cache_read_input_tokens": cache_read,
                    "output_tokens": 900
                }
            }
        }))
        .unwrap();
        state.apply_claude_context_usage(frame, usage, None);
    }
    let (frame, usage) = provider_context_usage_from_claude_stream(&serde_json::json!({
        "type": "result",
        "usage": {
            "input_tokens": 64,
            "cache_read_input_tokens": 1_171_028,
            "output_tokens": 11_063
        },
        "modelUsage": { "claude-opus-4-5": { "contextWindow": 200000 } }
    }))
    .unwrap();
    state.apply_claude_context_usage(frame, usage, None);

    let merged = state.context_usage.expect("usage");
    assert_eq!(merged.input_tokens, Some(88_012));
    assert_eq!(merged.total_tokens, Some(88_912));
    assert_eq!(merged.model_context_window, Some(200_000));
}

/// Without a request frame, turn spend cannot establish context occupancy.
#[test]
fn claude_turn_totals_do_not_invent_context_when_no_request_frame_arrived() {
    let mut state = StreamingCommandState::new();
    let (frame, usage) = provider_context_usage_from_claude_stream(&serde_json::json!({
        "type": "result",
        "usage": { "input_tokens": 4_000, "output_tokens": 120 },
        "modelUsage": { "claude-opus-4-5": { "contextWindow": 200000 } }
    }))
    .unwrap();
    state.apply_claude_context_usage(frame, usage, None);

    assert!(state.context_usage.is_none());
    assert_eq!(
        state.billed_usage.as_ref().unwrap().total_tokens,
        Some(4_120)
    );
}

#[test]
fn claude_overage_counts_the_plan_limit_as_spent() {
    let window = provider_rate_limit_from_claude_stream(&serde_json::json!({
        "type": "rate_limit_event",
        "rate_limit_info": {
            "status": "rejected",
            "rateLimitType": "weekly",
            "isUsingOverage": true
        }
    }))
    .unwrap();
    assert_eq!(window.id, "weekly");
    assert_eq!(window.status, "exhausted");
    assert_eq!(window.used_percent, Some(100));

    let allowed_on_overage = provider_rate_limit_from_claude_stream(&serde_json::json!({
        "type": "rate_limit_event",
        "rate_limit_info": {
            "status": "allowed",
            "rateLimitType": "five_hour",
            "isUsingOverage": true
        }
    }))
    .unwrap();
    assert_eq!(allowed_on_overage.status, "exhausted");
}

/// An idle account has no open session, so `five_hour` comes back null.
/// The plan still meters one. The level is absent until a later reading
/// names a utilization; inventing zero would show a full allowance.
#[test]
fn anthropic_idle_session_keeps_an_unmeasured_five_hour_window() {
    let windows = provider_usage_windows_from_anthropic_usage(&serde_json::json!({
        "five_hour": serde_json::Value::Null,
        "seven_day": {
            "utilization": 3.0,
            "resets_at": "2026-11-01T16:59:59.259573+00:00"
        },
        "seven_day_opus": serde_json::Value::Null
    }));
    assert_eq!(
        windows
            .iter()
            .map(|window| (window.id.as_str(), window.used_percent))
            .collect::<Vec<_>>(),
        vec![("five-hour", None), ("weekly", Some(3))]
    );
    assert!(windows[0].resets_at.is_none());
}

#[test]
fn claude_effort_arg_drops_levels_the_selected_model_rejects() {
    for model in [
        "claude-fable-5-1",
        "claude-fable-5",
        "claude-opus-5-5",
        "claude-opus-5",
        "claude-opus-4-8",
        "claude-opus-5-5-1m",
        "claude-opus-5-1m",
        "claude-opus-4-8-1m",
        "claude-sonnet-5-5",
        "claude-sonnet-5",
        "claude-haiku-5-5",
    ] {
        for effort in ["low", "medium", "high", "xhigh", "max"] {
            assert_eq!(
                claude_reasoning_effort_arg(Some(model), Some(effort)),
                Some(effort.into())
            );
        }
        assert_eq!(
            claude_reasoning_effort_arg(Some(model), Some("ultra")),
            None
        );
        assert_eq!(claude_reasoning_effort_arg(Some(model), None), None);
    }
    for effort in ["low", "medium", "high", "xhigh", "max", "ultra"] {
        assert_eq!(
            claude_reasoning_effort_arg(Some("claude-haiku-4-5"), Some(effort)),
            None
        );
    }
}

#[test]
fn claude_model_arg_selects_the_1m_window_for_1m_rows() {
    assert_eq!(
        claude_model_arg("claude-opus-5-5-1m"),
        "claude-opus-5-5[1m]"
    );
    assert_eq!(
        claude_model_arg("claude-opus-4-8-1m"),
        "claude-opus-4-8[1m]"
    );
    assert_eq!(claude_model_arg("claude-opus-5-5"), "claude-opus-5-5");
    assert_eq!(claude_model_arg("claude-sonnet-5-5"), "claude-sonnet-5-5");
    assert_eq!(claude_model_arg("my-proxy-1m"), "my-proxy-1m");
}

#[test]
fn claude_panes_are_governable_by_profile_or_binary() {
    let by_profile = TerminalPaneRequest {
        profile_id: Some("claude-code".into()),
        command: "claude".into(),
        ..Default::default()
    };
    assert_eq!(governable_pane_provider(&by_profile), Some("anthropic"));

    // A custom profile id still governs when it launches the Claude binary.
    let by_binary = TerminalPaneRequest {
        profile_id: Some("my-claude".into()),
        command: "/opt/homebrew/bin/claude".into(),
        ..Default::default()
    };
    assert_eq!(governable_pane_provider(&by_binary), Some("anthropic"));
}

#[test]
fn claude_file_tools_carry_line_counts_in_any_permission_mode() {
    let tool_use = serde_json::json!({
        "type": "assistant",
        "message": { "content": [{
            "type": "tool_use", "id": "toolu_edit", "name": "Edit",
            "input": {
                "file_path": "/Users/me/Gyro/packages/ui/src/styles.css",
                "old_string": "  padding-top: 12px;",
                "new_string": "  padding-top: 10px;"
            }
        }]}
    });
    let activities = extract_provider_activities(&tool_use);
    assert_eq!(activities[0].kind, "file");
    // Measured from the call itself, before any result or approval.
    assert_eq!(activities[0].file_counts, Some((1, 1)));

    // The result reports what was applied, including edits the CLI made
    // without Gyro's broker (bypass mode), which leave no receipt.
    let result = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": [{
            "type": "tool_result", "tool_use_id": "toolu_edit",
            "content": "The file has been updated."
        }]},
        "tool_use_result": {
            "filePath": "/Users/me/Gyro/packages/ui/src/styles.css",
            "structuredPatch": [{
                "oldStart": 1, "oldLines": 3, "newStart": 1, "newLines": 4,
                "lines": [" a", "-  padding-top: 12px;", "+  padding-top: 10px;", "+  gap: 0;", " b"]
            }]
        }
    });
    assert_eq!(
        provider_file_result_counts(&result),
        vec![("toolu_edit".to_string(), (2, 1))]
    );
    // Transcripts spell the same record in camelCase.
    let mut transcript = result.clone();
    let record = transcript
        .as_object_mut()
        .unwrap()
        .remove("tool_use_result")
        .unwrap();
    transcript["toolUseResult"] = record;
    assert_eq!(provider_file_result_counts(&transcript).len(), 1);

    // A failed or refused call applied nothing, and a Bash result is not a file.
    let mut failed = result.clone();
    failed["message"]["content"][0]["is_error"] = serde_json::json!(true);
    assert!(provider_file_result_counts(&failed).is_empty());
    let bash = serde_json::json!({
        "type": "user",
        "message": { "content": [{ "type": "tool_result", "tool_use_id": "toolu_bash" }]},
        "tool_use_result": { "stdout": "ok", "stderr": "" }
    });
    assert!(provider_file_result_counts(&bash).is_empty());
}
