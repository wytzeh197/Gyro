use crate::{
    app::limits::{
        MAX_CHAT_IDE_SNAPSHOT_BYTES, MAX_CHAT_IMAGE_BYTES, MAX_CHAT_VIDEO_BYTES,
        MAX_CHAT_WORKSPACE_ATTACHMENT_BYTES, MAX_STORED_CHAT_ATTACHMENTS_PER_SESSION,
        MAX_STORED_CHAT_ATTACHMENT_BYTES_PER_SESSION, MAX_STORED_DRAFT_ATTACHMENTS,
    },
    capabilities::access::browser_observation,
    chat_images,
    providers::{
        binding::session_execution_workspace,
        chat_types::{PrepareChatAttachmentRequest, PreparedChatAttachment},
    },
    session_browser,
    sessions::commands::{attachment_session_lock, remove_attachment_storage_entry},
    state::provider_run::ModelBrowserResource,
    stores::{open_store, parse_uuid, to_string},
    workspace::files::read_bounded_regular_file,
};
use gyro_core::GyroPaths;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use tauri::Manager;
use uuid::Uuid;
#[tauri::command]
pub(crate) async fn prepare_browser_attachment(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<PreparedChatAttachment, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = open_store()?;
        let session = store
            .get_session(parse_uuid(&session_id)?)
            .map_err(to_string)?
            .ok_or_else(|| "the browser chat no longer exists".to_string())?;
        let workspace = session_execution_workspace(&session, store.paths())?;
        let snapshot = app
            .state::<session_browser::SessionBrowserManager>()
            .require_owned(&session_id, &workspace.display().to_string())?;
        let page = session_browser::call_agent(
            &app,
            &session_id,
            "readPage",
            serde_json::json!({"maxDepth": 4}),
        )?;
        let owned = ModelBrowserResource {
            resource_id: snapshot.resource_id,
            session_id: session_id.clone(),
            turn_id: None,
            call_id: Uuid::new_v4(),
            workspace_key: workspace.display().to_string(),
            url: snapshot.url,
        };
        let observation = browser_observation(
            &app,
            &owned,
            &page,
            Some(page.clone()),
            None,
            Vec::new(),
            Vec::new(),
        )
        .map_err(to_string)?;
        let mut observation = serde_json::to_value(observation).map_err(to_string)?;
        // Capture both forms now. The adapter includes the image only when it
        // supports vision, so switching to a text model preserves the snapshot.
        let image =
            session_browser::capture_session_browser_png(&app, &session_id).and_then(|capture| {
                let width = capture.width;
                let height = capture.height;
                prepare_chat_attachment_blocking(PrepareChatAttachmentRequest {
                    session_id: session_id.clone(),
                    path: String::new(),
                    workspace_path: None,
                    kind: "image".into(),
                    bytes: Some(capture.png),
                    name: Some("Gyro Browser.png".into()),
                    relative_path: None,
                })
                .map(|image| (image, width, height))
            });
        match image {
            Ok((image, width, height)) => {
                observation["screenshot"] = serde_json::json!({
                    "path": image.path,
                    "filename": image.name,
                    "width": width,
                    "height": height,
                    "createdAt": chrono::Utc::now().to_rfc3339(),
                });
                observation["attachedImage"] = serde_json::to_value(image).map_err(to_string)?;
                observation["evidence"]["screenshotCaptured"] = serde_json::json!(true);
            }
            Err(error) => {
                observation["evidence"]["visualNote"] =
                    serde_json::json!(format!("Screenshot unavailable: {error}"));
            }
        }
        prepare_chat_attachment_blocking(PrepareChatAttachmentRequest {
            session_id,
            path: String::new(),
            workspace_path: None,
            kind: "browser-snapshot".into(),
            bytes: Some(serde_json::to_vec(&observation).map_err(to_string)?),
            name: Some("Gyro Browser snapshot.json".into()),
            relative_path: Some("Gyro Browser".into()),
        })
    })
    .await
    .map_err(|error| format!("browser attachment worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn prepare_chat_attachment(
    request: PrepareChatAttachmentRequest,
) -> Result<PreparedChatAttachment, String> {
    tauri::async_runtime::spawn_blocking(move || prepare_chat_attachment_blocking(request))
        .await
        .map_err(|error| format!("attachment worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn read_cited_chat_image(
    request: chat_images::ResolveCitedChatImageRequest,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        chat_images::read_cited_chat_image_request(request)
    })
    .await
    .map_err(|error| format!("image preview worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn resolve_cited_chat_image(
    request: chat_images::ResolveCitedChatImageRequest,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        chat_images::resolve_cited_chat_image_request(request)
    })
    .await
    .map_err(|error| format!("cited image worker failed: {error}"))?
}

/// QuickTime files written before the ISO base format may open with a movie,
/// data, or padding atom instead of `ftyp`.
pub(crate) fn is_quicktime_container(bytes: &[u8]) -> bool {
    matches!(
        bytes.get(4..8),
        Some(b"ftyp" | b"moov" | b"mdat" | b"wide" | b"free" | b"skip" | b"pnot")
    )
}

pub(crate) fn validated_chat_media_type(
    name: &str,
    is_video: bool,
    bytes: &[u8],
) -> Result<(&'static str, &'static str), String> {
    // Images are typed by their bytes: pasted and downloaded images often carry
    // a name that disagrees with their contents, and the stored file is renamed
    // to the content type anyway.
    if !is_video {
        return if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            Ok(("image/png", "png"))
        } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
            Ok(("image/jpeg", "jpg"))
        } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
            Ok(("image/webp", "webp"))
        } else {
            Err("only PNG, JPEG, and WebP images are supported".into())
        };
    }
    let extension = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "mp4" | "m4v" if bytes.get(4..8) == Some(b"ftyp") => Ok(("video/mp4", "mp4")),
        "mov" if is_quicktime_container(bytes) => Ok(("video/quicktime", "mov")),
        "webm" if bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) => Ok(("video/webm", "webm")),
        "mp4" | "m4v" | "mov" | "webm" => {
            Err("video contents do not match the selected file type".into())
        }
        _ => Err("only MP4, M4V, MOV, and WebM videos are supported".into()),
    }
}

