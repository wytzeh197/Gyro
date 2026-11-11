use super::SessionStore;
use crate::project_memory::{MemoryCandidate, MemoryDraft};
use anyhow::{ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

pub(super) fn ensure_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch("create table if not exists project_memory_candidates (
      id text primary key not null, root_key text not null,
      source_session_id text not null references sessions(id) on delete cascade,
      source_turn_id text not null, source_event_id text not null,
      revision integer not null default 1, status text not null default 'pending',
      draft_json text, evidence_quote text);
      create index if not exists idx_memory_candidates_root on project_memory_candidates(root_key,status);")?;
    Ok(())
}

impl SessionStore {
    pub fn begin_project_memory_candidate_acceptance(
        &self,
        root_key: &str,
        id: &str,
        revision: u64,
        draft: &MemoryDraft,
    ) -> Result<()> {
        let changed=self.conn.execute("update project_memory_candidates set status='accepting',revision=revision+1,draft_json=?4 where root_key=?1 and id=?2 and revision=?3 and status in ('pending','accepting')",params![root_key,id,revision,serde_json::to_string(draft)?])?;
        ensure!(changed == 1, "memory suggestion changed; reload");
        Ok(())
    }
    pub fn add_project_memory_candidate(
        &self,
        root_key: &str,
        session: Uuid,
        turn: Uuid,
        event: Uuid,
        draft: &MemoryDraft,
        quote: &str,
    ) -> Result<()> {
        let json = serde_json::to_string(draft)?;
        ensure!(
            json.len() <= 8192 && quote.len() <= 1200,
            "memory candidate is too large"
        );
        let id = crate::mutations::content_hash(
            format!(
                "{root_key}:{session}:{turn}:{}",
                draft
                    .text
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .to_lowercase()
            )
            .as_bytes(),
        );
        self.conn.execute("insert or ignore into project_memory_candidates (id,root_key,source_session_id,source_turn_id,source_event_id,draft_json,evidence_quote) select ?1,?2,?3,?4,?5,?6,?7 where (select count(*) from project_memory_candidates where root_key=?2 and status in ('pending','accepting'))<100",params![id,root_key,session.to_string(),turn.to_string(),event.to_string(),json,quote])?;
        Ok(())
    }
    pub fn project_memory_candidates(&self, root_key: &str) -> Result<Vec<MemoryCandidate>> {
        let mut query=self.conn.prepare("select id,root_key,source_session_id,source_turn_id,source_event_id,revision,status,draft_json,evidence_quote from project_memory_candidates where root_key=?1 order by (status in ('pending','accepting')) desc,rowid desc limit 100")?;
        let rows = query.query_map([root_key], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, u64>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<String>>(8)?,
            ))
        })?;
        rows.map(|row| {
            let (
                id,
                root_key,
                source_session_id,
                source_turn_id,
                source_event_id,
                revision,
                status,
                draft,
                evidence_quote,
            ) = row?;
            Ok(MemoryCandidate {
                id,
                root_key,
                source_session_id,
                source_turn_id,
                source_event_id,
                revision,
                status,
                draft: draft.map(|json| serde_json::from_str(&json)).transpose()?,
                evidence_quote,
            })
        })
        .collect()
    }
    pub fn project_memory_candidate(&self, root_key: &str, id: &str) -> Result<MemoryCandidate> {
        self.conn.query_row("select id,root_key,source_session_id,source_turn_id,source_event_id,revision,status,draft_json,evidence_quote from project_memory_candidates where root_key=?1 and id=?2",params![root_key,id],|row| {
            let raw:Option<String>=row.get(7)?;
            let draft=raw.map(|json|serde_json::from_str(&json)).transpose().map_err(|error|rusqlite::Error::FromSqlConversionFailure(7,rusqlite::types::Type::Text,Box::new(error)))?;
            Ok(MemoryCandidate{id:row.get(0)?,root_key:row.get(1)?,source_session_id:row.get(2)?,source_turn_id:row.get(3)?,source_event_id:row.get(4)?,revision:row.get(5)?,status:row.get(6)?,draft,evidence_quote:row.get(8)?})
        }).optional()?.ok_or_else(||anyhow::anyhow!("memory suggestion is unavailable"))
    }
    pub fn decide_project_memory_candidate(
        &self,
        root_key: &str,
        id: &str,
        revision: u64,
        status: &str,
    ) -> Result<()> {
        ensure!(
            ["accepting", "accepted", "dismissed"].contains(&status),
            "invalid memory suggestion decision"
        );
        let clear = status == "accepted" || status == "dismissed";
        let changed=self.conn.execute("update project_memory_candidates set status=?4,revision=revision+1,draft_json=case when ?5 then null else draft_json end,evidence_quote=case when ?5 then null else evidence_quote end where root_key=?1 and id=?2 and revision=?3 and status in ('pending','accepting')",params![root_key,id,revision,status,clear])?;
        if changed == 0 {
            let actual: Option<String> = self
                .conn
                .query_row(
                    "select status from project_memory_candidates where root_key=?1 and id=?2",
                    params![root_key, id],
                    |row| row.get(0),
                )
                .optional()?;
            ensure!(
                actual.as_deref() == Some(status),
                "memory suggestion changed; reload"
            );
        }
        Ok(())
    }
}
