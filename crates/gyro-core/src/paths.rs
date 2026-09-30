use anyhow::{anyhow, Context, Result};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GyroPaths {
    pub base_dir: PathBuf,
    pub sessions_dir: PathBuf,
    pub worktrees_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub mutation_journals_dir: PathBuf,
    pub browser_captures_dir: PathBuf,
    pub database_path: PathBuf,
    pub config_path: PathBuf,
    pub socket_path: PathBuf,
}

impl GyroPaths {
    pub fn for_current_user() -> Result<Self> {
        // Keep development acceptance runs separate from the user's projects.
        #[cfg(debug_assertions)]
        if let Some(root) = std::env::var_os("GYRO_TEST_DATA_DIR") {
            let root = PathBuf::from(root);
            anyhow::ensure!(root.is_absolute(), "GYRO_TEST_DATA_DIR must be absolute");
            return Ok(Self::from_base_dir(root));
        }
        let base_dir = dirs::data_dir()
            .context("could not resolve user data directory")?
            .join("Gyro");
        Ok(Self::from_base_dir(base_dir))
    }

    pub fn from_base_dir(base_dir: PathBuf) -> Self {
        let sessions_dir = base_dir.join("sessions");
        let worktrees_dir = base_dir.join("worktrees");
        let logs_dir = base_dir.join("logs");
        let mutation_journals_dir = base_dir.join("mutation-journals");
        let browser_captures_dir = base_dir.join("browser-captures");
        Self {
            database_path: base_dir.join("gyro.sqlite3"),
            config_path: base_dir.join("config.json"),
            socket_path: base_dir.join("gyro.sock"),
            sessions_dir,
            worktrees_dir,
            logs_dir,
            mutation_journals_dir,
            browser_captures_dir,
            base_dir,
        }
    }

    pub fn ensure(&self) -> Result<()> {
        for directory in [
            &self.base_dir,
            &self.sessions_dir,
            &self.worktrees_dir,
            &self.logs_dir,
            &self.mutation_journals_dir,
            &self.browser_captures_dir,
        ] {
            ensure_private_directory(directory)?;
        }
        Ok(())
    }

    /// Give a projectless chat its own execution boundary without treating the
    /// user's home directory as a project or exposing other chat workspaces.
    pub fn ensure_chat_workspace(&self, session_id: uuid::Uuid) -> Result<PathBuf> {
        self.ensure()?;
        let root = self.sessions_dir.join("workspaces");
        ensure_private_directory(&root)?;
        let workspace = root.join(session_id.to_string());
        ensure_private_directory(&workspace)?;
        workspace
            .canonicalize()
            .context("resolve private chat workspace")
    }

    /// Remove the private workspace [`Self::ensure_chat_workspace`] gave a
    /// chat. Only that exact directory goes, and only while it is a real
    /// directory inside the Gyro data root: a symlink planted in its place is
    /// refused rather than followed. Returns false when there was none.
    pub fn remove_chat_workspace(&self, session_id: uuid::Uuid) -> Result<bool> {
        let root = self.sessions_dir.join("workspaces");
        let workspace = root.join(session_id.to_string());
        let metadata = match std::fs::symlink_metadata(&workspace) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => {
                return Err(error).with_context(|| format!("inspect {}", workspace.display()))
            }
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(anyhow!(
                "private chat workspace is not a regular directory: {}",
                workspace.display()
            ));
        }
        let root_metadata = std::fs::symlink_metadata(&root)
            .with_context(|| format!("inspect {}", root.display()))?;
        if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
            return Err(anyhow!(
                "private Gyro data path is not a regular directory: {}",
                root.display()
            ));
        }
        let base = self
            .base_dir
            .canonicalize()
            .context("resolve Gyro data root")?;
        let canonical_root = root
            .canonicalize()
            .context("resolve private chat workspaces")?;
        let canonical = workspace
            .canonicalize()
            .context("resolve private chat workspace")?;
        if !canonical_root.starts_with(&base)
            || canonical != canonical_root.join(session_id.to_string())
        {
            return Err(anyhow!(
                "private chat workspace is outside the Gyro data root: {}",
                workspace.display()
            ));
        }
        // `remove_dir_all` removes symlinks inside the tree without following
        // them, so nothing outside the workspace can be reached through it.
        std::fs::remove_dir_all(&canonical)
            .with_context(|| format!("remove {}", canonical.display()))?;
        Ok(true)
    }
}

fn ensure_private_directory(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path).with_context(|| format!("create {}", path.display()))?;
    let metadata =
        std::fs::symlink_metadata(path).with_context(|| format!("inspect {}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(anyhow!(
            "private Gyro data path is not a regular directory: {}",
            path.display()
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .with_context(|| format!("secure {}", path.display()))?;
    }
    Ok(())
}

