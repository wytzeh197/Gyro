//! Ide types.

use crate::default_custom_task_group;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    process::ChildStdin,
    sync::{mpsc, Arc, Mutex},
};
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IdeCommandOutput {
    pub(crate) status: String,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) exit_code: Option<i32>,
    pub(crate) source_truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskDefinitionResult {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) command: String,
    pub(crate) args: Vec<String>,
    pub(crate) group: String,
    pub(crate) cwd: Option<String>,
    pub(crate) status: String,
    pub(crate) output_channel_id: Option<String>,
    /// "suggested" for tasks detected from manifests, "custom" for saved commands.
    pub(crate) source: String,
    /// Which manifest family produced the command: node, cargo, make, just,
    /// python, go, deno, or custom.
    pub(crate) toolchain: String,
    /// Repo-relative directory when the command belongs to a workspace member.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) package_path: Option<String>,
    /// "primary" is a front door. "variant" is a sibling such as `test:unit`.
    pub(crate) role: String,
}

/// A command the person saved for this workspace, persisted in `.gyro/tasks.json`.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CustomTaskRecord {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) command: String,
    #[serde(default)]
    pub(crate) args: Vec<String>,
    #[serde(default = "default_custom_task_group")]
    pub(crate) group: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) cwd: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CustomTaskFile {
    #[serde(default)]
    pub(crate) version: u32,
    #[serde(default)]
    pub(crate) tasks: Vec<CustomTaskRecord>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CustomTaskCreateRequest {
    pub(crate) workspace_path: String,
    pub(crate) command_line: String,
    pub(crate) label: Option<String>,
    pub(crate) group: Option<String>,
    pub(crate) cwd: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CustomTaskDeleteRequest {
    pub(crate) workspace_path: String,
    pub(crate) task_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskCancelRequest {
    pub(crate) workspace_path: String,
    pub(crate) task_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskRunRequest {
    pub(crate) workspace_path: String,
    pub(crate) task_id: String,
    pub(crate) command: String,
    pub(crate) args: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TestTreeItemResult {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) path: Option<String>,
    pub(crate) status: String,
    pub(crate) children: Vec<TestTreeItemResult>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TestRunRequest {
    pub(crate) workspace_path: String,
    pub(crate) test_ids: Option<Vec<String>>,
    pub(crate) command: Option<String>,
    pub(crate) args: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DebugStartRequest {
    pub(crate) workspace_path: Option<String>,
    pub(crate) name: String,
    pub(crate) adapter: String,
    pub(crate) command: Option<String>,
    pub(crate) args: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DebugSendRequest {
    pub(crate) session_id: String,
    pub(crate) request: serde_json::Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DebugSessionResult {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) adapter: String,
    pub(crate) status: String,
    pub(crate) message: Option<String>,
    pub(crate) capabilities: Vec<String>,
}

#[derive(Clone, Default)]
pub(crate) struct DebugAdapterManager {
    pub(crate) processes: Arc<Mutex<HashMap<String, Arc<Mutex<DebugAdapterProcess>>>>>,
}

pub(crate) struct DebugAdapterProcess {
    pub(crate) child: gyro_core::process_guard::GuardedChild,
    pub(crate) stdin: ChildStdin,
    pub(crate) messages: mpsc::Receiver<Result<serde_json::Value, String>>,
    pub(crate) next_sequence: u64,
    pub(crate) name: String,
    pub(crate) adapter: String,
    /// A launched debuggee is ours to terminate on stop; an attached one is not.
    pub(crate) launched: bool,
}

impl Drop for DebugAdapterProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
