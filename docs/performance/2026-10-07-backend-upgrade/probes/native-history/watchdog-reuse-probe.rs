use std::{fs, process::{Command, Stdio}, path::PathBuf, time::{Duration, Instant}};
use std::os::fd::AsRawFd;
use gyro_core::execution::{run_command, CancellationToken, ExecutionRequest};
extern "C" { fn kill(pid: i32, signal: i32) -> i32; fn getpgid(pid: i32) -> i32; fn flock(fd: i32, operation: i32) -> i32; }
struct OwnedGroup { owner: std::process::Child, group: Option<i32> }
impl Drop for OwnedGroup { fn drop(&mut self) {
    if let Some(pid) = self.group { if unsafe { getpgid(pid) } == pid { unsafe { kill(-pid, 9); } } }
    let _ = self.owner.kill(); let _ = self.owner.wait();
} }
fn main() {
    if let Some(code) = gyro_core::process_guard::run_crash_helper() { std::process::exit(code); }
    let args: Vec<_> = std::env::args_os().collect();
    if args.get(1).map(|s| s == "benchmark-guarded" || s == "benchmark-plain" || s == "benchmark-pooled").unwrap_or(false) {
        if args[1] == "benchmark-guarded" || args[1] == "benchmark-pooled" { gyro_core::process_guard::enable_crash_cleanup(); }
        let _scope = if args[1] == "benchmark-pooled" { Some(gyro_core::process_guard::ProcessLeaseScope::unleased()) } else { None };
        let mut times = Vec::new();
        for _ in 0..20 {
            let started = Instant::now();
            let result = run_command(ExecutionRequest::new("/usr/bin/true"), CancellationToken::default(), |_| {}).unwrap();
            assert!(result.succeeded());
            times.push(started.elapsed().as_micros());
        }
        println!("{:?}", times);
        return;
    }
    if args.get(1).map(|s| s == "owner").unwrap_or(false) {
        gyro_core::process_guard::enable_crash_cleanup();
        let root = PathBuf::from(&args[2]);
        let lease = fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(root.join("lease")).unwrap();
        assert_eq!(unsafe { flock(lease.as_raw_fd(), 2 | 4) }, 0);
        let _lease_scope = gyro_core::process_guard::ProcessLeaseScope::bind(&lease).unwrap();
        let mut request = ExecutionRequest::new("/bin/sh");
        request.args = ["-c", "printf '%s\\n' \"$$\"; sleep 2; printf 'owned fixture only' > \"$GYRO_ORPHAN_MARKER\"; sleep 30"].into_iter().map(Into::into).collect();
        request.env.push(("GYRO_ORPHAN_MARKER".into(), Some(root.join("after-owner-exit").into_os_string())));
        request.credentials = gyro_core::credentials::CredentialPolicy::for_provider("probe-no-provider");
        run_command(request, CancellationToken::default(), |chunk| {
            if let Ok(pid) = chunk.text.trim().parse::<i32>() { fs::write(root.join("ready"), pid.to_string()).unwrap(); }
        }).unwrap();
        return;
    }
    let root = PathBuf::from(&args[1]);
    fs::create_dir(&root).unwrap();
    let mut owned = OwnedGroup { owner: Command::new(std::env::current_exe().unwrap()).arg("owner").arg(&root).stdout(Stdio::null()).spawn().unwrap(), group: None };
    let deadline = Instant::now() + Duration::from_secs(10);
    while !root.join("ready").exists() {
        assert!(owned.owner.try_wait().unwrap().is_none());
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    let pid: i32 = fs::read_to_string(root.join("ready")).unwrap().parse().unwrap();
    assert_eq!(unsafe { getpgid(pid) }, pid);
    owned.group = Some(pid);
    owned.owner.kill().unwrap(); owned.owner.wait().unwrap();
    std::thread::sleep(Duration::from_millis(2400));
    let alive = unsafe { kill(pid, 0) } == 0;
    let wrote = root.join("after-owner-exit").exists();
    println!("{{\"ownerForceQuit\":true,\"childAliveAfterCleanupGrace\":{alive},\"childWroteFixtureAfterOwnerExit\":{wrote},\"providerAccountsUsed\":false,\"groupCleanupOwned\":true}}");
}
