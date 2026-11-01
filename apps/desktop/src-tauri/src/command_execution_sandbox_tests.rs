use super::*;

// Only synthetic paths are supplied as credential roots. These tests exercise
// desktop wiring; detailed Seatbelt policy cases live in gyro-core.
struct Fixture {
    _temp: tempfile::TempDir,
    workspace: PathBuf,
    home: PathBuf,
    private_data: PathBuf,
    outside: PathBuf,
    secret: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let workspace = root.join("workspace");
        let home = root.join("home");
        let private_data = root.join("private-data");
        for path in [&workspace, &home, &private_data, &home.join(".ssh")] {
            std::fs::create_dir_all(path).unwrap();
        }
        let secret = home.join(".ssh/synthetic-fixture");
        std::fs::write(&secret, "synthetic fixture only").unwrap();
        Self {
            _temp: temp,
            workspace,
            home,
            private_data,
            outside: root.join("outside-marker"),
            secret,
        }
    }

    fn boundary(&self) -> ModelCommandBoundary {
        ModelCommandBoundary::Workspace {
            root: self.workspace.clone(),
            home: self.home.clone(),
            private_data_root: self.private_data.clone(),
        }
    }

    fn probe_args(&self) -> Vec<String> {
        vec![
            "-c".into(),
            r#"set -eu
printf ran >> allowed-marker
if { printf outside > "$1"; } 2>/dev/null; then exit 41; fi
if /bin/cat "$2" >/dev/null 2>&1; then exit 42; fi
printf scratch > "$TMPDIR/probe"
printf 'scratch=%s' "$TMPDIR""#
                .into(),
            "gyro-boundary-fixture".into(),
            self.outside.to_str().unwrap().into(),
            self.secret.to_str().unwrap().into(),
        ]
    }

    fn terminal(
        &self,
        id: &str,
        args: Vec<String>,
        boundary: ModelCommandBoundary,
    ) -> TerminalPaneRequest {
        model_terminal_request(
            id.into(),
            "Boundary fixture".into(),
            "/bin/sh".into(),
            args,
            self.workspace.to_str().unwrap(),
            &self.workspace,
            boundary,
        )
    }
}

fn assert_scratch_removed(output: &str) -> PathBuf {
    let path = PathBuf::from(
        output
            .strip_prefix("scratch=")
            .expect("scratch probe output"),
    );
    let root = path.parent().unwrap();
    assert!(root
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("gyro-sandbox-"));
    assert!(
        !root.exists(),
        "command scratch must be removed after the process is reaped"
    );
    path
}

