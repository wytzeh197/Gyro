use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};
use std::time::Duration;
#[cfg(target_os = "macos")]
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};

pub const MENU_BAR_STATUS_EVENT: &str = "gyro://menu-bar-status";
pub const MENU_BAR_NAVIGATION_EVENT: &str = "gyro://menu-bar-navigation";

#[cfg(target_os = "macos")]
const MENU_BAR_TRAY_ID: &str = "gyro-menu-bar";
#[cfg(target_os = "macos")]
const MENU_BAR_POPOVER_LABEL: &str = "menu-bar-popover";
/// Window geometry mirrors the token block in `menu-bar.css`; change both
/// together. The window is transparent and the card's drop shadow is drawn in
/// CSS, so the window carries a transparent gutter for the shadow to land in —
/// without it macOS clips the shadow square against the window edge. The
/// shadow points down, hence the asymmetry; the top gutter also serves as the
/// gap between the menu bar and the card, so the popover is positioned flush
/// under the tray icon.
#[cfg(target_os = "macos")]
const MENU_BAR_GUTTER_TOP: f64 = 8.0;
#[cfg(target_os = "macos")]
const MENU_BAR_GUTTER_X: f64 = 16.0;
#[cfg(target_os = "macos")]
const MENU_BAR_GUTTER_BOTTOM: f64 = 24.0;
#[cfg(target_os = "macos")]
const MENU_BAR_CARD_WIDTH: f64 = 372.0;
#[cfg(target_os = "macos")]
const MENU_BAR_POPOVER_WIDTH: f64 = MENU_BAR_CARD_WIDTH + MENU_BAR_GUTTER_X * 2.0;
#[cfg(target_os = "macos")]
const MENU_BAR_HEADER_HEIGHT: f64 = 64.0;
#[cfg(target_os = "macos")]
const MENU_BAR_ROW_HEIGHT: f64 = 60.0;
#[cfg(target_os = "macos")]
const MENU_BAR_OVERFLOW_HEIGHT: f64 = 32.0;
#[cfg(target_os = "macos")]
const MENU_BAR_FOOTER_HEIGHT: f64 = 44.0;
/// Kept in step with the same cap in `MenuBarPopover.tsx`; jobs past it are
/// summarised by the "+N more" row.
#[cfg(target_os = "macos")]
const MENU_BAR_MAX_VISIBLE_JOBS: usize = 4;
/// A tray press that dismisses the popover also blurs it, so the blur handler
/// closes the window before the tray click arrives. Within this window the
/// pending tray press is treated as the close, not as a fresh open.
#[cfg(target_os = "macos")]
const MENU_BAR_POPOVER_REOPEN_GUARD: Duration = Duration::from_millis(250);
#[cfg(target_os = "macos")]
static MENU_BAR_POPOVER_DISMISSED_AT: Mutex<Option<Instant>> = Mutex::new(None);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MenuBarSnapshotState {
    Idle,
    Working,
    Attention,
    Complete,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuBarJob {
    pub id: String,
    pub kind: String,
    pub target_id: String,
    pub title: String,
    pub detail: String,
    pub status: String,
    pub started_at: String,
    pub can_stop: bool,
    pub provider_id: Option<String>,
    pub provider_label: Option<String>,
    pub model_id: Option<String>,
    pub model_label: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuBarOutcome {
    pub id: String,
    pub kind: String,
    pub target_id: String,
    pub title: String,
    pub detail: String,
    pub status: String,
    pub finished_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuBarSnapshot {
    pub state: MenuBarSnapshotState,
    pub jobs: Vec<MenuBarJob>,
    pub total_active: usize,
    pub recent_outcome: Option<MenuBarOutcome>,
    pub theme: String,
    pub reduce_motion: bool,
}

impl Default for MenuBarSnapshot {
    fn default() -> Self {
        Self {
            state: MenuBarSnapshotState::Idle,
            jobs: Vec::new(),
            total_active: 0,
            recent_outcome: None,
            theme: "dark".into(),
            reduce_motion: false,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MenuBarTarget {
    pub kind: String,
    pub id: String,
}

#[cfg(target_os = "macos")]
struct MenuBarIcons {
    idle: tauri::image::Image<'static>,
    working: tauri::image::Image<'static>,
    attention: tauri::image::Image<'static>,
    complete: tauri::image::Image<'static>,
}

#[cfg(target_os = "macos")]
impl MenuBarIcons {
    fn load() -> Self {
        fn png(bytes: &'static [u8]) -> tauri::image::Image<'static> {
            tauri::image::Image::from_bytes(bytes)
                .expect("embedded Gyro menu bar icon must be valid PNG")
                .to_owned()
        }
        Self {
            idle: png(include_bytes!("../icons/menubar/gyro-idle.png")),
            working: png(include_bytes!("../icons/menubar/gyro-working-0.png")),
            attention: png(include_bytes!("../icons/menubar/gyro-attention.png")),
            complete: png(include_bytes!("../icons/menubar/gyro-complete.png")),
        }
    }
}

pub struct MenuBarController {
    snapshot: Mutex<MenuBarSnapshot>,
    display_state: Mutex<MenuBarSnapshotState>,
    acknowledged_outcome_id: Mutex<Option<String>>,
    completion_generation: AtomicU64,
    visible: AtomicBool,
    #[cfg(target_os = "macos")]
    icons: MenuBarIcons,
}

impl Default for MenuBarController {
    fn default() -> Self {
        Self {
            snapshot: Mutex::new(MenuBarSnapshot::default()),
            display_state: Mutex::new(MenuBarSnapshotState::Idle),
            acknowledged_outcome_id: Mutex::new(None),
            completion_generation: AtomicU64::new(0),
            visible: AtomicBool::new(true),
            #[cfg(target_os = "macos")]
            icons: MenuBarIcons::load(),
        }
    }
}

impl MenuBarController {
    fn public_snapshot(&self) -> MenuBarSnapshot {
        let mut snapshot = self
            .snapshot
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default();
        if let Ok(state) = self.display_state.lock() {
            snapshot.state = *state;
        }
        snapshot
    }

    fn effective_state(&self, snapshot: &MenuBarSnapshot) -> MenuBarSnapshotState {
        if snapshot.jobs.iter().any(|job| job.status == "waiting") {
            return MenuBarSnapshotState::Attention;
        }
        if !snapshot.jobs.is_empty() {
            return MenuBarSnapshotState::Working;
        }
        if let Some(outcome) = snapshot.recent_outcome.as_ref() {
            if outcome.status == "failed" {
                let acknowledged = self
                    .acknowledged_outcome_id
                    .lock()
                    .ok()
                    .and_then(|value| value.clone());
                if acknowledged.as_deref() != Some(outcome.id.as_str()) {
                    return MenuBarSnapshotState::Attention;
                }
                return MenuBarSnapshotState::Idle;
            }
        }
        if snapshot.state == MenuBarSnapshotState::Complete {
            MenuBarSnapshotState::Complete
        } else {
            MenuBarSnapshotState::Idle
        }
    }

    fn set_snapshot(&self, app: &AppHandle, snapshot: MenuBarSnapshot) {
        let state = self.effective_state(&snapshot);
        if let Ok(mut stored) = self.snapshot.lock() {
            *stored = snapshot;
        }
        if let Ok(mut display_state) = self.display_state.lock() {
            *display_state = state;
        }
        let generation = self.completion_generation.fetch_add(1, Ordering::AcqRel) + 1;
        if state == MenuBarSnapshotState::Complete {
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(3));
                let controller = app.state::<MenuBarController>();
                if controller.completion_generation.load(Ordering::Acquire) != generation {
                    return;
                }
                if let Ok(mut display_state) = controller.display_state.lock() {
                    *display_state = MenuBarSnapshotState::Idle;
                }
                update_native_presentation(&app);
                emit_snapshot(&app);
            });
        }
        update_native_presentation(app);
        resize_popover(app);
        emit_snapshot(app);
    }

    fn acknowledge_recent_outcome(&self, app: &AppHandle) {
        let snapshot = self
            .snapshot
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default();
        if let Some(outcome) = snapshot.recent_outcome.as_ref() {
            if outcome.status == "failed" {
                if let Ok(mut acknowledged) = self.acknowledged_outcome_id.lock() {
                    *acknowledged = Some(outcome.id.clone());
                }
            }
        }
        if let Ok(mut state) = self.display_state.lock() {
            *state = self.effective_state(&snapshot);
        }
        update_native_presentation(app);
        emit_snapshot(app);
    }
}

fn emit_snapshot(app: &AppHandle) {
    let snapshot = app.state::<MenuBarController>().public_snapshot();
    if let Err(error) = app.emit(MENU_BAR_STATUS_EVENT, snapshot) {
        eprintln!("could not emit Gyro menu bar status: {error}");
    }
}

#[cfg(target_os = "macos")]
fn popover_height(snapshot: &MenuBarSnapshot) -> f64 {
    let visible_jobs = snapshot.jobs.len().min(MENU_BAR_MAX_VISIBLE_JOBS);
    // With no jobs the popover shows a single recent-outcome or empty row.
    let content = if visible_jobs > 0 {
        visible_jobs as f64 * MENU_BAR_ROW_HEIGHT
            + if snapshot.jobs.len() > MENU_BAR_MAX_VISIBLE_JOBS {
                MENU_BAR_OVERFLOW_HEIGHT
            } else {
                0.0
            }
    } else {
        MENU_BAR_ROW_HEIGHT
    };
    MENU_BAR_GUTTER_TOP
        + MENU_BAR_HEADER_HEIGHT
        + content
        + MENU_BAR_FOOTER_HEIGHT
        + MENU_BAR_GUTTER_BOTTOM
}

#[cfg(target_os = "macos")]
fn resize_popover(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MENU_BAR_POPOVER_LABEL) else {
        return;
    };
    let height = popover_height(&app.state::<MenuBarController>().public_snapshot());
    let _ = window.set_size(tauri::LogicalSize::new(MENU_BAR_POPOVER_WIDTH, height));
}

#[cfg(not(target_os = "macos"))]
fn resize_popover(_app: &AppHandle) {}

#[cfg(target_os = "macos")]
fn update_native_presentation(app: &AppHandle) {
    let controller = app.state::<MenuBarController>();
    let snapshot = controller.public_snapshot();
    let Some(tray) = app.tray_by_id(MENU_BAR_TRAY_ID) else {
        return;
    };
    let icon = match snapshot.state {
        MenuBarSnapshotState::Working => &controller.icons.working,
        MenuBarSnapshotState::Attention => &controller.icons.attention,
        MenuBarSnapshotState::Complete => &controller.icons.complete,
        MenuBarSnapshotState::Idle => &controller.icons.idle,
    };
    let tooltip = match snapshot.state {
        MenuBarSnapshotState::Working => format!(
            "Gyro — Working on {} {}",
            snapshot.total_active,
            if snapshot.total_active == 1 {
                "job"
            } else {
                "jobs"
            }
        ),
        MenuBarSnapshotState::Attention => "Gyro — Needs attention".into(),
        MenuBarSnapshotState::Complete => "Gyro — Work complete".into(),
        MenuBarSnapshotState::Idle => "Gyro — Ready".into(),
    };
    let _ = tray.set_icon_with_as_template(Some(icon.clone()), true);
    let _ = tray.set_tooltip(Some(tooltip));
    let _ = tray.set_visible(controller.visible.load(Ordering::Acquire));
}

#[cfg(not(target_os = "macos"))]
fn update_native_presentation(_app: &AppHandle) {}

#[cfg(target_os = "macos")]
fn position_popover(app: &AppHandle, rect: tauri::Rect, pointer: tauri::PhysicalPosition<f64>) {
    let Some(window) = app.get_webview_window(MENU_BAR_POPOVER_LABEL) else {
        return;
    };
    let monitor = app
        .monitor_from_point(pointer.x, pointer.y)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    let scale = monitor.scale_factor();
    let icon_position = rect.position.to_physical::<f64>(scale);
    let icon_size = rect.size.to_physical::<f64>(scale);
    let popup_width = MENU_BAR_POPOVER_WIDTH * scale;
    let work_area = monitor.work_area();
    // The window's side gutters are transparent, so the screen margin is
    // measured against the visible card rather than the window box.
    let edge_margin = (8.0 - MENU_BAR_GUTTER_X) * scale;
    let work_left = work_area.position.x as f64 + edge_margin;
    let work_right =
        (work_area.position.x as f64 + work_area.size.width as f64) - popup_width - edge_margin;
    let x = (icon_position.x + icon_size.width / 2.0 - popup_width / 2.0)
        .clamp(work_left, work_right.max(work_left));
    // MENU_BAR_GUTTER_TOP is the visible gap between the tray icon and the card.
    let y = icon_position.y + icon_size.height;
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
}

#[cfg(target_os = "macos")]
fn toggle_popover(app: &AppHandle, rect: tauri::Rect, pointer: tauri::PhysicalPosition<f64>) {
    let Some(window) = app.get_webview_window(MENU_BAR_POPOVER_LABEL) else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return;
    }
    if took_recent_outside_dismiss() {
        return;
    }
    resize_popover(app);
    position_popover(app, rect, pointer);
    let _ = window.show();
    let _ = window.set_focus();
    app.state::<MenuBarController>()
        .acknowledge_recent_outcome(app);
}

#[cfg(target_os = "macos")]
fn hide_popover(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MENU_BAR_POPOVER_LABEL) {
        let _ = window.hide();
    }
}

#[cfg(not(target_os = "macos"))]
fn hide_popover(_app: &AppHandle) {}

#[cfg(target_os = "macos")]
fn note_outside_dismiss() {
    if let Ok(mut dismissed_at) = MENU_BAR_POPOVER_DISMISSED_AT.lock() {
        *dismissed_at = Some(Instant::now());
    }
}

#[cfg(target_os = "macos")]
fn took_recent_outside_dismiss() -> bool {
    let Ok(mut dismissed_at) = MENU_BAR_POPOVER_DISMISSED_AT.lock() else {
        return false;
    };
    dismissed_at
        .take()
        .is_some_and(|at| at.elapsed() < MENU_BAR_POPOVER_REOPEN_GUARD)
}

/// Closes the menu bar popover as soon as the press lands anywhere outside it,
/// which on macOS surfaces as the popover window losing focus.
pub fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    #[cfg(target_os = "macos")]
    {
        if window.label() != MENU_BAR_POPOVER_LABEL {
            return;
        }
        if matches!(event, tauri::WindowEvent::Focused(false))
            && window.is_visible().unwrap_or(false)
        {
            note_outside_dismiss();
            let _ = window.hide();
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, event);
    }
}

