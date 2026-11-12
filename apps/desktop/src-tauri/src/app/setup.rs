#[cfg(all(debug_assertions, feature = "native-browser-events-smoke"))]
use crate::browser_frontend_smoke;
#[cfg(all(debug_assertions, feature = "native-browser-shell-review"))]
use crate::browser_shell_review;
use crate::{
    agent_session_worker,
    app::shutdown::drain_backend_resources_on_quit,
    app_preview,
    automation::{
        runtime::{run_event_wakes_automation_scheduler, AutomationSchedulerControl},
        scheduler::start_automation_scheduler,
    },
    canvas_preview,
    capabilities::mcp_server::{run_provider_capability_server, run_provider_permission_server},
    cloud_connection, delegated_agents, desktop_shortcuts, goal_runner,
    ide::{language_server, types::DebugAdapterManager},
    ipc::cli::start_cli_ipc_listener,
    local_check, menu_bar, project_import,
    providers::session_lifecycle::reconcile_interrupted_provider_turns,
    quit_confirmation, session_browser,
    state::{
        managers::{
            CapabilityIdeEvidenceManager, ProviderApprovalManager, ProviderCancellationManager,
            ProviderCapabilityApprovalManager, ProviderCapabilityBroker,
            ProviderCapabilityResourceManager,
        },
        workspace::{WorkspacePreparationManager, WorkspaceWatchManager},
    },
    stores::SessionStoreLease,
    terminal::types::TerminalProcessManager,
};
#[cfg(target_os = "macos")]
use crate::{
    app::shutdown::restore_main_window, window_controls::apply_macos_traffic_light_position,
};
#[cfg(debug_assertions)]
use crate::{browser_smoke, code_mode_smoke, lsp_smoke, performance_benchmark};
use gyro_core::{recover_provider_mutation_transactions, GyroPaths, SessionStore};
use tauri::Manager;
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
            crate::features::workflow_execution::recover(app.handle().clone());
            crate::features::workflow_extraction::recover(app.handle());
            start_automation_scheduler(app.handle().clone());
            crate::features::code_reviews::execution::recover(app.handle().clone());
            crate::features::code_reviews::fix_queue::recover(app.handle());
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
            crate::local_check::prepare_local_check,
            crate::cloud_connection::cloud_connection_view,
            crate::cloud_connection::cloud_connection_action,
            crate::cloud_connection::cloud_connection_begin,
            crate::cloud_connection::cloud_connection_verify,
            crate::cloud_connection::cloud_connection_service,
            crate::local_check::resolve_local_check,
            crate::local_check::cancel_local_check,
            crate::local_check::list_local_checks,
            crate::local_check::delete_local_check,
            crate::efficiency::set_efficiency_config,
            crate::features::project_memory::commands::project_memory_request,
            crate::features::code_reviews::commands::code_review_request,
            crate::features::workflows::workflow_definition_request,
            crate::features::workflow_execution::commands::workflow_run_request,
            crate::features::workflow_extraction::commands::workflow_extraction_request,
            crate::efficiency::get_efficiency_task_totals,
            crate::efficiency::route_efficiency_phase,
            crate::quit_confirmation::get_quit_confirmation,
            crate::quit_confirmation::resolve_quit_confirmation,
            crate::project_import::get_project_import_sources,
            crate::project_import::scan_project_imports,
            crate::project_import::start_project_import,
            crate::project_import::get_project_import_job,
            crate::project_import::cancel_project_import,
            crate::project_import::relocate_imported_project,
            crate::project_import::continue_import_in_new_session,
            crate::project_import_continuation::get_imported_chat_state,
            crate::turn_timing::timing_diagnostics_enabled,
            crate::turn_timing::record_frontend_timing,
            crate::turn_timing::record_surface_timing,
            crate::delegated_agents::list_subagents,
            crate::delegated_agents::stop_subagent,
            crate::sessions::events::append_chat_context_event,
            crate::sessions::events::append_editor_event,
            crate::sessions::events::append_plan_event,
            crate::sessions::commands::append_user_message,
            crate::sessions::commands::set_session_workspace_identity,
            crate::automation::commands::claim_due_automation,
            crate::providers::health::check_provider_auth,
            crate::browser::preview::check_browser_preview,
            crate::providers::health::check_provider_health,
            crate::provider_install::install_provider_cli,
            crate::provider_api_keys::provider_api_key_status,
            crate::provider_api_keys::set_provider_api_key,
            crate::provider_api_keys::clear_provider_api_key,
            crate::provider_api_keys::list_custom_provider_models,
            crate::providers::health::check_cli_updates_command,
            crate::providers::health::apply_cli_updates_command,
            crate::providers::health::provider_cli_install_plan_command,
            crate::system_access::check_system_access,
            crate::system_access::open_system_access_settings,
            crate::dictation_access::request_dictation_access,
            crate::dictation_access::start_dictation,
            crate::dictation_access::stop_dictation,
            crate::browser::preview::capture_browser_preview,
            crate::app_preview::app_preview_request,
            crate::browser::preview::capture_session_browser_preview,
            crate::session_browser::session_browser_open,
            crate::session_browser::session_browser_set_bounds,
            crate::session_browser::session_browser_set_viewport,
            crate::session_browser::session_browser_set_visible,
            crate::session_browser::session_browser_navigate,
            crate::session_browser::session_browser_reload,
            crate::session_browser::session_browser_history,
            crate::session_browser::session_browser_close,
            crate::session_browser::session_browser_snapshot,
            crate::automation::commands::complete_automation_lease,
            crate::terminal::panes::close_terminal_pane,
            crate::automation::commands::create_automation,
            crate::automation::commands::edit_automation,
            crate::sessions::commands::create_desktop_session,
            crate::workspace::files::create_file_mutation_proposal,
            crate::terminal::panes::create_terminal_pane,
            crate::workspace::paths::create_workspace_file,
            crate::sessions::commands::create_worktree_session,
            crate::ide::debug::debug_send,
            crate::ide::debug::debug_start,
            crate::ide::debug::debug_stop,
            crate::providers::health::discover_ollama_models_command,
            crate::providers::health::discover_google_models_command,
            crate::sessions::commands::delete_session,
            crate::workspace::paths::delete_workspace_path,
            crate::workspace::paths::duplicate_workspace_path,
            crate::workspace::paths::peek_workspace_path_undo,
            crate::workspace::paths::undo_workspace_path,
            crate::workspace::paths::redo_workspace_path,
            crate::diagnostics::export::export_diagnostics,
            crate::app::config::get_account_session,
            crate::app::commands::get_notification_permission,
            crate::menu_bar::get_menu_bar_snapshot,
            crate::capabilities::commands::get_project_capability_policy,
            crate::capabilities::commands::get_provider_capability_support,
            crate::capabilities::commands::list_provider_capability_support,
            crate::model_catalog::fetch_model_catalog,
            crate::model_catalog::install_model_catalog,
            crate::live_model_context::refresh_model_context_windows,
            crate::usage::fetch::get_provider_usage,
            crate::usage::fetch::get_session_usage_totals,
            crate::usage::commands::get_usage_safety_snapshot,
            crate::usage::commands::get_provider_usage_ledger,
            crate::usage::commands::set_usage_paused,
            crate::usage::commands::set_provider_budget,
            crate::context_compaction::set_auto_compact_percent,
            crate::git::commands::git_commit,
            crate::git::commands::git_branches,
            crate::git::commands::git_checkout_branch,
            crate::git::commands::git_rename_branch,
            crate::git::commands::git_create_branch,
            crate::git::commands::git_remove_worktree,
            crate::git::commands::git_diff,
            crate::git::review::git_review_content,
            crate::git::commands::git_discard,
            crate::git::commands::git_fetch,
            crate::git::commands::git_pull,
            crate::git::commands::git_push,
            crate::git::commands::git_stage,
            crate::git::commands::git_status,
            crate::git::commands::git_unstage,
            crate::git::github::github_create_pull_request,
            crate::git::github::github_pull_requests,
            crate::git::github::github_rerun_workflow,
            crate::git::github::github_status,
            crate::git::github::github_workflow_logs,
            crate::git::github::github_workflow_run_detail,
            crate::git::github::github_workflow_runs,
            crate::automation::commands::list_automations,
            crate::terminal::panes::list_active_capability_resources,
            crate::automation::commands::list_due_automations,
            crate::sessions::commands::list_sessions,
            crate::task_suggestions::list_start_task_suggestions,
            crate::workspace::tree::list_workspace_files,
            crate::workspace::tree::list_workspace_tree,
            crate::workspace_roots::inspect_workspace_folders,
            crate::app::config::load_config,
            crate::app::config::warm_desktop_shell,
            crate::app::config::logout_account,
            crate::ide::language_server::lsp_request,
            crate::ide::language_server::lsp_start,
            crate::ide::language_server::lsp_stop,
            crate::workspace::files::read_workspace_file,
            crate::workspace::files::read_workspace_file_full,
            crate::terminal::panes::read_terminal_output,
            crate::sessions::commands::read_session_events,
            crate::sessions::attachments::prepare_chat_attachment,
            crate::sessions::attachments::read_cited_chat_image,
            crate::sessions::attachments::resolve_cited_chat_image,
            crate::chat_media_upload::prepare_chat_media_upload,
            crate::chat_media_upload::download_chat_media_url,
            crate::sessions::attachments::prepare_browser_attachment,
            crate::workspace::preparation::prepare_workspace,
            crate::app::commands::restart_app,
            crate::app::commands::updater_platform_key,
            crate::menu_bar::hide_menu_bar_popover,
            crate::automation::commands::recover_automation_leases,
            crate::sessions::commands::rename_session,
            crate::workspace::paths::rename_workspace_path,
            crate::app::config::refresh_account_session,
            crate::terminal::panes::resize_terminal_pane,
            crate::terminal::panes::terminal_pane_working_directory,
            crate::workspace::files::resolve_file_mutation_proposal,
            crate::providers::approvals::resolve_provider_approval,
            crate::capabilities::execute::resolve_capability_approval,
            crate::sessions::review::record_file_review_decision,
            crate::terminal::panes::restart_terminal_pane,
            crate::terminal::panes::restore_terminal_panes,
            crate::automation::commands::run_automation,
            crate::council::commands::read_council_artifact,
            crate::council::commands::retry_council_synthesis,
            crate::council::commands::run_council_chat,
            crate::providers::commands::run_provider_chat,
            crate::providers::commands::compact_provider_chat,
            crate::app::config::save_config,
            crate::capabilities::commands::save_project_capability_policy,
            crate::workspace::paths::search_workspace,
            crate::session_model::set_session_model,
            crate::menu_bar::set_menu_bar_snapshot,
            crate::menu_bar::set_menu_bar_visible,
            crate::git::commands::set_session_branch,
            crate::automation::commands::set_automation_status,
            crate::workspace::files::stat_workspace_file,
            crate::workspace::files::classify_dropped_path,
            crate::providers::change_summary::summarize_file_changes,
            crate::app::config::start_account_login,
            crate::terminal::panes::stop_terminal_pane,
            crate::terminal::panes::stop_model_terminal_resource,
            crate::providers::commands::stop_provider_chat,
            crate::menu_bar::open_menu_bar_target,
            crate::menu_bar::show_main_window,
            crate::terminal::panes::terminal_pane_has_foreground_job,
            crate::ide::tasks::task_discover,
            crate::ide::tasks::task_create_custom,
            crate::ide::tasks::task_delete_custom,
            crate::ide::tasks::task_cancel,
            crate::ide::tasks::task_run,
            crate::ide::tasks::test_discover,
            crate::app::commands::test_notification,
            crate::ide::tasks::test_run,
            crate::automation::commands::triage_automation,
            crate::capabilities::commands::update_capability_ide_evidence,
            crate::workspace::paths::watch_workspace,
            crate::workspace::files::write_workspace_file,
            crate::terminal::panes::write_terminal_input
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
