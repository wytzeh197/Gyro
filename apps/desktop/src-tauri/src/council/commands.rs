use crate::{
    app::limits::MAX_CONCURRENT_PROVIDER_RUNS,
    emit_provider_chat_event, open_store, parse_uuid, provider_chat_cancelled,
    provider_stop_message,
    providers::chat_types::{ChatAttachmentRequest, ChatMode, ProviderChatRequest},
    run_provider_chat_with_retry,
    state::{
        managers::ProviderCancellationManager,
        provider_run::{ProviderRunControl, PROVIDER_STOP_MARKER},
    },
    to_string, validate_chat_message, UsageContext,
};
use gyro_core::{
    barrier_decision, build_synthesizer_user_prompt, council_run_dir, final_run_status,
    parse_council_synthesis, seat_label_map, successful_seat_answers, write_council_run_manifest,
    write_council_snapshot, write_seat_artifact, write_synthesis_artifact, CouncilAttachmentRef,
    CouncilBarrierDecision, CouncilContextSnapshot, CouncilRun, CouncilRunStatus, CouncilSeat,
    CouncilSeatStatus, CouncilToolPolicy, GyroConfig, GyroPaths, HarnessRunStatus, Session,
    SessionEvent, SessionEventKind, UsageOrigin, COUNCIL_MAX_SEATS, COUNCIL_MIN_SEATS,
    SYNTHESIZER_SYSTEM_PROMPT,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, sync::Arc, time::Instant};
use tauri::Manager;
use uuid::Uuid;
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CouncilSeatRequest {
    pub(crate) provider_id: String,
    pub(crate) provider_label: Option<String>,
    pub(crate) model_id: Option<String>,
    pub(crate) model_label: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CouncilChatRequest {
    pub(crate) session_id: String,
    pub(crate) message: String,
    pub(crate) turn_id: Option<String>,
    #[serde(default)]
    pub(crate) preset_id: Option<String>,
    pub(crate) seats: Vec<CouncilSeatRequest>,
    pub(crate) synthesizer_provider_id: String,
    pub(crate) synthesizer_provider_label: Option<String>,
    pub(crate) synthesizer_model_id: Option<String>,
    pub(crate) synthesizer_model_label: Option<String>,
    pub(crate) workspace_path: Option<String>,
    #[serde(default)]
    pub(crate) attachments: Vec<ChatAttachmentRequest>,
    #[serde(default)]
    #[allow(dead_code)]
    pub(crate) require_command_approval: bool,
    #[serde(default)]
    #[allow(dead_code)]
    pub(crate) require_file_edit_approval: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CouncilChatResponse {
    pub(crate) council_run: CouncilRun,
    pub(crate) assistant_event: SessionEvent,
    pub(crate) status_event: SessionEvent,
    pub(crate) session: Option<Session>,
}

#[tauri::command]
pub(crate) async fn run_council_chat(
    app: tauri::AppHandle,
    mut request: CouncilChatRequest,
) -> Result<CouncilChatResponse, String> {
    request.message = validate_chat_message(&request.message)?;
    let seat_count = request.seats.len();
    if !(COUNCIL_MIN_SEATS..=COUNCIL_MAX_SEATS).contains(&seat_count) {
        return Err(format!(
            "council requires between {COUNCIL_MIN_SEATS} and {COUNCIL_MAX_SEATS} seats (got {seat_count})"
        ));
    }
    let session_id = request.session_id.clone();
    {
        let manager = app.state::<ProviderCancellationManager>();
        let mut flags = manager
            .flags
            .lock()
            .map_err(|_| "provider cancellation state is unavailable".to_string())?;
        if flags.contains_key(&session_id) {
            return Err("a provider turn is already running for this session".into());
        }
        if flags.len() >= MAX_CONCURRENT_PROVIDER_RUNS {
            return Err(format!(
                "Gyro can run at most {MAX_CONCURRENT_PROVIDER_RUNS} provider turns at once"
            ));
        }
        flags.insert(session_id.clone(), Arc::new(ProviderRunControl::default()));
    }
    let worker_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_council_chat_blocking(worker_app, request)
    })
    .await
    .map_err(|error| format!("council chat worker failed: {error}"));
    app.state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .map(|mut flags| flags.remove(&session_id));
    result?
}

