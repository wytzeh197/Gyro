mod capture;
pub(crate) mod commands;
use crate::{
    automation::runtime::AutomationRunAdmission,
    features::scope::root_scope,
    providers::{
        chat_types::{InternalRequestPurpose, ProviderChatRequest},
        retry::run_provider_chat_with_retry,
        session_lifecycle::ProviderSessionLease,
    },
    stores::open_store,
    usage::guard::UsageContext,
};
use anyhow::{ensure, Result};
use gyro_core::{workflows::*, CreateSessionContext, GyroConfig, SessionOrigin, UsageOrigin};
use serde_json::json;
use std::{
    collections::HashSet,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tauri::Emitter;
use uuid::Uuid;
pub(crate) fn notify(app: &tauri::AppHandle, draft: &WorkflowDraft) {
    let _=app.emit("gyro://workflow-draft-changed",json!({"draftId":draft.id,"sourceSessionId":draft.source_session_id,"revision":draft.revision,"status":draft.status}));
}
fn workers() -> &'static Mutex<HashSet<Uuid>> {
    static WORKERS: OnceLock<Mutex<HashSet<Uuid>>> = OnceLock::new();
    WORKERS.get_or_init(Default::default)
}
pub(super) fn start(app: tauri::AppHandle, id: Uuid) {
    if !workers()
        .lock()
        .map(|mut workers| workers.insert(id))
        .unwrap_or(false)
    {
        return;
    }
    std::thread::spawn(move || {
        struct Worker(Uuid);
        impl Drop for Worker {
            fn drop(&mut self) {
                if let Ok(mut workers) = workers().lock() {
                    workers.remove(&self.0);
                }
            }
        }
        let _worker = Worker(id);
        let Ok(store) = open_store() else {
            return;
        };
        let Ok(Some(_lease)) = ProviderSessionLease::try_acquire(store.paths(), id) else {
            return;
        };
        if let Err(error) = execute(&app, id) {
            if let Ok(Some(current)) = store.workflow_draft(id) {
                if current.status.active() {
                    if let Ok(failed) = store.stop_workflow_extraction(
                        id,
                        current.revision,
                        WorkflowDraftStatus::Failed,
                        &error.to_string(),
                    ) {
                        notify(&app, &failed);
                    }
                }
            }
        }
    });
}
fn execute(app: &tauri::AppHandle, id: Uuid) -> Result<()> {
    let store = open_store().map_err(anyhow::Error::msg)?;
    let admission = loop {
        let draft = store
            .workflow_draft(id)?
            .ok_or_else(|| anyhow::anyhow!("extraction draft is unavailable"))?;
        if draft.status != WorkflowDraftStatus::Queued {
            return Ok(());
        }
        if let Some(admission) =
            AutomationRunAdmission::reserve(app, id).map_err(anyhow::Error::msg)?
        {
            break admission;
        }
        std::thread::sleep(Duration::from_millis(500));
    };
    let draft = store
        .workflow_draft(id)?
        .ok_or_else(|| anyhow::anyhow!("extraction draft is unavailable"))?;
    let (source, _, root) = root_scope(
        &store,
        &draft.source_session_id.to_string(),
        Some(&draft.root_id),
    )?;
    ensure!(
        root.to_string_lossy() == draft.root_key,
        "extraction root changed"
    );
    let provider = draft
        .provider_id
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("Choose an extraction provider"))?;
    let model = draft
        .model_id
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("Choose an extraction model"))?;
    crate::features::code_reviews::execution::validate_reviewer(
        &GyroConfig::load(store.paths())?,
        provider,
        model,
    )?;
    let budget = crate::provider_context::provider_model_context_window(provider, Some(model))
        .map(|tokens| (tokens.saturating_mul(3) / 2).min(192 * 1024) as usize)
        .unwrap_or(48 * 1024);
    ensure!(
        draft.input.len() <= budget,
        "Complete extraction input exceeds the chosen model budget; select fewer turns"
    );
    let child = store.create_subagent_session(
        &root,
        SessionOrigin::Desktop,
        "Extract workflow draft",
        CreateSessionContext {
            provider_id: Some(provider.into()),
            model_id: Some(model.into()),
            branch: source.branch,
            ..Default::default()
        },
        source.id,
    )?;
    let running = store.start_workflow_extraction(id, draft.revision, child.id)?;
    notify(app, &running);
    let Some(lease) = ProviderSessionLease::try_acquire(store.paths(), child.id)? else {
        anyhow::bail!("extraction session is busy");
    };
    admission
        .transfer_to_session(&child.id.to_string())
        .map_err(anyhow::Error::msg)?;
    struct Active<'a>(&'a AutomationRunAdmission, String);
    impl Drop for Active<'_> {
        fn drop(&mut self) {
            let _ = self.0.reclaim_from_session(&self.1);
        }
    }
    let _active = Active(&admission, child.id.to_string());
    use tauri::Manager;
    if let Some(control) = app
        .state::<crate::state::managers::ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .and_then(|flags| flags.get(&child.id.to_string()).cloned())
    {
        *control
            .process_owner
            .lock()
            .map_err(|_| anyhow::anyhow!("process owner is unavailable"))? =
            Some(lease.process_owner());
    }
    let mut capture = crate::features::code_reviews::output::OutputCapture::begin_workflow(
        store.paths(),
        id,
        child.id.to_string(),
    )?;
    let mut request: ProviderChatRequest = serde_json::from_value(
        json!({"sessionId":child.id,"turnId":Uuid::new_v4(),"providerId":provider,"modelId":model,"message":draft.input,"workspacePath":root,"mode":"council","fullAccess":false,"requireCommandApproval":true,"requireFileEditApproval":true}),
    )?;
    request.internal_purpose = Some(InternalRequestPurpose::WorkflowExtraction);
    let output = run_provider_chat_with_retry(
        &store,
        app,
        &request,
        None,
        UsageContext::new(UsageOrigin::WorkflowExtraction),
    )
    .map_err(anyhow::Error::msg)?;
    write_draft_output(store.paths(), id, &output.response)?;
    capture.completed();
    let current = store
        .workflow_draft(id)?
        .ok_or_else(|| anyhow::anyhow!("workflow draft was deleted"))?;
    if current.status == WorkflowDraftStatus::Cancelled {
        return Ok(());
    }
    ensure!(
        !output.answer_cut_off && !output.paused_at_tool_budget,
        "Extraction output is incomplete; inspect its output and explicitly start a new draft"
    );
    let definition = parse_definition(output.response.trim().as_bytes())?;
    let ready = store.finish_workflow_extraction(id, current.revision, definition)?;
    notify(app, &ready);
    Ok(())
}
pub(crate) fn recover(app: &tauri::AppHandle) {
    let Ok(store) = open_store() else {
        return;
    };
    let Ok(drafts) = store.workflow_drafts(None) else {
        return;
    };
    for draft in drafts {
        if draft.status.active() {
            let Ok(Some(_lease)) = ProviderSessionLease::try_acquire(store.paths(), draft.id)
            else {
                continue;
            };
            if let Ok(interrupted)=store.stop_workflow_extraction(draft.id,draft.revision,WorkflowDraftStatus::Interrupted,"Extraction interrupted by restart. Inspect captured output and explicitly capture a new draft to try again."){notify(app,&interrupted);}
        }
    }
}
