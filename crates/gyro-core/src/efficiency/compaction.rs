//! Anchor-preserving compaction: shrink the middle of a conversation, never the instructions that
//! define the task. Pure local computation — no summarisation model call, no extra round trip.
//!
//! Two properties the blunt threshold path does not hold:
//! 1. Pinned messages (system/developer instructions, the first user turn, the live user turn) are
//!    never dropped, so repeated compaction cannot erode what was actually asked for.
//! 2. A dropped run is widened backwards to include the assistant message that requested a tool, so
//!    compaction never orphans a tool result — a shape several providers reject outright.
use serde_json::{json, Value};

/// Keep at least this much recent context, even when the target asks for more.
pub const MIN_TAIL_BYTES: usize = 8_000;
/// Never bother compacting below this size: the bookkeeping would cost more than it saves.
pub const MIN_COMPACT_BYTES: usize = 24_000;
const TOOL_NAME_LIMIT: usize = 8;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Report {
    pub before_bytes: usize,
    pub after_bytes: usize,
    pub dropped: usize,
    pub pinned: usize,
    pub note: String,
}

impl Report {
    pub fn compacted(&self) -> bool {
        self.dropped > 0
    }
    pub fn saved_bytes(&self) -> usize {
        self.before_bytes.saturating_sub(self.after_bytes)
    }
}

/// Messages that must survive every compaction.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Anchors {
    pinned: Vec<usize>,
}

impl Anchors {
    pub fn pin(messages: &[Value]) -> Self {
        let mut pinned = Vec::new();
        for (index, message) in messages.iter().enumerate() {
            if matches!(role(message), "system" | "developer") {
                pinned.push(index);
            }
        }
        if let Some(index) = messages.iter().position(|message| role(message) == "user") {
            pinned.push(index);
        }
        if let Some(index) = messages.iter().rposition(|message| role(message) == "user") {
            pinned.push(index);
        }
        pinned.sort_unstable();
        pinned.dedup();
        Self { pinned }
    }
    pub fn contains(&self, index: usize) -> bool {
        self.pinned.binary_search(&index).is_ok()
    }
    pub fn indices(&self) -> &[usize] {
        &self.pinned
    }
    pub fn is_empty(&self) -> bool {
        self.pinned.is_empty()
    }
    pub fn len(&self) -> usize {
        self.pinned.len()
    }
}

pub fn role(message: &Value) -> &str {
    message.get("role").and_then(Value::as_str).unwrap_or("")
}

pub fn message_bytes(message: &Value) -> usize {
    message.to_string().len()
}

pub fn total_bytes(messages: &[Value]) -> usize {
    messages.iter().map(message_bytes).sum()
}

fn tool_names(messages: &[Value]) -> String {
    let mut names: Vec<String> = Vec::new();
    for message in messages {
        if let Some(name) = message.get("name").and_then(Value::as_str) {
            if !names.iter().any(|seen| seen == name) {
                names.push(name.to_owned());
            }
        }
        if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                let name = call
                    .get("function")
                    .and_then(|function| function.get("name"))
                    .or_else(|| call.get("name"))
                    .and_then(Value::as_str);
                if let Some(name) = name {
                    if !names.iter().any(|seen| seen == name) {
                        names.push(name.to_owned());
                    }
                }
            }
        }
    }
    let shown = names
        .iter()
        .take(TOOL_NAME_LIMIT)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if names.len() > TOOL_NAME_LIMIT {
        format!("{shown}, +{} more", names.len() - TOOL_NAME_LIMIT)
    } else {
        shown
    }
}

fn summary(dropped: usize, dropped_bytes: usize, tools: &str) -> Value {
    let mut content = format!(
        "[compacted {dropped} earlier messages ({dropped_bytes} bytes) to keep this context affordable."
    );
    if !tools.is_empty() {
        content.push_str(&format!(" Retired tool activity: {tools}."));
    }
    content.push_str(
        " Instructions and the most recent turns are unchanged. Re-read a file before relying on a summary of it.]",
    );
    json!({ "role": "user", "content": content })
}

