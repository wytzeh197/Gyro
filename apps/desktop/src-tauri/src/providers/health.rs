use crate::{acp_auth_methods, acp_provider_runtime, project_import_continuation, to_string};
use gyro_core::{
    apply_cli_updates, check_cli_updates, discover_ollama_models, provider_cli_install_plan,
    CliInstallPlanReport, CliUpdateApplyResult, CliUpdateCheckReport, ProviderHealthCheck,
    ProviderHealthRequest,
};
use std::{path::Path, time::Duration};
#[tauri::command]
pub(crate) async fn check_provider_health(
    request: ProviderHealthRequest,
    imported_session_id: Option<String>,
) -> Result<ProviderHealthCheck, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let scope = imported_session_id
            .as_deref()
            .map(|id| {
                project_import_continuation::imported_auth_data_home(id, &request.provider_id)
            })
            .transpose()
            .map_err(to_string)?
            .flatten();
        match scope {
            Some((_, home)) => gyro_core::provider_health::provider_health_with_data_home(
                request,
                Path::new(&home),
            )
            .map_err(to_string),
            None => check_provider_health_blocking(request),
        }
    })
    .await
    .map_err(|error| format!("provider health worker failed: {error}"))?
}

/// Discover models installed in the configured loopback Ollama runtime.
/// This result is transient: a model installed on one Mac is not persisted as
/// though it were available on another one.
#[tauri::command]
pub(crate) async fn discover_ollama_models_command(
    base_url: Option<String>,
) -> Result<gyro_core::OllamaDiscovery, String> {
    tauri::async_runtime::spawn_blocking(move || {
        discover_ollama_models(base_url.as_deref()).map_err(to_string)
    })
    .await
    .map_err(|error| format!("Ollama discovery worker failed: {error}"))?
}

/// Read the connected Google agent's model inventory without an inference request.
#[tauri::command]
pub(crate) async fn discover_google_models_command(
    provider_id: String,
) -> Result<gyro_core::AcpModelDiscovery, String> {
    if provider_id != "antigravity" {
        return Err("Google model discovery requires Antigravity".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = acp_provider_runtime(&provider_id)
            .ok_or_else(|| "Google ACP runtime is unavailable".to_string())?;
        let methods = acp_auth_methods(runtime);
        let methods = methods.iter().map(String::as_str).collect::<Vec<_>>();
        gyro_core::discover_acp_models(
            runtime.label,
            runtime.program,
            runtime.args.iter().map(Into::into).collect(),
            &methods,
            Duration::from_secs(20),
        )
        .map_err(to_string)
    })
    .await
    .map_err(|error| format!("Google model discovery worker failed: {error}"))?
}

/// Scan installed provider CLIs for available updates (npm + native checks).
#[tauri::command]
pub(crate) async fn check_cli_updates_command() -> Result<CliUpdateCheckReport, String> {
    tauri::async_runtime::spawn_blocking(check_cli_updates)
        .await
        .map_err(|error| format!("cli update check worker failed: {error}"))?
        .map_err(to_string)
}

/// How to install a missing provider CLI so the sign-in that follows finds it.
#[tauri::command]
pub(crate) async fn provider_cli_install_plan_command(
    provider_id: String,
) -> Result<CliInstallPlanReport, String> {
    tauri::async_runtime::spawn_blocking(move || provider_cli_install_plan(&provider_id))
        .await
        .map_err(|error| format!("cli install plan worker failed: {error}"))
}

/// Apply updates for specific provider CLIs, or every pending offer when empty.
#[tauri::command]
pub(crate) async fn apply_cli_updates_command(
    provider_ids: Option<Vec<String>>,
) -> Result<Vec<CliUpdateApplyResult>, String> {
    let ids = provider_ids.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || apply_cli_updates(&ids))
        .await
        .map_err(|error| format!("cli update worker failed: {error}"))?
        .map_err(to_string)
}

pub(crate) fn check_provider_health_blocking(
    request: ProviderHealthRequest,
) -> Result<ProviderHealthCheck, String> {
    gyro_core::provider_health(request).map_err(to_string)
}

#[tauri::command]
pub(crate) async fn check_provider_auth(
    provider_id: String,
) -> Result<ProviderHealthCheck, String> {
    tauri::async_runtime::spawn_blocking(move || {
        check_provider_health_blocking(ProviderHealthRequest {
            provider_id,
            api_key_ref: None,
            base_url: None,
            kind: None,
            // Standing readiness question, not a user action: a recent answer
            // is the same answer.
            force: false,
        })
    })
    .await
    .map_err(|error| format!("provider auth worker failed: {error}"))?
}
