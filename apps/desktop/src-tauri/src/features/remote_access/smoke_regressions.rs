//! Regressions through the real host dispatcher, isolated stores, and live QUIC/PTYs.
use super::{
    commands::{local_action, LocalAction},
    smoke::call,
    Runtime,
};
use gyro_remote::{
    protocol::{ApprovalKind, GitAction, ModelChoice, TerminalAction},
    transport::Node,
    Operation, RemoteEvent, Request,
};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc, time::Duration};
use tauri::Manager;
use uuid::Uuid;

fn write(session: &str, content: &str, hash: &str) -> Operation {
    Operation::WriteFile {
        session_id: session.into(),
        path: "main.txt".into(),
        content: content.into(),
        expected_hash: Some(hash.into()),
    }
}

async fn file(client: &Node, host: &str, session: &str) -> anyhow::Result<Value> {
    call(
        client,
        host,
        Operation::ReadFile {
            session_id: session.into(),
            path: "main.txt".into(),
        },
        None,
    )
    .await
}

async fn terminal(client: &Node, host: &str, session: &str, lease: u64) -> anyhow::Result<String> {
    Ok(call(
        client,
        host,
        Operation::Terminal {
            session_id: session.into(),
            action: TerminalAction::Create,
            pane_id: None,
            input: None,
            cols: None,
            rows: None,
            revision: None,
        },
        Some(lease),
    )
    .await?["paneId"]
        .as_str()
        .unwrap()
        .into())
}

async fn watch(
    client: &Node,
    host: &str,
    session: &str,
) -> anyhow::Result<(
    tokio::task::JoinHandle<()>,
    tokio::sync::mpsc::UnboundedReceiver<RemoteEvent>,
)> {
    let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
    let task = client
        .watch(
            host,
            Request {
                id: Uuid::new_v4(),
                lease: None,
                operation: Operation::Watch {
                    session_id: session.into(),
                },
            },
            Arc::new(move |event| {
                let _ = sender.send(event);
            }),
        )
        .await?;
    Ok((task, receiver))
}

async fn event(
    receiver: &mut tokio::sync::mpsc::UnboundedReceiver<RemoteEvent>,
) -> anyhow::Result<RemoteEvent> {
    tokio::time::timeout(Duration::from_secs(2), receiver.recv())
        .await?
        .ok_or_else(|| anyhow::anyhow!("Watch ended without expected event"))
}

/// Occupy exactly the resource a slow Git fetch would hold, without public network
/// dependencies. The release sender also unblocks the worker on early test failure.
async fn hold_git(
    host: &Runtime,
    session: &str,
) -> anyhow::Result<(
    tokio::sync::oneshot::Sender<()>,
    tokio::task::JoinHandle<()>,
)> {
    let operation = Operation::Git {
        session_id: session.into(),
        action: GitAction::Fetch,
        path: None,
        message: None,
        expected_revision: None,
    };
    let paths = host
        .mutation_paths(&operation)
        .map_err(anyhow::Error::msg)?;
    let locks = host
        .mutation_locks
        .for_paths(&paths)
        .map_err(anyhow::Error::msg)?;
    let (ready, admitted) = tokio::sync::oneshot::channel();
    let (release, done) = tokio::sync::oneshot::channel();
    let worker = tokio::task::spawn_blocking(move || {
        let _guards = locks
            .iter()
            .map(|gate| gate.lock())
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let _ = ready.send(());
        let _ = done.blocking_recv();
    });
    admitted.await?;
    Ok((release, worker))
}

