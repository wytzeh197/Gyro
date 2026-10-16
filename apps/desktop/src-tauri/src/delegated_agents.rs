//! Gyro-owned asynchronous delegation. Provider threads never own child lifetime.
use super::*;
use chrono::Utc;
use serde_json::{json, Value};

const EVENT: &str = "gyro://subagent-event";
const MAX_TASK_CHARS: usize = 16_000;
const MAX_AUTOMATIC_CONTINUATIONS: u8 = 2;
const INCOMPLETE_TASK_NOTICE: &str = "The sub-agent reports unfinished work.";
const UNCONFIRMED_TASK_NOTICE: &str = "The sub-agent did not confirm task completion.";

/// Delegation spends additional model calls. Reasoning depth alone at High or
/// XHigh does not opt in; the active user request may explicitly opt in or out.
pub(super) fn request_allows_delegation(request: &ProviderChatRequest) -> bool {
    if request.mode == ChatMode::Council {
        return false;
    }
    match delegation_intent(&request.message) {
        Some(allowed) => allowed,
        None => efficiency::config().parallel_agents,
    }
}

fn delegation_intent(message: &str) -> Option<bool> {
    let mut requested = false;
    let mut fenced = false;
    let instructions = message
        .lines()
        .filter(|line| {
            let line = line.trim();
            if line.starts_with("```") || line.starts_with("~~~") {
                fenced = !fenced;
                return false;
            }
            !fenced && !line.starts_with(['>', '"', '\''])
        })
        .collect::<Vec<_>>()
        .join("\n");
    for sentence in instructions.split(['\n', '.', ';', '?']) {
        let normalized = sentence
            .chars()
            .flat_map(char::to_lowercase)
            .map(|character| {
                if character.is_alphanumeric() {
                    character
                } else {
                    ' '
                }
            })
            .collect::<String>();
        let words = normalized.split_whitespace().collect::<Vec<_>>();
        for (noun, word) in words.iter().enumerate() {
            let agent = matches!(*word, "subagent" | "subagents")
                || (*word == "sub"
                    && words
                        .get(noun + 1)
                        .is_some_and(|word| matches!(*word, "agent" | "agents")))
                || (*word == "parallel" && words.get(noun + 1) == Some(&"agents"));
            if !agent {
                continue;
            }
            // Opt-outs do not require a delegation verb ("No subagents",
            // "Implement without subagents"). They override expensive effort.
            let prefix = &words[..noun];
            if prefix.iter().any(|word| {
                matches!(
                    *word,
                    "no" | "not" | "dont" | "never" | "without" | "cannot"
                )
            }) || prefix.windows(2).any(|words| words == ["don", "t"])
                || words.windows(2).any(|words| words == ["only", "when"])
                || words.contains(&"unless")
            {
                return Some(false);
            }
            let noun_end = noun
                + if matches!(*word, "sub" | "parallel") {
                    2
                } else {
                    1
                };
            // An agent must be the object of the request, not an adjective in
            // "subagent status/events/tests" or a reported tool name.
            if words
                .get(noun_end)
                .is_some_and(|word| !matches!(*word, "to" | "for" | "on" | "and" | "please"))
            {
                continue;
            }
            let Some(action) = (noun.saturating_sub(8)..noun).rev().find(|index| {
                matches!(
                    words[*index],
                    "use" | "using" | "spawn" | "start" | "launch" | "delegate" | "assign" | "run"
                )
            }) else {
                continue;
            };
            let lead = if words.starts_with(&["can", "you", "please"])
                || words.starts_with(&["could", "you", "please"])
            {
                3
            } else if words.starts_with(&["can", "you"]) || words.starts_with(&["could", "you"]) {
                2
            } else if words.starts_with(&["i", "want", "you", "to"]) {
                4
            } else if words.starts_with(&["i", "want", "to"]) {
                3
            } else if words.starts_with(&["please"]) {
                1
            } else {
                0
            };
            let modifiers = |word: &&str| {
                word.parse::<u16>().is_ok()
                    || matches!(
                        *word,
                        "a" | "an"
                            | "one"
                            | "two"
                            | "three"
                            | "four"
                            | "five"
                            | "six"
                            | "several"
                            | "some"
                            | "multiple"
                            | "additional"
                            | "new"
                            | "parallel"
                    )
            };
            let object = if matches!(words[action], "delegate" | "assign") {
                // "Delegate the parser review to a sub-agent".
                (action + 1..noun)
                    .rev()
                    .find(|index| words[*index] == "to")
                    .is_some_and(|to| words[to + 1..noun].iter().all(modifiers))
            } else {
                words[action + 1..noun].iter().all(modifiers)
            };
            let direct = action == lead
                || (words[action] == "using"
                    && words.get(lead).is_some_and(|word| {
                        matches!(
                            *word,
                            "implement"
                                | "build"
                                | "fix"
                                | "review"
                                | "audit"
                                | "investigate"
                                | "research"
                                | "check"
                                | "analyze"
                                | "analyse"
                                | "test"
                                | "create"
                                | "refactor"
                                | "update"
                        )
                    }));
            requested |= object && direct;
        }
    }
    requested.then_some(true)
}

pub(super) fn prompt_guidance(request: &ProviderChatRequest, resumed: bool) -> &'static str {
    let child = delegation_session(&request.session_id)
        .is_some_and(|session| session.parent_session_id.is_some());
    prompt_guidance_for_role(request, resumed, child)
}

fn prompt_guidance_for_role(
    request: &ProviderChatRequest,
    resumed: bool,
    child: bool,
) -> &'static str {
    if child || !request_allows_delegation(request) {
        "This turn runs with one agent. Do not launch or message sub-agents, call gyro_research_run for new research, or use provider-native delegation. Complete the task yourself with the available tools. You may wait for or stop existing children and read their results."
    } else if resumed {
        "Delegate only when task complexity warrants another model call, through Gyro's gyro_agent_spawn/wait/send/stop tools. Give self-contained tasks and file ownership; children share the workspace, inherit this model and permissions, cannot delegate, and are read-only in Plan mode. Wait for all children and incorporate their reports before replying."
    } else {
        "Parallel delegation: delegate only when task complexity warrants another model call, using Gyro's gyro_agent_spawn/wait/send/stop tools, not provider-native delegation. Give each child a self-contained task and clear file ownership in the shared workspace. Children inherit this model and this chat's permissions, cannot delegate, and Plan-mode children are read-only. Wait for all children and incorporate their reports before your final response."
    }
}

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
    continuations: u8,
    delivered: bool,
}

