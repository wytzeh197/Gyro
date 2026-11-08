use crate::{
    app::config::load_config_blocking,
    capabilities::bridge::active_provider_capability_context,
    context_compaction, delegated_agents, efficiency, goal_runner, live_model_context,
    project_import_continuation,
    provider_accounting::provider_turn_tokens,
    provider_context::provider_context_usage_with_window,
    provider_retry_recovery,
    provider_run_cleanup::ProviderTurnFinalizer,
    provider_session_lifecycle::ProviderSessionLease,
    provider_timeline,
    providers::{
        binding::{
            bind_provider_capability_context, bind_provider_chat_request, validate_chat_context,
        },
        chat_types::{
            normal_chat_requests_plan, ChatMode, ProviderChatRequest, ProviderChatResponse,
            ProviderContextCompactionResponse,
        },
        compaction::compact_local_provider_chat,
        events::{
            append_provider_diagnostics_event, append_provider_status_event,
            emit_provider_activity_event, emit_provider_chat_event, kimi_acp_plan_payload,
            provider_activity_event_entry, provider_chat_status_message,
            provider_turn_has_unfinished_attempt,
        },
        markers::{
            completed_chat_artifacts, completed_plan_updates, derive_session_summary,
            publish_streamed_session_title, strip_hidden_control_markers, suggested_title_for_turn,
            ChatArtifactExtraction, SessionTitleExtraction,
        },
        process::provider_adapter_for,
        retry::run_provider_chat_with_retry,
        runners::{
            codex::run_openai_codex_context_compaction,
            kimi_acp::provider_resume_cursor_from_binding,
        },
        streaming::provider_chat_cancelled,
        types::{ProviderActivity, ProviderAdapterKind},
    },
    reply_segments::persisted_text_segments,
    session_goal, session_title_stream,
    sessions::titles::{is_generic_session_title, session_title_from_message},
    state::{
        managers::ProviderCancellationManager,
        provider_run::{
            PROVIDER_CUT_OFF_NOTICE, PROVIDER_STOP_MARKER, PROVIDER_TOOL_BUDGET_NOTICE,
        },
    },
    stores::{open_store, parse_uuid, to_string},
    text::{chat_message_preview, validate_chat_message},
    usage::guard::UsageContext,
};
use gyro_core::{
    timing, timing::Stage as TimingStage, GyroConfig, GyroPaths, HarnessRunStatus,
    ProviderRunPayload, SessionEvent, SessionEventKind, UsageOrigin, WorkspaceContextSnapshot,
};
use tauri::{Emitter, Manager};
use uuid::Uuid;
/// Run one chat turn to completion.
///
/// `origin` says whether this is an interactive turn or an unattended
/// automation run. The usage ledger keeps them apart so a schedule cannot
/// quietly outspend the person at the keyboard.
pub(crate) fn run_provider_chat_blocking(
    app: tauri::AppHandle,
    request: ProviderChatRequest,
    origin: UsageOrigin,
) -> Result<ProviderChatResponse, String> {
    run_provider_chat_blocking_in_lease(app, request, origin, None)
}

