use super::{open_store, parse_uuid, SessionEvent, SessionEventKind};

/// Turns kept at full length before the transcript starts clipping harder.
///
/// Recent turns are what the model is actually continuing from, so they stay
/// whole. Older ones only have to carry what was decided, and at the previous
/// flat cap forty of them could put ~20K tokens in front of every prompt.
const HISTORY_RECENT_TURNS: usize = 6;
const HISTORY_RECENT_CHARS: usize = 2_000;
const HISTORY_OLDER_CHARS: usize = 400;

/// Load the local Gyro transcript for any model handoff or failed resume.
pub(super) fn acp_conversation_history_text_for_session(session_id: &str) -> Option<String> {
    let session_uuid = parse_uuid(session_id).ok()?;
    let store = open_store().ok()?;
    // Scan the existing bounded event window before selecting conversation.
    // Tool activity must not consume the 40-message history allowance.
    let events = store.read_events(session_uuid).ok()?;
    conversation_history_from_events(events)
}

fn local_context_checkpoint(event: &SessionEvent) -> Option<&str> {
    (event.kind == SessionEventKind::SystemEvent)
        .then(|| event.payload.get("contextSummary"))
        .flatten()
        .and_then(serde_json::Value::as_str)
}

pub(super) fn local_compaction_summary(events: &[SessionEvent]) -> Option<String> {
    let since = events
        .iter()
        .rposition(|event| local_context_checkpoint(event).is_some())
        .map_or(0, |index| index + 1);
    if !events[since..].iter().any(|event| {
        event.kind == SessionEventKind::AssistantMessage && !event.message.trim().is_empty()
    }) {
        return None;
    }
    let history = conversation_history_from_events(events.to_vec())?;
    const MAX_CHARS: usize = 8_000;
    const PREFIX_CHARS: usize = 1_500;
    if history.chars().count() <= MAX_CHARS {
        return Some(history);
    }
    let prefix = history.chars().take(PREFIX_CHARS).collect::<String>();
    let tail = history
        .chars()
        .rev()
        .take(MAX_CHARS - PREFIX_CHARS - 30)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    Some(format!("{prefix}\n\n[Earlier detail omitted]\n\n{tail}"))
}

