use crate::{
    providers::binding::session_execution_workspace,
    state::{
        managers::ProviderCancellationManager,
        provider_run::{cancel_provider_run, ProviderStopReason},
    },
    stores::{open_store, parse_uuid, to_string},
};
use gyro_core::{GyroConfig, GyroPaths, Session, SessionStore};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf, sync::Mutex};
use tauri::Manager;
use uuid::Uuid;

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatBinding {
    provider: String,
    workspace: PathBuf,
    workspace_revision: u64,
}

impl ChatBinding {
    fn read(session: &Session, paths: &GyroPaths) -> Result<Self, String> {
        Ok(Self {
            provider: session
                .provider_id
                .clone()
                .ok_or_else(|| "Choose a provider before enabling Full access.".to_string())?,
            workspace: session_execution_workspace(session, paths)?,
            workspace_revision: session.workspace_identity.revision,
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatFullAccessScope {
    binding: ChatBinding,
    provider_label: String,
}

fn read_local_chat(store: &SessionStore, id: Uuid) -> Result<Session, String> {
    store
        .get_session(id)
        .map_err(to_string)?
        .filter(|session| session.parent_session_id.is_none())
        .ok_or_else(|| "Full access requires a local chat.".to_string())
}

#[derive(Default)]
pub(crate) struct ChatFullAccess(Mutex<HashMap<Uuid, ChatBinding>>);

pub(crate) fn permits(app: &tauri::AppHandle, session: &Session, paths: &GyroPaths) -> bool {
    let Ok(binding) = ChatBinding::read(session, paths) else {
        return false;
    };
    app.try_state::<ChatFullAccess>()
        .and_then(|grants| {
            let mut grants = grants.0.lock().ok()?;
            let valid = grants.get(&session.id) == Some(&binding);
            if !valid {
                grants.remove(&session.id);
            }
            Some(valid)
        })
        .unwrap_or(false)
}

pub(crate) fn revoke(app: &tauri::AppHandle, session: Uuid) -> Result<(), String> {
    let grants = app.state::<ChatFullAccess>();
    let revoked = grants
        .0
        .lock()
        .map_err(to_string)?
        .remove(&session)
        .is_some();
    if revoked {
        let session_id = session.to_string();
        cancel_provider_run(app, &session_id, ProviderStopReason::User)?;
        if let Some(resources) =
            app.try_state::<crate::state::managers::ProviderCapabilityResourceManager>()
        {
            let terminal = resources
                .terminals
                .lock()
                .map_err(to_string)?
                .get(&session_id)
                .cloned();
            if let Some(terminal) = terminal {
                if let Some(manager) =
                    app.try_state::<crate::terminal::types::TerminalProcessManager>()
                {
                    manager.stop(&terminal.pane_id).map_err(to_string)?;
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn for_active_turn(
    app: &tauri::AppHandle,
    session_id: &str,
    mut config: GyroConfig,
) -> GyroConfig {
    config.full_access = false;
    let Some(manager) = app.try_state::<ProviderCancellationManager>() else {
        return config;
    };
    let Some(run) = manager
        .flags
        .lock()
        .ok()
        .and_then(|runs| runs.get(session_id).cloned())
    else {
        return config;
    };
    if run.cancellation.is_cancelled() {
        config.require_command_approval = true;
        config.require_file_edit_approval = true;
        return config;
    }
    let Ok(request) = run.request.lock() else {
        return config;
    };
    let Some(request) = request.as_ref() else {
        return config;
    };
    config.full_access = request.full_access;
    config.require_command_approval = request.require_command_approval;
    config.require_file_edit_approval = request.require_file_edit_approval;
    config
}

#[tauri::command]
pub(crate) async fn get_chat_full_access_scope(
    session_id: String,
) -> Result<ChatFullAccessScope, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = open_store()?;
        let session = read_local_chat(&store, parse_uuid(&session_id)?)?;
        let binding = ChatBinding::read(&session, store.paths())?;
        let provider_label = session
            .provider_label
            .unwrap_or_else(|| binding.provider.clone());
        Ok(ChatFullAccessScope {
            binding,
            provider_label,
        })
    })
    .await
    .map_err(to_string)?
}

#[tauri::command]
pub(crate) async fn set_chat_full_access(
    app: tauri::AppHandle,
    session_id: String,
    enabled: bool,
    confirmed_binding: Option<ChatBinding>,
) -> Result<bool, String> {
    crate::features::remote_access::require_local_control(&app, &session_id)?;
    let session_id = parse_uuid(&session_id)?;
    if !enabled {
        revoke(&app, session_id)?;
        return Ok(false);
    }
    let confirmed_binding =
        confirmed_binding.ok_or_else(|| "Review Full access before enabling it.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let store = open_store()?;
        let manager = app.state::<ProviderCancellationManager>();
        let runs = manager.flags.lock().map_err(to_string)?;
        if runs.contains_key(&session_id.to_string()) {
            return Err("Stop the active response before enabling Full access.".into());
        }
        let binding = ChatBinding::read(&read_local_chat(&store, session_id)?, store.paths())?;
        if binding != confirmed_binding {
            return Err("The chat’s provider or workspace changed. Review access again.".into());
        }
        app.state::<ChatFullAccess>()
            .0
            .lock()
            .map_err(to_string)?
            .insert(session_id, binding);
        Ok(true)
    })
    .await
    .map_err(to_string)?
}
