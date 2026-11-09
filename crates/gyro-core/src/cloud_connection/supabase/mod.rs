//! Staging Auth protocol adapter. Not wired to app startup or paid capabilities.
//! The Cloud coordinator must own generation checks and credential commits;
//! an Auth session alone never establishes a subscription or service account.
pub(crate) mod store;
#[cfg(test)]
mod tests;
pub(crate) mod transport;

use base64::Engine;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::json;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
pub use store::{MacKeychain, RefreshCredential, RefreshStore};
use transport::{HttpTransport, Operation, Transport};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum AuthError {
    #[error("Supabase staging configuration is invalid.")]
    Configuration,
    #[error("Enter a valid email address and six- or eight-digit verification code, or paste the original sign-in link.")]
    Input,
    #[error("Cloud sign-in could not be verified. Request a new code or sign in again.")]
    Rejected,
    #[error("Cloud sign-in is temporarily unavailable. Local work remains available.")]
    Unavailable,
    #[error("Too many sign-in attempts. Wait before requesting another code.")]
    RateLimited,
    #[error("The Cloud sign-in response could not be verified.")]
    Protocol,
    #[error("The Cloud refresh credential could not be accessed in macOS Keychain.")]
    Storage,
}

/// Explicit native configuration. No environment lookup or startup I/O.
/// Only hosted Supabase project origins and public publishable keys are accepted.
#[derive(Clone)]
pub struct StagingConfig {
    project_ref: String,
    publishable_key: String,
}
impl StagingConfig {
    pub fn new(project_ref: &str, publishable_key: &str) -> Result<Self, AuthError> {
        if project_ref.len() != 20
            || !project_ref
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            || !publishable_key.starts_with("sb_publishable_")
            || !(30..=256).contains(&publishable_key.len())
            || !publishable_key
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        {
            return Err(AuthError::Configuration);
        }
        Ok(Self {
            project_ref: project_ref.into(),
            publishable_key: publishable_key.into(),
        })
    }
    pub fn issuer(&self) -> String {
        format!("https://{}.supabase.co/auth/v1", self.project_ref)
    }
}

#[derive(Clone, Copy)]
pub enum EntryIntent {
    Subscribe,
    Restore,
}

#[derive(Deserialize)]
struct User {
    id: Uuid,
    email: String,
    email_confirmed_at: Option<DateTime<Utc>>,
    role: String,
    #[serde(default)]
    is_anonymous: bool,
}
impl User {
    fn validate(&self) -> Result<(), AuthError> {
        if self.id.is_nil()
            || self.is_anonymous
            || self.role != "authenticated"
            || email(&self.email).is_err()
            || !self
                .email_confirmed_at
                .is_some_and(|t| t <= Utc::now() + chrono::Duration::seconds(5))
        {
            return Err(AuthError::Protocol);
        }
        Ok(())
    }
}
#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    token_type: String,
    expires_in: u64,
    expires_at: Option<DateTimeSeconds>,
    user: User,
}
#[derive(Deserialize)]
#[serde(transparent)]
struct DateTimeSeconds(i64);

/// No Debug or Serialize: reusable credentials never form a webview result.
pub struct Session {
    project_ref: String,
    account_id: Uuid,
    /// The issuer-verified address, kept so the UI can say who is signed in.
    email: String,
    access_token: String,
    refresh_token: String,
    expires_at: DateTime<Utc>,
    received: Instant,
    ttl: Duration,
}
impl Session {
    pub(crate) fn access_token(&self) -> &str {
        &self.access_token
    }
    pub(crate) fn session_id(&self) -> Result<Uuid, AuthError> {
        // This token was already verified online by the pinned issuer. Bind the
        // session claim again to the independently authenticated backend snapshot.
        let parts: Vec<_> = self.access_token.split('.').collect();
        if parts.len() != 3 {
            return Err(AuthError::Protocol);
        }
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(parts[1])
            .map_err(|_| AuthError::Protocol)?;
        let value: serde_json::Value = decode(&bytes)?;
        if value["iss"].as_str()
            != Some(&format!("https://{}.supabase.co/auth/v1", self.project_ref))
            || value["sub"].as_str() != Some(&self.account_id.to_string())
        {
            return Err(AuthError::Protocol);
        }
        value["session_id"]
            .as_str()
            .and_then(|v| Uuid::parse_str(v).ok())
            .filter(|v| !v.is_nil())
            .ok_or(AuthError::Protocol)
    }
    pub fn account_id(&self) -> Uuid {
        self.account_id
    }
    pub fn email(&self) -> &str {
        &self.email
    }
    pub fn expires_at(&self) -> DateTime<Utc> {
        self.expires_at
    }
    pub fn is_fresh(&self) -> bool {
        self.received.elapsed() < self.ttl && Utc::now() < self.expires_at
    }
    /// Renew an already validated native session without requiring persistence.
    /// This opaque credential is never serialized or returned to the webview.
    pub(crate) fn refresh_credential(&self) -> RefreshCredential {
        RefreshCredential {
            project_ref: self.project_ref.clone(),
            account_id: self.account_id,
            refresh_token: self.refresh_token.clone(),
        }
    }
    #[cfg(test)]
    pub(crate) fn expire_fixture(&mut self) {
        self.ttl = Duration::ZERO;
        self.expires_at = Utc::now() - chrono::Duration::seconds(1);
    }
}