pub(crate) fn prepare_chat_attachment_blocking(
    request: PrepareChatAttachmentRequest,
) -> Result<PreparedChatAttachment, String> {
    let safe_session = if request.session_id == "new" {
        "new".to_string()
    } else {
        parse_uuid(&request.session_id)?.to_string()
    };
    let attachment_lock = attachment_session_lock(&safe_session)?;
    let _attachment_guard = attachment_lock
        .lock()
        .map_err(|_| "session attachment lock is unavailable".to_string())?;
    if safe_session != "new" {
        let store = open_store()?;
        let session_id = parse_uuid(&safe_session)?;
        if store.get_session(session_id).map_err(to_string)?.is_none() {
            return Err("the attachment session no longer exists".into());
        }
    }
    let source = (!request.path.trim().is_empty())
        .then(|| PathBuf::from(request.path.trim()).canonicalize())
        .transpose()
        .map_err(|_| "attachment file is missing or unavailable".to_string())?;
    let metadata = source
        .as_ref()
        .map(|path| path.metadata())
        .transpose()
        .map_err(to_string)?;
    if metadata.as_ref().is_some_and(|value| !value.is_file()) {
        return Err("directories cannot be attached".into());
    }
    let name = request
        .name
        .clone()
        .or_else(|| source.as_ref()?.file_name()?.to_str().map(str::to_string))
        .ok_or_else(|| "attachment name is invalid".to_string())?;
    validate_attachment_name(&name)?;
    let modified_at = metadata
        .as_ref()
        .and_then(|metadata| metadata.modified().ok())
        .map(chrono::DateTime::<chrono::Utc>::from)
        .map(|value| value.to_rfc3339());

    let (path, relative_path, mime_type, size, content_hash) =
        if request.kind == "image" || request.kind == "video" {
            let is_video = request.kind == "video";
            let media_limit = if is_video {
                MAX_CHAT_VIDEO_BYTES
            } else {
                MAX_CHAT_IMAGE_BYTES
            };
            let media_label = if is_video { "videos" } else { "images" };
            if metadata
                .as_ref()
                .is_some_and(|metadata| metadata.len() > media_limit)
            {
                return Err(format!(
                    "{media_label} must be {} MB or smaller",
                    media_limit / (1024 * 1024)
                ));
            }
            let bytes = match request.bytes {
                Some(bytes) => bytes,
                None => read_bounded_regular_file(
                    source
                        .as_ref()
                        .ok_or_else(|| "media attachment has no source data".to_string())?,
                    media_limit as usize,
                    "media attachment",
                )
                .map(|(bytes, _)| bytes)
                .map_err(|_| "attachment file is empty or unreadable".to_string())?,
            };
            if bytes.is_empty() {
                return Err("attachment file is empty or unreadable".into());
            }
            if bytes.len() as u64 > media_limit {
                return Err(format!(
                    "{media_label} must be {} MB or smaller",
                    media_limit / (1024 * 1024)
                ));
            }
            let (mime, safe_extension) = validated_chat_media_type(&name, is_video, &bytes)?;
            let content_hash = format!("{:x}", Sha256::digest(&bytes));
            let paths = GyroPaths::for_current_user().map_err(to_string)?;
            paths.ensure().map_err(to_string)?;
            let attachments_root = paths.sessions_dir.join("attachments");
            ensure_private_attachment_directory(&attachments_root)?;
            let attachment_dir = attachments_root.join(&safe_session);
            ensure_private_attachment_directory(&attachment_dir)?;
            // Never incorporate the renderer-provided display name into a filesystem
            // path. Content-addressed native filenames eliminate traversal and make
            // deduplication safe.
            let destination = attachment_dir.join(format!("{content_hash}.{safe_extension}"));
            if safe_session == "new" {
                make_room_in_draft_attachments(&attachment_dir, &destination, bytes.len() as u64)?;
            }
            ensure_attachment_storage_quota(&attachment_dir, &destination, bytes.len() as u64)?;
            write_private_attachment(&destination, &bytes, &content_hash)?;
            if safe_session != "new" {
                if let Some(source) = source.as_ref() {
                    let draft_dir = attachments_root.join("new");
                    if source.starts_with(&draft_dir) && source != &destination {
                        let _ = fs::remove_file(source);
                    }
                }
            }
            (
                destination.display().to_string(),
                None,
                Some(mime.to_string()),
                bytes.len() as u64,
                content_hash,
            )
        } else if request.kind == "workspace-file" {
            let workspace = request
                .workspace_path
                .as_deref()
                .ok_or_else(|| "select a workspace before attaching a file".to_string())?;
            let source =
                source.ok_or_else(|| "workspace files require a local path".to_string())?;
            let workspace = PathBuf::from(workspace).canonicalize().map_err(to_string)?;
            if !source.starts_with(&workspace) {
                return Err("workspace file must remain inside the selected workspace".into());
            }
            let relative = source
                .strip_prefix(&workspace)
                .map_err(to_string)?
                .display()
                .to_string();
            let (content_hash, size) =
                hash_file_streaming(&source, Some(MAX_CHAT_WORKSPACE_ATTACHMENT_BYTES))?;
            if size == 0 {
                return Err("attachment file is empty or unreadable".into());
            }
            (
                source.display().to_string(),
                Some(relative),
                None,
                size,
                content_hash,
            )
        } else if matches!(
            request.kind.as_str(),
            "ide-snapshot" | "browser-snapshot" | "terminal-output"
        ) {
            let is_terminal_output = request.kind == "terminal-output";
            let paths = GyroPaths::for_current_user().map_err(to_string)?;
            paths.ensure().map_err(to_string)?;
            let attachments_root = paths.sessions_dir.join("attachments");
            let bytes = match request.bytes {
                Some(bytes) => bytes,
                None => {
                    let source = source.as_ref().ok_or_else(|| {
                        "editor snapshots require immutable text content".to_string()
                    })?;
                    let draft_dir = attachments_root
                        .join("new")
                        .canonicalize()
                        .map_err(|_| "draft editor snapshot storage is unavailable".to_string())?;
                    if !source.starts_with(&draft_dir) {
                        return Err(
                            "editor snapshots can only migrate from private draft storage".into(),
                        );
                    }
                    read_bounded_regular_file(
                        source,
                        MAX_CHAT_IDE_SNAPSHOT_BYTES as usize,
                        "editor snapshot",
                    )
                    .map(|(bytes, _)| bytes)
                    .map_err(to_string)?
                }
            };
            if bytes.is_empty() || bytes.len() as u64 > MAX_CHAT_IDE_SNAPSHOT_BYTES {
                return Err("editor snapshots must contain 1 byte to 128 KB of text".into());
            }
            if bytes.contains(&0) || std::str::from_utf8(&bytes).is_err() {
                return Err("editor snapshots must be UTF-8 text".into());
            }
            let bytes = if is_terminal_output {
                redact_terminal_output(&bytes)
            } else {
                bytes
            };
            // Terminal output is not a workspace file, so it has no path to check.
            let relative = if is_terminal_output {
                None
            } else {
                Some(
                    gyro_core::normalize_capability_relative_path(
                        request.relative_path.as_deref().ok_or_else(|| {
                            "editor snapshots require a workspace path".to_string()
                        })?,
                    )
                    .map_err(to_string)?,
                )
            };
            let content_hash = format!("{:x}", Sha256::digest(&bytes));
            ensure_private_attachment_directory(&attachments_root)?;
            let attachment_dir = attachments_root.join(&safe_session);
            ensure_private_attachment_directory(&attachment_dir)?;
            let destination = attachment_dir.join(format!("{content_hash}.snapshot.txt"));
            if safe_session == "new" {
                make_room_in_draft_attachments(&attachment_dir, &destination, bytes.len() as u64)?;
            }
            ensure_attachment_storage_quota(&attachment_dir, &destination, bytes.len() as u64)?;
            write_private_attachment(&destination, &bytes, &content_hash)?;
            if safe_session != "new" {
                if let Some(source) = source.as_ref() {
                    let draft_dir = attachments_root.join("new");
                    if source.starts_with(&draft_dir) && source != &destination {
                        let _ = fs::remove_file(source);
                    }
                }
            }
            (
                destination.display().to_string(),
                relative,
                Some("text/plain".into()),
                bytes.len() as u64,
                content_hash,
            )
        } else {
            return Err("unsupported attachment kind".into());
        };

    let preview_text = (request.kind == "terminal-output")
        .then(|| fs::read_to_string(&path).ok())
        .flatten();
    Ok(PreparedChatAttachment {
        id: Uuid::new_v4().to_string(),
        kind: request.kind,
        name,
        path,
        relative_path,
        mime_type,
        size,
        content_hash,
        modified_at,
        available: true,
        stale: false,
        preview_text,
    })
}

