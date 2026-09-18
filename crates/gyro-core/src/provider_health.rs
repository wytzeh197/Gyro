use crate::execution::{
    run_command, CancellationToken, ExecutionOutcome, ExecutionRequest, ExecutionTermination,
};
use crate::{
    check_acp_health, check_kimi_acp_health, discover_ollama_models, health_kind_for,
    openai_compat_endpoint, openai_compat_host_is_loopback, openai_compat_list_models,
    provider_api_key_env_name, provider_api_key_value, provider_has_api_key,
    stored_provider_api_key_env, KimiAcpHealthStatus, ProviderHealthKind,
};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

const PROVIDER_HEALTH_TIMEOUT: Duration = Duration::from_secs(10);
const PROVIDER_HEALTH_MAX_STDOUT_CHARS: usize = 32 * 1024;
const PROVIDER_HEALTH_MAX_STDERR_CHARS: usize = 16 * 1024;
// Local provider CLIs can briefly lose their socket while their own updater,
// keychain helper, or device-code flow is settling. One short retry keeps that
// transient state from being presented as a broken provider, without making a
// settings refresh slow or hiding persistent setup failures.
const PROVIDER_HEALTH_ATTEMPTS: usize = 2;
const PROVIDER_HEALTH_RETRY_DELAY: Duration = Duration::from_millis(250);

/// How long a probe result may answer for a provider without probing again.
///
/// A probe starts a provider CLI (`codex login status`, `claude auth status`)
/// or calls a local endpoint, so it costs hundreds of milliseconds and a child
/// process. The desktop legitimately asks for the same answer more than once —
/// a config save re-runs the readiness sweep, and the sign-in watcher re-asks
/// while a login settles — and every repeat used to spawn the CLI again. This
/// window absorbs those repeats while staying well under the time it takes a
/// person to finish a browser sign-in and press Connect again; every explicit
/// user action passes `force` and probes for real.
pub const PROVIDER_HEALTH_CACHE_TTL: Duration = Duration::from_secs(30);

/// Cap on distinct providers held, so a session probing many hand-added
/// endpoints cannot grow the map without bound.
const PROVIDER_HEALTH_CACHE_CAPACITY: usize = 64;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderHealthRequest {
    pub provider_id: String,
    pub base_url: Option<String>,
    pub api_key_ref: Option<String>,
    /// Config `kind`, for a provider the static registry does not describe.
    ///
    /// A user-defined provider is only identifiable from its config entry, and
    /// its health probe has to follow the same resolution the runner does.
    #[serde(default)]
    pub kind: Option<String>,
    /// Probe now even when a cached result is still fresh.
    ///
    /// Set by an explicit user action — Settings' "Test provider" and the check
    /// that follows a completed sign-in — where a stale answer would misreport
    /// what the person just did. Background readiness sweeps leave it unset so
    /// their repeats are served from the cache.
    #[serde(default)]
    pub force: bool,
}

/// A cached probe result and when it was taken.
type ProviderHealthCacheEntry = (Instant, ProviderHealthCheck);

/// Probe results keyed by everything a probe actually reads.
///
/// `api_key_ref` and `base_url` are part of the key because a stored-key or
/// endpoint change must not inherit the previous answer, and an absent ref is
/// normalized with an empty one so both spellings share a single entry.
fn provider_health_cache_key(request: &ProviderHealthRequest) -> String {
    let normalize = |value: &Option<String>| {
        value
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("")
            .to_string()
    };
    format!(
        "{}\u{1f}{}\u{1f}{}\u{1f}{}",
        request.provider_id.trim(),
        normalize(&request.api_key_ref),
        normalize(&request.base_url),
        normalize(&request.kind),
    )
}

static PROVIDER_HEALTH_CACHE: Mutex<Vec<(String, ProviderHealthCacheEntry)>> =
    Mutex::new(Vec::new());

/// Best-effort cached lookup. A poisoned lock and a miss both mean "probe".
fn cached_provider_health(request: &ProviderHealthRequest) -> Option<ProviderHealthCheck> {
    let key = provider_health_cache_key(request);
    let mut cache = PROVIDER_HEALTH_CACHE.lock().ok()?;
    cache.retain(|(_, (taken_at, _))| taken_at.elapsed() < PROVIDER_HEALTH_CACHE_TTL);
    cache
        .iter()
        .find(|(entry_key, _)| entry_key == &key)
        .map(|(_, (_, check))| check.clone())
}

