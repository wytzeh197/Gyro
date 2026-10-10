//! Gyro-owned asynchronous delegation. Provider threads never own child lifetime.
use super::*;
use chrono::Utc;
use serde_json::{json, Value};

const EVENT: &str = "gyro://subagent-event";
const MAX_TASK_CHARS: usize = 16_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgentSnapshot {
    pub agent_id: String,
    pub parent_session_id: String,
    pub parent_turn_id: Option<String>,
    pub name: String,
    pub task: String,
    pub provider_id: String,
    pub model_id: Option<String>,
    pub read_only: bool,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub started_at: Option<String>,
    pub elapsed_ms: u64,
    pub tokens: Option<UsageTokens>,
    pub run_id: String,
    pub summary: Option<String>,
    pub error: Option<String>,
}

struct AgentEntry {
    snapshot: AgentSnapshot,
    request: ProviderChatRequest,
    ceiling: CapabilityPolicySnapshot,
    previous_tokens: Option<UsageTokens>,
    pending: Vec<String>,
    delivered: bool,
}

#[derive(Default)]
pub(super) struct AgentManager {
    entries: Mutex<HashMap<String, AgentEntry>>,
}

fn is_live(status: &str) -> bool {
    matches!(status, "running" | "waiting" | "stopping")
}

fn owned(entry: &AgentSnapshot, parent: &str) -> anyhow::Result<()> {
    if entry.parent_session_id != parent {
        anyhow::bail!("this agent belongs to another chat");
    }
    Ok(())
}

pub(super) fn validate_caller(
    store: &SessionStore,
    bound: &BoundProviderCapabilityContext,
    id: CapabilityId,
) -> anyhow::Result<()> {
    if matches!(
        id,
        CapabilityId::AgentSpawn | CapabilityId::AgentSend | CapabilityId::ResearchRun
    ) {
        let session = store
            .get_session(Uuid::parse_str(&bound.session_id)?)?
            .ok_or_else(|| anyhow::anyhow!("owning chat no longer exists"))?;
        if session.parent_session_id.is_some() {
            anyhow::bail!("sub-agents cannot delegate or launch other agents");
        }
    }
    Ok(())
}

fn task_text(value: &str) -> anyhow::Result<String> {
    let text = value.trim();
    if text.is_empty() || text.chars().count() > MAX_TASK_CHARS {
        anyhow::bail!("agent tasks must contain 1–{MAX_TASK_CHARS} characters");
    }
    Ok(gyro_core::security::redact_secrets(text))
}

fn publish(app: &tauri::AppHandle, snapshot: &AgentSnapshot, persist: bool) -> anyhow::Result<()> {
    if persist {
        let store = open_store().map_err(anyhow::Error::msg)?;
        let event = store.append_event_with_turn_id(
            Uuid::parse_str(&snapshot.parent_session_id)?,
            SessionEventKind::SystemEvent,
            format!("{}: {}", snapshot.name, snapshot.status),
            json!({"kind": "subagent-state", "agent": snapshot}),
            snapshot
                .parent_turn_id
                .as_deref()
                .map(Uuid::parse_str)
                .transpose()?,
        )?;
        let _ = app.emit(PROVIDER_CAPABILITY_EVENT, event);
        // A child may settle after the parent answer or after reopening the
        // chat. Publish the durable task total so both surfaces see the revision.
        if let Some(turn) = snapshot.parent_turn_id.as_deref().and_then(|id| Uuid::parse_str(id).ok()) {
            let parent = Uuid::parse_str(&snapshot.parent_session_id)?;
            if let Ok(Some(tokens)) = store.task_usage_tokens(parent, turn) {
                if let Ok(receipt) = store.append_event_with_turn_id(parent, SessionEventKind::SystemEvent, "",
                    json!({"kind": "provider-turn-tokens", "accountingVersion": 1, "turnTokens": tokens}), Some(turn)) {
                    let _ = app.emit(PROVIDER_CAPABILITY_EVENT, receipt);
                }
            }
        }
    }
    let _ = app.emit(EVENT, snapshot);
    Ok(())
}

pub(super) fn spawn(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    name: &str,
    task: &str,
) -> anyhow::Result<AgentSnapshot> {
    let store = open_store().map_err(anyhow::Error::msg)?;
    validate_caller(&store, bound, CapabilityId::AgentSpawn)?;
    let parent = store
        .get_session(Uuid::parse_str(&bound.session_id)?)?
        .ok_or_else(|| anyhow::anyhow!("parent chat disappeared"))?;
    let parent_request = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .map_err(|_| anyhow::anyhow!("run state unavailable"))?
        .get(&bound.session_id)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("parent turn is no longer running"))?
        .request
        .lock()
        .map_err(|_| anyhow::anyhow!("run request unavailable"))?
        .clone()
        .ok_or_else(|| anyhow::anyhow!("parent has no active request"))?;
    let task = task_text(task)?;
    let name = gyro_core::sanitize_capability_summary(name.trim());
    if name.is_empty() || name.chars().count() > 60 {
        anyhow::bail!("agent name must contain 1–60 characters");
    }
    let mut request = parent_request.clone();
    let read_only = inherit_parent_permissions(&mut request, &parent_request, &bound.policy);
    let child = store.create_subagent_session(
        &parent.workspace_path,
        SessionOrigin::Desktop,
        &name,
        CreateSessionContext {
            workspace_mode: parent.workspace_mode,
            branch: parent.branch.clone(),
            worktree_name: parent.worktree_name.clone(),
            provider_id: Some(parent_request.provider_id.clone()),
            provider_label: parent_request.provider_label.clone(),
            model_id: parent_request.model_id.clone(),
            model_label: parent_request.model_label.clone(),
            reasoning_effort: parent_request.reasoning_effort.clone(),
        },
        parent.id,
    )?;
    let roots = parent
        .workspace_identity
        .roots
        .iter()
        .map(|root| root.path.clone())
        .collect::<Vec<_>>();
    if let Err(error) = store.set_workspace_identity(child.id, &roots, &parent.workspace_path) {
        let _ = store.delete_session(child.id);
        return Err(error);
    }
    if let Err(error) = store.append_event(
        child.id,
        SessionEventKind::SystemEvent,
        "Delegation authority inherited",
        json!({
            "kind": "subagent-authority", "policy": bound.policy,
            "fullAccess": request.full_access,
            "requireCommandApproval": request.require_command_approval,
            "requireFileEditApproval": request.require_file_edit_approval,
        }),
    ) {
        let _ = store.delete_session(child.id);
        return Err(error);
    }
    let id = child.id.to_string();
    let control = match subagent_capability::ChildRunControl::claim(app, &id, &bound.session_id) {
        Ok(control) => control,
        Err(error) => {
            let _ = store.delete_session(child.id);
            return Err(error);
        }
    };
    let now = Utc::now().to_rfc3339();
    request.session_id = id.clone();
    request.turn_id = Some(Uuid::new_v4().to_string());
    request.suggest_title = false;
    request.goal = None;
    request.plan = None;
    request.attachments.clear();
    request.message = child_prompt(&task, read_only);
    let snapshot = AgentSnapshot {
        agent_id: id.clone(),
        parent_session_id: bound.session_id.clone(),
        parent_turn_id: bound.turn_id.clone(),
        name,
        task,
        provider_id: request.provider_id.clone(),
        model_id: request.model_id.clone(),
        read_only,
        status: "running".into(),
        created_at: now.clone(),
        updated_at: now.clone(),
        started_at: Some(now),
        elapsed_ms: 0,
        tokens: None,
        run_id: request.turn_id.clone().unwrap(),
        summary: None,
        error: None,
    };
    app.state::<AgentManager>()
        .entries
        .lock()
        .map_err(|_| anyhow::anyhow!("agent state unavailable"))?
        .insert(
            id.clone(),
            AgentEntry {
                snapshot: snapshot.clone(),
                request,
                ceiling: bound.policy.clone(),
                previous_tokens: None,
                pending: Vec::new(),
                delivered: false,
            },
        );
    if let Err(error) = publish(app, &snapshot, true) {
        app.state::<AgentManager>()
            .entries
            .lock()
            .ok()
            .map(|mut entries| entries.remove(&id));
        drop(control);
        let _ = store.delete_session(child.id);
        return Err(error);
    }
    start_worker(app.clone(), id, control);
    Ok(snapshot)
}

