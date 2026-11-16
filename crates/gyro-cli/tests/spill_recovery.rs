use gyro_core::{efficiency::spill, GyroPaths};
use std::process::{Command, Output};
use uuid::Uuid;

fn cli(paths: &GyroPaths, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_gyro"))
        .env("GYRO_TEST_DATA_DIR", &paths.base_dir)
        .env("GYRO_SPILL_DIR", paths.base_dir.join("spill"))
        .args(args)
        .output()
        .unwrap()
}

#[test]
fn cli_recovers_only_the_explicit_session_without_a_global_fallback() {
    let temp = tempfile::tempdir().unwrap();
    let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
    let owner = Uuid::new_v4();
    let other = Uuid::new_v4();
    let text = "private desktop output";
    let address = spill::address("workspace.read", "gyro_workspace_read", text);
    {
        let _scope = spill::SessionScope::start(&paths, owner);
        assert!(spill::persist(&address, text));
    }
    let read = cli(
        &paths,
        &["spill", &address, "--session", &owner.to_string(), "--json"],
    );
    assert!(
        read.status.success(),
        "{}",
        String::from_utf8_lossy(&read.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&read.stdout).unwrap();
    assert_eq!(value["schema"], "gyro.cli.v1");
    assert_eq!(value["text"], text);
    assert!(!cli(
        &paths,
        &["spill", &address, "--session", &other.to_string(), "--json"]
    )
    .status
    .success());
    assert!(!cli(&paths, &["spill", &address, "--json"]).status.success());

    // The old operator-facing command still reads old local copies, but a
    // session selection cannot silently read one of those global records.
    spill::SpillStore::new(paths.base_dir.join("spill"))
        .save(&address, "legacy local output")
        .unwrap();
    let legacy = cli(&paths, &["spill", &address, "--json"]);
    assert!(legacy.status.success());
    let value: serde_json::Value = serde_json::from_slice(&legacy.stdout).unwrap();
    assert_eq!(value["text"], "legacy local output");
    assert!(!cli(
        &paths,
        &["spill", &address, "--session", &other.to_string(), "--json"]
    )
    .status
    .success());
}
