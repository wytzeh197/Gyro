use anyhow::{anyhow, Context, Result};
use clap::{Args, Parser, Subcommand};
use gyro_core::{
    config::CommandProfile, create_worktree, doctor::run_doctor, ipc::notify_running_app, keychain,
    slugify_worktree_name, AppNotification, AppNotificationKind, ApprovalRequestPayload,
    CancellationToken, CreateSessionContext, DoctorStatus, ExecutionRequest, ExecutionStream,
    ExecutionTermination, GyroConfig, GyroPaths, HarnessRunStatus, ProviderHealthRequest,
    ProviderHealthService, ProviderRunPayload, ProviderTextChunk, Session, SessionEventKind,
    SessionOrigin, SessionStore, SessionWorkspaceMode, TerminalRequestPayload,
};
use serde::Serialize;
use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const CLI_JSON_SCHEMA_V1: &str = "gyro.cli.v1";
const EXIT_PROVIDER_UNAVAILABLE: i32 = 3;

const DEFAULT_SESSION_LIMIT: usize = 20;

#[derive(Debug, Parser)]
#[command(name = "gyro")]
#[command(about = "Open-source local-first coding agent workspace.")]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Start an interactive provider-backed chat in the current repository.
    Chat(ChatArgs),
    /// Run a one-shot coding task in the current repository.
    Run(RunArgs),
    /// Resume the latest or selected Gyro session.
    Resume(ResumeArgs),
    /// List recent local Gyro sessions.
    Sessions(SessionsArgs),
    /// Check CLI, provider, app, and agent readiness.
    Setup(SetupArgs),
    /// Open or attach sessions in Gyro.app.
    App(AppArgs),
    /// Validate local setup.
    Doctor(DoctorArgs),
    /// Manage local Gyro configuration.
    Config(ConfigArgs),
}

#[derive(Debug, Args)]
struct ChatArgs {
    /// Workspace path. Defaults to the current directory.
    #[arg(long)]
    workspace: Option<PathBuf>,

    /// CLI profile to use, such as codex or claude-code.
    #[arg(long)]
    profile: Option<String>,

    /// Model hint to use for this chat.
    #[arg(long)]
    model: Option<String>,

    /// Approve provider runs when the active policy requires terminal confirmation.
    #[arg(long)]
    approve: bool,

    /// Stop a provider turn when this timeout is reached.
    #[arg(long, default_value_t = 180, value_parser = clap::value_parser!(u64).range(1..=3600))]
    timeout_seconds: u64,
}

impl Default for ChatArgs {
    fn default() -> Self {
        Self {
            workspace: None,
            profile: None,
            model: None,
            approve: false,
            timeout_seconds: 180,
        }
    }
}

#[derive(Debug, Args)]
struct RunArgs {
    /// Task to record and run.
    task: String,

    /// Workspace path. Defaults to the current directory.
    #[arg(long)]
    workspace: Option<PathBuf>,

    /// CLI profile to use, such as codex or claude-code.
    #[arg(long)]
    profile: Option<String>,

    /// Model hint to record for this run.
    #[arg(long)]
    model: Option<String>,

    /// Launch Gyro.app if it is not already running.
    #[arg(long, conflicts_with = "no_open")]
    open: bool,

    /// Do not notify or open Gyro.app.
    #[arg(long)]
    no_open: bool,

    /// Emit JSON instead of text.
    #[arg(long)]
    json: bool,

    /// Approve this provider run when the active policy requires terminal confirmation.
    #[arg(long)]
    approve: bool,

    /// Stop the provider when this timeout is reached.
    #[arg(long, default_value_t = 180, value_parser = clap::value_parser!(u64).range(1..=3600))]
    timeout_seconds: u64,

    #[command(flatten)]
    worktree: WorktreeArgs,
}

#[derive(Debug, Args)]
struct ResumeArgs {
    /// Session id to resume. Defaults to the latest session.
    session_id: Option<Uuid>,

    /// Override the recorded CLI profile for this resume.
    #[arg(long)]
    profile: Option<String>,

    /// Override the recorded model hint for this resume.
    #[arg(long)]
    model: Option<String>,

    /// Launch Gyro.app if it is not already running.
    #[arg(long, conflicts_with = "no_open")]
    open: bool,

    /// Do not notify or open Gyro.app.
    #[arg(long)]
    no_open: bool,

    /// Emit JSON instead of text.
    #[arg(long)]
    json: bool,

    /// Message sent while resuming. Defaults to continuing the interrupted work.
    #[arg(long)]
    message: Option<String>,

    /// Approve this provider run when the active policy requires terminal confirmation.
    #[arg(long)]
    approve: bool,

    /// Stop the provider when this timeout is reached.
    #[arg(long, default_value_t = 180, value_parser = clap::value_parser!(u64).range(1..=3600))]
    timeout_seconds: u64,
}

#[derive(Debug, Args)]
struct SessionsArgs {
    /// Emit JSON instead of text.
    #[arg(long)]
    json: bool,

    /// Only show sessions for this workspace.
    #[arg(long)]
    workspace: Option<PathBuf>,

    /// Maximum number of sessions to show.
    #[arg(long, default_value_t = DEFAULT_SESSION_LIMIT)]
    limit: usize,
}

#[derive(Debug, Args)]
struct SetupArgs {
    /// Emit JSON instead of text.
    #[arg(long)]
    json: bool,
}

#[derive(Clone, Debug, Args)]
struct WorktreeArgs {
    /// Create the session in an isolated Git worktree under Gyro app support.
    #[arg(long)]
    worktree: bool,

    /// Branch name to create for --worktree. Defaults to gyro/<task-slug>-<timestamp>.
    #[arg(long)]
    branch: Option<String>,

    /// Worktree directory name to create under Gyro app support.
    #[arg(long)]
    worktree_name: Option<String>,
}

#[derive(Debug, Args)]
struct AppArgs {
    #[command(subcommand)]
    command: AppCommand,
}

#[derive(Debug, Subcommand)]
enum AppCommand {
    /// Open Gyro.app and focus a session.
    Open {
        /// Session id to open. Defaults to the latest session.
        session_id: Option<Uuid>,
    },
    /// Attach the current CLI session to Gyro.app.
    Attach {
        /// Workspace path. Defaults to the current directory.
        #[arg(long)]
        workspace: Option<PathBuf>,

        #[command(flatten)]
        worktree: WorktreeArgs,
    },
}

#[derive(Debug, Args)]
struct DoctorArgs {
    /// Emit JSON instead of text.
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args)]
struct ConfigArgs {
    #[command(subcommand)]
    command: ConfigCommand,
}