pub(crate) fn run_council_chat_blocking(
    app: tauri::AppHandle,
    request: CouncilChatRequest,
) -> Result<CouncilChatResponse, String> {
    let store = open_store()?;
    let session_uuid = parse_uuid(&request.session_id)?;
    let session = store
        .get_session(session_uuid)
        .map_err(to_string)?
        .ok_or_else(|| "council chat session no longer exists".to_string())?;
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    let config = GyroConfig::load(&paths).map_err(to_string)?;
    if !config.council.enabled {
        return Err("Model Council is disabled in settings".into());
    }

    let parent_turn_id = request
        .turn_id
        .as_deref()
        .map(parse_uuid)
        .transpose()?
        .unwrap_or_else(Uuid::new_v4);
    let started_at = chrono::Utc::now();

    let snapshot = CouncilContextSnapshot {
        id: Uuid::new_v4(),
        prompt: request.message.clone(),
        project_key: Some(session.workspace_path.display().to_string()),
        workspace_path: request
            .workspace_path
            .clone()
            .or_else(|| Some(session.workspace_path.display().to_string())),
        attachments: request
            .attachments
            .iter()
            .map(|attachment| CouncilAttachmentRef {
                id: attachment.id.clone(),
                name: Some(attachment.name.clone()),
                path: Some(attachment.path.clone()),
                kind: Some(attachment.kind.clone()),
            })
            .collect(),
        git_summary: None,
        created_at: started_at,
    };

    let mut seats: Vec<CouncilSeat> = request
        .seats
        .iter()
        .map(|seat| {
            let provider_label = seat
                .provider_label
                .clone()
                .unwrap_or_else(|| seat.provider_id.clone());
            CouncilSeat {
                id: Uuid::new_v4(),
                council_run_id: Uuid::nil(),
                run_id: Uuid::new_v4(),
                provider_id: seat.provider_id.clone(),
                provider_label,
                model_id: seat.model_id.clone(),
                model_label: seat.model_label.clone(),
                status: CouncilSeatStatus::Queued,
                started_at: None,
                completed_at: None,
                duration_ms: None,
                raw_output: None,
                artifact_path: None,
                error: None,
            }
        })
        .collect();

    let mut council_run = CouncilRun::new(
        session_uuid,
        snapshot.clone(),
        seats.clone(),
        request.preset_id.clone(),
        CouncilToolPolicy::None,
        Some(request.synthesizer_provider_id.clone()),
        request.synthesizer_model_id.clone(),
    )
    .map_err(to_string)?;
    seats = council_run.seats.clone();

    let run_dir = council_run_dir(&paths.sessions_dir, session_uuid, council_run.id);
    write_council_snapshot(&run_dir, &snapshot).map_err(to_string)?;
    write_council_run_manifest(&run_dir, &council_run).map_err(to_string)?;

    store
        .append_event_with_turn_id(
            session_uuid,
            SessionEventKind::CouncilRunStarted,
            format!(
                "Council started with {} seats",
                council_run.seats.len()
            ),
            serde_json::json!({
                "councilRunId": council_run.id,
                "presetId": council_run.preset_id,
                "seatProviderIds": council_run.seats.iter().map(|s| &s.provider_id).collect::<Vec<_>>(),
                "snapshotId": snapshot.id,
                "synthesizerProviderId": request.synthesizer_provider_id,
            }),
            Some(parent_turn_id),
        )
        .map_err(to_string)?;

    council_run.status = CouncilRunStatus::Running;
    council_run.updated_at = chrono::Utc::now();

    // Fan-out seats in parallel. Each seat opens its own store connection.
    let seat_jobs: Vec<(CouncilSeat, ProviderChatRequest)> = seats
        .iter()
        .map(|seat| {
            let seat_request = ProviderChatRequest {
                session_id: request.session_id.clone(),
                message: request.message.clone(),
                turn_id: Some(seat.run_id.to_string()),
                provider_id: seat.provider_id.clone(),
                provider_label: Some(seat.provider_label.clone()),
                model_id: seat.model_id.clone(),
                model_label: seat.model_label.clone(),
                reasoning_effort: None,
                require_command_approval: true,
                require_file_edit_approval: true,
                full_access: false,
                suggest_title: false,
                workspace_path: request
                    .workspace_path
                    .clone()
                    .or_else(|| Some(session.workspace_path.display().to_string())),
                mode: ChatMode::Council,
                goal: None,
                plan: None,
                attachments: request.attachments.clone(),
                workspace_context: None,
                workspace_check: None,
                side_chat_context: None,
                internal_purpose: None,
            };
            (seat.clone(), seat_request)
        })
        .collect();

    for (seat, _) in &seat_jobs {
        store
            .link_usage_turn(session_uuid, seat.run_id, session_uuid, parent_turn_id)
            .map_err(to_string)?;
    }
    let seat_results: Vec<(Uuid, Result<String, String>, u128)> = std::thread::scope(|scope| {
        let mut handles = Vec::new();
        for (seat, seat_request) in seat_jobs {
            let app = app.clone();
            let session_id_str = request.session_id.clone();
            let council_run_id = council_run.id;
            handles.push(scope.spawn(move || {
                let seat_id = seat.id;
                let seat_started = Instant::now();
                if let Ok(store) = open_store() {
                    let _ = store.append_event_with_turn_id(
                        session_uuid,
                        SessionEventKind::CouncilSeatStarted,
                        format!("Council seat started: {}", seat.provider_label),
                        serde_json::json!({
                            "councilRunId": council_run_id,
                            "seatId": seat.id,
                            "runId": seat.run_id,
                            "providerId": seat.provider_id,
                            "modelId": seat.model_id,
                        }),
                        Some(parent_turn_id),
                    );
                }
                emit_provider_chat_event(
                    &app,
                    &seat_request,
                    "started",
                    Some(HarnessRunStatus::Running),
                    None,
                    Some(format!("Council seat running: {}", seat.provider_label)),
                    None,
                );
                if provider_chat_cancelled(&app, &session_id_str) {
                    return (
                        seat_id,
                        Err(provider_stop_message(&app, &session_id_str)),
                        seat_started.elapsed().as_millis(),
                    );
                }
                let store = match open_store() {
                    Ok(store) => store,
                    Err(error) => {
                        return (seat_id, Err(error), seat_started.elapsed().as_millis());
                    }
                };
                let result = run_provider_chat_with_retry(
                    &store,
                    &app,
                    &seat_request,
                    None,
                    UsageContext::seat(seat_id),
                )
                .map(|output| {
                    let text = output.response.trim().to_string();
                    if text.is_empty() {
                        Err("council seat returned an empty response".to_string())
                    } else {
                        Ok(text)
                    }
                })
                .unwrap_or_else(|error| {
                    Err(gyro_core::security::redact_secrets(&error.to_string()))
                });
                (seat_id, result, seat_started.elapsed().as_millis())
            }));
        }
        handles
            .into_iter()
            .map(|handle| {
                handle.join().unwrap_or_else(|_| {
                    (Uuid::nil(), Err("council seat worker panicked".into()), 0)
                })
            })
            .collect()
    });

    let cancelled = provider_chat_cancelled(&app, &request.session_id);
    let mut result_by_id: HashMap<Uuid, (Result<String, String>, u128)> = HashMap::new();
    for (seat_id, result, duration_ms) in seat_results {
        result_by_id.insert(seat_id, (result, duration_ms));
    }

    for seat in &mut council_run.seats {
        let completed_at = chrono::Utc::now();
        seat.started_at = Some(started_at);
        seat.completed_at = Some(completed_at);
        let (result, duration_ms) = result_by_id
            .remove(&seat.id)
            .unwrap_or_else(|| (Err("council seat did not report a result".into()), 0));
        seat.duration_ms = Some(duration_ms);
        match result {
            Ok(text) => {
                let path = write_seat_artifact(&run_dir, seat.id, &text).map_err(to_string)?;
                seat.raw_output = Some(text);
                seat.artifact_path = Some(path.display().to_string());
                seat.status = CouncilSeatStatus::Done;
                seat.error = None;
                let summary: String = seat
                    .raw_output
                    .as_deref()
                    .unwrap_or("")
                    .chars()
                    .take(280)
                    .collect();
                let _ = store.append_event_with_turn_id(
                    session_uuid,
                    SessionEventKind::CouncilSeatCompleted,
                    format!("Council seat completed: {}", seat.provider_label),
                    serde_json::json!({
                        "councilRunId": council_run.id,
                        "seatId": seat.id,
                        "status": "done",
                        "durationMs": duration_ms,
                        "outputSummary": summary,
                        "artifactPath": seat.artifact_path,
                    }),
                    Some(parent_turn_id),
                );
            }
            Err(error) => {
                let status = if error.contains(PROVIDER_STOP_MARKER) {
                    CouncilSeatStatus::Cancelled
                } else {
                    CouncilSeatStatus::Failed
                };
                seat.status = status;
                seat.error = Some(error.clone());
                let _ = store.append_event_with_turn_id(
                    session_uuid,
                    SessionEventKind::CouncilSeatFailed,
                    format!("Council seat failed: {}", seat.provider_label),
                    serde_json::json!({
                        "councilRunId": council_run.id,
                        "seatId": seat.id,
                        "error": error,
                    }),
                    Some(parent_turn_id),
                );
            }
        }
    }

    write_council_run_manifest(&run_dir, &council_run).map_err(to_string)?;

    let decision = barrier_decision(
        &council_run.seats,
        config.council.synthesize_on_partial,
        cancelled,
    );

    let mut synthesis_ok = false;
    match decision {
        CouncilBarrierDecision::Synthesize { .. } => {
            council_run.status = CouncilRunStatus::Synthesizing;
            council_run.updated_at = chrono::Utc::now();
            write_council_run_manifest(&run_dir, &council_run).map_err(to_string)?;
            let _ = store.append_event_with_turn_id(
                session_uuid,
                SessionEventKind::CouncilSynthesisStarted,
                "Council synthesis started",
                serde_json::json!({
                    "councilRunId": council_run.id,
                    "synthesizerProviderId": request.synthesizer_provider_id,
                }),
                Some(parent_turn_id),
            );

            let answers = successful_seat_answers(&council_run.seats);
            let synth_user = build_synthesizer_user_prompt(&request.message, &answers);
            let synth_message = format!("{SYNTHESIZER_SYSTEM_PROMPT}\n\n---\n\n{synth_user}");
            let synth_run_id = Uuid::new_v4();
            store
                .link_usage_turn(session_uuid, synth_run_id, session_uuid, parent_turn_id)
                .map_err(to_string)?;
            let synth_request = ProviderChatRequest {
                session_id: request.session_id.clone(),
                message: synth_message,
                turn_id: Some(synth_run_id.to_string()),
                provider_id: request.synthesizer_provider_id.clone(),
                provider_label: request
                    .synthesizer_provider_label
                    .clone()
                    .or_else(|| Some(request.synthesizer_provider_id.clone())),
                model_id: request.synthesizer_model_id.clone(),
                model_label: request.synthesizer_model_label.clone(),
                reasoning_effort: None,
                require_command_approval: true,
                require_file_edit_approval: true,
                full_access: false,
                suggest_title: false,
                workspace_path: request
                    .workspace_path
                    .clone()
                    .or_else(|| Some(session.workspace_path.display().to_string())),
                mode: ChatMode::Council,
                goal: None,
                plan: None,
                attachments: Vec::new(),
                workspace_context: None,
                workspace_check: None,
                side_chat_context: None,
                internal_purpose: None,
            };
            emit_provider_chat_event(
                &app,
                &synth_request,
                "started",
                Some(HarnessRunStatus::Running),
                None,
                Some("Council synthesizing…".into()),
                None,
            );
            let synth_started = Instant::now();
            let synth_result = if provider_chat_cancelled(&app, &request.session_id) {
                Err(provider_stop_message(&app, &request.session_id))
            } else {
                run_provider_chat_with_retry(
                    &store,
                    &app,
                    &synth_request,
                    None,
                    UsageContext::new(UsageOrigin::CouncilSynthesis),
                )
                .map(|output| output.response)
                .map_err(|error| gyro_core::security::redact_secrets(&error.to_string()))
            };
            let synth_duration = synth_started.elapsed().as_millis();
            match synth_result {
                Ok(raw) => {
                    let labels = seat_label_map(&council_run.seats);
                    let mut synthesis = parse_council_synthesis(
                        &raw,
                        &request.synthesizer_provider_id,
                        request.synthesizer_model_id.clone(),
                        Some(synth_run_id),
                        &labels,
                    );
                    synthesis.started_at = Some(chrono::Utc::now());
                    synthesis.completed_at = Some(chrono::Utc::now());
                    synthesis.duration_ms = Some(synth_duration);
                    let path = write_synthesis_artifact(&run_dir, &synthesis.unified_markdown)
                        .map_err(to_string)?;
                    synthesis.artifact_path = Some(path.display().to_string());
                    council_run.synthesis = Some(synthesis.clone());
                    synthesis_ok = true;
                    let _ = store.append_event_with_turn_id(
                        session_uuid,
                        SessionEventKind::CouncilSynthesisCompleted,
                        "Council synthesis completed",
                        serde_json::json!({
                            "councilRunId": council_run.id,
                            "synthesizerProviderId": request.synthesizer_provider_id,
                            "durationMs": synth_duration,
                            "artifactPath": synthesis.artifact_path,
                            "recommendation": synthesis.recommendation.chars().take(400).collect::<String>(),
                        }),
                        Some(parent_turn_id),
                    );
                }
                Err(error) => {
                    let _ = store.append_event_with_turn_id(
                        session_uuid,
                        SessionEventKind::CouncilSynthesisCompleted,
                        "Council synthesis failed",
                        serde_json::json!({
                            "councilRunId": council_run.id,
                            "error": error,
                        }),
                        Some(parent_turn_id),
                    );
                }
            }
        }
        CouncilBarrierDecision::Cancelled => {
            council_run.status = CouncilRunStatus::Cancelled;
            council_run.cancelled_at = Some(chrono::Utc::now());
        }
        CouncilBarrierDecision::FailNoSuccessfulSeats => {
            // Either zero successes or partial without synthesize_on_partial.
            if council_run.seats_succeeded() == 0 {
                council_run.status = CouncilRunStatus::Failed;
            }
        }
    }

    let cancelled = cancelled || provider_chat_cancelled(&app, &request.session_id);
    council_run.status = final_run_status(&council_run.seats, synthesis_ok, cancelled);
    council_run.updated_at = chrono::Utc::now();
    council_run.recompute_totals();
    write_council_run_manifest(&run_dir, &council_run).map_err(to_string)?;

    let _ = store.append_event_with_turn_id(
        session_uuid,
        SessionEventKind::CouncilRunCompleted,
        format!("Council {}", council_run.status.as_str()),
        serde_json::json!({
            "councilRunId": council_run.id,
            "status": council_run.status.as_str(),
            "totals": council_run.totals,
        }),
        Some(parent_turn_id),
    );

    let assistant_markdown = council_run
        .synthesis
        .as_ref()
        .map(|synthesis| {
            synthesis
                .user_edited_markdown
                .clone()
                .unwrap_or_else(|| synthesis.unified_markdown.clone())
        })
        .unwrap_or_else(|| render_council_seats_fallback(&council_run));

    let seat_summaries: Vec<serde_json::Value> = council_run
        .seats
        .iter()
        .map(|seat| {
            serde_json::json!({
                "id": seat.id,
                "providerId": seat.provider_id,
                "providerLabel": seat.provider_label,
                "modelId": seat.model_id,
                "status": seat.status.as_str(),
                "durationMs": seat.duration_ms,
                "error": seat.error,
                "artifactPath": seat.artifact_path,
                "outputPreview": seat.raw_output.as_ref().map(|text| text.chars().take(400).collect::<String>()),
            })
        })
        .collect();

    let assistant_payload = serde_json::json!({
        "schema": gyro_core::HARNESS_SCHEMA_V1,
        "kind": "council-response",
        "runKind": "council-run",
        "runId": parent_turn_id,
        "turnTokens": store.task_usage_tokens(session_uuid, parent_turn_id).ok().flatten(),
        "councilRunId": council_run.id,
        "status": council_run.status.as_str(),
        "presetId": council_run.preset_id,
        "seats": seat_summaries,
        "synthesis": council_run.synthesis,
        "totals": council_run.totals,
        "manifestPath": run_dir.join("run.json").display().to_string(),
    });

    let assistant_event = store
        .append_event_with_turn_id(
            session_uuid,
            SessionEventKind::AssistantMessage,
            assistant_markdown,
            assistant_payload,
            Some(parent_turn_id),
        )
        .map_err(to_string)?;

    let harness_status = match council_run.status {
        CouncilRunStatus::Done | CouncilRunStatus::Partial => HarnessRunStatus::Done,
        CouncilRunStatus::Cancelled => HarnessRunStatus::Cancelled,
        _ => HarnessRunStatus::Failed,
    };

    let status_event = store
        .append_event_with_turn_id(
            session_uuid,
            SessionEventKind::SystemEvent,
            format!("Council {}", council_run.status.as_str()),
            serde_json::json!({
                "schema": gyro_core::HARNESS_SCHEMA_V1,
                "kind": "provider-run",
                "runId": parent_turn_id,
                "status": harness_status.as_str(),
                "councilRunId": council_run.id,
            }),
            Some(parent_turn_id),
        )
        .map_err(to_string)?;

    let phase = match council_run.status {
        CouncilRunStatus::Cancelled => "cancelled",
        CouncilRunStatus::Failed => "failed",
        _ => "completed",
    };
    let synth_request_for_emit = ProviderChatRequest {
        session_id: request.session_id.clone(),
        message: request.message.clone(),
        turn_id: Some(parent_turn_id.to_string()),
        provider_id: request.synthesizer_provider_id.clone(),
        provider_label: request.synthesizer_provider_label.clone(),
        model_id: request.synthesizer_model_id.clone(),
        model_label: request.synthesizer_model_label.clone(),
        reasoning_effort: None,
        require_command_approval: true,
        require_file_edit_approval: true,
        full_access: false,
        suggest_title: false,
        workspace_path: request.workspace_path.clone(),
        mode: ChatMode::Council,
        goal: None,
        plan: None,
        attachments: Vec::new(),
        workspace_context: None,
        workspace_check: None,
        side_chat_context: None,
        internal_purpose: None,
    };
    emit_provider_chat_event(
        &app,
        &synth_request_for_emit,
        phase,
        Some(harness_status),
        None,
        Some(format!("Council {}", council_run.status.as_str())),
        if matches!(
            council_run.status,
            CouncilRunStatus::Failed | CouncilRunStatus::Cancelled
        ) {
            Some(format!("Council {}", council_run.status.as_str()))
        } else {
            None
        },
    );

    let refreshed = store.get_session(session_uuid).map_err(to_string)?;
    if matches!(
        council_run.status,
        CouncilRunStatus::Failed | CouncilRunStatus::Cancelled
    ) && council_run.seats_succeeded() == 0
    {
        return Err(format!(
            "council failed: {}",
            council_run
                .seats
                .iter()
                .find_map(|seat| seat.error.clone())
                .unwrap_or_else(|| "no successful seats".into())
        ));
    }

    Ok(CouncilChatResponse {
        council_run,
        assistant_event,
        status_event,
        session: refreshed,
    })
}

