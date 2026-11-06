use super::*;
use serde_json::Value;
use std::{collections::VecDeque, sync::Barrier};

fn fixture(name: &str) -> Value {
    let value: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../docs/contracts/fixtures/cloud-connection-mock.json"
    )))
    .unwrap();
    value["snapshots"][name].clone()
}
fn active() -> Value {
    let mut s = fixture("active");
    let now = Utc::now();
    for (pointer, date) in [
        ("/verifiedAt", now),
        ("/expiresAt", now + chrono::Duration::seconds(50)),
        ("/session/expiresAt", now + chrono::Duration::hours(1)),
        ("/session/revocationCheckedAt", now),
        ("/subscription/paidThrough", now + chrono::Duration::days(1)),
        ("/currentPeriod/startsAt", now - chrono::Duration::hours(1)),
        ("/currentPeriod/endsAt", now + chrono::Duration::days(1)),
    ] {
        *s.pointer_mut(pointer).unwrap() = json!(date.to_rfc3339());
    }
    s
}
fn login(s: Value) -> Value {
    json!({"contractVersion":VERSION,"environment":"local","mode":"mock",
    "accountId":s["account"]["id"],"sessionId":s["session"]["id"],"accessToken":"a".repeat(64),"snapshot":s})
}
fn revoked(s: &Value) -> Value {
    json!({"contractVersion":VERSION,"sessionId":s["session"]["id"],
    "revokedAt":Utc::now(),"scope":"current-session","localDataDeleted":false})
}
fn validate(value: Value) -> Result<(), CloudError> {
    let s: Snapshot = decode(&serde_json::to_vec(&value).unwrap())?;
    s.validate(
        Environment::Local,
        Mode::Mock,
        s.account.id,
        s.session.id,
        0,
        Utc::now(),
    )
}
#[test]
fn actual_mock_producer_snapshots_satisfy_native_semantics() {
    for name in ["pending", "active", "cancelled", "exhausted", "expired"] {
        let s: Snapshot = serde_json::from_value(fixture(name)).unwrap();
        s.validate(
            Environment::Local,
            Mode::Mock,
            s.account.id,
            s.session.id,
            0,
            s.verified_at,
        )
        .unwrap();
    }
}
#[test]
fn malformed_and_inconsistent_snapshots_never_become_verified() {
    let s = active();
    validate(s.clone()).unwrap();
    for (path, value) in [
        ("/contractVersion", json!("unknown")),
        ("/environment", json!("production")),
        ("/mode", json!("live")),
        ("/revision", json!(9_007_199_254_740_992_u64)),
        ("/account/emailVerified", json!(false)),
        ("/account/status", json!("disabled")),
        ("/account/id", json!("bad")),
        ("/subscription/state", json!("expired")),
        ("/subscription/source", json!("none")),
        ("/subscription/paidThrough", json!(null)),
        ("/subscription/planId", json!(null)),
        ("/capabilities/managedAi/reason", json!("exhausted")),
        ("/currentPeriod/availableMicros", json!(49_999)),
        ("/currentPeriod/spentMicros", json!(-1)),
        ("/currentPeriod/reservedMicros", json!(0.5)),
        ("/currentPeriod", json!(null)),
        (
            "/expiresAt",
            json!(Utc::now() - chrono::Duration::seconds(1)),
        ),
        (
            "/expiresAt",
            json!(Utc::now() + chrono::Duration::seconds(120)),
        ),
        (
            "/verifiedAt",
            json!(Utc::now() + chrono::Duration::minutes(1)),
        ),
        (
            "/session/revocationCheckedAt",
            json!(Utc::now() - chrono::Duration::minutes(1)),
        ),
        (
            "/session/expiresAt",
            json!(Utc::now() + chrono::Duration::seconds(10)),
        ),
        (
            "/currentPeriod/endsAt",
            json!(Utc::now() - chrono::Duration::seconds(1)),
        ),
    ] {
        let mut bad = s.clone();
        *bad.pointer_mut(path).unwrap() = value;
        assert_eq!(validate(bad), Err(CloudError::Protocol), "{path}");
    }
    for key in ["currentPeriod", "contractVersion"] {
        let mut bad = s.clone();
        bad.as_object_mut().unwrap().remove(key);
        assert!(validate(bad).is_err());
    }
    let mut bad = s.clone();
    bad["subscription"]
        .as_object_mut()
        .unwrap()
        .remove("renewalAt");
    assert!(validate(bad).is_err());
    let mut bad = s.clone();
    bad["accessToken"] = json!("no tokens in snapshot");
    assert!(validate(bad).is_err());
    let snap: Snapshot = serde_json::from_value(s).unwrap();
    assert!(snap
        .validate(
            Environment::Local,
            Mode::Mock,
            Uuid::new_v4(),
            snap.session.id,
            0,
            Utc::now()
        )
        .is_err());
    assert!(snap
        .validate(
            Environment::Local,
            Mode::Mock,
            snap.account.id,
            Uuid::new_v4(),
            0,
            Utc::now()
        )
        .is_err());
    assert!(snap
        .validate(
            Environment::Local,
            Mode::Mock,
            snap.account.id,
            snap.session.id,
            snap.revision + 1,
            Utc::now()
        )
        .is_err());
}
#[test]
fn exhaustion_preserves_independent_capabilities_and_oversettled_usage() {
    let mut v = active();
    v["currentPeriod"]["spentMicros"] = json!(60_000);
    v["currentPeriod"]["availableMicros"] = json!(0);
    v["capabilities"]["managedAi"] = json!({"allowed":false,"reason":"exhausted"});
    v["capabilities"]["selectedSync"] = json!({"allowed":true,"reason":"entitled"});
    validate(v).unwrap();
}