fn remember_provider_health(request: &ProviderHealthRequest, check: &ProviderHealthCheck) {
    let Ok(mut cache) = PROVIDER_HEALTH_CACHE.lock() else {
        return;
    };
    let key = provider_health_cache_key(request);
    cache.retain(|(entry_key, (taken_at, _))| {
        entry_key != &key && taken_at.elapsed() < PROVIDER_HEALTH_CACHE_TTL
    });
    if cache.len() >= PROVIDER_HEALTH_CACHE_CAPACITY {
        cache.remove(0);
    }
    cache.push((key, (Instant::now(), check.clone())));
}

/// Drop every cached probe result.
///
/// Called when Gyro itself changes what a probe would see — a stored API key
/// was written or cleared — so the next readiness sweep reports the new state
/// instead of waiting out the TTL.
pub fn invalidate_provider_health_cache() {
    if let Ok(mut cache) = PROVIDER_HEALTH_CACHE.lock() {
        cache.clear();
    }
}

/// One provider's readiness, reusing a recent probe unless `force` is set.
///
/// This is the entry point the desktop command uses; it exists so the cache is
/// consulted for readiness sweeps without making an explicit user action serve
/// a stale answer.
pub fn provider_health(request: ProviderHealthRequest) -> Result<ProviderHealthCheck> {
    if !request.force {
        if let Some(check) = cached_provider_health(&request) {
            return Ok(check);
        }
    }
    let check = ProviderHealthService.check(request.clone())?;
    remember_provider_health(&request, &check);
    Ok(check)
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
/// How to probe one provider CLI for readiness. These were six adjacent `&str`
/// parameters, where transposing `auth_owner` and `command` still compiled and
/// silently reported the wrong login instructions; named fields make the call
/// sites checkable.
struct CliProbe<'a> {
    provider_id: &'a str,
    auth_owner: &'a str,
    command: &'a str,
    args: &'a [&'a str],
    login_command: Option<&'a str>,
    secret_storage: &'a str,
}

pub struct ProviderHealthService;

impl ProviderHealthService {
    pub fn check(&self, request: ProviderHealthRequest) -> Result<ProviderHealthCheck> {
        let health_kind = health_kind_for(&request.provider_id, request.kind.as_deref())
            .ok_or_else(|| anyhow::anyhow!("unknown provider `{}`", request.provider_id))?;
        match health_kind {
            ProviderHealthKind::CodexCli => self.check_openai(request),
            ProviderHealthKind::ClaudeCli => self.check_cli_or_stored_key(
                &CliProbe {
                    provider_id: "anthropic",
                    auth_owner: "provider-cli",
                    command: "claude",
                    args: &["auth", "status"],
                    login_command: Some("claude auth login"),
                    secret_storage: "Provider CLI, OS Keychain, or provider-owned files",
                },
                &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
            ),
            ProviderHealthKind::KimiAcp => Ok(acp_provider_health(&request.provider_id)),
            ProviderHealthKind::CursorCli => Ok(acp_provider_health(&request.provider_id)),
            ProviderHealthKind::Environment if request.provider_id == "xai" => Ok(
                env_provider_health("xai", request.api_key_ref.as_deref(), &["XAI_API_KEY"]),
            ),
            ProviderHealthKind::Environment => Ok(env_provider_health(
                &request.provider_id,
                request.api_key_ref.as_deref(),
                &[
                    "GEMINI_API_KEY",
                    "GOOGLE_API_KEY",
                    "GOOGLE_APPLICATION_CREDENTIALS",
                ],
            )),
            ProviderHealthKind::OpenCodeCli => Ok(acp_provider_health(&request.provider_id)),
            ProviderHealthKind::OllamaApi => {
                Ok(ollama_provider_health(request.base_url.as_deref()))
            }
            ProviderHealthKind::OpenAiCompatibleApi => Ok(openai_compatible_provider_health(
                &request.provider_id,
                request.base_url.as_deref(),
            )),
        }
    }

