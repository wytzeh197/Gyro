//! One detailed status decoration per workspace, within each caller's budget.
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, OnceLock, Weak},
    time::Instant,
};

#[derive(Default)]
struct Gate {
    busy: Mutex<bool>,
    ready: Condvar,
}

pub(super) struct Permit(Arc<Gate>);
impl Drop for Permit {
    fn drop(&mut self) {
        let mut busy = self
            .0
            .busy
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *busy = false;
        // An awakened reader may already have exhausted its own budget. Wake
        // every waiter so that cannot leave a free gate with sleeping readers.
        self.0.ready.notify_all();
    }
}

pub(super) fn acquire(root: &Path, deadline: Instant) -> anyhow::Result<Permit> {
    static GATES: OnceLock<Mutex<HashMap<PathBuf, Weak<Gate>>>> = OnceLock::new();
    let gate = {
        let mut gates = GATES
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        gates.retain(|_, gate| gate.strong_count() > 0);
        match gates.get(root).and_then(Weak::upgrade) {
            Some(gate) => gate,
            None => {
                let gate = Arc::new(Gate::default());
                gates.insert(root.to_owned(), Arc::downgrade(&gate));
                gate
            }
        }
    };
    let mut busy = gate.busy.lock().unwrap_or_else(|error| error.into_inner());
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        anyhow::ensure!(
            !remaining.is_zero(),
            "Git detail inspection timed out; retry to refresh"
        );
        if !*busy {
            *busy = true;
            drop(busy);
            return Ok(Permit(gate));
        }
        busy = gate
            .ready
            .wait_timeout(busy, remaining)
            .unwrap_or_else(|error| error.into_inner())
            .0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn busy_workspace_does_not_block_another_workspace_or_outlive_a_deadline() {
        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("first");
        let second = directory.path().join("second");
        let permit = acquire(&first, Instant::now() + Duration::from_secs(1)).unwrap();
        let _other = acquire(&second, Instant::now() + Duration::from_secs(1)).unwrap();
        let started = Instant::now();
        assert!(acquire(&first, started + Duration::from_millis(30)).is_err());
        assert!(started.elapsed() < Duration::from_secs(1));
        drop(permit);
        assert!(acquire(&first, Instant::now() + Duration::from_secs(1)).is_ok());
        assert!(acquire(&first, Instant::now()).is_err());
    }

    #[test]
    fn panicking_reader_releases_waiters() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().to_owned();
        let worker_root = root.clone();
        let (acquired, wait) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _permit = acquire(&worker_root, Instant::now() + Duration::from_secs(1)).unwrap();
            acquired.send(()).unwrap();
            released.recv().unwrap();
            panic!("injected detail reader failure");
        });
        wait.recv_timeout(Duration::from_secs(1)).unwrap();
        release.send(()).unwrap();
        let _next = acquire(&root, Instant::now() + Duration::from_secs(1)).unwrap();
        assert!(worker.join().is_err());
    }
}
