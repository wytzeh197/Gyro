use crate::{
    app::limits::{MAX_WORKSPACE_FILE_EDIT_BYTES, MAX_WORKSPACE_FILE_PREVIEW_BYTES},
    ide::task_discovery::content_hash,
    stores::to_string,
    workspace::types::{
        FileMutationDecisionRequest, FileMutationDecisionResult, FileMutationProposalRequest,
        WorkspaceFileContent, WorkspaceFileStat, WorkspaceFileWriteRequest,
    },
    workspace_mutations::{
        create_file_mutation_proposal_impl, resolve_file_mutation_proposal_impl,
    },
};
use anyhow::Context;
use gyro_core::MutationProposal;
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;
#[tauri::command]
pub(crate) async fn read_workspace_file(
    app: tauri::AppHandle,
    workspace_path: String,
    path: String,
) -> Result<WorkspaceFileContent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        super::access::require_path(&app, &workspace_path, &path, false)?;
        read_workspace_file_impl(&workspace_path, &path).map_err(to_string)
    })
    .await
    .map_err(|error| format!("workspace file read worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn read_workspace_file_full(
    app: tauri::AppHandle,
    workspace_path: String,
    path: String,
) -> Result<WorkspaceFileContent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        super::access::require_path(&app, &workspace_path, &path, false)?;
        read_workspace_file_with_limit(&workspace_path, &path, MAX_WORKSPACE_FILE_EDIT_BYTES)
            .map_err(to_string)
    })
    .await
    .map_err(|error| format!("full workspace file read worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn stat_workspace_file(
    app: tauri::AppHandle,
    workspace_path: String,
    path: String,
) -> Result<WorkspaceFileStat, String> {
    tauri::async_runtime::spawn_blocking(move || {
        super::access::require_path(&app, &workspace_path, &path, false)?;
        stat_workspace_file_impl(&workspace_path, &path).map_err(to_string)
    })
    .await
    .map_err(|error| format!("workspace file stat worker failed: {error}"))?
}

/// Kind of a path dropped on the window. Symlinks stay `other` so a drop
/// cannot follow a link out of the folder the person actually dragged.
/// This does not grant workspace trust and does not read the directory.
pub(crate) fn dropped_path_kind(path: String) -> Result<String, String> {
    let path = PathBuf::from(path.trim());
    if !path.is_absolute() {
        return Err("drop path must be absolute".into());
    }
    let metadata =
        std::fs::symlink_metadata(&path).map_err(|_| "drop path is missing".to_string())?;
    if metadata.file_type().is_symlink() {
        return Ok("other".into());
    }
    if metadata.is_dir() {
        return Ok("directory".into());
    }
    if metadata.is_file() {
        return Ok("file".into());
    }
    Ok("other".into())
}

#[tauri::command]
pub(crate) async fn classify_dropped_path(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || dropped_path_kind(path))
        .await
        .map_err(|error| format!("dropped path worker failed: {error}"))?
}

