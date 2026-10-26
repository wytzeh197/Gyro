//! Public relay between a cloud agent and a paired Mac.
//!
//! The Mac dials this process. The process does not open a port on the laptop.
//! It stores the prompt, the status, the redacted summary, and the resolved
//! provider, model, and effort. The workspace path is kept only so the Mac can
//! route the task. File bodies and terminal transcripts are not stored.
//! Serve HTTP here and terminate HTTPS in front of it.

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;
use uuid::Uuid;

use crate::agent_sessions::{bounded_agent_summary, resolve_choice, ChoiceCatalog, ChoiceRequest};
use crate::paths::secure_private_file;

const TOKEN_HEX_LEN: usize = 64;
const MAX_PROMPT_CHARS: usize = 32_000;
const MAX_HTTP_BODY: usize = 1024 * 1024;
const DEFAULT_OFFLINE_AFTER_MS: i64 = 45_000;

const SCHEMA: &str = "
create table if not exists relay_meta (
  id integer primary key check (id = 1),
  pairing_code text not null,
  agent_token text not null,
  offline_after_ms integer not null
);
create table if not exists relay_device (
  id integer primary key check (id = 1),
  device_id text not null,
  secret text not null,
  workspaces_json text not null,
  catalog_json text not null,
  last_seen text
);
create table if not exists relay_tasks (
  id text primary key,
  workspace text not null,
  prompt text not null,
  provider_id text,
  provider_label text,
  model_id text,
  model_label text,
  reasoning_effort text,
  status text not null,
  session_id text,
  summary text,
  error text,
  accepted integer,
  created_at text not null,
  updated_at text not null
);
create table if not exists relay_commands (
  id text primary key,
  task_id text not null,
  kind text not null,
  payload_json text not null,
  created_at text not null
);
create table if not exists relay_read_pages (
  token text primary key,
  task_id text not null,
  page_json text not null
);
";

