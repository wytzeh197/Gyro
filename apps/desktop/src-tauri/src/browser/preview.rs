//! Browser preview checks and captures.

#[cfg(target_os = "macos")]
use crate::browser::types::BrowserPreviewSnapshot;
use crate::{
    session_browser, to_string, truncate_chars, BrowserPreviewAdmission, BrowserPreviewCapture,
    BrowserPreviewCaptureRequest, BrowserPreviewCheck, BrowserPreviewCheckRequest,
    BrowserPreviewDiagnostic, HiddenWebviewGuard, BROWSER_PREVIEW_CAPTURE_TIMEOUT,
    BROWSER_PREVIEW_DIAGNOSTIC_TIMEOUT, MAX_BROWSER_PREVIEW_CAPTURES,
    MAX_BROWSER_PREVIEW_CAPTURE_BYTES, MAX_BROWSER_PREVIEW_DIAGNOSTICS,
    MAX_BROWSER_PREVIEW_DIAGNOSTIC_CHARS, MAX_BROWSER_PREVIEW_DIAGNOSTIC_PAYLOAD_CHARS,
};
use gyro_core::GyroPaths;
use std::{fs, io::Write, path::Path, sync::mpsc, time::Duration};
use tauri::Manager;
use uuid::Uuid;

#[tauri::command]
pub(crate) async fn check_browser_preview(
    app: tauri::AppHandle,
    request: BrowserPreviewCheckRequest,
) -> Result<BrowserPreviewCheck, String> {
    let capture_request = request.clone();
    let mut check =
        tauri::async_runtime::spawn_blocking(move || check_browser_preview_blocking(request))
            .await
            .map_err(|error| format!("browser preview worker failed: {error}"))??;
    if check.reachable && check.diagnostics_supported {
        match capture_browser_preview_diagnostics(&app, &capture_request.url).await {
            Ok(diagnostics) => {
                check.diagnostics = diagnostics;
                check.diagnostics_captured = true;
            }
            Err(error) => {
                check.message = format!("{} · diagnostics unavailable", check.message);
                eprintln!(
                    "browser preview diagnostics unavailable: {}",
                    gyro_core::security::redact_secrets(&error)
                );
            }
        }
    }
    Ok(check)
}

pub(crate) fn check_browser_preview_blocking(
    request: BrowserPreviewCheckRequest,
) -> Result<BrowserPreviewCheck, String> {
    let mut current =
        url::Url::parse(request.url.trim()).map_err(|_| "invalid preview URL".to_string())?;
    if !matches!(current.scheme(), "http" | "https") {
        return Err("preview URLs must use http or https".into());
    }
    if current.host_str().is_none() {
        return Err("preview URL must include a host".into());
    }
    if !current.username().is_empty() || current.password().is_some() {
        return Err("preview URLs cannot include credentials".into());
    }
    if !browser_preview_diagnostics_supported(&current) {
        return Err("preview URLs must use localhost or a loopback IP address".into());
    }
    let approved_origin = current.origin().ascii_serialization();
    let diagnostics_supported = true;
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(2))
        .timeout_read(Duration::from_secs(2))
        .timeout_write(Duration::from_secs(2))
        .redirects(0)
        .build();
    for _ in 0..=5 {
        match agent.get(current.as_str()).call() {
            Ok(response) if (300..400).contains(&response.status()) => {
                let location = response
                    .header("location")
                    .ok_or_else(|| "preview redirect did not include a location".to_string())?;
                let next = current
                    .join(location)
                    .map_err(|_| "preview redirect URL is invalid".to_string())?;
                if !browser_preview_diagnostics_supported(&next)
                    || next.origin().ascii_serialization() != approved_origin
                {
                    return Err(
                        "preview redirects must stay on the approved loopback origin".into(),
                    );
                }
                current = next;
            }
            Ok(response) => {
                return Ok(BrowserPreviewCheck {
                    reachable: true,
                    status_code: Some(response.status()),
                    message: format!("Local preview reachable (HTTP {})", response.status()),
                    diagnostics: Vec::new(),
                    diagnostics_supported,
                    diagnostics_captured: false,
                })
            }
            Err(ureq::Error::Status(status, _)) => {
                return Ok(BrowserPreviewCheck {
                    reachable: true,
                    status_code: Some(status),
                    message: format!("Preview server reachable (HTTP {status})"),
                    diagnostics: Vec::new(),
                    diagnostics_supported,
                    diagnostics_captured: false,
                })
            }
            Err(ureq::Error::Transport(_)) => {
                return Ok(BrowserPreviewCheck {
                    reachable: false,
                    status_code: None,
                    message: "Preview unavailable: connection refused, timed out, or offline"
                        .into(),
                    diagnostics: Vec::new(),
                    diagnostics_supported,
                    diagnostics_captured: false,
                })
            }
        }
    }
    Err("preview redirected too many times".into())
}

