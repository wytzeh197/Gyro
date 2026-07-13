use crate::paths::GyroPaths;
use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

const MAX_SESSION_TITLE_CHARS: usize = 160;
const MAX_SESSION_EVENT_MESSAGE_CHARS: usize = 64_000;
const MAX_SESSION_EVENT_PAYLOAD_BYTES: usize = 128 * 1024;
const MAX_SESSION_EVENTS_READ: usize = 1_000;
const SESSION_EVENT_TAIL_CHUNK_BYTES: usize = 64 * 1024;

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
    GoalUpdated,
    ChatModeChanged,
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
    pub reasoning_effort: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub events_path: PathBuf,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSessionBinding {
    pub session_id: Uuid,
    pub provider_id: String,
    pub model_id: Option<String>,
    pub model_label: Option<String>,
    pub reasoning_effort: Option<String>,
    pub resume_cursor_json: Value,
    pub status: String,
    pub last_error: Option<String>,
    pub updated_at: DateTime<Utc>,
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
    pub reasoning_effort: Option<String>,
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
            reasoning_effort: None,
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
        conn.busy_timeout(std::time::Duration::from_secs(2))?;
        conn.execute_batch(
            "pragma foreign_keys = on;
             pragma journal_mode = wal;
             pragma synchronous = full;",
        )?;
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
        let title = normalize_session_title(title)?;
        let events_path = self.session_events_path(id)?;
        let workspace_path = workspace_path
            .as_ref()
            .canonicalize()
            .unwrap_or_else(|_| workspace_path.as_ref().to_path_buf());
        let session = Session {
            id,
            title,
            workspace_path,
            origin,
            workspace_mode: context.workspace_mode,
            branch: context.branch,
            worktree_name: context.worktree_name,
            provider_id: context.provider_id,
            provider_label: context.provider_label,
            model_id: context.model_id,
            model_label: context.model_label,
            reasoning_effort: context.reasoning_effort,
            created_at: now,
            updated_at: now,
            events_path,
        };

        self.conn.execute(
            "insert into sessions
             (id, title, workspace_path, origin, workspace_mode, branch, worktree_name, provider_id, provider_label, model_id, model_label, reasoning_effort, created_at, updated_at, events_path)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
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
                session.reasoning_effort,
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
                "reasoningEffort": session.reasoning_effort,
            }),
        )?;

        self.get_session(session.id)?
            .ok_or_else(|| anyhow!("session was not persisted"))
    }

    pub fn get_session(&self, session_id: Uuid) -> Result<Option<Session>> {
        self.conn
            .query_row(
                "select id, title, workspace_path, origin, created_at, updated_at, events_path
                 , workspace_mode, branch, worktree_name, provider_id, provider_label, model_id, model_label, reasoning_effort
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
                 , workspace_mode, branch, worktree_name, provider_id, provider_label, model_id, model_label, reasoning_effort
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
             , workspace_mode, branch, worktree_name, provider_id, provider_label, model_id, model_label, reasoning_effort
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
        let title = normalize_session_title(title)?;

        let changed = self.conn.execute(
            "update sessions set title = ?1 where id = ?2",
            params![title, session_id.to_string()],
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

        let events_path = self.session_events_path(session.id)?;
        if events_path.exists() {
            std::fs::remove_file(&events_path)
                .with_context(|| format!("remove {}", events_path.display()))?;
        }

        self.conn.execute(
            "delete from provider_session_bindings where session_id = ?1",
            params![session_id.to_string()],
        )?;

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
        reasoning_effort: Option<String>,
    ) -> Result<Option<Session>> {
        let changed = self.conn.execute(
            "update sessions
             set provider_id = ?1, provider_label = ?2, model_id = ?3, model_label = ?4, reasoning_effort = ?5
             where id = ?6",
            params![
                provider_id,
                provider_label,
                model_id,
                model_label,
                reasoning_effort,
                session_id.to_string(),
            ],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        self.get_session(session_id)
    }

    pub fn get_provider_session_binding(
        &self,
        session_id: Uuid,
        provider_id: &str,
    ) -> Result<Option<ProviderSessionBinding>> {
        self.conn
            .query_row(
                "select session_id, provider_id, model_id, model_label, reasoning_effort, resume_cursor_json, status, last_error, updated_at
                 from provider_session_bindings
                 where session_id = ?1 and provider_id = ?2",
                params![session_id.to_string(), provider_id],
                |row| row_to_provider_session_binding(row),
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn upsert_provider_session_binding(
        &self,
        session_id: Uuid,
        provider_id: impl Into<String>,
        model_id: Option<String>,
        model_label: Option<String>,
        reasoning_effort: Option<String>,
        resume_cursor_json: Value,
        status: impl Into<String>,
        last_error: Option<String>,
    ) -> Result<ProviderSessionBinding> {
        self.get_session(session_id)?
            .ok_or_else(|| anyhow!("unknown session {session_id}"))?;
        let provider_id = normalize_provider_binding_text("provider id", provider_id.into())?;
        let status = normalize_provider_binding_text("provider binding status", status.into())?;
        let resume_cursor_json = validate_provider_resume_cursor(resume_cursor_json)?;
        let resume_cursor_text = serde_json::to_string(&resume_cursor_json)?;
        let updated_at = Utc::now();

        self.conn.execute(
            "insert into provider_session_bindings
             (session_id, provider_id, model_id, model_label, reasoning_effort, resume_cursor_json, status, last_error, updated_at)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             on conflict(session_id, provider_id) do update set
               model_id = excluded.model_id,
               model_label = excluded.model_label,
               reasoning_effort = excluded.reasoning_effort,
               resume_cursor_json = excluded.resume_cursor_json,
               status = excluded.status,
               last_error = excluded.last_error,
               updated_at = excluded.updated_at",
            params![
                session_id.to_string(),
                provider_id,
                model_id,
                model_label,
                reasoning_effort,
                resume_cursor_text,
                status,
                last_error,
                updated_at.to_rfc3339(),
            ],
        )?;

        self.get_provider_session_binding(session_id, &provider_id)?
            .ok_or_else(|| anyhow!("provider session binding was not persisted"))
    }

    pub fn clear_provider_session_binding(
        &self,
        session_id: Uuid,
        provider_id: &str,
    ) -> Result<bool> {
        let changed = self.conn.execute(
            "delete from provider_session_bindings where session_id = ?1 and provider_id = ?2",
            params![session_id.to_string(), provider_id],
        )?;
        Ok(changed > 0)
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
        self.append_user_turn_message_with_turn_id(session_id, message, payload, Uuid::new_v4())
    }

    pub fn append_user_turn_message_with_turn_id(
        &self,
        session_id: Uuid,
        message: impl Into<String>,
        payload: Value,
        turn_id: Uuid,
    ) -> Result<SessionEvent> {
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
        let message = normalize_session_event_message(message)?;
        let payload = validate_session_event_payload(payload)?;
        let mut event = SessionEvent::new(session_id, kind, message, payload);
        event.turn_id = turn_id;
        let encoded = serde_json::to_string(&event)?;
        let events_path = self.session_events_path(session.id)?;
        let mut file = OpenOptions::new()
            .append(true)
            .create(true)
            .open(&events_path)
            .with_context(|| format!("open {}", events_path.display()))?;
        writeln!(file, "{encoded}")?;
        file.flush()?;
        file.sync_data()
            .with_context(|| format!("sync {}", events_path.display()))?;

        self.conn.execute(
            "update sessions set updated_at = ?1 where id = ?2",
            params![event.created_at.to_rfc3339(), session_id.to_string()],
        )?;
        Ok(event)
    }

    pub fn read_events(&self, session_id: Uuid) -> Result<Vec<SessionEvent>> {
        self.read_recent_events(session_id, MAX_SESSION_EVENTS_READ)
    }

    pub fn read_recent_events(
        &self,
        session_id: Uuid,
        max_recent_events: usize,
    ) -> Result<Vec<SessionEvent>> {
        let session = self
            .get_session(session_id)?
            .ok_or_else(|| anyhow!("unknown session {session_id}"))?;
        let events_path = self.session_events_path(session.id)?;

        if !events_path.exists() {
            return Ok(Vec::new());
        }

        let mut file = std::fs::File::open(&events_path)
            .with_context(|| format!("open {}", events_path.display()))?;
        let mut first_line = String::new();
        BufReader::new(file.try_clone()?).read_line(&mut first_line)?;
        let recent_lines = read_recent_event_lines(&mut file, max_recent_events)?;
        let mut events = recent_lines
            .iter()
            .enumerate()
            .filter_map(|(index, line)| {
                if line.is_empty() {
                    None
                } else {
                    Some(parse_session_event_line(&events_path, index, line))
                }
            })
            .collect::<Result<Vec<_>>>()?;
        if !first_line.trim().is_empty() {
            let first_event = parse_session_event_line(&events_path, 0, first_line.trim_end())?;
            if first_event.kind == SessionEventKind::SessionCreated
                && !events.iter().any(|item| item.id == first_event.id)
            {
                events.insert(0, first_event);
            }
        }
        Ok(events)
    }

    fn session_events_path(&self, session_id: Uuid) -> Result<PathBuf> {
        let path = self.paths.sessions_dir.join(format!("{session_id}.jsonl"));
        if let Ok(metadata) = std::fs::symlink_metadata(&path) {
            if metadata.file_type().is_symlink() {
                return Err(anyhow!("session event file cannot be a symlink"));
            }
        }
        Ok(path)
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
               reasoning_effort text,
               created_at text not null,
               updated_at text not null,
               events_path text not null
             );

             create index if not exists idx_sessions_updated_at
             on sessions(updated_at desc);

             create table if not exists provider_session_bindings (
               session_id text not null,
               provider_id text not null,
               model_id text,
               model_label text,
               reasoning_effort text,
               resume_cursor_json text not null,
               status text not null,
               last_error text,
               updated_at text not null,
               primary key (session_id, provider_id)
             );

             create index if not exists idx_provider_session_bindings_updated_at
             on provider_session_bindings(updated_at desc);",
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
        self.ensure_column("reasoning_effort", "reasoning_effort text")?;
        self.ensure_provider_binding_column("reasoning_effort", "reasoning_effort text")?;
        Ok(())
    }

    fn ensure_provider_binding_column(&self, column_name: &str, definition: &str) -> Result<()> {
        let mut stmt = self
            .conn
            .prepare("pragma table_info(provider_session_bindings)")?;
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        if columns.iter().any(|column| column == column_name) {
            return Ok(());
        }
        self.conn.execute_batch(&format!(
            "alter table provider_session_bindings add column {definition};"
        ))?;
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

fn read_recent_event_lines(file: &mut std::fs::File, max_lines: usize) -> Result<Vec<String>> {
    if max_lines == 0 {
        return Ok(Vec::new());
    }
    let file_len = file.seek(SeekFrom::End(0))?;
    if file_len == 0 {
        return Ok(Vec::new());
    }

    let mut chunks = Vec::new();
    let mut position = file_len;
    let mut newline_count = 0usize;
    while position > 0 && newline_count <= max_lines {
        let chunk_len = usize::try_from(position.min(SESSION_EVENT_TAIL_CHUNK_BYTES as u64))?;
        position -= chunk_len as u64;
        file.seek(SeekFrom::Start(position))?;
        let mut chunk = vec![0; chunk_len];
        file.read_exact(&mut chunk)?;
        newline_count += chunk.iter().filter(|byte| **byte == b'\n').count();
        chunks.push(chunk);
    }
    chunks.reverse();
    let mut bytes = chunks.into_iter().flatten().collect::<Vec<_>>();
    if position > 0 {
        if let Some(first_newline) = bytes.iter().position(|byte| *byte == b'\n') {
            bytes.drain(..=first_newline);
        } else {
            bytes.clear();
        }
    }

    let has_trailing_newline = bytes.last() == Some(&b'\n');
    let text = String::from_utf8(bytes).context("session event log is not valid UTF-8")?;
    let mut lines = text.lines().map(str::to_string).collect::<Vec<_>>();
    if !has_trailing_newline {
        if lines
            .last()
            .is_some_and(|line| serde_json::from_str::<SessionEvent>(line).is_err())
        {
            lines.pop();
        }
    }
    if lines.len() > max_lines {
        lines.drain(..lines.len() - max_lines);
    }
    Ok(lines)
}

fn row_to_provider_session_binding(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<ProviderSessionBinding> {
    let session_id: String = row.get(0)?;
    let provider_id: String = row.get(1)?;
    let model_id: Option<String> = row.get(2)?;
    let model_label: Option<String> = row.get(3)?;
    let reasoning_effort: Option<String> = row.get(4)?;
    let resume_cursor_json: String = row.get(5)?;
    let status: String = row.get(6)?;
    let last_error: Option<String> = row.get(7)?;
    let updated_at: String = row.get(8)?;

    Ok(ProviderSessionBinding {
        session_id: Uuid::parse_str(&session_id).map_err(parse_error)?,
        provider_id,
        model_id,
        model_label,
        reasoning_effort,
        resume_cursor_json: serde_json::from_str(&resume_cursor_json).map_err(parse_error)?,
        status,
        last_error,
        updated_at: DateTime::parse_from_rfc3339(&updated_at)
            .map_err(parse_error)?
            .with_timezone(&Utc),
    })
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
    let reasoning_effort: Option<String> = row.get(14)?;

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
        reasoning_effort,
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

fn parse_session_event_line(
    events_path: &Path,
    line_number: usize,
    line: &str,
) -> Result<SessionEvent> {
    serde_json::from_str::<SessionEvent>(line).with_context(|| {
        format!(
            "parse session event {} at line {}",
            events_path.display(),
            line_number + 1
        )
    })
}

fn normalize_session_title(title: impl Into<String>) -> Result<String> {
    let title = title.into().trim().to_string();
    if title.is_empty() {
        return Err(anyhow!("session title cannot be empty"));
    }
    if title.chars().count() > MAX_SESSION_TITLE_CHARS {
        return Err(anyhow!(
            "session title cannot exceed {MAX_SESSION_TITLE_CHARS} characters"
        ));
    }
    Ok(title)
}

fn normalize_session_event_message(message: impl Into<String>) -> Result<String> {
    let message = message.into().replace('\0', "");
    if message.chars().count() > MAX_SESSION_EVENT_MESSAGE_CHARS {
        return Err(anyhow!(
            "session event message cannot exceed {MAX_SESSION_EVENT_MESSAGE_CHARS} characters"
        ));
    }
    Ok(message)
}

fn validate_session_event_payload(payload: Value) -> Result<Value> {
    let encoded = serde_json::to_vec(&payload)?;
    if encoded.len() > MAX_SESSION_EVENT_PAYLOAD_BYTES {
        return Err(anyhow!(
            "session event payload cannot exceed {MAX_SESSION_EVENT_PAYLOAD_BYTES} bytes"
        ));
    }
    Ok(payload)
}

fn normalize_provider_binding_text(label: &str, value: String) -> Result<String> {
    let value = value.replace('\0', "").trim().to_string();
    if value.is_empty() {
        return Err(anyhow!("{label} cannot be empty"));
    }
    Ok(value)
}

fn validate_provider_resume_cursor(cursor: Value) -> Result<Value> {
    crate::harness::validate_provider_resume_cursor_value(cursor)
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
    fn appends_user_turn_messages_with_existing_turn_identity() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "turn session")
            .unwrap();
        let turn_id = Uuid::new_v4();

        let event = store
            .append_user_turn_message_with_turn_id(
                session.id,
                "inspect this",
                serde_json::json!({ "surface": "desktop" }),
                turn_id,
            )
            .unwrap();

        assert_eq!(event.turn_id, Some(turn_id));
        assert_eq!(event.payload["turnId"], turn_id.to_string());
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
    fn reads_recent_events_without_parsing_full_history() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "long session")
            .unwrap();

        for index in 0..12 {
            store
                .append_event(
                    session.id,
                    SessionEventKind::UserMessage,
                    format!("message {index}"),
                    serde_json::json!({ "index": index }),
                )
                .unwrap();
        }

        let events = store.read_recent_events(session.id, 3).unwrap();
        assert_eq!(events.len(), 4);
        assert_eq!(events[0].kind, SessionEventKind::SessionCreated);
        assert_eq!(events[1].message, "message 9");
        assert_eq!(events[2].message, "message 10");
        assert_eq!(events[3].message, "message 11");
    }

    #[test]
    fn recovers_events_before_an_interrupted_trailing_write() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "recover session")
            .unwrap();
        store
            .append_event(
                session.id,
                SessionEventKind::UserMessage,
                "durable message",
                serde_json::json!({ "source": "test" }),
            )
            .unwrap();
        let mut file = OpenOptions::new()
            .append(true)
            .open(&session.events_path)
            .unwrap();
        file.write_all(br#"{"id":"interrupted""#).unwrap();
        file.flush().unwrap();

        let events = store.read_events(session.id).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].message, "durable message");
    }

    #[test]
    fn reports_corrupt_complete_event_lines() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "corrupt session")
            .unwrap();
        let mut file = OpenOptions::new()
            .append(true)
            .open(&session.events_path)
            .unwrap();
        file.write_all(b"not-json\n").unwrap();
        file.flush().unwrap();

        assert!(store.read_events(session.id).is_err());
    }

    #[test]
    fn measures_long_session_tail_loading_against_full_scan() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "long benchmark")
            .unwrap();
        let mut writer = std::io::BufWriter::new(
            OpenOptions::new()
                .append(true)
                .open(&session.events_path)
                .unwrap(),
        );
        for index in 0..50_000 {
            let event = SessionEvent::new(
                session.id,
                SessionEventKind::AssistantMessage,
                format!("event {index}"),
                serde_json::json!({ "index": index }),
            );
            writeln!(writer, "{}", serde_json::to_string(&event).unwrap()).unwrap();
        }
        writer.flush().unwrap();

        let full_scan_started = std::time::Instant::now();
        let mut old_recent = std::collections::VecDeque::with_capacity(1_001);
        for line in BufReader::new(std::fs::File::open(&session.events_path).unwrap()).lines() {
            old_recent.push_back(line.unwrap());
            if old_recent.len() > 1_000 {
                old_recent.pop_front();
            }
        }
        let old_recent = old_recent
            .iter()
            .map(|line| serde_json::from_str::<SessionEvent>(line).unwrap())
            .collect::<Vec<_>>();
        let full_scan_elapsed = full_scan_started.elapsed();

        let tail_started = std::time::Instant::now();
        let tail = store.read_recent_events(session.id, 1_000).unwrap();
        let tail_elapsed = tail_started.elapsed();

        assert_eq!(old_recent.len(), 1_000);
        assert_eq!(old_recent.last().unwrap().message, "event 49999");
        assert_eq!(tail.len(), 1_001);
        assert_eq!(tail.last().unwrap().message, "event 49999");
        eprintln!(
            "long-session-load full-scan={}us tail-read={}us events=50001 retained=1001",
            full_scan_elapsed.as_micros(),
            tail_elapsed.as_micros()
        );
    }

    #[test]
    fn rejects_oversized_session_event_messages() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "bounded session")
            .unwrap();
        let message = "a".repeat(MAX_SESSION_EVENT_MESSAGE_CHARS + 1);

        let error = store
            .append_event(
                session.id,
                SessionEventKind::UserMessage,
                message,
                serde_json::json!({ "source": "test" }),
            )
            .unwrap_err();

        assert!(error.to_string().contains("session event message"));
    }

    #[test]
    fn ignores_tampered_session_event_paths_for_writes() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "path session")
            .unwrap();
        let outside_path = temp.path().join("outside.jsonl");
        store
            .conn
            .execute(
                "update sessions set events_path = ?1 where id = ?2",
                rusqlite::params![outside_path.to_string_lossy(), session.id.to_string()],
            )
            .unwrap();

        store
            .append_event(
                session.id,
                SessionEventKind::UserMessage,
                "hello",
                serde_json::json!({ "source": "test" }),
            )
            .unwrap();

        assert!(!outside_path.exists());
        assert!(store
            .paths
            .sessions_dir
            .join(format!("{}.jsonl", session.id))
            .exists());
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
                    reasoning_effort: Some("high".into()),
                    ..CreateSessionContext::default()
                },
            )
            .unwrap();

        let stored = store.get_session(session.id).unwrap().unwrap();
        assert_eq!(stored.provider_id.as_deref(), Some("openai"));
        assert_eq!(stored.provider_label.as_deref(), Some("OpenAI"));
        assert_eq!(stored.model_id.as_deref(), Some("gpt-5.5"));
        assert_eq!(stored.model_label.as_deref(), Some("GPT-5.5"));
        assert_eq!(stored.reasoning_effort.as_deref(), Some("high"));

        let updated = store
            .update_session_model(
                session.id,
                Some("anthropic".into()),
                Some("Anthropic".into()),
                Some("claude-sonnet-5".into()),
                Some("Claude Sonnet 5".into()),
                None,
            )
            .unwrap()
            .unwrap();
        assert_eq!(updated.provider_id.as_deref(), Some("anthropic"));
        assert_eq!(updated.model_id.as_deref(), Some("claude-sonnet-5"));
        assert_eq!(updated.updated_at, stored.updated_at);
    }

    #[test]
    fn stores_updates_and_clears_provider_session_bindings() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "binding session")
            .unwrap();

        let binding = store
            .upsert_provider_session_binding(
                session.id,
                "openai",
                Some("gpt-5.5".into()),
                Some("GPT-5.5".into()),
                Some("high".into()),
                serde_json::json!({ "kind": "codex-session", "sessionId": Uuid::new_v4() }),
                "ready",
                None,
            )
            .unwrap();
        assert_eq!(binding.session_id, session.id);
        assert_eq!(binding.provider_id, "openai");
        assert_eq!(binding.status, "ready");
        assert_eq!(binding.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(binding.resume_cursor_json["kind"], "codex-session");

        let updated = store
            .upsert_provider_session_binding(
                session.id,
                "openai",
                Some("gpt-5.4".into()),
                Some("GPT-5.4".into()),
                Some("medium".into()),
                serde_json::json!({ "kind": "codex-session", "sessionId": Uuid::new_v4() }),
                "failed",
                Some("stale cursor".into()),
            )
            .unwrap();
        assert_eq!(updated.model_id.as_deref(), Some("gpt-5.4"));
        assert_eq!(updated.last_error.as_deref(), Some("stale cursor"));

        assert!(store
            .clear_provider_session_binding(session.id, "openai")
            .unwrap());
        assert!(store
            .get_provider_session_binding(session.id, "openai")
            .unwrap()
            .is_none());
    }

    #[test]
    fn rejects_oversized_provider_resume_cursors() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "binding session")
            .unwrap();

        let error = store
            .upsert_provider_session_binding(
                session.id,
                "openai",
                None,
                None,
                None,
                serde_json::json!({ "kind": "codex-session", "blob": "a".repeat(crate::harness::MAX_HARNESS_RESUME_CURSOR_BYTES + 1) }),
                "ready",
                None,
            )
            .unwrap_err();

        assert!(error.to_string().contains("provider resume cursor"));
    }

    #[test]
    fn deleting_session_clears_provider_session_bindings() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "binding session")
            .unwrap();

        store
            .upsert_provider_session_binding(
                session.id,
                "openai",
                None,
                None,
                None,
                serde_json::json!({ "kind": "codex-session", "sessionId": Uuid::new_v4() }),
                "ready",
                None,
            )
            .unwrap();

        assert!(store.delete_session(session.id).unwrap());
        assert!(store
            .get_provider_session_binding(session.id, "openai")
            .unwrap()
            .is_none());
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
        assert_eq!(renamed.updated_at, session.updated_at);
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
