//! Model-owned terminal observations and lifecycle operations.
use super::*;

pub(super) fn execute(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    request: &CapabilityRequest,
) -> anyhow::Result<(String, serde_json::Value, Option<CapabilityResourceRef>)> {
    let arguments = &request.arguments;
    let resources = app.state::<ProviderCapabilityResourceManager>();
    let owned = resources
        .terminals
        .lock()
        .map_err(|_| anyhow::anyhow!("terminal capability state is unavailable"))?
        .get(&bound.session_id)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("this chat has no model-owned terminal"))?;
    if owned.workspace_key != bound.workspace_key || owned.session_id != bound.session_id {
        anyhow::bail!("terminal resource ownership changed");
    }
    let snapshot = if request.capability_id == CapabilityId::TerminalWait {
        let resource_id = capability_argument_string(arguments, "resourceId")?;
        if resource_id != owned.resource_id {
            anyhow::bail!(
                "terminal resource ownership changed; do not wait on a replacement command"
            );
        }
        let timeout = terminal_wait::timeout(arguments)?;
        let cancellation = app
            .state::<ProviderCancellationManager>()
            .flags
            .lock()
            .map_err(|_| anyhow::anyhow!("provider run state is unavailable"))?
            .get(&bound.session_id)
            .filter(|control| {
                control
                    .capability_context
                    .lock()
                    .ok()
                    .is_some_and(|context| {
                        context
                            .as_ref()
                            .is_some_and(|context| context.turn_id == bound.turn_id)
                    })
            })
            .map(|control| control.cancellation.clone())
            .ok_or_else(|| anyhow::anyhow!("provider run is no longer active"))?;
        terminal_wait::wait(timeout, &cancellation, || {
            let terminals = resources
                .terminals
                .lock()
                .map_err(|_| anyhow::anyhow!("terminal capability state is unavailable"))?;
            if !terminals.get(&bound.session_id).is_some_and(|current| {
                current.resource_id == owned.resource_id
                    && current.workspace_key == bound.workspace_key
            }) {
                anyhow::bail!("terminal resource ownership changed");
            }
            app.state::<TerminalProcessManager>()
                .read(&owned.pane_id, None)
        })?
    } else if request.capability_id == CapabilityId::TerminalRead {
        app.state::<TerminalProcessManager>()
            .read(&owned.pane_id, None)?
    } else {
        let snapshot = app.state::<TerminalProcessManager>().stop(&owned.pane_id)?;
        resources
            .terminals
            .lock()
            .ok()
            .map(|mut terminals| terminals.remove(&bound.session_id));
        snapshot
    };
    let resource = CapabilityResourceRef {
        id: owned.resource_id,
        kind: "terminal".into(),
        label: snapshot.title.clone(),
    };
    Ok((
        if request.capability_id == CapabilityId::TerminalWait {
            if snapshot.status == "running" {
                "Command is still running; wait again to continue when it finishes".into()
            } else {
                format!(
                    "Command finished (exit code {}); inspect the output and continue",
                    snapshot
                        .exit_code
                        .map_or("unknown".into(), |code| code.to_string())
                )
            }
        } else if request.capability_id == CapabilityId::TerminalRead {
            "Read model terminal output".into()
        } else {
            "Stopped model terminal".into()
        },
        serde_json::json!({
            "completed": snapshot.status != "running",
            "exitCode": snapshot.exit_code,
            "pane": snapshot,
            "owner": {
                "kind": "model",
                "sessionId": owned.session_id,
                "turnId": owned.turn_id,
                "callId": owned.call_id,
            }
        }),
        Some(resource),
    ))
}
