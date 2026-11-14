use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub const ALPN: &[u8] = b"gyro/remote/v1";
pub const MAX_FRAME: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub id: Uuid,
    pub operation: Operation,
    pub lease: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Operation {
    Pair {
        secret: String,
        name: String,
    },
    PairStatus,
    Hello,
    Projects,
    RequestStatus {
        request_id: Uuid,
    },
    Sessions {
        project_id: String,
    },
    CreateSession {
        project_id: String,
        title: String,
        model: ModelChoice,
        branch: Option<String>,
    },
    RenameSession {
        session_id: String,
        title: String,
    },
    History {
        session_id: String,
        before: Option<String>,
        revision: Option<String>,
    },
    Snapshot {
        session_id: String,
    },
    Watch {
        session_id: String,
    },
    Submit {
        session_id: String,
        turn_id: String,
        message: String,
        model: ModelChoice,
    },
    Stop {
        session_id: String,
    },
    Approval {
        session_id: String,
        approval_id: String,
        turn_id: Option<String>,
        kind: ApprovalKind,
        decision: String,
    },
    Question {
        session_id: String,
        question_id: String,
        answers: Value,
    },
    Claim {
        session_id: String,
    },
    RequestControl {
        session_id: String,
    },
    TransferControl {
        session_id: String,
        peer_id: String,
    },
    Release {
        session_id: String,
    },
    Files {
        session_id: String,
    },
    Search {
        session_id: String,
        query: String,
    },
    ReadFile {
        session_id: String,
        path: String,
    },
    WriteFile {
        session_id: String,
        path: String,
        content: String,
        expected_hash: Option<String>,
    },
    Path {
        session_id: String,
        action: PathAction,
        path: String,
        name: Option<String>,
        expected_hash: Option<String>,
    },
    Git {
        session_id: String,
        action: GitAction,
        path: Option<String>,
        message: Option<String>,
        expected_revision: Option<String>,
    },
    Terminal {
        session_id: String,
        action: TerminalAction,
        pane_id: Option<String>,
        input: Option<String>,
        cols: Option<u16>,
        rows: Option<u16>,
        revision: Option<u64>,
    },
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelChoice {
    pub provider_id: String,
    pub model_id: String,
    pub reasoning_effort: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalKind {
    Provider,
    Capability,
    Mutation,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PathAction {
    CreateFile,
    CreateDirectory,
    Rename,
    Delete,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum GitAction {
    Status,
    Diff,
    Branches,
    Stage,
    Unstage,
    Discard,
    Commit,
    CreateBranch,
    Checkout,
    Fetch,
    Pull,
    Push,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TerminalAction {
    List,
    Create,
    Read,
    Input,
    Resize,
    Close,
}

impl Operation {
    pub fn session_id(&self) -> Option<&str> {
        match self {
            Self::RenameSession { session_id, .. }
            | Self::History { session_id, .. }
            | Self::Snapshot { session_id }
            | Self::Watch { session_id }
            | Self::Submit { session_id, .. }
            | Self::Stop { session_id }
            | Self::Approval { session_id, .. }
            | Self::Question { session_id, .. }
            | Self::Claim { session_id }
            | Self::RequestControl { session_id }
            | Self::TransferControl { session_id, .. }
            | Self::Release { session_id }
            | Self::Files { session_id }
            | Self::Search { session_id, .. }
            | Self::ReadFile { session_id, .. }
            | Self::WriteFile { session_id, .. }
            | Self::Path { session_id, .. }
            | Self::Git { session_id, .. }
            | Self::Terminal { session_id, .. } => Some(session_id),
            _ => None,
        }
    }
    pub fn mutates(&self) -> bool {
        match self {
            Self::CreateSession { .. }
            | Self::RenameSession { .. }
            | Self::Submit { .. }
            | Self::Stop { .. }
            | Self::Approval { .. }
            | Self::Question { .. }
            | Self::WriteFile { .. }
            | Self::Path { .. } => true,
            Self::Git { action, .. } => !matches!(
                action,
                GitAction::Status | GitAction::Diff | GitAction::Branches
            ),
            Self::Terminal { action, .. } => {
                !matches!(action, TerminalAction::List | TerminalAction::Read)
            }
            _ => false,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub id: Uuid,
    pub value: Option<Value>,
    pub error: Option<String>,
}
impl Response {
    pub fn result(id: Uuid, result: Result<Value, String>) -> Self {
        match result {
            Ok(value) => Self {
                id,
                value: Some(value),
                error: None,
            },
            Err(error) => Self {
                id,
                value: None,
                error: Some(error),
            },
        }
    }
    pub fn into_result(self) -> Result<Value, String> {
        self.error
            .map_or_else(|| Ok(self.value.unwrap_or(Value::Null)), Err)
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEvent {
    pub session_id: String,
    pub topic: String,
    pub payload: Value,
}
