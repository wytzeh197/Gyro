//! `gyro_research`: one bounded, read-only provider run in a fresh context.
//!
//! A research sub-agent is a real chat turn in its own session, run in Plan
//! mode, so it inherits the capability policy that already exists for
//! read-only work instead of a hand-rolled tool filter: inspection tools are
//! advertised, and every writing class is denied by the broker. That also makes
//! recursion impossible rather than merely discouraged — this capability's own
//! class is denied in Plan mode, so a sub-agent cannot start another one.
//!
//! The child turn runs against a run control of its own, because every provider
//! run in the app is dispatched through the cancellation manager: the
//! capability context is bound through that control, the broker checks it
//! before executing a tool call, an approval watches it to abandon its wait,
//! and timeline and usage events read their sequence from it. A child without a
//! control dies before its first token — "provider run is no longer active" —
//! which is exactly how research appeared broken.
//!
//! The child's stop token is watched against the parent chat's, so stopping the
//! chat that asked for research also stops the research instead of leaving it
//! to spend on its own while the parent waits for a tool result nobody is
//! waiting for any more. The watch is one-way: stopping the research chat stops
//! only the research.
//!
//! The child session is kept rather than deleted, so the cached research is
//! auditable, and only its final assistant message is returned to the parent.
//! The call blocks the parent's tool call until the child finishes; the child's
//! provider run carries the same timeouts and usage metering as any other turn,
//! attributed to the sub-agent origin so its cost is visible on its own.
use super::*;
use serde_json::{json, Value};

const SUBAGENT_SCHEMA: &str = "gyro.subagent.v1";
const MAX_QUESTION_CHARS: usize = 4_000;
const MAX_SUMMARY_CHARS: usize = 8_000;
const MAX_TITLE_CHARS: usize = 60;
/// How often a child run checks whether the chat that started it was stopped.
const PARENT_STOP_POLL_INTERVAL: Duration = Duration::from_millis(250);

pub(super) fn execute(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    request: &CapabilityRequest,
) -> anyhow::Result<(String, Value, Option<CapabilityResourceRef>)> {
    let question = normalize_question(capability_argument_string(&request.arguments, "question")?)?;
    let store = open_store().map_err(anyhow::Error::msg)?;
    let parent_id = Uuid::parse_str(&bound.session_id)?;
    let parent = store
        .get_session(parent_id)?
        .ok_or_else(|| anyhow::anyhow!("the chat that asked for research no longer exists"))?;
    let provider_id = parent
        .provider_id
        .clone()
        .ok_or_else(|| anyhow::anyhow!("this chat has no provider selected"))?;
    let child = store.create_subagent_session(
        &parent.workspace_path,
        SessionOrigin::Desktop,
        format!("Research: {}", title_from(&question)),
        CreateSessionContext {
            workspace_mode: parent.workspace_mode,
            branch: parent.branch.clone(),
            worktree_name: parent.worktree_name.clone(),
            provider_id: Some(provider_id.clone()),
            provider_label: parent.provider_label.clone(),
            model_id: parent.model_id.clone(),
            model_label: parent.model_label.clone(),
            reasoning_effort: parent.reasoning_effort.clone(),
        },
        parent.id,
    )?;
    // The child turn is a provider run like any other, so it runs against a
    // control registered in the cancellation manager for exactly its lifetime.
    let run = match ChildRunControl::claim(app, &child.id.to_string(), &parent.id.to_string()) {
        Ok(run) => run,
        Err(error) => {
            // The child never started, so there is no research to keep:
            // remove the empty session instead of leaving a stray chat behind.
            let _ = store.delete_session(child.id);
            return Err(error);
        }
    };
    let outcome = run_provider_chat_blocking(
        app.clone(),
        ProviderChatRequest {
            session_id: child.id.to_string(),
            message: research_prompt(&question),
            turn_id: Some(Uuid::new_v4().to_string()),
            provider_id,
            provider_label: child.provider_label.clone(),
            model_id: child.model_id.clone(),
            model_label: child.model_label.clone(),
            reasoning_effort: child.reasoning_effort.clone(),
            // Read-only work still asks before anything unusual, and never
            // inherits the parent's Full Access.
            require_command_approval: true,
            require_file_edit_approval: true,
            full_access: false,
            suggest_title: false,
            workspace_path: Some(parent.workspace_path.to_string_lossy().to_string()),
            mode: ChatMode::Plan,
            goal: None,
            plan: None,
            attachments: Vec::new(),
            workspace_context: None,
            workspace_check: None,
        },
        UsageOrigin::SubAgent,
    );
    // Nothing may approve, cancel, or meter against the child run once it has
    // returned; the run wrote its own events before releasing the control.
    drop(run);
    let response = outcome
        .map_err(|error| anyhow::anyhow!("the research sub-agent did not finish: {error}"))?;
    let (summary, truncated) = truncate_chars(&response.assistant_event.message, MAX_SUMMARY_CHARS);
    let resource = CapabilityResourceRef {
        id: child.id.to_string(),
        kind: "chat".into(),
        label: child.title.clone(),
    };
    Ok((
        format!("Research finished in chat {}", child.id),
        json!({
            "schema": SUBAGENT_SCHEMA,
            "sessionId": child.id,
            "title": child.title,
            "providerId": child.provider_id,
            "modelId": child.model_id,
            "question": question,
            "truncated": truncated,
            "summary": summary,
        }),
        Some(resource),
    ))
}

