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
///
/// A failed resume stays on the tapered window. The first turn after a model
/// switch does not: that model has no provider session, so it gets every user
/// and assistant message still stored for the chat.
pub(super) fn acp_conversation_history_text_for_session(session_id: &str) -> Option<String> {
    let session_uuid = parse_uuid(session_id).ok()?;
    let store = open_store().ok()?;
    // Scan the existing bounded event window before selecting conversation.
    // Tool activity must not consume the 40-message history allowance.
    let events = store.read_events(session_uuid).ok()?;
    if model_switch_awaits_first_reply(&events) {
        let transcript = store.read_transcript_events(session_uuid).unwrap_or(events);
        return conversation_history_from_events_full(transcript);
    }
    if super::efficiency::config().policies() && super::efficiency::config().task_state {
        let context = store.read_efficiency_context_events(session_uuid).ok()?;
        if let Some(record) = context
            .iter()
            .rev()
            .filter(|e| e.kind == SessionEventKind::TaskCheckpoint)
            .find_map(|e| {
                serde_json::from_value::<gyro_core::efficiency::checkpoint::TaskCheckpoint>(
                    e.payload.clone(),
                )
                .ok()
            })
        {
            let recent = events
                .into_iter()
                .filter(|e| {
                    e.created_at
                        > context
                            .iter()
                            .rev()
                            .find(|e| e.kind == SessionEventKind::TaskCheckpoint)
                            .map(|e| e.created_at)
                            .unwrap_or_default()
                })
                .collect();
            return Some(format!(
                "{}\n{}",
                record.handoff(),
                conversation_history_from_events(recent).unwrap_or_default()
            ));
        }
    }
    conversation_history_from_events(events)
}

fn local_context_checkpoint(event: &SessionEvent) -> Option<&str> {
    (event.kind == SessionEventKind::SystemEvent)
        .then(|| event.payload.get("contextSummary"))
        .flatten()
        .and_then(serde_json::Value::as_str)
}

/// What a manual `/compact` did to the handoff history without a model call.
///
/// Every provider without a resumable compacted session (everything except a
/// Codex session) rewrites the transcript here. The rewrite is local, so the
/// two honest outcomes are `kept` (the history already fit) and `condensed`
/// (full turns were replaced by a digest). Neither is a summary, and callers
/// must not describe it as one.
pub(super) struct LocalCompaction {
    /// The text stored as the checkpoint and sent as the next turn's context.
    pub(super) text: String,
    /// Turns whose full text was replaced by the digest. Zero when the history
    /// already fit the window.
    pub(super) condensed_turns: usize,
}

impl LocalCompaction {
    /// The word the activity row and the transcript card may use.
    pub(super) fn mode(&self) -> &'static str {
        if self.condensed_turns == 0 {
            "kept"
        } else {
            "condensed"
        }
    }
}

pub(super) fn local_compaction_summary(events: &[SessionEvent]) -> Option<LocalCompaction> {
    let since = events
        .iter()
        .rposition(|event| local_context_checkpoint(event).is_some())
        .map_or(0, |index| index + 1);
    if !events[since..].iter().any(|event| {
        event.kind == SessionEventKind::AssistantMessage && !event.message.trim().is_empty()
    }) {
        return None;
    }
    let lines = history_lines(events.to_vec());
    let history = join_history(&lines)?;
    const MAX_CHARS: usize = 8_000;
    if history.chars().count() <= MAX_CHARS {
        return Some(LocalCompaction {
            text: history,
            condensed_turns: 0,
        });
    }
    let (prefix, condensed, tail) = split_compacted_history(lines);
    let digest = condensed_turns_digest(&condensed);
    Some(LocalCompaction {
        text: format!(
            "{prefix}\n\n[Earlier turns condensed — full text no longer sent]\n{digest}\n\n{tail}"
        ),
        condensed_turns: condensed.len(),
    })
}

