//! Durable, bounded goal continuation. The goal event log is the queue.
//! Only a queued turn with no dispatched attempt is recoverable automatically.
use super::*;
use serde::{Deserialize, Serialize};

pub(super) const EVENT: &str = "gyro://goal-run-event";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct Limits {
    pub max_automatic_turns: u32,
    pub max_minutes: u32,
    pub max_new_tokens: u64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            max_automatic_turns: 8,
            max_minutes: 120,
            max_new_tokens: 500_000,
        }
    }
}
impl Limits {
    pub(super) fn validate(&self) -> Result<(), String> {
        if !(1..=32).contains(&self.max_automatic_turns)
            || !(1..=1440).contains(&self.max_minutes)
            || !(1_000..=10_000_000).contains(&self.max_new_tokens)
        {
            return Err("goal limits require 1–32 automatic turns, 1–1440 minutes, and 1,000–10,000,000 new tokens".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Run {
    id: Uuid,
    #[serde(default)]
    goal_version: Option<Uuid>,
    status: String,
    started_at: chrono::DateTime<chrono::Utc>,
    deadline: chrono::DateTime<chrono::Utc>,
    automatic_turns: u32,
    new_tokens: u64,
    limits: Limits,
    #[serde(default)]
    checkpoint: String,
    #[serde(default)]
    next_action: String,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    missing_reports: u32,
    #[serde(default)]
    last_progress: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_request: Option<ProviderChatRequest>,
}
impl Run {
    fn new(limits: Limits) -> Self {
        let now = chrono::Utc::now();
        Self {
            id: Uuid::new_v4(),
            goal_version: None,
            status: "running".into(),
            started_at: now,
            deadline: now + chrono::Duration::minutes(i64::from(limits.max_minutes)),
            automatic_turns: 0,
            new_tokens: 0,
            limits,
            checkpoint: String::new(),
            next_action: String::new(),
            reason: String::new(),
            missing_reports: 0,
            last_progress: String::new(),
            next_request: None,
        }
    }
    fn exhausted(&self, now: chrono::DateTime<chrono::Utc>) -> Option<&'static str> {
        if now >= self.deadline {
            Some("The goal reached its time limit. Review the checkpoint before resuming.")
        } else if self.automatic_turns >= self.limits.max_automatic_turns {
            Some(
                "The goal reached its automatic turn limit. Review the checkpoint before resuming.",
            )
        } else if self.new_tokens >= self.limits.max_new_tokens {
            Some("The goal reached its new-token limit. Review the checkpoint before resuming.")
        } else {
            None
        }
    }
    fn dispatch_limit(&self, now: chrono::DateTime<chrono::Utc>) -> Option<&'static str> {
        if now >= self.deadline {
            Some("The goal reached its time limit. Review the checkpoint before resuming.")
        } else if self.automatic_turns > self.limits.max_automatic_turns {
            Some(
                "The goal reached its automatic turn limit. Review the checkpoint before resuming.",
            )
        } else if self.new_tokens >= self.limits.max_new_tokens {
            Some("The goal reached its new-token limit. Review the checkpoint before resuming.")
        } else {
            None
        }
    }
    fn stop(&mut self, status: &str, reason: impl Into<String>) {
        self.status = status.into();
        self.reason = clean(&reason.into());
        self.next_request = None;
    }
    /// Decide without a second model call. Missing reports get one chance to
    /// supply a checkpoint; repeated empty or unchanged reports stop the run.
    fn after_response(&mut self, response: &ProviderChatResponse) {
        if let Ok(tokens) = serde_json::from_value::<UsageTokens>(
            response.assistant_event.payload["turnTokens"].clone(),
        ) {
            self.new_tokens = self
                .new_tokens
                .saturating_add(gyro_core::call_ceiling_tokens(
                    Some(tokens.input_tokens),
                    Some(tokens.cached_input_tokens),
                    Some(tokens.output_tokens),
                ));
        }
        let payload = &response.assistant_event.payload;
        if payload.get("questions").is_some() {
            self.stop(
                "blocked",
                "The goal needs your answer before work can continue.",
            );
            return;
        }
        if let Some(error) = response
            .status_event
            .payload
            .get("error")
            .and_then(serde_json::Value::as_str)
            .filter(|s| !s.is_empty())
        {
            self.stop("paused", error);
            return;
        }
        let update = payload.get("goalUpdate").and_then(normalize_update);
        let Some(update) = update else {
            self.missing_reports += 1;
            self.checkpoint = clean(&response.assistant_event.message);
            if self.missing_reports > 1 {
                self.stop("blocked", "The model did not report whether the goal is complete or what actionable work remains.");
            } else {
                self.status = "queued".into();
                self.next_action =
                    "Report the goal checkpoint, then carry out remaining authorized work.".into();
            }
            return;
        };
        let status = update["status"].as_str().unwrap();
        self.checkpoint = update["progress"].as_str().unwrap_or("").into();
        self.next_action = update["nextAction"].as_str().unwrap_or("").into();
        if status != "continue" {
            if self.checkpoint.is_empty() {
                self.checkpoint = clean(&response.assistant_event.message);
            }
            self.stop(
                if status == "complete" {
                    "complete"
                } else {
                    status
                },
                update["reason"].as_str().unwrap_or(""),
            );
            return;
        }
        let fingerprint = format!("{}\n{}", self.checkpoint, self.next_action);
        if self.next_action.is_empty() || self.checkpoint.is_empty() {
            self.stop(
                "blocked",
                "The model reported continuation without progress and an actionable next step.",
            );
        } else if fingerprint == self.last_progress {
            self.stop(
                "blocked",
                "The goal repeated the same checkpoint and next action without progress.",
            );
        } else {
            self.last_progress = fingerprint;
            self.status = "queued".into();
            self.reason.clear();
        }
    }
}

fn clean(value: &str) -> String {
    gyro_core::security::redact_secrets(value.trim())
        .chars()
        .take(1_200)
        .collect()
}
pub(super) fn normalize_update(value: &serde_json::Value) -> Option<serde_json::Value> {
    let raw = value.get("status")?.as_str()?;
    // "done" is the word the model is told to use when the outcome is met.
    // It is the same stop as complete: the composer goal then leaves.
    let status = match raw {
        "done" => "complete",
        "complete" | "continue" | "blocked" | "paused" => raw,
        _ => return None,
    };
    let mut update = serde_json::json!({"status": status});
    for field in ["progress", "nextAction", "reason"] {
        if let Some(text) = value.get(field).and_then(serde_json::Value::as_str) {
            update[field] = clean(text).into();
        }
    }
    Some(update)
}
fn latest_event(events: &[SessionEvent]) -> Option<&SessionEvent> {
    let revision = session_goal::goal_revision(events);
    let goal = session_goal::stored_session_goal(events);
    events.iter().rev().find(|event| {
        if event.kind != SessionEventKind::GoalUpdated {
            return false;
        }
        match event.payload["source"].as_str() {
            Some("goal-runner") => {
                goal.as_ref()
                    .is_some_and(|goal| event.payload["text"].as_str() == Some(goal.text.as_str()))
                    && event.payload["goalVersion"]
                        .as_str()
                        .and_then(|id| Uuid::parse_str(id).ok())
                        == revision
            }
            Some("model") => {
                goal.as_ref()
                    .is_some_and(|goal| event.payload["text"].as_str() == Some(goal.text.as_str()))
                    && event.payload.get("goalVersion").is_none_or(|value| {
                        value.as_str().and_then(|id| Uuid::parse_str(id).ok()) == revision
                    })
            }
            _ => true,
        }
    })
}
fn stored_run(event: &SessionEvent) -> Option<Run> {
    (event.payload["source"] == "goal-runner")
        .then(|| serde_json::from_value(event.payload["run"].clone()).ok())
        .flatten()
}
fn limits(events: &[SessionEvent]) -> Limits {
    latest_event(events)
        .and_then(|e| serde_json::from_value(e.payload["runLimits"].clone()).ok())
        .unwrap_or_default()
}

/// Refuse to overwrite a goal changed or cleared during generation.
fn persist(
    store: &SessionStore,
    session: Uuid,
    goal: &str,
    run: &Run,
) -> Result<Option<SessionEvent>, String> {
    let events = store.read_context_events(session).map_err(to_string)?;
    let Some(current) = session_goal::stored_session_goal(&events) else {
        return Ok(None);
    };
    let revision = session_goal::goal_revision(&events);
    if current.text != goal
        || (current.status == "complete" && run.status != "complete")
        || run
            .goal_version
            .is_some_and(|expected| Some(expected) != revision)
    {
        return Ok(None);
    }
    store
        .append_event(
            session,
            SessionEventKind::GoalUpdated,
            if run.reason.is_empty() {
                format!("Goal {}", run.status)
            } else {
                format!("Goal {}: {}", run.status, run.reason)
            },
            serde_json::json!({"action":"set","text":goal,
            "status":if run.status == "complete" { "complete" } else { "active" },
            "source":"goal-runner","goalVersion":revision,"run":run,"runLimits":run.limits}),
        )
        .map(Some)
        .map_err(to_string)
}
fn owner(app: &tauri::AppHandle, session: &str) -> Option<String> {
    app.state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .and_then(|flags| {
            flags
                .get(session)
                .map(|control| control.approval_nonce.clone())
        })
}
fn publish(
    app: &tauri::AppHandle,
    session: &str,
    event: Option<SessionEvent>,
    response: Option<&ProviderChatResponse>,
) {
    let _ = app.emit(EVENT, serde_json::json!({"sessionId":session,"owner":owner(app, session),"event":event,"response":response}));
}
pub(super) fn finished(app: &tauri::AppHandle, session: &str, owner: &str) {
    let _ = app.emit(
        EVENT,
        serde_json::json!({"sessionId":session,"owner":owner,"finished":true}),
    );
}
fn continuation(request: &ProviderChatRequest, run: &Run) -> ProviderChatRequest {
    let mut next = request.clone();
    next.turn_id = Some(Uuid::new_v4().to_string());
    next.suggest_title = false;
    next.attachments.clear();
    next.workspace_context = None;
    next.workspace_check = None;
    next.plan = None;
    next.message = format!("Continue the active goal from the saved checkpoint. Preserve the user's instructions, scope, permissions, and restrictions from this conversation. Verify actual progress; do not repeat completed work or replay an action whose result is uncertain. If only prohibited work, user input, approval, or external acceptance remains, report blocked or paused and the precise reason.\n\nProgress:\n{}\n\nNext action:\n{}", run.checkpoint, run.next_action);
    next
}

/// A watchdog owns the original control, so a late wake cannot cancel a newer run.
struct Deadline {
    sender: mpsc::Sender<()>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Deadline {
    fn start(control: Arc<ProviderRunControl>, remaining: Duration) -> Self {
        let (sender, receiver) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            if receiver.recv_timeout(remaining) == Err(mpsc::RecvTimeoutError::Timeout) {
                if let Ok(mut reason) = control.stop_reason.lock() {
                    reason.get_or_insert(ProviderStopReason::GoalDeadline);
                }
                control.cancellation.cancel();
            }
        });
        Self {
            sender,
            worker: Some(worker),
        }
    }
}
impl Drop for Deadline {
    fn drop(&mut self) {
        let _ = self.sender.send(());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// Runs only composer Chat goals. Council, planning, automations and delegated
/// children retain their own lifecycles and never inherit this supervisor.
pub(super) fn run(
    app: tauri::AppHandle,
    mut request: ProviderChatRequest,
    expected_run: Option<Uuid>,
) -> Result<ProviderChatResponse, String> {
    let store = open_store()?;
    let session = parse_uuid(&request.session_id)?;
    let events = store.read_context_events(session).map_err(to_string)?;
    let goal = session_goal::stored_or_unsaved_goal(&events, request.goal.clone());
    if let Some(expected) = expected_run {
        if !latest_event(&events)
            .and_then(stored_run)
            .is_some_and(|run| {
                run.id == expected
                    && run.status == "queued"
                    && run
                        .next_request
                        .as_ref()
                        .is_some_and(|next| next.turn_id == request.turn_id)
            })
            || !goal.as_ref().is_some_and(|g| g.status == "active")
        {
            return Err("the saved goal continuation is no longer queued".into());
        }
    }
    if request.mode != ChatMode::Normal
        || (expected_run.is_none() && normal_chat_requests_plan(&request.message))
        || !goal.as_ref().is_some_and(|g| g.status == "active")
    {
        return turn_timing::run_timed_provider_chat(app, request, UsageOrigin::Chat);
    }
    let goal = goal.unwrap();
    // A failed frontend goal save still receives a durable outcome before work.
    if session_goal::stored_session_goal(&events).is_none() {
        store
            .append_event(
                session,
                SessionEventKind::GoalUpdated,
                format!("Goal set: {}", goal.text),
                serde_json::json!({"action":"set","text":goal.text,"status":"active"}),
            )
            .map_err(to_string)?;
    }
    request.goal = Some(goal.clone());
    let previous = latest_event(&events).and_then(stored_run);
    let mut run = previous
        .clone()
        .filter(|run| {
            run.status == "queued"
                && run
                    .next_request
                    .as_ref()
                    .is_some_and(|next| next.turn_id == request.turn_id)
        })
        .unwrap_or_else(|| {
            let mut fresh = Run::new(limits(&events));
            if let Some(previous) = previous.as_ref() {
                fresh.checkpoint = previous.checkpoint.clone();
                fresh.next_action = previous.next_action.clone();
            }
            fresh
        });
    if expected_run.is_none()
        && !run.checkpoint.is_empty()
        && matches!(
            request.message.trim(),
            "Continue" | "Continue the goal from its saved checkpoint."
        )
    {
        let turn_id = request.turn_id.clone();
        request = continuation(&request, &run);
        request.turn_id = turn_id;
    }
    run.goal_version =
        session_goal::goal_revision(&store.read_context_events(session).map_err(to_string)?);
    run.limits.validate()?;
    let lease = ProviderSessionLease::for_run(&store, session).map_err(to_string)?;
    let control = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .map_err(to_string)?
        .get(&request.session_id)
        .cloned()
        .ok_or_else(|| "goal run has no provider owner".to_string())?;
    let remaining = (run.deadline - chrono::Utc::now())
        .to_std()
        .unwrap_or_default();
    let _deadline = Deadline::start(control.clone(), remaining);
    let mut last_response = None;
    loop {
        let current_events = store.read_context_events(session).map_err(to_string)?;
        let current = session_goal::stored_session_goal(&current_events);
        if !current
            .as_ref()
            .is_some_and(|g| g.text == goal.text && g.status == "active")
            || session_goal::goal_revision(&current_events) != run.goal_version
        {
            if let Some(response) = last_response {
                return Ok(response);
            }
            return Err("the goal was changed or cleared before continuation".into());
        }
        if control.cancellation.is_cancelled() {
            run.stop("paused", provider_stop_message(&app, &request.session_id));
        } else if let Some(reason) = run.dispatch_limit(chrono::Utc::now()) {
            run.stop("paused", reason);
        }
        if matches!(run.status.as_str(), "paused" | "blocked") {
            publish(
                &app,
                &request.session_id,
                persist(&store, session, &goal.text, &run)?,
                None,
            );
            return last_response.ok_or_else(|| run.reason.clone());
        }
        run.status = "running".into();
        run.next_request = None;
        let event = persist(&store, session, &goal.text, &run)?;
        if event.is_none() {
            return last_response.ok_or_else(|| "the goal changed before continuation".into());
        }
        publish(&app, &request.session_id, event, None);
        // Hold the kernel session lease over the whole goal, including the gaps
        // between turns. A fresh spend/progress guard applies to each new turn.
        if run.automatic_turns > 0 {
            *control.spend_guard.lock().map_err(to_string)? = None;
            *control.efficiency_progress.lock().map_err(to_string)? = Default::default();
            *control.efficiency_checkpoint.lock().map_err(to_string)? = None;
            *control.timeline.lock().map_err(to_string)? = Default::default();
            control.next_event_sequence.store(0, Ordering::SeqCst);
            let turn = request
                .turn_id
                .as_deref()
                .map(parse_uuid)
                .transpose()?
                .unwrap();
            let user = store
                .append_user_turn_message_with_turn_id(
                    session,
                    "Continue the goal",
                    serde_json::json!({"surface":"goal-runner","goalRunId":run.id}),
                    turn,
                )
                .map_err(to_string)?;
            let _ = app.emit(EVENT, serde_json::json!({"sessionId":request.session_id,"owner":owner(&app, &request.session_id),"userEvent":user}));
        }
        *control.goal_token_budget.lock().map_err(to_string)? =
            Some((run.new_tokens, run.limits.max_new_tokens));
        let result = turn_timing::run_timed_provider_chat_in_lease(
            app.clone(),
            request.clone(),
            UsageOrigin::Chat,
            Some(&lease),
        );
        match result {
            Err(error) => {
                run.stop(
                    if control.cancellation.is_cancelled() {
                        "paused"
                    } else {
                        "blocked"
                    },
                    &error,
                );
                publish(
                    &app,
                    &request.session_id,
                    persist(&store, session, &goal.text, &run)?,
                    None,
                );
                return last_response.map(Ok).unwrap_or(Err(error));
            }
            Ok(response) => {
                if control.cancellation.is_cancelled() {
                    run.stop("paused", provider_stop_message(&app, &request.session_id));
                } else {
                    run.after_response(&response);
                }
                let current = session_goal::stored_session_goal(
                    &store.read_context_events(session).map_err(to_string)?,
                );
                if current
                    .as_ref()
                    .is_some_and(|g| g.text == goal.text && g.status == "complete")
                {
                    run.stop("complete", "");
                }
                if run.status == "queued" {
                    if let Some(reason) = run.exhausted(chrono::Utc::now()) {
                        run.stop("paused", reason);
                    } else {
                        run.automatic_turns += 1;
                        request = continuation(&request, &run);
                        run.next_request = Some(request.clone());
                    }
                }
                let event = persist(&store, session, &goal.text, &run)?;
                publish(&app, &request.session_id, event, Some(&response));
                if run.status != "queued"
                    || !current
                        .as_ref()
                        .is_some_and(|g| g.text == goal.text && g.status == "active")
                {
                    return Ok(response);
                }
                last_response = Some(response);
            }
        }
    }
}

fn recoverable_request(
    store: &SessionStore,
    session: Uuid,
    run: &Run,
) -> Result<Option<ProviderChatRequest>, String> {
    if run.status != "queued"
        || run.limits.validate().is_err()
        || run.dispatch_limit(chrono::Utc::now()).is_some()
    {
        return Ok(None);
    }
    let Some(mut request) = run.next_request.clone().filter(|request| {
        request.session_id == session.to_string() && request.mode == ChatMode::Normal
    }) else {
        return Ok(None);
    };
    let Some(turn) = request
        .turn_id
        .as_deref()
        .and_then(|turn| Uuid::parse_str(turn).ok())
    else {
        return Ok(None);
    };
    if store
        .latest_provider_status_for_turn(session, turn)
        .map_err(to_string)?
        .is_some()
        || provider_turn_has_unfinished_attempt(store, session, turn).map_err(to_string)?
    {
        return Ok(None);
    }
    request.full_access = false;
    request.require_command_approval = true;
    request.require_file_edit_approval = true;
    Ok(Some(request))
}

pub(super) fn pause(store: &SessionStore, session: Uuid) -> Result<SessionEvent, String> {
    let events = store.read_context_events(session).map_err(to_string)?;
    let goal = session_goal::stored_session_goal(&events)
        .filter(|g| g.status == "active")
        .ok_or_else(|| "this chat has no active goal to pause".to_string())?;
    let mut run = latest_event(&events)
        .and_then(stored_run)
        .unwrap_or_else(|| Run::new(limits(&events)));
    run.stop(
        "paused",
        "You paused this goal. Resume when you want work to continue.",
    );
    persist(store, session, &goal.text, &run)?
        .ok_or_else(|| "the goal changed before it could pause".into())
}

/// Restart recovery never dispatches a running/uncertain turn. A queued request
/// is replayable only before its first provider attempt and under its old limits.
pub(super) fn recover(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let scan = tauri::async_runtime::spawn_blocking(move || {
            let store = open_store()?;
            let mut queued = Vec::new();
            for session in store.list_sessions().map_err(to_string)? {
                let events = store.read_context_events(session.id).map_err(to_string)?;
                let Some(event) = latest_event(&events) else { continue; };
                let Some(goal) = session_goal::stored_session_goal(&events).filter(|g| g.status == "active") else { continue; };
                let Some(mut run) = stored_run(event).filter(|r| matches!(r.status.as_str(), "running" | "queued")) else { continue; };
                // A live host still owns this chat. Do not steal or alter it.
                let Some(_lease) = ProviderSessionLease::try_acquire(store.paths(), session.id).map_err(to_string)? else { continue; };
                if let Some(request) = recoverable_request(&store, session.id, &run)? {
                    queued.push((goal.text, request, run.id));
                } else {
                    run.stop("paused", "Gyro restarted with unfinished goal work. Review the saved checkpoint before resuming; uncertain actions were not replayed.");
                    persist(&store, session.id, &goal.text, &run)?;
                }
            }
            Ok::<_, String>(queued)
        }).await;
        let Ok(Ok(queued)) = scan else {
            return;
        };
        for (goal, request, run_id) in queued {
            let session_id = request.session_id.clone();
            if let Err(error) = run_goal_chat(app.clone(), request, Some(run_id)).await {
                if let Ok(store) = open_store() {
                    if let Ok(events) = Uuid::parse_str(&session_id)
                        .map_err(to_string)
                        .and_then(|id| store.read_context_events(id).map_err(to_string))
                    {
                        if let Some(mut run) = latest_event(&events)
                            .and_then(stored_run)
                            .filter(|r| r.status == "queued")
                        {
                            run.stop("paused", error);
                            if let Ok(event) =
                                persist(&store, Uuid::parse_str(&session_id).unwrap(), &goal, &run)
                            {
                                publish(&app, &session_id, event, None);
                            }
                        }
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn response(update: serde_json::Value) -> ProviderChatResponse {
        ProviderChatResponse {
            activity_events: vec![],
            assistant_event: SessionEvent::new(
                Uuid::nil(),
                SessionEventKind::AssistantMessage,
                "Saved progress",
                serde_json::json!({"goalUpdate":update}),
            ),
            status_event: SessionEvent::new(
                Uuid::nil(),
                SessionEventKind::SystemEvent,
                "Done",
                serde_json::json!({}),
            ),
            session: None,
            session_title: None,
            resume_cursor: None,
        }
    }
    #[test]
    fn unfinished_work_continues_then_completes() {
        let mut run = Run::new(Limits::default());
        run.after_response(&response(serde_json::json!({"status":"continue","progress":"Implemented runner","nextAction":"Verify restart recovery"})));
        assert_eq!(run.status, "queued");
        run.after_response(&response(
            serde_json::json!({"status":"complete","progress":"Recovery passed"}),
        ));
        assert_eq!(run.status, "complete");
        assert!(run.next_request.is_none());
    }
    #[test]
    fn done_is_the_same_stop_as_complete() {
        let update =
            normalize_update(&serde_json::json!({"status":"done","progress":"Shipped"})).unwrap();
        assert_eq!(update["status"], "complete");
        let mut run = Run::new(Limits::default());
        run.after_response(&response(
            serde_json::json!({"status":"done","progress":"Shipped"}),
        ));
        assert_eq!(run.status, "complete");
        assert!(run.next_request.is_none());
    }
    #[test]
    fn blockers_and_questions_do_not_schedule_more_work() {
        let mut run = Run::new(Limits::default());
        run.after_response(&response(serde_json::json!({"status":"blocked","reason":"Single-agent restriction prevents live validation"})));
        assert_eq!(run.status, "blocked");
        assert!(run.reason.contains("Single-agent"));
        let mut answer = response(
            serde_json::json!({"status":"continue","progress":"Done","nextAction":"Publish"}),
        );
        answer.assistant_event.payload["questions"] =
            serde_json::json!({"questions":[{"question":"Which target?"}]});
        run.after_response(&answer);
        assert_eq!(run.status, "blocked");
    }
    #[test]
    fn repeated_or_missing_checkpoints_stop() {
        let mut run = Run::new(Limits::default());
        let answer = response(
            serde_json::json!({"status":"continue","progress":"Same work","nextAction":"Same check"}),
        );
        run.after_response(&answer);
        assert_eq!(run.status, "queued");
        run.after_response(&answer);
        assert_eq!(run.status, "blocked");
        let mut run = Run::new(Limits::default());
        run.after_response(&response(serde_json::Value::Null));
        assert_eq!(run.status, "queued");
        run.after_response(&response(serde_json::Value::Null));
        assert_eq!(run.status, "blocked");
    }
    #[test]
    fn cached_input_is_not_charged_against_the_goal_new_token_limit() {
        let mut run = Run::new(Limits::default());
        let mut answer = response(
            serde_json::json!({"status":"continue","progress":"Implemented","nextAction":"Verify"}),
        );
        answer.assistant_event.payload["turnTokens"] = serde_json::to_value(UsageTokens {
            input_tokens: 10_000,
            cached_input_tokens: 9_000,
            output_tokens: 500,
            total_tokens: 10_500,
            ..Default::default()
        })
        .unwrap();
        run.after_response(&answer);
        assert_eq!(run.new_tokens, 1_500);
    }
    #[test]
    fn cut_off_responses_pause_even_with_a_continue_report() {
        let mut run = Run::new(Limits::default());
        let mut answer = response(
            serde_json::json!({"status":"continue","progress":"Wrote","nextAction":"Test"}),
        );
        answer.status_event.payload["error"] = PROVIDER_CUT_OFF_NOTICE.into();
        run.after_response(&answer);
        assert_eq!(run.status, "paused");
    }
    #[test]
    fn all_limits_are_bounded_and_survive_serialization() {
        let mut run = Run::new(Limits::default());
        assert!(run.exhausted(run.deadline).is_some());
        run.automatic_turns = run.limits.max_automatic_turns;
        assert!(run.exhausted(run.started_at).unwrap().contains("turn"));
        run.automatic_turns = 0;
        run.new_tokens = run.limits.max_new_tokens;
        let restored: Run = serde_json::from_value(serde_json::to_value(&run).unwrap()).unwrap();
        assert_eq!(restored.deadline, run.deadline);
        assert_eq!(restored.new_tokens, run.new_tokens);
        assert!(restored
            .exhausted(run.started_at)
            .unwrap()
            .contains("token"));
        assert!(Limits {
            max_automatic_turns: 0,
            ..Limits::default()
        }
        .validate()
        .is_err());
    }
    #[test]
    fn normalized_reports_cannot_change_the_goal_or_authority() {
        let update = normalize_update(&serde_json::json!({"status":"continue","text":"Other goal","fullAccess":true,"nextAction":"x".repeat(2000)})).unwrap();
        assert!(update.get("text").is_none());
        assert!(update.get("fullAccess").is_none());
        assert_eq!(update["nextAction"].as_str().unwrap().chars().count(), 1200);
        assert!(normalize_update(&serde_json::json!({"status":"anything"})).is_none());
    }
    fn request(session: Uuid) -> ProviderChatRequest {
        serde_json::from_value(serde_json::json!({
            "sessionId":session, "turnId":Uuid::new_v4(), "message":"Continue the goal",
            "providerId":"codex", "fullAccess":true,
            "requireCommandApproval":false, "requireFileEditApproval":false
        }))
        .unwrap()
    }
    #[test]
    fn final_allowed_turn_dispatches_but_cannot_enqueue_another() {
        let mut run = Run::new(Limits::default());
        run.automatic_turns = run.limits.max_automatic_turns;
        assert!(run.dispatch_limit(run.started_at).is_none());
        assert!(run.exhausted(run.started_at).is_some());
    }
    #[test]
    fn queue_survives_store_reopen_without_resetting_limits_or_permissions() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let store = SessionStore::open(paths.clone()).unwrap();
        let session = store
            .create_session(temp.path(), gyro_core::SessionOrigin::Desktop, "Goal")
            .unwrap();
        store
            .append_event(
                session.id,
                SessionEventKind::GoalUpdated,
                "Goal set",
                serde_json::json!({"action":"set","text":"Finish the runner","status":"active"}),
            )
            .unwrap();
        let mut run = Run::new(Limits::default());
        run.status = "queued".into();
        run.automatic_turns = 3;
        run.new_tokens = 1_234;
        run.checkpoint = "Implementation verified".into();
        run.next_request = Some(request(session.id));
        persist(&store, session.id, "Finish the runner", &run)
            .unwrap()
            .unwrap();
        drop(store);
        let store = SessionStore::open(paths).unwrap();
        let events = store.read_context_events(session.id).unwrap();
        let restored = latest_event(&events).and_then(stored_run).unwrap();
        assert_eq!(restored.id, run.id);
        assert_eq!(restored.automatic_turns, 3);
        assert_eq!(restored.new_tokens, 1_234);
        assert_eq!(restored.deadline, run.deadline);
        let next = recoverable_request(&store, session.id, &restored)
            .unwrap()
            .unwrap();
        assert_eq!(next.turn_id, run.next_request.as_ref().unwrap().turn_id);
        assert!(!next.full_access);
        assert!(next.require_command_approval && next.require_file_edit_approval);
        let turn = parse_uuid(next.turn_id.as_deref().unwrap()).unwrap();
        store
            .append_event_with_turn_id(
                session.id,
                SessionEventKind::SystemEvent,
                "Dispatched",
                serde_json::json!({"kind":"provider-status","status":"running"}),
                Some(turn),
            )
            .unwrap();
        assert!(recoverable_request(&store, session.id, &restored)
            .unwrap()
            .is_none());
    }
    #[test]
    fn running_expired_and_wrong_session_requests_are_never_replayed() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), gyro_core::SessionOrigin::Desktop, "Goal")
            .unwrap();
        let mut run = Run::new(Limits::default());
        run.next_request = Some(request(session.id));
        assert!(recoverable_request(&store, session.id, &run)
            .unwrap()
            .is_none());
        run.status = "queued".into();
        run.deadline = chrono::Utc::now() - chrono::Duration::seconds(1);
        assert!(recoverable_request(&store, session.id, &run)
            .unwrap()
            .is_none());
        run.deadline = chrono::Utc::now() + chrono::Duration::hours(1);
        run.next_request = Some(request(Uuid::new_v4()));
        assert!(recoverable_request(&store, session.id, &run)
            .unwrap()
            .is_none());
    }
    #[test]
    fn changed_or_cleared_goal_cannot_be_revived_by_old_checkpoint() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), gyro_core::SessionOrigin::Desktop, "Goal")
            .unwrap();
        store
            .append_event(
                session.id,
                SessionEventKind::GoalUpdated,
                "Goal set",
                serde_json::json!({"action":"set","text":"Original","status":"active"}),
            )
            .unwrap();
        let run = Run::new(Limits::default());
        store
            .append_event(
                session.id,
                SessionEventKind::GoalUpdated,
                "Goal changed",
                serde_json::json!({"action":"set","text":"Changed","status":"active"}),
            )
            .unwrap();
        assert!(persist(&store, session.id, "Original", &run)
            .unwrap()
            .is_none());
        store
            .append_event(
                session.id,
                SessionEventKind::GoalUpdated,
                "Goal cleared",
                serde_json::json!({"action":"clear"}),
            )
            .unwrap();
        assert!(persist(&store, session.id, "Original", &run)
            .unwrap()
            .is_none());
    }
    #[test]
    fn continuation_uses_a_new_turn_and_preserves_authority_without_resending_attachments() {
        let mut original = request(Uuid::new_v4());
        original.require_command_approval = true;
        original.require_file_edit_approval = true;
        original.full_access = false;
        original.suggest_title = true;
        let run = Run::new(Limits::default());
        let next = continuation(&original, &run);
        assert_ne!(next.turn_id, original.turn_id);
        assert_eq!(next.provider_id, original.provider_id);
        assert_eq!(next.model_id, original.model_id);
        assert!(next.require_command_approval && next.require_file_edit_approval);
        assert!(!next.full_access && !next.suggest_title);
        assert!(next.attachments.is_empty());
        assert!(next.workspace_context.is_none() && next.workspace_check.is_none());
    }
    #[test]
    fn deadline_stops_only_its_original_owner_and_drop_disarms_it() {
        let old = Arc::new(ProviderRunControl::default());
        let new = Arc::new(ProviderRunControl::default());
        let mut deadline = Deadline::start(old.clone(), Duration::ZERO);
        deadline.worker.take().unwrap().join().unwrap();
        assert!(old.cancellation.is_cancelled());
        assert!(!new.cancellation.is_cancelled());
        let active = Arc::new(ProviderRunControl::default());
        drop(Deadline::start(active.clone(), Duration::from_secs(60)));
        assert!(!active.cancellation.is_cancelled());
    }
}
