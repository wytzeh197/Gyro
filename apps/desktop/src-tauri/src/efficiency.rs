//! Desktop integration for local, inspectable efficiency policies.
use super::*;
use gyro_core::efficiency::{
    checkpoint::{AgentNotes, FileEvidence, TaskCheckpoint},
    progress::Decision,
};
use serde_json::{json, Value};
static ROUTE_LOCK: Mutex<()> = Mutex::new(());

thread_local! { static PROMPT_SECTIONS: std::cell::RefCell<Option<(String,String)>> = const {std::cell::RefCell::new(None)}; }
pub(super) fn capture_prompt(build: impl FnOnce() -> String) -> (String, String) {
    let _measure = timing::EfficiencyTimer::start(timing::EfficiencyComponent::RequestAssembly);
    PROMPT_SECTIONS.with(|slot| *slot.borrow_mut() = Some((String::new(), String::new())));
    let original = build();
    PROMPT_SECTIONS
        .with(|slot| slot.borrow_mut().take())
        .filter(|(_, dynamic)| !dynamic.is_empty())
        .unwrap_or((String::new(), original))
}
fn stable_instruction(part: &str) -> bool {
    [
        "Council seat mode:",
        "Work efficiently:",
        "Reuse current evidence,",
        "Use the selected workspace to carry out workspace requests.",
        "Paths are workspace-relative.",
        "Finish requested implementation with authorized edits",
        "When the user requests implementation, carry it through",
        "Gyro Workspace tools are available,",
        "For long-running builds or release checks,",
        "Plan mode is read-only.",
        "When you create or revise the checklist,",
        "When the plan is ready for implementation,",
        "The Gyro plan below is live while you work.",
    ]
    .iter()
    .any(|prefix| part.starts_with(prefix))
}

pub(super) fn record_prompt_parts(parts: &[String], message: &str) {
    PROMPT_SECTIONS.with(|slot| {
        if slot.borrow().is_none() {
            return;
        }
        let mut stable = Vec::new();
        let mut dynamic = Vec::new();
        let mut attribution = gyro_core::efficiency::context::Attribution::default();
        for part in parts {
            if part.starts_with("Prior conversation in this Gyro chat") {
                attribution.history += part.chars().count() as u64;
                dynamic.push(part.as_str());
            } else if part.starts_with("Explicit user attachments:") {
                attribution.source_excerpts += part.chars().count() as u64;
                dynamic.push(part.as_str());
            } else if part.starts_with("Selected workspace:")
                || part.starts_with("Gyro chat mode:")
                || part.starts_with("Goal")
                || part.starts_with("Plan")
                || part.starts_with("Workspace")
                || part.starts_with("[gyro.")
            {
                attribution.task_state += part.chars().count() as u64;
                dynamic.push(part.as_str());
            } else if stable_instruction(part) {
                stable.push(part.as_str());
            } else {
                dynamic.push(part.as_str());
            }
        }
        gyro_core::provider_observation::prepared_context(attribution);
        *slot.borrow_mut() = Some((
            stable.join("\n"),
            format!("{}\n\nUser message:\n{}", dynamic.join("\n"), message),
        ));
    });
}

