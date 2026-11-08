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
mod ipc;
mod providers;
mod sessions;
mod state;
mod stores;
mod terminal;
mod text;
mod usage;
mod workspace;
pub use app::setup::run;
pub use app::setup::run_entrypoint;
// @moved-reexports-start
#[cfg(target_os = "macos")]
use app::shutdown::restore_main_window;
use app::{
    config::load_config_blocking,
    limits::{
        BROWSER_PREVIEW_CAPTURE_TIMEOUT, BROWSER_PREVIEW_DIAGNOSTIC_TIMEOUT,
        GIT_STATUS_PREPARATION_TIMEOUT, GIT_STATUS_TIMEOUT, MAX_BROWSER_PREVIEW_CAPTURES,
        MAX_BROWSER_PREVIEW_CAPTURE_BYTES, MAX_BROWSER_PREVIEW_DIAGNOSTICS,
        MAX_BROWSER_PREVIEW_DIAGNOSTIC_CHARS, MAX_BROWSER_PREVIEW_DIAGNOSTIC_PAYLOAD_CHARS,
        MAX_CHAT_ATTACHMENTS, MAX_CHAT_IMAGE_BYTES, MAX_CHAT_RESPONSE_CHARS, MAX_CHAT_VIDEO_BYTES,
        MAX_CONCURRENT_BROWSER_PREVIEWS, MAX_CONCURRENT_IDE_COMMANDS, MAX_CONCURRENT_PROVIDER_RUNS,
        MAX_CONCURRENT_SCHEDULED_RUNS, MAX_DAP_OUTPUT_EVENT_BYTES, MAX_DEBUG_ADAPTER_PROCESSES,
        MAX_DESKTOP_SESSION_EVENTS_READ, MAX_GIT_STATUS_CACHES,
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
        MAX_CODEX_APP_SERVER_PATCH_BYTES, MAX_DESKTOP_IPC_MESSAGE_BYTES, MAX_LIVE_RESPONSE_CHARS,
        MAX_PROVIDER_STDOUT_FRAME_BYTES, MAX_STORED_CHAT_ATTACHMENTS_PER_SESSION,
        MAX_STORED_CHAT_ATTACHMENT_BYTES_PER_SESSION, MAX_STORED_DRAFT_ATTACHMENTS,
        MAX_WORKSPACE_FILE_PREVIEW_BYTES, MAX_WORKSPACE_WATCH_CACHES,
        PROVIDER_CHAT_HEARTBEAT_INTERVAL,
    },
    shutdown::{remove_provider_host_ipc_socket, run_quit_jobs_until},
};
#[cfg(test)]
use automation::runtime::{run_event_wakes_automation_scheduler, AutomationSchedulerControl};
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
        mark_browser_image_attached, write_desktop_mcp_message,
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
    create_worktree,
    ipc::{
        DesktopProviderApprovalBehavior, DesktopProviderApprovalRequest,
        DesktopProviderApprovalResponse, DESKTOP_PROVIDER_APPROVAL_IPC_SCHEMA_V1,
    },
    AutomationStatus, AutomationStore, CapabilityResult, ProjectCapabilityGrant,
    SessionWorkspaceMode, WorkspaceCheckReport, WORKSPACE_UNAVAILABLE_MESSAGE,
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
use ipc::cli::{bind_cli_ipc_listener, provider_host_ipc_paths};
use ipc::cli::{desktop_provider_ipc_paths, start_cli_ipc_listener, write_bounded_json_line};
#[cfg(test)]
use provider_retry_recovery::run_provider_chat_with_retry_using;
#[cfg(not(unix))]
use providers::process::{configure_provider_process_group, terminate_provider_process_group};
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
use providers::{
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
        cancel_task_run, with_ide_evidence, BrowserPreviewAdmission, CapabilityIdeEvidenceManager,
        HiddenWebviewGuard, IdeCommandAdmission, ProviderCancellationManager,
        ProviderCapabilityApprovalManager, ProviderCapabilityBroker,
        ProviderCapabilityResourceManager, TaskRunHandle,
    },
    provider_run::{
        stop_provider_run, BoundProviderCapabilityContext, ModelBrowserResource,
        ModelTerminalResource, PendingCapabilityApproval, PendingProviderApproval,
        ProviderApprovalContext, ProviderApprovalNotificationOpen, ProviderRunControl,
        ProviderStopReason, PROVIDER_INTERRUPTED_MARKER, PROVIDER_STALL_MARKER,
        PROVIDER_STOP_MARKER,
    },
};
#[cfg(test)]
use state::{
    provider_run::{
        ProviderApprovalDecision, PROVIDER_CUT_OFF_NOTICE, PROVIDER_TOOL_BUDGET_NOTICE,
    },
    workspace::{WorkspaceRescanState, WorkspaceWatchManager},
};
#[cfg(test)]
use std::{io::BufRead, sync::atomic::AtomicUsize};
use stores::{
    open_automation_store, open_store, parse_uuid, to_string, warm_store_pools, SessionStoreLease,
};
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
mod project_import;
mod project_import_continuation;
mod session_goal;
mod session_history;
mod session_model;
mod session_title_stream;
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
use automation::commands::automation_notification_content;
#[cfg(test)]
use automation::execution::{automation_provider_prompt, parse_automation_execution_outcome};
#[cfg(test)]
use automation::runtime::automation_scheduler_effective_now;
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
    decide_mutation_proposal, mutation_approval_payload, openai_compat_endpoint,
    openai_compat_host_is_loopback, provider_accepts_images, provider_api_key_env_name,
    provider_descriptor, Automation, CancellationToken, CapabilityAccess,
    CapabilityApprovalDecision, CapabilityClass, CapabilityId, CapabilityInvocationContext,
    CapabilityPolicySnapshot, CapabilityRequest, CapabilityResourceRef, CapabilityResponse,
    CapabilityRunMode, CapabilityStatus, CreateSessionContext, CredentialPolicy, ExecutionRequest,
    ExecutionStream, ExecutionTermination, GyroConfig, GyroPaths, HarnessRunStatus,
    MutationDecision, MutationProposal, OllamaToolChatRequest, OpenAiCompatChatRequest,
    ProjectCapabilityPolicy, ProviderCapabilitySupport, ProviderSessionBinding, Session,
    SessionEvent, SessionEventKind, SessionOrigin, SessionStore, UsageEntry, UsageOrigin,
    UsageOutcome, UsageTokens, WorkspaceContextSnapshot, CAPABILITY_DESCRIPTORS,
    OLLAMA_CANCELLED_MESSAGE, OPENAI_COMPAT_CANCELLED_MESSAGE, PROVIDER_CAPABILITY_IPC_SCHEMA_V1,
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