#[derive(Default)]
pub(super) struct AgentManager {
    entries: Mutex<HashMap<String, AgentEntry>>,
    changed: std::sync::Condvar,
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
        if !bound.allow_delegation {
            anyhow::bail!("this turn runs with one agent; enable parallel agents in Efficiency settings, or explicitly request sub-agents in your message");
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
        if let Some(turn) = snapshot
            .parent_turn_id
            .as_deref()
            .and_then(|id| Uuid::parse_str(id).ok())
        {
            let parent = Uuid::parse_str(&snapshot.parent_session_id)?;
            if let Ok(Some(tokens)) = store.task_usage_tokens(parent, turn) {
                if let Ok(receipt) = store.append_event_with_turn_id(parent, SessionEventKind::SystemEvent, "",
                    json!({"kind": "provider-turn-tokens", "accountingVersion": 1, "turnTokens": tokens}), Some(turn)) {
                    let _ = app.emit(PROVIDER_CAPABILITY_EVENT, receipt);
                }
            }
        }
    }
    if persist {
        app.state::<AgentManager>().changed.notify_all();
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
    spawn_with_runtime(app, bound, name, task, None)
}

pub(super) fn spawn_with_runtime(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    name: &str,
    task: &str,
    runtime: Option<Duration>,
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
    let control = match subagent_capability::ChildRunControl::claim_with_runtime(
        app,
        &id,
        &bound.session_id,
        runtime,
    ) {
        Ok(control) => control,
        Err(error) => {
            let _ = store.delete_session(child.id);
            return Err(error);
        }
    };
    let now = Utc::now().to_rfc3339();
    request.session_id = id.clone();
    request.turn_id = Some(Uuid::new_v4().to_string());
    prepare_child_request(&mut request, &task, read_only);
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
    let manager = app.state::<AgentManager>();
    let mut entries = match manager.entries.lock() {
        Ok(entries) => entries,
        Err(_) => {
            drop(control);
            let _ = store.delete_session(child.id);
            anyhow::bail!("agent state unavailable");
        }
    };
    entries.insert(
        id.clone(),
        AgentEntry {
            snapshot: snapshot.clone(),
            request,
            ceiling: bound.policy.clone(),
            previous_tokens: None,
            pending: Vec::new(),
            continuations: 0,
            delivered: false,
        },
    );
    if let Err(error) = publish(app, &snapshot, true) {
        entries.remove(&id);
        drop(control);
        let _ = store.delete_session(child.id);
        return Err(error);
    }
    drop(entries);
    start_worker(app.clone(), id, control)?;
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

fn prepare_child_request(request: &mut ProviderChatRequest, task: &str, read_only: bool) {
    request.suggest_title = false;
    request.goal = None;
    request.plan = None;
    request.attachments.clear();
    // The child's broker obtains its own current workspace evidence. Parent
    // editor/diagnostic snapshots are expensive and may describe another pane.
    request.workspace_context = None;
    request.workspace_check = None;
    request.message = child_prompt(task, read_only);
}

pub(super) fn completion_update(value: &Value) -> Option<Value> {
    let status = value.get("status").and_then(Value::as_str)?;
    if !matches!(status, "complete" | "continue" | "blocked") {
        return None;
    }
    let mut update = json!({"status": status});
    if let Some(reason) = value.get("reason").and_then(Value::as_str) {
        update["reason"] = json!(gyro_core::security::redact_secrets(
            &subagent_capability::truncate_chars(reason, 800).0
        ));
    }
    Some(update)
}

fn completion_error(payload: &Value, requires_completion: bool) -> Option<String> {
    let update = completion_update(&payload["agentUpdate"]);
    match update.as_ref().and_then(|value| value["status"].as_str()) {
        Some("continue") => Some(INCOMPLETE_TASK_NOTICE.into()),
        Some("blocked") => Some(format!(
            "Sub-agent blocked: {}",
            update
                .as_ref()
                .and_then(|value| value["reason"].as_str())
                .filter(|reason| !reason.trim().is_empty())
                .unwrap_or("read the retained report for the missing input or capability")
        )),
        Some("complete") => None,
        _ if requires_completion => Some(UNCONFIRMED_TASK_NOTICE.into()),
        _ => None, // Older saved tasks predate the completion contract.
    }
}

/// Choose optional browser guidance from the assigned task, not the wrapper
/// that tells every child it owns a browser. This never changes tool authority.
pub(super) fn browser_task_message(message: &str) -> &str {
    if message.starts_with("You are a ")
        && message.contains("sub-agent delegated by another Gyro chat.")
        && message.contains(GYRO_AGENT_UPDATE_MARKER)
    {
        if let Some((_, task)) = message.split_once("\n\nTask:\n") {
            return task;
        }
    }
    if message.starts_with("Continue the same delegated task ")
        && message.contains(GYRO_AGENT_UPDATE_MARKER)
    {
        if let Some((_, task)) = message.split_once("\n\nAssigned task:\n") {
            return task
                .split_once("\n\nLast checkpoint:\n")
                .map_or(task, |(task, _)| task);
        }
    }
    message
}

fn child_prompt(task: &str, read_only: bool) -> String {
    format!("You are a {}sub-agent delegated by another Gyro chat. Work on the self-contained task below. You inherit the parent's permissions and approval setting. You share the parent's workspace: respect assigned file ownership and do not overwrite others' edits. You have your own independent Gyro Browser session: open and use it through the browser tools when needed. It runs in the background and does not appear in the parent's frontend. You cannot launch sub-agents. {}Finish the assigned work with the available tools and relevant verification before replying; do not stop at a plan or a promise. Reuse current evidence, prefer targeted reads and web fetches, and do not repeat passing checks without a reason. Browser screenshots and page events can be used privately; re-observe after acting, and report any need for trusted native input as a blocker. When done, return a concise report of results, changes, validation, and unresolved issues. End with one hidden line GYRO_AGENT_UPDATE: {{\"status\":\"complete\"}} only when the assigned task is verified finished. Use status \"continue\" for remaining authorized work, or \"blocked\" with a short reason when user input or an unavailable capability is required. Continued work is bounded; report remaining work truthfully. Do not ask for duplicate approval; use the broker's approval flow.\n\nTask:\n{task}",
        if read_only { "read-only research " } else { "working " },
        if read_only { "You cannot write files or run commands. " } else { "" })
}

fn start_worker(
    app: tauri::AppHandle,
    id: String,
    initial: subagent_capability::ChildRunControl,
) -> anyhow::Result<()> {
    let worker_app = app.clone();
    let worker_id = id.clone();
    let launched = std::thread::Builder::new()
        .name("gyro-subagent".into())
        .spawn(move || {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                worker_loop(worker_app.clone(), &worker_id, initial)
            }));
            if outcome.is_err() {
                fail_worker(
                    &worker_app,
                    &worker_id,
                    "the sub-agent worker exited unexpectedly",
                );
            }
        });
    if let Err(error) = launched {
        let message = format!("could not start the sub-agent worker: {error}");
        // The failed spawn drops its closure and run control. Keep a terminal
        // durable snapshot instead of a running agent with no worker.
        fail_worker(&app, &id, &message);
        anyhow::bail!(message);
    }
    Ok(())
}

