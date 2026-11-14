use super::{err, store, RemoteAccess, RemoteWatch, Runtime};
use base64::Engine;
use gyro_remote::store::{Invitation, Settings, SidebarProject};
use gyro_remote::{store::Peer, Operation, RemoteEvent, Request};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{Emitter, Manager};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum LocalAction {
    Configure { enabled: bool, name: String },
    Invite,
    CancelInvitation,
    Share { path: String },
    SyncProjects { projects: Vec<SidebarProject> },
    Unshare { project_id: String },
    Approve { peer_id: String },
    Reject { peer_id: String },
    Revoke { peer_id: String },
    Pair { invitation: String },
    PairStatus { host_id: String },
    Reclaim { session_id: String },
    Release { session_id: String },
    Transfer { session_id: String, peer_id: String },
    Disconnect { host_id: String },
}
#[tauri::command]
pub(crate) async fn remote_access_status(app: tauri::AppHandle) -> Result<Value, String> {
    let state = app.state::<RemoteAccess>();
    let slot = state.runtime.lock().await;
    if let Some(r) = slot.as_ref() {
        let runtime = r.clone();
        drop(slot);
        return tauri::async_runtime::spawn_blocking(move || runtime.snapshot())
            .await
            .map_err(err)?;
    }
    drop(slot);
    tauri::async_runtime::spawn_blocking(||{let s=store()?;Ok(json!({"settings":s.settings().map_err(err)?,"deviceId":null,"hostingActive":false,"invitationActive":false,"peers":s.peers().map_err(err)?,"pending":s.pending().map_err(err)?,"projects":s.projects().map_err(err)?,"controls":{}}))}).await.map_err(err)?
}
#[tauri::command]
pub(crate) async fn remote_access_action(
    app: tauri::AppHandle,
    request: LocalAction,
) -> Result<Value, String> {
    if let LocalAction::Configure {
        enabled: false,
        name,
    } = request
    {
        let was_enabled = tauri::async_runtime::spawn_blocking(move || {
            let s = store()?;
            let previous = s.settings().map_err(err)?.enabled;
            s.save_settings(&Settings {
                enabled: false,
                name,
            })
            .map_err(err)?;
            Ok::<_, String>(previous)
        })
        .await
        .map_err(err)??;
        if !was_enabled {
            return Ok(Value::Null);
        }
        let runtime = app.state::<RemoteAccess>().runtime.lock().await.take();
        *app.state::<RemoteAccess>().active.write().map_err(err)? = None;
        if let Some(runtime) = runtime {
            if let Some(node) = runtime.node.get() {
                node.close().await;
            }
            runtime.close_terminals(|_| true);
            for (_, watch) in runtime.watches.lock().map_err(err)?.drain() {
                watch.abort();
            }
        }
        return Ok(Value::Null);
    }
    let state = app.state::<RemoteAccess>();
    if state.runtime.lock().await.is_none()
        && matches!(
            &request,
            LocalAction::SyncProjects { .. }
                | LocalAction::Share { .. }
                | LocalAction::Unshare { .. }
                | LocalAction::Revoke { .. }
                | LocalAction::Reject { .. }
                | LocalAction::CancelInvitation
        )
    {
        return tauri::async_runtime::spawn_blocking(move || {
            let s = store()?;
            match request {
                LocalAction::SyncProjects { projects } => {
                    s.sync_projects(&projects).map_err(err)?
                }
                LocalAction::Share { path } => s.share(std::path::Path::new(&path)).map_err(err)?,
                LocalAction::Unshare { project_id } => s.unshare(&project_id).map_err(err)?,
                LocalAction::Revoke { peer_id } | LocalAction::Reject { peer_id } => {
                    s.revoke(&peer_id).map_err(err)?
                }
                LocalAction::CancelInvitation => s.clear_invitation().map_err(err)?,
                _ => unreachable!(),
            };
            Ok(Value::Null)
        })
        .await
        .map_err(err)?;
    }
    let runtime = state.ensure(&app).await?;
    let node = runtime.node.get().unwrap();
    match request {
        LocalAction::Pair { invitation } => {
            if invitation.len() > 4096 {
                return Err("Invalid invitation".into());
            }
            let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(
                    invitation
                        .trim()
                        .strip_prefix("gyro-pair-v1:")
                        .ok_or("Paste a Gyro invitation")?,
                )
                .map_err(|_| "Invalid invitation".to_string())?;
            let invite: Invitation =
                serde_json::from_slice(&bytes).map_err(|_| "Invalid invitation".to_string())?;
            if invite.version != 1 || invite.expires_at <= gyro_remote::store::now() {
                return Err("Invitation expired or unsupported".into());
            }
            if invite.host_id == node.id() {
                return Err("This invitation belongs to this Mac".into());
            }
            if let Some(address) = invite.address {
                node.remember(&invite.host_id, address).await.map_err(err)?;
            }
            let result = node
                .request(
                    &invite.host_id,
                    Request {
                        id: Uuid::new_v4(),
                        lease: None,
                        operation: Operation::Pair {
                            secret: invite.secret,
                            name: runtime.store.settings().map_err(err)?.name,
                        },
                    },
                )
                .await
                .map_err(|_| {
                    "Could not reach the host. Check that Gyro is open and try again.".to_string()
                })?
                .into_result()?;
            // A host record is not inbound authorization. The host still approves us.
            runtime
                .store
                .trust(&Peer {
                    id: invite.host_id,
                    name: invite.name,
                    role: "host".into(),
                })
                .map_err(err)?;
            return Ok(result);
        }
        LocalAction::PairStatus { host_id } => {
            if !runtime.store.trusts(&host_id, "host") {
                return Err("Unknown host".into());
            }
            let result = node
                .request(
                    &host_id,
                    Request {
                        id: Uuid::new_v4(),
                        lease: None,
                        operation: Operation::PairStatus,
                    },
                )
                .await
                .map_err(|_| "Host unavailable".to_string())?
                .into_result()?;
            if result.get("status").and_then(Value::as_str) == Some("approved") {
                approve_reciprocal_host(&runtime, &host_id)?;
            }
            return Ok(result);
        }
        LocalAction::Disconnect { host_id } => {
            if let Some(watch) = runtime.watches.lock().map_err(err)?.remove(&host_id) {
                watch.abort();
            }
            node.disconnect(&host_id).await;
        }
        action => {
            return tauri::async_runtime::spawn_blocking(move || local_action(&runtime, action))
                .await
                .map_err(err)?
        }
    }
    tauri::async_runtime::spawn_blocking(move || runtime.snapshot())
        .await
        .map_err(err)?
}
// Successful approval or an authorized Hello proves the host approved this Mac.
fn approve_reciprocal_host(runtime: &Runtime, id: &str) -> Result<(), String> {
    if !runtime.store.trusts(id, "client") {
        let mut peer = runtime
            .store
            .peers()
            .map_err(err)?
            .into_iter()
            .find(|p| p.id == id)
            .ok_or("Unknown host")?;
        peer.role = "both".into();
        runtime.store.trust(&peer).map_err(err)?;
        let _ = runtime
            .app
            .emit("gyro://remote-access-changed", Value::Null);
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn remote_host_request(
    app: tauri::AppHandle,
    host_id: String,
    request: Request,
) -> Result<Value, String> {
    let state = app.state::<RemoteAccess>();
    let runtime = state.ensure(&app).await?;
    if !runtime.store.trusts(&host_id, "host") {
        return Err("Host is not paired".into());
    }
    let hello = matches!(&request.operation, Operation::Hello);
    let result = runtime
        .node
        .get()
        .unwrap()
        .request(&host_id, request)
        .await
        .map_err(|_| {
            "Host unavailable or request timed out. Refresh before retrying an action.".to_string()
        })?
        .into_result()?;
    if hello {
        approve_reciprocal_host(&runtime, &host_id)?;
    }
    Ok(result)
}
#[tauri::command]
pub(crate) async fn remote_host_watch(
    app: tauri::AppHandle,
    host_id: String,
    session_id: Option<String>,
    watch_id: String,
) -> Result<(), String> {
    let state = app.state::<RemoteAccess>();
    let runtime = state.ensure(&app).await?;
    if !runtime.store.trusts(&host_id, "host") {
        return Err("Host is not paired".into());
    }
    if session_id.is_none() {
        let mut watches = runtime.watches.lock().map_err(err)?;
        if watches.get(&host_id).is_some_and(|w| w.id == watch_id) {
            if let Some(w) = watches.remove(&host_id) {
                w.abort();
            }
        }
        return Ok(());
    }
    {
        let mut watches = runtime.watches.lock().map_err(err)?;
        if let Some(watch) = watches.remove(&host_id) {
            watch.abort();
        }
        watches.insert(
            host_id.clone(),
            RemoteWatch {
                id: watch_id.clone(),
                task: None,
            },
        );
    }
    if let Some(session_id) = session_id {
        let sender = app.clone();
        let host = host_id.clone();
        let callback_watch = watch_id.clone();
        let callback = Arc::new(move |event: RemoteEvent| {
            let _ = sender.emit(
                "gyro://remote-host-event",
                json!({"hostId":host,"watchId":callback_watch,"event":event}),
            );
        });
        let watch = runtime
            .node
            .get()
            .unwrap()
            .watch(
                &host_id,
                Request {
                    id: Uuid::new_v4(),
                    lease: None,
                    operation: Operation::Watch { session_id },
                },
                callback,
            )
            .await
            .map_err(|_| "Could not subscribe to the host".to_string())?;
        let mut watches = runtime.watches.lock().map_err(err)?;
        if let Some(current) = watches.get_mut(&host_id).filter(|w| w.id == watch_id) {
            current.task = Some(watch);
        } else {
            watch.abort();
        }
    }
    Ok(())
}

pub(super) fn local_action(runtime: &Runtime, request: LocalAction) -> Result<Value, String> {
    let node = runtime.node.get().unwrap();
    match request {
        LocalAction::Configure { enabled, name } => {
            runtime
                .store
                .save_settings(&Settings { enabled, name })
                .map_err(err)?;
        }
        LocalAction::Invite => {
            let mut invite = runtime.store.invite(node.id()).map_err(err)?;
            invite.address = Some(node.address());
            return Ok(
                json!({"invitation":format!("gyro-pair-v1:{}",base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&invite).map_err(err)?)),"expiresAt":invite.expires_at}),
            );
        }
        LocalAction::CancelInvitation => runtime.store.clear_invitation().map_err(err)?,
        LocalAction::Share { path } => runtime
            .store
            .share(std::path::Path::new(&path))
            .map_err(err)?,
        LocalAction::Unshare { project_id } => {
            runtime.store.project(&project_id).map_err(err)?;
            runtime.store.unshare(&project_id).map_err(err)?;
            revoke_removed_scopes(runtime)?;
        }
        LocalAction::SyncProjects { projects } => {
            let previous = runtime.store.projects().map_err(err)?;
            runtime.store.sync_projects(&projects).map_err(err)?;
            let next = runtime.store.projects().map_err(err)?;
            if previous.iter().any(|p| !next.iter().any(|n| n.id == p.id)) {
                revoke_removed_scopes(runtime)?;
            }
        }
        LocalAction::Approve { peer_id } => runtime.store.approve(&peer_id).map_err(err)?,
        LocalAction::Reject { peer_id } | LocalAction::Revoke { peer_id } => {
            runtime.store.revoke(&peer_id).map_err(err)?;
            runtime.controls.lock().map_err(err)?.revoke(&peer_id);
            runtime.close_terminals(|t| t.peer == peer_id);
            let _ = node.events.send(RemoteEvent {
                session_id: String::new(),
                topic: "revoked".into(),
                payload: json!(peer_id),
            });
            let node = node.clone();
            tauri::async_runtime::spawn(async move {
                node.disconnect(&peer_id).await;
            });
        }
        LocalAction::Reclaim { session_id } => {
            runtime.session(&session_id)?;
            runtime
                .controls
                .lock()
                .map_err(err)?
                .claim(&session_id, "local", true)?;
            runtime.publish(&session_id, "refresh", Value::Null);
        }
        LocalAction::Release { session_id } => {
            runtime
                .controls
                .lock()
                .map_err(err)?
                .release(&session_id, "local");
            runtime.publish(&session_id, "refresh", Value::Null);
        }
        LocalAction::Transfer {
            session_id,
            peer_id,
        } => {
            if !runtime.store.trusts(&peer_id, "client") {
                return Err("Device is no longer trusted".into());
            }
            let mut controls = runtime.controls.lock().map_err(err)?;
            let generation = controls.current(&session_id).map(|c| c.generation);
            controls.transfer(&session_id, "local", generation, &peer_id)?;
            runtime.publish(&session_id, "refresh", Value::Null);
        }
        _ => return Err("Unsupported local device action".into()),
    }
    runtime.snapshot()
}

fn revoke_removed_scopes(runtime: &Runtime) -> Result<(), String> {
    let node = runtime.node.get().unwrap();
    // Use the same complete-root authorization as request admission.
    // A removed secondary root invalidates a session too; overlapping
    // shares that still authorize every root must remain connected.
    let sessions = crate::stores::open_store()?
        .list_sessions()
        .map_err(err)?
        .into_iter()
        .filter(|s| runtime.session(&s.id.to_string()).is_err())
        .map(|s| s.id.to_string())
        .collect::<Vec<_>>();
    runtime.close_terminals(|t| sessions.contains(&t.session));
    for session in sessions {
        let _ = node.events.send(RemoteEvent {
            session_id: session,
            topic: "scopeRevoked".into(),
            payload: Value::Null,
        });
    }
    Ok(())
}
