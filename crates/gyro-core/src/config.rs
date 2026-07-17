use crate::paths::GyroPaths;
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use uuid::Uuid;

const MAX_CONFIG_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProviderConfig {
    pub id: String,
    pub display_name: String,
    pub base_url: Option<String>,
    pub api_key_ref: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CommandProfileReadiness {
    Ready,
    #[default]
    Waiting,
    Blocked,
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
    pub full_access: bool,
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
            full_access: false,
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
                ModelProviderConfig {
                    id: "kimi".into(),
                    display_name: "Kimi".into(),
                    base_url: None,
                    api_key_ref: "provider-cli:kimi".into(),
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
                CommandProfile {
                    id: "kimi-code".into(),
                    display_name: "Kimi Code".into(),
                    command: "kimi".into(),
                    args: Vec::new(),
                    working_directory: None,
                    provider_id: Some("kimi".into()),
                    default_model: Some("k3".into()),
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
        Self::load_unlocked(paths)
    }

    fn load_unlocked(paths: &GyroPaths) -> Result<Self> {
        let Some(file) = open_config_for_read(&paths.config_path)? else {
            return Ok(Self::default());
        };
        let mut bytes = Vec::new();
        file.take((MAX_CONFIG_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .with_context(|| format!("read {}", paths.config_path.display()))?;
        if bytes.len() > MAX_CONFIG_BYTES {
            return Err(anyhow!(
                "config file {} exceeds the {} byte size limit",
                paths.config_path.display(),
                MAX_CONFIG_BYTES
            ));
        }
        let raw = String::from_utf8(bytes)
            .with_context(|| format!("read {} as UTF-8", paths.config_path.display()))?;
        let mut config: Self = serde_json::from_str(&raw)
            .with_context(|| format!("parse {}", paths.config_path.display()))?;
        config.normalize_legacy_state();
        Ok(config)
    }

    pub fn save(&self, paths: &GyroPaths) -> Result<()> {
        let _lock = acquire_config_lock(paths)?;
        self.save_unlocked(paths)
    }

    pub fn update<T>(paths: &GyroPaths, update: impl FnOnce(&mut Self) -> Result<T>) -> Result<T> {
        let _lock = acquire_config_lock(paths)?;
        let mut config = Self::load_unlocked(paths)?;
        let result = update(&mut config)?;
        config.save_unlocked(paths)?;
        Ok(result)
    }

    fn save_unlocked(&self, paths: &GyroPaths) -> Result<()> {
        paths.ensure()?;
        reject_unsafe_config_target(&paths.config_path)?;
        let mut bytes = serde_json::to_vec_pretty(self)?;
        bytes.push(b'\n');
        if bytes.len() > MAX_CONFIG_BYTES {
            return Err(anyhow!(
                "serialized config exceeds the {} byte size limit",
                MAX_CONFIG_BYTES
            ));
        }
        atomic_write_private_config(&paths.config_path, &bytes)
    }

    fn normalize_legacy_state(&mut self) {
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

        for profile in &mut self.command_profiles {
            if profile.provider_id.is_none() {
                profile.provider_id = match profile.id.as_str() {
                    "codex" => Some("openai".into()),
                    "claude" | "claude-code" => Some("anthropic".into()),
                    "kimi" | "kimi-code" => Some("kimi".into()),
                    _ => None,
                };
            }
        }

        if !self
            .model_providers
            .iter()
            .any(|provider| provider.id == "kimi")
        {
            self.model_providers.push(ModelProviderConfig {
                id: "kimi".into(),
                display_name: "Kimi".into(),
                base_url: None,
                api_key_ref: "provider-cli:kimi".into(),
                enabled: false,
            });
        }
        if !self
            .command_profiles
            .iter()
            .any(|profile| profile.id == "kimi-code")
        {
            self.command_profiles.push(CommandProfile {
                id: "kimi-code".into(),
                display_name: "Kimi Code".into(),
                command: "kimi".into(),
                args: Vec::new(),
                working_directory: None,
                provider_id: Some("kimi".into()),
                default_model: Some("k3".into()),
                readiness: CommandProfileReadiness::Waiting,
            });
        }
    }
}

struct ConfigFileLock {
    file: File,
}

fn acquire_config_lock(paths: &GyroPaths) -> Result<ConfigFileLock> {
    paths.ensure()?;
    let lock_path = paths.base_dir.join("config.lock");
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(&lock_path)
        .with_context(|| format!("open {}", lock_path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&lock_path, std::fs::Permissions::from_mode(0o600))
            .with_context(|| format!("secure {}", lock_path.display()))?;
        use std::os::fd::AsRawFd;
        loop {
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } == 0 {
                break;
            }
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::Interrupted {
                return Err(error).with_context(|| format!("lock {}", lock_path.display()));
            }
        }
    }
    Ok(ConfigFileLock { file })
}

impl Drop for ConfigFileLock {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            unsafe {
                libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
            }
        }
    }
}

fn open_config_for_read(path: &Path) -> Result<Option<File>> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(anyhow!(
                "config file cannot be a symlink: {}",
                path.display()
            ))
        }
        Ok(metadata) if !metadata.file_type().is_file() => {
            return Err(anyhow!(
                "config path is not a regular file: {}",
                path.display()
            ))
        }
        Ok(metadata) if metadata.len() > MAX_CONFIG_BYTES as u64 => {
            return Err(anyhow!(
                "config file {} exceeds the {} byte size limit",
                path.display(),
                MAX_CONFIG_BYTES
            ))
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("inspect {}", path.display())),
    }

    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options
        .open(path)
        .with_context(|| format!("open {}", path.display()))?;
    let metadata = file
        .metadata()
        .with_context(|| format!("inspect opened config {}", path.display()))?;
    if !metadata.file_type().is_file() {
        return Err(anyhow!(
            "config path is not a regular file: {}",
            path.display()
        ));
    }
    if metadata.len() > MAX_CONFIG_BYTES as u64 {
        return Err(anyhow!(
            "config file {} exceeds the {} byte size limit",
            path.display(),
            MAX_CONFIG_BYTES
        ));
    }
    Ok(Some(file))
}