/// The parent's backend-bound permissions are the child's authority, including
/// on later turns. Task arguments must not silently select a different mode.
fn inherit_parent_permissions(
    child: &mut ProviderChatRequest,
    parent: &ProviderChatRequest,
    policy: &CapabilityPolicySnapshot,
) -> bool {
    child.mode = inherited_chat_mode(policy.mode);
    child.require_command_approval = parent.require_command_approval;
    child.require_file_edit_approval = parent.require_file_edit_approval;
    child.full_access = parent.full_access && policy.mode == CapabilityRunMode::Normal;
    policy.mode != CapabilityRunMode::Normal
}

fn inherited_chat_mode(mode: CapabilityRunMode) -> ChatMode {
    match mode {
        CapabilityRunMode::Normal => ChatMode::Normal,
        CapabilityRunMode::Plan => ChatMode::Plan,
        CapabilityRunMode::Council => ChatMode::Council,
    }
}

fn inherit_entry_permissions(
    entry: &mut AgentEntry,
    parent: &ProviderChatRequest,
    policy: &CapabilityPolicySnapshot,
) {
    entry.snapshot.read_only = inherit_parent_permissions(&mut entry.request, parent, policy);
    entry.ceiling = policy.clone();
}

fn child_prompt(task: &str, read_only: bool) -> String {
    format!("You are a {}sub-agent delegated by another Gyro chat. Work on the self-contained task below. You inherit the parent's permissions and approval setting. You share the parent's workspace: respect assigned file ownership and do not overwrite others' edits. You have your own independent Gyro Browser session: open and use it through the browser tools when needed. It runs in the background and does not appear in the parent's frontend. You cannot launch sub-agents. {}When done, return a report of results, changes, validation, and unresolved issues. Do not produce a plan or ask for duplicate approval; use the broker's approval flow.\n\nTask:\n{task}",
        if read_only { "read-only research " } else { "working " },
        if read_only { "You cannot write files or run commands. " } else { "" })
}

fn start_worker(app: tauri::AppHandle, id: String, initial: subagent_capability::ChildRunControl) {
    std::thread::spawn(move || {
        let mut control = Some(initial);
        loop {
            let request = match app
                .state::<AgentManager>()
                .entries
                .lock()
                .ok()
                .and_then(|entries| entries.get(&id).map(|entry| entry.request.clone()))
            {
                Some(request) => request,
                None => return,
            };
            if let Some((parent, parent_turn)) = app.state::<AgentManager>().entries.lock().ok()
                .and_then(|entries| entries.get(&id).map(|entry| (
                    entry.snapshot.parent_session_id.clone(), entry.snapshot.parent_turn_id.clone())))
            {
                if let (Ok(store), Ok(child), Some(child_turn), Ok(parent), Some(parent_turn)) = (
                    open_store(), Uuid::parse_str(&request.session_id),
                    request.turn_id.as_deref().and_then(|value| Uuid::parse_str(value).ok()),
                    Uuid::parse_str(&parent),
                    parent_turn.as_deref().and_then(|value| Uuid::parse_str(value).ok()),
                ) {
                    if let Err(error) = store.link_usage_turn(child, child_turn, parent, parent_turn) {
                        eprintln!("could not attribute child usage: {error}");
                    }
                }
            }
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                run_provider_chat_blocking(app.clone(), request.clone(), UsageOrigin::SubAgent)
            }))
            .unwrap_or_else(|_| Err("the sub-agent worker exited unexpectedly".into()));
            let stopped = provider_chat_cancelled(&app, &id);
            drop(control.take());
            let manager = app.state::<AgentManager>();
            let mut entries = match manager.entries.lock() {
                Ok(entries) => entries,
                Err(_) => return,
            };
            let Some(entry) = entries.get_mut(&id) else {
                return;
            };
            settle(entry, outcome, stopped);
            if let Ok(store) = open_store() {
                if let Ok(Some(tokens)) = store.session_usage_tokens(Uuid::parse_str(&id).unwrap()) {
                    entry.snapshot.tokens = Some(tokens);
                }
            }
            // Decide the queue while holding the same lock as send; no task can
            // land in the gap between settling and releasing the worker.
            if !stopped && !entry.pending.is_empty() {
                let task = entry.pending.remove(0);
                match subagent_capability::ChildRunControl::claim(
                    &app,
                    &id,
                    &entry.snapshot.parent_session_id,
                ) {
                    Ok(next) => {
                        let finished = entry.snapshot.clone();
                        if let Err(error) = publish(&app, &finished, true) {
                            eprintln!("could not persist agent state: {error}");
                        }
                        begin_followup(entry, task);
                        control = Some(next);
                        let snapshot = entry.snapshot.clone();
                        drop(entries);
                        let _ = publish(&app, &snapshot, true);
                        continue;
                    }
                    Err(error) => {
                        entry.snapshot.error = Some(error.to_string());
                        entry.pending.clear();
                        entry.snapshot.status = "failed".into();
                    }
                }
            }
            let snapshot = entry.snapshot.clone();
            drop(entries);
            let _ = publish(&app, &snapshot, true);
            return;
        }
    });
}

