//! Vendor install guidance for providers whose CLI is missing on this device.
//!
//! The desktop app, `gyro setup`, and the provider health payload all read this
//! one table, so a corrected installer is fixed once. A row either carries a
//! runnable vendor installer (`command`) or is a docs-only pointer
//! (`command: None`). Gyro never installs on its own: the command is shown
//! first and runs only after the user confirms it.

use serde::Serialize;

/// Vendor install guidance for one provider.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInstallGuide {
    /// Provider id from [`crate::provider_registry`].
    pub provider_id: &'static str,
    /// Executable that has to end up on `PATH`.
    pub binary: &'static str,
    /// Vendor installer, or `None` when Gyro has no verified command to offer.
    pub command: Option<&'static str>,
    /// Official page that documents the installer.
    pub docs_url: &'static str,
    /// One sentence shown under the command.
    pub summary: &'static str,
}

/// One row per registry provider.
///
/// Rows with `command: None` are API-key providers or CLIs whose installer
/// Gyro has not verified, so the UI shows the docs link instead of a command
/// the user could paste and only then discover is wrong.
pub const PROVIDER_INSTALL_GUIDES: &[ProviderInstallGuide] = &[
    ProviderInstallGuide {
        provider_id: "openai",
        binary: "codex",
        command: Some("npm install -g @openai/codex"),
        docs_url: "https://developers.openai.com/codex/cli/",
        summary: "Installs the Codex CLI with npm. Run `codex login` afterwards.",
    },
    ProviderInstallGuide {
        provider_id: "anthropic",
        binary: "claude",
        command: Some("npm install -g @anthropic-ai/claude-code"),
        docs_url: "https://code.claude.com/docs/en/setup",
        summary: "Installs Claude Code with npm. Gyro can sign in for you afterwards.",
    },
    ProviderInstallGuide {
        provider_id: "kimi",
        binary: "kimi",
        command: None,
        docs_url: "https://github.com/MoonshotAI/kimi-cli",
        summary: "Moonshot publishes the Kimi CLI with its own installer instructions.",
    },
    ProviderInstallGuide {
        provider_id: "xai",
        binary: "grok",
        command: None,
        docs_url: "https://docs.x.ai/docs/guides/grok-cli",
        summary: "xAI publishes the Grok CLI and its install steps together.",
    },
    ProviderInstallGuide {
        provider_id: "gemini",
        binary: "gemini",
        command: Some("npm install -g @google/gemini-cli"),
        docs_url: "https://github.com/google-gemini/gemini-cli",
        summary: "Installs the Gemini CLI with npm. Run `gemini` once to sign in.",
    },
    ProviderInstallGuide {
        provider_id: "antigravity",
        binary: "agy",
        command: Some("curl -fsSL https://antigravity.google/cli/install.sh | bash"),
        docs_url: "https://antigravity.google/docs",
        summary: "Installs Google's Antigravity CLI. Run `agy` once to sign in.",
    },
    ProviderInstallGuide {
        provider_id: "ollama",
        binary: "ollama",
        command: Some("brew install ollama"),
        docs_url: "https://ollama.com/download",
        summary: "Installs the Ollama runtime. `ollama serve` keeps it running locally.",
    },
    ProviderInstallGuide {
        provider_id: "cursor",
        binary: "cursor-agent",
        command: Some("curl https://cursor.com/install -fsS | bash"),
        docs_url: "https://cursor.com/docs/cli",
        summary: "Installs the Cursor CLI. Run `cursor-agent login` afterwards.",
    },
    ProviderInstallGuide {
        provider_id: "opencode",
        binary: "opencode",
        command: Some("curl -fsSL https://opencode.ai/install | bash"),
        docs_url: "https://opencode.ai/docs",
        summary: "Installs the OpenCode CLI. Run `opencode auth login` afterwards.",
    },
    ProviderInstallGuide {
        provider_id: "deepseek",
        binary: "deepseek",
        command: None,
        docs_url: "https://api-docs.deepseek.com",
        summary: "DeepSeek runs on an API key, so there is no CLI to install.",
    },
    ProviderInstallGuide {
        provider_id: "mistral",
        binary: "mistral",
        command: None,
        docs_url: "https://docs.mistral.ai",
        summary: "Mistral runs on an API key, so there is no CLI to install.",
    },
    ProviderInstallGuide {
        provider_id: "openrouter",
        binary: "openrouter",
        command: None,
        docs_url: "https://openrouter.ai/docs",
        summary: "OpenRouter runs on an API key, so there is no CLI to install.",
    },
];

