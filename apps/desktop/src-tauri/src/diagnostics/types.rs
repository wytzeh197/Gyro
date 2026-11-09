//! Diagnostics types.

use gyro_core::{ProviderCapabilitySupport, ProviderHealthCheck};
use serde::Serialize;
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosticsExportBundle {
    pub(crate) schema: String,
    pub(crate) generated_at: String,
    pub(crate) config_summary: DiagnosticsConfigSummary,
    pub(crate) provider_health: Vec<ProviderHealthCheck>,
    pub(crate) provider_capabilities: Vec<ProviderCapabilitySupport>,
    pub(crate) recent_run_diagnostics: Vec<serde_json::Value>,
    pub(crate) sessions: Vec<DiagnosticsSessionSummary>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosticsConfigSummary {
    pub(crate) telemetry_enabled: bool,
    pub(crate) require_command_approval: bool,
    pub(crate) require_file_edit_approval: bool,
    pub(crate) full_access: bool,
    pub(crate) provider_count: usize,
    pub(crate) enabled_provider_ids: Vec<String>,
    pub(crate) command_profile_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosticsSessionSummary {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) origin: String,
    pub(crate) workspace_mode: String,
    pub(crate) branch: String,
    pub(crate) provider_id: Option<String>,
    pub(crate) model_id: Option<String>,
    pub(crate) event_count: usize,
    pub(crate) event_read_error: Option<String>,
    pub(crate) updated_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosticsExportResult {
    pub(crate) path: String,
    pub(crate) bundle: DiagnosticsExportBundle,
}
