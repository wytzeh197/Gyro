//! Detect and apply updates for provider CLIs Gyro can drive.
//!
//! Checks run on the desktop backend (launch + periodic). The UI shows a
//! center-top notice with **Update** or **Update All** — never installs without
//! that explicit press.

use crate::cli_path::augmented_gui_path;
use crate::execution::{run_command, CancellationToken, ExecutionRequest, ExecutionTermination};
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

const CLI_CHECK_TIMEOUT: Duration = Duration::from_secs(25);
const CLI_UPDATE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const CLI_CHECK_OUTPUT_CHARS: usize = 64 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliUpdateOffer {
    pub provider_id: String,
    pub display_name: String,
    pub program: String,
    pub current_version: Option<String>,
    pub latest_version: Option<String>,
    pub update_available: bool,
    /// Human-readable how Gyro knows (native check, npm, …).
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
    /// Optional npm global package used for outdated checks.
    npm_package: Option<&'static str>,
    /// Native check command args after the program, when supported.
    /// Grok: `update --check --json`.
    native_check_args: Option<&'static [&'static str]>,
    update_args: &'static [&'static str],
    /// The update command installs through npm (directly, or via the CLI's
    /// own updater). It must then run with the npm that owns `npm_package`
    /// first on PATH, or a second npm on PATH installs into the wrong prefix.
    updates_through_npm: bool,
}

const CLI_UPDATE_SPECS: &[CliUpdateSpec] = &[
    CliUpdateSpec {
        provider_id: "anthropic",
        display_name: "Claude Code",
        program: "claude",
        npm_package: Some("@anthropic-ai/claude-code"),
        native_check_args: None,
        update_args: &["update"],
        updates_through_npm: false,
    },
    CliUpdateSpec {
        provider_id: "openai",
        display_name: "Codex",
        program: "codex",
        npm_package: Some("@openai/codex"),
        native_check_args: None,
        update_args: &["update"],
        updates_through_npm: false,
    },
    CliUpdateSpec {
        provider_id: "xai",
        display_name: "Grok",
        program: "grok",
        // Only used to find the owning npm: the native check stays the source
        // of truth, and `grok update` shells out to npm for npm installs.
        npm_package: Some("@xai-official/grok"),
        native_check_args: Some(&["update", "--check", "--json"]),
        update_args: &["update"],
        updates_through_npm: true,
    },
    CliUpdateSpec {
        provider_id: "gemini",
        display_name: "Gemini CLI",
        program: "gemini",
        npm_package: Some("@google/gemini-cli"),
        native_check_args: None,
        update_args: &[], // filled via npm install when updating
        updates_through_npm: true,
    },
    CliUpdateSpec {
        provider_id: "kimi",
        display_name: "Kimi Code",
        program: "kimi",
        npm_package: None,
        native_check_args: None,
        update_args: &["upgrade"],
        updates_through_npm: false,
    },
];

/// Scan installed provider CLIs for available updates.
pub fn check_cli_updates() -> Result<CliUpdateCheckReport> {
    let npm_outdated = npm_global_outdated().unwrap_or_default();
    let mut offers = Vec::new();
    for spec in CLI_UPDATE_SPECS {
        if !program_is_available(spec.program) {
            continue;
        }
        if let Some(offer) = check_one_cli(spec, &npm_outdated) {
            if offer.update_available {
                offers.push(offer);
            }
        }
    }
    Ok(CliUpdateCheckReport {
        checked_at: chrono::Utc::now().to_rfc3339(),
        offers,
    })
}

/// Apply updates for the given provider ids (or all pending if empty).
pub fn apply_cli_updates(provider_ids: &[String]) -> Result<Vec<CliUpdateApplyResult>> {
    let report = check_cli_updates()?;
    let mut results = Vec::new();
    if provider_ids.is_empty() {
        for offer in &report.offers {
            results.push(apply_one_cli_update(offer));
        }
        return Ok(results);
    }
    for provider_id in provider_ids {
        match report
            .offers
            .iter()
            .find(|offer| &offer.provider_id == provider_id)
        {
            Some(offer) => results.push(apply_one_cli_update(offer)),
            // The notice can be older than the CLI: another terminal, or the
            // CLI's own auto-updater, may already have installed the release.
            // That is the outcome the user asked for, not a failure.
            None => {
                if let Some(spec) = spec_for(provider_id) {
                    results.push(CliUpdateApplyResult {
                        provider_id: spec.provider_id.into(),
                        display_name: spec.display_name.into(),
                        ok: true,
                        message: format!("{} is already up to date", spec.display_name),
                    });
                }
            }
        }
    }
    Ok(results)
}