pub(crate) fn run_provider_chat_blocking_in_lease(
    app: tauri::AppHandle,
    mut request: ProviderChatRequest,
    origin: UsageOrigin,
    lease: Option<&ProviderSessionLease>,
) -> Result<ProviderChatResponse, String> {
    let store = open_store()?;
    let session_id = parse_uuid(&request.session_id)?;
    let acquired_lease;
    let _session_lease = match lease {
        Some(lease) => lease,
        None => {
            acquired_lease =
                ProviderSessionLease::for_run(&store, session_id).map_err(to_string)?;
            &acquired_lease
        }
    };
    if let Some(control) = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .and_then(|flags| flags.get(&request.session_id).cloned())
    {
        *control.process_owner.lock().map_err(to_string)? = Some(_session_lease.process_owner());
    }
    let session = store
        .get_session(session_id)
        .map_err(to_string)?
        .ok_or_else(|| "provider chat session no longer exists".to_string())?;
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    let config = GyroConfig::load(&paths).map_err(to_string)?;
    bind_provider_chat_request(&mut request, &session, &config, store.paths())?;
    delegated_agents::restrict_request(&app, &mut request);
    // The stored goal outranks the window's copy, which may predate a clear or
    // a completion made elsewhere; the window's copy covers a failed save.
    let events = store.read_context_events(session_id).map_err(to_string)?;
    request.goal = session_goal::stored_or_unsaved_goal(&events, request.goal.take());
    request.message = validate_chat_message(&request.message)?;
    // Automatic title ownership survives omitted markers, failed first turns,
    // retries, model switches and app restarts. Generic names start naming;
    // durable ownership decides whether it is finished. A retry may have lost
    // the window's first-send flag before initialization ever ran.
    if is_generic_session_title(&session.title) {
        let fallback =
            session_title_from_message(&request.message).unwrap_or_else(|| session.title.clone());
        if let Some(renamed) = store
            .begin_session_title(session_id, &session.title, &fallback, &request.message)
            .map_err(to_string)?
        {
            let _ = app.emit("gyro://session-title-updated", renamed);
        }
    }
    let pending_title = store.pending_session_title(session_id).map_err(to_string)?;
    request.suggest_title = pending_title.is_some();
    let _title_task = session_title_stream::TaskScope::start(
        &request.session_id,
        pending_title.as_ref().map(|(_, task)| task.as_str()),
    );
    let title_before_turn = pending_title
        .as_ref()
        .map(|(title, _)| title.as_str())
        .unwrap_or(&session.title);
    if request.suggest_title {
        if let Some(control) = app
            .state::<ProviderCancellationManager>()
            .flags
            .lock()
            .ok()
            .and_then(|flags| flags.get(&request.session_id).cloned())
        {
            if let Ok(mut state) = control.suggested_title.lock() {
                // Open, not closed: the model may replace the provisional
                // title for this run. `publish_streamed_session_title` renames
                // once and closes the control again.
                *state = suggested_title_for_turn(title_before_turn);
            }
        }
    }
    let automatically_entered_plan = request.mode == ChatMode::Normal
        && lease.is_none()
        && normal_chat_requests_plan(&request.message);
    if automatically_entered_plan {
        // An explicit request for a plan should receive the same read-only
        // capability policy, prompt contract, document, and approval handoff
        // as the composer mode. Do this before binding tool authority.
        request.mode = ChatMode::Plan;
    }
    validate_chat_context(&request)?;
    let turn_id = request.turn_id.as_deref().map(parse_uuid).transpose()?;
    let run_id = turn_id.unwrap_or_else(Uuid::new_v4);
    request.turn_id = Some(run_id.to_string());
    // Checked before any of the work below: this send is about to be refused,
    // and scanning the workspace, binding a capability context, and persisting
    // a snapshot for it are all wasted. Running the check first also means a
    // refused send no longer leaves a bound capability context behind it.
    let turn_status = store
        .latest_provider_status_for_turn(session_id, run_id)
        .map_err(to_string)?;
    if provider_turn_has_unfinished_attempt(&store, session_id, run_id).map_err(to_string)? {
        return Err(
            "this turn has an unfinished provider attempt; start a new turn to avoid replaying tools"
                .into(),
        );
    }
    let mut automatic_plan_events = Vec::new();
    if automatically_entered_plan {
        if request.goal.take().is_some() {
            automatic_plan_events.push(
                store
                    .append_event_with_turn_id(
                        session_id,
                        SessionEventKind::GoalUpdated,
                        "Goal cleared",
                        serde_json::json!({
                            "action": "clear",
                            "source": "automatic-plan-mode",
                        }),
                        Some(run_id),
                    )
                    .map_err(to_string)?,
            );
        }
        automatic_plan_events.push(
            store
                .append_event_with_turn_id(
                    session_id,
                    SessionEventKind::ChatModeChanged,
                    "Plan mode enabled",
                    serde_json::json!({
                        "mode": "plan",
                        "source": "message-intent",
                    }),
                    Some(run_id),
                )
                .map_err(to_string)?,
        );
    }
    let load_persisted_context = turn_status.is_some();
    timing::mark(TimingStage::WorkspaceStart);
    if let Some(control) = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .map_err(to_string)?
        .get(&request.session_id)
        .cloned()
    {
        *control.request.lock().map_err(to_string)? = Some(request.clone());
    }
    let _agent_scope = delegated_agents::ParentRunScope::new(&app, &request.session_id);
    // The session row read at turn start is this turn's authority for the
    // workspace identity; re-reading it here could straddle a roots update.
    let context_already_persisted = bind_provider_capability_context(
        &app,
        &store,
        &request,
        run_id,
        load_persisted_context,
        &session,
    )?;
    timing::mark(TimingStage::WorkspaceReady);
    let bound_context =
        active_provider_capability_context(&app, &request.session_id).map_err(to_string)?;
    let workspace_context = bound_context.workspace_context.clone();
    request.workspace_context = Some(workspace_context.clone());
    request.workspace_check = Some(bound_context.workspace_check.clone());
    let attempt_id = Uuid::new_v4();
    let started_at = chrono::Utc::now();
    let adapter = provider_adapter_for(&request.provider_id);
    let mut turn_finalizer = ProviderTurnFinalizer::new(
        &store,
        &request,
        session_id,
        run_id,
        attempt_id,
        |status, error| {
            emit_provider_chat_event(
                &app,
                &request,
                if status == HarnessRunStatus::Done {
                    "completed"
                } else {
                    "failed"
                },
                Some(status),
                None,
                None,
                error.map(str::to_string),
            );
        },
    );
    // Mark the turn live before durable workspace-context writes so the first
    // visible provider activity is not gated on JSONL fsync.
    emit_provider_chat_event(
        &app,
        &request,
        "started",
        Some(HarnessRunStatus::Running),
        None,
        Some(provider_chat_status_message(
            &HarnessRunStatus::Running,
            request.provider_label.as_deref().unwrap_or("Provider"),
        )),
        None,
    );
    // The binding above already found any snapshot this turn persisted, so a
    // retry never rescans the transcript to decide whether to write it again.
    if !context_already_persisted {
        store
            .append_event_with_turn_id(
                session_id,
                SessionEventKind::SystemEvent,
                "Workspace context attached",
                serde_json::json!({
                    "kind": "workspace-context",
                    "schema": WorkspaceContextSnapshot::SCHEMA,
                    "snapshot": workspace_context,
                    "check": bound_context.workspace_check,
                }),
                Some(run_id),
            )
            .map_err(to_string)?;
    }
    let _ = append_provider_status_event(
        &store,
        session_id,
        &request,
        Some(run_id),
        attempt_id,
        HarnessRunStatus::Running,
        None,
    );

    let binding = store
        .get_provider_session_binding(session_id, &request.provider_id)
        .map_err(to_string)?
        .and_then(|binding| {
            project_import_continuation::compatible_binding(&store, binding, &request)
        });
    let runner_request = provider_retry_recovery::manual_retry_request(
        &request,
        turn_status.as_deref(),
        binding.as_ref(),
    );
    let runner_output = match run_provider_chat_with_retry(
        &store,
        &app,
        &runner_request,
        binding,
        UsageContext::new(origin),
    ) {
        Ok(response) => response,
        Err(error) => {
            let error = gyro_core::security::redact_secrets(&error.to_string());
            let status = if error.contains(PROVIDER_STOP_MARKER) {
                HarnessRunStatus::Cancelled
            } else if adapter.kind == ProviderAdapterKind::ReadinessOnly {
                HarnessRunStatus::Blocked
            } else {
                HarnessRunStatus::Failed
            };
            let _ = append_provider_status_event(
                &store,
                session_id,
                &request,
                Some(run_id),
                attempt_id,
                status.clone(),
                Some(error.as_str()),
            );
            let _ = append_provider_diagnostics_event(
                &store,
                session_id,
                &request,
                Some(run_id),
                attempt_id,
                status.clone(),
                started_at,
                0,
                false,
                Some(error.as_str()),
                None,
            );
            emit_provider_chat_event(
                &app,
                &request,
                if status == HarnessRunStatus::Cancelled {
                    "cancelled"
                } else {
                    "failed"
                },
                Some(status),
                None,
                None,
                Some(error.clone()),
            );
            return Err(error);
        }
    };
    publish_streamed_session_title(&app, &request, &runner_output.response, true);
    // Some models omit the naming instruction entirely. Repair the title with
    // the selected model under deny-all authority, without replaying the task.
    // Failure leaves durable pending state for a later send instead of failing
    // a successful user response.
    session_title_stream::repair_missing(&store, &app, &request);
    // One pass removes every GYRO_* control marker (including ones glued
    // mid-line after multi-block streams) and returns title, plan, and
    // artifacts together. Chaining the per-marker helpers would drop later
    // markers because each helper strips all of them.
    let control_markers = strip_hidden_control_markers(&runner_output.response);
    let title_extraction = SessionTitleExtraction {
        title: if request.suggest_title {
            control_markers.session_title
        } else {
            None
        },
        #[cfg(test)]
        message: control_markers.message.clone(),
    };
    let mut plan_payloads =
        completed_plan_updates(&runner_output.activities, control_markers.plan_updates);
    let questions = control_markers.questions;
    let artifact_extraction = ChatArtifactExtraction {
        // Intermediate previews remain attached to the final reply; emitting
        // one no longer closes the turn or discards it when the answer arrives.
        items: completed_chat_artifacts(&runner_output.activities, control_markers.artifacts),
        message: control_markers.message,
    };
    let resume_cursor_value = runner_output
        .resume_cursor
        .as_ref()
        .map(serde_json::to_value)
        .transpose()
        .map_err(to_string)?;
    let mut assistant_payload = gyro_core::harness_payload_value(&ProviderRunPayload::new(
        run_id,
        attempt_id,
        "desktop",
        HarnessRunStatus::Done,
        request.provider_id.clone(),
        request.provider_label.clone(),
        request.model_id.clone(),
        request.model_label.clone(),
        Some(chat_message_preview(&request.message)),
        Some(adapter.runner.into()),
        Some(adapter.auth_owner.into()),
        runner_output.resumed,
        runner_output.retry_count,
        Some(adapter.timeout_seconds),
    ))
    .unwrap_or_else(|error| {
        serde_json::json!({
            "schema": gyro_core::HARNESS_SCHEMA_V1,
            "kind": "provider-response",
            "runId": run_id,
            "attemptId": attempt_id,
            "status": "done",
            "metadataError": gyro_core::sanitize_harness_text(&error.to_string()),
        })
    });
    if let Some(object) = assistant_payload.as_object_mut() {
        object.insert(
            "reasoningEffort".into(),
            request
                .reasoning_effort
                .clone()
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null),
        );
        object.insert(
            "kind".into(),
            serde_json::Value::String("provider-response".into()),
        );
        object.insert(
            "runKind".into(),
            serde_json::Value::String("provider-run".into()),
        );
        object.insert(
            "resumeCursor".into(),
            runner_output
                .resume_cursor
                .as_ref()
                .map(serde_json::to_value)
                .transpose()
                .map_err(to_string)?
                .unwrap_or(serde_json::Value::Null),
        );
        object.insert(
            "sessionTitle".into(),
            title_extraction
                .title
                .as_ref()
                .map(|title| serde_json::Value::String(title.clone()))
                .unwrap_or(serde_json::Value::Null),
        );
        object.insert(
            "timelineSequence".into(),
            serde_json::Value::from(runner_output.activities.len() as u64),
        );
        if let Some(segments) = runner_output.streamed_text.as_ref().and_then(|streamed| {
            persisted_text_segments(
                &artifact_extraction.message,
                streamed,
                &runner_output.activities,
            )
        }) {
            object.insert("segments".into(), segments);
        }
        if !artifact_extraction.items.is_empty() {
            object.insert(
                "artifacts".into(),
                serde_json::Value::Array(artifact_extraction.items.clone()),
            );
        }
        if let Some(questions) = questions {
            object.insert("questions".into(), questions);
        }
        if let Some(tasks) = control_markers.tasks.clone() {
            object.insert("tasks".into(), tasks);
        }
        if let Some(update) = control_markers.agent_update.as_ref() {
            object.insert("agentUpdate".into(), update.clone());
        }
        if let Some(update) = control_markers
            .goal_update
            .as_ref()
            .and_then(goal_runner::normalize_update)
        {
            object.insert("goalUpdate".into(), update);
        }
        object.insert(
            "turnTokens".into(),
            serde_json::to_value(provider_turn_tokens(&request, Some(&runner_output)))
                .map_err(to_string)?,
        );
        if let Some(raw) = runner_output.context_usage.as_ref() {
            let base_url = load_config_blocking().ok().and_then(|config| {
                config
                    .model_providers
                    .into_iter()
                    .find(|provider| provider.id == request.provider_id)
                    .and_then(|provider| provider.base_url)
            });
            live_model_context::observe_runtime(
                &request.provider_id,
                request.model_id.as_deref(),
                base_url.as_deref(),
                raw.model_context_window,
            );
        }
        if let Some(context_usage) = provider_context_usage_with_window(
            runner_output.context_usage.clone(),
            &request.provider_id,
            request.model_id.as_deref(),
        ) {
            object.insert(
                "contextUsage".into(),
                serde_json::to_value(&context_usage).map_err(to_string)?,
            );
            object.insert(
                "contextWindowSource".into(),
                serde_json::json!(if runner_output
                    .context_usage
                    .as_ref()
                    .and_then(|usage| usage.model_context_window)
                    .is_some()
                {
                    "runtime"
                } else {
                    "catalog"
                }),
            );
        }
        if !runner_output.rate_limits.is_empty() {
            object.insert(
                "rateLimits".into(),
                serde_json::to_value(&runner_output.rate_limits).map_err(to_string)?,
            );
        }
    }
    // Reserve unstreamed activity before closing the response. Streamed items
    // reuse their original positions, including text that preceded broker calls.
    for activity in &runner_output.activities {
        provider_timeline::activity(&app, &request.session_id, activity);
    }
    provider_timeline::observe(&app, &request.session_id, Some("response"), None)
        .insert_into(&mut assistant_payload);
    if let Some(segments) = provider_timeline::response_segments(
        &app,
        &request.session_id,
        &artifact_extraction.message,
    ) {
        assistant_payload["segments"] = segments;
    }
    let assistant_event = store
        .append_event_with_turn_id(
            session_id,
            SessionEventKind::AssistantMessage,
            artifact_extraction.message,
            assistant_payload,
            Some(run_id),
        )
        .map_err(to_string)?;
    turn_finalizer.response_saved();
    if let Err(error) = efficiency::save_checkpoint(&app, &store, &request) {
        eprintln!(
            "Checkpoint save failed: {}",
            gyro_core::sanitize_capability_summary(&error.to_string())
        );
    }
    // Persist the response before advancing the provider cursor. The response is
    // the durable source of truth even if cursor metadata cannot be updated.
    if let Some(resume_cursor_value) = resume_cursor_value {
        if let Err(error) = store.upsert_provider_session_binding(
            session_id,
            request.provider_id.clone(),
            request.model_id.clone(),
            request.model_label.clone(),
            request.reasoning_effort.clone(),
            resume_cursor_value,
            "ready",
            None,
        ) {
            eprintln!(
                "provider response was saved but its resume cursor was not: {}",
                gyro_core::security::redact_secrets(&error.to_string())
            );
        }
    }

    // Timeline enrichment is intentionally best-effort after the assistant
    // response is durable. A title, activity, or diagnostics failure must not
    // turn a completed provider request into a duplicate retry.
    if plan_payloads.is_empty() && request.mode == ChatMode::Plan {
        // ACP execution checklists only become Plan documents in Plan mode.
        // Keep the document even if the provider omits its hidden checklist.
        let payload = runner_output
            .activities
            .iter()
            .rev()
            .find_map(kimi_acp_plan_payload)
            .unwrap_or_else(|| {
                serde_json::json!({
                    "action": "replace",
                    "title": "Plan",
                    "items": [],
                    "source": if automatically_entered_plan {
                        "message-intent-fallback"
                    } else {
                        "plan-mode-fallback"
                    },
                })
            });
        plan_payloads.push(payload);
    }
    let plan_events: Vec<_> = plan_payloads
        .into_iter()
        .filter_map(|mut payload| {
            // The document belongs to the plan event. The assistant message is
            // only the fallback for providers that emit a checklist without
            // one, and a blank copy must not shadow the real text.
            let has_document = ["content", "markdown"].iter().any(|key| {
                payload
                    .get(*key)
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|content| !content.trim().is_empty())
            });
            if request.mode == ChatMode::Plan
                && !has_document
                && !assistant_event.message.trim().is_empty()
            {
                let mut with_content = payload.clone();
                if let Some(object) = with_content.as_object_mut() {
                    object.insert(
                        "content".into(),
                        serde_json::Value::String(assistant_event.message.clone()),
                    );
                    // Keep within the event limit; the context index can use
                    // the preceding assistant message as a content fallback.
                    if serde_json::to_vec(&with_content)
                        .is_ok_and(|encoded| encoded.len() <= 96 * 1024)
                    {
                        payload = with_content;
                    }
                }
            }
            store
                .append_event_with_turn_id(
                    session_id,
                    SessionEventKind::PlanUpdated,
                    "Provider updated the plan",
                    payload,
                    Some(run_id),
                )
                .ok()
        })
        .collect();

    // The model may report that it met the goal, never that the goal changed:
    // the text stays the user's, only the status moves.
    let goal_event = control_markers
        .goal_update
        .as_ref()
        .filter(|update| {
            update.get("status").and_then(serde_json::Value::as_str) == Some("complete")
        })
        .and(request.goal.as_ref())
        .filter(|goal| {
            goal.status == "active"
                && !goal.text.trim().is_empty()
                && !provider_chat_cancelled(&app, &request.session_id)
                && session_goal::stored_session_goal(
                    &store.read_context_events(session_id).unwrap_or_default(),
                )
                .is_some_and(|current| current.status == "active" && current.text == goal.text)
        })
        .and_then(|goal| {
            let text = goal.text.trim();
            store
                .append_event_with_turn_id(
                    session_id,
                    SessionEventKind::GoalUpdated,
                    format!("Goal completed: {text}"),
                    serde_json::json!({
                        "action": "set",
                        "text": text,
                        "status": "complete",
                        "source": "model",
                        "goalVersion": session_goal::goal_revision(&events),
                    }),
                    Some(run_id),
                )
                .ok()
        });
    publish_streamed_session_title(&app, &request, &runner_output.response, true);
    let renamed_session = store.get_session(session_id).ok().flatten();
    let session_summary = derive_session_summary(&assistant_event.message);
    let session = session_summary
        .as_deref()
        .and_then(|summary| {
            store
                .update_session_summary(session_id, summary)
                .ok()
                .flatten()
        })
        .or(renamed_session);
    let activity_entries = runner_output
        .activities
        .iter()
        .enumerate()
        .map(|(sequence, activity)| {
            let mut entry =
                provider_activity_event_entry(&request, run_id, sequence as u64, activity);
            let (position, segments) =
                provider_timeline::activity(&app, &request.session_id, activity);
            position.insert_into(&mut entry.1);
            if let Some(segments) = segments {
                entry.1["timelineSegments"] = segments;
            }
            entry
        })
        .collect();
    let mut activity_events =
        match store.append_system_events_with_turn_id(session_id, activity_entries) {
            Ok(events) => events,
            Err(error) => {
                eprintln!(
                    "provider response was saved without its activity batch: {}",
                    gyro_core::security::redact_secrets(&error.to_string())
                );
                Vec::new()
            }
        };
    if !automatic_plan_events.is_empty() {
        automatic_plan_events.append(&mut activity_events);
        activity_events = automatic_plan_events;
    }
    activity_events.extend(plan_events);
    if let Some(goal_event) = goal_event {
        activity_events.push(goal_event);
    }
    let status_event = append_provider_status_event(
        &store,
        session_id,
        &request,
        Some(run_id),
        attempt_id,
        HarnessRunStatus::Done,
        if runner_output.paused_at_tool_budget {
            Some(PROVIDER_TOOL_BUDGET_NOTICE)
        } else if runner_output.answer_cut_off {
            Some(PROVIDER_CUT_OFF_NOTICE)
        } else {
            None
        },
    )
    .unwrap_or_else(|error| {
        eprintln!(
            "provider response was saved without its completion status: {}",
            gyro_core::security::redact_secrets(&error.to_string())
        );
        let mut event = SessionEvent::new(
            session_id,
            SessionEventKind::SystemEvent,
            provider_chat_status_message(
                &HarnessRunStatus::Done,
                request.provider_label.as_deref().unwrap_or("Provider"),
            ),
            serde_json::json!({
                "schema": gyro_core::HARNESS_SCHEMA_V1,
                "kind": "provider-status",
                "status": "done",
                "runId": run_id,
                "attemptId": attempt_id,
                "persistence": "response-only",
            }),
        );
        event.turn_id = Some(run_id);
        event
    });
    let _ = append_provider_diagnostics_event(
        &store,
        session_id,
        &request,
        Some(run_id),
        attempt_id,
        HarnessRunStatus::Done,
        started_at,
        runner_output.retry_count,
        runner_output.resumed,
        None,
        runner_output.output_summary.as_deref(),
    );
    emit_provider_chat_event(
        &app,
        &request,
        "completed",
        Some(HarnessRunStatus::Done),
        None,
        Some(provider_chat_status_message(
            &HarnessRunStatus::Done,
            request.provider_label.as_deref().unwrap_or("Provider"),
        )),
        None,
    );

    turn_finalizer.settled();
    Ok(ProviderChatResponse {
        activity_events,
        assistant_event,
        session_title: title_extraction.title,
        session,
        status_event,
        resume_cursor: runner_output.resume_cursor,
    })
}

