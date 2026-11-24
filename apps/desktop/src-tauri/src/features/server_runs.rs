//! Desktop bridge for running an installed Codex CLI on a user's SSH server.
use anyhow::{bail, ensure, Context, Result};
use gyro_remote::{
    server_runs::{
        needs_sign_in, new_run_id, project_name, runner_error_code, RunEvent, RunRequest, RunState,
        RunStatus, RunnerHost, ServerRun, SignInCheck, SignInRule,
    },
    ssh::{config_hosts, Options},
    store::{self, Store},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use crate::{git, workspace::files::workspace_root};

const CLI: &str = "codex";
const LOG_BATCH_SIZE: usize = 48;
const MAX_DIFF_BYTES: usize = 512 * 1024;

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Request {
    List {
        workspace_path: String,
    },
    Start {
        workspace_path: String,
        host: String,
        task: String,
    },
    Read {
        run_id: String,
        offset: u64,
    },
    Stop {
        run_id: String,
    },
    Review {
        run_id: String,
    },
    FileDiff {
        run_id: String,
        path: String,
    },
}

#[tauri::command]
pub(crate) async fn server_runs_request(
    window: tauri::WebviewWindow,
    request: Request,
) -> Result<Value, String> {
    if !cfg!(debug_assertions) {
        return Err("Server runs are available in Gyro’s development build.".into());
    }
    if window.label() != "main" {
        return Err("Server runs are available from the main Gyro window.".into());
    }
    dispatch(request).await.map_err(|error| error.to_string())
}

async fn dispatch(request: Request) -> Result<Value> {
    let store = super::remote_access::store().map_err(anyhow::Error::msg)?;
    match request {
        Request::List { workspace_path } => {
            let repo = repository(workspace_path).await?;
            let mut runs = store.server_runs()?;
            runs.retain(|run| Path::new(&run.repo) == repo);
            runs.reverse();
            let aliases = std::env::var_os("HOME")
                .map(|home| config_hosts(Path::new(&home)))
                .unwrap_or_default();
            Ok(json!({ "runs": runs, "aliases": aliases }))
        }
        Request::Start {
            workspace_path,
            host,
            task,
        } => {
            let repo = repository(workspace_path).await?;
            start(&store, &repo, host, task).await
        }
        Request::Read { run_id, offset } => {
            let run = saved_run(&store, &run_id)?;
            read(&run, offset).await
        }
        Request::Stop { run_id } => {
            let run = saved_run(&store, &run_id)?;
            let status = runner(&run.host_id)?.stop(&run.id).await?;
            Ok(status_value(&status))
        }
        Request::Review { run_id } => review(&store, saved_run(&store, &run_id)?).await,
        Request::FileDiff { run_id, path } => file_diff(saved_run(&store, &run_id)?, path).await,
    }
}

async fn repository(workspace_path: String) -> Result<PathBuf> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure!(
            !workspace_path.trim().is_empty(),
            "Open a Git project first."
        );
        let workspace = workspace_root(&workspace_path)?;
        let repo = git::read::repo_root(&workspace, Instant::now() + Duration::from_secs(10))?
            .context("Open a Git project first.")?;
        ensure!(
            repo == workspace,
            "Open the repository root to run this project on a server."
        );
        Ok(repo)
    })
    .await?
}

fn runner(host: &str) -> Result<RunnerHost> {
    RunnerHost::new(Options {
        host: host.to_owned(),
        user: None,
        port: None,
        identity_file: None,
        socket_path: None,
    })
}

fn saved_run(store: &Store, id: &str) -> Result<ServerRun> {
    store
        .server_runs()?
        .into_iter()
        .find(|run| run.id == id)
        .context("This run is no longer saved on this Mac.")
}