fn spec_for(provider_id: &str) -> Option<&'static CliUpdateSpec> {
    CLI_UPDATE_SPECS
        .iter()
        .find(|spec| spec.provider_id == provider_id)
}

fn check_one_cli(
    spec: &CliUpdateSpec,
    npm_outdated: &HashMap<String, NpmOutdatedEntry>,
) -> Option<CliUpdateOffer> {
    let current = installed_version(spec.program);
    let update_command = update_command_for(spec);

    // 1) Native check (Grok).
    if let Some(args) = spec.native_check_args {
        if let Some(offer) =
            check_via_native_json(spec, args, current.clone(), update_command.clone())
        {
            return Some(offer);
        }
    }

    // 2) npm registry checks for CLIs with npm releases.
    //
    // `npm outdated -g` describes the package tree owned by whichever npm is
    // on PATH. That can differ from the executable we will launch: for
    // example, a standalone Codex install in `~/.local/bin` wins over an
    // older Homebrew npm install. Always take the installed version from the
    // executable above, and use npm only to learn the latest release. This
    // keeps an offer and its update command pointed at the same CLI.
    if let Some(package) = spec.npm_package {
        // A version we could not read cannot be compared safely. In that case
        // omit the notice rather than offering an update for a different
        // installation of the same CLI.
        let latest = npm_outdated
            .get(package)
            .and_then(|entry| entry.latest.clone().or(entry.wanted.clone()))
            .or_else(|| npm_view_version(package).ok());
        let check_source = if npm_outdated.contains_key(package) {
            "npm"
        } else {
            "npm-view"
        };
        return npm_update_offer(
            spec,
            current.as_deref(),
            latest.as_deref(),
            check_source,
            update_command,
        );
    }

    // 3) Installed but no update channel we can query — omit from the notice.
    // Kimi and similar still get an entry only when we can prove an update.
    None
}

fn npm_update_offer(
    spec: &CliUpdateSpec,
    current: Option<&str>,
    latest: Option<&str>,
    check_source: &str,
    update_command: Vec<String>,
) -> Option<CliUpdateOffer> {
    let (current_version, latest_version) = npm_update_versions(current, latest)?;
    let update_available = versions_differ(Some(&current_version), Some(&latest_version));
    Some(CliUpdateOffer {
        provider_id: spec.provider_id.into(),
        display_name: spec.display_name.into(),
        program: spec.program.into(),
        current_version: Some(current_version),
        latest_version: Some(latest_version),
        update_available,
        check_source: check_source.into(),
        update_command,
    })
}

fn check_via_native_json(
    spec: &CliUpdateSpec,
    args: &[&str],
    current: Option<String>,
    update_command: Vec<String>,
) -> Option<CliUpdateOffer> {
    let output = run_cli_capture(spec.program, args, CLI_CHECK_TIMEOUT).ok()?;
    let value: serde_json::Value = serde_json::from_str(output.trim()).ok()?;
    let update_available = value
        .get("updateAvailable")
        .and_then(|item| item.as_bool())
        .unwrap_or(false);
    let current_version = value
        .get("currentVersion")
        .and_then(|item| item.as_str())
        .map(normalize_version)
        .or_else(|| current.map(|value| normalize_version(&value)));
    let latest_version = value
        .get("latestVersion")
        .and_then(|item| item.as_str())
        .map(normalize_version);
    Some(CliUpdateOffer {
        provider_id: spec.provider_id.into(),
        display_name: spec.display_name.into(),
        program: spec.program.into(),
        current_version,
        latest_version,
        update_available,
        check_source: "native".into(),
        update_command,
    })
}

