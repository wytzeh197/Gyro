//! Language-server bridge for the IDE: managed LSP processes, request
//! dispatch, and the JSON-RPC framing shared with the debug-adapter
//! bridge that remains in `lib.rs`.
//!
//! Extracted from `lib.rs` to hold that file under its architecture
//! ceiling; new language-server behavior belongs here. Model-facing code
//! navigation (`lsp_capability.rs`) goes through [`LanguageServerManager::request_for_file`]
//! so that the editor and the capabilities share one server pool.

use crate::{
    add_ide_protocol_message_bytes, command_with_gui_path, read_workspace_file_with_limit,
    to_string, workspace_root, MAX_IDE_PROTOCOL_MESSAGES_PER_RESPONSE,
    MAX_IDE_PROTOCOL_RESPONSE_BYTES, MAX_WORKSPACE_FILE_EDIT_BYTES,
};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, ChildStdout, Stdio};
use std::sync::{mpsc, Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};
use uuid::Uuid;

const MAX_LANGUAGE_SERVER_PROCESSES: usize = 16;
const MAX_LSP_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_LSP_HEADER_BYTES: usize = 16 * 1024;
const IDE_PROTOCOL_CHANNEL_CAPACITY: usize = 8;
const MAX_OPEN_LSP_DOCUMENTS: usize = 64;
const LSP_FILE_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const LSP_REQUEST_TIMEOUT_MESSAGE: &str = "language server request timed out";
const LSP_INDEXING_RETRY_AFTER_MS: u64 = 2000;
/// Server messages that arrived while a request was waiting but did not fit
/// in that request's reply wait here for the editor's next `$/gyro/poll`.
/// Oldest entries are dropped first: a later publishDiagnostics for a file
/// supersedes an earlier one.
const MAX_LSP_BACKLOG_MESSAGES: usize = 256;
const MAX_LSP_BACKLOG_BYTES: usize = 8 * 1024 * 1024;

/// Extension → (language id, command) pairs the capabilities may start. The
/// editor keeps the UI copy of this table in
/// `packages/ui/src/editor/languages/definitions.ts`; drift between the two
/// is caught by `scripts/check-language-server-registry.mjs`.
const LANGUAGE_SERVER_BY_SUFFIX: &[(&str, &str, &str)] = &[
    (
        ".tsx",
        "typescriptreact",
        "typescript-language-server --stdio",
    ),
    (
        ".jsx",
        "javascriptreact",
        "typescript-language-server --stdio",
    ),
    (".ts", "typescript", "typescript-language-server --stdio"),
    (".mts", "typescript", "typescript-language-server --stdio"),
    (".cts", "typescript", "typescript-language-server --stdio"),
    (".js", "javascript", "typescript-language-server --stdio"),
    (".mjs", "javascript", "typescript-language-server --stdio"),
    (".cjs", "javascript", "typescript-language-server --stdio"),
    (".json", "json", "vscode-json-language-server --stdio"),
    (".jsonc", "json", "vscode-json-language-server --stdio"),
    (".html", "html", "vscode-html-language-server --stdio"),
    (".htm", "html", "vscode-html-language-server --stdio"),
    (".xhtml", "html", "vscode-html-language-server --stdio"),
    (".css", "css", "vscode-css-language-server --stdio"),
    (".scss", "scss", "vscode-css-language-server --stdio"),
    (".less", "less", "vscode-css-language-server --stdio"),
    (".rs", "rust", "rust-analyzer"),
];

const LANGUAGE_SERVER_BY_FILENAME: &[(&str, &str, &str)] = &[
    (
        "tsconfig.json",
        "json",
        "vscode-json-language-server --stdio",
    ),
    (
        "jsconfig.json",
        "json",
        "vscode-json-language-server --stdio",
    ),
];

/// Which language server serves this file, if any.
pub fn language_server_for_path(path: &Path) -> Option<(&'static str, &'static str)> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())?
        .to_ascii_lowercase();
    for (filename, language_id, command) in LANGUAGE_SERVER_BY_FILENAME {
        if name == *filename {
            return Some((language_id, command));
        }
    }
    for (suffix, language_id, command) in LANGUAGE_SERVER_BY_SUFFIX {
        if name.ends_with(suffix) {
            return Some((language_id, command));
        }
    }
    None
}

/// One semantic query for a file, in the tool's 1-based coordinates.
#[derive(Clone, Copy, Debug)]
pub enum LspFileRequest {
    Definition {
        line: u64,
        column: u64,
    },
    References {
        line: u64,
        column: u64,
        include_declaration: bool,
    },
    Hover {
        line: u64,
        column: u64,
    },
    Formatting {
        tab_size: u32,
        insert_spaces: bool,
    },
    DocumentSymbol,
}

impl LspFileRequest {
    fn feature(self) -> &'static str {
        match self {
            Self::Definition { .. } => "definitionProvider",
            Self::References { .. } => "referencesProvider",
            Self::Hover { .. } => "hoverProvider",
            Self::Formatting { .. } => "documentFormattingProvider",
            Self::DocumentSymbol => "documentSymbolProvider",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Definition { .. } => "definition",
            Self::References { .. } => "references",
            Self::Hover { .. } => "hover",
            Self::Formatting { .. } => "formatting",
            Self::DocumentSymbol => "document symbols",
        }
    }

    fn method(self) -> &'static str {
        match self {
            Self::Definition { .. } => "textDocument/definition",
            Self::References { .. } => "textDocument/references",
            Self::Hover { .. } => "textDocument/hover",
            Self::Formatting { .. } => "textDocument/formatting",
            Self::DocumentSymbol => "textDocument/documentSymbol",
        }
    }
}

/// A finished answer, or an honest "the server is still indexing".
pub enum LspFileOutcome {
    Result(serde_json::Value),
    Indexing { retry_after_ms: u64 },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LspStartRequest {
    workspace_path: String,
    language_id: String,
    command: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LspRequestPayload {
    server_id: String,
    method: String,
    params: serde_json::Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LspSessionResult {
    server_id: String,
    language_id: String,
    command: String,
    status: String,
    message: String,
    capabilities: serde_json::Value,
    position_encoding: String,
}

/// `(root, language id, command)`: the identity of one managed server.
type LanguageServerKey = (PathBuf, String, String);
type LanguageServerStartGates = Mutex<HashMap<LanguageServerKey, Arc<Mutex<()>>>>;

#[derive(Clone, Default)]
pub struct LanguageServerManager {
    processes: Arc<Mutex<HashMap<String, Arc<Mutex<LanguageServerProcess>>>>>,
    /// One gate per key that is being acquired, so concurrent acquires for
    /// the same server wait for a single spawn instead of each starting one.
    starting: Arc<LanguageServerStartGates>,
}

/// A caller's place in the per-key start queue. Dropping it retires the
/// gate once nobody else holds or waits on it.
struct LanguageServerStartGate<'a> {
    gates: &'a LanguageServerStartGates,
    key: LanguageServerKey,
    gate: Arc<Mutex<()>>,
}

impl<'a> LanguageServerStartGate<'a> {
    fn enter(gates: &'a LanguageServerStartGates, key: LanguageServerKey) -> anyhow::Result<Self> {
        let gate = gates
            .lock()
            .map_err(|_| anyhow::anyhow!("language server start lock poisoned"))?
            .entry(key.clone())
            .or_default()
            .clone();
        Ok(Self { gates, key, gate })
    }
}

impl Drop for LanguageServerStartGate<'_> {
    fn drop(&mut self) {
        if let Ok(mut gates) = self.gates.lock() {
            // The map's reference plus ours: nobody else is queued. Clones are
            // only taken under this lock, so the count cannot race upward.
            if Arc::strong_count(&self.gate) <= 2 {
                gates.remove(&self.key);
            }
        }
    }
}

/// What the server was last told about an open document.
struct LspDocumentState {
    version: i64,
    /// Hash of the complete text last sent to the server. An incremental
    /// editor change leaves this unknown; disk-only requests must then fail
    /// rather than replace a snapshot owned by the editor.
    content_hash: Option<u64>,
    /// The editor opened this document itself; the model path must not
    /// close it on eviction.
    editor_open: bool,
}

struct LanguageServerProcess {
    child: gyro_core::process_guard::GuardedChild,
    stdin: ChildStdin,
    messages: mpsc::Receiver<Result<serde_json::Value, String>>,
    next_request_id: u64,
    semantic_tokens: serde_json::Value,
    capabilities: serde_json::Value,
    /// Documents the model path opened, oldest first, for eviction.
    open_documents: VecDeque<String>,
    /// Every document the server currently has open, from either path.
    documents: HashMap<String, LspDocumentState>,
    /// Server messages awaiting the next poll, with their encoded sizes.
    backlog: VecDeque<(serde_json::Value, usize)>,
    backlog_bytes: usize,
    root: PathBuf,
    language_id: String,
    command: String,
    /// Whether this server has ever answered with a real semantic result.
    /// A cold rust-analyzer answers promptly with an empty list instead of
    /// timing out and sends no readiness notification, so an empty answer
    /// from a server that has never produced a result is "still loading".
    answered_nonempty: bool,
}

impl LanguageServerProcess {
    fn new(
        child: gyro_core::process_guard::GuardedChild,
        stdin: ChildStdin,
        messages: mpsc::Receiver<Result<serde_json::Value, String>>,
        root: &Path,
        language_id: &str,
        command: &str,
    ) -> Self {
        Self {
            child,
            stdin,
            messages,
            next_request_id: 2,
            semantic_tokens: serde_json::Value::Null,
            capabilities: serde_json::Value::Null,
            open_documents: VecDeque::new(),
            documents: HashMap::new(),
            backlog: VecDeque::new(),
            backlog_bytes: 0,
            root: root.to_path_buf(),
            language_id: language_id.to_string(),
            command: command.to_string(),
            answered_nonempty: false,
        }
    }
}

impl Drop for LanguageServerProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[tauri::command]
pub async fn lsp_start(
    request: LspStartRequest,
    manager: tauri::State<'_, LanguageServerManager>,
) -> Result<LspSessionResult, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.start(request).map_err(to_string))
        .await
        .map_err(|error| format!("language server start worker failed: {error}"))?
}

