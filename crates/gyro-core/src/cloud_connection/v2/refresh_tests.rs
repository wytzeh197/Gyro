//! Synthetic coordinator tests: no HTTP, email, OS Keychain, or real credentials.
use super::{tests::snapshot, *};
use crate::cloud_connection::supabase::{
    self,
    store::fixture::MemoryStore,
    transport::{Operation, Transport as AuthTransport},
    AuthError, RefreshCredential,
};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    },
};

const PROJECT: &str = "abcdefghijklmnopqrst";
const ADDRESS: &str = "owner@example.test";

#[derive(Default)]
struct Store {
    inner: MemoryStore,
    loads: AtomicUsize,
    saves: AtomicUsize,
    clears: AtomicUsize,
    forbidden: AtomicBool,
}
impl Store {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: MemoryStore {
                project_ref: PROJECT.into(),
                ..Default::default()
            },
            ..Default::default()
        })
    }
    fn check(&self) {
        assert!(
            !self.forbidden.load(Ordering::SeqCst),
            "Unexpected store I/O"
        );
    }
}
impl RefreshStore for Store {
    fn load(&self) -> Result<Option<RefreshCredential>, AuthError> {
        self.check();
        self.loads.fetch_add(1, Ordering::SeqCst);
        self.inner.load()
    }
    fn save(&self, session: &Session) -> Result<(), AuthError> {
        self.check();
        self.saves.fetch_add(1, Ordering::SeqCst);
        self.inner.save(session)
    }
    fn clear(&self) -> Result<(), AuthError> {
        self.check();
        self.clears.fetch_add(1, Ordering::SeqCst);
        self.inner.clear()
    }
}

struct Gate {
    started: mpsc::Sender<()>,
    resume: Mutex<mpsc::Receiver<()>>,
}
type AuthStep = (Operation, Result<Value, AuthError>);
struct Auth {
    steps: Mutex<VecDeque<AuthStep>>,
    calls: Mutex<Vec<(Operation, Value)>>,
    gate: Option<Gate>,
}
impl Auth {
    fn new(steps: Vec<AuthStep>) -> Arc<Self> {
        Arc::new(Self {
            steps: Mutex::new(steps.into()),
            calls: Mutex::new(vec![]),
            gate: None,
        })
    }
}
impl AuthTransport for Auth {
    fn request(
        &self,
        operation: Operation,
        _: Option<&str>,
        body: Value,
    ) -> Result<Vec<u8>, AuthError> {
        self.calls.lock().unwrap().push((operation, body));
        let (expected, result) = self.steps.lock().unwrap().pop_front().unwrap();
        assert_eq!(operation, expected);
        if operation == Operation::Refresh {
            if let Some(gate) = &self.gate {
                gate.started.send(()).unwrap();
                gate.resume
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap();
            }
        }
        result.map(|value| serde_json::to_vec(&value).unwrap())
    }
}

struct Backend {
    value: Snapshot,
    reads: AtomicUsize,
}
impl Transport for Backend {
    fn request(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        device: Uuid,
        _: Option<&[u8]>,
        _: &'static str,
        _: Option<&str>,
    ) -> Result<Response, Error> {
        assert!(token.is_some());
        assert_eq!(device, self.value.session.device_id);
        let body = match (method, path) {
            ("GET", "/v2/account") => {
                self.reads.fetch_add(1, Ordering::SeqCst);
                serde_json::to_vec(&self.value).unwrap()
            }
            ("POST", "/v2/devices" | "/v2/sessions/revoke") => b"{}".to_vec(),
            _ => panic!("Unexpected backend request"),
        };
        Ok(Response { status: 200, body })
    }
}

