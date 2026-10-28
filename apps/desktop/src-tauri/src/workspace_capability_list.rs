//! A bounded, scoped view of the Workspace tree for model calls.
use super::*;
use serde_json::{json, Value};

const DEFAULT_PAGE_LIMIT: usize = 100;
const MAX_PAGE_LIMIT: usize = 200;

pub(super) fn execute(
    workspace: &Path,
    arguments: &Value,
) -> anyhow::Result<(String, Value, Option<CapabilityResourceRef>)> {
    let max_bytes = workspace_result_byte_limit(arguments)?;
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
                .and_then(|path| {
                    // Root aliases are valid for a directory listing, while file
                    // capabilities still require a concrete relative path.
                    if matches!(path.trim(), "" | "." | "./" | ".\\") {
                        Ok(None)
                    } else {
                        gyro_core::normalize_capability_relative_path(path).map(Some)
                    }
                })
        })
        .transpose()?
        .flatten();
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
    let window: Vec<WorkspaceFile> = entries.iter().skip(offset).take(limit).cloned().collect();
    // Each entry is encoded once. The old loop encoded the whole page again
    // after every accepted path, so a 200-entry page paid a triangular copy.
    let entry_lengths = window
        .iter()
        .map(redacted_entry_json_len)
        .collect::<anyhow::Result<Vec<_>>>()?;
    let keep =
        entries_within_byte_budget(scope.as_deref(), &entry_lengths, total, offset, max_bytes)?;
    let page = window[..keep].to_vec();
    if page.is_empty() && offset < total {
        anyhow::bail!("A Workspace path is too long to return; list a narrower directory");
    }
    let returned = page.len();
    let data = redact_json_strings(page_result(scope.as_deref(), &page, total, offset));
    if serde_json::to_vec(&data)?.len() > max_bytes {
        anyhow::bail!("Workspace list metadata exceeds maxBytes; increase the byte budget");
    }
    let summary = format!(
        "Listed {returned} of {total} Workspace entries{}",
        scope
            .as_ref()
            .map(|path| format!(" in {path}"))
            .unwrap_or_default()
    );
    Ok((summary, data, None))
}

/// Compact JSON length of one redacted entry, as it appears inside `entries`.
fn redacted_entry_json_len(entry: &WorkspaceFile) -> anyhow::Result<usize> {
    let value = redact_json_strings(serde_json::to_value(entry)?);
    Ok(serde_json::to_vec(&value)?.len())
}

/// How many leading entries fit in the redacted page.
///
/// `page_result` grows as entries are added: the array gains objects, and
/// `returned` / `nextOffset` / `hasMore` change. Those three fields are a
/// small object, so the search re-encodes only that shell. Entry bodies are
/// the precomputed lengths. Adding an entry cannot shrink the page: the
/// smallest entry object is larger than the bytes saved when `nextOffset`
/// flips from a number to `null` on the last page.
fn entries_within_byte_budget(
    scope: Option<&str>,
    entry_lengths: &[usize],
    total: usize,
    offset: usize,
    max_bytes: usize,
) -> anyhow::Result<usize> {
    let mut low = 0usize;
    let mut high = entry_lengths.len();
    while low < high {
        let mid = low + (high - low + 1) / 2;
        match compact_page_len(scope, &entry_lengths[..mid], total, offset)? {
            Some(len) if len <= max_bytes => low = mid,
            _ => high = mid - 1,
        }
    }
    Ok(low)
}

/// Byte length of `redact(page_result)` without encoding the entry array again.
///
/// The page is the metadata object plus one `"entries"` field. A non-empty
/// object gains exactly one comma when that field is added, independent of
/// key order. `None` means the length overflowed.
fn compact_page_len(
    scope: Option<&str>,
    entry_lengths: &[usize],
    total: usize,
    offset: usize,
) -> anyhow::Result<Option<usize>> {
    let count = entry_lengths.len();
    let next_offset = offset.saturating_add(count);
    let has_more = next_offset < total;
    let metadata = redact_json_strings(json!({
        "path": scope,
        "total": total,
        "returned": count,
        "offset": offset,
        "hasMore": has_more,
        "nextOffset": if has_more { Some(next_offset) } else { None },
    }));
    let metadata_len = serde_json::to_vec(&metadata)?.len();
    let Some(array_len) = json_array_len(entry_lengths) else {
        return Ok(None);
    };
    let Some(with_field) = metadata_len.checked_add(1 + "\"entries\":".len()) else {
        return Ok(None);
    };
    Ok(with_field.checked_add(array_len))
}

