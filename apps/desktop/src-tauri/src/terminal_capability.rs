//! Model-owned terminal observations and lifecycle operations.
use super::*;
use serde_json::{json, Value};

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
        let context = manager
            .by_workspace
            .lock()
            .map_err(|_| anyhow::anyhow!("IDE evidence state is unavailable"))?
            .get(&bound.workspace_key)
            .cloned()
            .unwrap_or_else(|| bound.workspace_context.clone());
        context
            .active_output
            .ok_or_else(|| anyhow::anyhow!("Workspace has no active task or test output"))?
    };
    let data = if output["lines"].is_array() {
        capability_output_budget::array_page(output, "lines", arguments, 20, 1000)?
    } else {
        bound_command_result(output, arguments)?
    };
    Ok(("Read Workspace output".into(), data, None))
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
                current.resource_id == owned.resource_id
                    && current.workspace_key == bound.workspace_key
            }) {
                anyhow::bail!("terminal resource ownership changed");
            }
            app.state::<TerminalProcessManager>()
                .observe(&owned.pane_id, include_output)
        })?
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
    data: serde_json::Value,
    arguments: &serde_json::Value,
) -> anyhow::Result<serde_json::Value> {
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
        let _measure=timing::EfficiencyTimer::start(timing::EfficiencyComponent::StructuredEvidence);
        if let Some(evidence) = gyro_core::efficiency::evidence::parse(data["stdout"].as_str().unwrap_or_default(), data["stderr"].as_str().unwrap_or_default(), data["exitCode"].as_i64()) {
            let summary = serde_json::to_value(&evidence)?;
            // Preserve the existing byte contract and fall back to raw windows for large/partial summaries.
            if serde_json::to_vec(&summary)?.len() < workspace_result_byte_limit(arguments)? / 2 {
                data["evidenceSummary"] = summary;
                if evidence.coverage == "complete" && !data["sourceTruncated"].as_bool().unwrap_or(false) && arguments.get("stdoutOffset").is_none() && arguments.get("stderrOffset").is_none() {
                    let total_chars = data["stdout"].as_str().unwrap_or_default().chars().count();
                    data["stdout"] = json!(""); data["rawOutput"] = json!({"available":true,"outputId":data["id"],"stdoutChars":total_chars,"retrieve":"Use read_output with outputId and stdoutOffset: 0"});
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
