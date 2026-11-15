use gyro_core::{GyroPaths, SessionEventKind, SessionOrigin, SessionStore};
use rusqlite::Connection;
use serde_json::json;
use uuid::Uuid;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let tmp = tempfile::tempdir()?;
    let paths = GyroPaths::from_base_dir(tmp.path().join("isolated-gyro"));
    let store = SessionStore::open(paths.clone())?;
    let session = store.create_session(tmp.path(), SessionOrigin::Desktop, "audit fixture")?;
    let db = Connection::open(&paths.database_path)?;

    // Seed one indexed message so the fast-path assumes the index is complete.
    store.append_user_turn_message_with_turn_id(session.id, "seed", json!({}), Uuid::new_v4())?;
    let turn = Uuid::new_v4();
    db.execute_batch("CREATE TRIGGER audit_reject_message BEFORE INSERT ON session_turn_messages BEGIN SELECT RAISE(ABORT, 'audit injected index failure'); END;")?;
    let first = store.append_user_turn_message_with_turn_id(session.id, "same retry", json!({}), turn)?;
    db.execute_batch("DROP TRIGGER audit_reject_message;")?;
    let second = store.append_user_turn_message_with_turn_id(session.id, "same retry", json!({}), turn)?;
    let copies = store.read_events(session.id)?.iter().filter(|e| e.turn_id == Some(turn) && e.kind == SessionEventKind::UserMessage).count();
    println!("message_index_failure: append_returned_ok=true duplicate_event_ids={} durable_copies={copies}", first.id != second.id);
    assert_eq!(copies, 2, "audit finding no longer reproduces");

    let status_turn = Uuid::new_v4();
    store.append_event_with_turn_id(session.id, SessionEventKind::SystemEvent, "running", json!({"kind":"provider-status", "status":"running"}), Some(status_turn))?;
    db.execute_batch("CREATE TRIGGER audit_reject_status BEFORE INSERT ON session_turn_status BEGIN SELECT RAISE(ABORT, 'audit injected status failure'); END;")?;
    store.append_event_with_turn_id(session.id, SessionEventKind::SystemEvent, "done", json!({"kind":"provider-status", "status":"done"}), Some(status_turn))?;
    db.execute_batch("DROP TRIGGER audit_reject_status;")?;
    drop(store);
    let reopened = SessionStore::open(paths.clone())?;
    let log_status = reopened.read_events(session.id)?.into_iter().filter(|e| e.turn_id == Some(status_turn)).last().unwrap().payload["status"].clone();
    let index_status = reopened.latest_provider_status_for_turn(session.id, status_turn)?;
    let running = reopened.has_running_provider_turn(session.id)?;
    println!("status_index_failure_after_reopen: log_status={log_status} index_status={index_status:?} has_running={running}");
    assert_eq!(log_status, json!("done"));
    assert_eq!(index_status.as_deref(), Some("running"));

    db.pragma_update(None, "user_version", 9999)?;
    drop(reopened);
    let future_open = SessionStore::open(paths.clone());
    println!("future_schema: user_version=9999 open_accepted={}", future_open.is_ok());
    assert!(future_open.is_ok(), "audit finding no longer reproduces");
    Ok(())
}
