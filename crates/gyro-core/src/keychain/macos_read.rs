use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const HELPER_ARG: &str = "--gyro-keychain-read";
const PARENT_CHANNEL_FD: i32 = 3;
const MAX_ACCOUNT_BYTES: usize = 4096;
const MAX_REPLY_BYTES: u64 = 1024 * 1024;
const READ_DEADLINE: Duration = Duration::from_secs(3);
const ACCESS_DETAIL: &str = "Gyro could not read the saved credential from macOS Keychain without user interaction. Unlock your Mac and allow Gyro to access this credential, then send again.";

#[derive(Serialize, Deserialize)]
struct Reply {
    value: Option<String>,
    denied: bool,
}

#[link(name = "Security", kind = "framework")]
extern "C" {
    fn SecKeychainSetUserInteractionAllowed(state: u8) -> i32;
}

#[cfg(not(test))]
pub(super) fn get(account: &str) -> Result<Option<String>> {
    let mut command = Command::new(std::env::current_exe().context("locate credential reader")?);
    command.arg(HELPER_ARG);
    read_with_command(command, account, READ_DEADLINE)
}

fn read_with_command(
    mut command: Command,
    account: &str,
    deadline: Duration,
) -> Result<Option<String>> {
    if account.len() > MAX_ACCOUNT_BYTES || account.contains('\0') {
        bail!("invalid credential account");
    }
    let (_parent_channel, child_channel) =
        UnixStream::pair().context("create private credential reader channel")?;
    let channel_fd = child_channel.as_raw_fd();
    // A normal CLI/profile invocation must never turn this private protocol
    // into an API-key export command. Only this call inherits the peer channel.
    unsafe {
        command.pre_exec(move || {
            if channel_fd != PARENT_CHANNEL_FD && libc::dup2(channel_fd, PARENT_CHANNEL_FD) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::fcntl(PARENT_CHANNEL_FD, libc::F_SETFD, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    // Only the account name enters stdin. Credentials return through an
    // anonymous pipe, never process arguments, environment, files or logs.
    let mut child = command
        .process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("start isolated credential reader")?;
    drop(child_channel);
    crate::execution::register_process_group(child.id());
    let input = child.stdin.take().expect("piped stdin");
    let output = child.stdout.take().expect("piped stdout");
    // Drain while the child runs, with a strict bound, so a large credential
    // cannot fill the pipe and deadlock the parent's wait.
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        output
            .take(MAX_REPLY_BYTES + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let sent = serde_json::to_writer(input, account);
    let started = Instant::now();
    let status = if sent.is_ok() {
        loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) if started.elapsed() < deadline => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                _ => break None,
            }
        }
    } else {
        None
    };
    if status.is_none() {
        // Retire the entire group so no descendant can retain a pipe during
        // timeout cleanup. The same registry covers normal application quit.
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
        let _ = child.kill();
    }
    let _ = child.wait();
    crate::execution::unregister_process_group(child.id());
    let reply = reader.join().ok().and_then(Result::ok);
    if status.is_some_and(|status| !status.success()) {
        bail!("macOS Keychain reader failed its private protocol. Restart Gyro and send again.");
    }
    if !status.is_some_and(|status| status.success()) {
        bail!("{ACCESS_DETAIL}");
    }
    let bytes = reply
        .filter(|bytes| bytes.len() as u64 <= MAX_REPLY_BYTES)
        .context("invalid credential reader response")?;
    // Never include malformed response bytes or serializer errors in a log.
    let reply: Reply = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("invalid credential reader response"))?;
    if reply.denied {
        bail!("{ACCESS_DETAIL}");
    }
    Ok(reply.value)
}

pub(super) fn run_helper() -> Option<i32> {
    let args = std::env::args_os().collect::<Vec<_>>();
    if args.len() != 2 || args[1] != HELPER_ARG {
        return None;
    }
    // This mode is only a pipe protocol; it must never print a key to a terminal.
    if unsafe { libc::isatty(libc::STDIN_FILENO) != 0 || libc::isatty(libc::STDOUT_FILENO) != 0 } {
        return Some(2);
    }
    if !has_trusted_parent_channel() {
        return Some(2);
    }
    let mut parent_channel = unsafe { UnixStream::from_raw_fd(PARENT_CHANNEL_FD) };
    std::thread::spawn(move || {
        let _ = parent_channel.read(&mut [0u8; 1]);
        // The channel is deliberately silent. EOF means the owning reader
        // died (including a hard app crash); never leave a Keychain child behind.
        unsafe {
            libc::_exit(3);
        }
    });
    let account: String = match serde_json::from_reader::<_, String>(
        std::io::stdin().take(MAX_ACCOUNT_BYTES as u64 + 16),
    ) {
        Ok(account) if account.len() <= MAX_ACCOUNT_BYTES && !account.contains('\0') => account,
        _ => return Some(2),
    };
    // Per-query no-auth flags do not suppress UI for the file-based Keychain
    // used by keyring. Set the legacy policy ONLY inside this disposable child.
    // The parent retains its normal policy for explicit Settings writes.
    if unsafe { SecKeychainSetUserInteractionAllowed(0) } != 0 {
        return Some(3);
    }
    let reply = match super::get_api_key_direct(&account) {
        Ok(value)
            if value
                .as_ref()
                .is_none_or(|value| value.len() < MAX_REPLY_BYTES as usize / 2) =>
        {
            Reply {
                value,
                denied: false,
            }
        }
        _ => Reply {
            value: None,
            denied: true,
        },
    };
    let mut stdout = std::io::stdout().lock();
    Some(
        if serde_json::to_writer(&mut stdout, &reply).is_ok() && stdout.flush().is_ok() {
            0
        } else {
            3
        },
    )
}

fn has_trusted_parent_channel() -> bool {
    let mut peer: libc::pid_t = 0;
    let mut length = std::mem::size_of_val(&peer) as libc::socklen_t;
    let parent = unsafe { libc::getppid() };
    // Socket peer identity comes from the kernel, rather than argv or an
    // environment variable a workspace command could copy.
    if parent <= 1
        || unsafe {
            libc::getsockopt(
                PARENT_CHANNEL_FD,
                libc::SOL_LOCAL,
                libc::LOCAL_PEERPID,
                (&mut peer as *mut libc::pid_t).cast(),
                &mut length,
            )
        } != 0
        || peer != parent
    {
        return false;
    }
    let Ok(executable) = std::env::current_exe() else {
        return false;
    };
    let mut path = [0u8; 4096];
    let length = unsafe { libc::proc_pidpath(parent, path.as_mut_ptr().cast(), path.len() as u32) };
    if length <= 0 {
        return false;
    }
    let end = path
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(path.len());
    &path[..end] == executable.as_os_str().as_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    }

    #[test]
    fn reader_bounds_stalls_and_preserves_access_errors() {
        let start = Instant::now();
        let result = read_with_command(shell("sleep 10"), "fixture", Duration::from_millis(30));
        assert!(start.elapsed() < Duration::from_secs(1));
        assert_eq!(result.unwrap_err().to_string(), ACCESS_DETAIL);
        let result = read_with_command(
            shell("printf '%s' '{\"value\":null,\"denied\":true}'"),
            "fixture",
            READ_DEADLINE,
        );
        assert_eq!(result.unwrap_err().to_string(), ACCESS_DETAIL);
    }

    #[test]
    fn reader_distinguishes_absence_and_never_reports_malformed_secret_bytes() {
        assert_eq!(
            read_with_command(
                shell("printf '%s' '{\"value\":null,\"denied\":false}'"),
                "fixture",
                READ_DEADLINE
            )
            .unwrap(),
            None
        );
        assert_eq!(
            read_with_command(
                shell("printf '%s' '{\"value\":\"fixture-key\",\"denied\":false}'"),
                "fixture",
                READ_DEADLINE
            )
            .unwrap()
            .as_deref(),
            Some("fixture-key")
        );
        let error = read_with_command(
            shell("printf '%s' secret-fixture"),
            "fixture",
            READ_DEADLINE,
        )
        .unwrap_err()
        .to_string();
        assert!(!error.contains("secret-fixture"));
    }
}