#[cfg(test)]
mod dropped_path_kind_tests {
    #[test]
    fn directory_file_and_symlink_stay_distinct() {
        let root = std::env::temp_dir().join(format!("gyro-drop-kind-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("folder")).unwrap();
        std::fs::write(root.join("notes.md"), b"hi").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("folder"), root.join("link")).unwrap();
        assert_eq!(
            super::dropped_path_kind(root.join("folder").display().to_string()).unwrap(),
            "directory"
        );
        assert_eq!(
            super::dropped_path_kind(root.join("notes.md").display().to_string()).unwrap(),
            "file"
        );
        #[cfg(unix)]
        assert_eq!(
            super::dropped_path_kind(root.join("link").display().to_string()).unwrap(),
            "other"
        );
        assert!(super::dropped_path_kind("notes.md".into()).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[tauri::command]
pub(crate) async fn write_workspace_file(
    app: tauri::AppHandle,
    request: WorkspaceFileWriteRequest,
) -> Result<WorkspaceFileContent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        super::access::require_path(&app, &request.workspace_path, &request.path, false)?;
        write_workspace_file_impl(&request).map_err(to_string)
    })
    .await
    .map_err(|error| format!("workspace file write worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn create_file_mutation_proposal(
    request: FileMutationProposalRequest,
) -> Result<MutationProposal, String> {
    tauri::async_runtime::spawn_blocking(move || {
        create_file_mutation_proposal_impl(request).map_err(to_string)
    })
    .await
    .map_err(|error| format!("file mutation proposal worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn preview_file_mutation_proposal(
    proposal_id: String,
) -> Result<gyro_core::MutationReview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = crate::stores::open_store()?;
        let proposal = store
            .get_mutation_proposal(Uuid::parse_str(&proposal_id).map_err(to_string)?)
            .map_err(to_string)?
            .ok_or_else(|| "unknown proposal".to_string())?;
        gyro_core::review_mutation_proposal(proposal).map_err(to_string)
    })
    .await
    .map_err(to_string)?
}

#[tauri::command]
pub(crate) async fn resolve_file_mutation_proposal(
    app: tauri::AppHandle,
    request: FileMutationDecisionRequest,
) -> Result<FileMutationDecisionResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        resolve_file_mutation_proposal_impl(&app, request).map_err(to_string)
    })
    .await
    .map_err(|error| format!("file mutation decision worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn undo_recorded_chat_edit(
    app: tauri::AppHandle,
    session_id: String,
    turn_id: String,
    undo_id: String,
) -> Result<gyro_core::SessionEvent, String> {
    crate::features::remote_access::require_local_control(&app, &session_id)?;
    let reservation =
        crate::provider_run_cleanup::ProviderRunReservation::reserve(&app, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let _reservation = reservation;
        let store = crate::stores::open_store()?;
        let session_id = crate::stores::parse_uuid(&session_id)?;
        let turn_id = crate::stores::parse_uuid(&turn_id)?;
        let undo_id = crate::stores::parse_uuid(&undo_id)?;
        let _lease =
            crate::providers::session_lifecycle::ProviderSessionLease::for_run(&store, session_id)
                .map_err(to_string)?;
        gyro_core::mutations::undo_recorded_edit(
            &store,
            session_id,
            turn_id,
            undo_id,
            |workspace, paths| {
                let manager = app.state::<crate::state::managers::CapabilityIdeEvidenceManager>();
                let evidence = manager
                    .evidence
                    .lock()
                    .map_err(|_| anyhow::anyhow!("Editor state is unavailable."))?;
                let snapshot = evidence.get(&workspace.to_string_lossy()).ok_or_else(|| {
                    anyhow::anyhow!("Open the recorded workspace to check for unsaved changes.")
                })?;
                for path in paths {
                    crate::workspace_mutations::assert_clean_proposal_buffer(snapshot, path)?;
                }
                Ok(())
            },
        )
        .map_err(to_string)
    })
    .await
    .map_err(to_string)?
}

pub(crate) fn read_workspace_file_impl(
    workspace_path: &str,
    path: &str,
) -> anyhow::Result<WorkspaceFileContent> {
    read_workspace_file_with_limit(workspace_path, path, MAX_WORKSPACE_FILE_PREVIEW_BYTES)
}

pub(crate) fn read_workspace_file_with_limit(
    workspace_path: &str,
    path: &str,
    max_bytes: usize,
) -> anyhow::Result<WorkspaceFileContent> {
    let root = PathBuf::from(workspace_path).canonicalize()?;
    let candidate = gyro_core::security::assert_path_inside_workspace(&root, Path::new(path))?;
    let (mut bytes, size_bytes) =
        read_workspace_bytes(&root, &candidate, max_bytes, "workspace file")?;
    let truncated = bytes.len() > max_bytes;
    if truncated {
        bytes.truncate(max_bytes);
    }
    if bytes.contains(&0) {
        anyhow::bail!("binary workspace files cannot be previewed");
    }
    let content_hash = content_hash(&bytes);
    let content = decode_workspace_utf8(&bytes, truncated)?;

    Ok(WorkspaceFileContent {
        path: path.to_string(),
        content,
        truncated,
        size_bytes,
        content_hash,
    })
}

