//! Disposable, deterministic usage-ledger read benchmark; no provider calls.
use gyro_core::{usage, usage_receipts};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{hint::black_box, time::Instant};
use uuid::Uuid;

fn sample(mut run: impl FnMut() -> Value) -> Value {
    let expected = run();
    let mut samples = Vec::new();
    for _ in 0..9 {
        let started = Instant::now();
        let result = black_box(run());
        samples.push(started.elapsed().as_secs_f64() * 1000.0);
        assert_eq!(result, expected);
    }
    samples.sort_by(f64::total_cmp);
    json!({"medianMs":samples[4], "samplesMs":samples,
        "outputSha256":format!("{:x}", Sha256::digest(serde_json::to_vec(&expected).unwrap())),
        "output":expected})
}

fn fixture(noise: usize) -> anyhow::Result<Value> {
    let temp = tempfile::tempdir()?;
    let mut conn = Connection::open(temp.path().join("usage.sqlite"))?;
    usage::ensure_usage_schema(&conn)?;
    let session = Uuid::from_u128(1);
    let child = Uuid::from_u128(2);
    let turn = Uuid::from_u128(3);
    let child_turn = Uuid::from_u128(4);
    let tokens = usage::UsageTokens::measured(Some(100), Some(20), Some(50), None, None);
    let started = Instant::now();
    let tx = conn.transaction()?;
    {
        let mut insert = tx.prepare(
            "insert into usage_ledger
            (id, occurred_at, session_id, turn_id, provider_id, origin, outcome,
             input_tokens, cached_input_tokens, output_tokens, total_tokens, measured)
            values (?1, ?2, ?3, ?4, 'fixture', 'chat', 'done', 100, 20, 50, 150, 1)",
        )?;
        let mut receipt = tx.prepare(
            "insert into usage_receipt_revisions
            (usage_id, tokens_json, observed_at) values (?1, ?2, ?3)",
        )?;
        let encoded = serde_json::to_string(&tokens)?;
        for index in 0..noise + 200 {
            let owner = if index < 100 {
                session
            } else if index < 200 || index % 2 == 0 {
                child
            } else {
                Uuid::from_u128(1000 + (index % 100) as u128)
            };
            let owned_turn = if index < 100 {
                turn
            } else if index < 200 {
                child_turn
            } else {
                Uuid::from_u128(1000 + index as u128)
            };
            let id = Uuid::from_u128(10_000 + index as u128).to_string();
            // Distinct stable times allow exact before/after output comparison.
            let at = (chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")?
                + chrono::Duration::seconds(index as i64))
            .to_rfc3339();
            insert.execute(params![id, at, owner.to_string(), owned_turn.to_string()])?;
            receipt.execute(params![id, encoded, at])?;
        }
    }
    usage_receipts::link_turn(&tx, child, child_turn, session, turn)?;
    // One missing receipt must remain visible after optimization.
    tx.execute(
        "insert into usage_call_expectations values (?1, ?2, 101)",
        params![child.to_string(), child_turn.to_string()],
    )?;
    tx.commit()?;
    let insert_ms = started.elapsed().as_secs_f64() * 1000.0;
    Ok(
        json!({"ledgerRows":noise+200, "ownedRows":200, "fixtureInsertMs":insert_ms,
        "sessionTotals":sample(|| serde_json::to_value(usage::session_usage_totals(&conn, session).unwrap()).unwrap()),
        "sessionReceipt":sample(|| serde_json::to_value(usage_receipts::session_tokens(&conn, session).unwrap()).unwrap()),
        "taskReceipt":sample(|| serde_json::to_value(usage_receipts::task_tokens(&conn, session, turn).unwrap()).unwrap())}),
    )
}

fn main() -> anyhow::Result<()> {
    if std::env::args().any(|arg| arg == "--index-cost") {
        println!("{}", serde_json::to_string_pretty(&index_cost()?)?);
        return Ok(());
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "schema":"gyro.usage-performance.v1",
            "evidence":"local debug SQLite fixture; no native UI or live provider measurement",
            "small":fixture(0)?, "large":fixture(20_000)?
        }))?
    );
    Ok(())
}

// Compare public, durable append calls with/without the new index in a disposable
// existing database. Alternate order to avoid always giving one case a warm cache.
fn index_cost() -> anyhow::Result<Value> {
    let temp = tempfile::tempdir()?;
    let conn = Connection::open(temp.path().join("usage.sqlite"))?;
    usage::ensure_usage_schema(&conn)?;
    conn.execute_batch("drop index idx_usage_ledger_session_turn;
        with recursive n(x) as (select 1 union all select x+1 from n where x < 20000)
        insert into usage_ledger (id, occurred_at, session_id, turn_id, provider_id, origin, outcome)
        select cast(x as text), '2026-01-01T00:00:00Z', 'fixture', cast(x as text), 'fixture', 'chat', 'done' from n;")?;
    let used_bytes = |conn: &Connection| -> anyhow::Result<u64> {
        let pages: u64 = conn.query_row("pragma page_count", [], |r| r.get(0))?;
        let free: u64 = conn.query_row("pragma freelist_count", [], |r| r.get(0))?;
        let size: u64 = conn.query_row("pragma page_size", [], |r| r.get(0))?;
        Ok((pages - free) * size)
    };
    let bytes_before = used_bytes(&conn)?;
    let started = Instant::now();
    usage::ensure_usage_schema(&conn)?;
    let migration_ms = started.elapsed().as_secs_f64() * 1000.0;
    let bytes_after = used_bytes(&conn)?;
    let call = usage::UsageEntry {
        session_id: Uuid::from_u128(1),
        turn_id: Some(Uuid::from_u128(2)),
        seat_id: None,
        provider_id: "fixture".into(),
        model_id: None,
        reasoning_effort: None,
        origin: usage::UsageOrigin::Chat,
        outcome: usage::UsageOutcome::Done,
        tokens: usage::UsageTokens::measured(Some(100), Some(20), Some(50), None, None),
        wall_ms: 100,
        retry_count: 0,
    };
    let mut without = Vec::new();
    let mut with = Vec::new();
    for round in 0..9 {
        for indexed in if round % 2 == 0 {
            [false, true]
        } else {
            [true, false]
        } {
            conn.execute_batch("drop index if exists idx_usage_ledger_session_turn")?;
            if indexed {
                usage::ensure_usage_schema(&conn)?;
            }
            let started = Instant::now();
            for _ in 0..20 {
                usage::insert_usage_entry(&conn, &call)?;
            }
            let ms = started.elapsed().as_secs_f64() * 1000.0 / 20.0;
            if indexed {
                with.push(ms)
            } else {
                without.push(ms)
            };
        }
    }
    with.sort_by(f64::total_cmp);
    without.sort_by(f64::total_cmp);
    let rows: u64 = conn.query_row("select count(*) from usage_ledger", [], |r| r.get(0))?;
    let receipts: u64 =
        conn.query_row("select count(*) from usage_receipt_revisions", [], |r| {
            r.get(0)
        })?;
    assert_eq!(rows, 20_360);
    assert_eq!(receipts, 360);
    Ok(json!({"schema":"gyro.usage-index-cost.v1",
        "evidence":"local debug disposable SQLite; alternating same-process comparison",
        "existingRows":20000,"callsPerSample":20,"insertedRows":360,"insertedReceipts":receipts,
        "migrationSingleObservationMs":migration_ms,"usedBytesBefore":bytes_before,"usedBytesAfter":bytes_after,
        "withoutIndex":{"medianMs":without[4],"samplesMs":without},
        "withIndex":{"medianMs":with[4],"samplesMs":with}}))
}
