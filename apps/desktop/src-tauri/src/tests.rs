use crate::{
    app::{
        config::merge_renderer_config,
        limits::{
            MAX_BROWSER_PREVIEW_CAPTURES, MAX_CHAT_ATTACHMENTS, MAX_CHAT_IMAGE_BYTES,
            MAX_CHAT_MESSAGE_CHARS, MAX_CHAT_RESPONSE_CHARS, MAX_CODEX_APP_SERVER_ACTIVITIES,
            MAX_CODEX_APP_SERVER_MESSAGE_BYTES, MAX_CODEX_APP_SERVER_PATCHES,
            MAX_CODEX_APP_SERVER_PATCH_BYTES, MAX_DESKTOP_IPC_MESSAGE_BYTES,
            MAX_LIVE_RESPONSE_CHARS, MAX_PROVIDER_STDOUT_FRAME_BYTES,
            MAX_STORED_CHAT_ATTACHMENTS_PER_SESSION, MAX_STORED_CHAT_ATTACHMENT_BYTES_PER_SESSION,
            MAX_STORED_DRAFT_ATTACHMENTS, MAX_TERMINAL_OUTPUT_BYTES, MAX_WORKSPACE_FILE_EDIT_BYTES,
            MAX_WORKSPACE_FILE_PREVIEW_BYTES, MAX_WORKSPACE_WATCH_CACHES,
            PROVIDER_CHAT_HEARTBEAT_INTERVAL,
        },
        shutdown::{remove_provider_host_ipc_socket, run_quit_jobs_until},
    },
    automation::{
        commands::automation_notification_content,
        execution::{automation_provider_prompt, parse_automation_execution_outcome},
        runtime::{
            automation_scheduler_effective_now, run_event_wakes_automation_scheduler,
            AutomationSchedulerControl,
        },
        scheduler::{
            automation_dispatch_candidates, recover_automation_scheduler_leases_with,
            run_automation_scheduler_once_at_with, run_automation_scheduler_once_with,
            run_automation_scheduler_once_with_heartbeat_interval,
        },
    },
    browser::{
        preview::{
            browser_preview_capture_dimensions, browser_preview_capture_script,
            browser_preview_diagnostics_supported, check_browser_preview_blocking,
            parse_browser_preview_diagnostics, persist_browser_preview_capture,
        },
        types::{
            BrowserObservation, BrowserObservationDiagnostics, BrowserObservationEvidence,
            BrowserObservationOwner, BrowserPreviewCheckRequest, BROWSER_OBSERVATION_FRAMING,
            BROWSER_OBSERVATION_SCHEMA_V1,
        },
    },
    browser_knowledge,
    capabilities::{
        access::{
            capability_access_for_call, capability_access_with_full_access, capability_grant_scope,
            effective_capability_class, unknown_workspace_task_message,
        },
        bridge::{
            codex_capability_tool_approval_args, codex_compact_invoke_approval_args,
            desktop_claude_permission_mcp_config, desktop_claude_permission_mcp_config_for,
            provider_run_approval_matches, ClaudePermissionBridgeIdentity,
        },
        mcp_server::{
            advertised_capability_descriptors, browser_result_image, capability_mcp_response,
            desktop_capability_tool_call, desktop_capability_tool_schema,
            desktop_permission_tool_call, write_desktop_mcp_message,
            DesktopProviderCapabilityContext, DesktopProviderPermissionContext,
        },
    },
    capability_workspace_helpers::{
        normalize_workspace_context_paths, workspace_context_metadata,
        DEFAULT_WORKSPACE_RESULT_BYTES,
    },
    context_compaction, delegated_agents,
    diagnostics::export::{terminal_command_path, user_home_directory},
    efficiency,
    git::{
        branches::git_branch_catalog_impl,
        commands::{
            git_action_error, git_checkout_branch_impl, git_command, git_commit_blocking,
            git_create_branch_impl, git_current_branch, git_discard_blocking, git_push_blocking,
            git_remove_worktree_impl, git_rename_branch_impl, git_stage_blocking,
            sort_branch_catalog_entries,
        },
        status_cache::{
            git_repo_root, git_repository_state, git_status_for_preparation, git_status_impl,
            git_status_read_failure, parse_git_numstat, parse_git_status_v2, GitRepositoryState,
        },
        types::{
            GitCheckoutBranchRequest, GitCommitRequest, GitCreateBranchRequest,
            GitRemoveWorktreeRequest, GitStageRequest, GitSyncRequest,
        },
    },
    ide::{
        debug::{debug_adapter_command_is_allowed, redact_json_strings},
        language_server,
        task_discovery::{
            custom_task_create_impl, custom_task_delete_impl, justfile_recipes, makefile_targets,
            parse_command_line, suggested_task, task_discover_impl, test_tree_from_tasks,
        },
        tasks::{configure_noninteractive_task_environment, task_run_blocking},
        types::{
            CustomTaskCreateRequest, CustomTaskDeleteRequest, DebugAdapterManager,
            DebugSendRequest, DebugStartRequest, IdeCommandOutput, TaskDefinitionResult,
            TaskRunRequest,
        },
    },
    ipc::cli::{bind_cli_ipc_listener, provider_host_ipc_paths, write_bounded_json_line},
    kimi_usage::{
        fetch_kimi_provider_usage, kimi_sign_in_at, kimi_sign_in_renewal,
        provider_usage_windows_from_kimi_usages, store_kimi_sign_in, KimiSignIn, KimiSignInRenewal,
        KIMI_NO_PLAN_LIMITS,
    },
    ollama_runner::{ollama_compatibility_catalog, validate_ollama_compatibility_call},
    provider_accounting,
    provider_activity::{
        extract_provider_activities, extract_provider_activity,
        extract_provider_commentary_activity, provider_file_result_counts,
    },
    provider_context::{
        provider_context_usage_from_app_server, provider_context_usage_from_claude_stream,
        provider_context_usage_from_codex_exec, provider_context_usage_with_window,
        provider_model_context_window, ClaudeUsageFrame, OllamaTurnUsage, ProviderContextUsage,
    },
    provider_reliability::{is_transient_provider_error, provider_failure_recovery},
    provider_timeline, provider_tool_batch,
    providers::{
        approvals::{
            claude_multimodal_input, desktop_claude_approval_details,
            desktop_claude_approval_response, provider_approval_label, provider_approval_risk,
        },
        binding::{
            bind_provider_chat_request, local_conversation_history_for_request,
            provider_approval_instructions, validate_chat_context,
        },
        chat_types::{
            normal_chat_requests_plan, ChatAttachmentRequest, ChatMode, InternalRequestPurpose,
            PrepareChatAttachmentRequest, ProviderChatRequest, SessionGoalContext,
        },
        cli_args::{
            claude_allowed_capability_tools, claude_chat_args, claude_model_arg,
            claude_reasoning_effort_arg, codex_chat_args, codex_model_arg,
            codex_reasoning_effort_arg, grok_reasoning_effort_arg, provider_chat_cwd,
        },
        codex_app_server::{
            codex_app_server_closed_message, codex_app_server_result, read_bounded_protocol_line,
            spawn_codex_app_server_reader,
        },
        events::{
            append_provider_status_event, kimi_acp_plan_payload, provider_activity_event_entry,
        },
        markers::{
            completed_chat_artifacts, completed_plan_updates, completed_stream_title,
            derive_session_summary, extract_chat_artifact_marker, extract_plan_update_marker,
            extract_session_title_marker, repair_glued_assistant_blocks,
            streamed_title_replacement, strip_hidden_control_markers, suggested_title_for_turn,
            valid_chat_artifact, GYRO_AGENT_UPDATE_MARKER, GYRO_GOAL_UPDATE_MARKER,
            MAX_CHAT_ARTIFACTS,
        },
        process::{
            build_grok_acp_program_args, command_with_gui_path, is_stale_resume_error,
            provider_adapter_for, provider_stream_failure_detail,
        },
        prompt::{
            claude_chat_prompt, openai_codex_chat_prompt, provider_context_message,
            provider_context_message_for_turn, provider_context_message_with_capabilities,
            provider_context_message_with_tool_support, user_requests_gyro_browser, PromptTurn,
        },
        retry::{is_provider_cancellation, with_browser_attachment_images},
        retry_recovery::run_provider_chat_with_retry_using,
        runners::{
            claude::{claude_login_failure, claude_runner_output, CLAUDE_LOGIN_EXPIRED_DETAIL},
            codex::{
                codex_app_server_policy, codex_file_change_activities, codex_item_activity,
                codex_provider_approval_response, codex_reasoning_activity,
                insert_codex_app_server_patch, CodexAppServerCommentaryStream,
            },
            kimi_acp::{
                acp_provider_runtime, apply_acp_workspace_write,
                compatible_provider_session_binding, provider_resume_cursor_from_binding,
            },
        },
        stdout::{
            extract_provider_session_id, extract_provider_text_delta, merge_provider_rate_limit,
            provider_activities_for_response, provider_rate_limit_from_claude_stream,
            recover_streamed_provider_answer,
        },
        streaming::{
            provider_quiet_seconds, provider_run_failure, provider_run_stalled, ProviderQuietClock,
            StreamingCommandOutput, StreamingCommandState, PROVIDER_CHAT_QUIET_NOTICE,
        },
        types::{
            ProviderActivity, ProviderAdapterKind, ProviderChatStreamEvent, ProviderResumeCursor,
            ProviderRunnerOutput,
        },
    },
    sessions::{
        attachments::{
            ensure_attachment_storage_quota, ensure_private_attachment_directory,
            make_room_in_draft_attachments, prepare_chat_attachment_blocking,
            redact_terminal_output, validate_attachment_name, validated_chat_media_type,
        },
        commands::{remove_attachment_storage_entry, stage_session_attachments},
        titles::{
            is_generic_session_title, session_title_from_message,
            SESSION_TITLE_FIRST_TURN_INSTRUCTION,
        },
    },
    state::{
        provider_run::{
            BoundProviderCapabilityContext, ProviderApprovalDecision, ProviderRunControl,
            ProviderStopReason, PROVIDER_CUT_OFF_NOTICE, PROVIDER_TOOL_BUDGET_NOTICE,
        },
        workspace::{WorkspaceRescanState, WorkspaceWatchManager},
    },
    terminal::{
        governance::governable_pane_provider,
        panes::terminal_current_directory,
        types::{
            PaneGovernance, TerminalPaneRequest, TerminalPaneSnapshot, TerminalProcessManager,
        },
    },
    terminal_process::{
        append_terminal_output, configure_terminal_environment, resolve_terminal_cwd,
        snapshot_terminal_output, TerminalOutputBuffer,
    },
    text::{
        push_bounded, sanitize_provider_chat_response, sanitize_provider_text_delta,
        truncate_chars, validate_chat_message, BoundedPushResult,
    },
    usage::{
        fetch::{
            claude_oauth_access_token_at, fetch_anthropic_provider_usage,
            get_provider_usage_blocking, provider_usage_windows_from_anthropic_usage,
            provider_usage_windows_from_codex, provider_usage_windows_from_xai_billing,
        },
        types::{CodexRateLimitSnapshot, CodexRateLimitWindow},
    },
    workspace::{
        files::{
            read_workspace_file_impl, read_workspace_file_with_limit, workspace_root,
            write_workspace_file_impl,
        },
        tree::{
            compare_workspace_tree_entries, list_workspace_tree_blocking,
            workspace_watch_event_is_relevant,
        },
        types::{
            WorkspaceFile, WorkspaceFileWriteRequest, WorkspaceSearchRange, WorkspaceSearchResult,
        },
    },
    workspace_search::{bound_model_search_results, run_workspace_rg_search},
};
use base64::Engine;
use gyro_core::{
    create_worktree,
    ipc::{
        DesktopProviderApprovalBehavior, DesktopProviderApprovalRequest,
        DesktopProviderApprovalResponse, DESKTOP_PROVIDER_APPROVAL_IPC_SCHEMA_V1,
    },
    provider_account_label, provider_runtime_status_from_output, provider_subscription_label,
    should_skip_codex_login_for_external_env, user_cli_paths, Automation, AutomationRunStatus,
    AutomationStatus, AutomationStore, CapabilityAccess, CapabilityClass, CapabilityId,
    CapabilityPolicySnapshot, CapabilityRequest, CapabilityResponse, CapabilityResult,
    CapabilityRunMode, CapabilityStatus, CreateAutomationRequest, CreateSessionContext, GyroConfig,
    GyroPaths, HarnessRunStatus, ProjectCapabilityGrant, ProjectCapabilityPolicy,
    ProviderSessionBinding, Session, SessionEventKind, SessionOrigin, SessionStore,
    SessionWorkspaceMode, WorkspaceCheckReport, WorkspaceContextSnapshot, CAPABILITY_DESCRIPTORS,
    WORKSPACE_UNAVAILABLE_MESSAGE,
};
use notify::Event as NotifyEvent;
use portable_pty::CommandBuilder;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use uuid::Uuid;

