//! Optional hosted v2 Cloud client. Configuration is public; credentials stay native.
//! Construction is idle. Every service operation still requires backend authorization.
pub mod outbox;
pub mod selection;
pub mod services;

use super::supabase::{Client, EntryIntent, MacKeychain, RefreshStore, Session, StagingConfig};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[cfg(debug_assertions)]
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use uuid::Uuid;

pub const VERSION: &str = "2.0.0";
const MAX_RESPONSE: usize = 72 * 1024 * 1024;

#[derive(Clone, Copy, Debug, thiserror::Error)]
pub enum Error {
    #[error("Gyro Cloud is not configured. Local work remains available.")]
    Unconfigured,
    #[error("The Cloud response could not be verified.")]
    Protocol,
    #[error("Gyro Cloud is unavailable. Local work remains available.")]
    Unavailable,
    #[error("Sign in again to use Gyro Cloud.")]
    Authentication,
    #[error("This Cloud operation is unavailable for your account.")]
    Denied,
    #[error("Another Cloud operation is running.")]
    Busy,
    #[error("This response belongs to an earlier Cloud session.")]
    Stale,
    #[error("The selected Cloud input is invalid or too large.")]
    Input,
    #[error("The Cloud operation conflicts with the current service state. Refresh status before trying again.")]
    Conflict,
    #[error("End Cloud renewal in billing before requesting Cloud account deletion.")]
    CancelRenewalFirst,
    #[error("A Cloud limit was reached. Local work remains available.")]
    Limited,
    #[error("No saved Cloud request was found for this account and request key.")]
    NotFound,
    #[error("The Cloud refresh credential could not be accessed in macOS Keychain.")]
    Storage,
}
impl From<super::supabase::AuthError> for Error {
    fn from(value: super::supabase::AuthError) -> Self {
        use super::supabase::AuthError;
        match value {
            AuthError::Storage => Self::Storage,
            AuthError::Input => Self::Input,
            AuthError::Rejected => Self::Authentication,
            AuthError::RateLimited => Self::Limited,
            AuthError::Unavailable => Self::Unavailable,
            _ => Self::Protocol,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Environment {
    Production,
    #[cfg(debug_assertions)]
    Staging,
}
impl Environment {
    fn as_str(self) -> &'static str {
        match self {
            Self::Production => "production",
            #[cfg(debug_assertions)]
            Self::Staging => "staging",
        }
    }
    fn permits_managed_ai(self) -> bool {
        self == Self::Production
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublicConfig {
    environment: String,
    api_origin: String,
    share_origin: String,
    auth_project: Option<String>,
    auth_publishable_key: Option<String>,
    environment_isolation_verified: bool,
    staging_auth_project: Option<String>,
}
impl PublicConfig {
    fn reserves_project(&self, environment: Environment, project: &str) -> bool {
        match environment {
            Environment::Production => {
                self.staging_auth_project.as_deref() == Some(project)
                    || (project == "hqyahsvqjizmsfxclxzd" && !self.isolated())
            }
            #[cfg(debug_assertions)]
            Environment::Staging => {
                self.isolated() && self.auth_project.as_deref() == Some(project)
            }
        }
    }
    fn isolated(&self) -> bool {
        self.environment_isolation_verified
            && self.staging_auth_project.as_deref().is_some_and(|stage| {
                stage.len() == 20
                    && stage.bytes().all(|c| c.is_ascii_lowercase())
                    && self
                        .auth_project
                        .as_deref()
                        .is_some_and(|production| production != stage)
            })
    }
}

#[derive(Clone, Copy, Default)]
struct BuildPins<'a> {
    api: Option<&'a str>,
    project: Option<&'a str>,
    public_key: Option<&'a str>,
    share: Option<&'a str>,
}
impl BuildPins<'_> {
    fn any(self) -> bool {
        [self.api, self.project, self.public_key, self.share]
            .iter()
            .any(Option::is_some)
    }
    fn configure(self, environment: Environment) -> Option<Config> {
        let mut config =
            Config::configured(self.api?, self.project?, self.public_key?, environment).ok()?;
        if let Some(origin) = self.share {
            config = config.with_share_origin(origin).ok()?;
        }
        Some(config)
    }
}

#[derive(Clone)]
pub struct Config {
    api_origin: String,
    auth: StagingConfig,
    share_origin: Option<String>,
    environment: Environment,
    local_namespace: String,
    #[cfg(debug_assertions)]
    scope: String,
}
impl Config {
    pub fn production(
        api_origin: &str,
        project_ref: &str,
        publishable_key: &str,
    ) -> Result<Self, Error> {
        Self::configured(
            api_origin,
            project_ref,
            publishable_key,
            Environment::Production,
        )
    }
    /// Hosted v2 staging is absent from release builds and never uses runtime origins.
    #[cfg(debug_assertions)]
    pub fn debug_staging(
        api_origin: &str,
        project_ref: &str,
        publishable_key: &str,
    ) -> Result<Self, Error> {
        Self::configured(
            api_origin,
            project_ref,
            publishable_key,
            Environment::Staging,
        )
    }
    fn origin(origin: &str) -> Result<String, Error> {
        let u = url::Url::parse(origin).map_err(|_| Error::Input)?;
        if u.scheme() != "https"
            || u.host_str().is_none()
            || u.host_str()
                .is_some_and(|h| h == "localhost" || h.parse::<std::net::IpAddr>().is_ok())
            || u.port().is_some()
            || !u.username().is_empty()
            || u.password().is_some()
            || u.query().is_some()
            || u.fragment().is_some()
            || u.path() != "/"
        {
            return Err(Error::Input);
        }
        Ok(u.origin().ascii_serialization())
    }
    fn configured(
        api_origin: &str,
        project_ref: &str,
        publishable_key: &str,
        environment: Environment,
    ) -> Result<Self, Error> {
        let api_origin = Self::origin(api_origin)?;
        if (environment == Environment::Production && api_origin.contains("staging"))
            || Self::reserved_project(environment, project_ref)
        {
            return Err(Error::Input);
        }
        let auth = StagingConfig::new(project_ref, publishable_key)?;
        #[cfg(debug_assertions)]
        let scope = format!(
            "{:x}",
            Sha256::digest(format!("{api_origin}|{}", auth.issuer()).as_bytes())
        );
        let local_namespace = match environment {
            Environment::Production => "cloud-production-v2".into(),
            #[cfg(debug_assertions)]
            Environment::Staging => format!("cloud-staging-v2/{scope}"),
        };
        Ok(Self {
            api_origin,
            auth,
            share_origin: None,
            environment,
            local_namespace,
            #[cfg(debug_assertions)]
            scope,
        })
    }
    fn with_share_origin(mut self, origin: &str) -> Result<Self, Error> {
        let origin = Self::origin(origin)?;
        if origin == self.api_origin {
            return Err(Error::Input);
        }
        self.share_origin = Some(origin);
        Ok(self)
    }
    /// Committed public deployment pins. Incomplete provisioning keeps paid
    /// Cloud unconfigured; Account/local work remain available in every build.
    fn public_config() -> Option<PublicConfig> {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../config/cloud-production.json"
        )))
        .ok()
    }
    fn reserved_project(environment: Environment, project: &str) -> bool {
        Self::public_config().map_or(
            environment == Environment::Production && project == "hqyahsvqjizmsfxclxzd",
            |pins| pins.reserves_project(environment, project),
        )
    }
    fn bundled_production() -> Option<Self> {
        let pins = Self::public_config()?;
        if pins.environment != "production" || !pins.isolated() {
            return None;
        }
        Self::production(
            &pins.api_origin,
            pins.auth_project.as_deref()?,
            pins.auth_publishable_key.as_deref()?,
        )
        .ok()?
        .with_share_origin(&pins.share_origin)
        .ok()
    }
    fn production_pins() -> BuildPins<'static> {
        BuildPins {
            api: option_env!("GYRO_CLOUD_V2_API_ORIGIN"),
            project: option_env!("GYRO_CLOUD_V2_AUTH_PROJECT"),
            public_key: option_env!("GYRO_CLOUD_V2_AUTH_PUBLISHABLE_KEY"),
            share: option_env!("GYRO_CLOUD_V2_SHARE_ORIGIN"),
        }
    }
    #[cfg(debug_assertions)]
    fn staging_pins() -> BuildPins<'static> {
        BuildPins {
            api: option_env!("GYRO_CLOUD_V2_STAGING_API_ORIGIN"),
            project: option_env!("GYRO_CLOUD_V2_STAGING_AUTH_PROJECT"),
            public_key: option_env!("GYRO_CLOUD_V2_STAGING_AUTH_PUBLISHABLE_KEY"),
            share: option_env!("GYRO_CLOUD_V2_STAGING_SHARE_ORIGIN"),
        }
    }
    /// A partial or mixed configuration never falls back to a mock adapter.
    pub fn build_requested() -> bool {
        #[cfg(debug_assertions)]
        if Self::staging_pins().any() {
            return true;
        }
        Self::production_pins().any() || Self::bundled_production().is_some()
    }
    #[cfg(debug_assertions)]
    fn debug_pins(production: BuildPins<'_>, staging: BuildPins<'_>) -> Option<Self> {
        match (production.any(), staging.any()) {
            (true, true) => None,
            (_, true) => staging.configure(Environment::Staging),
            _ => production.configure(Environment::Production),
        }
    }
    /// These are compile-time public configuration, never runtime/webview URL inputs.
    pub fn from_build() -> Option<Self> {
        #[cfg(debug_assertions)]
        {
            return if Self::production_pins().any() || Self::staging_pins().any() {
                Self::debug_pins(Self::production_pins(), Self::staging_pins())
            } else {
                Self::bundled_production()
            };
        }
        #[cfg(not(debug_assertions))]
        {
            if Self::production_pins().any() {
                Self::production_pins().configure(Environment::Production)
            } else {
                Self::bundled_production()
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Plan {
    Plus,
    Premium,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Account {
    pub id: Uuid,
    pub status: String,
    pub email_verified: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudSession {
    pub id: Uuid,
    pub expires_at: DateTime<Utc>,
    pub device_id: Uuid,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Subscription {
    pub state: String,
    pub plan_id: Option<Plan>,
    pub plan_version: Option<String>,
    pub period_id: Option<String>,
    pub paid_through: Option<DateTime<Utc>>,
    pub scheduled_plan: Option<Plan>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Decision {
    pub allowed: bool,
    pub reason: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capabilities {
    pub managed_ai: Decision,
    pub selected_sync: Decision,
    pub backup: Decision,
    pub sharing: Decision,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Limits {
    pub devices: u32,
    pub storage_bytes: u64,
    pub history_days: u32,
    pub active_links: u32,
    pub concurrent_jobs: u32,
    pub upload_bytes_per_month: u64,
    pub download_bytes_per_month: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedUsage {
    pub unit: String,
    pub used: f64,
    pub held: f64,
    pub remaining: f64,
    pub reset_at: Option<DateTime<Utc>>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageUsage {
    pub used_bytes: u64,
    pub reserved_bytes: u64,
    pub limit_bytes: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Usage {
    pub managed_ai: ManagedUsage,
    pub storage: StorageUsage,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub contract_version: String,
    pub environment: String,
    pub verified_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub account: Account,
    pub session: CloudSession,
    pub subscription: Subscription,
    pub capabilities: Capabilities,
    pub limits: Limits,
    pub usage: Usage,
}
impl Snapshot {
    fn validate_for(
        &self,
        environment: Environment,
        account: Uuid,
        session: Uuid,
        device: Uuid,
    ) -> Result<(), Error> {
        let now = Utc::now();
        let u = &self.usage.managed_ai;
        let active = matches!(
            self.subscription.state.as_str(),
            "active" | "cancellation-scheduled"
        );
        let decisions = [
            &self.capabilities.managed_ai,
            &self.capabilities.selected_sync,
            &self.capabilities.backup,
            &self.capabilities.sharing,
        ];
        if self.contract_version != VERSION
            || self.environment != environment.as_str()
            || (!environment.permits_managed_ai() && self.capabilities.managed_ai.allowed)
            || self.account.id != account
            || account.is_nil()
            || self.session.id != session
            || session.is_nil()
            || self.session.device_id != device
            || device.is_nil()
            || self.verified_at > now + chrono::Duration::seconds(5)
            || self.expires_at <= now
            || self.expires_at <= self.verified_at
            || self.expires_at - self.verified_at > chrono::Duration::seconds(60)
            || self.session.expires_at < self.expires_at
            || !matches!(
                self.subscription.state.as_str(),
                "none"
                    | "checkout-pending"
                    | "active"
                    | "cancellation-scheduled"
                    | "payment-problem"
                    | "expired"
                    | "revoked"
                    | "disputed"
            )
            || u.unit != "percent"
            || [u.used, u.held, u.remaining]
                .iter()
                .any(|v| !v.is_finite() || *v < 0.0 || *v > 100.0)
            || u.used + u.held + u.remaining > 100.1
            || decisions.iter().any(|d| {
                d.allowed
                    && (!active || !self.account.email_verified || self.account.status != "enabled")
            })
            || (active
                && (self.subscription.plan_id.is_none()
                    || !self
                        .subscription
                        .paid_through
                        .is_some_and(|v| v >= self.expires_at)))
            || (self.capabilities.managed_ai.allowed && u.remaining <= 0.0)
            || self.usage.storage.limit_bytes != self.limits.storage_bytes
        {
            return Err(Error::Protocol);
        }
        Ok(())
    }
    #[cfg(test)]
    fn validate(&self, account: Uuid, session: Uuid, device: Uuid) -> Result<(), Error> {
        self.validate_for(Environment::Production, account, session, device)
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub environment: &'static str,
    pub contract_version: &'static str,
    pub state: String,
    pub auth_stage: Option<String>,
    pub last_verified: Option<DateTime<Utc>>,
    pub snapshot: Option<Snapshot>,
    pub revocation_pending: bool,
    pub remember_session: bool,
}
impl Default for View {
    fn default() -> Self {
        Self {
            environment: "production",
            contract_version: VERSION,
            state: "signed-out".into(),
            auth_stage: None,
            last_verified: None,
            snapshot: None,
            revocation_pending: false,
            remember_session: false,
        }
    }
}

pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}
pub trait Transport: Send + Sync {
    fn request(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        device: Uuid,
        body: Option<&[u8]>,
        content_type: &'static str,
        idempotency_key: Option<&str>,
    ) -> Result<Response, Error>;
}
struct Https {
    origin: String,
    agent: ureq::Agent,
}
impl Https {
    fn new(config: &Config) -> Self {
        Self {
            origin: config.api_origin.clone(),
            agent: ureq::AgentBuilder::new()
                .redirects(0)
                .try_proxy_from_env(false)
                .timeout(Duration::from_secs(45))
                .timeout_connect(Duration::from_secs(5))
                .build(),
        }
    }
}
impl Transport for Https {
    fn request(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        device: Uuid,
        body: Option<&[u8]>,
        content_type: &'static str,
        idempotency_key: Option<&str>,
    ) -> Result<Response, Error> {
        if !path.starts_with("/v2/")
            || path.contains("://")
            || path.contains('\\')
            || path.contains('#')
        {
            return Err(Error::Input);
        }
        let mut req = self
            .agent
            .request(method, &format!("{}{}", self.origin, path))
            .set("Accept", "application/json")
            .set("Cache-Control", "no-store")
            .set("X-Gyro-Device", &device.to_string());
        if let Some(token) = token {
            req = req.set("Authorization", &format!("Bearer {token}"));
        }
        if let Some(key) = idempotency_key {
            req = req.set("Idempotency-Key", key);
        }
        let response = match body {
            Some(v) => req.set("Content-Type", content_type).send_bytes(v),
            None => req.call(),
        };
        let response = match response {
            Ok(v) => v,
            Err(ureq::Error::Status(_, r)) => r,
            Err(_) => return Err(Error::Unavailable),
        };
        let status = response.status();
        if (300..400).contains(&status) {
            return Err(Error::Protocol);
        }
        if response.header("Content-Type").is_none_or(|v| {
            !v.split(';')
                .next()
                .is_some_and(|s| s.trim().eq_ignore_ascii_case("application/json"))
        }) {
            return Err(Error::Protocol);
        }
        let mut bytes = Vec::new();
        response
            .into_reader()
            .take((MAX_RESPONSE + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::Unavailable)?;
        if bytes.len() > MAX_RESPONSE {
            return Err(Error::Protocol);
        }
        Ok(Response {
            status,
            body: bytes,
        })
    }
}
#[derive(Clone)]
struct Pending {
    email: String,
    intent: Option<Value>,
    remember: bool,
}
struct Inner {
    generation: u64,
    busy: bool,
    session: Option<Arc<Session>>,
    pending: Option<Pending>,
    plan: Option<Plan>,
    view: View,
    received: Option<Instant>,
    checkout_request: Uuid,
    previews: std::collections::HashMap<Uuid, services::Preview>,
}
pub struct Connection {
    auth: Client,
    store: Arc<dyn RefreshStore>,
    transport: Arc<dyn Transport>,
    share_origin: Option<String>,
    environment: Environment,
    local_namespace: String,
    device_id: Mutex<Option<Uuid>>,
    inner: Mutex<Inner>,
}
pub struct Outcome {
    pub view: View,
    pub open_url: Option<String>,
}
impl Connection {
    pub fn from_build() -> Option<Self> {
        let config = Config::from_build()?;
        let transport = Arc::new(Https::new(&config));
        let store = Arc::new(match config.environment {
            Environment::Production => MacKeychain::production(&config.auth),
            #[cfg(debug_assertions)]
            Environment::Staging => MacKeychain::v2_staging(&config.auth, &config.scope),
        });
        Some(Self::new(config, store, transport, Uuid::nil()))
    }
    pub fn new(
        config: Config,
        store: Arc<dyn RefreshStore>,
        transport: Arc<dyn Transport>,
        device_id: Uuid,
    ) -> Self {
        let view = View {
            environment: config.environment.as_str(),
            ..View::default()
        };
        Self {
            auth: Client::new(config.auth),
            store,
            transport,
            share_origin: config.share_origin,
            environment: config.environment,
            local_namespace: config.local_namespace,
            device_id: Mutex::new((!device_id.is_nil()).then_some(device_id)),
            inner: Mutex::new(Inner {
                generation: 0,
                busy: false,
                session: None,
                pending: None,
                plan: None,
                view,
                received: None,
                checkout_request: Uuid::new_v4(),
                previews: std::collections::HashMap::new(),
            }),
        }
    }
    /// No file is opened here; only explicit device/data operations create state.
    pub fn local_state(&self) -> Result<outbox::LocalState, Error> {
        outbox::LocalState::for_namespace(&self.local_namespace)
    }
    pub fn save_read_only_archive(&self, chat: &selection::Chat) -> Result<Uuid, Error> {
        if self.environment == Environment::Production {
            return selection::save_read_only_archive(chat);
        }
        let local = self.local_state()?;
        let root = local
            .path()
            .parent()
            .ok_or(Error::Storage)?
            .join("archives");
        selection::save_read_only_archive_in(chat, &root)
    }
    fn device(&self) -> Result<Uuid, Error> {
        let mut id = self.device_id.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(v) = *id {
            return Ok(v);
        }
        let v = self.local_state()?.device_id()?;
        *id = Some(v);
        Ok(v)
    }
    pub fn view(&self) -> View {
        let s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut v = s.view.clone();
        if v.state == "connected"
            && (!s
                .received
                .is_some_and(|r| r.elapsed() < Duration::from_secs(45))
                || !v
                    .snapshot
                    .as_ref()
                    .is_some_and(|s| s.expires_at > Utc::now()))
        {
            v.state = "offline".into();
        }
        v
    }
    fn start(&self) -> Result<u64, Error> {
        let mut s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if s.busy {
            return Err(Error::Busy);
        }
        s.generation += 1;
        s.busy = true;
        s.view.state = "verifying".into();
        Ok(s.generation)
    }
    fn failed(&self, ticket: u64) {
        let mut s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if s.generation == ticket {
            s.busy = false;
            s.view.state = if s.session.is_some() {
                "offline"
            } else {
                "signed-out"
            }
            .into();
        }
    }
    fn json(
        &self,
        method: &str,
        path: &str,
        session: Option<&Session>,
        body: Option<Value>,
    ) -> Result<Value, Error> {
        let bytes = body
            .map(|v| serde_json::to_vec(&v).map_err(|_| Error::Input))
            .transpose()?;
        let r = self.transport.request(
            method,
            path,
            session.map(Session::access_token),
            self.device()?,
            bytes.as_deref(),
            "application/json",
            None,
        )?;
        match r.status {
            200..=299 => serde_json::from_slice(&r.body).map_err(|_| Error::Protocol),
            401 => Err(Error::Authentication),
            403 => Err(Error::Denied),
            404 => Err(Error::NotFound),
            409 => {
                let code = serde_json::from_slice::<Value>(&r.body)
                    .ok()
                    .and_then(|v| v["error"]["code"].as_str().map(str::to_owned));
                Err(if code.as_deref() == Some("cancel_renewal_first") {
                    Error::CancelRenewalFirst
                } else {
                    Error::Conflict
                })
            }
            402 | 413 | 429 => Err(Error::Limited),
            _ => Err(Error::Unavailable),
        }
    }
    fn snapshot(&self, session: &Session) -> Result<Snapshot, Error> {
        let snapshot: Snapshot =
            serde_json::from_value(self.json("GET", "/v2/account", Some(session), None)?)
                .map_err(|_| Error::Protocol)?;
        snapshot.validate_for(
            self.environment,
            session.account_id(),
            session.session_id()?,
            self.device()?,
        )?;
        Ok(snapshot)
    }
    fn commit(
        &self,
        ticket: u64,
        session: Arc<Session>,
        snapshot: Snapshot,
        remember: bool,
    ) -> Result<View, Error> {
        let mut s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if s.generation != ticket {
            return Err(Error::Stale);
        }
        if remember {
            self.store.save(&session)?;
        } else {
            self.store.clear()?;
        }
        Ok(Self::connected(&mut s, session, snapshot, remember))
    }
    /// Publish a verified snapshot without touching the refresh credential.
    /// Callers must hold the generation-checked state lock.
    fn connected(s: &mut Inner, session: Arc<Session>, snapshot: Snapshot, remember: bool) -> View {
        s.session = Some(session);
        s.pending = None;
        s.busy = false;
        s.view.auth_stage = None;
        s.view.state = "connected".into();
        s.view.last_verified = Some(snapshot.verified_at);
        s.view.snapshot = Some(snapshot);
        s.view.remember_session = remember;
        s.received = Some(Instant::now());
        s.view.clone()
    }
    pub fn choose(&self, plan: Option<Plan>) -> Result<Outcome, Error> {
        let mut s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if s.busy {
            return Err(Error::Busy);
        }
        s.generation += 1;
        s.plan = plan;
        s.pending = None;
        s.checkout_request = Uuid::new_v4();
        if s.session.is_some() && plan.is_some() {
            drop(s);
            return self.billing(plan);
        }
        s.view.auth_stage = Some("email".into());
        Ok(Outcome {
            view: s.view.clone(),
            open_url: None,
        })
    }
    pub fn begin(&self, email: &str, remember: bool) -> Result<Outcome, Error> {
        let ticket = self.start()?;
        let plan = self.inner.lock().unwrap_or_else(|e| e.into_inner()).plan;
        let result = (|| {
            let intent = plan
                .map(|p| {
                    self.json(
                        "POST",
                        "/v2/subscription-intents",
                        None,
                        Some(json!({"planId":p})),
                    )
                })
                .transpose()?;
            if let Some(i) = &intent {
                if i["intentId"]
                    .as_str()
                    .and_then(|v| Uuid::parse_str(v).ok())
                    .is_none()
                    || !i["secret"]
                        .as_str()
                        .is_some_and(|v| (32..=256).contains(&v.len()))
                {
                    return Err(Error::Protocol);
                }
            }
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
                return Err(Error::Stale);
            }
            s.pending = Some(Pending {
                email: email.into(),
                intent,
                remember,
            });
            s.busy = false;
            s.view.auth_stage = Some("proof".into());
            s.view.state = "signed-out".into();
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
    pub fn verify(&self, proof: &str) -> Result<Outcome, Error> {
        let ticket = self.start()?;
        let result = (|| {
            let pending = {
                let s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
                s.pending.clone().ok_or(Error::Input)?
            };
            let session = Arc::new(self.auth.verify_email_proof(
                &pending.email,
                proof,
                if pending.intent.is_some() {
                    EntryIntent::Subscribe
                } else {
                    EntryIntent::Restore
                },
            )?);
            let body = if let Some(i) = pending.intent {
                json!({"intentId":i["intentId"],"secret":i["secret"],"deviceId":self.device()?,"label":"Gyro for macOS"})
            } else {
                json!({"deviceId":self.device()?,"label":"Gyro for macOS"})
            };
            self.json(
                "POST",
                if body.get("intentId").is_some() {
                    "/v2/accounts"
                } else {
                    "/v2/devices"
                },
                Some(&session),
                Some(body),
            )?;
            let snapshot = self.snapshot(&session)?;
            let plan = self.inner.lock().unwrap_or_else(|e| e.into_inner()).plan;
            let view = self.commit(ticket, session, snapshot, pending.remember)?;
            if plan.is_some() {
                self.billing(plan)
            } else {
                Ok(Outcome {
                    view,
                    open_url: None,
                })
            }
        })();
        if result.is_err() {
            self.failed(ticket);
        }
        result
    }
    pub fn restore(&self) -> Result<Outcome, Error> {
        let ticket = self.start()?;
        let result = (|| {
            let saved = {
                let s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
                if s.generation != ticket {
                    return Err(Error::Stale);
                }
                self.store.load()?
            };
            let Some(saved) = saved else {
                let mut s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
                s.busy = false;
                s.view.state = "signed-out".into();
                s.view.auth_stage = Some("email".into());
                return Ok(Outcome {
                    view: s.view.clone(),
                    open_url: None,
                });
            };
            self.store.clear()?;
            let session = Arc::new(self.auth.refresh(&saved)?);
            self.json(
                "POST",
                "/v2/devices",
                Some(&session),
                Some(json!({"deviceId":self.device()?,"label":"Gyro for macOS"})),
            )?;
            let snapshot = self.snapshot(&session)?;
            Ok(Outcome {
                view: self.commit(ticket, session, snapshot, true)?,
                open_url: None,
            })
        })();
        if result.is_err() {
            self.failed(ticket);
        }
        result
    }
    fn authenticated<T>(&self, op: impl FnOnce(&Session) -> Result<T, Error>) -> Result<T, Error> {
        let ticket = self.start()?;
        let result = (|| {
            let (session, remember) = {
                let s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
                (
                    s.session.clone().ok_or(Error::Authentication)?,
                    s.view.remember_session,
                )
            };
            let rotated = !session.is_fresh();
            let session = if !rotated {
                session
            } else {
                let saved = {
                    let s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
                    if s.generation != ticket {
                        return Err(Error::Stale);
                    }
                    if remember {
                        let saved = self.store.load()?.ok_or(Error::Authentication)?;
                        self.store.clear()?;
                        saved
                    } else {
                        session.refresh_credential()
                    }
                };
                match self.auth.refresh(&saved) {
                    Ok(session) => Arc::new(session),
                    Err(error) => {
                        // A rotating credential may already have been consumed.
                        // Never retry it after a lost or unverifiable response.
                        let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
                        if state.generation != ticket {
                            return Err(Error::Stale);
                        }
                        state.session = None;
                        state.view.snapshot = None;
                        state.view.last_verified = None;
                        return Err(error.into());
                    }
                }
            };
            if rotated {
                let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
                if state.generation != ticket {
                    return Err(Error::Stale);
                }
                if remember {
                    self.store.save(&session)?;
                }
                state.session = Some(session.clone());
            }
            let value = op(&session)?;
            match self.snapshot(&session) {
                Ok(snapshot) => {
                    let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
                    if state.generation != ticket {
                        return Err(Error::Stale);
                    }
                    Self::connected(&mut state, session, snapshot, remember);
                }
                Err(error) => {
                    let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
                    if state.generation != ticket {
                        return Err(Error::Stale);
                    }
                    state.busy = false;
                    if matches!(error, Error::Authentication | Error::Denied) {
                        state.session = None;
                        state.view.snapshot = None;
                        state.view.last_verified = None;
                        state.view.state = "expired".into();
                        state.view.revocation_pending = self.store.clear().is_err();
                    } else {
                        state.view.state = "offline".into();
                    }
                }
            }
            Ok(value)
        })();
        if result.is_err() {
            self.failed(ticket);
        }
        result
    }
    pub fn refresh(&self) -> Result<Outcome, Error> {
        self.authenticated(|_| Ok(()))?;
        Ok(Outcome {
            view: self.view(),
            open_url: None,
        })
    }
    pub fn billing(&self, plan: Option<Plan>) -> Result<Outcome, Error> {
        let request_id = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .checkout_request;
        let handoff = self.authenticated(|s| {
            self.json(
                "POST",
                if plan.is_some() {
                    "/v2/billing/checkout"
                } else {
                    "/v2/billing/portal"
                },
                Some(s),
                Some(
                    plan.map_or_else(|| json!({}), |p| json!({"planId":p,"requestId":request_id})),
                ),
            )
        })?;
        if handoff["accessGranted"] != false {
            return Err(Error::Protocol);
        }
        let expires = handoff["expiresAt"]
            .as_str()
            .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
            .ok_or(Error::Protocol)?;
        if expires <= Utc::now() {
            return Err(Error::Protocol);
        }
        let url = checked_billing_url(handoff["url"].as_str().ok_or(Error::Protocol)?)?;
        Ok(Outcome {
            view: self.view(),
            open_url: Some(url),
        })
    }
    pub fn sign_out(&self) -> Result<Outcome, Error> {
        let (session, clear) = {
            let mut s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            s.generation += 1;
            s.busy = false;
            s.pending = None;
            s.plan = None;
            s.received = None;
            s.previews.clear();
            let session = s.session.take();
            let clear = self.store.clear();
            s.view = View {
                environment: self.environment.as_str(),
                ..View::default()
            };
            s.view.revocation_pending = clear.is_err() || session.is_some();
            (session, clear)
        };
        let revoked = session.as_ref().is_none_or(|s| {
            self.json("POST", "/v2/sessions/revoke", Some(s), Some(json!({})))
                .is_ok()
                && self.auth.logout_current_session(s).is_ok()
        });
        let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        state.view.revocation_pending = clear.is_err() || !revoked;
        Ok(Outcome {
            view: state.view.clone(),
            open_url: None,
        })
    }
}
pub fn checked_billing_url(value: &str) -> Result<String, Error> {
    let u = url::Url::parse(value).map_err(|_| Error::Protocol)?;
    // Stripe Checkout uses the fragment to open its hosted payment page.
    let stripe_checkout = u.host_str() == Some("checkout.stripe.com")
        && (u.path().starts_with("/c/pay/cs_test_") || u.path().starts_with("/c/pay/cs_live_"));
    if value.len() > 8192
        || u.scheme() != "https"
        || !matches!(
            u.host_str(),
            Some("checkout.stripe.com" | "billing.stripe.com")
        )
        || u.port().is_some()
        || !u.username().is_empty()
        || u.password().is_some()
        || (u.fragment().is_some() && !stripe_checkout)
    {
        return Err(Error::Protocol);
    }
    Ok(value.into())
}

#[cfg(test)]
mod refresh_tests;
#[cfg(test)]
mod tests {
    use super::*;
    pub(super) fn snapshot(account: Uuid, session: Uuid, device: Uuid) -> Snapshot {
        let now = Utc::now();
        serde_json::from_value(json!({"contractVersion":"2.0.0","environment":"production","verifiedAt":now,"expiresAt":now+chrono::Duration::seconds(45),"account":{"id":account,"status":"enabled","emailVerified":true},"session":{"id":session,"deviceId":device,"expiresAt":now+chrono::Duration::hours(1)},"subscription":{"state":"active","planId":"plus","planVersion":"2026-11-02","periodId":"invoice-fixture","paidThrough":now+chrono::Duration::days(30),"scheduledPlan":null},"capabilities":{"managedAi":{"allowed":true,"reason":"entitled"},"selectedSync":{"allowed":true,"reason":"entitled"},"backup":{"allowed":true,"reason":"entitled"},"sharing":{"allowed":true,"reason":"entitled"}},"limits":{"devices":2,"storageBytes":2000000000_u64,"historyDays":30,"activeLinks":10,"concurrentJobs":1,"uploadBytesPerMonth":10000000000_u64,"downloadBytesPerMonth":20000000000_u64},"usage":{"managedAi":{"unit":"percent","used":12.5,"held":2.5,"remaining":85,"resetAt":now+chrono::Duration::days(30)},"storage":{"usedBytes":0,"reservedBytes":0,"limitBytes":2000000000_u64}}})).unwrap()
    }
    #[test]
    fn snapshots_bind_account_session_device_environment_and_freshness() {
        let a = Uuid::new_v4();
        let s = Uuid::new_v4();
        let d = Uuid::new_v4();
        let good = snapshot(a, s, d);
        assert!(good.validate(a, s, d).is_ok());
        assert!(good.validate(Uuid::new_v4(), s, d).is_err());
        assert!(good.validate(a, Uuid::new_v4(), d).is_err());
        assert!(good.validate(a, s, Uuid::new_v4()).is_err());
        let mut bad = good.clone();
        bad.environment = "staging".into();
        assert!(bad.validate(a, s, d).is_err());
        let mut bad = good.clone();
        bad.expires_at = Utc::now() - chrono::Duration::seconds(1);
        assert!(bad.validate(a, s, d).is_err());
        let mut bad = good.clone();
        bad.account.email_verified = false;
        assert!(bad.validate(a, s, d).is_err());
        let mut bad = good.clone();
        bad.usage.managed_ai.unit = "EUR".into();
        assert!(bad.validate(a, s, d).is_err());
        let mut bad = good;
        bad.usage.managed_ai.remaining = 100.;
        assert!(bad.validate(a, s, d).is_err());
    }
    #[test]
    fn production_snapshots_never_accept_client_balance_or_auth_tokens() {
        let v =
            serde_json::to_value(snapshot(Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4())).unwrap();
        for field in [
            "accessToken",
            "refreshToken",
            "balanceOverride",
            "providerKey",
        ] {
            let mut bad = v.clone();
            bad[field] = json!("forbidden");
            assert!(serde_json::from_value::<Snapshot>(bad).is_err());
        }
    }
    #[test]
    fn no_allowance_does_not_remove_independent_sync_capabilities() {
        let a = Uuid::new_v4();
        let s = Uuid::new_v4();
        let d = Uuid::new_v4();
        let mut v = snapshot(a, s, d);
        v.usage.managed_ai.used = 100.;
        v.usage.managed_ai.held = 0.;
        v.usage.managed_ai.remaining = 0.;
        v.capabilities.managed_ai.allowed = false;
        v.capabilities.managed_ai.reason = "exhausted".into();
        assert!(v.validate(a, s, d).is_ok());
        assert!(v.capabilities.selected_sync.allowed);
    }
    struct IdleTransport(std::sync::atomic::AtomicUsize);
    impl Transport for IdleTransport {
        fn request(
            &self,
            _: &str,
            _: &str,
            _: Option<&str>,
            _: Uuid,
            _: Option<&[u8]>,
            _: &'static str,
            _: Option<&str>,
        ) -> Result<Response, Error> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Err(Error::Unavailable)
        }
    }
    #[test]
    fn production_construction_and_cached_reads_never_network_or_load_keychain() {
        let config = Config::production(
            "https://cloud.example",
            "abcdefghijklmnopqrst",
            "sb_publishable_fixture_only_not_a_secret",
        )
        .unwrap();
        let transport = Arc::new(IdleTransport(std::sync::atomic::AtomicUsize::new(0)));
        let store = Arc::new(super::super::supabase::store::fixture::MemoryStore {
            project_ref: "abcdefghijklmnopqrst".into(),
            ..Default::default()
        });
        let c = Connection::new(config, store.clone(), transport.clone(), Uuid::new_v4());
        assert_eq!(c.view().state, "signed-out");
        assert!(store.value.lock().unwrap().is_none());
        assert_eq!(transport.0.load(std::sync::atomic::Ordering::SeqCst), 0);
    }
    #[test]
    fn late_generation_cannot_write_refresh_after_signout() {
        let config = Config::production(
            "https://cloud.example",
            "abcdefghijklmnopqrst",
            "sb_publishable_fixture_only_not_a_secret",
        )
        .unwrap();
        let a = Uuid::new_v4();
        let s = Uuid::new_v4();
        let d = Uuid::new_v4();
        let session = Arc::new(super::super::supabase::fixture_session(&config.auth, a, s));
        let store = Arc::new(super::super::supabase::store::fixture::MemoryStore {
            project_ref: "abcdefghijklmnopqrst".into(),
            ..Default::default()
        });
        let c = Connection::new(
            config,
            store.clone(),
            Arc::new(IdleTransport(std::sync::atomic::AtomicUsize::new(0))),
            d,
        );
        let ticket = c.start().unwrap();
        c.sign_out().unwrap();
        assert!(matches!(
            c.commit(ticket, session, snapshot(a, s, d), true),
            Err(Error::Stale)
        ));
        assert!(store.value.lock().unwrap().is_none());
        assert!(c.view().snapshot.is_none());
    }
    #[test]
    fn bundled_production_requires_verified_separate_staging_auth() {
        let mut pins = Config::public_config().unwrap();
        assert!(!pins.isolated());
        assert!(Config::bundled_production().is_none());
        pins.environment_isolation_verified = true;
        pins.staging_auth_project = pins.auth_project.clone();
        assert!(!pins.isolated());
        pins.staging_auth_project = Some("zyxwvutsrqponmlkjihg".into());
        assert!(pins.isolated());
        assert!(!pins.reserves_project(Environment::Production, "hqyahsvqjizmsfxclxzd"));
        assert!(pins.reserves_project(Environment::Production, "zyxwvutsrqponmlkjihg"));
        #[cfg(debug_assertions)]
        {
            assert!(pins.reserves_project(Environment::Staging, "hqyahsvqjizmsfxclxzd"));
            assert!(!pins.reserves_project(Environment::Staging, "zyxwvutsrqponmlkjihg"));
        }
    }
    #[test]
    fn production_origins_are_fixed_public_https_configuration() {
        let key = "sb_publishable_fixture_only_not_a_secret";
        for bad in [
            "http://cloud.example",
            "https://localhost",
            "https://127.0.0.1",
            "https://user@cloud.example",
            "https://cloud.example/path",
            "https://cloud.example?token=x",
            "https://cloud.example#x",
            "https://cloud.example:4342",
            "https://gyro-cloud-v2-staging-api.example",
        ] {
            assert!(Config::production(bad, "abcdefghijklmnopqrst", key).is_err());
        }
        assert!(Config::production("https://cloud.example", "hqyahsvqjizmsfxclxzd", key).is_err());
        assert!(Config::production("https://cloud.example", "abcdefghijklmnopqrst", key).is_ok());
    }
    #[test]
    fn billing_handoffs_reject_other_destinations_and_embedded_credentials() {
        for bad in [
            "http://checkout.stripe.com/c/pay/cs_live_fixture",
            "https://checkout.stripe.com.evil.example/x",
            "https://user@billing.stripe.com/x",
            "https://billing.stripe.com:4342/x",
            "https://billing.stripe.com/p/session/fixture#fragment",
            "https://checkout.stripe.com/other#fragment",
            "javascript:alert(1)",
        ] {
            assert!(checked_billing_url(bad).is_err());
        }
        assert!(checked_billing_url("https://checkout.stripe.com/c/pay/cs_live_fixture").is_ok());
        let sandbox = "https://checkout.stripe.com/c/pay/cs_test_fixture#opaqueFixtureToken";
        assert_eq!(checked_billing_url(sandbox).unwrap(), sandbox);
    }
    #[cfg(debug_assertions)]
    #[test]
    fn debug_staging_pins_reject_partial_mixed_and_untrusted_configuration() {
        let pins = BuildPins {
            api: Some("https://stage-api.example"),
            project: Some("abcdefghijklmnopqrst"),
            public_key: Some("sb_publishable_fixture_public_key_only"),
            share: Some("https://stage-share.example"),
        };
        assert!(Config::debug_pins(BuildPins::default(), BuildPins::default()).is_none());
        assert!(Config::debug_pins(pins, pins).is_none());
        assert!(Config::debug_pins(
            BuildPins::default(),
            BuildPins {
                project: None,
                ..pins
            }
        )
        .is_none());
        let staging = Config::debug_pins(BuildPins::default(), pins).unwrap();
        assert_eq!(staging.environment, Environment::Staging);
        assert_eq!(
            staging.auth.issuer(),
            "https://abcdefghijklmnopqrst.supabase.co/auth/v1"
        );
        assert_eq!(
            staging.share_origin.as_deref(),
            Some("https://stage-share.example")
        );
        for bad in [
            "http://stage-api.example",
            "https://127.0.0.1",
            "https://localhost",
            "https://user@stage-api.example",
            "https://stage-api.example/path",
            "https://stage-api.example?override=1",
        ] {
            assert!(Config::debug_pins(
                BuildPins::default(),
                BuildPins {
                    api: Some(bad),
                    ..pins
                }
            )
            .is_none());
        }
        assert!(Config::debug_pins(
            BuildPins::default(),
            BuildPins {
                share: pins.api,
                ..pins
            }
        )
        .is_none());
        let production = Config::debug_pins(pins, BuildPins::default()).unwrap();
        assert_eq!(production.environment, Environment::Production);
    }
    #[cfg(debug_assertions)]
    #[test]
    fn debug_staging_is_idle_keeps_its_label_on_logout_and_rejects_ai_before_io() {
        let config = Config::debug_staging(
            "https://stage-api.example",
            "abcdefghijklmnopqrst",
            "sb_publishable_fixture_public_key_only",
        )
        .unwrap();
        let transport = Arc::new(IdleTransport(std::sync::atomic::AtomicUsize::new(0)));
        let store = Arc::new(super::super::supabase::store::fixture::MemoryStore {
            project_ref: "abcdefghijklmnopqrst".into(),
            ..Default::default()
        });
        let connection = Connection::new(config, store.clone(), transport.clone(), Uuid::new_v4());
        assert_eq!(connection.view().environment, "staging");
        assert_eq!(connection.view().contract_version, VERSION);
        assert_eq!(connection.view().state, "signed-out");
        assert!(matches!(
            connection.service(services::Command::SubmitJob {
                task: services::Task::FailureExplanation,
                context: "Reviewed fixture".into(),
                source_ids: vec![],
                idempotency_key: Uuid::new_v4()
            }),
            Err(Error::Denied)
        ));
        assert!(matches!(
            connection.service(services::Command::ExtractMemory {
                project_id: Uuid::new_v4(),
                request_id: Uuid::new_v4(),
                source_object_ids: vec![],
                automatic: false,
                rescan_object_ids: None
            }),
            Err(Error::Denied)
        ));
        assert_eq!(connection.sign_out().unwrap().view.environment, "staging");
        assert!(store.value.lock().unwrap().is_none());
        assert_eq!(transport.0.load(std::sync::atomic::Ordering::SeqCst), 0);
    }
    #[cfg(debug_assertions)]
    #[test]
    fn hosted_staging_response_must_match_environment_and_cannot_enable_paid_ai() {
        struct Wire(Mutex<Snapshot>);
        impl Transport for Wire {
            fn request(
                &self,
                method: &str,
                path: &str,
                _: Option<&str>,
                _: Uuid,
                _: Option<&[u8]>,
                _: &'static str,
                _: Option<&str>,
            ) -> Result<Response, Error> {
                assert_eq!((method, path), ("GET", "/v2/account"));
                Ok(Response {
                    status: 200,
                    body: serde_json::to_vec(&*self.0.lock().unwrap()).unwrap(),
                })
            }
        }
        let config = Config::debug_staging(
            "https://stage-api.example",
            "abcdefghijklmnopqrst",
            "sb_publishable_fixture_public_key_only",
        )
        .unwrap();
        let account = Uuid::new_v4();
        let session_id = Uuid::new_v4();
        let device = Uuid::new_v4();
        let session = super::super::supabase::fixture_session(&config.auth, account, session_id);
        let mut value = snapshot(account, session_id, device);
        value.environment = "staging".into();
        value.capabilities.managed_ai = Decision {
            allowed: false,
            reason: "staging-ai-disabled".into(),
        };
        let wire = Arc::new(Wire(Mutex::new(value)));
        let store = Arc::new(super::super::supabase::store::fixture::MemoryStore {
            project_ref: "abcdefghijklmnopqrst".into(),
            ..Default::default()
        });
        let connection = Connection::new(config, store, wire.clone(), device);
        let good = connection.snapshot(&session).unwrap();
        assert_eq!(good.environment, "staging");
        assert!(good.capabilities.selected_sync.allowed);
        assert!(good.validate(account, session_id, device).is_err());
        wire.0.lock().unwrap().environment = "production".into();
        assert!(matches!(
            connection.snapshot(&session),
            Err(Error::Protocol)
        ));
        let mut changed = wire.0.lock().unwrap();
        changed.environment = "staging".into();
        changed.capabilities.managed_ai.allowed = true;
        drop(changed);
        assert!(matches!(
            connection.snapshot(&session),
            Err(Error::Protocol)
        ));
    }
    #[cfg(debug_assertions)]
    #[test]
    fn staging_issuers_and_endpoints_isolate_devices_outboxes_cursors_and_job_keys() {
        let key = "sb_publishable_fixture_public_key_only";
        let production =
            Config::production("https://api.example", "abcdefghijklmnopqrst", key).unwrap();
        let first = Config::debug_staging("https://stage-api.example", "abcdefghijklmnopqrst", key)
            .unwrap();
        let another_endpoint =
            Config::debug_staging("https://other-stage.example", "abcdefghijklmnopqrst", key)
                .unwrap();
        let another_issuer =
            Config::debug_staging("https://stage-api.example", "zyxwvutsrqponmlkjihg", key)
                .unwrap();
        let temp = tempfile::tempdir().unwrap();
        let account = Uuid::new_v4();
        let request = Uuid::new_v4();
        let job = Uuid::new_v4();
        let states: Vec<_> = [&production, &first, &another_endpoint, &another_issuer]
            .iter()
            .map(|config| {
                outbox::LocalState::at(
                    temp.path()
                        .join(&config.local_namespace)
                        .join("outbox.sqlite3"),
                )
            })
            .collect();
        let mut devices = std::collections::HashSet::new();
        for state in &states {
            assert!(devices.insert(state.device_id().unwrap()));
        }
        states[0]
            .put(&outbox::Pending {
                request_id: request,
                object_id: Uuid::new_v4(),
                account_id: account,
                kind: "chat".into(),
                filename: None,
                base_revision_id: None,
                upload_id: None,
                next_chunk: 0,
                payload: b"reviewed fixture".to_vec(),
            })
            .unwrap();
        states[0].remember_job(account, job).unwrap();
        states[0]
            .apply_changes(account, &json!({"items":[],"changeCursor":"42"}))
            .unwrap();
        assert_eq!(states[0].list(account).unwrap().len(), 1);
        for state in &states[1..] {
            assert!(state.list(account).unwrap().is_empty());
            assert!(state.last_job(account).unwrap().is_none());
            assert_eq!(state.cursor(account).unwrap(), "0");
        }
        assert_ne!(first.scope, another_endpoint.scope);
        assert_ne!(first.scope, another_issuer.scope);
    }
}
