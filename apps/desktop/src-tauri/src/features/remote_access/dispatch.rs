use super::{err, Runtime};
use crate::{
    state::managers::{
        ProviderApprovalManager, ProviderCancellationManager, ProviderCapabilityApprovalManager,
    },
    stores::{open_store, parse_uuid},
};
use gyro_remote::{
    protocol::{ApprovalKind, ModelChoice},
    Operation, Request,
};
use serde::Serialize;
use serde_json::{json, Value};
#[cfg(debug_assertions)]
use tauri::Emitter;
use tauri::Manager;

pub(super) fn value<T: Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(err)
}
pub(super) fn execute(runtime: &Runtime, peer: &str, request: &Request) -> Result<Value, String> {
    match &request.operation {
        Operation::Hello => hello(runtime),
        Operation::Projects => value(runtime.store.projects().map_err(err)?),
        Operation::Sessions { project_id } => {
            let project = runtime.store.project(project_id).map_err(err)?;
            value(
                open_store()?
                    .list_sessions()
                    .map_err(err)?
                    .into_iter()
                    .filter(|s| {
                        s.parent_session_id.is_none()
                            && runtime
                                .store
                                .belongs(&s.id.to_string(), &s.workspace_path, &project)
                            && runtime.session(&s.id.to_string()).is_ok()
                    })
                    .collect::<Vec<_>>(),
            )
        }
        Operation::CreateSession {
            project_id,
            title,
            model,
            branch,
        } => {
            let project = runtime.store.project(project_id).map_err(err)?;
            validate_model(model)?;
            if title.chars().count() > 80 {
                return Err("Session title is too long".into());
            }
            let path = project.path.to_string_lossy().to_string();
            let session = if let Some(branch) = branch {
                crate::sessions::commands::create_worktree_session_blocking(
                    path,
                    title.clone(),
                    branch.clone(),
                    None,
                    Some(model.provider_id.clone()),
                    None,
                    Some(model.model_id.clone()),
                    None,
                    model.reasoning_effort.clone(),
                )?
            } else {
                crate::sessions::commands::create_desktop_session_blocking(
                    path,
                    title.clone(),
                    Some(model.provider_id.clone()),
                    None,
                    Some(model.model_id.clone()),
                    None,
                    model.reasoning_effort.clone(),
                )?
            };
            runtime
                .store
                .scope(
                    &session.id.to_string(),
                    &project.id,
                    &session.workspace_path,
                )
                .map_err(err)?;
            let control = runtime.controls.lock().map_err(err)?.claim(
                &session.id.to_string(),
                peer,
                false,
            )?;
            Ok(json!({"session":session,"control":control}))
        }
        Operation::RenameSession { session_id, title } => {
            if title.trim().is_empty() || title.chars().count() > 80 {
                return Err("Use a session title between 1 and 80 characters".into());
            }
            value(
                open_store()?
                    .rename_session(parse_uuid(session_id)?, title)
                    .map_err(err)?,
            )
        }
        Operation::History {
            session_id,
            before,
            revision,
        } => value(crate::session_history::read_session_events_blocking(
            session_id.clone(),
            before.clone(),
            Some(200),
            false,
            revision.clone(),
        )?),
        Operation::Snapshot { session_id } => snapshot(runtime, session_id),
        Operation::Watch { .. } => Ok(Value::Bool(true)),
        Operation::Claim { session_id } => {
            // An existing active host run starts with local authority. A hidden window
            // yields it so a paired client can continue without another host click.
            let visible = runtime
                .app
                .get_webview_window("main")
                .and_then(|w| w.is_visible().ok())
                .unwrap_or(false);
            if visible
                && runtime
                    .app
                    .state::<ProviderCancellationManager>()
                    .flags
                    .lock()
                    .map_err(err)?
                    .contains_key(session_id)
                && runtime
                    .controls
                    .lock()
                    .map_err(err)?
                    .current(session_id)
                    .is_none()
            {
                runtime
                    .controls
                    .lock()
                    .map_err(err)?
                    .claim(session_id, "local", false)?;
            }
            value(
                runtime
                    .controls
                    .lock()
                    .map_err(err)?
                    .claim(session_id, peer, false)?,
            )
        }
        Operation::RequestControl { session_id } => value(
            runtime
                .controls
                .lock()
                .map_err(err)?
                .request(session_id, peer)?,
        ),
        Operation::TransferControl {
            session_id,
            peer_id,
        } => {
            if !runtime.store.trusts(peer_id, "client") {
                return Err("Requested device is not trusted".into());
            }
            value(runtime.controls.lock().map_err(err)?.transfer(
                session_id,
                peer,
                request.lease,
                peer_id,
            )?)
        }
        Operation::Release { session_id } => {
            // An old view's delayed cleanup must not release a newly claimed lease.
            let mut controls = runtime.controls.lock().map_err(err)?;
            if controls.check(session_id, peer, request.lease).is_ok() {
                controls.release(session_id, peer);
            }
            Ok(Value::Null)
        }
        Operation::Submit {
            session_id,
            turn_id,
            message,
            model,
        } => submit(runtime, session_id, turn_id, message, model),
        Operation::Stop { session_id } => Ok(json!(crate::state::provider_run::stop_provider_run(
            &runtime.app,
            session_id,
            crate::state::provider_run::ProviderStopReason::User
        ))),
        Operation::Approval {
            session_id,
            approval_id,
            turn_id,
            kind,
            decision,
        } => approve(
            runtime,
            session_id,
            approval_id,
            turn_id.as_deref(),
            kind,
            decision,
        ),
        Operation::Question {
            session_id,
            question_id,
            answers,
        } => {
            let session = runtime.session(session_id)?;
            let model = ModelChoice {
                provider_id: session.provider_id.ok_or("Select a model")?,
                model_id: session.model_id.ok_or("Select a model")?,
                reasoning_effort: session.reasoning_effort,
            };
            // One turn per question, whichever device or retry answers it first.
            let digest = <sha2::Sha256 as sha2::Digest>::digest(format!("{session_id}\0{question_id}"));
            let mut bytes = [0u8; 16];
            bytes.copy_from_slice(&digest[..16]);
            let turn = uuid::Builder::from_custom_bytes(bytes).into_uuid();
            submit(
                runtime,
                session_id,
                &turn.to_string(),
                &format!(
                    "My answers to {question_id}:\n{}",
                    serde_json::to_string(answers).map_err(err)?
                ),
                &model,
            )
        }
        operation => super::workspace::execute(runtime, peer, operation),
    }
}

