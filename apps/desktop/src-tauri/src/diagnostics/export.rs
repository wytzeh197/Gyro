use crate::{
    diagnostics::types::{
        DiagnosticsConfigSummary, DiagnosticsExportBundle, DiagnosticsExportResult,
        DiagnosticsSessionSummary,
    },
    stores::{open_store, to_string},
};
use gyro_core::{
    GyroConfig, GyroPaths, ProviderHealthCheck, ProviderHealthRequest, SessionOrigin,
    SessionWorkspaceMode,
};
use std::{
    fs,
    path::{Path, PathBuf},
};
#[tauri::command]
pub(crate) async fn export_diagnostics() -> Result<DiagnosticsExportResult, String> {
    tauri::async_runtime::spawn_blocking(export_diagnostics_blocking)
        .await
        .map_err(|error| format!("diagnostics export worker failed: {error}"))?
}

pub(crate) fn export_diagnostics_blocking() -> Result<DiagnosticsExportResult, String> {
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    paths.ensure().map_err(to_string)?;
    let config = GyroConfig::load(&paths).map_err(to_string)?;
    let store = open_store()?;
    let sessions = store.list_sessions().map_err(to_string)?;
    let provider_health = collect_provider_health_for_diagnostics(&config);
    let mut recent_run_diagnostics = Vec::new();
    let mut session_summaries = Vec::new();

    for session in sessions.iter().take(25) {
        let (events, event_read_error) = match store.read_events(session.id) {
            Ok(events) => (events, None),
            Err(error) => (
                Vec::new(),
                Some(gyro_core::sanitize_harness_text(&error.to_string())),
            ),
        };
        session_summaries.push(DiagnosticsSessionSummary {
            id: session.id.to_string(),
            title: gyro_core::sanitize_harness_text(&session.title),
            origin: session_origin_label(&session.origin).into(),
            workspace_mode: session_workspace_mode_label(&session.workspace_mode).into(),
            branch: gyro_core::sanitize_harness_text(&session.branch),
            provider_id: session.provider_id.clone(),
            model_id: session.model_id.clone(),
            event_count: events.len(),
            event_read_error,
            updated_at: session.updated_at.to_rfc3339(),
        });

        for event in events.iter().rev() {
            let Some(payload) = event.payload.as_object() else {
                continue;
            };
            if payload.get("schema").and_then(|value| value.as_str())
                == Some(gyro_core::HARNESS_SCHEMA_V1)
                && payload.get("kind").and_then(|value| value.as_str())
                    == Some("provider-diagnostics")
            {
                recent_run_diagnostics.push(event.payload.clone());
                if recent_run_diagnostics.len() >= 50 {
                    break;
                }
            }
        }
        if recent_run_diagnostics.len() >= 50 {
            break;
        }
    }

    let bundle = DiagnosticsExportBundle {
        schema: gyro_core::HARNESS_SCHEMA_V1.into(),
        generated_at: chrono::Utc::now().to_rfc3339(),
        config_summary: DiagnosticsConfigSummary {
            telemetry_enabled: config.telemetry_enabled,
            require_command_approval: config.require_command_approval,
            require_file_edit_approval: config.require_file_edit_approval,
            full_access: config.full_access,
            provider_count: config.model_providers.len(),
            enabled_provider_ids: config
                .model_providers
                .iter()
                .filter(|provider| provider.enabled)
                .map(|provider| provider.id.clone())
                .collect(),
            command_profile_count: config.command_profiles.len(),
        },
        provider_health,
        provider_capabilities: gyro_core::provider_capability_manifest(),
        recent_run_diagnostics,
        sessions: session_summaries,
    };
    let diagnostics_dir = paths.logs_dir.join("diagnostics");
    fs::create_dir_all(&diagnostics_dir).map_err(to_string)?;
    let file_name = format!(
        "gyro-diagnostics-{}.json",
        chrono::Utc::now().format("%Y%m%dT%H%M%SZ")
    );
    let path = diagnostics_dir.join(file_name);
    let raw = serde_json::to_string_pretty(&bundle).map_err(to_string)?;
    fs::write(&path, format!("{raw}\n")).map_err(to_string)?;

    Ok(DiagnosticsExportResult {
        path: path.display().to_string(),
        bundle,
    })
}

pub(crate) fn collect_provider_health_for_diagnostics(
    config: &GyroConfig,
) -> Vec<ProviderHealthCheck> {
    config
        .model_providers
        .iter()
        .filter_map(|provider| {
            // The shared entry point, so a report written just after a readiness
            // sweep reuses those probes instead of starting a second round of
            // provider CLIs behind it.
            gyro_core::provider_health(ProviderHealthRequest {
                provider_id: provider.id.clone(),
                base_url: provider.base_url.clone(),
                api_key_ref: Some(provider.api_key_ref.clone()),
                kind: provider.kind.clone(),
                force: false,
            })
            .ok()
        })
        .collect()
}

pub(crate) fn session_origin_label(origin: &SessionOrigin) -> &'static str {
    match origin {
        SessionOrigin::Cli => "cli",
        SessionOrigin::Desktop => "desktop",
    }
}

pub(crate) fn session_workspace_mode_label(mode: &SessionWorkspaceMode) -> &'static str {
    match mode {
        SessionWorkspaceMode::Local => "local",
        SessionWorkspaceMode::Worktree => "worktree",
    }
}

pub(crate) fn user_home_directory() -> anyhow::Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("user home directory is unavailable"))?;
    Ok(home.canonicalize().unwrap_or(home))
}

pub(crate) fn terminal_command_path(command: &str) -> String {
    let command = command.trim();
    if command == "zsh" && Path::new("/bin/zsh").exists() {
        return "/bin/zsh".into();
    }
    command.into()
}
