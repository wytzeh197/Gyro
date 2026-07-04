use anyhow::{Context, Result};
use std::path::PathBuf;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GyroPaths {
    pub base_dir: PathBuf,
    pub sessions_dir: PathBuf,
    pub worktrees_dir: PathBuf,
    pub logs_dir: PathBuf,
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
        Self {
            database_path: base_dir.join("gyro.sqlite3"),
            config_path: base_dir.join("config.json"),
            socket_path: base_dir.join("gyro.sock"),
            sessions_dir,
            worktrees_dir,
            logs_dir,
            base_dir,
        }
    }

    pub fn ensure(&self) -> Result<()> {
        std::fs::create_dir_all(&self.base_dir)
            .with_context(|| format!("create {}", self.base_dir.display()))?;
        std::fs::create_dir_all(&self.sessions_dir)
            .with_context(|| format!("create {}", self.sessions_dir.display()))?;
        std::fs::create_dir_all(&self.worktrees_dir)
            .with_context(|| format!("create {}", self.worktrees_dir.display()))?;
        std::fs::create_dir_all(&self.logs_dir)
            .with_context(|| format!("create {}", self.logs_dir.display()))?;
        Ok(())
    }
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
    }
}
