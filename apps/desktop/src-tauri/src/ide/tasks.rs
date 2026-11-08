//! Workspace task and test commands.

use crate::{
    command_execution::run_workspace_task_output_with_cancellation,
    ide::{
        task_discovery::{
            custom_task_create_impl, custom_task_delete_impl, task_discover_impl,
            test_discover_impl,
        },
        types::{
            CustomTaskCreateRequest, CustomTaskDeleteRequest, IdeCommandOutput, TaskCancelRequest,
            TaskDefinitionResult, TaskRunRequest, TestRunRequest, TestTreeItemResult,
        },
    },
    providers::process::command_with_gui_path,
    state::managers::{cancel_task_run, IdeCommandAdmission, TaskRunHandle},
    stores::to_string,
    workspace::files::{assert_workspace_path, workspace_root},
};
use std::{
    path::{Path, PathBuf},
    process::Command,
};

#[tauri::command]
pub(crate) async fn task_discover(
    workspace_path: String,
) -> Result<Vec<TaskDefinitionResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        task_discover_impl(&workspace_path).map_err(to_string)
    })
    .await
    .map_err(|error| format!("task discover worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn task_run(request: TaskRunRequest) -> Result<IdeCommandOutput, String> {
    tauri::async_runtime::spawn_blocking(move || task_run_blocking(request))
        .await
        .map_err(|error| format!("task run worker failed: {error}"))?
}

pub(crate) fn task_working_directory(root: &Path, cwd: Option<&str>) -> Result<PathBuf, String> {
    match cwd.map(str::trim).filter(|value| !value.is_empty()) {
        Some(relative) => {
            let resolved = assert_workspace_path(root, relative).map_err(to_string)?;
            if !resolved.is_dir() {
                return Err("task working directory is missing from this workspace".into());
            }
            Ok(resolved)
        }
        None => Ok(root.to_path_buf()),
    }
}

/// A task started from the desktop has no terminal available for package-manager
/// prompts. pnpm documents `CI=1` as the noninteractive mode, which lets a
/// user-requested task repair its module layout instead of aborting before it
/// runs.
pub(crate) fn configure_noninteractive_task_environment(command: &mut Command, program: &str) {
    if Path::new(program)
        .file_name()
        .is_some_and(|name| name == "pnpm")
    {
        command.env("CI", "1");
    }
}

pub(crate) fn task_run_blocking(request: TaskRunRequest) -> Result<IdeCommandOutput, String> {
    let _admission = IdeCommandAdmission::acquire()?;
    let root = workspace_root(&request.workspace_path).map_err(to_string)?;
    let task = task_discover_impl(&request.workspace_path)
        .map_err(to_string)?
        .into_iter()
        .find(|task| task.id == request.task_id)
        .ok_or_else(|| "task is no longer present in the workspace".to_string())?;
    if request.command != task.command || request.args != task.args {
        return Err("task definition changed; refresh tasks before running it".into());
    }
    let working_directory = task_working_directory(&root, task.cwd.as_deref())?;
    let mut command = command_with_gui_path(&task.command);
    command.current_dir(working_directory).args(&task.args);
    configure_noninteractive_task_environment(&mut command, &task.command);
    let handle = TaskRunHandle::register(&root, &task.id);
    let mut output =
        run_workspace_task_output_with_cancellation(command, handle.token()).map_err(to_string)?;
    if output.status == "done" {
        output.stdout = format!("task {} completed\n{}", task.id, output.stdout);
    }
    Ok(output)
}

#[tauri::command]
pub(crate) async fn task_create_custom(
    request: CustomTaskCreateRequest,
) -> Result<Vec<TaskDefinitionResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        custom_task_create_impl(&request).map_err(to_string)
    })
    .await
    .map_err(|error| format!("custom task create worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn task_delete_custom(
    request: CustomTaskDeleteRequest,
) -> Result<Vec<TaskDefinitionResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        custom_task_delete_impl(&request).map_err(to_string)
    })
    .await
    .map_err(|error| format!("custom task delete worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn task_cancel(request: TaskCancelRequest) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = workspace_root(&request.workspace_path).map_err(to_string)?;
        Ok(cancel_task_run(&root, &request.task_id))
    })
    .await
    .map_err(|error| format!("task cancel worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn test_discover(
    workspace_path: String,
) -> Result<Vec<TestTreeItemResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        test_discover_impl(&workspace_path).map_err(to_string)
    })
    .await
    .map_err(|error| format!("test discover worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn test_run(request: TestRunRequest) -> Result<IdeCommandOutput, String> {
    tauri::async_runtime::spawn_blocking(move || test_run_blocking(request))
        .await
        .map_err(|error| format!("test run worker failed: {error}"))?
}

pub(crate) fn test_run_blocking(request: TestRunRequest) -> Result<IdeCommandOutput, String> {
    let _admission = IdeCommandAdmission::acquire()?;
    let root = workspace_root(&request.workspace_path).map_err(to_string)?;
    let discovered = task_discover_impl(&request.workspace_path).map_err(to_string)?;
    let requested_ids = request.test_ids.as_deref().unwrap_or_default();
    if requested_ids.len() > 1 {
        return Err("run one native-discovered test task at a time".into());
    }
    let task = if let Some(test_id) = requested_ids.first() {
        discovered
            .into_iter()
            .find(|task| task.group == "test" && task.id == *test_id)
    } else {
        discovered.into_iter().find(|task| task.group == "test")
    }
    .ok_or_else(|| "no native-discovered test task is available".to_string())?;
    if request
        .command
        .as_ref()
        .is_some_and(|command| command != &task.command)
        || request.args.as_ref().is_some_and(|args| args != &task.args)
    {
        return Err("test definition changed; refresh tests before running it".into());
    }
    let working_directory = task_working_directory(&root, task.cwd.as_deref())?;
    let mut command = command_with_gui_path(&task.command);
    command.current_dir(working_directory).args(&task.args);
    configure_noninteractive_task_environment(&mut command, &task.command);
    let handle = TaskRunHandle::register(&root, &task.id);
    let mut output =
        run_workspace_task_output_with_cancellation(command, handle.token()).map_err(to_string)?;
    output.stdout = format!("tests {:?}\n{}", vec![task.id], output.stdout);
    Ok(output)
}
