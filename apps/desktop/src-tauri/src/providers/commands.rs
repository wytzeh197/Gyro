use crate::{
    app::limits::MAX_CONCURRENT_PROVIDER_RUNS,
    goal_runner, parse_uuid,
    provider_run_cleanup::ProviderRunReservation,
    providers::{
        chat_types::{
            ProviderChatRequest, ProviderChatResponse, ProviderContextCompactionResponse,
        },
        run::compact_provider_chat_blocking,
    },
    state::{
        managers::ProviderCancellationManager,
        provider_run::{stop_provider_run, ProviderRunControl, ProviderStopReason},
    },
    validate_chat_message,
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
    {
        let manager = app.state::<ProviderCancellationManager>();
        let mut flags = manager
            .flags
            .lock()
            .map_err(|_| "provider cancellation state is unavailable".to_string())?;
        if flags.contains_key(&session_id) {
            return Err("a provider turn is already running for this session".into());
        }
        if flags.len() >= MAX_CONCURRENT_PROVIDER_RUNS {
            return Err(format!(
                "Gyro can run at most {MAX_CONCURRENT_PROVIDER_RUNS} provider turns at once"
            ));
        }
        flags.insert(session_id.clone(), Arc::new(ProviderRunControl::default()));
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
) -> Result<(), String> {
    stop_provider_run(&app, &session_id, ProviderStopReason::User)
        .then_some(())
        .ok_or_else(|| "no provider turn is running for this session".to_string())
}
