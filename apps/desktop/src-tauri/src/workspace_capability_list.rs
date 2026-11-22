//! A bounded, scoped view of the Workspace tree for model calls.
use crate::{
    capability_workspace_helpers::workspace_result_byte_limit,
    ide::debug::redact_json_strings,
    workspace::{files::assert_workspace_path, tree::list_workspace_tree_blocking},
};
use gyro_core::CapabilityResourceRef;
use serde_json::{json, Value};
use std::path::Path;

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
    let entries = list_workspace_tree_blocking(directory.display().to_string(), Some(depth))
        .map_err(anyhow::Error::msg)?;
    let total = entries.len();
    let prefix = scope
        .as_deref()
        .map(|scope| (scope, Path::new(scope).components().count()));
    let mut window = Vec::new();
    let mut array_lengths = vec![2usize]; // An empty array is `[]`.
    for mut entry in entries.into_iter().skip(offset).take(limit) {
        if let Some((scope, prefix_depth)) = prefix {
            entry.path = format!("{scope}/{}", entry.path);
            entry.depth += prefix_depth;
        }
        // Redact and measure each candidate once. If its array alone is too
        // large, that prefix cannot fit with the surrounding metadata either.
        let entry = redact_json_strings(serde_json::to_value(entry)?);
        let bytes = serde_json::to_vec(&entry)?.len();
        let used = array_lengths[window.len()];
        let Some(length) = used.checked_add(bytes + usize::from(!window.is_empty())) else {
            break;
        };
        if length > max_bytes {
            break;
        }
        window.push(entry);
        array_lengths.push(length);
    }
    let redacted_scope = redact_json_strings(json!(scope));
    let returned =
        entries_within_byte_budget(&redacted_scope, &array_lengths, total, offset, max_bytes)?;
    if returned == 0 && offset < total {
        anyhow::bail!("A Workspace path is too long to return; list a narrower directory");
    }
    let mut data = page_metadata(&redacted_scope, total, offset, returned);
    if compact_page_len(&data, array_lengths[returned])?.is_none_or(|len| len > max_bytes) {
        anyhow::bail!("Workspace list metadata exceeds maxBytes; increase the byte budget");
    }
    window.truncate(returned);
    data["entries"] = Value::Array(window);
    let summary = format!(
        "Listed {returned} of {total} Workspace entries{}",
        scope
            .as_ref()
            .map(|path| format!(" in {path}"))
            .unwrap_or_default()
    );
    Ok((summary, data, None))
}

/// How many leading entries fit in the redacted page.
///
/// `array_lengths[n]` is the encoded array length for the first `n` entries.
/// The page grows as entries are added: the array gains objects, and
/// `returned` / `nextOffset` / `hasMore` change. Those three fields are a
/// small object, so the search re-encodes only that shell. Entry bodies are
/// the precomputed lengths. Adding an entry cannot shrink the page: the
/// smallest entry object is larger than the bytes saved when `nextOffset`
/// flips from a number to `null` on the last page.
fn entries_within_byte_budget(
    scope: &Value,
    array_lengths: &[usize],
    total: usize,
    offset: usize,
    max_bytes: usize,
) -> anyhow::Result<usize> {
    let mut low = 0usize;
    let mut high = array_lengths.len() - 1;
    while low < high {
        let mid = low + (high - low + 1) / 2;
        let metadata = page_metadata(scope, total, offset, mid);
        match compact_page_len(&metadata, array_lengths[mid])? {
            Some(len) if len <= max_bytes => low = mid,
            _ => high = mid - 1,
        }
    }
    Ok(low)
}

/// Compact JSON length with the already measured entries array.
///
/// The page is the metadata object plus one `"entries"` field. A non-empty
/// object gains exactly one comma when that field is added, independent of
/// key order. `None` means the length overflowed.
fn compact_page_len(metadata: &Value, array_len: usize) -> anyhow::Result<Option<usize>> {
    let metadata_len = serde_json::to_vec(metadata)?.len();
    Ok(metadata_len
        .checked_add(",\"entries\":".len())
        .and_then(|length| length.checked_add(array_len)))
}

fn page_metadata(scope: &Value, total: usize, offset: usize, returned: usize) -> Value {
    let next_offset = offset.saturating_add(returned);
    let has_more = next_offset < total;
    json!({
        "path": scope,
        "total": total,
        "returned": returned,
        "offset": offset,
        "hasMore": has_more,
        "nextOffset": if has_more { Some(next_offset) } else { None },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::types::WorkspaceFile;
    use std::fs;

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
        for (offset, scope) in [
            (0usize, Value::Null),
            (4, json!(format!("sk-{}", "a".repeat(24)))),
        ] {
            let redacted_scope = redact_json_strings(scope.clone());
            let mut array_lengths = Vec::new();
            for count in 0..=files.len() - offset {
                let slice = &files[offset..offset + count];
                let mut page = page_metadata(&scope, total, offset, count);
                page["entries"] = json!(slice);
                let page = redact_json_strings(page);
                let array_len = serde_json::to_vec(&page["entries"]).unwrap().len();
                array_lengths.push(array_len);
                let metadata = page_metadata(&redacted_scope, total, offset, count);
                assert_eq!(
                    compact_page_len(&metadata, array_len).unwrap(),
                    Some(serde_json::to_vec(&page).unwrap().len()),
                    "count {count} offset {offset}"
                );
            }
            // Check caps around every prefix, including where hasMore flips.
            for (count, array_len) in array_lengths.iter().copied().enumerate() {
                let metadata = page_metadata(&redacted_scope, total, offset, count);
                let cap = compact_page_len(&metadata, array_len).unwrap().unwrap();
                assert_eq!(
                    entries_within_byte_budget(&redacted_scope, &array_lengths, total, offset, cap)
                        .unwrap(),
                    count
                );
                assert_eq!(
                    entries_within_byte_budget(
                        &redacted_scope,
                        &array_lengths,
                        total,
                        offset,
                        cap - 1,
                    )
                    .unwrap(),
                    count.saturating_sub(1)
                );
            }
        }
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
