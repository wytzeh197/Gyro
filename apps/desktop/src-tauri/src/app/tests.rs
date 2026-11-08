use super::*;

#[test]
fn renderer_config_cannot_replace_native_account_state() {
    let mut persisted = GyroConfig::default();
    persisted.account_session.signed_in = true;
    persisted.account_session.user_id = Some("native-user".into());
    let mut incoming = persisted.clone();
    incoming.telemetry_enabled = true;
    incoming.account_oidc.issuer_url = "https://attacker.invalid".into();
    incoming.account_session.user_id = Some("forged-user".into());

    let merged = merge_renderer_config(incoming, &persisted);

    assert!(merged.telemetry_enabled);
    assert_eq!(merged.account_oidc, persisted.account_oidc);
    assert_eq!(merged.account_session, persisted.account_session);
}

#[cfg(unix)]
#[test]
fn provider_ipc_routes_to_owning_host_when_another_app_owns_public_socket() {
    use std::os::unix::net::UnixListener;

    let temp = tempfile::tempdir().unwrap();
    let public = GyroPaths::from_base_dir(temp.path().join("Gyro"));
    public.ensure().unwrap();
    let first = provider_host_ipc_paths(public.clone(), 101).unwrap();
    let second = provider_host_ipc_paths(public.clone(), 202).unwrap();
    assert!(provider_host_ipc_paths(public.clone(), 0).is_err());
    let public_listener = UnixListener::bind(&public.socket_path).unwrap();
    public_listener.set_nonblocking(true).unwrap();

    for (paths, owner) in [(first, "first-host"), (second, "second-host")] {
        let listener = bind_cli_ipc_listener(&paths).unwrap().unwrap();
        listener.set_nonblocking(true).unwrap();
        let worker = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(3);
            let stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "owning host received no request");
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("accept provider request: {error}"),
                }
            };
            // macOS inherits O_NONBLOCK from the listening socket. Poll
            // acceptance above, then read the complete request in blocking mode.
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(stream);
            let line = read_bounded_protocol_line(&mut reader, MAX_DESKTOP_IPC_MESSAGE_BYTES)
                .unwrap()
                .unwrap();
            let request: CapabilityRequest = serde_json::from_slice(&line).unwrap();
            let response = CapabilityResponse::failed(
                env!("CARGO_PKG_VERSION"),
                request.context.call_id,
                owner,
                "fixture host",
            );
            write_bounded_json_line(reader.get_mut(), &response, MAX_DESKTOP_IPC_MESSAGE_BYTES)
                .unwrap();
        });
        let context = DesktopProviderCapabilityContext {
            session_id: Uuid::new_v4().to_string(),
            turn_id: Some(Uuid::new_v4().to_string()),
            run_nonce: "test-run-nonce".into(),
            provider_id: "openai".into(),
            workspace_key: temp.path().display().to_string(),
            mode: CapabilityRunMode::Normal,
            allow_delegation: false,
            compact_catalog: false,
            policy_revision: 0,
            workspace_context_revision: 0,
        };
        let params = serde_json::json!({"name": "gyro_browser_inspect", "arguments": {}});
        let response = desktop_capability_tool_call(&paths, &context, params.clone()).unwrap();
        assert!(response["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains(owner));
        worker.join().unwrap();

        // Once the owner exits, never send its chat to the public instance.
        let response = desktop_capability_tool_call(&paths, &context, params).unwrap();
        assert!(response["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("tools-unavailable"));
        assert_eq!(
            public_listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }
}

#[cfg(unix)]
#[test]
fn ipc_bind_preserves_live_socket_and_replaces_only_stale_socket() {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    use std::os::unix::net::UnixListener;

    let temp = tempfile::tempdir().unwrap();
    let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
    paths.ensure().unwrap();
    let live = UnixListener::bind(&paths.socket_path).unwrap();
    let live_inode = fs::symlink_metadata(&paths.socket_path).unwrap().ino();

    assert!(bind_cli_ipc_listener(&paths).unwrap().is_none());
    assert_eq!(
        fs::symlink_metadata(&paths.socket_path).unwrap().ino(),
        live_inode
    );

    // Drain the liveness probe before closing the listener. On macOS, a
    // queued connection can briefly keep the socket connectable after the
    // listener is dropped.
    let (probe, _) = live.accept().unwrap();
    drop(probe);
    drop(live);
    let rebound = (0..50)
        .find_map(|_| match bind_cli_ipc_listener(&paths).unwrap() {
            Some(listener) => Some(listener),
            None => {
                std::thread::sleep(Duration::from_millis(10));
                None
            }
        })
        .expect("closed IPC socket should eventually be detected as stale");
    assert!(fs::symlink_metadata(&paths.socket_path)
        .unwrap()
        .file_type()
        .is_socket());
    drop(rebound);
}

#[cfg(unix)]
#[test]
fn ipc_bind_refuses_to_remove_non_socket_targets() {
    let temp = tempfile::tempdir().unwrap();
    let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
    paths.ensure().unwrap();
    fs::write(&paths.socket_path, b"do not remove").unwrap();

    assert!(bind_cli_ipc_listener(&paths)
        .unwrap_err()
        .to_string()
        .contains("not a safe Unix socket"));
    assert_eq!(fs::read(&paths.socket_path).unwrap(), b"do not remove");
}

#[cfg(unix)]
#[test]
fn quit_removes_only_this_hosts_provider_socket() {
    let temp = tempfile::tempdir().unwrap();
    let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
    paths.ensure().unwrap();
    let own = provider_host_ipc_paths(paths.clone(), 4242).unwrap();
    let other = provider_host_ipc_paths(paths.clone(), 4343).unwrap();
    drop(std::os::unix::net::UnixListener::bind(&own.socket_path).unwrap());
    drop(std::os::unix::net::UnixListener::bind(&other.socket_path).unwrap());
    remove_provider_host_ipc_socket(paths.clone(), 4242);
    assert!(!own.socket_path.exists() && other.socket_path.exists());
    fs::remove_file(&other.socket_path).unwrap();
    fs::write(&other.socket_path, b"not a socket").unwrap();
    remove_provider_host_ipc_socket(paths, 4343);
    assert!(other.socket_path.exists());
}

#[test]
fn quit_jobs_run_in_parallel_and_stop_waiting_at_the_deadline() {
    let finished = Arc::new(AtomicUsize::new(0));
    let mut jobs: Vec<Box<dyn FnOnce() + Send>> =
        vec![Box::new(|| std::thread::sleep(Duration::from_secs(30)))];
    for _ in 0..4 {
        let finished = Arc::clone(&finished);
        jobs.push(Box::new(move || {
            std::thread::sleep(Duration::from_millis(100));
            finished.fetch_add(1, Ordering::SeqCst);
        }));
    }
    let started = Instant::now();
    run_quit_jobs_until(jobs, started + Duration::from_millis(400));
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(finished.load(Ordering::SeqCst), 4);
}

#[test]
fn scheduler_pauses_configuration_failures_instead_of_retrying_forever() {
    let temp = tempfile::tempdir().unwrap();
    let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
    let store = AutomationStore::open(paths.clone()).unwrap();
    store
        .create_automation(CreateAutomationRequest {
            title: "Missing workspace".into(),
            prompt: "Run checks".into(),
            schedule: gyro_core::AutomationSchedule::Heartbeat,
            project: "Missing".into(),
            provider: "Codex".into(),
            branch: "main".into(),
            workspace_mode: SessionWorkspaceMode::Local,
            worktree_name: None,
            stop_condition: None,
            next_run_at: Some(chrono::Utc::now() - chrono::Duration::minutes(1)),
            execution: gyro_core::AutomationExecutionContext::default(),
        })
        .unwrap();

    let failed = run_automation_scheduler_once_with(&paths, "worker", |_| {
        Err("configuration: choose a workspace for this automation".into())
    })
    .unwrap()
    .unwrap();
    assert_eq!(failed.status, AutomationStatus::Paused);
    assert!(failed.next_run_at.is_none());
    assert_eq!(failed.run_history[0].status, AutomationRunStatus::Failed);
    assert!(failed.last_result.contains("choose a workspace"));
}
