//! Workspace reads honor their advertised ranges and the serialized tool budget.
use super::*;
use serde_json::{json, Value};

pub(super) fn execute(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    request: &CapabilityRequest,
) -> anyhow::Result<(String, Value, Option<CapabilityResourceRef>)> {
    let arguments = &request.arguments;
    let max_bytes = workspace_result_byte_limit(arguments)?;
    let path = gyro_core::normalize_capability_relative_path(capability_argument_string(
        arguments, "path",
    )?)?;
    let workspace = bound.workspace.display().to_string();
    let editor_read = request.capability_id == CapabilityId::WorkspaceReadEditor;
    let ranged = editor_read
        || request.capability_id == CapabilityId::WorkspaceReadRange
        || ["line", "endLine", "column", "endColumn"]
            .iter()
            .any(|key| arguments.get(key).is_some());
    let data = if !ranged {
        read_disk_file_data(&workspace, &path)?
    } else {
        let context = app
            .state::<CapabilityIdeEvidenceManager>()
            .by_workspace
            .lock()
            .map_err(|_| anyhow::anyhow!("IDE evidence state is unavailable"))?
            .get(&bound.workspace_key)
            .cloned()
            .unwrap_or_else(|| bound.workspace_context.clone());
        let buffer = context.buffers.iter().find(|buffer| {
            buffer.get("path").and_then(Value::as_str) == Some(&path)
                && buffer.get("content").and_then(Value::as_str).is_some()
        });
        let selection_only = arguments
            .get("selectionOnly")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let selection = context.selection.as_ref().filter(|selection| {
            selection.get("path").and_then(Value::as_str) == Some(&path)
                && selection.get("text").and_then(Value::as_str).is_some()
        });
        let (content, hash, disk_hash, dirty, source) = if editor_read && selection_only {
            let selection = selection.ok_or_else(|| {
                anyhow::anyhow!("No text selection is available for this editor file")
            })?;
            if selection["truncated"].as_bool().unwrap_or(false) {
                anyhow::bail!(
                    "Editor selection exceeds the live-text limit; select a smaller range"
                );
            }
            (
                selection["text"].as_str().unwrap().to_owned(),
                selection["contentHash"].clone(),
                Value::Null,
                true,
                "editor-selection",
            )
        } else if editor_read && buffer.is_some() {
            let buffer = buffer.unwrap();
            if buffer["truncated"].as_bool().unwrap_or(false) {
                anyhow::bail!("Editor buffer exceeds the live-text limit; select a smaller range and use selectionOnly");
            }
            (
                buffer["content"].as_str().unwrap().to_owned(),
                buffer["contentHash"].clone(),
                buffer["diskHash"].clone(),
                buffer["dirty"].as_bool().unwrap_or(false),
                "editor-buffer",
            )
        } else if editor_read {
            anyhow::bail!("No live editor buffer is available for this file");
        } else {
            let file = read_range_source(&workspace, &path)?;
            (
                file.content,
                json!(file.content_hash),
                Value::Null,
                false,
                "disk",
            )
        };
        let mut data = select_safe_range(&content, arguments)?;
        data["path"] = json!(path);
        data["source"] = json!(source);
        data["dirty"] = json!(dirty);
        data["contentHash"] = hash;
        data["diskHash"] = disk_hash;
        data["contextRevision"] = json!(context.revision);
        if editor_read && !selection_only {
            data["documentVersion"] = buffer
                .and_then(|item| item.get("documentVersion"))
                .cloned()
                .unwrap_or(Value::Null);
        }
        data
    };
    let mut data = bound_read_result(data, max_bytes)?;
    if !editor_read {
        apply_known_content_hash(&mut data, arguments)?;
    }
    let summary = if data["unchanged"] == true {
        format!("Verified {path} is unchanged; reused previously read evidence")
    } else if editor_read {
        format!("Read live editor text for {path}")
    } else if ranged {
        format!("Read {path}:{}-{}", data["line"], data["endLine"])
    } else {
        format!("Read {path}")
    };
    let resource = CapabilityResourceRef {
        id: format!("workspace:{}:{}", request.context.session_id, path),
        kind: if ranged { "ide" } else { "workspace" }.into(),
        label: path,
    };
    Ok((summary, data, Some(resource)))
}

