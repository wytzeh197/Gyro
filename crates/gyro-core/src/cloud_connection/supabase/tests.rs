use super::*;
use serde_json::Value;
use std::{collections::VecDeque, sync::Mutex};
use store::fixture::MemoryStore;

const PROJECT: &str = "abcdefghijklmnopqrst";
const PUBLIC: &str = "sb_publishable_fixture_public_key_only";
const ADDRESS: &str = "owner@example.test";
fn config() -> StagingConfig {
    StagingConfig::new(PROJECT, PUBLIC).unwrap()
}
fn user(id: Uuid) -> Value {
    json!({"id":id,"email":ADDRESS,"role":"authenticated","is_anonymous":false,
        "email_confirmed_at":Utc::now()-chrono::Duration::seconds(10)})
}
fn tokens(id: Uuid, refresh: &str) -> Value {
    json!({"access_token":"fixture-access-only","refresh_token":refresh,"token_type":"bearer",
        "expires_in":3600,"expires_at":(Utc::now()+chrono::Duration::hours(1)).timestamp(),"user":user(id)})
}
type Call = (Operation, Option<String>, Value);
struct Script {
    steps: Mutex<VecDeque<(Operation, Result<Value, AuthError>)>>,
    calls: Mutex<Vec<Call>>,
}
impl Script {
    fn new(steps: Vec<(Operation, Result<Value, AuthError>)>) -> Arc<Self> {
        Arc::new(Self {
            steps: Mutex::new(steps.into()),
            calls: Mutex::new(vec![]),
        })
    }
}
impl Transport for Script {
    fn request(
        &self,
        operation: Operation,
        token: Option<&str>,
        body: Value,
    ) -> Result<Vec<u8>, AuthError> {
        self.calls
            .lock()
            .unwrap()
            .push((operation, token.map(str::to_owned), body));
        let (expected, result) = self
            .steps
            .lock()
            .unwrap()
            .pop_front()
            .expect("Unexpected Auth request");
        assert_eq!(operation, expected);
        result.map(|value| serde_json::to_vec(&value).unwrap())
    }
}
fn client(wire: Arc<Script>) -> Client {
    Client {
        config: config(),
        wire,
    }
}

#[test]
fn configuration_is_project_pinned_and_rejects_secret_keys_or_arbitrary_origins() {
    assert_eq!(
        config().issuer(),
        "https://abcdefghijklmnopqrst.supabase.co/auth/v1"
    );
    for project in [
        "",
        "https://evil.example",
        "abcdefghijklmnopqrs/",
        "ABCDEFGHIJKLMNOPQRST",
    ] {
        assert!(StagingConfig::new(project, PUBLIC).is_err());
    }
    for key in [
        "",
        "sb_secret_do_not_use",
        "eyJlegacy_anon_jwt",
        "sb_publishable_bad\nheader_injection",
    ] {
        assert!(StagingConfig::new(PROJECT, key).is_err());
    }
    let staging = MacKeychain::staging(&config());
    assert_eq!(staging.account(), "supabase:staging:abcdefghijklmnopqrst");
    // The real OS store is deliberately inaccessible to unit tests.
    assert!(matches!(staging.load(), Err(AuthError::Storage)));
}

#[cfg(debug_assertions)]
#[test]
fn v2_staging_refresh_accounts_never_overlap_production_or_legacy_staging() {
    let cfg = config();
    let legacy = MacKeychain::staging(&cfg).account();
    let production = MacKeychain::production(&cfg).account();
    let first = MacKeychain::v2_staging(&cfg, &"0".repeat(64)).account();
    let another = MacKeychain::v2_staging(&cfg, &"1".repeat(64)).account();
    assert_ne!(legacy, production);
    assert_ne!(first, production);
    assert_ne!(first, legacy);
    assert_ne!(first, another);
    assert!(first.starts_with("supabase:staging-v2:"));
}

#[cfg(debug_assertions)]
#[test]
fn production_acceptance_uses_a_separate_keychain_account_without_os_access() {
    let cfg = config();
    let namespace = Uuid::new_v4();
    let first = MacKeychain::production_acceptance(&cfg, namespace).unwrap();
    let reopened = MacKeychain::production_acceptance(&cfg, namespace).unwrap();
    let another = MacKeychain::production_acceptance(&cfg, Uuid::new_v4()).unwrap();
    assert_eq!(first.account(), reopened.account());
    assert_ne!(first.account(), another.account());
    assert_ne!(first.account(), MacKeychain::production(&cfg).account());
    assert_ne!(first.account(), MacKeychain::staging(&cfg).account());
    assert_ne!(
        first.account(),
        MacKeychain::v2_staging(&cfg, "scope").account()
    );
    assert!(MacKeychain::production_acceptance(&cfg, Uuid::nil()).is_err());
    assert!(matches!(first.load(), Err(AuthError::Storage)));
}

