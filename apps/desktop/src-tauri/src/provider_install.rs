//! Guided CLI install for a provider whose binary is missing.
//!
//! The desktop shows the vendor command before anything runs. This module is
//! the only place an installer runs, and the command always comes from
//! `gyro_core`'s install table, never from the webview.

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

/// Ceiling for one vendor installer before Gyro gives up on it.
const INSTALL_BUDGET: Duration = Duration::from_secs(15 * 60);
/// How much installer output is kept for the UI.
const INSTALL_OUTPUT_LIMIT: usize = 32 * 1024;
/// Poll interval while the installer runs.
const INSTALL_POLL: Duration = Duration::from_millis(200);

/// What one confirmed install produced.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallOutcome {
    pub provider_id: String,
    pub command: String,
    /// Whether the provider's CLI answers a probe once the installer exited.
    pub installed: bool,
    pub output: String,
    /// Fresh health, so the UI can continue straight into sign-in.
    pub health: Option<gyro_core::ProviderHealthCheck>,
}

/// Run one provider's vendor installer, but only after the user confirmed it.
#[tauri::command]
pub(crate) async fn install_provider_cli(
    provider_id: String,
    confirm: bool,
) -> Result<InstallOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || install_blocking(provider_id, confirm))
        .await
        .map_err(|error| format!("install worker stopped: {error}"))?
}

fn install_blocking(provider_id: String, confirm: bool) -> Result<InstallOutcome, String> {
    if !confirm {
        return Err("Installing a provider CLI needs explicit confirmation.".into());
    }
    let command = gyro_core::install_command(&provider_id).ok_or_else(|| {
        let docs = gyro_core::install_guide(&provider_id)
            .map(|guide| guide.docs_url)
            .unwrap_or("the vendor's site");
        format!("Gyro has no verified installer for `{provider_id}`; install it from {docs}.")
    })?;

    let output = run_installer(command)?;
    let health = crate::check_provider_health_blocking(gyro_core::ProviderHealthRequest {
        provider_id: provider_id.clone(),
        api_key_ref: None,
        base_url: None,
        kind: None,
        // The installer just changed the device, so a cached probe is stale.
        force: true,
    })
    .ok();
    let installed = health
        .as_ref()
        .is_some_and(|check| check.runtime_status != "not-installed");

    Ok(InstallOutcome {
        provider_id,
        command: command.to_string(),
        installed,
        output,
        health,
    })
}

fn run_installer(command: &str) -> Result<String, String> {
    // A login shell inherits the user's own PATH, which is where a fresh CLI
    // lands; the app process alone only sees the short Dock PATH.
    let mut child = Command::new("/bin/bash")
        .args(["-lc", command])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start `{command}`: {error}"))?;

    let deadline = Instant::now() + INSTALL_BUDGET;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(INSTALL_POLL),
            Ok(None) => {
                let _ = child.kill();
                return Err(format!("`{command}` did not finish within fifteen minutes."));
            }
            Err(error) => return Err(format!("`{command}` could not be watched: {error}")),
        }
    }

    let finished = child
        .wait_with_output()
        .map_err(|error| format!("`{command}` produced no readable output: {error}"))?;
    Ok(transcript(&finished))
}

/// Stdout and stderr folded into one transcript for the UI to show verbatim.
fn transcript(output: &std::process::Output) -> String {
    let mut text = String::from_utf8_lossy(&output.stdout).trim_end().to_string();
    let errors = String::from_utf8_lossy(&output.stderr);
    if !errors.trim().is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(errors.trim_end());
    }
    if text.len() > INSTALL_OUTPUT_LIMIT {
        text.truncate(INSTALL_OUTPUT_LIMIT);
        text.push_str("\n(output truncated)");
    }
    text
}
