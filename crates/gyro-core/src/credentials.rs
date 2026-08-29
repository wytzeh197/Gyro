//! Credential scrubbing for agent-driven processes.
//!
//! Layer 0 of docs/internal/workspace-safety.md. A spawned child inherits the
//! full parent environment by default, so an agent can read a credential out of
//! its own environment — or `cat` a credential file — without ever leaving the
//! workspace directory. That needs no sandbox to fix, and this module is the
//! part that ships before one exists.
//!
//! The rule is per-provider, not blanket: provider CLIs authenticate through
//! inherited environment variables (see `provider_health`), so stripping every
//! key would break the very run being protected. A scrubbed run keeps the keys
//! the launched provider needs for its own auth and drops every other one.

use std::collections::BTreeSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Environment variables a provider needs to authenticate as itself.
///
/// Anything not listed here is stripped from that provider's runs, including
/// the other providers' keys — a Claude run has no reason to hold an xAI key.
fn provider_credential_env_vars(provider_id: &str) -> &'static [&'static str] {
    match provider_id {
        "anthropic" => &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
        "openai" => &["OPENAI_API_KEY"],
        "xai" => &["XAI_API_KEY"],
        "gemini" => &[
            "GEMINI_API_KEY",
            "GOOGLE_API_KEY",
            "GOOGLE_APPLICATION_CREDENTIALS",
        ],
        "kimi" => &["MOONSHOT_API_KEY", "KIMI_API_KEY"],
        _ => &[],
    }
}

/// Environment variable names that carry a secret regardless of who set them.
///
/// Matched in addition to the structural rules in [`env_name_is_credential`],
/// for names those rules would miss.
const ALWAYS_DENIED_ENV_VARS: &[&str] = &[
    "AWS_ACCESS_KEY_ID",
    "AWS_SECURITY_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_PAT",
    "GH_PAT",
    "TWINE_PASSWORD",
    "DOCKER_AUTH_CONFIG",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "NETRC",
    "CI_JOB_JWT",
];

/// Name segments that mark a variable as a secret on their own.
const DENIED_SEGMENTS: &[&str] = &[
    "TOKEN",
    "TOKENS",
    "SECRET",
    "SECRETS",
    "PASSWORD",
    "PASSWD",
    "CREDENTIAL",
    "CREDENTIALS",
    "APIKEY",
    "PRIVATEKEY",
];

/// Adjacent segment pairs that mark a variable as a secret.
///
/// Kept separate from [`DENIED_SEGMENTS`] because neither half is conclusive on
/// its own — `KEY` alone would catch `KEYBOARD_LAYOUT`, `ACCESS` alone would
/// catch `ACCESS_LOG_PATH`.
const DENIED_SEGMENT_PAIRS: &[(&str, &str)] = &[
    ("API", "KEY"),
    ("ACCESS", "KEY"),
    ("PRIVATE", "KEY"),
    ("SECRET", "KEY"),
    ("SIGNING", "KEY"),
    ("AUTH", "TOKEN"),
    ("ACCESS", "TOKEN"),
    ("SESSION", "TOKEN"),
    ("REFRESH", "TOKEN"),
];

/// Whether an environment variable name looks like it carries a secret.
///
/// Deliberately structural rather than a fixed list: the list of services a
/// developer holds keys for is open-ended, and a name-shaped rule covers the
/// ones nobody thought to enumerate. Segments are matched whole so
/// `TOKENIZERS_PARALLELISM` and `KEYBOARD_LAYOUT` stay untouched.
pub fn env_name_is_credential(name: &str) -> bool {
    let normalized = name.trim().to_ascii_uppercase();
    if normalized.is_empty() {
        return false;
    }
    if ALWAYS_DENIED_ENV_VARS.contains(&normalized.as_str()) {
        return true;
    }

    let segments: Vec<&str> = normalized.split('_').collect();
    if segments
        .iter()
        .any(|segment| DENIED_SEGMENTS.contains(segment))
    {
        return true;
    }
    segments.windows(2).any(|pair| {
        DENIED_SEGMENT_PAIRS
            .iter()
            .any(|(first, second)| pair[0] == *first && pair[1] == *second)
    })
}

