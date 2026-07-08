use crate::paths::GyroPaths;
use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionOrigin {
    Cli,
    Desktop,
}

impl SessionOrigin {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Cli => "cli",
            Self::Desktop => "desktop",
        }
    }

    fn from_str(value: &str) -> Self {
        match value {
            "desktop" => Self::Desktop,
            _ => Self::Cli,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionWorkspaceMode {
    Local,
    Worktree,
}

impl SessionWorkspaceMode {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Worktree => "worktree",
        }
    }

    pub(crate) fn from_str(value: &str) -> Self {
        match value {
            "worktree" => Self::Worktree,
            _ => Self::Local,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionEventKind {
    SessionCreated,
    UserMessage,
    AssistantMessage,
    CommandRequested,
    CommandOutput,
    FileEditProposed,
    ApprovalRequested,
    PlanUpdated,
    SystemEvent,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub id: Uuid,
    pub session_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub kind: SessionEventKind,
    pub message: String,
    pub payload: Value,
}

impl SessionEvent {
    pub fn new(
        session_id: Uuid,
        kind: SessionEventKind,
        message: impl Into<String>,
        payload: Value,
    ) -> Self {
        Self {
            id: Uuid::new_v4(),
            session_id,
            turn_id: None,
            created_at: Utc::now(),
            kind,
            message: message.into(),
            payload,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: Uuid,
    pub title: String,
    pub workspace_path: PathBuf,
    pub origin: SessionOrigin,
    pub workspace_mode: SessionWorkspaceMode,
    pub branch: String,
    pub worktree_name: Option<String>,
    pub provider_id: Option<String>,
    pub provider_label: Option<String>,
    pub model_id: Option<String>,
    pub model_label: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub events_path: PathBuf,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionContext {
    pub workspace_mode: SessionWorkspaceMode,
    pub branch: String,
    pub worktree_name: Option<String>,
    pub provider_id: Option<String>,
    pub provider_label: Option<String>,
    pub model_id: Option<String>,
    pub model_label: Option<String>,
}

impl Default for CreateSessionContext {
    fn default() -> Self {
        Self {
            workspace_mode: SessionWorkspaceMode::Local,
            branch: "main".into(),
            worktree_name: None,
            provider_id: None,
            provider_label: None,
            model_id: None,
            model_label: None,
        }
    }
}

pub struct SessionStore {
    paths: GyroPaths,
    conn: Connection,
}

impl SessionStore {
    pub fn open(paths: GyroPaths) -> Result<Self> {
        paths.ensure()?;
        let conn = Connection::open(&paths.database_path)
            .with_context(|| format!("open {}", paths.database_path.display()))?;
        let store = Self { paths, conn };
        store.initialize()?;
        Ok(store)
    }

    pub fn paths(&self) -> &GyroPaths {
        &self.paths
    }

    pub fn create_session(
        &self,
        workspace_path: impl AsRef<Path>,
        origin: SessionOrigin,
        title: impl Into<String>,
    ) -> Result<Session> {
        self.create_session_with_context(
            workspace_path,
            origin,
            title,
            CreateSessionContext::default(),
        )
    }

    pub fn create_session_with_context(
        &self,
        workspace_path: impl AsRef<Path>,
        origin: SessionOrigin,
        title: impl Into<String>,
        context: CreateSessionContext,
    ) -> Result<Session> {
        let now = Utc::now();
        let id = Uuid::new_v4();
        let events_path = self.paths.sessions_dir.join(format!("{id}.jsonl"));
        let workspace_path = workspace_path
            .as_ref()
            .canonicalize()
            .unwrap_or_else(|_| workspace_path.as_ref().to_path_buf());
        let session = Session {
            id,
            title: title.into(),
            workspace_path,
            origin,
            workspace_mode: context.workspace_mode,
            branch: context.branch,
            worktree_name: context.worktree_name,
            provider_id: context.provider_id,
            provider_label: context.provider_label,
            model_id: context.model_id,
            model_label: context.model_label,
            created_at: now,
            updated_at: now,
            events_path,
        };

        self.conn.execute(
            "insert into sessions
             (id, title, workspace_path, origin, workspace_mode, branch, worktree_name, provider_id, provider_label, model_id, model_label, created_at, updated_at, events_path)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                session.id.to_string(),
                session.title,
                session.workspace_path.to_string_lossy(),
                session.origin.as_str(),
                session.workspace_mode.as_str(),
                session.branch,
                session.worktree_name,
                session.provider_id,
                session.provider_label,
                session.model_id,
                session.model_label,
                session.created_at.to_rfc3339(),
                session.updated_at.to_rfc3339(),
                session.events_path.to_string_lossy()
            ],
        )?;

        self.append_event(
            session.id,
            SessionEventKind::SessionCreated,
            "Session created",
            serde_json::json!({
                "origin": session.origin.as_str(),
                "workspaceMode": session.workspace_mode.as_str(),
                "workspacePath": session.workspace_path,
                "branch": session.branch,
                "worktreeName": session.worktree_name,
                "providerId": session.provider_id,
                "providerLabel": session.provider_label,
                "modelId": session.model_id,
                "modelLabel": session.model_label,
            }),
        )?;

        self.get_session(session.id)?
            .ok_or_else(|| anyhow!("session was not persisted"))
    }

    pub fn get_session(&self, session_id: Uuid) -> Result<Option<Session>> {
        self.conn
            .query_row(
                "select id, title, workspace_path, origin, created_at, updated_at, events_path
                 , workspace_mode, branch, worktree_name, provider_id, provider_label, model_id, model_label
                 from sessions where id = ?1",
                params![session_id.to_string()],
                |row| row_to_session(row),
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn latest_session(&self) -> Result<Option<Session>> {
        self.conn
            .query_row(
                "select id, title, workspace_path, origin, created_at, updated_at, events_path
                 , workspace_mode, branch, worktree_name, provider_id, provider_label, model_id, model_label
                 from sessions order by updated_at desc limit 1",
                [],
                |row| row_to_session(row),
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn list_sessions(&self) -> Result<Vec<Session>> {
        let mut stmt = self.conn.prepare(
            "select id, title, workspace_path, origin, created_at, updated_at, events_path
             , workspace_mode, branch, worktree_name, provider_id, provider_label, model_id, model_label
             from sessions order by updated_at desc",
        )?;
        let rows = stmt.query_map([], |row| row_to_session(row))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub fn rename_session(
        &self,
        session_id: Uuid,
        title: impl Into<String>,
    ) -> Result<Option<Session>> {
        let title = title.into().trim().to_string();
        if title.is_empty() {
            return Err(anyhow!("session title cannot be empty"));
        }

        let updated_at = Utc::now();
        let changed = self.conn.execute(
            "update sessions set title = ?1, updated_at = ?2 where id = ?3",
            params![title, updated_at.to_rfc3339(), session_id.to_string()],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        self.get_session(session_id)
    }

    pub fn delete_session(&self, session_id: Uuid) -> Result<bool> {
        let Some(session) = self.get_session(session_id)? else {
            return Ok(false);
        };

        if session.events_path.starts_with(&self.paths.sessions_dir) && session.events_path.exists()
        {
            std::fs::remove_file(&session.events_path)
                .with_context(|| format!("remove {}", session.events_path.display()))?;
        }

        let changed = self.conn.execute(
            "delete from sessions where id = ?1",
            params![session_id.to_string()],
        )?;
        Ok(changed > 0)
    }

    pub fn update_session_model(
        &self,
        session_id: Uuid,
        provider_id: Option<String>,
        provider_label: Option<String>,
        model_id: Option<String>,
        model_label: Option<String>,
    ) -> Result<Option<Session>> {
        let updated_at = Utc::now();
        let changed = self.conn.execute(
            "update sessions
             set provider_id = ?1, provider_label = ?2, model_id = ?3, model_label = ?4, updated_at = ?5
             where id = ?6",
            params![
                provider_id,
                provider_label,
                model_id,
                model_label,
                updated_at.to_rfc3339(),
                session_id.to_string(),
            ],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        self.get_session(session_id)
    }

    pub fn append_event(
        &self,
        session_id: Uuid,
        kind: SessionEventKind,
        message: impl Into<String>,
        payload: Value,
    ) -> Result<SessionEvent> {
        self.append_event_with_turn_id(session_id, kind, message, payload, None)
    }

    pub fn append_user_turn_message(
        &self,
        session_id: Uuid,
        message: impl Into<String>,
        payload: Value,
    ) -> Result<SessionEvent> {
        let turn_id = Uuid::new_v4();
        self.append_event_with_turn_id(
            session_id,
            SessionEventKind::UserMessage,
            message,
            payload_with_turn_id(payload, turn_id),
            Some(turn_id),
        )
    }

    pub fn append_event_with_turn_id(
        &self,
        session_id: Uuid,
        kind: SessionEventKind,
        message: impl Into<String>,
        payload: Value,
        turn_id: Option<Uuid>,
    ) -> Result<SessionEvent> {
        let session = self
            .get_session(session_id)?
            .ok_or_else(|| anyhow!("unknown session {session_id}"))?;
        let mut event = SessionEvent::new(session_id, kind, message, payload);
        event.turn_id = turn_id;
        let encoded = serde_json::to_string(&event)?;
        let mut file = OpenOptions::new()
            .append(true)
            .create(true)
            .open(&session.events_path)
            .with_context(|| format!("open {}", session.events_path.display()))?;
        writeln!(file, "{encoded}")?;

        self.conn.execute(
            "update sessions set updated_at = ?1 where id = ?2",
            params![event.created_at.to_rfc3339(), session_id.to_string()],
        )?;
        Ok(event)
    }

    pub fn read_events(&self, session_id: Uuid) -> Result<Vec<SessionEvent>> {
        let session = self
            .get_session(session_id)?
            .ok_or_else(|| anyhow!("unknown session {session_id}"))?;

        if !session.events_path.exists() {
            return Ok(Vec::new());
        }

        let file = std::fs::File::open(&session.events_path)
            .with_context(|| format!("open {}", session.events_path.display()))?;
        BufReader::new(file)
            .lines()
            .enumerate()
            .map(|(line_number, line)| {
                let line = line?;
                serde_json::from_str::<SessionEvent>(&line).with_context(|| {
                    format!(
                        "parse session event {} at line {}",
                        session.events_path.display(),
                        line_number + 1
                    )
                })
            })
            .collect()
    }

    fn initialize(&self) -> Result<()> {
        self.conn.execute_batch(
            "create table if not exists sessions (
               id text primary key not null,
               title text not null,
               workspace_path text not null,
               origin text not null,
               workspace_mode text not null default 'local',
               branch text not null default 'main',
               worktree_name text,
               provider_id text,
               provider_label text,
               model_id text,
               model_label text,
               created_at text not null,
               updated_at text not null,
               events_path text not null
             );

             create index if not exists idx_sessions_updated_at
             on sessions(updated_at desc);",
        )?;
        self.ensure_column(
            "workspace_mode",
            "workspace_mode text not null default 'local'",
        )?;
        self.ensure_column("branch", "branch text not null default 'main'")?;
        self.ensure_column("worktree_name", "worktree_name text")?;
        self.ensure_column("provider_id", "provider_id text")?;
        self.ensure_column("provider_label", "provider_label text")?;
        self.ensure_column("model_id", "model_id text")?;
        self.ensure_column("model_label", "model_label text")?;
        Ok(())
    }

    fn ensure_column(&self, column_name: &str, definition: &str) -> Result<()> {
        let mut stmt = self.conn.prepare("pragma table_info(sessions)")?;
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        if columns.iter().any(|column| column == column_name) {
            return Ok(());
        }
        self.conn
            .execute_batch(&format!("alter table sessions add column {definition};"))?;
        Ok(())
    }
}

fn row_to_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<Session> {
    let id: String = row.get(0)?;
    let title: String = row.get(1)?;
    let workspace_path: String = row.get(2)?;
    let origin: String = row.get(3)?;
    let created_at: String = row.get(4)?;
    let updated_at: String = row.get(5)?;
    let events_path: String = row.get(6)?;
    let workspace_mode: String = row.get(7)?;
    let branch: String = row.get(8)?;
    let worktree_name: Option<String> = row.get(9)?;
    let provider_id: Option<String> = row.get(10)?;
    let provider_label: Option<String> = row.get(11)?;
    let model_id: Option<String> = row.get(12)?;
    let model_label: Option<String> = row.get(13)?;

    Ok(Session {
        id: Uuid::parse_str(&id).map_err(parse_error)?,
        title,
        workspace_path: PathBuf::from(workspace_path),
        origin: SessionOrigin::from_str(&origin),
        workspace_mode: SessionWorkspaceMode::from_str(&workspace_mode),
        branch,
        worktree_name,
        provider_id,
        provider_label,
        model_id,
        model_label,
        created_at: DateTime::parse_from_rfc3339(&created_at)
            .map_err(parse_error)?
            .with_timezone(&Utc),
        updated_at: DateTime::parse_from_rfc3339(&updated_at)
            .map_err(parse_error)?
            .with_timezone(&Utc),
        events_path: PathBuf::from(events_path),
    })
}

fn parse_error(error: impl std::error::Error + Send + Sync + 'static) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

fn payload_with_turn_id(payload: Value, turn_id: Uuid) -> Value {
    match payload {
        Value::Object(mut object) => {
            object.insert("turnId".into(), Value::String(turn_id.to_string()));
            Value::Object(object)
        }
        value => serde_json::json!({
            "value": value,
            "turnId": turn_id,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_session_and_appends_jsonl_events() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Cli, "test session")
            .unwrap();
        assert_eq!(session.workspace_mode, SessionWorkspaceMode::Local);
        assert_eq!(session.branch, "main");

        store
            .append_event(
                session.id,
                SessionEventKind::UserMessage,
                "hello",
                serde_json::json!({ "source": "test" }),
            )
            .unwrap();

        let events = store.read_events(session.id).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].kind, SessionEventKind::SessionCreated);
        assert_eq!(events[1].message, "hello");
        assert!(store.latest_session().unwrap().is_some());
    }

    #[test]
    fn appends_user_turn_messages_with_turn_identity() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "turn session")
            .unwrap();

        let event = store
            .append_user_turn_message(
                session.id,
                "inspect this",
                serde_json::json!({ "surface": "desktop" }),
            )
            .unwrap();

        let turn_id = event.turn_id.expect("turn id should be present");
        assert_eq!(event.payload["turnId"], turn_id.to_string());

        let events = store.read_events(session.id).unwrap();
        assert_eq!(events[1].turn_id, Some(turn_id));
    }

    #[test]
    fn appends_plan_update_events() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "plan session")
            .unwrap();

        store
            .append_event(
                session.id,
                SessionEventKind::PlanUpdated,
                "Plan updated",
                serde_json::json!({
                    "action": "add-item",
                    "item": { "id": "inspect", "title": "Inspect the task" },
                }),
            )
            .unwrap();

        let events = store.read_events(session.id).unwrap();
        assert_eq!(events[1].kind, SessionEventKind::PlanUpdated);
        assert_eq!(events[1].payload["action"], "add-item");
    }

    #[test]
    fn stores_worktree_session_context() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session_with_context(
                temp.path(),
                SessionOrigin::Desktop,
                "worktree session",
                CreateSessionContext {
                    workspace_mode: SessionWorkspaceMode::Worktree,
                    branch: "gyro/test-worktree".into(),
                    worktree_name: Some("gyro-test-worktree".into()),
                    ..CreateSessionContext::default()
                },
            )
            .unwrap();

        let stored = store.get_session(session.id).unwrap().unwrap();
        assert_eq!(stored.workspace_mode, SessionWorkspaceMode::Worktree);
        assert_eq!(stored.branch, "gyro/test-worktree");
        assert_eq!(stored.worktree_name.as_deref(), Some("gyro-test-worktree"));
    }

    #[test]
    fn stores_and_updates_session_model() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session_with_context(
                temp.path(),
                SessionOrigin::Desktop,
                "model session",
                CreateSessionContext {
                    provider_id: Some("openai".into()),
                    provider_label: Some("OpenAI".into()),
                    model_id: Some("gpt-5.5".into()),
                    model_label: Some("GPT-5.5".into()),
                    ..CreateSessionContext::default()
                },
            )
            .unwrap();

        let stored = store.get_session(session.id).unwrap().unwrap();
        assert_eq!(stored.provider_id.as_deref(), Some("openai"));
        assert_eq!(stored.provider_label.as_deref(), Some("OpenAI"));
        assert_eq!(stored.model_id.as_deref(), Some("gpt-5.5"));
        assert_eq!(stored.model_label.as_deref(), Some("GPT-5.5"));

        let updated = store
            .update_session_model(
                session.id,
                Some("anthropic".into()),
                Some("Anthropic".into()),
                Some("claude-sonnet-5".into()),
                Some("Claude Sonnet 5".into()),
            )
            .unwrap()
            .unwrap();
        assert_eq!(updated.provider_id.as_deref(), Some("anthropic"));
        assert_eq!(updated.model_id.as_deref(), Some("claude-sonnet-5"));
        assert!(updated.updated_at >= stored.updated_at);
    }

    #[test]
    fn renames_and_deletes_sessions() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "old title")
            .unwrap();
        let events_path = session.events_path.clone();
        assert!(events_path.exists());

        let renamed = store
            .rename_session(session.id, "  new title  ")
            .unwrap()
            .unwrap();
        assert_eq!(renamed.title, "new title");
        assert!(renamed.updated_at >= renamed.created_at);
        assert_eq!(store.latest_session().unwrap().unwrap().title, "new title");

        assert!(store
            .rename_session(Uuid::new_v4(), "missing")
            .unwrap()
            .is_none());
        assert!(store.rename_session(session.id, " ").is_err());

        assert!(store.delete_session(session.id).unwrap());
        assert!(store.get_session(session.id).unwrap().is_none());
        assert!(!events_path.exists());
        assert!(!store.delete_session(session.id).unwrap());
    }
}
