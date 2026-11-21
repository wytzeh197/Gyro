//! Detect and apply updates for the provider executables Gyro launches.

use crate::cli_path::augmented_gui_path;
use crate::execution::{
    run_command, CancellationToken, ExecutionOutcome, ExecutionRequest, ExecutionTermination,
};
use anyhow::{anyhow, bail, Context, Result};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::Duration;

const CLI_VERSION_TIMEOUT: Duration = Duration::from_secs(8);
const CLI_CHECK_TIMEOUT: Duration = Duration::from_secs(25);
const CLI_UPDATE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const CLI_OUTPUT_CHARS: usize = 64 * 1024;
const GROK_NATIVE_INSTALLER: (&str, &str) = ("GROK_INSTALLER", "internal");

// Avoid checking a partially replaced CLI or running two package managers
// against the same global prefix at once.
static CLI_UPDATES: RwLock<()> = RwLock::new(());

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliUpdateOffer {
    pub provider_id: String,
    pub display_name: String,
    pub program: String,
    pub current_version: Option<String>,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub check_source: String,
    pub update_command: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliUpdateCheckReport {
    pub checked_at: String,
    pub offers: Vec<CliUpdateOffer>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliUpdateApplyResult {
    pub provider_id: String,
    pub display_name: String,
    pub ok: bool,
    pub message: String,
}

struct CliUpdateSpec {
    provider_id: &'static str,
    display_name: &'static str,
    program: &'static str,
    npm_package: Option<&'static str>,
    native_check_args: Option<&'static [&'static str]>,
    native_update_args: Option<&'static [&'static str]>,
}

const CLI_UPDATE_SPECS: &[CliUpdateSpec] = &[
    CliUpdateSpec {
        provider_id: "anthropic",
        display_name: "Claude Code",
        program: "claude",
        npm_package: Some("@anthropic-ai/claude-code"),
        native_check_args: None,
        native_update_args: Some(&["update"]),
    },
    CliUpdateSpec {
        provider_id: "openai",
        display_name: "Codex",
        program: "codex",
        npm_package: Some("@openai/codex"),
        native_check_args: None,
        native_update_args: Some(&["update"]),
    },
    CliUpdateSpec {
        provider_id: "xai",
        display_name: "Grok",
        program: "grok",
        npm_package: Some("@xai-official/grok"),
        native_check_args: Some(&["update", "--check", "--json"]),
        native_update_args: Some(&["update"]),
    },
    CliUpdateSpec {
        provider_id: "gemini",
        display_name: "Gemini CLI",
        program: "gemini",
        npm_package: Some("@google/gemini-cli"),
        native_check_args: None,
        native_update_args: None,
    },
];