pub(crate) fn browser_preview_diagnostics_supported(url: &url::Url) -> bool {
    // Diagnostics for the ephemeral capture webview stay loopback-only.
    // Session browser navigation uses session_browser::browser_url_is_navigable.
    session_browser::browser_url_is_navigable(url) && session_browser::browser_url_is_loopback(url)
}

pub(crate) fn browser_preview_capture_script(prefix: &str) -> Result<String, String> {
    let prefix = serde_json::to_string(prefix).map_err(to_string)?;
    Ok(format!(
        r#"(() => {{
  const prefix = {prefix};
  const diagnostics = [];
  const text = (value) => {{
    try {{
      if (value instanceof Error) return value.message || value.name;
      if (typeof value === "string") return value;
      const encoded = JSON.stringify(value);
      return encoded === undefined ? String(value) : encoded;
    }} catch (_) {{
      return String(value);
    }}
  }};
  const record = (kind, values, source, line, column) => {{
    if (diagnostics.length >= {MAX_BROWSER_PREVIEW_DIAGNOSTICS}) return;
    const message = values.map(text).join(" ").slice(0, {MAX_BROWSER_PREVIEW_DIAGNOSTIC_CHARS});
    if (!message) return;
    diagnostics.push({{
      kind,
      message,
      source: typeof source === "string" ? source : null,
      line: Number.isFinite(line) ? line : null,
      column: Number.isFinite(column) ? column : null,
    }});
  }};
  const originalError = console.error.bind(console);
  console.error = (...values) => {{
    record("console-error", values, null, null, null);
    originalError(...values);
  }};
  addEventListener("error", (event) => {{
    record("page-error", [event.message || "Page error"], event.filename, event.lineno, event.colno);
  }}, true);
  addEventListener("unhandledrejection", (event) => {{
    record("unhandled-rejection", [event.reason || "Unhandled promise rejection"], null, null, null);
  }}, true);
  let reported = false;
  const report = () => {{
    if (reported) return;
    reported = true;
    document.title = prefix + JSON.stringify(diagnostics);
  }};
  addEventListener("load", () => setTimeout(report, 750), {{ once: true }});
  setTimeout(report, 3000);
}})();"#
    ))
}

pub(crate) fn sanitize_browser_preview_source(source: Option<String>) -> Option<String> {
    let source = source?.trim().to_string();
    if source.is_empty() {
        return None;
    }
    let sanitized = match url::Url::parse(&source) {
        Ok(url) => url.path().to_string(),
        Err(_) => source,
    };
    Some(truncate_chars(
        &gyro_core::security::redact_secrets(&sanitized),
        MAX_BROWSER_PREVIEW_DIAGNOSTIC_CHARS,
    ))
}

