use crate::sessions::{SessionEvent, SessionEventKind};
use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use uuid::Uuid;

const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_LINE_BYTES: u64 = 1024 * 1024;
const MAX_RECORDS: usize = 100_000;
const MAX_DIAGNOSTICS: usize = 100;
const MAX_TEXT_CHARS: usize = 60_000;
const MAX_EVENTS: usize = 20_000;

pub(super) struct Transcript {
    pub records: Vec<Value>,
    pub diagnostics: Vec<String>,
}

pub(super) struct ParsedConversation {
    pub session_id: String,
    pub workspace_path: String,
    pub title: String,
    pub model_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub events: Vec<SessionEvent>,
    pub diagnostics: Vec<String>,
}

pub(super) fn read_transcript(path: &Path) -> Result<Transcript> {
    let file = File::open(path).context("Unable to read conversation")?;
    let size = file.metadata()?.len();
    if size > MAX_FILE_BYTES {
        return Err(anyhow!("Conversation exceeds the 256 MB import limit"));
    }
    // A fixed-length view avoids following a writer indefinitely.
    let mut reader = BufReader::new(file.take(size));
    let mut records = Vec::new();
    let mut diagnostics = Vec::new();
    let mut line = Vec::new();
    let mut line_number = 0;
    let mut omitted_diagnostics = 0;
    loop {
        if line_number >= MAX_RECORDS {
            report_diagnostic(
                &mut diagnostics,
                &mut omitted_diagnostics,
                "Conversation reached the 100,000 line limit; remaining records were omitted"
                    .into(),
            );
            break;
        }
        line.clear();
        let length = reader
            .by_ref()
            .take(MAX_LINE_BYTES + 1)
            .read_until(b'\n', &mut line)?;
        if length == 0 {
            break;
        }
        line_number += 1;
        if length as u64 > MAX_LINE_BYTES {
            // Discard the remainder without allocating a large line.
            let mut rest = Vec::new();
            while !line.ends_with(b"\n") {
                rest.clear();
                if reader
                    .by_ref()
                    .take(MAX_LINE_BYTES)
                    .read_until(b'\n', &mut rest)?
                    == 0
                {
                    break;
                }
                if rest.ends_with(b"\n") {
                    break;
                }
            }
            report_diagnostic(
                &mut diagnostics,
                &mut omitted_diagnostics,
                format!("Line {line_number} exceeded 1 MB and was omitted"),
            );
            continue;
        }
        if !line.ends_with(b"\n") {
            report_diagnostic(&mut diagnostics, &mut omitted_diagnostics, format!("Incomplete trailing line {line_number} was omitted; scan again after the source finishes writing"));
            break;
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        match serde_json::from_slice::<Value>(&line) {
            Ok(record) if record.is_object() => records.push(record),
            _ => report_diagnostic(
                &mut diagnostics,
                &mut omitted_diagnostics,
                format!("Malformed record on line {line_number} was omitted"),
            ),
        }
    }
    if omitted_diagnostics > 0 {
        diagnostics.push(format!(
            "{omitted_diagnostics} further import diagnostics were omitted"
        ));
    }
    Ok(Transcript {
        records,
        diagnostics,
    })
}

fn report_diagnostic(diagnostics: &mut Vec<String>, omitted: &mut usize, message: String) {
    if diagnostics.len() < MAX_DIAGNOSTICS {
        diagnostics.push(message);
    } else {
        *omitted += 1;
    }
}

pub(super) fn check_format_version(
    label: &str,
    version: Option<&str>,
    known_majors: &[u32],
    diagnostics: &mut Vec<String>,
) {
    let Some(version) = version else {
        return;
    }; // Recognizable legacy schemas omit versions.
    let major = version
        .split('.')
        .next()
        .and_then(|major| major.parse::<u32>().ok());
    if major.map_or(true, |major| !known_majors.contains(&major)) {
        let version: String = version
            .chars()
            .filter(|character| !character.is_control())
            .take(64)
            .collect();
        diagnostics.push(format!("{label} transcript version {version} is newer or unrecognized; only supported visible record formats were imported"));
    }
}

pub(super) fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_owned)
}

pub(super) fn timestamp(value: &Value) -> Option<DateTime<Utc>> {
    value
        .as_str()
        .and_then(|text| DateTime::parse_from_rfc3339(text).ok())
        .map(|date| date.with_timezone(&Utc))
}

pub(super) fn bounded_text(value: &str, diagnostics: &mut Vec<String>) -> String {
    if value.chars().count() <= MAX_TEXT_CHARS {
        return value.into();
    }
    diagnostics.push("A long message or tool result was shortened to 60,000 characters".into());
    let mut result: String = value.chars().take(MAX_TEXT_CHARS - 40).collect();
    result.push_str("\n[Remaining imported content omitted]");
    result
}

pub(super) fn title(value: Option<String>, events: &[SessionEvent]) -> String {
    value
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            events
                .iter()
                .find(|event| {
                    matches!(event.kind, SessionEventKind::UserMessage)
                        && !event.message.trim().is_empty()
                })
                .map(|event| event.message.clone())
        })
        .map(|value| {
            value
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(160)
                .collect()
        })
        .unwrap_or_else(|| "Imported conversation".into())
}

