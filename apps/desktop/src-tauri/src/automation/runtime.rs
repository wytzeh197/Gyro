//! In-process scheduler state: the wake signal, the run clock, provider-slot
//! admission and the lease heartbeat.

use crate::{
    app::limits::MAX_CONCURRENT_PROVIDER_RUNS,
    state::{managers::ProviderCancellationManager, provider_run::ProviderRunControl},
};
use gyro_core::{AutomationStore, GyroPaths};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager;
use uuid::Uuid;

pub(crate) const AUTOMATION_SCHEDULER_POLL_INTERVAL: Duration = Duration::from_secs(5);

pub(crate) const AUTOMATION_LEASE_SECONDS: i64 = 45 * 60;

pub(crate) const AUTOMATION_LEASE_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Default)]
pub(crate) struct AutomationSchedulerControl {
    pub(crate) state: Mutex<AutomationSchedulerState>,
    pub(crate) wake: Condvar,
}

#[derive(Default)]
pub(crate) struct AutomationSchedulerState {
    pub(crate) generation: u64,
    pub(crate) running_sessions: HashMap<Uuid, String>,
}

pub(crate) struct AutomationLeaseHeartbeat {
    pub(crate) stopped: Arc<AtomicBool>,
    pub(crate) worker: Option<std::thread::JoinHandle<()>>,
}

pub(crate) struct AutomationSchedulerClock {
    pub(crate) last_effective: chrono::DateTime<chrono::Utc>,
    pub(crate) last_sample: Instant,
}

/// A scheduled run owns a provider slot before its lease is claimed. A busy
/// interactive app leaves the automation due instead of recording a false failure.
pub(crate) struct AutomationRunAdmission {
    pub(crate) app: tauri::AppHandle,
    pub(crate) reservation_key: String,
}

impl AutomationRunAdmission {
    pub(crate) fn reserve(
        app: &tauri::AppHandle,
        automation_id: Uuid,
    ) -> Result<Option<Self>, String> {
        let reservation_key = format!("automation-reserved-{automation_id}");
        let manager = app.state::<ProviderCancellationManager>();
        let mut flags = manager
            .flags
            .lock()
            .map_err(|_| "provider cancellation state is unavailable".to_string())?;
        if flags.contains_key(&reservation_key)||flags.len() >= MAX_CONCURRENT_PROVIDER_RUNS {
            return Ok(None);
        }
        flags.insert(
            reservation_key.clone(),
            Arc::new(ProviderRunControl::default()),
        );
        Ok(Some(Self {
            app: app.clone(),
            reservation_key,
        }))
    }

    pub(crate) fn transfer_to_session(&self, session_id: &str) -> Result<(), String> {
        let manager = self.app.state::<ProviderCancellationManager>();
        let mut flags = manager
            .flags
            .lock()
            .map_err(|_| "provider cancellation state is unavailable".to_string())?;
        if flags.contains_key(session_id) {
            return Err("the workflow step session is already active".into());
        }
        let control = flags
            .remove(&self.reservation_key)
            .ok_or_else(|| "automation provider reservation was lost".to_string())?;
        flags.insert(session_id.to_string(), control);
        Ok(())
    }
    pub(crate) fn reclaim_from_session(&self, session_id: &str) -> Result<(), String> {
        let manager = self.app.state::<ProviderCancellationManager>();
        let mut flags = manager
            .flags
            .lock()
            .map_err(|_| "provider cancellation state is unavailable".to_string())?;
        let control = flags
            .remove(session_id)
            .ok_or_else(|| "workflow provider reservation was lost".to_string())?;
        flags.insert(self.reservation_key.clone(), control);
        Ok(())
    }
}

impl Drop for AutomationRunAdmission {
    fn drop(&mut self) {
        if let Ok(mut flags) = self.app.state::<ProviderCancellationManager>().flags.lock() {
            flags.remove(&self.reservation_key);
        }
    }
}

