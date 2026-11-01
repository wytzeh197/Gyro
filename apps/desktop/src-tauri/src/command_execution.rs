//! Bounded command execution and credential handling for model-owned tools.
use super::*;
use gyro_core::workspace_sandbox::PreparedWorkspaceSandbox;

/// Selected only by the capability broker. A renderer cannot opt a command
/// out of confinement or choose its writable root. Retained across PTY restart.
#[derive(Clone, Debug, Default)]
pub(super) enum ModelCommandBoundary {
    #[default]
    Unrestricted,
    Workspace {
        root: PathBuf,
        home: PathBuf,
        private_data_root: PathBuf,
    },
}

#[derive(Clone, Debug)]
pub(super) struct ModelCommandContext {
    session_id: String,
    mode: CapabilityRunMode,
    workspace: PathBuf,
}

impl ModelCommandContext {
    pub(super) fn from_bound(bound: &BoundProviderCapabilityContext) -> Self {
        Self {
            session_id: bound.session_id.clone(),
            mode: bound.policy.mode,
            workspace: bound.workspace.clone(),
        }
    }
}

impl ModelCommandBoundary {
    pub(super) fn prepare(
        &self,
        cwd: Option<&Path>,
    ) -> anyhow::Result<Option<PreparedWorkspaceSandbox>> {
        match self {
            Self::Unrestricted => Ok(None),
            Self::Workspace {
                root,
                home,
                private_data_root,
            } => {
                let cwd =
                    cwd.ok_or_else(|| anyhow::anyhow!("model command has no working directory"))?;
                PreparedWorkspaceSandbox::prepare(root, cwd, home, Some(private_data_root))
                    .map(Some)
            }
        }
    }

    pub(super) fn policy_name(&self) -> &'static str {
        match self {
            Self::Unrestricted => "unrestricted",
            Self::Workspace { .. } => "workspace-filesystem",
        }
    }

    pub(super) fn summary(&self) -> &'static str {
        model_command_policy_summary(self.policy_name())
    }

    /// Restart can tighten a Full access pane but never silently upgrade an
    /// existing confined pane or move its trusted workspace root.
    pub(super) fn tighten_for_restart(&mut self, current: Self) {
        if matches!(self, Self::Unrestricted) {
            *self = current;
        }
    }
}

pub(super) fn model_command_policy_summary(policy: &str) -> &'static str {
    match policy {
        "workspace-filesystem" => "workspace filesystem policy; network allowed",
        "unrestricted" => "Full access",
        _ => "unknown execution policy",
    }
}

fn model_command_full_access(
    config: &GyroConfig,
    mode: CapabilityRunMode,
    child_ceiling: bool,
) -> bool {
    capability_full_access_enabled(config) && mode == CapabilityRunMode::Normal && child_ceiling
}

pub(super) fn model_command_boundary(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
) -> anyhow::Result<ModelCommandBoundary> {
    model_command_boundary_for_context(app, &ModelCommandContext::from_bound(bound))
}

fn model_command_boundary_for_context(
    app: &tauri::AppHandle,
    context: &ModelCommandContext,
) -> anyhow::Result<ModelCommandBoundary> {
    let config = load_config_blocking().map_err(anyhow::Error::msg)?;
    if model_command_full_access(
        &config,
        context.mode,
        delegated_agents::full_access_ceiling(app, &context.session_id),
    ) {
        return Ok(ModelCommandBoundary::Unrestricted);
    }
    Ok(ModelCommandBoundary::Workspace {
        root: context.workspace.clone(),
        home: user_home_directory()?,
        private_data_root: GyroPaths::for_current_user()?.base_dir,
    })
}

pub(super) fn refresh_model_terminal_boundary(
    app: &tauri::AppHandle,
    request: &mut TerminalPaneRequest,
) -> anyhow::Result<()> {
    if let Some(context) = request.model_command_context.as_ref() {
        let current = model_command_boundary_for_context(app, context)?;
        request.execution_boundary.tighten_for_restart(current);
    }
    Ok(())
}

