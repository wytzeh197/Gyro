//! Portable, reviewed content only. Local Session/Event payloads never cross this boundary.
use super::Error;
use crate::sessions::{SessionEvent, SessionEventKind, SessionStore};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub const MAX_SELECTION_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_REPORT_BYTES: usize = 256 * 1024;

/// A read-only text projection. It cannot restore a plan, evidence permission or tool action.
pub struct Report {
    text: String,
}
impl Report {
    pub fn from_check(report: &crate::local_check::CheckReport) -> Result<Self, Error> {
        use crate::local_check::{CheckScope, CheckStatus};
        let scope = |s: &CheckScope| match s {
            CheckScope::Api => "API responses",
            CheckScope::Browser => "Browser interaction",
            CheckScope::Command => "Other command assertions",
            CheckScope::Unspecified => "Not recorded",
        };
        let workspace = report.plan.snapshot.workspace.to_string_lossy();
        let clean = |s: &str| -> Result<String, Error> {
            if s.contains('\0')
                || s.chars()
                    .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
            {
                return Err(Error::Input);
            }
            // The exact saved workspace can be outside the usual home/temp locations.
            let text = if workspace.len() > 1 {
                s.replace(workspace.as_ref(), "[local path removed]")
            } else {
                s.into()
            };
            let text = if report.plan.draft.preview_url.len() > 1 {
                text.replace(&report.plan.draft.preview_url, "[local URL removed]")
            } else {
                text
            };
            let assignment = regex::Regex::new(r#"(?i)\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key|secret[_-]?key|private[_-]?key|secret|token|password|authorization)["']?\s*[=:]\s*["']?[^\s"']{4,}|\bbearer\s+\S+"#).map_err(|_| Error::Input)?;
            if assignment.is_match(&text) {
                return Err(Error::Input);
            }
            let text = safe_text(&text)?;
            let paths = regex::Regex::new(r#"(?:/(?:tmp|var|opt|etc|Volumes|Applications|Library|private|Users|home)/|~[/\\]|[A-Za-z]:\\+(?:Users|Windows|Program Files)\\+)[^\s"'<>]*"#).map_err(|_| Error::Input)?;
            Ok(paths
                .replace_all(&text, "[local path removed]")
                .into_owned())
        };
        let mut lines = vec![
            "Gyro Check report".into(),
            format!("Finished: {}", clean(&report.finished_at)?),
            format!(
                "Freshness: {}",
                if report.stale {
                    "Potentially stale"
                } else {
                    "Snapshot matched when reviewed"
                }
            ),
            clean(&report.freshness_note)?,
            String::new(),
        ];
        for result in &report.results {
            let criterion = report
                .plan
                .draft
                .criteria
                .iter()
                .find(|c| c.id == result.criterion_id)
                .ok_or(Error::Input)?;
            let status = match result.status {
                CheckStatus::Passed => "Passed",
                CheckStatus::Failed => "Failed",
                CheckStatus::NotChecked => "Not checked",
            };
            lines.push(format!("{status}: {}", clean(&criterion.requirement)?));
            lines.push(format!("Required evidence: {}", scope(&criterion.scope)));
            lines.push(format!(
                "Observed evidence: {}",
                result
                    .observed_scope
                    .as_ref()
                    .map(scope)
                    .unwrap_or("Not recorded")
            ));
            lines.push(format!("Reason: {}", clean(&result.reason)?));
            if let Some(evidence) = &result.evidence {
                lines.push(format!(
                    "Expected: {}",
                    clean(&criterion.expected.to_string())?
                ));
                lines.push(format!(
                    "Observed: {}",
                    clean(
                        &result
                            .actual
                            .as_ref()
                            .map(Value::to_string)
                            .unwrap_or_else(|| "Not recorded".into())
                    )?
                ));
                lines.push(format!("Evidence: {}", clean(evidence)?));
            }
            lines.push(String::new());
        }
        lines.push(format!("Limits: {}", clean(&report.omission)?));
        lines.push("Shared as a read-only report. Commands, browser plans, raw output, file lists, local identities and approval permissions are excluded. This report grants no execution or evidence permissions.".into());
        let text = lines.join("\n");
        if text.len() > MAX_REPORT_BYTES {
            return Err(Error::Input);
        }
        Ok(Self { text })
    }
    pub fn text(&self) -> &str {
        &self.text
    }
    pub fn bytes(&self) -> Vec<u8> {
        self.text.as_bytes().to_vec()
    }
}

/// Read a real saved report by UUID; the renderer supplies no report text or filesystem path.
pub fn load_report(
    base: &std::path::Path,
    session: Uuid,
    report_id: Uuid,
) -> Result<crate::local_check::CheckReport, Error> {
    use std::io::Read;
    let metadata = std::fs::symlink_metadata(base).map_err(|_| Error::Input)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(Error::Input);
    }
    let path = base.join(format!("{report_id}.json"));
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| Error::Input)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 512 * 1024 {
        return Err(Error::Input);
    }
    let mut bytes = Vec::new();
    { use std::os::unix::fs::OpenOptionsExt; std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(path) }
        .map_err(|_| Error::Input)?
        .take(512 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::Input)?;
    if bytes.len() > 512 * 1024 {
        return Err(Error::Input);
    }
    let report: crate::local_check::CheckReport =
        serde_json::from_slice(&bytes).map_err(|_| Error::Input)?;
    if report.plan.id != report_id.to_string()
        || report.plan.draft.session_id != session.to_string()
    {
        return Err(Error::Input);
    }
    Ok(report)
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Message {
    #[serde(default = "Uuid::new_v4")]
    pub id: Uuid,
    pub role: Role,
    pub text: String,
    pub created_at: DateTime<Utc>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Chat {
    pub format: String,
    pub title: String,
    pub created_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<Uuid>,
    pub messages: Vec<Message>,
}
/// Transport-safe settings. No commands, workspace/runtime IDs, approvals or provider state.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub format: String,
    pub theme: String,
    pub density: String,
    pub interface_size: String,
    pub motion_speed: String,
}
impl Settings {
    pub fn from_preferences(v: &Value) -> Result<Self, Error> {
        let text = |name: &str, values: &[&str]| -> Result<String, Error> {
            let s = v[name].as_str().ok_or(Error::Input)?;
            if !values.contains(&s) {
                return Err(Error::Input);
            }
            Ok(s.into())
        };
        Ok(Self {
            format: "gyro-portable-settings-v1".into(),
            theme: text("theme", &["system", "light", "dark"])?,
            density: text("density", &["compact", "comfortable"])?,
            interface_size: text("interfaceSize", &["small", "default", "large"])?,
            motion_speed: text("motionSpeed", &["slower", "default", "faster"])?,
        })
    }
}
/// Content can contain text typed by a user. Block recognisable credential material;
/// redact machine-local path strings, and still require review before upload.
pub(super) fn safe_text(v: &str) -> Result<String, Error> {
    if v.contains("-----BEGIN ")
        || [
            "sb_secret_",
            "sk_live_",
            "sk_test_",
            "whsec_",
            "ghp_",
            "github_pat_",
            "Bearer ",
            "postgresql://",
            "postgres://",
        ]
        .iter()
        .any(|p| v.contains(p))
    {
        return Err(Error::Input);
    }
    static CREDENTIALS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let credentials = CREDENTIALS.get_or_init(|| {
        regex::Regex::new(r"\b(?:sk-|xai-|AIza|AKIA)[A-Za-z0-9_-]{16,}")
            .expect("static credential pattern")
    });
    if credentials.is_match(v) {
        return Err(Error::Input);
    }
    static PATHS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let paths = PATHS.get_or_init(|| {
        regex::Regex::new(
            r#"(?:/Users/|/home/|/private/(?:tmp|var)/|[A-Za-z]:\\Users\\)[^\s"'<>]*"#,
        )
        .expect("static local path pattern")
    });
    Ok(paths.replace_all(v, "[local path removed]").into_owned())
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Attachment {
    pub format: String,
    pub name: String,
    pub bytes_base64: String,
    pub sha256: String,
}
impl Attachment {
    pub fn create(name: &str, bytes: &[u8]) -> Result<Self, Error> {
        use base64::Engine;
        use sha2::{Digest, Sha256};
        validate_attachment(name, bytes)?;
        Ok(Self {
            format: "gyro-portable-attachment-v1".into(),
            name: name.into(),
            bytes_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
            sha256: format!("{:x}", Sha256::digest(bytes)),
        })
    }
    pub fn bytes(&self) -> Result<Vec<u8>, Error> {
        use base64::Engine;
        use sha2::{Digest, Sha256};
        if self.format != "gyro-portable-attachment-v1"
            || self.bytes_base64.len() > 68 * 1024 * 1024
        {
            return Err(Error::Input);
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&self.bytes_base64)
            .map_err(|_| Error::Input)?;
        validate_attachment(&self.name, &bytes)?;
        if format!("{:x}", Sha256::digest(&bytes)) != self.sha256 {
            return Err(Error::Protocol);
        }
        Ok(bytes)
    }
}
pub fn validate_attachment(name: &str, bytes: &[u8]) -> Result<(), Error> {
    if bytes.len() > 50 * 1024 * 1024
        || name.is_empty()
        || name.len() > 255
        || name.contains(['/', '\\'])
        || name.chars().any(char::is_control)
        || name.starts_with('.')
        || ["pem", "key", "p12", "pfx"]
            .iter()
            .any(|ext| name.to_ascii_lowercase().ends_with(&format!(".{ext}")))
    {
        return Err(Error::Input);
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        safe_text(text)?;
    }
    Ok(())
}
impl Chat {
    /// A v3 selection must fit as a complete supported archive. Stream the local
    /// transcript and reject an oversized selection instead of loading its tail
    /// or silently truncating a long chat. Legacy v2 behavior is unchanged.
    pub fn from_bounded_session(store:&SessionStore,id:Uuid,namespace:Uuid,max_bytes:usize)->Result<Self,Error>{
        let session=store.get_session(id).map_err(|_|Error::Storage)?.ok_or(Error::Input)?;
        let mut messages=Vec::new();let mut bytes=0usize;let mut failure=None;
        let stopped=store.visit_transcript_events(id,|event|{
            let role=match event.kind{SessionEventKind::UserMessage=>Role::User,SessionEventKind::AssistantMessage=>Role::Assistant,_=>return true};
            let text=match safe_text(&event.message){Ok(text)=>text,Err(error)=>{failure=Some(error);return false;}};
            let message=Message{id:portable_message_id(namespace,event.id),role,text,created_at:event.created_at};
            let length=match serde_json::to_vec(&message){Ok(b)=>b.len(),Err(_)=>{failure=Some(Error::Input);return false;}};
            bytes=bytes.saturating_add(length+1);if bytes>max_bytes||messages.len()>=100000{failure=Some(Error::Limited);return false;}messages.push(message);true
        }).map_err(|_|Error::Storage)?;
        if let Some(error)=failure{return Err(error);}if stopped{return Err(Error::Limited);}
        let value=Self{format:"gyro-portable-chat-v1".into(),title:safe_text(&session.title)?,created_at:session.created_at,project_id:None,messages};
        if value.bytes()?.len()>max_bytes{return Err(Error::Limited);}Ok(value)
    }
    pub fn from_session(
        store: &SessionStore,
        id: Uuid,
        cloud_namespace: Uuid,
    ) -> Result<Self, Error> {
        let session = store
            .get_session(id)
            .map_err(|_| Error::Storage)?
            .ok_or(Error::Input)?;
        // Full display transcript, deliberately not the bounded provider history helper.
        let events = store
            .read_transcript_events(id)
            .map_err(|_| Error::Storage)?;
        Self::from_events_in_namespace(&session.title, session.created_at, &events, cloud_namespace)
    }
    pub fn from_events(
        title: &str,
        created_at: DateTime<Utc>,
        events: &[SessionEvent],
    ) -> Result<Self, Error> {
        Self::from_events_in_namespace(title, created_at, events, Uuid::nil())
    }
    fn from_events_in_namespace(
        title: &str,
        created_at: DateTime<Utc>,
        events: &[SessionEvent],
        cloud_namespace: Uuid,
    ) -> Result<Self, Error> {
        let mut messages = Vec::new();
        for e in events {
            let role = match e.kind {
                SessionEventKind::UserMessage => Role::User,
                SessionEventKind::AssistantMessage => Role::Assistant,
                _ => continue,
            };
            messages.push(Message {
                id: portable_message_id(cloud_namespace, e.id),
                role,
                text: safe_text(&e.message)?,
                created_at: e.created_at,
            });
        }
        let value = Self {
            format: "gyro-portable-chat-v1".into(),
            title: safe_text(title)?,
            created_at,
            project_id: None,
            messages,
        };
        value.bytes()?;
        Ok(value)
    }
    pub fn bytes(&self) -> Result<Vec<u8>, Error> {
        if self.format != "gyro-portable-chat-v1"
            || self.title.len() > 1000
            || self.messages.len() > 100_000
        {
            return Err(Error::Input);
        }
        safe_text(&self.title)?;
        for m in &self.messages {
            if safe_text(&m.text)? != m.text {
                return Err(Error::Input);
            }
        }
        let bytes = serde_json::to_vec(self).map_err(|_| Error::Input)?;
        if bytes.len() > MAX_SELECTION_BYTES {
            return Err(Error::Limited);
        }
        Ok(bytes)
    }
}
fn portable_message_id(namespace: Uuid, local_event: Uuid) -> Uuid {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    digest.update(b"gyro-cloud-portable-message-v1");
    digest.update(namespace.as_bytes());
    digest.update(local_event.as_bytes());
    let hashed = digest.finalize();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&hashed[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}
pub fn save_read_only_archive(chat: &Chat) -> Result<Uuid, Error> {
    let root = crate::paths::GyroPaths::for_current_user()
        .map_err(|_| Error::Storage)?
        .base_dir
        .join("cloud-restored-archives");
    save_read_only_archive_in(chat, &root)
}
pub(super) fn save_read_only_archive_in(
    chat: &Chat,
    root: &std::path::Path,
) -> Result<Uuid, Error> {
    use std::io::Write;
    let bytes = chat.bytes()?;
    crate::paths::ensure_private_directory(&root).map_err(|_| Error::Storage)?;
    let id = Uuid::new_v4();
    let path = root.join(format!("{id}.json"));
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|_| Error::Storage)?;
    file.write_all(&bytes).map_err(|_| Error::Storage)?;
    file.sync_all().map_err(|_| Error::Storage)?;
    Ok(id)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn check_report() -> crate::local_check::CheckReport {
        serde_json::from_value(serde_json::json!({
            "plan":{"id":Uuid::new_v4(),"createdAt":"2026-11-02T10:00:00Z","workspaceRevision":1,
                "draft":{"sessionId":Uuid::new_v4(),"previewUrl":"http://127.0.0.1:4317/private","command":"secret command never shared","dataChanges":"private mutation plan","files":["private-config.ts"],"criteria":[{"id":"add","requirement":"Add an item","expected":true,"scope":"api"}]},
                "snapshot":{"workspace":"/volumes/private-project","gitHead":"private-git-hash","files":[]}},
            "finishedAt":"2026-11-02T10:01:00Z","results":[{"criterionId":"add","status":"failed","actual":false,"evidence":"Observed response at /Users/test/private/file and /volumes/private-project/src/main.ts","reason":"Expected true but received false","observedScope":"api"}],
            "output":null,"stale":true,"freshnessNote":"Files changed; run a fresh check.","omission":"Browser interaction was not checked."
        })).unwrap()
    }
    #[test]
    fn shared_report_preserves_verdict_and_limits_but_excludes_runtime_authority() {
        let source = check_report();
        let portable = Report::from_check(&source).unwrap();
        let text = portable.text();
        for required in [
            "Failed: Add an item",
            "Expected: true",
            "Observed: false",
            "Potentially stale",
            "Browser interaction was not checked.",
            "[local path removed]",
        ] {
            assert!(text.contains(required), "missing {required}");
        }
        for private in [
            "/Users/",
            "/volumes/",
            "secret command",
            "private mutation",
            "private-config",
            "private-git",
            "127.0.0.1",
            &source.plan.id,
            &source.plan.draft.session_id,
        ] {
            assert!(!text.contains(private), "leaked {private}");
        }
        assert_eq!(portable.bytes(), text.as_bytes());
        // Read-only content cannot be deserialized as an executable report or plan.
        assert!(
            serde_json::from_slice::<crate::local_check::CheckPlan>(&portable.bytes()).is_err()
        );
    }
    #[test]
    fn report_projection_blocks_obvious_credentials_and_never_truncates() {
        for secret in [
            "Bearer private-authorization",
            "api_key=arbitrary-secret-value",
            "authorization: bearer arbitrary-authorization",
            "token=arbitrary-secret-value",
            r#"{"apiKey":"arbitrary-secret-value"}"#,
            r#"{"password":"hunter2"}"#,
            "AWS_SECRET_ACCESS_KEY=arbitrary-secret-value",
            "Authorization: Basic arbitrary-authorization",
            "password=supersecret",
            "-----BEGIN PRIVATE KEY-----",
            "sk-abcdefghijklmnopqrstuvw",
        ] {
            let mut source = check_report();
            source.results[0].evidence = Some(secret.into());
            assert!(Report::from_check(&source).is_err(), "accepted {secret}");
        }
        let mut source = check_report();
        source.results[0].evidence = Some("x".repeat(MAX_REPORT_BYTES));
        assert!(Report::from_check(&source).is_err());
    }
    #[test]
    fn report_projection_redacts_common_absolute_paths_and_local_preview_url() {
        let mut source = check_report();
        source.results[0].evidence = Some("/tmp/evidence.txt /etc/private-config /Volumes/Work/file ~/private/file C:\\Users\\test\\private.txt http://127.0.0.1:4317/private".into());
        let text = Report::from_check(&source).unwrap().text;
        for path in [
            "/tmp/",
            "/etc/",
            "/Volumes/",
            "~/private",
            "C:\\Users",
            "127.0.0.1",
        ] {
            assert!(!text.contains(path));
        }
        assert!(text.contains("[local URL removed]"));
    }
    #[test]
    fn saved_report_lookup_enforces_session_identity_and_file_bounds() {
        let dir = tempfile::tempdir().unwrap();
        let source = check_report();
        let id = Uuid::parse_str(&source.plan.id).unwrap();
        let session = Uuid::parse_str(&source.plan.draft.session_id).unwrap();
        crate::local_check::save_report(dir.path(), &source).unwrap();
        assert!(load_report(dir.path(), session, id).is_ok());
        assert!(load_report(dir.path(), Uuid::new_v4(), id).is_err());
        assert!(load_report(dir.path(), session, Uuid::new_v4()).is_err());
        let path = dir.path().join(format!("{id}.json"));
        std::fs::write(&path, vec![b' '; 512 * 1024 + 1]).unwrap();
        assert!(load_report(dir.path(), session, id).is_err());
        #[cfg(unix)]
        {
            std::fs::remove_file(&path).unwrap();
            std::os::unix::fs::symlink("/dev/null", path).unwrap();
            assert!(load_report(dir.path(), session, id).is_err());
        }
    }
    use serde_json::json;
    #[test]
    fn portable_message_identity_is_stable_and_separate_from_runtime_ids() {
        let event = Uuid::new_v4();
        let namespace = Uuid::new_v4();
        let id = portable_message_id(namespace, event);
        assert_eq!(id, portable_message_id(namespace, event));
        assert_ne!(id, event);
        assert_ne!(id, portable_message_id(Uuid::new_v4(), event));
    }
    #[test]
    fn portable_chat_drops_all_runtime_authority_and_keeps_complete_message_text() {
        let id = Uuid::new_v4();
        let full = "message ".repeat(10_000);
        let events = vec![
            SessionEvent::new(
                id,
                SessionEventKind::UserMessage,
                full.clone(),
                json!({"apiKey":"never exported","approval":"allow","workspace":"/Users/example/project"}),
            ),
            SessionEvent::new(
                id,
                SessionEventKind::ApprovalRequested,
                "approve everything",
                json!({"command":"rm"}),
            ),
            SessionEvent::new(
                id,
                SessionEventKind::AssistantMessage,
                "See /Users/example/project/code.rs",
                json!({"providerResumeId":"private"}),
            ),
        ];
        let chat = Chat::from_events("Portable chat", Utc::now(), &events).unwrap();
        let encoded = String::from_utf8(chat.bytes().unwrap()).unwrap();
        assert_eq!(chat.messages.len(), 2);
        assert_eq!(chat.messages[0].text, full);
        for excluded in [
            "apiKey",
            "workspace",
            "approval",
            "providerResumeId",
            "/Users/",
            &id.to_string(),
        ] {
            assert!(!encoded.contains(excluded));
        }
    }
    #[test]
    fn settings_projection_drops_unapproved_fields() {
        let v = json!({"theme":"dark","density":"compact","interfaceSize":"default","motionSpeed":"default","providerKey":"should not leave Mac","approvalPolicy":"automatic"});
        let encoded = serde_json::to_string(&Settings::from_preferences(&v).unwrap()).unwrap();
        assert!(!encoded.contains("providerKey"));
        assert!(!encoded.contains("approvalPolicy"));
    }
    #[test]
    fn credential_like_content_requires_removal_before_upload() {
        assert!(safe_text("credential sk_live_fixture_secret").is_err());
    }
    #[test]
    fn selected_attachments_round_trip_bytes_and_reject_private_key_files() {
        let a = Attachment::create("result.txt", b"approved attachment").unwrap();
        assert_eq!(a.bytes().unwrap(), b"approved attachment");
        assert!(Attachment::create(".env", b"private").is_err());
        assert!(Attachment::create("private.pem", b"private").is_err());
        assert!(Attachment::create("../config.txt", b"private").is_err());
        let mut bad = a;
        bad.sha256 = "0".repeat(64);
        assert!(bad.bytes().is_err());
    }
}
