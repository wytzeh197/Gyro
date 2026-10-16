use super::*;

// Explicit allowlist: these observe disk state without changing the workspace,
// opening an editor, running a command, or driving a shared browser session.
fn independent_read(id: CapabilityId) -> bool {
    matches!(
        id,
        CapabilityId::WorkspaceList
            | CapabilityId::WorkspaceSearch
            | CapabilityId::WorkspaceRead
            | CapabilityId::WorkspaceReadRange
    )
}

pub(super) fn model_tools(
    mode: CapabilityRunMode,
    allow_delegation: bool,
) -> Vec<serde_json::Value> {
    let mut tools: Vec<serde_json::Value> = advertised_capability_descriptors(mode)
        .filter(|descriptor| allow_delegation || !delegated_agents::delegation_tool(descriptor.id))
        .map(|descriptor| {
            serde_json::json!({
                "type": "function",
                "function": {
                    "name": descriptor.id.provider_tool_name(),
                    "description": descriptor.description,
                    "parameters": desktop_capability_tool_schema(descriptor.id),
                }
            })
        })
        .collect();
    if efficiency::config().policies() && efficiency::config().cache_assembly {
        gyro_core::efficiency::context::stable_tools(&mut tools);
    }
    tools
}

/// Native tools get the same single corrective retry as the JSON bridge.
/// Execution failures are observed results; only an all-invalid name/schema
/// batch spends this recovery budget.
pub(super) fn check_native_tool_recovery(
    valid_calls: usize,
    malformed_responses: &mut usize,
) -> anyhow::Result<()> {
    if valid_calls > 0 {
        *malformed_responses = 0;
        return Ok(());
    }
    *malformed_responses += 1;
    anyhow::ensure!(
        *malformed_responses <= 1,
        "The model returned only invalid Gyro tool calls after one corrective retry; no invalid actions were executed. Check the tool names and arguments before continuing."
    );
    Ok(())
}

/// Keep actionable capability evidence in provider context without repeatedly
/// sending the desktop IPC envelope, duplicate call ids, or absent fields.
pub(super) fn model_response_text(response: &CapabilityResponse) -> anyhow::Result<String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Evidence<'a> {
        capability_id: CapabilityId,
        summary: &'a str,
        data: &'a serde_json::Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        resource: Option<&'a CapabilityResourceRef>,
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Payload<'a> {
        status: CapabilityStatus,
        call_id: Uuid,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<Evidence<'a>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<&'a gyro_core::capabilities::CapabilityError>,
        #[serde(skip_serializing_if = "Option::is_none")]
        compatible: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        schema: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        app_version: Option<&'a str>,
    }
    // Borrow potentially large evidence instead of cloning its JSON tree.
    let payload = Payload {
        status: response.status,
        call_id: response.call_id,
        result: response.result.as_ref().map(|result| Evidence {
            capability_id: result.capability_id,
            summary: &result.summary,
            data: &result.data,
            resource: result.resource.as_ref(),
        }),
        error: response.error.as_ref(),
        compatible: (!response.compatible).then_some(false),
        schema: (!response.compatible).then_some(response.schema.as_str()),
        app_version: (!response.compatible).then_some(response.app_version.as_str()),
    };
    Ok(serde_json::to_string(&payload)?)
}

pub(super) fn execute(
    app: &tauri::AppHandle,
    session_id: &str,
    calls: &[(CapabilityId, serde_json::Value)],
) -> anyhow::Result<Vec<CapabilityResponse>> {
    ordered(calls, |id, arguments| {
        invoke_run_capability(app, session_id, id, arguments.clone())
    })
}

