//! Explicit debug fixture: production handlers and WebKit, isolated sessions/store.
use serde_json::json;
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

#[path = "browser_navigation_smoke.rs"]
mod navigation;

const REPORT_READY: &str = "GYRO_BROWSER_FRONTEND_SMOKE_READY";

fn persist_report(
    window: &tauri::WebviewWindow,
    path: &Path,
    csp: &str,
    sentinel: &Path,
    payload: &str,
) -> Result<bool, Box<dyn std::error::Error>> {
    if payload.len() > 64 * 1024 {
        return Err("report exceeds its byte budget".into());
    }
    let mut report: serde_json::Value = serde_json::from_str(payload)?;
    let object = report.as_object_mut().ok_or("expected a report object")?;
    object.insert("nativeCsp".into(), csp.into());
    object.insert(
        "nativeBuild".into(),
        "debug-embedded-tauri-production-handlers".into(),
    );
    object.insert(
        "reportTransport".into(),
        "native-evaluation-callback".into(),
    );
    let asset_scope = window.app_handle().asset_protocol_scope();
    let captures = object
        .get("captures")
        .and_then(|value| value.as_array())
        .map(|captures| {
            captures
                .iter()
                .filter_map(|capture| capture.get("path").and_then(|path| path.as_str()))
                .map(|path| json!({"path":path, "allowed":asset_scope.is_allowed(path)}))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    object.insert("captureAssetScope".into(), captures.into());
    object.insert(
        "workspaceAssetAllowed".into(),
        asset_scope.is_allowed(sentinel).into(),
    );
    let success = object.get("passed").and_then(|value| value.as_bool()) == Some(true);
    std::fs::write(path, serde_json::to_vec_pretty(&report)?)?;
    Ok(success)
}

pub(super) fn start(app: &AppHandle) -> Result<bool, Box<dyn std::error::Error>> {
    if std::env::var("GYRO_BROWSER_FRONTEND_SMOKE").as_deref() != Ok("1") {
        return Ok(false);
    }
    let data = PathBuf::from(std::env::var("GYRO_TEST_DATA_DIR")?).canonicalize()?;
    let temporary = std::env::temp_dir().canonicalize()?;
    let root = data.parent().ok_or("fixture data parent missing")?;
    if data != root.join("data")
        || !data.is_dir()
        || root == temporary
        || root == Path::new("/private/tmp")
        || !(root.starts_with(&temporary) || root.starts_with("/private/tmp"))
    {
        return Err(
            "native browser frontend fixture requires a temporary root/data directory".into(),
        );
    }
    let url = super::session_browser::parse_navigable_url(&std::env::var(
        "GYRO_BROWSER_FRONTEND_PAGE_URL",
    )?)?;
    if !super::session_browser::browser_url_is_loopback(&url) {
        return Err("native browser fixture page must be loopback".into());
    }
    let store = crate::stores::open_store()?;
    let mut sessions = Vec::new();
    for name in ["first", "second"] {
        let workspace = root.join("workspaces").join(name);
        std::fs::create_dir_all(&workspace)?;
        let session = store.create_session(
            &workspace,
            gyro_core::SessionOrigin::Desktop,
            "Native browser frontend fixture",
        )?;
        sessions.push(json!({"id":session.id, "workspaceKey":workspace}));
    }
    drop(store);
    let navigation_only = std::env::var("GYRO_BROWSER_NAVIGATION_SMOKE").as_deref() == Ok("1");
    let report_path = data.join(if navigation_only {
        "browser-navigation.json"
    } else {
        "browser-frontend.json"
    });
    let csp = app
        .config()
        .app
        .security
        .csp
        .as_ref()
        .ok_or("fixture CSP missing")?
        .to_string();
    let visual_review = std::env::var("GYRO_BROWSER_FRONTEND_VISUAL_REVIEW").as_deref() == Ok("1");
    let options = json!({"sessions":sessions, "pageUrl":url.as_str(), "visualReview":visual_review,"navigationOnly":navigation_only});
    let complete = Arc::new(AtomicBool::new(false));
    let callback_complete = complete.clone();
    let callback_path = report_path.clone();
    let workspace_sentinel = root.join("workspaces/first/sentinel.txt");
    std::fs::write(&workspace_sentinel, "isolated fixture asset scope sentinel")?;
    let requested = AtomicBool::new(false);
    WebviewWindowBuilder::new(
        app,
        "main",
        WebviewUrl::App("browser-events-native-smoke.html".into()),
    )
    .title("Gyro isolated native browser check")
    .inner_size(1100.0, 820.0)
    .incognito(true)
    .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
    .initialization_script(format!("window.__nativeBrowserEvents = {options};"))
    .on_navigation(|url| url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost"))
    .on_document_title_changed(move |window, title| {
        if let Some(progress) = title.strip_prefix("GYRO_BROWSER_CAPTURE_PROGRESS:") {
            if progress.len() < 2048 {
                let _ = std::fs::write(callback_path.with_file_name("progress.json"), progress);
            }
            return;
        }
        if matches!(
            title.as_str(),
            "GYRO_BROWSER_CAPTURE_REVIEW_READY" | "GYRO_BROWSER_CAPTURE_REVIEW_RECOVERED"
        ) {
            let name = if title.ends_with("RECOVERED") {
                "review-recovered.json"
            } else {
                "review-ready.json"
            };
            let _ = std::fs::write(
                callback_path.with_file_name(name),
                json!({"ready":true,"pid":std::process::id()}).to_string(),
            );
            return;
        }
        if title != REPORT_READY || requested.swap(true, Ordering::AcqRel) { return; }
        let complete = callback_complete.clone();
        let path = callback_path.clone();
        let csp = csp.clone();
        let sentinel = workspace_sentinel.clone();
        let receiver = window.clone();
        // A short title is only the ready signal. Read the bounded report using
        // the same native callback transport as production browser observations.
        if let Err(error) = window.eval_with_callback("JSON.parse(window.__nativeBrowserReport)", move |payload| {
            if complete.swap(true, Ordering::AcqRel) { return; }
            let result = persist_report(&receiver, &path, &csp, &sentinel, &payload);
            let passed = result.as_ref().is_ok_and(|passed| *passed);
            if let Err(error) = result {
                let _ = std::fs::write(&path, json!({"passed":false,"error":format!("native report receive failed: {error}")}).to_string());
            }
            receiver.app_handle().exit(if passed { 0 } else { 1 });
        }) {
            callback_complete.store(true, Ordering::Release);
            let _ = std::fs::write(&callback_path, json!({"passed":false,"error":format!("native report evaluation failed: {error}")}).to_string());
            window.app_handle().exit(1);
        }
    })
    .build()?;
    if navigation_only {
        navigation::start(
            app.clone(),
            url,
            sessions[0].clone(),
            report_path.clone(),
            complete.clone(),
        );
    }
    let timeout_app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(if visual_review { 360 } else { 90 }));
        if !complete.swap(true, Ordering::AcqRel) {
            let _ = std::fs::write(
                report_path,
                br#"{"passed":false,"error":"native browser frontend fixture timed out"}"#,
            );
            timeout_app.exit(1);
        }
    });
    Ok(true)
}
