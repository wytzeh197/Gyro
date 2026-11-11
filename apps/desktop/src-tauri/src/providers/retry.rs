use crate::{
    app::config::load_config_blocking,
    delegated_agents, efficiency, provider_accounting,
    provider_accounting::{provider_turn_tokens, record_provider_usage},
    provider_context, provider_reliability,
    provider_reliability::is_transient_provider_error,
    provider_spend_guard, provider_timeline,
    providers::{
        binding::validate_chat_context,
        chat_types::{isolated_internal_purpose, ChatAttachmentRequest, ProviderChatRequest},
        process::provider_adapter_for,
        retry_recovery as provider_retry_recovery,
        retry_recovery::run_provider_chat_with_retry_using_with_wait,
        run::compact_provider_chat_blocking,
        runner::runner_for,
        runners::kimi_acp::provider_resume_cursor_from_binding,
        streaming::{provider_chat_cancelled, provider_stop_message},
        tauri_host::TauriRunnerHost,
        types::{ProviderResumeCursor, ProviderRunAttempt, ProviderRunnerOutput},
    },
    state::managers::ProviderCancellationManager,
    stores::parse_uuid,
    usage::guard::{session_context_signal, usage_guard_block, UsageContext},
};
use gyro_core::{
    timing, timing::Stage as TimingStage, ProviderSessionBinding, SessionStore, UsageOrigin,
    UsageOutcome,
};
use std::{
    fs,
    sync::atomic::Ordering,
    time::{Duration, Instant},
};
use tauri::Manager;
use uuid::Uuid;
/// Compact a resumed session before the next prompt when its last measured
/// fill is at or past the configured share.
///
/// Every provider reaches the model through `run_provider_chat_with_retry`,
/// so this is the one place a new adapter cannot skip. The rewrite is the
/// same one `/compact` runs: Codex compacts inside its session, and every
/// other provider starts the next prompt from the saved checkpoint. A
/// compaction summary is itself a provider call and must not compact again.
pub(crate) fn auto_compact_owned_session(
    store: &SessionStore,
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    binding: Option<ProviderSessionBinding>,
    usage_context: UsageContext,
) -> anyhow::Result<Option<ProviderSessionBinding>> {
    // A summary of the conversation must not compact the conversation first.
    if usage_context.origin == UsageOrigin::ContextCompaction
        || isolated_internal_purpose(request).is_some()
        || request.message.trim() == "/compact"
    {
        return Ok(binding);
    }
    let percent = match load_config_blocking() {
        Ok(config) => config.usage_guard.auto_compact_percent,
        Err(_) => return Ok(binding),
    };
    let Ok(session_id) = parse_uuid(&request.session_id) else {
        return Ok(binding);
    };
    let Ok(events) = store.read_events(session_id) else {
        return Ok(binding);
    };
    let signals = events
        .iter()
        .map(session_context_signal)
        .collect::<Vec<_>>();
    let catalog_window = provider_context::provider_model_context_window(
        &request.provider_id,
        request.model_id.as_deref(),
    );
    if !provider_context::should_auto_compact_session(
        percent,
        &request.provider_id,
        request.model_id.as_deref(),
        catalog_window,
        &signals,
    ) {
        return Ok(binding);
    }
    let run_id = request
        .turn_id
        .as_deref()
        .and_then(|value| Uuid::parse_str(value).ok())
        .unwrap_or_else(Uuid::new_v4);
    // Codex compacts inside the resumed session. Everyone else drops the
    // binding so the following prompt starts from the checkpoint instead of
    // reopening the full transcript.
    let keeps_resume = binding.as_ref().is_some_and(|binding| {
        provider_resume_cursor_from_binding(binding)
            .is_some_and(|cursor| cursor.kind == "codex-session")
    });
    loop {
        provider_retry_recovery::wait_for_shared_cooldown(app, request)?;
        match compact_provider_chat_blocking(app.clone(), request.session_id.clone(), run_id) {
            Ok(_) => return Ok(if keeps_resume { binding } else { None }),
            Err(error) if provider_reliability::is_rate_limit_error(&error) => {
                let hint = gyro_core::provider_retry::provider_cooldown_hint(&error)
                    .unwrap_or(Duration::from_secs(30));
                gyro_core::provider_cooldown::observe_error(&error, hint);
                if hint > Duration::from_secs(30) {
                    return Err(anyhow::anyhow!(
                        "Required context compaction failed: {error}"
                    ));
                }
                if !gyro_core::provider_retry::take_retry() {
                    return Err(anyhow::anyhow!(
                        "{} Required context compaction failed: {error}",
                        provider_retry_recovery::RETRY_EXHAUSTED
                    ));
                }
                // Retry the compaction itself, never the uncompacted generation.
            }
            Err(error) => {
                return Err(anyhow::anyhow!(
                    "Required context compaction failed: {error}"
                ))
            }
        }
    }
}