enum CliCheck {
    Unavailable(String),
    Current(Version),
    Available(PendingUpdate),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeUpdateCheck {
    update_available: bool,
    latest_version: Option<String>,
    installer: Option<String>,
    error: Option<String>,
}

struct PendingUpdate {
    executable: PathBuf,
    resolved_executable: PathBuf,
    current: Version,
    latest: Option<Version>,
    check_source: &'static str,
    command: UpdateCommand,
}

struct UpdateCommand {
    program: PathBuf,
    args: Vec<OsString>,
    search_path: String,
    env: Option<(&'static str, &'static str)>,
}

impl PendingUpdate {
    fn offer(&self, spec: &CliUpdateSpec) -> CliUpdateOffer {
        let mut update_command = Vec::new();
        if let Some((key, value)) = self.command.env {
            update_command.extend(["env".into(), format!("{key}={value}")]);
        }
        update_command.extend(
            std::iter::once(self.command.program.as_os_str())
                .chain(self.command.args.iter().map(OsString::as_os_str))
                .map(|part| part.to_string_lossy().into_owned()),
        );
        CliUpdateOffer {
            provider_id: spec.provider_id.into(),
            display_name: spec.display_name.into(),
            program: spec.program.into(),
            current_version: Some(self.current.to_string()),
            latest_version: self.latest.as_ref().map(ToString::to_string),
            update_available: true,
            check_source: self.check_source.into(),
            update_command,
        }
    }
}

/// Scan installed provider CLIs for available updates.
pub fn check_cli_updates() -> Result<CliUpdateCheckReport> {
    let _guard = CLI_UPDATES
        .try_read()
        .map_err(|_| anyhow!("A CLI update is already running."))?;
    check_cli_updates_on_path(&augmented_gui_path(), grok_home().as_deref())
}

fn check_cli_updates_on_path(
    search_path: &str,
    grok_home: Option<&Path>,
) -> Result<CliUpdateCheckReport> {
    let checks = std::thread::scope(|scope| {
        CLI_UPDATE_SPECS
            .iter()
            .map(|spec| {
                (
                    spec,
                    scope.spawn(move || check_one_cli(spec, search_path, grok_home)),
                )
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|(spec, worker)| {
                let check = worker
                    .join()
                    .unwrap_or_else(|_| Err(anyhow!("Update check worker stopped")));
                (spec, check)
            })
            .collect::<Vec<_>>()
    });
    let mut offers = Vec::new();
    let mut failures = Vec::new();
    for (spec, check) in checks {
        match check {
            Ok(CliCheck::Available(update)) => offers.push(update.offer(spec)),
            Ok(_) => {}
            Err(error) => failures.push(format!("{}: {error:#}", spec.display_name)),
        }
    }
    // A failed probe is inconclusive. If there are no fresh offers, let the
    // caller keep its last known ones instead of replacing them with an empty list.
    if offers.is_empty() && !failures.is_empty() {
        bail!("{}", summarize_failure(&failures.join("\n")));
    }
    Ok(CliUpdateCheckReport {
        checked_at: chrono::Utc::now().to_rfc3339(),
        offers,
    })
}

/// Apply updates for the given provider ids (or all pending if empty).
pub fn apply_cli_updates(provider_ids: &[String]) -> Result<Vec<CliUpdateApplyResult>> {
    let _guard = CLI_UPDATES
        .write()
        .map_err(|_| anyhow!("The CLI update worker stopped unexpectedly."))?;
    Ok(apply_cli_updates_on_path(
        provider_ids,
        &augmented_gui_path(),
        grok_home().as_deref(),
    ))
}

fn apply_cli_updates_on_path(
    provider_ids: &[String],
    search_path: &str,
    grok_home: Option<&Path>,
) -> Vec<CliUpdateApplyResult> {
    let only_pending = provider_ids.is_empty();
    let ids: Vec<&str> = if only_pending {
        CLI_UPDATE_SPECS
            .iter()
            .map(|spec| spec.provider_id)
            .collect()
    } else {
        provider_ids.iter().map(String::as_str).collect()
    };
    let mut seen = HashSet::new();
    let mut results = Vec::new();
    for id in ids.into_iter().filter(|id| seen.insert(*id)) {
        let Some(spec) = CLI_UPDATE_SPECS.iter().find(|spec| spec.provider_id == id) else {
            results.push(CliUpdateApplyResult {
                provider_id: id.into(),
                display_name: id.into(),
                ok: false,
                message: "Gyro has no update route for this provider CLI.".into(),
            });
            continue;
        };
        let result = match check_one_cli(spec, search_path, grok_home) {
            Ok(CliCheck::Available(update)) => apply_one_cli_update(spec, update, search_path),
            Ok(_) if only_pending => continue,
            Ok(CliCheck::Current(version)) => Ok(already_current(spec, &version)),
            Ok(CliCheck::Unavailable(reason)) => Err(anyhow!(reason)),
            Err(error) => Err(error),
        };
        results.push(CliUpdateApplyResult {
            provider_id: id.into(),
            display_name: spec.display_name.into(),
            ok: result.is_ok(),
            message: result.unwrap_or_else(|error| summarize_failure(&format!("{error:#}"))),
        });
    }
    results
}

fn check_one_cli(
    spec: &CliUpdateSpec,
    search_path: &str,
    grok_home: Option<&Path>,
) -> Result<CliCheck> {
    let Some(executable) = find_on_path(spec.program, search_path) else {
        return Ok(CliCheck::Unavailable(format!(
            "Gyro cannot find {} on its PATH.",
            spec.program
        )));
    };
    let resolved_executable = executable
        .canonicalize()
        .context("Resolve CLI executable")?;
    let npm_install = spec.npm_package.and_then(|package| {
        npm_prefix_for(&resolved_executable, spec.program, package).map(|prefix| (package, prefix))
    });
    if npm_install.is_none() && spec.native_update_args.is_none() {
        return Ok(CliCheck::Unavailable(format!(
            "Gyro could not identify a supported update route for {} at {}.",
            spec.display_name,
            executable.display()
        )));
    }

    let current = installed_version(spec, &executable, search_path)?;
    let (latest, check_source, command) = if let Some((package, prefix)) = npm_install {
        // A per-user prefix need not contain npm itself. Use the npm beside the
        // installation when available and pass the prefix explicitly either way.
        let npm_path = prepend_path(&prefix.join("bin"), search_path);
        let npm = find_on_path("npm", &npm_path).context("Gyro cannot find npm on its PATH")?;
        let latest = npm_latest_version(&npm, package, Some(&prefix), &npm_path)?;
        let command = UpdateCommand {
            program: npm,
            args: vec![
                "install".into(),
                "--global".into(),
                "--prefix".into(),
                prefix.into_os_string(),
                format!("{package}@{latest}").into(),
            ],
            search_path: npm_path,
            env: None,
        };
        (Some(latest), "npm-view", command)
    } else {
        let mut env = None;
        let (latest, check_source) = if let Some(args) = spec.native_check_args {
            let mut check = native_update_check(&executable, args, search_path, env)?;
            if spec.provider_id == "xai"
                && check.installer.as_deref() == Some("npm")
                && grok_home.is_some_and(|home| {
                    grok_npm_link_conflict(home, &resolved_executable, search_path)
                })
            {
                env = Some(GROK_NATIVE_INSTALLER);
                check = native_update_check(&executable, args, search_path, env)?;
                if check.installer.as_deref() != Some(GROK_NATIVE_INSTALLER.1) {
                    bail!("Grok did not select its native installer after detecting an npm link conflict.");
                }
            }
            if let Some(error) = check.error {
                bail!("Grok could not check for an update: {error}");
            }
            if !check.update_available {
                return Ok(CliCheck::Current(current));
            }
            let latest = check
                .latest_version
                .as_deref()
                .map(|value| {
                    parse_version(value).context("Native update check returned an invalid version")
                })
                .transpose()?;
            (latest, "native")
        } else {
            let package = spec.npm_package.context("No release source for this CLI")?;
            let npm = find_on_path("npm", search_path)
                .context("Gyro cannot find npm to check the latest version")?;
            (
                Some(npm_latest_version(&npm, package, None, search_path)?),
                "npm-view",
            )
        };
        let command = UpdateCommand {
            program: executable.clone(),
            args: spec
                .native_update_args
                .unwrap_or_default()
                .iter()
                .map(OsString::from)
                .collect(),
            search_path: search_path.into(),
            env,
        };
        (latest, check_source, command)
    };

    if latest
        .as_ref()
        .is_some_and(|latest| at_least(&current, latest))
    {
        return Ok(CliCheck::Current(current));
    }

    Ok(CliCheck::Available(PendingUpdate {
        executable,
        resolved_executable,
        current,
        latest,
        check_source,
        command,
    }))
}

fn apply_one_cli_update(
    spec: &CliUpdateSpec,
    update: PendingUpdate,
    search_path: &str,
) -> Result<String> {
    // Recheck just before writing. A terminal or the provider's auto-updater
    // can replace the executable while the registry lookup is in flight.
    let executable = find_on_path(spec.program, search_path)
        .context("The CLI disappeared during the update check")?;
    let before = installed_version(spec, &executable, search_path)?;
    if update
        .latest
        .as_ref()
        .is_some_and(|latest| at_least(&before, latest))
    {
        return Ok(already_current(spec, &before));
    }
    if executable != update.executable
        || executable.canonicalize()? != update.resolved_executable
        || before != update.current
    {
        bail!(
            "{} changed during the update check. Check for updates again.",
            spec.display_name
        );
    }

    let command = update.command;
    let outcome = run_cli_with_path(
        &command.program,
        &command.args,
        CLI_UPDATE_TIMEOUT,
        &command.search_path,
        command.env,
    );
    // A failed updater can still have replaced part of the install.
    crate::provider_health::invalidate_provider_health_cache();
    let output = successful_output(&command.program, outcome?)?;
    let observed = find_on_path(spec.program, search_path)
        .and_then(|path| installed_version(spec, &path, search_path).ok())
        .with_context(|| {
            format!(
                "{} finished its update command, but Gyro could not read the version it uses",
                spec.display_name
            )
        })?;
    if let Some(latest) = update.latest {
        if !at_least(&observed, &latest) {
            bail!(
                "{} finished its update command, but Gyro still uses {} (expected {})",
                spec.display_name,
                observed,
                latest
            );
        }
    } else if !observed.cmp_precedence(&before).is_gt() {
        bail!(
            "{} finished its update command, but Gyro still uses {}",
            spec.display_name,
            observed
        );
    }

    let verification = format!("{} updated to {observed}", spec.display_name);
    let summary = join_output(&output)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(4)
        .collect::<Vec<_>>()
        .join(" · ")
        .chars()
        .take(280)
        .collect::<String>();
    if summary.is_empty() {
        Ok(verification)
    } else {
        Ok(format!("{verification} · {summary}"))
    }
}

fn already_current(spec: &CliUpdateSpec, version: &Version) -> String {
    format!("{} is already up to date ({version})", spec.display_name)
}

fn at_least(observed: &Version, expected: &Version) -> bool {
    !observed.cmp_precedence(expected).is_lt()
}

fn native_update_check(
    executable: &Path,
    args: &[&str],
    search_path: &str,
    env: Option<(&str, &str)>,
) -> Result<NativeUpdateCheck> {
    let outcome = run_cli_with_path(executable, args, CLI_CHECK_TIMEOUT, search_path, env)?;
    let output = successful_output(executable, outcome)?;
    serde_json::from_str(output.stdout.trim()).context("Read the native update check response")
}

fn grok_home() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("GROK_HOME").filter(|home| !home.is_empty()) {
        return Some(cli_working_dir()?.join(home));
    }
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".grok"))
}

