//! Account/model cooldowns shared by foreground, queued and compaction workers.
//! Keys are opaque profile fingerprints; request text and credentials never live here.
use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

thread_local! { static SCOPE: RefCell<Option<String>> = const { RefCell::new(None) }; }

pub struct Scope(Option<String>);
impl Scope {
    pub fn enter(key: String) -> Self {
        Self(SCOPE.with(|scope| scope.replace(Some(key))))
    }
}
impl Drop for Scope {
    fn drop(&mut self) {
        SCOPE.with(|scope| {
            scope.replace(self.0.take());
        });
    }
}

#[derive(Default)]
struct Lane {
    until: Option<Instant>,
    queue: VecDeque<u64>,
    release_at: Option<Instant>,
}
#[derive(Default)]
struct Registry {
    lanes: HashMap<String, Lane>,
    aliases: HashMap<String, String>,
    next_ticket: u64,
}
impl Registry {
    fn canonical<'a>(&'a self, key: &'a str) -> &'a str {
        self.aliases.get(key).map_or(key, String::as_str)
    }
    fn link(&mut self, profile: &str, quota: String) {
        let old = self.canonical(profile).to_owned();
        if old != quota {
            if let Some(previous) = (old == profile).then(|| self.lanes.remove(&old)).flatten() {
                let next = self.lanes.entry(quota.clone()).or_default();
                next.until = next.until.into_iter().chain(previous.until).max();
                next.release_at = next.release_at.into_iter().chain(previous.release_at).max();
                next.queue.extend(previous.queue);
                next.queue.make_contiguous().sort_unstable();
            }
            self.aliases.insert(profile.into(), quota);
        }
    }
    fn observe(&mut self, key: &str, delay: Duration, now: Instant) {
        let key = self.canonical(key).to_owned();
        let Some(until) = now.checked_add(delay) else {
            return;
        };
        self.lanes
            .retain(|_, lane| !lane.queue.is_empty() || lane.until.is_some_and(|at| at > now));
        let lane = self.lanes.entry(key).or_default();
        lane.until = Some(lane.until.map_or(until, |old| old.max(until)));
    }
    fn remaining(&self, key: &str, now: Instant) -> Duration {
        self.lanes
            .get(self.canonical(key))
            .and_then(|lane| lane.until)
            .map_or(Duration::ZERO, |at| at.saturating_duration_since(now))
    }
    fn join(&mut self, key: &str) -> u64 {
        let key = self.canonical(key).to_owned();
        self.next_ticket += 1;
        self.lanes
            .entry(key)
            .or_default()
            .queue
            .push_back(self.next_ticket);
        self.next_ticket
    }
    fn take(&mut self, key: &str, ticket: u64, now: Instant) -> bool {
        let key = self.canonical(key).to_owned();
        let Some(lane) = self.lanes.get_mut(&key) else {
            return false;
        };
        if lane.queue.front() != Some(&ticket)
            || lane.until.is_some_and(|at| at > now)
            || lane.release_at.is_some_and(|at| at > now)
        {
            return false;
        }
        lane.queue.pop_front();
        // Stagger callers released by the same quota reset; ordinary requests
        // do not acquire a lane until a cooldown has actually been observed.
        lane.release_at = Some(now + Duration::from_millis(100));
        true
    }
    fn cancel(&mut self, key: &str, ticket: u64) {
        let key = self.canonical(key).to_owned();
        if let Some(lane) = self.lanes.get_mut(&key) {
            lane.queue.retain(|id| *id != ticket);
        }
    }
}
fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(Registry::default()))
}

pub fn remaining() -> Duration {
    SCOPE
        .with(|scope| {
            scope.borrow().as_deref().and_then(|key| {
                registry()
                    .lock()
                    .ok()
                    .map(|state| state.remaining(key, Instant::now()))
            })
        })
        .unwrap_or_default()
}

pub fn observe(delay: Duration) {
    SCOPE.with(|scope| {
        if let Some(key) = scope.borrow().as_deref() {
            if let Ok(mut state) = registry().lock() {
                state.observe(key, delay, Instant::now());
            }
        }
    });
}

/// A provider-reported organization can connect two native login profiles to
/// the same quota. Only a digest is retained, scoped to endpoint and model.
pub fn observe_error(error: &str, delay: Duration) {
    use sha2::{Digest, Sha256};
    static ORGANIZATION: OnceLock<regex::Regex> = OnceLock::new();
    let pattern = ORGANIZATION
        .get_or_init(|| regex::Regex::new(r"(?i)organization\s+(org-[a-z0-9-]+)").unwrap());
    let organization = pattern.captures(error).and_then(|capture| capture.get(1));
    if let Some(organization) = organization {
        SCOPE.with(|scope| {
            if let Some(key) = scope.borrow().as_deref() {
                let namespace = key.split('/').next().unwrap_or(key);
                let quota = format!(
                    "quota:{namespace}:{:x}",
                    Sha256::digest(organization.as_str().as_bytes())
                );
                if let Ok(mut state) = registry().lock() {
                    state.link(key, quota);
                }
            }
        });
    }
    observe(delay);
}

