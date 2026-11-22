//! Workspace reads honor their advertised ranges and the serialized tool budget.
use super::*;
use serde_json::{json, Value};
use std::io::{self, Write};

pub(super) fn execute(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    request: &CapabilityRequest,
) -> anyhow::Result<(String, Value, Option<CapabilityResourceRef>)> {
    let arguments = &request.arguments;
    let max_bytes = workspace_result_byte_limit(arguments)?;
    let requested_path = capability_argument_string(arguments, "path")?;
    // A spill address names bytes this process already retired and read, so it never resolves
    // against the workspace: no path normalization, no IDE buffer lookup, no file to authorize.
    if gyro_core::efficiency::spill::is_address(requested_path) {
        return read_spill(
            &request.context.session_id,
            arguments,
            requested_path,
            max_bytes,
        );
    }
    let path = gyro_core::normalize_capability_relative_path(requested_path)?;
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
        // Copy only the buffer and selection this read needs. The snapshot lists
        // every open tab and can hold unsaved text for more than the active file.
        let (buffer, context_selection, context_revision) =
            with_ide_evidence(app, bound, |context| {
                let buffer = context
                    .buffers
                    .iter()
                    .find(|buffer| buffer.get("path").and_then(Value::as_str) == Some(&path))
                    .cloned();
                let selection = context
                    .selection
                    .as_ref()
                    .filter(|selection| {
                        selection.get("path").and_then(Value::as_str) == Some(&path)
                            && selection.get("text").and_then(Value::as_str).is_some()
                    })
                    .cloned();
                Ok((buffer, selection, context.revision))
            })?;
        let selection_only = arguments
            .get("selectionOnly")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let selection = context_selection;
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
            let buffer = buffer.as_ref().expect("checked above");
            let held = held_editor_text(buffer)?;
            (
                held.content.to_owned(),
                held.hash,
                held.disk_hash,
                held.dirty,
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
        data["contextRevision"] = json!(context_revision);
        if editor_read && !selection_only {
            data["documentVersion"] = buffer
                .as_ref()
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

/// A tool window is bounded tighter than the tool budget itself: the address exists because the
/// value was too expensive to carry, so a single read must not reintroduce it wholesale.
const SPILL_TOOL_WINDOW: usize = 64 * 1024;

/// Headroom kept free for the address, the window numbers and the JSON keys, so the content
/// returned never has to be trimmed after the offsets were computed from it.
const SPILL_RESULT_OVERHEAD: usize = 512;

/// Read one window of a retired copy.
///
/// The copy was disclosed by whatever read produced it, so there is no file to authorize here —
/// but there is also no guarantee it still exists: the sweep drops old copies, and a machine
/// without a data directory never wrote one. Absence is reported as such rather than as a
/// workspace miss, so a caller does not go hunting for a path that was never a path.
fn read_spill(
    session_id: &str,
    arguments: &Value,
    address: &str,
    max_bytes: usize,
) -> anyhow::Result<(String, Value, Option<CapabilityResourceRef>)> {
    let offset = arguments.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let limit = max_bytes
        .saturating_sub(SPILL_RESULT_OVERHEAD)
        .clamp(1, SPILL_TOOL_WINDOW);
    let Some(window) = gyro_core::efficiency::spill::read_window(address, offset, limit)? else {
        anyhow::bail!(
            "{address} is not a copy this session can read: it was swept, or never written"
        );
    };
    let (summary, data) = spill_payload(&window);
    let resource = CapabilityResourceRef {
        id: format!("spill:{session_id}:{address}"),
        kind: "spill".into(),
        label: window.address.clone(),
    };
    Ok((summary, data, Some(resource)))
}

/// The window as the tool reports it. The numbers are the ones the CLI prints, so a reader can
/// copy the next offset from either surface without doing arithmetic.
fn spill_payload(window: &gyro_core::efficiency::spill::SpillRead) -> (String, Value) {
    let end = window.offset + window.text.len();
    let next = window.next_offset();
    let summary = match next {
        Some(next) => format!(
            "Read {} bytes {end} of {} · next offset={next}",
            window.address, window.total_bytes
        ),
        None => format!(
            "Read {} bytes {end} of {} (complete)",
            window.address, window.total_bytes
        ),
    };
    let data = json!({
        "address": window.address,
        "offset": window.offset,
        "bytes": window.text.len(),
        "totalBytes": window.total_bytes,
        "truncated": window.truncated(),
        "nextOffset": next,
        "content": window.text,
        "source": "spill",
        "historical": true,
        "note": "Retained evidence from an earlier execution, not current workspace state. Never repeat an action merely to recover its output.",
    });
    (summary, data)
}

#[cfg(test)]
mod spill_read_tests {
    use super::*;
    use gyro_core::efficiency::spill::SpillRead;

    fn window(offset: usize, text: &str, total_bytes: usize) -> SpillRead {
        SpillRead {
            address: "spill://cap/tool/deadbeef00000000".to_owned(),
            text: text.to_owned(),
            offset,
            total_bytes,
        }
    }

    #[test]
    fn spill_addresses_route_and_paths_do_not() {
        assert!(gyro_core::efficiency::spill::is_address(
            "spill://cap/tool/deadbeef00000000"
        ));
        assert!(!gyro_core::efficiency::spill::is_address("src/lib.rs"));
        assert!(!gyro_core::efficiency::spill::is_address("./spill/x"));
    }

    #[test]
    fn a_partial_window_names_the_next_offset() {
        let (summary, data) = spill_payload(&window(0, &"a".repeat(40), 100));
        assert!(summary.contains("bytes 40 of 100"), "{summary}");
        assert!(summary.contains("next offset=40"), "{summary}");
        assert_eq!(data["nextOffset"], json!(40));
        assert_eq!(data["truncated"], json!(true));
        assert_eq!(data["bytes"], json!(40));
        assert_eq!(data["source"], json!("spill"));
        assert_eq!(data["offset"], json!(0));
    }

    #[test]
    fn the_last_window_says_so_instead_of_naming_a_next_one() {
        let (summary, data) = spill_payload(&window(90, "0123456789", 100));
        assert!(summary.contains("bytes 100 of 100"), "{summary}");
        assert!(summary.contains("complete"), "{summary}");
        assert_eq!(data["nextOffset"], Value::Null);
        assert_eq!(data["truncated"], json!(false));
    }

    #[test]
    fn an_address_with_no_copy_reports_absence_not_a_workspace_miss() {
        let error = read_spill(
            "session",
            &json!({ "path": "spill://cap/tool/0000000000000000" }),
            "spill://cap/tool/0000000000000000",
            8192,
        )
        .err()
        .expect("no copy was ever written at this address");
        assert!(error.to_string().contains("never written"), "{error}");
    }
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

/// Text the bridge is actually holding for one open buffer.
///
/// Complete unsaved text is disclosed. A clean buffer with no copied text is
/// not live editor text. A dirty buffer that did not fit in the evidence
/// snapshot is refused rather than returned as a prefix.
#[derive(Debug)]
pub(super) struct HeldEditorText<'a> {
    pub content: &'a str,
    pub hash: Value,
    pub disk_hash: Value,
    pub dirty: bool,
}

pub(super) fn held_editor_text(buffer: &Value) -> anyhow::Result<HeldEditorText<'_>> {
    if buffer["truncated"].as_bool().unwrap_or(false) {
        anyhow::bail!(
            "Editor buffer exceeds the live-text limit; select a smaller range and use selectionOnly"
        );
    }
    let dirty = buffer["dirty"].as_bool().unwrap_or(false);
    if let Some(content) = buffer.get("content").and_then(Value::as_str) {
        return Ok(HeldEditorText {
            content,
            hash: buffer["contentHash"].clone(),
            disk_hash: buffer["diskHash"].clone(),
            dirty,
        });
    }
    if dirty {
        anyhow::bail!(
            "Unsaved editor text did not fit in the workspace evidence budget; save the file or read the selection with selectionOnly"
        );
    }
    anyhow::bail!(
        "This open file has no unsaved editor text; read it with gyro_workspace_read_range"
    );
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
    let requested_end =
        capability_positive_position(arguments, "endLine")?.unwrap_or(line.saturating_add(199));
    let column = capability_positive_position(arguments, "column")?.unwrap_or(1);
    let end_column = capability_positive_position(arguments, "endColumn")?;
    if requested_end < line {
        anyhow::bail!("Workspace range endLine must not precede line");
    }
    if requested_end == line && end_column.is_some_and(|end| end < column) {
        anyhow::bail!("Workspace range endColumn must not precede column");
    }
    // Copy at most 2,000 lines. A longer ask is the next page, not a failed read:
    // the serialized budget cannot return more, and the continuation covers it.
    let end = requested_end.min(line.saturating_add(1_999));
    let line_limited = end < requested_end;
    let mut actual_end = 0;
    let mut text = String::new();
    let mut omitted_a_line = false;
    // Stop at the first line past the window so a range near the top of a large
    // file does not walk its tail. One extra line tells a clamped window from EOF.
    for (index, source) in content.split('\n').enumerate() {
        let number = index as u64 + 1;
        if number > end {
            omitted_a_line = true;
            break;
        }
        actual_end = number;
        if number >= line {
            if number > line {
                text.push('\n');
            }
            let start = if number == line { column - 1 } else { 0 } as usize;
            // endColumn applies to the requested end line. A clamped window keeps
            // its last line whole so the next page starts at the omitted line.
            let stop = if number == requested_end {
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
        "content": text, "truncated": line_limited && omitted_a_line}),
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
        (line, column + utf16_units(content))
    } else {
        (
            line + newlines,
            utf16_units(content.rsplit('\n').next().unwrap_or("")) + 1,
        )
    }
}

/// UTF-16 length used as an editor column delta.
///
/// Source text is usually ASCII, where the byte length is the UTF-16 length.
/// A minified line is scanned once per budget probe, so the ASCII case should
/// not decode every byte.
fn utf16_units(text: &str) -> u64 {
    if text.is_ascii() {
        text.len() as u64
    } else {
        text.encode_utf16().count() as u64
    }
}

/// Compact JSON length of one string, including the surrounding quotes.
///
/// Matches `serde_json`'s compact encoding: `"`, `\`, and the short controls
/// take two bytes; other bytes below 0x20 take `\u00XX`; everything else,
/// including non-ASCII UTF-8, is written unchanged.
fn json_string_encoded_len(text: &str) -> usize {
    let mut len = 2;
    for &byte in text.as_bytes() {
        len += match byte {
            0x08 | 0x09 | 0x0A | 0x0C | 0x0D | b'"' | b'\\' => 2,
            0x00..=0x1F => 6,
            _ => 1,
        };
    }
    len
}

fn json_byte_len(value: &Value) -> anyhow::Result<usize> {
    struct ByteCounter(usize);

    impl Write for ByteCounter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0 = self.0.saturating_add(buf.len());
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    let mut counter = ByteCounter(0);
    serde_json::to_writer(&mut counter, value)?;
    Ok(counter.0)
}

/// `shell["content"]` must be `""`. The returned length is the compact JSON
/// size of that object with `content` replaced by `content`.
fn payload_len(shell: &Value, content: &str) -> anyhow::Result<usize> {
    debug_assert_eq!(shell.get("content").and_then(Value::as_str), Some(""));
    let shell_len = json_byte_len(shell)?;
    Ok(shell_len - json_string_encoded_len("") + json_string_encoded_len(content))
}

fn bound_read_result(mut data: Value, max_bytes: usize) -> anyhow::Result<Value> {
    // A shorter redaction marker would shift continuation columns and can
    // skip source characters on the next chunk. Mask while preserving positions
    // and redact the remaining metadata separately. Own the string once: the
    // unmasked copy dies with this block instead of sitting beside the page.
    let (masked, redacted) = {
        let raw = match data
            .as_object_mut()
            .and_then(|object| object.remove("content"))
        {
            Some(Value::String(text)) => text,
            _ => String::new(),
        };
        let masked = gyro_core::security::redact_secrets_preserving_positions(&raw);
        let redacted = masked != raw;
        (masked, redacted)
    };
    data = redact_json_strings(data);
    if redacted {
        data["redacted"] = json!(true);
    }
    let full_len = masked.len();
    // The serialized payload is never smaller than its text, so text past the
    // result budget can never fit. Cutting it first keeps the boundary search
    // below from walking a 64 MB minified line.
    let mut cap = full_len.min(max_bytes);
    while !masked.is_char_boundary(cap) {
        cap -= 1;
    }
    let content = if cap == masked.len() {
        masked
    } else {
        masked[..cap].to_owned()
    };
    let already_truncated = data["truncated"].as_bool().unwrap_or(false);
    let line = data["line"].as_u64().unwrap_or(1);
    let column = data["column"].as_u64().unwrap_or(1);
    // Probes price the content string in place. Copying it into the object
    // and encoding that object retained a fresh page on every step.
    data["content"] = json!("");
    let apply_window = |data: &mut Value, end: usize| {
        let truncated = already_truncated || end < full_len;
        data["truncated"] = json!(truncated);
        if truncated {
            let (next_line, next_column) = continuation(&content[..end], line, column);
            data["nextLine"] = json!(next_line);
            data["nextColumn"] = json!(next_column);
        }
    };
    let encoded_len = |data: &Value, end: usize| payload_len(data, &content[..end]);
    apply_window(&mut data, content.len());
    if encoded_len(&data, content.len())? <= max_bytes {
        data["content"] = json!(&content[..]);
        return Ok(data);
    }
    // ASCII character boundaries are the byte offsets, so a source file does
    // not need an index. Non-ASCII still records scalar boundaries. The
    // measured length includes escaping and metadata, which is what the
    // capability validator checks.
    let boundaries = if content.is_ascii() {
        None
    } else {
        Some(
            content
                .char_indices()
                .map(|(index, _)| index)
                .chain(std::iter::once(content.len()))
                .collect::<Vec<_>>(),
        )
    };
    let last = boundaries
        .as_ref()
        .map(|bounds| bounds.len() - 1)
        .unwrap_or(content.len());
    let boundary_at = |index: usize| {
        boundaries
            .as_ref()
            .map(|bounds| bounds[index])
            .unwrap_or(index)
    };
    let (mut low, mut high) = (0, last);
    while low < high {
        let mid = low + (high - low).div_ceil(2);
        let end = boundary_at(mid);
        apply_window(&mut data, end);
        if encoded_len(&data, end)? <= max_bytes {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    let end = boundary_at(low);
    apply_window(&mut data, end);
    if encoded_len(&data, end)? > max_bytes {
        anyhow::bail!("Workspace read metadata exceeds maxBytes; increase the byte budget");
    }
    data["content"] = json!(&content[..end]);
    gyro_core::validate_capability_result_data(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn held_editor_text_accepts_only_complete_live_buffers() {
        let buffer = json!({"path":"a.ts","content":"let x = 1\n","dirty":true,"diskHash":"abc"});
        let held = held_editor_text(&buffer).unwrap();
        assert_eq!(held.content, "let x = 1\n");
        assert!(held.dirty);
        assert_eq!(held.disk_hash, json!("abc"));

        let over_budget = json!({"path":"a.ts","dirty":true});
        assert!(held_editor_text(&over_budget)
            .unwrap_err()
            .to_string()
            .contains("evidence budget"));

        let clean = json!({"path":"a.ts","dirty":false});
        assert!(held_editor_text(&clean)
            .unwrap_err()
            .to_string()
            .contains("gyro_workspace_read_range"));

        let truncated = json!({"path":"a.ts","content":"partial","truncated":true,"dirty":true});
        assert!(held_editor_text(&truncated)
            .unwrap_err()
            .to_string()
            .contains("live-text limit"));
    }

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
        let short = select_range("text", &json!({"line":1,"endLine":2001})).unwrap();
        assert_eq!(short["content"], "text");
        assert_eq!(short["truncated"], false);
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
    fn workspace_read_clamps_a_span_over_two_thousand_lines() {
        let inside = select_range("L1\nL2\nL3", &json!({"line":1,"endLine":2})).unwrap();
        assert_eq!(inside["truncated"], false);
        assert_eq!(inside["content"], "L1\nL2");

        let exact: String = (1..=2_000)
            .map(|n| format!("L{n}"))
            .collect::<Vec<_>>()
            .join("\n");
        let boundary = select_range(&exact, &json!({"line":1,"endLine":9_000})).unwrap();
        assert_eq!(boundary["truncated"], false);
        assert_eq!(boundary["endLine"], 2_000);

        let lines: String = (1..=2_002)
            .map(|n| format!("L{n}"))
            .collect::<Vec<_>>()
            .join("\n");
        let capped =
            select_range(&lines, &json!({"line":1,"endLine":2_002,"endColumn":2})).unwrap();
        assert_eq!(capped["truncated"], true);
        assert_eq!(capped["endLine"], 2_000);
        let capped_text = capped["content"].as_str().unwrap();
        assert_eq!(capped_text.lines().count(), 2_000);
        assert!(capped_text.ends_with("L2000"));
        let page = bound_read_result(capped, DEFAULT_WORKSPACE_RESULT_BYTES).unwrap();
        let rest = select_range(
            &lines,
            &json!({
                "line": page["nextLine"],
                "column": page["nextColumn"],
                "endLine": 2_002
            }),
        )
        .unwrap();
        assert_eq!(
            format!(
                "{}{}",
                page["content"].as_str().unwrap(),
                rest["content"].as_str().unwrap()
            ),
            lines
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

    #[test]
    fn read_window_measurement_matches_compact_json() {
        let long = "x".repeat(200);
        let samples = [
            "",
            "abc",
            "a\"b\\c",
            "line\n\t\r\u{0008}",
            "\u{0001}é🦀",
            long.as_str(),
        ];
        for content in samples {
            let mut shell = json!({
                "path": "a.ts",
                "content": "",
                "line": 1,
                "truncated": true,
                "nextLine": 12,
                "nextColumn": 34
            });
            let measured = payload_len(&shell, content).unwrap();
            shell["content"] = json!(content);
            assert_eq!(
                measured,
                serde_json::to_vec(&shell).unwrap().len(),
                "{content:?}"
            );
        }
    }

    #[test]
    fn bounded_ascii_and_escaped_reads_keep_the_longest_fitting_prefix() {
        for text in ["a\"b\\".repeat(2_000), "é\"".repeat(2_000)] {
            let budget = 900;
            let result = bound_read_result(
                json!({"path":"a.ts","content":text,"line":1,"column":1,"truncated":false}),
                budget,
            )
            .unwrap();
            assert!(serde_json::to_vec(&result).unwrap().len() <= budget);
            let kept = result["content"].as_str().unwrap();
            assert!(kept.len() < text.len());
            let mut extended = kept.to_owned();
            extended.push(text[kept.len()..].chars().next().unwrap());
            let mut longer = result.clone();
            longer["content"] = json!(extended);
            let (next_line, next_column) = continuation(&extended, 1, 1);
            longer["nextLine"] = json!(next_line);
            longer["nextColumn"] = json!(next_column);
            longer["truncated"] = json!(true);
            assert!(serde_json::to_vec(&longer).unwrap().len() > budget);
        }
    }
}
