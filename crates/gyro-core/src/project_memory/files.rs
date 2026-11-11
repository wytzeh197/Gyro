//! Descriptor-confined reads shared by the desktop and CLI memory hosts.
use super::{MemoryDocument, MemorySource, MAX_MEMORY_FILE_BYTES, MEMORY_PATH};
use anyhow::{ensure, Context, Result};
use std::{
    fs,
    io::Read,
    path::{Component, Path},
};

pub fn read_project_memory(workspace: &Path) -> Result<Option<String>> {
    confined_bytes(workspace, MEMORY_PATH, MAX_MEMORY_FILE_BYTES)?
        .map(|bytes| {
            ensure!(!bytes.contains(&0), "project memory is not a text file");
            String::from_utf8(bytes).context("project memory is not UTF-8 text")
        })
        .transpose()
}

pub fn confined_bytes(workspace: &Path, relative: &str, limit: usize) -> Result<Option<Vec<u8>>> {
    super::types::validate_relative_path(relative)?;
    #[cfg(not(unix))]
    {
        let _ = (workspace, relative, limit);
        anyhow::bail!("confined project-memory reads are unavailable on this platform");
    }
    #[cfg(unix)]
    {
        use std::{
            ffi::CString,
            os::{
                fd::{AsRawFd, FromRawFd},
                unix::{ffi::OsStrExt, fs::OpenOptionsExt},
            },
        };
        let mut current = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(workspace)?;
        let parts: Vec<_> = Path::new(relative).components().collect();
        for (index, component) in parts.iter().enumerate() {
            let Component::Normal(name) = component else {
                anyhow::bail!("invalid memory path component");
            };
            let name = CString::new(name.as_bytes())?;
            let flags = libc::O_RDONLY
                | libc::O_NOFOLLOW
                | libc::O_NONBLOCK
                | libc::O_CLOEXEC
                | if index + 1 < parts.len() {
                    libc::O_DIRECTORY
                } else {
                    0
                };
            let descriptor = unsafe { libc::openat(current.as_raw_fd(), name.as_ptr(), flags) };
            if descriptor < 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::NotFound {
                    return Ok(None);
                }
                return Err(error).context("open confined memory path");
            }
            current = unsafe { fs::File::from_raw_fd(descriptor) };
        }
        ensure!(
            current.metadata()?.is_file(),
            "memory source is not a regular file"
        );
        let mut bytes = Vec::new();
        current
            .take(limit.saturating_add(1) as u64)
            .read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= limit, "memory source exceeds its read limit");
        Ok(Some(bytes))
    }
}

/// Validate only selected evidence, bounded to 8 distinct files/commits per
/// root. Missing/changed/unreadable evidence excludes dependent assertions.
pub(super) fn verify_selected_sources(
    document: &mut MemoryDocument<'_>,
    workspace: &Path,
    private: &Path,
    selected_ids: &[String],
    cache: &mut std::collections::HashMap<String, bool>,
) -> bool {
    let mut changed = false;
    for entry in &mut document.entries {
        if entry.source_changed || !selected_ids.contains(&entry.id) {
            continue;
        }
        let sources = entry
            .metadata
            .as_ref()
            .map(|m| m.sources.as_slice())
            .unwrap_or_default();
        for source in sources {
            let key = format!(
                "{}:{}",
                workspace.display(),
                serde_json::to_string(source).unwrap_or_default()
            );
            let valid = if let Some(valid) = cache.get(&key) {
                *valid
            } else if cache.len() >= 8 {
                false
            } else {
                let valid = match source {
                    MemorySource::ProjectFile {
                        path, content_hash, ..
                    } => {
                        (!workspace.join(path).starts_with(private))
                            && confined_bytes(workspace, path, 1024 * 1024)
                                .ok()
                                .flatten()
                                .is_some_and(|bytes| {
                                    crate::mutations::content_hash(&bytes) == *content_hash
                                })
                    }
                    MemorySource::Commit { oid, .. } => std::process::Command::new("git")
                        .args(["--no-lazy-fetch", "-c", "protocol.allow=never", "-C"])
                        .arg(workspace)
                        .args(["cat-file", "-e", &format!("{oid}^{{commit}}")])
                        .env("GIT_NO_LAZY_FETCH", "1")
                        .env("GIT_NO_REPLACE_OBJECTS", "1")
                        .env("GIT_OPTIONAL_LOCKS", "0")
                        .stdin(std::process::Stdio::null())
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .status()
                        .is_ok_and(|status| status.success()),
                    MemorySource::UserEntered => true,
                };
                cache.insert(key, valid);
                valid
            };
            if !valid {
                entry.source_changed = true;
                changed = true;
                break;
            }
        }
    }
    changed
}
