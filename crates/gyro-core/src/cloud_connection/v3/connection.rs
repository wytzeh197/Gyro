use super::{
    project::{self, Selection},
    transfer::{Http, Outbox, Pending},
    Error, POLICY, VERSION,
};
use crate::cloud_connection::supabase::{
    Client, EntryIntent, MacKeychain, RefreshStore, Session, StagingConfig,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use uuid::Uuid;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    enabled: bool,
    contract_version: String,
    policy_version: String,
    environment: String,
    api_origin: Option<String>,
    auth_project: Option<String>,
    auth_publishable_key: Option<String>,
    production_isolation_verified: bool,
}
struct State {
    generation: u64,
    session: Option<Arc<Session>>,
    registered: bool,
    email: Option<String>,
    intent: Option<Value>,
    remember: bool,
    previews: HashMap<Uuid, Selection>,
    transfers: HashMap<Uuid, Arc<AtomicBool>>,
}
pub struct Connection {
    origin: String,
    auth: Client,
    store: Arc<dyn RefreshStore>,
    outbox: Outbox,
    device: Uuid,
    state: Mutex<State>,
    refresh_gate: Mutex<()>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub configured: bool,
    pub connected: bool,
    pub registered: bool,
    pub contract_version: &'static str,
    pub policy_version: &'static str,
    pub account_id: Option<Uuid>,
}
fn reviewed_production_project(project: &str) -> bool {
    let Ok(pins) = serde_json::from_str::<Value>(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../config/cloud-production.json"
    ))) else {
        return false;
    };
    pins["environment"] == "production"
        && pins["environmentIsolationVerified"] == true
        && pins["authProject"].as_str() == Some(project)
        && pins["stagingAuthProject"].as_str().is_some_and(|staging| {
            staging.len() == 20
                && staging.bytes().all(|b| b.is_ascii_lowercase())
                && staging != project
        })
}
impl Connection {
    /// Configuration is an explicit release choice. Construction neither signs in
    /// nor registers a Cloud account. Production pins cannot reuse staging projects.
    pub fn from_build() -> Option<Self> {
        // Standalone debug staging builds can carry reviewed public pins without
        // changing the disabled public release configuration. Never accepts a
        // production override or a runtime/renderer-supplied configuration.
        let public_config = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../config/cloud-v3.json"
        ));
        let staging_override = if cfg!(debug_assertions) {
            option_env!("GYRO_CLOUD_V3_STAGING_CONFIG_JSON")
        } else {
            None
        };
        let c: Config = serde_json::from_str(staging_override.unwrap_or(public_config)).ok()?;
        if staging_override.is_some() && c.environment != "staging" {
            return None;
        }
        if !c.enabled
            || c.contract_version != VERSION
            || !super::supported_policy(&c.policy_version)
        {
            return None;
        }
        let staging = c.environment == "staging";
        if staging && !cfg!(debug_assertions)
            || !staging && (c.environment != "production" || !c.production_isolation_verified)
        {
            return None;
        }
        let project = c.auth_project?;
        if !staging && !reviewed_production_project(&project) {
            return None;
        }
        let auth = StagingConfig::new(&project, &c.auth_publishable_key?).ok()?;
        let origin = c.api_origin?;
        let url = url::Url::parse(&origin).ok()?;
        if url.scheme() != "https"
            || url.path() != "/"
            || url.host_str().is_none()
            || url.username() != ""
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return None;
        }
        let scope = format!(
            "{:x}",
            Sha256::digest(format!("{project}|{origin}|{VERSION}"))
        );
        let paths = crate::paths::GyroPaths::for_current_user().ok()?;
        let root = paths
            .base_dir
            .join(if staging {
                "cloud-staging-v3"
            } else {
                "cloud-production-v3"
            })
            .join(&scope);
        let store = Arc::new(MacKeychain::v3(&auth, staging, &scope));
        // Stable device identity is created only on the first deliberate Cloud action.
        Some(Self {
            origin: origin.trim_end_matches('/').into(),
            auth: Client::new(auth),
            store,
            outbox: Outbox::at(root),
            device: Uuid::nil(),
            refresh_gate: Mutex::new(()),
            state: Mutex::new(State {
                generation: 0,
                session: None,
                registered: false,
                email: None,
                intent: None,
                remember: false,
                previews: HashMap::new(),
                transfers: HashMap::new(),
            }),
        })
    }
    fn device(&self) -> Result<Uuid, Error> {
        if !self.device.is_nil() {
            return Ok(self.device);
        }
        let path = self.outbox.root().join("device");
        project::private_dir(self.outbox.root())?;
        if path.exists() {
            return read_device_identity(&path);
        }
        let id = Uuid::new_v4();
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        match options.open(&path) {
            Ok(mut f) => {
                f.write_all(id.to_string().as_bytes())?;
                f.sync_all()?;
                Ok(id)
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => read_device_identity(&path),
            Err(e) => Err(e.into()),
        }
    }
    pub fn view(&self) -> View {
        let s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        View {
            configured: true,
            connected: s.session.as_ref().is_some_and(|s| s.is_fresh()),
            registered: s.registered,
            contract_version: VERSION,
            policy_version: POLICY,
            account_id: s.session.as_ref().map(|s| s.account_id()),
        }
    }
    /// Public identity fields only; the webview never receives Auth credentials.
    pub fn profile(&self) -> Result<Value, Error> {
        let (generation, session) = self.session()?;
        let profile = self
            .auth
            .profile(&session)
            .map_err(|_| Error::Unavailable)?;
        self.stale(generation)?;
        let mut value = serde_json::to_value(profile)?;
        value["deviceId"] = serde_json::to_value(self.device()?)?;
        Ok(value)
    }
    pub fn update_profile(&self, display_name: &str) -> Result<Value, Error> {
        let (generation, session) = self.session()?;
        let profile = self
            .auth
            .update_profile(&session, display_name)
            .map_err(|_| Error::Unavailable)?;
        self.stale(generation)?;
        let mut value = serde_json::to_value(profile)?;
        value["deviceId"] = serde_json::to_value(self.device()?)?;
        Ok(value)
    }
    /// Native-only rotation. A consumed credential is never retried after an
    /// ambiguous result; no application request has been dispatched at this point.
    fn session(&self) -> Result<(u64, Arc<Session>), Error> {
        {
            let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(session) = state.session.as_ref().filter(|s| {
                s.is_fresh() && s.expires_at() > chrono::Utc::now() + chrono::Duration::seconds(30)
            }) {
                return Ok((state.generation, session.clone()));
            }
        }
        let _rotation = self.refresh_gate.lock().unwrap_or_else(|e| e.into_inner());
        let (generation, previous, remember, credential) = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let previous = state.session.clone().ok_or(Error::SessionUnavailable)?;
            if previous.is_fresh()
                && previous.expires_at() > chrono::Utc::now() + chrono::Duration::seconds(30)
            {
                return Ok((state.generation, previous));
            }
            let credential = if state.remember {
                let saved = self
                    .store
                    .load()
                    .map_err(|_| Error::Keychain)?
                    .ok_or(Error::SessionUnavailable)?;
                if !previous.matches_refresh_credential(&saved) {
                    // Another account or process replaced the remembered login.
                    // Do not rotate, erase, or revoke that different credential.
                    return Err(Error::SessionUnavailable);
                }
                self.store.clear().map_err(|_| Error::Keychain)?;
                saved
            } else {
                previous.refresh_credential()
            };
            // Other callers wait on refresh_gate. If the response is lost, the
            // rotating credential cannot be selected again from memory or disk.
            state.session = None;
            (state.generation, previous, state.remember, credential)
        };
        let refreshed = self
            .auth
            .refresh(&credential)
            .map_err(|_| Error::SessionUnavailable)
            .and_then(|session| {
                if session.account_id() != previous.account_id()
                    || session.session_id().ok() != previous.session_id().ok()
                    || session.session_id().is_err()
                {
                    let _ = self.auth.logout_current_session(&session);
                    return Err(Error::SessionUnavailable);
                }
                Ok(Arc::new(session))
            });
        let session = match refreshed {
            Ok(session) => session,
            Err(error) => {
                let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                if state.generation == generation {
                    state.generation += 1;
                    state.registered = false;
                    state.previews.clear();
                    for flag in state.transfers.values() {
                        flag.store(true, Ordering::SeqCst);
                    }
                    state.transfers.clear();
                }
                return Err(error);
            }
        };
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.generation != generation {
            drop(state);
            let _ = self.auth.logout_current_session(&session);
            return Err(Error::Identity);
        }
        if remember && self.store.save(&session).is_err() {
            state.generation += 1;
            state.registered = false;
            for flag in state.transfers.values() {
                flag.store(true, Ordering::SeqCst);
            }
            state.transfers.clear();
            state.previews.clear();
            drop(state);
            let _ = self.auth.logout_current_session(&session);
            return Err(Error::Keychain);
        }
        state.session = Some(session.clone());
        Ok((generation, session))
    }
    pub fn refreshed_view(&self) -> View {
        // Absent credentials neither load Keychain nor create an account. The
        // desktop executes this on a blocking worker, never its UI thread.
        let _ = self.session();
        self.view()
    }
    fn http<'a>(
        &'a self,
        origin: &'a str,
        session: &'a Session,
        generation: u64,
    ) -> Result<Http<'a>, Error> {
        Ok(
            Http::new(origin, session, self.device()?)?.renewing(move || {
                self.stale(generation)?;
                let (current, session) = self.session()?;
                if current != generation {
                    return Err(Error::Identity);
                }
                Ok(session)
            }),
        )
    }
    fn stale(&self, generation: u64) -> Result<(), Error> {
        if self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .generation
            != generation
        {
            return Err(Error::Identity);
        }
        Ok(())
    }
    fn public_post(&self, path: &str, value: Value) -> Result<Value, Error> {
        use std::io::Read;
        let agent = ureq::AgentBuilder::new()
            .redirects(0)
            .timeout(std::time::Duration::from_secs(15))
            .build();
        let response = agent
            .post(&format!("{}{}", self.origin, path))
            .send_json(value)
            .map_err(|_| Error::Unavailable)?;
        let mut bytes = Vec::new();
        response.into_reader().take(32769).read_to_end(&mut bytes)?;
        if bytes.len() > 32768 {
            return Err(Error::Limit);
        }
        let v: Value = serde_json::from_slice(&bytes)?;
        if v["contractVersion"] != VERSION
            || !v["policyVersion"]
                .as_str()
                .is_some_and(super::supported_policy)
        {
            return Err(Error::Integrity);
        }
        Ok(v["result"].clone())
    }
    pub fn begin(&self, email: &str, subscribe: bool, remember: bool) -> Result<(), Error> {
        let generation = {
            let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if s.session.as_ref().is_some_and(|session| session.is_fresh()) {
                return Err(Error::Identity);
            }
            s.session = None;
            s.generation += 1;
            s.registered = false;
            s.previews.clear();
            for flag in s.transfers.values() {
                flag.store(true, Ordering::SeqCst);
            }
            s.transfers.clear();
            s.generation
        };
        let intent = if subscribe {
            Some(self.public_post("/v3/intents", json!({"planId":"cloud"}))?)
        } else {
            None
        };
        self.auth
            .request_email_code(
                email,
                if subscribe {
                    EntryIntent::Subscribe
                } else {
                    EntryIntent::Restore
                },
            )
            .map_err(|_| Error::Unavailable)?;
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if s.generation != generation
            || s.session.as_ref().is_some_and(|session| session.is_fresh())
        {
            return Err(Error::Identity);
        }
        s.email = Some(email.into());
        s.intent = intent;
        s.remember = remember;
        Ok(())
    }
    pub fn verify(&self, code: &str, remember: bool) -> Result<Value, Error> {
        let (generation, email, intent) = {
            let s = self.state.lock().unwrap_or_else(|e| e.into_inner());
            (
                s.generation,
                s.email.clone().ok_or(Error::Identity)?,
                s.intent.clone(),
            )
        };
        let session = Arc::new(
            self.auth
                .verify_email_code(&email, code)
                .map_err(|_| Error::SessionUnavailable)?,
        );
        let origin = format!("{}/", self.origin);
        let http = Http::new(&origin, &session, self.device()?)?;
        if let Some(intent) = intent {
            http.json(
                "POST",
                "/v3/accounts",
                json!({"intentId":intent["intentId"],"secret":intent["secret"]}),
            )?;
        }
        drop(http);
        self.finish_session(session, generation, remember)
    }
    fn finish_session(
        &self,
        session: Arc<Session>,
        generation: u64,
        remember: bool,
    ) -> Result<Value, Error> {
        let origin = format!("{}/", self.origin);
        let http = Http::new(&origin, &session, self.device()?)?;
        let value = match http.json(
            "POST",
            "/v3/devices",
            json!({"deviceId":self.device()?,"label":"Mac"}),
        ) {
            Ok(v) => v,
            Err(Error::DeviceLimit) => json!({"registered":false,"reason":"device-limit"}),
            Err(Error::DeviceRevoked) => json!({"registered":false,"reason":"device-revoked"}),
            Err(Error::Unavailable) if remember => {
                // Auth has already consumed the old credential. A Cloud outage
                // must not discard its verified replacement and require email
                // proof again. Retain only the refresh credential, without
                // granting a connected or registered session. The next explicit
                // reconnect exchanges the replacement, never the consumed one.
                let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
                if s.generation != generation {
                    drop(s);
                    let _ = self.auth.logout_current_session(&session);
                    return Err(Error::Identity);
                }
                if self.store.save(&session).is_err() {
                    drop(s);
                    let _ = self.auth.logout_current_session(&session);
                    return Err(Error::Keychain);
                }
                s.generation += 1;
                s.session = None;
                s.registered = false;
                s.email = None;
                s.intent = None;
                s.previews.clear();
                for flag in s.transfers.values() {
                    flag.store(true, Ordering::SeqCst);
                }
                s.transfers.clear();
                return Err(Error::Unavailable);
            }
            Err(e) => {
                let _ = self.auth.logout_current_session(&session);
                return Err(e);
            }
        };
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if s.generation != generation {
            let _ = self.auth.logout_current_session(&session);
            return Err(Error::Identity);
        }
        if remember {
            if self.store.save(&session).is_err() {
                let _ = self.auth.logout_current_session(&session);
                return Err(Error::Keychain);
            }
        } else if self.store.clear().is_err() {
            let _ = self.auth.logout_current_session(&session);
            return Err(Error::Keychain);
        }
        drop(http);
        s.session = Some(session);
        s.registered = value["registered"] == true;
        s.remember = remember;
        s.email = None;
        s.intent = None;
        Ok(value)
    }
    pub fn restore_session(&self) -> Result<(), Error> {
        let _rotation = self.refresh_gate.lock().unwrap_or_else(|e| e.into_inner());
        let generation = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.generation += 1;
            state.session = None;
            state.registered = false;
            state.previews.clear();
            for flag in state.transfers.values() {
                flag.store(true, Ordering::SeqCst);
            }
            state.transfers.clear();
            state.generation
        };
        let saved = self
            .store
            .take_for_reconnect()
            .map_err(|_| Error::Keychain)?
            .ok_or(Error::SessionUnavailable)?;
        let session = Arc::new(
            self.auth
                .refresh(&saved)
                .map_err(|_| Error::SessionUnavailable)?,
        );
        self.finish_session(session, generation, true).map(|_| ())
    }
    pub fn register_device(&self, new_identity: bool) -> Result<Value, Error> {
        let (generation, session) = self.session()?;
        if new_identity {
            let s = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if s.registered {
                return Err(Error::Identity);
            }
            drop(s);
            use std::io::Write;
            let path = self.outbox.root().join("device");
            let temporary = self
                .outbox
                .root()
                .join(format!("{}.device", Uuid::new_v4()));
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
            }
            let mut f = options.open(&temporary)?;
            f.write_all(Uuid::new_v4().to_string().as_bytes())?;
            f.sync_all()?;
            std::fs::rename(temporary, path)?;
        }
        let remember = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remember;
        self.finish_session(session, generation, remember)
    }
    pub fn sign_out(&self) -> Result<(), Error> {
        let session = {
            let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
            s.generation += 1;
            s.previews.clear();
            for transfer in s.transfers.values() {
                transfer.store(true, Ordering::SeqCst);
            }
            s.transfers.clear();
            s.email = None;
            s.intent = None;
            s.registered = false;
            s.session.take()
        };
        let cleared = self.store.clear().map_err(|_| Error::Keychain);
        if let Some(session) = session {
            let origin = format!("{}/", self.origin);
            // A broken local device file must not skip Auth session revocation.
            if let Ok(device) = self.device() {
                if let Ok(http) = Http::new(&origin, &session, device) {
                    let _ = http.json("POST", "/v3/sign-out", json!({}));
                }
            }
            self.auth
                .logout_current_session(&session)
                .map_err(|_| Error::Unavailable)?;
        }
        cleared
    }
    pub fn consent_identity(&self) -> Result<(u64, Uuid), Error> {
        let (generation, session) = self.session()?;
        Ok((generation, session.account_id()))
    }
    pub fn preview_project(&self, root: &Path) -> Result<Value, Error> {
        let (generation, _) = self.session()?;
        let selected = project::preview(root)?;
        let value = serde_json::to_value(&selected.preview)?;
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if s.generation != generation {
            return Err(Error::Identity);
        }
        s.previews.clear();
        s.previews.insert(selected.preview.ticket, selected);
        Ok(value)
    }
    pub fn discard_preview(&self, ticket: Uuid) -> Result<(), Error> {
        self.session()?;
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .previews
            .remove(&ticket);
        Ok(())
    }
    pub fn prepare(
        &self,
        ticket: Uuid,
        object: Uuid,
        base: Option<Uuid>,
        label: String,
        reviewed: bool,
    ) -> Result<Value, Error> {
        if !reviewed || label.trim().is_empty() || label.len() > 120 {
            return Err(Error::Integrity);
        }
        let (generation, session) = self.session()?;
        let selection = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .previews
            .remove(&ticket)
            .ok_or(Error::Changed)?;
        let prepared = project::prepare(&selection, self.outbox.root())?;
        self.stale(generation)?;
        let pending = Pending {
            request_id: Uuid::new_v4(),
            account_id: session.account_id(),
            device_id: self.device()?,
            object_id: object,
            base_revision_id: base,
            label,
            kind: "project".into(),
            prepared,
            upload_id: None,
            remote_request_id: None,
        };
        self.outbox.save(&pending)?;
        Ok(serde_json::to_value(pending)?)
    }
    pub fn resume(&self, request: Uuid) -> Result<Value, Error> {
        let (generation, session) = self.session()?;
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.transfers.contains_key(&request) || state.transfers.len() >= 2 {
                return Err(Error::Busy);
            }
            state.transfers.insert(request, cancelled.clone());
        }
        let origin = format!("{}/", self.origin);
        let result = (|| {
            let active = || {
                let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                state.generation == generation && !cancelled.load(Ordering::SeqCst)
            };
            let http = self
                .http(&origin, &session, generation)?
                .controlled(&active);
            self.outbox.resume_controlled(
                &http,
                request,
                session.account_id(),
                self.device()?,
                &active,
            )
        })();
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state
            .transfers
            .get(&request)
            .is_some_and(|v| Arc::ptr_eq(v, &cancelled))
        {
            state.transfers.remove(&request);
        }
        drop(state);
        result
    }
    pub fn renew(&self, request: Uuid) -> Result<(), Error> {
        let (generation, session) = self.session()?;
        let origin = format!("{}/", self.origin);
        let http = self.http(&origin, &session, generation)?;
        self.outbox
            .renew(&http, request, session.account_id(), self.device()?)
    }
    pub fn cancel(&self, request: Uuid) -> Result<(), Error> {
        let (generation, session) = self.session()?;
        if let Some(flag) = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .transfers
            .get(&request)
        {
            flag.store(true, Ordering::SeqCst);
        }
        let origin = format!("{}/", self.origin);
        let http = self.http(&origin, &session, generation)?;
        self.outbox
            .cancel(&http, request, session.account_id(), self.device()?)
    }
    pub fn pending(&self) -> Result<Value, Error> {
        let (generation, session) = self.session()?;
        let pending = self.outbox.pending(session.account_id(), self.device()?)?;
        let running = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .transfers
            .keys()
            .copied()
            .collect::<std::collections::HashSet<_>>();
        let origin = format!("{}/", self.origin);
        let http = self.http(&origin, &session, generation)?;
        let mut checked = 0;
        let mut items = Vec::with_capacity(pending.len());
        for p in pending {
            let mut value = serde_json::to_value(&p)?;
            let local_running = running.contains(&p.request_id);
            value["localRunning"] = json!(local_running);
            value["cancelRequested"] = json!(self.outbox.cancelled(p.request_id));
            let mut status = self.outbox.completed_status(&p);
            // Bounded migration of old prepared copies and verification polling.
            // Cached receipts are historical presentation, never access authority.
            if status.is_none()
                && !local_running
                && !self.outbox.cancelled(p.request_id)
                && checked < 2
            {
                if let Some(id) = p.upload_id {
                    checked += 1;
                    if let Ok(response) = super::transfer::Remote::status(&http, id) {
                        self.stale(generation)?;
                        if self.outbox.remember_completed(&p, &response).is_ok() {
                            status = response["status"].as_str().map(str::to_owned);
                        }
                    }
                }
            }
            value["cloudStatus"] = json!(status);
            items.push(value);
        }
        self.stale(generation)?;
        Ok(Value::Array(items))
    }
    pub fn save_content(
        &self,
        kind: &str,
        label: &str,
        bytes: &[u8],
        object: Uuid,
        base: Option<Uuid>,
        reviewed: bool,
    ) -> Result<Value, Error> {
        use std::io::Write;
        if !reviewed
            || !["chat", "handoff", "report"].contains(&kind)
            || bytes.len()
                > if kind == "chat" {
                    4 * 1024 * 1024
                } else {
                    1024 * 1024
                }
            || label.trim().is_empty()
            || label.len() > 120
        {
            return Err(Error::Limit);
        }
        let (generation, session) = self.session()?;
        project::private_dir(self.outbox.root())?;
        let id = Uuid::new_v4();
        let path = self.outbox.root().join(format!("{id}.pack"));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options.open(path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        self.stale(generation)?;
        let prepared = project::Prepared {
            id,
            size: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
            manifest_sha256: String::new(),
            files: 0,
        };
        let pending = Pending {
            request_id: Uuid::new_v4(),
            account_id: session.account_id(),
            device_id: self.device()?,
            object_id: object,
            base_revision_id: base,
            label: label.into(),
            kind: kind.into(),
            prepared,
            upload_id: None,
            remote_request_id: None,
        };
        self.outbox.save(&pending)?;
        Ok(serde_json::to_value(pending)?)
    }
    pub fn read_chat(&self, revision: Uuid) -> Result<Value, Error> {
        let (generation, session) = self.session()?;
        let origin = format!("{}/", self.origin);
        let http = self.http(&origin, &session, generation)?;
        use super::transfer::Remote;
        let meta = http.revision(revision)?;
        let size = meta["size_bytes"]
            .as_u64()
            .or_else(|| meta["size_bytes"].as_str().and_then(|s| s.parse().ok()))
            .ok_or(Error::Integrity)?;
        if meta["kind"] != "chat" || size > 4 * 1024 * 1024 {
            return Err(Error::Limit);
        }
        let bytes = http.download(revision, 0)?;
        if bytes.len() as u64 != size
            || format!("{:x}", Sha256::digest(&bytes))
                != meta["sha256"].as_str().ok_or(Error::Integrity)?
        {
            return Err(Error::Integrity);
        }
        let value: super::continuity::SavedChat = serde_json::from_slice(&bytes)?;
        if value.format != "gyro-continuity-chat-v1"
            || value.unsupported.is_empty()
            || value.unsupported.len() > 20
        {
            return Err(Error::Integrity);
        }
        let archive = value.archive;
        archive.bytes().map_err(|_| Error::Integrity)?;
        self.stale(generation)?;
        Ok(
            json!({"archive":archive,"projectRevision":value.project_revision,"unsupported":value.unsupported,"freshSessionRequired":true,"authorityTransferred":false}),
        )
    }
    pub fn publish_phone(&self, content: Value) -> Result<Value, Error> {
        if serde_json::to_vec(&content)?.len() > 32 * 1024 {
            return Err(Error::Limit);
        }
        let (generation, session) = self.session()?;
        let origin = format!("{}/", self.origin);
        let result =
            self.http(&origin, &session, generation)?
                .json("POST", "/v3/phone/publish", content)?;
        self.stale(generation)?;
        Ok(result)
    }
    pub fn read_report(&self, revision: Uuid) -> Result<Value, Error> {
        let (generation, session) = self.session()?;
        let origin = format!("{}/", self.origin);
        let http = self.http(&origin, &session, generation)?;
        use super::transfer::Remote;
        let meta = http.revision(revision)?;
        let size = meta["size_bytes"]
            .as_u64()
            .or_else(|| meta["size_bytes"].as_str().and_then(|s| s.parse().ok()))
            .ok_or(Error::Integrity)?;
        if meta["kind"] != "report" || size > 1024 * 1024 {
            return Err(Error::Limit);
        }
        let bytes = http.download(revision, 0)?;
        if bytes.len() as u64 != size
            || format!("{:x}", Sha256::digest(&bytes))
                != meta["sha256"].as_str().ok_or(Error::Integrity)?
        {
            return Err(Error::Integrity);
        }
        let text = String::from_utf8(bytes).map_err(|_| Error::Integrity)?;
        self.stale(generation)?;
        Ok(json!({"text":text,"readOnly":true,"authorityTransferred":false}))
    }
    pub fn restore_project(&self, revision: Uuid, destination: &Path) -> Result<(), Error> {
        let (generation, session) = self.session()?;
        let origin = format!("{}/", self.origin);
        let active = || self.stale(generation).is_ok();
        let http = self
            .http(&origin, &session, generation)?
            .controlled(&active);
        let p = self.outbox.download(&http, revision)?;
        self.stale(generation)?;
        self.outbox.restore_download(&p, destination)
    }
    pub fn export_to(&self, id: Uuid, parent: &Path) -> Result<usize, Error> {
        let (generation, session) = self.session()?;
        let origin = format!("{}/", self.origin);
        let active = || self.stale(generation).is_ok();
        let http = self
            .http(&origin, &session, generation)?
            .controlled(&active);
        let count = http.export_account(id, parent, session.account_id())?;
        self.stale(generation)?;
        Ok(count)
    }
    pub fn service(&self, command: Command) -> Result<Value, Error> {
        let (generation, session) = self.session()?;
        let origin = format!("{}/", self.origin);
        let http = self.http(&origin, &session, generation)?;
        let (method, path, body) = match command {
            Command::RecoverLastJob => (
                "GET",
                format!(
                    "/v3/jobs/by-request/{}",
                    self.outbox.last_ai(session.account_id())?
                ),
                Value::Null,
            ),
            Command::Policy => ("GET", "/v3/policy".into(), Value::Null),
            Command::Capabilities => ("GET", "/v3/capabilities".into(), Value::Null),
            Command::PhonePair => ("POST", "/v3/phone/pairs".into(), json!({})),
            Command::PhoneDevices => ("GET", "/v3/phone/devices".into(), Value::Null),
            Command::RevokePhone { device_id } => (
                "DELETE",
                format!("/v3/phone/devices/{device_id}"),
                Value::Null,
            ),
            Command::Usage => ("GET", "/v3/usage".into(), Value::Null),
            Command::Wallet => ("GET", "/v3/wallet".into(), Value::Null),
            Command::Devices => ("GET", "/v3/devices".into(), Value::Null),
            Command::RevokeDevice { device_id } => {
                ("DELETE", format!("/v3/devices/{device_id}"), Value::Null)
            }
            Command::Versions { object_id, cursor } => (
                "GET",
                format!(
                    "/v3/versions?{}{}",
                    object_id
                        .map(|id| format!("objectId={id}&"))
                        .unwrap_or_default(),
                    cursor.map(|id| format!("after={id}")).unwrap_or_default()
                ),
                Value::Null,
            ),
            Command::DeleteVersion { revision_id } => (
                "DELETE",
                format!("/v3/revisions/{revision_id}"),
                Value::Null,
            ),
            Command::Checkout {
                request_id,
                plan_id,
            } => {
                let selected = plan_id.unwrap_or_else(|| "cloud".into());
                if !["cloud", "plus"].contains(&selected.as_str()) {
                    return Err(Error::Integrity);
                }
                (
                    "POST",
                    "/v3/checkout".into(),
                    json!({"requestId":request_id,"planId":selected}),
                )
            }
            Command::Billing => ("POST", "/v3/billing".into(), json!({})),
            Command::BeginExport => ("POST", "/v3/exports".into(), json!({})),
            Command::Submit {
                request_id,
                task,
                context,
                source_ids,
                reviewed,
            } => {
                if !reviewed
                    || ![
                        "handoff-summary",
                        "failure-explanation",
                        "check-plan",
                        "test-suggestions",
                        "change-review",
                        "check-comparison",
                    ]
                    .contains(&task.as_str())
                {
                    return Err(Error::Integrity);
                }
                self.outbox.remember_ai(session.account_id(), request_id)?;
                (
                    "POST",
                    "/v3/jobs".into(),
                    json!({"requestId":request_id,"task":task,"context":context,"sourceIds":source_ids,"consent":true}),
                )
            }
            Command::Job { job_id } => ("GET", format!("/v3/jobs/{job_id}"), Value::Null),
            Command::CancelJob { job_id } => ("DELETE", format!("/v3/jobs/{job_id}"), Value::Null),
        };
        let value = http.json(method, &path, body)?;
        self.stale(generation)?;
        Ok(value)
    }
}
#[derive(Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Command {
    Policy,
    Capabilities,
    RecoverLastJob,
    PhonePair,
    PhoneDevices,
    RevokePhone {
        device_id: Uuid,
    },
    Usage,
    Wallet,
    Devices,
    RevokeDevice {
        device_id: Uuid,
    },
    Versions {
        object_id: Option<Uuid>,
        cursor: Option<Uuid>,
    },
    DeleteVersion {
        revision_id: Uuid,
    },
    Checkout {
        request_id: Uuid,
        plan_id: Option<String>,
    },
    Billing,
    BeginExport,
    Submit {
        request_id: Uuid,
        task: String,
        context: String,
        source_ids: Vec<String>,
        reviewed: bool,
    },
    Job {
        job_id: Uuid,
    },
    CancelJob {
        job_id: Uuid,
    },
}

fn read_device_identity(path: &Path) -> Result<Uuid, Error> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    if !file.metadata()?.is_file() || file.metadata()?.len() != 36 {
        return Err(Error::Integrity);
    }
    let mut value = String::new();
    file.take(37).read_to_string(&mut value)?;
    Uuid::parse_str(&value).map_err(|_| Error::Integrity)
}

#[cfg(test)]
#[path = "connection_tests.rs"]
mod connection_tests;
