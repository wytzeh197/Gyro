//! A bounded, scoped view of the Workspace tree for model calls.
use super::*;
use serde_json::{json, Value};

const DEFAULT_PAGE_LIMIT: usize = 100;
const MAX_PAGE_LIMIT: usize = 200;
const RESULT_HEADROOM_BYTES: usize = 4 * 1024;

pub(super) fn execute(
    workspace: &Path,
    arguments: &Value,
) -> anyhow::Result<(String, Value, Option<CapabilityResourceRef>)> {
    let depth = arguments
        .get("depth")
        .and_then(Value::as_u64)
        .unwrap_or(2)
        .clamp(1, 8) as usize;
    let limit = arguments
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_PAGE_LIMIT as u64)
        .clamp(1, MAX_PAGE_LIMIT as u64) as usize;
    let offset = arguments
        .get("offset")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(usize::MAX as u64) as usize;
    let scope = arguments
        .get("path")
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Workspace list path must be a string"))
                .and_then(gyro_core::normalize_capability_relative_path)
        })
        .transpose()?;
    let directory = scope
        .as_deref()
        .map(|path| assert_workspace_path(workspace, path))
        .transpose()?
        .unwrap_or_else(|| workspace.to_path_buf());
    if !directory.is_dir() {
        anyhow::bail!("Workspace list path must be an existing directory");
    }
    let mut entries = list_workspace_tree_blocking(directory.display().to_string(), Some(depth))
        .map_err(anyhow::Error::msg)?;
    if let Some(scope) = scope.as_deref() {
        let prefix_depth = Path::new(scope).components().count();
        for entry in &mut entries {
            entry.path = format!("{scope}/{}", entry.path);
            entry.depth += prefix_depth;
        }
    }
    let total = entries.len();
    let mut page = Vec::new();
    for entry in entries.iter().skip(offset).take(limit) {
        page.push(entry.clone());
        let candidate = page_result(scope.as_deref(), &page, total, offset);
        if serde_json::to_vec(&candidate)?.len()
            > gyro_core::capabilities::MAX_CAPABILITY_RESULT_BYTES - RESULT_HEADROOM_BYTES
        {
            page.pop();
            break;
        }
    }
    if page.is_empty() && offset < total {
        anyhow::bail!("A Workspace path is too long to return; list a narrower directory");
    }
    let returned = page.len();
    let data = page_result(scope.as_deref(), &page, total, offset);
    let summary = format!(
        "Listed {returned} of {total} Workspace entries{}",
        scope
            .as_ref()
            .map(|path| format!(" in {path}"))
            .unwrap_or_default()
    );
    Ok((summary, data, None))
}

fn page_result(
    scope: Option<&str>,
    entries: &[WorkspaceFile],
    total: usize,
    offset: usize,
) -> Value {
    let next_offset = offset.saturating_add(entries.len());
    let has_more = next_offset < total;
    json!({
        "path": scope,
        "entries": entries,
        "total": total,
        "returned": entries.len(),
        "offset": offset,
        "hasMore": has_more,
        "nextOffset": if has_more { Some(next_offset) } else { None },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_list_pages_and_scopes_without_losing_entries() {
        let workspace = tempfile::tempdir().unwrap();
        fs::create_dir(workspace.path().join("src")).unwrap();
        for index in 0..240 {
            fs::write(
                workspace
                    .path()
                    .join("src")
                    .join(format!("file-{index:03}.rs")),
                "",
            )
            .unwrap();
        }
        let (_, first, _) = execute(
            workspace.path(),
            &json!({"path":"src","depth":1,"limit":75}),
        )
        .unwrap();
        assert_eq!(first["total"], 240);
        assert_eq!(first["returned"], 75);
        assert_eq!(first["nextOffset"], 75);
        assert_eq!(first["hasMore"], true);
        assert!(first["entries"].as_array().unwrap().iter().all(|entry| {
            entry["path"].as_str().unwrap().starts_with("src/") && entry["depth"] == 2
        }));
        let (_, last, _) = execute(
            workspace.path(),
            &json!({"path":"src","depth":1,"offset":225,"limit":75}),
        )
        .unwrap();
        assert_eq!(last["returned"], 15);
        assert_eq!(last["hasMore"], false);
        assert!(last["nextOffset"].is_null());
    }

    #[test]
    fn model_list_rejects_paths_outside_workspace() {
        let workspace = tempfile::tempdir().unwrap();
        assert!(execute(workspace.path(), &json!({"path":"../outside"})).is_err());
        assert!(execute(workspace.path(), &json!({"path":"/tmp"})).is_err());
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            std::os::unix::fs::symlink(outside.path(), workspace.path().join("link")).unwrap();
            assert!(execute(workspace.path(), &json!({"path":"link"})).is_err());
        }
    }

    #[test]
    fn model_list_stays_inside_result_budget() {
        let workspace = tempfile::tempdir().unwrap();
        let mut directory = workspace.path().to_path_buf();
        for _ in 0..6 {
            directory.push("x".repeat(100));
        }
        fs::create_dir_all(&directory).unwrap();
        for index in 0..200 {
            fs::write(
                directory.join(format!("{index:03}-{}.txt", "y".repeat(140))),
                "",
            )
            .unwrap();
        }
        let (_, data, _) = execute(workspace.path(), &json!({"depth":8,"limit":200})).unwrap();
        assert!(data["hasMore"].as_bool().unwrap());
        assert!(
            serde_json::to_vec(&data).unwrap().len()
                <= gyro_core::capabilities::MAX_CAPABILITY_RESULT_BYTES
        );
    }
}
