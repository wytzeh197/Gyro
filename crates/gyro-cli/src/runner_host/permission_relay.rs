//! Claude's stdio MCP child is in a background process group. It must never
//! read the controlling terminal (SIGTTIN). Only the foreground host asks;
//! the existing permission server still records and applies each decision.
use crate::provider_approval::ApprovalKind as CodexApprovalKind;
use anyhow::{bail, ensure, Result};
use gyro_core::CancellationToken;
use serde_json::{json, Value};
use std::{
    io::BufReader,
    os::unix::{
        fs::DirBuilderExt,
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use uuid::Uuid;

pub(super) struct PermissionRelay {
    directory: PathBuf,
    listener: UnixListener,
}
impl PermissionRelay {
    pub(super) fn new() -> Result<Self> {
        // Keep below Unix socket path limits even when TMPDIR is long.
        let directory = Path::new("/tmp").join(format!("gyro-approval-{}", Uuid::new_v4()));
        std::fs::DirBuilder::new().mode(0o700).create(&directory)?;
        let result = (|| {
            let listener = UnixListener::bind(directory.join("relay"))?;
            listener.set_nonblocking(true)?;
            Ok(Self {
                directory: directory.clone(),
                listener,
            })
        })();
        if result.is_err() {
            let _ = std::fs::remove_dir_all(directory);
        }
        result
    }
    pub(super) fn path(&self) -> PathBuf {
        self.directory.join("relay")
    }
    pub(super) fn run<T>(
        &self,
        cancellation: &CancellationToken,
        session: Uuid,
        turn: Uuid,
        decide: impl Fn(CodexApprovalKind, &Value, &CancellationToken) -> Result<bool> + Sync,
        execute: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        let finished = AtomicBool::new(false);
        let input_cancellation = CancellationToken::default();
        // Always stop the worker, including when execute unwinds.
        struct Stop<'a>(&'a AtomicBool, &'a CancellationToken);
        impl Drop for Stop<'_> {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Release);
                self.1.cancel();
            }
        }
        std::thread::scope(|scope| {
            scope.spawn(|| {
                while !finished.load(Ordering::Acquire) && !cancellation.is_cancelled() {
                    match self.listener.accept() {
                        Ok((mut stream, _)) => {
                            let result = (|| -> Result<bool> {
                                stream.set_nonblocking(false)?;
                                stream.set_read_timeout(Some(Duration::from_millis(250)))?;
                                stream.set_write_timeout(Some(Duration::from_millis(250)))?;
                                let line = crate::read_bounded_mcp_line(&mut BufReader::new(
                                    stream.try_clone()?,
                                ))?
                                .ok_or_else(|| anyhow::anyhow!("permission relay request ended"))?;
                                let request: Value = serde_json::from_slice(&line)?;
                                ensure!(
                                    request["session"] == session.to_string()
                                        && request["turn"] == turn.to_string(),
                                    "permission relay ownership mismatch"
                                );
                                ensure!(
                                    !finished.load(Ordering::Acquire)
                                        && !cancellation.is_cancelled(),
                                    "permission relay cancelled"
                                );
                                let kind = match request["kind"].as_str() {
                                    Some("command") => CodexApprovalKind::Command,
                                    Some("file-change") => CodexApprovalKind::FileChange,
                                    Some("permissions") => CodexApprovalKind::Permissions,
                                    _ => bail!("unknown permission kind"),
                                };
                                decide(kind, &request["details"], &input_cancellation)
                            })();
                            // Errors fail closed and never carry provider input into diagnostics.
                            let _ = crate::write_mcp_message(
                                &mut stream,
                                &json!({"approved":result.unwrap_or(false)}),
                            );
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(20));
                        }
                        Err(_) => break,
                    }
                }
            });
            let _stop = Stop(&finished, &input_cancellation);
            execute()
        })
    }
}
impl Drop for PermissionRelay {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(self.path());
        let _ = std::fs::remove_dir(&self.directory);
    }
}

pub(crate) fn request(
    path: &Path,
    session: Uuid,
    turn: Uuid,
    kind: CodexApprovalKind,
    details: &Value,
) -> Result<bool> {
    let mut stream = UnixStream::connect(path)?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    // The enclosing provider deadline tears down the child on cancellation.
    stream.set_read_timeout(Some(Duration::from_secs(120)))?;
    crate::write_mcp_message(
        &mut stream,
        &json!({"session":session,"turn":turn,"kind":kind.as_str(),"details":details}),
    )?;
    let line = crate::read_bounded_mcp_line(&mut BufReader::new(stream))?
        .ok_or_else(|| anyhow::anyhow!("permission relay closed without a decision"))?;
    let response: Value = serde_json::from_slice(&line)?;
    Ok(response["approved"].as_bool().unwrap_or(false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    #[test]
    fn relay_keeps_decisions_in_host_and_rejects_foreign_owners() {
        let relay = PermissionRelay::new().unwrap();
        let session = Uuid::new_v4();
        let turn = Uuid::new_v4();
        let calls = AtomicUsize::new(0);
        relay
            .run(
                &CancellationToken::default(),
                session,
                turn,
                |kind, details, _| {
                    calls.fetch_add(1, Ordering::Relaxed);
                    assert!(matches!(kind, CodexApprovalKind::FileChange));
                    Ok(details["path"] == "allowed.txt")
                },
                || {
                    assert!(!request(
                        &relay.path(),
                        Uuid::new_v4(),
                        turn,
                        CodexApprovalKind::FileChange,
                        &json!({"path":"allowed.txt"})
                    )?);
                    assert!(request(
                        &relay.path(),
                        session,
                        turn,
                        CodexApprovalKind::FileChange,
                        &json!({"path":"allowed.txt"})
                    )?);
                    assert!(!request(
                        &relay.path(),
                        session,
                        turn,
                        CodexApprovalKind::FileChange,
                        &json!({"path":"denied.txt"})
                    )?);
                    Ok(())
                },
            )
            .unwrap();
        assert_eq!(calls.load(Ordering::Relaxed), 2);
        let path = relay.path();
        drop(relay);
        assert!(!path.exists());
    }
    #[test]
    fn provider_exit_cancels_an_unanswered_foreground_prompt() {
        let relay = PermissionRelay::new().unwrap();
        let session = Uuid::new_v4();
        let turn = Uuid::new_v4();
        let path = relay.path();
        let (started, entered) = std::sync::mpsc::channel();
        let client = std::thread::spawn(move || {
            request(&path, session, turn, CodexApprovalKind::Command, &json!({})).unwrap()
        });
        let before = std::time::Instant::now();
        relay
            .run(
                &CancellationToken::default(),
                session,
                turn,
                |_, _, cancellation| {
                    started.send(()).unwrap();
                    while !cancellation.is_cancelled() {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Ok(false)
                },
                || {
                    entered.recv_timeout(Duration::from_secs(2))?;
                    Ok(())
                },
            )
            .unwrap();
        assert!(!client.join().unwrap());
        assert!(before.elapsed() < Duration::from_secs(2));
    }
}
