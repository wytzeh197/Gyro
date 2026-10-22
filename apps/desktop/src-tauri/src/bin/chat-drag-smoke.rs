//! Isolated native WebKit fixture for actual macOS splitview drag gestures.
//! The normal application entrypoint, providers, and user state are never used.

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{WebviewUrl, WebviewWindowBuilder};

#[path = "../window_controls.rs"]
mod window_controls;

const MAX_REPORT_BYTES: usize = 1024 * 1024;

struct FixtureReport {
    path: PathBuf,
    native_window: serde_json::Value,
    native_csp: String,
    write_lock: Arc<Mutex<()>>,
}

#[tauri::command]
async fn report_chat_drag_smoke(
    mut report: serde_json::Value,
    fixture: tauri::State<'_, FixtureReport>,
) -> Result<(), String> {
    let path = fixture.path.clone();
    let native_window = fixture.native_window.clone();
    let native_csp = fixture.native_csp.clone();
    let write_lock = Arc::clone(&fixture.write_lock);
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = write_lock
            .lock()
            .map_err(|_| "Native drag report writer is unavailable")?;
        let object = report.as_object_mut().ok_or("Expected a JSON object")?;
        object.insert(
            "nativeBuild".into(),
            serde_json::Value::String("debug-embedded-tauri".into()),
        );
        object.insert("nativeWindow".into(), native_window);
        object.insert("nativeCsp".into(), serde_json::Value::String(native_csp));
        let bytes = serde_json::to_vec_pretty(&report).map_err(|error| error.to_string())?;
        if bytes.len() > MAX_REPORT_BYTES {
            return Err("Native drag report exceeds the payload limit".into());
        }
        // Readers see a whole snapshot even while drag events update the fixture.
        let pending = path.with_extension("pending");
        std::fs::write(&pending, bytes).map_err(|error| error.to_string())?;
        std::fs::rename(pending, &path).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn fixture_data_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let requested = if let Some(directory) = std::env::var_os("GYRO_TEST_DATA_DIR") {
        PathBuf::from(directory)
    } else {
        // A CUA-launched .app does not inherit a shell's environment variables.
        // The build-only packager places the disposable test path in Resources.
        let executable = std::env::current_exe()?;
        let resources = executable
            .parent()
            .and_then(|macos| macos.parent())
            .ok_or("Native fixture executable is outside an app bundle")?
            .join("Resources/fixture-data-dir");
        PathBuf::from(std::fs::read_to_string(resources)?.trim())
    };
    let directory = requested.canonicalize()?;
    let temporary_root = std::env::temp_dir().canonicalize()?;
    let slash_tmp = PathBuf::from("/private/tmp");
    if !directory.is_dir()
        || (!directory.starts_with(&temporary_root) && !directory.starts_with(&slash_tmp))
        || directory == temporary_root
        || directory == slash_tmp
    {
        return Err("Native fixture data must be a disposable temporary directory".into());
    }
    Ok(directory)
}

fn main() {
    if !cfg!(debug_assertions) {
        eprintln!("The chat drag harness is debug-only.");
        std::process::exit(2);
    }
    if let Err(error) = run() {
        eprintln!("Native chat drag harness: {error}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = fixture_data_dir()?;
    let mut context = tauri::generate_context!();
    let mut main_window = context
        .config()
        .app
        .windows
        .first()
        .ok_or("Gyro has no configured main window")?
        .clone();
    // Keep production dragDropEnabled, titlebar, dimensions, and traffic lights.
    // Incognito matches the production debug application's disposable-data mode.
    main_window.label = "main".into();
    main_window.title = "Gyro chat drag native".into();
    main_window.url = WebviewUrl::App("chat-drag-preview.html".into());
    main_window.incognito = true;
    main_window.devtools = Some(false);
    let native_window = serde_json::to_value(&main_window)?;
    let native_csp = context
        .config()
        .app
        .security
        .csp
        .as_ref()
        .ok_or("App CSP is missing")?
        .to_string();
    // Never create an implicit normal application window.
    context.config_mut().app.windows.clear();
    context.config_mut().identifier = "dev.gyro.chat-drag-smoke".into();
    context.config_mut().product_name = Some("Gyro chat drag native".into());
    let app = tauri::Builder::default()
        .manage(FixtureReport {
            path: data_dir.join("state.json"),
            native_window,
            native_csp,
            write_lock: Arc::new(Mutex::new(())),
        })
        .invoke_handler(tauri::generate_handler![report_chat_drag_smoke])
        .setup(move |app| {
            let window = WebviewWindowBuilder::from_config(app, &main_window)?
                .on_navigation(|url| {
                    url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost")
                })
                .build()?;
            #[cfg(target_os = "macos")]
            window_controls::apply_macos_traffic_light_position(&window);
            Ok(())
        })
        .build(context)?;
    app.run(|_, _| {});
    Ok(())
}
