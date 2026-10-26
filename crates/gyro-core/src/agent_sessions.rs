//! Local inbox an external agent uses to start one Gyro session.
//!
//! The loopback server accepts the task and opens the session before it
//! returns. It does not run a provider. A desktop worker claims the row later.

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use uuid::Uuid;

use crate::mutations::{decide_mutation_proposal, MutationDecision};
use crate::paths::{secure_private_file, GyroPaths};
use crate::security::redact_secrets;
use crate::sessions::{
    CreateSessionContext, MutationProposalOperation, SessionEventKind, SessionOrigin, SessionStore,
    SessionWorkspaceMode,
};

const TOKEN_FILE: &str = "agent-session.token";
const ENDPOINT_FILE: &str = "agent-session-endpoint.json";
const TOKEN_HEX_LEN: usize = 64;
const MAX_PROMPT_CHARS: usize = 32_000;
/// Characters of user and assistant text one `read_session` page may return.
const MAX_READ_CHARS: usize = 32_000;
const MAX_SUMMARY_CHARS: usize = 4_000;
const MAX_HTTP_BODY: usize = 1024 * 1024;

/// Provider, model, and effort the user has enabled.
///
/// The desktop app writes this snapshot. Core does not invent a provider.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceCatalog {
    pub selected_provider_id: Option<String>,
    pub providers: Vec<ProviderChoices>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderChoices {
    pub id: String,
    pub label: String,
    pub default_model: Option<String>,
    pub default_effort: Option<String>,
    pub models: Vec<ModelChoices>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoices {
    pub id: String,
    pub label: String,
    pub efforts: Vec<String>,
}

#[derive(Clone, Debug, Default)]
pub struct ChoiceRequest {
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub reasoning_effort: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedChoice {
    pub provider_id: String,
    pub provider_label: String,
    pub model_id: String,
    pub model_label: String,
    pub reasoning_effort: Option<String>,
}

/// Approvals stay on for an agent-started session.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AgentSessionRunPolicy {
    pub require_command_approval: bool,
    pub require_file_edit_approval: bool,
    pub full_access: bool,
}

pub fn agent_session_run_policy() -> AgentSessionRunPolicy {
    AgentSessionRunPolicy {
        require_command_approval: true,
        require_file_edit_approval: true,
        full_access: false,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentSessionState {
    Queued,
    Running,
    Done,
    Failed,
}

impl AgentSessionState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Done => "done",
            Self::Failed => "failed",
        }
    }

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "queued" => Ok(Self::Queued),
            "running" => Ok(Self::Running),
            "done" => Ok(Self::Done),
            "failed" => Ok(Self::Failed),
            _ => Err(anyhow!("unknown agent session status {value}")),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentReportStatus {
    Queued,
    Running,
    WaitingForApproval,
    Done,
    Failed,
}

impl AgentReportStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::WaitingForApproval => "waiting-for-approval",
            Self::Done => "done",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug)]
pub struct AgentSessionRow {
    pub id: Uuid,
    pub session_id: Option<Uuid>,
    pub turn_id: Option<Uuid>,
    pub workspace_path: PathBuf,
    pub prompt: String,
    pub state: AgentSessionState,
    pub provider_id: String,
    pub provider_label: String,
    pub model_id: String,
    pub model_label: String,
    pub reasoning_effort: Option<String>,
    pub summary: Option<String>,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionReport {
    pub session_id: Option<Uuid>,
    pub inbox_id: Uuid,
    pub status: String,
    pub provider_id: String,
    pub provider_label: String,
    pub model_id: String,
    pub model_label: String,
    pub reasoning_effort: Option<String>,
    pub summary: Option<String>,
    pub error: Option<String>,
    /// What a running session is blocked on, so the caller can hand it to a person.
    pub pending_approval: Option<AgentPendingApproval>,
}

/// One approval a session is waiting for, named so the calling agent can report it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPendingApproval {
    pub proposal_id: Uuid,
    pub tool: String,
    pub summary: String,
    pub requested_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionListItem {
    pub session_id: Option<Uuid>,
    pub inbox_id: Uuid,
    pub workspace: String,
    pub status: String,
    pub title: String,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionTurn {
    pub id: Uuid,
    pub role: String,
    pub text: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionRead {
    #[serde(flatten)]
    pub report: AgentSessionReport,
    pub turns: Vec<AgentSessionTurn>,
    pub has_more: bool,
}

#[derive(Clone, Debug)]
pub struct AgentControl {
    pub inbox_id: Uuid,
    pub session_id: Option<Uuid>,
    pub status: String,
}

fn stop_hook_slot() -> &'static Mutex<Option<Arc<dyn Fn(Uuid) + Send + Sync>>> {
    static HOOK: OnceLock<Mutex<Option<Arc<dyn Fn(Uuid) + Send + Sync>>>> = OnceLock::new();
    HOOK.get_or_init(|| Mutex::new(None))
}

/// Desktop registers this so a running provider turn can be cancelled from MCP.
pub fn set_session_stop_hook(hook: Arc<dyn Fn(Uuid) + Send + Sync>) {
    if let Ok(mut slot) = stop_hook_slot().lock() {
        *slot = Some(hook);
    }
}

fn invoke_stop_hook(session_id: Uuid) {
    let hook = stop_hook_slot().lock().ok().and_then(|slot| slot.clone());
    if let Some(hook) = hook {
        hook(session_id);
    }
}

/// A Mac that dials a public relay. The credential itself stays in the keychain.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPairing {
    pub device_id: Uuid,
    pub relay_url: String,
    pub paired_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolledRelayTask {
    pub relay_task_id: String,
    pub session_id: Uuid,
    pub inbox_id: Uuid,
}

pub struct AgentSessionStore {
    paths: GyroPaths,
    conn: Connection,
}

impl AgentSessionStore {
    pub fn open(paths: GyroPaths) -> Result<Self> {
        paths.ensure()?;
        let conn = crate::sqlite::open_private_database(&paths.database_path)
            .with_context(|| format!("open {}", paths.database_path.display()))?;
        secure_private_file(&paths.database_path)?;
        let store = Self { paths, conn };
        store.initialize()?;
        Ok(store)
    }

    pub fn paths(&self) -> &GyroPaths {
        &self.paths
    }

    fn initialize(&self) -> Result<()> {
        self.conn.execute_batch(
            "create table if not exists agent_choice_catalog (
               id integer primary key check (id = 1),
               catalog_json text not null
             );
             create table if not exists agent_session_allow (
               workspace_path text primary key
             );
             create table if not exists agent_pairing (
               id integer primary key check (id = 1),
               device_id text not null,
               relay_url text not null,
               paired_at text not null
             );
             create table if not exists agent_relay_tasks (
               relay_task_id text primary key,
               session_id text,
               accepted integer not null,
               created_at text not null
             );
             create table if not exists agent_sessions (
               id text primary key,
               session_id text,
               turn_id text,
               workspace_path text not null,
               prompt text not null,
               status text not null,
               provider_id text not null,
               provider_label text not null,
               model_id text not null,
               model_label text not null,
               reasoning_effort text,
               summary text,
               error text,
               created_at text not null,
               updated_at text not null
             );
             create table if not exists agent_command_blocks (
               proposal_id text primary key,
               inbox_id text not null,
               summary text not null,
               requested_at text not null
             );
             create table if not exists agent_relay_command_acks (
               command_id text primary key
             );",
        )?;
        Ok(())
    }

    pub fn set_choice_catalog(&self, catalog: &ChoiceCatalog) -> Result<()> {
        let encoded = serde_json::to_string(catalog)?;
        self.conn.execute(
            "insert into agent_choice_catalog (id, catalog_json) values (1, ?1)
             on conflict(id) do update set catalog_json = excluded.catalog_json",
            params![encoded],
        )?;
        Ok(())
    }

    pub fn choice_catalog(&self) -> Result<ChoiceCatalog> {
        let encoded: Option<String> = self
            .conn
            .query_row(
                "select catalog_json from agent_choice_catalog where id = 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        match encoded {
            Some(encoded) => Ok(serde_json::from_str(&encoded)?),
            None => Ok(ChoiceCatalog::default()),
        }
    }

    pub fn allow_workspace(&self, workspace: &Path) -> Result<PathBuf> {
        let canonical = canonical_workspace(workspace)?;
        self.conn.execute(
            "insert into agent_session_allow (workspace_path) values (?1)
             on conflict(workspace_path) do nothing",
            params![canonical.display().to_string()],
        )?;
        Ok(canonical)
    }

    pub fn list_workspaces(&self) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("select workspace_path from agent_session_allow order by workspace_path")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }
}

/// When the allowlist is empty, adopt one workspace the user already opened.
///
/// A start request is refused until a workspace is allowed. The installed CLI
/// may not have `gyro agent-session allow` yet, and the desktop app already
/// knows the folders its own chats use. A manual allowlist is left unchanged.
pub fn allow_latest_session_workspace(paths: &GyroPaths) -> Result<Option<PathBuf>> {
    let store = AgentSessionStore::open(paths.clone())?;
    if !store.list_workspaces()?.is_empty() {
        return Ok(None);
    }
    let sessions = SessionStore::open(paths.clone())?;
    let listed = sessions.list_sessions_limited(Some(40))?;
    let Some(workspace) = listed.into_iter().find_map(|session| {
        if session.parent_session_id.is_some() || !session.workspace_path.is_dir() {
            return None;
        }
        Some(session.workspace_path)
    }) else {
        return Ok(None);
    };
    Ok(Some(store.allow_workspace(&workspace)?))
}

