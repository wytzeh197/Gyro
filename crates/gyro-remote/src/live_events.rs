//! Bounded in-memory catch-up for clients opening an already-running chat.
//! Durable history remains authoritative; credentials never enter this buffer.
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
    events: VecDeque<(Value, usize)>,
}
impl LiveEvents {
    pub fn push(&mut self, session: &str, payload: Value) {
        let bytes = payload.to_string().len();
        if bytes > MAX_BYTES {
            return;
        }
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
        frames.bytes += bytes;
        frames.events.push_back((payload, bytes));
        while frames.bytes > MAX_BYTES || frames.events.len() > MAX_EVENTS {
            if let Some((_, size)) = frames.events.pop_front() {
                frames.bytes -= size;
            }
        }
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
