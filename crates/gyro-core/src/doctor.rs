use crate::{config::GyroConfig, keychain, paths::GyroPaths};
use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DoctorStatus {
    Pass,
    Warn,
    Fail,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorCheck {
    pub id: String,
    pub label: String,
    pub status: DoctorStatus,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub checks: Vec<DoctorCheck>,
}

impl DoctorReport {
    pub fn has_failures(&self) -> bool {
        self.checks
            .iter()
            .any(|check| check.status == DoctorStatus::Fail)
    }
}

pub fn run_doctor(paths: &GyroPaths, config: &GyroConfig) -> DoctorReport {
    let mut checks = Vec::new();
    checks.push(command_check("git", "Git", &["--version"]));
    checks.push(shell_check());
    checks.push(app_install_check());
    checks.push(update_channel_check(config));
    checks.push(provider_key_check(config));
    checks.push(storage_check(paths));

    DoctorReport { checks }
}

fn command_check(command: &str, label: &str, args: &[&str]) -> DoctorCheck {
    match Command::new(command).args(args).output() {
        Ok(output) if output.status.success() => DoctorCheck {
            id: command.into(),
            label: label.into(),
            status: DoctorStatus::Pass,
            message: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        },
        Ok(output) => DoctorCheck {
            id: command.into(),
            label: label.into(),
            status: DoctorStatus::Fail,
            message: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        },
        Err(error) => DoctorCheck {
            id: command.into(),
            label: label.into(),
            status: DoctorStatus::Fail,
            message: error.to_string(),
        },
    }
}

fn shell_check() -> DoctorCheck {
    match std::env::var("SHELL") {
        Ok(shell) => DoctorCheck {
            id: "shell".into(),
            label: "Default shell".into(),
            status: DoctorStatus::Pass,
            message: shell,
        },
        Err(_) => DoctorCheck {
            id: "shell".into(),
            label: "Default shell".into(),
            status: DoctorStatus::Warn,
            message: "SHELL is not set".into(),
        },
    }
}

fn app_install_check() -> DoctorCheck {
    #[cfg(target_os = "macos")]
    let installed = std::path::Path::new("/Applications/Gyro.app").exists();
    #[cfg(not(target_os = "macos"))]
    let installed = false;

    DoctorCheck {
        id: "desktop-app".into(),
        label: "Gyro.app".into(),
        status: if installed {
            DoctorStatus::Pass
        } else {
            DoctorStatus::Warn
        },
        message: if installed {
            "Installed in /Applications".into()
        } else {
            "Gyro.app was not found in /Applications".into()
        },
    }
}

fn update_channel_check(config: &GyroConfig) -> DoctorCheck {
    DoctorCheck {
        id: "update-channel".into(),
        label: "Update channel".into(),
        status: DoctorStatus::Pass,
        message: format!("{:?}", config.update_channel),
    }
}

fn provider_key_check(config: &GyroConfig) -> DoctorCheck {
    let enabled = config
        .model_providers
        .iter()
        .filter(|provider| provider.enabled)
        .collect::<Vec<_>>();
    if enabled.is_empty() {
        return DoctorCheck {
            id: "model-provider".into(),
            label: "Model provider".into(),
            status: DoctorStatus::Warn,
            message: "No model provider is enabled yet".into(),
        };
    }

    let missing = enabled
        .iter()
        .filter(|provider| {
            keychain::get_api_key(&provider.api_key_ref)
                .ok()
                .flatten()
                .is_none()
        })
        .map(|provider| provider.display_name.clone())
        .collect::<Vec<_>>();

    DoctorCheck {
        id: "model-provider".into(),
        label: "Model provider".into(),
        status: if missing.is_empty() {
            DoctorStatus::Pass
        } else {
            DoctorStatus::Fail
        },
        message: if missing.is_empty() {
            "Enabled providers have keys in Keychain".into()
        } else {
            format!("Missing Keychain API keys for {}", missing.join(", "))
        },
    }
}

fn storage_check(paths: &GyroPaths) -> DoctorCheck {
    match paths.ensure() {
        Ok(()) => DoctorCheck {
            id: "storage".into(),
            label: "Local storage".into(),
            status: DoctorStatus::Pass,
            message: paths.base_dir.display().to_string(),
        },
        Err(error) => DoctorCheck {
            id: "storage".into(),
            label: "Local storage".into(),
            status: DoctorStatus::Fail,
            message: error.to_string(),
        },
    }
}
