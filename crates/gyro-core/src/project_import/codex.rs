use super::transcript::{self, ParsedConversation, Transcript};
use crate::sessions::SessionEventKind;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

fn message_text(payload: &Value) -> String {
    match payload.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|block| {
                matches!(
                    block.get("type").and_then(Value::as_str),
                    Some("input_text" | "output_text" | "text")
                )
            })
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Modern rollouts store tool results as content blocks. The text blocks may
/// themselves contain a structured exec/MCP response; keep its readable output,
/// status and text content without importing image URLs or base64 data.
fn tool_output(value: &Value, diagnostics: &mut Vec<String>) -> (String, bool) {
    match value {
        Value::String(text) => {
            if let Ok(object @ Value::Object(_)) = serde_json::from_str::<Value>(text) {
                if object.get("exit_code").is_some()
                    || object.get("wall_time_seconds").is_some()
                    || (object.get("isError").is_some() && object.get("content").is_some())
                {
                    return tool_output(&object, diagnostics);
                }
            }
            (text.clone(), false)
        }
        Value::Array(blocks) => {
            let mut texts = Vec::new();
            let mut failed = false;
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("input_text" | "output_text" | "text") => {
                        let (text, block_failed) = tool_output(block.get("text").unwrap_or(&Value::Null), diagnostics);
                        texts.push(text);
                        failed |= block_failed;
                    }
                    Some("input_image" | "image") => diagnostics.push("An embedded or remote historical tool image was omitted; its source remains in Codex".into()),
                    _ => diagnostics.push("An unsupported Codex tool-result block was omitted".into()),
                }
            }
            (texts.join("\n"), failed)
        }
        Value::Object(object) => {
            let failed = object
                .get("exit_code")
                .and_then(Value::as_i64)
                .is_some_and(|code| code != 0)
                || object.get("isError").and_then(Value::as_bool) == Some(true)
                || object.get("is_error").and_then(Value::as_bool) == Some(true);
            let content = object
                .get("output")
                .filter(|_| {
                    object.contains_key("exit_code") || object.contains_key("wall_time_seconds")
                })
                .or_else(|| {
                    object
                        .get("content")
                        .filter(|_| object.contains_key("isError"))
                });
            match content {
                Some(content) => {
                    let (text, nested_failed) = tool_output(content, diagnostics);
                    (text, failed || nested_failed)
                }
                None => (
                    serde_json::to_string_pretty(value).unwrap_or_default(),
                    failed,
                ),
            }
        }
        Value::Null => (String::new(), false),
        _ => (value.to_string(), false),
    }
}

