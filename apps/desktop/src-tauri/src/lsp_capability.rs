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
    let page = CodePage::from_arguments(arguments, request.capability_id)?;
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
                let (locations, total) = location_entries(&canonical_workspace, &result, page);
                paged_result(
                    json!({
                        "schema": CODE_OBSERVATION_SCHEMA,
                        "path": &path,
                        "status": "ok",
                        "locations": locations,
                        "total": total,
                        "offset": page.offset,
                    }),
                    "locations",
                )
            }
            CapabilityId::CodeHover => {
                let text = hover_text(&result);
                json!({
                    "schema": CODE_OBSERVATION_SCHEMA,
                    "path": &path,
                    "status": "ok",
                    "truncated": text.chars().count() > MAX_CODE_HOVER_CHARS,
                    "hover": text.chars().take(MAX_CODE_HOVER_CHARS).collect::<String>(),
                })
            }
            CapabilityId::CodeSymbols => {
                let (symbols, total) = symbol_entries(&canonical_workspace, &file, &result, page);
                paged_result(
                    json!({
                        "schema": CODE_OBSERVATION_SCHEMA,
                        "path": &path,
                        "status": "ok",
                        "symbols": symbols,
                        "total": total,
                        "offset": page.offset,
                    }),
                    "symbols",
                )
            }
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

#[derive(Clone, Copy)]
struct CodePage {
    offset: usize,
    limit: usize,
}

impl CodePage {
    fn from_arguments(arguments: &Value, id: CapabilityId) -> anyhow::Result<Self> {
        let maximum = if id == CapabilityId::CodeSymbols {
            MAX_CODE_SYMBOLS
        } else {
            MAX_CODE_LOCATIONS
        };
        let integer = |name: &str, default: usize| -> anyhow::Result<usize> {
            match arguments.get(name) {
                None => Ok(default),
                Some(value) => value
                    .as_u64()
                    .and_then(|value| usize::try_from(value).ok())
                    .ok_or_else(|| {
                        anyhow::anyhow!(
                            "capability argument `{name}` must be a nonnegative integer"
                        )
                    }),
            }
        };
        let limit = integer("limit", maximum)?;
        if limit == 0 || limit > maximum {
            anyhow::bail!("capability argument `limit` must be between 1 and {maximum}");
        }
        Ok(Self {
            offset: integer("offset", 0)?,
            limit,
        })
    }

    fn includes(self, index: usize) -> bool {
        index >= self.offset && index - self.offset < self.limit
    }
}

/// Recomputed after byte-budget trimming as well as ordinary pagination, so
/// following nextOffset never skips entries removed to fit the response.
fn paged_result(mut data: Value, key: &str) -> Value {
    let returned = data[key].as_array().map_or(0, Vec::len);
    let total = data["total"].as_u64().unwrap_or(0);
    let offset = data["offset"].as_u64().unwrap_or(0);
    let next = offset.saturating_add(returned as u64);
    data["returned"] = json!(returned);
    data["hasMore"] = json!(next < total);
    data["nextOffset"] = if next < total {
        json!(next)
    } else {
        Value::Null
    };
    data["truncated"] = json!((returned as u64) < total);
    data
}

/// Normalize LSP `Location | Location[] | LocationLink[] | null` into bounded
/// entries with a source preview line, so a definition lookup does not cost
/// the model a second read round trip.
fn location_entries(workspace: &Path, result: &Value, page: CodePage) -> (Vec<Value>, usize) {
    let raw = match result {
        Value::Array(items) => items.iter().collect::<Vec<_>>(),
        Value::Object(_) => vec![result],
        _ => Vec::new(),
    };
    let mut source_by_path = HashMap::new();
    let mut entries = Vec::new();
    let mut total = 0;
    for item in raw {
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
        let Some((line, column)) = range_position(range) else {
            continue;
        };
        let include = page.includes(total);
        total += 1;
        if !include {
            continue;
        }
        let mut entry = json!({
            "path": path_label(workspace, &file),
            "line": line,
        });
        let source = source_line(workspace, &file, line, &mut source_by_path);
        insert_scalar_column(&mut entry, source, column);
        if entries.len() < MAX_CODE_PREVIEWS {
            if let Some(source) = source {
                entry["preview"] = json!(source
                    .trim()
                    .chars()
                    .take(MAX_CODE_PREVIEW_CHARS)
                    .collect::<String>());
            }
        }
        entries.push(entry);
    }
    (entries, total)
}

