//! Real native frame, DOM and PNG coordinate oracle for the debug fixture.
use crate::{
    browser_viewport::{BrowserViewportMode as Mode, BrowserViewportRequest},
    session_browser::{
        self as browser, SessionBrowserBounds as Bounds, SessionBrowserManager,
        SessionBrowserOpenRequest,
    },
};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::mpsc,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

fn document(app: &AppHandle, session: &str) -> Result<Value, String> {
    let snapshot = app
        .state::<SessionBrowserManager>()
        .get_snapshot(session)?
        .ok_or("geometry browser missing")?;
    let view = app
        .get_webview(&snapshot.label)
        .ok_or("geometry view missing")?;
    let (send, receive) = mpsc::channel();
    view.eval_with_callback("({url:location.href,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,clientWidth:document.documentElement.clientWidth,clientHeight:document.documentElement.clientHeight,visual:visualViewport?{width:visualViewport.width,height:visualViewport.height,scale:visualViewport.scale}:null,marker:(()=>{const e=document.querySelector('#geometry-marker'),r=e?.getBoundingClientRect();return r?{x:r.x,y:r.y,width:r.width,height:r.height,clicks:e.dataset.clicks}:null})()})",move|value|{let _=send.send(value);}).map_err(|e|e.to_string())?;
    serde_json::from_str(
        &receive
            .recv_timeout(Duration::from_secs(3))
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

unsafe fn scroll_geometry(view: &objc2_app_kit::NSView, depth: u8) -> Option<Value> {
    if depth > 6 {
        return None;
    }
    if let Some(scroll) = view.downcast_ref::<objc2_app_kit::NSScrollView>() {
        let inset = scroll.contentInsets();
        let size = scroll.contentSize();
        return Some(
            json!({"autoInsets":scroll.automaticallyAdjustsContentInsets(),"insets":{"top":inset.top,"bottom":inset.bottom,"left":inset.left,"right":inset.right},"content":{"width":size.width,"height":size.height},"horizontalScroller":scroll.hasHorizontalScroller(),"verticalScroller":scroll.hasVerticalScroller()}),
        );
    }
    for child in view.subviews().iter() {
        if let Some(geometry) = scroll_geometry(&child, depth + 1) {
            return Some(geometry);
        }
    }
    None
}

fn native(app: &AppHandle, session: &str) -> Result<Value, String> {
    let snapshot = app
        .state::<SessionBrowserManager>()
        .get_snapshot(session)?
        .ok_or("geometry browser missing")?;
    let view = app
        .get_webview(&snapshot.label)
        .ok_or("geometry view missing")?;
    let (send, receive) = mpsc::channel();
    view.with_webview(move|platform|unsafe {
        let view=&*platform.inner().cast::<objc2_web_kit::WKWebView>();
        let frame=view.frame();let bounds=view.bounds();let parent=view.superview().map(|v|v.bounds());let parent_frame=view.superview().map(|v|v.frame());let origin=view.convertPoint_toView(objc2_foundation::NSPoint::new(0.0,0.0),None);let unit=view.convertPoint_toView(objc2_foundation::NSPoint::new(1.0,1.0),None);let safe=view.safeAreaInsets();let additional=view.additionalSafeAreaInsets();
        let _=send.send(json!({"frame":{"x":frame.origin.x,"y":frame.origin.y,"width":frame.size.width,"height":frame.size.height},"bounds":{"x":bounds.origin.x,"y":bounds.origin.y,"width":bounds.size.width,"height":bounds.size.height},"parent":parent.map(|r|json!({"width":r.size.width,"height":r.size.height})),"parentFrame":parent_frame.map(|r|json!({"x":r.origin.x,"y":r.origin.y,"width":r.size.width,"height":r.size.height})),"cssToWindowScale":{"x":(unit.x-origin.x).abs()*view.pageZoom(),"y":(unit.y-origin.y).abs()*view.pageZoom()},"scroll":scroll_geometry(view,0),"safeArea":{"top":safe.top,"left":safe.left,"bottom":safe.bottom,"right":safe.right},"additionalSafeArea":{"top":additional.top,"left":additional.left,"bottom":additional.bottom,"right":additional.right},"zoom":view.pageZoom(),"hidden":view.isHidden(),"backingScale":view.window().map(|w|w.backingScaleFactor())}));
    }).map_err(|e|e.to_string())?;
    receive
        .recv_timeout(Duration::from_secs(3))
        .map_err(|e| e.to_string())
}

pub(super) fn run(
    app: &AppHandle,
    base: &url::Url,
    owner: &Value,
    path: &Path,
    checks: &mut Vec<Value>,
    observations: &mut Vec<Value>,
) -> Result<(), String> {
    let session = owner["id"].as_str().ok_or("geometry owner missing")?;
    let workspace = owner["workspaceKey"]
        .as_str()
        .ok_or("geometry workspace missing")?;
    let mut url = base.clone();
    url.query_pairs_mut()
        .clear()
        .append_pair("label", "Original");
    let presets = [
        ("background", Mode::Desktop, 1280.0, 800.0, None, None),
        ("initial-background", Mode::Auto, 1280.0, 800.0, None, None),
        ("desktop-narrow", Mode::Desktop, 480.0, 300.0, None, None),
        (
            "desktop-fractional",
            Mode::Desktop,
            481.37,
            309.63,
            None,
            None,
        ),
        (
            "mobile-fractional",
            Mode::Mobile,
            341.27,
            717.83,
            None,
            None,
        ),
        (
            "tablet-fractional",
            Mode::Tablet,
            417.43,
            571.29,
            None,
            None,
        ),
        (
            "custom-fractional",
            Mode::Desktop,
            541.75,
            391.25,
            Some(1920),
            Some(1080),
        ),
        ("responsive", Mode::Responsive, 536.0, 418.0, None, None),
    ];
    for (name, mode, width, height, custom_width, custom_height) in presets {
        browser::open_session_browser(
            app,
            SessionBrowserOpenRequest {
                session_id: session.into(),
                workspace_key: workspace.into(),
                url: url.to_string(),
                bounds: if name == "initial-background" {
                    None
                } else {
                    Some(Bounds {
                        x: 10.25,
                        y: 30.75,
                        width,
                        height,
                    })
                },
                visible: Some(false),
            },
        )?;
        super::wait_page(app, session, url.as_str(), true)?;
        let advertised = if name == "initial-background" {
            app.state::<SessionBrowserManager>()
                .get_snapshot(session)?
                .ok_or("initial geometry missing")?
        } else {
            browser::set_session_browser_viewport(
                app,
                session,
                BrowserViewportRequest {
                    mode,
                    width: custom_width,
                    height: custom_height,
                },
            )?
        };
        let started = Instant::now();
        let before = document(app, session)?;
        let native_before = native(app, session)?;
        let capture = browser::capture_session_browser_png(app, session)?;
        let png = path
            .parent()
            .ok_or("geometry report parent missing")?
            .join(format!("geometry-{name}.png"));
        std::fs::write(&png, &capture.png).map_err(|e| e.to_string())?;
        let after = document(app, session)?;
        let native_after = native(app, session)?;
        // Caller-side preset expectations, independent of returned metadata.
        let (preset_width, preset_height) = match mode {
            Mode::Mobile => (390.0, 844.0),
            Mode::Tablet => (768.0, 1024.0),
            Mode::Responsive => (width, height),
            _ => (1280.0, 800.0),
        };
        let expected_width = custom_width.map(f64::from).unwrap_or(preset_width);
        let expected_height = custom_height.map(f64::from).unwrap_or(preset_height);
        let expected = json!({"width":expected_width,"height":expected_height});
        super::record(
            checks,
            &format!("{name}: advertised viewport matches caller's requested preset"),
            advertised.viewport.width == expected_width
                && advertised.viewport.height == expected_height,
        );
        let scale_ok = ["x", "y"].iter().all(|axis| {
            native_after["cssToWindowScale"][axis]
                .as_f64()
                .is_some_and(|scale| (scale - advertised.viewport.display_scale).abs() < 0.000001)
        });
        super::record(
            checks,
            &format!("{name}: native pointer conversion matches fitted scale"),
            scale_ok,
        );
        super::record(
            checks,
            &format!("{name}: native view keeps a full CSS frame without page zoom"),
            native_after["zoom"] == 1.0
                && native_after["bounds"]["width"].as_f64() == Some(expected_width)
                && native_after["bounds"]["height"].as_f64() == Some(expected_height)
                && native_after["frame"]["width"].as_f64() == Some(expected_width)
                && native_after["frame"]["height"].as_f64() == Some(expected_height),
        );
        for (phase, doc) in [("before capture", &before), ("after capture", &after)] {
            super::record(
                checks,
                &format!("{name}: actual DOM matches requested viewport {phase}"),
                doc["width"].as_f64() == Some(expected_width)
                    && doc["height"].as_f64() == Some(expected_height),
            );
        }
        super::record(
            checks,
            &format!("{name}: PNG dimensions match current DOM coordinates"),
            after["width"] == capture.width && after["height"] == capture.height,
        );
        let marker = after.get("marker").ok_or("geometry marker missing")?;
        let x = marker["x"].as_f64().ok_or("marker x missing")?
            + marker["width"].as_f64().ok_or("marker width missing")? / 2.0;
        let y = marker["y"].as_f64().ok_or("marker y missing")?
            + marker["height"].as_f64().ok_or("marker height missing")? / 2.0;
        if name == "mobile-fractional"
            && std::env::var("GYRO_BROWSER_GEOMETRY_INPUT_REVIEW").as_deref() == Ok("1")
        {
            browser::set_session_browser_visible(app, session, true)?;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("Gyro native viewport input review");
            }
            let ready = path.with_file_name("geometry-input-ready.json");
            std::fs::write(ready,json!({"ready":true,"case":name,"cssTarget":{"x":x,"y":y},"native":native(app,session)?}).to_string()).map_err(|e|e.to_string())?;
            for expected_clicks in [1, 2] {
                let deadline = Instant::now() + Duration::from_secs(120);
                loop {
                    let page = document(app, session)?;
                    if page["marker"]["clicks"]
                        .as_str()
                        .and_then(|n| n.parse::<u64>().ok())
                        .is_some_and(|n| n >= expected_clicks)
                    {
                        if expected_clicks == 1 {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.set_title("Gyro coordinate click verified");
                            }
                            std::fs::write(path.with_file_name("geometry-input-verified.json"),json!({"verified":true,"document":page,"native":native(app,session)?}).to_string()).map_err(|e|e.to_string())?;
                        }
                        break;
                    }
                    if Instant::now() >= deadline {
                        return Err(format!(
                            "native coordinate review did not receive click {expected_clicks}"
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
            }
            browser::set_session_browser_visible(app, session, false)?;
            super::record(
                checks,
                "native coordinate input reaches the fitted calibration target",
                true,
            );
            observations.push(
                json!({"nativeCoordinateInputVerified":true,"case":name,"cssTarget":{"x":x,"y":y}}),
            );
        }
        let previous_clicks = document(app, session)?["marker"]["clicks"]
            .as_str()
            .and_then(|n| n.parse::<u64>().ok())
            .ok_or("marker counter missing")?;
        browser::mouse_session_browser(app, session, "click", x, y, x, y)?;
        super::record(
            checks,
            &format!("{name}: background pointer reaches the calibration target"),
            document(app, session)?["marker"]["clicks"] == (previous_clicks + 1).to_string(),
        );
        super::record(
            checks,
            &format!("{name}: screenshot preserves the current viewport"),
            before["width"] == after["width"] && before["height"] == after["height"],
        );
        observations.push(json!({"case":name,"requested":expected,"advertised":advertised,"nativeBefore":native_before,"nativeAfter":native_after,"documentBefore":before,"documentAfter":after,"capture":{"path":png,"width":capture.width,"height":capture.height},"elapsedMs":started.elapsed().as_millis()}));
        browser::close_session_browser(app, session)?;
    }
    check_resource(app, &url, workspace, session, path, checks, observations)?;
    let deadline = Instant::now() + Duration::from_secs(3);
    let counts = loop {
        let counts = crate::browser_viewport::native_container_counts();
        if counts["installed"] == counts["detached"] && counts["installed"] == counts["dropped"]
            || Instant::now() >= deadline
        {
            break counts;
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    super::record(
        checks,
        "all native viewport containers are detached and released",
        counts["installed"].as_u64().unwrap_or(0) > 0
            && counts["installed"] == counts["detached"]
            && counts["installed"] == counts["dropped"],
    );
    observations.push(json!({"containerLifecycle":counts}));
    Ok(())
}

/// Exercise only the private native resource lifecycle. This does not consume
/// approval, run a Check plan or claim coverage of the human resolver.
fn check_resource(
    app: &AppHandle,
    url: &url::Url,
    workspace: &str,
    session: &str,
    path: &Path,
    checks: &mut Vec<Value>,
    observations: &mut Vec<Value>,
) -> Result<(), String> {
    let mut url = url.clone();
    url.set_query(None);
    let plan: gyro_core::local_check::CheckPlan = serde_json::from_value(json!({
        "id":uuid::Uuid::new_v4().to_string(),
        "createdAt":"2026-11-07T00:00:00Z",
        "workspaceRevision":0,
        "draft":{
            "sessionId":session,"previewUrl":url.as_str(),"command":"",
            "dataChanges":"Read the isolated calibration page; no Check actions execute.",
            "files":["browser-observation.html"],
            "criteria":[{"id":"marker","requirement":"Read the calibration marker height.","scope":"browser","expected":{"height":12}}],
            "browser":{"readySelector":"#geometry-marker","viewport":{"width":1440,"height":1080},
                "steps":[{"action":"observe","criterionId":"marker","waitMs":0,
                    "reads":[{"key":"height","selector":"#geometry-marker","kind":"height"}]}]}
        },
        "snapshot":{"workspace":workspace,"gitHead":null,"files":[]}
    })).map_err(|e|e.to_string())?;
    let id = browser::open_check_browser(app, &plan)?;
    super::wait_page(app, &id, url.as_str(), true)?;
    let advertised = app
        .state::<SessionBrowserManager>()
        .get_snapshot(&id)?
        .ok_or("Check snapshot missing")?;
    let before = document(app, &id)?;
    let native = native(app, &id)?;
    let capture = browser::capture_session_browser_png(app, &id)?;
    let after = document(app, &id)?;
    let png = path.with_file_name("geometry-private-check.png");
    std::fs::write(&png, &capture.png).map_err(|e| e.to_string())?;
    super::record(
        checks,
        "private Check resource retains its own hidden browser",
        advertised.background_only
            && !advertised.visible
            && advertised.session_id != session
            && native["hidden"] == true,
    );
    super::record(
        checks,
        "private Check native DOM matches the reviewed viewport",
        advertised.viewport.width == 1440.0
            && advertised.viewport.height == 1080.0
            && before["width"] == 1440
            && before["height"] == 1080
            && after["width"] == 1440
            && after["height"] == 1080,
    );
    super::record(
        checks,
        "private Check PNG matches the reviewed viewport",
        capture.width == 1440 && capture.height == 1080,
    );
    super::record(
        checks,
        "private Check loads the calibration page rather than an error document",
        after["marker"]["height"] == 12 && after["marker"]["clicks"] == "0",
    );
    browser::close_check_browser(app, &id)?;
    super::record(
        checks,
        "closing Check removes its resource and native webview",
        app.state::<SessionBrowserManager>()
            .get_snapshot(&id)?
            .is_none()
            && app.get_webview(&advertised.label).is_none(),
    );
    observations.push(json!({"case":"private-check","requested":{"width":1440,"height":1080},"advertised":advertised,"nativeAfter":native,"documentBefore":before,"documentAfter":after,"capture":{"path":png,"width":capture.width,"height":capture.height}}));
    Ok(())
}