#[derive(Debug, Subcommand)]
enum ConfigCommand {
    /// Print the effective local config.
    Show {
        /// Emit JSON instead of text.
        #[arg(long)]
        json: bool,
    },
    /// Confirm the Stable GitHub Releases update source.
    SetUpdateChannel { channel: String },
    /// Enable a configured model provider.
    EnableProvider { provider_id: String },
    /// Store a provider API key in macOS Keychain.
    SetProviderKey {
        provider_id: String,
        /// API key value. Prefer --env for shell-history safety.
        #[arg(long)]
        value: Option<String>,
        /// Environment variable containing the key.
        #[arg(long)]
        env: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[allow(dead_code)]
#[serde(rename_all = "kebab-case")]
enum CliStatus {
    Ready,
    Waiting,
    Blocked,
    Running,
    Done,
    Failed,
}

impl CliStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Waiting => "waiting",
            Self::Blocked => "blocked",
            Self::Running => "running",
            Self::Done => "done",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionCommandOutput {
    status: CliStatus,
    session_id: Uuid,
    title: String,
    workspace: PathBuf,
    workspace_mode: SessionWorkspaceMode,
    branch: String,
    worktree_name: Option<String>,
    profile_id: Option<String>,
    profile_label: Option<String>,
    model: Option<String>,
    approval_required: bool,
    app_handoff: AppHandoffOutput,
    resume_command: String,
    next_command: Option<String>,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    run: Option<CliRunOutput>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CliRunOutput {
    run_id: Uuid,
    attempt_id: Uuid,
    provider_id: String,
    duration_ms: u64,
    exit_code: Option<i32>,
    resumed: bool,
    response: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppHandoffOutput {
    requested: bool,
    opened: bool,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionListOutput {
    status: CliStatus,
    count: usize,
    sessions: Vec<SessionSummaryOutput>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionSummaryOutput {
    session_id: Uuid,
    title: String,
    workspace: PathBuf,
    workspace_mode: SessionWorkspaceMode,
    branch: String,
    worktree_name: Option<String>,
    origin: SessionOrigin,
    updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupOutput {
    status: CliStatus,
    checks: Vec<SetupCheckOutput>,
    mcp_instructions: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupCheckOutput {
    id: String,
    label: String,
    status: CliStatus,
    message: String,
    next: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OpenBehavior {
    NotifyRunning,
    OpenApp,
    Skip,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum CliErrorCategory {
    InvalidInput,
    ProviderUnavailable,
    ApprovalRejected,
    ExecutionFailed,
    Cancelled,
    Internal,
}

impl CliErrorCategory {
    fn exit_code(self) -> i32 {
        match self {
            Self::InvalidInput => 2,
            Self::ProviderUnavailable => EXIT_PROVIDER_UNAVAILABLE,
            Self::ApprovalRejected => 4,
            Self::ExecutionFailed => 5,
            Self::Cancelled => 130,
            Self::Internal => 70,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CliErrorBody<'a> {
    category: CliErrorCategory,
    code: i32,
    message: &'a str,
}

#[derive(Serialize)]
struct CliErrorOutput<'a> {
    schema: &'static str,
    status: &'static str,
    error: CliErrorBody<'a>,
}

#[derive(Serialize)]
struct CliJsonEnvelope<'a, T> {
    schema: &'static str,
    #[serde(flatten)]
    value: &'a T,
}

impl Cli {
    fn wants_json(&self) -> bool {
        match self.command.as_ref() {
            Some(Commands::Chat(_)) => false,
            Some(Commands::Run(args)) => args.json,
            Some(Commands::Resume(args)) => args.json,
            Some(Commands::Sessions(args)) => args.json,
            Some(Commands::Setup(args)) => args.json,
            Some(Commands::Doctor(args)) => args.json,
            Some(Commands::Config(ConfigArgs {
                command: ConfigCommand::Show { json },
            })) => *json,
            _ => false,
        }
    }
}

fn main() {
    let cli = Cli::parse();
    let json = cli.wants_json();
    if let Err(error) = run_cli(cli) {
        let message = gyro_core::security::redact_secrets(&error.to_string());
        let category = classify_cli_error(&message);
        if json {
            let output = CliErrorOutput {
                schema: CLI_JSON_SCHEMA_V1,
                status: "failed",
                error: CliErrorBody {
                    category,
                    code: category.exit_code(),
                    message: &message,
                },
            };
            eprintln!(
                "{}",
                serde_json::to_string_pretty(&output)
                    .unwrap_or_else(|_| format!("Gyro CLI failed: {message}"))
            );
        } else {
            eprintln!("Gyro CLI failed: {message}");
        }
        std::process::exit(category.exit_code());
    }
}

fn run_cli(cli: Cli) -> Result<()> {
    match cli.command {
        Some(Commands::Chat(args)) => interactive_chat(args),
        Some(Commands::Run(args)) => run_task(args),
        Some(Commands::Resume(args)) => resume_session(args),
        Some(Commands::Sessions(args)) => sessions_command(args),
        Some(Commands::Setup(args)) => setup_command(args),
        Some(Commands::App(args)) => app_command(args),
        Some(Commands::Doctor(args)) => doctor(args),
        Some(Commands::Config(args)) => config_command(args),
        None => interactive_chat(ChatArgs::default()),
    }
}

fn classify_cli_error(message: &str) -> CliErrorCategory {
    let message = message.to_ascii_lowercase();
    if message.contains("cancelled") || message.contains("interrupted") {
        CliErrorCategory::Cancelled
    } else if message.contains("approval") && message.contains("reject") {
        CliErrorCategory::ApprovalRejected
    } else if message.contains("session saved: no")
        || message.contains("unknown provider")
        || message.contains("unknown profile")
        || message.contains("require --")
        || message.contains("pass exactly one")
        || message.contains("resolve workspace path")
    {
        CliErrorCategory::InvalidInput
    } else if message.contains("not installed")
        || message.contains("unavailable")
        || message.contains("not authenticated")
        || message.contains("not logged in")
        || message.contains("auth required")
        || message.contains("not configured")
        || message.contains("has no provider")
        || message.contains("status: blocked")
    {
        CliErrorCategory::ProviderUnavailable
    } else if message.contains("not found") || message.contains("does not exist") {
        CliErrorCategory::InvalidInput
    } else if message.contains("timed out")
        || message.contains("execution failed")
        || message.contains("exited with")
    {
        CliErrorCategory::ExecutionFailed
    } else {
        CliErrorCategory::Internal
    }
}

fn open_store() -> Result<(GyroPaths, SessionStore)> {
    let paths = GyroPaths::for_current_user()?;
    let store = SessionStore::open(paths.clone())?;
    Ok((paths, store))
}

fn workspace_path(explicit: Option<PathBuf>) -> Result<PathBuf> {
    explicit
        .unwrap_or(std::env::current_dir()?)
        .canonicalize()
        .context("resolve workspace path")
}

fn open_behavior(open: bool, no_open: bool) -> OpenBehavior {
    if no_open {
        OpenBehavior::Skip
    } else if open {
        OpenBehavior::OpenApp
    } else {
        OpenBehavior::NotifyRunning
    }
}

fn select_command_profile<'a>(
    config: &'a GyroConfig,
    profile_id: Option<&str>,
) -> Result<Option<&'a CommandProfile>> {
    let Some(profile_id) = profile_id else {
        return Ok(None);
    };
    config
        .command_profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .map(Some)
        .ok_or_else(|| {
            anyhow!(
                "status: blocked\nprofile `{profile_id}` is not configured\nnext: run `gyro config show` to inspect available CLI profiles\nsession saved: no"
            )
        })
}

fn select_execution_profile<'a>(
    config: &'a GyroConfig,
    profile_id: Option<&str>,
) -> Result<&'a CommandProfile> {
    if let Some(profile) = select_command_profile(config, profile_id)? {
        return Ok(profile);
    }
    config
        .command_profiles
        .iter()
        .find(|profile| {
            profile.provider_id.as_ref().is_some_and(|provider_id| {
                config
                    .model_providers
                    .iter()
                    .any(|provider| provider.id == *provider_id && provider.enabled)
            }) && command_in_path(&profile.command).is_some()
        })
        .ok_or_else(|| {
            anyhow!(
                "provider unavailable: choose an enabled executable profile with --profile <id>"
            )
        })
}

fn command_in_path(command: &str) -> Option<PathBuf> {
    let command_path = Path::new(command);
    if command_path.components().count() > 1 {
        return command_path.exists().then(|| command_path.to_path_buf());
    }

    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(command))
        .find(|candidate| candidate.exists() && candidate.is_file())
}

fn profile_status(profile: Option<&CommandProfile>) -> (CliStatus, Option<String>, Option<String>) {
    let Some(profile) = profile else {
        return (
            CliStatus::Waiting,
            None,
            Some(
                "choose a CLI profile with `--profile codex` or inspect setup with `gyro setup`"
                    .into(),
            ),
        );
    };

    if let Some(path) = command_in_path(&profile.command) {
        return (
            CliStatus::Waiting,
            Some(format!("{} ready at {}", profile.display_name, path.display())),
            Some(format!(
                "{} session recorded; open it in Gyro.app or run the agent command from the terminal",
                profile.display_name
            )),
        );
    }

    (
        CliStatus::Blocked,
        Some(format!(
            "{} command `{}` was not found",
            profile.display_name, profile.command
        )),
        Some(format!(
            "install `{}` or choose another profile with `--profile <id>`",
            profile.command
        )),
    )
}

fn model_for(profile: Option<&CommandProfile>, override_model: Option<String>) -> Option<String> {
    override_model.or_else(|| profile.and_then(|profile| profile.default_model.clone()))
}

fn profile_label(profile: Option<&CommandProfile>) -> Option<String> {
    profile.map(|profile| profile.display_name.clone())
}

fn profile_id(profile: Option<&CommandProfile>) -> Option<String> {
    profile.map(|profile| profile.id.clone())
}

fn workspace_mode_label(mode: &SessionWorkspaceMode) -> &'static str {
    match mode {
        SessionWorkspaceMode::Local => "local",
        SessionWorkspaceMode::Worktree => "worktree",
    }
}

fn cli_status_to_harness(status: CliStatus) -> HarnessRunStatus {
    match status {
        CliStatus::Ready | CliStatus::Waiting => HarnessRunStatus::Waiting,
        CliStatus::Blocked => HarnessRunStatus::Blocked,
        CliStatus::Running => HarnessRunStatus::Running,
        CliStatus::Done => HarnessRunStatus::Done,
        CliStatus::Failed => HarnessRunStatus::Failed,
    }
}

fn cli_provider_run_payload(
    run_id: Uuid,
    attempt_id: Uuid,
    mode: &str,
    status: HarnessRunStatus,
    profile: Option<&CommandProfile>,
    model: Option<String>,
    session: &Session,
) -> Result<serde_json::Value> {
    let provider_id = profile
        .and_then(|profile| profile.provider_id.clone())
        .unwrap_or_else(|| "local-cli".into());
    let payload = ProviderRunPayload::new(
        run_id,
        attempt_id,
        "cli",
        status,
        provider_id,
        profile_label(profile),
        model.clone(),
        model.clone(),
        Some(session.title.clone()),
        profile.map(|profile| profile.command.clone()),
        Some("provider-cli-or-local-shell".into()),
        mode == "resume",
        0,
        None,
    );
    let mut value = gyro_core::harness_payload_value(&payload)?;
    insert_cli_metadata(&mut value, mode, profile, model, session);
    Ok(value)
}

fn cli_terminal_request_payload(
    run_id: Uuid,
    mode: &str,
    status: HarnessRunStatus,
    profile: Option<&CommandProfile>,
    model: Option<String>,
    session: &Session,
    approval_required: bool,
) -> Result<serde_json::Value> {
    let payload = TerminalRequestPayload::new(
        run_id,
        "cli",
        profile
            .map(|profile| profile.command.clone())
            .unwrap_or_else(|| "unconfigured-profile".into()),
        profile
            .map(|profile| profile.args.clone())
            .unwrap_or_default(),
        Some(session.workspace_path.display().to_string()),
        status,
    )
    .with_approval_required(approval_required);
    if payload.approval_required {
        gyro_core::validate_mutation_approval_policy("terminal-request", true)?;
    }
    let mut value = gyro_core::harness_payload_value(&payload)?;
    insert_cli_metadata(&mut value, mode, profile, model, session);
    Ok(value)
}

fn cli_approval_payload(
    run_id: Uuid,
    mode: &str,
    require_command_approval: bool,
    require_file_edit_approval: bool,
) -> Result<serde_json::Value> {
    let payload = ApprovalRequestPayload::new(
        run_id,
        "command-and-file-edits",
        "Commands and file edits require approval before execution.",
        "ask",
    );
    let mut value = gyro_core::harness_payload_value(&payload)?;
    if let Some(object) = value.as_object_mut() {
        object.insert("mode".into(), serde_json::Value::String(mode.into()));
        object.insert(
            "requireCommandApproval".into(),
            serde_json::Value::Bool(require_command_approval),
        );
        object.insert(
            "requireFileEditApproval".into(),
            serde_json::Value::Bool(require_file_edit_approval),
        );
    }
    Ok(value)
}

fn cli_profile_readiness_payload(
    run_id: Uuid,
    attempt_id: Uuid,
    mode: &str,
    profile: Option<&CommandProfile>,
    model: Option<String>,
    session: &Session,
    next_command: Option<String>,
) -> Result<serde_json::Value> {
    let mut value = cli_provider_run_payload(
        run_id,
        attempt_id,
        mode,
        HarnessRunStatus::Blocked,
        profile,
        model,
        session,
    )?;
    if let Some(object) = value.as_object_mut() {
        object.insert(
            "kind".into(),
            serde_json::Value::String("profile-readiness".into()),
        );
        object.insert(
            "next".into(),
            next_command
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null),
        );
        object.insert("sessionSaved".into(), serde_json::Value::Bool(true));
    }
    Ok(value)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CliProviderKind {
    Codex,
    Claude,
}

struct CliProviderInvocation {
    request: ExecutionRequest,
    output_path: Option<PathBuf>,
    provider_kind: CliProviderKind,
    proposed_session_id: Option<String>,
}

#[derive(Default)]
struct CliStreamDecoder {
    line_buffer: String,
    response: String,
    provider_session_id: Option<String>,
}

impl CliStreamDecoder {
    fn push_stdout(&mut self, chunk: &str) -> Vec<String> {
        self.line_buffer.push_str(chunk);
        let mut deltas = Vec::new();
        while let Some(newline) = self.line_buffer.find('\n') {
            let line = self.line_buffer.drain(..=newline).collect::<String>();
            self.push_line(&line, &mut deltas);
        }
        if self.line_buffer.chars().count() > 256_000 {
            self.line_buffer.clear();
        }
        deltas
    }

    fn finish(&mut self) -> Vec<String> {
        if self.line_buffer.is_empty() {
            return Vec::new();
        }
        let line = std::mem::take(&mut self.line_buffer);
        let mut deltas = Vec::new();
        self.push_line(&line, &mut deltas);
        deltas
    }

    fn push_line(&mut self, line: &str, deltas: &mut Vec<String>) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            return;
        };
        if self.provider_session_id.is_none() {
            self.provider_session_id = gyro_core::extract_provider_session_id(&value);
        }
        let Some(chunk) = gyro_core::extract_provider_text_chunk(&value) else {
            return;
        };
        let delta = match chunk {
            ProviderTextChunk::Delta(delta) => delta,
            ProviderTextChunk::Snapshot(snapshot) => {
                if self.response.is_empty() {
                    snapshot
                } else {
                    snapshot
                        .strip_prefix(&self.response)
                        .unwrap_or_default()
                        .to_string()
                }
            }
            ProviderTextChunk::Final(final_text) => {
                if self.response.is_empty() {
                    final_text
                } else {
                    final_text
                        .strip_prefix(&self.response)
                        .unwrap_or_default()
                        .to_string()
                }
            }
        };
        if !delta.is_empty() {
            self.response.push_str(&delta);
            deltas.push(delta);
        }
    }
}

static CLI_SIGNAL_TOKEN: OnceLock<Mutex<Option<CancellationToken>>> = OnceLock::new();
static CLI_SIGNAL_HANDLER: OnceLock<std::result::Result<(), String>> = OnceLock::new();

struct CliCancellationGuard;

impl Drop for CliCancellationGuard {
    fn drop(&mut self) {
        if let Some(slot) = CLI_SIGNAL_TOKEN.get() {
            if let Ok(mut active) = slot.lock() {
                *active = None;
            }
        }
    }
}

fn activate_cli_cancellation(token: CancellationToken) -> Result<CliCancellationGuard> {
    let slot = CLI_SIGNAL_TOKEN.get_or_init(|| Mutex::new(None));
    let handler = CLI_SIGNAL_HANDLER.get_or_init(|| {
        ctrlc::set_handler(|| {
            if let Some(slot) = CLI_SIGNAL_TOKEN.get() {
                if let Ok(active) = slot.lock() {
                    if let Some(token) = active.as_ref() {
                        token.cancel();
                    }
                }
            }
        })
        .map_err(|error| error.to_string())
    });
    if let Err(error) = handler {
        return Err(anyhow!("install Ctrl-C handler: {error}"));
    }
    *slot
        .lock()
        .map_err(|_| anyhow!("CLI cancellation state is unavailable"))? = Some(token);
    Ok(CliCancellationGuard)
}

fn confirm_cli_execution(config: &GyroConfig, approved: bool, json: bool) -> Result<bool> {
    let approval_required = config.require_command_approval || config.require_file_edit_approval;
    if !approval_required || approved {
        return Ok(true);
    }
    if json || !io::stdin().is_terminal() {
        return Err(anyhow!(
            "approval rejected: the active policy requires confirmation; rerun with --approve"
        ));
    }
    print!(
        "The provider may run commands or edit workspace files under the active policy. Approve this run? [y/N] "
    );
    io::stdout().flush()?;
    let mut answer = String::new();
    io::stdin().read_line(&mut answer)?;
    if matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
        Ok(true)
    } else {
        Err(anyhow!("approval rejected by user"))
    }
}

fn cli_provider_kind(profile: &CommandProfile) -> Result<CliProviderKind> {
    match profile.provider_id.as_deref() {
        Some("openai") => Ok(CliProviderKind::Codex),
        Some("anthropic") => Ok(CliProviderKind::Claude),
        Some(provider_id) => Err(anyhow!(
            "provider `{provider_id}` is unavailable for CLI execution"
        )),
        None => Err(anyhow!(
            "profile `{}` is not configured with an executable provider",
            profile.id
        )),
    }
}

fn build_cli_provider_invocation(
    profile: &CommandProfile,
    workspace: &Path,
    prompt: &str,
    model: Option<&str>,
    resume_cursor: Option<(&str, &str)>,
    approved: bool,
    timeout_seconds: u64,
) -> Result<CliProviderInvocation> {
    let provider_kind = cli_provider_kind(profile)?;
    let mut args = profile.args.clone();
    let mut output_path = None;
    let mut proposed_session_id = None;
    match provider_kind {
        CliProviderKind::Codex => {
            let response_path =
                std::env::temp_dir().join(format!("gyro-cli-response-{}.txt", Uuid::new_v4()));
            args.push("exec".into());
            if let Some(("codex-session", session_id)) = resume_cursor {
                args.push("resume".into());
                args.push("--skip-git-repo-check".into());
                if approved {
                    args.push("--dangerously-bypass-approvals-and-sandbox".into());
                }
                args.push("--json".into());
                args.push("--output-last-message".into());
                args.push(response_path.display().to_string());
                if let Some(model) = cli_codex_model_arg(model) {
                    args.extend(["--model".into(), model]);
                }
                args.push(session_id.into());
            } else {
                args.push("--skip-git-repo-check".into());
                if approved {
                    args.push("--dangerously-bypass-approvals-and-sandbox".into());
                } else {
                    args.extend(["--sandbox".into(), "workspace-write".into()]);
                }
                args.push("--json".into());
                args.push("--output-last-message".into());
                args.push(response_path.display().to_string());
                if let Some(model) = cli_codex_model_arg(model) {
                    args.extend(["--model".into(), model]);
                }
            }
            args.extend(["--".into(), prompt.into()]);
            output_path = Some(response_path);
        }
        CliProviderKind::Claude => {
            args.extend([
                "--print".into(),
                "--output-format".into(),
                "stream-json".into(),
                "--include-partial-messages".into(),
            ]);
            if let Some(("claude-session", session_id)) = resume_cursor {
                args.extend(["--resume".into(), session_id.into()]);
                proposed_session_id = Some(session_id.into());
            } else {
                let session_id = Uuid::new_v4().to_string();
                args.extend(["--session-id".into(), session_id.clone()]);
                proposed_session_id = Some(session_id);
            }
            if let Some(model) = model.map(str::trim).filter(|model| !model.is_empty()) {
                args.extend(["--model".into(), model.into()]);
            }
            if approved {
                args.push("--dangerously-skip-permissions".into());
            }
            args.push(prompt.into());
        }
    }
    let mut request = ExecutionRequest::new(profile.command.clone());
    request.args = args.into_iter().map(Into::into).collect();
    request.current_dir = Some(workspace.to_path_buf());
    request.timeout = Duration::from_secs(timeout_seconds);
    request.max_stdout_chars = 256_000;
    request.max_stderr_chars = 64_000;
    Ok(CliProviderInvocation {
        request,
        output_path,
        provider_kind,
        proposed_session_id,
    })
}

fn cli_codex_model_arg(model: Option<&str>) -> Option<String> {
    let model = model?.trim();
    if model.is_empty()
        || matches!(
            model.to_ascii_lowercase().as_str(),
            "gpt-5.5" | "gpt-5.4" | "gpt-5.4-mini" | "gpt-5"
        )
    {
        return None;
    }
    Some(model.into())
}

#[allow(clippy::too_many_arguments)]
fn append_cli_run_status(
    store: &SessionStore,
    session: &Session,
    turn_id: Uuid,
    attempt_id: Uuid,
    mode: &str,
    status: HarnessRunStatus,
    profile: &CommandProfile,
    model: Option<String>,
    message: &str,
    error: Option<&str>,
    duration_ms: Option<u64>,
) -> Result<()> {
    let mut payload = cli_provider_run_payload(
        turn_id,
        attempt_id,
        mode,
        status,
        Some(profile),
        model,
        session,
    )?;
    if let Some(object) = payload.as_object_mut() {
        object.insert(
            "error".into(),
            error
                .map(gyro_core::sanitize_harness_text)
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null),
        );
        object.insert(
            "durationMs".into(),
            duration_ms
                .map(serde_json::Value::from)
                .unwrap_or(serde_json::Value::Null),
        );
    }
    store.append_event_with_turn_id(
        session.id,
        SessionEventKind::SystemEvent,
        message,
        payload,
        Some(turn_id),
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn execute_cli_provider(
    store: &SessionStore,
    session: &Session,
    profile: &CommandProfile,
    model: Option<String>,
    prompt: &str,
    mode: &str,
    config: &GyroConfig,
    approved: bool,
    json: bool,
    timeout_seconds: u64,
    turn_id: Uuid,
    attempt_id: Uuid,
) -> Result<CliRunOutput> {
    let approved = confirm_cli_execution(config, approved, json)?;
    let provider_id = profile
        .provider_id
        .clone()
        .ok_or_else(|| anyhow!("profile `{}` has no provider", profile.id))?;
    let binding = store.get_provider_session_binding(session.id, &provider_id)?;
    let resume_cursor = binding.as_ref().and_then(|binding| {
        let kind = binding.resume_cursor_json.get("kind")?.as_str()?;
        let session_id = binding.resume_cursor_json.get("sessionId")?.as_str()?;
        Some((kind, session_id))
    });
    let invocation = build_cli_provider_invocation(
        profile,
        &session.workspace_path,
        prompt,
        model.as_deref(),
        resume_cursor,
        approved,
        timeout_seconds,
    )?;
    append_cli_run_status(
        store,
        session,
        turn_id,
        attempt_id,
        mode,
        HarnessRunStatus::Running,
        profile,
        model.clone(),
        "CLI provider run started.",
        None,
        None,
    )?;
    if !json {
        eprintln!(
            "Running {} in {}...",
            profile.display_name,
            session.workspace_path.display()
        );
    }
    let cancellation = CancellationToken::default();
    let _cancellation_guard = activate_cli_cancellation(cancellation.clone())?;
    let mut decoder = CliStreamDecoder::default();
    let outcome = gyro_core::run_command(invocation.request, cancellation, |chunk| {
        if chunk.stream != ExecutionStream::Stdout {
            return;
        }
        for delta in decoder.push_stdout(&chunk.text) {
            if !json {
                print!("{delta}");
                let _ = io::stdout().flush();
            }
        }
    });
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(error) => {
            let error = gyro_core::sanitize_harness_text(&error.to_string());
            append_cli_run_status(
                store,
                session,
                turn_id,
                attempt_id,
                mode,
                HarnessRunStatus::Failed,
                profile,
                model,
                "CLI provider run failed to start.",
                Some(&error),
                None,
            )?;
            return Err(anyhow!("execution failed: {error}"));
        }
    };
    for delta in decoder.finish() {
        if !json {
            print!("{delta}");
        }
    }
    if !json && !decoder.response.is_empty() {
        println!();
    }
    let output_file_response = invocation
        .output_path
        .as_ref()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .unwrap_or_default();
    if let Some(path) = invocation.output_path.as_ref() {
        let _ = std::fs::remove_file(path);
    }
    let response = gyro_core::sanitize_harness_text(
        output_file_response
            .trim()
            .is_empty()
            .then_some(decoder.response.trim())
            .unwrap_or(output_file_response.trim()),
    );
    let status = match outcome.termination {
        ExecutionTermination::Cancelled => HarnessRunStatus::Cancelled,
        ExecutionTermination::TimedOut | ExecutionTermination::Inactive => HarnessRunStatus::Failed,
        ExecutionTermination::Exited { code: Some(0) } if !response.is_empty() => {
            HarnessRunStatus::Done
        }
        ExecutionTermination::Exited { .. } => HarnessRunStatus::Failed,
    };
    if status != HarnessRunStatus::Done {
        let detail = match outcome.termination {
            ExecutionTermination::Cancelled => "run cancelled by user".to_string(),
            ExecutionTermination::TimedOut => {
                format!("execution timed out after {timeout_seconds} seconds")
            }
            ExecutionTermination::Inactive => "execution stopped after prolonged inactivity".into(),
            ExecutionTermination::Exited { code } => {
                let stderr = gyro_core::sanitize_harness_text(outcome.stderr.trim());
                if stderr.is_empty() {
                    format!("provider exited with {}", code.unwrap_or(-1))
                } else {
                    format!("provider exited with {}: {stderr}", code.unwrap_or(-1))
                }
            }
        };
        append_cli_run_status(
            store,
            session,
            turn_id,
            attempt_id,
            mode,
            status.clone(),
            profile,
            model,
            if status == HarnessRunStatus::Cancelled {
                "CLI provider run cancelled."
            } else {
                "CLI provider run failed."
            },
            Some(&detail),
            Some(outcome.duration_ms),
        )?;
        return Err(anyhow!(detail));
    }
    let provider_session_id = decoder
        .provider_session_id
        .or(invocation.proposed_session_id);
    if let Some(provider_session_id) = provider_session_id.as_deref() {
        let kind = match invocation.provider_kind {
            CliProviderKind::Codex => "codex-session",
            CliProviderKind::Claude => "claude-session",
        };
        store.upsert_provider_session_binding(
            session.id,
            provider_id.clone(),
            model.clone(),
            model.clone(),
            None,
            serde_json::json!({"kind": kind, "sessionId": provider_session_id}),
            "ready",
            None,
        )?;
    }
    store.append_event_with_turn_id(
        session.id,
        SessionEventKind::AssistantMessage,
        response.clone(),
        cli_provider_run_payload(
            turn_id,
            attempt_id,
            mode,
            HarnessRunStatus::Done,
            Some(profile),
            model.clone(),
            session,
        )?,
        Some(turn_id),
    )?;
    append_cli_run_status(
        store,
        session,
        turn_id,
        attempt_id,
        mode,
        HarnessRunStatus::Done,
        profile,
        model,
        "CLI provider run completed.",
        None,
        Some(outcome.duration_ms),
    )?;
    Ok(CliRunOutput {
        run_id: turn_id,
        attempt_id,
        provider_id,
        duration_ms: outcome.duration_ms,
        exit_code: outcome.exit_code(),
        resumed: resume_cursor.is_some(),
        response,
    })
}

fn insert_cli_metadata(
    value: &mut serde_json::Value,
    mode: &str,
    profile: Option<&CommandProfile>,
    model: Option<String>,
    session: &Session,
) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    object.insert("mode".into(), serde_json::Value::String(mode.into()));
    object.insert(
        "profileId".into(),
        profile_id(profile)
            .map(serde_json::Value::String)
            .unwrap_or(serde_json::Value::Null),
    );
    object.insert(
        "profileLabel".into(),
        profile_label(profile)
            .map(serde_json::Value::String)
            .unwrap_or(serde_json::Value::Null),
    );
    object.insert(
        "model".into(),
        model
            .map(serde_json::Value::String)
            .unwrap_or(serde_json::Value::Null),
    );
    object.insert(
        "workspaceMode".into(),
        serde_json::Value::String(workspace_mode_label(&session.workspace_mode).into()),
    );
    object.insert(
        "branch".into(),
        serde_json::Value::String(session.branch.clone()),
    );
    object.insert(
        "worktreeName".into(),
        session
            .worktree_name
            .clone()
            .map(serde_json::Value::String)
            .unwrap_or(serde_json::Value::Null),
    );
    object.insert(
        "resumeCommand".into(),
        serde_json::Value::String(format!("gyro resume {}", session.id)),
    );
}

