use super::*;

pub(super) fn start_automation_scheduler(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let paths = match GyroPaths::for_current_user() {
            Ok(paths) => paths,
            Err(error) => {
                eprintln!("could not resolve automation scheduler paths: {error}");
                return;
            }
        };
        let lease_owner = format!("desktop-{}-{}", std::process::id(), Uuid::new_v4());
        let mut observed_generation = app.state::<AutomationSchedulerControl>().generation();
        let mut clock = AutomationSchedulerClock::new(chrono::Utc::now());
        let (completed_tx, completed_rx) = mpsc::channel::<Uuid>();
        let mut running_workspaces: HashMap<Uuid, PathBuf> = HashMap::new();

        loop {
            while let Ok(automation_id) = completed_rx.try_recv() {
                running_workspaces.remove(&automation_id);
            }
            let now = clock.now();
            // Do not recover an in-process worker whose lease heartbeat is
            // momentarily late. Expired leases from earlier processes are
            // reconciled whenever the local worker set is empty.
            if running_workspaces.is_empty() {
                if let Err(error) =
                    recover_automation_scheduler_leases_with(&paths, now, |automation| {
                        emit_automation_update(&app, automation);
                        notify_automation_outcome(&app, automation);
                    })
                {
                    eprintln!("could not recover automation leases: {error}");
                }
            }
            if running_workspaces.len() < MAX_CONCURRENT_SCHEDULED_RUNS {
                let due = AutomationStore::open(paths.clone())
                    .and_then(|store| store.list_due_automations(now));
                match due {
                    Ok(due) => {
                        for (automation, workspace) in
                            automation_dispatch_candidates(&paths, due, &running_workspaces)
                        {
                            let admission =
                                match AutomationRunAdmission::reserve(&app, automation.id) {
                                    Ok(Some(admission)) => admission,
                                    Ok(None) => break,
                                    Err(error) => {
                                        eprintln!("automation provider admission failed: {error}");
                                        break;
                                    }
                                };
                            let worker_app = app.clone();
                            let worker_paths = paths.clone();
                            let worker_owner = lease_owner.clone();
                            let worker_now = now;
                            let worker_tx = completed_tx.clone();
                            let automation_id = automation.id;
                            running_workspaces.insert(automation_id, workspace);
                            let spawned = std::thread::Builder::new()
                                .name(format!("gyro-automation-{automation_id}"))
                                .spawn(move || {
                                    let result = std::panic::catch_unwind(
                                        std::panic::AssertUnwindSafe(|| {
                                            run_automation_scheduler_id_at_with(
                                                &worker_paths,
                                                automation_id,
                                                &worker_owner,
                                                worker_now,
                                                |claimed| {
                                                    emit_automation_update(&worker_app, claimed);
                                                    execute_claimed_automation(
                                                        &worker_app,
                                                        &worker_paths,
                                                        claimed,
                                                        &admission,
                                                    )
                                                },
                                            )
                                        }),
                                    );
                                    match result {
                                        Ok(Ok(Some(updated))) => {
                                            emit_automation_update(&worker_app, &updated);
                                            notify_automation_outcome(&worker_app, &updated);
                                        }
                                        Ok(Ok(None)) => {}
                                        Ok(Err(error)) => {
                                            eprintln!(
                                                "automation scheduler iteration failed: {error}"
                                            )
                                        }
                                        Err(_) => eprintln!("automation scheduler worker panicked"),
                                    }
                                    drop(admission);
                                    let _ = worker_tx.send(automation_id);
                                    worker_app.state::<AutomationSchedulerControl>().wake();
                                });
                            if let Err(error) = spawned {
                                running_workspaces.remove(&automation_id);
                                eprintln!("could not start automation worker: {error}");
                            }
                        }
                    }
                    Err(error) => eprintln!("could not list due automations: {error}"),
                }
            }
            observed_generation = app
                .state::<AutomationSchedulerControl>()
                .wait_for_change(observed_generation, AUTOMATION_SCHEDULER_POLL_INTERVAL);
        }
    });
}