fn hello(runtime: &Runtime) -> Result<Value, String> {
    let paths = gyro_core::GyroPaths::for_current_user().map_err(err)?;
    let config = gyro_core::GyroConfig::load(&paths).map_err(err)?;
    let choices = crate::model_catalog::catalog_choice_models();
    let providers=config.model_providers.iter().filter(|p|p.enabled).map(|p|{
        let mut models=if p.model_ids.is_empty(){choices.iter().filter(|(id,_,_)|id==&p.id).map(|(_,id,_)|id.clone()).collect::<Vec<_>>()}else{p.model_ids.clone()};
        if let Some(default)=p.default_model_id.as_ref(){if !models.contains(default){models.push(default.clone());}}
        let health=gyro_core::provider_health(gyro_core::ProviderHealthRequest{provider_id:p.id.clone(),base_url:p.base_url.clone(),api_key_ref:Some(p.api_key_ref.clone()),kind:p.kind.clone(),force:false});
        let status=health.as_ref().map(|h|h.runtime_status.as_str()).unwrap_or("unknown");
        json!({"id":p.id,"displayName":p.display_name,"models":models,"defaultModelId":p.default_model_id,"kind":p.kind,"runtimeStatus":status})
    }).collect::<Vec<_>>();
    Ok(
        json!({"protocol":1,"hostId":runtime.node.get().unwrap().id(),"name":runtime.store.settings().map_err(err)?.name,"providers":providers,"selectedProviderId":config.selected_provider_id,"capabilities":["chat","files","git","terminal","approvals","questions","worktrees"],"experimental":true}),
    )
}
fn validate_model(model: &ModelChoice) -> Result<(), String> {
    if model
        .reasoning_effort
        .as_deref()
        .is_some_and(|e| !matches!(e, "low" | "medium" | "high" | "xhigh" | "max" | "ultra"))
    {
        return Err("Unsupported host reasoning effort".into());
    }
    let config =
        gyro_core::GyroConfig::load(&gyro_core::GyroPaths::for_current_user().map_err(err)?)
            .map_err(err)?;
    let provider = config
        .model_providers
        .iter()
        .find(|p| p.id == model.provider_id && p.enabled)
        .ok_or("This provider is not enabled on the host")?;
    if !gyro_core::provider_is_executable_for(provider) {
        return Err("This provider cannot execute chats on the host".into());
    }
    if model.model_id.is_empty()
        || model.model_id.len() > 200
        || model.model_id.chars().any(char::is_control)
    {
        return Err("Select an available host model".into());
    }
    let known = provider.model_ids.iter().any(|id| id == &model.model_id)
        || provider.default_model_id.as_deref() == Some(&model.model_id)
        || crate::model_catalog::catalog_choice_models()
            .iter()
            .any(|(p, m, _)| p == &model.provider_id && m == &model.model_id);
    if !known {
        return Err("The selected model is unavailable on the host".into());
    }
    Ok(())
}
fn submit(
    runtime: &Runtime,
    session_id: &str,
    turn_id: &str,
    message: &str,
    model: &ModelChoice,
) -> Result<Value, String> {
    validate_model(model)?;
    let turn = parse_uuid(turn_id)?;
    let message = crate::text::validate_chat_message(message)?;
    let session = runtime.session(session_id)?;
    let store = open_store()?;
    // Stable turn identity prevents a caller from replaying a prompt under a new request ID.
    if store
        .read_recent_events(session.id, 1000)
        .map_err(err)?
        .iter()
        .any(|e| e.turn_id == Some(turn))
    {
        return Err("This turn already exists. Refresh the session.".into());
    }
    let reservation =
        crate::provider_run_cleanup::ProviderRunReservation::reserve(&runtime.app, session_id)?;
    runtime
        .store
        .reserve_turn(session_id, turn_id)
        .map_err(err)?;
    let config =
        gyro_core::GyroConfig::load(&gyro_core::GyroPaths::for_current_user().map_err(err)?)
            .map_err(err)?;
    let event = crate::sessions::commands::append_user_message_blocking(
        session_id.into(),
        message.clone(),
        Some(turn_id.into()),
        Vec::new(),
    )?;
    let request = crate::providers::chat_types::ProviderChatRequest {
        // The explicit debug smoke returns before any provider process can start.
        session_id: session_id.into(),
        turn_id: Some(turn_id.into()),
        message,
        provider_id: model.provider_id.clone(),
        provider_label: None,
        model_id: Some(model.model_id.clone()),
        model_label: None,
        reasoning_effort: model.reasoning_effort.clone(),
        require_command_approval: config.require_command_approval,
        require_file_edit_approval: config.require_file_edit_approval,
        full_access: config.full_access,
        suggest_title: true,
        workspace_path: Some(session.workspace_path.to_string_lossy().into()),
        mode: crate::providers::chat_types::ChatMode::Normal,
        goal: None,
        plan: None,
        attachments: Vec::new(),
        workspace_context: None,
        workspace_check: None,
        side_chat_context: None,
        workflow_run_id: None,
        project_memory: None,
        internal_purpose: None,
    };
    #[cfg(debug_assertions)]
    if runtime.fixture {
        let event_result = event.clone();
        let app = runtime.app.clone();
        let fixture_session = session.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _reservation = reservation;
            std::thread::sleep(std::time::Duration::from_millis(30));
            let result = (|| -> Result<(), String> {
                crate::workspace::files::write_workspace_file_impl(
                    &crate::workspace::types::WorkspaceFileWriteRequest {
                        workspace_path: fixture_session.workspace_path.to_string_lossy().into(),
                        path: "fixture-result.txt".into(),
                        content: "Deterministic remote runner fixture\n".into(),
                        expected_hash: None,
                    },
                )
                .map_err(err)?;
                open_store()?
                    .append_event_with_turn_id(
                        fixture_session.id,
                        gyro_core::SessionEventKind::AssistantMessage,
                        "Deterministic fixture completed",
                        json!({"kind":"remote-fixture"}),
                        Some(turn),
                    )
                    .map_err(err)?;
                Ok(())
            })();
            if result.is_err() {
                eprintln!("Remote runner fixture failed");
            }
            let _=app.emit(crate::app::limits::PROVIDER_CHAT_EVENT,json!({"sessionId":fixture_session.id,"turnId":turn,"phase":"completed","status":"done"}));
        });
        return Ok(json!({"accepted":true,"event":event_result,"turnId":turn_id}));
    }
    let app = runtime.app.clone();
    let session = session_id.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let _reservation = reservation;
        if let Err(error) = crate::goal_runner::run(app.clone(), request, None) {
            if let Ok(store) = open_store() {
                let _=store.append_event(parse_uuid(&session).unwrap(),gyro_core::SessionEventKind::SystemEvent,"Remote run failed",json!({"kind":"remote-run-error","error":gyro_core::sanitize_harness_text(&error)}));
            }
        }
    });
    Ok(json!({"accepted":true,"event":event,"turnId":turn_id}))
}
fn snapshot(runtime: &Runtime, session_id: &str) -> Result<Value, String> {
    let session = parse_uuid(session_id)?;
    let recent = open_store()?
        .read_recent_events(session, 400)
        .map_err(err)?;
    let provider=runtime.app.state::<ProviderApprovalManager>().pending.lock().map_err(err)?.values().filter(|p|p.session_id==session).map(|p|json!({"id":p.approval_id,"turnId":p.turn_id,"kind":"provider","payload":p.payload})).collect::<Vec<_>>();
    let capabilities = runtime
        .app
        .state::<ProviderCapabilityApprovalManager>()
        .pending
        .lock()
        .map_err(err)?
        .iter()
        .filter(|(_, p)| p.session_id == session)
        .map(|(id, p)| {
            let payload = recent
                .iter()
                .rev()
                .find(|event| event.payload.get("approvalId").and_then(Value::as_str) == Some(id))
                .map(|e| e.payload.clone());
            json!({"id":id,"turnId":p.turn_id,"kind":"capability","payload":payload})
        })
        .collect::<Vec<_>>();
    let mutations = open_store()?
        .list_unsurfaced_pending_mutation_proposals(session)
        .map_err(err)?;
    Ok(
        json!({"session":runtime.session(session_id)?,"running":runtime.app.state::<ProviderCancellationManager>().flags.lock().map_err(err)?.contains_key(session_id),"control":runtime.controls.lock().map_err(err)?.current(session_id),"approvals":provider.into_iter().chain(capabilities).collect::<Vec<_>>(),"mutations":mutations}),
    )
}
fn approve(
    runtime: &Runtime,
    session_id: &str,
    approval_id: &str,
    turn_id: Option<&str>,
    kind: &ApprovalKind,
    decision: &str,
) -> Result<Value, String> {
    if !matches!(decision, "approve" | "reject") {
        return Err("Choose approve or reject".into());
    }
    let session = parse_uuid(session_id)?;
    match kind {
        ApprovalKind::Provider => {
            {
                let manager = runtime.app.state::<ProviderApprovalManager>();
                let pending = manager.pending.lock().map_err(err)?;
                let p = pending
                    .get(approval_id)
                    .ok_or("Approval is no longer pending")?;
                if p.session_id != session || p.turn_id != turn_id.map(parse_uuid).transpose()? {
                    return Err("Approval belongs to another session or turn".into());
                }
            }
            value(
                crate::providers::approvals::resolve_provider_approval_blocking(
                    runtime.app.clone(),
                    crate::capabilities::types::ProviderApprovalDecisionRequest {
                        approval_id: approval_id.into(),
                        decision: decision.into(),
                    },
                )?,
            )
        }
        ApprovalKind::Capability => {
            let manager = runtime.app.state::<ProviderCapabilityApprovalManager>();
            let mut pending = manager.pending.lock().map_err(err)?;
            let p = pending
                .get(approval_id)
                .ok_or("Approval is no longer pending")?;
            if p.session_id != session || p.turn_id != turn_id.map(parse_uuid).transpose()? {
                return Err("Approval belongs to another session or turn".into());
            }
            let p = pending.remove(approval_id).unwrap();
            p.sender
                .send(if decision == "approve" {
                    gyro_core::CapabilityApprovalDecision::AllowOnce
                } else {
                    gyro_core::CapabilityApprovalDecision::Deny
                })
                .map_err(|_| "Approval is no longer waiting".to_string())?;
            Ok(Value::Null)
        }
        ApprovalKind::Mutation => {
            let proposal = open_store()?
                .get_mutation_proposal(parse_uuid(approval_id)?)
                .map_err(err)?
                .ok_or("Mutation is no longer pending")?;
            if proposal.session_id != session {
                return Err("Mutation belongs to another session".into());
            }
            value(
                crate::workspace_mutations::resolve_file_mutation_proposal_impl(
                    crate::workspace::types::FileMutationDecisionRequest {
                        proposal_id: approval_id.into(),
                        decision: decision.into(),
                    },
                )
                .map_err(err)?,
            )
        }
    }
}
