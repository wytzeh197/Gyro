use super::Runtime;
use crate::terminal::types::{TerminalOutputCursor, TerminalProcessManager};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
use tauri::Manager;

pub(super) fn start(runtime: &Arc<Runtime>) -> tokio::task::JoinHandle<()> {
    let weak = Arc::downgrade(runtime);
    let mut changed = crate::terminal_process::output_changes().subscribe();
    tokio::spawn(async move {
        let mut cursors: HashMap<String, (u64, TerminalOutputCursor)> = HashMap::new();
        loop {
            let first = changed.recv().await;
            if matches!(first, Err(tokio::sync::broadcast::error::RecvError::Closed)) {
                break;
            }
            // Coalesce busy PTYs; empty terminals do no work and send no traffic.
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let mut dirty = HashSet::new();
            let mut all = first.is_err();
            if let Ok(pane) = first {
                dirty.insert(pane);
            }
            loop {
                match changed.try_recv() {
                    Ok(pane) => {
                        dirty.insert(pane);
                    }
                    Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => all = true,
                    Err(_) => break,
                }
            }
            let Some(runtime) = weak.upgrade() else {
                break;
            };
            if runtime.stopped.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }
            let result = tauri::async_runtime::spawn_blocking(move || {
                let panes = runtime
                    .terminals
                    .lock()
                    .map(|panes| {
                        panes
                            .iter()
                            .map(|(id, t)| (id.clone(), t.session.clone(), t.peer.clone()))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                cursors.retain(|id, _| panes.iter().any(|(pane, _, _)| pane == id));
                let manager = runtime.app.state::<TerminalProcessManager>();
                for (pane, session, peer) in panes {
                    if !all && !dirty.contains(&pane) {
                        continue;
                    }
                    let previous = cursors.get(&pane);
                    if let Ok(snapshot) =
                        manager.read_since(&pane, previous.map(|p| p.0), previous.map(|p| &p.1))
                    {
                        cursors.insert(
                            pane,
                            (snapshot.output_revision, snapshot.output_cursor.clone()),
                        );
                        runtime.publish(
                            &session,
                            "terminal",
                            serde_json::json!({"recipient":peer,"snapshot":snapshot}),
                        );
                    }
                }
                cursors
            })
            .await;
            match result {
                Ok(value) => cursors = value,
                Err(_) => break,
            }
        }
    })
}
