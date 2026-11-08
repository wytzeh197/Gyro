//! Native CLI arguments, supplied with the host's current catalog and tool policy.
use super::types::ChatMode;
/// Claude Code tools that bypass a Gyro surface or cannot work in a `--print`
/// run, so Claude uses Gyro's governed equivalent instead.
/// - Agent/Task: delegation goes through Gyro's agent tools.
/// - Artifact*, DesignSync: publish to claude.ai instead of Gyro Canvas or
///   Browser; a design asked for in a Gyro chat ended up as an external link.
/// - Schedule/cron/remote/notification tools: the process exits with the
///   reply, so a scheduled wakeup or trigger would never come back to the chat.
/// - Cross-session messaging and worktree switching: they act outside the
///   chat's bound workspace and session.
pub const CLAUDE_DISALLOWED_NATIVE_TOOLS: &str = "Agent,Task,\
Artifact,ArtifactComments,ArtifactData,DesignSync,\
ScheduleWakeup,CronCreate,CronDelete,CronList,RemoteTrigger,PushNotification,\
ListAgents,SendMessage,SendToProject,SendToProjectContext,\
EnterWorktree,ExitWorktree";

#[allow(clippy::too_many_arguments)]
pub fn claude_chat_args(
    resume_session_id: Option<&str>,
    session_id: &str,
    model_id: Option<&str>,
    reasoning_effort: Option<&str>,
    mode: &ChatMode,
    require_command_approval: bool,
    require_file_edit_approval: bool,
    full_access: bool,
    permission_mcp_config: Option<&str>,
    prompt: &str,
    capability_tools: String,
    model_efforts: Option<&[String]>,
) -> Vec<String> {
    let mut args = vec![
        "--print".into(),
        "--output-format".into(),
        "stream-json".into(),
        // `--print --output-format stream-json` is rejected without `--verbose`.
        "--verbose".into(),
        "--include-partial-messages".into(),
    ];
    if let Some(resume_session_id) = resume_session_id {
        args.push("--resume".into());
        args.push(resume_session_id.into());
    } else {
        args.push("--session-id".into());
        args.push(session_id.into());
    }
    if let Some(model) = model_id.map(str::trim).filter(|model| !model.is_empty()) {
        args.push("--model".into());
        args.push(claude_model_arg(model));
    }
    if let Some(effort) = claude_reasoning_effort_arg(model_id, reasoning_effort, model_efforts) {
        args.push("--effort".into());
        args.push(effort);
    }
    args.extend([
        "--disallowedTools".into(),
        CLAUDE_DISALLOWED_NATIVE_TOOLS.into(),
    ]);
    if let Some(permission_mcp_config) = permission_mcp_config {
        args.extend([
            "--setting-sources".into(),
            "".into(),
            "--mcp-config".into(),
            permission_mcp_config.into(),
            "--strict-mcp-config".into(),
        ]);
    }
    let posture = crate::approval_posture(
        full_access,
        require_command_approval,
        require_file_edit_approval,
    );
    if matches!(mode, ChatMode::Plan | ChatMode::Council) {
        // Plan and Council are non-mutating. Council is stricter at the Gyro
        // capability gate (deny-all); Claude plan mode is the closest CLI knob.
        args.push("--permission-mode".into());
        args.push("plan".into());
        if !capability_tools.is_empty() {
            args.push("--allowedTools".into());
            args.push(capability_tools);
        }
    } else if permission_mcp_config.is_some() && posture != crate::ApprovalPosture::FullAccess {
        // Ask is `manual`. Approve for me is `auto`: Claude lets the safe set
        // through and asks Gyro about the rest.
        args.extend([
            "--permission-prompt-tool".into(),
            "mcp__gyro_approval__approve".into(),
            "--allowedTools".into(),
            format!("mcp__gyro_approval__approve,{capability_tools}"),
            "--permission-mode".into(),
            crate::claude_permission_mode(posture).into(),
        ]);
    } else if posture == crate::ApprovalPosture::FullAccess {
        args.push("--dangerously-skip-permissions".into());
        args.push("--allowedTools".into());
        args.push(capability_tools);
    }
    // `claude --allowedTools <tools...>` is variadic. Without an option
    // terminator, Commander consumes the chat prompt as another tool name and
    // the CLI exits with "Input must be provided either through stdin or as a
    // prompt argument when using --print".
    args.push("--".into());
    args.push(prompt.into());
    args
}

/// The `claude --model` value for a picker id.
///
/// Claude Code runs a bare Opus id at 200K and selects the 1M window with a
/// `[1m]` suffix. Catalog ids cannot contain brackets (shipped pickers reject
/// the whole document), so the 1M rows are spelled `<model>-1m` and rewritten
/// here.
pub fn claude_model_arg(model_id: &str) -> String {
    match model_id.strip_suffix("-1m") {
        Some(base) if base.starts_with("claude-") => format!("{base}[1m]"),
        _ => model_id.to_string(),
    }
}

/// The `claude --effort <level>` value supported by the selected model.
/// Haiku 4.5 has no effort parameter; the CLI accepting a word is insufficient.
pub fn claude_reasoning_effort_arg(
    model_id: Option<&str>,
    reasoning_effort: Option<&str>,
    model_efforts: Option<&[String]>,
) -> Option<String> {
    let effort = reasoning_effort?.trim().to_ascii_lowercase();
    if let Some(efforts) = model_efforts {
        return efforts.contains(&effort).then_some(effort);
    }
    if model_id.map(str::trim) == Some("claude-haiku-4-5") {
        return None;
    }
    matches!(effort.as_str(), "low" | "medium" | "high" | "xhigh" | "max").then_some(effort)
}

/// The `grok --reasoning-effort <level>` value for a requested reasoning effort.
///
/// Grok 4.5 publishes `low`, `medium`, and `high`. Grok 4.3, 4.6, 4.7, and
/// 4.7 Fast also publish `xhigh`. The flag parser accepts still more words,
/// but the model rejects them once the turn starts, so unsupported levels are
/// dropped here and Grok keeps its own default.
pub fn grok_reasoning_effort_arg(
    model_id: Option<&str>,
    reasoning_effort: Option<&str>,
    model_efforts: Option<&[String]>,
) -> Option<String> {
    let effort = reasoning_effort?.trim().to_ascii_lowercase();
    if let Some(efforts) = model_efforts {
        return efforts.contains(&effort).then_some(effort);
    }
    crate::grok::reasoning_effort_arg(model_id, Some(effort.as_str()))
}
/// Build Grok ACP spawn args with model/effort at process start.
pub fn build_grok_acp_program_args(
    model_id: Option<&str>,
    reasoning_effort: Option<&str>,
    posture: crate::ApprovalPosture,
    model_efforts: Option<&[String]>,
) -> Vec<std::ffi::OsString> {
    let effort = grok_reasoning_effort_arg(model_id, reasoning_effort, model_efforts);
    crate::grok::format_acp_program_args(model_id, effort.as_deref(), posture)
}