// A preview may end in the middle of one codepoint; malformed input anywhere
// else must never be silently replaced and subsequently saved over the file.
pub(crate) fn decode_workspace_utf8(bytes: &[u8], truncated: bool) -> anyhow::Result<String> {
    match std::str::from_utf8(bytes) {
        Ok(content) => Ok(content.to_owned()),
        Err(error) if truncated && error.error_len().is_none() => {
            Ok(std::str::from_utf8(&bytes[..error.valid_up_to()])?.to_owned())
        }
        Err(_) => anyhow::bail!("This file is not valid UTF-8 and cannot be edited as text."),
    }
}

#[cfg(test)]
mod workspace_utf8_tests {
    use super::decode_workspace_utf8;

    #[cfg(unix)]
    #[test]
    fn approved_read_cannot_follow_a_parent_replaced_after_path_validation() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let root = base.join("workspace");
        let outside = base.join("outside");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(root.join("src/file.txt"), b"approved content").unwrap();
        std::fs::write(outside.join("file.txt"), b"outside sentinel").unwrap();
        let approved = gyro_core::security::assert_path_inside_workspace(
            &root,
            std::path::Path::new("src/file.txt"),
        )
        .unwrap();
        std::fs::rename(root.join("src"), root.join("old")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("src")).unwrap();
        let result = super::read_workspace_bytes(&root, &approved, 1024, "workspace file");
        assert!(
            result.is_err(),
            "validated read followed a replaced parent: {result:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_fifo_without_waiting_for_a_writer() {
        use std::os::unix::{ffi::OsStrExt, fs::OpenOptionsExt};
        use std::time::Duration;

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("pipe");
        let fifo = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        let (sender, receiver) = std::sync::mpsc::channel();
        let reader_path = path.clone();
        let reader = std::thread::spawn(move || {
            let _ = sender.send(super::read_bounded_regular_file(
                &reader_path,
                1024,
                "workspace file",
            ));
        });
        let result = receiver.recv_timeout(Duration::from_secs(2));
        if result.is_err() {
            // Unblock a regressed reader without hanging the test itself.
            let _writer = std::fs::OpenOptions::new()
                .write(true)
                .custom_flags(libc::O_NONBLOCK)
                .open(&path);
            let _ = receiver.recv_timeout(Duration::from_secs(2));
        }
        if reader.is_finished() {
            reader.join().unwrap();
        }
        let error = result
            .expect("FIFO read blocked waiting for a writer")
            .unwrap_err()
            .to_string();
        assert!(error.contains("not a regular file"), "{error}");
    }
    #[test]
    fn rejects_invalid_utf8_even_in_previews() {
        assert!(decode_workspace_utf8(&[0xff, 0x61], false).is_err());
        assert!(decode_workspace_utf8(&[0xff, 0x61], true).is_err());
        assert!(decode_workspace_utf8(&[0x61, 0xe2], false).is_err());
    }
    #[test]
    fn trims_only_a_truncated_codepoint() {
        assert_eq!(
            decode_workspace_utf8(&[0x61, 0xe2, 0x82], true).unwrap(),
            "a"
        );
        assert_eq!(decode_workspace_utf8("a€".as_bytes(), false).unwrap(), "a€");
    }
}

pub(crate) fn read_bounded_regular_file(
    path: &Path,
    max_bytes: usize,
    label: &str,
) -> anyhow::Result<(Vec<u8>, u64)> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // A FIFO must not block in open() before the regular-file check.
        // O_NONBLOCK has no effect on ordinary file reads.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("open {label} {}", path.display()))?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        anyhow::bail!("{label} is not a regular file");
    }
    let mut bytes = Vec::with_capacity(max_bytes.min(metadata.len() as usize));
    Read::by_ref(&mut file)
        .take(max_bytes.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .with_context(|| format!("read {label} {}", path.display()))?;
    Ok((bytes, metadata.len()))
}

