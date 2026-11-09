use crate::{
    efficiency, provider_tool_batch,
    providers::chat_types::ProviderChatRequest,
    state::{
        managers::ProviderCancellationManager,
        provider_run::{BoundProviderCapabilityContext, ProviderRunControl},
    },
};
use anyhow::Context;
use gyro_core::{CapabilityRunMode, CAPABILITY_DESCRIPTORS};
use std::{collections::HashMap, sync::Arc};
use tauri::Manager;
pub(crate) fn active_provider_approval_nonce(
    app: &tauri::AppHandle,
    session_id: &str,
) -> anyhow::Result<String> {
    app.state::<ProviderCancellationManager>()
        .flags
        .lock()
        .map_err(|_| anyhow::anyhow!("provider run state is unavailable"))?
        .get(session_id)
        .map(|control| control.approval_nonce.clone())
        .ok_or_else(|| anyhow::anyhow!("provider approval has no active run"))
}

pub(crate) fn active_provider_capability_context(
    app: &tauri::AppHandle,
    session_id: &str,
) -> anyhow::Result<BoundProviderCapabilityContext> {
    app.state::<ProviderCancellationManager>()
        .flags
        .lock()
        .map_err(|_| anyhow::anyhow!("provider run state is unavailable"))?
        .get(session_id)
        .ok_or_else(|| anyhow::anyhow!("provider capability has no active run"))?
        .capability_context
        .lock()
        .map_err(|_| anyhow::anyhow!("provider capability context is unavailable"))?
        .clone()
        .ok_or_else(|| anyhow::anyhow!("provider capability context is not bound"))
}

/// The Gyro capability server as an ACP `session/new` MCP entry.
///
/// ACP takes env as an array of `{name, value}` objects, unlike the object map
/// the Claude and Codex CLIs use, so the shared env list is reshaped here.
pub(crate) fn capability_acp_mcp_server(
    bound: &BoundProviderCapabilityContext,
    approval_nonce: &str,
) -> anyhow::Result<serde_json::Value> {
    let executable = std::env::current_exe().context("resolve Gyro capability server path")?;
    Ok(serde_json::json!({
        "name": "gyro_capabilities",
        "command": executable,
        "args": ["provider-capability-server"],
        "env": capability_mcp_env(bound, approval_nonce)
            .into_iter()
            .map(|(name, value)| serde_json::json!({ "name": name, "value": value }))
            .collect::<Vec<_>>(),
    }))
}

pub(crate) fn capability_mcp_env(
    bound: &BoundProviderCapabilityContext,
    approval_nonce: &str,
) -> Vec<(&'static str, String)> {
    let mut env = vec![
        ("GYRO_PROVIDER_HOST_PID", std::process::id().to_string()),
        ("GYRO_CAPABILITY_SESSION_ID", bound.session_id.clone()),
        (
            "GYRO_CAPABILITY_TURN_ID",
            bound.turn_id.clone().unwrap_or_default(),
        ),
        ("GYRO_CAPABILITY_RUN_NONCE", approval_nonce.into()),
        ("GYRO_CAPABILITY_PROVIDER_ID", bound.provider_id.clone()),
        ("GYRO_CAPABILITY_WORKSPACE_KEY", bound.workspace_key.clone()),
        (
            "GYRO_CAPABILITY_ALLOW_DELEGATION",
            bound.allow_delegation.to_string(),
        ),
        (
            "GYRO_CAPABILITY_MODE",
            match bound.policy.mode {
                CapabilityRunMode::Normal => "normal",
                CapabilityRunMode::Plan => "plan",
                CapabilityRunMode::Council => "council",
            }
            .into(),
        ),
        (
            "GYRO_CAPABILITY_POLICY_REVISION",
            bound.policy.revision.to_string(),
        ),
        (
            "GYRO_CAPABILITY_WORKSPACE_CONTEXT_REVISION",
            bound.workspace_context.revision.to_string(),
        ),
    ];
    if compact_cli_catalog_for_run(bound) {
        env.push((provider_tool_batch::COMPACT_CATALOG_ENV, "true".into()));
    }
    #[cfg(debug_assertions)]
    if let Ok(root) = std::env::var("GYRO_TEST_DATA_DIR") {
        env.push(("GYRO_TEST_DATA_DIR", root));
    }
    env
}

/// Panes have no turn id. Their prompts carry no Gyro guidance, so a short list
/// would hide tools from them without saying how to reach the rest.
pub(crate) fn compact_cli_catalog_for_run(bound: &BoundProviderCapabilityContext) -> bool {
    bound.turn_id.is_some()
        && provider_tool_batch::compact_cli_catalog_active(
            &bound.provider_id,
            &efficiency::config(),
        )
}

pub(crate) fn codex_capability_mcp_config_args(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
) -> anyhow::Result<Vec<String>> {
    let executable = std::env::current_exe().context("resolve Gyro capability bridge")?;
    let bound = active_provider_capability_context(app, &request.session_id)?;
    let approval_nonce = active_provider_approval_nonce(app, &request.session_id)?;
    let mut args = vec![
        "-c".into(),
        format!(
            "mcp_servers.gyro_capabilities.command={}",
            serde_json::to_string(&executable.display().to_string())?
        ),
        "-c".into(),
        "mcp_servers.gyro_capabilities.args=[\"provider-capability-server\"]".into(),
        "-c".into(),
        "mcp_servers.gyro_capabilities.required=true".into(),
        // Codex's default 60 s MCP tool timeout would cut off a long
        // gyro_terminal_wait; one long wait is far cheaper than many short ones.
        "-c".into(),
        "mcp_servers.gyro_capabilities.tool_timeout_sec=330".into(),
    ];
    for (name, value) in capability_mcp_env(&bound, &approval_nonce) {
        args.push("-c".into());
        args.push(format!(
            "mcp_servers.gyro_capabilities.env.{name}={}",
            serde_json::to_string(&value)?
        ));
    }
    args.extend(codex_capability_tool_approval_args());
    if compact_cli_catalog_for_run(&bound) {
        args.extend(codex_compact_invoke_approval_args());
    }
    Ok(args)
}

