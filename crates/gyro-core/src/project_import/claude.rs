use super::transcript::{self, ParsedConversation, Transcript};
use crate::sessions::SessionEventKind;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use uuid::Uuid;

pub(super) fn normalize(source: &Transcript) -> Result<Option<ParsedConversation>> {
    let main = source
        .records
        .iter()
        .filter(|record| record.get("isSidechain").and_then(Value::as_bool) != Some(true))
        .collect::<Vec<_>>();
    let identities = main
        .iter()
        .filter_map(|record| transcript::text(record, "uuid").map(|id| (id, *record)))
        .collect::<HashMap<_, _>>();
    // Last-prompt and summary records identify the currently selected branch.
    // Falling back to the final main-chain node handles older transcript formats.
    let marked_leaf = main.iter().enumerate().rev().find_map(|(index, record)| {
        transcript::text(record, "leafUuid")
            .filter(|id| identities.contains_key(id))
            .map(|id| (index, id))
    });
    let latest_node = main
        .iter()
        .enumerate()
        .rev()
        .find_map(|(index, record)| transcript::text(record, "uuid").map(|id| (index, id)));
    let leaf = match (marked_leaf, latest_node) {
        (Some(marked), Some(latest)) => Some(if marked.0 >= latest.0 {
            marked.1
        } else {
            latest.1
        }),
        (Some(marked), None) => Some(marked.1),
        (None, Some(latest)) => Some(latest.1),
        (None, None) => None,
    };
    let mut selected = HashSet::new();
    let mut cursor = leaf;
    while let Some(id) = cursor {
        if !selected.insert(id.clone()) {
            break;
        }
        cursor = identities.get(&id).and_then(|record| {
            transcript::text(record, "parentUuid").or_else(|| {
                // Compaction resets the executable context's parent but
                // retains the conversation ancestry in a logical parent.
                (record.get("type").and_then(Value::as_str) == Some("system")
                    && record.get("subtype").and_then(Value::as_str) == Some("compact_boundary"))
                .then(|| transcript::text(record, "logicalParentUuid"))
                .flatten()
            })
        });
    }
    let selected_records = main
        .iter()
        .copied()
        .filter(|record| match transcript::text(record, "uuid") {
            Some(id) if !selected.is_empty() => {
                selected.contains(&id)
                    && identities
                        .get(&id)
                        .is_some_and(|latest| std::ptr::eq(*latest, *record))
            }
            _ => true,
        })
        .collect::<Vec<_>>();
    let message_records = selected_records
        .iter()
        .filter(|record| {
            matches!(
                record.get("type").and_then(Value::as_str),
                Some("user" | "assistant")
            )
        })
        .copied()
        .collect::<Vec<_>>();
    if message_records.is_empty() {
        return Ok(None);
    }
    let Some(session_id) = message_records
        .iter()
        .find_map(|record| transcript::text(record, "sessionId"))
    else {
        return Err(anyhow!("Claude transcript has no session identity"));
    };
    let workspace_path = message_records
        .iter()
        .find_map(|record| transcript::text(record, "cwd"))
        .unwrap_or_default();
    let first_at = message_records
        .iter()
        .find_map(|record| record.get("timestamp").and_then(transcript::timestamp))
        .ok_or_else(|| anyhow!("Claude transcript has no supported timestamps"))?;
    let mut latest_at = first_at;
    let mut events = Vec::new();
    let mut diagnostics = Vec::new();
    transcript::check_format_version(
        "Claude Code",
        message_records
            .iter()
            .rev()
            .find_map(|record| record.get("version").and_then(Value::as_str)),
        &[1, 2],
        &mut diagnostics,
    );
    let mut model_id = None;
    let mut turn_id = None;
    let mut tools: HashMap<String, usize> = HashMap::new();
    let mut seen_messages = HashSet::new();
    let mut custom_title = None;
    let mut generated_title = None;
    for record in &main {
        match record.get("type").and_then(Value::as_str) {
            Some("custom-title") => {
                custom_title = transcript::text(record, "customTitle").or(custom_title)
            }
            Some("ai-title") => {
                generated_title = transcript::text(record, "aiTitle").or(generated_title)
            }
            Some("summary") => {
                generated_title = transcript::text(record, "summary").or(generated_title)
            }
            _ => {}
        }
    }
    for record in selected_records {
        let at = record
            .get("timestamp")
            .and_then(transcript::timestamp)
            .unwrap_or(latest_at);
        latest_at = latest_at.max(at);
        let role = record
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !matches!(role, "user" | "assistant") {
            continue;
        }
        if transcript::text(record, "sessionId").is_some_and(|id| id != session_id) {
            diagnostics.push("A record belonging to another session was omitted".into());
            continue;
        }
        if record.get("isMeta").and_then(Value::as_bool) == Some(true)
            || record.get("isCompactSummary").and_then(Value::as_bool) == Some(true)
        {
            continue;
        }
        let Some(message) = record.get("message") else {
            diagnostics.push("An unsupported Claude message record was omitted".into());
            continue;
        };
        if role == "assistant" {
            model_id = transcript::text(message, "model").or(model_id);
        }
        let content = message.get("content").unwrap_or(&Value::Null);
        let blocks = match content {
            Value::String(text) => vec![json!({"type":"text", "text":text})],
            Value::Array(blocks) => blocks.clone(),
            _ => {
                diagnostics.push("A Claude message used an unsupported content format".into());
                continue;
            }
        };
        let text = blocks
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
        let attachments = blocks.iter().filter_map(|block| match block.get("type").and_then(Value::as_str) {
            Some("image" | "document") => {
                let source = block.get("source")?;
                let path = source.get("path").or_else(|| source.get("file_path")).and_then(Value::as_str);
                if let Some(path) = path.filter(|path| Path::new(path).is_absolute()) {
                    let name = Path::new(path).file_name().unwrap_or_default().to_string_lossy();
                    Some(transcript::attachment(&name, path, source.get("media_type").and_then(Value::as_str), Path::new(path).is_file()))
                } else {
                    diagnostics.push("An embedded or remote Claude attachment could not be copied; its source remains in Claude Code".into());
                    None
                }
            }
            _ => None,
        }).collect::<Vec<_>>();
        if !text.trim().is_empty() || !attachments.is_empty() {
            let message_id = transcript::text(message, "id")
                .or_else(|| transcript::text(record, "uuid"))
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            if seen_messages.insert((message_id, role.to_owned(), text.clone())) {
                if role == "user" {
                    turn_id = transcript::text(record, "promptId")
                        .and_then(|id| Uuid::parse_str(&id).ok())
                        .or_else(|| {
                            transcript::text(record, "uuid")
                                .and_then(|id| Uuid::parse_str(&id).ok())
                        })
                        .or_else(|| Some(Uuid::new_v4()));
                }
                transcript::push_message(
                    &mut events,
                    if role == "user" {
                        SessionEventKind::UserMessage
                    } else {
                        SessionEventKind::AssistantMessage
                    },
                    &text,
                    at,
                    turn_id,
                    if role == "user" {
                        json!({"attachments":attachments})
                    } else {
                        json!({"kind":"provider-response", "status":"done", "attachments":attachments})
                    },
                    &mut diagnostics,
                );
            }
        }
        for block in blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("tool_use") if role == "assistant" => {
                    let call_id = transcript::text(&block, "id")
                        .unwrap_or_else(|| Uuid::new_v4().to_string());
                    if tools.contains_key(&call_id) {
                        continue;
                    }
                    let label = transcript::text(&block, "name")
                        .unwrap_or_else(|| "Historical tool".into());
                    let detail = block.get("input").map(Value::to_string).unwrap_or_default();
                    let detail = transcript::bounded_text(&detail, &mut diagnostics);
                    tools.insert(call_id.clone(), events.len());
                    events.push(transcript::activity(
                        &label,
                        format!("{detail}\n[No result recorded in imported history]"),
                        true,
                        at,
                        turn_id,
                        Some(&call_id),
                    ));
                }
                Some("tool_result") if role == "user" => {
                    let call_id = transcript::text(&block, "tool_use_id").unwrap_or_default();
                    let result = match block.get("content") {
                        Some(Value::String(text)) => text.clone(),
                        Some(Value::Array(blocks)) => blocks
                            .iter()
                            .filter_map(|block| block.get("text").and_then(Value::as_str))
                            .collect::<Vec<_>>()
                            .join("\n"),
                        _ => String::new(),
                    };
                    let result = transcript::bounded_text(&result, &mut diagnostics);
                    let failed = block.get("is_error").and_then(Value::as_bool) == Some(true);
                    if let Some(index) = tools.get(&call_id).copied() {
                        let event = &mut events[index];
                        let input = event
                            .payload
                            .get("detail")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .trim_end_matches("\n[No result recorded in imported history]");
                        event.payload["detail"] = json!(transcript::bounded_text(
                            &format!("{input}\n{result}"),
                            &mut diagnostics
                        ));
                        event.payload["status"] = json!(if failed { "failed" } else { "done" });
                    } else {
                        events.push(transcript::activity(
                            "Historical tool result",
                            result,
                            failed,
                            at,
                            turn_id,
                            Some(&call_id),
                        ));
                    }
                }
                Some(
                    "text" | "thinking" | "redacted_thinking" | "image" | "document" | "tool_use"
                    | "tool_result",
                ) => {}
                Some(_) | None => {
                    diagnostics.push("An unsupported Claude content block was omitted".into())
                }
            }
        }
    }
    let title = transcript::title(custom_title.or(generated_title), &events);
    transcript::finish(ParsedConversation {
        session_id,
        workspace_path,
        title,
        model_id,
        created_at: first_at,
        updated_at: latest_at,
        events,
        diagnostics,
    })
}
