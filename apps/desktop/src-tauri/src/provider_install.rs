//! Guided CLI install for a provider whose binary is missing.
//!
//! The desktop shows the vendor command before anything runs. This module is
//! the only place an installer runs, and the command always comes from
//! `gyro_core`'s install table, never from the webview.

use gyro_core::execution::{
    run_command, CancellationToken, ExecutionRequest, ExecutionTermination,
};
use std::time::Duration;

use serde::Serialize;

/// Ceiling for one vendor installer before Gyro gives up on it.
const INSTALL_BUDGET: Duration = Duration::from_secs(15 * 60);
/// How much installer output is kept for the UI.
const INSTALL_OUTPUT_LIMIT: usize = 32 * 1024;

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
    let health = crate::providers::health::check_provider_health_blocking(
        gyro_core::ProviderHealthRequest {
            provider_id: provider_id.clone(),
            api_key_ref: None,
            base_url: None,
            kind: None,
            // The installer just changed the device, so a cached probe is stale.
            force: true,
        },
    )
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
    run_installer_with_budget(command, INSTALL_BUDGET)
}

fn run_installer_with_budget(command: &str, budget: Duration) -> Result<String, String> {
    // Drain both pipes while the installer runs. The shared runner bounds
    // output, observes deadlines and reaps the entire process group on exit.
    let mut request = ExecutionRequest::new("/bin/bash");
    request.args = vec!["-lc".into(), command.into()];
    request.timeout = budget;
    request.max_stdout_chars = INSTALL_OUTPUT_LIMIT;
    request.max_stderr_chars = INSTALL_OUTPUT_LIMIT;
    let outcome = run_command(request, CancellationToken::default(), |_| {})
        .map_err(|error| format!("Could not run `{command}`: {error}"))?;
    let output = transcript(
        &outcome.stdout,
        &outcome.stderr,
        outcome.stdout_truncated || outcome.stderr_truncated,
    );
    match outcome.termination {
        ExecutionTermination::Exited { code: Some(0) } => Ok(output),
        ExecutionTermination::TimedOut => Err(format!(
            "`{command}` did not finish within {} seconds.",
            budget.as_secs()
        )),
        ExecutionTermination::Exited { code } => Err(format!(
            "`{command}` exited unsuccessfully ({code:?}).\n{output}"
        )),
        _ => Err(format!("`{command}` stopped before completing.\n{output}")),
    }
}

/// Keep a byte-bounded transcript without splitting a Unicode character.
fn transcript(stdout: &str, stderr: &str, truncated: bool) -> String {
    let mut text = stdout.trim_end().to_string();
    if !stderr.trim().is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(stderr.trim_end());
    }
    if text.len() > INSTALL_OUTPUT_LIMIT || truncated {
        let mut end = text.len().min(INSTALL_OUTPUT_LIMIT);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push_str("\n(output truncated)");
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbose_installer_drains_both_pipes_and_bounds_the_transcript() {
        let start = std::time::Instant::now();
        let output = run_installer_with_budget(
            "/usr/bin/awk 'BEGIN {for(i=0;i<10000;i++) print \"fixture stdout line\"}'; /usr/bin/awk 'BEGIN {for(i=0;i<10000;i++) print \"fixture stderr line\"}' >&2",
            Duration::from_secs(5),
        ).unwrap();
        eprintln!(
            "verbose installer fixture completed in {:?}",
            start.elapsed()
        );
        assert!(output.starts_with("fixture stdout line"));
        assert!(output.ends_with("(output truncated)"));
        assert!(output.len() <= INSTALL_OUTPUT_LIMIT + 20);

        // The same immutable 1 MiB fixture used to reproduce the old stall.
        let start = std::time::Instant::now();
        let output = run_installer_with_budget(
            "exec /usr/bin/head -c 1048576 /dev/zero",
            Duration::from_secs(5),
        )
        .unwrap();
        eprintln!("1 MiB installer fixture completed in {:?}", start.elapsed());
        assert!(output.ends_with("(output truncated)"));
        assert!(output.len() <= INSTALL_OUTPUT_LIMIT + 20);
    }

    #[test]
    fn unicode_transcripts_do_not_panic_at_the_byte_limit() {
        let output = transcript(&"€".repeat(INSTALL_OUTPUT_LIMIT), "", false);
        assert!(output.ends_with("(output truncated)"));
        assert!(output.len() <= INSTALL_OUTPUT_LIMIT + 20);
        assert_eq!(transcript("out\n", "err\n", false), "out\nerr");
    }

    #[test]
    fn installer_deadlines_and_nonzero_exits_are_failures() {
        assert!(run_installer_with_budget("exit 7", Duration::from_secs(2))
            .unwrap_err()
            .contains("unsuccessfully"));
        assert!(
            run_installer_with_budget("exec /bin/sleep 30", Duration::from_millis(100))
                .unwrap_err()
                .contains("did not finish")
        );
    }
}