impl AgentSessionStore {
    pub fn start_session(
        &self,
        workspace: &Path,
        prompt: &str,
        choice: ChoiceRequest,
    ) -> Result<AgentSessionRow> {
        let prompt = prompt.trim();
        if prompt.is_empty() {
            return Err(anyhow!("prompt cannot be empty"));
        }
        if prompt.chars().count() > MAX_PROMPT_CHARS {
            return Err(anyhow!(
                "prompt cannot exceed {MAX_PROMPT_CHARS} characters"
            ));
        }
        let catalog = self.choice_catalog()?;
        let resolved = resolve_choice(&catalog, &choice)?;
        let canonical = canonical_workspace(workspace)?;
        let allowed = self.list_workspaces()?;
        if !allowed
            .iter()
            .any(|path| path == &canonical.display().to_string())
        {
            return Err(anyhow!("workspace is not allowed"));
        }

        let sessions = SessionStore::open(self.paths.clone())?;
        let session = sessions.create_session_with_context(
            &canonical,
            SessionOrigin::Desktop,
            agent_session_title(prompt),
            CreateSessionContext {
                workspace_mode: SessionWorkspaceMode::Local,
                branch: "main".into(),
                provider_id: Some(resolved.provider_id.clone()),
                provider_label: Some(resolved.provider_label.clone()),
                model_id: Some(resolved.model_id.clone()),
                model_label: Some(resolved.model_label.clone()),
                reasoning_effort: resolved.reasoning_effort.clone(),
                ..CreateSessionContext::default()
            },
        )?;
        let event = sessions.append_user_turn_message(
            session.id,
            prompt,
            json!({ "surface": "agent-session" }),
        )?;

        let now = Utc::now();
        let id = Uuid::new_v4();
        self.conn.execute(
            "insert into agent_sessions (
               id, session_id, turn_id, workspace_path, prompt, status,
               provider_id, provider_label, model_id, model_label, reasoning_effort,
               summary, error, created_at, updated_at
             ) values (?1, ?2, ?3, ?4, ?5, 'queued', ?6, ?7, ?8, ?9, ?10, null, null, ?11, ?12)",
            params![
                id.to_string(),
                session.id.to_string(),
                event.turn_id.map(|turn| turn.to_string()),
                canonical.display().to_string(),
                prompt,
                resolved.provider_id,
                resolved.provider_label,
                resolved.model_id,
                resolved.model_label,
                resolved.reasoning_effort,
                now.to_rfc3339(),
                now.to_rfc3339(),
            ],
        )?;
        self.get(id)?
            .ok_or_else(|| anyhow!("agent session was not persisted"))
    }

    pub fn get(&self, id: Uuid) -> Result<Option<AgentSessionRow>> {
        self.conn
            .query_row(
                "select id, session_id, turn_id, workspace_path, prompt, status,
                        provider_id, provider_label, model_id, model_label, reasoning_effort,
                        summary, error, created_at, updated_at
                 from agent_sessions
                 where id = ?1 or session_id = ?1",
                params![id.to_string()],
                row_to_agent_session,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn report(&self, id: Uuid) -> Result<AgentSessionReport> {
        let row = self
            .get(id)?
            .ok_or_else(|| anyhow!("unknown session {id}"))?;
        let mut status = match row.state {
            AgentSessionState::Queued => AgentReportStatus::Queued,
            AgentSessionState::Running => AgentReportStatus::Running,
            AgentSessionState::Done => AgentReportStatus::Done,
            AgentSessionState::Failed => AgentReportStatus::Failed,
        };
        let mut pending_approval = None;
        if status == AgentReportStatus::Running {
            if let Some(session_id) = row.session_id {
                let sessions = SessionStore::open(self.paths.clone())?;
                if let Some(proposal) = sessions
                    .list_pending_mutation_proposals(session_id)?
                    .into_iter()
                    .next()
                {
                    let verb = match proposal.operation {
                        MutationProposalOperation::Create => "create",
                        MutationProposalOperation::Update => "update",
                    };
                    status = AgentReportStatus::WaitingForApproval;
                    pending_approval = Some(AgentPendingApproval {
                        proposal_id: proposal.id,
                        tool: verb.to_string(),
                        summary: format!("{verb} {}", proposal.path),
                        requested_at: proposal.created_at,
                    });
                }
            }
        }
        if pending_approval.is_none() && status == AgentReportStatus::Running {
            if let Some(block) = self.command_block_for_inbox(row.id)? {
                status = AgentReportStatus::WaitingForApproval;
                pending_approval = Some(block);
            }
        }
        Ok(AgentSessionReport {
            session_id: row.session_id,
            inbox_id: row.id,
            status: status.as_str().into(),
            provider_id: row.provider_id,
            provider_label: row.provider_label,
            model_id: row.model_id,
            model_label: row.model_label,
            reasoning_effort: row.reasoning_effort,
            summary: row.summary,
            error: row.error,
            pending_approval,
        })
    }

    /// Claim the oldest queued session whose workspace is not already running.
    pub fn claim_next(&self) -> Result<Option<AgentSessionRow>> {
        let now = Utc::now().to_rfc3339();
        let transaction = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        transaction.execute(
            "update agent_sessions
             set status = 'failed', error = 'session was not opened', updated_at = ?1
             where status = 'queued' and session_id is null",
            params![now],
        )?;
        let id: Option<String> = transaction
            .query_row(
                "select id from agent_sessions
                 where status = 'queued' and session_id is not null
                   and workspace_path not in (
                     select workspace_path from agent_sessions where status = 'running'
                   )
                 order by created_at asc
                 limit 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let Some(id) = id else {
            transaction.commit()?;
            return Ok(None);
        };
        let changed = transaction.execute(
            "update agent_sessions set status = 'running', updated_at = ?1
             where id = ?2 and status = 'queued'",
            params![now, id],
        )?;
        transaction.commit()?;
        if changed != 1 {
            return Ok(None);
        }
        self.get(Uuid::parse_str(&id)?)
    }

    pub fn finish(&self, id: Uuid, outcome: std::result::Result<String, String>) -> Result<bool> {
        let now = Utc::now().to_rfc3339();
        let (status, summary, error) = match outcome {
            Ok(summary) => ("done", Some(bounded_agent_summary(&summary)), None),
            Err(error) => ("failed", None, Some(bounded_agent_summary(&error))),
        };
        let changed = self.conn.execute(
            "update agent_sessions
             set status = ?1, summary = ?2, error = ?3, updated_at = ?4
             where id = ?5 and status = 'running'",
            params![status, summary, error, now, id.to_string()],
        )?;
        Ok(changed == 1)
    }

    /// Fail rows a dead process left running. Call this from listener start only.
    pub fn recover_interrupted(&self) -> Result<usize> {
        let now = Utc::now().to_rfc3339();
        let changed = self.conn.execute(
            "update agent_sessions
             set status = 'failed', error = 'interrupted before the session finished', updated_at = ?1
             where status = 'running'",
            params![now],
        )?;
        Ok(changed)
    }

    pub fn revoke_queued_work(&self) -> Result<usize> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "update agent_sessions
             set status = 'failed', error = 'revoked', updated_at = ?1
             where status = 'running'",
            params![now],
        )?;
        let deleted = self
            .conn
            .execute("delete from agent_sessions where status = 'queued'", [])?;
        Ok(deleted)
    }

    /// Withdraw one session the desktop has not started yet.
    ///
    /// A session Gyro already claimed belongs to the desktop, so stopping that
    /// one is the window's job, not the calling agent's.
    pub fn cancel(&self, id: Uuid) -> Result<()> {
        let row = self
            .get(id)?
            .ok_or_else(|| anyhow::anyhow!("unknown session"))?;
        if row.state != AgentSessionState::Queued {
            anyhow::bail!("Gyro already started this session; stop it in Gyro");
        }
        let removed = self.conn.execute(
            "delete from agent_sessions where id = ?1 and status = 'queued'",
            params![row.id.to_string()],
        )?;
        if removed == 0 {
            anyhow::bail!("Gyro already started this session; stop it in Gyro");
        }
        Ok(())
    }

    pub fn list_sessions(
        &self,
        limit: usize,
        before: Option<DateTime<Utc>>,
    ) -> Result<Vec<AgentSessionListItem>> {
        let limit = limit.clamp(1, 50);
        let before = before.map(|time| time.to_rfc3339());
        let mut statement = self.conn.prepare(
            "select id from agent_sessions
             where ?1 is null or updated_at < ?1
             order by updated_at desc
             limit ?2",
        )?;
        let ids = statement.query_map(params![before, limit as i64], |row| {
            row.get::<_, String>(0)
        })?;
        let mut items = Vec::new();
        for id in ids {
            let id = Uuid::parse_str(&id?)?;
            let Some(row) = self.get(id)? else {
                continue;
            };
            let report = self.report(row.id)?;
            items.push(AgentSessionListItem {
                session_id: row.session_id,
                inbox_id: row.id,
                workspace: row.workspace_path.display().to_string(),
                status: report.status,
                title: agent_session_title(&row.prompt),
                updated_at: row.updated_at,
            });
        }
        Ok(items)
    }

    pub fn read_session(
        &self,
        id: Uuid,
        after: Option<Uuid>,
        limit: usize,
    ) -> Result<AgentSessionRead> {
        let report = self.report(id)?;
        let session_id = report
            .session_id
            .ok_or_else(|| anyhow!("session was not opened"))?;
        let sessions = SessionStore::open(self.paths.clone())?;
        let limit = limit.clamp(1, 20);
        let mut turns = Vec::new();
        let mut chars = 0usize;
        let mut stopped_early = false;
        let mut passed_cursor = after.is_none();
        // A page is at most 20 turns. Stop once that page is decided so the
        // rest of a long transcript, including a later oversized line, is not
        // read or decoded.
        sessions.visit_transcript_events(session_id, |event| {
            if !matches!(
                event.kind,
                SessionEventKind::UserMessage | SessionEventKind::AssistantMessage
            ) {
                return true;
            }
            if !passed_cursor {
                if after == Some(event.id) {
                    passed_cursor = true;
                }
                return true;
            }
            if turns.len() == limit {
                stopped_early = true;
                return false;
            }
            let text = redact_secrets(&event.message);
            let text_chars = text.chars().count();
            if chars.saturating_add(text_chars) > MAX_READ_CHARS && !turns.is_empty() {
                stopped_early = true;
                return false;
            }
            let (text, counted) = if text_chars > MAX_READ_CHARS {
                let mut bounded: String = text.chars().take(MAX_READ_CHARS - 1).collect();
                bounded.push('\u{2026}');
                let counted = bounded.chars().count();
                (bounded, counted)
            } else {
                (text, text_chars)
            };
            chars = chars.saturating_add(counted);
            turns.push(AgentSessionTurn {
                id: event.id,
                role: if event.kind == SessionEventKind::UserMessage {
                    "user"
                } else {
                    "assistant"
                }
                .to_string(),
                text,
                created_at: event.created_at,
            });
            true
        })?;
        if after.is_some() && !passed_cursor {
            return Err(anyhow!("unknown cursor"));
        }
        Ok(AgentSessionRead {
            report,
            turns,
            has_more: stopped_early,
        })
    }

    pub fn continue_session(
        &self,
        id: Uuid,
        prompt: &str,
        choice: ChoiceRequest,
    ) -> Result<AgentSessionRow> {
        let prompt = prompt.trim();
        if prompt.is_empty() {
            return Err(anyhow!("prompt cannot be empty"));
        }
        if prompt.chars().count() > MAX_PROMPT_CHARS {
            return Err(anyhow!(
                "prompt cannot exceed {MAX_PROMPT_CHARS} characters"
            ));
        }
        let row = self
            .get(id)?
            .ok_or_else(|| anyhow!("unknown session"))?;
        if matches!(
            row.state,
            AgentSessionState::Queued | AgentSessionState::Running
        ) {
            return Err(anyhow!("session is still {}", row.state.as_str()));
        }
        let running: i64 = self.conn.query_row(
            "select count(*) from agent_sessions
             where workspace_path = ?1 and status = 'running'",
            params![row.workspace_path.display().to_string()],
            |row| row.get(0),
        )?;
        if running > 0 {
            return Err(anyhow!("workspace already has a running session"));
        }
        let canonical = canonical_workspace(&row.workspace_path)?;
        let allowed = self.list_workspaces()?;
        if !allowed
            .iter()
            .any(|path| path == &canonical.display().to_string())
        {
            return Err(anyhow!("workspace is not allowed"));
        }
        let catalog = self.choice_catalog()?;
        let resolved = resolve_choice(&catalog, &choice)?;
        let session_id = row
            .session_id
            .ok_or_else(|| anyhow!("session was not opened"))?;
        let sessions = SessionStore::open(self.paths.clone())?;
        let event = sessions.append_user_turn_message(
            session_id,
            prompt,
            json!({ "surface": "agent-session" }),
        )?;
        let now = Utc::now().to_rfc3339();
        let changed = self.conn.execute(
            "update agent_sessions
             set prompt = ?1, turn_id = ?2, status = 'queued', summary = null, error = null,
                 provider_id = ?3, provider_label = ?4, model_id = ?5, model_label = ?6,
                 reasoning_effort = ?7, updated_at = ?8
             where id = ?9 and status in ('done', 'failed')",
            params![
                prompt,
                event.turn_id.map(|turn| turn.to_string()),
                resolved.provider_id,
                resolved.provider_label,
                resolved.model_id,
                resolved.model_label,
                resolved.reasoning_effort,
                now,
                row.id.to_string(),
            ],
        )?;
        if changed != 1 {
            return Err(anyhow!("session is still running"));
        }
        self.clear_command_blocks_for_inbox(row.id)?;
        self.get(row.id)?
            .ok_or_else(|| anyhow!("agent session was not persisted"))
    }

    pub fn stop_session(&self, id: Uuid) -> Result<AgentControl> {
        let row = self
            .get(id)?
            .ok_or_else(|| anyhow!("unknown session"))?;
        match row.state {
            AgentSessionState::Queued => {
                self.cancel(row.id)?;
                Ok(AgentControl {
                    inbox_id: row.id,
                    session_id: row.session_id,
                    status: "cancelled".into(),
                })
            }
            AgentSessionState::Running => {
                let now = Utc::now().to_rfc3339();
                let changed = self.conn.execute(
                    "update agent_sessions
                     set status = 'failed', summary = null, error = 'stopped', updated_at = ?1
                     where id = ?2 and status = 'running'",
                    params![now, row.id.to_string()],
                )?;
                self.clear_command_blocks_for_inbox(row.id)?;
                if changed == 1 {
                    if let Some(session_id) = row.session_id {
                        invoke_stop_hook(session_id);
                    }
                    return Ok(AgentControl {
                        inbox_id: row.id,
                        session_id: row.session_id,
                        status: "stopped".into(),
                    });
                }
                let current = self
                    .get(row.id)?
                    .ok_or_else(|| anyhow!("unknown session"))?;
                Ok(AgentControl {
                    inbox_id: current.id,
                    session_id: current.session_id,
                    status: current.state.as_str().into(),
                })
            }
            AgentSessionState::Done | AgentSessionState::Failed => Ok(AgentControl {
                inbox_id: row.id,
                session_id: row.session_id,
                status: row.state.as_str().into(),
            }),
        }
    }

    pub fn note_command_block(
        &self,
        session_id: Uuid,
        proposal_id: Uuid,
        summary: &str,
    ) -> Result<bool> {
        let inbox_id: Option<String> = self
            .conn
            .query_row(
                "select id from agent_sessions where session_id = ?1 and status = 'running'",
                params![session_id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        let Some(inbox_id) = inbox_id else {
            return Ok(false);
        };
        self.conn.execute(
            "insert into agent_command_blocks (proposal_id, inbox_id, summary, requested_at)
             values (?1, ?2, ?3, ?4)
             on conflict(proposal_id) do update set
               inbox_id = excluded.inbox_id,
               summary = excluded.summary,
               requested_at = excluded.requested_at",
            params![
                proposal_id.to_string(),
                inbox_id,
                bounded_agent_summary(summary),
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(true)
    }

    pub fn clear_command_block_for_session(&self, session_id: Uuid) -> Result<()> {
        self.conn.execute(
            "delete from agent_command_blocks
             where inbox_id in (
               select id from agent_sessions where session_id = ?1
             )",
            params![session_id.to_string()],
        )?;
        Ok(())
    }

    pub fn deny_approval(&self, proposal_id: Uuid) -> Result<AgentControl> {
        let inbox_id: Option<String> = self
            .conn
            .query_row(
                "select inbox_id from agent_command_blocks where proposal_id = ?1",
                params![proposal_id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(inbox_id) = inbox_id {
            let inbox_id = Uuid::parse_str(&inbox_id)?;
            return self.stop_session(inbox_id);
        }
        let sessions = SessionStore::open(self.paths.clone())?;
        decide_mutation_proposal(&sessions, proposal_id, MutationDecision::Reject)?;
        Ok(AgentControl {
            inbox_id: proposal_id,
            session_id: None,
            status: "denied".into(),
        })
    }

    fn clear_command_blocks_for_inbox(&self, inbox_id: Uuid) -> Result<()> {
        self.conn.execute(
            "delete from agent_command_blocks where inbox_id = ?1",
            params![inbox_id.to_string()],
        )?;
        Ok(())
    }

    fn command_block_for_inbox(&self, inbox_id: Uuid) -> Result<Option<AgentPendingApproval>> {
        self.conn
            .query_row(
                "select proposal_id, summary, requested_at
                 from agent_command_blocks where inbox_id = ?1",
                params![inbox_id.to_string()],
                |row| {
                    Ok(AgentPendingApproval {
                        proposal_id: Uuid::parse_str(&row.get::<_, String>(0)?).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                0,
                                rusqlite::types::Type::Text,
                                error.into(),
                            )
                        })?,
                        tool: "command".into(),
                        summary: row.get(1)?,
                        requested_at: parse_time(row.get(2)?)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn pairing(&self) -> Result<Option<AgentPairing>> {
        self.conn
            .query_row(
                "select device_id, relay_url, paired_at from agent_pairing where id = 1",
                [],
                |row| {
                    Ok(AgentPairing {
                        device_id: Uuid::parse_str(&row.get::<_, String>(0)?).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                0,
                                rusqlite::types::Type::Text,
                                error.into(),
                            )
                        })?,
                        relay_url: row.get(1)?,
                        paired_at: parse_time(row.get(2)?)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    fn save_pairing(
        &self,
        device_id: Uuid,
        relay_url: &str,
        paired_at: DateTime<Utc>,
    ) -> Result<()> {
        self.conn.execute(
            "insert into agent_pairing (id, device_id, relay_url, paired_at)
             values (1, ?1, ?2, ?3)
             on conflict(id) do update set
               device_id = excluded.device_id,
               relay_url = excluded.relay_url,
               paired_at = excluded.paired_at",
            params![device_id.to_string(), relay_url, paired_at.to_rfc3339()],
        )?;
        Ok(())
    }

    fn clear_pairing(&self) -> Result<()> {
        self.conn.execute("delete from agent_pairing", [])?;
        self.conn.execute("delete from agent_relay_tasks", [])?;
        Ok(())
    }

    /// Returns false when this relay task was already handled.
    fn remember_relay_task(
        &self,
        relay_task_id: &str,
        session_id: Option<Uuid>,
        accepted: bool,
    ) -> Result<bool> {
        let changed = self.conn.execute(
            "insert into agent_relay_tasks (relay_task_id, session_id, accepted, created_at)
             values (?1, ?2, ?3, ?4)
             on conflict(relay_task_id) do nothing",
            params![
                relay_task_id,
                session_id.map(|id| id.to_string()),
                accepted as i64,
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(changed == 1)
    }

    fn relay_task_ack(&self, relay_task_id: &str) -> Result<Option<(Option<Uuid>, bool)>> {
        self.conn
            .query_row(
                "select session_id, accepted from agent_relay_tasks where relay_task_id = ?1",
                params![relay_task_id],
                |row| {
                    let session: Option<String> = row.get(0)?;
                    let accepted: i64 = row.get(1)?;
                    Ok((
                        session.and_then(|value| Uuid::parse_str(&value).ok()),
                        accepted != 0,
                    ))
                },
            )
            .optional()
            .map_err(Into::into)
    }

    fn relay_status_reports(&self) -> Result<Vec<Value>> {
        let pairs = {
            let mut stmt = self.conn.prepare(
                "select relay_task_id, session_id from agent_relay_tasks
                 where accepted = 1 and session_id is not null",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        let mut reports = Vec::new();
        for (task_id, session_id) in pairs {
            let Ok(session_id) = Uuid::parse_str(&session_id) else {
                continue;
            };
            let Ok(report) = self.report(session_id) else {
                continue;
            };
            let mut value = serde_json::to_value(report)?;
            if let Some(object) = value.as_object_mut() {
                object.insert("taskId".into(), Value::String(task_id));
            }
            reports.push(value);
        }
        Ok(reports)
    }

    fn command_ack_ids(&self) -> Result<Vec<String>> {
        let mut statement = self.conn.prepare(
            "select command_id from agent_relay_command_acks order by command_id asc",
        )?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    fn command_ack_known(&self, command_id: &str) -> Result<bool> {
        let found: Option<i64> = self
            .conn
            .query_row(
                "select 1 from agent_relay_command_acks where command_id = ?1",
                params![command_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(found.is_some())
    }

    fn remember_command_ack(&self, command_id: &str) -> Result<()> {
        self.conn.execute(
            "insert into agent_relay_command_acks (command_id) values (?1)
             on conflict(command_id) do nothing",
            params![command_id],
        )?;
        Ok(())
    }

    fn forget_command_acks(&self, ids: &[String]) -> Result<()> {
        for id in ids {
            self.conn.execute(
                "delete from agent_relay_command_acks where command_id = ?1",
                params![id],
            )?;
        }
        Ok(())
    }

    fn gyro_session_for_relay_task(&self, relay_task_id: &str) -> Result<Option<Uuid>> {
        let session: Option<String> = self
            .conn
            .query_row(
                "select session_id from agent_relay_tasks
                 where relay_task_id = ?1 and accepted = 1",
                params![relay_task_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(session.and_then(|value| Uuid::parse_str(&value).ok()))
    }
}

pub fn resolve_choice(catalog: &ChoiceCatalog, request: &ChoiceRequest) -> Result<ResolvedChoice> {
    let provider_id = request
        .provider_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| catalog.selected_provider_id.clone())
        .ok_or_else(|| anyhow!("choose a provider the user has enabled"))?;
    let provider = catalog
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| anyhow!("provider {provider_id} is not enabled"))?;
    let model_id = request
        .model_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| provider.default_model.clone())
        .ok_or_else(|| anyhow!("choose a model the user has enabled"))?;
    let model = provider
        .models
        .iter()
        .find(|model| model.id.eq_ignore_ascii_case(&model_id))
        .ok_or_else(|| anyhow!("model {model_id} is not enabled"))?;
    let requested_effort = request
        .reasoning_effort
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let reasoning_effort = match requested_effort {
        Some(effort) => {
            if !model
                .efforts
                .iter()
                .any(|allowed| allowed.eq_ignore_ascii_case(&effort))
            {
                return Err(anyhow!("effort {effort} is not enabled for {model_id}"));
            }
            Some(canonical_effort(&model.efforts, &effort))
        }
        None => match provider.default_effort.clone() {
            Some(effort) if !model.efforts.is_empty() => {
                if !model
                    .efforts
                    .iter()
                    .any(|allowed| allowed.eq_ignore_ascii_case(&effort))
                {
                    return Err(anyhow!(
                        "saved effort {effort} is not enabled for {model_id}"
                    ));
                }
                Some(canonical_effort(&model.efforts, &effort))
            }
            Some(effort) => Some(effort),
            None => None,
        },
    };
    Ok(ResolvedChoice {
        provider_id: provider.id.clone(),
        provider_label: provider.label.clone(),
        model_id: model.id.clone(),
        model_label: model.label.clone(),
        reasoning_effort,
    })
}

fn canonical_effort(efforts: &[String], requested: &str) -> String {
    efforts
        .iter()
        .find(|effort| effort.eq_ignore_ascii_case(requested))
        .cloned()
        .unwrap_or_else(|| requested.to_string())
}

pub fn bounded_agent_summary(input: &str) -> String {
    let redacted = redact_secrets(input.trim());
    if redacted.chars().count() <= MAX_SUMMARY_CHARS {
        return redacted;
    }
    let mut bounded: String = redacted.chars().take(MAX_SUMMARY_CHARS - 1).collect();
    bounded.push('\u{2026}');
    bounded
}

fn agent_session_title(prompt: &str) -> String {
    let first = prompt.lines().next().unwrap_or(prompt).trim();
    let mut title = format!("Agent: {first}");
    if title.chars().count() > 160 {
        title = title.chars().take(160).collect();
    }
    title
}

fn canonical_workspace(path: &Path) -> Result<PathBuf> {
    path.canonicalize()
        .with_context(|| format!("workspace {} is not available", path.display()))
}

fn row_to_agent_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentSessionRow> {
    let state: String = row.get(5)?;
    Ok(AgentSessionRow {
        id: parse_uuid(row.get(0)?)?,
        session_id: optional_uuid(row.get(1)?)?,
        turn_id: optional_uuid(row.get(2)?)?,
        workspace_path: PathBuf::from(row.get::<_, String>(3)?),
        prompt: row.get(4)?,
        state: AgentSessionState::from_str(&state).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, error.into())
        })?,
        provider_id: row.get(6)?,
        provider_label: row.get(7)?,
        model_id: row.get(8)?,
        model_label: row.get(9)?,
        reasoning_effort: row.get(10)?,
        summary: row.get(11)?,
        error: row.get(12)?,
        created_at: parse_time(row.get(13)?)?,
        updated_at: parse_time(row.get(14)?)?,
    })
}

fn parse_uuid(value: String) -> rusqlite::Result<Uuid> {
    Uuid::parse_str(&value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, error.into())
    })
}

fn optional_uuid(value: Option<String>) -> rusqlite::Result<Option<Uuid>> {
    value.map(parse_uuid).transpose()
}

fn parse_time(value: String) -> rusqlite::Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(&value)
        .map(|time| time.with_timezone(&Utc))
        .map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(13, rusqlite::types::Type::Text, error.into())
        })
}

fn token_path(paths: &GyroPaths) -> PathBuf {
    paths.base_dir.join(TOKEN_FILE)
}

fn endpoint_path(paths: &GyroPaths) -> PathBuf {
    paths.base_dir.join(ENDPOINT_FILE)
}

pub fn ensure_local_token(paths: &GyroPaths) -> Result<String> {
    paths.ensure()?;
    let path = token_path(paths);
    if let Ok(existing) = fs::read_to_string(&path) {
        let existing = existing.trim();
        if existing.len() == TOKEN_HEX_LEN && existing.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            secure_private_file(&path)?;
            return Ok(existing.to_string());
        }
    }
    write_new_token(paths)
}

fn write_new_token(paths: &GyroPaths) -> Result<String> {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let token = encode_hex(&bytes);
    let path = token_path(paths);
    fs::write(&path, format!("{token}\n"))?;
    secure_private_file(&path)?;
    Ok(token)
}

pub fn revoke_local_link(paths: &GyroPaths) -> Result<()> {
    let store = AgentSessionStore::open(paths.clone())?;
    store.revoke_queued_work()?;
    write_new_token(paths)?;
    let endpoint = endpoint_path(paths);
    match fs::remove_file(&endpoint) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("remove {}", endpoint.display())),
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct EndpointFile {
    url: String,
    pid: u32,
}

pub fn listening_endpoint(paths: &GyroPaths) -> Result<Option<String>> {
    let path = endpoint_path(paths);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
    };
    let endpoint: EndpointFile = serde_json::from_str(&raw)?;
    if process_alive(endpoint.pid) {
        Ok(Some(endpoint.url))
    } else {
        Ok(None)
    }
}

fn process_alive(pid: u32) -> bool {
    // `kill` treats a negative id as a process group. Reject anything that
    // does not fit in a positive pid before calling it.
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn tokens_match(expected: &str, presented: &str) -> bool {
    if expected.len() != TOKEN_HEX_LEN || presented.len() != TOKEN_HEX_LEN {
        return false;
    }
    let mut diff = 0u8;
    for (left, right) in expected.bytes().zip(presented.bytes()) {
        diff |= left ^ right;
    }
    diff == 0
}

pub struct AgentSessionListener {
    shutdown: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    url: String,
}

impl AgentSessionListener {
    pub fn start(paths: &GyroPaths) -> Result<Self> {
        let store = AgentSessionStore::open(paths.clone())?;
        store.recover_interrupted()?;
        let _token = ensure_local_token(paths)?;
        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .context("bind the agent session listener")?;
        listener.set_nonblocking(true)?;
        let address = listener.local_addr()?;
        let url = format!("http://{address}/mcp");
        let endpoint = EndpointFile {
            url: url.clone(),
            pid: std::process::id(),
        };
        let endpoint_path = endpoint_path(paths);
        fs::write(&endpoint_path, serde_json::to_vec(&endpoint)?)?;
        secure_private_file(&endpoint_path)?;

        let shutdown = Arc::new(AtomicBool::new(false));
        let flag = shutdown.clone();
        let paths = paths.clone();
        let thread = thread::Builder::new()
            .name("gyro-agent-mcp".into())
            .spawn(move || accept_loop(listener, flag, paths))
            .context("start the agent session listener")?;
        Ok(Self {
            shutdown,
            thread: Some(thread),
            url,
        })
    }

    pub fn url(&self) -> &str {
        &self.url
    }
}

impl Drop for AgentSessionListener {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// A local client that stalls must not hold the inbox for every other caller.
const MAX_CONCURRENT_CONNECTIONS: usize = 8;

struct InflightGuard(Arc<AtomicUsize>);

impl InflightGuard {
    fn enter(counter: &Arc<AtomicUsize>) -> Option<Self> {
        let mut current = counter.load(Ordering::Relaxed);
        loop {
            if current >= MAX_CONCURRENT_CONNECTIONS {
                return None;
            }
            match counter.compare_exchange_weak(
                current,
                current + 1,
                Ordering::AcqRel,
                Ordering::Relaxed,
            ) {
                Ok(_) => return Some(Self(Arc::clone(counter))),
                Err(actual) => current = actual,
            }
        }
    }
}

impl Drop for InflightGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn accept_loop(listener: TcpListener, shutdown: Arc<AtomicBool>, paths: GyroPaths) {
    let inflight = Arc::new(AtomicUsize::new(0));
    while !shutdown.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((mut stream, peer)) => {
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
                if !peer.ip().is_loopback() {
                    continue;
                }
                let guard = match InflightGuard::enter(&inflight) {
                    Some(guard) => guard,
                    // Answering at once beats queueing: the caller learns the inbox
                    // is busy instead of waiting behind a client that stalled.
                    None => {
                        let _ = write_http(&mut stream, 503, br#"{"error":"busy"}"#);
                        continue;
                    }
                };
                let paths = paths.clone();
                thread::spawn(move || {
                    let _guard = guard;
                    if let Ok(store) = AgentSessionStore::open(paths.clone()) {
                        let _ = handle_connection(stream, &store, &paths);
                    }
                });
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::Interrupted =>
            {
                thread::sleep(Duration::from_millis(20));
            }
            Err(_) => {
                // A transient accept failure (out of descriptors, aborted handshake)
                // must not retire an endpoint the desktop still advertises as live.
                thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

fn handle_connection(
    mut stream: TcpStream,
    store: &AgentSessionStore,
    paths: &GyroPaths,
) -> Result<()> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            return Ok(());
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(end) = find_header_end(&buffer) {
            break end;
        }
        if buffer.len() > 64 * 1024 {
            return Ok(());
        }
    };
    let header_text = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let mut body = buffer[header_end + 4..].to_vec();
    let content_length = content_length(&header_text).unwrap_or(0);
    if content_length > MAX_HTTP_BODY {
        write_http(&mut stream, 413, br#"{"error":"body too large"}"#)?;
        return Ok(());
    }
    while body.len() < content_length {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(content_length);

    if !header_text.starts_with("POST /mcp ") {
        write_http(&mut stream, 404, br#"{"error":"not found"}"#)?;
        return Ok(());
    }
    let presented = bearer_token(&header_text).unwrap_or_default();
    let expected = ensure_local_token(paths).unwrap_or_default();
    if !tokens_match(&expected, &presented) {
        write_http(&mut stream, 401, br#"{"error":"unauthorized"}"#)?;
        return Ok(());
    }

    let request: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let response = mcp_response(store, &request);
    write_http(&mut stream, 200, response.as_bytes())?;
    Ok(())
}

fn mcp_response(store: &AgentSessionStore, request: &Value) -> String {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    if id.is_null() {
        return json!({"jsonrpc":"2.0"}).to_string();
    }
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": "2024-11-05",
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "gyro-agent-sessions", "version": "0.1.0" }
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({
            "tools": [
                tool_def("list_workspaces", "List workspaces and the provider, model, and effort the user has enabled.", json!({"type":"object","properties":{}})),
                tool_def("start_session", "Start a Gyro session and return immediately. Omit provider, model, or effort to use the saved choice. Values the user has not enabled are refused.", json!({
                    "type": "object",
                    "properties": {
                        "workspace": { "type": "string" },
                        "prompt": { "type": "string" },
                        "providerId": { "type": "string" },
                        "modelId": { "type": "string" },
                        "reasoningEffort": { "type": "string" }
                    },
                    "required": ["workspace", "prompt"]
                })),
                tool_def("session_status", "Read one session by the sessionId or inboxId returned from start_session. A blocked session names the approval in pendingApproval.", json!({
                    "type": "object",
                    "properties": { "sessionId": { "type": "string" } },
                    "required": ["sessionId"]
                })),
                tool_def("cancel_session", "Withdraw a session that has not started yet. A session Gyro already started must be stopped in Gyro.", json!({
                    "type": "object",
                    "properties": { "sessionId": { "type": "string" } },
                    "required": ["sessionId"]
                })),
                tool_def("list_sessions", "List sessions this inbox opened, newest first.", json!({
                    "type": "object",
                    "properties": {
                        "limit": { "type": "integer" },
                        "before": { "type": "string" }
                    }
                })),
                tool_def("read_session", "Read the saved user and assistant turns for one inbox session.", json!({
                    "type": "object",
                    "properties": {
                        "sessionId": { "type": "string" },
                        "after": { "type": "string" },
                        "limit": { "type": "integer" }
                    },
                    "required": ["sessionId"]
                })),
                tool_def("continue_session", "Append a prompt to a finished inbox session and queue that same session again.", json!({
                    "type": "object",
                    "properties": {
                        "sessionId": { "type": "string" },
                        "prompt": { "type": "string" },
                        "providerId": { "type": "string" },
                        "modelId": { "type": "string" },
                        "reasoningEffort": { "type": "string" }
                    },
                    "required": ["sessionId", "prompt"]
                })),
                tool_def("stop_session", "Withdraw a queued session, or stop a session Gyro is running. A finished session stays saved.", json!({
                    "type": "object",
                    "properties": { "sessionId": { "type": "string" } },
                    "required": ["sessionId"]
                })),
                tool_def("resolve_approval", "Deny an approval that is blocking a session. Approving stays with the person using Gyro.", json!({
                    "type": "object",
                    "properties": {
                        "proposalId": { "type": "string" },
                        "decision": { "type": "string", "enum": ["deny", "allow"] }
                    },
                    "required": ["proposalId", "decision"]
                }))
            ]
        })),
        "tools/call" => {
            let params = request.get("params").cloned().unwrap_or(json!({}));
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
            match call_tool(store, name, &arguments) {
                Ok(payload) => Ok(tool_result(payload, false)),
                Err(error) => Ok(tool_result(json!({"error": error}), true)),
            }
        }
        _ => Err("method not found"),
    };
    match result {
        Ok(result) => json!({"jsonrpc":"2.0", "id": id, "result": result}).to_string(),
        Err(message) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": message }
        })
        .to_string(),
    }
}

fn tool_def(name: &str, description: &str, schema: Value) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": schema
    })
}

fn tool_result(payload: Value, is_error: bool) -> Value {
    json!({
        "content": [{ "type": "text", "text": payload.to_string() }],
        "isError": is_error
    })
}

fn call_tool(store: &AgentSessionStore, name: &str, arguments: &Value) -> Result<Value, String> {
    match name {
        "list_workspaces" => {
            let workspaces = store.list_workspaces().map_err(|error| error.to_string())?;
            let catalog = store.choice_catalog().map_err(|error| error.to_string())?;
            Ok(json!({
                "workspaces": workspaces,
                "selectedProviderId": catalog.selected_provider_id,
                "providers": catalog.providers
            }))
        }
        "start_session" => {
            let workspace = argument_string(arguments, "workspace")?;
            let prompt = argument_string(arguments, "prompt")?;
            let choice = ChoiceRequest {
                provider_id: optional_argument(arguments, "providerId"),
                model_id: optional_argument(arguments, "modelId"),
                reasoning_effort: optional_argument(arguments, "reasoningEffort"),
            };
            let row = store
                .start_session(Path::new(&workspace), &prompt, choice)
                .map_err(|error| error.to_string())?;
            Ok(json!({
                "sessionId": row.session_id,
                "inboxId": row.id,
                "status": row.state.as_str(),
                "providerId": row.provider_id,
                "providerLabel": row.provider_label,
                "modelId": row.model_id,
                "modelLabel": row.model_label,
                "reasoningEffort": row.reasoning_effort
            }))
        }
        "session_status" => {
            let id = argument_string(arguments, "sessionId")?;
            let id = Uuid::parse_str(&id).map_err(|_| "unknown session".to_string())?;
            let report = store
                .report(id)
                .map_err(|_| "unknown session".to_string())?;
            Ok(serde_json::to_value(report).map_err(|error| error.to_string())?)
        }
        "cancel_session" => {
            let id = argument_uuid(arguments, "sessionId")?;
            store.cancel(id).map_err(|error| error.to_string())?;
            Ok(json!({ "sessionId": id, "status": "cancelled" }))
        }
        "list_sessions" => {
            let limit = argument_limit(arguments, 20, 50);
            let before = match optional_argument(arguments, "before") {
                Some(value) => Some(
                    DateTime::parse_from_rfc3339(&value)
                        .map_err(|_| "before must be a timestamp".to_string())?
                        .with_timezone(&Utc),
                ),
                None => None,
            };
            let items = store
                .list_sessions(limit, before)
                .map_err(|error| error.to_string())?;
            Ok(json!({ "sessions": items }))
        }
        "read_session" => {
            let id = argument_uuid(arguments, "sessionId")?;
            let after = match optional_argument(arguments, "after") {
                Some(value) => {
                    Some(Uuid::parse_str(&value).map_err(|_| "unknown cursor".to_string())?)
                }
                None => None,
            };
            let page = store
                .read_session(id, after, argument_limit(arguments, 20, 20))
                .map_err(|error| error.to_string())?;
            serde_json::to_value(page).map_err(|error| error.to_string())
        }
        "continue_session" => {
            let id = argument_uuid(arguments, "sessionId")?;
            let prompt = argument_string(arguments, "prompt")?;
            let row = store
                .continue_session(id, &prompt, choice_from_arguments(arguments))
                .map_err(|error| error.to_string())?;
            Ok(session_started_json(&row))
        }
        "stop_session" => {
            let id = argument_uuid(arguments, "sessionId")?;
            let control = store.stop_session(id).map_err(|error| error.to_string())?;
            Ok(json!({
                "sessionId": control.session_id,
                "inboxId": control.inbox_id,
                "status": control.status
            }))
        }
        "resolve_approval" => {
            let proposal_id = argument_uuid(arguments, "proposalId")?;
            match argument_string(arguments, "decision")?.as_str() {
                "deny" => {
                    store
                        .deny_approval(proposal_id)
                        .map_err(|error| error.to_string())?;
                    Ok(json!({ "proposalId": proposal_id, "decision": "denied" }))
                }
                "allow" => Err(
                    "Only the person using Gyro can approve. Deny it here, or approve it in Gyro."
                        .into(),
                ),
                other => Err(format!("decision must be deny or allow, not {other}")),
            }
        }
        _ => Err(format!("unknown tool {name}")),
    }
}

fn choice_from_arguments(arguments: &Value) -> ChoiceRequest {
    ChoiceRequest {
        provider_id: optional_argument(arguments, "providerId"),
        model_id: optional_argument(arguments, "modelId"),
        reasoning_effort: optional_argument(arguments, "reasoningEffort"),
    }
}

fn session_started_json(row: &AgentSessionRow) -> Value {
    json!({
        "sessionId": row.session_id,
        "inboxId": row.id,
        "status": row.state.as_str(),
        "providerId": row.provider_id,
        "providerLabel": row.provider_label,
        "modelId": row.model_id,
        "modelLabel": row.model_label,
        "reasoningEffort": row.reasoning_effort
    })
}

fn argument_limit(arguments: &Value, default: u64, max: u64) -> usize {
    let raw = arguments
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(default);
    raw.clamp(1, max) as usize
}

fn argument_string(arguments: &Value, key: &str) -> Result<String, String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("{key} is required"))
}

fn argument_uuid(arguments: &Value, key: &str) -> Result<Uuid, String> {
    let value = argument_string(arguments, key)?;
    Uuid::parse_str(&value).map_err(|_| format!("{key} must be a UUID"))
}

fn optional_argument(arguments: &Value, key: &str) -> Option<String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn content_length(headers: &str) -> Option<usize> {
    headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if name.eq_ignore_ascii_case("content-length") {
            value.trim().parse().ok()
        } else {
            None
        }
    })
}

fn bearer_token(headers: &str) -> Option<String> {
    headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if !name.eq_ignore_ascii_case("authorization") {
            return None;
        }
        let value = value.trim();
        value
            .strip_prefix("Bearer ")
            .or_else(|| value.strip_prefix("bearer "))
            .map(str::trim)
            .map(str::to_string)
    })
}

