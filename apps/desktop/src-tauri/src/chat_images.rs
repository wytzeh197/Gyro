//! Resolve an image path a model cited in chat to a file Gyro may display.
//!
//! Models often cite a workspace-relative path, or, for Grok, a file saved
//! under that ACP session's media directory. The stored reply keeps the
//! citation text. Display asks this resolver for an absolute path, and only
//! a regular PNG, JPEG, or WebP that stays inside an allowed root is returned.

use serde::Deserialize;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Debug)]
pub(super) struct CitedImageContext {
    pub(super) workspace: PathBuf,
    pub(super) provider_id: Option<String>,
    pub(super) provider_session_id: Option<String>,
    pub(super) browser_captures: Option<PathBuf>,
    pub(super) attachments: Option<PathBuf>,
    pub(super) home: Option<PathBuf>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ResolveCitedChatImageRequest {
    target: String,
    workspace_path: Option<String>,
    provider_id: Option<String>,
    provider_session_id: Option<String>,
    session_id: Option<String>,
}

pub(super) fn resolve_cited_chat_image_request(
    request: ResolveCitedChatImageRequest,
) -> Result<Option<String>, String> {
    let paths = gyro_core::GyroPaths::for_current_user().map_err(|error| error.to_string())?;
    let attachments = request
        .session_id
        .as_deref()
        .filter(|id| safe_session_id(id))
        .map(|id| paths.sessions_dir.join("attachments").join(id));
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    let resolved = resolve_cited_chat_image(
        &request.target,
        &CitedImageContext {
            workspace: request
                .workspace_path
                .as_deref()
                .map(PathBuf::from)
                .unwrap_or_default(),
            provider_id: request.provider_id,
            provider_session_id: request.provider_session_id,
            browser_captures: Some(paths.browser_captures_dir),
            attachments,
            home,
        },
    );
    Ok(resolved.map(|path| path.display().to_string()))
}

/// Absolute path of a cited image, or `None` when the citation is not a file
/// Gyro should render.
pub(super) fn resolve_cited_chat_image(
    target: &str,
    context: &CitedImageContext,
) -> Option<PathBuf> {
    let candidate = cited_candidate(target)?;
    let roots = image_roots(context);
    match candidate {
        CitedCandidate::Relative(relative) => roots
            .iter()
            .find_map(|root| accept_image(root, &root.join(&relative))),
        CitedCandidate::Absolute(path) => roots.iter().find_map(|root| accept_image(root, &path)),
    }
}

enum CitedCandidate {
    Relative(PathBuf),
    Absolute(PathBuf),
}

fn cited_candidate(target: &str) -> Option<CitedCandidate> {
    let target = target.trim();
    if target.is_empty() || target.len() > 4096 || target.chars().any(char::is_control) {
        return None;
    }
    let lower = target.to_ascii_lowercase();
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("data:")
        || lower.starts_with("javascript:")
    {
        return None;
    }
    if lower.starts_with("file:") {
        let path = file_url_path(target)?;
        return image_extension(&path).then_some(CitedCandidate::Absolute(path));
    }
    if target.contains(':') {
        return None;
    }
    if Path::new(target).is_absolute() {
        let path = PathBuf::from(target);
        return image_extension(&path).then_some(CitedCandidate::Absolute(path));
    }
    let relative = safe_relative(target)?;
    image_extension(&relative).then_some(CitedCandidate::Relative(relative))
}

fn image_roots(context: &CitedImageContext) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if context.workspace.is_absolute() {
        roots.push(context.workspace.clone());
    }
    if context.provider_id.as_deref() == Some("xai") {
        if let (Some(home), Some(session)) = (
            context.home.as_ref(),
            context
                .provider_session_id
                .as_deref()
                .filter(|id| safe_session_id(id)),
        ) {
            if home.is_absolute() {
                for label in workspace_labels(&context.workspace) {
                    let encoded = encode_uri_component(&label);
                    if encoded.is_empty()
                        || encoded.contains('/')
                        || encoded.contains('\\')
                        || encoded == ".."
                    {
                        continue;
                    }
                    roots.push(
                        home.join(".grok")
                            .join("sessions")
                            .join(encoded)
                            .join(session),
                    );
                }
            }
        }
    }
    if let Some(dir) = &context.attachments {
        if dir.is_absolute() {
            roots.push(dir.clone());
        }
    }
    if let Some(dir) = &context.browser_captures {
        if dir.is_absolute() {
            roots.push(dir.clone());
        }
    }
    roots
}

