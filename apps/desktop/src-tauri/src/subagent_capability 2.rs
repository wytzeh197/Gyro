//! Compatibility wrapper for bounded research and child run controls.
use super::*;
use serde_json::{json, Value};

const SUBAGENT_SCHEMA: &str = "gyro.subagent.v1";
const MAX_QUESTION_CHARS: usize = 4_000;
#[cfg(test)]
const MAX_SUMMARY_CHARS: usize = 8_000;
const MAX_TITLE_CHARS: usize = 60;
/// How often a child run checks whether the chat that started it was stopped.
const PARENT_STOP_POLL_INTERVAL: Duration = Duration::from_millis(250);
/// The parent's tool call gives up reading after 15 minutes (the IPC approval
/// read timeout), so research stops just before that instead of spending on
/// with nobody left to read its report.
const RESEARCH_MAX_RUNTIME: Duration = Duration::from_secs(14 * 60);

pub(super) fn retrieves_existing(arguments: &Value) -> bool {
    arguments
        .get("sessionId")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.trim().is_empty())
}

pub(super) fn execute(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    request: &CapabilityRequest,
) -> anyhow::Result<(String, Value, Option<CapabilityResourceRef>)> {
    // Validate before starting a paid run; existing results are read without
    // starting or messaging an agent.
    workspace_result_byte_limit(&request.arguments)?;
    capability_output_budget::offset(&request.arguments, "summaryOffset")?;
    let agent = if request.arguments.get("sessionId").is_some() {
        let id = capability_argument_string(&request.arguments, "sessionId")?;
        delegated_agents::wait(app, bound, &[id.to_owned()], Duration::ZERO)?
            .into_iter()
            .next()
            .ok_or_else(|| anyhow::anyhow!("research agent disappeared"))?
    } else {
        let question =
            normalize_question(capability_argument_string(&request.arguments, "question")?)?;
        let title = truncate_chars(
            &format!("Research: {}", title_from(&question)),
            MAX_TITLE_CHARS,
        )
        .0;
        let agent = delegated_agents::spawn_with_runtime(
            app,
            bound,
            &title,
            &research_prompt(&question),
            Some(RESEARCH_MAX_RUNTIME),
        )?;
        delegated_agents::wait(app, bound, &[agent.agent_id], RESEARCH_MAX_RUNTIME)?
            .into_iter()
            .next()
            .ok_or_else(|| anyhow::anyhow!("research agent disappeared"))?
    };
    if agent.status != "completed" {
        anyhow::bail!(
            "the research sub-agent did not finish: {}",
            agent.error.as_deref().unwrap_or(&agent.status)
        );
    }
    let store = open_store().map_err(anyhow::Error::msg)?;
    let response = store
        .read_events(Uuid::parse_str(&agent.agent_id)?)?
        .into_iter()
        .rev()
        .find(|event| event.kind == SessionEventKind::AssistantMessage);
    let summary = response
        .as_ref()
        .map(|event| event.message.as_str())
        .unwrap_or_else(|| agent.summary.as_deref().unwrap_or(""));
    let mut data = capability_output_budget::text_result(
        json!({
            "schema": SUBAGENT_SCHEMA, "sessionId": agent.agent_id, "title": agent.name,
            "providerId": agent.provider_id, "modelId": agent.model_id,
            "truncated": false, "summary": summary,
            "fullResultAvailableInChat": true,
        }),
        &[capability_output_budget::TextField {
            pointer: "/summary",
            window: "summaryWindow",
            offset: "summaryOffset",
            tail: false,
        }],
        &request.arguments,
    )?;
    data["truncated"] = data["summaryWindow"]["truncated"].clone();
    delegated_agents::acknowledge_reports(app, &bound.session_id, &[agent.clone()])?;
    Ok((
        format!("Read research results in chat {}", agent.agent_id),
        data,
        Some(CapabilityResourceRef {
            id: agent.agent_id,
            kind: "chat".into(),
            label: agent.name,
        }),
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
    let parent = flags
        .get(parent_session_id)
        .ok_or_else(|| anyhow::anyhow!("the chat that asked for research is no longer running"))?;
    if parent.cancellation.is_cancelled() {
        anyhow::bail!("the chat that asked for research was already stopped");
    }
    if flags.len() >= MAX_CONCURRENT_PROVIDER_RUNS {
        anyhow::bail!("Gyro can run at most {MAX_CONCURRENT_PROVIDER_RUNS} provider turns at once");
    }
    let control = Arc::new(ProviderRunControl::default());
    flags.insert(session_id.to_string(), Arc::clone(&control));
    Ok(control)
}

/// Replace a child's finished turn without releasing its concurrency slot.
fn renew_child_run_control(
    flags: &mut HashMap<String, Arc<ProviderRunControl>>,
    session_id: &str,
    parent_session_id: &str,
    current: &Arc<ProviderRunControl>,
) -> anyhow::Result<Arc<ProviderRunControl>> {
    if !flags
        .get(session_id)
        .is_some_and(|control| Arc::ptr_eq(control, current))
    {
        anyhow::bail!("the sub-agent run control changed before its next task");
    }
    let Some(parent) = flags.get(parent_session_id) else {
        current.cancellation.cancel();
        anyhow::bail!("the chat that asked for research is no longer running");
    };
    if current.cancellation.is_cancelled() || parent.cancellation.is_cancelled() {
        // Reflect the parent's stop now, without waiting for the poll watcher.
        current.cancellation.cancel();
        anyhow::bail!("the chat or sub-agent was already stopped");
    }
    let next = Arc::new(ProviderRunControl::default());
    flags.insert(session_id.into(), Arc::clone(&next));
    Ok(next)
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
    #[cfg(test)]
    fn start(parent: &CancellationToken, child: &CancellationToken) -> Self {
        Self::start_until(parent, child, Some(RESEARCH_MAX_RUNTIME)).unwrap()
    }

    /// Test convenience; real child turns share one absolute deadline.
    #[cfg(test)]
    fn start_until(
        parent: &CancellationToken,
        child: &CancellationToken,
        runtime: Option<Duration>,
    ) -> anyhow::Result<Self> {
        Self::start_until_deadline(
            parent,
            child,
            runtime.map(|runtime| Instant::now() + runtime),
        )
    }

    fn start_until_deadline(
        parent: &CancellationToken,
        child: &CancellationToken,
        deadline: Option<Instant>,
    ) -> anyhow::Result<Self> {
        let stopped = Arc::new(AtomicBool::new(false));
        let worker_stopped = Arc::clone(&stopped);
        let parent = parent.clone();
        let child = child.clone();
        let worker = std::thread::Builder::new()
            .name("gyro-parent-stop".into())
            .spawn(move || {
                while !worker_stopped.load(Ordering::SeqCst) {
                    if parent.is_cancelled()
                        || deadline.is_some_and(|deadline| Instant::now() >= deadline)
                    {
                        child.cancel();
                        return;
                    }
                    std::thread::park_timeout(PARENT_STOP_POLL_INTERVAL);
                }
            })?;
        Ok(Self {
            stopped,
            worker: Some(worker),
        })
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
pub(super) struct ChildRunControl {
    app: tauri::AppHandle,
    session_id: String,
    control: Arc<ProviderRunControl>,
    /// Held until teardown; each new task gets a fresh watcher and control.
    watcher: Option<ParentStopWatcher>,
    deadline: Option<Instant>,
}

impl ChildRunControl {
    pub(super) fn claim(
        app: &tauri::AppHandle,
        session_id: &str,
        parent_session_id: &str,
    ) -> anyhow::Result<Self> {
        Self::claim_with_runtime(app, session_id, parent_session_id, None)
    }

    pub(super) fn claim_with_runtime(
        app: &tauri::AppHandle,
        session_id: &str,
        parent_session_id: &str,
        runtime: Option<Duration>,
    ) -> anyhow::Result<Self> {
        let manager = app.state::<ProviderCancellationManager>();
        let mut flags = manager
            .flags
            .lock()
            .map_err(|_| anyhow::anyhow!("provider run state is unavailable"))?;
        let control = claim_child_run_control(&mut flags, session_id, parent_session_id)?;
        let parent = flags.get(parent_session_id).unwrap().cancellation.clone();
        let deadline = runtime.map(|runtime| Instant::now() + runtime);
        let watcher =
            match ParentStopWatcher::start_until_deadline(&parent, &control.cancellation, deadline)
            {
                Ok(watcher) => watcher,
                Err(error) => {
                    release_child_run_control(&mut flags, session_id, &control);
                    return Err(error.context("could not start the sub-agent stop watcher"));
                }
            };
        drop(flags);
        Ok(Self {
            app: app.clone(),
            session_id: session_id.to_string(),
            watcher: Some(watcher),
            deadline,
            control,
        })
    }

    pub(super) fn is_cancelled(&self) -> bool {
        self.control.cancellation.is_cancelled()
    }

    pub(super) fn renew(&mut self, parent_session_id: &str) -> anyhow::Result<()> {
        if let Err(error) = remaining_child_runtime(self.deadline, Instant::now()) {
            self.control.cancellation.cancel();
            return Err(error);
        }
        let manager = self.app.state::<ProviderCancellationManager>();
        let mut flags = manager
            .flags
            .lock()
            .map_err(|_| anyhow::anyhow!("provider run state is unavailable"))?;
        let next = renew_child_run_control(
            &mut flags,
            &self.session_id,
            parent_session_id,
            &self.control,
        )?;
        let parent = flags.get(parent_session_id).unwrap().cancellation.clone();
        let watcher = match ParentStopWatcher::start_until_deadline(
            &parent,
            &next.cancellation,
            self.deadline,
        ) {
            Ok(watcher) => watcher,
            Err(error) => {
                flags.insert(self.session_id.clone(), Arc::clone(&self.control));
                return Err(error.context("could not start the sub-agent stop watcher"));
            }
        };
        self.watcher.take();
        self.control = next;
        self.watcher = Some(watcher);
        Ok(())
    }
}

fn remaining_child_runtime(
    deadline: Option<Instant>,
    now: Instant,
) -> anyhow::Result<Option<Duration>> {
    deadline
        .map(|deadline| {
            deadline
                .checked_duration_since(now)
                .filter(|remaining| !remaining.is_zero())
                .ok_or_else(|| anyhow::anyhow!("the sub-agent reached its runtime limit"))
        })
        .transpose()
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

/// Research defines the task; the parent defines its permissions.
fn research_prompt(question: &str) -> String {
    format!(
        "Research the question below using the tools available under the parent's inherited permissions. \
         Focus on evidence and avoid unrelated changes. When you are done reply with a short report: \
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

pub(super) fn truncate_chars(value: &str, limit: usize) -> (String, bool) {
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
                    "description": "Required to start research: one self-contained question with the paths or behavior needed. Omit when reading an existing sessionId."
                },
                "maxBytes": workspace_result_bytes_schema(),
                "sessionId": { "type":"string","description":"Read a previously returned research session without starting another model run." },
                "summaryOffset": capability_output_budget::offset_schema()
            }),
            vec![],
        ),
        _ => return None,
    };
    Some((properties, required))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn child_continuations_keep_the_original_runtime_deadline() {
        let now = Instant::now();
        let deadline = now + Duration::from_secs(10);
        assert_eq!(
            remaining_child_runtime(Some(deadline), now).unwrap(),
            Some(Duration::from_secs(10))
        );
        assert_eq!(
            remaining_child_runtime(Some(deadline), now + Duration::from_secs(7)).unwrap(),
            Some(Duration::from_secs(3))
        );
        assert!(remaining_child_runtime(Some(deadline), deadline).is_err());
        assert!(
            remaining_child_runtime(Some(deadline), deadline + Duration::from_secs(1)).is_err()
        );
        assert_eq!(
            remaining_child_runtime(None, now + Duration::from_secs(1000)).unwrap(),
            None
        );
    }

    #[test]
    fn reading_existing_research_does_not_admit_a_new_paid_run() {
        assert!(retrieves_existing(
            &json!({"sessionId":"owned-session","summaryOffset":500})
        ));
        for arguments in [
            json!({"question":"new research"}),
            json!({"sessionId":""}),
            json!({"sessionId":"  "}),
            json!({"sessionId":42}),
        ] {
            assert!(!retrieves_existing(&arguments));
        }
        let (properties, required) = schema(CapabilityId::ResearchRun).unwrap();
        assert!(properties["sessionId"].is_object());
        assert!(properties["summaryOffset"].is_object());
        assert!(required.is_empty());
    }

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
    fn the_research_prompt_respects_inherited_permissions() {
        let prompt = research_prompt("how does the capability broker work?");
        assert!(prompt.contains("parent's inherited permissions"));
        assert!(!prompt.contains("cannot write files"));
        assert!(!prompt.contains("cannot write"));
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
    fn schema_supports_new_questions_and_existing_result_reads() {
        let (properties, required) = schema(CapabilityId::ResearchRun).unwrap();
        assert!(properties["question"].is_object());
        assert!(properties["sessionId"].is_object());
        assert!(required.is_empty());
        assert!(schema(CapabilityId::CodeDefinition).is_none());
    }

    fn provider_run_flags() -> HashMap<String, Arc<ProviderRunControl>> {
        HashMap::from([("parent".into(), Arc::new(ProviderRunControl::default()))])
    }

    #[test]
    fn a_child_run_claims_its_own_control_and_gives_it_back() {
        let mut flags = provider_run_flags();
        let control = claim_child_run_control(&mut flags, "child", "parent").unwrap();
        assert!(Arc::ptr_eq(flags.get("child").unwrap(), &control));
        release_child_run_control(&mut flags, "child", &control);
        assert_eq!(flags.len(), 1);
        assert!(flags.contains_key("parent"));
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
        for index in 1..MAX_CONCURRENT_PROVIDER_RUNS {
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
    fn a_missing_parent_cannot_leave_an_unwatched_child() {
        let mut flags = HashMap::new();
        assert!(claim_child_run_control(&mut flags, "child", "missing").is_err());
        assert!(flags.is_empty());
    }

    #[test]
    fn queued_child_turn_keeps_its_slot_even_at_full_capacity() {
        let mut flags = provider_run_flags();
        let old = claim_child_run_control(&mut flags, "child", "parent").unwrap();
        for index in 2..MAX_CONCURRENT_PROVIDER_RUNS {
            flags.insert(
                format!("other-{index}"),
                Arc::new(ProviderRunControl::default()),
            );
        }
        assert_eq!(flags.len(), MAX_CONCURRENT_PROVIDER_RUNS);
        let next = renew_child_run_control(&mut flags, "child", "parent", &old).unwrap();
        assert_eq!(flags.len(), MAX_CONCURRENT_PROVIDER_RUNS);
        assert!(!Arc::ptr_eq(&old, &next));
        assert!(!next.cancellation.is_cancelled());
        release_child_run_control(&mut flags, "child", &old);
        assert!(Arc::ptr_eq(&flags["child"], &next));
        assert!(renew_child_run_control(&mut flags, "child", "parent", &old).is_err());
        next.cancellation.cancel();
        assert!(renew_child_run_control(&mut flags, "child", "parent", &next).is_err());
        assert!(Arc::ptr_eq(&flags["child"], &next));
    }

    #[test]
    fn queued_child_handoff_detects_parent_stop_without_polling_delay() {
        for removed in [false, true] {
            let mut flags = provider_run_flags();
            let current = claim_child_run_control(&mut flags, "child", "parent").unwrap();
            if removed {
                flags.remove("parent");
            } else {
                flags["parent"].cancellation.cancel();
            }
            assert!(!current.cancellation.is_cancelled());
            assert!(renew_child_run_control(&mut flags, "child", "parent", &current).is_err());
            assert!(current.cancellation.is_cancelled());
            assert!(Arc::ptr_eq(&flags["child"], &current));
        }
    }

    #[test]
    fn async_agent_watcher_has_no_research_deadline_and_still_honors_parent_stop() {
        let parent = CancellationToken::default();
        let child = CancellationToken::default();
        let watcher = ParentStopWatcher::start_until(&parent, &child, None).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        assert!(!child.is_cancelled());
        parent.cancel();
        let deadline = Instant::now() + Duration::from_secs(2);
        while !child.is_cancelled() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(child.is_cancelled());
        drop(watcher);
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

    #[test]
    fn research_past_its_runtime_is_stopped() {
        let parent = CancellationToken::default();
        let child = CancellationToken::default();
        let _watcher =
            ParentStopWatcher::start_until(&parent, &child, Some(Duration::ZERO)).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !child.is_cancelled() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(child.is_cancelled(), "research outlived its runtime");
        assert!(!parent.is_cancelled());
    }
}
