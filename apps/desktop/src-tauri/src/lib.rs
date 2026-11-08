mod agent_session_worker;
mod app;
mod automation;
#[cfg(test)]
mod backend_performance_tests;
mod browser;
mod canvas_preview;
mod capabilities;
mod chat_images;
mod chat_media_upload;
mod council;
mod diagnostics;
mod git;
mod ide;
mod providers;
mod sessions;
mod state;
mod terminal;
mod text;
mod usage;
mod workspace;
// @moved-reexports-start
use app::{
    config::load_config_blocking,
    limits::{
        BROWSER_PREVIEW_CAPTURE_TIMEOUT, BROWSER_PREVIEW_DIAGNOSTIC_TIMEOUT,
        DESKTOP_IPC_IO_TIMEOUT, DESKTOP_IPC_QUEUE_CAPACITY, DESKTOP_IPC_WORKER_COUNT,
        GIT_STATUS_PREPARATION_TIMEOUT, GIT_STATUS_TIMEOUT, MAX_BROWSER_PREVIEW_CAPTURES,
        MAX_BROWSER_PREVIEW_CAPTURE_BYTES, MAX_BROWSER_PREVIEW_DIAGNOSTICS,
        MAX_BROWSER_PREVIEW_DIAGNOSTIC_CHARS, MAX_BROWSER_PREVIEW_DIAGNOSTIC_PAYLOAD_CHARS,
        MAX_CHAT_ATTACHMENTS, MAX_CHAT_IMAGE_BYTES, MAX_CHAT_RESPONSE_CHARS, MAX_CHAT_VIDEO_BYTES,
        MAX_CONCURRENT_BROWSER_PREVIEWS, MAX_CONCURRENT_IDE_COMMANDS, MAX_CONCURRENT_PROVIDER_RUNS,
        MAX_CONCURRENT_SCHEDULED_RUNS, MAX_DAP_OUTPUT_EVENT_BYTES, MAX_DEBUG_ADAPTER_PROCESSES,
        MAX_DESKTOP_IPC_MESSAGE_BYTES, MAX_DESKTOP_SESSION_EVENTS_READ, MAX_GIT_STATUS_CACHES,
        MAX_IDE_PROTOCOL_MESSAGES_PER_RESPONSE, MAX_IDE_PROTOCOL_RESPONSE_BYTES,
        MAX_PERMISSION_MCP_MESSAGE_BYTES, MAX_TERMINAL_OUTPUT_BYTES, MAX_TERMINAL_PROCESSES,
        MAX_WORKSPACE_FILE_EDIT_BYTES, MAX_WORKSPACE_SEARCH_FALLBACK_BYTES,
        PROVIDER_APPROVAL_EVENT, PROVIDER_APPROVAL_NOTIFICATION_OPEN_EVENT,
        PROVIDER_CAPABILITY_EVENT, PROVIDER_CHAT_EVENT, TEXT_TRUNCATION_SUFFIX,
    },
};
#[cfg(test)]
use app::{
    config::merge_renderer_config,
    limits::{
        MAX_CHAT_MESSAGE_CHARS, MAX_CODEX_APP_SERVER_ACTIVITIES,
        MAX_CODEX_APP_SERVER_MESSAGE_BYTES, MAX_CODEX_APP_SERVER_PATCHES,
        MAX_CODEX_APP_SERVER_PATCH_BYTES, MAX_LIVE_RESPONSE_CHARS, MAX_PROVIDER_STDOUT_FRAME_BYTES,
        MAX_STORED_CHAT_ATTACHMENTS_PER_SESSION, MAX_STORED_CHAT_ATTACHMENT_BYTES_PER_SESSION,
        MAX_STORED_DRAFT_ATTACHMENTS, MAX_WORKSPACE_FILE_PREVIEW_BYTES, MAX_WORKSPACE_WATCH_CACHES,
        PROVIDER_CHAT_HEARTBEAT_INTERVAL,
    },
};
use browser::{
    preview::persist_browser_preview_capture,
    types::{
        BrowserPreviewCapture, BrowserPreviewCaptureRequest, BrowserPreviewCheck,
        BrowserPreviewCheckRequest, BrowserPreviewDiagnostic, BROWSER_OBSERVATION_FRAMING,
        BROWSER_OBSERVATION_SCHEMA_V1,
    },
};
#[cfg(test)]
use browser::{
    preview::{
        browser_preview_capture_dimensions, browser_preview_capture_script,
        browser_preview_diagnostics_supported, check_browser_preview_blocking,
        parse_browser_preview_diagnostics,
    },
    types::{
        BrowserObservation, BrowserObservationDiagnostics, BrowserObservationEvidence,
        BrowserObservationOwner,
    },
};
use capabilities::{
    access::{
        browser_observation, capability_argument_string, capability_argument_u64,
        capability_argument_usize, capability_full_access_enabled, capability_positive_position,
        narrower_capability_access, remember_model_browser_resource,
        require_model_browser_resource,
    },
    approval::capability_event,
    bridge::{
        active_provider_approval_nonce, active_provider_capability_context,
        capability_acp_mcp_server, codex_capability_mcp_config_args,
        desktop_claude_permission_mcp_config, desktop_claude_permission_mcp_config_for,
        provider_run_approval_matches, ClaudePermissionBridgeIdentity,
    },
    execute::handle_desktop_provider_capability_request,
    mcp_server::{
        advertised_capability_descriptors, browser_result_image, desktop_capability_tool_schema,
        mark_browser_image_attached, run_provider_capability_server,
        run_provider_permission_server, write_desktop_mcp_message,
    },
};
#[cfg(test)]
use capabilities::{
    access::{
        capability_access_for_call, capability_access_with_full_access, capability_grant_scope,
        effective_capability_class, unknown_workspace_task_message,
    },
    bridge::{codex_capability_tool_approval_args, codex_compact_invoke_approval_args},
    mcp_server::{
        capability_mcp_response, desktop_capability_tool_call, desktop_permission_tool_call,
        DesktopProviderCapabilityContext, DesktopProviderPermissionContext,
    },
};
use diagnostics::export::{terminal_command_path, user_home_directory};
#[cfg(test)]
use git::commands::{
    git_action_error, git_checkout_branch_impl, git_commit_blocking, git_create_branch_impl,
    git_discard_blocking, git_push_blocking, git_remove_worktree_impl, git_rename_branch_impl,
    git_stage_blocking,
};
use git::{
    commands::{git_command, git_current_branch, sort_branch_catalog_entries},
    types::{
        GitBranchCatalog, GitBranchTip, GitCheckoutBranchRequest, GitCommitRequest,
        GitCreateBranchRequest, GitLinkedWorktree, GitPathRequest, GitRemoveWorktreeRequest,
        GitStageRequest, GitSyncRequest, GitSyncResult, GithubCreatePullRequestRequest,
        GithubPullRequestsRequest, GithubWorkflowRunRequest, GithubWorkflowRunsRequest,
        GithubWorkspaceRequest, MainComparisonStats, SourceControlFile, SourceControlStatus,
    },
};
#[cfg(test)]
use git_branch_service::git_branch_catalog_before;
#[cfg(test)]
use gyro_core::{
    create_worktree, ipc::DesktopProviderApprovalBehavior, CapabilityResult,
    ProjectCapabilityGrant, SessionWorkspaceMode, WorkspaceCheckReport,
    WORKSPACE_UNAVAILABLE_MESSAGE,
};
#[cfg(test)]
use ide::{
    debug::debug_adapter_command_is_allowed,
    task_discovery::{
        justfile_recipes, makefile_targets, parse_command_line, suggested_task,
        test_tree_from_tasks,
    },
    tasks::{configure_noninteractive_task_environment, task_run_blocking},
};
use ide::{
    debug::{add_ide_protocol_message_bytes, redact_json_strings},
    task_discovery::{
        content_hash, custom_task_create_impl, custom_task_delete_impl, default_custom_task_group,
        task_discover_impl, test_discover_impl,
    },
    types::{
        CustomTaskCreateRequest, CustomTaskDeleteRequest, CustomTaskFile, CustomTaskRecord,
        DebugAdapterManager, DebugAdapterProcess, DebugSendRequest, DebugSessionResult,
        DebugStartRequest, IdeCommandOutput, TaskCancelRequest, TaskDefinitionResult,
        TaskRunRequest, TestRunRequest, TestTreeItemResult,
    },
};
#[cfg(test)]
use provider_retry_recovery::run_provider_chat_with_retry_using;
#[cfg(not(unix))]
use providers::process::{configure_provider_process_group, terminate_provider_process_group};
use providers::{
    approvals::handle_desktop_provider_approval_request,
    binding::{
        advertised_mcp_capability_tools, bind_provider_capability_context,
        capability_run_mode_for_chat, local_conversation_history_for_request,
        session_execution_workspace,
    },
    chat_types::{
        normal_chat_requests_plan, ChatAttachmentRequest, ChatMode, InternalRequestPurpose,
        PrepareChatAttachmentRequest, PreparedChatAttachment, ProviderChatRequest,
        ProviderChatResponse, SessionGoalContext,
    },
    codex_app_server::{
        codex_app_server_result, read_bounded_protocol_line, receive_codex_app_server_response,
        receive_codex_app_server_response_until, spawn_codex_app_server_reader,
        write_codex_app_server_message,
    },
    commands::{run_goal_chat, run_provider_chat},
    events::{
        append_provider_diagnostics_event, append_provider_status_event,
        emit_provider_activity_event, emit_provider_chat_event, emit_provider_context_usage,
        kimi_acp_plan_payload, next_provider_event_sequence, provider_activity_event_entry,
        provider_chat_status_message, provider_turn_has_unfinished_attempt,
    },
    health::check_provider_health_blocking,
    markers::{
        completed_chat_artifacts, completed_plan_updates, derive_session_summary,
        publish_streamed_session_title, sanitize_session_title_candidate,
        strip_hidden_control_markers, suggested_title_for_turn, take_visible_stream_text,
        ChatArtifactExtraction, SessionTitleExtraction, GYRO_AGENT_UPDATE_MARKER,
        GYRO_SESSION_TITLE_MARKER,
    },
    process::{
        command_for_provider, command_with_gui_path, is_stale_resume_error, provider_adapter_for,
        provider_output_summary,
    },
    prompt::{provider_context_message_with_capabilities, user_requests_gyro_browser},
    retry::{
        is_provider_cancellation, persist_failed_provider_attempt, run_provider_chat_once,
        run_provider_chat_with_retry, wait_before_provider_retry, with_browser_attachment_images,
    },
    run::{run_provider_chat_blocking, run_provider_chat_blocking_in_lease},
    runners::{
        antigravity::run_antigravity_chat,
        claude::run_anthropic_claude_chat,
        codex::{run_openai_codex_chat, run_openai_codex_context_compaction},
        kimi_acp::{
            acp_auth_methods, acp_provider_runtime, compatible_provider_session_binding,
            provider_resume_cursor_from_binding, run_kimi_acp_chat,
        },
    },
    stdout::{
        command_activity_label, extract_codex_agent_message_text, humanize_activity_name,
        json_object_string, json_string_or_joined, provider_activities_for_response,
        provider_activity_path, provider_tool_activity_note,
    },
    streaming::{
        provider_chat_cancelled, provider_stop_message, spawn_provider_chat_heartbeat,
        PROVIDER_CHAT_INACTIVITY_TIMEOUT_SECS,
    },
    types::{
        ProviderActivity, ProviderAdapterDescriptor, ProviderAdapterKind, ProviderResumeCursor,
        ProviderRunAttempt, ProviderRunnerOutput,
    },
};
#[cfg(test)]
use providers::{
    approvals::{
        claude_multimodal_input, desktop_claude_approval_details, desktop_claude_approval_response,
        provider_approval_label, provider_approval_risk,
    },
    binding::{bind_provider_chat_request, provider_approval_instructions, validate_chat_context},
    cli_args::{
        claude_allowed_capability_tools, claude_chat_args, claude_model_arg,
        claude_reasoning_effort_arg, codex_chat_args, codex_model_arg, codex_reasoning_effort_arg,
        grok_reasoning_effort_arg, provider_chat_cwd,
    },
    codex_app_server::codex_app_server_closed_message,
    markers::{
        completed_stream_title, extract_chat_artifact_marker, extract_plan_update_marker,
        extract_session_title_marker, repair_glued_assistant_blocks, streamed_title_replacement,
        valid_chat_artifact, GYRO_GOAL_UPDATE_MARKER, MAX_CHAT_ARTIFACTS,
    },
    process::{build_grok_acp_program_args, provider_stream_failure_detail},
    prompt::{
        claude_chat_prompt, openai_codex_chat_prompt, provider_context_message,
        provider_context_message_for_turn, provider_context_message_with_capabilities_for_turn,
        provider_context_message_with_tool_support, PromptTurn,
    },
    runners::{
        claude::{claude_login_failure, claude_runner_output, CLAUDE_LOGIN_EXPIRED_DETAIL},
        codex::{
            codex_app_server_policy, codex_file_change_activities, codex_item_activity,
            codex_provider_approval_response, codex_reasoning_activity,
            insert_codex_app_server_patch, CodexAppServerCommentaryStream,
        },
        kimi_acp::apply_acp_workspace_write,
    },
    stdout::{
        claude_rate_limit_used_percent, extract_provider_session_id, extract_provider_text_delta,
        merge_provider_rate_limit, provider_rate_limit_from_claude_stream,
        recover_streamed_provider_answer,
    },
    streaming::{
        provider_quiet_seconds, provider_run_failure, provider_run_stalled, ProviderQuietClock,
        StreamingCommandOutput, StreamingCommandState, PROVIDER_CHAT_QUIET_NOTICE,
    },
    types::ProviderChatStreamEvent,
};
use sessions::{
    attachments::{
        ensure_attachment_storage_quota, ensure_private_attachment_directory,
        prepare_chat_attachment_blocking, validated_chat_media_type, write_private_attachment,
    },
    commands::attachment_session_lock,
    titles::{is_generic_session_title, SESSION_TITLE_FIRST_TURN_INSTRUCTION},
};
#[cfg(test)]
use sessions::{
    attachments::{
        make_room_in_draft_attachments, redact_terminal_output, validate_attachment_name,
    },
    commands::{remove_attachment_storage_entry, stage_session_attachments},
    titles::session_title_from_message,
};
use state::{
    managers::{
        active_task_runs, cancel_task_run, with_ide_evidence, BrowserPreviewAdmission,
        CapabilityIdeEvidenceManager, HiddenWebviewGuard, IdeCommandAdmission,
        ProviderApprovalManager, ProviderCancellationManager, ProviderCapabilityApprovalManager,
        ProviderCapabilityBroker, ProviderCapabilityResourceManager, TaskRunHandle,
    },
    provider_run::{
        stop_provider_run, BoundProviderCapabilityContext, ModelBrowserResource,
        ModelTerminalResource, PendingCapabilityApproval, PendingProviderApproval,
        ProviderApprovalContext, ProviderApprovalNotificationOpen, ProviderRunControl,
        ProviderStopReason, PROVIDER_INTERRUPTED_MARKER, PROVIDER_STALL_MARKER,
        PROVIDER_STOP_MARKER,
    },
    workspace::{WorkspacePreparationManager, WorkspaceWatchManager},
};
#[cfg(test)]
use state::{
    provider_run::{
        ProviderApprovalDecision, PROVIDER_CUT_OFF_NOTICE, PROVIDER_TOOL_BUDGET_NOTICE,
    },
    workspace::WorkspaceRescanState,
};
#[cfg(test)]
use std::{io::BufRead, sync::atomic::AtomicUsize};
#[cfg(test)]
use terminal::{governance::governable_pane_provider, panes::terminal_current_directory};
use terminal::{
    governance::{release_pane_governance, resolve_pane_governance},
    types::{PaneGovernance, TerminalPaneRequest, TerminalPaneSnapshot, TerminalProcessManager},
};
use text::{
    chat_message_preview, sanitize_provider_text_delta, truncate_chars, truncate_error_detail,
    validate_chat_message,
};
#[cfg(test)]
use text::{push_bounded, sanitize_provider_chat_response, BoundedPushResult};
#[cfg(test)]
use usage::{
    fetch::{
        claude_oauth_access_token_at, fetch_anthropic_provider_usage, get_provider_usage_blocking,
        provider_usage_windows_from_anthropic_usage, provider_usage_windows_from_codex,
        provider_usage_windows_from_xai_billing, usage_refresh_fallback,
    },
    types::{CodexRateLimitSnapshot, CodexRateLimitWindow},
};
use usage::{
    fetch::{plan_window_identity, plan_window_status, remember_provider_rate_limits_in},
    guard::{usage_guard_block, UsageContext},
    types::{ProviderRateLimitWindow, ProviderUsageSnapshot},
};
use workspace::{
    files::{
        assert_workspace_entry, assert_workspace_path, atomic_write_workspace_file,
        read_bounded_regular_file, read_workspace_file_with_limit, validated_workspace_file_target,
        workspace_root,
    },
    paths::{
        absolute_workspace_path, apply_path_history_action, create_workspace_path_impl,
        delete_workspace_path_impl, duplicate_workspace_path_impl, emit_workspace_path_change,
        path_history_change, rename_workspace_path_impl, same_workspace_folder,
        WorkspacePathChange,
    },
    tree::list_workspace_tree_blocking,
    types::{
        FileMutationDecisionRequest, FileMutationDecisionResult, FileMutationProposalRequest,
        WorkspaceFile, WorkspaceFileContent, WorkspacePathCreateRequest,
        WorkspacePathDeleteRequest, WorkspacePathDuplicateRequest, WorkspacePathRenameRequest,
        WorkspacePreparationSnapshot, WorkspaceSearchRange, WorkspaceSearchResult,
    },
};
#[cfg(test)]
use workspace::{
    files::{read_workspace_file_impl, write_workspace_file_impl},
    paths::{copy_entry, move_entry_into_trash, remove_entry, unique_trash_destination},
    tree::{
        compare_workspace_tree_entries, scan_workspace_tree, workspace_watch_event_is_relevant,
    },
    types::WorkspaceFileWriteRequest,
};
#[cfg(test)]
use workspace_search::{bound_model_search_results, run_workspace_rg_search};
// @moved-reexports-end
use chat_media_upload::prepare_chat_media_upload;
mod agent_reports;
mod cloud_connection;
mod conversation_history;
mod efficiency;
mod git_branch_service;
mod git_read;
use git_branch_service::git_branch_catalog_impl;
mod ide_evidence;
mod live_model_context;
mod local_check;
mod model_catalog;
mod provider_accounting;
mod provider_activity;
mod provider_spend_guard;
use provider_accounting::*;
use provider_activity::*;
mod codex_images;
mod codex_startup;
mod codex_turn_completion;
mod context_compaction;
mod provider_mcp;
mod provider_reliability;
mod provider_retry_recovery;
mod provider_run_cleanup;
mod provider_session_lifecycle;
use provider_session_lifecycle::{reconcile_interrupted_provider_turns, ProviderSessionLease};
mod code_mode;
#[cfg(debug_assertions)]
mod code_mode_smoke;
mod provider_tool_batch;
use provider_reliability::{is_transient_provider_error, provider_failure_recovery};
mod ollama_runner;
mod openai_compatible_runner;
use ollama_runner::*;
mod capability_output_budget;
mod capability_workspace_helpers;
mod workspace_context_capability;
use capability_workspace_helpers::*;
mod capability_execution_guard;
mod command_execution;
use command_execution::*;
#[cfg(target_os = "macos")]
mod desktop_shortcuts;
mod provider_api_keys;
mod provider_install;
mod window_controls;
#[cfg(target_os = "macos")]
pub(crate) use window_controls::apply_macos_traffic_light_position;
mod claude_usage_cli;
#[cfg(debug_assertions)]
mod efficiency_benchmark;
mod goal_runner;
mod kimi_usage;
#[cfg(debug_assertions)]
mod performance_benchmark;
mod session_goal;
mod session_model;
mod session_title_stream;
use session_model::set_session_model;
mod project_import;
mod project_import_continuation;
mod session_history;
mod turn_timing;
mod usage_poll;
use gyro_core::timing::{self};
use kimi_usage::*;
mod app_preview;
mod browser_knowledge;
mod browser_pointer;
#[cfg(all(debug_assertions, feature = "native-browser-shell-review"))]
mod browser_shell_review;
mod capability_inspection;
mod file_patch_counts;
mod workspace_roots;
mod workspace_search;
mod workspace_tree_order;

