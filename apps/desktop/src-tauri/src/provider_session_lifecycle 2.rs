use super::{
    provider_chat_status_message, provider_failure_recovery, GyroPaths, HarnessRunStatus,
    SessionEvent, SessionEventKind, SessionStore, MAX_DESKTOP_SESSION_EVENTS_READ,
    PROVIDER_INTERRUPTED_MARKER,
};
use anyhow::Context;
use std::{collections::HashMap, fs, path::Path};
use uuid::Uuid;

pub(crate) const SESSION_LEASE_VERSION: u64 = 1;

/// A kernel-owned lease, released even if the provider host is force-quit.
/// Keep the file in place after release: unlinking creates a second lock inode.
pub(crate) struct ProviderSessionLease {
    _scope: gyro_core::process_guard::ProcessLeaseScope,
    _file: fs::File,
}

impl ProviderSessionLease {
    pub(crate) fn process_owner(&self) -> gyro_core::process_guard::ProcessOwner {
        self._scope.owner()
    }

    pub(crate) fn for_run(store: &SessionStore, session_id: Uuid) -> anyhow::Result<Self> {
        let lease = Self::try_acquire(store.paths(), session_id)?
            .ok_or_else(|| anyhow::anyhow!("this chat already has an active provider run"))?;
        // Older binaries hold no lease. Do not dispatch a second run when a
        // durable running row and an older live endpoint make ownership unclear.
        if store.has_running_provider_turn(session_id)?
            && legacy_provider_host_active(&store.paths().base_dir)?
        {
            anyhow::bail!("this chat has an unfinished run in a live Gyro host");
        }
        Ok(lease)
    }

    pub(crate) fn try_acquire(paths: &GyroPaths, session_id: Uuid) -> anyhow::Result<Option<Self>> {
        paths.ensure()?;
        let directory = paths.base_dir.join("provider-session-leases");
        fs::create_dir_all(&directory)?;
        let metadata = fs::symlink_metadata(&directory)?;
        anyhow::ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "provider session lease directory is not a regular directory"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
        }
        let mut options = fs::OpenOptions::new();
        options.create(true).truncate(false).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // Exclusive handle sharing; OPEN_REPARSE_POINT refuses following
            // a symlink planted at the otherwise fixed UUID path.
            options.share_mode(0).custom_flags(0x0020_0000);
        }
        let file = match options.open(directory.join(format!("{session_id}.lock"))) {
            Ok(file) => file,
            #[cfg(windows)]
            Err(error) if error.raw_os_error() == Some(32) => return Ok(None),
            Err(error) => return Err(error).context("open provider session lease"),
        };
        anyhow::ensure!(
            file.metadata()?.is_file(),
            "provider session lease is not a regular file"
        );
        #[cfg(unix)]
        {
            use std::os::{
                fd::AsRawFd,
                unix::fs::{MetadataExt, PermissionsExt},
            };
            let metadata = file.metadata()?;
            anyhow::ensure!(
                metadata.nlink() == 1 && metadata.uid() == unsafe { libc::geteuid() },
                "provider session lease is not a private owned file"
            );
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
            loop {
                if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                    break;
                }
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                if error.kind() == std::io::ErrorKind::WouldBlock {
                    return Ok(None);
                }
                return Err(error).context("lock provider session lease");
            }
        }
        #[cfg(not(any(unix, windows)))]
        anyhow::bail!("provider session leases are unavailable on this platform");
        #[cfg(any(unix, windows))]
        Ok(Some(Self {
            _scope: gyro_core::process_guard::ProcessLeaseScope::bind(&file)?,
            _file: file,
        }))
    }
}

/// Close abandoned turns while excluding sessions still owned by another host.
pub(crate) fn reconcile_interrupted_provider_turns(store: &SessionStore) -> anyhow::Result<usize> {
    reconcile_running_turns(store, store.list_running_turns()?)
}