pub(crate) fn automation_scheduler_effective_now(
    previous: chrono::DateTime<chrono::Utc>,
    monotonic_elapsed: Duration,
    observed_wall: chrono::DateTime<chrono::Utc>,
) -> chrono::DateTime<chrono::Utc> {
    let elapsed = chrono::Duration::from_std(monotonic_elapsed).unwrap_or_default();
    observed_wall.max(previous + elapsed)
}

impl AutomationSchedulerClock {
    pub(crate) fn new(observed_wall: chrono::DateTime<chrono::Utc>) -> Self {
        Self {
            last_effective: observed_wall,
            last_sample: Instant::now(),
        }
    }

    pub(crate) fn now(&mut self) -> chrono::DateTime<chrono::Utc> {
        let sample = Instant::now();
        let effective = automation_scheduler_effective_now(
            self.last_effective,
            sample.duration_since(self.last_sample),
            chrono::Utc::now(),
        );
        self.last_effective = effective;
        self.last_sample = sample;
        effective
    }
}

impl AutomationLeaseHeartbeat {
    pub(crate) fn start(
        paths: GyroPaths,
        automation_id: Uuid,
        lease_owner: String,
        lease_seconds: i64,
        interval: Duration,
    ) -> Self {
        let stopped = Arc::new(AtomicBool::new(false));
        let worker_stopped = stopped.clone();
        let worker = std::thread::spawn(move || {
            let store = match AutomationStore::open(paths) {
                Ok(store) => store,
                Err(error) => {
                    eprintln!("could not start automation lease heartbeat: {error}");
                    return;
                }
            };
            while !worker_stopped.load(Ordering::SeqCst) {
                std::thread::park_timeout(interval);
                if worker_stopped.load(Ordering::SeqCst) {
                    break;
                }
                match store.renew_automation_lease(
                    automation_id,
                    lease_owner.clone(),
                    lease_seconds,
                ) {
                    Ok(Some(_)) => {}
                    Ok(None) => break,
                    Err(error) => eprintln!(
                        "could not renew automation lease {}: {}",
                        automation_id,
                        gyro_core::security::redact_secrets(&error.to_string())
                    ),
                }
            }
        });
        Self {
            stopped,
            worker: Some(worker),
        }
    }

    pub(crate) fn stop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            worker.thread().unpark();
            let _ = worker.join();
        }
    }
}

impl Drop for AutomationLeaseHeartbeat {
    fn drop(&mut self) {
        self.stop();
    }
}

impl AutomationSchedulerControl {
    pub(crate) fn wake(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.generation = state.generation.wrapping_add(1);
            self.wake.notify_all();
        }
    }

    pub(crate) fn generation(&self) -> u64 {
        self.state
            .lock()
            .map(|state| state.generation)
            .unwrap_or_default()
    }

    pub(crate) fn wait_for_change(&self, observed_generation: u64, timeout: Duration) -> u64 {
        let Ok(state) = self.state.lock() else {
            std::thread::sleep(timeout);
            return observed_generation;
        };
        if state.generation != observed_generation {
            return state.generation;
        }
        self.wake
            .wait_timeout_while(state, timeout, |state| {
                state.generation == observed_generation
            })
            .map(|(state, _)| state.generation)
            .unwrap_or(observed_generation)
    }

    pub(crate) fn register(&self, automation_id: Uuid, session_id: String) {
        if let Ok(mut state) = self.state.lock() {
            state.running_sessions.insert(automation_id, session_id);
        }
    }

    pub(crate) fn unregister(&self, automation_id: Uuid) {
        if let Ok(mut state) = self.state.lock() {
            state.running_sessions.remove(&automation_id);
        }
    }

    pub(crate) fn session_for(&self, automation_id: Uuid) -> Option<String> {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.running_sessions.get(&automation_id).cloned())
    }
}

pub(crate) fn run_event_wakes_automation_scheduler(event: &tauri::RunEvent) -> bool {
    matches!(event, tauri::RunEvent::Resumed)
}