use anyhow::Context;
use automation::commands::{
    automation_notification_content, cancel_scheduled_automation, emit_automation_update,
    run_automation_blocking, set_automation_status_blocking,
};
#[cfg(test)]
use automation::execution::{automation_provider_prompt, parse_automation_execution_outcome};
#[cfg(test)]
use automation::runtime::automation_scheduler_effective_now;
use automation::runtime::{run_event_wakes_automation_scheduler, AutomationSchedulerControl};
use automation::scheduler::start_automation_scheduler;
#[cfg(test)]
use automation::scheduler::{
    automation_dispatch_candidates, recover_automation_scheduler_leases_with,
    run_automation_scheduler_once_at_with, run_automation_scheduler_once_with,
    run_automation_scheduler_once_with_heartbeat_interval,
};
use base64::Engine as _;
use gyro_core::augmented_gui_path;
#[cfg(test)]
use gyro_core::user_cli_paths;
use gyro_core::{
    decide_mutation_proposal,
    ipc::{
        acknowledgement_for, versions_compatible, AppNotification, AutomateAction, AutomateRequest,
        AutomateResponse, AutomateSummary, DesktopProviderApprovalRequest,
        DesktopProviderApprovalResponse, AUTOMATE_IPC_SCHEMA_V1,
        DESKTOP_PROVIDER_APPROVAL_IPC_SCHEMA_V1,
    },
    mutation_approval_payload, openai_compat_endpoint, openai_compat_host_is_loopback,
    provider_accepts_images, provider_api_key_env_name, provider_descriptor,
    recover_provider_mutation_transactions, AppNotificationKind, Automation, AutomationStatus,
    AutomationStore, CancellationToken, CapabilityAccess, CapabilityApprovalDecision,
    CapabilityClass, CapabilityId, CapabilityInvocationContext, CapabilityPolicySnapshot,
    CapabilityRequest, CapabilityResourceRef, CapabilityResponse, CapabilityRunMode,
    CapabilityStatus, CreateSessionContext, CredentialPolicy, ExecutionRequest, ExecutionStream,
    ExecutionTermination, GyroConfig, GyroPaths, HarnessRunStatus, MutationDecision,
    MutationProposal, OllamaToolChatRequest, OpenAiCompatChatRequest, ProjectCapabilityPolicy,
    ProviderCapabilitySupport, ProviderSessionBinding, Session, SessionEvent, SessionEventKind,
    SessionOrigin, SessionStore, UsageEntry, UsageOrigin, UsageOutcome, UsageTokens,
    WorkspaceContextSnapshot, CAPABILITY_DESCRIPTORS, OLLAMA_CANCELLED_MESSAGE,
    OPENAI_COMPAT_CANCELLED_MESSAGE, PROVIDER_CAPABILITY_IPC_SCHEMA_V1,
};
#[cfg(test)]
use gyro_core::{AutomationRunStatus, CreateAutomationRequest};
#[cfg(test)]
use notify::Event as NotifyEvent;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc, Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant, SystemTime};
use tauri::{Emitter, Manager};
use uuid::Uuid;

