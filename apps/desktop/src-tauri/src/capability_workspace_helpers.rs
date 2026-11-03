use super::*;

// Keep routine model inspection small; callers can opt into the hard tool
// ceiling when the additional context is actually needed.
pub(super) const DEFAULT_WORKSPACE_RESULT_BYTES: usize = 16 * 1024;
pub(super) const MIN_WORKSPACE_RESULT_BYTES: usize = 1024;

pub(super) fn workspace_result_bytes_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "integer", "minimum": MIN_WORKSPACE_RESULT_BYTES,
        "maximum": gyro_core::capabilities::MAX_CAPABILITY_RESULT_BYTES,
        "default": DEFAULT_WORKSPACE_RESULT_BYTES,
        "description": "Maximum serialized result data bytes. Keep the default for routine inspection; increase only when additional context is needed."
    })
}

pub(super) fn redact_workspace_capability_result(
    id: CapabilityId,
    mut data: serde_json::Value,
) -> serde_json::Value {
    if matches!(
        id,
        CapabilityId::WorkspaceRead
            | CapabilityId::WorkspaceReadRange
            | CapabilityId::WorkspaceReadEditor
    ) {
        // These modules mask content before selecting/truncating it. A second
        // generic redaction would change source columns to a shorter marker.
        let content = data
            .as_object_mut()
            .and_then(|object| object.remove("content"));
        let mut data = redact_json_strings(data);
        if let Some(content) = content {
            data["content"] = content;
        }
        data
    } else if id == CapabilityId::WorkspaceSearch {
        if let Some(matches) = data.as_array_mut() {
            for matched in matches {
                // Search previews also preserve full-source UTF-16 ranges.
                let line = matched
                    .as_object_mut()
                    .and_then(|object| object.remove("line"));
                *matched = redact_json_strings(std::mem::take(matched));
                if let Some(line) = line {
                    matched["line"] = line;
                }
            }
        }
        data
    } else {
        redact_json_strings(data)
    }
}

pub(super) fn workspace_result_byte_limit(arguments: &serde_json::Value) -> anyhow::Result<usize> {
    let Some(value) = arguments.get("maxBytes") else {
        return Ok(DEFAULT_WORKSPACE_RESULT_BYTES);
    };
    let bytes = value
        .as_u64()
        .filter(|bytes| {
            (MIN_WORKSPACE_RESULT_BYTES as u64
                ..=gyro_core::capabilities::MAX_CAPABILITY_RESULT_BYTES as u64)
                .contains(bytes)
        })
        .ok_or_else(|| {
            anyhow::anyhow!(
                "capability argument `maxBytes` must be an integer between {} and {}",
                MIN_WORKSPACE_RESULT_BYTES,
                gyro_core::capabilities::MAX_CAPABILITY_RESULT_BYTES
            )
        })?;
    Ok(bytes as usize)
}

/// A search or read with several roots must name one. A single root is implied.
pub(super) fn root_argument_required(root_count: usize, root_id_present: bool) -> bool {
    !root_id_present && root_count != 1
}

pub(super) fn capability_uses_workspace_root(id: CapabilityId) -> bool {
    !matches!(
        id,
        CapabilityId::WorkspaceContext
            | CapabilityId::CodeModeDiscover
            | CapabilityId::CodeModeExecute
            | CapabilityId::BrowserOpen
            | CapabilityId::BrowserInspect
            | CapabilityId::BrowserReload
            | CapabilityId::BrowserScreenshot
            | CapabilityId::BrowserViewport
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
            // The folder it opens is the argument, not one of this chat's roots.
            | CapabilityId::WorkspaceOpenFolder
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn workspace_result_budgets_are_explicit_and_validated() {
        assert_eq!(workspace_result_byte_limit(&json!({})).unwrap(), 16 * 1024);
        assert_eq!(
            workspace_result_byte_limit(&json!({"maxBytes":1024})).unwrap(),
            1024
        );
        for value in [
            json!(0),
            json!(1023),
            json!(131073),
            json!(1.5),
            json!("4096"),
            Value::Null,
        ] {
            assert!(workspace_result_byte_limit(&json!({"maxBytes":value})).is_err());
        }
        assert!(root_argument_required(2, false));
        assert!(!root_argument_required(1, false));
        assert!(!root_argument_required(2, true));
        assert!(root_argument_required(0, false));
    }
}
