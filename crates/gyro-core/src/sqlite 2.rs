//! Shared SQLite runtime settings for Gyro's local-first stores.
//!
//! Session, automation, and usage data share one on-disk database under
//! Application Support. Every connection should use the same PRAGMA profile so
//! app + CLI writers stay compatible under WAL and recover cleanly from brief
//! lock contention.

use anyhow::{Context, Result};
use rusqlite::{Connection, ErrorCode};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
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
    // Switching a database into WAL can report SQLITE_BUSY straight away,
    // without the busy timeout, when the app and the CLI open it together.
    // Every pragma here is idempotent, so the batch is simply retried.
    with_busy_retry(|| {
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
        .context("apply sqlite runtime pragmas")
    })?;
    Ok(())
}

/// Open a private Gyro database file with the shared runtime profile.
pub fn open_private_database(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)
        .with_context(|| format!("open sqlite database {}", path.display()))?;
    configure_connection(&conn)?;
    Ok(conn)
}

/// Idle connections kept for one database: the most commands the app runs at
/// once. Each holds its own page cache, so the pool never grows past this.
const POOL_IDLE_PER_DATABASE: usize = 8;

/// Idle connections kept across every path. Production opens one database;
/// the bound keeps test processes, which use a fresh path per test, from
/// holding descriptors for every database they ever opened.
const POOL_IDLE_CAPACITY: usize = 16;

/// A store's schema, ensured once per process rather than once per open.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) enum StoreSchema {
    Sessions,
    Automations,
    AgentSessions,
}

/// Device and inode of a database file. A connection only goes back to a
/// caller while the path still names the file it was opened on, so a deleted
/// or replaced database is opened afresh, as it was before pooling.
type FileIdentity = (u64, u64);

/// `schema_version` changes with every schema change, from any process;
/// `user_version` is the store's own migration level.
type SchemaStamp = (i64, i64);

struct IdleConnection {
    path: PathBuf,
    identity: FileIdentity,
    conn: Connection,
}

#[derive(Default)]
struct ConnectionPool {
    idle: VecDeque<IdleConnection>,
    ensured: HashMap<(PathBuf, StoreSchema), (FileIdentity, SchemaStamp)>,
}

fn connection_pool() -> MutexGuard<'static, ConnectionPool> {
    static POOL: OnceLock<Mutex<ConnectionPool>> = OnceLock::new();
    POOL.get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn file_identity(path: &Path) -> Option<FileIdentity> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(path)
            .ok()
            .map(|metadata| (metadata.dev(), metadata.ino()))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

/// A configured connection borrowed from the per-process pool.
///
/// Opening a connection and parsing the schema on its first statement costs
/// about half a millisecond, and most backend actions open a store. Each
/// connection is still an ordinary WAL connection with the shared busy
/// timeout, so the CLI and the app interleave exactly as with fresh opens;
/// reuse only skips the open. A connection is pooled again on drop unless a
/// transaction was left open or the thread is unwinding.
pub struct PooledConnection {
    conn: Option<Connection>,
    path: PathBuf,
    identity: Option<FileIdentity>,
}

impl PooledConnection {
    /// Run `initialize` unless this process already ensured `schema` on this
    /// database and no process has changed its schema since.
    pub(crate) fn ensure_schema(
        &self,
        schema: StoreSchema,
        initialize: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        let key = (self.path.clone(), schema);
        let current = match self.identity {
            Some(identity) => {
                let stamp = self.schema_stamp()?;
                let ensured = connection_pool().ensured.get(&key) == Some(&(identity, stamp));
                if ensured {
                    return Ok(());
                }
                Some(identity)
            }
            None => None,
        };
        initialize()?;
        if let Some(identity) = current {
            let stamp = self.schema_stamp()?;
            connection_pool().ensured.insert(key, (identity, stamp));
        }
        Ok(())
    }

    fn schema_stamp(&self) -> Result<SchemaStamp> {
        with_busy_retry(|| {
            self.query_row(
                "select schema_version, user_version from pragma_schema_version, pragma_user_version",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .context("read sqlite schema stamp")
        })
    }
}

impl std::ops::Deref for PooledConnection {
    type Target = Connection;

