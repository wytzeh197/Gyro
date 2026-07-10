use anyhow::{anyhow, Context, Result};
use clap::{Args, Parser, Subcommand};
use gyro_core::{
    config::{CommandProfile, UpdateChannel},
    create_worktree,
    doctor::run_doctor,
    ipc::notify_running_app,
    keychain, slugify_worktree_name, AppNotification, AppNotificationKind, ApprovalRequestPayload,
    CreateSessionContext, DoctorStatus, GyroConfig, GyroPaths, HarnessRunStatus,
    ProviderRunPayload, Session, SessionEventKind, SessionOrigin, SessionStore,
    SessionWorkspaceMode, TerminalRequestPayload,
};
use serde::Serialize;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

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
    /// Set the update channel.
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
    app_handoff: AppHandoffOutput,
    resume_command: String,
    next_command: Option<String>,
    message: String,
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

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Some(Commands::Run(args)) => run_task(args),
        Some(Commands::Resume(args)) => resume_session(args),
        Some(Commands::Sessions(args)) => sessions_command(args),
        Some(Commands::Setup(args)) => setup_command(args),
        Some(Commands::App(args)) => app_command(args),
        Some(Commands::Doctor(args)) => doctor(args),
        Some(Commands::Config(args)) => config_command(args),
        None => interactive_chat(),
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
    );
    gyro_core::validate_mutation_approval_policy("terminal-request", payload.approval_required)?;
    let mut value = gyro_core::harness_payload_value(&payload)?;
    insert_cli_metadata(&mut value, mode, profile, model, session);
    Ok(value)
}

fn cli_approval_payload(run_id: Uuid, mode: &str) -> Result<serde_json::Value> {
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
            serde_json::Value::Bool(true),
        );
        object.insert(
            "requireFileEditApproval".into(),
            serde_json::Value::Bool(true),
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
    println!("{}", serde_json::to_string_pretty(value)?);
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

fn interactive_chat() -> Result<()> {
    let (paths, store) = open_store()?;
    let workspace = workspace_path(None)?;
    let session = store.create_session(&workspace, SessionOrigin::Cli, "CLI chat")?;

    println!("Gyro CLI session {}", session.id);
    println!("Workspace: {}", workspace.display());
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
                None,
                None,
                &session,
            )?,
            Some(turn_id),
        )?;
        store.append_event_with_turn_id(
            session.id,
            SessionEventKind::SystemEvent,
            "Message saved. Model execution is configured through providers.",
            cli_provider_run_payload(
                turn_id,
                attempt_id,
                "chat",
                HarnessRunStatus::Waiting,
                None,
                None,
                &session,
            )?,
            Some(turn_id),
        )?;
        println!("saved to session {}", session.id);
    }

    Ok(())
}

