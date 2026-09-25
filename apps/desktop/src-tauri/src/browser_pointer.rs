use serde_json::{json, Value};
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
    if !matches!(action, "hover" | "click" | "secondary-click" | "drag") {
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
    let reference = app
        .state::<SessionBrowserManager>()
        .pointer_reference(session_id, capture_id)?;
    let status = session_browser::call_agent(app, session_id, "status", json!({}))?;
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
    let target =
        session_browser::call_agent(app, session_id, "pointerTarget", json!({ "x": x, "y": y }))?;
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
    if action != "hover" && target["sensitive"] == true {
        return Err("this action needs user takeover in the Browser".into());
    }
    if action == "drag" {
        let destination = session_browser::call_agent(
            app,
            session_id,
            "pointerTarget",
            json!({ "x": to_x, "y": to_y }),
        )?;
        if destination.get("url").and_then(Value::as_str) != Some(reference.url.as_str())
            || destination.get("viewport") != Some(&reference.viewport)
        {
            return Err("browser page or viewport changed; take a new screenshot".into());
        }
        if destination["blocked"] == true || destination["sensitive"] == true {
            return Err("drag destination needs user takeover in the Browser".into());
        }
    }
    session_browser::mouse_session_browser(app, session_id, action, x, y, to_x, to_y)?;
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
            "verification": "Re-observe the page before claiming the outcome."
        }),
    })
}
