use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};

#[derive(Default)]
pub struct QuitConfirmation {
    pending: AtomicBool,
    confirmed: AtomicBool,
}

impl QuitConfirmation {
    fn request(&self, code: Option<i32>) -> bool {
        // Updates/restarts and diagnostic failures have their own exit paths.
        if code.is_some() || self.confirmed.load(Ordering::SeqCst) {
            return false;
        }
        self.pending.store(true, Ordering::SeqCst);
        true
    }

    fn resolve(&self, quit: bool) -> bool {
        if !self.pending.swap(false, Ordering::SeqCst) {
            return false;
        }
        self.confirmed.store(quit, Ordering::SeqCst);
        quit
    }
}

/// Returns true when shutdown was deferred. No resources may drain in that case.
pub fn defer_exit(app: &tauri::AppHandle, code: Option<i32>, api: &tauri::ExitRequestApi) -> bool {
    if !app.state::<QuitConfirmation>().request(code) {
        return false;
    }
    api.prevent_exit();
    show_confirmation(app);
    true
}

pub fn request_quit(app: &tauri::AppHandle) {
    if app.state::<QuitConfirmation>().request(None) {
        show_confirmation(app);
    }
}

fn show_confirmation(app: &tauri::AppHandle) {
    let reveal = || -> anyhow::Result<()> {
        #[cfg(target_os = "macos")]
        crate::restore_main_window(app)?;
        #[cfg(not(target_os = "macos"))]
        if let Some(window) = app.get_webview_window("main") {
            window.unminimize()?;
            window.show()?;
            window.set_focus()?;
        }
        app.emit_to("main", "gyro-quit-requested", ())?;
        Ok(())
    };
    if let Err(error) = reveal() {
        eprintln!("could not show Gyro quit confirmation: {error}");
    }
}

#[tauri::command]
pub fn get_quit_confirmation(state: tauri::State<'_, QuitConfirmation>) -> bool {
    state.pending.load(Ordering::SeqCst)
}

#[tauri::command]
pub fn resolve_quit_confirmation(app: tauri::AppHandle, quit: bool) {
    if app.state::<QuitConfirmation>().resolve(quit) {
        app.exit(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_keeps_quit_requests_guarded_and_confirmation_allows_exit() {
        let state = QuitConfirmation::default();
        assert!(!state.resolve(true));
        assert!(state.request(None)); // Cmd+Q / application menu / Dock.
        assert!(state.request(None)); // Repeated tray quit: same pending prompt.
        assert!(!state.resolve(false));
        assert!(!state.pending.load(Ordering::SeqCst));
        assert!(state.request(None));
        assert!(state.resolve(true));
        assert!(!state.request(Some(0)));
        assert!(!state.request(None));
    }

    #[test]
    fn restarts_and_error_exits_do_not_request_confirmation() {
        let state = QuitConfirmation::default();
        assert!(!state.request(Some(tauri::RESTART_EXIT_CODE)));
        assert!(!state.request(Some(0))); // Programmatic smoke-test completion.
        assert!(!state.request(Some(1)));
        assert!(!state.pending.load(Ordering::SeqCst));
    }
}
