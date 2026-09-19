//! Model-facing semantic code navigation backed by the managed language
//! servers: definition, references, hover, and document symbols.
//!
//! Unlike the editor path this one must work for files the user never
//! opened. It starts (or reuses) the workspace's language server through
//! `language_server.rs`, opens the document on the Rust side, and reports
//! `indexing` instead of a bogus "not found" while a cold server warms up.
use super::*;
use crate::language_server::{LanguageServerManager, LspFileOutcome, LspFileRequest};
use serde_json::{json, Value};
use std::collections::HashMap;

const CODE_OBSERVATION_SCHEMA: &str = "gyro.code-observation.v1";
const MAX_CODE_LOCATIONS: usize = 50;
const MAX_CODE_SYMBOLS: usize = 200;
const MAX_CODE_SYMBOL_DEPTH: usize = 3;
const MAX_CODE_PREVIEWS: usize = 20;
const MAX_CODE_PREVIEW_CHARS: usize = 400;
const MAX_CODE_HOVER_CHARS: usize = 4_000;

const SYMBOL_KINDS: &[&str] = &[
    "",
    "file",
    "module",
    "namespace",
    "package",
    "class",
    "method",
    "property",
    "field",
    "constructor",
    "enum",
    "interface",
    "function",
    "variable",
    "constant",
    "string",
    "number",
    "boolean",
    "array",
    "object",
    "key",
    "null",
    "enum member",
    "struct",
    "event",
    "operator",
    "type parameter",
];

pub(super) fn execute(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    request: &CapabilityRequest,
) -> anyhow::Result<(String, Value, Option<CapabilityResourceRef>)> {
    let arguments = &request.arguments;
    let path = gyro_core::normalize_capability_relative_path(capability_argument_string(
        arguments, "path",
    )?)?;
    // The canonical form is what location previews strip prefixes against;
    // `assert_path_inside_workspace` returns the canonical candidate already.
    let canonical_workspace = bound
        .workspace
        .canonicalize()
        .unwrap_or_else(|_| bound.workspace.clone());
    let file =
        gyro_core::security::assert_path_inside_workspace(&bound.workspace, Path::new(&path))?;
    let (line, column) = match request.capability_id {
        CapabilityId::CodeDefinition | CapabilityId::CodeReferences | CapabilityId::CodeHover => (
            required_position(arguments, "line")?,
            required_position(arguments, "column")?,
        ),
        _ => (0, 0),
    };
    let lsp_request = match request.capability_id {
        CapabilityId::CodeDefinition => LspFileRequest::Definition { line, column },
        CapabilityId::CodeReferences => LspFileRequest::References {
            line,
            column,
            include_declaration: arguments
                .get("includeDeclaration")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        },
        CapabilityId::CodeHover => LspFileRequest::Hover { line, column },
        CapabilityId::CodeSymbols => LspFileRequest::DocumentSymbol,
        _ => anyhow::bail!("lsp_capability does not handle {}", request.capability_id),
    };
    let manager = app.state::<LanguageServerManager>();
    let outcome = manager.request_for_file(&bound.workspace, &path, &file, lsp_request)?;
    let data = match outcome {
        LspFileOutcome::Indexing { retry_after_ms } => json!({
            "schema": CODE_OBSERVATION_SCHEMA,
            "path": &path,
            "status": "indexing",
            "retryAfterMs": retry_after_ms,
            "message": "The language server is still indexing this workspace; retry shortly instead of concluding the symbol is missing.",
        }),
        LspFileOutcome::Result(result) => match request.capability_id {
            CapabilityId::CodeDefinition | CapabilityId::CodeReferences => {
                let locations = location_entries(&canonical_workspace, &result);
                let total = locations.len();
                json!({
                    "schema": CODE_OBSERVATION_SCHEMA,
                    "path": &path,
                    "status": "ok",
                    "locations": locations,
                    "total": total,
                })
            }
            CapabilityId::CodeHover => json!({
                "schema": CODE_OBSERVATION_SCHEMA,
                "path": &path,
                "status": "ok",
                "hover": hover_text(&result),
            }),
            CapabilityId::CodeSymbols => json!({
                "schema": CODE_OBSERVATION_SCHEMA,
                "path": &path,
                "status": "ok",
                "symbols": symbol_entries(&result),
            }),
            _ => anyhow::bail!("lsp_capability does not handle {}", request.capability_id),
        },
    };
    let data = bound_code_result(redact_json_strings(data))?;
    let summary = if data["status"] == "indexing" {
        format!("Language server is indexing for {path}")
    } else {
        let count = |key: &str| data[key].as_array().map(Vec::len).unwrap_or(0);
        match request.capability_id {
            CapabilityId::CodeDefinition => {
                format!(
                    "Found {} definition location(s) for {path}",
                    count("locations")
                )
            }
            CapabilityId::CodeReferences => {
                format!("Found {} reference(s) for {path}", count("locations"))
            }
            CapabilityId::CodeHover => format!("Read hover card for {path}"),
            CapabilityId::CodeSymbols => {
                format!("Listed {} symbol(s) in {path}", count("symbols"))
            }
            _ => format!("Inspected {path}"),
        }
    };
    let resource = CapabilityResourceRef {
        id: format!("workspace:{}:{path}", request.context.session_id),
        kind: "ide".into(),
        label: path,
    };
    Ok((summary, data, Some(resource)))
}