fn write_http(stream: &mut TcpStream, status: u16, body: &[u8]) -> Result<()> {
    let reason = match status {
        200 => "OK",
        401 => "Unauthorized",
        404 => "Not Found",
        413 => "Payload Too Large",
        _ => "Error",
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes())?;
    stream.write_all(body)?;
    Ok(())
}

#[cfg_attr(test, allow(dead_code))]
const PAIRING_KEYCHAIN_ACCOUNT: &str = "agent-session-pairing";
#[cfg_attr(not(test), allow(dead_code))]
const PAIRING_SECRET_FILE: &str = "agent-session-pairing.secret";

/// Exchange a pairing code with a public relay and keep the credential locally.
///
/// The Mac opens the connection. Nothing listens for the relay.
pub fn pair_outbound(paths: &GyroPaths, relay: &str, pairing_code: &str) -> Result<AgentPairing> {
    let relay = validate_relay_url(relay)?;
    let pairing_code = pairing_code.trim();
    if pairing_code.len() < 8 || pairing_code.len() > 200 {
        return Err(anyhow!("pairing code must be between 8 and 200 characters"));
    }
    let store = AgentSessionStore::open(paths.clone())?;
    let workspaces = store.list_workspaces()?;
    if workspaces.is_empty() {
        return Err(anyhow!("allow a workspace before pairing"));
    }
    let device_id = Uuid::new_v4();
    let response = post_relay(
        &relay_endpoint(&relay, "/v1/pair")?,
        None,
        &json!({
            "deviceId": device_id,
            "pairingCode": pairing_code,
            "workspaces": workspaces,
        }),
    )?;
    let credential = response
        .get("credential")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if credential.len() != TOKEN_HEX_LEN || !credential.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(anyhow!("relay returned an invalid credential"));
    }
    write_pairing_secret(paths, credential)?;
    let paired_at = Utc::now();
    if let Err(error) = store.save_pairing(device_id, &relay_origin(&relay), paired_at) {
        let _ = delete_pairing_secret(paths);
        return Err(error);
    }
    Ok(AgentPairing {
        device_id,
        relay_url: relay_origin(&relay),
        paired_at,
    })
}

