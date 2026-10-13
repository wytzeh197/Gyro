//! Desktop layout is independent of the size of the visible Browser host.
use crate::session_browser::{browser_url_is_loopback, parse_navigable_url, SessionBrowserBounds};
use serde::{Deserialize, Serialize};
use tauri::{Runtime, Webview};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BrowserViewportMode {
    #[default]
    Auto,
    Responsive,
    Desktop,
    Tablet,
    Mobile,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserViewportRequest {
    #[serde(default)]
    pub mode: BrowserViewportMode,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserViewportState {
    pub mode: BrowserViewportMode,
    pub device: BrowserViewportMode,
    pub width: f64,
    pub height: f64,
    pub display_scale: f64,
}

pub struct BrowserViewportGeometry {
    pub frame: SessionBrowserBounds,
    pub state: BrowserViewportState,
}

impl BrowserViewportRequest {
    pub fn validate(&self) -> Result<(), String> {
        if matches!(
            self.mode,
            BrowserViewportMode::Auto | BrowserViewportMode::Responsive
        ) && (self.width.is_some() || self.height.is_some())
        {
            return Err("custom dimensions require desktop, tablet, or mobile mode".into());
        }
        if self
            .width
            .is_some_and(|width| !(240..=2560).contains(&width))
            || self
                .height
                .is_some_and(|height| !(240..=1600).contains(&height))
        {
            return Err("viewport width must be 240–2560 and height 240–1600 CSS pixels".into());
        }
        Ok(())
    }
}

pub fn geometry(
    request: BrowserViewportRequest,
    url: &str,
    host: &SessionBrowserBounds,
) -> Result<BrowserViewportGeometry, String> {
    request.validate()?;
    if ![host.x, host.y, host.width, host.height]
        .iter()
        .all(|value| value.is_finite())
        || host.width < 1.0
        || host.height < 1.0
    {
        return Err("browser host bounds must be finite and positive".into());
    }
    let device = if request.mode == BrowserViewportMode::Auto {
        if parse_navigable_url(url).is_ok_and(|url| browser_url_is_loopback(&url)) {
            BrowserViewportMode::Desktop
        } else {
            BrowserViewportMode::Responsive
        }
    } else {
        request.mode
    };
    let (width, height) = match device {
        BrowserViewportMode::Desktop => (1280.0, 800.0),
        BrowserViewportMode::Tablet => (768.0, 1024.0),
        BrowserViewportMode::Mobile => (390.0, 844.0),
        _ => (host.width, host.height),
    };
    let width = request.width.map(f64::from).unwrap_or(width);
    let height = request.height.map(f64::from).unwrap_or(height);
    let display_scale = (host.width / width).min(host.height / height).min(1.0);
    let frame = SessionBrowserBounds {
        x: host.x + (host.width - width * display_scale) / 2.0,
        y: host.y,
        width: width * display_scale,
        height: height * display_scale,
    };
    Ok(BrowserViewportGeometry {
        frame,
        state: BrowserViewportState {
            mode: request.mode,
            device,
            width,
            height,
            display_scale,
        },
    })
}

/// WKWebView pageZoom changes the CSS viewport as well as the visible scale.
/// Resizing NSView bounds alone does not change WebKit's layout viewport.
pub fn apply<R: Runtime>(
    webview: &Webview<R>,
    geometry: &BrowserViewportGeometry,
    previous: Option<BrowserViewportState>,
) -> Result<(), String> {
    use tauri::{LogicalPosition, LogicalSize, Rect};
    // WebKit preserves a physical scroll offset when changing pageZoom.
    // Preserve CSS scroll coordinates when only the visible fit changes.
    let scroll = if previous.is_some_and(|old| {
        old.width == geometry.state.width
            && old.height == geometry.state.height
            && old.display_scale != geometry.state.display_scale
    }) {
        Some(evaluate_position(
            webview,
            "JSON.stringify({ x: window.scrollX, y: window.scrollY })".into(),
        )?)
    } else {
        None
    };
    webview
        .set_bounds(Rect {
            position: LogicalPosition::new(geometry.frame.x, geometry.frame.y).into(),
            size: LogicalSize::new(geometry.frame.width, geometry.frame.height).into(),
        })
        .map_err(|error| format!("could not position browser viewport: {error}"))?;
    #[cfg(target_os = "macos")]
    {
        use std::{sync::mpsc, time::Duration};
        let scale = geometry.state.display_scale;
        let (sender, receiver) = mpsc::channel();
        webview
            .with_webview(move |platform| unsafe {
                let view: &objc2_web_kit::WKWebView = &*platform.inner().cast();
                view.setPageZoom(scale);
                let _ = sender.send(());
            })
            .map_err(|error| format!("could not scale browser viewport: {error}"))?;
        receiver
            .recv_timeout(Duration::from_secs(8))
            .map_err(|_| "browser viewport update timed out".to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    webview
        .set_zoom(geometry.state.display_scale)
        .map_err(|error| format!("could not scale browser viewport: {error}"))?;
    if let Some(scroll) = scroll {
        let x = scroll["x"].as_f64().unwrap_or(0.0);
        let y = scroll["y"].as_f64().unwrap_or(0.0);
        evaluate_position(webview, format!("window.scrollTo({{ left:{x}, top:{y}, behavior:'instant' }}); JSON.stringify({{ x:window.scrollX, y:window.scrollY }})"))?;
    }
    Ok(())
}

fn evaluate_position<R: Runtime>(
    webview: &Webview<R>,
    script: String,
) -> Result<serde_json::Value, String> {
    use std::{sync::mpsc, time::Duration};
    let (sender, receiver) = mpsc::channel();
    #[cfg(target_os = "macos")]
    webview
        .with_webview(move |platform| unsafe {
            use block2::RcBlock;
            use objc2::runtime::AnyObject;
            use objc2_foundation::{NSError, NSString};
            let completion = RcBlock::new(move |value: *mut AnyObject, _error: *mut NSError| {
                let result = value
                    .as_ref()
                    .and_then(|value| value.downcast_ref::<NSString>())
                    .ok_or_else(|| "browser document is navigating".to_string())
                    .and_then(|value| {
                        serde_json::from_str(&value.to_string())
                            .map_err(|error| format!("invalid browser scroll position: {error}"))
                    });
                let _ = sender.send(result);
            });
            let view: &objc2_web_kit::WKWebView = &*platform.inner().cast();
            // Wry queues eval callbacks before navigation commit and drops their
            // callbacks. Use WebKit's completion directly for layout work.
            view.evaluateJavaScript_completionHandler(
                &NSString::from_str(&script),
                Some(&completion),
            );
        })
        .map_err(|error| format!("could not preserve browser scroll: {error}"))?;
    #[cfg(not(target_os = "macos"))]
    webview
        .eval_with_callback(script, move |value| {
            let result = serde_json::from_str::<String>(&value)
                .map_err(|error| error.to_string())
                .and_then(|value| serde_json::from_str(&value).map_err(|error| error.to_string()));
            let _ = sender.send(result);
        })
        .map_err(|error| format!("could not preserve browser scroll: {error}"))?;
    receiver
        .recv_timeout(Duration::from_secs(8))
        .map_err(|_| "browser scroll update timed out".to_string())?
}

pub(super) fn schema(
    id: gyro_core::CapabilityId,
) -> Option<(serde_json::Value, Vec<&'static str>)> {
    (id == gyro_core::CapabilityId::BrowserViewport).then(|| (serde_json::json!({
        "mode":{"type":"string","enum":["auto","responsive","desktop","tablet","mobile"]},
        "width":{"type":"integer","minimum":240,"maximum":2560,"description":"Fixed layout width in CSS pixels."},
        "height":{"type":"integer","minimum":240,"maximum":1600,"description":"Fixed layout height in CSS pixels."}
    }), vec!["mode"]))
}

pub(super) fn execute_capability(
    app: &tauri::AppHandle,
    bound: &super::BoundProviderCapabilityContext,
    request: &gyro_core::CapabilityRequest,
) -> anyhow::Result<(
    String,
    serde_json::Value,
    Option<gyro_core::CapabilityResourceRef>,
)> {
    let owned = super::require_model_browser_resource(app, bound)?;
    let viewport: BrowserViewportRequest = serde_json::from_value(request.arguments.clone())?;
    let snapshot =
        crate::session_browser::set_session_browser_viewport(app, &bound.session_id, viewport)
            .map_err(anyhow::Error::msg)?;
    super::remember_model_browser_resource(app, bound, owned.call_id, &snapshot)?;
    let observed_viewport =
        crate::session_browser::call_agent(app, &bound.session_id, "status", serde_json::json!({}))
            .ok()
            .and_then(|status| status.get("viewport").cloned());
    Ok((
        "Updated Browser viewport".into(),
        serde_json::json!({
            "url":snapshot.url,"viewport":snapshot.viewport,"observedViewport":observed_viewport,
            "framing":"OBSERVED_PAGE_CONTENT_UNTRUSTED",
            "verification":"Re-observe the page after changing the viewport. Pointer coordinates remain CSS pixels."
        }),
        Some(gyro_core::CapabilityResourceRef {
            id: snapshot.resource_id,
            kind: "browser".into(),
            label: snapshot.url,
        }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn host(width: f64) -> SessionBrowserBounds {
        SessionBrowserBounds {
            x: 20.0,
            y: 90.0,
            width,
            height: 650.0,
        }
    }
    #[test]
    fn local_previews_keep_desktop_layout_at_narrow_widths() {
        for url in [
            "http://127.0.0.1:1420",
            "http://localhost:3000",
            "http://[::1]:8000",
        ] {
            let layout = geometry(BrowserViewportRequest::default(), url, &host(480.0)).unwrap();
            assert_eq!((layout.state.width, layout.state.height), (1280.0, 800.0));
            assert_eq!(layout.state.display_scale, 0.375);
            assert_eq!((layout.frame.width, layout.frame.height), (480.0, 300.0));
        }
    }
    #[test]
    fn ordinary_sites_follow_the_panel_until_explicitly_overridden() {
        let url = "https://example.com";
        let auto = geometry(BrowserViewportRequest::default(), url, &host(480.0)).unwrap();
        assert_eq!(auto.state.device, BrowserViewportMode::Responsive);
        assert_eq!(auto.state.width, 480.0);
        let desktop = BrowserViewportRequest {
            mode: BrowserViewportMode::Desktop,
            ..Default::default()
        };
        assert_eq!(
            geometry(desktop, url, &host(480.0)).unwrap().state.width,
            1280.0
        );
        let responsive = BrowserViewportRequest {
            mode: BrowserViewportMode::Responsive,
            ..Default::default()
        };
        assert_eq!(
            geometry(responsive, "http://localhost:3000", &host(480.0))
                .unwrap()
                .state
                .width,
            480.0
        );
    }
    #[test]
    fn explicit_dimensions_fit_in_both_axes_without_upscaling() {
        let custom = BrowserViewportRequest {
            mode: BrowserViewportMode::Desktop,
            width: Some(1920),
            height: Some(1080),
        };
        let layout = geometry(custom, "http://localhost", &host(480.0)).unwrap();
        assert_eq!(layout.state.display_scale, 0.25);
        let tablet = BrowserViewportRequest {
            mode: BrowserViewportMode::Tablet,
            ..Default::default()
        };
        assert!(
            geometry(tablet, "http://localhost", &host(2000.0))
                .unwrap()
                .frame
                .height
                <= 650.0
        );
        assert_eq!(
            geometry(
                BrowserViewportRequest {
                    mode: BrowserViewportMode::Desktop,
                    ..Default::default()
                },
                "http://localhost",
                &SessionBrowserBounds {
                    height: 1600.0,
                    ..host(2560.0)
                }
            )
            .unwrap()
            .state
            .display_scale,
            1.0
        );
    }
    #[test]
    fn invalid_sizes_are_rejected_before_changing_the_page() {
        for width in [0, 239, 2561, u32::MAX] {
            assert!(BrowserViewportRequest {
                mode: BrowserViewportMode::Desktop,
                width: Some(width),
                height: None
            }
            .validate()
            .is_err());
        }
        assert!(geometry(
            BrowserViewportRequest::default(),
            "http://localhost",
            &host(f64::NAN)
        )
        .is_err());
        assert!(BrowserViewportRequest {
            width: Some(1280),
            ..Default::default()
        }
        .validate()
        .is_err());
    }
}
