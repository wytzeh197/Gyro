#![cfg(unix)]

use gyro_core::{
    CommandProfile, CommandProfileReadiness, GyroConfig, GyroPaths, ModelProviderConfig,
    SessionOrigin, SessionStore,
};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

fn data_base(home: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support/Gyro")
    } else {
        home.join("data/Gyro")
    }
}

fn gyro_command(home: &Path, workspace: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_gyro"));
    command
        .current_dir(workspace)
        .env("HOME", home)
        .env("XDG_DATA_HOME", home.join("data"))
        .env("XDG_CONFIG_HOME", home.join("config"));
    command
}

fn write_config(home: &Path, command: &Path, approvals_required: bool) {
    write_provider_config(home, command, approvals_required, "openai");
}

fn write_provider_config(home: &Path, command: &Path, approvals_required: bool, provider_id: &str) {
    let paths = GyroPaths::from_base_dir(data_base(home));
    let config = GyroConfig {
        require_command_approval: approvals_required,
        require_file_edit_approval: approvals_required,
        model_providers: vec![ModelProviderConfig {
            id: provider_id.into(),
            display_name: provider_id.into(),
            base_url: None,
            api_key_ref: format!("provider:{provider_id}"),
            enabled: true,
        }],
        command_profiles: vec![CommandProfile {
            id: "test-provider".into(),
            display_name: "Test Provider".into(),
            command: command.display().to_string(),
            args: Vec::new(),
            working_directory: None,
            provider_id: Some(provider_id.into()),
            default_model: None,
            readiness: CommandProfileReadiness::Ready,
        }],
        ..GyroConfig::default()
    };
    config.save(&paths).unwrap();
}

fn write_script(folder: &Path, body: &str) -> PathBuf {
    let script = folder.join("provider.sh");
    fs::write(&script, format!("#!/bin/sh\n{body}\n")).unwrap();
    let mut permissions = fs::metadata(&script).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&script, permissions).unwrap();
    script
}

fn assert_failure(output: &Output, code: i32, category: &str) {
    assert_eq!(
        output.status.code(),
        Some(code),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stderr).unwrap_or_else(|error| {
        panic!(
            "stderr was not JSON ({error}): {}",
            String::from_utf8_lossy(&output.stderr)
        )
    });
    assert_eq!(value["schema"], "gyro.cli.v1");
    assert_eq!(value["status"], "failed");
    assert_eq!(value["error"]["category"], category);
    assert_eq!(value["error"]["code"], code);
}

fn assert_success_json(output: &Output) -> Value {
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "stdout was not JSON ({error}): {}",
            String::from_utf8_lossy(&output.stdout)
        )
    });
    assert_eq!(value["schema"], "gyro.cli.v1");
    value
}

#[test]
fn real_binary_reports_stable_input_provider_approval_execution_and_internal_codes() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let workspace = temp.path().join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&workspace).unwrap();

    let invalid = gyro_command(&home, &workspace)
        .args([
            "sessions",
            "--workspace",
            temp.path().join("missing").to_str().unwrap(),
            "--json",
        ])
        .output()
        .unwrap();
    assert_failure(&invalid, 2, "invalid-input");

    let paths = GyroPaths::from_base_dir(data_base(&home));
    let providerless = GyroConfig {
        require_command_approval: false,
        require_file_edit_approval: false,
        command_profiles: vec![CommandProfile {
            id: "shell".into(),
            display_name: "Shell".into(),
            command: "/bin/sh".into(),
            args: Vec::new(),
            working_directory: None,
            provider_id: None,
            default_model: None,
            readiness: CommandProfileReadiness::Ready,
        }],
        ..GyroConfig::default()
    };
    providerless.save(&paths).unwrap();
    let unavailable = gyro_command(&home, &workspace)
        .args([
            "run",
            "--profile",
            "shell",
            "--no-open",
            "--json",
            "--approve",
            "inspect",
        ])
        .output()
        .unwrap();
    assert_failure(&unavailable, 3, "provider-unavailable");

    let approval_script = write_script(
        temp.path(),
        r#"IFS= read -r initialize
printf '%s\n' '{"id":1,"result":{}}'
IFS= read -r initialized
IFS= read -r thread
printf '%s\n' '{"id":2,"result":{"thread":{"id":"thread-test"}}}'
IFS= read -r turn
printf '%s\n' '{"id":3,"result":{}}'
printf '%s\n' '{"id":41,"method":"item/commandExecution/requestApproval","params":{"command":"printf test","cwd":"/tmp","reason":"integration test"}}'
IFS= read -r decision
exit 0"#,
    );
    write_config(&home, &approval_script, true);
    let rejected = gyro_command(&home, &workspace)
        .args([
            "run",
            "--profile",
            "test-provider",
            "--no-open",
            "--json",
            "inspect",
        ])
        .output()
        .unwrap();
    assert_failure(&rejected, 4, "approval-rejected");

    let failing_script = write_script(temp.path(), "exit 9");
    write_config(&home, &failing_script, false);
    let failed = gyro_command(&home, &workspace)
        .args([
            "run",
            "--profile",
            "test-provider",
            "--no-open",
            "--json",
            "inspect",
        ])
        .output()
        .unwrap();
    assert_failure(&failed, 5, "execution-failed");

    fs::write(paths.config_path, "{invalid-json").unwrap();
    let internal = gyro_command(&home, &workspace)
        .args(["config", "show", "--json"])
        .output()
        .unwrap();
    assert_failure(&internal, 70, "internal");
}