/// Forget the relay credential and drop queued work.
pub fn unpair(paths: &GyroPaths) -> Result<()> {
    let store = AgentSessionStore::open(paths.clone())?;
    store.clear_pairing()?;
    delete_pairing_secret(paths)?;
    store.revoke_queued_work()?;
    Ok(())
}

/// Pull tasks from the paired relay. Disallowed workspaces are not started.
pub fn poll_paired_relay(paths: &GyroPaths) -> Result<Vec<PolledRelayTask>> {
    let store = AgentSessionStore::open(paths.clone())?;
    let Some(pairing) = store.pairing()? else {
        return Ok(Vec::new());
    };
    let Some(secret) = read_pairing_secret(paths)? else {
        return Err(anyhow!("pairing credential is missing"));
    };
    let relay = validate_relay_url(&pairing.relay_url)?;
    let workspaces = store.list_workspaces()?;
    let applied_command_ids = store.command_ack_ids()?;
    let response = match post_relay(
        &relay_endpoint(&relay, "/v1/poll")?,
        Some(&secret),
        &json!({
            "deviceId": pairing.device_id,
            "workspaces": workspaces,
            "catalog": store.choice_catalog()?,
            "reports": store.relay_status_reports()?,
            "appliedCommandIds": applied_command_ids,
        }),
    ) {
        Ok(response) => response,
        Err(error) if error.to_string().contains("rejected the Mac") => {
            unpair(paths)?;
            return Err(error);
        }
        Err(error) => return Err(error),
    };
    store.forget_command_acks(&applied_command_ids)?;
    let tasks = response
        .get("tasks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut started = Vec::new();
    for task in tasks {
        let Some(relay_task_id) = task.get("id").and_then(Value::as_str).map(str::trim) else {
            continue;
        };
        if relay_task_id.is_empty() {
            continue;
        }
        if let Some((session_id, accepted)) = store.relay_task_ack(relay_task_id)? {
            let _ = post_relay(
                &relay_endpoint(&relay, "/v1/ack")?,
                Some(&secret),
                &json!({
                    "taskId": relay_task_id,
                    "accepted": accepted,
                    "sessionId": session_id,
                }),
            );
            continue;
        }
        let workspace = task
            .get("workspace")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let prompt = task
            .get("prompt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let choice = ChoiceRequest {
            provider_id: task
                .get("providerId")
                .and_then(Value::as_str)
                .map(str::to_string),
            model_id: task
                .get("modelId")
                .and_then(Value::as_str)
                .map(str::to_string),
            reasoning_effort: task
                .get("reasoningEffort")
                .and_then(Value::as_str)
                .map(str::to_string),
        };
        match store.start_session(Path::new(workspace), prompt, choice) {
            Ok(row) => {
                if !store.remember_relay_task(relay_task_id, row.session_id, true)? {
                    continue;
                }
                let _ = post_relay(
                    &relay_endpoint(&relay, "/v1/ack")?,
                    Some(&secret),
                    &json!({
                        "taskId": relay_task_id,
                        "accepted": true,
                        "sessionId": row.session_id,
                    }),
                );
                if let Some(session_id) = row.session_id {
                    started.push(PolledRelayTask {
                        relay_task_id: relay_task_id.to_string(),
                        session_id,
                        inbox_id: row.id,
                    });
                }
            }
            Err(error) if permanent_start_refusal(&error) => {
                if store.remember_relay_task(relay_task_id, None, false)? {
                    let _ = post_relay(
                        &relay_endpoint(&relay, "/v1/ack")?,
                        Some(&secret),
                        &json!({
                            "taskId": relay_task_id,
                            "accepted": false,
                            "error": error.to_string(),
                        }),
                    );
                }
            }
            Err(error) => return Err(error),
        }
    }
    let applied = apply_polled_commands(&store, response.get("commands"))?;
    let pages = pages_for_polled_reads(&store, response.get("reads"))?;
    if !applied.is_empty() || !pages.is_empty() {
        let posted = post_relay(
            &relay_endpoint(&relay, "/v1/poll")?,
            Some(&secret),
            &json!({
                "deviceId": pairing.device_id,
                "appliedCommandIds": applied,
                "pages": pages,
            }),
        );
        if posted.is_ok() {
            store.forget_command_acks(&applied)?;
        }
    }
    Ok(started)
}

fn apply_polled_commands(
    store: &AgentSessionStore,
    commands: Option<&Value>,
) -> Result<Vec<String>> {
    let Some(commands) = commands.and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    let mut applied = Vec::new();
    for command in commands {
        let Some(id) = command.get("id").and_then(Value::as_str).map(str::trim) else {
            continue;
        };
        if id.is_empty() {
            continue;
        }
        if !store.command_ack_known(id)? {
            store.remember_command_ack(id)?;
            let _ = apply_one_polled_command(store, command);
        }
        applied.push(id.to_string());
    }
    Ok(applied)
}

fn apply_one_polled_command(store: &AgentSessionStore, command: &Value) -> Result<()> {
    let kind = command.get("kind").and_then(Value::as_str).unwrap_or("");
    let task_id = command.get("taskId").and_then(Value::as_str).unwrap_or("");
    match kind {
        "continue" => {
            let Some(session_id) = store.gyro_session_for_relay_task(task_id)? else {
                return Err(anyhow!("unknown session"));
            };
            let prompt = command.get("prompt").and_then(Value::as_str).unwrap_or("");
            let choice = ChoiceRequest {
                provider_id: command
                    .get("providerId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                model_id: command.get("modelId").and_then(Value::as_str).map(str::to_string),
                reasoning_effort: command
                    .get("reasoningEffort")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            };
            store.continue_session(session_id, prompt, choice)?;
        }
        "stop" => {
            let Some(session_id) = store.gyro_session_for_relay_task(task_id)? else {
                return Err(anyhow!("unknown session"));
            };
            store.stop_session(session_id)?;
        }
        "deny" => {
            let proposal_id = command
                .get("proposalId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let proposal_id = Uuid::parse_str(proposal_id)?;
            store.deny_approval(proposal_id)?;
        }
        _ => {}
    }
    Ok(())
}

fn pages_for_polled_reads(store: &AgentSessionStore, reads: Option<&Value>) -> Result<Vec<Value>> {
    let Some(reads) = reads.and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    let mut pages = Vec::new();
    for read in reads {
        let Some(token) = read.get("token").and_then(Value::as_str) else {
            continue;
        };
        let Some(task_id) = read.get("taskId").and_then(Value::as_str) else {
            continue;
        };
        let after = read
            .get("after")
            .and_then(Value::as_str)
            .and_then(|value| Uuid::parse_str(value).ok());
        let limit = read.get("limit").and_then(Value::as_u64).unwrap_or(20) as usize;
        let Some(session_id) = store.gyro_session_for_relay_task(task_id)? else {
            pages.push(json!({
                "token": token,
                "page": { "error": "unknown session" }
            }));
            continue;
        };
        match store.read_session(session_id, after, limit) {
            Ok(page) => {
                let mut value = serde_json::to_value(page)?;
                if let Some(object) = value.as_object_mut() {
                    let gyro = object.get("sessionId").cloned().unwrap_or(Value::Null);
                    object.insert("gyroSessionId".into(), gyro);
                    object.insert("sessionId".into(), Value::String(task_id.to_string()));
                }
                pages.push(json!({ "token": token, "page": value }));
            }
            Err(error) => pages.push(json!({
                "token": token,
                "page": { "error": error.to_string() }
            })),
        }
    }
    Ok(pages)
}

fn permanent_start_refusal(error: &anyhow::Error) -> bool {
    let message = error.to_string();
    ["not allowed", "not enabled", "choose a ", "prompt cannot"]
        .iter()
        .any(|needle| message.contains(needle))
}

pub fn validate_relay_url(raw: &str) -> Result<url::Url> {
    let url = url::Url::parse(raw.trim()).context("relay URL is not valid")?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(anyhow!("relay URL cannot contain credentials"));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(anyhow!("relay URL cannot contain a query or fragment"));
    }
    let host = url
        .host_str()
        .ok_or_else(|| anyhow!("relay URL needs a host"))?;
    #[cfg(test)]
    if url.scheme() == "http" && host == "127.0.0.1" && url.port().is_some() {
        return Ok(url);
    }
    if url.scheme() != "https" {
        return Err(anyhow!("relay URL must be https"));
    }
    if host_is_local(host) {
        return Err(anyhow!("relay URL must be a public host"));
    }
    Ok(url)
}

fn host_is_local(host: &str) -> bool {
    let host = host.trim_matches(['[', ']']);
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(address)) => {
            address.is_loopback()
                || address.is_private()
                || address.is_link_local()
                || address.is_unspecified()
                || address.is_broadcast()
        }
        Ok(std::net::IpAddr::V6(address)) => {
            let octets = address.octets();
            address.is_loopback()
                || address.is_unspecified()
                || (octets[0] & 0xfe) == 0xfc
                || (octets[0] == 0xfe && (octets[1] & 0xc0) == 0x80)
        }
        Err(_) => false,
    }
}

