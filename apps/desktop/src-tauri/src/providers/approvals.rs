use crate::{
    app::limits::{PROVIDER_APPROVAL_EVENT, PROVIDER_APPROVAL_TIMEOUT},
    capabilities::{bridge::provider_run_approval_matches, types::ProviderApprovalDecisionRequest},
    desktop_notifications::notify_provider_approval_question,
    providers::{
        chat_types::ProviderChatRequest,
        streaming::{provider_chat_cancelled, provider_stop_message},
    },
    state::{
        managers::{ProviderApprovalManager, ProviderCancellationManager},
        provider_run::{
            PendingProviderApproval, ProviderApprovalContext, ProviderApprovalDecision,
        },
    },
    stores::{open_store, to_string},
    text::truncate_chars,
};
use anyhow::Context;
use gyro_core::{
    apply_provider_mutation_transaction_with_cancellation, begin_provider_mutation_transaction,
    ipc::{
        versions_compatible, DesktopProviderApprovalRequest, DesktopProviderApprovalResponse,
        DESKTOP_PROVIDER_APPROVAL_IPC_SCHEMA_V1,
    },
    prepare_claude_provider_mutation_transaction, prepare_provider_mutation_transaction, timing,
    GyroConfig, GyroPaths, PendingProviderMutationCommit, PreparedProviderMutationTransaction,
    ProviderFileChange, ProviderMutationJournalContext, SessionEvent, SessionEventKind,
    SessionStore,
};
use std::{
    path::Path,
    sync::mpsc,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use uuid::Uuid;
#[tauri::command]
pub(crate) async fn resolve_provider_approval(
    app: tauri::AppHandle,
    request: ProviderApprovalDecisionRequest,
) -> Result<SessionEvent, String> {
    tauri::async_runtime::spawn_blocking(move || resolve_provider_approval_blocking(app, request))
        .await
        .map_err(|error| format!("provider approval worker failed: {error}"))?
}

/// Approving a reviewed file set opens the session store, writes a durable
/// mutation journal, fsyncs every changed file and appends a session event.
/// That is seconds of disk work for a large edit set, so it runs on a blocking
/// worker; left on the async runtime it starved the IPC thread pool and every
/// other command — session lists, event reads, terminal reads — stalled behind
/// one approval.
pub(crate) fn resolve_provider_approval_blocking(
    app: tauri::AppHandle,
    request: ProviderApprovalDecisionRequest,
) -> Result<SessionEvent, String> {
    let decision = match request.decision.as_str() {
        "approve" => ProviderApprovalDecision::Approve,
        "reject" => ProviderApprovalDecision::Reject,
        _ => return Err("provider approval decision must be approve or reject".into()),
    };
    let pending = app
        .state::<ProviderApprovalManager>()
        .pending
        .lock()
        .map_err(|_| "provider approval state is unavailable".to_string())?
        .remove(&request.approval_id)
        .ok_or_else(|| "this provider approval is no longer pending".to_string())?;
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    let store = open_store()?;
    let mut payload = pending.payload;
    let mut provider_decision = decision;
    let mut pending_mutation: Option<PendingProviderMutationCommit> = None;
    if decision == ProviderApprovalDecision::Approve {
        if let Some(transaction) = pending.file_transaction.as_ref() {
            match begin_provider_mutation_transaction(
                transaction,
                &paths.mutation_journals_dir,
                ProviderMutationJournalContext {
                    session_id: pending.session_id,
                    approval_id: pending.approval_id,
                },
            ) {
                Ok(commit) => {
                    payload["changedPaths"] =
                        serde_json::to_value(commit.result().changed_paths.clone())
                            .map_err(|error| error.to_string())?;
                    payload["fileChanges"] = serde_json::to_value(&commit.result().file_changes)
                        .map_err(|error| error.to_string())?;
                    provider_decision = ProviderApprovalDecision::AppliedByGyro;
                    pending_mutation = Some(commit);
                }
                Err(error) => {
                    payload["status"] = serde_json::Value::String("failed".into());
                    payload["error"] = serde_json::Value::String(error.to_string());
                    payload["decidedAt"] =
                        serde_json::Value::String(chrono::Utc::now().to_rfc3339());
                    let event = store.append_event_with_turn_id(
                        pending.session_id,
                        SessionEventKind::SystemEvent,
                        "Provider file changes were not applied",
                        payload,
                        pending.turn_id,
                    );
                    let _ = pending.sender.send(ProviderApprovalDecision::Reject);
                    let event = event.map_err(to_string)?;
                    let _ = app.emit(PROVIDER_APPROVAL_EVENT, event);
                    return Err(format!("The reviewed file set was not applied: {error}"));
                }
            }
        }
    }
    payload["status"] = serde_json::Value::String(
        match provider_decision {
            ProviderApprovalDecision::Approve => "approved",
            ProviderApprovalDecision::Reject => "rejected",
            ProviderApprovalDecision::AppliedByGyro => "applied",
        }
        .into(),
    );
    payload["decidedAt"] = serde_json::Value::String(chrono::Utc::now().to_rfc3339());
    let event = match store.append_event_with_turn_id(
        pending.session_id,
        SessionEventKind::SystemEvent,
        match provider_decision {
            ProviderApprovalDecision::Approve => "Provider action approved",
            ProviderApprovalDecision::Reject => "Provider action rejected",
            ProviderApprovalDecision::AppliedByGyro => "Provider file changes applied through Gyro",
        },
        payload,
        pending.turn_id,
    ) {
        Ok(event) => event,
        Err(error) => {
            let rollback_error = pending_mutation.and_then(|commit| commit.rollback().err());
            let _ = pending.sender.send(ProviderApprovalDecision::Reject);
            return Err(match rollback_error {
                Some(rollback_error) => format!(
                    "record provider approval failed ({error}); rollback also failed: {rollback_error}"
                ),
                None => to_string(error),
            });
        }
    };
    if let Some(commit) = pending_mutation {
        if let Err(error) = commit.mark_applied() {
            eprintln!("Gyro could not write the durable applied marker before cleanup: {error}");
        }
        if let Err(error) = commit.finalize() {
            eprintln!("Gyro deferred provider mutation cleanup until restart: {error}");
        }
    }
    pending
        .sender
        .send(provider_decision)
        .map_err(|_| "the provider turn ended before the decision was delivered".to_string())?;
    let _ = app.emit(PROVIDER_APPROVAL_EVENT, event.clone());
    Ok(event)
}

pub(crate) struct AgentCommandBlockGuard {
    pub(crate) session_id: Uuid,
    pub(crate) active: bool,
}

impl Drop for AgentCommandBlockGuard {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let Ok(paths) = GyroPaths::for_current_user() else {
            return;
        };
        let Ok(store) = gyro_core::agent_sessions::AgentSessionStore::open(paths) else {
            return;
        };
        let _ = store.clear_command_block_for_session(self.session_id);
    }
}