fn required_position(arguments: &Value, name: &str) -> anyhow::Result<u64> {
    capability_positive_position(arguments, name)?
        .ok_or_else(|| anyhow::anyhow!("capability argument `{name}` is required"))
}

/// Normalize LSP `Location | Location[] | LocationLink[] | null` into bounded
/// entries with a source preview line, so a definition lookup does not cost
/// the model a second read round trip.
fn location_entries(workspace: &Path, result: &Value) -> Vec<Value> {
    let raw = match result {
        Value::Array(items) => items.iter().collect::<Vec<_>>(),
        Value::Object(_) => vec![result],
        _ => Vec::new(),
    };
    let mut lines_by_path: HashMap<String, Option<Vec<String>>> = HashMap::new();
    let mut entries = Vec::new();
    for item in raw {
        if entries.len() >= MAX_CODE_LOCATIONS {
            break;
        }
        let Some(uri) = item
            .get("uri")
            .or_else(|| item.pointer("/targetUri"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let Some(range) = item
            .get("range")
            .or_else(|| item.pointer("/targetSelectionRange"))
            .or_else(|| item.pointer("/targetRange"))
        else {
            continue;
        };
        let Some(file) = uri_to_path(uri) else {
            continue;
        };
        let line = range
            .pointer("/start/line")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            + 1;
        let column = range
            .pointer("/start/character")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            + 1;
        let mut entry = json!({
            "path": path_label(workspace, &file),
            "line": line,
            "column": column,
        });
        if entries.len() < MAX_CODE_PREVIEWS {
            if let Some(preview) = preview_line(workspace, &file, line, &mut lines_by_path) {
                entry["preview"] = json!(preview);
            }
        }
        entries.push(entry);
    }
    entries
}

/// `file:///path` → `PathBuf`, decoding the percent escapes the editor and
/// this crate both emit for spaces and other reserved characters.
fn uri_to_path(uri: &str) -> Option<PathBuf> {
    let rest = uri.strip_prefix("file://")?;
    let bytes = rest.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok()?;
            decoded.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok().map(PathBuf::from)
}

fn path_label(workspace: &Path, file: &Path) -> String {
    file.strip_prefix(workspace)
        .unwrap_or(file)
        .to_string_lossy()
        .into_owned()
}

fn preview_line(
    workspace: &Path,
    file: &Path,
    line: u64,
    cache: &mut HashMap<String, Option<Vec<String>>>,
) -> Option<String> {
    let relative = file.strip_prefix(workspace).ok()?.to_str()?;
    // Previews go through the same bounded reader as the read capabilities so
    // symlinks, binary files, and oversized files behave identically. Files
    // outside the workspace are left without a preview on purpose.
    let lines = cache
        .entry(relative.to_string())
        .or_insert_with(|| {
            read_workspace_file_with_limit(
                &workspace.display().to_string(),
                relative,
                MAX_WORKSPACE_SEARCH_FALLBACK_BYTES as usize,
            )
            .ok()
            .map(|file| file.content.split('\n').map(str::to_owned).collect())
        })
        .as_ref()?;
    let text = lines.get(line.checked_sub(1)? as usize)?;
    Some(
        text.trim()
            .chars()
            .take(MAX_CODE_PREVIEW_CHARS)
            .collect::<String>(),
    )
}

fn hover_text(result: &Value) -> String {
    let contents = result.get("contents").cloned().unwrap_or(Value::Null);
    let text = match contents {
        Value::String(text) => text,
        Value::Object(_) => contents
            .get("value")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::String(text) => text.clone(),
                Value::Object(_) => item
                    .get("value")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                _ => String::new(),
            })
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => String::new(),
    };
    text.chars().take(MAX_CODE_HOVER_CHARS).collect()
}