fn session_summary(session: &Session) -> SessionSummaryOutput {
    SessionSummaryOutput {
        session_id: session.id,
        title: session.title.clone(),
        workspace: session.workspace_path.clone(),
        workspace_mode: session.workspace_mode.clone(),
        branch: session.branch.clone(),
        worktree_name: session.worktree_name.clone(),
        origin: session.origin.clone(),
        updated_at: session.updated_at.to_rfc3339(),
    }
}

fn print_json<T: Serialize>(value: &T) -> Result<()> {
    println!(
        "{}",
        serde_json::to_string_pretty(&CliJsonEnvelope {
            schema: CLI_JSON_SCHEMA_V1,
            value,
        })?
    );
    Ok(())
}

fn create_cli_session(
    paths: &GyroPaths,
    store: &SessionStore,
    workspace: &PathBuf,
    title: String,
    worktree: &WorktreeArgs,
) -> Result<Session> {
    if !worktree.worktree && (worktree.branch.is_some() || worktree.worktree_name.is_some()) {
        return Err(anyhow!("--branch and --worktree-name require --worktree"));
    }

    if !worktree.worktree {
        return store.create_session(workspace, SessionOrigin::Cli, title);
    }

    let branch = worktree
        .branch
        .clone()
        .unwrap_or_else(|| default_worktree_branch(&title));
    let plan = create_worktree(paths, workspace, branch, worktree.worktree_name.clone())?;
    let session = store.create_session_with_context(
        &plan.worktree_path,
        SessionOrigin::Cli,
        title,
        CreateSessionContext {
            workspace_mode: SessionWorkspaceMode::Worktree,
            branch: plan.branch,
            worktree_name: Some(plan.worktree_name),
            ..CreateSessionContext::default()
        },
    )?;
    store.append_event(
        session.id,
        SessionEventKind::SystemEvent,
        "CLI worktree session created.",
        serde_json::json!({
            "surface": "cli",
            "workspaceMode": session.workspace_mode.clone(),
            "repoPath": plan.git_root,
            "worktreePath": plan.worktree_path,
            "branch": session.branch.clone(),
            "worktreeName": session.worktree_name.clone(),
        }),
    )?;
    Ok(session)
}

