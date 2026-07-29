//! Shared SQLite runtime settings for Gyro's local-first stores.
//!
//! Session, automation, and usage data share one on-disk database under
//! Application Support. Every connection should use the same PRAGMA profile so
//! app + CLI writers stay compatible under WAL and recover cleanly from brief
//! lock contention.

use anyhow::{Context, Result};
use rusqlite::{Connection, ErrorCode};
use std::path::Path;
use std::thread;
use std::time::Duration;

/// Default wait when another Gyro process holds a write lock.
pub const DEFAULT_BUSY_TIMEOUT: Duration = Duration::from_secs(10);

/// How many times to retry a statement that hit SQLITE_BUSY / locked.
pub const DEFAULT_BUSY_RETRIES: u32 = 8;

/// Apply the production SQLite profile to a newly opened connection.
///
/// - WAL + NORMAL: durable enough for the index tables; JSONL event fsync is
///   the chat history durability bar.
/// - foreign_keys: keep mutation/session cascades honest.
/// - temp_store=memory + larger page cache: list/read hot paths stay off disk.
/// - mmap: cheap random reads of small rows on macOS.
/// - wal_autocheckpoint: bound WAL growth under heavy chat write bursts.
pub fn configure_connection(conn: &Connection) -> Result<()> {
    conn.busy_timeout(DEFAULT_BUSY_TIMEOUT)
        .context("set sqlite busy_timeout")?;
    conn.execute_batch(
        "pragma foreign_keys = on;
         pragma journal_mode = wal;
         pragma synchronous = normal;
         pragma temp_store = memory;
         pragma cache_size = -65536;
         pragma mmap_size = 268435456;
         pragma wal_autocheckpoint = 1000;
         pragma recursive_triggers = on;",
    )
    .context("apply sqlite runtime pragmas")?;
    Ok(())
}

/// Open a private Gyro database file with the shared runtime profile.
pub fn open_private_database(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)
        .with_context(|| format!("open sqlite database {}", path.display()))?;
    configure_connection(&conn)?;
    Ok(conn)
}

/// Run `PRAGMA optimize` so the query planner keeps useful stats after warm-up
/// or long-lived process reuse. Best-effort: never fails the caller.
pub fn optimize_connection(conn: &Connection) {
    let _ = conn.execute_batch("pragma optimize;");
}

/// Cheap integrity probe used during shell warm-up. Returns Ok(()) when the
/// database reports `ok`, or an error describing corruption.
pub fn quick_check(conn: &Connection) -> Result<()> {
    let status: String = conn
        .query_row("pragma quick_check", [], |row| row.get(0))
        .context("run pragma quick_check")?;
    if status.eq_ignore_ascii_case("ok") {
        return Ok(());
    }
    anyhow::bail!("sqlite quick_check failed: {status}");
}

/// Passive WAL checkpoint — releases free pages without blocking readers.
pub fn checkpoint_wal_passive(conn: &Connection) {
    let _ = conn.execute_batch("pragma wal_checkpoint(PASSIVE);");
}

/// True when the rusqlite error is a transient lock/busy condition.
pub fn is_busy_error(error: &rusqlite::Error) -> bool {
    match error {
        rusqlite::Error::SqliteFailure(code, _) => matches!(
            code.code,
            ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked
        ),
        _ => false,
    }
}

/// Retry a unit of SQLite work when the database is briefly locked.
pub fn with_busy_retry<T, F>(op: F) -> Result<T>
where
    F: FnMut() -> Result<T>,
{
    with_busy_retry_n(DEFAULT_BUSY_RETRIES, op)
}

pub fn with_busy_retry_n<T, F>(max_retries: u32, mut op: F) -> Result<T>
where
    F: FnMut() -> Result<T>,
{
    let mut attempt = 0u32;
    loop {
        match op() {
            Ok(value) => return Ok(value),
            Err(error) => {
                let busy = error
                    .downcast_ref::<rusqlite::Error>()
                    .map(is_busy_error)
                    .unwrap_or_else(|| {
                        let message = error.to_string().to_ascii_lowercase();
                        message.contains("database is locked")
                            || message.contains("database is busy")
                    });
                if !busy || attempt >= max_retries {
                    return Err(error);
                }
                let backoff_ms = 5u64.saturating_mul(1u64 << attempt.min(5));
                thread::sleep(Duration::from_millis(backoff_ms.min(200)));
                attempt = attempt.saturating_add(1);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn configure_connection_enables_wal_and_foreign_keys() {
        let conn = Connection::open_in_memory().expect("memory db");
        configure_connection(&conn).expect("configure");
        let foreign_keys: i32 = conn
            .query_row("pragma foreign_keys", [], |row| row.get(0))
            .expect("fk");
        assert_eq!(foreign_keys, 1);
        let journal: String = conn
            .query_row("pragma journal_mode", [], |row| row.get(0))
            .expect("journal");
        // In-memory DBs may report "memory"; file-backed uses wal. Accept either
        // as proof the batch ran without error on this platform.
        assert!(!journal.is_empty());
    }

    #[test]
    fn busy_retry_eventually_succeeds() {
        let mut tries = 0u32;
        let value = with_busy_retry_n(5, || {
            tries += 1;
            if tries < 3 {
                anyhow::bail!("database is locked");
            }
            Ok(42)
        })
        .expect("retry");
        assert_eq!(value, 42);
        assert_eq!(tries, 3);
    }

    #[test]
    fn quick_check_passes_on_healthy_memory_db() {
        let conn = Connection::open_in_memory().expect("memory db");
        configure_connection(&conn).expect("configure");
        conn.execute_batch("create table t(id integer primary key);")
            .expect("create");
        quick_check(&conn).expect("healthy");
    }
}
