//! Confined workspace inspection. Every admitted child action re-enters the broker.
use super::*;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

const MAX_SOURCE: usize = 16 * 1024;
const MAX_FRAME: usize = 128 * 1024;
const MAX_CALLS: usize = 32;
const MAX_DATA: usize = 512 * 1024;
const LIMIT: Duration = Duration::from_secs(60);

/// macOS task_info layout from the platform SDK. RSS bounds script allocations
/// that would otherwise fit neither the tool-data nor returned-output budget.
#[cfg(target_os = "macos")]
fn worker_resident_bytes(pid: u32) -> Option<u64> {
    #[link(name = "proc")]
    unsafe extern "C" {
        fn proc_pidinfo(
            pid: i32,
            flavor: i32,
            arg: u64,
            buffer: *mut libc::c_void,
            size: i32,
        ) -> i32;
    }
    let mut info = [0u64; 12];
    let read = unsafe {
        proc_pidinfo(
            pid as i32,
            4,
            0,
            info.as_mut_ptr().cast(),
            std::mem::size_of_val(&info) as i32,
        )
    };
    (read >= 16).then_some(info[1])
}
#[cfg(not(target_os = "macos"))]
fn worker_resident_bytes(_pid: u32) -> Option<u64> {
    None
}

#[derive(Clone)]
struct Group {
    id: Uuid,
    label: String,
    source: String,
    outcome: Arc<Mutex<Option<Value>>>,
    stopped: Arc<AtomicBool>,
}
thread_local! { static GROUP: RefCell<Option<Group>> = const { RefCell::new(None) }; }

pub(super) struct GroupScope(Option<Group>);
impl Drop for GroupScope {
    fn drop(&mut self) {
        GROUP.with(|slot| *slot.borrow_mut() = self.0.take());
    }
}
fn enter(group: Group) -> GroupScope {
    GroupScope(GROUP.with(|slot| slot.borrow_mut().replace(group)))
}
pub(super) fn begin(request: &CapabilityRequest) -> Option<GroupScope> {
    if request.capability_id != CapabilityId::CodeModeExecute {
        return None;
    }
    Some(enter(Group {
        id: request.context.call_id,
        label: gyro_core::sanitize_capability_summary(
            request
                .arguments
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or("Inspecting workspace"),
        )
        .chars()
        .take(100)
        .collect(),
        source: gyro_core::sanitize_harness_text(
            request
                .arguments
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or(""),
        )
        .chars()
        .take(MAX_SOURCE)
        .collect(),
        outcome: Arc::new(Mutex::new(None)),
        stopped: Arc::new(AtomicBool::new(false)),
    }))
}
pub(super) fn in_group() -> bool {
    GROUP.with(|slot| slot.borrow().is_some())
}
pub(super) fn finish_approval(
    app: &tauri::AppHandle,
    store: &SessionStore,
    session_id: Uuid,
    turn_id: Option<Uuid>,
    approval_id: Uuid,
    decision: &Result<CapabilityApprovalDecision, String>,
) {
    if !in_group() {
        return;
    }
    let status = match decision {
        Ok(CapabilityApprovalDecision::Deny) => "rejected",
        Ok(_) => "approved",
        Err(message) if message.contains("cancelled") => "cancelled",
        Err(_) => "failed",
    };
    let payload = json!({
        "kind": "provider-tool-approval", "approvalId": approval_id,
        "status": status, "error": decision.as_ref().err().map(|message| gyro_core::sanitize_capability_summary(message)),
    });
    if let Ok(event) = store.append_event_with_turn_id(
        session_id,
        SessionEventKind::SystemEvent,
        format!("Workflow approval {status}"),
        payload,
        turn_id,
    ) {
        let _ = app.emit(PROVIDER_APPROVAL_EVENT, event);
    }
}
pub(super) fn cancelled() -> bool {
    GROUP.with(|slot| {
        slot.borrow()
            .as_ref()
            .is_some_and(|group| group.stopped.load(Ordering::Acquire))
    })
}
pub(super) fn annotate(call_id: Uuid, payload: &mut Value) {
    GROUP.with(|slot| {
        if let Some(group) = slot.borrow().as_ref() {
            if call_id == group.id {
                payload["codeMode"] = json!({
                    "label": group.label, "source": group.source,
                    "outcome": group.outcome.lock().ok().and_then(|value| value.clone()),
                });
            } else {
                payload["groupId"] = json!(group.id);
            }
        }
    });
}

