//! A fail-closed macOS filesystem boundary for Gyro-owned agent commands.
//!
//! This is not an egress filter: IP networking and ordinary non-secret reads
//! remain available. Provider processes and human terminals must choose their
//! own execution policy; callers opt agent-owned commands into this wrapper.
//! Keep the prepared value alive until the managed process group has exited,
//! and apply `environment()` after other environment overrides. Cleanup is best
//! effort: a host crash can leave scratch behind, and process-group management
//! does not promise to reap a descendant that detaches into a new session.
//! Other sandboxed commands cannot read retained scratch. Never retry an
//! unsuccessful wrapped command without its sandbox.

use anyhow::{bail, Result};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use tempfile::TempDir;

const SANDBOX_EXECUTABLE: &str = "/usr/bin/sandbox-exec";

#[derive(Debug)]
pub struct PreparedWorkspaceSandbox {
    // The owner, rather than a process-visible profile file, controls lifetime.
    _scratch: TempDir,
    scratch_path: PathBuf,
    arguments: Vec<OsString>,
    environment: Vec<(OsString, OsString)>,
}

impl PreparedWorkspaceSandbox {
    /// Prepare one command's boundary. All paths must be absolute; workspace
    /// and cwd must be existing directories and cwd must be inside workspace.
    /// Mutable symlink components in authority paths are rejected. `/tmp` and
    /// `/var` are accepted only as their fixed macOS system aliases.
    ///
    /// Gyro's private directory is unreadable, except for the selected workspace
    /// strictly inside its managed `worktrees/<repo>/<task>` or
    /// `sessions/workspaces/<task>` trees. Selecting a private/container root is
    /// not a way to grant access to other sessions, configuration, or sockets.
    pub fn prepare(
        workspace: &Path,
        cwd: &Path,
        home: &Path,
        private_data_root: Option<&Path>,
    ) -> Result<Self> {
        #[cfg(target_os = "macos")]
        {
            macos::prepare(workspace, cwd, home, private_data_root)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (workspace, cwd, home, private_data_root);
            bail!("Gyro's workspace command sandbox requires macOS; execution was not started")
        }
    }

    /// Return an argv-preserving wrapper suitable for std::process::Command or
    /// portable-pty. Paths are sandbox-exec parameters, never policy source.
    pub fn wrap_command(&self, program: &OsStr, args: &[OsString]) -> (OsString, Vec<OsString>) {
        let mut wrapped = self.arguments.clone();
        wrapped.push("--".into());
        wrapped.push(program.to_owned());
        wrapped.extend_from_slice(args);
        (SANDBOX_EXECUTABLE.into(), wrapped)
    }

    /// Apply these values last so command-provided values cannot redirect the
    /// writable scratch/cache allowance elsewhere. HOME is deliberately kept.
    pub fn environment(&self) -> Vec<(OsString, OsString)> {
        self.environment.clone()
    }

