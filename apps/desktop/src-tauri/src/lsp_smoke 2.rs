//! Opt-in native regression check for semantic code navigation. Set
//! `GYRO_LSP_SMOKE=1` and an absolute `GYRO_TEST_DATA_DIR`; set
//! `GYRO_LSP_SMOKE_ROOT` to point at the repository under test (defaults to
//! the current directory). The check starts rust-analyzer through the same
//! manager the capabilities use, waits out a cold index, and asserts a known
//! definition, a known reference set, and a document-symbol list. It writes
//! `lsp-smoke.json` to the data directory and exits non-zero on failure.
use crate::language_server::{
    language_server_for_path, LanguageServerManager, LspFileOutcome, LspFileRequest,
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tauri::AppHandle;

pub fn start(app: &AppHandle) -> Result<bool, Box<dyn std::error::Error>> {
    if std::env::var("GYRO_LSP_SMOKE").as_deref() != Ok("1") {
        return Ok(false);
    }
    let root = PathBuf::from(std::env::var("GYRO_LSP_SMOKE_ROOT").unwrap_or_else(|_| ".".into()));
    let output = PathBuf::from(std::env::var("GYRO_TEST_DATA_DIR")?);
    if !output.is_absolute() {
        return Err("native LSP smoke requires an absolute GYRO_TEST_DATA_DIR".into());
    }
    std::fs::create_dir_all(&output)?;
    let app = app.clone();
    std::thread::spawn(move || {
        let result = run(&root);
        let report = match &result {
            Ok(steps) => json!({ "ok": true, "steps": steps }),
            Err(error) => json!({ "ok": false, "error": error }),
        };
        let _ = std::fs::write(output.join("lsp-smoke.json"), report.to_string());
        eprintln!("LSP smoke: {report}");
        app.exit(if result.is_ok() { 0 } else { 1 });
    });
    Ok(true)
}

fn run(root: &Path) -> Result<Vec<String>, String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("smoke root is unavailable: {error}"))?;
    let manager = LanguageServerManager::default();
    let deadline = Instant::now() + Duration::from_secs(600);
    let mut steps = Vec::new();

    // A cross-file definition: a use site in lib.rs must resolve into the
    // extracted language-server module.
    let lib_path = root.join("apps/desktop/src-tauri/src/lib.rs");
    let lib_text = std::fs::read_to_string(&lib_path).map_err(|error| error.to_string())?;
    let (line, column) = find_position(&lib_text, "LanguageServerManager::default()")
        .ok_or("the definition probe needle is missing from lib.rs")?;
    let definition = probe(
        &manager,
        &root,
        &lib_path,
        LspFileRequest::Definition { line, column },
        deadline,
    )?;
    if !definition.to_string().contains("language_server.rs") {
        return Err(format!(
            "definition of LanguageServerManager did not resolve to language_server.rs: {definition}"
        ));
    }
    steps.push("definition: LanguageServerManager resolves to language_server.rs".into());

    // References of a function must include its call sites in another module.
    let (line, column) = find_position(&lib_text, "capability_argument_string<'a>(")
        .ok_or("the references probe needle is missing from lib.rs")?;
    let references = probe(
        &manager,
        &root,
        &lib_path,
        LspFileRequest::References {
            line,
            column,
            include_declaration: true,
        },
        deadline,
    )?;
    let references_text = references.to_string();
    if !references_text.contains("workspace_capability_read.rs") {
        return Err(format!(
            "references of capability_argument_string missed its workspace_capability_read.rs call sites: {references}"
        ));
    }
    steps.push("references: capability_argument_string includes its capability call sites".into());

    // Document symbols on a Go-to-definition target the model will actually
    // ask about; proves documentSymbol works even though the editor does not
    // use it today.
    let capability_path = root.join("apps/desktop/src-tauri/src/lsp_capability.rs");
    let symbols = probe(
        &manager,
        &root,
        &capability_path,
        LspFileRequest::DocumentSymbol,
        deadline,
    )?;
    if !symbols.to_string().contains("execute") {
        return Err(format!(
            "document symbols for lsp_capability.rs missed `execute`: {symbols}"
        ));
    }
    steps.push("symbols: lsp_capability.rs exposes execute".into());

    for server_id in manager.server_ids() {
        let _ = manager.stop(&server_id);
    }
    Ok(steps)
}

fn probe(
    manager: &LanguageServerManager,
    root: &Path,
    file: &Path,
    request: LspFileRequest,
    deadline: Instant,
) -> Result<Value, String> {
    let relative = file
        .strip_prefix(root)
        .map_err(|_| "smoke targets must live inside the smoke root".to_string())?
        .to_string_lossy()
        .into_owned();
    let canonical = file.canonicalize().unwrap_or_else(|_| file.to_path_buf());
    let (language_id, command) = language_server_for_path(&canonical)
        .ok_or_else(|| format!("no language server for {relative}"))?;
    if !crate::language_server::language_server_command_is_allowed(language_id, command) {
        return Err(format!(
            "{language_id} is not on the language-server allowlist"
        ));
    }
    loop {
        let outcome = manager
            .request_for_file(root, &relative, &canonical, request)
            .map_err(|error| format!("{relative}: {error}"))?;
        match outcome {
            LspFileOutcome::Indexing { retry_after_ms } => {
                if Instant::now() >= deadline {
                    return Err(format!(
                        "{relative}: the language server was still indexing at the smoke deadline"
                    ));
                }
                std::thread::sleep(Duration::from_millis(retry_after_ms.min(2_000)));
            }
            LspFileOutcome::Result(result) => return Ok(result),
        }
    }
}

fn find_position(text: &str, needle: &str) -> Option<(u64, u64)> {
    let index = text.find(needle)?;
    let line = text[..index].matches('\n').count() as u64 + 1;
    let line_start = text[..index]
        .rfind('\n')
        .map(|value| value + 1)
        .unwrap_or(0);
    let column = text[line_start..index].chars().count() as u64 + 1;
    Some((line, column))
}
