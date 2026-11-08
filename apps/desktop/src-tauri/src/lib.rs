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
mod command_execution;
mod context_compaction;
mod conversation_history;
#[cfg(target_os = "macos")]
mod desktop_shortcuts;
mod efficiency;
#[cfg(debug_assertions)]
mod efficiency_benchmark;
mod file_patch_counts;
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
mod provider_run_cleanup;
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
#[cfg(test)]
mod gyro_cloud;
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