fn relay_origin(relay: &url::Url) -> String {
    relay.as_str().trim_end_matches('/').to_string()
}

fn relay_endpoint(relay: &url::Url, path: &str) -> Result<url::Url> {
    let mut endpoint = relay.clone();
    endpoint.set_path(path);
    endpoint.set_query(None);
    endpoint.set_fragment(None);
    Ok(endpoint)
}

fn post_relay(url: &url::Url, bearer: Option<&str>, body: &Value) -> Result<Value> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(10))
        .timeout_write(Duration::from_secs(10))
        .timeout(Duration::from_secs(10))
        .redirects(0)
        .build();
    let mut request = agent
        .post(url.as_str())
        .set("Content-Type", "application/json")
        .set("Accept", "application/json");
    if let Some(bearer) = bearer {
        request = request.set("Authorization", &format!("Bearer {bearer}"));
    }
    match request.send_json(body) {
        Ok(response) => response.into_json().context("read relay response"),
        Err(ureq::Error::Status(status, response)) => {
            let _ = response.into_string();
            if status == 401 || status == 403 {
                Err(anyhow!("relay rejected the Mac"))
            } else {
                Err(anyhow!("relay returned {status}"))
            }
        }
        Err(ureq::Error::Transport(error)) => {
            Err(anyhow!(error)).context("could not reach the relay")
        }
    }
}

