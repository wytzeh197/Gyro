//! GitHub workflow and pull request commands.

use crate::{
    git_current_branch, to_string, workspace_root, GithubCreatePullRequestRequest,
    GithubPullRequestsRequest, GithubWorkflowRunRequest, GithubWorkflowRunsRequest,
    GithubWorkspaceRequest,
};

#[tauri::command]
pub(crate) async fn github_status(
    request: GithubWorkspaceRequest,
) -> Result<gyro_core::GithubAvailability, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = workspace_root(&request.workspace_path).map_err(to_string)?;
        Ok(gyro_core::github_availability(&root))
    })
    .await
    .map_err(|error| format!("github status worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn github_workflow_runs(
    request: GithubWorkflowRunsRequest,
) -> Result<Vec<gyro_core::GithubWorkflowRun>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = workspace_root(&request.workspace_path).map_err(to_string)?;
        gyro_core::list_workflow_runs(
            &root,
            request.branch.as_deref(),
            request.limit.unwrap_or(20),
        )
        .map_err(to_string)
    })
    .await
    .map_err(|error| format!("github workflow runs worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn github_workflow_run_detail(
    request: GithubWorkflowRunRequest,
) -> Result<gyro_core::GithubWorkflowRunDetail, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = workspace_root(&request.workspace_path).map_err(to_string)?;
        gyro_core::workflow_run_detail(&root, request.run_id).map_err(to_string)
    })
    .await
    .map_err(|error| format!("github workflow detail worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn github_workflow_logs(
    request: GithubWorkflowRunRequest,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = workspace_root(&request.workspace_path).map_err(to_string)?;
        gyro_core::workflow_run_logs(&root, request.run_id, request.failed_only).map_err(to_string)
    })
    .await
    .map_err(|error| format!("github workflow logs worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn github_rerun_workflow(request: GithubWorkflowRunRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = workspace_root(&request.workspace_path).map_err(to_string)?;
        gyro_core::rerun_workflow(&root, request.run_id, request.failed_only).map_err(to_string)
    })
    .await
    .map_err(|error| format!("github rerun worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn github_pull_requests(
    request: GithubPullRequestsRequest,
) -> Result<Vec<gyro_core::GithubPullRequest>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = workspace_root(&request.workspace_path).map_err(to_string)?;
        let mut requests =
            gyro_core::list_pull_requests(&root, request.limit.unwrap_or(20)).map_err(to_string)?;
        if let Some(branch) = git_current_branch(&root) {
            if !requests.iter().any(|request| request.head_ref == branch) {
                if let Some(current) =
                    gyro_core::pull_request_for_branch(&root, &branch).map_err(to_string)?
                {
                    requests.insert(0, current);
                }
            }
        }
        Ok(requests)
    })
    .await
    .map_err(|error| format!("github pull requests worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn github_create_pull_request(
    request: GithubCreatePullRequestRequest,
) -> Result<gyro_core::GithubPullRequest, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = workspace_root(&request.workspace_path).map_err(to_string)?;
        gyro_core::create_pull_request(&root, &request.pull_request).map_err(to_string)
    })
    .await
    .map_err(|error| format!("github pull request worker failed: {error}"))?
}
