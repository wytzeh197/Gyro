use super::SessionStore;
use anyhow::{ensure, Result};
use rusqlite::params;
use uuid::Uuid;
impl SessionStore {
    pub fn delete_workflow_run(&self, id: Uuid, expected: u64) -> Result<()> {
        let transaction = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let run = self
            .workflow_run(id)?
            .ok_or_else(|| anyhow::anyhow!("workflow is unavailable"))?;
        ensure!(
            run.status.terminal() && run.revision == expected,
            "Stop the workflow and reload before deleting its run record"
        );
        let continuations:u64=self.conn.query_row("select count(*) from workflow_runs where status in ('queued','running','waiting') and json_extract(run_json,'$.previousRunId')=?1",[id.to_string()],|row|row.get(0))?;
        ensure!(
            continuations == 0,
            "Stop the active continuation before deleting its prior evidence"
        );
        ensure!(
            self.conn.execute(
                "delete from workflow_runs where id=?1 and revision=?2",
                params![id.to_string(), expected]
            )? == 1,
            "workflow changed; reload"
        );
        transaction.commit()?;
        Ok(())
    }
}