fn completed_terminal(manager: &TerminalProcessManager, id: &str) -> TerminalPaneSnapshot {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let snapshot = manager.read(id, None).unwrap();
        assert_ne!(
            snapshot.status, "failed",
            "terminal failed: {:?}",
            snapshot.output
        );
        // The PTY reader can deliver its final bytes after try_wait sees exit.
        if snapshot.status == "done"
            && snapshot.output_complete
            && snapshot
                .output
                .as_deref()
                .is_some_and(|output| !output.is_empty())
        {
            assert_eq!(snapshot.exit_code, Some(0));
            return snapshot;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "terminal did not finish: {:?}",
            snapshot.output
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn foreground_model_task_enforces_workspace_and_cleans_private_scratch() {
    let fixture = Fixture::new();
    let mut command = Command::new("/bin/sh");
    command
        .args(fixture.probe_args())
        .current_dir(&fixture.workspace);
    // Sandbox overrides must win over command-provided cache/temp values.
    command.env("TMPDIR", &fixture.home);
    let result = run_model_task_output_with_cancellation(
        command,
        CancellationToken::default(),
        &fixture.boundary(),
    )
    .unwrap();
    assert_eq!(result.status, "done", "{}", result.stderr);
    assert_eq!(result.exit_code, Some(0));
    assert_eq!(
        std::fs::read_to_string(fixture.workspace.join("allowed-marker")).unwrap(),
        "ran"
    );
    assert!(!fixture.outside.exists());
    assert_scratch_removed(&result.stdout);
}

#[test]
fn model_pty_restart_keeps_boundary_original_command_and_fresh_scratch() {
    let fixture = Fixture::new();
    let args = fixture.probe_args();
    let displayed_command = format!("/bin/sh {}", args.join(" "));
    let manager = TerminalProcessManager::default();
    let initial = manager
        .create(fixture.terminal("model:boundary", args, fixture.boundary()))
        .unwrap();
    assert_eq!(initial.command, displayed_command);
    assert_eq!(initial.execution_policy, "workspace-filesystem");
    let first = completed_terminal(&manager, "model:boundary");
    let first_scratch = assert_scratch_removed(first.output.as_deref().unwrap());
    let restarted = manager.restart("model:boundary").unwrap();
    assert_eq!(restarted.command, displayed_command);
    assert_eq!(restarted.execution_policy, "workspace-filesystem");
    let second = completed_terminal(&manager, "model:boundary");
    assert_eq!(second.command, displayed_command);
    assert_eq!(second.execution_policy, "workspace-filesystem");
    let second_scratch = assert_scratch_removed(second.output.as_deref().unwrap());
    assert_ne!(first_scratch, second_scratch);
    assert_eq!(
        std::fs::read_to_string(fixture.workspace.join("allowed-marker")).unwrap(),
        "ranran"
    );
    assert!(!fixture.outside.exists());
    manager.close("model:boundary").unwrap();
}

#[test]
fn failed_boundary_preparation_never_starts_foreground_or_pty_command() {
    let fixture = Fixture::new();
    let invalid_boundary = ModelCommandBoundary::Workspace {
        root: fixture.workspace.join("missing-root"),
        home: fixture.home.clone(),
        private_data_root: fixture.private_data.clone(),
    };
    let marker = fixture.workspace.join("must-not-run");
    let mut command = Command::new("/usr/bin/touch");
    command.arg(&marker).current_dir(&fixture.workspace);
    assert!(run_model_task_output_with_cancellation(
        command,
        CancellationToken::default(),
        &invalid_boundary,
    )
    .is_err());
    assert!(!marker.exists());
    let manager = TerminalProcessManager::default();
    let request = fixture.terminal(
        "model:invalid-boundary",
        vec!["-c".into(), "printf started > must-not-run".into()],
        invalid_boundary,
    );
    assert!(manager.create(request).is_err());
    assert!(!marker.exists());
}

#[test]
fn explicit_full_access_allows_foreground_and_pty_external_writes() {
    let fixture = Fixture::new();
    let args = vec![
        "-c".into(),
        "printf ran >> \"$1\"; printf done".into(),
        "gyro-full-access-fixture".into(),
        fixture.outside.to_str().unwrap().into(),
    ];
    let mut command = Command::new("/bin/sh");
    command.args(&args).current_dir(&fixture.workspace);
    let result = run_model_task_output_with_cancellation(
        command,
        CancellationToken::default(),
        &ModelCommandBoundary::Unrestricted,
    )
    .unwrap();
    assert_eq!(result.status, "done");
    assert_eq!(std::fs::read_to_string(&fixture.outside).unwrap(), "ran");
    let manager = TerminalProcessManager::default();
    let snapshot = manager
        .create(fixture.terminal(
            "model:full-access",
            args,
            ModelCommandBoundary::Unrestricted,
        ))
        .unwrap();
    assert_eq!(snapshot.execution_policy, "unrestricted");
    assert_terminal_output(&manager, "model:full-access", "done");
    assert_eq!(std::fs::read_to_string(&fixture.outside).unwrap(), "ranran");
    manager.close("model:full-access").unwrap();
}

#[test]
fn model_pty_restart_refresh_can_tighten_but_never_upgrade_or_ignore_failure() {
    let fixture = Fixture::new();
    let args = vec![
        "-c".into(),
        r#"set -eu
printf ran >> restart-marker
if { printf ran >> "$1"; } 2>/dev/null; then printf allowed; else printf blocked; fi"#
            .into(),
        "gyro-restart-fixture".into(),
        fixture.outside.to_str().unwrap().into(),
    ];
    let displayed_command = format!("/bin/sh {}", args.join(" "));
    let manager = TerminalProcessManager::default();
    manager
        .create(fixture.terminal("model:refresh", args, ModelCommandBoundary::Unrestricted))
        .unwrap();
    assert_terminal_output(&manager, "model:refresh", "allowed");
    assert_eq!(std::fs::read_to_string(&fixture.outside).unwrap(), "ran");

    let failed_refresh_marker = fixture.workspace.join("failed-refresh-must-not-run");
    let error = manager
        .restart_with("model:refresh", |request| {
            // Even a mutated request must not launch when refresh fails.
            request.args = vec![
                "-c".into(),
                "printf started > \"$1\"".into(),
                "gyro-failed-refresh-fixture".into(),
                failed_refresh_marker.to_str().unwrap().into(),
            ];
            anyhow::bail!("synthetic policy refresh failure")
        })
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("synthetic policy refresh failure"));
    assert!(!failed_refresh_marker.exists());
    let unchanged = manager.read("model:refresh", None).unwrap();
    assert_eq!(unchanged.command, displayed_command);
    assert_eq!(unchanged.execution_policy, "unrestricted");
    assert_eq!(
        std::fs::read_to_string(fixture.workspace.join("restart-marker")).unwrap(),
        "ran"
    );

    let tightened = manager
        .restart_with("model:refresh", |request| {
            request
                .execution_boundary
                .tighten_for_restart(fixture.boundary());
            Ok(())
        })
        .unwrap();
    assert_eq!(tightened.command, displayed_command);
    assert_eq!(tightened.execution_policy, "workspace-filesystem");
    assert_terminal_output(&manager, "model:refresh", "blocked");
    assert_eq!(std::fs::read_to_string(&fixture.outside).unwrap(), "ran");

    let still_confined = manager
        .restart_with("model:refresh", |request| {
            request
                .execution_boundary
                .tighten_for_restart(ModelCommandBoundary::Unrestricted);
            Ok(())
        })
        .unwrap();
    assert_eq!(still_confined.command, displayed_command);
    assert_eq!(still_confined.execution_policy, "workspace-filesystem");
    assert_terminal_output(&manager, "model:refresh", "blocked");
    assert_eq!(std::fs::read_to_string(&fixture.outside).unwrap(), "ran");
    assert_eq!(
        std::fs::read_to_string(fixture.workspace.join("restart-marker")).unwrap(),
        "ranranran"
    );
    manager.close("model:refresh").unwrap();
}
