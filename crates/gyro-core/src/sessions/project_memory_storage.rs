//! Memory settings and content-free context receipts share session-store
//! initialization and deletion. JSONL delivery uses a recoverable outbox.
use super::SessionStore;
use crate::project_memory::{MemoryReceipt, MemorySettings};
use anyhow::{ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

pub(super) fn ensure_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "create table if not exists project_memory_settings (
        workspace_key text primary key not null, settings_json text not null);
      create table if not exists project_memory_turn_receipts (
        session_id text not null references sessions(id) on delete cascade,
        turn_id text not null, provider_id text not null, receipt_json text not null,
        primary key(session_id,turn_id,provider_id));
      create table if not exists project_memory_thread_receipts (
        session_id text not null references sessions(id) on delete cascade,
        provider_id text not null, cursor_hash text not null, receipt_json text not null,
        primary key(session_id,provider_id));
      create table if not exists project_memory_receipt_outbox (
        operation_id text primary key not null,
        session_id text not null references sessions(id) on delete cascade,
        emitted integer not null default 0);",
    )?;
    Ok(())
}

impl SessionStore {
    /// Invalidate before dispatch, after preparing the previous receipt in
    /// memory. A crash, cancellation or failed acknowledgement then forces a
    /// conservative reset instead of reusing a possibly partial delivery.
    pub fn invalidate_project_memory_receipt(&self, session: Uuid, provider: &str) -> Result<()> {
        self.conn.execute(
            "delete from project_memory_thread_receipts where session_id=?1 and provider_id=?2",
            params![session.to_string(), provider],
        )?;
        Ok(())
    }
    pub fn project_memory_receipts(&self, session: Uuid) -> Result<Vec<serde_json::Value>> {
        let mut statement=self.conn.prepare("select turn_id,provider_id,receipt_json from project_memory_turn_receipts where session_id=?1 order by rowid desc limit 20")?;
        let rows = statement.query_map([session.to_string()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        rows.map(|row|{let (turn,provider,json)=row?;Ok(serde_json::json!({"turnId":turn,"providerId":provider,"receipt":serde_json::from_str::<serde_json::Value>(&json)?}))}).collect()
    }
    pub fn project_memory_settings(&self, workspace_key: &str) -> Result<MemorySettings> {
        let json: Option<String> = self
            .conn
            .query_row(
                "select settings_json from project_memory_settings where workspace_key=?1",
                [workspace_key],
                |row| row.get(0),
            )
            .optional()?;
        json.map(|json| serde_json::from_str(&json))
            .transpose()
            .map(|value| value.unwrap_or_default())
            .map_err(Into::into)
    }

    pub fn set_project_memory_settings(
        &self,
        workspace_key: &str,
        settings: &MemorySettings,
    ) -> Result<()> {
        settings.validate()?;
        self.conn.execute("insert into project_memory_settings (workspace_key,settings_json) values (?1,?2) on conflict(workspace_key) do update set settings_json=excluded.settings_json", params![workspace_key,serde_json::to_string(settings)?])?;
        Ok(())
    }

    pub fn previous_project_memory_receipt(
        &self,
        session: Uuid,
        provider: &str,
        cursor_json: &serde_json::Value,
    ) -> Result<Option<MemoryReceipt>> {
        let hash = crate::mutations::content_hash(serde_json::to_string(cursor_json)?.as_bytes());
        let json: Option<String> = self.conn.query_row("select receipt_json from project_memory_thread_receipts where session_id=?1 and provider_id=?2 and cursor_hash=?3",params![session.to_string(),provider,hash],|row|row.get(0)).optional()?;
        json.map(|json| serde_json::from_str(&json))
            .transpose()
            .map_err(Into::into)
    }

    pub fn record_project_memory_receipt(
        &self,
        session: Uuid,
        turn: Uuid,
        provider: &str,
        receipt: &MemoryReceipt,
    ) -> Result<()> {
        ensure!(
            self.get_session(session)?.is_some(),
            "unknown memory session"
        );
        let json = serde_json::to_string(receipt)?;
        ensure!(
            json.len() <= 32 * 1024,
            "memory receipt exceeds its size limit"
        );
        let operation = crate::mutations::content_hash(
            format!("{session}:{turn}:{provider}:{json}").as_bytes(),
        );
        let transaction = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        transaction.execute("insert into project_memory_turn_receipts (session_id,turn_id,provider_id,receipt_json) values (?1,?2,?3,?4) on conflict(session_id,turn_id,provider_id) do update set receipt_json=excluded.receipt_json",params![session.to_string(),turn.to_string(),provider,json])?;
        let inserted = transaction.execute("insert or ignore into project_memory_receipt_outbox (operation_id,session_id) values (?1,?2)",params![operation,session.to_string()])? > 0;
        let emitted: bool = transaction.query_row(
            "select emitted from project_memory_receipt_outbox where operation_id=?1",
            [&operation],
            |row| row.get(0),
        )?;
        transaction.commit()?;
        if !emitted {
            // Only a crash between append and acknowledgement needs history
            // reconciliation. Normal turns do no transcript scan.
            let already_appended = !inserted
                && self
                    .read_transcript_events(session)?
                    .iter()
                    .any(|event| event.payload["operationId"].as_str() == Some(operation.as_str()));
            if !already_appended {
                self.append_event_with_turn_id(session,crate::SessionEventKind::SystemEvent,"Project memory context prepared",serde_json::json!({"kind":"project-memory-context","schema":"gyro.project-memory-context.v1","operationId":operation,"providerId":provider,"receipt":receipt}),Some(turn))?;
            }
            self.conn.execute(
                "update project_memory_receipt_outbox set emitted=1 where operation_id=?1",
                [operation],
            )?;
        }
        Ok(())
    }

    /// Call only after a successful provider attempt acknowledges the thread.
    /// A failed/cancelled attempt never becomes a basis for suppressing context.
    pub fn acknowledge_project_memory_receipt(
        &self,
        session: Uuid,
        turn: Uuid,
        provider: &str,
        cursor_json: &serde_json::Value,
        receipt: &MemoryReceipt,
    ) -> Result<()> {
        let hash = crate::mutations::content_hash(serde_json::to_string(cursor_json)?.as_bytes());
        self.conn.execute("insert into project_memory_thread_receipts (session_id,provider_id,cursor_hash,receipt_json)
          select session_id,provider_id,?4,receipt_json from project_memory_turn_receipts where session_id=?1 and turn_id=?2 and provider_id=?3 and receipt_json=?5
          on conflict(session_id,provider_id) do update set cursor_hash=excluded.cursor_hash,receipt_json=excluded.receipt_json",params![session.to_string(),turn.to_string(),provider,hash,serde_json::to_string(receipt)?])?;
        Ok(())
    }
}
