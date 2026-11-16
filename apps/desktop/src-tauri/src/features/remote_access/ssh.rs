//! Local SSH connection manager; outgoing connections never touch the Gyro device key.
use super::{err, store, RemoteWatch};
use gyro_remote::{
    ssh::{Connection, Options, SavedHost},
    Operation, RemoteEvent, Request,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager};
use uuid::Uuid;

#[derive(Default)]
pub(super) struct Ssh {
    connections: Mutex<HashMap<String, Arc<Connection>>>,
    watches: Mutex<HashMap<String, RemoteWatch>>,
    connecting: tokio::sync::Mutex<()>,
}
impl Ssh {
    pub fn snapshot(&self, snapshot: &mut Value) -> Result<(), String> {
        let connections = self.connections.lock().map_err(err)?;
        let store = store()?;
        let hosts = store.ssh_hosts().map_err(err)?;
        snapshot["sshClientId"] = json!(format!("ssh:{}", store.ssh_client_id().map_err(err)?));
        let peers = snapshot["peers"]
            .as_array_mut()
            .ok_or("Invalid remote status")?;
        for host in &hosts {
            peers.push(json!({"id":host.id,"name":host.name,"role":"host","transport":"ssh"}));
        }
        snapshot["sshHosts"] = json!(hosts.iter().map(|host| json!({"id":host.id,"name":host.name,"options":host.options,"connected":connections.get(&host.id).is_some_and(|c|!c.client.is_closed())})).collect::<Vec<_>>());
        Ok(())
    }
    pub fn connection(&self, id: &str) -> Result<Arc<Connection>, String> {
        self.connections
            .lock()
            .map_err(err)?
            .get(id)
            .filter(|c| !c.client.is_closed())
            .cloned()
            .ok_or_else(|| "SSH host is disconnected. Connect in Remote access settings.".into())
    }
    pub async fn connect(
        &self,
        id: Option<String>,
        options: Option<Options>,
    ) -> Result<Value, String> {
        let _connect = self.connecting.lock().await;
        let saved = store()?.ssh_hosts().map_err(err)?;
        let existing = if let Some(id) = id {
            Some(
                saved
                    .iter()
                    .find(|h| h.id == id)
                    .cloned()
                    .ok_or("Unknown SSH host")?,
            )
        } else {
            None
        };
        let options = existing
            .as_ref()
            .map(|h| h.options.clone())
            .or(options)
            .ok_or("Enter an SSH host")?;
        options.validate().map_err(err)?;
        let existing = existing.or_else(|| saved.iter().find(|h| h.options == options).cloned());
        if existing.is_none() && saved.len() >= 16 {
            return Err("At most 16 SSH hosts can be saved".into());
        }
        let id = existing
            .as_ref()
            .map(|h| h.id.clone())
            .unwrap_or_else(|| format!("ssh:{}", Uuid::new_v4()));
        self.disconnect(&id)?;
        let client_id = store()?.ssh_client_id().map_err(err)?;
        let connection = Connection::connect(&options, client_id)
            .await
            .map_err(err)?;
        let info = connection.hello().await.map_err(err)?;
        if info.get("protocol").and_then(Value::as_u64) != Some(1)
            || !info.get("capabilities").is_some_and(Value::is_array)
        {
            return Err(
                "The host runs an unsupported Gyro version. Update Gyro on the host.".into(),
            );
        }
        let name = info
            .get("name")
            .and_then(Value::as_str)
            .filter(|s| {
                !s.trim().is_empty() && s.chars().count() <= 80 && !s.chars().any(char::is_control)
            })
            .unwrap_or(&options.host)
            .to_string();
        store()?
            .save_ssh_host(&SavedHost {
                id: id.clone(),
                name: name.clone(),
                options,
            })
            .map_err(err)?;
        self.connections
            .lock()
            .map_err(err)?
            .insert(id.clone(), connection);
        Ok(json!({"id":id,"name":name,"role":"host","transport":"ssh"}))
    }
    pub fn disconnect(&self, id: &str) -> Result<(), String> {
        if let Some(watch) = self.watches.lock().map_err(err)?.remove(id) {
            watch.abort();
        }
        if let Some(connection) = self.connections.lock().map_err(err)?.remove(id) {
            connection.close();
        }
        Ok(())
    }
    pub fn remove(&self, id: &str) -> Result<(), String> {
        self.disconnect(id)?;
        store()?.remove_ssh_host(id).map_err(err)
    }
    pub async fn watch(
        &self,
        app: tauri::AppHandle,
        id: String,
        session: Option<String>,
        watch_id: String,
    ) -> Result<(), String> {
        if session.is_none() {
            let mut watches = self.watches.lock().map_err(err)?;
            if watches.get(&id).is_some_and(|w| w.id == watch_id) {
                if let Some(w) = watches.remove(&id) {
                    w.abort();
                }
            }
            return Ok(());
        }
        let connection = self.connection(&id)?;
        {
            let mut watches = self.watches.lock().map_err(err)?;
            if let Some(old) = watches.remove(&id) {
                old.abort();
            }
            watches.insert(
                id.clone(),
                RemoteWatch {
                    id: watch_id.clone(),
                    task: None,
                },
            );
        }
        let host = id.clone();
        let key = watch_id.clone();
        let callback = Arc::new(move |event: RemoteEvent| {
            let _ = app.emit(
                "gyro://remote-host-event",
                json!({"hostId":host,"watchId":key,"event":event}),
            );
        });
        let result = connection
            .client
            .watch(
                Request {
                    id: Uuid::new_v4(),
                    lease: None,
                    operation: Operation::Watch {
                        session_id: session.unwrap(),
                    },
                },
                callback,
            )
            .await
            .map_err(err);
        let mut watches = self.watches.lock().map_err(err)?;
        match result {
            Ok(task) => {
                if let Some(current) = watches.get_mut(&id).filter(|w| w.id == watch_id) {
                    current.task = Some(task);
                } else {
                    task.abort();
                }
                Ok(())
            }
            Err(error) => {
                if watches.get(&id).is_some_and(|w| w.id == watch_id) {
                    watches.remove(&id);
                }
                Err(error)
            }
        }
    }
}
impl Drop for Ssh {
    fn drop(&mut self) {
        if let Ok(watches) = self.watches.get_mut() {
            for (_, w) in watches.drain() {
                w.abort();
            }
        }
        if let Ok(connections) = self.connections.get_mut() {
            for (_, c) in connections.drain() {
                c.close();
            }
        }
    }
}

