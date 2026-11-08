//! Opt-in native regression check. Runs without provider calls or user data.
//! GYRO_BROWSER_SMOKE_URL must point to scripts/fixtures/browser-observation.html
//! served on loopback; GYRO_TEST_DATA_DIR receives the report and native PNG.
use crate::browser_pointer;
#[path = "browser_viewport_smoke.rs"]
mod viewport;
use crate::session_browser::*;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

/// The fixture owns this isolated window. Activate it immediately before OS
/// input, after startup and page loading have finished; setup-time activation
/// alone can be lost while AppKit finishes launching the bare debug binary.
pub(super) fn prepare_mouse(app: &AppHandle) -> Result<(), String> {
    let owned_app = app.clone();
    let (sender, receiver) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let result = (|| -> Result<(), String> {
            #[cfg(target_os = "macos")]
            {
                let mtm = objc2::MainThreadMarker::new()
                    .ok_or("native browser smoke activation left the main thread")?;
                #[allow(deprecated)]
                objc2_app_kit::NSApplication::sharedApplication(mtm)
                    .activateIgnoringOtherApps(true);
            }
            let window = owned_app
                // Adding the browser child turns this into a multi-webview
                // window, so it is no longer a WebviewWindow facade.
                .get_window("main")
                .ok_or("native browser smoke window disappeared")?;
            window.show().map_err(|error| error.to_string())?;
            window.set_focus().map_err(|error| error.to_string())
        })();
        let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(3))
        .map_err(|error| format!("native browser smoke activation timed out: {error}"))?
}

pub fn start(app: &AppHandle) -> Result<bool, Box<dyn std::error::Error>> {
    let Ok(url) = std::env::var("GYRO_BROWSER_SMOKE_URL") else {
        return Ok(false);
    };
    let output = PathBuf::from(std::env::var("GYRO_TEST_DATA_DIR")?);
    if !output.is_absolute() || !browser_url_is_loopback(&parse_navigable_url(&url)?) {
        return Err("native browser smoke requires isolated data and a loopback fixture".into());
    }
    std::fs::create_dir_all(&output)?;
    // The test explicitly owns this isolated window. Production mouse actions
    // refuse to activate Gyro, so establish their foreground precondition here.
    #[cfg(target_os = "macos")]
    {
        let mtm = objc2::MainThreadMarker::new()
            .ok_or("native browser smoke must start on the main thread")?;
        // Test-only: a bare debug binary does not receive Launch Services'
        // activation. Focusing its window alone leaves NSApp inactive.
        #[allow(deprecated)]
        objc2_app_kit::NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
    }
    if let Some(window) = app.get_webview_window("main") {
        window.show()?;
        window.set_focus()?;
    }

    let app = app.clone();
    std::thread::spawn(move || {
        let result = run(&app, &url, &output);
        let report = match &result {
            Ok(steps) => json!({"ok": true, "steps": steps}),
            Err(error) => json!({"ok": false, "error": error}),
        };
        let _ = std::fs::write(output.join("browser-smoke.json"), report.to_string());
        eprintln!("Browser smoke: {report}");
        app.exit(if result.is_ok() { 0 } else { 1 });
    });
    Ok(true)
}

