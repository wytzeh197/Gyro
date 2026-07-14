use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

const GUI_CLI_PATHS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
];

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderHealthRequest {
    pub provider_id: String,
    pub base_url: Option<String>,
    pub api_key_ref: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderHealthCheck {
    pub provider_id: String,
    pub output: String,
    pub runtime_status: String,
    pub auth_owner: String,
    pub auth_command: Option<String>,
    pub login_command: Option<String>,
    pub account_label: Option<String>,
    pub subscription_label: Option<String>,
    pub provider_mode: Option<String>,
    pub secret_storage: String,
    pub privacy_note: String,
    pub diagnostics_opt_in: bool,
}

#[derive(Default)]
pub struct ProviderHealthService;

impl ProviderHealthService {
    pub fn check(&self, request: ProviderHealthRequest) -> Result<ProviderHealthCheck> {
        match request.provider_id.as_str() {
            "openai" => self.check_openai(request),
            "anthropic" => self.cli_check(
                "anthropic",
                "provider-cli",
                "claude",
                &["auth", "status"],
                Some("claude auth login"),
                "Provider CLI, OS Keychain, or provider-owned files",
            ),
            "cursor" => self.cli_check(
                "cursor",
                "provider-cli",
                "cursor-agent",
                &["login", "status"],
                Some("cursor-agent login"),
                "Provider CLI, OS Keychain, or provider-owned files",
            ),
            "xai" => Ok(env_provider_health(
                "xai",
                request.api_key_ref.as_deref(),
                &["XAI_API_KEY"],
            )),
            "gemini" => Ok(env_provider_health(
                "gemini",
                request.api_key_ref.as_deref(),
                &[
                    "GEMINI_API_KEY",
                    "GOOGLE_API_KEY",
                    "GOOGLE_APPLICATION_CREDENTIALS",
                ],
            )),
            "opencode" => self.cli_check(
                "opencode",
                "provider-cli",
                "opencode",
                &["auth", "status"],
                Some("opencode auth login"),
                "Provider CLI, OS Keychain, or provider-owned files",
            ),
            _ => anyhow::bail!("unknown provider `{}`", request.provider_id),
        }
    }

    fn check_openai(&self, request: ProviderHealthRequest) -> Result<ProviderHealthCheck> {
        if should_skip_codex_login_for_external_env(
            request.base_url.as_deref(),
            request.api_key_ref.as_deref(),
        ) {
            return Ok(env_provider_health(
                "openai",
                request.api_key_ref.as_deref(),
                &["OPENAI_API_KEY"],
            ));
        }

        self.cli_check(
            "openai",
            "provider-cli",
            "codex",
            &["login", "status"],
            Some("codex login --device-auth"),
            "Provider CLI, OS Keychain, or provider-owned files",
        )
    }

    fn cli_check(
        &self,
        provider_id: &str,
        auth_owner: &str,
        command: &str,
        args: &[&str],
        login_command: Option<&str>,
        secret_storage: &str,
    ) -> Result<ProviderHealthCheck> {
        let auth_command = std::iter::once(command)
            .chain(args.iter().copied())
            .collect::<Vec<_>>()
            .join(" ");
        let output = match command_output(command, args) {
            Ok(output) => output,
            Err(error) => format!("{command} not installed or unavailable: {error}"),
        };
        let output = crate::security::redact_secrets(&output);
        Ok(ProviderHealthCheck {
            provider_id: provider_id.into(),
            runtime_status: provider_runtime_status_from_output(&output).into(),
            auth_owner: auth_owner.into(),
            auth_command: Some(auth_command),
            login_command: login_command.map(str::to_string),
            account_label: provider_account_label(&output),
            subscription_label: provider_subscription_label(&output),
            provider_mode: provider_mode_label(&output),
            secret_storage: secret_storage.into(),
            privacy_note:
                "Gyro stores readiness summaries only; provider tokens stay outside Gyro.".into(),
            diagnostics_opt_in: false,
            output,
        })
    }
}

pub fn should_skip_codex_login_for_external_env(
    base_url: Option<&str>,
    api_key_ref: Option<&str>,
) -> bool {
    let base_url = base_url.unwrap_or_default().trim().to_ascii_lowercase();
    let api_key_ref = api_key_ref.unwrap_or_default().trim().to_ascii_lowercase();
    let external_base_url = !base_url.is_empty()
        && !base_url.contains("api.openai.com")
        && !base_url.contains("chatgpt.com");
    let env_owned_key = api_key_ref.starts_with("provider-env:")
        || api_key_ref.starts_with("env:")
        || api_key_ref.ends_with("_api_key")
        || api_key_ref.contains("api_key");

    external_base_url && env_owned_key
}

fn env_provider_health(
    provider_id: &str,
    api_key_ref: Option<&str>,
    fallback_env_names: &[&str],
) -> ProviderHealthCheck {
    let mut env_names = Vec::new();
    if let Some(env_name) = env_name_from_ref(api_key_ref) {
        env_names.push(env_name);
    }
    for env_name in fallback_env_names {
        if !env_names.iter().any(|candidate| candidate == env_name) {
            env_names.push((*env_name).to_string());
        }
    }

    let present_env = env_names
        .iter()
        .find(|env_name| std::env::var_os(env_name.as_str()).is_some())
        .cloned();
    let output = if let Some(env_name) = present_env.as_deref() {
        format!(
            "{provider_id} provider-env auth available; {env_name} is set; value not read by Gyro."
        )
    } else {
        format!(
            "{provider_id} provider-env auth missing; configure one of {} outside Gyro.",
            env_names.join(", ")
        )
    };

    ProviderHealthCheck {
        provider_id: provider_id.into(),
        runtime_status: if present_env.is_some() {
            "ready".into()
        } else {
            "not-logged-in".into()
        },
        auth_owner: "provider-env".into(),
        auth_command: None,
        login_command: None,
        account_label: None,
        subscription_label: None,
        provider_mode: Some("environment-owned auth".into()),
        secret_storage: "Environment variable or provider SDK store".into(),
        privacy_note: "Gyro stores readiness summaries only; provider tokens stay outside Gyro."
            .into(),
        diagnostics_opt_in: false,
        output,
    }
}

fn env_name_from_ref(api_key_ref: Option<&str>) -> Option<String> {
    let reference = api_key_ref?.trim();
    let candidate = reference
        .strip_prefix("provider-env:")
        .or_else(|| reference.strip_prefix("env:"))
        .unwrap_or(reference)
        .trim();
    if candidate.is_empty() || candidate.contains(':') || candidate.contains('/') {
        None
    } else {
        Some(candidate.to_string())
    }
}

pub fn provider_runtime_status_from_output(output: &str) -> &'static str {
    let normalized = output.to_ascii_lowercase();
    if normalized.contains("not installed")
        || normalized.contains("command not found")
        || normalized.contains("no such file")
    {
        "not-installed"
    } else if normalized.contains("not authenticated")
        || normalized.contains("not logged in")
        || normalized.contains("logged out")
        || normalized.contains("authentication_failed")
        || normalized.contains("authentication failed")
        || normalized.contains("failed to authenticate")
        || normalized.contains("invalid authentication credentials")
        || normalized.contains("unauthorized")
        || normalized.contains("\"loggedin\": false")
        || normalized.contains("\"loggedin\":false")
        || normalized.contains("auth required")
    {
        "not-logged-in"
    } else if normalized.contains("authenticated")
        || normalized.contains("logged in")
        || normalized.contains("\"loggedin\": true")
        || normalized.contains("\"loggedin\":true")
        || normalized.contains("ready")
        || normalized.contains("ok")
    {
        "ready"
    } else if normalized.contains("error")
        || normalized.contains("failed")
        || normalized.contains("invalid")
        || normalized.contains("denied")
    {
        "warning"
    } else {
        "unknown"
    }
}