#[tauri::command]
pub async fn lsp_request(
    request: LspRequestPayload,
    manager: tauri::State<'_, LanguageServerManager>,
) -> Result<serde_json::Value, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.request(request).map_err(to_string))
        .await
        .map_err(|error| format!("language server request worker failed: {error}"))?
}

#[tauri::command]
pub async fn lsp_stop(
    server_id: String,
    manager: tauri::State<'_, LanguageServerManager>,
) -> Result<serde_json::Value, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.stop(&server_id).map_err(to_string))
        .await
        .map_err(|error| format!("language server stop worker failed: {error}"))?
}

impl LanguageServerManager {
    fn start(&self, request: LspStartRequest) -> anyhow::Result<LspSessionResult> {
        let root = workspace_root(&request.workspace_path)?;
        let command_text = request.command.trim().to_string();
        if !language_server_command_is_allowed(&request.language_id, &command_text) {
            anyhow::bail!("language server command is not allowed for this language");
        }
        let (server_id, message) = self.acquire(&root, &request.language_id, &command_text)?;
        let process = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("language server manager lock poisoned"))?
            .get(&server_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("language server stopped during initialization"))?;
        let capabilities = {
            let mut process = process
                .lock()
                .map_err(|_| anyhow::anyhow!("language server process lock poisoned"))?;
            if let Some(status) = process.child.try_wait()? {
                anyhow::bail!("language server exited with {status}");
            }
            process.capabilities.clone()
        };
        Ok(LspSessionResult {
            server_id,
            language_id: request.language_id,
            command: command_text,
            status: "ready".into(),
            message,
            capabilities,
            position_encoding: "utf-16".into(),
        })
    }

    /// Reuse or spawn the one process serving `(root, language_id, command)`.
    ///
    /// The workspace root is part of the key: a second workspace must never
    /// share a server that was `current_dir`-ed and `rootUri`-ed elsewhere.
    fn acquire(
        &self,
        root: &Path,
        language_id: &str,
        command_text: &str,
    ) -> anyhow::Result<(String, String)> {
        if !language_server_command_is_allowed(language_id, command_text) {
            anyhow::bail!("language server command is not allowed for this language");
        }
        let mut parts = command_text.split_whitespace();
        let command_name = parts
            .next()
            .ok_or_else(|| anyhow::anyhow!("language server command is required"))?;
        let mut args = parts.map(ToOwned::to_owned).collect::<Vec<_>>();
        if language_server_needs_stdio_arg(command_name) && !args.iter().any(|arg| arg == "--stdio")
        {
            args.push("--stdio".into());
        }

        self.acquire_with(root, language_id, command_text, || {
            start_language_server_process(root, language_id, command_text, command_name, args)
        })
    }

    /// The reuse-or-start core of [`Self::acquire`], with the process start
    /// injected. Concurrent acquires for one key — parallel model navigation
    /// calls, or the model racing the editor — queue on a per-key gate, so
    /// exactly one of them runs `start` and the rest find its server. The
    /// manager map is never locked across spawn and initialize.
    fn acquire_with(
        &self,
        root: &Path,
        language_id: &str,
        command_text: &str,
        start: impl FnOnce() -> anyhow::Result<(LanguageServerProcess, String)>,
    ) -> anyhow::Result<(String, String)> {
        let gate = LanguageServerStartGate::enter(
            &self.starting,
            (
                root.to_path_buf(),
                language_id.to_string(),
                command_text.to_string(),
            ),
        )?;
        let _start_turn = gate.gate.lock().unwrap_or_else(PoisonError::into_inner);

        let existing_processes = {
            let processes = self
                .processes
                .lock()
                .map_err(|_| anyhow::anyhow!("language server manager lock poisoned"))?;
            processes
                .iter()
                .map(|(server_id, process)| (server_id.clone(), process.clone()))
                .collect::<Vec<_>>()
        };
        let mut stale_processes = Vec::new();
        let mut live_processes = 0usize;
        for (server_id, process) in existing_processes {
            let mut process = process
                .lock()
                .map_err(|_| anyhow::anyhow!("language server process lock poisoned"))?;
            if process.child.try_wait()?.is_some() {
                stale_processes.push(server_id);
                continue;
            }
            live_processes += 1;
            if process.language_id == language_id
                && process.command == command_text
                && process.root == root
            {
                return Ok((server_id, "Language server is already running".into()));
            }
        }
        if !stale_processes.is_empty() {
            let mut processes = self
                .processes
                .lock()
                .map_err(|_| anyhow::anyhow!("language server manager lock poisoned"))?;
            for server_id in stale_processes {
                processes.remove(&server_id);
            }
        }
        if live_processes >= MAX_LANGUAGE_SERVER_PROCESSES {
            anyhow::bail!("language server process limit reached; stop a server first");
        }

        let (process, message) = start()?;
        let server_id = format!("{language_id}:{}", Uuid::new_v4());
        let mut processes = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("language server manager lock poisoned"))?;
        if processes.len() >= MAX_LANGUAGE_SERVER_PROCESSES {
            drop(processes);
            // Dropping the process kills and reaps it.
            drop(process);
            anyhow::bail!("language server process limit reached; stop a server first");
        }
        processes.insert(server_id.clone(), Arc::new(Mutex::new(process)));
        Ok((server_id, message))
    }

    /// Answer one semantic query for a workspace file the model named.
    ///
    /// Unlike the editor path this must work for files nobody opened: the
    /// server is started on demand, the document is opened on the Rust side,
    /// and a cold server reports `Indexing` instead of a wrong answer.
    pub fn request_for_file(
        &self,
        root: &Path,
        relative_path: &str,
        file: &Path,
        request: LspFileRequest,
    ) -> anyhow::Result<LspFileOutcome> {
        let Some((language_id, command)) = language_server_for_path(file) else {
            anyhow::bail!("no language server is registered for this file type");
        };
        let root = root
            .canonicalize()
            .map_err(|error| anyhow::anyhow!("workspace root is unavailable: {error}"))?;
        let (server_id, _) = self.acquire(&root, language_id, command)?;
        let process = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("language server manager lock poisoned"))?
            .get(&server_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("language server is not running"))?;
        let mut process = process
            .lock()
            .map_err(|_| anyhow::anyhow!("language server process lock poisoned"))?;
        if let Some(status) = process.child.try_wait()? {
            anyhow::bail!("language server exited with {status}");
        }
        if !lsp_feature_supported(&process.capabilities, request.feature()) {
            anyhow::bail!(
                "the {language_id} language server does not support {}",
                request.label()
            );
        }
        let file_content = read_workspace_file_with_limit(
            &root.to_string_lossy(),
            relative_path,
            MAX_WORKSPACE_FILE_EDIT_BYTES,
        )?;
        if file_content.truncated {
            anyhow::bail!("{relative_path} is too large for semantic navigation");
        }
        let lines = file_content.content.split('\n').collect::<Vec<_>>();
        let uri = workspace_file_uri(file);
        ensure_document_open(&mut process, &uri, &file_content.content)?;
        let params = match request {
            LspFileRequest::Definition { line, column }
            | LspFileRequest::Hover { line, column } => {
                serde_json::json!({
                    "textDocument": { "uri": uri },
                    "position": position_params(&lines, line, column, relative_path)?,
                })
            }
            LspFileRequest::References {
                line,
                column,
                include_declaration,
            } => serde_json::json!({
                "textDocument": { "uri": uri },
                "position": position_params(&lines, line, column, relative_path)?,
                "context": { "includeDeclaration": include_declaration },
            }),
            LspFileRequest::Formatting {
                tab_size,
                insert_spaces,
            } => serde_json::json!({
                "textDocument": { "uri": uri },
                "options": { "tabSize": tab_size, "insertSpaces": insert_spaces },
            }),
            LspFileRequest::DocumentSymbol => serde_json::json!({
                "textDocument": { "uri": uri },
            }),
        };
        let request_id = process.next_request_id;
        process.next_request_id += 1;
        write_lsp_message(
            &mut process.stdin,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": request.method(),
                "params": params,
            }),
        )?;
        match receive_lsp_response(&mut process, request_id, LSP_FILE_REQUEST_TIMEOUT) {
            Ok((response, _messages)) => {
                if let Some(error) = response.get("error") {
                    // -32801 "content modified" is rust-analyzer's retryable
                    // signal that the workspace moved under the request — it
                    // answers this while it is still loading — so it joins
                    // Indexing rather than failing the call.
                    if error.get("code").and_then(|value| value.as_i64()) == Some(-32801) {
                        return Ok(LspFileOutcome::Indexing {
                            retry_after_ms: LSP_INDEXING_RETRY_AFTER_MS,
                        });
                    }
                    anyhow::bail!("language server rejected the request: {error}");
                }
                let result = response
                    .get("result")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                // rust-analyzer answers promptly while it is still loading the
                // crate graph — with an empty result, not a timeout, and with
                // no readiness notification to wait on — so an empty answer is
                // only believed once this server has shown it can resolve
                // something in the workspace.
                if lsp_result_is_empty(&result) {
                    if !process.answered_nonempty {
                        return Ok(LspFileOutcome::Indexing {
                            retry_after_ms: LSP_INDEXING_RETRY_AFTER_MS,
                        });
                    }
                } else {
                    process.answered_nonempty = true;
                }
                Ok(LspFileOutcome::Result(result))
            }
            // A cold server (rust-analyzer on first touch) indexes for a while
            // before it can answer. Report that instead of letting the model
            // conclude the symbol has no definition.
            Err(error) if error.to_string() == LSP_REQUEST_TIMEOUT_MESSAGE => {
                Ok(LspFileOutcome::Indexing {
                    retry_after_ms: LSP_INDEXING_RETRY_AFTER_MS,
                })
            }
            Err(error) => Err(error),
        }
    }

    fn request(&self, request: LspRequestPayload) -> anyhow::Result<serde_json::Value> {
        let process = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("language server manager lock poisoned"))?
            .get(&request.server_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("language server is not running"))?;
        let mut process = process
            .lock()
            .map_err(|_| anyhow::anyhow!("language server process lock poisoned"))?;
        if let Some(status) = process.child.try_wait()? {
            anyhow::bail!("language server exited with {status}");
        }

        if request.method == "$/gyro/semanticTokensLegend" {
            let full = process.semantic_tokens.get("full");
            let supported = full
                .is_some_and(|value| value == &serde_json::Value::Bool(true) || value.is_object());
            return Ok(
                serde_json::json!({ "serverId": request.server_id, "status": "ok", "result": if supported { process.semantic_tokens.get("legend").cloned().unwrap_or(serde_json::Value::Null) } else { serde_json::Value::Null } }),
            );
        }
        if request.method == "$/gyro/poll" {
            let messages = drain_lsp_messages(&mut process)?;
            return Ok(serde_json::json!({
                "serverId": request.server_id,
                "status": "ok",
                "messages": messages,
            }));
        }

        if lsp_method_is_notification(&request.method) {
            if let Some((method, params)) =
                normalize_editor_document_notification(&process, &request.method, &request.params)?
            {
                write_lsp_message(
                    &mut process.stdin,
                    &serde_json::json!({
                        "jsonrpc": "2.0",
                        "method": method,
                        "params": params,
                    }),
                )?;
                observe_editor_document_notification(&mut process, &method, &params);
            }
            let document_version = request
                .params
                .pointer("/textDocument/uri")
                .and_then(serde_json::Value::as_str)
                .and_then(|uri| process.documents.get(uri))
                .map(|document| document.version);
            let messages = drain_lsp_messages(&mut process)?;
            return Ok(serde_json::json!({
                "serverId": request.server_id,
                "status": "sent",
                "messages": messages,
                "documentVersion": document_version,
            }));
        }

        let request_id = process.next_request_id;
        process.next_request_id += 1;
        write_lsp_message(
            &mut process.stdin,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": request.method,
                "params": request.params,
            }),
        )?;
        let (response, messages) =
            receive_lsp_response(&mut process, request_id, Duration::from_secs(15))?;
        Ok(serde_json::json!({
            "serverId": request.server_id,
            "status": if response.get("error").is_some() { "error" } else { "ok" },
            "result": response.get("result").cloned(),
            "error": response.get("error").cloned(),
            "messages": messages,
        }))
    }

    pub fn server_ids(&self) -> Vec<String> {
        self.processes
            .lock()
            .map(|processes| processes.keys().cloned().collect())
            .unwrap_or_default()
    }

    pub fn stop(&self, server_id: &str) -> anyhow::Result<serde_json::Value> {
        let process = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("language server manager lock poisoned"))?
            .remove(server_id);
        let Some(process) = process else {
            return Ok(serde_json::json!({
                "serverId": server_id,
                "status": "stopped",
            }));
        };
        let mut process = process
            .lock()
            .map_err(|_| anyhow::anyhow!("language server process lock poisoned"))?;
        // Close every document we opened so a long-lived server does not keep
        // analysis state for files this app no longer tracks.
        let open_documents = process.documents.keys().cloned().collect::<Vec<_>>();
        process.open_documents.clear();
        process.documents.clear();
        for uri in open_documents {
            let _ = write_lsp_message(
                &mut process.stdin,
                &serde_json::json!({
                    "jsonrpc": "2.0",
                    "method": "textDocument/didClose",
                    "params": { "textDocument": { "uri": uri } },
                }),
            );
        }
        let request_id = process.next_request_id;
        process.next_request_id += 1;
        let _ = write_lsp_message(
            &mut process.stdin,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "shutdown",
                "params": null,
            }),
        );
        let _ = receive_lsp_response(&mut process, request_id, Duration::from_secs(2));
        let _ = write_lsp_message(
            &mut process.stdin,
            &serde_json::json!({ "jsonrpc": "2.0", "method": "exit", "params": null }),
        );
        let _ = process.child.kill();
        let _ = process.child.wait();
        Ok(serde_json::json!({
            "serverId": server_id,
            "status": "stopped",
        }))
    }
}

