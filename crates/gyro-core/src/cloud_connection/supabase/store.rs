use super::{secret, AuthError, Session, StagingConfig};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
#[cfg(target_os = "macos")]
pub(crate) mod macos;

/// Opaque native-only refresh credential. Access tokens are never persisted.
pub struct RefreshCredential {
    pub(super) project_ref: String,
    pub(super) account_id: Uuid,
    pub(super) refresh_token: String,
}
pub trait RefreshStore: Send + Sync {
    fn load(&self) -> Result<Option<RefreshCredential>, AuthError>;
    /// Explicit reconnect consumes the stored refresh credential before issuer
    /// dispatch. An ambiguous result is never retried automatically.
    fn take_for_reconnect(&self) -> Result<Option<RefreshCredential>, AuthError> {
        let saved = self.load()?;
        if saved.is_some() { self.clear()?; }
        Ok(saved)
    }
    fn save(&self, session: &Session) -> Result<(), AuthError>;
    fn clear(&self) -> Result<(), AuthError>;
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Stored {
    version: u8,
    project_ref: String,
    account_id: Uuid,
    refresh_token: String,
}
fn encode(session: &Session, project_ref: &str) -> Result<String, AuthError> {
    if session.project_ref != project_ref {
        return Err(AuthError::Configuration);
    }
    serde_json::to_string(&Stored {
        version: 1,
        project_ref: project_ref.into(),
        account_id: session.account_id,
        refresh_token: session.refresh_token.clone(),
    })
    .map_err(|_| AuthError::Storage)
}
fn decode(value: &str, project_ref: &str) -> Result<RefreshCredential, AuthError> {
    if value.len() > 4096 {
        return Err(AuthError::Storage);
    }
    let saved: Stored = serde_json::from_str(value).map_err(|_| AuthError::Storage)?;
    if saved.version != 1
        || saved.project_ref != project_ref
        || saved.account_id.is_nil()
        || !secret(&saved.refresh_token, 2048)
    {
        return Err(AuthError::Storage);
    }
    Ok(RefreshCredential {
        project_ref: saved.project_ref,
        account_id: saved.account_id,
        refresh_token: saved.refresh_token,
    })
}

/// Direct OS Keychain storage, separate from Gyro's provider-key/local-file helper.
/// Only explicit caller operations touch Keychain; construction does no I/O.
pub struct MacKeychain {
    project_ref: String,
    environment: &'static str,
    scope: Option<String>,
}
impl MacKeychain {
    pub(crate) fn v3(config: &StagingConfig, staging: bool, scope: &str) -> Self {
        Self { project_ref: config.project_ref.clone(), environment: if staging { "staging-v3" } else { "production-v3" }, scope: Some(scope.into()) }
    }
    pub fn staging(config: &StagingConfig) -> Self {
        Self {
            project_ref: config.project_ref.clone(),
            environment: "staging",
            scope: None,
        }
    }
    /// Production credentials never share the staging Keychain account.
    pub fn production(config: &StagingConfig) -> Self {
        Self {
            project_ref: config.project_ref.clone(),
            environment: "production-v2",
            scope: None,
        }
    }
    /// Controlled native acceptance keeps real production test credentials out
    /// of the owner's normal entry. This factory is absent from release builds.
    #[cfg(debug_assertions)]
    pub(crate) fn production_acceptance(
        config: &StagingConfig,
        namespace: Uuid,
    ) -> Result<Self, AuthError> {
        if namespace.is_nil() {
            return Err(AuthError::Input);
        }
        Ok(Self {
            project_ref: config.project_ref.clone(),
            environment: "production-acceptance",
            scope: Some(namespace.to_string()),
        })
    }
    #[cfg(debug_assertions)]
    pub(crate) fn v2_staging(config: &StagingConfig, scope: &str) -> Self {
        Self {
            project_ref: config.project_ref.clone(),
            environment: "staging-v2",
            scope: Some(scope.into()),
        }
    }
    /// Isolated synthetic acceptance namespace; never a real project/session.
    #[cfg(debug_assertions)]
    pub(super) fn acceptance_namespace(namespace: Uuid) -> Result<Self, AuthError> {
        if namespace.is_nil() {
            return Err(AuthError::Input);
        }
        Ok(Self {
            project_ref: "abcdefghijklmnopqrst".into(),
            environment: "acceptance-only",
            scope: Some(namespace.to_string()),
        })
    }

