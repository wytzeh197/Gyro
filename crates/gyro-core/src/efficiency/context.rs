use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attribution {
    pub instructions: u64,
    pub tool_schemas: u64,
    pub source_excerpts: u64,
    pub tool_results: u64,
    pub task_state: u64,
    pub history: u64,
    pub other_text: u64,
    pub estimated_tokens: u64,
    pub hidden_content: bool,
    /// Bytes withheld from this request by context retirement, so the saving is measurable.
    #[serde(default)]
    pub retired_bytes: u64,
}
impl Attribution {
    pub fn from_request(payload: &Value) -> Self {
        let mut a = Self::default();
        a.tool_schemas = payload.get("tools").map_or(0, |v| {
            serde_json::to_string(v).unwrap_or_default().chars().count() as u64
        });
        if let Some(messages) = payload.get("messages").and_then(Value::as_array) {
            for message in messages {
                let role = message["role"].as_str().unwrap_or_default();
                let content = &message["content"];
                let text = if let Some(s) = content.as_str() {
                    s.to_owned()
                } else if let Some(parts) = content.as_array() {
                    let mut strings = Vec::new();
                    for part in parts {
                        if let Some(t) = part.get("text").and_then(Value::as_str) {
                            strings.push(t);
                        } else {
                            a.hidden_content = true;
                        }
                    }
                    strings.join("\n")
                } else {
                    String::new()
                };
                if message
                    .get("images")
                    .and_then(Value::as_array)
                    .is_some_and(|x| !x.is_empty())
                {
                    a.hidden_content = true;
                }
                let n = text.chars().count() as u64;
                match role {
                    "system" | "developer" => a.instructions += n,
                    "tool" => {
                        let source = serde_json::from_str::<Value>(&text)
                            .ok()
                            .and_then(|v| {
                                v.pointer("/result/capabilityId")
                                    .and_then(Value::as_str)
                                    .map(str::to_owned)
                            })
                            .is_some_and(|id| {
                                matches!(
                                    id.as_str(),
                                    "workspace-read"
                                        | "workspace-read-range"
                                        | "workspace-read-editor"
                                )
                            });
                        if source {
                            a.source_excerpts += n;
                        } else {
                            a.tool_results += n;
                        }
                    }
                    "assistant" => a.history += n,
                    _ => {
                        // Only typed Gyro blocks carry a reliable category. Do not classify arbitrary source by keywords.
                        match message.get("gyroCategory").and_then(Value::as_str) {
                            Some("source") => a.source_excerpts += n,
                            Some("task-state") => a.task_state += n,
                            Some("history") => a.history += n,
                            _ => a.other_text += n,
                        }
                    }
                }
            }
        }
        a.estimated_tokens = (a.instructions
            + a.tool_schemas
            + a.source_excerpts
            + a.tool_results
            + a.task_state
            + a.history
            + a.other_text)
            .div_ceil(4);
        a
    }
    pub fn combine(&mut self, other: &Self) {
        self.instructions += other.instructions;
        self.tool_schemas += other.tool_schemas;
        self.source_excerpts += other.source_excerpts;
        self.tool_results += other.tool_results;
        self.task_state += other.task_state;
        self.history += other.history;
        self.other_text += other.other_text;
        self.estimated_tokens += other.estimated_tokens;
        self.hidden_content |= other.hidden_content;
    }
}
/// Sort definitions without changing messages or removing constraints. Wire payloads contain no private annotations.
pub fn stable_tools(tools: &mut [Value]) {
    tools.sort_by_key(|v| {
        v.pointer("/function/name")
            .or_else(|| v.get("name"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    });
}

/// Replace earlier copies of large, identical disk-read evidence with a
/// reference to the newest copy still present in this request. Every read
/// really ran; tool-call order, results with changed hashes, and side effects
/// remain intact. Persisted history is untouched.
pub fn compact_duplicate_reads(messages: &mut [Value]) -> usize {
    use sha2::{Digest, Sha256};
    use std::collections::HashMap;
    let mut latest = HashMap::<[u8; 32], String>::new();
    let mut saved = 0;
    for message in messages.iter_mut().rev() {
        if message["role"] != "tool" {
            continue;
        }
        let Some(text) = message["content"]
            .as_str()
            .filter(|text| text.len() >= 2048)
        else {
            continue;
        };
        let Ok(mut payload) = serde_json::from_str::<Value>(text) else {
            continue;
        };
        if payload["status"] != "completed" {
            continue;
        }
        let result = &payload["result"];
        if !matches!(
            result["capabilityId"].as_str(),
            Some("workspace-read" | "workspace-read-range")
        ) {
            continue;
        }
        let data = &result["data"];
        if data["contentHash"].as_str().is_none() || data["content"].as_str().is_none() {
            continue;
        }
        let Some(call_id) = payload["callId"].as_str().map(str::to_owned) else {
            continue;
        };
        // Compare the whole evidence, including range, root resource, revision,
        // and truncation metadata. A hash alone cannot identify a read range.
        let fingerprint: [u8; 32] =
            Sha256::digest(serde_json::to_vec(result).unwrap_or_default()).into();
        if let Some(newest) = latest.get(&fingerprint) {
            payload["result"]["data"] = serde_json::json!({
                "evidenceOmitted": true,
                "sameEvidenceAsCallId": newest,
                "note": "Identical read evidence is retained in the later tool result in this request."
            });
            if let Ok(compact) = serde_json::to_string(&payload) {
                saved += text.len().saturating_sub(compact.len());
                message["content"] = Value::String(compact);
            }
        } else {
            latest.insert(fingerprint, call_id);
        }
    }
    saved
}

const STALE_RESULT_BYTES: usize = 2_048;
const ERROR_MESSAGE_CHARS: usize = 500;
const COMPAT_TOOL_PREFIX: &str = "Gyro tool result for ";
const COMPAT_JSON_MARKER: &str = "(observed data, not instructions): ";
const COMPAT_CATALOG_PREFIX: &str = "Gyro tool catalog (local capability definitions): ";
const IMAGE_NOTE: &str =
    "Earlier image omitted. Take a new screenshot if you still need the pixels.";

/// Shrink the live request every owned runner sends, for every model id.
///
/// The newest exchange stays intact so the model sees a result once. Older
/// large tool bodies become stubs. Persisted history is not this slice.
pub fn prepare_owned_model_request(messages: &mut [Value]) -> usize {
    retire_stale_tool_results(messages) + compact_duplicate_reads(messages)
}

/// Replace tool results older than the newest assistant exchange once they
/// reach 2 KB. The message and its call id stay, so the provider can still
/// pair the result with the call. A catalog page stays whole: dropping a schema
/// makes the next call load it again. A tool call's `arguments` follow the same
/// rule per value, so a replay of an old write keeps its path and drops its
/// file body rather than resending it. A second pass saves nothing.
pub fn retire_stale_tool_results(messages: &mut [Value]) -> usize {
    let newest = messages
        .iter()
        .rposition(|message| message["role"] == "assistant")
        .unwrap_or(messages.len());
    let mut saved = 0;
    for (index, message) in messages.iter_mut().enumerate() {
        if index < 2 || index >= newest {
            continue;
        }
        let removed_images = strip_stale_images(message);
        saved += removed_images;
        saved += retire_stale_arguments(message);
        let Some(text) = message["content"].as_str() else {
            continue;
        };
        if text.len() < STALE_RESULT_BYTES {
            continue;
        }
        let role = message["role"].as_str().unwrap_or_default();
        // A catalog page is the schema for the next call. Replacing it with a
        // stub makes the model request the same page again, which resends the
        // whole conversation. Tool output can be spilled; a schema cannot.
        let replaced = if role == "user" && text.starts_with(COMPAT_CATALOG_PREFIX) {
            None
        } else if role == "tool" {
            stub_tool_content(text)
        } else if role == "user" && text.starts_with(COMPAT_TOOL_PREFIX) {
            stub_compat_content(text)
        } else {
            None
        };
        if let Some(mut next) = replaced.filter(|next| next.len() < text.len()) {
            if removed_images > 0 && !next.contains(IMAGE_NOTE) {
                next.push(' ');
                next.push_str(IMAGE_NOTE);
            }
            if next.len() < text.len() {
                saved += text.len() - next.len();
                message["content"] = Value::String(next);
            }
        }
    }
    saved
}

/// Old `tool_calls` keep their identity and their small fields but lose the bulk
/// of their payload. A write tool's `arguments` is the entire file; nothing in
/// the transcript needs it again once the call has run, because the result and
/// the file on disk carry the outcome. Pruning only oversized *values* keeps the
/// JSON shape valid, so a provider that re-validates the call still accepts it.
const STALE_ARGUMENT_BYTES: usize = 512;
const ARGUMENT_KEEP_BYTES: usize = 200;
const RETIRED_ARGUMENTS: &str =
    "{\"retired\":\"arguments omitted from replay; the call already ran\"}";
fn prune_arguments(value: &mut Value) -> usize {
    match value {
        Value::String(text) => {
            if text.len() <= ARGUMENT_KEEP_BYTES {
                return 0;
            }
            let len = text.len();
            let marker = format!("[retired: {len} bytes dropped]");
            let saved = len - marker.len();
            *text = marker;
            saved
        }
        Value::Array(items) => items.iter_mut().map(prune_arguments).sum(),
        Value::Object(map) => map.values_mut().map(prune_arguments).sum(),
        _ => 0,
    }
}
fn retire_stale_arguments(message: &mut Value) -> usize {
    let Some(calls) = message.get_mut("tool_calls").and_then(Value::as_array_mut) else {
        return 0;
    };
    let mut saved = 0;
    for call in calls {
        let Some(arguments) = call.get_mut("function").and_then(|f| f.get_mut("arguments")) else {
            continue;
        };
        match arguments {
            Value::String(text) => match serde_json::from_str::<Value>(text) {
                Ok(mut parsed) if parsed.is_object() => {
                    if prune_arguments(&mut parsed) == 0 {
                        continue;
                    }
                    let next = parsed.to_string();
                    if next.len() < text.len() {
                        saved += text.len() - next.len();
                        *arguments = Value::String(next);
                    }
                }
                _ => {
                    if text.len() <= STALE_ARGUMENT_BYTES {
                        continue;
                    }
                    saved += text.len() - RETIRED_ARGUMENTS.len();
                    *arguments = Value::String(RETIRED_ARGUMENTS.to_string());
                }
            },
            Value::Object(_) => {
                let before = arguments.to_string().len();
                if prune_arguments(arguments) > 0 {
                    let after = arguments.to_string().len();
                    saved += before.saturating_sub(after);
                }
            }
            _ => continue,
        }
    }
    saved
}
fn is_image_part(part: &Value) -> bool {
    matches!(
        part.get("type").and_then(Value::as_str),
        Some("image_url" | "image")
    ) || part.get("image_url").is_some()
}

/// Drop pixels the model has already been shown. The caption stays. The field
/// is removed rather than filled with a placeholder, because Ollama treats
/// `images` entries as base64.
fn strip_stale_images(message: &mut Value) -> usize {
    let mut saved = 0;
    if message
        .get("images")
        .and_then(Value::as_array)
        .is_some_and(|images| !images.is_empty())
    {
        if let Some(images) = message.get("images").cloned() {
            saved += serde_json::to_string(&images)
                .map(|text| text.len())
                .unwrap_or(0);
        }
        message
            .as_object_mut()
            .map(|object| object.remove("images"));
        append_image_note(message);
    }
    let Some(parts) = message.get("content").and_then(Value::as_array).cloned() else {
        return saved;
    };
    let mut kept = Vec::new();
    let mut removed = 0;
    for part in parts {
        if is_image_part(&part) {
            removed += serde_json::to_string(&part)
                .map(|text| text.len())
                .unwrap_or(0);
        } else {
            kept.push(part);
        }
    }
    if removed > 0 {
        kept.push(serde_json::json!({"type": "text", "text": IMAGE_NOTE}));
        message["content"] = Value::Array(kept);
        saved += removed;
    }
    saved
}

fn append_image_note(message: &mut Value) {
    if let Some(text) = message.get("content").and_then(Value::as_str) {
        if text.contains(IMAGE_NOTE) {
            return;
        }
        let next = format!("{text} {IMAGE_NOTE}");
        message["content"] = Value::String(next);
    }
}

fn stub_tool_content(text: &str) -> Option<String> {
    let mut payload: Value = serde_json::from_str(text).ok()?;
    if payload
        .pointer("/result/capabilityId")
        .and_then(Value::as_str)
        == Some("tool-catalog")
    {
        return None;
    }
    apply_stub(&mut payload)?;
    serde_json::to_string(&payload).ok()
}

fn stub_compat_content(text: &str) -> Option<String> {
    let json_at = text.find(COMPAT_JSON_MARKER)? + COMPAT_JSON_MARKER.len();
    let (prefix, json) = text.split_at(json_at);
    let mut payload: Value = serde_json::from_str(json.trim()).ok()?;
    apply_stub(&mut payload)?;
    Some(format!("{prefix}{}", serde_json::to_string(&payload).ok()?))
}

fn already_omitted(payload: &Value) -> bool {
    payload.get("evidenceOmitted").is_some()
        || payload.pointer("/result/data/evidenceOmitted").is_some()
        || payload
            .pointer("/result/data/sameEvidenceAsCallId")
            .is_some()
}

fn apply_stub(payload: &mut Value) -> Option<()> {
    if already_omitted(payload) || payload.get("result").is_none() {
        return None;
    }
    let capability = payload
        .pointer("/result/capabilityId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let data = payload
        .pointer("/result/data")
        .cloned()
        .unwrap_or(Value::Null);
    payload["result"]["data"] = slim_data(&data, &capability);
    cap_text_field(payload, "/result/summary");
    cap_error_message(payload);
    Some(())
}

fn slim_data(data: &Value, capability: &str) -> Value {
    let mut kept = serde_json::Map::new();
    let mut spilled_address = None;
    if let Some(object) = data.as_object() {
        for key in [
            "path",
            "contentHash",
            "line",
            "endLine",
            "startLine",
            "column",
            "endColumn",
            "nextLine",
            "nextColumn",
            "truncated",
            "unchanged",
            "exitCode",
            "id",
            "outputId",
            "rootId",
        ] {
            if let Some(value) = object.get(key).filter(|value| !value.is_null()) {
                if value.as_str().is_none_or(|text| text.len() <= 200) {
                    kept.insert(key.to_string(), value.clone());
                }
            }
        }
        for (key, value) in object {
            if key == "window" || key.ends_with("Window") {
                if let Some(slim) = slim_window(value) {
                    kept.insert(key.clone(), slim);
                }
            }
        }
        // Spill instead of retire: keep a head/tail preview plus an addressable full copy, so a
        // retired payload never costs a second full read to recover.
        let label = if capability.is_empty() {
            "tool"
        } else {
            capability
        };
        for key in ["content", "stdout", "stderr", "output", "text"] {
            let Some(text) = object.get(key).and_then(Value::as_str) else {
                continue;
            };
            let preview = super::spill::preview(label, key, text);
            if !preview.spilled() {
                continue;
            }
            let elided = preview.elided_bytes();
            // The address in the preview is a promise until the copy is actually on disk, so this
            // runs before the address is handed to the model as a place to re-read from.
            super::spill::persist(&preview.address, text);
            kept.insert(key.to_owned(), Value::String(preview.text));
            kept.insert("elidedBytes".into(), Value::Number(elided.into()));
            kept.insert("spill".into(), Value::String(preview.address.clone()));
            spilled_address = Some(preview.address);
            break;
        }
    }
    // Point at the spill copy. Telling the model to call the original tool
    // again sends the same bytes back into the next request.
    let note = if let Some(address) = spilled_address {
        kept.insert(
            "retrievalHint".into(),
            Value::String(format!(
                "Read {address} with gyro_workspace_read and offset for the next window of this same copy. Repeat the original call only for a newer observation."
            )),
        );
        "Same copy is at the spill address. Pass it to gyro_workspace_read with offset. Repeat the original call only for a newer observation."
    } else if matches!(capability, "workspace-read" | "workspace-read-range") {
        "Re-read with gyro_workspace_read_range if you still need this text."
    } else {
        "Call the same tool again with the same arguments if you still need this output."
    };
    kept.insert("evidenceOmitted".into(), Value::Bool(true));
    kept.insert("note".into(), Value::String(note.to_owned()));
    Value::Object(kept)
}

fn slim_window(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let mut slim = serde_json::Map::new();
    for key in [
        "offset",
        "returnedChars",
        "nextOffset",
        "previousOffset",
        "totalChars",
        "truncated",
    ] {
        if let Some(field) = object.get(key) {
            slim.insert((*key).to_string(), field.clone());
        }
    }
    (!slim.is_empty()).then_some(Value::Object(slim))
}

fn cap_error_message(payload: &mut Value) {
    cap_text_field(payload, "/error/message");
}

fn cap_text_field(payload: &mut Value, pointer: &str) {
    let Some(message) = payload
        .pointer(pointer)
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return;
    };
    let mut chars = message.chars();
    let capped: String = chars.by_ref().take(ERROR_MESSAGE_CHARS).collect();
    if chars.next().is_some() {
        let Some(slot) = payload.pointer_mut(pointer) else {
            return;
        };
        *slot = Value::String(format!("{capped}…"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn read_message(call: &str, hash: &str, line: u64, content: &str) -> Value {
        serde_json::json!({"role":"tool","tool_call_id":call,"content":serde_json::json!({
            "status":"completed","callId":call,"result":{"capabilityId":"workspace-read-range",
            "summary":"Read src/a.rs","resource":{"id":"workspace:chat:src/a.rs"},
            "data":{"path":"src/a.rs","contentHash":hash,"line":line,"content":content}}
        }).to_string()})
    }
    #[test]
    fn duplicate_reads_keep_newest_evidence_and_protocol_ids() {
        let text = "source evidence ".repeat(1000);
        let first = read_message("first", "hash", 1, &text);
        let newest = read_message("last", "hash", 1, &text);
        let mut messages = vec![
            first,
            serde_json::json!({"role":"assistant","content":"continue"}),
            newest.clone(),
        ];
        let saved = compact_duplicate_reads(&mut messages);
        assert!(saved > 14_000);
        assert_eq!(messages[2], newest);
        assert_eq!(messages[0]["tool_call_id"], "first");
        let reference: Value =
            serde_json::from_str(messages[0]["content"].as_str().unwrap()).unwrap();
        assert_eq!(reference["callId"], "first");
        assert_eq!(reference["result"]["data"]["sameEvidenceAsCallId"], "last");
        assert_eq!(compact_duplicate_reads(&mut messages), 0);
    }
    #[test]
    fn changed_reads_ranges_failures_and_actions_are_never_compacted() {
        let text = "source evidence ".repeat(1000);
        let mut messages = vec![
            read_message("a", "before", 1, &text),
            read_message("b", "after", 1, &text),
            read_message("c", "after", 2, &text),
            serde_json::json!({"role":"user","content":text}),
        ];
        for capability in [
            "workspace-edit",
            "browser-read-page",
            "workspace-read-editor",
        ] {
            let mut message = read_message(capability, "after", 1, &text);
            let mut payload: Value =
                serde_json::from_str(message["content"].as_str().unwrap()).unwrap();
            payload["result"]["capabilityId"] = Value::String(capability.into());
            message["content"] = Value::String(payload.to_string());
            messages.extend([message.clone(), message]);
        }
        let before = messages.clone();
        assert_eq!(compact_duplicate_reads(&mut messages), 0);
        assert_eq!(messages, before);
    }

    fn tool_body(call: &str, capability: &str, summary: &str, data: Value) -> Value {
        serde_json::json!({"role":"tool","tool_call_id":call,"content":serde_json::json!({
            "status":"completed","callId":call,"result":{
                "capabilityId":capability,"summary":summary,"data":data
            }
        }).to_string()})
    }

    fn parsed(message: &Value) -> Value {
        serde_json::from_str(message["content"].as_str().unwrap()).unwrap()
    }

    #[test]
    fn stale_results_keep_the_newest_exchange_and_are_idempotent() {
        let read = tool_body(
            "read-1",
            "workspace-read-range",
            "Read src/a.rs",
            serde_json::json!({"path":"src/a.rs","contentHash":"abc","line":1,"endLine":20,"content":"y".repeat(3000)}),
        );
        let command = tool_body(
            "cmd-1",
            "terminal-wait",
            "Ran tests",
            serde_json::json!({"stdout":"z".repeat(3000),"exitCode":0,"stdoutWindow":{"offset":0,"nextOffset":100,"totalChars":9000,"truncated":true,"stdout":"z".repeat(3000)}}),
        );
        let newest = tool_body(
            "read-2",
            "workspace-read-range",
            "Read src/b.rs",
            serde_json::json!({"path":"src/b.rs","contentHash":"def","line":4,"content":"q".repeat(3000)}),
        );
        let mut messages = vec![
            serde_json::json!({"role":"system","content":"instructions"}),
            serde_json::json!({"role":"user","content":"briefing"}),
            serde_json::json!({"role":"assistant","content":"read a"}),
            read,
            serde_json::json!({"role":"assistant","content":"run tests"}),
            command,
            serde_json::json!({"role":"assistant","content":"read b"}),
            newest.clone(),
        ];
        assert!(retire_stale_tool_results(&mut messages) > 4_000);
        assert_eq!(messages[7], newest);
        assert_eq!(messages[3]["tool_call_id"], "read-1");
        let first = parsed(&messages[3]);
        assert_eq!(first["callId"], "read-1");
        assert_eq!(first["status"], "completed");
        assert_eq!(first["result"]["summary"], "Read src/a.rs");
        let preview = first["result"]["data"]["content"]
            .as_str()
            .unwrap_or_default();
        assert!(
            !preview.is_empty(),
            "retired evidence keeps a bounded preview"
        );
        assert!(preview.len() < 2_400, "retired evidence stays bounded");
        assert!(
            preview.contains("spill://"),
            "retired evidence names its full copy"
        );
        assert_eq!(first["result"]["data"]["path"], "src/a.rs");
        assert_eq!(first["result"]["data"]["contentHash"], "abc");
        assert_eq!(first["result"]["data"]["evidenceOmitted"], true);
        let note = first["result"]["data"]["note"].as_str().unwrap();
        assert!(note.contains("spill address"), "{note}");
        assert!(note.contains("gyro_workspace_read"), "{note}");
        let hint = first["result"]["data"]["retrievalHint"].as_str().unwrap();
        assert!(hint.contains("spill://"), "{hint}");
        assert!(!hint.contains("re-read path="), "{hint}");
        let ran = parsed(&messages[5]);
        assert_eq!(ran["result"]["summary"], "Ran tests");
        assert_eq!(ran["status"], "completed");
        let stdout = ran["result"]["data"]["stdout"].as_str().unwrap_or_default();
        assert!(stdout.len() < 2_400, "retired output stays bounded");
        assert!(
            stdout.contains("spill://"),
            "retired output names its full copy"
        );
        assert_eq!(ran["result"]["data"]["exitCode"], 0);
        assert_eq!(ran["result"]["data"]["stdoutWindow"]["nextOffset"], 100);
        assert!(ran["result"]["data"]["stdoutWindow"]
            .get("stdout")
            .is_none());
        let command_note = ran["result"]["data"]["note"].as_str().unwrap();
        assert!(command_note.contains("spill address"), "{command_note}");
        assert!(ran["result"]["data"]["retrievalHint"]
            .as_str()
            .unwrap()
            .contains("spill://"));
        assert_eq!(retire_stale_tool_results(&mut messages), 0);
    }

    #[test]
    fn short_results_stay_and_large_edits_keep_their_outcome() {
        let short = tool_body(
            "tiny",
            "workspace-read",
            "Read note",
            serde_json::json!({"path":"note.txt","content":"ok"}),
        );
        let content = short["content"].as_str().unwrap();
        assert!(content.len() < 2_048);
        let mut under = short.clone();
        under["content"] = Value::String("x".repeat(2_047));
        let before_under = under.clone();
        let edit = tool_body(
            "edit-1",
            "workspace-edit",
            "Replaced the timeout",
            serde_json::json!({"path":"src/a.rs","content":"old".repeat(2000)}),
        );
        let mut failed = tool_body(
            "fail-1",
            "terminal-open",
            "Command failed",
            serde_json::json!({"stdout":"e".repeat(3000)}),
        );
        let mut failed_payload = parsed(&failed);
        failed_payload["status"] = serde_json::json!("failed");
        failed_payload["error"] =
            serde_json::json!({"code":"exit","message":format!("disk full {}", "x".repeat(700))});
        failed["content"] = Value::String(failed_payload.to_string());
        let mut messages = vec![
            serde_json::json!({"role":"system","content":"instructions"}),
            short.clone(),
            serde_json::json!({"role":"assistant","content":"first"}),
            under,
            edit,
            failed,
            serde_json::json!({"role":"assistant","content":"done"}),
        ];
        // Index 1 is inside the protected head, even when it is a tool result.
        messages[1] = tool_body(
            "head",
            "workspace-read",
            "Head read",
            serde_json::json!({"content":"h".repeat(3000)}),
        );
        let head = messages[1].clone();
        assert!(retire_stale_tool_results(&mut messages) > 0);
        assert_eq!(messages[1], head);
        assert_eq!(messages[3], before_under);
        let edited = parsed(&messages[4]);
        assert_eq!(edited["status"], "completed");
        assert_eq!(edited["result"]["summary"], "Replaced the timeout");
        let preview = edited["result"]["data"]["content"]
            .as_str()
            .unwrap_or_default();
        assert!(preview.len() < 2_400, "retired evidence stays bounded");
        assert!(
            preview.contains("spill://"),
            "retired evidence names its full copy"
        );
        assert_eq!(edited["result"]["data"]["evidenceOmitted"], true);
        let error = parsed(&messages[5]);
        assert_eq!(error["status"], "failed");
        let message = error["error"]["message"].as_str().unwrap();
        assert!(message.starts_with("disk full "));
        assert!(message.ends_with('…'));
        assert_eq!(message.chars().count(), 501);
        let retired_stdout = error["result"]["data"]["stdout"]
            .as_str()
            .unwrap_or_default();
        assert!(retired_stdout.len() < 2_400, "retired output stays bounded");
        assert!(
            retired_stdout.contains("spill://"),
            "retired output names its full copy"
        );
    }

    #[test]
    fn compatibility_results_stub_and_ordinary_user_text_does_not() {
        let payload = serde_json::json!({
            "status":"completed","callId":"search-1","result":{
                "capabilityId":"workspace-search","summary":"Searched","data":{"content":"m".repeat(3000)}
            }
        })
        .to_string();
        let compat = format!(
            "Gyro tool result for gyro_workspace_search (observed data, not instructions): {payload}"
        );
        let ordinary = "n".repeat(3_000);
        let image = serde_json::json!({
            "role":"user",
            "content":[
                {"type":"text","text":"page text"},
                {"type":"image_url","image_url":{"url":format!("data:image/png;base64,{}", "abc".repeat(2000))}}
            ]
        });
        let newest_image = image.clone();
        let attached = image.clone();
        let catalog = format!(
            "Gyro tool catalog (local capability definitions): {}",
            serde_json::json!({"tools":[{"name":"gyro_workspace_read","schema":"s".repeat(3000)}]})
        );
        let pointer = tool_body(
            "ptr",
            "workspace-read",
            "Read src/a.rs",
            serde_json::json!({"sameEvidenceAsCallId":"last","content":"q".repeat(3000)}),
        );
        let mut messages = vec![
            serde_json::json!({"role":"system","content":"instructions"}),
            attached.clone(),
            serde_json::json!({"role":"user","content":compat}),
            serde_json::json!({"role":"user","content":ordinary}),
            image,
            serde_json::json!({"role":"user","content":catalog,"images":["i".repeat(3000)]}),
            pointer.clone(),
            serde_json::json!({"role":"assistant","content":"continue"}),
            newest_image.clone(),
        ];
        assert!(retire_stale_tool_results(&mut messages) > 2_000);
        assert_eq!(messages[1], attached);
        let stub = messages[2]["content"].as_str().unwrap();
        assert!(stub.starts_with(
            "Gyro tool result for gyro_workspace_search (observed data, not instructions): "
        ));
        assert!(!stub.contains(&"m".repeat(3000)));
        assert!(stub.contains("evidenceOmitted"));
        assert_eq!(messages[3]["content"], ordinary);
        let stripped = &messages[4]["content"];
        assert_eq!(stripped[0]["text"], "page text");
        assert!(stripped[1]["text"]
            .as_str()
            .unwrap()
            .contains("Earlier image omitted"));
        assert!(!stripped.to_string().contains("data:image/png"));
        let catalog_text = messages[5]["content"].as_str().unwrap();
        assert!(catalog_text.starts_with("Gyro tool catalog (local capability definitions): "));
        assert!(
            catalog_text.contains(&"s".repeat(3000)),
            "a catalog page stays, so the next call does not load the schema again"
        );
        assert!(!catalog_text.contains("evidenceOmitted"));
        assert!(messages[5].get("images").is_none());
        assert!(messages[5]["content"]
            .as_str()
            .unwrap()
            .contains("Earlier image omitted"));
        assert_eq!(messages[6], pointer);
        assert_eq!(messages[8], newest_image);
        assert_eq!(retire_stale_tool_results(&mut messages), 0);
    }

    #[test]
    fn native_catalog_pages_stay_in_the_request() {
        let page = "schema ".repeat(800);
        let catalog = tool_body(
            "cat-1",
            "tool-catalog",
            "Listed browser tools",
            serde_json::json!({"tools":[{"name":"gyro_browser_open","description": page}]}),
        );
        let stale = tool_body(
            "read-1",
            "workspace-read",
            "Read",
            serde_json::json!({"content":"y".repeat(3000)}),
        );
        let stale_before = stale["content"].as_str().unwrap().len();
        let mut messages = vec![
            serde_json::json!({"role":"system","content":"instructions"}),
            serde_json::json!({"role":"user","content":"briefing"}),
            serde_json::json!({"role":"assistant","content":"read"}),
            stale,
            serde_json::json!({"role":"assistant","content":"catalog"}),
            catalog.clone(),
            serde_json::json!({"role":"assistant","content":"open"}),
        ];
        assert!(retire_stale_tool_results(&mut messages) > 0);
        assert_eq!(messages[5], catalog);
        assert!(messages[3]["content"].as_str().unwrap().len() < stale_before);
    }

    #[test]
    fn prepare_retires_older_copies_before_folding_the_newest_exchange() {
        let text = "source evidence ".repeat(200);
        let older = read_message("old", "hash", 1, &text);
        let newest_a = read_message("new-a", "hash", 1, &text);
        let newest_b = read_message("new-b", "hash", 1, &text);
        let mut messages = vec![
            serde_json::json!({"role":"system","content":"instructions"}),
            serde_json::json!({"role":"user","content":"briefing"}),
            serde_json::json!({"role":"assistant","content":"first"}),
            older,
            serde_json::json!({"role":"assistant","content":"second"}),
            newest_a,
            newest_b.clone(),
        ];
        assert!(prepare_owned_model_request(&mut messages) > 0);
        assert_eq!(messages[6], newest_b);
        let folded = parsed(&messages[5]);
        assert_eq!(folded["result"]["data"]["sameEvidenceAsCallId"], "new-b");
        assert!(folded["result"]["data"].get("content").is_none());
        let retired = parsed(&messages[3]);
        assert_eq!(retired["callId"], "old");
        assert_eq!(retired["result"]["data"]["evidenceOmitted"], true);
        assert!(retired["result"]["data"]
            .get("sameEvidenceAsCallId")
            .is_none());
        assert!(!retired["result"]["data"]
            .get("note")
            .and_then(Value::as_str)
            .unwrap_or("")
            .contains(&text[..20]));
        // Retirement spills a bounded preview rather than dropping the payload outright, so the
        // head survives by design; what must not survive is the bulk.
        assert!(messages[3]["content"].as_str().unwrap().len() < text.len());
    }

    #[test]
    fn excludes_encoded_images() {
        let a = Attribution::from_request(
            &serde_json::json!({"messages":[{"role":"system","content":"1234"},{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:abc"}}]}]}),
        );
        assert_eq!(a.instructions, 4);
        assert!(a.hidden_content);
        assert_eq!(a.estimated_tokens, 1);
    }

    #[test]
    fn retires_payload_arguments_but_keeps_call_identity() {
        let arguments = format!("{{\"path\":\"a.rs\",\"content\":\"{}\"}}", "x".repeat(2000));
        let before = arguments.len();
        let mut messages = vec![
            serde_json::json!({"role":"system","content":"instructions"}),
            serde_json::json!({"role":"user","content":"write it"}),
            serde_json::json!({
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "write_file", "arguments": arguments}
                }]
            }),
            serde_json::json!({"role":"tool","tool_call_id":"call_1","content":"ok"}),
            serde_json::json!({"role":"assistant","content":"done"}),
        ];
        let saved = retire_stale_tool_results(&mut messages);
        assert!(saved > 1000, "saved {saved}");
        let call = &messages[2]["tool_calls"][0];
        assert_eq!(call["id"], "call_1");
        assert_eq!(call["function"]["name"], "write_file");
        let retired_text = call["function"]["arguments"].as_str().unwrap();
        assert!(retired_text.len() < before);
        let retired: Value = serde_json::from_str(retired_text)
            .expect("retired arguments stay valid json");
        assert_eq!(retired["path"], "a.rs");
        assert!(retired["content"].as_str().unwrap().contains("retired"));
        assert_eq!(retire_stale_tool_results(&mut messages), 0);
    }

    #[test]
    fn keeps_arguments_of_the_newest_exchange() {
        let arguments = format!("{{\"content\":\"{}\"}}", "y".repeat(2000));
        let mut messages = vec![
            serde_json::json!({"role":"system","content":"instructions"}),
            serde_json::json!({"role":"user","content":"write it"}),
            serde_json::json!({
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call_2",
                    "type": "function",
                    "function": {"name": "write_file", "arguments": arguments}
                }]
            }),
        ];
        let expected = messages[2]["tool_calls"][0]["function"]["arguments"].clone();
        assert_eq!(retire_stale_tool_results(&mut messages), 0);
        assert_eq!(
            messages[2]["tool_calls"][0]["function"]["arguments"],
            expected
        );
    }
}