/// Split a tapered history into the head, the middle, and the tail.
///
/// The head is background, the tail is the thread being continued, and the
/// middle is what a character cap cannot carry whole. It is returned rather
/// than dropped so the checkpoint can describe it turn by turn instead of
/// leaving a hole where the conversation used to be.
fn split_compacted_history(
    lines: Vec<(String, String)>,
) -> (String, Vec<(String, String)>, String) {
    const PREFIX_CHARS: usize = 1_500;
    const TAIL_CHARS: usize = 4_800;

    let mut prefix = String::new();
    let mut head = 0;
    while head < lines.len() {
        let line = history_line(&lines[head]);
        if prefix.chars().count() + line.chars().count() + 2 > PREFIX_CHARS {
            break;
        }
        if !prefix.is_empty() {
            prefix.push_str("\n\n");
        }
        prefix.push_str(&line);
        head += 1;
    }

    let mut tail_parts: Vec<String> = Vec::new();
    let mut tail_chars = 0;
    let mut end = lines.len();
    while end > head {
        let line = history_line(&lines[end - 1]);
        if tail_chars + line.chars().count() + 2 > TAIL_CHARS {
            break;
        }
        tail_chars += line.chars().count() + 2;
        tail_parts.push(line);
        end -= 1;
    }
    tail_parts.reverse();

    // Keep at least one turn in the middle when there is more history than the
    // head and tail budgets can hold, so a checkpoint always describes what it
    // took out instead of cutting silently.
    if end <= head && head < lines.len() {
        end = head + 1;
    }

    (prefix, lines[head..end].to_vec(), tail_parts.join("\n\n"))
}

/// One line per condensed turn: who spoke and what the turn was about.
///
/// The full text is gone either way; this keeps the decisions and the subject
/// so the next prompt is not starting from a blank where forty turns used to
/// be. No paraphrase is attempted, because that would need a model call and
/// this path deliberately does not make one.
fn condensed_turns_digest(condensed: &[(String, String)]) -> String {
    const DIGEST_TURN_CHARS: usize = 200;
    const DIGEST_CHARS: usize = 1_600;

    let mut digest = Vec::new();
    let mut used = 0;
    for (role, text) in condensed {
        let first = text
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or(text.as_str());
        let clipped: String = first.chars().take(DIGEST_TURN_CHARS).collect();
        let elided = first.chars().count() > DIGEST_TURN_CHARS;
        let line = format!("- {role}: {clipped}{}", if elided { "…" } else { "" });
        // The digest rides in front of the tail inside the same 8,000-character
        // checkpoint budget, so it stops before it can refill the window it is
        // meant to shrink.
        if used + line.chars().count() + 1 > DIGEST_CHARS && !digest.is_empty() {
            break;
        }
        used += line.chars().count() + 1;
        digest.push(line);
    }
    let hidden = condensed.len().saturating_sub(digest.len());
    if hidden > 0 {
        digest.push(format!("- …and {hidden} more turns"));
    }
    digest.join("\n")
}

fn is_model_switch(event: &SessionEvent) -> bool {
    event.kind == SessionEventKind::SystemEvent
        && event
            .payload
            .get("kind")
            .and_then(serde_json::Value::as_str)
            == Some("model-switch")
}

/// True when the latest model switch has not yet received an assistant reply.
///
/// That turn opens a fresh provider session, so the prompt has to carry the
/// chat the previous model already had.
fn model_switch_awaits_first_reply(events: &[SessionEvent]) -> bool {
    let Some(switch_at) = events.iter().rposition(is_model_switch) else {
        return false;
    };
    !events[switch_at + 1..].iter().any(|event| {
        event.kind == SessionEventKind::AssistantMessage && !event.message.trim().is_empty()
    })
}

/// The handoff history as message lines: role plus text, already tapered.
fn history_lines(events: Vec<SessionEvent>) -> Vec<(String, String)> {
    collect_history_lines(events, true)
}

fn history_lines_full(events: Vec<SessionEvent>) -> Vec<(String, String)> {
    collect_history_lines(events, false)
}

