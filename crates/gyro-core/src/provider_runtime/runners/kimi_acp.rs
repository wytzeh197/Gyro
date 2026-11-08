use crate::provider_runtime::{
    host::{
        emit_provider_activity_event, emit_provider_chat_event, emit_provider_context_usage,
        RunnerHost,
    },
    limits::{MAX_CHAT_IMAGE_BYTES, PROVIDER_CHAT_MAX_RUNTIME_SECS},
    native_args::build_grok_acp_program_args,
    support::{
        load_config_blocking, provider_billed_usage_from_acp_tokens, provider_chat_cwd,
        provider_output_summary, sanitize_provider_approval_details,
    },
    types::{
        ChatMode, PromptTurn, ProviderActivity, ProviderApprovalDecision, ProviderChatRequest,
        ProviderContextUsage, ProviderResumeCursor, ProviderRunAttempt, ProviderRunnerOutput,
    },
};
use crate::{
    apply_provider_mutation_transaction_with_cancellation, run_kimi_acp, CredentialPolicy,
    HarnessRunStatus, KimiAcpApprovalDecision, KimiAcpApprovalKind, KimiAcpMode, KimiAcpRequest,
    PreparedProviderMutationTransaction, ProviderSessionBinding,
};
use anyhow::Context;
use base64::Engine;
use std::{
    fs,
    path::Path,
    sync::{atomic::AtomicBool, Arc, Mutex},
    time::Duration,
};
#[derive(Clone, Copy)]
pub struct AcpProviderRuntime {
    pub label: &'static str,
    pub program: &'static str,
    pub args: &'static [&'static str],
    pub auth_methods: &'static [&'static str],
    pub cursor_kind: &'static str,
    pub default_model: &'static str,
    pub runner: &'static str,
}

pub fn acp_provider_runtime(provider_id: &str) -> Option<AcpProviderRuntime> {
    match provider_id {
        "kimi" => Some(AcpProviderRuntime {
            label: "Kimi",
            program: "kimi",
            args: &["acp"],
            auth_methods: &["login"],
            cursor_kind: "kimi-acp-session",
            default_model: "k3",
            runner: "kimi-acp",
        }),
        "xai" => Some(AcpProviderRuntime {
            label: "xAI",
            program: "grok",
            // Grok ACP agent entry: --no-leader keeps Grok in ACP
            // client mode. Model/effort are appended dynamically when set.
            args: &[
                "--no-auto-update",
                "--permission-mode",
                "default",
                "agent",
                "--no-leader",
                "stdio",
            ],
            auth_methods: &["xai.api_key", "cached_token"],
            cursor_kind: "xai-acp-session",
            default_model: "grok-4.7",
            runner: "grok-acp",
        }),
        "gemini" => Some(AcpProviderRuntime {
            label: "Gemini",
            program: "gemini",
            args: &["--acp"],
            auth_methods: &["oauth-personal", "gemini-api-key", "vertex-ai", "login"],
            cursor_kind: "gemini-acp-session",
            default_model: "gemini-default",
            runner: "gemini-acp",
        }),
        "cursor" => Some(AcpProviderRuntime {
            label: "Cursor",
            args: &["acp"],
            auth_methods: &["cursor_login"],
            cursor_kind: "cursor-acp-session",
            default_model: "cursor-default",
            program: "cursor-agent",
            runner: "cursor-acp",
        }),
        "opencode" => Some(AcpProviderRuntime {
            label: "OpenCode",
            args: &["acp"],
            auth_methods: &["opencode-login"],
            cursor_kind: "opencode-acp-session",
            default_model: "opencode-default",
            program: "opencode",
            runner: "opencode-acp",
        }),
        _ => None,
    }
}

pub fn acp_auth_methods(runtime: AcpProviderRuntime) -> Vec<String> {
    let mut methods = runtime
        .auth_methods
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    if runtime.program == "grok" {
        let preferred = if crate::provider_has_api_key("xai") {
            "xai.api_key"
        } else {
            "cached_token"
        };
        methods.sort_by_key(|method| usize::from(method != preferred));
    } else if runtime.program == "gemini" {
        let preferred = if crate::provider_has_api_key("gemini") {
            Some("gemini-api-key")
        } else if std::env::var_os("GOOGLE_GENAI_USE_VERTEXAI").is_some()
            || std::env::var_os("GOOGLE_APPLICATION_CREDENTIALS").is_some()
        {
            Some("vertex-ai")
        } else {
            None
        };
        if let Some(preferred) = preferred {
            methods.sort_by_key(|method| usize::from(method != preferred));
        }
    }
    methods
}

