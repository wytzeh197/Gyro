use crate::{
    capabilities::bridge::active_provider_capability_context,
    context_compaction, conversation_history,
    conversation_history::local_compaction_summary,
    efficiency,
    provider_context::ProviderContextUsage,
    providers::{
        binding::bind_provider_capability_context,
        chat_types::{
            ChatMode, InternalRequestPurpose, ProviderChatRequest,
            ProviderContextCompactionResponse,
        },
        events::{emit_provider_activity_event, provider_activity_event_entry},
        retry::run_provider_chat_with_retry,
        types::ProviderActivity,
    },
    stores::{parse_uuid, to_string},
    usage::guard::UsageContext,
};
use gyro_core::{SessionStore, UsageOrigin};
use std::time::Instant;
use uuid::Uuid;
/// One metered provider call that turns this chat's transcript into the
/// checkpoint a manual `/compact` stores.
///
/// A provider with a compaction command of its own never reaches this: it
/// compacts inside its own session. Every other provider gets a real
/// summarization request, so what the transcript shows is work a model
/// actually did, and its reply is what the next turn starts from.
pub(crate) fn run_compaction_summary_call(
    store: &SessionStore,
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
) -> Result<(String, Option<ProviderContextUsage>), String> {
    let transcript = conversation_history::compaction_transcript_for_session(&request.session_id)
        .ok_or_else(|| "this chat has no transcript to summarize".to_string())?;
    // Reads text and writes text, and touches nothing else. Council mode is
    // Gyro's existing shape for exactly that -- deny-all at the capability
    // gate, no tools, no approvals -- so this borrows it rather than inventing
    // a weaker policy of its own.
    let summary_request = ProviderChatRequest {
        session_id: request.session_id.clone(),
        message: format!(
            "{}\n\n---\n\n{transcript}",
            conversation_history::COMPACTION_PROMPT
        ),
        turn_id: request.turn_id.clone(),
        provider_id: request.provider_id.clone(),
        provider_label: request.provider_label.clone(),
        model_id: request.model_id.clone(),
        model_label: request.model_label.clone(),
        reasoning_effort: request.reasoning_effort.clone(),
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
        workflow_run_id: None,
        project_memory: None,        internal_purpose: Some(InternalRequestPurpose::ContextSummary),
    };
    // An auto-compaction runs inside a turn that already bound its context. A
    // manual `/compact` runs between turns, where nothing is bound, and every
    // runner refuses to start without one -- so the summarizer binds its own,
    // under the same deny-all council policy as the request.
    if active_provider_capability_context(app, &request.session_id).is_err() {
        let session_uuid = parse_uuid(&request.session_id)?;
        let session = store
            .get_session(session_uuid)
            .map_err(to_string)?
            .ok_or_else(|| "provider chat session no longer exists".to_string())?;
        let run_id = request
            .turn_id
            .as_deref()
            .and_then(|value| Uuid::parse_str(value).ok())
            .unwrap_or_else(Uuid::new_v4);
        bind_provider_capability_context(app, store, &summary_request, run_id, false, &session)?;
    }
    // The caller already holds this session's cancellation flag for the whole
    // compaction, so Stop ends the summarizer like it ends any other turn.
    let _mute = context_compaction::mute_summary_stream(&request.session_id);
    run_provider_chat_with_retry(
        store,
        app,
        &summary_request,
        None,
        UsageContext::new(store.workflow_dispatch_origin(Uuid::parse_str(&request.session_id).map_err(to_string)?).map_err(to_string)?.filter(|origin|matches!(origin,UsageOrigin::Automation|UsageOrigin::AgentSession)).unwrap_or(UsageOrigin::ContextCompaction)),
    )
    .map(|output| (output.response, output.billed_usage))
    .map_err(|error| gyro_core::security::redact_secrets(&error.to_string()))
}

