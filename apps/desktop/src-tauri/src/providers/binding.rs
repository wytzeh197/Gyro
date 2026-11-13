use crate::{
    app::{
        config::load_config_blocking,
        limits::{
            MAX_CHAT_ATTACHMENTS, MAX_CHAT_ATTACHMENT_TOTAL_BYTES, MAX_CHAT_IDE_SNAPSHOT_BYTES,
            MAX_CHAT_IMAGES, MAX_CHAT_IMAGE_BYTES, MAX_CHAT_VIDEOS, MAX_CHAT_VIDEO_BYTES,
            MAX_CHAT_WORKSPACE_ATTACHMENT_BYTES,
        },
    },
    capabilities::mcp_server::advertised_capability_descriptors,
    context_compaction,
    conversation_history::acp_conversation_history_text_for_session,
    delegated_agents,
    providers::chat_types::{isolated_internal_purpose, ProviderChatRequest},
    sessions::attachments::{hash_file_streaming, validate_attachment_name},
    state::{
        managers::{CapabilityIdeEvidenceManager, ProviderCancellationManager},
        provider_run::BoundProviderCapabilityContext,
    },
    stores::to_string,
};
use gyro_core::{
    CapabilityPolicySnapshot, CapabilityRunMode, GyroConfig, GyroPaths, Session, SessionStore,
    WorkspaceContextSnapshot, WORKSPACE_UNAVAILABLE_MESSAGE,
};
use std::{fs, path::PathBuf};
use tauri::Manager;
use uuid::Uuid;
pub(crate) fn session_execution_workspace(
    session: &Session,
    paths: &GyroPaths,
) -> Result<PathBuf, String> {
    if session.workspace_path.as_os_str().is_empty() {
        paths.ensure_chat_workspace(session.id).map_err(to_string)
    } else {
        session
            .workspace_path
            .canonicalize()
            .map_err(|_| "the chat workspace is no longer available".to_string())
    }
}

pub(crate) fn bind_provider_chat_request(
    request: &mut ProviderChatRequest,
    session: &Session,
    config: &GyroConfig,
    paths: &GyroPaths,
) -> Result<(), String> {
    let role_store = gyro_core::SessionStore::open(paths.clone()).map_err(to_string)?;
    let root = session_execution_workspace(session, paths)?;
    if let Some(id) = request.workflow_run_id {
        let ceiling = role_store
            .validate_workflow_dispatch(
                id,
                session.id,
                &request.provider_id,
                request.model_id.as_deref(),
                &root.to_string_lossy(),
            )
            .map_err(to_string)?;
        request.full_access = false;
        request.require_command_approval = true;
        request.require_file_edit_approval = true;
        if ceiling == gyro_core::workflows::WorkflowAccess::ReadOnly {
            request.mode = super::chat_types::ChatMode::Plan;
        }
    } else if role_store
        .active_workflow_for_root(&root.to_string_lossy())
        .map_err(to_string)?
        .is_some()
    {
        return Err("A workflow owns this checkout. Stop it before starting another mutating chat, or use another worktree.".into());
    }
    if role_store
        .advisory_session_purpose(session.id)
        .map_err(to_string)?
        .is_some()
    {
        return Err(
            "This session is managed by an advisory feature; use its Review or Workflow controls."
                .into(),
        );
    }
    if request.session_id != session.id.to_string() {
        return Err("provider chat session identity did not match stored state".into());
    }
    let provider_id = session
        .provider_id
        .as_deref()
        .ok_or_else(|| "select a provider before starting chat".to_string())?;
    if request.provider_id != provider_id {
        return Err("provider selection changed; refresh the chat and try again".into());
    }
    let provider = config
        .model_providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| "the selected provider is not configured".to_string())?;
    if config
        .removed_provider_ids
        .iter()
        .any(|id| id == provider_id)
    {
        return Err("the selected provider was removed from Gyro".into());
    }
    if !provider.enabled {
        return Err("the selected provider is disabled in Gyro settings".into());
    }
    if request.model_id != session.model_id || request.reasoning_effort != session.reasoning_effort
    {
        return Err("model selection changed; refresh the chat and try again".into());
    }

    let workspace = session_execution_workspace(session, paths)?;
    if !workspace.is_dir() {
        return Err("the chat workspace is not a directory".into());
    }
    if let Some(requested_workspace) = request
        .workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        let requested_workspace = PathBuf::from(requested_workspace)
            .canonicalize()
            .map_err(|_| "the requested workspace is no longer available".to_string())?;
        if requested_workspace != workspace {
            return Err("workspace selection changed; refresh the chat and try again".into());
        }
    }

    // The renderer selects UX state, but native execution authority always comes
    // from persisted backend state. This prevents a stale or compromised renderer
    // from weakening approvals or swapping provider/workspace/model identity.
    request.provider_id = provider_id.to_string();
    request.provider_label = session
        .provider_label
        .clone()
        .or_else(|| Some(provider.display_name.clone()));
    request.model_id = session.model_id.clone();
    request.model_label = session.model_label.clone();
    request.reasoning_effort = session.reasoning_effort.clone();
    request.workspace_path = Some(workspace.display().to_string());
    request.require_command_approval = config.require_command_approval;
    request.require_file_edit_approval = config.require_file_edit_approval;
    // Approval requirements are the stronger authority. A stale or manually
    // edited config must not let a provider's full-access flag bypass them.
    request.full_access = config.full_access
        && !request.require_command_approval
        && !request.require_file_edit_approval;
    Ok(())
}

