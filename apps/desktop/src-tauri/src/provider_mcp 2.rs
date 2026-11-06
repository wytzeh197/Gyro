//! Bounded MCP stdio dispatch. A long workspace operation must not prevent
//! health checks, tool discovery, or other independent tool calls from reaching
//! the desktop broker. Each submitted operation executes at most once.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::{mpsc, Arc, Mutex};

const TOOL_WORKERS: usize = 4;
const TOOL_QUEUE_CAPACITY: usize = 16;

#[derive(Clone, Copy, PartialEq)]
enum CallState {
    Queued,
    Running,
    Cancelled,
}

fn error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message.into()}})
}

fn send(output: &Mutex<impl Write>, message: &Value) -> anyhow::Result<()> {
    let mut output = output
        .lock()
        .map_err(|_| anyhow::anyhow!("MCP output is unavailable"))?;
    super::write_desktop_mcp_message(&mut *output, message)
}

pub(super) fn serve<R, W, F>(
    input: &mut R,
    output: W,
    name: &str,
    tools: Vec<Value>,
    call: F,
) -> anyhow::Result<()>
where
    R: BufRead,
    W: Write + Send,
    F: Fn(Value) -> anyhow::Result<Value> + Sync,
{
    let output = Mutex::new(output);
    let (sender, receiver) = mpsc::sync_channel::<(Value, Value)>(TOOL_QUEUE_CAPACITY);
    let receiver = Mutex::new(receiver);
    let active = Mutex::new(HashMap::<String, CallState>::new());
    let write_error = Arc::new(Mutex::new(None::<String>));
    std::thread::scope(|scope| {
        for _ in 0..TOOL_WORKERS {
            let (receiver, output, active, call) = (&receiver, &output, &active, &call);
            let write_error = Arc::clone(&write_error);
            scope.spawn(move || loop {
                let request = match receiver.lock() {
                    Ok(receiver) => receiver.recv(),
                    Err(_) => return,
                };
                let Ok((id, params)) = request else { return };
                {
                    let mut active = active.lock().unwrap();
                    if active.get(&id.to_string()) == Some(&CallState::Cancelled) {
                        active.remove(&id.to_string());
                        continue;
                    }
                    active.insert(id.to_string(), CallState::Running);
                }
                let result = match call(params) {
                    Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
                    Err(failure) => error(
                        id.clone(),
                        -32603,
                        gyro_core::sanitize_capability_summary(&failure.to_string()),
                    ),
                };
                active.lock().unwrap().remove(&id.to_string());
                if let Err(failure) = send(output, &result) {
                    *write_error.lock().unwrap() = Some(failure.to_string());
                    return;
                }
            });
        }
        let result = (|| {
            while let Some(line) =
                super::read_bounded_protocol_line(input, super::MAX_PERMISSION_MCP_MESSAGE_BYTES)
                    .map_err(anyhow::Error::msg)?
            {
                if let Some(failure) = write_error.lock().unwrap().take() {
                    anyhow::bail!(failure);
                }
                if line.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                let request: Value = match serde_json::from_slice(&line) {
                    Ok(request) => request,
                    Err(_) => {
                        send(&output, &error(Value::Null, -32700, "Invalid JSON"))?;
                        continue;
                    }
                };
                let id = request.get("id").cloned();
                let method = request.get("method").and_then(Value::as_str);
                if request.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
                    || method.is_none()
                    || id
                        .as_ref()
                        .is_some_and(|id| !id.is_string() && !id.is_number())
                {
                    send(
                        &output,
                        &error(Value::Null, -32600, "Invalid JSON-RPC request"),
                    )?;
                    continue;
                }
                // Withdraw queued work before it can mutate the workspace.
                // In-flight operations use the broker's run cancellation; closing
                // their socket alone cannot safely roll an operation back.
                let Some(id) = id else {
                    if method == Some("notifications/cancelled") {
                        if let Some(request_id) = request.pointer("/params/requestId") {
                            let mut active = active.lock().unwrap();
                            if let Some(state) = active.get_mut(&request_id.to_string()) {
                                if *state == CallState::Queued {
                                    *state = CallState::Cancelled;
                                }
                            }
                        }
                    }
                    continue;
                };
                let method = method.unwrap();
                let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
                if !params.is_object() {
                    send(&output, &error(id, -32602, "MCP params must be an object"))?;
                    continue;
                }
                let result = match method {
                    "initialize" => json!({
                        "protocolVersion": params.get("protocolVersion")
                            .and_then(Value::as_str).unwrap_or("2024-11-05"),
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": name, "version": env!("CARGO_PKG_VERSION")},
                    }),
                    "ping" => json!({}),
                    "tools/list" => json!({"tools": tools}),
                    "tools/call" => {
                        let tool_name = params.get("name").and_then(Value::as_str);
                        if !tools
                            .iter()
                            .any(|tool| tool.get("name").and_then(Value::as_str) == tool_name)
                            || tool_name.is_none()
                            || params
                                .get("arguments")
                                .is_some_and(|arguments| !arguments.is_object())
                        {
                            send(
                                &output,
                                &error(id, -32602, "Unknown tool or invalid tool arguments"),
                            )?;
                            continue;
                        }
                        let key = id.to_string();
                        {
                            let mut active = active.lock().unwrap();
                            if active.contains_key(&key) {
                                send(&output, &error(id, -32600, "Request id is already in use"))?;
                                continue;
                            }
                            active.insert(key.clone(), CallState::Queued);
                        }
                        if let Err(failure) = sender.try_send((id.clone(), params)) {
                            active.lock().unwrap().remove(&key);
                            let message = match failure {
                                mpsc::TrySendError::Full(_) => {
                                    "Gyro tool queue is full; wait for an active call to finish"
                                }
                                mpsc::TrySendError::Disconnected(_) => {
                                    "Gyro tool workers are unavailable"
                                }
                            };
                            send(&output, &error(id, -32000, message))?;
                        }
                        continue;
                    }
                    _ => {
                        send(
                            &output,
                            &error(id, -32601, format!("Unsupported MCP method `{method}`")),
                        )?;
                        continue;
                    }
                };
                send(
                    &output,
                    &json!({"jsonrpc": "2.0", "id": id, "result": result}),
                )?;
            }
            Ok(())
        })();
        // Closing the queue drains accepted calls exactly once and releases
        // workers on normal EOF and all reader/protocol errors.
        drop(sender);
        result
    })?;
    if let Some(failure) = write_error.lock().unwrap().take() {
        anyhow::bail!(failure);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::io::Cursor;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Condvar;
    use std::time::Duration;

    struct ChannelWriter(mpsc::Sender<Value>, Vec<u8>);

    impl Write for ChannelWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.1.extend_from_slice(bytes);
            while let Some(newline) = self.1.iter().position(|byte| *byte == b'\n') {
                let frame: Vec<_> = self.1.drain(..=newline).collect();
                self.0
                    .send(serde_json::from_slice(&frame).unwrap())
                    .unwrap();
            }
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn tools() -> Vec<Value> {
        vec![json!({"name": "fixture", "inputSchema": {"type": "object"}})]
    }

    #[test]
    fn long_tool_call_does_not_block_ping_discovery_or_independent_calls() {
        let (output_tx, output_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = Mutex::new(release_rx);
        let worker = std::thread::spawn(move || {
            let mut input = Cursor::new(concat!(
                "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"fixture\",\"arguments\":{\"wait\":true}}}\n",
                "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"fixture\"}}\n",
                "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"ping\"}\n",
                "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/list\"}\n",
            ));
            serve(
                &mut input,
                ChannelWriter(output_tx, Vec::new()),
                "fixture",
                tools(),
                |params| {
                    if params.pointer("/arguments/wait") == Some(&json!(true)) {
                        release_rx.lock().unwrap().recv().unwrap();
                    }
                    Ok(json!({"content": []}))
                },
            )
        });

        let mut ready = HashSet::new();
        for _ in 0..3 {
            let response = output_rx.recv_timeout(Duration::from_secs(3)).unwrap();
            ready.insert(response["id"].as_u64().unwrap());
        }
        assert_eq!(ready, HashSet::from([2, 3, 4]));
        release_tx.send(()).unwrap();
        assert_eq!(
            output_rx.recv_timeout(Duration::from_secs(3)).unwrap()["id"],
            1
        );
        worker.join().unwrap().unwrap();
        assert!(output_rx.try_recv().is_err());
    }

    #[test]
    fn invalid_messages_are_reported_without_executing_notifications() {
        let mut input = Cursor::new(concat!(
            "invalid json\n",
            "{\"id\":1,\"method\":\"ping\"}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"unknown\"}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"missing\"}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"fixture\",\"arguments\":[]}}\n",
            "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{\"name\":\"fixture\"}}\n",
            "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"ping\"}\n",
        ));
        let mut output = Vec::new();
        serve(&mut input, &mut output, "fixture", tools(), |_| {
            panic!("invalid requests and notifications must not invoke tools")
        })
        .unwrap();
        let responses: Vec<Value> = output
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect();
        assert_eq!(responses.len(), 6);
        for (response, code) in responses
            .iter()
            .zip([-32700, -32600, -32601, -32602, -32602])
        {
            assert_eq!(response["error"]["code"], code);
        }
        assert_eq!(responses[5]["id"], 5);
        assert!(responses[5].get("result").is_some());
    }

    #[test]
    fn cancelled_queued_tool_is_never_executed() {
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let worker_gate = Arc::clone(&gate);
        let (output_tx, output_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let mut input = String::new();
            for id in 0..=TOOL_WORKERS {
                input.push_str(&json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":"fixture","arguments":{"id":id}}}).to_string());
                input.push('\n');
            }
            input.push_str(&json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":TOOL_WORKERS}}).to_string());
            input.push_str("\n{\"jsonrpc\":\"2.0\",\"id\":100,\"method\":\"ping\"}\n");
            serve(
                &mut Cursor::new(input),
                ChannelWriter(output_tx, Vec::new()),
                "fixture",
                tools(),
                |params| {
                    assert_ne!(params["arguments"]["id"], TOOL_WORKERS);
                    let (lock, released) = &*worker_gate;
                    let mut ready = lock.lock().unwrap();
                    while !*ready {
                        ready = released.wait(ready).unwrap();
                    }
                    Ok(json!({"content": []}))
                },
            )
        });
        assert_eq!(
            output_rx.recv_timeout(Duration::from_secs(3)).unwrap()["id"],
            100
        );
        *gate.0.lock().unwrap() = true;
        gate.1.notify_all();
        worker.join().unwrap().unwrap();
        let completed: Vec<_> = output_rx.try_iter().collect();
        assert_eq!(completed.len(), TOOL_WORKERS);
        assert!(completed
            .iter()
            .all(|response| response["id"] != TOOL_WORKERS));
    }

    #[test]
    fn saturated_tool_queue_is_bounded_and_does_not_block_ping_or_replay_calls() {
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let worker_gate = Arc::clone(&gate);
        let invoked = Arc::new(AtomicUsize::new(0));
        let worker_invoked = Arc::clone(&invoked);
        let (output_tx, output_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let mut input = String::new();
            for id in 0..100 {
                input.push_str(&json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":"fixture"}}).to_string());
                input.push('\n');
            }
            input.push_str("{\"jsonrpc\":\"2.0\",\"id\":100,\"method\":\"ping\"}\n");
            serve(
                &mut Cursor::new(input),
                ChannelWriter(output_tx, Vec::new()),
                "fixture",
                tools(),
                |_| {
                    worker_invoked.fetch_add(1, Ordering::SeqCst);
                    let (lock, released) = &*worker_gate;
                    let mut ready = lock.lock().unwrap();
                    while !*ready {
                        ready = released.wait(ready).unwrap();
                    }
                    Ok(json!({"content": []}))
                },
            )
        });
        let mut rejected = 0;
        loop {
            let response = output_rx.recv_timeout(Duration::from_secs(3)).unwrap();
            if response["id"] == 100 {
                break;
            }
            assert_eq!(response["error"]["code"], -32000);
            rejected += 1;
        }
        assert!(invoked.load(Ordering::SeqCst) <= TOOL_WORKERS);
        assert!(rejected >= 100 - TOOL_QUEUE_CAPACITY - TOOL_WORKERS);
        *gate.0.lock().unwrap() = true;
        gate.1.notify_all();
        worker.join().unwrap().unwrap();
        let completed = output_rx.try_iter().count();
        assert_eq!(completed + rejected, 100);
        assert_eq!(completed, invoked.load(Ordering::SeqCst));
    }
}
