use gyro_core::{SessionEvent, SessionEventKind};

const RELEASED_V1_EVENTS: &str = include_str!("fixtures/session-events-v1.jsonl");

#[test]
fn released_v1_session_events_still_decode_and_round_trip() {
    let events = RELEASED_V1_EVENTS
        .lines()
        .map(|line| serde_json::from_str::<SessionEvent>(line).unwrap())
        .collect::<Vec<_>>();

    assert_eq!(events.len(), 3);
    assert!(matches!(events[0].kind, SessionEventKind::SessionCreated));
    assert!(matches!(events[1].kind, SessionEventKind::UserMessage));
    assert_eq!(events[1].turn_id, events[2].turn_id);

    for event in events {
        let encoded = serde_json::to_string(&event).unwrap();
        let decoded: SessionEvent = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.id, event.id);
        assert_eq!(decoded.session_id, event.session_id);
        assert_eq!(decoded.turn_id, event.turn_id);
    }
}
