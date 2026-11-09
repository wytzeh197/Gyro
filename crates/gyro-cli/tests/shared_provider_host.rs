#![cfg(unix)]
use gyro_core::{
    CommandProfile, CommandProfileReadiness, GyroConfig, GyroPaths, ModelProviderConfig,
    SessionStore,
};
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

fn data_base(home: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support/Gyro")
    } else {
        home.join("data/Gyro")
    }
}
fn command(home: &Path, workspace: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_gyro"));
    command
        .current_dir(workspace)
        .env("HOME", home)
        .env("GYRO_TEST_EMPTY_KEYCHAIN", "1")
        .env("XDG_DATA_HOME", home.join("data"))
        .env("XDG_CONFIG_HOME", home.join("config"))
        .env("GYRO_SPILL_DIR", home.join("spill"));
    command
}
fn configure(home: &Path, endpoint: &str) {
    let config = GyroConfig {
        require_command_approval: true,
        require_file_edit_approval: true,
        model_providers: vec![ModelProviderConfig {
            id: "custom:host-fixture".into(),
            display_name: "Host fixture".into(),
            base_url: Some(endpoint.into()),
            api_key_ref: "provider:custom:host-fixture".into(),
            enabled: true,
            default_model_id: Some("fixture".into()),
            kind: Some(gyro_core::OPENAI_COMPATIBLE_KIND.into()),
            model_ids: vec!["fixture".into()],
        }],
        command_profiles: vec![CommandProfile {
            id: "http-fixture".into(),
            display_name: "HTTP fixture".into(),
            command: "/missing-http-adapter-executable".into(),
            args: Vec::new(),
            working_directory: None,
            provider_id: Some("custom:host-fixture".into()),
            default_model: Some("fixture".into()),
            readiness: CommandProfileReadiness::Ready,
        }],
        ..GyroConfig::default()
    };
    config
        .save(&GyroPaths::from_base_dir(data_base(home)))
        .unwrap();
}
fn accept(listener: &TcpListener) -> TcpStream {
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                return stream;
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < until =>
            {
                std::thread::sleep(Duration::from_millis(5))
            }
            Err(error) => panic!("fixture accept: {error}"),
        }
    }
}
fn read_request(stream: &mut TcpStream) -> Value {
    let mut reader = BufReader::new(stream);
    let mut length = 0;
    let mut headers = 0;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        headers += line.len();
        assert!(headers < 64 * 1024);
        if line == "\r\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().unwrap();
            }
        }
    }
    assert!(length > 0 && length <= 1024 * 1024);
    let mut body = vec![0; length];
    reader.read_exact(&mut body).unwrap();
    serde_json::from_slice(&body).unwrap()
}
fn respond(stream: &mut TcpStream, delta: Value, finish: &str) {
    let frame = json!({"choices":[{"delta":delta,"finish_reason":finish}],"usage":{"prompt_tokens":30,"completion_tokens":5,"total_tokens":35}});
    let body = format!("data: {frame}\n\ndata: [DONE]\n\n");
    write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
    stream.flush().unwrap();
}
fn tool(name: &str, args: Value) -> Value {
    json!({"tool_calls":[{"index":0,"id":name,"type":"function","function":{"name":name,"arguments":args.to_string()}}]})
}
fn latest_tool(request: &Value) -> Value {
    serde_json::from_str(
        request["messages"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|m| m["role"] == "tool")
            .unwrap()["content"]
            .as_str()
            .unwrap(),
    )
    .unwrap()
}

#[test]
fn api_cli_uses_shared_tools_and_enforces_terminal_file_decisions() {
    for approved in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let workspace = root.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(workspace.join("file.txt"), "before\n").unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        configure(
            &home,
            &format!("http://{}/v1", listener.local_addr().unwrap()),
        );
        let server = std::thread::spawn(move || {
            let mut stream = accept(&listener);
            let first = read_request(&mut stream);
            let names = first["tools"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v["function"]["name"].as_str().unwrap())
                .collect::<Vec<_>>();
            assert!(names.contains(&"gyro_workspace_read"));
            assert!(names.contains(&"gyro_workspace_propose_edit"));
            assert!(!names.contains(&"gyro_browser_navigate"));
            respond(
                &mut stream,
                tool("gyro_workspace_read", json!({"path":"file.txt"})),
                "tool_calls",
            );
            drop(stream);
            let mut stream = accept(&listener);
            let second = read_request(&mut stream);
            let observed = latest_tool(&second);
            assert_eq!(observed["result"]["data"]["content"], "before\n");
            let hash = observed["result"]["data"]["contentHash"].clone();
            respond(
                &mut stream,
                tool(
                    "gyro_workspace_propose_edit",
                    json!({"path":"file.txt","content":"after\n","expectedHash":hash}),
                ),
                "tool_calls",
            );
            drop(stream);
            let mut stream = accept(&listener);
            let third = read_request(&mut stream);
            assert_eq!(latest_tool(&third)["result"]["data"]["applied"], approved);
            respond(&mut stream, json!({"content":"checked"}), "stop");
        });
        let mut process = command(&home, &workspace);
        process.args([
            "run",
            "--profile",
            "http-fixture",
            "--no-open",
            "--json",
            "--timeout-seconds",
            "8",
        ]);
        if approved {
            process.arg("--approve");
        }
        process.arg("Update file.txt through the tools.");
        let output = process.output().unwrap();
        server.join().unwrap();
        if approved {
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let value: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(value["run"]["response"], "checked");
            assert_eq!(value["run"]["resumed"], false);
        } else {
            let value: Value = serde_json::from_slice(&output.stderr).unwrap();
            assert_eq!(value["error"]["category"], "approval-rejected");
        }
        assert_eq!(
            fs::read_to_string(workspace.join("file.txt")).unwrap(),
            if approved { "after\n" } else { "before\n" }
        );
        let store = SessionStore::open(GyroPaths::from_base_dir(data_base(&home))).unwrap();
        let session = store.latest_session().unwrap().unwrap();
        assert!(store
            .read_events(session.id)
            .unwrap()
            .iter()
            .any(|e| e.payload["kind"] == "capability-result"));
    }
}

#[test]
fn api_cli_ctrl_c_interrupts_an_open_generation_request() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let workspace = root.path().join("workspace");
    fs::create_dir_all(&workspace).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    configure(
        &home,
        &format!("http://{}/v1", listener.local_addr().unwrap()),
    );
    let (ready, started) = mpsc::channel();
    let (done, finish) = mpsc::channel();
    let server = std::thread::spawn(move || {
        let mut stream = accept(&listener);
        let _ = read_request(&mut stream);
        ready.send(()).unwrap();
        let _ = finish.recv_timeout(Duration::from_secs(10));
    });
    let mut process = command(&home, &workspace);
    process
        .args([
            "run",
            "--profile",
            "http-fixture",
            "--no-open",
            "--json",
            "--timeout-seconds",
            "8",
            "wait for reply",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = process.spawn().unwrap();
    started.recv_timeout(Duration::from_secs(5)).unwrap();
    let at = Instant::now();
    assert_eq!(unsafe { libc::kill(child.id() as i32, libc::SIGINT) }, 0);
    let output = child.wait_with_output().unwrap();
    let _ = done.send(());
    server.join().unwrap();
    assert!(at.elapsed() < Duration::from_secs(3));
    assert_eq!(output.status.code(), Some(130));
    let value: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(value["error"]["category"], "cancelled");
}
