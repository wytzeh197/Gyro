//! PATH resolution for provider CLIs launched from Gyro.app.
//!
//! Dock/Finder launches inherit a minimal launchd PATH. Provider CLIs almost
//! always live in user install locations (`~/.local/bin`, `~/.grok/bin`, nvm,
//! …). Health probes and ACP handshakes must share this list so a successful
//! terminal login is not followed by a failed "CLI not found" health check.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

const GUI_CLI_PATHS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
];

/// User-local install locations for every supported provider CLI family.
const USER_CLI_PATH_SUFFIXES: &[&str] = &[
    ".local/bin",
    "bin",
    // xAI / Grok Build
    ".grok/bin",
    // Kimi Code
    ".kimi-code/bin",
    // Toolchain shims
    ".volta/bin",
    ".asdf/shims",
    ".local/share/mise/shims",
    ".bun/bin",
    ".cargo/bin",
    // npm / yarn / pnpm global bins (Claude, Codex, Gemini, Cursor, OpenCode)
    ".npm-global/bin",
    ".npm/bin",
    ".yarn/bin",
    ".pnpm",
    "Library/pnpm",
    // Cursor Agent
    ".cursor/bin",
    ".local/share/cursor-agent/versions",
    // Google Gemini CLI
    ".gemini/bin",
];

/// Build the PATH used when Gyro spawns provider CLIs from a GUI context.
pub fn augmented_gui_path() -> String {
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

/// User install directories Gyro always searches, independent of process PATH.
pub fn user_cli_paths(home: &Path) -> Vec<String> {
    let mut paths = USER_CLI_PATH_SUFFIXES
        .iter()
        .map(|suffix| home.join(suffix))
        .collect::<Vec<_>>();

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

    // Claude sometimes installs versioned binaries under share without a stable
    // shim in older layouts; prefer the newest version directory if present.
    let claude_versions = home.join(".local/share/claude/versions");
    if let Ok(entries) = std::fs::read_dir(claude_versions) {
        let mut versions = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_file() || path.is_dir())
            .collect::<Vec<_>>();
        versions.sort();
        if let Some(latest) = versions.pop() {
            if latest.is_dir() {
                paths.push(latest);
            } else if let Some(parent) = latest.parent() {
                paths.push(parent.to_path_buf());
            }
        }
    }

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
    use super::{augmented_gui_path, user_cli_paths};
    use std::path::Path;

    #[test]
    fn user_cli_paths_cover_every_provider_family() {
        let home = Path::new("/Users/example");
        let paths = user_cli_paths(home);
        for required in [
            "/Users/example/.local/bin",
            "/Users/example/.grok/bin",
            "/Users/example/.kimi-code/bin",
            "/Users/example/.npm-global/bin",
            "/Users/example/.cursor/bin",
            "/Users/example/.gemini/bin",
            "/Users/example/.cargo/bin",
            "/Users/example/Library/pnpm",
        ] {
            assert!(
                paths.iter().any(|path| path == required),
                "missing {required} in {paths:?}"
            );
        }
    }

    #[test]
    fn user_cli_paths_prefer_newest_nvm_node_bin() {
        let home = tempfile::tempdir().unwrap();
        let node_versions = home.path().join(".nvm/versions/node");
        std::fs::create_dir_all(node_versions.join("v22.23.1/bin")).unwrap();
        std::fs::create_dir_all(node_versions.join("v24.11.0/bin")).unwrap();
        std::fs::create_dir_all(node_versions.join("v9.9.9/bin")).unwrap();

        let paths = user_cli_paths(home.path());
        let nvm_paths = paths
            .iter()
            .filter(|path| path.contains(".nvm/versions/node"))
            .collect::<Vec<_>>();

        assert_eq!(nvm_paths.len(), 3);
        assert!(nvm_paths[0].ends_with("v24.11.0/bin"));
        assert!(nvm_paths[1].ends_with("v22.23.1/bin"));
        assert!(nvm_paths[2].ends_with("v9.9.9/bin"));
    }

    #[test]
    fn augmented_gui_path_includes_user_and_system_locations() {
        let path = augmented_gui_path();
        assert!(path.contains(".local/bin") || path.contains("/.local/bin"));
        assert!(path.contains(".grok/bin"));
        assert!(path.contains("/usr/bin") || path.contains("/bin"));
    }
}