fn anthropic_provider_request() -> ProviderChatRequest {
    ProviderChatRequest {
        session_id: Uuid::new_v4().to_string(),
        message: "edit it".into(),
        turn_id: Some(Uuid::new_v4().to_string()),
        provider_id: "anthropic".into(),
        provider_label: Some("Anthropic".into()),
        model_id: Some("sonnet".into()),
        model_label: Some("Claude Sonnet".into()),
        reasoning_effort: None,
        require_command_approval: true,
        require_file_edit_approval: true,
        full_access: false,
        suggest_title: false,
        workspace_path: Some("/tmp/gyro-workspace".into()),
        mode: ChatMode::Normal,
        goal: None,
        plan: None,
        attachments: Vec::new(),
        workspace_context: None,
        workspace_check: None,
        side_chat_context: None,
        internal_purpose: None,
    }
}

fn bound_capability_context(request: &ProviderChatRequest) -> BoundProviderCapabilityContext {
    let workspace_key = request.workspace_path.clone().unwrap();
    let policy = ProjectCapabilityPolicy::defaults(workspace_key.clone());
    let workspace_context = WorkspaceContextSnapshot::empty(workspace_key.clone());
    BoundProviderCapabilityContext {
        session_id: request.session_id.clone(),
        turn_id: request.turn_id.clone(),
        provider_id: request.provider_id.clone(),
        provider_kind: None,
        workspace: PathBuf::from(&workspace_key),
        workspace_identity_revision: 1,
        allow_delegation: delegated_agents::request_allows_delegation(request),
        policy: CapabilityPolicySnapshot::from_policy(&policy, CapabilityRunMode::Normal),
        workspace_context,
        workspace_check: WorkspaceCheckReport::placeholder(workspace_key.clone()),
        workspace_key,
    }
}

