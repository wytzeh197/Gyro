use gyro_core::CancellationToken;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::time::{Duration, Instant};

/// A synchronous provider request can still honour the CLI's wall deadline.
/// Completion releases the timer immediately; no sleeping watchdog survives it.
pub(super) struct ProviderDeadline {
    done: mpsc::Sender<Instant>,
    worker: Option<std::thread::JoinHandle<()>>,
    expired: Arc<AtomicBool>,
}

impl ProviderDeadline {
    pub(super) fn start(token: CancellationToken, timeout: Duration) -> Self {
        let started = Instant::now();
        let (done, completion) = mpsc::channel();
        let expired = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&expired);
        let worker = std::thread::spawn(move || {
            watch_deadline(&token, &flag, started, timeout, completion);
        });
        Self {
            done,
            worker: Some(worker),
            expired,
        }
    }
    pub(super) fn finish(&mut self) {
        let _ = self.done.send(Instant::now());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
    pub(super) fn expired(&self) -> bool {
        self.expired.load(Ordering::SeqCst)
    }
}
// The budget starts on the caller, not when the watchdog is first scheduled.
// A queued completion timestamp preserves timely work even if the watchdog runs late.
fn watch_deadline(
    token: &CancellationToken,
    expired: &AtomicBool,
    started: Instant,
    timeout: Duration,
    completion: mpsc::Receiver<Instant>,
) {
    let timed_out = match completion.recv_timeout(timeout.saturating_sub(started.elapsed())) {
        Ok(completed) => completed.saturating_duration_since(started) >= timeout,
        Err(mpsc::RecvTimeoutError::Timeout) => true,
        Err(mpsc::RecvTimeoutError::Disconnected) => false,
    };
    if timed_out && !token.is_cancelled() {
        expired.store(true, Ordering::SeqCst);
        token.cancel();
    }
}

impl Drop for ProviderDeadline {
    fn drop(&mut self) {
        self.finish();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deadline_cancels_pending_work_and_completion_retires_the_watchdog() {
        let token = CancellationToken::default();
        let mut deadline = ProviderDeadline::start(token.clone(), Duration::from_millis(20));
        let observe_until = Instant::now() + Duration::from_secs(2);
        while !token.is_cancelled() && Instant::now() < observe_until {
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(token.is_cancelled() && deadline.expired());
        deadline.finish();
        let token = CancellationToken::default();
        let mut deadline = ProviderDeadline::start(token.clone(), Duration::from_secs(10));
        let at = std::time::Instant::now();
        deadline.finish();
        assert!(at.elapsed() < Duration::from_secs(1));
        assert!(!token.is_cancelled() && !deadline.expired());
        assert!(deadline.worker.is_none());
    }
    #[test]
    fn delayed_watchdog_cannot_retire_a_completion_after_the_absolute_deadline() {
        let token = CancellationToken::default();
        let expired = AtomicBool::new(false);
        let started = Instant::now() - Duration::from_secs(2);
        let (done, completion) = mpsc::channel();
        done.send(started + Duration::from_millis(1500)).unwrap();
        watch_deadline(
            &token,
            &expired,
            started,
            Duration::from_secs(1),
            completion,
        );
        assert!(token.is_cancelled() && expired.load(Ordering::SeqCst));
    }
    #[test]
    fn delayed_watchdog_preserves_completion_before_the_absolute_deadline() {
        let token = CancellationToken::default();
        let expired = AtomicBool::new(false);
        let started = Instant::now() - Duration::from_secs(2);
        let (done, completion) = mpsc::channel();
        done.send(started + Duration::from_millis(500)).unwrap();
        watch_deadline(
            &token,
            &expired,
            started,
            Duration::from_secs(1),
            completion,
        );
        assert!(!token.is_cancelled() && !expired.load(Ordering::SeqCst));
    }
    #[test]
    fn manual_stop_is_not_reclassified_as_a_deadline() {
        let token = CancellationToken::default();
        token.cancel();
        let mut deadline = ProviderDeadline::start(token.clone(), Duration::ZERO);
        deadline.finish();
        assert!(token.is_cancelled() && !deadline.expired());
    }
}