#[test]
fn real_binary_surfaces_structured_claude_authentication_failures() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let workspace = temp.path().join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&workspace).unwrap();
    let provider = write_script(
        temp.path(),
        r#"printf '%s\n' '{"type":"result","subtype":"error_during_execution","is_error":true,"api_error_status":401,"result":"Failed to authenticate. API Error: 401 Invalid authentication credentials; token=secret-provider-token"}'
exit 1"#,
    );
    write_provider_config(&home, &provider, false, "anthropic");

    let output = gyro_command(&home, &workspace)
        .args([
            "run",
            "--profile",
            "test-provider",
            "--no-open",
            "--json",
            "inspect",
        ])
        .output()
        .unwrap();

    assert_failure(&output, 3, "provider-unavailable");
    let value: Value = serde_json::from_slice(&output.stderr).unwrap();
    let message = value["error"]["message"].as_str().unwrap();
    assert!(message.contains("Claude authentication failed"));
    assert!(message.contains("claude auth login"));
    assert!(message.contains("Gyro session was saved"));
    assert!(message.contains("[REDACTED]"));
    assert!(!message.contains("secret-provider-token"));

    let paths = GyroPaths::from_base_dir(data_base(&home));
    let store = SessionStore::open(paths).unwrap();
    let session = store.latest_session().unwrap().unwrap();
    let binding = store
        .get_provider_session_binding(session.id, "anthropic")
        .unwrap()
        .unwrap();
    assert_eq!(binding.status, "failed");
    assert_eq!(binding.resume_cursor_json["kind"], "claude-session");
}

#[test]
fn real_binary_setup_blocks_an_enabled_claude_provider_without_authentication() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let workspace = temp.path().join("workspace");
    let bin = temp.path().join("bin");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&bin).unwrap();
    let claude = bin.join("claude");
    fs::write(
        &claude,
        "#!/bin/sh\nprintf '%s\\n' '{\"loggedIn\":false,\"token\":\"secret-provider-token\"}'\nexit 1\n",
    )
    .unwrap();
    let mut permissions = fs::metadata(&claude).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&claude, permissions).unwrap();
    write_provider_config(&home, &claude, false, "anthropic");

    let output = gyro_command(&home, &workspace)
        .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
        .args(["setup", "--json"])
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    let provider = value["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|check| check["id"] == "provider:anthropic")
        .unwrap();
    assert_eq!(provider["status"], "blocked");
    assert_eq!(provider["next"], "run `claude auth login`");
    assert!(provider["message"].as_str().unwrap().contains("[REDACTED]"));
    assert!(!provider["message"]
        .as_str()
        .unwrap()
        .contains("secret-provider-token"));
}

#[test]
fn real_binary_does_not_launch_a_profile_with_a_disabled_provider() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let workspace = temp.path().join("workspace");
    let marker = temp.path().join("provider-started");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&workspace).unwrap();
    let provider = write_script(
        temp.path(),
        "printf started > \"$GYRO_TEST_MARKER\"\nexit 0",
    );
    let paths = GyroPaths::from_base_dir(data_base(&home));
    let config = GyroConfig {
        model_providers: vec![ModelProviderConfig {
            id: "anthropic".into(),
            display_name: "Anthropic".into(),
            base_url: None,
            api_key_ref: "provider:anthropic".into(),
            enabled: false,
        }],
        command_profiles: vec![CommandProfile {
            id: "test-provider".into(),
            display_name: "Test Provider".into(),
            command: provider.display().to_string(),
            args: Vec::new(),
            working_directory: None,
            provider_id: Some("anthropic".into()),
            default_model: None,
            readiness: CommandProfileReadiness::Ready,
        }],
        ..GyroConfig::default()
    };
    config.save(&paths).unwrap();

    let output = gyro_command(&home, &workspace)
        .env("GYRO_TEST_MARKER", &marker)
        .args([
            "run",
            "--profile",
            "test-provider",
            "--no-open",
            "--json",
            "inspect",
        ])
        .output()
        .unwrap();

    assert_failure(&output, 3, "provider-unavailable");
    let value: Value = serde_json::from_slice(&output.stderr).unwrap();
    let message = value["error"]["message"].as_str().unwrap();
    assert!(message.contains("provider `anthropic` is disabled"));
    assert!(message.contains("gyro config enable-provider anthropic"));
    assert!(message.contains("session saved: no"));
    assert!(!marker.exists());
    let store = SessionStore::open(paths).unwrap();
    assert!(store.latest_session().unwrap().is_none());
}

#[test]
fn real_binary_human_sessions_wrap_in_narrow_no_color_terminals() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let workspace = temp
        .path()
        .join("workspace-with-a-long-name-for-terminal-wrapping");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&workspace).unwrap();
    let paths = GyroPaths::from_base_dir(data_base(&home));
    let store = SessionStore::open(paths).unwrap();
    store
        .create_session(
            &workspace,
            SessionOrigin::Cli,
            "Résumé 🌍 terminal verification",
        )
        .unwrap();

    let output = gyro_command(&home, &workspace)
        .env("COLUMNS", "60")
        .env("NO_COLOR", "1")
        .args(["sessions"])
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    let normalized = stdout.split_whitespace().collect::<Vec<_>>().join(" ");
    assert!(normalized.contains("Résumé 🌍 terminal verification"));
    assert!(!stdout.contains("\u{1b}["));
    assert!(
        stdout.lines().all(|line| line.chars().count() <= 60),
        "narrow output exceeded 60 columns:\n{stdout}"
    );
}

