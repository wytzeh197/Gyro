//! Isolated native document/navigation oracle; compiled only by the debug fixture.
use crate::session_browser::{self as browser, SessionBrowserManager, SessionBrowserOpenRequest};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

#[path = "browser_geometry_smoke.rs"]
mod geometry;

pub(super) fn start(
    app: AppHandle,
    base: url::Url,
    owner: Value,
    path: PathBuf,
    complete: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        let mut checks = Vec::new();
        let mut observations = Vec::new();
        let geometry_only = std::env::var("GYRO_BROWSER_GEOMETRY_SMOKE").as_deref() == Ok("1");
        let result = if geometry_only {
            geometry::run(&app, &base, &owner, &path, &mut checks, &mut observations)
        } else {
            run(&app, &base, &owner, &mut checks, &mut observations)
        };
        let passed = result.is_ok() && checks.iter().all(|check| check["passed"] == true);
        let report = json!({
            "passed":passed, "checks":checks, "observations":observations,
            "nativeBuild":"debug-embedded-tauri-production-handlers",
            "engine":"native-WKWebView", "nativeOsInputTested":false,
            "error":result.err(),
            "mode":if geometry_only {"geometry"} else {"navigation"},
        });
        if !complete.swap(true, Ordering::AcqRel) {
            let _ = std::fs::write(path, serde_json::to_vec_pretty(&report).unwrap());
            app.exit(if passed { 0 } else { 1 });
        }
    });
}

fn control(base: &url::Url, op: &str) -> Result<Value, String> {
    if base.scheme() != "http" || base.host_str() != Some("127.0.0.1") {
        return Err("navigation oracle requires its exact loopback HTTP server".into());
    }
    let port = base.port().ok_or("fixture server port missing")?;
    let mut stream = TcpStream::connect_timeout(
        &SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
        Duration::from_secs(2),
    )
    .map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    write!(stream,"GET /__gyro_navigation_control?op={op} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n").map_err(|e|e.to_string())?;
    let mut response = String::new();
    stream
        .take(8192)
        .read_to_string(&mut response)
        .map_err(|e| e.to_string())?;
    if !response.starts_with("HTTP/1.1 200 ") {
        return Err(format!("fixture control failed: {response}"));
    }
    let (_, body) = response
        .split_once("\r\n\r\n")
        .ok_or("fixture control body missing")?;
    serde_json::from_str(body).map_err(|e| e.to_string())
}

fn raw_document(app: &AppHandle, session: &str) -> Result<Value, String> {
    let snapshot = app
        .state::<SessionBrowserManager>()
        .get_snapshot(session)?
        .ok_or("fixture browser missing")?;
    let view = app
        .get_webview(&snapshot.label)
        .ok_or("fixture webview missing")?;
    let (send, receive) = mpsc::channel();
    // Read-only oracle bypasses the tool guard under test and inspects the real DOM.
    view.eval_with_callback("({url:location.href,readyState:document.readyState,width:innerWidth,height:innerHeight,clicks:document.querySelector('#click-count')?.textContent,navigationMarker:document.querySelector('#nav-state')?.textContent})",move|value|{let _=send.send(value);}).map_err(|e|e.to_string())?;
    let encoded = receive
        .recv_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&encoded).map_err(|e| e.to_string())
}