fn user(account: Uuid) -> Value {
    json!({"id":account,"email":ADDRESS,"role":"authenticated","is_anonymous":false,
        "email_confirmed_at":Utc::now()-chrono::Duration::seconds(10)})
}
fn refreshed(account: Uuid, session_id: Uuid, refresh: &str) -> Value {
    let config = StagingConfig::new(PROJECT, "sb_publishable_fixture_only_not_a_secret").unwrap();
    let session = supabase::fixture_session(&config, account, session_id);
    json!({"access_token":session.access_token(),"refresh_token":refresh,"token_type":"bearer",
        "expires_in":3600,"expires_at":(Utc::now()+chrono::Duration::hours(1)).timestamp(),"user":user(account)})
}
fn connection(
    store: Arc<Store>,
    auth: Arc<Auth>,
    account: Uuid,
    session_id: Uuid,
    device: Uuid,
) -> Connection {
    let config = Config::production(
        "https://cloud.example",
        PROJECT,
        "sb_publishable_fixture_only_not_a_secret",
    )
    .unwrap();
    let auth_config = config.auth.clone();
    let mut c = Connection::new(
        config,
        store,
        Arc::new(Backend {
            value: snapshot(account, session_id, device),
            reads: AtomicUsize::new(0),
        }),
        device,
    );
    c.auth = Client::test_client(auth_config, auth);
    c
}
fn establish(c: &Connection, account: Uuid, session_id: Uuid, device: Uuid, remember: bool) {
    let config = StagingConfig::new(PROJECT, "sb_publishable_fixture_only_not_a_secret").unwrap();
    let session = Arc::new(supabase::fixture_session(&config, account, session_id));
    let ticket = c.start().unwrap();
    c.commit(
        ticket,
        session,
        snapshot(account, session_id, device),
        remember,
    )
    .unwrap();
}
fn expire(c: &Connection) {
    let mut state = c.inner.lock().unwrap();
    Arc::get_mut(state.session.as_mut().unwrap())
        .unwrap()
        .expire_fixture();
}

#[test]
fn nonremembered_session_rotates_in_memory_without_any_keychain_io() {
    let (account, session, device) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let auth = Auth::new(vec![
        (
            Operation::Refresh,
            Ok(refreshed(account, session, "refresh-two")),
        ),
        (Operation::User, Ok(user(account))),
        (
            Operation::Refresh,
            Ok(refreshed(account, session, "refresh-three")),
        ),
        (Operation::User, Ok(user(account))),
    ]);
    let store = Store::new();
    let c = connection(store.clone(), auth.clone(), account, session, device);
    establish(&c, account, session, device, false);
    assert_eq!(store.clears.load(Ordering::SeqCst), 1);
    store.forbidden.store(true, Ordering::SeqCst);
    for _ in 0..2 {
        expire(&c);
        let view = c.refresh().unwrap().view;
        assert_eq!(view.state, "connected");
        assert!(!view.remember_session);
        assert!(store.inner.value.lock().unwrap().is_none());
    }
    // A fresh-token status refresh also has no credential-store dependency.
    c.refresh().unwrap();
    let calls = auth.calls.lock().unwrap();
    assert_eq!(calls.len(), 4);
    assert_eq!(calls[0].1, json!({"refresh_token":"fixture-refresh-only"}));
    assert_eq!(calls[2].1, json!({"refresh_token":"refresh-two"}));
    assert_eq!(store.loads.load(Ordering::SeqCst), 0);
    assert_eq!(store.saves.load(Ordering::SeqCst), 0);
    assert_eq!(store.clears.load(Ordering::SeqCst), 1);
    drop(calls);

    // A new process has no remembered credential and must request email proof.
    store.forbidden.store(false, Ordering::SeqCst);
    let restarted = connection(store.clone(), Auth::new(vec![]), account, session, device);
    assert_eq!(
        restarted.restore().unwrap().view.auth_stage.as_deref(),
        Some("email")
    );
    assert_eq!(store.saves.load(Ordering::SeqCst), 0);
}