pub(crate) fn run_provider_chat_with_retry(
    store: &SessionStore,
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    binding: Option<ProviderSessionBinding>,
    usage_context: UsageContext,
) -> anyhow::Result<ProviderRunnerOutput> {
    validate_workflow_request(store,request)?;
    let _checkout_lease=ordinary_checkout_lease(store,request)?;
    let _budget = gyro_core::provider_retry::RetryScope::start();
    let _cycle = provider_retry_recovery::Cycle::start();
    let _cooldown = gyro_core::provider_cooldown::Scope::enter(
        provider_retry_recovery::cooldown_scope(store, request),
    );
    let observer_app = app.clone();
    let observer_request = request.clone();
    let _observer =
        gyro_core::provider_retry::ObserveWait::start(move |delay, attempt, waiting| {
            provider_retry_recovery::set_kind(
                if gyro_core::provider_cooldown::remaining().is_zero() {
                    "network"
                } else {
                    "rate-limit"
                },
            );
            if waiting {
                provider_retry_recovery::emit_wait(
                    &observer_app,
                    &observer_request,
                    delay,
                    attempt,
                    3,
                );
            } else {
                provider_retry_recovery::emit_started(&observer_app, &observer_request, attempt, 3);
            }
        });
    provider_retry_recovery::wait_for_shared_cooldown(app, request)?;
    let profiled = efficiency::profile(request);
    let request = &profiled;
    let binding = auto_compact_owned_session(store, app, request, binding, usage_context)?;
    let mut output =
        run_provider_chat_with_retry_inner(store, app, request, binding, usage_context)?;
    let mut continuation = request.clone();
    for round in 0..=8 {
        let Some(reports) = delegated_agents::collect_for_parent(app, request)? else {
            if let (Ok(session), Some(turn)) = (
                Uuid::parse_str(&request.session_id),
                request
                    .turn_id
                    .as_deref()
                    .and_then(|value| Uuid::parse_str(value).ok()),
            ) {
                if let Some(tokens) = store.task_usage_tokens(session, turn)? {
                    output.accounted_usage = Some(tokens);
                    provider_accounting::emit_task_tokens(app, request, tokens);
                }
            }
            return Ok(output);
        };
        if round == 8 {
            anyhow::bail!(
                "the parent reached its delegation synthesis limit; remaining agents were stopped"
            );
        }
        continuation.message = format!("Your previous response was held until delegated agents settled. Their reports follow. Incorporate these results and failures, verify any necessary changes, and then give the final response to the original request.\n\nOriginal request:\n{}\n\nPrevious response:\n{}\n\nAgent reports:\n{}", request.message, output.response, reports);
        let binding = output
            .resume_cursor
            .as_ref()
            .map(|cursor| ProviderSessionBinding {
                session_id: Uuid::parse_str(&request.session_id).unwrap(),
                provider_id: request.provider_id.clone(),
                model_id: request.model_id.clone(),
                model_label: request.model_label.clone(),
                reasoning_effort: request.reasoning_effort.clone(),
                resume_cursor_json: serde_json::to_value(cursor).unwrap(),
                status: "ready".into(),
                last_error: None,
                updated_at: chrono::Utc::now(),
            });
        let a = provider_turn_tokens(request, Some(&output));
        provider_accounting::set_usage_offset(app, &request.session_id, Some(a));
        let next_result =
            run_provider_chat_with_retry_inner(store, app, &continuation, binding, usage_context);
        provider_accounting::set_usage_offset(app, &request.session_id, None);
        let mut next = next_result?;
        let b = provider_turn_tokens(&continuation, Some(&next));
        next.accounted_usage = Some(a.combine(b).with_scope(gyro_core::usage::UsageScope::Turn));
        let mut activities = output.activities;
        activities.append(&mut next.activities);
        next.activities = activities;
        output = next;
        provider_accounting::emit_task_tokens(app, request, output.accounted_usage.unwrap());
    }
    anyhow::bail!(
        "the parent reached its delegation synthesis limit; remaining agents were stopped"
    )
}

