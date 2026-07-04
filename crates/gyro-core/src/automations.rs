use crate::{paths::GyroPaths, sessions::SessionWorkspaceMode};
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
}

pub struct AutomationStore {
    conn: Connection,
}

impl AutomationStore {
    pub fn open(paths: GyroPaths) -> Result<Self> {
        paths.ensure()?;
        let conn = Connection::open(&paths.database_path)
            .with_context(|| format!("open {}", paths.database_path.display()))?;
        let store = Self { conn };
        store.initialize()?;
        Ok(store)
    }

    pub fn list_automations(&self) -> Result<Vec<Automation>> {
        let mut stmt = self.conn.prepare(
            "select id, title, prompt, schedule, status, triage_state, project, provider,
             branch, workspace_mode, worktree_name, stop_condition, last_run_at, next_run_at,
             lease_owner, lease_expires_at, last_result, unread_results, run_history, created_at, updated_at
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
                 lease_owner, lease_expires_at, last_result, unread_results, run_history, created_at, updated_at
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
        let run_history = vec![AutomationRun {
            id: Uuid::new_v4(),
            status: AutomationRunStatus::Queued,
            started_at: now,
            finished_at: None,
            summary: "Automation created locally".into(),
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
            last_run_at: None,
            next_run_at: draft.next_run_at.or_else(|| Some(next_automation_run_at())),
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
                .or_else(|| Some(next_automation_run_at())),
            AutomationStatus::Paused | AutomationStatus::Completed => None,
        };
        let (lease_owner, lease_expires_at) = match status {
            AutomationStatus::Current => (automation.lease_owner, automation.lease_expires_at),
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

        apply_automation_run(&mut automation, summary, Utc::now());

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
             lease_owner, lease_expires_at, last_result, unread_results, run_history, created_at, updated_at
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
        let lease_owner = lease_owner.into().trim().to_string();
        if lease_owner.is_empty() {
            return Err(anyhow!("automation lease owner cannot be empty"));
        }

        let now = Utc::now();
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
             where id = ?4 and (lease_expires_at is null or lease_expires_at <= ?3)",
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

        self.get_automation(Uuid::parse_str(&automation_id)?)
    }

    pub fn recover_expired_automation_leases_now(&self) -> Result<usize> {
        self.recover_expired_automation_leases(Utc::now())
    }

    pub fn recover_expired_automation_leases(&self, now: DateTime<Utc>) -> Result<usize> {
        let now = now.to_rfc3339();
        self.conn
            .execute(
                "update automations set lease_owner = null, lease_expires_at = null,
                 updated_at = ?1
                 where lease_expires_at is not null and lease_expires_at <= ?1",
                params![now],
            )
            .map_err(Into::into)
    }

    pub fn complete_automation_lease(
        &self,
        automation_id: Uuid,
        lease_owner: impl Into<String>,
        summary: impl Into<String>,
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

        apply_automation_run(&mut automation, summary, Utc::now());
        self.update_automation(&automation)?;
        self.get_automation(automation_id)
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
               created_at text not null,
               updated_at text not null
             );

	             create index if not exists idx_automations_updated_at
	             on automations(updated_at desc);",
        )?;
        self.ensure_column("lease_owner", "text")?;
        self.ensure_column("lease_expires_at", "text")?;
        Ok(())
    }

    fn insert_automation(&self, automation: &Automation) -> Result<()> {
        self.conn.execute(
	             "insert into automations
	             (id, title, prompt, schedule, status, triage_state, project, provider, branch,
	              workspace_mode, worktree_name, stop_condition, last_run_at, next_run_at, last_result,
	              unread_results, run_history, created_at, updated_at, lease_owner, lease_expires_at)
	             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
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
	             updated_at = ?19 where id = ?20",
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

fn next_automation_run_at() -> DateTime<Utc> {
    next_automation_run_after(Utc::now())
}

fn next_automation_run_after(now: DateTime<Utc>) -> DateTime<Utc> {
    now + Duration::hours(1)
}

fn apply_automation_run(automation: &mut Automation, summary: String, now: DateTime<Utc>) {
    automation.last_run_at = Some(now);
    automation.last_result = summary.clone();
    automation.next_run_at = if automation.status == AutomationStatus::Current {
        Some(next_automation_run_after(now))
    } else {
        automation.next_run_at
    };
    automation.lease_owner = None;
    automation.lease_expires_at = None;
    automation.triage_state = AutomationTriageState::NeedsReview;
    automation.unread_results += 1;
    automation.updated_at = now;
    automation.run_history.insert(
        0,
        AutomationRun {
            id: Uuid::new_v4(),
            status: AutomationRunStatus::Passed,
            started_at: now,
            finished_at: Some(now),
            summary,
        },
    );
    automation.run_history.truncate(8);
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
            })
            .unwrap();

        assert_eq!(automation.title, "Heartbeat");
        assert_eq!(automation.status, AutomationStatus::Current);
        assert_eq!(automation.triage_state, AutomationTriageState::None);
        assert_eq!(automation.run_history.len(), 1);
        assert_eq!(store.list_automations().unwrap().len(), 1);

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
        let store =
            AutomationStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
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
            })
            .unwrap();

        let claimed = store.claim_due_automation("desktop-scheduler", 30).unwrap();
        assert!(claimed.is_some());
        assert!(store.list_due_automations(Utc::now()).unwrap().is_empty());

        let recovered = store
            .recover_expired_automation_leases(Utc::now() + Duration::minutes(1))
            .unwrap();
        assert_eq!(recovered, 1);
        assert_eq!(store.list_due_automations(Utc::now()).unwrap().len(), 1);
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
            })
            .is_err());
        assert!(store
            .record_automation_run(Uuid::new_v4(), "missing")
            .unwrap()
            .is_none());
    }
}