pub(super) fn allowed(id: CapabilityId) -> bool {
    matches!(
        id,
        CapabilityId::WorkspaceList
            | CapabilityId::WorkspaceSearch
            | CapabilityId::WorkspaceRead
            | CapabilityId::WorkspaceReadRange
    )
}
pub(super) fn enabled() -> bool {
    // An internal rollout switch, deliberately absent from product UI.
    std::env::var("GYRO_CODE_MODE").as_deref() == Ok("1") && worker_path().is_some()
}
fn worker_path() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let bundled = executable.parent()?.join("gyro-codemode");
    if bundled.is_file() {
        return Some(bundled);
    }
    #[cfg(debug_assertions)]
    {
        let suffix = if cfg!(target_arch = "aarch64") {
            "aarch64-apple-darwin"
        } else {
            "x86_64-apple-darwin"
        };
        let development = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("gyro-codemode-{suffix}"));
        if development.is_file() {
            return Some(development);
        }
    }
    None
}
pub(super) fn schema(id: CapabilityId) -> Option<(Value, Vec<&'static str>)> {
    match id {
        CapabilityId::CodeModeDiscover => Some((
            json!({
                "query": { "type": "string", "maxLength": 200 },
                "offset": { "type": "integer", "minimum": 0 },
                "limit": { "type": "integer", "minimum": 1, "maximum": 4 },
            }),
            vec![],
        )),
        CapabilityId::CodeModeExecute => Some((
            json!({
                "label": { "type": "string", "minLength": 1, "maxLength": 100 },
                "code": { "type": "string", "minLength": 1, "maxLength": MAX_SOURCE },
            }),
            vec!["label", "code"],
        )),
        _ => None,
    }
}
fn catalog(mode: CapabilityRunMode) -> Vec<Value> {
    advertised_capability_descriptors(mode)
        .filter(|item| allowed(item.id))
        .map(|item| {
            json!({
                "name": item.id.provider_tool_name(), "description": item.description,
                "schema": desktop_capability_tool_schema(item.id),
            })
        })
        .collect()
}