pub(crate) fn run_provider_chat_with_retry_inner(
    store: &SessionStore,
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    binding: Option<ProviderSessionBinding>,
    usage_context: UsageContext,
) -> anyhow::Result<ProviderRunnerOutput> {
    if let Some(reason) = usage_guard_block(store, usage_context.origin, &request.provider_id) {
        anyhow::bail!(reason);
    }
    if let (Ok(session), Some(turn)) = (
        Uuid::parse_str(&request.session_id),
        request
            .turn_id
            .as_deref()
            .and_then(|value| Uuid::parse_str(value).ok()),
    ) {
        let _ = store.note_usage_call(session, turn);
    }
    let started = Instant::now();
    provider_spend_guard::bind(app, request, store);
    let _observations = gyro_core::provider_observation::Scope::start();
    provider_accounting::bind_timing(app, &request.session_id);
    let mut result = run_provider_chat_with_retry_using_with_wait(
        store,
        request,
        binding,
        |resume_cursor, attempt| {
            provider_retry_recovery::wait_for_shared_cooldown(app, request)?;
            gyro_core::provider_observation::attempt();
            let shown = provider_timeline::item_count(app, &request.session_id);
            let continuation = attempt
                .continuing_work
                .then(|| provider_retry_recovery::continuation_request(request));
            let result = run_provider_chat_once(
                app,
                continuation.as_ref().unwrap_or(request),
                resume_cursor,
                attempt,
            );
            attempt.tools_dispatched |=
                provider_accounting::has_dispatched_tools(app, &request.session_id);
            attempt.mutations_completed |= app
                .state::<ProviderCancellationManager>()
                .flags
                .lock()
                .ok()
                .and_then(|flags| flags.get(&request.session_id).cloned())
                .is_some_and(|control| control.completed_mutations.load(Ordering::Relaxed));
            attempt.published_output |= provider_timeline::item_count(app, &request.session_id)
                != shown
                || attempt.tools_dispatched
                || attempt.mutations_completed;
            if let Ok(output) = &result {
                if let Some(tokens) = output.accounted_usage.or_else(|| {
                    output
                        .billed_usage
                        .as_ref()
                        .map(provider_accounting::usage_tokens)
                }) {
                    gyro_core::provider_observation::native_usage(tokens);
                }
            }
            result
        },
        || {
            provider_chat_cancelled(app, &request.session_id)
                .then(|| provider_stop_message(app, &request.session_id))
        },
        |delay, retry_attempt, max_attempts, _capacity| {
            {
                provider_retry_recovery::emit_wait(
                    app,
                    request,
                    delay,
                    retry_attempt,
                    max_attempts,
                );
            }
            wait_before_provider_retry(delay, &|| {
                provider_chat_cancelled(app, &request.session_id)
                    .then(|| provider_stop_message(app, &request.session_id))
            })?;
            provider_retry_recovery::emit_started(app, request, retry_attempt, max_attempts);
            Ok(())
        },
    )
    .map_err(|error| {
        if gyro_core::provider_retry::retries_used() >= 3
            && is_transient_provider_error(&format!("{error:#}"))
        {
            error.context(provider_retry_recovery::RETRY_EXHAUSTED)
        } else {
            anyhow::anyhow!("{error:#}")
        }
    });
    timing::mark(TimingStage::ProviderComplete);
    if let Some(summary) = gyro_core::provider_observation::snapshot() {
        if let Ok(output) = &mut result {
            output.accounted_usage = summary.tokens.or(output.accounted_usage);
            output.retry_count = output.retry_count.max(summary.retries);
        }
        timing::provider_requests(summary);
    }
    let wall_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
    match result.as_ref() {
        Ok(output) => record_provider_usage(
            store,
            request,
            usage_context,
            Some(output),
            UsageOutcome::Done,
            wall_ms,
        ),
        // A failed or cancelled run still burned whatever it burned before it
        // stopped, so it is recorded rather than dropped.
        Err(error) => record_provider_usage(
            store,
            request,
            usage_context,
            None,
            if is_provider_cancellation(&error.to_string()) {
                UsageOutcome::Cancelled
            } else {
                UsageOutcome::Failed
            },
            wall_ms,
        ),
    }
    if result.is_err() {
        let _ = efficiency::save_checkpoint(app, store, request);
    }
    result
}