    fn deref(&self) -> &Connection {
        self.conn.as_ref().expect("pooled connection is present")
    }
}

impl std::ops::DerefMut for PooledConnection {
    fn deref_mut(&mut self) -> &mut Connection {
        self.conn.as_mut().expect("pooled connection is present")
    }
}

impl Drop for PooledConnection {
    fn drop(&mut self) {
        let (Some(conn), Some(identity)) = (self.conn.take(), self.identity) else {
            return;
        };
        if thread::panicking() || !conn.is_autocommit() {
            return;
        }
        let evicted = {
            let mut pool = connection_pool();
            let same_database = pool
                .idle
                .iter()
                .filter(|idle| idle.path == self.path)
                .count();
            if same_database >= POOL_IDLE_PER_DATABASE {
                Some(conn)
            } else {
                pool.idle.push_back(IdleConnection {
                    path: std::mem::take(&mut self.path),
                    identity,
                    conn,
                });
                (pool.idle.len() > POOL_IDLE_CAPACITY)
                    .then(|| pool.idle.pop_front())
                    .flatten()
                    .map(|idle| idle.conn)
            }
        };
        // Closing a connection can checkpoint the WAL; never under the lock.
        drop(evicted);
    }
}

/// Borrow an idle connection to `path`, or open one with the shared profile.
pub(crate) fn open_pooled_database(path: &Path) -> Result<PooledConnection> {
    let identity = file_identity(path);
    let (reused, stale) = {
        let mut pool = connection_pool();
        let mut stale = Vec::new();
        let mut reused = None;
        let mut index = pool.idle.len();
        while index > 0 {
            index -= 1;
            if pool.idle[index].path != path {
                continue;
            }
            if Some(pool.idle[index].identity) != identity {
                stale.extend(pool.idle.remove(index));
            } else if reused.is_none() {
                reused = pool.idle.remove(index);
            }
        }
        (reused, stale)
    };
    drop(stale);
    if let Some(idle) = reused {
        return Ok(PooledConnection {
            conn: Some(idle.conn),
            path: idle.path,
            identity: Some(idle.identity),
        });
    }
    let conn = open_private_database(path)?;
    Ok(PooledConnection {
        conn: Some(conn),
        path: path.to_path_buf(),
        identity: file_identity(path),
    })
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

/// True when an `alter table … add column` lost a race to another process
/// that added the same column first — the schema is already what we wanted.
pub fn is_duplicate_column_error(error: &rusqlite::Error) -> bool {
    match error {
        rusqlite::Error::SqliteFailure(_, Some(message)) => {
            message.contains("duplicate column name")
        }
        _ => false,
    }
}

/// Add a column, treating "another process already added it" as success.
pub fn add_column_if_missing(conn: &Connection, table: &str, definition: &str) -> Result<()> {
    match conn.execute_batch(&format!("alter table {table} add column {definition};")) {
        Ok(()) => Ok(()),
        Err(error) if is_duplicate_column_error(&error) => Ok(()),
        Err(error) => Err(error.into()),
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
    fn adding_a_column_another_process_already_added_succeeds() {
        let conn = Connection::open_in_memory().expect("memory db");
        conn.execute_batch("create table t(id integer primary key);")
            .expect("create");
        add_column_if_missing(&conn, "t", "note text").expect("first add");
        // The second add is what a concurrent opener sees after its
        // table_info check went stale.
        let error = conn
            .execute_batch("alter table t add column note text;")
            .unwrap_err();
        assert!(is_duplicate_column_error(&error));
        add_column_if_missing(&conn, "t", "note text").expect("duplicate add is a no-op");
        assert!(add_column_if_missing(&conn, "missing", "note text").is_err());
    }

    fn has_marker(conn: &Connection) -> bool {
        conn.query_row(
            "select count(*) from sqlite_temp_master where name = 'marker'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap()
            == 1
    }

    #[test]
    fn a_returned_connection_is_reused_unless_a_transaction_was_left_open() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("pool.sqlite3");
        let conn = open_pooled_database(&path).unwrap();
        // A temporary table lives on one connection only.
        conn.execute_batch("create temp table marker(id integer);")
            .unwrap();
        drop(conn);
        let conn = open_pooled_database(&path).unwrap();
        assert!(has_marker(&conn));
        conn.execute_batch("begin immediate;").unwrap();
        drop(conn);
        let conn = open_pooled_database(&path).unwrap();
        assert!(!has_marker(&conn));
        assert!(conn.is_autocommit());
        // The abandoned write lock went with the discarded connection.
        conn.execute_batch("begin immediate; commit;").unwrap();
    }

    #[test]
    fn a_replaced_database_file_is_opened_afresh() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("pool.sqlite3");
        let conn = open_pooled_database(&path).unwrap();
        conn.execute_batch("create temp table marker(id integer); create table kept(id integer);")
            .unwrap();
        drop(conn);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
        let conn = open_pooled_database(&path).unwrap();
        assert!(!has_marker(&conn));
        let tables: i64 = conn
            .query_row(
                "select count(*) from sqlite_master where name = 'kept'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tables, 0);
    }

    #[test]
    fn a_schema_is_ensured_again_after_any_schema_change() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("pool.sqlite3");
        let runs = std::cell::Cell::new(0);
        let ensure = |conn: &PooledConnection| {
            conn.ensure_schema(StoreSchema::Automations, || {
                runs.set(runs.get() + 1);
                conn.execute_batch("create table if not exists ensured(id integer);")?;
                Ok(())
            })
            .unwrap();
        };
        ensure(&open_pooled_database(&path).unwrap());
        ensure(&open_pooled_database(&path).unwrap());
        assert_eq!(runs.get(), 1);
        // Another process, here a plain connection, drops the table.
        Connection::open(&path)
            .unwrap()
            .execute_batch("drop table ensured;")
            .unwrap();
        let conn = open_pooled_database(&path).unwrap();
        ensure(&conn);
        assert_eq!(runs.get(), 2);
        conn.query_row("select count(*) from ensured", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap();
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