/// Spawn and initialize one language server. The returned process is killed
/// and reaped on drop, so an initialize failure cannot leak it.
fn start_language_server_process(
    root: &Path,
    language_id: &str,
    command_text: &str,
    command_name: &str,
    args: Vec<String>,
) -> anyhow::Result<(LanguageServerProcess, String)> {
    let mut command = command_with_gui_path(command_name);
    command
        .args(args)
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = gyro_core::process_guard::spawn_service(&mut command).map_err(|error| {
        anyhow::anyhow!("failed to start language server {command_name}: {error}")
    })?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow::anyhow!("language server stdin unavailable"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("language server stdout unavailable"))?;
    let mut process = LanguageServerProcess::new(
        child,
        stdin,
        spawn_lsp_message_reader(stdout),
        root,
        language_id,
        command_text,
    );
    let root_uri = workspace_file_uri(root);
    write_lsp_message(
        &mut process.stdin,
        &serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "processId": std::process::id(),
                "clientInfo": { "name": "Gyro", "version": env!("CARGO_PKG_VERSION") },
                "rootUri": root_uri,
                "workspaceFolders": [{ "uri": root_uri, "name": root.file_name().and_then(|name| name.to_str()).unwrap_or("workspace") }],
                "capabilities": {
                    "general": { "positionEncodings": ["utf-16"] },
                    "workspace": {
                        "workspaceFolders": true, "configuration": true,
                        "workspaceEdit": { "documentChanges": true }
                    },
                    "textDocument": {
                        "publishDiagnostics": { "relatedInformation": true },
                        "completion": { "completionItem": { "snippetSupport": true } },
                        "hover": { "contentFormat": ["markdown", "plaintext"] },
                        "definition": { "linkSupport": true },
                        "rename": { "prepareSupport": true },
                        "semanticTokens": {
                            "requests": { "full": true },
                            "tokenTypes": ["namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter", "variable", "property", "enumMember", "event", "function", "method", "macro", "keyword", "modifier", "comment", "string", "number", "regexp", "operator", "decorator"],
                            "tokenModifiers": ["declaration", "definition", "readonly", "static", "deprecated", "abstract", "async", "modification", "documentation", "defaultLibrary"],
                            "formats": ["relative"], "overlappingTokenSupport": false, "multilineTokenSupport": false
                        }
                    }
                }
            }
        }),
    )?;
    let (initialize_response, startup_messages) =
        receive_lsp_response(&mut process, 1, Duration::from_secs(12))?;
    if let Some(error) = initialize_response.get("error") {
        anyhow::bail!("language server initialize failed: {error}");
    }
    write_lsp_message(
        &mut process.stdin,
        &serde_json::json!({
            "jsonrpc": "2.0",
            "method": "initialized",
            "params": {}
        }),
    )?;
    process.semantic_tokens = initialize_response
        .pointer("/result/capabilities/semanticTokensProvider")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    process.capabilities = initialize_response
        .pointer("/result/capabilities")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    assert_utf16_position_encoding(&process.capabilities)?;
    let capability_count = initialize_response
        .pointer("/result/capabilities")
        .and_then(|value| value.as_object())
        .map(|value| value.len())
        .unwrap_or(0);
    Ok((
        process,
        format!(
            "Initialized with {capability_count} capabilities and {} startup messages",
            startup_messages.len()
        ),
    ))
}

