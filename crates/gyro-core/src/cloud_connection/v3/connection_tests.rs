use super::*;
use crate::cloud_connection::supabase::{
    self,
    store::fixture::MemoryStore,
    transport::{Operation, Transport},
    AuthError,
};
use std::sync::{atomic::AtomicUsize, Barrier};

struct AuthFixture {
    account: Uuid,
    fail_logout: bool,
    logout_calls: AtomicUsize,
    refresh_calls: AtomicUsize,
    refresh_failure: AtomicBool,
    session_id: Uuid,
    refresh_tokens_used: Mutex<Vec<String>>,
    blocked_refresh: Mutex<Option<(Arc<Barrier>, Arc<Barrier>)>>,
    blocked_profile: Option<(Arc<Barrier>, Arc<Barrier>)>,
}
impl Transport for AuthFixture {
    fn request(
        &self,
        operation: Operation,
        _token: Option<&str>,
        body: Value,
    ) -> Result<Vec<u8>, AuthError> {
        match operation {
            Operation::Code => Ok(b"{}".to_vec()),
            Operation::Refresh => {
                self.refresh_calls.fetch_add(1, Ordering::SeqCst);
                self.refresh_tokens_used
                    .lock()
                    .unwrap()
                    .push(body["refresh_token"].as_str().unwrap().into());
                let gate = self.blocked_refresh.lock().unwrap().clone();
                if let Some((entered, release)) = gate {
                    entered.wait();
                    release.wait();
                }
                if self.refresh_failure.load(Ordering::SeqCst) {
                    return Err(AuthError::Unavailable);
                }
                let config = StagingConfig::new(
                    "abcdefghijklmnopqrst",
                    "sb_publishable_fixture_public_key_only",
                )
                .unwrap();
                let session = supabase::fixture_session(&config, self.account, self.session_id);
                serde_json::to_vec(&json!({"access_token":session.access_token(),"refresh_token":"fixture-v3-rotated-refresh-only","token_type":"bearer","expires_in":3600,"expires_at":(chrono::Utc::now()+chrono::Duration::hours(1)).timestamp(),"user":{"id":self.account,"email":"fixture@example.test","role":"authenticated","is_anonymous":false,"email_confirmed_at":"2026-01-01T00:00:00Z"}})).map_err(|_|AuthError::Protocol)
            }
            Operation::Logout => {
                self.logout_calls.fetch_add(1, Ordering::SeqCst);
                if self.fail_logout {
                    Err(AuthError::Unavailable)
                } else {
                    Ok(b"{}".to_vec())
                }
            }
            Operation::User | Operation::UpdateUser => {
                if let Some((entered, release)) = &self.blocked_profile {
                    entered.wait();
                    release.wait();
                }
                serde_json::to_vec(&json!({"id":self.account,"email":"fixture@example.test","role":"authenticated","is_anonymous":false,"email_confirmed_at":"2026-01-01T00:00:00Z","user_metadata":{"display_name":"Fixture"}})).map_err(|_| AuthError::Protocol)
            }
            _ => panic!("Unexpected Auth operation in local Settings regression"),
        }
    }
}
fn fixture(
    fail_logout: bool,
    blocked_profile: Option<(Arc<Barrier>, Arc<Barrier>)>,
) -> (
    tempfile::TempDir,
    Arc<Connection>,
    Arc<MemoryStore>,
    Arc<AuthFixture>,
) {
    let temp = tempfile::tempdir().unwrap();
    let config = StagingConfig::new(
        "abcdefghijklmnopqrst",
        "sb_publishable_fixture_public_key_only",
    )
    .unwrap();
    let account = Uuid::new_v4();
    let session = Arc::new(supabase::fixture_session(&config, account, Uuid::new_v4()));
    let store = Arc::new(MemoryStore {
        project_ref: "abcdefghijklmnopqrst".into(),
        ..Default::default()
    });
    store.save(&session).unwrap();
    let wire = Arc::new(AuthFixture {
        account,
        fail_logout,
        logout_calls: AtomicUsize::new(0),
        refresh_calls: AtomicUsize::new(0),
        refresh_failure: AtomicBool::new(true),
        session_id: session.session_id().unwrap(),
        refresh_tokens_used: Mutex::new(Vec::new()),
        blocked_refresh: Mutex::new(None),
        blocked_profile,
    });
    let connection = Arc::new(Connection {
        // Closed loopback port; never calls hosted Cloud or Supabase.
        origin: "https://127.0.0.1:0".into(),
        auth: Client::test_client(config, wire.clone()),
        store: store.clone(),
        outbox: Outbox::at(temp.path().join("outbox")),
        device: Uuid::new_v4(),
        refresh_gate: Mutex::new(()),
        state: Mutex::new(State {
            generation: 0,
            session: Some(session),
            registered: true,
            email: Some("fixture@example.test".into()),
            intent: None,
            remember: true,
            previews: HashMap::new(),
            transfers: HashMap::new(),
        }),
    });
    (temp, connection, store, wire)
}
#[test]
fn failed_remote_signout_still_clears_local_authority_previews_and_running_transfers() {
    let (temp, connection, store, wire) = fixture(true, None);
    let project = temp.path().join("project");
    std::fs::create_dir(&project).unwrap();
    std::fs::write(project.join("README.md"), b"local files survive sign-out").unwrap();
    connection.preview_project(&project).unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    connection
        .state
        .lock()
        .unwrap()
        .transfers
        .insert(Uuid::new_v4(), cancel.clone());
    assert!(matches!(connection.sign_out(), Err(Error::Unavailable)));
    assert!(!connection.view().connected);
    assert!(!connection.view().registered);
    assert!(connection.view().account_id.is_none());
    let state = connection.state.lock().unwrap();
    assert!(state.previews.is_empty());
    assert!(state.transfers.is_empty());
    assert!(state.email.is_none());
    assert!(cancel.load(Ordering::SeqCst));
    assert!(store.value.lock().unwrap().is_none());
    assert_eq!(wire.logout_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        std::fs::read(project.join("README.md")).unwrap(),
        b"local files survive sign-out"
    );
}
#[test]
fn keychain_failure_is_reported_after_clearing_memory_and_attempting_issuer_revocation() {
    let (_temp, connection, store, wire) = fixture(false, None);
    *store.fail.lock().unwrap() = true;
    assert!(matches!(connection.sign_out(), Err(Error::Keychain)));
    assert!(!connection.view().connected);
    assert!(connection.consent_identity().is_err());
    assert_eq!(wire.logout_calls.load(Ordering::SeqCst), 1);
}
#[test]
fn profile_requests_finishing_after_signout_do_not_repopulate_account_state() {
    for update in [false, true] {
        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let (_temp, connection, _store, _wire) =
            fixture(false, Some((entered.clone(), release.clone())));
        let pending = connection.clone();
        let task = std::thread::spawn(move || {
            if update {
                pending.update_profile("Fixture")
            } else {
                pending.profile()
            }
        });
        entered.wait();
        connection.sign_out().unwrap();
        release.wait();
        assert!(matches!(task.join().unwrap(), Err(Error::Identity)));
        assert!(!connection.view().connected);
    }
}

