//! Run-owned cleanup survives early returns, worker panics, and dropped IPC callers.

pub(crate) use crate::providers::runner::ProviderHeartbeat;
use crate::{
    app::limits::MAX_CONCURRENT_PROVIDER_RUNS,
    goal_runner,
    providers::{chat_types::ProviderChatRequest, events::append_provider_status_event},
    state::{managers::ProviderCancellationManager, provider_run::ProviderRunControl},
};
use gyro_core::{HarnessRunStatus, SessionStore};
#[cfg(test)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::Manager;
use uuid::Uuid;

/// The blocking worker owns admission, not the future awaiting its result.
/// Dropping an IPC caller must neither leak its slot nor release it while the
/// provider is still executing tools.
pub(super) struct ProviderRunReservation {
    app: tauri::AppHandle,
    session_id: String,
    control: Arc<ProviderRunControl>,
}

impl ProviderRunReservation {
    pub(super) fn reserve(app: &tauri::AppHandle, session_id: &str) -> Result<Self, String> {
        let control = Arc::new(ProviderRunControl::default());
        let manager = app.state::<ProviderCancellationManager>();
        let mut flags = manager
            .flags
            .lock()
            .map_err(|_| "provider cancellation state is unavailable".to_string())?;
        if flags.contains_key(session_id) {
            return Err("a provider turn is already running for this session".into());
        }
        if flags.len() >= MAX_CONCURRENT_PROVIDER_RUNS {
            return Err(format!(
                "Gyro can run at most {MAX_CONCURRENT_PROVIDER_RUNS} provider turns at once"
            ));
        }
        flags.insert(session_id.to_string(), control.clone());
        Ok(Self {
            app: app.clone(),
            session_id: session_id.into(),
            control,
        })
    }
}

/// A cancellation request is not permission to run a second writer. Wait for
/// the worker to release its own reservation; never remove it from the caller.
/// Runs on a blocking worker, without holding the registry lock while waiting.
pub(crate) fn wait_for_owned_run_release(
    flags: &Mutex<HashMap<String, Arc<ProviderRunControl>>>,
    session_id: &str,
    control: &Arc<ProviderRunControl>,
    timeout: std::time::Duration,
) -> Result<(), String> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let still_owned = flags
            .lock()
            .map_err(|_| "provider cancellation state is unavailable".to_string())?
            .get(session_id)
            .is_some_and(|current| Arc::ptr_eq(current, control));
        if !still_owned {
            return Ok(());
        }
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err("The current turn is still stopping; the queued message is waiting for it to release the chat.".into());
        }
        std::thread::sleep(remaining.min(std::time::Duration::from_millis(10)));
    }
}

fn release_owned_run(
    flags: &Mutex<HashMap<String, Arc<ProviderRunControl>>>,
    session_id: &str,
    control: &Arc<ProviderRunControl>,
) {
    // Cleanup can still release its own slot if another owner poisoned the
    // registry. Provider code is never executed under this lock.
    let mut flags = flags.lock().unwrap_or_else(|error| error.into_inner());
    if flags
        .get(session_id)
        .is_some_and(|current| Arc::ptr_eq(current, control))
    {
        flags.remove(session_id);
    }
}

impl Drop for ProviderRunReservation {
    fn drop(&mut self) {
        release_owned_run(
            &self.app.state::<ProviderCancellationManager>().flags,
            &self.session_id,
            &self.control,
        );
        goal_runner::finished(&self.app, &self.session_id, &self.control.approval_nonce);
    }
}

const ABANDONED_TURN: &str =
    "The chat worker ended unexpectedly. Review any partial work, then send again to continue.";

/// Close a started turn if setup, persistence, or a panic bypasses the runner's
/// normal terminal event. This guard is dropped before the session lease.
pub(super) struct ProviderTurnFinalizer<'a> {
    store: &'a SessionStore,
    request: &'a ProviderChatRequest,
    session_id: Uuid,
    run_id: Uuid,
    attempt_id: Uuid,
    settled: bool,
    response_saved: bool,
    on_terminal: Box<dyn Fn(HarnessRunStatus, Option<&str>) + 'a>,
}

impl<'a> ProviderTurnFinalizer<'a> {
    pub(super) fn new(
        store: &'a SessionStore,
        request: &'a ProviderChatRequest,
        session_id: Uuid,
        run_id: Uuid,
        attempt_id: Uuid,
        on_terminal: impl Fn(HarnessRunStatus, Option<&str>) + 'a,
    ) -> Self {
        Self {
            store,
            request,
            session_id,
            run_id,
            attempt_id,
            settled: false,
            response_saved: false,
            on_terminal: Box::new(on_terminal),
        }
    }

    pub(super) fn response_saved(&mut self) {
        self.response_saved = true;
    }

    pub(super) fn settled(&mut self) {
        self.settled = true;
    }
}