/// Conditional reads still inspect disk. The caller explicitly asks to reuse
/// a file it already read; a changed or unavailable hash always returns text.
fn apply_known_content_hash(data: &mut Value, arguments: &Value) -> anyhow::Result<()> {
    let Some(known) = arguments.get("knownContentHash") else {
        return Ok(());
    };
    let known = known
        .as_str()
        .filter(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| {
            anyhow::anyhow!("knownContentHash must be a SHA-256 hash from a previous read")
        })?;
    if data["contentHash"].as_str() == Some(known) {
        if let Some(object) = data.as_object_mut() {
            object.remove("content");
            object.remove("nextLine");
            object.remove("nextColumn");
        }
        data["unchanged"] = json!(true);
        data["contentOmitted"] = json!(true);
    }
    Ok(())
}

fn read_disk_file_data(workspace: &str, path: &str) -> anyhow::Result<Value> {
    // Guarded edits accept a complete-file hash. Reading through the edit
    // limit avoids advertising a preview hash as the hash of a larger file.
    let file = read_workspace_file_with_limit(workspace, path, MAX_WORKSPACE_FILE_EDIT_BYTES)?;
    let candidate =
        gyro_core::security::assert_path_inside_workspace(Path::new(workspace), Path::new(path))?;
    let modified_at = candidate
        .metadata()
        .and_then(|m| m.modified())
        .ok()
        .map(chrono::DateTime::<chrono::Utc>::from)
        .map(|v| v.to_rfc3339());
    Ok(
        json!({"path": file.path, "content": file.content, "truncated": file.truncated,
        "sizeBytes": file.size_bytes,
        "contentHash": if file.truncated { None } else { Some(file.content_hash) },
        "modifiedAt": modified_at, "line": 1, "column": 1}),
    )
}

fn read_range_source(workspace: &str, path: &str) -> anyhow::Result<WorkspaceFileContent> {
    // Ranges must not be selected from the 256 KiB UI preview: later lines
    // would silently look like EOF. Bound input with the existing search budget.
    let file = read_workspace_file_with_limit(
        workspace,
        path,
        MAX_WORKSPACE_SEARCH_FALLBACK_BYTES as usize,
    )?;
    if file.truncated {
        anyhow::bail!("File exceeds the workspace range scan limit; use a targeted terminal read");
    }
    Ok(file)
}

fn select_range(content: &str, arguments: &Value) -> anyhow::Result<Value> {
    let line = capability_positive_position(arguments, "line")?.unwrap_or(1);
    let end =
        capability_positive_position(arguments, "endLine")?.unwrap_or(line.saturating_add(199));
    let column = capability_positive_position(arguments, "column")?.unwrap_or(1);
    let end_column = capability_positive_position(arguments, "endColumn")?;
    if end < line || end - line > 1_999 {
        anyhow::bail!("Workspace range must contain at most 2,000 ordered lines");
    }
    if end == line && end_column.is_some_and(|end| end < column) {
        anyhow::bail!("Workspace range endColumn must not precede column");
    }
    let mut actual_end = 0;
    let mut text = String::new();
    // Iterate instead of indexing a vector containing every line of the file.
    // A range near the top of a large file need not enumerate its entire tail.
    for (index, source) in content.split('\n').enumerate().take(end as usize) {
        let number = index as u64 + 1;
        actual_end = number;
        if number >= line {
            if number > line {
                text.push('\n');
            }
            let start = if number == line { column - 1 } else { 0 } as usize;
            let stop = if number == end {
                end_column.map(|c| (c - 1) as usize)
            } else {
                None
            };
            let start = utf16_offset(source, start)?;
            let stop = stop
                .map(|column| utf16_offset(source, column))
                .transpose()?
                .unwrap_or(source.len());
            text.push_str(&source[start..stop]);
        }
    }
    Ok(
        json!({"line": line, "startLine": line, "endLine": actual_end, "column": column,
        "content": text, "truncated": false}),
    )
}

fn select_safe_range(content: &str, arguments: &Value) -> anyhow::Result<Value> {
    // Redact the complete source before range selection. A chunk beginning
    // halfway through a secret must not expose its otherwise unrecognizable
    // suffix, and masking preserves the requested source positions.
    let masked = gyro_core::security::redact_secrets_preserving_positions(content);
    let mut data = select_range(&masked, arguments)?;
    if masked != content {
        data["redacted"] = json!(true);
    }
    Ok(data)
}

