use super::SessionStore;
use crate::workflows::*;
use anyhow::{ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;
pub(super) fn ensure_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch("create table if not exists workflow_drafts(id text primary key not null,source_session_id text not null references sessions(id) on delete cascade,revision integer not null,status text not null,draft_json text not null);
create table if not exists workflow_bindings(root_key text not null,definition_id text not null,revision integer not null,binding_json text not null,primary key(root_key,definition_id));")?;
    Ok(())
}
fn status(status: WorkflowDraftStatus) -> String {
    serde_json::to_value(status)
        .unwrap()
        .as_str()
        .unwrap()
        .into()
}
impl SessionStore {
    pub fn save_workflow_binding(
        &self,
        root: &str,
        definition: &WorkflowDefinition,
        binding: &WorkflowBinding,
        expected: u64,
    ) -> Result<u64> {
        binding.validate(definition)?;
        let json = serde_json::to_string(binding)?;
        ensure!(json.len() <= 1024 * 1024, "workflow binding is too large");
        let transaction = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let revision: Option<u64> = self
            .conn
            .query_row(
                "select revision from workflow_bindings where root_key=?1 and definition_id=?2",
                params![root, definition.id],
                |row| row.get(0),
            )
            .optional()?;
        ensure!(
            revision.unwrap_or(0) == expected,
            "workflow setup changed; reload before saving"
        );
        let next = expected + 1;
        self.conn.execute("insert into workflow_bindings(root_key,definition_id,revision,binding_json) values (?1,?2,?3,?4) on conflict(root_key,definition_id) do update set revision=?3,binding_json=?4",params![root,definition.id,next,json])?;
        transaction.commit()?;
        Ok(next)
    }
    pub fn workflow_binding(&self, root: &str, id: &str) -> Result<Option<(u64, WorkflowBinding)>> {
        let row:Option<(u64,String)>=self.conn.query_row("select revision,binding_json from workflow_bindings where root_key=?1 and definition_id=?2",params![root,id],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
        row.map(|(revision, json)| Ok((revision, serde_json::from_str(&json)?)))
            .transpose()
    }
    pub fn create_workflow_draft(
        &self,
        source: Uuid,
        root_id: &str,
        root_key: &str,
        turns: Vec<Uuid>,
        source_complete: bool,
        input: String,
    ) -> Result<WorkflowDraft> {
        ensure!(
            self.get_session(source)?.is_some()
                && !turns.is_empty()
                && turns.len() <= 20
                && input.len() <= 64 * 1024
                && root_id.len() <= 96
                && root_key.len() <= 4096,
            "workflow extraction capture exceeds its limits"
        );
        let count: u64 = self.conn.query_row(
            "select count(*) from workflow_drafts where source_session_id=?1",
            [source.to_string()],
            |row| row.get(0),
        )?;
        ensure!(
            count < 100,
            "delete earlier workflow drafts before capturing more"
        );
        let draft = WorkflowDraft {
            id: Uuid::new_v4(),
            revision: 1,
            source_session_id: source,
            root_id: root_id.into(),
            root_key: root_key.into(),
            source_turn_ids: turns,
            source_complete,
            capture_hash: crate::mutations::content_hash(input.as_bytes()),
            input,
            status: WorkflowDraftStatus::Preview,
            extraction_session_id: None,
            provider_id: None,
            model_id: None,
            definition: None,
            error: None,
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        self.conn.execute("insert into workflow_drafts(id,source_session_id,revision,status,draft_json) values (?1,?2,1,'preview',?3)",params![draft.id.to_string(),source.to_string(),serde_json::to_string(&draft)?])?;
        Ok(draft)
    }
    pub fn workflow_draft(&self, id: Uuid) -> Result<Option<WorkflowDraft>> {
        let json: Option<String> = self
            .conn
            .query_row(
                "select draft_json from workflow_drafts where id=?1",
                [id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        json.map(|json| serde_json::from_str(&json))
            .transpose()
            .map_err(Into::into)
    }
    pub fn workflow_drafts(&self, source: Option<Uuid>) -> Result<Vec<WorkflowDraft>> {
        let mut statement=self.conn.prepare("select draft_json from workflow_drafts where (?1 is null or source_session_id=?1) order by (status in ('queued','running')) desc,rowid desc limit 100")?;
        let rows = statement.query_map([source.map(|id| id.to_string())], |row| {
            row.get::<_, String>(0)
        })?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }
    fn save_workflow_draft(&self, draft: &WorkflowDraft, expected: u64) -> Result<()> {
        let json = serde_json::to_string(draft)?;
        ensure!(json.len() <= 512 * 1024, "workflow draft is too large");
        ensure!(self.conn.execute("update workflow_drafts set revision=?3,status=?4,draft_json=?5 where id=?1 and revision=?2",params![draft.id.to_string(),expected,draft.revision,status(draft.status),json])?==1,"workflow draft changed; reload");
        Ok(())
    }
    pub fn queue_workflow_extraction(
        &self,
        id: Uuid,
        expected: u64,
        hash: &str,
        provider: &str,
        model: &str,
    ) -> Result<WorkflowDraft> {
        let transaction = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let mut draft = self
            .workflow_draft(id)?
            .ok_or_else(|| anyhow::anyhow!("workflow draft is unavailable"))?;
        if draft.status != WorkflowDraftStatus::Preview {
            ensure!(
                draft.capture_hash == hash
                    && draft.provider_id.as_deref() == Some(provider)
                    && draft.model_id.as_deref() == Some(model),
                "extraction ID belongs to different input or reviewer"
            );
            return Ok(draft);
        }
        ensure!(
            draft.revision == expected
                && draft.capture_hash == hash
                && !provider.is_empty()
                && provider.len() <= 100
                && !model.is_empty()
                && model.len() <= 200,
            "extraction input changed or provider/model is missing"
        );
        let active: u64 = self.conn.query_row(
            "select count(*) from workflow_drafts where status in ('queued','running')",
            [],
            |row| row.get(0),
        )?;
        ensure!(active < 100, "workflow extraction queue is full");
        draft.provider_id = Some(provider.into());
        draft.model_id = Some(model.into());
        draft.status = WorkflowDraftStatus::Queued;
        draft.revision += 1;
        self.save_workflow_draft(&draft, expected)?;
        transaction.commit()?;
        Ok(draft)
    }
    pub fn start_workflow_extraction(
        &self,
        id: Uuid,
        expected: u64,
        session: Uuid,
    ) -> Result<WorkflowDraft> {
        let mut draft = self
            .workflow_draft(id)?
            .ok_or_else(|| anyhow::anyhow!("workflow draft is unavailable"))?;
        ensure!(
            draft.revision == expected && draft.status == WorkflowDraftStatus::Queued,
            "extraction is stale or already started"
        );
        let child = self
            .get_session(session)?
            .ok_or_else(|| anyhow::anyhow!("extraction session is unavailable"))?;
        ensure!(
            child.parent_session_id == Some(draft.source_session_id)
                && child.provider_id == draft.provider_id
                && child.model_id == draft.model_id,
            "extraction session binding mismatch"
        );
        self.assign_advisory_session(
            session,
            crate::provider_runtime::types::InternalRequestPurpose::WorkflowExtraction,
        )?;
        draft.extraction_session_id = Some(session);
        draft.status = WorkflowDraftStatus::Running;
        draft.revision += 1;
        self.save_workflow_draft(&draft, expected)?;
        Ok(draft)
    }
    pub fn finish_workflow_extraction(
        &self,
        id: Uuid,
        expected: u64,
        definition: WorkflowDefinition,
    ) -> Result<WorkflowDraft> {
        validate_definition(&definition)?;
        let mut draft = self
            .workflow_draft(id)?
            .ok_or_else(|| anyhow::anyhow!("workflow draft is unavailable"))?;
        ensure!(
            draft.revision == expected && draft.status == WorkflowDraftStatus::Running,
            "extraction stopped or changed"
        );
        draft.definition = Some(definition);
        draft.status = WorkflowDraftStatus::Ready;
        draft.revision += 1;
        self.save_workflow_draft(&draft, expected)?;
        Ok(draft)
    }
    pub fn stop_workflow_extraction(
        &self,
        id: Uuid,
        expected: u64,
        next: WorkflowDraftStatus,
        error: &str,
    ) -> Result<WorkflowDraft> {
        ensure!(
            matches!(
                next,
                WorkflowDraftStatus::Failed
                    | WorkflowDraftStatus::Interrupted
                    | WorkflowDraftStatus::Cancelled
            ),
            "invalid extraction stop state"
        );
        let mut draft = self
            .workflow_draft(id)?
            .ok_or_else(|| anyhow::anyhow!("workflow draft is unavailable"))?;
        ensure!(
            draft.revision == expected
                && matches!(
                    draft.status,
                    WorkflowDraftStatus::Queued
                        | WorkflowDraftStatus::Running
                        | WorkflowDraftStatus::Preview
                ),
            "extraction is finished or changed"
        );
        draft.status = next;
        draft.error = Some(crate::sanitize_capability_summary(error));
        draft.revision += 1;
        self.save_workflow_draft(&draft, expected)?;
        Ok(draft)
    }
    pub fn delete_workflow_draft(&self, id: Uuid, expected: u64) -> Result<()> {
        let draft = self
            .workflow_draft(id)?
            .ok_or_else(|| anyhow::anyhow!("workflow draft is unavailable"))?;
        ensure!(
            draft.revision == expected && !draft.status.active(),
            "stop extraction and reload before deleting the draft"
        );
        delete_draft_output(self.paths(), id)?;
        ensure!(
            self.conn.execute(
                "delete from workflow_drafts where id=?1 and revision=?2",
                params![id.to_string(), expected]
            )? == 1,
            "workflow draft changed; reload"
        );
        Ok(())
    }
}
