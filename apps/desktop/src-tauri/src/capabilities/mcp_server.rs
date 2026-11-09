use crate::{
    app::limits::{MAX_BROWSER_PREVIEW_CAPTURE_BYTES, MAX_PERMISSION_MCP_MESSAGE_BYTES},
    browser::types::BROWSER_OBSERVATION_SCHEMA_V1,
    browser_viewport, capability_output_budget,
    capability_workspace_helpers::{capability_uses_workspace_root, workspace_result_bytes_schema},
    code_mode, delegated_agents, efficiency,
    git::{branches as git_branch_service, history_capability as git_history_capability},
    ipc::cli::{desktop_provider_ipc_paths, write_bounded_json_line},
    lsp_capability, memory_capability, provider_mcp, provider_tool_batch, subagent_capability,
    web_fetch_capability, workspace_edit_capability, workspace_open_capability,
    workspace_path_capability,
};
use anyhow::Context;
use base64::Engine;
use gyro_core::{
    ipc::{
        request_desktop_provider_approval, request_desktop_provider_capability,
        DesktopProviderApprovalBehavior, DesktopProviderApprovalRequest,
        DesktopProviderApprovalResponse, DESKTOP_PROVIDER_APPROVAL_IPC_SCHEMA_V1,
    },
    provider_accepts_images, CapabilityId, CapabilityInvocationContext, CapabilityRequest,
    CapabilityResponse, CapabilityRunMode, CapabilityStatus, GyroPaths,
    PROVIDER_CAPABILITY_IPC_SCHEMA_V1,
};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};
use uuid::Uuid;
pub(crate) struct DesktopProviderPermissionContext {
    pub(crate) session_id: String,
    pub(crate) turn_id: Option<String>,
    pub(crate) run_nonce: String,
    pub(crate) provider_id: String,
    pub(crate) provider_label: Option<String>,
    pub(crate) require_command_approval: bool,
    pub(crate) require_file_edit_approval: bool,
}

pub(crate) struct DesktopProviderCapabilityContext {
    pub(crate) session_id: String,
    pub(crate) turn_id: Option<String>,
    pub(crate) run_nonce: String,
    pub(crate) provider_id: String,
    pub(crate) workspace_key: String,
    pub(crate) mode: CapabilityRunMode,
    pub(crate) policy_revision: u64,
    pub(crate) workspace_context_revision: u64,
    pub(crate) allow_delegation: bool,
    pub(crate) compact_catalog: bool,
}

impl DesktopProviderCapabilityContext {
    pub(crate) fn from_env() -> anyhow::Result<Self> {
        let mode = match desktop_permission_env("GYRO_CAPABILITY_MODE")?.as_str() {
            "normal" => CapabilityRunMode::Normal,
            "plan" => CapabilityRunMode::Plan,
            "council" => CapabilityRunMode::Council,
            _ => anyhow::bail!("invalid provider capability mode"),
        };
        Ok(Self {
            session_id: desktop_permission_env("GYRO_CAPABILITY_SESSION_ID")?,
            turn_id: std::env::var("GYRO_CAPABILITY_TURN_ID")
                .ok()
                .filter(|value| !value.trim().is_empty()),
            run_nonce: desktop_permission_env("GYRO_CAPABILITY_RUN_NONCE")?,
            provider_id: desktop_permission_env("GYRO_CAPABILITY_PROVIDER_ID")?,
            workspace_key: desktop_permission_env("GYRO_CAPABILITY_WORKSPACE_KEY")?,
            mode,
            // Older launchers do not carry an opt-in; fail closed. Execution
            // still checks the host-owned context rather than trusting this env.
            allow_delegation: std::env::var("GYRO_CAPABILITY_ALLOW_DELEGATION")
                .is_ok_and(|value| value == "true"),
            compact_catalog: std::env::var(provider_tool_batch::COMPACT_CATALOG_ENV)
                .is_ok_and(|value| value == "true"),
            policy_revision: desktop_permission_env("GYRO_CAPABILITY_POLICY_REVISION")?
                .parse()
                .context("invalid provider capability policy revision")?,
            workspace_context_revision: desktop_permission_env(
                "GYRO_CAPABILITY_WORKSPACE_CONTEXT_REVISION",
            )?
            .parse()
            .context("invalid Workspace context revision")?,
        })
    }
}

