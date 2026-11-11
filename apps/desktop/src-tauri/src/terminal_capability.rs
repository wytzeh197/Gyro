//! Model-owned terminal observations and lifecycle operations.
use crate::{
    capabilities::access::capability_argument_string,
    capability_output_budget,
    capability_workspace_helpers::workspace_result_byte_limit,
    efficiency,
    state::{
        managers::{
            CapabilityIdeEvidenceManager, ProviderCancellationManager,
            ProviderCapabilityResourceManager,
        },
        provider_run::BoundProviderCapabilityContext,
    },
    terminal::types::{TerminalPaneSnapshot, TerminalProcessManager},
    terminal_wait,
};
use gyro_core::{
    timing, CapabilityId, CapabilityRequest, CapabilityResourceRef, WorkspaceContextSnapshot,
};
use serde_json::{json, Value};
use std::{collections::VecDeque, sync::Mutex, time::Duration};
use tauri::Manager;

const RETAINED_OUTPUT_COUNT: usize = 16;
const RETAINED_OUTPUT_BYTES: usize = 16 * 1024 * 1024;

struct RetainedOutput {
    workspace: String,
    session_id: String,
    id: String,
    bytes: usize,
    data: Value,
}

#[derive(Default)]
pub(super) struct RetainedTaskOutputs {
    entries: Mutex<VecDeque<RetainedOutput>>,
}

impl RetainedTaskOutputs {
    pub(super) fn remember(&self, workspace: &str, session_id: &str, data: Value) {
        let Some(id) = data["id"].as_str().map(str::to_owned) else {
            return;
        };
        let Ok(bytes) = serde_json::to_vec(&data).map(|encoded| encoded.len()) else {
            return;
        };
        if bytes > RETAINED_OUTPUT_BYTES {
            return;
        }
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        entries.retain(|entry| entry.workspace != workspace || entry.id != id);
        while entries.len() >= RETAINED_OUTPUT_COUNT
            || entries.iter().map(|entry| entry.bytes).sum::<usize>() + bytes
                > RETAINED_OUTPUT_BYTES
        {
            entries.pop_front();
        }
        entries.push_back(RetainedOutput {
            workspace: workspace.into(),
            session_id: session_id.into(),
            id,
            bytes,
            data,
        });
    }

    pub(super) fn get(&self, workspace: &str, session_id: Option<&str>, id: &str) -> Option<Value> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .find(|entry| {
                entry.workspace == workspace
                    && entry.id == id
                    && session_id.is_none_or(|session| entry.session_id == session)
            })
            .map(|entry| entry.data.clone())
    }

    pub(super) fn restore_context(&self, workspace: &str, context: &mut WorkspaceContextSnapshot) {
        let retained = context
            .active_output
            .as_ref()
            .and_then(|output| output["id"].as_str())
            .and_then(|id| self.get(workspace, None, id));
        if let Some(retained) = retained {
            context.active_output = Some(retained);
        }
    }
}

pub(super) fn live_output_result(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    id: &str,
    fallback: &Value,
) -> Value {
    app.state::<CapabilityIdeEvidenceManager>()
        .task_outputs
        .get(&bound.workspace_key, Some(&bound.session_id), id)
        .unwrap_or_else(|| fallback.clone())
}

pub(super) fn read_workspace_output(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    arguments: &Value,
) -> anyhow::Result<(String, Value, Option<CapabilityResourceRef>)> {
    workspace_result_byte_limit(arguments)?;
    let manager = app.state::<CapabilityIdeEvidenceManager>();
    let output = if arguments.get("outputId").is_some() {
        let id = capability_argument_string(arguments, "outputId")?;
        manager
            .task_outputs
            .get(&bound.workspace_key, Some(&bound.session_id), id)
            .ok_or_else(|| anyhow::anyhow!("Requested output is not retained for this chat"))?
    } else {
        // Only the active output channel is needed, so borrow the snapshot
        // instead of copying every open buffer out of the cache.
        let evidence = manager
            .evidence
            .lock()
            .map_err(|_| anyhow::anyhow!("IDE evidence state is unavailable"))?;
        match evidence.get(&bound.workspace_key) {
            Some(context) => context.active_output.clone(),
            None => bound.workspace_context.active_output.clone(),
        }
        .ok_or_else(|| anyhow::anyhow!("Workspace has no active task or test output"))?
    };
    let data = if output["lines"].is_array() {
        capability_output_budget::array_page(output, "lines", arguments, 20, 1000)?
    } else {
        bound_command_result(output, arguments)?
    };
    Ok(("Read Workspace output".into(), data, None))
}

