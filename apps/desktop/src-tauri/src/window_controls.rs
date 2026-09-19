/// Overlay traffic-light origin matching `tauri.conf.json` and the sidebar
/// titlebar CSS. Native 14px controls at this inset share the 48px chat
/// header's centreline with the 28px window-navigation buttons.
const MAIN_TRAFFIC_LIGHT_X: f64 = 16.0;
const MAIN_TRAFFIC_LIGHT_Y: f64 = 17.0;

/// Tauri's `unstable` feature hosts the main webview as a child, which leaves
/// `trafficLightPosition` stuck at (0, 0) (tauri-apps/tauri#14072). Tauri 2.11
/// also does not expose `set_traffic_light_position` on `WebviewWindow`, so
/// apply wry's NSWindow inset after the window exists.
#[cfg(target_os = "macos")]
pub(crate) fn apply_macos_traffic_light_position<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) {
    match window.ns_window() {
        Ok(ptr) if !ptr.is_null() => unsafe {
            inset_macos_traffic_lights(ptr, MAIN_TRAFFIC_LIGHT_X, MAIN_TRAFFIC_LIGHT_Y);
        },
        Ok(_) => {}
        Err(error) => {
            eprintln!("could not position macOS window controls: {error}");
        }
    }
}

/// Mirrors wry's `inset_traffic_lights`: grow the titlebar container to the
/// requested top inset, then place close/miniaturize/zoom from the left inset.
#[cfg(target_os = "macos")]
unsafe fn inset_macos_traffic_lights(ns_window: *mut std::ffi::c_void, x: f64, y: f64) {
    use objc2_app_kit::{NSView, NSWindow, NSWindowButton};

    let window = &*ns_window.cast::<NSWindow>();
    let Some(close) = window.standardWindowButton(NSWindowButton::CloseButton) else {
        return;
    };
    let Some(miniaturize) = window.standardWindowButton(NSWindowButton::MiniaturizeButton) else {
        return;
    };
    let zoom = window.standardWindowButton(NSWindowButton::ZoomButton);
    let Some(title_bar_container_view) = close
        .superview()
        .and_then(|superview| superview.superview())
    else {
        return;
    };

    let close_rect = NSView::frame(&close);
    let title_bar_frame_height = close_rect.size.height + y;
    let mut title_bar_rect = NSView::frame(&title_bar_container_view);
    title_bar_rect.size.height = title_bar_frame_height;
    title_bar_rect.origin.y = window.frame().size.height - title_bar_frame_height;
    title_bar_container_view.setFrame(title_bar_rect);

    let space_between = NSView::frame(&miniaturize).origin.x - close_rect.origin.x;
    let mut window_buttons = vec![close, miniaturize];
    if let Some(zoom) = zoom {
        window_buttons.push(zoom);
    }
    for (index, button) in window_buttons.into_iter().enumerate() {
        let Some(parent) = button.superview() else {
            continue;
        };
        let mut rect = NSView::frame(&button);
        // The button container can itself be offset inside the titlebar.
        // Define the target in window coordinates, then convert into that
        // container rather than treating its origin as the window origin.
        rect.origin.x = x + (index as f64 * space_between);
        rect.origin.y = window.frame().size.height - y - rect.size.height;
        let local_rect = parent.convertRect_fromView(rect, None);
        button.setFrameOrigin(local_rect.origin);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main_window_traffic_lights_use_overlay_inset() {
        assert_eq!(MAIN_TRAFFIC_LIGHT_X, 16.0);
        assert_eq!(MAIN_TRAFFIC_LIGHT_Y, 17.0);
    }
}