/// Wait out a retry delay in short steps, returning the stop message if the
/// run is stopped meanwhile so a stopped turn never starts another attempt.
pub(crate) fn wait_before_provider_retry(
    delay: Duration,
    stopped: &impl Fn() -> Option<String>,
) -> Result<(), String> {
    let deadline = Instant::now() + delay;
    loop {
        if let Some(message) = stopped() {
            return Err(message);
        }
        let now = Instant::now();
        if now >= deadline {
            return Ok(());
        }
        std::thread::sleep((deadline - now).min(Duration::from_millis(50)));
    }
}

pub(crate) fn persist_failed_provider_attempt(
    store: &SessionStore,
    request: &ProviderChatRequest,
    binding: Option<&ProviderSessionBinding>,
    attempt: &ProviderRunAttempt,
    error: &anyhow::Error,
) {
    let last_error = Some(gyro_core::security::redact_secrets(&error.to_string()));
    match binding {
        Some(binding) => {
            let _ = store.upsert_provider_session_binding(
                binding.session_id,
                binding.provider_id.clone(),
                binding.model_id.clone(),
                binding.model_label.clone(),
                binding.reasoning_effort.clone(),
                attempt
                    .resume_cursor
                    .as_ref()
                    .and_then(|cursor| serde_json::to_value(cursor).ok())
                    .unwrap_or_else(|| binding.resume_cursor_json.clone()),
                "failed",
                last_error,
            );
        }
        // A session's first turn has no binding to carry forward, so the cursor
        // this run created is the only record that the provider conversation
        // exists. Dropping it is what made a stopped first turn restart from
        // nothing on every retry.
        None => {
            let cursor_json = attempt
                .resume_cursor
                .as_ref()
                .and_then(|cursor| serde_json::to_value(cursor).ok());
            if let (Some(cursor_json), Ok(session_id)) =
                (cursor_json, parse_uuid(&request.session_id))
            {
                let _ = store.upsert_provider_session_binding(
                    session_id,
                    request.provider_id.clone(),
                    request.model_id.clone(),
                    request.model_label.clone(),
                    request.reasoning_effort.clone(),
                    cursor_json,
                    "failed",
                    last_error,
                );
            }
        }
    }
}

pub(crate) fn with_browser_attachment_images(
    request: &ProviderChatRequest,
    supports_images: bool,
) -> anyhow::Result<ProviderChatRequest> {
    let mut expanded = request.clone();
    if supports_images
        && request
            .attachments
            .iter()
            .any(|item| item.kind == "browser-snapshot")
    {
        validate_chat_context(request).map_err(anyhow::Error::msg)?;
        for attachment in &request.attachments {
            if attachment.kind != "browser-snapshot" {
                continue;
            }
            let snapshot: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(&attachment.path)?)?;
            if let Some(image) = snapshot.get("attachedImage") {
                let image: ChatAttachmentRequest = serde_json::from_value(image.clone())?;
                anyhow::ensure!(
                    image.kind == "image",
                    "browser snapshot contained an invalid image reference"
                );
                if !expanded
                    .attachments
                    .iter()
                    .any(|existing| existing.id == image.id && existing.path == image.path)
                {
                    expanded.attachments.push(image);
                }
            }
        }
        // Apply the same session ownership, integrity, size and count limits as
        // ordinary images. Snapshot JSON cannot grant arbitrary file access.
        validate_chat_context(&expanded).map_err(anyhow::Error::msg)?;
    }
    Ok(expanded)
}

