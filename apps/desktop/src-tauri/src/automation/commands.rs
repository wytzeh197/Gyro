//! Tauri commands for the automation list, its leases and its triage state.

use super::runtime::AutomationSchedulerControl;
use crate::{open_automation_store, parse_uuid, to_string, ProviderCancellationManager};
use gyro_core::{
    Automation, AutomationRunStatus, AutomationStatus, AutomationTriageState,
    CreateAutomationRequest,
};
use tauri::{Emitter, Manager};
use uuid::Uuid;

pub(crate) const AUTOMATION_UPDATED_EVENT: &str = "gyro://automation-updated";

#[tauri::command]
pub(crate) async fn list_automations() -> Result<Vec<Automation>, String> {
    tauri::async_runtime::spawn_blocking(list_automations_blocking)
        .await
        .map_err(|error| format!("automation list worker failed: {error}"))?
}

pub(crate) fn list_automations_blocking() -> Result<Vec<Automation>, String> {
    let store = open_automation_store()?;
    store.list_automations().map_err(to_string)
}

#[tauri::command]
pub(crate) async fn list_due_automations() -> Result<Vec<Automation>, String> {
    tauri::async_runtime::spawn_blocking(list_due_automations_blocking)
        .await
        .map_err(|error| format!("due automation list worker failed: {error}"))?
}

pub(crate) fn list_due_automations_blocking() -> Result<Vec<Automation>, String> {
    let store = open_automation_store()?;
    store.list_due_automations_now().map_err(to_string)
}

#[tauri::command]
pub(crate) async fn create_automation(
    app: tauri::AppHandle,
    draft: CreateAutomationRequest,
) -> Result<Automation, String> {
    let automation =
        tauri::async_runtime::spawn_blocking(move || create_automation_blocking(draft))
            .await
            .map_err(|error| format!("automation create worker failed: {error}"))??;
    emit_automation_update(&app, &automation);
    app.state::<AutomationSchedulerControl>().wake();
    Ok(automation)
}

pub(crate) fn create_automation_blocking(
    draft: CreateAutomationRequest,
) -> Result<Automation, String> {
    let store = open_automation_store()?;
    store.create_automation(draft).map_err(to_string)
}

#[tauri::command]
pub(crate) async fn edit_automation(
    app: tauri::AppHandle,
    automation_id: String,
    draft: CreateAutomationRequest,
) -> Result<Automation, String> {
    let id = parse_uuid(&automation_id)?;
    let automation = tauri::async_runtime::spawn_blocking(move || {
        open_automation_store()?
            .edit_automation(id, draft)
            .map_err(to_string)
    })
    .await
    .map_err(to_string)??;
    emit_automation_update(&app, &automation);
    app.state::<AutomationSchedulerControl>().wake();
    Ok(automation)
}

#[tauri::command]
pub(crate) async fn set_automation_status(
    app: tauri::AppHandle,
    automation_id: String,
    status: AutomationStatus,
) -> Result<Automation, String> {
    let parsed_id = parse_uuid(&automation_id)?;
    let should_cancel = status != AutomationStatus::Current;
    let automation = tauri::async_runtime::spawn_blocking(move || {
        set_automation_status_blocking(automation_id, status)
    })
    .await
    .map_err(|error| format!("automation status worker failed: {error}"))??;
    if should_cancel {
        cancel_scheduled_automation(&app, parsed_id);
    }
    emit_automation_update(&app, &automation);
    app.state::<AutomationSchedulerControl>().wake();
    Ok(automation)
}

pub(crate) fn set_automation_status_blocking(
    automation_id: String,
    status: AutomationStatus,
) -> Result<Automation, String> {
    let store = open_automation_store()?;
    let automation_id = parse_uuid(&automation_id)?;
    store
        .set_automation_status(automation_id, status)
        .map_err(to_string)?
        .ok_or_else(|| "automation not found".into())
}

#[tauri::command]
pub(crate) async fn run_automation(
    app: tauri::AppHandle,
    automation_id: String,
) -> Result<Automation, String> {
    let automation =
        tauri::async_runtime::spawn_blocking(move || run_automation_blocking(automation_id))
            .await
            .map_err(|error| format!("automation queue worker failed: {error}"))??;
    emit_automation_update(&app, &automation);
    app.state::<AutomationSchedulerControl>().wake();
    Ok(automation)
}

