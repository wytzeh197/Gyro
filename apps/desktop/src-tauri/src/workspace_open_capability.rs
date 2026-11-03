//! `gyro_workspace_open_folder`: point Gyro at a local folder the user named.
//!
//! A chat with no folder works in a private scratch workspace, so a request
//! such as "open my website checkout" used to end with the model telling the
//! user to use the Open workspace button. This opens the folder the way that
//! button does: the app switches to the project and shows a fresh chat bound
//! to it. The chat that asked keeps its own workspace, because a provider turn
//! is bound to its root for as long as it runs and cannot be moved under it.
//!
//! The call only validates the folder and reports it. The desktop frontend
//! performs the switch when it receives the `workspace` resource, and only
//! while the asking chat is still the one on screen.
use super::*;
use serde_json::{json, Value};

const MAX_FOLDER_PATH_CHARS: usize = 4_096;

pub(super) fn execute(
    request: &CapabilityRequest,
) -> anyhow::Result<(String, Value, Option<CapabilityResourceRef>)> {
    let raw = capability_argument_string(&request.arguments, "path")?;
    let paths = GyroPaths::for_current_user()?;
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let folder = resolve_folder(raw, home.as_deref(), &paths.base_dir)?;
    let display = folder.display().to_string();
    let name = folder
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| display.clone());
    let branch = git_branch_catalog_impl(&display)
        .ok()
        .filter(|catalog| catalog.available)
        .and_then(|catalog| catalog.current);
    let resource = CapabilityResourceRef {
        id: format!("workspace-open:{}:{display}", request.context.session_id),
        kind: "workspace".into(),
        label: name.clone(),
    };
    Ok((
        format!("Opened {name} in Gyro"),
        json!({
            "path": display,
            "name": name,
            "branch": branch,
            "message": "Gyro switched to this folder and a new chat there is ready for the user. This chat's own workspace did not change, so its tools still read the previous workspace.",
        }),
        Some(resource),
    ))
}

/// Resolve what the model passed to a real directory.
///
/// The path must be absolute once a leading `~` is expanded, and must exist as
/// a directory. Anything inside Gyro's own data directory is refused: that is
/// where other chats' private workspaces, settings, and sockets live, and no
/// chat should be pointed at them by name.
fn resolve_folder(raw: &str, home: Option<&Path>, data_root: &Path) -> anyhow::Result<PathBuf> {
    if raw.contains('\0') || raw.chars().count() > MAX_FOLDER_PATH_CHARS {
        anyhow::bail!("folder path is invalid");
    }
    let expanded = match raw {
        "~" => home.map(Path::to_path_buf),
        _ => match raw.strip_prefix("~/") {
            Some(rest) => home.map(|home| home.join(rest)),
            None => Some(PathBuf::from(raw)),
        },
    }
    .ok_or_else(|| {
        anyhow::anyhow!("the home folder could not be resolved; pass an absolute path")
    })?;
    if !expanded.is_absolute() {
        anyhow::bail!("pass an absolute folder path such as /Users/name/project");
    }
    let folder = expanded
        .canonicalize()
        .map_err(|_| anyhow::anyhow!("{} does not exist", expanded.display()))?;
    if !folder.is_dir() {
        anyhow::bail!("{} is not a folder", folder.display());
    }
    // The data root may not exist yet in a fresh profile; then nothing can be
    // inside it either.
    if let Ok(data_root) = data_root.canonicalize() {
        if folder.starts_with(&data_root) {
            anyhow::bail!("Gyro's own data folder cannot be opened as a workspace");
        }
    }
    Ok(folder)
}

pub(super) fn schema(id: CapabilityId) -> Option<(Value, Vec<&'static str>)> {
    match id {
        CapabilityId::WorkspaceOpenFolder => Some((
            json!({
                "path": {
                    "type": "string",
                    "maxLength": MAX_FOLDER_PATH_CHARS,
                    "description": "Absolute path of the folder to open, for example /Users/name/Developer/site. A leading ~/ is expanded."
                }
            }),
            vec!["path"],
        )),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_an_existing_directory_by_its_canonical_path() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let site = temp.path().join("site");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&site).unwrap();
        let resolved = resolve_folder(site.to_str().unwrap(), None, &data).unwrap();
        assert_eq!(resolved, site.canonicalize().unwrap());
    }

    #[test]
    fn expands_a_leading_tilde_against_the_home_folder() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let home = temp.path().join("home");
        std::fs::create_dir_all(home.join("Developer/site")).unwrap();
        let resolved = resolve_folder("~/Developer/site", Some(&home), &data).unwrap();
        assert_eq!(
            resolved,
            home.join("Developer/site").canonicalize().unwrap()
        );
        assert_eq!(
            resolve_folder("~", Some(&home), &data).unwrap(),
            home.canonicalize().unwrap()
        );
        assert!(resolve_folder("~/Developer/site", None, &data).is_err());
    }

    #[test]
    fn refuses_what_is_not_an_absolute_existing_directory() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let file = temp.path().join("notes.txt");
        std::fs::write(&file, "x").unwrap();
        assert!(resolve_folder("Developer/site", None, &data).is_err());
        assert!(resolve_folder("", None, &data).is_err());
        assert!(resolve_folder("a\0b", None, &data).is_err());
        assert!(
            resolve_folder(temp.path().join("missing").to_str().unwrap(), None, &data).is_err()
        );
        assert!(resolve_folder(file.to_str().unwrap(), None, &data).is_err());
    }

    #[test]
    fn refuses_folders_inside_gyros_own_data_directory() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let private = data.join("sessions/workspaces/other-chat");
        std::fs::create_dir_all(&private).unwrap();
        assert!(resolve_folder(private.to_str().unwrap(), None, &data).is_err());
        assert!(resolve_folder(data.to_str().unwrap(), None, &data).is_err());
        // A sibling that merely shares a name prefix is not inside it.
        let sibling = temp.path().join("data-site");
        std::fs::create_dir_all(&sibling).unwrap();
        assert!(resolve_folder(sibling.to_str().unwrap(), None, &data).is_ok());
    }

    #[test]
    fn schema_requires_a_path_and_only_this_capability_owns_it() {
        let (properties, required) = schema(CapabilityId::WorkspaceOpenFolder).unwrap();
        assert!(properties["path"].is_object());
        assert_eq!(required, vec!["path"]);
        assert!(schema(CapabilityId::WorkspaceRead).is_none());
    }
}