fn apply_one_cli_update(offer: &CliUpdateOffer) -> CliUpdateApplyResult {
    let search_path = update_search_path(offer);
    let program = offer
        .update_command
        .first()
        .cloned()
        .unwrap_or_else(|| offer.program.clone());
    // Launch the same executable the check inspected, even when the update
    // PATH puts another installation's bin directory first.
    let program = if program == offer.program {
        find_on_path(&program, &augmented_gui_path())
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or(program)
    } else {
        program
    };
    let args = offer.update_command.get(1..).unwrap_or(&[]).to_vec();
    let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    match run_cli_capture_with_path(&program, &arg_refs, CLI_UPDATE_TIMEOUT, &search_path) {
        Ok(output) => {
            match verify_applied_cli_update(offer, installed_version(&offer.program).as_deref()) {
                Ok(verification) => {
                    let summary = summarize_command_output(&output);
                    CliUpdateApplyResult {
                        provider_id: offer.provider_id.clone(),
                        display_name: offer.display_name.clone(),
                        ok: true,
                        message: if summary.is_empty() {
                            verification
                        } else {
                            format!("{verification} · {summary}")
                        },
                    }
                }
                Err(message) => CliUpdateApplyResult {
                    provider_id: offer.provider_id.clone(),
                    display_name: offer.display_name.clone(),
                    ok: false,
                    message,
                },
            }
        }
        Err(error) => CliUpdateApplyResult {
            provider_id: offer.provider_id.clone(),
            display_name: offer.display_name.clone(),
            ok: false,
            message: summarize_failure(&error.to_string()),
        },
    }
}

/// PATH for an update command. npm-backed updates put the bin directory of
/// the npm that owns the package first; everything else uses Gyro's GUI PATH.
///
/// Several npm installations are common (Homebrew, nvm, and tools that bundle
/// their own Node in `~/.local/bin`). Whichever comes first on PATH would
/// otherwise run `npm install -g` against its own prefix, which either
/// collides with existing links (EEXIST) or installs a copy Gyro never runs.
fn update_search_path(offer: &CliUpdateOffer) -> String {
    let base = augmented_gui_path();
    let Some(spec) = spec_for(&offer.provider_id) else {
        return base;
    };
    let Some(package) = spec.npm_package else {
        return base;
    };
    let Some(owner) = owning_npm(package, &base) else {
        return base;
    };
    let launches_npm_install = find_on_path(spec.program, &base)
        .and_then(|path| path.canonicalize().ok())
        .is_some_and(|path| path.starts_with(&owner.package_dir));
    if !spec.updates_through_npm && !launches_npm_install {
        return base;
    }
    prepend_path(&owner.bin_dir, &base)
}

struct NpmOwner {
    bin_dir: PathBuf,
    package_dir: PathBuf,
}

/// Find the npm whose global root contains `package`, preferring PATH order.
fn owning_npm(package: &str, search_path: &str) -> Option<NpmOwner> {
    let mut seen = Vec::new();
    for dir in std::env::split_paths(search_path) {
        let npm = dir.join("npm");
        let Ok(resolved) = npm.canonicalize() else {
            continue;
        };
        if seen.contains(&resolved) {
            continue;
        }
        seen.push(resolved);
        // Run each npm with its own directory first so `#!/usr/bin/env node`
        // picks the Node it was installed with.
        let path = prepend_path(&dir, search_path);
        let Ok(output) = run_cli_capture_with_path(
            &npm.to_string_lossy(),
            &["root", "-g"],
            CLI_CHECK_TIMEOUT,
            &path,
        ) else {
            continue;
        };
        let Some(root) = output
            .lines()
            .map(str::trim)
            .rfind(|line| line.starts_with('/'))
        else {
            continue;
        };
        let package_dir = Path::new(root).join(package);
        if package_dir.join("package.json").is_file() {
            return Some(NpmOwner {
                bin_dir: dir,
                package_dir: package_dir.canonicalize().unwrap_or(package_dir),
            });
        }
    }
    None
}

