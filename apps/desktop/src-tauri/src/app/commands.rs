use crate::{
    desktop_notifications::{native_permission, send_test_notification},
    stores::to_string,
};
#[tauri::command]
pub(crate) async fn restart_app(app: tauri::AppHandle) -> Result<(), String> {
    app.restart()
}

/// Platform key this build downloads from `latest.json`, so the UI can read the
/// matching archive size before the download starts.
#[tauri::command]
pub(crate) async fn updater_platform_key() -> String {
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };
    format!("{os}-{}", std::env::consts::ARCH)
}

#[tauri::command]
pub(crate) async fn get_notification_permission(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || native_permission(&app).to_string())
        .await
        .map_err(to_string)
}

#[tauri::command]
pub(crate) async fn test_notification(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || send_test_notification(&app).to_string())
        .await
        .map_err(to_string)
}
