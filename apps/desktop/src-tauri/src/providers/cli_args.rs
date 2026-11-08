use crate::{
    model_catalog, provider_tool_batch,
    providers::chat_types::{ChatAttachmentRequest, ChatMode},
};
use std::path::Path;
#[allow(clippy::too_many_arguments)]
pub(crate) fn codex_chat_args(
    resume_session_id: Option<&str>,
    output_path: &Path,
    model_id: Option<&str>,
    reasoning_effort: Option<&str>,
    mode: &ChatMode,
    require_command_approval: bool,
    require_file_edit_approval: bool,
    full_access: bool,
    attachments: &[ChatAttachmentRequest],
    prompt: &str,
) -> Vec<String> {
    let mut args = vec!["exec".into()];
    let full_access = *mode == ChatMode::Normal
        && full_access
        && !require_command_approval
        && !require_file_edit_approval;
    if resume_session_id.is_some() {
        args.push("resume".into());
    } else {
        args.push("--skip-git-repo-check".into());
        if full_access {
            args.push("--dangerously-bypass-approvals-and-sandbox".into());
        } else {
            args.extend(["--sandbox".into(), "read-only".into()]);
        }
    }
    args.push("--json".into());
    args.extend(["-c".into(), "features.multi_agent=false".into()]);
    args.push("--output-last-message".into());
    args.push(output_path.display().to_string());
    if resume_session_id.is_some() {
        args.push("--skip-git-repo-check".into());
        if full_access {
            args.push("--dangerously-bypass-approvals-and-sandbox".into());
        } else {
            // `codex exec resume` does not accept the top-level `--sandbox`
            // option. Apply the same read-only policy through its supported
            // config override so Plan mode and approval-gated resumes start.
            args.extend(["--config".into(), "sandbox_mode=\"read-only\"".into()]);
        }
    }
    if let Some(model) = codex_model_arg(model_id) {
        args.push("--model".into());
        args.push(model);
    }
    if let Some(effort) = codex_reasoning_effort_arg(model_id, reasoning_effort) {
        args.push("--config".into());
        args.push(format!("model_reasoning_effort=\"{effort}\""));
    }
    if let Some(session_id) = resume_session_id {
        args.push(session_id.into());
    }
    for attachment in attachments.iter().filter(|item| item.kind == "image") {
        args.push("--image".into());
        args.push(attachment.path.clone());
    }
    // `codex exec --image <FILE>...` is variadic. Without an option terminator,
    // Clap can consume the chat prompt as another image path and then fall back
    // to an empty stdin stream.
    args.push("--".into());
    args.push(prompt.into());
    args
}

/// Plan can reach discovery, so it gets the wrapper too; Council lists no tools.
pub(crate) fn claude_allowed_capability_tools(tools: String, compact: bool) -> String {
    if compact && tools.contains("mcp__gyro_capabilities__gyro_tool_catalog") {
        format!(
            "{tools},mcp__gyro_capabilities__{}",
            provider_tool_batch::COMPACT_INVOKE
        )
    } else {
        tools
    }
}

pub(crate) fn codex_model_arg(model_id: Option<&str>) -> Option<String> {
    let model = model_id?.trim();
    if model.is_empty() {
        return None;
    }
    let normalized = model.to_ascii_lowercase();
    // Preserve the requested model for Codex to validate against its actual
    // sign-in route. GPT-5.4 is still valid with API keys; GPT-5.5 is active
    // until October 14. Never silently run the CLI default under those labels.
    if normalized == "gpt-5" {
        return None;
    }
    Some(model.to_string())
}

pub(crate) fn codex_reasoning_effort_arg(
    model_id: Option<&str>,
    reasoning_effort: Option<&str>,
) -> Option<String> {
    let effort = reasoning_effort?.trim().to_ascii_lowercase();
    let model = model_id?.trim().to_ascii_lowercase();
    // The published catalog speaks for the model first, so a model added
    // after this release runs with the levels it actually has.
    if let Some(efforts) = model_catalog::catalog_reasoning_efforts("openai", Some(&model)) {
        return efforts.contains(&effort).then_some(effort);
    }
    let supported = match model.as_str() {
        "gpt-6.1-sol" | "gpt-6-astra" | "gpt-6-sol" | "gpt-5.6-sol" | "gpt-5.6-terra" => {
            matches!(
                effort.as_str(),
                "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
            )
        }
        "gpt-6-luna" | "gpt-5.6-luna" => {
            matches!(effort.as_str(), "low" | "medium" | "high" | "xhigh" | "max")
        }
        "gpt-5.5" | "gpt-5.4" | "gpt-5.4-mini" | "gpt-5" => {
            matches!(effort.as_str(), "low" | "medium" | "high" | "xhigh")
        }
        // Models the remote catalog adds after a release are unknown here.
        // Codex validates the level itself, so any word from the shared
        // vocabulary is forwarded rather than failing the run locally.
        _ => matches!(
            effort.as_str(),
            "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
        ),
    };
    supported.then_some(effort)
}

pub(crate) use gyro_core::provider_runtime::support::{
    audit_provider_chat_args, provider_chat_cwd,
};

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn claude_chat_args(
    resume_session_id: Option<&str>,
    session_id: &str,
    model_id: Option<&str>,
    reasoning_effort: Option<&str>,
    mode: &ChatMode,
    require_command_approval: bool,
    require_file_edit_approval: bool,
    full_access: bool,
    permission_mcp_config: Option<&str>,
    prompt: &str,
) -> Vec<String> {
    gyro_core::provider_runtime::native_args::claude_chat_args(
        resume_session_id,
        session_id,
        model_id,
        reasoning_effort,
        mode,
        require_command_approval,
        require_file_edit_approval,
        full_access,
        permission_mcp_config,
        prompt,
        claude_allowed_capability_tools(
            advertised_mcp_capability_tools(capability_run_mode_for_chat(*mode)),
            provider_tool_batch::compact_cli_catalog_active("anthropic", &efficiency::config()),
        ),
        model_catalog::catalog_reasoning_efforts("anthropic", model_id).as_deref(),
    )
}
#[cfg(test)]
pub(crate) fn claude_reasoning_effort_arg(
    model_id: Option<&str>,
    reasoning_effort: Option<&str>,
) -> Option<String> {
    gyro_core::provider_runtime::native_args::claude_reasoning_effort_arg(
        model_id,
        reasoning_effort,
        model_catalog::catalog_reasoning_efforts("anthropic", model_id).as_deref(),
    )
}
#[cfg(test)]
pub(crate) use gyro_core::provider_runtime::native_args::claude_model_arg;

#[cfg(test)]
use crate::{
    efficiency,
    providers::binding::{advertised_mcp_capability_tools, capability_run_mode_for_chat},
};

#[cfg(test)]
pub(crate) fn grok_reasoning_effort_arg(
    model_id: Option<&str>,
    reasoning_effort: Option<&str>,
) -> Option<String> {
    gyro_core::provider_runtime::native_args::grok_reasoning_effort_arg(
        model_id,
        reasoning_effort,
        model_catalog::catalog_reasoning_efforts("xai", model_id).as_deref(),
    )
}