fn settle(entry: &mut AgentEntry, outcome: Result<ProviderChatResponse, String>, stopped: bool) {
    let now = Utc::now();
    if let Some(start) = entry
        .snapshot
        .started_at
        .take()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok())
    {
        entry.snapshot.elapsed_ms = entry
            .snapshot
            .elapsed_ms
            .saturating_add((now.signed_duration_since(start).num_milliseconds().max(0)) as u64);
    }
    entry.snapshot.updated_at = now.to_rfc3339();
    match outcome {
        Ok(response) => {
            let tokens = response
                .assistant_event
                .payload
                .get("turnTokens")
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok());
            entry.snapshot.tokens = add_tokens(entry.previous_tokens, tokens);
            entry.snapshot.summary = Some(
                subagent_capability::truncate_chars(&response.assistant_event.message, 8_000).0,
            );
            entry.snapshot.status = "completed".into();
        }
        Err(error) => {
            entry.snapshot.error = Some(gyro_core::security::redact_secrets(&error));
            entry.snapshot.status = if stopped { "cancelled" } else { "failed" }.into();
        }
    }
}

pub(super) fn add_tokens(
    first: Option<UsageTokens>,
    second: Option<UsageTokens>,
) -> Option<UsageTokens> {
    match (first, second) {
        (Some(a), Some(b)) => Some(a.combine(b)),
        (a, b) => a.or(b),
    }
}

fn begin_followup(entry: &mut AgentEntry, task: String) {
    entry.previous_tokens = entry.snapshot.tokens;
    entry.snapshot.task = task.clone();
    entry.snapshot.run_id = Uuid::new_v4().to_string();
    entry.snapshot.started_at = Some(Utc::now().to_rfc3339());
    entry.snapshot.updated_at = Utc::now().to_rfc3339();
    entry.snapshot.status = "running".into();
    entry.snapshot.summary = None;
    entry.snapshot.error = None;
    entry.request.message = child_prompt(&task, entry.snapshot.read_only);
    entry.request.turn_id = Some(entry.snapshot.run_id.clone());
    entry.delivered = false;
}

pub(super) fn observe_tokens(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    tokens: UsageTokens,
) {
    let manager = app.state::<AgentManager>();
    let snapshot = manager.entries.lock().ok().and_then(|mut entries| {
        let entry = entries.get_mut(&request.session_id)?;
        if request.turn_id.as_deref() != Some(&entry.snapshot.run_id)
            || !is_live(&entry.snapshot.status)
        {
            return None;
        }
        entry.snapshot.tokens = add_tokens(entry.previous_tokens, Some(tokens));
        entry.snapshot.updated_at = Utc::now().to_rfc3339();
        Some(entry.snapshot.clone())
    });
    if let Some(snapshot) = snapshot {
        let _ = publish(app, &snapshot, false);
    }
}

pub(super) fn restrict_context(
    app: &tauri::AppHandle,
    context: &mut BoundProviderCapabilityContext,
) {
    if let Ok(entries) = app.state::<AgentManager>().entries.lock() {
        if let Some(entry) = entries.get(&context.session_id) {
            for (class, access) in context.policy.classes.iter_mut() {
                *access = narrower_capability_access(*access, entry.ceiling.access_for(*class));
            }
            context
                .policy
                .grants
                .retain(|grant| entry.ceiling.grants.contains(grant));
        }
    }
}

pub(super) fn restrict_request(app: &tauri::AppHandle, request: &mut ProviderChatRequest) {
    if let Ok(entries) = app.state::<AgentManager>().entries.lock() {
        if let Some(entry) = entries.get(&request.session_id) {
            request.full_access &= entry.request.full_access;
            request.require_command_approval |= entry.request.require_command_approval;
            request.require_file_edit_approval |= entry.request.require_file_edit_approval;
            request.mode = entry.request.mode;
        }
    }
}

pub(super) fn delegation_tool(id: CapabilityId) -> bool {
    matches!(
        id,
        CapabilityId::AgentSpawn | CapabilityId::AgentSend | CapabilityId::ResearchRun
    )
}

/// Auto approval includes delegation, while explicit project denials and the
/// run-mode ceiling remain in force. Child authority is inherited separately.
pub(super) fn permission_access(
    access: CapabilityAccess,
    id: CapabilityId,
    mode: CapabilityRunMode,
    config: &GyroConfig,
) -> CapabilityAccess {
    if access == CapabilityAccess::Ask
        && delegation_tool(id)
        && mode != CapabilityRunMode::Council
        && !config.require_command_approval
        && !config.require_file_edit_approval
    {
        CapabilityAccess::Allow
    } else {
        access
    }
}

pub(super) fn can_delegate(session: &str) -> bool {
    open_store()
        .ok()
        .and_then(|store| {
            Uuid::parse_str(session)
                .ok()
                .and_then(|id| store.get_session(id).ok().flatten())
        })
        .is_some_and(|session| session.parent_session_id.is_none())
}

pub(super) fn full_access_ceiling(app: &tauri::AppHandle, session: &str) -> bool {
    app.state::<AgentManager>()
        .entries
        .lock()
        .ok()
        .is_some_and(|entries| {
            entries
                .get(session)
                .is_none_or(|entry| entry.request.full_access)
        })
}

