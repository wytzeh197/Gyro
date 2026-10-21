//! Window chrome for the macOS main window.
//!
//! AppKit paints the traffic-light glyph as a fixed 12px circle inside a 14px
//! button frame, and resizing those frames (16–22px, measured on a live
//! `NSWindow`) leaves the painted dot byte-identically 12px. A native control
//! can therefore neither match the 15px of the header icons nor be moved onto
//! their centreline: only its position is addressable.
//!
//! Gyro hides the native buttons and draws its own 15px dots in the webview
//! (`apps/desktop/src/window-controls.tsx` plus its stylesheet), where the
//! same layout engine that places the header buttons sizes and centres them.
//! Clicks come back through [`main_window_action`]. Hiding rather than
//! removing the AppKit buttons keeps Cmd+W / Cmd+M working from the menu bar
//! and leaves VoiceOver's window actions intact.

/// A request from one of the webview's own titlebar dots.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WindowAction {
    Close,
    Minimize,
    Zoom,
}

impl WindowAction {
    pub(crate) fn parse(raw: &str) -> Option<Self> {
        match raw {
            "close" => Some(Self::Close),
            "minimize" => Some(Self::Minimize),
            "zoom" => Some(Self::Zoom),
            _ => None,
        }
    }

    fn verb(self) -> &'static str {
        match self {
            Self::Close => "close",
            Self::Minimize => "minimize",
            Self::Zoom => "zoom",
        }
    }
}

/// Drives the main window from the custom dots.
///
/// `Close` hides the window instead of exiting — the same contract as the
/// `CloseRequested` handler, so a stray click never drops a running turn and
/// the dock icon brings the window back.
#[tauri::command]
pub(crate) fn main_window_action(
    window: tauri::WebviewWindow,
    action: String,
) -> Result<(), String> {
    let action =
        WindowAction::parse(&action).ok_or_else(|| format!("unknown window action: {action}"))?;
    let result = match action {
        WindowAction::Close => window.hide(),
        WindowAction::Minimize => window.minimize(),
        // macOS calls the green button "zoom"; AppKit maps maximize onto it.
        WindowAction::Zoom if window.is_maximized().unwrap_or(false) => window.unmaximize(),
        WindowAction::Zoom => window.maximize(),
    };
    result.map_err(|error| format!("could not {} the window: {error}", action.verb()))
}

/// Whether the window is fullscreen, where macOS hides the titlebar entirely
/// and the dots have to leave with it.
#[tauri::command]
pub(crate) fn main_window_is_fullscreen(window: tauri::WebviewWindow) -> bool {
    window.is_fullscreen().unwrap_or(false)
}

/// Keeps the native traffic lights in step with the webview's dots: hidden
/// while the webview draws them, restored in fullscreen where macOS reveals the
/// titlebar on hover. Also watches for AppKit rebuilding the titlebar.
#[cfg(target_os = "macos")]
pub(crate) fn apply_macos_window_chrome<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    match window.ns_window() {
        Ok(ptr) if !ptr.is_null() => unsafe {
            sync_native_traffic_lights(ptr);
            observe_macos_titlebar_relayout(ptr);
        },
        Ok(_) => {}
        Err(error) => {
            eprintln!("could not reach the macOS window controls: {error}");
        }
    }
}

/// AppKit rebuilds the titlebar on key/main changes, fullscreen exit, and other
/// internal relayouts, bringing the standard buttons back without any Tauri
/// window event. Watch the window's own notifications and hide them again on
/// the next main-queue turn, after AppKit's layout pass. Installed once per
/// NSWindow.
#[cfg(target_os = "macos")]
unsafe fn observe_macos_titlebar_relayout(ns_window: *mut std::ffi::c_void) {
    use std::collections::HashSet;
    use std::ptr::NonNull;
    use std::sync::{Mutex, OnceLock};

    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{
        NSWindow, NSWindowDidBecomeKeyNotification, NSWindowDidBecomeMainNotification,
        NSWindowDidDeminiaturizeNotification, NSWindowDidEndLiveResizeNotification,
        NSWindowDidExitFullScreenNotification, NSWindowDidResignKeyNotification,
        NSWindowDidResignMainNotification, NSWindowDidResizeNotification,
        NSWindowDidUpdateNotification,
    };
    use objc2_foundation::{NSNotification, NSNotificationCenter, NSOperationQueue};

    static OBSERVED: OnceLock<Mutex<HashSet<usize>>> = OnceLock::new();
    let observed = OBSERVED.get_or_init(|| Mutex::new(HashSet::new()));
    let Ok(mut observed) = observed.lock() else {
        return;
    };
    if !observed.insert(ns_window as usize) {
        return;
    }

    let block = RcBlock::new(|notification: NonNull<NSNotification>| {
        let Some(object) = notification.as_ref().object() else {
            return;
        };
        let Ok(window) = object.downcast::<NSWindow>() else {
            return;
        };
        let ptr = objc2::rc::Retained::as_ptr(&window) as *mut std::ffi::c_void;
        sync_native_traffic_lights(ptr);
    });
    let center = NSNotificationCenter::defaultCenter();
    let queue = NSOperationQueue::mainQueue();
    let window = &*ns_window.cast::<AnyObject>();
    for name in [
        NSWindowDidUpdateNotification,
        NSWindowDidBecomeKeyNotification,
        NSWindowDidResignKeyNotification,
        NSWindowDidBecomeMainNotification,
        NSWindowDidResignMainNotification,
        NSWindowDidResizeNotification,
        NSWindowDidEndLiveResizeNotification,
        NSWindowDidExitFullScreenNotification,
        NSWindowDidDeminiaturizeNotification,
    ] {
        let token = center.addObserverForName_object_queue_usingBlock(
            Some(name),
            Some(window),
            Some(&queue),
            &block,
        );
        // The main window lives for the whole process (close only hides it).
        std::mem::forget(token);
    }
}

/// Shows or hides close/miniaturize/zoom. Hidden buttons stay in the
/// hierarchy, so the menu bar's Cmd+W / Cmd+M and VoiceOver's window actions
/// still reach the window. Fullscreen restores them: the webview hides its own
/// dots there, while macOS reveals the native titlebar on hover.
#[cfg(target_os = "macos")]
unsafe fn sync_native_traffic_lights(ns_window: *mut std::ffi::c_void) {
    use objc2_app_kit::{NSWindow, NSWindowButton, NSWindowStyleMask};

    let window = &*ns_window.cast::<NSWindow>();
    let hidden = !window.styleMask().contains(NSWindowStyleMask::FullScreen);
    for button in [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ]
    .into_iter()
    .filter_map(|kind| window.standardWindowButton(kind))
    {
        // Guarded so the notification loop cannot dirty AppKit's layout again.
        if button.isHidden() != hidden {
            button.setHidden(hidden);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_actions_round_trip_through_their_wire_names() {
        for (raw, action) in [
            ("close", WindowAction::Close),
            ("minimize", WindowAction::Minimize),
            ("zoom", WindowAction::Zoom),
        ] {
            assert_eq!(WindowAction::parse(raw), Some(action));
            assert_eq!(action.verb(), raw);
        }
        assert_eq!(WindowAction::parse("maximize"), None);
        assert_eq!(WindowAction::parse(""), None);
    }
}