#[test]
fn remembered_rotation_remains_available_only_through_explicit_restart_restore() {
    let (account, session, device) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let store = Store::new();
    let auth = Auth::new(vec![
        (
            Operation::Refresh,
            Ok(refreshed(account, session, "refresh-two")),
        ),
        (Operation::User, Ok(user(account))),
    ]);
    let c = connection(store.clone(), auth.clone(), account, session, device);
    establish(&c, account, session, device, true);
    expire(&c);
    assert!(c.refresh().unwrap().view.remember_session);
    assert_eq!(store.loads.load(Ordering::SeqCst), 1);
    assert_eq!(store.clears.load(Ordering::SeqCst), 1);
    assert_eq!(store.saves.load(Ordering::SeqCst), 2);
    assert!(store
        .inner
        .value
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .contains("refresh-two"));
    let before = store.loads.load(Ordering::SeqCst);
    let restored_auth = Auth::new(vec![
        (
            Operation::Refresh,
            Ok(refreshed(account, session, "refresh-three")),
        ),
        (Operation::User, Ok(user(account))),
    ]);
    let restarted = connection(
        store.clone(),
        restored_auth.clone(),
        account,
        session,
        device,
    );
    assert_eq!(restarted.view().state, "signed-out");
    assert_eq!(store.loads.load(Ordering::SeqCst), before);
    assert!(restored_auth.calls.lock().unwrap().is_empty());
    let view = restarted.restore().unwrap().view;
    assert_eq!(view.state, "connected");
    assert!(view.remember_session);
    assert_eq!(
        restored_auth.calls.lock().unwrap()[0].1,
        json!({"refresh_token":"refresh-two"})
    );
    let saved = store.inner.value.lock().unwrap().clone().unwrap();
    assert!(saved.contains("refresh-three"));
    assert!(!saved.contains("access_token") && !saved.contains("refresh-two"));
}

#[test]
fn ambiguous_refresh_response_never_retries_the_consumed_credential() {
    for remember in [false, true] {
        let (account, session, device) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let store = Store::new();
        let auth = Auth::new(vec![(Operation::Refresh, Err(AuthError::Unavailable))]);
        let c = connection(store.clone(), auth.clone(), account, session, device);
        establish(&c, account, session, device, remember);
        expire(&c);
        assert!(matches!(c.refresh(), Err(Error::Unavailable)));
        assert!(matches!(c.refresh(), Err(Error::Authentication)));
        assert_eq!(auth.calls.lock().unwrap().len(), 1);
        assert!(c.view().snapshot.is_none());
        assert_eq!(c.view().state, "signed-out");
        assert!(store.inner.value.lock().unwrap().is_none());
    }
}

#[test]
fn concurrent_refresh_is_single_flight_and_signout_blocks_late_credential_commit() {
    let (account, session, device) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let store = Store::new();
    let (started_tx, started_rx) = mpsc::channel();
    let (resume_tx, resume_rx) = mpsc::channel();
    let auth = Arc::new(Auth {
        steps: Mutex::new(
            vec![
                (
                    Operation::Refresh,
                    Ok(refreshed(account, session, "refresh-two")),
                ),
                (Operation::Logout, Ok(json!(null))),
                (Operation::User, Ok(user(account))),
            ]
            .into(),
        ),
        calls: Mutex::new(vec![]),
        gate: Some(Gate {
            started: started_tx,
            resume: Mutex::new(resume_rx),
        }),
    });
    let c = Arc::new(connection(
        store.clone(),
        auth.clone(),
        account,
        session,
        device,
    ));
    establish(&c, account, session, device, true);
    expire(&c);
    let refreshing = {
        let c = c.clone();
        std::thread::spawn(move || c.refresh().map(|_| ()))
    };
    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(matches!(c.refresh(), Err(Error::Busy)));
    assert_eq!(c.sign_out().unwrap().view.state, "signed-out");
    assert!(!c.view().revocation_pending);
    resume_tx.send(()).unwrap();
    assert!(matches!(refreshing.join().unwrap(), Err(Error::Stale)));
    assert_eq!(
        auth.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(op, _)| *op == Operation::Refresh)
            .count(),
        1
    );
    assert!(store.inner.value.lock().unwrap().is_none());
    assert_eq!(store.saves.load(Ordering::SeqCst), 1);
    assert_eq!(c.view().state, "signed-out");
    assert!(c.view().snapshot.is_none());
}
