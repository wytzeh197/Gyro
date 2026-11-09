//! Read-only layout diagnostics for the guarded, disposable normal-App review.
use std::{io::Write, time::Duration};
use tauri::{AppHandle, Manager};

const SNAPSHOT: &str = r#"(() => {
  const key = '__gyroShellLayoutReview';
  if (!window[key]) {
    const errors = [];
    window.addEventListener('error', event => {
      if (errors.length < 20) errors.push(String(event.message));
    });
    window.addEventListener('unhandledrejection', event => {
      if (errors.length < 20) errors.push(String(event.reason));
    });
    window[key] = { errors };
  }
  const rect = node => {
    const r = node.getBoundingClientRect();
    return { x:r.x, y:r.y, width:r.width, height:r.height };
  };
  const state = node => {
    const css = getComputedStyle(node);
    return { class:node.className, rect:rect(node), width:css.width,
      opacity:css.opacity, display:css.display, hidden:node.hidden,
      connected:node.isConnected, inert:node.inert,
      animations:node.getAnimations().map(a => ({ state:a.playState,
        currentTime:a.currentTime, timing:a.effect?.getComputedTiming(),
        keyframes:a.effect?.getKeyframes() })) };
  };
  return { at:Date.now(), ready:document.readyState,
    visibility:document.visibilityState, viewport:[innerWidth,innerHeight],
    errors:window[key].errors,
    screen:[screenX,screenY,outerWidth,outerHeight],
    dragRegions:[...document.querySelectorAll('[data-tauri-drag-region]')].map(state),
    titleHit:document.elementFromPoint(1100,20)?.className,
    docks:[...document.querySelectorAll('.gyro-chat-companion')].map(node => ({
      ...state(node), parents:[node.parentElement,node.parentElement?.parentElement,
        node.parentElement?.parentElement?.parentElement].filter(Boolean).map(state),
      browser:[...node.querySelectorAll('.gyro-browser-preview, .gyro-browser-native-host')].map(state)
    })) };
})()"#;

pub(crate) fn start(app: &AppHandle) {
    // This is compiled out of ordinary builds. Even a feature build must name
    // the immutable store pinned by the review-only binary before collecting.
    let Some(data) = option_env!("GYRO_NATIVE_BROWSER_SHELL_DATA_DIR") else {
        return;
    };
    let data = std::path::Path::new(data);
    if std::env::var_os("GYRO_TEST_DATA_DIR").as_deref() != Some(data.as_os_str())
        || data.canonicalize().ok().as_deref() != Some(data)
        || !data.starts_with("/private/tmp")
        || std::fs::read_to_string(data.join(".native-shell-review"))
            .ok()
            .as_deref()
            != Some("isolated-native-shell-review\n")
    {
        return;
    }
    let Some(root) = data.parent() else { return };
    let path = root.join("companion-layout.jsonl");
    let app = app.clone();
    std::thread::spawn(move || {
        let Ok(mut file) = std::fs::File::create(path) else {
            return;
        };
        let mut previous = serde_json::Value::Null;
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_secs(1800) {
            // Adding a child browser makes this a multi-webview window. The
            // root webview remains addressable even when WebviewWindow is not.
            let Some(webview) = app.get_webview("main") else {
                break;
            };
            let (send, receive) = std::sync::mpsc::sync_channel(1);
            if webview
                .eval_with_callback(SNAPSHOT, move |payload| {
                    let _ = send.send(payload);
                })
                .is_err()
            {
                break;
            }
            if let Ok(payload) = receive.recv_timeout(Duration::from_secs(2)) {
                if let Ok(mut snapshot) = serde_json::from_str::<serde_json::Value>(&payload) {
                    let window = webview.window();
                    let position = window.outer_position().ok();
                    let size = window.outer_size().ok();
                    snapshot["nativeWindow"] = serde_json::json!({
                        "position":position.map(|p| [p.x, p.y]),
                        "size":size.map(|s| [s.width, s.height]),
                        "scale":window.scale_factor().ok(),
                    });
                    let at = snapshot.as_object_mut().and_then(|o| o.remove("at"));
                    if snapshot != previous {
                        previous = snapshot.clone();
                        snapshot["at"] = at.unwrap_or(serde_json::Value::Null);
                        let _ = writeln!(file, "{snapshot}");
                        let _ = file.flush();
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    });
}