pub(crate) fn parse_browser_preview_diagnostics(
    prefix: &str,
    title: &str,
) -> Option<Vec<BrowserPreviewDiagnostic>> {
    let payload = title.strip_prefix(prefix)?;
    if payload.chars().count() > MAX_BROWSER_PREVIEW_DIAGNOSTIC_PAYLOAD_CHARS {
        return None;
    }
    let diagnostics = serde_json::from_str::<Vec<BrowserPreviewDiagnostic>>(payload).ok()?;
    Some(
        diagnostics
            .into_iter()
            .take(MAX_BROWSER_PREVIEW_DIAGNOSTICS)
            .filter_map(|diagnostic| {
                let message = truncate_chars(
                    &gyro_core::security::redact_secrets(diagnostic.message.trim()),
                    MAX_BROWSER_PREVIEW_DIAGNOSTIC_CHARS,
                );
                if message.is_empty() {
                    return None;
                }
                let kind = match diagnostic.kind.as_str() {
                    "console-error" | "page-error" | "unhandled-rejection" => diagnostic.kind,
                    _ => "page-error".into(),
                };
                Some(BrowserPreviewDiagnostic {
                    kind,
                    message,
                    source: sanitize_browser_preview_source(diagnostic.source),
                    line: diagnostic.line,
                    column: diagnostic.column,
                })
            })
            .collect(),
    )
}

pub(crate) async fn capture_browser_preview_diagnostics(
    app: &tauri::AppHandle,
    raw_url: &str,
) -> Result<Vec<BrowserPreviewDiagnostic>, String> {
    let _admission = BrowserPreviewAdmission::acquire()?;
    let url = url::Url::parse(raw_url.trim()).map_err(|_| "invalid preview URL".to_string())?;
    if !browser_preview_diagnostics_supported(&url) {
        return Err("diagnostics are limited to loopback previews".into());
    }
    let token = Uuid::new_v4();
    let prefix = format!("gyro-browser-diagnostics:{token}:");
    let script = browser_preview_capture_script(&prefix)?;
    let (sender, receiver) = mpsc::channel();
    let callback_prefix = prefix.clone();
    let label = format!("browser-diagnostics-{token}");
    let window = tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::External(url))
        .title("Gyro browser diagnostics")
        .inner_size(1.0, 1.0)
        .visible(false)
        .skip_taskbar(true)
        .incognito(true)
        .devtools(false)
        .on_navigation(browser_preview_diagnostics_supported)
        .initialization_script(script)
        .on_document_title_changed(move |_window, title| {
            if title.starts_with(&callback_prefix) {
                let _ = sender.send(title);
            }
        })
        .build()
        .map_err(|error| format!("could not create diagnostic webview: {error}"))?;
    let window = HiddenWebviewGuard(window);
    let received = tauri::async_runtime::spawn_blocking(move || {
        receiver.recv_timeout(BROWSER_PREVIEW_DIAGNOSTIC_TIMEOUT)
    })
    .await
    .map_err(|error| format!("browser diagnostic worker failed: {error}"))?;
    let _ = window.close();
    let title = received.map_err(|_| "browser diagnostic capture timed out".to_string())?;
    parse_browser_preview_diagnostics(&prefix, &title)
        .ok_or_else(|| "browser diagnostic payload was invalid".to_string())
}