fn automation_scheduler_workspace_key(paths: &GyroPaths, automation: &Automation) -> PathBuf {
    let path = if automation.workspace_mode == SessionWorkspaceMode::Worktree {
        automation
            .worktree_name
            .as_ref()
            .map(|name| paths.worktrees_dir.join(name))
    } else {
        automation
            .execution
            .workspace_path
            .as_ref()
            .map(PathBuf::from)
    };
    path.map(|path| path.canonicalize().unwrap_or(path))
        .unwrap_or_else(|| PathBuf::from(format!("missing-automation-{}", automation.id)))
}

pub(super) fn automation_dispatch_candidates(
    paths: &GyroPaths,
    due: Vec<Automation>,
    running_workspaces: &HashMap<Uuid, PathBuf>,
) -> Vec<(Automation, PathBuf)> {
    let mut occupied = running_workspaces.values().cloned().collect::<HashSet<_>>();
    let available = MAX_CONCURRENT_SCHEDULED_RUNS.saturating_sub(running_workspaces.len());
    due.into_iter()
        // Expired leases from another process are recovered only after local
        // workers finish, so their old run receipt stays intact until then.
        .filter(|automation| automation.lease_owner.is_none())
        .filter_map(|automation| {
            let workspace = automation_scheduler_workspace_key(paths, &automation);
            occupied
                .insert(workspace.clone())
                .then_some((automation, workspace))
        })
        .take(available)
        .collect()
}

pub(super) fn recover_automation_scheduler_leases_with<F>(
    paths: &GyroPaths,
    now: chrono::DateTime<chrono::Utc>,
    mut on_recovered: F,
) -> Result<usize, String>
where
    F: FnMut(&Automation),
{
    let store = AutomationStore::open(paths.clone()).map_err(to_string)?;
    let expired_ids = store
        .list_automations()
        .map_err(to_string)?
        .into_iter()
        .filter(|automation| {
            automation
                .lease_expires_at
                .is_some_and(|expires_at| expires_at <= now)
        })
        .map(|automation| automation.id)
        .collect::<Vec<_>>();
    if expired_ids.is_empty() {
        return Ok(0);
    }

    let recovered = store
        .recover_expired_automation_leases(now)
        .map_err(to_string)?;
    for automation_id in expired_ids {
        let Some(automation) = store.get_automation(automation_id).map_err(to_string)? else {
            continue;
        };
        // Lease ownership cleared by recovery is enough signal; exact timestamp
        // equality with the recovery clock is fragile under store rounding.
        if automation.lease_owner.is_none() {
            on_recovered(&automation);
        }
    }
    Ok(recovered)
}
#[cfg(test)]
pub(super) fn run_automation_scheduler_once_with<F>(
    paths: &GyroPaths,
    lease_owner: &str,
    execute: F,
) -> Result<Option<Automation>, String>
where
    F: FnOnce(&Automation) -> Result<String, String>,
{
    run_automation_scheduler_once_at_with(paths, lease_owner, chrono::Utc::now(), execute)
}

#[cfg(test)]
pub(super) fn run_automation_scheduler_once_at_with<F>(
    paths: &GyroPaths,
    lease_owner: &str,
    now: chrono::DateTime<chrono::Utc>,
    execute: F,
) -> Result<Option<Automation>, String>
where
    F: FnOnce(&Automation) -> Result<String, String>,
{
    run_automation_scheduler_once_at_with_heartbeat_interval(
        paths,
        None,
        lease_owner,
        now,
        AUTOMATION_LEASE_HEARTBEAT_INTERVAL,
        execute,
    )
}