pub(crate) use gyro_core::provider_runtime::support::capability_run_mode_for_chat;

pub(crate) fn advertised_mcp_capability_tools(mode: CapabilityRunMode) -> String {
    advertised_capability_descriptors(mode)
        .map(|descriptor| {
            format!(
                "mcp__gyro_capabilities__{}",
                descriptor.id.provider_tool_name()
            )
        })
        .collect::<Vec<_>>()
        .join(",")
}

pub(crate) fn bind_provider_capability_context(
    app: &tauri::AppHandle,
    store: &SessionStore,
    request: &ProviderChatRequest,
    run_id: Uuid,
    load_persisted_context: bool,
    session: &Session,
) -> Result<bool, String> {
    let workspace_path = request
        .workspace_path
        .as_deref()
        .ok_or_else(|| "provider capability context requires a workspace".to_string())?;
    let workspace_check = gyro_core::check_workspace(workspace_path);
    if workspace_check.is_unavailable() {
        return Err(WORKSPACE_UNAVAILABLE_MESSAGE.into());
    }
    // The check already resolved this root and keyed its report by the result,
    // so the turn reuses that path instead of canonicalizing a second time.
    let workspace = workspace_check
        .canonical_workspace()
        .ok_or_else(|| WORKSPACE_UNAVAILABLE_MESSAGE.to_string())?;
    let workspace_key = workspace.display().to_string();
    let policy = store
        .get_project_capability_policy(&workspace_key)
        .map_err(to_string)?;
    let mode = capability_run_mode_for_chat(request.mode);
    let persisted_context = if load_persisted_context {
        store
            .latest_workspace_context_event(
                Uuid::parse_str(&request.session_id).map_err(to_string)?,
                run_id,
            )
            .map_err(to_string)?
            .and_then(|event| {
                event
                    .payload
                    .get("snapshot")
                    .cloned()
                    .and_then(|snapshot| serde_json::from_value(snapshot).ok())
            })
    } else {
        None
    };
    let context_already_persisted = persisted_context.is_some();
    let workspace_context = if let Some(context) = persisted_context {
        context
    } else {
        app.state::<CapabilityIdeEvidenceManager>()
            .evidence
            .lock()
            .map_err(|_| "IDE evidence state is unavailable".to_string())?
            .get(&workspace_key)
            .cloned()
            .unwrap_or_else(|| WorkspaceContextSnapshot::empty(workspace_key.clone()))
    };
    let mut context = BoundProviderCapabilityContext {
        session_id: request.session_id.clone(),
        turn_id: Some(run_id.to_string()),
        provider_id: request.provider_id.clone(),
        provider_kind: load_config_blocking()?
            .model_providers
            .iter()
            .find(|provider| provider.id == request.provider_id)
            .and_then(|provider| provider.kind.clone()),
        workspace,
        workspace_key,
        workspace_identity_revision: session.workspace_identity.revision,
        allow_delegation: delegated_agents::request_allows_delegation(request)
            && delegated_agents::can_delegate(&request.session_id),
        policy: CapabilityPolicySnapshot::from_policy(&policy, mode),
        workspace_context,
        workspace_check,
    };
    delegated_agents::restrict_context(app, &mut context);
    let manager = app.state::<ProviderCancellationManager>();
    let control = manager
        .flags
        .lock()
        .map_err(|_| "provider run state is unavailable".to_string())?
        .get(&request.session_id)
        .cloned()
        .ok_or_else(|| "provider run is no longer active".to_string())?;
    *control
        .capability_context
        .lock()
        .map_err(|_| "provider capability context is unavailable".to_string())? = Some(context);
    Ok(context_already_persisted)
}

