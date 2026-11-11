use super::SessionStore;
use crate::code_reviews::{
    CodeReviewRun, FindingDisposition, ParsedReview, ReviewSnapshot, ReviewStatus,
};
use anyhow::{ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

pub(super) fn ensure_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch("create table if not exists code_reviews (
      id text primary key not null, source_session_id text not null references sessions(id) on delete cascade,
      revision integer not null, status text not null, run_json text not null);
      create index if not exists idx_code_reviews_source on code_reviews(source_session_id);
      create table if not exists code_review_transitions (
        review_id text not null references code_reviews(id) on delete cascade,
        revision integer not null, status text not null, created_at text not null,
        primary key(review_id,revision));")?;
    conn.execute_batch("create table if not exists feature_session_roles (session_id text primary key not null references sessions(id) on delete cascade,role text not null);")?;
    conn.execute_batch("create table if not exists code_review_operations (operation_id text primary key not null,review_id text not null references code_reviews(id) on delete cascade);")?;
    conn.execute_batch("create table if not exists code_review_captures(id text primary key not null,source_session_id text not null references sessions(id) on delete cascade,root_id text not null,manifest_hash text not null);")?;
    Ok(())
}
fn status(value: ReviewStatus) -> String {
    serde_json::to_value(value)
        .unwrap()
        .as_str()
        .unwrap()
        .to_string()
}
impl SessionStore {
    pub fn register_code_review_capture(&self, snapshot: &ReviewSnapshot) -> Result<()> {
        let pending:u64=self.conn.query_row("select count(*) from code_review_captures where source_session_id=?1 and not exists(select 1 from code_reviews where json_extract(run_json,'$.snapshotId')=code_review_captures.id)",[snapshot.source_session_id.to_string()],|row|row.get(0))?;
        ensure!(
            pending < 20,
            "Discard earlier preview inputs before capturing more revisions"
        );
        self.conn.execute("insert into code_review_captures(id,source_session_id,root_id,manifest_hash) values (?1,?2,?3,?4)",params![snapshot.id.to_string(),snapshot.source_session_id.to_string(),snapshot.root_id,snapshot.manifest_hash])?;
        Ok(())
    }
    pub fn discard_code_review_previews(&self, source: Uuid, root: Option<&str>) -> Result<usize> {
        let transaction = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let ids: Vec<String> = {
            let mut statement=self.conn.prepare("select id from code_review_captures where source_session_id=?1 and (?2 is null or root_id=?2) and not exists(select 1 from code_reviews where json_extract(run_json,'$.snapshotId')=code_review_captures.id)")?;
            let ids = statement
                .query_map(params![source.to_string(), root], |row| row.get(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            ids
        };
        for id in &ids {
            crate::code_reviews::delete_snapshot_artifact(self.paths(), Uuid::parse_str(id)?)?;
            self.conn
                .execute("delete from code_review_captures where id=?1", [id])?;
        }
        transaction.commit()?;
        Ok(ids.len())
    }
    pub fn delete_code_review(&self, id: Uuid, expected: u64) -> Result<Option<Uuid>> {
        let transaction = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let run = self
            .code_review(id)?
            .ok_or_else(|| anyhow::anyhow!("review is unavailable"))?;
        ensure!(
            run.status.terminal() && run.revision == expected,
            "stop the review and reload before deleting it"
        );
        let active_fixes:u64=self.conn.query_row("select count(*) from review_fix_intents where review_id=?1 and status in ('queued','dispatching','sent')",[id.to_string()],|row|row.get(0))?;
        ensure!(
            active_fixes == 0,
            "Cancel the review's active fix requests before deleting it"
        );
        let mut removable = run.snapshot_id;
        if let Some(snapshot) = removable {
            let mut statement = self.conn.prepare("select run_json from code_reviews")?;
            for row in statement.query_map([], |row| row.get::<_, String>(0))? {
                let other: CodeReviewRun = serde_json::from_str(&row?)?;
                if other.id != id && other.snapshot_id == Some(snapshot) {
                    removable = None;
                    break;
                }
            }
        }
        crate::code_reviews::delete_review_artifacts(self.paths(), id, removable)?;
        if let Some(snapshot) = removable {
            self.conn.execute(
                "delete from code_review_captures where id=?1",
                [snapshot.to_string()],
            )?;
        }
        ensure!(
            self.conn.execute(
                "delete from code_reviews where id=?1 and revision=?2",
                params![id.to_string(), expected]
            )? == 1,
            "review changed; reload"
        );
        transaction.commit()?;
        Ok(removable)
    }
    pub fn create_code_review_with_operation(
        &self,
        operation: Uuid,
        snapshot: &ReviewSnapshot,
        provider_id: &str,
        model_id: &str,
        previous: Option<Uuid>,
        origin: crate::UsageOrigin,
        workflow_run_id: Option<Uuid>,
    ) -> Result<CodeReviewRun> {
        let transaction = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let existing: Option<String> = transaction
            .query_row(
                "select review_id from code_review_operations where operation_id=?1",
                [operation.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        let run = if let Some(existing) = existing {
            let run = self
                .code_review(Uuid::parse_str(&existing)?)?
                .ok_or_else(|| anyhow::anyhow!("review operation is unavailable"))?;
            ensure!(
                run.source_session_id == snapshot.source_session_id
                    && run.snapshot_id == Some(snapshot.id)
                    && run.provider_id == provider_id
                    && run.model_id == model_id
                    && run.previous_review_id == previous
                    && run.origin == origin
                    && run.workflow_run_id == workflow_run_id,
                "review operation ID belongs to a different request"
            );
            run
        } else {
            let active:u64=transaction.query_row("select count(*) from code_reviews where status in ('queued','capturing','running')",[],|row|row.get(0))?;
            ensure!(
                active < 100,
                "review queue is full; wait or cancel a queued review"
            );
            let run = self.create_code_review_origin(
                snapshot,
                provider_id,
                model_id,
                previous,
                origin,
                workflow_run_id,
            )?;
            transaction.execute(
                "insert into code_review_operations(operation_id,review_id) values (?1,?2)",
                params![operation.to_string(), run.id.to_string()],
            )?;
            run
        };
        transaction.commit()?;
        Ok(run)
    }
    pub fn assign_advisory_session(
        &self,
        session: Uuid,
        purpose: crate::provider_runtime::types::InternalRequestPurpose,
    ) -> Result<()> {
        use crate::provider_runtime::types::InternalRequestPurpose;
        let role = match purpose {
            InternalRequestPurpose::CodeReview => "code-review",
            InternalRequestPurpose::WorkflowExtraction => "workflow-extraction",
            _ => anyhow::bail!("unsupported advisory session purpose"),
        };
        self.conn.execute("insert into feature_session_roles(session_id,role) values (?1,?2) on conflict(session_id) do nothing",params![session.to_string(),role])?;
        ensure!(
            self.advisory_session_purpose(session)? == Some(purpose),
            "session purpose cannot change"
        );
        Ok(())
    }
    pub fn advisory_session_purpose(
        &self,
        session: Uuid,
    ) -> Result<Option<crate::provider_runtime::types::InternalRequestPurpose>> {
        use crate::provider_runtime::types::InternalRequestPurpose;
        let role: Option<String> = self
            .conn
            .query_row(
                "select role from feature_session_roles where session_id=?1",
                [session.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        role.map(|role| match role.as_str() {
            "code-review" => Ok(InternalRequestPurpose::CodeReview),
            "workflow-extraction" => Ok(InternalRequestPurpose::WorkflowExtraction),
            _ => anyhow::bail!("unknown restricted session purpose"),
        })
        .transpose()
    }
    pub fn bind_code_review_session(
        &self,
        id: Uuid,
        expected: u64,
        session: Uuid,
    ) -> Result<CodeReviewRun> {
        let mut run = self
            .code_review(id)?
            .ok_or_else(|| anyhow::anyhow!("review is unavailable"))?;
        ensure!(
            run.revision == expected
                && run.status == ReviewStatus::Queued
                && run.review_session_id.is_none(),
            "review changed or already has a reviewer session"
        );
        let child = self
            .get_session(session)?
            .ok_or_else(|| anyhow::anyhow!("reviewer session is unavailable"))?;
        ensure!(
            child.parent_session_id == Some(run.source_session_id)
                && child.provider_id.as_deref() == Some(run.provider_id.as_str())
                && child.model_id.as_deref() == Some(run.model_id.as_str()),
            "reviewer session binding mismatch"
        );
        self.assign_advisory_session(
            session,
            crate::provider_runtime::types::InternalRequestPurpose::CodeReview,
        )?;
        run.review_session_id = Some(session);
        run.revision += 1;
        self.save_code_review_revision(&run, expected)?;
        Ok(run)
    }
    pub fn create_code_review(
        &self,
        snapshot: &ReviewSnapshot,
        provider_id: &str,
        model_id: &str,
        previous_review_id: Option<Uuid>,
    ) -> Result<CodeReviewRun> {
        self.create_code_review_origin(
            snapshot,
            provider_id,
            model_id,
            previous_review_id,
            crate::UsageOrigin::CodeReview,
            None,
        )
    }
    fn create_code_review_origin(
        &self,
        snapshot: &ReviewSnapshot,
        provider_id: &str,
        model_id: &str,
        previous_review_id: Option<Uuid>,
        origin: crate::UsageOrigin,
        workflow_run_id: Option<Uuid>,
    ) -> Result<CodeReviewRun> {
        ensure!(
            previous_review_id == snapshot.previous_review_id,
            "previous review must be frozen in the captured input"
        );
        if let Some(id) = workflow_run_id {
            let workflow = self
                .workflow_run(id)?
                .ok_or_else(|| anyhow::anyhow!("owning workflow is unavailable"))?;
            ensure!(
                workflow.status == crate::workflows::WorkflowRunStatus::Running
                    && workflow.origin == origin
                    && workflow.root_key == snapshot.root_key,
                "review workflow ownership changed"
            );
            ensure!(
                workflow
                    .definition
                    .steps
                    .iter()
                    .enumerate()
                    .any(|(index, step)| match step {
                        crate::workflows::WorkflowStep::Review {
                            role, source_step, ..
                        } if workflow.steps[index].status
                            == crate::workflows::WorkflowStepStatus::Pending =>
                            workflow
                                .steps
                                .iter()
                                .find(|step| &step.step_id == source_step)
                                .and_then(|step| step.session_id)
                                == Some(snapshot.source_session_id)
                                && workflow
                                    .binding
                                    .roles
                                    .get(role)
                                    .is_some_and(|binding| binding.provider_id == provider_id
                                        && binding.model_id == model_id),
                        _ => false,
                    }),
                "review does not match a pending workflow step and role"
            );
        }
        ensure!(
            self.get_session(snapshot.source_session_id)?.is_some(),
            "review source session is unavailable"
        );
        ensure!(
            !provider_id.is_empty()
                && provider_id.len() <= 100
                && !model_id.is_empty()
                && model_id.len() <= 200,
            "reviewer provider and model are required"
        );
        if let Some(previous) = previous_review_id {
            let prior = self
                .code_review(previous)?
                .ok_or_else(|| anyhow::anyhow!("previous review is unavailable"))?;
            ensure!(
                prior.source_session_id == snapshot.source_session_id
                    && prior.root_id == snapshot.root_id,
                "previous review belongs to another source"
            );
        }
        let run = CodeReviewRun {
            workflow_run_id,
            resolutions: vec![],
            origin,
            id: Uuid::new_v4(),
            revision: 1,
            source_session_id: snapshot.source_session_id,
            review_session_id: None,
            root_id: snapshot.root_id.clone(),
            snapshot_id: Some(snapshot.id),
            provider_id: provider_id.into(),
            model_id: model_id.into(),
            status: ReviewStatus::Queued,
            summary: None,
            findings: Vec::new(),
            limitations: Vec::new(),
            supplied_files: snapshot.files.len(),
            intended_files: snapshot.files.len() + snapshot.exclusions.len(),
            error: None,
            previous_review_id,
            created_at: chrono::Utc::now().to_rfc3339(),
            finished_at: None,
        };
        self.conn.execute("insert into code_reviews (id,source_session_id,revision,status,run_json) values (?1,?2,1,'queued',?3)",params![run.id.to_string(),run.source_session_id.to_string(),serde_json::to_string(&run)?])?;
        Ok(run)
    }
    pub fn code_review(&self, id: Uuid) -> Result<Option<CodeReviewRun>> {
        let json: Option<String> = self
            .conn
            .query_row(
                "select run_json from code_reviews where id=?1",
                [id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        json.map(|json| serde_json::from_str(&json))
            .transpose()
            .map_err(Into::into)
    }
    pub fn code_reviews(&self, source: Option<Uuid>) -> Result<Vec<CodeReviewRun>> {
        let mut query=self.conn.prepare("select run_json from code_reviews where (?1 is null or source_session_id=?1) order by (status in ('queued','capturing','running')) desc,rowid desc limit 100")?;
        let rows = query.query_map([source.map(|id| id.to_string())], |row| {
            row.get::<_, String>(0)
        })?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }
    pub(super) fn save_code_review_revision(
        &self,
        run: &CodeReviewRun,
        expected: u64,
    ) -> Result<()> {
        let encoded = serde_json::to_string(run)?;
        ensure!(
            encoded.len() <= 512 * 1024,
            "review state exceeds its size limit"
        );
        let transaction = if self.conn.is_autocommit() {
            Some(rusqlite::Transaction::new_unchecked(
                &self.conn,
                rusqlite::TransactionBehavior::Immediate,
            )?)
        } else {
            None
        };
        ensure!(self.conn.execute("update code_reviews set revision=?3,status=?4,run_json=?5 where id=?1 and revision=?2",params![run.id.to_string(),expected,run.revision,status(run.status),encoded])?==1,"review changed; reload");
        self.conn.execute("insert into code_review_transitions (review_id,revision,status,created_at) values (?1,?2,?3,?4)",params![run.id.to_string(),run.revision,status(run.status),chrono::Utc::now().to_rfc3339()])?;
        if let Some(transaction) = transaction {
            transaction.commit()?;
        }
        Ok(())
    }
    pub fn transition_code_review(
        &self,
        id: Uuid,
        expected: u64,
        next: ReviewStatus,
        review_session: Option<Uuid>,
        error: Option<String>,
    ) -> Result<CodeReviewRun> {
        let mut run = self
            .code_review(id)?
            .ok_or_else(|| anyhow::anyhow!("review is unavailable"))?;
        ensure!(
            run.revision == expected && run.status.may_transition(next),
            "review transition is stale or invalid"
        );
        ensure!(
            next != ReviewStatus::Completed,
            "completed review requires a validated result"
        );
        if let Some(session) = review_session {
            ensure!(
                self.get_session(session)?.is_some(),
                "reviewer session is unavailable"
            );
            ensure!(
                run.review_session_id.is_none() || run.review_session_id == Some(session),
                "reviewer session cannot change"
            );
            run.review_session_id = Some(session);
        }
        run.status = next;
        run.error = error.map(|error| crate::sanitize_capability_summary(&error));
        run.revision += 1;
        if next.terminal() {
            run.finished_at = Some(chrono::Utc::now().to_rfc3339());
        }
        self.save_code_review_revision(&run, expected)?;
        Ok(run)
    }
    pub fn finish_code_review(
        &self,
        id: Uuid,
        expected: u64,
        result: ParsedReview,
    ) -> Result<CodeReviewRun> {
        let transaction = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let mut run = self
            .code_review(id)?
            .ok_or_else(|| anyhow::anyhow!("review is unavailable"))?;
        ensure!(
            run.revision == expected && run.status == ReviewStatus::Running,
            "review is no longer running"
        );
        ensure!(
            result
                .findings
                .iter()
                .all(|finding| finding.review_id == id
                    && Some(finding.snapshot_id) == run.snapshot_id),
            "finding belongs to another snapshot"
        );
        run.status = if run.supplied_files == run.intended_files {
            ReviewStatus::Completed
        } else {
            ReviewStatus::Incomplete
        };
        run.summary = Some(result.summary);
        run.findings = result.findings;
        run.limitations = result.limitations;
        run.resolutions = result.resolutions;
        if run.status == ReviewStatus::Completed && !run.resolutions.is_empty() {
            let prior_id = run
                .previous_review_id
                .ok_or_else(|| anyhow::anyhow!("resolution requires a previous review"))?;
            let mut prior = self
                .code_review(prior_id)?
                .ok_or_else(|| anyhow::anyhow!("previous review is unavailable"))?;
            let revision = prior.revision;
            for resolution in &run.resolutions {
                let finding = prior
                    .findings
                    .iter_mut()
                    .find(|finding| finding.id == resolution.finding_id)
                    .ok_or_else(|| anyhow::anyhow!("previous finding is unavailable"))?;
                // Concurrent human dismissals or another re-review win over stale evidence.
                if finding.revision != resolution.expected_revision
                    || finding.anchor_hash != resolution.previous_anchor_hash
                    || !matches!(
                        finding.disposition,
                        FindingDisposition::Open
                            | FindingDisposition::SentForFix
                            | FindingDisposition::FixClaimed
                    )
                {
                    continue;
                }
                finding.disposition = FindingDisposition::ResolvedByReview;
                finding.resolved_by_review_id = Some(id);
                finding.revision += 1;
            }
            prior.revision += 1;
            self.save_code_review_revision(&prior, revision)?;
        }
        run.finished_at = Some(chrono::Utc::now().to_rfc3339());
        run.revision += 1;
        self.save_code_review_revision(&run, expected)?;
        transaction.commit()?;
        Ok(run)
    }
    pub fn dismiss_code_review_finding(
        &self,
        id: Uuid,
        expected: u64,
        finding_id: Uuid,
    ) -> Result<CodeReviewRun> {
        let mut run = self
            .code_review(id)?
            .ok_or_else(|| anyhow::anyhow!("review is unavailable"))?;
        ensure!(
            run.revision == expected && run.status.terminal(),
            "review changed or is still active"
        );
        let finding = run
            .findings
            .iter_mut()
            .find(|finding| finding.id == finding_id)
            .ok_or_else(|| anyhow::anyhow!("finding is unavailable"))?;
        finding.disposition = FindingDisposition::Dismissed;
        finding.revision += 1;
        run.revision += 1;
        self.save_code_review_revision(&run, expected)?;
        Ok(run)
    }
}
