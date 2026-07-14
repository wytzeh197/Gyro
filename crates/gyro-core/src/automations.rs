use crate::{
    paths::{reject_unsafe_private_file, secure_private_file, GyroPaths},
    sessions::SessionWorkspaceMode,
};
use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AutomationStatus {
    Current,
    Paused,
    Completed,
}

impl AutomationStatus {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Current => "current",
            Self::Paused => "paused",
            Self::Completed => "completed",
        }
    }

    fn from_str(value: &str) -> Self {
        match value {
            "paused" => Self::Paused,
            "completed" => Self::Completed,
            _ => Self::Current,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AutomationSchedule {
    Manual,
    Hourly,
    Daily,
    Weekly,
    Heartbeat,
}

impl AutomationSchedule {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Hourly => "hourly",
            Self::Daily => "daily",
            Self::Weekly => "weekly",
            Self::Heartbeat => "heartbeat",
        }
    }

    fn from_str(value: &str) -> Self {
        match value {
            "hourly" => Self::Hourly,
            "daily" => Self::Daily,
            "weekly" => Self::Weekly,
            "heartbeat" => Self::Heartbeat,
            _ => Self::Manual,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AutomationRunStatus {
    Queued,
    Running,
    Passed,
    Failed,
    Stopped,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationExecutionContext {
    pub workspace_path: Option<String>,
    pub provider_id: Option<String>,
    pub provider_label: Option<String>,
    pub model_id: Option<String>,
    pub model_label: Option<String>,
    pub reasoning_effort: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AutomationTriageState {
    None,
    NeedsReview,
    Archived,
}

impl AutomationTriageState {
    fn as_str(&self) -> &'static str {
        match self {
            Self::None => "none",
            Self::NeedsReview => "needs-review",
            Self::Archived => "archived",
        }
    }

    fn from_str(value: &str) -> Self {
        match value {
            "needs-review" => Self::NeedsReview,
            "archived" => Self::Archived,
            _ => Self::None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRun {
    pub id: Uuid,
    pub status: AutomationRunStatus,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub summary: String,
    #[serde(default)]
    pub stop_condition_met: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    pub id: Uuid,
    pub title: String,
    pub prompt: String,
    pub schedule: AutomationSchedule,
    pub status: AutomationStatus,
    pub triage_state: AutomationTriageState,
    pub project: String,
    pub provider: String,
    pub branch: String,
    pub workspace_mode: SessionWorkspaceMode,
    pub worktree_name: Option<String>,
    pub stop_condition: Option<String>,
    #[serde(default)]
    pub execution: AutomationExecutionContext,
    pub last_run_at: Option<DateTime<Utc>>,
    pub next_run_at: Option<DateTime<Utc>>,
    pub lease_owner: Option<String>,
    pub lease_expires_at: Option<DateTime<Utc>>,
    pub last_result: String,
    pub unread_results: u32,
    pub run_history: Vec<AutomationRun>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAutomationRequest {
    pub title: String,
    pub prompt: String,
    pub schedule: AutomationSchedule,
    pub project: String,
    pub provider: String,
    pub branch: String,
    pub workspace_mode: SessionWorkspaceMode,
    pub worktree_name: Option<String>,
    pub stop_condition: Option<String>,
    pub next_run_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub execution: AutomationExecutionContext,
}

pub struct AutomationStore {
    conn: Connection,
}

impl AutomationStore {
    pub fn open(paths: GyroPaths) -> Result<Self> {
        paths.ensure()?;
        reject_unsafe_private_file(&paths.database_path)?;
        let conn = Connection::open(&paths.database_path)
            .with_context(|| format!("open {}", paths.database_path.display()))?;
        secure_private_file(&paths.database_path)?;
        conn.busy_timeout(std::time::Duration::from_secs(2))?;
        conn.execute_batch(
            "pragma foreign_keys = on;
             pragma journal_mode = wal;
             pragma synchronous = full;",
        )?;
        let store = Self { conn };
        store.initialize()?;
        Ok(store)
    }

    pub fn list_automations(&self) -> Result<Vec<Automation>> {
        let mut stmt = self.conn.prepare(
            "select id, title, prompt, schedule, status, triage_state, project, provider,
             branch, workspace_mode, worktree_name, stop_condition, last_run_at, next_run_at,
             lease_owner, lease_expires_at, last_result, unread_results, run_history, created_at, updated_at,
             execution_context
             from automations order by updated_at desc",
        )?;
        let rows = stmt.query_map([], row_to_automation)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub fn get_automation(&self, automation_id: Uuid) -> Result<Option<Automation>> {
        self.conn
            .query_row(
                "select id, title, prompt, schedule, status, triage_state, project, provider,
                 branch, workspace_mode, worktree_name, stop_condition, last_run_at, next_run_at,
                 lease_owner, lease_expires_at, last_result, unread_results, run_history, created_at, updated_at,
                 execution_context
                 from automations where id = ?1",
                params![automation_id.to_string()],
                row_to_automation,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn create_automation(&self, draft: CreateAutomationRequest) -> Result<Automation> {
        let title = draft.title.trim().to_string();
        let prompt = draft.prompt.trim().to_string();
        if title.is_empty() {
            return Err(anyhow!("automation title cannot be empty"));
        }
        if prompt.is_empty() {
            return Err(anyhow!("automation prompt cannot be empty"));
        }

        let now = Utc::now();
        let id = Uuid::new_v4();
        let next_run_at = draft
            .next_run_at
            .or_else(|| next_automation_run_after(&draft.schedule, now));
        let run_history = vec![AutomationRun {
            id: Uuid::new_v4(),
            status: AutomationRunStatus::Queued,
            started_at: now,
            finished_at: None,
            summary: "Automation created locally".into(),
            stop_condition_met: None,
        }];
        let automation = Automation {
            id,
            title,
            prompt,
            schedule: draft.schedule,
            status: AutomationStatus::Current,
            triage_state: AutomationTriageState::None,
            project: blank_to_default(draft.project, "Gyro"),
            provider: blank_to_default(draft.provider, "Codex"),
            branch: blank_to_default(draft.branch, "main"),
            workspace_mode: draft.workspace_mode,
            worktree_name: draft.worktree_name,
            stop_condition: draft
                .stop_condition
                .filter(|value| !value.trim().is_empty()),
            execution: draft.execution,
            last_run_at: None,
            next_run_at,
            lease_owner: None,
            lease_expires_at: None,
            last_result: "Waiting for first local run".into(),
            unread_results: 0,
            run_history,
            created_at: now,
            updated_at: now,
        };

        self.insert_automation(&automation)?;
        self.get_automation(automation.id)?
            .ok_or_else(|| anyhow!("automation was not persisted"))
    }

    pub fn set_automation_status(
        &self,
        automation_id: Uuid,
        status: AutomationStatus,
    ) -> Result<Option<Automation>> {
        let Some(automation) = self.get_automation(automation_id)? else {
            return Ok(None);
        };
        let next_run_at = match status {
            AutomationStatus::Current => automation
                .next_run_at
                .or_else(|| next_automation_run_after(&automation.schedule, Utc::now())),
            AutomationStatus::Paused | AutomationStatus::Completed => None,
        };
        let (lease_owner, lease_expires_at) = match status {
            AutomationStatus::Current => (automation.lease_owner, automation.lease_expires_at),
            AutomationStatus::Paused | AutomationStatus::Completed
                if automation.lease_owner.is_some() =>
            {
                (automation.lease_owner, automation.lease_expires_at)
            }
            AutomationStatus::Paused | AutomationStatus::Completed => (None, None),
        };
        let updated_at = Utc::now();
        self.conn.execute(
            "update automations set status = ?1, next_run_at = ?2, lease_owner = ?3,
             lease_expires_at = ?4, updated_at = ?5 where id = ?6",
            params![
                status.as_str(),
                format_optional_datetime(next_run_at),
                lease_owner,
                format_optional_datetime(lease_expires_at),
                updated_at.to_rfc3339(),
                automation_id.to_string(),
            ],
        )?;
        self.get_automation(automation_id)
    }

    pub fn record_automation_run(
        &self,
        automation_id: Uuid,
        summary: impl Into<String>,
    ) -> Result<Option<Automation>> {
        let Some(mut automation) = self.get_automation(automation_id)? else {
            return Ok(None);
        };
        let summary = summary.into().trim().to_string();
        if summary.is_empty() {
            return Err(anyhow!("automation run summary cannot be empty"));
        }

        apply_automation_run(
            &mut automation,
            AutomationRunStatus::Passed,
            summary,
            Utc::now(),
            None,
        );

        self.update_automation(&automation)?;
        self.get_automation(automation_id)
    }

    pub fn list_due_automations_now(&self) -> Result<Vec<Automation>> {
        self.list_due_automations(Utc::now())
    }

    pub fn list_due_automations(&self, now: DateTime<Utc>) -> Result<Vec<Automation>> {
        let now = now.to_rfc3339();
        let mut stmt = self.conn.prepare(
            "select id, title, prompt, schedule, status, triage_state, project, provider,
             branch, workspace_mode, worktree_name, stop_condition, last_run_at, next_run_at,
             lease_owner, lease_expires_at, last_result, unread_results, run_history, created_at, updated_at,
             execution_context
             from automations
             where status = 'current'
             and next_run_at is not null
             and next_run_at <= ?1
             and (lease_expires_at is null or lease_expires_at <= ?1)
             order by next_run_at asc, updated_at asc",
        )?;
        let rows = stmt.query_map(params![now], row_to_automation)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub fn claim_due_automation(
        &self,
        lease_owner: impl Into<String>,
        lease_seconds: i64,
    ) -> Result<Option<Automation>> {
        self.claim_due_automation_at(lease_owner, lease_seconds, Utc::now())
    }

    pub fn claim_due_automation_at(
        &self,
        lease_owner: impl Into<String>,
        lease_seconds: i64,
        now: DateTime<Utc>,
    ) -> Result<Option<Automation>> {
        let lease_owner = lease_owner.into().trim().to_string();
        if lease_owner.is_empty() {
            return Err(anyhow!("automation lease owner cannot be empty"));
        }

        let now_string = now.to_rfc3339();
        let lease_expires_at = now + Duration::seconds(lease_seconds.clamp(30, 60 * 60 * 24));
        let lease_expires_at_string = lease_expires_at.to_rfc3339();
        let automation_id: Option<String> = self
            .conn
            .query_row(
                "select id from automations
                 where status = 'current'
                 and next_run_at is not null
                 and next_run_at <= ?1
                 and (lease_expires_at is null or lease_expires_at <= ?1)
                 order by next_run_at asc, updated_at asc
                 limit 1",
                params![now_string],
                |row| row.get(0),
            )
            .optional()?;

        let Some(automation_id) = automation_id else {
            return Ok(None);
        };

        let changed = self.conn.execute(
            "update automations set lease_owner = ?1, lease_expires_at = ?2, updated_at = ?3
             where id = ?4
             and status = 'current'
             and next_run_at is not null
             and next_run_at <= ?3
             and (lease_expires_at is null or lease_expires_at <= ?3)",
            params![
                lease_owner,
                lease_expires_at_string,
                now_string,
                automation_id
            ],
        )?;
        if changed == 0 {
            return Ok(None);
        }

        let automation_id = Uuid::parse_str(&automation_id)?;
        self.mark_claimed_automation_running(automation_id, &lease_owner, now)?;
        let claimed = self.get_automation(automation_id)?;
        if claimed
            .as_ref()
            .is_some_and(|automation| automation.status != AutomationStatus::Current)
        {
            self.conn.execute(
                "update automations set lease_owner = null, lease_expires_at = null
                 where id = ?1 and lease_owner = ?2",
                params![automation_id.to_string(), lease_owner],
            )?;
            return Ok(None);
        }
        Ok(claimed)
    }

    pub fn queue_automation_now(&self, automation_id: Uuid) -> Result<Option<Automation>> {
        let Some(automation) = self.get_automation(automation_id)? else {
            return Ok(None);
        };
        if automation.status != AutomationStatus::Current {
            return Err(anyhow!("resume the automation before running it"));
        }
        if automation.lease_owner.is_some() {
            return Err(anyhow!("automation is already running"));
        }
        let now = Utc::now();
        let changed = self.conn.execute(
            "update automations set next_run_at = ?1, updated_at = ?1
             where id = ?2 and status = 'current' and lease_owner is null",
            params![now.to_rfc3339(), automation_id.to_string()],
        )?;
        if changed == 0 {
            let latest = self.get_automation(automation_id)?;
            return match latest {
                Some(latest) if latest.status != AutomationStatus::Current => {
                    Err(anyhow!("resume the automation before running it"))
                }
                Some(_) => Err(anyhow!("automation is already running")),
                None => Ok(None),
            };
        }
        self.get_automation(automation_id)
    }

    pub fn renew_automation_lease(
        &self,
        automation_id: Uuid,
        lease_owner: impl Into<String>,
        lease_seconds: i64,
    ) -> Result<Option<Automation>> {
        self.renew_automation_lease_at(automation_id, lease_owner, lease_seconds, Utc::now())
    }

    pub fn renew_automation_lease_at(
        &self,
        automation_id: Uuid,
        lease_owner: impl Into<String>,
        lease_seconds: i64,
        now: DateTime<Utc>,
    ) -> Result<Option<Automation>> {
        let lease_owner = lease_owner.into().trim().to_string();
        if lease_owner.is_empty() {
            return Err(anyhow!("automation lease owner cannot be empty"));
        }
        let Some(automation) = self.get_automation(automation_id)? else {
            return Ok(None);
        };
        if automation.lease_owner.as_deref() != Some(lease_owner.as_str()) {
            return Ok(None);
        }
        let Some(current_expiry) = automation.lease_expires_at else {
            return Ok(None);
        };
        let requested_expiry = now + Duration::seconds(lease_seconds.clamp(30, 60 * 60 * 24));
        let lease_expires_at = current_expiry.max(requested_expiry);
        let changed = self.conn.execute(
            "update automations set lease_expires_at = ?1
             where id = ?2 and lease_owner = ?3 and lease_expires_at is not null",
            params![
                lease_expires_at.to_rfc3339(),
                automation_id.to_string(),
                lease_owner,
            ],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        self.get_automation(automation_id)
    }

    pub fn recover_expired_automation_leases_now(&self) -> Result<usize> {
        self.recover_expired_automation_leases(Utc::now())
    }

    pub fn recover_expired_automation_leases(&self, now: DateTime<Utc>) -> Result<usize> {
        let expired = self
            .list_automations()?
            .into_iter()
            .filter(|automation| {
                automation
                    .lease_expires_at
                    .is_some_and(|expiry| expiry <= now)
            })
            .collect::<Vec<_>>();
        let mut recovered = 0;
        for mut automation in expired {
            let Some(lease_owner) = automation.lease_owner.clone() else {
                continue;
            };
            let status = if automation.status == AutomationStatus::Current {
                AutomationRunStatus::Failed
            } else {
                AutomationRunStatus::Stopped
            };
            apply_automation_run(
                &mut automation,
                status,
                "Automation was interrupted before its scheduler lease completed".into(),
                now,
                None,
            );
            recovered += self.conn.execute(
                "update automations set
                 last_run_at = ?1,
                 next_run_at = case when status = 'current' then ?2 else null end,
                 last_result = ?3,
                 unread_results = ?4,
                 run_history = ?5,
                 lease_owner = null,
                 lease_expires_at = null,
                 triage_state = ?6,
                 updated_at = ?7
                 where id = ?8
                 and lease_owner = ?9
                 and lease_expires_at is not null
                 and lease_expires_at <= ?10",
                params![
                    format_optional_datetime(automation.last_run_at),
                    format_optional_datetime(automation.next_run_at),
                    automation.last_result,
                    automation.unread_results,
                    serde_json::to_string(&automation.run_history)?,
                    automation.triage_state.as_str(),
                    automation.updated_at.to_rfc3339(),
                    automation.id.to_string(),
                    lease_owner,
                    now.to_rfc3339(),
                ],
            )?;
        }
        Ok(recovered)
    }

    pub fn complete_automation_lease(
        &self,
        automation_id: Uuid,
        lease_owner: impl Into<String>,
        summary: impl Into<String>,
    ) -> Result<Option<Automation>> {
        self.finish_automation_lease(
            automation_id,
            lease_owner,
            AutomationRunStatus::Passed,
            summary,
        )
    }

    pub fn finish_automation_lease(
        &self,
        automation_id: Uuid,
        lease_owner: impl Into<String>,
        run_status: AutomationRunStatus,
        summary: impl Into<String>,
    ) -> Result<Option<Automation>> {
        self.finish_automation_lease_with_stop_condition(
            automation_id,
            lease_owner,
            run_status,
            summary,
            None,
        )
    }

    pub fn finish_automation_lease_with_stop_condition(
        &self,
        automation_id: Uuid,
        lease_owner: impl Into<String>,
        run_status: AutomationRunStatus,
        summary: impl Into<String>,
        stop_condition_met: Option<bool>,
    ) -> Result<Option<Automation>> {
        let Some(mut automation) = self.get_automation(automation_id)? else {
            return Ok(None);
        };
        let lease_owner = lease_owner.into().trim().to_string();
        if lease_owner.is_empty() {
            return Err(anyhow!("automation lease owner cannot be empty"));
        }
        if automation.lease_owner.as_deref() != Some(lease_owner.as_str()) {
            return Err(anyhow!("automation lease is owned by another scheduler"));
        }
        let summary = summary.into().trim().to_string();
        if summary.is_empty() {
            return Err(anyhow!("automation run summary cannot be empty"));
        }

        if !matches!(
            run_status,
            AutomationRunStatus::Passed
                | AutomationRunStatus::Failed
                | AutomationRunStatus::Stopped
        ) {
            return Err(anyhow!("automation run must finish with a terminal status"));
        }
        if stop_condition_met == Some(true) && run_status != AutomationRunStatus::Passed {
            return Err(anyhow!(
                "only a successful automation run can satisfy its stop condition"
            ));
        }

        let finished_at = automation
            .run_history
            .iter()
            .find(|run| run.status == AutomationRunStatus::Running && run.finished_at.is_none())
            .map(|run| run.started_at.max(Utc::now()))
            .unwrap_or_else(Utc::now);
        apply_automation_run(
            &mut automation,
            run_status,
            summary,
            finished_at,
            stop_condition_met,
        );
        let changed = self.conn.execute(
            "update automations set
             last_run_at = ?1,
             next_run_at = case when status = 'current' then ?2 else null end,
             last_result = ?3,
             unread_results = ?4,
             run_history = ?5,
             lease_owner = null,
             lease_expires_at = null,
             triage_state = ?6,
             updated_at = ?7,
             status = ?10
             where id = ?8 and lease_owner = ?9",
            params![
                format_optional_datetime(automation.last_run_at),
                format_optional_datetime(automation.next_run_at),
                automation.last_result,
                automation.unread_results,
                serde_json::to_string(&automation.run_history)?,
                automation.triage_state.as_str(),
                automation.updated_at.to_rfc3339(),
                automation.id.to_string(),
                lease_owner,
                automation.status.as_str(),
            ],
        )?;
        if changed == 0 {
            return Err(anyhow!("automation lease changed before completion"));
        }
        self.get_automation(automation_id)
    }

    fn mark_claimed_automation_running(
        &self,
        automation_id: Uuid,
        lease_owner: &str,
        started_at: DateTime<Utc>,
    ) -> Result<()> {
        let Some(mut automation) = self.get_automation(automation_id)? else {
            return Ok(());
        };
        if automation.status != AutomationStatus::Current
            || automation.lease_owner.as_deref() != Some(lease_owner)
        {
            return Ok(());
        }
        automation.run_history.insert(
            0,
            AutomationRun {
                id: Uuid::new_v4(),
                status: AutomationRunStatus::Running,
                started_at,
                finished_at: None,
                summary: "Automation is running".into(),
                stop_condition_met: None,
            },
        );
        automation.run_history.truncate(8);
        automation.updated_at = started_at;
        self.conn.execute(
            "update automations set run_history = ?1, updated_at = ?2
             where id = ?3 and status = 'current' and lease_owner = ?4",
            params![
                serde_json::to_string(&automation.run_history)?,
                started_at.to_rfc3339(),
                automation_id.to_string(),
                lease_owner,
            ],
        )?;
        Ok(())
    }

    pub fn triage_automation(
        &self,
        automation_id: Uuid,
        triage_state: AutomationTriageState,
    ) -> Result<Option<Automation>> {
        let Some(mut automation) = self.get_automation(automation_id)? else {
            return Ok(None);
        };
        automation.triage_state = triage_state;
        if automation.triage_state == AutomationTriageState::Archived {
            automation.unread_results = 0;
        }
        automation.updated_at = Utc::now();
        self.update_automation(&automation)?;
        self.get_automation(automation_id)
    }

    fn initialize(&self) -> Result<()> {
        self.conn.execute_batch(
            "create table if not exists automations (
               id text primary key not null,
               title text not null,
               prompt text not null,
               schedule text not null,
               status text not null,
               triage_state text not null,
               project text not null,
               provider text not null,
               branch text not null,
               workspace_mode text not null default 'local',
               worktree_name text,
	               stop_condition text,
	               last_run_at text,
	               next_run_at text,
	               lease_owner text,
	               lease_expires_at text,
	               last_result text not null,
	               unread_results integer not null default 0,
	               run_history text not null,
	               execution_context text not null default '{}',
               created_at text not null,
               updated_at text not null
             );

	             create index if not exists idx_automations_updated_at
	             on automations(updated_at desc);",
        )?;
        self.ensure_column("lease_owner", "text")?;
        self.ensure_column("lease_expires_at", "text")?;
        self.ensure_column("execution_context", "text not null default '{}'")?;
        Ok(())
    }

    fn insert_automation(&self, automation: &Automation) -> Result<()> {
        self.conn.execute(
	             "insert into automations
	             (id, title, prompt, schedule, status, triage_state, project, provider, branch,
	              workspace_mode, worktree_name, stop_condition, last_run_at, next_run_at, last_result,
	              unread_results, run_history, created_at, updated_at, lease_owner, lease_expires_at,
	              execution_context)
	             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)",
            params![
                automation.id.to_string(),
                automation.title,
                automation.prompt,
                automation.schedule.as_str(),
                automation.status.as_str(),
                automation.triage_state.as_str(),
                automation.project,
                automation.provider,
                automation.branch,
                automation.workspace_mode.as_str(),
                automation.worktree_name,
                automation.stop_condition,
                format_optional_datetime(automation.last_run_at),
                format_optional_datetime(automation.next_run_at),
                automation.last_result,
                automation.unread_results,
                serde_json::to_string(&automation.run_history)?,
                automation.created_at.to_rfc3339(),
                automation.updated_at.to_rfc3339(),
                automation.lease_owner,
                format_optional_datetime(automation.lease_expires_at),
                serde_json::to_string(&automation.execution)?,
            ],
        )?;
        Ok(())
    }

    fn update_automation(&self, automation: &Automation) -> Result<()> {
        self.conn.execute(
            "update automations set
	             title = ?1, prompt = ?2, schedule = ?3, status = ?4, triage_state = ?5,
	             project = ?6, provider = ?7, branch = ?8, workspace_mode = ?9,
	             worktree_name = ?10, stop_condition = ?11, last_run_at = ?12,
	             next_run_at = ?13, last_result = ?14, unread_results = ?15,
	             run_history = ?16, lease_owner = ?17, lease_expires_at = ?18,
	             updated_at = ?19, execution_context = ?20 where id = ?21",
            params![
                automation.title,
                automation.prompt,
                automation.schedule.as_str(),
                automation.status.as_str(),
                automation.triage_state.as_str(),
                automation.project,
                automation.provider,
                automation.branch,
                automation.workspace_mode.as_str(),
                automation.worktree_name,
                automation.stop_condition,
                format_optional_datetime(automation.last_run_at),
                format_optional_datetime(automation.next_run_at),
                automation.last_result,
                automation.unread_results,
                serde_json::to_string(&automation.run_history)?,
                automation.lease_owner,
                format_optional_datetime(automation.lease_expires_at),
                automation.updated_at.to_rfc3339(),
                serde_json::to_string(&automation.execution)?,
                automation.id.to_string(),
            ],
        )?;
        Ok(())
    }

    fn ensure_column(&self, column_name: &str, column_definition: &str) -> Result<()> {
        let mut stmt = self.conn.prepare("pragma table_info(automations)")?;
        let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;
        for column in columns {
            if column? == column_name {
                return Ok(());
            }
        }
        self.conn.execute(
            &format!("alter table automations add column {column_name} {column_definition}"),
            [],
        )?;
        Ok(())
    }
}

fn row_to_automation(row: &rusqlite::Row<'_>) -> rusqlite::Result<Automation> {
    let id: String = row.get(0)?;
    let schedule: String = row.get(3)?;
    let status: String = row.get(4)?;
    let triage_state: String = row.get(5)?;
    let workspace_mode: String = row.get(9)?;
    let last_run_at: Option<String> = row.get(12)?;
    let next_run_at: Option<String> = row.get(13)?;
    let lease_expires_at: Option<String> = row.get(15)?;
    let unread_results: i64 = row.get(17)?;
    let run_history: String = row.get(18)?;
    let created_at: String = row.get(19)?;
    let updated_at: String = row.get(20)?;
    let execution_context: String = row.get(21)?;

    Ok(Automation {
        id: Uuid::parse_str(&id).map_err(parse_error)?,
        title: row.get(1)?,
        prompt: row.get(2)?,
        schedule: AutomationSchedule::from_str(&schedule),
        status: AutomationStatus::from_str(&status),
        triage_state: AutomationTriageState::from_str(&triage_state),
        project: row.get(6)?,
        provider: row.get(7)?,
        branch: row.get(8)?,
        workspace_mode: SessionWorkspaceMode::from_str(&workspace_mode),
        worktree_name: row.get(10)?,
        stop_condition: row.get(11)?,
        execution: serde_json::from_str(&execution_context).unwrap_or_default(),
        last_run_at: parse_optional_datetime(last_run_at).map_err(parse_error)?,
        next_run_at: parse_optional_datetime(next_run_at).map_err(parse_error)?,
        lease_owner: row.get(14)?,
        lease_expires_at: parse_optional_datetime(lease_expires_at).map_err(parse_error)?,
        last_result: row.get(16)?,
        unread_results: unread_results.max(0) as u32,
        run_history: serde_json::from_str(&run_history).map_err(parse_error)?,
        created_at: DateTime::parse_from_rfc3339(&created_at)
            .map_err(parse_error)?
            .with_timezone(&Utc),
        updated_at: DateTime::parse_from_rfc3339(&updated_at)
            .map_err(parse_error)?
            .with_timezone(&Utc),
    })
}

fn blank_to_default(value: String, fallback: &str) -> String {
    let value = value.trim().to_string();
    if value.is_empty() {
        fallback.into()
    } else {
        value
    }
}

fn next_automation_run_after(
    schedule: &AutomationSchedule,
    now: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    match schedule {
        AutomationSchedule::Manual => None,
        AutomationSchedule::Hourly | AutomationSchedule::Heartbeat => {
            Some(now + Duration::hours(1))
        }
        AutomationSchedule::Daily => Some(now + Duration::days(1)),
        AutomationSchedule::Weekly => Some(now + Duration::weeks(1)),
    }
}

fn apply_automation_run(
    automation: &mut Automation,
    run_status: AutomationRunStatus,
    summary: String,
    now: DateTime<Utc>,
    stop_condition_met: Option<bool>,
) {
    if run_status == AutomationRunStatus::Passed && stop_condition_met == Some(true) {
        automation.status = AutomationStatus::Completed;
    }
    automation.last_run_at = Some(now);
    automation.last_result = summary.clone();
    automation.next_run_at = match automation.status {
        AutomationStatus::Current => match run_status {
            AutomationRunStatus::Failed => Some(now + automation_retry_delay(automation)),
            AutomationRunStatus::Stopped => None,
            _ => next_automation_run_after(&automation.schedule, now),
        },
        AutomationStatus::Paused | AutomationStatus::Completed => None,
    };
    automation.lease_owner = None;
    automation.lease_expires_at = None;
    automation.triage_state = AutomationTriageState::NeedsReview;
    automation.unread_results += 1;
    automation.updated_at = now;
    if let Some(run) = automation
        .run_history
        .iter_mut()
        .find(|run| run.status == AutomationRunStatus::Running && run.finished_at.is_none())
    {
        run.status = run_status;
        run.finished_at = Some(now);
        run.summary = summary;
        run.stop_condition_met = stop_condition_met;
    } else {
        automation.run_history.insert(
            0,
            AutomationRun {
                id: Uuid::new_v4(),
                status: run_status,
                started_at: now,
                finished_at: Some(now),
                summary,
                stop_condition_met,
            },
        );
    }
    automation.run_history.truncate(8);
}

fn automation_retry_delay(automation: &Automation) -> Duration {
    let consecutive_failures = automation
        .run_history
        .iter()
        .filter(|run| {
            run.status != AutomationRunStatus::Running && run.status != AutomationRunStatus::Queued
        })
        .take_while(|run| run.status == AutomationRunStatus::Failed)
        .count();
    match consecutive_failures {
        0 => Duration::minutes(1),
        1 => Duration::minutes(5),
        2 => Duration::minutes(15),
        _ => Duration::hours(1),
    }
}

fn format_optional_datetime(value: Option<DateTime<Utc>>) -> Option<String> {
    value.map(|value| value.to_rfc3339())
}

fn parse_optional_datetime(
    value: Option<String>,
) -> Result<Option<DateTime<Utc>>, chrono::ParseError> {
    value
        .map(|value| DateTime::parse_from_rfc3339(&value).map(|parsed| parsed.with_timezone(&Utc)))
        .transpose()
}

fn parse_error(error: impl std::error::Error + Send + Sync + 'static) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_and_updates_automation_lifecycle() {
        let temp = tempfile::tempdir().unwrap();
        let store =
            AutomationStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let automation = store
            .create_automation(CreateAutomationRequest {
                title: " Heartbeat ".into(),
                prompt: "Run smoke checks".into(),
                schedule: AutomationSchedule::Heartbeat,
                project: "Gyro".into(),
                provider: "Codex".into(),
                branch: "main".into(),
                workspace_mode: SessionWorkspaceMode::Local,
                worktree_name: None,
                stop_condition: Some("Stop after green twice".into()),
                next_run_at: None,
                execution: AutomationExecutionContext {
                    workspace_path: Some("/tmp/Gyro".into()),
                    provider_id: Some("openai".into()),
                    provider_label: Some("OpenAI".into()),
                    model_id: Some("gpt-5.6".into()),
                    model_label: Some("GPT-5.6".into()),
                    reasoning_effort: Some("medium".into()),
                },
            })
            .unwrap();

        assert_eq!(automation.title, "Heartbeat");
        assert_eq!(automation.status, AutomationStatus::Current);
        assert_eq!(automation.triage_state, AutomationTriageState::None);
        assert_eq!(automation.run_history.len(), 1);
        assert_eq!(store.list_automations().unwrap().len(), 1);
        assert_eq!(automation.execution.provider_id.as_deref(), Some("openai"));

        let ran = store
            .record_automation_run(automation.id, "smoke passed")
            .unwrap()
            .unwrap();
        assert_eq!(ran.triage_state, AutomationTriageState::NeedsReview);
        assert_eq!(ran.unread_results, 1);
        assert_eq!(ran.last_result, "smoke passed");
        assert_eq!(ran.run_history[0].status, AutomationRunStatus::Passed);

        let paused = store
            .set_automation_status(automation.id, AutomationStatus::Paused)
            .unwrap()
            .unwrap();
        assert_eq!(paused.status, AutomationStatus::Paused);
        assert!(paused.next_run_at.is_none());

        let archived = store
            .triage_automation(automation.id, AutomationTriageState::Archived)
            .unwrap()
            .unwrap();
        assert_eq!(archived.triage_state, AutomationTriageState::Archived);
        assert_eq!(archived.unread_results, 0);
    }

    #[test]
    fn claims_due_automation_with_recoverable_lease() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let store = AutomationStore::open(paths.clone()).unwrap();
        let due_at = Utc::now() - Duration::minutes(1);
        let automation = store
            .create_automation(CreateAutomationRequest {
                title: "Scheduled smoke".into(),
                prompt: "Run smoke checks".into(),
                schedule: AutomationSchedule::Hourly,
                project: "Gyro".into(),
                provider: "Codex".into(),
                branch: "main".into(),
                workspace_mode: SessionWorkspaceMode::Local,
                worktree_name: None,
                stop_condition: None,
                next_run_at: Some(due_at),
                execution: AutomationExecutionContext::default(),
            })
            .unwrap();

        assert_eq!(store.list_due_automations(Utc::now()).unwrap().len(), 1);

        let claimed = store
            .claim_due_automation("desktop-scheduler", 300)
            .unwrap()
            .unwrap();
        assert_eq!(claimed.id, automation.id);
        assert_eq!(claimed.lease_owner.as_deref(), Some("desktop-scheduler"));
        assert!(claimed.lease_expires_at.is_some());
        assert!(store.list_due_automations(Utc::now()).unwrap().is_empty());
        let competing_store = AutomationStore::open(paths).unwrap();
        assert!(competing_store
            .claim_due_automation("competing-scheduler", 300)
            .unwrap()
            .is_none());

        let completed = store
            .complete_automation_lease(automation.id, "desktop-scheduler", "scheduled smoke passed")
            .unwrap()
            .unwrap();
        assert!(completed.lease_owner.is_none());
        assert!(completed.lease_expires_at.is_none());
        assert_eq!(completed.unread_results, 1);
        assert_eq!(completed.last_result, "scheduled smoke passed");
        assert_eq!(completed.run_history[0].status, AutomationRunStatus::Passed);
        assert!(completed.next_run_at.unwrap() > Utc::now());
    }

    #[test]
    fn forward_clock_jump_claims_one_missed_run_without_duplicates() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let store = AutomationStore::open(paths.clone()).unwrap();
        let before_sleep = Utc::now();
        let automation = store
            .create_automation(CreateAutomationRequest {
                title: "Wake smoke".into(),
                prompt: "Run after wake".into(),
                schedule: AutomationSchedule::Hourly,
                project: "Gyro".into(),
                provider: "Codex".into(),
                branch: "main".into(),
                workspace_mode: SessionWorkspaceMode::Local,
                worktree_name: None,
                stop_condition: None,
                next_run_at: Some(before_sleep + Duration::hours(1)),
                execution: AutomationExecutionContext::default(),
            })
            .unwrap();

        assert!(store
            .claim_due_automation_at("before-sleep", 300, before_sleep)
            .unwrap()
            .is_none());

        let after_wake = before_sleep + Duration::hours(6);
        let claimed = store
            .claim_due_automation_at("wake-worker", 300, after_wake)
            .unwrap()
            .unwrap();
        assert_eq!(claimed.id, automation.id);
        assert_eq!(claimed.lease_owner.as_deref(), Some("wake-worker"));

        let competing_store = AutomationStore::open(paths).unwrap();
        assert!(competing_store
            .claim_due_automation_at("duplicate-worker", 300, after_wake)
            .unwrap()
            .is_none());
    }

    #[test]
    fn lease_renewal_extends_only_the_current_owners_active_run() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let store = AutomationStore::open(paths).unwrap();
        let now = Utc::now();
        let automation = store
            .create_automation(CreateAutomationRequest {
                title: "Long approval".into(),
                prompt: "Wait for review".into(),
                schedule: AutomationSchedule::Hourly,
                project: "Gyro".into(),
                provider: "Codex".into(),
                branch: "main".into(),
                workspace_mode: SessionWorkspaceMode::Local,
                worktree_name: None,
                stop_condition: None,
                next_run_at: Some(now - Duration::minutes(1)),
                execution: AutomationExecutionContext::default(),
            })
            .unwrap();
        let claimed = store
            .claim_due_automation_at("owner", 45 * 60, now)
            .unwrap()
            .unwrap();
        let initial_expiry = claimed.lease_expires_at.unwrap();

        assert!(store
            .renew_automation_lease_at(
                automation.id,
                "stale-owner",
                45 * 60,
                now + Duration::minutes(20),
            )
            .unwrap()
            .is_none());
        assert_eq!(
            store
                .get_automation(automation.id)
                .unwrap()
                .unwrap()
                .lease_expires_at,
            Some(initial_expiry)
        );

        let backward_renewal = store
            .renew_automation_lease_at(automation.id, "owner", 45 * 60, now - Duration::hours(2))
            .unwrap()
            .unwrap();
        assert_eq!(backward_renewal.lease_expires_at, Some(initial_expiry));

        let renewed = store
            .renew_automation_lease_at(automation.id, "owner", 45 * 60, now + Duration::minutes(20))
            .unwrap()
            .unwrap();
        assert!(renewed.lease_expires_at.unwrap() > initial_expiry);

        store
            .set_automation_status(automation.id, AutomationStatus::Paused)
            .unwrap();
        let paused_renewal = store
            .renew_automation_lease_at(automation.id, "owner", 45 * 60, now + Duration::minutes(30))
            .unwrap()
            .unwrap();
        assert_eq!(paused_renewal.status, AutomationStatus::Paused);
        assert!(paused_renewal.lease_owner.is_some());
        assert_eq!(
            store
                .recover_expired_automation_leases(now + Duration::minutes(50))
                .unwrap(),
            0
        );

        let stopped = store
            .finish_automation_lease(
                automation.id,
                "owner",
                AutomationRunStatus::Stopped,
                "Stopped after approval wait",
            )
            .unwrap()
            .unwrap();
        assert!(stopped.lease_owner.is_none());
        assert!(stopped.lease_expires_at.is_none());
    }

    #[test]
    fn satisfied_stop_condition_atomically_completes_the_automation() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let store = AutomationStore::open(paths.clone()).unwrap();
        let automation = store
            .create_automation(CreateAutomationRequest {
                title: "Stop after green".into(),
                prompt: "Run smoke checks".into(),
                schedule: AutomationSchedule::Hourly,
                project: "Gyro".into(),
                provider: "Codex".into(),
                branch: "main".into(),
                workspace_mode: SessionWorkspaceMode::Local,
                worktree_name: None,
                stop_condition: Some("All smoke checks pass".into()),
                next_run_at: Some(Utc::now() - Duration::minutes(1)),
                execution: AutomationExecutionContext::default(),
            })
            .unwrap();
        store
            .claim_due_automation("desktop-scheduler", 300)
            .unwrap()
            .unwrap();

        let completed = store
            .finish_automation_lease_with_stop_condition(
                automation.id,
                "desktop-scheduler",
                AutomationRunStatus::Passed,
                "All smoke checks passed",
                Some(true),
            )
            .unwrap()
            .unwrap();

        assert_eq!(completed.status, AutomationStatus::Completed);
        assert!(completed.next_run_at.is_none());
        assert!(completed.lease_owner.is_none());
        assert_eq!(completed.run_history[0].stop_condition_met, Some(true));
        assert!(store.list_due_automations(Utc::now()).unwrap().is_empty());
        assert!(store.queue_automation_now(automation.id).is_err());

        let reopened = AutomationStore::open(paths)
            .unwrap()
            .get_automation(automation.id)
            .unwrap()
            .unwrap();
        assert_eq!(reopened.status, AutomationStatus::Completed);
        assert_eq!(reopened.run_history[0].stop_condition_met, Some(true));
    }

    #[test]
    fn old_run_history_without_a_stop_verdict_remains_readable() {
        let run = serde_json::from_value::<AutomationRun>(serde_json::json!({
            "id": Uuid::new_v4(),
            "status": "passed",
            "startedAt": Utc::now(),
            "finishedAt": Utc::now(),
            "summary": "Legacy run"
        }))
        .unwrap();

        assert_eq!(run.stop_condition_met, None);
    }

    #[test]
    fn recovers_expired_automation_leases() {
        let temp = tempfile::tempdir().unwrap();
        let store =
            AutomationStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        store
            .create_automation(CreateAutomationRequest {
                title: "Recoverable smoke".into(),
                prompt: "Run smoke checks".into(),
                schedule: AutomationSchedule::Hourly,
                project: "Gyro".into(),
                provider: "Codex".into(),
                branch: "main".into(),
                workspace_mode: SessionWorkspaceMode::Local,
                worktree_name: None,
                stop_condition: None,
                next_run_at: Some(Utc::now() - Duration::minutes(1)),
                execution: AutomationExecutionContext::default(),
            })
            .unwrap();

        let claimed = store.claim_due_automation("desktop-scheduler", 30).unwrap();
        assert!(claimed.is_some());
        assert!(store.list_due_automations(Utc::now()).unwrap().is_empty());

        let recovered = store
            .recover_expired_automation_leases(Utc::now() + Duration::minutes(1))
            .unwrap();
        assert_eq!(recovered, 1);
        let recovered = store.list_automations().unwrap().remove(0);
        assert!(recovered.lease_owner.is_none());
        assert_eq!(recovered.run_history[0].status, AutomationRunStatus::Failed);
        assert!(recovered.next_run_at.unwrap() > Utc::now());
    }

    #[test]
    fn pausing_a_claimed_run_keeps_ownership_until_it_stops() {
        let temp = tempfile::tempdir().unwrap();
        let store =
            AutomationStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let automation = store
            .create_automation(CreateAutomationRequest {
                title: "Pause me".into(),
                prompt: "Wait".into(),
                schedule: AutomationSchedule::Hourly,
                project: "Gyro".into(),
                provider: "Codex".into(),
                branch: "main".into(),
                workspace_mode: SessionWorkspaceMode::Local,
                worktree_name: None,
                stop_condition: None,
                next_run_at: Some(Utc::now() - Duration::minutes(1)),
                execution: AutomationExecutionContext::default(),
            })
            .unwrap();
        store.claim_due_automation("worker", 300).unwrap().unwrap();
        let paused = store
            .set_automation_status(automation.id, AutomationStatus::Paused)
            .unwrap()
            .unwrap();
        assert_eq!(paused.lease_owner.as_deref(), Some("worker"));
        assert!(paused.next_run_at.is_none());

        let stopped = store
            .finish_automation_lease(
                automation.id,
                "worker",
                AutomationRunStatus::Stopped,
                "Stopped after pause",
            )
            .unwrap()
            .unwrap();
        assert_eq!(stopped.status, AutomationStatus::Paused);
        assert!(stopped.lease_owner.is_none());
        assert!(stopped.next_run_at.is_none());
        assert_eq!(stopped.run_history[0].status, AutomationRunStatus::Stopped);
    }

    #[test]
    fn schedules_and_failure_backoff_match_the_selected_cadence() {
        let now = Utc::now();
        assert!(next_automation_run_after(&AutomationSchedule::Manual, now).is_none());
        assert_eq!(
            next_automation_run_after(&AutomationSchedule::Hourly, now),
            Some(now + Duration::hours(1))
        );
        assert_eq!(
            next_automation_run_after(&AutomationSchedule::Daily, now),
            Some(now + Duration::days(1))
        );
        assert_eq!(
            next_automation_run_after(&AutomationSchedule::Weekly, now),
            Some(now + Duration::weeks(1))
        );

        let temp = tempfile::tempdir().unwrap();
        let store =
            AutomationStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let automation = store
            .create_automation(CreateAutomationRequest {
                title: "Retry me".into(),
                prompt: "Fail safely".into(),
                schedule: AutomationSchedule::Daily,
                project: "Gyro".into(),
                provider: "Codex".into(),
                branch: "main".into(),
                workspace_mode: SessionWorkspaceMode::Local,
                worktree_name: None,
                stop_condition: None,
                next_run_at: Some(now - Duration::minutes(1)),
                execution: AutomationExecutionContext::default(),
            })
            .unwrap();
        store.claim_due_automation("worker", 300).unwrap().unwrap();
        let failed = store
            .finish_automation_lease(
                automation.id,
                "worker",
                AutomationRunStatus::Failed,
                "Provider offline",
            )
            .unwrap()
            .unwrap();
        assert_eq!(failed.run_history[0].status, AutomationRunStatus::Failed);
        assert_eq!(failed.last_result, "Provider offline");
        assert!(failed.next_run_at.unwrap() < Utc::now() + Duration::minutes(2));
    }

    #[test]
    fn rejects_invalid_automation_inputs_and_missing_ids() {
        let temp = tempfile::tempdir().unwrap();
        let store =
            AutomationStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        assert!(store
            .create_automation(CreateAutomationRequest {
                title: " ".into(),
                prompt: "Run smoke checks".into(),
                schedule: AutomationSchedule::Manual,
                project: "Gyro".into(),
                provider: "Codex".into(),
                branch: "main".into(),
                workspace_mode: SessionWorkspaceMode::Local,
                worktree_name: None,
                stop_condition: None,
                next_run_at: None,
                execution: AutomationExecutionContext::default(),
            })
            .is_err());
        assert!(store
            .record_automation_run(Uuid::new_v4(), "missing")
            .unwrap()
            .is_none());
    }
}