pub(crate) fn render_council_seats_fallback(run: &CouncilRun) -> String {
    let mut out = String::from("## Council seats\n\n");
    out.push_str("Synthesis was unavailable. Individual seat answers are shown below.\n\n");
    for seat in &run.seats {
        out.push_str(&format!(
            "### {} ({})\n\n",
            seat.provider_label,
            seat.status.as_str()
        ));
        if let Some(error) = &seat.error {
            out.push_str(&format!("Error: {error}\n\n"));
        }
        if let Some(text) = &seat.raw_output {
            out.push_str(text.trim());
            out.push_str("\n\n");
        }
    }
    out
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadCouncilArtifactRequest {
    pub(crate) session_id: String,
    pub(crate) council_run_id: String,
    /// `seat` | `synthesis` | `manifest`
    pub(crate) kind: String,
    pub(crate) seat_id: Option<String>,
}

#[tauri::command]
pub(crate) async fn read_council_artifact(
    request: ReadCouncilArtifactRequest,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session_id = parse_uuid(&request.session_id)?;
        let council_run_id = parse_uuid(&request.council_run_id)?;
        let paths = GyroPaths::for_current_user().map_err(to_string)?;
        let run_dir = council_run_dir(&paths.sessions_dir, session_id, council_run_id);
        match request.kind.as_str() {
            "manifest" => {
                let path = run_dir.join("run.json");
                fs::read_to_string(&path).map_err(to_string)
            }
            "synthesis" => {
                let path = run_dir.join("synthesis.md");
                fs::read_to_string(&path).map_err(to_string)
            }
            "seat" => {
                let seat_id = request
                    .seat_id
                    .as_deref()
                    .ok_or_else(|| "seatId is required for seat artifacts".to_string())?;
                let seat_uuid = parse_uuid(seat_id)?;
                let path = run_dir.join(format!("seat-{seat_uuid}.md"));
                fs::read_to_string(&path).map_err(to_string)
            }
            other => Err(format!("unsupported council artifact kind `{other}`")),
        }
    })
    .await
    .map_err(|error| format!("council artifact worker failed: {error}"))?
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RetryCouncilSynthesisRequest {
    pub(crate) session_id: String,
    pub(crate) council_run_id: String,
    pub(crate) turn_id: Option<String>,
    pub(crate) synthesizer_provider_id: Option<String>,
    pub(crate) synthesizer_provider_label: Option<String>,
    pub(crate) synthesizer_model_id: Option<String>,
    pub(crate) synthesizer_model_label: Option<String>,
    pub(crate) workspace_path: Option<String>,
}