/// HTTP relay. Cloud agents call `/mcp`. The paired Mac calls `/v1/pair`,
/// `/v1/poll`, and `/v1/ack`.
pub struct AgentRelayServer {
    data_dir: PathBuf,
    origin: String,
    pairing_code: String,
    agent_token: String,
    shutdown: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl AgentRelayServer {
    pub fn start(
        data_dir: PathBuf,
        bind: impl AsRef<str>,
        pairing_code: Option<String>,
    ) -> Result<Self> {
        ensure_private_dir(&data_dir)?;
        let conn = open_db(&data_dir)?;
        let (pairing_code, agent_token) = ensure_meta(&conn, pairing_code.as_deref())?;
        drop(conn);
        let address: SocketAddr = bind
            .as_ref()
            .parse()
            .with_context(|| format!("relay bind {} is not an address", bind.as_ref()))?;
        if !address.ip().is_loopback()
            && std::env::var("GYRO_RELAY_PUBLIC").ok().as_deref() != Some("1")
        {
            anyhow::bail!(
                "relay bind {address} is not loopback; set GYRO_RELAY_PUBLIC=1 to listen on a public address"
            );
        }
        let listener = TcpListener::bind(address).context("bind the agent relay")?;
        listener.set_nonblocking(true)?;
        let local = listener.local_addr()?;
        let origin = format!("http://{local}");
        let shutdown = Arc::new(AtomicBool::new(false));
        let flag = shutdown.clone();
        let directory = data_dir.clone();
        let thread = thread::Builder::new()
            .name("gyro-agent-relay".into())
            .spawn(move || accept_loop(listener, flag, directory))
            .context("start the agent relay")?;
        Ok(Self {
            data_dir,
            origin,
            pairing_code,
            agent_token,
            shutdown,
            thread: Some(thread),
        })
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub fn pairing_code(&self) -> &str {
        &self.pairing_code
    }

    pub fn agent_token(&self) -> &str {
        &self.agent_token
    }

    pub fn shutdown_flag(&self) -> Arc<AtomicBool> {
        self.shutdown.clone()
    }

    pub fn set_offline_after(&self, duration: Duration) -> Result<()> {
        let millis = i64::try_from(duration.as_millis()).unwrap_or(i64::MAX);
        let conn = open_db(&self.data_dir)?;
        conn.execute(
            "update relay_meta set offline_after_ms = ?1 where id = 1",
            params![millis],
        )?;
        Ok(())
    }

    pub fn wait(mut self) -> Result<()> {
        if let Some(thread) = self.thread.take() {
            thread
                .join()
                .map_err(|_| anyhow!("agent relay stopped unexpectedly"))?;
        }
        Ok(())
    }
}

impl Drop for AgentRelayServer {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn ensure_private_dir(dir: &Path) -> Result<()> {
    fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn open_db(data_dir: &Path) -> Result<Connection> {
    let path = data_dir.join("relay.sqlite3");
    let conn = crate::sqlite::open_private_database(&path)
        .with_context(|| format!("open {}", path.display()))?;
    secure_private_file(&path)?;
    conn.execute_batch(SCHEMA)?;
    crate::sqlite::add_column_if_missing(&conn, "relay_tasks", "pending_approval_json text")?;
    crate::sqlite::add_column_if_missing(&conn, "relay_tasks", "read_after text")?;
    crate::sqlite::add_column_if_missing(&conn, "relay_tasks", "read_token text")?;
    crate::sqlite::add_column_if_missing(&conn, "relay_tasks", "read_limit integer")?;
    Ok(conn)
}

fn ensure_meta(conn: &Connection, pairing_code: Option<&str>) -> Result<(String, String)> {
    let existing: Option<(String, String)> = conn
        .query_row(
            "select pairing_code, agent_token from relay_meta where id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((code, token)) = existing {
        if let Some(requested) = pairing_code {
            let requested = validate_pairing_code(requested)?;
            if requested != code {
                conn.execute(
                    "update relay_meta set pairing_code = ?1 where id = 1",
                    params![requested],
                )?;
                return Ok((requested.to_string(), token));
            }
        }
        return Ok((code, token));
    }
    let code = match pairing_code {
        Some(code) => validate_pairing_code(code)?.to_string(),
        None => random_hex(16),
    };
    let token = random_hex(32);
    conn.execute(
        "insert into relay_meta (id, pairing_code, agent_token, offline_after_ms)
         values (1, ?1, ?2, ?3)",
        params![code, token, DEFAULT_OFFLINE_AFTER_MS],
    )?;
    Ok((code, token))
}

fn validate_pairing_code(code: &str) -> Result<&str> {
    let code = code.trim();
    if code.len() < 8 || code.len() > 200 {
        return Err(anyhow!("pairing code must be between 8 and 200 characters"));
    }
    Ok(code)
}

fn accept_loop(listener: TcpListener, shutdown: Arc<AtomicBool>, data_dir: PathBuf) {
    while !shutdown.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
                let _ = handle_connection(stream, &data_dir);
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::Interrupted =>
            {
                thread::sleep(Duration::from_millis(20));
            }
            Err(_) => break,
        }
    }
}

fn handle_connection(mut stream: TcpStream, data_dir: &Path) -> Result<()> {
    let (head, body) = match read_request(&mut stream)? {
        Some(request) => request,
        None => return Ok(()),
    };
    if !head.starts_with("POST ") {
        write_http(&mut stream, 404, br#"{"error":"not found"}"#)?;
        return Ok(());
    }
    let path = request_path(&head);
    let bearer = bearer_token(&head);
    let conn = open_db(data_dir)?;
    let (status, response) = dispatch(&conn, path, bearer.as_deref(), &body);
    write_http(&mut stream, status, response.as_bytes())?;
    Ok(())
}

fn dispatch(conn: &Connection, path: &str, bearer: Option<&str>, body: &[u8]) -> (u16, String) {
    let parsed = serde_json::from_slice::<Value>(body).unwrap_or(Value::Null);
    match path {
        "/v1/pair" => pair(conn, &parsed),
        "/v1/poll" => poll(conn, bearer, &parsed),
        "/v1/ack" => ack(conn, bearer, &parsed),
        "/mcp" => {
            if !agent_authorized(conn, bearer) {
                return (401, json!({"error": "unauthorized"}).to_string());
            }
            (200, mcp(conn, &parsed))
        }
        _ => (404, json!({"error": "not found"}).to_string()),
    }
}

fn pair(conn: &Connection, body: &Value) -> (u16, String) {
    let presented = body
        .get("pairingCode")
        .and_then(Value::as_str)
        .unwrap_or("");
    let expected = meta_value(conn, "pairing_code").unwrap_or_default();
    if !codes_match(&expected, presented.trim()) {
        return (403, json!({"error": "rejected"}).to_string());
    }
    let Some(device_id) = body
        .get("deviceId")
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value.trim()).ok())
    else {
        return (400, json!({"error": "deviceId is required"}).to_string());
    };
    let secret = random_hex(32);
    let workspaces = json!(string_list(body.get("workspaces"))).to_string();
    let now = Utc::now().to_rfc3339();
    if conn
        .execute(
            "insert into relay_device (id, device_id, secret, workspaces_json, catalog_json, last_seen)
             values (1, ?1, ?2, ?3, '{}', ?4)
             on conflict(id) do update set
               device_id = excluded.device_id,
               secret = excluded.secret,
               workspaces_json = excluded.workspaces_json,
               last_seen = excluded.last_seen",
            params![device_id.to_string(), secret, workspaces, now],
        )
        .is_err()
    {
        return (500, json!({"error": "could not save the pairing"}).to_string());
    }
    (200, json!({"credential": secret}).to_string())
}

fn poll(conn: &Connection, bearer: Option<&str>, body: &Value) -> (u16, String) {
    let Some(device) = authorized_device(conn, bearer, body) else {
        return (401, json!({"error": "unauthorized"}).to_string());
    };
    let now = Utc::now().to_rfc3339();
    let workspaces = if body.get("workspaces").is_some() {
        json!(string_list(body.get("workspaces"))).to_string()
    } else {
        device.workspaces_json
    };
    let catalog = match body.get("catalog") {
        Some(value) if serde_json::from_value::<ChoiceCatalog>(value.clone()).is_ok() => {
            value.to_string()
        }
        _ => device.catalog_json,
    };
    if conn
        .execute(
            "update relay_device
             set workspaces_json = ?1, catalog_json = ?2, last_seen = ?3
             where id = 1",
            params![workspaces, catalog, now],
        )
        .is_err()
    {
        return (
            500,
            json!({"error": "could not update the device"}).to_string(),
        );
    }
    if let Some(reports) = body.get("reports").and_then(Value::as_array) {
        for report in reports {
            let _ = apply_report(conn, report, &now);
        }
    }
    if let Some(ids) = body.get("appliedCommandIds").and_then(Value::as_array) {
        for id in ids.iter().filter_map(Value::as_str) {
            let _ = conn.execute("delete from relay_commands where id = ?1", params![id]);
        }
    }
    if let Some(pages) = body.get("pages").and_then(Value::as_array) {
        for page in pages {
            let Some(token) = page.get("token").and_then(Value::as_str) else {
                continue;
            };
            let task_id: Option<String> = conn
                .query_row(
                    "select id from relay_tasks where read_token = ?1",
                    params![token],
                    |row| row.get(0),
                )
                .optional()
                .ok()
                .flatten();
            let Some(task_id) = task_id else {
                continue;
            };
            let _ = conn.execute(
                "insert into relay_read_pages (token, task_id, page_json) values (?1, ?2, ?3)
                 on conflict(token) do update set
                   task_id = excluded.task_id,
                   page_json = excluded.page_json",
                params![token, task_id, page.to_string()],
            );
            let _ = conn.execute(
                "update relay_tasks
                 set read_token = null, read_after = null, read_limit = null
                 where read_token = ?1",
                params![token],
            );
        }
    }
    let tasks = match pending_tasks(conn) {
        Ok(tasks) => tasks,
        Err(_) => return (500, json!({"error": "could not list tasks"}).to_string()),
    };
    let commands = match pending_commands(conn) {
        Ok(commands) => commands,
        Err(_) => return (500, json!({"error": "could not list commands"}).to_string()),
    };
    let reads = match pending_reads(conn) {
        Ok(reads) => reads,
        Err(_) => return (500, json!({"error": "could not list reads"}).to_string()),
    };
    (
        200,
        json!({"tasks": tasks, "commands": commands, "reads": reads}).to_string(),
    )
}

fn ack(conn: &Connection, bearer: Option<&str>, body: &Value) -> (u16, String) {
    if bearer_device(conn, bearer).is_none() {
        return (401, json!({"error": "unauthorized"}).to_string());
    }
    let Some(task_id) = body.get("taskId").and_then(Value::as_str).map(str::trim) else {
        return (400, json!({"error": "taskId is required"}).to_string());
    };
    let Some(accepted) = body.get("accepted").and_then(Value::as_bool) else {
        return (400, json!({"error": "accepted is required"}).to_string());
    };
    let session_id = body
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| Uuid::parse_str(value).is_ok())
        .map(str::to_string);
    let error = body
        .get("error")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(bounded_agent_summary);
    let now = Utc::now().to_rfc3339();
    let changed = conn.execute(
        "update relay_tasks set
           accepted = ?1,
           session_id = coalesce(?2, session_id),
           status = case when ?1 = 0 then 'failed' else status end,
           error = coalesce(?3, error),
           updated_at = ?4
         where id = ?5",
        params![accepted as i64, session_id, error, now, task_id],
    );
    match changed {
        Ok(0) => (404, json!({"error": "unknown task"}).to_string()),
        Ok(_) => (200, json!({"ok": true}).to_string()),
        Err(_) => (500, json!({"error": "could not ack"}).to_string()),
    }
}

