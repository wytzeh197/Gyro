//! Experimental device access, separate from Cloud accounts and entitlements.
pub(crate) mod commands;
mod dispatch;
mod mutation_locks;
#[cfg(debug_assertions)]
pub(crate) mod smoke;
#[cfg(debug_assertions)]
mod smoke_regressions;
mod workspace;
use base64::Engine;
use gyro_remote::{
    control::Controls,
    protocol::Operation,
    store::{Receipt, Store},
    transport::{Handler, Node},
    RemoteEvent, Request, Response,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};
use tauri::{Emitter, Listener, Manager};

#[derive(Default)]
pub(crate) struct RemoteAccess {
    runtime: tokio::sync::Mutex<Option<Arc<Runtime>>>,
    active: std::sync::RwLock<Option<std::sync::Weak<Runtime>>>,
}
pub(super) struct Runtime {
    pub app: tauri::AppHandle,
    pub store: Store,
    pub node: OnceLock<Arc<Node>>,
    pub controls: Mutex<Controls>,
    pub terminals: Mutex<HashMap<String, RemoteTerminal>>,
    mutation_locks: mutation_locks::MutationLocks,
    pub watches: Mutex<HashMap<String, RemoteWatch>>,
    #[cfg(debug_assertions)]
    fixture: bool,
}
/// A terminal pane a remote device opened, bound to one session and the device that owns it.
pub(super) struct RemoteTerminal {
    pub session: String,
    pub peer: String,
}
/// Open remote terminals allowed per device; each is a login shell on this Mac.
pub(super) const TERMINALS_PER_DEVICE: usize = 8;
pub(super) struct RemoteWatch {
    pub id: String,
    pub task: Option<tokio::task::JoinHandle<()>>,
}
impl RemoteWatch {
    pub fn abort(self) {
        if let Some(task) = self.task {
            task.abort();
        }
    }
}
pub(super) fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
pub(super) fn store() -> Result<Store, String> {
    let paths = gyro_core::GyroPaths::for_current_user().map_err(err)?;
    Store::open(&paths.base_dir.join("remote-access")).map_err(err)
}
impl RemoteAccess {
    pub(super) async fn ensure(&self, app: &tauri::AppHandle) -> Result<Arc<Runtime>, String> {
        let mut slot = self.runtime.lock().await;
        if let Some(runtime) = slot.as_ref() {
            return Ok(runtime.clone());
        }
        let app_key = app.config().identifier.clone();
        let secret = tauri::async_runtime::spawn_blocking(move || -> Result<[u8; 32], String> {
            let entry = keyring::Entry::new(&format!("{app_key}.remote-access"), "device-identity")
                .map_err(|_| "Device Keychain is unavailable".to_string())?;
            match entry.get_password() {
                Ok(value) => base64::engine::general_purpose::STANDARD
                    .decode(value)
                    .map_err(|_| {
                        "Device identity is invalid; reset remote access in Keychain".to_string()
                    })?
                    .try_into()
                    .map_err(|_| "Device identity is invalid".to_string()),
                Err(keyring::Error::NoEntry) => {
                    let key = iroh_secret();
                    entry
                        .set_password(&base64::engine::general_purpose::STANDARD.encode(key))
                        .map_err(|_| {
                            "Could not save the device identity in Keychain".to_string()
                        })?;
                    Ok(key)
                }
                Err(_) => Err("Unlock Keychain to use remote access".into()),
            }
        })
        .await
        .map_err(err)??;
        let remote_store = tauri::async_runtime::spawn_blocking(store)
            .await
            .map_err(err)??;
        let runtime = Runtime::bind(app, remote_store, secret, false).await?;
        *self.active.write().map_err(err)? = Some(Arc::downgrade(&runtime));
        *slot = Some(runtime.clone());
        Ok(runtime)
    }
}
fn iroh_secret() -> [u8; 32] {
    Node::generate_secret()
}
impl Runtime {
    pub(super) async fn bind(
        app: &tauri::AppHandle,
        remote_store: Store,
        secret: [u8; 32],
        loopback: bool,
    ) -> Result<Arc<Self>, String> {
        remote_store.reconcile_interrupted_requests().map_err(err)?;
        let runtime = Arc::new(Runtime {
            app: app.clone(),
            store: remote_store,
            node: OnceLock::new(),
            controls: Mutex::new(Controls::default()),
            terminals: Mutex::new(HashMap::new()),
            mutation_locks: mutation_locks::MutationLocks::default(),
            watches: Mutex::new(HashMap::new()),
            #[cfg(debug_assertions)]
            fixture: loopback,
        });
        let weak = Arc::downgrade(&runtime);
        let handler: Handler = Arc::new(move |peer, request| {
            let weak = weak.clone();
            Box::pin(async move {
                let id = request.id;
                match weak.upgrade() {
                    Some(r) => r.handle(peer, request).await,
                    None => Response::result(id, Err("Host stopped".into())),
                }
            })
        });
        let node = if loopback {
            Node::bind_loopback(secret, handler).await
        } else {
            Node::bind(secret, handler).await
        }
        .map_err(|_| "Could not start device networking".to_string())?;
        // Paired devices get long-lived connections; unknown identities only get a few
        // short guest slots for pairing, so they can never crowd out trusted devices.
        let weak = Arc::downgrade(&runtime);
        node.set_trust(Arc::new(move |peer| {
            weak.upgrade()
                .is_some_and(|r| r.store.trusts(peer, "client"))
        }));
        runtime
            .node
            .set(node.clone())
            .map_err(|_| "Device networking already started")?;
        let weak = Arc::downgrade(&runtime);
        app.listen_any(crate::app::limits::PROVIDER_CHAT_EVENT, move |event| {
            let Some(runtime) = weak.upgrade() else {
                return;
            };
            let Ok(payload) = serde_json::from_str::<Value>(event.payload()) else {
                return;
            };
            if let Some(session) = payload.get("sessionId").and_then(Value::as_str) {
                runtime.publish(session, "provider", payload.clone());
            }
        });
        Ok(runtime)
    }
    /// Ends remote shells when their device, session scope, or hosting goes away, so
    /// revoked access never leaves a live shell behind.
    pub fn close_terminals(&self, matches: impl Fn(&RemoteTerminal) -> bool) {
        let panes = match self.terminals.lock() {
            Ok(mut terminals) => {
                let panes: Vec<String> = terminals
                    .iter()
                    .filter(|(_, t)| matches(t))
                    .map(|(id, _)| id.clone())
                    .collect();
                for pane in &panes {
                    terminals.remove(pane);
                }
                panes
            }
            Err(_) => return,
        };
        let manager = self
            .app
            .state::<crate::terminal::types::TerminalProcessManager>();
        for pane in panes {
            let _ = manager.close(&pane);
        }
    }
    pub fn publish(&self, session: &str, topic: &str, payload: Value) {
        if let Some(node) = self.node.get() {
            let _ = node.events.send(RemoteEvent {
                session_id: session.into(),
                topic: topic.into(),
                payload,
            });
        }
    }
    pub fn session(&self, id: &str) -> Result<gyro_core::Session, String> {
        let session = crate::stores::open_store()?
            .get_session(crate::stores::parse_uuid(id)?)
            .map_err(err)?
            .ok_or("Session not found")?;
        if !self.store.authorizes(id, &session.workspace_path)
            || session
                .workspace_identity
                .roots
                .iter()
                .any(|r| !self.store.authorizes(id, &r.path))
        {
            return Err(
                "Every project root in this session must be shared before remote access".into(),
            );
        }
        Ok(session)
    }
    async fn handle(self: Arc<Self>, peer: String, request: Request) -> Response {
        let id = request.id;
        let runtime = self.clone();
        let result =
            tauri::async_runtime::spawn_blocking(move || runtime.handle_blocking(&peer, &request))
                .await
                .map_err(|_| "Remote operation worker failed".to_string())
                .and_then(|r| r);
        Response::result(id, result)
    }
    fn handle_blocking(&self, peer: &str, request: &Request) -> Result<Value, String> {
        if !self.store.settings().map_err(err)?.enabled {
            return Err("Remote access is disabled on this Mac".into());
        }
        match &request.operation {
            Operation::Pair { secret, name } => {
                self.store.request_pair(peer, name, secret).map_err(err)?;
                let _ = self.app.emit("gyro://remote-access-changed", ());
                return Ok(
                    json!({"status":"pending","hostId":self.node.get().unwrap().id(),"peerId":peer}),
                );
            }
            Operation::PairStatus => {
                return Ok(
                    json!({"status":if self.store.trusts(peer,"client"){"approved"}else if self.store.pending().map_err(err)?.iter().any(|p|p.id==peer){"pending"}else{"rejected"}}),
                )
            }
            _ => {}
        }
        self.authorize(peer, &request.operation)?;
        if let Operation::RequestStatus { request_id } = request.operation {
            return self.store.request_status(peer, request_id).map_err(err);
        }
        if request.operation.mutates() {
            if let Some(session) = request.operation.session_id() {
                self.controls
                    .lock()
                    .map_err(err)?
                    .check(session, peer, request.lease)?;
            }
            match self.store.begin(peer,request.id,&serde_json::to_value(&request.operation).map_err(err)?).map_err(err)? {
                Receipt::Complete(v)=>return Ok(v),Receipt::Failed(e)=>return Err(e),Receipt::Uncertain=>return Err("This request was already admitted. Refresh its result before attempting another action.".into()),Receipt::New=>{},
            }
        }
        let result = (|| {
            // Resolve completed receipts before inspecting transient approval state.
            // The worker owns guards through execution even if its caller disconnects.
            let gates = self
                .mutation_locks
                .for_paths(&self.mutation_paths(&request.operation)?)?;
            let _guards = gates
                .iter()
                .map(|gate| gate.lock())
                .collect::<Result<Vec<_>, _>>()?;
            if !gates.is_empty() {
                self.authorize(peer, &request.operation)?;
                self.mutation_paths(&request.operation)?;
                if let Some(session) = request.operation.session_id() {
                    self.controls.lock().map_err(err)?.check(session, peer, request.lease)?;
                }
            }
            dispatch::execute(self, peer, request)
        })();
        if request.operation.mutates() {
            self.store.finish(peer, request.id, &result).map_err(err)?;
        }
        // Only mutations change state other devices should refetch. Publishing on reads made
        // every watching client reload on its own reload, an unbounded refresh loop.
        if request.operation.mutates() && result.is_ok() {
            if let Some(session) = request.operation.session_id() {
                self.publish(session, "refresh", Value::Null);
            }
        }
        result
    }
    fn authorize(&self, peer: &str, operation: &Operation) -> Result<(), String> {
        if !self.store.settings().map_err(err)?.enabled {
            return Err("Remote access is disabled on this Mac".into());
        }
        if !self.store.trusts(peer, "client") {
            return Err("This device is not trusted or its access was revoked".into());
        }
        if let Some(session) = operation.session_id() {
            self.session(session)?;
        }
        Ok(())
    }
    pub fn snapshot(&self) -> Result<Value, String> {
        let hosting_active =
            self.store.settings().map_err(err)?.enabled && self.node.get().is_some();
        Ok(
            json!({"settings":self.store.settings().map_err(err)?,"hostingActive":hosting_active,"deviceId":self.node.get().map(|n|n.id()),"peers":self.store.peers().map_err(err)?,"pending":self.store.pending().map_err(err)?,"projects":self.store.projects().map_err(err)?,"controls":self.controls.lock().map_err(err)?.all()}),
        )
    }
}