pub fn provider_subscription_label(output: &str) -> Option<String> {
    quoted_field(output, "subscriptionType")
        .or_else(|| quoted_field(output, "subscriptionTier"))
        .or_else(|| quoted_field(output, "subscription"))
}

pub fn provider_account_label(output: &str) -> Option<String> {
    quoted_field(output, "email")
        .or_else(|| quoted_field(output, "account"))
        .or_else(|| quoted_field(output, "user"))
}

pub fn provider_mode_label(output: &str) -> Option<String> {
    quoted_field(output, "mode").or_else(|| quoted_field(output, "authMode"))
}

fn quoted_field(output: &str, field: &str) -> Option<String> {
    let marker = format!("\"{field}\"");
    let start = output.find(&marker)?;
    let after_marker = &output[start + marker.len()..];
    let colon = after_marker.find(':')?;
    let after_colon = after_marker[colon + 1..].trim_start();
    let after_quote = after_colon.strip_prefix('"')?;
    let end = after_quote.find('"')?;
    Some(after_quote[..end].to_string())
}

fn command_output(command: &str, args: &[&str]) -> Result<String, String> {
    let output = command_with_gui_path(command)
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let combined = [stdout, stderr]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if combined.is_empty() {
        Ok(format!("{command} exited with {}", output.status))
    } else {
        Ok(combined)
    }
}

