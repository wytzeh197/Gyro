//! Exercise the shipped command dispatch, including bypassing broken startup.
use gyro_core::{GyroPaths, SessionStore};
use std::process::{Command, Output};

fn cli(paths: &GyroPaths, arguments: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_gyro"))
        .env("GYRO_TEST_DATA_DIR", &paths.base_dir)
        .args(arguments)
        .output()
        .unwrap()
}

#[test]
fn recovery_cli_works_when_the_active_schema_is_too_new() {
    let temp = tempfile::tempdir().unwrap();
    let paths = GyroPaths::from_base_dir(temp.path().join("data"));
    paths.ensure().unwrap();
    let conn = gyro_core::open_private_database(&paths.database_path).unwrap();
    conn.execute_batch("create table sentinel(value text); insert into sentinel values('saved'); pragma user_version=16;").unwrap();
    drop(SessionStore::open(paths.clone()).unwrap());
    conn.execute_batch("pragma user_version=9999;").unwrap();

    let failed_start = cli(&paths, &["sessions", "--json"]);
    assert!(!failed_start.status.success());
    assert!(String::from_utf8_lossy(&failed_start.stderr).contains("newer Gyro"));
    let listed = cli(&paths, &["database", "backups", "--json"]);
    assert!(
        listed.status.success(),
        "{}",
        String::from_utf8_lossy(&listed.stderr)
    );
    let listed: serde_json::Value = serde_json::from_slice(&listed.stdout).unwrap();
    assert_eq!(listed["schema"], "gyro.cli.v1");
    assert_eq!(listed["backups"].as_array().unwrap().len(), 1);
    let backup = listed["backups"][0]["path"].as_str().unwrap();
    let output = temp.path().join("recovered.sqlite3");
    let arguments = [
        "database",
        "restore",
        backup,
        "--output",
        output.to_str().unwrap(),
        "--json",
    ];
    let restored = cli(&paths, &arguments);
    assert!(
        restored.status.success(),
        "{}",
        String::from_utf8_lossy(&restored.stderr)
    );
    let restored: serde_json::Value = serde_json::from_slice(&restored.stdout).unwrap();
    assert_eq!(restored["activated"], false);
    assert!(
        !cli(&paths, &arguments).status.success(),
        "must not overwrite output"
    );
    let recovered = gyro_core::open_private_database(&output).unwrap();
    assert_eq!(
        recovered
            .query_row("select value from sentinel", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "saved"
    );
    assert_eq!(
        conn.query_row("pragma user_version", [], |row| row.get::<_, i32>(0))
            .unwrap(),
        9999
    );
}
