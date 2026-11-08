use super::*;

#[test]
fn dap_json_rpc_framing_round_trips() {
    let value = serde_json::json!({
        "seq": 4,
        "type": "request",
        "command": "threads",
        "arguments": {}
    });
    let mut framed = Vec::new();
    language_server::write_lsp_message(&mut framed, &value).unwrap();

    let decoded =
        language_server::read_lsp_message(&mut BufReader::new(framed.as_slice())).unwrap();

    assert_eq!(decoded, value);
}

#[test]
fn debug_adapter_manager_runs_request_lifecycle() {
    if command_with_gui_path("python3")
        .arg("--version")
        .output()
        .map(|output| !output.status.success())
        .unwrap_or(true)
    {
        return;
    }
    let workspace = tempfile::tempdir().unwrap();
    let adapter_path = workspace.path().join("fake_adapter.py");
    std::fs::write(
            &adapter_path,
            r#"import json, sys

def read_message():
    length = None
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return None
        if line in (b'\r\n', b'\n'):
            break
        if line.lower().startswith(b'content-length:'):
            length = int(line.split(b':', 1)[1].strip())
    return json.loads(sys.stdin.buffer.read(length))

def send(message):
    body = json.dumps(message).encode()
    sys.stdout.buffer.write(f'Content-Length: {len(body)}\r\n\r\n'.encode() + body)
    sys.stdout.buffer.flush()

while True:
    message = read_message()
    if message is None:
        break
    command = message.get('command', '')
    for index in range(40 if command == 'launch' else 0):
        send({'seq': 1000 + index, 'type': 'event', 'event': 'output', 'body': {'output': f'line {index}\n'}})
    if command == 'disconnect':
        with open(__file__ + '.disconnect.json', 'w') as record:
            json.dump(message.get('arguments'), record)
    body = {'supportsConfigurationDoneRequest': True} if command == 'initialize' else {'threads': [{'id': 1, 'name': 'main'}]}
    send({'seq': message['seq'] + 100, 'type': 'response', 'request_seq': message['seq'], 'command': command, 'success': True, 'body': body})
    if command == 'disconnect':
        break
"#,
        )
        .unwrap();
    let manager = DebugAdapterManager::default();
    let session = manager
        .start(DebugStartRequest {
            workspace_path: Some(workspace.path().to_string_lossy().to_string()),
            name: "Fake debug".into(),
            adapter: "fake".into(),
            command: Some(format!("python3 {}", adapter_path.display())),
            args: None,
        })
        .unwrap();

    assert_eq!(session.status, "configured");
    assert!(session
        .capabilities
        .contains(&"supportsConfigurationDoneRequest".to_string()));
    let response = manager
        .send(DebugSendRequest {
            session_id: session.id.clone(),
            request: serde_json::json!({ "command": "threads" }),
        })
        .unwrap();
    assert_eq!(response["response"]["body"]["threads"][0]["name"], "main");
    // More program output than the 32-message cap arrives before `launch`
    // responds; the request still succeeds with every event.
    let launch = manager
        .send(DebugSendRequest {
            session_id: session.id.clone(),
            request: serde_json::json!({ "command": "launch" }),
        })
        .unwrap();
    assert_eq!(launch["status"], "ok");
    assert_eq!(launch["events"].as_array().unwrap().len(), 40);
    assert_eq!(manager.stop(&session.id).unwrap()["status"], "stopped");
    let disconnect =
        std::fs::read_to_string(format!("{}.disconnect.json", adapter_path.display())).unwrap();
    let disconnect: serde_json::Value = serde_json::from_str(&disconnect).unwrap();
    assert_eq!(disconnect["terminateDebuggee"], true);
}

#[test]
fn debug_adapter_payloads_redact_secrets_recursively() {
    let value = redact_json_strings(serde_json::json!({
        "output": "Authorization: Bearer super-secret-value",
        "nested": ["OPENAI_API_KEY=sk-test-secret"]
    }));

    assert!(!value.to_string().contains("super-secret-value"));
    assert!(!value.to_string().contains("sk-test-secret"));
}

#[test]
fn desktop_pnpm_tasks_run_without_an_interactive_prompt() {
    let mut pnpm = command_with_gui_path("pnpm");
    configure_noninteractive_task_environment(&mut pnpm, "pnpm");
    let ci = pnpm
        .get_envs()
        .find(|(key, _)| *key == std::ffi::OsStr::new("CI"))
        .and_then(|(_, value)| value)
        .map(|value| value.to_string_lossy().to_string());
    assert_eq!(ci.as_deref(), Some("1"));

    let mut npm = command_with_gui_path("npm");
    configure_noninteractive_task_environment(&mut npm, "npm");
    assert!(npm
        .get_envs()
        .all(|(key, _)| key != std::ffi::OsStr::new("CI")));
}