fn workspace_labels(workspace: &Path) -> Vec<String> {
    let mut labels = Vec::new();
    if workspace.is_absolute() {
        if let Some(text) = workspace.to_str() {
            labels.push(text.to_string());
        }
        if let Ok(canonical) = workspace.canonicalize() {
            if let Some(text) = canonical.to_str() {
                if !labels.iter().any(|label| label == text) {
                    labels.push(text.to_string());
                }
            }
        }
    }
    labels
}

fn accept_image(root: &Path, candidate: &Path) -> Option<PathBuf> {
    let root = root.canonicalize().ok()?;
    if !fs::metadata(&root).ok()?.is_dir() {
        return None;
    }
    let canonical = candidate.canonicalize().ok()?;
    if !canonical.starts_with(&root) {
        return None;
    }
    let metadata = fs::metadata(&canonical).ok()?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > super::MAX_CHAT_IMAGE_BYTES {
        return None;
    }
    let mut header = [0_u8; 16];
    let mut file = fs::File::open(&canonical).ok()?;
    let read = file.read(&mut header).ok()?;
    super::validated_chat_media_type("cited", false, &header[..read]).ok()?;
    Some(canonical)
}

fn safe_relative(target: &str) -> Option<PathBuf> {
    let path = Path::new(target);
    if path.is_absolute() {
        return None;
    }
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                let text = part.to_str()?;
                if text.is_empty() || text == ".." || text.contains('\0') {
                    return None;
                }
                clean.push(part);
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    (!clean.as_os_str().is_empty()).then_some(clean)
}

fn safe_session_id(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn image_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "webp"
            )
        })
}

