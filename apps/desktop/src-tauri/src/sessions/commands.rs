use crate::{
    git_branch_service::git_branch_catalog_impl,
    open_store, parse_uuid,
    providers::chat_types::ChatAttachmentRequest,
    session_history::{read_session_events_blocking, SessionEventsReadResult},
    state::{
        managers::{
            ProviderCancellationManager, ProviderCapabilityResourceManager,
            ATTACHMENT_SESSION_LOCKS,
        },
        provider_run::ProviderRunControl,
    },
    terminal::{governance::release_pane_governance, types::TerminalProcessManager},
    to_string, validate_chat_message,
};
use gyro_core::{
    create_worktree, CreateSessionContext, GyroPaths, Session, SessionEvent, SessionEventKind,
    SessionOrigin, SessionWorkspaceMode,
};
use serde::Deserialize;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
};
use tauri::Manager;
use uuid::Uuid;
#[tauri::command]
pub(crate) async fn list_sessions() -> Result<Vec<Session>, String> {
    tauri::async_runtime::spawn_blocking(list_sessions_blocking)
        .await
        .map_err(|error| format!("session list worker failed: {error}"))?
}

pub(crate) fn list_sessions_blocking() -> Result<Vec<Session>, String> {
    let store = open_store()?;
    store.list_sessions().map_err(to_string)
}

#[tauri::command]
pub(crate) async fn create_desktop_session(
    workspace_path: String,
    title: String,
    provider_id: Option<String>,
    provider_label: Option<String>,
    model_id: Option<String>,
    model_label: Option<String>,
    reasoning_effort: Option<String>,
) -> Result<Session, String> {
    tauri::async_runtime::spawn_blocking(move || {
        create_desktop_session_blocking(
            workspace_path,
            title,
            provider_id,
            provider_label,
            model_id,
            model_label,
            reasoning_effort,
        )
    })
    .await
    .map_err(|error| format!("desktop session worker failed: {error}"))?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetSessionWorkspaceIdentityRequest {
    pub(crate) session_id: String,
    pub(crate) roots: Vec<String>,
    pub(crate) active_root: String,
}

#[tauri::command]
pub(crate) async fn set_session_workspace_identity(
    request: SetSessionWorkspaceIdentityRequest,
) -> Result<Session, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session_id = Uuid::parse_str(&request.session_id).map_err(to_string)?;
        let roots = request
            .roots
            .into_iter()
            .map(PathBuf::from)
            .collect::<Vec<_>>();
        open_store()?
            .set_workspace_identity(session_id, &roots, Path::new(&request.active_root))
            .map_err(to_string)
    })
    .await
    .map_err(|error| format!("Workspace identity worker failed: {error}"))?
}