#[cfg(test)]
pub(super) fn run_automation_scheduler_once_with_heartbeat_interval<F>(
    paths: &GyroPaths,
    lease_owner: &str,
    heartbeat_interval: Duration,
    execute: F,
) -> Result<Option<Automation>, String>
where
    F: FnOnce(&Automation) -> Result<String, String>,
{
    run_automation_scheduler_once_at_with_heartbeat_interval(
        paths,
        None,
        lease_owner,
        chrono::Utc::now(),
        heartbeat_interval,
        execute,
    )
}

fn run_automation_scheduler_id_at_with<F>(
    paths: &GyroPaths,
    automation_id: Uuid,
    lease_owner: &str,
    now: chrono::DateTime<chrono::Utc>,
    execute: F,
) -> Result<Option<Automation>, String>
where
    F: FnOnce(&Automation) -> Result<String, String>,
{
    run_automation_scheduler_once_at_with_heartbeat_interval(
        paths,
        Some(automation_id),
        lease_owner,
        now,
        AUTOMATION_LEASE_HEARTBEAT_INTERVAL,
        execute,
    )
}

fn run_automation_scheduler_once_at_with_heartbeat_interval<F>(
    paths: &GyroPaths,
    selected_id: Option<Uuid>,
    lease_owner: &str,
    now: chrono::DateTime<chrono::Utc>,
    heartbeat_interval: Duration,
    execute: F,
) -> Result<Option<Automation>, String>
where
    F: FnOnce(&Automation) -> Result<String, String>,
{
    let store = AutomationStore::open(paths.clone()).map_err(to_string)?;
    let claim = match selected_id {
        Some(automation_id) => store.claim_due_automation_id_at(
            automation_id,
            lease_owner,
            AUTOMATION_LEASE_SECONDS,
            now,
        ),
        None => store.claim_due_automation_at(lease_owner, AUTOMATION_LEASE_SECONDS, now),
    };
    let Some(claimed) = claim.map_err(to_string)? else {
        return Ok(None);
    };

    let heartbeat = AutomationLeaseHeartbeat::start(
        paths.clone(),
        claimed.id,
        lease_owner.to_string(),
        AUTOMATION_LEASE_SECONDS,
        heartbeat_interval,
    );
    let execution_result =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| execute(&claimed)))
            .unwrap_or_else(|_| {
                Err("automation execution panicked and was safely contained".into())
            });
    drop(heartbeat);

    let (status, summary, pause_for_configuration, stop_condition_met) = match execution_result {
        Ok(summary) => match parse_automation_execution_outcome(&claimed, &summary) {
            Ok(outcome) => (
                AutomationRunStatus::Passed,
                outcome.summary,
                false,
                outcome.stop_condition_met,
            ),
            Err(error) => (AutomationRunStatus::Failed, error, false, None),
        },
        Err(error) if error.contains("chat cancelled") => (
            AutomationRunStatus::Stopped,
            "Automation stopped before completion".into(),
            false,
            None,
        ),
        Err(error) => {
            let error = gyro_core::security::redact_secrets(&error);
            let pause = error.starts_with("configuration:");
            (AutomationRunStatus::Failed, error, pause, None)
        }
    };
    let updated = store
        .finish_automation_lease_with_stop_condition(
            claimed.id,
            lease_owner,
            status,
            bounded_automation_summary(&summary),
            stop_condition_met,
        )
        .map_err(to_string)?
        .ok_or_else(|| "claimed automation disappeared before completion".to_string())?;
    if pause_for_configuration {
        return store
            .set_automation_status(updated.id, AutomationStatus::Paused)
            .map_err(to_string);
    }
    Ok(Some(updated))
}

