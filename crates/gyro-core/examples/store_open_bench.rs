//! Store open + first read latency, the path most backend actions take.
//!
//! cargo run --release -p gyro-core --example store_open_bench -- [iterations]
//!
//! Builds a throwaway store with 250 chats, then times each store's open plus
//! one read, sequentially and from four threads at once.
use anyhow::Result;
use gyro_core::agent_sessions::AgentSessionStore;
use gyro_core::{AutomationStore, GyroPaths, SessionOrigin, SessionStore};
use std::time::{Duration, Instant};

fn main() -> Result<()> {
    let iterations: usize = std::env::args()
        .nth(1)
        .and_then(|value| value.parse().ok())
        .unwrap_or(2000);
    let temp = tempfile::tempdir()?;
    let paths = GyroPaths::from_base_dir(temp.path().join("gyro"));
    let workspace = temp.path().join("project");
    std::fs::create_dir(&workspace)?;
    let session_id = {
        let store = SessionStore::open(paths.clone())?;
        let mut last = None;
        for index in 0..250 {
            let session = store.create_session(
                &workspace,
                SessionOrigin::Desktop,
                &format!("chat {index}"),
            )?;
            last = Some(session.id);
        }
        AutomationStore::open(paths.clone())?;
        AgentSessionStore::open(paths.clone())?;
        last.unwrap()
    };
    // A folder changed in the last two seconds is always rescanned for
    // interrupted imports; time the settled case a running app sees.
    std::thread::sleep(Duration::from_millis(2100));

    report("raw connection + count", iterations, || {
        let conn = gyro_core::open_private_database(&paths.database_path)?;
        conn.query_row("select count(*) from sessions", [], |row| {
            row.get::<_, i64>(0)
        })?;
        Ok(())
    })?;
    report("SessionStore::open + get_session", iterations, || {
        SessionStore::open(paths.clone())?.get_session(session_id)?;
        Ok(())
    })?;
    report("AutomationStore::open + list", iterations, || {
        AutomationStore::open(paths.clone())?.list_automations()?;
        Ok(())
    })?;
    report("AgentSessionStore::open + pairing", iterations, || {
        AgentSessionStore::open(paths.clone())?.pairing()?;
        Ok(())
    })?;

    let started = Instant::now();
    std::thread::scope(|scope| -> Result<()> {
        let workers = (0..4)
            .map(|_| {
                let paths = paths.clone();
                scope.spawn(move || -> Result<()> {
                    for _ in 0..iterations {
                        SessionStore::open(paths.clone())?.get_session(session_id)?;
                    }
                    Ok(())
                })
            })
            .collect::<Vec<_>>();
        for worker in workers {
            worker.join().expect("worker")?;
        }
        Ok(())
    })?;
    let per_open = started.elapsed() / (4 * iterations) as u32;
    println!(
        "{:<36} {:>8.1} µs wall per open (4 threads)",
        "SessionStore::open x4 threads",
        micros(per_open)
    );
    Ok(())
}

fn report(label: &str, iterations: usize, mut run: impl FnMut() -> Result<()>) -> Result<()> {
    for _ in 0..50 {
        run()?;
    }
    let mut samples = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let started = Instant::now();
        run()?;
        samples.push(started.elapsed());
    }
    samples.sort();
    let mean = samples.iter().sum::<Duration>() / iterations as u32;
    println!(
        "{label:<36} mean {:>7.1} µs  p50 {:>7.1} µs  p95 {:>7.1} µs",
        micros(mean),
        micros(samples[iterations / 2]),
        micros(samples[iterations * 95 / 100]),
    );
    Ok(())
}

fn micros(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1e6
}
