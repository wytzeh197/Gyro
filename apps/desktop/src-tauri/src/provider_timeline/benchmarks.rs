//! Explicit fixture timings for the actual timeline implementation.

use crate::{
    ide::task_discovery::content_hash, provider_timeline::ProviderTimeline,
    providers::types::ProviderActivity,
};
use std::time::Instant;
fn sample(mut run: impl FnMut() -> serde_json::Value) -> serde_json::Value {
    let expected = run();
    let mut samples = Vec::new();
    for _ in 0..9 {
        let started = Instant::now();
        let result = std::hint::black_box(run());
        samples.push(started.elapsed().as_secs_f64() * 1000.0);
        assert_eq!(result, expected);
    }
    samples.sort_by(f64::total_cmp);
    serde_json::json!({"medianMs":samples[4],"samplesMs":samples,
        "outputSha256":content_hash(&serde_json::to_vec(&expected).unwrap())})
}

fn stable(mut value: serde_json::Value) -> serde_json::Value {
    // Wall-clock stamps differ per run; verify their presence, hash order/offsets.
    for mark in value.as_array_mut().unwrap() {
        assert!(chrono::DateTime::parse_from_rfc3339(mark["createdAt"].as_str().unwrap()).is_ok());
        mark.as_object_mut().unwrap().remove("createdAt");
    }
    value
}

#[test]
#[ignore = "explicit local performance measurement"]
fn timeline_benchmark() {
    let mut timeline = ProviderTimeline::default();
    for index in 0..400 {
        timeline.observe(Some(&format!("tool:{index}")), None);
        timeline.observe(
            None,
            Some(&format!(
                "Block {index}: café 🦀 {}\n\n",
                "text ".repeat(40)
            )),
        );
    }
    let message = timeline.text.clone();
    let response = sample(|| stable(timeline.response_segments(&message).unwrap()));
    let commentary = sample(|| {
        let mut timeline = ProviderTimeline::default();
        let mut activity = ProviderActivity {
            id: "commentary".into(),
            kind: "commentary".into(),
            label: String::new(),
            detail: None,
            file_counts: None,
            note: None,
            status: "done".into(),
        };
        let mut output = None;
        for index in 0..400 {
            timeline.observe(Some(&format!("tool:{index}")), None);
            for _ in 0..5 {
                activity.label.push_str("More café 🦀 commentary. ");
                output = timeline.activity(&activity).1;
            }
        }
        stable(output.unwrap())
    });
    println!(
        "TIMELINE_BENCHMARK {}",
        serde_json::json!({
            "schema":"gyro.timeline-performance.v1", "evidence":"local debug timeline fixture; no native UI or live provider measurement",
            "blocks":400,"responseBytes":message.len(),"commentaryUpdates":2000,
            "responseSegments":response,"commentary":commentary,
        })
    );
}