fn reject_unsafe_config_target(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(anyhow!(
            "config file cannot be a symlink: {}",
            path.display()
        )),
        Ok(metadata) if !metadata.file_type().is_file() => Err(anyhow!(
            "config path is not a regular file: {}",
            path.display()
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("inspect {}", path.display())),
    }
}

fn atomic_write_private_config(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("config path has no parent directory"))?;
    let temporary = parent.join(format!(".config-{}.tmp", Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
            let mut file = options
                .open(&temporary)
                .with_context(|| format!("create {}", temporary.display()))?;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
            file.write_all(bytes)?;
            file.flush()?;
            file.sync_all()?;
        }
        #[cfg(not(unix))]
        {
            let mut file = options
                .open(&temporary)
                .with_context(|| format!("create {}", temporary.display()))?;
            file.write_all(bytes)?;
            file.flush()?;
            file.sync_all()?;
        }
        std::fs::rename(&temporary, path).with_context(|| format!("replace {}", path.display()))?;
        File::open(parent)
            .with_context(|| format!("open config directory {}", parent.display()))?
            .sync_all()
            .with_context(|| format!("sync config directory {}", parent.display()))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.with_context(|| format!("write {}", path.display()))
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
        assert!(!config.full_access);
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

    #[test]
    fn loading_legacy_profiles_restores_known_provider_identity() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        paths.ensure().unwrap();
        std::fs::write(
            &paths.config_path,
            r#"{
              "telemetryEnabled": false,
              "requireCommandApproval": true,
              "requireFileEditApproval": true,
              "modelProviders": [],
              "commandProfiles": [
                {"id":"codex","displayName":"Codex CLI","command":"codex","args":[],"workingDirectory":null},
                {"id":"claude-code","displayName":"Claude Code","command":"claude","args":[],"workingDirectory":null}
              ]
            }"#,
        )
        .unwrap();

        let config = GyroConfig::load(&paths).unwrap();

        assert_eq!(
            config.command_profiles[0].provider_id.as_deref(),
            Some("openai")
        );
        assert_eq!(
            config.command_profiles[1].provider_id.as_deref(),
            Some("anthropic")
        );
    }

    #[test]
    fn saves_private_config_atomically_and_round_trips() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let config = GyroConfig {
            telemetry_enabled: true,
            ..GyroConfig::default()
        };

        config.save(&paths).unwrap();

        assert_eq!(GyroConfig::load(&paths).unwrap(), config);
        assert!(std::fs::read_dir(paths.config_path.parent().unwrap())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .all(|entry| !entry.file_name().to_string_lossy().starts_with(".config-")));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&paths.config_path)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn concurrent_config_replacements_always_leave_valid_json() {
        const WRITERS: usize = 6;
        const SAVES_PER_WRITER: usize = 8;

        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        GyroConfig::default().save(&paths).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(WRITERS));
        let threads = (0..WRITERS)
            .map(|writer| {
                let paths = paths.clone();
                let barrier = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    for sequence in 0..SAVES_PER_WRITER {
                        let mut config = GyroConfig::default();
                        config.command_profiles[0].display_name =
                            format!("writer-{writer}-save-{sequence}");
                        config.save(&paths).unwrap();
                        GyroConfig::load(&paths).unwrap();
                    }
                })
            })
            .collect::<Vec<_>>();
        for thread in threads {
            thread.join().unwrap();
        }

        GyroConfig::load(&paths).unwrap();
    }

    #[test]
    fn concurrent_config_updates_preserve_every_change() {
        const WRITERS: usize = 8;

        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        GyroConfig::default().save(&paths).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(WRITERS));
        let threads = (0..WRITERS)
            .map(|writer| {
                let paths = paths.clone();
                let barrier = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    GyroConfig::update(&paths, |config| {
                        config.command_profiles.push(CommandProfile {
                            id: format!("concurrent-{writer}"),
                            display_name: format!("Concurrent writer {writer}"),
                            command: "true".into(),
                            args: Vec::new(),
                            working_directory: None,
                            provider_id: None,
                            default_model: None,
                            readiness: CommandProfileReadiness::Ready,
                        });
                        Ok(())
                    })
                    .unwrap();
                })
            })
            .collect::<Vec<_>>();
        for thread in threads {
            thread.join().unwrap();
        }

        let config = GyroConfig::load(&paths).unwrap();
        for writer in 0..WRITERS {
            assert!(config
                .command_profiles
                .iter()
                .any(|profile| profile.id == format!("concurrent-{writer}")));
        }
    }

    #[test]
    fn rejects_oversized_config_without_replacing_existing_state() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let config = GyroConfig::default();
        config.save(&paths).unwrap();
        let original = std::fs::read(&paths.config_path).unwrap();

        std::fs::write(&paths.config_path, vec![b'x'; MAX_CONFIG_BYTES + 1]).unwrap();
        let error = GyroConfig::load(&paths).unwrap_err().to_string();
        assert!(error.contains("size limit"), "unexpected error: {error}");

        std::fs::write(&paths.config_path, &original).unwrap();
        let mut oversized = config;
        oversized.command_profiles[0].args = vec!["x".repeat(MAX_CONFIG_BYTES)];
        let error = oversized.save(&paths).unwrap_err().to_string();
        assert!(error.contains("size limit"), "unexpected error: {error}");
        assert_eq!(std::fs::read(&paths.config_path).unwrap(), original);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_config_symlinks_for_load_and_save() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        paths.ensure().unwrap();
        let target = temp.path().join("outside-config.json");
        let original = serde_json::to_vec_pretty(&GyroConfig::default()).unwrap();
        std::fs::write(&target, &original).unwrap();
        symlink(&target, &paths.config_path).unwrap();

        let load_error = GyroConfig::load(&paths).unwrap_err().to_string();
        assert!(load_error.contains("cannot be a symlink"));
        let save_error = GyroConfig::default().save(&paths).unwrap_err().to_string();
        assert!(save_error.contains("cannot be a symlink"));
        assert_eq!(std::fs::read(&target).unwrap(), original);
    }
}
