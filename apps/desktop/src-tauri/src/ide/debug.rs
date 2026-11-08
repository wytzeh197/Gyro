//! Debug adapter commands and protocol handling.

use crate::{
    command_with_gui_path, language_server, to_string, workspace_root, DebugAdapterManager,
    DebugAdapterProcess, DebugSendRequest, DebugSessionResult, DebugStartRequest,
    MAX_DAP_OUTPUT_EVENT_BYTES, MAX_DEBUG_ADAPTER_PROCESSES,
    MAX_IDE_PROTOCOL_MESSAGES_PER_RESPONSE, MAX_IDE_PROTOCOL_RESPONSE_BYTES,
};
use std::{
    process::Stdio,
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};
use uuid::Uuid;

#[tauri::command]
pub(crate) async fn debug_start(
    request: DebugStartRequest,
    manager: tauri::State<'_, DebugAdapterManager>,
) -> Result<DebugSessionResult, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.start(request).map_err(to_string))
        .await
        .map_err(|error| format!("debug start worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn debug_send(
    request: DebugSendRequest,
    manager: tauri::State<'_, DebugAdapterManager>,
) -> Result<serde_json::Value, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.send(request).map_err(to_string))
        .await
        .map_err(|error| format!("debug request worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn debug_stop(
    session_id: String,
    manager: tauri::State<'_, DebugAdapterManager>,
) -> Result<serde_json::Value, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.stop(&session_id).map_err(to_string))
        .await
        .map_err(|error| format!("debug stop worker failed: {error}"))?
}