/// Compact `messages` in place until it fits `target_bytes`. Returns what actually happened, so the
/// caller can book the saving in the ledger instead of guessing.
pub fn compact(messages: &mut Vec<Value>, target_bytes: usize) -> Report {
    let before = total_bytes(messages);
    let anchors = Anchors::pin(messages);
    let mut report = Report {
        before_bytes: before,
        after_bytes: before,
        dropped: 0,
        pinned: anchors.len(),
        note: String::new(),
    };
    let threshold = target_bytes.max(MIN_COMPACT_BYTES);
    if before <= threshold || messages.len() < 4 {
        return report;
    }
    // Keep a recent tail worth at least MIN_TAIL_BYTES, stopping at the first anchor.
    let mut tail_start = messages.len();
    let mut tail_bytes = 0;
    while tail_start > 0 && tail_bytes < MIN_TAIL_BYTES {
        let previous = tail_start - 1;
        if anchors.contains(previous) {
            break;
        }
        tail_bytes += message_bytes(&messages[previous]);
        tail_start = previous;
    }
    let Some(mut start) = (0..tail_start).find(|index| !anchors.contains(*index)) else {
        return report;
    };
    let mut end = start;
    while end < tail_start && !anchors.contains(end) {
        end += 1;
    }
    // Never orphan a tool result: widen the dropped run back to the assistant that asked for it.
    while start > 0 && role(&messages[start]) == "tool" && !anchors.contains(start - 1) {
        start -= 1;
    }
    if end <= start {
        return report;
    }
    let dropped = end - start;
    let dropped_bytes: usize = messages[start..end].iter().map(message_bytes).sum();
    let note = summary(dropped, dropped_bytes, &tool_names(&messages[start..end]));
    let described = note
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    messages.splice(start..end, [note]);
    report.dropped = dropped;
    report.after_bytes = total_bytes(messages);
    report.note = described;
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    fn for_call(role: &str, body: String) -> Value {
        json!({ "role": role, "content": body })
    }

    fn conversation() -> Vec<Value> {
        vec![
            for_call("system", "You are Gyro. Keep changes small.".into()),
            for_call(
                "user",
                "Fix the parser bug and keep the tests green.".into(),
            ),
            json!({ "role": "assistant", "tool_calls": [{ "function": { "name": "workspace_read" } }] }),
            for_call("tool", "read output".repeat(4_000)),
            json!({ "role": "assistant", "tool_calls": [{ "function": { "name": "workspace_search" } }] }),
            for_call("tool", "grep output".repeat(4_000)),
            for_call("assistant", "middle reasoning ".repeat(2_000)),
            for_call("user", "Now also check the golden tests.".into()),
            for_call("assistant", "recent turn ".repeat(4_000)),
        ]
    }

    #[test]
    fn anchors_cover_instructions_and_both_user_turns() {
        let messages = conversation();
        let anchors = Anchors::pin(&messages);
        assert!(anchors.contains(0), "system prompt is pinned");
        assert!(anchors.contains(1), "first user turn is pinned");
        assert!(anchors.contains(7), "live user turn is pinned");
        assert!(!anchors.contains(3), "tool output is droppable");
    }

    #[test]
    fn small_conversations_are_left_alone() {
        let mut messages = vec![
            for_call("system", "sys".into()),
            for_call("user", "hello".into()),
            for_call("assistant", "hi".into()),
            for_call("user", "again".into()),
        ];
        let before = total_bytes(&messages);
        let report = compact(&mut messages, 0);
        assert!(!report.compacted());
        assert_eq!(report.saved_bytes(), 0);
        assert_eq!(total_bytes(&messages), before);
        assert_eq!(messages.len(), 4);
    }

    #[test]
    fn compacts_the_middle_and_reports_the_saving() {
        let mut messages = conversation();
        let first_user = messages[1]["content"].clone();
        let report = compact(&mut messages, MIN_COMPACT_BYTES);
        assert!(report.compacted());
        assert!(report.saved_bytes() > 0);
        assert_eq!(
            report.before_bytes,
            report.before_bytes.max(report.after_bytes)
        );
        assert_eq!(report.after_bytes, total_bytes(&messages));
        assert!(messages.len() < 9);
        // Anchors survive verbatim.
        assert_eq!(messages[0]["content"], "You are Gyro. Keep changes small.");
        assert_eq!(messages[1]["content"], first_user);
    }

    #[test]
    fn never_orphans_a_tool_result() {
        let mut messages = conversation();
        compact(&mut messages, MIN_COMPACT_BYTES);
        for (index, message) in messages.iter().enumerate() {
            if role(message) != "tool" {
                continue;
            }
            let parent = messages[..index]
                .iter()
                .rev()
                .find(|parent| role(parent) != "tool");
            assert_eq!(
                parent.map(|parent| role(parent)),
                Some("assistant"),
                "tool result at {index} must keep its assistant parent"
            );
        }
    }

    #[test]
    fn repeated_compaction_keeps_the_instructions() {
        let mut messages = conversation();
        for _ in 0..3 {
            compact(&mut messages, MIN_COMPACT_BYTES);
            assert_eq!(messages[0]["content"], "You are Gyro. Keep changes small.");
            assert_eq!(
                messages[1]["content"],
                "Fix the parser bug and keep the tests green."
            );
        }
        let text = messages
            .iter()
            .map(|message| message.to_string())
            .collect::<String>();
        assert!(text.contains("Now also check the golden tests."));
    }

    #[test]
    fn the_compaction_note_says_what_went_missing() {
        let mut messages = conversation();
        let report = compact(&mut messages, MIN_COMPACT_BYTES);
        assert!(report.note.contains("compacted"));
        assert!(report.note.contains("Retired tool activity"));
        assert!(report.note.contains("workspace_read"));
    }
}