pub(super) async fn action(
    app: &tauri::AppHandle,
    action: super::commands::LocalAction,
) -> Result<Value, String> {
    use super::commands::LocalAction;
    let state = app.state::<super::RemoteAccess>();
    match action {
        LocalAction::SshHosts => {
            let home = std::env::var_os("HOME").ok_or("Could not locate SSH configuration")?;
            tauri::async_runtime::spawn_blocking(move || {
                serde_json::to_value(gyro_remote::ssh::config_hosts(std::path::Path::new(&home)))
                    .map_err(err)
            })
            .await
            .map_err(err)?
        }
        LocalAction::SshConnect { host_id, options } => {
            let result = state.ssh.connect(host_id, options).await?;
            let _ = app.emit("gyro://remote-access-changed", ());
            Ok(result)
        }
        LocalAction::SshDisconnect { host_id } => {
            let _change = state.ssh.connecting.lock().await;
            state.ssh.disconnect(&host_id)?;
            Ok(Value::Null)
        }
        LocalAction::SshRemove { host_id } => {
            let _change = state.ssh.connecting.lock().await;
            state.ssh.remove(&host_id)?;
            let _ = app.emit("gyro://remote-access-changed", ());
            Ok(Value::Null)
        }
        _ => Err("Unsupported SSH action".into()),
    }
}