/// Observe the exact command that was started, including its final PTY drain.
/// Both the short initial yield and explicit waits use the same ownership and
/// cancellation checks. No process/resource lock is held while sleeping.
pub(super) fn wait_for_command(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    resource_id: &str,
    timeout: Duration,
) -> anyhow::Result<TerminalPaneSnapshot> {
    let resources = app.state::<ProviderCapabilityResourceManager>();
    let owned = resources
        .terminals
        .lock()
        .map_err(|_| anyhow::anyhow!("terminal capability state is unavailable"))?
        .get(&bound.session_id)
        .filter(|owned| {
            owned.resource_id == resource_id
                && owned.workspace_key == bound.workspace_key
                && owned.session_id == bound.session_id
        })
        .cloned()
        .ok_or_else(|| {
            anyhow::anyhow!(
                "terminal resource ownership changed; do not wait on a replacement command"
            )
        })?;
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
    terminal_wait::wait(timeout, &cancellation, |include_output| {
        let terminals = resources
            .terminals
            .lock()
            .map_err(|_| anyhow::anyhow!("terminal capability state is unavailable"))?;
        if !terminals.get(&bound.session_id).is_some_and(|current| {
            current.resource_id == owned.resource_id && current.workspace_key == bound.workspace_key
        }) {
            anyhow::bail!("terminal resource ownership changed");
        }
        app.state::<TerminalProcessManager>()
            .observe(&owned.pane_id, include_output)
    })
}

pub(super) fn execute(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    request: &CapabilityRequest,
) -> anyhow::Result<(String, serde_json::Value, Option<CapabilityResourceRef>)> {
    let arguments = &request.arguments;
    workspace_result_byte_limit(arguments)?;
    capability_output_budget::offset(arguments, "outputOffset")?;
    let known_revision = if arguments.get("outputOffset").is_some() {
        None
    } else {
        capability_output_budget::offset(arguments, "knownOutputRevision")?
            .map(|value| value as u64)
    };
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
    let mut snapshot = if request.capability_id == CapabilityId::TerminalWait {
        let resource_id = capability_argument_string(arguments, "resourceId")?;
        if resource_id != owned.resource_id {
            anyhow::bail!(
                "terminal resource ownership changed; do not wait on a replacement command"
            );
        }
        let timeout = terminal_wait::timeout(arguments)?;
        wait_for_command(app, bound, resource_id, timeout)?
    } else if request.capability_id == CapabilityId::TerminalRead {
        app.state::<TerminalProcessManager>()
            .read(&owned.pane_id, known_revision)?
    } else {
        let snapshot = app.state::<TerminalProcessManager>().stop(&owned.pane_id)?;
        resources
            .terminals
            .lock()
            .ok()
            .map(|mut terminals| terminals.remove(&bound.session_id));
        snapshot
    };
    if known_revision == Some(snapshot.output_revision) {
        snapshot.output = None;
    }
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
        bound_terminal_result(
            serde_json::json!({
                "completed": snapshot.status != "running",
                "exitCode": snapshot.exit_code,
                "pane": snapshot,
                "stoppedBy": if request.capability_id == CapabilityId::TerminalStop {
                    serde_json::Value::from("model")
                } else {
                    serde_json::Value::Null
                },
                "owner": {
                    "kind": "model",
                    "sessionId": owned.session_id,
                    "turnId": owned.turn_id,
                    "callId": owned.call_id,
                }
            }),
            arguments,
        )?,
        Some(resource),
    ))
}

pub(super) fn bound_terminal_result(
    mut data: serde_json::Value,
    arguments: &serde_json::Value,
) -> anyhow::Result<serde_json::Value> {
    // The model already sent the command. Replaying it on open/read/wait/stop
    // grows provider history and can exhaust the result budget before any
    // output fits. Strip only duplicated input and pane presentation fields
    // from this model-facing copy; the terminal's backing snapshot is intact.
    if let Some(pane) = data
        .get_mut("pane")
        .and_then(serde_json::Value::as_object_mut)
    {
        for field in ["command", "cols", "rows", "profileId", "title"] {
            pane.remove(field);
        }
    }
    capability_output_budget::text_result(
        data,
        &[capability_output_budget::TextField {
            pointer: "/pane/output",
            window: "outputWindow",
            offset: "outputOffset",
            tail: true,
        }],
        arguments,
    )
}

