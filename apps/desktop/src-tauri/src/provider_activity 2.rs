//! Provider activity extraction: a provider frame in, activity rows out.
//!
//! `lib.rs` keeps the shell around this domain: the stream state, the
//! timeline and the emitted events. What lives here is the part that reads a
//! provider value and decides what a person is shown, so the shell keeps
//! delegating instead of growing.

use crate::*;

/// The context window a provider's model exposes, in tokens.
///
/// Providers that report their own window win; this table is what answers for
/// the ones that never do. Without it the composer meter falls back to a single
/// default and measures a 1M-token model against 128K — or the reverse — which
/// makes the remaining-context number wrong in exactly the situation it matters.
///
/// Keep in step with `providerCatalog` in `packages/ui/src/provider-catalog.ts`;
/// `check-workbench-ui` asserts the two agree.
pub(crate) fn extract_provider_commentary_activity(
    value: &serde_json::Value,
) -> Option<ProviderActivity> {
    let text = extract_codex_agent_message_text(value)?;
    // A stray control marker is removed rather than dropping the note: a later
    // turn can repeat the title line above real narration.
    let text = if text.contains("GYRO_") {
        strip_hidden_control_markers(&text)
            .message
            .trim()
            .to_string()
    } else {
        text
    };
    if text.trim().is_empty() {
        return None;
    }
    let item = value.get("item")?;
    let id = item
        .get("id")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| format!("commentary-{}", Uuid::new_v4()));
    Some(ProviderActivity {
        id,
        kind: "commentary".into(),
        label: sanitize_provider_text_delta(&text),
        detail: None,
        file_counts: None,
        note: None,
        status: "done".into(),
    })
}

/// Every work beat this stream frame carries. Claude can pack several
/// `tool_use` blocks into one assistant message; Codex still sends one item.
pub(crate) fn extract_provider_activities(value: &serde_json::Value) -> Vec<ProviderActivity> {
    if let Some(activity) = extract_provider_activity(value) {
        return vec![activity];
    }
    extract_provider_tool_uses_from_message(value)
}

pub(crate) fn extract_provider_activity(value: &serde_json::Value) -> Option<ProviderActivity> {
    let event_type = value
        .get("type")
        .and_then(|item| item.as_str())
        .unwrap_or("");
    let nested_event = value.get("event").unwrap_or(value);
    let nested_type = nested_event
        .get("type")
        .and_then(|item| item.as_str())
        .unwrap_or(event_type);
    let item = value
        .get("item")
        .or_else(|| nested_event.get("item"))
        .or_else(|| nested_event.get("content_block"))?;
    let item_type = item.get("type").and_then(|value| value.as_str())?;
    let id = item
        .get("id")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .or_else(|| {
            nested_event
                .get("index")
                .and_then(|value| value.as_u64())
                .map(|index| format!("{item_type}-{index}"))
        })
        .unwrap_or_else(|| format!("{item_type}-{}", Uuid::new_v4()));
    let status = provider_activity_status(event_type, nested_type, item);

    match item_type {
        "command_execution" | "command" => {
            let command = json_string_or_joined(item.get("command"))?;
            Some(ProviderActivity {
                id,
                kind: "command".into(),
                label: command_activity_label(&command),
                detail: Some(command),
                file_counts: None,
                note: None,
                status: status.into(),
            })
        }
        "file_change" | "file_edit" => {
            let path = provider_activity_path(item).unwrap_or_else(|| "workspace files".into());
            Some(ProviderActivity {
                id,
                kind: "file".into(),
                label: format!("Updated {path}"),
                detail: Some(path),
                file_counts: None,
                note: None,
                status: status.into(),
            })
        }
        "mcp_tool_call" | "tool_use" | "tool_call" => {
            let name = item
                .get("name")
                .or_else(|| item.get("tool"))
                .and_then(|value| value.as_str())
                .unwrap_or("tool");
            let input = item.get("input").or_else(|| item.get("arguments"));
            Some(tool_use_activity(id, name, input, status))
        }
        "web_search" | "web_search_call" => {
            let query = item
                .get("query")
                .and_then(|value| value.as_str())
                .map(str::to_string);
            Some(ProviderActivity {
                id,
                kind: "search".into(),
                label: "Searched the web".into(),
                detail: query,
                file_counts: None,
                note: None,
                status: status.into(),
            })
        }
        "context_compaction" | "contextCompaction" | "compaction" => Some(ProviderActivity {
            id,
            kind: "context".into(),
            label: if status == "running" {
                "Compacting context".into()
            } else {
                "Compacted context".into()
            },
            detail: Some(
                "Summarized earlier conversation to keep the thread within the model context window."
                    .into(),
            ),
            file_counts: None,
            note: None,
            status: status.into(),
        }),
        _ => None,
    }
}

/// Claude Code (and Anthropic-shaped streams) finish a tool with the full
/// `input` on the assistant message. `content_block_start` often only has the
/// name, so the completed message is what fills in the note / reclassifies
/// Bash → command.
pub(crate) fn extract_provider_tool_uses_from_message(
    value: &serde_json::Value,
) -> Vec<ProviderActivity> {
    let message = value
        .get("message")
        .or_else(|| value.pointer("/event/message"))
        .unwrap_or(value);
    let content = message
        .get("content")
        .and_then(|value| value.as_array())
        .or_else(|| value.get("content").and_then(|value| value.as_array()));
    let Some(content) = content else {
        return Vec::new();
    };
    let event_type = value
        .get("type")
        .and_then(|item| item.as_str())
        .unwrap_or("");
    content
        .iter()
        .filter_map(|block| {
            let block_type = block.get("type").and_then(|value| value.as_str())?;
            if block_type != "tool_use"
                && block_type != "tool_call"
                && block_type != "mcp_tool_call"
            {
                return None;
            }
            let name = block
                .get("name")
                .or_else(|| block.get("tool"))
                .and_then(|value| value.as_str())
                .unwrap_or("tool");
            let id = block
                .get("id")
                .and_then(|value| value.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| format!("{block_type}-{}", Uuid::new_v4()));
            let input = block.get("input").or_else(|| block.get("arguments"));
            let status = provider_activity_status(event_type, event_type, block);
            Some(tool_use_activity(id, name, input, status))
        })
        .collect()
}