/// Every argument vector Gyro can build, across providers and permission
/// branches, paired with the provider that would run it.
///
/// Both builders take many flags whose combinations select different
/// branches, and only some of those branches end in a variadic option. This
/// enumerates them so a new branch cannot quietly reintroduce an argument
/// shape the CLI would misread.
fn every_provider_chat_arg_vector() -> Vec<(&'static str, String, Vec<String>)> {
    let output_path = PathBuf::from("/tmp/gyro-last-message.txt");
    let image = ChatAttachmentRequest {
        id: "image-1".into(),
        kind: "image".into(),
        name: "shot.png".into(),
        path: "/tmp/shot.png".into(),
        relative_path: None,
        mime_type: Some("image/png".into()),
        size: 128,
        content_hash: None,
        modified_at: None,
        preview_url: None,
    };
    let session = "019f4612-7e58-7412-9fe9-5f0d6cb29c8e";
    let mut vectors = Vec::new();

    for (label, mode, require_command, require_edit, full_access, resume) in [
        ("plan", ChatMode::Plan, false, false, false, false),
        ("gated", ChatMode::Normal, true, true, false, false),
        ("full-access", ChatMode::Normal, false, false, true, false),
        ("resumed", ChatMode::Normal, false, false, true, true),
    ] {
        vectors.push((
            "anthropic",
            format!("claude/{label}"),
            claude_chat_args(
                resume.then_some(session),
                session,
                Some("claude-sonnet-5"),
                Some("high"),
                &mode,
                require_command,
                require_edit,
                full_access,
                Some("{\"mcpServers\":{}}"),
                "reply with ok",
            ),
        ));
        vectors.push((
            "openai",
            format!("codex/{label}"),
            codex_chat_args(
                resume.then_some(session),
                &output_path,
                Some("gpt-5.6-sol"),
                Some("medium"),
                &mode,
                require_command,
                require_edit,
                full_access,
                // Attachments matter here: `codex --image <FILE>...` is the
                // other variadic option in the codebase.
                std::slice::from_ref(&image),
                "reply with ok",
            ),
        ));
    }

    // ACP agents receive the prompt over stdio, but Gyro still chooses the
    // flags that start them, and those can drift just as easily.
    for provider_id in ["kimi", "xai", "gemini", "cursor", "opencode"] {
        let runtime = acp_provider_runtime(provider_id).expect("acp runtime");
        vectors.push((
            provider_id,
            format!("{}/launch", runtime.program),
            runtime.args.iter().map(|arg| (*arg).to_string()).collect(),
        ));
    }
    for posture in [
        gyro_core::ApprovalPosture::Ask,
        gyro_core::ApprovalPosture::ApproveForMe,
        gyro_core::ApprovalPosture::FullAccess,
    ] {
        let name = match posture {
            gyro_core::ApprovalPosture::Ask => "ask",
            gyro_core::ApprovalPosture::ApproveForMe => "approve",
            gyro_core::ApprovalPosture::FullAccess => "full",
        };
        vectors.push((
            "xai",
            format!("grok/{name}"),
            build_grok_acp_program_args(Some("grok-4.7"), Some("high"), posture)
                .iter()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect(),
        ));
        for provider_id in ["kimi", "gemini", "cursor", "opencode", "antigravity"] {
            let Some(args) = gyro_core::acp_permission_args(provider_id, posture) else {
                continue;
            };
            vectors.push((
                provider_id,
                format!("{provider_id}/{name}"),
                args.iter().map(|arg| (*arg).to_string()).collect(),
            ));
        }
    }
    vectors
}