/// Registers a run control for one research session.
///
/// Split out of the app handle so the bookkeeping stays testable on its own:
/// the session collision check, the app-wide ceiling on concurrent provider
/// runs, and the check that the chat which asked for research is still alive.
fn claim_child_run_control(
    flags: &mut HashMap<String, Arc<ProviderRunControl>>,
    session_id: &str,
    parent_session_id: &str,
) -> anyhow::Result<Arc<ProviderRunControl>> {
    if flags.contains_key(session_id) {
        anyhow::bail!("a provider turn is already running for this research chat");
    }
    if flags.len() >= MAX_CONCURRENT_PROVIDER_RUNS {
        anyhow::bail!("Gyro can run at most {MAX_CONCURRENT_PROVIDER_RUNS} provider turns at once");
    }
    if flags
        .get(parent_session_id)
        .is_some_and(|parent| parent.cancellation.is_cancelled())
    {
        anyhow::bail!("the chat that asked for research was already stopped");
    }
    let control = Arc::new(ProviderRunControl::default());
    flags.insert(session_id.to_string(), Arc::clone(&control));
    Ok(control)
}

/// Removes a child's control, but only while it is still that child's own, so a
/// run that already ended cannot release the booking of the run that replaced
/// it.
fn release_child_run_control(
    flags: &mut HashMap<String, Arc<ProviderRunControl>>,
    session_id: &str,
    control: &Arc<ProviderRunControl>,
) {
    if flags
        .get(session_id)
        .is_some_and(|current| Arc::ptr_eq(current, control))
    {
        flags.remove(session_id);
    }
}

/// Stops a child run when the chat that started it is stopped.
///
/// The two runs are watched rather than sharing one token, because a shared
/// token would let a stop of the research chat stop the chat that asked for it.
/// The watch is one-way and one-shot: a parent stop reaches the child, a child
/// stop does not reach the parent.
struct ParentStopWatcher {
    stopped: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl ParentStopWatcher {
    fn start(parent: &CancellationToken, child: &CancellationToken) -> Self {
        let stopped = Arc::new(AtomicBool::new(false));
        let worker_stopped = Arc::clone(&stopped);
        let parent = parent.clone();
        let child = child.clone();
        let worker = std::thread::spawn(move || {
            while !worker_stopped.load(Ordering::SeqCst) {
                if parent.is_cancelled() {
                    child.cancel();
                    return;
                }
                std::thread::park_timeout(PARENT_STOP_POLL_INTERVAL);
            }
        });
        Self {
            stopped,
            worker: Some(worker),
        }
    }
}

impl Drop for ParentStopWatcher {
    fn drop(&mut self) {
        // Dropping joins the poll loop, so a finished run leaves no thread
        // behind to stop the run that comes next.
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            worker.thread().unpark();
            let _ = worker.join();
        }
    }
}

/// The run control a research child owns for exactly as long as its turn runs.
///
/// Every provider run in the app is registered in the cancellation manager for
/// its lifetime: the capability context is bound through that control, the
/// broker checks it before executing a tool call, an approval watches it to
/// abandon its wait, and timeline and usage events read their sequence from it.
/// A child is a real provider run, so it claims a control of its own before the
/// child turn starts; without one the run dies before its first token with
/// "provider run is no longer active", which is how research appeared broken.
struct ChildRunControl {
    app: tauri::AppHandle,
    session_id: String,
    control: Arc<ProviderRunControl>,
    /// Absent only if the parent's control was already gone, which the broker
    /// makes practically impossible while the tool call it dispatched runs.
    watcher: Option<ParentStopWatcher>,
}