/// Measured counts from a Claude `user` frame's tool results, by tool id.
///
/// Claude Code reports the hunks each file tool applied alongside its result
/// (`tool_use_result`; `toolUseResult` in transcripts). That record exists
/// whether Gyro's broker approved the write or the CLI applied it directly,
/// so it is what makes counts independent of permission mode. A frame carries
/// one record, so it is only attributed when the frame has one tool result.
pub(crate) fn provider_file_result_counts(
    value: &serde_json::Value,
) -> Vec<(String, (usize, usize))> {
    let Some(result) = value
        .get("tool_use_result")
        .or_else(|| value.get("toolUseResult"))
        .filter(|result| result.get("filePath").is_some())
    else {
        return Vec::new();
    };
    let Some(counts) = file_patch_counts::from_claude_tool_result(result) else {
        return Vec::new();
    };
    let tool_results = value
        .pointer("/message/content")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter(|block| {
            block.get("type").and_then(serde_json::Value::as_str) == Some("tool_result")
        })
        .collect::<Vec<_>>();
    match tool_results.as_slice() {
        [block] if block.get("is_error").and_then(serde_json::Value::as_bool) != Some(true) => {
            block
                .get("tool_use_id")
                .and_then(serde_json::Value::as_str)
                .map(|id| vec![(id.to_string(), counts)])
                .unwrap_or_default()
        }
        _ => Vec::new(),
    }
}

pub(crate) fn provider_activity_status(
    event_type: &str,
    nested_type: &str,
    item: &serde_json::Value,
) -> &'static str {
    if event_type.contains("started")
        || nested_type.contains("start")
        || item.get("status").and_then(|value| value.as_str()) == Some("in_progress")
    {
        "running"
    } else if event_type.contains("failed")
        || nested_type.contains("error")
        || item.get("status").and_then(|value| value.as_str()) == Some("failed")
    {
        "failed"
    } else {
        "done"
    }
}

/// Map a provider tool call onto the rail kind that already has wording, and
/// keep a free-form `note` when the primary field is only a machine id.
pub(crate) fn tool_use_activity(
    id: String,
    name: &str,
    input: Option<&serde_json::Value>,
    status: &str,
) -> ProviderActivity {
    let input = input.unwrap_or(&serde_json::Value::Null);
    let note = provider_tool_activity_note(name, input);

    // Well-known Claude Code tools carry enough structure to reclassify so the
    // rail can say "Ran command · pnpm test" instead of "Bash" three times.
    match name {
        "Bash" | "KillShell" => {
            if let Some(command) = json_object_string(input, &["command"]) {
                let description =
                    json_object_string(input, &["description"]).filter(|value| value != &command);
                return ProviderActivity {
                    id,
                    kind: "command".into(),
                    label: command_activity_label(&command),
                    detail: Some(command),
                    file_counts: None,
                    note: description,
                    status: status.into(),
                };
            }
        }
        "Read" | "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => {
            if let Some(path) = json_object_string(
                input,
                &[
                    "file_path",
                    "filePath",
                    "path",
                    "notebook_path",
                    "notebookPath",
                ],
            ) {
                // A read is not a change. Keeping it out of the `file` bucket is
                // what stops the rail saying "Edited file" over a path nothing
                // wrote to, and keeps reads out of the turn's changed-file set.
                if name == "Read" {
                    let file_name = Path::new(&path)
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or(&path);
                    return ProviderActivity {
                        id,
                        kind: "read".into(),
                        label: format!("Read {file_name}"),
                        detail: Some(path),
                        file_counts: None,
                        note: None,
                        status: status.into(),
                    };
                }
                return ProviderActivity {
                    id,
                    kind: "file".into(),
                    label: format!("Updated {path}"),
                    detail: Some(path),
                    // Provisional: the tool result replaces this with the hunks
                    // actually applied (see `provider_file_result_counts`).
                    file_counts: file_patch_counts::from_claude_edit_input(name, input),
                    note: None,
                    status: status.into(),
                };
            }
        }
        "Grep" | "Glob" => {
            if let Some(query) =
                json_object_string(input, &["pattern", "glob", "glob_pattern", "query"])
            {
                return ProviderActivity {
                    id,
                    kind: "search".into(),
                    label: "Searched project".into(),
                    detail: Some(query),
                    file_counts: None,
                    note: json_object_string(input, &["path", "file_path", "filePath"]),
                    status: status.into(),
                };
            }
        }
        "WebSearch" | "WebFetch" => {
            if let Some(query) = json_object_string(input, &["query", "url"]) {
                return ProviderActivity {
                    id,
                    kind: "search".into(),
                    label: "Searched the web".into(),
                    detail: Some(query),
                    file_counts: None,
                    note: None,
                    status: status.into(),
                };
            }
        }
        _ => {}
    }

    ProviderActivity {
        id,
        kind: "tool".into(),
        label: format!("Used {}", humanize_activity_name(name)),
        detail: Some(name.to_string()),
        file_counts: None,
        note,
        status: status.into(),
    }
}