fn range_position(range: &Value) -> Option<(u64, u64)> {
    Some((
        range.pointer("/start/line")?.as_u64()?.checked_add(1)?,
        range
            .pointer("/start/character")?
            .as_u64()?
            .checked_add(1)?,
    ))
}

/// `file:///path` → `PathBuf`, decoding the percent escapes the editor and
/// this crate both emit for spaces and other reserved characters.
fn uri_to_path(uri: &str) -> Option<PathBuf> {
    url::Url::parse(uri).ok()?.to_file_path().ok()
}

fn path_label(workspace: &Path, file: &Path) -> String {
    file.strip_prefix(workspace)
        .unwrap_or(file)
        .to_string_lossy()
        .into_owned()
}

fn source_line<'a>(
    workspace: &Path,
    file: &Path,
    line: u64,
    cache: &'a mut HashMap<String, Option<String>>,
) -> Option<&'a str> {
    let relative = file.strip_prefix(workspace).ok()?.to_str()?;
    // Read original text before response redaction so replaced secret strings
    // cannot shift positions. Reuse this bounded read for columns and previews;
    // never read outside the workspace, including through symlinks.
    let source = cache
        .entry(relative.to_string())
        .or_insert_with(|| {
            read_workspace_file_with_limit(
                &workspace.display().to_string(),
                relative,
                MAX_WORKSPACE_FILE_EDIT_BYTES,
            )
            .ok()
            .filter(|file| !file.truncated)
            .map(|file| file.content)
        })
        .as_ref()?;
    let text = source
        .split('\n')
        .nth(usize::try_from(line.checked_sub(1)?).ok()?)?;
    Some(text.strip_suffix('\r').unwrap_or(text))
}

fn scalar_column(source: &str, utf16_column: u64) -> Option<u64> {
    let target = utf16_column.checked_sub(1)?;
    let mut units = 0;
    let mut column = 1;
    for character in source.chars() {
        if units == target {
            return Some(column);
        }
        units += character.len_utf16() as u64;
        column += 1;
        if units > target {
            return None;
        }
    }
    (units == target).then_some(column)
}

fn insert_scalar_column(entry: &mut Value, source: Option<&str>, utf16_column: u64) {
    match source.and_then(|source| scalar_column(source, utf16_column)) {
        Some(column) => entry["column"] = json!(column),
        None => {
            // A raw UTF-16 value must not masquerade as a reusable tool column.
            entry["column"] = Value::Null;
            entry["utf16Column"] = json!(utf16_column);
            entry["columnUnavailableReason"] = json!(if source.is_some() {
                "invalid_utf16_position"
            } else {
                "source_line_unavailable"
            });
        }
    }
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
    text
}

fn symbol_entries(
    workspace: &Path,
    file: &Path,
    result: &Value,
    page: CodePage,
) -> (Vec<Value>, usize) {
    let mut entries = Vec::new();
    let Value::Array(items) = result else {
        return (entries, 0);
    };
    // Iterate instead of recursing or hiding deeply nested symbols. The page
    // bounds the response, and the stack grows with nesting, not symbol count.
    let mut stack = vec![(items.iter(), 0usize)];
    let mut source_by_path = HashMap::new();
    let mut total = 0;
    while let Some((siblings, depth)) = stack.last_mut() {
        let depth = *depth;
        let Some(symbol) = siblings.next() else {
            stack.pop();
            continue;
        };
        if let Some(children) = symbol.get("children").and_then(Value::as_array) {
            stack.push((children.iter(), depth + 1));
        }
        let Some(name) = symbol.get("name").and_then(Value::as_str) else {
            continue;
        };
        let Some((line, column)) = symbol
            .get("selectionRange")
            .or_else(|| symbol.get("range"))
            .or_else(|| symbol.pointer("/location/range"))
            .and_then(range_position)
        else {
            continue;
        };
        let include = page.includes(total);
        total += 1;
        if !include {
            continue;
        }
        let mut entry = json!({
            "name": name,
            "kind": symbol_kind(symbol),
            "line": line,
            "depth": depth,
        });
        let location_file = symbol
            .pointer("/location/uri")
            .and_then(Value::as_str)
            .map(uri_to_path);
        let source_file = location_file
            .as_ref()
            .map_or(Some(file), |file| file.as_deref());
        let source =
            source_file.and_then(|file| source_line(workspace, file, line, &mut source_by_path));
        insert_scalar_column(&mut entry, source, column);
        entries.push(entry);
    }
    (entries, total)
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
            anyhow::bail!("a code navigation entry exceeds the tool response size limit");
        }
        if let Some(items) = data[key].as_array_mut() {
            items.truncate(length / 2);
        }
        data = paged_result(data, key);
    }
    Ok(data)
}

