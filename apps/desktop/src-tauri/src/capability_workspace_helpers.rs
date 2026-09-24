use super::*;

pub(super) fn capability_uses_workspace_root(id: CapabilityId) -> bool {
    !matches!(
        id,
        CapabilityId::WorkspaceContext
            | CapabilityId::BrowserOpen
            | CapabilityId::BrowserInspect
            | CapabilityId::BrowserReload
            | CapabilityId::BrowserScreenshot
            | CapabilityId::BrowserNavigate
            | CapabilityId::BrowserBack
            | CapabilityId::BrowserForward
            | CapabilityId::BrowserClick
            | CapabilityId::BrowserType
            | CapabilityId::BrowserScroll
            | CapabilityId::BrowserFormInput
            | CapabilityId::BrowserReadPage
            | CapabilityId::BrowserFind
            | CapabilityId::BrowserConsole
            | CapabilityId::BrowserNetwork
            | CapabilityId::WebFetch
    )
}

pub(super) fn workspace_context_metadata(
    context: &WorkspaceContextSnapshot,
) -> WorkspaceContextSnapshot {
    let mut visible = context.clone();
    if let Some(selection) = visible
        .selection
        .as_mut()
        .and_then(serde_json::Value::as_object_mut)
    {
        selection.remove("text");
    }
    for buffer in &mut visible.buffers {
        if let Some(object) = buffer.as_object_mut() {
            object.remove("content");
        }
    }
    visible
}

pub(super) fn normalize_workspace_context_paths(
    workspace: &Path,
    context: &mut WorkspaceContextSnapshot,
) -> anyhow::Result<()> {
    let workspace = workspace.canonicalize()?;
    let normalize = |path: &str| -> anyhow::Result<String> {
        let candidate = Path::new(path);
        if candidate.is_absolute() {
            let candidate =
                gyro_core::security::assert_path_inside_workspace(&workspace, candidate)?;
            return candidate
                .strip_prefix(&workspace)
                .map(|relative| relative.to_string_lossy().replace('\\', "/"))
                .map_err(anyhow::Error::from);
        }
        gyro_core::normalize_capability_relative_path(path)
    };
    context.active_path = context.active_path.as_deref().map(&normalize).transpose()?;
    context.visible_tabs = context
        .visible_tabs
        .iter()
        .map(|path| normalize(path))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let normalize_value_path = |value: &mut serde_json::Value| -> anyhow::Result<()> {
        let Some(object) = value.as_object_mut() else {
            return Ok(());
        };
        let Some(path) = object
            .get("path")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
        else {
            return Ok(());
        };
        object.insert("path".into(), serde_json::Value::String(normalize(&path)?));
        Ok(())
    };
    if let Some(selection) = context.selection.as_mut() {
        normalize_value_path(selection)?;
    }
    for buffer in &mut context.buffers {
        normalize_value_path(buffer)?;
    }
    for diagnostic in &mut context.diagnostics {
        normalize_value_path(diagnostic)?;
    }
    for test in &mut context.test_failures {
        normalize_value_path(test)?;
    }
    Ok(())
}