fn ordered<T: Send>(
    calls: &[(CapabilityId, serde_json::Value)],
    invoke: impl Fn(CapabilityId, &serde_json::Value) -> anyhow::Result<T> + Sync,
) -> anyhow::Result<Vec<T>> {
    let mut results = Vec::with_capacity(calls.len());
    let mut offset = 0;
    while offset < calls.len() {
        if !independent_read(calls[offset].0) {
            results.push(invoke(calls[offset].0, &calls[offset].1)?);
            offset += 1;
            continue;
        }
        let count = calls[offset..]
            .iter()
            .take(4)
            .take_while(|(id, _)| independent_read(*id))
            .count();
        if count == 1 {
            results.push(invoke(calls[offset].0, &calls[offset].1)?);
            offset += 1;
            continue;
        }
        let trace = timing::capture();
        let batch = std::thread::scope(|scope| {
            // The existing runner worker handles one read while up to three
            // peers run beside it. This keeps the four-read limit without
            // paying for a thread that merely waits on the other readers.
            let workers = calls[offset..offset + count - 1]
                .iter()
                .map(|(id, arguments)| {
                    let invoke = &invoke;
                    let trace = trace.clone();
                    std::thread::Builder::new().spawn_scoped(scope, move || {
                        let _trace = timing::attach(trace);
                        invoke(*id, arguments)
                    })
                })
                .collect::<Vec<_>>();
            let last = &calls[offset + count - 1];
            let last_result = read_on_worker(|| invoke(last.0, &last.1));
            // Join all readers before crossing a write barrier, even on error.
            let mut batch = workers
                .into_iter()
                .enumerate()
                .map(|(index, worker)| match worker {
                    Ok(worker) => worker
                        .join()
                        .unwrap_or_else(|_| Err(anyhow::anyhow!("Gyro tool worker failed"))),
                    // A resource-limited host can still read on the existing
                    // worker, without failing the turn and replaying tools.
                    Err(_) => {
                        let (id, arguments) = &calls[offset + index];
                        read_on_worker(|| invoke(*id, arguments))
                    }
                })
                .collect::<Vec<_>>();
            batch.push(last_result);
            batch
        });
        for result in batch {
            results.push(result?);
        }
        offset += count;
    }
    Ok(results)
}

