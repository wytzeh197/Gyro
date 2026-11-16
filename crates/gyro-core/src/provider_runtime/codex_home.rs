//! Keep Gyro's durable Codex threads out of the Codex desktop/CLI history.
//!
//! Only configuration, instructions and file-backed credentials are shared.
//! Session files, SQLite databases, memories and caches belong to Gyro. Keyring
//! credentials are scoped by Codex home; health checks and sign-in must use the
//! same private home as chat runs.
use crate::{paths::ensure_private_directory, GyroPaths};
use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

pub fn source_home(command: &Command) -> Result<PathBuf> {
    let explicit = command.get_envs().find(|(key, _)| *key == "CODEX_HOME");
    let home = match explicit {
        Some((_, value)) => value.map(PathBuf::from),
        None => std::env::var_os("CODEX_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from),
    }
    .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
    .context("could not resolve Codex data home")?;
    anyhow::ensure!(home.is_absolute(), "Codex data home must be absolute");
    Ok(home)
}

pub fn prepare(paths: &GyroPaths, source: &Path) -> Result<PathBuf> {
    anyhow::ensure!(source.is_absolute(), "Codex data home must be absolute");
    paths.ensure()?;
    let providers = paths.base_dir.join("providers");
    ensure_private_directory(&providers)?;
    let root = providers.join("codex");
    ensure_private_directory(&root)?;
    // A provider command may already have been prepared by the desktop host.
    if source.parent() == Some(root.as_path()) {
        ensure_private_directory(source)?;
        for name in ["sessions", "archived_sessions", "log", "gyro-threads"] {
            ensure_private_directory(&source.join(name))?;
        }
        return Ok(source.to_owned());
    }
    let source = source.canonicalize().unwrap_or_else(|_| source.to_owned());
    let digest = Sha256::digest(source.as_os_str().as_encoded_bytes());
    let home = root.join(format!("{digest:x}"));
    ensure_private_directory(&home)?;
    for name in ["sessions", "archived_sessions", "log", "gyro-threads"] {
        ensure_private_directory(&home.join(name))?;
    }
    // Do not link the home itself, session storage, databases, memories or
    // desktop state. In particular sqlite_home from shared config is overridden
    // by configure(), after loading that config.
    for name in [
        "config.toml",
        "AGENTS.md",
        "AGENTS.override.md",
        "skills",
        "rules",
        ".credentials.json",
    ] {
        if source.join(name).exists() {
            link_if_absent(&source.join(name), &home.join(name))?;
        }
    }
    // A dangling auth link lets the normal file-backed login create the shared
    // credential file too. Never copy tokens: refreshes must see one document.
    for name in ["auth.json", "auth.lock", "auth.json.lock"] {
        link_if_absent(&source.join(name), &home.join(name))?;
    }
    Ok(home)
}

#[cfg(unix)]
fn link_if_absent(source: &Path, destination: &Path) -> Result<()> {
    match std::os::unix::fs::symlink(source, destination) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let metadata = fs::symlink_metadata(destination)?;
            if metadata.file_type().is_symlink() {
                anyhow::ensure!(
                    fs::read_link(destination)? == source,
                    "unexpected Codex shared-file link: {}",
                    destination.display()
                );
            }
            Ok(())
        }
        Err(error) => Err(error).with_context(|| format!("link {}", destination.display())),
    }
}

#[cfg(not(unix))]
fn link_if_absent(_source: &Path, _destination: &Path) -> Result<()> {
    anyhow::bail!("Codex storage isolation requires filesystem symlink support")
}

pub fn configure(command: &mut Command, paths: &GyroPaths) -> Result<PathBuf> {
    let home = prepare(paths, &source_home(command)?)?;
    command
        .env("CODEX_HOME", &home)
        .env("CODEX_SQLITE_HOME", &home);
    for (key, path) in [("sqlite_home", home.clone()), ("log_dir", home.join("log"))] {
        // JSON string quoting is also valid for these TOML basic strings.
        command
            .arg("-c")
            .arg(format!("{key}={}", serde_json::to_string(&path)?));
    }
    Ok(home)
}

/// Cursors minted before isolation belong to shared storage. Rebuild their
/// context from Gyro's transcript once, rather than resuming a shared thread.
pub fn owns_thread(home: &Path, id: &str) -> bool {
    valid_id(id) && home.join("gyro-threads").join(id).is_file()
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

pub fn remember_thread(home: &Path, id: &str) -> Result<()> {
    anyhow::ensure!(valid_id(id), "invalid Codex thread id");
    let path = home.join("gyro-threads").join(id);
    crate::paths::reject_unsafe_private_file(&path)?;
    fs::write(&path, b"Gyro Codex thread\n")?;
    crate::paths::secure_private_file(&path)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn separates_history_and_databases_but_shares_credentials_without_copying() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let source = temp.path().join("codex");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("auth.json"), "first").unwrap();
        fs::write(source.join("config.toml"), "sqlite_home='/shared'\n").unwrap();
        let mut command = Command::new("codex");
        command.env("CODEX_HOME", &source);
        let home = configure(&mut command, &paths).unwrap();
        assert_ne!(home, source);
        assert!(!fs::symlink_metadata(home.join("sessions"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read_link(home.join("auth.json")).unwrap(),
            source.canonicalize().unwrap().join("auth.json")
        );
        fs::write(source.join("auth.json"), "refreshed").unwrap();
        assert_eq!(
            fs::read_to_string(home.join("auth.json")).unwrap(),
            "refreshed"
        );
        assert_eq!(configure(&mut command, &paths).unwrap(), home);
        let id = uuid::Uuid::new_v4().to_string();
        assert!(!owns_thread(&home, &id));
        remember_thread(&home, &id).unwrap();
        assert!(owns_thread(&home, &id));
        assert!(!owns_thread(&home, "../auth.json"));
        assert!(remember_thread(&home, "../auth.json").is_err());
        let args: Vec<_> = command.get_args().map(|a| a.to_string_lossy()).collect();
        assert!(args
            .iter()
            .any(|a| a.starts_with("sqlite_home=") && a.contains(home.to_str().unwrap())));
    }

    #[test]
    fn imported_accounts_get_distinct_homes_and_state_symlinks_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let first = prepare(&paths, &temp.path().join("first")).unwrap();
        let second = prepare(&paths, &temp.path().join("second")).unwrap();
        assert_ne!(first, second);
        fs::remove_dir(first.join("sessions")).unwrap();
        std::os::unix::fs::symlink(temp.path(), first.join("sessions")).unwrap();
        assert!(prepare(&paths, &temp.path().join("first")).is_err());
    }
}
