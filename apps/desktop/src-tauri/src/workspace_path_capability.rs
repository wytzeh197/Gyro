//! Model-facing file lifecycle inside the Workspace: create, rename or move,
//! and delete.
//!
//! These run through the same root-asserted helpers the Workspace explorer
//! calls, so a model cannot take a lifecycle shortcut the user interface does
//! not have. The capability class is `WorkspaceWrite`, which the broker treats
//! as Ask: Full Access in a normal run applies the change immediately, and any
//! other posture asks the user first. Plan and Council never reach the
//! filesystem, because their policy denies the class outright.
use super::*;
use crate::workspace_edit_capability::assert_no_unsaved_editor_changes;
use serde_json::{json, Value};

const WORKSPACE_PATH_SCHEMA: &str = "gyro.workspace-path.v1";

/// Everything the arguments say, before anything touches the filesystem.
#[derive(Debug, PartialEq)]
struct LifecycleRequest {
    path: String,
    kind: Option<String>,
    destination: Option<String>,
    expected_hash: Option<String>,
}

pub(super) fn execute(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    request: &CapabilityRequest,
) -> anyhow::Result<(String, Value, Option<CapabilityResourceRef>)> {
    let parsed = parse_arguments(request.capability_id, &request.arguments)?;
    let path = parsed.path.clone();
    assert_no_unsaved_editor_changes(app, bound, &path)?;
    let workspace_path = bound.workspace.to_string_lossy().to_string();
    let (summary, resource_label, data) = match request.capability_id {
        CapabilityId::WorkspaceCreatePath => {
            let kind = parsed.kind.clone().unwrap_or_default();
            create_workspace_path_impl(&WorkspacePathCreateRequest {
                workspace_path,
                path: path.clone(),
                kind: kind.clone(),
            })?;
            (
                format!("Created {kind} {path}"),
                path.clone(),
                json!({ "schema": WORKSPACE_PATH_SCHEMA, "action": "create", "path": path, "kind": kind }),
            )
        }
        CapabilityId::WorkspaceRenamePath => {
            let destination = parsed.destination.clone().unwrap_or_default();
            assert_no_unsaved_editor_changes(app, bound, &destination)?;
            rename_workspace_path_impl(&WorkspacePathRenameRequest {
                workspace_path,
                from_path: path.clone(),
                to_path: destination.clone(),
            })?;
            (
                format!("Renamed {path} to {destination}"),
                destination.clone(),
                json!({
                    "schema": WORKSPACE_PATH_SCHEMA,
                    "action": "rename",
                    "path": path,
                    "destination": destination,
                }),
            )
        }
        CapabilityId::WorkspaceDeletePath => {
            let candidate = assert_workspace_path(&bound.workspace, &path)?;
            assert_deletable(&candidate, &path, parsed.expected_hash.as_deref())?;
            delete_workspace_path_impl(&WorkspacePathDeleteRequest {
                workspace_path,
                path: path.clone(),
                expected_hash: parsed.expected_hash.clone(),
            })?;
            (
                format!("Deleted {path}"),
                path.clone(),
                json!({ "schema": WORKSPACE_PATH_SCHEMA, "action": "delete", "path": path }),
            )
        }
        other => anyhow::bail!("workspace_path_capability does not handle {other}"),
    };
    let resource = CapabilityResourceRef {
        id: format!("workspace:{}:{resource_label}", request.context.session_id),
        kind: "file".into(),
        label: resource_label,
    };
    Ok((summary, data, Some(resource)))
}