/// Which credentials a spawned process is allowed to inherit.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub enum CredentialPolicy {
    /// Gyro's own tooling — `git`, `gh`, provider health checks, CLI updates.
    /// Inherits the full parent environment, because these calls are Gyro's,
    /// not an agent's, and some of them genuinely need the user's tokens.
    #[default]
    Inherit,
    /// An agent-driven run. Every credential-shaped variable is removed from
    /// the child environment except `allowed`.
    Scrubbed { allowed: BTreeSet<String> },
}

impl CredentialPolicy {
    /// The policy for a run of `provider_id`: scrubbed, keeping only the keys
    /// that provider authenticates with.
    pub fn for_provider(provider_id: &str) -> Self {
        Self::Scrubbed {
            allowed: provider_credential_env_vars(provider_id)
                .iter()
                .map(|name| (*name).to_string())
                .collect(),
        }
    }

    /// A scrubbed policy that keeps nothing — for agent-driven commands that
    /// need no provider auth of their own.
    pub fn scrubbed() -> Self {
        Self::Scrubbed {
            allowed: BTreeSet::new(),
        }
    }

    pub fn is_scrubbed(&self) -> bool {
        matches!(self, Self::Scrubbed { .. })
    }

    fn allows(&self, name: &str) -> bool {
        match self {
            Self::Inherit => true,
            Self::Scrubbed { allowed } => allowed.contains(&name.to_ascii_uppercase()),
        }
    }

    /// Environment overrides that strip the denied credentials, as
    /// `(name, None)` removal entries.
    ///
    /// Computed against the environment the child would actually inherit,
    /// rather than a fixed list, so a key Gyro has never heard of is still
    /// removed as long as its name is credential-shaped.
    pub fn env_overrides(&self) -> Vec<(OsString, Option<OsString>)> {
        self.env_overrides_from(std::env::vars_os().map(|(key, _)| key))
    }

    /// [`Self::env_overrides`] against an explicit set of names, for tests and
    /// for callers that have already captured a parent environment.
    pub fn env_overrides_from<I>(&self, names: I) -> Vec<(OsString, Option<OsString>)>
    where
        I: IntoIterator<Item = OsString>,
    {
        if matches!(self, Self::Inherit) {
            return Vec::new();
        }
        names
            .into_iter()
            .filter(|name| {
                let Some(name) = name.to_str() else {
                    // A non-UTF-8 name cannot be matched against the rules, so
                    // it is kept: dropping it would break unrelated tooling
                    // without being a credential we identified.
                    return false;
                };
                env_name_is_credential(name) && !self.allows(name)
            })
            .map(|name| (name, None))
            .collect()
    }
}

/// Credential stores that agent-driven reads should not reach.
///
/// Enforcing this on arbitrary shell commands needs the OS-level sandbox of
/// Layer 2. Until then it is enforced where Gyro mediates the read itself —
/// the capability layer — and it is the list the Seatbelt profile will deny.
pub fn credential_store_paths(home: &Path) -> Vec<PathBuf> {
    [
        ".ssh",
        ".aws",
        ".gnupg",
        ".kube",
        ".netrc",
        ".npmrc",
        ".pypirc",
        ".docker/config.json",
        ".config/gh",
        ".config/gcloud",
        ".config/op",
        "Library/Keychains",
    ]
    .iter()
    .map(|relative| home.join(relative))
    .collect()
}

/// Whether `path` is inside a known credential store.
///
/// Compares lexically after normalizing separators: the caller may be checking
/// a path that does not exist yet, so this cannot rely on `canonicalize`.
pub fn path_is_credential_store(home: &Path, path: &Path) -> bool {
    let candidate = normalize_for_compare(path);
    credential_store_paths(home).iter().any(|denied| {
        let denied = normalize_for_compare(denied);
        candidate == denied || candidate.starts_with(&format!("{denied}/"))
    })
}

/// Directory names that hold credentials wherever they appear.
///
/// Matched on any leading segment of a path so the contents are covered even
/// when the file name itself looks harmless (`.config/gh/hosts.yml`).
const CREDENTIAL_STORE_DIRS: &[&str] = &[
    ".ssh",
    ".aws",
    ".gnupg",
    ".kube",
    ".docker",
    "gh",
    "gcloud",
    "keychains",
];