impl DesktopProviderPermissionContext {
    pub(crate) fn from_env() -> anyhow::Result<Self> {
        Ok(Self {
            session_id: desktop_permission_env("GYRO_DESKTOP_PERMISSION_SESSION_ID")?,
            turn_id: std::env::var("GYRO_DESKTOP_PERMISSION_TURN_ID")
                .ok()
                .filter(|value| !value.trim().is_empty()),
            run_nonce: desktop_permission_env("GYRO_DESKTOP_PERMISSION_RUN_NONCE")?,
            provider_id: desktop_permission_env("GYRO_DESKTOP_PERMISSION_PROVIDER_ID")?,
            provider_label: std::env::var("GYRO_DESKTOP_PERMISSION_PROVIDER_LABEL")
                .ok()
                .filter(|value| !value.trim().is_empty()),
            require_command_approval: desktop_permission_env_bool(
                "GYRO_DESKTOP_PERMISSION_REQUIRE_COMMAND",
            )?,
            require_file_edit_approval: desktop_permission_env_bool(
                "GYRO_DESKTOP_PERMISSION_REQUIRE_FILE",
            )?,
        })
    }
}

pub(crate) fn desktop_permission_env(name: &str) -> anyhow::Result<String> {
    std::env::var(name)
        .with_context(|| format!("missing desktop provider permission context {name}"))
}

pub(crate) fn desktop_permission_env_bool(name: &str) -> anyhow::Result<bool> {
    match desktop_permission_env(name)?.as_str() {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => anyhow::bail!("invalid desktop provider permission flag {name}"),
    }
}

