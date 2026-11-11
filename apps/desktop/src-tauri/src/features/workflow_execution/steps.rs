use super::{notify, preflight};
use crate::{
    automation::runtime::{AutomationRunAdmission, AutomationSchedulerControl},
    capabilities::{
        bridge::{active_provider_approval_nonce, active_provider_capability_context},
        execute::handle_desktop_provider_capability_request,
    },
    providers::{
        binding::bind_provider_capability_context, chat_types::ProviderChatRequest,
        run::run_provider_chat_blocking, session_lifecycle::ProviderSessionLease,
    },
    state::managers::ProviderCancellationManager,
};
use anyhow::{ensure, Result};
use gyro_core::{
    workflows::*, Automation, CapabilityId, CapabilityInvocationContext, CapabilityRequest,
    CapabilityStatus, CreateSessionContext, SessionEventKind, SessionOrigin, SessionStore,
    PROVIDER_CAPABILITY_IPC_SCHEMA_V1,
};
use serde_json::json;
use tauri::Manager;
use uuid::Uuid;

struct Active<'a> {
    app: &'a tauri::AppHandle,
    admission: &'a AutomationRunAdmission,
    automation: Uuid,
    session: String,
}
impl<'a> Active<'a> {
    fn begin(
        app: &'a tauri::AppHandle,
        admission: &'a AutomationRunAdmission,
        automation: Uuid,
        session: Uuid,
    ) -> Result<Self> {
        let session = session.to_string();
        admission
            .transfer_to_session(&session)
            .map_err(anyhow::Error::msg)?;
        app.state::<AutomationSchedulerControl>()
            .register(automation, session.clone());
        Ok(Self {
            app,
            admission,
            automation,
            session,
        })
    }
}
impl Drop for Active<'_> {
    fn drop(&mut self) {
        self.app
            .state::<AutomationSchedulerControl>()
            .unregister(self.automation);
        let _ = self.admission.reclaim_from_session(&self.session);
    }
}
pub(super) fn execute(
    app: &tauri::AppHandle,
    store: &SessionStore,
    automation: &Automation,
    run: &WorkflowRun,
    index: usize,
    admission: &AutomationRunAdmission,
) -> Result<WorkflowRun> {
    match &run.definition.steps[index] {
        WorkflowStep::Agent {
            role, instructions, ..
        } => {
            let binding = &run.binding.roles[role];
            let parent = store
                .get_session(run.source_session_id)?
                .ok_or_else(|| anyhow::anyhow!("workflow session is unavailable"))?;
            let session = store.create_subagent_session(
                &run.root_key,
                SessionOrigin::Desktop,
                format!("{} · {}", run.definition.name, run.steps[index].step_id),
                CreateSessionContext {
                    provider_id: Some(binding.provider_id.clone()),
                    model_id: Some(binding.model_id.clone()),
                    branch: parent.branch,
                    ..Default::default()
                },
                run.source_session_id,
            )?;
            let mut context: serde_json::Value =
                serde_json::from_str(&render_text_input(instructions, &run.binding.inputs)?)?;
            context["previousOutputs"] = json!(run
                .definition
                .steps
                .iter()
                .zip(&run.steps)
                .filter_map(|(definition, attempt)| match definition {
                    WorkflowStep::Agent { output, .. }
                        if attempt.status == WorkflowStepStatus::Completed =>
                        Some((output.name.clone(), attempt.output.clone())),
                    _ => None,
                })
                .collect::<std::collections::BTreeMap<_, _>>());
            let message = serde_json::to_string(&context)?;
            ensure!(
                message.len() <= 32 * 1024,
                "Complete workflow step input exceeds 32 KiB; narrow inputs or previous outputs"
            );
            let turn = Uuid::new_v4();
            let running =
                store.begin_workflow_step(run.id, run.revision, index, session.id, Some(turn))?;
            notify(app, &running);
            store.append_event_with_turn_id(session.id,SessionEventKind::UserMessage,&message,json!({"surface":"workflow","workflowRunId":run.id,"stepId":run.steps[index].step_id}),Some(turn))?;
            let _active = Active::begin(app, admission, automation.id, session.id)?;
            let mut request: ProviderChatRequest = serde_json::from_value(
                json!({"sessionId":session.id,"turnId":turn,"providerId":binding.provider_id,"modelId":binding.model_id,"message":message,"workspacePath":run.root_key,"mode":"normal","fullAccess":false,"requireCommandApproval":true,"requireFileEditApproval":true}),
            )?;
            request.workflow_run_id = Some(run.id);
            let output = run_provider_chat_blocking(app.clone(), request, run.origin)
                .map_err(anyhow::Error::msg)?;
            let notice = output.status_event.payload["error"]
                .as_str()
                .unwrap_or_default();
            ensure!(
                output.status_event.payload["status"] == "done"
                    && !crate::provider_reliability::is_tool_budget_notice(notice)
                    && !notice.contains("may be cut off"),
                "Workflow agent stopped with incomplete output; inspect its turn before retrying"
            );
            store.complete_workflow_step(
                run.id,
                running.revision,
                index,
                output.assistant_event.message,
                None,
                None,
            )
        }
        WorkflowStep::Review {
            role,
            source_step,
            instructions,
            ..
        } => {
            let source = run
                .steps
                .iter()
                .find(|step| &step.step_id == source_step)
                .ok_or_else(|| anyhow::anyhow!("review source step is unavailable"))?;
            let session = store
                .get_session(
                    source
                        .session_id
                        .ok_or_else(|| anyhow::anyhow!("review source session is unavailable"))?,
                )?
                .ok_or_else(|| anyhow::anyhow!("review source session was deleted"))?;
            let turn = source
                .turn_id
                .ok_or_else(|| anyhow::anyhow!("review source turn is unavailable"))?;
            let binding = &run.binding.roles[role];
            let brief = render_text_input(instructions, &run.binding.inputs)?;
            let snapshot = crate::features::code_reviews::capture::capture(
                store,
                &session.id.to_string(),
                Some(&session.workspace_identity.active_root_id),
                gyro_core::code_reviews::ReviewScope::Turn { turn_id: turn },
                vec![],
                Some(brief),
                crate::provider_context::provider_model_context_window(
                    &binding.provider_id,
                    Some(&binding.model_id),
                ),
                None,
            )?;
            let review = store.create_code_review_with_operation(
                Uuid::new_v4(),
                &snapshot,
                &binding.provider_id,
                &binding.model_id,
                None,
                run.origin,
                Some(run.id),
            )?;
            let _review_lease = ProviderSessionLease::try_acquire(store.paths(), review.id)?
                .ok_or_else(|| anyhow::anyhow!("review is owned by another host"))?;
            let review = crate::features::code_reviews::execution::ensure_session(store, review)?;
            let reviewer = review.review_session_id.unwrap();
            let running = store.begin_workflow_step(run.id, run.revision, index, reviewer, None)?;
            notify(app, &running);
            app.state::<AutomationSchedulerControl>()
                .register(automation.id, reviewer.to_string());
            let result = crate::features::code_reviews::execution::execute_reserved(
                app, review.id, admission,
            );
            app.state::<AutomationSchedulerControl>()
                .unregister(automation.id);
            if let Err(error) = result {
                if let Some(current) = store.code_review(review.id)? {
                    if !current.status.terminal() {
                        let next =
                            if current.status == gyro_core::code_reviews::ReviewStatus::Running {
                                gyro_core::code_reviews::ReviewStatus::Incomplete
                            } else {
                                gyro_core::code_reviews::ReviewStatus::Failed
                            };
                        let _ = store.transition_code_review(
                            current.id,
                            current.revision,
                            next,
                            None,
                            Some(error.to_string()),
                        );
                    }
                }
                return Err(error);
            }
            let completed = store
                .code_review(review.id)?
                .ok_or_else(|| anyhow::anyhow!("review was deleted"))?;
            let open = completed
                .findings
                .iter()
                .filter(|finding| {
                    !matches!(
                        finding.disposition,
                        gyro_core::code_reviews::FindingDisposition::Dismissed
                            | gyro_core::code_reviews::FindingDisposition::ResolvedByReview
                    )
                })
                .count();
            store.complete_workflow_step(
                run.id,
                running.revision,
                index,
                completed.summary.clone().unwrap_or_default(),
                Some((
                    completed.id,
                    completed.status == gyro_core::code_reviews::ReviewStatus::Completed,
                    open,
                )),
                None,
            )
        }
        WorkflowStep::Verification { command_ref, .. } => {
            let task = preflight::bound_task(
                std::path::Path::new(&run.root_key),
                &run.binding,
                command_ref,
            )?;
            let session = store
                .get_session(run.source_session_id)?
                .ok_or_else(|| anyhow::anyhow!("workflow session is unavailable"))?;
            let turn = Uuid::new_v4();
            let running =
                store.begin_workflow_step(run.id, run.revision, index, session.id, Some(turn))?;
            notify(app, &running);
            let _active = Active::begin(app, admission, automation.id, session.id)?;
            let _lease = ProviderSessionLease::for_run(store, session.id)?;
            let request: ProviderChatRequest = serde_json::from_value(
                json!({"sessionId":session.id,"turnId":turn,"providerId":session.provider_id,"modelId":session.model_id,"message":"Run the explicitly bound verification task under current approvals","workspacePath":run.root_key,"mode":"normal","fullAccess":false,"requireCommandApproval":true,"requireFileEditApproval":true}),
            )?;
            if let Some(control) = app
                .state::<ProviderCancellationManager>()
                .flags
                .lock()
                .ok()
                .and_then(|flags| flags.get(&session.id.to_string()).cloned())
            {
                *control
                    .process_owner
                    .lock()
                    .map_err(|_| anyhow::anyhow!("process owner is unavailable"))? =
                    Some(_lease.process_owner());
                *control
                    .request
                    .lock()
                    .map_err(|_| anyhow::anyhow!("workflow task context is unavailable"))? =
                    Some(request.clone());
            }
            store.append_event_with_turn_id(session.id,SessionEventKind::SystemEvent,"Workflow verification requested",json!({"kind":"workflow-verification","workflowRunId":run.id,"stepId":run.steps[index].step_id,"command":task.command,"args":task.args}),Some(turn))?;
            bind_provider_capability_context(app, store, &request, turn, false, &session)
                .map_err(anyhow::Error::msg)?;
            let bound = active_provider_capability_context(app, &session.id.to_string())?;
            let nonce = active_provider_approval_nonce(app, &session.id.to_string())?;
            let result = handle_desktop_provider_capability_request(
                app,
                CapabilityRequest {
                    schema: PROVIDER_CAPABILITY_IPC_SCHEMA_V1.into(),
                    sender_version: env!("CARGO_PKG_VERSION").into(),
                    context: CapabilityInvocationContext {
                        session_id: bound.session_id,
                        turn_id: bound.turn_id,
                        provider_id: bound.provider_id,
                        run_nonce: nonce,
                        call_id: Uuid::new_v4(),
                        workspace_key: bound.workspace_key,
                        mode: bound.policy.mode,
                        policy_revision: bound.policy.revision,
                        workspace_context_revision: bound.workspace_context.revision,
                    },
                    capability_id: CapabilityId::WorkspaceRunTask,
                    arguments: json!({"taskId":task.id,"background":false,"maxBytes":64*1024}),
                },
            );
            ensure!(
                result.status == CapabilityStatus::Completed,
                "Verification needs attention: {}",
                result
                    .error
                    .map(|error| error.message)
                    .unwrap_or_else(|| "no completed task receipt".into())
            );
            let result = result
                .result
                .ok_or_else(|| anyhow::anyhow!("verification receipt is unavailable"))?;
            let passed =
                result.data["exitCode"].as_i64() == Some(0) && result.data["status"] == "done";
            store.complete_workflow_step(
                run.id,
                running.revision,
                index,
                serde_json::to_string(&result.data)?,
                None,
                Some(passed),
            )
        }
    }
}
