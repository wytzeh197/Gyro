//! AppKit menu accelerators remain available while a child WKWebView has focus.
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Manager, Runtime,
};

pub(crate) fn setup<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = match app.menu() {
        Some(menu) => menu,
        None => Menu::default(app)?,
    };
    let search = MenuItem::with_id(app, "gyro-search", "Search Gyro", true, Some("CmdOrCtrl+K"))?;
    let view = menu.items()?.into_iter().find_map(|item| {
        item.as_submenu()
            .filter(|submenu| submenu.text().ok().as_deref() == Some("View"))
            .cloned()
    });
    if let Some(view) = view {
        view.append(&PredefinedMenuItem::separator(app)?)?;
        view.append(&search)?;
    } else {
        menu.append(&Submenu::with_items(app, "View", true, &[&search])?)?;
    }
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if event.id.as_ref() == "gyro-search"
            && app
                .get_window("main")
                .is_some_and(|window| window.is_focused().unwrap_or(false))
        {
            let _ = app.emit_to(
                tauri::EventTarget::webview("main"),
                "desktop-shortcut",
                serde_json::json!({"key":"k"}),
            );
        }
    });
    Ok(())
}
