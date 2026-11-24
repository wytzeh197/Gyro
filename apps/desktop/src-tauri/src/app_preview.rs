//! Selected runtime ownership and framed observations. No native image is a live web page.
use crate::{browser::types::BrowserPreviewCapture, session_browser};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, Runtime};
#[cfg(target_os = "macos")]
#[path = "app_preview_macos.rs"]
mod platform;
#[cfg(target_os = "macos")]
#[path = "app_preview_simulator.rs"]
mod simulator;
#[cfg(target_os = "macos")]
#[path = "app_preview_xcode.rs"]
mod xcode;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub width: f64,
    pub height: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<[f64; 4]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub booted: Option<bool>,
}
fn web_target() -> Target {
    Target {
        id: "web".into(),
        kind: "web".into(),
        title: "Web preview".into(),
        width: 0.,
        height: 0.,
        window_id: None,
        pid: None,
        bounds: None,
        device_family: None,
        device_type: None,
        booted: None,
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub image_width: u32,
    pub image_height: u32,
}
impl Frame {
    fn point(&self, x: f64, y: f64, target: &Target) -> Result<(f64, f64), String> {
        if !x.is_finite()
            || !y.is_finite()
            || self.width <= 0.
            || self.height <= 0.
            || x < self.x
            || y < self.y
            || x >= self.x + self.width
            || y >= self.y + self.height
        {
            return Err(
                "Coordinates are outside the captured content; surrounds are not interactive"
                    .into(),
            );
        }
        Ok((
            (x - self.x) * target.width / self.width,
            (y - self.y) * target.height / self.height,
        ))
    }
}
#[derive(Clone)]
struct Reference {
    id: String,
    target: Target,
    frame: Frame,
    created: Instant,
    web_capture_id: Option<String>,
    revision: u64,
    digest: Option<Vec<u8>>,
}
impl Reference {
    fn validate(&self, id: &str, revision: u64) -> Result<(), String> {
        if self.id != id
            || self.revision != revision
            || self.created.elapsed() > Duration::from_secs(15)
        {
            return Err("Capture is stale or belongs to another target; capture again".into());
        }
        Ok(())
    }
}
#[derive(Default)]
struct Slot {
    workspace: String,
    target: Option<Target>,
    revision: u64,
    capture: Option<Reference>,
}
#[derive(Default)]
pub struct ManagerState {
    slots: Mutex<HashMap<String, Slot>>,
    #[cfg(target_os = "macos")]
    build: Mutex<()>,
}
impl ManagerState {
    fn with<T>(
        &self,
        session: &str,
        workspace: &str,
        f: impl FnOnce(&mut Slot) -> Result<T, String>,
    ) -> Result<T, String> {
        if session.is_empty() {
            return Err("Preview requires an owning session".into());
        }
        let mut slots = self.slots.lock().map_err(|_| "Preview state unavailable")?;
        let slot = slots.entry(session.into()).or_insert_with(|| Slot {
            workspace: workspace.into(),
            ..Slot::default()
        });
        if slot.workspace != workspace {
            return Err("Preview workspace ownership changed".into());
        }
        f(slot)
    }
}
pub fn selected<R: Runtime>(
    app: &AppHandle<R>,
    session: &str,
    workspace: &str,
) -> Result<Target, String> {
    app.state::<ManagerState>()
        .with(session, workspace, |slot| {
            Ok(slot.target.clone().unwrap_or_else(web_target))
        })
}
pub fn targets<R: Runtime>(
    app: &AppHandle<R>,
    session: &str,
    workspace: &str,
) -> Result<Value, String> {
    let selected = selected(app, session, workspace)?;
    let mut targets = vec![web_target()];
    let mut issues = Vec::<String>::new();
    #[cfg(target_os = "macos")]
    {
        match platform::windows() {
            Ok(windows) => targets.extend(windows),
            Err(e) => issues.push(e),
        }
        match simulator::targets() {
            Ok(devices) => targets.extend(devices),
            Err(e) => issues.push(e),
        }
    }
    #[cfg(not(target_os = "macos"))]
    issues.push("Native previews require macOS".into());
    Ok(json!({"selected":selected,"targets":targets,"issues":issues}))
}
pub fn select<R: Runtime>(
    app: &AppHandle<R>,
    session: &str,
    workspace: &str,
    id: &str,
) -> Result<Target, String> {
    let target = if id == "web" {
        web_target()
    } else {
        let listed = targets(app, session, workspace)?;
        serde_json::from_value::<Vec<Target>>(listed["targets"].clone())
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|t| t.id == id)
            .ok_or("Target is unavailable; refresh targets")?
    };
    app.state::<ManagerState>()
        .with(session, workspace, |slot| {
            slot.target = Some(target.clone());
            slot.revision += 1;
            slot.capture = None;
            let _ = app.emit(
                "gyro:app-preview-changed",
                json!({"sessionId":session,"workspace":workspace,"target":target}),
            );
            Ok(())
        })?;
    if target.kind != "web" {
        let _ = session_browser::set_session_browser_visible(app, session, false);
    }
    Ok(target)
}
fn current_target(target: &Target) -> Result<Target, String> {
    if target.kind == "web" {
        return Ok(target.clone());
    }
    #[cfg(target_os = "macos")]
    {
        let all = if target.kind == "simulator" {
            simulator::targets()?
        } else {
            platform::windows()?
        };
        return all
            .into_iter()
            .find(|t| t.id == target.id)
            .ok_or("Runtime disconnected; capture is stale".into());
    }
    #[cfg(not(target_os = "macos"))]
    Err("Native previews require macOS".into())
}
pub fn capture<R: Runtime>(
    app: &AppHandle<R>,
    session: &str,
    workspace: &str,
) -> Result<Value, String> {
    let (mut target, revision) = app.state::<ManagerState>().with(session, workspace, |s| {
        s.revision += 1;
        s.capture = None;
        Ok((s.target.clone().unwrap_or_else(web_target), s.revision))
    })?;
    let mut web_capture_id = None;
    let (png, width, height) = if target.kind == "web" {
        let owned = app
            .state::<session_browser::SessionBrowserManager>()
            .require_owned(session, workspace)?;
        let before = session_browser::call_agent(app, session, "status", json!({}))?;
        let shot = session_browser::capture_session_browser_png(app, session)?;
        let after = session_browser::call_agent(app, session, "status", json!({}))?;
        if before.get("url") != after.get("url") || before.get("viewport") != after.get("viewport")
        {
            return Err("Web page changed during capture; capture again".into());
        }
        target.width = after["viewport"]["width"]
            .as_f64()
            .ok_or("Missing web viewport")?;
        target.height = after["viewport"]["height"]
            .as_f64()
            .ok_or("Missing web viewport")?;
        target.title = owned.title;
        let id = format!("preview-web-{}", uuid::Uuid::new_v4());
        app.state::<session_browser::SessionBrowserManager>()
            .remember_pointer_capture(session, id.clone(), owned.url, after["viewport"].clone())?;
        web_capture_id = Some(id);
        (shot.png, shot.width, shot.height)
    } else {
        target = current_target(&target)?;
        #[cfg(target_os = "macos")]
        {
            let shot = if target.kind == "simulator" {
                simulator_capture(&target)?
            } else {
                platform::capture(&target)?
            };
            if current_target(&target)? != target {
                return Err("Runtime moved or changed during capture; capture again".into());
            }
            if target.kind == "simulator" {
                target.width = f64::from(shot.1);
                target.height = f64::from(shot.2);
            }
            shot
        }
        #[cfg(not(target_os = "macos"))]
        return Err("Native previews require macOS".into());
    };
    use sha2::{Digest, Sha256};
    let digest = (target.kind != "web").then(|| Sha256::digest(&png).to_vec());
    let raw_frame = Frame {
        x: 0., y: 0., width: f64::from(width), height: f64::from(height),
        image_width: width, image_height: height,
    };
    #[cfg(target_os = "macos")]
    let (png, frame) = if target.kind != "web" {
        (png, raw_frame)
    } else {
        platform::frame(&png, width, height, target.kind == "web" && target.width < 500.)?
    };
    #[cfg(not(target_os = "macos"))]
    let frame = raw_frame;
    let paths = gyro_core::GyroPaths::for_current_user().map_err(|e| e.to_string())?;
    let mut saved: BrowserPreviewCapture =
        crate::browser::preview::persist_browser_preview_capture(
            &paths,
            &png,
            frame.image_width,
            frame.image_height,
            chrono::Utc::now(),
        )?;
    saved.title = Some(target.title.clone());
    saved.resource_id = Some(format!("preview:{session}:{}", target.id));
    let reference = Reference {
        id: saved.filename.clone(),
        target: target.clone(),
        frame: frame.clone(),
        created: Instant::now(),
        web_capture_id,
        revision,
        digest,
    };
    let observation = json!({
        "schema":crate::browser::types::BROWSER_OBSERVATION_SCHEMA_V1,
        "owner":{"sessionId":session,"workspace":workspace},
        "target":target,"screenshot":saved,"contentRect":frame,
        "coordinateSpace":"framed-image-pixels","capturedAt":saved.created_at,
        "status":"captured","expiresAfterMs":15000,
        "interaction":if target.kind=="simulator" {"capture-only; use Simulator for native input"} else {"click"},
        "framing":if target.kind!="web" {"device-pixels"} else {crate::browser::types::BROWSER_OBSERVATION_FRAMING},
        "evidence":{"runtime":target.kind,"liveStream":false,"screenshotModelVisible":false}
    });
    app.state::<ManagerState>()
        .with(session, workspace, |slot| {
            if slot.revision != revision {
                return Err("Selected target changed during capture".into());
            }
            slot.capture = Some(reference);
            let _ = app.emit("gyro:app-preview-captured", &observation);
            Ok(())
        })?;
    Ok(observation)
}
pub fn click<R: Runtime>(
    app: &AppHandle<R>,
    session: &str,
    workspace: &str,
    id: &str,
    x: f64,
    y: f64,
) -> Result<Value, String> {
    // Serialize selection/capture invalidation with input. A target change cannot
    // slip between checking the capture and dispatching the event.
    app.state::<ManagerState>().with(session,workspace,|slot| {
        let reference = slot.capture.clone().ok_or("Capture the selected target before interacting")?;
        reference.validate(id, slot.revision)?;
        let (x,y) = reference.frame.point(x,y,&reference.target)?;
        if reference.target.kind == "web" {
            crate::browser_pointer::execute(app,session,"Gyro",&json!({
                "action":"click","captureId":reference.web_capture_id,"x":x,"y":y
            }))?;
        } else {
            if reference.target.kind == "simulator" {
                return Err("Simulator input is unavailable: simctl provides screenshots, not supported touch injection. Interact in Simulator and refresh.".into());
            }
            if current_target(&reference.target)? != reference.target {
                return Err("Window moved, resized or disconnected; capture again".into());
            }
            #[cfg(target_os = "macos")]
            {
                use sha2::{Digest,Sha256};
                let (current,_,_) = platform::capture(&reference.target)?;
                if reference.digest.as_deref() != Some(Sha256::digest(&current).as_slice()) {
                    return Err("Window content changed since capture; capture again".into());
                }
                platform::click(&reference.target,x,y)?;
            }
            #[cfg(not(target_os = "macos"))]
            return Err("Native previews require macOS".into());
        }
        slot.capture=None;
        Ok(json!({"target":reference.target,"inputDispatched":true,"verification":"Capture again to verify the result","status":"stale"}))
    })
}
#[cfg(target_os = "macos")]
fn simulator_capture(target: &Target) -> Result<(Vec<u8>, u32, u32), String> {
    let udid = simulator::udid(target)?;
    let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    let path = dir.path().join("screen.png");
    simulator::command(
        None,
        &[
            "simctl",
            "io",
            udid,
            "screenshot",
            "--type=png",
            path.to_str().ok_or("Invalid capture path")?,
        ],
        15,
    )?;
    let png = std::fs::read(path).map_err(|e| e.to_string())?;
    let (w, h) = platform::png_dimensions(&png)?;
    Ok((png, w, h))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewOptions {
    project: Option<String>,
    scheme: Option<String>,
    region: Option<PixelRegion>,
    xcode_path: Option<String>,
}

#[derive(Clone, Copy, Deserialize)]
pub(super) struct PixelRegion {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

impl PixelRegion {
    fn is_inside(self, width: u32, height: u32) -> bool {
        self.width > 0 && self.height > 0
            && self.x.checked_add(self.width).is_some_and(|end| end <= width)
            && self.y.checked_add(self.height).is_some_and(|end| end <= height)
    }
}

#[cfg(target_os = "macos")]
fn project_root(session: &str, workspace: &str) -> Result<std::path::PathBuf, String> {
    let requested = std::path::Path::new(workspace);
    if !requested.is_absolute() {
        return Err("Open the app’s project folder in Gyro first".into());
    }
    let root = requested.canonicalize().map_err(|e| e.to_string())?;
    if let Some(owner) = session.strip_prefix("workbench:") {
        if owner != workspace {
            return Err("Preview project does not belong to this workspace".into());
        }
    } else {
        let store = crate::stores::open_store()?;
        let chat = store.get_session(crate::stores::parse_uuid(session)?)
            .map_err(crate::stores::to_string)?.ok_or("The preview chat no longer exists")?;
        if chat.workspace_path.as_os_str().is_empty()
            || crate::providers::binding::session_execution_workspace(&chat, store.paths())? != root
        {
            return Err("Preview project does not belong to this chat".into());
        }
    }
    Ok(root)
}

#[cfg(target_os = "macos")]
fn run_simulator(
    app: &AppHandle, session: &str, workspace: &str, options: PreviewOptions,
) -> Result<Value, String> {
    use sha2::{Digest, Sha256};
    let root = project_root(session, workspace)?;
    let state = app.state::<ManagerState>();
    let _build = state.build.try_lock().map_err(|_| "A Simulator build is already running")?;
    let (target, revision) = state.with(session, workspace, |slot| {
        let target = slot.target.clone().filter(|target| target.kind == "simulator")
            .ok_or("Select an iPhone or iPad Simulator")?;
        slot.revision += 1;
        slot.capture = None;
        Ok((target, slot.revision))
    })?;
    let cache_key = format!("{:x}", Sha256::digest(root.as_os_str().as_encoded_bytes()));
    let derived = app.path().app_cache_dir().map_err(|e| e.to_string())?
        .join("simulator-derived-data").join(cache_key);
    let project = options.project.as_deref().ok_or("Choose an Xcode project")?;
    let scheme = options.scheme.as_deref().ok_or("Choose an Xcode scheme")?;
    simulator::run(&root, &derived, &target, project, scheme, |phase| {
        let _ = app.emit("gyro:app-preview-build", json!({
            "sessionId":session, "workspace":workspace, "targetId":target.id, "phase":phase,
        }));
    })?;
    let available = current_target(&target)?;
    state.with(session, workspace, |slot| {
        if slot.revision != revision {
            return Err("Preview selection changed during the Simulator build".into());
        }
        slot.target = Some(available);
        Ok(())
    })?;
    capture(app, session, workspace)
}

/// Transient preview pixels stay in memory. Only explicit captures enter the
/// persisted capture queue, so auto-refresh cannot prune a comparison baseline.
#[cfg(target_os = "macos")]
fn simulator_frame(app: &AppHandle, session: &str, workspace: &str) -> Result<Value, String> {
    use base64::Engine as _;
    let target = selected(app, session, workspace)?;
    if target.kind != "simulator" {
        return Err("Select a Simulator device to refresh its screen".into());
    }
    let (png, width, height) = simulator_capture(&target)?;
    if png.len() > crate::app::limits::MAX_BROWSER_PREVIEW_CAPTURE_BYTES {
        return Err("The Simulator frame exceeded the capture limit".into());
    }
    if selected(app, session, workspace)?.id != target.id {
        return Err("Preview selection changed during refresh".into());
    }
    let src = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png));
    Ok(json!({
        "target": target,
        "screenshot": {
            "path": "", "filename": "",
            "width":width, "height":height, "src":src,
            "createdAt":chrono::Utc::now().to_rfc3339(),
        },
        "contentRect": {"x":0, "y":0, "width":width, "height":height},
        "expiresAfterMs":0, "interaction":"capture-only",
    }))
}