pub(super) async fn run(
    app: &tauri::AppHandle,
    host: &Arc<Runtime>,
    client: &Arc<Node>,
    directory: &Path,
    model: &ModelChoice,
) -> anyhow::Result<Value> {
    let base = directory.join("regressions");
    let a = base.join("a");
    let b = base.join("b");
    let c = base.join("c");
    for root in [&a, &b, &c] {
        std::fs::create_dir_all(root)?;
        std::fs::write(root.join("main.txt"), "before\n")?;
        host.store.share(root)?;
    }
    let host_id = host.node.get().unwrap().id();
    let projects = host.store.projects()?;
    let project_a = projects.iter().find(|p| p.path == a).unwrap();
    let project_b = projects.iter().find(|p| p.path == b).unwrap();
    let project_c = projects.iter().find(|p| p.path == c).unwrap();
    let mut sessions = Vec::new();
    for project in [project_a, project_b, project_c] {
        let created = call(
            client,
            &host_id,
            Operation::CreateSession {
                project_id: project.id.clone(),
                title: "Regression fixture".into(),
                model: model.clone(),
                branch: None,
            },
            None,
        )
        .await?;
        sessions.push((
            created["session"]["id"].as_str().unwrap().to_string(),
            created["control"]["generation"].as_u64().unwrap(),
        ));
    }
    let (session_a, lease_a) = &sessions[0];
    let (session_c, lease_c) = &sessions[2];
    // Parent/child sessions address the identical file with different relative
    // paths. Both wait for the parent resource; exactly one stale-base save wins.
    host.store.share(&base)?;
    let parent = host
        .store
        .projects()?
        .into_iter()
        .find(|p| p.path == base)
        .unwrap();
    let parent_session = call(
        client,
        &host_id,
        Operation::CreateSession {
            project_id: parent.id.clone(),
            title: "Parent workspace".into(),
            model: model.clone(),
            branch: None,
        },
        None,
    )
    .await?;
    let parent_id = parent_session["session"]["id"].as_str().unwrap();
    let parent_lease = parent_session["control"]["generation"].as_u64().unwrap();
    let initial = file(client, &host_id, session_a).await?;
    let (release, worker) = hold_git(host, parent_id).await?;
    let child_client = client.clone();
    let child_host = host_id.clone();
    let child_op = write(
        session_a,
        "child wins\n",
        initial["contentHash"].as_str().unwrap(),
    );
    let child_lease = *lease_a;
    let child_save =
        tokio::spawn(
            async move { call(&child_client, &child_host, child_op, Some(child_lease)).await },
        );
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !child_save.is_finished(),
        "parent workspace must fence child writes"
    );
    let parent_client = client.clone();
    let parent_host = host_id.clone();
    let parent_op = Operation::WriteFile {
        session_id: parent_id.into(),
        path: "a/main.txt".into(),
        content: "parent wins\n".into(),
        expected_hash: Some(initial["contentHash"].as_str().unwrap().into()),
    };
    let parent_save = tokio::spawn(async move {
        call(&parent_client, &parent_host, parent_op, Some(parent_lease)).await
    });
    let _ = release.send(());
    worker.await?;
    let (child_result, parent_result) = tokio::try_join!(child_save, parent_save)?;
    assert_ne!(
        child_result.is_ok(),
        parent_result.is_ok(),
        "exactly one save using the same base hash may succeed"
    );
    local_action(
        host,
        LocalAction::Unshare {
            project_id: parent.id,
        },
    )
    .map_err(anyhow::Error::msg)?;
    crate::stores::open_store()
        .map_err(anyhow::Error::msg)?
        .set_workspace_identity(Uuid::parse_str(session_a)?, &[a.clone(), b.clone()], &a)?;

    // Same-resource writes wait, while another project's write and a non-file
    // approval in the blocked session still complete through normal admission.
    let original = file(client, &host_id, session_a).await?;
    let hash_a = original["contentHash"].as_str().unwrap().to_string();
    let (release, worker) = hold_git(host, session_a).await?;
    let request_client = client.clone();
    let request_host = host_id.clone();
    let operation = write(session_a, "serialized\n", &hash_a);
    let lease = *lease_a;
    let queued =
        tokio::spawn(
            async move { call(&request_client, &request_host, operation, Some(lease)).await },
        );
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !queued.is_finished(),
        "same repository mutations must still serialize"
    );
    let other = file(client, &host_id, session_c).await?;
    tokio::time::timeout(
        Duration::from_secs(2),
        call(
            client,
            &host_id,
            write(
                session_c,
                "unrelated\n",
                other["contentHash"].as_str().unwrap(),
            ),
            Some(*lease_c),
        ),
    )
    .await??;
    let approval_id = Uuid::new_v4().to_string();
    let turn = Uuid::new_v4();
    let (sender, receiver) = std::sync::mpsc::channel();
    app.state::<crate::state::managers::ProviderCapabilityApprovalManager>()
        .pending
        .lock()
        .unwrap()
        .insert(
            approval_id.clone(),
            crate::state::provider_run::PendingCapabilityApproval {
                session_id: Uuid::parse_str(session_a)?,
                turn_id: Some(turn),
                sender,
            },
        );
    tokio::time::timeout(
        Duration::from_secs(2),
        call(
            client,
            &host_id,
            Operation::Approval {
                session_id: session_a.clone(),
                approval_id,
                turn_id: Some(turn.to_string()),
                kind: ApprovalKind::Capability,
                decision: "approve".into(),
            },
            Some(*lease_a),
        ),
    )
    .await??;
    assert_eq!(
        receiver.recv_timeout(Duration::from_secs(1))?,
        gyro_core::CapabilityApprovalDecision::AllowOnce
    );
    let approval_id = Uuid::new_v4();
    let (sender, receiver) = std::sync::mpsc::channel();
    app.state::<crate::state::managers::ProviderApprovalManager>()
        .pending
        .lock()
        .unwrap()
        .insert(
            approval_id.to_string(),
            crate::state::provider_run::PendingProviderApproval {
                session_id: Uuid::parse_str(session_a)?,
                turn_id: Some(turn),
                approval_id,
                payload: json!({"kind":"approval-fixture"}),
                file_transaction: None,
                sender,
            },
        );
    let request = Request {
        id: Uuid::new_v4(),
        lease: Some(*lease_a),
        operation: Operation::Approval {
            session_id: session_a.clone(),
            approval_id: approval_id.to_string(),
            turn_id: Some(turn.to_string()),
            kind: ApprovalKind::Provider,
            decision: "approve".into(),
        },
    };
    let first = tokio::time::timeout(
        Duration::from_secs(2),
        client.request(&host_id, request.clone()),
    )
    .await??
    .into_result()
    .map_err(anyhow::Error::msg)?;
    let replay = client
        .request(&host_id, request)
        .await?
        .into_result()
        .map_err(anyhow::Error::msg)?;
    assert_eq!(
        first, replay,
        "completed approval receipts must replay after pending state is removed"
    );
    assert_eq!(
        receiver.recv_timeout(Duration::from_secs(1))?,
        crate::state::provider_run::ProviderApprovalDecision::Approve
    );
    let _ = release.send(());
    worker.await?;
    tokio::time::timeout(Duration::from_secs(2), queued).await???;
    assert_eq!(std::fs::read_to_string(a.join("main.txt"))?, "serialized\n");

    let pane = terminal(client, &host_id, session_a, *lease_a).await?;
    let (watch_a, mut events_a) = watch(client, &host_id, session_a).await?;
    let (watch_c, mut events_c) = watch(client, &host_id, session_c).await?;
    host.publish(session_a, "provider", json!("before-unshare"));
    assert_eq!(event(&mut events_a).await?.payload, "before-unshare");
    // Revoke a secondary root while a write is queued. It must be reauthorized
    // after acquiring its resource lock, not execute using the old permission.
    let current = file(client, &host_id, session_a).await?;
    let (release, worker) = hold_git(host, session_a).await?;
    let request_client = client.clone();
    let request_host = host_id.clone();
    let operation = write(
        session_a,
        "forbidden\n",
        current["contentHash"].as_str().unwrap(),
    );
    let queued =
        tokio::spawn(
            async move { call(&request_client, &request_host, operation, Some(lease)).await },
        );
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!queued.is_finished());
    local_action(
        host,
        LocalAction::Unshare {
            project_id: project_b.id.clone(),
        },
    )
    .map_err(anyhow::Error::msg)?;
    let _ = release.send(());
    worker.await?;
    assert!(tokio::time::timeout(Duration::from_secs(2), queued)
        .await??
        .is_err());
    assert_eq!(std::fs::read_to_string(a.join("main.txt"))?, "serialized\n");
    assert!(host.session(session_a).is_err());
    assert!(host.session(&sessions[1].0).is_err());
    assert!(!host.terminals.lock().unwrap().contains_key(&pane));
    assert!(app
        .state::<crate::terminal::types::TerminalProcessManager>()
        .observe(&pane, false)
        .is_err());
    host.publish(session_a, "provider", json!("forbidden-after-unshare"));
    let closed = event(&mut events_a).await?;
    assert_eq!(closed.payload["streamClosed"], true);
    watch_a.await?;
    assert!(events_a.try_recv().is_err());
    host.publish(session_c, "provider", json!("unaffected"));
    assert_eq!(event(&mut events_c).await?.payload, "unaffected");

    // Removing a redundant share must preserve authorization, streams and shells.
    host.store.share(&b)?;
    host.store.share(&base)?;
    let project_b = host
        .store
        .projects()?
        .into_iter()
        .find(|p| p.path == b)
        .unwrap();
    let pane = terminal(client, &host_id, session_a, *lease_a).await?;
    let (watch_a, mut events_a) = watch(client, &host_id, session_a).await?;
    local_action(
        host,
        LocalAction::Unshare {
            project_id: project_b.id,
        },
    )
    .map_err(anyhow::Error::msg)?;
    assert!(host.session(session_a).is_ok());
    assert!(host.terminals.lock().unwrap().contains_key(&pane));
    host.publish(session_a, "provider", json!("overlap-preserved"));
    assert_eq!(event(&mut events_a).await?.payload, "overlap-preserved");
    let parent = host
        .store
        .projects()?
        .into_iter()
        .find(|p| p.path == base)
        .unwrap();
    local_action(
        host,
        LocalAction::Unshare {
            project_id: parent.id,
        },
    )
    .map_err(anyhow::Error::msg)?;
    assert!(!host.terminals.lock().unwrap().contains_key(&pane));
    assert_eq!(event(&mut events_a).await?.payload["streamClosed"], true);
    watch_a.await?;
    assert!(host.session(session_c).is_ok());
    host.publish(session_c, "provider", json!("still-unaffected"));
    assert_eq!(event(&mut events_c).await?.payload, "still-unaffected");
    watch_c.abort();
    let _ = watch_c.await;
    Ok(json!([
        "overlapping-workspace-saves-serialized",
        "same-repository-serialized",
        "unrelated-project-write-responsive",
        "capability-approval-responsive",
        "provider-approval-responsive",
        "approval-receipt-replayed",
        "queued-write-reauthorized",
        "secondary-root-watch-revoked",
        "secondary-root-terminal-closed",
        "unrelated-session-preserved",
        "overlapping-share-preserved"
    ]))
}