#[test]
fn real_binary_chat_streams_versioned_json_through_a_non_tty_pipe() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let workspace = temp.path().join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&workspace).unwrap();
    let provider = write_script(
        temp.path(),
        r#"printf '%s\n' '{"type":"item.completed","session_id":"claude-pipe-session","item":{"type":"agent_message","text":"héllo 🌍"}}'"#,
    );
    write_provider_config(&home, &provider, false, "anthropic");

    let mut child = gyro_command(&home, &workspace)
        .args(["chat", "--profile", "test-provider", "--json"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all("inspect résumé 🌍\n/exit\n".as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    let events = stdout
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(events.len(), 3, "unexpected JSON stream:\n{stdout}");
    assert!(events.iter().all(|event| event["schema"] == "gyro.cli.v1"));
    assert_eq!(events[0]["event"], "chat-started");
    assert_eq!(events[1]["event"], "chat-turn");
    assert_eq!(events[1]["run"]["response"], "héllo 🌍");
    assert_eq!(events[2]["event"], "chat-closed");
}

#[test]
fn real_binary_read_commands_keep_the_v1_json_contract() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let workspace = temp.path().join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&workspace).unwrap();

    let sessions = assert_success_json(
        &gyro_command(&home, &workspace)
            .args(["sessions", "--json"])
            .output()
            .unwrap(),
    );
    assert_eq!(sessions["status"], "ready");
    assert!(sessions["sessions"].is_array());

    let setup = assert_success_json(
        &gyro_command(&home, &workspace)
            .args(["setup", "--json"])
            .output()
            .unwrap(),
    );
    assert!(setup["status"].is_string());
    assert!(setup["checks"].is_array());
    let setup_provider = setup["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|check| check["id"] == "model-provider")
        .unwrap();
    assert!(setup_provider["next"]
        .as_str()
        .unwrap()
        .contains("gyro config enable-provider openai"));

    let doctor = assert_success_json(
        &gyro_command(&home, &workspace)
            .env("SHELL", "/bin/zsh")
            .args(["doctor", "--json"])
            .output()
            .unwrap(),
    );
    let doctor_checks = doctor["checks"].as_array().unwrap();
    assert!(doctor_checks
        .iter()
        .all(|check| check["required"].is_boolean()));
    let optional_provider = doctor_checks
        .iter()
        .find(|check| check["id"] == "model-provider")
        .unwrap();
    assert_eq!(optional_provider["required"], false);
    assert!(optional_provider["next"]
        .as_str()
        .unwrap()
        .contains("gyro config enable-provider openai"));

    let config = assert_success_json(
        &gyro_command(&home, &workspace)
            .args(["config", "show", "--json"])
            .output()
            .unwrap(),
    );
    assert!(config["modelProviders"].is_array());
    assert!(config["commandProfiles"].is_array());

    let approvals = assert_success_json(
        &gyro_command(&home, &workspace)
            .args(["approvals", "--json"])
            .output()
            .unwrap(),
    );
    assert_eq!(approvals["status"], "done");
    assert!(approvals["approvals"].is_array());

    let completions = gyro_command(&home, &workspace)
        .args(["completions", "zsh"])
        .output()
        .unwrap();
    assert!(completions.status.success());
    assert!(String::from_utf8_lossy(&completions.stdout).contains("_gyro"));
}

#[test]
fn real_binary_compatible_app_handoff_keeps_the_v1_json_contract() {
    let root = PathBuf::from("/tmp").join(format!("gyro-ipc-ok-{}", uuid::Uuid::new_v4()));
    let home = root.join("home");
    let workspace = root.join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&workspace).unwrap();
    let paths = GyroPaths::from_base_dir(data_base(&home));
    let store = SessionStore::open(paths.clone()).unwrap();
    let session = store
        .create_session(&workspace, SessionOrigin::Cli, "handoff contract")
        .unwrap();
    let listener = UnixListener::bind(&paths.socket_path).unwrap();
    let server = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut request = String::new();
        BufReader::new(stream.try_clone().unwrap())
            .read_line(&mut request)
            .unwrap();
        let request: Value = serde_json::from_str(&request).unwrap();
        assert_eq!(request["schema"], "gyro.app-ipc.v1");
        assert_eq!(request["kind"], "open-session");
        let acknowledgement = serde_json::json!({
            "schema": "gyro.app-ipc.v1",
            "status": "ok",
            "appVersion": env!("CARGO_PKG_VERSION"),
            "compatible": true,
            "message": "Gyro.app accepted the session handoff.",
        });
        let mut stream = stream;
        serde_json::to_writer(&mut stream, &acknowledgement).unwrap();
        stream.write_all(b"\n").unwrap();
        stream.flush().unwrap();
    });

    let output = gyro_command(&home, &workspace)
        .args(["app", "open", &session.id.to_string(), "--json"])
        .output()
        .unwrap();
    server.join().unwrap();
    let value = assert_success_json(&output);

    assert_eq!(value["status"], "done");
    assert_eq!(value["action"], "open");
    assert_eq!(value["session"]["sessionId"], session.id.to_string());
    assert_eq!(value["appHandoff"]["compatible"], true);
    assert_eq!(value["appHandoff"]["appVersion"], env!("CARGO_PKG_VERSION"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn real_binary_maps_ctrl_c_to_cancelled_exit_code() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let workspace = temp.path().join("workspace");
    let marker = temp.path().join("provider-started");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&workspace).unwrap();
    let script = write_script(
        temp.path(),
        "printf started > \"$GYRO_TEST_MARKER\"\nsleep 30",
    );
    write_config(&home, &script, false);

    let child = gyro_command(&home, &workspace)
        .env("GYRO_TEST_MARKER", &marker)
        .args([
            "run",
            "--profile",
            "test-provider",
            "--no-open",
            "--json",
            "inspect",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(5);
    while !marker.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    assert!(
        marker.exists(),
        "provider did not start before cancellation"
    );
    unsafe {
        libc::kill(child.id() as i32, libc::SIGINT);
    }
    let output = child.wait_with_output().unwrap();
    assert_failure(&output, 130, "cancelled");
}

#[test]
fn real_tty_ctrl_c_cancels_an_action_approval_before_the_action_runs() {
    let root = PathBuf::from("/tmp").join(format!("gyro-approval-{}", uuid::Uuid::new_v4()));
    let home = root.join("home");
    let workspace = root.join("workspace");
    let marker = root.join("provider-action-ran");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&workspace).unwrap();
    let script = write_script(
        &root,
        r#"IFS= read -r initialize
printf '%s\n' '{"id":1,"result":{}}'
IFS= read -r initialized
IFS= read -r thread
printf '%s\n' '{"id":2,"result":{"thread":{"id":"thread-test"}}}'
IFS= read -r turn
printf '%s\n' '{"id":3,"result":{}}'
printf '%s\n' '{"id":41,"method":"item/commandExecution/requestApproval","params":{"command":"printf started","cwd":"/tmp","reason":"integration test"}}'
IFS= read -r decision
case "$decision" in *'"decision":"accept"'*) printf started > "$GYRO_TEST_MARKER" ;; esac
exit 0"#,
    );
    write_config(&home, &script, true);

    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut command = CommandBuilder::new(env!("CARGO_BIN_EXE_gyro"));
    command.args(["run", "--profile", "test-provider", "--no-open", "inspect"]);
    command.cwd(&workspace);
    command.env("HOME", &home);
    command.env("XDG_DATA_HOME", home.join("data"));
    command.env("XDG_CONFIG_HOME", home.join("config"));
    command.env("GYRO_TEST_MARKER", &marker);
    let mut child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut writer = pair.master.take_writer().unwrap();
    let (output_sender, output_receiver) = mpsc::channel();
    let reader_thread = thread::spawn(move || {
        let mut buffer = [0u8; 1024];
        loop {
            match std::io::Read::read(&mut reader, &mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    if output_sender.send(buffer[..count].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let deadline = Instant::now() + Duration::from_secs(5);
    let mut terminal_output = String::new();
    while !terminal_output.contains("Approve this action?") && Instant::now() < deadline {
        if let Ok(chunk) = output_receiver.recv_timeout(Duration::from_millis(50)) {
            terminal_output.push_str(&String::from_utf8_lossy(&chunk));
        }
    }
    assert!(
        terminal_output.contains("Approve this action?"),
        "approval prompt was not shown: {terminal_output}"
    );
    writer.write_all(&[3]).unwrap();
    writer.flush().unwrap();

    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            panic!("CLI did not exit after Ctrl-C during action approval");
        }
        thread::sleep(Duration::from_millis(20));
    };
    drop(writer);
    drop(pair.master);
    reader_thread.join().unwrap();

    assert_eq!(
        status.exit_code(),
        130,
        "terminal output: {terminal_output}"
    );
    assert!(
        !marker.exists(),
        "provider action ran after approval cancellation"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn real_permission_bridge_routes_claude_commands_and_file_edits() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let workspace = temp.path().join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&workspace).unwrap();
    let paths = GyroPaths::from_base_dir(data_base(&home));
    let store = SessionStore::open(paths).unwrap();
    let session = store
        .create_session(&workspace, SessionOrigin::Cli, "Claude approval bridge")
        .unwrap();
    let turn_id = uuid::Uuid::new_v4();

    let mut child = gyro_command(&home, &workspace)
        .args(["provider-permission-server"])
        .env("GYRO_PERMISSION_SESSION_ID", session.id.to_string())
        .env("GYRO_PERMISSION_TURN_ID", turn_id.to_string())
        .env("GYRO_PERMISSION_PROFILE_ID", "claude-code")
        .env("GYRO_PERMISSION_PROVIDER_ID", "anthropic")
        .env("GYRO_PERMISSION_REQUIRE_COMMAND", "true")
        .env("GYRO_PERMISSION_REQUIRE_FILE", "true")
        .env("GYRO_PERMISSION_AUTO_APPROVE", "true")
        .env("GYRO_PERMISSION_JSON", "true")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    writeln!(
        stdin,
        "{}",
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": { "protocolVersion": "2024-11-05" },
        })
    )
    .unwrap();
    writeln!(
        stdin,
        "{}",
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "approve",
                "arguments": {
                    "tool_name": "Bash",
                    "input": { "command": "printf safe" },
                },
            },
        })
    )
    .unwrap();
    writeln!(
        stdin,
        "{}",
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "approve",
                "arguments": {
                    "tool_name": "Write",
                    "input": {
                        "file_path": workspace.join("created-by-claude.txt"),
                        "content": "created atomically\n",
                    },
                },
            },
        })
    )
    .unwrap();
    drop(stdin);

    let mut initialize = String::new();
    stdout.read_line(&mut initialize).unwrap();
    let mut approval = String::new();
    stdout.read_line(&mut approval).unwrap();
    let approval: Value = serde_json::from_str(&approval).unwrap();
    let permission: Value =
        serde_json::from_str(approval["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(permission["behavior"], "allow");
    let mut file_approval = String::new();
    stdout.read_line(&mut file_approval).unwrap();
    let file_approval: Value = serde_json::from_str(&file_approval).unwrap();
    let file_permission: Value = serde_json::from_str(
        file_approval["result"]["content"][0]["text"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(file_permission["behavior"], "deny");
    assert!(child.wait().unwrap().success());
    assert_eq!(
        fs::read_to_string(workspace.join("created-by-claude.txt")).unwrap(),
        "created atomically\n"
    );

    let events = store.read_events(session.id).unwrap();
    assert!(events.iter().any(|event| {
        event.kind == gyro_core::SessionEventKind::ApprovalRequested
            && event.payload["providerId"] == "anthropic"
            && event.payload["approvalType"] == "command"
    }));
    assert!(events
        .iter()
        .any(|event| event.payload["status"] == "approved"));
    assert!(events.iter().any(|event| {
        event.payload["approvalType"] == "file-change"
            && event.payload["status"] == "applied"
            && event.payload["changedPaths"][0] == "created-by-claude.txt"
    }));
}

#[test]
fn real_binary_lists_reviews_approves_and_rejects_file_mutations() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let workspace = temp.path().join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&workspace).unwrap();
    let paths = GyroPaths::from_base_dir(data_base(&home));
    let store = SessionStore::open(paths).unwrap();
    let session = store
        .create_session(&workspace, SessionOrigin::Cli, "approval test")
        .unwrap();
    let approved = store
        .create_mutation_proposal(
            session.id,
            None,
            "approved.txt",
            "reviewed content\n",
            None,
            false,
        )
        .unwrap();
    let rejected = store
        .create_mutation_proposal(
            session.id,
            None,
            "rejected.txt",
            "do not write\n",
            None,
            false,
        )
        .unwrap();

    let inbox = gyro_command(&home, &workspace)
        .args(["approvals", "--json"])
        .output()
        .unwrap();
    assert!(
        inbox.status.success(),
        "{}",
        String::from_utf8_lossy(&inbox.stderr)
    );
    let inbox_value: Value = serde_json::from_slice(&inbox.stdout).unwrap();
    assert_eq!(inbox_value["schema"], "gyro.cli.v1");
    assert_eq!(inbox_value["status"], "waiting");
    assert_eq!(inbox_value["count"], 2);
    assert!(!String::from_utf8_lossy(&inbox.stdout).contains("reviewed content"));

    let review = gyro_command(&home, &workspace)
        .args(["approvals", "show", &approved.id.to_string(), "--json"])
        .output()
        .unwrap();
    assert!(review.status.success());
    let review_value: Value = serde_json::from_slice(&review.stdout).unwrap();
    assert_eq!(
        review_value["approval"]["proposalId"],
        approved.id.to_string()
    );
    assert!(review_value["diffPreview"]
        .as_str()
        .unwrap()
        .contains("+reviewed content"));

    let approve = gyro_command(&home, &workspace)
        .args(["approvals", "approve", &approved.id.to_string(), "--json"])
        .output()
        .unwrap();
    assert!(
        approve.status.success(),
        "{}",
        String::from_utf8_lossy(&approve.stderr)
    );
    let approve_value: Value = serde_json::from_slice(&approve.stdout).unwrap();
    assert_eq!(approve_value["status"], "done");
    assert_eq!(approve_value["decision"], "approve");
    assert_eq!(
        fs::read_to_string(workspace.join("approved.txt")).unwrap(),
        "reviewed content\n"
    );

    let reject = gyro_command(&home, &workspace)
        .args(["approvals", "reject", &rejected.id.to_string(), "--json"])
        .output()
        .unwrap();
    assert!(reject.status.success());
    let reject_value: Value = serde_json::from_slice(&reject.stdout).unwrap();
    assert_eq!(reject_value["decision"], "reject");
    assert!(!workspace.join("rejected.txt").exists());

    let missing = gyro_command(&home, &workspace)
        .args([
            "approvals",
            "show",
            &uuid::Uuid::new_v4().to_string(),
            "--json",
        ])
        .output()
        .unwrap();
    assert_failure(&missing, 2, "invalid-input");
}

#[test]
fn real_binary_setup_and_handoff_recover_stale_app_sockets() {
    let root = PathBuf::from("/tmp").join(format!("gyro-stale-{}", uuid::Uuid::new_v4()));
    let home = root.join("home");
    let workspace = root.join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&workspace).unwrap();
    let paths = GyroPaths::from_base_dir(data_base(&home));
    paths.ensure().unwrap();

    let listener = UnixListener::bind(&paths.socket_path).unwrap();
    drop(listener);
    let setup = gyro_command(&home, &workspace)
        .args(["setup", "--json"])
        .output()
        .unwrap();
    assert!(
        setup.status.success(),
        "{}",
        String::from_utf8_lossy(&setup.stderr)
    );
    let setup_value: Value = serde_json::from_slice(&setup.stdout).unwrap();
    let app_check = setup_value["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|check| check["id"] == "app-ipc")
        .unwrap();
    assert_eq!(app_check["status"], "waiting");
    assert!(app_check["message"]
        .as_str()
        .unwrap()
        .contains("not running"));
    assert!(!paths.socket_path.exists());

    let provider = write_script(
        &root,
        r#"test "$1" = "app-server" || exit 21
test "$2" = "--stdio" || exit 22
IFS= read -r initialize
printf '%s\n' '{"id":1,"result":{}}'
IFS= read -r initialized
IFS= read -r thread
printf '%s\n' '{"id":2,"result":{"thread":{"id":"thread-stale-socket"}}}'
IFS= read -r turn
printf '%s\n' '{"id":3,"result":{"turn":{"id":"turn-stale-socket"}}}'
printf '%s\n' '{"method":"item/agentMessage/delta","params":{"delta":"done"}}'
printf '%s\n' '{"method":"item/completed","params":{"item":{"type":"agentMessage","text":"done"}}}'
printf '%s\n' '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}'"#,
    );
    write_config(&home, &provider, false);
    let listener = UnixListener::bind(&paths.socket_path).unwrap();
    drop(listener);

    let run = gyro_command(&home, &workspace)
        .args(["run", "--profile", "test-provider", "--json", "inspect"])
        .output()
        .unwrap();

    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let run_value: Value = serde_json::from_slice(&run.stdout).unwrap();
    assert_eq!(run_value["status"], "done");
    assert_eq!(run_value["appHandoff"]["opened"], false);
    assert!(run_value["appHandoff"]["message"]
        .as_str()
        .unwrap()
        .contains("not running"));
    assert!(!paths.socket_path.exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn real_binary_requires_explicit_retry_after_a_stale_codex_resume() {
    let root = PathBuf::from("/tmp").join(format!("gyro-codex-resume-{}", uuid::Uuid::new_v4()));
    let home = root.join("home");
    let workspace = root.join("workspace");
    let attempts = root.join("attempts.txt");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&workspace).unwrap();
    let provider = write_script(
        &root,
        r#"IFS= read -r initialize
printf '%s\n' '{"id":1,"result":{}}'
IFS= read -r initialized
IFS= read -r thread
case "$thread" in
  *'"method":"thread/resume"'*)
    printf 'resume\n' >> "$GYRO_TEST_MARKER"
    printf '%s\n' '{"id":2,"error":{"message":"thread not found"}}'
    exit 0
    ;;
esac
printf 'start\n' >> "$GYRO_TEST_MARKER"
printf '%s\n' '{"id":2,"result":{"thread":{"id":"thread-recovered"}}}'
IFS= read -r turn
printf '%s\n' '{"id":3,"result":{"turn":{"id":"turn-recovered"}}}'
printf '%s\n' '{"method":"item/agentMessage/delta","params":{"delta":"recovered"}}'
printf '%s\n' '{"method":"item/completed","params":{"item":{"type":"agentMessage","text":"recovered"}}}'
printf '%s\n' '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}'"#,
    );
    write_config(&home, &provider, false);
    let paths = GyroPaths::from_base_dir(data_base(&home));
    let store = SessionStore::open(paths.clone()).unwrap();
    let session = store
        .create_session(&workspace, SessionOrigin::Cli, "stale Codex resume")
        .unwrap();
    store
        .upsert_provider_session_binding(
            session.id,
            "openai",
            None,
            None,
            None,
            serde_json::json!({"kind": "codex-session", "sessionId": "thread-stale"}),
            "ready",
            None,
        )
        .unwrap();

    let stale_resume = gyro_command(&home, &workspace)
        .env("GYRO_TEST_MARKER", &attempts)
        .args([
            "resume",
            &session.id.to_string(),
            "--profile",
            "test-provider",
            "--message",
            "continue",
            "--no-open",
            "--json",
        ])
        .output()
        .unwrap();

    assert_failure(&stale_resume, 5, "execution-failed");
    let failure: Value = serde_json::from_slice(&stale_resume.stderr).unwrap();
    assert!(failure["error"]["message"]
        .as_str()
        .unwrap()
        .contains("retry explicitly"));
    assert_eq!(fs::read_to_string(&attempts).unwrap(), "resume\n");
    let reopened = SessionStore::open(paths.clone()).unwrap();
    assert!(reopened
        .get_provider_session_binding(session.id, "openai")
        .unwrap()
        .is_none());

    let explicit_retry = gyro_command(&home, &workspace)
        .env("GYRO_TEST_MARKER", &attempts)
        .args([
            "resume",
            &session.id.to_string(),
            "--profile",
            "test-provider",
            "--message",
            "continue",
            "--no-open",
            "--json",
        ])
        .output()
        .unwrap();

    assert!(
        explicit_retry.status.success(),
        "{}",
        String::from_utf8_lossy(&explicit_retry.stderr)
    );
    let value: Value = serde_json::from_slice(&explicit_retry.stdout).unwrap();
    assert_eq!(value["status"], "done");
    assert_eq!(value["run"]["resumed"], false);
    assert_eq!(value["run"]["response"], "recovered");
    assert_eq!(fs::read_to_string(&attempts).unwrap(), "resume\nstart\n");
    let reopened = SessionStore::open(paths).unwrap();
    let binding = reopened
        .get_provider_session_binding(session.id, "openai")
        .unwrap()
        .unwrap();
    assert_eq!(binding.resume_cursor_json["sessionId"], "thread-recovered");
    assert_eq!(binding.status, "ready");
    assert!(reopened
        .read_events(session.id)
        .unwrap()
        .iter()
        .any(|event| {
            event
                .message
                .contains("Stale provider resume cursor cleared")
        }));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn real_binary_resumes_a_codex_thread_after_the_provider_crashes() {
    let root = PathBuf::from("/tmp").join(format!("gyro-codex-crash-{}", uuid::Uuid::new_v4()));
    let home = root.join("home");
    let workspace = root.join("workspace");
    let attempts = root.join("attempts.txt");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&workspace).unwrap();
    let provider = write_script(
        &root,
        r#"IFS= read -r initialize
printf '%s\n' '{"id":1,"result":{}}'
IFS= read -r initialized
IFS= read -r thread
case "$thread" in
  *'"method":"thread/resume"'*)
    printf 'resume\n' >> "$GYRO_TEST_MARKER"
    case "$thread" in *'"threadId":"thread-before-crash"'*) ;; *) exit 23 ;; esac
    printf '%s\n' '{"id":2,"result":{"thread":{"id":"thread-before-crash"}}}'
    IFS= read -r turn
    printf '%s\n' '{"id":3,"result":{"turn":{"id":"turn-after-crash"}}}'
    printf '%s\n' '{"method":"item/agentMessage/delta","params":{"delta":"resumed"}}'
    printf '%s\n' '{"method":"item/completed","params":{"item":{"type":"agentMessage","text":"resumed"}}}'
    printf '%s\n' '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}'
    exit 0
    ;;
