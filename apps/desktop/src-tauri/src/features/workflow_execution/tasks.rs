//! Bind discovered tasks by identity, argv, working directory and manifest bytes.
use crate::ide::{task_discovery::task_discover_impl, types::TaskDefinitionResult};
use anyhow::{ensure, Result};
use gyro_core::{mutations::content_hash, project_memory::confined_bytes};
use serde_json::{json, Value};
use std::{collections::BTreeSet, path::Path};
fn source_hash(root: &Path, tasks: &[TaskDefinitionResult]) -> Result<String> {
    let mut directories = BTreeSet::from([String::new()]);
    for task in tasks {
        if let Some(path) = &task.package_path {
            directories.insert(path.clone());
        }
    }
    let mut sources = Vec::new();
    let mut total = 0;
    for directory in directories {
        for name in [
            "package.json",
            "Cargo.toml",
            "Makefile",
            "makefile",
            "Justfile",
            "justfile",
            "pyproject.toml",
            "go.mod",
            "deno.json",
            "deno.jsonc",
            "pnpm-workspace.yaml",
            ".gyro/tasks.json",
        ] {
            let path = if directory.is_empty() {
                name.into()
            } else {
                format!("{directory}/{name}")
            };
            if let Some(bytes) = confined_bytes(root, &path, 512 * 1024)? {
                total += bytes.len();
                ensure!(
                    total <= 16 * 1024 * 1024,
                    "Task manifests exceed the binding witness budget"
                );
                sources.push((path, content_hash(&bytes)));
            }
        }
    }
    Ok(content_hash(&serde_json::to_vec(&sources)?))
}
fn fingerprint(task: &TaskDefinitionResult, sources: &str) -> Result<String> {
    Ok(content_hash(&serde_json::to_vec(&(task, sources))?))
}
pub(super) fn choices(root: &Path) -> Result<Value> {
    let tasks = task_discover_impl(&root.to_string_lossy())?;
    let sources = source_hash(root, &tasks)?;
    let mut result = Vec::new();
    for task in &tasks {
        let mut value = serde_json::to_value(task)?;
        value["fingerprint"] = json!(fingerprint(task, &sources)?);
        result.push(value);
    }
    Ok(json!(result))
}
pub(super) fn bound(
    root: &Path,
    binding: &gyro_core::workflows::WorkflowBinding,
    id: &str,
) -> Result<TaskDefinitionResult> {
    let command = binding
        .commands
        .get(id)
        .ok_or_else(|| anyhow::anyhow!("Choose a verification task"))?;
    let argv = binding.command_argv(id)?;
    let tasks = task_discover_impl(&root.to_string_lossy())?;
    let sources = source_hash(root, &tasks)?;
    let task=tasks.into_iter().find(|task|Some(task.id.as_str())==command.task_id.as_deref()&&task.command==argv[0]&&task.args==argv[1..]).ok_or_else(||anyhow::anyhow!("Command binding {id} no longer matches its discovered task; explicitly reselect it"))?;
    ensure!(
        command.task_fingerprint.as_deref() == Some(fingerprint(&task, &sources)?.as_str()),
        "Verification task or its manifest changed; inspect and explicitly rebind {id}"
    );
    Ok(task)
}