impl ChildRunControl {
    fn claim(
        app: &tauri::AppHandle,
        session_id: &str,
        parent_session_id: &str,
    ) -> anyhow::Result<Self> {
        let manager = app.state::<ProviderCancellationManager>();
        let mut flags = manager
            .flags
            .lock()
            .map_err(|_| anyhow::anyhow!("provider run state is unavailable"))?;
        let control = claim_child_run_control(&mut flags, session_id, parent_session_id)?;
        let parent = flags
            .get(parent_session_id)
            .map(|parent| parent.cancellation.clone());
        drop(flags);
        Ok(Self {
            app: app.clone(),
            session_id: session_id.to_string(),
            watcher: parent.map(|parent| ParentStopWatcher::start(&parent, &control.cancellation)),
            control,
        })
    }
}

impl Drop for ChildRunControl {
    fn drop(&mut self) {
        // Stop watching first: the watcher must not cancel the child while the
        // run is being torn down, and dropping it joins its poll loop.
        self.watcher.take();
        if let Ok(mut flags) = self.app.state::<ProviderCancellationManager>().flags.lock() {
            release_child_run_control(&mut flags, &self.session_id, &self.control);
        }
    }
}

/// A sub-agent gets a question, not a conversation: it is told what it is, that
/// it may only read, and that the parent wants findings rather than a plan.
fn research_prompt(question: &str) -> String {
    format!(
        "You are a read-only research sub-agent started by another Gyro chat. \
         Answer the question below using only read-only tools (search, read, code navigation, git history). \
         You cannot write files, run commands, or fetch the web. \
         Work from evidence in this workspace, and when you are done reply with a short report: \
         the findings, the file paths and line numbers that support them, and anything you could not determine. \
         Do not produce a plan or ask for approval; the chat that started you will relay your report.\n\n\
         Question: {question}"
    )
}

fn normalize_question(value: &str) -> anyhow::Result<String> {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        anyhow::bail!("capability argument `question` is required");
    }
    if collapsed.chars().count() > MAX_QUESTION_CHARS {
        anyhow::bail!("a research question is limited to {MAX_QUESTION_CHARS} characters");
    }
    Ok(collapsed)
}

fn title_from(question: &str) -> String {
    truncate_chars(question, MAX_TITLE_CHARS).0
}

fn truncate_chars(value: &str, limit: usize) -> (String, bool) {
    if value.chars().count() <= limit {
        return (value.to_string(), false);
    }
    (value.chars().take(limit).collect::<String>(), true)
}

