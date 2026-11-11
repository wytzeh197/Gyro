//! A continuation copies only acknowledged completed steps into a new run.
use super::SessionStore;
use crate::workflows::*;
use anyhow::{ensure, Result};
use uuid::Uuid;
impl SessionStore {
    pub fn inherit_completed_workflow_steps(
        &self,
        id: Uuid,
        previous: Uuid,
        revision: u64,
    ) -> Result<WorkflowRun> {
        let mut run = self
            .workflow_run(id)?
            .ok_or_else(|| anyhow::anyhow!("continuation is unavailable"))?;
        let prior = self
            .workflow_run(previous)?
            .ok_or_else(|| anyhow::anyhow!("previous workflow is unavailable"))?;
        ensure!(
            prior.revision == revision
                && matches!(
                    prior.status,
                    WorkflowRunStatus::Interrupted
                        | WorkflowRunStatus::Cancelled
                        | WorkflowRunStatus::Failed
                ),
            "previous run changed or is still active"
        );
        ensure!(
            run.definition == prior.definition
                && run.binding == prior.binding
                && run.root_key == prior.root_key,
            "continuation configuration differs from the original run"
        );
        if run.previous_run_id == Some(previous) {
            return Ok(run);
        }
        ensure!(
            run.status == WorkflowRunStatus::Queued
                && run.revision == 1
                && run.previous_run_id.is_none(),
            "continuation has already started"
        );
        let prefix = prior
            .steps
            .iter()
            .take_while(|step| step.status == WorkflowStepStatus::Completed)
            .count();
        ensure!(
            prefix < prior.steps.len(),
            "there are no unfinished steps to retry"
        );
        for index in 0..prefix {
            run.steps[index] = prior.steps[index].clone();
        }
        run.previous_run_id = Some(previous);
        run.revision += 1;
        self.save_workflow_revision(&run, 1, None)?;
        Ok(run)
    }
}