#[test]
fn desktop_task_runner_passes_ci_to_a_real_pnpm_script() {
    if command_with_gui_path("pnpm")
        .arg("--version")
        .output()
        .is_err()
    {
        return;
    }

    let workspace = tempfile::tempdir().unwrap();
    std::fs::write(
        workspace.path().join("package.json"),
        r#"{"packageManager":"pnpm@11.7.0","scripts":{"verify-ci":"node -e \"process.exit(process.env.CI === '1' ? 0 : 1)\""}}"#,
    )
    .unwrap();
    // This asks discovery for pnpm without requiring any dependency install.
    std::fs::write(
        workspace.path().join("pnpm-lock.yaml"),
        "lockfileVersion: '9.0'\n",
    )
    .unwrap();

    let output = task_run_blocking(TaskRunRequest {
        workspace_path: workspace.path().display().to_string(),
        task_id: "package:verify-ci".into(),
        command: "pnpm".into(),
        args: vec!["run".into(), "verify-ci".into()],
    })
    .unwrap();

    assert_eq!(output.status, "done", "{}{}", output.stdout, output.stderr);
}

#[test]
fn makefile_and_justfile_targets_skip_variables_and_patterns() {
    let targets = makefile_targets(
            "CARGO := cargo\n.PHONY: build\nbuild: deps\n\tcargo build\n%.o: %.c\n\tcc $<\ntest lint:\n\techo hi\n",
        );
    assert_eq!(targets, vec!["build", "test", "lint"]);

    let recipes = justfile_recipes(
            "set shell := [\"bash\"]\nversion := \"1\"\nbuild:\n  cargo build\ntest filter='':\n  cargo test\n",
        );
    assert_eq!(recipes, vec!["build", "test"]);
}

#[test]
fn suggested_tasks_cover_common_project_manifests() {
    let workspace = tempfile::tempdir().unwrap();
    std::fs::write(
        workspace.path().join("Cargo.toml"),
        "[package]\nname=\"a\"\n",
    )
    .unwrap();
    std::fs::write(workspace.path().join("Makefile"), "ship:\n\techo ship\n").unwrap();
    std::fs::write(workspace.path().join("go.mod"), "module example.com/a\n").unwrap();

    let tasks = task_discover_impl(&workspace.path().display().to_string()).unwrap();
    let ids: Vec<&str> = tasks.iter().map(|task| task.id.as_str()).collect();
    assert!(ids.contains(&"cargo:test"));
    assert!(ids.contains(&"cargo:check"));
    assert!(!ids.contains(&"cargo:clippy"));
    assert!(ids.contains(&"make:ship"));
    assert!(ids.contains(&"go:test"));
    assert!(tasks.iter().all(|task| task.source == "suggested"));
    let cargo_check = tasks.iter().find(|task| task.id == "cargo:check").unwrap();
    assert_eq!(cargo_check.group, "check");
    assert_eq!(cargo_check.toolchain, "cargo");
    assert_eq!(cargo_check.role, "primary");
}

#[test]
fn test_catalog_is_derived_from_the_discovered_task_catalog() {
    let tasks = vec![
        TaskDefinitionResult {
            id: "package:test".into(),
            label: "pnpm test".into(),
            command: "pnpm".into(),
            args: vec!["run".into(), "test".into()],
            group: "test".into(),
            cwd: None,
            status: "idle".into(),
            output_channel_id: None,
            source: "suggested".into(),
            toolchain: "node".into(),
            package_path: None,
            role: "primary".into(),
        },
        TaskDefinitionResult {
            id: "package:build".into(),
            label: "pnpm build".into(),
            command: "pnpm".into(),
            args: vec!["run".into(), "build".into()],
            group: "build".into(),
            cwd: None,
            status: "idle".into(),
            output_channel_id: None,
            source: "suggested".into(),
            toolchain: "node".into(),
            package_path: None,
            role: "primary".into(),
        },
    ];

    let tests = test_tree_from_tasks(&tasks);
    assert_eq!(tests.len(), 1);
    assert_eq!(tests[0].children.len(), 1);
    assert_eq!(tests[0].children[0].id, "package:test");
}

#[test]
fn unknown_workspace_task_lists_the_valid_ids() {
    let task = |id: &str, group: &str| {
        suggested_task(
            id.into(),
            id.into(),
            "npm",
            Vec::new(),
            group,
            "node",
            None,
            "primary",
        )
    };
    let tasks = vec![task("package:build", "build"), task("package:test", "test")];
    let message = unknown_workspace_task_message("build", &tasks, false);
    assert!(message.contains("package:build, package:test"), "{message}");
    let message = unknown_workspace_task_message("package:build", &tasks, true);
    assert!(message.contains("available ids: package:test"), "{message}");
    assert!(!message.contains("package:build,"), "{message}");
    let many: Vec<_> = (0..240)
        .map(|index| task(&format!("package:script-{index:03}"), "build"))
        .collect();
    let message = unknown_workspace_task_message("x", &many, false);
    assert!(
        message.len() < 2_200 && message.ends_with("more)"),
        "{message}"
    );
    assert!(unknown_workspace_task_message("x", &[], true).contains("no discovered test tasks"));
}