#[cfg(all(debug_assertions, feature = "native-browser-events-smoke"))]
mod browser_frontend_smoke;
#[cfg(debug_assertions)]
mod browser_smoke;
mod git_history_capability;
mod git_line_counts;
mod git_main_comparison;
#[cfg(test)]
mod gyro_cloud;
pub(crate) use git_main_comparison::git_main_comparison_base;
mod git_status_cache;
use git_status_cache::*;
mod delegated_agents;
mod desktop_notifications;
mod language_server;
mod launch_integrity;
mod lsp_capability;
#[cfg(debug_assertions)]
mod lsp_smoke;
mod memory_capability;
mod menu_bar;
mod provider_timeline;
mod quit_confirmation;
mod reply_segments;
mod subagent_capability;
mod web_fetch_capability;
use reply_segments::StreamedText;
mod browser_viewport;
mod provider_context;
mod provider_identity;
mod session_browser;
use provider_context::*;
use provider_identity::provider_model_identity;
mod commit_suggestion;
mod dictation_access;
mod source_control_review;
mod system_access;
mod task_suggestions;
mod terminal_capability;
mod terminal_process;
mod terminal_wait;
mod workspace_capability_list;
mod workspace_capability_read;
mod workspace_edit_capability;
mod workspace_mutations;
mod workspace_open_capability;
mod workspace_path_capability;
mod workspace_path_history;
#[cfg(test)]
use workspace_mutations::create_file_mutation_proposal_in_store;