/// Send `textDocument/didOpen` the first time a document is touched, a
/// full-text `didChange` whenever its on-disk content has moved since the
/// server last saw it (the agent edits files between navigation calls), and
/// `didClose` when the registry evicts one. The editor's own bookkeeping is
/// renderer-only, so this registry is what makes model requests answerable
/// for files the user never opened.
fn ensure_document_open(
    process: &mut LanguageServerProcess,
    uri: &str,
    text: &str,
) -> anyhow::Result<()> {
    let content_hash = lsp_document_hash(text);
    if let Some(document) = process.documents.get_mut(uri) {
        if document.content_hash == Some(content_hash) {
            return Ok(());
        }
        if document.editor_open {
            anyhow::bail!(
                "file has unsaved or unsynchronized editor changes; save or close it before disk-based code navigation"
            );
        }
        let version = document
            .version
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("language server document version exhausted"))?;
        write_lsp_message(
            &mut process.stdin,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "method": "textDocument/didChange",
                "params": {
                    "textDocument": { "uri": uri, "version": version },
                    "contentChanges": [{ "text": text }],
                }
            }),
        )?;
        document.version = version;
        document.content_hash = Some(content_hash);
        return Ok(());
    }
    while process.open_documents.len() >= MAX_OPEN_LSP_DOCUMENTS {
        let Some(evicted) = process.open_documents.pop_front() else {
            break;
        };
        // A document the editor also has open stays open for the editor.
        if process
            .documents
            .get(&evicted)
            .is_some_and(|document| document.editor_open)
        {
            continue;
        }
        process.documents.remove(&evicted);
        let _ = write_lsp_message(
            &mut process.stdin,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "method": "textDocument/didClose",
                "params": { "textDocument": { "uri": evicted } },
            }),
        );
    }
    write_lsp_message(
        &mut process.stdin,
        &serde_json::json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didOpen",
            "params": {
                "textDocument": {
                    "uri": uri,
                    "languageId": process.language_id,
                    "version": 1,
                    "text": text,
                }
            }
        }),
    )?;
    process.open_documents.push_back(uri.to_owned());
    process.documents.insert(
        uri.to_owned(),
        LspDocumentState {
            version: 1,
            content_hash: Some(content_hash),
            editor_open: false,
        },
    );
    Ok(())
}

/// An editor may take ownership of a document the model already opened.
/// Send a full change in that case instead of a second didOpen, and return
/// the actual version to the renderer so it can continue the same sequence.
fn normalize_editor_document_notification(
    process: &LanguageServerProcess,
    method: &str,
    params: &serde_json::Value,
) -> anyhow::Result<Option<(String, serde_json::Value)>> {
    if method != "textDocument/didOpen" && method != "textDocument/didChange" {
        return Ok(Some((method.to_string(), params.clone())));
    }
    let uri = params
        .pointer("/textDocument/uri")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("editor document URI is required"))?;
    let version = params
        .pointer("/textDocument/version")
        .and_then(serde_json::Value::as_i64)
        .filter(|version| *version >= 0)
        .ok_or_else(|| anyhow::anyhow!("editor document version must be a nonnegative integer"))?;
    let existing = process.documents.get(uri);
    if method == "textDocument/didOpen" {
        anyhow::ensure!(
            params
                .pointer("/textDocument/text")
                .and_then(serde_json::Value::as_str)
                .is_some(),
            "editor document text is required"
        );
    }
    if method == "textDocument/didChange" {
        anyhow::ensure!(
            params
                .get("contentChanges")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|changes| changes.iter().all(|change| change
                    .get("text")
                    .and_then(serde_json::Value::as_str)
                    .is_some())),
            "editor document content changes require text"
        );
        let document = existing
            .ok_or_else(|| anyhow::anyhow!("editor document must be opened before changes"))?;
        if document.editor_open && version <= document.version {
            let hash = editor_document_content_hash(method, params);
            if hash.is_some() && hash == document.content_hash {
                return Ok(None);
            }
            anyhow::bail!("editor document change is stale; synchronize the current version first");
        }
    }
    let actual_version = match existing {
        Some(document) => version.max(
            document
                .version
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("language server document version exhausted"))?,
        ),
        None => version,
    };
    if method == "textDocument/didOpen" && existing.is_some() {
        let text = params
            .pointer("/textDocument/text")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("editor document text is required"))?;
        return Ok(Some((
            "textDocument/didChange".into(),
            serde_json::json!({
                "textDocument": { "uri": uri, "version": actual_version },
                "contentChanges": [{ "text": text }],
            }),
        )));
    }
    let mut params = params.clone();
    params["textDocument"]["version"] = actual_version.into();
    Ok(Some((method.to_string(), params)))
}

fn editor_document_content_hash(method: &str, params: &serde_json::Value) -> Option<u64> {
    if method == "textDocument/didOpen" {
        return params
            .pointer("/textDocument/text")
            .and_then(serde_json::Value::as_str)
            .map(lsp_document_hash);
    }
    let changes = params.get("contentChanges")?.as_array()?;
    // Incremental changes cannot prove that the server's complete snapshot
    // matches disk without retaining another full copy of every document.
    if changes.iter().any(|change| change.get("range").is_some()) {
        return None;
    }
    changes.last()?.get("text")?.as_str().map(lsp_document_hash)
}

/// The editor drives its own `didOpen`/`didChange`/`didClose` through
/// [`LanguageServerManager::request`]. Track them so the model path neither
/// re-opens a document the server already has, nor closes one under the
/// editor. Disk-only requests can reuse a matching editor snapshot, but must
/// never replace the editor's text with disk content.
fn observe_editor_document_notification(
    process: &mut LanguageServerProcess,
    method: &str,
    params: &serde_json::Value,
) {
    let Some(uri) = params
        .pointer("/textDocument/uri")
        .and_then(|value| value.as_str())
    else {
        return;
    };
    let version = params
        .pointer("/textDocument/version")
        .and_then(|value| value.as_i64())
        .unwrap_or(0);
    match method {
        "textDocument/didOpen" => {
            let document =
                process
                    .documents
                    .entry(uri.to_owned())
                    .or_insert_with(|| LspDocumentState {
                        version,
                        content_hash: editor_document_content_hash(method, params),
                        editor_open: true,
                    });
            document.version = document.version.max(version);
            document.content_hash = editor_document_content_hash(method, params);
            document.editor_open = true;
        }
        "textDocument/didChange" => {
            if let Some(document) = process.documents.get_mut(uri) {
                document.version = document.version.max(version);
                document.content_hash = editor_document_content_hash(method, params);
                document.editor_open = true;
            }
        }
        "textDocument/didClose" => {
            process.documents.remove(uri);
            process.open_documents.retain(|open| open != uri);
        }
        _ => {}
    }
}

fn lsp_document_hash(text: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}

fn lsp_feature_supported(capabilities: &serde_json::Value, feature: &str) -> bool {
    match capabilities.get(feature) {
        Some(serde_json::Value::Bool(value)) => *value,
        Some(serde_json::Value::Object(_)) => true,
        _ => false,
    }
}

fn assert_utf16_position_encoding(capabilities: &serde_json::Value) -> anyhow::Result<()> {
    // LSP 3.17 defaults to UTF-16 when a server omits positionEncoding. Gyro
    // advertises only that encoding because both Monaco and tool conversion
    // already use UTF-16 units.
    if let Some(encoding) = capabilities.get("positionEncoding") {
        anyhow::ensure!(
            encoding.as_str() == Some("utf-16"),
            "language server selected unsupported position encoding: {encoding}"
        );
    }
    Ok(())
}

fn position_params(
    lines: &[&str],
    line: u64,
    column: u64,
    relative_path: &str,
) -> anyhow::Result<serde_json::Value> {
    let Some(text) = line
        .checked_sub(1)
        .and_then(|index| lines.get(index as usize))
    else {
        anyhow::bail!("line {line} is past the end of {relative_path}");
    };
    Ok(serde_json::json!({
        "line": line - 1,
        "character": lsp_character(text, column),
    }))
}