pub(super) fn execute(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    request: &CapabilityRequest,
) -> anyhow::Result<(String, Value, Option<CapabilityResourceRef>)> {
    anyhow::ensure!(
        enabled(),
        "Code Mode is unavailable; use ordinary workspace tools. No script was executed."
    );
    provider_reliability::validate_tool_call(
        request.capability_id.provider_tool_name(),
        &request.arguments,
    )
    .map_err(anyhow::Error::msg)?;
    if request.capability_id == CapabilityId::CodeModeDiscover {
        let query = request
            .arguments
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        let offset = request
            .arguments
            .get("offset")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        let limit = request
            .arguments
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(4) as usize;
        let tools = catalog(bound.policy.mode)
            .into_iter()
            .filter(|tool| {
                tool["name"].as_str().unwrap_or("").contains(&query)
                    || tool["description"]
                        .as_str()
                        .unwrap_or("")
                        .to_lowercase()
                        .contains(&query)
            })
            .collect::<Vec<_>>();
        let items = tools
            .iter()
            .skip(offset)
            .take(limit)
            .cloned()
            .collect::<Vec<_>>();
        let next = offset.saturating_add(items.len());
        return Ok((
            "Discovered workspace workflow tools".into(),
            json!({
                "schema": "gyro.codemode.catalog.v1", "tools": items, "total": tools.len(),
                "offset": offset, "hasMore": next < tools.len(), "nextOffset": (next < tools.len()).then_some(next),
                "resultShape": "{callId,status,summary,data,resource}", "maxCalls": MAX_CALLS, "maxConcurrentReads": 4,
            }),
            None,
        ));
    }
    let code = capability_argument_string(&request.arguments, "code")?;
    anyhow::ensure!(
        !code.trim().is_empty() && code.len() <= MAX_SOURCE,
        "Code Mode source must be 1–16384 bytes"
    );
    let group = GROUP
        .with(|slot| slot.borrow().clone())
        .ok_or_else(|| anyhow::anyhow!("Missing workflow context"))?;
    let parent_context = request.context.clone();
    let receipts = Arc::new(Mutex::new(Vec::<Value>::new()));
    let control = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .and_then(|flags| flags.get(&bound.session_id).cloned())
        .ok_or_else(|| anyhow::anyhow!("The provider run is no longer active"))?;
    let result = run_worker(
        &worker_path().ok_or_else(|| anyhow::anyhow!("Missing Code Mode helper"))?,
        &catalog(bound.policy.mode),
        code,
        group.stopped.clone(),
        LIMIT,
        || control.cancellation.is_cancelled(),
        |name, mut input| {
            let _scope = enter(group.clone());
            let call_id = Uuid::new_v4();
            let call_started = Instant::now();
            let validated = provider_reliability::validate_tool_call(name, &input)
                .map_err(anyhow::Error::msg)
                .and_then(|id| {
                    anyhow::ensure!(
                        allowed(id),
                        "Tool is outside the Code Mode inspection allowlist"
                    );
                    Ok(id)
                });
            let response = match validated {
                Ok(id) => {
                    // Keep each observation bounded even when a script requests the hard ceiling.
                    let budget = input
                        .get("maxBytes")
                        .and_then(Value::as_u64)
                        .unwrap_or(16384)
                        .min(16384);
                    input["maxBytes"] = json!(budget);
                    let mut context = parent_context.clone();
                    context.call_id = call_id;
                    app.state::<ProviderCapabilityBroker>().invoke(
                        app,
                        CapabilityRequest {
                            schema: PROVIDER_CAPABILITY_IPC_SCHEMA_V1.into(),
                            sender_version: env!("CARGO_PKG_VERSION").into(),
                            context,
                            capability_id: id,
                            arguments: input,
                        },
                    )
                }
                Err(error) => CapabilityResponse::failed(
                    env!("CARGO_PKG_VERSION"),
                    call_id,
                    "invalid-tool",
                    error.to_string(),
                ),
            };
            let status =
                if response.error.as_ref().is_some_and(|error| {
                    matches!(error.code.as_str(), "policy-denied" | "user-denied")
                }) {
                    "denied"
                } else if response
                    .error
                    .as_ref()
                    .is_some_and(|error| error.code == "cancelled")
                {
                    "cancelled"
                } else if response.status == CapabilityStatus::Completed {
                    "completed"
                } else {
                    "failed"
                };
            if let Ok(mut receipts) = receipts.lock() {
                receipts.push(json!({
                "callId": call_id, "name": name, "status": status, "durationMs": call_started.elapsed().as_millis(),
                "summary": response.result.as_ref().map(|result| result.summary.clone()).or_else(|| response.error.as_ref().map(|error| error.message.clone())),
                "resource": response.result.as_ref().and_then(|result| result.resource.clone()),
            }));
            }
            if let Some(error) = response.error {
                if let Some(id) =
                    CapabilityId::from_provider_tool_name(name).filter(|id| allowed(*id))
                {
                    let terminal = match status {
                        "denied" => CapabilityStatus::Denied,
                        "cancelled" => CapabilityStatus::Cancelled,
                        _ => CapabilityStatus::Failed,
                    };
                    let _ =
                        capability_event(app, bound, call_id, id, terminal, &error.message, None);
                }
                return Err(error.message);
            }
            let result = response
                .result
                .ok_or_else(|| "Missing tool result".to_string())?;
            Ok(
                json!({ "callId": result.call_id, "status": status, "summary": result.summary, "data": result.data, "resource": result.resource }),
            )
        },
    );
    let outcome = redact_json_strings(result);
    let receipts = receipts
        .lock()
        .map_err(|_| anyhow::anyhow!("Workflow receipts unavailable"))?
        .clone();
    let completed = receipts
        .iter()
        .filter(|item| item["status"] == "completed")
        .count();
    let partial = receipts.iter().any(|item| item["status"] != "completed")
        || outcome["ok"] != true
        || outcome["incomplete"] == true
        || outcome.get("warnings").is_some();
    let data = json!({
        "schema": "gyro.codemode.result.v1", "groupId": group.id, "outcome": outcome,
        "calls": receipts, "completed": completed, "partial": partial,
        "observationsUntrusted": true,
    });
    if let Ok(mut stored) = group.outcome.lock() {
        *stored = Some(data.clone());
    }
    Ok((
        format!(
            "{}: {} actions completed{}",
            group.label,
            completed,
            if partial { " · partial results" } else { "" }
        ),
        data,
        None,
    ))
}

