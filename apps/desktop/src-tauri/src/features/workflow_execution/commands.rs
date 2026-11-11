//! Explicit local launch/configuration commands. No launch occurs during discovery.
use super::{notify, preflight, root_scope};
use crate::{
    automation::{commands::emit_automation_update, runtime::AutomationSchedulerControl},
    state::provider_run::{stop_provider_run, ProviderStopReason},
    stores::{open_automation_store, open_store},
};
use anyhow::{ensure, Result};
use gyro_core::{
    workflows::*, AutomationExecutionContext, AutomationSchedule, CreateAutomationRequest,
    SessionWorkspaceMode,
};
use serde_json::{json, Value};
use tauri::Manager;
use uuid::Uuid;
pub(crate) fn stop_for_source(app: &tauri::AppHandle, source: Uuid) -> Result<()> {
    let store = open_store().map_err(anyhow::Error::msg)?;
    let tree = store.feature_session_tree(source)?;
    for session in &tree {
        for intent in store
            .review_fix_intents(Some(*session))?
            .into_iter()
            .filter(|intent| intent.status.active())
        {
            crate::features::code_reviews::fix_queue::cancel(app, &store, intent.id, *session)?;
            ensure!(
                crate::providers::session_lifecycle::ProviderSessionLease::try_acquire(
                    store.paths(),
                    intent.id
                )?
                .is_some(),
                "Fix request is stopping; retry deleting this chat shortly"
            );
        }
        crate::features::code_reviews::execution::stop_for_source(app, *session)?;
        crate::features::workflow_extraction::commands::stop_for_source(app, &store, *session)?;
    }
    for mut run in store.workflow_runs(None)? {
        if tree.contains(&run.source_session_id)
            || run
                .steps
                .iter()
                .any(|step| step.session_id.is_some_and(|id| tree.contains(&id)))
        {
            if !run.status.terminal() {
                run = cancel_run(app, &store, run.id, "Source chat deleted by you")?;
            }
            ensure!(
                crate::providers::session_lifecycle::ProviderSessionLease::try_acquire(
                    store.paths(),
                    run.operation_id
                )?
                .is_some(),
                "Workflow is stopping; retry deleting the source chat shortly"
            );
        }
    }
    if let Ok(jobs) = open_automation_store() {
        for job in jobs.list_automations()? {
            if job
                .execution
                .workflow_binding
                .as_ref()
                .is_some_and(|binding| tree.contains(&binding.source_session_id))
            {
                if let Some(updated) =
                    jobs.set_automation_status(job.id, gyro_core::AutomationStatus::Paused)?
                {
                    emit_automation_update(app, &updated);
                }
            }
        }
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn workflow_run_request(
    app: tauri::AppHandle,
    session_id: Option<String>,
    root_id: Option<String>,
    action: String,
    payload: Option<Value>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        request(
            &app,
            session_id.as_deref(),
            root_id.as_deref(),
            &action,
            payload.unwrap_or_else(|| json!({})),
        )
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}
fn request(
    app: &tauri::AppHandle,
    session_id: Option<&str>,
    root_id: Option<&str>,
    action: &str,
    payload: Value,
) -> Result<Value> {
    ensure!(
        serde_json::to_vec(&payload)?.len() <= 1024 * 1024,
        "workflow request is too large"
    );
    let store = open_store().map_err(anyhow::Error::msg)?;
    match action {
        "projects" => {
            let sessions = store.list_sessions_limited(Some(200))?;
            Ok(json!(sessions.into_iter().filter(|session|session.parent_session_id.is_none()&&!session.workspace_path.as_os_str().is_empty()).filter_map(|session|root_scope(&store,&session.id.to_string(),None).ok().map(|(_,root, path)|json!({"sessionId":session.id,"rootId":root,"title":session.title,"path":path}))).collect::<Vec<_>>()))
        }
        "retry-preview" | "retry" => super::continuation::request(app, &store, action, &payload),
        "runs" => Ok(json!(store.workflow_run_summaries()?)),
        "toggle-job" => {
            let id: Uuid = serde_json::from_value(payload["jobId"].clone())?;
            let jobs = open_automation_store().map_err(anyhow::Error::msg)?;
            let current = jobs
                .get_automation(id)?
                .ok_or_else(|| anyhow::anyhow!("workflow job is unavailable"))?;
            ensure!(
                current.execution.workflow_binding.is_some(),
                "job is not a workflow"
            );
            let paused = payload["paused"]
                .as_bool()
                .ok_or_else(|| anyhow::anyhow!("choose whether to pause the job"))?;
            if paused {
                for run in store
                    .workflow_runs(None)?
                    .into_iter()
                    .filter(|run| run.automation_id == Some(id) && !run.status.terminal())
                {
                    cancel_run(app, &store, run.id, "Schedule paused by you")?;
                }
                crate::automation::commands::cancel_scheduled_automation(app, id);
            }
            let job = jobs
                .set_automation_status(
                    id,
                    if paused {
                        gyro_core::AutomationStatus::Paused
                    } else {
                        gyro_core::AutomationStatus::Current
                    },
                )?
                .ok_or_else(|| anyhow::anyhow!("workflow job is unavailable"))?;
            emit_automation_update(app, &job);
            app.state::<AutomationSchedulerControl>().wake();
            Ok(json!(job))
        }
        "jobs" => Ok(json!(open_automation_store()
            .map_err(anyhow::Error::msg)?
            .list_automations()?
            .into_iter()
            .filter(|job| job.execution.workflow_binding.is_some())
            .collect::<Vec<_>>())),
        "get" => {
            let run = store
                .workflow_run(serde_json::from_value(payload["runId"].clone())?)?
                .ok_or_else(|| anyhow::anyhow!("workflow is unavailable"))?;
            let usage = store.session_usage_totals(run.source_session_id)?;
            let mut value = serde_json::to_value(&run)?;
            value["usage"] = json!(usage);
            Ok(value)
        }
        "delete" => {
            let id: Uuid = serde_json::from_value(payload["runId"].clone())?;
            let run = store
                .workflow_run(id)?
                .ok_or_else(|| anyhow::anyhow!("workflow is unavailable"))?;
            let _lease = crate::providers::session_lifecycle::ProviderSessionLease::try_acquire(
                store.paths(),
                run.operation_id,
            )?
            .ok_or_else(|| anyhow::anyhow!("Workflow is still stopping; retry shortly"))?;
            let jobs = open_automation_store().map_err(anyhow::Error::msg)?;
            ensure!(
                !jobs.list_automations()?.iter().any(|job| job.status
                    == gyro_core::AutomationStatus::Current
                    && job
                        .execution
                        .workflow_binding
                        .as_ref()
                        .and_then(|binding| binding.continuation.as_ref())
                        .is_some_and(|continuation| continuation.run_id == id)
                    && (job.next_run_at.is_some() || job.lease_owner.is_some())),
                "Cancel the queued continuation before deleting its prior evidence"
            );
            store.delete_workflow_run(
                id,
                payload["revision"]
                    .as_u64()
                    .ok_or_else(|| anyhow::anyhow!("run revision is required"))?,
            )?;
            notify(app, &run);
            Ok(json!({"deleted":true}))
        }
        "stop" => Ok(json!(cancel_run(
            app,
            &store,
            serde_json::from_value(payload["runId"].clone())?,
            "Stopped by you"
        )?)),
        _ => {
            let session_id =
                session_id.ok_or_else(|| anyhow::anyhow!("Choose a project session"))?;
            let (session, root_id, root) = root_scope(&store, session_id, root_id)?;
            if action == "project" {
                return Ok(
                    json!({"sessionId":session.id,"rootId":root_id,"title":session.title,"path":root}),
                );
            }
            if action == "setup" {
                let config = gyro_core::GyroConfig::load(store.paths())?;
                return Ok(
                    json!({"rootId":root_id,"roots":session.workspace_identity.roots,"providers":config.model_providers.iter().map(|provider|{let kind=gyro_core::provider_runtime::api_config::provider_adapter_with_kind(&provider.id,provider.kind.as_deref()).kind;json!({"id":provider.id,"label":provider.display_name,"enabled":provider.enabled,"modelIds":provider.model_ids,"reviewAvailable":matches!(kind,gyro_core::provider_runtime::types::ProviderAdapterKind::OpenAiCompatible|gyro_core::provider_runtime::types::ProviderAdapterKind::Ollama),"transport":if kind==gyro_core::provider_runtime::types::ProviderAdapterKind::Ollama{"local"}else if kind==gyro_core::provider_runtime::types::ProviderAdapterKind::OpenAiCompatible{"API"}else{"CLI"}})}).collect::<Vec<_>>(),"tasks":super::tasks::choices(&root)?}),
                );
            }
            ensure!(
                matches!(
                    action,
                    "preflight" | "launch" | "schedule" | "binding" | "save-binding" | "adopt"
                ),
                "unknown workflow run action"
            );
            let id = payload["definitionId"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Choose a saved workflow"))?;
            let listing = read_definitions(&root, &store.paths().base_dir.canonicalize()?)?;
            let definition = listing
                .into_iter()
                .find_map(|item| item.definition.filter(|definition| definition.id == id))
                .ok_or_else(|| anyhow::anyhow!("saved workflow is unavailable or invalid"))?;
            if action == "binding" {
                return Ok(
                    match store.workflow_binding(&root.to_string_lossy(), &definition.id)? {
                        Some((revision, binding)) => {
                            json!({"revision":revision,"binding":binding,"stale":binding.definition_hash!=definition_hash(&definition)?})
                        }
                        None => json!({"revision":0,"binding":null,"stale":false}),
                    },
                );
            }
            let binding: WorkflowBinding = serde_json::from_value(payload["binding"].clone())?;
            let pinned = WorkflowAutomationBinding {
                continuation: None,
                source_session_id: session.id,
                root_id: root_id.clone(),
                definition,
                binding,
            };
            preflight::check(app, &store, &pinned, &root, &[], true)?;
            if action == "save-binding" {
                let revision = store.save_workflow_binding(
                    &root.to_string_lossy(),
                    &pinned.definition,
                    &pinned.binding,
                    payload["revision"]
                        .as_u64()
                        .ok_or_else(|| anyhow::anyhow!("setup revision is required"))?,
                )?;
                return Ok(json!({"revision":revision}));
            }
            if action == "adopt" {
                let id = serde_json::from_value(payload["jobId"].clone())?;
                let expected = serde_json::from_value(payload["updatedAt"].clone())?;
                let jobs = open_automation_store().map_err(anyhow::Error::msg)?;
                let current = jobs
                    .get_automation(id)?
                    .ok_or_else(|| anyhow::anyhow!("workflow schedule is unavailable"))?;
                ensure!(
                    current.execution.workspace_path.as_deref()
                        == Some(root.to_string_lossy().as_ref()),
                    "schedule belongs to another root"
                );
                let job = jobs.adopt_workflow_setup(id, expected, pinned)?;
                emit_automation_update(app, &job);
                app.state::<AutomationSchedulerControl>().wake();
                return Ok(json!(job));
            }
            if action == "preflight" {
                return Ok(
                    json!({"ready":true,"definitionHash":pinned.binding.definition_hash,"queuedAfterCurrentChat":preflight::checkout_busy(app,&store,&root,&[])?}),
                );
            }
            let operation: Uuid = serde_json::from_value(payload["operationId"].clone())?;
            let schedule = if action == "launch" {
                AutomationSchedule::Manual
            } else {
                serde_json::from_value(payload["schedule"].clone())?
            };
            let calendar = payload
                .get("calendar")
                .filter(|value| !value.is_null())
                .map(|value| serde_json::from_value(value.clone()))
                .transpose()?;
            let role = preflight::first_agent(&pinned.definition)?;
            let first = pinned.binding.roles[role].clone();
            let draft = CreateAutomationRequest {
                title: pinned.definition.name.clone(),
                prompt: format!(
                    "Run workflow {} at pinned version {}",
                    pinned.definition.id,
                    &pinned.binding.definition_hash[..12]
                ),
                schedule: schedule.clone(),
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
                    calendar,
                    workspace_path: Some(root.to_string_lossy().into_owned()),
                    provider_id: Some(first.provider_id),
                    model_id: Some(first.model_id),
                    ..Default::default()
                },
            };
            let jobs = open_automation_store().map_err(anyhow::Error::msg)?;
            let job = jobs.create_workflow_automation(draft, operation)?;
            let job = if schedule == AutomationSchedule::Manual {
                jobs.queue_manual_workflow_once(job.id)?
            } else {
                job
            };
            emit_automation_update(app, &job);
            app.state::<AutomationSchedulerControl>().wake();
            Ok(json!(job))
        }
    }
}

fn cancel_run(
    app: &tauri::AppHandle,
    store: &gyro_core::SessionStore,
    id: Uuid,
    message: &str,
) -> Result<gyro_core::workflows::WorkflowRun> {
    for _ in 0..3 {
        let run = store
            .workflow_run(id)?
            .ok_or_else(|| anyhow::anyhow!("workflow is unavailable"))?;
        if run.status.terminal() {
            return Ok(run);
        }
        for step in &run.steps {
            if step.status == WorkflowStepStatus::Running {
                if let Some(session) = step.session_id {
                    stop_provider_run(app, &session.to_string(), ProviderStopReason::User);
                }
            }
        }
        if let Ok(cancelled) =
            store.stop_workflow_run(id, run.revision, WorkflowRunStatus::Cancelled, message)
        {
            for mut review in store
                .code_reviews(None)?
                .into_iter()
                .filter(|review| review.workflow_run_id == Some(id) && !review.status.terminal())
            {
                if let Some(session) = review.review_session_id {
                    stop_provider_run(app, &session.to_string(), ProviderStopReason::User);
                }
                for _ in 0..3 {
                    if review.status.terminal() {
                        break;
                    }
                    match store.transition_code_review(
                        review.id,
                        review.revision,
                        gyro_core::code_reviews::ReviewStatus::Cancelled,
                        None,
                        Some(message.into()),
                    ) {
                        Ok(next) => {
                            crate::features::code_reviews::execution::notify(app, &next);
                            break;
                        }
                        Err(_) => {
                            review = store
                                .code_review(review.id)?
                                .ok_or_else(|| anyhow::anyhow!("review is unavailable"))?
                        }
                    }
                }
            }
            notify(app, &cancelled);
            return Ok(cancelled);
        }
    }
    anyhow::bail!("workflow changed while stopping; refresh and retry")
}