fn lsp_character(line_text: &str, column: u64) -> u64 {
    // Tool positions are 1-based Unicode scalar counts; LSP wants 0-based
    // UTF-16 units. The two agree on ASCII and diverge only on astral
    // characters, which would otherwise shift every position on the line.
    let mut units = 0u64;
    for (index, character) in line_text.chars().enumerate() {
        if index as u64 + 1 >= column {
            break;
        }
        units += character.len_utf16() as u64;
    }
    units
}

pub fn language_server_command_is_allowed(language_id: &str, command: &str) -> bool {
    let normalized = command.split_whitespace().collect::<Vec<_>>().join(" ");
    match language_id {
        "typescript" | "typescriptreact" | "javascript" | "javascriptreact" => {
            normalized == "typescript-language-server --stdio"
        }
        "rust" => normalized == "rust-analyzer",
        "json" => normalized == "vscode-json-language-server --stdio",
        "css" | "scss" | "less" => normalized == "vscode-css-language-server --stdio",
        "html" => normalized == "vscode-html-language-server --stdio",
        _ => false,
    }
}

fn language_server_needs_stdio_arg(command: &str) -> bool {
    let name = Path::new(command)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(command);
    matches!(
        name,
        "typescript-language-server"
            | "vscode-json-language-server"
            | "vscode-css-language-server"
            | "vscode-html-language-server"
    )
}

fn lsp_method_is_notification(method: &str) -> bool {
    method == "initialized"
        || method == "exit"
        || method == "workspace/didChangeConfiguration"
        || method == "workspace/didChangeWatchedFiles"
        || method.starts_with("textDocument/did")
        || method.starts_with("$/")
}

pub fn spawn_lsp_message_reader(
    stdout: ChildStdout,
) -> mpsc::Receiver<Result<serde_json::Value, String>> {
    let (sender, receiver) = mpsc::sync_channel(IDE_PROTOCOL_CHANNEL_CAPACITY);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_lsp_message(&mut reader) {
                Ok(message) => {
                    if sender.send(Ok(message)).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let _ = sender.send(Err(error.to_string()));
                    break;
                }
            }
        }
    });
    receiver
}

pub fn write_lsp_message(writer: &mut impl Write, value: &serde_json::Value) -> anyhow::Result<()> {
    let body = serde_json::to_vec(value)?;
    if body.len() > MAX_LSP_MESSAGE_BYTES {
        anyhow::bail!("language server message exceeds size limit");
    }
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())?;
    writer.write_all(&body)?;
    writer.flush()?;
    Ok(())
}

pub fn read_lsp_message(reader: &mut impl BufRead) -> anyhow::Result<serde_json::Value> {
    let mut content_length = None;
    let mut header_bytes = 0usize;
    loop {
        let mut header = String::new();
        let remaining = MAX_LSP_HEADER_BYTES.saturating_sub(header_bytes);
        if remaining == 0 {
            anyhow::bail!("language server headers exceed size limit");
        }
        let read = Read::by_ref(reader)
            .take((remaining + 1) as u64)
            .read_line(&mut header)?;
        if read == 0 {
            anyhow::bail!("language server output closed");
        }
        header_bytes = header_bytes.saturating_add(read);
        if header_bytes > MAX_LSP_HEADER_BYTES {
            anyhow::bail!("language server headers exceed size limit");
        }
        if header == "\r\n" || header == "\n" {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = Some(value.trim().parse::<usize>()?);
            }
        }
    }
    let content_length =
        content_length.ok_or_else(|| anyhow::anyhow!("missing LSP Content-Length header"))?;
    if content_length > MAX_LSP_MESSAGE_BYTES {
        anyhow::bail!("language server message exceeds size limit");
    }
    let mut body = vec![0; content_length];
    reader.read_exact(&mut body)?;
    Ok(serde_json::from_slice(&body)?)
}

fn receive_lsp_response(
    process: &mut LanguageServerProcess,
    request_id: u64,
    timeout: Duration,
) -> anyhow::Result<(serde_json::Value, Vec<serde_json::Value>)> {
    let deadline = Instant::now() + timeout;
    let mut messages = Vec::new();
    let mut message_bytes = 0usize;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            anyhow::bail!(LSP_REQUEST_TIMEOUT_MESSAGE);
        }
        let message = process
            .messages
            .recv_timeout(remaining)
            .map_err(|error| match error {
                mpsc::RecvTimeoutError::Timeout => anyhow::anyhow!(LSP_REQUEST_TIMEOUT_MESSAGE),
                mpsc::RecvTimeoutError::Disconnected => {
                    anyhow::anyhow!("language server response channel disconnected")
                }
            })?
            .map_err(anyhow::Error::msg)?;
        // A server-to-client request can reuse our numeric id; only a message
        // without a method is the response.
        if message.get("method").is_none()
            && message.get("id").and_then(|value| value.as_u64()) == Some(request_id)
        {
            return Ok((message, messages));
        }
        handle_lsp_server_message(process, &message)?;
        // Notifications (a rust-analyzer diagnostics burst), server requests,
        // and replies to other ids do not fail this request. The first ones
        // ride back with the response; the rest wait, bounded, for the next
        // poll. The wait itself is bounded by the deadline above.
        let size = lsp_message_size(&message);
        if process.backlog.is_empty()
            && messages.len() < MAX_IDE_PROTOCOL_MESSAGES_PER_RESPONSE
            && message_bytes.saturating_add(size) <= MAX_IDE_PROTOCOL_RESPONSE_BYTES
        {
            message_bytes += size;
            messages.push(message);
        } else {
            push_lsp_backlog(process, message, size);
        }
    }
}

fn lsp_message_size(message: &serde_json::Value) -> usize {
    serde_json::to_vec(message)
        .map(|bytes| bytes.len())
        .unwrap_or(0)
}

/// Keep a server message for the next poll, dropping the oldest ones past
/// the backlog's count and byte bounds.
fn push_lsp_backlog(process: &mut LanguageServerProcess, message: serde_json::Value, size: usize) {
    if size > MAX_LSP_BACKLOG_BYTES {
        return;
    }
    process.backlog.push_back((message, size));
    process.backlog_bytes = process.backlog_bytes.saturating_add(size);
    while process.backlog.len() > MAX_LSP_BACKLOG_MESSAGES
        || process.backlog_bytes > MAX_LSP_BACKLOG_BYTES
    {
        let Some((_, dropped)) = process.backlog.pop_front() else {
            break;
        };
        process.backlog_bytes = process.backlog_bytes.saturating_sub(dropped);
    }
}

fn drain_lsp_messages(
    process: &mut LanguageServerProcess,
) -> anyhow::Result<Vec<serde_json::Value>> {
    let mut messages = Vec::new();
    let mut message_bytes = 0usize;
    for _ in 0..MAX_IDE_PROTOCOL_MESSAGES_PER_RESPONSE {
        // Messages held back while a request waited come first, in order.
        let message = if let Some((message, size)) = process.backlog.pop_front() {
            process.backlog_bytes = process.backlog_bytes.saturating_sub(size);
            message
        } else {
            let message = match process.messages.try_recv() {
                Ok(message) => message.map_err(anyhow::Error::msg)?,
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    anyhow::bail!("language server output disconnected")
                }
            };
            handle_lsp_server_message(process, &message)?;
            message
        };
        add_ide_protocol_message_bytes(&mut message_bytes, &message)?;
        messages.push(message);
    }
    Ok(messages)
}

fn handle_lsp_server_message(
    process: &mut LanguageServerProcess,
    message: &serde_json::Value,
) -> anyhow::Result<()> {
    let Some(id) = message.get("id") else {
        return Ok(());
    };
    let Some(method) = message.get("method").and_then(|value| value.as_str()) else {
        return Ok(());
    };
    let result = if method == "workspace/configuration" {
        let count = message
            .pointer("/params/items")
            .and_then(|value| value.as_array())
            .map(|items| items.len())
            .unwrap_or(0);
        serde_json::Value::Array(vec![serde_json::Value::Null; count])
    } else {
        serde_json::Value::Null
    };
    write_lsp_message(
        &mut process.stdin,
        &serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result }),
    )
}

/// An empty answer: no definition, no reference, no symbol. Distinguishes the
/// shapes the protocol actually returns (`null`, `[]`) from real results.
fn lsp_result_is_empty(result: &serde_json::Value) -> bool {
    match result {
        serde_json::Value::Null => true,
        serde_json::Value::Array(items) => items.is_empty(),
        _ => false,
    }
}