/// Model-owned shell commands do not need a provider's authentication. Keep
/// this separate from provider launches and human-triggered workspace tasks.
pub(super) fn run_model_task_output_with_cancellation(
    command: Command,
    cancellation: CancellationToken,
    boundary: &ModelCommandBoundary,
) -> anyhow::Result<IdeCommandOutput> {
    let mut request = execution_request(&command);
    // Keep scratch alive until the bounded runner has reaped the command.
    // A failed preparation or sandbox-exec launch never retries unrestricted.
    let sandbox = boundary.prepare(request.current_dir.as_deref())?;
    if let Some(sandbox) = sandbox.as_ref() {
        (request.program, request.args) = sandbox.wrap_command(&request.program, &request.args);
        request.env.extend(
            sandbox
                .environment()
                .into_iter()
                .map(|(key, value)| (key, Some(value))),
        );
    }
    request.timeout = Duration::from_secs(30 * 60);
    request.inactivity_timeout = Some(Duration::from_secs(5 * 60));
    request.max_stdout_chars = 2 * 1024 * 1024;
    request.max_stderr_chars = 1024 * 1024;
    request.credentials = CredentialPolicy::scrubbed();
    // The shared runner permits intentional env overrides after scrubbing.
    // Model tools have no such exception: strip credential-shaped overrides
    // as well, while leaving the provider-launch contract unchanged.
    let denied = request
        .credentials
        .env_overrides_from(request.env.iter().map(|(key, _)| key.clone()));
    for (key, value) in &mut request.env {
        if denied.iter().any(|(denied, _)| denied == key) {
            *value = None;
        }
    }
    let output = gyro_core::run_command(request, cancellation, |_| {})?;
    Ok(command_output(output))
}

pub(super) fn model_terminal_request(
    pane_id: String,
    title: String,
    command: String,
    args: Vec<String>,
    workspace_key: &str,
    cwd: &Path,
    boundary: ModelCommandBoundary,
) -> TerminalPaneRequest {
    TerminalPaneRequest {
        pane_id,
        title,
        command,
        args,
        workspace_path: Some(workspace_key.to_string()),
        workspace_mode: Some("local".into()),
        working_directory: Some(cwd.display().to_string()),
        credential_policy: CredentialPolicy::scrubbed(),
        execution_boundary: boundary,
        cols: Some(120),
        rows: Some(32),
        ..Default::default()
    }
}

pub(super) fn apply_terminal_credential_policy(
    command: &mut CommandBuilder,
    policy: &CredentialPolicy,
) {
    if !policy.is_scrubbed() {
        return;
    }
    // portable-pty snapshots the parent's environment at construction. Its
    // string iterator omits entries with non-UTF-8 values, so include parent
    // names too. All terminal-specific overrides use String values.
    let names = std::env::vars_os().map(|(key, _)| key).chain(
        command
            .iter_full_env_as_str()
            .map(|(key, _)| std::ffi::OsString::from(key)),
    );
    let removals = policy.env_overrides_from(names);
    for (name, _) in removals {
        command.env_remove(name);
    }
}

pub(super) fn run_command_output(command: Command) -> anyhow::Result<IdeCommandOutput> {
    run_command_output_with_cancellation(command, CancellationToken::default())
}

pub(super) fn run_command_output_with_cancellation(
    command: Command,
    cancellation: CancellationToken,
) -> anyhow::Result<IdeCommandOutput> {
    run_command_output_with_limits(
        command,
        cancellation,
        Duration::from_secs(30 * 60),
        Some(Duration::from_secs(5 * 60)),
    )
}

/// Build and test commands can be quiet while they compile or download. Keep
/// them cancellable, but do not treat silence as a failure or stop them after
/// the short task window used by incidental helper commands.
pub(super) fn run_workspace_task_output_with_cancellation(
    command: Command,
    cancellation: CancellationToken,
) -> anyhow::Result<IdeCommandOutput> {
    run_command_output_with_limits(
        command,
        cancellation,
        Duration::from_secs(2 * 60 * 60),
        None,
    )
}

