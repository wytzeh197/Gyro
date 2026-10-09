use gyro_core::CancellationToken;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::time::Duration;

/// A synchronous provider request can still honour the CLI's wall deadline.
/// Completion releases the timer immediately; no sleeping watchdog survives it.
pub(super) struct ProviderDeadline {
    done: mpsc::Sender<()>,
    worker: Option<std::thread::JoinHandle<()>>,
    expired: Arc<AtomicBool>,
}

impl ProviderDeadline {
    pub(super) fn start(token: CancellationToken, timeout: Duration) -> Self {
        let (done, completion) = mpsc::channel();
        let expired = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&expired);
        let worker = std::thread::spawn(move || {
            if matches!(
                completion.recv_timeout(timeout),
                Err(mpsc::RecvTimeoutError::Timeout)
            ) && !token.is_cancelled()
            {
                flag.store(true, Ordering::SeqCst);
                token.cancel();
            }
        });
        Self {
            done,
            worker: Some(worker),
            expired,
        }
    }
    pub(super) fn finish(&mut self) {
        let _ = self.done.send(());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
    pub(super) fn expired(&self) -> bool {
        self.expired.load(Ordering::SeqCst)
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
        std::thread::sleep(Duration::from_millis(60));
        deadline.finish();
        assert!(token.is_cancelled() && deadline.expired());
        let token = CancellationToken::default();
        let mut deadline = ProviderDeadline::start(token.clone(), Duration::from_secs(10));
        let at = std::time::Instant::now();
        deadline.finish();
        assert!(at.elapsed() < Duration::from_secs(1));
        assert!(!token.is_cancelled() && !deadline.expired());
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