pub(crate) fn run_automation_blocking(automation_id: String) -> Result<Automation, String> {
    let store = open_automation_store()?;
    let automation_id = parse_uuid(&automation_id)?;
    store
        .queue_automation_now(automation_id)
        .map_err(to_string)?
        .ok_or_else(|| "automation not found".into())
}

#[tauri::command]
pub(crate) async fn claim_due_automation(
    lease_owner: String,
    lease_seconds: Option<i64>,
) -> Result<Option<Automation>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        claim_due_automation_blocking(lease_owner, lease_seconds)
    })
    .await
    .map_err(|error| format!("automation claim worker failed: {error}"))?
}

pub(crate) fn claim_due_automation_blocking(
    lease_owner: String,
    lease_seconds: Option<i64>,
) -> Result<Option<Automation>, String> {
    let store = open_automation_store()?;
    store
        .claim_due_automation(lease_owner, lease_seconds.unwrap_or(300))
        .map_err(to_string)
}

#[tauri::command]
pub(crate) async fn complete_automation_lease(
    automation_id: String,
    lease_owner: String,
    summary: String,
) -> Result<Automation, String> {
    tauri::async_runtime::spawn_blocking(move || {
        complete_automation_lease_blocking(automation_id, lease_owner, summary)
    })
    .await
    .map_err(|error| format!("automation lease complete worker failed: {error}"))?
}

pub(crate) fn complete_automation_lease_blocking(
    automation_id: String,
    lease_owner: String,
    summary: String,
) -> Result<Automation, String> {
    let store = open_automation_store()?;
    let automation_id = parse_uuid(&automation_id)?;
    store
        .complete_automation_lease(automation_id, lease_owner, summary)
        .map_err(to_string)?
        .ok_or_else(|| "automation not found".into())
}

#[tauri::command]
pub(crate) async fn recover_automation_leases() -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(recover_automation_leases_blocking)
        .await
        .map_err(|error| format!("automation lease recovery worker failed: {error}"))?
}

pub(crate) fn recover_automation_leases_blocking() -> Result<usize, String> {
    let store = open_automation_store()?;
    store
        .recover_expired_automation_leases_now()
        .map_err(to_string)
}

#[tauri::command]
pub(crate) async fn triage_automation(
    automation_id: String,
    triage_state: AutomationTriageState,
) -> Result<Automation, String> {
    tauri::async_runtime::spawn_blocking(move || {
        triage_automation_blocking(automation_id, triage_state)
    })
    .await
    .map_err(|error| format!("automation triage worker failed: {error}"))?
}

pub(crate) fn triage_automation_blocking(
    automation_id: String,
    triage_state: AutomationTriageState,
) -> Result<Automation, String> {
    let store = open_automation_store()?;
    let automation_id = parse_uuid(&automation_id)?;
    store
        .triage_automation(automation_id, triage_state)
        .map_err(to_string)?
        .ok_or_else(|| "automation not found".into())
}

pub(crate) fn emit_automation_update(app: &tauri::AppHandle, automation: &Automation) {
    if let Err(error) = app.emit(AUTOMATION_UPDATED_EVENT, automation) {
        eprintln!("could not emit automation update: {error}");
    }
}

pub(crate) fn automation_notification_content(
    automation: &Automation,
) -> Option<(&'static str, &'static str)> {
    match automation.run_history.first()?.status {
        AutomationRunStatus::Passed => Some((
            "Gyro automation finished",
            "A scheduled automation completed. Open Gyro to review the result.",
        )),
        AutomationRunStatus::Failed => Some((
            "Gyro automation needs attention",
            "A scheduled automation failed. Open Gyro to review the result.",
        )),
        AutomationRunStatus::Queued
        | AutomationRunStatus::Running
        | AutomationRunStatus::Stopped => None,
    }
}

pub(crate) fn cancel_scheduled_automation(app: &tauri::AppHandle, automation_id: Uuid) {
    let Some(session_id) = app
        .state::<AutomationSchedulerControl>()
        .session_for(automation_id)
    else {
        return;
    };
    if let Ok(flags) = app.state::<ProviderCancellationManager>().flags.lock() {
        if let Some(control) = flags.get(&session_id) {
            control.cancellation.cancel();
        }
    }
}