fn mcp(conn: &Connection, request: &Value) -> String {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    if id.is_null() {
        return json!({"jsonrpc": "2.0"}).to_string();
    }
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": "2024-11-05",
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "gyro-agent-relay", "version": "0.1.0" }
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({
            "tools": [
                tool_def(
                    "list_workspaces",
                    "List workspaces and the provider, model, and effort the paired Mac has announced.",
                    json!({"type": "object", "properties": {}})
                ),
                tool_def(
                    "start_session",
                    "Queue a Gyro session and return immediately. Omit provider, model, or effort to use the saved choice. The Mac must have announced that choice.",
                    json!({
                        "type": "object",
                        "properties": {
                            "workspace": { "type": "string" },
                            "prompt": { "type": "string" },
                            "providerId": { "type": "string" },
                            "modelId": { "type": "string" },
                            "reasoningEffort": { "type": "string" }
                        },
                        "required": ["workspace", "prompt"]
                    })
                ),
                tool_def(
                    "session_status",
                    "Read one session by the sessionId returned from start_session. A blocked session names the approval in pendingApproval.",
                    json!({
                        "type": "object",
                        "properties": { "sessionId": { "type": "string" } },
                        "required": ["sessionId"]
                    })
                ),
                tool_def(
                    "list_sessions",
                    "List sessions this relay has queued, newest first.",
                    json!({
                        "type": "object",
                        "properties": {
                            "limit": { "type": "integer" },
                            "before": { "type": "string" }
                        }
                    })
                ),
                tool_def(
                    "read_session",
                    "Read the saved user and assistant turns for one session. The first call waits for the paired Mac. The next call returns one page, and the relay drops that page.",
                    json!({
                        "type": "object",
                        "properties": {
                            "sessionId": { "type": "string" },
                            "after": { "type": "string" },
                            "limit": { "type": "integer" }
                        },
                        "required": ["sessionId"]
                    })
                ),
                tool_def(
                    "continue_session",
                    "Append a prompt to a finished session and queue that same session again.",
                    json!({
                        "type": "object",
                        "properties": {
                            "sessionId": { "type": "string" },
                            "prompt": { "type": "string" },
                            "providerId": { "type": "string" },
                            "modelId": { "type": "string" },
                            "reasoningEffort": { "type": "string" }
                        },
                        "required": ["sessionId", "prompt"]
                    })
                ),
                tool_def(
                    "stop_session",
                    "Withdraw a session the Mac has not started, or ask the Mac to stop a session it is running. A finished session stays saved.",
                    json!({
                        "type": "object",
                        "properties": { "sessionId": { "type": "string" } },
                        "required": ["sessionId"]
                    })
                ),
                tool_def(
                    "cancel_session",
                    "Withdraw a session the Mac has not started. A session Gyro already started must be stopped.",
                    json!({
                        "type": "object",
                        "properties": { "sessionId": { "type": "string" } },
                        "required": ["sessionId"]
                    })
                ),
                tool_def(
                    "resolve_approval",
                    "Deny an approval that is blocking a session. Approving stays with the person using Gyro.",
                    json!({
                        "type": "object",
                        "properties": {
                            "proposalId": { "type": "string" },
                            "decision": { "type": "string", "enum": ["deny", "allow"] }
                        },
                        "required": ["proposalId", "decision"]
                    })
                )
            ]
        })),
        "tools/call" => {
            let params = request.get("params").cloned().unwrap_or(json!({}));
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
            match call_tool(conn, name, &arguments) {
                Ok(payload) => Ok(tool_result(payload, false)),
                Err(error) => Ok(tool_result(json!({"error": error}), true)),
            }
        }
        _ => Err("method not found"),
    };
    match result {
        Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}).to_string(),
        Err(message) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": message }
        })
        .to_string(),
    }
}

fn call_tool(conn: &Connection, name: &str, arguments: &Value) -> Result<Value, String> {
    match name {
        "list_workspaces" => list_workspaces(conn),
        "start_session" => start_session(conn, arguments),
        "session_status" => session_status(conn, arguments),
        "list_sessions" => list_sessions(conn, arguments),
        "read_session" => read_session(conn, arguments),
        "continue_session" => continue_session(conn, arguments),
        "stop_session" => stop_session(conn, arguments),
        "cancel_session" => cancel_session(conn, arguments),
        "resolve_approval" => resolve_approval(conn, arguments),
        _ => Err(format!("unknown tool {name}")),
    }
}

fn list_sessions(conn: &Connection, arguments: &Value) -> Result<Value, String> {
    let limit = argument_limit(arguments, 20, 50);
    let before = argument_before(arguments)?;
    let online = mac_is_online(conn);
    let mut stmt = conn
        .prepare(
            "select id, session_id, workspace, status, prompt, summary, updated_at
             from relay_tasks
             where ?1 is null or updated_at < ?1
             order by updated_at desc
             limit ?2",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![before, limit as i64], |row| {
            let id: String = row.get(0)?;
            let gyro: Option<String> = row.get(1)?;
            let workspace: String = row.get(2)?;
            let status: String = row.get(3)?;
            let prompt: String = row.get(4)?;
            let summary: Option<String> = row.get(5)?;
            let updated_at: String = row.get(6)?;
            let title_source = if prompt.trim().is_empty() {
                summary.unwrap_or_default()
            } else {
                prompt
            };
            Ok(json!({
                "sessionId": id,
                "gyroSessionId": gyro,
                "workspace": workspace,
                "status": visible_status(&status, online),
                "title": session_title(&title_source),
                "updatedAt": updated_at,
            }))
        })
        .map_err(|error| error.to_string())?;
    let sessions = rows
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(json!({ "sessions": sessions }))
}

fn read_session(conn: &Connection, arguments: &Value) -> Result<Value, String> {
    let task = require_task(conn, arguments)?;
    if let Some(page) = stored_page(conn, &task.id)? {
        let _ = conn.execute(
            "delete from relay_read_pages where task_id = ?1",
            params![task.id],
        );
        return page_payload(page);
    }
    if read_token_set(conn, &task.id)? {
        return Ok(pending_read(&task, mac_is_online(conn)));
    }
    let after = optional_text(arguments, "after");
    if let Some(after) = &after {
        if Uuid::parse_str(after).is_err() {
            return Err("unknown cursor".into());
        }
    }
    let limit = argument_limit(arguments, 20, 20) as i64;
    let token = Uuid::new_v4().to_string();
    conn.execute(
        "update relay_tasks
         set read_token = ?1, read_after = ?2, read_limit = ?3
         where id = ?4 and read_token is null",
        params![token, after, limit, task.id],
    )
    .map_err(|error| error.to_string())?;
    Ok(pending_read(&task, mac_is_online(conn)))
}

fn continue_session(conn: &Connection, arguments: &Value) -> Result<Value, String> {
    let task = require_task(conn, arguments)?;
    if task.status != "done" && task.status != "failed" {
        return Err(format!("session is still {}", task.status));
    }
    let prompt = required_text(arguments, "prompt")?;
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err(format!(
            "prompt cannot exceed {MAX_PROMPT_CHARS} characters"
        ));
    }
    let device = device(conn)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Mac is not paired".to_string())?;
    let choice = ChoiceRequest {
        provider_id: optional_text(arguments, "providerId"),
        model_id: optional_text(arguments, "modelId"),
        reasoning_effort: optional_text(arguments, "reasoningEffort"),
    };
    resolve_choice(&catalog_of(&device), &choice).map_err(|error| error.to_string())?;
    insert_command(
        conn,
        &task.id,
        "continue",
        json!({
            "prompt": prompt,
            "providerId": choice.provider_id,
            "modelId": choice.model_id,
            "reasoningEffort": choice.reasoning_effort,
        }),
    )?;
    let online = mac_online(conn, &device);
    Ok(json!({
        "sessionId": task.id,
        "gyroSessionId": task.session_id,
        "status": if online { "queued" } else { "offline" },
    }))
}