pub(crate) fn desktop_permission_tool_call(
    paths: &GyroPaths,
    context: &DesktopProviderPermissionContext,
    params: serde_json::Value,
) -> anyhow::Result<serde_json::Value> {
    if params.get("name").and_then(serde_json::Value::as_str) != Some("approve") {
        anyhow::bail!("unknown Gyro desktop approval tool");
    }
    let arguments = params.get("arguments").cloned().unwrap_or_default();
    let tool_name = arguments
        .get("tool_name")
        .or_else(|| arguments.get("toolName"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let input = arguments
        .get("input")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let request = DesktopProviderApprovalRequest {
        schema: DESKTOP_PROVIDER_APPROVAL_IPC_SCHEMA_V1.into(),
        sender_version: env!("CARGO_PKG_VERSION").into(),
        session_id: context.session_id.clone(),
        turn_id: context.turn_id.clone(),
        run_nonce: context.run_nonce.clone(),
        provider_id: context.provider_id.clone(),
        provider_label: context.provider_label.clone(),
        tool_name,
        input: input.clone(),
        permission_suggestions: arguments
            .get("permission_suggestions")
            .or_else(|| arguments.get("permissionSuggestions"))
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
        require_command_approval: context.require_command_approval,
        require_file_edit_approval: context.require_file_edit_approval,
    };
    let response = request_desktop_provider_approval(paths, &request).unwrap_or_else(|error| {
        DesktopProviderApprovalResponse::deny(format!(
            "Gyro denied this provider action because desktop approval was unavailable: {}",
            gyro_core::sanitize_harness_text(&error.to_string())
        ))
    });
    let permission_result = match response.behavior {
        DesktopProviderApprovalBehavior::Allow => serde_json::json!({
            "behavior": "allow",
            "updatedInput": response.updated_input.unwrap_or(input),
            "message": response.message,
        }),
        DesktopProviderApprovalBehavior::Deny => serde_json::json!({
            "behavior": "deny",
            "message": response.message,
        }),
    };
    Ok(serde_json::json!({
        "content": [{
            "type": "text",
            "text": serde_json::to_string(&permission_result)?,
        }],
        "isError": false,
    }))
}

pub(crate) fn advertised_capability_descriptors(
    mode: CapabilityRunMode,
) -> impl Iterator<Item = &'static gyro_core::CapabilityDescriptor> {
    let config = efficiency::config();
    gyro_core::advertised_capability_descriptors(mode).filter(move |descriptor| {
        match descriptor.id {
            CapabilityId::CodeModeDiscover | CapabilityId::CodeModeExecute => code_mode::enabled(),
            CapabilityId::TaskCheckpoint => config.policies() && config.task_state,
            CapabilityId::WorkspaceOutline => config.policies() && config.repository_retrieval,
            _ => true,
        }
    })
}

pub(crate) fn desktop_capability_tool_schema(id: CapabilityId) -> serde_json::Value {
    let mut schema = efficiency::capability_schema(id)
        .unwrap_or_else(|| desktop_capability_tool_schema_inner(id));
    if capability_uses_workspace_root(id) {
        schema["properties"]["rootId"] = serde_json::json!({
            "type": "string",
            "description": "Workspace root ID; required for multiple roots."
        });
    }
    schema
}

pub(crate) fn desktop_capability_tool_schema_inner(id: CapabilityId) -> serde_json::Value {
    // Domain modules own their schemas so this function keeps one delegation
    // guard per module instead of one match arm per capability.
    if let Some((properties, required)) = capability_output_budget::schema(id)
        .or_else(|| lsp_capability::schema(id))
        .or_else(|| workspace_edit_capability::schema(id))
        .or_else(|| workspace_path_capability::schema(id))
        .or_else(|| workspace_open_capability::schema(id))
        .or_else(|| git_history_capability::schema(id))
        .or_else(|| git_branch_service::schema(id))
        .or_else(|| web_fetch_capability::schema(id))
        .or_else(|| browser_viewport::schema(id))
        .or_else(|| memory_capability::schema(id))
        .or_else(|| subagent_capability::schema(id))
        .or_else(|| delegated_agents::schema(id))
        .or_else(|| code_mode::schema(id))
    {
        return serde_json::json!({
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": false,
        });
    }
    let properties = match id {
        CapabilityId::WorkspaceList => serde_json::json!({
            "path": { "type": "string", "description": "Optional workspace-relative directory to list." },
            "depth": { "type": "integer", "minimum": 1, "maximum": 8 },
            "offset": { "type": "integer", "minimum": 0 },
            "limit": { "type": "integer", "minimum": 1, "maximum": 200 },
            "maxBytes": workspace_result_bytes_schema()
        }),
        CapabilityId::WorkspaceSearch => serde_json::json!({
            "query": {
                "type": "string",
                "description": "Ripgrep regular expression. Use | for alternation and .* for wildcards."
            },
            "path": {
                "type": "string",
                "description": "Optional existing workspace-relative file or directory; omit for the root and put filename patterns in globs. A dot also selects the root. For a file path, omit globs. Never broadens a missing path."
            },
            "globs": { "type": "array", "items": { "type": "string" }, "description": "Optional ripgrep globs that filter files, such as [\"*.ts\", \"!*.test.ts\"]." },
            "maxResults": { "type": "integer", "minimum": 1, "maximum": 1000, "default": 50, "description": "Maximum matching lines to return." },
            "maxBytes": workspace_result_bytes_schema()
        }),
        CapabilityId::WorkspaceRead | CapabilityId::WorkspaceReadRange => serde_json::json!({
            "path": {
                "type": "string",
                "description": "Workspace-relative file path, or a spill:// address quoted by a prior preview."
            },
            "knownContentHash": { "type": "string", "pattern": "^[a-fA-F0-9]{64}$", "description": "Omit unchanged text when rechecking evidence already read at this hash. Omit this argument to read new content or a new range." },
            "line": { "type": "integer", "minimum": 1, "description": "First line to read, 1-based. With no endLine, reads 200 lines." },
            "endLine": { "type": "integer", "minimum": 1, "description": "Last line to read, 1-based and inclusive. At most 2,000 lines per call; the reply names where to continue." },
            "column": { "type": "integer", "minimum": 1, "description": "First column on line, 1-based." },
            "endColumn": { "type": "integer", "minimum": 1, "description": "Last column on endLine, 1-based." },
            "offset": {
                "type": "integer",
                "minimum": 0,
                "description": "Byte offset into a spill:// address. Ignored for file paths; the reply names the next offset."
            },
            "maxBytes": workspace_result_bytes_schema()
        }),
        CapabilityId::WorkspaceReadEditor => serde_json::json!({
            "path": { "type": "string" },
            "selectionOnly": { "type": "boolean" },
            "line": { "type": "integer", "minimum": 1 },
            "endLine": { "type": "integer", "minimum": 1 },
            "column": { "type": "integer", "minimum": 1 },
            "endColumn": { "type": "integer", "minimum": 1 },
            "maxBytes": workspace_result_bytes_schema()
        }),
        CapabilityId::IdeReveal => serde_json::json!({
            "path": { "type": "string" },
            "line": { "type": "integer", "minimum": 1 },
            "endLine": { "type": "integer", "minimum": 1 },
            "column": { "type": "integer", "minimum": 1 },
            "endColumn": { "type": "integer", "minimum": 1 }
        }),
        CapabilityId::IdeOpenPanel => serde_json::json!({
            "panel": {
                "type": "string",
                "enum": ["diff", "terminal", "browser", "problems", "test-results", "output"]
            }
        }),
        CapabilityId::BrowserOpen | CapabilityId::BrowserNavigate => serde_json::json!({
            "url": { "type": "string" },
            "reveal": {
                "type": "boolean",
                "default": false,
                "description": "Show the Browser panel only when the user explicitly asks to see the page or a required manual handoff such as sign-in needs it. Omit or set false for reading, research, implementation checks, interactions, screenshots, or rendering fallback; these work while hidden."
            }
        }),
        CapabilityId::BrowserSelectTarget => serde_json::json!({
            "targetId": {"type":"string","description":"ID returned by gyro_browser_targets, or web"}
        }),
        CapabilityId::BrowserPreviewClick => serde_json::json!({
            "captureId":{"type":"string"},"x":{"type":"number"},"y":{"type":"number"}
        }),
        CapabilityId::BrowserScreenshot => serde_json::json!({
            "device": { "type": "string", "enum": ["responsive", "desktop", "tablet", "mobile"] }
        }),
        CapabilityId::BrowserClick => serde_json::json!({
            "ref": { "type": "string", "description": "Element ref from read_page or find" }
        }),
        CapabilityId::BrowserMouse => serde_json::json!({
            "action": { "type": "string", "enum": ["hover", "click", "secondary-click", "drag"] },
            "captureId": { "type": "string", "description": "Filename from a recent screenshot of this chat's browser" },
            "x": { "type": "number", "description": "Start X in browser CSS pixels from the screenshot's top-left" },
            "y": { "type": "number", "description": "Start Y in browser CSS pixels from the screenshot's top-left" },
            "toX": { "type": "number", "description": "Required destination X for drag" },
            "toY": { "type": "number", "description": "Required destination Y for drag" }
        }),
        CapabilityId::BrowserType => serde_json::json!({
            "text": { "type": "string" },
            "ref": { "type": "string", "description": "Optional element ref; defaults to focused element" },
            "submit": { "type": "boolean" }
        }),
        CapabilityId::BrowserScroll => serde_json::json!({
            "dx": { "type": "number" },
            "dy": { "type": "number" },
            "ref": { "type": "string" }
        }),
        CapabilityId::BrowserFormInput => serde_json::json!({
            "ref": { "type": "string" },
            "value": { "type": "string" }
        }),
        CapabilityId::GithubRerunWorkflow => serde_json::json!({
            "runId": { "type": "integer", "minimum": 1 },
            "failedOnly": { "type": "boolean" }
        }),
        CapabilityId::GithubCreatePullRequest => serde_json::json!({
            "title": { "type": "string" },
            "body": { "type": "string" },
            "base": { "type": "string" },
            "draft": { "type": "boolean" }
        }),
        CapabilityId::ToolCatalog => serde_json::json!({
            "prefix": {
                "type": "string",
                "default": "gyro_",
                "description": "Domain prefix such as gyro_browser_ or gyro_github_."
            },
            "offset": { "type": "integer", "minimum": 0, "description": "Page start; pass nextOffset from the previous page." }
        }),
        _ => serde_json::json!({}),
    };
    let required = match id {
        CapabilityId::WorkspaceSearch => vec!["query"],
        CapabilityId::WorkspaceRead
        | CapabilityId::WorkspaceReadRange
        | CapabilityId::WorkspaceReadEditor
        | CapabilityId::IdeReveal => vec!["path"],
        CapabilityId::WorkspaceRunTask | CapabilityId::WorkspaceRunTest => vec!["taskId"],
        CapabilityId::IdeOpenPanel => vec!["panel"],
        CapabilityId::TerminalOpen => vec!["program"],
        CapabilityId::TerminalWait => vec!["resourceId"],
        CapabilityId::BrowserOpen | CapabilityId::BrowserNavigate => vec!["url"],
        CapabilityId::BrowserSelectTarget => vec!["targetId"],
        CapabilityId::BrowserPreviewClick => vec!["captureId", "x", "y"],
        CapabilityId::BrowserClick => vec!["ref"],
        CapabilityId::BrowserMouse => vec!["action", "captureId", "x", "y"],
        CapabilityId::BrowserType => vec!["text"],
        CapabilityId::BrowserFormInput => vec!["ref", "value"],
        CapabilityId::GithubWorkflowLogs | CapabilityId::GithubRerunWorkflow => vec!["runId"],
        CapabilityId::GithubCreatePullRequest => vec!["title"],
        _ => Vec::new(),
    };
    serde_json::json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
}

pub(crate) fn desktop_capability_tool_call(
    paths: &GyroPaths,
    context: &DesktopProviderCapabilityContext,
    params: serde_json::Value,
) -> anyhow::Result<serde_json::Value> {
    let name = params
        .get("name")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("capability tool name is required"))?;
    let call_id = Uuid::new_v4();
    let empty = serde_json::json!({});
    let arguments = params.get("arguments").unwrap_or(&empty);
    let (capability_id, arguments) =
        if context.compact_catalog && name == provider_tool_batch::COMPACT_INVOKE {
            let allow_delegation =
                context.allow_delegation && delegated_agents::can_delegate(&context.session_id);
            match provider_tool_batch::resolve_tool_call(
                name,
                arguments,
                context.mode,
                allow_delegation,
                true,
            ) {
                Ok(resolved) => resolved,
                Err(message) => {
                    return capability_mcp_response(
                        paths,
                        CapabilityResponse::failed(
                            env!("CARGO_PKG_VERSION"),
                            call_id,
                            "invalid-arguments",
                            message,
                        ),
                        provider_accepts_images(&context.provider_id),
                    );
                }
            }
        } else {
            let capability_id = CapabilityId::from_provider_tool_name(name)
                .ok_or_else(|| anyhow::anyhow!("unknown Gyro capability tool"))?;
            (capability_id, arguments.clone())
        };
    let request = CapabilityRequest {
        schema: PROVIDER_CAPABILITY_IPC_SCHEMA_V1.into(),
        sender_version: env!("CARGO_PKG_VERSION").into(),
        context: CapabilityInvocationContext {
            session_id: context.session_id.clone(),
            turn_id: context.turn_id.clone(),
            provider_id: context.provider_id.clone(),
            run_nonce: context.run_nonce.clone(),
            call_id,
            workspace_key: context.workspace_key.clone(),
            mode: context.mode,
            policy_revision: context.policy_revision,
            workspace_context_revision: context.workspace_context_revision,
        },
        capability_id,
        arguments,
    };
    let response = request_desktop_provider_capability(paths, &request).unwrap_or_else(|error| {
        CapabilityResponse::failed(
            env!("CARGO_PKG_VERSION"),
            call_id,
            "tools-unavailable",
            format!(
                "Gyro tools unavailable: {}",
                gyro_core::sanitize_capability_summary(&error.to_string())
            ),
        )
    });
    capability_mcp_response(
        paths,
        response,
        provider_accepts_images(&context.provider_id),
    )
}