fn read_on_worker<T>(invoke: impl FnOnce() -> anyhow::Result<T>) -> anyhow::Result<T> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(invoke))
        .unwrap_or_else(|_| Err(anyhow::anyhow!("Gyro tool worker failed")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consecutive_invalid_batches_get_one_correction_and_are_never_replayed() {
        let mut messages = Vec::new();
        let mut malformed = 0;
        for (index, (name, arguments)) in [
            ("unknown_tool", serde_json::json!({})),
            (
                CapabilityId::WorkspaceRead.provider_tool_name(),
                serde_json::json!({}),
            ),
        ]
        .into_iter()
        .enumerate()
        {
            let valid = provider_reliability::prepare_tool_call(
                &mut messages,
                name,
                &arguments,
                Some("invalid-call"),
            );
            assert!(valid.is_none());
            let outcome = check_native_tool_recovery(usize::from(valid.is_some()), &mut malformed);
            if index == 0 {
                assert!(outcome.is_ok());
            } else {
                let error = outcome.unwrap_err().to_string();
                assert!(error.contains("one corrective retry"));
                assert!(!provider_reliability::is_transient_provider_error(&error));
            }
        }
        assert_eq!(messages.len(), 2);
    }

    #[test]
    fn valid_requests_reset_recovery_even_when_their_execution_can_fail() {
        let mut malformed = 0;
        check_native_tool_recovery(0, &mut malformed).unwrap();
        let mut messages = Vec::new();
        let valid = provider_reliability::prepare_tool_call(
            &mut messages,
            CapabilityId::WorkspaceRead.provider_tool_name(),
            &serde_json::json!({"path":"missing-file.rs"}),
            Some("valid-request"),
        );
        assert!(valid.is_some());
        check_native_tool_recovery(usize::from(valid.is_some()), &mut malformed).unwrap();
        assert_eq!(malformed, 0);
        // A missing file is still a valid request, not a malformed model reply.
        let failed =
            CapabilityResponse::failed("test", Uuid::new_v4(), "missing-file", "File missing");
        assert_eq!(failed.status, CapabilityStatus::Failed);
        check_native_tool_recovery(0, &mut malformed).unwrap();
        assert_eq!(malformed, 1);
    }

    #[test]
    fn compact_native_catalogs_keep_all_mode_capabilities_and_constraints() {
        for mode in [
            CapabilityRunMode::Normal,
            CapabilityRunMode::Plan,
            CapabilityRunMode::Council,
        ] {
            let current_tools = model_tools(mode, true);
            let descriptors = advertised_capability_descriptors(mode).collect::<Vec<_>>();
            assert_eq!(current_tools.len(), descriptors.len());
            for (tool, descriptor) in current_tools.iter().zip(descriptors) {
                assert_eq!(tool["function"]["name"], descriptor.id.provider_tool_name());
                assert_eq!(
                    tool["function"]["parameters"],
                    desktop_capability_tool_schema(descriptor.id)
                );
            }
            let current = serde_json::Value::Array(current_tools);
            let mut legacy = current.clone();
            let mut rooted = 0;
            for tool in legacy.as_array_mut().unwrap() {
                if let Some(root) = tool.pointer_mut("/function/parameters/properties/rootId") {
                    rooted += 1;
                    root["description"] = "Workspace root ID from gyro_workspace_get_context. Required when this session has multiple roots.".into();
                }
            }
            let before_bytes = serde_json::to_vec(&legacy).unwrap().len();
            let after_bytes = serde_json::to_vec(&current).unwrap().len();
            let before_chars = gyro_core::provider_observation::text_size(&legacy).0;
            let after_chars = gyro_core::provider_observation::text_size(&current).0;
            if rooted > 0 {
                assert!(
                    after_chars < before_chars,
                    "root guidance must be shared instead of repeated"
                );
                assert!(after_bytes < before_bytes);
            }
            eprintln!("native catalog {mode:?}: {} tools, {rooted} root fields, {before_bytes} -> {after_bytes} bytes, {before_chars} -> {after_chars} text/schema characters", current.as_array().unwrap().len());
        }
        let without_delegation = model_tools(CapabilityRunMode::Normal, false);
        assert!(without_delegation.iter().all(|tool| {
            let name = tool["function"]["name"].as_str().unwrap();
            !delegated_agents::delegation_tool(CapabilityId::from_provider_tool_name(name).unwrap())
        }));
    }

    #[test]
    fn model_results_keep_evidence_and_resources_without_the_ipc_envelope() {
        let call_id = Uuid::new_v4();
        let response = CapabilityResponse::completed(
            "test-version",
            CapabilityResult {
                call_id,
                capability_id: CapabilityId::WorkspaceRead,
                summary: "Read file".into(),
                data: serde_json::json!({"text": "file contents", "truncated": false}),
                resource: Some(CapabilityResourceRef {
                    id: "file-resource".into(),
                    kind: "file".into(),
                    label: "example.rs".into(),
                }),
            },
        );
        let compact = model_response_text(&response).unwrap();
        let payload: serde_json::Value = serde_json::from_str(&compact).unwrap();
        assert_eq!(payload["callId"], call_id.to_string());
        assert_eq!(payload["status"], "completed");
        assert_eq!(payload["result"]["summary"], "Read file");
        assert_eq!(
            payload["result"]["data"],
            response.result.as_ref().unwrap().data
        );
        assert_eq!(payload["result"]["resource"]["id"], "file-resource");
        for field in ["schema", "appVersion", "compatible", "error"] {
            assert!(payload.get(field).is_none());
        }
        assert!(payload["result"].get("callId").is_none());
        assert!(compact.len() + 100 < serde_json::to_string(&response).unwrap().len());
    }

    #[test]
    fn model_results_keep_failures_and_incompatibility_actionable() {
        let mut response = CapabilityResponse::failed(
            "test-version",
            Uuid::new_v4(),
            "incompatible-schema",
            "Update the provider adapter",
        );
        response.compatible = false;
        let payload: serde_json::Value =
            serde_json::from_str(&model_response_text(&response).unwrap()).unwrap();
        assert_eq!(payload["status"], "failed");
        assert_eq!(payload["error"]["code"], "incompatible-schema");
        assert_eq!(payload["error"]["message"], "Update the provider adapter");
        assert_eq!(payload["compatible"], false);
        assert_eq!(payload["schema"], response.schema);
        assert_eq!(payload["appVersion"], response.app_version);
        assert!(payload.get("result").is_none());
    }

    #[test]
    fn an_isolated_read_runs_on_the_existing_worker() {
        let caller = std::thread::current().id();
        ordered(
            &[(CapabilityId::WorkspaceRead, serde_json::json!({}))],
            |_, _| {
                assert_eq!(std::thread::current().id(), caller);
                Ok(())
            },
        )
        .unwrap();
    }
    #[test]
    fn concurrent_reads_preserve_result_order_and_finish_before_writes() {
        let barrier = std::sync::Barrier::new(2);
        let finished = AtomicUsize::new(0);
        let calls = vec![
            (CapabilityId::WorkspaceRead, serde_json::json!(0)),
            (CapabilityId::WorkspaceReadRange, serde_json::json!(1)),
            (CapabilityId::WorkspaceEdit, serde_json::json!(2)),
        ];
        let results = ordered(&calls, |id, argument| {
            if independent_read(id) {
                barrier.wait();
                finished.fetch_add(1, Ordering::SeqCst);
            } else {
                assert_eq!(finished.load(Ordering::SeqCst), 2);
            }
            Ok(argument.as_u64().unwrap())
        })
        .unwrap();
        assert_eq!(results, [0, 1, 2]);
        for id in [
            CapabilityId::WorkspaceReadEditor,
            CapabilityId::TerminalOpen,
            CapabilityId::BrowserInspect,
            CapabilityId::WorkspaceEdit,
            CapabilityId::WebFetch,
        ] {
            assert!(!independent_read(id));
        }
    }
    #[test]
    fn failed_read_never_starts_a_later_write() {
        let calls = [
            (CapabilityId::WorkspaceRead, serde_json::json!({})),
            (CapabilityId::WorkspaceEdit, serde_json::json!({})),
        ];
        assert!(ordered::<()>(&calls, |id, _| {
            assert_eq!(id, CapabilityId::WorkspaceRead);
            anyhow::bail!("cancelled")
        })
        .is_err());
    }

    #[test]
    fn read_batches_use_the_runner_and_cap_parallelism_at_four() {
        let caller = std::thread::current().id();
        let barrier = std::sync::Barrier::new(4);
        let caller_reads = AtomicUsize::new(0);
        let active = AtomicUsize::new(0);
        let maximum = AtomicUsize::new(0);
        let calls = (0..8)
            .map(|index| (CapabilityId::WorkspaceRead, serde_json::json!(index)))
            .collect::<Vec<_>>();
        let results = ordered(&calls, |_, argument| {
            if std::thread::current().id() == caller {
                caller_reads.fetch_add(1, Ordering::SeqCst);
            }
            let readers = active.fetch_add(1, Ordering::SeqCst) + 1;
            maximum.fetch_max(readers, Ordering::SeqCst);
            barrier.wait();
            active.fetch_sub(1, Ordering::SeqCst);
            Ok(argument.as_u64().unwrap())
        })
        .unwrap();
        assert_eq!(results, (0..8).collect::<Vec<_>>());
        assert_eq!(maximum.load(Ordering::SeqCst), 4);
        assert_eq!(caller_reads.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_failed_concurrent_reader_finishes_its_peers_before_returning() {
        let barrier = std::sync::Barrier::new(2);
        let finished = AtomicUsize::new(0);
        let calls = [
            (CapabilityId::WorkspaceRead, serde_json::json!(0)),
            (CapabilityId::WorkspaceRead, serde_json::json!(1)),
            (CapabilityId::WorkspaceEdit, serde_json::json!(2)),
        ];
        assert!(ordered(&calls, |id, argument| {
            assert!(independent_read(id), "a failed read must stop later writes");
            barrier.wait();
            finished.fetch_add(1, Ordering::SeqCst);
            if argument == &serde_json::json!(0) {
                anyhow::bail!("read failed");
            }
            Ok(())
        })
        .is_err());
        assert_eq!(finished.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_panic_in_a_reader_never_starts_a_later_write() {
        for failed_index in [0, 1] {
            let calls = [
                (CapabilityId::WorkspaceRead, serde_json::json!(0)),
                (CapabilityId::WorkspaceRead, serde_json::json!(1)),
                (CapabilityId::WorkspaceEdit, serde_json::json!(2)),
            ];
            let error = ordered(&calls, |id, argument| {
                assert!(independent_read(id));
                assert_ne!(argument, &serde_json::json!(failed_index), "read panic");
                Ok(())
            })
            .unwrap_err();
            assert_eq!(error.to_string(), "Gyro tool worker failed");
        }
    }
}