async fn start(store: &Store, repo: &Path, host: String, task: String) -> Result<Value> {
    let task = task.trim();
    ensure!(!task.is_empty(), "Enter a task for Codex.");
    ensure!(task.len() <= 32 * 1024, "The task is too long.");
    ensure!(
        !task.contains('\0'),
        "The task contains an unsupported character."
    );
    let host = host.trim().to_owned();
    let runner = runner(&host)?;
    let installed = runner.ensure_runner().await?;
    ensure!(
        installed.doctor.os.eq_ignore_ascii_case("linux"),
        "Choose a Linux SSH server."
    );
    ensure!(
        installed.doctor.git.is_some(),
        "Install Git on the server and try again."
    );
    let sign_in = runner
        .sign_in_status(&SignInCheck {
            argv: ["codex", "login", "status"].map(str::to_owned).to_vec(),
            signed_in: SignInRule {
                exit: Some(0),
                ..SignInRule::default()
            },
            timeout_seconds: None,
        })
        .await?;
    ensure!(sign_in.found, "Install Codex on the server and try again.");
    if let Some(error) = sign_in.error {
        bail!("Could not check Codex sign-in on the server: {error}");
    }
    ensure!(
        sign_in.signed_in == Some(true),
        "Sign in to Codex on the server, then try again."
    );

    let id = new_run_id();
    let run = ServerRun {
        result_branch: format!("gyro/cloud/{id}"),
        id,
        host_id: host,
        project: project_name(repo),
        repo: repo
            .to_str()
            .context("The project path is not valid text.")?
            .into(),
        cli: CLI.into(),
        state: RunState::Starting,
        offset: 0,
        base_commit: None,
        result_commit: None,
        created_at: store::now(),
    };
    // Save before sending the start request. Closing the app or losing the
    // SSH reply must leave a way to find a run that the server already started.
    store.save_server_run(&run)?;
    let request = RunRequest {
        cli: CLI.into(),
        task: task.into(),
        argv: [
            "codex",
            "-a",
            "never",
            "exec",
            "--sandbox",
            "workspace-write",
            "--json",
            "--",
            "{task}",
        ]
        .map(str::to_owned)
        .to_vec(),
        env: Default::default(),
        timeout_seconds: Some(3600),
        idle_seconds: None,
        allow_parallel: false,
    };
    match runner.launch(repo, &run.id, &request).await {
        Ok(_) => Ok(json!({ "run": run })),
        Err(error) if runner_error_code(&error).is_some_and(|code| code != "run_exists") => {
            store.remove_server_run(&run.id)?;
            Err(error)
        }
        Err(error) => Ok(json!({ "run": run, "warning": error.to_string() })),
    }
}

fn status_value(status: &RunStatus) -> Value {
    json!({
        "state": status.state,
        "reason": status.reason,
        "canReview": status.state.is_terminal() && status.result_commit.is_some() && status.changed == Some(true),
    })
}

async fn read(run: &ServerRun, offset: u64) -> Result<Value> {
    let host = runner(&run.host_id)?;
    let status = host.show(&run.id).await.map_err(|error| {
        if runner_error_code(&error) == Some("no_run") {
            anyhow::anyhow!(
                "This run could not be found on the server. Start again if it never launched."
            )
        } else {
            error
        }
    })?;
    let mut attach = host.attach(&run.id, offset).await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    let mut output = Vec::new();
    let mut terminal_log = false;
    let mut signed_out = false;
    for _ in 0..LOG_BATCH_SIZE {
        match tokio::time::timeout_at(deadline, attach.next()).await {
            Ok(Ok(Some(event))) => {
                signed_out |= needs_sign_in(CLI, &event.event);
                match event.event {
                    RunEvent::Out { line, .. } => {
                        if let Some(text) = codex_output(&line) {
                            output.push(text.chars().take(3000).collect::<String>());
                        }
                    }
                    RunEvent::Truncated => {
                        output.push("The server log reached its size limit.".into())
                    }
                    RunEvent::End { .. } => {
                        terminal_log = true;
                        break;
                    }
                    _ => {}
                }
            }
            Ok(Ok(None)) => {
                terminal_log = status.state.is_terminal();
                break;
            }
            Ok(Err(error)) => return Err(error),
            Err(_) => break,
        }
    }
    Ok(json!({
        "status": status_value(&status),
        "offset": attach.offset(),
        "output": output,
        "signedOut": signed_out,
        "finished": status.state.is_terminal() && terminal_log,
    }))
}

