//! What one automation run needs: its workspace, its provider, its prompt, and
//! the stop-condition verdict parsed from the provider's reply.

use crate::text::truncate_chars;
use gyro_core::{create_worktree, Automation, GyroPaths, SessionWorkspaceMode};
use serde::Deserialize;
use std::path::PathBuf;

pub(crate) const AUTOMATION_RESULT_MARKER_PREFIX: &str = "<!-- gyro-automation-result:";

pub(crate) const AUTOMATION_RESULT_MARKER_SUFFIX: &str = "-->";

pub(crate) fn resolve_automation_workspace(
    paths: &GyroPaths,
    automation: &Automation,
) -> Result<PathBuf, String> {
    let source = automation
        .execution
        .workspace_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "configuration: choose a workspace for this automation".to_string())?;
    let source = PathBuf::from(source).canonicalize().map_err(|_| {
        "configuration: the automation workspace is no longer available".to_string()
    })?;
    if !source.is_dir() {
        return Err("configuration: the automation workspace is not a folder".into());
    }
    if automation.workspace_mode == SessionWorkspaceMode::Local {
        return Ok(source);
    }

    let worktree_name = automation
        .worktree_name
        .as_deref()
        .ok_or_else(|| "configuration: the automation has no worktree name".to_string())?;
    let expected = paths.worktrees_dir.join(worktree_name);
    if expected.exists() {
        let expected = expected
            .canonicalize()
            .map_err(|_| "configuration: the automation worktree is unavailable".to_string())?;
        let root = paths
            .worktrees_dir
            .canonicalize()
            .map_err(|_| "configuration: the Gyro worktree root is unavailable".to_string())?;
        if !expected.starts_with(root) || !expected.is_dir() {
            return Err("configuration: the automation worktree is unsafe".into());
        }
        return Ok(expected);
    }
    create_worktree(
        paths,
        source,
        automation.branch.clone(),
        Some(worktree_name.to_string()),
    )
    .map(|plan| plan.worktree_path)
    .map_err(|error| format!("configuration: could not create automation worktree: {error}"))
}

pub(crate) fn provider_id_for_automation_label(label: &str) -> &'static str {
    let normalized = label.to_ascii_lowercase();
    if normalized.contains("claude") || normalized.contains("anthropic") {
        "anthropic"
    } else {
        "openai"
    }
}

pub(crate) fn automation_provider_prompt(automation: &Automation) -> String {
    match automation.stop_condition.as_deref() {
        Some(condition) => format!(
            "{}\n\nAutomation stop condition: {}\n\nEvaluate the stop condition after completing the work. End your final response with exactly one hidden machine-readable line using one of these forms:\n<!-- gyro-automation-result: {{\"stopConditionMet\":true}} -->\n<!-- gyro-automation-result: {{\"stopConditionMet\":false}} -->\nUse true only when you verified the condition is satisfied. Do not omit this line.",
            automation.prompt, condition,
        ),
        None => automation.prompt.clone(),
    }
}

#[derive(Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationStopConditionVerdict {
    pub(crate) stop_condition_met: bool,
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct AutomationExecutionOutcome {
    pub(crate) summary: String,
    pub(crate) stop_condition_met: Option<bool>,
}

pub(crate) fn parse_automation_execution_outcome(
    automation: &Automation,
    response: &str,
) -> Result<AutomationExecutionOutcome, String> {
    if automation.stop_condition.is_none() {
        return Ok(AutomationExecutionOutcome {
            summary: response.trim().to_string(),
            stop_condition_met: None,
        });
    }

    let marker_start = response
        .rfind(AUTOMATION_RESULT_MARKER_PREFIX)
        .ok_or_else(|| {
            "Automation failed closed because the provider did not report a stop-condition verdict"
                .to_string()
        })?;
    let marker_payload_start = marker_start + AUTOMATION_RESULT_MARKER_PREFIX.len();
    let marker_tail = &response[marker_payload_start..];
    let marker_end = marker_tail
        .find(AUTOMATION_RESULT_MARKER_SUFFIX)
        .ok_or_else(|| {
            "Automation failed closed because the provider returned an incomplete stop-condition verdict"
                .to_string()
        })?;
    let trailing = &marker_tail[marker_end + AUTOMATION_RESULT_MARKER_SUFFIX.len()..];
    if !trailing.trim().is_empty() {
        return Err(
            "Automation failed closed because its stop-condition verdict was not the final output"
                .into(),
        );
    }

    let verdict = serde_json::from_str::<AutomationStopConditionVerdict>(
        marker_tail[..marker_end].trim(),
    )
    .map_err(|_| {
        "Automation failed closed because the provider returned an invalid stop-condition verdict"
            .to_string()
    })?;
    let summary = response[..marker_start].trim();
    Ok(AutomationExecutionOutcome {
        summary: if summary.is_empty() {
            "Automation completed and evaluated its stop condition".into()
        } else {
            summary.to_string()
        },
        stop_condition_met: Some(verdict.stop_condition_met),
    })
}

pub(crate) fn bounded_automation_summary(value: &str) -> String {
    truncate_chars(value.trim(), 600)
}
