use crate::sessions::{SessionEvent, SessionEventKind};
use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use uuid::Uuid;

const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_LINE_BYTES: u64 = 1024 * 1024;
const MAX_RECORDS: usize = 100_000;
const MAX_DIAGNOSTICS: usize = 100;
const MAX_TEXT_CHARS: usize = 60_000;
const MAX_EVENTS: usize = 20_000;
/// Headroom under the 128 KiB session payload limit. Storage adds `imported`
/// after this check.
const MAX_IMPORTED_EVENT_PAYLOAD_BYTES: usize = 120 * 1024;
/// A label, status, or id. Larger values are body and are dropped only when
/// the payload is still over the ceiling after the attachment trim.
const MAX_IMPORTED_DISPLAY_FIELD_BYTES: usize = 1024;

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
        if fit_imported_event_payload(&mut event.payload, sequence + 1)? {
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

/// Compact JSON length of `value`, without retaining the encoded buffer.
fn json_byte_len(value: &Value) -> Result<usize> {
    struct ByteCounter(usize);

    impl Write for ByteCounter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0 = self.0.saturating_add(buf.len());
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    let mut counter = ByteCounter(0);
    serde_json::to_writer(&mut counter, value)?;
    Ok(counter.0)
}

/// Keep harmless display metadata. Never keep an oversized provider payload.
///
/// Returns whether anything was omitted. A payload that already fits is left
/// untouched. Attachments are removed and `detail` is capped first. Fields
/// larger than a label are dropped only if that is not enough. A value that
/// is still too big, including a non-object, becomes the timeline markers.
fn fit_imported_event_payload(payload: &mut Value, timeline_sequence: usize) -> Result<bool> {
    if json_byte_len(payload)? <= MAX_IMPORTED_EVENT_PAYLOAD_BYTES {
        return Ok(false);
    }
    let detail = payload
        .get("detail")
        .and_then(Value::as_str)
        .map(|value| value.chars().take(20_000).collect::<String>());
    if let Some(object) = payload.as_object_mut() {
        object.remove("attachments");
        if let Some(detail) = detail {
            object.insert("detail".into(), json!(detail));
        }
    }
    if json_byte_len(payload)? > MAX_IMPORTED_EVENT_PAYLOAD_BYTES {
        if let Some(object) = payload.as_object() {
            let bulky = object
                .iter()
                .filter(|(_, value)| {
                    json_byte_len(value).unwrap_or(usize::MAX) > MAX_IMPORTED_DISPLAY_FIELD_BYTES
                })
                .map(|(key, _)| key.clone())
                .collect::<Vec<_>>();
            if let Some(object) = payload.as_object_mut() {
                for key in bulky {
                    object.remove(&key);
                }
            }
        }
    }
    if json_byte_len(payload)? > MAX_IMPORTED_EVENT_PAYLOAD_BYTES || !payload.is_object() {
        *payload = json!({
            "timelineSequence": timeline_sequence,
            "historical": true,
        });
    }
    Ok(true)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::SessionEventKind;

    fn conversation(payload: Value) -> ParsedConversation {
        let now = Utc::now();
        ParsedConversation {
            session_id: "11111111-1111-4111-8111-111111111111".into(),
            workspace_path: "/tmp/gyro-import-fixture".into(),
            title: "Imported".into(),
            model_id: None,
            created_at: now,
            updated_at: now,
            events: vec![
                event(
                    SessionEventKind::UserMessage,
                    "hello".into(),
                    now,
                    None,
                    json!({}),
                ),
                event(
                    SessionEventKind::SystemEvent,
                    "tool".into(),
                    now,
                    None,
                    payload,
                ),
            ],
            diagnostics: Vec::new(),
        }
    }

    fn tool_payload(parsed: &ParsedConversation) -> &Value {
        &parsed.events[1].payload
    }

    fn omitted(parsed: &ParsedConversation) -> bool {
        parsed
            .diagnostics
            .iter()
            .any(|line| line.contains("oversized attachment"))
    }

    #[test]
    fn json_byte_len_matches_compact_json() {
        let quotes = Value::String("\"".repeat(32));
        let crabs = json!({"detail": "🦀".repeat(40)});
        for value in [quotes, crabs] {
            assert_eq!(
                json_byte_len(&value).unwrap(),
                serde_json::to_vec(&value).unwrap().len()
            );
        }
    }

    #[test]
    fn payload_on_the_ceiling_is_kept() {
        let shell = json!({
            "historical": true,
            "pad": "",
            "timelineSequence": 2,
        });
        let slack = MAX_IMPORTED_EVENT_PAYLOAD_BYTES - json_byte_len(&shell).unwrap();
        let fitting = json!({"pad": "x".repeat(slack)});
        let kept = finish(conversation(fitting)).unwrap().unwrap();
        let payload = tool_payload(&kept);
        assert!(!omitted(&kept));
        assert_eq!(payload["pad"].as_str().unwrap().len(), slack);
        assert_eq!(
            json_byte_len(payload).unwrap(),
            MAX_IMPORTED_EVENT_PAYLOAD_BYTES
        );

        let over = json!({"pad": "x".repeat(slack + 1)});
        let trimmed = finish(conversation(over)).unwrap().unwrap();
        let payload = tool_payload(&trimmed);
        assert!(omitted(&trimmed));
        assert!(payload.get("pad").is_none());
        assert_eq!(payload["historical"], true);
        assert_eq!(payload["timelineSequence"], 2);
        assert!(json_byte_len(payload).unwrap() <= MAX_IMPORTED_EVENT_PAYLOAD_BYTES);
    }

    #[test]
    fn removing_attachments_keeps_the_rest_of_a_fitting_payload() {
        let payload = json!({
            "tool": "read",
            "detail": "ok",
            "attachments": [{"data": "x".repeat(130 * 1024)}],
        });
        let finished = finish(conversation(payload)).unwrap().unwrap();
        let payload = tool_payload(&finished);
        assert!(omitted(&finished));
        assert!(payload.get("attachments").is_none());
        assert_eq!(payload["tool"], "read");
        assert_eq!(payload["detail"], "ok");
        assert!(json_byte_len(payload).unwrap() <= MAX_IMPORTED_EVENT_PAYLOAD_BYTES);
    }

    #[test]
    fn long_detail_is_capped_before_other_fields_are_dropped() {
        let payload = json!({
            "tool": "exec",
            "detail": "d".repeat(130_000),
        });
        let finished = finish(conversation(payload)).unwrap().unwrap();
        let payload = tool_payload(&finished);
        assert!(omitted(&finished));
        assert_eq!(payload["tool"], "exec");
        assert_eq!(payload["detail"].as_str().unwrap().len(), 20_000);
        assert!(json_byte_len(payload).unwrap() <= MAX_IMPORTED_EVENT_PAYLOAD_BYTES);
    }

    #[test]
    fn bulky_fields_are_dropped_and_labels_stay() {
        let payload = json!({
            "tool": "exec",
            "status": "done",
            "detail": "short",
            "label": "x".repeat(1022),
            "changes": "y".repeat(130 * 1024),
        });
        let finished = finish(conversation(payload)).unwrap().unwrap();
        let payload = tool_payload(&finished);
        assert!(omitted(&finished));
        assert!(payload.get("changes").is_none());
        assert_eq!(payload["tool"], "exec");
        assert_eq!(payload["status"], "done");
        assert_eq!(payload["detail"], "short");
        assert_eq!(payload["label"].as_str().unwrap().len(), 1022);
        assert!(json_byte_len(payload).unwrap() <= MAX_IMPORTED_EVENT_PAYLOAD_BYTES);

        let payload = json!({
            "tool": "exec",
            "label": "x".repeat(1023),
            "changes": "y".repeat(130 * 1024),
        });
        let finished = finish(conversation(payload)).unwrap().unwrap();
        let payload = tool_payload(&finished);
        assert!(payload.get("changes").is_none());
        assert!(payload.get("label").is_none());
        assert_eq!(payload["tool"], "exec");
    }

    #[test]
    fn many_medium_fields_fall_back_to_timeline_markers() {
        let mut payload = serde_json::Map::new();
        for index in 0..160 {
            payload.insert(format!("f{index:03}"), Value::String("x".repeat(800)));
        }
        let finished = finish(conversation(Value::Object(payload)))
            .unwrap()
            .unwrap();
        let payload = tool_payload(&finished);
        assert!(omitted(&finished));
        assert_eq!(payload["historical"], true);
        assert_eq!(payload["timelineSequence"], 2);
        assert_eq!(payload.as_object().unwrap().len(), 2);
        assert!(json_byte_len(payload).unwrap() <= MAX_IMPORTED_EVENT_PAYLOAD_BYTES);
    }

    #[test]
    fn non_object_over_the_ceiling_becomes_timeline_markers() {
        let finished = finish(conversation(Value::String("x".repeat(130 * 1024))))
            .unwrap()
            .unwrap();
        let payload = tool_payload(&finished);
        assert!(omitted(&finished));
        assert_eq!(payload["historical"], true);
        assert_eq!(payload["timelineSequence"], 2);
        assert_eq!(payload.as_object().unwrap().len(), 2);
    }

    #[test]
    fn small_payload_is_not_reported_as_omitted() {
        let finished = finish(conversation(json!({"tool": "read", "detail": "ok"})))
            .unwrap()
            .unwrap();
        let payload = tool_payload(&finished);
        assert!(!omitted(&finished));
        assert_eq!(payload["tool"], "read");
        assert_eq!(payload["detail"], "ok");
        assert_eq!(payload["historical"], true);
        assert_eq!(payload["timelineSequence"], 2);
    }
}