#[test]
fn construction_is_idle_and_restore_codes_never_request_signup() {
    let wire = Script::new(vec![
        (Operation::Code, Ok(json!({}))),
        (Operation::Code, Ok(json!({}))),
    ]);
    let c = client(wire.clone());
    assert!(wire.calls.lock().unwrap().is_empty());
    c.request_email_code(ADDRESS, EntryIntent::Restore).unwrap();
    c.request_email_code(ADDRESS, EntryIntent::Subscribe)
        .unwrap();
    let calls = wire.calls.lock().unwrap();
    assert_eq!(
        calls[0],
        (
            Operation::Code,
            None,
            json!({"email":ADDRESS,"create_user":false})
        )
    );
    assert_eq!(
        calls[1],
        (
            Operation::Code,
            None,
            json!({"email":ADDRESS,"create_user":true})
        )
    );
}

#[test]
fn invalid_inputs_do_not_send_auth_requests() {
    let wire = Script::new(vec![]);
    let c = client(wire.clone());
    for address in [
        "",
        "missing-at",
        "name@domain@other.test",
        " name@example.test",
        "a@b\n.test",
    ] {
        assert!(c
            .request_email_code(address, EntryIntent::Subscribe)
            .is_err());
        assert!(c.verify_email_code(address, "123456").is_err());
    }
    for code in ["", "12345", "1234567", "12x456", "１２３４５６"] {
        assert!(c.verify_email_code(ADDRESS, code).is_err());
    }
    assert!(wire.calls.lock().unwrap().is_empty());
}

#[test]
fn email_code_requires_a_verified_matching_issuer_user() {
    let id = Uuid::new_v4();
    let wire = Script::new(vec![
        (Operation::Verify, Ok(tokens(id, "refresh-one"))),
        (Operation::User, Ok(user(id))),
    ]);
    let session = client(wire.clone())
        .verify_email_code(ADDRESS, "123456")
        .unwrap();
    assert_eq!(session.account_id(), id);
    assert!(session.is_fresh());
    let calls = wire.calls.lock().unwrap();
    assert_eq!(
        calls[0],
        (
            Operation::Verify,
            None,
            json!({"email":ADDRESS,"token":"123456","type":"email"})
        )
    );
    assert_eq!(calls[1].0, Operation::User);
    assert_eq!(calls[1].1.as_deref(), Some("fixture-access-only"));
}

#[test]
fn six_and_eight_digit_ascii_codes_preserve_leading_zeroes_on_both_entrypoints() {
    for code in ["012345", "01234567"] {
        for proof_entrypoint in [false, true] {
            let id = Uuid::new_v4();
            let wire = Script::new(vec![
                (Operation::Verify, Ok(tokens(id, "fixture-refresh"))),
                (Operation::User, Ok(user(id))),
            ]);
            let c = client(wire.clone());
            let session = if proof_entrypoint {
                c.verify_email_proof(ADDRESS, &format!(" \t{code}\n"), EntryIntent::Restore)
            } else {
                c.verify_email_code(ADDRESS, code)
            }
            .unwrap();
            assert_eq!(session.account_id(), id);
            let calls = wire.calls.lock().unwrap();
            assert_eq!(calls.len(), 2);
            assert_eq!(calls[0].0, Operation::Verify);
            assert_eq!(
                calls[0].2,
                json!({"email":ADDRESS,"token":code,"type":"email"})
            );
            assert_eq!(calls[1].0, Operation::User);
        }
    }
}

#[test]
fn unsupported_code_lengths_and_non_ascii_digits_never_contact_auth() {
    let wire = Script::new(vec![]);
    let c = client(wire.clone());
    for code in [
        "1234567",
        "123456789",
        "１２３４５６",
        "１２３４５６７８",
        "١٢٣٤٥٦",
        "١٢٣٤٥٦٧٨",
        "12345１",
        "1234567１",
    ] {
        assert!(matches!(
            c.verify_email_code(ADDRESS, code),
            Err(AuthError::Input)
        ));
        assert!(matches!(
            c.verify_email_proof(ADDRESS, code, EntryIntent::Restore),
            Err(AuthError::Input)
        ));
    }
    assert!(wire.calls.lock().unwrap().is_empty());
}

