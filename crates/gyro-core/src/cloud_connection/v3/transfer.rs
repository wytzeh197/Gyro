use super::{
    project::{self, Prepared},
    Error, CHUNK, VERSION,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::{
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use uuid::Uuid;

/// Bounded binary fan-out. Metadata, billing and AI mutations stay serial.
pub(super) const PARALLEL_CHUNKS: usize = 4;
pub(super) fn parallel_chunks<T: Send>(
    count: usize,
    work: impl Fn(usize) -> Result<T, Error> + Sync,
) -> Result<Vec<Result<T, Error>>, Error> {
    if count > PARALLEL_CHUNKS {
        return Err(Error::Limit);
    }
    Ok(std::thread::scope(|scope| {
        let work = &work;
        let handles: Vec<_> = (0..count).map(|i| scope.spawn(move || work(i))).collect();
        // Join every request, including after a failure; nothing dispatches after return.
        handles
            .into_iter()
            .map(|h| h.join().unwrap_or(Err(Error::Unavailable)))
            .collect()
    }))
}

/// Tokens are borrowed from a verified native session, never serialized to IPC.
pub struct Http<'a> {
    origin: &'a str,
    device: Uuid,
    agent: ureq::Agent,
    session: &'a crate::cloud_connection::supabase::Session,
    active: Option<&'a (dyn Fn() -> bool + Sync)>,
    renew: Option<
        Box<dyn Fn() -> Result<Arc<crate::cloud_connection::supabase::Session>, Error> + Sync + 'a>,
    >,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    contract_version: String,
    policy_version: String,
    result: Value,
}
impl<'a> Http<'a> {
    pub(crate) fn new(
        origin: &'a str,
        session: &'a crate::cloud_connection::supabase::Session,
        device: Uuid,
    ) -> Result<Self, Error> {
        let url = url::Url::parse(origin).map_err(|_| Error::Unavailable)?;
        if url.scheme() != "https"
            || url.path() != "/"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !session.is_fresh()
        {
            return Err(Error::Unavailable);
        }
        Ok(Self {
            origin: origin.trim_end_matches('/'),
            device,
            session,
            active: None,
            renew: None,
            agent: ureq::AgentBuilder::new()
                .max_idle_connections_per_host(PARALLEL_CHUNKS)
                .redirects(0)
                .timeout(Duration::from_secs(90))
                .build(),
        })
    }
    pub(crate) fn controlled(mut self, active: &'a (dyn Fn() -> bool + Sync)) -> Self {
        self.active = Some(active);
        self
    }
    pub(crate) fn renewing(
        mut self,
        renew: impl Fn() -> Result<Arc<crate::cloud_connection::supabase::Session>, Error> + Sync + 'a,
    ) -> Self {
        self.renew = Some(Box::new(renew));
        self
    }
    fn is_active(&self) -> bool {
        self.active.is_none_or(|f| f())
    }
    fn request_session(
        &self,
    ) -> Result<Option<Arc<crate::cloud_connection::supabase::Session>>, Error> {
        if !self.is_active() {
            return Err(Error::Cancelled);
        }
        let renewed = self.renew.as_ref().map(|renew| renew()).transpose()?;
        let session = renewed.as_deref().unwrap_or(self.session);
        if !session.is_fresh() {
            return Err(Error::SessionUnavailable);
        }
        if session.account_id() != self.session.account_id()
            || session.session_id().ok() != self.session.session_id().ok()
            || session.session_id().is_err()
        {
            return Err(Error::Identity);
        }
        if !self.is_active() {
            return Err(Error::Cancelled);
        }
        Ok(renewed)
    }
    fn request(
        &self,
        method: &str,
        path: &str,
        body: &[u8],
        binary: bool,
    ) -> Result<Vec<u8>, Error> {
        if !path.starts_with("/v3/") || path.contains("..") || path.contains('#') {
            return Err(Error::Path);
        }
        for attempt in 0..=2 {
            let renewed = self.request_session()?;
            let session = renewed.as_deref().unwrap_or(self.session);
            let request = self
                .agent
                .request(method, &format!("{}{}", self.origin, path))
                .set(
                    "Authorization",
                    &format!("Bearer {}", session.access_token()),
                )
                .set("X-Gyro-Device", &self.device.to_string())
                .set(
                    "Content-Type",
                    if binary {
                        "application/octet-stream"
                    } else {
                        "application/json"
                    },
                );
            let response = match if method == "GET" || method == "DELETE" {
                request.call()
            } else {
                request.send_bytes(body)
            } {
                Ok(r) => r,
                Err(ureq::Error::Status(_, r)) => r,
                Err(_) => return Err(Error::Unavailable),
            };
            let status = response.status();
            let retry_after = response
                .header("Retry-After")
                .and_then(|v| v.parse::<u64>().ok())
                .filter(|v| *v > 0 && *v <= 60)
                .unwrap_or(60);
            if response.header("X-Gyro-Contract") != Some(VERSION)
                || !response
                    .header("X-Gyro-Policy")
                    .is_some_and(super::supported_policy)
            {
                return Err(Error::Integrity);
            }
            let limit = if status >= 400 {
                8192
            } else if binary {
                CHUNK
            } else {
                9 * 1024 * 1024
            };
            let mut bytes = Vec::new();
            response
                .into_reader()
                .take((limit + 1) as u64)
                .read_to_end(&mut bytes)?;
            if bytes.len() > limit {
                return Err(Error::Limit);
            }
            if status >= 400 {
                let value: Value =
                    serde_json::from_slice(&bytes).map_err(|_| Error::Unavailable)?;
                if attempt < 2
                    && retryable_rate_limit(status, value["error"]["code"].as_str(), method, path)
                {
                    for _ in 0..retry_after * 4 {
                        if !self.is_active() {
                            return Err(Error::Cancelled);
                        }
                        std::thread::sleep(Duration::from_millis(250));
                    }
                    continue;
                }
                return Err(match value["error"]["code"].as_str() {
                    Some("device_limit") => Error::DeviceLimit,
                    Some("device_revoked") => Error::DeviceRevoked,
                    Some("session_unavailable") => Error::SessionUnavailable,
                    _ => Error::Unavailable,
                });
            }
            return Ok(bytes);
        }
        Err(Error::Unavailable)
    }
    pub fn json(&self, method: &str, path: &str, body: Value) -> Result<Value, Error> {
        let raw = self.request(method, path, &serde_json::to_vec(&body)?, false)?;
        let v: Envelope = serde_json::from_slice(&raw)?;
        if v.contract_version != VERSION || !super::supported_policy(&v.policy_version) {
            return Err(Error::Integrity);
        }
        if path == "/v3/wallet" && v.result["currency"] != "USD" {
            return Err(Error::Integrity);
        }
        Ok(v.result)
    }
    pub fn export_account(&self, id: Uuid, parent: &Path, account: Uuid) -> Result<usize, Error> {
        let root = parent.join(format!("gyro-export-{id}"));
        let marker = root.join(".gyro-export");
        let identity = format!("{account}/{id}");
        if root.exists() {
            if fs::symlink_metadata(&root)?.file_type().is_symlink()
                || fs::read_to_string(&marker)? != identity
            {
                return Err(Error::Destination);
            }
        } else {
            fs::create_dir(&root)?;
            project::private_dir(&root)?;
            let mut f = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&marker)?;
            f.write_all(identity.as_bytes())?;
            f.sync_all()?;
        }
        let mut after = None;
        let mut completed = 0;
        loop {
            let page = self.json(
                "GET",
                &format!(
                    "/v3/exports/{id}{}",
                    after
                        .map(|a: Uuid| format!("?after={a}"))
                        .unwrap_or_default()
                ),
                Value::Null,
            )?;
            let items = page.as_array().ok_or(Error::Integrity)?;
            if items.is_empty() {
                break;
            }
            for item in items {
                let revision: Uuid = serde_json::from_value(item["id"].clone())?;
                let meta = self.json(
                    "GET",
                    &format!("/v3/exports/{id}/revisions/{revision}"),
                    Value::Null,
                )?;
                let size = meta["size_bytes"]
                    .as_u64()
                    .or_else(|| meta["size_bytes"].as_str().and_then(|v| v.parse().ok()))
                    .ok_or(Error::Integrity)?;
                if size > super::MAX_PAYLOAD {
                    return Err(Error::Limit);
                }
                let path = root.join(format!("{revision}.gyrodata"));
                let mut options = OpenOptions::new();
                options.read(true).write(true).create(true);
                #[cfg(unix)]
                options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
                let mut file = options.open(&path)?;
                let mut full = Sha256::new();
                let chunks = meta["chunks"].as_array().ok_or(Error::Integrity)?;
                if chunks.len() != size.div_ceil(CHUNK as u64) as usize {
                    return Err(Error::Integrity);
                }
                for (index, c) in chunks.iter().enumerate() {
                    let n = (size - index as u64 * CHUNK as u64).min(CHUNK as u64) as usize;
                    let mut bytes = vec![0; n];
                    let offset = index as u64 * CHUNK as u64;
                    file.seek(SeekFrom::Start(offset))?;
                    let expected = c["sha256"].as_str().ok_or(Error::Integrity)?;
                    if !(file.read_exact(&mut bytes).is_ok()
                        && format!("{:x}", Sha256::digest(&bytes)) == expected)
                    {
                        bytes = self.request(
                            "GET",
                            &format!("/v3/exports/{id}/revisions/{revision}/chunks/{index}"),
                            &[],
                            true,
                        )?;
                        if bytes.len() != n || format!("{:x}", Sha256::digest(&bytes)) != expected {
                            return Err(Error::Integrity);
                        }
                        file.seek(SeekFrom::Start(offset))?;
                        file.write_all(&bytes)?;
                        file.sync_data()?;
                    }
                    full.update(bytes);
                }
                if format!("{:x}", full.finalize())
                    != meta["sha256"].as_str().ok_or(Error::Integrity)?
                {
                    return Err(Error::Integrity);
                }
                file.set_len(size)?;
                file.sync_all()?;
                let metadata = serde_json::to_vec_pretty(&meta)?;
                let metadata_path = root.join(format!("{revision}.metadata.json"));
                if !metadata_path.exists() {
                    let mut out = OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(metadata_path)?;
                    out.write_all(&metadata)?;
                    out.sync_all()?;
                }
                completed += 1;
                after = Some(revision);
            }
            if items.len() < 100 {
                break;
            }
        }
        Ok(completed)
    }
}
pub trait Remote {
    fn begin(&self, metadata: Value) -> Result<Value, Error>;
    fn status(&self, id: Uuid) -> Result<Value, Error>;
    fn chunk(&self, id: Uuid, index: usize, bytes: &[u8]) -> Result<(), Error>;
    fn chunk_batch(&self, id: Uuid, chunks: &[(usize, Vec<u8>)]) -> Result<(), Error> {
        for (index, bytes) in chunks {
            self.chunk(id, *index, bytes)?;
        }
        Ok(())
    }
    fn commit(&self, id: Uuid) -> Result<Value, Error>;
    fn cancel(&self, id: Uuid) -> Result<(), Error>;
    fn revision(&self, id: Uuid) -> Result<Value, Error>;
    fn download(&self, id: Uuid, index: usize) -> Result<Vec<u8>, Error>;
    fn download_batch(
        &self,
        id: Uuid,
        indices: &[usize],
    ) -> Result<Vec<Result<Vec<u8>, Error>>, Error> {
        Ok(indices
            .iter()
            .map(|index| self.download(id, *index))
            .collect())
    }
}
impl Remote for Http<'_> {
    fn begin(&self, m: Value) -> Result<Value, Error> {
        self.json("POST", "/v3/uploads", m)
    }
    fn status(&self, id: Uuid) -> Result<Value, Error> {
        self.json("GET", &format!("/v3/uploads/{id}"), Value::Null)
    }
    fn chunk(&self, id: Uuid, index: usize, bytes: &[u8]) -> Result<(), Error> {
        self.request(
            "PUT",
            &format!("/v3/uploads/{id}/chunks/{index}"),
            bytes,
            true,
        )
        .map(|_| ())
    }
    fn chunk_batch(&self, id: Uuid, chunks: &[(usize, Vec<u8>)]) -> Result<(), Error> {
        parallel_chunks(chunks.len(), |i| self.chunk(id, chunks[i].0, &chunks[i].1))?
            .into_iter()
            .collect::<Result<Vec<_>, _>>()
            .map(|_| ())
    }
    fn download_batch(
        &self,
        id: Uuid,
        indices: &[usize],
    ) -> Result<Vec<Result<Vec<u8>, Error>>, Error> {
        parallel_chunks(indices.len(), |i| self.download(id, indices[i]))
    }
    fn commit(&self, id: Uuid) -> Result<Value, Error> {
        self.json("POST", &format!("/v3/uploads/{id}/commit"), json!({}))
    }
    fn cancel(&self, id: Uuid) -> Result<(), Error> {
        self.json("DELETE", &format!("/v3/uploads/{id}"), Value::Null)
            .map(|_| ())
    }
    fn revision(&self, id: Uuid) -> Result<Value, Error> {
        self.json("GET", &format!("/v3/revisions/{id}"), Value::Null)
    }
    fn download(&self, id: Uuid, index: usize) -> Result<Vec<u8>, Error> {
        self.request(
            "GET",
            &format!("/v3/revisions/{id}/chunks/{index}"),
            &[],
            true,
        )
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pending {
    pub request_id: Uuid,
    pub account_id: Uuid,
    pub device_id: Uuid,
    pub object_id: Uuid,
    pub base_revision_id: Option<Uuid>,
    pub label: String,
    pub kind: String,
    pub prepared: Prepared,
    pub upload_id: Option<Uuid>,
    #[serde(default)]
    pub remote_request_id: Option<Uuid>,
}
/// Metadata only. Pack bytes never enter the renderer, SQLite record or JSON.
pub struct Outbox {
    root: PathBuf,
}
impl Outbox {
    pub fn at(root: PathBuf) -> Self {
        Self { root }
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    fn record(&self, id: Uuid) -> PathBuf {
        self.root.join(format!("{id}.json"))
    }
    /// Historical completion receipt for presentation only; never restore or entitlement authority.
    pub fn completed_status(&self, p: &Pending) -> Option<String> {
        let path = self.root.join(format!("{}.completed", p.request_id));
        let mut f = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
            .ok()?;
        if f.metadata().ok()?.len() > 512 {
            return None;
        }
        let mut bytes = Vec::new();
        f.read_to_end(&mut bytes).ok()?;
        let v: Value = serde_json::from_slice(&bytes).ok()?;
        if v["uploadId"] != json!(p.upload_id?)
            || v["accountId"] != json!(p.account_id)
            || v["deviceId"] != json!(p.device_id)
        {
            return None;
        }
        let status = v["status"].as_str()?;
        matches!(status, "committed" | "conflict").then(|| status.to_owned())
    }
    pub fn remember_completed(&self, p: &Pending, response: &Value) -> Result<(), Error> {
        let status = response["status"].as_str().ok_or(Error::Integrity)?;
        if !matches!(status, "committed" | "conflict") {
            return Ok(());
        }
        if response["uploadId"] != json!(p.upload_id.ok_or(Error::Integrity)?)
            || response["size"].as_u64() != Some(p.prepared.size)
        {
            return Err(Error::Integrity);
        }
        if self.cancelled(p.request_id) || !self.record(p.request_id).exists() {
            return Err(Error::Cancelled);
        }
        let v = json!({"uploadId":p.upload_id,"accountId":p.account_id,"deviceId":p.device_id,"status":status});
        let temporary = self.root.join(format!("{}.tmp", Uuid::new_v4()));
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&temporary)?;
        f.write_all(&serde_json::to_vec(&v)?)?;
        f.sync_all()?;
        fs::rename(
            temporary,
            self.root.join(format!("{}.completed", p.request_id)),
        )?;
        Ok(())
    }
    pub fn cancelled(&self, id: Uuid) -> bool {
        self.root.join(format!("{id}.cancelled")).exists()
    }
    pub fn save(&self, p: &Pending) -> Result<(), Error> {
        project::private_dir(&self.root)?;
        if self.cancelled(p.request_id) {
            return Err(Error::Cancelled);
        }
        let bytes = serde_json::to_vec(p)?;
        if bytes.len() > 8192 {
            return Err(Error::Limit);
        }
        let temporary = self.root.join(format!("{}.tmp", Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        let mut out = options.open(&temporary)?;
        out.write_all(&bytes)?;
        out.sync_all()?;
        fs::rename(temporary, self.record(p.request_id))?;
        if self.cancelled(p.request_id) {
            let _ = fs::remove_file(self.record(p.request_id));
            return Err(Error::Cancelled);
        }
        Ok(())
    }
    pub fn read(&self, id: Uuid, account: Uuid, device: Uuid) -> Result<Pending, Error> {
        let path = self.record(id);
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)?;
        if file.metadata()?.len() > 8192 {
            return Err(Error::Limit);
        }
        let mut b = Vec::new();
        file.read_to_end(&mut b)?;
        let p: Pending = serde_json::from_slice(&b)?;
        if p.request_id != id || p.account_id != account || p.device_id != device {
            return Err(Error::Identity);
        }
        Ok(p)
    }
    pub fn pending(&self, account: Uuid, device: Uuid) -> Result<Vec<Pending>, Error> {
        if !self.root.exists() {
            return Ok(Vec::new());
        }
        let mut list = Vec::new();
        for item in fs::read_dir(&self.root)? {
            let path = item?.path();
            if path.extension().and_then(|v| v.to_str()) == Some("json") {
                if let Some(id) = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .and_then(|s| Uuid::parse_str(s).ok())
                {
                    if let Ok(p) = self.read(id, account, device) {
                        list.push(p);
                    }
                }
            }
        }
        Ok(list)
    }
    pub fn resume(
        &self,
        remote: &dyn Remote,
        request: Uuid,
        account: Uuid,
        device: Uuid,
    ) -> Result<Value, Error> {
        self.resume_controlled(remote, request, account, device, &|| true)
    }
    pub fn resume_controlled(
        &self,
        remote: &dyn Remote,
        request: Uuid,
        account: Uuid,
        device: Uuid,
        active: &dyn Fn() -> bool,
    ) -> Result<Value, Error> {
        let check = || {
            if active() && !self.cancelled(request) {
                Ok(())
            } else {
                Err(Error::Cancelled)
            }
        };
        check()?;
        let mut p = self.read(request, account, device)?;
        if p.prepared.size > super::MAX_PAYLOAD {
            return Err(Error::Limit);
        }
        let path = self.root.join(format!("{}.pack", p.prepared.id));
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)?;
        if file.metadata()?.len() != p.prepared.size {
            return Err(Error::Integrity);
        }
        let previous = if let Some(id) = p.upload_id {
            check()?;
            let status = remote.status(id)?;
            if matches!(
                status["status"].as_str(),
                Some("committed" | "conflict" | "verifying")
            ) {
                self.remember_completed(&p, &status)?;
                return Ok(status);
            }
            Some(status)
        } else {
            None
        };
        // Verify immutable local spool before dispatch; bounded streaming hash.
        let mut digest = Sha256::new();
        let mut buffer = vec![0; CHUNK];
        loop {
            check()?;
            let n = file.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            digest.update(&buffer[..n]);
        }
        if format!("{:x}", digest.finalize()) != p.prepared.sha256 {
            return Err(Error::Integrity);
        }
        file.seek(SeekFrom::Start(0))?;
        if p.upload_id.is_none() {
            check()?;
            let response=remote.begin(json!({"requestId":p.remote_request_id.unwrap_or(p.request_id),"objectId":p.object_id,"baseRevisionId":p.base_revision_id,"kind":p.kind,"label":p.label,"size":p.prepared.size,"sha256":p.prepared.sha256,"manifestSha256":if p.kind=="project"{Some(&p.prepared.manifest_sha256)}else{None},"consent":true}))?;
            p.upload_id = Some(serde_json::from_value(response["uploadId"].clone())?);
            if check().is_err() {
                let _ = remote.cancel(p.upload_id.ok_or(Error::Integrity)?);
                return Err(Error::Cancelled);
            }
            self.save(&p)?;
        }
        let upload = p.upload_id.ok_or(Error::Integrity)?;
        check()?;
        let status = if let Some(status) = previous {
            status
        } else {
            remote.status(upload)?
        };
        let state = status["status"].as_str().ok_or(Error::Integrity)?;
        if matches!(state, "committed" | "conflict" | "verifying") {
            self.remember_completed(&p, &status)?;
            return Ok(status);
        }
        if state != "active" {
            return Err(Error::Unavailable);
        }
        let ready = status["ready"].as_array().ok_or(Error::Integrity)?;
        let mut batch = Vec::with_capacity(PARALLEL_CHUNKS);
        for index in 0..p.prepared.size.div_ceil(CHUNK as u64) as usize {
            check()?;
            let n =
                usize::try_from((p.prepared.size - index as u64 * CHUNK as u64).min(CHUNK as u64))
                    .map_err(|_| Error::Limit)?;
            file.read_exact(&mut buffer[..n])?;
            let hash = format!("{:x}", Sha256::digest(&buffer[..n]));
            let known = ready
                .iter()
                .find(|r| r["index"].as_u64() == Some(index as u64));
            if let Some(k) = known {
                if k["sha256"] != hash || k["size"].as_u64() != Some(n as u64) {
                    return Err(Error::Integrity);
                }
            } else {
                batch.push((index, buffer[..n].to_vec()));
                if batch.len() == PARALLEL_CHUNKS {
                    check()?;
                    remote.chunk_batch(upload, &batch)?;
                    batch.clear();
                }
            }
        }
        check()?;
        if !batch.is_empty() {
            remote.chunk_batch(upload, &batch)?;
        }
        check()?;
        let result = remote.commit(upload)?;
        self.remember_completed(&p, &result)?;
        Ok(result)
    }
    pub fn cancel(
        &self,
        remote: &dyn Remote,
        id: Uuid,
        account: Uuid,
        device: Uuid,
    ) -> Result<(), Error> {
        let p = self.read(id, account, device)?;
        project::private_dir(&self.root)?;
        let marker = self.root.join(format!("{id}.cancelled"));
        match OpenOptions::new().create_new(true).write(true).open(marker) {
            Ok(f) => f.sync_all()?,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
        if let Some(upload) = p.upload_id {
            remote.cancel(upload)?;
        }
        fs::remove_file(self.record(id))?;
        let _ = fs::remove_file(self.root.join(format!("{id}.completed")));
        fs::remove_file(self.root.join(format!("{}.pack", p.prepared.id)))?;
        Ok(())
    }
    pub fn renew(
        &self,
        remote: &dyn Remote,
        id: Uuid,
        account: Uuid,
        device: Uuid,
    ) -> Result<(), Error> {
        let mut p = self.read(id, account, device)?;
        if let Some(upload) = p.upload_id {
            let status = remote.status(upload)?;
            if matches!(
                status["status"].as_str(),
                Some("committed" | "conflict" | "verifying")
            ) {
                return Err(Error::Changed);
            }
            remote.cancel(upload)?;
        }
        p.remote_request_id = Some(Uuid::new_v4());
        p.upload_id = None;
        self.save(&p)
    }
    pub fn remember_ai(&self, account: Uuid, request: Uuid) -> Result<(), Error> {
        project::private_dir(&self.root)?;
        let target = self.root.join(format!("ai-{account}"));
        let temporary = self.root.join(format!("{}.tmp", Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        let mut f = options.open(&temporary)?;
        f.write_all(request.to_string().as_bytes())?;
        f.sync_all()?;
        fs::rename(temporary, target)?;
        Ok(())
    }
    pub fn last_ai(&self, account: Uuid) -> Result<Uuid, Error> {
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(self.root.join(format!("ai-{account}")))?;
        if file.metadata()?.len() != 36 {
            return Err(Error::Integrity);
        }
        let mut value = String::new();
        file.read_to_string(&mut value)?;
        Uuid::parse_str(&value).map_err(|_| Error::Integrity)
    }
    pub fn download(&self, remote: &dyn Remote, revision: Uuid) -> Result<Prepared, Error> {
        let r = remote.revision(revision)?;
        if r["kind"] != "project" {
            return Err(Error::Integrity);
        }
        let size = r["size_bytes"]
            .as_u64()
            .or_else(|| r["size_bytes"].as_str().and_then(|s| s.parse().ok()))
            .ok_or(Error::Integrity)?;
        if size > super::MAX_PAYLOAD {
            return Err(Error::Limit);
        }
        let p = Prepared {
            id: revision,
            size,
            sha256: r["sha256"].as_str().ok_or(Error::Integrity)?.into(),
            manifest_sha256: r["manifest_sha256"]
                .as_str()
                .ok_or(Error::Integrity)?
                .into(),
            files: 0,
        };
        project::private_dir(&self.root)?;
        let path = self.root.join(format!("{revision}.download"));
        let chunks = r["chunks"].as_array().ok_or(Error::Integrity)?;
        if chunks.len() != size.div_ceil(CHUNK as u64) as usize {
            return Err(Error::Integrity);
        }
        let mut options = OpenOptions::new();
        options.create(true).read(true).write(true);
        #[cfg(unix)]
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        let mut output = options.open(path)?;
        let mut full = Sha256::new();
        for base in (0..chunks.len()).step_by(PARALLEL_CHUNKS) {
            let end = (base + PARALLEL_CHUNKS).min(chunks.len());
            let mut buffers = Vec::with_capacity(end - base);
            let mut missing = Vec::new();
            for index in base..end {
                let length = ((size - index as u64 * CHUNK as u64).min(CHUNK as u64)) as usize;
                let expected = chunks[index]["sha256"].as_str().ok_or(Error::Integrity)?;
                let mut existing = vec![0; length];
                output.seek(SeekFrom::Start(index as u64 * CHUNK as u64))?;
                if output.read_exact(&mut existing).is_ok()
                    && format!("{:x}", Sha256::digest(&existing)) == expected
                {
                    buffers.push(Some(existing));
                } else {
                    buffers.push(None);
                    missing.push(index);
                }
            }
            let results = remote.download_batch(revision, &missing)?;
            if results.len() != missing.len() {
                return Err(Error::Integrity);
            }
            let mut failure = None;
            for (index, result) in missing.into_iter().zip(results) {
                match result {
                    Ok(bytes) => {
                        let length =
                            ((size - index as u64 * CHUNK as u64).min(CHUNK as u64)) as usize;
                        if bytes.len() != length
                            || format!("{:x}", Sha256::digest(&bytes))
                                != chunks[index]["sha256"].as_str().ok_or(Error::Integrity)?
                        {
                            failure.get_or_insert(Error::Integrity);
                            continue;
                        }
                        output.seek(SeekFrom::Start(index as u64 * CHUNK as u64))?;
                        output.write_all(&bytes)?;
                        output.sync_data()?;
                        buffers[index - base] = Some(bytes);
                    }
                    Err(error) => {
                        failure.get_or_insert(error);
                    }
                }
            }
            // Preserve successful verified chunks even if another request failed.
            if let Some(error) = failure {
                return Err(error);
            }
            for bytes in buffers {
                full.update(bytes.ok_or(Error::Integrity)?);
            }
        }
        if format!("{:x}", full.finalize()) != p.sha256 {
            return Err(Error::Integrity);
        }
        output.set_len(size)?;
        output.sync_all()?;
        Ok(p)
    }
    pub fn restore_download(&self, p: &Prepared, destination: &Path) -> Result<(), Error> {
        project::restore(
            &self.root.join(format!("{}.download", p.id)),
            p,
            destination,
        )
    }
}

/// Only an explicit pre-admission rate rejection permits transparent retries.
/// AI/billing/start/commit mutations and monthly exhaustion never redispatch.
fn retryable_rate_limit(status: u16, code: Option<&str>, method: &str, path: &str) -> bool {
    status == 429
        && code == Some("rate_limited")
        && (method == "GET"
            || (method == "PUT" && path.starts_with("/v3/uploads/") && path.contains("/chunks/")))
}
#[cfg(test)]
mod retry_tests {
    use super::*;
    #[test]
    fn only_rate_rejected_reads_and_immutable_chunks_can_retry() {
        assert!(retryable_rate_limit(
            429,
            Some("rate_limited"),
            "PUT",
            "/v3/uploads/id/chunks/0"
        ));
        assert!(retryable_rate_limit(
            429,
            Some("rate_limited"),
            "GET",
            "/v3/revisions/id/chunks/0"
        ));
        for path in ["/v3/jobs", "/v3/checkout", "/v3/uploads/id/commit"] {
            assert!(!retryable_rate_limit(
                429,
                Some("rate_limited"),
                "POST",
                path
            ));
        }
        assert!(!retryable_rate_limit(
            429,
            Some("operation_limit"),
            "GET",
            "/v3/versions"
        ));
        assert!(!retryable_rate_limit(
            503,
            Some("rate_limited"),
            "PUT",
            "/v3/uploads/id/chunks/0"
        ));
    }

    #[test]
    fn long_transfer_uses_renewed_session_and_never_switches_identity() {
        use crate::cloud_connection::supabase::{self, StagingConfig};
        use std::sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Mutex,
        };
        let config = StagingConfig::new(
            "abcdefghijklmnopqrst",
            "sb_publishable_fixture_public_key_only",
        )
        .unwrap();
        let account = Uuid::new_v4();
        let session_id = Uuid::new_v4();
        let mut original = supabase::fixture_session(&config, account, session_id);
        original.expire_fixture(); // Original token expired after Http construction.
        let renewed = Arc::new(supabase::fixture_session(&config, account, session_id));
        let current = Mutex::new(renewed.clone());
        let calls = AtomicUsize::new(0);
        let active = AtomicBool::new(true);
        let check = || active.load(Ordering::SeqCst);
        let http = Http {
            origin: "https://api.fixture.invalid",
            device: Uuid::new_v4(),
            agent: ureq::AgentBuilder::new().build(),
            session: &original,
            active: Some(&check),
            renew: None,
        }
        .renewing(|| {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(current.lock().unwrap().clone())
        });
        assert!(Arc::ptr_eq(
            &http.request_session().unwrap().unwrap(),
            &renewed
        ));
        *current.lock().unwrap() = Arc::new(supabase::fixture_session(
            &config,
            Uuid::new_v4(),
            session_id,
        ));
        assert!(matches!(http.request_session(), Err(Error::Identity)));
        *current.lock().unwrap() =
            Arc::new(supabase::fixture_session(&config, account, Uuid::new_v4()));
        assert!(matches!(http.request_session(), Err(Error::Identity)));
        active.store(false, Ordering::SeqCst);
        let before = calls.load(Ordering::SeqCst);
        assert!(matches!(http.request_session(), Err(Error::Cancelled)));
        assert_eq!(calls.load(Ordering::SeqCst), before);
    }
}