impl Drop for ProviderTurnFinalizer<'_> {
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        // Do not overwrite the normal terminal path.
        if self
            .store
            .latest_provider_status_for_turn(self.session_id, self.run_id)
            .ok()
            .flatten()
            .is_some_and(|status| !matches!(status.as_str(), "running" | "waiting" | "queued"))
        {
            return;
        }
        let (status, error) = if self.response_saved {
            (HarnessRunStatus::Done, None)
        } else {
            (HarnessRunStatus::Failed, Some(ABANDONED_TURN))
        };
        let _ = append_provider_status_event(
            self.store,
            self.session_id,
            self.request,
            Some(self.run_id),
            self.attempt_id,
            status.clone(),
            error,
        );
        (self.on_terminal)(status, error);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::{
        events::provider_turn_has_unfinished_attempt, session_lifecycle::ProviderSessionLease,
    };
    use gyro_core::{GyroPaths, SessionEventKind};
    use std::time::Duration;

    #[test]
    fn steer_waits_for_worker_release_without_releasing_its_slot() {
        let control = Arc::new(ProviderRunControl::default());
        control.cancellation.cancel();
        let flags = Arc::new(Mutex::new(HashMap::from([(
            "chat".into(),
            control.clone(),
        )])));
        let (sent, received) = std::sync::mpsc::channel();
        let worker_flags = flags.clone();
        let worker_control = control.clone();
        let waiter = std::thread::spawn(move || {
            sent.send(wait_for_owned_run_release(
                &worker_flags,
                "chat",
                &worker_control,
                Duration::from_secs(2),
            ))
            .unwrap();
        });
        assert!(matches!(
            received.recv_timeout(Duration::from_millis(25)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        assert!(Arc::ptr_eq(
            flags.lock().unwrap().get("chat").unwrap(),
            &control
        ));
        release_owned_run(&flags, "chat", &control);
        received
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .unwrap();
        waiter.join().unwrap();
    }

    #[test]
    fn steer_acknowledgement_never_cancels_a_replacement_run() {
        let original = Arc::new(ProviderRunControl::default());
        original.cancellation.cancel();
        let replacement = Arc::new(ProviderRunControl::default());
        let flags = Mutex::new(HashMap::from([("chat".into(), replacement.clone())]));
        wait_for_owned_run_release(&flags, "chat", &original, Duration::ZERO).unwrap();
        assert!(!replacement.cancellation.is_cancelled());
        assert!(Arc::ptr_eq(
            flags.lock().unwrap().get("chat").unwrap(),
            &replacement
        ));
        wait_for_owned_run_release(&flags, "finished", &original, Duration::ZERO).unwrap();
    }

    #[test]
    fn steer_timeout_preserves_the_active_run_reservation() {
        let control = Arc::new(ProviderRunControl::default());
        control.cancellation.cancel();
        let flags = Mutex::new(HashMap::from([("chat".into(), control.clone())]));
        assert!(wait_for_owned_run_release(&flags, "chat", &control, Duration::ZERO).is_err());
        assert!(flags.lock().unwrap().contains_key("chat"));
    }

    fn setup() -> (
        tempfile::TempDir,
        SessionStore,
        ProviderChatRequest,
        Uuid,
        Uuid,
    ) {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), gyro_core::SessionOrigin::Desktop, "cleanup")
            .unwrap();
        let run = Uuid::new_v4();
        let request = serde_json::from_value(serde_json::json!({
            "sessionId": session.id.to_string(), "turnId": run.to_string(),
            "message": "continue", "providerId": "openai",
        }))
        .unwrap();
        (temp, store, request, session.id, run)
    }

    #[test]
    fn abandoned_retry_wait_is_closed_as_a_failure() {
        let (_temp, store, request, session, run) = setup();
        store.append_event_with_turn_id(session, SessionEventKind::SystemEvent, "Waiting for provider",
            serde_json::json!({"kind":"provider-status", "status":"waiting", "nativeRetry":true}), Some(run)).unwrap();
        assert!(provider_turn_has_unfinished_attempt(&store, session, run).unwrap());
        {
            let _finalizer = ProviderTurnFinalizer::new(
                &store,
                &request,
                session,
                run,
                Uuid::new_v4(),
                |status, _| assert_eq!(status, HarnessRunStatus::Failed),
            );
        }
        assert_eq!(
            store
                .latest_provider_status_for_turn(session, run)
                .unwrap()
                .as_deref(),
            Some("failed")
        );
    }

    #[test]
    fn early_return_and_panic_close_the_turn_before_lease_release() {
        for panic in [false, true] {
            let (_temp, store, request, session, run) = setup();
            let lease = ProviderSessionLease::for_run(&store, session).unwrap();
            let attempt = Uuid::new_v4();
            append_provider_status_event(
                &store,
                session,
                &request,
                Some(run),
                attempt,
                HarnessRunStatus::Running,
                None,
            )
            .unwrap();
            let emitted = std::cell::Cell::new(0);
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _finalizer = ProviderTurnFinalizer::new(
                    &store,
                    &request,
                    session,
                    run,
                    attempt,
                    |status, error| {
                        assert_eq!(status, HarnessRunStatus::Failed);
                        assert_eq!(error, Some(ABANDONED_TURN));
                        // Terminal notification happens while this worker still owns the lease.
                        assert!(ProviderSessionLease::try_acquire(store.paths(), session)
                            .unwrap()
                            .is_none());
                        emitted.set(emitted.get() + 1);
                    },
                );
                if panic {
                    panic!("injected persistence failure");
                }
                Err::<(), _>("injected early return")
            }));
            assert_eq!(result.is_err(), panic);
            assert_eq!(emitted.get(), 1);
            assert_eq!(
                store
                    .latest_provider_status_for_turn(session, run)
                    .unwrap()
                    .as_deref(),
                Some("failed")
            );
            assert!(!provider_turn_has_unfinished_attempt(&store, session, run).unwrap());
            drop(lease);
            let _next_run = ProviderSessionLease::for_run(&store, session).unwrap();
        }
    }

    #[test]
    fn normal_terminal_status_is_not_overwritten_or_emitted_twice() {
        for status in [
            HarnessRunStatus::Done,
            HarnessRunStatus::Failed,
            HarnessRunStatus::Cancelled,
        ] {
            let (_temp, store, request, session, run) = setup();
            let attempt = Uuid::new_v4();
            append_provider_status_event(
                &store,
                session,
                &request,
                Some(run),
                attempt,
                status,
                None,
            )
            .unwrap();
            let before = store.read_events(session).unwrap();
            drop(ProviderTurnFinalizer::new(
                &store,
                &request,
                session,
                run,
                attempt,
                |_, _| panic!("duplicate terminal event"),
            ));
            assert_eq!(store.read_events(session).unwrap().len(), before.len());
        }
    }

    #[test]
    fn saved_response_is_completed_if_postprocessing_panics() {
        let (_temp, store, request, session, run) = setup();
        let attempt = Uuid::new_v4();
        append_provider_status_event(
            &store,
            session,
            &request,
            Some(run),
            attempt,
            HarnessRunStatus::Running,
            None,
        )
        .unwrap();
        let emitted = std::cell::Cell::new(0);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut guard = ProviderTurnFinalizer::new(
                &store,
                &request,
                session,
                run,
                attempt,
                |status, error| {
                    assert_eq!(status, HarnessRunStatus::Done);
                    assert!(error.is_none());
                    emitted.set(emitted.get() + 1);
                },
            );
            store
                .append_event_with_turn_id(
                    session,
                    SessionEventKind::AssistantMessage,
                    "saved answer",
                    serde_json::json!({"kind":"provider-response"}),
                    Some(run),
                )
                .unwrap();
            guard.response_saved();
            panic!("injected postprocessing failure");
        }));
        assert!(result.is_err());
        assert_eq!(emitted.get(), 1);
        assert_eq!(
            store
                .latest_provider_status_for_turn(session, run)
                .unwrap()
                .as_deref(),
            Some("done")
        );
        assert_eq!(
            store
                .read_events(session)
                .unwrap()
                .iter()
                .filter(|event| event.kind == SessionEventKind::AssistantMessage)
                .count(),
            1
        );
    }

    #[test]
    fn heartbeat_is_joined_when_its_worker_unwinds() {
        let stop = Arc::new(AtomicBool::new(false));
        let exited = Arc::new(AtomicBool::new(false));
        let result = std::panic::catch_unwind({
            let stop = stop.clone();
            let exited = exited.clone();
            move || {
                let worker_stop = stop.clone();
                let worker = std::thread::spawn(move || {
                    while !worker_stop.load(Ordering::Relaxed) {
                        std::thread::park_timeout(Duration::from_millis(10));
                    }
                    exited.store(true, Ordering::Relaxed);
                });
                let _heartbeat = ProviderHeartbeat::new(stop, worker);
                panic!("injected provider failure");
            }
        });
        assert!(result.is_err());
        assert!(stop.load(Ordering::Relaxed));
        assert!(
            exited.load(Ordering::Relaxed),
            "cleanup joins before the turn settles"
        );
    }

    #[test]
    fn admission_cleanup_releases_only_the_owning_run() {
        let control = Arc::new(ProviderRunControl::default());
        let replacement = Arc::new(ProviderRunControl::default());
        let flags = Mutex::new(HashMap::from([("chat".into(), control.clone())]));
        release_owned_run(&flags, "chat", &replacement);
        assert_eq!(flags.lock().unwrap().len(), 1);
        release_owned_run(&flags, "chat", &control);
        assert!(flags.lock().unwrap().is_empty());
        flags
            .lock()
            .unwrap()
            .insert("chat".into(), replacement.clone());
        release_owned_run(&flags, "chat", &control);
        assert!(Arc::ptr_eq(&flags.lock().unwrap()["chat"], &replacement));
    }
}
