//! Per-process OpenCode agent whose native tools use Gyro's approval callback.
//!
//! Global OPENCODE_PERMISSION alone is insufficient: agent rules win over it.
//! Use a fresh agent name and select it after both session/new and session/load.
//! No provider configuration is written to disk. Native task delegation is
//! disabled because those agents have independent permission rules; Gyro's MCP
//! delegation remains available through the same approval channel.
//!
//! OpenCode has no sandbox and no posture flag, so the agent's own rules carry
//! Approve for Me: edits and reads inside the project run natively, while
//! shell, web and paths outside the project still ask. Ask for Approval and
//! Full Access keep every tool on ask; Full Access is answered by the callback.

use crate::ApprovalPosture;
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::process::Command;

pub(crate) fn configure(
    command: &mut Command,
    plan: bool,
    posture: ApprovalPosture,
) -> Result<String> {
    let name = format!("gyro-{}", uuid::Uuid::new_v4().simple());
    let inherited = std::env::var("OPENCODE_CONFIG_CONTENT").ok();
    let config = configuration(inherited.as_deref(), &name, plan, posture)?;
    command.env("OPENCODE_CONFIG_CONTENT", serde_json::to_string(&config)?);
    // Don't inherit native auto-approval: the callback owns Gyro's posture.
    command.env_remove("OPENCODE_PERMISSION");
    Ok(name)
}

/// The managed agent's `permission` block.
///
/// This is OpenCode's `permission` map: a tool key with `allow`, `ask` or
/// `deny`, or a pattern map for `read`, `bash` and the other rule tools.
fn permission(plan: bool, posture: ApprovalPosture) -> Value {
    let secrets_denied = |rest: &str| json!({ "*": rest, "*.env": "deny", "*.env.*": "deny" });
    if plan || posture != ApprovalPosture::ApproveForMe {
        return json!({
            "*": "ask",
            "edit": if plan { "deny" } else { "ask" },
            "task": "deny",
            "read": secrets_denied("ask")
        });
    }
    json!({
        "*": "ask",
        "edit": "allow",
        "read": secrets_denied("allow"),
        "glob": "allow",
        "grep": "allow",
        "list": "allow",
        "lsp": "allow",
        "todowrite": "allow",
        // Gyro's own tools (MCP server `gyro_capabilities`) follow the
        // project's capability policy on Gyro's side, as before.
        "gyro_capabilities_*": "allow",
        // Exact read-only commands only: a wildcard would also match a chained
        // command such as `git status; rm -rf .`.
        "bash": {
            "*": "ask",
            "git status": "allow",
            "git diff": "allow",
            "git log": "allow",
            "pwd": "allow",
            "ls": "allow"
        },
        "external_directory": "ask",
        "webfetch": "ask",
        "websearch": "ask",
        "doom_loop": "ask",
        "task": "deny"
    })
}