pub(super) fn normalize(source: &Transcript) -> Result<Option<ParsedConversation>> {
    let Some(meta_record) = source
        .records
        .iter()
        .rev()
        .find(|record| record.get("type").and_then(Value::as_str) == Some("session_meta"))
    else {
        return Err(anyhow!(
            "Codex transcript has no supported session metadata"
        ));
    };
    // Forked rollouts can retain the parent's metadata and append the new
    // thread's metadata. The latest native identity is the resumable thread;
    // older records remain its inherited conversation history.
    let meta = meta_record.get("payload").unwrap_or(&Value::Null);
    let source_meta = meta.get("source");
    if source_meta.is_some_and(|value| {
        value
            .as_object()
            .is_some_and(|object| object.contains_key("subagent"))
            || value
                .as_str()
                .is_some_and(|source| source.contains("subagent"))
    }) || meta
        .get("parent_thread_id")
        .is_some_and(|value| !value.is_null())
    {
        return Ok(None);
    }
    let session_id = transcript::text(meta, "id")
        .or_else(|| transcript::text(meta, "session_id"))
        .unwrap_or_default();
    let workspace_path = transcript::text(meta, "cwd").unwrap_or_default();
    let created_at = meta
        .get("timestamp")
        .and_then(transcript::timestamp)
        .or_else(|| meta_record.get("timestamp").and_then(transcript::timestamp))
        .ok_or_else(|| anyhow!("Codex transcript has no supported timestamps"))?;
    let mut updated_at = created_at;
    let mut model_id = transcript::text(meta, "model");
    let mut custom_title =
        transcript::text(meta, "title").or_else(|| transcript::text(meta, "name"));
    let mut events = Vec::new();
    let mut diagnostics = Vec::new();
    transcript::check_format_version(
        "Codex",
        meta.get("cli_version").and_then(Value::as_str),
        &[0],
        &mut diagnostics,
    );
    let mut turn_id = None;
    let mut has_native_turn = false;
    let mut tools = HashMap::new();
    let mut seen_tools = HashSet::new();
    // The event_msg representation duplicates the canonical response_item
    // messages in modern rollouts. Preserve event-only messages in older files.
    let mut response_messages = HashMap::new();
    for record in &source.records {
        if record.get("type").and_then(Value::as_str) != Some("response_item") {
            continue;
        }
        let Some(payload) = record.get("payload") else {
            continue;
        };
        if payload.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let role = payload
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if matches!(role, "user" | "assistant")
            && payload.get("channel").and_then(Value::as_str) != Some("analysis")
        {
            *response_messages
                .entry((role.to_owned(), message_text(payload)))
                .or_insert(0usize) += 1;
        }
    }
    for record in &source.records {
        let at = record
            .get("timestamp")
            .and_then(transcript::timestamp)
            .unwrap_or(updated_at);
        updated_at = updated_at.max(at);
        let record_type = record
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Some(payload) = record.get("payload") else {
            continue;
        };
        if record_type == "turn_context" {
            model_id = transcript::text(payload, "model").or(model_id);
            if let Some(native_turn) =
                transcript::text(payload, "turn_id").and_then(|id| Uuid::parse_str(&id).ok())
            {
                turn_id = Some(native_turn);
                has_native_turn = true;
            }
            continue;
        }
        if record_type == "event_msg" {
            let kind = payload
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if matches!(kind, "task_started" | "turn_started") {
                turn_id =
                    transcript::text(payload, "turn_id").and_then(|id| Uuid::parse_str(&id).ok());
                has_native_turn = turn_id.is_some();
            }
            if matches!(kind, "thread_name_updated" | "session_title") {
                custom_title = transcript::text(payload, "name")
                    .or_else(|| transcript::text(payload, "title"))
                    .or(custom_title);
            }
            let role = match kind {
                "user_message" => "user",
                "agent_message" => "assistant",
                _ => continue,
            };
            let message = transcript::text(payload, "message").unwrap_or_default();
            if let Some(count) = response_messages.get_mut(&(role.to_owned(), message.clone())) {
                if *count > 0 {
                    *count -= 1;
                    continue;
                }
            }
            if !message.trim().is_empty() {
                if role == "user" && !has_native_turn {
                    turn_id = Some(Uuid::new_v4());
                }
                transcript::push_message(
                    &mut events,
                    if role == "user" {
                        SessionEventKind::UserMessage
                    } else {
                        SessionEventKind::AssistantMessage
                    },
                    &message,
                    at,
                    turn_id,
                    if role == "assistant" {
                        json!({"kind":"provider-response", "status":"done"})
                    } else {
                        json!({})
                    },
                    &mut diagnostics,
                );
            }
            continue;
        }
        if record_type != "response_item" {
            continue;
        }
        match payload.get("type").and_then(Value::as_str) {
            Some("message") => {
                let role = payload
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !matches!(role, "user" | "assistant")
                    || payload.get("channel").and_then(Value::as_str) == Some("analysis")
                {
                    continue;
                }
                let message = message_text(payload);
                let mut attachments = Vec::new();
                if let Some(blocks) = payload.get("content").and_then(Value::as_array) {
                    for block in blocks {
                        if block.get("type").and_then(Value::as_str) != Some("input_image") {
                            continue;
                        }
                        let path = block
                            .get("image_url")
                            .or_else(|| block.get("url"))
                            .and_then(Value::as_str)
                            .and_then(|path| url::Url::parse(path).ok())
                            .and_then(|url| url.to_file_path().ok());
                        if let Some(path) = path.filter(|path| path.is_absolute()) {
                            let name = path.file_name().unwrap_or_default().to_string_lossy();
                            attachments.push(transcript::attachment(
                                &name,
                                &path.to_string_lossy(),
                                Some("image/png"),
                                path.is_file(),
                            ));
                        } else {
                            diagnostics.push("An embedded or remote Codex image could not be copied; its source remains in Codex".into());
                        }
                    }
                }
                if message.trim().is_empty() && attachments.is_empty() {
                    continue;
                }
                if role == "user" && !has_native_turn {
                    turn_id = Some(Uuid::new_v4());
                }
                transcript::push_message(
                    &mut events,
                    if role == "user" {
                        SessionEventKind::UserMessage
                    } else {
                        SessionEventKind::AssistantMessage
                    },
                    &message,
                    at,
                    turn_id,
                    if role == "assistant" {
                        json!({"kind":"provider-response", "status":"done", "attachments":attachments})
                    } else {
                        json!({"attachments":attachments})
                    },
                    &mut diagnostics,
                );
            }
            Some("function_call" | "custom_tool_call") => {
                let call_id = transcript::text(payload, "call_id")
                    .or_else(|| transcript::text(payload, "id"))
                    .unwrap_or_else(|| Uuid::new_v4().to_string());
                if !seen_tools.insert(call_id.clone()) {
                    continue;
                }
                let label =
                    transcript::text(payload, "name").unwrap_or_else(|| "Historical tool".into());
                let detail = transcript::text(payload, "arguments")
                    .or_else(|| transcript::text(payload, "input"))
                    .unwrap_or_default();
                tools.insert(call_id.clone(), events.len());
                events.push(transcript::activity(
                    &label,
                    format!(
                        "{}\n[No result recorded in imported history]",
                        transcript::bounded_text(&detail, &mut diagnostics)
                    ),
                    true,
                    at,
                    turn_id,
                    Some(&call_id),
                ));
            }
            Some("function_call_output" | "custom_tool_call_output") => {
                let call_id = transcript::text(payload, "call_id").unwrap_or_default();
                let (output, result_failed) = payload
                    .get("output")
                    .map(|output| tool_output(output, &mut diagnostics))
                    .unwrap_or_default();
                let failed =
                    payload.get("is_error").and_then(Value::as_bool) == Some(true) || result_failed;
                let output = transcript::bounded_text(&output, &mut diagnostics);
                if let Some(index) = tools.get(&call_id).copied() {
                    let event: &mut crate::sessions::SessionEvent = &mut events[index];
                    let input = event
                        .payload
                        .get("detail")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .trim_end_matches("\n[No result recorded in imported history]");
                    event.payload["detail"] = json!(transcript::bounded_text(
                        &format!("{input}\n{output}"),
                        &mut diagnostics
                    ));
                    event.payload["status"] = json!(if failed { "failed" } else { "done" });
                } else {
                    events.push(transcript::activity(
                        "Historical tool result",
                        output,
                        failed,
                        at,
                        turn_id,
                        Some(&call_id),
                    ));
                }
            }
            Some("web_search_call") => {
                let call_id =
                    transcript::text(payload, "id").unwrap_or_else(|| Uuid::new_v4().to_string());
                let detail = payload
                    .get("action")
                    .map(Value::to_string)
                    .unwrap_or_default();
                events.push(transcript::activity(
                    "Web search",
                    transcript::bounded_text(&detail, &mut diagnostics),
                    payload.get("status").and_then(Value::as_str) != Some("completed"),
                    at,
                    turn_id,
                    Some(&call_id),
                ));
            }
            Some("reasoning" | "compaction" | "agent_message") => {}
            Some(_) | None => {
                diagnostics.push("An unsupported Codex response record was omitted".into())
            }
        }
    }
    let title = transcript::title(custom_title, &events);
    transcript::finish(ParsedConversation {
        session_id,
        workspace_path,
        title,
        model_id,
        created_at,
        updated_at,
        events,
        diagnostics,
    })
}