/// Read only a capture returned by the trusted broker, never a model-supplied
/// path. Image bytes travel outside the bounded structured observation.
pub(crate) fn browser_result_image(
    paths: &GyroPaths,
    response: &CapabilityResponse,
) -> anyhow::Result<Option<String>> {
    let Some(result) = response.result.as_ref().filter(|result| {
        response.status == CapabilityStatus::Completed
            && matches!(
                result.capability_id,
                CapabilityId::BrowserScreenshot | CapabilityId::BrowserCapturePreview
            )
            && result.data["schema"] == BROWSER_OBSERVATION_SCHEMA_V1
    }) else {
        return Ok(None);
    };
    let capture_path = result.data["screenshot"]["path"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("browser capture path is missing"))?;
    let capture_path = Path::new(capture_path).canonicalize()?;
    let capture_root = paths.browser_captures_dir.canonicalize()?;
    anyhow::ensure!(
        capture_path.parent() == Some(capture_root.as_path()),
        "browser capture is outside private capture storage"
    );
    let mut bytes = Vec::new();
    fs::File::open(capture_path)?
        .take((MAX_BROWSER_PREVIEW_CAPTURE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    anyhow::ensure!(
        bytes.len() <= MAX_BROWSER_PREVIEW_CAPTURE_BYTES && bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "browser capture is invalid or exceeds the image size limit"
    );
    Ok(Some(
        base64::engine::general_purpose::STANDARD.encode(bytes),
    ))
}

pub(crate) use gyro_core::provider_runtime::tool_batch::mark_browser_image_attached;

pub(crate) fn capability_mcp_response(
    paths: &GyroPaths,
    mut response: CapabilityResponse,
    supports_images: bool,
) -> anyhow::Result<serde_json::Value> {
    let image = if supports_images {
        browser_result_image(paths, &response)?
    } else {
        None
    };
    if image.is_some() {
        mark_browser_image_attached(&mut response);
    }
    let is_error = response.status != CapabilityStatus::Completed;
    let text = if let Some(mut result) = response.result {
        provider_tool_batch::spill_result_data(
            result.capability_id.as_str(),
            result.capability_id.provider_tool_name(),
            &mut result.data,
        );
        serde_json::to_string(&serde_json::json!({
            "callId": result.call_id,
            "capabilityId": result.capability_id,
            "summary": result.summary,
            "data": result.data,
            "resource": result.resource,
        }))?
    } else {
        serde_json::to_string(&serde_json::json!({
            "callId": response.call_id,
            "error": response.error,
        }))?
    };
    let mut content = vec![serde_json::json!({ "type": "text", "text": text })];
    if let Some(data) = image {
        content.push(serde_json::json!({ "type": "image", "mimeType": "image/png", "data": data }));
    }
    Ok(serde_json::json!({
        "content": content,
        "isError": is_error,
    }))
}

pub(crate) fn write_desktop_mcp_message(
    output: &mut impl Write,
    message: &serde_json::Value,
) -> anyhow::Result<()> {
    // Outgoing capability results may carry a base64 PNG. Incoming requests
    // retain the smaller protocol limit; structured IPC results are unchanged.
    write_bounded_json_line(
        output,
        message,
        MAX_PERMISSION_MCP_MESSAGE_BYTES + 4 * MAX_BROWSER_PREVIEW_CAPTURE_BYTES.div_ceil(3),
    )
    .map_err(anyhow::Error::msg)
}

pub fn run_provider_permission_server() -> anyhow::Result<()> {
    let context = DesktopProviderPermissionContext::from_env()?;
    let paths = desktop_provider_ipc_paths()?;
    provider_mcp::serve(
        &mut std::io::stdin().lock(),
        std::io::stdout(),
        "gyro-desktop-approval",
        vec![serde_json::json!({
            "name": "approve",
            "description": "Ask Gyro.app to approve or reject one Claude Code tool action.",
            "inputSchema": {
                "type": "object",
                "additionalProperties": true,
            },
        })],
        |params| desktop_permission_tool_call(&paths, &context, params),
    )
}

pub fn run_provider_capability_server() -> anyhow::Result<()> {
    let context = DesktopProviderCapabilityContext::from_env()?;
    let paths = desktop_provider_ipc_paths()?;
    let allow_delegation =
        context.allow_delegation && delegated_agents::can_delegate(&context.session_id);
    provider_mcp::serve(
        &mut std::io::stdin().lock(),
        std::io::stdout(),
        "gyro-provider-capabilities",
        provider_tool_batch::mcp_tools_for(context.mode, allow_delegation, context.compact_catalog),
        |params| desktop_capability_tool_call(&paths, &context, params),
    )
}
