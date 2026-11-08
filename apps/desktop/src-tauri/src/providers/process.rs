use crate::{
    context_compaction,
    conversation_history::acp_conversation_history_text_for_session,
    openai_compatible_runner,
    providers::{
        cli_args::grok_reasoning_effort_arg,
        streaming::PROVIDER_CHAT_INACTIVITY_TIMEOUT_SECS,
        types::{ProviderAdapterDescriptor, ProviderAdapterKind},
    },
};
use gyro_core::{
    augmented_gui_path, is_openai_compatible_provider, provider_descriptor, ProviderExecutionKind,
};
use std::process::{Child, Command};
#[cfg(unix)]
use std::time::Duration;
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

/// Whether an error means the stored provider cursor is dead.
///
/// A true stale-resume error is one short sentence from the CLI. A failed
/// stream-json run, however, arrives here as its entire transcript: every frame
/// carries a session id, which is one half of the test below, and any tool that
/// touched a missing path contributes "no such file", which is the other. Read
/// together across thousands of unrelated characters they looked exactly like a
/// dead cursor, so an ordinary failure cleared the binding and the conversation
/// it pointed at could no longer be resumed.
///
/// Classifying sentence by sentence is what keeps the two halves from meeting.
pub(crate) fn is_stale_resume_error(error: &str) -> bool {
    error
        .lines()
        .filter_map(provider_error_sentence)
        .any(|sentence| is_stale_resume_sentence(&sentence))
}

pub(crate) fn is_stale_resume_sentence(sentence: &str) -> bool {
    // Long enough for any CLI's error sentence, short enough that a pasted
    // transcript or a file dump cannot qualify as one.
    const MAX_RESUME_ERROR_SENTENCE_CHARS: usize = 400;
    if sentence.chars().count() > MAX_RESUME_ERROR_SENTENCE_CHARS {
        return false;
    }
    let normalized = sentence.to_ascii_lowercase();
    // Grok ACP returns bare "Method not found" when session/resume is not
    // implemented — treat that as a dead cursor so Retry starts clean.
    if normalized.contains("method not found")
        || normalized.contains("method_not_found")
        || normalized.contains("-32601")
    {
        return true;
    }
    let resume_identity = normalized.contains("resume")
        || normalized.contains("session")
        || normalized.contains("thread");
    let missing_identity = normalized.contains("not found")
        || normalized.contains("no such")
        || normalized.contains("unknown")
        || normalized.contains("missing")
        || normalized.contains("expired")
        || normalized.contains("could not resume")
        // Claude Code's own wording for a session id it cannot load: "No
        // conversation found with session ID: <id>". It reads as a match for
        // "found" rather than "not found", so without this the cursor was
        // never cleared and every retry failed the same way.
        || normalized.contains("no conversation");
    resume_identity && missing_identity
}

/// Build Grok ACP spawn args with model/effort at process start.
pub(crate) fn build_grok_acp_program_args(
    model_id: Option<&str>,
    reasoning_effort: Option<&str>,
    posture: gyro_core::ApprovalPosture,
) -> Vec<std::ffi::OsString> {
    let effort = grok_reasoning_effort_arg(model_id, reasoning_effort);
    gyro_core::grok::format_acp_program_args(model_id, effort.as_deref(), posture)
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

pub(crate) struct ProviderProcessGuard {
    pub(crate) child: gyro_core::process_guard::GuardedChild,
}

impl ProviderProcessGuard {
    /// Registered so quitting Gyro tears the group down: it runs in its own
    /// process group and gets no SIGHUP from the app exiting.
    pub(crate) fn new(child: gyro_core::process_guard::GuardedChild) -> Self {
        gyro_core::register_process_group(child.id());
        Self { child }
    }
}

impl std::ops::Deref for ProviderProcessGuard {
    type Target = Child;

    fn deref(&self) -> &Self::Target {
        &self.child
    }
}

impl std::ops::DerefMut for ProviderProcessGuard {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.child
    }
}

impl Drop for ProviderProcessGuard {
    fn drop(&mut self) {
        terminate_provider_process_group(&mut self.child);
        gyro_core::unregister_process_group(self.child.id());
    }
}

#[cfg(unix)]
pub(crate) fn configure_provider_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
}

#[cfg(not(unix))]
pub(crate) fn configure_provider_process_group(_command: &mut Command) {}

#[cfg(unix)]
pub(crate) fn terminate_provider_process_group(child: &mut Child) {
    let process_group = -(child.id() as i32);
    unsafe {
        libc::kill(process_group, libc::SIGTERM);
    }
    for _ in 0..10 {
        let _ = child.try_wait();
        let group_exists = unsafe { libc::kill(process_group, 0) } == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
        if !group_exists {
            let _ = child.wait();
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    unsafe {
        libc::kill(process_group, libc::SIGKILL);
    }
    let _ = child.wait();
}

#[cfg(not(unix))]
pub(crate) fn terminate_provider_process_group(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

pub(crate) use gyro_core::provider_runtime::support::{
    provider_error_sentence, provider_output_summary, provider_stream_failure_detail,
};