pub(crate) fn create_desktop_session_blocking(
    workspace_path: String,
    title: String,
    provider_id: Option<String>,
    provider_label: Option<String>,
    model_id: Option<String>,
    model_label: Option<String>,
    reasoning_effort: Option<String>,
) -> Result<Session, String> {
    let store = open_store()?;
    let branch = if workspace_path.trim().is_empty() {
        "main".into()
    } else {
        git_branch_catalog_impl(&workspace_path)
            .ok()
            .and_then(|catalog| catalog.current)
            .unwrap_or_else(|| "main".into())
    };
    store
        .create_session_with_context(
            PathBuf::from(workspace_path),
            SessionOrigin::Desktop,
            title,
            CreateSessionContext {
                branch,
                provider_id,
                provider_label,
                model_id,
                model_label,
                reasoning_effort,
                ..CreateSessionContext::default()
            },
        )
        .map_err(to_string)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn create_worktree_session(
    workspace_path: String,
    title: String,
    branch: String,
    worktree_name: Option<String>,
    provider_id: Option<String>,
    provider_label: Option<String>,
    model_id: Option<String>,
    model_label: Option<String>,
    reasoning_effort: Option<String>,
) -> Result<Session, String> {
    tauri::async_runtime::spawn_blocking(move || {
        create_worktree_session_blocking(
            workspace_path,
            title,
            branch,
            worktree_name,
            provider_id,
            provider_label,
            model_id,
            model_label,
            reasoning_effort,
        )
    })
    .await
    .map_err(|error| format!("worktree session worker failed: {error}"))?
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn create_worktree_session_blocking(
    workspace_path: String,
    title: String,
    branch: String,
    worktree_name: Option<String>,
    provider_id: Option<String>,
    provider_label: Option<String>,
    model_id: Option<String>,
    model_label: Option<String>,
    reasoning_effort: Option<String>,
) -> Result<Session, String> {
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    let store = open_store()?;
    let plan = create_worktree(&paths, PathBuf::from(workspace_path), branch, worktree_name)
        .map_err(to_string)?;

    let session = store
        .create_session_with_context(
            &plan.worktree_path,
            SessionOrigin::Desktop,
            title,
            CreateSessionContext {
                workspace_mode: SessionWorkspaceMode::Worktree,
                branch: plan.branch,
                worktree_name: Some(plan.worktree_name),
                provider_id,
                provider_label,
                model_id,
                model_label,
                reasoning_effort,
            },
        )
        .map_err(to_string)?;
    store
        .append_event(
            session.id,
            SessionEventKind::SystemEvent,
            "Worktree session created",
            serde_json::json!({
                "repoPath": plan.git_root,
                "worktreePath": plan.worktree_path,
                "branch": session.branch,
                "worktreeName": session.worktree_name,
            }),
        )
        .map_err(to_string)?;
    store
        .get_session(session.id)
        .map_err(to_string)?
        .ok_or_else(|| "worktree session was not persisted".into())
}

#[tauri::command]
pub(crate) async fn rename_session(session_id: String, title: String) -> Result<Session, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = open_store()?;
        let session_id = parse_uuid(&session_id)?;
        store
            .rename_session(session_id, title)
            .map_err(to_string)?
            .ok_or_else(|| "session not found".into())
    })
    .await
    .map_err(|error| format!("session rename worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn delete_session(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<bool, String> {
    let reservation = Arc::new(ProviderRunControl::default());
    {
        let manager = app.state::<ProviderCancellationManager>();
        let mut flags = manager
            .flags
            .lock()
            .map_err(|_| "provider cancellation state is unavailable".to_string())?;
        if flags.contains_key(&session_id) {
            return Err("stop the active provider turn before deleting this session".into());
        }
        flags.insert(session_id.clone(), reservation.clone());
    }
    let worker_session_id = session_id.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || delete_session_blocking(worker_session_id))
            .await
            .map_err(|error| format!("session delete worker failed: {error}"));
    if let Ok(mut flags) = app.state::<ProviderCancellationManager>().flags.lock() {
        if flags
            .get(&session_id)
            .is_some_and(|current| Arc::ptr_eq(current, &reservation))
        {
            flags.remove(&session_id);
        }
    }
    let deleted = result??;
    if deleted {
        let owned_terminal = app
            .state::<ProviderCapabilityResourceManager>()
            .terminals
            .lock()
            .ok()
            .and_then(|mut terminals| terminals.remove(&session_id));
        if let Some(owned) = owned_terminal {
            let _ = app.state::<TerminalProcessManager>().stop(&owned.pane_id);
            if let Ok(Some(governed_session)) =
                app.state::<TerminalProcessManager>().close(&owned.pane_id)
            {
                release_pane_governance(&app, &governed_session);
            }
        }
        if let Ok(mut browsers) = app
            .state::<ProviderCapabilityResourceManager>()
            .browsers
            .lock()
        {
            browsers.remove(&session_id);
        }
    }
    Ok(deleted)
}

pub(crate) fn delete_session_blocking(session_id: String) -> Result<bool, String> {
    let session_id = parse_uuid(&session_id)?;
    let attachment_lock = attachment_session_lock(&session_id.to_string())?;
    let _attachment_guard = attachment_lock
        .lock()
        .map_err(|_| "session attachment lock is unavailable".to_string())?;
    let store = open_store()?;
    let attachments_root = store.paths().sessions_dir.join("attachments");
    cleanup_staged_session_attachments(&attachments_root);
    let staged = stage_session_attachments(&attachments_root, session_id)?;
    match store.delete_session(session_id) {
        Ok(deleted) => {
            drop(store);
            if let Some((_, tombstone)) = staged {
                if let Err(error) = remove_attachment_storage_entry(&tombstone) {
                    eprintln!(
                        "could not finish private attachment cleanup for {session_id}: {error}"
                    );
                }
            }
            Ok(deleted)
        }
        Err(error) => {
            if let Some((original, tombstone)) = staged {
                let _ = fs::rename(tombstone, original);
            }
            Err(to_string(error))
        }
    }
}