fn default_worktree_branch(title: &str) -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    format!("gyro/{}-{timestamp}", slugify_worktree_name(title))
}

fn interactive_chat(args: ChatArgs) -> Result<()> {
    let (paths, store) = open_store()?;
    let config = GyroConfig::load(&paths)?;
    let profile = select_execution_profile(&config, args.profile.as_deref())?;
    let model = model_for(Some(profile), args.model);
    let workspace = workspace_path(args.workspace)?;
    let session = store.create_session(&workspace, SessionOrigin::Cli, "CLI chat")?;

    println!("Gyro CLI session {}", session.id);
    println!("Workspace: {}", workspace.display());
    println!("Provider: {}", profile.display_name);
    println!("Type a message, or /open to open this session in Gyro.app, or /exit.");

    let stdin = io::stdin();
    loop {
        print!("gyro> ");
        io::stdout().flush()?;

        let mut input = String::new();
        if stdin.read_line(&mut input)? == 0 {
            break;
        }

        let input = input.trim();
        if input.is_empty() {
            continue;
        }
        if input == "/exit" || input == "/quit" {
            break;
        }
        if input == "/open" {
            open_session_in_app(&paths, &session, AppNotificationKind::OpenSession)?;
            continue;
        }

        let turn_id = Uuid::new_v4();
        let attempt_id = Uuid::new_v4();
        store.append_event_with_turn_id(
            session.id,
            SessionEventKind::UserMessage,
            input,
            cli_provider_run_payload(
                turn_id,
                attempt_id,
                "chat",
                HarnessRunStatus::Queued,
                Some(profile),
                model.clone(),
                &session,
            )?,
            Some(turn_id),
        )?;
        store.append_event_with_turn_id(
            session.id,
            SessionEventKind::CommandRequested,
            "CLI chat provider execution requested.",
            cli_terminal_request_payload(
                turn_id,
                "chat",
                HarnessRunStatus::Queued,
                Some(profile),
                model.clone(),
                &session,
                config.require_command_approval || config.require_file_edit_approval,
            )?,
            Some(turn_id),
        )?;
        if config.require_command_approval || config.require_file_edit_approval {
            store.append_event_with_turn_id(
                session.id,
                SessionEventKind::ApprovalRequested,
                "CLI chat turn requires approval under the active policy.",
                cli_approval_payload(
                    turn_id,
                    "chat",
                    config.require_command_approval,
                    config.require_file_edit_approval,
                )?,
                Some(turn_id),
            )?;
        }
        execute_cli_provider(
            &store,
            &session,
            profile,
            model.clone(),
            input,
            "chat",
            &config,
            args.approve,
            false,
            args.timeout_seconds,
            turn_id,
            attempt_id,
        )?;
    }

    Ok(())
}

