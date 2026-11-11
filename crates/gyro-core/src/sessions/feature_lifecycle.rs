use super::{SessionStore, MAX_SUBAGENT_SESSION_TREE};
use anyhow::{ensure, Result};
use uuid::Uuid;
impl SessionStore {
    pub fn feature_session_tree(&self, source: Uuid) -> Result<Vec<Uuid>> {
        let mut statement=self.conn.prepare("with recursive tree(id) as (select id from sessions where id=?1 union select sessions.id from sessions join tree on sessions.parent_session_id=tree.id) select id from tree limit ?2")?;
        let ids: Vec<String> = statement
            .query_map(
                rusqlite::params![source.to_string(), (MAX_SUBAGENT_SESSION_TREE + 2) as u64],
                |row| row.get(0),
            )?
            .collect::<std::result::Result<_, _>>()?;
        ensure!(
            ids.len() <= MAX_SUBAGENT_SESSION_TREE + 1,
            "session tree is too large; delete child sessions first"
        );
        ids.into_iter()
            .map(|id| Uuid::parse_str(&id).map_err(Into::into))
            .collect()
    }
    pub(super) fn prepare_feature_session_deletion(&self, source: Uuid) -> Result<()> {
        let sources = self.feature_session_tree(source)?;
        for source in &sources {
            self.check_feature_session_deletion(*source)?;
        }
        for source in sources {
            self.cleanup_feature_session_deletion(source)?;
        }
        Ok(())
    }
    fn check_feature_session_deletion(&self, source: Uuid) -> Result<()> {
        let fixes:u64=self.conn.query_row("select count(*) from review_fix_intents where source_session_id=?1 and status in ('queued','dispatching','sent')",[source.to_string()],|row|row.get(0))?;
        ensure!(
            fixes == 0,
            "Stop this chat's queued fixes before deleting it"
        );
        let active:u64=self.conn.query_row("select count(*) from code_reviews where source_session_id=?1 and status in ('queued','capturing','running')",[source.to_string()],|row|row.get(0))?;
        ensure!(
            active == 0,
            "Stop this session's active reviews before deleting it"
        );
        let reviewing:u64=self.conn.query_row("select count(*) from code_reviews where json_extract(run_json,'$.reviewSessionId')=?1 and status in ('queued','capturing','running')",[source.to_string()],|row|row.get(0))?;
        ensure!(
            reviewing == 0,
            "Stop the managed review before deleting its reviewer session"
        );
        let workflows:u64=self.conn.query_row("select count(*) from workflow_runs where source_session_id=?1 and status in ('queued','running','waiting')",[source.to_string()],|row|row.get(0))?;
        ensure!(
            workflows == 0,
            "Stop this session's workflows before deleting it"
        );
        Ok(())
    }
    fn cleanup_feature_session_deletion(&self, source: Uuid) -> Result<()> {
        loop {
            let runs = self.code_reviews(Some(source))?;
            if runs.is_empty() {
                break;
            }
            for run in runs {
                self.delete_code_review(run.id, run.revision)?;
            }
        }
        self.discard_code_review_previews(source, None)?;
        for draft in self.workflow_drafts(Some(source))? {
            ensure!(
                !draft.status.active(),
                "Stop extraction before deleting this source chat"
            );
            self.delete_workflow_draft(draft.id, draft.revision)?;
        }
        Ok(())
    }
}