#[cfg(test)]
use gyro_core::{
    provider_account_label, provider_runtime_status_from_output, provider_subscription_label,
    should_skip_codex_login_for_external_env,
};

pub fn run_entrypoint() {
    if std::env::args().nth(1).as_deref() == Some("provider-permission-server") {
        if let Err(error) = run_provider_permission_server() {
            eprintln!(
                "Gyro desktop permission bridge failed: {}",
                gyro_core::sanitize_harness_text(&error.to_string())
            );
            std::process::exit(1);
        }
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("provider-capability-server") {
        if let Err(error) = run_provider_capability_server() {
            eprintln!(
                "Gyro provider capability bridge failed: {}",
                gyro_core::sanitize_capability_summary(&error.to_string())
            );
            std::process::exit(1);
        }
        return;
    }
    run();
}

pub fn run() {
    let mut context = tauri::generate_context!();
    // Native material is visible only through the tinted navigation chrome.
    // Keep other platforms and auxiliary windows on their existing backgrounds.
    #[cfg(target_os = "macos")]
    for window in &mut context.config_mut().app.windows {
        if window.label == "main" {
            window.transparent = true;
            window.background_color = Some(tauri::utils::config::Color(0, 0, 0, 0));
            window.window_effects = Some(tauri::utils::config::WindowEffectsConfig {
                effects: vec![tauri::window::Effect::Sidebar],
                state: Some(tauri::window::EffectState::FollowsWindowActiveState),
                ..Default::default()
            });
        }
    }
    #[cfg(debug_assertions)]
    if std::env::var_os("GYRO_TEST_DATA_DIR").is_some()
        && std::env::var_os("GYRO_TEST_PERSIST_UI").as_deref() != Some(std::ffi::OsStr::new("1"))
    {
        for window in &mut context.config_mut().app.windows {
            window.incognito = true;
        }
    }
    #[cfg(debug_assertions)]
    if std::env::var_os("GYRO_CODE_MODE_SMOKE").is_some() {
        context.config_mut().app.windows.clear();
    }
    #[cfg(debug_assertions)]
    if std::env::var("GYRO_LOCAL_PROVIDER_FIXTURE").as_deref() == Ok("1") {
        // Isolated native browser integration uses a hidden, empty parent webview.
        context.config_mut().app.windows.clear();
        let mut window = tauri::utils::config::WindowConfig::default();
        window.label = "main".into();
        window.url = tauri::WebviewUrl::External("about:blank".parse().expect("static blank URL"));
        window.visible = false;
        window.incognito = true;
        context.config_mut().app.windows.push(window);
    }
    #[cfg(all(debug_assertions, feature = "native-browser-events-smoke"))]
    if std::env::var("GYRO_BROWSER_FRONTEND_SMOKE").as_deref() == Ok("1") {
        context.config_mut().app.windows.clear();
        context.config_mut().identifier = "dev.gyro.browser-events-smoke".into();
        context.config_mut().product_name = Some("Gyro native browser event check".into());
    }
    let builder = session_browser::register_bridge_protocol(tauri::Builder::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());
    // macOS notices use desktop_notifications' native permission/delivery
    // path. The plugin's unused Web Notification shim probes an IPC permission
    // that these webviews intentionally do not have, causing an unhandled
    // rejection at startup (and in embedded browser pages).
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_notification::init());
    let app = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(TerminalProcessManager::default())
        .manage(language_server::LanguageServerManager::default())
        .manage(DebugAdapterManager::default())
        .manage(ProviderCancellationManager::default())
        .manage(local_check::LocalCheckManager::default())
        .manage(cloud_connection::CloudConnection::default())
        .manage(project_import::ProjectImportManager::default())
        .manage(delegated_agents::AgentManager::default())
        .manage(ProviderApprovalManager::default())
        .manage(ProviderCapabilityApprovalManager::default())
        .manage(ProviderCapabilityBroker)
        .manage(ProviderCapabilityResourceManager::default())
        .manage(CapabilityIdeEvidenceManager::default())
        .manage(WorkspaceWatchManager::default())
        .manage(WorkspacePreparationManager::default())
        .manage(AutomationSchedulerControl::default())
        .manage(session_browser::SessionBrowserManager::default())
        .manage(app_preview::ManagerState::default())
        .manage(menu_bar::MenuBarController::default())
        .manage(quit_confirmation::QuitConfirmation::default())
        .setup(|app| {
            #[cfg(all(debug_assertions, feature = "native-browser-events-smoke"))]
            if browser_frontend_smoke::start(app.handle())? {
                return Ok(());
            }
            #[cfg(debug_assertions)]
            if code_mode_smoke::start(app.handle())? {
                return Ok(());
            }
            #[cfg(debug_assertions)]
            if performance_benchmark::start(app.handle())? {
                return Ok(());
            }
            #[cfg(debug_assertions)]
            if browser_smoke::start(app.handle())? {
                return Ok(());
            }
            #[cfg(debug_assertions)]
            if lsp_smoke::start(app.handle())? {
                return Ok(());
            }
            menu_bar::setup(app)?;
            #[cfg(target_os = "macos")]
            desktop_shortcuts::setup(app.handle())?;
            #[cfg(target_os = "macos")]
            restore_main_window(app.handle())?;
            // Store recovery runs before any command can start a turn, but a
            // locked or damaged store must not stop the app from opening: the
            // warm-up report and later store calls surface the failure instead.
            // Index maintenance is left to `warm_desktop_shell`, off this thread.
            match GyroPaths::for_current_user()
                .and_then(|paths| Ok((SessionStore::open(paths.clone())?, paths)))
            {
                Ok((store, paths)) => {
                    let journals = &paths.mutation_journals_dir;
                    if let Err(error) = recover_provider_mutation_transactions(journals, &store) {
                        eprintln!("could not recover provider file edits: {error}");
                    }
                    // A session whose turn cannot be closed still takes a new turn.
                    match reconcile_interrupted_provider_turns(&store) {
                        Ok(0) => {}
                        Ok(closed) => {
                            eprintln!("closed {closed} turn(s) interrupted by an earlier exit")
                        }
                        Err(error) => eprintln!("could not reconcile interrupted turns: {error}"),
                    }
                    drop(SessionStoreLease { store: Some(store) });
                }
                Err(error) => eprintln!("could not open the session store at launch: {error}"),
            }
            start_cli_ipc_listener(app.handle().clone());
            start_automation_scheduler(app.handle().clone());
            agent_session_worker::start(app.handle().clone());
            goal_runner::recover(app.handle().clone());
            #[cfg(all(debug_assertions, feature = "native-browser-shell-review"))]
            browser_shell_review::start(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            menu_bar::handle_window_event(window, event);
            #[cfg(target_os = "macos")]
            if window.label() == "main"
                && matches!(
                    event,
                    tauri::WindowEvent::Resized(_)
                        | tauri::WindowEvent::ScaleFactorChanged { .. }
                        | tauri::WindowEvent::ThemeChanged(_)
                )
            {
                if let Some(main) = window.app_handle().get_webview_window("main") {
                    apply_macos_traffic_light_position(&main);
                }
            }
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Err(error) = window.hide() {
                    eprintln!("could not hide Gyro window: {error}");
                }
            }
        })
        .register_uri_scheme_protocol("gyro-canvas", |_context, request| {
            canvas_preview::response(request)
        })
        .invoke_handler(tauri::generate_handler![
            local_check::prepare_local_check,
            cloud_connection::cloud_connection_view,
            cloud_connection::cloud_connection_action,
            cloud_connection::cloud_connection_begin,
            cloud_connection::cloud_connection_verify,
            cloud_connection::cloud_connection_service,
            local_check::resolve_local_check,
            local_check::cancel_local_check,
            local_check::list_local_checks,
            local_check::delete_local_check,
            efficiency::set_efficiency_config,
            efficiency::get_efficiency_task_totals,
            efficiency::route_efficiency_phase,
            quit_confirmation::get_quit_confirmation,
            quit_confirmation::resolve_quit_confirmation,
            project_import::get_project_import_sources,
            project_import::scan_project_imports,
            project_import::start_project_import,
            project_import::get_project_import_job,
            project_import::cancel_project_import,
            project_import::relocate_imported_project,
            project_import::continue_import_in_new_session,
            project_import_continuation::get_imported_chat_state,
            turn_timing::timing_diagnostics_enabled,
            turn_timing::record_frontend_timing,
            turn_timing::record_surface_timing,
            delegated_agents::list_subagents,
            delegated_agents::stop_subagent,
            sessions::events::append_chat_context_event,
            sessions::events::append_editor_event,
            sessions::events::append_plan_event,
            sessions::commands::append_user_message,
            sessions::commands::set_session_workspace_identity,
            automation::commands::claim_due_automation,
            providers::health::check_provider_auth,
            browser::preview::check_browser_preview,
            providers::health::check_provider_health,
            provider_install::install_provider_cli,
            provider_api_keys::provider_api_key_status,
            provider_api_keys::set_provider_api_key,
            provider_api_keys::clear_provider_api_key,
            provider_api_keys::list_custom_provider_models,
            providers::health::check_cli_updates_command,
            providers::health::apply_cli_updates_command,
            providers::health::provider_cli_install_plan_command,
            system_access::check_system_access,
            system_access::open_system_access_settings,
            dictation_access::request_dictation_access,
            dictation_access::start_dictation,
            dictation_access::stop_dictation,
            browser::preview::capture_browser_preview,
            app_preview::app_preview_request,
            browser::preview::capture_session_browser_preview,
            session_browser::session_browser_open,
            session_browser::session_browser_set_bounds,
            session_browser::session_browser_set_viewport,
            session_browser::session_browser_set_visible,
            session_browser::session_browser_navigate,
            session_browser::session_browser_reload,
            session_browser::session_browser_history,
            session_browser::session_browser_close,
            session_browser::session_browser_snapshot,
            automation::commands::complete_automation_lease,
            terminal::panes::close_terminal_pane,
            automation::commands::create_automation,
            automation::commands::edit_automation,
            sessions::commands::create_desktop_session,
            workspace::files::create_file_mutation_proposal,
            terminal::panes::create_terminal_pane,
            workspace::paths::create_workspace_file,
            sessions::commands::create_worktree_session,
            ide::debug::debug_send,
            ide::debug::debug_start,
            ide::debug::debug_stop,
            providers::health::discover_ollama_models_command,
            providers::health::discover_google_models_command,
            sessions::commands::delete_session,
            workspace::paths::delete_workspace_path,
            workspace::paths::duplicate_workspace_path,
            workspace::paths::peek_workspace_path_undo,
            workspace::paths::undo_workspace_path,
            workspace::paths::redo_workspace_path,
            diagnostics::export::export_diagnostics,
            app::config::get_account_session,
            app::commands::get_notification_permission,
            menu_bar::get_menu_bar_snapshot,
            capabilities::commands::get_project_capability_policy,
            capabilities::commands::get_provider_capability_support,
            capabilities::commands::list_provider_capability_support,
            model_catalog::fetch_model_catalog,
            model_catalog::install_model_catalog,
            live_model_context::refresh_model_context_windows,
            usage::fetch::get_provider_usage,
            usage::fetch::get_session_usage_totals,
            usage::commands::get_usage_safety_snapshot,
            usage::commands::get_provider_usage_ledger,
            usage::commands::set_usage_paused,
            usage::commands::set_provider_budget,
            context_compaction::set_auto_compact_percent,
            git::commands::git_commit,
            git::commands::git_branches,
            git::commands::git_checkout_branch,
            git::commands::git_rename_branch,
            git::commands::git_create_branch,
            git::commands::git_remove_worktree,
            git::commands::git_diff,
            source_control_review::git_review_content,
            git::commands::git_discard,
            git::commands::git_fetch,
            git::commands::git_pull,
            git::commands::git_push,
            git::commands::git_stage,
            git::commands::git_status,
            git::commands::git_unstage,
            git::github::github_create_pull_request,
            git::github::github_pull_requests,
            git::github::github_rerun_workflow,
            git::github::github_status,
            git::github::github_workflow_logs,
            git::github::github_workflow_run_detail,
            git::github::github_workflow_runs,
            automation::commands::list_automations,
            terminal::panes::list_active_capability_resources,
            automation::commands::list_due_automations,
            sessions::commands::list_sessions,
            task_suggestions::list_start_task_suggestions,
            workspace::tree::list_workspace_files,
            workspace::tree::list_workspace_tree,
            workspace_roots::inspect_workspace_folders,
            app::config::load_config,
            app::config::warm_desktop_shell,
            app::config::logout_account,
            language_server::lsp_request,
            language_server::lsp_start,
            language_server::lsp_stop,
            workspace::files::read_workspace_file,
            workspace::files::read_workspace_file_full,
            terminal::panes::read_terminal_output,
            sessions::commands::read_session_events,
            sessions::attachments::prepare_chat_attachment,
            sessions::attachments::read_cited_chat_image,
            sessions::attachments::resolve_cited_chat_image,
            prepare_chat_media_upload,
            sessions::attachments::prepare_browser_attachment,
            workspace::preparation::prepare_workspace,
            app::commands::restart_app,
            app::commands::updater_platform_key,
            menu_bar::hide_menu_bar_popover,
            automation::commands::recover_automation_leases,
            sessions::commands::rename_session,
            workspace::paths::rename_workspace_path,
            app::config::refresh_account_session,
            terminal::panes::resize_terminal_pane,
            terminal::panes::terminal_pane_working_directory,
            workspace::files::resolve_file_mutation_proposal,
            providers::approvals::resolve_provider_approval,
            capabilities::execute::resolve_capability_approval,
            sessions::review::record_file_review_decision,
            terminal::panes::restart_terminal_pane,
            terminal::panes::restore_terminal_panes,
            automation::commands::run_automation,
            council::commands::read_council_artifact,
            council::commands::retry_council_synthesis,
            council::commands::run_council_chat,
            providers::commands::run_provider_chat,
            providers::commands::compact_provider_chat,
            app::config::save_config,
            capabilities::commands::save_project_capability_policy,
            workspace::paths::search_workspace,
            set_session_model,
            menu_bar::set_menu_bar_snapshot,
            menu_bar::set_menu_bar_visible,
            git::commands::set_session_branch,
            automation::commands::set_automation_status,
            workspace::files::stat_workspace_file,
            workspace::files::classify_dropped_path,
            providers::change_summary::summarize_file_changes,
            app::config::start_account_login,
            terminal::panes::stop_terminal_pane,
            terminal::panes::stop_model_terminal_resource,
            providers::commands::stop_provider_chat,
            menu_bar::open_menu_bar_target,
            menu_bar::show_main_window,
            terminal::panes::terminal_pane_has_foreground_job,
            ide::tasks::task_discover,
            ide::tasks::task_create_custom,
            ide::tasks::task_delete_custom,
            ide::tasks::task_cancel,
            ide::tasks::task_run,
            ide::tasks::test_discover,
            app::commands::test_notification,
            ide::tasks::test_run,
            automation::commands::triage_automation,
            capabilities::commands::update_capability_ide_evidence,
            workspace::paths::watch_workspace,
            workspace::files::write_workspace_file,
            terminal::panes::write_terminal_input
        ])
        .build(context)
        .expect("error while building Gyro");

    app.run(|app, event| {
        #[cfg(debug_assertions)]
        if std::env::var_os("GYRO_CODE_MODE_SMOKE").is_some() {
            if let tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } = &event
            {
                api.prevent_exit();
                return;
            }
            #[cfg(target_os = "macos")]
            if matches!(&event, tauri::RunEvent::Reopen { .. }) {
                return;
            }
        }
        if let tauri::RunEvent::ExitRequested { code, api, .. } = &event {
            if quit_confirmation::defer_exit(app, *code, api) {
                return;
            }
        }
        if run_event_wakes_automation_scheduler(&event) {
            app.state::<AutomationSchedulerControl>().wake();
        }
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            drain_backend_resources_on_quit(app);
        }
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen {
            has_visible_windows,
            ..
        } = &event
        {
            if !*has_visible_windows {
                if let Err(error) = restore_main_window(app) {
                    eprintln!("could not reopen Gyro window: {error}");
                }
            }
        }
    });
}