pub(super) fn bound_command_result(
    mut data: serde_json::Value,
    arguments: &serde_json::Value,
) -> anyhow::Result<serde_json::Value> {
    if efficiency::config().policies() && efficiency::config().structured_evidence {
        let _measure =
            timing::EfficiencyTimer::start(timing::EfficiencyComponent::StructuredEvidence);
        if let Some(evidence) = gyro_core::efficiency::evidence::parse(
            data["stdout"].as_str().unwrap_or_default(),
            data["stderr"].as_str().unwrap_or_default(),
            data["exitCode"].as_i64(),
        ) {
            let summary = serde_json::to_value(&evidence)?;
            // Preserve the existing byte contract and fall back to raw windows for large/partial summaries.
            if serde_json::to_vec(&summary)?.len() < workspace_result_byte_limit(arguments)? / 2 {
                data["evidenceSummary"] = summary;
                if evidence.coverage == "complete"
                    && !data["sourceTruncated"].as_bool().unwrap_or(false)
                    && arguments.get("stdoutOffset").is_none()
                    && arguments.get("stderrOffset").is_none()
                {
                    let total_chars = data["stdout"].as_str().unwrap_or_default().chars().count();
                    data["stdout"] = json!("");
                    data["rawOutput"] = json!({"available":true,"outputId":data["id"],"stdoutChars":total_chars,"retrieve":"Use read_output with outputId and stdoutOffset: 0"});
                }
            }
        }
    }
    capability_output_budget::text_result(
        data,
        &[
            capability_output_budget::TextField {
                pointer: "/stdout",
                window: "stdoutWindow",
                offset: "stdoutOffset",
                tail: true,
            },
            capability_output_budget::TextField {
                pointer: "/stderr",
                window: "stderrWindow",
                offset: "stderrOffset",
                tail: true,
            },
        ],
        arguments,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_replies_are_compact_on_api_and_mcp_for_every_operation() {
        use gyro_core::{CapabilityResponse, CapabilityResult, GyroPaths};
        let paths = GyroPaths::from_base_dir(std::env::temp_dir().join("gyro-terminal-wire-test"));
        for id in [
            CapabilityId::TerminalOpen,
            CapabilityId::TerminalRead,
            CapabilityId::TerminalWait,
            CapabilityId::TerminalStop,
        ] {
            let data = bound_terminal_result(json!({
                "completed":true, "exitCode":1,
                "pane":{"command":"script ".repeat(8000), "output":format!("{}FINAL FAILURE", "log\n".repeat(3000)),
                    "outputRevision":17, "status":"done", "exitCode":1}
            }), &json!({})).unwrap();
            let response = CapabilityResponse::completed(
                "test",
                CapabilityResult {
                    call_id: uuid::Uuid::new_v4(),
                    capability_id: id,
                    summary: "Command finished".into(),
                    data,
                    resource: None,
                },
            );
            let api: serde_json::Value = serde_json::from_str(
                &gyro_core::provider_runtime::tool_batch::model_response_text(&response).unwrap(),
            )
            .unwrap();
            let mcp =
                crate::capabilities::mcp_server::capability_mcp_response(&paths, response, false)
                    .unwrap();
            let native: serde_json::Value =
                serde_json::from_str(mcp["content"][0]["text"].as_str().unwrap()).unwrap();
            for actual in [&api["result"]["data"], &native["data"]] {
                let output = actual["pane"]["output"].as_str().unwrap();
                assert!(output.len() < 2400 && output.contains("spill://"));
                assert!(output.ends_with("FINAL FAILURE"));
                assert!(actual["pane"].get("command").is_none());
                assert_eq!(actual["exitCode"], 1);
                assert_eq!(actual["pane"]["outputRevision"], 17);
                assert!(actual["outputWindow"].is_object());
            }
        }
    }

    #[test]
    fn terminal_reply_does_not_replay_command_or_pane_chrome() {
        let snapshot = json!({
            "completed": true, "exitCode": 1,
            "owner": {"kind": "model", "sessionId": "session"},
            "pane": {
                "command": format!("python3 -c '{}'", "script body ".repeat(4000)),
                "cols": 120, "rows": 32, "profileId": null, "title": "Model · python3",
                "output": "FAILED: exact diagnostic 🦀\n", "outputRevision": 42,
                "outputComplete": true, "status": "done", "exitCode": 1,
                "workingDirectory": "/workspace", "paneId": "model:session",
                "hasForegroundJob": false
            }
        });
        let bounded = bound_terminal_result(snapshot.clone(), &json!({})).unwrap();
        for field in ["command", "cols", "rows", "profileId", "title"] {
            assert!(bounded["pane"].get(field).is_none(), "{field}");
        }
        for field in [
            "output",
            "outputRevision",
            "outputComplete",
            "status",
            "exitCode",
            "workingDirectory",
            "paneId",
            "hasForegroundJob",
        ] {
            assert_eq!(bounded["pane"][field], snapshot["pane"][field], "{field}");
        }
        assert_eq!(bounded["owner"], snapshot["owner"]);
        assert_eq!(bounded["completed"], true);
        assert_eq!(bounded["exitCode"], 1);
        assert_eq!(bounded["outputWindow"]["truncated"], false);
        let before = serde_json::to_vec(&snapshot).unwrap().len();
        let after = serde_json::to_vec(&bounded).unwrap().len();
        println!("terminal command fixture: {before} -> {after} serialized bytes");
        assert!(after * 20 < before);
        assert!(snapshot["pane"]["command"].as_str().unwrap().len() > 40_000);
    }

    #[test]
    fn terminal_reply_keeps_output_pages_recoverable() {
        let output = "🦀 exact line\n".repeat(1000);
        let snapshot = json!({
            "pane": {"command": "large command ".repeat(4000), "output": output,
                "outputRevision": 7, "status": "done", "exitCode": 0},
            "completed": true, "exitCode": 0
        });
        let tail = bound_terminal_result(snapshot.clone(), &json!({"maxBytes": 2048})).unwrap();
        assert_eq!(tail["outputWindow"]["truncated"], true);
        assert!(tail["outputWindow"]["previousOffset"].is_number());
        let mut offset = 0;
        let mut restored = String::new();
        loop {
            let page = bound_terminal_result(
                snapshot.clone(),
                &json!({"maxBytes": 2048, "outputOffset": offset}),
            )
            .unwrap();
            restored.push_str(page["pane"]["output"].as_str().unwrap());
            assert_eq!(page["pane"]["outputRevision"], 7);
            let Some(next) = page["outputWindow"]["nextOffset"].as_u64() else {
                break;
            };
            assert!(next > offset);
            offset = next;
        }
        assert_eq!(restored, output);
    }

    #[test]
    fn clipped_ui_refresh_keeps_full_output_and_other_channels_untouched() {
        let cache = RetainedTaskOutputs::default();
        let full = json!({"id":"output:owner:test","taskId":"test","status":"failed","stdout":"🦀 exact line\n".repeat(20_000),"stderr":"FINAL FAILURE"});
        cache.remember("workspace", "owner", full.clone());
        let mut context = WorkspaceContextSnapshot::empty("workspace");
        context.active_output = Some(
            json!({"id":"output:owner:test","lines":["🦀 clipped preview"],"label":"Test output"}),
        );
        cache.restore_context("workspace", &mut context);
        assert_eq!(context.active_output.as_ref().unwrap(), &full);
        let page = bound_command_result(
            context.active_output.clone().unwrap(),
            &json!({"stdoutOffset":0}),
        )
        .unwrap();
        assert!(page["stdoutWindow"]["nextOffset"].as_u64().unwrap() > 0);
        assert_eq!(
            cache.get("workspace", Some("owner"), "output:owner:test"),
            Some(full)
        );
        assert!(cache
            .get("workspace", Some("another-session"), "output:owner:test")
            .is_none());
        assert!(cache
            .get("another-workspace", Some("owner"), "output:owner:test")
            .is_none());
        let other = json!({"id":"user-selected-channel","lines":["Other output"]});
        context.active_output = Some(other.clone());
        cache.restore_context("workspace", &mut context);
        assert_eq!(context.active_output, Some(other));
    }

    #[test]
    fn output_cache_evicts_old_entries_by_count_and_total_bytes() {
        let cache = RetainedTaskOutputs::default();
        for index in 0..RETAINED_OUTPUT_COUNT + 1 {
            cache.remember(
                "workspace",
                "owner",
                json!({"id":format!("output-{index}"),"stdout":"done"}),
            );
        }
        assert!(cache.get("workspace", Some("owner"), "output-0").is_none());
        assert!(cache.get("workspace", Some("owner"), "output-16").is_some());
        let cache = RetainedTaskOutputs::default();
        for index in 0..3 {
            cache.remember(
                "workspace",
                "owner",
                json!({"id":format!("large-{index}"),"stdout":"x".repeat(RETAINED_OUTPUT_BYTES/2)}),
            );
        }
        assert!(cache.get("workspace", Some("owner"), "large-0").is_none());
        assert!(cache.get("workspace", Some("owner"), "large-2").is_some());
        let entries = cache.entries.lock().unwrap();
        assert!(entries.iter().map(|entry| entry.bytes).sum::<usize>() <= RETAINED_OUTPUT_BYTES);
    }
}