#[test]
fn expired_signin_is_distinct_from_foreign_transfer_and_preserves_prepared_files() {
    let (temp, connection, _store, wire) = fixture(false, None);
    let root = temp.path().join("project");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("README.md"), b"preserve this reviewed save").unwrap();
    let preview = connection.preview_project(&root).unwrap();
    let ticket = serde_json::from_value(preview["ticket"].clone()).unwrap();
    connection
        .prepare(ticket, Uuid::new_v4(), None, "Expiry fixture".into(), true)
        .unwrap();
    let (_, session) = connection.session().unwrap();
    let pending = connection
        .outbox
        .pending(session.account_id(), connection.device)
        .unwrap();
    assert_eq!(pending.len(), 1);
    let prepared = connection
        .outbox
        .root()
        .join(format!("{}.pack", pending[0].prepared.id));
    let before = std::fs::read(&prepared).unwrap();
    let mut expired = supabase::fixture_session(
        &StagingConfig::new(
            "abcdefghijklmnopqrst",
            "sb_publishable_fixture_public_key_only",
        )
        .unwrap(),
        session.account_id(),
        Uuid::new_v4(),
    );
    expired.expire_fixture();
    connection.state.lock().unwrap().session = Some(Arc::new(expired));
    assert!(!connection.view().connected);
    assert!(matches!(
        connection.profile(),
        Err(Error::SessionUnavailable)
    ));
    assert!(matches!(
        connection.pending(),
        Err(Error::SessionUnavailable)
    ));
    assert!(matches!(
        connection
            .outbox
            .read(pending[0].request_id, Uuid::new_v4(), connection.device),
        Err(Error::Identity)
    ));
    assert_eq!(std::fs::read(prepared).unwrap(), before);
    assert_eq!(wire.logout_calls.load(Ordering::SeqCst), 0);
}