/// Whole-quit budget. Quit runs on the main thread, so no single wedged
/// language server, debug adapter or PTY may hold it longer than this.
const QUIT_DRAIN_DEADLINE: Duration = Duration::from_secs(2);
static QUIT_DRAINED: AtomicBool = AtomicBool::new(false);

fn drain_backend_resources_on_quit(app: &tauri::AppHandle) {
    // Best-effort drain on true quit. Window hide on macOS is intentional and
    // must keep the automation scheduler and terminals alive. ExitRequested and
    // Exit both land here; drain once so quit spends one deadline, not two.
    if QUIT_DRAINED.swap(true, Ordering::SeqCst) {
        return;
    }
    let deadline = Instant::now() + QUIT_DRAIN_DEADLINE;
    if let Ok(mut flags) = app.state::<ProviderCancellationManager>().flags.lock() {
        for control in flags.values() {
            control.cancellation.cancel();
        }
        flags.clear();
    }
    // Cancelled task runs kill their own commands; the wait below lets them.
    if let Ok(runs) = active_task_runs().lock() {
        runs.values().for_each(CancellationToken::cancel);
    }
    app.state::<AutomationSchedulerControl>().wake();
    let mut jobs: Vec<Box<dyn FnOnce() + Send>> = Vec::new();
    // Provider CLIs and task commands run in their own process groups and get
    // no SIGHUP from the app exiting; the process exits right after this drain,
    // before a cancelled runner could reap them itself.
    jobs.push(Box::new(|| {
        gyro_core::terminate_live_process_groups(QUIT_DRAIN_DEADLINE / 2)
    }));
    for pane in app.state::<TerminalProcessManager>().take_all() {
        jobs.push(Box::new(move || {
            terminal_process::terminate_terminal_pane(&pane)
        }));
    }
    let language_servers = app
        .state::<language_server::LanguageServerManager>()
        .inner()
        .clone();
    for server_id in language_servers.server_ids() {
        let manager = language_servers.clone();
        jobs.push(Box::new(move || drop(manager.stop(&server_id))));
    }
    let debug_adapters = app.state::<DebugAdapterManager>().inner().clone();
    let debug_session_ids = debug_adapters
        .processes
        .lock()
        .map(|processes| processes.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    for session_id in debug_session_ids {
        let manager = debug_adapters.clone();
        jobs.push(Box::new(move || drop(manager.stop(&session_id))));
    }
    run_quit_jobs_until(jobs, deadline);
    while Instant::now() < deadline && active_task_runs().lock().is_ok_and(|runs| !runs.is_empty())
    {
        std::thread::sleep(Duration::from_millis(20));
    }
    if let Ok(paths) = GyroPaths::for_current_user() {
        remove_provider_host_ipc_socket(paths, std::process::id());
    }
}

/// Runs each shutdown on its own thread and returns by `deadline` even if some
/// never finish; the process is exiting, so stragglers die with it.
fn run_quit_jobs_until(jobs: Vec<Box<dyn FnOnce() + Send>>, deadline: Instant) {
    let (done, finished) = mpsc::channel::<()>();
    let pending = jobs.len();
    for job in jobs {
        let done = done.clone();
        let _ = std::thread::Builder::new()
            .name("gyro-quit-drain".into())
            .spawn(move || {
                job();
                let _ = done.send(());
            });
    }
    drop(done);
    for _ in 0..pending {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if finished.recv_timeout(remaining).is_err() {
            break;
        }
    }
}

/// The per-PID provider socket belongs to this process alone; the public CLI
/// socket may be taken over by another instance and is left alone.
fn remove_provider_host_ipc_socket(paths: GyroPaths, host_pid: u32) {
    #[cfg(unix)]
    if let Ok(paths) = provider_host_ipc_paths(paths, host_pid) {
        use std::os::unix::fs::FileTypeExt;
        if fs::symlink_metadata(&paths.socket_path).is_ok_and(|meta| meta.file_type().is_socket()) {
            let _ = fs::remove_file(&paths.socket_path);
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn restore_main_window(app: &tauri::AppHandle) -> anyhow::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        apply_macos_traffic_light_position(&window);
        window.unminimize()?;
        window.show()?;
        window.set_focus()?;
        return Ok(());
    }

    let config = app
        .config()
        .app
        .windows
        .first()
        .context("Gyro has no configured main window")?;
    let window = tauri::WebviewWindowBuilder::from_config(app, config)?.build()?;
    apply_macos_traffic_light_position(&window);
    window.show()?;
    window.set_focus()?;
    Ok(())
}

/// Process-local SQLite connection pools. Concurrent commands borrow a handle
/// and return it on drop. Extra connections beyond capacity are discarded so
/// the pool stays small (one DB file, several WAL readers/writers).
const SESSION_STORE_POOL_CAPACITY: usize = 8;
const AUTOMATION_STORE_POOL_CAPACITY: usize = 2;
static SESSION_STORE_POOL: Mutex<Vec<SessionStore>> = Mutex::new(Vec::new());
static AUTOMATION_STORE_POOL: Mutex<Vec<AutomationStore>> = Mutex::new(Vec::new());

struct SessionStoreLease {
    store: Option<SessionStore>,
}

impl std::ops::Deref for SessionStoreLease {
    type Target = SessionStore;

    fn deref(&self) -> &Self::Target {
        self.store.as_ref().expect("session store lease is active")
    }
}

impl AsRef<SessionStore> for SessionStoreLease {
    fn as_ref(&self) -> &SessionStore {
        self.store.as_ref().expect("session store lease is active")
    }
}

impl Drop for SessionStoreLease {
    fn drop(&mut self) {
        if let Some(store) = self.store.take() {
            if let Ok(mut pool) = SESSION_STORE_POOL.lock() {
                if pool.len() < SESSION_STORE_POOL_CAPACITY {
                    pool.push(store);
                }
            }
        }
    }
}

struct AutomationStoreLease {
    store: Option<AutomationStore>,
}

impl std::ops::Deref for AutomationStoreLease {
    type Target = AutomationStore;

    fn deref(&self) -> &Self::Target {
        self.store
            .as_ref()
            .expect("automation store lease is active")
    }
}

impl AsRef<AutomationStore> for AutomationStoreLease {
    fn as_ref(&self) -> &AutomationStore {
        self.store
            .as_ref()
            .expect("automation store lease is active")
    }
}

impl Drop for AutomationStoreLease {
    fn drop(&mut self) {
        if let Some(store) = self.store.take() {
            if let Ok(mut pool) = AUTOMATION_STORE_POOL.lock() {
                if pool.len() < AUTOMATION_STORE_POOL_CAPACITY {
                    pool.push(store);
                }
            }
        }
    }
}

fn open_store() -> Result<SessionStoreLease, String> {
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    if let Ok(mut pool) = SESSION_STORE_POOL.lock() {
        if let Some(store) = pool.pop() {
            return Ok(SessionStoreLease { store: Some(store) });
        }
    }
    let store = SessionStore::open(paths).map_err(to_string)?;
    Ok(SessionStoreLease { store: Some(store) })
}

fn open_automation_store() -> Result<AutomationStoreLease, String> {
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    if let Ok(mut pool) = AUTOMATION_STORE_POOL.lock() {
        if let Some(store) = pool.pop() {
            return Ok(AutomationStoreLease { store: Some(store) });
        }
    }
    let store = AutomationStore::open(paths).map_err(to_string)?;
    Ok(AutomationStoreLease { store: Some(store) })
}

/// Prefill idle pooled connections so the first user actions after warm-up do
/// not pay SQLite open + schema ensure latency.
fn warm_store_pools(paths: &GyroPaths) -> Result<(usize, usize), String> {
    // Connections open outside the pool locks, so store calls made during
    // warm-up never queue behind it. Maintenance already ran on the caller's
    // connection and is database-wide, so pooled connections skip it.
    let idle = SESSION_STORE_POOL.lock().map_or(0, |pool| pool.len());
    let sessions = (idle..SESSION_STORE_POOL_CAPACITY)
        .map(|_| SessionStore::open(paths.clone()).map_err(to_string))
        .collect::<Result<Vec<_>, _>>()?;
    let session_warmed = sessions.len();
    for store in sessions {
        drop(SessionStoreLease { store: Some(store) });
    }
    let idle = AUTOMATION_STORE_POOL.lock().map_or(0, |pool| pool.len());
    let automations = (idle..AUTOMATION_STORE_POOL_CAPACITY)
        .map(|_| AutomationStore::open(paths.clone()).map_err(to_string))
        .collect::<Result<Vec<_>, _>>()?;
    let automation_warmed = automations.len();
    for store in automations {
        drop(AutomationStoreLease { store: Some(store) });
    }
    Ok((session_warmed, automation_warmed))
}

fn parse_uuid(value: &str) -> Result<Uuid, String> {
    Uuid::parse_str(value).map_err(to_string)
}

fn to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn provider_host_ipc_paths(mut paths: GyroPaths, host_pid: u32) -> anyhow::Result<GyroPaths> {
    anyhow::ensure!(host_pid != 0, "invalid Gyro provider host process");
    paths.socket_path = paths.base_dir.join(format!("gyro-{host_pid}.sock"));
    Ok(paths)
}

fn desktop_provider_ipc_paths() -> anyhow::Result<GyroPaths> {
    let paths = GyroPaths::for_current_user()?;
    match std::env::var("GYRO_PROVIDER_HOST_PID") {
        Ok(host_pid) => provider_host_ipc_paths(
            paths,
            host_pid
                .parse()
                .context("invalid Gyro provider host process")?,
        ),
        // Older installed apps still use the public endpoint. An explicit
        // host must never fall back to a different running desktop instance.
        Err(std::env::VarError::NotPresent) => Ok(paths),
        Err(error) => Err(error).context("invalid Gyro provider host process"),
    }
}

fn start_cli_ipc_listener(app: tauri::AppHandle) {
    let paths = match GyroPaths::for_current_user() {
        Ok(paths) => paths,
        Err(error) => {
            eprintln!("could not start Gyro IPC listener: {error}");
            return;
        }
    };

    // The public CLI socket can belong to another desktop instance. Provider
    // helpers must reach the instance that owns their chat and active run.
    let provider_paths = provider_host_ipc_paths(paths.clone(), std::process::id())
        .expect("the current process has a nonzero id");
    start_ipc_listener_at(app.clone(), provider_paths);
    start_ipc_listener_at(app, paths);
}

fn start_ipc_listener_at(app: tauri::AppHandle, paths: GyroPaths) {
    std::thread::spawn(move || {
        #[cfg(unix)]
        {
            if let Err(error) = paths.ensure() {
                eprintln!("could not create Gyro IPC directory: {error}");
                return;
            }
            let listener = match bind_cli_ipc_listener(&paths) {
                Ok(Some(listener)) => listener,
                Ok(None) => {
                    eprintln!("Gyro IPC listener is already active");
                    return;
                }
                Err(error) => {
                    eprintln!("could not bind Gyro IPC socket: {error}");
                    return;
                }
            };

            let (sender, receiver) = mpsc::sync_channel(DESKTOP_IPC_QUEUE_CAPACITY);
            let receiver = Arc::new(Mutex::new(receiver));
            for _ in 0..DESKTOP_IPC_WORKER_COUNT {
                let app = app.clone();
                let receiver = Arc::clone(&receiver);
                std::thread::spawn(move || loop {
                    let stream = match receiver.lock() {
                        Ok(receiver) => receiver.recv(),
                        Err(_) => return,
                    };
                    match stream {
                        Ok(stream) => handle_cli_ipc_connection(&app, stream),
                        Err(_) => return,
                    }
                });
            }

            for stream in listener.incoming() {
                let Ok(stream) = stream else {
                    continue;
                };
                if sender.try_send(stream).is_err() {
                    eprintln!("Gyro IPC queue is full; rejecting a connection");
                }
            }
        }
    });
}

#[cfg(unix)]
fn bind_cli_ipc_listener(
    paths: &GyroPaths,
) -> anyhow::Result<Option<std::os::unix::net::UnixListener>> {
    use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
    use std::os::unix::net::{UnixListener, UnixStream};

    // Only retry endpoint races a bounded number of times. A failed request
    // is never replayed here; these probes happen before a listener is bound.
    for _ in 0..3 {
        let listener = match UnixListener::bind(&paths.socket_path) {
            Ok(listener) => listener,
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
                let before = match fs::symlink_metadata(&paths.socket_path) {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error).context("inspect existing Gyro IPC socket"),
                };
                if before.file_type().is_symlink() || !before.file_type().is_socket() {
                    anyhow::bail!(
                        "Gyro IPC path is not a safe Unix socket: {}",
                        paths.socket_path.display()
                    );
                }
                match UnixStream::connect(&paths.socket_path) {
                    Ok(_) => return Ok(None),
                    Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => {
                        // Permission failures and transient resource exhaustion do
                        // not prove the owner exited. Never unlink a live bridge.
                        return Err(error).with_context(|| {
                            format!(
                                "probe existing Gyro IPC socket {}",
                                paths.socket_path.display()
                            )
                        });
                    }
                }
                let after = match fs::symlink_metadata(&paths.socket_path) {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error).context("reinspect existing Gyro IPC socket"),
                };
                if before.dev() != after.dev()
                    || before.ino() != after.ino()
                    || after.file_type().is_symlink()
                    || !after.file_type().is_socket()
                {
                    anyhow::bail!("Gyro IPC socket changed while checking whether it was stale");
                }
                match fs::remove_file(&paths.socket_path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error).context("remove stale Gyro IPC socket"),
                }
                continue;
            }
            Err(error) => {
                return Err(error).with_context(|| format!("bind {}", paths.socket_path.display()))
            }
        };
        fs::set_permissions(&paths.socket_path, fs::Permissions::from_mode(0o600))?;
        return Ok(Some(listener));
    }
    anyhow::bail!(
        "Gyro IPC socket kept changing while binding {}",
        paths.socket_path.display()
    )
}