fn run_task(args: RunArgs) -> Result<()> {
    let (paths, store) = open_store()?;
    let config = GyroConfig::load(&paths)?;
    let profile = Some(select_execution_profile(&config, args.profile.as_deref())?);
    let model = model_for(profile, args.model);
    let workspace = workspace_path(args.workspace)?;
    let title = summarize_title(&args.task);
    let session = create_cli_session(&paths, &store, &workspace, title, &args.worktree)?;
    let (status, profile_message, next_command) = profile_status(profile);
    let turn_id = Uuid::new_v4();
    let attempt_id = Uuid::new_v4();
    store.append_event_with_turn_id(
        session.id,
        SessionEventKind::UserMessage,
        args.task.clone(),
        cli_provider_run_payload(
            turn_id,
            attempt_id,
            "run",
            HarnessRunStatus::Queued,
            profile,
            model.clone(),
            &session,
        )?,
        Some(turn_id),
    )?;
    store.append_event_with_turn_id(
        session.id,
        SessionEventKind::CommandRequested,
        "CLI agent launch recorded.",
        cli_terminal_request_payload(
            turn_id,
            "run",
            cli_status_to_harness(status),
            profile,
            model.clone(),
            &session,
            config.require_command_approval || config.require_file_edit_approval,
        )?,
        Some(turn_id),
    )?;
    if config.require_command_approval || config.require_file_edit_approval {
        store.append_event_with_turn_id(
            session.id,
            SessionEventKind::ApprovalRequested,
            "CLI provider execution requires approval under the active policy.",
            cli_approval_payload(
                turn_id,
                "run",
                config.require_command_approval,
                config.require_file_edit_approval,
            )?,
            Some(turn_id),
        )?;
    }

    if status == CliStatus::Blocked {
        store.append_event_with_turn_id(
            session.id,
            SessionEventKind::SystemEvent,
            profile_message
                .clone()
                .unwrap_or_else(|| "CLI profile is blocked.".into()),
            cli_profile_readiness_payload(
                turn_id,
                attempt_id,
                "run",
                profile,
                model.clone(),
                &session,
                next_command.clone(),
            )?,
            Some(turn_id),
        )?;
        return Err(anyhow!(
            "provider unavailable: {}; session saved: {}",
            profile_message.unwrap_or_else(|| "selected CLI profile is blocked".into()),
            session.id
        ));
    }

    let run = Some(execute_cli_provider(
        &store,
        &session,
        profile.ok_or_else(|| anyhow!("an executable provider profile is required"))?,
        model.clone(),
        &args.task,
        "run",
        &config,
        args.approve,
        args.json,
        args.timeout_seconds,
        turn_id,
        attempt_id,
    )?);
    let handoff = perform_app_handoff(
        &paths,
        &session,
        AppNotificationKind::OpenSession,
        open_behavior(args.open, args.no_open),
    )?;
    let final_status = CliStatus::Done;
    let message = match final_status {
        CliStatus::Done => {
            "trusted provider run completed and was saved to the shared session".into()
        }
        _ => "local session saved".into(),
    };
    let output = SessionCommandOutput {
        status: final_status,
        session_id: session.id,
        title: session.title.clone(),
        workspace: session.workspace_path.clone(),
        workspace_mode: session.workspace_mode.clone(),
        branch: session.branch.clone(),
        worktree_name: session.worktree_name.clone(),
        profile_id: profile_id(profile),
        profile_label: profile_label(profile),
        model,
        approval_required: config.require_command_approval || config.require_file_edit_approval,
        app_handoff: handoff,
        resume_command: format!("gyro resume {}", session.id),
        next_command: None,
        message,
        run,
    };

    if args.json {
        print_json(&output)?;
    } else {
        print_session_command_output("Run completed", &output);
    }
    Ok(())
}

fn resume_session(args: ResumeArgs) -> Result<()> {
    let (paths, store) = open_store()?;
    let config = GyroConfig::load(&paths)?;
    let session = match args.session_id {
        Some(id) => store
            .get_session(id)?
            .ok_or_else(|| anyhow!("session {id} was not found"))?,
        None => store
            .latest_session()?
            .ok_or_else(|| anyhow!("no Gyro sessions exist yet"))?,
    };
    let events = store.read_events(session.id)?;
    let recorded_profile = latest_payload_string(&events, "profileId");
    let recorded_model = latest_payload_string(&events, "model");
    let selected_profile_id = args.profile.as_deref().or(recorded_profile.as_deref());
    let profile = Some(select_execution_profile(&config, selected_profile_id)?);
    let model = model_for(profile, args.model.or(recorded_model));
    let (status, profile_message, next_command) = profile_status(profile);
    let turn_id = Uuid::new_v4();
    let attempt_id = Uuid::new_v4();
    let resume_message = args.message.clone().unwrap_or_else(|| {
        "Continue the previous trusted run from its durable state. Resume the last incomplete step and report the result."
            .into()
    });

    store.append_event_with_turn_id(
        session.id,
        SessionEventKind::SystemEvent,
        "CLI resume requested.",
        cli_provider_run_payload(
            turn_id,
            attempt_id,
            "resume",
            cli_status_to_harness(status),
            profile,
            model.clone(),
            &session,
        )?,
        Some(turn_id),
    )?;
    store.append_event_with_turn_id(
        session.id,
        SessionEventKind::UserMessage,
        resume_message.clone(),
        cli_provider_run_payload(
            turn_id,
            attempt_id,
            "resume",
            HarnessRunStatus::Queued,
            profile,
            model.clone(),
            &session,
        )?,
        Some(turn_id),
    )?;
    store.append_event_with_turn_id(
        session.id,
        SessionEventKind::CommandRequested,
        "CLI agent resume recorded.",
        cli_terminal_request_payload(
            turn_id,
            "resume",
            cli_status_to_harness(status),
            profile,
            model.clone(),
            &session,
            config.require_command_approval || config.require_file_edit_approval,
        )?,
        Some(turn_id),
    )?;
    if config.require_command_approval || config.require_file_edit_approval {
        store.append_event_with_turn_id(
            session.id,
            SessionEventKind::ApprovalRequested,
            "CLI provider resume requires approval under the active policy.",
            cli_approval_payload(
                turn_id,
                "resume",
                config.require_command_approval,
                config.require_file_edit_approval,
            )?,
            Some(turn_id),
        )?;
    }

    if status == CliStatus::Blocked {
        store.append_event_with_turn_id(
            session.id,
            SessionEventKind::SystemEvent,
            profile_message
                .clone()
                .unwrap_or_else(|| "CLI profile is blocked.".into()),
            cli_profile_readiness_payload(
                turn_id,
                attempt_id,
                "resume",
                profile,
                model.clone(),
                &session,
                next_command.clone(),
            )?,
            Some(turn_id),
        )?;
        return Err(anyhow!(
            "provider unavailable: {}; session saved: {}",
            profile_message.unwrap_or_else(|| "selected CLI profile is blocked".into()),
            session.id
        ));
    }

    let run = Some(execute_cli_provider(
        &store,
        &session,
        profile.ok_or_else(|| anyhow!("an executable provider profile is required"))?,
        model.clone(),
        &resume_message,
        "resume",
        &config,
        args.approve,
        args.json,
        args.timeout_seconds,
        turn_id,
        attempt_id,
    )?);
    let handoff = perform_app_handoff(
        &paths,
        &session,
        AppNotificationKind::OpenSession,
        open_behavior(args.open, args.no_open),
    )?;
    let final_status = CliStatus::Done;
    let message = match final_status {
        CliStatus::Done => "trusted provider run resumed and saved to the shared session".into(),
        _ => "resume recorded".into(),
    };
    let output = SessionCommandOutput {
        status: final_status,
        session_id: session.id,
        title: session.title.clone(),
        workspace: session.workspace_path.clone(),
        workspace_mode: session.workspace_mode.clone(),
        branch: session.branch.clone(),
        worktree_name: session.worktree_name.clone(),
        profile_id: profile_id(profile),
        profile_label: profile_label(profile),
        model,
        approval_required: config.require_command_approval || config.require_file_edit_approval,
        app_handoff: handoff,
        resume_command: format!("gyro resume {}", session.id),
        next_command: None,
        message,
        run,
    };

    if args.json {
        print_json(&output)?;
    } else {
        print_session_command_output("Resume completed", &output);
    }
    Ok(())
}

