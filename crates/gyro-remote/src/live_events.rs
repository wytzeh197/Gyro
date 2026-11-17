//! Bounded in-memory catch-up for clients opening an already-running chat.
//! Durable history remains authoritative. Producers own payload redaction;
//! this buffer bounds and compacts the same events sent to live subscribers.
use serde_json::Value;
use std::collections::{HashMap, VecDeque};

const MAX_SESSIONS: usize = 16;
const MAX_BYTES: usize = 1024 * 1024;
const MAX_EVENTS: usize = 2048;

#[derive(Default)]
pub struct LiveEvents {
    sessions: HashMap<String, Frames>,
    order: VecDeque<String>,
}
#[derive(Default)]
struct Frames {
    turn: Option<String>,
    bytes: usize,
    truncated: bool,
    events: VecDeque<(Value, usize)>,
}
impl LiveEvents {
    pub fn push(&mut self, session: &str, payload: Value) {
        let bytes = payload.to_string().len();
        self.order.retain(|id| id != session);
        self.order.push_back(session.into());
        while self.order.len() > MAX_SESSIONS {
            if let Some(id) = self.order.pop_front() {
                self.sessions.remove(&id);
            }
        }
        let frames = self.sessions.entry(session.into()).or_default();
        let turn = payload
            .get("turnId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if turn.is_some() && frames.turn != turn {
            *frames = Frames {
                turn,
                ..Frames::default()
            };
        }
        // Compact adjacent token deltas into a cumulative checkpoint segment.
        // Keep the final sequence as the cursor; replay bypasses live ordering.
        if payload["phase"] == "delta" {
            if let Some((last, size)) = frames.events.back_mut() {
                if last["phase"] == "delta"
                    && last["timelineOrder"] == payload["timelineOrder"]
                    && last["turnId"] == payload["turnId"]
                {
                    if let (Some(before), Some(delta)) =
                        (last["textDelta"].as_str(), payload["textDelta"].as_str())
                    {
                        let mut text = before.to_owned();
                        let remaining = (256 * 1024usize).saturating_sub(text.len());
                        let mut end = delta.len().min(remaining);
                        while !delta.is_char_boundary(end) {
                            end -= 1;
                        }
                        text.push_str(&delta[..end]);
                        frames.truncated |= end < delta.len();
                        let mut merged = payload;
                        merged["textDelta"] = Value::String(text);
                        frames.bytes -= *size;
                        *size = merged.to_string().len();
                        frames.bytes += *size;
                        *last = merged;
                        self.trim(session);
                        return;
                    }
                }
            }
        }
        if bytes > MAX_BYTES {
            frames.truncated = true;
            return;
        }
        frames.bytes += bytes;
        frames.events.push_back((payload, bytes));
        self.trim(session);
    }
    fn trim(&mut self, session: &str) {
        let frames = self.sessions.get_mut(session).unwrap();
        while frames.bytes > MAX_BYTES || frames.events.len() > MAX_EVENTS {
            if let Some((_, size)) = frames.events.pop_front() {
                frames.bytes -= size;
                frames.truncated = true;
            }
        }
    }
    pub fn truncated(&self, session: &str) -> bool {
        self.sessions
            .get(session)
            .is_some_and(|frames| frames.truncated)
    }
    pub fn snapshot(&self, session: &str) -> Vec<Value> {
        self.sessions
            .get(session)
            .map(|frames| {
                frames
                    .events
                    .iter()
                    .map(|(event, _)| event.clone())
                    .collect()
            })
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn thousands_of_tokens_replay_the_whole_prefix_with_a_final_cursor() {
        let mut live = LiveEvents::default();
        for sequence in 0..10_000 {
            live.push("a", json!({"sessionId":"a", "turnId":"t", "phase":"delta", "eventId":format!("frame-{sequence}"), "timelineOrder":1, "sequence":sequence, "textDelta":"x"}));
        }
        let events = live.snapshot("a");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["textDelta"].as_str().unwrap().len(), 10_000);
        assert_eq!(events[0]["sequence"], 9999);
        assert!(!live.truncated("a"));
    }
    #[test]
    fn catchup_contains_text_tools_and_context_only_for_the_current_session_and_turn() {
        let mut live = LiveEvents::default();
        for (sequence, phase) in ["started", "delta", "activity", "context-usage"]
            .iter()
            .enumerate()
        {
            live.push(
                "a",
                json!({"turnId":"one","sequence":sequence,"phase":phase}),
            );
        }
        live.push("b", json!({"turnId":"other","phase":"delta"}));
        assert_eq!(live.snapshot("a").len(), 4);
        live.push("a", json!({"turnId":"two","phase":"started"}));
        assert_eq!(live.snapshot("a").len(), 1);
        assert_eq!(live.snapshot("b").len(), 1);
    }
    #[test]
    fn catchup_is_bounded_by_frames_bytes_and_sessions() {
        let mut live = LiveEvents::default();
        for i in 0..MAX_EVENTS + 1 {
            live.push("a", json!({"sequence":i}));
        }
        assert_eq!(live.snapshot("a").len(), MAX_EVENTS);
        assert_eq!(live.snapshot("a")[0]["sequence"], 1);
        for _ in 0..4 {
            live.push("b", json!({"textDelta":"x".repeat(MAX_BYTES / 3)}));
        }
        assert!(live.sessions["b"].bytes <= MAX_BYTES);
        for i in 0..MAX_SESSIONS {
            live.push(&format!("s{i}"), json!({"phase":"started"}));
        }
        assert!(live.snapshot("a").is_empty());
        assert_eq!(live.sessions.len(), MAX_SESSIONS);
    }
}