esac
printf 'start\n' >> "$GYRO_TEST_MARKER"
printf '%s\n' '{"id":2,"result":{"thread":{"id":"thread-before-crash"}}}'
IFS= read -r turn
exit 9"#,
    );
    write_config(&home, &provider, false);

    let first = gyro_command(&home, &workspace)
        .env("GYRO_TEST_MARKER", &attempts)
        .args([
            "run",
            "--profile",
            "test-provider",
            "--no-open",
            "--json",
            "start",
        ])
        .output()
        .unwrap();
    assert_failure(&first, 5, "execution-failed");

    let paths = GyroPaths::from_base_dir(data_base(&home));
    let store = SessionStore::open(paths.clone()).unwrap();
    let session = store.latest_session().unwrap().unwrap();
    let failed_binding = store
        .get_provider_session_binding(session.id, "openai")
        .unwrap()
        .unwrap();
    assert_eq!(
        failed_binding.resume_cursor_json["sessionId"],
        "thread-before-crash"
    );
    assert_eq!(failed_binding.status, "failed");
    assert!(failed_binding.last_error.is_some());

    let resumed = gyro_command(&home, &workspace)
        .env("GYRO_TEST_MARKER", &attempts)
        .args([
            "resume",
            &session.id.to_string(),
            "--profile",
            "test-provider",
            "--message",
            "continue",
            "--no-open",
            "--json",
        ])
        .output()
        .unwrap();

    assert!(
        resumed.status.success(),
        "{}",
        String::from_utf8_lossy(&resumed.stderr)
    );
    let value: Value = serde_json::from_slice(&resumed.stdout).unwrap();
    assert_eq!(value["status"], "done");
    assert_eq!(value["run"]["resumed"], true);
    assert_eq!(value["run"]["response"], "resumed");
    assert_eq!(fs::read_to_string(&attempts).unwrap(), "start\nresume\n");
    let reopened = SessionStore::open(paths).unwrap();
    let ready_binding = reopened
        .get_provider_session_binding(session.id, "openai")
        .unwrap()
        .unwrap();
    assert_eq!(ready_binding.status, "ready");
    assert!(ready_binding.last_error.is_none());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn real_binary_requires_explicit_retry_after_a_stale_claude_resume() {
    let root = PathBuf::from("/tmp").join(format!("gyro-claude-resume-{}", uuid::Uuid::new_v4()));
    let home = root.join("home");
    let workspace = root.join("workspace");
    let attempts = root.join("attempts.txt");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&workspace).unwrap();
    let provider = write_script(
        &root,
        r#"case " $* " in
  *' --resume claude-stale '*)
    printf 'resume\n' >> "$GYRO_TEST_MARKER"
    printf '%s\n' 'Could not resume session: not found' >&2
    exit 1
    ;;
