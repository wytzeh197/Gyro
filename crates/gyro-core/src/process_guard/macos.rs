use std::{
    collections::HashMap,
    fs::File,
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{ffi::OsStrExt, net::UnixStream, process::CommandExt},
    },
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

const HELPER_ARG: &str = "--gyro-process-crash-helper";
const CHANNEL_FD: i32 = 3;
const LEASE_FD: i32 = 4;
const READY: u8 = 0x47;
const ARMED: u8 = 0x41;
const REJECTED: u8 = 0x52;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(2);

const ARM: u8 = 1;
const RELEASE: u8 = 2;
const FRAME_BYTES: usize = 13;
const MAX_GROUPS: usize = 64;
static NEXT_REGISTRATION: AtomicU64 = AtomicU64::new(1);

pub(super) struct Watchdog {
    inner: Mutex<Guardian>,
}
struct Guardian {
    channel: Option<UnixStream>,
    helper: Child,
}
impl Watchdog {
    pub(super) fn start(lease: Option<&File>) -> io::Result<Arc<Self>> {
        let (mut parent, helper_channel) = UnixStream::pair()?;
        parent.set_read_timeout(Some(STARTUP_TIMEOUT))?;
        parent.set_write_timeout(Some(STARTUP_TIMEOUT))?;
        let source_channel = duplicate_high(helper_channel.as_raw_fd())?;
        let source_lease = lease
            .map(|file| duplicate_high(file.as_raw_fd()))
            .transpose()?;
        let channel_fd = source_channel.as_raw_fd();
        let lease_fd = source_lease.as_ref().map(AsRawFd::as_raw_fd);
        let mut helper_command = Command::new(std::env::current_exe()?);
        #[cfg(not(test))]
        helper_command.args([
            HELPER_ARG,
            if lease_fd.is_some() { "lease" } else { "none" },
        ]);
        #[cfg(test)]
        helper_command
            .args([
                "--exact",
                "process_guard::macos::tests::helper_entrypoint",
                "--nocapture",
            ])
            .env(
                "GYRO_PROCESS_GUARD_TEST_LEASE",
                if lease_fd.is_some() { "1" } else { "0" },
            );
        helper_command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0);
        for (key, _) in
            crate::credentials::CredentialPolicy::for_provider("process-guard").env_overrides()
        {
            helper_command.env_remove(key);
        }
        unsafe {
            helper_command.pre_exec(move || {
                map_inherited(channel_fd, CHANNEL_FD)?;
                if let Some(fd) = lease_fd {
                    map_inherited(fd, LEASE_FD)?;
                }
                Ok(())
            });
        }
        let helper = helper_command.spawn()?;
        let mut guardian = Guardian {
            channel: None,
            helper,
        };
        drop(helper_channel);
        let mut ready = [0];
        parent.read_exact(&mut ready)?;
        if ready != [READY] {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "process watchdog did not become ready",
            ));
        }
        guardian.channel = Some(parent);
        Ok(Arc::new(Self {
            inner: Mutex::new(guardian),
        }))
    }
    pub(super) fn spawn(&self, command: &mut Command) -> io::Result<(Child, u64)> {
        // Serialize only registration/exec handshakes, never command execution.
        let mut guardian = self
            .inner
            .lock()
            .map_err(|_| io::Error::other("process watchdog state unavailable"))?;
        if guardian.helper.try_wait()?.is_some() {
            return Err(io::Error::other("process watchdog exited"));
        }
        let generation = NEXT_REGISTRATION
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                value.checked_add(1)
            })
            .map_err(|_| io::Error::other("process registration exhausted"))?;
        let fd = guardian.channel.as_ref().unwrap().as_raw_fd();
        let owner = unsafe { libc::getpid() };
        unsafe {
            command.pre_exec(move || {
                if libc::getppid() != owner {
                    return Err(io::Error::from_raw_os_error(libc::ECANCELED));
                }
                if libc::setpgid(0, 0) != 0 {
                    return Err(io::Error::last_os_error());
                }
                write_raw(fd, &frame(ARM, libc::getpid(), generation))?;
                let mut reply = [0];
                read_raw(fd, &mut reply)?;
                if reply != [ARMED] {
                    return Err(io::Error::from_raw_os_error(libc::ECANCELED));
                }
                Ok(())
            });
        }
        match command.spawn() {
            Ok(child) => Ok((child, generation)),
            Err(error) => {
                let _ = guardian.release(0, generation);
                Err(error)
            }
        }
    }
    pub(super) fn release(&self, pid: i32, generation: u64) -> io::Result<()> {
        self.inner
            .lock()
            .map_err(|_| io::Error::other("process watchdog state unavailable"))?
            .release(pid, generation)
    }
}
impl Guardian {
    fn release(&mut self, pid: i32, generation: u64) -> io::Result<()> {
        let channel = self.channel.as_mut().unwrap();
        channel.write_all(&frame(RELEASE, pid, generation))?;
        let mut reply = [0];
        channel.read_exact(&mut reply)?;
        if reply != [ARMED] {
            return Err(io::Error::from_raw_os_error(libc::ECANCELED));
        }
        Ok(())
    }
}
impl Drop for Guardian {
    fn drop(&mut self) {
        drop(self.channel.take());
        let deadline = Instant::now() + Duration::from_secs(1);
        while Instant::now() < deadline {
            match self.helper.try_wait() {
                Ok(Some(_)) => return,
                Err(_) => break,
                Ok(None) => {}
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        let _ = self.helper.kill();
        let _ = self.helper.wait();
    }
}
fn frame(operation: u8, pid: i32, generation: u64) -> [u8; FRAME_BYTES] {
    let mut bytes = [0; FRAME_BYTES];
    bytes[0] = operation;
    bytes[1..5].copy_from_slice(&pid.to_ne_bytes());
    bytes[5..].copy_from_slice(&generation.to_ne_bytes());
    bytes
}

fn duplicate_high(fd: i32) -> io::Result<OwnedFd> {
    let duplicated = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 10) };
    if duplicated < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(duplicated) })
}
unsafe fn map_inherited(source: i32, target: i32) -> io::Result<()> {
    if libc::dup2(source, target) < 0 || libc::fcntl(target, libc::F_SETFD, 0) < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
unsafe fn write_raw(fd: i32, mut bytes: &[u8]) -> io::Result<()> {
    while !bytes.is_empty() {
        let count = libc::write(fd, bytes.as_ptr().cast(), bytes.len());
        if count < 0 {
            if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(io::Error::last_os_error());
        }
        if count == 0 {
            return Err(io::Error::from_raw_os_error(libc::EPIPE));
        }
        bytes = &bytes[count as usize..];
    }
    Ok(())
}
unsafe fn read_raw(fd: i32, mut bytes: &mut [u8]) -> io::Result<()> {
    while !bytes.is_empty() {
        let count = libc::read(fd, bytes.as_mut_ptr().cast(), bytes.len());
        if count < 0 {
            if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(io::Error::last_os_error());
        }
        if count == 0 {
            return Err(io::Error::from_raw_os_error(libc::EPIPE));
        }
        bytes = &mut bytes[count as usize..];
    }
    Ok(())
}

pub(super) fn run_entrypoint() -> Option<i32> {
    let args = std::env::args_os().collect::<Vec<_>>();
    if args.get(1).map_or(true, |arg| arg != HELPER_ARG) {
        return None;
    }
    if args.len() != 3 || (args[2] != "lease" && args[2] != "none") {
        return Some(2);
    }
    Some(run_body(args[2] == "lease").map(|_| 0).unwrap_or(3))
}

fn trusted_parent() -> Option<i32> {
    let parent = unsafe { libc::getppid() };
    let mut peer: libc::pid_t = 0;
    let mut length = std::mem::size_of_val(&peer) as libc::socklen_t;
    if parent <= 1
        || unsafe {
            libc::getsockopt(
                CHANNEL_FD,
                libc::SOL_LOCAL,
                libc::LOCAL_PEERPID,
                (&mut peer as *mut libc::pid_t).cast(),
                &mut length,
            )
        } != 0
        || peer != parent
    {
        return None;
    }
    let executable = std::env::current_exe().ok()?;
    let mut path = [0u8; 4096];
    if unsafe { libc::proc_pidpath(parent, path.as_mut_ptr().cast(), path.len() as u32) } <= 0 {
        return None;
    }
    let end = path
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(path.len());
    (&path[..end] == executable.as_os_str().as_bytes()).then_some(parent)
}

struct WatchedGroup {
    pid: i32,
    generation: u64,
    started: (u64, u64),
}
fn process_info(pid: i32) -> Option<libc::proc_bsdinfo> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of_val(&info) as i32;
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    (read == size && info.pbi_pid == pid as u32).then_some(info)
}
fn owned_provider_group(owner: i32, pid: i32) -> bool {
    pid > 1
        && unsafe { libc::getpgid(pid) } == pid
        && process_info(pid).is_some_and(|info| info.pbi_ppid == owner as u32)
}
impl WatchedGroup {
    fn current(&self) -> bool {
        process_info(self.pid).map_or(true, |info| {
            (info.pbi_start_tvsec, info.pbi_start_tvusec) == self.started
        })
    }
    fn signal(&self, signal: i32) {
        if self.current() {
            unsafe {
                libc::kill(-self.pid, signal);
            }
        }
    }
    fn exists(&self) -> bool {
        self.current()
            && (unsafe { libc::kill(-self.pid, 0) } == 0
                || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH))
    }
}
fn clean_groups(groups: impl Iterator<Item = WatchedGroup>) {
    let groups = groups.collect::<Vec<_>>();
    for group in &groups {
        group.signal(libc::SIGTERM);
    }
    let deadline = Instant::now() + Duration::from_millis(250);
    while Instant::now() < deadline {
        if groups.iter().all(|group| !group.exists()) {
            return;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    for group in &groups {
        group.signal(libc::SIGKILL);
    }
}
struct Registrations(HashMap<i32, WatchedGroup>);
impl Drop for Registrations {
    fn drop(&mut self) {
        clean_groups(self.0.drain().map(|(_, group)| group));
    }
}

fn event(ident: usize, filter: i16, fflags: u32) -> libc::kevent {
    libc::kevent {
        ident,
        filter,
        flags: libc::EV_ADD | libc::EV_ONESHOT,
        fflags,
        data: 0,
        udata: std::ptr::null_mut(),
    }
}
fn register(queue: &OwnedFd, changes: &[libc::kevent]) -> io::Result<()> {
    if unsafe {
        libc::kevent(
            queue.as_raw_fd(),
            changes.as_ptr(),
            changes.len() as i32,
            std::ptr::null_mut(),
            0,
            std::ptr::null(),
        )
    } < 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn run_body(has_lease: bool) -> io::Result<()> {
    let owner = trusted_parent().ok_or_else(|| io::Error::from_raw_os_error(libc::EPERM))?;
    let owner_started =
        process_info(owner).ok_or_else(|| io::Error::from_raw_os_error(libc::ESRCH))?;
    let mut channel = unsafe { UnixStream::from_raw_fd(CHANNEL_FD) };
    channel.set_nonblocking(true)?;
    let _lease = if has_lease {
        Some(unsafe { File::from_raw_fd(LEASE_FD) })
    } else {
        None
    };
    let fd = unsafe { libc::kqueue() };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let queue = unsafe { OwnedFd::from_raw_fd(fd) };
    let mut read_event = event(channel.as_raw_fd() as usize, libc::EVFILT_READ, 0);
    read_event.flags = libc::EV_ADD;
    register(
        &queue,
        &[
            event(owner as usize, libc::EVFILT_PROC, libc::NOTE_EXIT),
            read_event,
        ],
    )?;
    let mut groups = Registrations(HashMap::new());
    channel.write_all(&[READY])?;
    let mut bytes = [0; FRAME_BYTES];
    let mut buffered = 0;
    loop {
        let mut observed: libc::kevent = unsafe { std::mem::zeroed() };
        let count = unsafe {
            libc::kevent(
                queue.as_raw_fd(),
                std::ptr::null(),
                0,
                &mut observed,
                1,
                std::ptr::null(),
            )
        };
        if count < 0 {
            if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(io::Error::last_os_error());
        }
        if count == 0 {
            continue;
        }
        if observed.flags & libc::EV_ERROR != 0 {
            return Err(io::Error::from_raw_os_error(observed.data as i32));
        }
        if observed.filter == libc::EVFILT_PROC {
            if observed.ident == owner as usize {
                return Ok(());
            }
            if let Some(group) = groups.0.remove(&(observed.ident as i32)) {
                clean_groups(std::iter::once(group));
            }
            continue;
        }
        match channel.read(&mut bytes[buffered..]) {
            Ok(0) => return Ok(()),
            Ok(count) => buffered += count,
            Err(error)
                if error.kind() == io::ErrorKind::WouldBlock
                    || error.kind() == io::ErrorKind::Interrupted =>
            {
                continue
            }
            Err(error) => return Err(error),
        }
        if buffered != FRAME_BYTES {
            continue;
        }
        buffered = 0;
        let pid = i32::from_ne_bytes(bytes[1..5].try_into().unwrap());
        let generation = u64::from_ne_bytes(bytes[5..].try_into().unwrap());
        if generation == 0 {
            return Err(io::Error::from_raw_os_error(libc::EINVAL));
        }
        match bytes[0] {
            ARM => {
                let live_owner = process_info(owner).is_some_and(|info| {
                    info.pbi_status != libc::SZOMB
                        && (info.pbi_start_tvsec, info.pbi_start_tvusec)
                            == (
                                owner_started.pbi_start_tvsec,
                                owner_started.pbi_start_tvusec,
                            )
                });
                if !live_owner {
                    return Err(io::Error::from_raw_os_error(libc::ECANCELED));
                }
                if !owned_provider_group(owner, pid)
                    || groups.0.contains_key(&pid)
                    || groups.0.len() >= MAX_GROUPS
                {
                    channel.write_all(&[REJECTED])?;
                    continue;
                }
                let info =
                    process_info(pid).ok_or_else(|| io::Error::from_raw_os_error(libc::ESRCH))?;
                let group = WatchedGroup {
                    pid,
                    generation,
                    started: (info.pbi_start_tvsec, info.pbi_start_tvusec),
                };
                groups.0.insert(pid, group);
                register(
                    &queue,
                    &[event(pid as usize, libc::EVFILT_PROC, libc::NOTE_EXIT)],
                )?;
            }
            RELEASE => {
                let matched = groups.0.iter().find_map(|(key, group)| {
                    (group.generation == generation && (pid == 0 || pid == *key)).then_some(*key)
                });
                if let Some(key) = matched {
                    let group = groups.0.remove(&key).unwrap();
                    let removal = libc::kevent {
                        flags: libc::EV_DELETE,
                        ..event(key as usize, libc::EVFILT_PROC, 0)
                    };
                    let _ = register(&queue, &[removal]);
                    clean_groups(std::iter::once(group));
                }
            }
            _ => return Err(io::Error::from_raw_os_error(libc::EINVAL)),
        }
        channel.write_all(&[ARMED])?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::execution::{run_command, CancellationToken, ExecutionRequest};

    struct FixtureOwner(Child);
    impl Drop for FixtureOwner {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    fn owner_force_quit_stops_term_ignoring_group_and_keeps_lease_until_cleanup() {
        let temp = tempfile::tempdir().unwrap();
        let ready = temp.path().join("ready");
        let lease = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(temp.path().join("lease"))
            .unwrap();
        let mut owner = FixtureOwner(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "process_guard::macos::tests::owner_entrypoint",
                    "--nocapture",
                ])
                .env("GYRO_PROCESS_GUARD_TEST_ROOT", temp.path())
                .stdout(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        while !ready.exists() {
            assert!(
                owner.0.try_wait().unwrap().is_none(),
                "owner fixture exited before readiness"
            );
            assert!(
                Instant::now() < deadline,
                "owner fixture readiness timed out"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let pids = std::fs::read_to_string(&ready)
            .unwrap()
            .split_whitespace()
            .map(|value| value.parse::<i32>().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(pids.len(), 4);
        let groups = pids
            .iter()
            .map(|pid| unsafe { libc::getpgid(*pid) })
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            groups.len(),
            2,
            "the fixture must have two distinct process groups"
        );
        assert_eq!(
            unsafe { libc::flock(lease.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            -1
        );
        let fd = unsafe { libc::kqueue() };
        assert!(fd >= 0);
        let queue = unsafe { OwnedFd::from_raw_fd(fd) };
        let changes = pids
            .iter()
            .map(|pid| event(*pid as usize, libc::EVFILT_PROC, libc::NOTE_EXIT))
            .collect::<Vec<_>>();
        register(&queue, &changes).unwrap();
        owner.0.kill().unwrap();
        owner.0.wait().unwrap();
        // Both mocks ignore SIGTERM, forcing the bounded escalation path. The
        // host is dead but its watchdog still owns the lease during that grace.
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(
            unsafe { libc::flock(lease.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            -1
        );
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut exited = std::collections::BTreeSet::new();
        while exited.len() != 4 {
            assert!(
                Instant::now() < deadline,
                "watchdog did not stop the owned group"
            );
            let mut observed: libc::kevent = unsafe { std::mem::zeroed() };
            let timeout = libc::timespec {
                tv_sec: 0,
                tv_nsec: 100_000_000,
            };
            let count = unsafe {
                libc::kevent(
                    queue.as_raw_fd(),
                    std::ptr::null(),
                    0,
                    &mut observed,
                    1,
                    &timeout,
                )
            };
            assert!(count >= 0);
            if count > 0 {
                assert_eq!(observed.filter, libc::EVFILT_PROC);
                assert_ne!(observed.fflags & libc::NOTE_EXIT, 0);
                exited.insert(observed.ident as i32);
            }
        }
        assert_eq!(exited.into_iter().collect::<Vec<_>>(), {
            let mut sorted = pids;
            sorted.sort_unstable();
            sorted
        });
        let deadline = Instant::now() + Duration::from_secs(1);
        while unsafe { libc::flock(lease.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            assert!(
                Instant::now() < deadline,
                "watchdog retained a completed lease"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!temp.path().join("unexpected-write").exists());
    }

    #[test]
    fn owner_entrypoint() {
        let Some(root) = std::env::var_os("GYRO_PROCESS_GUARD_TEST_ROOT") else {
            return;
        };
        super::super::enable_crash_cleanup();
        let root = std::path::PathBuf::from(root);
        let lease = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(root.join("lease"))
            .unwrap();
        assert_eq!(
            unsafe { libc::flock(lease.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        let _scope = super::super::ProcessLeaseScope::bind(&lease).unwrap();
        // Reuse an idle watchdog after a completed first command, then share
        // it with a capability-style worker running concurrently with the model.
        run_command(
            ExecutionRequest::new("/usr/bin/true"),
            CancellationToken::default(),
            |_| {},
        )
        .unwrap();
        let owner = _scope.owner();
        let pids = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let worker_root = root.clone();
        let worker_pids = pids.clone();
        let worker_owner = owner.clone();
        std::thread::spawn(move || {
            let _entered = worker_owner.enter();
            run_owned_fixture_group(worker_root, worker_pids);
        });
        run_owned_fixture_group(root, pids);
    }

    fn run_owned_fixture_group(root: std::path::PathBuf, pids: Arc<Mutex<Vec<i32>>>) {
        let mut request = ExecutionRequest::new("/bin/sh");
        request.args = ["-c", "trap '' TERM; printf 'pid:%s\\n' \"$$\"; /bin/sh -c 'trap \"\" TERM; printf \"pid:%s\\n\" \"$$\"; sleep 2; printf forbidden > \"$GYRO_GUARD_WRITE\"; sleep 30' & wait"].into_iter().map(Into::into).collect();
        request.env.push((
            "GYRO_GUARD_WRITE".into(),
            Some(root.join("unexpected-write").into_os_string()),
        ));
        let mut buffer = String::new();
        run_command(request, CancellationToken::default(), |chunk| {
            buffer.push_str(&chunk.text);
            while let Some(index) = buffer.find('\n') {
                let line = buffer[..index].to_string();
                buffer.drain(..=index);
                if let Some(pid) = line.strip_prefix("pid:") {
                    let mut pids = pids.lock().unwrap();
                    pids.push(pid.parse::<i32>().unwrap());
                    if pids.len() == 4 {
                        let content = pids
                            .iter()
                            .map(i32::to_string)
                            .collect::<Vec<_>>()
                            .join(" ");
                        std::fs::write(root.join("ready"), content).unwrap();
                    }
                }
            }
        })
        .unwrap();
    }

    #[test]
    fn helper_rejects_untrusted_parent_and_invalid_group() {
        assert!(trusted_parent().is_none());
        let watchdog = Watchdog::start(None).unwrap();
        let mut guardian = watchdog.inner.lock().unwrap();
        let channel = guardian.channel.as_mut().unwrap();
        channel.write_all(&frame(ARM, 0, 1)).unwrap();
        let mut response = [0];
        channel.read_exact(&mut response).unwrap();
        assert_eq!(response, [REJECTED]);
        assert!(guardian.helper.try_wait().unwrap().is_none());
    }

    #[test]
    fn ownership_requires_a_direct_child_in_its_own_group() {
        let mut command = Command::new("/bin/sleep");
        command.arg("30").process_group(0);
        let mut child = FixtureOwner(command.spawn().unwrap());
        let pid = child.0.id() as i32;
        let owner = unsafe { libc::getpid() };
        assert!(owned_provider_group(owner, pid));
        assert!(!owned_provider_group(owner + 1, pid));
        assert!(!owned_provider_group(owner, owner));
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        assert!(!owned_provider_group(owner, pid));
    }

    #[test]
    fn spawn_failure_reaps_watchdog_without_a_provider() {
        let mut command = Command::new("/gyro-nonexistent-provider-fixture");
        let watchdog = Watchdog::start(None).unwrap();
        let pid = watchdog.inner.lock().unwrap().helper.id() as i32;
        assert!(watchdog.spawn(&mut command).is_err());
        drop(watchdog);
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
    }

    #[test]
    fn completed_commands_and_workers_reuse_one_watchdog_without_stopping_other_groups() {
        let owner = super::super::ProcessOwner::unleased();
        let watchdog = owner.watchdog().unwrap();
        let helper = watchdog.inner.lock().unwrap().helper.id();
        let mut model_command = Command::new("/bin/sleep");
        model_command.arg("30");
        let mut model = super::super::spawn_with_owner(&mut model_command, &owner).unwrap();
        let model_generation = model.watchdog.as_ref().unwrap().1;
        let worker_owner = owner.clone();
        std::thread::spawn(move || {
            let _entered = worker_owner.enter();
            let entered = super::super::OWNER_SCOPE
                .with(|slot| slot.borrow().clone())
                .unwrap();
            for _ in 0..8 {
                let mut command = Command::new("/usr/bin/true");
                let mut child = super::super::spawn_with_owner(&mut command, &entered).unwrap();
                assert!(child.wait().unwrap().success());
                drop(child);
                assert_eq!(
                    entered
                        .watchdog()
                        .unwrap()
                        .inner
                        .lock()
                        .unwrap()
                        .helper
                        .id(),
                    helper
                );
            }
            let mut missing = Command::new("/gyro-nonexistent-provider-fixture");
            assert!(super::super::spawn_with_owner(&mut missing, &entered).is_err());
            let mut next = Command::new("/usr/bin/true");
            assert!(super::super::spawn_with_owner(&mut next, &entered)
                .unwrap()
                .wait()
                .unwrap()
                .success());
        })
        .join()
        .unwrap();
        watchdog
            .release(model.id() as i32, model_generation + 1)
            .unwrap();
        assert!(
            model.try_wait().unwrap().is_none(),
            "another generation cannot release the model"
        );
        drop(model);
        assert!(watchdog
            .inner
            .lock()
            .unwrap()
            .helper
            .try_wait()
            .unwrap()
            .is_none());
    }

    #[test]
    fn nested_scopes_are_isolated_and_restore_the_previous_owner() {
        let outer = super::super::ProcessLeaseScope::unleased();
        let first = outer.owner().watchdog().unwrap();
        {
            let inner = super::super::ProcessLeaseScope::unleased();
            let second = inner.owner().watchdog().unwrap();
            assert!(!Arc::ptr_eq(&first, &second));
        }
        let restored = super::super::OWNER_SCOPE
            .with(|slot| slot.borrow().clone())
            .unwrap();
        assert!(Arc::ptr_eq(&first, &restored.watchdog().unwrap()));
    }

    #[test]
    fn idle_scope_keeps_lease_until_last_owner_and_watchdog_are_reaped() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("lease");
        let lease = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        assert_eq!(
            unsafe { libc::flock(lease.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        let scope = super::super::ProcessLeaseScope::bind(&lease).unwrap();
        drop(lease);
        let probe = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        let owner = scope.owner();
        let watchdog = owner.watchdog().unwrap();
        let helper = watchdog.inner.lock().unwrap().helper.id() as i32;
        let mut command = Command::new("/usr/bin/true");
        let mut child = super::super::spawn_with_owner(&mut command, &owner).unwrap();
        child.wait().unwrap();
        drop(child);
        assert_eq!(
            unsafe { libc::flock(probe.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            -1
        );
        drop(watchdog);
        drop(owner);
        drop(scope);
        assert_eq!(unsafe { libc::kill(helper, 0) }, -1);
        assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
        assert_eq!(
            unsafe { libc::flock(probe.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
    }

    #[test]
    fn persistent_service_survives_model_scope_and_releases_its_process_on_drop() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("lease");
        let lease = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        assert_eq!(
            unsafe { libc::flock(lease.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        let model = super::super::ProcessLeaseScope::bind(&lease).unwrap();
        drop(lease);
        let mut command = Command::new("/bin/sleep");
        command.arg("30");
        let mut service = super::super::spawn_service_with_cleanup(&mut command, true).unwrap();
        let pid = service.id() as i32;
        let helper = service
            .watchdog
            .as_ref()
            .unwrap()
            .0
            .inner
            .lock()
            .unwrap()
            .helper
            .id() as i32;
        drop(model);
        let probe = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        assert_eq!(
            unsafe { libc::flock(probe.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0,
            "a persistent service must not keep the model's lease"
        );
        assert!(
            service.try_wait().unwrap().is_none(),
            "service persists after model completion"
        );
        drop(service);
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert_eq!(unsafe { libc::kill(helper, 0) }, -1);
    }

    #[test]
    fn helper_entrypoint() {
        let Some(value) = std::env::var_os("GYRO_PROCESS_GUARD_TEST_LEASE") else {
            return;
        };
        std::process::exit(super::run_body(value == "1").map(|_| 0).unwrap_or(3));
    }
}
