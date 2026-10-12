//! Opt-in native broker acceptance using isolated fixtures, no provider calls.
use super::*;
use serde_json::{json, Value};

pub(super) fn start(app: &tauri::AppHandle) -> Result<bool, Box<dyn std::error::Error>> {
    if std::env::var_os("GYRO_CODE_MODE_SMOKE").is_none() {
        return Ok(false);
    }
    let directory = PathBuf::from(std::env::var("GYRO_TEST_DATA_DIR")?);
    if !directory.is_absolute() {
        return Err("Code Mode smoke requires isolated absolute data directory".into());
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let result = run(&app, &directory);
        let report = match &result {
            Ok(value) => value.clone(),
            Err(error) => json!({"ok":false,"error":error.to_string()}),
        };
        let _ = fs::write(directory.join("code-mode-smoke.json"), report.to_string());
        eprintln!("Code Mode native smoke: {report}");
        app.exit(if result.is_ok() { 0 } else { 1 });
    });
    Ok(true)
}
fn run(app: &tauri::AppHandle, directory: &Path) -> anyhow::Result<Value> {
    fs::create_dir_all(directory)?;
    let paths = GyroPaths::for_current_user()?;
    let mut config = GyroConfig::default();
    config.full_access = false;
    config.require_command_approval = true;
    config.require_file_edit_approval = true;
    config.save(&paths)?;
    let workspace = directory.join("fixture");
    fs::create_dir_all(&workspace)?;
    fs::write(workspace.join("one.txt"), "spacing token one\n")?;
    fs::write(workspace.join("two.txt"), "spacing token two\n")?;
    fs::write(
        workspace.join(".env"),
        "PRIVATE_FIXTURE=never disclose without approval\n",
    )?;
    let workspace = workspace.canonicalize()?;
    let store = open_store().map_err(anyhow::Error::msg)?;
    let session = store.create_session(
        &workspace,
        SessionOrigin::Desktop,
        "Code Mode native fixture",
    )?;
    let session_id = session.id.to_string();
    let mut bound = BoundProviderCapabilityContext {
        session_id: session_id.clone(),
        turn_id: Some(Uuid::new_v4().to_string()),
        provider_id: "openrouter".into(),
        workspace: workspace.clone(),
        workspace_key: workspace.display().to_string(),
        workspace_identity_revision: session.workspace_identity.revision,
        allow_delegation: false,
        policy: CapabilityPolicySnapshot::from_policy(
            &store.get_project_capability_policy(&workspace.display().to_string())?,
            CapabilityRunMode::Normal,
        ),
        workspace_context: WorkspaceContextSnapshot::empty(workspace.display().to_string()),
        workspace_check: gyro_core::check_workspace(&workspace),
    };
    let control = Arc::new(ProviderRunControl::default());
    let lease = ProviderSessionLease::for_run(&store, session.id)?;
    *control.process_owner.lock().unwrap() = Some(lease.process_owner());
    *control.capability_context.lock().unwrap() = Some(bound.clone());
    app.state::<ProviderCancellationManager>()
        .flags
        .lock()
        .unwrap()
        .insert(session_id.clone(), control.clone());
    let request = |id, arguments, context: &BoundProviderCapabilityContext| CapabilityRequest {
        schema: PROVIDER_CAPABILITY_IPC_SCHEMA_V1.into(),
        sender_version: env!("CARGO_PKG_VERSION").into(),
        context: CapabilityInvocationContext {
            session_id: context.session_id.clone(),
            turn_id: context.turn_id.clone(),
            provider_id: context.provider_id.clone(),
            run_nonce: control.approval_nonce.clone(),
            call_id: Uuid::new_v4(),
            workspace_key: context.workspace_key.clone(),
            mode: context.policy.mode,
            policy_revision: context.policy.revision,
            workspace_context_revision: context.workspace_context.revision,
        },
        capability_id: id,
        arguments,
    };
    let invoke = |id, arguments, context: &BoundProviderCapabilityContext| {
        app.state::<ProviderCapabilityBroker>()
            .invoke(app, request(id, arguments, context))
    };
    let mut steps = Vec::new();
    anyhow::ensure!(
        code_mode::enabled(),
        "Code Mode pilot must be enabled for acceptance"
    );
    let catalog = invoke(CapabilityId::CodeModeDiscover, json!({"limit":2}), &bound);
    anyhow::ensure!(
        catalog
            .result
            .as_ref()
            .is_some_and(|r| r.data["tools"].as_array().is_some_and(|a| a.len() == 2)
                && r.data["hasMore"] == true),
        "Catalog pagination: {catalog:?}"
    );
    anyhow::ensure!(
        provider_tool_batch::model_tools(CapabilityRunMode::Normal, false)
            .iter()
            .any(|t| t["function"]["name"] == "gyro_code_mode_execute"),
        "Native provider did not advertise execution"
    );
    steps.push("catalog pagination and native provider discovery");

    let ordinary_started = Instant::now();
    let mut ordinary = Vec::new();
    let found = invoke(
        CapabilityId::WorkspaceSearch,
        json!({"query":"spacing","globs":["*.txt"]}),
        &bound,
    );
    let matches = found
        .result
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("Search failed"))?
        .data
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Unexpected search"))?;
    for found in matches {
        let read = invoke(
            CapabilityId::WorkspaceRead,
            json!({"path":found["path"]}),
            &bound,
        );
        ordinary.push(
            read.result
                .ok_or_else(|| anyhow::anyhow!("Read failed"))?
                .data["content"]
                .clone(),
        );
    }
    let ordinary_ms = ordinary_started.elapsed().as_millis();
    let started = Instant::now();
    let composed = invoke(
        CapabilityId::CodeModeExecute,
        json!({"label":"Checking spacing fixtures","code":"const found = await tools.gyro_workspace_search({query:'spacing', globs:['*.txt']}); const read = await Promise.all(found.data.map(match => tools.gyro_workspace_read({path:match.path}))); return read.map(item => item.data.content);"}),
        &bound,
    );
    let composed_ms = started.elapsed().as_millis();
    let data = &composed
        .result
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("Workflow failed"))?
        .data;
    anyhow::ensure!(data["outcome"]["ok"] == true, "Dependent workflow: {data}");
    let mut actual = data["outcome"]["value"]
        .as_array()
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("Missing composed evidence"))?;
    actual.sort_by_key(Value::to_string);
    ordinary.sort_by_key(Value::to_string);
    anyhow::ensure!(
        actual == ordinary,
        "Evidence differs: actual={actual:?}, ordinary={ordinary:?}"
    );
    let events = store.read_events(session.id)?;
    let parent = composed.result.as_ref().unwrap().call_id;
    let children = events
        .iter()
        .filter(|e| {
            e.payload["groupId"] == parent.to_string() && e.payload["status"] == "completed"
        })
        .count();
    anyhow::ensure!(
        children == 3,
        "Expected 3 audited child completions, got {children}"
    );
    anyhow::ensure!(
        events
            .iter()
            .any(|e| e.payload["callId"] == parent.to_string()
                && e.payload["codeMode"]["outcome"]["completed"] == 3),
        "Parent outcome not durable"
    );
    steps.push(
        "dependent search/parallel reads through broker; evidence parity; durable grouped events",
    );

    let invalid = invoke(
        CapabilityId::CodeModeExecute,
        json!({"label":"Validate arguments","code":"return await tools.gyro_workspace_read({path:42});"}),
        &bound,
    );
    anyhow::ensure!(
        invalid.result.unwrap().data["outcome"]["ok"] == false,
        "Invalid arguments executed"
    );
    let escape = invoke(
        CapabilityId::CodeModeExecute,
        json!({"label":"Validate scope","code":"return await tools.gyro_workspace_read({path:'../outside.txt'});"}),
        &bound,
    );
    anyhow::ensure!(
        escape.result.unwrap().data["outcome"]["ok"] == false,
        "Workspace escape allowed"
    );
    steps.push("schema validation and workspace escape refusal");

    let denied = std::thread::scope(|scope| {
        let session_id = &session_id;
        scope.spawn(move || {
            let started = Instant::now();
            loop {
                let pending = {
                    let manager = app.state::<ProviderCapabilityApprovalManager>();
                    let mut items = manager.pending.lock().unwrap();
                    let id = items
                        .iter()
                        .find(|(_, v)| v.session_id.to_string() == *session_id)
                        .map(|(id, _)| id.clone());
                    id.and_then(|id| items.remove(&id))
                };
                if let Some(pending) = pending {
                    pending
                        .sender
                        .send(CapabilityApprovalDecision::Deny)
                        .unwrap();
                    return;
                }
                assert!(
                    started.elapsed() < Duration::from_secs(10),
                    "Expected sensitive-read approval"
                );
                std::thread::sleep(Duration::from_millis(20));
            }
        });
        invoke(
            CapabilityId::CodeModeExecute,
            json!({"label":"Check sensitive-read approval","code":"await tools.gyro_workspace_read({path:'one.txt'}); return await tools.gyro_workspace_read({path:'.env'});"}),
            &bound,
        )
    });
    let denied = denied.result.unwrap().data;
    anyhow::ensure!(
        denied["outcome"]["ok"] == false
            && denied["completed"] == 1
            && denied["calls"][1]["status"] == "denied",
        "Denied workflow lost partial work: {denied}"
    );
    anyhow::ensure!(
        !denied.to_string().contains("never disclose"),
        "Denied content disclosed"
    );
    steps.push("sensitive-read approval denial retains earlier work without disclosure or replay");

    let second = directory.join("second-root");
    fs::create_dir_all(&second)?;
    fs::write(second.join("secondary.txt"), "secondary evidence")?;
    let identity = store
        .set_workspace_identity(session.id, &[workspace.clone(), second.clone()], &workspace)?
        .workspace_identity;
    bound.workspace_identity_revision = identity.revision;
    *control.capability_context.lock().unwrap() = Some(bound.clone());
    let missing_root = invoke(
        CapabilityId::CodeModeExecute,
        json!({"label":"Require root","code":"return await tools.gyro_workspace_read({path:'one.txt'});"}),
        &bound,
    );
    anyhow::ensure!(
        missing_root.result.unwrap().data["outcome"]["ok"] == false,
        "Missing root was accepted"
    );
    let root = identity
        .roots
        .iter()
        .find(|root| root.path == second.canonicalize().unwrap())
        .unwrap();
    let code = format!("return (await tools.gyro_workspace_read({{path:'secondary.txt',rootId:{}}})).data.content;", serde_json::to_string(&root.id)?);
    let selected = invoke(
        CapabilityId::CodeModeExecute,
        json!({"label":"Read secondary root","code":code}),
        &bound,
    );
    anyhow::ensure!(
        selected.result.unwrap().data["outcome"]["value"] == "secondary evidence",
        "Secondary root routing failed"
    );
    let identity = store
        .set_workspace_identity(session.id, &[workspace.clone()], &workspace)?
        .workspace_identity;
    bound.workspace_identity_revision = identity.revision;
    *control.capability_context.lock().unwrap() = Some(bound.clone());
    steps.push("multi-root calls require rootId; explicit secondary-root routing preserves scope");

    bound.policy.mode = CapabilityRunMode::Plan;
    *control.capability_context.lock().unwrap() = Some(bound.clone());
    let read_only = invoke(
        CapabilityId::CodeModeExecute,
        json!({"label":"Plan inspection","code":"return (await tools.gyro_workspace_read({path:'one.txt'})).data.content;"}),
        &bound,
    );
    anyhow::ensure!(
        read_only.result.unwrap().data["outcome"]["ok"] == true,
        "Plan inspection failed"
    );
    let no_edit = invoke(
        CapabilityId::CodeModeExecute,
        json!({"label":"Reject write","code":"return await tools.gyro_workspace_edit({path:'one.txt',oldString:'spacing',newString:'changed'});"}),
        &bound,
    );
    anyhow::ensure!(
        no_edit.result.unwrap().data["outcome"]["ok"] == false,
        "Plan write allowed"
    );
    anyhow::ensure!(
        fs::read_to_string(workspace.join("one.txt"))? == "spacing token one\n",
        "File changed"
    );
    bound.policy.mode = CapabilityRunMode::Council;
    *control.capability_context.lock().unwrap() = Some(bound.clone());
    anyhow::ensure!(
        invoke(
            CapabilityId::CodeModeExecute,
            json!({"label":"Council","code":"return 1"}),
            &bound
        )
        .result
        .is_none(),
        "Council executed"
    );
    steps.push("Plan inspection allowed; writes unavailable; Council denied");

    bound.policy.mode = CapabilityRunMode::Normal;
    *control.capability_context.lock().unwrap() = Some(bound.clone());
    let stopped = std::thread::scope(|scope| {
        let control = &control;
        scope.spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            control.cancellation.cancel();
        });
        invoke(
            CapabilityId::CodeModeExecute,
            json!({"label":"Cancel busy workflow","code":"while(true) {}"}),
            &bound,
        )
    });
    anyhow::ensure!(
        stopped.result.unwrap().data["outcome"]["error"]["kind"] == "Cancelled",
        "Stop did not cancel worker"
    );
    steps.push("native Stop terminates busy worker");
    app.state::<ProviderCancellationManager>()
        .flags
        .lock()
        .unwrap()
        .remove(&session_id);
    Ok(json!({
        "ok":true,"steps":steps,"sessionId":session_id,
        "benchmark":{"kind":"deterministic broker fixture, no model generation","ordinaryToolExchanges":3,"composedToolExchanges":1,"coldDiscoveryExchanges":1,"ordinaryMs":ordinary_ms,"composedMs":composed_ms,"evidenceEqual":true,
            "modelTokens":null,"note":"Round trips are counted from scripted requests. No inference latency or token savings are claimed."},
    }))
}