fn expire_connection(connection: &Connection) {
    let mut state = connection.state.lock().unwrap();
    Arc::get_mut(state.session.as_mut().unwrap())
        .unwrap()
        .expire_fixture();
}

#[test]
fn simultaneous_expired_operations_rotate_once_without_keychain_when_not_remembered() {
    let (_temp, connection, store, wire) = fixture(false, None);
    connection.state.lock().unwrap().remember = false;
    wire.refresh_failure.store(false, Ordering::SeqCst);
    *store.fail.lock().unwrap() = true; // Every Keychain operation would fail.
    expire_connection(&connection);
    let start = Arc::new(Barrier::new(9));
    let tasks: Vec<_> = (0..8)
        .map(|_| {
            let c = connection.clone();
            let gate = start.clone();
            std::thread::spawn(move || {
                gate.wait();
                c.profile()
            })
        })
        .collect();
    start.wait();
    for task in tasks {
        assert_eq!(
            task.join().unwrap().unwrap()["accountId"],
            wire.account.to_string()
        );
    }
    assert_eq!(wire.refresh_calls.load(Ordering::SeqCst), 1);
    assert!(connection.view().connected);
    assert!(!connection.state.lock().unwrap().remember);
}

#[test]
fn remembered_rotation_saves_the_new_credential_and_unknown_results_are_not_retried() {
    let (_temp, connection, store, wire) = fixture(false, None);
    wire.refresh_failure.store(false, Ordering::SeqCst);
    expire_connection(&connection);
    assert!(connection.refreshed_view().connected);
    expire_connection(&connection);
    assert!(connection.profile().is_ok());
    assert_eq!(
        *wire.refresh_tokens_used.lock().unwrap(),
        vec!["fixture-refresh-only", "fixture-v3-rotated-refresh-only"]
    );
    assert!(store.value.lock().unwrap().is_some());
    wire.refresh_failure.store(true, Ordering::SeqCst);
    expire_connection(&connection);
    assert!(matches!(
        connection.profile(),
        Err(Error::SessionUnavailable)
    ));
    assert!(matches!(
        connection.profile(),
        Err(Error::SessionUnavailable)
    ));
    assert_eq!(wire.refresh_calls.load(Ordering::SeqCst), 3);
    assert!(store.value.lock().unwrap().is_none());
    assert!(!connection.view().connected);
}

