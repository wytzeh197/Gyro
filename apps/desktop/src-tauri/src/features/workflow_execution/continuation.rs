//! Explicit retries require inspection and a bounded current workspace witness.
use super::{notify, preflight, root_lease, root_scope};
use crate::{
    git::{commands::git_command, read},
    providers::session_lifecycle::ProviderSessionLease,
    stores::open_automation_store,
};
use anyhow::{ensure, Result};
use gyro_core::{
    workflows::*, AutomationExecutionContext, AutomationSchedule, AutomationStatus,
    CreateAutomationRequest, SessionStore, SessionWorkspaceMode,
};
use serde_json::{json, Value};
use std::{
    path::Path,
    time::{Duration, Instant},
};
use tauri::Manager;
use uuid::Uuid;
fn git(root: &Path, args: &[&str]) -> Result<String> {
    let mut command = git_command();
    command
        .args(["--no-lazy-fetch", "--literal-pathspecs", "-C"])
        .arg(root)
        .args(args);
    let output = read::run(
        &command,
        Instant::now() + Duration::from_secs(10),
        2 * 1024 * 1024,
    )?;
    ensure!(
        output.succeeded() && !output.stdout_truncated,
        "Complete workspace witness is unavailable; inspect changes and start a new run instead"
    );
    Ok(output.stdout)
}
pub(super) fn fingerprint(root: &Path) -> Result<String> {
    let head = git(root, &["rev-parse", "--verify", "HEAD"])?;
    let status = git(
        root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    let diff = git(
        root,
        &["diff", "HEAD", "--binary", "--no-ext-diff", "--no-textconv"],
    )?;
    let untracked = git(root, &["ls-files", "--others", "--exclude-standard", "-z"])?;
    let paths: Vec<_> = untracked
        .split('\0')
        .filter(|path| !path.is_empty())
        .collect();
    ensure!(
        paths.len() <= 256,
        "Too many untracked files for a bounded retry witness; inspect them and start a new run"
    );
    let mut total = 0;
    let mut files = Vec::new();
    for path in paths {
        let bytes = gyro_core::project_memory::confined_bytes(root, path, 1024 * 1024)?
            .ok_or_else(|| anyhow::anyhow!("untracked file disappeared"))?;
        total += bytes.len();
        ensure!(
            total <= 16 * 1024 * 1024,
            "Untracked files exceed the retry witness budget"
        );
        files.push((path, gyro_core::mutations::content_hash(&bytes)));
    }
    Ok(gyro_core::mutations::content_hash(&serde_json::to_vec(&(
        head, status, diff, files,
    ))?))
}
pub(super) fn request(
    app: &tauri::AppHandle,
    store: &SessionStore,
    action: &str,
    payload: &Value,
) -> Result<Value> {
    let id: Uuid = serde_json::from_value(payload["runId"].clone())?;
    if action == "retry" {
        let operation: Uuid = serde_json::from_value(payload["operationId"].clone())?;
        let jobs = open_automation_store().map_err(anyhow::Error::msg)?;
        if let Some(job) = jobs.get_automation(operation)? {
            ensure!(
                job.execution
                    .workflow_binding
                    .as_ref()
                    .and_then(|binding| binding.continuation.as_ref())
                    .is_some_and(|continuation| continuation.run_id == id),
                "retry operation belongs to another run"
            );
            let job = jobs.queue_manual_workflow_once(job.id)?;
            crate::automation::commands::emit_automation_update(app, &job);
            app.state::<crate::automation::runtime::AutomationSchedulerControl>()
                .wake();
            return Ok(json!(job));
        }
    }
    let mut prior = store
        .workflow_run(id)?
        .ok_or_else(|| anyhow::anyhow!("workflow is unavailable"))?;
    ensure!(
        matches!(
            prior.status,
            WorkflowRunStatus::Waiting
                | WorkflowRunStatus::Interrupted
                | WorkflowRunStatus::Cancelled
                | WorkflowRunStatus::Failed
        ),
        "Only stopped unfinished runs can be retried"
    );
    let original = store
        .get_session(prior.source_session_id)?
        .ok_or_else(|| anyhow::anyhow!("workflow source is unavailable"))?;
    let source = original
        .parent_session_id
        .ok_or_else(|| anyhow::anyhow!("original project session is unavailable"))?;
    let (session, root_id, root) = root_scope(store, &source.to_string(), None)?;
    ensure!(
        root.to_string_lossy() == prior.root_key,
        "workflow root changed"
    );
    let Some(_operation) = ProviderSessionLease::try_acquire(store.paths(), prior.operation_id)?
    else {
        anyhow::bail!("Previous attempt is still stopping; retry shortly")
    };
    let Some(_root) = root_lease(store.paths(), &root)? else {
        anyhow::bail!("Another workflow owns this checkout")
    };
    let index = prior
        .steps
        .iter()
        .position(|step| step.status != WorkflowStepStatus::Completed)
        .ok_or_else(|| anyhow::anyhow!("No unfinished steps remain"))?;
    let witness = fingerprint(&root)?;
    if action == "retry-preview" {
        return Ok(
            json!({"revision":prior.revision,"workspaceFingerprint":witness,"stepId":prior.steps[index].step_id,"completedSteps":index,"message":"Inspect the recorded actions in each step. The unfinished step will get a fresh attempt and may repeat side effects; completed steps will be retained. Current permissions and the original inputs remain in force."}),
        );
    }
    ensure!(
        payload["reviewedActions"].as_bool() == Some(true)
            && payload["revision"].as_u64() == Some(prior.revision)
            && payload["workspaceFingerprint"].as_str() == Some(witness.as_str()),
        "Run or workspace changed; inspect it again before retrying"
    );
    let operation: Uuid = serde_json::from_value(payload["operationId"].clone())?;
    let jobs = open_automation_store().map_err(anyhow::Error::msg)?;
    if let Some(job) = jobs.get_automation(operation)? {
        ensure!(
            job.execution
                .workflow_binding
                .as_ref()
                .and_then(|binding| binding.continuation.as_ref())
                .is_some_and(|continuation| continuation.run_id == id),
            "retry operation belongs to another run"
        );
        return Ok(json!(job));
    }
    let mut pinned = WorkflowAutomationBinding {
        continuation: None,
        source_session_id: source,
        root_id,
        definition: prior.definition.clone(),
        binding: prior.binding.clone(),
    };
    preflight::check(
        app,
        store,
        &pinned,
        &root,
        &[prior.source_session_id],
        false,
    )?;
    if prior.status == WorkflowRunStatus::Waiting {
        prior = store.stop_workflow_run(
            id,
            prior.revision,
            WorkflowRunStatus::Interrupted,
            "Explicit continuation requested after inspecting recorded actions",
        )?;
        notify(app, &prior);
    }
    pinned.continuation = Some(WorkflowContinuation {
        run_id: id,
        revision: prior.revision,
        workspace_fingerprint: witness,
    });
    let role = preflight::first_agent(&pinned.definition)?;
    let first = pinned.binding.roles[role].clone();
    let job = jobs.create_workflow_automation(
        CreateAutomationRequest {
            title: format!("Continue {}", prior.definition.name),
            prompt: format!("Explicit continuation of workflow {id}"),
            schedule: AutomationSchedule::Manual,
            project: root
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            provider: first.provider_id.clone(),
            branch: session.branch,
            workspace_mode: SessionWorkspaceMode::Local,
            worktree_name: None,
            stop_condition: None,
            next_run_at: None,
            execution: AutomationExecutionContext {
                workflow_binding: Some(pinned),
                workspace_path: Some(root.to_string_lossy().into_owned()),
                provider_id: Some(first.provider_id),
                model_id: Some(first.model_id),
                ..Default::default()
            },
        },
        operation,
    )?;
    ensure!(
        job.status == AutomationStatus::Current,
        "continuation job is paused"
    );
    let job = jobs.queue_manual_workflow_once(job.id)?;
    crate::automation::commands::emit_automation_update(app, &job);
    app.state::<crate::automation::runtime::AutomationSchedulerControl>()
        .wake();
    Ok(json!(job))
}