impl DebugAdapterManager {
    pub(crate) fn start(&self, request: DebugStartRequest) -> anyhow::Result<DebugSessionResult> {
        let existing_processes = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("debug adapter manager lock poisoned"))?
            .iter()
            .map(|(session_id, process)| (session_id.clone(), process.clone()))
            .collect::<Vec<_>>();
        let mut stale_processes = Vec::new();
        let mut live_processes = 0usize;
        for (session_id, process) in existing_processes {
            if process
                .lock()
                .map_err(|_| anyhow::anyhow!("debug adapter process lock poisoned"))?
                .child
                .try_wait()?
                .is_some()
            {
                stale_processes.push(session_id);
            } else {
                live_processes += 1;
            }
        }
        if !stale_processes.is_empty() {
            let mut processes = self
                .processes
                .lock()
                .map_err(|_| anyhow::anyhow!("debug adapter manager lock poisoned"))?;
            for session_id in stale_processes {
                processes.remove(&session_id);
            }
        }
        if live_processes >= MAX_DEBUG_ADAPTER_PROCESSES {
            anyhow::bail!("debug adapter process limit reached; stop a debug session first");
        }
        let root = request
            .workspace_path
            .as_deref()
            .map(workspace_root)
            .transpose()?;
        let command_text = request
            .command
            .as_deref()
            .unwrap_or(&request.adapter)
            .trim();
        let mut command_parts = command_text.split_whitespace();
        let command_name = command_parts
            .next()
            .ok_or_else(|| anyhow::anyhow!("debug adapter command is required"))?;
        let mut args = command_parts.map(ToOwned::to_owned).collect::<Vec<_>>();
        args.extend(request.args.clone().unwrap_or_default());
        if !debug_adapter_command_is_allowed(&request.adapter, command_name, &args) {
            anyhow::bail!("debug adapter command requires a native allowlist entry");
        }
        let mut command = command_with_gui_path(command_name);
        command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(root) = root.as_ref() {
            command.current_dir(root);
        }
        let mut child = gyro_core::process_guard::spawn_service(&mut command).map_err(|error| {
            anyhow::anyhow!("failed to start debug adapter {command_name}: {error}")
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("debug adapter stdin unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("debug adapter stdout unavailable"))?;
        let mut process = DebugAdapterProcess {
            child,
            stdin,
            messages: language_server::spawn_lsp_message_reader(stdout),
            next_sequence: 2,
            name: request.name.clone(),
            adapter: request.adapter.clone(),
            launched: false,
        };
        language_server::write_lsp_message(
            &mut process.stdin,
            &serde_json::json!({
                "seq": 1,
                "type": "request",
                "command": "initialize",
                "arguments": {
                    "clientID": "gyro",
                    "clientName": "Gyro",
                    "adapterID": request.adapter,
                    "pathFormat": "path",
                    "linesStartAt1": true,
                    "columnsStartAt1": true,
                    "supportsVariableType": true,
                    "supportsVariablePaging": true,
                    "supportsRunInTerminalRequest": false,
                    "supportsMemoryReferences": true,
                    "supportsProgressReporting": true,
                    "supportsInvalidatedEvent": true
                }
            }),
        )?;
        let (response, events) = receive_dap_response(&mut process, 1, Duration::from_secs(12))?;
        if response.get("success").and_then(|value| value.as_bool()) == Some(false) {
            let message = response
                .get("message")
                .and_then(|value| value.as_str())
                .unwrap_or("debug adapter initialize failed");
            anyhow::bail!("{message}");
        }
        let capabilities = response
            .get("body")
            .and_then(|value| value.as_object())
            .map(|body| {
                body.iter()
                    .filter_map(|(key, value)| {
                        value
                            .as_bool()
                            .is_some_and(|value| value)
                            .then_some(key.clone())
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let session_id = format!("debug-{}", Uuid::new_v4());
        let message = Some(format!(
            "Initialized with {} capabilities and {} startup events",
            capabilities.len(),
            events.len()
        ));
        let result = DebugSessionResult {
            id: session_id.clone(),
            name: request.name,
            adapter: request.adapter,
            status: "configured".into(),
            message,
            capabilities,
        };
        let mut processes = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("debug adapter manager lock poisoned"))?;
        if processes.len() >= MAX_DEBUG_ADAPTER_PROCESSES {
            let _ = process.child.kill();
            let _ = process.child.wait();
            anyhow::bail!("debug adapter process limit reached; stop a debug session first");
        }
        processes.insert(session_id, Arc::new(Mutex::new(process)));
        Ok(result)
    }

    pub(crate) fn send(&self, request: DebugSendRequest) -> anyhow::Result<serde_json::Value> {
        let process = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("debug adapter manager lock poisoned"))?
            .get(&request.session_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("debug session is not running"))?;
        let mut process = process
            .lock()
            .map_err(|_| anyhow::anyhow!("debug adapter process lock poisoned"))?;
        if let Some(status) = process.child.try_wait()? {
            anyhow::bail!("debug adapter exited with {status}");
        }
        let command = request
            .request
            .get("command")
            .and_then(|value| value.as_str())
            .ok_or_else(|| anyhow::anyhow!("debug request command is required"))?;
        if command == "$/gyro/poll" {
            let events = drain_dap_messages(&mut process)?;
            return Ok(redact_json_strings(serde_json::json!({
                "sessionId": request.session_id,
                "name": process.name,
                "adapter": process.adapter,
                "status": "ok",
                "events": events,
            })));
        }
        if command == "launch" || command == "attach" {
            process.launched = command == "launch";
        }
        let sequence = process.next_sequence;
        process.next_sequence += 1;
        language_server::write_lsp_message(
            &mut process.stdin,
            &serde_json::json!({
                "seq": sequence,
                "type": "request",
                "command": command,
                "arguments": request.request.get("arguments").cloned().unwrap_or_else(|| serde_json::json!({})),
            }),
        )?;
        let (response, events) =
            receive_dap_response(&mut process, sequence, Duration::from_secs(20))?;
        Ok(redact_json_strings(serde_json::json!({
            "sessionId": request.session_id,
            "status": if response.get("success").and_then(|value| value.as_bool()) == Some(false) { "error" } else { "ok" },
            "response": response,
            "events": events,
        })))
    }

    pub(crate) fn stop(&self, session_id: &str) -> anyhow::Result<serde_json::Value> {
        let process = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("debug adapter manager lock poisoned"))?
            .remove(session_id);
        let Some(process) = process else {
            return Ok(serde_json::json!({ "sessionId": session_id, "status": "stopped" }));
        };
        let mut process = process
            .lock()
            .map_err(|_| anyhow::anyhow!("debug adapter process lock poisoned"))?;
        let sequence = process.next_sequence;
        let terminate_debuggee = process.launched;
        let _ = language_server::write_lsp_message(
            &mut process.stdin,
            &serde_json::json!({
                "seq": sequence,
                "type": "request",
                "command": "disconnect",
                "arguments": { "terminateDebuggee": terminate_debuggee }
            }),
        );
        let _ = receive_dap_response(&mut process, sequence, Duration::from_secs(2));
        let _ = process.child.kill();
        let _ = process.child.wait();
        Ok(serde_json::json!({ "sessionId": session_id, "status": "stopped" }))
    }
}

pub(crate) fn debug_adapter_command_is_allowed(
    adapter: &str,
    command: &str,
    args: &[String],
) -> bool {
    if command.is_empty()
        || command.contains('/')
        || command.contains('\\')
        || args.len() > 32
        || args
            .iter()
            .any(|arg| arg.len() > 4_096 || arg.as_bytes().contains(&0))
    {
        return false;
    }
    #[cfg(test)]
    if adapter == "fake" && command == "python3" {
        return true;
    }
    let allowed = [
        "lldb-dap",
        "codelldb",
        "debugpy-adapter",
        "dlv",
        "js-debug-adapter",
        "vscode-js-debug",
        "netcoredbg",
        "OpenDebugAD7",
    ];
    adapter == command && allowed.contains(&command)
}

pub(crate) fn receive_dap_response(
    process: &mut DebugAdapterProcess,
    request_sequence: u64,
    timeout: Duration,
) -> anyhow::Result<(serde_json::Value, Vec<serde_json::Value>)> {
    let deadline = Instant::now() + timeout;
    let mut events = Vec::new();
    let mut event_bytes = 0usize;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            anyhow::bail!("debug adapter request timed out");
        }
        let message = process
            .messages
            .recv_timeout(remaining)
            .map_err(|error| anyhow::anyhow!("debug adapter response failed: {error}"))?
            .map_err(anyhow::Error::msg)?;
        if message.get("type").and_then(|value| value.as_str()) == Some("response")
            && message.get("request_seq").and_then(|value| value.as_u64()) == Some(request_sequence)
        {
            return Ok((message, events));
        }
        handle_dap_adapter_request(process, &message)?;
        // A launch can print far more output than a message cap allows before
        // it responds. Output past the byte budget is dropped; other events stay.
        if message.get("event").and_then(|value| value.as_str()) == Some("output")
            && event_bytes.saturating_add(serde_json::to_vec(&message)?.len())
                > MAX_DAP_OUTPUT_EVENT_BYTES
        {
            continue;
        }
        add_ide_protocol_message_bytes(&mut event_bytes, &message)?;
        events.push(message);
    }
}

pub(crate) fn drain_dap_messages(
    process: &mut DebugAdapterProcess,
) -> anyhow::Result<Vec<serde_json::Value>> {
    let mut messages = Vec::new();
    let mut message_bytes = 0usize;
    for _ in 0..MAX_IDE_PROTOCOL_MESSAGES_PER_RESPONSE {
        let message = match process.messages.try_recv() {
            Ok(message) => message.map_err(anyhow::Error::msg)?,
            Err(mpsc::TryRecvError::Empty) => break,
            Err(mpsc::TryRecvError::Disconnected) => {
                anyhow::bail!("debug adapter output disconnected")
            }
        };
        handle_dap_adapter_request(process, &message)?;
        add_ide_protocol_message_bytes(&mut message_bytes, &message)?;
        messages.push(message);
    }
    Ok(messages)
}

pub(crate) fn add_ide_protocol_message_bytes(
    total: &mut usize,
    message: &serde_json::Value,
) -> anyhow::Result<()> {
    *total = total.saturating_add(serde_json::to_vec(message)?.len());
    if *total > MAX_IDE_PROTOCOL_RESPONSE_BYTES {
        anyhow::bail!("IDE protocol response exceeded its aggregate size limit");
    }
    Ok(())
}

pub(crate) fn handle_dap_adapter_request(
    process: &mut DebugAdapterProcess,
    message: &serde_json::Value,
) -> anyhow::Result<()> {
    if message.get("type").and_then(|value| value.as_str()) != Some("request") {
        return Ok(());
    }
    let Some(request_sequence) = message.get("seq").and_then(|value| value.as_u64()) else {
        return Ok(());
    };
    let command = message
        .get("command")
        .and_then(|value| value.as_str())
        .unwrap_or("adapterRequest");
    let sequence = process.next_sequence;
    process.next_sequence += 1;
    language_server::write_lsp_message(
        &mut process.stdin,
        &serde_json::json!({
            "seq": sequence,
            "type": "response",
            "request_seq": request_sequence,
            "command": command,
            "success": false,
            "message": format!("Gyro does not support adapter request {command} yet")
        }),
    )
}

pub(crate) fn redact_json_strings(mut value: serde_json::Value) -> serde_json::Value {
    fn redact(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::String(text) => {
                *text = gyro_core::security::redact_secrets(text);
            }
            serde_json::Value::Array(items) => items.iter_mut().for_each(redact),
            serde_json::Value::Object(map) => map.values_mut().for_each(redact),
            _ => {}
        }
    }
    redact(&mut value);
    value
}