/// Tool schemas live here so `lib.rs` keeps a single delegation guard instead
/// of one delegation arm per capability.
pub(super) fn schema(id: CapabilityId) -> Option<(Value, Vec<&'static str>)> {
    let (properties, required) = match id {
        CapabilityId::ResearchRun => (
            json!({
                "question": {
                    "type": "string",
                    "description": "One self-contained research question. The sub-agent starts with no memory of this chat, so include the paths, symbols, or behaviour it needs to know about."
                }
            }),
            vec!["question"],
        ),
        _ => return None,
    };
    Some((properties, required))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn questions_collapse_whitespace_and_are_bounded() {
        assert_eq!(
            normalize_question("  where\nis   the parser? ").unwrap(),
            "where is the parser?"
        );
        assert!(normalize_question("   ").is_err());
        let long = "x".repeat(MAX_QUESTION_CHARS + 1);
        assert!(normalize_question(&long).is_err());
    }

    #[test]
    fn the_prompt_states_the_question_and_the_read_only_contract() {
        let prompt = research_prompt("how does the capability broker work?");
        assert!(prompt.contains("read-only research sub-agent"));
        assert!(prompt.contains("cannot write files"));
        assert!(
            prompt.contains("How does") || prompt.contains("how does the capability broker work?")
        );
        assert!(prompt.contains("Do not produce a plan"));
    }

    #[test]
    fn titles_are_short_enough_for_a_chat_list() {
        let title = title_from(&"word ".repeat(40));
        assert!(title.chars().count() <= MAX_TITLE_CHARS);
        assert_eq!(title_from("short question"), "short question");
    }

    #[test]
    fn summaries_are_truncated_rather_than_dumped() {
        let long = "y".repeat(MAX_SUMMARY_CHARS + 10);
        let (summary, truncated) = truncate_chars(&long, MAX_SUMMARY_CHARS);
        assert!(truncated);
        assert_eq!(summary.chars().count(), MAX_SUMMARY_CHARS);
        let (short, truncated) = truncate_chars("done", MAX_SUMMARY_CHARS);
        assert!(!truncated);
        assert_eq!(short, "done");
    }

    #[test]
    fn schema_requires_a_question_and_ignores_other_capabilities() {
        let (properties, required) = schema(CapabilityId::ResearchRun).unwrap();
        assert!(properties["question"].is_object());
        assert_eq!(required, vec!["question"]);
        assert!(schema(CapabilityId::CodeDefinition).is_none());
    }

    fn provider_run_flags() -> HashMap<String, Arc<ProviderRunControl>> {
        HashMap::new()
    }

    #[test]
    fn a_child_run_claims_its_own_control_and_gives_it_back() {
        let mut flags = provider_run_flags();
        let control = claim_child_run_control(&mut flags, "child", "parent").unwrap();
        assert!(Arc::ptr_eq(flags.get("child").unwrap(), &control));
        release_child_run_control(&mut flags, "child", &control);
        assert!(flags.is_empty());
    }

    #[test]
    fn a_second_claim_cannot_take_a_running_research_chat() {
        let mut flags = provider_run_flags();
        claim_child_run_control(&mut flags, "child", "parent").unwrap();
        let Err(error) = claim_child_run_control(&mut flags, "child", "parent") else {
            unreachable!("a session with a live run must not be claimed twice")
        };
        assert!(error.to_string().contains("already running"));
        // The refused claim left the running child's control in place.
        assert!(flags.contains_key("child"));
    }

    #[test]
    fn the_app_wide_run_ceiling_applies_to_research_too() {
        let mut flags = provider_run_flags();
        for index in 0..MAX_CONCURRENT_PROVIDER_RUNS {
            flags.insert(
                format!("chat-{index}"),
                Arc::new(ProviderRunControl::default()),
            );
        }
        let Err(error) = claim_child_run_control(&mut flags, "child", "parent") else {
            unreachable!("a full run table must refuse another provider run")
        };
        assert!(error.to_string().contains("at most"));
        assert!(!flags.contains_key("child"));
    }

    #[test]
    fn research_does_not_start_for_an_already_stopped_chat() {
        let mut flags = provider_run_flags();
        let parent = Arc::new(ProviderRunControl::default());
        parent.cancellation.cancel();
        flags.insert("parent".to_string(), parent);
        let Err(error) = claim_child_run_control(&mut flags, "child", "parent") else {
            unreachable!("a stopped chat must not start new work")
        };
        assert!(error.to_string().contains("already stopped"));
        assert!(!flags.contains_key("child"));
    }

    #[test]
    fn a_released_child_control_is_not_released_twice() {
        let mut flags = provider_run_flags();
        let control = claim_child_run_control(&mut flags, "child", "parent").unwrap();
        release_child_run_control(&mut flags, "child", &control);
        // A replacement run's booking survives the old run's late release.
        let replacement = claim_child_run_control(&mut flags, "child", "parent").unwrap();
        release_child_run_control(&mut flags, "child", &control);
        assert!(Arc::ptr_eq(flags.get("child").unwrap(), &replacement));
    }

    #[test]
    fn stopping_the_parent_stops_the_child() {
        let parent = CancellationToken::default();
        let child = CancellationToken::default();
        let watcher = ParentStopWatcher::start(&parent, &child);
        parent.cancel();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !child.is_cancelled() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(child.is_cancelled(), "the watcher never stopped the child");
        drop(watcher);
    }

    #[test]
    fn a_stopped_child_leaves_the_parent_running() {
        let parent = CancellationToken::default();
        let child = CancellationToken::default();
        let _watcher = ParentStopWatcher::start(&parent, &child);
        child.cancel();
        std::thread::sleep(PARENT_STOP_POLL_INTERVAL * 2);
        assert!(!parent.is_cancelled());
    }

    #[test]
    fn a_released_watcher_no_longer_stops_the_child() {
        let parent = CancellationToken::default();
        let child = CancellationToken::default();
        let watcher = ParentStopWatcher::start(&parent, &child);
        drop(watcher);
        parent.cancel();
        std::thread::sleep(PARENT_STOP_POLL_INTERVAL * 2);
        assert!(!child.is_cancelled());
    }
}
