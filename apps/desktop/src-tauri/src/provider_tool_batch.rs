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
            let workers = calls[offset..offset + count]
                .iter()
                .map(|(id, arguments)| {
                    let invoke = &invoke;
                    let trace = trace.clone();
                    scope.spawn(move || {
                        let _trace = timing::attach(trace);
                        invoke(*id, arguments)
                    })
                })
                .collect::<Vec<_>>();
            // Join all readers before crossing a write barrier, even on error.
            workers
                .into_iter()
                .map(|worker| {
                    worker
                        .join()
                        .unwrap_or_else(|_| Err(anyhow::anyhow!("Gyro tool worker failed")))
                })
                .collect::<Vec<_>>()
        });
        for result in batch {
            results.push(result?);
        }
        offset += count;
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
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
}
