//! Session-scoped media transfer. Network frames stay bounded even for large videos.
use super::{commands::remote_host_request, dispatch::value, err, Runtime};
use crate::{
    app::limits::{MAX_CHAT_ATTACHMENTS, MAX_CHAT_IMAGES, MAX_CHAT_IMAGE_BYTES,
        MAX_CHAT_VIDEOS, MAX_CHAT_VIDEO_BYTES, MAX_CHAT_ATTACHMENT_TOTAL_BYTES},
    providers::chat_types::{PrepareChatAttachmentRequest, PreparedChatAttachment},
    sessions::attachments::{prepare_chat_attachment_blocking, validate_attachment_name},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use crate::providers::chat_types::ChatAttachmentRequest;
use gyro_remote::{protocol::AttachmentRef, Operation, Request};
use serde_json::Value;
use std::{collections::HashMap, path::PathBuf, time::{Duration, Instant}};
use uuid::Uuid;

const CHUNK_BYTES: usize = 256 * 1024;
const MAX_UPLOADS: usize = 16;
#[derive(Default)]
pub(super) struct Uploads(HashMap<(String, String, Uuid), Upload>);
struct Upload {
    name: String,
    kind: String,
    bytes: Vec<u8>,
    touched: Instant,
}

impl Uploads {
    fn push(&mut self, peer: &str, session: &str, id: Uuid, name: &str,
        kind: &str, offset: usize, data: &str, complete: bool) -> Result<Option<Vec<u8>>, String> {
        self.0.retain(|_, upload| upload.touched.elapsed() < Duration::from_secs(600));
        validate_attachment_name(name)?;
        let limit = match kind {
            "image" => MAX_CHAT_IMAGE_BYTES,
            "video" => MAX_CHAT_VIDEO_BYTES,
            _ => return Err("Only images and videos can be uploaded".into()),
        } as usize;
        if data.len() > CHUNK_BYTES.div_ceil(3) * 4 {
            return Err("Attachment chunk is too large".into());
        }
        let bytes = STANDARD.decode(data).map_err(|_| "Invalid attachment bytes")?;
        if bytes.is_empty() || bytes.len() > CHUNK_BYTES {
            return Err("Invalid attachment chunk size".into());
        }
        let key = (peer.to_owned(), session.to_owned(), id);
        if !self.0.contains_key(&key) {
            if offset != 0 || self.0.len() >= MAX_UPLOADS {
                return Err("Attachment upload expired or the host is busy; attach it again".into());
            }
            self.0.insert(key.clone(), Upload {
                name: name.into(), kind: kind.into(), bytes: Vec::new(), touched: Instant::now(),
            });
        }
        let total: usize = self.0.values().map(|upload| upload.bytes.len()).sum();
        let upload = self.0.get_mut(&key).unwrap();
        if upload.name != name || upload.kind != kind || upload.bytes.len() != offset {
            return Err("Attachment upload changed or arrived out of order".into());
        }
        if offset.saturating_add(bytes.len()) > limit
            || total.saturating_add(bytes.len()) > MAX_CHAT_ATTACHMENT_TOTAL_BYTES as usize {
            self.0.remove(&key);
            return Err("Attachment upload exceeds the host storage limit".into());
        }
        upload.bytes.extend_from_slice(&bytes);
        upload.touched = Instant::now();
        Ok(if complete { Some(self.0.remove(&key).unwrap().bytes) } else { None })
    }
}

pub(super) fn upload(runtime: &Runtime, peer: &str, session: &str, id: Uuid,
    name: &str, kind: &str, offset: usize, data: &str, complete: bool) -> Result<Value, String> {
    let bytes = runtime.uploads.lock().map_err(err)?
        .push(peer, session, id, name, kind, offset, data, complete)?;
    match bytes {
        None => Ok(Value::Null),
        Some(bytes) => value(prepare_chat_attachment_blocking(PrepareChatAttachmentRequest {
            session_id: session.into(), path: String::new(), workspace_path: None,
            kind: kind.into(), bytes: Some(bytes), name: Some(name.into()), relative_path: None,
        })?),
    }
}

pub(super) fn workspace_attachment(runtime: &Runtime, session_id: &str, path: &str)
    -> Result<PreparedChatAttachment, String> {
    super::workspace::relative(path)?;
    let session = runtime.session(session_id)?;
    prepare_chat_attachment_blocking(PrepareChatAttachmentRequest {
        session_id: session_id.into(),
        path: session.workspace_path.join(path).to_string_lossy().into(),
        workspace_path: Some(session.workspace_path.to_string_lossy().into()),
        kind: "workspace-file".into(), bytes: None, name: None, relative_path: None,
    })
}

pub(super) fn for_submit(runtime: &Runtime, session_id: &str, refs: &[AttachmentRef])
    -> Result<Vec<ChatAttachmentRequest>, String> {
    if refs.len() > MAX_CHAT_ATTACHMENTS
        || refs.iter().filter(|a| a.kind == "image").count() > MAX_CHAT_IMAGES
        || refs.iter().filter(|a| a.kind == "video").count() > MAX_CHAT_VIDEOS {
        return Err("Too many attachments for one message".into());
    }
    let root = gyro_core::GyroPaths::for_current_user().map_err(err)?
        .sessions_dir.join("attachments").join(session_id);
    refs.iter().map(|reference| {
        let prepared = if reference.kind == "workspace-file" {
            workspace_attachment(runtime, session_id, &reference.path)?
        } else {
            if !matches!(reference.kind.as_str(), "image" | "video") {
                return Err("Unsupported remote attachment".into());
            }
            let path = PathBuf::from(&reference.path).canonicalize().map_err(err)?;
            if !path.starts_with(root.canonicalize().map_err(err)?) {
                return Err("The attachment does not belong to this host session".into());
            }
            prepare_chat_attachment_blocking(PrepareChatAttachmentRequest {
                session_id: session_id.into(), path: path.to_string_lossy().into(),
                workspace_path: None, kind: reference.kind.clone(), bytes: None,
                name: Some(reference.name.clone()), relative_path: None,
            })?
        };
        if prepared.content_hash != reference.content_hash {
            return Err("The attachment changed; remove it and attach it again".into());
        }
        serde_json::from_value(value(prepared)?).map_err(err)
    }).collect()
}

/// The picker and native drops read the client's files. Only validated media bytes
/// cross to the host; a path on this Mac is never interpreted as a host path.
#[tauri::command]
pub(crate) async fn remote_upload_attachment(
    app: tauri::AppHandle, host_id: String, session_id: String,
    attachment: ChatAttachmentRequest,
) -> Result<Value, String> {
    crate::stores::parse_uuid(&session_id)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        if !matches!(attachment.kind.as_str(), "image" | "video") {
            return Err("Select an image or video from this Mac".to_string());
        }
        let root = gyro_core::GyroPaths::for_current_user().map_err(err)?
            .sessions_dir.join("attachments").canonicalize().map_err(err)?;
        let path = PathBuf::from(&attachment.path).canonicalize().map_err(err)?;
        if !path.starts_with(root) {
            return Err("Prepare the local attachment before uploading it".into());
        }
        let prepared = prepare_chat_attachment_blocking(PrepareChatAttachmentRequest {
            session_id: "new".into(), path: path.to_string_lossy().into(),
            workspace_path: None, kind: attachment.kind.clone(), bytes: None,
            name: Some(attachment.name.clone()), relative_path: None,
        })?;
        if attachment.content_hash.as_deref() != Some(&prepared.content_hash) {
            return Err("The local attachment changed; attach it again".into());
        }
        let (bytes, _) = crate::workspace::files::read_bounded_regular_file(
            std::path::Path::new(&prepared.path), prepared.size as usize, "remote attachment",
        ).map_err(err)?;
        use sha2::{Digest, Sha256};
        if format!("{:x}", Sha256::digest(&bytes)) != prepared.content_hash {
            return Err("The local attachment changed during upload".into());
        }
        Ok::<_, String>((attachment.name, attachment.kind, bytes))
    }).await.map_err(err)??;
    let control = remote_host_request(app.clone(), host_id.clone(), Request {
        id: Uuid::new_v4(), lease: None,
        operation: Operation::Claim { session_id: session_id.clone() },
    }).await?;
    let lease = control["generation"].as_u64().ok_or("Host did not grant control")?;
    let upload_id = Uuid::new_v4();
    let (name, kind, bytes) = bytes;
    let mut result = Value::Null;
    for (index, chunk) in bytes.chunks(CHUNK_BYTES).enumerate() {
        let offset = index * CHUNK_BYTES;
        result = remote_host_request(app.clone(), host_id.clone(), Request {
            id: Uuid::new_v4(), lease: Some(lease),
            operation: Operation::UploadAttachment {
                session_id: session_id.clone(), upload_id,
                name: name.clone(), kind: kind.clone(), offset,
                data: STANDARD.encode(chunk), complete: offset + chunk.len() == bytes.len(),
            },
        }).await?;
    }
    Ok(result)
}