/// Tool schemas live here so `lib.rs` keeps a single delegation guard instead
/// of one arm per capability.
pub(super) fn schema(id: CapabilityId) -> Option<(Value, Vec<&'static str>)> {
    let (mut properties, required) = match id {
        CapabilityId::CodeDefinition | CapabilityId::CodeHover => (
            json!({
                "path": { "type": "string" },
                "line": { "type": "integer", "minimum": 1 },
                "column": { "type": "integer", "minimum": 1, "description": "One-based Unicode scalar column. Reuse a navigation result's column only when non-null; utf16Column is diagnostic only." }
            }),
            vec!["path", "line", "column"],
        ),
        CapabilityId::CodeReferences => (
            json!({
                "path": { "type": "string" },
                "line": { "type": "integer", "minimum": 1 },
                "column": { "type": "integer", "minimum": 1, "description": "One-based Unicode scalar column. Reuse a navigation result's column only when non-null; utf16Column is diagnostic only." },
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
    if id != CapabilityId::CodeHover {
        properties["offset"] = json!({
            "type": "integer", "minimum": 0,
            "description": "Zero-based result offset. Use nextOffset from the previous result to read the next page. Results may change when the workspace changes."
        });
        properties["limit"] = json!({
            "type": "integer", "minimum": 1,
            "maximum": if id == CapabilityId::CodeSymbols { MAX_CODE_SYMBOLS } else { MAX_CODE_LOCATIONS },
            "description": "Maximum entries to return in this page. Omit to use the maximum."
        });
    }
    Some((properties, required))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_source(relative: &str, content: &str) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().canonicalize().unwrap();
        let file = workspace.join(relative);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, content).unwrap();
        (directory, workspace, file)
    }

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
        let (_directory, workspace, file) = test_source("src/lib.rs", &"let symbol;\n".repeat(5));
        let plain = json!([{
            "uri": url::Url::from_file_path(&file).unwrap().as_str(),
            "range": { "start": { "line": 4, "character": 8 }, "end": { "line": 4, "character": 11 } }
        }]);
        let (entries, total) = location_entries(
            &workspace,
            &plain,
            CodePage {
                offset: 0,
                limit: 50,
            },
        );
        assert_eq!(total, 1);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["path"], "src/lib.rs");
        assert_eq!(entries[0]["line"], 5);
        assert_eq!(entries[0]["column"], 9);

        let link = json!([{
            "targetUri": url::Url::from_file_path(workspace.join("src/app.ts")).unwrap().as_str(),
            "targetSelectionRange": { "start": { "line": 0, "character": 0 } },
            "targetRange": { "start": { "line": 0, "character": 0 } }
        }]);
        let (entries, _) = location_entries(
            &workspace,
            &link,
            CodePage {
                offset: 0,
                limit: 50,
            },
        );
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["path"], "src/app.ts");
    }

    #[test]
    fn symbol_entries_flatten_document_symbols_with_depth() {
        let (_directory, workspace, file) =
            test_source("main.rs", "struct Widget {}\n  fn render() {}\n");
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
        let (entries, total) = symbol_entries(
            &workspace,
            &file,
            &result,
            CodePage {
                offset: 0,
                limit: 200,
            },
        );
        assert_eq!(total, 2);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["name"], "Widget");
        assert_eq!(entries[0]["kind"], "struct");
        assert_eq!(entries[0]["line"], 1);
        assert_eq!(entries[1]["name"], "render");
        assert_eq!(entries[1]["depth"], 1);
        assert_eq!(entries[1]["column"], 7);
    }

    #[test]
    fn symbol_entries_accept_flat_symbol_information() {
        let (_directory, workspace, file) = test_source("main.rs", &"fn main() {}\n".repeat(10));
        let result = json!([{
            "name": "main",
            "kind": 12,
            "location": {
                "uri": url::Url::from_file_path(&file).unwrap().as_str(),
                "range": { "start": { "line": 9, "character": 3 } }
            }
        }]);
        let (entries, _) = symbol_entries(
            &workspace,
            &file,
            &result,
            CodePage {
                offset: 0,
                limit: 200,
            },
        );
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
    fn navigation_columns_after_emoji_can_be_reused_as_scalar_positions() {
        let source = "let icon = \"💡\"; target();";
        let (_directory, workspace, file) = test_source("main.rs", source);
        let target_byte = source.find("target").unwrap();
        let lsp_character = source[..target_byte].encode_utf16().count();
        let range = json!({ "start": { "line": 0, "character": lsp_character } });
        let page = CodePage {
            offset: 0,
            limit: 50,
        };
        let (locations, _) = location_entries(
            &workspace,
            &json!([{
                "uri": url::Url::from_file_path(&file).unwrap().as_str(),
                "range": range,
            }]),
            page,
        );
        let (symbols, _) = symbol_entries(
            &workspace,
            &file,
            &json!([{
                "name": "target", "selectionRange": range,
            }]),
            page,
        );
        for entry in [&locations[0], &symbols[0]] {
            let column = entry["column"].as_u64().unwrap() as usize;
            assert_eq!(column, source[..target_byte].chars().count() + 1);
            assert_eq!(source.chars().nth(column - 1), Some('t'));
            // A subsequent code.* input converts this scalar column to UTF-16.
            let reused = source
                .chars()
                .take(column - 1)
                .map(char::len_utf16)
                .sum::<usize>();
            assert_eq!(reused, lsp_character);
            assert!(entry.get("utf16Column").is_none());
        }
    }

    #[test]
    fn navigation_does_not_offer_unusable_columns() {
        let (_directory, workspace, file) = test_source("main.rs", "💡target();");
        let (_outside_directory, _, outside) = test_source("outside.rs", "💡target();");
        let locations = json!([
            { "uri": url::Url::from_file_path(&file).unwrap().as_str(), "range": { "start": { "line": 0, "character": 1 } } },
            { "uri": url::Url::from_file_path(&file).unwrap().as_str(), "range": { "start": { "line": 0, "character": 99 } } },
            { "uri": url::Url::from_file_path(&outside).unwrap().as_str(), "range": { "start": { "line": 0, "character": 2 } } },
        ]);
        let (entries, total) = location_entries(
            &workspace,
            &locations,
            CodePage {
                offset: 0,
                limit: 50,
            },
        );
        assert_eq!(total, 3);
        for entry in &entries {
            assert!(entry["column"].is_null());
            assert!(entry["utf16Column"].is_number());
        }
        assert_eq!(
            entries[0]["columnUnavailableReason"],
            "invalid_utf16_position"
        );
        assert_eq!(
            entries[1]["columnUnavailableReason"],
            "invalid_utf16_position"
        );
        assert_eq!(
            entries[2]["columnUnavailableReason"],
            "source_line_unavailable"
        );
        assert!(entries[2].get("preview").is_none());
        assert_eq!(scalar_column("é💡x", 1), Some(1));
        assert_eq!(scalar_column("é💡x", 4), Some(3));
        assert_eq!(scalar_column("é💡x", 5), Some(4));
        assert_eq!(scalar_column("é💡x", 3), None);
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

    #[test]
    fn navigation_pages_expose_every_valid_reference() {
        let mut locations = vec![json!({ "uri": "https://example.com", "range": {} })];
        locations.extend((0..65).map(|line| {
            json!({
                "uri": "file:///tmp/ws/src/lib.rs",
                "range": { "start": { "line": line, "character": 0 } }
            })
        }));
        locations.push(json!({
            "uri": "file:///tmp/ws/src/lib.rs",
            "range": { "start": { "line": u64::MAX, "character": 0 } }
        }));
        let result = json!(locations);
        let (first, total) = location_entries(
            Path::new("/tmp/ws"),
            &result,
            CodePage {
                offset: 0,
                limit: 50,
            },
        );
        let first = paged_result(
            json!({ "locations": first, "total": total, "offset": 0 }),
            "locations",
        );
        assert_eq!(first["total"], 65);
        assert_eq!(first["returned"], 50);
        assert_eq!(first["hasMore"], true);
        assert_eq!(first["nextOffset"], 50);
        let (last, total) = location_entries(
            Path::new("/tmp/ws"),
            &result,
            CodePage {
                offset: 50,
                limit: 50,
            },
        );
        let last = paged_result(
            json!({ "locations": last, "total": total, "offset": 50 }),
            "locations",
        );
        assert_eq!(last["locations"][0]["line"], 51);
        assert_eq!(last["returned"], 15);
        assert_eq!(last["hasMore"], false);
        assert!(last["nextOffset"].is_null());
    }

    #[test]
    fn symbols_remain_reachable_after_the_first_page_and_below_depth_three() {
        let (_directory, workspace, file) = test_source("main.rs", &"fn symbol() {}\n".repeat(205));
        let leaf = json!({ "name": "deep", "kind": 12, "range": { "start": { "line": 8, "character": 4 } } });
        let tree = (0..5).fold(leaf, |child, index| {
            json!({
                "name": format!("parent{index}"), "kind": 5,
                "range": { "start": { "line": index, "character": 0 } }, "children": [child]
            })
        });
        let result = json!([tree]);
        let (entries, total) = symbol_entries(
            &workspace,
            &file,
            &result,
            CodePage {
                offset: 5,
                limit: 1,
            },
        );
        assert_eq!(total, 6);
        assert_eq!(entries[0]["name"], "deep");
        assert_eq!(entries[0]["depth"], 5);
        assert_eq!(entries[0]["column"], 5);

        let symbols = json!((0..205).map(|line| json!({
            "name": format!("symbol{line}"), "range": { "start": { "line": line, "character": 0 } }
        })).collect::<Vec<_>>());
        let (entries, total) = symbol_entries(
            &workspace,
            &file,
            &symbols,
            CodePage {
                offset: 200,
                limit: 200,
            },
        );
        assert_eq!(total, 205);
        assert_eq!(entries.len(), 5);
        assert_eq!(entries[0]["name"], "symbol200");
    }

    #[test]
    fn response_budget_trimming_keeps_a_recoverable_offset() {
        let symbols = (0..4)
            .map(|index| json!({ "name": "→".repeat(20_000), "line": index }))
            .collect::<Vec<_>>();
        let data = paged_result(
            json!({ "symbols": symbols, "total": 10, "offset": 3 }),
            "symbols",
        );
        let bounded = bound_code_result(data).unwrap();
        assert_eq!(bounded["returned"], 2);
        assert_eq!(bounded["nextOffset"], 5);
        assert_eq!(bounded["hasMore"], true);
        assert!(
            serde_json::to_vec(&bounded).unwrap().len()
                <= gyro_core::capabilities::MAX_CAPABILITY_RESULT_BYTES
        );
        assert!(bound_code_result(
            json!({ "symbols": [{ "name": "x".repeat(200_000) }], "total": 1, "offset": 0 })
        )
        .is_err());
    }

    #[test]
    fn navigation_page_arguments_are_bounded_and_do_not_wrap() {
        for value in [
            json!({"offset": -1}),
            json!({"offset": "1"}),
            json!({"limit": 0}),
            json!({"limit": 51}),
        ] {
            assert!(CodePage::from_arguments(&value, CapabilityId::CodeReferences).is_err());
        }
        let page =
            CodePage::from_arguments(&json!({"offset": usize::MAX}), CapabilityId::CodeReferences)
                .unwrap();
        assert!(!page.includes(0));
        assert!(page.includes(usize::MAX));
        let (properties, _) = schema(CapabilityId::CodeReferences).unwrap();
        assert_eq!(properties["limit"]["maximum"], 50);
        assert!(properties["offset"].is_object());
    }

    #[test]
    fn file_uris_use_local_file_url_semantics() {
        assert_eq!(
            uri_to_path("file://localhost/tmp/main.rs"),
            Some(PathBuf::from("/tmp/main.rs"))
        );
        assert_eq!(uri_to_path("file://remote.example/tmp/main.rs"), None);
    }
}
