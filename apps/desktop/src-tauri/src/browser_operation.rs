//! Cancellation and bounded waits for one model-owned browser operation.
//! A queued main-thread callback must not start after its caller gives up.
use gyro_core::{CancellationToken, CapabilityId};
use std::{
    cell::RefCell,
    marker::PhantomData,
    rc::Rc,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::{Duration, Instant},
};

const CANCELLED: &str = "browser operation cancelled";
const CALLBACK_BUDGET: Duration = Duration::from_secs(15);
const POLL: Duration = Duration::from_millis(25);

#[derive(Clone)]
struct Operation {
    cancellation: CancellationToken,
    deadline: Instant,
    resource_id: Option<String>,
}
thread_local! { static ACTIVE: RefCell<Option<Operation>> = const { RefCell::new(None) }; }

pub(crate) struct OperationScope {
    previous: Option<Operation>,
    // A thread-local scope cannot be restored from another thread.
    _same_thread: PhantomData<Rc<()>>,
}
impl Drop for OperationScope {
    fn drop(&mut self) {
        ACTIVE.with(|active| *active.borrow_mut() = self.previous.take());
    }
}

pub(crate) fn begin_model_operation(
    id: CapabilityId,
    cancellation: CancellationToken,
) -> Option<OperationScope> {
    id.as_str()
        .starts_with("browser.")
        .then(|| enter(cancellation, CALLBACK_BUDGET))
}
fn enter(cancellation: CancellationToken, budget: Duration) -> OperationScope {
    OperationScope {
        previous: ACTIVE.with(|active| {
            active.borrow_mut().replace(Operation {
                cancellation,
                deadline: Instant::now() + budget,
                resource_id: None,
            })
        }),
        _same_thread: PhantomData,
    }
}
pub(crate) fn bind_model_resource(resource_id: &str) -> Result<(), String> {
    ACTIVE.with(|active| {
        let mut active = active.borrow_mut();
        if let Some(operation) = active.as_mut() {
            if let Some(id) = operation.resource_id.as_deref() {
                return if id == resource_id { Ok(()) } else {
                    Err("browser resource changed during the tool call; observe the current browser again".into())
                };
            }
            operation.resource_id = Some(resource_id.to_string());
        }
        Ok(())
    })
}
pub(crate) fn operation_was_cancelled(message: &str) -> bool {
    message == CANCELLED
}

#[derive(Clone)]
pub(crate) struct DispatchGuard {
    cancellation: Option<CancellationToken>,
    workflow_stopped: Option<Arc<AtomicBool>>,
    abandoned: Arc<AtomicBool>,
    deadline: Instant,
    timeout_message: &'static str,
}
impl DispatchGuard {
    pub(crate) fn check(&self) -> Result<(), String> {
        if self.abandoned.load(Ordering::Acquire)
            || self
                .cancellation
                .as_ref()
                .is_some_and(CancellationToken::is_cancelled)
            || self
                .workflow_stopped
                .as_ref()
                .is_some_and(|stopped| stopped.load(Ordering::Acquire))
        {
            return Err(CANCELLED.into());
        }
        if Instant::now() >= self.deadline {
            return Err(self.timeout_message.into());
        }
        Ok(())
    }
}

pub(crate) struct PendingCall(DispatchGuard);
impl PendingCall {
    pub(crate) fn new(timeout: Duration, timeout_message: &'static str) -> Result<Self, String> {
        let operation = ACTIVE.with(|active| active.borrow().clone());
        let deadline = Instant::now() + timeout;
        let guard = DispatchGuard {
            cancellation: operation
                .as_ref()
                .map(|operation| operation.cancellation.clone()),
            workflow_stopped: crate::code_mode::cancellation_flag(),
            abandoned: Arc::new(AtomicBool::new(false)),
            deadline: operation.map_or(deadline, |operation| operation.deadline.min(deadline)),
            timeout_message,
        };
        guard.check()?;
        Ok(Self(guard))
    }
    pub(crate) fn guard(&self) -> DispatchGuard {
        self.0.clone()
    }
    pub(crate) fn wait<T>(&self, receiver: mpsc::Receiver<T>) -> Result<T, String> {
        loop {
            self.0.check()?;
            let remaining = self.0.deadline.saturating_duration_since(Instant::now());
            match receiver.recv_timeout(remaining.min(POLL)) {
                Ok(result) => {
                    self.0.check()?;
                    return Ok(result);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    self.0.check()?;
                    return Err("browser callback ended without a result".into());
                }
            }
        }
    }
}
impl Drop for PendingCall {
    fn drop(&mut self) {
        self.0.abandoned.store(true, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_tool_stays_bound_to_one_browser_and_the_next_tool_can_use_a_replacement() {
        let scope = begin_model_operation(
            CapabilityId::BrowserScreenshot,
            CancellationToken::default(),
        )
        .unwrap();
        bind_model_resource("original").unwrap();
        bind_model_resource("original").unwrap();
        assert!(bind_model_resource("replacement").is_err());
        drop(scope);
        let _next = begin_model_operation(
            CapabilityId::BrowserScreenshot,
            CancellationToken::default(),
        )
        .unwrap();
        bind_model_resource("replacement").unwrap();
    }

    #[test]
    fn stop_interrupts_a_silent_callback_without_waiting_for_its_timeout() {
        let token = CancellationToken::default();
        let _scope = begin_model_operation(CapabilityId::BrowserReadPage, token.clone()).unwrap();
        let pending = PendingCall::new(Duration::from_secs(8), "timed out").unwrap();
        let (_sender, receiver) = mpsc::channel::<()>();
        let worker = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            token.cancel();
        });
        let start = Instant::now();
        assert_eq!(pending.wait(receiver).unwrap_err(), CANCELLED);
        assert!(start.elapsed() < Duration::from_millis(500));
        worker.join().unwrap();
    }

