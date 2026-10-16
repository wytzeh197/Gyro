use super::*;

// Report presence only; test diagnostics must never echo environment values.
const PROBE: &str = r#"printf '%s|%s|%s|%s|%s|%s' \
    "${GYRO_COMMAND_FIXTURE_API_KEY+set}" "${OPENAI_API_KEY+set}" \
    "${GITHUB_TOKEN+set}" "${GYRO_COMMAND_OVERRIDE_SECRET+set}" \
    "${GYRO_COMMAND_BYTES_API_KEY+set}" "$GYRO_COMMAND_FIXTURE_PLAIN""#;
const SCRUBBED: &str = "|||||plain-value";
const INHERITED: &str = "set|set|set|set|set|plain-value";

// Run inherited-environment checks in a separate test process. Mutating the
// main test runner's environment would race unrelated provider/auth tests.
fn run_fixture(kind: &str) {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "command_execution::tests::credential_environment_child",
            "--ignored",
            "--nocapture",
        ])
        .env("GYRO_COMMAND_ENV_FIXTURE", kind)
        .env("GYRO_COMMAND_FIXTURE_API_KEY", "synthetic-fixture")
        .env("OPENAI_API_KEY", "synthetic-fixture")
        .env("GITHUB_TOKEN", "synthetic-fixture")
        .env("GYRO_COMMAND_FIXTURE_PLAIN", "plain-value");
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        command.env(
            "GYRO_COMMAND_BYTES_API_KEY",
            std::ffi::OsString::from_vec(b"synthetic-\xff".to_vec()),
        );
    }
    let result =
        run_bounded_command(&command, Duration::from_secs(20), None, 16_384, 16_384).unwrap();
    assert!(
        result.succeeded(),
        "{kind} fixture failed: {:?}\n{}\n{}",
        result.termination,
        result.stdout,
        result.stderr
    );
}

#[cfg(unix)]
#[test]
fn model_foreground_task_scrubs_inheritance_and_explicit_overrides() {
    run_fixture("foreground");
}

#[cfg(unix)]
#[test]
fn model_pty_scrubs_credentials_on_first_launch_and_restart() {
    run_fixture("pty");
}

#[cfg(unix)]
#[test]
fn human_commands_and_governed_provider_panes_preserve_their_environment() {
    run_fixture("human");
}

#[test]
fn renderer_cannot_select_terminal_execution_policies() {
    let request: TerminalPaneRequest = serde_json::from_value(serde_json::json!({
        "paneId": "model:spoofed",
        "title": "Shell",
        "command": "/bin/sh",
        "args": [],
        "credentialPolicy": {"scrubbed": {"allowed": ["OPENAI_API_KEY"]}},
        "executionBoundary": {"Workspace": {"root": "/", "home": "/", "private_data_root": "/"}},
        "modelCommandContext": {"sessionId": "spoofed", "mode": "normal", "workspace": "/"}
    }))
    .unwrap();
    assert_eq!(request.credential_policy, CredentialPolicy::Inherit);
    assert!(request.model_command_context.is_none());
    assert!(matches!(
        request.execution_boundary,
        ModelCommandBoundary::Unrestricted
    ));
}

#[test]
fn full_access_requires_explicit_flags_normal_mode_and_delegation_ceiling() {
    for (label, full_access, command_approval, file_approval, mode, ceiling, expected) in [
        (
            "explicit Full access",
            true,
            false,
            false,
            CapabilityRunMode::Normal,
            true,
            true,
        ),
        (
            "no Full access flag",
            false,
            false,
            false,
            CapabilityRunMode::Normal,
            true,
            false,
        ),
        (
            "command approval retained",
            true,
            true,
            false,
            CapabilityRunMode::Normal,
            true,
            false,
        ),
        (
            "file approval retained",
            true,
            false,
            true,
            CapabilityRunMode::Normal,
            true,
            false,
        ),
        (
            "plan mode",
            true,
            false,
            false,
            CapabilityRunMode::Plan,
            true,
            false,
        ),
        (
            "council mode",
            true,
            false,
            false,
            CapabilityRunMode::Council,
            true,
            false,
        ),
        (
            "restricted delegated child",
            true,
            false,
            false,
            CapabilityRunMode::Normal,
            false,
            false,
        ),
    ] {
        let config = GyroConfig {
            full_access,
            require_command_approval: command_approval,
            require_file_edit_approval: file_approval,
            ..Default::default()
        };
        assert_eq!(
            model_command_full_access(&config, mode, ceiling),
            expected,
            "{label}"
        );
    }
}