fn prepend_path(dir: &Path, search_path: &str) -> String {
    std::iter::once(dir.to_path_buf())
        .chain(std::env::split_paths(search_path).filter(|entry| entry != dir))
        .map(|entry| entry.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(":")
}

fn find_on_path(program: &str, search_path: &str) -> Option<PathBuf> {
    if program.contains('/') {
        return Some(PathBuf::from(program));
    }
    std::env::split_paths(search_path)
        .map(|dir| dir.join(program))
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

/// Keep the lines that explain a failed update and drop npm log noise, so the
/// notice and notification say why instead of echoing the whole transcript.
fn summarize_failure(message: &str) -> String {
    let lines = message
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| !line.contains("A complete log of this run"))
        .filter(|line| !line.starts_with("npm warn"))
        .collect::<Vec<_>>();
    let text = lines.join(" · ");
    if text.chars().count() <= 360 {
        return text;
    }
    let mut short = text.chars().take(359).collect::<String>();
    short.push('…');
    short
}

/// Confirm that the exact executable Gyro launched for the update reached the
/// advertised release. A zero exit code alone is not proof: another package
/// manager may have been updated while this CLI remained unchanged.
fn verify_applied_cli_update(
    offer: &CliUpdateOffer,
    observed_version: Option<&str>,
) -> std::result::Result<String, String> {
    let observed = observed_version
        .map(normalize_version)
        .filter(|version| !version.is_empty())
        .ok_or_else(|| {
            format!(
                "{} finished its update command, but Gyro could not read the version it uses",
                offer.display_name
            )
        })?;

    if let Some(expected) = offer
        .latest_version
        .as_deref()
        .map(normalize_version)
        .filter(|version| !version.is_empty())
    {
        // The CLI may install a release newer than the one the notice named.
        if compare_versions(&observed, &expected) == Ordering::Less {
            return Err(format!(
                "{} finished its update command, but Gyro still uses {} (expected {})",
                offer.display_name, observed, expected
            ));
        }
        return Ok(format!("{} updated to {}", offer.display_name, observed));
    }

    if let Some(previous) = offer
        .current_version
        .as_deref()
        .map(normalize_version)
        .filter(|version| !version.is_empty())
    {
        if observed == previous {
            return Err(format!(
                "{} finished its update command, but Gyro still uses {}",
                offer.display_name, observed
            ));
        }
        return Ok(format!("{} updated to {}", offer.display_name, observed));
    }

    Err(format!(
        "{} finished its update command, but Gyro cannot verify which version it should use",
        offer.display_name
    ))
}

fn update_command_for(spec: &CliUpdateSpec) -> Vec<String> {
    if spec.program == "gemini" {
        // Gemini has no first-party `update` subcommand on current builds.
        return vec![
            "npm".into(),
            "install".into(),
            "-g".into(),
            "@google/gemini-cli@latest".into(),
        ];
    }
    std::iter::once(spec.program.to_string())
        .chain(spec.update_args.iter().map(|arg| (*arg).to_string()))
        .collect()
}

fn program_is_available(program: &str) -> bool {
    // Cheap existence probe: --version. Failure to start means missing.
    match run_cli(program, &["--version"], Duration::from_secs(5)) {
        Ok(outcome) => {
            // Binary ran. Non-zero is still "available" for CLIs that print
            // version on stderr or use unusual exit codes.
            !matches!(
                outcome.termination,
                ExecutionTermination::Exited { code: Some(127) }
            )
        }
        Err(error) => {
            let text = error.to_string().to_ascii_lowercase();
            !text.contains("no such file")
                && !text.contains("not found")
                && !text.contains("cannot find")
                && !text.contains("failed to find")
        }
    }
}

fn installed_version(program: &str) -> Option<String> {
    let output = run_cli_capture(program, &["--version"], Duration::from_secs(8)).ok()?;
    parse_version_line(&output)
}

fn parse_version_line(output: &str) -> Option<String> {
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // "2.1.223 (Claude Code)", "codex-cli 0.144.4", "grok 0.2.118 (...)"
        let candidate = trimmed
            .split_whitespace()
            .find(|token| token.chars().next().is_some_and(|ch| ch.is_ascii_digit()))
            .unwrap_or(trimmed);
        let version = normalize_version(candidate);
        if !version.is_empty() {
            return Some(version);
        }
    }
    None
}

