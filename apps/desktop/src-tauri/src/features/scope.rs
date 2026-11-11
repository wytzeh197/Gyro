use anyhow::{ensure, Result};
use gyro_core::{CapabilityAccess, CapabilityClass, Session, SessionStore};
use std::path::PathBuf;
use uuid::Uuid;

pub(crate) fn root_scope(
    store: &SessionStore,
    session_id: &str,
    root_id: Option<&str>,
) -> Result<(Session, String, PathBuf)> {
    let session = store
        .get_session(Uuid::parse_str(session_id)?)?
        .ok_or_else(|| anyhow::anyhow!("unknown project session"))?;
    ensure!(
        !session.workspace_path.as_os_str().is_empty(),
        "Choose a project to use local project tools"
    );
    let id = root_id
        .unwrap_or(&session.workspace_identity.active_root_id)
        .to_string();
    let root = session
        .workspace_identity
        .root(&id)
        .ok_or_else(|| anyhow::anyhow!("root does not belong to this session"))?
        .canonicalize()?;
    ensure!(
        !root.starts_with(&store.paths().base_dir.canonicalize()?),
        "Private scratch workspaces have no durable project scope"
    );
    let policy = store
        .get_project_capability_policy(&root.to_string_lossy())?
        .with_missing_classes_defaulted();
    ensure!(
        policy.access_for(CapabilityClass::WorkspaceInspect) != CapabilityAccess::Deny,
        "project policy denies workspace inspection"
    );
    Ok((session, id, root))
}
