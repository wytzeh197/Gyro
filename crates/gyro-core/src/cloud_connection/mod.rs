//! Optional Cloud session, independent of the local device identity and engine.
//! Only an explicitly configured debug loopback mock is currently connectable.
pub mod contract;
pub mod hosted;
pub mod supabase;
#[cfg(test)]
mod tests;
pub mod transport;
pub mod v2;
pub mod v3;
use chrono::{DateTime, Utc};
use contract::{Environment, Login, Mode, Revoked, Snapshot, VERSION};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use transport::{Operation, Transport};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum CloudError {
    #[error("Cloud is not configured. Local work remains available.")]
    NotConfigured,
    #[error("The local Cloud simulator is unavailable. Local work remains available.")]
    Unavailable,
    #[error("The Cloud response could not be verified. Local work remains available.")]
    Protocol,
    #[error("Your Cloud session expired or was revoked. Local work remains available.")]
    Authentication,
    #[error("No synthetic account exists yet. Start with Subscribe in this local simulation.")]
    MissingAccount,
    #[error("A Cloud action is already running.")]
    Busy,
    #[error("This Cloud response belongs to an earlier session and was discarded.")]
    Stale,
    #[error("Sign out before starting another simulated account session.")]
    AlreadyConnected,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum State {
    Unconfigured,
    SignedOut,
    Verifying,
    Connected,
    Offline,
    Expired,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct View {
    pub state: State,
    pub last_verified: Option<DateTime<Utc>>,
    pub snapshot: Option<Snapshot>,
    pub revocation_pending: bool,
}
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Action {
    Read,
    SubscribeLite,
    SubscribePlus,
    SubscribePremium,
    Restore,
    Refresh,
    CompleteCheckout,
    CancelRenewal,
    Expire,
    ManagedRequest,
    SignOut,
    ManageBilling,
}
#[derive(Clone)]
struct Credential {
    token: String,
    account: Uuid,
    session: Uuid,
}
struct SessionState {
    generation: u64,
    busy: bool,
    credential: Option<Credential>,
    view: View,
    received: Option<(Instant, DateTime<Utc>, Duration)>,
    login_in_flight: Option<u64>,
    pending_revocations: BTreeSet<String>,
}
pub struct Connection {
    transport: Option<Arc<dyn Transport>>,
    state: Mutex<SessionState>,
}

fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T, CloudError> {
    if bytes.len() > 32_768 {
        return Err(CloudError::Protocol);
    }
    serde_json::from_slice(bytes).map_err(|_| CloudError::Protocol)
}
impl Default for Connection {
    fn default() -> Self {
        Self::new(None)
    }
}
impl Connection {
    /// Injected transports are for local mock/component acceptance. Production
    /// configuration and issuer/keychain exchange are deliberately absent.
    pub fn new(transport: Option<Arc<dyn Transport>>) -> Self {
        let initial = if transport.is_some() {
            State::SignedOut
        } else {
            State::Unconfigured
        };
        Self {
            transport,
            state: Mutex::new(SessionState {
                generation: 0,
                busy: false,
                credential: None,
                view: View {
                    state: initial,
                    last_verified: None,
                    snapshot: None,
                    revocation_pending: false,
                },
                received: None,
                login_in_flight: None,
                pending_revocations: BTreeSet::new(),
            }),
        }
    }
    pub fn from_debug_environment() -> Self {
        #[cfg(debug_assertions)]
        if let Ok(port) = std::env::var("GYRO_CLOUD_MOCK_PORT") {
            if let Ok(transport) = port
                .parse::<u16>()
                .ok()
                .filter(|p| *p >= 1024)
                .ok_or(CloudError::NotConfigured)
                .and_then(transport::LoopbackTransport::debug_port)
            {
                return Self::new(Some(Arc::new(transport)));
            }
        }
        Self::default()
    }
    pub fn view(&self) -> View {
        self.view_at(Utc::now(), Instant::now())
    }
    fn view_at(&self, now: DateTime<Utc>, instant: Instant) -> View {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let mut view = state.view.clone();
        view.revocation_pending = !state.pending_revocations.is_empty();
        if view.state == State::Connected {
            let fresh = state.received.is_some_and(|(received, wall, ttl)| {
                instant
                    .checked_duration_since(received)
                    .is_some_and(|age| age < ttl)
                    && now >= wall - chrono::Duration::seconds(5)
            }) && view
                .snapshot
                .as_ref()
                .is_some_and(|s| s.expires_at > now && s.session.expires_at > now);
            if !fresh {
                view.state = State::Offline;
            }
        }
        view
    }
    pub fn run(&self, action: Action) -> Result<View, CloudError> {
        if matches!(action, Action::Read) {
            return Ok(self.view());
        }
        if matches!(action, Action::SignOut) {
            return self.sign_out();
        }
        let transport = self.transport.as_ref().ok_or(CloudError::NotConfigured)?;
        let login = matches!(
            action,
            Action::SubscribeLite | Action::SubscribePlus | Action::Restore
        );
        let (generation, credential, min_revision) = {
            let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if s.busy {
                return Err(CloudError::Busy);
            }
            if login && s.credential.is_some() {
                return Err(CloudError::AlreadyConnected);
            }
            if !login && s.credential.is_none() {
                return Err(CloudError::Authentication);
            }
            s.generation += 1;
            s.busy = true;
            s.view.state = State::Verifying;
            if login {
                s.login_in_flight = Some(s.generation);
                // A new explicit identity exchange starts a new binding. Old
                // cached data from an expired session is never its authority.
                s.view.snapshot = None;
                s.view.last_verified = None;
                s.received = None;
            }
            (
                s.generation,
                s.credential.clone(),
                s.view.snapshot.as_ref().map_or(0, |v| v.revision),
            )
        };
        let operation = match action {
            Action::SubscribeLite | Action::SubscribePlus => Operation::Subscribe,
            Action::Restore => Operation::Restore,
            Action::CompleteCheckout => Operation::CompleteCheckout,
            Action::CancelRenewal => Operation::CancelRenewal,
            Action::Expire => Operation::Expire,
            Action::ManagedRequest => Operation::ManagedRequest,
            _ => Operation::Snapshot,
        };
        // The mock identity is synthetic and native-owned, not personal input.
        let body = match action {
            Action::SubscribeLite => json!({"email":"desktop@example.test","planId":"lite"}),
            Action::SubscribePlus => json!({"email":"desktop@example.test","planId":"plus"}),
            Action::Restore => json!({"email":"desktop@example.test"}),
            _ => json!({}),
        };
        let outcome = (|| {
            let bytes = transport.request(
                operation,
                credential.as_ref().map(|c| c.token.as_str()),
                body,
            )?;
            let (snapshot, auth) = if login {
                let value: Login = decode(&bytes)?;
                if value.contract_version != VERSION
                    || value.environment != Environment::Local
                    || value.mode != Mode::Mock
                    || value.access_token.len() != 64
                    || !value.access_token.bytes().all(|c| c.is_ascii_hexdigit())
                {
                    return Err(CloudError::Protocol);
                }
                (
                    value.snapshot,
                    Credential {
                        token: value.access_token,
                        account: value.account_id,
                        session: value.session_id,
                    },
                )
            } else {
                (
                    decode::<Snapshot>(&bytes)?,
                    credential.clone().ok_or(CloudError::Authentication)?,
                )
            };
            snapshot.validate(
                Environment::Local,
                Mode::Mock,
                auth.account,
                auth.session,
                min_revision,
                Utc::now(),
            )?;
            Ok((snapshot, auth))
        })();
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if s.generation != generation {
            drop(s);
            // Sign-out may win before a login response arrives. Revoke that
            // discarded new session too, without ever exposing its token.
            if login {
                if let Ok((_, auth)) = outcome {
                    if self.revoke(&auth).is_ok() {
                        self.state
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .pending_revocations
                            .remove(&format!("login:{generation}"));
                    }
                }
            }
            return Err(CloudError::Stale);
        }
        s.busy = false;
        s.login_in_flight = None;
        match outcome {
            Ok((snapshot, auth)) => {
                let now = Utc::now();
                let ttl = match (snapshot.expires_at - now).to_std() {
                    Ok(ttl) if !ttl.is_zero() => ttl.min(Duration::from_secs(60)),
                    _ => {
                        s.view.state = State::Offline;
                        return Err(CloudError::Protocol);
                    }
                };
                s.received = Some((Instant::now(), now, ttl));
                s.credential = Some(auth);
                s.view.state = State::Connected;
                s.view.last_verified = Some(snapshot.verified_at);
                s.view.snapshot = Some(snapshot);
                drop(s);
                Ok(self.view())
            }
            Err(error) => {
                s.view.state = if error == CloudError::Authentication {
                    s.credential = None;
                    State::Expired
                } else if s.credential.is_some() {
                    State::Offline
                } else {
                    State::SignedOut
                };
                Err(error)
            }
        }
    }
    fn revoke(&self, auth: &Credential) -> Result<(), CloudError> {
        let value: Revoked = decode(
            &self
                .transport
                .as_ref()
                .ok_or(CloudError::NotConfigured)?
                .request(Operation::Revoke, Some(&auth.token), json!({}))?,
        )?;
        let now = Utc::now();
        if value.contract_version != VERSION
            || value.session_id != auth.session
            || value.scope != "current-session"
            || value.local_data_deleted
            || (value.revoked_at - now).num_seconds().abs() > 10
        {
            return Err(CloudError::Protocol);
        }
        Ok(())
    }
    fn sign_out(&self) -> Result<View, CloudError> {
        let credential = {
            let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
            s.generation += 1;
            s.busy = false;
            s.received = None;
            if let Some(login) = s.login_in_flight.take() {
                s.pending_revocations.insert(format!("login:{login}"));
            }
            let credential = s.credential.take();
            s.view.state = if self.transport.is_some() {
                State::SignedOut
            } else {
                State::Unconfigured
            };
            s.view.snapshot = None;
            s.view.last_verified = None;
            if let Some(auth) = &credential {
                s.pending_revocations
                    .insert(format!("session:{}", auth.session));
            }
            credential
        };
        if let Some(auth) = credential {
            let result = self.revoke(&auth);
            let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if result.is_ok() {
                s.pending_revocations
                    .remove(&format!("session:{}", auth.session));
            }
            result?;
        }
        Ok(self.view())
    }
}