fn stop_session(conn: &Connection, arguments: &Value) -> Result<Value, String> {
    let task = require_task(conn, arguments)?;
    if task_accepted(conn, &task.id)?.is_none() {
        delete_task(conn, &task.id)?;
        return Ok(json!({ "sessionId": task.id, "status": "cancelled" }));
    }
    if task.status == "done" || task.status == "failed" {
        return Ok(json!({
            "sessionId": task.id,
            "gyroSessionId": task.session_id,
            "status": task.status,
        }));
    }
    insert_command(conn, &task.id, "stop", json!({}))?;
    let online = mac_is_online(conn);
    Ok(json!({
        "sessionId": task.id,
        "gyroSessionId": task.session_id,
        "status": if online { "stop-requested" } else { "offline" },
    }))
}

fn cancel_session(conn: &Connection, arguments: &Value) -> Result<Value, String> {
    let task = require_task(conn, arguments)?;
    if task_accepted(conn, &task.id)?.is_some() {
        return Err("Gyro already started this session; stop it in Gyro".into());
    }
    delete_task(conn, &task.id)?;
    Ok(json!({ "sessionId": task.id, "status": "cancelled" }))
}

fn resolve_approval(conn: &Connection, arguments: &Value) -> Result<Value, String> {
    let proposal_id = required_text(arguments, "proposalId")?;
    if Uuid::parse_str(&proposal_id).is_err() {
        return Err("unknown approval".into());
    }
    match required_text(arguments, "decision")?.as_str() {
        "allow" => Err(
            "Only the person using Gyro can approve. Deny it here, or approve it in Gyro.".into(),
        ),
        "deny" => {
            let task_id = task_id_for_proposal(conn, &proposal_id)?
                .ok_or_else(|| "unknown approval".to_string())?;
            insert_command(
                conn,
                &task_id,
                "deny",
                json!({ "proposalId": proposal_id }),
            )?;
            Ok(json!({ "proposalId": proposal_id, "decision": "denied" }))
        }
        other => Err(format!("decision must be deny or allow, not {other}")),
    }
}

fn require_task(conn: &Connection, arguments: &Value) -> Result<TaskRow, String> {
    let id = required_text(arguments, "sessionId")?;
    if Uuid::parse_str(&id).is_err() {
        return Err("unknown session".into());
    }
    task_by_id(conn, &id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "unknown session".to_string())
}

fn pending_read(task: &TaskRow, online: bool) -> Value {
    json!({
        "sessionId": task.id,
        "gyroSessionId": task.session_id,
        "pending": true,
        "status": visible_status(&task.status, online),
    })
}

fn pending_approval_value(conn: &Connection, task_id: &str) -> Result<Value> {
    let raw: Option<String> = conn.query_row(
        "select pending_approval_json from relay_tasks where id = ?1",
        params![task_id],
        |row| row.get(0),
    )?;
    Ok(match raw {
        Some(text) => serde_json::from_str(&text).unwrap_or(Value::Null),
        None => Value::Null,
    })
}

fn mac_is_online(conn: &Connection) -> bool {
    device(conn)
        .ok()
        .flatten()
        .is_some_and(|row| mac_online(conn, &row))
}