    pub fn scratch_dir(&self) -> &Path {
        &self.scratch_path
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use anyhow::{ensure, Context};
    use std::collections::BTreeSet;
    use std::fs;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::path::Component;

    const BASE_POLICY: &str = include_str!("workspace_sandbox.sbpl");
    const METADATA_NAMES: &[&str] = &[".git", ".gyro", ".codex", ".claude", ".agents"];
    // Case variants matter on the default case-insensitive macOS filesystem.
    const METADATA_FILTER: &str = r#"(regex #"(^|/)[.]([gG][iI][tT]|[gG][yY][rR][oO]|[cC][oO][dD][eE][xX]|[cC][lL][aA][uU][dD][eE]|[aA][gG][eE][nN][tT][sS])(/|$)")"#;
    const PROVIDER_AUTH_PATHS: &[&str] = &[
        ".codex",
        ".claude",
        ".claude.json",
        ".gemini",
        ".kimi",
        ".cursor",
        ".grok",
        ".antigravity",
        ".config/opencode",
        ".local/share/opencode",
        ".config/cursor",
        ".config/grok",
        ".config/antigravity",
        ".git-credentials",
        ".config/git/credentials",
        ".cargo/credentials",
        ".cargo/credentials.toml",
    ];
    const STARTUP_PATHS: &[&str] = &[
        ".zshenv",
        ".zprofile",
        ".zshrc",
        ".zlogin",
        ".zlogout",
        ".bashrc",
        ".bash_profile",
        ".bash_login",
        ".profile",
        ".config/fish",
        ".config/nushell",
        ".gitconfig",
        ".config/git/config",
    ];

    pub(super) fn prepare(
        workspace: &Path,
        cwd: &Path,
        home: &Path,
        private_data_root: Option<&Path>,
    ) -> Result<PreparedWorkspaceSandbox> {
        ensure!(
            Path::new(SANDBOX_EXECUTABLE).is_file(),
            "macOS sandbox-exec is unavailable; execution was not started"
        );
        let workspace = boundary_path(workspace, true).context("invalid sandbox workspace")?;
        let cwd = boundary_path(cwd, true).context("invalid sandbox working directory")?;
        let home = boundary_path(home, true).context("invalid sandbox home directory")?;
        ensure!(
            workspace != Path::new("/"),
            "the filesystem root cannot be a sandbox workspace"
        );
        ensure!(
            cwd.starts_with(&workspace),
            "sandbox working directory must be inside the selected workspace"
        );

        let mut private_roots = BTreeSet::new();
        private_roots.insert(boundary_path(
            &home.join("Library/Application Support/Gyro"),
            false,
        )?);
        if let Some(root) = private_data_root {
            private_roots
                .insert(boundary_path(root, false).context("invalid Gyro private data directory")?);
        }
        let mut read_denies = BTreeSet::new();
        for path in crate::credentials::credential_store_paths(&home)
            .into_iter()
            .chain(PROVIDER_AUTH_PATHS.iter().map(|path| home.join(path)))
        {
            read_denies.extend(denied_path_variants(&path)?);
        }
        ensure!(
            !read_denies
                .iter()
                .any(|path| workspace.starts_with(path) || cwd.starts_with(path)),
            "credential directories cannot be selected as a sandbox workspace or working directory"
        );

        let mut write_denies = read_denies.clone();
        for path in STARTUP_PATHS
            .iter()
            .map(|path| home.join(path))
            .chain(METADATA_NAMES.iter().map(|path| workspace.join(path)))
        {
            write_denies.extend(denied_path_variants(&path)?);
        }

        // A root-owned sticky directory avoids trusting a caller's TMPDIR.
        let scratch = tempfile::Builder::new()
            .prefix("gyro-sandbox-")
            .tempdir_in("/private/tmp")
            .context("create private command scratch directory")?;
        fs::set_permissions(scratch.path(), fs::Permissions::from_mode(0o700))?;
        let scratch_path = boundary_path(scratch.path(), true)?;
        let temp_path = scratch_path.join("tmp");
        let cache_path = scratch_path.join("cache");
        fs::create_dir(&temp_path)?;
        fs::create_dir(&cache_path)?;

        let mut policy = Policy::new();
        let workspace_filter = policy.path_filter(&workspace);
        let scratch_filter = policy.path_filter(&scratch_path);
        let mut read_exclusions = Vec::new();
        let mut write_exclusions = vec![format!("(require-not {METADATA_FILTER})")];
        // Processes share a user identity, so mode 0700 alone cannot keep
        // another agent's temporary files private.
        let other_scratch = format!(
            r#"(require-not (require-all (regex #"^(/private)?/tmp/gyro-sandbox-[^/]+(/|$)") (require-not {scratch_filter})))"#
        );
        read_exclusions.push(other_scratch.clone());
        write_exclusions.push(other_scratch);
        for path in &read_denies {
            let filter = policy.path_filter(path);
            read_exclusions.push(format!("(require-not {filter})"));
        }
        for path in &write_denies {
            let filter = policy.path_filter(path);
            write_exclusions.push(format!("(require-not {filter})"));
        }
        for private_root in &private_roots {
            let private_filter = policy.path_filter(private_root);
            let exclusion = if workspace.starts_with(private_root) {
                ensure!(is_managed_workspace(&workspace, private_root),
                    "only an individual managed workspace may be selected inside Gyro's private data directory");
                format!(
                    "(require-not (require-all {private_filter} (require-not {workspace_filter})))"
                )
            } else {
                format!("(require-not {private_filter})")
            };
            read_exclusions.push(exclusion.clone());
            write_exclusions.push(exclusion);
        }
        policy.source.push_str(&format!(
            "\n(allow file-read* (require-all {}))\n",
            read_exclusions.join(" ")
        ));
        policy.source.push_str(&format!("(allow file-write* (require-all (require-any {workspace_filter} {scratch_filter}) {}))\n", write_exclusions.join(" ")));

        // Prevent changing an authority path so the next command receives a
        // different tree. Ancestors of a protected path can be writable when
        // the workspace is HOME; protecting only the leaf would allow renames.
        let mut anchors = BTreeSet::new();
        for path in write_denies
            .iter()
            .chain(private_roots.iter())
            .chain([&workspace, &scratch_path])
        {
            anchors.extend(path.ancestors().map(Path::to_path_buf));
        }
        for path in anchors {
            let parameter = policy.parameter(&path);
            policy.source.push_str(&format!(
                "(deny file-write-unlink (literal (param \"{parameter}\")))\n"
            ));
        }
        let mut arguments = Vec::new();
        for (name, path) in policy.parameters {
            arguments.push("-D".into());
            let mut assignment = OsString::from(format!("{name}="));
            assignment.push(path);
            arguments.push(assignment);
        }
        arguments.extend([OsString::from("-p"), OsString::from(policy.source)]);
        let environment = [
            ("TMPDIR", &temp_path),
            ("TMP", &temp_path),
            ("TEMP", &temp_path),
            ("XDG_CACHE_HOME", &cache_path),
            ("npm_config_cache", &cache_path),
            ("PIP_CACHE_DIR", &cache_path),
            ("PYTHONPYCACHEPREFIX", &cache_path),
        ]
        .into_iter()
        .map(|(name, path)| (OsString::from(name), path.as_os_str().to_owned()))
        .collect();
        Ok(PreparedWorkspaceSandbox {
            _scratch: scratch,
            scratch_path,
            arguments,
            environment,
        })
    }

    fn is_managed_workspace(workspace: &Path, private_root: &Path) -> bool {
        workspace
            .strip_prefix(private_root.join("worktrees"))
            .is_ok_and(|tail| tail.components().count() >= 2)
            || workspace
                .strip_prefix(private_root.join("sessions/workspaces"))
                .is_ok_and(|tail| tail.components().count() >= 1)
    }

    struct Policy {
        source: String,
        parameters: Vec<(String, PathBuf)>,
    }

    impl Policy {
        fn new() -> Self {
            Self {
                source: BASE_POLICY.into(),
                parameters: Vec::new(),
            }
        }

        fn parameter(&mut self, path: &Path) -> String {
            let name = format!("GYRO_PATH_{}", self.parameters.len());
            self.parameters.push((name.clone(), path.to_path_buf()));
            name
        }

        fn path_filter(&mut self, path: &Path) -> String {
            let name = self.parameter(path);
            // `literal` also covers creation of a protected directory itself.
            format!("(require-any (literal (param \"{name}\")) (subpath (param \"{name}\")))")
        }
    }

    fn absolute_path(path: &Path) -> Result<PathBuf> {
        ensure!(path.is_absolute(), "sandbox paths must be absolute");
        let mut normalized = PathBuf::new();
        for component in path.components() {
            match component {
                Component::ParentDir => bail!("sandbox paths must not contain '..'"),
                Component::CurDir => {}
                other => normalized.push(other.as_os_str()),
            }
        }
        Ok(normalized)
    }

    /// Validate components before canonicalizing: resolving a mutable symlink
    /// would silently grant its target authority. Only fixed, root-owned macOS
    /// aliases are allowed. Missing trailing components are valid for denies.
    fn boundary_path(path: &Path, must_exist: bool) -> Result<PathBuf> {
        let path = absolute_path(path)?;
        let mut current = PathBuf::new();
        let mut missing = false;
        for component in path.components() {
            current.push(component.as_os_str());
            if missing {
                continue;
            }
            match fs::symlink_metadata(&current) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    let expected = match current.to_str() {
                        Some("/tmp") => Path::new("/private/tmp"),
                        Some("/var") => Path::new("/private/var"),
                        _ => bail!(
                            "mutable symlink component is not supported: {}",
                            current.display()
                        ),
                    };
                    ensure!(
                        metadata.uid() == 0 && fs::canonicalize(&current)? == expected,
                        "unexpected system alias: {}",
                        current.display()
                    );
                    current = expected.to_path_buf();
                }
                Ok(metadata) => ensure!(
                    metadata.is_dir(),
                    "sandbox path component is not a directory: {}",
                    current.display()
                ),
                Err(error) if !must_exist && error.kind() == std::io::ErrorKind::NotFound => {
                    missing = true
                }
                Err(error) => {
                    return Err(error)
                        .with_context(|| format!("inspect sandbox path {}", current.display()))
                }
            }
        }
        Ok(current)
    }

    /// Deny both the named store and its existing target when a user has
    /// symlinked a credential/config directory elsewhere. Missing leaves still
    /// get a rule; resolving the nearest existing ancestor handles that case.
    fn denied_path_variants(path: &Path) -> Result<BTreeSet<PathBuf>> {
        let path = absolute_path(path)?;
        let mut variants = BTreeSet::from([path.clone()]);
        for ancestor in path.ancestors() {
            match fs::canonicalize(ancestor) {
                Ok(resolved) => {
                    variants.insert(resolved.join(path.strip_prefix(ancestor)?));
                    break;
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                    ) => {}
                Err(error) => return Err(error).context("resolve protected sandbox path"),
            }
        }
        Ok(variants)
    }
}

#[cfg(test)]
#[path = "workspace_sandbox_tests.rs"]
mod tests;