#[tauri::command]
pub(crate) async fn capture_session_browser_preview(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<BrowserPreviewCapture, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let manager = app.state::<session_browser::SessionBrowserManager>();
        let owned = manager
            .get_snapshot(&session_id)?
            .ok_or_else(|| "this chat has no open browser".to_string())?;
        let before =
            session_browser::call_agent(&app, &session_id, "status", serde_json::json!({}))?;
        let screenshot = session_browser::capture_session_browser_png(&app, &session_id)?;
        let after =
            session_browser::call_agent(&app, &session_id, "status", serde_json::json!({}))?;
        let current = manager
            .get_snapshot(&session_id)?
            .ok_or_else(|| "browser closed during capture".to_string())?;
        if current.resource_id != owned.resource_id
            || current.navigation_id != owned.navigation_id
            || before.get("url") != after.get("url")
            || before.pointer("/navigation/id") != after.pointer("/navigation/id")
            || before.get("viewport") != after.get("viewport")
        {
            return Err("browser changed during capture; take a new screenshot".into());
        }
        let paths = GyroPaths::for_current_user().map_err(to_string)?;
        let mut capture = persist_browser_preview_capture(
            &paths,
            &screenshot.png,
            screenshot.width,
            screenshot.height,
            chrono::Utc::now(),
        )?;
        let url = after
            .get("url")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "browser capture has no URL".to_string())?
            .to_string();
        let viewport = after
            .get("viewport")
            .cloned()
            .ok_or_else(|| "browser capture has no viewport".to_string())?;
        manager.remember_pointer_capture_at_navigation(
            &session_id,
            owned.navigation_id,
            capture.filename.clone(),
            url.clone(),
            viewport.clone(),
        )?;
        capture.source_url = Some(url);
        capture.title = after
            .get("title")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        capture.resource_id = Some(owned.resource_id);
        capture.viewport = Some(viewport);
        Ok(capture)
    })
    .await
    .map_err(|error| format!("browser capture worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn capture_browser_preview(
    app: tauri::AppHandle,
    request: BrowserPreviewCaptureRequest,
) -> Result<BrowserPreviewCapture, String> {
    let _admission = BrowserPreviewAdmission::acquire()?;
    let url = url::Url::parse(request.url.trim()).map_err(|_| "invalid preview URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("preview URL must use http or https and include a host".into());
    }
    if !browser_preview_diagnostics_supported(&url) {
        return Err("screenshots are limited to local loopback previews".into());
    }
    let (width, height) = browser_preview_capture_dimensions(&request.device)?;

    #[cfg(target_os = "macos")]
    {
        let token = Uuid::new_v4();
        let label = format!("browser-capture-{token}");
        let (load_sender, load_receiver) = mpsc::channel();
        let window =
            tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::External(url))
                .title("Gyro browser capture")
                .inner_size(width as f64, height as f64)
                .visible(false)
                .focused(false)
                .skip_taskbar(true)
                .incognito(true)
                .devtools(false)
                .on_navigation(browser_preview_diagnostics_supported)
                .on_page_load(move |_window, payload| {
                    if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                        let _ = load_sender.send(());
                    }
                })
                .build()
                .map_err(|error| format!("could not create browser capture webview: {error}"))?;
        let window = HiddenWebviewGuard(window);

        let loaded = tauri::async_runtime::spawn_blocking(move || {
            load_receiver.recv_timeout(BROWSER_PREVIEW_CAPTURE_TIMEOUT)
        })
        .await
        .map_err(|error| format!("browser capture load worker failed: {error}"))?;
        if loaded.is_err() {
            let _ = window.close();
            return Err("browser preview did not finish loading before capture".into());
        }

        tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(300)))
            .await
            .map_err(|error| format!("browser capture settle worker failed: {error}"))?;
        let snapshot = capture_macos_browser_preview_snapshot(&window).await;
        let _ = window.close();
        let snapshot = snapshot?;
        let paths = GyroPaths::for_current_user().map_err(to_string)?;
        let created_at = chrono::Utc::now();
        tauri::async_runtime::spawn_blocking(move || {
            persist_browser_preview_capture(
                &paths,
                &snapshot.png,
                snapshot.width,
                snapshot.height,
                created_at,
            )
        })
        .await
        .map_err(|error| format!("browser capture writer failed: {error}"))?
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, width, height);
        Err("browser screenshots are currently available on macOS only".into())
    }
}

pub(crate) fn browser_preview_capture_dimensions(device: &str) -> Result<(u32, u32), String> {
    match device {
        "desktop" => Ok((1440, 900)),
        "tablet" => Ok((834, 1112)),
        "mobile" => Ok((390, 844)),
        _ => Err("unknown browser preview device".into()),
    }
}