fn recover_worker_entries(
    manager: &AgentManager,
) -> std::sync::MutexGuard<'_, HashMap<String, AgentEntry>> {
    let entries = manager
        .entries
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // The failed worker is closed under this lock; other intact agents remain
    // available rather than inheriting one worker's poisoned lifecycle lock.
    manager.entries.clear_poison();
    entries
}

fn fail_worker(app: &tauri::AppHandle, id: &str, error: &str) {
    let manager = app.state::<AgentManager>();
    let mut entries = recover_worker_entries(&manager);
    if let Some(entry) = entries.get_mut(id) {
        if is_live(&entry.snapshot.status) || !entry.pending.is_empty() {
            settle(entry, Err(error.into()), false);
            let _ = publish(app, &entry.snapshot, true);
        }
    }
    drop(entries);
    release_private_browser(app, id);
}

fn release_private_browser(app: &tauri::AppHandle, id: &str) {
    if session_browser::is_background_browser(app, id) {
        if let Err(error) = session_browser::close_session_browser(app, id) {
            eprintln!("could not release the sub-agent browser: {error}");
        }
    }
}

struct PrivateBrowserScope<'a> {
    app: &'a tauri::AppHandle,
    id: &'a str,
}
impl Drop for PrivateBrowserScope<'_> {
    fn drop(&mut self) {
        release_private_browser(self.app, self.id);
    }
}

