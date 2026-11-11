//! Sequential recipes dispatched by the existing automation scheduler.
pub(crate) mod commands;
mod continuation;
mod deadline;
pub(crate) mod preflight;
mod steps;
mod tasks;
use crate::{
    automation::runtime::AutomationRunAdmission,
    features::scope::root_scope,
    providers::session_lifecycle::ProviderSessionLease,
    stores::{open_automation_store, open_store},
};
use anyhow::{ensure, Result};
use gyro_core::{
    workflows::*, Automation, AutomationRunStatus, AutomationSchedule, AutomationStatus,
    CreateSessionContext, GyroPaths, SessionOrigin, SessionStore, UsageOrigin,
};
use serde_json::json;
use tauri::Emitter;

pub(crate) fn notify(app: &tauri::AppHandle, run: &WorkflowRun) {
    let _=app.emit("gyro://workflow-run-changed",json!({"runId":run.id,"sourceSessionId":run.source_session_id,"revision":run.revision,"status":run.status}));
}
pub(crate) fn root_lease(
    paths: &GyroPaths,
    root: &std::path::Path,
) -> Result<Option<gyro_core::workflows::WorkflowCheckoutLease>> {
    gyro_core::workflows::WorkflowCheckoutLease::try_acquire(paths, root, true)
}
pub(crate) fn execute(
    app: &tauri::AppHandle,
    paths: &GyroPaths,
    automation: &Automation,
    admission: &AutomationRunAdmission,
    checkout: &WorkflowCheckoutLease,
) -> Result<String, String> {
    execute_inner(app, paths, automation, admission, checkout).map_err(|error| {
        let message = gyro_core::security::redact_secrets(&error.to_string());
        if message.contains("chat cancelled") {
            message
        } else if message.starts_with("Workflow execution completed") {
            format!("needs attention: {message}")
        } else {
            format!("configuration: {message}")
        }
    })
}
fn execute_inner(
    app: &tauri::AppHandle,
    paths: &GyroPaths,
    automation: &Automation,
    admission: &AutomationRunAdmission,
    checkout: &WorkflowCheckoutLease,
) -> Result<String> {
    let pinned = automation
        .execution
        .workflow_binding
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("workflow binding is unavailable"))?;
    let store = open_store().map_err(anyhow::Error::msg)?;
    let (_, _, root) = root_scope(
        &store,
        &pinned.source_session_id.to_string(),
        Some(&pinned.root_id),
    )?;
    ensure!(
        checkout.owns_exclusively(&root),
        "Scheduler checkout reservation does not match the workflow root"
    );
    ensure!(automation.workspace_mode==gyro_core::SessionWorkspaceMode::Local,"This workflow runner requires a local checkout; choose a separate authorized project/worktree as its root");
    ensure!(
        automation
            .execution
            .workspace_path
            .as_deref()
            .map(std::path::Path::new)
            .and_then(|path| path.canonicalize().ok())
            .as_ref()
            == Some(&root),
        "workflow job root changed"
    );
    preflight::check(app, &store, pinned, &root, &[], false)?;
    let receipt = automation
        .run_history
        .iter()
        .find(|receipt| {
            receipt.status == AutomationRunStatus::Running && receipt.finished_at.is_none()
        })
        .ok_or_else(|| anyhow::anyhow!("workflow scheduler receipt is unavailable"))?;
    let operation = receipt.id;
    let Some(_lease) = ProviderSessionLease::try_acquire(paths, operation)? else {
        anyhow::bail!("another host owns this workflow run");
    };
    if store.workflow_run_for_operation(operation)?.is_none() {
        if let Some(previous) = &pinned.continuation {
            ensure!(continuation::fingerprint(&root)? == previous.workspace_fingerprint, "Workspace changed while the continuation waited; inspect it again before a new retry");
        }
    }
    let run = if let Some(run) = store.workflow_run_for_operation(operation)? {
        run
    } else {
        let role = preflight::first_agent(&pinned.definition)?;
        let binding = &pinned.binding.roles[role];
        let source = if let Some(session) = receipt
            .session_id
            .and_then(|id| store.get_session(id).ok().flatten())
        {
            session
        } else {
            store.create_subagent_session(
                &root,
                SessionOrigin::Desktop,
                format!("Workflow: {}", pinned.definition.name),
                CreateSessionContext {
                    provider_id: Some(binding.provider_id.clone()),
                    model_id: Some(binding.model_id.clone()),
                    branch: automation.branch.clone(),
                    ..Default::default()
                },
                pinned.source_session_id,
            )?
        };
        let linked = open_automation_store()
            .map_err(anyhow::Error::msg)?
            .link_run_session(
                automation.id,
                automation
                    .lease_owner
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("scheduler lease is unavailable"))?,
                source.id,
            )?;
        crate::automation::commands::emit_automation_update(app, &linked);
        let origin = if automation.schedule == AutomationSchedule::Manual {
            UsageOrigin::Chat
        } else {
            UsageOrigin::Automation
        };
        store.create_workflow_run(
            operation,
            Some(automation.id),
            source.id,
            &source.workspace_identity.active_root_id,
            &root.to_string_lossy(),
            &pinned.definition,
            &pinned.binding,
            origin,
        )?
    };
    let run = if let Some(previous) = &pinned.continuation {
        store.inherit_completed_workflow_steps(run.id, previous.run_id, previous.revision)?
    } else {
        run
    };
    ensure!(
        run.definition == pinned.definition
            && run.binding == pinned.binding
            && run.root_key == root.to_string_lossy(),
        "pinned workflow launch changed"
    );
    if run.status.terminal() {
        return finish_summary(&run);
    }
    let _deadline = deadline::RunDeadline::start(app.clone(), run.id);
    let result = run_steps(app, &store, automation, pinned, run.clone(), admission);
    match result {
        Ok(completed) => finish_summary(&completed),
        Err(error) => {
            if let Some(current) = store.workflow_run(run.id)? {
                if !current.status.terminal() && current.status != WorkflowRunStatus::Waiting {
                    let stopped = store.stop_workflow_run(
                        current.id,
                        current.revision,
                        WorkflowRunStatus::Waiting,
                        &error.to_string(),
                    )?;
                    notify(app, &stopped);
                }
                if current.status == WorkflowRunStatus::Cancelled {
                    return Err(anyhow::anyhow!("chat cancelled: workflow stopped by you"));
                }
            }
            Err(error)
        }
    }
}
fn run_steps(
    app: &tauri::AppHandle,
    store: &SessionStore,
    automation: &Automation,
    pinned: &WorkflowAutomationBinding,
    mut run: WorkflowRun,
    admission: &AutomationRunAdmission,
) -> Result<WorkflowRun> {
    for index in 0..run.steps.len() {
        run = store
            .workflow_run(run.id)?
            .ok_or_else(|| anyhow::anyhow!("workflow was deleted"))?;
        ensure!(
            !run.status.terminal() && run.status != WorkflowRunStatus::Waiting,
            "workflow was stopped or needs attention"
        );
        if run.steps[index].status == WorkflowStepStatus::Completed {
            continue;
        }
        ensure!(run.steps[index].status==WorkflowStepStatus::Pending,"An interrupted step needs an explicit new attempt; it cannot be replayed automatically");
        let job = open_automation_store()
            .map_err(anyhow::Error::msg)?
            .get_automation(automation.id)?
            .ok_or_else(|| anyhow::anyhow!("workflow schedule was deleted"))?;
        ensure!(
            job.status == AutomationStatus::Current
                && job.lease_owner == automation.lease_owner
                && job.execution.workflow_binding.as_ref() == Some(pinned),
            "workflow schedule stopped or changed"
        );
        let owned: Vec<_> = std::iter::once(run.source_session_id)
            .chain(run.steps.iter().filter_map(|step| step.session_id))
            .collect();
        preflight::check(
            app,
            store,
            pinned,
            std::path::Path::new(&run.root_key),
            &owned,
            false,
        )?;
        notify(app, &run);
        run = steps::execute(app, store, automation, &run, index, admission)?;
        notify(app, &run);
    }
    Ok(run)
}
fn finish_summary(run: &WorkflowRun) -> Result<String> {
    ensure!(
        run.status == WorkflowRunStatus::Completed,
        "workflow {:?}: {}",
        run.status,
        run.error.as_deref().unwrap_or("inspect the recorded steps")
    );
    ensure!(run.requirements_met==Some(true),"Workflow execution completed and needs attention: review findings, verification or required outputs remain unmet");
    Ok(format!("Workflow {} completed; all recorded requirements met. Inspect the linked steps and verification receipts.",run.definition.name))
}
pub(crate) fn recover(app: tauri::AppHandle) {
    let Ok(store) = open_store() else {
        return;
    };
    let Ok(runs) = store.workflow_runs(None) else {
        return;
    };
    for run in runs {
        if !run.status.terminal() {
            let Ok(Some(_lease)) =
                ProviderSessionLease::try_acquire(store.paths(), run.operation_id)
            else {
                continue;
            };
            if let Ok(interrupted)=store.stop_workflow_run(run.id,run.revision,WorkflowRunStatus::Interrupted,"Workflow interrupted by restart. Completed steps are preserved; inspect side effects before an explicit continuation."){notify(&app,&interrupted);if let Some(id)=run.automation_id{if let Ok(jobs)=open_automation_store(){let _=jobs.set_automation_status(id,AutomationStatus::Paused);}}}
        }
    }
}