fn restore_and_focus_main_window(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        crate::restore_main_window(app).map_err(|error| error.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn open_target(app: &AppHandle, target: MenuBarTarget) -> Result<(), String> {
    restore_and_focus_main_window(app)?;
    app.emit_to("main", MENU_BAR_NAVIGATION_EVENT, target)
        .map_err(|error| error.to_string())?;
    hide_popover(app);
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn setup(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let popover = tauri::WebviewWindowBuilder::new(
        app,
        MENU_BAR_POPOVER_LABEL,
        tauri::WebviewUrl::App("index.html?surface=menu-bar".into()),
    )
    .title("Gyro Status")
    .inner_size(MENU_BAR_POPOVER_WIDTH, 200.0)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .visible(false)
    .focused(false)
    .build()?;
    let _ = popover.set_focusable(true);

    let open_item = MenuItem::with_id(app, "gyro-menu-open", "Open Gyro", true, None::<&str>)?;
    let settings_item =
        MenuItem::with_id(app, "gyro-menu-settings", "Settings…", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "gyro-menu-quit", "Quit Gyro", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_item, &settings_item, &separator, &quit_item])?;
    let idle_icon = app.state::<MenuBarController>().icons.idle.clone();

    TrayIconBuilder::with_id(MENU_BAR_TRAY_ID)
        .icon(idle_icon)
        .icon_as_template(true)
        .tooltip("Gyro — Ready")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "gyro-menu-open" => {
                let _ = restore_and_focus_main_window(app);
                hide_popover(app);
            }
            "gyro-menu-settings" => {
                let _ = open_target(
                    app,
                    MenuBarTarget {
                        kind: "settings".into(),
                        id: "general".into(),
                    },
                );
            }
            "gyro-menu-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                position,
                ..
            } = event
            {
                toggle_popover(tray.app_handle(), rect, position);
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn setup(_app: &mut tauri::App) -> tauri::Result<()> {
    Ok(())
}

#[tauri::command]
pub fn set_menu_bar_snapshot(
    app: AppHandle,
    controller: tauri::State<'_, MenuBarController>,
    snapshot: MenuBarSnapshot,
) {
    controller.set_snapshot(&app, snapshot);
}

#[tauri::command]
pub fn get_menu_bar_snapshot(controller: tauri::State<'_, MenuBarController>) -> MenuBarSnapshot {
    controller.public_snapshot()
}

#[tauri::command]
pub fn set_menu_bar_visible(
    app: AppHandle,
    controller: tauri::State<'_, MenuBarController>,
    visible: bool,
) {
    controller.visible.store(visible, Ordering::Release);
    if !visible {
        hide_popover(&app);
    }
    update_native_presentation(&app);
}

#[tauri::command]
pub fn show_main_window(app: AppHandle) -> Result<(), String> {
    restore_and_focus_main_window(&app)?;
    hide_popover(&app);
    Ok(())
}

#[tauri::command]
pub fn hide_menu_bar_popover(app: AppHandle) {
    hide_popover(&app);
}

#[tauri::command]
pub fn open_menu_bar_target(app: AppHandle, target: MenuBarTarget) -> Result<(), String> {
    open_target(&app, target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot_with_jobs(statuses: &[&str]) -> MenuBarSnapshot {
        MenuBarSnapshot {
            jobs: statuses
                .iter()
                .enumerate()
                .map(|(index, status)| MenuBarJob {
                    id: format!("job-{index}"),
                    kind: "chat".into(),
                    target_id: format!("session-{index}"),
                    title: "Chat".into(),
                    detail: "Working".into(),
                    status: (*status).into(),
                    started_at: "2026-07-19T10:00:00Z".into(),
                    can_stop: true,
                    provider_id: Some("openai".into()),
                    provider_label: Some("OpenAI".into()),
                    model_id: Some("gpt-5.6-sol".into()),
                    model_label: Some("GPT-5.6 Sol".into()),
                })
                .collect(),
            total_active: statuses.len(),
            ..MenuBarSnapshot::default()
        }
    }

    #[test]
    fn menu_bar_job_keeps_model_identity_in_snapshot_json() {
        let snapshot = snapshot_with_jobs(&["finished"]);
        let json = serde_json::to_value(snapshot).expect("snapshot should serialize");
        let job = &json["jobs"][0];

        assert_eq!(job["providerId"], "openai");
        assert_eq!(job["providerLabel"], "OpenAI");
        assert_eq!(job["modelId"], "gpt-5.6-sol");
        assert_eq!(job["modelLabel"], "GPT-5.6 Sol");
    }

    #[test]
    fn waiting_job_takes_attention_precedence() {
        let controller = MenuBarController::default();
        assert_eq!(
            controller.effective_state(&snapshot_with_jobs(&["running", "waiting"])),
            MenuBarSnapshotState::Attention
        );
    }

    #[test]
    fn running_jobs_are_working() {
        let controller = MenuBarController::default();
        assert_eq!(
            controller.effective_state(&snapshot_with_jobs(&["running"])),
            MenuBarSnapshotState::Working
        );
    }

    #[test]
    fn acknowledged_failure_returns_to_idle() {
        let controller = MenuBarController::default();
        let snapshot = MenuBarSnapshot {
            state: MenuBarSnapshotState::Attention,
            recent_outcome: Some(MenuBarOutcome {
                id: "failure-1".into(),
                kind: "chat".into(),
                target_id: "session-1".into(),
                title: "Chat".into(),
                detail: "Failed".into(),
                status: "failed".into(),
                finished_at: "2026-07-19T10:00:00Z".into(),
            }),
            ..MenuBarSnapshot::default()
        };
        assert_eq!(
            controller.effective_state(&snapshot),
            MenuBarSnapshotState::Attention
        );
        *controller.acknowledged_outcome_id.lock().unwrap() = Some("failure-1".into());
        assert_eq!(
            controller.effective_state(&snapshot),
            MenuBarSnapshotState::Idle
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn popover_height_caps_visible_jobs() {
        // gutters 8 + 24, header 64, footer 44 -> 140 plus the rows.
        assert_eq!(popover_height(&snapshot_with_jobs(&[])), 200.0);
        assert_eq!(popover_height(&snapshot_with_jobs(&["running"])), 200.0);
        assert_eq!(
            popover_height(&snapshot_with_jobs(&["running", "running"])),
            260.0
        );
        // Capped at four rows, plus the 32px "+N more" row.
        assert_eq!(
            popover_height(&snapshot_with_jobs(&[
                "running", "running", "running", "running", "running"
            ])),
            412.0
        );
    }
}
