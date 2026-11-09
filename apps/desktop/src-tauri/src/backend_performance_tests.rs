//! Opt-in stage timings against disposable local fixtures, never user files.
use crate::{ide::task_discovery::content_hash, workspace::tree::scan_workspace_tree};
use std::{fs, time::Instant};

#[test]
#[ignore = "explicit local performance measurement"]
fn workspace_scan_benchmark() {
    let temp = tempfile::tempdir().unwrap();
    for package in 0..20 {
        for folder in 0..20 {
            let directory = temp
                .path()
                .join(format!("package-{package}/src/module-{folder}"));
            fs::create_dir_all(&directory).unwrap();
            for file in 0..25 {
                fs::write(directory.join(format!("file-{file}.rs")), "fixture\n").unwrap();
            }
        }
    }
    // Generated directories and .git stay excluded exactly as in production.
    fs::create_dir_all(temp.path().join("node_modules/ignored")).unwrap();
    fs::create_dir_all(temp.path().join(".git/objects")).unwrap();
    fs::write(
        temp.path().join("node_modules/ignored/package.js"),
        "ignored",
    )
    .unwrap();
    let expected = scan_workspace_tree(temp.path(), 8).unwrap();
    let serialized = serde_json::to_vec(&expected.files).unwrap();
    let mut samples = Vec::new();
    for _ in 0..7 {
        let started = Instant::now();
        let snapshot = scan_workspace_tree(temp.path(), 8).unwrap();
        samples.push(started.elapsed().as_secs_f64() * 1000.0);
        assert_eq!(serde_json::to_vec(&snapshot.files).unwrap(), serialized);
    }
    samples.sort_by(f64::total_cmp);
    println!(
        "WORKSPACE_SCAN_BENCHMARK {}",
        serde_json::json!({
            "schema":"gyro.backend-performance.v1", "evidence":"local debug project scan; no native UI measurement",
            "entries":expected.files.len(), "outputSha256":content_hash(&serialized),
            "medianMs":samples[3], "maxMs":samples[6], "samplesMs":samples,
        })
    );
}