pub(super) fn read_image(runtime: &Runtime, session_id: &str, target: &str, offset: u64)
    -> Result<Value, String> {
    use std::io::{Read, Seek, SeekFrom};
    let session = runtime.session(session_id)?;
    let paths = gyro_core::GyroPaths::for_current_user().map_err(err)?;
    let path = crate::chat_images::resolve_cited_chat_image(target, &crate::chat_images::CitedImageContext {
        workspace: session.workspace_path,
        provider_id: None, provider_session_id: None, home: None,
        browser_captures: Some(paths.browser_captures_dir),
        attachments: Some(paths.sessions_dir.join("attachments").join(session_id)),
    }).ok_or("This image is unavailable in the host workspace or session")?;
    let mut file = std::fs::File::open(path).map_err(err)?;
    let metadata = file.metadata().map_err(err)?;
    if offset >= metadata.len() { return Err("Invalid image offset".into()); }
    let revision = format!("{}:{:?}", metadata.len(), metadata.modified().map_err(err)?);
    let mut header = [0; 16];
    let count = file.read(&mut header).map_err(err)?;
    let (mime, _) = crate::sessions::attachments::validated_chat_media_type("preview", false, &header[..count])?;
    file.seek(SeekFrom::Start(offset)).map_err(err)?;
    let mut bytes = Vec::new();
    file.take(CHUNK_BYTES as u64).read_to_end(&mut bytes).map_err(err)?;
    Ok(serde_json::json!({
        "data": STANDARD.encode(&bytes), "mimeType": mime, "revision": revision,
        "total": metadata.len(), "nextOffset": offset + bytes.len() as u64,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn upload_is_ordered_scoped_bounded_and_expires() {
        let mut uploads = Uploads::default();
        let id = Uuid::new_v4();
        let data = STANDARD.encode(b"abc");
        assert!(uploads.push("a", "s", id, "../x.png", "image", 0, &data, false).is_err());
        assert!(uploads.push("a", "s", id, "x.png", "image", 0, &data, false).unwrap().is_none());
        assert!(uploads.push("b", "s", id, "x.png", "image", 3, &data, true).is_err());
        assert!(uploads.push("a", "other", id, "x.png", "image", 3, &data, true).is_err());
        assert!(uploads.push("a", "s", id, "x.png", "image", 1, &data, true).is_err());
        assert!(uploads.push("a", "s", id, "x.png", "image", 3,
            &STANDARD.encode(vec![0; CHUNK_BYTES + 1]), true).is_err());
        assert_eq!(uploads.push("a", "s", id, "x.png", "image", 3, &data, true).unwrap(),
            Some(b"abcabc".to_vec()));
        uploads.push("a", "s", id, "x.png", "image", 0, &data, false).unwrap();
        uploads.0.values_mut().next().unwrap().touched = Instant::now() - Duration::from_secs(601);
        assert!(uploads.push("a", "s", id, "x.png", "image", 3, &data, true).is_err());
    }
}
