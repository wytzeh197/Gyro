//! Cross-process admission: chats share a checkout; a workflow owns it exclusively.
use crate::GyroPaths;
use anyhow::{ensure, Result};
use std::{
    fs::{File, OpenOptions},
    path::Path,
};
pub struct WorkflowCheckoutLease {
    _file: File,
    root: std::path::PathBuf,
    exclusive: bool,
}
impl WorkflowCheckoutLease {
    pub fn owns_exclusively(&self, root: &Path) -> bool {
        self.exclusive && root.canonicalize().ok().as_ref() == Some(&self.root)
    }
    pub fn try_acquire(paths: &GyroPaths, root: &Path, exclusive: bool) -> Result<Option<Self>> {
        #[cfg(unix)]
        {
            use std::os::{
                fd::AsRawFd,
                unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
            };
            paths.ensure()?;
            let directory = paths.base_dir.join("workflow-checkout-leases");
            std::fs::create_dir_all(&directory)?;
            let metadata = std::fs::symlink_metadata(&directory)?;
            ensure!(
                metadata.is_dir()
                    && !metadata.file_type().is_symlink()
                    && metadata.uid() == unsafe { libc::geteuid() },
                "checkout lease directory is not private"
            );
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
            let key =
                crate::mutations::content_hash(root.canonicalize()?.to_string_lossy().as_bytes());
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(directory.join(key))?;
            let metadata = file.metadata()?;
            ensure!(
                metadata.is_file()
                    && metadata.nlink() == 1
                    && metadata.uid() == unsafe { libc::geteuid() },
                "checkout lease is not a private regular file"
            );
            file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
            loop {
                let op = if exclusive {
                    libc::LOCK_EX
                } else {
                    libc::LOCK_SH
                };
                if unsafe { libc::flock(file.as_raw_fd(), op | libc::LOCK_NB) } == 0 {
                    break;
                }
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::WouldBlock {
                    return Ok(None);
                }
                if error.kind() != std::io::ErrorKind::Interrupted {
                    return Err(error.into());
                }
            }
            Ok(Some(Self {
                _file: file,
                root: root.canonicalize()?,
                exclusive,
            }))
        }
        #[cfg(not(unix))]
        {
            let _ = (paths, root, exclusive);
            anyhow::bail!("workflow checkout admission is unavailable on this platform")
        }
    }
}
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn workflow_checkout_lease_excludes_workflows_but_allows_concurrent_chats() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("private"));
        let first = WorkflowCheckoutLease::try_acquire(&paths, temp.path(), false)
            .unwrap()
            .unwrap();
        let second = WorkflowCheckoutLease::try_acquire(&paths, temp.path(), false)
            .unwrap()
            .unwrap();
        assert!(
            WorkflowCheckoutLease::try_acquire(&paths, temp.path(), true)
                .unwrap()
                .is_none()
        );
        drop(first);
        drop(second);
        let exclusive = WorkflowCheckoutLease::try_acquire(&paths, temp.path(), true)
            .unwrap()
            .unwrap();
        assert!(
            WorkflowCheckoutLease::try_acquire(&paths, temp.path(), false)
                .unwrap()
                .is_none()
        );
        assert!(
            WorkflowCheckoutLease::try_acquire(&paths, temp.path(), true)
                .unwrap()
                .is_none()
        );
        drop(exclusive);
        assert!(
            WorkflowCheckoutLease::try_acquire(&paths, temp.path(), false)
                .unwrap()
                .is_some()
        );
    }
    #[test]
    #[ignore = "subprocess-only checkout lease probe"]
    fn checkout_child_probe() {
        let Some(root) = std::env::var_os("GYRO_CHECKOUT_PROBE_ROOT") else {
            return;
        };
        let data = std::env::var_os("GYRO_CHECKOUT_PROBE_DATA").unwrap();
        let exclusive = std::env::var("GYRO_CHECKOUT_PROBE_EXCLUSIVE").unwrap() == "1";
        let expected = std::env::var("GYRO_CHECKOUT_PROBE_EXPECT").unwrap() == "1";
        let lease = WorkflowCheckoutLease::try_acquire(
            &GyroPaths::from_base_dir(data.into()),
            Path::new(&root),
            exclusive,
        )
        .unwrap();
        assert_eq!(lease.is_some(), expected);
    }
    #[test]
    fn workflow_checkout_exclusion_holds_across_processes() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("private"));
        let probe = |exclusive: bool, expected: bool| {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--ignored",
                    "--exact",
                    "workflows::checkout::tests::checkout_child_probe",
                ])
                .env("GYRO_CHECKOUT_PROBE_ROOT", temp.path())
                .env("GYRO_CHECKOUT_PROBE_DATA", &paths.base_dir)
                .env(
                    "GYRO_CHECKOUT_PROBE_EXCLUSIVE",
                    if exclusive { "1" } else { "0" },
                )
                .env(
                    "GYRO_CHECKOUT_PROBE_EXPECT",
                    if expected { "1" } else { "0" },
                )
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stdout)
            );
        };
        let shared = WorkflowCheckoutLease::try_acquire(&paths, temp.path(), false)
            .unwrap()
            .unwrap();
        probe(false, true);
        probe(true, false);
        drop(shared);
        let exclusive = WorkflowCheckoutLease::try_acquire(&paths, temp.path(), true)
            .unwrap()
            .unwrap();
        probe(false, false);
        probe(true, false);
        drop(exclusive);
        probe(true, true);
        assert!(
            WorkflowCheckoutLease::try_acquire(&paths, temp.path(), false)
                .unwrap()
                .is_some()
        );
    }
}