fn normalize_version(value: &str) -> String {
    value
        .trim()
        .trim_start_matches('v')
        .trim_start_matches('V')
        .split(|ch: char| ch == '(' || ch == ',' || ch == '+' || ch.is_whitespace())
        .next()
        .unwrap_or(value)
        .trim()
        .trim_matches(|ch: char| !ch.is_ascii_alphanumeric() && ch != '.' && ch != '-')
        .to_string()
}

/// Pair the version of the executable Gyro will launch with npm's latest
/// registry version. Never substitute npm's package-tree `current` field: it
/// can belong to a shadowed installation.
fn npm_update_versions(current: Option<&str>, latest: Option<&str>) -> Option<(String, String)> {
    let current = current
        .map(normalize_version)
        .filter(|value| !value.is_empty())?;
    let latest = latest
        .map(normalize_version)
        .filter(|value| !value.is_empty())?;
    Some((current, latest))
}

/// Compare dotted numeric versions; non-numeric suffixes sort before the
/// release (`1.2.0-beta` < `1.2.0`). Falls back to string order.
fn compare_versions(left: &str, right: &str) -> Ordering {
    fn parts(value: &str) -> (Vec<u64>, bool) {
        let (core, pre) = match value.split_once('-') {
            Some((core, _)) => (core, true),
            None => (value, false),
        };
        (
            core.split('.')
                .map(|part| part.parse::<u64>().unwrap_or(0))
                .collect(),
            pre,
        )
    }
    let (left_core, left_pre) = parts(left);
    let (right_core, right_pre) = parts(right);
    let width = left_core.len().max(right_core.len());
    for index in 0..width {
        let a = left_core.get(index).copied().unwrap_or(0);
        let b = right_core.get(index).copied().unwrap_or(0);
        match a.cmp(&b) {
            Ordering::Equal => continue,
            other => return other,
        }
    }
    match (left_pre, right_pre) {
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        _ if left == right => Ordering::Equal,
        _ => left.cmp(right),
    }
}

fn versions_differ(current: Option<&str>, latest: Option<&str>) -> bool {
    match (current, latest) {
        (Some(current), Some(latest)) if !current.is_empty() && !latest.is_empty() => {
            current != latest
        }
        _ => false,
    }
}

#[derive(Clone, Debug, Default)]
struct NpmOutdatedEntry {
    wanted: Option<String>,
    latest: Option<String>,
}

fn npm_global_outdated() -> Result<HashMap<String, NpmOutdatedEntry>> {
    // `npm outdated -g --json` exits 1 when packages are outdated — still success for us.
    let output =
        run_cli_capture_allow_nonzero("npm", &["outdated", "-g", "--json"], CLI_CHECK_TIMEOUT)?;
    let trimmed = output.trim();
    if trimmed.is_empty() || trimmed == "{}" {
        return Ok(HashMap::new());
    }
    let value: serde_json::Value =
        serde_json::from_str(trimmed).context("parse npm outdated json")?;
    let object = value
        .as_object()
        .ok_or_else(|| anyhow!("npm outdated json was not an object"))?;
    let mut map = HashMap::new();
    for (name, entry) in object {
        let wanted = entry
            .get("wanted")
            .and_then(|item| item.as_str())
            .map(str::to_string);
        let latest = entry
            .get("latest")
            .and_then(|item| item.as_str())
            .map(str::to_string);
        map.insert(name.clone(), NpmOutdatedEntry { wanted, latest });
    }
    Ok(map)
}

fn npm_view_version(package: &str) -> Result<String> {
    let output = run_cli_capture("npm", &["view", package, "version"], CLI_CHECK_TIMEOUT)?;
    // npm prints config warnings before the answer; the version is last.
    output
        .lines()
        .rev()
        .filter(|line| !line.trim_start().starts_with("npm "))
        .find_map(parse_version_line)
        .ok_or_else(|| anyhow!("npm view returned no version"))
}