fn grok_npm_link_conflict(home: &Path, resolved: &Path, search_path: &str) -> bool {
    let Ok(home) = home.canonicalize() else {
        return false;
    };
    if !resolved.starts_with(&home)
        || home.join("bin/grok").canonicalize().as_deref().ok() != Some(resolved)
    {
        return false;
    }
    let Some(npm) = find_on_path("npm", search_path) else {
        return false;
    };
    let Ok(output) = run_cli_with_path(
        &npm,
        &["prefix", "--global"],
        CLI_VERSION_TIMEOUT,
        search_path,
        None,
    )
    .and_then(|outcome| successful_output(&npm, outcome)) else {
        return false;
    };
    let prefix = Path::new(output.stdout.trim());
    // The npm bin entry points to Grok's own managed copy, after npm ownership
    // has already been ruled out. npm would refuse to replace this entry.
    prefix.is_absolute() && prefix.join("bin/grok").canonicalize().as_deref().ok() == Some(resolved)
}

fn npm_latest_version(
    npm: &Path,
    package: &str,
    prefix: Option<&Path>,
    search_path: &str,
) -> Result<Version> {
    let package = format!("{package}@latest");
    let mut args = vec![
        OsStr::new("view"),
        OsStr::new(&package),
        OsStr::new("version"),
        OsStr::new("--json"),
        OsStr::new("--fetch-retries=1"),
        OsStr::new("--fetch-retry-mintimeout=500"),
        OsStr::new("--fetch-timeout=5000"),
    ];
    if let Some(prefix) = prefix {
        args.extend([
            OsStr::new("--global"),
            OsStr::new("--prefix"),
            prefix.as_os_str(),
        ]);
    }
    let outcome = run_cli_with_path(npm, &args, CLI_CHECK_TIMEOUT, search_path, None)?;
    let output = successful_output(npm, outcome).context("Check the latest release with npm")?;
    parse_npm_version(&output.stdout)
}

