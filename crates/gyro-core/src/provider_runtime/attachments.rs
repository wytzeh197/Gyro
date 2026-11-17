//! Bound and verify attachment bytes at the payload consumer, after admission.
//! Callers still own session/workspace authorization for the supplied path.
use super::{limits, types::ChatAttachmentRequest};
use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use std::{fs::File, io::Read};

fn read(attachment: &ChatAttachmentRequest, max_bytes: u64) -> Result<Vec<u8>> {
    read_scoped(attachment, max_bytes, None)
}

fn read_scoped(
    attachment: &ChatAttachmentRequest,
    max_bytes: u64,
    root: Option<&std::path::Path>,
) -> Result<Vec<u8>> {
    let mut options = File::options();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // A replaced attachment must not redirect the read through a symlink,
        // or hang the provider worker opening a FIFO instead of a file.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let parent = root
        .map(|root| {
            let path = crate::security::assert_path_inside_workspace(
                root,
                std::path::Path::new(&attachment.path),
            )?;
            crate::workspace_write::WorkspaceWriteParent::open(root, &path)
        })
        .transpose()?;
    let file = match &parent {
        Some(parent) => parent.open_read()?,
        None => options
            .open(&attachment.path)
            .with_context(|| format!("read attachment {}", attachment.name))?,
    };
    let metadata = file.metadata()?;
    anyhow::ensure!(
        metadata.is_file(),
        "{} is not a regular attachment file",
        attachment.name
    );
    anyhow::ensure!(
        metadata.len() <= max_bytes,
        "{} exceeds the {} byte attachment limit",
        attachment.name,
        max_bytes
    );
    let mut bytes = Vec::new();
    file.take(max_bytes + 1).read_to_end(&mut bytes)?;
    anyhow::ensure!(
        bytes.len() as u64 <= max_bytes,
        "{} exceeds the {} byte attachment limit",
        attachment.name,
        max_bytes
    );
    anyhow::ensure!(
        bytes.len() as u64 == attachment.size,
        "{} changed after it was attached; remove it and attach the current file",
        attachment.name
    );
    if let Some(expected) = &attachment.content_hash {
        anyhow::ensure!(
            &format!("{:x}", Sha256::digest(&bytes)) == expected,
            "{} changed after it was attached; remove it and attach the current file",
            attachment.name
        );
    }
    if let Some(parent) = parent {
        parent.verify()?;
    }
    Ok(bytes)
}

pub(super) fn image(attachment: &ChatAttachmentRequest) -> Result<Vec<u8>> {
    read(attachment, limits::MAX_CHAT_IMAGE_BYTES)
}

pub(super) fn workspace_text(
    attachment: &ChatAttachmentRequest,
    root: &std::path::Path,
) -> Result<String> {
    let root = root.canonicalize()?;
    String::from_utf8(read_scoped(
        attachment,
        limits::MAX_CHAT_WORKSPACE_ATTACHMENT_BYTES,
        Some(&root),
    )?)
    .with_context(|| format!("{} is not a UTF-8 text attachment", attachment.name))
}

/// Read a prepared text capture within the shared size and integrity limits.
pub fn snapshot_text(attachment: &ChatAttachmentRequest) -> Result<String> {
    String::from_utf8(read(attachment, limits::MAX_CHAT_IDE_SNAPSHOT_BYTES)?)
        .with_context(|| format!("{} is not a UTF-8 snapshot", attachment.name))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attachment(path: &std::path::Path, size: u64) -> ChatAttachmentRequest {
        ChatAttachmentRequest {
            id: "fixture".into(),
            kind: "image".into(),
            name: "fixture".into(),
            path: path.to_string_lossy().into_owned(),
            relative_path: None,
            mime_type: None,
            size,
            content_hash: None,
            modified_at: None,
            preview_url: None,
        }
    }

    #[test]
    fn exact_limit_and_declared_size_are_enforced() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("file");
        std::fs::write(&path, b"four").unwrap();
        assert_eq!(read(&attachment(&path, 4), 4).unwrap(), b"four");
        assert!(read(&attachment(&path, 4), 3).is_err());
        assert!(read(&attachment(&path, 3), 4).is_err());
        std::fs::write(&path, [0xff]).unwrap();
        assert!(workspace_text(&attachment(&path, 1), directory.path()).is_err());
        assert!(snapshot_text(&attachment(&path, 1)).is_err());
    }

    #[test]
    fn workspace_text_requires_the_selected_root() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("workspace");
        std::fs::create_dir(&root).unwrap();
        let inside = root.join("file");
        let outside = directory.path().join("other");
        std::fs::write(&inside, b"approved").unwrap();
        std::fs::write(&outside, b"outside").unwrap();
        assert_eq!(
            workspace_text(&attachment(&inside, 8), &root).unwrap(),
            "approved"
        );
        assert!(workspace_text(&attachment(&outside, 7), &root).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
            assert!(workspace_text(&attachment(&root.join("link"), 7), &root).is_err());
        }
    }

    #[test]
    fn text_captures_obey_their_smaller_limit() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("snapshot");
        let size = limits::MAX_CHAT_IDE_SNAPSHOT_BYTES + 1;
        std::fs::File::create(&path).unwrap().set_len(size).unwrap();
        assert!(snapshot_text(&attachment(&path, size)).is_err());
    }

    #[test]
    #[cfg(unix)]
    fn replaced_symlinks_and_fifos_do_not_get_read() {
        use std::os::unix::{ffi::OsStrExt, fs::symlink};
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("image");
        let other = directory.path().join("other");
        std::fs::write(&other, b"private").unwrap();
        symlink(&other, &path).unwrap();
        assert!(image(&attachment(&path, 7)).is_err());
        std::fs::remove_file(&path).unwrap();
        let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let started = std::time::Instant::now();
        assert!(image(&attachment(&path, 0)).is_err());
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
    }
}
