use super::{CancellationToken, TerminalPaneSnapshot};
use std::time::{Duration, Instant};

/// Longest single wait. Every wait call re-sends the model's whole context, so
/// one five-minute wait on a build is far cheaper than five one-minute polls.
pub(super) const MAX_WAIT_MS: u64 = 300_000;

pub(super) fn timeout(arguments: &serde_json::Value) -> anyhow::Result<Duration> {
    let millis = match arguments.get("timeoutMs") {
        None => 60_000,
        Some(value) => value
            .as_u64()
            .filter(|value| *value <= MAX_WAIT_MS)
            .ok_or_else(|| {
                anyhow::anyhow!("timeoutMs must be an integer from 0 to {MAX_WAIT_MS}")
            })?,
    };
    Ok(Duration::from_millis(millis))
}

/// Sleep between status checks without holding the process or resource locks.
/// A bounded wait yields a tool result; it never kills a still-running command.
/// `read(false)` polls status only; the output is copied once, on return.
pub(super) fn wait(
    timeout: Duration,
    cancellation: &CancellationToken,
    mut read: impl FnMut(bool) -> anyhow::Result<TerminalPaneSnapshot>,
) -> anyhow::Result<TerminalPaneSnapshot> {
    let started = Instant::now();
    let mut exited_at = None;
    loop {
        if cancellation.is_cancelled() {
            anyhow::bail!("command wait cancelled");
        }
        let snapshot = read(false)?;
        // Process exit can race the PTY reader's final output. Give it a bounded
        // drain period; descendants may keep the PTY open after the command exits.
        let finished = if snapshot.status != "running" {
            let exited = exited_at.get_or_insert_with(Instant::now);
            snapshot.output_complete || exited.elapsed() >= Duration::from_millis(500)
        } else {
            false
        };
        if finished || started.elapsed() >= timeout {
            return read(true);
        }
        std::thread::sleep(
            Duration::from_millis(100).min(timeout.saturating_sub(started.elapsed())),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        desktop_capability_tool_schema, CapabilityId, TerminalPaneRequest, TerminalProcessManager,
    };

    fn command(script: &str) -> TerminalProcessManager {
        let manager = TerminalProcessManager::default();
        manager
            .create(TerminalPaneRequest {
                pane_id: "wait-test".into(),
                title: "Wait test".into(),
                command: "sh".into(),
                args: vec!["-c".into(), script.into()],
                ..Default::default()
            })
            .unwrap();
        manager
    }

    #[test]
    fn waits_for_success_and_failure_and_returns_exit_codes() {
        for code in [0, 7] {
            let manager = command(&format!("printf build-output; sleep 0.2; exit {code}"));
            let snapshot = wait(
                Duration::from_secs(5),
                &CancellationToken::default(),
                |full| manager.observe("wait-test", full),
            )
            .unwrap();
            assert_eq!(snapshot.exit_code, Some(code));
            assert_eq!(snapshot.status, if code == 0 { "done" } else { "failed" });
            assert!(snapshot.output.unwrap_or_default().contains("build-output"));
            // Waiting again observes the same finished command; it never relaunches it.
            assert_eq!(
                wait(Duration::ZERO, &CancellationToken::default(), |full| {
                    manager.observe("wait-test", full)
                })
                .unwrap()
                .exit_code,
                Some(code)
            );
        }
    }

    #[test]
    fn polls_skip_output_and_only_the_returned_snapshot_carries_it() {
        let manager = command("printf polled; sleep 0.3");
        let mut polls_with_output = Vec::new();
        let snapshot = wait(
            Duration::from_secs(5),
            &CancellationToken::default(),
            |full| {
                let snapshot = manager.observe("wait-test", full)?;
                if !full {
                    polls_with_output.push(snapshot.output.is_some());
                }
                Ok(snapshot)
            },
        )
        .unwrap();
        assert!(polls_with_output.len() > 1);
        assert!(polls_with_output.iter().all(|copied| !copied));
        assert!(snapshot.output.unwrap_or_default().contains("polled"));
    }

    #[test]
    fn timeout_keeps_command_alive_and_a_later_wait_completes() {
        let manager = command("sleep 0.5; printf finished");
        let snapshot = wait(
            Duration::from_millis(20),
            &CancellationToken::default(),
            |full| manager.observe("wait-test", full),
        )
        .unwrap();
        assert_eq!(snapshot.status, "running");
        assert_eq!(snapshot.exit_code, None);
        let snapshot = wait(
            Duration::from_secs(5),
            &CancellationToken::default(),
            |full| manager.observe("wait-test", full),
        )
        .unwrap();
        assert_eq!(snapshot.exit_code, Some(0));
        assert!(snapshot.output.unwrap_or_default().contains("finished"));
    }

    #[test]
    fn cancelled_wait_exits_promptly_without_stopping_command() {
        let manager = command("sleep 5");
        let cancellation = CancellationToken::default();
        let cancel = cancellation.clone();
        let worker = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            cancel.cancel();
        });
        let started = Instant::now();
        let result = wait(Duration::from_secs(5), &cancellation, |full| {
            manager.observe("wait-test", full)
        });
        assert!(result.unwrap_err().to_string().contains("cancelled"));
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(manager.read("wait-test", None).unwrap().status, "running");
        worker.join().unwrap();
        manager.stop("wait-test").unwrap();
    }

    #[test]
    fn propagates_missing_or_replaced_resource_without_retrying() {
        let result = wait(
            Duration::from_secs(5),
            &CancellationToken::default(),
            |_| anyhow::bail!("terminal resource ownership changed"),
        );
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("ownership changed"));
    }

    #[test]
    fn schema_and_runtime_bound_waits_consistently() {
        assert_eq!(
            timeout(&serde_json::json!({})).unwrap(),
            Duration::from_secs(60)
        );
        assert_eq!(
            timeout(&serde_json::json!({"timeoutMs": 0})).unwrap(),
            Duration::ZERO
        );
        assert_eq!(
            timeout(&serde_json::json!({"timeoutMs": MAX_WAIT_MS})).unwrap(),
            Duration::from_secs(300)
        );
        for value in [
            serde_json::json!(-1),
            serde_json::json!(MAX_WAIT_MS + 1),
            serde_json::json!(1.5),
            serde_json::json!("1000"),
        ] {
            assert!(timeout(&serde_json::json!({"timeoutMs": value})).is_err());
        }
        let schema = desktop_capability_tool_schema(CapabilityId::TerminalWait);
        assert_eq!(schema["required"], serde_json::json!(["resourceId"]));
        assert_eq!(schema["properties"]["timeoutMs"]["maximum"], MAX_WAIT_MS);
        assert_eq!(
            CapabilityId::from_provider_tool_name("gyro_terminal_wait"),
            Some(CapabilityId::TerminalWait)
        );
    }
}
