use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Runtime};

use crate::session_browser::{self, SessionBrowserManager};

pub(super) struct BrowserMouseOutcome {
    pub action: String,
    pub url: String,
    pub data: Value,
}

pub(super) fn execute<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    actor: &str,
    arguments: &Value,
) -> Result<BrowserMouseOutcome, String> {
    let argument = |key: &str| {
        arguments
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("{key} is required"))
    };
    let action = argument("action")?;
    let capture_id = argument("captureId")?;
    if !matches!(
        action,
        "move" | "hover" | "click" | "secondary-click" | "drag"
    ) {
        return Err("unsupported browser pointer action".into());
    }
    let coordinate = |key: &str| -> Result<f64, String> {
        let value = arguments
            .get(key)
            .and_then(Value::as_f64)
            .ok_or_else(|| format!("{key} must be a number"))?;
        if !value.is_finite() {
            return Err(format!("{key} must be finite"));
        }
        Ok(value)
    };
    let x = coordinate("x")?;
    let y = coordinate("y")?;
    let (to_x, to_y) = if action == "drag" {
        (coordinate("toX")?, coordinate("toY")?)
    } else {
        (x, y)
    };
    let manager = app.state::<SessionBrowserManager>();
    let (lease, snapshot) = manager.capture_document(session_id)?;
    let _gesture = manager.begin_model_pointer(&snapshot.resource_id)?;
    let reference = manager.pointer_reference(session_id, capture_id)?;
    let call = |method, args| {
        session_browser::call_agent_for(app, lease.clone(), snapshot.clone(), method, args)
    };
    let status = call("status", json!({}))?;
    if status.get("url").and_then(Value::as_str) != Some(reference.url.as_str())
        || status.get("viewport") != Some(&reference.viewport)
    {
        return Err("browser page or viewport changed; take a new screenshot".into());
    }
    let width = reference.viewport["width"]
        .as_f64()
        .ok_or("browser screenshot has no viewport width")?;
    let height = reference.viewport["height"]
        .as_f64()
        .ok_or("browser screenshot has no viewport height")?;
    for (px, py) in [(x, y), (to_x, to_y)] {
        if px < 0.0 || py < 0.0 || px >= width || py >= height {
            return Err("pointer coordinates are outside the browser viewport".into());
        }
    }
    let moving_only = matches!(action, "move" | "hover");
    let probe = |x, y| -> Result<Value, String> {
        let target = call("pointerTarget", json!({ "x": x, "y": y }))?;
        if target.get("url").and_then(Value::as_str) != Some(reference.url.as_str())
            || target.get("viewport") != Some(&reference.viewport)
        {
            return Err("browser page or viewport changed; take a new screenshot".into());
        }
        if target["blocked"] == true {
            return Err(target["blockedReason"]
                .as_str()
                .unwrap_or("this target needs user takeover in the Browser")
                .into());
        }
        if !moving_only && target["sensitive"] == true {
            return Err("this action needs user takeover in the Browser".into());
        }
        if !moving_only && target["disabled"] == true {
            return Err("this pointer target is disabled".into());
        }
        if !moving_only && !target["targetToken"].is_string() {
            return Err("browser target could not be verified; take a new screenshot".into());
        }
        Ok(target)
    };
    let initial_target = probe(x, y)?;
    let initial_destination = (action == "drag").then(|| probe(to_x, to_y)).transpose()?;
    let background_only = snapshot.background_only || !snapshot.visible;
    let prior = status["pointerPosition"]["x"]
        .as_f64()
        .zip(status["pointerPosition"]["y"].as_f64())
        .filter(|(x, y)| *x >= 0.0 && *x < width && *y >= 0.0 && *y < height);
    let elapsed = Instant::now();
    let travel = PointerTravel::new(prior, (x, y));
    for step in 1..=travel.samples {
        let (point, due) = travel.sample(step);
        std::thread::sleep(due.saturating_sub(elapsed.elapsed()));
        call(
            "movePointer",
            json!({
                "x": point.0, "y": point.1, "url": reference.url, "viewport": reference.viewport,
                "actor": actor, "visible": !background_only, "first": step == 1, "final": step == travel.samples,
            }),
        )?;
    }
    // Movement can open a menu or rerender a target. Inspect it again before
    // applying a button, and keep evaluation and dispatch on the original lease.
    manager.pointer_reference(session_id, capture_id)?;
    let mut target = probe(x, y)?;
    let destination = (action == "drag").then(|| probe(to_x, to_y)).transpose()?;
    if !moving_only
        && (target["targetToken"] != initial_target["targetToken"]
            || destination.as_ref().map(|target| &target["targetToken"])
                != initial_destination.as_ref().map(|target| &target["targetToken"]))
    {
        return Err("browser target changed while moving; take a new screenshot before clicking or dragging".into());
    }
    if action != "move" && !(background_only && action == "hover") {
        let expectation = (!moving_only && background_only).then(|| json!({
            "url": reference.url,
            "viewport": reference.viewport,
            "source": target["targetToken"],
            "destination": destination.as_ref().map(|target| &target["targetToken"]),
        }));
        session_browser::mouse_session_browser_for(
            app,
            lease.clone(),
            snapshot.clone(),
            action,
            x,
            y,
            to_x,
            to_y,
            expectation,
        )?;
    }
    // Pointer feedback is best effort: navigation can replace the document
    // immediately after a successful click. It must not turn success into retry.
    if !background_only && !moving_only {
        let _ = call(
            "showPointer",
            json!({
                "action": action, "x": x, "y": y, "toX": to_x, "toY": to_y,
                "actor": actor, "url": reference.url,
            }),
        );
    }
    if let Some(target) = target.as_object_mut() {
        target.remove("targetToken");
    }
    Ok(BrowserMouseOutcome {
        action: action.to_string(),
        url: reference.url,
        data: json!({
            "action": action,
            "x": x,
            "y": y,
            "toX": to_x,
            "toY": to_y,
            "target": target,
            "inputMode": if background_only || action == "move" { "page-events" } else if action == "hover" { "native-webview" } else { "native-mouse" },
            "verification": if background_only || action == "move" {
                "Re-observe the result. Page-local movement sends pointer events. CSS hover and native menus require the foreground Browser."
            } else { "Re-observe the page before claiming the outcome." }
        }),
    })
}

struct PointerTravel {
    from: (f64, f64),
    to: (f64, f64),
    samples: u32,
    duration: Duration,
}

impl PointerTravel {
    fn new(from: Option<(f64, f64)>, to: (f64, f64)) -> Self {
        let from = from.unwrap_or(to);
        let distance = (to.0 - from.0).hypot(to.1 - from.1);
        let millis = if distance < 1.0 {
            0
        } else {
            (90.0 + distance * 0.18).min(280.0) as u32
        };
        Self {
            from,
            to,
            samples: millis.div_ceil(16).max(1),
            duration: Duration::from_millis(millis.into()),
        }
    }

    fn sample(&self, step: u32) -> ((f64, f64), Duration) {
        if step == self.samples {
            return (self.to, self.duration);
        }
        let time = f64::from(step) / f64::from(self.samples);
        let progress = time * time * (3.0 - 2.0 * time);
        (
            (
                self.from.0 + progress * (self.to.0 - self.from.0),
                self.from.1 + progress * (self.to.1 - self.from.1),
            ),
            self.duration.mul_f64(time),
        )
    }
}