    fn check_openai(&self, request: ProviderHealthRequest) -> Result<ProviderHealthCheck> {
        if should_skip_codex_login_for_external_env(
            request.base_url.as_deref(),
            request.api_key_ref.as_deref(),
        ) || provider_has_api_key("openai")
        {
            return Ok(env_provider_health(
                "openai",
                request.api_key_ref.as_deref(),
                &["OPENAI_API_KEY"],
            ));
        }

        self.cli_check(&CliProbe {
            provider_id: "openai",
            auth_owner: "provider-cli",
            command: "codex",
            args: &["login", "status"],
            login_command: Some("codex login --device-auth"),
            secret_storage: "Provider CLI, OS Keychain, or provider-owned files",
        })
    }

    fn check_cli_or_stored_key(
        &self,
        probe: &CliProbe<'_>,
        env_names: &[&str],
    ) -> Result<ProviderHealthCheck> {
        if provider_has_api_key(probe.provider_id) {
            return Ok(env_provider_health(probe.provider_id, None, env_names));
        }
        self.cli_check(probe)
    }

    fn cli_check(&self, probe: &CliProbe<'_>) -> Result<ProviderHealthCheck> {
        let &CliProbe {
            provider_id,
            auth_owner,
            command,
            args,
            login_command,
            secret_storage,
        } = probe;
        let auth_command = std::iter::once(command)
            .chain(args.iter().copied())
            .collect::<Vec<_>>()
            .join(" ");
        let output = match command_output(command, args, provider_id) {
            Ok(output) => output,
            Err(CommandOutputError::Unavailable(error)) => {
                format!("{command} unavailable: {error}")
            }
            Err(CommandOutputError::Terminated(error)) => {
                format!("{command} health check failed: {error}")
            }
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

fn ollama_provider_health(base_url: Option<&str>) -> ProviderHealthCheck {
    match discover_ollama_models(base_url) {
        Ok(discovery) => {
            let model_summary = if discovery.models.is_empty() {
                "Ollama is running, but no models are installed. Run `ollama pull <model>` and refresh Gyro."
                    .to_string()
            } else {
                format!(
                    "Ollama is running at {}; {} local model{} discovered.",
                    discovery.base_url,
                    discovery.models.len(),
                    if discovery.models.len() == 1 { "" } else { "s" }
                )
            };
            ProviderHealthCheck {
                provider_id: "ollama".into(),
                output: model_summary,
                // A reachable service without an installed model cannot run a
                // chat. Keep the runtime distinct from a missing Ollama
                // install so the UI can tell the user exactly what to do.
                runtime_status: if discovery.models.is_empty() {
                    "no-models".into()
                } else {
                    "ready".into()
                },
                auth_owner: "provider-sdk".into(),
                auth_command: None,
                login_command: None,
                account_label: None,
                subscription_label: None,
                provider_mode: Some("local Ollama runtime".into()),
                secret_storage: "No credentials; Ollama is contacted only over loopback.".into(),
                privacy_note: "Gyro sends prompts only to the configured loopback Ollama runtime.".into(),
                diagnostics_opt_in: false,
            }
        }
        Err(error) => ProviderHealthCheck {
            provider_id: "ollama".into(),
            output: crate::security::redact_secrets(&format!(
                "Ollama is unavailable: {error}. Install and start Ollama, then run `ollama pull <model>`."
            )),
            runtime_status: "not-installed".into(),
            auth_owner: "provider-sdk".into(),
            auth_command: None,
            login_command: None,
            account_label: None,
            subscription_label: None,
            provider_mode: Some("local Ollama runtime".into()),
            secret_storage: "No credentials; Ollama is contacted only over loopback.".into(),
            privacy_note: "Gyro sends prompts only to the configured loopback Ollama runtime.".into(),
            diagnostics_opt_in: false,
        },
    }
}

/// Readiness for a provider Gyro reaches over HTTPS with an API key.
///
/// Asking for the model list is what proves the key works; a TCP connect would
/// only prove the host exists. A stored key whose endpoint cannot be reached is
/// deliberately a warning rather than a failure: an offline laptop must not
/// make a valid key look rejected, so the message says which half failed.
fn openai_compatible_provider_health(
    provider_id: &str,
    base_url: Option<&str>,
) -> ProviderHealthCheck {
    let check = |output: String, runtime_status: &str| ProviderHealthCheck {
        provider_id: provider_id.into(),
        output: crate::security::redact_secrets(&output),
        runtime_status: runtime_status.into(),
        auth_owner: "provider-sdk".into(),
        auth_command: None,
        login_command: None,
        account_label: None,
        subscription_label: None,
        provider_mode: Some("OpenAI-compatible HTTPS".into()),
        secret_storage: "macOS Keychain, or the provider's environment variable".into(),
        privacy_note:
            "Gyro sends prompts straight to the endpoint you configured; no vendor CLI is involved."
                .into(),
        diagnostics_opt_in: false,
    };
    let Some(raw) = base_url.map(str::trim).filter(|value| !value.is_empty()) else {
        return check(
            "No base URL is set for this provider. Add one in Settings > Providers, for example https://api.deepseek.com/v1.".into(),
            "warning",
        );
    };
    let endpoint = match openai_compat_endpoint(raw) {
        Ok(endpoint) => endpoint,
        Err(error) => {
            return check(
                format!("This provider's base URL cannot be used: {error}"),
                "warning",
            )
        }
    };
    let api_key = provider_api_key_value(provider_id);
    if api_key.is_none() && !openai_compat_host_is_loopback(&endpoint) {
        let env_hint = provider_api_key_env_name(provider_id)
            .map(|name| format!(", or set {name}"))
            .unwrap_or_default();
        return check(
            format!(
                "No API key is stored for this provider. Add one in Settings > Providers{env_hint}."
            ),
            "not-logged-in",
        );
    }
    match openai_compat_list_models(endpoint.as_str(), api_key.as_deref().unwrap_or_default()) {
        Ok(discovery) if discovery.models.is_empty() => check(
            format!(
                "{} answered but reported no models; check that the base URL includes the API path.",
                discovery.base_url
            ),
            "no-models",
        ),
        Ok(discovery) => check(
            format!(
                "Connected to {}; {} model{} available.",
                discovery.base_url,
                discovery.models.len(),
                if discovery.models.len() == 1 { "" } else { "s" }
            ),
            "ready",
        ),
        Err(error) if api_key.is_some() => check(
            format!("A key is stored, but the endpoint could not be reached: {error}"),
            "warning",
        ),
        Err(error) => check(
            format!("{endpoint} is unavailable: {error}"),
            "not-installed",
        ),
    }
}

fn kimi_provider_health() -> ProviderHealthCheck {
    let health = check_kimi_acp_health("kimi", PROVIDER_HEALTH_TIMEOUT);
    let runtime_status = match health.status {
        KimiAcpHealthStatus::Ready => "ready",
        KimiAcpHealthStatus::NotInstalled => "not-installed",
        KimiAcpHealthStatus::NotLoggedIn => "not-logged-in",
        KimiAcpHealthStatus::Warning => "warning",
    };
    ProviderHealthCheck {
        provider_id: "kimi".into(),
        output: health.output,
        runtime_status: runtime_status.into(),
        auth_owner: "provider-cli".into(),
        auth_command: Some("kimi acp".into()),
        login_command: Some("kimi login".into()),
        account_label: None,
        subscription_label: None,
        provider_mode: Some("Kimi Code ACP".into()),
        secret_storage: "Kimi Code provider-owned files".into(),
        privacy_note: "Gyro stores readiness summaries only; Kimi tokens stay outside Gyro.".into(),
        diagnostics_opt_in: false,
    }
}

fn acp_provider_health(provider_id: &str) -> ProviderHealthCheck {
    use std::ffi::OsString;

    let (label, command, args, mut auth_methods, login_command) = match provider_id {
        "xai" => (
            "xAI",
            "grok",
            vec!["--no-auto-update", "agent", "stdio"],
            vec!["xai.api_key", "cached_token"],
            "grok login",
        ),
        "gemini" => (
            "Gemini",
            "gemini",
            vec!["--acp"],
            vec!["oauth-personal", "gemini-api-key", "vertex-ai", "login"],
            "gemini",
        ),
        "cursor" => (
            "Cursor",
            "cursor-agent",
            vec!["acp"],
            vec!["cursor_login"],
            "cursor-agent login",
        ),
        "opencode" => (
            "OpenCode",
            "opencode",
            vec!["acp"],
            vec!["opencode-login"],
            "opencode auth login",
        ),
        _ => return kimi_provider_health(),
    };
    if provider_id == "xai" {
        let preferred = if provider_has_api_key("xai") {
            "xai.api_key"
        } else {
            "cached_token"
        };
        auth_methods.sort_by_key(|method| usize::from(*method != preferred));
    } else if provider_id == "gemini" {
        let preferred = if provider_has_api_key("gemini") {
            Some("gemini-api-key")
        } else if std::env::var_os("GOOGLE_GENAI_USE_VERTEXAI").is_some()
            || std::env::var_os("GOOGLE_APPLICATION_CREDENTIALS").is_some()
        {
            Some("vertex-ai")
        } else {
            None
        };
        if let Some(preferred) = preferred {
            auth_methods.sort_by_key(|method| usize::from(*method != preferred));
        }
    }
    let health = check_acp_health(
        label,
        command,
        args.into_iter().map(OsString::from).collect(),
        &auth_methods,
        PROVIDER_HEALTH_TIMEOUT,
    );
    let runtime_status = match health.status {
        KimiAcpHealthStatus::Ready => "ready",
        KimiAcpHealthStatus::NotInstalled => "not-installed",
        KimiAcpHealthStatus::NotLoggedIn => "not-logged-in",
        KimiAcpHealthStatus::Warning => "warning",
    };
    // OpenCode's ACP authenticate method acknowledges the method id without
    // validating credentials for its selected model.
    let output = if provider_id == "opencode" && runtime_status == "ready" {
        "OpenCode ACP is available. Model credentials and access are verified only when a prompt runs.".into()
    } else {
        health.output
    };
    ProviderHealthCheck {
        provider_id: provider_id.into(),
        output,
        runtime_status: runtime_status.into(),
        auth_owner: "provider-cli".into(),
        auth_command: Some(format!("{command} ACP handshake")),
        login_command: Some(login_command.into()),
        account_label: None,
        subscription_label: None,
        provider_mode: Some("local-subscription-cli".into()),
        secret_storage: "Provider CLI, OS Keychain, or provider-owned files".into(),
        privacy_note:
            "Gyro checks the local ACP login state without reading provider credential values."
                .into(),
        diagnostics_opt_in: false,
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
    let keychain_key = provider_has_api_key(provider_id) && present_env.is_none();
    let output = if let Some(env_name) = present_env.as_deref() {
        format!(
            "{provider_id} provider-env auth available; {env_name} is set; value not read by Gyro."
        )
    } else if keychain_key {
        let env_name = env_names.first().map(String::as_str).unwrap_or("API_KEY");
        format!(
            "{provider_id} provider-env auth available; {env_name} is stored in macOS Keychain; key value omitted."
        )
    } else {
        format!(
            "{provider_id} provider-env auth missing; configure one of {} outside Gyro.",
            env_names.join(", ")
        )
    };

    ProviderHealthCheck {
        provider_id: provider_id.into(),
        runtime_status: if present_env.is_some() || keychain_key {
            "ready".into()
        } else {
            "not-logged-in".into()
        },
        auth_owner: "provider-env".into(),
        auth_command: None,
        login_command: None,
        account_label: None,
        subscription_label: None,
        provider_mode: Some(if keychain_key {
            "keychain-owned auth".into()
        } else {
            "environment-owned auth".into()
        }),
        secret_storage: if keychain_key {
            "macOS Keychain".into()
        } else {
            "Environment variable or provider SDK store".into()
        },
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
        || normalized.contains("unavailable")
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

#[derive(Debug, Eq, PartialEq)]
enum CommandOutputError {
    Unavailable(String),
    Terminated(String),
}

fn command_output(
    command: &str,
    args: &[&str],
    provider_id: &str,
) -> std::result::Result<String, CommandOutputError> {
    let mut result = command_output_with_limits(
        command,
        args,
        provider_id,
        PROVIDER_HEALTH_TIMEOUT,
        PROVIDER_HEALTH_MAX_STDOUT_CHARS,
        PROVIDER_HEALTH_MAX_STDERR_CHARS,
    );

    for attempt in 1..PROVIDER_HEALTH_ATTEMPTS {
        if !is_transient_health_result(&result) {
            break;
        }
        // A bounded, deterministic delay avoids retry storms when settings
        // checks several providers at once. Do not retry authentication or
        // installation problems: neither can recover without user action.
        thread::sleep(PROVIDER_HEALTH_RETRY_DELAY * attempt as u32);
        result = command_output_with_limits(
            command,
            args,
            provider_id,
            PROVIDER_HEALTH_TIMEOUT,
            PROVIDER_HEALTH_MAX_STDOUT_CHARS,
            PROVIDER_HEALTH_MAX_STDERR_CHARS,
        );
    }

    result
}

fn is_transient_health_result(result: &std::result::Result<String, CommandOutputError>) -> bool {
    let output = match result {
        Ok(output) => output,
        Err(CommandOutputError::Unavailable(output) | CommandOutputError::Terminated(output)) => {
            output
        }
    }
    .to_ascii_lowercase();

    [
        "timed out",
        "temporarily unavailable",
        "resource temporarily unavailable",
        "connection reset",
        "connection refused",
        "network is unreachable",
        "broken pipe",
        "econnreset",
        "eagain",
        "rate limit",
        "too many requests",
        "service unavailable",
        "try again",
    ]
    .iter()
    .any(|marker| output.contains(marker))
}

fn command_output_with_limits(
    command: &str,
    args: &[&str],
    provider_id: &str,
    timeout: Duration,
    max_stdout_chars: usize,
    max_stderr_chars: usize,
) -> std::result::Result<String, CommandOutputError> {
    let mut request = ExecutionRequest::new(command);
    request.args = args.iter().copied().map(OsString::from).collect();
    request.timeout = timeout;
    request.max_stdout_chars = max_stdout_chars;
    request.max_stderr_chars = max_stderr_chars;
    if !command.contains('/') {
        request.env.push((
            OsString::from("PATH"),
            Some(OsString::from(crate::cli_path::augmented_gui_path())),
        ));
    }
    if let Some((name, value)) = stored_provider_api_key_env(provider_id) {
        request.env.push((name, Some(value)));
    }
    let outcome = run_command(request, CancellationToken::default(), |_| {})
        .map_err(|error| CommandOutputError::Unavailable(error.to_string()))?;
    match &outcome.termination {
        ExecutionTermination::Exited { code } => {
            let mut combined = combined_command_output(&outcome);
            if let Some(code) = code.filter(|code| *code != 0) {
                if !combined.is_empty() {
                    combined.push('\n');
                }
                combined.push_str(&format!(
                    "[{command} health check failed with exit status {code}]"
                ));
            }
            if combined.is_empty() {
                let status = match code {
                    Some(code) => format!("exit status: {code}"),
                    None => "termination without an exit code".into(),
                };
                Ok(format!("{command} exited with {status}"))
            } else {
                Ok(combined)
            }
        }
        ExecutionTermination::TimedOut => Err(CommandOutputError::Terminated(format!(
            "timed out after {timeout:?}"
        ))),
        ExecutionTermination::Cancelled => {
            Err(CommandOutputError::Terminated("was cancelled".into()))
        }
        ExecutionTermination::Inactive => Err(CommandOutputError::Terminated(
            "stopped after becoming inactive".into(),
        )),
        ExecutionTermination::OutputLimit => Err(CommandOutputError::Terminated(
            "exceeded its output limit".into(),
        )),
    }
}

fn combined_command_output(outcome: &ExecutionOutcome) -> String {
    let stdout = retained_stream_output(
        &outcome.stdout,
        outcome.stdout_truncated,
        "stdout truncated",
    );
    let stderr = retained_stream_output(
        &outcome.stderr,
        outcome.stderr_truncated,
        "stderr truncated",
    );
    [stdout, stderr]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn retained_stream_output(output: &str, truncated: bool, marker: &str) -> String {
    let mut output = output.trim().to_string();
    if truncated {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push('[');
        output.push_str(marker);
        output.push(']');
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;

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

    #[cfg(unix)]
    #[test]
    fn bounded_health_command_reports_timeout() {
        let error = command_output_with_limits(
            "/bin/sh",
            &["-c", "sleep 5"],
            "openai",
            Duration::from_millis(50),
            128,
            128,
        )
        .unwrap_err();

        assert_eq!(
            error,
            CommandOutputError::Terminated("timed out after 50ms".into())
        );
    }

    #[cfg(unix)]
    #[test]
    fn bounded_health_command_marks_truncated_output() {
        let output = command_output_with_limits(
            "/bin/sh",
            &["-c", "printf 123456789"],
            "openai",
            Duration::from_secs(1),
            4,
            4,
        )
        .unwrap();

        assert_eq!(output, "1234\n[stdout truncated]");
    }

    #[cfg(unix)]
    #[test]
    fn nonzero_health_command_is_never_reported_as_inconclusive() {
        let output = command_output_with_limits(
            "/bin/sh",
            &["-c", "exit 17"],
            "openai",
            Duration::from_secs(1),
            128,
            128,
        )
        .unwrap();

        assert_eq!(provider_runtime_status_from_output(&output), "warning");
        assert!(output.contains("health check failed with exit status 17"));
    }

    #[test]
    fn transient_unavailability_is_a_warning_not_missing_auth() {
        assert_eq!(
            provider_runtime_status_from_output(
                "codex unavailable: Resource temporarily unavailable"
            ),
            "warning"
        );
    }

    #[test]
    fn retries_only_transient_provider_health_failures() {
        assert!(is_transient_health_result(&Err(
            CommandOutputError::Terminated("timed out after 10s".into())
        )));
        assert!(is_transient_health_result(&Ok(
            "provider health check failed: connection reset by peer".into()
        )));
        assert!(!is_transient_health_result(&Ok(
            "not authenticated; run provider login".into()
        )));
        assert!(!is_transient_health_result(&Err(
            CommandOutputError::Unavailable("No such file or directory".into())
        )));
    }

    #[test]
    fn ollama_without_installed_models_is_not_ready_to_use() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request_line = String::new();
            BufReader::new(&mut stream)
                .read_line(&mut request_line)
                .unwrap();
            assert!(request_line.starts_with("GET /api/tags"));
            let body = r#"{"models":[]}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });

        let health = ollama_provider_health(Some(&format!("http://{address}/api")));
        server.join().unwrap();

        assert_eq!(health.runtime_status, "no-models");
        assert!(health.output.contains("no models are installed"));
    }

    fn cache_probe_request(provider_id: &str, base_url: Option<&str>) -> ProviderHealthRequest {
        ProviderHealthRequest {
            provider_id: provider_id.to_string(),
            base_url: base_url.map(str::to_string),
            api_key_ref: None,
            kind: None,
            force: false,
        }
    }

    /// A readiness sweep asks the same question repeatedly. Each repeat used to
    /// start a provider CLI again; the repeat must now be answered from the
    /// probe already taken, while an explicit user action still probes for real.
    #[test]
    fn repeat_readiness_probes_reuse_the_recent_result() {
        invalidate_provider_health_cache();
        let request = cache_probe_request("cursor", None);

        let first = provider_health(request.clone()).unwrap();
        // Reads whatever this machine actually has; the value only has to be
        // reproducible for the cache assertions below.
        let probed_status = first.runtime_status.clone();
        assert!(
            cached_provider_health(&request).is_some(),
            "a completed probe should be remembered for the readiness sweep"
        );

        // What the desktop would show if a cached answer were ever stale.
        let mut poisoned = first.clone();
        poisoned.runtime_status = "ready".into();
        remember_provider_health(&request, &poisoned);
        assert_eq!(
            provider_health(request.clone()).unwrap().runtime_status,
            "ready",
            "an unforced repeat is served from the cache"
        );

        let forced = ProviderHealthRequest {
            force: true,
            ..request.clone()
        };
        assert_eq!(
            provider_health(forced).unwrap().runtime_status,
            probed_status,
            "a forced probe ignores the cached answer"
        );
        invalidate_provider_health_cache();
        assert_eq!(
            provider_health(request).unwrap().runtime_status,
            probed_status,
            "an invalidated cache re-probes instead of answering stale"
        );
    }

    /// The probe reads the endpoint it is pointed at, so a different endpoint
    /// must not inherit the previous one's answer.
    #[test]
    fn probe_cache_is_keyed_by_the_endpoint_it_probed() {
        invalidate_provider_health_cache();
        let request = cache_probe_request("ollama", Some("http://127.0.0.1:9/api"));
        let mut poisoned = ProviderHealthService
            .check(cache_probe_request("ollama", Some("http://127.0.0.1:9/api")))
            .unwrap();
        poisoned.output = "cached for the first endpoint".into();
        poisoned.runtime_status = "ready".into();
        remember_provider_health(&request, &poisoned);

        let other = cache_probe_request("ollama", Some("http://127.0.0.1:10/api"));
        let answered = provider_health(other).unwrap();
        assert_ne!(
            answered.output, "cached for the first endpoint",
            "a different base URL must probe instead of reusing another endpoint's answer"
        );
        invalidate_provider_health_cache();
    }
}
