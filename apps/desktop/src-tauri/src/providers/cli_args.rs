use crate::provider_tool_batch;
#[cfg(test)]
use crate::{
    model_catalog,
    providers::chat_types::{ChatAttachmentRequest, ChatMode},
};
#[cfg(test)]
use std::path::Path;

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

#[cfg(test)]
pub(crate) use gyro_core::provider_runtime::support::provider_chat_cwd;

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

#[cfg(test)]
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
    gyro_core::provider_runtime::native_args::codex_chat_args(
        resume_session_id,
        output_path,
        model_id,
        reasoning_effort,
        mode,
        require_command_approval,
        require_file_edit_approval,
        full_access,
        attachments,
        prompt,
        model_catalog::catalog_reasoning_efforts(
            "openai",
            model_id
                .map(str::trim)
                .map(str::to_ascii_lowercase)
                .as_deref(),
        )
        .as_deref(),
    )
}
#[cfg(test)]
pub(crate) fn codex_reasoning_effort_arg(
    model_id: Option<&str>,
    reasoning_effort: Option<&str>,
) -> Option<String> {
    gyro_core::provider_runtime::native_args::codex_reasoning_effort_arg(
        model_id,
        reasoning_effort,
        model_catalog::catalog_reasoning_efforts(
            "openai",
            model_id
                .map(str::trim)
                .map(str::to_ascii_lowercase)
                .as_deref(),
        )
        .as_deref(),
    )
}
#[cfg(test)]
pub(crate) use gyro_core::provider_runtime::native_args::codex_model_arg;
