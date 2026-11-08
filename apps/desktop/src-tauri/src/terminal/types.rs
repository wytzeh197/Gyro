//! Terminal types.

use crate::{terminal_process, ModelCommandBoundary, ModelCommandContext};
use gyro_core::CredentialPolicy;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
#[derive(Clone, Default)]
pub(crate) struct TerminalProcessManager {
    pub(crate) processes: Arc<Mutex<HashMap<String, terminal_process::TerminalPane>>>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalPaneRequest {
    pub(crate) pane_id: String,
    pub(crate) title: String,
    pub(crate) profile_id: Option<String>,
    pub(crate) command: String,
    pub(crate) args: Vec<String>,
    pub(crate) workspace_path: Option<String>,
    pub(crate) workspace_mode: Option<String>,
    pub(crate) working_directory: Option<String>,
    /// A chat whose imported provider data home the explicit login should use.
    #[serde(default)]
    pub(crate) provider_auth_session_id: Option<String>,
    /// Resolved from persisted import metadata, never accepted as renderer env.
    #[serde(skip)]
    pub(crate) provider_data_home: Option<(String, String)>,
    /// Set by the model capability broker; ordinary terminal/login panes inherit.
    #[serde(skip)]
    pub(crate) credential_policy: CredentialPolicy,
    /// Backend-selected process boundary, never accepted from the renderer.
    #[serde(skip)]
    pub(crate) execution_boundary: ModelCommandBoundary,
    #[serde(skip)]
    pub(crate) model_command_context: Option<ModelCommandContext>,
    pub(crate) cols: Option<u16>,
    pub(crate) rows: Option<u16>,
    /// Ask Gyro to run this pane under its approval policy.
    ///
    /// The renderer may only request governance; the command layer decides
    /// whether the profile supports it and resolves everything else itself.
    #[serde(default)]
    pub(crate) governed: bool,
    /// Resolved in `create_terminal_pane` from app state, never from the
    /// renderer, so a compromised window cannot choose the session identity or
    /// environment an agent CLI starts with.
    #[serde(skip)]
    pub(crate) governance: Option<PaneGovernance>,
}

/// Gyro-owned launch additions that put a pane under the same approval policy
/// and capability bridge a Chat turn gets.
///
/// This is the difference between a Gyro pane and any other terminal emulator:
/// the agent's file writes arrive as reviewable Gyro proposals instead of a
/// y/n prompt that scrolls out of the buffer.
#[derive(Clone, Debug)]
pub(crate) struct PaneGovernance {
    pub(crate) session_id: String,
    pub(crate) provider_id: String,
    pub(crate) env: Vec<(String, String)>,
    pub(crate) args: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalPaneSnapshot {
    pub(crate) pane_id: String,
    pub(crate) title: String,
    pub(crate) profile_id: Option<String>,
    pub(crate) command: String,
    /// Selected policy; failed sandbox setup exits without running the command.
    pub(crate) execution_policy: &'static str,
    pub(crate) output: Option<String>,
    pub(crate) output_revision: u64,
    pub(crate) output_complete: bool,
    pub(crate) status: String,
    pub(crate) has_foreground_job: Option<bool>,
    pub(crate) exit_code: Option<i32>,
    pub(crate) workspace_path: Option<String>,
    pub(crate) working_directory: Option<String>,
    pub(crate) cols: u16,
    pub(crate) rows: u16,
    /// Set only when the pane actually runs under Gyro's approval policy, so
    /// the CLI surface can report governance instead of asserting it.
    pub(crate) governed_session_id: Option<String>,
    pub(crate) governed_provider_id: Option<String>,
}
