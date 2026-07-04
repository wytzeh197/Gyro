use crate::paths::GyroPaths;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateChannel {
    Stable,
    Beta,
    Nightly,
}

impl Default for UpdateChannel {
    fn default() -> Self {
        Self::Stable
    }
}

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
#[serde(rename_all = "camelCase")]
pub struct CommandProfile {
    pub id: String,
    pub display_name: String,
    pub command: String,
    pub args: Vec<String>,
    pub working_directory: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GyroConfig {
    pub update_channel: UpdateChannel,
    pub telemetry_enabled: bool,
    pub require_command_approval: bool,
    pub require_file_edit_approval: bool,
    pub model_providers: Vec<ModelProviderConfig>,
    pub command_profiles: Vec<CommandProfile>,
}

impl Default for GyroConfig {
    fn default() -> Self {
        Self {
            update_channel: UpdateChannel::Stable,
            telemetry_enabled: false,
            require_command_approval: true,
            require_file_edit_approval: true,
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
                },
                CommandProfile {
                    id: "claude-code".into(),
                    display_name: "Claude Code".into(),
                    command: "claude".into(),
                    args: Vec::new(),
                    working_directory: None,
                },
                CommandProfile {
                    id: "codex".into(),
                    display_name: "Codex CLI".into(),
                    command: "codex".into(),
                    args: Vec::new(),
                    working_directory: None,
                },
            ],
        }
    }
}

impl GyroConfig {
    pub fn load(paths: &GyroPaths) -> Result<Self> {
        if !paths.config_path.exists() {
            return Ok(Self::default());
        }
        let raw = std::fs::read_to_string(&paths.config_path)
            .with_context(|| format!("read {}", paths.config_path.display()))?;
        serde_json::from_str(&raw).with_context(|| format!("parse {}", paths.config_path.display()))
    }

    pub fn save(&self, paths: &GyroPaths) -> Result<()> {
        paths.ensure()?;
        let raw = serde_json::to_string_pretty(self)?;
        std::fs::write(&paths.config_path, format!("{raw}\n"))
            .with_context(|| format!("write {}", paths.config_path.display()))
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
        assert_eq!(config.update_channel, UpdateChannel::Stable);
    }
}
