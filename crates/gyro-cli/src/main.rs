mod codex_app_server;

use anyhow::{anyhow, Context, Result};
use clap::{Args, CommandFactory, Parser, Subcommand};
use clap_complete::{generate, Shell};
use codex_app_server::{
    run_codex_app_server, ApprovalDecision as CodexApprovalDecision,
    ApprovalKind as CodexApprovalKind, ApprovalRequest as CodexApprovalRequest,
    CodexAppServerOutcome, CodexAppServerRequest,
};
use gyro_core::{
    begin_provider_mutation_transaction, begin_provider_mutation_transaction_with_cancellation,
    config::CommandProfile,
    create_worktree,
    doctor::run_doctor,
    ipc::{app_ipc_listener_ready, notify_running_app_with_status, AppNotificationResult},
    keychain, prepare_claude_provider_mutation_transaction, prepare_provider_mutation_transaction,
    recover_provider_mutation_transactions, slugify_worktree_name, AppNotification,
    AppNotificationKind, ApprovalRequestPayload, CancellationToken, CreateSessionContext,
    DoctorStatus, ExecutionRequest, ExecutionStream, ExecutionTermination, GyroConfig, GyroPaths,
    HarnessRunStatus, MutationDecision, MutationProposal, MutationProposalOperation,
    MutationProposalStatus, PendingProviderMutationCommit, ProviderFileChange,
    ProviderHealthRequest, ProviderHealthService, ProviderMutationJournalContext,
    ProviderRunPayload, ProviderTextChunk, Session, SessionEventKind, SessionOrigin, SessionStore,
    SessionWorkspaceMode, TerminalRequestPayload,
};
use serde::Serialize;
use std::error::Error as StdError;
use std::fmt;
use std::io::{self, BufRead, BufReader, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const CLI_JSON_SCHEMA_V1: &str = "gyro.cli.v1";
const EXIT_PROVIDER_UNAVAILABLE: i32 = 3;

const DEFAULT_SESSION_LIMIT: usize = 20;
const MAX_PROVIDER_RESPONSE_FILE_BYTES: usize = 256 * 1024;
const MAX_PERMISSION_MCP_MESSAGE_BYTES: usize = 1024 * 1024;

fn read_bounded_provider_response_file(path: &Path) -> Result<String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("open provider response {}", path.display()))?;
    if !file.metadata()?.is_file() {
        return Err(anyhow!("provider response is not a regular file"));
    }
    let mut bytes = Vec::with_capacity(8 * 1024);
    Read::by_ref(&mut file)
        .take((MAX_PROVIDER_RESPONSE_FILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_PROVIDER_RESPONSE_FILE_BYTES {
        return Err(anyhow!("provider response file exceeds its size limit"));
    }
    String::from_utf8(bytes).context("provider response file is not UTF-8")
}

#[derive(Debug, Parser)]
#[command(name = "gyro")]
#[command(about = "Open-source local-first coding agent workspace.")]
#[command(version)]
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
    /// Generate shell completions on stdout.
    Completions(CompletionsArgs),
    /// Review and decide pending workspace file approvals.
    Approvals(ApprovalsArgs),
    /// Internal MCP permission bridge used by Claude Code.
    #[command(hide = true)]
    ProviderPermissionServer,
}

#[derive(Debug, Args)]
struct CompletionsArgs {
    /// Shell to generate completions for.
    #[arg(value_enum)]
    shell: Shell,
}

#[derive(Debug, Args)]
struct ApprovalsArgs {
    /// Emit versioned JSON instead of text.
    #[arg(long, global = true)]
    json: bool,

    /// Limit the inbox to one session.
    #[arg(long, global = true)]
    session: Option<Uuid>,

    /// Maximum number of pending approvals to list.
    #[arg(long, global = true, default_value_t = 50, value_parser = clap::value_parser!(u8).range(1..=100))]
    limit: u8,

    #[command(subcommand)]
    command: Option<ApprovalCommand>,
}

#[derive(Debug, Subcommand)]
enum ApprovalCommand {
    /// Show the bounded diff for one pending file edit.
    Show { proposal_id: Uuid },
    /// Apply one reviewed file edit if its base content is unchanged.
    Approve { proposal_id: Uuid },
    /// Reject one pending file edit without writing to disk.
    Reject { proposal_id: Uuid },
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

