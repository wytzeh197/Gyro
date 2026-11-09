use crate::{context_compaction, conversation_history::acp_conversation_history_text_for_session};
use gyro_core::augmented_gui_path;
pub(crate) use gyro_core::provider_runtime::api_config::provider_adapter_for;
use std::process::Command;

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