fn task_accepted(conn: &Connection, task_id: &str) -> Result<Option<i64>, String> {
    conn.query_row(
        "select accepted from relay_tasks where id = ?1",
        params![task_id],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

fn delete_task(conn: &Connection, task_id: &str) -> Result<(), String> {
    conn.execute(
        "delete from relay_commands where task_id = ?1",
        params![task_id],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        "delete from relay_read_pages where task_id = ?1",
        params![task_id],
    )
    .map_err(|error| error.to_string())?;
    conn.execute("delete from relay_tasks where id = ?1", params![task_id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn insert_command(
    conn: &Connection,
    task_id: &str,
    kind: &str,
    payload: Value,
) -> Result<(), String> {
    conn.execute(
        "insert into relay_commands (id, task_id, kind, payload_json, created_at)
         values (?1, ?2, ?3, ?4, ?5)",
        params![
            Uuid::new_v4().to_string(),
            task_id,
            kind,
            payload.to_string(),
            Utc::now().to_rfc3339(),
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn stored_page(conn: &Connection, task_id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "select page_json from relay_read_pages where task_id = ?1 limit 1",
        params![task_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn read_token_set(conn: &Connection, task_id: &str) -> Result<bool, String> {
    let token: Option<String> = conn
        .query_row(
            "select read_token from relay_tasks where id = ?1",
            params![task_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(token.is_some())
}

fn page_payload(page: String) -> Result<Value, String> {
    let value: Value =
        serde_json::from_str(&page).unwrap_or_else(|_| json!({ "error": "unreadable page" }));
    let value = value.get("page").cloned().unwrap_or(value);
    if value.get("turns").is_none() {
        if let Some(message) = value.get("error").and_then(Value::as_str) {
            return Err(message.to_string());
        }
    }
    Ok(value)
}

fn task_id_for_proposal(conn: &Connection, proposal_id: &str) -> Result<Option<String>, String> {
    let mut stmt = conn
        .prepare(
            "select id, pending_approval_json
             from relay_tasks
             where pending_approval_json is not null",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        let (id, pending) = row.map_err(|error| error.to_string())?;
        let Ok(value) = serde_json::from_str::<Value>(&pending) else {
            continue;
        };
        if value.get("proposalId").and_then(Value::as_str) == Some(proposal_id) {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

fn session_title(prompt: &str) -> String {
    let first = prompt.lines().next().unwrap_or(prompt).trim();
    let mut title = format!("Agent: {first}");
    if title.chars().count() > 160 {
        title = title.chars().take(160).collect();
    }
    title
}

fn argument_limit(arguments: &Value, default: u64, max: u64) -> usize {
    let raw = arguments
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(default);
    raw.clamp(1, max) as usize
}

fn argument_before(arguments: &Value) -> Result<Option<String>, String> {
    let Some(value) = optional_text(arguments, "before") else {
        return Ok(None);
    };
    let parsed = DateTime::parse_from_rfc3339(&value)
        .map_err(|_| "before must be a timestamp".to_string())?;
    Ok(Some(parsed.with_timezone(&Utc).to_rfc3339()))
}

fn list_workspaces(conn: &Connection) -> Result<Value, String> {
    let device = device(conn).map_err(|error| error.to_string())?;
    let Some(device) = device else {
        return Err("Mac is not paired".into());
    };
    let catalog = catalog_of(&device);
    Ok(json!({
        "workspaces": workspaces_of(&device),
        "selectedProviderId": catalog.selected_provider_id,
        "providers": catalog.providers,
        "mac": if mac_online(conn, &device) { "online" } else { "offline" }
    }))
}

fn start_session(conn: &Connection, arguments: &Value) -> Result<Value, String> {
    let device = device(conn)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Mac is not paired".to_string())?;
    let workspace = required_text(arguments, "workspace")?;
    let prompt = required_text(arguments, "prompt")?;
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err(format!(
            "prompt cannot exceed {MAX_PROMPT_CHARS} characters"
        ));
    }
    if !workspaces_of(&device).iter().any(|path| path == &workspace) {
        return Err("workspace is not allowed".into());
    }
    let catalog = catalog_of(&device);
    if catalog.providers.is_empty() {
        return Err("the Mac has not announced a provider catalog".into());
    }
    let choice = ChoiceRequest {
        provider_id: optional_text(arguments, "providerId"),
        model_id: optional_text(arguments, "modelId"),
        reasoning_effort: optional_text(arguments, "reasoningEffort"),
    };
    let resolved = resolve_choice(&catalog, &choice).map_err(|error| error.to_string())?;
    let id = Uuid::new_v4();
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "insert into relay_tasks (
           id, workspace, prompt, provider_id, provider_label, model_id, model_label,
           reasoning_effort, status, session_id, summary, error, accepted, created_at, updated_at
         ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'queued', null, null, null, null, ?9, ?10)",
        params![
            id.to_string(),
            workspace,
            prompt,
            resolved.provider_id,
            resolved.provider_label,
            resolved.model_id,
            resolved.model_label,
            resolved.reasoning_effort,
            now,
            now,
        ],
    )
    .map_err(|error| error.to_string())?;
    let online = mac_online(conn, &device);
    Ok(json!({
        "sessionId": id,
        "status": if online { "queued" } else { "offline" },
        "providerId": resolved.provider_id,
        "providerLabel": resolved.provider_label,
        "modelId": resolved.model_id,
        "modelLabel": resolved.model_label,
        "reasoningEffort": resolved.reasoning_effort
    }))
}

fn session_status(conn: &Connection, arguments: &Value) -> Result<Value, String> {
    let id = required_text(arguments, "sessionId")?;
    if Uuid::parse_str(&id).is_err() {
        return Err("unknown session".into());
    }
    let task = task_by_id(conn, &id).map_err(|error| error.to_string())?;
    let Some(task) = task else {
        return Err("unknown session".into());
    };
    let device = device(conn).map_err(|error| error.to_string())?;
    let online = device
        .as_ref()
        .is_some_and(|device| mac_online(conn, device));
    let pending = pending_approval_value(conn, &task.id).map_err(|error| error.to_string())?;
    Ok(json!({
        "sessionId": task.id,
        "gyroSessionId": task.session_id,
        "taskId": task.id,
        "status": visible_status(&task.status, online),
        "providerId": task.provider_id,
        "providerLabel": task.provider_label,
        "modelId": task.model_id,
        "modelLabel": task.model_label,
        "reasoningEffort": task.reasoning_effort,
        "summary": task.summary,
        "error": task.error,
        "pendingApproval": pending
    }))
}

struct DeviceRow {
    workspaces_json: String,
    catalog_json: String,
    last_seen: Option<String>,
}

struct TaskRow {
    id: String,
    status: String,
    session_id: Option<String>,
    provider_id: Option<String>,
    provider_label: Option<String>,
    model_id: Option<String>,
    model_label: Option<String>,
    reasoning_effort: Option<String>,
    summary: Option<String>,
    error: Option<String>,
}

fn device(conn: &Connection) -> Result<Option<DeviceRow>> {
    conn.query_row(
        "select workspaces_json, catalog_json, last_seen from relay_device where id = 1",
        [],
        |row| {
            Ok(DeviceRow {
                workspaces_json: row.get(0)?,
                catalog_json: row.get(1)?,
                last_seen: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

fn bearer_device(conn: &Connection, bearer: Option<&str>) -> Option<DeviceRow> {
    let bearer = bearer?;
    let secret: String = conn
        .query_row("select secret from relay_device where id = 1", [], |row| {
            row.get(0)
        })
        .optional()
        .ok()??;
    if !tokens_match(&secret, bearer) {
        return None;
    }
    device(conn).ok()?
}

fn authorized_device(conn: &Connection, bearer: Option<&str>, body: &Value) -> Option<DeviceRow> {
    let device_row = bearer_device(conn, bearer)?;
    let presented = body.get("deviceId").and_then(Value::as_str).unwrap_or("");
    let stored: String = conn
        .query_row(
            "select device_id from relay_device where id = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .ok()??;
    if presented != stored {
        return None;
    }
    Some(device_row)
}

fn agent_authorized(conn: &Connection, bearer: Option<&str>) -> bool {
    let Some(bearer) = bearer else {
        return false;
    };
    meta_value(conn, "agent_token")
        .map(|expected| tokens_match(&expected, bearer))
        .unwrap_or(false)
}

fn meta_value(conn: &Connection, column: &str) -> Option<String> {
    let sql = match column {
        "pairing_code" => "select pairing_code from relay_meta where id = 1",
        "agent_token" => "select agent_token from relay_meta where id = 1",
        _ => return None,
    };
    conn.query_row(sql, [], |row| row.get(0)).ok()
}

fn pending_tasks(conn: &Connection) -> Result<Vec<Value>> {
    let mut stmt = conn.prepare(
        "select id, workspace, prompt, provider_id, model_id, reasoning_effort
         from relay_tasks where accepted is null
         order by created_at asc limit 20",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(json!({
            "id": row.get::<_, String>(0)?,
            "workspace": row.get::<_, String>(1)?,
            "prompt": row.get::<_, String>(2)?,
            "providerId": row.get::<_, Option<String>>(3)?,
            "modelId": row.get::<_, Option<String>>(4)?,
            "reasoningEffort": row.get::<_, Option<String>>(5)?
        }))
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

fn pending_commands(conn: &Connection) -> Result<Vec<Value>> {
    let mut stmt = conn.prepare(
        "select id, task_id, kind, payload_json
         from relay_commands
         order by created_at asc
         limit 20",
    )?;
    let rows = stmt.query_map([], |row| {
        let id: String = row.get(0)?;
        let task_id: String = row.get(1)?;
        let kind: String = row.get(2)?;
        let payload: String = row.get(3)?;
        let mut value = serde_json::from_str::<Value>(&payload).unwrap_or_else(|_| json!({}));
        let Some(object) = value.as_object_mut() else {
            return Ok(json!({ "id": id, "taskId": task_id, "kind": kind }));
        };
        object.insert("id".into(), Value::String(id));
        object.insert("taskId".into(), Value::String(task_id));
        object.insert("kind".into(), Value::String(kind));
        Ok(value)
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

fn pending_reads(conn: &Connection) -> Result<Vec<Value>> {
    let mut stmt = conn.prepare(
        "select id, read_after, read_token, read_limit
         from relay_tasks
         where read_token is not null
         order by updated_at asc
         limit 20",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(json!({
            "taskId": row.get::<_, String>(0)?,
            "after": row.get::<_, Option<String>>(1)?,
            "token": row.get::<_, String>(2)?,
            "limit": row.get::<_, Option<i64>>(3)?,
        }))
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

fn apply_report(conn: &Connection, report: &Value, now: &str) -> Result<()> {
    let Some(task_id) = report.get("taskId").and_then(Value::as_str).map(str::trim) else {
        return Ok(());
    };
    if task_id.is_empty() {
        return Ok(());
    }
    let exists: Option<i64> = conn
        .query_row(
            "select 1 from relay_tasks where id = ?1",
            params![task_id],
            |row| row.get(0),
        )
        .optional()?;
    if exists.is_none() {
        return Ok(());
    }
    let status = report
        .get("status")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| {
            matches!(
                *value,
                "queued" | "running" | "waiting-for-approval" | "done" | "failed"
            )
        });
    let summary = report
        .get("summary")
        .and_then(Value::as_str)
        .map(bounded_agent_summary);
    let error = report
        .get("error")
        .and_then(Value::as_str)
        .map(bounded_agent_summary);
    let session_id = report
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| Uuid::parse_str(value).is_ok());
    let pending_approval = match report.get("pendingApproval") {
        Some(Value::Null) | None => None,
        Some(value) => Some(value.to_string()),
    };
    conn.execute(
        "update relay_tasks set
           status = coalesce(?1, status),
           summary = coalesce(?2, summary),
           error = coalesce(?3, error),
           provider_id = coalesce(?4, provider_id),
           provider_label = coalesce(?5, provider_label),
           model_id = coalesce(?6, model_id),
           model_label = coalesce(?7, model_label),
           reasoning_effort = coalesce(?8, reasoning_effort),
           session_id = coalesce(?9, session_id),
           pending_approval_json = ?10,
           prompt = case when coalesce(?1, status) in ('done', 'failed') then '' else prompt end,
           updated_at = ?11
         where id = ?12",
        params![
            status,
            summary,
            error,
            limited_text(report.get("providerId")),
            limited_text(report.get("providerLabel")),
            limited_text(report.get("modelId")),
            limited_text(report.get("modelLabel")),
            limited_text(report.get("reasoningEffort")),
            session_id,
            pending_approval,
            now,
            task_id,
        ],
    )?;
    Ok(())
}

fn task_by_id(conn: &Connection, id: &str) -> Result<Option<TaskRow>> {
    conn.query_row(
        "select id, status, session_id, provider_id, provider_label, model_id, model_label,
                reasoning_effort, summary, error
         from relay_tasks where id = ?1 or session_id = ?1",
        params![id],
        |row| {
            Ok(TaskRow {
                id: row.get(0)?,
                status: row.get(1)?,
                session_id: row.get(2)?,
                provider_id: row.get(3)?,
                provider_label: row.get(4)?,
                model_id: row.get(5)?,
                model_label: row.get(6)?,
                reasoning_effort: row.get(7)?,
                summary: row.get(8)?,
                error: row.get(9)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

fn workspaces_of(device: &DeviceRow) -> Vec<String> {
    serde_json::from_str(&device.workspaces_json).unwrap_or_default()
}

fn catalog_of(device: &DeviceRow) -> ChoiceCatalog {
    serde_json::from_str(&device.catalog_json).unwrap_or_default()
}

fn mac_online(conn: &Connection, device: &DeviceRow) -> bool {
    let Some(seen) = device.last_seen.as_deref() else {
        return false;
    };
    let Ok(seen) = DateTime::parse_from_rfc3339(seen) else {
        return false;
    };
    let millis: i64 = conn
        .query_row(
            "select offline_after_ms from relay_meta where id = 1",
            [],
            |row| row.get(0),
        )
        .unwrap_or(DEFAULT_OFFLINE_AFTER_MS);
    let limit = chrono::Duration::milliseconds(millis.max(0));
    Utc::now().signed_duration_since(seen.with_timezone(&Utc)) <= limit
}

fn visible_status(stored: &str, online: bool) -> String {
    if online || stored == "done" || stored == "failed" {
        stored.to_string()
    } else {
        "offline".to_string()
    }
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty() && item.len() <= 4096)
                .take(64)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn required_text(arguments: &Value, key: &str) -> Result<String, String> {
    optional_text(arguments, key).ok_or_else(|| format!("{key} is required"))
}

fn optional_text(arguments: &Value, key: &str) -> Option<String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn limited_text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(200).collect())
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

fn codes_match(expected: &str, presented: &str) -> bool {
    if expected.len() != presented.len() || expected.is_empty() {
        return false;
    }
    let mut diff = 0u8;
    for (left, right) in expected.bytes().zip(presented.bytes()) {
        diff |= left ^ right;
    }
    diff == 0
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

fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    OsRng.fill_bytes(&mut buffer);
    encode_hex(&buffer)
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

fn read_request(stream: &mut TcpStream) -> Result<Option<(String, Vec<u8>)>> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            return Ok(None);
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(end) = find_header_end(&buffer) {
            break end;
        }
        if buffer.len() > 64 * 1024 {
            return Ok(None);
        }
    };
    let head = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let mut body = buffer[header_end + 4..].to_vec();
    let length = content_length(&head).unwrap_or(0);
    if length > MAX_HTTP_BODY {
        write_http(stream, 413, br#"{"error":"body too large"}"#)?;
        return Ok(None);
    }
    while body.len() < length {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(length);
    Ok(Some((head, body)))
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

fn request_path(head: &str) -> &str {
    head.lines()
        .next()
        .unwrap_or("")
        .split_whitespace()
        .nth(1)
        .unwrap_or("")
        .split('?')
        .next()
        .unwrap_or("")
}

fn write_http(stream: &mut TcpStream, status: u16, body: &[u8]) -> Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_sessions::{
        pair_outbound, poll_paired_relay, AgentSessionStore, ModelChoices, ProviderChoices,
    };
    use crate::paths::GyroPaths;
    use crate::sessions::{SessionEventKind, SessionStore};

    fn catalog() -> ChoiceCatalog {
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

    fn post_json(url: &str, bearer: Option<&str>, body: Value) -> (u16, Value) {
        let mut last = String::new();
        for _ in 0..30 {
            let agent = ureq::AgentBuilder::new()
                .timeout_connect(Duration::from_secs(2))
                .timeout_read(Duration::from_secs(2))
                .timeout(Duration::from_secs(2))
                .redirects(0)
                .build();
            let mut request = agent.post(url).set("Content-Type", "application/json");
            if let Some(bearer) = bearer {
                request = request.set("Authorization", &format!("Bearer {bearer}"));
            }
            match request.send_json(body.clone()) {
                Ok(response) => return (200, response.into_json().unwrap()),
                Err(ureq::Error::Status(status, response)) => {
                    let text = response.into_string().unwrap_or_default();
                    let value = serde_json::from_str(&text).unwrap_or(json!({"raw": text}));
                    return (status, value);
                }
                Err(error) => {
                    last = error.to_string();
                    thread::sleep(Duration::from_millis(20));
                }
            }
        }
        panic!("no relay response: {last}");
    }

    fn tool(origin: &str, token: &str, name: &str, arguments: Value) -> (bool, Value) {
        let (_status, body) = post_json(
            &format!("{origin}/mcp"),
            Some(token),
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": { "name": name, "arguments": arguments }
            }),
        );
        let is_error = body["result"]["isError"].as_bool().unwrap_or(true);
        let text = body["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let payload = serde_json::from_str(&text).unwrap_or(json!({"raw": text}));
        (is_error, payload)
    }

    fn database_text(dir: &Path) -> String {
        ["relay.sqlite3", "relay.sqlite3-wal", "relay.sqlite3-shm"]
            .into_iter()
            .fold(Vec::new(), |mut combined, name| {
                if let Ok(bytes) = fs::read(dir.join(name)) {
                    combined.extend(bytes);
                }
                combined
            })
            .into_iter()
            .map(|byte| byte as char)
            .collect()
    }

    #[test]
    fn relay_refuses_a_public_bind_without_the_operator_flag() {
        let temp = tempfile::tempdir().unwrap();
        match AgentRelayServer::start(temp.path().join("relay"), "0.0.0.0:0", None) {
            Ok(_) => panic!("public bind should fail"),
            Err(error) => {
                let error = error.to_string();
                assert!(
                    error.contains("GYRO_RELAY_PUBLIC"),
                    "public bind should name the operator flag, got {error}"
                );
            }
        }
    }

    #[test]
    fn relay_lists_starts_and_reports_without_storing_a_transcript() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let blocked = temp.path().join("blocked");
        fs::create_dir_all(&blocked).unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("gyro"));
        let store = AgentSessionStore::open(paths).unwrap();
        store.set_choice_catalog(&catalog()).unwrap();
        let allowed = store.allow_workspace(&workspace).unwrap();
        let relay_dir = temp.path().join("relay");
        let relay =
            AgentRelayServer::start(relay_dir.clone(), "127.0.0.1:0", Some("relay-code".into()))
                .unwrap();
        let origin = relay.origin().to_string();
        let token = relay.agent_token().to_string();

        let (error, payload) = tool(&origin, &token, "list_workspaces", json!({}));
        assert!(error);
        assert!(payload["error"].as_str().unwrap().contains("not paired"));

        let rejected = pair_outbound(store.paths(), &origin, "wrong-code").unwrap_err();
        assert!(rejected.to_string().contains("rejected the Mac"));
        assert!(store.pairing().unwrap().is_none());

        pair_outbound(store.paths(), &origin, "relay-code").unwrap();
        let device_secret =
            fs::read_to_string(store.paths().base_dir.join("agent-session-pairing.secret"))
                .unwrap();
        let device_secret = device_secret.trim().to_string();
        let (status, _) = post_json(
            &format!("{origin}/mcp"),
            Some(&device_secret),
            json!({"jsonrpc":"2.0","id":1,"method":"ping"}),
        );
        assert_eq!(status, 401);
        let (status, _) = post_json(
            &format!("{origin}/v1/poll"),
            Some(&token),
            json!({"deviceId": store.pairing().unwrap().unwrap().device_id}),
        );
        assert_eq!(status, 401);

        assert!(poll_paired_relay(store.paths()).unwrap().is_empty());
        let (error, listed) = tool(&origin, &token, "list_workspaces", json!({}));
        assert!(!error);
        assert_eq!(listed["mac"], "online");
        assert_eq!(listed["workspaces"][0], allowed.display().to_string());
        assert_eq!(listed["selectedProviderId"], "openai");
        assert_eq!(listed["providers"][0]["id"], "openai");

        let (error, refused) = tool(
            &origin,
            &token,
            "start_session",
            json!({
                "workspace": allowed.display().to_string(),
                "prompt": "DO-NOT-STORE-PROVIDER",
                "providerId": "closed"
            }),
        );
        assert!(error);
        assert!(refused["error"].as_str().unwrap().contains("not enabled"));
        let (error, refused) = tool(
            &origin,
            &token,
            "start_session",
            json!({
                "workspace": blocked.canonicalize().unwrap().display().to_string(),
                "prompt": "DO-NOT-STORE-WORKSPACE"
            }),
        );
        assert!(error);
        assert!(refused["error"].as_str().unwrap().contains("not allowed"));
        let stored = database_text(&relay_dir);
        assert!(!stored.contains("DO-NOT-STORE-PROVIDER"));
        assert!(!stored.contains("DO-NOT-STORE-WORKSPACE"));

        let (error, started) = tool(
            &origin,
            &token,
            "start_session",
            json!({
                "workspace": allowed.display().to_string(),
                "prompt": "Say hello"
            }),
        );
        assert!(!error, "{started}");
        assert_eq!(started["status"], "queued");
        assert_eq!(started["providerId"], "openai");
        assert_eq!(started["providerLabel"], "OpenAI");
        assert_eq!(started["modelId"], "gpt-test");
        assert_eq!(started["reasoningEffort"], "medium");
        let task_id = started["sessionId"].as_str().unwrap().to_string();

        let pulled = poll_paired_relay(store.paths()).unwrap();
        assert_eq!(pulled.len(), 1);
        assert!(poll_paired_relay(store.paths()).unwrap().is_empty());
        let (error, status) = tool(
            &origin,
            &token,
            "session_status",
            json!({"sessionId": task_id}),
        );
        assert!(!error, "{status}");
        assert_eq!(status["status"], "queued");
        assert_eq!(status["modelLabel"], "GPT Test");
        assert_eq!(status["sessionId"], task_id);
        assert_eq!(status["gyroSessionId"], pulled[0].session_id.to_string());

        let running = store.claim_next().unwrap().unwrap();
        assert!(store
            .finish(running.id, Ok("note sk-abcdefghijklmnopqrstuvwxyz".into()),)
            .unwrap());
        assert!(poll_paired_relay(store.paths()).unwrap().is_empty());
        let (error, status) = tool(
            &origin,
            &token,
            "session_status",
            json!({"sessionId": task_id}),
        );
        assert!(!error, "{status}");
        assert_eq!(status["status"], "done");
        assert!(status["summary"].as_str().unwrap().contains("[REDACTED]"));
        assert!(!status.to_string().contains("sk-abcdefghijklmnopqrstuvwxyz"));

        let device_id = store.pairing().unwrap().unwrap().device_id;
        let (_status, _) = post_json(
            &format!("{origin}/v1/poll"),
            Some(&device_secret),
            json!({
                "deviceId": device_id,
                "reports": [{
                    "taskId": task_id,
                    "status": "done",
                    "summary": "leaked sk-abcdefghijklmnopqrstuvwxyz",
                    "transcript": "SECRET-TRANSCRIPT",
                    "file": "SECRET-FILE-BODY"
                }]
            }),
        );
        let (error, status) = tool(
            &origin,
            &token,
            "session_status",
            json!({"sessionId": task_id}),
        );
        assert!(!error, "{status}");
        assert!(status["summary"].as_str().unwrap().contains("[REDACTED]"));
        assert!(!status.to_string().contains("SECRET-TRANSCRIPT"));
        let stored = database_text(&relay_dir);
        assert!(!stored.contains("Say hello"));
        assert!(!stored.contains("SECRET-TRANSCRIPT"));
        assert!(!stored.contains("SECRET-FILE-BODY"));
        let stored_prompt: String = open_db(&relay_dir)
            .unwrap()
            .query_row(
                "select prompt from relay_tasks where id = ?1",
                params![task_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(stored_prompt.is_empty());
        assert!(!stored.contains("sk-abcdefghijklmnopqrstuvwxyz"));

        relay.set_offline_after(Duration::ZERO).unwrap();
        let (error, asleep) = tool(
            &origin,
            &token,
            "start_session",
            json!({
                "workspace": allowed.display().to_string(),
                "prompt": "Wait for the Mac"
            }),
        );
        assert!(!error, "{asleep}");
        assert_eq!(asleep["status"], "offline");
        let (error, done) = tool(
            &origin,
            &token,
            "session_status",
            json!({"sessionId": task_id}),
        );
        assert!(!error, "{done}");
        assert_eq!(done["status"], "done");

        let saved_token = token.clone();
        drop(relay);
        let restarted = AgentRelayServer::start(relay_dir, "127.0.0.1:0", None).unwrap();
        assert_eq!(restarted.agent_token(), saved_token);
        assert_eq!(restarted.pairing_code(), "relay-code");
        let (error, done) = tool(
            restarted.origin(),
            restarted.agent_token(),
            "session_status",
            json!({"sessionId": task_id}),
        );
        assert!(!error, "{done}");
        assert_eq!(done["status"], "done");
        assert!(done.get("workspace").is_none());
        assert!(done.get("prompt").is_none());
    }

    #[test]
    fn relay_controls_the_same_saved_session() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("gyro"));
        let store = AgentSessionStore::open(paths).unwrap();
        store.set_choice_catalog(&catalog()).unwrap();
        let allowed = store.allow_workspace(&workspace).unwrap();
        let relay_dir = temp.path().join("relay");
        let relay =
            AgentRelayServer::start(relay_dir.clone(), "127.0.0.1:0", Some("relay-code".into()))
                .unwrap();
        let origin = relay.origin().to_string();
        let token = relay.agent_token().to_string();
        pair_outbound(store.paths(), &origin, "relay-code").unwrap();
        assert!(poll_paired_relay(store.paths()).unwrap().is_empty());

        let (error, started) = tool(
            &origin,
            &token,
            "start_session",
            json!({
                "workspace": allowed.display().to_string(),
                "prompt": "First task"
            }),
        );
        assert!(!error, "{started}");
        let queued_id = started["sessionId"].as_str().unwrap().to_string();
        let (error, cancelled) = tool(
            &origin,
            &token,
            "cancel_session",
            json!({"sessionId": queued_id}),
        );
        assert!(!error, "{cancelled}");
        assert_eq!(cancelled["status"], "cancelled");
        assert!(poll_paired_relay(store.paths()).unwrap().is_empty());

        let (error, started) = tool(
            &origin,
            &token,
            "start_session",
            json!({
                "workspace": allowed.display().to_string(),
                "prompt": "Say hello"
            }),
        );
        assert!(!error, "{started}");
        let task_id = started["sessionId"].as_str().unwrap().to_string();
        let pulled = poll_paired_relay(store.paths()).unwrap();
        assert_eq!(pulled.len(), 1);
        let gyro_id = pulled[0].session_id;
        let (error, status) = tool(
            &origin,
            &token,
            "session_status",
            json!({"sessionId": task_id}),
        );
        assert!(!error, "{status}");
        assert_eq!(status["sessionId"], task_id);
        assert_eq!(status["gyroSessionId"], gyro_id.to_string());
        let (error, early) = tool(
            &origin,
            &token,
            "continue_session",
            json!({"sessionId": task_id, "prompt": "too soon"}),
        );
        assert!(error, "{early}");
        assert!(early["error"].as_str().unwrap().contains("still queued"));

        let running = store.claim_next().unwrap().unwrap();
        let proposal_id = Uuid::new_v4();
        assert!(store
            .note_command_block(running.session_id.unwrap(), proposal_id, "cargo test")
            .unwrap());
        assert!(poll_paired_relay(store.paths()).unwrap().is_empty());
        let (error, status) = tool(
            &origin,
            &token,
            "session_status",
            json!({"sessionId": task_id}),
        );
        assert!(!error, "{status}");
        assert_eq!(status["status"], "waiting-for-approval");
        assert_eq!(status["pendingApproval"]["tool"], "command");
        assert_eq!(status["pendingApproval"]["proposalId"], proposal_id.to_string());
        let (error, allowed_decision) = tool(
            &origin,
            &token,
            "resolve_approval",
            json!({"proposalId": proposal_id, "decision": "allow"}),
        );
        assert!(error, "{allowed_decision}");
        assert!(allowed_decision["error"]
            .as_str()
            .unwrap()
            .contains("Only the person using Gyro can approve"));
        let (error, denied) = tool(
            &origin,
            &token,
            "resolve_approval",
            json!({"proposalId": proposal_id, "decision": "deny"}),
        );
        assert!(!error, "{denied}");
        assert_eq!(denied["decision"], "denied");
        assert!(poll_paired_relay(store.paths()).unwrap().is_empty());
        assert!(poll_paired_relay(store.paths()).unwrap().is_empty());
        let (error, status) = tool(
            &origin,
            &token,
            "session_status",
            json!({"sessionId": task_id}),
        );
        assert!(!error, "{status}");
        assert_eq!(status["status"], "failed");
        assert_eq!(status["error"], "stopped");

        let (error, continued) = tool(
            &origin,
            &token,
            "continue_session",
            json!({"sessionId": task_id, "prompt": "Second task"}),
        );
        assert!(!error, "{continued}");
        assert_eq!(continued["status"], "queued");
        assert_eq!(continued["sessionId"], task_id);
        assert_eq!(continued["gyroSessionId"], gyro_id.to_string());
        assert!(poll_paired_relay(store.paths()).unwrap().is_empty());
        let again = store.claim_next().unwrap().unwrap();
        assert_eq!(again.session_id, Some(gyro_id));
        assert_eq!(again.prompt, "Second task");
        assert!(store.finish(again.id, Ok("done".into())).unwrap());
        assert!(poll_paired_relay(store.paths()).unwrap().is_empty());
        let (error, status) = tool(
            &origin,
            &token,
            "session_status",
            json!({"sessionId": task_id}),
        );
        assert!(!error, "{status}");
        assert_eq!(status["status"], "done");

        let sessions = SessionStore::open(store.paths().clone()).unwrap();
        sessions
            .append_event(
                gyro_id,
                SessionEventKind::AssistantMessage,
                "SECRET-PAGE-BODY",
                json!({}),
            )
            .unwrap();
        let (error, pending) = tool(
            &origin,
            &token,
            "read_session",
            json!({"sessionId": task_id}),
        );
        assert!(!error, "{pending}");
        assert_eq!(pending["pending"], true);
        assert!(poll_paired_relay(store.paths()).unwrap().is_empty());
        let (error, page) = tool(
            &origin,
            &token,
            "read_session",
            json!({"sessionId": task_id}),
        );
        assert!(!error, "{page}");
        assert!(page["turns"].to_string().contains("SECRET-PAGE-BODY"));
        assert_eq!(page["sessionId"], task_id);
        assert_eq!(page["gyroSessionId"], gyro_id.to_string());
        let relay_db = open_db(&relay_dir).unwrap();
        let pages_left: i64 = relay_db
            .query_row("select count(*) from relay_read_pages", [], |row| row.get(0))
            .unwrap();
        assert_eq!(pages_left, 0);
        drop(relay_db);

        let (error, listed) = tool(&origin, &token, "list_sessions", json!({}));
        assert!(!error, "{listed}");
        assert!(listed["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["sessionId"] == task_id));
        let (error, stayed) = tool(
            &origin,
            &token,
            "stop_session",
            json!({"sessionId": task_id}),
        );
        assert!(!error, "{stayed}");
        assert_eq!(stayed["status"], "done");

        let (error, started) = tool(
            &origin,
            &token,
            "start_session",
            json!({
                "workspace": allowed.display().to_string(),
                "prompt": "Third task"
            }),
        );
        assert!(!error, "{started}");
        let third_id = started["sessionId"].as_str().unwrap().to_string();
        assert_eq!(poll_paired_relay(store.paths()).unwrap().len(), 1);
        store.claim_next().unwrap().unwrap();
        let (error, stopping) = tool(
            &origin,
            &token,
            "stop_session",
            json!({"sessionId": third_id}),
        );
        assert!(!error, "{stopping}");
        assert_eq!(stopping["status"], "stop-requested");
        assert!(poll_paired_relay(store.paths()).unwrap().is_empty());
        assert!(poll_paired_relay(store.paths()).unwrap().is_empty());
        let (error, status) = tool(
            &origin,
            &token,
            "session_status",
            json!({"sessionId": third_id}),
        );
        assert!(!error, "{status}");
        assert_eq!(status["status"], "failed");
        assert_eq!(status["error"], "stopped");
    }
}
