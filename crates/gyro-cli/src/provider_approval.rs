//! Approval DTOs for terminal prompts and the permission MCP server.
use serde_json::Value;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ApprovalKind {
    Command,
    FileChange,
    Permissions,
}

impl ApprovalKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::FileChange => "file-change",
            Self::Permissions => "permissions",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ApprovalDecision {
    Accept,
    Decline,
    AppliedByClient,
}

#[derive(Clone, Debug)]
pub(crate) struct ApprovalRequest {
    pub kind: ApprovalKind,
    pub details: Value,
}