fn run(app: &AppHandle, url: &str, output: &std::path::Path) -> Result<Vec<String>, String> {
    let store = crate::stores::open_store()?;
    let parent = store
        .create_session(
            output,
            gyro_core::SessionOrigin::Desktop,
            "Native browser smoke",
        )
        .map_err(crate::stores::to_string)?;
    let session_id = parent.id.to_string();
    let session = session_id.as_str();
    let mut steps = Vec::new();
    open_session_browser(
        app,
        SessionBrowserOpenRequest {
            session_id: session.into(),
            workspace_key: output.display().to_string(),
            url: url.into(),
            bounds: Some(SessionBrowserBounds {
                x: 20.,
                y: 90.,
                width: 800.,
                height: 650.,
            }),
            visible: Some(true),
        },
    )?;
    let wait_page = |expected: &str| -> Result<Value, String> {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Ok(page) = call_agent(app, session, "readPage", json!({"maxDepth":8})) {
                if page.to_string().contains(expected) {
                    return Ok(page);
                }
            }
            if Instant::now() > deadline {
                let current = call_agent(app, session, "readPage", json!({"maxDepth":8}))
                    .map(|page| page.to_string())
                    .unwrap_or_else(|error| format!("page read failed: {error}"));
                return Err(format!(
                    "page never showed {expected}; current page: {current}"
                ));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    let wait_url = |expected: &str| -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Ok(state) = call_agent(app, session, "status", json!({})) {
                if state["url"] == expected && state["readyState"] == "complete" {
                    return Ok(());
                }
            }
            if Instant::now() > deadline {
                return Err(format!("navigation never reached {expected}"));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    let call = |method: &str, args: Value| -> Result<Value, String> {
        let result = call_agent(app, session, method, args)?;
        if result["ok"] != true {
            return Err(format!("{method}: {result}"));
        }
        Ok(result)
    };
    let find = |selector: &str| -> Result<String, String> {
        let result = call("find", json!({"selector": selector}))?;
        result["results"][0]["ref"]
            .as_str()
            .map(String::from)
            .ok_or_else(|| format!("missing {selector}: {result}"))
    };
    let point = |selector: &str| -> Result<(f64, f64), String> {
        let result = call("find", json!({"selector": selector}))?;
        let rect = &result["results"][0]["rect"];
        let x = rect["x"]
            .as_f64()
            .ok_or_else(|| format!("missing {selector} X"))?;
        let y = rect["y"]
            .as_f64()
            .ok_or_else(|| format!("missing {selector} Y"))?;
        let width = rect["width"]
            .as_f64()
            .ok_or_else(|| format!("missing {selector} width"))?;
        let height = rect["height"]
            .as_f64()
            .ok_or_else(|| format!("missing {selector} height"))?;
        Ok((x + width / 2.0, y + height / 2.0))
    };
    let mouse_enabled = std::env::var("GYRO_BROWSER_SMOKE_SKIP_MOUSE").as_deref() != Ok("1");
    steps.extend(viewport::run(app, session, url, output, mouse_enabled)?);
    wait_page("Browser observation ready")?;
    steps.push("open/read".into());
    // A second read used to clear the map but retain invalid refs on elements.
    wait_page("Browser observation ready")?;
    let button = find("#change-state")?;
    // Simulate a busy native event queue. Stop must release the model worker
    // promptly, and the queued click must still be skipped when the queue drains.
    let (blocked, ready) = std::sync::mpsc::channel();
    let (release, unblock) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = blocked.send(());
        let _ = unblock.recv_timeout(Duration::from_secs(2));
    })
    .map_err(|error| error.to_string())?;
    ready
        .recv_timeout(Duration::from_secs(2))
        .map_err(|error| error.to_string())?;
    let token = gyro_core::CancellationToken::default();
    let operation =
        begin_model_operation(gyro_core::CapabilityId::BrowserClick, token.clone()).unwrap();
    let (stopped, stop_time) = std::sync::mpsc::channel();
    let canceller = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(20));
        let at = Instant::now();
        token.cancel();
        let _ = stopped.send(at);
    });
    let cancelled = call_agent(app, session, "click", json!({"ref":button}));
    let returned = Instant::now();
    drop(operation);
    let _ = release.send(());
    let _ = canceller.join();
    let cancelled_at = stop_time.recv().map_err(|error| error.to_string())?;
    let cancellation_latency = returned.saturating_duration_since(cancelled_at);
    if !cancelled
        .as_ref()
        .err()
        .is_some_and(|error| operation_was_cancelled(error))
        || cancellation_latency >= Duration::from_secs(1)
    {
        return Err(format!(
            "queued browser cancellation failed: {cancelled:?}, latency {cancellation_latency:?}"
        ));
    }
    let count = find("#click-count")?;
    if !call("readPage", json!({"ref":count}))?
        .to_string()
        .contains("Clicks: 0")
    {
        return Err("a cancelled queued click changed the page".into());
    }
    std::fs::write(
        output.join("browser-cancellation.json"),
        json!({
            "cancellationToReturnMs":cancellation_latency.as_secs_f64() * 1000.0,
            "queuedClickSkipped":true,
            "engine":"WKWebView",
        })
        .to_string(),
    )
    .map_err(|error| error.to_string())?;
    steps.push("Stop releases a queued browser call and suppresses its late click".into());
    let previous_resource = app
        .state::<SessionBrowserManager>()
        .get_snapshot(session)?
        .ok_or("browser disappeared before replacement")?;
    let previous_owner = crate::state::provider_run::ModelBrowserResource {
        resource_id: previous_resource.resource_id.clone(),
        session_id: session.into(),
        turn_id: None,
        call_id: uuid::Uuid::new_v4(),
        workspace_key: output.display().to_string(),
        url: previous_resource.url.clone(),
    };
    close_session_browser(app, session)?;
    if crate::capabilities::access::browser_observation(
        app,
        &previous_owner,
        &json!({}),
        None,
        None,
        Vec::new(),
        Vec::new(),
    )
    .is_ok()
    {
        return Err("an observation was accepted after its browser closed".into());
    }
    let replacement = open_session_browser(
        app,
        SessionBrowserOpenRequest {
            session_id: session.into(),
            workspace_key: output.display().to_string(),
            url: url.into(),
            bounds: Some(SessionBrowserBounds {
                x: 20.,
                y: 90.,
                width: 800.,
                height: 650.,
            }),
            visible: Some(true),
        },
    )?;
    wait_page("Browser observation ready")?;
    if crate::capabilities::access::browser_observation(
        app,
        &previous_owner,
        &json!({}),
        None,
        None,
        Vec::new(),
        Vec::new(),
    )
    .is_ok()
    {
        return Err("an observation was accepted from a replaced browser".into());
    }
    if replacement.resource_id == previous_resource.resource_id {
        return Err("reopened browser retained the previous resource ID".into());
    }
    let stale_operation = begin_model_operation(
        gyro_core::CapabilityId::BrowserClick,
        gyro_core::CancellationToken::default(),
    )
    .unwrap();
    bind_model_resource(&previous_resource.resource_id)?;
    let stale_click = call_agent(app, session, "click", json!({"ref":button}));
    drop(stale_operation);
    if !stale_click
        .as_ref()
        .err()
        .is_some_and(|error| error.contains("browser resource changed"))
    {
        return Err(format!(
            "stale model operation reached a reopened browser: {stale_click:?}"
        ));
    }
    wait_page("Clicks: 0")?;
    std::fs::write(
        output.join("browser-replacement.json"),
        json!({
            "resourceChanged":true,
            "staleModelClickRejected":true,
            "closedObservationRejected":true,
            "replacementObservationRejected":true,
            "replacementClickCount":0,
            "engine":"WKWebView",
        })
        .to_string(),
    )
    .map_err(|error| error.to_string())?;
    steps.push("close/reopen rejects a stale model operation before its click".into());
    let button = find("#change-state")?;
    let form = find("#safe-form")?;
    call("readPage", json!({"ref":form,"maxDepth":8}))?;
    let labelled = call("find", json!({"query":"Project name"}))?;
    if !labelled["results"].as_array().is_some_and(|results| {
        results
            .iter()
            .any(|item| item["tag"] == "input" && item["name"] == "Project name")
    }) {
        return Err(format!(
            "associated label did not locate its input: {labelled}"
        ));
    }
    let select = find("#project-kind")?;
    if call_agent(
        app,
        session,
        "formInput",
        json!({"ref":select,"value":"missing"}),
    )
    .is_ok()
    {
        return Err("a missing select option was accepted".into());
    }
    steps.push("label lookup/subtree reference preservation/invalid select rejection".into());
    let clicked = call("click", json!({"ref":button,"actor":"Codex"}))?;
    if clicked["name"] != "Change visible state" {
        return Err(format!("click did not name its element: {clicked}"));
    }
    find("[data-gyro-browser-pointer]")?;
    call("hidePointer", json!({}))?;
    let hidden = call("find", json!({"selector":"[data-gyro-browser-pointer]"}))?;
    if hidden["results"]
        .as_array()
        .is_some_and(|items| !items.is_empty())
    {
        return Err("AI cursor was not hidden for capture".into());
    }
    call("restorePointer", json!({}))?;
    find("[data-gyro-browser-pointer]")?;
    steps.push("AI cursor visible after click; capture hide/restore".into());
    // The action highlight is for the person watching; capture it, then clear.
    let highlighted = capture_session_browser_png(app, session)?;
    std::fs::write(output.join("browser-smoke-highlight.png"), highlighted.png)
        .map_err(|e| e.to_string())?;
    call("clearHighlight", json!({}))?;
    let page = wait_page("Clicks: 1")?;
    if page.to_string().contains("Clicks: 2") {
        return Err("click fired twice".into());
    }
    steps.push("repeat read/find/click exactly once/read changed state".into());
    if mouse_enabled {
        let _pointer_capture = capture_session_browser_png(app, session)?;
        let pointer_status = call("status", json!({}))?;
        let pointer_url = pointer_status["url"]
            .as_str()
            .ok_or("missing pointer URL")?;
        let pointer_viewport = pointer_status["viewport"]
            .as_object()
            .ok_or("missing pointer viewport")?;
        app.state::<SessionBrowserManager>()
            .remember_pointer_capture(
                session,
                "native-smoke-pointer.png".into(),
                pointer_url.into(),
                Value::Object(pointer_viewport.clone()),
            )?;
        let mouse = |action: &str, x: f64, y: f64, to_x: f64, to_y: f64| -> Result<(), String> {
            prepare_mouse(app)?;
            let outcome = browser_pointer::execute(
                app,
                session,
                "Claude",
                &json!({
                    "action": action,
                    "captureId": "native-smoke-pointer.png",
                    "x": x,
                    "y": y,
                    "toX": to_x,
                    "toY": to_y,
                }),
            )?;
            if outcome.action != action {
                return Err("browser mouse returned the wrong action".into());
            }
            Ok(())
        };
        let (hover_x, hover_y) = point("#hover-trigger")?;
        let pointer_target = call("pointerTarget", json!({"x":hover_x,"y":hover_y}))?;
        if pointer_target["name"] != "Hover target" {
            return Err(format!(
                "pointer coordinates missed hover target: {pointer_target}"
            ));
        }
        if browser_pointer::execute(
            app,
            session,
            "Model",
            &json!({"action":"hover","captureId":"stale","x":hover_x,"y":hover_y}),
        )
        .is_ok()
        {
            return Err("stale pointer capture was accepted".into());
        }
        mouse("hover", hover_x, hover_y, hover_x, hover_y)?;
        wait_page("Hover: open")?;
        let pointer_highlight = capture_session_browser_png(app, session)?;
        std::fs::write(
            output.join("browser-smoke-mouse-highlight.png"),
            pointer_highlight.png,
        )
        .map_err(|e| e.to_string())?;
        call("clearHighlight", json!({}))?;
        mouse("secondary-click", hover_x, hover_y, hover_x, hover_y)?;
        wait_page("Context: opened")?;
        let (canvas_x, canvas_y) = point("#pointer-canvas")?;
        mouse("click", canvas_x, canvas_y, canvas_x, canvas_y)?;
        wait_page("Canvas: clicked")?;
        let (drag_x, drag_y) = point("#drag-handle")?;
        let (drop_x, drop_y) = point("#drop-zone")?;
        mouse("drag", drag_x, drag_y, drop_x, drop_y)?;
        wait_page("Drag: completed")?;
        steps.push("native hover/secondary-click/canvas click/drag".into());
    } else {
        steps.push("SKIPPED native OS mouse: GYRO_BROWSER_SMOKE_SKIP_MOUSE=1".into());
    }
    let input = find("#project-name")?;
    let typed = call(
        "type",
        json!({"ref":input,"text":"Native smoke","submit":true}),
    )?;
    if typed["name"] != "Project name" {
        return Err(format!("type did not name its element: {typed}"));
    }
    wait_page("Form: saved Native smoke")?;
    steps.push("type/submit/read saved value".into());
    steps.push("click/type/formInput name their elements; highlight captured".into());
    let credential = find("#fixture-password")?;
    if call_agent(
        app,
        session,
        "type",
        json!({"ref":credential,"text":"blocked"}),
    )
    .is_ok()
    {
        return Err("credential write was not rejected".into());
    }
    if call_agent(
        app,
        session,
        "type",
        json!({"ref":"stale","text":"wrong target"}),
    )
    .is_ok()
    {
        return Err("stale ref was not rejected".into());
    }
    steps.push("credential and stale-ref rejection".into());
    let select = find("#project-kind")?;
    let selected = call("formInput", json!({"ref":select,"value":"app"}))?;
    if selected["name"] != "Project kind" {
        return Err(format!("formInput did not name its element: {selected}"));
    }
    let checkbox = find("#project-enabled")?;
    call("formInput", json!({"ref":checkbox,"value":"true"}))?;
    wait_page("Kind: app; enabled: true")?;
    call("scroll", json!({"dy":600}))?;
    let status = call("status", json!({}))?;
    if status["viewport"]["scrollY"].as_i64().unwrap_or(0) <= 0 {
        return Err("scroll did not move".into());
    }
    call("scroll", json!({"dy":-10000}))?;
    steps.push("select/checkbox/scroll/status".into());
    let capture = capture_session_browser_png(app, session)?;
    if capture.width < 100 || capture.height < 100 || !capture.png.starts_with(b"\x89PNG") {
        return Err("invalid native screenshot".into());
    }
    std::fs::write(output.join("browser-smoke.png"), capture.png).map_err(|e| e.to_string())?;
    steps.push(format!(
        "native screenshot {}x{}",
        capture.width, capture.height
    ));
    let console = call("console", json!({}))?;
    if !console.to_string().contains("gyro-browser-fixture-ready") {
        return Err("console missing".into());
    }
    let network = call("network", json!({}))?;
    if !network
        .to_string()
        .contains("__gyro_missing_network_fixture__")
    {
        return Err("page network request missing".into());
    }
    if network.to_string().contains("gyro-bridge://") {
        return Err("bridge recursively logs itself".into());
    }
    steps.push("console/network without bridge recursion".into());
    navigate_session_browser(app, session, &format!("{url}?second=1"))?;
    wait_url(&format!("{url}?second=1"))?;
    wait_page("State: initial")?;
    history_session_browser(app, session, "back")?;
    wait_url(url)?;
    wait_page("Browser observation ready")?;
    history_session_browser(app, session, "forward")?;
    wait_url(&format!("{url}?second=1"))?;
    wait_page("Browser observation ready")?;
    let button = find("#change-state")?;
    call("click", json!({"ref": button}))?;
    wait_page("State: changed")?;
    reload_session_browser(app, session)?;
    wait_page("State: initial")?;
    let snapshot = app
        .state::<SessionBrowserManager>()
        .get_snapshot(session)?
        .unwrap();
    if snapshot.title != "Gyro Browser Observation Fixture" {
        return Err(format!("missing title: {}", snapshot.title));
    }
    steps.push("navigate/back/forward/reload/title".into());
    close_session_browser(app, session)?;
    if app
        .state::<SessionBrowserManager>()
        .get_snapshot(session)?
        .is_some()
    {
        return Err("browser did not close".into());
    }
    steps.push("close".into());
    steps.push(run_background(app, url, output, parent.id)?);
    Ok(steps)
}