pub(crate) fn wait_for_provider_approval(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    approval_type: &str,
    details: serde_json::Value,
) -> anyhow::Result<ProviderApprovalDecision> {
    let file_transaction = if approval_type == "file-change" {
        let workspace_path = request
            .workspace_path
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("provider file approval has no selected workspace"))?;
        let changes = details
            .pointer("/patch/changes")
            .or_else(|| details.pointer("/change/changes"))
            .cloned()
            .ok_or_else(|| {
                anyhow::anyhow!("provider file approval did not include the reviewed file set")
            })?;
        let changes: Vec<ProviderFileChange> =
            serde_json::from_value(changes).context("decode reviewed provider file changes")?;
        Some(prepare_provider_mutation_transaction(
            Path::new(workspace_path),
            &changes,
        )?)
    } else {
        None
    };
    wait_for_provider_approval_with_transaction(
        app,
        &ProviderApprovalContext::from(request),
        approval_type,
        details,
        file_transaction,
    )
}

pub(crate) fn wait_for_provider_approval_with_transaction(
    app: &tauri::AppHandle,
    context: &ProviderApprovalContext,
    approval_type: &str,
    details: serde_json::Value,
    file_transaction: Option<PreparedProviderMutationTransaction>,
) -> anyhow::Result<ProviderApprovalDecision> {
    let _timing = timing::ApprovalScope::start();
    let approval_id = Uuid::new_v4();
    let session_id = Uuid::parse_str(&context.session_id)?;
    let turn_id = context
        .turn_id
        .as_deref()
        .map(Uuid::parse_str)
        .transpose()?;
    let command = details
        .get("command")
        .and_then(serde_json::Value::as_str)
        .map(gyro_core::sanitize_harness_text);
    let _agent_command_block = if approval_type == "command" {
        let summary = command.clone().unwrap_or_else(|| "command".into());
        let active = GyroPaths::for_current_user()
            .and_then(gyro_core::agent_sessions::AgentSessionStore::open)
            .and_then(|store| store.note_command_block(session_id, approval_id, &summary))
            .unwrap_or(false);
        Some(AgentCommandBlockGuard { session_id, active })
    } else {
        None
    };
    let reason = details
        .get("reason")
        .and_then(serde_json::Value::as_str)
        .map(gyro_core::sanitize_harness_text);
    let payload = serde_json::json!({
        "schema": "gyro.provider-approval.v1",
        "kind": "provider-tool-approval",
        "approvalId": approval_id,
        "approvalType": approval_type,
        "providerId": context.provider_id,
        "providerLabel": context.provider_label,
        "command": command,
        "cwd": details.get("cwd"),
        "reason": reason,
        "details": details,
        "status": "pending",
        "risk": provider_approval_risk(approval_type),
    });
    let store = open_store().map_err(anyhow::Error::msg)?;
    let event = store.append_event_with_turn_id(
        session_id,
        SessionEventKind::ApprovalRequested,
        provider_approval_label(approval_type),
        payload.clone(),
        turn_id,
    )?;
    let (sender, receiver) = mpsc::channel();
    app.state::<ProviderApprovalManager>()
        .pending
        .lock()
        .map_err(|_| anyhow::anyhow!("provider approval state is unavailable"))?
        .insert(
            approval_id.to_string(),
            PendingProviderApproval {
                sender,
                approval_id,
                session_id,
                turn_id,
                payload: payload.clone(),
                file_transaction,
            },
        );
    let _ = app.emit(PROVIDER_APPROVAL_EVENT, event);
    notify_provider_approval_question(app, context, approval_id, approval_type);
    let approval_key = approval_id.to_string();
    let started_at = Instant::now();
    loop {
        match receiver.recv_timeout(Duration::from_millis(250)) {
            Ok(decision) => {
                remove_pending_provider_approval(app, &approval_key);
                return Ok(decision);
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                remove_pending_provider_approval(app, &approval_key);
                record_provider_approval_terminal_event(
                    app,
                    &store,
                    session_id,
                    turn_id,
                    payload,
                    "failed",
                    "Provider approval channel closed",
                )?;
                anyhow::bail!("provider approval channel closed")
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if started_at.elapsed() >= PROVIDER_APPROVAL_TIMEOUT {
            remove_pending_provider_approval(app, &approval_key);
            record_provider_approval_terminal_event(
                app,
                &store,
                session_id,
                turn_id,
                payload,
                "expired",
                "Provider approval expired",
            )?;
            anyhow::bail!("provider approval expired after 15 minutes");
        }
        if provider_chat_cancelled(app, &context.session_id) {
            remove_pending_provider_approval(app, &approval_key);
            record_provider_approval_terminal_event(
                app,
                &store,
                session_id,
                turn_id,
                payload,
                "cancelled",
                "Provider approval cancelled",
            )?;
            anyhow::bail!("{}", provider_stop_message(app, &context.session_id));
        }
    }
}

pub(crate) fn remove_pending_provider_approval(app: &tauri::AppHandle, approval_key: &str) {
    if let Ok(mut pending) = app.state::<ProviderApprovalManager>().pending.lock() {
        pending.remove(approval_key);
    }
}

pub(crate) fn record_provider_approval_terminal_event(
    app: &tauri::AppHandle,
    store: &SessionStore,
    session_id: Uuid,
    turn_id: Option<Uuid>,
    mut payload: serde_json::Value,
    status: &str,
    message: &str,
) -> anyhow::Result<()> {
    payload["status"] = serde_json::Value::String(status.into());
    let event = store.append_event_with_turn_id(
        session_id,
        SessionEventKind::SystemEvent,
        message,
        payload,
        turn_id,
    )?;
    let _ = app.emit(PROVIDER_APPROVAL_EVENT, event);
    Ok(())
}

pub(crate) fn provider_approval_label(approval_type: &str) -> &'static str {
    match approval_type {
        "command" => "Review command",
        "file-change" => "Review provider file changes",
        _ => "Review provider permissions",
    }
}

pub(crate) fn provider_approval_risk(approval_type: &str) -> &'static str {
    match approval_type {
        "command" => "Runs a command in the selected project",
        "file-change" => "Allows the provider to apply the displayed workspace patch",
        _ => "Expands provider access for this turn",
    }
}

