//! The composer's three approval choices, translated into each CLI's own flags.
//!
//! Ask for approval, Approve for me, and Full access are one saved choice.
//! A CLI that has a native mode is started in that mode. A CLI that does not
//! is left on its default, and Gyro's approval callback still asks or allows
//! from the same flags.

use serde_json::Value;
use std::path::Path;

/// Which of the three composer choices is in force.
///
/// A split setting (ask for commands, allow edits, or the reverse) stays on
/// the ask side for native flags. The approval callback still honors each
/// flag on its own.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApprovalPosture {
    Ask,
    ApproveForMe,
    FullAccess,
}

pub fn approval_posture(
    full_access: bool,
    require_command_approval: bool,
    require_file_edit_approval: bool,
) -> ApprovalPosture {
    if full_access && !require_command_approval && !require_file_edit_approval {
        ApprovalPosture::FullAccess
    } else if !require_command_approval && !require_file_edit_approval {
        ApprovalPosture::ApproveForMe
    } else {
        ApprovalPosture::Ask
    }
}

/// Codex app-server approval policy and sandbox for one turn.
///
/// Plan and Council are read-only even when the saved choice is Full access.
/// Approve for me keeps the workspace sandbox and leaves network off. Full
/// access is `danger-full-access`.
pub fn codex_execution_policy(
    advisory: bool,
    require_command_approval: bool,
    require_file_edit_approval: bool,
    full_access: bool,
    cwd: &Path,
) -> (&'static str, &'static str, Value) {
    let full_access =
        !advisory && full_access && !require_command_approval && !require_file_edit_approval;
    let approval_policy = if advisory || require_command_approval {
        "untrusted"
    } else {
        "on-request"
    };
    if advisory || require_file_edit_approval {
        return (
            approval_policy,
            "read-only",
            serde_json::json!({ "type": "readOnly", "networkAccess": false }),
        );
    }
    if full_access {
        return (
            approval_policy,
            "danger-full-access",
            serde_json::json!({ "type": "dangerFullAccess" }),
        );
    }
    (
        approval_policy,
        "workspace-write",
        serde_json::json!({
            "type": "workspaceWrite",
            "writableRoots": [cwd],
            "networkAccess": false,
            "excludeTmpdirEnvVar": false,
            "excludeSlashTmp": false
        }),
    )
}

/// Claude Code's `--permission-mode` for a normal turn.
///
/// Full access is launched with `--dangerously-skip-permissions` instead of
/// this value. `manual` is the current ask mode; `default` is still accepted
/// by Claude Code 2.1 but is no longer one of the listed choices.
pub fn claude_permission_mode(posture: ApprovalPosture) -> &'static str {
    match posture {
        ApprovalPosture::Ask => "manual",
        ApprovalPosture::ApproveForMe => "auto",
        ApprovalPosture::FullAccess => "bypassPermissions",
    }
}

/// Whether Approve for me should still show a card when this CLI asks.
///
/// These CLIs auto-approve the safe set themselves. A request that still
/// reaches Gyro is outside that set, so the person decides it. CLIs without
/// that filter keep Gyro's allow-without-asking behavior.
pub fn approve_for_me_keeps_escalations(provider_id: &str) -> bool {
    matches!(provider_id, "xai" | "kimi" | "anthropic")
}