fn automate_enum_label(value: &impl serde::Serialize) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".into())
}

fn automate_summary(automation: &Automation) -> AutomateSummary {
    AutomateSummary {
        id: automation.id.to_string(),
        title: automation.title.clone(),
        schedule: automate_enum_label(&automation.schedule),
        status: automate_enum_label(&automation.status),
        last_run_at: automation.last_run_at.map(|time| time.to_rfc3339()),
    }
}

/// Resume only continues a paused automation. A completed or current run stays
/// as it is, so resume cannot flip a finished automation back to Current.
fn refuse_unpaused_automation_resume(status: AutomationStatus) -> Result<(), String> {
    if status == AutomationStatus::Paused {
        return Ok(());
    }
    Err(format!(
        "Only a paused automation can be resumed. This one is {}.",
        automate_enum_label(&status)
    ))
}

#[cfg(test)]
mod automate_resume_guard_tests {
    use super::refuse_unpaused_automation_resume;
    use gyro_core::AutomationStatus;

    #[test]
    fn resume_refuses_completed_and_current_automations() {
        assert!(refuse_unpaused_automation_resume(AutomationStatus::Paused).is_ok());
        let completed = refuse_unpaused_automation_resume(AutomationStatus::Completed).unwrap_err();
        assert!(
            completed.contains("Only a paused automation can be resumed"),
            "{completed}"
        );
        assert!(completed.contains("completed"), "{completed}");
        let current = refuse_unpaused_automation_resume(AutomationStatus::Current).unwrap_err();
        assert!(current.contains("current"), "{current}");
    }
}

