use super::*;
use crate::{store::Store, transport::Handler, Operation, RemoteEvent, Request, Response};
use serde_json::{json, Value};
use std::{
    os::unix::fs::PermissionsExt,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tokio::{
    net::UnixStream,
    sync::{broadcast, mpsc},
};
fn request(operation: Operation) -> Request {
    Request {
        id: Uuid::new_v4(),
        lease: None,
        operation,
    }
}
fn options(host: &str) -> Options {
    Options {
        host: host.into(),
        user: None,
        port: None,
        identity_file: None,
        socket_path: None,
    }
}
fn private_dir() -> tempfile::TempDir {
    let dir = tempfile::Builder::new()
        .prefix("gssh-")
        .tempdir_in("/tmp")
        .unwrap();
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    dir
}

#[test]
fn destinations_cannot_inject_arguments_or_commands() {
    for host in [
        "-oProxyCommand=touch /tmp/no",
        "user@mac",
        "mac;whoami",
        "mac\nother",
        "mac $(id)",
        "",
    ] {
        assert!(options(host).arguments().is_err(), "{host:?}");
    }
    for host in ["mac-mini", "192.0.2.10", "::1", "mac.local"] {
        assert!(options(host).arguments().is_ok());
    }
    let mut o = options("mac");
    o.socket_path = Some("/tmp/a'$(touch nope).sock".into());
    let args = o.arguments().unwrap();
    let command = args.last().unwrap();
    assert!(command.contains("'\\''"));
    assert!(!command.contains("p=/tmp/"));
    assert!(args.contains(&"StrictHostKeyChecking=yes".into()));
    assert!(args.contains(&"ClearAllForwardings=yes".into()));
    assert!(args.contains(&"BatchMode=yes".into()));
    assert!(!command.contains("ssh-agent"));
}
#[test]
fn aliases_include_quoted_files_but_not_wildcards_or_exec() {
    let dir = private_dir();
    std::fs::create_dir(dir.path().join(".ssh")).unwrap();
    std::fs::create_dir(dir.path().join(".ssh/hosts")).unwrap();
    std::fs::write(dir.path().join(".ssh/config"),"Host mac-mini office !nope *.wild # note\nInclude \"hosts/*.conf\"\nMatch exec \"touch /tmp/never-execute\"\nHost=second\n").unwrap();
    std::fs::write(
        dir.path().join(".ssh/hosts/a.conf"),
        "Host build-mac\nInclude ../config\n",
    )
    .unwrap();
    assert_eq!(
        config_hosts(dir.path()),
        vec!["build-mac", "mac-mini", "office", "second"]
    );
}
#[test]
fn saved_hosts_and_client_identity_survive_restart_without_pairing() {
    let dir = private_dir();
    let store = Store::open(dir.path()).unwrap();
    let client = store.ssh_client_id().unwrap();
    let saved = SavedHost {
        id: format!("ssh:{}", Uuid::new_v4()),
        name: "Mac Mini".into(),
        options: options("mini"),
    };
    store.save_ssh_host(&saved).unwrap();
    drop(store);
    let store = Store::open(dir.path()).unwrap();
    assert_eq!(store.ssh_client_id().unwrap(), client);
    assert_eq!(store.ssh_hosts().unwrap()[0].id, saved.id);
    assert!(store.peers().unwrap().is_empty());
    assert!(!store.settings().unwrap().enabled);
    store.remove_ssh_host(&saved.id).unwrap();
    assert!(store.ssh_hosts().unwrap().is_empty());
}

async fn client_at(path: &Path) -> Arc<stream::Client> {
    let stream = UnixStream::connect(path).await.unwrap();
    let (read, write) = stream.into_split();
    stream::Client::open(read, write, Uuid::new_v4())
        .await
        .unwrap()
}

async fn poll_server_pending(
    server: &mut std::pin::Pin<Box<impl std::future::Future<Output = anyhow::Result<()>>>>,
) {
    std::future::poll_fn(|cx| {
        assert!(
            server.as_mut().poll(cx).is_pending(),
            "the stream must stay open while a frame is incomplete"
        );
        std::task::Poll::Ready(())
    })
    .await;
}

#[tokio::test]
async fn completed_handlers_preserve_fragmented_request_headers_and_bodies() {
    use crate::transport::{read_frame, write_frame};
    use tokio::io::AsyncWriteExt;

    for fragment_header in [true, false] {
        let (mut client, host) = tokio::io::duplex(64 * 1024);
        let release = Arc::new(tokio::sync::Notify::new());
        let gate = release.clone();
        let handler: Handler = Arc::new(move |_, req| {
            let gate = gate.clone();
            Box::pin(async move {
                if matches!(req.operation, Operation::Projects) {
                    gate.notified().await;
                }
                Response::result(req.id, Ok(Value::Null))
            })
        });
        let (events, _) = broadcast::channel(8);
        let mut server = Box::pin(stream::serve(
            host,
            handler,
            events,
            Arc::new(|_| {}),
            Arc::new(Mutex::new(std::collections::HashMap::new())),
        ));
        write_frame(
            &mut client,
            &stream::Handshake {
                version: 1,
                client_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
        let first = request(Operation::Projects);
        write_frame(&mut client, &json!({"type":"request", "value":first}))
            .await
            .unwrap();
        // Manually drive the server so handler completion happens exactly
        // between consuming this fragment and receiving the remaining bytes.
        poll_server_pending(&mut server).await;
        let second = request(Operation::Hello);
        let body = serde_json::to_vec(&json!({"type":"request", "value":second})).unwrap();
        let mut frame = (body.len() as u32).to_be_bytes().to_vec();
        frame.extend(body);
        let split = if fragment_header {
            2
        } else {
            4 + (frame.len() - 4) / 2
        };
        client.write_all(&frame[..split]).await.unwrap();
        poll_server_pending(&mut server).await;
        release.notify_one();
        let response = tokio::time::timeout(
            Duration::from_secs(2),
            read_frame::<stream::Frame, _>(&mut client),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(matches!(response, stream::Frame::Response(r) if r.id == first.id));
        // The handler has sent its response and finished. Reap it while the
        // next frame's length/body is still partial, without any timing sleeps.
        poll_server_pending(&mut server).await;
        client.write_all(&frame[split..]).await.unwrap();
        poll_server_pending(&mut server).await;
        let response = tokio::time::timeout(
            Duration::from_secs(2),
            read_frame::<stream::Frame, _>(&mut client),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(matches!(response, stream::Frame::Response(r) if r.id == second.id));
    }
}

async fn duplex_client(capacity: usize) -> (Arc<stream::Client>, tokio::io::DuplexStream) {
    let (client, mut host) = tokio::io::duplex(capacity);
    let (read, write) = tokio::io::split(client);
    let (opened, handshake) = tokio::join!(
        stream::Client::open(read, write, Uuid::new_v4()),
        crate::transport::read_frame::<stream::Handshake, _>(&mut host)
    );
    handshake.unwrap();
    (opened.unwrap(), host)
}

#[tokio::test]
async fn cancelled_response_waits_release_pending_slots_without_closing_stream() {
    use crate::transport::{read_frame, write_frame};
    let (client, mut host) = duplex_client(64 * 1024).await;
    // Exceed the admission limit cumulatively, with no responses for the
    // abandoned requests. Each cancellation must return its own slot.
    for _ in 0..20 {
        let c = client.clone();
        let pending = tokio::spawn(async move { c.request(request(Operation::Hello)).await });
        tokio::time::timeout(Duration::from_secs(2), read_frame::<Value, _>(&mut host))
            .await
            .unwrap()
            .unwrap();
        pending.abort();
        assert!(pending.await.unwrap_err().is_cancelled());
        assert!(!client.is_closed());
    }
    let next = request(Operation::Projects);
    let sent = next.clone();
    let c = client.clone();
    let pending = tokio::spawn(async move { c.request(sent).await });
    let received: Value = read_frame(&mut host).await.unwrap();
    assert_eq!(received["value"]["id"], next.id.to_string());
    write_frame(
        &mut host,
        &stream::Frame::Response(Response::result(next.id, Ok(json!("still usable")))),
    )
    .await
    .unwrap();
    assert_eq!(
        pending.await.unwrap().unwrap().into_result().unwrap(),
        "still usable"
    );
}

#[tokio::test]
async fn delivered_responses_keep_their_id_reserved_until_the_request_settles() {
    use crate::transport::{read_frame, write_frame};
    let (client, mut host) = duplex_client(64 * 1024).await;
    let (events, mut observed) = mpsc::unbounded_channel();
    let c = client.clone();
    let setup = tokio::spawn(async move {
        c.watch(
            request(Operation::Watch {
                session_id: "s".into(),
            }),
            Arc::new(move |event| {
                let _ = events.send(event);
            }),
        )
        .await
    });
    let watch_request: Value = read_frame(&mut host).await.unwrap();
    let watch_id = Uuid::parse_str(watch_request["value"]["id"].as_str().unwrap()).unwrap();
    write_frame(
        &mut host,
        &stream::Frame::Response(Response::result(watch_id, Ok(Value::Null))),
    )
    .await
    .unwrap();
    let watch = setup.await.unwrap().unwrap();

    let req = request(Operation::Hello);
    let mut first = Box::pin(client.request(req.clone()));
    std::future::poll_fn(|cx| {
        assert!(std::future::Future::poll(first.as_mut(), cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    let _: Value = read_frame(&mut host).await.unwrap();
    for _ in 0..2 {
        write_frame(
            &mut host,
            &stream::Frame::Response(Response::result(req.id, Ok(json!("original")))),
        )
        .await
        .unwrap();
    }
    // Event delivery is an ordered barrier proving that both responses were
    // processed, while the original request future remains deliberately unpolled.
    write_frame(
        &mut host,
        &stream::Frame::Event(RemoteEvent {
            session_id: "s".into(),
            topic: "barrier".into(),
            payload: Value::Null,
        }),
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(2), observed.recv())
        .await
        .unwrap()
        .unwrap();
    let duplicate = tokio::time::timeout(Duration::from_secs(2), client.request(req.clone()))
        .await
        .unwrap()
        .unwrap_err();
    assert!(duplicate.to_string().contains("already in flight"));
    assert_eq!(first.await.unwrap().into_result().unwrap(), "original");

    let c = client.clone();
    let id = req.id;
    let reused = tokio::spawn(async move { c.request(req).await });
    let _: Value = read_frame(&mut host).await.unwrap();
    write_frame(
        &mut host,
        &stream::Frame::Response(Response::result(id, Ok(json!("reused")))),
    )
    .await
    .unwrap();
    assert_eq!(
        reused.await.unwrap().unwrap().into_result().unwrap(),
        "reused"
    );
    watch.abort();
}

#[tokio::test]
async fn cancelling_a_partial_write_closes_stream_and_rejects_queued_writes() {
    use tokio::io::AsyncReadExt;
    let (client, mut host) = duplex_client(16).await;
    let c = client.clone();
    let writing = tokio::spawn(async move { c.request(request(Operation::Hello)).await });
    // The frame is larger than this duplex buffer. Reading only half its
    // header proves bytes were sent while the rest of the write remains blocked.
    let mut prefix = [0u8; 2];
    host.read_exact(&mut prefix).await.unwrap();
    let c = client.clone();
    let queued = tokio::spawn(async move { c.request(request(Operation::Projects)).await });
    tokio::task::yield_now().await;
    writing.abort();
    assert!(writing.await.unwrap_err().is_cancelled());
    assert!(client.is_closed());
    assert!(tokio::time::timeout(Duration::from_secs(2), queued)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    assert!(client.request(request(Operation::Hello)).await.is_err());
    let mut remaining = Vec::new();
    tokio::time::timeout(Duration::from_secs(2), host.read_to_end(&mut remaining))
        .await
        .expect("fail-close must deliver EOF even while the client is retained")
        .unwrap();
}

#[tokio::test]
async fn cancelling_watch_setup_retires_the_admitted_subscription() {
    use crate::transport::read_frame;
    let (client, mut host) = duplex_client(64 * 1024).await;
    let watch_request = request(Operation::Watch {
        session_id: "s".into(),
    });
    let id = watch_request.id;
    let c = client.clone();
    let setup = tokio::spawn(async move { c.watch(watch_request, Arc::new(|_| {})).await });
    let frame: Value = read_frame(&mut host).await.unwrap();
    assert_eq!(frame["type"], "request");
    // The host has the request but has not acknowledged it yet.
    setup.abort();
    assert!(setup.await.unwrap_err().is_cancelled());
    let cancel: Value = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut host))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(cancel["type"], "unwatch");
    assert_eq!(cancel["value"], id.to_string());
    assert!(!client.is_closed());
}

#[tokio::test]
async fn client_failure_retires_the_owned_ssh_process() {
    let connection = Connection::launch(
        Path::new("/bin/sh"),
        vec!["-c".into(), "exec /bin/sleep 30".into()],
        Uuid::new_v4(),
    )
    .await
    .unwrap();
    assert!(connection.child.lock().unwrap().is_some());
    connection.client.close();
    tokio::time::timeout(Duration::from_secs(2), async {
        while connection.child.lock().unwrap().is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("client-only shutdown must retire the retained connection's process");
}

#[tokio::test]
async fn socket_multiplexes_requests_and_live_events_and_fences_scope_revocation() {
    let dir = private_dir();
    let path = dir.path().join("ssh.sock");
    let allowed = Arc::new(AtomicBool::new(true));
    let count = Arc::new(AtomicUsize::new(0));
    let a = allowed.clone();
    let c = count.clone();
    let handler: Handler = Arc::new(move |peer, req| {
        let a = a.clone();
        let c = c.clone();
        Box::pin(async move {
            assert!(peer.starts_with("ssh:"));
            c.fetch_add(1, Ordering::SeqCst);
            if matches!(req.operation, Operation::Watch { .. }) && !a.load(Ordering::SeqCst) {
                return Response::result(req.id, Err("Scope revoked".into()));
            }
            if matches!(req.operation, Operation::Projects) {
                tokio::time::sleep(Duration::from_millis(80)).await;
            }
            Response::result(req.id, Ok(json!({"peer":peer})))
        })
    });
    let (events, _) = broadcast::channel(256);
    let cleaned = Arc::new(AtomicBool::new(false));
    let cl = cleaned.clone();
    let server = Server::bind(
        &path,
        handler,
        events.clone(),
        Arc::new(move |_| {
            cl.store(true, Ordering::SeqCst);
        }),
    )
    .await
    .unwrap();
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let client = client_at(&path).await;
    let req = request(Operation::Hello);
    let first = client.request(req.clone()).await.unwrap();
    assert_eq!(first.id, req.id);
    let (sender, mut receive) = mpsc::unbounded_channel();
    let watch = client
        .watch(
            request(Operation::Watch {
                session_id: "s".into(),
            }),
            Arc::new(move |e| {
                let _ = sender.send(e);
            }),
        )
        .await
        .unwrap();
    events
        .send(RemoteEvent {
            session_id: "other".into(),
            topic: "provider".into(),
            payload: json!("hidden"),
        })
        .unwrap();
    events
        .send(RemoteEvent {
            session_id: "s".into(),
            topic: "provider".into(),
            payload: json!("live text"),
        })
        .unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), receive.recv())
            .await
            .unwrap()
            .unwrap()
            .payload,
        "live text"
    );
    let slow = {
        let client = client.clone();
        tokio::spawn(async move { client.request(request(Operation::Projects)).await })
    };
    let fast = tokio::time::timeout(
        Duration::from_millis(60),
        client.request(request(Operation::Stop {
            session_id: "s".into(),
        })),
    )
    .await
    .expect("stop must not wait behind slow reads")
    .unwrap();
    assert!(fast.error.is_none());
    slow.await.unwrap().unwrap();
    allowed.store(false, Ordering::SeqCst);
    events
        .send(RemoteEvent {
            session_id: "s".into(),
            topic: "provider".into(),
            payload: json!("forbidden"),
        })
        .unwrap();
    let revoked = tokio::time::timeout(Duration::from_secs(2), receive.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(revoked.topic, "resync");
    assert_eq!(revoked.payload["streamClosed"], true);
    watch.await.unwrap();
    client.close();
    drop(client);
    tokio::time::timeout(Duration::from_secs(2), async {
        while !cleaned.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    drop(server);
    assert!(!path.exists());
    assert!(count.load(Ordering::SeqCst) >= 5);
}
#[tokio::test]
async fn server_refuses_public_directories_and_live_socket_replacement() {
    let dir = private_dir();
    let path = dir.path().join("ssh.sock");
    let handler: Handler =
        Arc::new(|_, r| Box::pin(async move { Response::result(r.id, Ok(Value::Null)) }));
    let (events, _) = broadcast::channel(2);
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(
        Server::bind(&path, handler.clone(), events.clone(), Arc::new(|_| {}))
            .await
            .is_err()
    );
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let server = Server::bind(&path, handler.clone(), events.clone(), Arc::new(|_| {}))
        .await
        .unwrap();
    assert!(Server::bind(&path, handler, events, Arc::new(|_| {}))
        .await
        .is_err());
    drop(server);
}
#[tokio::test]
async fn host_shutdown_closes_watches_and_releases_clients() {
    let dir = private_dir();
    let handler: Handler =
        Arc::new(|_, r| Box::pin(async move { Response::result(r.id, Ok(Value::Null)) }));
    let (events, _) = broadcast::channel(8);
    let path = dir.path().join("ssh.sock");
    let server = Server::bind(&path, handler, events, Arc::new(|_| {}))
        .await
        .unwrap();
    let client = client_at(&path).await;
    let (sender, mut receive) = mpsc::unbounded_channel();
    let task = client
        .watch(
            request(Operation::Watch {
                session_id: "s".into(),
            }),
            Arc::new(move |e| {
                let _ = sender.send(e);
            }),
        )
        .await
        .unwrap();
    server.close();
    let event = tokio::time::timeout(Duration::from_secs(2), receive.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event.payload["streamClosed"], true);
    task.await.unwrap();
    assert!(client.is_closed());
}

/// Explicit real-OpenSSH integration. Uses temporary keys/known_hosts and a
/// high-port, unprivileged sshd. Never edits system SSH or the user's keys.
#[tokio::test]
#[ignore = "requires an sshd-capable local test environment"]
async fn actual_openssh_carries_requests_and_live_events() {
    use std::{io::Write, process::Stdio};
    let dir = private_dir();
    let key = dir.path().join("client");
    let server_key = dir.path().join("host");
    for key in [&key, &server_key] {
        assert!(std::process::Command::new("/usr/bin/ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-f"])
            .arg(key)
            .status()
            .unwrap()
            .success());
    }
    let address = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = address.local_addr().unwrap().port();
    drop(address);
    let user = std::env::var("USER").unwrap();
    let auth_dir = tempfile::Builder::new()
        .prefix(".gyro-ssh-auth-test-")
        .tempdir_in(std::env::var_os("HOME").unwrap())
        .unwrap();
    std::fs::set_permissions(auth_dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let authorized = auth_dir.path().join("authorized_keys");
    std::fs::copy(key.with_extension("pub"), &authorized).unwrap();
    let config = dir.path().join("sshd_config");
    std::fs::write(&config,format!("Port {port}\nListenAddress 127.0.0.1\nHostKey {}\nPidFile {}\nAuthorizedKeysFile {}\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nUsePAM no\nStrictModes yes\nAllowUsers {user}\nLogLevel VERBOSE\n",server_key.display(),dir.path().join("pid").display(),authorized.display())).unwrap();
    let log = std::fs::File::create(dir.path().join("sshd.log")).unwrap();
    let mut daemon = Command::new("/usr/sbin/sshd")
        .args(["-D", "-e", "-f"])
        .arg(&config)
        .stdout(Stdio::null())
        .stderr(log)
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let start = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(status) = daemon.try_wait().unwrap() {
                panic!(
                    "test sshd exited {status}: {}",
                    std::fs::read_to_string(dir.path().join("sshd.log")).unwrap()
                );
            }
            if tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_ok()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert!(start.is_ok(), "test sshd did not start");
    let public = std::fs::read_to_string(server_key.with_extension("pub")).unwrap();
    let known = dir.path().join("known_hosts");
    std::fs::write(&known, format!("[127.0.0.1]:{port} {public}")).unwrap();
    let handler: Handler = Arc::new(|peer, r| {
        Box::pin(async move {
            Response::result(
                r.id,
                Ok(
                    json!({"protocol":1,"name":"SSH test host","peer":peer,"capabilities":["chat"]}),
                ),
            )
        })
    });
    let (events, _) = broadcast::channel(8);
    let path = dir.path().join("ssh.sock");
    let disconnected = Arc::new(AtomicBool::new(false));
    let disconnected_flag = disconnected.clone();
    let _server = Server::bind(
        &path,
        handler,
        events.clone(),
        Arc::new(move |_| {
            disconnected_flag.store(true, Ordering::SeqCst);
        }),
    )
    .await
    .unwrap();
    let mut o = options("127.0.0.1");
    o.user = Some(user);
    o.port = Some(port);
    o.identity_file = Some(key.to_string_lossy().into());
    o.socket_path = Some(path.to_string_lossy().into());
    let mut args = o.arguments().unwrap();
    args.splice(
        0..0,
        [
            "-o".into(),
            format!("UserKnownHostsFile={}", known.display()),
        ],
    );
    let mut untrusted_args = o.arguments().unwrap();
    untrusted_args.splice(
        0..0,
        [
            "-o".into(),
            "UserKnownHostsFile=/dev/null".into(),
            "-o".into(),
            "GlobalKnownHostsFile=/dev/null".into(),
        ],
    );
    let untrusted = Connection::launch(Path::new("/usr/bin/ssh"), untrusted_args, Uuid::new_v4())
        .await
        .unwrap();
    assert!(
        untrusted
            .hello()
            .await
            .unwrap_err()
            .to_string()
            .contains("host key"),
        "unknown host keys must not be silently accepted"
    );
    let connection = Connection::launch(Path::new("/usr/bin/ssh"), args, Uuid::new_v4())
        .await
        .unwrap();
    let hello = connection.hello().await.unwrap_or_else(|error| {
        panic!(
            "SSH test failed: {error}; daemon: {}",
            std::fs::read_to_string(dir.path().join("sshd.log")).unwrap_or_default()
        )
    });
    assert_eq!(hello["name"], "SSH test host");
    let (tx, mut rx) = mpsc::unbounded_channel();
    let watch = connection
        .client
        .watch(
            request(Operation::Watch {
                session_id: "s".into(),
            }),
            Arc::new(move |e| {
                let _ = tx.send(e);
            }),
        )
        .await
        .unwrap();
    events
        .send(RemoteEvent {
            session_id: "s".into(),
            topic: "provider".into(),
            payload: json!({"text":"actual encrypted SSH stream"}),
        })
        .unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), rx.recv())
            .await
            .unwrap()
            .unwrap()
            .payload["text"],
        "actual encrypted SSH stream"
    );
    connection.close();
    watch.abort();
    tokio::time::timeout(Duration::from_secs(2), async {
        while !disconnected.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("SSH disconnect must close the host socket");
    let _ = daemon.kill().await;
    std::fs::File::create(dir.path().join("passed"))
        .unwrap()
        .write_all(b"real OpenSSH request and live event passed")
        .unwrap();
}

#[tokio::test]
async fn explicit_disconnect_settles_pending_requests_immediately() {
    let dir = private_dir();
    let path = dir.path().join("ssh.sock");
    let started = Arc::new(tokio::sync::Notify::new());
    let signal = started.clone();
    let handler: Handler = Arc::new(move |_, r| {
        let signal = signal.clone();
        Box::pin(async move {
            signal.notify_one();
            std::future::pending::<()>().await;
            Response::result(r.id, Ok(Value::Null))
        })
    });
    let (events, _) = broadcast::channel(8);
    let server = Server::bind(&path, handler, events, Arc::new(|_| {}))
        .await
        .unwrap();
    let client = client_at(&path).await;
    let pending = {
        let c = client.clone();
        tokio::spawn(async move { c.request(request(Operation::Projects)).await })
    };
    started.notified().await;
    client.close();
    assert!(tokio::time::timeout(Duration::from_secs(1), pending)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    drop(client);
    drop(server);
}
#[tokio::test]
async fn cancelling_an_old_watch_does_not_cancel_its_replacement() {
    let dir = private_dir();
    let path = dir.path().join("ssh.sock");
    let handler: Handler =
        Arc::new(|_, r| Box::pin(async move { Response::result(r.id, Ok(Value::Null)) }));
    let (events, _) = broadcast::channel(8);
    let _server = Server::bind(&path, handler, events.clone(), Arc::new(|_| {}))
        .await
        .unwrap();
    let client = client_at(&path).await;
    let first = client
        .watch(
            request(Operation::Watch {
                session_id: "s".into(),
            }),
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let second = client
        .watch(
            request(Operation::Watch {
                session_id: "s".into(),
            }),
            Arc::new(move |event| {
                let _ = tx.send(event);
            }),
        )
        .await
        .unwrap();
    first.abort();
    tokio::task::yield_now().await;
    tokio::task::yield_now().await;
    client.request(request(Operation::Hello)).await.unwrap();
    events
        .send(RemoteEvent {
            session_id: "s".into(),
            topic: "provider".into(),
            payload: json!("replacement"),
        })
        .unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), rx.recv())
            .await
            .unwrap()
            .unwrap()
            .payload,
        "replacement"
    );
    second.abort();
    client.close();
}
#[tokio::test]
async fn disconnecting_one_alias_keeps_other_connections_from_the_same_device_authorized() {
    let dir = private_dir();
    let path = dir.path().join("ssh.sock");
    let handler: Handler =
        Arc::new(|_, r| Box::pin(async move { Response::result(r.id, Ok(Value::Null)) }));
    let cleaned = Arc::new(AtomicUsize::new(0));
    let count = cleaned.clone();
    let (events, _) = broadcast::channel(8);
    let _server = Server::bind(
        &path,
        handler,
        events,
        Arc::new(move |_| {
            count.fetch_add(1, Ordering::SeqCst);
        }),
    )
    .await
    .unwrap();
    let id = Uuid::new_v4();
    let connect = || async {
        let stream = UnixStream::connect(&path).await.unwrap();
        let (r, w) = stream.into_split();
        let c = stream::Client::open(r, w, id).await.unwrap();
        c.request(request(Operation::Hello)).await.unwrap();
        c
    };
    let first = connect().await;
    let second = connect().await;
    first.close();
    drop(first);
    tokio::time::sleep(Duration::from_millis(20)).await;
    second.request(request(Operation::Hello)).await.unwrap();
    assert_eq!(cleaned.load(Ordering::SeqCst), 0);
    second.close();
    drop(second);
    tokio::time::timeout(Duration::from_secs(1), async {
        while cleaned.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(cleaned.load(Ordering::SeqCst), 1);
}
