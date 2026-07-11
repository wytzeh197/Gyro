use crate::paths::GyroPaths;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProviderConfig {
    pub id: String,
    pub display_name: String,
    pub base_url: Option<String>,
    pub api_key_ref: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CommandProfileReadiness {
    Ready,
    Waiting,
    Blocked,
}

impl Default for CommandProfileReadiness {
    fn default() -> Self {
        Self::Waiting
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandProfile {
    pub id: String,
    pub display_name: String,
    pub command: String,
    pub args: Vec<String>,
    pub working_directory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(default)]
    pub readiness: CommandProfileReadiness,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountOidcConfig {
    pub issuer_url: String,
    pub client_id: String,
    pub redirect_loopback_base: String,
    pub scopes: Vec<String>,
}

impl Default for AccountOidcConfig {
    fn default() -> Self {
        Self {
            issuer_url: std::env::var("GYRO_OIDC_ISSUER_URL")
                .unwrap_or_else(|_| "local-device://gyro".into()),
            client_id: std::env::var("GYRO_OIDC_CLIENT_ID")
                .unwrap_or_else(|_| "gyro-local-device".into()),
            redirect_loopback_base: "http://127.0.0.1".into(),
            scopes: vec![
                "openid".into(),
                "profile".into(),
                "email".into(),
                "offline_access".into(),
            ],
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSessionState {
    pub signed_in: bool,
    pub user_id: Option<String>,
    pub email: Option<String>,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub issuer: Option<String>,
    pub expires_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GyroConfig {
    #[serde(default = "default_automatic_update_checks")]
    pub automatic_update_checks: bool,
    pub telemetry_enabled: bool,
    pub require_command_approval: bool,
    pub require_file_edit_approval: bool,
    #[serde(default)]
    pub account_oidc: AccountOidcConfig,
    #[serde(default)]
    pub account_session: AccountSessionState,
    pub model_providers: Vec<ModelProviderConfig>,
    pub command_profiles: Vec<CommandProfile>,
}

impl Default for GyroConfig {
    fn default() -> Self {
        Self {
            automatic_update_checks: true,
            telemetry_enabled: false,
            require_command_approval: true,
            require_file_edit_approval: true,
            account_oidc: AccountOidcConfig::default(),
            account_session: AccountSessionState::default(),
            model_providers: vec![
                ModelProviderConfig {
                    id: "openai".into(),
                    display_name: "OpenAI".into(),
                    base_url: None,
                    api_key_ref: "provider:openai".into(),
                    enabled: false,
                },
                ModelProviderConfig {
                    id: "anthropic".into(),
                    display_name: "Anthropic".into(),
                    base_url: None,
                    api_key_ref: "provider:anthropic".into(),
                    enabled: false,
                },
            ],
            command_profiles: vec![
                CommandProfile {
                    id: "shell".into(),
                    display_name: "Shell".into(),
                    command: std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into()),
                    args: Vec::new(),
                    working_directory: None,
                    provider_id: None,
                    default_model: None,
                    readiness: CommandProfileReadiness::Ready,
                },
                CommandProfile {
                    id: "claude-code".into(),
                    display_name: "Claude Code".into(),
                    command: "claude".into(),
                    args: Vec::new(),
                    working_directory: None,
                    provider_id: Some("anthropic".into()),
                    default_model: None,
                    readiness: CommandProfileReadiness::Waiting,
                },
                CommandProfile {
                    id: "codex".into(),
                    display_name: "Codex CLI".into(),
                    command: "codex".into(),
                    args: Vec::new(),
                    working_directory: None,
                    provider_id: Some("openai".into()),
                    default_model: None,
                    readiness: CommandProfileReadiness::Waiting,
                },
            ],
        }
    }
}

fn default_automatic_update_checks() -> bool {
    true
}

impl GyroConfig {
    pub fn load(paths: &GyroPaths) -> Result<Self> {
        if !paths.config_path.exists() {
            return Ok(Self::default());
        }
        let raw = std::fs::read_to_string(&paths.config_path)
            .with_context(|| format!("read {}", paths.config_path.display()))?;
        let mut config: Self = serde_json::from_str(&raw)
            .with_context(|| format!("parse {}", paths.config_path.display()))?;
        config.normalize_legacy_account_state();
        Ok(config)
    }

    pub fn save(&self, paths: &GyroPaths) -> Result<()> {
        paths.ensure()?;
        let raw = serde_json::to_string_pretty(self)?;
        std::fs::write(&paths.config_path, format!("{raw}\n"))
            .with_context(|| format!("write {}", paths.config_path.display()))
    }

    fn normalize_legacy_account_state(&mut self) {
        let legacy_hosted_placeholder = self.account_oidc.issuer_url.trim_end_matches('/')
            == "https://auth.gyro.dev"
            && self.account_oidc.client_id == "gyro-desktop";
        if legacy_hosted_placeholder {
            self.account_oidc = AccountOidcConfig::default();
        }

        let legacy_local_development = self.account_session.issuer.as_deref()
            == Some("local-development://gyro")
            || self.account_session.user_id.as_deref() == Some("local-development-user");
        if legacy_local_development {
            self.account_session.user_id = Some("local-device".into());
            self.account_session.email = None;
            self.account_session.name = Some("This Mac".into());
            self.account_session.issuer = Some("local-device://gyro".into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_local_first() {
        let config = GyroConfig::default();
        assert!(!config.telemetry_enabled);
        assert!(config.require_command_approval);
        assert!(config.require_file_edit_approval);
        assert!(config.automatic_update_checks);
        assert_eq!(
            config.account_oidc.scopes,
            vec![
                String::from("openid"),
                String::from("profile"),
                String::from("email"),
                String::from("offline_access")
            ]
        );
        assert!(!config.account_session.signed_in);
    }

    #[test]
    fn old_configs_default_account_fields() {
        let config: GyroConfig = serde_json::from_str(
            r#"{
              "updateChannel": "stable",
              "telemetryEnabled": false,
              "requireCommandApproval": true,
              "requireFileEditApproval": true,
              "modelProviders": [],
              "commandProfiles": []
            }"#,
        )
        .unwrap();

        assert!(!config.account_oidc.client_id.is_empty());
        assert!(!config.account_session.signed_in);
        assert!(config.automatic_update_checks);
        assert!(serde_json::to_value(config)
            .unwrap()
            .get("updateChannel")
            .is_none());
    }

    #[test]
    fn old_command_profiles_default_execution_metadata() {
        let profile: CommandProfile = serde_json::from_str(
            r#"{
              "id": "codex",
              "displayName": "Codex CLI",
              "command": "codex",
              "args": [],
              "workingDirectory": null
            }"#,
        )
        .unwrap();

        assert_eq!(profile.provider_id, None);
        assert_eq!(profile.default_model, None);
        assert_eq!(profile.readiness, CommandProfileReadiness::Waiting);
    }
}