/// A browser the user never opened: no bounds, no visibility, driven entirely
/// through the agent bridge. This is how a model browses while the chat is in
/// split view, so the whole observe/act/capture loop has to work with nothing
/// on screen — a 1x1 child webview used to make every one of these steps lie.
fn run_background(
    app: &AppHandle,
    url: &str,
    output: &std::path::Path,
    parent_id: uuid::Uuid,
) -> Result<String, String> {
    let store = crate::stores::open_store()?;
    let child = store
        .create_subagent_session(
            output,
            gyro_core::SessionOrigin::Desktop,
            "Native background browser smoke",
            gyro_core::CreateSessionContext::default(),
            parent_id,
        )
        .map_err(crate::stores::to_string)?;
    let session_id = child.id.to_string();
    let session = session_id.as_str();
    let snapshot = open_session_browser(
        app,
        SessionBrowserOpenRequest {
            session_id: session.into(),
            workspace_key: output.display().to_string(),
            url: url.into(),
            bounds: None,
            visible: None,
        },
    )?;
    if snapshot.visible {
        return Err("a browser opened without bounds must stay hidden".into());
    }
    let deadline = Instant::now() + Duration::from_secs(15);
    let page = loop {
        if let Ok(page) = call_agent(app, session, "readPage", json!({"maxDepth":8})) {
            if page.to_string().contains("Browser observation ready") {
                break page;
            }
        }
        if Instant::now() > deadline {
            return Err("hidden page never became readable".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let _ = page;
    let status = call_agent(app, session, "status", json!({}))?;
    let width = status["viewport"]["width"].as_f64().unwrap_or_default();
    let height = status["viewport"]["height"].as_f64().unwrap_or_default();
    if width < 1000. || height < 600. {
        return Err(format!(
            "hidden browser reported a {width}x{height} viewport; pages need a real one"
        ));
    }
    let found = call_agent(app, session, "find", json!({"selector":"#change-state"}))?;
    let reference = found["results"][0]["ref"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| format!("hidden page could not locate its button: {found}"))?;
    let clicked = call_agent(app, session, "click", json!({"ref": reference}))?;
    if clicked["ok"] != true {
        return Err(format!("hidden click failed: {clicked}"));
    }
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(page) = call_agent(app, session, "readPage", json!({"maxDepth":8})) {
            if page.to_string().contains("State: changed") {
                break;
            }
        }
        if Instant::now() > deadline {
            return Err("hidden click never changed the page".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = call_agent(app, session, "clearHighlight", json!({}));
    let capture = capture_session_browser_png(app, session)?;
    if capture.width < 100 || capture.height < 100 || !capture.png.starts_with(b"\x89PNG") {
        return Err(format!(
            "hidden browser captured {}x{}; a background screenshot must be real",
            capture.width, capture.height
        ));
    }
    let capture_size = format!("{}x{}", capture.width, capture.height);
    std::fs::write(output.join("browser-smoke-background.png"), capture.png)
        .map_err(|e| e.to_string())?;
    close_session_browser(app, session)?;
    Ok(format!(
        "background open/read/find/click/read/capture at {width}x{height}, screenshot {capture_size}"
    ))
}