pub(crate) fn desktop_claude_approval_type(tool_name: &str) -> &'static str {
    match tool_name {
        "Bash" | "KillShell" => "command",
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => "file-change",
        _ => "permissions",
    }
}

pub(crate) fn sanitize_provider_approval_details(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::String(value) => {
            serde_json::Value::String(gyro_core::security::redact_secrets(&value))
        }
        serde_json::Value::Array(values) => serde_json::Value::Array(
            values
                .into_iter()
                .map(sanitize_provider_approval_details)
                .collect(),
        ),
        serde_json::Value::Object(values) => serde_json::Value::Object(
            values
                .into_iter()
                .map(|(key, value)| (key, sanitize_provider_approval_details(value)))
                .collect(),
        ),
        value => value,
    }
}

pub(crate) fn desktop_claude_approval_details(
    request: &DesktopProviderApprovalRequest,
    workspace_path: &Path,
) -> serde_json::Value {
    let command = request
        .input
        .get("command")
        .and_then(serde_json::Value::as_str)
        .map(|command| truncate_chars(&gyro_core::security::redact_secrets(command), 12_000));
    let reason = request
        .input
        .get("description")
        .or_else(|| request.input.get("reason"))
        .and_then(serde_json::Value::as_str)
        .map(|reason| truncate_chars(&gyro_core::security::redact_secrets(reason), 2_000));
    let file_path = request
        .input
        .get("file_path")
        .or_else(|| request.input.get("filePath"))
        .and_then(serde_json::Value::as_str);
    let input_summary = match desktop_claude_approval_type(&request.tool_name) {
        "file-change" => serde_json::json!({
            "filePath": file_path,
            "operation": request.tool_name,
            "contentBytes": request
                .input
                .get("content")
                .and_then(serde_json::Value::as_str)
                .map(str::len),
            "editCount": request
                .input
                .get("edits")
                .and_then(serde_json::Value::as_array)
                .map(Vec::len)
                .or_else(|| (request.tool_name == "Edit").then_some(1)),
            "replaceAll": request
                .input
                .get("replace_all")
                .or_else(|| request.input.get("replaceAll"))
                .and_then(serde_json::Value::as_bool),
        }),
        "command" => serde_json::json!({
            "command": command.clone(),
            "cwd": workspace_path,
        }),
        _ => serde_json::json!({
            "keys": request
                .input
                .as_object()
                .map(|input| input.keys().take(32).cloned().collect::<Vec<_>>())
                .unwrap_or_default(),
        }),
    };
    let permission_suggestions = serde_json::to_string(&sanitize_provider_approval_details(
        request.permission_suggestions.clone(),
    ))
    .ok()
    .map(|value| truncate_chars(&value, 8_000));
    sanitize_provider_approval_details(serde_json::json!({
        "toolName": request.tool_name,
        "input": input_summary,
        "permissionSuggestions": permission_suggestions,
        "command": command,
        "cwd": workspace_path,
        "reason": reason,
        "patch": {
            "changes": file_path
                .map(|path| vec![serde_json::json!({ "path": path })])
                .unwrap_or_default(),
        },
    }))
}

