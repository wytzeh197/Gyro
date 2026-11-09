use crate::ide::debug::redact_json_strings;
use gyro_core::{CapabilityId, WorkspaceContextSnapshot};
use std::path::Path;
// Keep routine model inspection small; callers can opt into the hard tool
// ceiling when the additional context is actually needed.
pub(super) const DEFAULT_WORKSPACE_RESULT_BYTES: usize = 16 * 1024;
pub(super) const MIN_WORKSPACE_RESULT_BYTES: usize = 1024;

pub(super) fn workspace_result_bytes_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "integer", "minimum": MIN_WORKSPACE_RESULT_BYTES,
        "maximum": gyro_core::capabilities::MAX_CAPABILITY_RESULT_BYTES,
        "default": DEFAULT_WORKSPACE_RESULT_BYTES,
        "description": "Maximum serialized result data bytes. Keep the default for routine inspection; increase only when additional context is needed. Integer values are clamped to the supported range; null uses the default."
    })
}

/// An existence hint only: never read or substitute another file, follow a
/// symlink, enumerate the workspace, or broaden a failed read's authority.
pub(super) fn workspace_path_recovery(workspace: &Path, path: &str) -> String {
    let mut guidance = String::from("Resolve paths from the selected workspace root, not the last file's directory. Preserve the exact path in the user's request; a bare filename names a root file. Call gyro_workspace_list with path \".\" to locate existing files. Do not create a file merely because this read failed.");
    if let Some(name) = Path::new(path).file_name().and_then(|name| name.to_str()) {
        if path != name && !gyro_core::capability_path_is_sensitive(name) {
            let root_file = workspace.join(name);
            if root_file
                .symlink_metadata()
                .is_ok_and(|metadata| metadata.file_type().is_file())
                && gyro_core::security::assert_path_inside_workspace(workspace, Path::new(name))
                    .is_ok()
            {
                guidance.push_str(&format!(" Existing file with this name at the workspace root: {name:?}. Read that exact path if it is the file requested; no alternate file was read by this failed call."));
            }
        }
    }
    guidance
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
    let Some(value) = arguments.get("maxBytes").filter(|value| !value.is_null()) else {
        return Ok(DEFAULT_WORKSPACE_RESULT_BYTES);
    };
    // This is an observation-size hint, not a file range or permission. Repair
    // integer bounds here so every provider and direct broker call behaves the
    // same way without a failed read or another model round. Keep bad types
    // correctable rather than guessing what a string or fraction means.
    if value.as_i64().is_some_and(|bytes| bytes < 0) {
        return Ok(MIN_WORKSPACE_RESULT_BYTES);
    }
    let bytes = value.as_u64().ok_or_else(|| {
        anyhow::anyhow!(
            "capability argument `maxBytes` must be an integer or null; omit it to use the default"
        )
    })?;
    Ok(bytes.clamp(
        MIN_WORKSPACE_RESULT_BYTES as u64,
        gyro_core::capabilities::MAX_CAPABILITY_RESULT_BYTES as u64,
    ) as usize)
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
            | CapabilityId::BrowserTargets
            | CapabilityId::BrowserSelectTarget
            | CapabilityId::BrowserCapturePreview
            | CapabilityId::BrowserPreviewClick
            | CapabilityId::BrowserMouse
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
    fn workspace_result_budgets_repair_optional_size_hints() {
        assert_eq!(workspace_result_byte_limit(&json!({})).unwrap(), 16 * 1024);
        for (value, expected) in [
            (Value::Null, DEFAULT_WORKSPACE_RESULT_BYTES),
            (json!(-1), 1024),
            (json!(i64::MIN), 1024),
            (json!(0), 1024),
            (json!(1023), 1024),
            (json!(1024), 1024),
            (json!(4096), 4096),
            (json!(131072), 131072),
            (json!(131073), 131072),
            (json!(u64::MAX), 131072),
        ] {
            assert_eq!(
                workspace_result_byte_limit(&json!({"maxBytes":value})).unwrap(),
                expected,
                "maxBytes={value}"
            );
        }
        for value in [json!(1.5), json!("4096"), json!(true), json!({}), json!([])] {
            assert!(workspace_result_byte_limit(&json!({"maxBytes":value})).is_err());
        }
    }

    #[test]
    fn multiple_workspace_roots_require_an_explicit_root() {
        assert!(root_argument_required(2, false));
        assert!(!root_argument_required(1, false));
        assert!(!root_argument_required(2, true));
        assert!(root_argument_required(0, false));
    }
}
