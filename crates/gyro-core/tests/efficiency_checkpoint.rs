use gyro_core::efficiency::checkpoint::{AgentNotes, TaskCheckpoint};
use gyro_core::{GyroPaths, SessionEvent, SessionEventKind, SessionOrigin, SessionStore};
use serde_json::json;
use uuid::Uuid;
#[test]
fn checkpoint_index_rebuilds_after_tail_and_keeps_latest_record() {
    let temp = tempfile::tempdir().unwrap();
    let paths = GyroPaths::from_base_dir(temp.path().join("store"));
    let store = SessionStore::open(paths.clone()).unwrap();
    let session = store
        .create_session(temp.path(), SessionOrigin::Desktop, "checkpoint")
        .unwrap();
    let user = store
        .append_event(
            session.id,
            SessionEventKind::UserMessage,
            "Preserve the public API",
            json!({}),
        )
        .unwrap();
    let mut cp = TaskCheckpoint::derive(session.id, &[user], "root", 1);
    cp.agent_assertions = AgentNotes {
        decisions: vec!["Use approach A".into()],
        ..Default::default()
    };
    store
        .append_event(session.id, SessionEventKind::TaskCheckpoint, "", json!(cp))
        .unwrap();
    for _ in 0..1005 {
        store
            .append_event(
                session.id,
                SessionEventKind::SystemEvent,
                "noise",
                json!({}),
            )
            .unwrap();
    }
    cp.agent_assertions.decisions = vec!["Approach A failed; use B".into()];
    store
        .append_event(session.id, SessionEventKind::TaskCheckpoint, "", json!(cp))
        .unwrap();
    drop(store);
    let reopened = SessionStore::open(paths.clone()).unwrap();
    let indexed = reopened.read_efficiency_context_events(session.id).unwrap();
    assert_eq!(
        indexed
            .iter()
            .filter(|e| e.kind == SessionEventKind::TaskCheckpoint)
            .count(),
        1
    );
    let record = TaskCheckpoint::derive(session.id, &indexed, "root", 2);
    assert_eq!(record.user_messages[0].text, "Preserve the public API");
    assert!(record.agent_assertions.decisions[0].contains("use B"));
    assert!(!record.verified);
    // SQLite is rebuildable; deleting the index causes a complete JSONL reconstruction.
    let conn = rusqlite::Connection::open(paths.database_path).unwrap();
    conn.execute("delete from session_context_events", [])
        .unwrap();
    conn.execute("delete from session_context_index", [])
        .unwrap();
    assert_eq!(
        reopened
            .read_efficiency_context_events(session.id)
            .unwrap()
            .iter()
            .filter(|e| e.kind == SessionEventKind::TaskCheckpoint)
            .count(),
        1
    );
}
#[test]
fn later_goal_status_does_not_create_a_new_task_and_clear_does() {
    let session = Uuid::new_v4();
    let goal = SessionEvent::new(
        session,
        SessionEventKind::GoalUpdated,
        "",
        json!({"action":"set","text":"Repair reconnect"}),
    );
    let first = TaskCheckpoint::derive(session, &[goal.clone()], "root", 1);
    let saved = SessionEvent::new(session, SessionEventKind::TaskCheckpoint, "", json!(first));
    let complete = SessionEvent::new(
        session,
        SessionEventKind::GoalUpdated,
        "",
        json!({"text":"Repair reconnect","status":"complete"}),
    );
    let next = TaskCheckpoint::derive(session, &[goal.clone(), saved.clone(), complete], "root", 1);
    assert_eq!(next.task_id, first.task_id);
    let clear = SessionEvent::new(
        session,
        SessionEventKind::GoalUpdated,
        "",
        json!({"action":"clear"}),
    );
    let next = TaskCheckpoint::derive(session, &[goal, saved, clear], "root", 2);
    assert_ne!(next.task_id, first.task_id);
    assert!(next.agent_assertions.decisions.is_empty());
}

#[test]
fn measurement_task_identity_is_stable_without_experimental_checkpoints() {
    let session = Uuid::new_v4();
    let initial = SessionEvent::new(
        session,
        SessionEventKind::GoalUpdated,
        "",
        json!({"action":"set","text":"Repair reconnect","status":"active"}),
    );
    let completed = SessionEvent::new(
        session,
        SessionEventKind::GoalUpdated,
        "",
        json!({"action":"set","text":"Repair reconnect","status":"complete"}),
    );
    assert_eq!(
        TaskCheckpoint::derive(session, &[initial.clone()], "root", 1).task_id,
        TaskCheckpoint::derive(session, &[initial, completed], "root", 2).task_id
    );
}