pub(crate) fn record_provider_approval_failure(
    app: &tauri::AppHandle,
    context: &ProviderApprovalContext,
    approval_type: &str,
    details: serde_json::Value,
    error: &str,
) {
    let Ok(session_id) = Uuid::parse_str(&context.session_id) else {
        return;
    };
    let turn_id = context
        .turn_id
        .as_deref()
        .and_then(|turn_id| Uuid::parse_str(turn_id).ok());
    let payload = serde_json::json!({
        "schema": "gyro.provider-approval.v1",
        "kind": "provider-tool-approval",
        "approvalId": Uuid::new_v4(),
        "approvalType": approval_type,
        "providerId": context.provider_id,
        "providerLabel": context.provider_label,
        "details": details,
        "status": "failed",
        "risk": provider_approval_risk(approval_type),
        "error": gyro_core::sanitize_harness_text(error),
    });
    let Ok(store) = open_store() else {
        return;
    };
    if let Ok(event) = store.append_event_with_turn_id(
        session_id,
        SessionEventKind::ApprovalRequested,
        "Provider action could not be reviewed",
        payload,
        turn_id,
    ) {
        let _ = app.emit(PROVIDER_APPROVAL_EVENT, event);
    }
}

pub(crate) fn handle_desktop_provider_approval_request(
    app: &tauri::AppHandle,
    request: DesktopProviderApprovalRequest,
) -> DesktopProviderApprovalResponse {
    if request.schema != DESKTOP_PROVIDER_APPROVAL_IPC_SCHEMA_V1
        || !versions_compatible(&request.sender_version, env!("CARGO_PKG_VERSION"))
    {
        let mut response = DesktopProviderApprovalResponse::deny(
            "The Claude approval helper does not match this Gyro.app version.",
        );
        response.compatible = false;
        return response;
    }
    if request.provider_id != "anthropic" {
        return DesktopProviderApprovalResponse::deny(
            "Gyro rejected a provider approval request from an unexpected provider.",
        );
    }
    let session_id = match Uuid::parse_str(&request.session_id) {
        Ok(session_id) => session_id,
        Err(_) => {
            return DesktopProviderApprovalResponse::deny(
                "Gyro rejected a provider approval request with an invalid session.",
            )
        }
    };
    if request
        .turn_id
        .as_deref()
        .map(Uuid::parse_str)
        .transpose()
        .is_err()
    {
        return DesktopProviderApprovalResponse::deny(
            "Gyro rejected a provider approval request with an invalid turn.",
        );
    }
    let store = match open_store() {
        Ok(store) => store,
        Err(error) => return DesktopProviderApprovalResponse::deny(error),
    };
    let config = match GyroPaths::for_current_user().and_then(|paths| GyroConfig::load(&paths)) {
        Ok(config) => config,
        Err(error) => return DesktopProviderApprovalResponse::deny(error.to_string()),
    };
    let session = match store.get_session(session_id) {
        Ok(Some(session)) => session,
        Ok(None) => {
            return DesktopProviderApprovalResponse::deny(
                "Gyro could not find the chat that requested this approval.",
            )
        }
        Err(error) => return DesktopProviderApprovalResponse::deny(error.to_string()),
    };
    if session.provider_id.as_deref() != Some("anthropic") {
        return DesktopProviderApprovalResponse::deny(
            "Gyro rejected an approval request for a chat using another provider.",
        );
    }
    let active_run_matches = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .map(|flags| provider_run_approval_matches(&flags, &request.session_id, &request.run_nonce))
        .unwrap_or(false);
    if !active_run_matches {
        return DesktopProviderApprovalResponse::deny(
            "Gyro rejected an approval request that was not issued by the active provider run.",
        );
    }
    let approval_type = desktop_claude_approval_type(&request.tool_name);
    let posture = gyro_core::approval_posture(
        config.full_access,
        config.require_command_approval,
        config.require_file_edit_approval,
    );
    // Claude `auto` already approved the safe set. A prompt that still arrives
    // is outside that set, so Approve for me asks instead of allowing it.
    let required = if posture == gyro_core::ApprovalPosture::ApproveForMe
        && gyro_core::approve_for_me_keeps_escalations("anthropic")
    {
        true
    } else {
        match approval_type {
            "command" => config.require_command_approval,
            "file-change" => config.require_file_edit_approval,
            _ => config.require_command_approval || config.require_file_edit_approval,
        }
    };
    let details = desktop_claude_approval_details(&request, &session.workspace_path);
    let context = ProviderApprovalContext {
        session_id: request.session_id.clone(),
        turn_id: request.turn_id.clone(),
        provider_id: request.provider_id.clone(),
        provider_label: session.provider_label.clone(),
    };
    let file_transaction = if approval_type == "file-change" {
        match prepare_claude_provider_mutation_transaction(
            &session.workspace_path,
            &request.tool_name,
            &request.input,
        ) {
            Ok(transaction) => Some(transaction),
            Err(error) => {
                record_provider_approval_failure(
                    app,
                    &context,
                    approval_type,
                    details,
                    &error.to_string(),
                );
                return DesktopProviderApprovalResponse::deny(format!(
                    "Gyro could not safely review this file change: {}",
                    gyro_core::sanitize_harness_text(&error.to_string())
                ));
            }
        }
    } else {
        None
    };
    if !required {
        if let Some(transaction) = file_transaction.as_ref() {
            let cancellation = app
                .state::<ProviderCancellationManager>()
                .flags
                .lock()
                .ok()
                .and_then(|flags| flags.get(&request.session_id).cloned())
                .map(|control| control.cancellation.clone())
                .unwrap_or_default();
            return match apply_provider_mutation_transaction_with_cancellation(transaction, || {
                cancellation.is_cancelled()
            }) {
                Ok(_) => desktop_claude_approval_response(
                    ProviderApprovalDecision::AppliedByGyro,
                    request.input,
                ),
                Err(error) => DesktopProviderApprovalResponse::deny(format!(
                    "Gyro could not safely apply this file change: {}",
                    gyro_core::sanitize_harness_text(&error.to_string())
                )),
            };
        }
        return DesktopProviderApprovalResponse::allow(
            request.input,
            "Gyro allowed this action under the current permissions.",
        );
    }
    match wait_for_provider_approval_with_transaction(
        app,
        &context,
        approval_type,
        details,
        file_transaction,
    ) {
        Ok(decision) => desktop_claude_approval_response(decision, request.input),
        Err(error) => DesktopProviderApprovalResponse::deny(format!(
            "Gyro could not complete this approval: {}",
            gyro_core::sanitize_harness_text(&error.to_string())
        )),
    }
}

pub(crate) fn desktop_claude_approval_response(
    decision: ProviderApprovalDecision,
    input: serde_json::Value,
) -> DesktopProviderApprovalResponse {
    match decision {
        ProviderApprovalDecision::Approve => DesktopProviderApprovalResponse::allow(
            input,
            "Gyro approved this provider action.",
        ),
        ProviderApprovalDecision::AppliedByGyro => DesktopProviderApprovalResponse::deny(
            "Gyro already applied the reviewed file changes atomically. Re-read the files and continue without retrying the write.",
        ),
        ProviderApprovalDecision::Reject => DesktopProviderApprovalResponse::deny(
            "The user rejected this provider action in Gyro.",
        ),
    }
}

#[cfg(test)]
pub(crate) use gyro_core::provider_runtime::support::claude_multimodal_input;