fn execute_claimed_automation(
    app: &tauri::AppHandle,
    paths: &GyroPaths,
    automation: &Automation,
    admission: &AutomationRunAdmission,
) -> Result<String, String> {
    let workspace_path = resolve_automation_workspace(paths, automation)?;
    let provider_id = automation
        .execution
        .provider_id
        .clone()
        .unwrap_or_else(|| provider_id_for_automation_label(&automation.provider).into());
    if provider_adapter_for(&provider_id).kind == ProviderAdapterKind::ReadinessOnly {
        return Err(format!(
            "configuration: {} cannot execute automation runs",
            automation.provider
        ));
    }
    let provider_label = automation
        .execution
        .provider_label
        .clone()
        .or_else(|| Some(automation.provider.clone()));
    let store = open_store()?;
    let session = store
        .create_session_with_context(
            &workspace_path,
            SessionOrigin::Desktop,
            format!("Automation: {}", automation.title),
            CreateSessionContext {
                workspace_mode: automation.workspace_mode.clone(),
                branch: automation.branch.clone(),
                worktree_name: automation.worktree_name.clone(),
                provider_id: Some(provider_id.clone()),
                provider_label: provider_label.clone(),
                model_id: automation.execution.model_id.clone(),
                model_label: automation.execution.model_label.clone(),
                reasoning_effort: automation.execution.reasoning_effort.clone(),
            },
        )
        .map_err(to_string)?;
    let linked = open_automation_store()?
        .link_run_session(
            automation.id,
            automation
                .lease_owner
                .as_deref()
                .ok_or("automation has no lease")?,
            session.id,
        )
        .map_err(to_string)?;
    emit_automation_update(app, &linked);
    let message = automation_provider_prompt(automation);
    let user_event = store
        .append_user_turn_message(
            session.id,
            message.clone(),
            serde_json::json!({
                "surface": "automation",
                "automationId": automation.id,
                "schedule": automation.schedule,
            }),
        )
        .map_err(to_string)?;
    let session_id = session.id.to_string();
    admission.transfer_to_session(&session_id)?;
    let _active_run = ActiveAutomationSession::new(app.clone(), automation.id, session_id.clone());

    let request = ProviderChatRequest {
        session_id: session_id.clone(),
        message,
        turn_id: user_event.turn_id.map(|id| id.to_string()),
        provider_id,
        provider_label,
        model_id: automation.execution.model_id.clone(),
        model_label: automation.execution.model_label.clone(),
        reasoning_effort: automation.execution.reasoning_effort.clone(),
        require_command_approval: true,
        require_file_edit_approval: true,
        full_access: false,
        suggest_title: false,
        workspace_path: Some(workspace_path.display().to_string()),
        mode: ChatMode::Normal,
        goal: None,
        plan: None,
        attachments: Vec::new(),
        workspace_context: None,
        workspace_check: None,
    };
    // Register cancellation first, then re-read persisted state. A pause between
    // claiming the lease and registering this session must still prevent dispatch.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let latest = open_automation_store()?
            .get_automation(automation.id)
            .map_err(to_string)?
            .ok_or_else(|| "automation no longer exists".to_string())?;
        if latest.status != AutomationStatus::Current
            || latest.lease_owner != automation.lease_owner
        {
            return Err("chat cancelled before automation dispatch".to_string());
        }
        run_provider_chat_blocking(app.clone(), request, UsageOrigin::Automation)
            .map(|response| response.assistant_event.message)
    }))
    .unwrap_or_else(|_| Err("automation execution panicked and was safely contained".into()));
    result
}

struct ActiveAutomationSession {
    app: tauri::AppHandle,
    automation_id: Uuid,
    session_id: String,
}

impl ActiveAutomationSession {
    fn new(app: tauri::AppHandle, automation_id: Uuid, session_id: String) -> Self {
        app.state::<AutomationSchedulerControl>()
            .register(automation_id, session_id.clone());
        Self {
            app,
            automation_id,
            session_id,
        }
    }
}

impl Drop for ActiveAutomationSession {
    fn drop(&mut self) {
        self.app
            .state::<AutomationSchedulerControl>()
            .unregister(self.automation_id);
        if let Ok(mut flags) = self.app.state::<ProviderCancellationManager>().flags.lock() {
            flags.remove(&self.session_id);
        }
    }
}