fn run_task(args: RunArgs) -> Result<()> {
    let (paths, store) = open_store()?;
    let config = GyroConfig::load(&paths)?;
    let profile = select_command_profile(&config, args.profile.as_deref())?;
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
        )?,
        Some(turn_id),
    )?;
    store.append_event_with_turn_id(
        session.id,
        SessionEventKind::ApprovalRequested,
        "Agent task recorded; command and file edits require approval by default.",
        cli_approval_payload(turn_id, "run")?,
        Some(turn_id),
    )?;

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
    }

    let handoff = perform_app_handoff(
        &paths,
        &session,
        AppNotificationKind::OpenSession,
        open_behavior(args.open, args.no_open),
    )?;
    let message = match status {
        CliStatus::Blocked => profile_message
            .unwrap_or_else(|| "session saved, but the selected CLI profile needs setup".into()),
        _ => "local session saved; approval required before commands or file edits".into(),
    };
    let output = SessionCommandOutput {
        status,
        session_id: session.id,
        title: session.title.clone(),
        workspace: session.workspace_path.clone(),
        workspace_mode: session.workspace_mode.clone(),
        branch: session.branch.clone(),
        worktree_name: session.worktree_name.clone(),
        profile_id: profile_id(profile),
        profile_label: profile_label(profile),
        model,
        app_handoff: handoff,
        resume_command: format!("gyro resume {}", session.id),
        next_command,
        message,
    };

    if args.json {
        print_json(&output)?;
    } else {
        print_session_command_output("Run recorded", &output);
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
    let profile = select_command_profile(&config, selected_profile_id)?;
    let model = model_for(profile, args.model.or(recorded_model));
    let (status, profile_message, next_command) = profile_status(profile);
    let turn_id = Uuid::new_v4();
    let attempt_id = Uuid::new_v4();

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
        SessionEventKind::CommandRequested,
        "CLI agent resume recorded.",
        cli_terminal_request_payload(
            turn_id,
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
        SessionEventKind::ApprovalRequested,
        "Agent resume recorded; command and file edits require approval by default.",
        cli_approval_payload(turn_id, "resume")?,
        Some(turn_id),
    )?;

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
    }

    let handoff = perform_app_handoff(
        &paths,
        &session,
        AppNotificationKind::OpenSession,
        open_behavior(args.open, args.no_open),
    )?;
    let message = match status {
        CliStatus::Blocked => profile_message
            .unwrap_or_else(|| "resume saved, but the selected CLI profile needs setup".into()),
        _ => "resume recorded; local session remains approval gated".into(),
    };
    let output = SessionCommandOutput {
        status,
        session_id: session.id,
        title: session.title.clone(),
        workspace: session.workspace_path.clone(),
        workspace_mode: session.workspace_mode.clone(),
        branch: session.branch.clone(),
        worktree_name: session.worktree_name.clone(),
        profile_id: profile_id(profile),
        profile_label: profile_label(profile),
        model,
        app_handoff: handoff,
        resume_command: format!("gyro resume {}", session.id),
        next_command,
        message,
    };

    if args.json {
        print_json(&output)?;
    } else {
        print_session_command_output("Resume recorded", &output);
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
        for provider in enabled_providers {
            let key_status = keychain::get_api_key(&provider.api_key_ref);
            let has_key = key_status
                .as_ref()
                .ok()
                .and_then(|value| value.as_ref())
                .is_some();
            checks.push(SetupCheckOutput {
                id: format!("provider:{}", provider.id),
                label: format!("Provider: {}", provider.display_name),
                status: if has_key {
                    CliStatus::Ready
                } else {
                    CliStatus::Waiting
                },
                message: if has_key {
                    format!("{} key is stored in Keychain", provider.display_name)
                } else if let Err(error) = key_status {
                    format!("could not inspect Keychain entry: {error}")
                } else {
                    format!("{} is enabled; no Keychain key found", provider.display_name)
                },
                next: if has_key {
                    None
                } else {
                    Some(format!(
                        "run `gyro config set-provider-key {} --env <ENV_VAR>` or use external CLI auth",
                        provider.id
                    ))
                },
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
    println!("approval: required");
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
        println!("{}", serde_json::to_string_pretty(&report)?);
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
        std::process::exit(1);
    }
    Ok(())
}

fn config_command(args: ConfigArgs) -> Result<()> {
    let paths = GyroPaths::for_current_user()?;
    let mut config = GyroConfig::load(&paths)?;

    match args.command {
        ConfigCommand::Show { json } => {
            if json {
                println!("{}", serde_json::to_string_pretty(&config)?);
            } else {
                println!("update channel: {:?}", config.update_channel);
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
            config.update_channel = parse_update_channel(&channel)?;
            config.save(&paths)?;
            println!("update channel set to {:?}", config.update_channel);
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

fn parse_update_channel(channel: &str) -> Result<UpdateChannel> {
    match channel {
        "stable" => Ok(UpdateChannel::Stable),
        "beta" => Ok(UpdateChannel::Beta),
        "nightly" => Ok(UpdateChannel::Nightly),
        _ => Err(anyhow!("expected update channel stable, beta, or nightly")),
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
        assert_eq!(args.task, "inspect this repo");
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
            app_handoff: AppHandoffOutput {
                requested: true,
                opened: false,
                message: "Gyro.app is not running".into(),
            },
            resume_command: "gyro resume 00000000-0000-0000-0000-000000000000".into(),
            next_command: Some("gyro setup".into()),
            message: "local session saved".into(),
        };
        let value = serde_json::to_value(output).unwrap();
        assert_eq!(value["status"], "waiting");
        assert_eq!(value["sessionId"], "00000000-0000-0000-0000-000000000000");
        assert_eq!(value["workspaceMode"], "local");
        assert_eq!(value["profileId"], "codex");
        assert_eq!(value["appHandoff"]["requested"], true);
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
        )
        .unwrap();
        let approval_payload = cli_approval_payload(run_id, "run").unwrap();

        assert_eq!(run_payload["schema"], gyro_core::HARNESS_SCHEMA_V1);
        assert_eq!(run_payload["runId"], run_id.to_string());
        assert_eq!(run_payload["status"], "queued");
        assert_eq!(run_payload["profileId"], "codex");
        assert_eq!(run_payload["model"], "gpt-test");
        assert_eq!(command_payload["kind"], "terminal-request");
        assert_eq!(command_payload["approvalRequired"], true);
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
}
