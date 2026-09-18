//! Deferred integrity probing for the desktop launch path.
//!
//! `pragma quick_check` walks the whole database and its WAL. That cost grows
//! with a user's history, and the answer cannot change what the shell does: the
//! warm-up report carries integrity as a non-fatal field precisely so a corrupt
//! store still opens instead of trapping someone on the optimizing screen. So
//! the scan runs beside the launch instead of in front of it.
//!
//! It lives in its own module because the desktop root sits at its architecture
//! size ceiling, and because "what the launch path may wait for" is one rule.

use super::*;
use std::sync::atomic::AtomicU8;

/// 0 = scan still running, 1 = ok, 2 = the scan reported a problem.
static LAUNCH_INTEGRITY_STATUS: AtomicU8 = AtomicU8::new(LAUNCH_INTEGRITY_RUNNING);
static LAUNCH_INTEGRITY_STARTED: AtomicBool = AtomicBool::new(false);

const LAUNCH_INTEGRITY_RUNNING: u8 = 0;
const LAUNCH_INTEGRITY_OK: u8 = 1;
const LAUNCH_INTEGRITY_FAILED: u8 = 2;

/// What the integrity scan has to say so far, for the warm-up report.
pub(crate) fn launch_integrity_status() -> String {
    match LAUNCH_INTEGRITY_STATUS.load(Ordering::Relaxed) {
        LAUNCH_INTEGRITY_RUNNING => "checking".to_string(),
        LAUNCH_INTEGRITY_OK => "ok".to_string(),
        _ => "failed (see logs)".to_string(),
    }
}

/// Run the integrity scan off the launch path, at most once per process.
pub(crate) fn defer_launch_integrity_check(paths: GyroPaths) {
    if LAUNCH_INTEGRITY_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let outcome = SessionStore::open(paths).and_then(|store| store.quick_check());
        match outcome {
            Ok(()) => LAUNCH_INTEGRITY_STATUS.store(LAUNCH_INTEGRITY_OK, Ordering::Relaxed),
            Err(error) => {
                // Surface corruption without failing anything: the shell is
                // already open, and doctor/repair paths dig deeper from here.
                eprintln!("gyro desktop shell: deferred sqlite quick_check reported: {error}");
                LAUNCH_INTEGRITY_STATUS.store(LAUNCH_INTEGRITY_FAILED, Ordering::Relaxed);
            }
        }
    });
}