/// Queue or pause in the running app. This does not start a provider turn;
/// the desktop scheduler still owns execution and the existing approval policy.
fn handle_automate_ipc(app: &tauri::AppHandle, request: AutomateRequest) -> AutomateResponse {
    let app_version = env!("CARGO_PKG_VERSION");
    if request.schema != AUTOMATE_IPC_SCHEMA_V1
        || !versions_compatible(&request.sender_version, app_version)
    {
        return AutomateResponse {
            schema: AUTOMATE_IPC_SCHEMA_V1.into(),
            app_version: app_version.into(),
            compatible: false,
            status: "incompatible".into(),
            message: format!(
                "Gyro CLI {} is not compatible with Gyro.app {app_version}",
                request.sender_version
            ),
            automations: Vec::new(),
        };
    }
    let parsed_id = match (&request.action, request.automation_id.as_deref()) {
        (AutomateAction::List, _) => None,
        (_, Some(id)) => match uuid::Uuid::parse_str(id.trim()) {
            Ok(id) => Some(id),
            Err(_) => {
                return AutomateResponse::error(app_version, "automation id must be a UUID");
            }
        },
        (_, None) => {
            return AutomateResponse::error(app_version, "automation id is required");
        }
    };
    let outcome = (|| -> Result<(String, Vec<AutomateSummary>), String> {
        match request.action {
            AutomateAction::List => {
                let store = open_automation_store()?;
                let automations = store.list_automations().map_err(to_string)?;
                let shown = automations.iter().take(200).map(automate_summary).collect();
                Ok(("Listed automations.".into(), shown))
            }
            AutomateAction::Run => {
                let id = parsed_id.ok_or_else(|| "automation id is required".to_string())?;
                let automation = run_automation_blocking(id.to_string())?;
                emit_automation_update(app, &automation);
                app.state::<AutomationSchedulerControl>().wake();
                Ok((
                    format!("Queued {}.", automation.title),
                    vec![automate_summary(&automation)],
                ))
            }
            AutomateAction::Pause => {
                let id = parsed_id.ok_or_else(|| "automation id is required".to_string())?;
                let automation =
                    set_automation_status_blocking(id.to_string(), AutomationStatus::Paused)?;
                cancel_scheduled_automation(app, id);
                emit_automation_update(app, &automation);
                app.state::<AutomationSchedulerControl>().wake();
                Ok((
                    format!("Paused {}.", automation.title),
                    vec![automate_summary(&automation)],
                ))
            }
            AutomateAction::Resume => {
                let id = parsed_id.ok_or_else(|| "automation id is required".to_string())?;
                let current = open_automation_store()?
                    .get_automation(id)
                    .map_err(to_string)?
                    .ok_or_else(|| "automation not found".to_string())?;
                refuse_unpaused_automation_resume(current.status)?;
                let automation =
                    set_automation_status_blocking(id.to_string(), AutomationStatus::Current)?;
                emit_automation_update(app, &automation);
                app.state::<AutomationSchedulerControl>().wake();
                Ok((
                    format!("Resumed {}.", automation.title),
                    vec![automate_summary(&automation)],
                ))
            }
        }
    })();
    match outcome {
        Ok((message, automations)) => AutomateResponse {
            schema: AUTOMATE_IPC_SCHEMA_V1.into(),
            app_version: app_version.into(),
            compatible: true,
            status: "ok".into(),
            message,
            automations,
        },
        Err(error) => AutomateResponse::error(app_version, error),
    }
}

