//! Local, deterministic backend-stage benchmark. No model calls or user data.
//! cargo run -p gyro-core --example backend_performance --locked
use gyro_core::{GyroPaths, SessionEvent, SessionEventKind, SessionOrigin, SessionStore};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{hint::black_box, io::Write, time::Instant};
use uuid::Uuid;

fn sample(mut run: impl FnMut(), iterations: usize) -> serde_json::Value {
    run();
    let mut times = Vec::new();
    for _ in 0..7 {
        let started = Instant::now();
        for _ in 0..iterations {
            run();
        }
        times.push(started.elapsed().as_secs_f64() * 1000.0 / iterations as f64);
    }
    times.sort_by(f64::total_cmp);
    json!({"medianMs":times[3], "maxMs":times[6], "samplesMs":times, "iterationsPerSample":iterations})
}

fn context_benchmark(phased: bool) -> anyhow::Result<serde_json::Value> {
    let temp = tempfile::tempdir()?;
    let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro")))?;
    let session = store.create_session(temp.path(), SessionOrigin::Desktop, "backend benchmark")?;
    let count = 2_000;
    let mut file = std::io::BufWriter::new(
        std::fs::OpenOptions::new()
            .append(true)
            .open(&session.events_path)?,
    );
    for i in 0..count {
        let kind = if phased && i < count / 2 {
            SessionEventKind::PlanUpdated
        } else if i % 250 == 0 {
            SessionEventKind::SystemEvent
        } else if i % 100 == 0 {
            SessionEventKind::GoalUpdated
        } else if i % 20 == 0 {
            SessionEventKind::PlanUpdated
        } else if i % 15 == 0 {
            SessionEventKind::ChatModeChanged
        } else {
            SessionEventKind::TaskCheckpoint
        };
        let mut event = SessionEvent::new(
            session.id,
            kind,
            "fixture context",
            json!({"kind":"efficiency-phase-route", "content":"fixture", "index":i}),
        );
        // Only routing records carry this field in the actual transcript.
        if event.kind != SessionEventKind::SystemEvent {
            event.payload.as_object_mut().unwrap().remove("kind");
        }
        event.id = Uuid::from_u128(i as u128 + 1);
        serde_json::to_writer(&mut file, &event)?;
        file.write_all(b"\n")?;
    }
    file.flush()?;
    let start = Instant::now();
    let expected = store.read_efficiency_context_events(session.id)?;
    let cold_ms = start.elapsed().as_secs_f64() * 1000.0;
    let ids = expected
        .iter()
        .map(|event| event.id.to_string())
        .collect::<Vec<_>>();
    let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&ids)?));
    let warm = sample(
        || {
            let result = store.read_efficiency_context_events(session.id).unwrap();
            assert_eq!(
                result.iter().map(|event| event.id).collect::<Vec<_>>(),
                expected.iter().map(|event| event.id).collect::<Vec<_>>()
            );
            black_box(result);
        },
        1,
    );
    Ok(
        json!({"inputEvents":count,"outputEvents":ids.len(),"outputIdsSha256":digest,"coldMs":cold_ms,"warm":warm}),
    )
}

fn main() -> anyhow::Result<()> {
    let context =
        json!({"interleaved": context_benchmark(false)?, "phased": context_benchmark(true)?});
    let mut redaction = serde_json::Map::new();
    for (name, text) in [
        (
            "cleanAscii",
            "src/workspace.rs: compiled successfully; 42 checks passed.\n".repeat(1200),
        ),
        (
            "cleanUnicode",
            "src/日本語.rs: café 🦀 workspace scan complete.\n".repeat(1200),
        ),
        (
            "withSecrets",
            format!(
                "{}\npassword=fixture-private-value\nAuthorization: Bearer fixture-token-123\n{}",
                "compiled successfully\n".repeat(1500),
                "checked another module\n".repeat(1500)
            ),
        ),
    ] {
        let expected = gyro_core::security::redact_secrets(&text);
        let expected_positions = gyro_core::security::redact_secrets_preserving_positions(&text);
        let elapsed = sample(
            || {
                assert_eq!(
                    gyro_core::security::redact_secrets(black_box(&text)),
                    expected
                );
            },
            20,
        );
        let positions = sample(
            || {
                assert_eq!(
                    gyro_core::security::redact_secrets_preserving_positions(black_box(&text)),
                    expected_positions
                );
            },
            20,
        );
        redaction.insert(name.into(), json!({"bytes":text.len(),"redact":elapsed,"preservePositions":positions,"outputSha256":format!("{:x}",Sha256::digest(expected.as_bytes())),"positionsSha256":format!("{:x}",Sha256::digest(expected_positions.as_bytes()))}));
    }
    println!(
        "{}",
        serde_json::to_string_pretty(
            &json!({"schema":"gyro.backend-performance.v1", "evidence":"local debug backend stages; no native UI or live provider measurement", "context":context, "redaction":redaction})
        )?
    );
    Ok(())
}
