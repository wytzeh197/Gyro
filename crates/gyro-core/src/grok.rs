//! Grok Build process flags. Model and effort are arguments, not ACP session calls:
//! `session/set_model` comes back "Method not found" and must not fail the turn.
use std::ffi::OsString;

/// Same Grok 4.7 weights on the faster Grok Build pool. Not a public API id.
pub const BUILD_FAST_MODEL_ID: &str = "grok-4.7-build-fast";

/// Built-in effort menu used when a live catalog row is absent.
///
/// Grok 4.5 stops at high. Grok 4.3, 4.6, 4.7, and 4.7 Fast also accept xhigh.
/// An empty model id keeps xhigh so a default Grok 4.7 launch can still set it.
pub fn bundled_reasoning_efforts(model_id: Option<&str>) -> &'static [&'static str] {
    const BASE: &[&str] = &["low", "medium", "high"];
    const WITH_XHIGH: &[&str] = &["low", "medium", "high", "xhigh"];
    let model_id = model_id.map(str::trim).unwrap_or("");
    if model_id.is_empty()
        || model_id.eq_ignore_ascii_case("grok-4.3")
        || model_id.eq_ignore_ascii_case("grok-4.6")
        || model_id.eq_ignore_ascii_case("grok-4.7")
        || model_id.eq_ignore_ascii_case(BUILD_FAST_MODEL_ID)
    {
        WITH_XHIGH
    } else {
        BASE
    }
}

/// One level from [`bundled_reasoning_efforts`], or nothing when the model rejects it.
pub fn reasoning_effort_arg(
    model_id: Option<&str>,
    reasoning_effort: Option<&str>,
) -> Option<String> {
    let effort = reasoning_effort?.trim().to_ascii_lowercase();
    if effort.is_empty() {
        return None;
    }
    bundled_reasoning_efforts(model_id)
        .iter()
        .any(|allowed| *allowed == effort)
        .then_some(effort)
}

/// `grok agent stdio` argv. `validated_effort` is placed as given; callers that
/// still have the user's raw choice use [`acp_program_args`].
pub fn format_acp_program_args(
    model_id: Option<&str>,
    validated_effort: Option<&str>,
    posture: crate::provider_permissions::ApprovalPosture,
) -> Vec<OsString> {
    let (permission_mode, sandbox) = match posture {
        // `auto` lets routine local work through and still asks Gyro about the
        // rest. `bypassPermissions` is always-approve. The sandbox is
        // process-wide: workspace keeps writes in the project, `off` is the
        // unrestricted Full access profile.
        crate::provider_permissions::ApprovalPosture::Ask => ("default", "workspace"),
        crate::provider_permissions::ApprovalPosture::ApproveForMe => ("auto", "workspace"),
        crate::provider_permissions::ApprovalPosture::FullAccess => ("bypassPermissions", "off"),
    };
    let mut args = vec![
        OsString::from("--no-auto-update"),
        OsString::from("--permission-mode"),
        OsString::from(permission_mode),
        OsString::from("--sandbox"),
        OsString::from(sandbox),
        OsString::from("agent"),
        OsString::from("--no-leader"),
    ];
    if let Some(model) = model_id.map(str::trim).filter(|model| !model.is_empty()) {
        args.push(OsString::from("-m"));
        args.push(OsString::from(model));
    }
    if let Some(effort) = validated_effort
        .map(str::trim)
        .filter(|effort| !effort.is_empty())
    {
        args.push(OsString::from("--reasoning-effort"));
        args.push(OsString::from(effort));
    }
    args.push(OsString::from("stdio"));
    args
}

/// `grok agent stdio` argv, dropping effort levels the built-in menu rejects.
pub fn acp_program_args(
    model_id: Option<&str>,
    reasoning_effort: Option<&str>,
    posture: crate::provider_permissions::ApprovalPosture,
) -> Vec<OsString> {
    let effort = reasoning_effort_arg(model_id, reasoning_effort);
    format_acp_program_args(model_id, effort.as_deref(), posture)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(model: Option<&str>, effort: Option<&str>) -> Vec<String> {
        acp_program_args(model, effort, crate::ApprovalPosture::Ask)
            .into_iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn bundled_menu_matches_the_picker() {
        assert_eq!(
            bundled_reasoning_efforts(Some("grok-4.7")),
            &["low", "medium", "high", "xhigh"][..]
        );
        assert_eq!(
            bundled_reasoning_efforts(Some("grok-4.3")),
            &["low", "medium", "high", "xhigh"][..]
        );
        assert_eq!(
            bundled_reasoning_efforts(Some("grok-4.6")),
            &["low", "medium", "high", "xhigh"][..]
        );
        assert_eq!(
            bundled_reasoning_efforts(Some("Grok-4.7")),
            &["low", "medium", "high", "xhigh"][..]
        );
        assert_eq!(
            bundled_reasoning_efforts(Some(BUILD_FAST_MODEL_ID)),
            &["low", "medium", "high", "xhigh"][..]
        );
        assert_eq!(
            bundled_reasoning_efforts(None),
            &["low", "medium", "high", "xhigh"][..]
        );
        assert_eq!(
            bundled_reasoning_efforts(Some("grok-4.5")),
            &["low", "medium", "high"][..]
        );
    }

    #[test]
    fn fast_variant_keeps_xhigh_and_standard_grok_drops_unknown_levels() {
        assert_eq!(
            reasoning_effort_arg(Some(BUILD_FAST_MODEL_ID), Some("xhigh")),
            Some("xhigh".into())
        );
        assert_eq!(reasoning_effort_arg(Some("grok-4.5"), Some("xhigh")), None);
        assert_eq!(reasoning_effort_arg(Some("grok-4.7"), Some("max")), None);
        assert_eq!(
            args(Some(BUILD_FAST_MODEL_ID), Some("XHIGH")),
            vec![
                "--no-auto-update",
                "--permission-mode",
                "default",
                "--sandbox",
                "workspace",
                "agent",
                "--no-leader",
                "-m",
                BUILD_FAST_MODEL_ID,
                "--reasoning-effort",
                "xhigh",
                "stdio",
            ]
        );
        assert_eq!(
            args(None, None),
            vec![
                "--no-auto-update",
                "--permission-mode",
                "default",
                "--sandbox",
                "workspace",
                "agent",
                "--no-leader",
                "stdio",
            ]
        );
        let full = acp_program_args(None, None, crate::ApprovalPosture::FullAccess)
            .into_iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            full,
            vec![
                "--no-auto-update",
                "--permission-mode",
                "bypassPermissions",
                "--sandbox",
                "off",
                "agent",
                "--no-leader",
                "stdio",
            ]
        );
        let auto = acp_program_args(None, None, crate::ApprovalPosture::ApproveForMe)
            .into_iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(auto
            .windows(2)
            .any(|pair| pair == ["--permission-mode", "auto"]));
        assert!(auto
            .windows(2)
            .any(|pair| pair == ["--sandbox", "workspace"]));
    }
}