#[tauri::command]
pub(crate) async fn retry_council_synthesis(
    app: tauri::AppHandle,
    request: RetryCouncilSynthesisRequest,
) -> Result<CouncilChatResponse, String> {
    let session_id = request.session_id.clone();
    {
        let manager = app.state::<ProviderCancellationManager>();
        let mut flags = manager
            .flags
            .lock()
            .map_err(|_| "provider cancellation state is unavailable".to_string())?;
        if flags.contains_key(&session_id) {
            return Err("a provider turn is already running for this session".into());
        }
        if flags.len() >= MAX_CONCURRENT_PROVIDER_RUNS {
            return Err(format!(
                "Gyro can run at most {MAX_CONCURRENT_PROVIDER_RUNS} provider turns at once"
            ));
        }
        flags.insert(session_id.clone(), Arc::new(ProviderRunControl::default()));
    }
    let worker_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        retry_council_synthesis_blocking(worker_app, request)
    })
    .await
    .map_err(|error| format!("council re-synthesis worker failed: {error}"));
    app.state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .map(|mut flags| flags.remove(&session_id));
    result?
}

pub(crate) fn retry_council_synthesis_blocking(
    app: tauri::AppHandle,
    request: RetryCouncilSynthesisRequest,
) -> Result<CouncilChatResponse, String> {
    let store = open_store()?;
    let session_uuid = parse_uuid(&request.session_id)?;
    let council_run_id = parse_uuid(&request.council_run_id)?;
    let session = store
        .get_session(session_uuid)
        .map_err(to_string)?
        .ok_or_else(|| "council session no longer exists".to_string())?;
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    let run_dir = council_run_dir(&paths.sessions_dir, session_uuid, council_run_id);
    let mut council_run = gyro_core::read_council_run_manifest(&run_dir).map_err(to_string)?;

    // Reload seat bodies from artifacts when missing from the manifest.
    for seat in &mut council_run.seats {
        if seat.raw_output.is_none() && seat.status == CouncilSeatStatus::Done {
            if let Ok(body) = gyro_core::read_seat_artifact(&run_dir, seat.id) {
                seat.raw_output = Some(body);
            }
        }
    }

    let answers = successful_seat_answers(&council_run.seats);
    if answers.is_empty() {
        return Err("no successful council seats to re-synthesize".into());
    }

    let synth_provider = request
        .synthesizer_provider_id
        .clone()
        .or(council_run.synthesizer_provider_id.clone())
        .ok_or_else(|| "synthesizer provider is required".to_string())?;
    let synth_model = request
        .synthesizer_model_id
        .clone()
        .or(council_run.synthesizer_model_id.clone());
    let synth_label = request
        .synthesizer_provider_label
        .clone()
        .unwrap_or_else(|| synth_provider.clone());

    let parent_turn_id = request
        .turn_id
        .as_deref()
        .map(parse_uuid)
        .transpose()?
        .unwrap_or_else(Uuid::new_v4);

    let synth_user = build_synthesizer_user_prompt(&council_run.snapshot.prompt, &answers);
    let synth_message = format!("{SYNTHESIZER_SYSTEM_PROMPT}\n\n---\n\n{synth_user}");
    let synth_run_id = Uuid::new_v4();
    store
        .link_usage_turn(session_uuid, synth_run_id, session_uuid, parent_turn_id)
        .map_err(to_string)?;
    let synth_request = ProviderChatRequest {
        session_id: request.session_id.clone(),
        message: synth_message,
        turn_id: Some(synth_run_id.to_string()),
        provider_id: synth_provider.clone(),
        provider_label: Some(synth_label.clone()),
        model_id: synth_model.clone(),
        model_label: request.synthesizer_model_label.clone(),
        reasoning_effort: None,
        require_command_approval: true,
        require_file_edit_approval: true,
        full_access: false,
        suggest_title: false,
        workspace_path: request
            .workspace_path
            .clone()
            .or_else(|| Some(session.workspace_path.display().to_string())),
        mode: ChatMode::Council,
        goal: None,
        plan: None,
        attachments: Vec::new(),
        workspace_context: None,
        workspace_check: None,
        side_chat_context: None,
        internal_purpose: None,
    };

    let _ = store.append_event_with_turn_id(
        session_uuid,
        SessionEventKind::CouncilSynthesisStarted,
        "Council re-synthesis started",
        serde_json::json!({
            "councilRunId": council_run.id,
            "synthesizerProviderId": synth_provider,
            "retry": true,
        }),
        Some(parent_turn_id),
    );

    council_run.status = CouncilRunStatus::Synthesizing;
    council_run.updated_at = chrono::Utc::now();
    write_council_run_manifest(&run_dir, &council_run).map_err(to_string)?;

    emit_provider_chat_event(
        &app,
        &synth_request,
        "started",
        Some(HarnessRunStatus::Running),
        None,
        Some("Council re-synthesizing…".into()),
        None,
    );

    let synth_started = Instant::now();
    let synth_result = if provider_chat_cancelled(&app, &request.session_id) {
        Err(provider_stop_message(&app, &request.session_id))
    } else {
        run_provider_chat_with_retry(
            &store,
            &app,
            &synth_request,
            None,
            UsageContext::new(UsageOrigin::CouncilResynthesis),
        )
        .map(|output| output.response)
        .map_err(|error| gyro_core::security::redact_secrets(&error.to_string()))
    };
    let synth_duration = synth_started.elapsed().as_millis();
    let cancelled = provider_chat_cancelled(&app, &request.session_id);

    let synthesis_ok = match synth_result {
        Ok(raw) => {
            let labels = seat_label_map(&council_run.seats);
            let mut synthesis = parse_council_synthesis(
                &raw,
                &synth_provider,
                synth_model.clone(),
                Some(synth_run_id),
                &labels,
            );
            synthesis.started_at = Some(chrono::Utc::now());
            synthesis.completed_at = Some(chrono::Utc::now());
            synthesis.duration_ms = Some(synth_duration);
            let path = write_synthesis_artifact(&run_dir, &synthesis.unified_markdown)
                .map_err(to_string)?;
            synthesis.artifact_path = Some(path.display().to_string());
            council_run.synthesis = Some(synthesis.clone());
            let _ = store.append_event_with_turn_id(
                session_uuid,
                SessionEventKind::CouncilSynthesisCompleted,
                "Council re-synthesis completed",
                serde_json::json!({
                    "councilRunId": council_run.id,
                    "synthesizerProviderId": synth_provider,
                    "durationMs": synth_duration,
                    "artifactPath": synthesis.artifact_path,
                    "retry": true,
                }),
                Some(parent_turn_id),
            );
            true
        }
        Err(error) => {
            let _ = store.append_event_with_turn_id(
                session_uuid,
                SessionEventKind::CouncilSynthesisCompleted,
                "Council re-synthesis failed",
                serde_json::json!({
                    "councilRunId": council_run.id,
                    "error": error,
                    "retry": true,
                }),
                Some(parent_turn_id),
            );
            false
        }
    };

    council_run.synthesizer_provider_id = Some(synth_provider.clone());
    council_run.synthesizer_model_id = synth_model.clone();
    council_run.status = final_run_status(&council_run.seats, synthesis_ok, cancelled);
    council_run.updated_at = chrono::Utc::now();
    council_run.recompute_totals();
    write_council_run_manifest(&run_dir, &council_run).map_err(to_string)?;

    let assistant_markdown = council_run
        .synthesis
        .as_ref()
        .map(|synthesis| {
            synthesis
                .user_edited_markdown
                .clone()
                .unwrap_or_else(|| synthesis.unified_markdown.clone())
        })
        .unwrap_or_else(|| render_council_seats_fallback(&council_run));

    let seat_summaries: Vec<serde_json::Value> = council_run
        .seats
        .iter()
        .map(|seat| {
            serde_json::json!({
                "id": seat.id,
                "providerId": seat.provider_id,
                "providerLabel": seat.provider_label,
                "modelId": seat.model_id,
                "status": seat.status.as_str(),
                "durationMs": seat.duration_ms,
                "error": seat.error,
                "artifactPath": seat.artifact_path,
                "outputPreview": seat.raw_output.as_ref().map(|text| text.chars().take(400).collect::<String>()),
            })
        })
        .collect();

    let assistant_payload = serde_json::json!({
        "schema": gyro_core::HARNESS_SCHEMA_V1,
        "kind": "council-response",
        "runKind": "council-run",
        "runId": parent_turn_id,
        "turnTokens": store.task_usage_tokens(session_uuid, parent_turn_id).ok().flatten(),
        "councilRunId": council_run.id,
        "status": council_run.status.as_str(),
        "presetId": council_run.preset_id,
        "seats": seat_summaries,
        "synthesis": council_run.synthesis,
        "totals": council_run.totals,
        "manifestPath": run_dir.join("run.json").display().to_string(),
        "retry": true,
    });

    let assistant_event = store
        .append_event_with_turn_id(
            session_uuid,
            SessionEventKind::AssistantMessage,
            assistant_markdown,
            assistant_payload,
            Some(parent_turn_id),
        )
        .map_err(to_string)?;

    let harness_status = match council_run.status {
        CouncilRunStatus::Done | CouncilRunStatus::Partial => HarnessRunStatus::Done,
        CouncilRunStatus::Cancelled => HarnessRunStatus::Cancelled,
        _ => HarnessRunStatus::Failed,
    };
    let status_event = store
        .append_event_with_turn_id(
            session_uuid,
            SessionEventKind::SystemEvent,
            format!("Council {}", council_run.status.as_str()),
            serde_json::json!({
                "schema": gyro_core::HARNESS_SCHEMA_V1,
                "kind": "provider-run",
                "runId": parent_turn_id,
                "status": harness_status.as_str(),
                "councilRunId": council_run.id,
                "retry": true,
            }),
            Some(parent_turn_id),
        )
        .map_err(to_string)?;

    emit_provider_chat_event(
        &app,
        &synth_request,
        if synthesis_ok { "completed" } else { "failed" },
        Some(harness_status),
        None,
        Some(format!("Council {}", council_run.status.as_str())),
        if synthesis_ok {
            None
        } else {
            Some("Council re-synthesis failed".into())
        },
    );

    if !synthesis_ok {
        return Err("council re-synthesis failed".into());
    }

    let refreshed = store.get_session(session_uuid).map_err(to_string)?;
    Ok(CouncilChatResponse {
        council_run,
        assistant_event,
        status_event,
        session: refreshed,
    })
}