pub(crate) fn compact_provider_chat_blocking(
    app: tauri::AppHandle,
    session_id: String,
    run_id: Uuid,
) -> Result<ProviderContextCompactionResponse, String> {
    let store = open_store()?;
    let session_uuid = parse_uuid(&session_id)?;
    let session = store
        .get_session(session_uuid)
        .map_err(to_string)?
        .ok_or_else(|| "provider chat session no longer exists".to_string())?;
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    let config = GyroConfig::load(&paths).map_err(to_string)?;
    let mut request = ProviderChatRequest {
        session_id: session_id.clone(),
        message: "/compact".into(),
        turn_id: Some(run_id.to_string()),
        provider_id: session
            .provider_id
            .clone()
            .ok_or_else(|| "select a provider before compacting this chat".to_string())?,
        provider_label: None,
        model_id: session.model_id.clone(),
        model_label: session.model_label.clone(),
        reasoning_effort: session.reasoning_effort.clone(),
        require_command_approval: true,
        require_file_edit_approval: true,
        full_access: false,
        suggest_title: false,
        workspace_path: None,
        mode: ChatMode::Normal,
        goal: None,
        plan: None,
        attachments: Vec::new(),
        workspace_context: None,
        workspace_check: None,
        side_chat_context: None,
        internal_purpose: None,
    };
    bind_provider_chat_request(&mut request, &session, &config, store.paths())?;
    if request.provider_id != "openai" {
        return compact_local_provider_chat(&app, &store, &request, session_uuid, run_id);
    }
    let resume_cursor = store
        .get_provider_session_binding(session_uuid, &request.provider_id)
        .map_err(to_string)?
        .and_then(|binding| {
            project_import_continuation::compatible_binding(&store, binding, &request)
        })
        .as_ref()
        .and_then(provider_resume_cursor_from_binding)
        .filter(|cursor| cursor.kind == "codex-session");
    let Some(resume_cursor) = resume_cursor else {
        return compact_local_provider_chat(&app, &store, &request, session_uuid, run_id);
    };
    let activity_params = serde_json::json!({ "turnId": run_id.to_string() });
    let running =
        context_compaction::codex_context_compaction_activity(&activity_params, "running");
    emit_provider_activity_event(&app, &request, &running, Some(0));

    let (completed, context_usage) =
        match run_openai_codex_context_compaction(&app, &request, &resume_cursor) {
            Ok(usage) => (
                context_compaction::codex_context_compaction_activity(&activity_params, "done"),
                provider_context_usage_with_window(
                    usage,
                    &request.provider_id,
                    request.model_id.as_deref(),
                ),
            ),
            Err(error) => {
                let error = gyro_core::security::redact_secrets(&error.to_string());
                let failed = ProviderActivity {
                    id: running.id,
                    kind: "context".into(),
                    label: "Context compaction failed".into(),
                    detail: Some(error.clone()),
                    file_counts: None,
                    note: None,
                    status: "failed".into(),
                };
                emit_provider_activity_event(&app, &request, &failed, Some(0));
                let _ = store.append_system_events_with_turn_id(
                    session_uuid,
                    vec![provider_activity_event_entry(&request, run_id, 0, &failed)],
                );
                return Err(error);
            }
        };
    emit_provider_activity_event(&app, &request, &completed, Some(0));
    let mut entry = provider_activity_event_entry(&request, run_id, 0, &completed);
    if let Some(payload) = entry.1.as_object_mut() {
        // Codex compacts inside its own resumed session, so this one really is
        // a model summary of the earlier conversation.
        payload.insert(
            "compactionMode".into(),
            serde_json::Value::String("summarized".into()),
        );
    }
    // The compacted thread's own measurement supersedes every earlier reading.
    if let (Some(usage), Some(payload)) = (context_usage, entry.1.as_object_mut()) {
        payload.insert(
            "contextUsage".into(),
            serde_json::to_value(&usage).map_err(to_string)?,
        );
    }
    let activity_events = store
        .append_system_events_with_turn_id(session_uuid, vec![entry])
        .map_err(to_string)?;
    Ok(ProviderContextCompactionResponse { activity_events })
}