fn parse_npm_version(stdout: &str) -> Result<Version> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum NpmVersion {
        Single(String),
        // npm 12 always emits an array with --json.
        Array([String; 1]),
    }

    let value: NpmVersion =
        serde_json::from_str(stdout.trim()).context("Read npm's version response")?;
    let version = match value {
        NpmVersion::Single(version) | NpmVersion::Array([version]) => version,
    };
    parse_version(&version).context("npm returned an invalid version")
}

fn installed_version(
    spec: &CliUpdateSpec,
    executable: &Path,
    search_path: &str,
) -> Result<Version> {
    let outcome = run_cli_with_path(
        executable,
        &["--version"],
        CLI_VERSION_TIMEOUT,
        search_path,
        None,
    )?;
    let output = successful_output(executable, outcome)?;
    parse_version_output(spec, &output.stdout)
        .or_else(|| parse_version_output(spec, &output.stderr))
        .with_context(|| {
            format!(
                "Gyro could not read the version at {}",
                executable.display()
            )
        })
}

fn parse_version_output(spec: &CliUpdateSpec, output: &str) -> Option<Version> {
    output.lines().find_map(|line| {
        let mut tokens = line.split_whitespace();
        let first = tokens.next()?;
        if first
            .trim_end_matches("-cli")
            .eq_ignore_ascii_case(spec.program)
        {
            return tokens.next().and_then(parse_version);
        }
        parse_version(first)
    })
}