    #[test]
    fn queued_callbacks_are_invalidated_by_cancellation_timeout_or_abandonment() {
        let token = CancellationToken::default();
        let _scope = begin_model_operation(CapabilityId::BrowserClick, token.clone()).unwrap();
        let pending = PendingCall::new(Duration::from_secs(8), "timed out").unwrap();
        let queued = pending.guard();
        token.cancel();
        assert_eq!(queued.check().unwrap_err(), CANCELLED);
        drop(_scope);
        let pending = PendingCall::new(Duration::from_secs(8), "timed out").unwrap();
        let queued = pending.guard();
        drop(pending);
        assert_eq!(queued.check().unwrap_err(), CANCELLED);
        let pending = PendingCall::new(Duration::from_millis(5), "timed out").unwrap();
        let queued = pending.guard();
        std::thread::sleep(Duration::from_millis(10));
        assert_eq!(queued.check().unwrap_err(), "timed out");
    }

    #[test]
    fn consecutive_callbacks_share_one_budget() {
        let _scope = enter(CancellationToken::default(), Duration::from_millis(20));
        let first = PendingCall::new(Duration::from_secs(8), "timed out").unwrap();
        let (sender, receiver) = mpsc::channel();
        sender.send("first result").unwrap();
        assert_eq!(first.wait(receiver).unwrap(), "first result");
        std::thread::sleep(Duration::from_millis(30));
        assert!(PendingCall::new(Duration::from_secs(8), "timed out").is_err());
    }

    #[test]
    fn scopes_restore_the_owner_and_do_not_cancel_manual_or_other_thread_calls() {
        let first = CancellationToken::default();
        let outer = begin_model_operation(CapabilityId::BrowserReadPage, first.clone()).unwrap();
        let second = CancellationToken::default();
        let inner = begin_model_operation(CapabilityId::BrowserFind, second.clone()).unwrap();
        first.cancel();
        assert!(PendingCall::new(Duration::from_secs(1), "timed out").is_ok());
        drop(inner);
        assert!(PendingCall::new(Duration::from_secs(1), "timed out").is_err());
        std::thread::spawn(|| {
            assert!(PendingCall::new(Duration::from_secs(1), "timed out").is_ok())
        })
        .join()
        .unwrap();
        drop(outer);
        assert!(PendingCall::new(Duration::from_secs(1), "timed out").is_ok());
        assert!(begin_model_operation(CapabilityId::CodeModeExecute, second).is_none());
    }

    #[test]
    fn cancellation_outranks_a_result_already_in_the_channel() {
        let token = CancellationToken::default();
        let _scope = begin_model_operation(CapabilityId::BrowserScreenshot, token.clone()).unwrap();
        let pending = PendingCall::new(Duration::from_secs(1), "timed out").unwrap();
        let (sender, receiver) = mpsc::channel();
        sender.send("late result").unwrap();
        token.cancel();
        assert_eq!(pending.wait(receiver).unwrap_err(), CANCELLED);
    }

    #[test]
    fn disconnected_callbacks_fail_promptly() {
        let pending = PendingCall::new(Duration::from_secs(8), "timed out").unwrap();
        let (sender, receiver) = mpsc::channel::<()>();
        drop(sender);
        assert!(pending
            .wait(receiver)
            .unwrap_err()
            .contains("without a result"));
    }
}
