//! Workspace root inspection for the Explorer, project settings, and
//! workspace-file import. Policy lives in `packages/ui/src/workspace-roots.ts`;
//! see `gyro_core::workspace_roots` for the status contract.

use gyro_core::workspace_roots::{inspect_workspace_roots, WorkspaceRootInspection};

/// Canonical identity and health for each path, in request order.
///
/// Runs off the async runtime: `canonicalize` on an unmounted network volume
/// can block for seconds, and the Explorer re-inspects on every activation.
#[tauri::command]
pub(crate) async fn inspect_workspace_folders(
    paths: Vec<String>,
) -> Result<Vec<WorkspaceRootInspection>, String> {
    tauri::async_runtime::spawn_blocking(move || inspect_workspace_roots(&paths))
        .await
        .map_err(|error| format!("workspace folder inspection failed: {error}"))
}