#[cfg(target_os = "macos")]
pub(crate) async fn capture_macos_browser_preview_snapshot(
    window: &tauri::WebviewWindow,
) -> Result<BrowserPreviewSnapshot, String> {
    let (sender, receiver) = mpsc::channel();
    window
        .with_webview(move |webview| unsafe {
            use block2::RcBlock;
            use objc2::runtime::AnyObject;
            use objc2_app_kit::{
                NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSImage,
            };
            use objc2_foundation::{NSDictionary, NSError};
            use objc2_web_kit::WKWebView;

            let view: &WKWebView = &*webview.inner().cast();
            let completion = RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
                let snapshot = (|| {
                    let image = image
                        .as_ref()
                        .ok_or_else(|| "native browser snapshot returned no image".to_string())?;
                    let tiff = image.TIFFRepresentation().ok_or_else(|| {
                        "native browser snapshot could not be encoded".to_string()
                    })?;
                    let bitmap = NSBitmapImageRep::imageRepWithData(&tiff).ok_or_else(|| {
                        "native browser snapshot could not create a bitmap".to_string()
                    })?;
                    let properties = NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::new();
                    let png = bitmap
                        .representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)
                        .ok_or_else(|| {
                            "native browser snapshot could not create PNG data".to_string()
                        })?;
                    if png.len() > MAX_BROWSER_PREVIEW_CAPTURE_BYTES {
                        return Err("browser screenshot exceeded the capture size limit".into());
                    }
                    Ok(BrowserPreviewSnapshot {
                        png: png.to_vec(),
                        width: bitmap.pixelsWide().max(0) as u32,
                        height: bitmap.pixelsHigh().max(0) as u32,
                    })
                })();
                let _ = sender.send(snapshot);
            });
            view.takeSnapshotWithConfiguration_completionHandler(None, &completion);
        })
        .map_err(|error| format!("could not request native browser snapshot: {error}"))?;

    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(BROWSER_PREVIEW_CAPTURE_TIMEOUT)
            .map_err(|_| "native browser screenshot timed out".to_string())?
    })
    .await
    .map_err(|error| format!("browser screenshot worker failed: {error}"))?
}

pub(crate) fn persist_browser_preview_capture(
    paths: &GyroPaths,
    png: &[u8],
    width: u32,
    height: u32,
    created_at: chrono::DateTime<chrono::Utc>,
) -> Result<BrowserPreviewCapture, String> {
    const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if !png.starts_with(PNG_SIGNATURE) {
        return Err("browser screenshot did not contain valid PNG data".into());
    }
    if png.len() > MAX_BROWSER_PREVIEW_CAPTURE_BYTES {
        return Err("browser screenshot exceeded the capture size limit".into());
    }
    ensure_private_browser_capture_directory(&paths.browser_captures_dir)?;
    let timestamp = created_at.format("%Y%m%dT%H%M%S%3fZ");
    let filename = format!("browser-preview-{timestamp}-{}.png", Uuid::new_v4());
    let path = paths.browser_captures_dir.join(&filename);
    let temporary_path = paths
        .browser_captures_dir
        .join(format!(".gyro-browser-capture-{}.tmp", Uuid::new_v4()));

    let write_result = (|| -> Result<(), String> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary_path).map_err(to_string)?;
        file.write_all(png).map_err(to_string)?;
        file.sync_all().map_err(to_string)?;
        fs::rename(&temporary_path, &path).map_err(to_string)?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary_path);
        return Err(format!("could not save browser screenshot: {error}"));
    }
    if let Err(error) = prune_browser_preview_captures(&paths.browser_captures_dir) {
        let _ = fs::remove_file(&path);
        return Err(error);
    }

    Ok(BrowserPreviewCapture {
        path: path.to_string_lossy().into_owned(),
        filename,
        width,
        height,
        created_at: created_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        source_url: None,
        title: None,
        resource_id: None,
        viewport: None,
    })
}

pub(crate) fn ensure_private_browser_capture_directory(directory: &Path) -> Result<(), String> {
    if let Ok(metadata) = fs::symlink_metadata(directory) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("browser capture storage path is unsafe".into());
        }
    } else {
        fs::create_dir_all(directory).map_err(to_string)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).map_err(to_string)?;
    }
    Ok(())
}

pub(crate) fn prune_browser_preview_captures(directory: &Path) -> Result<(), String> {
    let mut captures = fs::read_dir(directory)
        .map_err(to_string)?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let filename = entry.file_name().to_string_lossy().into_owned();
            let file_type = entry.file_type().ok()?;
            (file_type.is_file()
                && filename.starts_with("browser-preview-")
                && filename.ends_with(".png"))
            .then_some((filename, entry.path()))
        })
        .collect::<Vec<_>>();
    captures.sort_by(|left, right| right.0.cmp(&left.0));
    for (_, path) in captures.into_iter().skip(MAX_BROWSER_PREVIEW_CAPTURES) {
        fs::remove_file(path).map_err(to_string)?;
    }
    Ok(())
}
