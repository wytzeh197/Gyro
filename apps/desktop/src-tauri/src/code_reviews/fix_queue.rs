//! Selected findings enter the ordinary chat lane, never an advisory tool lane.
use super::{
    commands::{freshness, notify_fix},
    execution::notify,
};
use crate::{
    automation::runtime::AutomationRunAdmission,
    features::scope::root_scope,
    providers::{
        chat_types::ProviderChatRequest, run::run_provider_chat_blocking_in_lease,
        session_lifecycle::ProviderSessionLease,
    },
    state::provider_run::{stop_provider_run, ProviderStopReason},
    stores::open_store,
};
use anyhow::{ensure, Result};
use gyro_core::{
    code_reviews::{read_snapshot, ReviewFixIntent, ReviewFixStatus},
    SessionEventKind, SessionStore, UsageOrigin,
};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use uuid::Uuid;
fn workers() -> &'static Mutex<HashSet<Uuid>> {
    static WORKERS: OnceLock<Mutex<HashSet<Uuid>>> = OnceLock::new();
    WORKERS.get_or_init(Default::default)
}
pub(crate) fn summary(intent: &ReviewFixIntent) -> Value {
    json!({"id":intent.id,"reviewId":intent.review_id,"revision":intent.revision,"status":intent.status,"turnId":intent.turn_id,"providerId":intent.provider_id,"modelId":intent.model_id,"error":intent.error,"createdAt":intent.created_at})
}
pub(crate) fn cancel(
    app: &tauri::AppHandle,
    store: &SessionStore,
    id: Uuid,
    source: Uuid,
) -> Result<ReviewFixIntent> {
    for _ in 0..3 {
        let intent = store
            .review_fix_intent(id)?
            .ok_or_else(|| anyhow::anyhow!("fix request is unavailable"))?;
        ensure!(
            intent.source_session_id == source,
            "fix request belongs to another chat"
        );
        if !intent.status.active() {
            return Ok(intent);
        }
        if matches!(
            intent.status,
            ReviewFixStatus::Dispatching | ReviewFixStatus::Sent
        ) {
            stop_provider_run(app, &source.to_string(), ProviderStopReason::User);
        }
        if let Ok(next) = store.transition_review_fix(
            id,
            intent.revision,
            ReviewFixStatus::Cancelled,
            Some("Cancelled by you".into()),
        ) {
            notify_fix(app, &next);
            return Ok(next);
        }
    }
    anyhow::bail!("fix request changed while stopping; refresh and retry")
}
pub(crate) fn start(app: tauri::AppHandle, id: Uuid) {
    if !workers()
        .lock()
        .map(|mut set| set.insert(id))
        .unwrap_or(false)
    {
        return;
    }
    std::thread::spawn(move || {
        struct Worker(Uuid);
        impl Drop for Worker {
            fn drop(&mut self) {
                if let Ok(mut set) = workers().lock() {
                    set.remove(&self.0);
                }
            }
        }
        let _worker = Worker(id);
        let Ok(store) = open_store() else { return };
        let Ok(Some(_lease)) = ProviderSessionLease::try_acquire(store.paths(), id) else {
            return;
        };
        if let Err(error) = execute(&app, &store, id) {
            if let Ok(Some(intent)) = store.review_fix_intent(id) {
                if intent.status.active() {
                    if let Ok(next) = store.transition_review_fix(
                        id,
                        intent.revision,
                        ReviewFixStatus::Blocked,
                        Some(error.to_string()),
                    ) {
                        notify_fix(&app, &next)
                    }
                }
            }
        }
    });
}
fn execute(app: &tauri::AppHandle, store: &SessionStore, id: Uuid) -> Result<()> {
    loop {
        let intent = store
            .review_fix_intent(id)?
            .ok_or_else(|| anyhow::anyhow!("fix request was deleted"))?;
        if intent.status != ReviewFixStatus::Queued {
            return Ok(());
        }
        let (session, _, root) = root_scope(
            store,
            &intent.source_session_id.to_string(),
            Some(&intent.root_id),
        )?;
        ensure!(
            root.to_string_lossy() == intent.root_key
                && session.provider_id.as_deref() == Some(intent.provider_id.as_str())
                && session.model_id.as_deref() == Some(intent.model_id.as_str()),
            "Implementing root or provider/model changed while fixes waited; select findings again"
        );
        if crate::features::workflow_execution::preflight::checkout_busy(app, store, &root, &[])? {
            std::thread::sleep(Duration::from_millis(500));
            continue;
        }
        let Some(_checkout) =
            gyro_core::workflows::WorkflowCheckoutLease::try_acquire(store.paths(), &root, false)?
        else {
            std::thread::sleep(Duration::from_millis(500));
            continue;
        };
        let Some(source_lease) = ProviderSessionLease::try_acquire(store.paths(), session.id)?
        else {
            std::thread::sleep(Duration::from_millis(500));
            continue;
        };
        let Some(admission) =
            AutomationRunAdmission::reserve(app, id).map_err(anyhow::Error::msg)?
        else {
            drop(source_lease);
            std::thread::sleep(Duration::from_millis(500));
            continue;
        };
        // Revalidate after acquiring both the chat lease and global admission.
        let review = store
            .code_review(intent.review_id)?
            .ok_or_else(|| anyhow::anyhow!("review is unavailable"))?;
        let snapshot = read_snapshot(
            store.paths(),
            review
                .snapshot_id
                .ok_or_else(|| anyhow::anyhow!("snapshot is unavailable"))?,
        )?;
        let (state, fingerprint) = freshness(store, &snapshot);
        ensure!(state!="source-unavailable"&&fingerprint.as_deref()==Some(intent.target_fingerprint.as_str()),"Files changed while fixes waited; inspect the current revision and select findings again");
        let config = gyro_core::GyroConfig::load(store.paths())?;
        ensure!(
            config
                .model_providers
                .iter()
                .any(|provider| provider.id == intent.provider_id && provider.enabled),
            "Enable the selected implementing provider"
        );
        let mut request: ProviderChatRequest = serde_json::from_value(
            json!({"sessionId":session.id,"turnId":intent.turn_id,"providerId":intent.provider_id,"modelId":intent.model_id,"message":intent.message,"workspacePath":root,"mode":"normal","fullAccess":false,"requireCommandApproval":true,"requireFileEditApproval":true}),
        )?;
        crate::providers::binding::bind_provider_chat_request(
            &mut request,
            &session,
            &config,
            store.paths(),
        )
        .map_err(anyhow::Error::msg)?;
        let claimed =
            store.transition_review_fix(id, intent.revision, ReviewFixStatus::Dispatching, None)?;
        notify_fix(app, &claimed);
        admission
            .transfer_to_session(&session.id.to_string())
            .map_err(anyhow::Error::msg)?;
        struct Active<'a>(&'a AutomationRunAdmission, String);
        impl Drop for Active<'_> {
            fn drop(&mut self) {
                let _ = self.0.reclaim_from_session(&self.1);
            }
        }
        let _active = Active(&admission, session.id.to_string());
        let current = store
            .review_fix_intent(id)?
            .ok_or_else(|| anyhow::anyhow!("fix request was deleted"))?;
        ensure!(
            current.status == ReviewFixStatus::Dispatching,
            "fix request was cancelled"
        );
        store.append_event_with_turn_id(
            session.id,
            SessionEventKind::UserMessage,
            &intent.message,
            json!({"surface":"review-fix","fixIntentId":id}),
            Some(intent.turn_id),
        )?;
        store.append_event_with_turn_id(session.id,SessionEventKind::SystemEvent,"Selected findings sent for fixes",json!({"kind":"review-fix-requested","fixIntentId":id,"reviewId":intent.review_id,"findingIds":intent.finding_revisions.keys().collect::<Vec<_>>(),"rootId":intent.root_id}),Some(intent.turn_id))?;
        let sent =
            store.transition_review_fix(id, current.revision, ReviewFixStatus::Sent, None)?;
        notify_fix(app, &sent);
        if let Some(review) = store.code_review(intent.review_id)? {
            notify(app, &review)
        }
        let output = run_provider_chat_blocking_in_lease(
            app.clone(),
            request,
            UsageOrigin::Chat,
            Some(&source_lease),
        )
        .map_err(anyhow::Error::msg)?;
        let current = store
            .review_fix_intent(id)?
            .ok_or_else(|| anyhow::anyhow!("fix request was deleted"))?;
        if current.status == ReviewFixStatus::Cancelled {
            return Ok(());
        }
        ensure!(
            output.status_event.payload["status"] == "done"
                && output.status_event.payload["error"]
                    .as_str()
                    .is_none_or(str::is_empty)
                && !output.assistant_event.message.trim().is_empty(),
            "Implementing turn was incomplete; inspect its actions before another request"
        );
        let complete =
            store.transition_review_fix(id, current.revision, ReviewFixStatus::Completed, None)?;
        notify_fix(app, &complete);
        if let Some(review) = store.code_review(intent.review_id)? {
            notify(app, &review)
        }
        return Ok(());
    }
}
pub(crate) fn recover(app: &tauri::AppHandle) {
    let Ok(store) = open_store() else { return };
    let Ok(intents) = store.review_fix_intents(None) else {
        return;
    };
    for intent in intents {
        if !intent.status.active() {
            continue;
        }
        let Ok(Some(lease)) = ProviderSessionLease::try_acquire(store.paths(), intent.id) else {
            continue;
        };
        if intent.status==ReviewFixStatus::Queued{drop(lease);start(app.clone(),intent.id)}else if let Ok(next)=store.transition_review_fix(intent.id,intent.revision,ReviewFixStatus::Interrupted,Some("Fix dispatch was interrupted. Inspect the linked turn before selecting findings again; it was not replayed.".into())){notify_fix(app,&next)}
    }
}
