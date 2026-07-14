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
