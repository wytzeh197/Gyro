use super::*;
use crate::{GyroPaths, SessionOrigin};
use serde_json::json;
use std::{
    io::Write,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn fixture() -> (tempfile::TempDir, SessionStore, crate::Session) {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("data"))).unwrap();
    let session = store
        .create_session(temp.path(), SessionOrigin::Desktop, "recovery")
        .unwrap();
    (temp, store, session)
}

#[test]
fn deleted_and_unknown_sessions_do_not_create_logs_or_break_reconciliation() {
    let (_temp, store, session) = fixture();
    store.delete_session(session.id).unwrap();
    for id in [session.id, Uuid::new_v4()] {
        assert!(!store.has_running_provider_turn(id).unwrap());
        assert!(store
            .latest_provider_status_for_turn(id, Uuid::new_v4())
            .unwrap()
            .is_none());
        assert!(!store.session_events_path(id).unwrap().exists());
    }
    assert!(store.list_running_turns().unwrap().is_empty());
}

#[test]
fn failed_message_index_commit_is_repaired_without_a_duplicate() {
    let (_temp, store, session) = fixture();
    store
        .append_user_turn_message(session.id, "seed", json!({}))
        .unwrap();
    store.conn.execute_batch("create temp trigger fail_index before insert on session_turn_messages begin select raise(abort,'injected'); end;").unwrap();
    let turn = Uuid::new_v4();
    let saved = store
        .append_user_turn_message_with_turn_id(session.id, "once", json!({}), turn)
        .unwrap();
    assert!(store
        .append_user_turn_message_with_turn_id(session.id, "once", json!({}), turn)
        .is_err());
    store
        .conn
        .execute_batch("drop trigger fail_index;")
        .unwrap();
    let replay = store
        .append_user_turn_message_with_turn_id(session.id, "once", json!({}), turn)
        .unwrap();
    assert_eq!(saved.id, replay.id);
    assert_eq!(
        store
            .read_events(session.id)
            .unwrap()
            .iter()
            .filter(|e| e.turn_id == Some(turn))
            .count(),
        1
    );
}

#[test]
fn failed_terminal_index_is_repaired_after_reopening_and_by_global_recovery() {
    let (_temp, store, session) = fixture();
    let paths = store.paths.clone();
    let turn = Uuid::new_v4();
    let status = |value: &str| json!({"kind":"provider-status","status":value});
    store
        .append_event_with_turn_id(
            session.id,
            SessionEventKind::SystemEvent,
            "running",
            status("running"),
            Some(turn),
        )
        .unwrap();
    store.conn.execute_batch("create temp trigger fail_index before insert on session_turn_status begin select raise(abort,'injected'); end;").unwrap();
    store
        .append_event_with_turn_id(
            session.id,
            SessionEventKind::SystemEvent,
            "done",
            status("done"),
            Some(turn),
        )
        .unwrap();
    store
        .conn
        .execute_batch("drop trigger fail_index;")
        .unwrap();
    drop(store);
    let store = SessionStore::open(paths).unwrap();
    assert!(store.list_running_turns().unwrap().is_empty());
    assert_eq!(
        store
            .latest_provider_status_for_turn(session.id, turn)
            .unwrap()
            .as_deref(),
        Some("done")
    );
    assert!(!store.has_running_provider_turn(session.id).unwrap());
}

#[test]
fn batch_statuses_and_unindexed_running_turns_reach_global_recovery() {
    let (_temp, store, session) = fixture();
    let turn = Uuid::new_v4();
    store.conn.execute_batch("create temp trigger fail_index before insert on session_turn_status begin select raise(abort,'injected'); end;").unwrap();
    store
        .append_system_events_with_turn_id(
            session.id,
            vec![(
                "run".into(),
                json!({"kind":"provider-status","status":"running"}),
                Some(turn),
            )],
        )
        .unwrap();
    store
        .conn
        .execute_batch("drop trigger fail_index;")
        .unwrap();
    assert_eq!(
        store.list_running_turns().unwrap(),
        vec![(session.id, turn)]
    );
}

#[test]
fn replacement_truncation_and_partial_tails_do_not_leave_stale_rows() {
    let (_temp, store, session) = fixture();
    let turn = Uuid::new_v4();
    store
        .append_user_turn_message_with_turn_id(session.id, "old", json!({}), turn)
        .unwrap();
    let replacement = session.events_path.with_extension("replacement");
    std::fs::write(&replacement, b"bad JSON\npartial").unwrap();
    std::fs::rename(replacement, &session.events_path).unwrap();
    let new = store
        .append_user_turn_message_with_turn_id(session.id, "new", json!({}), turn)
        .unwrap();
    assert_eq!(new.message, "new");
    std::fs::write(&session.events_path, b"").unwrap();
    let newer = store
        .append_user_turn_message_with_turn_id(session.id, "newer", json!({}), turn)
        .unwrap();
    assert_ne!(new.id, newer.id);
    assert_eq!(store.read_events(session.id).unwrap().len(), 1);
}