pub(crate) fn validate_chat_context(request: &ProviderChatRequest) -> Result<(), String> {
    if request.attachments.len() > MAX_CHAT_ATTACHMENTS {
        return Err(format!(
            "attach at most {MAX_CHAT_ATTACHMENTS} files per turn"
        ));
    }
    let images = request
        .attachments
        .iter()
        .filter(|attachment| attachment.kind == "image")
        .count();
    if images > MAX_CHAT_IMAGES {
        return Err(format!("attach at most {MAX_CHAT_IMAGES} images per turn"));
    }
    let videos = request
        .attachments
        .iter()
        .filter(|attachment| attachment.kind == "video")
        .count();
    if videos > MAX_CHAT_VIDEOS {
        return Err(format!("attach at most {MAX_CHAT_VIDEOS} videos per turn"));
    }
    let mut total_bytes = 0_u64;
    for attachment in &request.attachments {
        validate_attachment_name(&attachment.name)?;
        let path = PathBuf::from(&attachment.path);
        let link_metadata = fs::symlink_metadata(&path)
            .map_err(|_| format!("{} is no longer available", attachment.name))?;
        if link_metadata.file_type().is_symlink() || !link_metadata.is_file() {
            return Err(format!("{} is not a file", attachment.name));
        }
        let metadata = path
            .metadata()
            .map_err(|_| format!("{} is no longer available", attachment.name))?;
        if metadata.len() != attachment.size {
            return Err(format!(
                "{} changed after it was attached; remove it and attach the current file",
                attachment.name
            ));
        }
        total_bytes = total_bytes
            .checked_add(metadata.len())
            .ok_or_else(|| "attachment size overflow".to_string())?;
        if total_bytes > MAX_CHAT_ATTACHMENT_TOTAL_BYTES {
            return Err(format!(
                "attachments exceed the {} MB per-turn limit",
                MAX_CHAT_ATTACHMENT_TOTAL_BYTES / (1024 * 1024)
            ));
        }
        if attachment.kind == "image" && metadata.len() > MAX_CHAT_IMAGE_BYTES {
            return Err(format!(
                "{} exceeds the {} MB image limit",
                attachment.name,
                MAX_CHAT_IMAGE_BYTES / (1024 * 1024)
            ));
        }
        if attachment.kind == "video" && metadata.len() > MAX_CHAT_VIDEO_BYTES {
            return Err(format!(
                "{} exceeds the {} MB video limit",
                attachment.name,
                MAX_CHAT_VIDEO_BYTES / (1024 * 1024)
            ));
        }
        if attachment.kind == "image" || attachment.kind == "video" {
            let expected_hash = attachment
                .content_hash
                .as_deref()
                .ok_or_else(|| format!("{} is missing its integrity hash", attachment.name))?;
            let canonical = path.canonicalize().map_err(to_string)?;
            let paths = GyroPaths::for_current_user().map_err(to_string)?;
            let attachment_dir = paths
                .sessions_dir
                .join("attachments")
                .join(&request.session_id)
                .canonicalize()
                .map_err(|_| "session attachment storage is unavailable".to_string())?;
            if !canonical.starts_with(&attachment_dir) {
                return Err(format!(
                    "{} is outside this session's private attachment storage",
                    attachment.name
                ));
            }
            let media_limit = if attachment.kind == "video" {
                MAX_CHAT_VIDEO_BYTES
            } else {
                MAX_CHAT_IMAGE_BYTES
            };
            let (current, current_size) = hash_file_streaming(&canonical, Some(media_limit))?;
            if current_size != attachment.size || current != expected_hash {
                return Err(format!(
                    "{} changed after it was attached; remove it and attach the current file",
                    attachment.name
                ));
            }
        } else if attachment.kind == "workspace-file" {
            if metadata.len() > MAX_CHAT_WORKSPACE_ATTACHMENT_BYTES {
                return Err(format!(
                    "{} exceeds the 32 MB workspace attachment limit",
                    attachment.name
                ));
            }
            let workspace = request
                .workspace_path
                .as_deref()
                .ok_or_else(|| "workspace attachment has no selected workspace".to_string())?;
            let canonical = path.canonicalize().map_err(to_string)?;
            let workspace = PathBuf::from(workspace).canonicalize().map_err(to_string)?;
            if !canonical.starts_with(workspace) {
                return Err(format!(
                    "{} escapes the selected workspace",
                    attachment.name
                ));
            }
            let expected = attachment
                .content_hash
                .as_deref()
                .ok_or_else(|| format!("{} is missing its integrity hash", attachment.name))?;
            let (current, current_size) =
                hash_file_streaming(&canonical, Some(MAX_CHAT_WORKSPACE_ATTACHMENT_BYTES))?;
            if current_size != attachment.size || current != expected {
                return Err(format!(
                    "{} changed after it was attached; remove it and attach the current file",
                    attachment.name
                ));
            }
        } else if matches!(
            attachment.kind.as_str(),
            "ide-snapshot" | "browser-snapshot" | "terminal-output"
        ) {
            if metadata.len() > MAX_CHAT_IDE_SNAPSHOT_BYTES {
                return Err(format!(
                    "{} exceeds the 128 KB editor snapshot limit",
                    attachment.name
                ));
            }
            let canonical = path.canonicalize().map_err(to_string)?;
            let paths = GyroPaths::for_current_user().map_err(to_string)?;
            let attachment_dir = paths
                .sessions_dir
                .join("attachments")
                .join(&request.session_id)
                .canonicalize()
                .map_err(|_| "session attachment storage is unavailable".to_string())?;
            if !canonical.starts_with(&attachment_dir) {
                return Err(format!(
                    "{} is outside this session's private snapshot storage",
                    attachment.name
                ));
            }
            let expected = attachment
                .content_hash
                .as_deref()
                .ok_or_else(|| format!("{} is missing its integrity hash", attachment.name))?;
            let (current, current_size) =
                hash_file_streaming(&canonical, Some(MAX_CHAT_IDE_SNAPSHOT_BYTES))?;
            if current_size != attachment.size || current != expected {
                return Err(format!(
                    "{} changed after it was captured; remove it and capture it again",
                    attachment.name
                ));
            }
        } else {
            return Err(format!(
                "{} has an unsupported attachment kind",
                attachment.name
            ));
        }
    }
    Ok(())
}

/// Local transcript for a provider turn that cannot resume a foreign agent
/// session (model handoff, missing cursor, or first turn after a switch).
pub(crate) fn local_conversation_history_for_request(
    request: &ProviderChatRequest,
) -> Option<String> {
    // Internal text-only calls already carry their complete input.
    if isolated_internal_purpose(request).is_some()
        || context_compaction::summary_stream_muted(&request.session_id)
    {
        return None;
    }
    acp_conversation_history_text_for_session(&request.session_id)
}

pub(crate) use gyro_core::provider_runtime::prompts::provider_approval_instructions;
