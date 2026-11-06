//! Named service operations; no renderer-controlled origins, headers, or generic HTTP proxy.
use super::{outbox::Pending, selection, Connection, Error, Plan, Session};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Task {
    MemoryUpdate,
    CheckPlan,
    FailureExplanation,
    TestSuggestions,
    ChangeReview,
    CheckComparison,
}
#[derive(Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Command {
    LastPayment,
    Devices,
    RevokeDevice {
        device_id: Uuid,
    },
    SchedulePlan {
        plan_id: Plan,
        request_id: Uuid,
    },
    ListObjects {
        cursor: Option<String>,
    },
    ReadObject {
        object_id: Uuid,
        revision_id: Option<Uuid>,
    },
    Versions {
        object_id: Uuid,
    },
    PinObject {
        object_id: Uuid,
        pinned: bool,
    },
    RestoreVersion {
        object_id: Uuid,
        revision_id: Uuid,
        expected_head_revision_id: Option<Uuid>,
    },
    DeleteObject {
        object_id: Uuid,
    },
    ListShares,
    CreateShare {
        object_id: Uuid,
        revision_id: Uuid,
        expires_in_days: u32,
    },
    RevokeShare {
        share_id: Uuid,
    },
    GetMemory {
        project_id: Uuid,
    },
    ExtractMemory {
        project_id: Uuid,
        request_id: Uuid,
        source_object_ids: Vec<Uuid>,
        automatic: bool,
        rescan_object_ids: Option<Vec<Uuid>>,
    },
    SaveMemory {
        project_id: Uuid,
        expected_revision: u64,
        content: String,
        sources: Vec<Source>,
        automatic_enabled: Option<bool>,
        source_object_ids: Option<Vec<Uuid>>,
    },
    ListMemoryProposals {
        project_id: Uuid,
    },
    MemoryProposal {
        project_id: Uuid,
        extraction_id: Uuid,
    },
    ReviewMemoryProposal {
        project_id: Uuid,
        extraction_id: Uuid,
        action: ReviewAction,
        expected_revision: u64,
    },
    SubmitJob {
        task: Task,
        context: String,
        source_ids: Vec<Uuid>,
        idempotency_key: Uuid,
    },
    Job {
        id: Uuid,
    },
    RecoverJob {
        idempotency_key: Uuid,
    },
    RecoverLastJob,
    ExportAccount,
    DeleteAccount {
        confirmation: String,
    },
    RetryUploads,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub object_id: Uuid,
    pub revision_id: Uuid,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewAction {
    Accept,
    Reject,
}
pub(super) struct Preview {
    account: Uuid,
    source_key: String,
    kind: String,
    filename: Option<String>,
    payload: Vec<u8>,
    expires: std::time::Instant,
}
fn query(path: &str, key: &str, value: Option<String>) -> String {
    value.map_or_else(
        || path.into(),
        |v| {
            format!(
                "{path}?{}",
                url::form_urlencoded::Serializer::new(String::new())
                    .append_pair(key, &v)
                    .finish()
            )
        },
    )
}
fn uuid(value: &Value, key: &str) -> Result<Uuid, Error> {
    value[key]
        .as_str()
        .and_then(|v| Uuid::parse_str(v).ok())
        .filter(|id| !id.is_nil())
        .ok_or(Error::Protocol)
}
impl Connection {
    pub fn preview_report(&self, local_id: Uuid, report_id: Uuid) -> Result<Value, Error> {
        let paths = crate::paths::GyroPaths::for_current_user().map_err(|_| Error::Storage)?;
        let base = paths.base_dir.join("check-reports");
        let store = crate::sessions::SessionStore::open(paths).map_err(|_| Error::Storage)?;
        let session = store
            .get_session(local_id)
            .map_err(|_| Error::Storage)?
            .ok_or(Error::Input)?;
        let mut report = selection::load_report(&base, local_id, report_id)?;
        crate::local_check::refresh_evidence_scope(&mut report);
        if session.workspace_path.canonicalize().ok().as_ref()
            != Some(&report.plan.snapshot.workspace)
            || session.workspace_identity.revision != report.plan.workspace_revision
        {
            report.stale = true;
            report.freshness_note = "Chat workspace changed or is unavailable.".into();
        } else {
            crate::local_check::refresh_freshness(&mut report);
        }
        let portable = selection::Report::from_check(&report)?;
        self.remember_preview(
            format!("report:{report_id}"),
            "report",
            portable.bytes(),
            json!(portable.text()),
        )
    }
    /// Streams a complete account export into a new user-selected local folder.
    /// Recovery routes use the server's separate bounded export window.
    pub fn export_to(&self, parent: &std::path::Path) -> Result<Value, Error> {
        self.authenticated(|session|{
        let manifest=self.json("GET","/v2/account/export",Some(session),None)?;
        let folder=parent.join(format!("gyro-cloud-export-{}",Uuid::new_v4()));crate::paths::ensure_private_directory(&folder).map_err(|_|Error::Storage)?;
        let write=|path:&std::path::Path,bytes:&[u8]|->Result<(),Error>{use std::io::Write;let mut options=std::fs::OpenOptions::new();options.create_new(true).write(true);#[cfg(unix)]{use std::os::unix::fs::OpenOptionsExt;options.mode(0o600);}let mut f=options.open(path).map_err(|_|Error::Storage)?;f.write_all(bytes).map_err(|_|Error::Storage)?;f.sync_all().map_err(|_|Error::Storage)};
        write(&folder.join("manifest.json"),&serde_json::to_vec_pretty(&manifest).map_err(|_|Error::Protocol)?)?;
        let objects=folder.join("objects");crate::paths::ensure_private_directory(&objects).map_err(|_|Error::Storage)?;
        let mut count=0;
        for revision in manifest["revisions"].as_array().ok_or(Error::Protocol)?{
            use std::io::Write;
            let object=revision["object_id"].as_str().and_then(|v|Uuid::parse_str(v).ok()).ok_or(Error::Protocol)?;let id=uuid(revision,"id")?;let size=revision["size_bytes"].as_u64().ok_or(Error::Protocol)? as usize;if size>50*1024*1024{return Err(Error::Limited);}
            let path=objects.join(format!("{id}.blob"));let mut options=std::fs::OpenOptions::new();options.create_new(true).write(true);#[cfg(unix)]{use std::os::unix::fs::OpenOptionsExt;options.mode(0o600);}let mut f=options.open(&path).map_err(|_|Error::Storage)?;let mut digest=Sha256::new();let mut written=0;
            for index in 0..size.div_ceil(4*1024*1024).max(1){let route=if size<=4*1024*1024{format!("/v2/account/export/objects/{object}")}else{format!("/v2/account/export/objects/{object}/chunks/{index}")};let value=self.json("GET",&query(&route,"revisionId",Some(id.to_string())),Some(session),None)?;
                let bytes=base64::engine::general_purpose::STANDARD.decode(value["bytesBase64"].as_str().ok_or(Error::Protocol)?).map_err(|_|Error::Protocol)?;
                if bytes.len()>4*1024*1024||value["sha256"].as_str()!=Some(format!("{:x}",Sha256::digest(&bytes)).as_str()){return Err(Error::Protocol);}f.write_all(&bytes).map_err(|_|Error::Storage)?;digest.update(&bytes);written+=bytes.len();
            }
            if written!=size||revision["checksum"].as_str()!=Some(format!("{:x}",digest.finalize()).as_str()){return Err(Error::Protocol);}f.sync_all().map_err(|_|Error::Storage)?;count+=1;
        }
        let memory=folder.join("memory");crate::paths::ensure_private_directory(&memory).map_err(|_|Error::Storage)?;
        for (field,key) in [("memoryRevisions","revision_id"),("memoryProposals","extraction_id")]{for entry in manifest[field].as_array().ok_or(Error::Protocol)?{let id=uuid(entry,key)?;let value=self.json("GET",&format!("/v2/account/export/memory/{id}"),Some(session),None)?;let bytes=if let Some(content)=value["content"].as_str(){content.as_bytes().to_vec()}else{base64::engine::general_purpose::STANDARD.decode(value["bytesBase64"].as_str().ok_or(Error::Protocol)?).map_err(|_|Error::Protocol)?};if bytes.len()>1024*1024||entry["checksum"].as_str()!=Some(format!("{:x}",Sha256::digest(&bytes)).as_str()){return Err(Error::Protocol);}write(&memory.join(format!("{id}.txt")),&bytes)?;count+=1;}}
        write(&folder.join("COMPLETE.json"),&serde_json::to_vec(&json!({"format":"gyro-cloud-export-complete-v2","files":count,"generatedAt":chrono::Utc::now()})).map_err(|_|Error::Protocol)?)?;
        Ok(json!({"saved":true,"files":count,"folderName":folder.file_name().and_then(|v|v.to_str()),"notice":"Complete Cloud export saved into a new folder. It contains the manifest, retained object versions and memory. Existing local data was preserved."}))
    })
    }
    pub fn preview_attachment(&self, name: &str, bytes: Vec<u8>) -> Result<Value, Error> {
        selection::validate_attachment(name, &bytes)?;
        let metadata = json!({"name":name,"sizeBytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(&bytes))});
        self.remember_preview(
            format!("attachment:{}", Uuid::new_v4()),
            "attachment",
            bytes,
            metadata,
        )
    }
    pub fn preview_chat(&self, local_id: Uuid) -> Result<Value, Error> {
        let paths = crate::paths::GyroPaths::for_current_user().map_err(|_| Error::Storage)?;
        let store = crate::sessions::SessionStore::open(paths).map_err(|_| Error::Storage)?;
        let account = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .view
            .snapshot
            .as_ref()
            .map(|s| s.account.id)
            .ok_or(Error::Authentication)?;
        let namespace = self
            .local_state()?
            .object_for_local(&format!("{account}:chat:{local_id}"))?;
        let mut chat = selection::Chat::from_session(&store, local_id, namespace)?;
        let session = store
            .get_session(local_id)
            .map_err(|_| Error::Storage)?
            .ok_or(Error::Input)?;
        chat.project_id = Some(self.local_state()?.object_for_local(&format!(
            "memory:{account}:{}",
            session.workspace_path.display()
        ))?);
        let payload = chat.bytes()?;
        self.remember_preview(
            format!("chat:{local_id}"),
            "chat",
            payload,
            serde_json::to_value(chat).map_err(|_| Error::Input)?,
        )
    }
    pub fn preview_settings(&self, preferences: Value) -> Result<Value, Error> {
        let projected = selection::Settings::from_preferences(&preferences)?;
        let content = serde_json::to_value(projected).map_err(|_| Error::Input)?;
        let payload = serde_json::to_vec(&content).map_err(|_| Error::Input)?;
        self.remember_preview("settings:appearance".into(), "settings", payload, content)
    }
    fn remember_preview(
        &self,
        key: String,
        kind: &str,
        payload: Vec<u8>,
        content: Value,
    ) -> Result<Value, Error> {
        let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let account = state
            .view
            .snapshot
            .as_ref()
            .map(|s| s.account.id)
            .ok_or(Error::Authentication)?;
        state
            .previews
            .retain(|_, p| p.expires.elapsed() < std::time::Duration::from_secs(600));
        if state.previews.len() >= 5 {
            return Err(Error::Limited);
        }
        let ticket = Uuid::new_v4();
        let size = payload.len();
        state.previews.insert(
            ticket,
            Preview {
                account,
                source_key: key,
                kind: kind.into(),
                filename: if kind == "attachment" {
                    content["name"].as_str().map(str::to_owned)
                } else {
                    None
                },
                payload,
                expires: std::time::Instant::now(),
            },
        );
        Ok(
            json!({"ticket":ticket,"kind":kind,"sizeBytes":size,"content":content,"notice":"Only this reviewed content will upload. Tool actions, credentials, local paths, approval policies and provider resume IDs are excluded. Attachments require separate explicit selection."}),
        )
    }
    pub fn upload_preview(&self, ticket: Uuid, reviewed: bool) -> Result<Value, Error> {
        if !reviewed {
            return Err(Error::Input);
        }
        let preview = {
            let mut s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let account = s
                .view
                .snapshot
                .as_ref()
                .map(|v| v.account.id)
                .ok_or(Error::Authentication)?;
            let p = s.previews.remove(&ticket).ok_or(Error::Input)?;
            if p.account != account || p.expires.elapsed() > std::time::Duration::from_secs(600) {
                return Err(Error::Stale);
            }
            p
        };
        self.queue_selection(
            &preview.source_key,
            &preview.kind,
            preview.filename,
            preview.payload,
            true,
        )
    }
    pub fn service(&self, command: Command) -> Result<Value, Error> {
        if !self.environment.permits_managed_ai()
            && matches!(
                &command,
                Command::SubmitJob { .. } | Command::ExtractMemory { .. }
            )
        {
            return Err(Error::Denied);
        }
        self.authenticated(|session|{
            let get=|path:&str|self.json("GET",path,Some(session),None);
            let send=|method:&str,path:&str,body:Value|self.json(method,path,Some(session),Some(body));
            match command {
                Command::LastPayment=>Ok(get("/v2/billing/last-payment").unwrap_or_else(|_| json!({"unavailable":true}))),
                Command::Devices=>get("/v2/devices"),
                Command::RevokeDevice{device_id}=>send("POST","/v2/sessions/revoke",json!({"deviceId":device_id})),
                Command::SchedulePlan{plan_id,request_id}=>send("POST","/v2/billing/plan-change",json!({"planId":plan_id,"requestId":request_id})),
                Command::ListObjects{cursor}=>{let local=self.local_state()?;let mut cursor=cursor.unwrap_or(local.cursor(session.account_id())?);if cursor.len()>24||!cursor.bytes().all(|b|b.is_ascii_digit()){return Err(Error::Input);}let mut more=false;for _ in 0..32 {let page=get(&query("/v2/sync/changes","cursor",Some(cursor)))?;local.apply_changes(session.account_id(),&page)?;more=page["hasMore"].as_bool().ok_or(Error::Protocol)?;cursor=page["changeCursor"].as_str().ok_or(Error::Protocol)?.into();if !more{break;}}Ok(json!({"items":local.cached_objects(session.account_id())?,"hasMore":more,"changeCursor":cursor}))},
                Command::ReadObject{object_id,revision_id}=>self.read_object(session,object_id,revision_id),
                Command::Versions{object_id}=>get(&format!("/v2/sync/objects/{object_id}/versions")),
                Command::PinObject{object_id,pinned}=>send("POST",&format!("/v2/sync/objects/{object_id}/pin"),json!({"pinned":pinned})),
                Command::RestoreVersion{object_id,revision_id,expected_head_revision_id}=>send("POST",&format!("/v2/sync/objects/{object_id}/restore"),json!({"revisionId":revision_id,"expectedHeadRevisionId":expected_head_revision_id})),
                Command::DeleteObject{object_id}=>send("DELETE",&format!("/v2/sync/objects/{object_id}"),json!({})),
                Command::ListShares=>get("/v2/shares"),
                Command::CreateShare{object_id,revision_id,expires_in_days}=>{if !(1..=30).contains(&expires_in_days){return Err(Error::Input);}let origin=self.share_origin.as_ref().ok_or(Error::Unconfigured)?;let mut value=send("POST","/v2/shares",json!({"objectId":object_id,"revisionId":revision_id,"expiresInDays":expires_in_days,"acknowledged":true}))?;let raw=value["url"].as_str().ok_or(Error::Protocol)?;let url=url::Url::parse(raw).map_err(|_|Error::Protocol)?;if raw.len()>8192||url.origin().ascii_serialization()!=*origin||!url.username().is_empty()||url.password().is_some()||url.fragment().is_some(){return Err(Error::Protocol);}if let Some(v)=value.as_object_mut(){v.remove("token");}Ok(value)},
                Command::RevokeShare{share_id}=>send("DELETE",&format!("/v2/shares/{share_id}"),json!({})),
                Command::GetMemory{project_id}=>get(&format!("/v2/memory/{project_id}")),
                Command::ExtractMemory{project_id,request_id,source_object_ids,automatic,rescan_object_ids}=>{if source_object_ids.len()>200||rescan_object_ids.as_ref().is_some_and(|v|v.len()>200||automatic){return Err(Error::Input);}if automatic&&!self.local_state()?.claim_daily_memory(session.account_id(),project_id)?{return Ok(json!({"skipped":true,"reason":"daily-local-limit","morePending":false}));}let mut body=json!({"requestId":request_id,"sourceObjectIds":source_object_ids,"automatic":automatic});if let Some(ids)=rescan_object_ids{body["rescanObjectIds"]=json!(ids);}send("POST",&format!("/v2/memory/{project_id}/extract"),body)},
                Command::SaveMemory{project_id,expected_revision,content,sources,automatic_enabled,source_object_ids}=>{if content.len()>128_000||sources.len()>200||source_object_ids.as_ref().is_some_and(|v|v.len()>200){return Err(Error::Input);}let mut body=json!({"expectedRevision":expected_revision,"content":content,"sources":sources});if let Some(enabled)=automatic_enabled{body["automaticEnabled"]=json!(enabled);}if let Some(ids)=source_object_ids{body["sourceObjectIds"]=json!(ids);}send("PUT",&format!("/v2/memory/{project_id}"),body)},
                Command::ListMemoryProposals{project_id}=>get(&format!("/v2/memory/{project_id}/proposals")),
                Command::MemoryProposal{project_id,extraction_id}=>get(&format!("/v2/memory/{project_id}/proposals/{extraction_id}")),
                Command::ReviewMemoryProposal{project_id,extraction_id,action,expected_revision}=>send("POST",&format!("/v2/memory/{project_id}/proposals/{extraction_id}"),match action {ReviewAction::Accept=>json!({"action":"accept","expectedRevision":expected_revision}),ReviewAction::Reject=>json!({"action":"reject"})}),
                Command::SubmitJob{task,context,source_ids,idempotency_key}=>{if context.is_empty()||context.len()>128_000||source_ids.len()>200||selection::safe_text(&context)?!=context{return Err(Error::Input);}self.local_state()?.remember_job(session.account_id(),idempotency_key)?;send("POST","/v2/ai/jobs",json!({"task":task,"context":context,"sourceIds":source_ids,"idempotencyKey":idempotency_key,"automatic":false}))},
                Command::Job{id}=>get(&format!("/v2/ai/jobs/{id}")),
                Command::RecoverJob{idempotency_key}=>{let key=idempotency_key.to_string();let response=self.transport.request("GET","/v2/ai/jobs/by-key",Some(session.access_token()),self.device()?,None,"application/json",Some(&key))?;match response.status{200..=299=>serde_json::from_slice(&response.body).map_err(|_|Error::Protocol),404=>Err(Error::NotFound),401=>Err(Error::Authentication),_=>Err(Error::Unavailable)}},
                Command::RecoverLastJob=>{let key=self.local_state()?.last_job(session.account_id())?.ok_or(Error::NotFound)?.to_string();let response=self.transport.request("GET","/v2/ai/jobs/by-key",Some(session.access_token()),self.device()?,None,"application/json",Some(&key))?;match response.status{200..=299=>serde_json::from_slice(&response.body).map_err(|_|Error::Protocol),404=>Err(Error::NotFound),401=>Err(Error::Authentication),_=>Err(Error::Unavailable)}},
                Command::ExportAccount=>get("/v2/account/export"),
                Command::DeleteAccount{confirmation}=>{if confirmation!="DELETE CLOUD DATA"{return Err(Error::Input);}send("POST","/v2/account/deletion",json!({"confirmation":"delete-cloud-data"}))},
                Command::RetryUploads=>self.flush_for(session),
            }
        })
    }
    /// Called only after the native preview is explicitly approved.
    pub fn queue_selection(
        &self,
        source_key: &str,
        kind: &str,
        filename: Option<String>,
        payload: Vec<u8>,
        reviewed: bool,
    ) -> Result<Value, Error> {
        if !reviewed
            || !matches!(kind, "chat" | "settings" | "report" | "attachment")
            || payload.len() > 50 * 1024 * 1024
        {
            return Err(Error::Input);
        }
        let account = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .view
            .snapshot
            .as_ref()
            .map(|s| s.account.id)
            .ok_or(Error::Authentication)?;
        let local = self.local_state()?;
        let object = local.object_for_local(&format!("{account}:{source_key}"))?;
        let record = Pending {
            request_id: Uuid::new_v4(),
            object_id: object,
            account_id: account,
            kind: kind.into(),
            filename,
            base_revision_id: local.head(account, object)?,
            upload_id: None,
            next_chunk: 0,
            payload,
        };
        local.put(&record)?;
        // Send only this reviewed selection. An unrelated queued failure must
        // not hide this report's commit acknowledgment or trigger other uploads.
        match self.authenticated(|session| self.flush_records(session, vec![record.clone()])) {
            Ok(mut v) => {
                // Bind this acknowledgment to this exact request before a caller
                // can create a report link.
                if let Some(ack) = selection_ack(&v, record.request_id, record.object_id)? {
                    v["uploaded"] = ack;
                }
                v["requestId"] = json!(record.request_id);
                Ok(v)
            }
            Err(Error::Unavailable) => Ok(
                json!({"queued":true,"requestId":record.request_id,"message":"Saved locally for explicit retry when Cloud is available."}),
            ),
            Err(e) => Err(e),
        }
    }
    fn flush_for(&self, session: &Session) -> Result<Value, Error> {
        let local = self.local_state()?;
        self.flush_records(session, local.list(session.account_id())?)
    }
    fn flush_records(&self, session: &Session, records: Vec<Pending>) -> Result<Value, Error> {
        if records.iter().any(|p| p.account_id != session.account_id()) {
            return Err(Error::Authentication);
        }
        let local = self.local_state()?;
        let mut results = Vec::new();
        for mut item in records {
            let result = (|| -> Result<Value, Error> {
                let chunks = item.payload.len().div_ceil(4 * 1024 * 1024).max(1);
                if item.upload_id.is_none() {
                    let digest = format!("{:x}", Sha256::digest(&item.payload));
                    // Reuse only the current server head. A retained revision can
                    // match the bytes after a remote edit or deletion.
                    if item.kind == "chat" {
                        if let Some(base) = item.base_revision_id {
                            let versions = self.json(
                                "GET",
                                &format!("/v2/sync/objects/{}/versions", item.object_id),
                                Some(session),
                                None,
                            );
                            if versions.as_ref().is_ok_and(|versions| {
                                matching_chat_head(versions, base, item.payload.len(), &digest)
                            }) {
                                local.remove(session.account_id(), item.request_id)?;
                                return Ok(json!({
                                    "objectId": item.object_id,
                                    "revisionId": base,
                                    "requestId": item.request_id,
                                    "conflict": false,
                                    "unchanged": true,
                                }));
                            }
                        }
                    }
                    let mut body = json!({"requestId":item.request_id,"objectId":item.object_id,"baseRevisionId":item.base_revision_id,"kind":item.kind,"sizeBytes":item.payload.len(),"sha256":digest,"totalChunks":chunks});
                    if let Some(filename) = &item.filename {
                        body["filename"] = json!(filename);
                    }
                    let upload =
                        self.json("POST", "/v2/sync/uploads", Some(session), Some(body))?;
                    item.upload_id = Some(uuid(&upload, "uploadId")?);
                    local.put(&item)?;
                }
                let upload = item.upload_id.ok_or(Error::Protocol)?;
                for index in item.next_chunk as usize..chunks {
                    let start = index * 4 * 1024 * 1024;
                    let end = (start + 4 * 1024 * 1024).min(item.payload.len());
                    let response = self.transport.request(
                        "PUT",
                        &format!("/v2/sync/uploads/{upload}/chunks/{index}"),
                        Some(session.access_token()),
                        self.device()?,
                        Some(&item.payload[start..end]),
                        "application/octet-stream",
                        None,
                    )?;
                    if !(200..300).contains(&response.status) {
                        return Err(if response.status == 429 || response.status == 413 {
                            Error::Limited
                        } else {
                            Error::Unavailable
                        });
                    }
                    item.next_chunk = (index + 1) as u32;
                    local.put(&item)?;
                }
                let committed = self.json(
                    "POST",
                    &format!("/v2/sync/uploads/{upload}/commit"),
                    Some(session),
                    Some(json!({})),
                )?;
                if uuid(&committed, "objectId")? != item.object_id {
                    return Err(Error::Protocol);
                }
                uuid(&committed, "revisionId")?;
                if committed["conflict"] == false {
                    local.record_head(
                        session.account_id(),
                        item.object_id,
                        uuid(&committed, "revisionId")?,
                    )?;
                }
                local.remove(session.account_id(), item.request_id)?;
                let mut committed = committed;
                committed["requestId"] = json!(item.request_id);
                Ok(committed)
            })();
            match result {
                Ok(committed) => results.push(committed),
                Err(error) if !results.is_empty() => {
                    return Ok(
                        json!({"queued":true,"completed":results,"message":error.to_string()}),
                    )
                }
                Err(error) => return Err(error),
            }
        }
        Ok(json!({"queued":false,"completed":results}))
    }
    fn read_object(
        &self,
        session: &Session,
        object: Uuid,
        revision: Option<Uuid>,
    ) -> Result<Value, Error> {
        let versions = self.json(
            "GET",
            &format!("/v2/sync/objects/{object}/versions"),
            Some(session),
            None,
        )?;
        let items = versions["items"].as_array().ok_or(Error::Protocol)?;
        let metadata = items
            .iter()
            .find(|v| revision.is_none_or(|id| uuid(v, "revisionId").ok() == Some(id)))
            .ok_or(Error::Input)?;
        let revision = uuid(metadata, "revisionId")?;
        let size = metadata["sizeBytes"].as_u64().ok_or(Error::Protocol)? as usize;
        if size > 50 * 1024 * 1024 {
            return Err(Error::Limited);
        }
        if size <= 4 * 1024 * 1024 {
            let value = self.json(
                "GET",
                &query(
                    &format!("/v2/sync/objects/{object}"),
                    "revisionId",
                    Some(revision.to_string()),
                ),
                Some(session),
                None,
            )?;
            validate_download(&value, object, Some(revision))?;
            return Ok(value);
        }
        let mut bytes = Vec::with_capacity(size);
        for index in 0..size.div_ceil(4 * 1024 * 1024) {
            let value = self.json(
                "GET",
                &query(
                    &format!("/v2/sync/objects/{object}/chunks/{index}"),
                    "revisionId",
                    Some(revision.to_string()),
                ),
                Some(session),
                None,
            )?;
            let chunk = base64::engine::general_purpose::STANDARD
                .decode(value["bytesBase64"].as_str().ok_or(Error::Protocol)?)
                .map_err(|_| Error::Protocol)?;
            if value["index"].as_u64() != Some(index as u64)
                || value["sizeBytes"].as_u64() != Some(chunk.len() as u64)
                || chunk.len() > 4 * 1024 * 1024
                || value["sha256"].as_str()
                    != Some(format!("{:x}", Sha256::digest(&chunk)).as_str())
            {
                return Err(Error::Protocol);
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.len() != size
            || metadata["sha256"].as_str() != Some(format!("{:x}", Sha256::digest(&bytes)).as_str())
        {
            return Err(Error::Protocol);
        }
        Ok(
            json!({"objectId":object,"revisionId":revision,"sizeBytes":size,"sha256":metadata["sha256"],"bytesBase64":base64::engine::general_purpose::STANDARD.encode(&bytes)}),
        )
    }
}
fn matching_chat_head(versions: &Value, base: Uuid, size: usize, digest: &str) -> bool {
    let Some(items) = versions["items"].as_array() else {
        return false;
    };
    let mut current = items
        .iter()
        .filter(|item| item.get("retainedUntil").is_some_and(Value::is_null));
    current.next().is_some_and(|head| {
        uuid(head, "revisionId").ok() == Some(base)
            && head["sizeBytes"].as_u64() == Some(size as u64)
            && head["sha256"].as_str() == Some(digest)
    }) && current.next().is_none()
}

fn selection_ack(value: &Value, request: Uuid, object: Uuid) -> Result<Option<Value>, Error> {
    let Some(items) = value["completed"].as_array() else {
        return Ok(None);
    };
    let Some(item) = items
        .iter()
        .find(|v| uuid(v, "requestId").ok() == Some(request))
    else {
        return Ok(None);
    };
    if uuid(item, "objectId")? != object {
        return Err(Error::Protocol);
    }
    uuid(item, "revisionId")?;
    Ok(Some(item.clone()))
}
fn validate_download(value: &Value, object: Uuid, revision: Option<Uuid>) -> Result<(), Error> {
    if uuid(value, "objectId")? != object
        || revision.is_some_and(|id| uuid(value, "revisionId").ok() != Some(id))
    {
        return Err(Error::Protocol);
    }
    let encoded = value["bytesBase64"].as_str().ok_or(Error::Protocol)?;
    if encoded.len() > 50 * 1024 * 1024 * 4 / 3 + 8 {
        return Err(Error::Limited);
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| Error::Protocol)?;
    if bytes.len() > 50 * 1024 * 1024
        || value["sizeBytes"].as_u64() != Some(bytes.len() as u64)
        || value["sha256"].as_str() != Some(format!("{:x}", Sha256::digest(&bytes)).as_str())
    {
        return Err(Error::Protocol);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    struct Script {
        calls: Mutex<Vec<(String, String, Option<String>)>>,
        account_status: u16,
    }
    impl super::super::Transport for Script {
        fn request(
            &self,
            method: &str,
            path: &str,
            _: Option<&str>,
            _: Uuid,
            _: Option<&[u8]>,
            _: &'static str,
            key: Option<&str>,
        ) -> Result<super::super::Response, Error> {
            self.calls
                .lock()
                .unwrap()
                .push((method.into(), path.into(), key.map(str::to_owned)));
            let (status, value) = if path == "/v2/account/deletion" {
                (200, json!({"deletionRequested":true}))
            } else if path == "/v2/ai/jobs/by-key" {
                (404, json!({"error":{"code":"not_found"}}))
            } else {
                (
                    self.account_status,
                    json!({"error":{"code":"account_unavailable"}}),
                )
            };
            Ok(super::super::Response {
                status,
                body: serde_json::to_vec(&value).unwrap(),
            })
        }
    }
    fn connection(script: Arc<Script>) -> Connection {
        let config = super::super::Config::production(
            "https://cloud.example",
            "abcdefghijklmnopqrst",
            "sb_publishable_fixture_only_not_a_secret",
        )
        .unwrap();
        let session = Arc::new(crate::cloud_connection::supabase::fixture_session(
            &config.auth,
            Uuid::new_v4(),
            Uuid::new_v4(),
        ));
        let store = Arc::new(
            crate::cloud_connection::supabase::store::fixture::MemoryStore {
                project_ref: "abcdefghijklmnopqrst".into(),
                ..Default::default()
            },
        );
        let c = Connection::new(config, store, script, Uuid::new_v4());
        {
            let mut state = c.inner.lock().unwrap();
            state.session = Some(session);
            state.view.state = "connected".into();
        }
        c
    }
    #[test]
    fn unchanged_chat_requires_a_matching_current_server_head() {
        let base = Uuid::new_v4();
        let current = json!({
            "revisionId": base,
            "sizeBytes": 14,
            "sha256": "digest",
            "retainedUntil": null,
        });
        let mut versions = json!({"items": [current.clone()]});
        assert!(matching_chat_head(&versions, base, 14, "digest"));
        assert!(!matching_chat_head(&versions, base, 14, "different"));
        assert!(!matching_chat_head(&versions, base, 13, "digest"));
        assert!(!matching_chat_head(&versions, Uuid::new_v4(), 14, "digest"));
        versions["items"][0]["retainedUntil"] = json!("2026-12-01T00:00:00Z");
        assert!(!matching_chat_head(&versions, base, 14, "digest"));
        versions["items"].as_array_mut().unwrap().push(json!({
            "revisionId": Uuid::new_v4(),
            "sizeBytes": 14,
            "sha256": "digest",
            "retainedUntil": null,
        }));
        assert!(!matching_chat_head(&versions, base, 14, "digest"));
    }

    #[test]
    fn report_link_ack_is_bound_to_the_exact_reviewed_upload() {
        let request = Uuid::new_v4();
        let object = Uuid::new_v4();
        let revision = Uuid::new_v4();
        let value = json!({"completed":[{"requestId":Uuid::new_v4(),"objectId":Uuid::new_v4(),"revisionId":Uuid::new_v4()}, {"requestId":request,"objectId":object,"revisionId":revision}]});
        assert_eq!(
            selection_ack(&value, request, object).unwrap().unwrap()["revisionId"],
            revision.to_string()
        );
        assert!(selection_ack(&value, Uuid::new_v4(), object)
            .unwrap()
            .is_none());
        assert!(selection_ack(&value, request, Uuid::new_v4()).is_err());
        assert!(selection_ack(&json!({"queued":true}), request, object)
            .unwrap()
            .is_none());
    }
    #[test]
    fn successful_deletion_ack_survives_following_account_denial() {
        let script = Arc::new(Script {
            calls: Mutex::new(Vec::new()),
            account_status: 403,
        });
        let c = connection(script.clone());
        let result = c
            .service(Command::DeleteAccount {
                confirmation: "DELETE CLOUD DATA".into(),
            })
            .unwrap();
        assert_eq!(result["deletionRequested"], true);
        assert_eq!(c.view().state, "expired");
        assert!(c.view().snapshot.is_none());
        assert_eq!(script.calls.lock().unwrap()[0].1, "/v2/account/deletion");
    }
    #[test]
    fn job_recovery_only_reads_original_request_key() {
        let script = Arc::new(Script {
            calls: Mutex::new(Vec::new()),
            account_status: 200,
        });
        let c = connection(script.clone());
        let key = Uuid::new_v4();
        assert!(matches!(
            c.service(Command::RecoverJob {
                idempotency_key: key
            }),
            Err(Error::NotFound)
        ));
        let calls = script.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0],
            (
                "GET".into(),
                "/v2/ai/jobs/by-key".into(),
                Some(key.to_string())
            )
        );
    }
    #[test]
    fn download_checksum_or_revision_mismatch_is_rejected() {
        let object = Uuid::new_v4();
        let revision = Uuid::new_v4();
        let bytes = b"reviewed portable content";
        let value = json!({"objectId":object,"revisionId":revision,"sizeBytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes)),"bytesBase64":base64::engine::general_purpose::STANDARD.encode(bytes)});
        assert!(validate_download(&value, object, Some(revision)).is_ok());
        assert!(validate_download(&value, object, Some(Uuid::new_v4())).is_err());
        let mut tampered = value;
        tampered["sha256"] = json!("0".repeat(64));
        assert!(validate_download(&tampered, object, Some(revision)).is_err());
    }
}