pub(crate) fn attachment_session_lock(session_id: &str) -> Result<Arc<Mutex<()>>, String> {
    let locks = ATTACHMENT_SESSION_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks
        .lock()
        .map_err(|_| "attachment lock registry is unavailable".to_string())?;
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(session_id).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(session_id.to_string(), Arc::downgrade(&lock));
    Ok(lock)
}

pub(crate) fn stage_session_attachments(
    attachments_root: &Path,
    session_id: Uuid,
) -> Result<Option<(PathBuf, PathBuf)>, String> {
    let root_metadata = match fs::symlink_metadata(attachments_root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(to_string(error)),
    };
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err("attachment storage is not a safe directory".into());
    }
    let session_dir = attachments_root.join(session_id.to_string());
    let metadata = match fs::symlink_metadata(&session_dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(to_string(error)),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("session attachment storage is not a safe directory".into());
    }
    let tombstone = attachments_root.join(format!(
        ".deleting-{session_id}-{}",
        Uuid::new_v4().simple()
    ));
    fs::rename(&session_dir, &tombstone).map_err(to_string)?;
    Ok(Some((session_dir, tombstone)))
}

pub(crate) fn remove_attachment_storage_entry(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(to_string(error)),
    };
    if metadata.file_type().is_symlink() || metadata.is_file() {
        fs::remove_file(path).map_err(to_string)
    } else if metadata.is_dir() {
        fs::remove_dir_all(path).map_err(to_string)
    } else {
        Err("attachment cleanup target has an unsupported file type".into())
    }
}

pub(crate) fn cleanup_staged_session_attachments(attachments_root: &Path) {
    let Ok(entries) = fs::read_dir(attachments_root) else {
        return;
    };
    for entry in entries.flatten().take(64) {
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with(".deleting-")
        {
            let _ = remove_attachment_storage_entry(&entry.path());
        }
    }
}

#[tauri::command]
pub(crate) async fn read_session_events(
    session_id: String,
    before_event_id: Option<String>,
    limit: Option<usize>,
    full_history: Option<bool>,
    known_revision: Option<String>,
) -> Result<SessionEventsReadResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_session_events_blocking(
            session_id,
            before_event_id,
            limit,
            full_history.unwrap_or(false),
            known_revision,
        )
    })
    .await
    .map_err(|error| format!("session event read worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn append_user_message(
    session_id: String,
    message: String,
    turn_id: Option<String>,
    #[allow(unused_variables)] attachments: Option<Vec<ChatAttachmentRequest>>,
) -> Result<SessionEvent, String> {
    let message = validate_chat_message(&message)?;
    tauri::async_runtime::spawn_blocking(move || {
        append_user_message_blocking(
            session_id,
            message,
            turn_id,
            attachments.unwrap_or_default(),
        )
    })
    .await
    .map_err(|error| format!("user message worker failed: {error}"))?
}

pub(crate) fn append_user_message_blocking(
    session_id: String,
    message: String,
    turn_id: Option<String>,
    attachments: Vec<ChatAttachmentRequest>,
) -> Result<SessionEvent, String> {
    let store = open_store()?;
    let session_id = parse_uuid(&session_id)?;
    if let Some(turn_id) = turn_id.as_deref() {
        return store
            .append_user_turn_message_with_turn_id(
                session_id,
                message,
                serde_json::json!({ "surface": "desktop", "attachments": attachments }),
                parse_uuid(turn_id)?,
            )
            .map_err(to_string);
    }
    store
        .append_user_turn_message(
            session_id,
            message,
            serde_json::json!({ "surface": "desktop", "attachments": attachments }),
        )
        .map_err(to_string)
}
