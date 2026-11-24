//! Recoverable projections of the fsynced JSONL log. The watermark and all
//! derived rows commit together; no indexed row is evidence of completeness.
use super::{
    lock_session_event_file, open_session_event_log_for_append, open_session_event_log_for_read,
    provider_status_from_payload, SessionEvent, SessionEventFileLockKind, SessionEventKind,
    SessionStore, MAX_SESSION_EVENT_LINE_BYTES,
};
use anyhow::{Context, Result};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::Path,
};
use uuid::Uuid;

// Version the derived rows together with the watermark. Older watermarks are
// rebuilt from JSONL before the retry evidence can be used.
const TURN_INDEX_VERSION: u8 = 2;

struct Watermark {
    identity: String,
    offset: u64,
    modified: String,
    anchor: String,
}

fn identity(metadata: &std::fs::Metadata) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!("{TURN_INDEX_VERSION}:{}:{}", metadata.dev(), metadata.ino())
    }
    #[cfg(not(unix))]
    {
        format!("{TURN_INDEX_VERSION}:{:?}", metadata.created().ok())
    }
}

fn anchor(file: &mut File, offset: u64) -> Result<String> {
    let length = offset.min(256) as usize;
    file.seek(SeekFrom::Start(offset - length as u64))?;
    let mut bytes = [0u8; 256];
    file.read_exact(&mut bytes[..length])?;
    Ok(format!("{:x}", Sha256::digest(&bytes[..length])))
}

impl SessionStore {
    pub(super) fn ensure_turn_index(&self, session: Uuid) -> Result<()> {
        self.with_current_turn_index(session, |_| Ok(()))
            .map(|_| ())
    }

    /// Returns the durable status for retry preparation and whether an
    /// unfinished attempt should block a new dispatch.
    pub fn provider_turn_status_for_dispatch(
        &self,
        session: Uuid,
        turn: Uuid,
    ) -> Result<(Option<String>, bool)> {
        self.with_current_turn_index(session, |file| {
            let status = self.indexed_provider_status_for_turn(session, turn)?;
            let tail_status = if status.is_none() {
                self.unterminated_provider_status(file, session, turn)?
            } else {
                None
            };
            let unfinished = matches!(
                status.as_deref().or(tail_status.as_deref()),
                Some("running" | "waiting" | "queued")
            );
            Ok((status, unfinished))
        })?
        .with_context(|| format!("unknown session {session}"))
    }

    /// A failed or interrupted turn with a tool receipt may continue only
    /// through the provider's known conversation. Evidence can predate the
    /// bounded tail that supplies chat context and display history.
    pub fn provider_turn_has_interrupted_work(&self, session: Uuid, turn: Uuid) -> Result<bool> {
        Ok(self
            .with_current_turn_index(session, |file| {
                let (interrupted, tool_work) = self
                    .conn
                    .query_row(
                        "select interrupted, tool_work from session_turn_retry_evidence
                 where session_id = ?1 and turn_id = ?2",
                        params![session.to_string(), turn.to_string()],
                        |row| Ok((row.get::<_, bool>(0)?, row.get::<_, bool>(1)?)),
                    )
                    .optional()?
                    .unwrap_or_default();
                if interrupted && tool_work {
                    return Ok(true);
                }
                let tail = self.unterminated_turn_event(file, session, turn)?;
                let (tail_interrupted, tail_work) = tail
                    .as_ref()
                    .map_or((false, false), |event| retry_evidence(&event.payload));
                Ok((interrupted || tail_interrupted) && (tool_work || tail_work))
            })?
            .unwrap_or(false))
    }