fn json_array_len(item_lengths: &[usize]) -> Option<usize> {
    let mut total = 2usize; // `[]`
    for (index, len) in item_lengths.iter().copied().enumerate() {
        total = total.checked_add(len)?;
        if index > 0 {
            total = total.checked_add(1)?;
        }
    }
    Some(total)
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
    fn model_list_accepts_root_aliases() {
        let workspace = tempfile::tempdir().unwrap();
        fs::write(workspace.path().join("file.rs"), "").unwrap();
        for arguments in [
            json!({}),
            json!({"path":""}),
            json!({"path":"."}),
            json!({"path":"./"}),
            json!({"path":".\\"}),
        ] {
            let (_, data, _) = execute(workspace.path(), &arguments).unwrap();
            assert_eq!(data["entries"][0]["path"], "file.rs");
            assert!(data["path"].is_null());
        }
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

    #[test]
    fn model_list_small_byte_pages_can_be_followed_without_gaps() {
        let workspace = tempfile::tempdir().unwrap();
        for index in 0..40 {
            fs::write(
                workspace
                    .path()
                    .join(format!("file-{index:02}-{}.txt", "x".repeat(100))),
                "",
            )
            .unwrap();
        }
        let mut offset = 0;
        let mut paths = Vec::new();
        loop {
            let (_, data, _) = execute(
                workspace.path(),
                &json!({"depth":1,"maxBytes":1024,"offset":offset}),
            )
            .unwrap();
            assert!(serde_json::to_vec(&data).unwrap().len() <= 1024);
            paths.extend(
                data["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|entry| entry["path"].as_str().unwrap().to_owned()),
            );
            if !data["hasMore"].as_bool().unwrap() {
                break;
            }
            offset = data["nextOffset"].as_u64().unwrap();
        }
        assert_eq!(paths.len(), 40);
        paths.sort();
        paths.dedup();
        assert_eq!(paths.len(), 40);
    }

    #[test]
    fn page_byte_length_matches_the_encoded_document() {
        let files = sample_files();
        let total = files.len();
        let lengths = files
            .iter()
            .map(redacted_entry_json_len)
            .collect::<anyhow::Result<Vec<_>>>()
            .unwrap();
        for (offset, scope) in [(0usize, None), (4, Some("src"))] {
            for count in 0..=files.len() - offset {
                let slice = &files[offset..offset + count];
                let encoded = serde_json::to_vec(&redact_json_strings(page_result(
                    scope, slice, total, offset,
                )))
                .unwrap()
                .len();
                assert_eq!(
                    compact_page_len(scope, &lengths[offset..offset + count], total, offset)
                        .unwrap(),
                    Some(encoded),
                    "count {count} offset {offset}"
                );
            }
        }
        // The last count in this loop is the full remainder, so hasMore is false
        // and nextOffset is null. Earlier counts still have a numeric nextOffset.
        let keep = entries_within_byte_budget(None, &lengths, total, 0, 900).unwrap();
        let mut linear = 0usize;
        for count in 1..=lengths.len() {
            let len = compact_page_len(None, &lengths[..count], total, 0)
                .unwrap()
                .unwrap();
            if len <= 900 {
                linear = count;
            } else {
                break;
            }
        }
        assert_eq!(keep, linear);
        assert!(keep > 0 && keep < lengths.len());
    }

    fn sample_files() -> Vec<WorkspaceFile> {
        (0..12)
            .map(|index| WorkspaceFile {
                path: if index == 3 {
                    format!("sk-{}", "a".repeat(24))
                } else {
                    format!("dir/file-{index:02}-café-{}.txt", "x".repeat(30))
                },
                kind: "file".into(),
                depth: index,
            })
            .collect()
    }
}
