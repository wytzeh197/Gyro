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
mod agent_reports;
mod app_preview;
mod browser_knowledge;
mod browser_pointer;
#[cfg(all(debug_assertions, feature = "native-browser-shell-review"))]
mod browser_shell_review;
mod capability_execution_guard;
mod capability_inspection;
mod capability_output_budget;
mod capability_workspace_helpers;
mod claude_usage_cli;
mod cloud_connection;
mod code_mode;
#[cfg(debug_assertions)]
mod code_mode_smoke;
mod codex_images;
mod codex_startup;
mod codex_turn_completion;
mod command_execution;
mod context_compaction;
mod conversation_history;
#[cfg(target_os = "macos")]
mod desktop_shortcuts;
mod efficiency;
#[cfg(debug_assertions)]
mod efficiency_benchmark;
mod file_patch_counts;
mod git_branch_service;
mod git_read;
mod goal_runner;
mod ide_evidence;
mod kimi_usage;
mod live_model_context;
mod local_check;
mod model_catalog;
mod ollama_runner;
mod openai_compatible_runner;
#[cfg(debug_assertions)]
mod performance_benchmark;
mod project_import;
mod project_import_continuation;
mod provider_accounting;
mod provider_activity;
mod provider_api_keys;
mod provider_install;
mod provider_mcp;
mod provider_reliability;
mod provider_retry_recovery;
mod provider_run_cleanup;
mod provider_session_lifecycle;
mod provider_spend_guard;
mod provider_tool_batch;
mod session_goal;
mod session_history;
mod session_model;
mod session_title_stream;
mod turn_timing;
mod usage_poll;
mod window_controls;
mod workspace_context_capability;
mod workspace_roots;
mod workspace_search;
mod workspace_tree_order;

#[cfg(all(debug_assertions, feature = "native-browser-events-smoke"))]
mod browser_frontend_smoke;
#[cfg(debug_assertions)]
mod browser_smoke;
mod browser_viewport;
mod commit_suggestion;
mod delegated_agents;
mod desktop_notifications;
mod dictation_access;
mod git_history_capability;
mod git_line_counts;
mod git_main_comparison;
mod git_status_cache;
#[cfg(test)]
mod gyro_cloud;
mod language_server;
mod launch_integrity;
mod lsp_capability;
#[cfg(debug_assertions)]
mod lsp_smoke;
mod memory_capability;
mod menu_bar;
mod provider_context;
mod provider_identity;
mod provider_timeline;
mod quit_confirmation;
mod reply_segments;
mod session_browser;
mod source_control_review;
mod subagent_capability;
mod system_access;
mod task_suggestions;
mod terminal_capability;
mod terminal_process;
mod terminal_wait;
mod web_fetch_capability;
mod workspace_capability_list;
mod workspace_capability_read;
mod workspace_edit_capability;
mod workspace_mutations;
mod workspace_open_capability;
mod workspace_path_capability;
mod workspace_path_history;

#[cfg(test)]
mod tests;

/// Deleting a workspace entry must always land in a trash, whichever volume it
/// stood on. These drive the move against a temporary directory so the user's
/// real trash is never involved.
#[cfg(test)]
mod workspace_trash_tests {

    use crate::workspace::paths::{
        absolute_workspace_path, copy_entry, move_entry_into_trash, remove_entry,
        same_workspace_folder, unique_trash_destination,
    };
    use std::path::PathBuf;

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
