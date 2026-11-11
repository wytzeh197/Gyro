use crate::{
    automation::runtime::AutomationRunAdmission,
    features::scope::root_scope,
    providers::{
        chat_types::{ChatMode, InternalRequestPurpose, ProviderChatRequest},
        retry::run_provider_chat_with_retry,
        session_lifecycle::ProviderSessionLease,
    },
    state::managers::ProviderCancellationManager,
    stores::open_store,
    usage::guard::UsageContext,
};
use anyhow::{ensure, Result};
use gyro_core::{
    code_reviews::{
        pack_review_input, parse_review_result, read_snapshot, write_review_output, CodeReviewRun,
        ReviewStatus,
    },
    provider_runtime::{api_config::provider_adapter_with_kind, types::ProviderAdapterKind},
    CreateSessionContext, GyroConfig, SessionEventKind, SessionOrigin, SessionStore,
};
use serde_json::json;
use std::{
    collections::HashSet,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tauri::{Emitter, Manager};
use uuid::Uuid;

fn workers() -> &'static Mutex<HashSet<Uuid>> {
    static WORKERS: OnceLock<Mutex<HashSet<Uuid>>> = OnceLock::new();
    WORKERS.get_or_init(Default::default)
}
pub(crate) fn notify(app: &tauri::AppHandle, run: &CodeReviewRun) {
    let _=app.emit("gyro://code-review-changed",json!({"sourceSessionId":run.source_session_id,"reviewId":run.id,"revision":run.revision,"status":run.status}));
}
pub(crate) fn validate_reviewer(
    config: &GyroConfig,
    provider_id: &str,
    model_id: &str,
) -> Result<()> {
    let provider = config
        .model_providers
        .iter()
        .find(|provider| provider.id == provider_id && provider.enabled)
        .ok_or_else(|| anyhow::anyhow!("Enable the selected reviewer in Providers"))?;
    let kind = provider_adapter_with_kind(provider_id, provider.kind.as_deref()).kind;
    ensure!(matches!(kind,ProviderAdapterKind::Ollama|ProviderAdapterKind::OpenAiCompatible),"No-tool review is unavailable for this adapter in this build; explicitly choose an API or local Ollama model");
    ensure!(
        !model_id.trim().is_empty() && model_id.len() <= 200,
        "Choose a reviewer model"
    );
    Ok(())
}
pub(crate) fn ensure_session(
    store: &SessionStore,
    mut run: CodeReviewRun,
) -> Result<CodeReviewRun> {
    if run.review_session_id.is_some() {
        return Ok(run);
    }
    let snapshot = read_snapshot(
        store.paths(),
        run.snapshot_id
            .ok_or_else(|| anyhow::anyhow!("review snapshot is unavailable"))?,
    )?;
    let (source, _, root) = root_scope(
        store,
        &run.source_session_id.to_string(),
        Some(&run.root_id),
    )?;
    ensure!(
        root.to_string_lossy() == snapshot.root_key,
        "review workspace root changed"
    );
    let child = store.create_subagent_session(
        &root,
        SessionOrigin::Desktop,
        "Second-opinion review",
        CreateSessionContext {
            provider_id: Some(run.provider_id.clone()),
            provider_label: Some(run.provider_id.clone()),
            model_id: Some(run.model_id.clone()),
            model_label: Some(run.model_id.clone()),
            branch: source.branch,
            ..Default::default()
        },
        source.id,
    )?;
    store.assign_advisory_session(child.id, InternalRequestPurpose::CodeReview)?;
    run = store.bind_code_review_session(run.id, run.revision, child.id)?;
    Ok(run)
}
pub(crate) fn start(app: tauri::AppHandle, id: Uuid) {
    if !workers()
        .lock()
        .map(|mut running| running.insert(id))
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
        // Own the run before binding a reviewer session. Separate hosts must
        // not race to create children or settle another host's transition.
        let Ok(claim_store) = open_store() else {
            return;
        };
        let Ok(Some(_claim)) = ProviderSessionLease::try_acquire(claim_store.paths(), id) else {
            return;
        };
        if let Err(error) = execute(&app, id) {
            if let Ok(store) = open_store() {
                if let Ok(Some(run)) = store.code_review(id) {
                    if !run.status.terminal() {
                        let next = if run.status == ReviewStatus::Running {
                            ReviewStatus::Incomplete
                        } else {
                            ReviewStatus::Failed
                        };
                        if let Ok(failed) = store.transition_code_review(
                            id,
                            run.revision,
                            next,
                            None,
                            Some(error.to_string()),
                        ) {
                            notify(&app, &failed);
                        }
                    }
                }
            }
        }
    });
}
fn execute(app: &tauri::AppHandle, id: Uuid) -> Result<()> {
    let store = open_store().map_err(anyhow::Error::msg)?;
    let admission = loop {
        let run = store
            .code_review(id)?
            .ok_or_else(|| anyhow::anyhow!("review was deleted"))?;
        if run.status != ReviewStatus::Queued {
            return Ok(());
        }
        if let Some(admission) =
            AutomationRunAdmission::reserve(app, id).map_err(anyhow::Error::msg)?
        {
            break admission;
        }
        std::thread::sleep(Duration::from_millis(500));
    };
    execute_reserved(app, id, &admission)
}
pub(crate) fn execute_reserved(
    app: &tauri::AppHandle,
    id: Uuid,
    admission: &AutomationRunAdmission,
) -> Result<()> {
    let store = open_store().map_err(anyhow::Error::msg)?;
    let run = ensure_session(
        &store,
        store
            .code_review(id)?
            .ok_or_else(|| anyhow::anyhow!("review is unavailable"))?,
    )?;
    let session_id = run.review_session_id.unwrap();
    let Some(lease) = ProviderSessionLease::try_acquire(store.paths(), session_id)? else {
        return Ok(());
    };
    let snapshot = read_snapshot(store.paths(), run.snapshot_id.unwrap())?;
    let (_, _, root) = root_scope(
        &store,
        &run.source_session_id.to_string(),
        Some(&run.root_id),
    )?;
    ensure!(
        root.to_string_lossy() == snapshot.root_key,
        "review root changed while queued"
    );
    let config = GyroConfig::load(store.paths())?;
    validate_reviewer(&config, &run.provider_id, &run.model_id)?;
    let window = crate::provider_context::provider_model_context_window(
        &run.provider_id,
        Some(&run.model_id),
    );
    let budget = window
        .map(|tokens| (tokens.saturating_mul(3) / 2).min(192 * 1024) as usize)
        .unwrap_or(48 * 1024);
    let input = pack_review_input(&snapshot, budget)?;
    let capturing =
        store.transition_code_review(id, run.revision, ReviewStatus::Capturing, None, None)?;
    notify(app, &capturing);
    admission
        .transfer_to_session(&session_id.to_string())
        .map_err(anyhow::Error::msg)?;
    struct Active<'a>(&'a AutomationRunAdmission, String);
    impl Drop for Active<'_> {
        fn drop(&mut self) {
            let _ = self.0.reclaim_from_session(&self.1);
        }
    }
    let _active = Active(admission, session_id.to_string());
    if let Some(control) = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .and_then(|flags| flags.get(&session_id.to_string()).cloned())
    {
        if let Ok(mut owner) = control.process_owner.lock() {
            *owner = Some(lease.process_owner());
        }
    }
    let running =
        store.transition_code_review(id, capturing.revision, ReviewStatus::Running, None, None)?;
    notify(app, &running);
    let turn = Uuid::new_v4();
    let mut output_capture =
        super::output::OutputCapture::begin(store.paths(), id, session_id.to_string())?;
    let mut request: ProviderChatRequest = serde_json::from_value(
        json!({"sessionId":session_id,"turnId":turn,"providerId":run.provider_id,"modelId":run.model_id,"message":input,"workspacePath":root,"mode":"council","requireCommandApproval":true,"requireFileEditApproval":true,"fullAccess":false}),
    )?;
    request.internal_purpose = Some(InternalRequestPurpose::CodeReview);
    request.mode = ChatMode::Council;
    store.append_event_with_turn_id(session_id,SessionEventKind::SystemEvent,"Reviewing immutable input",json!({"kind":"code-review-input","reviewId":id,"snapshotId":snapshot.id,"manifestHash":snapshot.manifest_hash,"purpose":"code-review"}),Some(turn))?;
    let output =
        run_provider_chat_with_retry(&store, app, &request, None, UsageContext::new(run.origin))
            .map_err(anyhow::Error::msg)?;
    write_review_output(store.paths(), id, &output.response)?;
    output_capture.completed();
    let current = store
        .code_review(id)?
        .ok_or_else(|| anyhow::anyhow!("review was deleted"))?;
    if current.status == ReviewStatus::Cancelled {
        return Ok(());
    }
    ensure!(!output.answer_cut_off&&!output.paused_at_tool_budget,"Review output was interrupted or truncated; inspect the partial output and start a new review");
    let parsed = parse_review_result(id, &snapshot, &output.response)?;
    let complete = store.finish_code_review(id, current.revision, parsed)?;
    store.append_event_with_turn_id(session_id,SessionEventKind::AssistantMessage,complete.summary.as_deref().unwrap_or("Review finished"),json!({"kind":"code-review-result","reviewId":id,"snapshotId":snapshot.id,"status":complete.status,"findingCount":complete.findings.len()}),Some(turn))?;
    notify(app, &complete);
    Ok(())
}
pub(crate) fn stop_for_source(app: &tauri::AppHandle, source: Uuid) -> Result<()> {
    let store = open_store().map_err(anyhow::Error::msg)?;
    let mut runs = store.code_reviews(Some(source))?;
    for run in store
        .code_reviews(None)?
        .into_iter()
        .filter(|run| run.review_session_id == Some(source))
    {
        if !runs.iter().any(|current| current.id == run.id) {
            runs.push(run);
        }
    }
    for mut run in runs {
        if run.status.terminal() {
            continue;
        }
        if let Some(session) = run.review_session_id {
            crate::state::provider_run::stop_provider_run(
                app,
                &session.to_string(),
                crate::state::provider_run::ProviderStopReason::User,
            );
        }
        for _ in 0..3 {
            if run.status.terminal() {
                break;
            }
            match store.transition_code_review(
                run.id,
                run.revision,
                ReviewStatus::Cancelled,
                None,
                Some("Source session deleted by you".into()),
            ) {
                Ok(next) => {
                    run = next;
                    notify(app, &run);
                    break;
                }
                Err(_) => {
                    run = store
                        .code_review(run.id)?
                        .ok_or_else(|| anyhow::anyhow!("review disappeared"))?;
                }
            }
        }
        if let Some(session) = run.review_session_id {
            ensure!(
                ProviderSessionLease::try_acquire(store.paths(), session)?.is_some(),
                "Reviewer is stopping; retry deleting the session shortly"
            );
        }
    }
    Ok(())
}
pub(crate) fn recover(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let Ok(store) = open_store() else {
            return;
        };
        let Ok(runs) = store.code_reviews(None) else {
            return;
        };
        for run in runs {
            let workflow_live = run.workflow_run_id.is_some_and(|id| {
                store
                    .workflow_run(id)
                    .ok()
                    .flatten()
                    .is_some_and(|run| !run.status.terminal())
            });
            if workflow_live {
                continue;
            }
            if run.status == ReviewStatus::Queued && run.workflow_run_id.is_none() {
                start(app.clone(), run.id);
            } else if !run.status.terminal() {
                let Ok(Some(_claim)) = ProviderSessionLease::try_acquire(store.paths(), run.id)
                else {
                    continue;
                };
                let owned = run.review_session_id.and_then(|session| {
                    ProviderSessionLease::try_acquire(store.paths(), session)
                        .ok()
                        .flatten()
                });
                if owned.is_some() || run.review_session_id.is_none() {
                    let next = if run.status == ReviewStatus::Running {
                        ReviewStatus::Incomplete
                    } else {
                        ReviewStatus::Failed
                    };
                    if let Ok(interrupted)=store.transition_code_review(run.id,run.revision,next,None,Some("Review interrupted by restart; inspect captured input and explicitly review again".into())){notify(&app,&interrupted);}
                }
            }
        }
    });
}
