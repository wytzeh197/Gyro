use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
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
    /// Bytes newly removed by retirement while assembling this turn's requests.
    /// This is not a token count or an estimate of replay or billing savings.
    #[serde(default)]
    pub retired_bytes: u64,
    /// Version 2 denotes the one-time-per-rewrite accounting above. Older
    /// receipts cannot establish this metric, even when their value is zero.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retirement_accounting_version: Option<u8>,
    /// Fixed classes of validated tool requests, available only for observed runners.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_class_counts: Option<BTreeMap<String, u64>>,
    /// Counts at the owned request boundary; native internals are unavailable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation_attempts: Option<GenerationAttempts>,
    /// Only observed owned-runner events; absent for legacy/native receipts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub efficiency_events: Option<EfficiencyEvents>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EfficiencyEvents {
    pub catalog_discoveries: u64,
    pub catalog_rediscoveries: u64,
    pub catalog_fallbacks: u64,
    pub spill_recoveries: u64,
    pub spill_failures: u64,
    pub repeated_call_notices: u64,
    pub repeated_call_pauses: u64,
}
impl EfficiencyEvents {
    pub fn combine(&mut self, other: &Self) {
        self.catalog_discoveries = self
            .catalog_discoveries
            .saturating_add(other.catalog_discoveries);
        self.catalog_rediscoveries = self
            .catalog_rediscoveries
            .saturating_add(other.catalog_rediscoveries);
        self.catalog_fallbacks = self
            .catalog_fallbacks
            .saturating_add(other.catalog_fallbacks);
        self.spill_recoveries = self.spill_recoveries.saturating_add(other.spill_recoveries);
        self.spill_failures = self.spill_failures.saturating_add(other.spill_failures);
        self.repeated_call_notices = self
            .repeated_call_notices
            .saturating_add(other.repeated_call_notices);
        self.repeated_call_pauses = self
            .repeated_call_pauses
            .saturating_add(other.repeated_call_pauses);
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationAttempts {
    pub started: u64,
    pub completed: u64,
    pub rejected: u64,
    pub retries: u64,
}

impl GenerationAttempts {
    pub fn combine(&mut self, other: &Self) {
        self.started = self.started.saturating_add(other.started);
        self.completed = self.completed.saturating_add(other.completed);
        self.rejected = self.rejected.saturating_add(other.rejected);
        self.retries = self.retries.saturating_add(other.retries);
    }
}
impl Attribution {
    pub fn from_request(payload: &Value) -> Self {
        let mut a = Self::default();
        // Compact JSON length in characters, counted while serializing. The
        // previous `to_string` copied every tool schema on each observed request.
        a.tool_schemas = payload.get("tools").map(json_chars).unwrap_or(0);
        if let Some(messages) = payload.get("messages").and_then(Value::as_array) {
            for message in messages {
                let role = message["role"].as_str().unwrap_or_default();
                let content = &message["content"];
                let counted = counted_content(content);
                if counted.hidden {
                    a.hidden_content = true;
                }
                if message
                    .get("images")
                    .and_then(Value::as_array)
                    .is_some_and(|x| !x.is_empty())
                {
                    a.hidden_content = true;
                }
                let n = counted.chars;
                match role {
                    "system" | "developer" => a.instructions += n,
                    "tool" => {
                        // A string body is borrowed. Multipart tool text is joined
                        // only here, which is the same string the classifier used
                        // to parse after copying every message.
                        let source = if let Some(text) = counted.whole {
                            tool_text_is_source(text)
                        } else if content.as_array().is_some() {
                            tool_text_is_source(&joined_text_parts(content))
                        } else {
                            false
                        };
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
        if other.retirement_accounting_version == Some(2) {
            self.retired_bytes = self.retired_bytes.saturating_add(other.retired_bytes);
            self.retirement_accounting_version = Some(2);
        }
    }
}

struct CountedContent<'a> {
    chars: u64,
    /// Set when `content` is one string, so a tool body can be parsed in place.
    whole: Option<&'a str>,
    hidden: bool,
}

/// Length of message text without copying it.
///
/// A string is counted where it sits. Multipart text is the same `join("\n")`
/// the old path counted, including a newline only between text parts. A part
/// that is not text marks the message hidden and contributes nothing.
fn counted_content(content: &Value) -> CountedContent<'_> {
    if let Some(text) = content.as_str() {
        return CountedContent {
            chars: char_len(text),
            whole: Some(text),
            hidden: false,
        };
    }
    let Some(parts) = content.as_array() else {
        return CountedContent {
            chars: 0,
            whole: None,
            hidden: false,
        };
    };
    let mut chars = 0u64;
    let mut pieces = 0u64;
    let mut hidden = false;
    for part in parts {
        if let Some(text) = part.get("text").and_then(Value::as_str) {
            if pieces > 0 {
                chars += 1;
            }
            chars += char_len(text);
            pieces += 1;
        } else {
            hidden = true;
        }
    }
    CountedContent {
        chars,
        whole: None,
        hidden,
    }
}

fn joined_text_parts(content: &Value) -> String {
    let Some(parts) = content.as_array() else {
        return String::new();
    };
    let mut strings = Vec::new();
    for part in parts {
        if let Some(text) = part.get("text").and_then(Value::as_str) {
            strings.push(text);
        }
    }
    strings.join("\n")
}

fn char_len(text: &str) -> u64 {
    if text.is_ascii() {
        text.len() as u64
    } else {
        text.chars().count() as u64
    }
}

fn tool_text_is_source(text: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return false;
    };
    matches!(
        value
            .pointer("/result/capabilityId")
            .and_then(Value::as_str),
        Some("workspace-read" | "workspace-read-range" | "workspace-read-editor")
    )
}

/// Character count of compact JSON.
///
/// `serde_json::to_string` then `chars().count()` copied the value. This writer
/// counts the same scalars. ASCII chunks use their byte length. A scalar split
/// across writes is finished when its continuation bytes arrive. A failed
/// write counts as zero, which is what `unwrap_or_default` did.
fn json_chars(value: &Value) -> u64 {
    let mut counter = Utf8CharCounter { chars: 0, need: 0 };
    match serde_json::to_writer(&mut counter, value) {
        Ok(()) => counter.chars as u64,
        Err(_) => 0,
    }
}

struct Utf8CharCounter {
    chars: usize,
    need: u8,
}

impl std::io::Write for Utf8CharCounter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.need == 0 && buf.is_ascii() {
            self.chars += buf.len();
            return Ok(buf.len());
        }
        for &byte in buf {
            if self.need > 0 {
                if byte & 0b1100_0000 == 0b1000_0000 {
                    self.need -= 1;
                    if self.need == 0 {
                        self.chars += 1;
                    }
                } else {
                    self.need = 0;
                    self.observe_lead(byte);
                }
                continue;
            }
            self.observe_lead(byte);
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Utf8CharCounter {
    fn observe_lead(&mut self, byte: u8) {
        if byte < 0x80 {
            self.chars += 1;
        } else if byte & 0b1110_0000 == 0b1100_0000 {
            self.need = 1;
        } else if byte & 0b1111_0000 == 0b1110_0000 {
            self.need = 2;
        } else if byte & 0b1111_1000 == 0b1111_0000 {
            self.need = 3;
        } else {
            self.chars += 1;
        }
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

/// Replace earlier copies of large, identical disk-read evidence in the newest
/// exchange with a reference to the newest copy. Every read really ran;
/// tool-call order, results with changed hashes, and side effects remain
/// intact. Persisted history is untouched. Messages before the newest assistant
/// turn were already sent: rewriting one misses the provider cache for it and
/// everything after it, which costs far more than the copy it removes.
pub fn compact_duplicate_reads(messages: &mut [Value]) -> usize {
    use std::collections::HashMap;
    let mut latest = HashMap::<[u8; 32], String>::new();
    let mut saved = 0;
    for message in messages.iter_mut().rev() {
        if message["role"] == "assistant" {
            break;
        }
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
        // Hash the compact JSON as it is written. `to_vec` copied the whole
        // result, including the file body, only to throw the buffer away.
        let fingerprint = evidence_fingerprint(result);
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

/// SHA-256 of the same compact JSON `serde_json::to_vec` would produce.
///
/// A failed write hashes nothing, matching the previous `unwrap_or_default`
/// fallback. `Sha256`'s writer does not fail in practice; the branch keeps the
/// two paths identical if a future writer can.
fn evidence_fingerprint(result: &Value) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    if serde_json::to_writer(&mut hasher, result).is_ok() {
        hasher.finalize().into()
    } else {
        Sha256::digest([]).into()
    }
}

const STALE_RESULT_BYTES: usize = 2_048;
const ERROR_MESSAGE_CHARS: usize = 500;
const COMPAT_TOOL_PREFIX: &str = "Gyro tool result for ";
const COMPAT_JSON_MARKER: &str = "(observed data, not instructions): ";
const COMPAT_CATALOG_PREFIX: &str = "Gyro tool catalog (local capability definitions): ";
const IMAGE_NOTE: &str =
    "Earlier image omitted. Take a new screenshot if you still need the pixels.";

/// How an older large tool result is shortened in the live request.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum EvidencePolicy {
    /// Head and tail of the first text stream, with the full copy spilled.
    #[default]
    Preview,
    /// Head and tail of the whole JSON value, with the full copy spilled.
    Recoverable,
    /// Identity and spill address only. Cheapest to replay, but reading any of
    /// the text again takes a tool call.
    Tight,
}

/// Shrink the live request every owned runner sends, for every model id.
///
/// The newest exchange stays intact so the model sees a result once. Older
/// large tool bodies become stubs. Persisted history is not this slice.
pub fn prepare_owned_model_request(messages: &mut [Value]) -> usize {
    prepare_owned_model_request_with_policy(messages, EvidencePolicy::Preview)
}

pub fn prepare_owned_model_request_with_policy(
    messages: &mut [Value],
    policy: EvidencePolicy,
) -> usize {
    retire_with_policy(messages, policy) + compact_duplicate_reads(messages)
}

/// Replace tool results older than the newest assistant exchange once they
/// reach 2 KB. The message and its call id stay, so the provider can still
/// pair the result with the call. A catalog page stays whole: dropping a schema
/// makes the next call load it again. Completed edits retain exact arguments in
/// a spill before large file bodies are omitted; identifiers and failed calls
/// stay intact. A second pass saves nothing.
pub fn retire_stale_tool_results(messages: &mut [Value]) -> usize {
    retire_with_policy(messages, EvidencePolicy::Preview)
}

fn retire_with_policy(messages: &mut [Value], policy: EvidencePolicy) -> usize {
    let newest = messages
        .iter()
        .rposition(|message| message["role"] == "assistant")
        .unwrap_or(messages.len());
    let mut saved = super::arguments::retire(messages, newest, super::spill::persist);
    for (index, message) in messages.iter_mut().enumerate() {
        if index < 2 || index >= newest {
            continue;
        }
        let removed_images = strip_stale_images(message);
        saved += removed_images;
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
            stub_tool_content(text, policy)
        } else if role == "user" && text.starts_with(COMPAT_TOOL_PREFIX) {
            stub_compat_content(text, policy)
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
        // The saved-byte count is the compact JSON length. Measuring it by
        // reference avoids cloning the base64 just to format and drop it.
        if let Some(images) = message.get("images") {
            saved += super::compaction::message_bytes(images);
        }
        message
            .as_object_mut()
            .map(|object| object.remove("images"));
        append_image_note(message);
    }
    let has_image_part = message
        .get("content")
        .and_then(Value::as_array)
        .is_some_and(|parts| parts.iter().any(is_image_part));
    if !has_image_part {
        return saved;
    }
    let Some(content) = message.get_mut("content") else {
        return saved;
    };
    let replaced = std::mem::replace(content, Value::Null);
    let Value::Array(parts) = replaced else {
        *content = replaced;
        return saved;
    };
    let mut kept = Vec::with_capacity(parts.len());
    let mut removed = 0;
    for part in parts {
        if is_image_part(&part) {
            removed += super::compaction::message_bytes(&part);
        } else {
            kept.push(part);
        }
    }
    if removed > 0 {
        kept.push(serde_json::json!({"type": "text", "text": IMAGE_NOTE}));
        *content = Value::Array(kept);
        saved += removed;
    } else {
        *content = Value::Array(kept);
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

fn stub_tool_content(text: &str, policy: EvidencePolicy) -> Option<String> {
    let mut payload: Value = serde_json::from_str(text).ok()?;
    if payload
        .pointer("/result/capabilityId")
        .and_then(Value::as_str)
        == Some("tool-catalog")
    {
        return None;
    }
    apply_stub(&mut payload, policy)?;
    serde_json::to_string(&payload).ok()
}

fn stub_compat_content(text: &str, policy: EvidencePolicy) -> Option<String> {
    let json_at = text.find(COMPAT_JSON_MARKER)? + COMPAT_JSON_MARKER.len();
    let (prefix, json) = text.split_at(json_at);
    let mut payload: Value = serde_json::from_str(json.trim()).ok()?;
    apply_stub(&mut payload, policy)?;
    Some(format!("{prefix}{}", serde_json::to_string(&payload).ok()?))
}

fn already_omitted(payload: &Value) -> bool {
    payload.get("evidenceOmitted").is_some()
        || payload.pointer("/result/data/evidenceOmitted").is_some()
        || payload
            .pointer("/result/data/sameEvidenceAsCallId")
            .is_some()
}

fn apply_stub(payload: &mut Value, policy: EvidencePolicy) -> Option<()> {
    if already_omitted(payload) || payload.get("result").is_none() {
        return None;
    }
    let capability = payload
        .pointer("/result/capabilityId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let slim = match policy {
        // Persist before replacing the body: a failed spill must retain evidence.
        EvidencePolicy::Recoverable => recoverable_data(
            payload.pointer("/result/data").unwrap_or(&Value::Null),
            &capability,
            super::spill::persist,
        )?,
        EvidencePolicy::Tight => tight_data(
            payload.pointer("/result/data").unwrap_or(&Value::Null),
            &capability,
            super::spill::persist,
        )?,
        EvidencePolicy::Preview => {
            // Move retired evidence rather than keeping a second payload copy.
            let data = match payload.pointer_mut("/result/data") {
                Some(slot) => std::mem::replace(slot, Value::Null),
                None => Value::Null,
            };
            slim_data(&data, &capability)
        }
    };
    payload["result"]["data"] = slim;
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
            if !super::spill::persist(&preview.address, text) {
                crate::provider_observation::efficiency_event(|e| {
                    e.spill_failures = e.spill_failures.saturating_add(1)
                });
                return data.clone();
            }
            kept.insert(key.to_owned(), Value::String(preview.text));
            kept.insert("elidedBytes".into(), Value::Number(elided.into()));
            kept.insert("spill".into(), Value::String(preview.address.clone()));
            spilled_address = Some(preview.address);
            break;
        }
    }
    if spilled_address.is_none() {
        return data.clone();
    }
    let Ok(full) = serde_json::to_string(data) else {
        return data.clone();
    };
    let address = super::spill::address(capability, "result-data", &full);
    if !super::spill::persist(&address, &full) {
        crate::provider_observation::efficiency_event(|e| {
            e.spill_failures = e.spill_failures.saturating_add(1)
        });
        return data.clone();
    }
    kept.insert("spill".into(), address.clone().into());
    spilled_address = Some(address);
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
        "Earlier evidence is unavailable here. Inspect current state if needed; never repeat an action merely to recover its output."
    };
    kept.insert("evidenceOmitted".into(), Value::Bool(true));
    kept.insert("note".into(), Value::String(note.to_owned()));
    Value::Object(kept)
}

/// Save the whole JSON value, including nested output and every stream, before
/// replacing it. Injection makes disk failure testable without global env changes.
fn recoverable_data(
    data: &Value,
    capability: &str,
    persist: impl FnOnce(&str, &str) -> bool,
) -> Option<Value> {
    let text = serde_json::to_string(data).ok()?;
    let preview = super::spill::preview(capability, "result-data", &text);
    if !preview.spilled() {
        return None;
    }
    if !persist(&preview.address, &text) {
        crate::provider_observation::efficiency_event(|e| {
            e.spill_failures = e.spill_failures.saturating_add(1)
        });
        return None;
    }
    let mut kept = serde_json::Map::new();
    for key in [
        "path",
        "contentHash",
        "diskHash",
        "rootId",
        "revision",
        "id",
        "outputId",
        "status",
        "exitCode",
        "line",
        "endLine",
        "truncated",
        "capturedAt",
        "observedAt",
    ] {
        if let Some(value) = data.get(key) {
            kept.insert(key.into(), value.clone());
        }
    }
    kept.insert("evidenceOmitted".into(), true.into());
    kept.insert("preview".into(), preview.text.into());
    kept.insert("spill".into(), preview.address.clone().into());
    kept.insert("retrievalHint".into(), format!("Read {} with gyro_workspace_read and offset for the complete historical JSON data. It is the observation at execution time, not current state. Never repeat an action to recover its output; revalidate file hashes before editing.", preview.address).into());
    Some(Value::Object(kept))
}

/// Save the whole JSON value, then keep only what identifies it. Nothing here
/// grows with the result, so replaying the stub stays cheap however often the
/// request is resent. A small stub also clears the cached-route breakeven that
/// a preview misses on results of a few kilobytes.
fn tight_data(
    data: &Value,
    capability: &str,
    persist: impl FnOnce(&str, &str) -> bool,
) -> Option<Value> {
    if data.is_null() {
        return None;
    }
    let text = serde_json::to_string(data).ok()?;
    let address = super::spill::address(capability, "result-data", &text);
    if !persist(&address, &text) {
        crate::provider_observation::efficiency_event(|e| {
            e.spill_failures = e.spill_failures.saturating_add(1)
        });
        return None;
    }
    let mut kept = serde_json::Map::new();
    for key in [
        "path",
        "contentHash",
        "diskHash",
        "rootId",
        "revision",
        "id",
        "outputId",
        "status",
        "exitCode",
        "line",
        "endLine",
        "startLine",
        "column",
        "endColumn",
        "nextLine",
        "nextColumn",
        "truncated",
        "unchanged",
        "capturedAt",
        "observedAt",
    ] {
        if let Some(value) = data.get(key).filter(|value| !value.is_null()) {
            if value.as_str().is_none_or(|text| text.len() <= 200) {
                kept.insert(key.into(), value.clone());
            }
        }
    }
    if let Some(object) = data.as_object() {
        for (key, value) in object {
            if key == "window" || key.ends_with("Window") {
                if let Some(slim) = slim_window(value) {
                    kept.insert(key.clone(), slim);
                }
            }
        }
    }
    kept.insert("evidenceOmitted".into(), true.into());
    kept.insert("elidedBytes".into(), text.len().into());
    kept.insert("spill".into(), address.into());
    kept.insert(
        "retrievalHint".into(),
        "Read spill with gyro_workspace_read and offset. Historical copy; revalidate before editing."
            .into(),
    );
    Some(Value::Object(kept))
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
            serde_json::json!({"role":"assistant","content":"continue"}),
            first,
            newest.clone(),
        ];
        let saved = compact_duplicate_reads(&mut messages);
        assert!(saved > 14_000);
        assert_eq!(messages[2], newest);
        assert_eq!(messages[1]["tool_call_id"], "first");
        let reference: Value =
            serde_json::from_str(messages[1]["content"].as_str().unwrap()).unwrap();
        assert_eq!(reference["callId"], "first");
        assert_eq!(reference["result"]["data"]["sameEvidenceAsCallId"], "last");
        assert_eq!(compact_duplicate_reads(&mut messages), 0);
    }
    #[test]
    fn evidence_fingerprint_matches_the_compact_json_bytes() {
        use sha2::{Digest, Sha256};
        let result = serde_json::json!({
            "capabilityId": "workspace-read",
            "data": {"contentHash": "abc", "content": "x".repeat(8_000)}
        });
        let via_buffer: [u8; 32] = Sha256::digest(serde_json::to_vec(&result).unwrap()).into();
        let empty: [u8; 32] = Sha256::digest([]).into();
        assert_eq!(evidence_fingerprint(&result), via_buffer);
        assert_ne!(evidence_fingerprint(&result), empty);
    }
    #[test]
    fn a_later_read_never_rewrites_an_already_sent_message() {
        let text = "source evidence ".repeat(1000);
        let briefing = serde_json::json!({"role":"user","content":"briefing"});
        let assistant = |name: &str| serde_json::json!({"role":"assistant","content":name});
        let mut messages = vec![
            serde_json::json!({"role":"system","content":"instructions"}),
            briefing,
            assistant("first"),
            read_message("first", "hash", 1, &text),
            assistant("second"),
            read_message("second", "hash", 1, &text),
        ];
        prepare_owned_model_request(&mut messages);
        let sent = messages[..4].to_vec();
        // The file is unchanged, so retiring the second read yields a stub identical to the
        // first apart from its call id. The first stub must keep its exact bytes regardless.
        messages.push(assistant("third"));
        messages.push(read_message("third", "hash", 1, &text));
        prepare_owned_model_request(&mut messages);
        assert_eq!(messages[..4], sent[..]);
        let sent = messages[..6].to_vec();
        messages.push(assistant("fourth"));
        messages.push(read_message("fourth", "hash", 1, &text));
        prepare_owned_model_request(&mut messages);
        assert_eq!(messages[..6], sent[..]);
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
    fn image_retirement_counts_removed_json_and_leaves_text_parts() {
        let images = serde_json::json!(["i".repeat(3000)]);
        let part = serde_json::json!({
            "type": "image_url",
            "image_url": {"url": format!("data:image/png;base64,{}", "abc".repeat(800))}
        });
        let expected = serde_json::to_string(&images).unwrap().len()
            + serde_json::to_string(&part).unwrap().len();
        let mut messages = vec![
            serde_json::json!({"role":"system","content":"instructions"}),
            serde_json::json!({"role":"user","content":"briefing"}),
            serde_json::json!({
                "role": "user",
                "content": [{"type": "text", "text": "page text"}, part],
                "images": images,
            }),
            serde_json::json!({"role":"assistant","content":"done"}),
        ];
        assert_eq!(retire_stale_tool_results(&mut messages), expected);
        assert_eq!(messages[2]["content"][0]["text"], "page text");
        assert!(messages[2].get("images").is_none());
        assert!(messages[2]["content"][1]["text"]
            .as_str()
            .unwrap()
            .contains("Earlier image omitted"));
        assert!(!messages[2].to_string().contains("data:image"));
        let text_only = serde_json::json!({
            "role": "user",
            "content": [{"type": "text", "text": "n".repeat(8_000)}]
        });
        let mut untouched = vec![
            serde_json::json!({"role":"system","content":"instructions"}),
            serde_json::json!({"role":"user","content":"briefing"}),
            text_only.clone(),
            serde_json::json!({"role":"assistant","content":"done"}),
        ];
        assert_eq!(retire_stale_tool_results(&mut untouched), 0);
        assert_eq!(untouched[2], text_only);
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

    /// The sums are the old algorithm: owned text, `chars().count()`, and
    /// `serde_json::to_string` for tools. ASCII is counted as bytes. A non-ASCII
    /// body, a multipart join, and an escaped tool schema must stay on that sum.
    #[test]
    fn attribution_matches_owned_character_counts() {
        let source = format!("{}界", "fn main() {}\n".repeat(40));
        let note = "line — two";
        let read = serde_json::json!({
            "status": "completed",
            "callId": "read",
            "result": {"capabilityId": "workspace-read-editor", "data": {"content": source.clone()}}
        })
        .to_string();
        let terminal = serde_json::json!({
            "status": "completed",
            "callId": "run",
            "result": {"capabilityId": "terminal", "data": {"output": "done\n"}}
        })
        .to_string();
        let tools = serde_json::json!([
            {"type": "function", "function": {"name": "gyro_workspace_read", "description": "read a file\nwith \"quotes\" and 界"}}
        ]);
        let payload = serde_json::json!({
            "tools": tools.clone(),
            "messages": [
                {"role": "developer", "content": "dev"},
                {"role": "user", "content": [
                    {"type": "text", "text": "hello"},
                    {"type": "text", "text": note},
                    {"type": "image_url", "image_url": {"url": "data:abc"}}
                ]},
                {"role": "assistant", "content": "prior"},
                {"role": "tool", "content": read.clone()},
                {"role": "tool", "content": [
                    {"type": "text", "text": terminal.clone()}
                ]},
                {"role": "user", "content": source.clone(), "gyroCategory": "source"},
                {"role": "user", "content": "state", "gyroCategory": "task-state"},
                {"role": "user", "content": "old", "gyroCategory": "history"},
                {"role": "user", "content": "ask", "images": ["abc"]}
            ]
        });
        let actual = Attribution::from_request(&payload);
        let tools_chars = serde_json::to_string(&payload["tools"])
            .unwrap()
            .chars()
            .count() as u64;
        let other =
            ("hello".chars().count() + 1 + note.chars().count() + "ask".chars().count()) as u64;
        assert_eq!(actual.tool_schemas, tools_chars);
        assert_eq!(actual.instructions, "dev".chars().count() as u64);
        assert_eq!(actual.other_text, other);
        assert_eq!(
            actual.history,
            ("prior".chars().count() + "old".chars().count()) as u64
        );
        assert_eq!(actual.task_state, "state".chars().count() as u64);
        assert_eq!(
            actual.source_excerpts,
            (read.chars().count() + source.chars().count()) as u64
        );
        assert_eq!(actual.tool_results, terminal.chars().count() as u64);
        assert!(actual.hidden_content);
        let summed = actual.instructions
            + actual.tool_schemas
            + actual.source_excerpts
            + actual.tool_results
            + actual.task_state
            + actual.history
            + actual.other_text;
        assert_eq!(actual.estimated_tokens, summed.div_ceil(4));
        assert_ne!(source.len(), source.chars().count());
        let rendered = serde_json::to_string(&tools).unwrap();
        assert!(rendered.chars().any(|character| !character.is_ascii()));
        assert_eq!(json_chars(&tools), rendered.chars().count() as u64);
    }

    #[test]
    fn json_char_counter_finishes_a_scalar_split_across_writes() {
        use std::io::Write;
        let mut counter = Utf8CharCounter { chars: 0, need: 0 };
        let bytes = "界".as_bytes();
        counter.write_all(&bytes[..1]).unwrap();
        counter.write_all(&bytes[1..]).unwrap();
        assert_eq!((counter.chars, counter.need), (1, 0));
    }

    #[test]
    fn retires_payload_arguments_but_keeps_call_identity() {
        let arguments = format!("{{\"path\":\"a.rs\",\"content\":\"{}\"}}", "x".repeat(4000));
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
                    "function": {"name": "gyro_workspace_propose_edit", "arguments": arguments}
                }]
            }),
            tool_body(
                "call_1",
                "workspace-propose-edit",
                "Proposed a.rs",
                serde_json::json!({"path":"a.rs","status":"pending"}),
            ),
            serde_json::json!({"role":"assistant","content":"done"}),
        ];
        let saved = retire_stale_tool_results(&mut messages);
        assert!(saved > 1000, "saved {saved}");
        let call = &messages[2]["tool_calls"][0];
        assert_eq!(call["id"], "call_1");
        assert_eq!(call["function"]["name"], "gyro_workspace_propose_edit");
        let retired_text = call["function"]["arguments"].as_str().unwrap();
        assert!(retired_text.len() < before);
        let retired: Value =
            serde_json::from_str(retired_text).expect("retired arguments stay valid json");
        assert_eq!(retired["path"], "a.rs");
        assert!(retired["content"].as_str().unwrap().contains("spill://"));
        assert_eq!(retire_stale_tool_results(&mut messages), 0);
    }