pub(crate) fn codex_compact_invoke_approval_args() -> [String; 2] {
    [
        "-c".into(),
        format!(
            "mcp_servers.gyro_capabilities.tools.{}.approval_mode=\"approve\"",
            provider_tool_batch::COMPACT_INVOKE
        ),
    ]
}

pub(crate) fn codex_capability_tool_approval_args() -> Vec<String> {
    // These tools enter Gyro's authenticated, run-bound capability dispatcher,
    // which enforces the current project policy and presents its own approvals.
    // Codex's separate MCP approval defaults can otherwise elicit a client
    // request that is rejected before the dispatcher ever receives the call,
    // including read-only tools under Full Access. Delegate only our known
    // tools to that dispatcher; do not change approval policy for other servers.
    CAPABILITY_DESCRIPTORS
        .iter()
        .flat_map(|descriptor| {
            [
                "-c".into(),
                format!(
                    "mcp_servers.gyro_capabilities.tools.{}.approval_mode=\"approve\"",
                    descriptor.id.provider_tool_name()
                ),
            ]
        })
        .collect()
}

pub(crate) fn provider_run_approval_matches(
    flags: &HashMap<String, Arc<ProviderRunControl>>,
    session_id: &str,
    approval_nonce: &str,
) -> bool {
    !approval_nonce.is_empty()
        && flags
            .get(session_id)
            .is_some_and(|control| control.approval_nonce == approval_nonce)
}

/// Identity and approval requirements a Claude CLI run reports back to Gyro.
///
/// Chat fills this from a `ProviderChatRequest`; a governed pane fills it from
/// the pane's own persisted CLI session. Both produce the same bridge, so a
/// pane's file writes land in the same proposal store Chat uses.
pub(crate) struct ClaudePermissionBridgeIdentity<'a> {
    pub(crate) session_id: &'a str,
    pub(crate) turn_id: Option<&'a str>,
    pub(crate) provider_id: &'a str,
    pub(crate) provider_label: &'a str,
    pub(crate) require_command_approval: bool,
    pub(crate) require_file_edit_approval: bool,
}

pub(crate) fn desktop_claude_permission_mcp_config_for(
    identity: &ClaudePermissionBridgeIdentity<'_>,
    approval_nonce: &str,
    bound: &BoundProviderCapabilityContext,
) -> anyhow::Result<String> {
    let executable = std::env::current_exe().context("resolve Gyro desktop permission bridge")?;
    let mut config = serde_json::json!({
        "mcpServers": {
            "gyro_approval": {
                "type": "stdio",
                "command": executable,
                "args": ["provider-permission-server"],
                "env": {
                    "GYRO_PROVIDER_HOST_PID": std::process::id().to_string(),
                    "GYRO_DESKTOP_PERMISSION_SESSION_ID": identity.session_id,
                    "GYRO_DESKTOP_PERMISSION_TURN_ID": identity.turn_id.unwrap_or(""),
                    "GYRO_DESKTOP_PERMISSION_RUN_NONCE": approval_nonce,
                    "GYRO_DESKTOP_PERMISSION_PROVIDER_ID": identity.provider_id,
                    "GYRO_DESKTOP_PERMISSION_PROVIDER_LABEL": identity.provider_label,
                    "GYRO_DESKTOP_PERMISSION_REQUIRE_COMMAND": identity.require_command_approval.to_string(),
                    "GYRO_DESKTOP_PERMISSION_REQUIRE_FILE": identity.require_file_edit_approval.to_string(),
                }
            },
            "gyro_capabilities": {
                "type": "stdio",
                "command": executable,
                "args": ["provider-capability-server"],
                "env": capability_mcp_env(bound, approval_nonce)
                    .into_iter()
                    .collect::<HashMap<_, _>>()
            },
        }
    });
    #[cfg(debug_assertions)]
    if let Ok(root) = std::env::var("GYRO_TEST_DATA_DIR") {
        config["mcpServers"]["gyro_approval"]["env"]["GYRO_TEST_DATA_DIR"] = root.into();
    }
    serde_json::to_string(&config).context("encode Gyro desktop permission bridge config")
}

pub(crate) fn desktop_claude_permission_mcp_config(
    request: &ProviderChatRequest,
    approval_nonce: &str,
    bound: &BoundProviderCapabilityContext,
) -> anyhow::Result<String> {
    desktop_claude_permission_mcp_config_for(
        &ClaudePermissionBridgeIdentity {
            session_id: &request.session_id,
            turn_id: request.turn_id.as_deref(),
            provider_id: &request.provider_id,
            provider_label: request.provider_label.as_deref().unwrap_or("Anthropic"),
            require_command_approval: request.require_command_approval,
            require_file_edit_approval: request.require_file_edit_approval,
        },
        approval_nonce,
        bound,
    )
}
