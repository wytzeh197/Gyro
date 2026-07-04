use anyhow::{anyhow, Context, Result};
use clap::{Args, Parser, Subcommand};
use gyro_core::{
    config::UpdateChannel, create_worktree, doctor::run_doctor, ipc::notify_running_app, keychain,
    slugify_worktree_name, AppNotification, AppNotificationKind, CreateSessionContext, GyroConfig,
    GyroPaths, Session, SessionEventKind, SessionOrigin, SessionStore, SessionWorkspaceMode,
};
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

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

    #[command(flatten)]
    worktree: WorktreeArgs,
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

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Some(Commands::Run(args)) => run_task(args),
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
        },
    )?;
    store.append_event(
        session.id,
        SessionEventKind::SystemEvent,
        "CLI worktree session created.",
        serde_json::json!({
            "repoPath": plan.git_root,
            "worktreePath": plan.worktree_path,
            "branch": session.branch,
            "worktreeName": session.worktree_name,
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

        store.append_event(
            session.id,
            SessionEventKind::UserMessage,
            input,
            serde_json::json!({ "surface": "cli" }),
        )?;
        store.append_event(
            session.id,
            SessionEventKind::SystemEvent,
            "Message saved. Model execution is configured through providers.",
            serde_json::json!({ "status": "queued-for-agent" }),
        )?;
        println!("saved to session {}", session.id);
    }

    Ok(())
}

fn run_task(args: RunArgs) -> Result<()> {
    let (paths, store) = open_store()?;
    let workspace = workspace_path(args.workspace)?;
    let title = summarize_title(&args.task);
    let session = create_cli_session(&paths, &store, &workspace, title, &args.worktree)?;
    store.append_event(
        session.id,
        SessionEventKind::UserMessage,
        args.task,
        serde_json::json!({
            "surface": "cli",
            "mode": "run",
            "workspaceMode": session.workspace_mode,
            "branch": session.branch,
            "worktreeName": session.worktree_name,
        }),
    )?;
    store.append_event(
        session.id,
        SessionEventKind::ApprovalRequested,
        "Agent task recorded; command and file edits require approval by default.",
        serde_json::json!({
            "requireCommandApproval": true,
            "requireFileEditApproval": true,
        }),
    )?;

    println!("Created Gyro session {}", session.id);
    println!("Workspace: {}", session.workspace_path.display());
    if session.workspace_mode == SessionWorkspaceMode::Worktree {
        println!("Branch: {}", session.branch);
        if let Some(worktree_name) = &session.worktree_name {
            println!("Worktree: {worktree_name}");
        }
    }
    if notify_session(&paths, &session, AppNotificationKind::OpenSession)? {
        println!("Notified Gyro.app to open the session.");
    } else {
        println!(
            "Gyro.app is not running. Run `gyro app open {}` to open it.",
            session.id
        );
    }
    Ok(())
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
                    "workspaceMode": session.workspace_mode,
                    "branch": session.branch,
                    "worktreeName": session.worktree_name,
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
    if notify_session(paths, session, kind.clone())? {
        println!("Notified Gyro.app about session {}.", session.id);
        return Ok(());
    }

    launch_desktop_app(&session.id, kind)?;
    Ok(())
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
            println!("Launched Gyro.app for session {session_id}.");
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
                    println!(
                        "  {} -> {} {}",
                        profile.display_name,
                        profile.command,
                        profile.args.join(" ")
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
