use super::SessionStore;
use crate::code_reviews::{FindingDisposition, ReviewFixIntent, ReviewFixStatus};
use anyhow::{ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;
pub(super) fn ensure_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch("create table if not exists review_fix_intents(id text primary key not null,review_id text not null references code_reviews(id) on delete cascade,source_session_id text not null references sessions(id) on delete cascade,status text not null,revision integer not null,intent_json text not null);")?;
    Ok(())
}
fn status(value: &ReviewFixStatus) -> String {
    serde_json::to_value(value)
        .unwrap()
        .as_str()
        .unwrap()
        .into()
}
impl SessionStore {
    pub fn review_fix_intent(&self, id: Uuid) -> Result<Option<ReviewFixIntent>> {
        let json: Option<String> = self
            .conn
            .query_row(
                "select intent_json from review_fix_intents where id=?1",
                [id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        json.map(|json| serde_json::from_str(&json).map_err(Into::into))
            .transpose()
    }
    pub fn review_fix_intents(&self, source: Option<Uuid>) -> Result<Vec<ReviewFixIntent>> {
        let mut query=self.conn.prepare("select intent_json from review_fix_intents where (?1 is null or source_session_id=?1) order by (status in ('queued','dispatching','sent')) desc,rowid desc limit 100")?;
        let rows = query.query_map([source.map(|id| id.to_string())], |row| {
            row.get::<_, String>(0)
        })?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }
    pub fn queue_review_fixes(&self, mut intent: ReviewFixIntent) -> Result<ReviewFixIntent> {
        let transaction = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        if let Some(existing) = self.review_fix_intent(intent.id)? {
            ensure!(
                existing.review_id == intent.review_id
                    && existing.source_session_id == intent.source_session_id
                    && existing.finding_revisions == intent.finding_revisions
                    && existing.target_fingerprint == intent.target_fingerprint
                    && existing.provider_id == intent.provider_id
                    && existing.model_id == intent.model_id,
                "fix operation belongs to another selection"
            );
            return Ok(existing);
        }
        ensure!(
            intent.message.len() <= 32 * 1024
                && !intent.message.trim().is_empty()
                && !intent.finding_revisions.is_empty()
                && intent.finding_revisions.len() <= 100,
            "fix request exceeds its limits"
        );
        let review = self
            .code_review(intent.review_id)?
            .ok_or_else(|| anyhow::anyhow!("review is unavailable"))?;
        ensure!(
            review.status.terminal()
                && review.revision == intent.review_revision
                && review.source_session_id == intent.source_session_id
                && review.root_id == intent.root_id,
            "review changed before queuing fixes"
        );
        for (id, revision) in &intent.finding_revisions {
            ensure!(
                review.findings.iter().any(|finding| finding.id == *id
                    && finding.revision == *revision
                    && !matches!(
                        finding.disposition,
                        FindingDisposition::Dismissed | FindingDisposition::ResolvedByReview
                    )),
                "selected finding changed"
            );
        }
        let count:u64=self.conn.query_row("select count(*) from review_fix_intents where status in ('queued','dispatching','sent')",[],|row|row.get(0))?;
        ensure!(count < 100, "fix queue is full");
        intent.status = ReviewFixStatus::Queued;
        intent.revision = 1;
        intent.error = None;
        self.conn.execute("insert into review_fix_intents(id,review_id,source_session_id,status,revision,intent_json) values (?1,?2,?3,'queued',1,?4)",params![intent.id.to_string(),intent.review_id.to_string(),intent.source_session_id.to_string(),serde_json::to_string(&intent)?])?;
        transaction.commit()?;
        Ok(intent)
    }
    pub fn transition_review_fix(
        &self,
        id: Uuid,
        expected: u64,
        next: ReviewFixStatus,
        error: Option<String>,
    ) -> Result<ReviewFixIntent> {
        let transaction = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let mut intent = self
            .review_fix_intent(id)?
            .ok_or_else(|| anyhow::anyhow!("fix request is unavailable"))?;
        ensure!(intent.revision == expected, "fix request changed; reload");
        let allowed = matches!(
            (&intent.status, &next),
            (ReviewFixStatus::Queued, ReviewFixStatus::Dispatching)
                | (ReviewFixStatus::Dispatching, ReviewFixStatus::Sent)
                | (ReviewFixStatus::Sent, ReviewFixStatus::Completed)
        ) || intent.status.active()
            && matches!(
                next,
                ReviewFixStatus::Cancelled
                    | ReviewFixStatus::Blocked
                    | ReviewFixStatus::Interrupted
            );
        ensure!(
            allowed,
            "fix request cannot be replayed or advanced from this state"
        );
        if matches!(
            next,
            ReviewFixStatus::Dispatching | ReviewFixStatus::Sent | ReviewFixStatus::Completed
        ) {
            let mut review = self
                .code_review(intent.review_id)?
                .ok_or_else(|| anyhow::anyhow!("review is unavailable"))?;
            if next == ReviewFixStatus::Dispatching {
                ensure!(
                    review.revision == intent.review_revision,
                    "review changed while fixes waited"
                );
                for (id, revision) in &intent.finding_revisions {
                    ensure!(
                        review.findings.iter().any(|finding| finding.id == *id
                            && finding.revision == *revision
                            && !matches!(
                                finding.disposition,
                                FindingDisposition::Dismissed
                                    | FindingDisposition::ResolvedByReview
                            )),
                        "selected finding changed while fixes waited"
                    );
                }
            }
            if matches!(next, ReviewFixStatus::Sent | ReviewFixStatus::Completed) {
                let revision = review.revision;
                for finding in &mut review.findings {
                    if intent.finding_revisions.contains_key(&finding.id)
                        && !matches!(
                            finding.disposition,
                            FindingDisposition::Dismissed | FindingDisposition::ResolvedByReview
                        )
                    {
                        if next == ReviewFixStatus::Completed {
                            let applied:u64=self.conn.query_row("select count(*) from mutation_proposals where session_id=?1 and turn_id=?2 and workspace_path=?3 and path=?4 and status='applied'",params![intent.source_session_id.to_string(),intent.turn_id.to_string(),intent.root_key,finding.path],|row|row.get(0))?;
                            if applied == 0 {
                                continue;
                            }
                            finding.disposition = FindingDisposition::FixClaimed;
                        } else {
                            finding.disposition = FindingDisposition::SentForFix;
                        }
                        finding.revision += 1;
                    }
                }
                review.revision += 1;
                self.save_code_review_revision(&review, revision)?;
            }
        }
        intent.status = next;
        intent.error = error.map(|value| crate::sanitize_capability_summary(&value));
        intent.revision += 1;
        ensure!(self.conn.execute("update review_fix_intents set status=?3,revision=?4,intent_json=?5 where id=?1 and revision=?2",params![id.to_string(),expected,status(&intent.status),intent.revision,serde_json::to_string(&intent)?])?==1,"fix request changed");
        transaction.commit()?;
        Ok(intent)
    }
}