fn command_with_gui_path(command: &str) -> Command {
    let mut process = Command::new(command);
    if !command.contains('/') {
        process.env("PATH", augmented_gui_path());
    }
    process
}

fn augmented_gui_path() -> String {
    let mut paths = std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| user_cli_paths(&home))
        .unwrap_or_default();
    paths.extend(
        std::env::var("PATH")
            .unwrap_or_default()
            .split(':')
            .filter(|path| !path.is_empty())
            .map(ToOwned::to_owned),
    );
    paths.extend(GUI_CLI_PATHS.iter().map(|path| (*path).to_string()));
    let mut seen = HashSet::new();
    paths.retain(|path| seen.insert(path.clone()));
    paths.join(":")
}

fn user_cli_paths(home: &Path) -> Vec<String> {
    let mut paths = vec![
        home.join(".local/bin"),
        home.join("bin"),
        home.join(".volta/bin"),
        home.join(".asdf/shims"),
        home.join(".local/share/mise/shims"),
        home.join(".bun/bin"),
        home.join(".cargo/bin"),
    ];
    let nvm_versions = home.join(".nvm/versions/node");
    let mut nvm_bins = std::fs::read_dir(nvm_versions)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();
    nvm_bins.sort_by_key(|path| std::cmp::Reverse(node_version_key(path)));
    paths.extend(nvm_bins.into_iter().map(|path| path.join("bin")));
    paths
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

fn node_version_key(path: &Path) -> (u64, u64, u64) {
    let version = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .trim_start_matches('v');
    let mut parts = version
        .split('.')
        .map(|part| part.parse::<u64>().unwrap_or_default());
    (
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_redacted_cli_health_and_external_auth_ownership() {
        let output = r#"{"loggedIn":true,"email":"dev@example.test","subscriptionType":"max"}"#;
        assert_eq!(provider_runtime_status_from_output(output), "ready");
        assert_eq!(
            provider_account_label(output).as_deref(),
            Some("dev@example.test")
        );
        assert_eq!(provider_subscription_label(output).as_deref(), Some("max"));
        assert!(should_skip_codex_login_for_external_env(
            Some("https://gateway.example.test"),
            Some("env:OPENAI_API_KEY")
        ));
        assert!(!should_skip_codex_login_for_external_env(
            Some("https://api.openai.com"),
            Some("env:OPENAI_API_KEY")
        ));
        assert!(
            node_version_key(Path::new("/tmp/v22.10.1"))
                > node_version_key(Path::new("/tmp/v20.18.0"))
        );
        assert_eq!(
            provider_runtime_status_from_output(
                r#"{"error":"authentication_failed","message":"Invalid authentication credentials"}"#
            ),
            "not-logged-in"
        );
        assert_eq!(
            provider_runtime_status_from_output("Failed to authenticate: unauthorized"),
            "not-logged-in"
        );
    }
}
