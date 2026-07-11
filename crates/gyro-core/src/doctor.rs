use crate::{config::GyroConfig, paths::GyroPaths};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, process::Command};

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
    checks.push(update_source_check());
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
    let installed_path = {
        let system_app = PathBuf::from("/Applications/Gyro.app");
        let user_app = std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|home| home.join("Applications/Gyro.app"));
        first_installed_app(std::iter::once(system_app).chain(user_app))
    };
    #[cfg(not(target_os = "macos"))]
    let installed_path: Option<PathBuf> = None;

    DoctorCheck {
        id: "desktop-app".into(),
        label: "Gyro.app".into(),
        status: if installed_path.is_some() {
            DoctorStatus::Pass
        } else {
            DoctorStatus::Warn
        },
        message: installed_path
            .map(|path| format!("Installed at {}", path.display()))
            .unwrap_or_else(|| "Gyro.app was not found in /Applications or ~/Applications".into()),
    }
}

fn first_installed_app(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|path| path.exists())
}

fn update_source_check() -> DoctorCheck {
    DoctorCheck {
        id: "update-source".into(),
        label: "Update source".into(),
        status: DoctorStatus::Pass,
        message: "Stable via GitHub Releases".into(),
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

    let names = enabled
        .iter()
        .map(|provider| provider.display_name.as_str())
        .collect::<Vec<_>>();

    DoctorCheck {
        id: "model-provider".into(),
        label: "Model provider".into(),
        status: DoctorStatus::Pass,
        message: format!(
            "Enabled provider profiles use external auth: {}",
            names.join(", ")
        ),
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

#[cfg(test)]
mod tests {
    use super::first_installed_app;
    use std::fs;

    #[test]
    fn finds_user_application_when_system_application_is_missing() {
        let root = std::env::temp_dir().join(format!("gyro-doctor-{}", std::process::id()));
        let system_app = root.join("system/Gyro.app");
        let user_app = root.join("user/Applications/Gyro.app");
        fs::create_dir_all(&user_app).expect("create user application fixture");

        let installed = first_installed_app([system_app, user_app.clone()]);

        assert_eq!(installed, Some(user_app));
        fs::remove_dir_all(root).expect("remove doctor fixture");
    }
}
