use gyro_core::{AutomationStore, GyroPaths, SessionStore};
use std::sync::Mutex;
use uuid::Uuid;
/// Process-local SQLite connection pools. Concurrent commands borrow a handle
/// and return it on drop. Extra connections beyond capacity are discarded so
/// the pool stays small (one DB file, several WAL readers/writers).
pub(crate) const SESSION_STORE_POOL_CAPACITY: usize = 8;
pub(crate) const AUTOMATION_STORE_POOL_CAPACITY: usize = 2;
pub(crate) static SESSION_STORE_POOL: Mutex<Vec<SessionStore>> = Mutex::new(Vec::new());
pub(crate) static AUTOMATION_STORE_POOL: Mutex<Vec<AutomationStore>> = Mutex::new(Vec::new());

pub(crate) struct SessionStoreLease {
    pub(crate) store: Option<SessionStore>,
}

impl std::ops::Deref for SessionStoreLease {
    type Target = SessionStore;

    fn deref(&self) -> &Self::Target {
        self.store.as_ref().expect("session store lease is active")
    }
}

impl AsRef<SessionStore> for SessionStoreLease {
    fn as_ref(&self) -> &SessionStore {
        self.store.as_ref().expect("session store lease is active")
    }
}

impl Drop for SessionStoreLease {
    fn drop(&mut self) {
        if let Some(store) = self.store.take() {
            if let Ok(mut pool) = SESSION_STORE_POOL.lock() {
                if pool.len() < SESSION_STORE_POOL_CAPACITY {
                    pool.push(store);
                }
            }
        }
    }
}

pub(crate) struct AutomationStoreLease {
    pub(crate) store: Option<AutomationStore>,
}

impl std::ops::Deref for AutomationStoreLease {
    type Target = AutomationStore;

    fn deref(&self) -> &Self::Target {
        self.store
            .as_ref()
            .expect("automation store lease is active")
    }
}

impl AsRef<AutomationStore> for AutomationStoreLease {
    fn as_ref(&self) -> &AutomationStore {
        self.store
            .as_ref()
            .expect("automation store lease is active")
    }
}

impl Drop for AutomationStoreLease {
    fn drop(&mut self) {
        if let Some(store) = self.store.take() {
            if let Ok(mut pool) = AUTOMATION_STORE_POOL.lock() {
                if pool.len() < AUTOMATION_STORE_POOL_CAPACITY {
                    pool.push(store);
                }
            }
        }
    }
}

pub(crate) fn open_store() -> Result<SessionStoreLease, String> {
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    if let Ok(mut pool) = SESSION_STORE_POOL.lock() {
        if let Some(store) = pool.pop() {
            return Ok(SessionStoreLease { store: Some(store) });
        }
    }
    let store = SessionStore::open(paths).map_err(to_string)?;
    Ok(SessionStoreLease { store: Some(store) })
}

pub(crate) fn open_automation_store() -> Result<AutomationStoreLease, String> {
    let paths = GyroPaths::for_current_user().map_err(to_string)?;
    if let Ok(mut pool) = AUTOMATION_STORE_POOL.lock() {
        if let Some(store) = pool.pop() {
            return Ok(AutomationStoreLease { store: Some(store) });
        }
    }
    let store = AutomationStore::open(paths).map_err(to_string)?;
    Ok(AutomationStoreLease { store: Some(store) })
}

/// Prefill idle pooled connections so the first user actions after warm-up do
/// not pay SQLite open + schema ensure latency.
pub(crate) fn warm_store_pools(paths: &GyroPaths) -> Result<(usize, usize), String> {
    // Connections open outside the pool locks, so store calls made during
    // warm-up never queue behind it. Maintenance already ran on the caller's
    // connection and is database-wide, so pooled connections skip it.
    let idle = SESSION_STORE_POOL.lock().map_or(0, |pool| pool.len());
    let sessions = (idle..SESSION_STORE_POOL_CAPACITY)
        .map(|_| SessionStore::open(paths.clone()).map_err(to_string))
        .collect::<Result<Vec<_>, _>>()?;
    let session_warmed = sessions.len();
    for store in sessions {
        drop(SessionStoreLease { store: Some(store) });
    }
    let idle = AUTOMATION_STORE_POOL.lock().map_or(0, |pool| pool.len());
    let automations = (idle..AUTOMATION_STORE_POOL_CAPACITY)
        .map(|_| AutomationStore::open(paths.clone()).map_err(to_string))
        .collect::<Result<Vec<_>, _>>()?;
    let automation_warmed = automations.len();
    for store in automations {
        drop(AutomationStoreLease { store: Some(store) });
    }
    Ok((session_warmed, automation_warmed))
}

pub(crate) fn parse_uuid(value: &str) -> Result<Uuid, String> {
    Uuid::parse_str(value).map_err(to_string)
}

pub(crate) fn to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}