fn email(value: &str) -> Result<&str, AuthError> {
    let (local, domain) = value.split_once('@').ok_or(AuthError::Input)?;
    if value.len() > 254
        || local.is_empty()
        || domain.is_empty()
        || domain.contains('@')
        || !domain.contains('.')
        || value.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(AuthError::Input);
    }
    Ok(value)
}
fn email_code(value: &str) -> bool {
    matches!(value.len(), 6 | 8) && value.bytes().all(|c| c.is_ascii_digit())
}
fn secret(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && value.bytes().all(|c| c.is_ascii_graphic())
}
fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T, AuthError> {
    if bytes.len() > 32_768 {
        return Err(AuthError::Protocol);
    }
    serde_json::from_slice(bytes).map_err(|_| AuthError::Protocol)
}

pub struct Client {
    config: StagingConfig,
    wire: Arc<dyn Transport>,
}
impl Client {
    #[cfg(test)]
    pub(crate) fn test_client(config: StagingConfig, wire: Arc<dyn transport::Transport>) -> Self {
        Self { config, wire }
    }
    pub fn verify_email_proof(
        &self,
        address: &str,
        proof: &str,
        intent: EntryIntent,
    ) -> Result<Session, AuthError> {
        let proof = proof.trim();
        if email_code(proof) {
            return self.verify_email_code(address, proof);
        }
        if proof.len() > 4096 {
            return Err(AuthError::Input);
        }
        let link = url::Url::parse(proof).map_err(|_| AuthError::Input)?;
        if link.origin().ascii_serialization()
            != format!("https://{}.supabase.co", self.config.project_ref)
            || link.path() != "/auth/v1/verify"
            || !link.username().is_empty()
            || link.password().is_some()
            || link.fragment().is_some()
        {
            return Err(AuthError::Input);
        }
        let mut pairs = std::collections::BTreeMap::new();
        for (key, value) in link.query_pairs() {
            if !["token", "token_hash", "type", "redirect_to"].contains(&key.as_ref())
                || pairs.insert(key.into_owned(), value.into_owned()).is_some()
            {
                return Err(AuthError::Input);
            }
        }
        if pairs.contains_key("token") && pairs.contains_key("token_hash") {
            return Err(AuthError::Input);
        }
        let hash = pairs
            .get("token")
            .or_else(|| pairs.get("token_hash"))
            .ok_or(AuthError::Input)?;
        let kind = pairs.get("type").map(String::as_str).unwrap_or("");
        if !(20..=512).contains(&hash.len())
            || !hash
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            || !(kind == "email"
                || kind == "magiclink"
                || (kind == "signup" && matches!(intent, EntryIntent::Subscribe)))
        {
            return Err(AuthError::Input);
        }
        let address = email(address)?;
        let bytes = self.wire.request(
            Operation::Verify,
            None,
            json!({"token_hash":hash,"type":"email"}),
        )?;
        self.session(&bytes, Some(address), None)
    }
    pub fn new(config: StagingConfig) -> Self {
        let wire = Arc::new(HttpTransport::new(&config));
        Self { config, wire }
    }
    /// An explicit Subscribe may create an Auth user. Restore must never do so.
    pub fn request_email_code(&self, address: &str, intent: EntryIntent) -> Result<(), AuthError> {
        let address = email(address)?;
        self.wire.request(
            Operation::Code,
            None,
            json!({
                "email":address, "create_user":matches!(intent, EntryIntent::Subscribe)
            }),
        )?;
        Ok(())
    }
    pub fn verify_email_code(&self, address: &str, code: &str) -> Result<Session, AuthError> {
        let address = email(address)?;
        if !email_code(code) {
            return Err(AuthError::Input);
        }
        let bytes = self.wire.request(
            Operation::Verify,
            None,
            json!({"email":address,"token":code,"type":"email"}),
        )?;
        self.session(&bytes, Some(address), None)
    }
    /// Refresh is deliberate and single-shot. There are no automatic retries
    /// of a rotating refresh credential, including after an ambiguous response.
    pub fn refresh(&self, saved: &RefreshCredential) -> Result<Session, AuthError> {
        if saved.project_ref != self.config.project_ref || !secret(&saved.refresh_token, 2048) {
            return Err(AuthError::Configuration);
        }
        let bytes = self.wire.request(
            Operation::Refresh,
            None,
            json!({"refresh_token":saved.refresh_token}),
        )?;
        self.session(&bytes, None, Some(saved.account_id))
    }
    fn session(
        &self,
        bytes: &[u8],
        address: Option<&str>,
        account: Option<Uuid>,
    ) -> Result<Session, AuthError> {
        let response: TokenResponse = decode(bytes)?;
        response.user.validate()?;
        if !secret(&response.access_token, 8192)
            || !secret(&response.refresh_token, 2048)
            || response.token_type != "bearer"
            || !(1..=3600).contains(&response.expires_in)
            || address.is_some_and(|e| !response.user.email.eq_ignore_ascii_case(e))
            || account.is_some_and(|id| response.user.id != id)
        {
            return Err(AuthError::Protocol);
        }
        let now = Utc::now();
        let mut expires_at = now + chrono::Duration::seconds(response.expires_in as i64);
        if let Some(absolute) = response.expires_at {
            let absolute = DateTime::from_timestamp(absolute.0, 0).ok_or(AuthError::Protocol)?;
            if absolute <= now || absolute > now + chrono::Duration::seconds(3605) {
                return Err(AuthError::Protocol);
            }
            expires_at = expires_at.min(absolute);
        }
        // Ask the fixed issuer to validate the access token. We do not decode
        // an unsigned JWT payload and call that verified identity.
        let verified: User = decode(&self.wire.request(
            Operation::User,
            Some(&response.access_token),
            json!({}),
        )?)?;
        verified.validate()?;
        if verified.id != response.user.id
            || !verified.email.eq_ignore_ascii_case(&response.user.email)
        {
            return Err(AuthError::Protocol);
        }
        let ttl = (expires_at - Utc::now())
            .to_std()
            .map_err(|_| AuthError::Protocol)?;
        if ttl.is_zero() {
            return Err(AuthError::Protocol);
        }
        Ok(Session {
            project_ref: self.config.project_ref.clone(),
            account_id: verified.id,
            email: verified.email,
            access_token: response.access_token,
            refresh_token: response.refresh_token,
            expires_at,
            received: Instant::now(),
            ttl,
        })
    }
    /// Issuer logout only. The coordinator must first clear local memory and
    /// Keychain, invalidate in-flight work, and separately revoke Gyro access.
    /// Supabase access JWTs can remain valid until expiry after issuer logout.
    pub fn logout_current_session(&self, session: &Session) -> Result<(), AuthError> {
        if session.project_ref != self.config.project_ref {
            return Err(AuthError::Configuration);
        }
        self.wire
            .request(Operation::Logout, Some(&session.access_token), json!({}))?;
        Ok(())
    }
}

#[cfg(test)]
pub(crate) fn fixture_session(config: &StagingConfig, account: Uuid, session: Uuid) -> Session {
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&json!({"iss":config.issuer(),"sub":account,"session_id":session}))
            .unwrap(),
    );
    Session {
        project_ref: config.project_ref.clone(),
        account_id: account,
        email: "fixture@example.com".into(),
        access_token: format!("fixture.{payload}.fixture"),
        refresh_token: "fixture-refresh-only".into(),
        expires_at: Utc::now() + chrono::Duration::hours(1),
        received: Instant::now(),
        ttl: Duration::from_secs(3600),
    }
}