/// A local host interaction may always reclaim control, but never silently.
pub(crate) fn require_local_control(app: &tauri::AppHandle, session: &str) -> Result<(), String> {
    let Some(state) = app.try_state::<RemoteAccess>() else {
        return Ok(());
    };
    let runtime = state
        .active
        .read()
        .map_err(err)?
        .as_ref()
        .and_then(std::sync::Weak::upgrade);
    if let Some(runtime) = runtime {
        let mut controls = runtime.controls.lock().map_err(err)?;
        if controls
            .current(session)
            .is_some_and(|c| c.owner != "local")
        {
            return Err(
                "This session is controlled remotely. Take control in Settings → Remote access."
                    .into(),
            );
        }
        controls.claim(session, "local", false)?;
    }
    Ok(())
}
pub(crate) fn require_local_terminal_control(
    app: &tauri::AppHandle,
    pane: &str,
) -> Result<(), String> {
    let Some(state) = app.try_state::<RemoteAccess>() else {
        return Ok(());
    };
    let session = {
        let runtime = state
            .active
            .read()
            .map_err(err)?
            .as_ref()
            .and_then(std::sync::Weak::upgrade);
        match runtime.as_ref() {
            Some(r) => r.terminals.lock().map_err(err)?.get(pane).map(|t| t.session.clone()),
            None => None,
        }
    };
    if let Some(session) = session {
        require_local_control(app, &session)?;
    }
    Ok(())
}
pub(crate) fn release_local_controls(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<RemoteAccess>() else {
        return;
    };
    if let Ok(active) = state.active.read() {
        if let Some(runtime) = active.as_ref().and_then(std::sync::Weak::upgrade) {
            if let Ok(mut controls) = runtime.controls.lock() {
                controls.revoke("local");
            }
        }
    };
}

pub(crate) fn start_if_enabled(app: tauri::AppHandle) {
    // Reading persisted opt-in does not create an endpoint or access Keychain.
    if store()
        .and_then(|s| s.settings().map_err(err))
        .is_ok_and(|s| s.enabled)
    {
        tauri::async_runtime::spawn(async move {
            let _ = app.state::<RemoteAccess>().ensure(&app).await;
        });
    }
}