fn conversation_history_from_events(events: Vec<SessionEvent>) -> Option<String> {
    let mut lines = Vec::new();
    for event in events {
        if let Some(summary) = local_context_checkpoint(&event) {
            lines.clear();
            lines.push(("Context summary", summary.to_string()));
            continue;
        }
        let role = match event.kind {
            SessionEventKind::UserMessage => "User",
            SessionEventKind::AssistantMessage => "Assistant",
            _ => continue,
        };
        let text = event.message.trim();
        if text.is_empty() || (role == "User" && text == "/compact") {
            continue;
        }
        lines.push((role, text.to_string()));
    }
    // Drop the trailing user line — it is the message currently being sent and
    // already lives in the main prompt. Dropped before the taper so it does not
    // spend one of the full-length slots on text the prompt already carries.
    if lines.last().is_some_and(|(role, _)| *role == "User") {
        lines.pop();
    }
    if lines.len() > 40 {
        let summary = lines
            .first()
            .filter(|(role, _)| *role == "Context summary")
            .cloned();
        lines.drain(..lines.len() - if summary.is_some() { 39 } else { 40 });
        if let Some(summary) = summary {
            lines.insert(0, summary);
        }
    }
    // Clip from the far end: the tail is the thread being continued, the head
    // is background.
    let recent_from = lines.len().saturating_sub(HISTORY_RECENT_TURNS);
    let joined = lines
        .into_iter()
        .enumerate()
        .map(|(index, (role, text))| {
            let budget = if role == "Context summary" {
                8_000
            } else if index >= recent_from {
                HISTORY_RECENT_CHARS
            } else {
                HISTORY_OLDER_CHARS
            };
            let clipped: String = text.chars().take(budget).collect();
            let elided = text.chars().nth(budget).is_some();
            format!("{role}: {clipped}{}", if elided { " […]" } else { "" })
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    (!joined.trim().is_empty()).then_some(joined)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn handoff_history_keeps_messages_despite_tool_activity() {
        let session = Uuid::new_v4();
        let event =
            |kind, text: &str| SessionEvent::new(session, kind, text, serde_json::json!({}));
        let mut events = vec![
            event(SessionEventKind::UserMessage, "Keep all tools available"),
            event(SessionEventKind::AssistantMessage, "Understood"),
        ];
        for _ in 0..100 {
            events.push(event(SessionEventKind::SystemEvent, "tool activity"));
        }
        events.push(event(SessionEventKind::UserMessage, "Current request"));
        let history = conversation_history_from_events(events).unwrap();
        assert!(history.contains("Keep all tools available"));
        assert!(history.contains("Understood"));
        assert!(!history.contains("tool activity"));
        assert!(!history.contains("Current request"));
    }

    #[test]
    fn local_compaction_checkpoint_replaces_older_handoff_history() {
        let session = Uuid::new_v4();
        let event =
            |kind, text: &str| SessionEvent::new(session, kind, text, serde_json::json!({}));
        let mut events = vec![
            event(SessionEventKind::UserMessage, "Keep the design blue"),
            event(SessionEventKind::AssistantMessage, "Blue is selected"),
            event(SessionEventKind::UserMessage, "/compact"),
        ];
        let summary = local_compaction_summary(&events).unwrap();
        assert!(summary.contains("Keep the design blue"));
        assert!(!summary.contains("/compact"));
        let checkpoint = SessionEvent::new(
            session,
            SessionEventKind::SystemEvent,
            "Compacted context",
            serde_json::json!({ "contextSummary": summary }),
        );
        events.push(checkpoint);
        events.push(event(SessionEventKind::UserMessage, "Use green instead"));
        events.push(event(
            SessionEventKind::AssistantMessage,
            "Green is selected",
        ));
        let history = conversation_history_from_events(events.clone()).unwrap();
        assert!(history.contains("Context summary:"));
        assert!(history.contains("Use green instead"));
        assert_eq!(history.matches("Keep the design blue").count(), 1);
        assert!(local_compaction_summary(&events).is_some());
    }

    #[test]
    fn local_checkpoint_survives_later_history_taper() {
        let session = Uuid::new_v4();
        let checkpoint = SessionEvent::new(
            session,
            SessionEventKind::SystemEvent,
            "Compacted context",
            serde_json::json!({ "contextSummary": "Important decision ".repeat(180) }),
        );
        let mut events = vec![checkpoint];
        for index in 0..45 {
            events.push(SessionEvent::new(
                session,
                SessionEventKind::AssistantMessage,
                format!("Later reply {index}"),
                serde_json::json!({}),
            ));
        }
        let history = conversation_history_from_events(events).unwrap();
        assert!(history.contains(&"Important decision ".repeat(180)));
        assert!(history.contains("Later reply 44"));
    }

    #[test]
    fn local_compaction_requires_new_reply_and_bounds_checkpoint() {
        let session = Uuid::new_v4();
        let mut events = vec![
            SessionEvent::new(
                session,
                SessionEventKind::UserMessage,
                "Long task",
                serde_json::json!({}),
            ),
            SessionEvent::new(
                session,
                SessionEventKind::AssistantMessage,
                "a".repeat(20_000),
                serde_json::json!({}),
            ),
        ];
        for index in 0..30 {
            events.push(SessionEvent::new(
                session,
                SessionEventKind::AssistantMessage,
                format!("message-{index} {}", "b".repeat(3_000)),
                serde_json::json!({}),
            ));
        }
        let summary = local_compaction_summary(&events).unwrap();
        assert!(summary.chars().count() <= 8_000);
        assert!(summary.contains("[Earlier detail omitted]"));
        events.push(SessionEvent::new(
            session,
            SessionEventKind::SystemEvent,
            "Compacted context",
            serde_json::json!({ "contextSummary": summary }),
        ));
        assert!(local_compaction_summary(&events).is_none());
    }

    #[test]
    fn handoff_history_keeps_its_message_and_character_limits() {
        let session = Uuid::new_v4();
        let events = (0..45)
            .map(|index| {
                SessionEvent::new(
                    session,
                    SessionEventKind::AssistantMessage,
                    format!("message-{index:02} {}", "x".repeat(3_000)),
                    serde_json::json!({}),
                )
            })
            .collect();
        let history = conversation_history_from_events(events).unwrap();
        let messages: Vec<_> = history.split("\n\n").collect();
        assert_eq!(messages.len(), 40);
        assert!(messages[0].starts_with("Assistant: message-05"));
        assert!(messages[39].starts_with("Assistant: message-44"));
        assert!(messages[0].chars().count() < 450);
        assert!(messages[39].chars().count() > 2_000);
        assert!(messages[39].chars().count() < 2_050);
    }
}