pub(crate) fn run_provider_chat_once(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    resume_cursor: Option<&ProviderResumeCursor>,
    attempt: &mut ProviderRunAttempt,
) -> anyhow::Result<ProviderRunnerOutput> {
    gyro_core::model_retirements::validate_provider_model(
        &request.provider_id,
        request.model_id.as_deref(),
    )?;
    timing::attempt();
    let runner = runner_for(provider_adapter_for(&request.provider_id).kind);
    let mut expanded = with_browser_attachment_images(request, runner.supports_images(request))?;
    let memory_store = crate::stores::open_store().map_err(anyhow::Error::msg)?;
    validate_workflow_request(&memory_store,request)?;
    let _checkout_lease=ordinary_checkout_lease(&memory_store,request)?;
    let memory_session = memory_store
        .get_session(uuid::Uuid::parse_str(&request.session_id)?)?
        .ok_or_else(|| anyhow::anyhow!("memory session no longer exists"))?;
    expanded.project_memory = if request.internal_purpose.is_none() && request.workflow_run_id.is_none()
    {
        Some(gyro_core::project_memory::prepare_memory_context(
            &memory_store,
            &memory_session,
            request,
            crate::provider_context::provider_model_context_window(
                &request.provider_id,
                request.model_id.as_deref(),
            ),
        )?)
    } else {
        None
    };
    if let Some(memory) = expanded.project_memory.as_mut() {
        memory.suggest_candidates &= request
            .project_memory
            .as_ref()
            .is_some_and(|memory| memory.suggest_candidates);
    }
    if expanded.project_memory.is_some() {
        memory_store.invalidate_project_memory_receipt(memory_session.id, &request.provider_id)?;
    }
    let output = runner.run(
        &TauriRunnerHost::new(app),
        &expanded,
        resume_cursor,
        attempt,
    )?;
    if !output.answer_cut_off {
        if let (Some(turn), Some(cursor)) =
            (request.turn_id.as_deref(), output.resume_cursor.as_ref())
        {
            // Only acknowledged successful attempts can suppress later input.
            if let Some(memory) = &expanded.project_memory {
                if let Err(error) = memory_store.acknowledge_project_memory_receipt(
                    memory_session.id,
                    uuid::Uuid::parse_str(turn)?,
                    &request.provider_id,
                    &serde_json::to_value(cursor)?,
                    &memory.render(output.resumed).1,
                ) {
                    eprintln!(
                        "Memory context acknowledgement unavailable: {}",
                        gyro_core::sanitize_capability_summary(&error.to_string())
                    );
                }
            }
        }
    }
    Ok(output)
}

pub(crate) use gyro_core::provider_runtime::reliability::is_provider_cancellation;

fn validate_workflow_request(store:&SessionStore,request:&ProviderChatRequest)->anyhow::Result<()> {
    if request.internal_purpose.is_none() {
        if let Some(root)=request.workspace_path.as_deref().map(std::path::Path::new).and_then(|root|root.canonicalize().ok()) {
            if let Some(id)=request.workflow_run_id {
                store.validate_workflow_dispatch(id,Uuid::parse_str(&request.session_id)?,&request.provider_id,request.model_id.as_deref(),&root.to_string_lossy())?;
            }else{
                anyhow::ensure!(store.active_workflow_for_root(&root.to_string_lossy())?.is_none(),"A workflow owns this checkout; stop it or use another worktree");
            }
        }
    }
    Ok(())
}

fn ordinary_checkout_lease(store:&SessionStore,request:&ProviderChatRequest)->anyhow::Result<Option<gyro_core::workflows::WorkflowCheckoutLease>>{
 if request.workflow_run_id.is_some()||request.internal_purpose.is_some(){return Ok(None)}
 #[cfg(not(unix))] {return Ok(None)}
 let session=store.get_session(Uuid::parse_str(&request.session_id)?)?.ok_or_else(||anyhow::anyhow!("source session is unavailable"))?;
 if session.workspace_path.as_os_str().is_empty(){return Ok(None)}
 Ok(Some(gyro_core::workflows::WorkflowCheckoutLease::try_acquire(store.paths(),&session.workspace_path,false)?.ok_or_else(||anyhow::anyhow!("A workflow owns this checkout; stop it or choose another worktree"))?))
}