#[cfg(unix)]
fn handle_cli_ipc_connection(app: &tauri::AppHandle, stream: std::os::unix::net::UnixStream) {
    let _ = stream.set_read_timeout(Some(DESKTOP_IPC_IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(DESKTOP_IPC_IO_TIMEOUT));
    let mut reader = BufReader::new(stream);
    let Ok(Some(frame)) = read_bounded_protocol_line(&mut reader, MAX_DESKTOP_IPC_MESSAGE_BYTES)
    else {
        return;
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&frame) else {
        return;
    };
    if value.get("schema").and_then(serde_json::Value::as_str) == Some(AUTOMATE_IPC_SCHEMA_V1) {
        let response = match serde_json::from_value::<AutomateRequest>(value) {
            Ok(request) => handle_automate_ipc(app, request),
            Err(error) => AutomateResponse::error(
                env!("CARGO_PKG_VERSION"),
                format!("Gyro could not read that automate command: {error}"),
            ),
        };
        let _ = write_bounded_json_line(reader.get_mut(), &response, MAX_DESKTOP_IPC_MESSAGE_BYTES);
        return;
    }
    if value.get("schema").and_then(serde_json::Value::as_str)
        == Some(DESKTOP_PROVIDER_APPROVAL_IPC_SCHEMA_V1)
    {
        let response = match serde_json::from_value::<DesktopProviderApprovalRequest>(value) {
            Ok(request) => handle_desktop_provider_approval_request(app, request),
            Err(error) => DesktopProviderApprovalResponse::deny(format!(
                "Gyro could not decode the provider approval request: {}",
                gyro_core::sanitize_harness_text(&error.to_string())
            )),
        };
        let _ = write_bounded_json_line(reader.get_mut(), &response, MAX_DESKTOP_IPC_MESSAGE_BYTES);
        return;
    }
    if value.get("schema").and_then(serde_json::Value::as_str)
        == Some(PROVIDER_CAPABILITY_IPC_SCHEMA_V1)
    {
        let response = match serde_json::from_value::<CapabilityRequest>(value) {
            Ok(request) => app.state::<ProviderCapabilityBroker>().invoke(app, request),
            Err(error) => CapabilityResponse::failed(
                env!("CARGO_PKG_VERSION"),
                Uuid::nil(),
                "invalid-request",
                error.to_string(),
            ),
        };
        let _ = write_bounded_json_line(reader.get_mut(), &response, MAX_DESKTOP_IPC_MESSAGE_BYTES);
        return;
    }
    let Ok(notification) = serde_json::from_value::<AppNotification>(value) else {
        return;
    };
    let acknowledgement = acknowledgement_for(&notification, env!("CARGO_PKG_VERSION"));
    if matches!(
        &notification.kind,
        AppNotificationKind::OpenSession | AppNotificationKind::AttachSession
    ) && acknowledgement.compatible
    {
        let _ = app.emit("gyro://app-notification", notification);
    }
    let _ = write_bounded_json_line(
        reader.get_mut(),
        &acknowledgement,
        MAX_DESKTOP_IPC_MESSAGE_BYTES,
    );
}

fn write_bounded_json_line(
    writer: &mut impl Write,
    value: &impl Serialize,
    max_bytes: usize,
) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(to_string)?;
    if bytes.len() > max_bytes {
        return Err(format!(
            "IPC response exceeded the {max_bytes} byte size limit"
        ));
    }
    writer
        .write_all(&bytes)
        .and_then(|_| writer.write_all(b"\n"))
        .and_then(|_| writer.flush())
        .map_err(to_string)
}

#[cfg(test)]
mod tests;

/// Deleting a workspace entry must always land in a trash, whichever volume it
/// stood on. These drive the move against a temporary directory so the user's
/// real trash is never involved.
#[cfg(test)]
mod workspace_trash_tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("gyro-trash-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn a_second_delete_keeps_the_extension_and_counts_up() {
        let trash = scratch("names");
        let name = std::ffi::OsStr::new("notes.md");

        let first = unique_trash_destination(&trash, name);
        assert_eq!(first.file_name().unwrap(), std::ffi::OsStr::new("notes.md"));
        std::fs::write(&first, b"one").unwrap();

        let second = unique_trash_destination(&trash, name);
        assert_eq!(
            second.file_name().unwrap(),
            std::ffi::OsStr::new("notes 2.md")
        );
        std::fs::write(&second, b"two").unwrap();

        let third = unique_trash_destination(&trash, name);
        assert_eq!(
            third.file_name().unwrap(),
            std::ffi::OsStr::new("notes 3.md")
        );

        std::fs::remove_dir_all(&trash).unwrap();
    }

    #[test]
    fn a_non_empty_folder_is_trashed_as_one_entry() {
        let root = scratch("folder");
        let trash = root.join("trash");
        let folder = root.join("project");
        std::fs::create_dir_all(folder.join("nested")).unwrap();
        std::fs::write(folder.join("nested").join("file.txt"), b"kept").unwrap();

        let destination = move_entry_into_trash(&folder, &trash).unwrap();

        assert!(!folder.exists(), "the deleted folder is gone from the tree");
        assert_eq!(
            std::fs::read(destination.join("nested").join("file.txt")).unwrap(),
            b"kept",
            "the whole tree survives the delete"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_tree_can_be_copied_across_volumes_before_it_is_dropped() {
        let root = scratch("copy");
        let source = root.join("source");
        std::fs::create_dir_all(source.join("inner")).unwrap();
        std::fs::write(source.join("inner").join("a.txt"), b"a").unwrap();
        let destination = root.join("elsewhere");

        copy_entry(&source, &destination).unwrap();
        remove_entry(&source).unwrap();

        assert!(!source.exists());
        assert_eq!(
            std::fs::read(destination.join("inner").join("a.txt")).unwrap(),
            b"a"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_rename_inside_one_folder_is_not_a_move() {
        assert!(same_workspace_folder("/w/src/lib.rs", "/w/src/main.rs"));
        assert!(!same_workspace_folder("/w/src/lib.rs", "/w/tests/lib.rs"));
    }

    #[test]
    fn a_relative_path_resolves_against_the_workspace_root() {
        assert_eq!(absolute_workspace_path("/w", "src/lib.rs"), "/w/src/lib.rs");
        assert_eq!(
            absolute_workspace_path("/w", "/elsewhere/lib.rs"),
            "/elsewhere/lib.rs"
        );
    }
}
