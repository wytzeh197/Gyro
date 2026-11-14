use super::*;
use crate::{agent_sessions::AgentSessionStore, automations::AutomationStore, SessionStore};
use std::{
    io::Write,
    process::{Command, Stdio},
};

fn fixture() -> (tempfile::TempDir, GyroPaths, Connection) {
    let temp = tempfile::tempdir().unwrap();
    let paths = GyroPaths::from_base_dir(temp.path().join("data"));
    paths.ensure().unwrap();
    let conn = super::super::open_private_database(&paths.database_path).unwrap();
    conn.execute_batch("pragma wal_autocheckpoint=0; create table sentinel(value text); insert into sentinel values('committed in WAL'); pragma user_version=16;").unwrap();
    (temp, paths, conn)
}

fn sentinel(path: &Path) -> String {
    read_only(path)
        .unwrap()
        .query_row("select value from sentinel", [], |r| r.get(0))
        .unwrap()
}

#[test]
fn migration_snapshots_committed_wal_and_restore_preserves_original() {
    let (temp, paths, conn) = fixture();
    assert!(
        paths
            .database_path
            .with_extension("sqlite3-wal")
            .metadata()
            .unwrap()
            .len()
            > 0
    );
    let _store = SessionStore::open(paths.clone()).unwrap();
    let backups = list_backups(&paths).unwrap();
    assert_eq!(backups.len(), 1);
    assert_eq!(sentinel(&backups[0].path), "committed in WAL");
    let backup = read_only(&backups[0].path).unwrap();
    assert_eq!(super::super::ensure_supported_schema(&backup).unwrap(), 16);
    assert_eq!(
        super::super::ensure_supported_schema(&conn).unwrap(),
        crate::sessions::SESSION_STORE_SCHEMA_VERSION
    );
    conn.execute("update sentinel set value='newer original'", [])
        .unwrap();
    let output = temp.path().join("restored.sqlite3");
    restore_backup(&backups[0].path, &output).unwrap();
    assert_eq!(sentinel(&output), "committed in WAL");
    assert_eq!(sentinel(&paths.database_path), "newer original");
    assert!(restore_backup(&backups[0].path, &output).is_err());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&output).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&backups[0].path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn failed_migration_and_backup_failure_leave_original_usable() {
    let (_temp, paths, conn) = fixture();
    conn.execute_batch("create view sessions as select 'broken' as id;")
        .unwrap();
    assert!(SessionStore::open(paths.clone()).is_err());
    assert_eq!(sentinel(&paths.database_path), "committed in WAL");
    assert_eq!(super::super::ensure_supported_schema(&conn).unwrap(), 16);
    assert_eq!(list_backups(&paths).unwrap().len(), 1);
    conn.execute_batch("drop view sessions;").unwrap();
    fs::rename(
        paths.base_dir.join("migration-backups"),
        paths.base_dir.join("saved-backups"),
    )
    .unwrap();
    fs::write(
        paths.base_dir.join("migration-backups"),
        b"blocked directory",
    )
    .unwrap();
    assert!(SessionStore::open(paths.clone()).is_err());
    assert_eq!(super::super::ensure_supported_schema(&conn).unwrap(), 16);
    assert_eq!(sentinel(&paths.database_path), "committed in WAL");
}

#[test]
fn repeated_attempts_capture_new_writes_and_retain_three_snapshots() {
    let (_temp, paths, conn) = fixture();
    let directory = paths.base_dir.join("migration-backups");
    fs::create_dir(&directory).unwrap();
    let abandoned = directory.join(format!("{PENDING_PREFIX}abandoned"));
    fs::write(&abandoned, b"incomplete copy").unwrap();
    let unrelated = directory.join("keep.txt");
    fs::write(&unrelated, b"not a snapshot").unwrap();
    for i in 0..6 {
        conn.execute("update sentinel set value=?1", [i.to_string()])
            .unwrap();
        conn.execute_batch("begin immediate").unwrap();
        let path = before_migration(&paths, 16, 17).unwrap().unwrap();
        conn.execute_batch("rollback").unwrap();
        assert_eq!(sentinel(&path), i.to_string());
        assert_eq!(list_backups(&paths).unwrap().len(), (i + 1).min(3));
    }
    assert!(!abandoned.exists());
    assert!(unrelated.exists());
}

