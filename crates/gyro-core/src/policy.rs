use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CommandDecision {
    Allowed,
    RequiresApproval,
    Denied { reason: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionPolicy {
    pub require_command_approval: bool,
    pub require_file_edit_approval: bool,
    pub denied_command_prefixes: Vec<String>,
}

impl Default for PermissionPolicy {
    fn default() -> Self {
        Self {
            require_command_approval: true,
            require_file_edit_approval: true,
            denied_command_prefixes: vec![
                "rm -rf /".into(),
                "sudo rm".into(),
                "diskutil erase".into(),
                "mkfs".into(),
            ],
        }
    }
}

impl PermissionPolicy {
    pub fn evaluate_command(&self, command: &str) -> CommandDecision {
        let normalized = command.trim();
        for denied in &self.denied_command_prefixes {
            if normalized.starts_with(denied) {
                return CommandDecision::Denied {
                    reason: format!("command starts with denied prefix `{denied}`"),
                };
            }
        }

        if self.require_command_approval {
            CommandDecision::RequiresApproval
        } else {
            CommandDecision::Allowed
        }
    }

    pub fn file_edit_requires_approval(&self) -> bool {
        self.require_file_edit_approval
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dangerous_command_is_denied_before_approval() {
        let policy = PermissionPolicy::default();
        assert!(matches!(
            policy.evaluate_command("rm -rf /"),
            CommandDecision::Denied { .. }
        ));
    }

    #[test]
    fn ordinary_command_requires_approval_by_default() {
        let policy = PermissionPolicy::default();
        assert_eq!(
            policy.evaluate_command("git status"),
            CommandDecision::RequiresApproval
        );
    }
}