pub(crate) fn reject_unsafe_private_file(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => Err(anyhow!(
            "private Gyro data path is not a regular file: {}",
            path.display()
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("inspect {}", path.display())),
    }
}

pub(crate) fn secure_private_file(path: &Path) -> Result<()> {
    reject_unsafe_private_file(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .with_context(|| format!("secure {}", path.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_expected_child_paths() {
        let paths = GyroPaths::from_base_dir(PathBuf::from("/tmp/GyroTest"));
        assert_eq!(paths.sessions_dir, PathBuf::from("/tmp/GyroTest/sessions"));
        assert_eq!(
            paths.worktrees_dir,
            PathBuf::from("/tmp/GyroTest/worktrees")
        );
        assert_eq!(
            paths.database_path,
            PathBuf::from("/tmp/GyroTest/gyro.sqlite3")
        );
        assert_eq!(paths.socket_path, PathBuf::from("/tmp/GyroTest/gyro.sock"));
        assert_eq!(
            paths.mutation_journals_dir,
            PathBuf::from("/tmp/GyroTest/mutation-journals")
        );
        assert_eq!(
            paths.browser_captures_dir,
            PathBuf::from("/tmp/GyroTest/browser-captures")
        );
    }

    #[test]
    fn projectless_chat_workspaces_are_private_stable_and_separate() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let id = uuid::Uuid::new_v4();
        let first = paths.ensure_chat_workspace(id).unwrap();
        assert_eq!(first, paths.ensure_chat_workspace(id).unwrap());
        assert_ne!(
            first,
            paths.ensure_chat_workspace(uuid::Uuid::new_v4()).unwrap()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::{symlink, PermissionsExt};
            assert_eq!(
                std::fs::metadata(&first).unwrap().permissions().mode() & 0o777,
                0o700
            );
            let other_id = uuid::Uuid::new_v4();
            symlink(
                temp.path(),
                first.parent().unwrap().join(other_id.to_string()),
            )
            .unwrap();
            assert!(paths.ensure_chat_workspace(other_id).is_err());
        }
    }

    #[test]
    fn removes_only_the_chat_workspace_it_was_asked_for() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let id = uuid::Uuid::new_v4();
        let kept = uuid::Uuid::new_v4();
        let workspace = paths.ensure_chat_workspace(id).unwrap();
        let other = paths.ensure_chat_workspace(kept).unwrap();
        std::fs::create_dir_all(workspace.join("nested")).unwrap();
        std::fs::write(workspace.join("nested/notes.txt"), b"scratch").unwrap();

        assert!(paths.remove_chat_workspace(id).unwrap());
        assert!(!workspace.exists());
        assert!(other.is_dir());
        // A chat that never had one, or a repeated delete, is not an error.
        assert!(!paths.remove_chat_workspace(id).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn chat_workspace_removal_never_follows_a_symlink_out_of_the_data_root() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("keep.txt"), b"not Gyro's").unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let planted = uuid::Uuid::new_v4();
        let workspace = paths.ensure_chat_workspace(uuid::Uuid::new_v4()).unwrap();
        symlink(
            outside.path(),
            workspace.parent().unwrap().join(planted.to_string()),
        )
        .unwrap();
        assert!(paths.remove_chat_workspace(planted).is_err());
        assert!(outside.path().join("keep.txt").exists());

        // A link inside a real workspace is removed as a link, not followed.
        let id = uuid::Uuid::new_v4();
        let workspace = paths.ensure_chat_workspace(id).unwrap();
        symlink(outside.path(), workspace.join("escape")).unwrap();
        assert!(paths.remove_chat_workspace(id).unwrap());
        assert!(outside.path().join("keep.txt").exists());
    }

    #[test]
    fn creates_private_data_directories() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        paths.ensure().unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for directory in [
                &paths.base_dir,
                &paths.sessions_dir,
                &paths.worktrees_dir,
                &paths.logs_dir,
                &paths.mutation_journals_dir,
                &paths.browser_captures_dir,
            ] {
                assert_eq!(
                    std::fs::metadata(directory).unwrap().permissions().mode() & 0o777,
                    0o700,
                    "{}",
                    directory.display()
                );
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_private_data_directories() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        std::fs::create_dir_all(&paths.base_dir).unwrap();
        symlink(outside.path(), &paths.sessions_dir).unwrap();

        assert!(paths
            .ensure()
            .unwrap_err()
            .to_string()
            .contains("not a regular directory"));
    }
}
