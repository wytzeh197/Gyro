//! Native acceptance for the same live page at a fitted desktop viewport.
use crate::{
    browser_pointer,
    browser_viewport::{BrowserViewportMode as Mode, BrowserViewportRequest},
    session_browser::*,
};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

pub fn run(
    app: &AppHandle,
    session: &str,
    url: &str,
    output: &std::path::Path,
    mouse_enabled: bool,
) -> Result<Vec<String>, String> {
    let wait = |width: i64, height: i64| -> Result<Value, String> {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Ok(status) = call_agent(app, session, "status", json!({})) {
                let scale = app
                    .state::<SessionBrowserManager>()
                    .get_snapshot(session)?
                    .ok_or("browser disappeared")?
                    .viewport
                    .display_scale;
                // Public WebKit page zoom quantizes viewport edges to display
                // pixels; verify at most one display pixel of size rounding.
                let size_matches = |key: &str, expected: i64| {
                    status["viewport"][key]
                        .as_f64()
                        .is_some_and(|actual| (actual - expected as f64).abs() * scale <= 1.)
                };
                if status["readyState"] == "complete"
                    && size_matches("width", width)
                    && size_matches("height", height)
                {
                    return Ok(status);
                }
                if Instant::now() >= deadline {
                    return Err(format!("expected {width}x{height}; actual: {status}"));
                }
            }
            if Instant::now() >= deadline {
                return Err("viewport did not become ready".into());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    let page_contains = |expected: &str| -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let page = call_agent(
                app,
                session,
                "readPage",
                json!({"maxDepth":8,"maxChars":12000}),
            )?;
            if page.to_string().contains(expected) {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(format!("missing {expected}: {page}"));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    let bounds = |width, height| SessionBrowserBounds {
        x: 20.,
        y: 90.,
        width,
        height,
    };
    let choose = |mode, width, height| {
        set_session_browser_viewport(
            app,
            session,
            BrowserViewportRequest {
                mode,
                width,
                height,
            },
        )
    };
    set_session_browser_bounds(app, session, bounds(480., 300.))?;
    wait(1280, 800)?;
    let snapshot = app
        .state::<SessionBrowserManager>()
        .get_snapshot(session)?
        .unwrap();
    if snapshot.viewport.mode != Mode::Auto
        || (snapshot.viewport.display_scale - 0.375).abs() > 0.001
    {
        return Err(format!(
            "local preview did not auto fit: {:?}",
            snapshot.viewport
        ));
    }
    // The button is beyond the physical panel's 480-pixel right edge.
    let found = call_agent(app, session, "find", json!({"selector":"#change-state"}))?;
    let rect = &found["results"][0]["rect"];
    let x =
        rect["x"].as_f64().ok_or("button X missing")? + rect["width"].as_f64().unwrap_or(0.) / 2.;
    let y =
        rect["y"].as_f64().ok_or("button Y missing")? + rect["height"].as_f64().unwrap_or(0.) / 2.;
    if x <= 480. {
        return Err("fixture does not exercise scaled pointer coordinates".into());
    }
    let capture = capture_session_browser_png(app, session)?;
    if capture.width < 1280 || capture.height < 800 {
        return Err(format!(
            "scaled-down capture {}x{}",
            capture.width, capture.height
        ));
    }
    std::fs::write(output.join("browser-desktop-fit.png"), capture.png)
        .map_err(|e| e.to_string())?;
    let status = wait(1280, 800)?;
    app.state::<SessionBrowserManager>()
        .remember_pointer_capture(
            session,
            "desktop-fit.png".into(),
            url.into(),
            status["viewport"].clone(),
        )?;
    if mouse_enabled {
        browser_pointer::execute(
            app,
            session,
            "Viewport smoke",
            &json!({
                "action":"click","captureId":"desktop-fit.png","x":x,"y":y
            }),
        )?;
    } else {
        call_agent(
            app,
            session,
            "click",
            json!({"ref":found["results"][0]["ref"]}),
        )?;
    }
    page_contains("Clicks: 1").map_err(|error| {
        format!(
            "{error}; pointer target {x},{y}; console {:?}",
            call_agent(app, session, "console", json!({}))
        )
    })?;
    set_session_browser_bounds(app, session, bounds(320., 420.))?;
    wait(1280, 800)?;
    page_contains("Clicks: 1")?;
    call_agent(app, session, "scroll", json!({"dy":400}))?;
    let before = call_agent(app, session, "status", json!({}))?;
    set_session_browser_bounds(app, session, bounds(440., 420.))?;
    let after = wait(1280, 800)?;
    // WebKit quantizes scroll offsets to display pixels at fractional zoom.
    let scroll_delta = (before["viewport"]["scrollY"].as_f64().unwrap_or(0.)
        - after["viewport"]["scrollY"].as_f64().unwrap_or(0.))
    .abs();
    let scale = app
        .state::<SessionBrowserManager>()
        .get_snapshot(session)?
        .unwrap()
        .viewport
        .display_scale;
    if scroll_delta * scale > 1. {
        return Err(format!(
            "resize changed page scroll: before {}, after {}",
            before["viewport"], after["viewport"]
        ));
    }
    choose(Mode::Responsive, None, None)?;
    wait(440, 420)?;
    navigate_session_browser(app, session, &format!("{url}?viewport=1"))?;
    wait(440, 420)?;
    choose(Mode::Auto, None, None)?;
    wait(1280, 800)?;
    choose(Mode::Desktop, Some(1920), Some(1080))?;
    wait(1920, 1080)?;
    choose(Mode::Tablet, None, None)?;
    wait(768, 1024)?;
    choose(Mode::Mobile, None, None)?;
    wait(390, 844)?;
    // Legacy mouse, form and navigation acceptance continue at their original
    // viewport, on a fresh page. No production foreground guard is relaxed.
    choose(Mode::Responsive, None, None)?;
    set_session_browser_bounds(app, session, bounds(800., 650.))?;
    navigate_session_browser(app, session, url)?;
    wait(800, 650)?;
    page_contains("Clicks: 0")?;
    Ok(vec![
        format!(
            "Auto local Desktop fit 1280x800 in 480x300; full-resolution PNG {}x{}",
            capture.width, capture.height
        ),
        if mouse_enabled {
            "native screenshot-based click beyond panel width; state and scroll preserved through resize".into()
        } else {
            "DOM click beyond panel width; state and scroll preserved through resize; native OS mouse SKIPPED".into()
        },
        "Responsive override persists through navigation; Auto restores Desktop fit".into(),
        "custom desktop 1920x1080, tablet 768x1024, mobile 390x844 native viewports".into(),
    ])
}