pub(crate) fn read_workspace_bytes(
    root: &Path,
    path: &Path,
    max_bytes: usize,
    label: &str,
) -> anyhow::Result<(Vec<u8>, u64)> {
    let parent = gyro_core::workspace_write::WorkspaceWriteParent::open(root, path)?;
    let mut file = parent
        .open_read()
        .with_context(|| format!("open {label} {}", path.display()))?;
    let metadata = file.metadata()?;
    anyhow::ensure!(metadata.is_file(), "{label} is not a regular file");
    let mut bytes = Vec::with_capacity(max_bytes.min(metadata.len() as usize));
    Read::by_ref(&mut file)
        .take(max_bytes.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .with_context(|| format!("read {label} {}", path.display()))?;
    parent.verify()?;
    Ok((bytes, metadata.len()))
}

pub(crate) fn stat_workspace_file_impl(
    workspace_path: &str,
    path: &str,
) -> anyhow::Result<WorkspaceFileStat> {
    let root = PathBuf::from(workspace_path).canonicalize()?;
    let candidate = gyro_core::security::assert_path_inside_workspace(&root, Path::new(path))?;
    let metadata = match std::fs::metadata(&candidate) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(WorkspaceFileStat {
                path: path.to_string(),
                kind: "missing".into(),
                size_bytes: 0,
                content_hash: None,
            });
        }
        Err(error) => return Err(error.into()),
    };
    let kind = if metadata.is_dir() {
        "directory"
    } else {
        "file"
    }
    .to_string();
    let content_hash =
        if metadata.is_file() && metadata.len() <= MAX_WORKSPACE_FILE_EDIT_BYTES as u64 {
            let (bytes, _) = read_workspace_bytes(
                &root,
                &candidate,
                MAX_WORKSPACE_FILE_EDIT_BYTES,
                "workspace file",
            )?;
            if bytes.len() > MAX_WORKSPACE_FILE_EDIT_BYTES || bytes.contains(&0) {
                None
            } else {
                Some(content_hash(&bytes))
            }
        } else {
            None
        };

    Ok(WorkspaceFileStat {
        path: path.to_string(),
        kind,
        size_bytes: metadata.len(),
        content_hash,
    })
}

pub(crate) fn write_workspace_file_impl(
    request: &WorkspaceFileWriteRequest,
) -> anyhow::Result<WorkspaceFileContent> {
    // Share the agent transaction lock from hash validation through replacement.
    let _write_lock = gyro_core::mutations::acquire_workspace_write_lock()?;
    let root = PathBuf::from(&request.workspace_path).canonicalize()?;
    let candidate = validated_workspace_file_target(&root, &request.path)?;
    if candidate.is_dir() {
        anyhow::bail!("workspace write path is a directory");
    }
    let content_bytes = request.content.as_bytes();
    if content_bytes.len() > MAX_WORKSPACE_FILE_EDIT_BYTES {
        anyhow::bail!("workspace file is too large to edit in Gyro");
    }
    if content_bytes.contains(&0) {
        anyhow::bail!("binary workspace files cannot be edited");
    }
    let validate_current = || -> anyhow::Result<()> {
        if let Some(expected_hash) = request.expected_hash.as_deref() {
            let (current, _) = read_workspace_bytes(
                &root,
                &candidate,
                MAX_WORKSPACE_FILE_EDIT_BYTES,
                "workspace file",
            )?;
            if current.len() > MAX_WORKSPACE_FILE_EDIT_BYTES {
                anyhow::bail!("workspace file is too large to edit in Gyro");
            }
            if current.contains(&0) {
                anyhow::bail!("binary workspace files cannot be edited");
            }
            let current_hash = content_hash(&current);
            if current_hash != expected_hash {
                anyhow::bail!("file changed on disk; reload before saving");
            }
        }
        Ok(())
    };
    validate_current()?;

    atomic_write_workspace_file_at_root(&root, &candidate, content_bytes, validate_current)?;
    // Return the committed snapshot, never a later writer's content paired with
    // this save completion. The next disk reconciliation detects later writes.
    Ok(WorkspaceFileContent {
        path: request.path.clone(),
        content: request.content.clone(),
        truncated: false,
        size_bytes: content_bytes.len() as u64,
        content_hash: content_hash(content_bytes),
    })
}