/// Argv for an ACP CLI, including its subcommand, for the saved choice.
///
/// `None` means this id is not an ACP CLI Gyro knows how to switch.
/// Antigravity's ACP server (`agy_acp_server.par`) takes no permission flag
/// that we can verify, so both non-ask choices return the same empty argv and
/// Gyro's callback is the only control. OpenCode has `--auto` and no sandbox,
/// so Approve for me and Full access are the same native mode; deny rules in
/// the user's OpenCode config still apply.
pub fn acp_permission_args(
    provider_id: &str,
    posture: ApprovalPosture,
) -> Option<&'static [&'static str]> {
    Some(match provider_id {
        "kimi" => match posture {
            // `--yolo` approves ordinary tool calls and can still ask.
            // `--auto` does not ask. Both are global flags and must precede `acp`.
            ApprovalPosture::Ask => &["acp"],
            ApprovalPosture::ApproveForMe => &["--yolo", "acp"],
            ApprovalPosture::FullAccess => &["--auto", "acp"],
        },
        "gemini" => match posture {
            // Halfway mode auto-approves edits and still prompts for other
            // tools. `--sandbox` is Gemini's project boundary. Full access is
            // `--approval-mode yolo` with the sandbox left off.
            ApprovalPosture::Ask => &["--approval-mode", "default", "--acp"],
            ApprovalPosture::ApproveForMe => {
                &["--approval-mode", "auto_edit", "--sandbox", "--acp"]
            }
            ApprovalPosture::FullAccess => &["--approval-mode", "yolo", "--acp"],
        },
        "cursor" => match posture {
            // The ACP subcommand reads `--force`, not `--yolo`. The sandbox
            // flag is `enabled` or `disabled`.
            ApprovalPosture::Ask => &["acp"],
            ApprovalPosture::ApproveForMe => &["--sandbox", "enabled", "acp"],
            ApprovalPosture::FullAccess => &["--force", "--sandbox", "disabled", "acp"],
        },
        "opencode" => match posture {
            ApprovalPosture::Ask => &["acp"],
            ApprovalPosture::ApproveForMe | ApprovalPosture::FullAccess => &["--auto", "acp"],
        },
        "antigravity" => &[],
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posture_follows_the_three_composer_choices() {
        assert_eq!(approval_posture(false, true, true), ApprovalPosture::Ask);
        assert_eq!(
            approval_posture(false, false, false),
            ApprovalPosture::ApproveForMe
        );
        assert_eq!(
            approval_posture(true, false, false),
            ApprovalPosture::FullAccess
        );
        // A leftover approval flag keeps the native CLI on the ask side.
        assert_eq!(approval_posture(true, true, false), ApprovalPosture::Ask);
        assert_eq!(approval_posture(false, true, false), ApprovalPosture::Ask);
    }

    #[test]
    fn codex_full_access_drops_the_sandbox_and_plan_keeps_it() {
        let cwd = Path::new("/tmp/gyro-workspace");
        let (approval, sandbox, policy) = codex_execution_policy(false, false, false, true, cwd);
        assert_eq!((approval, sandbox), ("on-request", "danger-full-access"));
        assert_eq!(policy["type"], "dangerFullAccess");

        let (approval, sandbox, policy) = codex_execution_policy(false, false, false, false, cwd);
        assert_eq!((approval, sandbox), ("on-request", "workspace-write"));
        assert_eq!(policy["networkAccess"], false);

        let (_, sandbox, _) = codex_execution_policy(true, false, false, true, cwd);
        assert_eq!(sandbox, "read-only");
    }

    #[test]
    fn each_acp_cli_gets_the_native_mode_it_actually_has() {
        assert_eq!(
            acp_permission_args("kimi", ApprovalPosture::FullAccess),
            Some(&["--auto", "acp"][..])
        );
        assert_eq!(
            acp_permission_args("kimi", ApprovalPosture::ApproveForMe),
            Some(&["--yolo", "acp"][..])
        );
        assert_eq!(
            acp_permission_args("gemini", ApprovalPosture::FullAccess),
            Some(&["--approval-mode", "yolo", "--acp"][..])
        );
        assert_eq!(
            acp_permission_args("cursor", ApprovalPosture::FullAccess),
            Some(&["--force", "--sandbox", "disabled", "acp"][..])
        );
        assert_eq!(
            acp_permission_args("opencode", ApprovalPosture::ApproveForMe),
            acp_permission_args("opencode", ApprovalPosture::FullAccess)
        );
        assert_eq!(
            acp_permission_args("antigravity", ApprovalPosture::FullAccess),
            Some(&[][..])
        );
        assert!(acp_permission_args("ollama", ApprovalPosture::FullAccess).is_none());
    }
}