fn latest_payload_string(events: &[gyro_core::SessionEvent], key: &str) -> Option<String> {
    events.iter().rev().find_map(|event| {
        event
            .payload
            .get(key)
            .and_then(|value| value.as_str())
            .map(str::to_string)
    })
}

fn sessions_command(args: SessionsArgs) -> Result<()> {
    let (_paths, store) = open_store()?;
    let workspace_filter = args
        .workspace
        .map(|workspace| workspace_path(Some(workspace)))
        .transpose()?;
    let mut sessions = store.list_sessions()?;
    if let Some(workspace) = workspace_filter {
        sessions.retain(|session| session.workspace_path == workspace);
    }
    sessions.truncate(args.limit);
    let summaries = sessions.iter().map(session_summary).collect::<Vec<_>>();
    let output = SessionListOutput {
        status: CliStatus::Ready,
        count: summaries.len(),
        sessions: summaries,
    };

    if args.json {
        print_json(&output)?;
    } else {
        print_sessions_output(&output);
    }
    Ok(())
}

fn setup_command(args: SetupArgs) -> Result<()> {
    let paths = GyroPaths::for_current_user()?;
    let config = GyroConfig::load(&paths)?;
    let mut checks = Vec::new();

    let doctor_report = run_doctor(&paths, &config);
    for check in doctor_report.checks {
        checks.push(SetupCheckOutput {
            id: check.id,
            label: check.label,
            status: match check.status {
                DoctorStatus::Pass => CliStatus::Ready,
                DoctorStatus::Warn => CliStatus::Waiting,
                DoctorStatus::Fail => CliStatus::Blocked,
            },
            message: check.message,
            next: None,
        });
    }

    checks.push(SetupCheckOutput {
        id: "app-ipc".into(),
        label: "Gyro.app bridge".into(),
        status: if paths.socket_path.exists() {
            CliStatus::Ready
        } else {
            CliStatus::Waiting
        },
        message: if paths.socket_path.exists() {
            format!("local app socket ready at {}", paths.socket_path.display())
        } else {
            "Gyro.app is not running; CLI sessions will remain resumable".into()
        },
        next: if paths.socket_path.exists() {
            None
        } else {
            Some("open Gyro.app or use `gyro app open` after creating a session".into())
        },
    });

    for profile in &config.command_profiles {
        let command_path = command_in_path(&profile.command);
        checks.push(SetupCheckOutput {
            id: format!("profile:{}", profile.id),
            label: format!("CLI profile: {}", profile.display_name),
            status: if command_path.is_some() {
                CliStatus::Ready
            } else {
                CliStatus::Blocked
            },
            message: command_path
                .map(|path| format!("{} found at {}", profile.command, path.display()))
                .unwrap_or_else(|| format!("{} was not found on PATH", profile.command)),
            next: if command_in_path(&profile.command).is_some() {
                None
            } else {
                Some(format!(
                    "install `{}` or update the `{}` profile command",
                    profile.command, profile.id
                ))
            },
        });
    }

    for agent in ["codex", "claude"] {
        let command_path = command_in_path(agent);
        let profile_hint = if agent == "claude" {
            "claude-code"
        } else {
            agent
        };
        checks.push(SetupCheckOutput {
            id: format!("agent:{agent}"),
            label: format!("Agent CLI: {agent}"),
            status: if command_path.is_some() {
                CliStatus::Ready
            } else {
                CliStatus::Waiting
            },
            message: command_path
                .map(|path| format!("{agent} found at {}", path.display()))
                .unwrap_or_else(|| format!("{agent} is not installed or not on PATH")),
            next: if command_in_path(agent).is_some() {
                None
            } else {
                Some(format!(
                    "install {agent} before selecting it with `gyro run --profile {profile_hint}`"
                ))
            },
        });
    }

    let enabled_providers = config
        .model_providers
        .iter()
        .filter(|provider| provider.enabled)
        .collect::<Vec<_>>();
    if enabled_providers.is_empty() {
        checks.push(SetupCheckOutput {
            id: "provider-readiness".into(),
            label: "Provider readiness".into(),
            status: CliStatus::Waiting,
            message: "no model provider is enabled yet".into(),
            next: Some(
                "run `gyro config enable-provider openai` or connect a provider in Gyro.app".into(),
            ),
        });
    } else {
        let health_service = ProviderHealthService;
        for provider in enabled_providers {
            let health = health_service.check(ProviderHealthRequest {
                provider_id: provider.id.clone(),
                base_url: provider.base_url.clone(),
                api_key_ref: Some(provider.api_key_ref.clone()),
            });
            let (status, message, next) = match health {
                Ok(health) if health.runtime_status == "ready" => {
                    (CliStatus::Ready, health.output, None)
                }
                Ok(health) => {
                    let executable_provider =
                        matches!(provider.id.as_str(), "openai" | "anthropic");
                    let status = if executable_provider
                        && matches!(
                            health.runtime_status.as_str(),
                            "not-installed" | "not-logged-in"
                        ) {
                        CliStatus::Blocked
                    } else {
                        CliStatus::Waiting
                    };
                    let next = health
                        .login_command
                        .map(|command| format!("run `{command}`"));
                    (status, health.output, next)
                }
                Err(error) => (
                    CliStatus::Waiting,
                    format!("provider readiness check failed: {error}"),
                    Some("retry `gyro setup` or inspect the provider in Gyro.app".into()),
                ),
            };
            checks.push(SetupCheckOutput {
                id: format!("provider:{}", provider.id),
                label: format!("Provider: {}", provider.display_name),
                status,
                message,
                next,
            });
        }
    }

    let status = if checks
        .iter()
        .any(|check| check.status == CliStatus::Blocked)
    {
        CliStatus::Blocked
    } else if checks
        .iter()
        .any(|check| check.status == CliStatus::Waiting)
    {
        CliStatus::Waiting
    } else {
        CliStatus::Ready
    };
    let output = SetupOutput {
        status,
        checks,
        mcp_instructions: vec![
            "Codex MCP: `codex mcp add --transport http --header \"Authorization: Bearer <token>\" <name> <url>`".into(),
            "Claude MCP: `claude mcp add --transport http --header \"Authorization: Bearer <token>\" <name> <url>`".into(),
            "Gyro v1 only prints MCP setup guidance; it does not edit third-party agent config files.".into(),
        ],
    };

    if args.json {
        print_json(&output)?;
    } else {
        print_setup_output(&output);
    }
    Ok(())
}

fn print_session_command_output(title: &str, output: &SessionCommandOutput) {
    println!("{title}");
    println!("status: {}", output.status.as_str());
    println!("session: {}", output.session_id);
    println!("workspace: {}", output.workspace.display());
    println!(
        "mode: {} ({})",
        workspace_mode_label(&output.workspace_mode),
        output.branch
    );
    if let Some(worktree_name) = &output.worktree_name {
        println!("worktree: {worktree_name}");
    }
    if let Some(profile_label) = &output.profile_label {
        let model = output
            .model
            .as_deref()
            .map(|model| format!(" · {model}"))
            .unwrap_or_default();
        println!("profile: {profile_label}{model}");
    }
    println!(
        "approval: {}",
        if output.approval_required {
            "required"
        } else {
            "not required"
        }
    );
    if let Some(run) = &output.run {
        println!("provider: {}", run.provider_id);
        println!("duration: {} ms", run.duration_ms);
        println!("exit: {}", run.exit_code.unwrap_or(-1));
        println!("resumed: {}", run.resumed);
    }
    println!("app: {}", output.app_handoff.message);
    println!("resume: {}", output.resume_command);
    if let Some(next) = &output.next_command {
        println!("next: {next}");
    }
    println!("{}", output.message);
}

fn print_sessions_output(output: &SessionListOutput) {
    println!("Gyro sessions");
    println!("status: {}", output.status.as_str());
    if output.sessions.is_empty() {
        println!("No sessions found.");
        return;
    }
    println!(
        "{:<36}  {:<10}  {:<9}  {:<18}  {}",
        "session", "origin", "mode", "updated", "title"
    );
    for session in &output.sessions {
        println!(
            "{:<36}  {:<10}  {:<9}  {:<18}  {}",
            session.session_id,
            format!("{:?}", session.origin).to_lowercase(),
            workspace_mode_label(&session.workspace_mode),
            session.updated_at,
            session.title
        );
        println!("  {}", session.workspace.display());
    }
}

fn print_setup_output(output: &SetupOutput) {
    println!("Gyro setup");
    println!("status: {}", output.status.as_str());
    for check in &output.checks {
        println!(
            "{:<10} {:<28} {}",
            check.status.as_str(),
            check.label,
            check.message
        );
        if let Some(next) = &check.next {
            println!("           next: {next}");
        }
    }
    println!("MCP setup hints");
    for instruction in &output.mcp_instructions {
        println!("  {instruction}");
    }
}

