//! Bounded raw-byte media ingestion; file validation and storage stay native.
use super::*;

/// Dropped and pasted media arrive as a raw IPC body. Encoding a video as a
/// JSON number array inflates it several times over and stalls the webview.
#[tauri::command]
pub(super) async fn prepare_chat_media_upload(
    request: tauri::ipc::Request<'_>,
) -> Result<PreparedChatAttachment, String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("media uploads must be sent as raw bytes".into());
    };
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
    };
    let decode = |value: String| {
        base64::engine::general_purpose::STANDARD
            .decode(value)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .ok_or_else(|| "media upload header is invalid".to_string())
    };
    let kind = header("x-gyro-kind").unwrap_or_default();
    validate_upload(&kind, body.len())?;
    let upload = PrepareChatAttachmentRequest {
        session_id: header("x-gyro-session-id")
            .ok_or_else(|| "media upload has no session".to_string())?,
        path: String::new(),
        workspace_path: header("x-gyro-workspace").map(decode).transpose()?,
        kind,
        bytes: Some(body.clone()),
        name: Some(
            header("x-gyro-name")
                .map(decode)
                .transpose()?
                .ok_or_else(|| "media upload has no name".to_string())?,
        ),
        relative_path: None,
    };
    tauri::async_runtime::spawn_blocking(move || prepare_chat_attachment_blocking(upload))
        .await
        .map_err(|error| format!("attachment worker failed: {error}"))?
}

fn validate_upload(kind: &str, bytes: usize) -> Result<(), String> {
    let limit = match kind {
        "image" => MAX_CHAT_IMAGE_BYTES,
        "video" => MAX_CHAT_VIDEO_BYTES,
        _ => return Err("only image and video uploads are supported".into()),
    };
    if bytes == 0 || bytes as u64 > limit {
        return Err(format!(
            "{kind}s must contain data and be {} MB or smaller",
            limit / (1024 * 1024)
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validate_media_before_copying_the_ipc_body() {
        assert!(validate_upload("image", 0).is_err());
        assert!(validate_upload("image", MAX_CHAT_IMAGE_BYTES as usize).is_ok());
        assert!(validate_upload("image", MAX_CHAT_IMAGE_BYTES as usize + 1).is_err());
        assert!(validate_upload("video", MAX_CHAT_VIDEO_BYTES as usize).is_ok());
        assert!(validate_upload("video", MAX_CHAT_VIDEO_BYTES as usize + 1).is_err());
        assert!(validate_upload("workspace-file", 1).is_err());
    }
}
