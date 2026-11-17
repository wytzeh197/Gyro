//! Descriptor-relative workspace I/O: a renamed/symlinked parent cannot
//! redirect a checked file operation between validation and access.
use anyhow::{anyhow, Context, Result};
use std::{
    fs::File,
    path::{Component, Path, PathBuf},
};

pub struct WorkspaceWriteParent {
    directory: File,
    root: PathBuf,
    target: PathBuf,
}

#[cfg(unix)]
fn name(value: &std::ffi::OsStr) -> Result<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    let mut components = Path::new(value).components();
    anyhow::ensure!(
        matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none(),
        "invalid workspace entry name"
    );
    Ok(std::ffi::CString::new(value.as_bytes())?)
}

impl WorkspaceWriteParent {
    pub fn open(root: &Path, target: &Path) -> Result<Self> {
        let relative = target
            .strip_prefix(root)
            .context("file target is outside workspace")?;
        anyhow::ensure!(
            relative.file_name().is_some(),
            "file target has no file name"
        );
        let parent = relative.parent().unwrap_or(Path::new(""));
        #[cfg(unix)]
        let directory = {
            use std::os::{
                fd::{AsRawFd, FromRawFd},
                unix::fs::OpenOptionsExt,
            };
            anyhow::ensure!(root.is_absolute(), "workspace root must be absolute");
            let mut directory = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open("/")?;
            // The root was canonicalized by the caller, but an ancestor may
            // have been swapped since then. Do not follow links in the root
            // itself either.
            for component in root.components().chain(parent.components()) {
                if component == Component::RootDir {
                    continue;
                }
                let Component::Normal(part) = component else {
                    return Err(anyhow!("invalid workspace parent"));
                };
                let part = name(part)?;
                let fd = unsafe {
                    libc::openat(
                        directory.as_raw_fd(),
                        part.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if fd < 0 {
                    return Err(std::io::Error::last_os_error().into());
                }
                directory = unsafe { File::from_raw_fd(fd) };
            }
            directory
        };
        #[cfg(not(unix))]
        let directory = {
            let resolved = root.join(parent).canonicalize()?;
            anyhow::ensure!(resolved == root.join(parent), "workspace parent changed");
            File::open(resolved)?
        };
        Ok(Self {
            directory,
            root: root.into(),
            target: target.into(),
        })
    }

    /// Reject directory replacement instead of silently writing to a detached
    /// directory. The actual rename still uses the pinned descriptor.
    pub fn verify(&self) -> Result<()> {
        let current = Self::open(&self.root, &self.target)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let before = self.directory.metadata()?;
            let now = current.directory.metadata()?;
            anyhow::ensure!(
                before.dev() == now.dev() && before.ino() == now.ino(),
                "workspace parent changed during file access"
            );
        }
        Ok(())
    }

    pub fn create(&self, entry: &std::ffi::OsStr) -> Result<File> {
        #[cfg(unix)]
        {
            use std::os::fd::{AsRawFd, FromRawFd};
            let entry = name(entry)?;
            let fd = unsafe {
                libc::openat(
                    self.directory.as_raw_fd(),
                    entry.as_ptr(),
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC,
                    0o666,
                )
            };
            if fd < 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            Ok(unsafe { File::from_raw_fd(fd) })
        }
        #[cfg(not(unix))]
        {
            Ok(std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(self.target.parent().unwrap().join(entry))?)
        }
    }

    /// Open the selected file through the pinned parent, without following a
    /// replacement link or waiting for a FIFO. Call verify after reading when
    /// a detached parent should invalidate the returned snapshot.
    pub fn open_read(&self) -> Result<File> {
        #[cfg(unix)]
        {
            use std::os::fd::{AsRawFd, FromRawFd};
            let entry = name(self.target.file_name().context("missing file name")?)?;
            let fd = unsafe {
                libc::openat(
                    self.directory.as_raw_fd(),
                    entry.as_ptr(),
                    libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            Ok(unsafe { File::from_raw_fd(fd) })
        }
        #[cfg(not(unix))]
        {
            self.verify()?;
            anyhow::ensure!(
                !std::fs::symlink_metadata(&self.target)?
                    .file_type()
                    .is_symlink(),
                "file is a symlink"
            );
            Ok(File::open(&self.target)?)
        }
    }

    pub fn rename_to(
        &self,
        from: &std::ffi::OsStr,
        destination: &Self,
        to: &std::ffi::OsStr,
    ) -> Result<()> {
        self.verify()?;
        destination.verify()?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let from = name(from)?;
            let to = name(to)?;
            if unsafe {
                libc::renameat(
                    self.directory.as_raw_fd(),
                    from.as_ptr(),
                    destination.directory.as_raw_fd(),
                    to.as_ptr(),
                )
            } != 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
            Ok(())
        }
        #[cfg(not(unix))]
        {
            Ok(std::fs::rename(
                self.target.parent().unwrap().join(from),
                destination.target.parent().unwrap().join(to),
            )?)
        }
    }

    pub fn remove(&self, entry: &std::ffi::OsStr) -> Result<()> {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let entry = name(entry)?;
            if unsafe { libc::unlinkat(self.directory.as_raw_fd(), entry.as_ptr(), 0) } != 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            Ok(())
        }
        #[cfg(not(unix))]
        {
            Ok(std::fs::remove_file(
                self.target.parent().unwrap().join(entry),
            )?)
        }
    }

    pub fn sync(&self) -> Result<()> {
        Ok(self.directory.sync_all()?)
    }
}

pub fn rename(root: &Path, from: &Path, to: &Path) -> Result<()> {
    let source = WorkspaceWriteParent::open(root, from)?;
    let destination = WorkspaceWriteParent::open(root, to)?;
    source.rename_to(
        from.file_name().unwrap(),
        &destination,
        to.file_name().unwrap(),
    )
}

pub fn remove(root: &Path, path: &Path) -> Result<()> {
    let parent = WorkspaceWriteParent::open(root, path)?;
    parent.remove(
        path.file_name()
            .ok_or_else(|| anyhow!("missing file name"))?,
    )
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{fs, io::Write, os::unix::fs::symlink};

    #[test]
    fn pinned_read_never_switches_to_a_replacement_parent() {
        use std::io::Read;
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let root = base.join("workspace");
        let outside = base.join("outside");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(root.join("src/file"), b"approved").unwrap();
        fs::write(outside.join("file"), b"outside sentinel").unwrap();
        let parent = WorkspaceWriteParent::open(&root, &root.join("src/file")).unwrap();
        fs::rename(root.join("src"), root.join("old")).unwrap();
        symlink(&outside, root.join("src")).unwrap();
        let mut content = String::new();
        parent
            .open_read()
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        assert_eq!(content, "approved");
        assert!(parent.verify().is_err());
    }

    #[test]
    fn parent_swap_cannot_redirect_staging_or_commit() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let root = base.join("workspace");
        let outside = base.join("outside");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("file"), "sentinel").unwrap();
        let parent = WorkspaceWriteParent::open(&root, &root.join("src/file")).unwrap();
        fs::rename(root.join("src"), root.join("old")).unwrap();
        symlink(&outside, root.join("src")).unwrap();
        parent
            .create("stage".as_ref())
            .unwrap()
            .write_all(b"agent")
            .unwrap();
        assert!(parent
            .rename_to("stage".as_ref(), &parent, "file".as_ref())
            .is_err());
        assert_eq!(
            fs::read_to_string(outside.join("file")).unwrap(),
            "sentinel"
        );
        assert!(!outside.join("stage").exists());
        assert!(WorkspaceWriteParent::open(&root, &root.join("src/file")).is_err());
        parent.remove("stage".as_ref()).unwrap();
    }
}