fn write_pairing_secret(paths: &GyroPaths, secret: &str) -> Result<()> {
    #[cfg(test)]
    {
        paths.ensure()?;
        let path = paths.base_dir.join(PAIRING_SECRET_FILE);
        fs::write(&path, format!("{secret}\n"))?;
        secure_private_file(&path)?;
        Ok(())
    }
    #[cfg(not(test))]
    {
        let _ = paths;
        crate::keychain::set_api_key(PAIRING_KEYCHAIN_ACCOUNT, secret)
    }
}

fn read_pairing_secret(paths: &GyroPaths) -> Result<Option<String>> {
    #[cfg(test)]
    {
        let path = paths.base_dir.join(PAIRING_SECRET_FILE);
        match fs::read_to_string(&path) {
            Ok(value) => {
                let value = value.trim().to_string();
                Ok((!value.is_empty()).then_some(value))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error).context("read pairing credential"),
        }
    }
    #[cfg(not(test))]
    {
        let _ = paths;
        crate::keychain::get_api_key(PAIRING_KEYCHAIN_ACCOUNT)
    }
}

fn delete_pairing_secret(paths: &GyroPaths) -> Result<()> {
    #[cfg(test)]
    {
        let path = paths.base_dir.join(PAIRING_SECRET_FILE);
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error).context("remove pairing credential"),
        }
    }
    #[cfg(not(test))]
    {
        let _ = paths;
        crate::keychain::delete_api_key(PAIRING_KEYCHAIN_ACCOUNT)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::Mutex;

    fn fixture() -> (tempfile::TempDir, AgentSessionStore, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("gyro"));
        let store = AgentSessionStore::open(paths).unwrap();
        store.set_choice_catalog(&sample_catalog()).unwrap();
        store.allow_workspace(&workspace).unwrap();
        (temp, store, workspace)
    }

    fn sample_catalog() -> ChoiceCatalog {
        ChoiceCatalog {
            selected_provider_id: Some("openai".into()),
            providers: vec![ProviderChoices {
                id: "openai".into(),
                label: "OpenAI".into(),
                default_model: Some("gpt-test".into()),
                default_effort: Some("medium".into()),
                models: vec![ModelChoices {
                    id: "gpt-test".into(),
                    label: "GPT Test".into(),
                    efforts: vec!["low".into(), "medium".into(), "high".into()],
                }],
            }],
        }
    }

    #[test]
    fn omitted_choice_uses_the_saved_provider_model_and_effort() {
        let (_temp, store, workspace) = fixture();
        let row = store
            .start_session(&workspace, "Look at the tests", ChoiceRequest::default())
            .unwrap();
        assert_eq!(row.provider_id, "openai");
        assert_eq!(row.model_id, "gpt-test");
        assert_eq!(row.reasoning_effort.as_deref(), Some("medium"));
        assert_eq!(row.state, AgentSessionState::Queued);
        let sessions = SessionStore::open(store.paths().clone()).unwrap();
        let session = sessions
            .get_session(row.session_id.unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(session.provider_id.as_deref(), Some("openai"));
        assert_eq!(session.model_id.as_deref(), Some("gpt-test"));
        assert_eq!(session.reasoning_effort.as_deref(), Some("medium"));
    }

    #[test]
    fn disabled_provider_model_or_effort_does_not_start_a_session() {
        let (_temp, store, workspace) = fixture();
        let before = SessionStore::open(store.paths().clone())
            .unwrap()
            .list_sessions()
            .unwrap()
            .len();
        let missing_provider = store.start_session(
            &workspace,
            "run",
            ChoiceRequest {
                provider_id: Some("closed".into()),
                ..ChoiceRequest::default()
            },
        );
        let missing_model = store.start_session(
            &workspace,
            "run",
            ChoiceRequest {
                model_id: Some("gpt-other".into()),
                ..ChoiceRequest::default()
            },
        );
        let missing_effort = store.start_session(
            &workspace,
            "run",
            ChoiceRequest {
                reasoning_effort: Some("max".into()),
                ..ChoiceRequest::default()
            },
        );
        assert!(missing_provider.is_err());
        assert!(missing_model.is_err());
        assert!(missing_effort.is_err());
        let after = SessionStore::open(store.paths().clone())
            .unwrap()
            .list_sessions()
            .unwrap()
            .len();
        assert_eq!(before, after);
    }

    #[test]
    fn disallowed_workspace_does_not_start_a_session() {
        let (temp, store, _workspace) = fixture();
        let other = temp.path().join("other");
        fs::create_dir_all(&other).unwrap();
        let error = store
            .start_session(&other, "run", ChoiceRequest::default())
            .unwrap_err()
            .to_string();
        assert!(error.contains("not allowed"));
    }

    #[test]
    fn empty_allowlist_adopts_the_newest_open_chat_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let older = temp.path().join("older");
        let newest = temp.path().join("newest");
        let missing = temp.path().join("missing");
        fs::create_dir_all(&older).unwrap();
        fs::create_dir_all(&newest).unwrap();
        fs::create_dir_all(&missing).unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("gyro"));
        let sessions = SessionStore::open(paths.clone()).unwrap();
        sessions
            .create_session(&older, SessionOrigin::Desktop, "older")
            .unwrap();
        sessions
            .create_session(&newest, SessionOrigin::Desktop, "newest")
            .unwrap();
        sessions
            .create_session(&missing, SessionOrigin::Desktop, "missing")
            .unwrap();
        fs::remove_dir_all(&missing).unwrap();
        let adopted = allow_latest_session_workspace(&paths).unwrap().unwrap();
        assert_eq!(adopted, newest.canonicalize().unwrap());
        let store = AgentSessionStore::open(paths.clone()).unwrap();
        assert_eq!(
            store.list_workspaces().unwrap(),
            vec![adopted.display().to_string()]
        );
        assert!(allow_latest_session_workspace(&paths).unwrap().is_none());

        let manual = temp.path().join("manual");
        fs::create_dir_all(&manual).unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("gyro-manual"));
        let store = AgentSessionStore::open(paths.clone()).unwrap();
        let allowed = store.allow_workspace(&manual).unwrap();
        SessionStore::open(paths.clone())
            .unwrap()
            .create_session(&newest, SessionOrigin::Desktop, "elsewhere")
            .unwrap();
        assert!(allow_latest_session_workspace(&paths).unwrap().is_none());
        assert_eq!(
            store.list_workspaces().unwrap(),
            vec![allowed.display().to_string()]
        );
    }

    #[test]
    fn a_cancelled_session_never_reaches_the_desktop() {
        let (_temp, store, workspace) = fixture();
        let row = store
            .start_session(&workspace, "Run the suite", ChoiceRequest::default())
            .unwrap();

        store.cancel(row.id).unwrap();

        assert!(store.get(row.id).unwrap().is_none());
        assert!(store.claim_next().unwrap().is_none());
    }

    #[test]
    fn a_session_gyro_already_started_cannot_be_cancelled_from_the_inbox() {
        let (_temp, store, workspace) = fixture();
        let row = store
            .start_session(&workspace, "Run the suite", ChoiceRequest::default())
            .unwrap();
        assert_eq!(store.claim_next().unwrap().unwrap().id, row.id);

        let error = store.cancel(row.id).unwrap_err().to_string();

        assert!(error.contains("stop it in Gyro"), "{error}");
        assert_eq!(
            store.get(row.id).unwrap().unwrap().state,
            AgentSessionState::Running
        );
    }

    #[test]
    fn a_blocked_session_names_the_approval_in_its_report() {
        let (_temp, store, workspace) = fixture();
        let row = store
            .start_session(&workspace, "Edit the readme", ChoiceRequest::default())
            .unwrap();
        store.claim_next().unwrap().unwrap();
        let sessions = SessionStore::open(store.paths().clone()).unwrap();
        let proposal = sessions
            .create_mutation_proposal(
                row.session_id.expect("session id"),
                None,
                "README.md",
                "the new readme",
                None,
                false,
            )
            .unwrap();

        let report = store.report(row.id).unwrap();

        assert_eq!(report.status, "waiting-for-approval");
        let pending = report.pending_approval.expect("pending approval");
        assert_eq!(pending.proposal_id, proposal.id);
        assert_eq!(pending.tool, "create");
        assert_eq!(pending.summary, "create README.md");
    }

    #[test]
    fn the_calling_agent_can_deny_the_approval_that_blocks_it() {
        let (_temp, store, workspace) = fixture();
        let row = store
            .start_session(&workspace, "Edit the readme", ChoiceRequest::default())
            .unwrap();
        store.claim_next().unwrap().unwrap();
        let sessions = SessionStore::open(store.paths().clone()).unwrap();
        let proposal = sessions
            .create_mutation_proposal(
                row.session_id.expect("session id"),
                None,
                "README.md",
                "the new readme",
                None,
                false,
            )
            .unwrap();

        let payload = call_tool(
            &store,
            "resolve_approval",
            &json!({ "proposalId": proposal.id.to_string(), "decision": "deny" }),
        )
        .unwrap();

        assert_eq!(payload["decision"], "denied");
        assert_eq!(
            sessions
                .get_mutation_proposal(proposal.id)
                .unwrap()
                .unwrap()
                .status,
            crate::sessions::MutationProposalStatus::Rejected
        );
    }

    #[test]
    fn approving_stays_with_the_person_using_gyro() {
        let (_temp, store, _workspace) = fixture();

        let error = call_tool(
            &store,
            "resolve_approval",
            &json!({ "proposalId": Uuid::new_v4().to_string(), "decision": "allow" }),
        )
        .unwrap_err();

        assert!(
            error.contains("Only the person using Gyro can approve"),
            "{error}"
        );
    }

    #[test]
    fn the_inbox_serves_a_bounded_number_of_connections_at_once() {
        let inflight = Arc::new(AtomicUsize::new(0));
        let mut held = Vec::new();
        for _ in 0..MAX_CONCURRENT_CONNECTIONS {
            held.push(InflightGuard::enter(&inflight).expect("a slot"));
        }

        // Past the cap the caller is answered instead of queued behind a stall.
        assert!(InflightGuard::enter(&inflight).is_none());

        drop(held.pop());
        assert!(InflightGuard::enter(&inflight).is_some());
    }

    #[test]
    fn start_session_returns_before_a_provider_would_run() {
        let (_temp, store, workspace) = fixture();
        let row = store
            .start_session(&workspace, "Inspect the crate", ChoiceRequest::default())
            .unwrap();
        assert_eq!(row.state, AgentSessionState::Queued);
        let claimed = store.claim_next().unwrap().unwrap();
        assert_eq!(claimed.id, row.id);
        assert_eq!(claimed.state, AgentSessionState::Running);
        assert!(store.claim_next().unwrap().is_none());
    }

    #[test]
    fn one_workspace_runs_one_session_at_a_time() {
        let (temp, store, workspace) = fixture();
        let other = temp.path().join("other");
        fs::create_dir_all(&other).unwrap();
        store.allow_workspace(&other).unwrap();
        let first = store
            .start_session(&workspace, "first", ChoiceRequest::default())
            .unwrap();
        let second = store
            .start_session(&workspace, "second", ChoiceRequest::default())
            .unwrap();
        let elsewhere = store
            .start_session(&other, "elsewhere", ChoiceRequest::default())
            .unwrap();
        let claimed = store.claim_next().unwrap().unwrap();
        assert_eq!(claimed.id, first.id);
        let next = store.claim_next().unwrap().unwrap();
        assert_eq!(next.id, elsewhere.id);
        assert!(store.claim_next().unwrap().is_none());
        assert!(store.finish(claimed.id, Ok("done".into())).unwrap());
        let resumed = store.claim_next().unwrap().unwrap();
        assert_eq!(resumed.id, second.id);
    }

    #[test]
    fn offline_queue_waits_and_a_dead_process_does_not_drop_it() {
        let (_temp, store, workspace) = fixture();
        let running = store
            .start_session(&workspace, "was running", ChoiceRequest::default())
            .unwrap();
        assert_eq!(store.claim_next().unwrap().unwrap().id, running.id);
        let queued = store
            .start_session(&workspace, "wait", ChoiceRequest::default())
            .unwrap();
        let reopened = AgentSessionStore::open(store.paths().clone()).unwrap();
        assert_eq!(
            reopened.get(running.id).unwrap().unwrap().state,
            AgentSessionState::Running
        );
        assert_eq!(reopened.recover_interrupted().unwrap(), 1);
        assert_eq!(
            reopened.get(queued.id).unwrap().unwrap().state,
            AgentSessionState::Queued
        );
        assert_eq!(
            reopened.get(running.id).unwrap().unwrap().state,
            AgentSessionState::Failed
        );
        let endpoint = endpoint_path(store.paths());
        fs::write(
            &endpoint,
            serde_json::to_vec(&EndpointFile {
                url: "http://127.0.0.1:9/mcp".into(),
                pid: i32::MAX as u32,
            })
            .unwrap(),
        )
        .unwrap();
        assert!(listening_endpoint(store.paths()).unwrap().is_none());
    }

    #[test]
    fn running_session_with_a_pending_edit_waits_for_approval() {
        let (_temp, store, workspace) = fixture();
        let row = store
            .start_session(&workspace, "edit a file", ChoiceRequest::default())
            .unwrap();
        store.claim_next().unwrap().unwrap();
        let sessions = SessionStore::open(store.paths().clone()).unwrap();
        sessions
            .create_mutation_proposal(
                row.session_id.unwrap(),
                row.turn_id,
                "notes.txt",
                "hello",
                None,
                false,
            )
            .unwrap();
        let report = store.report(row.session_id.unwrap()).unwrap();
        assert_eq!(report.status, "waiting-for-approval");
        assert_eq!(report.inbox_id, row.id);
        let policy = agent_session_run_policy();
        assert!(policy.require_command_approval);
        assert!(policy.require_file_edit_approval);
        assert!(!policy.full_access);
    }

    #[test]
    fn summary_is_bounded_and_redacted() {
        let secret = format!("token sk-{}", "a".repeat(24));
        let summary = bounded_agent_summary(&format!("{secret} {}", "word ".repeat(5_000)));
        assert!(summary.chars().count() <= MAX_SUMMARY_CHARS);
        assert!(!summary.contains(&secret));
        assert!(summary.contains("[REDACTED]"));
    }

    #[test]
    fn wrong_token_is_unauthorized_and_revoke_drops_the_queue() {
        let (_temp, store, workspace) = fixture();
        let row = store
            .start_session(&workspace, "queued work", ChoiceRequest::default())
            .unwrap();
        let listener = AgentSessionListener::start(store.paths()).unwrap();
        let token = ensure_local_token(store.paths()).unwrap();
        let (status, _) = post_mcp(
            listener.url(),
            "not-the-token",
            r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#,
        );
        assert_eq!(status, 401);
        let (status, body) = post_mcp(
            listener.url(),
            &token,
            &json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "session_status",
                    "arguments": { "sessionId": row.session_id.unwrap() }
                }
            })
            .to_string(),
        );
        assert_eq!(status, 200);
        assert!(body.contains("queued"));
        assert!(body.contains(&row.provider_id));
        let (status, body) = post_mcp(
            listener.url(),
            &token,
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"resolve_approval","arguments":{}}}"#,
        );
        assert_eq!(status, 200);
        assert!(body.contains("proposalId is required"));
        revoke_local_link(store.paths()).unwrap();
        assert!(store.get(row.id).unwrap().is_none());
        let rotated = ensure_local_token(store.paths()).unwrap();
        assert_ne!(rotated, token);
        drop(listener);
    }

    fn post_mcp(url: &str, token: &str, body: &str) -> (u16, String) {
        let address = url.trim_start_matches("http://").trim_end_matches("/mcp");
        let mut last = String::new();
        for _ in 0..20 {
            if let Ok(mut stream) = TcpStream::connect(address) {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let request = format!(
                    "POST /mcp HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(request.as_bytes()).unwrap();
                let mut response = String::new();
                let _ = stream.read_to_string(&mut response);
                if let Some((status, body)) = split_http(&response) {
                    return (status, body);
                }
                last = response;
            }
            thread::sleep(Duration::from_millis(20));
        }
        panic!("no mcp response: {last}");
    }

    fn split_http(response: &str) -> Option<(u16, String)> {
        let (head, body) = response.split_once("\r\n\r\n")?;
        let status = head
            .lines()
            .next()?
            .split_whitespace()
            .nth(1)?
            .parse()
            .ok()?;
        Some((status, body.to_string()))
    }

    const TEST_PAIRING_CREDENTIAL: &str =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    struct CapturedRequest {
        path: String,
        authorization: Option<String>,
        body: String,
    }

    struct FakeRelay {
        url: String,
        requests: Arc<Mutex<Vec<CapturedRequest>>>,
        tasks: Arc<Mutex<Vec<Value>>>,
        stop: Arc<AtomicBool>,
        handle: Option<JoinHandle<()>>,
    }

    impl FakeRelay {
        fn start() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let port = listener.local_addr().unwrap().port();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let tasks = Arc::new(Mutex::new(Vec::new()));
            let stop = Arc::new(AtomicBool::new(false));
            let requests_thread = Arc::clone(&requests);
            let tasks_thread = Arc::clone(&tasks);
            let stop_thread = Arc::clone(&stop);
            let handle = thread::spawn(move || {
                relay_loop(listener, requests_thread, tasks_thread, stop_thread)
            });
            Self {
                url: format!("http://127.0.0.1:{port}"),
                requests,
                tasks,
                stop,
                handle: Some(handle),
            }
        }

        fn request_count(&self) -> usize {
            self.requests.lock().unwrap().len()
        }
    }

    impl Drop for FakeRelay {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
    }

    fn relay_loop(
        listener: TcpListener,
        requests: Arc<Mutex<Vec<CapturedRequest>>>,
        tasks: Arc<Mutex<Vec<Value>>>,
        stop: Arc<AtomicBool>,
    ) {
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while !stop.load(Ordering::Relaxed) && std::time::Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = stream.set_nonblocking(false);
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                    if let Some((path, authorization, body)) = read_relay_request(&mut stream) {
                        requests.lock().unwrap().push(CapturedRequest {
                            path: path.clone(),
                            authorization,
                            body: body.clone(),
                        });
                        let (status, response) = relay_response(&path, &body, &tasks);
                        let _ = write_http(&mut stream, status, response.as_bytes());
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(_) => break,
            }
        }
    }

    fn read_relay_request(stream: &mut TcpStream) -> Option<(String, Option<String>, String)> {
        let mut buffer = Vec::new();
        let mut chunk = [0_u8; 4096];
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while std::time::Instant::now() < deadline && buffer.len() <= MAX_HTTP_BODY {
            if let Some(parsed) = parse_relay_request(&buffer) {
                return Some(parsed);
            }
            match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(count) => buffer.extend_from_slice(&chunk[..count]),
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        || error.kind() == std::io::ErrorKind::TimedOut =>
                {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(_) => return None,
            }
        }
        parse_relay_request(&buffer)
    }

    fn parse_relay_request(buffer: &[u8]) -> Option<(String, Option<String>, String)> {
        let header_end = find_header_end(buffer)?;
        let headers = String::from_utf8_lossy(&buffer[..header_end]).into_owned();
        let length = content_length(&headers).unwrap_or(0);
        let body_start = header_end + 4;
        if buffer.len() < body_start + length {
            return None;
        }
        let body = String::from_utf8_lossy(&buffer[body_start..body_start + length]).into_owned();
        let path = headers
            .lines()
            .next()
            .unwrap_or("")
            .split_whitespace()
            .nth(1)
            .unwrap_or("")
            .to_string();
        Some((path, bearer_token(&headers), body))
    }

    fn relay_response(path: &str, body: &str, tasks: &Mutex<Vec<Value>>) -> (u16, String) {
        if path.contains("/v1/pair") {
            let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
            let code = parsed
                .get("pairingCode")
                .and_then(Value::as_str)
                .unwrap_or("");
            if code == "good-code" {
                return (
                    200,
                    json!({ "credential": TEST_PAIRING_CREDENTIAL }).to_string(),
                );
            }
            return (403, json!({ "error": "bad code" }).to_string());
        }
        if path.contains("/v1/poll") {
            let queued = tasks.lock().unwrap().clone();
            return (200, json!({ "tasks": queued }).to_string());
        }
        if path.contains("/v1/ack") {
            return (200, json!({ "ok": true }).to_string());
        }
        (404, json!({ "error": "missing" }).to_string())
    }

    fn pairing_secret_path(paths: &GyroPaths) -> PathBuf {
        paths.base_dir.join("agent-session-pairing.secret")
    }

    fn database_bytes_contain(paths: &GyroPaths, needle: &str) -> bool {
        ["gyro.sqlite3", "gyro.sqlite3-wal", "gyro.sqlite3-shm"]
            .into_iter()
            .any(|name| {
                fs::read(paths.base_dir.join(name))
                    .map(|bytes| {
                        bytes
                            .windows(needle.len())
                            .any(|window| window == needle.as_bytes())
                    })
                    .unwrap_or(false)
            })
    }

    #[test]
    fn relay_url_must_be_public_https() {
        assert!(validate_relay_url("https://relay.example.com").is_ok());
        assert!(validate_relay_url("https://relay.example.com/gyro").is_ok());
        for rejected in [
            "http://example.com",
            "http://10.0.0.1",
            "https://10.0.0.1",
            "https://127.0.0.1",
            "https://127.0.0.1:443",
            "https://localhost",
            "https://192.168.1.9",
            "http://127.0.0.1",
            "https://relay.example.com/path?x=1",
            "https://user:pass@relay.example.com",
            "https://[::1]/",
            "https://[fc00::1]/",
            "https://[fe80::1]/",
        ] {
            assert!(validate_relay_url(rejected).is_err(), "{rejected}");
        }
        assert!(validate_relay_url("http://127.0.0.1:9").is_ok());
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("gyro"));
        let error = pair_outbound(&paths, "https://relay.example.com", "good-code").unwrap_err();
        assert!(error.to_string().contains("allow a workspace"));
    }

    #[test]
    fn pair_stores_the_credential_outside_sqlite() {
        let (temp, store, _workspace) = fixture();
        let blocked = temp.path().join("not-allowed");
        fs::create_dir_all(&blocked).unwrap();
        let blocked = blocked.canonicalize().unwrap();
        let relay = FakeRelay::start();
        let pairing = pair_outbound(store.paths(), &relay.url, "good-code").unwrap();
        assert_eq!(pairing.relay_url.trim_end_matches('/'), relay.url);
        let secret_path = pairing_secret_path(store.paths());
        assert_eq!(
            fs::read_to_string(&secret_path).unwrap().trim(),
            TEST_PAIRING_CREDENTIAL
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&secret_path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let conn = rusqlite::Connection::open(&store.paths().database_path).unwrap();
        let mut info = conn.prepare("pragma table_info(agent_pairing)").unwrap();
        let columns: Vec<String> = info
            .query_map([], |row| row.get(1))
            .unwrap()
            .map(|item| item.unwrap())
            .collect();
        assert_eq!(columns, vec!["id", "device_id", "relay_url", "paired_at"]);
        let stored_relay: String = conn
            .query_row(
                "select relay_url from agent_pairing where id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_relay, pairing.relay_url);
        assert!(!database_bytes_contain(
            store.paths(),
            TEST_PAIRING_CREDENTIAL
        ));
        let captured = relay.requests.lock().unwrap();
        let body: Value = serde_json::from_str(&captured[0].body).unwrap();
        assert_eq!(body["workspaces"].as_array().unwrap().len(), 1);
        assert!(!body.to_string().contains(&blocked.display().to_string()));
        assert!(captured[0].authorization.is_none());
    }

    #[test]
    fn bad_pairing_code_stores_nothing() {
        let (_temp, store, _workspace) = fixture();
        let relay = FakeRelay::start();
        let short = pair_outbound(store.paths(), &relay.url, "short").unwrap_err();
        assert!(short.to_string().contains("between 8 and 200"));
        assert_eq!(relay.request_count(), 0);
        let rejected = pair_outbound(store.paths(), &relay.url, "not-the-code").unwrap_err();
        assert!(rejected.to_string().contains("rejected the Mac"));
        assert!(store.pairing().unwrap().is_none());
        assert!(!pairing_secret_path(store.paths()).exists());
        let rows: i64 = rusqlite::Connection::open(&store.paths().database_path)
            .unwrap()
            .query_row("select count(*) from agent_pairing", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 0);
    }

    #[test]
    fn poll_starts_only_an_allowed_workspace() {
        let (temp, store, _workspace) = fixture();
        let allowed = store.list_workspaces().unwrap();
        assert_eq!(allowed.len(), 1);
        let blocked = temp.path().join("not-allowed");
        fs::create_dir_all(&blocked).unwrap();
        let blocked = blocked.canonicalize().unwrap().display().to_string();
        let relay = FakeRelay::start();
        pair_outbound(store.paths(), &relay.url, "good-code").unwrap();
        *relay.tasks.lock().unwrap() = vec![
            json!({
                "id": "task-allowed",
                "workspace": allowed[0],
                "prompt": "Say hello",
            }),
            json!({
                "id": "task-blocked",
                "workspace": blocked,
                "prompt": "Do not run",
            }),
        ];
        let started = poll_paired_relay(store.paths()).unwrap();
        assert_eq!(started.len(), 1);
        assert_eq!(started[0].relay_task_id, "task-allowed");
        let row = store.get(started[0].inbox_id).unwrap().unwrap();
        assert_eq!(row.state, AgentSessionState::Queued);
        assert_eq!(row.workspace_path.display().to_string(), allowed[0]);
        let sessions = SessionStore::open(store.paths().clone())
            .unwrap()
            .list_sessions()
            .unwrap();
        assert_eq!(sessions.len(), 1);
        assert!(sessions
            .iter()
            .all(|session| session.workspace_path.display().to_string() != blocked));
        let again = poll_paired_relay(store.paths()).unwrap();
        assert!(again.is_empty());
        assert_eq!(
            SessionStore::open(store.paths().clone())
                .unwrap()
                .list_sessions()
                .unwrap()
                .len(),
            1
        );
        let captured = relay.requests.lock().unwrap();
        let pair = captured
            .iter()
            .find(|item| item.path.contains("/v1/pair"))
            .unwrap();
        let pair_body: Value = serde_json::from_str(&pair.body).unwrap();
        let poll_bodies: Vec<Value> = captured
            .iter()
            .filter(|item| item.path.contains("/v1/poll"))
            .map(|item| serde_json::from_str(&item.body).unwrap())
            .collect();
        assert_eq!(poll_bodies.len(), 2);
        assert_eq!(pair_body["workspaces"], json!(allowed.clone()));
        assert_eq!(poll_bodies[0]["workspaces"], json!(allowed));
        assert!(!pair_body.to_string().contains(&blocked));
        assert!(!poll_bodies[0].to_string().contains(&blocked));
        assert!(pair.authorization.is_none());
        assert_eq!(
            captured
                .iter()
                .find(|item| item.path.contains("/v1/poll"))
                .unwrap()
                .authorization
                .as_deref(),
            Some(TEST_PAIRING_CREDENTIAL)
        );
        let device = store.pairing().unwrap().unwrap().device_id.to_string();
        assert_eq!(poll_bodies[0]["deviceId"], device);
        let acks: Vec<Value> = captured
            .iter()
            .filter(|item| item.path.contains("/v1/ack"))
            .map(|item| serde_json::from_str(&item.body).unwrap())
            .collect();
        assert_eq!(acks.len(), 4);
        assert!(acks
            .iter()
            .any(|ack| ack["taskId"] == "task-allowed" && ack["accepted"] == true));
        assert!(acks
            .iter()
            .any(|ack| ack["taskId"] == "task-blocked" && ack["accepted"] == false));
    }

    #[test]
    fn unpair_drops_queued_work_and_stops_polling() {
        let (_temp, store, workspace) = fixture();
        let relay = FakeRelay::start();
        pair_outbound(store.paths(), &relay.url, "good-code").unwrap();
        let row = store
            .start_session(&workspace, "queued work", ChoiceRequest::default())
            .unwrap();
        let requests_after_pair = relay.request_count();
        unpair(store.paths()).unwrap();
        assert!(store.get(row.id).unwrap().is_none());
        assert!(store.pairing().unwrap().is_none());
        assert!(!pairing_secret_path(store.paths()).exists());
        assert_eq!(store.list_workspaces().unwrap().len(), 1);
        let polled = poll_paired_relay(store.paths()).unwrap();
        assert!(polled.is_empty());
        assert_eq!(relay.request_count(), requests_after_pair);
    }

    #[test]
    fn offline_relay_keeps_queued_local_work() {
        let (_temp, store, workspace) = fixture();
        let relay = FakeRelay::start();
        pair_outbound(store.paths(), &relay.url, "good-code").unwrap();
        let row = store
            .start_session(&workspace, "queued work", ChoiceRequest::default())
            .unwrap();
        drop(relay);
        let error = poll_paired_relay(store.paths()).unwrap_err();
        assert!(error.to_string().contains("could not reach the relay"));
        let kept = store.get(row.id).unwrap().unwrap();
        assert_eq!(kept.state, AgentSessionState::Queued);
        assert!(store.pairing().unwrap().is_some());
    }

    #[test]
    fn read_session_returns_saved_turns_and_refuses_a_foreign_session() {
        let (_temp, store, workspace) = fixture();
        let row = store
            .start_session(
                &workspace,
                "Look at sk-abcdefghijklmnopqrstuvwxyz",
                ChoiceRequest::default(),
            )
            .unwrap();
        let sessions = SessionStore::open(store.paths().clone()).unwrap();
        sessions
            .append_event(
                row.session_id.unwrap(),
                SessionEventKind::AssistantMessage,
                "assistant says hello",
                json!({}),
            )
            .unwrap();
        let page = store.read_session(row.id, None, 20).unwrap();
        assert_eq!(page.turns.len(), 2);
        assert_eq!(page.turns[0].role, "user");
        assert!(page.turns[0].text.contains("[REDACTED]"));
        assert!(!page.turns[0].text.contains("sk-abcdefghijklmnopqrstuvwxyz"));
        assert_eq!(page.turns[1].role, "assistant");
        assert_eq!(page.turns[1].text, "assistant says hello");
        assert!(!page.has_more);
        let listed = store.list_sessions(20, None).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].inbox_id, row.id);
        let error = store
            .read_session(Uuid::new_v4(), None, 20)
            .unwrap_err()
            .to_string();
        assert!(error.contains("unknown session"));
    }

    #[test]
    fn read_session_stops_before_a_later_oversized_line() {
        let (_temp, store, workspace) = fixture();
        let row = store
            .start_session(&workspace, "first", ChoiceRequest::default())
            .unwrap();
        let session_id = row.session_id.unwrap();
        let sessions = SessionStore::open(store.paths().clone()).unwrap();
        let second = sessions
            .append_event(
                session_id,
                SessionEventKind::AssistantMessage,
                "second",
                json!({}),
            )
            .unwrap();
        sessions
            .append_event(
                session_id,
                SessionEventKind::AssistantMessage,
                "third",
                json!({}),
            )
            .unwrap();
        let unknown = store
            .read_session(row.id, Some(Uuid::new_v4()), 1)
            .unwrap_err()
            .to_string();
        assert!(unknown.contains("unknown cursor"));
        let session = sessions.get_session(session_id).unwrap().unwrap();
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&session.events_path)
            .unwrap();
        file.write_all(&vec![b'x'; 1024 * 1024 + 1]).unwrap();

        let page = store.read_session(row.id, None, 1).unwrap();
        assert_eq!(page.turns.len(), 1);
        assert_eq!(page.turns[0].text, "first");
        assert!(page.has_more);
        let next = store.read_session(row.id, Some(page.turns[0].id), 1).unwrap();
        assert_eq!(next.turns.len(), 1);
        assert_eq!(next.turns[0].id, second.id);
        assert_eq!(next.turns[0].text, "second");
        assert!(next.has_more);
        let error = sessions
            .read_transcript_events(session_id)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("line exceeds"),
            "the unread tail is still oversized: {error}"
        );
    }

    #[test]
    fn read_session_keeps_the_character_budget_across_pages() {
        let (_temp, store, workspace) = fixture();
        let row = store
            .start_session(&workspace, "short", ChoiceRequest::default())
            .unwrap();
        let session_id = row.session_id.unwrap();
        let sessions = SessionStore::open(store.paths().clone()).unwrap();
        sessions
            .append_event(
                session_id,
                SessionEventKind::AssistantMessage,
                "b".repeat(40_000),
                json!({}),
            )
            .unwrap();
        let first = store.read_session(row.id, None, 20).unwrap();
        assert_eq!(first.turns.len(), 1);
        assert_eq!(first.turns[0].text, "short");
        assert!(first.has_more);
        let second = store
            .read_session(row.id, Some(first.turns[0].id), 20)
            .unwrap();
        assert_eq!(second.turns.len(), 1);
        assert_eq!(second.turns[0].text.chars().count(), 32_000);
        assert!(second.turns[0].text.ends_with('\u{2026}'));
        assert!(!second.has_more);
    }

    #[test]
    fn continue_appends_to_the_same_saved_session() {
        let (_temp, store, workspace) = fixture();
        let row = store
            .start_session(&workspace, "First task", ChoiceRequest::default())
            .unwrap();
        let claimed = store.claim_next().unwrap().unwrap();
        assert!(store.finish(claimed.id, Ok("first answer".into())).unwrap());
        let continued = store
            .continue_session(row.session_id.unwrap(), "Second task", ChoiceRequest::default())
            .unwrap();
        assert_eq!(continued.session_id, row.session_id);
        assert_eq!(continued.state, AgentSessionState::Queued);
        let page = store.read_session(continued.id, None, 20).unwrap();
        assert_eq!(page.turns.len(), 2);
        assert_eq!(page.turns[1].text, "Second task");
    }

    #[test]
    fn continue_refuses_a_running_session_and_a_busy_workspace() {
        let (_temp, store, workspace) = fixture();
        let running = store
            .start_session(&workspace, "Still going", ChoiceRequest::default())
            .unwrap();
        store.claim_next().unwrap().unwrap();
        let error = store
            .continue_session(running.id, "More", ChoiceRequest::default())
            .unwrap_err()
            .to_string();
        assert!(error.contains("session is still running"));

        assert!(store.finish(running.id, Ok("done".into())).unwrap());
        let other = store
            .start_session(&workspace, "Other", ChoiceRequest::default())
            .unwrap();
        store.claim_next().unwrap().unwrap();
        let error = store
            .continue_session(running.session_id.unwrap(), "Again", ChoiceRequest::default())
            .unwrap_err()
            .to_string();
        assert!(error.contains("workspace already has a running session"));
        assert_eq!(store.get(other.id).unwrap().unwrap().state, AgentSessionState::Running);
    }

    #[test]
    fn stop_marks_a_running_session_and_does_not_let_finish_overwrite_it() {
        let (_temp, store, workspace) = fixture();
        let row = store
            .start_session(&workspace, "Stop me", ChoiceRequest::default())
            .unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let hook_seen = seen.clone();
        set_session_stop_hook(Arc::new(move |session_id| {
            hook_seen.lock().unwrap().push(session_id);
        }));
        store.claim_next().unwrap().unwrap();
        let control = store.stop_session(row.id).unwrap();
        assert_eq!(control.status, "stopped");
        assert!(seen.lock().unwrap().contains(&row.session_id.unwrap()));
        assert!(!store.finish(row.id, Ok("late answer".into())).unwrap());
        let kept = store.get(row.id).unwrap().unwrap();
        assert_eq!(kept.state, AgentSessionState::Failed);
        assert_eq!(kept.error.as_deref(), Some("stopped"));
        let queued = store
            .start_session(&workspace, "Not started", ChoiceRequest::default())
            .unwrap();
        let control = store.stop_session(queued.id).unwrap();
        assert_eq!(control.status, "cancelled");
        assert!(store.get(queued.id).unwrap().is_none());
    }

    #[test]
    fn a_blocked_command_is_visible_and_deny_stops_it() {
        let (_temp, store, workspace) = fixture();
        let row = store
            .start_session(&workspace, "Run tests", ChoiceRequest::default())
            .unwrap();
        store.claim_next().unwrap().unwrap();
        let proposal_id = Uuid::new_v4();
        assert!(store
            .note_command_block(row.session_id.unwrap(), proposal_id, "cargo test")
            .unwrap());
        let report = store.report(row.id).unwrap();
        assert_eq!(report.status, "waiting-for-approval");
        let pending = report.pending_approval.unwrap();
        assert_eq!(pending.tool, "command");
        assert_eq!(pending.summary, "cargo test");
        assert_eq!(pending.proposal_id, proposal_id);
        let control = store.deny_approval(proposal_id).unwrap();
        assert_eq!(control.status, "stopped");
        let report = store.report(row.id).unwrap();
        assert_eq!(report.status, "failed");
        assert!(report.pending_approval.is_none());
        let refused = call_tool(
            &store,
            "resolve_approval",
            &json!({"proposalId": proposal_id.to_string(), "decision": "allow"}),
        )
        .unwrap_err();
        assert!(refused.contains("Only the person using Gyro can approve"));
    }
}