    fn with_current_turn_index<T>(
        &self,
        session: Uuid,
        read: impl FnOnce(&mut File) -> Result<T>,
    ) -> Result<Option<T>> {
        if !self.turn_index_session_exists(session)? {
            return Ok(None);
        }
        let path = self.session_events_path(session)?;
        let mut file = match open_session_event_log_for_read(&path) {
            Ok(file) => file,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
            {
                // Create/open and lock the log even for legacy empty sessions.
                // Clearing without that lock can race the first real append.
                open_session_event_log_for_append(&path)?
            }
            Err(error) => return Err(error),
        };
        // All indexers use the append lock, then SQLite, in that order. This
        // also prevents two readers from advancing a watermark out of order.
        let _lock = lock_session_event_file(&file, SessionEventFileLockKind::Exclusive)?;
        self.catch_up_turn_index_locked(session, &path, &mut file)?;
        read(&mut file).map(Some)
    }

    // The catch-up covers every complete record. On an index miss only the
    // unfinished final record could contain older dispatch evidence. A
    // complete JSON object there can block replay but is not durable status.
    fn unterminated_provider_status(
        &self,
        file: &mut File,
        session: Uuid,
        turn: Uuid,
    ) -> Result<Option<String>> {
        Ok(self
            .unterminated_turn_event(file, session, turn)?
            .and_then(|event| provider_status_from_payload(&event.payload)))
    }