#[test]
fn an_eight_digit_code_still_requires_supabase_verification() {
    let wire = Script::new(vec![(Operation::Verify, Err(AuthError::Rejected))]);
    assert!(matches!(
        client(wire.clone()).verify_email_proof(ADDRESS, "01234567", EntryIntent::Restore),
        Err(AuthError::Rejected)
    ));
    let calls = wire.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0].2,
        json!({"email":ADDRESS,"token":"01234567","type":"email"})
    );
}

#[test]
fn hostile_or_expired_auth_responses_never_form_a_session() {
    let id = Uuid::new_v4();
    for (pointer, value) in [
        ("/user/email_confirmed_at", json!(null)),
        ("/user/is_anonymous", json!(true)),
        ("/user/role", json!("service_role")),
        ("/user/email", json!("other@example.test")),
        ("/user/id", json!(Uuid::nil())),
        ("/access_token", json!("bad\nheader")),
        ("/refresh_token", json!("")),
        ("/token_type", json!("unknown")),
        ("/expires_in", json!(0)),
        ("/expires_in", json!(7200)),
        (
            "/expires_at",
            json!((Utc::now() - chrono::Duration::seconds(10)).timestamp()),
        ),
    ] {
        let mut response = tokens(id, "refresh-one");
        *response.pointer_mut(pointer).unwrap() = value;
        let c = client(Script::new(vec![(Operation::Verify, Ok(response))]));
        assert!(
            matches!(
                c.verify_email_code(ADDRESS, "123456"),
                Err(AuthError::Protocol)
            ),
            "{pointer}"
        );
    }
    for mutation in ["id", "email", "email_confirmed_at"] {
        let mut verified = user(id);
        verified[mutation] = match mutation {
            "id" => json!(Uuid::new_v4()),
            "email" => json!("other@example.test"),
            _ => json!(null),
        };
        let c = client(Script::new(vec![
            (Operation::Verify, Ok(tokens(id, "refresh-one"))),
            (Operation::User, Ok(verified)),
        ]));
        assert!(matches!(
            c.verify_email_code(ADDRESS, "123456"),
            Err(AuthError::Protocol)
        ));
    }
}

#[test]
fn a_rotated_refresh_credential_can_replace_the_old_one_without_persisting_access() {
    let id = Uuid::new_v4();
    let wire = Script::new(vec![
        (Operation::Verify, Ok(tokens(id, "refresh-one"))),
        (Operation::User, Ok(user(id))),
        (Operation::Refresh, Ok(tokens(id, "refresh-two"))),
        (Operation::User, Ok(user(id))),
        (Operation::Logout, Ok(json!(null))),
    ]);
    let c = client(wire.clone());
    let vault = MemoryStore {
        project_ref: PROJECT.into(),
        ..Default::default()
    };
    let initial = c.verify_email_code(ADDRESS, "123456").unwrap();
    vault.save(&initial).unwrap();
    let saved = vault.load().unwrap().unwrap();
    let renewed = c.refresh(&saved).unwrap();
    vault.save(&renewed).unwrap();
    assert_eq!(vault.load().unwrap().unwrap().refresh_token, "refresh-two");
    let stored = vault.value.lock().unwrap().clone().unwrap();
    assert!(!stored.contains("access_token") && !stored.contains("fixture-access-only"));
    assert!(!stored.contains("refresh-one"));
    assert_eq!(
        wire.calls.lock().unwrap()[2].2,
        json!({"refresh_token":"refresh-one"})
    );
    vault.clear().unwrap();
    assert!(vault.load().unwrap().is_none());
    c.logout_current_session(&renewed).unwrap();
    assert_eq!(
        wire.calls.lock().unwrap().last().unwrap().0,
        Operation::Logout
    );
}

#[test]
fn refresh_cannot_switch_projects_or_accounts_and_is_not_retried_on_failure() {
    let id = Uuid::new_v4();
    let saved = RefreshCredential {
        project_ref: "differentprojectref00".into(),
        account_id: id,
        refresh_token: "refresh-one".into(),
    };
    let wire = Script::new(vec![]);
    assert!(matches!(
        client(wire.clone()).refresh(&saved),
        Err(AuthError::Configuration)
    ));
    assert!(wire.calls.lock().unwrap().is_empty());
    let saved = RefreshCredential {
        project_ref: PROJECT.into(),
        ..saved
    };
    let c = client(Script::new(vec![(
        Operation::Refresh,
        Ok(tokens(Uuid::new_v4(), "refresh-two")),
    )]));
    assert!(matches!(c.refresh(&saved), Err(AuthError::Protocol)));
    let wire = Script::new(vec![(Operation::Refresh, Err(AuthError::Unavailable))]);
    assert!(matches!(
        client(wire.clone()).refresh(&saved),
        Err(AuthError::Unavailable)
    ));
    assert_eq!(wire.calls.lock().unwrap().len(), 1);
}

