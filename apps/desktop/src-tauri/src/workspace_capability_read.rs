//! Workspace reads honor their advertised ranges and the serialized tool budget.
use super::*;
use serde_json::{json, Value};

pub(super) fn execute(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    request: &CapabilityRequest,
) -> anyhow::Result<(String, Value, Option<CapabilityResourceRef>)> {
    let arguments = &request.arguments;
    let path = gyro_core::normalize_capability_relative_path(capability_argument_string(
        arguments, "path",
    )?)?;
    let workspace = bound.workspace.display().to_string();
    let ranged = request.capability_id == CapabilityId::WorkspaceReadRange
        || ["line", "endLine", "column", "endColumn"]
            .iter()
            .any(|key| arguments.get(key).is_some());
    let mut data = if !ranged {
        let file = read_workspace_file_impl(&workspace, &path)?;
        let candidate =
            gyro_core::security::assert_path_inside_workspace(&bound.workspace, Path::new(&path))?;
        let modified_at = candidate
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .map(chrono::DateTime::<chrono::Utc>::from)
            .map(|v| v.to_rfc3339());
        json!({"path": file.path, "content": file.content, "truncated": file.truncated,
            "sizeBytes": file.size_bytes, "contentHash": file.content_hash, "modifiedAt": modified_at,
            "line": 1, "column": 1})
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
        let (content, hash, disk_hash, dirty, source) = if let Some(buffer) = buffer {
            (
                buffer["content"].as_str().unwrap().to_owned(),
                buffer["contentHash"].clone(),
                buffer["diskHash"].clone(),
                buffer["dirty"].as_bool().unwrap_or(false),
                "editor-buffer",
            )
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
        let mut data = select_range(&content, arguments)?;
        data["path"] = json!(path);
        data["source"] = json!(source);
        data["dirty"] = json!(dirty);
        data["contentHash"] = hash;
        data["diskHash"] = disk_hash;
        data["contextRevision"] = json!(context.revision);
        data
    };
    // Redaction can change encoded size, so bound the actual outgoing data.
    data = bound_read_result(redact_json_strings(data))?;
    let summary = if ranged {
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
    let lines: Vec<_> = content.split('\n').collect();
    let actual_end = end.min(lines.len() as u64);
    let mut text = String::new();
    if line <= actual_end {
        for number in line..=actual_end {
            if number > line {
                text.push('\n');
            }
            let source = lines[(number - 1) as usize];
            let start = if number == line { column - 1 } else { 0 } as usize;
            let stop = if number == end {
                end_column.map(|c| (c - 1) as usize)
            } else {
                None
            };
            text.extend(
                source
                    .chars()
                    .skip(start)
                    .take(stop.map_or(usize::MAX, |end| end.saturating_sub(start))),
            );
        }
    }
    Ok(
        json!({"line": line, "startLine": line, "endLine": actual_end, "column": column,
        "content": text, "truncated": false}),
    )
}

fn continuation(content: &str, line: u64, column: u64) -> (u64, u64) {
    let newlines = content.bytes().filter(|b| *b == b'\n').count() as u64;
    if newlines == 0 {
        (line, column + content.chars().count() as u64)
    } else {
        (
            line + newlines,
            content.rsplit('\n').next().unwrap_or("").chars().count() as u64 + 1,
        )
    }
}

fn bound_read_result(mut data: Value) -> anyhow::Result<Value> {
    let content = data["content"].as_str().unwrap_or("").to_owned();
    let already_truncated = data["truncated"].as_bool().unwrap_or(false);
    let line = data["line"].as_u64().unwrap_or(1);
    let column = data["column"].as_u64().unwrap_or(1);
    let update = |data: &mut Value, end: usize| {
        let text = &content[..end];
        let truncated = already_truncated || end < content.len();
        data["content"] = json!(text);
        data["truncated"] = json!(truncated);
        if truncated {
            let (next_line, next_column) = continuation(text, line, column);
            data["nextLine"] = json!(next_line);
            data["nextColumn"] = json!(next_column);
        }
    };
    update(&mut data, content.len());
    if serde_json::to_vec(&data)?.len() <= gyro_core::capabilities::MAX_CAPABILITY_RESULT_BYTES {
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
        if serde_json::to_vec(&data)?.len() <= gyro_core::capabilities::MAX_CAPABILITY_RESULT_BYTES
        {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    update(&mut data, boundaries[low]);
    gyro_core::validate_capability_result_data(data)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let result =
            bound_read_result(json!({"content":text,"line":1,"column":1,"truncated":false}))
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
    fn workspace_read_preview_truncation_has_continuation() {
        let result = bound_read_result(
            json!({"content":"first\nseé", "line":1,"column":1,"truncated":true}),
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
}