#[cfg(target_os = "macos")]
fn crop_capture(app: &AppHandle, session: &str, workspace: &str, id: &str, region: PixelRegion) -> Result<Value, String> {
    let reference = app.state::<ManagerState>().with(session, workspace, |slot| {
        // Annotation freezes the selected image. The input expiry is for clicks,
        // not for the time someone spends writing feedback about frozen pixels.
        slot.capture.clone().filter(|capture| capture.id == id && capture.revision == slot.revision
            && capture.target.kind != "web").ok_or_else(|| "Preview changed. Select the region again.".into())
    })?;
    if !region.is_inside(reference.frame.image_width, reference.frame.image_height)
        || f64::from(region.x) < reference.frame.x || f64::from(region.y) < reference.frame.y
        || f64::from(region.x + region.width) > reference.frame.x + reference.frame.width
        || f64::from(region.y + region.height) > reference.frame.y + reference.frame.height
    {
        return Err("Select a region inside the app screen".into());
    }
    let paths = gyro_core::GyroPaths::for_current_user().map_err(|e| e.to_string())?;
    let path = paths.browser_captures_dir.join(id);
    let (png, _) = crate::workspace::files::read_bounded_regular_file(
        &path, crate::app::limits::MAX_BROWSER_PREVIEW_CAPTURE_BYTES, "app preview capture",
    ).map_err(|_| "The preview capture is unavailable")?;
    let cropped = platform::crop(&png, region)?;
    let saved = crate::browser::preview::persist_browser_preview_capture(
        &paths, &cropped, region.width, region.height, chrono::Utc::now(),
    )?;
    serde_json::to_value(saved).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn app_preview_request(
    app: AppHandle,
    session_id: String,
    workspace_key: String,
    action: String,
    target_id: Option<String>,
    capture_id: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    options: Option<PreviewOptions>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || match action.as_str() {
        "targets" => targets(&app, &session_id, &workspace_key),
        #[cfg(target_os = "macos")]
        "xcode-setup" => serde_json::to_value(xcode::setup()).map_err(|e| e.to_string()),
        #[cfg(target_os = "macos")]
        "choose-xcode" => {
            let state = app.state::<ManagerState>();
            let _build = state.build.try_lock().map_err(|_| "Wait for the Simulator build to finish before switching Xcode")?;
            let path = options.and_then(|options| options.xcode_path).ok_or("Choose Xcode")?;
            xcode::choose(std::path::Path::new(&path))?;
            Ok(Value::Null)
        }
        #[cfg(target_os = "macos")]
        "open-xcode" => {
            xcode::open()?;
            Ok(Value::Null)
        }
        "select" => select(
            &app,
            &session_id,
            &workspace_key,
            target_id.as_deref().ok_or("Target required")?,
        )
        .and_then(|t| serde_json::to_value(t).map_err(|e| e.to_string())),
        "capture" => capture(&app, &session_id, &workspace_key),
        #[cfg(target_os = "macos")]
        "simulator-frame" => simulator_frame(&app, &session_id, &workspace_key),
        #[cfg(target_os = "macos")]
        "schemes" => {
            let root = project_root(&session_id, &workspace_key)?;
            serde_json::to_value(simulator::schemes(&root)?).map_err(|e| e.to_string())
        }
        #[cfg(target_os = "macos")]
        "run" => run_simulator(&app, &session_id, &workspace_key, options.ok_or("Choose an Xcode scheme")?),
        #[cfg(target_os = "macos")]
        "open-device" => {
            let target = selected(&app, &session_id, &workspace_key)?;
            simulator::open_device(&current_target(&target)?)?;
            Ok(Value::Null)
        }
        #[cfg(target_os = "macos")]
        "crop" => crop_capture(&app, &session_id, &workspace_key, capture_id.as_deref().ok_or("Capture required")?,
            options.and_then(|options| options.region).ok_or("Select a region")?),
        "click" => click(
            &app,
            &session_id,
            &workspace_key,
            capture_id.as_deref().ok_or("Capture required")?,
            x.ok_or("X required")?,
            y.ok_or("Y required")?,
        ),
        _ => Err("Unknown preview action".into()),
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frame_maps_retina_and_rejects_surrounds() {
        let frame = Frame {
            x: 10.,
            y: 26.,
            width: 800.,
            height: 600.,
            image_width: 820,
            image_height: 636,
        };
        let mut t = web_target();
        t.width = 400.;
        t.height = 300.;
        assert_eq!(frame.point(410., 326., &t).unwrap(), (200., 150.));
        for (x, y) in [
            (9., 26.),
            (10., 25.),
            (810., 26.),
            (10., 626.),
            (f64::NAN, 30.),
        ] {
            assert!(frame.point(x, y, &t).is_err());
        }
    }
    #[test]
    fn native_pixel_region_is_exact_and_cannot_overflow() {
        let region = PixelRegion { x: 920, y: 225, width: 240, height: 83 };
        assert!(region.is_inside(1206, 2622));
        assert!(!PixelRegion { x: 1206, ..region }.is_inside(1206, 2622));
        assert!(!PixelRegion { width: u32::MAX, ..region }.is_inside(1206, 2622));
        assert!(!PixelRegion { height: 0, ..region }.is_inside(1206, 2622));
    }
    #[test]
    fn capture_identity_revision_and_expiry_are_required() {
        let mut reference = Reference {
            id: "a".into(),
            target: web_target(),
            frame: Frame {
                x: 1.,
                y: 1.,
                width: 20.,
                height: 20.,
                image_width: 22,
                image_height: 22,
            },
            created: Instant::now(),
            web_capture_id: None,
            revision: 2,
            digest: None,
        };
        assert!(reference.validate("a", 2).is_ok());
        assert!(reference.validate("b", 2).is_err());
        assert!(reference.validate("a", 3).is_err());
        reference.created = Instant::now() - Duration::from_secs(16);
        assert!(reference.validate("a", 2).is_err());
    }
    #[test]
    fn ownership_is_not_shared_between_workspaces_or_sessions() {
        let manager = ManagerState::default();
        assert!(manager.with("a", "one", |_| Ok(())).is_ok());
        assert!(manager.with("a", "two", |_| Ok(())).is_err());
        assert!(manager.with("b", "two", |_| Ok(())).is_ok());
    }
}
