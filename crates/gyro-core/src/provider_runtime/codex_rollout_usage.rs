//! Bounded recovery of numeric Codex usage, bound to the provider's thread and turn.
use serde_json::{json, Value};
use std::io::{BufRead, Read, Seek, SeekFrom};

const TAIL_BYTES: u64 = 2 * 1024 * 1024;

fn records(thread: &Value) -> Option<Vec<Value>> {
    let id = thread.get("id")?.as_str()?;
    let path = std::path::Path::new(thread.get("path")?.as_str()?);
    if !path.is_absolute() || path.extension()?.to_str()? != "jsonl" {
        return None;
    }
    let mut file = std::fs::File::open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() {
        return None;
    }
    let mut first = String::new();
    std::io::BufReader::new((&mut file).take(256 * 1024))
        .read_line(&mut first)
        .ok()?;
    let header: Value = serde_json::from_str(&first).ok()?;
    if header.get("type")?.as_str()? != "session_meta"
        || header.pointer("/payload/id")?.as_str()? != id
    {
        return None;
    }
    let offset = metadata.len().saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut tail = Vec::new();
    file.take(TAIL_BYTES).read_to_end(&mut tail).ok()?;
    Some(
        tail.split(|byte| *byte == b'\n')
            .skip(usize::from(offset > 0))
            .filter_map(|line| serde_json::from_slice(line).ok())
            .collect(),
    )
}

pub(super) fn baseline(thread: &Value) -> Option<Value> {
    records(thread)?.into_iter().rev().find_map(|event| {
        (event.get("type").and_then(Value::as_str) == Some("event_msg")
            && event.pointer("/payload/type").and_then(Value::as_str) == Some("token_count"))
        .then(|| event.pointer("/payload/info/total_token_usage").cloned())
        .flatten()
    })
}

/// A counter without a turn ID is usable only within matching turn boundaries.
/// A truncated tail or another turn's terminal event cannot establish ownership.
pub(super) fn ending(thread: &Value, turn: &str) -> Option<Value> {
    let mut active = false;
    let mut reading = None;
    for event in records(thread)? {
        let kind = event.get("type").and_then(Value::as_str);
        let Some(payload) = event.get("payload") else {
            continue;
        };
        let event_kind = payload.get("type").and_then(Value::as_str);
        if kind == Some("turn_context")
            || (kind == Some("event_msg") && event_kind == Some("task_started"))
        {
            active = payload.get("turn_id").and_then(Value::as_str) == Some(turn);
            // Repeated context for this same turn does not erase its receipt.
            if !active {
                reading = None;
            }
        } else if active && kind == Some("event_msg") {
            match event_kind {
                Some("token_count") => {
                    if let Some(info) = payload.get("info").filter(|info| info.is_object()) {
                        reading = Some(json!({"tokenUsage": {
                            "total": info.get("total_token_usage"),
                            "last": info.get("last_token_usage"),
                        }}));
                    }
                }
                Some("task_complete" | "turn_aborted") => {
                    return (payload.get("turn_id").and_then(Value::as_str) == Some(turn))
                        .then_some(reading)
                        .flatten();
                }
                _ => {}
            }
        }
    }
    // No terminal record: a killed writer may have left an incomplete request.
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn file(events: &[Value]) -> (tempfile::TempDir, Value) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("usage.jsonl");
        let mut file = std::fs::File::create(&path).unwrap();
        writeln!(
            file,
            "{}",
            json!({"type":"session_meta","payload":{"id":"thread"}})
        )
        .unwrap();
        for event in events {
            writeln!(file, "{event}").unwrap();
        }
        (directory, json!({"id":"thread","path":path}))
    }
    fn context(turn: &str) -> Value {
        json!({"type":"turn_context","payload":{"turn_id":turn}})
    }
    fn receipt(total: u64) -> Value {
        json!({"type":"event_msg","payload":{"type":"token_count","info":{
            "total_token_usage":{"total_tokens":total},"last_token_usage":{"total_tokens":20}}}})
    }
    fn terminal(turn: &str) -> Value {
        json!({"type":"event_msg","payload":{"type":"turn_aborted","turn_id":turn}})
    }
    #[test]
    fn ending_requires_exact_thread_turn_and_terminal_identity() {
        let (_directory, mut thread) = file(&[
            context("turn"),
            receipt(120),
            terminal("turn"),
            context("next"),
            receipt(500),
            terminal("next"),
        ]);
        assert_eq!(
            ending(&thread, "turn").unwrap()["tokenUsage"]["total"]["total_tokens"],
            120
        );
        assert_eq!(
            ending(&thread, "next").unwrap()["tokenUsage"]["total"]["total_tokens"],
            500
        );
        assert!(ending(&thread, "other").is_none());
        thread["id"] = json!("wrong-thread");
        assert!(ending(&thread, "turn").is_none());
    }
    #[test]
    fn missing_boundaries_and_interrupted_writes_cannot_claim_a_terminal_receipt() {
        for events in [
            vec![receipt(120), terminal("turn")],
            vec![context("turn"), receipt(120)],
            vec![context("turn"), receipt(120), terminal("other")],
            vec![
                context("turn"),
                receipt(120),
                context("other"),
                terminal("turn"),
            ],
        ] {
            let (_directory, thread) = file(&events);
            assert!(ending(&thread, "turn").is_none());
        }
    }
    #[test]
    fn repeated_context_does_not_erase_usage_and_unknown_records_are_ignored() {
        let (_directory, thread) = file(&[
            context("turn"),
            receipt(120),
            json!({"unrelated":true}),
            context("turn"),
            receipt(150),
            terminal("turn"),
        ]);
        assert_eq!(
            ending(&thread, "turn").unwrap()["tokenUsage"]["total"]["total_tokens"],
            150
        );
    }
    #[test]
    fn bounded_tail_without_turn_boundary_cannot_assign_usage_to_requested_turn() {
        let (_directory, thread) = file(&[context("turn")]);
        let mut output = std::fs::OpenOptions::new()
            .append(true)
            .open(thread["path"].as_str().unwrap())
            .unwrap();
        writeln!(output, "{}", " ".repeat(TAIL_BYTES as usize + 100)).unwrap();
        writeln!(output, "{}", receipt(150)).unwrap();
        writeln!(output, "{}", terminal("turn")).unwrap();
        write!(output, "{{unfinished").unwrap();
        output.flush().unwrap();
        assert!(ending(&thread, "turn").is_none());
        assert_eq!(baseline(&thread).unwrap()["total_tokens"], 150);
    }
}