fn run_cli_capture(program: &str, args: &[&str], timeout: Duration) -> Result<String> {
    run_cli_capture_with_path(program, args, timeout, &augmented_gui_path())
}

fn run_cli_capture_with_path(
    program: &str,
    args: &[&str],
    timeout: Duration,
    search_path: &str,
) -> Result<String> {
    let outcome = run_cli_with_path(program, args, timeout, search_path)?;
    match &outcome.termination {
        ExecutionTermination::Exited { code: Some(0) } => Ok(join_output(&outcome)),
        ExecutionTermination::Exited { code } => Err(anyhow!(
            "{program} exited with {:?}: {}",
            code,
            join_output(&outcome)
        )),
        other => Err(anyhow!(
            "{program} terminated ({other:?}): {}",
            join_output(&outcome)
        )),
    }
}

fn run_cli_capture_allow_nonzero(
    program: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<String> {
    let outcome = run_cli(program, args, timeout)?;
    match &outcome.termination {
        ExecutionTermination::Exited { .. } => Ok(join_output(&outcome)),
        other => Err(anyhow!(
            "{program} terminated ({other:?}): {}",
            join_output(&outcome)
        )),
    }
}

fn run_cli(
    program: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<crate::execution::ExecutionOutcome> {
    run_cli_with_path(program, args, timeout, &augmented_gui_path())
}

fn run_cli_with_path(
    program: &str,
    args: &[&str],
    timeout: Duration,
    search_path: &str,
) -> Result<crate::execution::ExecutionOutcome> {
    let mut request = ExecutionRequest::new(OsString::from(program));
    request.args = args.iter().map(|arg| OsString::from(*arg)).collect();
    // Run from home, not wherever Gyro was launched: a project `.npmrc` or
    // `package.json` must not change how global CLIs are checked or updated.
    request.current_dir = std::env::var_os("HOME").map(PathBuf::from);
    request.env = vec![(OsString::from("PATH"), Some(OsString::from(search_path)))];
    request.timeout = timeout;
    request.inactivity_timeout = Some(timeout);
    request.max_stdout_chars = CLI_CHECK_OUTPUT_CHARS;
    request.max_stderr_chars = CLI_CHECK_OUTPUT_CHARS / 2;
    run_command(request, CancellationToken::default(), |_| {})
}

fn join_output(outcome: &crate::execution::ExecutionOutcome) -> String {
    let mut text = outcome.stdout.clone();
    if !outcome.stderr.trim().is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&outcome.stderr);
    }
    text
}

