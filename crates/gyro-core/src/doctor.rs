use crate::{
    config::GyroConfig,
    execution::{
        run_command, CancellationToken, ExecutionOutcome, ExecutionRequest, ExecutionTermination,
    },
    paths::GyroPaths,
};
use serde::{Deserialize, Serialize};
use std::{ffi::OsString, path::PathBuf, time::Duration};

const DOCTOR_COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const DOCTOR_MAX_STDOUT_CHARS: usize = 8 * 1024;
const DOCTOR_MAX_STDERR_CHARS: usize = 8 * 1024;

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
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
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
    let checks = vec![
        command_check("git", "Git", &["--version"]),
        shell_check(),
        app_install_check(),
        update_source_check(),
        provider_key_check(config),
        storage_check(paths),
    ];

    DoctorReport { checks }
}

fn command_check(command: &str, label: &str, args: &[&str]) -> DoctorCheck {
    command_check_with_limits(
        command,
        label,
        args,
        DOCTOR_COMMAND_TIMEOUT,
        DOCTOR_MAX_STDOUT_CHARS,
        DOCTOR_MAX_STDERR_CHARS,
    )
}

fn command_check_with_limits(
    command: &str,
    label: &str,
    args: &[&str],
    timeout: Duration,
    max_stdout_chars: usize,
    max_stderr_chars: usize,
) -> DoctorCheck {
    let mut request = ExecutionRequest::new(command);
    request.args = args.iter().copied().map(OsString::from).collect();
    request.timeout = timeout;
    request.max_stdout_chars = max_stdout_chars;
    request.max_stderr_chars = max_stderr_chars;
    match run_command(request, CancellationToken::default(), |_| {}) {
        Ok(output) if output.succeeded() => DoctorCheck {
            id: command.into(),
            label: label.into(),
            status: DoctorStatus::Pass,
            message: retained_command_output(
                &output.stdout,
                output.stdout_truncated,
                "stdout truncated",
            ),
            required: true,
            next: None,
        },
        Ok(output) => DoctorCheck {
            id: command.into(),
            label: label.into(),
            status: DoctorStatus::Fail,
            message: doctor_command_error(command, args, &output, timeout),
            required: true,
            next: Some(format!(
                "install {label} and confirm `{command} {}` succeeds",
                args.join(" ")
            )),
        },
        Err(error) => DoctorCheck {
            id: command.into(),
            label: label.into(),
            status: DoctorStatus::Fail,
            message: error.to_string(),
            required: true,
            next: Some(format!(
                "install {label} and confirm `{command} {}` succeeds",
                args.join(" ")
            )),
        },
    }
}

fn doctor_command_error(
    command: &str,
    args: &[&str],
    output: &ExecutionOutcome,
    timeout: Duration,
) -> String {
    let command_label = std::iter::once(command)
        .chain(args.iter().copied())
        .collect::<Vec<_>>()
        .join(" ");
    match &output.termination {
        ExecutionTermination::Exited { .. } => {
            retained_command_output(&output.stderr, output.stderr_truncated, "stderr truncated")
        }
        ExecutionTermination::TimedOut => {
            format!("`{command_label}` timed out after {timeout:?}")
        }
        ExecutionTermination::Cancelled => format!("`{command_label}` was cancelled"),
        ExecutionTermination::Inactive => {
            format!("`{command_label}` stopped after becoming inactive")
        }
        ExecutionTermination::OutputLimit => {
            format!("`{command_label}` exceeded its output limit")
        }
    }
}

fn retained_command_output(output: &str, truncated: bool, marker: &str) -> String {
    let mut output = output.trim().to_string();
    if truncated {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push('[');
        output.push_str(marker);
        output.push(']');
    }
    output
}

fn shell_check() -> DoctorCheck {
    match std::env::var("SHELL") {
        Ok(shell) => DoctorCheck {
            id: "shell".into(),
            label: "Default shell".into(),
            status: DoctorStatus::Pass,
            message: shell,
            required: false,
            next: None,
        },
        Err(_) => DoctorCheck {
            id: "shell".into(),
            label: "Default shell".into(),
            status: DoctorStatus::Warn,
            message: "SHELL is not set".into(),
            required: false,
            next: Some("set `SHELL` to your preferred shell, such as `/bin/zsh`".into()),
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
            .as_ref()
            .map(|path| format!("Installed at {}", path.display()))
            .unwrap_or_else(|| "Gyro.app was not found in /Applications or ~/Applications".into()),
        required: false,
        next: installed_path.is_none().then(|| {
            "install Gyro.app for visual handoff, or continue using the CLI on its own".into()
        }),
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
        required: true,
        next: None,
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
            required: false,
            next: Some(
                "run `gyro config enable-provider openai` or connect a provider in Gyro.app".into(),
            ),
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
        required: false,
        next: None,
    }
}

fn storage_check(paths: &GyroPaths) -> DoctorCheck {
    match paths.ensure() {
        Ok(()) => DoctorCheck {
            id: "storage".into(),
            label: "Local storage".into(),
            status: DoctorStatus::Pass,
            message: paths.base_dir.display().to_string(),
            required: true,
            next: None,
        },
        Err(error) => DoctorCheck {
            id: "storage".into(),
            label: "Local storage".into(),
            status: DoctorStatus::Fail,
            message: error.to_string(),
            required: true,
            next: Some(format!(
                "check write permissions for {} and retry `gyro doctor`",
                paths.base_dir.display()
            )),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{command_check_with_limits, first_installed_app, provider_key_check, DoctorStatus};
    use crate::GyroConfig;
    use std::fs;
    use std::time::Duration;

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

    #[test]
    fn optional_provider_check_includes_safe_remediation() {
        let check = provider_key_check(&GyroConfig::default());

        assert_eq!(check.status, DoctorStatus::Warn);
        assert!(!check.required);
        assert_eq!(
            check.next.as_deref(),
            Some("run `gyro config enable-provider openai` or connect a provider in Gyro.app")
        );
    }

    #[cfg(unix)]
    #[test]
    fn command_check_reports_timeout_as_failure() {
        let check = command_check_with_limits(
            "/bin/sh",
            "Slow command",
            &["-c", "sleep 5"],
            Duration::from_millis(50),
            128,
            128,
        );

        assert_eq!(check.status, DoctorStatus::Fail);
        assert_eq!(check.message, "`/bin/sh -c sleep 5` timed out after 50ms");
        assert!(check.required);
    }
}
