use crate::{
    app::config::load_config_blocking,
    capabilities::types::{CapabilityIdeEvidenceUpdate, SaveProjectCapabilityPolicyRequest},
    code_mode,
    ide::debug::redact_json_strings,
    normalize_workspace_context_paths, open_store, openai_compatible_runner,
    state::managers::CapabilityIdeEvidenceManager,
    to_string,
    workspace::files::workspace_root,
};
use gyro_core::{
    CapabilityId, ProjectCapabilityPolicy, ProviderCapabilitySupport, WorkspaceContextSnapshot,
};
#[tauri::command]
pub(crate) async fn get_project_capability_policy(
    workspace_path: String,
) -> Result<ProjectCapabilityPolicy, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = workspace_root(&workspace_path).map_err(to_string)?;
        open_store()?
            .get_project_capability_policy(&workspace.display().to_string())
            .map_err(to_string)
    })
    .await
    .map_err(|error| format!("capability policy worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn save_project_capability_policy(
    request: SaveProjectCapabilityPolicyRequest,
) -> Result<ProjectCapabilityPolicy, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = workspace_root(&request.workspace_path).map_err(to_string)?;
        let workspace_key = workspace.display().to_string();
        if request.policy.workspace_key != workspace_key {
            return Err("capability policy workspace changed; reload and try again".into());
        }
        open_store()?
            .save_project_capability_policy(request.policy, request.expected_revision)
            .map_err(to_string)
    })
    .await
    .map_err(|error| format!("capability policy save worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn get_provider_capability_support(
    provider_id: String,
) -> Result<ProviderCapabilitySupport, String> {
    openai_compatible_runner::configured_capability_support(provider_id.trim())
}

#[tauri::command]
pub(crate) async fn list_provider_capability_support(
) -> Result<Vec<ProviderCapabilitySupport>, String> {
    let mut support = gyro_core::provider_capability_manifest();
    let config = load_config_blocking()?;
    for provider in &config.model_providers {
        let configured = gyro_core::provider_capability_support_with_kind(
            &provider.id,
            provider.kind.as_deref(),
        );
        if let Some(existing) = support
            .iter_mut()
            .find(|item| item.provider_id == provider.id)
        {
            *existing = configured;
        } else if gyro_core::provider_registry::is_openai_compatible_provider(
            &provider.id,
            provider.kind.as_deref(),
        ) {
            support.push(configured);
        }
    }
    for item in &mut support {
        item.capabilities.retain(|id| {
            !matches!(
                id,
                CapabilityId::CodeModeDiscover | CapabilityId::CodeModeExecute
            ) || code_mode::enabled()
        });
    }
    Ok(support)
}

#[tauri::command]
pub(crate) async fn update_capability_ide_evidence(
    request: CapabilityIdeEvidenceUpdate,
    manager: tauri::State<'_, CapabilityIdeEvidenceManager>,
) -> Result<(), String> {
    let workspace = workspace_root(&request.workspace_path).map_err(to_string)?;
    let workspace_key = workspace.display().to_string();
    let diagnostics =
        gyro_core::validate_capability_result_data(redact_json_strings(request.diagnostics))
            .map_err(to_string)?;
    let mut context = request
        .context
        .unwrap_or_else(|| WorkspaceContextSnapshot::empty(workspace_key.clone()));
    context.workspace_key = workspace_key.clone();
    context.diagnostics = diagnostics.as_array().cloned().unwrap_or_default();
    normalize_workspace_context_paths(&workspace, &mut context).map_err(to_string)?;
    context.validate().map_err(to_string)?;
    manager
        .task_outputs
        .restore_context(&workspace_key, &mut context);
    manager
        .evidence
        .lock()
        .map_err(|_| "IDE evidence state is unavailable".to_string())?
        .store(workspace_key, context);
    Ok(())
}