/// Terminal output is whatever a program printed, which can include the tokens
/// and keys it was run with. Attachment preparation redacts it, since every
/// entry point passes there, so neither the stored copy nor the prompt has them.
pub(crate) fn redact_terminal_output(bytes: &[u8]) -> Vec<u8> {
    gyro_core::security::redact_secrets(&String::from_utf8_lossy(bytes)).into_bytes()
}

pub(crate) fn validate_attachment_name(name: &str) -> Result<(), String> {
    let mut components = Path::new(name).components();
    let is_single_component = matches!(components.next(), Some(std::path::Component::Normal(_)))
        && components.next().is_none();
    if !is_single_component || name.chars().count() > 255 || name.chars().any(char::is_control) {
        return Err("attachment name must be a single safe file name".into());
    }
    Ok(())
}

pub(crate) fn ensure_private_attachment_directory(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err("attachment storage path is not a private directory".into());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path).map_err(to_string)?;
        }
        Err(error) => return Err(to_string(error)),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(to_string)?;
    }
    Ok(())
}

/// Every unsent draft shares one folder, and only sending moves a file out of
/// it, so images from removed chips and abandoned drafts would otherwise stay
/// forever and eventually fill it. The draft folder is a cache: give up its least
/// recently used files instead. A session's folder is never pruned because its
/// transcript still points at those files.
pub(crate) fn make_room_in_draft_attachments(
    directory: &Path,
    destination: &Path,
    incoming_bytes: u64,
) -> Result<(), String> {
    // Attaching a stored image again counts as using it.
    if fs::symlink_metadata(destination).is_ok_and(|metadata| metadata.is_file()) {
        fs::File::options()
            .write(true)
            .open(destination)
            .and_then(|file| file.set_modified(std::time::SystemTime::now()))
            .map_err(to_string)?;
        return Ok(());
    }
    if fs::symlink_metadata(destination).is_ok() {
        return Ok(());
    }
    let mut stored = Vec::new();
    let mut bytes = 0u64;
    for entry in fs::read_dir(directory).map_err(to_string)? {
        let entry = entry.map_err(to_string)?;
        if entry.file_name().to_string_lossy().starts_with(".upload-") {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(to_string)?;
        // The quota check reports anything that is not a plain file.
        if !metadata.is_file() {
            continue;
        }
        bytes = bytes.saturating_add(metadata.len());
        let modified = metadata
            .modified()
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        stored.push((modified, entry.path(), metadata.len()));
    }
    stored.sort();
    let mut files = stored.len();
    for (_, path, size) in stored {
        if files < MAX_STORED_DRAFT_ATTACHMENTS
            && bytes.saturating_add(incoming_bytes) <= MAX_STORED_CHAT_ATTACHMENT_BYTES_PER_SESSION
        {
            break;
        }
        remove_attachment_storage_entry(&path)?;
        files -= 1;
        bytes = bytes.saturating_sub(size);
    }
    Ok(())
}

pub(crate) fn ensure_attachment_storage_quota(
    directory: &Path,
    destination: &Path,
    incoming_bytes: u64,
) -> Result<(), String> {
    if fs::symlink_metadata(destination).is_ok() {
        return Ok(());
    }
    let mut files = 0usize;
    let mut bytes = 0u64;
    for entry in fs::read_dir(directory).map_err(to_string)? {
        let entry = entry.map_err(to_string)?;
        let name = entry.file_name();
        if name.to_string_lossy().starts_with(".upload-") {
            let _ = remove_attachment_storage_entry(&entry.path());
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(to_string)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("session attachment storage contains an unsafe entry".into());
        }
        files = files.saturating_add(1);
        bytes = bytes
            .checked_add(metadata.len())
            .ok_or_else(|| "attachment storage size overflow".to_string())?;
    }
    // A session's files cannot be given up, so the only way forward is a new chat.
    if files >= MAX_STORED_CHAT_ATTACHMENTS_PER_SESSION {
        return Err(format!(
            "this chat has reached its limit of {MAX_STORED_CHAT_ATTACHMENTS_PER_SESSION} stored attachments; start a new chat to attach more"
        ));
    }
    if bytes.checked_add(incoming_bytes).map_or(true, |total| {
        total > MAX_STORED_CHAT_ATTACHMENT_BYTES_PER_SESSION
    }) {
        return Err(format!(
            "this chat's {} GB of attachment storage has no room for this file; start a new chat to attach it",
            MAX_STORED_CHAT_ATTACHMENT_BYTES_PER_SESSION / (1024 * 1024 * 1024)
        ));
    }
    Ok(())
}

pub(crate) fn write_private_attachment(
    path: &Path,
    bytes: &[u8],
    expected_hash: &str,
) -> Result<(), String> {
    if fs::symlink_metadata(path).is_ok() {
        return validate_private_attachment(path, expected_hash);
    }
    let parent = path
        .parent()
        .ok_or_else(|| "attachment destination has no parent directory".to_string())?;
    let temporary = parent.join(format!(".upload-{}", Uuid::new_v4().simple()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).map_err(to_string)?;
    let write_result = file.write_all(bytes).and_then(|_| file.sync_all());
    drop(file);
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary);
        return Err(to_string(error));
    }
    let link_result = fs::hard_link(&temporary, path);
    let _ = fs::remove_file(&temporary);
    match link_result {
        Ok(()) => {
            #[cfg(unix)]
            if let Ok(parent) = fs::File::open(parent) {
                let _ = parent.sync_all();
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            validate_private_attachment(path, expected_hash)
        }
        Err(error) => Err(to_string(error)),
    }
}

pub(crate) fn validate_private_attachment(path: &Path, expected_hash: &str) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(to_string)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("attachment destination is not a regular file".into());
    }
    let (actual_hash, _) = hash_file_streaming(path, Some(MAX_CHAT_VIDEO_BYTES))?;
    if actual_hash != expected_hash {
        return Err("attachment destination already contains different data".into());
    }
    Ok(())
}

pub(crate) fn hash_file_streaming(
    path: &Path,
    max_bytes: Option<u64>,
) -> Result<(String, u64), String> {
    let mut file = fs::File::open(path).map_err(to_string)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let count = file.read(&mut buffer).map_err(to_string)?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .ok_or_else(|| "attachment size overflow".to_string())?;
        if max_bytes.is_some_and(|limit| total > limit) {
            return Err("attachment exceeds the allowed size".into());
        }
        hasher.update(&buffer[..count]);
    }
    Ok((format!("{:x}", hasher.finalize()), total))
}