    /// Emit newline-delimited, versioned JSON events instead of interactive prompts.
    #[arg(long)]
    json: bool,

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
            json: false,
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
    /// Emit versioned JSON instead of text.
    #[arg(long, global = true)]
    json: bool,

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
    SetUpdateChannel {
        channel: String,
        /// Emit versioned JSON instead of text.
        #[arg(long)]
        json: bool,
    },
    /// Enable a configured model provider.
    EnableProvider {
        provider_id: String,
        /// Emit versioned JSON instead of text.
        #[arg(long)]
        json: bool,
    },
    /// Store a provider API key in macOS Keychain.
    SetProviderKey {
        provider_id: String,
        /// API key value. Prefer --env for shell-history safety.
        #[arg(long)]
        value: Option<String>,
        /// Environment variable containing the key.
        #[arg(long)]
        env: Option<String>,
        /// Emit versioned JSON instead of text.
        #[arg(long)]
        json: bool,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    app_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    compatible: Option<bool>,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatEventOutput {
    event: &'static str,
    status: CliStatus,
    session_id: Uuid,
    workspace: PathBuf,
    profile_id: String,
    profile_label: String,
    model: Option<String>,
    approval_required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    run: Option<CliRunOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    app_handoff: Option<AppHandoffOutput>,
}

struct ChatEventContext<'a> {
    session: &'a Session,
    profile: &'a CommandProfile,
    model: Option<&'a str>,
    approval_required: bool,
}

impl ChatEventContext<'_> {
    fn output(
        &self,
        event: &'static str,
        status: CliStatus,
        run: Option<CliRunOutput>,
        app_handoff: Option<AppHandoffOutput>,
    ) -> ChatEventOutput {
        ChatEventOutput {
            event,
            status,
            session_id: self.session.id,
            workspace: self.session.workspace_path.clone(),
            profile_id: self.profile.id.clone(),
            profile_label: self.profile.display_name.clone(),
            model: self.model.map(str::to_string),
            approval_required: self.approval_required,
            run,
            app_handoff,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppCommandOutput {
    status: CliStatus,
    action: &'static str,
    session: SessionSummaryOutput,
    app_handoff: AppHandoffOutput,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigMutationOutput {
    status: CliStatus,
    action: &'static str,
    target: String,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalInboxOutput {
    status: CliStatus,
    count: usize,
    approvals: Vec<ApprovalSummaryOutput>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalSummaryOutput {
    proposal_id: Uuid,
    session_id: Uuid,
    workspace: PathBuf,
    path: String,
    operation: MutationProposalOperation,
    status: MutationProposalStatus,
    created_at: String,
}

impl From<&MutationProposal> for ApprovalSummaryOutput {
    fn from(proposal: &MutationProposal) -> Self {
        Self {
            proposal_id: proposal.id,
            session_id: proposal.session_id,
            workspace: proposal.workspace_path.clone(),
            path: proposal.path.clone(),
            operation: proposal.operation,
            status: proposal.status,
            created_at: proposal.created_at.to_rfc3339(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalReviewOutput {
    status: CliStatus,
    approval: ApprovalSummaryOutput,
    old_lines: usize,
    new_lines: usize,
    diff_preview: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalDecisionOutput {
    status: CliStatus,
    decision: MutationDecision,
    approval: ApprovalSummaryOutput,
    changed_path: Option<PathBuf>,
    message: String,
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

#[derive(Debug)]
struct CliFailure {
    category: CliErrorCategory,
    message: String,
    report: bool,
}

impl fmt::Display for CliFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl StdError for CliFailure {}

fn cli_failure(category: CliErrorCategory, message: impl Into<String>) -> anyhow::Error {
    CliFailure {
        category,
        message: message.into(),
        report: true,
    }
    .into()
}

fn silent_cli_failure(category: CliErrorCategory, message: impl Into<String>) -> anyhow::Error {
    CliFailure {
        category,
        message: message.into(),
        report: false,
    }
    .into()
}

fn cli_failure_details(error: &anyhow::Error) -> (CliErrorCategory, bool) {
    error
        .downcast_ref::<CliFailure>()
        .map(|failure| (failure.category, failure.report))
        .unwrap_or((CliErrorCategory::Internal, true))
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
            Some(Commands::Chat(args)) => args.json,
            Some(Commands::Run(args)) => args.json,
            Some(Commands::Resume(args)) => args.json,
            Some(Commands::Sessions(args)) => args.json,
            Some(Commands::Setup(args)) => args.json,
            Some(Commands::App(args)) => args.json,
            Some(Commands::Doctor(args)) => args.json,
            Some(Commands::Approvals(args)) => args.json,
            Some(Commands::ProviderPermissionServer) => false,
            Some(Commands::Config(ConfigArgs {
                command: ConfigCommand::Show { json },
            })) => *json,
            Some(Commands::Config(ConfigArgs {
                command: ConfigCommand::SetUpdateChannel { json, .. },
            }))
            | Some(Commands::Config(ConfigArgs {
                command: ConfigCommand::EnableProvider { json, .. },
            }))
            | Some(Commands::Config(ConfigArgs {
                command: ConfigCommand::SetProviderKey { json, .. },
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
        let (category, report) = cli_failure_details(&error);
        if json && report {
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
        } else if report {
            eprintln!("Gyro CLI failed: {message}");
        }
        std::process::exit(category.exit_code());
    }
}

fn run_cli(cli: Cli) -> Result<()> {
    recover_provider_mutations_on_startup()?;
    match cli.command {
        Some(Commands::Chat(args)) => interactive_chat(args),
        Some(Commands::Run(args)) => run_task(args),
        Some(Commands::Resume(args)) => resume_session(args),
        Some(Commands::Sessions(args)) => sessions_command(args),
        Some(Commands::Setup(args)) => setup_command(args),
        Some(Commands::App(args)) => app_command(args),
        Some(Commands::Doctor(args)) => doctor(args),
        Some(Commands::Config(args)) => config_command(args),
        Some(Commands::Completions(args)) => completions_command(args),
        Some(Commands::Approvals(args)) => approvals_command(args),
        Some(Commands::ProviderPermissionServer) => provider_permission_server(),
        None => interactive_chat(ChatArgs::default()),
    }
}

fn recover_provider_mutations_on_startup() -> Result<()> {
    let paths = GyroPaths::for_current_user()?;
    let store = SessionStore::open(paths.clone())?;
    recover_provider_mutation_transactions(&paths.mutation_journals_dir, &store)?;
    Ok(())
}

fn completions_command(args: CompletionsArgs) -> Result<()> {
    let mut command = Cli::command();
    generate(args.shell, &mut command, "gyro", &mut io::stdout());
    Ok(())
}

fn approvals_command(args: ApprovalsArgs) -> Result<()> {
    let (_, store) = open_store()?;
    match args.command {
        None => {
            let proposals = if let Some(session_id) = args.session {
                if store.get_session(session_id)?.is_none() {
                    return Err(cli_failure(
                        CliErrorCategory::InvalidInput,
                        format!("session {session_id} was not found"),
                    ));
                }
                store.list_pending_mutation_proposals(session_id)?
            } else {
                store.list_pending_mutation_proposals_all(args.limit as usize)?
            };
            let approvals = proposals
                .iter()
                .take(args.limit as usize)
                .map(ApprovalSummaryOutput::from)
                .collect::<Vec<_>>();
            let output = ApprovalInboxOutput {
                status: if approvals.is_empty() {
                    CliStatus::Done
                } else {
                    CliStatus::Waiting
                },
                count: approvals.len(),
                approvals,
            };
            if args.json {
                print_json(&output)?;
            } else {
                print_approval_inbox(&output);
            }
            Ok(())
        }
        Some(ApprovalCommand::Show { proposal_id }) => {
            let proposal = approval_proposal(&store, proposal_id)?;
            let review = gyro_core::review_mutation_proposal(proposal).map_err(|error| {
                cli_failure(
                    CliErrorCategory::ExecutionFailed,
                    format!("approval review failed: {error}"),
                )
            })?;
            let output = ApprovalReviewOutput {
                status: if review.proposal.status == MutationProposalStatus::Pending {
                    CliStatus::Waiting
                } else {
                    CliStatus::Done
                },
                approval: ApprovalSummaryOutput::from(&review.proposal),
                old_lines: review.diff.old_lines,
                new_lines: review.diff.new_lines,
                diff_preview: review.diff.preview,
            };
            if args.json {
                print_json(&output)?;
            } else {
                print_approval_review(&output);
            }
            Ok(())
        }
        Some(ApprovalCommand::Approve { proposal_id }) => {
            decide_cli_mutation(&store, proposal_id, MutationDecision::Approve, args.json)
        }
        Some(ApprovalCommand::Reject { proposal_id }) => {
            decide_cli_mutation(&store, proposal_id, MutationDecision::Reject, args.json)
        }
    }
}

fn approval_proposal(store: &SessionStore, proposal_id: Uuid) -> Result<MutationProposal> {
    store.get_mutation_proposal(proposal_id)?.ok_or_else(|| {
        cli_failure(
            CliErrorCategory::InvalidInput,
            format!("approval {proposal_id} was not found"),
        )
    })
}

fn decide_cli_mutation(
    store: &SessionStore,
    proposal_id: Uuid,
    decision: MutationDecision,
    json: bool,
) -> Result<()> {
    let cancellation = CancellationToken::default();
    let _cancellation_guard = activate_cli_cancellation(cancellation.clone())?;
    ensure_cli_not_cancelled(&cancellation, "before the approval decision")?;
    let existing = approval_proposal(store, proposal_id)?;
    if existing.status != MutationProposalStatus::Pending
        && !(decision == MutationDecision::Reject
            && existing.status == MutationProposalStatus::Rejected)
        && !(decision == MutationDecision::Approve
            && existing.status == MutationProposalStatus::Applied)
    {
        return Err(cli_failure(
            CliErrorCategory::InvalidInput,
            format!(
                "approval {proposal_id} is already {}",
                existing.status.as_str()
            ),
        ));
    }
    let result =
        gyro_core::decide_mutation_proposal_with_cancellation(store, proposal_id, decision, || {
            cancellation.is_cancelled()
        })
        .map_err(|error| {
            if gyro_core::mutation_decision_was_cancelled(&error) {
                cli_failure(
                    CliErrorCategory::Cancelled,
                    "approval decision cancelled; the proposal remains pending",
                )
            } else {
                cli_failure(
                    CliErrorCategory::ExecutionFailed,
                    format!("approval decision failed: {error}"),
                )
            }
        })?;
    let status = match result.proposal.status {
        MutationProposalStatus::Applied | MutationProposalStatus::Rejected => CliStatus::Done,
        MutationProposalStatus::Failed => CliStatus::Failed,
        MutationProposalStatus::Pending | MutationProposalStatus::Applying => CliStatus::Waiting,
    };
    let message = match result.proposal.status {
        MutationProposalStatus::Applied => format!("applied {}", result.proposal.path),
        MutationProposalStatus::Rejected => {
            format!("rejected changes to {}", result.proposal.path)
        }
        MutationProposalStatus::Failed => format!("could not apply {}", result.proposal.path),
        MutationProposalStatus::Pending => format!("{} is still pending", result.proposal.path),
        MutationProposalStatus::Applying => format!("{} is being applied", result.proposal.path),
    };
    let output = ApprovalDecisionOutput {
        status,
        decision,
        approval: ApprovalSummaryOutput::from(&result.proposal),
        changed_path: result.changed_path,
        message,
    };
    if json {
        print_json(&output)?;
    } else {
        println!("{}", output.message);
    }
    Ok(())
}

fn print_approval_inbox(output: &ApprovalInboxOutput) {
    if output.approvals.is_empty() {
        println!("No pending approvals.");
        return;
    }
    println!("Pending approvals ({})", output.count);
    for approval in &output.approvals {
        println!(
            "{}  {:<6}  {}",
            approval.proposal_id,
            mutation_operation_label(approval.operation),
            approval.path
        );
        println!("  workspace: {}", approval.workspace.display());
    }
    println!("Review one with `gyro approvals show <proposal-id>`.");
}

fn print_approval_review(output: &ApprovalReviewOutput) {
    println!(
        "{} {}",
        mutation_operation_label(output.approval.operation),
        output.approval.path
    );
    println!("workspace: {}", output.approval.workspace.display());
    println!("status: {}", output.approval.status.as_str());
    println!("lines: {} -> {}", output.old_lines, output.new_lines);
    println!();
    print!("{}", output.diff_preview);
    if !output.diff_preview.ends_with('\n') {
        println!();
    }
    if output.approval.status == MutationProposalStatus::Pending {
        println!();
        println!(
            "Decide with `gyro approvals approve {}` or `gyro approvals reject {}`.",
            output.approval.proposal_id, output.approval.proposal_id
        );
    }
}

fn mutation_operation_label(operation: MutationProposalOperation) -> &'static str {
    match operation {
        MutationProposalOperation::Create => "create",
        MutationProposalOperation::Update => "update",
    }
}

struct ProviderPermissionContext {
    session_id: Uuid,
    turn_id: Uuid,
    profile_id: String,
    provider_id: String,
    require_command: bool,
    require_file: bool,
    auto_approve: bool,
    json: bool,
}

impl ProviderPermissionContext {
    fn from_env() -> Result<Self> {
        Ok(Self {
            session_id: permission_env_uuid("GYRO_PERMISSION_SESSION_ID")?,
            turn_id: permission_env_uuid("GYRO_PERMISSION_TURN_ID")?,
            profile_id: permission_env("GYRO_PERMISSION_PROFILE_ID")?,
            provider_id: permission_env("GYRO_PERMISSION_PROVIDER_ID")?,
            require_command: permission_env_bool("GYRO_PERMISSION_REQUIRE_COMMAND")?,
            require_file: permission_env_bool("GYRO_PERMISSION_REQUIRE_FILE")?,
            auto_approve: permission_env_bool("GYRO_PERMISSION_AUTO_APPROVE")?,
            json: permission_env_bool("GYRO_PERMISSION_JSON")?,
        })
    }
}

fn provider_permission_server() -> Result<()> {
    let context = ProviderPermissionContext::from_env()?;
    let (paths, store) = open_store()?;
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    let mut stdin = stdin.lock();
    while let Some(line) = read_bounded_mcp_line(&mut stdin)? {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let request: serde_json::Value = match serde_json::from_slice(&line) {
            Ok(request) => request,
            Err(error) => {
                write_mcp_message(
                    &mut stdout,
                    &serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": null,
                        "error": { "code": -32700, "message": error.to_string() },
                    }),
                )?;
                continue;
            }
        };
        let Some(method) = request.get("method").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let Some(id) = request.get("id").cloned() else {
            continue;
        };
        let result = match method {
            "initialize" => Ok(serde_json::json!({
                "protocolVersion": request
                    .pointer("/params/protocolVersion")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("2024-11-05"),
                "capabilities": { "tools": {} },
                "serverInfo": {
                    "name": "gyro-approval",
                    "version": env!("CARGO_PKG_VERSION"),
                },
            })),
            "ping" => Ok(serde_json::json!({})),
            "tools/list" => Ok(serde_json::json!({
                "tools": [{
                    "name": "approve",
                    "description": "Ask Gyro to approve or reject one Claude Code tool action.",
                    "inputSchema": {
                        "type": "object",
                        "additionalProperties": true,
                    },
                }],
            })),
            "tools/call" => handle_permission_tool_call(
                &store,
                &paths.mutation_journals_dir,
                &context,
                request.get("params").cloned().unwrap_or_default(),
            ),
            _ => Err(anyhow!("unsupported MCP method `{method}`")),
        };
        match result {
            Ok(result) => write_mcp_message(
                &mut stdout,
                &serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            )?,
            Err(error) => write_mcp_message(
                &mut stdout,
                &serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32603, "message": error.to_string() },
                }),
            )?,
        }
    }
    Ok(())
}

fn handle_permission_tool_call(
    store: &SessionStore,
    mutation_journal_dir: &Path,
    context: &ProviderPermissionContext,
    params: serde_json::Value,
) -> Result<serde_json::Value> {
    if params.get("name").and_then(serde_json::Value::as_str) != Some("approve") {
        return Err(anyhow!("unknown Gyro approval tool"));
    }
    let arguments = params.get("arguments").cloned().unwrap_or_default();
    let tool_name = arguments
        .get("tool_name")
        .or_else(|| arguments.get("toolName"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown");
    let tool_input = arguments
        .get("input")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let kind = permission_tool_kind(tool_name);
    let details = sanitize_provider_approval_details(serde_json::json!({
        "toolName": tool_name,
        "input": tool_input,
        "permissionSuggestions": arguments
            .get("permission_suggestions")
            .or_else(|| arguments.get("permissionSuggestions")),
    }));
    let approval_id = Uuid::new_v4();
    let mut payload = serde_json::json!({
        "schema": "gyro.provider-approval.v1",
        "kind": "provider-tool-approval",
        "surface": "cli",
        "approvalId": approval_id,
        "approvalType": kind.as_str(),
        "providerId": context.provider_id,
        "profileId": context.profile_id,
        "details": details,
        "status": "pending",
        "risk": codex_approval_risk(kind),
    });
    store.append_event_with_turn_id(
        context.session_id,
        SessionEventKind::ApprovalRequested,
        codex_approval_label(kind),
        payload.clone(),
        Some(context.turn_id),
    )?;

    let required = match kind {
        CodexApprovalKind::Command => context.require_command,
        CodexApprovalKind::FileChange => context.require_file,
        CodexApprovalKind::Permissions => true,
    };
    let mut approved = if !required || context.auto_approve {
        true
    } else if context.json {
        false
    } else {
        prompt_permission_on_tty(kind, &details)?
    };
    let mut applied_by_gyro = false;
    let mut apply_error = None;
    let mut pending_mutation: Option<PendingProviderMutationCommit> = None;
    if approved && kind == CodexApprovalKind::FileChange {
        let result = (|| -> Result<_> {
            let session = store
                .get_session(context.session_id)?
                .ok_or_else(|| anyhow!("permission bridge session was not found"))?;
            let transaction = prepare_claude_provider_mutation_transaction(
                &session.workspace_path,
                tool_name,
                &tool_input,
            )?;
            begin_provider_mutation_transaction(
                &transaction,
                mutation_journal_dir,
                ProviderMutationJournalContext {
                    session_id: context.session_id,
                    approval_id,
                },
            )
        })();
        match result {
            Ok(pending) => {
                payload["changedPaths"] =
                    serde_json::to_value(pending.result().changed_paths.clone())?;
                applied_by_gyro = true;
                pending_mutation = Some(pending);
            }
            Err(error) => {
                approved = false;
                apply_error = Some(gyro_core::sanitize_harness_text(&error.to_string()));
            }
        }
    }
    payload["status"] = serde_json::Value::String(if applied_by_gyro {
        "applied".into()
    } else if apply_error.is_some() {
        "failed".into()
    } else if approved {
        "approved".into()
    } else {
        "rejected".into()
    });
    if let Some(error) = apply_error.as_ref() {
        payload["error"] = serde_json::Value::String(error.clone());
    }
    let decision_event = store.append_event_with_turn_id(
        context.session_id,
        SessionEventKind::SystemEvent,
        if applied_by_gyro {
            "Provider file changes applied through Gyro."
        } else if apply_error.is_some() {
            "Provider file changes were not applied."
        } else if approved {
            "Provider action approved."
        } else {
            "Provider action rejected."
        },
        payload,
        Some(context.turn_id),
    );
    if let Err(error) = decision_event {
        if let Some(pending) = pending_mutation {
            pending.rollback().with_context(|| {
                format!("record provider approval failed ({error}); rollback also failed")
            })?;
        }
        return Err(error);
    }
    if let Some(pending) = pending_mutation {
        if let Err(error) = pending.finalize() {
            eprintln!(
                "Gyro deferred provider mutation cleanup until restart: {}",
                gyro_core::sanitize_harness_text(&error.to_string())
            );
        }
    }

    let permission_result = if applied_by_gyro {
        serde_json::json!({
            "behavior": "deny",
            "message": "Gyro already applied the reviewed file changes atomically.",
        })
    } else if approved {
        serde_json::json!({ "behavior": "allow", "updatedInput": tool_input })
    } else if let Some(error) = apply_error {
        serde_json::json!({
            "behavior": "deny",
            "message": format!("Gyro could not apply the reviewed file changes: {error}"),
        })
    } else {
        serde_json::json!({
            "behavior": "deny",
            "message": "Gyro rejected this provider action.",
        })
    };
    Ok(serde_json::json!({
        "content": [{
            "type": "text",
            "text": serde_json::to_string(&permission_result)?,
        }],
        "isError": false,
    }))
}

fn permission_tool_kind(tool_name: &str) -> CodexApprovalKind {
    match tool_name {
        "Bash" | "KillShell" => CodexApprovalKind::Command,
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => CodexApprovalKind::FileChange,
        _ => CodexApprovalKind::Permissions,
    }
}

fn prompt_permission_on_tty(kind: CodexApprovalKind, details: &serde_json::Value) -> Result<bool> {
    #[cfg(unix)]
    {
        let mut tty = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open("/dev/tty")
            .context("open terminal for provider approval")?;
        writeln!(tty)?;
        writeln!(tty, "{} required", codex_approval_label(kind))?;
        if let Some(tool_name) = details.get("toolName").and_then(serde_json::Value::as_str) {
            writeln!(tty, "  tool:    {tool_name}")?;
        }
        let input = details.get("input").unwrap_or(details);
        if let Some(command) = approval_command_text(input) {
            writeln!(tty, "  command: {command}")?;
        }
        for path in approval_file_paths(input).into_iter().take(6) {
            writeln!(tty, "  file:    {path}")?;
        }
        write!(tty, "Approve this action? [y/N] ")?;
        tty.flush()?;
        let mut answer = String::new();
        BufReader::new(tty.try_clone()?).read_line(&mut answer)?;
        Ok(matches!(
            answer.trim().to_ascii_lowercase().as_str(),
            "y" | "yes"
        ))
    }
    #[cfg(not(unix))]
    {
        let _ = (kind, details);
        Ok(false)
    }
}

fn write_mcp_message(writer: &mut impl Write, message: &serde_json::Value) -> Result<()> {
    let bytes = serde_json::to_vec(message)?;
    if bytes.len() > MAX_PERMISSION_MCP_MESSAGE_BYTES {
        return Err(anyhow!("permission MCP response exceeds its size limit"));
    }
    writer.write_all(&bytes)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

fn read_bounded_mcp_line(reader: &mut impl BufRead) -> Result<Option<Vec<u8>>> {
    let mut line = Vec::with_capacity(8 * 1024);
    let read = Read::by_ref(reader)
        .take((MAX_PERMISSION_MCP_MESSAGE_BYTES + 1) as u64)
        .read_until(b'\n', &mut line)?;
    if read == 0 {
        return Ok(None);
    }
    if line.len() > MAX_PERMISSION_MCP_MESSAGE_BYTES {
        return Err(anyhow!("permission MCP request exceeds its size limit"));
    }
    if line.last() != Some(&b'\n') {
        return Err(anyhow!("permission MCP request ended before its newline"));
    }
    line.pop();
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    Ok(Some(line))
}

fn permission_env(name: &str) -> Result<String> {
    std::env::var(name).map_err(|_| anyhow!("missing permission bridge environment `{name}`"))
}

fn permission_env_uuid(name: &str) -> Result<Uuid> {
    permission_env(name)?
        .parse()
        .map_err(|error| anyhow!("invalid permission bridge environment `{name}`: {error}"))
}

fn permission_env_bool(name: &str) -> Result<bool> {
    permission_env(name)?
        .parse()
        .map_err(|error| anyhow!("invalid permission bridge environment `{name}`: {error}"))
}

fn open_store() -> Result<(GyroPaths, SessionStore)> {
    let paths = GyroPaths::for_current_user()?;
    let store = SessionStore::open(paths.clone())?;
    Ok((paths, store))
}

fn workspace_path(explicit: Option<PathBuf>) -> Result<PathBuf> {
    let workspace = explicit.unwrap_or(std::env::current_dir()?);
    workspace.canonicalize().map_err(|error| {
        cli_failure(
            CliErrorCategory::InvalidInput,
            format!(
                "workspace `{}` could not be resolved: {error}",
                workspace.display()
            ),
        )
    })
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
            cli_failure(
                CliErrorCategory::InvalidInput,
                format!(
                    "status: blocked\nprofile `{profile_id}` is not configured\nnext: run `gyro config show` to inspect available CLI profiles\nsession saved: no"
                ),
            )
        })
}

fn select_execution_profile<'a>(
    config: &'a GyroConfig,
    profile_id: Option<&str>,
    session_saved: bool,
) -> Result<&'a CommandProfile> {
    let profile = if let Some(profile) = select_command_profile(config, profile_id)? {
        profile
    } else {
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
                cli_failure(
                    CliErrorCategory::ProviderUnavailable,
                    format!(
                        "provider unavailable: choose an enabled executable profile with `--profile <id>`; next: run `gyro setup`; session saved: {}",
                        if session_saved { "yes" } else { "no" }
                    ),
                )
            })?
    };
    let provider_id = profile.provider_id.as_deref().ok_or_else(|| {
        cli_failure(
            CliErrorCategory::ProviderUnavailable,
            format!(
                "profile `{}` has no executable provider; next: run `gyro config show`; session saved: {}",
                profile.id,
                if session_saved { "yes" } else { "no" }
            ),
        )
    })?;
    let provider_enabled = config
        .model_providers
        .iter()
        .any(|provider| provider.id == provider_id && provider.enabled);
    if !provider_enabled {
        return Err(cli_failure(
            CliErrorCategory::ProviderUnavailable,
            format!(
                "provider `{provider_id}` is disabled for profile `{}`; next: run `gyro config enable-provider {provider_id}`; session saved: {}",
                profile.id,
                if session_saved { "yes" } else { "no" }
            ),
        ));
    }
    Ok(profile)
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

struct CliProviderExecution {
    output_path: Option<PathBuf>,
    provider_kind: CliProviderKind,
    proposed_session_id: Option<String>,
    decoder: CliStreamDecoder,
    outcome: gyro_core::ExecutionOutcome,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CliProviderFailureKind {
    Authentication,
    Network,
    Other,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CliProviderFailure {
    kind: CliProviderFailureKind,
    message: String,
}

#[derive(Default)]
struct CliStreamDecoder {
    line_buffer: String,
    response: String,
    provider_session_id: Option<String>,
    provider_failure: Option<CliProviderFailure>,
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
        if let Some(failure) = cli_provider_failure_from_event(&value) {
            self.record_provider_failure(failure);
            return;
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

    fn record_provider_failure(&mut self, failure: CliProviderFailure) {
        let replace = self.provider_failure.as_ref().map_or(true, |current| {
            cli_provider_failure_priority(failure.kind)
                > cli_provider_failure_priority(current.kind)
                || (failure.kind == current.kind && failure.message.len() > current.message.len())
        });
        if replace {
            self.provider_failure = Some(failure);
        }
    }
}

fn cli_provider_failure_priority(kind: CliProviderFailureKind) -> u8 {
    match kind {
        CliProviderFailureKind::Other => 0,
        CliProviderFailureKind::Network => 1,
        CliProviderFailureKind::Authentication => 2,
    }
}

fn cli_provider_failure_from_event(value: &serde_json::Value) -> Option<CliProviderFailure> {
    let event_type = value
        .get("type")
        .or_else(|| value.get("event"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let subtype = value
        .get("subtype")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let api_status = value
        .get("api_error_status")
        .or_else(|| value.get("apiErrorStatus"))
        .and_then(serde_json::Value::as_u64);
    let explicit_error = value
        .get("is_error")
        .or_else(|| value.get("isError"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
        || api_status.is_some_and(|status| status >= 400)
        || value.get("error").is_some_and(|error| !error.is_null())
        || event_type.contains("error")
        || subtype.starts_with("error");

    let mut messages = ["error", "result", "message", "detail"]
        .into_iter()
        .filter_map(|key| value.get(key))
        .filter_map(|candidate| cli_provider_failure_text(candidate, 0))
        .filter(|message| !message.trim().is_empty())
        .collect::<Vec<_>>();
    messages.dedup();
    let combined = messages.join(" ");
    let normalized = combined.to_ascii_lowercase();
    let kind = if api_status == Some(401)
        || api_status == Some(403)
        || normalized.contains("authentication_failed")
        || normalized.contains("authentication failed")
        || normalized.contains("failed to authenticate")
        || normalized.contains("invalid authentication credentials")
        || normalized.contains("not authenticated")
        || normalized.contains("not logged in")
        || normalized.contains("unauthorized")
    {
        CliProviderFailureKind::Authentication
    } else if normalized.contains("network")
        || normalized.contains("connection")
        || normalized.contains("dns")
        || normalized.contains("timed out")
        || normalized.contains("timeout")
        || normalized.contains("offline")
    {
        CliProviderFailureKind::Network
    } else {
        CliProviderFailureKind::Other
    };
    if !explicit_error {
        return None;
    }

    let fallback = api_status
        .map(|status| format!("provider API returned HTTP {status}"))
        .unwrap_or_else(|| "provider reported an error".into());
    let message = gyro_core::sanitize_harness_text(if combined.trim().is_empty() {
        &fallback
    } else {
        combined.trim()
    });
    Some(CliProviderFailure { kind, message })
}

fn cli_provider_failure_text(value: &serde_json::Value, depth: usize) -> Option<String> {
    if depth > 4 {
        return None;
    }
    match value {
        serde_json::Value::String(value) => Some(value.clone()),
        serde_json::Value::Array(values) => {
            let text = values
                .iter()
                .filter_map(|value| cli_provider_failure_text(value, depth + 1))
                .collect::<Vec<_>>()
                .join(" ");
            (!text.trim().is_empty()).then_some(text)
        }
        serde_json::Value::Object(values) => {
            for key in ["message", "detail", "error", "result", "text", "content"] {
                if let Some(text) = values
                    .get(key)
                    .and_then(|value| cli_provider_failure_text(value, depth + 1))
                    .filter(|text| !text.trim().is_empty())
                {
                    return Some(text);
                }
            }
            None
        }
        _ => None,
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

fn ensure_cli_not_cancelled(cancellation: &CancellationToken, phase: &str) -> Result<()> {
    if cancellation.is_cancelled() {
        Err(cli_failure(
            CliErrorCategory::Cancelled,
            format!("run cancelled by user {phase}"),
        ))
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn read_cli_approval_answer(cancellation: &CancellationToken) -> Result<String> {
    use std::os::fd::AsRawFd;

    let stdin = io::stdin();
    let mut descriptor = libc::pollfd {
        fd: stdin.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    loop {
        ensure_cli_not_cancelled(cancellation, "during provider approval")?;
        descriptor.revents = 0;
        let result = unsafe { libc::poll(&mut descriptor, 1, 50) };
        if result < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error.into());
        }
        if result == 0 {
            continue;
        }
        if descriptor.revents & (libc::POLLERR | libc::POLLNVAL) != 0 {
            return Err(anyhow!("terminal input became unavailable during approval"));
        }
        if descriptor.revents & (libc::POLLIN | libc::POLLHUP) != 0 {
            let mut answer = String::new();
            match stdin.read_line(&mut answer) {
                Ok(_) => {
                    ensure_cli_not_cancelled(cancellation, "during provider approval")?;
                    return Ok(answer);
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error.into()),
            }
        }
    }
}

#[cfg(not(unix))]
fn read_cli_approval_answer(cancellation: &CancellationToken) -> Result<String> {
    let mut answer = String::new();
    io::stdin().read_line(&mut answer)?;
    ensure_cli_not_cancelled(cancellation, "during provider approval")?;
    Ok(answer)
}

fn cli_provider_kind(profile: &CommandProfile) -> Result<CliProviderKind> {
    match profile.provider_id.as_deref() {
        Some("openai") => Ok(CliProviderKind::Codex),
        Some("anthropic") => Ok(CliProviderKind::Claude),
        Some(provider_id) => Err(cli_failure(
            CliErrorCategory::ProviderUnavailable,
            format!("provider `{provider_id}` is unavailable for CLI execution"),
        )),
        None => Err(cli_failure(
            CliErrorCategory::ProviderUnavailable,
            format!(
                "profile `{}` is not configured with an executable provider",
                profile.id
            ),
        )),
    }
}

fn profile_uses_action_approvals(profile: Option<&CommandProfile>) -> bool {
    matches!(
        profile.and_then(|profile| profile.provider_id.as_deref()),
        Some("openai" | "anthropic")
    )
}

fn is_stale_provider_resume_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    let resume_identity = normalized.contains("resume")
        || normalized.contains("session")
        || normalized.contains("thread");
    let missing_identity = normalized.contains("not found")
        || normalized.contains("no such")
        || normalized.contains("unknown")
        || normalized.contains("missing")
        || normalized.contains("expired")
        || normalized.contains("could not resume");
    resume_identity && missing_identity
}

fn build_cli_provider_invocation(
    profile: &CommandProfile,
    workspace: &Path,
    prompt: &str,
    model: Option<&str>,
    resume_cursor: Option<(&str, &str)>,
    permission_mcp_config: Option<&str>,
    timeout_seconds: u64,
) -> Result<CliProviderInvocation> {
    let provider_kind = cli_provider_kind(profile)?;
    let mut args = profile.args.clone();
    if provider_kind != CliProviderKind::Claude {
        return Err(anyhow!(
            "Codex CLI execution must use the app-server approval adapter"
        ));
    }
    args.extend([
        "--print".into(),
        "--verbose".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--include-partial-messages".into(),
    ]);
    let proposed_session_id = if let Some(("claude-session", session_id)) = resume_cursor {
        args.extend(["--resume".into(), session_id.into()]);
        session_id.into()
    } else {
        let session_id = Uuid::new_v4().to_string();
        args.extend(["--session-id".into(), session_id.clone()]);
        session_id
    };
    if let Some(model) = model.map(str::trim).filter(|model| !model.is_empty()) {
        args.extend(["--model".into(), model.into()]);
    }
    if args.iter().any(|arg| {
        arg == "--dangerously-skip-permissions"
            || arg == "--allow-dangerously-skip-permissions"
            || arg == "bypassPermissions"
    }) {
        return Err(cli_failure(
            CliErrorCategory::ApprovalRejected,
            "Claude profile requests a permission bypass; remove the bypass flag and retry",
        ));
    }
    if let Some(permission_mcp_config) = permission_mcp_config {
        args.extend([
            "--setting-sources".into(),
            "".into(),
            "--mcp-config".into(),
            permission_mcp_config.into(),
            "--strict-mcp-config".into(),
            "--permission-prompt-tool".into(),
            "mcp__gyro_approval__approve".into(),
            "--allowedTools".into(),
            "mcp__gyro_approval__approve".into(),
            "--permission-mode".into(),
            "default".into(),
        ]);
    }
    args.push(prompt.into());
    let mut request = ExecutionRequest::new(profile.command.clone());
    request.args = args.into_iter().map(Into::into).collect();
    request.current_dir = Some(workspace.to_path_buf());
    request.timeout = Duration::from_secs(timeout_seconds);
    request.max_stdout_chars = 256_000;
    request.max_stderr_chars = 64_000;
    Ok(CliProviderInvocation {
        request,
        output_path: None,
        provider_kind,
        proposed_session_id: Some(proposed_session_id),
    })
}

fn run_cli_provider_invocation(
    invocation: CliProviderInvocation,
    cancellation: CancellationToken,
    json: bool,
) -> Result<CliProviderExecution> {
    let CliProviderInvocation {
        request,
        output_path,
        provider_kind,
        proposed_session_id,
    } = invocation;
    let mut decoder = CliStreamDecoder::default();
    let outcome = gyro_core::run_command(request, cancellation, |chunk| {
        if chunk.stream != ExecutionStream::Stdout {
            return;
        }
        for delta in decoder.push_stdout(&chunk.text) {
            if !json {
                print!("{delta}");
                let _ = io::stdout().flush();
            }
        }
    })?;
    for delta in decoder.finish() {
        if !json {
            print!("{delta}");
        }
    }
    Ok(CliProviderExecution {
        output_path,
        provider_kind,
        proposed_session_id,
        decoder,
        outcome,
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

fn claude_permission_mcp_config(
    session: &Session,
    profile: &CommandProfile,
    turn_id: Uuid,
    config: &GyroConfig,
    approved: bool,
    json: bool,
) -> Result<String> {
    let executable = std::env::current_exe().map_err(|error| {
        cli_failure(
            CliErrorCategory::Internal,
            format!("resolve Gyro CLI permission bridge: {error}"),
        )
    })?;
    serde_json::to_string(&serde_json::json!({
        "mcpServers": {
            "gyro_approval": {
                "type": "stdio",
                "command": executable,
                "args": ["provider-permission-server"],
                "env": {
                    "GYRO_PERMISSION_SESSION_ID": session.id,
                    "GYRO_PERMISSION_TURN_ID": turn_id,
                    "GYRO_PERMISSION_PROFILE_ID": profile.id,
                    "GYRO_PERMISSION_PROVIDER_ID": profile.provider_id,
                    "GYRO_PERMISSION_REQUIRE_COMMAND": config.require_command_approval.to_string(),
                    "GYRO_PERMISSION_REQUIRE_FILE": config.require_file_edit_approval.to_string(),
                    "GYRO_PERMISSION_AUTO_APPROVE": approved.to_string(),
                    "GYRO_PERMISSION_JSON": json.to_string(),
                }
            }
        }
    }))
    .map_err(Into::into)
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

fn update_cli_provider_binding_status(
    store: &SessionStore,
    session_id: Uuid,
    provider_id: &str,
    status: &str,
    error: Option<&str>,
) -> Result<()> {
    let Some(binding) = store.get_provider_session_binding(session_id, provider_id)? else {
        return Ok(());
    };
    store.upsert_provider_session_binding(
        binding.session_id,
        binding.provider_id,
        binding.model_id,
        binding.model_label,
        binding.reasoning_effort,
        binding.resume_cursor_json,
        status,
        error.map(gyro_core::sanitize_harness_text),
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn execute_codex_app_server_provider(
    store: &SessionStore,
    mutation_journal_dir: &Path,
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
    resume_cursor: Option<(&str, &str)>,
    cancellation: CancellationToken,
) -> Result<CliRunOutput> {
    let provider_id = profile
        .provider_id
        .clone()
        .unwrap_or_else(|| "openai".into());
    let resume_session_id = resume_cursor
        .and_then(|(kind, session_id)| (kind == "codex-session").then(|| session_id.to_string()));
    let outcome = run_codex_app_server(
        CodexAppServerRequest {
            program: profile.command.clone(),
            program_args: profile.args.clone(),
            workspace: session.workspace_path.clone(),
            prompt: codex_app_server_prompt(prompt),
            model: cli_codex_model_arg(model.as_deref()),
            resume_session_id,
            require_command_approval: config.require_command_approval,
            require_file_edit_approval: config.require_file_edit_approval,
            timeout: Duration::from_secs(timeout_seconds),
            cancellation: cancellation.clone(),
        },
        |delta| {
            if !json {
                print!("{delta}");
                let _ = io::stdout().flush();
            }
        },
        |approval| {
            decide_codex_provider_approval(
                store,
                mutation_journal_dir,
                session,
                profile,
                turn_id,
                config,
                approved,
                json,
                &cancellation,
                approval,
            )
        },
        |provider_session_id| {
            store.upsert_provider_session_binding(
                session.id,
                provider_id.clone(),
                model.clone(),
                model.clone(),
                None,
                serde_json::json!({
                    "kind": "codex-session",
                    "sessionId": provider_session_id,
                }),
                "running",
                None,
            )?;
            Ok(())
        },
    );
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(error) => {
            if cli_failure_details(&error).0 == CliErrorCategory::Cancelled {
                append_cli_run_status(
                    store,
                    session,
                    turn_id,
                    attempt_id,
                    mode,
                    HarnessRunStatus::Cancelled,
                    profile,
                    model,
                    "CLI provider run cancelled.",
                    Some("run cancelled by user during provider approval"),
                    None,
                )?;
                return Err(error);
            }
            let detail = gyro_core::sanitize_harness_text(&error.to_string());
            update_cli_provider_binding_status(
                store,
                session.id,
                &provider_id,
                "failed",
                Some(&detail),
            )?;
            append_cli_run_status(
                store,
                session,
                turn_id,
                attempt_id,
                mode,
                HarnessRunStatus::Failed,
                profile,
                model,
                "CLI provider app-server failed.",
                Some(&detail),
                None,
            )?;
            return Err(cli_failure(
                CliErrorCategory::ExecutionFailed,
                format!("execution failed: {detail}"),
            ));
        }
    };

    match outcome {
        CodexAppServerOutcome::Done(output) => {
            if !json {
                println!();
            }
            let response = gyro_core::sanitize_harness_text(output.response.trim());
            let assistant_payload = cli_provider_run_payload(
                turn_id,
                attempt_id,
                mode,
                HarnessRunStatus::Done,
                Some(profile),
                model.clone(),
                session,
            )
            .unwrap_or_else(|error| {
                serde_json::json!({
                    "schema": gyro_core::HARNESS_SCHEMA_V1,
                    "kind": "provider-response",
                    "runId": turn_id,
                    "attemptId": attempt_id,
                    "status": "done",
                    "metadataError": gyro_core::sanitize_harness_text(&error.to_string()),
                })
            });
            store.append_event_with_turn_id(
                session.id,
                SessionEventKind::AssistantMessage,
                response.clone(),
                assistant_payload,
                Some(turn_id),
            )?;
            // The assistant response is the durable source of truth. Never advance the
            // provider cursor past a response that failed to persist locally.
            if let Err(error) = store.upsert_provider_session_binding(
                session.id,
                provider_id.clone(),
                model.clone(),
                model.clone(),
                None,
                serde_json::json!({
                    "kind": "codex-session",
                    "sessionId": output.provider_session_id,
                }),
                "ready",
                None,
            ) {
                eprintln!(
                    "provider response was saved but its resume cursor was not: {}",
                    gyro_core::security::redact_secrets(&error.to_string())
                );
            }
            let _ = append_cli_run_status(
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
                Some(output.duration_ms),
            );
            Ok(CliRunOutput {
                run_id: turn_id,
                attempt_id,
                provider_id,
                duration_ms: output.duration_ms,
                exit_code: Some(0),
                resumed: output.resumed,
                response,
            })
        }
        CodexAppServerOutcome::ApprovalRejected { duration_ms } => {
            update_cli_provider_binding_status(store, session.id, &provider_id, "ready", None)?;
            append_cli_run_status(
                store,
                session,
                turn_id,
                attempt_id,
                mode,
                HarnessRunStatus::Blocked,
                profile,
                model,
                "CLI provider action was rejected.",
                Some("approval rejected for a provider action"),
                Some(duration_ms),
            )?;
            Err(cli_failure(
                CliErrorCategory::ApprovalRejected,
                "approval rejected for a provider action",
            ))
        }
        CodexAppServerOutcome::Cancelled { duration_ms } => {
            update_cli_provider_binding_status(
                store,
                session.id,
                &provider_id,
                "interrupted",
                Some("run cancelled by user"),
            )?;
            append_cli_run_status(
                store,
                session,
                turn_id,
                attempt_id,
                mode,
                HarnessRunStatus::Cancelled,
                profile,
                model,
                "CLI provider run cancelled.",
                Some("run cancelled by user"),
                Some(duration_ms),
            )?;
            Err(cli_failure(
                CliErrorCategory::Cancelled,
                "run cancelled by user",
            ))
        }
        CodexAppServerOutcome::TimedOut { duration_ms } => {
            let detail = format!("execution timed out after {timeout_seconds} seconds");
            update_cli_provider_binding_status(
                store,
                session.id,
                &provider_id,
                "interrupted",
                Some(&detail),
            )?;
            append_cli_run_status(
                store,
                session,
                turn_id,
                attempt_id,
                mode,
                HarnessRunStatus::Failed,
                profile,
                model,
                "CLI provider run failed.",
                Some(&detail),
                Some(duration_ms),
            )?;
            Err(cli_failure(CliErrorCategory::ExecutionFailed, detail))
        }
        CodexAppServerOutcome::Failed {
            message,
            duration_ms,
        } => {
            let detail = gyro_core::sanitize_harness_text(&message);
            update_cli_provider_binding_status(
                store,
                session.id,
                &provider_id,
                "failed",
                Some(&detail),
            )?;
            append_cli_run_status(
                store,
                session,
                turn_id,
                attempt_id,
                mode,
                HarnessRunStatus::Failed,
                profile,
                model,
                "CLI provider run failed.",
                Some(&detail),
                Some(duration_ms),
            )?;
            Err(cli_failure(CliErrorCategory::ExecutionFailed, detail))
        }
    }
}

fn codex_app_server_prompt(prompt: &str) -> String {
    format!(
        "Gyro applies approved file changes through its own guarded transaction. If a native \
         file-change callback is declined, re-read the affected files before reporting the \
         outcome: the user may have rejected it, or Gyro may already have applied the reviewed \
         change. Report the actual on-disk state and do not claim failure from the callback \
         decision alone.\n\nUser request:\n{prompt}"
    )
}

#[allow(clippy::too_many_arguments)]
fn decide_codex_provider_approval(
    store: &SessionStore,
    mutation_journal_dir: &Path,
    session: &Session,
    profile: &CommandProfile,
    turn_id: Uuid,
    config: &GyroConfig,
    approved: bool,
    json: bool,
    cancellation: &CancellationToken,
    approval: &CodexApprovalRequest,
) -> Result<CodexApprovalDecision> {
    ensure_cli_not_cancelled(cancellation, "before provider action approval")?;
    let approval_id = Uuid::new_v4();
    let details = sanitize_provider_approval_details(approval.details.clone());
    let required = match approval.kind {
        CodexApprovalKind::Command => config.require_command_approval,
        CodexApprovalKind::FileChange => config.require_file_edit_approval,
        CodexApprovalKind::Permissions => true,
    };
    let mut payload = serde_json::json!({
        "schema": "gyro.provider-approval.v1",
        "kind": "provider-tool-approval",
        "surface": "cli",
        "approvalId": approval_id,
        "approvalType": approval.kind.as_str(),
        "providerId": profile.provider_id,
        "profileId": profile.id,
        "details": details,
        "status": "pending",
        "risk": codex_approval_risk(approval.kind),
    });
    store.append_event_with_turn_id(
        session.id,
        SessionEventKind::ApprovalRequested,
        codex_approval_label(approval.kind),
        payload.clone(),
        Some(turn_id),
    )?;

    let mut decision = if !required || approved {
        CodexApprovalDecision::Accept
    } else if json || !io::stdin().is_terminal() {
        CodexApprovalDecision::Decline
    } else {
        print_codex_approval_prompt(approval.kind, &details)?;
        let answer = read_cli_approval_answer(cancellation)?;
        if matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
            CodexApprovalDecision::Accept
        } else {
            CodexApprovalDecision::Decline
        }
    };

    let mut pending_mutation: Option<PendingProviderMutationCommit> = None;
    if decision == CodexApprovalDecision::Accept && approval.kind == CodexApprovalKind::FileChange {
        let mutation_result = (|| -> Result<_> {
            let changes = provider_changes_from_approval(&approval.details)?;
            let transaction =
                prepare_provider_mutation_transaction(&session.workspace_path, &changes)?;
            begin_provider_mutation_transaction_with_cancellation(
                &transaction,
                mutation_journal_dir,
                ProviderMutationJournalContext {
                    session_id: session.id,
                    approval_id,
                },
                || cancellation.is_cancelled(),
            )
        })();
        match mutation_result {
            Ok(pending) => {
                payload["changedPaths"] =
                    serde_json::to_value(pending.result().changed_paths.clone())?;
                decision = CodexApprovalDecision::AppliedByClient;
                pending_mutation = Some(pending);
            }
            Err(error) => {
                payload["status"] = serde_json::Value::String("failed".into());
                payload["error"] =
                    serde_json::Value::String(gyro_core::sanitize_harness_text(&error.to_string()));
                store.append_event_with_turn_id(
                    session.id,
                    SessionEventKind::SystemEvent,
                    "Provider file changes were not applied.",
                    payload,
                    Some(turn_id),
                )?;
                decision = CodexApprovalDecision::Decline;
                return Ok(decision);
            }
        }
    }

    payload["status"] = serde_json::Value::String(match decision {
        CodexApprovalDecision::Accept => "approved".into(),
        CodexApprovalDecision::Decline => "rejected".into(),
        CodexApprovalDecision::AppliedByClient => "applied".into(),
    });
    let decision_event = store.append_event_with_turn_id(
        session.id,
        SessionEventKind::SystemEvent,
        match decision {
            CodexApprovalDecision::Accept => "Provider action approved.",
            CodexApprovalDecision::Decline => "Provider action rejected.",
            CodexApprovalDecision::AppliedByClient => "Provider file changes applied through Gyro.",
        },
        payload,
        Some(turn_id),
    );
    if let Err(error) = decision_event {
        if let Some(pending) = pending_mutation {
            pending.rollback().with_context(|| {
                format!("record provider approval failed ({error}); rollback also failed")
            })?;
        }
        return Err(error);
    }
    if let Some(pending) = pending_mutation {
        if let Err(error) = pending.finalize() {
            eprintln!(
                "Gyro deferred provider mutation cleanup until restart: {}",
                gyro_core::sanitize_harness_text(&error.to_string())
            );
        }
    }
    Ok(decision)
}

fn provider_changes_from_approval(details: &serde_json::Value) -> Result<Vec<ProviderFileChange>> {
    if let Some(changes) = details
        .pointer("/change/changes")
        .or_else(|| details.pointer("/patch/changes"))
        .or_else(|| details.get("changes"))
        .cloned()
    {
        return serde_json::from_value(changes).context("decode reviewed provider file changes");
    }
    if let Some(changes) = details
        .get("fileChanges")
        .and_then(serde_json::Value::as_object)
    {
        let changes = changes
            .iter()
            .map(|(path, change)| {
                let change_type = change
                    .get("type")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| anyhow!("legacy provider file change is missing its type"))?;
                let diff = match change_type {
                    "add" => change
                        .get("content")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default(),
                    "update" => change
                        .get("unified_diff")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default(),
                    "delete" => "",
                    other => return Err(anyhow!("unsupported provider file change type {other}")),
                };
                Ok(serde_json::json!({
                    "path": path,
                    "kind": {
                        "type": change_type,
                        "movePath": change.get("move_path"),
                    },
                    "diff": diff,
                }))
            })
            .collect::<Result<Vec<_>>>()?;
        return serde_json::from_value(serde_json::Value::Array(changes))
            .context("decode legacy reviewed provider file changes");
    }
    Err(anyhow!(
        "provider file approval did not include the reviewed file set"
    ))
}

fn codex_approval_label(kind: CodexApprovalKind) -> &'static str {
    match kind {
        CodexApprovalKind::Command => "Review provider command",
        CodexApprovalKind::FileChange => "Review provider file changes",
        CodexApprovalKind::Permissions => "Review provider permissions",
    }
}

fn codex_approval_risk(kind: CodexApprovalKind) -> &'static str {
    match kind {
        CodexApprovalKind::Command => "Runs one command in the selected project",
        CodexApprovalKind::FileChange => "Changes files in the selected project",
        CodexApprovalKind::Permissions => "Expands provider permissions for this turn",
    }
}

fn sanitize_provider_approval_details(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::String(value) => {
            serde_json::Value::String(gyro_core::security::redact_secrets(&value))
        }
        serde_json::Value::Array(values) => serde_json::Value::Array(
            values
                .into_iter()
                .map(sanitize_provider_approval_details)
                .collect(),
        ),
        serde_json::Value::Object(values) => serde_json::Value::Object(
            values
                .into_iter()
                .map(|(key, value)| (key, sanitize_provider_approval_details(value)))
                .collect(),
        ),
        value => value,
    }
}

fn print_codex_approval_prompt(kind: CodexApprovalKind, details: &serde_json::Value) -> Result<()> {
    eprintln!();
    eprintln!("{} required", codex_approval_label(kind));
    match kind {
        CodexApprovalKind::Command => {
            if let Some(command) = approval_command_text(details) {
                eprintln!("  command: {command}");
            }
            if let Some(cwd) = details.get("cwd").and_then(serde_json::Value::as_str) {
                eprintln!("  folder:  {cwd}");
            }
        }
        CodexApprovalKind::FileChange => {
            for path in approval_file_paths(details).into_iter().take(6) {
                eprintln!("  file:    {path}");
            }
        }
        CodexApprovalKind::Permissions => {}
    }
    if let Some(reason) = details
        .get("reason")
        .and_then(serde_json::Value::as_str)
        .filter(|reason| !reason.trim().is_empty())
    {
        eprintln!("  reason:  {reason}");
    }
    eprint!("Approve this action? [y/N] ");
    io::stderr().flush()?;
    Ok(())
}

fn approval_command_text(details: &serde_json::Value) -> Option<String> {
    match details.get("command")? {
        serde_json::Value::String(command) => Some(command.clone()),
        serde_json::Value::Array(parts) => Some(
            parts
                .iter()
                .filter_map(serde_json::Value::as_str)
                .collect::<Vec<_>>()
                .join(" "),
        ),
        _ => None,
    }
}

fn approval_file_paths(details: &serde_json::Value) -> Vec<String> {
    let mut paths = Vec::new();
    collect_approval_paths(details, &mut paths);
    paths.sort();
    paths.dedup();
    paths
}

fn collect_approval_paths(value: &serde_json::Value, paths: &mut Vec<String>) {
    match value {
        serde_json::Value::Object(object) => {
            for (key, value) in object {
                if matches!(key.as_str(), "path" | "move_path" | "movePath") {
                    if let Some(path) = value.as_str() {
                        paths.push(path.into());
                    }
                }
                if key == "fileChanges" {
                    if let Some(changes) = value.as_object() {
                        paths.extend(changes.keys().cloned());
                    }
                }
                collect_approval_paths(value, paths);
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                collect_approval_paths(value, paths);
            }
        }
        _ => {}
    }
}

#[allow(clippy::too_many_arguments)]
fn execute_cli_provider(
    store: &SessionStore,
    mutation_journal_dir: &Path,
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
    let cancellation = CancellationToken::default();
    let _cancellation_guard = activate_cli_cancellation(cancellation.clone())?;
    let provider_kind = cli_provider_kind(profile)?;
    let provider_id = profile.provider_id.clone().ok_or_else(|| {
        cli_failure(
            CliErrorCategory::ProviderUnavailable,
            format!("profile `{}` has no provider", profile.id),
        )
    })?;
    let binding = store.get_provider_session_binding(session.id, &provider_id)?;
    let resume_cursor = binding.as_ref().and_then(|binding| {
        let kind = binding.resume_cursor_json.get("kind")?.as_str()?;
        let session_id = binding.resume_cursor_json.get("sessionId")?.as_str()?;
        Some((kind, session_id))
    });
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
    if provider_kind == CliProviderKind::Codex {
        let result = execute_codex_app_server_provider(
            store,
            mutation_journal_dir,
            session,
            profile,
            model.clone(),
            prompt,
            mode,
            config,
            approved,
            json,
            timeout_seconds,
            turn_id,
            attempt_id,
            resume_cursor,
            cancellation.clone(),
        );
        return match result {
            Err(error)
                if binding.is_some() && is_stale_provider_resume_error(&error.to_string()) =>
            {
                store.clear_provider_session_binding(session.id, &provider_id)?;
                append_cli_run_status(
                    store,
                    session,
                    turn_id,
                    attempt_id,
                    mode,
                    HarnessRunStatus::Failed,
                    profile,
                    model,
                    "Stale provider resume cursor cleared; retry explicitly to avoid replaying tools.",
                    Some(&gyro_core::sanitize_harness_text(&error.to_string())),
                    None,
                )?;
                Err(error.context(
                    "stale provider cursor cleared; retry explicitly to avoid replaying tools",
                ))
            }
            result => result,
        };
    }
    let permission_mcp_config =
        claude_permission_mcp_config(session, profile, turn_id, config, approved, json)?;
    let active_attempt_id = attempt_id;
    let resumed = resume_cursor.is_some();
    let invocation = build_cli_provider_invocation(
        profile,
        &session.workspace_path,
        prompt,
        model.as_deref(),
        resume_cursor,
        Some(&permission_mcp_config),
        timeout_seconds,
    )?;
    if let Some(provider_session_id) = invocation.proposed_session_id.as_deref() {
        store.upsert_provider_session_binding(
            session.id,
            provider_id.clone(),
            model.clone(),
            model.clone(),
            None,
            serde_json::json!({
                "kind": "claude-session",
                "sessionId": provider_session_id,
            }),
            "running",
            None,
        )?;
    }
    let execution = run_cli_provider_invocation(invocation, cancellation.clone(), json);
    let CliProviderExecution {
        output_path,
        provider_kind: invocation_kind,
        proposed_session_id,
        decoder,
        outcome,
    } = match execution {
        Ok(execution) => execution,
        Err(error) => {
            let error = gyro_core::sanitize_harness_text(&error.to_string());
            update_cli_provider_binding_status(
                store,
                session.id,
                &provider_id,
                "failed",
                Some(&error),
            )?;
            append_cli_run_status(
                store,
                session,
                turn_id,
                active_attempt_id,
                mode,
                HarnessRunStatus::Failed,
                profile,
                model.clone(),
                "CLI provider run failed to start.",
                Some(&error),
                None,
            )?;
            return Err(cli_failure(
                CliErrorCategory::ExecutionFailed,
                format!("execution failed: {error}"),
            ));
        }
    };
    let stale_detail = format!("{}\n{}", outcome.stdout.trim(), outcome.stderr.trim());
    if resumed && !outcome.succeeded() && is_stale_provider_resume_error(&stale_detail) {
        let stale_detail = gyro_core::sanitize_harness_text(&stale_detail);
        append_cli_run_status(
            store,
            session,
            turn_id,
            active_attempt_id,
            mode,
            HarnessRunStatus::Failed,
            profile,
            model.clone(),
            "CLI provider resume cursor was stale.",
            Some(&stale_detail),
            Some(outcome.duration_ms),
        )?;
        store.clear_provider_session_binding(session.id, &provider_id)?;
        if let Some(path) = output_path.as_ref() {
            let _ = std::fs::remove_file(path);
        }
        return Err(cli_failure(
            CliErrorCategory::ExecutionFailed,
            "stale provider cursor cleared; retry explicitly to avoid replaying tools",
        ));
    }
    if !json && !decoder.response.is_empty() {
        println!();
    }
    let output_file_response = output_path
        .as_ref()
        .and_then(|path| read_bounded_provider_response_file(path).ok())
        .unwrap_or_default();
    if let Some(path) = output_path.as_ref() {
        let _ = std::fs::remove_file(path);
    }
    let response = gyro_core::sanitize_harness_text(if output_file_response.trim().is_empty() {
        decoder.response.trim()
    } else {
        output_file_response.trim()
    });
    let provider_session_id = decoder
        .provider_session_id
        .clone()
        .or(proposed_session_id.clone());
    let approval_rejected = provider_kind == CliProviderKind::Claude
        && turn_has_provider_action_status(store, session.id, turn_id, "rejected")?;
    let approval_failed = provider_kind == CliProviderKind::Claude
        && turn_has_provider_action_status(store, session.id, turn_id, "failed")?;
    let status = if approval_rejected {
        HarnessRunStatus::Blocked
    } else if approval_failed {
        HarnessRunStatus::Failed
    } else {
        match outcome.termination {
            ExecutionTermination::Cancelled => HarnessRunStatus::Cancelled,
            ExecutionTermination::TimedOut
            | ExecutionTermination::Inactive
            | ExecutionTermination::OutputLimit => HarnessRunStatus::Failed,
            ExecutionTermination::Exited { code: Some(0) } if !response.is_empty() => {
                HarnessRunStatus::Done
            }
            ExecutionTermination::Exited { .. } => HarnessRunStatus::Failed,
        }
    };
    if status != HarnessRunStatus::Done {
        let (category, detail) = if approval_rejected {
            (
                CliErrorCategory::ApprovalRejected,
                "approval rejected for a provider action".to_string(),
            )
        } else if approval_failed {
            (
                CliErrorCategory::ExecutionFailed,
                "provider file changes did not pass Gyro's atomic transaction".to_string(),
            )
        } else {
            match outcome.termination {
                ExecutionTermination::Cancelled => (
                    CliErrorCategory::Cancelled,
                    "run cancelled by user".to_string(),
                ),
                ExecutionTermination::TimedOut => (
                    CliErrorCategory::ExecutionFailed,
                    format!("execution timed out after {timeout_seconds} seconds"),
                ),
                ExecutionTermination::Inactive => (
                    CliErrorCategory::ExecutionFailed,
                    "execution stopped after prolonged inactivity".into(),
                ),
                ExecutionTermination::OutputLimit => (
                    CliErrorCategory::ExecutionFailed,
                    "execution exceeded Gyro's output activity limit".into(),
                ),
                ExecutionTermination::Exited { code } => {
                    if let Some(failure) = decoder.provider_failure.as_ref() {
                        let provider_label = match invocation_kind {
                            CliProviderKind::Codex => "Codex",
                            CliProviderKind::Claude => "Claude",
                        };
                        let resume = format!("`gyro resume {}`", session.id);
                        match failure.kind {
                            CliProviderFailureKind::Authentication => (
                                CliErrorCategory::ProviderUnavailable,
                                format!(
                                    "{provider_label} authentication failed: {}. Next: run `{}`, then retry with {resume}. The Gyro session was saved.",
                                    failure.message,
                                    match invocation_kind {
                                        CliProviderKind::Codex => "codex login --device-auth",
                                        CliProviderKind::Claude => "claude auth login",
                                    }
                                ),
                            ),
                            CliProviderFailureKind::Network => (
                                CliErrorCategory::ProviderUnavailable,
                                format!(
                                    "{provider_label} is unavailable: {}. Next: check the network, then retry with {resume}. The Gyro session was saved.",
                                    failure.message
                                ),
                            ),
                            CliProviderFailureKind::Other => (
                                CliErrorCategory::ExecutionFailed,
                                format!(
                                    "{provider_label} exited with {}: {}. Next: inspect `gyro setup`, then retry with {resume}. The Gyro session was saved.",
                                    code.unwrap_or(-1),
                                    failure.message
                                ),
                            ),
                        }
                    } else {
                        let stderr = gyro_core::sanitize_harness_text(outcome.stderr.trim());
                        let detail = if stderr.is_empty() {
                            format!("provider exited with {}", code.unwrap_or(-1))
                        } else {
                            format!("provider exited with {}: {stderr}", code.unwrap_or(-1))
                        };
                        (CliErrorCategory::ExecutionFailed, detail)
                    }
                }
            }
        };
        if let Some(provider_session_id) = provider_session_id.as_deref() {
            let kind = match invocation_kind {
                CliProviderKind::Codex => "codex-session",
                CliProviderKind::Claude => "claude-session",
            };
            let binding_status = if matches!(
                outcome.termination,
                ExecutionTermination::Cancelled
                    | ExecutionTermination::TimedOut
                    | ExecutionTermination::Inactive
                    | ExecutionTermination::OutputLimit
            ) {
                "interrupted"
            } else {
                "failed"
            };
            store.upsert_provider_session_binding(
                session.id,
                provider_id.clone(),
                model.clone(),
                model.clone(),
                None,
                serde_json::json!({"kind": kind, "sessionId": provider_session_id}),
                binding_status,
                Some(gyro_core::sanitize_harness_text(&detail)),
            )?;
        }
        append_cli_run_status(
            store,
            session,
            turn_id,
            active_attempt_id,
            mode,
            status.clone(),
            profile,
            model.clone(),
            if status == HarnessRunStatus::Cancelled {
                "CLI provider run cancelled."
            } else if status == HarnessRunStatus::Blocked {
                "CLI provider action was rejected."
            } else {
                "CLI provider run failed."
            },
            Some(&detail),
            Some(outcome.duration_ms),
        )?;
        return Err(cli_failure(category, detail));
    }
    if let Some(provider_session_id) = provider_session_id.as_deref() {
        let kind = match invocation_kind {
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
            active_attempt_id,
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
        active_attempt_id,
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
        attempt_id: active_attempt_id,
        provider_id,
        duration_ms: outcome.duration_ms,
        exit_code: outcome.exit_code(),
        resumed,
        response,
    })
}

fn turn_has_provider_action_status(
    store: &SessionStore,
    session_id: Uuid,
    turn_id: Uuid,
    status: &str,
) -> Result<bool> {
    Ok(store.read_events(session_id)?.iter().any(|event| {
        event.turn_id == Some(turn_id)
            && event.payload["schema"] == "gyro.provider-approval.v1"
            && event.payload["status"] == status
    }))
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

fn print_json_line<T: Serialize>(value: &T) -> Result<()> {
    println!(
        "{}",
        serde_json::to_string(&CliJsonEnvelope {
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
        return Err(cli_failure(
            CliErrorCategory::InvalidInput,
            "--branch and --worktree-name require --worktree",
        ));
    }

    if !worktree.worktree {
        return store.create_session(workspace, SessionOrigin::Cli, title);
    }

    let branch = worktree
        .branch
        .clone()
        .unwrap_or_else(|| default_worktree_branch(&title));
    gyro_core::validate_branch_name(&branch)
        .map_err(|error| cli_failure(CliErrorCategory::InvalidInput, error.to_string()))?;
    if let Some(worktree_name) = worktree.worktree_name.as_deref() {
        gyro_core::validate_worktree_name(worktree_name)
            .map_err(|error| cli_failure(CliErrorCategory::InvalidInput, error.to_string()))?;
    }
    let plan = create_worktree(paths, workspace, branch, worktree.worktree_name.clone())
        .map_err(|error| cli_failure(CliErrorCategory::ExecutionFailed, error.to_string()))?;
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
    let profile = select_execution_profile(&config, args.profile.as_deref(), false)?;
    let model = model_for(Some(profile), args.model);
    let workspace = workspace_path(args.workspace)?;
    let session = store.create_session(&workspace, SessionOrigin::Cli, "CLI chat")?;
    let approval_required = config.require_command_approval || config.require_file_edit_approval;
    let chat_context = ChatEventContext {
        session: &session,
        profile,
        model: model.as_deref(),
        approval_required,
    };

    if args.json {
        print_json_line(&chat_context.output("chat-started", CliStatus::Ready, None, None))?;
    } else {
        println!("Gyro CLI session {}", session.id);
        println!("Workspace: {}", workspace.display());
        println!("Provider: {}", profile.display_name);
        println!("Type a message, or /open to open this session in Gyro.app, or /exit.");
    }

    let stdin = io::stdin();
    loop {
        if !args.json {
            print!("gyro> ");
            io::stdout().flush()?;
        }

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
            let handoff = open_session_in_app(&paths, &session, AppNotificationKind::OpenSession)?;
            if args.json {
                print_json_line(&chat_context.output(
                    "app-handoff",
                    if handoff.opened {
                        CliStatus::Done
                    } else {
                        CliStatus::Waiting
                    },
                    None,
                    Some(handoff),
                ))?;
            } else {
                println!("{}", handoff.message);
            }
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
        if (config.require_command_approval || config.require_file_edit_approval)
            && !profile_uses_action_approvals(Some(profile))
        {
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
        let run = execute_cli_provider(
            &store,
            &paths.mutation_journals_dir,
            &session,
            profile,
            model.clone(),
            input,
            "chat",
            &config,
            args.approve,
            args.json,
            args.timeout_seconds,
            turn_id,
            attempt_id,
        )?;
        if args.json {
            print_json_line(&chat_context.output("chat-turn", CliStatus::Done, Some(run), None))?;
        }
    }

    if args.json {
        print_json_line(&chat_context.output("chat-closed", CliStatus::Done, None, None))?;
    }

    Ok(())
}

fn run_task(args: RunArgs) -> Result<()> {
    let (paths, store) = open_store()?;
    let config = GyroConfig::load(&paths)?;
    let profile = Some(select_execution_profile(
        &config,
        args.profile.as_deref(),
        false,
    )?);
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
    if (config.require_command_approval || config.require_file_edit_approval)
        && !profile_uses_action_approvals(profile)
    {
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
        return Err(cli_failure(
            CliErrorCategory::ProviderUnavailable,
            format!(
                "provider unavailable: {}; session saved: {}",
                profile_message.unwrap_or_else(|| "selected CLI profile is blocked".into()),
                session.id
            ),
        ));
    }

    let run = Some(execute_cli_provider(
        &store,
        &paths.mutation_journals_dir,
        &session,
        profile.ok_or_else(|| {
            cli_failure(
                CliErrorCategory::ProviderUnavailable,
                "an executable provider profile is required",
            )
        })?,
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
        Some(id) => store.get_session(id)?.ok_or_else(|| {
            cli_failure(
                CliErrorCategory::InvalidInput,
                format!("session {id} was not found"),
            )
        })?,
        None => store.latest_session()?.ok_or_else(|| {
            cli_failure(CliErrorCategory::InvalidInput, "no Gyro sessions exist yet")
        })?,
    };
    let events = store.read_events(session.id)?;
    let recorded_profile = latest_payload_string(&events, "profileId");
    let recorded_model = latest_payload_string(&events, "model");
    let selected_profile_id = args.profile.as_deref().or(recorded_profile.as_deref());
    let profile = Some(select_execution_profile(
        &config,
        selected_profile_id,
        true,
    )?);
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
    if (config.require_command_approval || config.require_file_edit_approval)
        && !profile_uses_action_approvals(profile)
    {
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
        return Err(cli_failure(
            CliErrorCategory::ProviderUnavailable,
            format!(
                "provider unavailable: {}; session saved: {}",
                profile_message.unwrap_or_else(|| "selected CLI profile is blocked".into()),
                session.id
            ),
        ));
    }

    let run = Some(execute_cli_provider(
        &store,
        &paths.mutation_journals_dir,
        &session,
        profile.ok_or_else(|| {
            cli_failure(
                CliErrorCategory::ProviderUnavailable,
                "an executable provider profile is required",
            )
        })?,
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
            next: check.next,
        });
    }

    let (app_ipc_status, app_ipc_message, app_ipc_next) = match app_ipc_listener_ready(&paths) {
        Ok(true) => (
            CliStatus::Ready,
            format!("local app bridge ready at {}", paths.socket_path.display()),
            None,
        ),
        Ok(false) => (
            CliStatus::Waiting,
            "Gyro.app is not running; CLI sessions will remain resumable".into(),
            Some("open Gyro.app or use `gyro app open` after creating a session".into()),
        ),
        Err(error) => (
            CliStatus::Blocked,
            format!("local app bridge check failed: {error}"),
            Some(format!(
                "inspect or remove {} before retrying",
                paths.socket_path.display()
            )),
        ),
    };
    checks.push(SetupCheckOutput {
        id: "app-ipc".into(),
        label: "Gyro.app bridge".into(),
        status: app_ipc_status,
        message: app_ipc_message,
        next: app_ipc_next,
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
                    let status = if executable_provider {
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
    let width = terminal_width();
    println!("Gyro sessions");
    println!("status: {}", output.status.as_str());
    if output.sessions.is_empty() {
        println!("No sessions found.");
        return;
    }
    if width < 100 {
        for session in &output.sessions {
            print_wrapped_line(
                "",
                &format!("{}  {}", session.session_id, session.title),
                width,
            );
            print_wrapped_line(
                "  ",
                &format!(
                    "{} · {} · {}",
                    format!("{:?}", session.origin).to_lowercase(),
                    workspace_mode_label(&session.workspace_mode),
                    session.updated_at
                ),
                width,
            );
            print_wrapped_line("  ", &session.workspace.display().to_string(), width);
        }
        return;
    }
    let title_width = width.saturating_sub(81).max(8);
    println!(
        "{:<36}  {:<10}  {:<9}  {:<18}  title",
        "session", "origin", "mode", "updated"
    );
    for session in &output.sessions {
        println!(
            "{:<36}  {:<10}  {:<9}  {:<18}  {}",
            session.session_id,
            format!("{:?}", session.origin).to_lowercase(),
            workspace_mode_label(&session.workspace_mode),
            session.updated_at,
            truncate_cli_text(&session.title, title_width)
        );
        print_wrapped_line("  ", &session.workspace.display().to_string(), width);
    }
}

fn print_setup_output(output: &SetupOutput) {
    let width = terminal_width();
    println!("Gyro setup");
    println!("status: {}", output.status.as_str());
    for check in &output.checks {
        print_wrapped_line(
            &format!("{:<9} ", check.status.as_str()),
            &format!("{} - {}", check.label, check.message),
            width,
        );
        if let Some(next) = &check.next {
            print_wrapped_line("          ", &format!("next: {next}"), width);
        }
    }
    println!("MCP setup hints");
    for instruction in &output.mcp_instructions {
        print_wrapped_line("  ", instruction, width);
    }
}

fn terminal_width() -> usize {
    if let Some(width) = std::env::var("COLUMNS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|width| *width >= 40)
    {
        return width.min(240);
    }

    #[cfg(unix)]
    if io::stdout().is_terminal() {
        let mut size = libc::winsize {
            ws_row: 0,
            ws_col: 0,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        let result = unsafe { libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut size) };
        if result == 0 && size.ws_col >= 40 {
            return usize::from(size.ws_col).min(240);
        }
    }

    100
}

fn print_wrapped_line(prefix: &str, value: &str, width: usize) {
    let continuation = " ".repeat(prefix.chars().count());
    let content_width = width.saturating_sub(prefix.chars().count()).max(12);
    for (index, line) in wrap_cli_text(value, content_width).into_iter().enumerate() {
        println!("{}{line}", if index == 0 { prefix } else { &continuation });
    }
}

fn wrap_cli_text(value: &str, width: usize) -> Vec<String> {
    let width = width.max(8);
    let mut lines = Vec::new();
    for source_line in value.lines() {
        let mut current = String::new();
        for word in source_line.split_whitespace() {
            if word.chars().count() > width {
                if !current.is_empty() {
                    lines.push(std::mem::take(&mut current));
                }
                let mut chunk = String::new();
                for character in word.chars() {
                    chunk.push(character);
                    if chunk.chars().count() == width {
                        lines.push(std::mem::take(&mut chunk));
                    }
                }
                current = chunk;
                continue;
            }
            let next_width =
                current.chars().count() + usize::from(!current.is_empty()) + word.chars().count();
            if next_width > width && !current.is_empty() {
                lines.push(std::mem::take(&mut current));
            }
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(word);
        }
        if !current.is_empty() {
            lines.push(current);
        } else if source_line.is_empty() {
            lines.push(String::new());
        }
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

fn truncate_cli_text(value: &str, width: usize) -> String {
    if value.chars().count() <= width {
        return value.into();
    }
    if width <= 3 {
        return value.chars().take(width).collect();
    }
    value.chars().take(width - 3).collect::<String>() + "..."
}

fn app_command(args: AppArgs) -> Result<()> {
    let (action, session, handoff) = match args.command {
        AppCommand::Open { session_id } => {
            let (paths, store) = open_store()?;
            let session = match session_id {
                Some(id) => store.get_session(id)?.ok_or_else(|| {
                    cli_failure(
                        CliErrorCategory::InvalidInput,
                        format!("session {id} was not found"),
                    )
                })?,
                None => store.latest_session()?.ok_or_else(|| {
                    cli_failure(CliErrorCategory::InvalidInput, "no Gyro sessions exist yet")
                })?,
            };
            let handoff = open_session_in_app(&paths, &session, AppNotificationKind::OpenSession)?;
            ("open", session, handoff)
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
            let handoff =
                open_session_in_app(&paths, &session, AppNotificationKind::AttachSession)?;
            ("attach", session, handoff)
        }
    };
    let output = AppCommandOutput {
        status: if handoff.opened {
            CliStatus::Done
        } else {
            CliStatus::Waiting
        },
        action,
        session: session_summary(&session),
        app_handoff: handoff,
    };
    if args.json {
        print_json(&output)?;
    } else {
        println!("{}", output.app_handoff.message);
    }
    Ok(())
}

fn open_session_in_app(
    paths: &GyroPaths,
    session: &Session,
    kind: AppNotificationKind,
) -> Result<AppHandoffOutput> {
    perform_app_handoff(paths, session, kind, OpenBehavior::OpenApp)
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
            app_version: None,
            compatible: None,
            message: format!(
                "app handoff skipped; resume available with `gyro resume {}`",
                session.id
            ),
        }),
        OpenBehavior::NotifyRunning => {
            let notification = notify_session(paths, session, kind)?;
            if let Some(handoff) = running_app_handoff(session, notification)? {
                Ok(handoff)
            } else {
                Ok(AppHandoffOutput {
                    requested: true,
                    opened: false,
                    app_version: None,
                    compatible: None,
                    message: format!(
                        "Gyro.app is not running; run `gyro app open {}` to open this session",
                        session.id
                    ),
                })
            }
        }
        OpenBehavior::OpenApp => {
            let notification = notify_session(paths, session, kind.clone())?;
            if let Some(handoff) = running_app_handoff(session, notification)? {
                return Ok(handoff);
            }
            launch_desktop_app(&session.id, kind)?;
            Ok(AppHandoffOutput {
                requested: true,
                opened: true,
                app_version: None,
                compatible: None,
                message: format!("launched Gyro.app for session {}", session.id),
            })
        }
    }
}

fn notify_session(
    paths: &GyroPaths,
    session: &Session,
    kind: AppNotificationKind,
) -> Result<AppNotificationResult> {
    let mut notification =
        AppNotification::new(kind, session.id.to_string(), session.workspace_path.clone());
    notification.workspace_mode = Some(session.workspace_mode.clone());
    notification.branch = Some(session.branch.clone());
    notification.worktree_name = session.worktree_name.clone();
    notify_running_app_with_status(paths, &notification).map_err(|error| {
        cli_failure(
            CliErrorCategory::ExecutionFailed,
            format!("app handoff failed: {error}"),
        )
    })
}

fn running_app_handoff(
    session: &Session,
    notification: AppNotificationResult,
) -> Result<Option<AppHandoffOutput>> {
    if !notification.running {
        return Ok(None);
    }
    if !notification.compatible {
        return Err(cli_failure(
            CliErrorCategory::ExecutionFailed,
            notification.message.unwrap_or_else(|| {
                format!(
                    "Gyro CLI {} is not compatible with the running Gyro.app; update both from the same release channel",
                    env!("CARGO_PKG_VERSION")
                )
            }),
        ));
    }
    if !notification.acknowledged {
        return Err(cli_failure(
            CliErrorCategory::ExecutionFailed,
            "Gyro.app is running but did not acknowledge the session handoff; restart Gyro.app and try again",
        ));
    }
    Ok(Some(AppHandoffOutput {
        requested: true,
        opened: true,
        app_version: notification.app_version,
        compatible: Some(true),
        message: format!("opened in running Gyro.app session {}", session.id),
    }))
}

fn launch_desktop_app(session_id: &Uuid, kind: AppNotificationKind) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let route = match kind {
            AppNotificationKind::OpenSession => "open",
            AppNotificationKind::AttachSession => "attach",
        };
        let mut request = ExecutionRequest::new("open");
        request.args = [
            "-a".to_string(),
            "Gyro".to_string(),
            "--args".to_string(),
            format!("gyro://{route}/{session_id}"),
        ]
        .into_iter()
        .map(Into::into)
        .collect();
        request.timeout = Duration::from_secs(15);
        request.max_stdout_chars = 8 * 1024;
        request.max_stderr_chars = 8 * 1024;
        let outcome = gyro_core::run_command(request, CancellationToken::default(), |_| {})
            .map_err(|error| {
                cli_failure(
                    CliErrorCategory::ExecutionFailed,
                    format!("launch Gyro.app: {error}"),
                )
            })?;
        if outcome.succeeded() {
            Ok(())
        } else {
            Err(cli_failure(
                CliErrorCategory::ExecutionFailed,
                "could not launch Gyro.app; install the desktop app or run from source",
            ))
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = session_id;
        let _ = kind;
        Err(cli_failure(
            CliErrorCategory::ExecutionFailed,
            "desktop app launch is only implemented for macOS v1",
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
        let width = terminal_width();
        for check in &report.checks {
            print_wrapped_line(
                &format!("{:<5} ", format!("{:?}", check.status).to_lowercase()),
                &format!(
                    "{} ({}) - {}",
                    check.label,
                    if check.required {
                        "required"
                    } else {
                        "optional"
                    },
                    check.message
                ),
                width,
            );
            if let Some(next) = &check.next {
                print_wrapped_line("      ", &format!("next: {next}"), width);
            }
        }
    }

    if report.has_failures() {
        return Err(silent_cli_failure(
            CliErrorCategory::ProviderUnavailable,
            "doctor found required setup failures",
        ));
    }
    Ok(())
}

fn config_command(args: ConfigArgs) -> Result<()> {
    let paths = GyroPaths::for_current_user()?;
    let config = GyroConfig::load(&paths)?;

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
        ConfigCommand::SetUpdateChannel { channel, json } => {
            require_stable_update_source(&channel)?;
            let output = ConfigMutationOutput {
                status: CliStatus::Done,
                action: "set-update-channel",
                target: channel,
                message: "update source set to Stable via GitHub Releases".into(),
            };
            if json {
                print_json(&output)?;
            } else {
                println!("{}", output.message);
            }
        }
        ConfigCommand::EnableProvider { provider_id, json } => {
            let display_name = GyroConfig::update(&paths, |config| {
                let provider = config
                    .model_providers
                    .iter_mut()
                    .find(|provider| provider.id == provider_id)
                    .ok_or_else(|| {
                        cli_failure(
                            CliErrorCategory::InvalidInput,
                            format!("unknown provider `{provider_id}`"),
                        )
                    })?;
                provider.enabled = true;
                Ok(provider.display_name.clone())
            })?;
            let output = ConfigMutationOutput {
                status: CliStatus::Done,
                action: "enable-provider",
                target: provider_id,
                message: format!("enabled provider {display_name}"),
            };
            if json {
                print_json(&output)?;
            } else {
                println!("{}", output.message);
            }
        }
        ConfigCommand::SetProviderKey {
            provider_id,
            value,
            env,
            json,
        } => {
            let provider = config
                .model_providers
                .iter()
                .find(|provider| provider.id == provider_id)
                .ok_or_else(|| {
                    cli_failure(
                        CliErrorCategory::InvalidInput,
                        format!("unknown provider `{provider_id}`"),
                    )
                })?;
            let value = match (value, env) {
                (Some(value), None) => value,
                (None, Some(env)) => std::env::var(&env).map_err(|error| {
                    cli_failure(
                        CliErrorCategory::InvalidInput,
                        format!("read provider key from ${env}: {error}"),
                    )
                })?,
                _ => {
                    return Err(cli_failure(
                        CliErrorCategory::InvalidInput,
                        "pass exactly one of --value or --env when setting a provider key",
                    ))
                }
            };
            keychain::set_api_key(&provider.api_key_ref, &value).map_err(|error| {
                cli_failure(
                    CliErrorCategory::ExecutionFailed,
                    format!("store provider key in macOS Keychain: {error}"),
                )
            })?;
            let output = ConfigMutationOutput {
                status: CliStatus::Done,
                action: "set-provider-key",
                target: provider_id,
                message: format!("stored {} API key in macOS Keychain", provider.display_name),
            };
            if json {
                print_json(&output)?;
            } else {
                println!("{}", output.message);
            }
        }
    }

    Ok(())
}

fn require_stable_update_source(channel: &str) -> Result<()> {
    if channel == "stable" {
        Ok(())
    } else {
        Err(cli_failure(
            CliErrorCategory::InvalidInput,
            "Gyro supports only the stable GitHub Releases update source",
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
            "--json",
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
        assert!(chat.json);
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
    fn parses_machine_output_for_app_and_config_mutations() {
        let app = Cli::try_parse_from(["gyro", "app", "open", "--json"]).unwrap();
        assert!(app.wants_json());
        let Some(Commands::App(AppArgs {
            json,
            command: AppCommand::Open { session_id },
        })) = app.command
        else {
            panic!("expected app open command");
        };
        assert!(json);
        assert!(session_id.is_none());

        for args in [
            vec!["gyro", "config", "set-update-channel", "stable", "--json"],
            vec!["gyro", "config", "enable-provider", "openai", "--json"],
            vec![
                "gyro",
                "config",
                "set-provider-key",
                "openai",
                "--env",
                "OPENAI_API_KEY",
                "--json",
            ],
        ] {
            let cli = Cli::try_parse_from(args).unwrap();
            assert!(cli.wants_json());
        }
    }

    #[test]
    fn generates_completions_for_supported_shells() {
        for shell in [Shell::Zsh, Shell::Bash, Shell::Fish] {
            let mut command = Cli::command();
            let mut output = Vec::new();
            generate(shell, &mut command, "gyro", &mut output);
            let output = String::from_utf8(output).unwrap();
            assert!(output.contains("doctor"));
            assert!(output.contains("sessions"));
            assert!(output.contains("completions"));
        }

        let cli = Cli::try_parse_from(["gyro", "completions", "zsh"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Commands::Completions(CompletionsArgs { shell: Shell::Zsh }))
        ));
    }

    #[test]
    fn parses_terminal_native_approval_workflows() {
        let session_id = Uuid::new_v4();
        let inbox = Cli::try_parse_from([
            "gyro",
            "approvals",
            "--session",
            &session_id.to_string(),
            "--limit",
            "10",
            "--json",
        ])
        .unwrap();
        assert!(inbox.wants_json());
        let Some(Commands::Approvals(ApprovalsArgs {
            session,
            limit,
            command: None,
            ..
        })) = inbox.command
        else {
            panic!("expected approval inbox");
        };
        assert_eq!(session, Some(session_id));
        assert_eq!(limit, 10);

        let proposal_id = Uuid::new_v4();
        let approve = Cli::try_parse_from([
            "gyro",
            "approvals",
            "approve",
            &proposal_id.to_string(),
            "--json",
        ])
        .unwrap();
        assert!(approve.wants_json());
        assert!(matches!(
            approve.command,
            Some(Commands::Approvals(ApprovalsArgs {
                command: Some(ApprovalCommand::Approve { proposal_id: parsed }),
                ..
            })) if parsed == proposal_id
        ));
    }

    #[test]
    fn approval_inbox_json_omits_unreviewed_file_content() {
        let output = ApprovalInboxOutput {
            status: CliStatus::Waiting,
            count: 1,
            approvals: vec![ApprovalSummaryOutput {
                proposal_id: Uuid::new_v4(),
                session_id: Uuid::new_v4(),
                workspace: PathBuf::from("/tmp/project"),
                path: "src/main.rs".into(),
                operation: MutationProposalOperation::Update,
                status: MutationProposalStatus::Pending,
                created_at: "2026-07-13T00:00:00Z".into(),
            }],
        };
        let value = serde_json::to_value(CliJsonEnvelope {
            schema: CLI_JSON_SCHEMA_V1,
            value: &output,
        })
        .unwrap();

        assert_eq!(value["schema"], CLI_JSON_SCHEMA_V1);
        assert_eq!(value["status"], "waiting");
        assert_eq!(value["approvals"][0]["operation"], "update");
        assert!(value["approvals"][0].get("content").is_none());
        assert!(value["approvals"][0].get("expectedHash").is_none());
    }

    #[test]
    fn chat_and_app_json_contracts_are_versioned_and_redaction_safe() {
        let session_id = Uuid::new_v4();
        let chat = ChatEventOutput {
            event: "chat-turn",
            status: CliStatus::Done,
            session_id,
            workspace: PathBuf::from("/tmp/project"),
            profile_id: "codex".into(),
            profile_label: "Codex".into(),
            model: Some("gpt-test".into()),
            approval_required: true,
            run: Some(CliRunOutput {
                run_id: Uuid::new_v4(),
                attempt_id: Uuid::new_v4(),
                provider_id: "openai".into(),
                duration_ms: 42,
                exit_code: Some(0),
                resumed: false,
                response: "done".into(),
            }),
            app_handoff: None,
        };
        let chat_value = serde_json::to_value(CliJsonEnvelope {
            schema: CLI_JSON_SCHEMA_V1,
            value: &chat,
        })
        .unwrap();
        assert_eq!(chat_value["schema"], "gyro.cli.v1");
        assert_eq!(chat_value["event"], "chat-turn");
        assert_eq!(chat_value["sessionId"], session_id.to_string());
        assert_eq!(chat_value["run"]["response"], "done");

        let app = AppCommandOutput {
            status: CliStatus::Done,
            action: "open",
            session: SessionSummaryOutput {
                session_id,
                title: "Inspect".into(),
                workspace: PathBuf::from("/tmp/project"),
                workspace_mode: SessionWorkspaceMode::Local,
                branch: "main".into(),
                worktree_name: None,
                origin: SessionOrigin::Cli,
                updated_at: "2026-07-13T00:00:00Z".into(),
            },
            app_handoff: AppHandoffOutput {
                requested: true,
                opened: true,
                app_version: Some("0.1.0-alpha.20".into()),
                compatible: Some(true),
                message: "opened".into(),
            },
        };
        let app_value = serde_json::to_value(CliJsonEnvelope {
            schema: CLI_JSON_SCHEMA_V1,
            value: &app,
        })
        .unwrap();
        assert_eq!(app_value["schema"], "gyro.cli.v1");
        assert_eq!(app_value["action"], "open");
        assert_eq!(app_value["appHandoff"]["opened"], true);
        assert_eq!(app_value["appHandoff"]["compatible"], true);

        let mutation = ConfigMutationOutput {
            status: CliStatus::Done,
            action: "set-provider-key",
            target: "openai".into(),
            message: "stored OpenAI API key in macOS Keychain".into(),
        };
        let mutation_value = serde_json::to_value(CliJsonEnvelope {
            schema: CLI_JSON_SCHEMA_V1,
            value: &mutation,
        })
        .unwrap();
        assert_eq!(mutation_value["target"], "openai");
        assert!(mutation_value.get("value").is_none());
        assert!(mutation_value.get("apiKey").is_none());
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
    fn disabled_provider_profile_is_blocked_before_execution() {
        let config = GyroConfig::default();
        let error = select_execution_profile(&config, Some("claude-code"), false).unwrap_err();
        let message = error.to_string();

        assert_eq!(
            cli_failure_details(&error).0,
            CliErrorCategory::ProviderUnavailable
        );
        assert!(message.contains("provider `anthropic` is disabled"));
        assert!(message.contains("gyro config enable-provider anthropic"));
        assert!(message.contains("session saved: no"));
    }

    #[test]
    fn stale_resume_detection_requires_a_provider_session_identity() {
        assert!(is_stale_provider_resume_error(
            "Codex app-server error: thread not found"
        ));
        assert!(is_stale_provider_resume_error(
            "Could not resume unknown session"
        ));
        assert!(!is_stale_provider_resume_error("workspace file not found"));
        assert!(!is_stale_provider_resume_error("provider rate limited"));
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
                app_version: None,
                compatible: None,
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
    fn typed_failures_keep_exit_categories_independent_of_wording() {
        for category in [
            CliErrorCategory::InvalidInput,
            CliErrorCategory::ProviderUnavailable,
            CliErrorCategory::ApprovalRejected,
            CliErrorCategory::ExecutionFailed,
            CliErrorCategory::Cancelled,
        ] {
            let error = cli_failure(category, "wording without category hints")
                .context("outer command context");
            assert_eq!(cli_failure_details(&error), (category, true));
            assert_eq!(
                cli_failure_details(&error).0.exit_code(),
                category.exit_code()
            );
        }

        let internal = anyhow!("untyped storage failure");
        assert_eq!(
            cli_failure_details(&internal),
            (CliErrorCategory::Internal, true)
        );
        let silent = silent_cli_failure(CliErrorCategory::ProviderUnavailable, "doctor failed");
        assert_eq!(
            cli_failure_details(&silent),
            (CliErrorCategory::ProviderUnavailable, false)
        );
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

    #[test]
    fn shared_stream_decoder_extracts_structured_authentication_failures() {
        let mut decoder = CliStreamDecoder::default();
        let deltas = decoder.push_stdout(
            r#"{"type":"result","subtype":"error_during_execution","is_error":true,"api_error_status":401,"result":"Failed to authenticate. API Error: 401 Invalid authentication credentials; api_key=sk-abcdefghijklmnopqrstuvwxyz123456"}
"#,
        );

        assert!(deltas.is_empty());
        assert!(decoder.response.is_empty());
        let failure = decoder.provider_failure.unwrap();
        assert_eq!(failure.kind, CliProviderFailureKind::Authentication);
        assert!(failure.message.contains("Failed to authenticate"));
        assert!(failure.message.contains("[REDACTED]"));
        assert!(!failure.message.contains("abcdefghijklmnopqrstuvwxyz"));
    }

    #[test]
    fn normal_provider_text_that_mentions_auth_is_not_a_failure() {
        let mut decoder = CliStreamDecoder::default();
        let deltas = decoder.push_stdout(
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"The test covers a user who is not authenticated."}}
"#,
        );

        assert_eq!(
            deltas,
            vec!["The test covers a user who is not authenticated."]
        );
        assert!(decoder.provider_failure.is_none());
    }

    #[test]
    fn narrow_cli_wrapping_preserves_unicode_and_bounds_lines() {
        let value =
            "Provider ready · résumé 🌍 /a/very/long/path/that/must/wrap/without/losing/data";
        let lines = wrap_cli_text(value, 24);

        assert!(lines.iter().all(|line| line.chars().count() <= 24));
        assert_eq!(lines.concat().replace(' ', ""), value.replace(' ', ""));
        assert_eq!(truncate_cli_text("résumé 🌍 ready", 10), "résumé ...");
    }

    #[test]
    fn claude_invocation_uses_the_permission_bridge_without_a_bypass_flag() {
        let profile = CommandProfile {
            id: "claude-code".into(),
            display_name: "Claude Code".into(),
            command: "claude".into(),
            args: Vec::new(),
            working_directory: None,
            provider_id: Some("anthropic".into()),
            default_model: None,
            readiness: gyro_core::CommandProfileReadiness::Ready,
        };
        let invocation = build_cli_provider_invocation(
            &profile,
            Path::new("/tmp"),
            "inspect",
            None,
            None,
            Some(r#"{"mcpServers":{}}"#),
            5,
        )
        .unwrap();
        let args = invocation
            .request
            .args
            .iter()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect::<Vec<_>>();

        assert!(args.contains(&"--permission-prompt-tool".into()));
        assert!(args.contains(&"mcp__gyro_approval__approve".into()));
        assert!(args.contains(&"--setting-sources".into()));
        assert!(args.contains(&"--verbose".into()));
        assert!(!args.contains(&"--dangerously-skip-permissions".into()));
    }

    #[test]
    fn claude_profile_permission_bypasses_fail_closed() {
        let profile = CommandProfile {
            id: "claude-code".into(),
            display_name: "Claude Code".into(),
            command: "claude".into(),
            args: vec!["--dangerously-skip-permissions".into()],
            working_directory: None,
            provider_id: Some("anthropic".into()),
            default_model: None,
            readiness: gyro_core::CommandProfileReadiness::Ready,
        };
        let error = build_cli_provider_invocation(
            &profile,
            Path::new("/tmp"),
            "inspect",
            None,
            None,
            Some(r#"{"mcpServers":{}}"#),
            5,
        )
        .err()
        .expect("permission bypass must fail");

        assert_eq!(
            cli_failure_details(&error).0,
            CliErrorCategory::ApprovalRejected
        );
    }

    #[test]
    fn codex_file_approval_applies_the_reviewed_change_without_native_reapply() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("reviewed.txt"), "before\n").unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let mutation_journal_dir = paths.mutation_journals_dir.clone();
        let store = SessionStore::open(paths).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Cli, "reviewed mutation")
            .unwrap();
        let profile = CommandProfile {
            id: "codex".into(),
            display_name: "Codex CLI".into(),
            command: "codex".into(),
            args: Vec::new(),
            working_directory: None,
            provider_id: Some("openai".into()),
            default_model: None,
            readiness: gyro_core::CommandProfileReadiness::Ready,
        };
        let approval = CodexApprovalRequest {
            kind: CodexApprovalKind::FileChange,
            details: serde_json::json!({
                "change": {
                    "changes": [{
                        "path": temp.path().join("reviewed.txt"),
                        "kind": { "type": "update", "movePath": null },
                        "diff": "@@ -1 +1 @@\n-before\n+after\n"
                    }]
                }
            }),
        };

        let decision = decide_codex_provider_approval(
            &store,
            &mutation_journal_dir,
            &session,
            &profile,
            Uuid::new_v4(),
            &GyroConfig::default(),
            true,
            true,
            &CancellationToken::default(),
            &approval,
        )
        .unwrap();

        let events = store.read_events(session.id).unwrap();
        assert_eq!(
            decision,
            CodexApprovalDecision::AppliedByClient,
            "events: {events:#?}"
        );
        assert_eq!(
            std::fs::read_to_string(temp.path().join("reviewed.txt")).unwrap(),
            "after\n"
        );
        assert!(events.iter().any(|event| {
            event.payload["status"] == "applied"
                && event.payload["changedPaths"][0] == "reviewed.txt"
        }));
    }

    #[test]
    fn codex_app_server_prompt_requires_disk_truth_after_native_decline() {
        let prompt = codex_app_server_prompt("update it");
        assert!(prompt.contains("re-read the affected files"));
        assert!(prompt.contains("actual on-disk state"));
        assert!(prompt.ends_with("User request:\nupdate it"));
    }

    #[cfg(unix)]
    #[test]
    fn codex_app_server_file_turn_uses_the_gyro_transaction_end_to_end() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("reviewed.txt"), "before\n").unwrap();
        let script = temp.path().join("fake-codex-file-turn");
        std::fs::write(
            &script,
            r#"#!/bin/sh
test "$1" = "app-server" || exit 21
test "$2" = "--stdio" || exit 22
IFS= read -r initialize
printf '%s\n' '{"id":1,"result":{}}'
IFS= read -r initialized
IFS= read -r thread
printf '%s\n' '{"id":2,"result":{"thread":{"id":"019f5a51-d9dc-7423-89fa-8f92cfe4d728"}}}'
IFS= read -r turn
printf '%s\n' '{"id":3,"result":{}}'
printf '%s\n' '{"method":"item/fileChange/patchUpdated","params":{"itemId":"file-1","changes":[{"path":"reviewed.txt","kind":{"type":"update","movePath":null},"diff":"@@ -1 +1 @@\n-before\n+after\n"}]}}'
printf '%s\n' '{"id":42,"method":"item/fileChange/requestApproval","params":{"itemId":"file-1","reason":"test reviewed file"}}'
IFS= read -r decision
case "$decision" in *'"decision":"decline"'*) ;; *) exit 23 ;; esac
printf '%s\n' '{"method":"item/agentMessage/delta","params":{"delta":"updated"}}'
printf '%s\n' '{"method":"item/completed","params":{"item":{"type":"agentMessage","text":"updated"}}}'
printf '%s\n' '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}'
"#,
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script, permissions).unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let mutation_journal_dir = paths.mutation_journals_dir.clone();
        let store = SessionStore::open(paths).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Cli, "file turn")
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
        let config = GyroConfig {
            require_command_approval: true,
            require_file_edit_approval: true,
            ..GyroConfig::default()
        };

        let output = execute_cli_provider(
            &store,
            &mutation_journal_dir,
            &session,
            &profile,
            None,
            "update the file",
            "run",
            &config,
            true,
            true,
            5,
            Uuid::new_v4(),
            Uuid::new_v4(),
        )
        .unwrap();

        assert_eq!(output.response, "updated");
        assert_eq!(
            std::fs::read_to_string(temp.path().join("reviewed.txt")).unwrap(),
            "after\n"
        );
        assert!(store.read_events(session.id).unwrap().iter().any(|event| {
            event.payload["status"] == "applied"
                && event.payload["changedPaths"][0] == "reviewed.txt"
        }));
    }

    #[cfg(unix)]
    #[test]
    fn trusted_cli_run_persists_shared_state_and_ctrl_c_reaches_active_token() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("fake-codex");
        std::fs::write(
            &script,
            r#"#!/bin/sh
test "$1" = "app-server" || exit 21
test "$2" = "--stdio" || exit 22
IFS= read -r initialize
printf '%s\n' '{"id":1,"result":{}}'
IFS= read -r initialized
IFS= read -r thread
printf '%s\n' '{"id":2,"result":{"thread":{"id":"019f5a51-d9dc-7423-89fa-8f92cfe4d727"}}}'
IFS= read -r turn
printf '%s\n' '{"id":3,"result":{}}'
printf '%s\n' '{"id":41,"method":"item/commandExecution/requestApproval","params":{"itemId":"command-1","command":"printf validated","cwd":"/tmp","reason":"test"}}'
IFS= read -r decision
case "$decision" in *'"decision":"accept"'*) ;; *) exit 23 ;; esac
printf '%s\n' '{"method":"item/agentMessage/delta","params":{"delta":"validated"}}'
printf '%s\n' '{"method":"item/completed","params":{"item":{"type":"agentMessage","text":"validated"}}}'
printf '%s\n' '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}'
"#,
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script, permissions).unwrap();

        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let mutation_journal_dir = paths.mutation_journals_dir.clone();
        let store = SessionStore::open(paths).unwrap();
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
        let config = GyroConfig {
            require_command_approval: false,
            require_file_edit_approval: false,
            ..GyroConfig::default()
        };
        let run_id = Uuid::new_v4();
        let attempt_id = Uuid::new_v4();

        let output = execute_cli_provider(
            &store,
            &mutation_journal_dir,
            &session,
            &profile,
            None,
            "validate",
            "run",
            &config,
            false,
            true,
            5,
            run_id,
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
            .read_events(session.id)
            .unwrap()
            .iter()
            .any(|event| event.kind == SessionEventKind::ApprovalRequested
                && event.payload["schema"] == "gyro.provider-approval.v1"
                && event.payload["approvalType"] == "command"));
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