struct Script {
    steps: Mutex<VecDeque<(Operation, Result<Value, CloudError>)>>,
    calls: Mutex<Vec<Operation>>,
    block: Option<(Operation, Arc<Barrier>, Arc<Barrier>)>,
}
impl Script {
    fn new(steps: Vec<(Operation, Result<Value, CloudError>)>) -> Self {
        Self {
            steps: Mutex::new(steps.into()),
            calls: Mutex::new(vec![]),
            block: None,
        }
    }
}
impl Transport for Script {
    fn request(&self, op: Operation, token: Option<&str>, _: Value) -> Result<Vec<u8>, CloudError> {
        self.calls.lock().unwrap().push(op);
        assert_eq!(
            token.is_none(),
            matches!(op, Operation::Subscribe | Operation::Restore)
        );
        let (expected, value) = self
            .steps
            .lock()
            .unwrap()
            .pop_front()
            .expect("Unexpected network operation");
        assert_eq!(expected, op);
        if let Some((blocked, started, resume)) = &self.block {
            if *blocked == op {
                started.wait();
                resume.wait();
            }
        }
        value.map(|v| serde_json::to_vec(&v).unwrap())
    }
}
#[test]
fn absent_config_and_fresh_reads_never_contact_a_service() {
    let disabled = Connection::default();
    assert_eq!(disabled.view().state, State::Unconfigured);
    assert_eq!(
        disabled.run(Action::SubscribePlus).unwrap_err(),
        CloudError::NotConfigured
    );
    let wire = Arc::new(Script::new(vec![]));
    let c = Connection::new(Some(wire.clone()));
    for _ in 0..3 {
        assert_eq!(c.run(Action::Read).unwrap().state, State::SignedOut);
    }
    c.run(Action::SignOut).unwrap();
    assert!(wire.calls.lock().unwrap().is_empty());
}
#[test]
fn snapshot_expiry_and_clock_rollback_cannot_keep_a_connected_view() {
    let c = Connection::new(Some(Arc::new(Script::new(vec![(
        Operation::Subscribe,
        Ok(login(active())),
    )]))));
    let view = c.run(Action::SubscribePlus).unwrap();
    assert_eq!(view.state, State::Connected);
    assert!(!serde_json::to_string(&view)
        .unwrap()
        .contains(&"a".repeat(64)));
    assert_eq!(
        c.view_at(Utc::now(), Instant::now() + Duration::from_secs(61))
            .state,
        State::Offline
    );
    assert_eq!(
        c.view_at(Utc::now() - chrono::Duration::minutes(1), Instant::now())
            .state,
        State::Offline
    );
    assert_eq!(
        c.view_at(Utc::now() + chrono::Duration::minutes(1), Instant::now())
            .state,
        State::Offline
    );
}
#[test]
fn failed_refresh_keeps_last_verified_data_but_never_connected_authority() {
    for error in [
        CloudError::Unavailable,
        CloudError::Authentication,
        CloudError::Protocol,
    ] {
        let c = Connection::new(Some(Arc::new(Script::new(vec![
            (Operation::Subscribe, Ok(login(active()))),
            (Operation::Snapshot, Err(error)),
        ]))));
        c.run(Action::SubscribePlus).unwrap();
        assert_eq!(c.run(Action::Refresh).unwrap_err(), error);
        let view = c.view();
        assert_eq!(
            view.state,
            if error == CloudError::Authentication {
                State::Expired
            } else {
                State::Offline
            }
        );
        assert!(view.last_verified.is_some());
    }
}