/// Validate the arguments for one lifecycle call. Kept separate from the
/// filesystem work so every refusal is a plain, testable decision.
fn parse_arguments(
    capability_id: CapabilityId,
    arguments: &Value,
) -> anyhow::Result<LifecycleRequest> {
    let path = gyro_core::normalize_capability_relative_path(capability_argument_string(
        arguments, "path",
    )?)?;
    let optional_string = |name: &str| {
        arguments
            .get(name)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    let request = match capability_id {
        CapabilityId::WorkspaceCreatePath => {
            let kind = capability_argument_string(arguments, "kind")?.to_ascii_lowercase();
            if kind != "file" && kind != "directory" {
                anyhow::bail!("capability argument `kind` must be `file` or `directory`");
            }
            LifecycleRequest {
                path,
                kind: Some(kind),
                destination: None,
                expected_hash: None,
            }
        }
        CapabilityId::WorkspaceRenamePath => {
            let destination = gyro_core::normalize_capability_relative_path(
                capability_argument_string(arguments, "destination")?,
            )?;
            if destination == path {
                anyhow::bail!("destination must differ from path");
            }
            LifecycleRequest {
                path,
                kind: None,
                destination: Some(destination),
                expected_hash: None,
            }
        }
        CapabilityId::WorkspaceDeletePath => LifecycleRequest {
            path,
            kind: None,
            destination: None,
            expected_hash: optional_string("expectedHash"),
        },
        other => anyhow::bail!("workspace_path_capability does not handle {other}"),
    };
    Ok(request)
}

/// Whether this exact path may be removed. Whether a path is a file or a
/// directory is only knowable from the filesystem, so the hash requirement for
/// files is decided here rather than while parsing arguments.
fn assert_deletable(
    candidate: &Path,
    path: &str,
    expected_hash: Option<&str>,
) -> anyhow::Result<()> {
    if !candidate.exists() {
        anyhow::bail!("{path} does not exist");
    }
    if candidate.is_dir() {
        // `remove_dir` refuses a populated directory anyway; say why in words
        // the model can act on instead of surfacing a bare OS error.
        if fs::read_dir(candidate)?.next().is_some() {
            anyhow::bail!("{path} is a directory that is not empty; delete its entries first");
        }
        return Ok(());
    }
    // A file is deleted against the hash the model last read, so a changed file
    // is never removed by a stale decision.
    if expected_hash.is_none() {
        anyhow::bail!("expectedHash is required when deleting a file; read it first");
    }
    Ok(())
}

/// Tool schemas live here so `lib.rs` keeps a single delegation guard instead
/// of one arm per capability.
pub(super) fn schema(id: CapabilityId) -> Option<(Value, Vec<&'static str>)> {
    let (properties, required) = match id {
        CapabilityId::WorkspaceCreatePath => (
            json!({
                "path": {
                    "type": "string",
                    "description": "Workspace-relative path to create."
                },
                "kind": {
                    "type": "string",
                    "enum": ["file", "directory"],
                    "description": "Create an empty file or a directory; missing parent directories are created too. Give a new file its content with gyro_workspace_propose_edit instead."
                }
            }),
            vec!["path", "kind"],
        ),
        CapabilityId::WorkspaceRenamePath => (
            json!({
                "path": { "type": "string", "description": "Existing workspace-relative path to rename or move." },
                "destination": {
                    "type": "string",
                    "description": "New workspace-relative path. Missing parent directories are created; an existing path is refused."
                }
            }),
            vec!["path", "destination"],
        ),
        CapabilityId::WorkspaceDeletePath => (
            json!({
                "path": { "type": "string", "description": "Workspace-relative path to delete. A directory must already be empty." },
                "expectedHash": {
                    "type": "string",
                    "description": "Hash returned when the file was read. Required for a file, so a changed file is never deleted by a stale decision."
                }
            }),
            vec!["path"],
        ),
        _ => return None,
    };
    Some((properties, required))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_requires_a_known_kind() {
        let directory = parse_arguments(
            CapabilityId::WorkspaceCreatePath,
            &json!({ "path": "src/new", "kind": "directory" }),
        )
        .unwrap();
        assert_eq!(directory.kind.as_deref(), Some("directory"));
        let mixed_case = parse_arguments(
            CapabilityId::WorkspaceCreatePath,
            &json!({ "path": "src/new", "kind": "File" }),
        )
        .unwrap();
        assert_eq!(mixed_case.kind.as_deref(), Some("file"));

        let error = parse_arguments(
            CapabilityId::WorkspaceCreatePath,
            &json!({ "path": "src/new", "kind": "symlink" }),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("file` or `directory"), "{error}");
    }

    #[test]
    fn paths_stay_inside_the_workspace() {
        for path in ["../escape", "/etc/passwd", "src/../../outside"] {
            let error = parse_arguments(
                CapabilityId::WorkspaceDeletePath,
                &json!({ "path": path, "expectedHash": "abc" }),
            )
            .unwrap_err()
            .to_string();
            assert!(
                error.contains("inside the current workspace"),
                "{path}: {error}"
            );
        }
    }

    #[test]
    fn rename_needs_a_different_destination() {
        let error = parse_arguments(
            CapabilityId::WorkspaceRenamePath,
            &json!({ "path": "src/a.ts", "destination": "src/a.ts" }),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("must differ"), "{error}");

        let moved = parse_arguments(
            CapabilityId::WorkspaceRenamePath,
            &json!({ "path": "src/a.ts", "destination": "lib/a.ts" }),
        )
        .unwrap();
        assert_eq!(moved.destination.as_deref(), Some("lib/a.ts"));
    }

    #[test]
    fn deleting_a_file_requires_the_hash_it_was_read_at() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("a.ts");
        fs::write(&file, "content").unwrap();

        let error = assert_deletable(&file, "a.ts", None)
            .unwrap_err()
            .to_string();
        assert!(error.contains("expectedHash is required"), "{error}");
        assert!(assert_deletable(&file, "a.ts", Some("deadbeef")).is_ok());

        let missing = temp.path().join("absent.ts");
        let error = assert_deletable(&missing, "absent.ts", Some("deadbeef"))
            .unwrap_err()
            .to_string();
        assert!(error.contains("does not exist"), "{error}");
    }

    #[test]
    fn a_populated_directory_is_refused_with_an_actionable_message() {
        let temp = tempfile::tempdir().unwrap();
        let empty = temp.path().join("empty");
        fs::create_dir(&empty).unwrap();
        // An empty directory needs no hash: there is no file content to guard.
        assert!(assert_deletable(&empty, "empty", None).is_ok());

        let full = temp.path().join("full");
        fs::create_dir(&full).unwrap();
        fs::write(full.join("child.txt"), "content").unwrap();
        let error = assert_deletable(&full, "full", None)
            .unwrap_err()
            .to_string();
        assert!(error.contains("not empty"), "{error}");
    }

    #[test]
    fn schemas_require_the_arguments_each_tool_needs() {
        let (_, required) = schema(CapabilityId::WorkspaceCreatePath).unwrap();
        assert_eq!(required, vec!["path", "kind"]);
        let (_, required) = schema(CapabilityId::WorkspaceRenamePath).unwrap();
        assert_eq!(required, vec!["path", "destination"]);
        let (properties, required) = schema(CapabilityId::WorkspaceDeletePath).unwrap();
        assert!(properties["expectedHash"].is_object());
        assert_eq!(required, vec!["path"]);
        assert!(schema(CapabilityId::WorkspaceRead).is_none());
    }
}