fn reconcile_running_turns(
    store: &SessionStore,
    running: Vec<(Uuid, Uuid)>,
) -> anyhow::Result<usize> {
    if running.is_empty() {
        return Ok(0);
    }
    let mut turns_by_session: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
    for (session_id, turn_id) in running {
        turns_by_session
            .entry(session_id)
            .or_default()
            .push(turn_id);
    }
    let mut legacy_host_active = None;
    let mut closed = 0;
    for (session_id, turn_ids) in turns_by_session {
        let Some(_lease) = ProviderSessionLease::try_acquire(store.paths(), session_id)? else {
            continue;
        };
        let events = store.read_recent_events(session_id, MAX_DESKTOP_SESSION_EVENTS_READ)?;
        for turn_id in turn_ids {
            // Enumeration can race a final status append before lease acquisition.
            if store
                .latest_provider_status_for_turn(session_id, turn_id)?
                .as_deref()
                != Some("running")
            {
                continue;
            }
            let payload = interrupted_provider_status_payload(&events, turn_id);
            if payload
                .get("sessionLeaseVersion")
                .and_then(serde_json::Value::as_u64)
                != Some(SESSION_LEASE_VERSION)
            {
                let active = match legacy_host_active {
                    Some(active) => active,
                    None => {
                        let active = legacy_provider_host_active(&store.paths().base_dir)?;
                        legacy_host_active = Some(active);
                        active
                    }
                };
                if active {
                    continue;
                }
            }
            let label = payload
                .get("providerLabel")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("Provider");
            let message = provider_chat_status_message(&HarnessRunStatus::Failed, label);
            match store.append_event_with_turn_id(
                session_id,
                SessionEventKind::SystemEvent,
                message,
                payload,
                Some(turn_id),
            ) {
                Ok(_) => closed += 1,
                Err(error) => eprintln!("could not close interrupted turn {turn_id}: {error}"),
            }
        }
    }
    Ok(closed)
}

/// Older hosts do not acquire leases. A live public endpoint is ambiguous, so
/// defer their recovery. Nonblocking connect avoids waiting on a full backlog.
fn legacy_provider_host_active(base_dir: &Path) -> anyhow::Result<bool> {
    #[cfg(unix)]
    {
        use std::os::{
            fd::{FromRawFd, OwnedFd},
            unix::{ffi::OsStrExt, fs::FileTypeExt},
        };
        for entry in fs::read_dir(base_dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if name != "gyro.sock" && !(name.starts_with("gyro-") && name.ends_with(".sock")) {
                continue;
            }
            if !entry.file_type()?.is_socket() {
                continue;
            }
            let raw = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
            if raw < 0 {
                return Err(std::io::Error::last_os_error())
                    .context("inspect legacy provider host");
            }
            let socket = unsafe { OwnedFd::from_raw_fd(raw) };
            use std::os::fd::AsRawFd;
            if unsafe { libc::fcntl(socket.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK) } < 0 {
                return Err(std::io::Error::last_os_error())
                    .context("make legacy host check nonblocking");
            }
            let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
            address.sun_family = libc::AF_UNIX as _;
            let path = entry.path();
            let bytes = path.as_os_str().as_bytes();
            anyhow::ensure!(
                bytes.len() < address.sun_path.len(),
                "legacy provider socket path is too long"
            );
            for (destination, byte) in address.sun_path.iter_mut().zip(bytes) {
                *destination = *byte as _;
            }
            let result = unsafe {
                libc::connect(
                    socket.as_raw_fd(),
                    &address as *const _ as *const libc::sockaddr,
                    std::mem::size_of_val(&address) as libc::socklen_t,
                )
            };
            if result == 0 {
                #[cfg(target_os = "macos")]
                {
                    let mut peer: libc::pid_t = 0;
                    let mut length = std::mem::size_of_val(&peer) as libc::socklen_t;
                    if unsafe {
                        libc::getsockopt(
                            socket.as_raw_fd(),
                            libc::SOL_LOCAL,
                            libc::LOCAL_PEERPID,
                            (&mut peer as *mut libc::pid_t).cast(),
                            &mut length,
                        )
                    } == 0
                        && peer == unsafe { libc::getpid() }
                    {
                        // This host always holds a session lease for active
                        // runs. Its own endpoint cannot represent an older,
                        // lease-free owner; treating it as one blocks recovery.
                        continue;
                    }
                }
                return Ok(true);
            }
            let error = std::io::Error::last_os_error();
            match error.raw_os_error() {
                Some(libc::ECONNREFUSED | libc::ENOENT) => continue,
                // A full listener queue is still a live or ambiguous host.
                Some(libc::EINPROGRESS | libc::EAGAIN) => return Ok(true),
                _ => return Err(error).context("inspect legacy provider socket"),
            }
        }
    }
    #[cfg(not(unix))]
    let _ = base_dir;
    Ok(false)
}