#[test]
fn explicit_restore_after_expired_identity_uses_a_new_session_binding() {
    let mut old = active();
    old["revision"] = json!(100);
    let mut new = active();
    new["session"]["id"] = json!(Uuid::new_v4());
    let c = Connection::new(Some(Arc::new(Script::new(vec![
        (Operation::Subscribe, Ok(login(old))),
        (Operation::Snapshot, Err(CloudError::Authentication)),
        (Operation::Restore, Ok(login(new.clone()))),
    ]))));
    c.run(Action::SubscribePlus).unwrap();
    assert!(c.run(Action::Refresh).is_err());
    let restored = c.run(Action::Restore).unwrap();
    assert_eq!(restored.state, State::Connected);
    assert_eq!(
        restored.snapshot.unwrap().session.id.to_string(),
        new["session"]["id"].as_str().unwrap()
    );
}
#[test]
fn revision_regression_and_wrong_account_do_not_replace_the_previous_snapshot() {
    for mutation in ["revision", "account"] {
        let mut first = active();
        first["revision"] = json!(10);
        let mut next = first.clone();
        if mutation == "revision" {
            next["revision"] = json!(9);
        } else {
            next["account"]["id"] = json!(Uuid::new_v4());
        }
        let c = Connection::new(Some(Arc::new(Script::new(vec![
            (Operation::Subscribe, Ok(login(first))),
            (Operation::Snapshot, Ok(next)),
        ]))));
        c.run(Action::SubscribePlus).unwrap();
        assert_eq!(c.run(Action::Refresh).unwrap_err(), CloudError::Protocol);
        assert_eq!(c.view().snapshot.unwrap().revision, 10);
        assert_eq!(c.view().state, State::Offline);
    }
}
#[test]
fn signout_clears_credentials_even_if_revocation_fails() {
    let c = Connection::new(Some(Arc::new(Script::new(vec![
        (Operation::Subscribe, Ok(login(active()))),
        (Operation::Revoke, Err(CloudError::Unavailable)),
    ]))));
    c.run(Action::SubscribePlus).unwrap();
    assert_eq!(c.run(Action::SignOut).unwrap_err(), CloudError::Unavailable);
    let view = c.view();
    assert_eq!(view.state, State::SignedOut);
    assert!(view.snapshot.is_none());
    assert!(view.revocation_pending);
    assert_eq!(
        c.run(Action::Refresh).unwrap_err(),
        CloudError::Authentication
    );
}
#[test]
fn restore_keeps_an_earlier_unconfirmed_revocation_separate_from_current_identity() {
    let previous = active();
    let mut restored = previous.clone();
    restored["session"]["id"] = json!(Uuid::new_v4());
    let c = Connection::new(Some(Arc::new(Script::new(vec![
        (Operation::Subscribe, Ok(login(previous))),
        (Operation::Revoke, Err(CloudError::Unavailable)),
        (Operation::Restore, Ok(login(restored.clone()))),
    ]))));
    c.run(Action::SubscribePlus).unwrap();
    assert_eq!(c.run(Action::SignOut).unwrap_err(), CloudError::Unavailable);
    let view = c.run(Action::Restore).unwrap();
    assert_eq!(view.state, State::Connected);
    assert!(view.revocation_pending);
    assert_eq!(
        view.snapshot.unwrap().session.id.to_string(),
        restored["session"]["id"].as_str().unwrap()
    );
}

#[test]
fn signout_wins_over_delayed_refresh_and_delayed_login() {
    for block_login in [false, true] {
        let s = active();
        let started = Arc::new(Barrier::new(2));
        let resume = Arc::new(Barrier::new(2));
        let mut steps = vec![(Operation::Subscribe, Ok(login(s.clone())))];
        if !block_login {
            steps.push((Operation::Snapshot, Ok(s.clone())));
        }
        steps.push((Operation::Revoke, Ok(revoked(&s))));
        let mut transport = Script::new(steps);
        transport.block = Some((
            if block_login {
                Operation::Subscribe
            } else {
                Operation::Snapshot
            },
            started.clone(),
            resume.clone(),
        ));
        let c = Arc::new(Connection::new(Some(Arc::new(transport))));
        if !block_login {
            c.run(Action::SubscribePlus).unwrap();
        }
        let worker = c.clone();
        let task = std::thread::spawn(move || {
            worker.run(if block_login {
                Action::SubscribePlus
            } else {
                Action::Refresh
            })
        });
        started.wait();
        c.run(Action::SignOut).unwrap();
        assert_eq!(c.view().state, State::SignedOut);
        if block_login {
            assert!(c.view().revocation_pending);
        }
        resume.wait();
        assert_eq!(task.join().unwrap().unwrap_err(), CloudError::Stale);
        let view = c.view();
        assert_eq!(view.state, State::SignedOut);
        assert!(view.snapshot.is_none());
        assert!(!view.revocation_pending);
    }
}

#[test]
fn loopback_transport_rejects_redirects_and_oversized_responses() {
    use std::io::{Read, Write};
    for oversized in [false, true] {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let sentinel = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        sentinel.set_nonblocking(true).unwrap();
        let destination = sentinel.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut input = [0; 8192];
            let _ = stream.read(&mut input);
            let reply = if oversized {
                format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: 40000\r\nConnection: close\r\n\r\n{}","x".repeat(40000))
            } else {
                format!("HTTP/1.1 302 Found\r\nLocation: http://{destination}/leak\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            };
            let _ = stream.write_all(reply.as_bytes());
        });
        let wire = transport::LoopbackTransport::debug_port(port).unwrap();
        assert!(wire
            .request(Operation::Snapshot, Some(&"b".repeat(64)), json!({}))
            .is_err());
        server.join().unwrap();
        assert_eq!(
            sentinel.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }
}
