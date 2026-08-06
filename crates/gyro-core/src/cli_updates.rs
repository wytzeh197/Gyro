//! Detect and apply updates for provider CLIs Gyro can drive.
//!
//! Checks run on the desktop backend (launch + periodic). The UI shows a
//! center-top notice with **Update** or **Update All** — never installs without
//! that explicit press.

use crate::execution::{
    run_command, CancellationToken, ExecutionRequest, ExecutionTermination,
};
use crate::cli_path::augmented_gui_path;
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsString;
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
}

const CLI_UPDATE_SPECS: &[CliUpdateSpec] = &[
    CliUpdateSpec {
        provider_id: "anthropic",
        display_name: "Claude Code",
        program: "claude",
        npm_package: Some("@anthropic-ai/claude-code"),
        native_check_args: None,
        update_args: &["update"],
    },
    CliUpdateSpec {
        provider_id: "openai",
        display_name: "Codex",
        program: "codex",
        npm_package: Some("@openai/codex"),
        native_check_args: None,
        update_args: &["update"],
    },
    CliUpdateSpec {
        provider_id: "xai",
        display_name: "Grok",
        program: "grok",
        npm_package: None,
        native_check_args: Some(&["update", "--check", "--json"]),
        update_args: &["update"],
    },
    CliUpdateSpec {
        provider_id: "gemini",
        display_name: "Gemini CLI",
        program: "gemini",
        npm_package: Some("@google/gemini-cli"),
        native_check_args: None,
        update_args: &[], // filled via npm install when updating
    },
    CliUpdateSpec {
        provider_id: "kimi",
        display_name: "Kimi Code",
        program: "kimi",
        npm_package: None,
        native_check_args: None,
        update_args: &["upgrade"],
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
    let targets: Vec<CliUpdateOffer> = if provider_ids.is_empty() {
        report.offers
    } else {
        report
            .offers
            .into_iter()
            .filter(|offer| provider_ids.iter().any(|id| id == &offer.provider_id))
            .collect()
    };
    if targets.is_empty() {
        return Ok(Vec::new());
    }
    let mut results = Vec::with_capacity(targets.len());
    for offer in targets {
        results.push(apply_one_cli_update(&offer));
    }
    Ok(results)
}

fn check_one_cli(
    spec: &CliUpdateSpec,
    npm_outdated: &HashMap<String, NpmOutdatedEntry>,
) -> Option<CliUpdateOffer> {
    let current = installed_version(spec.program);
    let update_command = update_command_for(spec);

    // 1) Native check (Grok).
    if let Some(args) = spec.native_check_args {
        if let Some(offer) = check_via_native_json(spec, args, current.clone(), update_command.clone())
        {
            return Some(offer);
        }
    }

    // 2) npm outdated for packages installed globally.
    if let Some(package) = spec.npm_package {
        if let Some(entry) = npm_outdated.get(package) {
            let current_version = entry
                .current
                .clone()
                .or_else(|| current.clone())
                .map(|value| normalize_version(&value));
            let latest_version = entry
                .latest
                .clone()
                .or_else(|| entry.wanted.clone())
                .map(|value| normalize_version(&value));
            let update_available = versions_differ(
                current_version.as_deref(),
                latest_version.as_deref(),
            );
            return Some(CliUpdateOffer {
                provider_id: spec.provider_id.into(),
                display_name: spec.display_name.into(),
                program: spec.program.into(),
                current_version,
                latest_version,
                update_available,
                check_source: "npm".into(),
                update_command,
            });
        }
        // Package not in outdated list: either up to date or not npm-installed.
        // If we have both installed + registry latest, compare when npm is available.
        if let (Some(current_version), Some(latest)) =
            (current.clone(), npm_view_version(package).ok())
        {
            let current_version = normalize_version(&current_version);
            let latest_version = normalize_version(&latest);
            let update_available = versions_differ(Some(&current_version), Some(&latest_version));
            return Some(CliUpdateOffer {
                provider_id: spec.provider_id.into(),
                display_name: spec.display_name.into(),
                program: spec.program.into(),
                current_version: Some(current_version),
                latest_version: Some(latest_version),
                update_available,
                check_source: "npm-view".into(),
                update_command,
            });
        }
    }

    // 3) Installed but no update channel we can query — omit from the notice.
    // Kimi and similar still get an entry only when we can prove an update.
    let _ = current;
    None
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
    let program = offer
        .update_command
        .first()
        .cloned()
        .unwrap_or_else(|| offer.program.clone());
    let args = offer
        .update_command
        .get(1..)
        .unwrap_or(&[])
        .iter()
        .cloned()
        .collect::<Vec<_>>();
    let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    match run_cli_capture(&program, &arg_refs, CLI_UPDATE_TIMEOUT) {
        Ok(output) => {
            let message = summarize_command_output(&output);
            CliUpdateApplyResult {
                provider_id: offer.provider_id.clone(),
                display_name: offer.display_name.clone(),
                ok: true,
                message: if message.is_empty() {
                    format!("{} updated", offer.display_name)
                } else {
                    message
                },
            }
        }
        Err(error) => CliUpdateApplyResult {
            provider_id: offer.provider_id.clone(),
            display_name: offer.display_name.clone(),
            ok: false,
            message: error.to_string(),
        },
    }
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
    current: Option<String>,
    wanted: Option<String>,
    latest: Option<String>,
}

fn npm_global_outdated() -> Result<HashMap<String, NpmOutdatedEntry>> {
    // `npm outdated -g --json` exits 1 when packages are outdated — still success for us.
    let output = run_cli_capture_allow_nonzero(
        "npm",
        &["outdated", "-g", "--json"],
        CLI_CHECK_TIMEOUT,
    )?;
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
        let current = entry
            .get("current")
            .and_then(|item| item.as_str())
            .map(str::to_string);
        let wanted = entry
            .get("wanted")
            .and_then(|item| item.as_str())
            .map(str::to_string);
        let latest = entry
            .get("latest")
            .and_then(|item| item.as_str())
            .map(str::to_string);
        map.insert(
            name.clone(),
            NpmOutdatedEntry {
                current,
                wanted,
                latest,
            },
        );
    }
    Ok(map)
}

fn npm_view_version(package: &str) -> Result<String> {
    let output = run_cli_capture("npm", &["view", package, "version"], CLI_CHECK_TIMEOUT)?;
    parse_version_line(&output).ok_or_else(|| anyhow!("npm view returned no version"))
}

fn run_cli_capture(program: &str, args: &[&str], timeout: Duration) -> Result<String> {
    let outcome = run_cli(program, args, timeout)?;
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
    let mut request = ExecutionRequest::new(OsString::from(program));
    request.args = args.iter().map(|arg| OsString::from(*arg)).collect();
    request.env = vec![(
        OsString::from("PATH"),
        Some(OsString::from(augmented_gui_path())),
    )];
    request.timeout = timeout;
    request.inactivity_timeout = Some(timeout);
    request.max_stdout_chars = CLI_CHECK_OUTPUT_CHARS;
    request.max_stderr_chars = CLI_CHECK_OUTPUT_CHARS / 2;
    run_command(request, CancellationToken::default(), |_| {}).map_err(Into::into)
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
    fn update_command_for_gemini_uses_npm() {
        let gemini = CLI_UPDATE_SPECS
            .iter()
            .find(|spec| spec.provider_id == "gemini")
            .unwrap();
        let command = update_command_for(gemini);
        assert_eq!(command[0], "npm");
        assert!(command.iter().any(|part| part.contains("@google/gemini-cli")));
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