#[test]
fn warm_index_reads_only_the_new_tail_and_rolls_back_a_failed_watermark() {
    let (_temp, store, session) = fixture();
    store
        .append_system_events_with_turn_id(
            session.id,
            (0..2000)
                .map(|i| (i.to_string(), json!({}), None))
                .collect(),
        )
        .unwrap();
    let mut file = super::super::open_session_event_log_for_append(&session.events_path).unwrap();
    let _lock = lock_session_event_file(&file, SessionEventFileLockKind::Exclusive).unwrap();
    assert_eq!(
        store
            .catch_up_turn_index_locked(session.id, &session.events_path, &mut file)
            .unwrap(),
        0
    );
    let turn = Uuid::new_v4();
    let mut event = SessionEvent::new(session.id, SessionEventKind::UserMessage, "tail", json!({}));
    event.turn_id = Some(turn);
    let line = format!("{}\n", serde_json::to_string(&event).unwrap());
    file.write_all(line.as_bytes()).unwrap();
    file.sync_data().unwrap();
    store.conn.execute_batch("create temp trigger fail_mark before update on session_turn_index begin select raise(abort,'watermark failure'); end;").unwrap();
    assert!(store
        .catch_up_turn_index_locked(session.id, &session.events_path, &mut file)
        .is_err());
    assert!(store
        .indexed_turn_message(session.id, turn, &SessionEventKind::UserMessage)
        .unwrap()
        .is_none());
    store.conn.execute_batch("drop trigger fail_mark;").unwrap();
    assert_eq!(
        store
            .catch_up_turn_index_locked(session.id, &session.events_path, &mut file)
            .unwrap(),
        line.len() as u64
    );
    assert_eq!(
        store
            .catch_up_turn_index_locked(session.id, &session.events_path, &mut file)
            .unwrap(),
        0
    );
}

fn child(paths: &GyroPaths, session: Uuid, turn: Uuid, mode: &str) -> std::process::Child {
    Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "sessions::turn_index::tests::subprocess_writer",
            "--ignored",
        ])
        .env("GYRO_INDEX_PROBE_ROOT", &paths.base_dir)
        .env("GYRO_INDEX_PROBE_SESSION", session.to_string())
        .env("GYRO_INDEX_PROBE_TURN", turn.to_string())
        .env("GYRO_INDEX_PROBE_MODE", mode)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .spawn()
        .unwrap()
}

#[test]
fn separate_processes_deduplicate_after_a_writer_is_killed_after_fsync() {
    let (_temp, store, session) = fixture();
    let turn = Uuid::new_v4();
    let mut writer = child(&store.paths, session.id, turn, "crash");
    let ready = store.paths.base_dir.join("fsynced");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    let observed = ready.exists();
    writer.kill().unwrap();
    writer.wait().unwrap();
    assert!(observed, "writer did not reach fsync");
    let mut a = child(&store.paths, session.id, turn, "retry");
    let mut b = child(&store.paths, session.id, turn, "retry");
    assert!(a.wait().unwrap().success());
    assert!(b.wait().unwrap().success());
    assert_eq!(
        store
            .read_events(session.id)
            .unwrap()
            .iter()
            .filter(|e| e.turn_id == Some(turn))
            .count(),
        1
    );
}

#[test]
#[ignore = "subprocess helper; parent test supplies an isolated data root"]
fn subprocess_writer() {
    let Some(root) = std::env::var_os("GYRO_INDEX_PROBE_ROOT") else {
        return;
    };
    let store = SessionStore::open(GyroPaths::from_base_dir(root.into())).unwrap();
    let session = Uuid::parse_str(&std::env::var("GYRO_INDEX_PROBE_SESSION").unwrap()).unwrap();
    let turn = Uuid::parse_str(&std::env::var("GYRO_INDEX_PROBE_TURN").unwrap()).unwrap();
    if std::env::var("GYRO_INDEX_PROBE_MODE").unwrap() == "crash" {
        let path = store.session_events_path(session).unwrap();
        let mut file = super::super::open_session_event_log_for_append(&path).unwrap();
        let _lock = lock_session_event_file(&file, SessionEventFileLockKind::Exclusive).unwrap();
        let mut event =
            SessionEvent::new(session, SessionEventKind::UserMessage, "once", json!({}));
        event.turn_id = Some(turn);
        writeln!(file, "{}", serde_json::to_string(&event).unwrap()).unwrap();
        file.sync_data().unwrap();
        std::fs::write(store.paths.base_dir.join("fsynced"), b"ready").unwrap();
        loop {
            std::thread::park();
        }
    }
    store
        .append_user_turn_message_with_turn_id(session, "once", json!({}), turn)
        .unwrap();
}