fn wait_page(app: &AppHandle, session: &str, url: &str, complete: bool) -> Result<Value, String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(page) = browser::call_agent(app, session, "readPage", json!({"maxDepth":4})) {
            if page["url"] == url && (!complete || page["readyState"] == "complete") {
                return Ok(page);
            }
        }
        if Instant::now() >= deadline {
            return Err(format!("fixture document never became available: {url}"));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn find_button(app: &AppHandle, session: &str) -> Result<String, String> {
    find_selector(app, session, "#change-state")
}
fn find_selector(app: &AppHandle, session: &str, selector: &str) -> Result<String, String> {
    browser::call_agent(app, session, "find", json!({"selector":selector}))?["results"][0]["ref"]
        .as_str()
        .map(str::to_owned)
        .ok_or("fixture button missing".into())
}

fn record(checks: &mut Vec<Value>, name: &str, passed: bool) {
    checks.push(json!({"name":name,"passed":passed}));
}

fn wait_failure(app: &AppHandle, session: &str) -> Result<browser::SessionBrowserSnapshot, String> {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let snapshot = app
            .state::<SessionBrowserManager>()
            .get_snapshot(session)?
            .ok_or("failure browser missing")?;
        if snapshot.navigation_error.is_some() || Instant::now() >= deadline {
            return Ok(snapshot);
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn stop_loading(app: &AppHandle, session: &str) -> Result<(), String> {
    let snapshot = app
        .state::<SessionBrowserManager>()
        .get_snapshot(session)?
        .ok_or("stop browser missing")?;
    let view = app
        .get_webview(&snapshot.label)
        .ok_or("stop view missing")?;
    let (send, receive) = mpsc::channel();
    view.with_webview(move |platform| unsafe {
        let view = &*platform.inner().cast::<objc2_web_kit::WKWebView>();
        view.stopLoading();
        let _ = send.send(());
    })
    .map_err(|e| e.to_string())?;
    receive
        .recv_timeout(Duration::from_secs(3))
        .map_err(|e| e.to_string())
}

struct MainThreadBarrier(Option<mpsc::Sender<()>>);
impl Drop for MainThreadBarrier {
    fn drop(&mut self) {
        if let Some(send) = self.0.take() {
            let _ = send.send(());
        }
    }
}
fn hold_main_thread(app: &AppHandle) -> Result<MainThreadBarrier, String> {
    let (entered, receive) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = entered.send(());
        // Fixture-only bounded barrier, always released by its RAII owner.
        let _ = wait.recv_timeout(Duration::from_secs(3));
    })
    .map_err(|e| e.to_string())?;
    receive
        .recv_timeout(Duration::from_secs(2))
        .map_err(|e| e.to_string())?;
    Ok(MainThreadBarrier(Some(release)))
}

fn run(
    app: &AppHandle,
    base: &url::Url,
    owner: &Value,
    checks: &mut Vec<Value>,
    observations: &mut Vec<Value>,
) -> Result<(), String> {
    let session = owner["id"].as_str().ok_or("fixture session missing")?;
    let workspace = owner["workspaceKey"]
        .as_str()
        .ok_or("fixture workspace missing")?;
    let page = |label: &str| {
        let mut url = base.clone();
        url.query_pairs_mut().clear().append_pair("label", label);
        url.to_string()
    };
    let original = page("Original");
    let target = page("Provisional");
    browser::open_session_browser(
        app,
        SessionBrowserOpenRequest {
            session_id: session.into(),
            workspace_key: workspace.into(),
            url: original.clone(),
            bounds: None,
            visible: Some(false),
        },
    )?;
    wait_page(app, session, &original, true)?;
    let old_ref = find_button(app, session)?;
    for cycle in 1..=2 {
        control(base, "arm")?;
        if cycle == 1 {
            browser::navigate_session_browser(app, session, &target)?;
        } else {
            browser::reload_session_browser(app, session)?;
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if control(base, "state")?["heldDocuments"]
                .as_u64()
                .unwrap_or(0)
                > 0
            {
                break;
            }
            if Instant::now() >= deadline {
                return Err("server did not receive the provisional navigation".into());
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let reference = if cycle == 1 {
            old_ref.clone()
        } else {
            observations
                .last()
                .and_then(|v| v["newRef"].as_str())
                .ok_or("new reference missing")?
                .to_string()
        };
        let before = raw_document(app, session)?;
        let read = browser::call_agent(app, session, "readPage", json!({"maxDepth":4}));
        let click = browser::call_agent(app, session, "click", json!({"ref":reference}));
        let capture = browser::capture_session_browser_png(app, session);
        let pointer = browser::mouse_session_browser(app, session, "click", 1.0, 1.0, 1.0, 1.0);
        let after = raw_document(app, session)?;
        let snapshot = app
            .state::<SessionBrowserManager>()
            .get_snapshot(session)?
            .ok_or("browser missing during navigation")?;
        record(
            checks,
            &format!("cycle {cycle}: previous document read is rejected before response headers"),
            read.is_err(),
        );
        record(
            checks,
            &format!("cycle {cycle}: previous document click is rejected before response headers"),
            click.is_err(),
        );
        record(
            checks,
            &format!("cycle {cycle}: rejected click leaves the actual old document unchanged"),
            before["clicks"] == after["clicks"],
        );
        record(
            checks,
            &format!("cycle {cycle}: old tool result cannot overwrite the requested native URL"),
            snapshot.url == target,
        );
        record(
            checks,
            &format!("cycle {cycle}: native screenshot cannot return previous-document pixels"),
            capture.is_err(),
        );
        record(
            checks,
            &format!("cycle {cycle}: background pointer cannot act on the previous document"),
            pointer.is_err(),
        );
        // Exercise the same bounded observation used by model tools, starting
        // while response headers are still held by the fixture server.
        let interactive = std::thread::scope(|threads| {
            let release = threads.spawn(|| {
                std::thread::sleep(Duration::from_millis(150));
                control(base, "release-document")
            });
            let observed = browser::observe_agent(app, session, "readPage", json!({"maxDepth":4}));
            release
                .join()
                .map_err(|_| "document release worker panicked".to_string())??;
            observed
        })?;
        record(
            checks,
            &format!(
                "cycle {cycle}: one observation waits for delayed headers and returns the new page"
            ),
            interactive["url"] == target && interactive["readyState"] == "interactive",
        );
        let new_ref = find_button(app, session)?;
        let current = app
            .state::<SessionBrowserManager>()
            .get_snapshot(session)?
            .ok_or("browser missing after response")?;
        record(
            checks,
            &format!(
                "cycle {cycle}: current interactive document remains usable while an image is held"
            ),
            current.loading && interactive["readyState"] == "interactive",
        );
        let stale = browser::call_agent(app, session, "click", json!({"ref":reference}));
        record(
            checks,
            &format!("cycle {cycle}: old document reference is rejected after commit"),
            stale.is_err(),
        );
        browser::call_agent(app, session, "click", json!({"ref":new_ref}))?;
        let changed = raw_document(app, session)?;
        record(
            checks,
            &format!("cycle {cycle}: a fresh reference changes the current interactive document"),
            changed["clicks"] == "Clicks: 1",
        );
        let found = browser::call_agent(app, session, "find", json!({"selector":"#change-state"}))?;
        let rect = &found["results"][0]["rect"];
        let x = rect["x"].as_f64().ok_or("button X missing")?
            + rect["width"].as_f64().ok_or("button width missing")? / 2.0;
        let y = rect["y"].as_f64().ok_or("button Y missing")?
            + rect["height"].as_f64().ok_or("button height missing")? / 2.0;
        browser::mouse_session_browser(app, session, "click", x, y, x, y)?;
        record(
            checks,
            &format!(
                "cycle {cycle}: background pointer can act on the committed interactive document"
            ),
            raw_document(app, session)?["clicks"] == "Clicks: 2",
        );
        control(base, "release-images")?;
        wait_page(app, session, &target, true)?;
        observations.push(json!({"cycle":cycle,"before":before,"after":after,"readResult":read.map_err(|e|e.to_string()),"clickResult":click.map_err(|e|e.to_string()),"snapshotAfterOldRead":snapshot,"newRef":new_ref,"interactiveState":interactive["readyState"]}));
    }
    control(base, "finish")?;
    browser::history_session_browser(app, session, "back")?;
    wait_page(app, session, &original, true)?;
    record(
        checks,
        "native Back reaches the actual previous document",
        raw_document(app, session)?["url"] == original,
    );
    browser::history_session_browser(app, session, "forward")?;
    wait_page(app, session, &target, true)?;
    record(
        checks,
        "native Forward reaches the actual next document",
        raw_document(app, session)?["url"] == target,
    );
    let before = app
        .state::<SessionBrowserManager>()
        .get_snapshot(session)?
        .ok_or("history browser missing")?;
    let exhausted = browser::history_session_browser(app, session, "forward");
    let after = app
        .state::<SessionBrowserManager>()
        .get_snapshot(session)?
        .ok_or("history browser missing")?;
    record(
        checks,
        "unavailable history fails without invalidating the current document",
        exhausted.is_err()
            && before.navigation_id == after.navigation_id
            && after.document_committed,
    );
    browser::close_session_browser(app, session)?;
    record(
        checks,
        "native browser closes after both navigation cycles",
        app.state::<SessionBrowserManager>()
            .get_snapshot(session)?
            .is_none(),
    );
    for _ in 0..8 {
        let fast = page("Fast");
        browser::open_session_browser(
            app,
            SessionBrowserOpenRequest {
                session_id: session.into(),
                workspace_key: workspace.into(),
                url: fast.clone(),
                bounds: None,
                visible: Some(false),
            },
        )?;
        wait_page(app, session, &fast, true)?;
        browser::close_session_browser(app, session)?;
    }
    record(
        checks,
        "eight immediate initial documents remain usable after native creation",
        true,
    );
    for (kind, selector) in [
        ("link", "#nav-link"),
        ("form", "#nav-submit"),
        ("script", "#nav-script"),
    ] {
        control(base, "arm")?;
        browser::open_session_browser(
            app,
            SessionBrowserOpenRequest {
                session_id: session.into(),
                workspace_key: workspace.into(),
                url: original.clone(),
                bounds: None,
                visible: Some(false),
            },
        )?;
        wait_page(app, session, &original, true)?;
        let trigger = find_selector(app, session, selector)?;
        let old = find_button(app, session)?;
        let old_target =
            browser::call_agent(app, session, "find", json!({"selector":"#change-state"}))?;
        let rect = &old_target["results"][0]["rect"];
        let old_x = rect["x"].as_f64().ok_or("old button X missing")?
            + rect["width"].as_f64().ok_or("old button width missing")? / 2.0;
        let old_y = rect["y"].as_f64().ok_or("old button Y missing")?
            + rect["height"].as_f64().ok_or("old button height missing")? / 2.0;
        let trigger_result = browser::call_agent(app, session, "click", json!({"ref":trigger}));
        let deadline = Instant::now() + Duration::from_secs(5);
        while control(base, "state")?["heldDocuments"]
            .as_u64()
            .unwrap_or(0)
            == 0
        {
            if Instant::now() >= deadline {
                return Err(format!("{kind} did not reach the held response"));
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let before = raw_document(app, session)?;
        let read = browser::call_agent(app, session, "readPage", json!({"maxDepth":3}));
        let click = browser::call_agent(app, session, "click", json!({"ref":old}));
        let capture = browser::capture_session_browser_png(app, session);
        let pointer =
            browser::mouse_session_browser(app, session, "click", old_x, old_y, old_x, old_y);
        let after = raw_document(app, session)?;
        record(
            checks,
            &format!("page {kind}: old reads fail while response headers are held"),
            read.is_err(),
        );
        record(
            checks,
            &format!("page {kind}: old clicks fail while response headers are held"),
            click.is_err(),
        );
        record(
            checks,
            &format!("page {kind}: actual old document stays unchanged"),
            before["clicks"] == after["clicks"],
        );
        record(
            checks,
            &format!("page {kind}: screenshot cannot return old pixels"),
            capture.is_err(),
        );
        record(
            checks,
            &format!("page {kind}: pointer cannot act on old document"),
            pointer.is_err(),
        );
        let pending = app
            .state::<SessionBrowserManager>()
            .get_snapshot(session)?
            .ok_or("page navigation browser missing")?;
        record(
            checks,
            &format!("page {kind}: native state records the pending main document"),
            pending.loading && !pending.document_committed && pending.url == target,
        );
        control(base, "release-document")?;
        wait_page(app, session, &target, false)?;
        let fresh = find_button(app, session)?;
        browser::call_agent(app, session, "click", json!({"ref":fresh}))?;
        record(
            checks,
            &format!("page {kind}: committed interactive document accepts fresh work"),
            raw_document(app, session)?["clicks"] == "Clicks: 1",
        );
        control(base, "release-images")?;
        wait_page(app, session, &target, true)?;
        observations.push(json!({"pageNavigation":kind,"triggerResult":trigger_result,"before":before,"after":after,"readResult":read,"clickResult":click,"pending":pending}));
        browser::close_session_browser(app, session)?;
    }
    browser::open_session_browser(
        app,
        SessionBrowserOpenRequest {
            session_id: session.into(),
            workspace_key: workspace.into(),
            url: original.clone(),
            bounds: None,
            visible: Some(false),
        },
    )?;
    wait_page(app, session, &original, true)?;
    let old = find_button(app, session)?;
    let identity = app
        .state::<SessionBrowserManager>()
        .get_snapshot(session)?
        .ok_or("same-document fixture missing")?
        .navigation_id;
    for (name, selector, count) in [
        ("prevented link", "#nav-prevent", 1),
        ("SPA route", "#nav-spa", 2),
        ("fragment", "#nav-hash", 3),
        ("iframe", "#nav-frame", 4),
        ("blocked credential URL", "#nav-blocked", 5),
    ] {
        let trigger = find_selector(app, session, selector)?;
        browser::call_agent(app, session, "click", json!({"ref":trigger}))?;
        if name == "iframe" {
            let deadline = Instant::now() + Duration::from_secs(5);
            while control(base, "state")?["heldFrames"].as_u64().unwrap_or(0) == 0 {
                if Instant::now() >= deadline {
                    return Err("iframe did not reach the held response".into());
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        }
        browser::call_agent(app, session, "click", json!({"ref":old}))?;
        let current = app
            .state::<SessionBrowserManager>()
            .get_snapshot(session)?
            .ok_or("same-document browser missing")?;
        record(
            checks,
            &format!("{name} leaves the parent document usable with its existing references"),
            current.navigation_id == identity
                && current.document_committed
                && raw_document(app, session)?["clicks"] == format!("Clicks: {count}"),
        );
        if name == "iframe" {
            control(base, "release-frames")?;
        }
    }
    browser::close_session_browser(app, session)?;
    // A real provisional network failure must settle instead of waiting forever.
    browser::open_session_browser(
        app,
        SessionBrowserOpenRequest {
            session_id: session.into(),
            workspace_key: workspace.into(),
            url: original.clone(),
            bounds: None,
            visible: Some(false),
        },
    )?;
    wait_page(app, session, &original, true)?;
    let failed_url = page("Failure");
    browser::navigate_session_browser(app, session, &failed_url)?;
    let deadline = Instant::now() + Duration::from_secs(3);
    let failed = loop {
        let snapshot = app
            .state::<SessionBrowserManager>()
            .get_snapshot(session)?
            .ok_or("failure browser missing")?;
        if !snapshot.loading || Instant::now() >= deadline {
            break serde_json::to_value(snapshot).map_err(|e| e.to_string())?;
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    let read = browser::call_agent(app, session, "readPage", json!({"maxDepth":3}));
    record(
        checks,
        "connection failure stops loading",
        failed["loading"] == false,
    );
    record(
        checks,
        "connection failure reports an explicit recovery error",
        failed["navigationError"].is_object(),
    );
    record(
        checks,
        "connection failure cannot expose the old document",
        read.is_err() && raw_document(app, session)?["url"] == original,
    );
    observations
        .push(json!({"failure":failed,"readResult":read,"wireState":control(base,"state")?}));
    browser::history_session_browser(app, session, "back")?;
    wait_page(app, session, &original, true)?;
    record(
        checks,
        "Back recovers the actual previous document after provisional failure",
        raw_document(app, session)?["url"] == original,
    );

    browser::close_session_browser(app, session)?;
    browser::open_session_browser(
        app,
        SessionBrowserOpenRequest {
            session_id: session.into(),
            workspace_key: workspace.into(),
            url: failed_url.clone(),
            bounds: None,
            visible: Some(false),
        },
    )?;
    let initial_failure = wait_failure(app, session)?;
    record(
        checks,
        "a failed initial document settles without a previously committed page",
        !initial_failure.loading && initial_failure.navigation_error.is_some(),
    );
    record(
        checks,
        "Back on a failed initial document reports unavailable history",
        browser::history_session_browser(app, session, "back").is_err(),
    );
    observations.push(json!({"initialFailure":initial_failure}));
    browser::navigate_session_browser(app, session, &original)?;
    wait_page(app, session, &original, true)?;

    browser::navigate_session_browser(app, session, &failed_url)?;
    let repeated = wait_failure(app, session)?;
    record(
        checks,
        "a second failure settles independently",
        repeated.navigation_error.is_some() && !repeated.loading,
    );
    control(base, "allow-failed-document")?;
    browser::reload_session_browser(app, session)?;
    wait_page(app, session, &failed_url, true)?;
    let retried = app
        .state::<SessionBrowserManager>()
        .get_snapshot(session)?
        .ok_or("retry browser missing")?;
    record(
        checks,
        "Retry loads the failed URL instead of reloading the old page",
        raw_document(app, session)?["url"] == failed_url && retried.navigation_error.is_none(),
    );

    browser::navigate_session_browser(app, session, &original)?;
    wait_page(app, session, &original, true)?;
    control(base, "arm")?;
    browser::navigate_session_browser(app, session, &target)?;
    let deadline = Instant::now() + Duration::from_secs(3);
    while control(base, "state")?["heldDocuments"]
        .as_u64()
        .unwrap_or(0)
        == 0
    {
        if Instant::now() >= deadline {
            return Err("cancel request never reached server".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    stop_loading(app, session)?;
    let cancelled = wait_failure(app, session)?;
    record(
        checks,
        "native cancellation stops loading with an explicit cancelled state",
        !cancelled.loading
            && cancelled
                .navigation_error
                .as_ref()
                .is_some_and(|error| error.kind == "cancelled" && error.code == -999),
    );
    record(
        checks,
        "native cancellation keeps old DOM unavailable until explicit recovery",
        browser::call_agent(app, session, "readPage", json!({})).is_err(),
    );
    browser::history_session_browser(app, session, "back")?;
    wait_page(app, session, &original, true)?;
    record(
        checks,
        "Back recovers after native cancellation",
        raw_document(app, session)?["url"] == original,
    );

    browser::navigate_session_browser(app, session, &target)?;
    let deadline = Instant::now() + Duration::from_secs(3);
    while control(base, "state")?["heldDocuments"]
        .as_u64()
        .unwrap_or(0)
        == 0
    {
        if Instant::now() >= deadline {
            return Err("superseded request never reached server".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let second = page("Second");
    browser::navigate_session_browser(app, session, &second)?;
    wait_page(app, session, &second, true)?;
    let replacement = app
        .state::<SessionBrowserManager>()
        .get_snapshot(session)?
        .ok_or("replacement browser missing")?;
    record(
        checks,
        "superseding a held load leaves its replacement ready without cancellation errors",
        !replacement.loading
            && replacement.navigation_error.is_none()
            && raw_document(app, session)?["url"] == second,
    );
    observations.push(json!({"retried":retried,"cancelled":cancelled,"replacement":replacement}));
    browser::close_session_browser(app, session)?;

    browser::open_session_browser(
        app,
        SessionBrowserOpenRequest {
            session_id: session.into(),
            workspace_key: workspace.into(),
            url: original.clone(),
            bounds: None,
            visible: Some(false),
        },
    )?;
    wait_page(app, session, &original, true)?;
    let barrier = hold_main_thread(app)?;
    let token = gyro_core::CancellationToken::default();
    let worker_token = token.clone();
    let worker_app = app.clone();
    let worker_session = session.to_string();
    let cancelled_url = page("QueuedCancelled");
    let worker_url = cancelled_url.clone();
    let (send, receive) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let _scope =
            browser::begin_model_operation(gyro_core::CapabilityId::BrowserNavigate, worker_token);
        let result = browser::navigate_session_browser(&worker_app, &worker_session, &worker_url);
        let _ = send.send(result);
    });
    let deadline = Instant::now() + Duration::from_secs(1);
    while app
        .state::<SessionBrowserManager>()
        .get_snapshot(session)?
        .is_none_or(|snapshot| snapshot.url != cancelled_url)
    {
        if Instant::now() >= deadline {
            return Err("queued navigation did not reach its state reservation".into());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let cancel_started = Instant::now();
    token.cancel();
    let early_result = receive.recv_timeout(Duration::from_millis(500));
    let returned_promptly = early_result.is_ok();
    let cancel_ms = cancel_started.elapsed().as_millis();
    drop(barrier);
    let cancelled_result = match early_result {
        Ok(result) => result,
        Err(_) => receive
            .recv_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())?,
    };
    worker
        .join()
        .map_err(|_| "queued navigation worker panicked")?;
    let deadline = Instant::now() + Duration::from_secs(3);
    let settled = loop {
        let snapshot = app
            .state::<SessionBrowserManager>()
            .get_snapshot(session)?
            .ok_or("queued browser missing")?;
        if !snapshot.loading || Instant::now() >= deadline {
            break snapshot;
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    let actual = raw_document(app, session)?;
    let wire = control(base, "state")?;
    record(
        checks,
        "queued navigation cancellation returns promptly",
        returned_promptly && cancelled_result.is_err() && cancel_ms < 500,
    );
    record(
        checks,
        "cancelled queued navigation never reaches the server",
        wire["queuedCancelledRequests"] == 0,
    );
    record(
        checks,
        "cancelled queued navigation leaves the actual document unchanged",
        actual["url"] == original,
    );
    record(
        checks,
        "cancelled queued navigation settles without a false successful destination",
        !settled.loading && settled.url != cancelled_url || settled.navigation_error.is_some(),
    );
    observations.push(json!({"queuedCancellation":{"result":cancelled_result,"elapsedMs":cancel_ms,"settled":settled,"actual":actual,"wireState":wire}}));
    for kind in ["reload", "reopen", "viewport"] {
        let before = app
            .state::<SessionBrowserManager>()
            .get_snapshot(session)?
            .ok_or("cancel browser missing")?;
        let actual_before = raw_document(app, session)?;
        let wire_before = control(base, "state")?;
        let barrier = hold_main_thread(app)?;
        let token = gyro_core::CancellationToken::default();
        let worker_token = token.clone();
        let worker_app = app.clone();
        let worker_session = session.to_string();
        let worker_workspace = workspace.to_string();
        let worker_url = page("QueuedReopen");
        let (send, receive) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let capability = match kind {
                "reload" => gyro_core::CapabilityId::BrowserReload,
                "reopen" => gyro_core::CapabilityId::BrowserOpen,
                _ => gyro_core::CapabilityId::BrowserViewport,
            };
            let _scope = browser::begin_model_operation(capability, worker_token);
            let result = match kind {
                "reload" => browser::reload_session_browser(&worker_app, &worker_session),
                "reopen" => browser::open_session_browser(
                    &worker_app,
                    SessionBrowserOpenRequest {
                        session_id: worker_session.clone(),
                        workspace_key: worker_workspace,
                        url: worker_url,
                        bounds: None,
                        visible: Some(false),
                    },
                ),
                _ => browser::set_session_browser_viewport(
                    &worker_app,
                    &worker_session,
                    crate::browser_viewport::BrowserViewportRequest {
                        mode: crate::browser_viewport::BrowserViewportMode::Mobile,
                        width: None,
                        height: None,
                    },
                ),
            };
            let _ = send.send(result);
        });
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            let manager = app.state::<SessionBrowserManager>();
            let entered = if kind == "viewport" {
                manager.fixture_layout_is_busy()
            } else {
                manager
                    .get_snapshot(session)?
                    .is_some_and(|snapshot| snapshot.navigation_id > before.navigation_id)
            };
            if entered {
                break;
            }
            if Instant::now() >= deadline {
                return Err(format!("{kind} never entered its pending operation"));
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let started = Instant::now();
        token.cancel();
        let early = receive.recv_timeout(Duration::from_millis(500));
        let prompt = early.is_ok();
        let elapsed_ms = started.elapsed().as_millis();
        drop(barrier);
        let result = match early {
            Ok(result) => result,
            Err(_) => receive
                .recv_timeout(Duration::from_secs(5))
                .map_err(|e| e.to_string())?,
        };
        worker.join().map_err(|_| "cancel worker panicked")?;
        // This native read runs after the released callbacks, independently of
        // the manager state used by tools. It detects late document/zoom changes.
        let after = raw_document(app, session)?;
        let snapshot = app
            .state::<SessionBrowserManager>()
            .get_snapshot(session)?
            .ok_or("cancelled browser disappeared")?;
        let wire = control(base, "state")?;
        record(
            checks,
            &format!("cancelled {kind} returns promptly"),
            prompt && result.is_err() && elapsed_ms < 500,
        );
        record(
            checks,
            &format!("cancelled {kind} does not change the actual document or viewport"),
            after["url"] == actual_before["url"]
                && after["width"] == actual_before["width"]
                && after["height"] == actual_before["height"],
        );
        record(
            checks,
            &format!("cancelled {kind} preserves current resource metadata"),
            snapshot.resource_id == before.resource_id
                && snapshot.url == before.url
                && snapshot.viewport == before.viewport
                && snapshot.document_committed,
        );
        record(
            checks,
            &format!("cancelled {kind} does not issue a late page request"),
            wire["requestsByLabel"] == wire_before["requestsByLabel"],
        );
        observations.push(json!({"cancelledOperation":kind,"result":result,"elapsedMs":elapsed_ms,"before":actual_before,"after":after,"snapshot":snapshot,"wireState":wire}));
    }
    let barrier = hold_main_thread(app)?;
    let first_app = app.clone();
    let first_session = session.to_string();
    let old_url = page("QueuedSuperseded");
    let old_for_worker = old_url.clone();
    let (send_old, receive_old) = mpsc::channel();
    let old_worker = std::thread::spawn(move || {
        let _ = send_old.send(browser::navigate_session_browser(
            &first_app,
            &first_session,
            &old_for_worker,
        ));
    });
    let deadline = Instant::now() + Duration::from_secs(1);
    while app
        .state::<SessionBrowserManager>()
        .get_snapshot(session)?
        .is_none_or(|snapshot| snapshot.url != old_url)
    {
        if Instant::now() >= deadline {
            return Err("older request did not reserve navigation".into());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let next_app = app.clone();
    let next_session = session.to_string();
    let latest_url = page("Second");
    let latest_for_worker = latest_url.clone();
    let (send_next, receive_next) = mpsc::channel();
    let next_worker = std::thread::spawn(move || {
        let _ = send_next.send(browser::navigate_session_browser(
            &next_app,
            &next_session,
            &latest_for_worker,
        ));
    });
    let deadline = Instant::now() + Duration::from_secs(1);
    while app
        .state::<SessionBrowserManager>()
        .get_snapshot(session)?
        .is_none_or(|snapshot| snapshot.url != latest_url)
    {
        if Instant::now() >= deadline {
            return Err("replacement request did not reserve navigation".into());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    drop(barrier);
    let older = receive_old
        .recv_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    let latest = receive_next
        .recv_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    old_worker
        .join()
        .map_err(|_| "older request worker panicked")?;
    next_worker
        .join()
        .map_err(|_| "replacement request worker panicked")?;
    wait_page(app, session, &latest_url, true)?;
    let wire = control(base, "state")?;
    record(
        checks,
        "a superseded queued navigation is rejected before native dispatch",
        older.is_err(),
    );
    record(
        checks,
        "a superseded queued destination never reaches the server",
        wire["requestsByLabel"]["QueuedSuperseded"]
            .as_u64()
            .unwrap_or(0)
            == 0,
    );
    record(
        checks,
        "the latest queued navigation reaches the actual requested document",
        latest.is_ok() && raw_document(app, session)?["url"] == latest_url,
    );
    observations
        .push(json!({"supersededQueuedRequest":{"older":older,"latest":latest,"wireState":wire}}));

    browser::close_session_browser(app, session)?;
    let deadline = Instant::now() + Duration::from_secs(3);
    let counts = loop {
        let counts = browser::navigation_observer_counts();
        if (counts["installed"] == counts["detached"] && counts["installed"] == counts["dropped"])
            || Instant::now() >= deadline
        {
            break counts;
        }
        // Native teardown is queued; wait for the actual delegate release.
        std::thread::sleep(Duration::from_millis(25));
    };
    record(
        checks,
        "navigation observer restores and releases every installed delegate",
        counts["installed"].as_u64().unwrap_or(0) > 0
            && counts["installed"] == counts["detached"]
            && counts["installed"] == counts["dropped"]
            && counts["forwardedCallbacks"].as_u64().unwrap_or(0) > 0,
    );
    observations.push(json!({"delegateLifecycle":counts}));
    Ok(())
}