fn app_command(args: AppArgs) -> Result<()> {
    match args.command {
        AppCommand::Open { session_id } => {
            let (paths, store) = open_store()?;
            let session = match session_id {
                Some(id) => store
                    .get_session(id)?
                    .ok_or_else(|| anyhow!("session {id} was not found"))?,
                None => store
                    .latest_session()?
                    .ok_or_else(|| anyhow!("no Gyro sessions exist yet"))?,
            };
            open_session_in_app(&paths, &session, AppNotificationKind::OpenSession)
        }
        AppCommand::Attach {
            workspace,
            worktree,
        } => {
            let (paths, store) = open_store()?;
            let workspace = workspace_path(workspace)?;
            let session =
                create_cli_session(&paths, &store, &workspace, "CLI attach".into(), &worktree)?;
            store.append_event(
                session.id,
                SessionEventKind::SystemEvent,
                "CLI terminal requested desktop attach.",
                serde_json::json!({
                    "surface": "cli",
                    "mode": "attach",
                    "workspaceMode": session.workspace_mode.clone(),
                    "branch": session.branch.clone(),
                    "worktreeName": session.worktree_name.clone(),
                }),
            )?;
            open_session_in_app(&paths, &session, AppNotificationKind::AttachSession)
        }
    }
}

fn open_session_in_app(
    paths: &GyroPaths,
    session: &Session,
    kind: AppNotificationKind,
) -> Result<()> {
    let handoff = perform_app_handoff(paths, session, kind, OpenBehavior::OpenApp)?;
    println!("{}", handoff.message);
    Ok(())
}

fn perform_app_handoff(
    paths: &GyroPaths,
    session: &Session,
    kind: AppNotificationKind,
    behavior: OpenBehavior,
) -> Result<AppHandoffOutput> {
    match behavior {
        OpenBehavior::Skip => Ok(AppHandoffOutput {
            requested: false,
            opened: false,
            message: format!(
                "app handoff skipped; resume available with `gyro resume {}`",
                session.id
            ),
        }),
        OpenBehavior::NotifyRunning => {
            if notify_session(paths, session, kind)? {
                Ok(AppHandoffOutput {
                    requested: true,
                    opened: true,
                    message: format!("opened in running Gyro.app session {}", session.id),
                })
            } else {
                Ok(AppHandoffOutput {
                    requested: true,
                    opened: false,
                    message: format!(
                        "Gyro.app is not running; run `gyro app open {}` to open this session",
                        session.id
                    ),
                })
            }
        }
        OpenBehavior::OpenApp => {
            if notify_session(paths, session, kind.clone())? {
                return Ok(AppHandoffOutput {
                    requested: true,
                    opened: true,
                    message: format!("opened in running Gyro.app session {}", session.id),
                });
            }
            launch_desktop_app(&session.id, kind)?;
            Ok(AppHandoffOutput {
                requested: true,
                opened: true,
                message: format!("launched Gyro.app for session {}", session.id),
            })
        }
    }
}

fn notify_session(paths: &GyroPaths, session: &Session, kind: AppNotificationKind) -> Result<bool> {
    notify_running_app(
        paths,
        &AppNotification {
            kind,
            session_id: session.id.to_string(),
            workspace_path: session.workspace_path.clone(),
            workspace_mode: Some(session.workspace_mode.clone()),
            branch: Some(session.branch.clone()),
            worktree_name: session.worktree_name.clone(),
        },
    )
}

fn launch_desktop_app(session_id: &Uuid, kind: AppNotificationKind) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let route = match kind {
            AppNotificationKind::OpenSession => "open",
            AppNotificationKind::AttachSession => "attach",
        };
        let status = Command::new("open")
            .args([
                "-a",
                "Gyro",
                "--args",
                &format!("gyro://{route}/{session_id}"),
            ])
            .status()
            .context("launch Gyro.app")?;
        if status.success() {
            Ok(())
        } else {
            Err(anyhow!(
                "could not launch Gyro.app; install the desktop app or run from source"
            ))
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = session_id;
        let _ = kind;
        Err(anyhow!(
            "desktop app launch is only implemented for macOS v1"
        ))
    }
}

fn doctor(args: DoctorArgs) -> Result<()> {
    let paths = GyroPaths::for_current_user()?;
    let config = GyroConfig::load(&paths)?;
    let report = run_doctor(&paths, &config);

    if args.json {
        print_json(&report)?;
    } else {
        for check in &report.checks {
            println!(
                "{:<16} {:<5} {}",
                check.label,
                format!("{:?}", check.status),
                check.message
            );
        }
    }

    if report.has_failures() {
        std::process::exit(EXIT_PROVIDER_UNAVAILABLE);
    }
    Ok(())
}

fn config_command(args: ConfigArgs) -> Result<()> {
    let paths = GyroPaths::for_current_user()?;
    let mut config = GyroConfig::load(&paths)?;

    match args.command {
        ConfigCommand::Show { json } => {
            if json {
                print_json(&config)?;
            } else {
                println!("update source: Stable via GitHub Releases");
                println!(
                    "telemetry: {}",
                    if config.telemetry_enabled {
                        "on"
                    } else {
                        "off"
                    }
                );
                println!("providers:");
                for provider in &config.model_providers {
                    println!(
                        "  {} ({}) - {}",
                        provider.display_name,
                        provider.id,
                        if provider.enabled {
                            "enabled"
                        } else {
                            "disabled"
                        }
                    );
                }
                println!("command profiles:");
                for profile in &config.command_profiles {
                    let metadata = match (&profile.provider_id, &profile.default_model) {
                        (Some(provider), Some(model)) => format!(" [{provider} · {model}]"),
                        (Some(provider), None) => format!(" [{provider}]"),
                        (None, Some(model)) => format!(" [{model}]"),
                        (None, None) => String::new(),
                    };
                    println!(
                        "  {} ({}) -> {} {}{}",
                        profile.display_name,
                        profile.id,
                        profile.command,
                        profile.args.join(" "),
                        metadata
                    );
                }
            }
        }
        ConfigCommand::SetUpdateChannel { channel } => {
            require_stable_update_source(&channel)?;
            config.save(&paths)?;
            println!("update source set to Stable via GitHub Releases");
        }
        ConfigCommand::EnableProvider { provider_id } => {
            let display_name = {
                let provider = config
                    .model_providers
                    .iter_mut()
                    .find(|provider| provider.id == provider_id)
                    .ok_or_else(|| anyhow!("unknown provider `{provider_id}`"))?;
                provider.enabled = true;
                provider.display_name.clone()
            };
            config.save(&paths)?;
            println!("enabled provider {display_name}");
        }
        ConfigCommand::SetProviderKey {
            provider_id,
            value,
            env,
        } => {
            let provider = config
                .model_providers
                .iter()
                .find(|provider| provider.id == provider_id)
                .ok_or_else(|| anyhow!("unknown provider `{provider_id}`"))?;
            let value = match (value, env) {
                (Some(value), None) => value,
                (None, Some(env)) => {
                    std::env::var(&env).with_context(|| format!("read provider key from ${env}"))?
                }
                _ => {
                    return Err(anyhow!(
                        "pass exactly one of --value or --env when setting a provider key"
                    ))
                }
            };
            keychain::set_api_key(&provider.api_key_ref, &value)?;
            println!("stored {} API key in macOS Keychain", provider.display_name);
        }
    }

    Ok(())
}

fn require_stable_update_source(channel: &str) -> Result<()> {
    if channel == "stable" {
        Ok(())
    } else {
        Err(anyhow!(
            "Gyro supports only the stable GitHub Releases update source"
        ))
    }
}