#[test]
fn keychain_codec_rejects_cross_project_or_corrupt_records_and_surfaces_failures() {
    let vault = MemoryStore {
        project_ref: PROJECT.into(),
        ..Default::default()
    };
    for value in ["not-json", "{}", &"x".repeat(4097)] {
        *vault.value.lock().unwrap() = Some(value.into());
        assert!(matches!(vault.load(), Err(AuthError::Storage)));
    }
    let id = Uuid::new_v4();
    *vault.value.lock().unwrap() = Some(json!({"version":1,"project_ref":"another-project","account_id":id,"refresh_token":"refresh-one"}).to_string());
    assert!(matches!(vault.load(), Err(AuthError::Storage)));
    *vault.fail.lock().unwrap() = true;
    assert!(matches!(vault.clear(), Err(AuthError::Storage)));
    assert!(matches!(vault.load(), Err(AuthError::Storage)));
}

#[test]
fn auth_transport_rejects_redirects_html_large_bodies_and_false_logout_acknowledgements() {
    use transport::read_response;
    for (status, content_type, body) in [
        (302, "application/json", "{}".to_string()),
        (200, "text/html", "<html>proxy</html>".to_string()),
        (200, "application/json-evil", "{}".to_string()),
        (200, "application/json", "x".repeat(32_769)),
    ] {
        let response: ureq::Response = format!(
            "HTTP/1.1 {status} Fixture\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        ).parse().unwrap();
        assert!(matches!(
            read_response(response, Operation::Verify),
            Err(AuthError::Protocol)
        ));
    }
    assert!(read_response(
        ureq::Response::new(204, "No Content", "").unwrap(),
        Operation::Logout
    )
    .is_ok());
    assert!(matches!(
        read_response(
            ureq::Response::new(200, "OK", "{}").unwrap(),
            Operation::Logout
        ),
        Err(AuthError::Protocol)
    ));
}

#[test]
fn default_email_link_is_exchanged_at_the_fixed_issuer_without_following_redirects() {
    let id = Uuid::new_v4();
    let wire = Script::new(vec![
        (Operation::Verify, Ok(tokens(id, "fixture-refresh"))),
        (Operation::User, Ok(user(id))),
    ]);
    let client = Client {
        config: config(),
        wire: wire.clone(),
    };
    client.verify_email_proof(ADDRESS,&format!("https://{PROJECT}.supabase.co/auth/v1/verify?token={}&type=magiclink&redirect_to=https%3A%2F%2Fforeign.invalid","a".repeat(64)),EntryIntent::Restore).unwrap();
    let calls = wire.calls.lock().unwrap();
    assert_eq!(
        calls[0].2,
        json!({"token_hash":"a".repeat(64),"type":"email"})
    );
}
#[test]
fn email_proof_rejects_other_issuers_ambiguous_tokens_and_recovery_links_before_network() {
    let wire = Script::new(vec![]);
    let client = Client {
        config: config(),
        wire: wire.clone(),
    };
    for link in [
        format!(
            "https://evil.invalid/auth/v1/verify?token={}&type=email",
            "a".repeat(64)
        ),
        format!(
            "https://{PROJECT}.supabase.co/auth/v1/verify?token={}&type=recovery",
            "a".repeat(64)
        ),
        format!(
            "https://{PROJECT}.supabase.co/auth/v1/verify?token={}&token_hash={}&type=email",
            "a".repeat(64),
            "a".repeat(64)
        ),
        format!(
            "https://{PROJECT}.supabase.co/auth/v1/verify?token={}&type=email&type=magiclink",
            "a".repeat(64)
        ),
    ] {
        assert!(client
            .verify_email_proof(ADDRESS, &link, EntryIntent::Restore)
            .is_err());
    }
    assert!(wire.calls.lock().unwrap().is_empty());
}

#[cfg(debug_assertions)]
#[test]
fn isolated_acceptance_namespaces_cannot_address_owner_refresh_entries() {
    assert!(MacKeychain::acceptance_namespace(Uuid::nil()).is_err());
    let first = MacKeychain::acceptance_namespace(Uuid::new_v4())
        .unwrap()
        .account();
    let second = MacKeychain::acceptance_namespace(Uuid::new_v4())
        .unwrap()
        .account();
    assert!(first.starts_with("supabase:acceptance-only:abcdefghijklmnopqrst:"));
    assert_ne!(first, second);
    assert_ne!(first, MacKeychain::production(&config()).account());
    assert_ne!(first, MacKeychain::staging(&config()).account());
}
