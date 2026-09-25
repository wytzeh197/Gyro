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
    MAX_WORKSPACE_FILE_EDIT_BYTES,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Stdio};
use std::sync::{mpsc, Arc, Mutex};
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
    DocumentSymbol,
}

impl LspFileRequest {
    fn feature(self) -> &'static str {
        match self {
            Self::Definition { .. } => "definitionProvider",
            Self::References { .. } => "referencesProvider",
            Self::Hover { .. } => "hoverProvider",
            Self::DocumentSymbol => "documentSymbolProvider",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Definition { .. } => "definition",
            Self::References { .. } => "references",
            Self::Hover { .. } => "hover",
            Self::DocumentSymbol => "document symbols",
        }
    }

    fn method(self) -> &'static str {
        match self {
            Self::Definition { .. } => "textDocument/definition",
            Self::References { .. } => "textDocument/references",
            Self::Hover { .. } => "textDocument/hover",
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
}

#[derive(Clone, Default)]
pub struct LanguageServerManager {
    processes: Arc<Mutex<HashMap<String, Arc<Mutex<LanguageServerProcess>>>>>,
}

struct LanguageServerProcess {
    child: Child,
    stdin: ChildStdin,
    messages: mpsc::Receiver<Result<serde_json::Value, String>>,
    next_request_id: u64,
    semantic_tokens: serde_json::Value,
    capabilities: serde_json::Value,
    open_documents: VecDeque<String>,
    open_document_set: HashSet<String>,
    root: PathBuf,
    language_id: String,
    command: String,
    /// Whether this server has ever answered with a real semantic result.
    /// A cold rust-analyzer answers promptly with an empty list instead of
    /// timing out and sends no readiness notification, so an empty answer
    /// from a server that has never produced a result is "still loading".
    answered_nonempty: bool,
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
        Ok(LspSessionResult {
            server_id,
            language_id: request.language_id,
            command: command_text,
            status: "ready".into(),
            message,
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

        let mut command = command_with_gui_path(command_name);
        command
            .args(args)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command.spawn().map_err(|error| {
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
        let mut process = LanguageServerProcess {
            child,
            stdin,
            messages: spawn_lsp_message_reader(stdout),
            next_request_id: 2,
            semantic_tokens: serde_json::Value::Null,
            capabilities: serde_json::Value::Null,
            open_documents: VecDeque::new(),
            open_document_set: HashSet::new(),
            root: root.to_path_buf(),
            language_id: language_id.to_string(),
            command: command_text.to_string(),
            answered_nonempty: false,
        };
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
                        "workspace": { "workspaceFolders": true, "configuration": true },
                        "textDocument": {
                            "publishDiagnostics": { "relatedInformation": true },
                            "completion": { "completionItem": { "snippetSupport": true } },
                            "hover": { "contentFormat": ["markdown", "plaintext"] },
                            "definition": { "linkSupport": true },
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
        let capability_count = initialize_response
            .pointer("/result/capabilities")
            .and_then(|value| value.as_object())
            .map(|value| value.len())
            .unwrap_or(0);
        let server_id = format!("{language_id}:{}", Uuid::new_v4());
        let mut processes = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("language server manager lock poisoned"))?;
        if processes.len() >= MAX_LANGUAGE_SERVER_PROCESSES {
            let _ = process.child.kill();
            let _ = process.child.wait();
            anyhow::bail!("language server process limit reached; stop a server first");
        }
        processes.insert(server_id.clone(), Arc::new(Mutex::new(process)));
        Ok((
            server_id,
            format!(
                "Initialized with {capability_count} capabilities and {} startup messages",
                startup_messages.len()
            ),
        ))
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
            write_lsp_message(
                &mut process.stdin,
                &serde_json::json!({
                    "jsonrpc": "2.0",
                    "method": request.method,
                    "params": request.params,
                }),
            )?;
            let messages = drain_lsp_messages(&mut process)?;
            return Ok(serde_json::json!({
                "serverId": request.server_id,
                "status": "sent",
                "messages": messages,
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
        let open_documents = process.open_documents.drain(..).collect::<Vec<_>>();
        process.open_document_set.clear();
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

/// Send `textDocument/didOpen` the first time a document is touched, and
/// `didClose` when the registry evicts one. The editor's own bookkeeping is
/// renderer-only, so this registry is what makes model requests answerable
/// for files the user never opened.
fn ensure_document_open(
    process: &mut LanguageServerProcess,
    uri: &str,
    text: &str,
) -> anyhow::Result<()> {
    if process.open_document_set.contains(uri) {
        return Ok(());
    }
    while process.open_documents.len() >= MAX_OPEN_LSP_DOCUMENTS {
        let Some(evicted) = process.open_documents.pop_front() else {
            break;
        };
        process.open_document_set.remove(&evicted);
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
    process.open_document_set.insert(uri.to_owned());
    Ok(())
}

fn lsp_feature_supported(capabilities: &serde_json::Value, feature: &str) -> bool {
    match capabilities.get(feature) {
        Some(serde_json::Value::Bool(value)) => *value,
        Some(serde_json::Value::Object(_)) => true,
        _ => false,
    }
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
            .map_err(|error| anyhow::anyhow!("language server response failed: {error}"))?
            .map_err(anyhow::Error::msg)?;
        if message.get("id").and_then(|value| value.as_u64()) == Some(request_id) {
            return Ok((message, messages));
        }
        handle_lsp_server_message(process, &message)?;
        if messages.len() >= MAX_IDE_PROTOCOL_MESSAGES_PER_RESPONSE {
            anyhow::bail!("language server produced too many messages before its response");
        }
        add_ide_protocol_message_bytes(&mut message_bytes, &message)?;
        messages.push(message);
    }
}

fn drain_lsp_messages(
    process: &mut LanguageServerProcess,
) -> anyhow::Result<Vec<serde_json::Value>> {
    let mut messages = Vec::new();
    let mut message_bytes = 0usize;
    for _ in 0..MAX_IDE_PROTOCOL_MESSAGES_PER_RESPONSE {
        let message = match process.messages.try_recv() {
            Ok(message) => message.map_err(anyhow::Error::msg)?,
            Err(mpsc::TryRecvError::Empty) => break,
            Err(mpsc::TryRecvError::Disconnected) => {
                anyhow::bail!("language server output disconnected")
            }
        };
        handle_lsp_server_message(process, &message)?;
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