fn collect_history_lines(events: Vec<SessionEvent>, taper: bool) -> Vec<(String, String)> {
    let mut lines: Vec<(String, String)> = Vec::new();
    for event in events {
        if let Some(summary) = local_context_checkpoint(&event) {
            lines.clear();
            lines.push(("Context summary".to_string(), summary.to_string()));
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
        lines.push((role.to_string(), text.to_string()));
    }
    // Drop the trailing user line — it is the message currently being sent and
    // already lives in the main prompt. Dropped before the taper so it does not
    // spend one of the full-length slots on text the prompt already carries.
    if lines.last().is_some_and(|(role, _)| role == "User") {
        lines.pop();
    }
    if !taper {
        return lines;
    }
    if lines.len() > 40 {
        let summary = lines
            .first()
            .filter(|(role, _)| role.as_str() == "Context summary")
            .cloned();
        lines.drain(..lines.len() - if summary.is_some() { 39 } else { 40 });
        if let Some(summary) = summary {
            lines.insert(0, summary);
        }
    }
    // Clip from the far end: the tail is the thread being continued, the head
    // is background.
    let recent_from = lines.len().saturating_sub(HISTORY_RECENT_TURNS);
    lines
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
            (
                role,
                format!("{clipped}{}", if elided { " […]" } else { "" }),
            )
        })
        .collect()
}

/// The handoff history as one string: what the model is given when Gyro has to
/// reconstruct the conversation instead of resuming a provider session.
fn conversation_history_from_events(events: Vec<SessionEvent>) -> Option<String> {
    join_history(&history_lines(events))
}

fn conversation_history_from_events_full(events: Vec<SessionEvent>) -> Option<String> {
    join_history(&history_lines_full(events))
}

fn history_line((role, text): &(String, String)) -> String {
    format!("{role}: {text}")
}

fn join_history(lines: &[(String, String)]) -> Option<String> {
    let joined = lines
        .iter()
        .map(history_line)
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
        assert!(summary.text.contains("Keep the design blue"));
        assert!(!summary.text.contains("/compact"));
        // A short chat is kept whole; calling that a summary is the bug this
        // mode exists to prevent.
        assert_eq!(summary.condensed_turns, 0);
        assert_eq!(summary.mode(), "kept");
        let checkpoint = SessionEvent::new(
            session,
            SessionEventKind::SystemEvent,
            "Compacted context",
            serde_json::json!({ "contextSummary": summary.text }),
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
        assert!(summary.text.chars().count() <= 8_000);
        assert!(summary.text.contains("[Earlier turns condensed"));
        assert!(summary.condensed_turns > 0);
        assert_eq!(summary.mode(), "condensed");
        events.push(SessionEvent::new(
            session,
            SessionEventKind::SystemEvent,
            "Compacted context",
            serde_json::json!({ "contextSummary": summary.text }),
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

    #[test]
    fn model_switch_handoff_sends_every_message_unclipped() {
        let session = Uuid::new_v4();
        let mut events: Vec<_> = (0..45)
            .map(|index| {
                SessionEvent::new(
                    session,
                    SessionEventKind::AssistantMessage,
                    format!("message-{index:02} {}", "x".repeat(3_000)),
                    serde_json::json!({}),
                )
            })
            .collect();
        events.push(SessionEvent::new(
            session,
            SessionEventKind::SystemEvent,
            "Switched to Grok 4.7",
            serde_json::json!({"kind": "model-switch", "modelId": "grok-4"}),
        ));
        events.push(SessionEvent::new(
            session,
            SessionEventKind::UserMessage,
            "Current request",
            serde_json::json!({}),
        ));
        assert!(model_switch_awaits_first_reply(&events));
        let history = conversation_history_from_events_full(events).unwrap();
        let messages: Vec<_> = history.split("\n\n").collect();
        assert_eq!(messages.len(), 45);
        assert!(messages[0].starts_with("Assistant: message-00"));
        assert!(messages[0].contains(&"x".repeat(3_000)));
        assert!(!messages[0].contains("[…]"));
        assert!(messages[44].starts_with("Assistant: message-44"));
        assert!(!history.contains("Current request"));
        assert!(!history.contains("Switched to Grok"));
    }

    #[test]
    fn model_switch_after_a_reply_is_no_longer_the_handoff_turn() {
        let session = Uuid::new_v4();
        let events = vec![
            SessionEvent::new(
                session,
                SessionEventKind::SystemEvent,
                "Switched to Grok 4.7",
                serde_json::json!({"kind": "model-switch"}),
            ),
            SessionEvent::new(
                session,
                SessionEventKind::AssistantMessage,
                "Picked up the thread",
                serde_json::json!({}),
            ),
            SessionEvent::new(
                session,
                SessionEventKind::UserMessage,
                "Next request",
                serde_json::json!({}),
            ),
        ];
        assert!(!model_switch_awaits_first_reply(&events));
    }
}
