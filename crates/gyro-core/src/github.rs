//! GitHub integration backed by the `gh` CLI.
//!
//! Gyro never stores a GitHub token of its own: every call shells out to the
//! user's already-authenticated `gh`. When `gh` is missing or logged out the
//! probe degrades to an unavailable [`GithubAvailability`] with a hint instead
//! of failing, so the Workspace can render a quiet empty state.

use crate::cli_path::augmented_gui_path;
use crate::execution::{run_command, CancellationToken, ExecutionRequest, ExecutionTermination};
use crate::security::redact_secrets;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

pub const GITHUB_SCHEMA_V1: &str = "gyro.github.v1";

const GH_TIMEOUT: Duration = Duration::from_secs(30);
const GH_LOG_TIMEOUT: Duration = Duration::from_secs(90);
const GH_MAX_STDOUT_CHARS: usize = 512_000;
const GH_MAX_STDERR_CHARS: usize = 64_000;
const GH_MAX_LOG_CHARS: usize = 1_024_000;

pub const MAX_WORKFLOW_RUNS: usize = 50;
pub const MAX_PULL_REQUESTS: usize = 50;

const INSTALL_HINT: &str =
    "Install the GitHub CLI (https://cli.github.com) and run `gh auth login` to enable GitHub features.";
const LOGIN_HINT: &str = "Run `gh auth login` to connect Gyro to GitHub.";

/// Normalized run state shared by workflow runs, jobs, and steps.
///
/// `gh` reports progress in `status` and the outcome in `conclusion`; collapsing
/// the pair into one value keeps the UI from having to re-derive it everywhere.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GithubRunState {
    Queued,
    InProgress,
    Success,
    Failure,
    Cancelled,
    Skipped,
    Neutral,
    TimedOut,
    ActionRequired,
    Stale,
    Unknown,
}

impl GithubRunState {
    pub fn from_status_and_conclusion(status: &str, conclusion: Option<&str>) -> Self {
        let conclusion = conclusion.map(str::trim).filter(|value| !value.is_empty());
        if let Some(conclusion) = conclusion {
            return match conclusion.to_ascii_lowercase().as_str() {
                "success" => Self::Success,
                "failure" | "error" | "startup_failure" => Self::Failure,
                "pending" | "expected" => Self::Queued,
                "cancelled" | "canceled" => Self::Cancelled,
                "skipped" => Self::Skipped,
                "neutral" => Self::Neutral,
                "timed_out" | "timed-out" => Self::TimedOut,
                "action_required" | "action-required" => Self::ActionRequired,
                "stale" => Self::Stale,
                _ => Self::Unknown,
            };
        }
        match status.trim().to_ascii_lowercase().as_str() {
            "queued" | "requested" | "waiting" | "pending" => Self::Queued,
            "in_progress" | "in-progress" => Self::InProgress,
            _ => Self::Unknown,
        }
    }

    /// Whether the run is still moving, so callers know to keep polling.
    pub fn is_active(self) -> bool {
        matches!(self, Self::Queued | Self::InProgress)
    }