#[test]
#[ignore = "subprocess entrypoint for isolated environment fixtures"]
fn credential_environment_child() {
    match std::env::var("GYRO_COMMAND_ENV_FIXTURE").unwrap().as_str() {
        "foreground" => {
            let temp = tempfile::tempdir().unwrap();
            let mut command = probe_command();
            command.current_dir(temp.path());
            let output = run_model_task_output_with_cancellation(
                command,
                CancellationToken::default(),
                &ModelCommandBoundary::Unrestricted,
            )
            .unwrap();
            assert_eq!(output.status, "done");
            assert_eq!(output.exit_code, Some(0));
            assert_eq!(output.stdout, SCRUBBED);
            // Existing cancellation behavior survives the
            // model-specific execution path, not just its environment filter.
            let marker = temp.path().join("must-not-run");
            let mut command = Command::new("/usr/bin/touch");
            command.arg(&marker);
            let cancellation = CancellationToken::default();
            cancellation.cancel();
            let output = run_model_task_output_with_cancellation(
                command,
                cancellation,
                &ModelCommandBoundary::Unrestricted,
            )
            .unwrap();
            assert_eq!(output.status, "cancelled");
            assert!(!marker.exists());
        }
        "pty" => {
            let temp = tempfile::tempdir().unwrap();
            let workspace = temp.path().canonicalize().unwrap();
            let mut request = model_terminal_request(
                "model:fixture".into(),
                "Model fixture".into(),
                "/bin/sh".into(),
                vec!["-c".into(), PROBE.into()],
                workspace.to_str().unwrap(),
                &workspace,
                ModelCommandBoundary::Unrestricted,
            );
            // Exercise scrubbing after all terminal env additions, including
            // a credential that was not inherited from the parent process.
            request.governance = Some(fixture_governance());
            let manager = TerminalProcessManager::default();
            manager.create(request).unwrap();
            assert_terminal_output(&manager, "model:fixture", SCRUBBED);
            manager.restart("model:fixture").unwrap();
            assert_terminal_output(&manager, "model:fixture", SCRUBBED);
            manager.close("model:fixture").unwrap();
        }
        "human" => {
            let output = run_command_output(probe_command()).unwrap();
            assert_eq!(output.status, "done");
            assert_eq!(output.stdout, INHERITED);
            let manager = TerminalProcessManager::default();
            manager
                .create(TerminalPaneRequest {
                    pane_id: "human:fixture".into(),
                    title: "Governed provider fixture".into(),
                    command: "/bin/sh".into(),
                    args: vec!["-c".into(), PROBE.into()],
                    governance: Some(fixture_governance()),
                    ..Default::default()
                })
                .unwrap();
            assert_terminal_output(&manager, "human:fixture", INHERITED);
            manager.close("human:fixture").unwrap();
        }
        _ => panic!("unknown environment fixture"),
    }
}

#[cfg(target_os = "macos")]
#[path = "command_execution_sandbox_tests.rs"]
mod sandbox;

fn probe_command() -> Command {
    let mut command = Command::new("/bin/sh");
    command
        .args(["-c", PROBE])
        .env("GYRO_COMMAND_OVERRIDE_SECRET", "synthetic-override");
    command
}

fn fixture_governance() -> PaneGovernance {
    PaneGovernance {
        session_id: "fixture".into(),
        provider_id: "anthropic".into(),
        args: vec![],
        env: vec![(
            "GYRO_COMMAND_OVERRIDE_SECRET".into(),
            "synthetic-override".into(),
        )],
    }
}

fn assert_terminal_output(manager: &TerminalProcessManager, id: &str, expected: &str) {
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        let snapshot = manager.read(id, None).unwrap();
        if snapshot.output.as_deref() == Some(expected) && snapshot.status == "done" {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "terminal {id} did not complete with the expected credential-presence flags: {:?}, {:?}",
            snapshot.status,
            snapshot.output
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}
