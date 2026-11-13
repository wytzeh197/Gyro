//! Legacy login-Keychain compatibility with isolated, noninteractive access.
//! Never change the main process interaction policy or a credential ACL.
#![cfg_attr(test, allow(dead_code))]
use super::AuthError;
use crate::keychain::macos_read::{
    disable_interaction, exchange_with_command, has_trusted_parent_channel,
};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    os::fd::FromRawFd,
    os::unix::net::UnixStream,
    process::Command,
    time::Duration,
};
const ARG: &str = "--gyro-cloud-keychain";
const SERVICE: &str = "dev.gyro.cloud.refresh";
const LIMIT: u64 = 8192;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    account: String,
    operation: Operation,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "kebab-case")]
enum Operation {
    Load,
    TakeForReconnect,
    Save(String),
    Clear,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    value: Option<String>,
    failed: bool,
}
fn valid(r: &Request) -> bool {
    r.account.starts_with("supabase:")
        && r.account.len() <= 256
        && r.account
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b':' || b == b'-')
        && match &r.operation {
            Operation::Save(v) => v.len() <= 4096,
            _ => true,
        }
}
fn request(account: &str, operation: Operation) -> Result<Option<String>, AuthError> {
    let request = Request {
        account: account.into(),
        operation,
    };
    if !valid(&request) {
        return Err(AuthError::Storage);
    }
    let mut command = Command::new(std::env::current_exe().map_err(|_| AuthError::Storage)?);
    command.arg(ARG);
    let input = serde_json::to_vec(&request).map_err(|_| AuthError::Storage)?;
    let deadline = if matches!(request.operation, Operation::TakeForReconnect) {
        30
    } else {
        3
    };
    let bytes = exchange_with_command(command, &input, Duration::from_secs(deadline), LIMIT)
        .map_err(|_| AuthError::Storage)?;
    let reply: Reply = serde_json::from_slice(&bytes).map_err(|_| AuthError::Storage)?;
    if reply.failed || reply.value.as_ref().is_some_and(|v| v.len() > 4096) {
        return Err(AuthError::Storage);
    }
    Ok(reply.value)
}
pub(super) fn load(account: &str) -> Result<Option<String>, AuthError> {
    request(account, Operation::Load)
}
pub(super) fn take_for_reconnect(account: &str) -> Result<Option<String>, AuthError> {
    request(account, Operation::TakeForReconnect)
}
pub(super) fn save(account: &str, value: String) -> Result<(), AuthError> {
    request(account, Operation::Save(value)).map(|_| ())
}
pub(super) fn clear(account: &str) -> Result<(), AuthError> {
    request(account, Operation::Clear).map(|_| ())
}
pub(crate) fn run_helper() -> Option<i32> {
    let args: Vec<_> = std::env::args_os().collect();
    if args.len() != 2 || args[1] != ARG {
        return None;
    }
    // This is not a credential-export CLI. Only our kernel-identified parent
    // executable can create the private channel. Direct invocation is refused.
    if unsafe { libc::isatty(0) != 0 || libc::isatty(1) != 0 } || !has_trusted_parent_channel() {
        return Some(2);
    }
    let mut parent = unsafe { UnixStream::from_raw_fd(3) };
    std::thread::spawn(move || {
        let _ = parent.read(&mut [0]);
        unsafe {
            libc::_exit(3);
        }
    });
    let request: Request = match serde_json::from_reader(std::io::stdin().take(LIMIT + 1)) {
        Ok(r) if valid(&r) => r,
        _ => return Some(2),
    };
    // Per-query no-auth flags do not reliably suppress legacy login-Keychain
    // sheets. Limit the legacy interaction setting to this disposable child.
    if !matches!(request.operation, Operation::TakeForReconnect) && !disable_interaction() {
        return Some(3);
    }
    let result = (|| {
        let entry = keyring::Entry::new(SERVICE, &request.account)?;
        match request.operation {
            Operation::TakeForReconnect => {
                let value = match entry.get_password() {
                    Ok(v) => v,
                    Err(keyring::Error::NoEntry) => return Ok(None),
                    Err(e) => return Err(e),
                };
                // Reject malformed/cross-project material before consuming it.
                let project = request.account.split(':').nth(2).unwrap_or("");
                if super::decode(&value, project).is_err() {
                    return Err(keyring::Error::NoEntry);
                }
                entry.delete_credential()?;
                Ok(Some(value))
            }
            Operation::Load => match entry.get_password() {
                Ok(v) if v.len() <= 4096 => Ok(Some(v)),
                Err(keyring::Error::NoEntry) => Ok(None),
                _ => Err(keyring::Error::NoEntry),
            },
            Operation::Save(value) => entry.set_password(&value).map(|_| None),
            Operation::Clear => match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(None),
                Err(e) => Err(e),
            },
        }
    })();
    let reply = match result {
        Ok(value) => Reply {
            value,
            failed: false,
        },
        Err(_) => Reply {
            value: None,
            failed: true,
        },
    };
    let mut output = std::io::stdout().lock();
    Some(
        if serde_json::to_writer(&mut output, &reply).is_ok() && output.flush().is_ok() {
            0
        } else {
            3
        },
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protocol_bounds_scope_and_secret_size() {
        assert!(valid(&Request {
            account: "supabase:staging-v3:abcdefghijklmnopqrst:fixture".into(),
            operation: Operation::Load
        }));
        assert!(!valid(&Request {
            account: "provider-key".into(),
            operation: Operation::Clear
        }));
        assert!(!valid(&Request {
            account: "supabase:bad\0account".into(),
            operation: Operation::Load
        }));
        assert!(!valid(&Request {
            account: "supabase:fixture".into(),
            operation: Operation::Save("x".repeat(4097))
        }));
    }
}