fn summarize_command_output(output: &str) -> String {
    output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(4)
        .collect::<Vec<_>>()
        .join(" · ")
        .chars()
        .take(280)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_version_strings() {
        assert_eq!(normalize_version("v1.2.3"), "1.2.3");
        assert_eq!(normalize_version("2.1.223 (Claude Code)"), "2.1.223");
        assert_eq!(normalize_version("0.144.4"), "0.144.4");
    }

    #[test]
    fn parse_version_line_finds_semver() {
        assert_eq!(
            parse_version_line("2.1.223 (Claude Code)\n"),
            Some("2.1.223".into())
        );
        assert_eq!(
            parse_version_line("codex-cli 0.144.4\n"),
            Some("0.144.4".into())
        );
        assert_eq!(
            parse_version_line("grok 0.2.118 (1e1687c1cf6a)\n"),
            Some("0.2.118".into())
        );
    }

    #[test]
    fn versions_differ_compares_normalized_values() {
        assert!(versions_differ(Some("0.53.0"), Some("0.54.0")));
        assert!(!versions_differ(Some("0.53.0"), Some("0.53.0")));
        assert!(!versions_differ(None, Some("0.53.0")));
    }

    #[test]
    fn npm_update_versions_uses_the_running_cli_not_a_shadowed_global_package() {
        // npm may report 0.151.0 from Homebrew while Gyro launches the
        // standalone 0.152.1 executable from ~/.local/bin.
        assert_eq!(
            npm_update_versions(Some("0.152.1"), Some("0.152.1")),
            Some(("0.152.1".into(), "0.152.1".into()))
        );
    }

    #[test]
    fn shadowed_global_npm_package_does_not_create_a_cli_update_offer() {
        let codex = CLI_UPDATE_SPECS
            .iter()
            .find(|spec| spec.provider_id == "openai")
            .unwrap();

        // npm's stale 0.151.0 `current` is deliberately not an input here.
        // The executable Gyro will run is already 0.152.1, as is npm's latest.
        let offer = npm_update_offer(
            codex,
            Some("0.152.1"),
            Some("0.152.1"),
            "npm",
            update_command_for(codex),
        )
        .unwrap();

        assert_eq!(offer.current_version.as_deref(), Some("0.152.1"));
        assert_eq!(offer.latest_version.as_deref(), Some("0.152.1"));
        assert!(!offer.update_available);
    }

    #[test]
    fn post_update_verification_rejects_an_unchanged_selected_cli() {
        let offer = CliUpdateOffer {
            provider_id: "openai".into(),
            display_name: "Codex".into(),
            program: "codex".into(),
            current_version: Some("0.151.0".into()),
            latest_version: Some("0.152.1".into()),
            update_available: true,
            check_source: "npm".into(),
            update_command: vec!["codex".into(), "update".into()],
        };

        let error = verify_applied_cli_update(&offer, Some("0.151.0")).unwrap_err();
        assert!(error.contains("still uses 0.151.0 (expected 0.152.1)"));
        assert_eq!(
            verify_applied_cli_update(&offer, Some("0.152.1")).unwrap(),
            "Codex updated to 0.152.1"
        );
    }

    #[test]
    fn post_update_verification_accepts_a_newer_release() {
        let offer = CliUpdateOffer {
            provider_id: "xai".into(),
            display_name: "Grok".into(),
            program: "grok".into(),
            current_version: Some("1.0.40".into()),
            latest_version: Some("1.0.41".into()),
            update_available: true,
            check_source: "native".into(),
            update_command: vec!["grok".into(), "update".into()],
        };
        assert_eq!(
            verify_applied_cli_update(&offer, Some("1.0.42")).unwrap(),
            "Grok updated to 1.0.42"
        );
    }

    #[test]
    fn compare_versions_orders_numeric_parts() {
        assert_eq!(compare_versions("1.0.41", "1.0.40"), Ordering::Greater);
        assert_eq!(compare_versions("1.0.9", "1.0.10"), Ordering::Less);
        assert_eq!(compare_versions("2.1.280", "2.1.280"), Ordering::Equal);
        assert_eq!(compare_versions("1.2.0-beta.1", "1.2.0"), Ordering::Less);
    }

    #[test]
    fn prepend_path_moves_the_owning_npm_first_without_duplicates() {
        assert_eq!(
            prepend_path(
                Path::new("/opt/homebrew/bin"),
                "/u/.local/bin:/opt/homebrew/bin:/usr/bin"
            ),
            "/opt/homebrew/bin:/u/.local/bin:/usr/bin"
        );
    }

    #[test]
    fn summarize_failure_keeps_the_reason_and_drops_npm_noise() {
        let summary = summarize_failure(
            "grok exited with Some(1): Updating Grok 1.0.40 → 1.0.41\n\nnpm warn config x\nnpm error code EEXIST\nnpm error A complete log of this run can be found in: /tmp/x.log\n",
        );
        assert!(summary.contains("EEXIST"));
        assert!(!summary.contains("complete log"));
        assert!(!summary.contains("npm warn"));
    }

    #[test]
    fn update_command_for_gemini_uses_npm() {
        let gemini = CLI_UPDATE_SPECS
            .iter()
            .find(|spec| spec.provider_id == "gemini")
            .unwrap();
        let command = update_command_for(gemini);
        assert_eq!(command[0], "npm");
        assert!(command
            .iter()
            .any(|part| part.contains("@google/gemini-cli")));
    }

    #[test]
    fn update_command_for_claude_uses_native() {
        let claude = CLI_UPDATE_SPECS
            .iter()
            .find(|spec| spec.provider_id == "anthropic")
            .unwrap();
        assert_eq!(update_command_for(claude), vec!["claude", "update"]);
    }
}