fn summarize_title(task: &str) -> String {
    let mut title = task
        .split_whitespace()
        .take(8)
        .collect::<Vec<_>>()
        .join(" ");
    if title.is_empty() {
        title = "CLI task".into();
    }
    if title.len() > 80 {
        title.truncate(80);
    }
    title
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_update_channel_command_accepts_only_stable() {
        assert!(require_stable_update_source("stable").is_ok());
        assert!(require_stable_update_source("beta").is_err());
        assert!(require_stable_update_source("nightly").is_err());
    }

    #[test]
    fn parses_run_profile_model_and_json_flags() {
        let cli = Cli::try_parse_from([
            "gyro",
            "run",
            "--profile",
            "codex",
            "--model",
            "gpt-test",
            "--no-open",
            "--json",
            "inspect this repo",
        ])
        .unwrap();

        let Some(Commands::Run(args)) = cli.command else {
            panic!("expected run command");
        };
        assert_eq!(args.profile.as_deref(), Some("codex"));
        assert_eq!(args.model.as_deref(), Some("gpt-test"));
        assert!(args.no_open);
        assert!(args.json);
        assert!(!args.approve);
        assert_eq!(args.timeout_seconds, 180);
        assert_eq!(args.task, "inspect this repo");
    }

    #[test]
    fn parses_chat_and_resume_execution_controls() {
        let chat = Cli::try_parse_from([
            "gyro",
            "chat",
            "--profile",
            "claude-code",
            "--model",
            "sonnet",
            "--approve",
            "--timeout-seconds",
            "45",
        ])
        .unwrap();
        let Some(Commands::Chat(chat)) = chat.command else {
            panic!("expected chat command");
        };
        assert_eq!(chat.profile.as_deref(), Some("claude-code"));
        assert_eq!(chat.model.as_deref(), Some("sonnet"));
        assert!(chat.approve);
        assert_eq!(chat.timeout_seconds, 45);

        let session_id = Uuid::new_v4();
        let resume = Cli::try_parse_from([
            "gyro",
            "resume",
            &session_id.to_string(),
            "--message",
            "continue safely",
            "--json",
            "--no-open",
            "--timeout-seconds",
            "90",
        ])
        .unwrap();
        let Some(Commands::Resume(resume)) = resume.command else {
            panic!("expected resume command");
        };
        assert_eq!(resume.session_id, Some(session_id));
        assert_eq!(resume.message.as_deref(), Some("continue safely"));
        assert!(resume.json);
        assert!(resume.no_open);
        assert_eq!(resume.timeout_seconds, 90);
    }

    #[test]
    fn invalid_profile_selection_is_blocked_before_session_creation() {
        let config = GyroConfig::default();
        let error = select_command_profile(&config, Some("missing")).unwrap_err();
        let message = error.to_string();
        assert!(message.contains("status: blocked"));
        assert!(message.contains("session saved: no"));
    }

    #[test]
    fn session_command_output_uses_camel_case_json_shape() {
        let output = SessionCommandOutput {
            status: CliStatus::Waiting,
            session_id: Uuid::nil(),
            title: "Inspect".into(),
            workspace: PathBuf::from("/tmp/project"),
            workspace_mode: SessionWorkspaceMode::Local,
            branch: "main".into(),
            worktree_name: None,
            profile_id: Some("codex".into()),
            profile_label: Some("Codex CLI".into()),
            model: Some("gpt-test".into()),
            approval_required: false,
            app_handoff: AppHandoffOutput {
                requested: true,
                opened: false,
                message: "Gyro.app is not running".into(),
            },
            resume_command: "gyro resume 00000000-0000-0000-0000-000000000000".into(),
            next_command: Some("gyro setup".into()),
            message: "local session saved".into(),
            run: None,
        };
        let value = serde_json::to_value(output).unwrap();
        assert_eq!(value["status"], "waiting");
        assert_eq!(value["sessionId"], "00000000-0000-0000-0000-000000000000");
        assert_eq!(value["workspaceMode"], "local");
        assert_eq!(value["profileId"], "codex");
        assert_eq!(value["approvalRequired"], false);
        assert_eq!(value["appHandoff"]["requested"], true);
    }

    #[test]
    fn completed_run_json_includes_stable_execution_evidence() {
        let run_id = Uuid::new_v4();
        let attempt_id = Uuid::new_v4();
        let output = CliRunOutput {
            run_id,
            attempt_id,
            provider_id: "openai".into(),
            duration_ms: 42,
            exit_code: Some(0),
            resumed: true,
            response: "done".into(),
        };
        let value = serde_json::to_value(output).unwrap();

        assert_eq!(value["runId"], run_id.to_string());
        assert_eq!(value["attemptId"], attempt_id.to_string());
        assert_eq!(value["providerId"], "openai");
        assert_eq!(value["durationMs"], 42);
        assert_eq!(value["exitCode"], 0);
        assert_eq!(value["resumed"], true);
        assert_eq!(value["response"], "done");
    }

    #[test]
    fn json_envelopes_are_versioned_without_hiding_command_fields() {
        let output = SessionListOutput {
            status: CliStatus::Ready,
            count: 0,
            sessions: Vec::new(),
        };
        let value = serde_json::to_value(CliJsonEnvelope {
            schema: CLI_JSON_SCHEMA_V1,
            value: &output,
        })
        .unwrap();

        assert_eq!(value["schema"], "gyro.cli.v1");
        assert_eq!(value["status"], "ready");
        assert_eq!(value["count"], 0);
    }

    #[test]
    fn runtime_failures_map_to_stable_exit_categories() {
        assert_eq!(
            classify_cli_error("profile is not installed"),
            CliErrorCategory::ProviderUnavailable
        );
        assert_eq!(
            classify_cli_error("profile `legacy` has no provider"),
            CliErrorCategory::ProviderUnavailable
        );
        assert_eq!(
            classify_cli_error("provider exited with 1: not logged in"),
            CliErrorCategory::ProviderUnavailable
        );
        assert_eq!(
            classify_cli_error("session was not found"),
            CliErrorCategory::InvalidInput
        );
        assert_eq!(
            classify_cli_error("profile `missing` is not configured; session saved: no"),
            CliErrorCategory::InvalidInput
        );
        assert_eq!(
            classify_cli_error("approval was rejected"),
            CliErrorCategory::ApprovalRejected
        );
        assert_eq!(
            classify_cli_error("provider execution failed"),
            CliErrorCategory::ExecutionFailed
        );
        assert_eq!(classify_cli_error("run cancelled by user").exit_code(), 130);
        assert_eq!(CliErrorCategory::Internal.exit_code(), 70);
    }

    #[test]
    fn cli_harness_payloads_keep_resume_metadata_and_approval_gate() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Cli, "Inspect harness")
            .unwrap();
        let profile = CommandProfile {
            id: "codex".into(),
            display_name: "Codex CLI".into(),
            command: "codex".into(),
            args: vec!["exec".into()],
            working_directory: None,
            provider_id: Some("openai".into()),
            default_model: Some("gpt-test".into()),
            readiness: gyro_core::config::CommandProfileReadiness::Ready,
        };
        let run_id = Uuid::new_v4();
        let attempt_id = Uuid::new_v4();

        let run_payload = cli_provider_run_payload(
            run_id,
            attempt_id,
            "run",
            HarnessRunStatus::Queued,
            Some(&profile),
            Some("gpt-test".into()),
            &session,
        )
        .unwrap();
        let command_payload = cli_terminal_request_payload(
            run_id,
            "run",
            HarnessRunStatus::Waiting,
            Some(&profile),
            Some("gpt-test".into()),
            &session,
            true,
        )
        .unwrap();
        let approval_payload = cli_approval_payload(run_id, "run", true, true).unwrap();

        assert_eq!(run_payload["schema"], gyro_core::HARNESS_SCHEMA_V1);
        assert_eq!(run_payload["runId"], run_id.to_string());
        assert_eq!(run_payload["status"], "queued");
        assert_eq!(run_payload["profileId"], "codex");
        assert_eq!(run_payload["model"], "gpt-test");
        assert_eq!(command_payload["kind"], "terminal-request");
        assert_eq!(command_payload["approvalRequired"], true);
        let trusted_command_payload = cli_terminal_request_payload(
            run_id,
            "run",
            HarnessRunStatus::Waiting,
            Some(&profile),
            Some("gpt-test".into()),
            &session,
            false,
        )
        .unwrap();
        assert_eq!(trusted_command_payload["approvalRequired"], false);
        assert_eq!(approval_payload["kind"], "approval-request");
        assert_eq!(approval_payload["requireFileEditApproval"], true);
    }

    #[test]
    fn resume_defaults_to_latest_session() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let first = store
            .create_session(temp.path(), SessionOrigin::Cli, "first")
            .unwrap();
        let second = store
            .create_session(temp.path(), SessionOrigin::Cli, "second")
            .unwrap();

        let latest = store.latest_session().unwrap().unwrap();
        assert_ne!(first.id, second.id);
        assert_eq!(latest.id, second.id);
    }

    #[test]
    fn latest_payload_string_reads_resume_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Cli, "metadata")
            .unwrap();
        store
            .append_event(
                session.id,
                SessionEventKind::SystemEvent,
                "first",
                serde_json::json!({ "profileId": "codex", "model": "old" }),
            )
            .unwrap();
        store
            .append_event(
                session.id,
                SessionEventKind::SystemEvent,
                "second",
                serde_json::json!({ "model": "new" }),
            )
            .unwrap();

        let events = store.read_events(session.id).unwrap();
        assert_eq!(
            latest_payload_string(&events, "profileId").as_deref(),
            Some("codex")
        );
        assert_eq!(
            latest_payload_string(&events, "model").as_deref(),
            Some("new")
        );
    }

    #[test]
    fn shared_stream_decoder_deduplicates_snapshots_and_final_text() {
        let mut decoder = CliStreamDecoder::default();
        assert_eq!(
            decoder.push_stdout(
                "{\"type\":\"content_block_delta\",\"delta\":{\"text\":\"hello \"}}\n"
            ),
            vec!["hello "]
        );
        assert_eq!(
            decoder
                .push_stdout("{\"type\":\"content_block_partial\",\"content\":\"hello world\"}\n"),
            vec!["world"]
        );
        assert!(decoder
            .push_stdout("{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"hello world\"}}\n")
            .is_empty());
        assert_eq!(decoder.response, "hello world");
    }

    #[cfg(unix)]
    #[test]
    fn trusted_cli_run_persists_shared_state_and_ctrl_c_reaches_active_token() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("fake-codex");
        std::fs::write(
            &script,
            "#!/bin/sh\nprintf '%s\\n' '{\"type\":\"item.completed\",\"session_id\":\"019f5a51-d9dc-7423-89fa-8f92cfe4d727\",\"item\":{\"type\":\"agent_message\",\"text\":\"validated\"}}'\n",
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script, permissions).unwrap();

        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Cli, "trusted run")
            .unwrap();
        let profile = CommandProfile {
            id: "codex".into(),
            display_name: "Codex CLI".into(),
            command: script.display().to_string(),
            args: Vec::new(),
            working_directory: None,
            provider_id: Some("openai".into()),
            default_model: None,
            readiness: gyro_core::CommandProfileReadiness::Ready,
        };
        let mut config = GyroConfig::default();
        config.require_command_approval = false;
        config.require_file_edit_approval = false;
        let run_id = Uuid::new_v4();
        let attempt_id = Uuid::new_v4();

        let output = execute_cli_provider(
            &store, &session, &profile, None, "validate", "run", &config, false, true, 5, run_id,
            attempt_id,
        )
        .unwrap();

        assert_eq!(output.response, "validated");
        assert_eq!(output.exit_code, Some(0));
        assert!(store
            .read_events(session.id)
            .unwrap()
            .iter()
            .any(|event| event.kind == SessionEventKind::AssistantMessage
                && event.message == "validated"));
        assert!(store
            .get_provider_session_binding(session.id, "openai")
            .unwrap()
            .is_some());

        let token = CancellationToken::default();
        let guard = activate_cli_cancellation(token.clone()).unwrap();
        unsafe {
            libc::raise(libc::SIGINT);
        }
        for _ in 0..20 {
            if token.is_cancelled() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(token.is_cancelled());
        drop(guard);
    }
}