fn failure(kind: &str, message: &str) -> Value {
    json!({ "ok": false, "error": { "kind": kind, "message": message } })
}
enum WorkerEvent {
    Frame(Value),
    Response(u64, Result<Value, String>),
    Error(String),
}

/// No replay. A disposable worker and a bounded queue live for exactly one workflow.
fn run_worker(
    binary: &Path,
    tools: &[Value],
    code: &str,
    stopped: Arc<AtomicBool>,
    timeout: Duration,
    cancelled: impl Fn() -> bool + Sync,
    invoke: impl Fn(&str, Value) -> Result<Value, String> + Sync,
) -> Value {
    let scratch = match tempfile::tempdir() {
        Ok(value) => value,
        Err(error) => return failure("WorkerFailure", &error.to_string()),
    };
    let mut command = Command::new(binary);
    command
        .env_clear()
        .env("BUN_JSC_useJIT", "0")
        .current_dir(scratch.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = match gyro_core::process_guard::spawn_guarded(&mut command) {
        Ok(child) => child,
        Err(error) => return failure("WorkerUnavailable", &error.to_string()),
    };
    let mut input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let start = json!({ "type": "start", "code": code, "tools": tools });
    if writeln!(input, "{start}").is_err() {
        let _ = child.kill();
        let _ = child.wait();
        return failure("WorkerFailure", "Unable to start workflow");
    }
    let started = Instant::now();
    let outcome = std::thread::scope(|scope| {
        let (sender, receiver) = mpsc::channel::<WorkerEvent>();
        let reader_sender = sender.clone();
        scope.spawn(move || {
            let mut reader = BufReader::new(output);
            for _ in 0..MAX_CALLS + 2 {
                let mut line = String::new();
                match (&mut reader)
                    .take((MAX_FRAME + 1) as u64)
                    .read_line(&mut line)
                {
                    Ok(0) => {
                        let _ =
                            reader_sender.send(WorkerEvent::Error("Worker disconnected".into()));
                        return;
                    }
                    Ok(_) if line.len() > MAX_FRAME || !line.ends_with('\n') => {
                        let _ = reader_sender
                            .send(WorkerEvent::Error("Worker frame exceeded limit".into()));
                        return;
                    }
                    Ok(_) => match serde_json::from_str(&line) {
                        Ok(frame) => {
                            if reader_sender.send(WorkerEvent::Frame(frame)).is_err() {
                                return;
                            }
                        }
                        Err(_) => {
                            let _ = reader_sender
                                .send(WorkerEvent::Error("Invalid worker frame".into()));
                            return;
                        }
                    },
                    Err(error) => {
                        let _ = reader_sender.send(WorkerEvent::Error(error.to_string()));
                        return;
                    }
                }
            }
            let _ = reader_sender.send(WorkerEvent::Error(
                "Worker frame count exceeded limit".into(),
            ));
        });
        let mut queue: VecDeque<(u64, String, Value)> = VecDeque::new();
        let mut active = 0;
        let mut admitted = 0;
        let mut bytes = 0;
        let mut ids = std::collections::HashSet::new();
        let mut memory_check = Instant::now();
        let outcome = loop {
            if memory_check.elapsed() >= Duration::from_millis(100) {
                memory_check = Instant::now();
                if worker_resident_bytes(child.id()).is_some_and(|bytes| bytes > 256 * 1024 * 1024)
                {
                    break failure(
                        "MemoryLimitExceeded",
                        "Workflow exceeded its 256 MiB memory limit",
                    );
                }
            }
            if cancelled() || stopped.load(Ordering::Acquire) {
                break failure(
                    "Cancelled",
                    "Workflow cancelled; completed actions are retained",
                );
            }
            if started.elapsed() >= timeout {
                break failure(
                    "TimeoutExceeded",
                    "Workflow exceeded its time limit; completed actions are retained",
                );
            }
            while active < 4 && !queue.is_empty() {
                let (id, name, arguments) = queue.pop_front().unwrap();
                let sender = sender.clone();
                let invoke = &invoke;
                let stopped = stopped.clone();
                scope.spawn(move || {
                    let result = if stopped.load(Ordering::Acquire) {
                        Err("Workflow cancelled".into())
                    } else {
                        invoke(&name, arguments)
                    };
                    let _ = sender.send(WorkerEvent::Response(id, result));
                });
                active += 1;
            }
            match receiver.recv_timeout(Duration::from_millis(25)) {
                Ok(WorkerEvent::Frame(frame)) if frame["type"] == "call" => {
                    let Some(id) = frame["id"].as_u64() else {
                        break failure("ProtocolError", "Invalid call id");
                    };
                    let Some(name) = frame["name"].as_str() else {
                        break failure("ProtocolError", "Missing tool name");
                    };
                    admitted += 1;
                    if admitted > MAX_CALLS || !ids.insert(id) {
                        break failure("ToolCallLimitExceeded", "Invalid or excessive tool calls");
                    }
                    if !CapabilityId::from_provider_tool_name(name).is_some_and(allowed) {
                        break failure("UnknownTool", "Unavailable workflow tool");
                    }
                    queue.push_back((id, name.to_owned(), frame["input"].clone()));
                }
                Ok(WorkerEvent::Frame(frame)) if frame["type"] == "result" => {
                    let mut result = frame["outcome"].clone();
                    if !result.is_object() || !result["ok"].is_boolean() {
                        break failure("ProtocolError", "Invalid workflow result");
                    }
                    if active > 0 || !queue.is_empty() {
                        result["incomplete"] = json!(true);
                    }
                    break result;
                }
                Ok(WorkerEvent::Frame(_)) => {
                    break failure("ProtocolError", "Unknown worker message")
                }
                Ok(WorkerEvent::Response(id, result)) => {
                    active -= 1;
                    let frame = match result {
                        Ok(value) => json!({ "type": "response", "id": id, "value": value }),
                        Err(error) => json!({ "type": "response", "id": id, "error": error }),
                    };
                    let encoded = frame.to_string();
                    bytes += encoded.len();
                    if bytes > MAX_DATA || encoded.len() > MAX_FRAME {
                        break failure(
                            "DataLimitExceeded",
                            "Workflow intermediate data exceeded limit",
                        );
                    }
                    if writeln!(input, "{encoded}").is_err() {
                        break failure("WorkerFailure", "Worker disconnected during a tool call");
                    }
                }
                Ok(WorkerEvent::Error(error)) => break failure("WorkerFailure", &error),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => break failure("WorkerFailure", "Worker disconnected"),
            }
        };
        stopped.store(true, Ordering::Release);
        let _ = child.kill();
        let _ = child.wait();
        drop(input);
        outcome
    });
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    fn binary() -> PathBuf {
        worker_path().expect("Build the Code Mode helper before running its tests")
    }
    fn fixture_tools() -> Vec<Value> {
        catalog(CapabilityRunMode::Normal)
    }
    #[test]
    fn inspection_allowlist_and_mode_catalog() {
        assert_eq!(fixture_tools().len(), 4);
        assert!(catalog(CapabilityRunMode::Council).is_empty());
        assert_eq!(catalog(CapabilityRunMode::Plan).len(), 4);
        assert!(!allowed(CapabilityId::WorkspaceReadEditor));
        assert!(!allowed(CapabilityId::CodeModeExecute));
        assert!(!allowed(CapabilityId::WorkspaceEdit));
        assert!(!allowed(CapabilityId::TerminalOpen));
        assert!(provider_reliability::validate_tool_call(
            "gyro_workspace_read",
            &json!({"path": 42})
        )
        .is_err());
    }
    #[test]
    fn real_worker_composes_bounded_parallel_reads_and_preserves_partial_failure() {
        let active = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let count = AtomicUsize::new(0);
        let outcome = run_worker(&binary(), &fixture_tools(),
            "const values = await Promise.all([1,2,3,4,5,6].map(i => tools.gyro_workspace_read({path: 'file'+i}))); return values.map(x => x.data);",
            Arc::new(AtomicBool::new(false)), LIMIT, || false, |_, input| {
                let n = active.fetch_add(1, Ordering::SeqCst) + 1; peak.fetch_max(n, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(20)); active.fetch_sub(1, Ordering::SeqCst); count.fetch_add(1, Ordering::SeqCst);
                Ok(json!({"data": input["path"]}))
            });
        assert_eq!(outcome["ok"], true, "{outcome}");
        assert_eq!(count.load(Ordering::SeqCst), 6);
        assert!(peak.load(Ordering::SeqCst) <= 4);
        let calls = AtomicUsize::new(0);
        let failed = run_worker(&binary(), &fixture_tools(),
            "await tools.gyro_workspace_read({path:'ok'}); await tools.gyro_workspace_read({path:'denied'});",
            Arc::new(AtomicBool::new(false)), LIMIT, || false, |_, input| {
                calls.fetch_add(1, Ordering::SeqCst);
                if input["path"] == "denied" { Err("Denied by policy".into()) } else { Ok(json!({"data":"retained"})) }
            });
        assert_eq!(failed["ok"], false);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
    #[test]
    fn real_worker_has_no_host_access_and_busy_work_can_be_stopped() {
        for code in [
            "return process.env",
            "return fetch('https://example.com')",
            "import fs from 'node:fs';",
            "return tools.gyro_workspace_edit({})",
        ] {
            let result = run_worker(
                &binary(),
                &fixture_tools(),
                code,
                Arc::new(AtomicBool::new(false)),
                LIMIT,
                || false,
                |_, _| panic!("Host called"),
            );
            assert_eq!(result["ok"], false, "{code}: {result}");
        }
        let started = Instant::now();
        let result = run_worker(
            &binary(),
            &fixture_tools(),
            "while(true) {}",
            Arc::new(AtomicBool::new(false)),
            Duration::from_millis(200),
            || false,
            |_, _| panic!("Host called"),
        );
        assert_eq!(result["error"]["kind"], "TimeoutExceeded");
        assert!(started.elapsed() < Duration::from_secs(3));
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn real_worker_memory_is_bounded() {
        let result = run_worker(
            &binary(),
            &fixture_tools(),
            "let values=[]; while(true) values.push('a'.repeat(1048576));",
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
            || false,
            |_, _| panic!("Host called"),
        );
        assert_eq!(result["error"]["kind"], "MemoryLimitExceeded", "{result}");
    }
    #[test]
    fn real_worker_unawaited_calls_are_interrupted_without_replay() {
        let calls = AtomicUsize::new(0);
        let result = run_worker(
            &binary(),
            &fixture_tools(),
            "tools.gyro_workspace_read({path:'slow'}); return 'early';",
            Arc::new(AtomicBool::new(false)),
            LIMIT,
            || false,
            |_, _| {
                calls.fetch_add(1, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(50));
                Ok(json!({"data":"late"}))
            },
        );
        assert!(
            result["incomplete"] == true || result.get("warnings").is_some(),
            "{result}"
        );
        assert!(calls.load(Ordering::SeqCst) <= 1);
    }
    #[test]
    fn group_annotations_restore_and_never_cross_threads_by_accident() {
        let group = Group {
            id: Uuid::new_v4(),
            label: "Inspect".into(),
            source: "return 1".into(),
            outcome: Arc::new(Mutex::new(None)),
            stopped: Arc::new(AtomicBool::new(false)),
        };
        let mut parent = json!({});
        let mut child = json!({});
        {
            let _scope = enter(group.clone());
            annotate(group.id, &mut parent);
            annotate(Uuid::new_v4(), &mut child);
        }
        assert_eq!(parent["codeMode"]["label"], "Inspect");
        assert_eq!(child["groupId"], group.id.to_string());
        let mut outside = json!({});
        annotate(Uuid::new_v4(), &mut outside);
        assert!(outside.get("groupId").is_none());
    }
}