fn worker_loop(app: tauri::AppHandle, id: &str, mut control: subagent_capability::ChildRunControl) {
    let _browser_scope = PrivateBrowserScope { app: &app, id };
    loop {
        let request = match app
            .state::<AgentManager>()
            .entries
            .lock()
            .ok()
            .and_then(|entries| entries.get(id).map(|entry| entry.request.clone()))
        {
            Some(request) => request,
            None => {
                drop(control);
                fail_worker(&app, id, "the sub-agent request state is unavailable");
                return;
            }
        };
        if let Some((parent, parent_turn)) = app
            .state::<AgentManager>()
            .entries
            .lock()
            .ok()
            .and_then(|entries| {
                entries.get(id).map(|entry| {
                    (
                        entry.snapshot.parent_session_id.clone(),
                        entry.snapshot.parent_turn_id.clone(),
                    )
                })
            })
        {
            if let (Ok(store), Ok(child), Some(child_turn), Ok(parent), Some(parent_turn)) = (
                open_store(),
                Uuid::parse_str(&request.session_id),
                request
                    .turn_id
                    .as_deref()
                    .and_then(|value| Uuid::parse_str(value).ok()),
                Uuid::parse_str(&parent),
                parent_turn
                    .as_deref()
                    .and_then(|value| Uuid::parse_str(value).ok()),
            ) {
                if let Err(error) = store.link_usage_turn(child, child_turn, parent, parent_turn) {
                    eprintln!("could not attribute child usage: {error}");
                }
            }
        }
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_provider_chat_blocking(app.clone(), request, UsageOrigin::SubAgent)
        }))
        .unwrap_or_else(|_| Err("the sub-agent worker exited unexpectedly".into()));
        let manager = app.state::<AgentManager>();
        let mut entries = match manager.entries.lock() {
            Ok(entries) => entries,
            Err(_) => {
                drop(control);
                fail_worker(&app, id, "the sub-agent lifecycle state is unavailable");
                return;
            }
        };
        let Some(entry) = entries.get_mut(id) else {
            return;
        };
        let stopped = control.is_cancelled() || entry.snapshot.status == "stopping";
        settle(entry, outcome, stopped);
        if let Ok(store) = open_store() {
            if let Ok(child_id) = Uuid::parse_str(id) {
                if let Ok(Some(tokens)) = store.session_usage_tokens(child_id) {
                    entry.snapshot.tokens = Some(tokens);
                }
            }
        }
        if !stopped && can_continue(entry) {
            match control.renew(&entry.snapshot.parent_session_id) {
                Ok(()) => {
                    begin_continuation(entry);
                    if let Err(error) = publish(&app, &entry.snapshot, true) {
                        settle(entry, Err(error.to_string()), false);
                        let _ = publish(&app, &entry.snapshot, true);
                        drop(control);
                        drop(entries);
                        return;
                    }
                    drop(entries);
                    continue;
                }
                Err(error) => settle(entry, Err(error.to_string()), control.is_cancelled()),
            }
        }
        // Hand off the existing slot atomically; another chat cannot steal it
        // between the completed turn and an explicitly queued next task.
        if !stopped && entry.snapshot.status == "completed" && !entry.pending.is_empty() {
            match control.renew(&entry.snapshot.parent_session_id) {
                Ok(()) => {
                    let finished = entry.snapshot.clone();
                    if let Err(error) = publish(&app, &finished, true) {
                        eprintln!("could not persist agent state: {error}");
                    }
                    let task = entry.pending.remove(0);
                    begin_followup(entry, task);
                    if let Err(error) = publish(&app, &entry.snapshot, true) {
                        settle(entry, Err(error.to_string()), false);
                        let _ = publish(&app, &entry.snapshot, true);
                        drop(control);
                        drop(entries);
                        return;
                    }
                    drop(entries);
                    continue;
                }
                Err(error) => {
                    settle(entry, Err(error.to_string()), control.is_cancelled());
                }
            }
        }
        let _ = publish(&app, &entry.snapshot, true);
        // Keep settlement, durable publication, and release serialized with
        // send. A completed entry is never visible with its old run booked.
        drop(control);
        drop(entries);
        return;
    }
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
            let notice = response
                .status_event
                .payload
                .get("error")
                .and_then(Value::as_str)
                .filter(|notice| {
                    provider_reliability::is_tool_budget_notice(notice)
                        || notice.contains("may be cut off")
                });
            let requires_completion = entry.request.message.contains(GYRO_AGENT_UPDATE_MARKER);
            let error = if stopped {
                Some("The sub-agent was stopped before task completion.".into())
            } else if let Some(notice) = notice {
                Some(gyro_core::security::redact_secrets(notice))
            } else {
                completion_error(&response.assistant_event.payload, requires_completion)
            };
            entry.snapshot.status = if stopped {
                "cancelled"
            } else if error.is_some() {
                "interrupted"
            } else {
                "completed"
            }
            .into();
            entry.snapshot.error = error;
        }
        Err(error) => {
            entry.snapshot.error = Some(gyro_core::security::redact_secrets(&error));
            entry.snapshot.status = if stopped { "cancelled" } else { "failed" }.into();
        }
    }
    if entry.snapshot.error.as_deref() == Some(INCOMPLETE_TASK_NOTICE)
        && entry.continuations >= MAX_AUTOMATIC_CONTINUATIONS
    {
        entry.snapshot.error = Some(format!(
            "{INCOMPLETE_TASK_NOTICE} Automatic continuation limit reached; the report is retained."
        ));
    }
    if entry.snapshot.status != "completed" && !can_continue(entry) && !entry.pending.is_empty() {
        entry.pending.clear();
        let error = entry
            .snapshot
            .error
            .get_or_insert_with(|| "the sub-agent did not finish".into());
        error.push_str(" Queued follow-ups were not started because this run did not finish.");
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

fn can_continue(entry: &AgentEntry) -> bool {
    entry.snapshot.status == "interrupted"
        && entry.snapshot.error.as_deref() == Some(INCOMPLETE_TASK_NOTICE)
        && entry.continuations < MAX_AUTOMATIC_CONTINUATIONS
}

fn begin_continuation(entry: &mut AgentEntry) {
    let round = entry.continuations + 1;
    let checkpoint = entry.snapshot.summary.clone().unwrap_or_default();
    let task = entry.snapshot.task.clone();
    begin_followup(entry, task);
    entry.continuations = round;
    entry.request.message = format!(
        "Continue the same delegated task from the durable conversation and current files. Do not replay completed edits or repeat passing checks without a reason. Finish remaining authorized work and verification. If blocked, report the missing input or capability. End with GYRO_AGENT_UPDATE: {{\"status\":\"complete\"}}, {{\"status\":\"continue\"}}, or {{\"status\":\"blocked\",\"reason\":\"...\"}} as appropriate.\n\nAssigned task:\n{}\n\nLast checkpoint:\n{}",
        entry.snapshot.task, subagent_capability::truncate_chars(&checkpoint, 2_000).0
    );
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
    prepare_child_request(&mut entry.request, &task, entry.snapshot.read_only);
    entry.continuations = 0;
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

fn delegation_session(session: &str) -> Option<Session> {
    open_store().ok().and_then(|store| {
        Uuid::parse_str(session)
            .ok()
            .and_then(|id| store.get_session(id).ok().flatten())
    })
}

pub(super) fn can_delegate(session: &str) -> bool {
    delegation_session(session).is_some_and(|session| session.parent_session_id.is_none())
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
    let manager = app.state::<AgentManager>();
    loop {
        if provider_chat_cancelled(app, &bound.session_id) {
            anyhow::bail!(provider_stop_message(app, &bound.session_id));
        }
        let entries = manager
            .entries
            .lock()
            .map_err(|_| anyhow::anyhow!("agent state unavailable"))?;
        let snapshots = ids
            .iter()
            .map(|id| {
                let entry = entries
                    .get(id)
                    .ok_or_else(|| anyhow::anyhow!("agent not found: {id}"))?;
                owned(&entry.snapshot, &bound.session_id)?;
                Ok(entry.snapshot.clone())
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        let remaining = deadline.saturating_duration_since(Instant::now());
        if snapshots.iter().all(|agent| !is_live(&agent.status)) || remaining.is_zero() {
            return Ok(snapshots);
        }
        // Lifecycle publication wakes this immediately; the bounded timeout
        // still observes parent cancellation without a 20Hz polling loop.
        let _ = manager
            .changed
            .wait_timeout(entries, remaining.min(Duration::from_millis(250)))
            .map_err(|_| anyhow::anyhow!("agent state unavailable"))?;
    }
}

pub(super) fn acknowledge_reports(
    app: &tauri::AppHandle,
    parent: &str,
    snapshots: &[AgentSnapshot],
) -> anyhow::Result<()> {
    let manager = app.state::<AgentManager>();
    let mut entries = manager
        .entries
        .lock()
        .map_err(|_| anyhow::anyhow!("agent state unavailable"))?;
    mark_delivered(&mut entries, parent, snapshots);
    Ok(())
}

fn mark_delivered(
    entries: &mut HashMap<String, AgentEntry>,
    parent: &str,
    snapshots: &[AgentSnapshot],
) {
    for snapshot in snapshots {
        if let Some(entry) = entries.get_mut(&snapshot.agent_id) {
            if entry.snapshot.parent_session_id == parent
                && entry.snapshot.run_id == snapshot.run_id
                && entry.snapshot.updated_at == snapshot.updated_at
                && !is_live(&entry.snapshot.status)
            {
                entry.delivered = true;
            }
        }
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
    if let Err(error) = publish(app, &snapshot, true) {
        settle(entry, Err(error.to_string()), false);
        let _ = publish(app, &entry.snapshot, true);
        drop(control);
        drop(entries);
        return Err(error);
    }
    drop(entries);
    start_worker(app.clone(), id.to_string(), control)?;
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
            continuations: 0,
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
    // Async coding agents use their provider's watchdog and the parent's
    // cancellation, not the synchronous research bridge's 14-minute deadline.
    let results = loop {
        let results = wait(app, &bound, &ids, Duration::from_secs(60))?;
        if results.iter().all(|agent| !is_live(&agent.status)) {
            break results;
        }
    };
    let report = serde_json::to_string(&bounded_reports(&results)?)?;
    acknowledge_reports(app, &bound.session_id, &results)?;
    Ok(Some(report))
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
fn reconcile_saved_snapshot(snapshot: &mut AgentSnapshot, events: &[SessionEvent]) {
    let run = Uuid::parse_str(&snapshot.run_id).ok();
    let relevant = events
        .iter()
        .filter(|event| run.is_some() && event.turn_id == run)
        .collect::<Vec<_>>();
    let response = relevant
        .iter()
        .rev()
        .find(|event| event.kind == SessionEventKind::AssistantMessage);
    let status = relevant
        .iter()
        .rev()
        .find(|event| event.payload.get("kind").and_then(Value::as_str) == Some("provider-status"));
    let notice = status.and_then(|event| event.payload.get("error").and_then(Value::as_str));
    snapshot.status = "interrupted".into();
    snapshot.summary = None;
    snapshot.error = Some(PROVIDER_INTERRUPTED_MARKER.into());
    if let Some(response) = response {
        snapshot.summary = Some(subagent_capability::truncate_chars(&response.message, 8_000).0);
        let partial = notice.filter(|notice| {
            provider_reliability::is_tool_budget_notice(notice) || notice.contains("may be cut off")
        });
        let stopped = status.is_some_and(|event| event.payload["status"] == "cancelled");
        let requires_completion = relevant.iter().any(|event| {
            event.kind == SessionEventKind::UserMessage
                && event.message.contains(GYRO_AGENT_UPDATE_MARKER)
        });
        snapshot.error = if stopped {
            Some("The sub-agent was stopped before task completion.".into())
        } else {
            partial
                .map(gyro_core::security::redact_secrets)
                .or_else(|| completion_error(&response.payload, requires_completion))
        };
        snapshot.status = if stopped {
            "cancelled"
        } else if snapshot.error.is_some() {
            "interrupted"
        } else {
            "completed"
        }
        .into();
    } else if let Some(status) = status {
        match status.payload.get("status").and_then(Value::as_str) {
            Some("failed") if notice != Some(PROVIDER_INTERRUPTED_MARKER) => {
                snapshot.status = "failed".into()
            }
            Some("cancelled") => snapshot.status = "cancelled".into(),
            _ => {}
        }
        snapshot.error = notice
            .map(gyro_core::security::redact_secrets)
            .or(snapshot.error.take());
    }
    if let Some(start) = snapshot
        .started_at
        .take()
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(&value).ok())
    {
        let end = relevant
            .iter()
            .rev()
            .find(|event| {
                event.payload.get("error").and_then(Value::as_str)
                    != Some(PROVIDER_INTERRUPTED_MARKER)
            })
            .map(|event| event.created_at)
            .unwrap_or_else(|| start.with_timezone(&Utc));
        snapshot.elapsed_ms = snapshot
            .elapsed_ms
            .saturating_add(end.signed_duration_since(start).num_milliseconds().max(0) as u64);
    }
    if let Some(last) = relevant.last() {
        snapshot.updated_at = last.created_at.to_rfc3339();
    }
}

fn list(app: &tauri::AppHandle, parent: &str) -> anyhow::Result<Vec<AgentSnapshot>> {
    let store = open_store().map_err(anyhow::Error::msg)?;
    let mut snapshots = HashMap::new();
    let parent_events = store.read_events(Uuid::parse_str(parent)?)?;
    for event in &parent_events {
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
        let latest_turn = events.iter().rev().find_map(|event| event.turn_id);
        let response = events.iter().rev().find(|event| {
            event.kind == SessionEventKind::AssistantMessage && event.turn_id == latest_turn
        });
        let parent_turn = parent_events
            .iter()
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
                status: "running".into(),
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
                run_id: latest_turn.map(|id| id.to_string()).unwrap_or_default(),
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
            let events = store.read_events(Uuid::parse_str(&snapshot.agent_id)?)?;
            reconcile_saved_snapshot(snapshot, &events);
            // Ledger counts survive even if the last lifecycle write was lost.
            if let Ok(totals) = store.session_usage_totals(Uuid::parse_str(&snapshot.agent_id)?) {
                if totals.calls > 0 {
                    snapshot.tokens = store
                        .session_usage_tokens(Uuid::parse_str(&snapshot.agent_id)?)
                        .ok()
                        .flatten();
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
    let report_options = agent_reports::Options::parse(&request.arguments)?;
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
    let report = agent_reports::render(&snapshots, &report_options)?;
    acknowledge_reports(app, &bound.session_id, &snapshots)?;
    Ok((
        format!("Updated {} sub-agent(s)", snapshots.len()),
        report,
        resource,
    ))
}

// Tool reports omit the already-known task and share a conservative escaped-JSON
// budget. The complete transcript remains available in the companion panel.
fn bounded_reports(snapshots: &[AgentSnapshot]) -> anyhow::Result<Vec<Value>> {
    let options = agent_reports::Options::parse(&json!({}))?;
    let data = agent_reports::render(snapshots, &options)?;
    Ok(data["agents"].as_array().cloned().unwrap_or_default())
}

pub(super) fn schema(id: CapabilityId) -> Option<(Value, Vec<&'static str>)> {
    Some(match id {
        CapabilityId::AgentSpawn => (
            json!({"name":{"type":"string","minLength":1,"maxLength":60},"task":{"type":"string","minLength":1,"maxLength":16000}}),
            vec!["name", "task"],
        ),
        CapabilityId::AgentWait => (
            json!({"agentIds":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"string"}},"timeoutMs":{"type":"integer","minimum":0,"maximum":60000},
                "knownRevisions":{"type":"object","additionalProperties":{"type":"string"},"description":"Map agentId to its last returned revision to omit unchanged reports. Omit an ID to retrieve its summary again."},
                "maxBytes":workspace_result_bytes_schema()}),
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

    #[test]
    fn reasoning_effort_does_not_authorize_delegation() {
        let mut request = entry().request;
        request.message = "Implement the requested workspace change".into();
        for effort in [
            None,
            Some("low"),
            Some("medium"),
            Some("high"),
            Some("xhigh"),
            Some("invalid"),
        ] {
            request.reasoning_effort = effort.map(str::to_owned);
            assert!(!request_allows_delegation(&request), "{effort:?}");
        }
        for effort in ["max", "ultra", " MAX "] {
            request.reasoning_effort = Some(effort.into());
            assert!(!request_allows_delegation(&request), "{effort}");
            request.mode = ChatMode::Plan;
            assert!(!request_allows_delegation(&request));
            request.mode = ChatMode::Council;
            assert!(!request_allows_delegation(&request));
            request.mode = ChatMode::Normal;
        }
    }

    #[test]
    fn explicit_requests_allow_delegation_but_mentions_and_quoted_instructions_do_not() {
        let mut request = entry().request;
        request.reasoning_effort = Some("high".into());
        for message in [
            "Use subagents to review the parser",
            "Please start 2 sub-agents for this change",
            "Can you use sub agents to inspect the UI?",
            "Delegate the parser review to a sub-agent",
            "Build the dashboard using subagents",
            "Can you please use subagents to review this?",
        ] {
            request.message = message.into();
            assert!(request_allows_delegation(&request), "{message}");
        }
        for message in [
            "HOW THE HELL IS THE MODEL STARTING SUB AGENTS ON HIGH EFFORT MODE?",
            "Why did you start subagents?",
            "How can I use subagents?",
            "Why is the model using subagents?",
            "Please explain how models use subagents",
            "The docs say: use subagents",
            "The model started two subagents",
            "> Use subagents for this task",
            "\"Use subagents for this task\"",
            "Attached instructions:\n```text\nUse subagents for this task\n```\nExplain these instructions",
            "Do not use subagents",
            "Don't start sub-agents",
            "Use subagents only when I ask",
            "Can you run tests for subagents?",
            "Use subagent status in the sidebar",
            "Use the word subagents in the description",
            "Create a demo using subagent events",
            "Use the existing tests to verify subagent behavior",
            "Build the UI using the current subagent status",
        ] {
            request.message = message.into();
            assert!(!request_allows_delegation(&request), "{message}");
        }
        request.reasoning_effort = Some("max".into());
        for message in [
            "Do not use subagents",
            "Don't launch sub-agents",
            "Work without using subagents",
            "No subagents",
            "Implement without subagents",
            "Please work without sub-agents",
        ] {
            request.message = message.into();
            assert!(!request_allows_delegation(&request), "{message}");
        }
        assert!(prompt_guidance_for_role(&request, false, true).contains("one agent"));
        request.message = "Use subagents to investigate".into();
        assert!(request_allows_delegation(&request));
        assert!(prompt_guidance_for_role(&request, true, true).contains("one agent"));
        request.message = child_prompt("Inspect parser", false);
        assert!(!request_allows_delegation(&request));
    }

    #[test]
    fn single_agent_guidance_replaces_delegation_on_fresh_and_resumed_turns() {
        let mut request = entry().request;
        request.reasoning_effort = Some("high".into());
        for resumed in [false, true] {
            let prompt = provider_context_message_for_turn(
                &request,
                None,
                PromptTurn {
                    resumed,
                    approvals_sent_separately: false,
                },
            );
            assert!(prompt.contains("This turn runs with one agent"));
            assert!(!prompt.contains("gyro_agent_spawn/wait/send/stop"));
            assert!(!prompt.contains("task complexity warrants another model call"));
            request.reasoning_effort = Some("max".into());
            let prompt = provider_context_message_for_turn(
                &request,
                None,
                PromptTurn {
                    resumed,
                    approvals_sent_separately: false,
                },
            );
            assert!(!prompt.contains("gyro_agent_spawn/wait/send/stop"));
            let original_message = request.message.clone();
            request.message = "Use subagents to implement the requested change".into();
            let prompt = provider_context_message_for_turn(
                &request,
                None,
                PromptTurn {
                    resumed,
                    approvals_sent_separately: false,
                },
            );
            assert!(prompt.contains("gyro_agent_spawn/wait/send/stop"));
            request.message = original_message;
            request.reasoning_effort = Some("high".into());
        }
    }

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
            continuations: 0,
            delivered: false,
        }
    }

    fn child_response(message: &str, notice: Option<&str>) -> ProviderChatResponse {
        let child = Uuid::new_v4();
        ProviderChatResponse {
            activity_events: Vec::new(),
            assistant_event: SessionEvent::new(
                child,
                SessionEventKind::AssistantMessage,
                message,
                json!({}),
            ),
            session: None,
            session_title: None,
            resume_cursor: None,
            status_event: SessionEvent::new(
                child,
                SessionEventKind::SystemEvent,
                "done",
                json!({"kind":"provider-status","status":"done","error":notice}),
            ),
        }
    }

    #[test]
    fn browser_boilerplate_does_not_charge_unrelated_tasks_for_the_full_guide() {
        let unrelated = child_prompt("Fix and test the parser in crates/parser.rs", false);
        assert!(user_requests_gyro_browser(&unrelated));
        let task = browser_task_message(&unrelated);
        assert_eq!(task, "Fix and test the parser in crates/parser.rs");
        assert!(!user_requests_gyro_browser(task));
        let browsing = child_prompt(
            "Use Browser to verify the signup button at https://example.test",
            false,
        );
        assert!(user_requests_gyro_browser(browser_task_message(&browsing)));
        let mut entry = entry();
        entry.snapshot.task = task.into();
        entry.snapshot.summary = Some("I used Browser for unrelated documentation.".into());
        begin_continuation(&mut entry);
        assert_eq!(browser_task_message(&entry.request.message), task);
        assert!(!user_requests_gyro_browser(browser_task_message(
            &entry.request.message
        )));
        let mut request = entry.request;
        request.message = unrelated;
        let before = browser_knowledge::context(true, true, "normal", true)
            .chars()
            .count();
        let after = browser_knowledge::context(true, true, "normal", false)
            .chars()
            .count();
        assert!(after < before);
        println!("Unrelated child browser guidance: {before} -> {after} characters");
        let root_message = "Open https://example.test in Browser";
        assert_eq!(browser_task_message(root_message), root_message);
    }

    #[test]
    fn new_tasks_require_completion_and_preserve_the_parents_choices() {
        let mut entry = entry();
        entry.request.model_id = Some("selected-model".into());
        entry.request.reasoning_effort = Some("xhigh".into());
        entry.request.goal = Some(SessionGoalContext {
            text: "Parent goal".into(),
            status: "active".into(),
        });
        entry.request.plan = Some(json!({"items":[{"title":"unrelated parent step"}]}));
        entry.request.workspace_context = Some(WorkspaceContextSnapshot::empty("parent-pane"));
        let policy = entry.ceiling.clone();
        prepare_child_request(&mut entry.request, "Implement and verify parser", true);
        assert_eq!(entry.request.model_id.as_deref(), Some("selected-model"));
        assert_eq!(entry.request.reasoning_effort.as_deref(), Some("xhigh"));
        assert_eq!(entry.ceiling, policy);
        assert!(entry.request.goal.is_none());
        assert!(entry.request.plan.is_none());
        assert!(entry.request.workspace_context.is_none());
        assert!(entry.request.workspace_check.is_none());
        assert!(entry.request.message.contains("do not stop at a plan"));
        settle(
            &mut entry,
            Ok(child_response("I will inspect the parser next.", None)),
            false,
        );
        assert_eq!(entry.snapshot.status, "interrupted");
        assert_eq!(
            entry.snapshot.error.as_deref(),
            Some(UNCONFIRMED_TASK_NOTICE)
        );
        assert!(!can_continue(&entry));
    }

    fn reported_response(status: &str, notice: Option<&str>) -> ProviderChatResponse {
        let mut response = child_response("Verified changes; remaining work is recorded.", notice);
        response.assistant_event.payload["agentUpdate"] =
            json!({"status":status,"reason":"Missing test service"});
        response
    }

    #[test]
    fn restored_completion_keeps_unfinished_and_blocked_reports_interrupted() {
        for reported in ["continue", "blocked", "complete"] {
            let run = Uuid::new_v4();
            let child = Uuid::new_v4();
            let mut snapshot = entry().snapshot;
            snapshot.run_id = run.to_string();
            let mut response = reported_response(reported, None).assistant_event;
            response.turn_id = Some(run);
            let mut user = SessionEvent::new(
                child,
                SessionEventKind::UserMessage,
                child_prompt("Implement and verify parser", false),
                json!({}),
            );
            user.turn_id = Some(run);
            reconcile_saved_snapshot(&mut snapshot, &[user, response]);
            assert_eq!(
                snapshot.status,
                if reported == "complete" {
                    "completed"
                } else {
                    "interrupted"
                }
            );
        }
        let run = Uuid::new_v4();
        let mut snapshot = entry().snapshot;
        snapshot.run_id = run.to_string();
        let mut response = child_response("Here is the implementation plan.", None).assistant_event;
        response.turn_id = Some(run);
        let mut user = SessionEvent::new(
            Uuid::new_v4(),
            SessionEventKind::UserMessage,
            child_prompt("Implement parser", false),
            json!({}),
        );
        user.turn_id = Some(run);
        reconcile_saved_snapshot(&mut snapshot, &[user, response]);
        assert_eq!(snapshot.status, "interrupted");
        assert_eq!(snapshot.error.as_deref(), Some(UNCONFIRMED_TASK_NOTICE));
    }

    #[test]
    fn unfinished_work_continues_twice_without_starting_a_separate_queued_task() {
        let mut entry = entry();
        entry.request.message = child_prompt("Implement parser", false);
        entry.snapshot.task = "Implement parser".into();
        entry.pending.push("A separately assigned task".into());
        for round in 0..=MAX_AUTOMATIC_CONTINUATIONS {
            settle(&mut entry, Ok(reported_response("continue", None)), false);
            assert_eq!(entry.snapshot.status, "interrupted");
            if round < MAX_AUTOMATIC_CONTINUATIONS {
                assert!(can_continue(&entry));
                assert_eq!(entry.pending.len(), 1);
                let prior_run = entry.snapshot.run_id.clone();
                begin_continuation(&mut entry);
                assert_ne!(entry.snapshot.run_id, prior_run);
                assert_eq!(entry.continuations, round + 1);
                assert_eq!(entry.snapshot.task, "Implement parser");
                assert!(entry
                    .request
                    .message
                    .contains("Do not replay completed edits"));
                assert!(entry.request.message.contains("Last checkpoint"));
                assert!(!entry.delivered);
            } else {
                assert!(!can_continue(&entry));
                assert!(entry.pending.is_empty());
                assert!(entry
                    .snapshot
                    .error
                    .as_deref()
                    .unwrap()
                    .contains("continuation limit"));
                assert!(entry.snapshot.summary.is_some());
            }
        }
        begin_followup(&mut entry, "New authorized task".into());
        assert_eq!(entry.continuations, 0);
    }

    #[test]
    fn explicit_completion_blockers_and_cancellation_are_distinct() {
        let mut entry = entry();
        entry.request.message = child_prompt("Implement parser", false);
        settle(&mut entry, Ok(reported_response("blocked", None)), false);
        assert_eq!(entry.snapshot.status, "interrupted");
        assert!(entry
            .snapshot
            .error
            .as_deref()
            .unwrap()
            .contains("Missing test service"));
        assert!(!can_continue(&entry));
        settle(&mut entry, Ok(reported_response("complete", None)), false);
        assert_eq!(entry.snapshot.status, "completed");
        assert!(entry.snapshot.error.is_none());
        settle(&mut entry, Ok(reported_response("complete", None)), true);
        assert_eq!(entry.snapshot.status, "cancelled");
        assert!(!can_continue(&entry));
        for notice in [PROVIDER_TOOL_BUDGET_NOTICE, PROVIDER_CUT_OFF_NOTICE] {
            settle(
                &mut entry,
                Ok(reported_response("complete", Some(notice))),
                false,
            );
            assert_eq!(entry.snapshot.status, "interrupted");
            assert!(!can_continue(&entry));
        }
        assert!(
            completion_update(&json!({"status":"complete","policy":"allow"}))
                .unwrap()
                .get("policy")
                .is_none()
        );
        assert!(completion_update(&json!({"status":"unknown"})).is_none());
        let bounded =
            completion_update(&json!({"status":"blocked","reason":"x".repeat(2000)})).unwrap();
        assert_eq!(bounded["reason"].as_str().unwrap().len(), 800);
    }

    #[test]
    fn partial_child_reports_remain_available_and_do_not_start_queued_work() {
        for notice in [PROVIDER_TOOL_BUDGET_NOTICE, PROVIDER_CUT_OFF_NOTICE] {
            let mut entry = entry();
            entry.pending.push("Continue the implementation".into());
            settle(
                &mut entry,
                Ok(child_response(
                    "Applied the first change; validation remains",
                    Some(notice),
                )),
                false,
            );
            assert_eq!(entry.snapshot.status, "interrupted");
            assert_eq!(
                entry.snapshot.summary.as_deref(),
                Some("Applied the first change; validation remains")
            );
            assert!(entry.snapshot.error.as_deref().unwrap().contains(notice));
            assert!(entry.pending.is_empty());
            assert!(entry.snapshot.started_at.is_none());
        }
        let mut entry = entry();
        entry.pending.push("A separately queued task".into());
        settle(
            &mut entry,
            Err("provider authentication failed".into()),
            false,
        );
        assert_eq!(entry.snapshot.status, "failed");
        assert!(entry.pending.is_empty());
        assert!(entry
            .snapshot
            .error
            .as_deref()
            .unwrap()
            .contains("Queued follow-ups were not started"));
    }

    #[test]
    fn completed_child_keeps_authorized_followups_ready_for_handoff() {
        let mut entry = entry();
        entry.pending.push("Implement the next part".into());
        settle(
            &mut entry,
            Ok(child_response("Verified the first part", None)),
            false,
        );
        assert_eq!(entry.snapshot.status, "completed");
        assert_eq!(entry.pending.len(), 1);
        assert!(entry.snapshot.error.is_none());
    }

    #[test]
    fn failed_report_rendering_does_not_acknowledge_children_or_hide_later_runs() {
        let mut entries = HashMap::new();
        for index in 0..8 {
            let mut entry = entry();
            entry.snapshot.agent_id = format!("child-{index}");
            entry.snapshot.status = "completed".into();
            entries.insert(entry.snapshot.agent_id.clone(), entry);
        }
        let snapshots = entries
            .values()
            .map(|entry| entry.snapshot.clone())
            .collect::<Vec<_>>();
        assert!(agent_reports::render(
            &snapshots,
            &agent_reports::Options::parse(&json!({"maxBytes":1024})).unwrap()
        )
        .is_err());
        assert!(entries.values().all(|entry| !entry.delivered));
        agent_reports::render(
            &snapshots,
            &agent_reports::Options::parse(&json!({})).unwrap(),
        )
        .unwrap();
        mark_delivered(&mut entries, "parent", &snapshots);
        assert!(entries.values().all(|entry| entry.delivered));
        let first = &snapshots[0];
        begin_followup(entries.get_mut(&first.agent_id).unwrap(), "New work".into());
        mark_delivered(&mut entries, "parent", std::slice::from_ref(first));
        assert!(!entries[&first.agent_id].delivered);
    }

    #[test]
    fn one_worker_panic_does_not_poison_other_agents() {
        let manager = AgentManager::default();
        {
            let mut entries = manager.entries.lock().unwrap();
            entries.insert("failed-worker".into(), entry());
            entries.insert("other-worker".into(), entry());
        }
        let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _entries = manager.entries.lock().unwrap();
            panic!("simulated lifecycle panic");
        }));
        assert!(panic.is_err());
        let mut entries = recover_worker_entries(&manager);
        settle(
            entries.get_mut("failed-worker").unwrap(),
            Err("worker stopped unexpectedly".into()),
            false,
        );
        drop(entries);
        let entries = manager.entries.lock().unwrap();
        assert_eq!(entries["failed-worker"].snapshot.status, "failed");
        assert_eq!(entries["other-worker"].snapshot.status, "running");
    }

    #[test]
    fn restart_recovers_durable_child_response_for_the_correct_run() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("data"))).unwrap();
        let child = store
            .create_session(temp.path(), SessionOrigin::Desktop, "recovery")
            .unwrap();
        let completed = Uuid::new_v4();
        store
            .append_event_with_turn_id(
                child.id,
                SessionEventKind::AssistantMessage,
                "Verified changes and tests",
                json!({}),
                Some(completed),
            )
            .unwrap();
        store
            .append_event_with_turn_id(
                child.id,
                SessionEventKind::SystemEvent,
                "done",
                json!({"kind":"provider-status","status":"done"}),
                Some(completed),
            )
            .unwrap();
        let mut snapshot = entry().snapshot;
        snapshot.run_id = completed.to_string();
        reconcile_saved_snapshot(&mut snapshot, &store.read_events(child.id).unwrap());
        assert_eq!(snapshot.status, "completed");
        assert_eq!(
            snapshot.summary.as_deref(),
            Some("Verified changes and tests")
        );
        assert!(snapshot.error.is_none());
        assert!(snapshot.started_at.is_none());

        let failed = Uuid::new_v4();
        store.append_event_with_turn_id(child.id, SessionEventKind::SystemEvent, "failed", json!({"kind":"provider-status","status":"failed","error":"provider refused new turn"}), Some(failed)).unwrap();
        let mut latest = entry().snapshot;
        latest.run_id = failed.to_string();
        reconcile_saved_snapshot(&mut latest, &store.read_events(child.id).unwrap());
        assert_eq!(latest.status, "failed");
        assert!(
            latest.summary.is_none(),
            "an older successful turn must not hide a new failure"
        );
        assert_eq!(latest.error.as_deref(), Some("provider refused new turn"));
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
        let reports = bounded_reports(&agents).unwrap();
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
            allow_delegation: true,
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
        // Old/resumed provider sessions can retain earlier tool schemas. The
        // current host-owned turn still blocks additional paid model calls.
        bound.allow_delegation = false;
        for id in [
            CapabilityId::AgentSpawn,
            CapabilityId::AgentSend,
            CapabilityId::ResearchRun,
        ] {
            assert!(validate_caller(&store, &bound, id)
                .unwrap_err()
                .to_string()
                .contains("one agent"));
        }
        for id in [CapabilityId::AgentWait, CapabilityId::AgentStop] {
            assert!(validate_caller(&store, &bound, id).is_ok());
        }
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
