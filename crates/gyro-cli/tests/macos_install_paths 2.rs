#![cfg(target_os = "macos")]

use serde_json::Value;
use std::fs;
use std::os::unix::fs::symlink;
use std::process::Command;

#[test]
fn real_binary_doctor_accepts_a_symlink_installation() {
    let temp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap();
    let home = root.join("home");
    let bin = root.join("bin");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&bin).unwrap();
    let executable = fs::canonicalize(env!("CARGO_BIN_EXE_gyro")).unwrap();
    let installed_link = bin.join("gyro");
    symlink(executable, &installed_link).unwrap();

    let output = Command::new(&installed_link)
        .args(["doctor", "--json"])
        .env_clear()
        .env("HOME", &home)
        .env("PATH", "/usr/bin:/bin")
        .env("SHELL", "/bin/zsh")
        .env("GYRO_TEST_EMPTY_KEYCHAIN", "1")
        .env("GYRO_DISABLE_APP_HANDOFF", "1")
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "symlink-installed doctor failed: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["schema"], "gyro.cli.v1");
    let git = report["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|check| check["id"] == "git")
        .unwrap();
    assert_eq!(git["status"], "pass");
}
