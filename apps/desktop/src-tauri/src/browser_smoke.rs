//! Opt-in native regression check. Runs without provider calls or user data.
//! GYRO_BROWSER_SMOKE_URL must point to scripts/fixtures/browser-observation.html
//! served on loopback; GYRO_TEST_DATA_DIR receives the report and native PNG.
use crate::browser_pointer;
use crate::session_browser::*;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

pub fn start(app: &AppHandle) -> Result<bool, Box<dyn std::error::Error>> {
    let Ok(url) = std::env::var("GYRO_BROWSER_SMOKE_URL") else {
        return Ok(false);
    };
    let output = PathBuf::from(std::env::var("GYRO_TEST_DATA_DIR")?);
    if !output.is_absolute() || !browser_url_is_loopback(&parse_navigable_url(&url)?) {
        return Err("native browser smoke requires isolated data and a loopback fixture".into());
    }
    std::fs::create_dir_all(&output)?;
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
    let session = "native-browser-smoke";
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
                return Err(format!("page never showed {expected}"));
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
    wait_page("Browser observation ready")?;
    steps.push("open/read".into());
    // A second read used to clear the map but retain invalid refs on elements.
    wait_page("Browser observation ready")?;
    let button = find("#change-state")?;
    let clicked = call("click", json!({"ref":button}))?;
    if clicked["name"] != "Change visible state" {
        return Err(format!("click did not name its element: {clicked}"));
    }
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
        let outcome = browser_pointer::execute(
            app,
            session,
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
        &json!({"action":"hover","captureId":"stale","x":hover_x,"y":hover_y}),
    )
    .is_ok()
    {
        return Err("stale pointer capture was accepted".into());
    }
    mouse("hover", hover_x, hover_y, hover_x, hover_y)?;
    wait_page("Hover: open")?;
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
    steps.push(run_background(app, url, output)?);
    Ok(steps)
}

/// A browser the user never opened: no bounds, no visibility, driven entirely
/// through the agent bridge. This is how a model browses while the chat is in
/// split view, so the whole observe/act/capture loop has to work with nothing
/// on screen — a 1x1 child webview used to make every one of these steps lie.
fn run_background(app: &AppHandle, url: &str, output: &std::path::Path) -> Result<String, String> {
    let session = "native-browser-smoke-background";
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
