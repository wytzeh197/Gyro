use crate::{
    app::{
        config::load_config_blocking,
        limits::{
            MAX_MODEL_TERMINAL_PROCESSES, PROVIDER_APPROVAL_EVENT, PROVIDER_APPROVAL_TIMEOUT,
            PROVIDER_CAPABILITY_EVENT,
        },
    },
    capabilities::access::{
        capability_access_for_call, capability_argument_string, capability_full_access_enabled,
        narrower_capability_access,
    },
    capability_inspection, code_mode,
    command_execution::{model_command_boundary, model_terminal_request, ModelCommandContext},
    delegated_agents,
    ide::task_discovery::content_hash,
    provider_accounting, provider_timeline,
    providers::approvals::record_provider_approval_terminal_event,
    state::{
        managers::{
            with_ide_evidence, CapabilityIdeEvidenceManager, ProviderCancellationManager,
            ProviderCapabilityApprovalManager, ProviderCapabilityResourceManager,
        },
        provider_run::{
            BoundProviderCapabilityContext, ModelTerminalResource, PendingCapabilityApproval,
        },
    },
    stores::open_store,
    terminal::types::{TerminalPaneSnapshot, TerminalProcessManager},
    workspace_capability_read,
};
use gyro_core::{
    timing, CapabilityAccess, CapabilityApprovalDecision, CapabilityCallEvent, CapabilityClass,
    CapabilityId, CapabilityResourceRef, CapabilityRunMode, CapabilityStatus,
    ProjectCapabilityGrant, SessionEvent, SessionEventKind, CAPABILITY_SCHEMA_V1,
};
use std::{
    path::Path,
    sync::mpsc,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use uuid::Uuid;
pub(crate) fn capability_event(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    call_id: Uuid,
    capability_id: CapabilityId,
    status: CapabilityStatus,
    summary: &str,
    resource: Option<CapabilityResourceRef>,
) -> anyhow::Result<SessionEvent> {
    capability_event_with_target(
        app,
        bound,
        call_id,
        capability_id,
        status,
        summary,
        resource,
        None,
    )
}

/// `target` names what a browser action touched ("Save", "Search") so the run
/// rail can say "Clicked Save" rather than an element ref. It is page content:
/// untrusted, sanitized, and only ever displayed.
#[allow(clippy::too_many_arguments)]
pub(crate) fn capability_event_with_target(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    call_id: Uuid,
    capability_id: CapabilityId,
    status: CapabilityStatus,
    summary: &str,
    resource: Option<CapabilityResourceRef>,
    target: Option<&str>,
) -> anyhow::Result<SessionEvent> {
    provider_accounting::tool_timing(call_id, status);
    let event = CapabilityCallEvent {
        schema: CAPABILITY_SCHEMA_V1.into(),
        kind: "capability-call".into(),
        call_id,
        capability_id,
        status,
        provider_id: bound.provider_id.clone(),
        policy_revision: bound.policy.revision,
        summary: gyro_core::sanitize_capability_summary(summary),
        resource,
    };
    let store = open_store().map_err(anyhow::Error::msg)?;
    let session_id = Uuid::parse_str(&bound.session_id)?;
    let mut payload = serde_json::to_value(event)?;
    code_mode::annotate(call_id, &mut payload);
    capability_inspection::annotate(call_id, &mut payload);
    provider_timeline::observe(
        app,
        &bound.session_id,
        Some(&format!("capability:{call_id}")),
        None,
    )
    .insert_into(&mut payload);
    if let Some(target) = target
        .map(gyro_core::sanitize_capability_summary)
        .filter(|target| !target.is_empty())
    {
        payload["target"] = serde_json::json!(target);
    }
    let stored = if let Some(turn_id) = bound.turn_id.as_deref() {
        store.append_event_with_turn_id(
            session_id,
            SessionEventKind::SystemEvent,
            summary,
            payload,
            Some(Uuid::parse_str(turn_id)?),
        )?
    } else {
        store.append_event(session_id, SessionEventKind::SystemEvent, summary, payload)?
    };
    let _ = app.emit(PROVIDER_CAPABILITY_EVENT, stored.clone());
    Ok(stored)
}

pub(crate) fn wait_for_capability_approval(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    call_id: Uuid,
    capability_id: CapabilityId,
    arguments: &serde_json::Value,
    class: CapabilityClass,
    scope_kind: &str,
    scope_value: &str,
) -> anyhow::Result<CapabilityApprovalDecision> {
    let _timing = timing::ApprovalScope::start();
    let approval_id = Uuid::new_v4();
    let session_id = Uuid::parse_str(&bound.session_id)?;
    let turn_id = bound.turn_id.as_deref().map(Uuid::parse_str).transpose()?;
    let (sender, receiver) = mpsc::channel();
    app.state::<ProviderCapabilityApprovalManager>()
        .pending
        .lock()
        .map_err(|_| anyhow::anyhow!("capability approval state is unavailable"))?
        .insert(
            approval_id.to_string(),
            PendingCapabilityApproval {
                sender,
                session_id,
                turn_id,
            },
        );
    let mut payload = serde_json::json!({
        "schema": CAPABILITY_SCHEMA_V1,
        "kind": "capability-approval",
        "approvalId": approval_id,
        "callId": call_id,
        "capabilityId": capability_id,
        "capabilityClass": class,
        "providerId": bound.provider_id,
        "status": "waiting",
        "scopeKind": scope_kind,
        "scopeValue": gyro_core::sanitize_capability_summary(scope_value),
        "choices": if capability_id == CapabilityId::WorkspaceReadEditor {
            serde_json::json!(["deny", "allow-once"])
        } else {
            serde_json::json!(["deny", "allow-once", "allow-project"])
        },
    });
    provider_timeline::observe(
        app,
        &bound.session_id,
        Some(&format!("capability:{call_id}")),
        None,
    )
    .insert_into(&mut payload);
    let store = open_store().map_err(anyhow::Error::msg)?;
    let event = if let Some(turn_id) = turn_id {
        store.append_event_with_turn_id(
            session_id,
            SessionEventKind::ApprovalRequested,
            format!("Approve {}", capability_id.as_str()),
            payload,
            Some(turn_id),
        )?
    } else {
        store.append_event(
            session_id,
            SessionEventKind::ApprovalRequested,
            format!("Approve {}", capability_id.as_str()),
            payload,
        )?
    };
    let mut visible_event = event;
    if capability_id == CapabilityId::WorkspaceReadEditor {
        let path = arguments
            .get("path")
            .and_then(serde_json::Value::as_str)
            .map(gyro_core::normalize_capability_relative_path)
            .transpose()?;
        let path = path.as_deref();
        let selection_only = arguments
            .get("selectionOnly")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let latest = app
            .state::<CapabilityIdeEvidenceManager>()
            .evidence
            .lock()
            .ok()
            .and_then(|contexts| contexts.get(&bound.workspace_key).cloned())
            .unwrap_or_else(|| bound.workspace_context.clone());
        let source = if selection_only {
            latest.selection.as_ref()
        } else {
            latest
                .buffers
                .iter()
                .find(|buffer| buffer.get("path").and_then(serde_json::Value::as_str) == path)
        };
        if let Some(source) =
            source.filter(|source| source.get("path").and_then(serde_json::Value::as_str) == path)
        {
            let content = source
                .get(if selection_only { "text" } else { "content" })
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            visible_event.payload["editorPreview"] = serde_json::json!({
                "path": path,
                "content": content,
                "selectionOnly": selection_only,
                "dirty": source.get("dirty").and_then(serde_json::Value::as_bool).unwrap_or(false),
                "truncated": source.get("truncated").and_then(serde_json::Value::as_bool).unwrap_or(false),
                "documentVersion": source.get("documentVersion"),
            });
        }
    }
    let _ = capability_event(
        app,
        bound,
        call_id,
        capability_id,
        CapabilityStatus::Waiting,
        "Waiting for approval",
        None,
    );
    let _ = app.emit(PROVIDER_APPROVAL_EVENT, visible_event);
    let started_at = Instant::now();
    let decision = loop {
        match receiver.recv_timeout(Duration::from_millis(250)) {
            Ok(decision) => break Ok(decision),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                break Err("capability approval was cancelled".to_string())
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        let active = app
            .state::<ProviderCancellationManager>()
            .flags
            .lock()
            .ok()
            .and_then(|flags| flags.get(&bound.session_id).cloned());
        if code_mode::cancelled()
            || active
                .as_ref()
                .map_or(true, |control| control.cancellation.is_cancelled())
        {
            break Err("capability approval was cancelled".to_string());
        }
        // A permission-mode change also releases already waiting delegation.
        // Recheck live project policy so auto approval cannot bypass a denial.
        let automatic = load_config_blocking().is_ok_and(|config| {
            let full_access = capability_id != CapabilityId::WorkspaceReadEditor
                && bound.policy.mode == CapabilityRunMode::Normal
                && delegated_agents::full_access_ceiling(app, &bound.session_id)
                && capability_full_access_enabled(&config);
            full_access
                || (delegated_agents::delegation_tool(capability_id)
                    && store
                        .get_project_capability_policy(&bound.workspace_key)
                        .is_ok_and(|current| {
                            let mut access = capability_access_for_call(
                                bound,
                                &current,
                                class,
                                scope_kind,
                                scope_value,
                            );
                            if bound.policy.mode == CapabilityRunMode::Plan {
                                access = narrower_capability_access(
                                    bound
                                        .policy
                                        .classes
                                        .get(&class)
                                        .copied()
                                        .unwrap_or(CapabilityAccess::Deny),
                                    current.access_for(class),
                                );
                            }
                            delegated_agents::permission_access(
                                access,
                                capability_id,
                                bound.policy.mode,
                                &config,
                            ) == CapabilityAccess::Allow
                        }))
        });
        if automatic {
            break Ok(CapabilityApprovalDecision::AllowOnce);
        }
        if started_at.elapsed() >= PROVIDER_APPROVAL_TIMEOUT {
            break Err("capability approval timed out".to_string());
        }
    };
    app.state::<ProviderCapabilityApprovalManager>()
        .pending
        .lock()
        .ok()
        .map(|mut pending| pending.remove(&approval_id.to_string()));
    code_mode::finish_approval(app, &store, session_id, turn_id, approval_id, &decision);
    if !code_mode::in_group() {
        let status = match &decision {
            Ok(CapabilityApprovalDecision::Deny) => "rejected",
            Ok(_) => "approved",
            Err(message) if message.contains("cancelled") => "cancelled",
            Err(_) => "failed",
        };
        if let Err(error) = record_provider_approval_terminal_event(
            app,
            &store,
            session_id,
            turn_id,
            serde_json::json!({"kind":"capability-approval","approvalId":approval_id,"callId":call_id}),
            status,
            &format!("Capability approval {status}"),
        ) {
            eprintln!(
                "could not save capability approval outcome: {}",
                gyro_core::security::redact_secrets(&error.to_string())
            );
        }
    }
    decision
        .map(|decision| {
            if capability_id == CapabilityId::WorkspaceReadEditor
                && decision == CapabilityApprovalDecision::AllowProject
            {
                CapabilityApprovalDecision::AllowOnce
            } else {
                decision
            }
        })
        .map_err(anyhow::Error::msg)
}

pub(crate) fn editor_approval_fingerprint(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    arguments: &serde_json::Value,
) -> anyhow::Result<String> {
    let path = gyro_core::normalize_capability_relative_path(capability_argument_string(
        arguments, "path",
    )?)?;
    let selection_only = arguments
        .get("selectionOnly")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    // The live buffer is the thing being approved, so read it under the cache
    // lock instead of copying every open buffer in the workspace first.
    with_ide_evidence(app, bound, |latest| {
        let source = if selection_only {
            latest.selection.as_ref()
        } else {
            latest.buffers.iter().find(|buffer| {
                buffer.get("path").and_then(serde_json::Value::as_str) == Some(path.as_str())
            })
        }
        .filter(|source| {
            source.get("path").and_then(serde_json::Value::as_str) == Some(path.as_str())
        })
        .ok_or_else(|| anyhow::anyhow!("requested live editor text is unavailable"))?;
        if selection_only {
            anyhow::ensure!(
                !source
                    .get("truncated")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
                "live editor text exceeds the approval limit; select a smaller range"
            );
            anyhow::ensure!(
                source
                    .get("text")
                    .and_then(serde_json::Value::as_str)
                    .is_some(),
                "requested live editor text is unavailable"
            );
        } else {
            workspace_capability_read::held_editor_text(source)?;
        }
        Ok(content_hash(&serde_json::to_vec(source)?))
    })
}

pub(crate) fn persist_capability_grant(
    bound: &BoundProviderCapabilityContext,
    class: CapabilityClass,
    scope_kind: String,
    scope_value: String,
) -> anyhow::Result<()> {
    let store = open_store().map_err(anyhow::Error::msg)?;
    let mut policy = store.get_project_capability_policy(&bound.workspace_key)?;
    if !policy.grants.iter().any(|grant| {
        grant.class == class && grant.scope_kind == scope_kind && grant.scope_value == scope_value
    }) {
        policy.grants.push(ProjectCapabilityGrant {
            id: Uuid::new_v4(),
            class,
            scope_kind,
            scope_value,
            created_at: chrono::Utc::now(),
        });
        store.save_project_capability_policy(policy.clone(), Some(policy.revision))?;
    }
    Ok(())
}

/// Claim this chat's single model-owned terminal and start `command` in it.
///
/// Shared by `terminal.open` and by background `workspace.run_task`, so a
/// background task is readable and stoppable through the same terminal
/// capabilities instead of blocking the turn until it exits.
pub(crate) fn claim_model_terminal(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    call_id: Uuid,
    title: String,
    command: String,
    args: Vec<String>,
    cwd: &Path,
) -> anyhow::Result<(String, TerminalPaneSnapshot)> {
    let resources = app.state::<ProviderCapabilityResourceManager>();
    let mut terminals = resources
        .terminals
        .lock()
        .map_err(|_| anyhow::anyhow!("terminal capability state is unavailable"))?;
    let is_running = |owned: &ModelTerminalResource| {
        app.state::<TerminalProcessManager>()
            .read(&owned.pane_id, None)
            .is_ok_and(|snapshot| snapshot.status == "running")
    };
    // Keep completed resources readable until their owning chat replaces them.
    // Another chat starting a command must not erase a waiter's final result.
    if terminals.get(&bound.session_id).is_some_and(is_running) {
        anyhow::bail!("this chat already owns a live model terminal");
    }
    if terminals.values().filter(|owned| is_running(owned)).count() >= MAX_MODEL_TERMINAL_PROCESSES
    {
        anyhow::bail!("model terminal limit reached");
    }
    let resource_id = Uuid::new_v4().to_string();
    let pane_id = format!("model:{}", bound.session_id);
    let mut terminal_request = model_terminal_request(
        pane_id.clone(),
        title,
        command,
        args,
        &bound.workspace_key,
        cwd,
        model_command_boundary(app, bound)?,
    );
    terminal_request.model_command_context = Some(ModelCommandContext::from_bound(bound));
    let snapshot = app
        .state::<TerminalProcessManager>()
        .create(terminal_request)?;
    terminals.insert(
        bound.session_id.clone(),
        ModelTerminalResource {
            resource_id: resource_id.clone(),
            pane_id,
            session_id: bound.session_id.clone(),
            turn_id: bound.turn_id.clone(),
            call_id,
            workspace_key: bound.workspace_key.clone(),
        },
    );
    Ok((resource_id, snapshot))
}