/// The closing payload for an interrupted turn, shaped like the run's own.
fn interrupted_provider_status_payload(
    events: &[SessionEvent],
    turn_id: Uuid,
) -> serde_json::Value {
    let previous = events
        .iter()
        .rfind(|event| {
            event.turn_id == Some(turn_id)
                && event
                    .payload
                    .get("kind")
                    .and_then(serde_json::Value::as_str)
                    == Some("provider-status")
        })
        .and_then(|event| event.payload.as_object())
        .cloned()
        .unwrap_or_default();
    let mut payload = serde_json::Value::Object(previous);
    let (recovery_kind, recovery_message) = provider_failure_recovery(PROVIDER_INTERRUPTED_MARKER);
    if let Some(object) = payload.as_object_mut() {
        object.insert(
            "kind".into(),
            serde_json::Value::String("provider-status".into()),
        );
        object.insert(
            "status".into(),
            serde_json::Value::String(HarnessRunStatus::Failed.as_str().into()),
        );
        object.insert(
            "error".into(),
            serde_json::Value::String(PROVIDER_INTERRUPTED_MARKER.into()),
        );
        object.insert(
            "recoveryKind".into(),
            serde_json::Value::String(recovery_kind.into()),
        );
        object.insert(
            "recoveryMessage".into(),
            serde_json::Value::String(recovery_message.into()),
        );
        object.insert(
            "turnId".into(),
            serde_json::Value::String(turn_id.to_string()),
        );
        object.insert(
            "completedAt".into(),
            serde_json::Value::String(chrono::Utc::now().to_rfc3339()),
        );
    }
    payload
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider_turn_has_unfinished_attempt;
    use gyro_core::SessionOrigin;

    fn running_turn(store: &SessionStore, session: Uuid, turn: Uuid) {
        store
            .append_event_with_turn_id(
                session,
                SessionEventKind::SystemEvent,
                "working",
                serde_json::json!({"kind":"provider-status", "status":"running",
                "sessionLeaseVersion":SESSION_LEASE_VERSION}),
                Some(turn),
            )
            .unwrap();
    }

    #[test]
    fn lease_excludes_same_session_but_allows_another_and_releases_on_drop() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let session = Uuid::new_v4();
        let lease = ProviderSessionLease::try_acquire(&paths, session)
            .unwrap()
            .unwrap();
        assert!(ProviderSessionLease::try_acquire(&paths, session)
            .unwrap()
            .is_none());
        assert!(ProviderSessionLease::try_acquire(&paths, Uuid::new_v4())
            .unwrap()
            .is_some());
        drop(lease);
        assert!(ProviderSessionLease::try_acquire(&paths, session)
            .unwrap()
            .is_some());
        assert!(paths
            .base_dir
            .join("provider-session-leases")
            .join(format!("{session}.lock"))
            .exists());
    }

    #[test]
    fn completed_turn_from_stale_enumeration_is_never_overwritten() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "chat")
            .unwrap();
        let turn = Uuid::new_v4();
        running_turn(&store, session.id, turn);
        let snapshot = store.list_running_turns().unwrap();
        store
            .append_event_with_turn_id(
                session.id,
                SessionEventKind::SystemEvent,
                "done",
                serde_json::json!({"kind":"provider-status", "status":"done"}),
                Some(turn),
            )
            .unwrap();
        let count = store.read_events(session.id).unwrap().len();
        assert_eq!(reconcile_running_turns(&store, snapshot).unwrap(), 0);
        assert_eq!(
            store
                .latest_provider_status_for_turn(session.id, turn)
                .unwrap()
                .as_deref(),
            Some("done")
        );
        assert_eq!(store.read_events(session.id).unwrap().len(), count);
    }

    struct ChildGuard(std::process::Child);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    fn startup_preserves_other_process_run_then_recovers_after_force_quit() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Gyro");
        let store = SessionStore::open(GyroPaths::from_base_dir(root.clone())).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "chat")
            .unwrap();
        let turn = Uuid::new_v4();
        let ready = temp.path().join("ready");
        let mut child = ChildGuard(
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "provider_session_lifecycle::tests::lease_child_process",
                    "--nocapture",
                ])
                .env("GYRO_LEASE_TEST_ROOT", &root)
                .env("GYRO_LEASE_TEST_SESSION", session.id.to_string())
                .env("GYRO_LEASE_TEST_TURN", turn.to_string())
                .env("GYRO_LEASE_TEST_READY", &ready)
                .stdout(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !ready.exists() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "lease child exited before holding its lease"
            );
            assert!(
                std::time::Instant::now() < deadline,
                "lease child never became ready"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let count = store.read_events(session.id).unwrap().len();
        assert_eq!(reconcile_interrupted_provider_turns(&store).unwrap(), 0);
        assert_eq!(store.read_events(session.id).unwrap().len(), count);
        assert!(provider_turn_has_unfinished_attempt(&store, session.id, turn).unwrap());
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        assert_eq!(reconcile_interrupted_provider_turns(&store).unwrap(), 1);
        assert_eq!(reconcile_interrupted_provider_turns(&store).unwrap(), 0);
        assert!(!provider_turn_has_unfinished_attempt(&store, session.id, turn).unwrap());
    }

    #[test]
    fn lease_child_process() {
        let Some(root) = std::env::var_os("GYRO_LEASE_TEST_ROOT") else {
            return;
        };
        let store = SessionStore::open(GyroPaths::from_base_dir(root.into())).unwrap();
        let session = Uuid::parse_str(&std::env::var("GYRO_LEASE_TEST_SESSION").unwrap()).unwrap();
        let turn = Uuid::parse_str(&std::env::var("GYRO_LEASE_TEST_TURN").unwrap()).unwrap();
        let _lease = ProviderSessionLease::try_acquire(store.paths(), session)
            .unwrap()
            .unwrap();
        running_turn(&store, session, turn);
        fs::write(std::env::var_os("GYRO_LEASE_TEST_READY").unwrap(), b"ready").unwrap();
        loop {
            std::thread::park();
        }
    }

    #[cfg(unix)]
    #[test]
    fn legacy_live_listener_defers_recovery_but_stale_socket_does_not() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "chat")
            .unwrap();
        let turn = Uuid::new_v4();
        store
            .append_event_with_turn_id(
                session.id,
                SessionEventKind::SystemEvent,
                "old host working",
                serde_json::json!({"kind":"provider-status", "status":"running"}),
                Some(turn),
            )
            .unwrap();
        let ready = temp.path().join("legacy-ready");
        let mut child = ChildGuard(
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "provider_session_lifecycle::tests::legacy_listener_child_process",
                    "--nocapture",
                ])
                .env(
                    "GYRO_LEGACY_LISTENER_TEST_SOCKET",
                    &store.paths().socket_path,
                )
                .env("GYRO_LEGACY_LISTENER_TEST_READY", &ready)
                .stdout(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !ready.exists() {
            assert!(child.0.try_wait().unwrap().is_none());
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(reconcile_interrupted_provider_turns(&store).unwrap(), 0);
        assert!(ProviderSessionLease::for_run(&store, session.id).is_err());
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        assert!(store.paths().socket_path.exists());
        assert!(ProviderSessionLease::for_run(&store, session.id).is_ok());
        assert_eq!(reconcile_interrupted_provider_turns(&store).unwrap(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn legacy_listener_child_process() {
        let Some(socket) = std::env::var_os("GYRO_LEGACY_LISTENER_TEST_SOCKET") else {
            return;
        };
        let _listener = std::os::unix::net::UnixListener::bind(socket).unwrap();
        fs::write(
            std::env::var_os("GYRO_LEGACY_LISTENER_TEST_READY").unwrap(),
            b"ready",
        )
        .unwrap();
        loop {
            std::thread::park();
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn current_host_endpoint_does_not_block_legacy_turn_recovery() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "abandoned legacy chat")
            .unwrap();
        let turn = Uuid::new_v4();
        store
            .append_event_with_turn_id(
                session.id,
                SessionEventKind::SystemEvent,
                "old host was working",
                serde_json::json!({"kind":"provider-status", "status":"running"}),
                Some(turn),
            )
            .unwrap();
        let _listener = std::os::unix::net::UnixListener::bind(&store.paths().socket_path).unwrap();
        assert!(ProviderSessionLease::for_run(&store, session.id).is_ok());
        assert_eq!(reconcile_interrupted_provider_turns(&store).unwrap(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn lease_refuses_symlink_files_and_directories_without_touching_target() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        paths.ensure().unwrap();
        let directory = paths.base_dir.join("provider-session-leases");
        fs::create_dir(&directory).unwrap();
        let target = temp.path().join("untouched");
        fs::write(&target, b"private target").unwrap();
        let session = Uuid::new_v4();
        symlink(&target, directory.join(format!("{session}.lock"))).unwrap();
        assert!(ProviderSessionLease::try_acquire(&paths, session).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"private target");
        fs::remove_file(directory.join(format!("{session}.lock"))).unwrap();
        fs::hard_link(&target, directory.join(format!("{session}.lock"))).unwrap();
        let target_permissions = fs::metadata(&target).unwrap().permissions();
        assert!(ProviderSessionLease::try_acquire(&paths, session).is_err());
        assert_eq!(
            fs::metadata(&target).unwrap().permissions(),
            target_permissions
        );
        fs::remove_dir_all(&directory).unwrap();
        symlink(temp.path(), &directory).unwrap();
        assert!(ProviderSessionLease::try_acquire(&paths, session).is_err());
        assert!(!temp.path().join(format!("{session}.lock")).exists());
    }

    #[test]
    fn an_interrupted_turn_is_closed_so_the_chat_can_be_picked_back_up() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "chat session")
            .unwrap();
        let turn_id = Uuid::new_v4();
        store
            .append_event_with_turn_id(
                session.id,
                SessionEventKind::SystemEvent,
                "Claude is working",
                serde_json::json!({
                    "kind": "provider-status",
                    "status": "running",
                    "providerId": "anthropic",
                    "providerLabel": "Claude",
                    "modelId": "sonnet",
                    "turnId": turn_id.to_string(),
                }),
                Some(turn_id),
            )
            .unwrap();
        // This is the state a force-quit leaves behind, and it refused every
        // further attempt on the turn.
        assert!(provider_turn_has_unfinished_attempt(&store, session.id, turn_id).unwrap());

        assert_eq!(reconcile_interrupted_provider_turns(&store).unwrap(), 1);

        assert!(!provider_turn_has_unfinished_attempt(&store, session.id, turn_id).unwrap());
        let closing = store
            .read_recent_events(session.id, 32)
            .unwrap()
            .into_iter()
            .rfind(|event| event.turn_id == Some(turn_id))
            .expect("the interrupted turn is closed with an event");
        assert_eq!(closing.payload["status"], "failed");
        assert_eq!(closing.payload["recoveryKind"], "interrupted");
        // The closing event keeps the run's identity so it renders like the one
        // it replaces rather than as an anonymous failure.
        assert_eq!(closing.payload["providerLabel"], "Claude");
        assert_eq!(closing.payload["modelId"], "sonnet");
        assert_eq!(closing.message, "Claude send needs attention");

        // A second startup has nothing left to close.
        assert_eq!(reconcile_interrupted_provider_turns(&store).unwrap(), 0);
    }
}
