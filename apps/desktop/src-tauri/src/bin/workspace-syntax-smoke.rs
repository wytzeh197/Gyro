//! Isolated native WebKit acceptance, with no normal application initialization.
//! Build the explicit native-syntax-smoke Vite mode before this debug binary.

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{utils::config::Csp, Manager, WebviewUrl, WebviewWindowBuilder};

const REPORT_PREFIX: &str = "GYRO_WORKSPACE_SYNTAX_SMOKE:";
const MAX_REPORT_BYTES: usize = 64 * 1024;

#[derive(serde::Deserialize)]
struct TitleChunk {
    index: usize,
    count: usize,
    chunk: String,
}

#[derive(Default)]
struct TitleReport {
    parts: Vec<Option<String>>,
    bytes: usize,
}

impl TitleReport {
    fn receive(&mut self, payload: &str) -> Result<Option<String>, String> {
        if payload.len() > 2048 {
            return Err("Native title piece exceeds the frame limit".into());
        }
        let piece: TitleChunk = serde_json::from_str(payload).map_err(|error| error.to_string())?;
        if piece.count == 0 || piece.count > 256 || piece.index >= piece.count {
            return Err("Invalid native title piece index".into());
        }
        if self.parts.is_empty() {
            self.parts.resize(piece.count, None);
        }
        if self.parts.len() != piece.count || self.parts[piece.index].is_some() {
            return Err("Inconsistent or repeated native title piece".into());
        }
        self.bytes += piece.chunk.len();
        if self.bytes > MAX_REPORT_BYTES {
            return Err("Native syntax report exceeds the payload limit".into());
        }
        self.parts[piece.index] = Some(piece.chunk);
        if self.parts.iter().all(Option::is_some) {
            Ok(Some(
                self.parts
                    .iter()
                    .map(|part| part.as_deref().unwrap())
                    .collect(),
            ))
        } else {
            Ok(None)
        }
    }
}

fn main() {
    if !cfg!(debug_assertions) {
        eprintln!("The Workspace syntax harness is debug-only.");
        std::process::exit(2);
    }
    if let Err(error) = run() {
        eprintln!("Workspace syntax harness: {error}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    // Require a disposable, existing data directory. Nothing reads GyroPaths,
    // user preferences, app databases, keychain, providers, or automation.
    let data_dir = PathBuf::from(std::env::var("GYRO_TEST_DATA_DIR")?).canonicalize()?;
    let temporary_root = std::env::temp_dir().canonicalize()?;
    let slash_tmp = PathBuf::from("/private/tmp");
    if !data_dir.is_dir()
        || (!data_dir.starts_with(&temporary_root) && !data_dir.starts_with(&slash_tmp))
        || data_dir == temporary_root
        || data_dir == slash_tmp
    {
        return Err(
            "GYRO_TEST_DATA_DIR must be a disposable directory inside the temporary directory"
                .into(),
        );
    }
    let blocked = std::env::var_os("GYRO_SYNTAX_SMOKE_BLOCK_WASM").is_some();
    let report_path = data_dir.join(if blocked {
        "blocked-wasm.json"
    } else {
        "syntax.json"
    });
    let mut context = tauri::generate_context!();
    // Never open the configured main app window or invoke gyro_desktop_lib.
    context.config_mut().app.windows.clear();
    context.config_mut().identifier = "dev.gyro.workspace-syntax-smoke".into();
    context.config_mut().product_name = Some("Gyro Workspace syntax check".into());
    if blocked {
        let csp = context
            .config()
            .app
            .security
            .csp
            .as_ref()
            .ok_or("App CSP is missing")?
            .to_string();
        context.config_mut().app.security.csp =
            Some(Csp::Policy(csp.replace(" 'wasm-unsafe-eval'", "")));
    }
    let native_csp = context
        .config()
        .app
        .security
        .csp
        .as_ref()
        .ok_or("App CSP is missing")?
        .to_string();
    let completed = Arc::new(AtomicBool::new(false));
    let setup_completed = completed.clone();
    let setup_report_path = report_path.clone();
    let app = tauri::Builder::default()
        .setup(move |app| {
            let callback_completed = setup_completed.clone();
            let callback_report_path = setup_report_path.clone();
            let callback_csp = native_csp.clone();
            let title_report = Mutex::new(TitleReport::default());
            WebviewWindowBuilder::new(
                app,
                "isolated-workspace-syntax",
                WebviewUrl::App("workspace-syntax-native-smoke.html".into()),
            )
            .title("Gyro isolated Workspace syntax check")
            .inner_size(720.0, 520.0)
            .visible(false)
            .skip_taskbar(true)
            .incognito(true)
            .devtools(false)
            .on_navigation(|url| {
                url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost")
            })
            .initialization_script(format!(
                "window.__nativeSyntaxSmoke = {{blockedWasm:{blocked}}};"
            ))
            .on_document_title_changed(move |window, title| {
                let Some(payload) = title.strip_prefix(REPORT_PREFIX) else {
                    return;
                };
                if callback_completed.load(Ordering::SeqCst) {
                    return;
                }
                let payload = match title_report.lock().unwrap().receive(payload) {
                    Ok(Some(report)) => report,
                    Ok(None) => return,
                    Err(error) => {
                        eprintln!("Native syntax title transport failed: {error}");
                        return;
                    }
                };
                if callback_completed.swap(true, Ordering::SeqCst) {
                    return;
                }
                let report = serde_json::from_str::<serde_json::Value>(&payload);
                let success = report.as_ref().is_ok_and(|report| {
                    report.get("passed").and_then(|value| value.as_bool()) == Some(true)
                        && report.get("blockedWasm").and_then(|value| value.as_bool())
                            == Some(blocked)
                });
                let result = report
                    .map_err(|error| error.to_string())
                    .and_then(|mut report| {
                        let object = report.as_object_mut().ok_or("Expected a JSON object")?;
                        object.insert(
                            "nativeCsp".into(),
                            serde_json::Value::String(callback_csp.clone()),
                        );
                        object.insert(
                            "nativeBuild".into(),
                            serde_json::Value::String("debug-embedded-tauri".into()),
                        );
                        std::fs::write(
                            &callback_report_path,
                            serde_json::to_vec_pretty(&report).unwrap(),
                        )
                        .map_err(|error| error.to_string())
                    });
                let written = result.is_ok();
                if let Err(error) = result {
                    eprintln!("Native syntax report failed: {error}");
                }
                window
                    .app_handle()
                    .exit(if success && written { 0 } else { 1 });
            })
            .build()?;
            let timeout_app = app.handle().clone();
            let timeout_completed = setup_completed.clone();
            let timeout_report_path = setup_report_path.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(60));
                if !timeout_completed.swap(true, Ordering::SeqCst) {
                    let _ = std::fs::write(
                        timeout_report_path,
                        br#"{"passed":false,"error":"Native syntax probe timed out"}"#,
                    );
                    timeout_app.exit(1);
                }
            });
            Ok(())
        })
        .build(context)?;
    app.run(|_, _| {});
    Ok(())
}
