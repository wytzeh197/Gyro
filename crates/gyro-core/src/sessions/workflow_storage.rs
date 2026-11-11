use super::SessionStore;
use crate::workflows::*;
use anyhow::{ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;
pub(super) fn ensure_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch("create table if not exists workflow_runs(id text primary key not null, operation_id text unique not null, automation_id text, source_session_id text not null references sessions(id) on delete cascade, revision integer not null, status text not null, run_json text not null);
    create index if not exists idx_workflow_runs_source on workflow_runs(source_session_id);
    create table if not exists workflow_journal(run_id text not null references workflow_runs(id) on delete cascade,revision integer not null,step_id text,status text not null,created_at text not null,primary key(run_id,revision));")?;
    conn.execute_batch("create unique index if not exists idx_workflow_active_root on workflow_runs(json_extract(run_json,'$.rootKey')) where status in ('queued','running','waiting');")?;
    Ok(())
}
fn encoded_status(status: WorkflowRunStatus) -> String {
    serde_json::to_value(status)
        .unwrap()
        .as_str()
        .unwrap()
        .into()
}
impl SessionStore {
    pub fn workflow_run_summaries(&self) -> Result<Vec<serde_json::Value>> {
        let mut paths = vec![
            "'$.binding'".to_string(),
            "'$.definition.steps'".to_string(),
            "'$.definition.inputs'".to_string(),
        ];
        for index in 0..12 {
            paths.push(format!("'$.steps[{index}].output'"));
        }
        let sql=format!("select json_remove(run_json,{}) from workflow_runs order by (status in ('queued','running','waiting')) desc,rowid desc limit 100",paths.join(","));
        let mut query = self.conn.prepare(&sql)?;
        let rows = query.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }

    pub fn workflow_dispatch_origin(&self, session: Uuid) -> Result<Option<crate::UsageOrigin>> {
        let json:Option<String>=self.conn.query_row("select run_json from workflow_runs where status='running' and exists(select 1 from json_each(run_json,'$.steps') where json_extract(value,'$.sessionId')=?1 and json_extract(value,'$.status')='running') limit 1",[session.to_string()],|row|row.get(0)).optional()?;
        json.map(|json| serde_json::from_str::<WorkflowRun>(&json).map(|run| run.origin))
            .transpose()
            .map_err(Into::into)
    }
    pub fn workflow_run_for_operation(&self, id: Uuid) -> Result<Option<WorkflowRun>> {
        let json: Option<String> = self
            .conn
            .query_row(
                "select run_json from workflow_runs where operation_id=?1",
                [id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        json.map(|json| serde_json::from_str(&json))
            .transpose()
            .map_err(Into::into)
    }
    pub fn active_workflow_for_root(&self, root: &str) -> Result<Option<WorkflowRun>> {
        let json:Option<String>=self.conn.query_row("select run_json from workflow_runs where status in ('queued','running','waiting') and json_extract(run_json,'$.rootKey')=?1",[root],|row|row.get(0)).optional()?;
        json.map(|json| serde_json::from_str(&json))
            .transpose()
            .map_err(Into::into)
    }
    pub fn validate_workflow_dispatch(
        &self,
        id: Uuid,
        session: Uuid,
        provider: &str,
        model: Option<&str>,
        root: &str,
    ) -> Result<WorkflowAccess> {
        let run = self
            .workflow_run(id)?
            .ok_or_else(|| anyhow::anyhow!("workflow is unavailable"))?;
        ensure!(
            run.status == WorkflowRunStatus::Running && run.root_key == root,
            "workflow is stopped or its root changed"
        );
        let index = run
            .steps
            .iter()
            .position(|step| {
                step.status == WorkflowStepStatus::Running && step.session_id == Some(session)
            })
            .ok_or_else(|| anyhow::anyhow!("session is not the running workflow step"))?;
        let WorkflowStep::Agent {
            role,
            requested_access,
            ..
        } = &run.definition.steps[index]
        else {
            anyhow::bail!("only an agent step can dispatch an ordinary provider turn")
        };
        let binding = &run.binding.roles[role];
        ensure!(
            binding.provider_id == provider && Some(binding.model_id.as_str()) == model,
            "workflow role binding changed"
        );
        Ok(
            if *requested_access == WorkflowAccess::ReadOnly
                || binding.access_ceiling == WorkflowAccess::ReadOnly
            {
                WorkflowAccess::ReadOnly
            } else {
                WorkflowAccess::Workspace
            },
        )
    }
    pub fn create_workflow_run(
        &self,
        operation: Uuid,
        automation: Option<Uuid>,
        source: Uuid,
        root_id: &str,
        root_key: &str,
        definition: &WorkflowDefinition,
        binding: &WorkflowBinding,
        origin: crate::UsageOrigin,
    ) -> Result<WorkflowRun> {
        let transaction = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        binding.validate(definition)?;
        ensure!(
            self.get_session(source)?.is_some(),
            "workflow source session is unavailable"
        );
        ensure!(
            root_id.len() <= 96 && root_key.len() <= 4096,
            "invalid workflow root"
        );
        let existing: Option<String> = self
            .conn
            .query_row(
                "select run_json from workflow_runs where operation_id=?1",
                [operation.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(json) = existing {
            let run: WorkflowRun = serde_json::from_str(&json)?;
            ensure!(
                run.automation_id == automation
                    && run.source_session_id == source
                    && run.root_id == root_id
                    && run.root_key == root_key
                    && run.definition == *definition
                    && run.binding == *binding
                    && run.origin == origin,
                "workflow operation belongs to a different launch"
            );
            return Ok(run);
        }
        let run = WorkflowRun {
            previous_run_id: None,
            id: Uuid::new_v4(),
            operation_id: operation,
            revision: 1,
            automation_id: automation,
            source_session_id: source,
            root_id: root_id.into(),
            root_key: root_key.into(),
            origin,
            definition: definition.clone(),
            binding: binding.clone(),
            status: WorkflowRunStatus::Queued,
            steps: definition
                .steps
                .iter()
                .map(|step| WorkflowStepAttempt {
                    step_id: step.id().into(),
                    status: WorkflowStepStatus::Pending,
                    session_id: None,
                    turn_id: None,
                    review_id: None,
                    output: None,
                    verification_passed: None,
                    review_completed: None,
                    open_findings: 0,
                    error: None,
                })
                .collect(),
            requirements_met: None,
            error: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            finished_at: None,
        };
        let active: u64 = self.conn.query_row(
            "select count(*) from workflow_runs where status in ('queued','running','waiting')",
            [],
            |row| row.get(0),
        )?;
        ensure!(active < 100, "workflow queue is full");
        self.conn.execute("insert into workflow_runs(id,operation_id,automation_id,source_session_id,revision,status,run_json) values (?1,?2,?3,?4,1,'queued',?5)",params![run.id.to_string(),operation.to_string(),automation.map(|id|id.to_string()),source.to_string(),serde_json::to_string(&run)?])?;
        transaction.commit()?;
        Ok(run)
    }
    pub fn workflow_run(&self, id: Uuid) -> Result<Option<WorkflowRun>> {
        let json: Option<String> = self
            .conn
            .query_row(
                "select run_json from workflow_runs where id=?1",
                [id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        json.map(|json| serde_json::from_str(&json))
            .transpose()
            .map_err(Into::into)
    }
    pub fn workflow_runs(&self, source: Option<Uuid>) -> Result<Vec<WorkflowRun>> {
        let mut query=self.conn.prepare("select run_json from workflow_runs where (?1 is null or source_session_id=?1) order by (status in ('queued','running','waiting')) desc,rowid desc limit 100")?;
        let rows = query.query_map([source.map(|id| id.to_string())], |row| {
            row.get::<_, String>(0)
        })?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }
    pub(super) fn save_workflow_revision(
        &self,
        run: &WorkflowRun,
        expected: u64,
        step: Option<&str>,
    ) -> Result<()> {
        let json = serde_json::to_string(run)?;
        ensure!(
            json.len() <= 2 * 1024 * 1024,
            "workflow state exceeds its size limit"
        );
        let transaction = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        ensure!(transaction.execute("update workflow_runs set revision=?3,status=?4,run_json=?5 where id=?1 and revision=?2",params![run.id.to_string(),expected,run.revision,encoded_status(run.status),json])?==1,"workflow changed; reload");
        transaction.execute("insert into workflow_journal(run_id,revision,step_id,status,created_at) values (?1,?2,?3,?4,?5)",params![run.id.to_string(),run.revision,step,encoded_status(run.status),chrono::Utc::now().to_rfc3339()])?;
        transaction.commit()?;
        Ok(())
    }
    pub fn begin_workflow_step(
        &self,
        id: Uuid,
        expected: u64,
        index: usize,
        session: Uuid,
        turn: Option<Uuid>,
    ) -> Result<WorkflowRun> {
        let mut run = self
            .workflow_run(id)?
            .ok_or_else(|| anyhow::anyhow!("workflow is unavailable"))?;
        ensure!(
            run.revision == expected
                && matches!(
                    run.status,
                    WorkflowRunStatus::Queued | WorkflowRunStatus::Running
                )
                && index < run.steps.len(),
            "workflow dispatch is stale or unavailable"
        );
        ensure!(
            run.steps[..index]
                .iter()
                .all(|step| step.status == WorkflowStepStatus::Completed)
                && run.steps[index].status == WorkflowStepStatus::Pending,
            "workflow step cannot be replayed or run out of order"
        );
        let child = self
            .get_session(session)?
            .ok_or_else(|| anyhow::anyhow!("workflow step session is unavailable"))?;
        let parent = match &run.definition.steps[index] {
            WorkflowStep::Review { source_step, .. } => run
                .steps
                .iter()
                .find(|step| &step.step_id == source_step)
                .and_then(|step| step.session_id),
            _ => Some(run.source_session_id),
        };
        ensure!(
            child.parent_session_id == parent || child.id == run.source_session_id,
            "workflow child belongs to another source"
        );
        run.status = WorkflowRunStatus::Running;
        run.steps[index].status = WorkflowStepStatus::Running;
        run.steps[index].session_id = Some(session);
        if matches!(run.definition.steps[index], WorkflowStep::Review { .. }) {
            let json:String=self.conn.query_row("select run_json from code_reviews where json_extract(run_json,'$.reviewSessionId')=?1 and json_extract(run_json,'$.workflowRunId')=?2",params![session.to_string(),id.to_string()],|row|row.get(0))?;
            let review: crate::code_reviews::CodeReviewRun = serde_json::from_str(&json)?;
            run.steps[index].review_id = Some(review.id);
        }
        run.steps[index].turn_id = turn;
        run.revision += 1;
        self.save_workflow_revision(&run, expected, Some(&run.steps[index].step_id))?;
        Ok(run)
    }
    pub fn complete_workflow_step(
        &self,
        id: Uuid,
        expected: u64,
        index: usize,
        output: String,
        review: Option<(Uuid, bool, usize)>,
        verification: Option<bool>,
    ) -> Result<WorkflowRun> {
        ensure!(
            output.len() <= 128 * 1024,
            "workflow output exceeds 128 KiB"
        );
        let mut run = self
            .workflow_run(id)?
            .ok_or_else(|| anyhow::anyhow!("workflow is unavailable"))?;
        ensure!(
            run.revision == expected
                && run.status == WorkflowRunStatus::Running
                && index < run.steps.len()
                && run.steps[index].status == WorkflowStepStatus::Running,
            "workflow result is stale or cancelled"
        );
        match &run.definition.steps[index] {
            WorkflowStep::Agent {
                output: required, ..
            } => {
                ensure!(
                    !required.required || !output.trim().is_empty(),
                    "required workflow output is missing"
                );
                ensure!(
                    review.is_none() && verification.is_none(),
                    "agent result cannot assert review or verification completion"
                );
            }
            WorkflowStep::Review { .. } => ensure!(
                review.is_some() && verification.is_none(),
                "review result must reference its review"
            ),
            WorkflowStep::Verification { .. } => ensure!(
                verification.is_some() && review.is_none(),
                "verification needs an exit verdict"
            ),
        }
        if let Some((review_id, completed, open)) = review {
            let record = self
                .code_review(review_id)?
                .ok_or_else(|| anyhow::anyhow!("workflow review is unavailable"))?;
            let WorkflowStep::Review { source_step, .. } = &run.definition.steps[index] else {
                anyhow::bail!("only review steps can record a review")
            };
            let source = run
                .steps
                .iter()
                .find(|step| &step.step_id == source_step)
                .and_then(|step| step.session_id);
            ensure!(
                Some(record.source_session_id) == source && record.origin == run.origin,
                "review belongs to a different workflow step or trigger"
            );
            ensure!(
                record.status.terminal()
                    && completed == (record.status == crate::code_reviews::ReviewStatus::Completed)
                    && open
                        == record
                            .findings
                            .iter()
                            .filter(|finding| !matches!(
                                finding.disposition,
                                crate::code_reviews::FindingDisposition::Dismissed
                                    | crate::code_reviews::FindingDisposition::ResolvedByReview
                            ))
                            .count(),
                "workflow review result does not match stored evidence"
            );
            run.steps[index].review_id = Some(review_id);
            run.steps[index].review_completed = Some(completed);
            run.steps[index].open_findings = open;
        }
        run.steps[index].output = Some(output);
        run.steps[index].verification_passed = verification;
        run.steps[index].status = WorkflowStepStatus::Completed;
        if index + 1 == run.steps.len() {
            run.status = WorkflowRunStatus::Completed;
            run.finished_at = Some(chrono::Utc::now().to_rfc3339());
            run.requirements_met = Some(
                run.definition
                    .completion
                    .required_outputs
                    .iter()
                    .all(|name| {
                        run.definition
                            .steps
                            .iter()
                            .enumerate()
                            .any(|(index, step)| {
                                matches!(step,WorkflowStep::Agent{output,..}if &output.name==name)
                                    && run.steps[index]
                                        .output
                                        .as_ref()
                                        .is_some_and(|text| !text.trim().is_empty())
                            })
                    })
                    && (!run.definition.completion.require_review_completion
                        || run
                            .steps
                            .iter()
                            .filter(|step| step.review_id.is_some())
                            .all(|step| step.review_completed == Some(true)))
                    && (!run.definition.completion.require_verification_success
                        || run
                            .steps
                            .iter()
                            .filter(|step| step.verification_passed.is_some())
                            .all(|step| step.verification_passed == Some(true)))
                    && run.steps.iter().all(|step| {
                        step.open_findings == 0
                            && step.review_completed != Some(false)
                            && step.verification_passed != Some(false)
                    }),
            );
        }
        run.revision += 1;
        self.save_workflow_revision(&run, expected, Some(&run.steps[index].step_id))?;
        Ok(run)
    }
    pub fn stop_workflow_run(
        &self,
        id: Uuid,
        expected: u64,
        status: WorkflowRunStatus,
        error: &str,
    ) -> Result<WorkflowRun> {
        ensure!(
            matches!(
                status,
                WorkflowRunStatus::Waiting
                    | WorkflowRunStatus::Failed
                    | WorkflowRunStatus::Cancelled
                    | WorkflowRunStatus::Interrupted
            ),
            "invalid workflow stop state"
        );
        let mut run = self
            .workflow_run(id)?
            .ok_or_else(|| anyhow::anyhow!("workflow is unavailable"))?;
        ensure!(
            run.revision == expected && !run.status.terminal(),
            "workflow changed or is already finished"
        );
        for step in &mut run.steps {
            if step.status == WorkflowStepStatus::Running {
                step.status = match status {
                    WorkflowRunStatus::Waiting => WorkflowStepStatus::Waiting,
                    WorkflowRunStatus::Cancelled => WorkflowStepStatus::Cancelled,
                    WorkflowRunStatus::Interrupted => WorkflowStepStatus::Interrupted,
                    _ => WorkflowStepStatus::Failed,
                };
                step.error = Some(crate::sanitize_capability_summary(error));
            }
        }
        run.status = status;
        run.error = Some(crate::sanitize_capability_summary(error));
        run.revision += 1;
        if status.terminal() {
            run.finished_at = Some(chrono::Utc::now().to_rfc3339());
        }
        self.save_workflow_revision(&run, expected, None)?;
        Ok(run)
    }
}