pub(super) fn config() -> gyro_core::efficiency::Config {
    load_config_blocking()
        .map(|c| c.efficiency)
        .unwrap_or_default()
}
#[tauri::command]
pub async fn set_efficiency_config(
    value: gyro_core::efficiency::Config,
) -> Result<gyro_core::efficiency::Config, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = GyroPaths::for_current_user().map_err(to_string)?;
        GyroConfig::update(&paths, |current| {
            gyro_core::efficiency::pricing::validate_append(
                &current.efficiency.prices,
                &value.prices,
            )?;
            anyhow::ensure!(
                value.routing.routes.len() <= 8,
                "At most eight phase routes"
            );
            current.efficiency = value.clone();
            Ok(())
        })
        .map_err(to_string)?;
        Ok(value)
    })
    .await
    .map_err(to_string)?
}
#[tauri::command]
pub async fn get_efficiency_task_totals(
    task_id: String,
) -> Result<gyro_core::efficiency::accounting::TaskTotals, String> {
    tauri::async_runtime::spawn_blocking(move || {
        open_store()?
            .efficiency_task_totals(parse_uuid(&task_id)?)
            .map_err(to_string)
    })
    .await
    .map_err(to_string)?
}
struct PhaseAdmission {
    app: tauri::AppHandle,
    session_id: String,
    control: Arc<ProviderRunControl>,
}
impl PhaseAdmission {
    fn acquire(app: &tauri::AppHandle, session_id: &str) -> Result<Self, String> {
        let manager = app.state::<ProviderCancellationManager>();
        let mut flags = manager.flags.lock().map_err(to_string)?;
        if flags.contains_key(session_id) {
            return Err("Finish or stop the active turn before changing phase".into());
        }
        let control = Arc::new(ProviderRunControl::default());
        flags.insert(session_id.to_string(), control.clone());
        Ok(Self {
            app: app.clone(),
            session_id: session_id.into(),
            control,
        })
    }
}
impl Drop for PhaseAdmission {
    fn drop(&mut self) {
        if let Ok(mut flags) = self.app.state::<ProviderCancellationManager>().flags.lock() {
            if flags
                .get(&self.session_id)
                .is_some_and(|c| Arc::ptr_eq(c, &self.control))
            {
                flags.remove(&self.session_id);
            }
        }
    }
}
#[tauri::command]
pub async fn route_efficiency_phase(
    app: tauri::AppHandle,
    session_id: String,
    phase: String,
    escalate: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _route_lock = ROUTE_LOCK.lock().map_err(to_string)?;
        let _admission = PhaseAdmission::acquire(&app,&session_id)?;
        let cfg = load_config_blocking()?;
        if !cfg.efficiency.enabled {return Err("Efficiency is disabled".into());}
        let store = open_store()?; let session = parse_uuid(&session_id)?;
        let current = store.get_session(session).map_err(to_string)?.ok_or("Unknown chat")?;
        let events = events(&store,session).map_err(to_string)?;
        let task = checkpoint(&store,session,&current.workspace_path.to_string_lossy(),0).map_err(to_string)?;
        let already = events.iter().any(|e|e.payload["kind"] == "efficiency-phase-route" && e.payload["taskId"] == json!(task.task_id) && e.payload["escalated"] == true);
        let route = cfg.efficiency.routing.select(&phase,false,escalate,already).ok_or("No configured route or the escalation was already used")?;
        let provider = cfg.model_providers.iter().find(|p|p.id==route.provider && p.enabled).ok_or("Routing target provider is not enabled")?;
        let configured_model = model_catalog::catalog_model_profile(&provider.id,Some(&route.model)).is_some() || provider.model_ids.contains(&route.model);
        if !configured_model {return Err("Routing target model is not configured".into());}
        if let Some(effort)=current.reasoning_effort.as_deref() {if !model_catalog::catalog_reasoning_efforts(&provider.id,Some(&route.model)).is_some_and(|efforts|efforts.iter().any(|e|e==effort)) {return Err("Choose an effort supported by the target model before routing".into());}}
        task.validate().map_err(to_string)?;
        store.append_event(session,SessionEventKind::TaskCheckpoint,"Phase handoff checkpoint",serde_json::to_value(task.clone()).map_err(to_string)?).map_err(to_string)?;
        if current.provider_id.as_deref()!=Some(route.provider.as_str()) || current.model_id.as_deref()!=Some(route.model.as_str()) {store.clear_provider_session_binding(session,&route.provider).map_err(to_string)?;}
        store.update_session_model(session,Some(route.provider.clone()),None,Some(route.model.clone()),None,current.reasoning_effort.clone()).map_err(to_string)?;
        store.append_event(session,SessionEventKind::SystemEvent,"Model changed for the selected task phase",json!({"kind":"efficiency-phase-route","taskId":task.task_id,"phase":phase,"provider":route.provider,"model":route.model,"escalated":escalate})).map_err(to_string)?;
        Ok(())
    }).await.map_err(to_string)?
}
pub(super) fn profile(request: &ProviderChatRequest) -> ProviderChatRequest {
    let mut next = request.clone();
    let cfg = config();
    if !cfg.enabled || next.reasoning_effort.is_some() {
        return next;
    }
    let efforts =
        model_catalog::catalog_reasoning_efforts(&next.provider_id, next.model_id.as_deref())
            .unwrap_or_default();
    let references = efforts.iter().map(String::as_str).collect::<Vec<_>>();
    next.reasoning_effort = cfg.profile.effort(None, &references).map(str::to_owned);
    next
}
fn events(store: &SessionStore, session: Uuid) -> anyhow::Result<Vec<SessionEvent>> {
    let mut events = store.read_efficiency_context_events(session)?;
    let recent = store.read_events(session)?;
    let ids = events.iter().map(|e| e.id).collect::<HashSet<_>>();
    events.extend(
        recent
            .into_iter()
            .filter(|e| !ids.contains(&e.id) && e.kind != SessionEventKind::TaskCheckpoint),
    );
    events.sort_by_key(|e| e.created_at);
    Ok(events)
}
pub(super) fn checkpoint(
    store: &SessionStore,
    session: Uuid,
    workspace: &str,
    revision: u64,
) -> anyhow::Result<TaskCheckpoint> {
    Ok(TaskCheckpoint::derive(
        session,
        &events(store, session)?,
        workspace,
        revision,
    ))
}
pub(super) fn save_checkpoint(
    app: &tauri::AppHandle,
    store: &SessionStore,
    request: &ProviderChatRequest,
) -> anyhow::Result<()> {
    if !config().policies() || !config().task_state {
        return Ok(());
    }
    let _measure = timing::EfficiencyTimer::start(timing::EfficiencyComponent::Checkpoint);
    let session = parse_uuid(&request.session_id).map_err(anyhow::Error::msg)?;
    let mut current = checkpoint(
        store,
        session,
        request.workspace_path.as_deref().unwrap_or(""),
        request.workspace_context.as_ref().map_or(0, |c| c.revision),
    )?;
    if let Some(control) = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .and_then(|flags| flags.get(&request.session_id).cloned())
    {
        if let Some(pending) = control
            .efficiency_checkpoint
            .lock()
            .ok()
            .and_then(|c| c.clone())
        {
            if pending.task_id == current.task_id {
                current.progress_notice = pending.progress_notice;
                current.files = pending.files;
                current.verification = pending.verification;
                current.repository_signals = pending.repository_signals;
                current.agent_assertions = pending.agent_assertions;
            }
        }
    }
    if request.plan.is_some() {
        current.plan = request.plan.clone();
    }
    current.validate()?;
    store.append_event_with_turn_id(
        session,
        SessionEventKind::TaskCheckpoint,
        "Task checkpoint saved",
        serde_json::to_value(&current)?,
        request
            .turn_id
            .as_deref()
            .and_then(|s| Uuid::parse_str(s).ok()),
    )?;
    Ok(())
}
pub(super) fn capability_schema(id: CapabilityId) -> Option<Value> {
    match id {
        CapabilityId::TaskCheckpoint => Some(
            json!({"type":"object","additionalProperties":false,"properties":{"section":{"type":"string","enum":["checkpoint","history"],"default":"checkpoint"},"beforeEventId":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":100},"notes":{"type":"object","additionalProperties":false,"properties":{"decisions":{"type":"array","maxItems":32,"items":{"type":"string","maxLength":2000}},"attemptedApproaches":{"type":"array","maxItems":32,"items":{"type":"string","maxLength":2000}},"constraints":{"type":"array","maxItems":32,"items":{"type":"string","maxLength":2000}},"acceptanceCriteria":{"type":"array","maxItems":32,"items":{"type":"string","maxLength":2000}},"unresolvedQuestions":{"type":"array","maxItems":32,"items":{"type":"string","maxLength":2000}}}},"offset":capability_output_budget::offset_schema(),"maxBytes":workspace_result_bytes_schema()}}),
        ),
        CapabilityId::WorkspaceOutline => Some(
            json!({"type":"object","additionalProperties":false,"properties":{"path":{"type":"string"},"depth":{"type":"integer","minimum":1,"maximum":8},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":100},"signals":{"type":"array","maxItems":100,"items":{"type":"object","properties":{"path":{"type":"string"},"explicit":{"type":"boolean"},"searchMatches":{"type":"integer","minimum":0},"symbolMatches":{"type":"integer","minimum":0},"referenced":{"type":"boolean"},"test":{"type":"boolean"},"changed":{"type":"boolean"}}}},"maxBytes":workspace_result_bytes_schema()}}),
        ),
        _ => None,
    }
}
pub(super) fn execute(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    request: &CapabilityRequest,
) -> anyhow::Result<(String, Value, Option<CapabilityResourceRef>)> {
    anyhow::ensure!(config().policies(),"Task-state and retrieval policies are experimental; enable Efficiency experiments in Usage settings");
    let _measure =
        timing::EfficiencyTimer::start(if request.capability_id == CapabilityId::TaskCheckpoint {
            timing::EfficiencyComponent::Checkpoint
        } else {
            timing::EfficiencyComponent::Retrieval
        });
    let session = Uuid::parse_str(&bound.session_id)?;
    if request.capability_id == CapabilityId::TaskCheckpoint {
        anyhow::ensure!(config().task_state, "Task-state policy is disabled");
        let store = open_store().map_err(anyhow::Error::msg)?;
        if request.arguments["section"] == "history" {
            let limit = capability_output_budget::page_limit(&request.arguments, 20, 100)?;
            let (history, more) = if let Some(before) = request.arguments["beforeEventId"].as_str()
            {
                let page = store.read_events_before(session, Uuid::parse_str(before)?, limit)?;
                (page.events, page.has_more_before)
            } else {
                let events = store.read_events(session)?;
                let start = events.len().saturating_sub(limit);
                (events[start..].to_vec(), start > 0)
            };
            let before = history.first().map(|e| e.id);
            let data = capability_output_budget::array_page(
                json!({"events":history,"hasMoreBefore":more,"beforeEventId":before}),
                "events",
                &request.arguments,
                20,
                100,
            )?;
            return Ok(("Read exact retained chat evidence".into(), data, None));
        }
        let mut record = checkpoint(
            &store,
            session,
            &bound.workspace_key,
            bound.workspace_context.revision,
        )?;
        if let Some(control) = app
            .state::<ProviderCancellationManager>()
            .flags
            .lock()
            .ok()
            .and_then(|f| f.get(&bound.session_id).cloned())
        {
            if let Some(pending) = control
                .efficiency_checkpoint
                .lock()
                .ok()
                .and_then(|c| c.clone())
            {
                if pending.task_id == record.task_id {
                    record.files = pending.files;
                    record.verification = pending.verification;
                    record.repository_signals = pending.repository_signals;
                    record.agent_assertions = pending.agent_assertions;
                }
            }
        }
        if let Some(notes) = request.arguments.get("notes") {
            let notes: AgentNotes = serde_json::from_value(notes.clone())?;
            notes.validate()?;
            record.unresolved_questions = notes.unresolved_questions.clone();
            record.agent_assertions = notes;
            record.validate()?;
            if let Some(control) = app
                .state::<ProviderCancellationManager>()
                .flags
                .lock()
                .ok()
                .and_then(|f| f.get(&bound.session_id).cloned())
            {
                if let Ok(mut pending) = control.efficiency_checkpoint.lock() {
                    *pending = Some(record.clone());
                }
            }

            store.append_event_with_turn_id(
                session,
                SessionEventKind::TaskCheckpoint,
                "Task checkpoint updated",
                serde_json::to_value(&record)?,
                request
                    .context
                    .turn_id
                    .as_deref()
                    .and_then(|s| Uuid::parse_str(s).ok()),
            )?;
        }
        revalidate_outputs(app, bound, &mut record);
        let data = capability_output_budget::text_result(
            json!({"taskId":record.task_id,"verified":record.verified,"revision":record.revision,"details":record.handoff()}),
            &[capability_output_budget::TextField {
                pointer: "/details",
                window: "detailsWindow",
                offset: "offset",
                tail: false,
            }],
            &request.arguments,
        )?;
        return Ok((
            "Read task state; agent assertions remain unverified".into(),
            data,
            None,
        ));
    }
    anyhow::ensure!(
        config().repository_retrieval,
        "Repository retrieval policy is disabled"
    );
    let mut list_args = request.arguments.clone();
    list_args["limit"] = json!(200);
    let (_, listing, _) = workspace_capability_list::execute(&bound.workspace, &list_args)?;
    let mut signals = request
        .arguments
        .get("signals")
        .cloned()
        .map(serde_json::from_value::<Vec<gyro_core::efficiency::retrieval::Candidate>>)
        .transpose()?
        .unwrap_or_default();
    anyhow::ensure!(signals.len() <= 100, "At most 100 relevance signals");
    if let Ok(store) = open_store() {
        if let Ok(record) = checkpoint(
            &store,
            session,
            &bound.workspace_key,
            bound.workspace_context.revision,
        ) {
            signals.extend(record.repository_signals);
        }
    }

    if let Some(control) = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .and_then(|f| f.get(&bound.session_id).cloned())
    {
        if let Some(pending) = control
            .efficiency_checkpoint
            .lock()
            .ok()
            .and_then(|p| p.clone())
        {
            signals.extend(pending.repository_signals);
        }
    }
    signals.retain(|signal| signal.root_id.is_empty() || signal.root_id == bound.workspace_key);
    let mut candidates = Vec::new();
    for entry in listing["entries"].as_array().into_iter().flatten() {
        if let Some(path) = entry["path"].as_str() {
            if gyro_core::capability_path_is_sensitive(path) {
                continue;
            }
            let mut candidate = signals
                .iter()
                .find(|s| s.path == path)
                .cloned()
                .unwrap_or_default();
            candidate.path = path.into();
            candidate.test |= path.contains("test") || path.contains("spec");
            candidates.push(candidate);
        }
    }
    for signal in &signals {
        if signal.explicit
            && !candidates.iter().any(|c| c.path == signal.path)
            && !gyro_core::capability_path_is_sensitive(&signal.path)
            && gyro_core::security::assert_path_inside_workspace(
                &bound.workspace,
                Path::new(&signal.path),
            )
            .is_ok()
        {
            candidates.push(signal.clone());
        }
    }
    let limit = request.arguments["limit"].as_u64().unwrap_or(50).min(100) as usize;
    let ranked = gyro_core::efficiency::retrieval::rank(candidates, limit);
    Ok((
        "Read ranked repository outline; expand with search and code navigation".into(),
        json!({"workspace":bound.workspace_key,"revision":bound.workspace_context.revision,"entries":ranked,"nextOffset":listing["nextOffset"],"sourceHasMore":listing["hasMore"],"signalSource":"agent assertions","expandTools":["gyro_workspace_search","gyro_code_definition","gyro_code_references","gyro_code_symbols"]}),
        None,
    ))
}
fn revalidate_outputs(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    record: &mut TaskCheckpoint,
) {
    let latest = app
        .state::<CapabilityIdeEvidenceManager>()
        .by_workspace
        .lock()
        .ok()
        .and_then(|contexts| contexts.get(&bound.workspace_key).cloned())
        .unwrap_or_else(|| bound.workspace_context.clone());
    for file in &mut record.files {
        if file.root_id != bound.workspace_key {
            file.availability = "other root; revalidate with rootId".into();
            continue;
        }
        let disk = gyro_core::security::assert_path_inside_workspace(
            &bound.workspace,
            Path::new(&file.path),
        )
        .ok()
        .and_then(|path| {
            let metadata = fs::metadata(&path).ok()?;
            if metadata.len() > MAX_WORKSPACE_FILE_EDIT_BYTES as u64 {
                return None;
            }
            fs::read(path).ok().map(|bytes| content_hash(&bytes))
        });
        let buffer = latest
            .buffers
            .iter()
            .find(|buffer| buffer["path"] == file.path);
        let content = if file.dirty {
            buffer
                .and_then(|b| b["content"].as_str())
                .map(|text| content_hash(text.as_bytes()))
        } else {
            disk.clone()
        };
        let dirty = buffer.and_then(|b| b["dirty"].as_bool()).unwrap_or(false);
        file.availability = if gyro_core::efficiency::retrieval::fresh(
            file,
            &bound.workspace_key,
            latest.revision,
            content.as_deref(),
            disk.as_deref(),
            dirty,
        ) {
            "current"
        } else {
            "stale or unavailable; reread the file"
        }
        .into();
    }

    for evidence in &mut record.verification {
        evidence.availability = if evidence.output_id.as_deref().is_some_and(|id| {
            app.state::<CapabilityIdeEvidenceManager>()
                .task_outputs
                .get(&bound.workspace_key, Some(&bound.session_id), id)
                .is_some()
        }) {
            if evidence.source_truncated {
                "source-truncated"
            } else {
                "retained"
            }
        } else {
            "expired; rerun the relevant check"
        }
        .into();
    }
}
fn collect_signals(
    value: &Value,
    id: CapabilityId,
    root_id: &str,
    signals: &mut Vec<gyro_core::efficiency::retrieval::Candidate>,
) {
    if let Some(path) = value.get("path").and_then(Value::as_str) {
        if gyro_core::normalize_capability_relative_path(path).is_ok()
            && !gyro_core::capability_path_is_sensitive(path)
        {
            let signal = gyro_core::efficiency::retrieval::Candidate {
                path: path.into(),
                root_id: root_id.into(),
                search_matches: if id == CapabilityId::WorkspaceSearch {
                    1
                } else {
                    0
                },
                symbol_matches: if id == CapabilityId::CodeSymbols {
                    1
                } else {
                    0
                },
                changed: id == CapabilityId::WorkspaceGitStatus,
                referenced: matches!(
                    id,
                    CapabilityId::CodeDefinition | CapabilityId::CodeReferences
                ),
                ..Default::default()
            };
            signals.push(signal);
        }
    }
    if let Some(a) = value.as_array() {
        for v in a {
            collect_signals(v, id, root_id, signals);
        }
    }
    if let Some(o) = value.as_object() {
        for v in o.values().filter(|v| v.is_array() || v.is_object()) {
            collect_signals(v, id, root_id, signals);
        }
    }
    if signals.len() > 100 {
        signals.drain(..signals.len() - 100);
    }
}

pub(super) fn observe(
    app: &tauri::AppHandle,
    request: &CapabilityRequest,
    response: &mut CapabilityResponse,
) {
    let cfg = config();
    if !cfg.policies() || response.result.is_none() {
        return;
    }
    let Ok(bound) = active_provider_capability_context(app, &request.context.session_id) else {
        return;
    };
    let pending_control = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .and_then(|f| f.get(&bound.session_id).cloned());
    if cfg.task_state || cfg.repository_retrieval {
        let _measure = timing::EfficiencyTimer::start(timing::EfficiencyComponent::Checkpoint);
        if let Some(result) = response.result.as_ref() {
            if let Ok(store) = open_store() {
                if let Ok(session) = Uuid::parse_str(&bound.session_id) {
                    if let Ok(mut record) = checkpoint(
                        &store,
                        session,
                        &bound.workspace_key,
                        bound.workspace_context.revision,
                    ) {
                        if let Some(pending) = pending_control.as_ref().and_then(|c| {
                            c.efficiency_checkpoint.lock().ok().and_then(|p| p.clone())
                        }) {
                            if pending.task_id == record.task_id {
                                record = pending;
                            }
                        }
                        let signals_changed = matches!(
                            request.capability_id,
                            CapabilityId::WorkspaceSearch
                                | CapabilityId::CodeDefinition
                                | CapabilityId::CodeReferences
                                | CapabilityId::CodeSymbols
                                | CapabilityId::WorkspaceGitStatus
                        );
                        if signals_changed {
                            collect_signals(
                                &result.data,
                                request.capability_id,
                                &bound.workspace_key,
                                &mut record.repository_signals,
                            );
                        }
                        if let Some(path) = result.data["path"].as_str() {
                            if let Some(hash) = result.data["contentHash"].as_str() {
                                record
                                    .files
                                    .retain(|f| f.path != path || f.root_id != bound.workspace_key);
                                record.files.push(FileEvidence {
                                    availability: "revalidate".into(),
                                    path: path.into(),
                                    root_id: bound.workspace_key.clone(),
                                    content_hash: Some(hash.into()),
                                    disk_hash: result.data["diskHash"].as_str().map(str::to_owned),
                                    dirty: result.data["dirty"].as_bool().unwrap_or(false),
                                    revision: bound.workspace_context.revision,
                                });
                                if record.files.len() > 64 {
                                    record.files.remove(0);
                                }
                            }
                        }
                        if matches!(
                            request.capability_id,
                            CapabilityId::WorkspaceRunTask | CapabilityId::WorkspaceRunTest
                        ) {
                            record.verification.push(gyro_core::efficiency::checkpoint::VerificationEvidence{event_id:request.context.call_id,output_id:result.data["id"].as_str().map(str::to_owned),outcome:json!({"status":result.data["status"],"exitCode":result.data["exitCode"],"evidence":result.data["evidenceSummary"]}),source_truncated:result.data["sourceTruncated"].as_bool().unwrap_or(false),availability:"revalidate".into()});
                            if record.verification.len() > 16 {
                                record.verification.remove(0);
                            }
                        }
                        if (signals_changed
                            || result.data.get("contentHash").is_some()
                            || matches!(
                                request.capability_id,
                                CapabilityId::WorkspaceRunTask | CapabilityId::WorkspaceRunTest
                            ))
                            && record.validate().is_ok()
                        {
                            if let Some(control) = pending_control.as_ref() {
                                if let Ok(mut pending) = control.efficiency_checkpoint.lock() {
                                    *pending = Some(record);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    if !cfg.progress_detection {
        return;
    }
    let _measure = timing::EfficiencyTimer::start(timing::EfficiencyComponent::Progress);
    let control = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .and_then(|f| f.get(&bound.session_id).cloned());
    let Some(control) = control else {
        return;
    };
    let outcome = response
        .result
        .as_ref()
        .map(|r| r.data.clone())
        .unwrap_or_else(|| json!({"error":response.error}));
    let state = json!({"workspace":bound.workspace_key,"rootRevision":bound.workspace_identity_revision,"revision":bound.workspace_context.revision});
    let mut outcome = outcome;
    if let Some(object) = outcome.as_object_mut() {
        for field in ["id", "finishedAt", "capturedAt", "owner", "contextRevision"] {
            object.remove(field);
        }
    }
    let decision = control
        .efficiency_progress
        .lock()
        .ok()
        .map(|mut d| {
            d.observe(
                request.capability_id.as_str(),
                &request.arguments,
                &state,
                &outcome,
            )
        })
        .unwrap_or(Decision::Continue);
    if decision != Decision::Continue {
        if let Ok(store) = open_store() {
            if let Ok(session) = Uuid::parse_str(&bound.session_id) {
                if let Ok(mut record) = checkpoint(
                    &store,
                    session,
                    &bound.workspace_key,
                    bound.workspace_context.revision,
                ) {
                    record.progress_notice = Some(
                        json!({"capability":request.capability_id,"lastCallId":request.context.call_id,"repeatCount":if decision==Decision::Correct{3}else{6},"observedAt":chrono::Utc::now(),"contextRevision":bound.workspace_context.revision,"action":if decision==Decision::Correct{"change-approach"}else{"pause-and-review"}}),
                    );
                    if let Ok(mut pending) = control.efficiency_checkpoint.lock() {
                        if let Some(old) = pending.as_mut() {
                            old.progress_notice = record.progress_notice.clone();
                        } else {
                            *pending = Some(record.clone());
                        }
                    }
                    if record.validate().is_ok() {
                        let _ = store.append_event_with_turn_id(
                            session,
                            SessionEventKind::TaskCheckpoint,
                            "Repeated-work checkpoint",
                            serde_json::to_value(record).unwrap_or(Value::Null),
                            request
                                .context
                                .turn_id
                                .as_deref()
                                .and_then(|s| Uuid::parse_str(s).ok()),
                        );
                    }
                }
            }
        }
        let message = if decision == Decision::Correct {
            "Three identical calls returned unchanged evidence. Save a checkpoint and choose a different approach; required verification still applies."
        } else {
            "Six identical calls returned unchanged evidence. Gyro paused this turn. Review the checkpoint and resume with a changed approach."
        };
        if let Some(result) = response.result.as_mut() {
            result.data["progressNotice"] = json!(message);
        }
        if let Ok(request) = control.request.lock() {
            if let Some(request) = request.as_ref() {
                let activity = ProviderActivity {
                    id: format!("efficiency-progress-{}", Uuid::new_v4()),
                    kind: "context".into(),
                    label: if decision == Decision::Pause {
                        "Paused repeated work"
                    } else {
                        "Repeated work detected"
                    }
                    .into(),
                    detail: Some(message.into()),
                    file_counts: None,
                    note: None,
                    status: "done".into(),
                };
                emit_provider_activity_event(app, request, &activity, None);
                if let Ok(store) = open_store() {
                    let _ = save_checkpoint(app, &store, request);
                }
            }
        }
        if decision == Decision::Pause {
            stop_provider_run(app, &bound.session_id, ProviderStopReason::NoProgress);
        }
    }
}