fn provider_chat_request_for(
    session: &Session,
    workspace: &Path,
    provider_id: &str,
) -> ProviderChatRequest {
    ProviderChatRequest {
        session_id: session.id.to_string(),
        message: "explain this repo".into(),
        turn_id: Some(Uuid::new_v4().to_string()),
        provider_id: provider_id.into(),
        provider_label: Some("Anthropic".into()),
        model_id: Some("claude-opus-5".into()),
        model_label: Some("Opus 5".into()),
        reasoning_effort: None,
        require_command_approval: false,
        require_file_edit_approval: false,
        full_access: true,
        suggest_title: false,
        workspace_path: Some(workspace.display().to_string()),
        mode: ChatMode::Normal,
        goal: None,
        plan: None,
        attachments: Vec::new(),
        workspace_context: None,
        workspace_check: None,
        side_chat_context: None,
        internal_purpose: None,
    }
}

fn create_due_stop_condition_automation(paths: &GyroPaths) -> Automation {
    AutomationStore::open(paths.clone())
        .unwrap()
        .create_automation(CreateAutomationRequest {
            title: "Stop-condition smoke".into(),
            prompt: "Run checks".into(),
            schedule: gyro_core::AutomationSchedule::Hourly,
            project: "Gyro".into(),
            provider: "Codex".into(),
            branch: "main".into(),
            workspace_mode: SessionWorkspaceMode::Local,
            worktree_name: None,
            stop_condition: Some("All checks pass".into()),
            next_run_at: Some(chrono::Utc::now() - chrono::Duration::minutes(1)),
            execution: gyro_core::AutomationExecutionContext::default(),
        })
        .unwrap()
}