#[test]
fn newer_schema_is_rejected_by_every_store_including_cached_connections() {
    let (_temp, paths, conn) = fixture();
    drop(SessionStore::open(paths.clone()).unwrap());
    drop(AutomationStore::open(paths.clone()).unwrap());
    drop(AgentSessionStore::open(paths.clone()).unwrap());
    conn.execute_batch("pragma user_version=9999").unwrap();
    let before: i64 = conn
        .query_row("pragma schema_version", [], |r| r.get(0))
        .unwrap();
    for error in [
        SessionStore::open(paths.clone()).err().unwrap(),
        AutomationStore::open(paths.clone()).err().unwrap(),
        AgentSessionStore::open(paths.clone()).err().unwrap(),
        super::super::open_private_database(&paths.database_path)
            .err()
            .unwrap(),
    ] {
        assert!(format!("{error:#}").contains("newer Gyro"), "{error:#}");
    }
    assert_eq!(
        conn.query_row("pragma schema_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        before
    );
    assert_eq!(sentinel(&paths.database_path), "committed in WAL");
}

#[test]
fn fresh_database_needs_no_backup_and_corrupt_restore_leaves_no_output() {
    let temp = tempfile::tempdir().unwrap();
    let paths = GyroPaths::from_base_dir(temp.path().join("fresh"));
    drop(SessionStore::open(paths.clone()).unwrap());
    assert!(list_backups(&paths).unwrap().is_empty());
    let source = temp.path().join("corrupt.sqlite3");
    fs::write(&source, b"not sqlite").unwrap();
    let output = temp.path().join("output.sqlite3");
    assert!(restore_backup(&source, &output).is_err());
    assert!(!output.exists());
    assert!(check_space(100, Some(99)).is_err());
    assert!(check_space(100, Some(100)).is_ok());
}

#[test]
fn killing_a_migration_keeps_original_and_a_restorable_snapshot() {
    let (temp, paths, conn) = fixture();
    drop(conn);
    let ready = temp.path().join("ready");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "sqlite::recovery::tests::migration_child",
            "--ignored",
        ])
        .env("GYRO_MIGRATION_PROBE_DIR", &paths.base_dir)
        .env("GYRO_MIGRATION_PROBE_READY", &ready)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready.exists() && Instant::now() < deadline {
        if let Some(status) = child.try_wait().unwrap() {
            panic!("migration helper exited: {status}");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let completed = ready.exists();
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(completed, "migration helper failed to reach crash point");
    let original = read_only(&paths.database_path).unwrap();
    assert_eq!(
        super::super::ensure_supported_schema(&original).unwrap(),
        16
    );
    assert!(original
        .prepare("select * from uncommitted_migration")
        .is_err());
    let output = temp.path().join("restored.sqlite3");
    restore_backup(&list_backups(&paths).unwrap()[0].path, &output).unwrap();
    assert_eq!(sentinel(&output), "committed in WAL");
    drop(SessionStore::open(paths.clone()).unwrap());
    assert_eq!(sentinel(&paths.database_path), "committed in WAL");
}

#[test]
#[ignore = "subprocess helper invoked by killing_a_migration_keeps_original_and_a_restorable_snapshot"]
fn migration_child() {
    let paths =
        GyroPaths::from_base_dir(std::env::var_os("GYRO_MIGRATION_PROBE_DIR").unwrap().into());
    let conn = super::super::open_private_database(&paths.database_path).unwrap();
    conn.execute_batch("begin immediate").unwrap();
    before_migration(&paths, 16, 17).unwrap();
    conn.execute_batch("create table uncommitted_migration(value text); pragma user_version=17")
        .unwrap();
    let mut ready = File::create(std::env::var_os("GYRO_MIGRATION_PROBE_READY").unwrap()).unwrap();
    ready.write_all(b"ready").unwrap();
    ready.sync_all().unwrap();
    loop {
        std::thread::park();
    }
}