/// Whether a workspace-relative path reaches into a credential store.
///
/// Relevant when the workspace itself is the home directory: `.config/gh` is
/// then an ordinary relative path, and nothing about its file names marks it.
pub fn relative_path_is_in_credential_store(path: &str) -> bool {
    let normalized = path.trim().replace('\\', "/").to_ascii_lowercase();
    normalized
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .any(|segment| CREDENTIAL_STORE_DIRS.contains(&segment))
}

fn normalize_for_compare(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    fn removed(policy: &CredentialPolicy, values: &[&str]) -> Vec<String> {
        policy
            .env_overrides_from(names(values))
            .into_iter()
            .map(|(key, _)| key.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn credential_shaped_names_are_recognized() {
        for name in [
            "AWS_SECRET_ACCESS_KEY",
            "AWS_SESSION_TOKEN",
            "AWS_ACCESS_KEY_ID",
            "GITHUB_TOKEN",
            "GH_TOKEN",
            "NPM_TOKEN",
            "NODE_AUTH_TOKEN",
            "STRIPE_SECRET_KEY",
            "CLOUDFLARE_API_TOKEN",
            "SOME_VENDOR_NOBODY_LISTED_API_KEY",
            "DB_PASSWORD",
        ] {
            assert!(env_name_is_credential(name), "{name} should be denied");
        }
    }

    #[test]
    fn ordinary_names_are_left_alone() {
        for name in [
            "PATH",
            "HOME",
            "TERM",
            "TOKENIZERS_PARALLELISM",
            "KEYBOARD_LAYOUT",
            "ACCESS_LOG_PATH",
            "RUST_LOG",
            "CARGO_TARGET_DIR",
        ] {
            assert!(!env_name_is_credential(name), "{name} should be kept");
        }
    }

    #[test]
    fn inherit_removes_nothing() {
        let policy = CredentialPolicy::Inherit;
        assert!(removed(&policy, &["GITHUB_TOKEN", "AWS_SESSION_TOKEN"]).is_empty());
    }

    #[test]
    fn provider_keeps_only_its_own_keys() {
        let policy = CredentialPolicy::for_provider("anthropic");
        let removed = removed(
            &policy,
            &[
                "PATH",
                "ANTHROPIC_API_KEY",
                "XAI_API_KEY",
                "OPENAI_API_KEY",
                "GITHUB_TOKEN",
                "AWS_SECRET_ACCESS_KEY",
            ],
        );
        assert_eq!(
            removed,
            vec![
                "XAI_API_KEY",
                "OPENAI_API_KEY",
                "GITHUB_TOKEN",
                "AWS_SECRET_ACCESS_KEY"
            ]
        );
    }

    #[test]
    fn unknown_provider_keeps_nothing() {
        let policy = CredentialPolicy::for_provider("not-a-provider");
        assert_eq!(
            removed(&policy, &["ANTHROPIC_API_KEY", "PATH"]),
            vec!["ANTHROPIC_API_KEY"]
        );
    }

    #[test]
    fn credential_store_directories_are_recognized_in_relative_paths() {
        for path in [
            ".ssh/config",
            ".aws/credentials",
            ".config/gh/hosts.yml",
            ".config/gcloud/application_default_credentials.json",
            "nested/.docker/config.json",
        ] {
            assert!(
                relative_path_is_in_credential_store(path),
                "{path} should be denied"
            );
        }
        for path in ["src/main.rs", "docs/gharial.md", "packages/ui/src/index.ts"] {
            assert!(
                !relative_path_is_in_credential_store(path),
                "{path} should be allowed"
            );
        }
    }

    #[test]
    fn credential_stores_are_recognized_under_home() {
        let home = Path::new("/Users/example");
        for path in [
            "/Users/example/.ssh",
            "/Users/example/.ssh/id_ed25519",
            "/Users/example/.aws/credentials",
            "/Users/example/.config/gh/hosts.yml",
            "/Users/example/Library/Keychains/login.keychain-db",
        ] {
            assert!(
                path_is_credential_store(home, Path::new(path)),
                "{path} should be denied"
            );
        }
        for path in [
            "/Users/example/Gyro/src/main.rs",
            "/Users/example/.sshfs-config",
            "/Users/example/.config/ghostty/config",
        ] {
            assert!(
                !path_is_credential_store(home, Path::new(path)),
                "{path} should be allowed"
            );
        }
    }
}
