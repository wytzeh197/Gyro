//! Native filesystem grants. A renderer-supplied workspacePath is a scope to
//! validate, never authority to open a new part of the filesystem.
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

#[derive(Default, Serialize, Deserialize)]
struct Grants {
    roots: HashSet<PathBuf>,
}
impl Grants {
    fn allows(&self, path: &Path) -> bool {
        self.roots.iter().any(|root| path.starts_with(root))
    }
    fn load(path: &Path) -> anyhow::Result<Self> {
        match std::fs::read(path) {
            Ok(bytes) => {
                let grants: Self = serde_json::from_slice(&bytes)?;
                anyhow::ensure!(
                    grants.roots.iter().all(|p| p.is_absolute()),
                    "invalid workspace access grants"
                );
                Ok(grants)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(error.into()),
        }
    }
}
#[derive(Default)]
struct Access {
    grants: Option<Grants>,
    declined: HashSet<PathBuf>,
}
static ACCESS: OnceLock<Mutex<Access>> = OnceLock::new();

fn access() -> Result<std::sync::MutexGuard<'static, Access>, String> {
    let mut access = ACCESS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "Workspace access is unavailable".to_string())?;
    if access.grants.is_none() {
        let paths = gyro_core::GyroPaths::for_current_user().map_err(crate::stores::to_string)?;
        access.grants = Some(
            Grants::load(&paths.base_dir.join("workspace-access.json"))
                .map_err(|error| format!("Could not read workspace access grants: {error}"))?,
        );
    }
    Ok(access)
}

/// Only opening a workspace may request a new grant. Mutations never prompt or
/// expand scope. The dialog plugin already grants genuinely picked directories.
pub(crate) fn open_root(app: &tauri::AppHandle, path: &str) -> Result<(), String> {
    let root = Path::new(path)
        .canonicalize()
        .map_err(crate::stores::to_string)?;
    if !root.is_dir() {
        return Err("Workspace root is not a directory".into());
    }
    let mut access = access()?;
    if access.grants.as_ref().unwrap().allows(&root) {
        return Ok(());
    }
    let picked = app.asset_protocol_scope().is_allowed(&root);
    if !picked {
        if access.declined.contains(&root) {
            return Err(
                "Folder access was cancelled. Choose the folder with Open Folder to grant access."
                    .into(),
            );
        }
        let allowed = app
            .dialog()
            .message(format!(
                "Allow Gyro to read and edit files in this workspace folder?\n\n{}",
                root.display()
            ))
            .title("Open workspace folder")
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Open Folder".into(),
                "Cancel".into(),
            ))
            .blocking_show();
        if !allowed {
            access.declined.insert(root);
            return Err("Folder access was cancelled".into());
        }
    }
    // Commit before publishing authority, so a failed write cannot silently
    // turn a one-time prompt into a grant that disappears on restart.
    let mut roots = access.grants.as_ref().unwrap().roots.clone();
    roots.insert(root.clone());
    let grants = Grants { roots };
    let paths = gyro_core::GyroPaths::for_current_user().map_err(crate::stores::to_string)?;
    paths.ensure().map_err(crate::stores::to_string)?;
    let bytes = serde_json::to_vec(&grants).map_err(crate::stores::to_string)?;
    super::files::atomic_write_workspace_file(
        &paths.base_dir.join("workspace-access.json"),
        &bytes,
    )
    .map_err(crate::stores::to_string)?;
    access.grants = Some(grants);
    access.declined.remove(&root);
    Ok(())
}

pub(crate) fn require_root(app: &tauri::AppHandle, root: &str) -> Result<(), String> {
    let path = Path::new(root)
        .canonicalize()
        .map_err(crate::stores::to_string)?;
    require_resolved(app, &path)
}

pub(crate) fn require_path(
    app: &tauri::AppHandle,
    root: &str,
    path: &str,
    entry: bool,
) -> Result<(), String> {
    let resolved = if entry {
        gyro_core::security::assert_entry_inside_workspace(Path::new(root), Path::new(path))
    } else {
        gyro_core::security::assert_path_inside_workspace(Path::new(root), Path::new(path))
    }
    .map_err(crate::stores::to_string)?;
    require_resolved(app, &resolved)
}

fn require_resolved(app: &tauri::AppHandle, path: &Path) -> Result<(), String> {
    // Exact file picks (including Save As) authorize that file, not its parent.
    if app.asset_protocol_scope().is_allowed(path)
        || access()?.grants.as_ref().unwrap().allows(path)
    {
        Ok(())
    } else {
        Err("File access is outside the approved workspace folders. Open the folder first.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn workspace_grants_do_not_authorize_parent_or_sibling_prefix() {
        let grants = Grants {
            roots: [PathBuf::from("/projects/café notes")].into(),
        };
        assert!(grants.allows(Path::new("/projects/café notes/src/main.rs")));
        assert!(!grants.allows(Path::new("/projects")));
        assert!(!grants.allows(Path::new("/projects/café notes-other/file")));
        assert!(!grants.allows(Path::new("/outside/file")));
    }
    #[test]
    fn corrupt_workspace_grants_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("grants.json");
        assert!(Grants::load(&file).unwrap().roots.is_empty());
        std::fs::write(&file, b"invalid").unwrap();
        assert!(Grants::load(&file).is_err());
        std::fs::write(&file, br#"{"roots":["relative"]}"#).unwrap();
        assert!(Grants::load(&file).is_err());
    }

    #[test]
    #[cfg(unix)]
    fn workspace_grants_reject_forged_root_and_external_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap().join("approved");
        let outside = temp.path().canonicalize().unwrap().join("outside");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("secret"), "sentinel").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        let grants = Grants {
            roots: [root.clone()].into(),
        };
        let forged =
            gyro_core::security::assert_path_inside_workspace(&outside, Path::new("secret"))
                .unwrap();
        assert!(!grants.allows(&forged));
        assert!(gyro_core::security::assert_path_inside_workspace(
            &root,
            Path::new("../outside/secret")
        )
        .is_err());
        assert!(
            gyro_core::security::assert_path_inside_workspace(&root, Path::new("link/secret"))
                .is_err()
        );
        // Renaming the symlink entry is allowed; following its target is not.
        let link =
            gyro_core::security::assert_entry_inside_workspace(&root, Path::new("link")).unwrap();
        assert!(grants.allows(&link));
    }
}