esac
printf 'start\n' >> "$GYRO_TEST_MARKER"
printf '%s\n' '{"type":"item.completed","session_id":"claude-recovered","item":{"type":"agent_message","text":"recovered"}}'"#,
    );
    write_provider_config(&home, &provider, false, "anthropic");
    let paths = GyroPaths::from_base_dir(data_base(&home));
    let store = SessionStore::open(paths.clone()).unwrap();
    let session = store
        .create_session(&workspace, SessionOrigin::Cli, "stale Claude resume")
        .unwrap();
    store
        .upsert_provider_session_binding(
            session.id,
            "anthropic",
            None,
            None,
            None,
            serde_json::json!({"kind": "claude-session", "sessionId": "claude-stale"}),
            "ready",
            None,
        )
        .unwrap();

    let stale_resume = gyro_command(&home, &workspace)
        .env("GYRO_TEST_MARKER", &attempts)
        .args([
            "resume",
            &session.id.to_string(),
            "--profile",
            "test-provider",
            "--message",
            "continue",
            "--no-open",
            "--json",
        ])
        .output()
        .unwrap();

    assert_failure(&stale_resume, 5, "execution-failed");
    let failure: Value = serde_json::from_slice(&stale_resume.stderr).unwrap();
    assert!(failure["error"]["message"]
        .as_str()
        .unwrap()
        .contains("retry explicitly"));
    assert_eq!(fs::read_to_string(&attempts).unwrap(), "resume\n");
    let reopened = SessionStore::open(paths.clone()).unwrap();
    assert!(reopened
        .get_provider_session_binding(session.id, "anthropic")
        .unwrap()
        .is_none());

    let explicit_retry = gyro_command(&home, &workspace)
        .env("GYRO_TEST_MARKER", &attempts)
        .args([
            "resume",
            &session.id.to_string(),
            "--profile",
            "test-provider",
            "--message",
            "continue",
            "--no-open",
            "--json",
        ])
        .output()
        .unwrap();

    assert!(
        explicit_retry.status.success(),
        "{}",
        String::from_utf8_lossy(&explicit_retry.stderr)
    );
    let value: Value = serde_json::from_slice(&explicit_retry.stdout).unwrap();
    assert_eq!(value["status"], "done");
    assert_eq!(value["run"]["resumed"], false);
    assert_eq!(value["run"]["response"], "recovered");
    assert_eq!(fs::read_to_string(&attempts).unwrap(), "resume\nstart\n");
    let reopened = SessionStore::open(paths).unwrap();
    let binding = reopened
        .get_provider_session_binding(session.id, "anthropic")
        .unwrap()
        .unwrap();
    assert_eq!(binding.resume_cursor_json["sessionId"], "claude-recovered");
    assert_eq!(binding.status, "ready");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn real_binary_resumes_a_claude_session_after_the_provider_crashes() {
    let root = PathBuf::from("/tmp").join(format!("gyro-claude-crash-{}", uuid::Uuid::new_v4()));
    let home = root.join("home");
    let workspace = root.join("workspace");
    let session_marker = root.join("provider-session.txt");
    let attempts = root.join("attempts.txt");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&workspace).unwrap();
    let provider = write_script(
        &root,
        r#"previous=''
provider_session=''
for argument in "$@"; do
  if test "$previous" = '--session-id'; then provider_session="$argument"; fi
  previous="$argument"
done
case " $* " in
  *' --resume '*)
    printf 'resume\n' >> "$GYRO_TEST_MARKER"
    provider_session=$(cat "$GYRO_TEST_SESSION_MARKER")
    case " $* " in *" --resume $provider_session "*) ;; *) exit 24 ;; esac
    printf '{"type":"item.completed","session_id":"%s","item":{"type":"agent_message","text":"resumed"}}\n' "$provider_session"
    exit 0
    ;;