/// Guidance for one provider id, when the table knows it.
pub fn install_guide(provider_id: &str) -> Option<&'static ProviderInstallGuide> {
    PROVIDER_INSTALL_GUIDES
        .iter()
        .find(|guide| guide.provider_id == provider_id)
}

/// The command a confirmed install runs, when the table has one.
pub fn install_command(provider_id: &str) -> Option<&'static str> {
    install_guide(provider_id).and_then(|guide| guide.command)
}

/// One-line hint shared by `gyro setup` and the desktop app.
pub fn install_hint(provider_id: &str) -> Option<String> {
    let guide = install_guide(provider_id)?;
    let action = match guide.command {
        Some(command) => format!("Install it with `{command}`"),
        None => format!("Install it from {}", guide.docs_url),
    };
    Some(format!(
        "`{}` is not installed on this device. {action}, then try again.",
        guide.binary
    ))
}

/// Guidance for a binary name, for callers that only know the executable
/// (`claude`, `codex`, ...) and not the registry provider id.
pub fn install_hint_for_binary(binary: &str) -> Option<String> {
    PROVIDER_INSTALL_GUIDES
        .iter()
        .find(|guide| guide.binary == binary)
        .and_then(|guide| install_hint(guide.provider_id))
}

/// The GitHub CLI is not a model provider, but a missing `gh` needs the same
/// kind of guidance, so it lives here beside the provider installers.
pub const GH_CLI_GUIDE: ProviderInstallGuide = ProviderInstallGuide {
    provider_id: "github",
    binary: "gh",
    command: Some("brew install gh"),
    docs_url: "https://cli.github.com",
    summary: "GitHub's own CLI, used for issues, pull requests, and Actions.",
};

/// One-line install hint for the GitHub CLI, shared with the desktop app.
pub const GH_CLI_INSTALL_HINT: &str = "The GitHub CLI (`gh`) is not installed. Install it with `brew install gh`, then run `gh auth login`. Docs: https://cli.github.com";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider_registry::provider_registry;

    #[test]
    fn every_registry_provider_has_exactly_one_guide() {
        for descriptor in provider_registry() {
            let matches: Vec<_> = PROVIDER_INSTALL_GUIDES
                .iter()
                .filter(|guide| guide.provider_id == descriptor.id)
                .collect();
            assert_eq!(
                matches.len(),
                1,
                "provider `{}` needs exactly one install guide",
                descriptor.id
            );
        }
    }

    #[test]
    fn table_has_no_rows_outside_the_registry() {
        for guide in PROVIDER_INSTALL_GUIDES {
            assert!(
                provider_registry()
                    .iter()
                    .any(|descriptor| descriptor.id == guide.provider_id),
                "install guide `{}` has no registry provider",
                guide.provider_id
            );
        }
    }

    #[test]
    fn every_row_links_to_official_https_docs() {
        for guide in PROVIDER_INSTALL_GUIDES {
            assert!(
                guide.docs_url.starts_with("https://"),
                "`{}` needs an https docs link",
                guide.provider_id
            );
            assert!(!guide.summary.is_empty(), "`{}` needs a summary", guide.provider_id);
            assert!(!guide.binary.is_empty(), "`{}` needs a binary", guide.provider_id);
        }
    }

    #[test]
    fn only_api_key_providers_are_docs_only() {
        let mut docs_only: Vec<_> = PROVIDER_INSTALL_GUIDES
            .iter()
            .filter(|guide| guide.command.is_none())
            .map(|guide| guide.provider_id)
            .collect();
        docs_only.sort_unstable();
        assert_eq!(
            docs_only,
            vec!["deepseek", "kimi", "mistral", "openrouter", "xai"]
        );
    }

    #[test]
    fn install_hint_names_the_binary_and_the_next_step() {
        let hint = install_hint("anthropic").expect("anthropic has a guide");
        assert!(hint.contains("`claude`"));
        assert!(hint.contains("npm install -g @anthropic-ai/claude-code"));

        let docs_only = install_hint("openrouter").expect("openrouter has a guide");
        assert!(docs_only.contains("https://openrouter.ai/docs"));
        assert!(install_command("openrouter").is_none());
        assert!(install_guide("no-such-provider").is_none());
    }
}