fn workspace_file_uri(path: &Path) -> String {
    let value = path.to_string_lossy();
    let mut encoded = String::with_capacity(value.len() + 8);
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b':' | b'.' | b'-' | b'_' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    format!("file://{encoded}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lsp_json_rpc_framing_round_trips() {
        let value = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "textDocument/hover",
            "params": { "line": 4 }
        });
        let mut framed = Vec::new();
        write_lsp_message(&mut framed, &value).unwrap();

        let decoded = read_lsp_message(&mut BufReader::new(framed.as_slice())).unwrap();

        assert_eq!(decoded, value);
        assert!(String::from_utf8_lossy(&framed).starts_with("Content-Length: "));
    }

    #[test]
    fn lsp_json_rpc_framing_accepts_case_insensitive_header() {
        let body = br#"{"jsonrpc":"2.0","method":"initialized","params":{}}"#;
        let framed = format!("content-length: {}\r\n\r\n", body.len())
            .into_bytes()
            .into_iter()
            .chain(body.iter().copied())
            .collect::<Vec<_>>();

        let decoded = read_lsp_message(&mut BufReader::new(framed.as_slice())).unwrap();

        assert_eq!(decoded["method"], "initialized");
    }

    #[test]
    fn lsp_json_rpc_framing_rejects_oversized_headers() {
        let framed = format!("X-Fill: {}", "x".repeat(MAX_LSP_HEADER_BYTES + 1));
        let error = read_lsp_message(&mut BufReader::new(framed.as_bytes())).unwrap_err();
        assert!(error.to_string().contains("headers exceed size limit"));
    }

    #[test]
    fn workspace_file_uri_encodes_spaces_without_losing_path_shape() {
        let uri = workspace_file_uri(Path::new("/tmp/Gyro Workspace/src/main.ts"));

        assert_eq!(uri, "file:///tmp/Gyro%20Workspace/src/main.ts");
    }

    #[test]
    fn lsp_notification_detection_covers_document_lifecycle() {
        assert!(lsp_method_is_notification("textDocument/didOpen"));
        assert!(lsp_method_is_notification("textDocument/didChange"));
        assert!(lsp_method_is_notification("$/cancelRequest"));
        assert!(!lsp_method_is_notification("textDocument/hover"));
    }

    #[test]
    fn language_server_for_path_covers_registered_file_types() {
        assert_eq!(
            language_server_for_path(Path::new("/w/src/app.ts")),
            Some(("typescript", "typescript-language-server --stdio"))
        );
        assert_eq!(
            language_server_for_path(Path::new("/w/src/App.tsx")),
            Some(("typescriptreact", "typescript-language-server --stdio"))
        );
        assert_eq!(
            language_server_for_path(Path::new("/w/src/main.rs")),
            Some(("rust", "rust-analyzer"))
        );
        assert_eq!(
            language_server_for_path(Path::new("/w/tsconfig.json")),
            Some(("json", "vscode-json-language-server --stdio"))
        );
        assert_eq!(
            language_server_for_path(Path::new("/w/styles.module.scss")),
            Some(("scss", "vscode-css-language-server --stdio"))
        );
        assert!(language_server_for_path(Path::new("/w/notes.md")).is_none());
    }

    #[test]
    fn every_registered_language_server_passes_the_command_allowlist() {
        for (suffix, language_id, command) in LANGUAGE_SERVER_BY_SUFFIX {
            assert!(
                language_server_command_is_allowed(language_id, command),
                "{suffix} maps to a command the allowlist rejects: {language_id} / {command}"
            );
        }
        for (filename, language_id, command) in LANGUAGE_SERVER_BY_FILENAME {
            assert!(
                language_server_command_is_allowed(language_id, command),
                "{filename} maps to a command the allowlist rejects: {language_id} / {command}"
            );
        }
    }

    #[test]
    fn lsp_character_converts_scalar_columns_to_utf16_units() {
        assert_eq!(lsp_character("let value", 1), 0);
        assert_eq!(lsp_character("let value", 5), 4);
        assert_eq!(lsp_character("éx", 2), 1);
        assert_eq!(lsp_character("💡x", 2), 2);
        // Columns past the end of the line clamp to the line's width.
        assert_eq!(lsp_character("abc", 99), 3);
    }

    #[test]
    fn lsp_feature_support_accepts_bool_and_object_capabilities() {
        let capabilities = serde_json::json!({
            "definitionProvider": true,
            "hoverProvider": { "workDoneProgress": true },
            "documentSymbolProvider": false,
        });
        assert!(lsp_feature_supported(&capabilities, "definitionProvider"));
        assert!(lsp_feature_supported(&capabilities, "hoverProvider"));
        assert!(!lsp_feature_supported(
            &capabilities,
            "documentSymbolProvider"
        ));
        assert!(!lsp_feature_supported(&capabilities, "referencesProvider"));
    }

    #[test]
    fn position_encoding_accepts_only_explicit_or_default_utf16() {
        assert_utf16_position_encoding(&serde_json::json!({})).unwrap();
        assert_utf16_position_encoding(&serde_json::json!({ "positionEncoding": "utf-16" }))
            .unwrap();
        for encoding in [
            serde_json::json!("utf-8"),
            serde_json::json!("utf-32"),
            serde_json::Value::Null,
        ] {
            let error = assert_utf16_position_encoding(
                &serde_json::json!({ "positionEncoding": encoding }),
            )
            .unwrap_err();
            assert!(error.to_string().contains("unsupported position encoding"));
        }
    }

    #[test]
    fn language_server_manager_initializes_rust_analyzer_when_available() {
        if command_with_gui_path("rust-analyzer")
            .arg("--version")
            .output()
            .map(|output| !output.status.success())
            .unwrap_or(true)
        {
            return;
        }
        let workspace = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(workspace.path().join("src")).unwrap();
        std::fs::write(
            workspace.path().join("Cargo.toml"),
            "[package]\nname = \"lsp-check\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )
        .unwrap();
        std::fs::write(workspace.path().join("src/lib.rs"), "pub fn ready() {}\n").unwrap();
        let manager = LanguageServerManager::default();

        let session = manager
            .start(LspStartRequest {
                workspace_path: workspace.path().to_string_lossy().to_string(),
                language_id: "rust".into(),
                command: "rust-analyzer".into(),
            })
            .unwrap();

        assert_eq!(session.status, "ready");
        assert!(session.message.contains("capabilities"));
        assert_eq!(session.position_encoding, "utf-16");
        assert!(session.capabilities.is_object());
        assert_eq!(
            manager.stop(&session.server_id).unwrap()["status"],
            "stopped"
        );
    }

    #[test]
    fn semantic_requests_answer_or_report_indexing_when_rust_analyzer_is_available() {
        if command_with_gui_path("rust-analyzer")
            .arg("--version")
            .output()
            .map(|output| !output.status.success())
            .unwrap_or(true)
        {
            return;
        }
        let workspace = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(workspace.path().join("src")).unwrap();
        std::fs::write(
            workspace.path().join("Cargo.toml"),
            "[package]\nname = \"lsp-nav\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )
        .unwrap();
        let source = "pub fn helper() -> u32 { 1 }\n\npub fn caller() -> u32 { helper() }\n";
        std::fs::write(workspace.path().join("src/lib.rs"), source).unwrap();
        let manager = LanguageServerManager::default();
        let root = workspace.path().to_path_buf();
        let file = root.join("src/lib.rs").canonicalize().unwrap();
        // The cursor must sit on the call itself (1-based scalar column):
        // one column to the left lands on the brace and resolves to nothing.
        let call_line = source.lines().nth(2).unwrap();
        let column = call_line.find("helper()").unwrap() as u64 + 1;
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            let outcome = manager
                .request_for_file(
                    &root,
                    "src/lib.rs",
                    &file,
                    LspFileRequest::Definition { line: 3, column },
                )
                .unwrap();
            match outcome {
                LspFileOutcome::Indexing { retry_after_ms } => {
                    if Instant::now() > deadline {
                        // A cold server on a busy machine may still be
                        // indexing; the request flow itself is proven.
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(retry_after_ms.min(1_000)));
                }
                LspFileOutcome::Result(result) => {
                    assert!(
                        result.to_string().contains("lib.rs"),
                        "definition should resolve inside the workspace: {result}"
                    );
                    break;
                }
            }
        }
        for server_id in manager.server_ids() {
            manager.stop(&server_id).unwrap();
        }
    }

    #[test]
    fn real_rust_server_navigates_and_renames_across_files() {
        if command_with_gui_path("rust-analyzer")
            .arg("--version")
            .output()
            .map(|output| !output.status.success())
            .unwrap_or(true)
        {
            return;
        }
        let workspace = tempfile::tempdir().unwrap();
        let root = workspace.path().canonicalize().unwrap();
        std::fs::create_dir(root.join("src")).unwrap();
        std::fs::write(
            root.join("Cargo.toml"),
            "[package]\nname = \"workspace-rename-check\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )
        .unwrap();
        let source = "mod helper;\npub fn caller() -> u32 { helper::increment(1) }\n";
        let helper = "pub fn increment(value: u32) -> u32 { value + 1 }\n";
        std::fs::write(root.join("src/lib.rs"), source).unwrap();
        std::fs::write(root.join("src/helper.rs"), helper).unwrap();
        let manager = LanguageServerManager::default();
        let file = root.join("src/lib.rs");
        let helper_uri = workspace_file_uri(&root.join("src/helper.rs"));
        let source_uri = workspace_file_uri(&file);
        let column = source.lines().nth(1).unwrap().find("increment").unwrap() as u64 + 1;
        let wait_for_result = |request| {
            let deadline = Instant::now() + Duration::from_secs(120);
            loop {
                match manager
                    .request_for_file(&root, "src/lib.rs", &file, request)
                    .unwrap()
                {
                    LspFileOutcome::Result(result) => break result,
                    LspFileOutcome::Indexing { retry_after_ms } => {
                        assert!(
                            Instant::now() < deadline,
                            "rust-analyzer did not finish indexing"
                        );
                        std::thread::sleep(Duration::from_millis(retry_after_ms.min(1_000)));
                    }
                }
            }
        };
        let definition = wait_for_result(LspFileRequest::Definition { line: 2, column });
        assert!(definition.to_string().contains(&helper_uri), "{definition}");
        let references = wait_for_result(LspFileRequest::References {
            line: 2,
            column,
            include_declaration: true,
        });
        assert!(references.to_string().contains(&helper_uri), "{references}");
        assert!(references.to_string().contains(&source_uri), "{references}");
        let session = manager
            .start(LspStartRequest {
                workspace_path: root.to_string_lossy().into_owned(),
                language_id: "rust".into(),
                command: "rust-analyzer".into(),
            })
            .unwrap();
        assert!(lsp_feature_supported(
            &session.capabilities,
            "renameProvider"
        ));
        manager
            .request(LspRequestPayload {
                server_id: session.server_id.clone(),
                method: "textDocument/didOpen".into(),
                params: serde_json::json!({
                    "textDocument": { "uri": helper_uri, "languageId": "rust", "version": 1, "text": helper },
                }),
            })
            .unwrap();
        let response = manager
            .request(LspRequestPayload {
                server_id: session.server_id.clone(),
                method: "textDocument/rename".into(),
                params: serde_json::json!({
                    "textDocument": { "uri": helper_uri },
                    "position": { "line": 0, "character": 7 },
                    "newName": "increase",
                }),
            })
            .unwrap();
        assert_eq!(response["status"], "ok", "{response}");
        let edit = &response["result"];
        assert!(edit.to_string().contains(&helper_uri), "{edit}");
        assert!(edit.to_string().contains(&source_uri), "{edit}");
        assert!(edit.to_string().contains("increase"), "{edit}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), source);
        assert_eq!(
            std::fs::read_to_string(root.join("src/helper.rs")).unwrap(),
            helper
        );
        assert_eq!(
            manager.stop(&session.server_id).unwrap()["status"],
            "stopped"
        );
    }

    /// A stand-in server: `cat` echoes whatever Gyro writes to its stdin, and
    /// the incoming message channel is fed by the test.
    fn fake_language_server(
        root: &Path,
        stdout: Stdio,
    ) -> (
        LanguageServerProcess,
        Option<ChildStdout>,
        mpsc::SyncSender<Result<serde_json::Value, String>>,
    ) {
        let mut command = std::process::Command::new("/bin/cat");
        command
            .stdin(Stdio::piped())
            .stdout(stdout)
            .stderr(Stdio::null());
        let mut child = gyro_core::process_guard::spawn_service(&mut command).unwrap();
        let stdin = child.stdin.take().unwrap();
        let echoed = child.stdout.take();
        let (sender, receiver) = mpsc::sync_channel(1024);
        let process =
            LanguageServerProcess::new(child, stdin, receiver, root, "rust", "rust-analyzer");
        (process, echoed, sender)
    }

    #[test]
    fn concurrent_acquires_for_one_server_key_start_a_single_process() {
        let workspace = tempfile::tempdir().unwrap();
        let root = workspace.path().to_path_buf();
        let manager = LanguageServerManager::default();
        let starts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let barrier = Arc::new(std::sync::Barrier::new(4));

        let workers = (0..4)
            .map(|_| {
                let manager = manager.clone();
                let root = root.clone();
                let starts = starts.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    manager
                        .acquire_with(&root, "rust", "rust-analyzer", || {
                            starts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            // Spawn + initialize takes a while for real servers.
                            std::thread::sleep(Duration::from_millis(150));
                            let (process, _, _) = fake_language_server(&root, Stdio::null());
                            Ok((process, "started".into()))
                        })
                        .unwrap()
                        .0
                })
            })
            .collect::<Vec<_>>();
        let server_ids = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>();

        assert_eq!(starts.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(server_ids.iter().all(|id| id == &server_ids[0]));
        assert_eq!(manager.server_ids(), vec![server_ids[0].clone()]);
        assert!(manager.starting.lock().unwrap().is_empty());
    }

    #[test]
    fn reused_server_start_returns_its_initialized_capabilities() {
        let workspace = tempfile::tempdir().unwrap();
        let root = workspace.path().canonicalize().unwrap();
        let manager = LanguageServerManager::default();
        let capabilities = serde_json::json!({
            "definitionProvider": true,
            "renameProvider": { "prepareProvider": true },
            "documentFormattingProvider": false,
            "positionEncoding": "utf-16",
        });
        let (server_id, _) = manager
            .acquire_with(&root, "rust", "rust-analyzer", || {
                let (mut process, _, _) = fake_language_server(&root, Stdio::null());
                process.capabilities = capabilities.clone();
                Ok((process, "initialized".into()))
            })
            .unwrap();
        let session = manager
            .start(LspStartRequest {
                workspace_path: root.to_string_lossy().into_owned(),
                language_id: "rust".into(),
                command: "rust-analyzer".into(),
            })
            .unwrap();

        assert_eq!(session.server_id, server_id);
        assert_eq!(session.capabilities, capabilities);
        assert_eq!(session.position_encoding, "utf-16");
        let serialized = serde_json::to_value(session).unwrap();
        assert_eq!(serialized["capabilities"], capabilities);
        assert_eq!(serialized["positionEncoding"], "utf-16");
    }

    #[test]
    fn editor_takeover_uses_a_monotonic_full_change_and_rejects_stale_text() {
        let workspace = tempfile::tempdir().unwrap();
        let (mut process, echoed, sender) = fake_language_server(workspace.path(), Stdio::piped());
        let mut echoed = BufReader::new(echoed.unwrap());
        let uri = "file:///workspace/src/lib.rs";
        ensure_document_open(&mut process, uri, "pub fn disk() {}\n").unwrap();
        ensure_document_open(&mut process, uri, "pub fn disk_updated() {}\n").unwrap();
        let manager = LanguageServerManager::default();
        manager
            .processes
            .lock()
            .unwrap()
            .insert("test".into(), Arc::new(Mutex::new(process)));
        let response = manager
            .request(LspRequestPayload {
                server_id: "test".into(),
                method: "textDocument/didOpen".into(),
                params: serde_json::json!({
                    "textDocument": { "uri": uri, "version": 1, "text": "pub fn editor() {}\n" },
                }),
            })
            .unwrap();

        assert_eq!(response["documentVersion"], 3);
        assert_eq!(
            read_lsp_message(&mut echoed).unwrap()["method"],
            "textDocument/didOpen"
        );
        assert_eq!(
            read_lsp_message(&mut echoed).unwrap()["method"],
            "textDocument/didChange"
        );
        let takeover = read_lsp_message(&mut echoed).unwrap();
        assert_eq!(takeover["method"], "textDocument/didChange");
        assert_eq!(takeover["params"]["textDocument"]["version"], 3);
        assert_eq!(
            takeover["params"]["contentChanges"][0]["text"],
            "pub fn editor() {}\n"
        );

        let stale = manager.request(LspRequestPayload {
            server_id: "test".into(),
            method: "textDocument/didChange".into(),
            params: serde_json::json!({
                "textDocument": { "uri": uri, "version": 2 },
                "contentChanges": [{ "text": "pub fn stale() {}\n" }],
            }),
        });
        assert!(stale.unwrap_err().to_string().contains("stale"));
        let response = manager
            .request(LspRequestPayload {
                server_id: "test".into(),
                method: "textDocument/didChange".into(),
                params: serde_json::json!({
                    "textDocument": { "uri": uri, "version": 4 },
                    "contentChanges": [{ "text": "pub fn current() {}\n" }],
                }),
            })
            .unwrap();
        assert_eq!(response["documentVersion"], 4);
        let current = read_lsp_message(&mut echoed).unwrap();
        // No frame was emitted for the stale change.
        assert_eq!(current["params"]["textDocument"]["version"], 4);
        assert_eq!(
            current["params"]["contentChanges"][0]["text"],
            "pub fn current() {}\n"
        );
        drop(sender);
    }

    #[test]
    fn model_requests_resync_documents_that_changed_on_disk() {
        let workspace = tempfile::tempdir().unwrap();
        let (mut process, echoed, _sender) = fake_language_server(workspace.path(), Stdio::piped());
        let mut echoed = BufReader::new(echoed.unwrap());
        let uri = "file:///workspace/src/lib.rs";

        ensure_document_open(&mut process, uri, "pub fn before() {}\n").unwrap();
        ensure_document_open(&mut process, uri, "pub fn before() {}\n").unwrap();
        ensure_document_open(&mut process, uri, "pub fn after() {}\n").unwrap();

        let opened = read_lsp_message(&mut echoed).unwrap();
        assert_eq!(opened["method"], "textDocument/didOpen");
        assert_eq!(opened["params"]["textDocument"]["version"], 1);
        // Unchanged content sends nothing, so the next frame is the change.
        let changed = read_lsp_message(&mut echoed).unwrap();
        assert_eq!(changed["method"], "textDocument/didChange");
        assert_eq!(changed["params"]["textDocument"]["uri"], uri);
        assert_eq!(changed["params"]["textDocument"]["version"], 2);
        assert_eq!(
            changed["params"]["contentChanges"][0]["text"],
            "pub fn after() {}\n"
        );

        // The editor now owns an unsaved snapshot. A disk-only model query
        // must not replace it or reason using mismatched disk coordinates.
        observe_editor_document_notification(
            &mut process,
            "textDocument/didChange",
            &serde_json::json!({
                "textDocument": { "uri": uri, "version": 1_700_000_000_000_i64 },
                "contentChanges": [{ "text": "pub fn unsaved() {}\n" }],
            }),
        );
        let error = ensure_document_open(&mut process, uri, "pub fn after() {}\n").unwrap_err();
        assert!(error
            .to_string()
            .contains("unsaved or unsynchronized editor changes"));
        assert_eq!(process.documents[uri].version, 1_700_000_000_000_i64);
        assert_eq!(
            process.documents[uri].content_hash,
            Some(lsp_document_hash("pub fn unsaved() {}\n"))
        );
        // The matching snapshot is reusable and also emits no change.
        ensure_document_open(&mut process, uri, "pub fn unsaved() {}\n").unwrap();
        write_lsp_message(
            &mut process.stdin,
            &serde_json::json!({ "method": "test/sentinel" }),
        )
        .unwrap();
        assert_eq!(
            read_lsp_message(&mut echoed).unwrap()["method"],
            "test/sentinel"
        );
    }

    #[test]
    fn editor_owned_documents_are_preserved_until_close_and_never_evicted() {
        let workspace = tempfile::tempdir().unwrap();
        let (mut process, echoed, _sender) = fake_language_server(workspace.path(), Stdio::piped());
        let mut echoed = BufReader::new(echoed.unwrap());
        let editor_uri = "file:///workspace/src/editor.rs";
        observe_editor_document_notification(
            &mut process,
            "textDocument/didOpen",
            &serde_json::json!({
                "textDocument": {
                    "uri": editor_uri,
                    "languageId": "rust",
                    "version": 1,
                    "text": "pub fn buffer() {}\n",
                }
            }),
        );

        ensure_document_open(&mut process, editor_uri, "pub fn buffer() {}\n").unwrap();
        assert!(ensure_document_open(&mut process, editor_uri, "pub fn disk() {}\n").is_err());

        // A document the model opened and the editor then opened too is
        // skipped by eviction; plain model documents are evicted oldest first.
        let shared_uri = "file:///workspace/src/shared.rs";
        ensure_document_open(&mut process, shared_uri, "pub fn shared() {}\n").unwrap();
        observe_editor_document_notification(
            &mut process,
            "textDocument/didOpen",
            &serde_json::json!({ "textDocument": { "uri": shared_uri, "version": 1 } }),
        );
        for index in 0..=MAX_OPEN_LSP_DOCUMENTS {
            let uri = format!("file:///workspace/src/model_{index}.rs");
            ensure_document_open(&mut process, &uri, "pub fn model() {}\n").unwrap();
        }
        assert!(process.documents.contains_key(editor_uri));
        assert!(process.documents.contains_key(shared_uri));
        assert!(!process
            .documents
            .contains_key("file:///workspace/src/model_0.rs"));
        assert!(process
            .documents
            .contains_key("file:///workspace/src/model_1.rs"));

        observe_editor_document_notification(
            &mut process,
            "textDocument/didClose",
            &serde_json::json!({ "textDocument": { "uri": editor_uri } }),
        );
        ensure_document_open(&mut process, editor_uri, "pub fn disk() {}\n").unwrap();
        assert!(!process.documents[editor_uri].editor_open);
        assert_eq!(
            process.documents[editor_uri].content_hash,
            Some(lsp_document_hash("pub fn disk() {}\n"))
        );
        // The first actual frame remains the model's shared document open:
        // reading/rejecting an editor snapshot did not emit any protocol edit.
        assert_eq!(
            read_lsp_message(&mut echoed).unwrap()["params"]["textDocument"]["uri"],
            shared_uri
        );
    }

    #[test]
    fn incremental_editor_changes_never_trigger_disk_resynchronization() {
        let workspace = tempfile::tempdir().unwrap();
        let (mut process, _, _sender) = fake_language_server(workspace.path(), Stdio::null());
        let uri = "file:///workspace/src/lib.rs";
        ensure_document_open(&mut process, uri, "pub fn disk() {}\n").unwrap();
        observe_editor_document_notification(
            &mut process,
            "textDocument/didChange",
            &serde_json::json!({
                "textDocument": { "uri": uri, "version": 2 },
                "contentChanges": [{
                    "range": { "start": { "line": 0, "character": 7 }, "end": { "line": 0, "character": 11 } },
                    "text": "edited",
                }],
            }),
        );
        let error = ensure_document_open(&mut process, uri, "pub fn disk() {}\n").unwrap_err();
        assert!(error.to_string().contains("unsynchronized editor changes"));
        assert_eq!(process.documents[uri].version, 2);
        assert!(process.documents[uri].editor_open);
        assert!(process.documents[uri].content_hash.is_none());
    }

    #[test]
    fn notification_bursts_before_a_response_do_not_fail_the_request() {
        let workspace = tempfile::tempdir().unwrap();
        let (mut process, _, sender) = fake_language_server(workspace.path(), Stdio::null());
        let diagnostics = |index: usize| {
            serde_json::json!({
                "jsonrpc": "2.0",
                "method": "textDocument/publishDiagnostics",
                "params": { "uri": format!("file:///workspace/src/{index}.rs"), "diagnostics": [] },
            })
        };
        let burst = 400;
        for index in 0..burst {
            sender.send(Ok(diagnostics(index))).unwrap();
        }
        // A reply to some other request does not end the wait either.
        sender
            .send(Ok(
                serde_json::json!({ "jsonrpc": "2.0", "id": 3, "result": null }),
            ))
            .unwrap();
        sender
            .send(Ok(
                serde_json::json!({ "jsonrpc": "2.0", "id": 7, "result": [1] }),
            ))
            .unwrap();

        let (response, messages) =
            receive_lsp_response(&mut process, 7, Duration::from_secs(5)).unwrap();

        assert_eq!(response["result"], serde_json::json!([1]));
        assert_eq!(messages.len(), MAX_IDE_PROTOCOL_MESSAGES_PER_RESPONSE);
        assert_eq!(messages[0], diagnostics(0));
        // The overflow waits, bounded and in order, for the editor's poll;
        // the oldest of it is dropped first.
        let mut polled = Vec::new();
        loop {
            let batch = drain_lsp_messages(&mut process).unwrap();
            if batch.is_empty() {
                break;
            }
            polled.extend(batch);
        }
        assert_eq!(polled.len(), MAX_LSP_BACKLOG_MESSAGES);
        assert_eq!(
            polled.last().unwrap(),
            &serde_json::json!({ "jsonrpc": "2.0", "id": 3, "result": null })
        );
        assert_eq!(polled[polled.len() - 2], diagnostics(burst - 1));
        assert_eq!(process.backlog_bytes, 0);
    }

    #[test]
    fn empty_semantic_answers_are_recognized_by_shape() {
        assert!(lsp_result_is_empty(&serde_json::Value::Null));
        assert!(lsp_result_is_empty(&serde_json::json!([])));
        assert!(!lsp_result_is_empty(&serde_json::json!([
            { "uri": "file:///workspace/src/lib.rs" }
        ])));
        assert!(!lsp_result_is_empty(
            &serde_json::json!({ "contents": "hover" })
        ));
    }
}