fn symbol_entries(result: &Value) -> Vec<Value> {
    let mut entries = Vec::new();
    let Value::Array(items) = result else {
        return entries;
    };
    // documentSymbol may return either the hierarchical DocumentSymbol[]
    // shape or the flat SymbolInformation[] shape; support both.
    let flat = items.iter().all(|item| item.get("location").is_some())
        && items.iter().any(|item| item.get("location").is_some());
    for item in items {
        if entries.len() >= MAX_CODE_SYMBOLS {
            break;
        }
        if flat {
            let Some(name) = item.get("name").and_then(Value::as_str) else {
                continue;
            };
            let line = item
                .pointer("/location/range/start/line")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                + 1;
            entries.push(json!({
                "name": name,
                "kind": symbol_kind(item),
                "line": line,
                "depth": 0,
            }));
        } else {
            flatten_document_symbol(item, 0, &mut entries);
        }
    }
    entries
}

fn flatten_document_symbol(symbol: &Value, depth: usize, entries: &mut Vec<Value>) {
    if entries.len() >= MAX_CODE_SYMBOLS || depth > MAX_CODE_SYMBOL_DEPTH {
        return;
    }
    let Some(name) = symbol.get("name").and_then(Value::as_str) else {
        return;
    };
    let line = symbol
        .pointer("/selectionRange/start/line")
        .or_else(|| symbol.pointer("/range/start/line"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
        + 1;
    entries.push(json!({
        "name": name,
        "kind": symbol_kind(symbol),
        "line": line,
        "depth": depth,
    }));
    if let Some(children) = symbol.get("children").and_then(Value::as_array) {
        for child in children {
            flatten_document_symbol(child, depth + 1, entries);
        }
    }
}

fn symbol_kind(symbol: &Value) -> &'static str {
    let kind = symbol.get("kind").and_then(Value::as_u64).unwrap_or(0) as usize;
    SYMBOL_KINDS
        .get(kind)
        .copied()
        .filter(|value| !value.is_empty())
        .unwrap_or("symbol")
}

/// Keep the observation inside the shared capability budget by trimming
/// whole trailing entries; a half entry would be worse than a smaller list.
fn bound_code_result(mut data: Value) -> anyhow::Result<Value> {
    let key = if data.get("locations").is_some() {
        "locations"
    } else if data.get("symbols").is_some() {
        "symbols"
    } else {
        return Ok(data);
    };
    while serde_json::to_vec(&data)?.len() > gyro_core::capabilities::MAX_CAPABILITY_RESULT_BYTES {
        let length = data[key].as_array().map(Vec::len).unwrap_or(0);
        if length <= 1 {
            break;
        }
        if let Some(items) = data[key].as_array_mut() {
            items.truncate(length / 2);
        }
        data["truncated"] = json!(true);
    }
    Ok(data)
}

/// Tool schemas live here so `lib.rs` keeps a single delegation guard instead
/// of one arm per capability.
pub(super) fn schema(id: CapabilityId) -> Option<(Value, Vec<&'static str>)> {
    let (properties, required) = match id {
        CapabilityId::CodeDefinition | CapabilityId::CodeHover => (
            json!({
                "path": { "type": "string" },
                "line": { "type": "integer", "minimum": 1 },
                "column": { "type": "integer", "minimum": 1 }
            }),
            vec!["path", "line", "column"],
        ),
        CapabilityId::CodeReferences => (
            json!({
                "path": { "type": "string" },
                "line": { "type": "integer", "minimum": 1 },
                "column": { "type": "integer", "minimum": 1 },
                "includeDeclaration": { "type": "boolean" }
            }),
            vec!["path", "line", "column"],
        ),
        CapabilityId::CodeSymbols => (
            json!({
                "path": { "type": "string" }
            }),
            vec!["path"],
        ),
        _ => return None,
    };
    Some((properties, required))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uri_to_path_decodes_percent_escapes() {
        assert_eq!(
            uri_to_path("file:///tmp/Gyro%20Workspace/src/main.ts"),
            Some(PathBuf::from("/tmp/Gyro Workspace/src/main.ts"))
        );
        assert_eq!(uri_to_path("https://example.com"), None);
    }

    #[test]
    fn location_entries_normalize_location_links_and_plain_locations() {
        let workspace = Path::new("/tmp/ws");
        let plain = json!([{
            "uri": "file:///tmp/ws/src/lib.rs",
            "range": { "start": { "line": 4, "character": 8 }, "end": { "line": 4, "character": 11 } }
        }]);
        let entries = location_entries(workspace, &plain);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["path"], "src/lib.rs");
        assert_eq!(entries[0]["line"], 5);
        assert_eq!(entries[0]["column"], 9);

        let link = json!([{
            "targetUri": "file:///tmp/ws/src/app.ts",
            "targetSelectionRange": { "start": { "line": 0, "character": 0 } },
            "targetRange": { "start": { "line": 0, "character": 0 } }
        }]);
        let entries = location_entries(workspace, &link);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["path"], "src/app.ts");
    }

    #[test]
    fn symbol_entries_flatten_document_symbols_with_depth() {
        let result = json!([{
            "name": "Widget",
            "kind": 23,
            "range": { "start": { "line": 0, "character": 0 } },
            "selectionRange": { "start": { "line": 0, "character": 11 } },
            "children": [{
                "name": "render",
                "kind": 6,
                "range": { "start": { "line": 1, "character": 2 } },
                "selectionRange": { "start": { "line": 1, "character": 6 } },
            }]
        }]);
        let entries = symbol_entries(&result);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["name"], "Widget");
        assert_eq!(entries[0]["kind"], "struct");
        assert_eq!(entries[0]["line"], 1);
        assert_eq!(entries[1]["name"], "render");
        assert_eq!(entries[1]["depth"], 1);
    }

    #[test]
    fn symbol_entries_accept_flat_symbol_information() {
        let result = json!([{
            "name": "main",
            "kind": 12,
            "location": {
                "uri": "file:///tmp/ws/src/main.rs",
                "range": { "start": { "line": 9, "character": 3 } }
            }
        }]);
        let entries = symbol_entries(&result);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["kind"], "function");
        assert_eq!(entries[0]["line"], 10);
    }

    #[test]
    fn hover_text_flattens_markup_and_marked_strings() {
        assert_eq!(
            hover_text(&json!({ "contents": { "kind": "markdown", "value": "fn ready()" } })),
            "fn ready()"
        );
        assert_eq!(
            hover_text(&json!({ "contents": ["one", { "value": "two" }] })),
            "one\n\ntwo"
        );
        assert_eq!(hover_text(&json!(null)), "");
    }

    #[test]
    fn schemas_require_positions_where_the_tools_need_them() {
        let (properties, required) = schema(CapabilityId::CodeDefinition).unwrap();
        assert!(properties["line"].is_object());
        assert_eq!(required, vec!["path", "line", "column"]);
        let (_, required) = schema(CapabilityId::CodeSymbols).unwrap();
        assert_eq!(required, vec!["path"]);
        assert!(schema(CapabilityId::WorkspaceRead).is_none());
    }
}