pub(super) fn file_edit_ceiling(app: &tauri::AppHandle, session: &str) -> bool {
    app.state::<AgentManager>()
        .entries
        .lock()
        .ok()
        .is_some_and(|entries| {
            entries.get(session).is_none_or(|entry| {
                entry.request.full_access && !entry.request.require_file_edit_approval
            })
        })
}

pub(super) fn wait(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    ids: &[String],
    timeout: Duration,
) -> anyhow::Result<Vec<AgentSnapshot>> {
    for id in ids {
        restore_entry(app, bound, id)?;
    }
    let deadline = Instant::now() + timeout;
    loop {
        if provider_chat_cancelled(app, &bound.session_id) {
            anyhow::bail!(provider_stop_message(app, &bound.session_id));
        }
        let snapshots = {
            let manager = app.state::<AgentManager>();
            let mut entries = manager
                .entries
                .lock()
                .map_err(|_| anyhow::anyhow!("agent state unavailable"))?;
            ids.iter()
                .map(|id| {
                    let entry = entries
                        .get_mut(id)
                        .ok_or_else(|| anyhow::anyhow!("agent not found: {id}"))?;
                    owned(&entry.snapshot, &bound.session_id)?;
                    if !is_live(&entry.snapshot.status) {
                        entry.delivered = true;
                    }
                    Ok(entry.snapshot.clone())
                })
                .collect::<anyhow::Result<Vec<_>>>()?
        };
        if snapshots.iter().all(|agent| !is_live(&agent.status)) || Instant::now() >= deadline {
            return Ok(snapshots);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn send(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    id: &str,
    message: &str,
) -> anyhow::Result<AgentSnapshot> {
    let task = task_text(message)?;
    restore_entry(app, bound, id)?;
    let manager = app.state::<AgentManager>();
    let mut entries = manager
        .entries
        .lock()
        .map_err(|_| anyhow::anyhow!("agent state unavailable"))?;
    let entry = entries
        .get_mut(id)
        .ok_or_else(|| anyhow::anyhow!("agent not found"))?;
    owned(&entry.snapshot, &bound.session_id)?;
    if entry.snapshot.status == "stopping" {
        anyhow::bail!("agent is stopping; wait for it to settle");
    }
    if entry.pending.len() >= 8 {
        anyhow::bail!("agent already has eight pending tasks");
    }
    entry.snapshot.parent_turn_id = bound.turn_id.clone();
    let parent_request = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .map_err(|_| anyhow::anyhow!("run state unavailable"))?
        .get(&bound.session_id)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("parent turn no longer active"))?
        .request
        .lock()
        .map_err(|_| anyhow::anyhow!("run request unavailable"))?
        .clone()
        .ok_or_else(|| anyhow::anyhow!("parent request unavailable"))?;
    inherit_entry_permissions(entry, &parent_request, &bound.policy);
    open_store().map_err(anyhow::Error::msg)?.append_event(Uuid::parse_str(id)?, SessionEventKind::SystemEvent, "Delegation authority inherited", json!({
        "kind": "subagent-authority", "policy": entry.ceiling,
        "fullAccess": entry.request.full_access, "requireCommandApproval": entry.request.require_command_approval,
        "requireFileEditApproval": entry.request.require_file_edit_approval,
    }))?;
    if is_live(&entry.snapshot.status) {
        entry.pending.push(task);
        entry.delivered = false;
        return Ok(entry.snapshot.clone());
    }
    let control = subagent_capability::ChildRunControl::claim(app, id, &bound.session_id)?;
    begin_followup(entry, task);
    let snapshot = entry.snapshot.clone();
    drop(entries);
    if let Err(error) = publish(app, &snapshot, true) {
        if let Ok(mut entries) = manager.entries.lock() {
            if let Some(entry) = entries.get_mut(id) {
                settle(entry, Err(error.to_string()), false);
            }
        }
        drop(control);
        return Err(error);
    }
    start_worker(app.clone(), id.to_string(), control);
    Ok(snapshot)
}

fn restore_entry(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    id: &str,
) -> anyhow::Result<()> {
    if app
        .state::<AgentManager>()
        .entries
        .lock()
        .map_err(|_| anyhow::anyhow!("agent state unavailable"))?
        .contains_key(id)
    {
        return Ok(());
    }
    let store = open_store().map_err(anyhow::Error::msg)?;
    let child = store
        .get_session(Uuid::parse_str(id)?)?
        .ok_or_else(|| anyhow::anyhow!("agent not found"))?;
    if child.parent_session_id.map(|id| id.to_string()).as_deref() != Some(&bound.session_id) {
        anyhow::bail!("this agent belongs to another chat");
    }
    let snapshot = list(app, &bound.session_id)?
        .into_iter()
        .find(|agent| agent.agent_id == id)
        .ok_or_else(|| anyhow::anyhow!("saved agent state is unavailable"))?;
    let authority = store
        .read_events(child.id)?
        .into_iter()
        .rev()
        .find(|event| {
            event.payload.get("kind").and_then(Value::as_str) == Some("subagent-authority")
        })
        .map(|event| event.payload)
        .ok_or_else(|| {
            anyhow::anyhow!("saved agent authority is unavailable; spawn a new agent")
        })?;
    let ceiling: CapabilityPolicySnapshot = serde_json::from_value(authority["policy"].clone())?;
    let request = ProviderChatRequest {
        session_id: id.into(),
        message: String::new(),
        turn_id: None,
        provider_id: snapshot.provider_id.clone(),
        provider_label: child.provider_label,
        model_id: child.model_id,
        model_label: child.model_label,
        reasoning_effort: child.reasoning_effort,
        require_command_approval: authority["requireCommandApproval"]
            .as_bool()
            .unwrap_or(true),
        require_file_edit_approval: authority["requireFileEditApproval"]
            .as_bool()
            .unwrap_or(true),
        full_access: authority["fullAccess"].as_bool().unwrap_or(false),
        suggest_title: false,
        workspace_path: Some(child.workspace_path.to_string_lossy().into()),
        mode: inherited_chat_mode(ceiling.mode),
        goal: None,
        plan: None,
        attachments: Vec::new(),
        workspace_context: None,
        workspace_check: None,
    };
    app.state::<AgentManager>()
        .entries
        .lock()
        .map_err(|_| anyhow::anyhow!("agent state unavailable"))?
        .entry(id.into())
        .or_insert(AgentEntry {
            previous_tokens: snapshot.tokens,
            snapshot,
            request,
            ceiling,
            pending: Vec::new(),
            delivered: true,
        });
    Ok(())
}

fn stop(app: &tauri::AppHandle, parent: &str, id: &str) -> anyhow::Result<AgentSnapshot> {
    let manager = app.state::<AgentManager>();
    let mut entries = manager
        .entries
        .lock()
        .map_err(|_| anyhow::anyhow!("agent state unavailable"))?;
    let entry = entries
        .get_mut(id)
        .ok_or_else(|| anyhow::anyhow!("agent not found"))?;
    owned(&entry.snapshot, parent)?;
    entry.pending.clear();
    if is_live(&entry.snapshot.status) {
        if let Some(control) = app
            .state::<ProviderCancellationManager>()
            .flags
            .lock()
            .map_err(|_| anyhow::anyhow!("run state unavailable"))?
            .get(id)
        {
            control.cancellation.cancel();
        }
        entry.snapshot.status = "stopping".into();
    }
    let snapshot = entry.snapshot.clone();
    drop(entries);
    publish(app, &snapshot, true)?;
    Ok(snapshot)
}

/// A parent turn must never leave spending children behind after a failure.
pub(super) struct ParentRunScope {
    app: tauri::AppHandle,
    session: String,
}
impl ParentRunScope {
    pub(super) fn new(app: &tauri::AppHandle, session: &str) -> Self {
        Self {
            app: app.clone(),
            session: session.into(),
        }
    }
}
impl Drop for ParentRunScope {
    fn drop(&mut self) {
        let ids = self
            .app
            .state::<AgentManager>()
            .entries
            .lock()
            .ok()
            .map(|entries| {
                entries
                    .values()
                    .filter(|entry| {
                        entry.snapshot.parent_session_id == self.session
                            && is_live(&entry.snapshot.status)
                    })
                    .map(|entry| entry.snapshot.agent_id.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for id in ids {
            let _ = stop(&self.app, &self.session, &id);
        }
    }
}

pub(super) fn collect_for_parent(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
) -> anyhow::Result<Option<String>> {
    let ids = app
        .state::<AgentManager>()
        .entries
        .lock()
        .map_err(|_| anyhow::anyhow!("agent state unavailable"))?
        .values()
        .filter(|entry| {
            entry.snapshot.parent_session_id == request.session_id
                && entry.snapshot.parent_turn_id == request.turn_id
                && !entry.delivered
        })
        .map(|entry| entry.snapshot.agent_id.clone())
        .take(32)
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(None);
    }
    let bound = active_provider_capability_context(app, &request.session_id)?;
    let results = wait(app, &bound, &ids, Duration::from_secs(14 * 60))?;
    if results.iter().any(|agent| is_live(&agent.status)) {
        anyhow::bail!("sub-agents did not settle before the parent wait timeout");
    }
    Ok(Some(serde_json::to_string(&bounded_reports(&results))?))
}

#[tauri::command]
pub(super) async fn list_subagents(
    app: tauri::AppHandle,
    parent_session_id: String,
) -> Result<Vec<AgentSnapshot>, String> {
    tauri::async_runtime::spawn_blocking(move || list(&app, &parent_session_id).map_err(to_string))
        .await
        .map_err(to_string)?
}
fn list(app: &tauri::AppHandle, parent: &str) -> anyhow::Result<Vec<AgentSnapshot>> {
    let store = open_store().map_err(anyhow::Error::msg)?;
    let mut snapshots = HashMap::new();
    for event in store.read_events(Uuid::parse_str(parent)?)? {
        if event.payload.get("kind").and_then(Value::as_str) == Some("subagent-state") {
            if let Ok(snapshot) =
                serde_json::from_value::<AgentSnapshot>(event.payload["agent"].clone())
            {
                snapshots.insert(snapshot.agent_id.clone(), snapshot);
            }
        }
    }
    for child in store.list_sessions()?.into_iter().filter(|session| {
        session
            .parent_session_id
            .map(|id| id.to_string())
            .as_deref()
            == Some(parent)
    }) {
        let id = child.id.to_string();
        if snapshots.contains_key(&id) {
            continue;
        }
        let events = store.read_events(child.id)?;
        let response = events
            .iter()
            .rev()
            .find(|event| event.kind == SessionEventKind::AssistantMessage);
        let parent_turn = store
            .read_events(Uuid::parse_str(parent)?)?
            .into_iter()
            .find(|event| {
                event
                    .payload
                    .pointer("/resource/id")
                    .and_then(Value::as_str)
                    == Some(&id)
            })
            .and_then(|event| event.turn_id)
            .map(|id| id.to_string());
        let totals = store.session_usage_totals(child.id).ok();
        snapshots.insert(
            id.clone(),
            AgentSnapshot {
                agent_id: id,
                parent_session_id: parent.into(),
                parent_turn_id: parent_turn,
                name: child.title,
                task: events
                    .iter()
                    .find(|event| event.kind == SessionEventKind::UserMessage)
                    .map(|event| event.message.clone())
                    .unwrap_or_default(),
                provider_id: child.provider_id.unwrap_or_default(),
                model_id: child.model_id,
                read_only: true,
                status: if response.is_some() {
                    "completed"
                } else {
                    "interrupted"
                }
                .into(),
                created_at: child.created_at.to_rfc3339(),
                updated_at: child.updated_at.to_rfc3339(),
                started_at: None,
                elapsed_ms: child
                    .updated_at
                    .signed_duration_since(child.created_at)
                    .num_milliseconds()
                    .max(0) as u64,
                tokens: totals
                    .filter(|totals| totals.calls > 0)
                    .and_then(|_| store.session_usage_tokens(child.id).ok().flatten()),
                run_id: response
                    .and_then(|event| event.turn_id)
                    .map(|id| id.to_string())
                    .unwrap_or_default(),
                summary: response
                    .map(|event| subagent_capability::truncate_chars(&event.message, 8_000).0),
                error: None,
            },
        );
    }
    let manager = app.state::<AgentManager>();
    let live = manager
        .entries
        .lock()
        .map_err(|_| anyhow::anyhow!("agent state unavailable"))?;
    for snapshot in snapshots.values_mut() {
        if !live.contains_key(&snapshot.agent_id) && is_live(&snapshot.status) {
            snapshot.status = "interrupted".into();
            snapshot.error = Some(PROVIDER_INTERRUPTED_MARKER.into());
            if let Some(start) = snapshot
                .started_at
                .take()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok())
            {
                let events = store.read_recent_events(Uuid::parse_str(&snapshot.agent_id)?, 256)?;
                let end = events
                    .iter()
                    .rev()
                    .find(|event| {
                        event.payload.get("error").and_then(Value::as_str)
                            != Some(PROVIDER_INTERRUPTED_MARKER)
                    })
                    .map(|e| e.created_at)
                    .unwrap_or_else(|| start.with_timezone(&Utc));
                snapshot.elapsed_ms = snapshot.elapsed_ms.saturating_add(
                    end.signed_duration_since(start).num_milliseconds().max(0) as u64,
                );
            }
            // Ledger counts survive even if the last lifecycle write was lost.
            if let Ok(totals) = store.session_usage_totals(Uuid::parse_str(&snapshot.agent_id)?) {
                if totals.calls > 0 {
                    snapshot.tokens = store.session_usage_tokens(Uuid::parse_str(&snapshot.agent_id)?).ok().flatten();
                }
            }
        }
    }
    for entry in live
        .values()
        .filter(|entry| entry.snapshot.parent_session_id == parent)
    {
        snapshots.insert(entry.snapshot.agent_id.clone(), entry.snapshot.clone());
    }
    let mut result = snapshots.into_values().collect::<Vec<_>>();
    result.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    Ok(result)
}

#[tauri::command]
pub(super) async fn stop_subagent(
    app: tauri::AppHandle,
    parent_session_id: String,
    agent_id: String,
) -> Result<AgentSnapshot, String> {
    stop(&app, &parent_session_id, &agent_id).map_err(to_string)
}

pub(super) fn execute(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    request: &CapabilityRequest,
) -> anyhow::Result<(String, Value, Option<CapabilityResourceRef>)> {
    let args = &request.arguments;
    let snapshots = match request.capability_id {
        CapabilityId::AgentSpawn => vec![spawn(
            app,
            bound,
            capability_argument_string(args, "name")?,
            capability_argument_string(args, "task")?,
        )?],
        CapabilityId::AgentSend => vec![send(
            app,
            bound,
            capability_argument_string(args, "agentId")?,
            capability_argument_string(args, "message")?,
        )?],
        CapabilityId::AgentStop => vec![stop(
            app,
            &bound.session_id,
            capability_argument_string(args, "agentId")?,
        )?],
        CapabilityId::AgentWait => {
            let ids = args
                .get("agentIds")
                .and_then(Value::as_array)
                .ok_or_else(|| anyhow::anyhow!("agentIds required"))?
                .iter()
                .map(|v| {
                    v.as_str()
                        .map(str::to_string)
                        .ok_or_else(|| anyhow::anyhow!("invalid agent ID"))
                })
                .collect::<anyhow::Result<Vec<_>>>()?;
            if ids.is_empty() || ids.len() > 32 {
                anyhow::bail!("wait requires 1–32 agent IDs");
            }
            wait(
                app,
                bound,
                &ids,
                Duration::from_millis(
                    args.get("timeoutMs")
                        .and_then(Value::as_u64)
                        .unwrap_or(30_000)
                        .min(60_000),
                ),
            )?
        }
        _ => anyhow::bail!("unsupported agent capability"),
    };
    let resource = snapshots.first().map(|agent| CapabilityResourceRef {
        id: agent.agent_id.clone(),
        kind: "chat".into(),
        label: agent.name.clone(),
    });
    Ok((
        format!("Updated {} sub-agent(s)", snapshots.len()),
        json!({"schema": "gyro.agents.v1", "agents": bounded_reports(&snapshots)}),
        resource,
    ))
}

// Tool reports omit the already-known task and share a conservative escaped-JSON
// budget. The complete transcript remains available in the companion panel.
fn bounded_reports(snapshots: &[AgentSnapshot]) -> Vec<Value> {
    let limit = (96 * 1024 / snapshots.len().max(1) / 6).min(8_000);
    snapshots.iter().map(|agent| {
        let (summary, truncated) = subagent_capability::truncate_chars(agent.summary.as_deref().unwrap_or(""), limit);
        json!({
            "agentId": agent.agent_id, "name": agent.name, "status": agent.status,
            "readOnly": agent.read_only, "providerId": agent.provider_id, "modelId": agent.model_id,
            "tokens": agent.tokens, "elapsedMs": agent.elapsed_ms, "runId": agent.run_id,
            "summary": summary, "summaryTruncated": truncated || agent.summary.as_ref().is_some_and(|text| text.chars().count() >= 8_000),
            "error": agent.error.as_ref().map(|text| subagent_capability::truncate_chars(text, 120).0),
        })
    }).collect()
}

pub(super) fn schema(id: CapabilityId) -> Option<(Value, Vec<&'static str>)> {
    Some(match id {
        CapabilityId::AgentSpawn => (
            json!({"name":{"type":"string","minLength":1,"maxLength":60},"task":{"type":"string","minLength":1,"maxLength":16000}}),
            vec!["name", "task"],
        ),
        CapabilityId::AgentWait => (
            json!({"agentIds":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"string"}},"timeoutMs":{"type":"integer","minimum":0,"maximum":60000}}),
            vec!["agentIds"],
        ),
        CapabilityId::AgentSend => (
            json!({"agentId":{"type":"string"},"message":{"type":"string","minLength":1,"maxLength":16000}}),
            vec!["agentId", "message"],
        ),
        CapabilityId::AgentStop => (json!({"agentId":{"type":"string"}}), vec!["agentId"]),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry() -> AgentEntry {
        let request: ProviderChatRequest = serde_json::from_value(
            json!({"sessionId": "child", "providerId": "openai", "message": "task"}),
        )
        .unwrap();
        AgentEntry {
            snapshot: AgentSnapshot {
                agent_id: "child".into(),
                parent_session_id: "parent".into(),
                parent_turn_id: Some("turn".into()),
                name: "Parser".into(),
                task: "Inspect parser".into(),
                provider_id: "openai".into(),
                model_id: None,
                read_only: true,
                status: "running".into(),
                created_at: Utc::now().to_rfc3339(),
                updated_at: Utc::now().to_rfc3339(),
                started_at: Some((Utc::now() - chrono::Duration::seconds(2)).to_rfc3339()),
                elapsed_ms: 500,
                tokens: None,
                run_id: "run".into(),
                summary: None,
                error: None,
            },
            request,
            ceiling: CapabilityPolicySnapshot::from_policy(
                &ProjectCapabilityPolicy::defaults("workspace"),
                CapabilityRunMode::Plan,
            ),
            previous_tokens: None,
            pending: Vec::new(),
            delivered: false,
        }
    }

    #[test]
    fn auto_approval_allows_delegation_without_crossing_denials_or_council() {
        let mut config = GyroConfig::default();
        config.require_command_approval = false;
        config.require_file_edit_approval = false;
        config.full_access = false;
        for id in [
            CapabilityId::AgentSpawn,
            CapabilityId::AgentSend,
            CapabilityId::ResearchRun,
        ] {
            for mode in [CapabilityRunMode::Normal, CapabilityRunMode::Plan] {
                assert_eq!(
                    permission_access(CapabilityAccess::Ask, id, mode, &config),
                    CapabilityAccess::Allow
                );
                assert_eq!(
                    permission_access(CapabilityAccess::Deny, id, mode, &config),
                    CapabilityAccess::Deny
                );
            }
            assert_eq!(
                permission_access(
                    CapabilityAccess::Ask,
                    id,
                    CapabilityRunMode::Council,
                    &config
                ),
                CapabilityAccess::Ask
            );
            for (commands, edits) in [(true, true), (true, false), (false, true)] {
                config.require_command_approval = commands;
                config.require_file_edit_approval = edits;
                assert_eq!(
                    permission_access(
                        CapabilityAccess::Ask,
                        id,
                        CapabilityRunMode::Normal,
                        &config
                    ),
                    CapabilityAccess::Ask
                );
            }
            config.require_command_approval = false;
            config.require_file_edit_approval = false;
        }
        assert_eq!(
            permission_access(
                CapabilityAccess::Ask,
                CapabilityId::GithubCreatePullRequest,
                CapabilityRunMode::Normal,
                &config
            ),
            CapabilityAccess::Ask
        );
        config.full_access = true;
        assert_eq!(
            permission_access(
                CapabilityAccess::Allow,
                CapabilityId::AgentSpawn,
                CapabilityRunMode::Normal,
                &config
            ),
            CapabilityAccess::Allow
        );
    }

    #[test]
    fn child_native_sandbox_and_approvals_match_the_parent() {
        for (mode, command_approval, edit_approval, full_access) in [
            (ChatMode::Normal, false, false, true),
            (ChatMode::Normal, true, true, false),
            (ChatMode::Normal, false, true, false),
            (ChatMode::Normal, true, false, false),
            (ChatMode::Normal, false, false, false),
            (ChatMode::Plan, false, false, true),
            (ChatMode::Council, false, false, true),
        ] {
            let mut parent = entry().request;
            parent.mode = mode;
            parent.require_command_approval = command_approval;
            parent.require_file_edit_approval = edit_approval;
            parent.full_access = full_access;
            let policy = CapabilityPolicySnapshot::from_policy(
                &ProjectCapabilityPolicy::defaults("workspace"),
                capability_run_mode_for_chat(mode),
            );
            let mut child = entry().request;
            child.session_id = "distinct-child".into();
            let read_only = inherit_parent_permissions(&mut child, &parent, &policy);
            let sandbox = |request: &ProviderChatRequest| {
                codex_app_server_policy(
                    &request.mode,
                    request.require_command_approval,
                    request.require_file_edit_approval,
                    request.full_access,
                    Path::new("workspace"),
                )
            };
            assert_eq!(sandbox(&child), sandbox(&parent));
            assert_eq!(child.require_command_approval, command_approval);
            assert_eq!(child.require_file_edit_approval, edit_approval);
            assert_eq!(read_only, mode != ChatMode::Normal);
            assert_eq!(child.session_id, "distinct-child");
            if mode == ChatMode::Normal && full_access {
                assert_eq!(sandbox(&child).1, "danger-full-access");
                assert!(child.full_access);
            } else if mode != ChatMode::Normal {
                assert!(!child.full_access);
                assert_eq!(sandbox(&child).1, "read-only");
            }
        }
    }

    #[test]
    fn followups_replace_stale_permissions_in_both_directions() {
        let mut child = entry();
        let mut parent = entry().request;
        parent.mode = ChatMode::Normal;
        parent.full_access = true;
        parent.require_command_approval = false;
        parent.require_file_edit_approval = false;
        let policy = CapabilityPolicySnapshot::from_policy(
            &ProjectCapabilityPolicy::defaults("workspace"),
            CapabilityRunMode::Normal,
        );
        inherit_entry_permissions(&mut child, &parent, &policy);
        begin_followup(&mut child, "Implement parser".into());
        assert!(child.request.full_access);
        assert!(!child.request.require_command_approval);
        assert!(!child.request.require_file_edit_approval);
        assert!(!child.snapshot.read_only);
        assert!(!child.request.message.contains("cannot write files"));
        assert_eq!(child.ceiling, policy);

        parent.mode = ChatMode::Plan;
        parent.full_access = false;
        parent.require_command_approval = true;
        parent.require_file_edit_approval = true;
        let restricted = CapabilityPolicySnapshot::from_policy(
            &ProjectCapabilityPolicy::defaults("workspace"),
            CapabilityRunMode::Plan,
        );
        inherit_entry_permissions(&mut child, &parent, &restricted);
        begin_followup(&mut child, "Inspect parser".into());
        assert!(!child.request.full_access);
        assert!(child.request.require_command_approval);
        assert!(child.request.require_file_edit_approval);
        assert!(child.snapshot.read_only);
        assert_eq!(child.request.mode, ChatMode::Plan);
        assert!(child.request.message.contains("cannot write files"));
        assert_eq!(child.ceiling, restricted);
        assert_eq!(
            child.ceiling.access_for(CapabilityClass::WorkspaceWrite),
            CapabilityAccess::Deny
        );
    }

    #[test]
    fn reports_stay_within_tool_budget_even_for_unicode_and_many_agents() {
        let mut snapshot = entry().snapshot;
        snapshot.task = "😀".repeat(16_000);
        snapshot.summary = Some("😀\n\"".repeat(8_000));
        snapshot.error = Some("failure".repeat(16_000));
        let agents = vec![snapshot; 32];
        let reports = bounded_reports(&agents);
        assert!(
            serde_json::to_vec(&reports).unwrap().len()
                < gyro_core::capabilities::MAX_CAPABILITY_RESULT_BYTES
        );
        assert_eq!(reports.len(), 32);
        assert_eq!(reports[0]["summaryTruncated"], true);
        assert!(reports[0].get("task").is_none());
    }

    #[test]
    fn cumulative_readings_replace_current_run_and_add_only_prior_runs() {
        let prior = UsageTokens::measured(Some(100), Some(90), Some(20), Some(5), Some(120));
        let current = UsageTokens::measured(Some(200), Some(190), Some(30), Some(10), Some(230));
        let combined = add_tokens(Some(prior), Some(current)).unwrap();
        assert_eq!(combined.total_tokens, 350);
        assert_eq!(combined.cached_input_tokens, 280);
        assert_eq!(combined.reasoning_output_tokens, 15);
        assert_eq!(add_tokens(Some(prior), Some(current)), Some(combined));
        assert!(
            !add_tokens(Some(prior), Some(UsageTokens::estimated(40, 20)))
                .unwrap()
                .measured
        );
        assert_eq!(add_tokens(None, None), None);
    }

    #[test]
    fn ownership_is_bound_to_parent_not_workspace_or_name() {
        let entry = entry();
        assert!(owned(&entry.snapshot, "parent").is_ok());
        assert!(owned(&entry.snapshot, "other-parent").is_err());
        assert!(owned(&entry.snapshot, "child").is_err());
    }

    #[test]
    fn stopped_and_failed_runs_freeze_runtime_and_preserve_usage() {
        let mut entry = entry();
        entry.snapshot.tokens = Some(UsageTokens::measured(None, None, None, None, Some(50)));
        settle(&mut entry, Err("cancelled".into()), true);
        assert_eq!(entry.snapshot.status, "cancelled");
        assert!(entry.snapshot.started_at.is_none());
        assert!(entry.snapshot.elapsed_ms >= 2500);
        assert_eq!(entry.snapshot.tokens.unwrap().total_tokens, 50);
        begin_followup(&mut entry, "Inspect tests".into());
        assert_eq!(entry.previous_tokens.unwrap().total_tokens, 50);
        assert_eq!(entry.snapshot.status, "running");
        assert!(entry.snapshot.error.is_none());
        assert!(!entry.delivered);
        assert_eq!(
            entry.request.turn_id.as_deref(),
            Some(entry.snapshot.run_id.as_str())
        );
    }

    #[test]
    fn task_boundaries_and_read_only_contract_survive_followups() {
        assert!(task_text("").is_err());
        assert!(task_text(&"x".repeat(MAX_TASK_CHARS + 1)).is_err());
        assert_eq!(task_text("\ninspect\nparser\n").unwrap(), "inspect\nparser");
        let prompt = child_prompt("Inspect parser", true);
        assert!(prompt.contains("cannot write files"));
        assert!(prompt.contains("cannot launch sub-agents"));
        assert!(prompt.contains("own independent Gyro Browser session"));
        assert!(prompt.contains("browser tools"));
        let prompt = child_prompt("Implement parser", false);
        assert!(!prompt.contains("cannot write files"));
        assert!(prompt.contains("file ownership"));
        assert!(prompt.contains("does not appear in the parent's frontend"));
    }

    #[test]
    fn children_cannot_delegate_even_if_the_tool_is_forged() {
        let temp = tempfile::tempdir().unwrap();
        let store =
            SessionStore::open(GyroPaths::from_base_dir(temp.path().join("store"))).unwrap();
        let parent = store
            .create_session(temp.path(), SessionOrigin::Desktop, "parent")
            .unwrap();
        let child = store
            .create_subagent_session(
                temp.path(),
                SessionOrigin::Desktop,
                "child",
                CreateSessionContext::default(),
                parent.id,
            )
            .unwrap();
        let policy = ProjectCapabilityPolicy::defaults(temp.path().display().to_string());
        let mut bound = BoundProviderCapabilityContext {
            session_id: child.id.to_string(),
            turn_id: None,
            provider_id: "openai".into(),
            workspace: temp.path().into(),
            workspace_key: policy.workspace_key.clone(),
            workspace_identity_revision: 1,
            policy: CapabilityPolicySnapshot::from_policy(&policy, CapabilityRunMode::Normal),
            workspace_context: WorkspaceContextSnapshot::empty(policy.workspace_key.clone()),
            workspace_check: gyro_core::check_workspace(temp.path()),
        };
        for id in [
            CapabilityId::AgentSpawn,
            CapabilityId::AgentSend,
            CapabilityId::ResearchRun,
        ] {
            assert!(validate_caller(&store, &bound, id).is_err());
        }
        bound.session_id = parent.id.to_string();
        assert!(validate_caller(&store, &bound, CapabilityId::AgentSpawn).is_ok());
        // The narrow Plan delegation exception does not enable the whole class.
        let ceiling = CapabilityPolicySnapshot::from_policy(&policy, CapabilityRunMode::Plan);
        assert_eq!(
            ceiling.access_for(CapabilityClass::AgentRun),
            CapabilityAccess::Deny
        );
        assert_eq!(
            ceiling.access_for(CapabilityClass::WorkspaceWrite),
            CapabilityAccess::Deny
        );
    }

    #[test]
    fn tool_schemas_cover_every_adapter_transport() {
        for id in [
            CapabilityId::AgentSpawn,
            CapabilityId::AgentWait,
            CapabilityId::AgentSend,
            CapabilityId::AgentStop,
        ] {
            let (properties, required) = schema(id).unwrap();
            assert!(!required.is_empty());
            for field in required {
                assert!(properties.get(field).is_some());
            }
            assert!(gyro_core::provider_capability_support("openai")
                .capabilities
                .contains(&id));
            assert!(gyro_core::provider_capability_support("ollama")
                .capabilities
                .contains(&id));
        }
    }
}