pub(super) fn run_command_output_with_limits(
    command: Command,
    cancellation: CancellationToken,
    timeout: Duration,
    inactivity_timeout: Option<Duration>,
) -> anyhow::Result<IdeCommandOutput> {
    let output = run_bounded_command_with_cancellation(
        &command,
        timeout,
        inactivity_timeout,
        2 * 1024 * 1024,
        1024 * 1024,
        cancellation,
    )?;
    Ok(command_output(output))
}

fn command_output(output: gyro_core::ExecutionOutcome) -> IdeCommandOutput {
    let mut stdout = gyro_core::security::redact_secrets(&output.stdout);
    let mut stderr = gyro_core::security::redact_secrets(&output.stderr);
    if output.stdout_truncated {
        stdout.push_str("\n[stdout truncated by Gyro]");
    }
    if output.stderr_truncated {
        stderr.push_str("\n[stderr truncated by Gyro]");
    }
    IdeCommandOutput {
        exit_code: match output.termination {
            ExecutionTermination::Exited { code } => code,
            _ => None,
        },
        source_truncated: output.stdout_truncated || output.stderr_truncated,
        status: match output.termination {
            ExecutionTermination::Exited { code: Some(0) } => "done",
            ExecutionTermination::Cancelled => "cancelled",
            ExecutionTermination::TimedOut => "timed-out",
            ExecutionTermination::Inactive => "inactive",
            ExecutionTermination::OutputLimit => "output-limit",
            ExecutionTermination::Exited { .. } => "failed",
        }
        .into(),
        stdout,
        stderr,
    }
}

pub(super) fn run_bounded_command(
    command: &Command,
    timeout: Duration,
    inactivity_timeout: Option<Duration>,
    max_stdout_chars: usize,
    max_stderr_chars: usize,
) -> anyhow::Result<gyro_core::ExecutionOutcome> {
    run_bounded_command_with_cancellation(
        command,
        timeout,
        inactivity_timeout,
        max_stdout_chars,
        max_stderr_chars,
        CancellationToken::default(),
    )
}

pub(super) fn run_bounded_command_with_cancellation(
    command: &Command,
    timeout: Duration,
    inactivity_timeout: Option<Duration>,
    max_stdout_chars: usize,
    max_stderr_chars: usize,
    cancellation: CancellationToken,
) -> anyhow::Result<gyro_core::ExecutionOutcome> {
    let mut request = execution_request(command);
    request.timeout = timeout;
    request.inactivity_timeout = inactivity_timeout;
    request.max_stdout_chars = max_stdout_chars;
    request.max_stderr_chars = max_stderr_chars;
    gyro_core::run_command(request, cancellation, |_| {})
}

fn execution_request(command: &Command) -> ExecutionRequest {
    let mut request = ExecutionRequest::new(command.get_program().to_os_string());
    request.args = command
        .get_args()
        .map(std::ffi::OsStr::to_os_string)
        .collect();
    request.current_dir = command.get_current_dir().map(Path::to_path_buf);
    request.env = command
        .get_envs()
        .map(|(key, value)| (key.to_os_string(), value.map(std::ffi::OsStr::to_os_string)))
        .collect();
    request
}

pub(super) fn bounded_command_error(
    label: &str,
    output: &gyro_core::ExecutionOutcome,
) -> anyhow::Error {
    let reason = match &output.termination {
        ExecutionTermination::Exited { code } => format!("exited with {code:?}"),
        ExecutionTermination::Cancelled => "was cancelled".into(),
        ExecutionTermination::TimedOut => "timed out".into(),
        ExecutionTermination::Inactive => "stopped after no output".into(),
        ExecutionTermination::OutputLimit => "exceeded its output limit".into(),
    };
    let detail = output.stderr.trim();
    if detail.is_empty() {
        anyhow::anyhow!("{label} {reason}")
    } else {
        anyhow::anyhow!("{label} {reason}: {}", truncate_error_detail(detail))
    }
}

#[cfg(test)]
#[path = "command_execution_tests.rs"]
mod tests;