fn codex_output(line: &str) -> Option<String> {
    let Ok(event) = serde_json::from_str::<Value>(line) else {
        return Some(line.to_owned());
    };
    let item = &event["item"];
    let text = match event["type"].as_str() {
        Some("item.completed") if item["type"] == "agent_message" => item["text"].as_str(),
        Some("item.completed") if item["type"] == "command_execution" => item["command"].as_str(),
        Some("turn.failed") => event["error"]["message"].as_str(),
        Some("error") => event["message"].as_str(),
        _ => None,
    };
    text.map(str::to_owned)
}

async fn review(store: &Store, mut run: ServerRun) -> Result<Value> {
    let repo = repository(run.repo.clone()).await?;
    let (base, result) = match cached_commits(&run) {
        Ok(commits) => commits,
        Err(_) => {
            let host = runner(&run.host_id)?;
            let status = host.show(&run.id).await?;
            let (base, result) = review_commits(&run, &status)?;
            let commit = host
                .fetch_result_at(&repo, &run.project, &run.id, &result)
                .await?;
            ensure!(
                commit == result,
                "The result branch differs from the recorded run."
            );
            run.state = status.state;
            run.base_commit = Some(base.clone());
            run.result_commit = Some(result.clone());
            store.save_server_run(&run)?;
            (base, result)
        }
    };
    let files = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<String>> {
        let output = diff(&repo, &base, &result, None)?;
        ensure!(
            !output.stdout_truncated,
            "Too many files to list. Open the result branch in Git to review them."
        );
        Ok(output
            .stdout
            .split_terminator('\0')
            .map(str::to_owned)
            .collect())
    })
    .await??;
    Ok(json!({ "branch": run.result_branch, "files": files }))
}

async fn file_diff(run: ServerRun, path: String) -> Result<Value> {
    let repo = repository(run.repo.clone()).await?;
    let (base, result) = cached_commits(&run)?;
    let output =
        tauri::async_runtime::spawn_blocking(move || diff(&repo, &base, &result, Some(&path)))
            .await??;
    let notice = output
        .stdout_truncated
        .then_some("Preview limited to 512 KB. The result branch contains the full change.");
    Ok(json!({ "unified": output.stdout, "notice": notice }))
}

fn cached_commits(run: &ServerRun) -> Result<(String, String)> {
    let base = run
        .base_commit
        .as_ref()
        .context("Fetch the result before reviewing.")?;
    let result = run
        .result_commit
        .as_ref()
        .context("Fetch the result before reviewing.")?;
    verified_commits(base, result)
}

fn review_commits(run: &ServerRun, status: &RunStatus) -> Result<(String, String)> {
    ensure!(
        status.id == run.id
            && status.project == run.project
            && status.result_branch == run.result_branch,
        "The server returned a different run."
    );
    ensure!(
        status.state.is_terminal(),
        "Wait for the run to finish before reviewing."
    );
    let result = status
        .result_commit
        .as_ref()
        .context("This run has no result commit.")?;
    verified_commits(&status.base_commit, result)
}

fn verified_commits(base: &str, result: &str) -> Result<(String, String)> {
    for oid in [base, result] {
        ensure!(
            matches!(oid.len(), 40 | 64) && oid.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "The server returned an invalid result commit."
        );
    }
    Ok((base.to_owned(), result.to_owned()))
}

fn diff(
    repo: &Path,
    base: &str,
    result: &str,
    path: Option<&str>,
) -> Result<gyro_core::ExecutionOutcome> {
    let mut command = git::commands::git_command();
    command
        .arg("--literal-pathspecs")
        .arg("-C")
        .arg(repo)
        .args([
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
        ]);
    if path.is_none() {
        command.args(["--name-only", "-z"]);
    }
    command.args([base, result, "--"]);
    command.args(path);
    let output = git::read::run(
        &command,
        Instant::now() + Duration::from_secs(20),
        MAX_DIFF_BYTES,
    )?;
    ensure!(
        output.succeeded(),
        "Could not read the result in Git. Fetch the result branch again."
    );
    Ok(output)
}