/// Waiters never hold the registry lock while sleeping. Dropping/cancelling a
/// waiter removes its ticket so it cannot stall unrelated sessions behind it.
pub fn wait(
    stopped: impl Fn() -> Option<String>,
    on_wait: impl FnOnce(Duration),
) -> Result<(), String> {
    if let Some(error) = stopped() {
        return Err(error);
    }
    let key = SCOPE.with(|scope| scope.borrow().clone());
    let Some(key) = key else { return Ok(()) };
    let ticket = {
        let mut state = registry()
            .lock()
            .map_err(|_| "Provider cooldown state is unavailable")?;
        let now = Instant::now();
        let remaining = state.remaining(&key, now);
        let queued = state
            .lanes
            .get(state.canonical(&key))
            .is_some_and(|lane| !lane.queue.is_empty());
        if remaining.is_zero() && !queued {
            return Ok(());
        }
        if remaining > Duration::from_secs(30) {
            return Err(format!(
                "Provider cooldown is longer than the automatic wait limit; try again in {:.3}s",
                remaining.as_secs_f64()
            ));
        }
        let ticket = state.join(&key);
        drop(state);
        on_wait(remaining);
        ticket
    };
    loop {
        if let Some(error) = stopped() {
            if let Ok(mut state) = registry().lock() {
                state.cancel(&key, ticket);
            }
            return Err(error);
        }
        let mut state = registry()
            .lock()
            .map_err(|_| "Provider cooldown state is unavailable")?;
        let now = Instant::now();
        let remaining = state.remaining(&key, now);
        if remaining > Duration::from_secs(30) {
            state.cancel(&key, ticket);
            return Err(format!("Provider cooldown was extended beyond the automatic wait limit; try again in {:.3}s", remaining.as_secs_f64()));
        }
        if state.take(&key, ticket, now) {
            return Ok(());
        }
        drop(state);
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deadlines_never_shorten_and_accounts_are_independent() {
        let now = Instant::now();
        let mut r = Registry::default();
        r.observe("account-a/model", Duration::from_secs(8), now);
        r.observe("account-a/model", Duration::from_secs(2), now);
        assert_eq!(r.remaining("account-a/model", now), Duration::from_secs(8));
        assert_eq!(r.remaining("account-b/model", now), Duration::ZERO);
    }
    #[test]
    fn fifo_release_is_staggered_and_cancellation_does_not_block() {
        let now = Instant::now();
        let mut r = Registry::default();
        r.observe("same", Duration::from_secs(2), now);
        let a = r.join("same");
        let b = r.join("same");
        let c = r.join("same");
        assert!(!r.take("same", a, now));
        assert!(!r.take("same", b, now + Duration::from_secs(2)));
        r.cancel("same", a);
        assert!(r.take("same", b, now + Duration::from_secs(2)));
        assert!(!r.take("same", c, now + Duration::from_secs(2)));
        assert!(r.take("same", c, now + Duration::from_millis(2100)));
    }
    #[test]
    fn known_organization_aliases_merge_deadlines_and_preserve_tickets() {
        let now = Instant::now();
        let mut r = Registry::default();
        r.observe("profile-a", Duration::from_secs(8), now);
        let ticket = r.join("profile-a");
        r.link("profile-a", "organization/model".into());
        r.link("profile-b", "organization/model".into());
        r.observe("profile-b", Duration::from_secs(2), now);
        assert_eq!(r.remaining("profile-b", now), Duration::from_secs(8));
        assert!(r.take("profile-a", ticket, now + Duration::from_secs(8)));
        assert_eq!(r.remaining("unrelated", now), Duration::ZERO);
    }
    #[test]
    fn long_waits_and_cancelled_waiters_do_not_dispatch() {
        let _scope = Scope::enter(uuid::Uuid::new_v4().to_string());
        observe(Duration::from_secs(90));
        assert!(wait(|| None, |_| panic!("long wait must stay actionable"))
            .unwrap_err()
            .contains("try again in"));
        assert_eq!(
            wait(|| Some("cancelled".into()), |_| panic!("cancelled waiter")).unwrap_err(),
            "cancelled"
        );
    }
}