pub fn apply_acp_workspace_write(
    workspace: &Path,
    target: &Path,
    content: &str,
    plan_mode: bool,
    require_approval: bool,
    cancellation: &crate::CancellationToken,
    approve: impl FnOnce(
        PreparedProviderMutationTransaction,
        serde_json::Value,
    ) -> anyhow::Result<ProviderApprovalDecision>,
) -> anyhow::Result<()> {
    if plan_mode {
        anyhow::bail!("ACP file writes are disabled in plan mode");
    }
    let (transaction, details) =
        crate::mutations::prepare_provider_text_replacement_review(workspace, target, content)?;
    if require_approval {
        // The resolver applies the exact reviewed transaction. Never reuse a
        // previous ACP permission grant or apply a committed transaction twice.
        if approve(transaction, details)? != ProviderApprovalDecision::AppliedByGyro {
            anyhow::bail!("ACP workspace write was not approved and applied");
        }
    } else {
        apply_provider_mutation_transaction_with_cancellation(&transaction, || {
            cancellation.is_cancelled()
        })?;
    }
    Ok(())
}

pub fn run_kimi_acp_chat(
    host: &dyn RunnerHost,
    request: &ProviderChatRequest,
    resume_cursor: Option<&ProviderResumeCursor>,
    attempt: &mut ProviderRunAttempt,
) -> anyhow::Result<ProviderRunnerOutput> {
    let runtime = acp_provider_runtime(&request.provider_id)
        .ok_or_else(|| anyhow::anyhow!("{} does not have an ACP runtime", request.provider_id))?;
    let provider_label = request.provider_label.as_deref().unwrap_or(runtime.label);
    let workspace = provider_chat_cwd(request.workspace_path.as_deref())?;
    let cancellation = host.cancellation(&request.session_id)?;
    let mut prompt = vec![serde_json::json!({
        "type": "text",
        "text": host.context_message(request, None, PromptTurn::default()),
    })];
    for attachment in &request.attachments {
        if attachment.kind == "image" {
            let bytes = fs::read(&attachment.path)
                .with_context(|| format!("read image attachment {}", attachment.name))?;
            if bytes.len() > MAX_CHAT_IMAGE_BYTES as usize {
                anyhow::bail!("{} exceeds the image attachment limit", attachment.name);
            }
            prompt.push(serde_json::json!({
                "type": "image",
                "data": base64::engine::general_purpose::STANDARD.encode(bytes),
                "mimeType": attachment.mime_type.as_deref().unwrap_or("application/octet-stream"),
            }));
        } else if attachment.kind == "workspace-file" {
            let content = fs::read_to_string(&attachment.path)
                .with_context(|| format!("read workspace attachment {}", attachment.name))?;
            prompt.push(serde_json::json!({
                "type": "resource",
                "resource": {
                    "uri": format!("file://{}", attachment.path),
                    "mimeType": attachment.mime_type.as_deref().unwrap_or("text/plain"),
                    "text": content,
                },
            }));
        }
    }

    // Give ACP agents the same Gyro capability tools the Claude and Codex
    // adapters get. A missing capability bind used to drop the MCP server and
    // leave Grok/Kimi/Gemini with no Gyro tools for the whole turn.
    let mcp_servers = host.acp_mcp_servers(&request.session_id)?;

    let resume_session_id = resume_cursor
        .filter(|cursor| cursor.kind == runtime.cursor_kind)
        .map(|cursor| cursor.session_id.clone());
    // ACP may reject a saved cursor and open a fresh session. Pass both prompt
    // forms so the adapter can choose after it knows whether reopen succeeded.
    let resumed_prompt = resume_session_id.as_ref().map(|_| {
        host.context_message(
            request,
            None,
            PromptTurn {
                resumed: true,
                approvals_sent_separately: false,
            },
        )
    });
    // Always load the local transcript. Grok often cannot resume; model handoffs
    // also start a fresh agent session. Either way the local Gyro session is the
    // source of truth and must travel with the prompt when resume is unavailable.
    let conversation_history_text = host.acp_conversation_history(&request.session_id);

    let launched_model = if request.provider_id == "xai" {
        let speed_config = load_config_blocking().map_err(anyhow::Error::msg)?;
        crate::fast_mode::launch_model_id(&speed_config, "xai", request.model_id.as_deref())
    } else {
        None
    };
    let approval_posture = crate::approval_posture(
        request.full_access,
        request.require_command_approval,
        request.require_file_edit_approval,
    );
    let program_args = if request.provider_id == "xai" {
        build_grok_acp_program_args(
            launched_model.as_deref().or(request.model_id.as_deref()),
            request.reasoning_effort.as_deref(),
            approval_posture,
            host.reasoning_efforts(
                "xai",
                launched_model.as_deref().or(request.model_id.as_deref()),
            )
            .as_deref(),
        )
    } else if let Some(args) = crate::acp_permission_args(&request.provider_id, approval_posture) {
        args.iter().copied().map(Into::into).collect()
    } else {
        runtime.args.iter().map(Into::into).collect()
    };

    let activities = Arc::new(Mutex::new(Vec::<ProviderActivity>::new()));
    let activity_sink = activities.clone();
    let plan_mode = request.mode == ChatMode::Plan;
    let require_command_approval = request.require_command_approval;
    let require_file_approval = request.require_file_edit_approval;
    // Same quiet-period heartbeats as Claude/Codex so the desktop keeps the
    // turn marked live while ACP tools think without frames.
    let heartbeat_stop = Arc::new(AtomicBool::new(false));
    let heartbeat = host.start_heartbeat(
        request.clone(),
        cancellation.clone(),
        heartbeat_stop.clone(),
    );
    let opened_session = Arc::new(Mutex::new(None::<String>));
    let output = run_kimi_acp(
        KimiAcpRequest {
            opened_session: Some(opened_session.clone()),
            credentials: CredentialPolicy::for_provider(&request.provider_id),
            provider_label: provider_label.into(),
            program: runtime.program.into(),
            program_args,
            auth_method_ids: acp_auth_methods(runtime),
            workspace: workspace.clone(),
            prompt,
            resumed_prompt,
            conversation_history_text,
            mcp_servers,
            model: request
                .model_id
                .clone()
                .filter(|model| !(request.provider_id == "xai" && model == runtime.default_model))
                .unwrap_or_else(|| {
                    if request.provider_id == "xai" {
                        String::new()
                    } else {
                        runtime.default_model.into()
                    }
                }),
            reasoning_effort: request.reasoning_effort.clone(),
            mode: if plan_mode {
                KimiAcpMode::Plan
            } else {
                KimiAcpMode::Normal
            },
            // Full access answers permission requests inside the core, so a card
            // that cannot be shown can never become a declined tool.
            auto_allow_permissions: approval_posture == crate::ApprovalPosture::FullAccess,
            resume_session_id,
            // Wall clock is the 24h chat max, not the 30m quiet-period constant.
            // Mis-wiring both to inactivity killed healthy Grok/Kimi/Gemini turns
            // at half an hour even when the agent was still working.
            timeout: Duration::from_secs(PROVIDER_CHAT_MAX_RUNTIME_SECS),
            // Quiet tools produce no ACP frames for long stretches. Silence is
            // not completion — only max runtime and user cancel end the turn.
            // Frame-level inactivity is set to the same ceiling so it cannot
            // undercut the wall clock.
            inactivity_timeout: Duration::from_secs(PROVIDER_CHAT_MAX_RUNTIME_SECS),
            cancellation: cancellation.clone(),
        },
        |delta| {
            emit_provider_chat_event(
                host,
                request,
                "delta",
                Some(HarnessRunStatus::Running),
                Some(delta.to_string()),
                None,
                None,
            );
        },
        |activity| {
            if let Some(context) = activity.context_usage {
                emit_provider_context_usage(
                    host,
                    request,
                    &ProviderContextUsage {
                        input_tokens: Some(context.used),
                        total_tokens: Some(context.used),
                        // Zero means this frame did not name a window. Some(0)
                        // would stick and block the catalog fill.
                        model_context_window: (context.size > 0).then_some(context.size),
                        estimated: context.estimated,
                        ..ProviderContextUsage::default()
                    },
                );
                return;
            }
            let mut activity = ProviderActivity {
                id: activity.id.clone(),
                kind: activity.kind.clone(),
                label: activity.label.clone(),
                detail: activity.detail.clone(),
                file_counts: activity.file_counts,
                note: None,
                status: activity.status.clone(),
            };
            // The diff usually arrives on one frame; a later status-only
            // update must not erase the counts it carried.
            if activity.file_counts.is_none() {
                if let Ok(sink) = activity_sink.lock() {
                    activity.file_counts = sink
                        .iter()
                        .find(|item| item.id == activity.id)
                        .and_then(|item| item.file_counts);
                }
            }
            emit_provider_activity_event(host, request, &activity, None);
            // Upsert by id so intermediate tool_call_update frames replace the
            // prior status instead of stacking dozens of "running" rows that
            // then persist after end_turn (every ACP provider, not only Grok).
            if let Ok(mut sink) = activity_sink.lock() {
                if let Some(existing) = sink.iter_mut().find(|item| item.id == activity.id) {
                    *existing = activity;
                } else {
                    sink.push(activity);
                }
            }
        },
        |approval| {
            // File writes stay blocked. Commands do not: Grok treats a shell
            // reject_once as the user declining the tool and cancels the turn.
            if plan_mode && crate::plan_mode_denies_approval(approval.kind) {
                return Ok(KimiAcpApprovalDecision::RejectOnce);
            }
            let approval_type = match approval.kind {
                KimiAcpApprovalKind::Command => "command",
                KimiAcpApprovalKind::FileChange => "file-change",
                KimiAcpApprovalKind::Other => "permissions",
            };
            // Grok `auto` and Kimi `--yolo` already let the safe set through.
            // A request that still arrives is outside that set, so Approve for
            // me shows a card instead of allowing it silently. Full access
            // does not ask: those CLIs are started with the bypass flag.
            let escalation = approval_posture == crate::ApprovalPosture::ApproveForMe
                && crate::approve_for_me_keeps_escalations(&request.provider_id);
            let auto_allow = if escalation {
                false
            } else {
                match approval.kind {
                    KimiAcpApprovalKind::Command => !require_command_approval,
                    KimiAcpApprovalKind::FileChange => !require_file_approval,
                    KimiAcpApprovalKind::Other => {
                        !require_command_approval && !require_file_approval
                    }
                }
            };
            let allowed = if auto_allow {
                true
            } else {
                host.request_approval(
                    request,
                    approval_type,
                    sanitize_provider_approval_details(approval.tool_call.clone()),
                    None,
                )? != ProviderApprovalDecision::Reject
            };
            Ok(if allowed {
                KimiAcpApprovalDecision::AllowOnce
            } else {
                KimiAcpApprovalDecision::RejectOnce
            })
        },
        |target, content| {
            apply_acp_workspace_write(
                &workspace,
                target,
                content,
                plan_mode,
                require_file_approval,
                &cancellation,
                |transaction, details| {
                    host.request_approval(
                        request,
                        "file-change",
                        sanitize_provider_approval_details(details),
                        Some(transaction),
                    )
                },
            )
        },
    );
    // Stop heartbeats on every exit path so a finished ACP turn never keeps
    // emitting "still working" after completed/failed/cancelled.
    drop(heartbeat);
    // Recorded before the error is propagated, as for Claude: a turn stopped
    // after the agent opened its session can still be resumed next time.
    attempt.resume_cursor = opened_session
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
        .map(|session_id| ProviderResumeCursor {
            kind: runtime.cursor_kind.into(),
            session_id,
        });
    // The ACP client reports a stop as its own "run cancelled" error. Name it
    // the way every other runner does, or a stop is recorded as a failure and
    // offered a retry.
    let output = output.map_err(|error| {
        if cancellation.is_cancelled() {
            error.context(host.stop_message(&request.session_id))
        } else {
            error
        }
    })?;
    let activities = activities
        .lock()
        .map_err(|_| anyhow::anyhow!("{provider_label} activity state is unavailable"))?
        .clone();
    let response = crate::sanitize_harness_text(&output.response);
    Ok(ProviderRunnerOutput {
        accounted_usage: Some(output.usage_observation.tokens),
        activities,
        context_usage: output.context_usage.map(|context| ProviderContextUsage {
            input_tokens: Some(context.used),
            total_tokens: Some(context.used),
            // Zero means this frame did not name a window. Some(0)
            // would stick and block the catalog fill.
            model_context_window: (context.size > 0).then_some(context.size),
            estimated: context.estimated,
            ..ProviderContextUsage::default()
        }),
        billed_usage: provider_billed_usage_from_acp_tokens(output.usage_observation.tokens),
        // ACP publishes no plan limits, so Kimi, Gemini, and Grok report none.
        rate_limits: Vec::new(),
        paused_at_tool_budget: false,
        // An agent that ran out of room kept its streamed text: the turn is
        // done, but the answer is not finished, and the transcript says so.
        answer_cut_off: output.truncated,
        response: response.clone(),
        resume_cursor: Some(ProviderResumeCursor {
            kind: runtime.cursor_kind.into(),
            session_id: output.session_id.clone(),
        }),
        retry_count: 0,
        resumed: output.resumed,
        streamed_text: None,
        output_summary: Some(provider_output_summary(
            runtime.runner,
            &output.stop_reason,
            Some(&output.session_id),
            response.chars().count(),
        )),
    })
}

pub fn provider_resume_cursor_from_binding(
    binding: &ProviderSessionBinding,
) -> Option<ProviderResumeCursor> {
    serde_json::from_value::<ProviderResumeCursor>(binding.resume_cursor_json.clone()).ok()
}

/// A stored resume cursor is only usable when it was written for the same model
/// the user is sending with now. After a local model handoff the binding is
/// usually cleared already; this filter is the safety net for in-flight state.
pub fn compatible_provider_session_binding(
    binding: ProviderSessionBinding,
    request: &ProviderChatRequest,
) -> Option<ProviderSessionBinding> {
    if binding.provider_id != request.provider_id {
        return None;
    }
    match (&binding.model_id, &request.model_id) {
        (Some(bound), Some(wanted)) if bound != wanted => None,
        (Some(_), None) | (None, Some(_)) => None,
        _ => Some(binding),
    }
}