    pub fn is_failure(self) -> bool {
        matches!(
            self,
            Self::Failure | Self::TimedOut | Self::ActionRequired | Self::Stale
        )
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubAvailability {
    pub schema: String,
    /// True only when `gh` is installed, authenticated, and the workspace is a
    /// GitHub repository — the single flag the UI needs to decide whether to
    /// show GitHub affordances at all.
    pub available: bool,
    pub cli_installed: bool,
    pub authenticated: bool,
    pub account: Option<String>,
    pub host: Option<String>,
    pub repository: Option<String>,
    pub default_branch: Option<String>,
    pub error: Option<String>,
    pub hint: Option<String>,
}

impl GithubAvailability {
    fn unavailable(error: impl Into<String>, hint: Option<&str>) -> Self {
        Self {
            schema: GITHUB_SCHEMA_V1.into(),
            available: false,
            cli_installed: false,
            authenticated: false,
            account: None,
            host: None,
            repository: None,
            default_branch: None,
            error: Some(error.into()),
            hint: hint.map(ToOwned::to_owned),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubWorkflowRun {
    pub id: u64,
    pub number: u64,
    pub title: String,
    pub workflow_name: String,
    pub state: GithubRunState,
    pub status: String,
    pub conclusion: Option<String>,
    pub branch: String,
    pub sha: String,
    pub event: String,
    pub url: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubWorkflowStep {
    pub name: String,
    pub number: u64,
    pub state: GithubRunState,
    pub conclusion: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubWorkflowJob {
    pub id: u64,
    pub name: String,
    pub state: GithubRunState,
    pub status: String,
    pub conclusion: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub url: String,
    pub steps: Vec<GithubWorkflowStep>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubWorkflowRunDetail {
    pub run: GithubWorkflowRun,
    pub jobs: Vec<GithubWorkflowJob>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubPullRequest {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub author: Option<String>,
    pub head_ref: String,
    pub base_ref: String,
    pub url: String,
    pub is_draft: bool,
    pub checks: Option<GithubRunState>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePullRequestRequest {
    pub title: String,
    pub body: Option<String>,
    pub base: Option<String>,
    pub head: Option<String>,
    #[serde(default)]
    pub draft: bool,
}

/// Probe `gh` availability, auth, and repository identity in one shot.
///
/// Returns `Ok` with `available: false` rather than `Err` for every expected
/// "not set up" case; `Err` is reserved for genuinely unexpected failures.
pub fn github_availability(repo: &Path) -> GithubAvailability {
    github_availability_with(|args| gh_output(repo, args, GH_TIMEOUT))
}

fn github_availability_with(
    mut command: impl FnMut(&[&str]) -> Result<GhOutput>,
) -> GithubAvailability {
    let auth = match command(&["auth", "status"]) {
        Ok(output) => output,
        Err(error) => {
            // Process-spawn errors carry the actual OS cause below "start gh".
            let message = format!("{error:#}");
            // A missing binary and a logged-out CLI need different remedies.
            let looks_missing = message.contains("No such file")
                || message.contains("not found")
                || message.contains("cannot find");
            return GithubAvailability {
                cli_installed: !looks_missing,
                ..GithubAvailability::unavailable(
                    if looks_missing {
                        "The GitHub CLI (gh) is not installed.".to_string()
                    } else {
                        message
                    },
                    looks_missing.then_some(INSTALL_HINT),
                )
            };
        }
    };

    let combined = format!("{}\n{}", auth.stdout, auth.stderr);
    // `gh auth status` exits unsuccessfully if *any* configured account has
    // trouble. A stale account on another host must not disable this workspace.
    // Repository access is the authoritative availability check.
    let repository_result = command(&[
        "repo",
        "view",
        "--json",
        "nameWithOwner,defaultBranchRef,url",
    ])
    .and_then(|output| parse_gh_json("gh repo view", &output));
    let repository_host = repository_result
        .as_ref()
        .ok()
        .and_then(|value| value.get("url"))
        .and_then(Value::as_str)
        .and_then(|url| url::Url::parse(url).ok())
        .and_then(|url| url.host_str().map(ToOwned::to_owned));
    let (host, account) = parse_auth_status(&combined, repository_host.as_deref());

    // `gh repo view` fails when the directory is not a GitHub repository, which
    // is an ordinary state for a local-only workspace.
    let (repository, default_branch, repo_error) = match repository_result {
        Ok(value) => (
            value
                .get("nameWithOwner")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            value
                .get("defaultBranchRef")
                .and_then(|branch| branch.get("name"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            None,
        ),
        Err(error) => (None, None, Some(error.to_string())),
    };

    let authenticated = repository.is_some() || auth.succeeded || account.is_some();
    GithubAvailability {
        schema: GITHUB_SCHEMA_V1.into(),
        available: repository.is_some(),
        cli_installed: true,
        authenticated,
        account,
        host: repository_host.or(host),
        repository: repository.clone(),
        default_branch,
        error: repository.is_none().then(|| {
            repo_error.unwrap_or_else(|| "This workspace is not a GitHub repository.".into())
        }),
        hint: (!authenticated).then(|| LOGIN_HINT.to_string()),
    }
}

pub fn list_workflow_runs(
    repo: &Path,
    branch: Option<&str>,
    limit: usize,
) -> Result<Vec<GithubWorkflowRun>> {
    let limit = limit.clamp(1, MAX_WORKFLOW_RUNS).to_string();
    let mut args = vec![
        "run",
        "list",
        "--limit",
        &limit,
        "--json",
        "databaseId,number,displayTitle,workflowName,status,conclusion,headBranch,headSha,event,url,createdAt,updatedAt",
    ];
    let branch = branch.map(str::trim).filter(|value| !value.is_empty());
    if let Some(branch) = branch {
        args.extend(["--branch", branch]);
    }
    let value = gh_json(repo, &args, GH_TIMEOUT)?;
    let entries = value
        .as_array()
        .ok_or_else(|| anyhow!("gh run list returned an unexpected payload"))?;
    Ok(entries.iter().map(parse_workflow_run).collect())
}

pub fn workflow_run_detail(repo: &Path, run_id: u64) -> Result<GithubWorkflowRunDetail> {
    let run_id = run_id.to_string();
    let value = gh_json(
        repo,
        &[
            "run",
            "view",
            &run_id,
            "--json",
            "databaseId,number,displayTitle,workflowName,status,conclusion,headBranch,headSha,event,url,createdAt,updatedAt,jobs",
        ],
        GH_TIMEOUT,
    )?;
    let jobs = value
        .get("jobs")
        .and_then(Value::as_array)
        .map(|jobs| jobs.iter().map(parse_workflow_job).collect())
        .unwrap_or_default();
    Ok(GithubWorkflowRunDetail {
        run: parse_workflow_run(&value),
        jobs,
    })
}

/// Fetch run logs. `failed_only` uses `--log-failed`, which is dramatically
/// smaller than the full log and is what a failure triage flow wants.
pub fn workflow_run_logs(repo: &Path, run_id: u64, failed_only: bool) -> Result<String> {
    let run_id = run_id.to_string();
    let mut args = vec!["run", "view", &run_id];
    args.push(if failed_only { "--log-failed" } else { "--log" });
    let output = gh_output_with_limits(repo, &args, GH_LOG_TIMEOUT, GH_MAX_LOG_CHARS)?;
    if !output.succeeded {
        return Err(gh_error("gh run view", &output));
    }
    Ok(output.stdout)
}

pub fn rerun_workflow(repo: &Path, run_id: u64, failed_only: bool) -> Result<()> {
    let run_id = run_id.to_string();
    let mut args = vec!["run", "rerun", &run_id];
    if failed_only {
        args.push("--failed");
    }
    let output = gh_output(repo, &args, GH_TIMEOUT)?;
    if !output.succeeded {
        return Err(gh_error("gh run rerun", &output));
    }
    Ok(())
}

pub fn list_pull_requests(repo: &Path, limit: usize) -> Result<Vec<GithubPullRequest>> {
    let limit = limit.clamp(1, MAX_PULL_REQUESTS).to_string();
    let value = gh_json(
        repo,
        &[
            "pr",
            "list",
            "--limit",
            &limit,
            "--json",
            "number,title,state,author,headRefName,baseRefName,url,isDraft,createdAt,updatedAt,statusCheckRollup",
        ],
        GH_TIMEOUT,
    )?;
    let entries = value
        .as_array()
        .ok_or_else(|| anyhow!("gh pr list returned an unexpected payload"))?;
    Ok(entries.iter().map(parse_pull_request).collect())
}

/// The pull request for `branch`, or `None` when the branch has none yet.
pub fn pull_request_for_branch(repo: &Path, branch: &str) -> Result<Option<GithubPullRequest>> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Ok(None);
    }
    let value = match gh_json(
        repo,
        &[
            "pr",
            "view",
            branch,
            "--json",
            "number,title,state,author,headRefName,baseRefName,url,isDraft,createdAt,updatedAt,statusCheckRollup",
        ],
        GH_TIMEOUT,
    ) {
        Ok(value) => value,
        // "no pull requests found" is a normal answer, not an error.
        Err(error) if error.to_string().to_ascii_lowercase().contains("no pull requests") => {
            return Ok(None)
        }
        Err(error) => return Err(error),
    };
    Ok(Some(parse_pull_request(&value)))
}

pub fn create_pull_request(
    repo: &Path,
    request: &CreatePullRequestRequest,
) -> Result<GithubPullRequest> {
    let title = request.title.trim();
    if title.is_empty() {
        return Err(anyhow!("a pull request title is required"));
    }
    let body = request.body.as_deref().unwrap_or("").trim().to_string();
    let mut args = vec!["pr", "create", "--title", title, "--body", &body];
    if let Some(base) = request
        .base
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        args.extend(["--base", base]);
    }
    let head = request
        .head
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(head) = head {
        args.extend(["--head", head]);
    }
    if request.draft {
        args.push("--draft");
    }
    let output = gh_output(repo, &args, GH_TIMEOUT)?;
    finish_pull_request_creation(request, &output, |url| pull_request_for_branch(repo, url))
}

fn finish_pull_request_creation(
    request: &CreatePullRequestRequest,
    output: &GhOutput,
    read_back: impl FnOnce(&str) -> Result<Option<GithubPullRequest>>,
) -> Result<GithubPullRequest> {
    if !output.succeeded {
        return Err(gh_error("gh pr create", output));
    }
    // Once gh confirms creation, a failing follow-up read must not invite the
    // user to repeat the mutation. Enrich the confirmed result when possible.
    let (url, number) = output
        .stdout
        .lines()
        .map(str::trim)
        .find_map(|line| pull_request_number_from_url(line).map(|number| (line, number)))
        .ok_or_else(|| anyhow!("gh pr create did not report a pull request URL"))?;
    if let Ok(Some(pull_request)) = read_back(url) {
        return Ok(pull_request);
    }
    Ok(GithubPullRequest {
        number,
        title: request.title.trim().to_string(),
        state: "OPEN".to_string(),
        author: None,
        head_ref: request
            .head
            .as_deref()
            .unwrap_or_default()
            .trim()
            .to_string(),
        base_ref: request
            .base
            .as_deref()
            .unwrap_or_default()
            .trim()
            .to_string(),
        url: url.to_string(),
        is_draft: request.draft,
        checks: None,
        created_at: None,
        updated_at: None,
    })
}

fn pull_request_number_from_url(value: &str) -> Option<u64> {
    let url = url::Url::parse(value).ok()?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let parts: Vec<_> = url.path_segments()?.collect();
    match parts.as_slice() {
        [owner, repository, "pull", number]
            if !owner.is_empty()
                && !repository.is_empty()
                && !number.is_empty()
                && number.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            number.parse::<u64>().ok().filter(|number| *number > 0)
        }
        _ => None,
    }
}

fn parse_workflow_run(value: &Value) -> GithubWorkflowRun {
    let status = string_field(value, "status").unwrap_or_default();
    let conclusion = string_field(value, "conclusion").filter(|value| !value.is_empty());
    GithubWorkflowRun {
        id: u64_field(value, "databaseId").unwrap_or_default(),
        number: u64_field(value, "number").unwrap_or_default(),
        title: string_field(value, "displayTitle").unwrap_or_default(),
        workflow_name: string_field(value, "workflowName").unwrap_or_default(),
        state: GithubRunState::from_status_and_conclusion(&status, conclusion.as_deref()),
        status,
        conclusion,
        branch: string_field(value, "headBranch").unwrap_or_default(),
        sha: string_field(value, "headSha").unwrap_or_default(),
        event: string_field(value, "event").unwrap_or_default(),
        url: string_field(value, "url").unwrap_or_default(),
        created_at: timestamp_field(value, "createdAt"),
        updated_at: timestamp_field(value, "updatedAt"),
    }
}

fn parse_workflow_job(value: &Value) -> GithubWorkflowJob {
    let status = string_field(value, "status").unwrap_or_default();
    let conclusion = string_field(value, "conclusion").filter(|value| !value.is_empty());
    let steps = value
        .get("steps")
        .and_then(Value::as_array)
        .map(|steps| steps.iter().map(parse_workflow_step).collect())
        .unwrap_or_default();
    GithubWorkflowJob {
        id: u64_field(value, "databaseId").unwrap_or_default(),
        name: string_field(value, "name").unwrap_or_default(),
        state: GithubRunState::from_status_and_conclusion(&status, conclusion.as_deref()),
        status,
        conclusion,
        started_at: timestamp_field(value, "startedAt"),
        completed_at: timestamp_field(value, "completedAt"),
        url: string_field(value, "url").unwrap_or_default(),
        steps,
    }
}

fn parse_workflow_step(value: &Value) -> GithubWorkflowStep {
    let status = string_field(value, "status").unwrap_or_default();
    let conclusion = string_field(value, "conclusion").filter(|value| !value.is_empty());
    GithubWorkflowStep {
        name: string_field(value, "name").unwrap_or_default(),
        number: u64_field(value, "number").unwrap_or_default(),
        state: GithubRunState::from_status_and_conclusion(&status, conclusion.as_deref()),
        conclusion,
    }
}

fn parse_pull_request(value: &Value) -> GithubPullRequest {
    GithubPullRequest {
        number: u64_field(value, "number").unwrap_or_default(),
        title: string_field(value, "title").unwrap_or_default(),
        state: string_field(value, "state").unwrap_or_default(),
        author: value
            .get("author")
            .and_then(|author| author.get("login"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        head_ref: string_field(value, "headRefName").unwrap_or_default(),
        base_ref: string_field(value, "baseRefName").unwrap_or_default(),
        url: string_field(value, "url").unwrap_or_default(),
        is_draft: value
            .get("isDraft")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        checks: parse_status_check_rollup(value.get("statusCheckRollup")),
        created_at: timestamp_field(value, "createdAt"),
        updated_at: timestamp_field(value, "updatedAt"),
    }
}

/// Collapse a PR's check rollup into one state: any failure wins, then any
/// still-running check. Cancelled and unknown outcomes never count as success.
fn parse_status_check_rollup(value: Option<&Value>) -> Option<GithubRunState> {
    let checks = value?.as_array()?;
    if checks.is_empty() {
        return None;
    }
    let mut result = GithubRunState::Success;
    for check in checks {
        let status = string_field(check, "status").unwrap_or_default();
        let conclusion = string_field(check, "conclusion")
            .filter(|value| !value.trim().is_empty())
            // Non-Actions checks report `state` instead of `conclusion`.
            .or_else(|| string_field(check, "state").filter(|value| !value.trim().is_empty()));
        let state = GithubRunState::from_status_and_conclusion(&status, conclusion.as_deref());
        if state.is_failure() {
            return Some(state);
        }
        // An unfinished, cancelled, or unrecognized check is not a passing
        // check. Keep these visible even when every other check succeeded.
        result = match (result, state) {
            (GithubRunState::InProgress, _) => GithubRunState::InProgress,
            (_, state) if state.is_active() => GithubRunState::InProgress,
            (GithubRunState::Cancelled, _) | (_, GithubRunState::Cancelled) => {
                GithubRunState::Cancelled
            }
            (GithubRunState::Unknown, _) | (_, GithubRunState::Unknown) => GithubRunState::Unknown,
            _ => result,
        };
    }
    Some(result)
}

fn parse_auth_status(output: &str, target_host: Option<&str>) -> (Option<String>, Option<String>) {
    let mut accounts: Vec<(&str, &str, Option<bool>)> = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        // gh prints: "✓ Logged in to github.com account NAME (keyring)".
        // Older builds print "... as NAME (...)".
        if let Some((_, rest)) = line.split_once("Logged in to ") {
            let mut parts = rest.split_whitespace();
            if let (Some(host), Some("account" | "as"), Some(account)) =
                (parts.next(), parts.next(), parts.next())
            {
                accounts.push((host, account, None));
            }
        } else if let Some((_, active)) = line.split_once("Active account:") {
            if let Some(account) = accounts.last_mut() {
                account.2 = match active.trim() {
                    "true" => Some(true),
                    "false" => Some(false),
                    _ => None,
                };
            }
        }
    }
    let eligible = |entry: &&(&str, &str, Option<bool>)| {
        target_host.map_or(true, |host| host.eq_ignore_ascii_case(entry.0))
    };
    let selected = accounts
        .iter()
        .filter(eligible)
        .find(|entry| entry.2 == Some(true))
        .or_else(|| {
            accounts
                .iter()
                .filter(eligible)
                .find(|entry| entry.2.is_none())
        });
    selected
        .map(|(host, account, _)| (Some((*host).to_string()), Some((*account).to_string())))
        .unwrap_or_default()
}

fn first_meaningful_line(output: &str) -> Option<String> {
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToOwned::to_owned)
}

fn string_field(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn u64_field(value: &Value, field: &str) -> Option<u64> {
    value.get(field).and_then(Value::as_u64)
}

/// gh emits Go zero-value timestamps for unstarted work; treat those as absent.
fn timestamp_field(value: &Value, field: &str) -> Option<String> {
    string_field(value, field).filter(|value| !value.is_empty() && !value.starts_with("0001-01-01"))
}

struct GhOutput {
    stdout: String,
    stderr: String,
    succeeded: bool,
}

fn gh_error(label: &str, output: &GhOutput) -> anyhow::Error {
    let detail = first_meaningful_line(&output.stderr)
        .or_else(|| first_meaningful_line(&output.stdout))
        .unwrap_or_else(|| "no output".into());
    anyhow!("{label} failed: {detail}")
}

fn gh_json(repo: &Path, args: &[&str], timeout: Duration) -> Result<Value> {
    let output = gh_output(repo, args, timeout)?;
    parse_gh_json(&format!("gh {}", args.join(" ")), &output)
}

fn parse_gh_json(label: &str, output: &GhOutput) -> Result<Value> {
    if !output.succeeded {
        return Err(gh_error(label, output));
    }
    serde_json::from_str(&output.stdout)
        .map_err(|error| anyhow!("could not read gh JSON output: {error}"))
}

fn gh_output(repo: &Path, args: &[&str], timeout: Duration) -> Result<GhOutput> {
    gh_output_with_limits(repo, args, timeout, GH_MAX_STDOUT_CHARS)
}

fn gh_output_with_limits(
    repo: &Path,
    args: &[&str],
    timeout: Duration,
    max_stdout_chars: usize,
) -> Result<GhOutput> {
    let mut request = ExecutionRequest::new("gh");
    request.args = args.iter().copied().map(OsString::from).collect();
    request.current_dir = Some(repo.to_path_buf());
    request.timeout = timeout;
    request.max_stdout_chars = max_stdout_chars;
    request.max_stderr_chars = GH_MAX_STDERR_CHARS;
    request.env.push((
        OsString::from("PATH"),
        Some(OsString::from(augmented_gui_path())),
    ));
    // gh opens a pager for some subcommands when it thinks it has a TTY.
    request
        .env
        .push((OsString::from("GH_PAGER"), Some(OsString::from("cat"))));
    request
        .env
        .push((OsString::from("NO_COLOR"), Some(OsString::from("1"))));

    let outcome = run_command(request, CancellationToken::default(), |_| {})?;
    match outcome.termination {
        ExecutionTermination::Exited { .. } => Ok(GhOutput {
            stdout: redact_secrets(&outcome.stdout),
            stderr: redact_secrets(&outcome.stderr),
            succeeded: outcome.succeeded(),
        }),
        ExecutionTermination::TimedOut => {
            Err(anyhow!("gh timed out after {} seconds", timeout.as_secs()))
        }
        ExecutionTermination::Cancelled => Err(anyhow!("gh was cancelled")),
        ExecutionTermination::Inactive => Err(anyhow!("gh stopped responding")),
        ExecutionTermination::OutputLimit => Err(anyhow!("gh exceeded its output limit")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gh_result(stdout: &str, stderr: &str, succeeded: bool) -> GhOutput {
        GhOutput {
            stdout: stdout.to_string(),
            stderr: stderr.to_string(),
            succeeded,
        }
    }

    #[test]
    fn availability_uses_repository_access_despite_unrelated_auth_failure() {
        let mut calls = 0;
        let availability = github_availability_with(|args| {
            calls += 1;
            Ok(match args[0] {
                "auth" => gh_result(
                    "",
                    "github.com\n  ✓ Logged in to github.com account old (keyring)\n  - Active account: false\n  ✓ Logged in to github.com account current (keyring)\n  - Active account: true\ngithub.corp.example\n  X Failed to log in with expired credentials",
                    false,
                ),
                "repo" => gh_result(
                    r#"{"nameWithOwner":"owner/repo","defaultBranchRef":{"name":"main"},"url":"https://github.com/owner/repo"}"#,
                    "",
                    true,
                ),
                _ => panic!("unexpected GitHub command"),
            })
        });
        assert_eq!(calls, 2);
        assert!(availability.available);
        assert!(availability.authenticated);
        assert_eq!(availability.account.as_deref(), Some("current"));
        assert_eq!(availability.host.as_deref(), Some("github.com"));
        assert_eq!(availability.repository.as_deref(), Some("owner/repo"));
        assert!(availability.error.is_none());
        assert!(availability.hint.is_none());
    }

    #[test]
    fn availability_selects_the_repository_host_account() {
        let availability = github_availability_with(|args| {
            Ok(if args[0] == "auth" {
                gh_result(
                    "✓ Logged in to github.com account personal (keyring)\n- Active account: true\n✓ Logged in to git.corp.example account work (keyring)\n- Active account: true",
                    "",
                    true,
                )
            } else {
                gh_result(
                    r#"{"nameWithOwner":"team/repo","url":"https://git.corp.example/team/repo"}"#,
                    "",
                    true,
                )
            })
        });
        assert!(availability.available);
        assert_eq!(availability.host.as_deref(), Some("git.corp.example"));
        assert_eq!(availability.account.as_deref(), Some("work"));
    }

    #[test]
    fn availability_does_not_require_human_readable_account_output() {
        let availability = github_availability_with(|args| {
            Ok(if args[0] == "auth" {
                gh_result("", "", true)
            } else {
                gh_result(
                    r#"{"nameWithOwner":"owner/repo","url":"https://github.com/owner/repo"}"#,
                    "",
                    true,
                )
            })
        });
        assert!(availability.available);
        assert!(availability.authenticated);
        assert!(availability.account.is_none());
    }

    #[test]
    fn availability_keeps_repository_errors_and_login_hints() {
        let availability = github_availability_with(|args| {
            Ok(if args[0] == "auth" {
                gh_result("", "You are not logged into any GitHub hosts.", false)
            } else {
                gh_result(
                    "",
                    "To get started with GitHub CLI, please run: gh auth login",
                    false,
                )
            })
        });
        assert!(!availability.available);
        assert!(availability.cli_installed);
        assert!(!availability.authenticated);
        assert_eq!(availability.hint.as_deref(), Some(LOGIN_HINT));
        assert!(availability.error.unwrap().contains("gh auth login"));
    }

    #[test]
    fn availability_does_not_call_a_timeout_a_missing_installation() {
        let availability =
            github_availability_with(|_| Err(anyhow!("gh timed out after 30 seconds")));
        assert!(!availability.available);
        assert!(availability.cli_installed);
        assert!(availability.hint.is_none());

        let missing = github_availability_with(|_| {
            Err(
                anyhow::Error::new(std::io::Error::from(std::io::ErrorKind::NotFound))
                    .context("start gh"),
            )
        });
        assert!(!missing.cli_installed);
        assert_eq!(missing.hint.as_deref(), Some(INSTALL_HINT));
    }

    #[test]
    fn created_pull_request_survives_follow_up_read_failure() {
        let request = CreatePullRequestRequest {
            title: " Fix reliability ".into(),
            draft: true,
            ..Default::default()
        };
        let output = gh_result("https://git.corp.example/team/repo/pull/123\n", "", true);
        for missing in [false, true] {
            let pull_request = finish_pull_request_creation(&request, &output, |url| {
                assert_eq!(url, "https://git.corp.example/team/repo/pull/123");
                if missing {
                    Ok(None)
                } else {
                    Err(anyhow!("connection reset"))
                }
            })
            .unwrap();
            assert_eq!(pull_request.number, 123);
            assert_eq!(pull_request.title, "Fix reliability");
            assert!(pull_request.is_draft);
            assert_eq!(pull_request.state, "OPEN");
            assert_eq!(pull_request.head_ref, "");
            assert_eq!(pull_request.base_ref, "");
            assert!(pull_request.checks.is_none());
        }
    }

    #[test]
    fn created_pull_request_uses_enriched_record_when_available() {
        let request = CreatePullRequestRequest::default();
        let output = gh_result("https://github.com/team/repo/pull/123", "", true);
        let pull_request = finish_pull_request_creation(&request, &output, |_| {
            Ok(Some(parse_pull_request(&serde_json::json!({
                "number": 123, "title": "Server title", "author": {"login": "author"},
                "headRefName": "feature", "baseRefName": "main"
            }))))
        })
        .unwrap();
        assert_eq!(pull_request.author.as_deref(), Some("author"));
        assert_eq!(pull_request.head_ref, "feature");
        assert_eq!(pull_request.base_ref, "main");
    }

    #[test]
    fn creation_requires_success_and_an_unambiguous_pull_request_url() {
        let request = CreatePullRequestRequest::default();
        let output = gh_result(
            "https://github.com/team/repo/pull/123",
            "permission denied",
            false,
        );
        assert!(finish_pull_request_creation(&request, &output, |_| {
            panic!("failed mutation must not be read back")
        })
        .unwrap_err()
        .to_string()
        .contains("permission denied"));

        for value in [
            "https://github.com/team/repo",
            "https://github.com/team/repo/issues/123",
            "https://github.com/team/repo/pull/0",
            "https://github.com/team/repo/pull/not-a-number",
            "https://github.com/team/repo/pull/+123",
            "https://github.com/team/repo/pull/123/files",
            "https://github.com/team/repo/pull/123?next=other",
            "https://user:password@github.com/team/repo/pull/123",
            "https://github.com//repo/pull/123",
            "not a URL",
        ] {
            let output = gh_result(value, "", true);
            assert!(
                finish_pull_request_creation(&request, &output, |_| {
                    panic!("unconfirmed mutation must not be read back")
                })
                .is_err(),
                "{value}"
            );
        }
    }

    #[test]
    fn status_checks_do_not_report_unfinished_or_unsuccessful_checks_as_passing() {
        for (check, expected) in [
            (
                serde_json::json!({"state": "PENDING"}),
                GithubRunState::InProgress,
            ),
            (
                serde_json::json!({"state": "EXPECTED"}),
                GithubRunState::InProgress,
            ),
            (
                serde_json::json!({"state": "ERROR"}),
                GithubRunState::Failure,
            ),
            (
                serde_json::json!({"status": "COMPLETED", "conclusion": "CANCELLED"}),
                GithubRunState::Cancelled,
            ),
            (
                serde_json::json!({"status": "COMPLETED", "conclusion": "STARTUP_FAILURE"}),
                GithubRunState::Failure,
            ),
            (
                serde_json::json!({"status": "COMPLETED", "conclusion": null}),
                GithubRunState::Unknown,
            ),
            (
                serde_json::json!({"state": "FUTURE_STATE"}),
                GithubRunState::Unknown,
            ),
        ] {
            for checks in [
                serde_json::json!([{"state": "SUCCESS"}, check]),
                serde_json::json!([check, {"state": "SUCCESS"}]),
            ] {
                assert_eq!(
                    parse_status_check_rollup(Some(&checks)),
                    Some(expected),
                    "{checks}"
                );
            }
        }
    }

    #[test]
    fn run_state_prefers_conclusion_over_status() {
        assert_eq!(
            GithubRunState::from_status_and_conclusion("completed", Some("failure")),
            GithubRunState::Failure
        );
        assert_eq!(
            GithubRunState::from_status_and_conclusion("in_progress", None),
            GithubRunState::InProgress
        );
        assert_eq!(
            GithubRunState::from_status_and_conclusion("queued", Some("")),
            GithubRunState::Queued
        );
    }

    #[test]
    fn run_state_classifies_activity_and_failure() {
        assert!(GithubRunState::Queued.is_active());
        assert!(!GithubRunState::Success.is_active());
        assert!(GithubRunState::TimedOut.is_failure());
        assert!(!GithubRunState::Skipped.is_failure());
    }

    #[test]
    fn auth_status_parses_current_and_legacy_phrasing() {
        let (host, account) =
            parse_auth_status("✓ Logged in to github.com account octocat (keyring)", None);
        assert_eq!(host.as_deref(), Some("github.com"));
        assert_eq!(account.as_deref(), Some("octocat"));

        let (host, account) =
            parse_auth_status("✓ Logged in to github.com as octocat (oauth)", None);
        assert_eq!(host.as_deref(), Some("github.com"));
        assert_eq!(account.as_deref(), Some("octocat"));
    }

    #[test]
    fn auth_status_reports_nothing_when_logged_out() {
        let (host, account) = parse_auth_status("You are not logged into any GitHub hosts.", None);
        assert!(host.is_none());
        assert!(account.is_none());
    }

    #[test]
    fn workflow_run_parses_gh_payload() {
        let value = serde_json::json!({
            "databaseId": 42_u64,
            "number": 7_u64,
            "displayTitle": "Fix the thing",
            "workflowName": "CI",
            "status": "completed",
            "conclusion": "failure",
            "headBranch": "main",
            "headSha": "abc123",
            "event": "push",
            "url": "https://github.com/o/r/actions/runs/42",
            "createdAt": "2026-07-25T10:00:00Z",
            "updatedAt": "0001-01-01T00:00:00Z"
        });
        let run = parse_workflow_run(&value);
        assert_eq!(run.id, 42);
        assert_eq!(run.state, GithubRunState::Failure);
        assert_eq!(run.created_at.as_deref(), Some("2026-07-25T10:00:00Z"));
        // Go zero-value timestamps are dropped rather than shown as year 1.
        assert!(run.updated_at.is_none());
    }

    #[test]
    fn status_check_rollup_collapses_to_worst_state() {
        let failing = serde_json::json!([
            {"status": "completed", "conclusion": "success"},
            {"status": "completed", "conclusion": "failure"}
        ]);
        assert_eq!(
            parse_status_check_rollup(Some(&failing)),
            Some(GithubRunState::Failure)
        );

        let running = serde_json::json!([
            {"status": "completed", "conclusion": "success"},
            {"status": "in_progress", "conclusion": null}
        ]);
        assert_eq!(
            parse_status_check_rollup(Some(&running)),
            Some(GithubRunState::InProgress)
        );

        let passing = serde_json::json!([{"status": "completed", "conclusion": "success"}]);
        assert_eq!(
            parse_status_check_rollup(Some(&passing)),
            Some(GithubRunState::Success)
        );

        assert_eq!(
            parse_status_check_rollup(Some(&serde_json::json!([]))),
            None
        );
        assert_eq!(parse_status_check_rollup(None), None);
    }

    #[test]
    fn status_check_rollup_reads_non_actions_state_field() {
        // Non-Actions checks (e.g. external CI) report `state`, not `conclusion`.
        let value = serde_json::json!([{"status": "", "state": "FAILURE"}]);
        assert_eq!(
            parse_status_check_rollup(Some(&value)),
            Some(GithubRunState::Failure)
        );
    }

    #[test]
    fn pull_request_parses_author_login_and_draft() {
        let value = serde_json::json!({
            "number": 15_u64,
            "title": "Add adapters",
            "state": "OPEN",
            "author": {"login": "wytzeh197"},
            "headRefName": "feature",
            "baseRefName": "main",
            "url": "https://github.com/o/r/pull/15",
            "isDraft": true,
            "statusCheckRollup": [{"status": "completed", "conclusion": "success"}]
        });
        let pr = parse_pull_request(&value);
        assert_eq!(pr.number, 15);
        assert_eq!(pr.author.as_deref(), Some("wytzeh197"));
        assert!(pr.is_draft);
        assert_eq!(pr.checks, Some(GithubRunState::Success));
    }
}
