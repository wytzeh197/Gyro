//! Claim agent-inbox sessions and run them through the normal provider path.
//!
//! The loopback call already opened the session and returned. This worker is
//! the only place that starts the provider. When the Mac is paired, the same
//! loop pulls relay tasks before it claims local work.

use super::*;
use gyro_core::agent_sessions::{
    agent_session_run_policy, AgentSessionRow, AgentSessionState, AgentSessionStore, ChoiceCatalog,
    ModelChoices, ProviderChoices,
};
use gyro_core::{provider_is_executable_for, GyroConfig};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

const RUNNING_LEASE: Duration = Duration::from_secs(30);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);

pub(super) fn start(app: tauri::AppHandle) {
    let hook_app = app.clone();
    gyro_core::agent_sessions::set_session_stop_hook(std::sync::Arc::new(move |session_id| {
        let _ = stop_provider_run(
            &hook_app,
            &session_id.to_string(),
            ProviderStopReason::User,
        );
    }));
    let spawned = std::thread::Builder::new()
        .name("gyro-agent-sessions".into())
        .spawn(move || {
            loop {
                let exited = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    worker(app.clone())
                }));
                if exited.is_err() {
                    eprintln!("agent session worker panicked; starting it again");
                } else {
                    eprintln!("agent session worker stopped; starting it again");
                }
                std::thread::sleep(Duration::from_secs(1));
            }
        });
    if let Err(error) = spawned {
        eprintln!("could not start the agent session worker: {error}");
    }
}

fn worker(app: tauri::AppHandle) {
    let paths = match GyroPaths::for_current_user() {
        Ok(paths) => paths,
        Err(error) => {
            eprintln!("could not resolve agent session paths: {error}");
            return;
        }
    };
    if let Err(error) = publish_choice_catalog(&paths) {
        eprintln!("could not publish the agent choice catalog: {error}");
    }
    // Listener start is the only place that fails every running row. A claim-loop
    // restart below keeps this listener so a live heartbeat is not treated as a crash.
    let _listener = match gyro_core::agent_sessions::AgentSessionListener::start(&paths) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("could not listen for agent sessions: {error}");
            return;
        }
    };
    loop {
        if !claim_loop_step(|| claim_iteration(&app, &paths)) {
            eprintln!("agent session worker panicked; continuing the claim loop");
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

/// One claim-loop turn. `true` means the turn finished; `false` means it panicked.
fn claim_loop_step(claim: impl FnOnce()) -> bool {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(claim)).is_ok()
}

fn claim_iteration(app: &tauri::AppHandle, paths: &GyroPaths) {
    if let Ok(store) = AgentSessionStore::open(paths.clone()) {
        let cutoff = chrono::Utc::now()
            - chrono::Duration::from_std(RUNNING_LEASE).unwrap_or(chrono::Duration::seconds(30));
        if let Err(error) = store.expire_stale_running(cutoff) {
            eprintln!("could not expire a stale agent session: {error}");
        }
    }
    if let Err(error) = publish_choice_catalog(paths) {
        eprintln!("could not refresh the agent choice catalog: {error}");
    }
    if let Err(error) = gyro_core::agent_sessions::poll_paired_relay(paths) {
        eprintln!("could not poll the agent relay: {error}");
    }
    match AgentSessionStore::open(paths.clone()).and_then(|store| store.claim_next()) {
        Ok(Some(row)) => {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _heartbeat = SessionHeartbeat::start(paths, row.id);
                execute(app, paths, &row);
            }));
            if result.is_err() {
                let _ = AgentSessionStore::open(paths.clone()).and_then(|store| {
                    store.finish(row.id, Err("agent session panicked".into()))
                });
            }
        }
        Ok(None) => {}
        Err(error) => eprintln!("could not claim an agent session: {error}"),
    }
}

