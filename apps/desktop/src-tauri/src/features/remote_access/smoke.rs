//! Explicit isolated native acceptance. No Keychain, public relay or model calls.
use super::{store, Runtime};
use gyro_remote::{
    protocol::{ApprovalKind, GitAction, ModelChoice, TerminalAction},
    store::Settings,
    transport::{Handler, Node},
    Operation, Request, Response,
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tauri::Manager;
use uuid::Uuid;

pub(crate) fn start(app: &tauri::AppHandle) -> Result<bool, Box<dyn std::error::Error>> {
    if std::env::var_os("GYRO_REMOTE_SMOKE").is_none() {
        return Ok(false);
    }
    let directory = PathBuf::from(std::env::var("GYRO_TEST_DATA_DIR")?);
    if !directory.is_absolute()
        || !directory.starts_with(std::env::temp_dir().canonicalize()?)
            && !directory.starts_with("/private/tmp")
    {
        return Err("Remote smoke requires an isolated temporary data directory".into());
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let task_app = app.clone();
        let task_directory = directory.clone();
        let task =
            tauri::async_runtime::spawn(async move { run(&task_app, &task_directory).await });
        let result = match tokio::time::timeout(Duration::from_secs(90), task).await {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => Err(anyhow::anyhow!("Smoke task failed: {error}")),
            Err(_) => Err(anyhow::anyhow!("Smoke timed out")),
        };
        let report = match &result {
            Ok(v) => v.clone(),
            Err(e) => json!({"ok":false,"error":e.to_string()}),
        };
        let _ = std::fs::write(
            directory.join("remote-smoke.json"),
            serde_json::to_vec_pretty(&report).unwrap(),
        );
        eprintln!(
            "Remote native smoke: {}",
            if result.is_ok() {
                "passed"
            } else {
                "failed; see isolated report"
            }
        );
        app.exit(if result.is_ok() { 0 } else { 1 });
    });
    Ok(true)
}
pub(super) async fn call(
    client: &Node,
    host: &str,
    op: Operation,
    lease: Option<u64>,
) -> anyhow::Result<Value> {
    client
        .request(
            host,
            Request {
                id: Uuid::new_v4(),
                operation: op,
                lease,
            },
        )
        .await?
        .into_result()
        .map_err(anyhow::Error::msg)
}
async fn run(app: &tauri::AppHandle, directory: &Path) -> anyhow::Result<Value> {
    std::fs::create_dir_all(directory)?;
    let root = directory.join("project");
    std::fs::create_dir_all(&root)?;
    std::fs::write(root.join("main.txt"), "before\n")?;
    for args in [
        vec!["init", "-b", "main"],
        vec!["config", "user.name", "Gyro fixture"],
        vec!["config", "user.email", "fixture@example.invalid"],
        vec!["config", "commit.gpgsign", "false"],
        vec!["add", "main.txt"],
        vec!["commit", "-m", "Fixture base"],
    ] {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(&root)
            .output()?;
        anyhow::ensure!(output.status.success(), "Fixture Git setup failed");
    }
    let paths = gyro_core::GyroPaths::for_current_user()?;
    let mut config = gyro_core::GyroConfig::default();
    let provider = config
        .model_providers
        .iter_mut()
        .find(|p| p.id == "openai")
        .ok_or_else(|| anyhow::anyhow!("Fixture provider unavailable"))?;
    provider.enabled = true;
    provider.default_model_id = Some("gpt-6.1".into());
    provider.api_key_ref = "GYRO_REMOTE_SMOKE_UNUSED".into();
    config.save(&paths)?;
    let model = ModelChoice {
        provider_id: "openai".into(),
        model_id: "gpt-6.1".into(),
        reasoning_effort: None,
    };
    let host_store = store().map_err(anyhow::Error::msg)?;
    host_store.save_settings(&Settings {
        enabled: true,
        name: "Native fixture host".into(),
    })?;
    host_store.share(&root)?;
    let host = Runtime::bind(app, host_store, Node::generate_secret(), true)
        .await
        .map_err(anyhow::Error::msg)?;
    *app.state::<super::RemoteAccess>().runtime.lock().await = Some(host.clone());
    *app.state::<super::RemoteAccess>().active.write().unwrap() = Some(Arc::downgrade(&host));
    let reject: Handler = Arc::new(|_, r| {
        Box::pin(async move {
            Response::result(r.id, Err("Fixture client has no inbound access".into()))
        })
    });
    let client = Node::bind_loopback(Node::generate_secret(), reject.clone()).await?;
    let other = Node::bind_loopback(Node::generate_secret(), reject).await?;
    let host_id = host.node.get().unwrap().id();
    client
        .remember(&host_id, host.node.get().unwrap().address())
        .await?;
    other
        .remember(&host_id, host.node.get().unwrap().address())
        .await?;
    assert!(call(&client, &host_id, Operation::Projects, None)
        .await
        .is_err());
    let invite = host.store.invite(host_id.clone())?;
    call(
        &client,
        &host_id,
        Operation::Pair {
            secret: invite.secret,
            name: "Native client".into(),
        },
        None,
    )
    .await?;
    assert!(call(&client, &host_id, Operation::Projects, None)
        .await
        .is_err());
    host.store.approve(&client.id())?;
    let project = call(&client, &host_id, Operation::Projects, None).await?[0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let request = Request {
        id: Uuid::new_v4(),
        lease: None,
        operation: Operation::CreateSession {
            project_id: project.clone(),
            title: "Remote native fixture".into(),
            model: model.clone(),
            branch: None,
        },
    };
    let created = client
        .request(&host_id, request.clone())
        .await?
        .into_result()
        .map_err(anyhow::Error::msg)?;
    let replay = client
        .request(&host_id, request)
        .await?
        .into_result()
        .map_err(anyhow::Error::msg)?;
    assert_eq!(created["session"]["id"], replay["session"]["id"]);
    let session = created["session"]["id"].as_str().unwrap().to_string();
    let generation = created["control"]["generation"].as_u64().unwrap();
    let file = call(
        &client,
        &host_id,
        Operation::ReadFile {
            session_id: session.clone(),
            path: "main.txt".into(),
        },
        None,
    )
    .await?;
    assert!(call(
        &client,
        &host_id,
        Operation::ReadFile {
            session_id: session.clone(),
            path: "../outside".into()
        },
        None
    )
    .await
    .is_err());
    let approval_id = Uuid::new_v4().to_string();
    let approval_turn = Uuid::new_v4();
    let (sender, receiver) = std::sync::mpsc::channel();
    app.state::<crate::state::managers::ProviderCapabilityApprovalManager>()
        .pending
        .lock()
        .unwrap()
        .insert(
            approval_id.clone(),
            crate::state::provider_run::PendingCapabilityApproval {
                sender,
                session_id: Uuid::parse_str(&session)?,
                turn_id: Some(approval_turn),
            },
        );
    assert!(call(
        &client,
        &host_id,
        Operation::Approval {
            session_id: session.clone(),
            approval_id: approval_id.clone(),
            turn_id: Some(Uuid::new_v4().to_string()),
            kind: ApprovalKind::Capability,
            decision: "approve".into()
        },
        Some(generation)
    )
    .await
    .is_err());
    call(
        &client,
        &host_id,
        Operation::Approval {
            session_id: session.clone(),
            approval_id,
            turn_id: Some(approval_turn.to_string()),
            kind: ApprovalKind::Capability,
            decision: "approve".into(),
        },
        Some(generation),
    )
    .await?;
    assert_eq!(
        receiver.recv_timeout(Duration::from_secs(1))?,
        gyro_core::CapabilityApprovalDecision::AllowOnce
    );
    assert!(super::require_local_control(app, &session).is_err());
    call(
        &client,
        &host_id,
        Operation::WriteFile {
            session_id: session.clone(),
            path: "main.txt".into(),
            content: "after\n".into(),
            expected_hash: Some(file["contentHash"].as_str().unwrap().into()),
        },
        Some(generation),
    )
    .await?;
    assert!(call(
        &client,
        &host_id,
        Operation::WriteFile {
            session_id: session.clone(),
            path: "main.txt".into(),
            content: "stale\n".into(),
            expected_hash: Some(file["contentHash"].as_str().unwrap().into())
        },
        Some(generation)
    )
    .await
    .is_err());
    let status = call(
        &client,
        &host_id,
        Operation::Git {
            session_id: session.clone(),
            action: GitAction::Status,
            path: None,
            message: None,
            expected_revision: None,
        },
        None,
    )
    .await?;
    let revision = status["revision"].as_str().unwrap().to_string();
    call(
        &client,
        &host_id,
        Operation::Git {
            session_id: session.clone(),
            action: GitAction::Stage,
            path: Some("main.txt".into()),
            message: None,
            expected_revision: Some(revision.clone()),
        },
        Some(generation),
    )
    .await?;
    assert!(call(
        &client,
        &host_id,
        Operation::Git {
            session_id: session.clone(),
            action: GitAction::Commit,
            path: None,
            message: Some("Must reject stale view".into()),
            expected_revision: Some(revision)
        },
        Some(generation)
    )
    .await
    .is_err());
    let status = call(
        &client,
        &host_id,
        Operation::Git {
            session_id: session.clone(),
            action: GitAction::Status,
            path: None,
            message: None,
            expected_revision: None,
        },
        None,
    )
    .await?;
    call(
        &client,
        &host_id,
        Operation::Git {
            session_id: session.clone(),
            action: GitAction::Commit,
            path: None,
            message: Some("Remote fixture commit".into()),
            expected_revision: Some(status["revision"].as_str().unwrap().into()),
        },
        Some(generation),
    )
    .await?;
    let worktree = call(
        &client,
        &host_id,
        Operation::CreateSession {
            project_id: project.clone(),
            title: "Fixture worktree".into(),
            model: model.clone(),
            branch: Some("remote-fixture".into()),
        },
        None,
    )
    .await?;
    let worktree_session = worktree["session"]["id"].as_str().unwrap().to_string();
    assert_ne!(
        worktree["session"]["workspacePath"],
        created["session"]["workspacePath"]
    );
    let worktree_file = call(
        &client,
        &host_id,
        Operation::ReadFile {
            session_id: worktree_session.clone(),
            path: "main.txt".into(),
        },
        None,
    )
    .await?;
    assert_eq!(worktree_file["content"], "after\n");
    let turn = Uuid::new_v4().to_string();
    let submit = Request {
        id: Uuid::new_v4(),
        lease: Some(generation),
        operation: Operation::Submit {
            session_id: session.clone(),
            turn_id: turn.clone(),
            message: "Run deterministic fixture".into(),
            model: model.clone(),
        },
    };
    client
        .request(&host_id, submit.clone())
        .await?
        .into_result()
        .map_err(anyhow::Error::msg)?;
    client.disconnect(&host_id).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    client
        .request(&host_id, submit)
        .await?
        .into_result()
        .map_err(anyhow::Error::msg)?;
    assert!(root.join("fixture-result.txt").exists());
    let events = crate::stores::open_store()
        .map_err(anyhow::Error::msg)?
        .read_recent_events(Uuid::parse_str(&session)?, 200)?;
    assert_eq!(
        events
            .iter()
            .filter(|e| e.kind == gyro_core::SessionEventKind::UserMessage)
            .count(),
        1
    );
    let pane = call(
        &client,
        &host_id,
        Operation::Terminal {
            session_id: session.clone(),
            action: TerminalAction::Create,
            pane_id: None,
            input: None,
            cols: Some(80),
            rows: Some(24),
            revision: None,
        },
        Some(generation),
    )
    .await?;
    let pane_id = pane["paneId"].as_str().unwrap().to_string();
    call(
        &client,
        &host_id,
        Operation::Terminal {
            session_id: session.clone(),
            action: TerminalAction::Input,
            pane_id: Some(pane_id.clone()),
            input: Some("printf 'GYRO_REMOTE_%s\\n' 'PTY_OK'\r".into()),
            cols: None,
            rows: None,
            revision: None,
        },
        Some(generation),
    )
    .await?;
    let mut pty_ok = false;
    for _ in 0..30 {
        let output = call(
            &client,
            &host_id,
            Operation::Terminal {
                session_id: session.clone(),
                action: TerminalAction::Read,
                pane_id: Some(pane_id.clone()),
                input: None,
                cols: None,
                rows: None,
                revision: None,
            },
            None,
        )
        .await?;
        if output["output"]
            .as_str()
            .unwrap_or("")
            .contains("GYRO_REMOTE_PTY_OK")
        {
            pty_ok = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(pty_ok);
    host.controls
        .lock()
        .unwrap()
        .claim(&session, "local", true)
        .unwrap();
    assert!(call(
        &client,
        &host_id,
        Operation::Terminal {
            session_id: session.clone(),
            action: TerminalAction::Input,
            pane_id: Some(pane_id),
            input: Some("bad\r".into()),
            cols: None,
            rows: None,
            revision: None
        },
        Some(generation)
    )
    .await
    .is_err());
    assert!(call(
        &other,
        &host_id,
        Operation::History {
            session_id: session,
            before: None,
            revision: None
        },
        None
    )
    .await
    .is_err());
    let regressions = super::smoke_regressions::run(app, &host, &client, directory, &model).await?;
    host.store.unshare(&project)?;
    assert!(call(
        &client,
        &host_id,
        Operation::ReadFile {
            session_id: worktree_session,
            path: "main.txt".into()
        },
        None
    )
    .await
    .is_err());
    host.store.revoke(&client.id())?;
    assert!(call(&client, &host_id, Operation::Projects, None)
        .await
        .is_err());
    client.close().await;
    other.close().await;
    host.node.get().unwrap().close().await;
    Ok(
        json!({"ok":true,"checks":["unpaired-denied","host-approval-required","create-idempotent","shared-paths","local-control-fenced","file-conflict","approval-turn-fencing","approval-routing","git-stage-commit","git-stale-revision","worktree-session","worktree-scope-revocation","submit-idempotent","disconnect-keeps-running","remote-pty","stale-control-denied","other-device-denied","revocation"],"regressions":regressions,"provider":"deterministic fixture; no provider calls","transport":"two loopback endpoints; no public relay"}),
    )
}