/// Sparse, so tests can reach the byte budget without writing a gigabyte.
fn sized_attachment(path: &Path, bytes: u64) {
    std::fs::File::create(path).unwrap().set_len(bytes).unwrap();
}

fn age_attachment(path: &Path, seconds_old: u64) {
    std::fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(seconds_old))
        .unwrap();
}

// A file count below these would again end a chat long before its bytes run
// out, and a draft folder this small would evict images from a full message.
const _: () = assert!(
    MAX_STORED_CHAT_ATTACHMENTS_PER_SESSION as u64 * MAX_CHAT_IMAGE_BYTES
        > MAX_STORED_CHAT_ATTACHMENT_BYTES_PER_SESSION
);
const _: () = assert!(MAX_STORED_DRAFT_ATTACHMENTS > MAX_CHAT_ATTACHMENTS);

fn wait_for_terminal_output(
    manager: &TerminalProcessManager,
    pane_id: &str,
    expected: &str,
) -> TerminalPaneSnapshot {
    for _ in 0..20 {
        let snapshot = manager.read(pane_id, None).unwrap();
        if snapshot
            .output
            .as_deref()
            .unwrap_or_default()
            .contains(expected)
            && snapshot.status != "running"
        {
            return snapshot;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    manager.read(pane_id, None).unwrap()
}

fn init_git_repo(repo: &Path) {
    run_git(repo, &["init", "-b", "main"]);
    run_git(repo, &["config", "user.name", "Gyro Test"]);
    run_git(repo, &["config", "user.email", "gyro@example.test"]);
}

fn run_git(repo: &Path, args: &[&str]) {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
}

#[path = "providers/runners/codex_tests.rs"]
mod providers_runners_codex_tests;

#[path = "providers/runners/compatibility_tests.rs"]
mod providers_runners_compatibility_tests;

#[path = "providers/runners/kimi_acp_tests.rs"]
mod providers_runners_kimi_acp_tests;

#[path = "providers/tests.rs"]
mod providers_tests;

#[path = "workspace/tests.rs"]
mod workspace_tests;

#[path = "capabilities/tests.rs"]
mod capabilities_tests;

#[path = "providers/runners/antigravity_tests.rs"]
mod providers_runners_antigravity_tests;

#[path = "providers/runners/claude_tests.rs"]
mod providers_runners_claude_tests;

#[path = "sessions/tests.rs"]
mod sessions_tests;

#[path = "browser/tests.rs"]
mod browser_tests;

#[path = "terminal/tests.rs"]
mod terminal_tests;

#[path = "sessions/attachments_tests.rs"]
mod sessions_attachments_tests;

#[path = "usage/tests.rs"]
mod usage_tests;

#[path = "ide/tests.rs"]
mod ide_tests;

#[path = "git/tests.rs"]
mod git_tests;

#[path = "sessions/titles_tests.rs"]
mod sessions_titles_tests;

#[path = "app/tests.rs"]
mod app_tests;