/// `encodeURIComponent` for the Grok session directory name. Unreserved
/// characters stay as themselves and every other byte is uppercase hex.
fn encode_uri_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => encoded.push(byte as char),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn file_url_path(target: &str) -> Option<PathBuf> {
    let rest = target.strip_prefix("file:")?;
    let rest = rest.strip_prefix("//").unwrap_or(rest);
    let path = rest.strip_prefix("localhost").unwrap_or(rest);
    if !path.starts_with('/') {
        return None;
    }
    let decoded = percent_decode(path)?;
    let path = PathBuf::from(decoded);
    path.is_absolute().then_some(path)
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return None;
            }
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok()?;
            decoded.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\ncited";

    fn context(workspace: &Path, home: &Path, provider: &str, session: &str) -> CitedImageContext {
        CitedImageContext {
            workspace: workspace.to_path_buf(),
            provider_id: Some(provider.into()),
            provider_session_id: Some(session.into()),
            browser_captures: None,
            attachments: None,
            home: Some(home.to_path_buf()),
        }
    }

    #[test]
    fn encodes_grok_workspace_directories_like_the_session_folder() {
        assert_eq!(
            encode_uri_component("/Users/wytze/Gyro"),
            "%2FUsers%2Fwytze%2FGyro"
        );
    }

    #[test]
    fn resolves_a_grok_session_image_and_workspace_images_for_every_provider() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("Gyro");
        let home = temp.path().join("home");
        let session = "01a1445d-a2ef-7421-9343-883299ce2c93";
        let grok_image = home
            .join(".grok")
            .join("sessions")
            .join(encode_uri_component(workspace.to_str().unwrap()))
            .join(session)
            .join("images")
            .join("composer.png");
        fs::create_dir_all(grok_image.parent().unwrap()).unwrap();
        fs::write(&grok_image, PNG).unwrap();
        let xai = context(&workspace, &home, "xai", session);
        let resolved = resolve_cited_chat_image("images/composer.png", &xai)
            .unwrap()
            .canonicalize()
            .unwrap();
        assert_eq!(resolved, grok_image.canonicalize().unwrap());

        let local = workspace.join("shots").join("panel.png");
        fs::create_dir_all(local.parent().unwrap()).unwrap();
        fs::write(&local, PNG).unwrap();
        for provider in [
            "anthropic",
            "cursor",
            "opencode",
            "mistral",
            "openrouter",
            "xai",
        ] {
            let resolved = resolve_cited_chat_image(
                "shots/panel.png",
                &context(&workspace, &home, provider, session),
            )
            .unwrap();
            assert_eq!(resolved, local.canonicalize().unwrap(), "{provider}");
        }
        // A provider that does not use Grok's session folder cannot see it.
        assert!(resolve_cited_chat_image(
            "images/composer.png",
            &context(&workspace, &home, "cursor", session),
        )
        .is_none());
        // The workspace copy wins when both places have the same relative path.
        let workspace_copy = workspace.join("images").join("composer.png");
        fs::create_dir_all(workspace_copy.parent().unwrap()).unwrap();
        fs::write(&workspace_copy, PNG).unwrap();
        assert_eq!(
            resolve_cited_chat_image("images/composer.png", &xai).unwrap(),
            workspace_copy.canonicalize().unwrap()
        );
    }

    #[test]
    fn rejects_paths_outside_the_allowed_roots() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("project");
        fs::create_dir_all(&workspace).unwrap();
        let home = temp.path().join("home");
        let outside = temp.path().join("secret.png");
        fs::write(&outside, PNG).unwrap();
        let session = "session-1";
        let image_context = context(&workspace, &home, "xai", session);
        assert!(resolve_cited_chat_image("../secret.png", &image_context).is_none());
        assert!(resolve_cited_chat_image(outside.to_str().unwrap(), &image_context).is_none());
        assert!(resolve_cited_chat_image("https://example.com/a.png", &image_context).is_none());
        assert!(resolve_cited_chat_image("images/composer.gif", &image_context).is_none());
        let text = workspace.join("notes.png");
        fs::write(&text, b"not an image").unwrap();
        assert!(resolve_cited_chat_image("notes.png", &image_context).is_none());

        #[cfg(unix)]
        {
            let link = workspace.join("leak.png");
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            assert!(resolve_cited_chat_image("leak.png", &image_context).is_none());
        }
    }

    #[test]
    fn resolves_browser_captures_and_session_attachments() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("project");
        fs::create_dir_all(&workspace).unwrap();
        let captures = temp.path().join("captures");
        let attachments = temp.path().join("attachments");
        fs::create_dir_all(&captures).unwrap();
        fs::create_dir_all(&attachments).unwrap();
        let capture = captures.join("browser-preview.png");
        let attachment = attachments.join("abc123.png");
        fs::write(&capture, PNG).unwrap();
        fs::write(&attachment, PNG).unwrap();
        let mut image_context = context(&workspace, temp.path(), "anthropic", "session-1");
        image_context.browser_captures = Some(captures);
        image_context.attachments = Some(attachments);
        assert_eq!(
            resolve_cited_chat_image("browser-preview.png", &image_context).unwrap(),
            capture.canonicalize().unwrap()
        );
        assert_eq!(
            resolve_cited_chat_image(capture.to_str().unwrap(), &image_context).unwrap(),
            capture.canonicalize().unwrap()
        );
        assert_eq!(
            resolve_cited_chat_image("abc123.png", &image_context).unwrap(),
            attachment.canonicalize().unwrap()
        );
    }

    #[test]
    fn resolves_the_reported_grok_composer_image_when_present() {
        let path = PathBuf::from(
            "/Users/wytze/.grok/sessions/%2FUsers%2Fwytze%2FGyro/01a1445d-a2ef-7421-9343-883299ce2c93/images/composer.png",
        );
        if !path.is_file() {
            return;
        }
        let resolved = resolve_cited_chat_image(
            "images/composer.png",
            &CitedImageContext {
                workspace: PathBuf::from("/Users/wytze/Gyro"),
                provider_id: Some("xai".into()),
                provider_session_id: Some("01a1445d-a2ef-7421-9343-883299ce2c93".into()),
                browser_captures: None,
                attachments: None,
                home: Some(PathBuf::from("/Users/wytze")),
            },
        );
        assert_eq!(
            resolved.and_then(|path| path.canonicalize().ok()),
            path.canonicalize().ok()
        );
    }
}