fn parse_version(value: &str) -> Option<Version> {
    Version::parse(value.trim().trim_start_matches(['v', 'V'])).ok()
}

/// A matching global bin link establishes ownership of the active executable,
/// even when another npm or a convenience symlink is earlier on PATH.
fn npm_prefix_for(resolved: &Path, program: &str, package: &str) -> Option<PathBuf> {
    // Homebrew formulae can have a private lib/node_modules tree.
    if resolved
        .ancestors()
        .any(|dir| dir.join("INSTALL_RECEIPT.json").is_file())
    {
        return None;
    }
    resolved.ancestors().find_map(|prefix| {
        let package_root = prefix.join("lib/node_modules").join(package);
        if !resolved.starts_with(&package_root) || !package_root.join("package.json").is_file() {
            return None;
        }
        let global_link = prefix.join("bin").join(program).canonicalize().ok()?;
        (global_link == resolved).then(|| prefix.to_path_buf())
    })
}

fn prepend_path(dir: &Path, search_path: &str) -> String {
    std::iter::once(dir.to_path_buf())
        .chain(std::env::split_paths(search_path).filter(|entry| entry != dir))
        .map(|entry| entry.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(":")
}

fn find_on_path(program: &str, search_path: &str) -> Option<PathBuf> {
    std::env::split_paths(search_path)
        .filter(|dir| !dir.as_os_str().is_empty())
        .filter_map(|dir| {
            if dir.is_absolute() {
                Some(dir.join(program))
            } else {
                cli_working_dir().map(|base| base.join(dir).join(program))
            }
        })
        .find(|candidate| is_executable_file(candidate))
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

pub(crate) fn run_cli_capture_with_path(
    program: &str,
    args: &[&str],
    timeout: Duration,
    search_path: &str,
) -> Result<String> {
    let program = Path::new(program);
    let outcome = run_cli_with_path(program, args, timeout, search_path, None)?;
    successful_output(program, outcome).map(|outcome| join_output(&outcome))
}

fn cli_working_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
}

fn run_cli_with_path(
    program: &Path,
    args: &[impl AsRef<OsStr>],
    timeout: Duration,
    search_path: &str,
    env: Option<(&str, &str)>,
) -> Result<ExecutionOutcome> {
    let mut request = ExecutionRequest::new(program.as_os_str());
    request.args = args.iter().map(|arg| arg.as_ref().to_owned()).collect();
    // A workspace's .npmrc must not affect global CLI updates.
    request.current_dir = cli_working_dir();
    request.env = vec![("PATH".into(), Some(search_path.into()))];
    if let Some((key, value)) = env {
        request.env.push((key.into(), Some(value.into())));
    }
    request.timeout = timeout;
    request.max_stdout_chars = CLI_OUTPUT_CHARS;
    request.max_stderr_chars = CLI_OUTPUT_CHARS / 2;
    run_command(request, CancellationToken::default(), |_| {})
}

fn successful_output(program: &Path, outcome: ExecutionOutcome) -> Result<ExecutionOutcome> {
    match &outcome.termination {
        ExecutionTermination::Exited { code: Some(0) } => Ok(outcome),
        ExecutionTermination::Exited { code } => bail!(
            "{} exited with {code:?}: {}",
            program.display(),
            join_output(&outcome)
        ),
        termination => bail!(
            "{} terminated ({termination:?}): {}",
            program.display(),
            join_output(&outcome)
        ),
    }
}

fn join_output(outcome: &ExecutionOutcome) -> String {
    match (outcome.stdout.trim(), outcome.stderr.trim()) {
        (stdout, "") => stdout.into(),
        ("", stderr) => stderr.into(),
        (stdout, stderr) => format!("{stdout}\n{stderr}"),
    }
}

fn summarize_failure(message: &str) -> String {
    let text = message
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| !line.contains("A complete log of this run"))
        .filter(|line| !line.starts_with("npm warn"))
        .collect::<Vec<_>>()
        .join(" · ");
    if text.chars().count() <= 360 {
        return text;
    }
    let mut short = text.chars().take(359).collect::<String>();
    short.push('…');
    short
}

#[cfg(all(test, unix))]
mod tests;
