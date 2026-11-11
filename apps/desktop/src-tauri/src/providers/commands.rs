use crate::{
    app::limits::MAX_CONCURRENT_PROVIDER_RUNS,
    goal_runner,
    provider_run_cleanup::{wait_for_owned_run_release, ProviderRunReservation},
    providers::{
        chat_types::{
            ProviderChatRequest, ProviderChatResponse, ProviderContextCompactionResponse,
        },
        run::compact_provider_chat_blocking,
    },
    state::{
        managers::ProviderCancellationManager,
        provider_run::{cancel_provider_run, ProviderRunControl, ProviderStopReason},
    },
    stores::parse_uuid,
    text::validate_chat_message,
};
use std::sync::Arc;
use tauri::Manager;
use uuid::Uuid;
#[tauri::command]
pub(crate) async fn run_provider_chat(
    app: tauri::AppHandle,
    request: ProviderChatRequest,
) -> Result<ProviderChatResponse, String> {
    run_goal_chat(app, request, None).await
}

pub(crate) async fn run_goal_chat(
    app: tauri::AppHandle,
    mut request: ProviderChatRequest,
    expected_run: Option<Uuid>,
) -> Result<ProviderChatResponse, String> {
    request.message = validate_chat_message(&request.message)?;
    let reservation = ProviderRunReservation::reserve(&app, &request.session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _reservation = reservation;
        goal_runner::run(app, request, expected_run)
    })
    .await
    .map_err(|error| format!("provider chat worker failed: {error}"))?
}

/// Compact a provider chat. Codex uses its native app-server request; other
/// providers restart from a bounded local conversation checkpoint. The slash
/// command is never sent to a model as a normal prompt.
#[tauri::command]
pub(crate) async fn compact_provider_chat(
    app: tauri::AppHandle,
    session_id: String,
    turn_id: Option<String>,
) -> Result<ProviderContextCompactionResponse, String> {
    let run_id = turn_id
        .as_deref()
        .map(parse_uuid)
        .transpose()?
        .unwrap_or_else(Uuid::new_v4);
    let finishing = {
        let manager = app.state::<ProviderCancellationManager>();
        let mut flags = manager
            .flags
            .lock()
            .map_err(|_| "provider cancellation state is unavailable".to_string())?;
        if let Some(control) = flags.get(&session_id) {
            if control.cancellation.is_cancelled() {
                return Err("the current response is stopping; compact after it finishes".into());
            }
            if control
                .context_compaction_closed
                .load(std::sync::atomic::Ordering::Acquire)
            {
                Some(control.clone())
            } else {
                // Coalesce clicks; never start a second provider or interrupt a write.
                control
                    .context_compaction_requested
                    .store(true, std::sync::atomic::Ordering::Release);
                return Ok(ProviderContextCompactionResponse {
                    activity_events: Vec::new(),
                });
            }
        } else {
            if flags.len() >= MAX_CONCURRENT_PROVIDER_RUNS {
                return Err(format!(
                    "Gyro can run at most {MAX_CONCURRENT_PROVIDER_RUNS} provider turns at once"
                ));
            }
            flags.insert(session_id.clone(), Arc::new(ProviderRunControl::default()));
            None
        }
    };
    if let Some(control) = finishing {
        let worker_app = app.clone();
        let worker_session = session_id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            wait_for_owned_run_release(
                &worker_app.state::<ProviderCancellationManager>().flags,
                &worker_session,
                &control,
                std::time::Duration::from_secs(10),
            )
        })
        .await
        .map_err(|error| format!("context compaction handoff failed: {error}"))??;
        return Box::pin(compact_provider_chat(app, session_id, turn_id)).await;
    }
    let worker_app = app.clone();
    let worker_session_id = session_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        compact_provider_chat_blocking(worker_app, worker_session_id, run_id)
    })
    .await
    .map_err(|error| format!("context compaction worker failed: {error}"));
    app.state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .map(|mut flags| flags.remove(&session_id));
    result?
}

#[tauri::command]
pub(crate) async fn stop_provider_chat(
    app: tauri::AppHandle,
    session_id: String,
    wait_for_stop: Option<bool>,
) -> Result<(), String> {
    let wait_for_stop = wait_for_stop.unwrap_or(false);
    let Some(control) = cancel_provider_run(&app, &session_id, ProviderStopReason::User)? else {
        // Steer can race natural completion. The queue should proceed when the
        // old run already released the session.
        return if wait_for_stop {
            Ok(())
        } else {
            Err("no provider turn is running for this session".into())
        };
    };
    if !wait_for_stop {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        wait_for_owned_run_release(
            &app.state::<ProviderCancellationManager>().flags,
            &session_id,
            &control,
            std::time::Duration::from_secs(10),
        )
    })
    .await
    .map_err(|error| format!("provider stop worker failed: {error}"))?
}