    #[test]
    fn keeps_arguments_of_the_newest_exchange() {
        let arguments = format!("{{\"content\":\"{}\"}}", "y".repeat(4000));
        let mut messages = vec![
            serde_json::json!({"role":"system","content":"instructions"}),
            serde_json::json!({"role":"user","content":"write it"}),
            serde_json::json!({
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call_2",
                    "type": "function",
                    "function": {"name": "gyro_workspace_propose_edit", "arguments": arguments}
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
    #[test]
    fn complete_evidence_preserves_nested_streams_and_failure_keeps_original() {
        let data = serde_json::json!({"path":"a.rs","contentHash":"v1","exitCode":1,"outputId":"job1",
            "pane":{"stdout":"a".repeat(4000),"stderr":"failure".repeat(900)},
            "matches":[{"text":"界".repeat(2000)}]});
        let dir = tempfile::tempdir().unwrap();
        let store = super::super::spill::SpillStore::new(dir.path());
        let compact = recoverable_data(&data, "workspace-run-task", |address, text| {
            store.save(address, text).is_ok()
        })
        .unwrap();
        assert_eq!(compact["exitCode"], 1);
        assert_eq!(compact["contentHash"], "v1");
        assert_eq!(compact["outputId"], "job1");
        let saved = store
            .load(compact["spill"].as_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&saved).unwrap(), data);
        assert!(compact["retrievalHint"]
            .as_str()
            .unwrap()
            .contains("Never repeat an action"));
        let blocked_path = dir.path().join("not-a-directory");
        std::fs::write(&blocked_path, "file").unwrap();
        let blocked = super::super::spill::SpillStore::new(blocked_path);
        assert!(
            recoverable_data(&data, "workspace-run-task", |address, text| blocked
                .save(address, text)
                .is_ok())
            .is_none()
        );
        assert_eq!(data["pane"]["stderr"], "failure".repeat(900));
        store.gc(0).unwrap();
        assert!(store
            .load(compact["spill"].as_str().unwrap())
            .unwrap()
            .is_none());
    }
    #[test]
    fn recovery_policy_keeps_head_newest_and_protocol_identity() {
        let old = read_message("old", "v1", 1, &"x".repeat(8000));
        let newest = read_message("new", "v2", 1, &"y".repeat(8000));
        let mut messages = vec![
            serde_json::json!({"role":"system","content":"rules"}),
            serde_json::json!({"role":"user","content":"attachment and exact request"}),
            serde_json::json!({"role":"assistant","content":"read"}),
            old,
            serde_json::json!({"role":"assistant","content":"read again"}),
            newest.clone(),
        ];
        let head = messages[..2].to_vec();
        prepare_owned_model_request_with_policy(&mut messages, EvidencePolicy::Recoverable);
        assert_eq!(messages[..2], head);
        assert_eq!(messages[5], newest);
        assert_eq!(parsed(&messages[3])["callId"], "old");
        assert_eq!(
            prepare_owned_model_request_with_policy(&mut messages, EvidencePolicy::Recoverable),
            0
        );
    }
    #[test]
    fn tight_evidence_keeps_identity_and_a_complete_copy() {
        let data = serde_json::json!({"path":"a.rs","contentHash":"v1","exitCode":1,"outputId":"job1",
            "window":{"offset":0,"nextOffset":4000,"totalChars":9000,"secret":"dropped"},
            "pane":{"stdout":"a".repeat(4000),"stderr":"failure".repeat(900)},
            "matches":[{"text":"界".repeat(2000)}]});
        let dir = tempfile::tempdir().unwrap();
        let store = super::super::spill::SpillStore::new(dir.path());
        let compact = tight_data(&data, "workspace-run-task", |address, text| {
            store.save(address, text).is_ok()
        })
        .unwrap();
        assert_eq!(compact["path"], "a.rs");
        assert_eq!(compact["contentHash"], "v1");
        assert_eq!(compact["exitCode"], 1);
        assert_eq!(compact["outputId"], "job1");
        assert_eq!(compact["window"]["nextOffset"], 4000);
        assert!(compact["window"].get("secret").is_none());
        assert_eq!(compact["evidenceOmitted"], true);
        let body = compact.to_string();
        assert!(body.len() < 500, "stub grew to {} bytes", body.len());
        assert!(!body.contains("failure"), "no preview text stays");
        let saved = store
            .load(compact["spill"].as_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&saved).unwrap(), data);
        assert_eq!(compact["elidedBytes"], saved.len());
    }
    #[test]
    fn tight_evidence_keeps_the_original_when_the_spill_fails() {
        let data = serde_json::json!({"path":"a.rs","content":"x".repeat(8000)});
        assert!(tight_data(&data, "workspace-read", |_, _| false).is_none());
        assert!(tight_data(&Value::Null, "workspace-read", |_, _| true).is_none());
    }
    #[test]
    fn tight_policy_keeps_head_newest_failures_and_protocol_identity() {
        let old = read_message("old", "v1", 1, &"x".repeat(8000));
        let newest = read_message("new", "v2", 1, &"y".repeat(8000));
        let failed = serde_json::json!({"role":"tool","tool_call_id":"bad","content":
            serde_json::json!({"status":"failed","callId":"bad","error":{"message":"e".repeat(4000)}}).to_string()});
        let mut messages = vec![
            serde_json::json!({"role":"system","content":"rules"}),
            serde_json::json!({"role":"user","content":"attachment and exact request"}),
            serde_json::json!({"role":"assistant","content":"read"}),
            old.clone(),
            failed.clone(),
            serde_json::json!({"role":"assistant","content":"read again"}),
            newest.clone(),
        ];
        let head = messages[..2].to_vec();
        let saved = prepare_owned_model_request_with_policy(&mut messages, EvidencePolicy::Tight);
        assert!(saved > 7000, "saved only {saved} bytes");
        assert_eq!(messages[..2], head);
        assert_eq!(messages[4], failed);
        assert_eq!(messages[6], newest);
        assert_eq!(messages[3]["tool_call_id"], old["tool_call_id"]);
        let stub = parsed(&messages[3]);
        assert_eq!(stub["callId"], "old");
        assert_eq!(stub["result"]["data"]["contentHash"], "v1");
        assert!(stub["result"]["data"]["spill"].is_string());
        assert!(stub["result"]["data"].get("content").is_none());
        assert_eq!(
            prepare_owned_model_request_with_policy(&mut messages, EvidencePolicy::Tight),
            0
        );
    }
}
