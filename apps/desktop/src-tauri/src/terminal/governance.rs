//! Model terminal command governance.

use crate::{
    advertised_mcp_capability_tools, desktop_claude_permission_mcp_config_for,
    git_branch_catalog_impl, open_store, BoundProviderCapabilityContext,
    CapabilityIdeEvidenceManager, ClaudePermissionBridgeIdentity, PaneGovernance,
    ProviderCancellationManager, ProviderRunControl, TerminalPaneRequest,
};
use anyhow::Context;
use gyro_core::{
    CapabilityPolicySnapshot, CapabilityRunMode, CreateSessionContext, GyroConfig, GyroPaths,
    SessionOrigin, SessionWorkspaceMode, WorkspaceContextSnapshot,
};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::Manager;

/// The provider a pane profile can be governed as, if any.
///
/// Governance is deliberately narrow: it only covers CLIs that expose an
/// interactive hook Gyro can enforce. Claude Code has
/// `--permission-prompt-tool`, and `handle_desktop_provider_approval_request`
/// only accepts `anthropic`. Codex routes approvals through the app-server
/// path instead, which a raw PTY pane does not speak, so it stays ungoverned
/// here rather than being labelled as protected when it is not.
pub(crate) fn governable_pane_provider(request: &TerminalPaneRequest) -> Option<&'static str> {
    let profile = request.profile_id.as_deref().unwrap_or_default();
    let command = Path::new(request.command.trim())
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    (matches!(profile, "claude" | "claude-code") || command == "claude").then_some("anthropic")
}

/// Put a pane under Gyro's approval policy.
///
/// Creates the pane's own CLI session, registers a run control so
/// `handle_desktop_provider_approval_request` recognises its approvals, and
/// returns the launch additions that point the CLI at Gyro's bridge.
pub(crate) fn resolve_pane_governance(
    app: &tauri::AppHandle,
    request: &TerminalPaneRequest,
) -> anyhow::Result<PaneGovernance> {
    let provider_id = governable_pane_provider(request)
        .ok_or_else(|| anyhow::anyhow!("this profile cannot run under Gyro approvals"))?;
    let workspace = request
        .workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| anyhow::anyhow!("a governed pane needs a trusted workspace"))?;
    let workspace = PathBuf::from(workspace)
        .canonicalize()
        .context("resolve governed pane workspace")?;
    if !workspace.is_dir() {
        anyhow::bail!("the governed pane workspace is not a directory");
    }

    let paths = GyroPaths::for_current_user()?;
    let config = GyroConfig::load(&paths)?;
    let provider = config
        .model_providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| anyhow::anyhow!("{provider_id} is not configured in Gyro settings"))?;
    if !provider.enabled {
        anyhow::bail!("{} is disabled in Gyro settings", provider.display_name);
    }
    let provider_label = provider.display_name.clone();

    let store = open_store().map_err(anyhow::Error::msg)?;
    let workspace_key = workspace.display().to_string();
    let branch = git_branch_catalog_impl(&workspace_key)
        .ok()
        .and_then(|catalog| catalog.current)
        .unwrap_or_else(|| "main".into());
    let session = store.create_session_with_context(
        &workspace,
        SessionOrigin::Cli,
        request.title.clone(),
        CreateSessionContext {
            branch,
            provider_id: Some(provider_id.to_string()),
            provider_label: Some(provider_label.clone()),
            workspace_mode: if request.workspace_mode.as_deref() == Some("worktree") {
                SessionWorkspaceMode::Worktree
            } else {
                SessionWorkspaceMode::Local
            },
            ..CreateSessionContext::default()
        },
    )?;
    let session_id = session.id.to_string();

    let bound = BoundProviderCapabilityContext {
        session_id: session_id.clone(),
        turn_id: None,
        provider_id: provider_id.to_string(),
        provider_kind: config
            .model_providers
            .iter()
            .find(|provider| provider.id == provider_id)
            .and_then(|provider| provider.kind.clone()),
        workspace: workspace.clone(),
        workspace_key: workspace_key.clone(),
        workspace_identity_revision: session.workspace_identity.revision,
        allow_delegation: false,
        policy: CapabilityPolicySnapshot::from_policy(
            &store.get_project_capability_policy(&workspace_key)?,
            CapabilityRunMode::Normal,
        ),
        workspace_context: app
            .state::<CapabilityIdeEvidenceManager>()
            .evidence
            .lock()
            .map_err(|_| anyhow::anyhow!("IDE evidence state is unavailable"))?
            .get(&workspace_key)
            .cloned()
            .unwrap_or_else(|| WorkspaceContextSnapshot::empty(workspace_key.clone())),
        workspace_check: gyro_core::check_workspace(&workspace),
    };

    // A pane is long-lived, so unlike a Chat turn its run control lives for the
    // life of the pane and is removed in `release_pane_governance`.
    let control = Arc::new(ProviderRunControl::default());
    let approval_nonce = control.approval_nonce.clone();
    *control
        .capability_context
        .lock()
        .map_err(|_| anyhow::anyhow!("provider capability context is unavailable"))? =
        Some(bound.clone());
    app.state::<ProviderCancellationManager>()
        .flags
        .lock()
        .map_err(|_| anyhow::anyhow!("provider run state is unavailable"))?
        .insert(session_id.clone(), control);

    let mcp_config = desktop_claude_permission_mcp_config_for(
        &ClaudePermissionBridgeIdentity {
            session_id: &session_id,
            turn_id: None,
            provider_id,
            provider_label: &provider_label,
            require_command_approval: config.require_command_approval,
            require_file_edit_approval: config.require_file_edit_approval,
        },
        &approval_nonce,
        &bound,
    )?;
    let capability_tools = advertised_mcp_capability_tools(CapabilityRunMode::Normal);
    let posture = gyro_core::approval_posture(
        config.full_access,
        config.require_command_approval,
        config.require_file_edit_approval,
    );
    let mut args = vec![
        "--setting-sources".into(),
        String::new(),
        "--mcp-config".into(),
        mcp_config,
        "--strict-mcp-config".into(),
    ];
    if posture == gyro_core::ApprovalPosture::FullAccess {
        args.push("--dangerously-skip-permissions".into());
    } else {
        args.extend([
            "--permission-prompt-tool".into(),
            "mcp__gyro_approval__approve".into(),
            "--allowedTools".into(),
            format!("mcp__gyro_approval__approve,{capability_tools}"),
            "--permission-mode".into(),
            gyro_core::claude_permission_mode(posture).into(),
        ]);
    }

    Ok(PaneGovernance {
        session_id,
        provider_id: provider_id.to_string(),
        env: Vec::new(),
        args,
    })
}

/// Drop a governed pane's run control so a closed pane cannot keep approving.
pub(crate) fn release_pane_governance(app: &tauri::AppHandle, session_id: &str) {
    if let Ok(mut flags) = app.state::<ProviderCancellationManager>().flags.lock() {
        if let Some(control) = flags.remove(session_id) {
            control.cancellation.cancel();
        }
    }
}