fn configuration(
    inherited: Option<&str>,
    name: &str,
    plan: bool,
    posture: ApprovalPosture,
) -> Result<Value> {
    let mut config: Value = match inherited.filter(|value| !value.trim().is_empty()) {
        Some(value) => {
            serde_json::from_str(value).context("parse OpenCode inline configuration")?
        }
        None => json!({}),
    };
    anyhow::ensure!(
        config.is_object(),
        "OpenCode inline configuration must be an object"
    );
    if config.get("agent").is_none() {
        config["agent"] = json!({});
    }
    anyhow::ensure!(
        config["agent"].is_object(),
        "OpenCode agent configuration must be an object"
    );
    config["agent"][name] = json!({
        "description": "Gyro workspace agent",
        "mode": "primary",
        "permission": permission(plan, posture)
    });
    config["default_agent"] = json!(name);
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Protocol/configuration acceptance only; does not send a model prompt.
    #[test]
    #[ignore = "requires GYRO_TEST_OPENCODE pointing at an installed OpenCode CLI"]
    fn installed_opencode_enforces_managed_agent_over_permissive_project_rules() {
        let binary = std::env::var("GYRO_TEST_OPENCODE").expect("GYRO_TEST_OPENCODE");
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("opencode.json"), r#"{"permission":"allow","default_agent":"build","agent":{"build":{"permission":"allow"}}}"#).unwrap();
        let mut command = Command::new(binary);
        command.current_dir(temp.path());
        for (key, child) in [
            ("XDG_CONFIG_HOME", "config"),
            ("XDG_DATA_HOME", "data"),
            ("XDG_CACHE_HOME", "cache"),
            ("XDG_STATE_HOME", "state"),
        ] {
            command.env(key, temp.path().join(child));
        }
        let name = configure(&mut command, false, ApprovalPosture::Ask).unwrap();
        let output = command
            .args(["--pure", "debug", "agent", &name])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let agent: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(agent["name"], name);
        let rules = agent["permission"].as_array().expect("permission rules");
        for (tool, expected) in [("bash", "ask"), ("edit", "ask"), ("task", "deny")] {
            let rule = rules
                .iter()
                .rev()
                .find(|rule| rule["permission"] == tool || rule["permission"] == "*")
                .unwrap();
            assert_eq!(rule["action"], expected, "{tool}: {rules:?}");
        }
    }

    #[test]
    fn permissive_custom_agents_cannot_be_selected_by_default() {
        let config = configuration(Some(r#"{"model":"vendor/model","default_agent":"build","agent":{"build":{"permission":"allow"}},"provider":{"vendor":{"options":{"baseURL":"http://localhost:1234"}}}}"#), "gyro-test", false, ApprovalPosture::Ask).unwrap();
        assert_eq!(config["default_agent"], "gyro-test");
        assert_eq!(config["agent"]["gyro-test"]["permission"]["*"], "ask");
        assert_eq!(config["agent"]["gyro-test"]["permission"]["task"], "deny");
        assert_eq!(config["agent"]["build"]["permission"], "allow");
        assert_eq!(config["model"], "vendor/model");
        assert_eq!(
            config["provider"]["vendor"]["options"]["baseURL"],
            "http://localhost:1234"
        );
    }

    #[test]
    fn planning_denies_edits_and_invalid_configuration_fails_closed() {
        for posture in [
            ApprovalPosture::Ask,
            ApprovalPosture::ApproveForMe,
            ApprovalPosture::FullAccess,
        ] {
            let config = configuration(None, "gyro-test", true, posture).unwrap();
            let rules = &config["agent"]["gyro-test"]["permission"];
            assert_eq!(rules["edit"], "deny");
            assert_eq!(rules["read"]["*"], "ask");
        }
        for bad in ["{", "[]", r#"{"agent":false}"#] {
            assert!(configuration(Some(bad), "gyro-test", false, ApprovalPosture::Ask).is_err());
        }
    }

    #[test]
    fn approve_for_me_runs_project_work_and_still_asks_for_shell_and_web() {
        let config =
            configuration(None, "gyro-test", false, ApprovalPosture::ApproveForMe).unwrap();
        let rules = &config["agent"]["gyro-test"]["permission"];
        assert_eq!(rules["edit"], "allow");
        assert_eq!(rules["read"]["*"], "allow");
        assert_eq!(rules["read"]["*.env"], "deny");
        assert_eq!(rules["bash"]["*"], "ask");
        assert_eq!(rules["bash"]["git status"], "allow");
        assert!(rules["bash"]
            .as_object()
            .unwrap()
            .keys()
            .all(|pattern| pattern == "*" || !pattern.contains('*')));
        for tool in ["external_directory", "webfetch", "websearch", "*"] {
            assert_eq!(rules[tool], "ask", "{tool}");
        }
        assert_eq!(rules["task"], "deny");
        assert_eq!(rules["gyro_capabilities_*"], "allow");
        // Last match wins in OpenCode, so the catch-all has to come first.
        assert_eq!(rules.as_object().unwrap().keys().next().unwrap(), "*");

        // Ask and Full Access keep every native tool on ask.
        for posture in [ApprovalPosture::Ask, ApprovalPosture::FullAccess] {
            let config = configuration(None, "gyro-test", false, posture).unwrap();
            let rules = &config["agent"]["gyro-test"]["permission"];
            assert_eq!(rules["edit"], "ask");
            assert_eq!(rules["read"]["*"], "ask");
        }
    }
}
