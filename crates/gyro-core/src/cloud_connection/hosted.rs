//! Explicit debug staging coordinator. Credentials never enter a WebView result.
use super::{
    contract::{Environment, Mode, Snapshot, VERSION},
    supabase::{self, Client, EntryIntent, MacKeychain, RefreshStore, Session, StagingConfig},
    Action, State, View,
};
use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    io::Read,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use uuid::Uuid;
#[derive(Debug, thiserror::Error)]
pub enum HostedError {
    #[error("The staging Cloud response could not be verified. Local work remains available.")]
    Protocol,
    #[error("The staging Cloud service is unavailable. Local work remains available.")]
    Unavailable,
    #[error("Another sign-in or subscription action is running.")]
    Busy,
    #[error("That sign-in action was cancelled. Start again.")]
    Stale,
    #[error(
        "Choose Subscribe or Restore, then enter your email and its original sign-in link or code."
    )]
    Input,
    #[error(transparent)]
    Auth(#[from] supabase::AuthError),
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedView {
    #[serde(flatten)]
    pub base: View,
    pub environment: &'static str,
    pub auth_stage: Option<&'static str>,
}
pub struct Outcome {
    pub view: HostedView,
    pub open_url: Option<String>,
}
#[derive(Clone)]
struct Pending {
    email: String,
    plan: Option<String>,
    intent: Option<Value>,
}
struct Inner {
    generation: u64,
    busy: bool,
    session: Option<Arc<Session>>,
    pending: Option<Pending>,
    plan: Option<String>,
    view: HostedView,
    received: Option<Instant>,
    checkout_id: Uuid,
}
trait Backend: Send + Sync {
    fn call(
        &self,
        path: &str,
        session: Option<&Session>,
        body: Option<Value>,
    ) -> Result<Value, HostedError>;
}
struct Loopback {
    origin: String,
    agent: ureq::Agent,
}
impl Backend for Loopback {
    fn call(
        &self,
        path: &str,
        session: Option<&Session>,
        body: Option<Value>,
    ) -> Result<Value, HostedError> {
        let mut request = self
            .agent
            .request(
                if body.is_some() { "POST" } else { "GET" },
                &format!("{}{}", self.origin, path),
            )
            .set("Accept", "application/json")
            .set("Cache-Control", "no-store");
        if let Some(session) = session {
            request = request.set(
                "Authorization",
                &format!("Bearer {}", session.access_token()),
            );
        }
        if path == "/v1/ai/requests" {
            request = request.set("Idempotency-Key", &Uuid::new_v4().to_string());
        }
        let response = if let Some(body) = body {
            request.send_json(body)
        } else {
            request.call()
        }
        .map_err(|_| HostedError::Unavailable)?;
        if !(200..300).contains(&response.status())
            || response.header("Cache-Control") != Some("no-store")
            || !response
                .header("Content-Type")
                .is_some_and(|s| s.starts_with("application/json"))
        {
            return Err(HostedError::Protocol);
        }
        let mut bytes = Vec::new();
        response
            .into_reader()
            .take(32769)
            .read_to_end(&mut bytes)
            .map_err(|_| HostedError::Unavailable)?;
        if bytes.len() > 32768 {
            return Err(HostedError::Protocol);
        }
        serde_json::from_slice(&bytes).map_err(|_| HostedError::Protocol)
    }
}
pub struct HostedConnection {
    auth: Arc<Client>,
    store: Arc<dyn RefreshStore>,
    backend: Arc<dyn Backend>,
    inner: Mutex<Inner>,
}
impl HostedConnection {
    pub fn debug_port(port: u16) -> Result<Self, HostedError> {
        if !cfg!(debug_assertions) || port < 1024 {
            return Err(HostedError::Input);
        }
        let project = option_env!("GYRO_CLOUD_LEGACY_STAGING_AUTH_PROJECT")
            .ok_or(HostedError::Input)?;
        let public_key = option_env!("GYRO_CLOUD_LEGACY_STAGING_AUTH_PUBLISHABLE_KEY")
            .ok_or(HostedError::Input)?;
        let config = StagingConfig::new(project, public_key)?;
        let store = Arc::new(MacKeychain::staging(&config));
        let backend = Arc::new(Loopback {
            origin: format!("http://127.0.0.1:{port}"),
            agent: ureq::AgentBuilder::new()
                .redirects(0)
                .try_proxy_from_env(false)
                .timeout(Duration::from_secs(8))
                .timeout_connect(Duration::from_secs(2))
                .build(),
        });
        Ok(Self::new(Arc::new(Client::new(config)), store, backend))
    }
    fn new(auth: Arc<Client>, store: Arc<dyn RefreshStore>, backend: Arc<dyn Backend>) -> Self {
        Self {
            auth,
            store,
            backend,
            inner: Mutex::new(Inner {
                generation: 0,
                busy: false,
                session: None,
                pending: None,
                plan: None,
                view: HostedView {
                    base: View {
                        state: State::SignedOut,
                        last_verified: None,
                        snapshot: None,
                        revocation_pending: false,
                    },
                    environment: "staging",
                    auth_stage: None,
                },
                received: None,
                checkout_id: Uuid::new_v4(),
            }),
        }
    }
    pub fn view(&self) -> HostedView {
        let s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut view = s.view.clone();
        if view.base.state == State::Connected
            && (!s
                .received
                .is_some_and(|t| t.elapsed() < Duration::from_secs(45))
                || !view.base.snapshot.as_ref().is_some_and(|v| {
                    v.expires_at > Utc::now() && v.session.expires_at > Utc::now()
                }))
        {
            view.base.state = State::Offline;
        }
        view
    }
    fn start(&self) -> Result<u64, HostedError> {
        let mut s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if s.busy {
            return Err(HostedError::Busy);
        }
        s.generation += 1;
        s.busy = true;
        s.view.base.state = State::Verifying;
        Ok(s.generation)
    }
    fn failed(&self, ticket: u64) {
        let mut s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if s.generation == ticket {
            s.busy = false;
            s.view.base.state = if s.session.is_some() {
                State::Offline
            } else {
                State::SignedOut
            };
        }
    }
    fn snapshot(&self, session: &Session, revision: u64) -> Result<Snapshot, HostedError> {
        let value = self
            .backend
            .call("/v1/account/snapshot", Some(session), None)?;
        let snapshot: Snapshot =
            serde_json::from_value(value).map_err(|_| HostedError::Protocol)?;
        snapshot
            .validate(
                Environment::Staging,
                Mode::Mock,
                session.account_id(),
                session.session_id()?,
                revision,
                Utc::now(),
            )
            .map_err(|_| HostedError::Protocol)?;
        Ok(snapshot)
    }
    fn commit(
        &self,
        ticket: u64,
        session: Arc<Session>,
        snapshot: Snapshot,
        persist: bool,
    ) -> Result<HostedView, HostedError> {
        let mut s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if s.generation != ticket {
            return Err(HostedError::Stale);
        }
        // The same lock fences credential writes against local sign-out.
        if persist {
            if let Err(error) = self.store.save(&session) {
                let _ = self.store.clear();
                return Err(error.into());
            }
        }
        s.session = Some(session);
        if s.plan.is_none()
            && snapshot.subscription.state == super::contract::SubscriptionState::CheckoutPending
        {
            s.plan = snapshot.subscription.plan_id.clone();
        }
        s.busy = false;
        s.pending = None;
        s.view.auth_stage = None;
        s.view.base.state = State::Connected;
        s.view.base.last_verified = Some(snapshot.verified_at);
        s.view.base.snapshot = Some(snapshot);
        s.received = Some(Instant::now());
        Ok(s.view.clone())
    }
    fn revoke(&self, session: &Session) -> bool {
        let backend = self
            .backend
            .call("/v1/session/revoke", Some(session), Some(json!({})))
            .is_ok_and(|value| {
                value["contractVersion"] == VERSION
                    && value["sessionId"]
                        .as_str()
                        .and_then(|id| Uuid::parse_str(id).ok())
                        == session.session_id().ok()
                    && value["scope"] == "current-session"
                    && value["localDataDeleted"] == false
            });
        let issuer = self.auth.logout_current_session(session).is_ok();
        backend && issuer
    }
    fn saved_for_refresh(
        &self,
        ticket: u64,
    ) -> Result<Option<supabase::RefreshCredential>, HostedError> {
        let s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if s.generation != ticket {
            return Err(HostedError::Stale);
        }
        let saved = self.store.load()?;
        if saved.is_some() {
            self.store.clear()?;
        }
        Ok(saved)
    }
    fn establish(
        &self,
        ticket: u64,
        session: Arc<Session>,
        revision: u64,
        persist: bool,
    ) -> Result<HostedView, HostedError> {
        let result = self
            .snapshot(&session, revision)
            .and_then(|snapshot| self.commit(ticket, session.clone(), snapshot, persist));
        if result.is_err() && persist {
            self.revoke(&session);
        }
        result
    }
    pub fn begin(&self, email: &str) -> Result<Outcome, HostedError> {
        if email.len() > 254 {
            return Err(HostedError::Input);
        }
        let ticket = self.start()?;
        let plan = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .plan
            .clone();
        let result = (|| {
            let intent = if let Some(plan) = &plan {
                let intent = self.backend.call(
                    "/v1/subscription-intents",
                    None,
                    Some(json!({"plan":plan})),
                )?;
                if intent["intentId"]
                    .as_str()
                    .and_then(|v| Uuid::parse_str(v).ok())
                    .is_none()
                    || !intent["secret"]
                        .as_str()
                        .is_some_and(|v| v.len() >= 32 && v.len() <= 256)
                {
                    return Err(HostedError::Protocol);
                }
                Some(json!({"intentId":intent["intentId"],"secret":intent["secret"]}))
            } else {
                None
            };
            self.auth.request_email_code(
                email,
                if plan.is_some() {
                    EntryIntent::Subscribe
                } else {
                    EntryIntent::Restore
                },
            )?;
            let mut s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if s.generation != ticket {
                return Err(HostedError::Stale);
            }
            s.busy = false;
            s.pending = Some(Pending {
                email: email.into(),
                plan,
                intent,
            });
            s.view.auth_stage = Some("proof");
            s.view.base.state = State::SignedOut;
            Ok(Outcome {
                view: s.view.clone(),
                open_url: None,
            })
        })();
        if result.is_err() {
            self.failed(ticket);
        }
        result
    }
    pub fn verify(&self, proof: &str) -> Result<Outcome, HostedError> {
        let ticket = self.start()?;
        let pending = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pending
            .clone();
        let result = (|| {
            let pending = pending.ok_or(HostedError::Input)?;
            let session = Arc::new(self.auth.verify_email_proof(
                &pending.email,
                proof,
                if pending.plan.is_some() {
                    EntryIntent::Subscribe
                } else {
                    EntryIntent::Restore
                },
            )?);
            let establish = (|| {
                if let Some(intent) = pending.intent {
                    let created =
                        self.backend
                            .call("/v1/accounts", Some(&session), Some(intent))?;
                    if created["accountId"].as_str() != Some(&session.account_id().to_string())
                        || created["paidAccessGranted"] != false
                    {
                        return Err(HostedError::Protocol);
                    }
                }
                let snapshot = self.snapshot(&session, 0)?;
                self.commit(ticket, session.clone(), snapshot, true)
            })();
            match establish {
                Ok(view) => {
                    if pending.plan.is_some() {
                        self.checkout()
                    } else {
                        Ok(Outcome {
                            view,
                            open_url: None,
                        })
                    }
                }
                Err(e) => {
                    self.revoke(&session);
                    Err(e)
                }
            }
        })();
        if result.is_err() {
            self.failed(ticket);
        }
        result
    }
    fn checkout(&self) -> Result<Outcome, HostedError> {
        self.authenticated(Action::CompleteCheckout)
    }
    fn authenticated(&self, action: Action) -> Result<Outcome, HostedError> {
        let ticket = self.start()?;
        let (session, revision, plan, request_id) = {
            let s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            (
                s.session.clone(),
                s.view.base.snapshot.as_ref().map_or(0, |v| v.revision),
                s.plan.clone(),
                s.checkout_id,
            )
        };
        let result = (|| {
            let old = session.ok_or(HostedError::Input)?;
            let rotated = !old.is_fresh();
            let session = if rotated {
                let saved = self.saved_for_refresh(ticket)?.ok_or(HostedError::Input)?;
                Arc::new(self.auth.refresh(&saved)?)
            } else {
                old
            };
            let url_result: Result<Option<String>, HostedError> = (|| {
                Ok(match action {
                    Action::CompleteCheckout => {
                        let plan = plan.ok_or(HostedError::Input)?;
                        let value = self.backend.call(
                            "/v1/billing/checkout",
                            Some(&session),
                            Some(json!({"plan":plan,"requestId":request_id})),
                        )?;
                        Some(checked_url(
                            value["url"].as_str().ok_or(HostedError::Protocol)?,
                            false,
                        )?)
                    }
                    Action::ManageBilling => {
                        let value = self.backend.call(
                            "/v1/billing/portal",
                            Some(&session),
                            Some(json!({})),
                        )?;
                        Some(checked_url(
                            value["url"].as_str().ok_or(HostedError::Protocol)?,
                            true,
                        )?)
                    }
                    Action::ManagedRequest => {
                        self.backend.call("/v1/ai/requests",Some(&session),Some(json!({"model":"mock/check-planner","prompt":"Staging subscription test only.","maxOutputTokens":64,"consentVersion":"managed-ai-v1"})))?;
                        None
                    }
                    _ => None,
                })
            })();
            let url = match url_result {
                Ok(url) => url,
                Err(error) => {
                    if rotated {
                        self.revoke(&session);
                    }
                    return Err(error);
                }
            };
            let view = self.establish(ticket, session, revision, rotated)?;
            Ok(Outcome {
                view,
                open_url: url,
            })
        })();
        if result.is_err() {
            self.failed(ticket);
        }
        result
    }
    pub fn run(&self, action: Action) -> Result<Outcome, HostedError> {
        if matches!(action, Action::Read) {
            return Ok(Outcome {
                view: self.view(),
                open_url: None,
            });
        }
        if matches!(action, Action::SignOut) {
            let (session, clear) = {
                let mut s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
                s.generation += 1;
                s.busy = false;
                s.pending = None;
                s.plan = None;
                s.received = None;
                s.view.base.state = State::SignedOut;
                s.view.base.snapshot = None;
                s.view.base.last_verified = None;
                s.view.auth_stage = None;
                s.checkout_id = Uuid::new_v4();
                let session = s.session.take();
                let clear = self.store.clear();
                s.view.base.revocation_pending = clear.is_err() || session.is_some();
                (session, clear)
            };
            let revoked = session.as_ref().is_none_or(|s| self.revoke(s));
            let mut s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            s.view.base.revocation_pending = clear.is_err() || !revoked;
            return Ok(Outcome {
                view: s.view.clone(),
                open_url: None,
            });
        }
        if matches!(action, Action::SubscribeLite | Action::SubscribePlus) {
            let mut s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if s.busy {
                return Err(HostedError::Busy);
            }
            s.generation += 1;
            s.plan = Some(
                if matches!(action, Action::SubscribeLite) {
                    "lite"
                } else {
                    "plus"
                }
                .into(),
            );
            s.pending = None;
            if s.session.is_some() {
                drop(s);
                return self.checkout();
            }
            s.view.auth_stage = Some("email");
            return Ok(Outcome {
                view: s.view.clone(),
                open_url: None,
            });
        }
        if matches!(action, Action::Restore) {
            if self
                .inner
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .session
                .is_some()
            {
                return Err(HostedError::Input);
            }
            let ticket = self.start()?;
            let result = (|| match self.saved_for_refresh(ticket)? {
                Some(saved) => {
                    let session = Arc::new(self.auth.refresh(&saved)?);
                    let view = self.establish(ticket, session, 0, true)?;
                    Ok(Outcome {
                        view,
                        open_url: None,
                    })
                }
                None => {
                    let mut s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
                    if s.generation != ticket {
                        return Err(HostedError::Stale);
                    }
                    s.busy = false;
                    s.plan = None;
                    s.view.auth_stage = Some("email");
                    s.view.base.state = State::SignedOut;
                    Ok(Outcome {
                        view: s.view.clone(),
                        open_url: None,
                    })
                }
            })();
            if result.is_err() {
                self.failed(ticket);
            }
            return result;
        }
        if matches!(action, Action::CancelRenewal | Action::Expire) {
            return Err(HostedError::Input);
        }
        self.authenticated(action)
    }
}
fn checked_url(value: &str, portal: bool) -> Result<String, HostedError> {
    let url = url::Url::parse(value).map_err(|_| HostedError::Protocol)?;
    // Portal URLs are opaque. The authenticated staging server verifies
    // the Stripe response's livemode=false and the bound customer.
    let token = |s: &str, min: usize| {
        s.len() >= min
            && s.len() <= 4096
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    };
    let host = if portal {
        "billing.stripe.com"
    } else {
        "checkout.stripe.com"
    };
    let path_ok = if portal {
        url.path()
            .strip_prefix("/p/session/")
            .is_some_and(|s| token(s, 12))
            || (url.path() == "/p/session" && {
                let pairs: Vec<_> = url.query_pairs().collect();
                pairs.len() == 1 && pairs[0].0 == "secret" && token(&pairs[0].1, 16)
            })
    } else {
        url.path().starts_with("/c/pay/cs_test_")
    };
    if value.len() > 8192
        || url.scheme() != "https"
        || url.host_str() != Some(host)
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !path_ok
    {
        return Err(HostedError::Protocol);
    }
    Ok(value.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use supabase::store::fixture::MemoryStore;
    use supabase::transport::{Operation, Transport};
    struct AuthWire;
    impl Transport for AuthWire {
        fn request(
            &self,
            operation: Operation,
            _token: Option<&str>,
            _body: Value,
        ) -> Result<Vec<u8>, supabase::AuthError> {
            assert_eq!(operation, Operation::Logout);
            Ok(vec![])
        }
    }
    struct Wire {
        account: Uuid,
        session: Uuid,
        started: Mutex<Option<std::sync::mpsc::Sender<()>>>,
        release: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
    }
    impl Backend for Wire {
        fn call(
            &self,
            path: &str,
            _session: Option<&Session>,
            _body: Option<Value>,
        ) -> Result<Value, HostedError> {
            if path == "/v1/session/revoke" {
                return Ok(
                    json!({"contractVersion":VERSION,"sessionId":self.session,"scope":"current-session","localDataDeleted":false}),
                );
            }
            assert_eq!(path, "/v1/account/snapshot");
            if let Some(sender) = self.started.lock().unwrap().take() {
                sender.send(()).unwrap();
            }
            if let Some(receiver) = self.release.lock().unwrap().take() {
                receiver.recv().unwrap();
            }
            let now = Utc::now();
            Ok(
                json!({"contractVersion":VERSION,"environment":"staging","mode":"mock","snapshotId":Uuid::new_v4(),"revision":1,"verifiedAt":now,"expiresAt":now+chrono::Duration::seconds(45),"account":{"id":self.account,"emailVerified":true,"status":"enabled"},"session":{"id":self.session,"expiresAt":now+chrono::Duration::hours(1),"revocationCheckedAt":now},"subscription":{"state":"none","planId":null,"source":"none","paidThrough":null,"renewalAt":null,"cancellationAt":null},"capabilities":{"managedAi":{"allowed":false,"reason":"no-subscription"},"selectedSync":{"allowed":false,"reason":"not-available"},"backup":{"allowed":false,"reason":"not-available"},"sharing":{"allowed":false,"reason":"not-available"}},"currentPeriod":null}),
            )
        }
    }
    fn setup(
        block: bool,
    ) -> (
        Arc<HostedConnection>,
        Arc<MemoryStore>,
        std::sync::mpsc::Receiver<()>,
        std::sync::mpsc::Sender<()>,
    ) {
        let config = StagingConfig::new(
            "abcdefghijklmnopqrst",
            "sb_publishable_fixture_public_key_only",
        )
        .unwrap();
        let account = Uuid::new_v4();
        let session = Uuid::new_v4();
        let value = Arc::new(supabase::fixture_session(&config, account, session));
        let store = Arc::new(MemoryStore {
            project_ref: "abcdefghijklmnopqrst".into(),
            ..Default::default()
        });
        store.save(&value).unwrap();
        let (started_s, started_r) = std::sync::mpsc::channel();
        let (release_s, release_r) = std::sync::mpsc::channel();
        let wire = Arc::new(Wire {
            account,
            session,
            started: Mutex::new(if block { Some(started_s) } else { None }),
            release: Mutex::new(if block { Some(release_r) } else { None }),
        });
        let c = Arc::new(HostedConnection::new(
            Arc::new(Client::test_client(config, Arc::new(AuthWire))),
            store.clone(),
            wire,
        ));
        c.inner.lock().unwrap().session = Some(value);
        (c, store, started_r, release_s)
    }
    #[test]
    fn late_snapshot_cannot_reconnect_or_rewrite_keychain_after_signout() {
        let (c, store, started, release) = setup(true);
        let worker = c.clone();
        let job = std::thread::spawn(move || worker.run(Action::Refresh));
        started.recv_timeout(Duration::from_secs(2)).unwrap();
        let view = c.run(Action::SignOut).unwrap().view;
        assert_eq!(view.base.state, State::SignedOut);
        assert!(store.value.lock().unwrap().is_none());
        release.send(()).unwrap();
        assert!(matches!(job.join().unwrap(), Err(HostedError::Stale)));
        assert_eq!(c.view().base.state, State::SignedOut);
        assert!(c.view().base.snapshot.is_none());
        assert!(store.value.lock().unwrap().is_none());
    }
    #[test]
    fn rotating_refresh_is_removed_before_exchange_and_generation_fences_keychain_access() {
        let (c, store, _, _) = setup(false);
        let ticket = c.start().unwrap();
        assert!(c.saved_for_refresh(ticket).unwrap().is_some());
        assert!(store.value.lock().unwrap().is_none());
        c.inner.lock().unwrap().generation += 1;
        assert!(matches!(
            c.saved_for_refresh(ticket),
            Err(HostedError::Stale)
        ));
    }
    #[test]
    fn billing_urls_restrict_destinations() {
        for url in [
            "https://evil.invalid/c/pay/cs_test_bad",
            "https://checkout.stripe.com.evil.invalid/c/pay/cs_test_bad",
            "https://checkout.stripe.com/c/pay/cs_live_bad",
            "http://checkout.stripe.com/c/pay/cs_test_bad",
            "https://user@checkout.stripe.com/c/pay/cs_test_bad",
        ] {
            assert!(checked_url(url, false).is_err());
        }
        assert!(checked_url("https://checkout.stripe.com/c/pay/cs_test_fixture", false).is_ok());
        assert!(checked_url("https://billing.stripe.com/p/session/test_fixture", true).is_ok());
        assert!(checked_url(
            "https://billing.stripe.com/p/session?secret=opaque_SandboxSessionFixture",
            true
        )
        .is_ok());
        assert!(checked_url("https://billing.stripe.com/p/session?secret=opaque_SandboxSessionFixture&secret=duplicate", true).is_err());
        assert!(checked_url(
            "https://billing.stripe.com/p/session/opaque_SandboxFixture",
            true
        )
        .is_ok());
        assert!(checked_url(
            "https://billing.stripe.com/p/session/opaque_Fixture/extra",
            true
        )
        .is_err());
        assert!(checked_url("https://evil.invalid/p/session/opaque_SandboxFixture", true).is_err());
    }
}
