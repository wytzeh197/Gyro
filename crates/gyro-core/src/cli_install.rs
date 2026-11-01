//! Choose how Gyro installs a missing provider CLI.
//!
//! The install runs in a terminal pane the person started from the model
//! popover, so it has to succeed without them fixing anything by hand, and
//! the CLI it installs has to land where Gyro searches (`cli_path`), or the
//! sign-in that follows reports "not installed" again. A bare
//! `npm install -g` fails both ways on common setups: a root-owned global
//! prefix (the nodejs.org package) answers EACCES, and an fnm or custom prefix
//! puts the binary outside Gyro's search path. The plan below checks both and
//! falls back to a per-user prefix Gyro always searches, or to the provider's
//! own installer.

use crate::cli_path::augmented_gui_path;
use crate::cli_updates::run_cli_capture_with_path;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Per-user npm prefix; `cli_path` searches its `bin` for every GUI launch.
const USER_NPM_PREFIX: &str = ".npm-global";
const NPM_PREFIX_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliInstallPlan {
    pub provider_id: String,
    pub program: String,
    /// Bare program name, so the terminal pane resolves it on Gyro's GUI PATH.
    pub command: String,
    pub args: Vec<String>,
    /// What the popover shows and copies; `~` stands for the home directory.
    pub display_command: String,
    pub method: CliInstallMethod,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CliInstallMethod {
    /// npm's own global prefix: writable and on Gyro's search path.
    NpmGlobal,
    /// `~/.npm-global`, when the global prefix is not writable or not searched.
    NpmUserPrefix,
    /// The provider's official install script.
    Installer,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CliInstallUnavailable {
    /// Gyro has no install route for this provider.
    Unsupported,
    /// The only route needs npm, and npm is missing.
    NeedsNode,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliInstallPlanReport {
    pub plan: Option<CliInstallPlan>,
    pub unavailable: Option<CliInstallUnavailable>,
    pub message: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Route {
    Npm(&'static str),
    Installer(&'static str),
}

struct InstallSpec {
    provider_id: &'static str,
    program: &'static str,
    /// Tried in order; the first route this machine can run wins.
    routes: &'static [Route],
}

const INSTALL_SPECS: &[InstallSpec] = &[
    InstallSpec {
        provider_id: "anthropic",
        program: "claude",
        // Anthropic recommends the native build; it needs no Node and installs
        // to ~/.local/bin, which Gyro searches.
        routes: &[
            Route::Installer("https://claude.ai/install.sh"),
            Route::Npm("@anthropic-ai/claude-code"),
        ],
    },
    InstallSpec {
        provider_id: "openai",
        program: "codex",
        routes: &[Route::Npm("@openai/codex")],
    },
    InstallSpec {
        provider_id: "gemini",
        program: "gemini",
        routes: &[Route::Npm("@google/gemini-cli")],
    },
    InstallSpec {
        provider_id: "xai",
        program: "grok",
        routes: &[Route::Npm("@xai-official/grok")],
    },
    InstallSpec {
        provider_id: "opencode",
        program: "opencode",
        routes: &[
            Route::Npm("opencode-ai"),
            Route::Installer("https://opencode.ai/install"),
        ],
    },
    InstallSpec {
        provider_id: "cursor",
        program: "cursor-agent",
        routes: &[Route::Installer("https://cursor.com/install")],
    },
];

/// What the machine offers an install, gathered once so the choice is pure.
#[derive(Clone, Debug, Default)]
struct InstallEnvironment {
    home: PathBuf,
    /// Entries of the PATH Gyro gives provider CLIs.
    search_path: Vec<String>,
    npm_available: bool,
    /// `npm prefix -g`, when npm answered.
    npm_prefix: Option<PathBuf>,
    npm_prefix_writable: bool,
    /// Install scripts are POSIX shell; Windows uses npm only.
    shell_installers: bool,
}

impl InstallEnvironment {
    fn detect() -> Self {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default();
        let path = augmented_gui_path();
        let search_path = path.split(':').map(str::to_string).collect::<Vec<_>>();
        let npm_available = program_on_path("npm", &search_path);
        let npm_prefix = npm_available
            .then(|| run_cli_capture_with_path("npm", &["prefix", "-g"], NPM_PREFIX_TIMEOUT, &path))
            .and_then(Result::ok)
            .map(|output| output.lines().last().unwrap_or_default().trim().to_string())
            .filter(|prefix| !prefix.is_empty())
            .map(PathBuf::from);
        let npm_prefix_writable = npm_prefix
            .as_deref()
            .is_some_and(|prefix| directory_writable(&npm_global_modules(prefix)));
        let shell_installers = !cfg!(windows)
            && program_on_path("bash", &search_path)
            && program_on_path("curl", &search_path);
        Self {
            home,
            search_path,
            npm_available,
            npm_prefix,
            npm_prefix_writable,
            shell_installers,
        }
    }

    fn searched(&self, dir: &Path) -> bool {
        let dir = dir.to_string_lossy();
        self.search_path.iter().any(|entry| entry == dir.as_ref())
    }
}

/// How to install `provider_id`'s CLI on this machine, or why Gyro can't.
pub fn provider_cli_install_plan(provider_id: &str) -> CliInstallPlanReport {
    if !INSTALL_SPECS
        .iter()
        .any(|spec| spec.provider_id == provider_id)
    {
        return plan_for(provider_id, &InstallEnvironment::default());
    }
    plan_for(provider_id, &InstallEnvironment::detect())
}

fn plan_for(provider_id: &str, env: &InstallEnvironment) -> CliInstallPlanReport {
    let Some(spec) = INSTALL_SPECS
        .iter()
        .find(|spec| spec.provider_id == provider_id)
    else {
        return CliInstallPlanReport {
            plan: None,
            unavailable: Some(CliInstallUnavailable::Unsupported),
            message: Some("Gyro can't install this CLI for you yet.".into()),
        };
    };
    for route in spec.routes {
        let plan = match *route {
            Route::Npm(package) => npm_plan(spec, package, env),
            Route::Installer(url) => installer_plan(spec, url, env),
        };
        if let Some(plan) = plan {
            return CliInstallPlanReport {
                plan: Some(plan),
                unavailable: None,
                message: None,
            };
        }
    }
    let needs_node = spec
        .routes
        .iter()
        .all(|route| matches!(route, Route::Npm(_)));
    CliInstallPlanReport {
        plan: None,
        unavailable: Some(if needs_node {
            CliInstallUnavailable::NeedsNode
        } else {
            CliInstallUnavailable::Unsupported
        }),
        message: Some(if needs_node {
            "Installing this CLI needs Node.js. Install it from nodejs.org, then try again.".into()
        } else {
            "Gyro couldn't find a way to install this CLI on this computer.".into()
        }),
    }
}

fn npm_plan(spec: &InstallSpec, package: &str, env: &InstallEnvironment) -> Option<CliInstallPlan> {
    if !env.npm_available {
        return None;
    }
    // The global prefix only works when npm can write to it and the binary it
    // links lands somewhere Gyro looks; otherwise keep the install per-user.
    let global_ok = env.npm_prefix_writable
        && env
            .npm_prefix
            .as_deref()
            .is_some_and(|prefix| env.searched(&npm_bin_dir(prefix)));
    let (args, display, method) = if global_ok {
        (
            vec!["install".into(), "-g".into(), package.into()],
            format!("npm install -g {package}"),
            CliInstallMethod::NpmGlobal,
        )
    } else {
        let prefix = env.home.join(USER_NPM_PREFIX);
        (
            vec![
                "install".into(),
                "-g".into(),
                "--prefix".into(),
                prefix.to_string_lossy().into_owned(),
                package.into(),
            ],
            format!("npm install -g --prefix ~/{USER_NPM_PREFIX} {package}"),
            CliInstallMethod::NpmUserPrefix,
        )
    };
    Some(CliInstallPlan {
        provider_id: spec.provider_id.into(),
        program: spec.program.into(),
        command: "npm".into(),
        args,
        display_command: display,
        method,
    })
}

fn installer_plan(
    spec: &InstallSpec,
    url: &str,
    env: &InstallEnvironment,
) -> Option<CliInstallPlan> {
    if !env.shell_installers {
        return None;
    }
    let script = format!("curl -fsSL {url} | bash");
    Some(CliInstallPlan {
        provider_id: spec.provider_id.into(),
        program: spec.program.into(),
        command: "bash".into(),
        args: vec!["-c".into(), script.clone()],
        display_command: script,
        method: CliInstallMethod::Installer,
    })
}

fn npm_bin_dir(prefix: &Path) -> PathBuf {
    if cfg!(windows) {
        prefix.to_path_buf()
    } else {
        prefix.join("bin")
    }
}

fn npm_global_modules(prefix: &Path) -> PathBuf {
    if cfg!(windows) {
        prefix.join("node_modules")
    } else {
        prefix.join("lib").join("node_modules")
    }
}

fn program_on_path(program: &str, search_path: &[String]) -> bool {
    search_path
        .iter()
        .filter(|dir| !dir.is_empty())
        .any(|dir| is_executable(&Path::new(dir).join(program)))
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Permission bits can't tell whether *this* user may write (ACLs, root-owned
/// parents), so ask the filesystem with a throwaway file. npm creates a
/// missing `lib/node_modules` itself, so test the nearest folder that exists.
fn directory_writable(dir: &Path) -> bool {
    let Some(existing) = dir.ancestors().find(|candidate| candidate.is_dir()) else {
        return false;
    };
    tempfile::Builder::new()
        .prefix(".gyro-write-check")
        .tempfile_in(existing)
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(home: &str) -> InstallEnvironment {
        InstallEnvironment {
            home: PathBuf::from(home),
            search_path: vec![
                format!("{home}/.local/bin"),
                format!("{home}/.npm-global/bin"),
                "/opt/homebrew/bin".into(),
                "/usr/local/bin".into(),
                "/usr/bin".into(),
            ],
            npm_available: true,
            npm_prefix: Some(PathBuf::from("/opt/homebrew")),
            npm_prefix_writable: true,
            shell_installers: true,
        }
    }

    #[test]
    fn writable_searched_global_prefix_uses_plain_global_install() {
        let report = plan_for("openai", &env("/Users/a"));
        let plan = report.plan.expect("plan");
        assert_eq!(plan.method, CliInstallMethod::NpmGlobal);
        assert_eq!(plan.command, "npm");
        assert_eq!(plan.args, ["install", "-g", "@openai/codex"]);
        assert_eq!(plan.display_command, "npm install -g @openai/codex");
    }

    #[test]
    fn root_owned_global_prefix_falls_back_to_user_prefix() {
        let mut environment = env("/Users/a");
        environment.npm_prefix = Some(PathBuf::from("/usr/local"));
        environment.npm_prefix_writable = false;
        let plan = plan_for("gemini", &environment).plan.expect("plan");
        assert_eq!(plan.method, CliInstallMethod::NpmUserPrefix);
        assert_eq!(
            plan.args,
            [
                "install",
                "-g",
                "--prefix",
                "/Users/a/.npm-global",
                "@google/gemini-cli"
            ]
        );
        assert_eq!(
            plan.display_command,
            "npm install -g --prefix ~/.npm-global @google/gemini-cli"
        );
    }

    #[test]
    fn unsearched_global_prefix_falls_back_to_user_prefix() {
        // fnm and custom prefixes link binaries Gyro would never find.
        let mut environment = env("/Users/a");
        environment.npm_prefix = Some(PathBuf::from(
            "/Users/a/.fnm/node-versions/v22/installation",
        ));
        let plan = plan_for("xai", &environment).plan.expect("plan");
        assert_eq!(plan.method, CliInstallMethod::NpmUserPrefix);
    }

    #[test]
    fn every_install_destination_is_on_gyros_search_path() {
        // npm user prefix, Claude/Cursor installers, OpenCode installer.
        let paths = crate::cli_path::user_cli_paths(Path::new("/Users/a"));
        for dir in [
            format!("/Users/a/{USER_NPM_PREFIX}/bin"),
            "/Users/a/.local/bin".to_string(),
            "/Users/a/.opencode/bin".to_string(),
        ] {
            assert!(paths.contains(&dir), "{dir} is not searched");
        }
    }

    #[test]
    fn claude_prefers_native_installer_and_falls_back_to_npm() {
        let plan = plan_for("anthropic", &env("/Users/a")).plan.expect("plan");
        assert_eq!(plan.method, CliInstallMethod::Installer);
        assert_eq!(plan.command, "bash");
        assert_eq!(
            plan.args,
            ["-c", "curl -fsSL https://claude.ai/install.sh | bash"]
        );

        let mut no_shell = env("/Users/a");
        no_shell.shell_installers = false;
        let plan = plan_for("anthropic", &no_shell).plan.expect("plan");
        assert_eq!(plan.method, CliInstallMethod::NpmGlobal);
    }

    #[test]
    fn opencode_uses_installer_without_node() {
        let mut environment = env("/Users/a");
        environment.npm_available = false;
        let plan = plan_for("opencode", &environment).plan.expect("plan");
        assert_eq!(plan.method, CliInstallMethod::Installer);
    }

    #[test]
    fn npm_only_cli_without_node_asks_for_node() {
        let mut environment = env("/Users/a");
        environment.npm_available = false;
        let report = plan_for("openai", &environment);
        assert!(report.plan.is_none());
        assert_eq!(report.unavailable, Some(CliInstallUnavailable::NeedsNode));
        assert!(report.message.unwrap_or_default().contains("Node.js"));
    }

    #[test]
    fn unknown_provider_is_unsupported() {
        let report = plan_for("kimi", &env("/Users/a"));
        assert!(report.plan.is_none());
        assert_eq!(report.unavailable, Some(CliInstallUnavailable::Unsupported));
    }

    #[test]
    fn writability_check_leaves_nothing_behind() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(directory_writable(dir.path()));
        // A prefix whose lib/node_modules npm has yet to create.
        assert!(directory_writable(&dir.path().join("lib/node_modules")));
        assert_eq!(std::fs::read_dir(dir.path()).expect("read").count(), 0);
    }
}