    /// Explicit debug-only OS storage probe. Contains no network/Auth operations.
    /// Every process step uses one fresh synthetic namespace, not owner entries.
    #[cfg(all(debug_assertions, target_os = "macos", not(test)))]
    pub fn isolated_acceptance_step(namespace: Uuid, step: &str) -> Result<(), AuthError> {
        let store = Self::acceptance_namespace(namespace)?;
        let initial = "fixture-refresh-initial-no-authority";
        let rotated = "fixture-refresh-rotated-no-authority";
        let account = Uuid::from_u128(1);
        let session = |refresh: &str| Session {
            project_ref: store.project_ref.clone(),
            account_id: account,
            email: "fixture@example.com".into(),
            access_token: "fixture-access-never-persist".into(),
            refresh_token: refresh.into(),
            expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
            received: std::time::Instant::now(),
            ttl: std::time::Duration::from_secs(3600),
        };
        let verify = |expected: &str| -> Result<(), AuthError> {
            let saved = store.load()?.ok_or(AuthError::Storage)?;
            if saved.project_ref != store.project_ref
                || saved.account_id != account
                || saved.refresh_token != expected
            {
                return Err(AuthError::Storage);
            }
            let raw = macos::load(&store.account())?.ok_or(AuthError::Storage)?;
            let value: serde_json::Value =
                serde_json::from_str(&raw).map_err(|_| AuthError::Storage)?;
            if value.get("access_token").is_some() || raw.contains("fixture-access-never-persist") {
                return Err(AuthError::Storage);
            }
            Ok(())
        };
        match step {
            "absent" => {
                if store.load()?.is_none() {
                    Ok(())
                } else {
                    Err(AuthError::Storage)
                }
            }
            "save" => store.save(&session(initial)),
            "load" => verify(initial),
            "rotate" => {
                verify(initial)?;
                store.save(&session(rotated))
            }
            "load-rotated" => verify(rotated),
            "reject-other-project" => {
                let mut wrong = session("fixture-must-not-be-saved");
                wrong.project_ref = "zyxwvutsrqponmlkjihg".into();
                if !matches!(store.save(&wrong), Err(AuthError::Configuration)) {
                    return Err(AuthError::Storage);
                }
                verify(rotated)
            }
            "take-for-reconnect" => {
                let saved = store.take_for_reconnect()?.ok_or(AuthError::Storage)?;
                if saved.refresh_token != rotated || saved.account_id != account || store.load()?.is_some() {
                    return Err(AuthError::Storage);
                }
                Ok(())
            }
            "clear" => store.clear(),
            _ => Err(AuthError::Input),
        }
    }

    pub(super) fn account(&self) -> String {
        let account = format!("supabase:{}:{}", self.environment, self.project_ref);
        self.scope
            .as_ref()
            .map_or(account.clone(), |scope| format!("{account}:{scope}"))
    }

}
impl RefreshStore for MacKeychain {
    fn load(&self) -> Result<Option<RefreshCredential>, AuthError> {
        #[cfg(all(target_os = "macos", not(test)))]
        {
            macos::load(&self.account())?
                .map(|value| decode(&value, &self.project_ref))
                .transpose()
        }
        // No fallback to local files, and no real Keychain access in unit tests.
        #[cfg(any(not(target_os = "macos"), test))]
        Err(AuthError::Storage)
    }
    fn take_for_reconnect(&self) -> Result<Option<RefreshCredential>, AuthError> {
        #[cfg(all(target_os = "macos", not(test)))]
        {
            macos::take_for_reconnect(&self.account())?
                .map(|value| decode(&value, &self.project_ref)).transpose()
        }
        #[cfg(any(not(target_os = "macos"), test))]
        Err(AuthError::Storage)
    }
    fn save(&self, session: &Session) -> Result<(), AuthError> {
        let value = encode(session, &self.project_ref)?;
        #[cfg(all(target_os = "macos", not(test)))]
        {
            macos::save(&self.account(), value)
        }
        #[cfg(any(not(target_os = "macos"), test))]
        {
            let _ = value;
            Err(AuthError::Storage)
        }
    }
    fn clear(&self) -> Result<(), AuthError> {
        #[cfg(all(target_os = "macos", not(test)))]
        {
            macos::clear(&self.account())
        }
        #[cfg(any(not(target_os = "macos"), test))]
        Err(AuthError::Storage)
    }
}

#[cfg(test)]
pub(crate) mod fixture {
    use super::*;
    use std::sync::Mutex;
    #[derive(Default)]
    pub struct MemoryStore {
        pub value: Mutex<Option<String>>,
        pub fail: Mutex<bool>,
        pub project_ref: String,
    }
    impl RefreshStore for MemoryStore {
        fn load(&self) -> Result<Option<RefreshCredential>, AuthError> {
            if *self.fail.lock().unwrap() {
                return Err(AuthError::Storage);
            }
            self.value
                .lock()
                .unwrap()
                .as_deref()
                .map(|v| decode(v, &self.project_ref))
                .transpose()
        }
        fn save(&self, session: &Session) -> Result<(), AuthError> {
            if *self.fail.lock().unwrap() {
                return Err(AuthError::Storage);
            }
            *self.value.lock().unwrap() = Some(encode(session, &self.project_ref)?);
            Ok(())
        }
        fn clear(&self) -> Result<(), AuthError> {
            if *self.fail.lock().unwrap() {
                return Err(AuthError::Storage);
            }
            *self.value.lock().unwrap() = None;
            Ok(())
        }
    }
}