pub(crate) fn validated_workspace_file_target(root: &Path, path: &str) -> anyhow::Result<PathBuf> {
    let candidate = gyro_core::security::assert_path_inside_workspace(root, Path::new(path))?;
    let parent = candidate
        .parent()
        .ok_or_else(|| anyhow::anyhow!("workspace file path has no parent"))?;
    let resolved_parent = parent
        .canonicalize()
        .map_err(|_| anyhow::anyhow!("workspace file parent does not exist"))?;
    if !resolved_parent.starts_with(root) {
        anyhow::bail!("workspace file parent resolves outside the workspace");
    }
    Ok(resolved_parent.join(
        candidate
            .file_name()
            .ok_or_else(|| anyhow::anyhow!("workspace file path has no file name"))?,
    ))
}

pub(crate) fn atomic_write_workspace_file(path: &Path, content: &[u8]) -> anyhow::Result<()> {
    atomic_write_workspace_file_at_root(
        path.parent().ok_or_else(|| anyhow::anyhow!("no parent"))?,
        path,
        content,
        || Ok(()),
    )
}

fn atomic_write_workspace_file_at_root(
    root: &Path,
    path: &Path,
    content: &[u8],
    before_commit: impl FnOnce() -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("workspace file path has no parent"))?;
    let temporary = parent.join(format!(
        ".gyro-{}-{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("mutation"),
        Uuid::new_v4()
    ));
    let directory = gyro_core::workspace_write::WorkspaceWriteParent::open(root, path)?;
    let result = (|| -> anyhow::Result<()> {
        let mut file = directory.create(temporary.file_name().unwrap())?;
        if let Ok(metadata) = fs::metadata(path) {
            file.set_permissions(metadata.permissions())?;
        }
        file.write_all(content)?;
        file.flush()?;
        file.sync_all()?;
        before_commit()?;
        directory.rename_to(
            temporary.file_name().unwrap(),
            &directory,
            path.file_name().unwrap(),
        )?;
        directory.sync()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = directory.remove(temporary.file_name().unwrap());
    }
    result
}

pub(crate) fn workspace_root(workspace_path: &str) -> anyhow::Result<PathBuf> {
    PathBuf::from(workspace_path)
        .canonicalize()
        .map_err(anyhow::Error::from)
}

pub(crate) fn assert_workspace_path(root: &Path, path: &str) -> anyhow::Result<PathBuf> {
    gyro_core::security::assert_path_inside_workspace(root, Path::new(path))
}

/// Lifecycle and Git actions act on the entry itself, never a symlink's target.
pub(crate) fn assert_workspace_entry(root: &Path, path: &str) -> anyhow::Result<PathBuf> {
    gyro_core::security::assert_entry_inside_workspace(root, Path::new(path))
}

#[cfg(test)]
mod save_race_tests {
    use super::*;

    #[test]
    fn workspace_save_revalidates_after_staging_and_cleans_temporary_file() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let path = root.join("café notes.txt");
        fs::write(&path, b"original").unwrap();
        let expected = content_hash(b"original");
        let result = atomic_write_workspace_file_at_root(&root, &path, b"editor", || {
            // A different process writes while Gyro is staging/syncing its save.
            fs::write(&path, b"external")?;
            anyhow::ensure!(
                content_hash(&fs::read(&path)?) == expected,
                "file changed on disk"
            );
            Ok(())
        });
        assert!(result.unwrap_err().to_string().contains("changed on disk"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "external");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    }

    #[test]
    fn workspace_concurrent_saves_cannot_both_commit_the_same_base() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        fs::write(root.join("notes.txt"), b"base").unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let workers: Vec<_> = ["first", "second"]
            .into_iter()
            .map(|text| {
                let barrier = barrier.clone();
                let request = WorkspaceFileWriteRequest {
                    workspace_path: root.display().to_string(),
                    path: "notes.txt".into(),
                    content: text.into(),
                    expected_hash: Some(content_hash(b"base")),
                };
                std::thread::spawn(move || {
                    barrier.wait();
                    write_workspace_file_impl(&request)
                })
            })
            .collect();
        let results: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        let winner = results.into_iter().find_map(Result::ok).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("notes.txt")).unwrap(),
            winner.content
        );
        assert_eq!(winner.content_hash, content_hash(winner.content.as_bytes()));
    }
}