struct SessionHeartbeat {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl SessionHeartbeat {
    fn start(paths: &GyroPaths, id: uuid::Uuid) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let beat_stop = stop.clone();
        let beat_paths = paths.clone();
        let thread = std::thread::Builder::new()
            .name("gyro-agent-session-heartbeat".into())
            .spawn(move || {
                while !beat_stop.load(Ordering::Relaxed) {
                    if let Ok(store) = AgentSessionStore::open(beat_paths.clone()) {
                        let _ = store.heartbeat(id);
                    }
                    let slices = HEARTBEAT_INTERVAL.as_millis() / 100;
                    for _ in 0..slices.max(1) {
                        if beat_stop.load(Ordering::Relaxed) {
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                }
            })
            .ok();
        Self { stop, thread }
    }
}

impl Drop for SessionHeartbeat {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn execute(app: &tauri::AppHandle, paths: &GyroPaths, row: &AgentSessionRow) {
    let finish = |outcome: Result<String, String>| {
        if let Ok(store) = AgentSessionStore::open(paths.clone()) {
            if let Some(session_id) = row.session_id {
                let _ = store.clear_command_block_for_session(session_id);
            }
            if let Err(error) = store.finish(row.id, outcome) {
                eprintln!("could not finish agent session {}: {error}", row.id);
            }
        }
    };
    if row.state != AgentSessionState::Running {
        return;
    }
    let Some(session_id) = row.session_id else {
        finish(Err("session was not opened".into()));
        return;
    };
    let config = match GyroConfig::load(paths) {
        Ok(config) => config,
        Err(error) => {
            finish(Err(error.to_string()));
            return;
        }
    };
    let executable = config
        .model_providers
        .iter()
        .find(|provider| provider.id == row.provider_id)
        .is_some_and(provider_is_executable_for);
    if !executable
        || provider_adapter_for(&row.provider_id).kind == ProviderAdapterKind::ReadinessOnly
    {
        finish(Err(format!(
            "provider {} cannot run a session",
            row.provider_id
        )));
        return;
    }
    let policy = agent_session_run_policy();
    let request = ProviderChatRequest {
        session_id: session_id.to_string(),
        message: row.prompt.clone(),
        turn_id: row.turn_id.map(|id| id.to_string()),
        provider_id: row.provider_id.clone(),
        provider_label: Some(row.provider_label.clone()),
        model_id: Some(row.model_id.clone()),
        model_label: Some(row.model_label.clone()),
        reasoning_effort: row.reasoning_effort.clone(),
        require_command_approval: policy.require_command_approval,
        require_file_edit_approval: policy.require_file_edit_approval,
        full_access: policy.full_access,
        suggest_title: false,
        workspace_path: Some(row.workspace_path.display().to_string()),
        mode: ChatMode::Normal,
        goal: None,
        plan: None,
        attachments: Vec::new(),
        workspace_context: None,
        workspace_check: None,
    };
    match run_provider_chat_blocking(app.clone(), request, UsageOrigin::AgentSession) {
        Ok(response) => finish(Ok(response.assistant_event.message)),
        Err(error) => finish(Err(error)),
    }
}

fn publish_choice_catalog(paths: &GyroPaths) -> Result<(), String> {
    let config = GyroConfig::load(paths).map_err(to_string)?;
    let catalog_models = model_catalog::catalog_choice_models();
    let mut providers = Vec::new();
    for provider in config
        .model_providers
        .iter()
        .filter(|provider| provider.enabled && provider_is_executable_for(provider))
    {
        let mut models = Vec::new();
        if !provider.model_ids.is_empty() {
            for model_id in &provider.model_ids {
                models.push(model_choice(&provider.id, model_id));
            }
        } else {
            for (provider_id, model_id, efforts) in &catalog_models {
                if provider_id.eq_ignore_ascii_case(&provider.id) {
                    models.push(ModelChoices {
                        id: model_id.clone(),
                        label: model_id.clone(),
                        efforts: published_efforts(&provider.id, model_id, efforts),
                    });
                }
            }
            // The remote catalog can lag the saved default. Grok 4.7 stays
            // selectable when the catalog still lists only Grok 4.3.
            if let Some(model_id) = provider.default_model_id.as_deref() {
                let present = models
                    .iter()
                    .any(|model| model.id.eq_ignore_ascii_case(model_id));
                if !present {
                    models.push(model_choice(&provider.id, model_id));
                }
            }
        }
        if models.is_empty() {
            continue;
        }
        let default_model = provider
            .default_model_id
            .clone()
            .filter(|model_id| {
                models
                    .iter()
                    .any(|model| model.id.eq_ignore_ascii_case(model_id))
            })
            .or_else(|| models.first().map(|model| model.id.clone()));
        providers.push(ProviderChoices {
            id: provider.id.clone(),
            label: provider.display_name.clone(),
            default_model,
            default_effort: None,
            models,
        });
    }
    let selected_provider_id = config
        .selected_provider_id
        .filter(|provider_id| providers.iter().any(|provider| provider.id == *provider_id));
    let store = AgentSessionStore::open(paths.clone()).map_err(to_string)?;
    store
        .set_choice_catalog(&ChoiceCatalog {
            selected_provider_id,
            providers,
        })
        .map_err(to_string)
}

fn model_choice(provider_id: &str, model_id: &str) -> ModelChoices {
    let catalog =
        model_catalog::catalog_reasoning_efforts(provider_id, Some(model_id)).unwrap_or_default();
    ModelChoices {
        id: model_id.to_string(),
        label: model_id.to_string(),
        efforts: published_efforts(provider_id, model_id, &catalog),
    }
}

/// Catalog efforts win. An xAI model the catalog does not list yet keeps the
/// built-in menu, so a request for Grok 4.7 can still name low through xhigh.
fn published_efforts(provider_id: &str, model_id: &str, catalog_efforts: &[String]) -> Vec<String> {
    if !catalog_efforts.is_empty() {
        return catalog_efforts.to_vec();
    }
    if provider_id.eq_ignore_ascii_case("xai") {
        return gyro_core::grok::bundled_reasoning_efforts(Some(model_id))
            .iter()
            .map(|effort| (*effort).to_string())
            .collect();
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::claim_loop_step;

    #[test]
    fn claim_loop_restarts_after_a_panic() {
        let runs = std::sync::atomic::AtomicUsize::new(0);
        let mut panicked = 0;
        let mut completed = 0;
        for _ in 0..3 {
            let continued = claim_loop_step(|| {
                let n = runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if n == 0 {
                    panic!("claim loop stopped");
                }
            });
            if continued {
                completed += 1;
            } else {
                panicked += 1;
            }
        }
        assert_eq!(panicked, 1);
        assert_eq!(completed, 2);
        assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 3);
    }
}