esac
printf 'start\n' >> "$GYRO_TEST_MARKER"
printf '%s' "$provider_session" > "$GYRO_TEST_SESSION_MARKER"
exit 9"#,
    );
    write_provider_config(&home, &provider, false, "anthropic");

    let first = gyro_command(&home, &workspace)
        .env("GYRO_TEST_MARKER", &attempts)
        .env("GYRO_TEST_SESSION_MARKER", &session_marker)
        .args([
            "run",
            "--profile",
            "test-provider",
            "--no-open",
            "--json",
            "start",
        ])
        .output()
        .unwrap();
    assert_failure(&first, 5, "execution-failed");

    let paths = GyroPaths::from_base_dir(data_base(&home));
    let store = SessionStore::open(paths.clone()).unwrap();
    let session = store.latest_session().unwrap().unwrap();
    let expected_provider_session = fs::read_to_string(&session_marker).unwrap();
    assert!(!expected_provider_session.is_empty());
    let failed_binding = store
        .get_provider_session_binding(session.id, "anthropic")
        .unwrap()
        .unwrap();
    assert_eq!(
        failed_binding.resume_cursor_json["sessionId"],
        expected_provider_session
    );
    assert_eq!(failed_binding.status, "failed");

    let resumed = gyro_command(&home, &workspace)
        .env("GYRO_TEST_MARKER", &attempts)
        .env("GYRO_TEST_SESSION_MARKER", &session_marker)
        .args([
            "resume",
            &session.id.to_string(),
            "--profile",
            "test-provider",
            "--message",
            "continue",
            "--no-open",
            "--json",
        ])
        .output()
        .unwrap();

    assert!(
        resumed.status.success(),
        "{}",
        String::from_utf8_lossy(&resumed.stderr)
    );
    let value: Value = serde_json::from_slice(&resumed.stdout).unwrap();
    assert_eq!(value["status"], "done");
    assert_eq!(value["run"]["resumed"], true);
    assert_eq!(value["run"]["response"], "resumed");
    assert_eq!(fs::read_to_string(&attempts).unwrap(), "start\nresume\n");
    let reopened = SessionStore::open(paths).unwrap();
    let ready_binding = reopened
        .get_provider_session_binding(session.id, "anthropic")
        .unwrap()
        .unwrap();
    assert_eq!(ready_binding.status, "ready");
    assert!(ready_binding.last_error.is_none());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn real_binary_fails_closed_on_incompatible_running_app() {
    let root = PathBuf::from("/tmp").join(format!("gyro-ipc-{}", uuid::Uuid::new_v4()));
    let home = root.join("home");
    let workspace = root.join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&workspace).unwrap();
    let paths = GyroPaths::from_base_dir(data_base(&home));
    let store = SessionStore::open(paths.clone()).unwrap();
    let session = store
        .create_session(&workspace, SessionOrigin::Cli, "handoff test")
        .unwrap();
    let listener = UnixListener::bind(&paths.socket_path).unwrap();
    let server = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut request = String::new();
        BufReader::new(stream.try_clone().unwrap())
            .read_line(&mut request)
            .unwrap();
        let request: Value = serde_json::from_str(&request).unwrap();
        assert_eq!(request["schema"], "gyro.app-ipc.v1");
        assert_eq!(request["senderVersion"], env!("CARGO_PKG_VERSION"));
        let acknowledgement = serde_json::json!({
            "schema": "gyro.app-ipc.v1",
            "status": "incompatible",
            "appVersion": "0.2.0",
            "compatible": false,
            "message": format!(
                "Gyro CLI {} is not compatible with Gyro.app 0.2.0; update both from the same release channel",
                env!("CARGO_PKG_VERSION")
            ),
        });
        let mut stream = stream;
        serde_json::to_writer(&mut stream, &acknowledgement).unwrap();
        stream.write_all(b"\n").unwrap();
        stream.flush().unwrap();
    });

    let output = gyro_command(&home, &workspace)
        .args(["app", "open", &session.id.to_string(), "--json"])
        .output()
        .unwrap();
    server.join().unwrap();

    assert_failure(&output, 5, "execution-failed");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains(env!("CARGO_PKG_VERSION")));
    assert!(stderr.contains("0.2.0"));
    assert!(stderr.contains("same release channel"));
    let _ = fs::remove_dir_all(root);
}