    fn unterminated_turn_event(
        &self,
        file: &mut File,
        session: Uuid,
        turn: Uuid,
    ) -> Result<Option<SessionEvent>> {
        let offset: Option<u64> = self
            .conn
            .query_row(
                "select indexed_bytes from session_turn_index where session_id = ?1",
                [session.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        let Some(offset) = offset else {
            anyhow::bail!("session {session} was deleted during turn status lookup");
        };
        let bytes = file.metadata()?.len().saturating_sub(offset);
        if bytes == 0 || bytes > MAX_SESSION_EVENT_LINE_BYTES as u64 {
            return Ok(None);
        }
        file.seek(SeekFrom::Start(offset))?;
        let mut record = vec![0; bytes as usize];
        file.read_exact(&mut record)?;
        Ok(serde_json::from_slice::<SessionEvent>(&record)
            .ok()
            .filter(|event| event.session_id == session && event.turn_id == Some(turn)))
    }

    fn clear_turn_index(&self, session: Uuid) -> Result<()> {
        for table in [
            "session_turn_messages",
            "session_turn_status",
            "session_turn_retry_evidence",
            "session_turn_index",
        ] {
            self.conn.execute(
                &format!("delete from {table} where session_id = ?1"),
                [session.to_string()],
            )?;
        }
        Ok(())
    }

    fn turn_index_session_exists(&self, session: Uuid) -> Result<bool> {
        Ok(self.conn.query_row(
            "select exists(select 1 from sessions where id=?1)",
            [session.to_string()],
            |row| row.get(0),
        )?)
    }

    /// Caller holds the exclusive log lock. Returns scanned bytes for
    /// regression checks that verify recovery reads only the unindexed tail.
    pub(super) fn catch_up_turn_index_locked(
        &self,
        session: Uuid,
        path: &Path,
        file: &mut File,
    ) -> Result<u64> {
        let metadata = file.metadata()?;
        let file_identity = identity(&metadata);
        let modified = format!("{:?}", metadata.modified()?);
        let length = metadata.len();
        let previous = self.conn.query_row(
            "select file_identity, indexed_bytes, file_modified, anchor from session_turn_index where session_id = ?1",
            [session.to_string()], |row| Ok(Watermark { identity: row.get(0)?, offset: row.get(1)?, modified: row.get(2)?, anchor: row.get(3)? }),
        ).optional()?;
        let valid = match &previous {
            Some(old) => {
                old.identity == file_identity
                    && old.offset <= length
                    && (old.offset != length || old.modified == modified)
                    && anchor(file, old.offset)? == old.anchor
            }
            None => false,
        };
        let start = previous
            .as_ref()
            .filter(|_| valid)
            .map_or(0, |old| old.offset);
        if valid && start == length {
            return Ok(0);
        }

        let transaction =
            rusqlite::Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        // Deletion may win between enumeration/open and acquiring the log
        // lock. Its cascading deletes must not turn startup into an error.
        if !self.turn_index_session_exists(session)? {
            return Ok(0);
        }
        if !valid {
            self.clear_turn_index(session)?;
        }
        file.seek(SeekFrom::Start(start))?;
        let mut reader = BufReader::new(&mut *file);
        let mut offset = start;
        // Allocate at most one bounded record. Corrupt complete records are
        // skipped, just as display history skips them. Incomplete tails remain
        // unindexed until the next append repairs them.
        while let Some((record, bytes)) = complete_record(&mut reader)? {
            offset += bytes;
            if let Some(event) =
                record.and_then(|bytes| serde_json::from_slice::<SessionEvent>(&bytes).ok())
            {
                if event.session_id != session {
                    continue;
                }
                if let Some(turn) = event.turn_id {
                    if matches!(
                        event.kind,
                        SessionEventKind::UserMessage | SessionEventKind::AssistantMessage
                    ) {
                        self.record_turn_message_index(session, turn, &event)?;
                    }
                    if let Some(status) = provider_status_from_payload(&event.payload) {
                        self.record_turn_provider_status(session, turn, &status)?;
                    }
                    let (interrupted, tool_work) = retry_evidence(&event.payload);
                    if interrupted || tool_work {
                        self.conn.execute(
                            "insert into session_turn_retry_evidence
                             (session_id, turn_id, interrupted, tool_work) values (?1, ?2, ?3, ?4)
                             on conflict(session_id, turn_id) do update set
                               interrupted = max(interrupted, excluded.interrupted),
                               tool_work = max(tool_work, excluded.tool_work)
                             where excluded.interrupted > interrupted or excluded.tool_work > tool_work",
                            params![session.to_string(), turn.to_string(), interrupted, tool_work],
                        )?;
                    }
                }
            }
        }
        drop(reader);
        anyhow::ensure!(
            identity(&std::fs::metadata(path)?) == file_identity,
            "session log was replaced during index recovery; retry"
        );
        self.conn.execute(
            "insert into session_turn_index (session_id,file_identity,indexed_bytes,file_modified,anchor)
             values (?1,?2,?3,?4,?5) on conflict(session_id) do update set
             file_identity=excluded.file_identity, indexed_bytes=excluded.indexed_bytes,
             file_modified=excluded.file_modified, anchor=excluded.anchor",
            params![session.to_string(), file_identity, offset, modified, anchor(file, offset)?],
        )?;
        transaction
            .commit()
            .context("commit recovered turn indexes")?;
        Ok(offset - start)
    }
}

fn retry_evidence(payload: &serde_json::Value) -> (bool, bool) {
    let kind = payload["kind"].as_str();
    let status = payload["status"].as_str();
    let interrupted = kind == Some("provider-status")
        && matches!(status, Some("failed" | "cancelled" | "interrupted"));
    let tool_work = matches!(
        payload["schema"].as_str(),
        Some("gyro.capability.v1" | "gyro.mutation.v1")
    ) || (kind == Some("provider-activity")
        && matches!(
            payload["activityKind"].as_str(),
            Some("command" | "file" | "tool")
        ))
        || (kind == Some("provider-approval") && status == Some("applied"));
    (interrupted, tool_work)
}

/// Streaming skip of oversized complete lines, without retaining their bytes.
fn complete_record(reader: &mut impl BufRead) -> Result<Option<(Option<Vec<u8>>, u64)>> {
    let mut record = Vec::new();
    let mut bytes = 0u64;
    let mut oversized = false;
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return Ok(None);
        }
        let end = buffer.iter().position(|b| *b == b'\n');
        let count = end.map_or(buffer.len(), |at| at + 1);
        bytes += count as u64;
        if bytes > MAX_SESSION_EVENT_LINE_BYTES as u64 {
            oversized = true;
            record.clear();
        }
        if !oversized {
            record.extend_from_slice(&buffer[..count]);
        }
        reader.consume(count);
        if end.is_some() {
            return Ok(Some(((!oversized).then_some(record), bytes)));
        }
    }
}

#[cfg(test)]
mod tests;