#[test]
fn refresh_finishing_after_signout_cannot_restore_authority_or_keychain() {
    let (_temp, connection, store, wire) = fixture(false, None);
    wire.refresh_failure.store(false, Ordering::SeqCst);
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    *wire.blocked_refresh.lock().unwrap() = Some((entered.clone(), release.clone()));
    expire_connection(&connection);
    let c = connection.clone();
    let task = std::thread::spawn(move || c.profile());
    entered.wait();
    assert!(connection.sign_out().is_ok());
    assert!(!connection.view().connected);
    release.wait();
    assert!(matches!(task.join().unwrap(), Err(Error::Identity)));
    assert!(!connection.view().connected);
    assert!(store.value.lock().unwrap().is_none());
    assert_eq!(wire.logout_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn failed_persistence_after_rotation_never_leaves_live_local_authority() {
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let (_temp, connection, store, wire) = fixture(false, Some((entered.clone(), release.clone())));
    wire.refresh_failure.store(false, Ordering::SeqCst);
    expire_connection(&connection);
    let c = connection.clone();
    let task = std::thread::spawn(move || c.profile());
    entered.wait();
    *store.fail.lock().unwrap() = true;
    release.wait();
    assert!(matches!(task.join().unwrap(), Err(Error::Keychain)));
    assert!(!connection.view().connected);
    assert!(store.value.lock().unwrap().is_none());
    assert_eq!(wire.logout_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn explicit_signin_invalidates_an_older_inflight_rotation() {
    let (_temp, connection, store, wire) = fixture(false, None);
    wire.refresh_failure.store(false, Ordering::SeqCst);
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    *wire.blocked_refresh.lock().unwrap() = Some((entered.clone(), release.clone()));
    expire_connection(&connection);
    let c = connection.clone();
    let task = std::thread::spawn(move || c.profile());
    entered.wait();
    connection
        .begin("fixture@example.test", false, false)
        .unwrap();
    release.wait();
    assert!(matches!(task.join().unwrap(), Err(Error::Identity)));
    assert!(!connection.view().connected);
    assert!(store.value.lock().unwrap().is_none());
    assert_eq!(wire.logout_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        connection.state.lock().unwrap().email.as_deref(),
        Some("fixture@example.test")
    );
}

#[test]
fn unexpected_remembered_credentials_are_preserved_without_provider_dispatch() {
    let config = StagingConfig::new(
        "abcdefghijklmnopqrst",
        "sb_publishable_fixture_public_key_only",
    )
    .unwrap();
    let (_temp, connection, store, wire) = fixture(false, None);
    let other = supabase::fixture_session(&config, Uuid::new_v4(), Uuid::new_v4());
    store.save(&other).unwrap();
    expire_connection(&connection);
    assert!(matches!(
        connection.profile(),
        Err(Error::SessionUnavailable)
    ));
    assert_eq!(wire.refresh_calls.load(Ordering::SeqCst), 0);
    assert!(store.value.lock().unwrap().is_some());
    // A stale credential for the same account must not overwrite or revoke a
    // newer in-memory rotation either.
    let (_temp, connection, store, wire) = fixture(false, None);
    wire.refresh_failure.store(false, Ordering::SeqCst);
    expire_connection(&connection);
    assert!(connection.profile().is_ok());
    let stale = supabase::fixture_session(&config, wire.account, wire.session_id);
    store.save(&stale).unwrap();
    expire_connection(&connection);
    assert!(matches!(
        connection.profile(),
        Err(Error::SessionUnavailable)
    ));
    assert_eq!(wire.refresh_calls.load(Ordering::SeqCst), 1);
    assert_eq!(wire.logout_calls.load(Ordering::SeqCst), 0);
    assert!(store.value.lock().unwrap().is_some());
}


#[test]
fn reconnect_keychain_failure_is_actionable_and_never_dispatches_refresh() {
    let (temp, connection, store, wire) = fixture(false, None);
    let prepared = temp.path().join("prepared-local-copy");
    std::fs::write(&prepared, b"preserve-local-data").unwrap();
    *store.fail.lock().unwrap() = true;
    let error = connection.restore_session().unwrap_err();
    assert!(matches!(error, Error::Keychain));
    assert!(error.to_string().contains("new email code"));
    assert_eq!(wire.refresh_calls.load(Ordering::SeqCst), 0);
    assert!(!connection.view().connected);
    assert!(store.value.lock().unwrap().is_some());
    assert_eq!(std::fs::read(prepared).unwrap(), b"preserve-local-data");
}

#[test]
fn v3_reuses_reviewed_production_identity_without_accepting_staging_or_arbitrary_projects() {
    assert!(reviewed_production_project("hqyahsvqjizmsfxclxzd"));
    assert!(!reviewed_production_project("tpskieaxnzltdmpebdfz"));
    assert!(!reviewed_production_project("abcdefghijklmnopqrst"));
    assert!(!reviewed_production_project(""));
    // The independently controlled v3 release switch remains closed.
    let config: Config = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"), "/../../config/cloud-v3.json"
    ))).unwrap();
    assert!(!config.enabled);
}

#[test]
fn reconnect_keeps_verified_rotation_during_cloud_outage_without_local_authority() {
    let (temp, connection, store, wire) = fixture(false, None);
    wire.refresh_failure.store(false, Ordering::SeqCst);
    let prepared = temp.path().join("prepared-local-copy");
    std::fs::write(&prepared, b"preserve-local-data").unwrap();
    assert!(matches!(connection.restore_session(), Err(Error::Unavailable)));
    assert!(!connection.view().connected);
    assert!(!connection.view().registered);
    assert!(connection.view().account_id.is_none());
    assert_eq!(wire.logout_calls.load(Ordering::SeqCst), 0);
    assert!(store.value.lock().unwrap().is_some());
    // A deliberate retry uses the new credential. There is no automatic retry
    // of either the issuer exchange or device-registration mutation.
    assert!(matches!(connection.restore_session(), Err(Error::Unavailable)));
    assert_eq!(wire.refresh_calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        *wire.refresh_tokens_used.lock().unwrap(),
        vec!["fixture-refresh-only", "fixture-v3-rotated-refresh-only"]
    );
    assert_eq!(std::fs::read(prepared).unwrap(), b"preserve-local-data");
    // A genuinely ambiguous issuer failure still consumes the selected token.
    wire.refresh_failure.store(true, Ordering::SeqCst);
    assert!(matches!(connection.restore_session(), Err(Error::SessionUnavailable)));
    assert!(store.value.lock().unwrap().is_none());
    assert!(matches!(connection.restore_session(), Err(Error::SessionUnavailable)));
    assert_eq!(wire.refresh_calls.load(Ordering::SeqCst), 3);
}

#[test]
fn signout_during_reconnect_cannot_save_rotation_after_cloud_outage() {
    let (_temp, connection, store, wire) = fixture(false, None);
    wire.refresh_failure.store(false, Ordering::SeqCst);
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    *wire.blocked_refresh.lock().unwrap() = Some((entered.clone(), release.clone()));
    let c = connection.clone();
    let task = std::thread::spawn(move || c.restore_session());
    entered.wait();
    connection.sign_out().unwrap();
    release.wait();
    assert!(matches!(task.join().unwrap(), Err(Error::Identity)));
    assert!(!connection.view().connected);
    assert!(!connection.view().registered);
    assert!(store.value.lock().unwrap().is_none());
    assert_eq!(wire.logout_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn reconnect_reports_failed_rotation_persistence_during_cloud_outage() {
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let (_temp, connection, store, wire) =
        fixture(false, Some((entered.clone(), release.clone())));
    wire.refresh_failure.store(false, Ordering::SeqCst);
    let c = connection.clone();
    let task = std::thread::spawn(move || c.restore_session());
    entered.wait();
    *store.fail.lock().unwrap() = true;
    release.wait();
    assert!(matches!(task.join().unwrap(), Err(Error::Keychain)));
    assert!(!connection.view().connected);
    assert!(store.value.lock().unwrap().is_none());
    assert_eq!(wire.logout_calls.load(Ordering::SeqCst), 1);
}