// All editor, LSP and search positions are 1-based UTF-16 columns. Reject a
// position within a surrogate pair so neither a read nor continuation drops it.
fn utf16_offset(line: &str, column: usize) -> anyhow::Result<usize> {
    let mut units = 0;
    for (offset, character) in line.char_indices() {
        if units == column {
            return Ok(offset);
        }
        units += character.len_utf16();
        if units > column {
            anyhow::bail!("Workspace column must not split a UTF-16 surrogate pair");
        }
    }
    Ok(line.len())
}

fn continuation(content: &str, line: u64, column: u64) -> (u64, u64) {
    let newlines = content.bytes().filter(|b| *b == b'\n').count() as u64;
    if newlines == 0 {
        (line, column + content.encode_utf16().count() as u64)
    } else {
        (
            line + newlines,
            content
                .rsplit('\n')
                .next()
                .unwrap_or("")
                .encode_utf16()
                .count() as u64
                + 1,
        )
    }
}

fn bound_read_result(mut data: Value, max_bytes: usize) -> anyhow::Result<Value> {
    // A shorter redaction marker would shift continuation columns and can
    // skip source characters on the next chunk. Mask while preserving positions
    // and redact the remaining metadata separately.
    let raw = data
        .as_object_mut()
        .and_then(|object| object.remove("content"))
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default();
    let masked = gyro_core::security::redact_secrets_preserving_positions(&raw);
    data = redact_json_strings(data);
    if masked != raw {
        data["redacted"] = json!(true);
    }
    data["content"] = json!(masked);
    let full = data["content"].as_str().unwrap_or("");
    let full_len = full.len();
    // The serialized payload is never smaller than its text, so text past the
    // result budget can never fit. Cutting it first keeps the boundary search
    // below from indexing every character of a 64 MB minified line.
    let mut cap = full_len.min(max_bytes);
    while !full.is_char_boundary(cap) {
        cap -= 1;
    }
    let content = full[..cap].to_owned();
    let already_truncated = data["truncated"].as_bool().unwrap_or(false);
    let line = data["line"].as_u64().unwrap_or(1);
    let column = data["column"].as_u64().unwrap_or(1);
    let update = |data: &mut Value, end: usize| {
        let text = &content[..end];
        let truncated = already_truncated || end < full_len;
        data["content"] = json!(text);
        data["truncated"] = json!(truncated);
        if truncated {
            let (next_line, next_column) = continuation(text, line, column);
            data["nextLine"] = json!(next_line);
            data["nextColumn"] = json!(next_column);
        }
    };
    update(&mut data, content.len());
    if serde_json::to_vec(&data)?.len() <= max_bytes {
        return Ok(data);
    }
    // Search UTF-8 boundaries using the serialized payload, including escaping
    // and metadata. This keeps the shared capability validator strict.
    let boundaries: Vec<_> = content
        .char_indices()
        .map(|(i, _)| i)
        .chain(std::iter::once(content.len()))
        .collect();
    let (mut low, mut high) = (0, boundaries.len() - 1);
    while low < high {
        let mid = low + (high - low).div_ceil(2);
        update(&mut data, boundaries[mid]);
        if serde_json::to_vec(&data)?.len() <= max_bytes {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    update(&mut data, boundaries[low]);
    if serde_json::to_vec(&data)?.len() > max_bytes {
        anyhow::bail!("Workspace read metadata exceeds maxBytes; increase the byte budget");
    }
    gyro_core::validate_capability_result_data(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conditional_reads_use_a_fresh_full_file_hash() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("file.rs"), "old source").unwrap();
        let mut first = read_disk_file_data(temp.path().to_str().unwrap(), "file.rs").unwrap();
        let known = first["contentHash"].clone();
        apply_known_content_hash(&mut first, &json!({"knownContentHash":known})).unwrap();
        assert!(first.get("content").is_none());
        assert_eq!(first["unchanged"], true);
        fs::write(temp.path().join("file.rs"), "changed source").unwrap();
        let mut changed = read_disk_file_data(temp.path().to_str().unwrap(), "file.rs").unwrap();
        apply_known_content_hash(&mut changed, &json!({"knownContentHash":known})).unwrap();
        assert_eq!(changed["content"], "changed source");
        assert!(changed.get("unchanged").is_none());
        assert!(
            apply_known_content_hash(&mut changed, &json!({"knownContentHash":"invalid"})).is_err()
        );
        let mut unknown = json!({"content":"partial source","contentHash":null});
        apply_known_content_hash(&mut unknown, &json!({"knownContentHash":known})).unwrap();
        assert_eq!(unknown["content"], "partial source");
    }

    #[test]
    fn workspace_read_honors_range_beyond_preview() {
        let temp = tempfile::tempdir().unwrap();
        let text = format!(
            "{}TARGET\nafter\n",
            "long prefix line padding padding padding\n".repeat(10_000)
        );
        fs::write(temp.path().join("large.tsx"), text).unwrap();
        let file = read_range_source(temp.path().to_str().unwrap(), "large.tsx").unwrap();
        let data = select_range(&file.content, &json!({"line":10001,"endLine":10001})).unwrap();
        assert_eq!(data["content"], "TARGET");
        assert_eq!(data["truncated"], false);
    }

    #[test]
    fn workspace_read_bounds_escaped_unicode_and_can_continue() {
        let text = "\u{0001}é\\\"".repeat(50_000);
        let result = bound_read_result(
            json!({"content":text,"line":1,"column":1,"truncated":false}),
            DEFAULT_WORKSPACE_RESULT_BYTES,
        )
        .unwrap();
        assert!(result["truncated"].as_bool().unwrap());
        assert!(
            serde_json::to_vec(&result).unwrap().len()
                <= gyro_core::capabilities::MAX_CAPABILITY_RESULT_BYTES
        );
        let rest = select_range(
            &text,
            &json!({"line":result["nextLine"],"column":result["nextColumn"],"endLine":1}),
        )
        .unwrap();
        assert_eq!(
            format!(
                "{}{}",
                result["content"].as_str().unwrap(),
                rest["content"].as_str().unwrap()
            ),
            text
        );
    }

    #[test]
    fn workspace_read_bounds_a_huge_minified_line() {
        let text = "é".repeat(8 * 1024 * 1024);
        let result = bound_read_result(
            json!({"content":text,"line":1,"column":1,"truncated":false}),
            DEFAULT_WORKSPACE_RESULT_BYTES,
        )
        .unwrap();
        assert_eq!(result["truncated"], true);
        assert_eq!(result["nextLine"], 1);
        let returned = result["content"].as_str().unwrap().chars().count() as u64;
        assert_eq!(result["nextColumn"], returned + 1);
        assert!(
            serde_json::to_vec(&result).unwrap().len()
                <= gyro_core::capabilities::MAX_CAPABILITY_RESULT_BYTES
        );
    }

    #[test]
    fn workspace_read_preview_truncation_has_continuation() {
        let result = bound_read_result(
            json!({"content":"first\nseé", "line":1,"column":1,"truncated":true}),
            DEFAULT_WORKSPACE_RESULT_BYTES,
        )
        .unwrap();
        assert_eq!(result["nextLine"], 2);
        assert_eq!(result["nextColumn"], 4);
    }

    #[test]
    fn workspace_read_ranges_validate_positions_and_columns() {
        assert!(select_range("text", &json!({"line":2,"endLine":1})).is_err());
        assert!(select_range("text", &json!({"line":0})).is_err());
        assert!(select_range("text", &json!({"line":1,"endLine":2001})).is_err());
        let data = select_range(
            "aébc\nnext",
            &json!({"line":1,"endLine":1,"column":2,"endColumn":4}),
        )
        .unwrap();
        assert_eq!(data["content"], "éb");
        assert_eq!(
            select_range("text", &json!({"line":3})).unwrap()["content"],
            ""
        );
    }

    #[test]
    fn workspace_reads_use_editor_utf16_columns_and_continuations() {
        let selected = select_range(
            "a🦀b",
            &json!({"line":1,"endLine":1,"column":2,"endColumn":4}),
        )
        .unwrap();
        assert_eq!(selected["content"], "🦀");
        assert!(select_range("a🦀b", &json!({"column":3})).is_err());
        let text = "🦀".repeat(2000);
        let result = bound_read_result(json!({"content":text,"line":1,"column":1}), 1024).unwrap();
        let rest = select_range(
            &text,
            &json!({"line":1,"endLine":1,"column":result["nextColumn"]}),
        )
        .unwrap();
        assert_eq!(
            format!(
                "{}{}",
                result["content"].as_str().unwrap(),
                rest["content"].as_str().unwrap()
            ),
            text
        );
        assert!(serde_json::to_vec(&result).unwrap().len() <= 1024);
    }

    #[test]
    fn workspace_read_hash_covers_complete_editable_file() {
        let workspace = tempfile::tempdir().unwrap();
        let content = "x".repeat(MAX_WORKSPACE_FILE_PREVIEW_BYTES + 20);
        fs::write(workspace.path().join("file.txt"), &content).unwrap();
        let result = bound_read_result(
            read_disk_file_data(workspace.path().to_str().unwrap(), "file.txt").unwrap(),
            DEFAULT_WORKSPACE_RESULT_BYTES,
        )
        .unwrap();
        assert_eq!(result["truncated"], true);
        assert_eq!(result["contentHash"], content_hash(content.as_bytes()));
        assert!(serde_json::to_vec(&result).unwrap().len() <= DEFAULT_WORKSPACE_RESULT_BYTES);
        fs::write(
            workspace.path().join("large.txt"),
            "x".repeat(MAX_WORKSPACE_FILE_EDIT_BYTES + 1),
        )
        .unwrap();
        let partial = read_disk_file_data(workspace.path().to_str().unwrap(), "large.txt").unwrap();
        assert!(partial["contentHash"].is_null());
    }

    #[test]
    fn redacted_read_chunks_keep_source_columns() {
        let secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
        let text = format!("\"token\":\"{secret}\" {}", "🦀".repeat(1000));
        let result = bound_read_result(json!({"content":text,"line":1,"column":1}), 1024).unwrap();
        assert_eq!(result["redacted"], true);
        assert!(!result["content"].as_str().unwrap().contains(secret));
        let final_result =
            redact_workspace_capability_result(CapabilityId::WorkspaceRead, result.clone());
        assert_eq!(result["content"], final_result["content"]);
        let rest = select_range(
            &text,
            &json!({"line":1,"endLine":1,"column":result["nextColumn"]}),
        )
        .unwrap();
        assert_eq!(
            format!(
                "{}{}",
                result["content"].as_str().unwrap(),
                rest["content"].as_str().unwrap()
            ),
            gyro_core::security::redact_secrets_preserving_positions(&text)
        );
    }

    #[test]
    fn redacted_astral_secret_can_continue_at_a_byte_cutoff() {
        let text = format!("{{\"token\":\"{}\"}} after", "🦀".repeat(1000));
        let masked = gyro_core::security::redact_secrets_preserving_positions(&text);
        let result = bound_read_result(json!({"content":text,"line":1,"column":1}), 1024).unwrap();
        let arguments = json!({"line":1,"endLine":1,"column":result["nextColumn"]});
        // The returned continuation must be a source codepoint boundary even
        // when the last source character was itself masked as a secret.
        assert!(select_range(&text, &arguments).is_ok());
        let rest = select_range(&masked, &arguments).unwrap();
        assert_eq!(
            format!(
                "{}{}",
                result["content"].as_str().unwrap(),
                rest["content"].as_str().unwrap()
            ),
            masked
        );
    }

    #[test]
    fn continued_range_inside_a_secret_keeps_its_suffix_masked() {
        let text = format!("{{\"token\":\"sk-{}\"}} after", "a".repeat(3000));
        let first = bound_read_result(
            select_safe_range(&text, &json!({"line":1,"endLine":1})).unwrap(),
            1024,
        )
        .unwrap();
        assert_eq!(first["truncated"], true);
        let column = first["nextColumn"].as_u64().unwrap();
        let arguments = json!({"line":1,"endLine":1,"column":column,"endColumn":column+10});
        assert_eq!(
            select_range(&text, &arguments).unwrap()["content"],
            "a".repeat(10)
        );
        let continued = select_safe_range(&text, &arguments).unwrap();
        assert_eq!(continued["content"], "*".repeat(10));
        assert_eq!(continued["redacted"], true);
    }
}
