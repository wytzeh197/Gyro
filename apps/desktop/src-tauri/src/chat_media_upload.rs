//! Bounded raw-byte media ingestion; file validation and storage stay native.

use crate::{
    app::limits::{MAX_CHAT_IMAGE_BYTES, MAX_CHAT_VIDEO_BYTES},
    providers::chat_types::{PrepareChatAttachmentRequest, PreparedChatAttachment},
    sessions::attachments::prepare_chat_attachment_blocking,
};
use base64::Engine;
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

/// Largest remote image a drop may download. Bigger than the attachment limit
/// on purpose: the webview re-encodes oversized pictures before uploading.
const MAX_DROPPED_IMAGE_DOWNLOAD_BYTES: u64 = 32 * 1024 * 1024;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DownloadedChatMedia {
    mime_type: String,
    /// Base64, because a JSON byte array is several times larger.
    data: String,
}

/// An image dragged out of a browser often arrives as a URL only. The webview
/// cannot fetch it: the app CSP limits `connect-src` to IPC, and most image
/// hosts send no CORS headers. Download it natively instead, bounded in time
/// and size, and only accept a real image response.
#[tauri::command]
pub(super) async fn download_chat_media_url(url: String) -> Result<DownloadedChatMedia, String> {
    let url = dropped_media_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || download_image(&url))
        .await
        .map_err(|error| format!("image download worker failed: {error}"))?
}

fn dropped_media_url(value: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(value.trim())
        .map_err(|_| "This image drag did not provide a valid image URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(
            "This image source cannot be attached. Save the image and drop its file instead."
                .into(),
        );
    }
    Ok(url)
}

fn download_image(url: &url::Url) -> Result<DownloadedChatMedia, String> {
    use std::io::Read;
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(20))
        .redirects(5)
        .build();
    let response = agent
        .get(url.as_str())
        .set("Accept", "image/*")
        .call()
        .map_err(|error| match error {
            ureq::Error::Status(status, _) => format!("Image download failed ({status})"),
            ureq::Error::Transport(transport) => {
                if transport.to_string().contains("timed out") {
                    "Image download timed out. Save the image and drop its file instead.".into()
                } else {
                    format!("Image download failed: {transport}")
                }
            }
        })?;
    let mime_type = response.content_type().trim().to_ascii_lowercase();
    if !mime_type.starts_with("image/") {
        return Err("The dropped URL did not return an image".into());
    }
    let declared = response
        .header("content-length")
        .and_then(|value| value.trim().parse::<u64>().ok());
    if declared.is_some_and(|length| length > MAX_DROPPED_IMAGE_DOWNLOAD_BYTES) {
        return Err("The dropped image is too large to download".into());
    }
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(MAX_DROPPED_IMAGE_DOWNLOAD_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Image download failed: {error}"))?;
    validate_download(bytes.len())?;
    Ok(DownloadedChatMedia {
        mime_type,
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

fn validate_download(bytes: usize) -> Result<(), String> {
    if bytes == 0 {
        return Err("The dropped image is empty".into());
    }
    if bytes as u64 > MAX_DROPPED_IMAGE_DOWNLOAD_BYTES {
        return Err("The dropped image is too large to download".into());
    }
    Ok(())
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

    #[test]
    fn dropped_media_downloads_only_follow_web_urls() {
        assert!(dropped_media_url("https://example.com/cat.png").is_ok());
        assert!(dropped_media_url(" http://localhost:5173/a.webp ").is_ok());
        for rejected in [
            "file:///Users/me/cat.png",
            "data:image/png;base64,AAAA",
            "javascript:alert(1)",
            "asset://localhost/%2Ftmp%2Fa.png",
            "not a url",
        ] {
            assert!(dropped_media_url(rejected).is_err(), "{rejected}");
        }
        assert!(validate_download(0).is_err());
        assert!(validate_download(MAX_DROPPED_IMAGE_DOWNLOAD_BYTES as usize).is_ok());
        assert!(validate_download(MAX_DROPPED_IMAGE_DOWNLOAD_BYTES as usize + 1).is_err());
    }
}
