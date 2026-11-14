//! Consistent pre-migration SQLite snapshots. Restore writes a new file so
//! neither a live connection nor the user's original database is overwritten.
use crate::{
    paths::{ensure_private_directory, reject_unsafe_private_file},
    GyroPaths,
};
use anyhow::{Context, Result};
use rusqlite::{
    backup::{Backup, StepResult},
    Connection, OpenFlags,
};
use serde::Serialize;
use std::{
    fs::{self, File},
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime},
};

const RETAIN_BACKUPS: usize = 3;
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(60);
const PENDING_PREFIX: &str = ".migration-snapshot-";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseBackup {
    pub path: PathBuf,
    pub bytes: u64,
}

fn read_only(path: &Path) -> Result<Connection> {
    reject_unsafe_private_file(path)?;
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("read database snapshot {}", path.display()))?;
    connection.busy_timeout(Duration::ZERO)?;
    Ok(connection)
}

fn copy_database(source: &Connection, destination: &mut Connection) -> Result<()> {
    destination.busy_timeout(Duration::ZERO)?;
    let deadline = Instant::now() + SNAPSHOT_TIMEOUT;
    let backup = Backup::new(source, destination)?;
    loop {
        anyhow::ensure!(
            Instant::now() < deadline,
            "Database backup exceeded its 60-second deadline; original database is unchanged"
        );
        match backup.step(256)? {
            StepResult::Done => return Ok(()),
            StepResult::More => {}
            StepResult::Busy | StepResult::Locked => std::thread::sleep(Duration::from_millis(10)),
            _ => anyhow::bail!("Unexpected SQLite backup state"),
        }
    }
}

fn available_space(directory: &Path) -> Option<u64> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let path = std::ffi::CString::new(directory.as_os_str().as_bytes()).ok()?;
        let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(path.as_ptr(), &mut stat) } == 0 {
            return Some((stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64));
        }
    }
    None
}

fn check_space(required: u64, available: Option<u64>) -> Result<()> {
    if let Some(available) = available {
        anyhow::ensure!(
            available >= required,
            "Not enough disk space for a migration backup: need {required} bytes, have {available}. Original database is unchanged."
        );
    }
    Ok(())
}

fn sync_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    Ok(())
}

/// Called with BEGIN IMMEDIATE held on the live database. WAL readers can
/// snapshot committed pages while that reservation prevents concurrent writes.
pub(crate) fn before_migration(paths: &GyroPaths, from: i32, to: i32) -> Result<Option<PathBuf>> {
    let source = read_only(&paths.database_path)?;
    let existing: bool = source.query_row(
        "select exists(select 1 from sqlite_master where type='table' and name not like 'sqlite_%')",
        [],
        |row| row.get(0),
    )?;
    if !existing {
        return Ok(None);
    }
    let directory = paths.base_dir.join("migration-backups");
    ensure_private_directory(&directory)?;
    // The caller holds the migration reservation, so these can only belong
    // to an interrupted older attempt. Never accumulate abandoned copies.
    for entry in fs::read_dir(&directory)? {
        let entry = entry?;
        if entry.file_type()?.is_file()
            && entry
                .file_name()
                .to_string_lossy()
                .starts_with(PENDING_PREFIX)
        {
            fs::remove_file(entry.path())?;
        }
    }
    // Snapshot each attempt: an older build may have written more data after
    // a failed migration. Reusing a snapshot just by inode/version loses it.
    let pages: u64 = source.query_row("pragma page_count", [], |r| r.get(0))?;
    let page_size: u64 = source.query_row("pragma page_size", [], |r| r.get(0))?;
    check_space(
        pages
            .saturating_mul(page_size)
            .saturating_add(16 * 1024 * 1024),
        available_space(&directory),
    )?;
    let temporary = tempfile::Builder::new()
        .prefix(PENDING_PREFIX)
        .tempfile_in(&directory)?;
    let mut destination = Connection::open(temporary.path())?;
    copy_database(&source, &mut destination)
        .context("create pre-migration backup; migration was not started")?;
    super::quick_check(&destination)?;
    drop(destination);
    temporary.as_file().sync_all()?;
    let name = format!(
        "schema-v{from}-to-v{to}-{}-{}.sqlite3",
        chrono::Utc::now().format("%Y%m%dT%H%M%S%3fZ"),
        uuid::Uuid::new_v4()
    );
    let backup = directory.join(&name);
    temporary.persist_noclobber(&backup)?;
    sync_directory(&directory)?;
    // Never remove the recovery snapshot that was just made. Only known
    // finished regular files participate in retention, never symlinks.
    let backups = list_backups(paths)?;
    for old in backups
        .into_iter()
        .filter(|old| old.path != backup)
        .skip(RETAIN_BACKUPS - 1)
    {
        fs::remove_file(old.path).context("prune old migration backup")?;
    }
    sync_directory(&directory)?;
    Ok(Some(backup))
}

pub fn list_backups(paths: &GyroPaths) -> Result<Vec<DatabaseBackup>> {
    let directory = paths.base_dir.join("migration-backups");
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut backups = Vec::new();
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if entry.file_type()?.is_file()
            && name.starts_with("schema-v")
            && name.ends_with(".sqlite3")
        {
            backups.push(DatabaseBackup {
                path: entry.path(),
                bytes: entry.metadata()?.len(),
            });
        }
    }
    backups.sort_by_cached_key(|backup| {
        std::cmp::Reverse(
            fs::metadata(&backup.path)
                .and_then(|m| m.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH),
        )
    });
    Ok(backups)
}

/// Restore a verified backup into a NEW SQLite file. JSONL histories remain in
/// their original data directory; this is an offline recovery artifact, never
/// an automatic rollback of live workspace data.
pub fn restore_backup(backup: &Path, output: &Path) -> Result<()> {
    let source = read_only(backup)?;
    super::ensure_supported_schema(&source)?;
    super::quick_check(&source).context("backup failed integrity validation")?;
    anyhow::ensure!(
        !output.try_exists()?,
        "Restore output already exists; choose a new file"
    );
    let parent = output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let temporary = tempfile::NamedTempFile::new_in(parent)?;
    let mut destination = Connection::open(temporary.path())?;
    copy_database(&source, &mut destination)?;
    super::quick_check(&destination)?;
    drop(destination);
    temporary.as_file().sync_all()?;
    temporary.persist_noclobber(output)?;
    sync_directory(parent)?;
    Ok(())
}

#[cfg(test)]
mod tests;
