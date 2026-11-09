use crate::{
    context_compaction,
    conversation_history::acp_conversation_history_text_for_session,
    openai_compatible_runner,
    providers::{
        streaming::PROVIDER_CHAT_INACTIVITY_TIMEOUT_SECS,
        types::{ProviderAdapterDescriptor, ProviderAdapterKind},
    },
};
use gyro_core::{
    augmented_gui_path, is_openai_compatible_provider, provider_descriptor, ProviderExecutionKind,
};
use std::process::Command;
pub(crate) fn provider_adapter_for(provider_id: &str) -> ProviderAdapterDescriptor {
    let Some(descriptor) = provider_descriptor(provider_id) else {
        // A provider Gyro does not ship. An endpoint the user defined runs over
        // HTTPS; anything else stays readiness-only.
        if is_openai_compatible_provider(
            provider_id,
            openai_compatible_runner::declared_provider_kind(provider_id).as_deref(),
        ) {
            return openai_compatible_runner::openai_compatible_adapter();
        }
        return ProviderAdapterDescriptor {
            kind: ProviderAdapterKind::ReadinessOnly,
            runner: "readiness-only",
            auth_owner: "provider-owned",
            timeout_seconds: 0,
        };
    };
    let kind = match descriptor.execution_kind {
        ProviderExecutionKind::CodexCli => ProviderAdapterKind::OpenAiCodex,
        ProviderExecutionKind::ClaudeCode => ProviderAdapterKind::AnthropicClaude,
        ProviderExecutionKind::KimiAcp => ProviderAdapterKind::KimiAcp,
        ProviderExecutionKind::AntigravityCli => ProviderAdapterKind::AntigravityCli,
        ProviderExecutionKind::AcpCli => ProviderAdapterKind::KimiAcp,
        ProviderExecutionKind::OllamaApi => ProviderAdapterKind::Ollama,
        ProviderExecutionKind::OpenAiCompatibleApi => ProviderAdapterKind::OpenAiCompatible,
        ProviderExecutionKind::ReadinessOnly => ProviderAdapterKind::ReadinessOnly,
    };
    ProviderAdapterDescriptor {
        kind,
        runner: descriptor.runner,
        auth_owner: descriptor.auth_owner,
        timeout_seconds: if kind == ProviderAdapterKind::ReadinessOnly {
            0
        } else {
            PROVIDER_CHAT_INACTIVITY_TIMEOUT_SECS
        },
    }
}

/// Recent user/assistant turns for agents that cannot reopen a provider session.
pub(crate) fn acp_conversation_history_text(
    _app: &tauri::AppHandle,
    session_id: &str,
) -> Option<String> {
    if context_compaction::summary_stream_muted(session_id) {
        return None;
    }
    acp_conversation_history_text_for_session(session_id)
}

pub(crate) fn command_with_gui_path(command: &str) -> Command {
    let mut process = Command::new(command);
    if !command.contains('/') {
        process.env("PATH", augmented_gui_path());
    }
    process
}

pub(crate) fn command_for_provider(command: &str, provider_id: &str) -> anyhow::Result<Command> {
    #[allow(unused_mut)]
    let mut process = command_with_gui_path(command);
    // Unit CLI peers do not consume the user's credential store; the compiled
    // native benchmark verifies authentication through the production reader.
    #[cfg(not(test))]
    gyro_core::try_apply_stored_provider_api_key(&mut process, provider_id)?;
    #[cfg(test)]
    let _ = provider_id;
    Ok(process)
}

pub(crate) use gyro_core::provider_runtime::support::provider_output_summary;

#[cfg(test)]
pub(crate) fn build_grok_acp_program_args(
    model_id: Option<&str>,
    reasoning_effort: Option<&str>,
    posture: gyro_core::ApprovalPosture,
) -> Vec<std::ffi::OsString> {
    gyro_core::provider_runtime::native_args::build_grok_acp_program_args(
        model_id,
        reasoning_effort,
        posture,
        crate::model_catalog::catalog_reasoning_efforts("xai", model_id).as_deref(),
    )
}

#[cfg(test)]
pub(crate) use gyro_core::provider_runtime::support::provider_stream_failure_detail;

pub(crate) use gyro_core::provider_runtime::support::is_stale_resume_error;