pub(crate) fn compact_local_provider_chat(
    app: &tauri::AppHandle,
    store: &SessionStore,
    request: &ProviderChatRequest,
    session_id: Uuid,
    run_id: Uuid,
) -> Result<ProviderContextCompactionResponse, String> {
    let events = store.read_events(session_id).map_err(to_string)?;
    let _ = efficiency::save_checkpoint(app, store, request);
    // Refuse before spending a call: with no completed reply in the window
    // there is nothing a model could summarize.
    let fallback = local_compaction_summary(&events).ok_or_else(|| {
        "this chat needs a completed reply before context can be compacted".to_string()
    })?;
    let params = serde_json::json!({ "turnId": run_id.to_string() });
    let label = request
        .model_label
        .as_deref()
        .or(request.provider_label.as_deref())
        .unwrap_or(request.provider_id.as_str());
    // Emitted before the request leaves, so a compaction that takes a while is
    // visible as work instead of as a turn that already finished.
    let mut running = context_compaction::codex_context_compaction_activity(&params, "running");
    running.detail = Some(format!(
        "Summarizing the earlier conversation with {label}."
    ));
    emit_provider_activity_event(app, request, &running, Some(0));

    // A resumable provider session holds the whole thread, tool results
    // included. Only a real summary is worth trading it for; the local rewrite
    // clips every turn, so dropping the session for it loses context to save
    // none.
    let resumable = store
        .get_provider_session_binding(session_id, &request.provider_id)
        .map_err(to_string)?
        .is_some();

    let started = Instant::now();
    let (compaction, usage, failure) = match run_compaction_summary_call(store, app, request) {
        Ok((reply, usage)) => match conversation_history::summarized_compaction(&reply) {
            Some(compaction) => (compaction, usage, None),
            None => (
                fallback,
                None,
                Some("the provider returned an empty summary".to_string()),
            ),
        },
        // A provider that cannot answer -- offline, out of quota, a CLI that
        // refused the prompt -- still leaves a usable checkpoint: the local
        // rewrite, worded as the rewrite it is.
        Err(error) => (fallback, None, Some(error)),
    };
    if let (Some(error), true) = (failure.as_deref(), resumable) {
        let failed = ProviderActivity {
            id: running.id,
            kind: "context".into(),
            label: "Context compaction failed".into(),
            detail: Some(format!(
                "Could not summarize this chat ({error}). The conversation continues unchanged."
            )),
            file_counts: None,
            note: None,
            status: "failed".into(),
        };
        emit_provider_activity_event(app, request, &failed, Some(0));
        let _ = store.append_system_events_with_turn_id(
            session_id,
            vec![provider_activity_event_entry(request, run_id, 0, &failed)],
        );
        return Err(error.to_string());
    }
    // A new provider session starts from the saved checkpoint on the next
    // turn. If writing the checkpoint fails, the transcript still carries the
    // original messages and the normal handoff path can reconstruct them.
    store
        .clear_provider_session_binding(session_id, &request.provider_id)
        .map_err(to_string)?;
    let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let report = context_compaction::CompactionSummary {
        label,
        elapsed_ms,
        input_tokens: usage.as_ref().and_then(|usage| usage.input_tokens),
    };
    let mut completed = context_compaction::codex_context_compaction_activity(&params, "done");
    completed.detail = Some(match failure.as_deref() {
        Some(error) => format!(
            "Could not summarize this chat ({error}). {}",
            context_compaction::manual_compaction_detail(&compaction, None)
        ),
        None => context_compaction::manual_compaction_detail(&compaction, Some(&report)),
    });
    let mut entry = provider_activity_event_entry(request, run_id, 0, &completed);
    if let Some(payload) = entry.1.as_object_mut() {
        payload.insert(
            "contextSummary".into(),
            serde_json::Value::String(compaction.text.clone()),
        );
        // What every surface may claim. A provider reply is "summarized"; the
        // local fallback keeps its own two words, so the card never reports
        // work no model did.
        payload.insert(
            "compactionMode".into(),
            serde_json::Value::String(compaction.mode().into()),
        );
        if compaction.condensed_turns > 0 {
            payload.insert(
                "condensedTurns".into(),
                serde_json::json!(compaction.condensed_turns),
            );
        }
        payload.insert("compactionElapsedMs".into(), serde_json::json!(elapsed_ms));
        if let Some(error) = failure {
            payload.insert("compactionError".into(), serde_json::Value::String(error));
        }
    }
    let activity_events = store
        .append_system_events_with_turn_id(session_id, vec![entry])
        .map_err(to_string)?;
    emit_provider_activity_event(app, request, &completed, Some(0));
    Ok(ProviderContextCompactionResponse { activity_events })
}