pub(super) fn event(
    kind: SessionEventKind,
    message: String,
    created_at: DateTime<Utc>,
    turn_id: Option<Uuid>,
    payload: Value,
) -> SessionEvent {
    SessionEvent {
        id: Uuid::new_v4(),
        session_id: Uuid::nil(),
        turn_id,
        created_at,
        kind,
        message,
        payload,
    }
}

/// Keep full supported prose while fitting each durable event's byte limit.
/// Split on UTF-8 boundaries and retain the same turn and timestamp.
pub(super) fn push_message(
    events: &mut Vec<SessionEvent>,
    kind: SessionEventKind,
    message: &str,
    created_at: DateTime<Utc>,
    turn_id: Option<Uuid>,
    payload: Value,
    diagnostics: &mut Vec<String>,
) {
    let mut parts = Vec::new();
    let mut remaining = message;
    while remaining.len() > 63_000 {
        let mut boundary = 63_000;
        while !remaining.is_char_boundary(boundary) {
            boundary -= 1;
        }
        parts.push(&remaining[..boundary]);
        remaining = &remaining[boundary..];
    }
    parts.push(remaining);
    if parts.len() > 1 {
        diagnostics.push("A long message was split into consecutive parts to preserve it within Gyro's event limits".into());
    }
    let total = parts.len();
    for (index, part) in parts.into_iter().enumerate() {
        let mut payload = payload.clone();
        if let Some(object) = payload.as_object_mut() {
            object.insert("importedMessagePart".into(), json!(index + 1));
            object.insert("importedMessageParts".into(), json!(total));
            if index > 0 {
                object.remove("attachments");
            }
        }
        events.push(event(
            kind.clone(),
            part.into(),
            created_at,
            turn_id,
            payload,
        ));
    }
}

pub(super) fn activity(
    label: &str,
    detail: String,
    failed: bool,
    created_at: DateTime<Utc>,
    turn_id: Option<Uuid>,
    source_id: Option<&str>,
) -> SessionEvent {
    let label: String = label.chars().take(160).collect();
    event(
        SessionEventKind::SystemEvent,
        label.clone(),
        created_at,
        turn_id,
        json!({
            "kind": "provider-activity", "activityKind": "tool", "tool": label,
            "label": label, "detail": detail, "status": if failed { "failed" } else { "done" },
        "historical": true, "sourceCallId": source_id.map(|id| id.chars().take(256).collect::<String>()),
        }),
    )
}

pub(super) fn finish(mut parsed: ParsedConversation) -> Result<Option<ParsedConversation>> {
    if !parsed.events.iter().any(|event| {
        matches!(
            event.kind,
            SessionEventKind::UserMessage | SessionEventKind::AssistantMessage
        )
    }) {
        return Ok(None);
    }
    if parsed.session_id.trim().is_empty() || parsed.session_id.len() > 256 {
        return Err(anyhow!(
            "Conversation has no supported native session identity"
        ));
    }
    if !Path::new(&parsed.workspace_path).is_absolute() {
        return Err(anyhow!(
            "Conversation has no absolute workspace path in its metadata"
        ));
    }
    if parsed.workspace_path.len() > 16 * 1024 {
        return Err(anyhow!(
            "Conversation workspace metadata exceeds the supported path limit"
        ));
    }
    if parsed.events.len() > MAX_EVENTS {
        parsed.events.truncate(MAX_EVENTS);
        parsed
            .diagnostics
            .push("Only the first 20,000 conversation events were imported".into());
    }
    // Byte limits matter as well as character limits for multibyte text.
    for (sequence, event) in parsed.events.iter_mut().enumerate() {
        if event.message.len() > 63_000 {
            let boundary = event
                .message
                .char_indices()
                .take_while(|(index, _)| *index < 62_000)
                .last()
                .map(|(index, _)| index)
                .unwrap_or(0);
            event.message.truncate(boundary);
            event
                .message
                .push_str("\n[Remaining imported content omitted]");
            parsed
                .diagnostics
                .push("A message was shortened to fit Gyro's storage limit".into());
        }
        if let Some(payload) = event.payload.as_object_mut() {
            payload.insert("timelineSequence".into(), json!(sequence + 1));
            payload.insert("historical".into(), json!(true));
        }
        if serde_json::to_vec(&event.payload)?.len() > 120 * 1024 {
            // Keep harmless display metadata, never oversized provider payloads.
            let detail = event
                .payload
                .get("detail")
                .and_then(Value::as_str)
                .map(|value| value.chars().take(20_000).collect::<String>());
            if let Some(payload) = event.payload.as_object_mut() {
                payload.remove("attachments");
                if let Some(detail) = detail {
                    payload.insert("detail".into(), json!(detail));
                }
            }
            parsed
                .diagnostics
                .push("An oversized attachment or tool payload was omitted".into());
        }
    }
    parsed.title = title(Some(parsed.title), &parsed.events);
    parsed.diagnostics.sort();
    parsed.diagnostics.dedup();
    parsed.diagnostics.truncate(100);
    Ok(Some(parsed))
}

pub(super) fn attachment(name: &str, path: &str, mime: Option<&str>, available: bool) -> Value {
    let kind = if mime.is_some_and(|mime| mime.starts_with("image/")) {
        "image"
    } else {
        "workspace-file"
    };
    let size = std::fs::metadata(path)
        .ok()
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    json!({"id":Uuid::new_v4().to_string(),"kind":kind,"name":name,"path":path,"size":size,"mimeType":mime,"available":available})
}
