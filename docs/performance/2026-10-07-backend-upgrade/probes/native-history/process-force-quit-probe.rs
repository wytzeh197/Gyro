use std::{fs, process::{Command, Stdio}, path::PathBuf, time::{Duration, Instant}};
use gyro_core::execution::{run_command, CancellationToken, ExecutionRequest};
extern "C" { fn kill(pid: i32, signal: i32) -> i32; fn getpgid(pid: i32) -> i32; }
struct OwnedGroup { owner: std::process::Child, group: Option<i32> }
impl Drop for OwnedGroup { fn drop(&mut self) {
    if let Some(pid) = self.group { if unsafe { getpgid(pid) } == pid { unsafe { kill(-pid, 9); } } }
    let _ = self.owner.kill(); let _ = self.owner.wait();
} }
fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    if args.get(1).map(|s| s == "owner").unwrap_or(false) {
        let root = PathBuf::from(&args[2]);
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
    let alive = unsafe { kill(pid, 0) } == 0;
    std::thread::sleep(Duration::from_millis(2400));
    let wrote = root.join("after-owner-exit").exists();
    println!("{{\"ownerForceQuit\":true,\"childAliveAfterOwnerExit\":{alive},\"childWroteFixtureAfterOwnerExit\":{wrote},\"providerAccountsUsed\":false,\"groupCleanupOwned\":true}}");
}
