use crate::security::redact_secrets;
use anyhow::{anyhow, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Component, Path};
use uuid::Uuid;

pub const CAPABILITY_SCHEMA_V1: &str = "gyro.capability.v1";
pub const PROVIDER_CAPABILITY_IPC_SCHEMA_V1: &str = "gyro.provider-capability-ipc.v1";
pub const MAX_CAPABILITY_RESULT_BYTES: usize = 128 * 1024;
pub const MAX_CAPABILITY_SUMMARY_CHARS: usize = 4_000;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityId {
    WorkspaceContext,
    WorkspaceList,
    WorkspaceSearch,
    WorkspaceRead,
    WorkspaceReadRange,
    WorkspaceDiagnostics,
    WorkspaceGitStatus,
    WorkspaceDiff,
    WorkspaceProposeEdit,
    WorkspaceRunTask,
    WorkspaceRunTest,
    WorkspaceReadOutput,
    IdeReveal,
    IdeOpenPanel,
    TerminalOpen,
    TerminalRead,
    TerminalStop,
    BrowserOpen,
    BrowserInspect,
    BrowserReload,
    BrowserScreenshot,
    GithubStatus,
    GithubPullRequests,
    GithubWorkflowRuns,
    GithubWorkflowLogs,
    GithubCreatePullRequest,
    GithubRerunWorkflow,
    GithubPush,
}

impl CapabilityId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::WorkspaceContext => "workspace.context",
            Self::WorkspaceList => "workspace.list",
            Self::WorkspaceSearch => "workspace.search",
            Self::WorkspaceRead => "workspace.read",
            Self::WorkspaceReadRange => "workspace.read_range",
            Self::WorkspaceDiagnostics => "workspace.diagnostics",
            Self::WorkspaceGitStatus => "workspace.git_status",
            Self::WorkspaceDiff => "workspace.diff",
            Self::WorkspaceProposeEdit => "workspace.propose_edit",
            Self::WorkspaceRunTask => "workspace.run_task",
            Self::WorkspaceRunTest => "workspace.run_test",
            Self::WorkspaceReadOutput => "workspace.read_output",
            Self::IdeReveal => "ide.reveal",
            Self::IdeOpenPanel => "ide.open_panel",
            Self::TerminalOpen => "terminal.open",
            Self::TerminalRead => "terminal.read",
            Self::TerminalStop => "terminal.stop",
            Self::BrowserOpen => "browser.open",
            Self::BrowserInspect => "browser.inspect",
            Self::BrowserReload => "browser.reload",
            Self::BrowserScreenshot => "browser.screenshot",
            Self::GithubStatus => "github.status",
            Self::GithubPullRequests => "github.pull_requests",
            Self::GithubWorkflowRuns => "github.workflow_runs",
            Self::GithubWorkflowLogs => "github.workflow_logs",
            Self::GithubCreatePullRequest => "github.create_pull_request",
            Self::GithubRerunWorkflow => "github.rerun_workflow",
            Self::GithubPush => "github.push",
        }
    }

    pub fn provider_tool_name(self) -> &'static str {
        match self {
            Self::WorkspaceContext => "gyro_workspace_get_context",
            Self::WorkspaceList => "gyro_workspace_list",
            Self::WorkspaceSearch => "gyro_workspace_search",
            Self::WorkspaceRead => "gyro_workspace_read",
            Self::WorkspaceReadRange => "gyro_workspace_read_range",
            Self::WorkspaceDiagnostics => "gyro_workspace_diagnostics",
            Self::WorkspaceGitStatus => "gyro_workspace_git_status",
            Self::WorkspaceDiff => "gyro_workspace_diff",
            Self::WorkspaceProposeEdit => "gyro_workspace_propose_edit",
            Self::WorkspaceRunTask => "gyro_workspace_run_task",
            Self::WorkspaceRunTest => "gyro_workspace_run_test",
            Self::WorkspaceReadOutput => "gyro_workspace_read_output",
            Self::IdeReveal => "gyro_ide_reveal",
            Self::IdeOpenPanel => "gyro_ide_open_panel",
            Self::TerminalOpen => "gyro_terminal_open",
            Self::TerminalRead => "gyro_terminal_read",
            Self::TerminalStop => "gyro_terminal_stop",
            Self::BrowserOpen => "gyro_browser_open",
            Self::BrowserInspect => "gyro_browser_inspect",
            Self::BrowserReload => "gyro_browser_reload",
            Self::BrowserScreenshot => "gyro_browser_screenshot",
            Self::GithubStatus => "gyro_github_status",
            Self::GithubPullRequests => "gyro_github_pull_requests",
            Self::GithubWorkflowRuns => "gyro_github_workflow_runs",
            Self::GithubWorkflowLogs => "gyro_github_workflow_logs",
            Self::GithubCreatePullRequest => "gyro_github_create_pull_request",
            Self::GithubRerunWorkflow => "gyro_github_rerun_workflow",
            Self::GithubPush => "gyro_github_push",
        }
    }

    pub fn from_provider_tool_name(name: &str) -> Option<Self> {
        CAPABILITY_DESCRIPTORS
            .iter()
            .find(|descriptor| descriptor.id.provider_tool_name() == name)
            .map(|descriptor| descriptor.id)
    }
}

impl std::fmt::Display for CapabilityId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityClass {
    WorkspaceInspect,
    WorkspaceSensitiveRead,
    IdeReveal,
    TerminalExecute,
    TerminalObserve,
    BrowserInspect,
    BrowserNavigate,
    /// Read-only GitHub queries through the user's existing `gh` login.
    GithubInspect,
    /// Outward-facing GitHub effects — pushing, opening PRs, re-running CI.
    GithubWrite,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CapabilityAccess {
    Deny,
    Ask,
    Allow,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityStatus {
    Requested,
    Waiting,
    Running,
    Completed,
    Failed,
    Denied,
    Cancelled,
    Inactive,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityApprovalDecision {
    Deny,
    AllowOnce,
    AllowProject,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityRunMode {
    Normal,
    Plan,
    /// Advisory Model Council: no tools; frozen snapshot only.
    Council,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCapabilityGrant {
    pub id: Uuid,
    pub class: CapabilityClass,
    pub scope_kind: String,
    pub scope_value: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCapabilityPolicy {
    pub schema: String,
    pub workspace_key: String,
    pub revision: u64,
    pub classes: BTreeMap<CapabilityClass, CapabilityAccess>,
    pub grants: Vec<ProjectCapabilityGrant>,
    pub updated_at: DateTime<Utc>,
}

impl ProjectCapabilityPolicy {
    pub fn defaults(workspace_key: impl Into<String>) -> Self {
        let mut classes = BTreeMap::new();
        classes.insert(CapabilityClass::WorkspaceInspect, CapabilityAccess::Allow);
        classes.insert(
            CapabilityClass::WorkspaceSensitiveRead,
            CapabilityAccess::Ask,
        );
        classes.insert(CapabilityClass::IdeReveal, CapabilityAccess::Allow);
        classes.insert(CapabilityClass::TerminalExecute, CapabilityAccess::Ask);
        classes.insert(CapabilityClass::TerminalObserve, CapabilityAccess::Allow);
        classes.insert(CapabilityClass::BrowserInspect, CapabilityAccess::Allow);
        classes.insert(CapabilityClass::BrowserNavigate, CapabilityAccess::Ask);
        classes.insert(CapabilityClass::GithubInspect, CapabilityAccess::Allow);
        // Pushing, opening a pull request, and re-running CI are visible outside
        // this machine, so they are never granted without an explicit decision.
        classes.insert(CapabilityClass::GithubWrite, CapabilityAccess::Ask);
        Self {
            schema: CAPABILITY_SCHEMA_V1.into(),
            workspace_key: workspace_key.into(),
            revision: 0,
            classes,
            grants: Vec::new(),
            updated_at: Utc::now(),
        }
    }

    pub fn deny_all(workspace_key: impl Into<String>, revision: u64) -> Self {
        let mut policy = Self::defaults(workspace_key);
        for access in policy.classes.values_mut() {
            *access = CapabilityAccess::Deny;
        }
        policy.revision = revision;
        policy
    }

    /// Fill in any capability class this policy predates, using the safe
    /// default for each.
    ///
    /// A policy stored before a class existed is not malformed, it is just old.
    /// Without this, adding a class would make [`Self::validate`] reject every
    /// saved policy and silently downgrade the project to deny-all.
    pub fn with_missing_classes_defaulted(mut self) -> Self {
        let defaults = Self::defaults(self.workspace_key.clone());
        for class in ALL_CAPABILITY_CLASSES {
            self.classes
                .entry(class)
                .or_insert_with(|| defaults.access_for(class));
        }
        self
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema != CAPABILITY_SCHEMA_V1 {
            return Err(anyhow!("unsupported capability policy schema"));
        }
        if self.workspace_key.trim().is_empty() {
            return Err(anyhow!("capability policy requires a workspace key"));
        }
        for class in ALL_CAPABILITY_CLASSES {
            if !self.classes.contains_key(&class) {
                return Err(anyhow!("capability policy is missing class {class:?}"));
            }
        }
        if self.grants.len() > 256 {
            return Err(anyhow!("capability policy has too many scoped grants"));
        }
        for grant in &self.grants {
            if grant.scope_kind.trim().is_empty() || grant.scope_value.trim().is_empty() {
                return Err(anyhow!("capability grants require a non-empty scope"));
            }
            if grant.scope_kind.chars().count() > 64 || grant.scope_value.chars().count() > 4_096 {
                return Err(anyhow!("capability grant scope is too large"));
            }
        }
        Ok(())
    }

    pub fn access_for(&self, class: CapabilityClass) -> CapabilityAccess {
        self.classes
            .get(&class)
            .copied()
            .unwrap_or(CapabilityAccess::Deny)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityPolicySnapshot {
    pub schema: String,
    pub workspace_key: String,
    pub revision: u64,
    pub mode: CapabilityRunMode,
    pub classes: BTreeMap<CapabilityClass, CapabilityAccess>,
    pub grants: Vec<ProjectCapabilityGrant>,
}

impl CapabilityPolicySnapshot {
    pub fn from_policy(policy: &ProjectCapabilityPolicy, mode: CapabilityRunMode) -> Self {
        Self {
            schema: CAPABILITY_SCHEMA_V1.into(),
            workspace_key: policy.workspace_key.clone(),
            revision: policy.revision,
            mode,
            classes: policy.classes.clone(),
            grants: policy.grants.clone(),
        }
    }

    pub fn access_for(&self, class: CapabilityClass) -> CapabilityAccess {
        // Council seats are advisory-only: deny every capability so they cannot
        // pull live workspace state beyond the frozen snapshot.
        if self.mode == CapabilityRunMode::Council {
            return CapabilityAccess::Deny;
        }
        // Plan mode is an allowlist: only classes that change nothing outside
        // Gyro survive it, so any class added later is denied until listed here.
        if self.mode == CapabilityRunMode::Plan
            && !matches!(
                class,
                CapabilityClass::WorkspaceInspect
                    | CapabilityClass::WorkspaceSensitiveRead
                    | CapabilityClass::IdeReveal
                    | CapabilityClass::BrowserInspect
                    | CapabilityClass::GithubInspect
            )
        {
            return CapabilityAccess::Deny;
        }
        self.classes
            .get(&class)
            .copied()
            .unwrap_or(CapabilityAccess::Deny)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityInvocationContext {
    pub session_id: String,
    pub turn_id: Option<String>,
    pub provider_id: String,
    pub run_nonce: String,
    pub call_id: Uuid,
    pub workspace_key: String,
    pub mode: CapabilityRunMode,
    pub policy_revision: u64,
    #[serde(default)]
    pub workspace_context_revision: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContextSnapshot {
    pub schema: String,
    pub workspace_key: String,
    pub revision: u64,
    pub captured_at: DateTime<Utc>,
    pub active_path: Option<String>,
    pub active_view: Option<String>,
    #[serde(default)]
    pub visible_tabs: Vec<String>,
    pub selection: Option<Value>,
    #[serde(default)]
    pub buffers: Vec<Value>,
    #[serde(default)]
    pub diagnostics: Vec<Value>,
    #[serde(default)]
    pub test_failures: Vec<Value>,
    pub active_output: Option<Value>,
}

impl WorkspaceContextSnapshot {
    pub const SCHEMA: &'static str = "gyro.workspace-context.v1";

    pub fn empty(workspace_key: impl Into<String>) -> Self {
        Self {
            schema: Self::SCHEMA.into(),
            workspace_key: workspace_key.into(),
            revision: 0,
            captured_at: Utc::now(),
            active_path: None,
            active_view: None,
            visible_tabs: Vec::new(),
            selection: None,
            buffers: Vec::new(),
            diagnostics: Vec::new(),
            test_failures: Vec::new(),
            active_output: None,
        }
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema != Self::SCHEMA {
            return Err(anyhow!("unsupported Workspace context schema"));
        }
        if self.workspace_key.trim().is_empty() {
            return Err(anyhow!("Workspace context requires a workspace key"));
        }
        if self.visible_tabs.len() > 64
            || self.buffers.len() > 64
            || self.diagnostics.len() > 1_000
            || self.test_failures.len() > 1_000
        {
            return Err(anyhow!("Workspace context contains too many entries"));
        }
        validate_capability_result_data(serde_json::to_value(self)?)?;
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityRequest {
    pub schema: String,
    pub sender_version: String,
    pub context: CapabilityInvocationContext,
    pub capability_id: CapabilityId,
    #[serde(default)]
    pub arguments: Value,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityResourceRef {
    pub id: String,
    pub kind: String,
    pub label: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityResult {
    pub call_id: Uuid,
    pub capability_id: CapabilityId,
    pub summary: String,
    pub data: Value,
    pub resource: Option<CapabilityResourceRef>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityError {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityResponse {
    pub schema: String,
    pub app_version: String,
    pub compatible: bool,
    pub status: CapabilityStatus,
    pub call_id: Uuid,
    pub result: Option<CapabilityResult>,
    pub error: Option<CapabilityError>,
}

impl CapabilityResponse {
    pub fn completed(app_version: impl Into<String>, result: CapabilityResult) -> Self {
        Self {
            schema: PROVIDER_CAPABILITY_IPC_SCHEMA_V1.into(),
            app_version: app_version.into(),
            compatible: true,
            status: CapabilityStatus::Completed,
            call_id: result.call_id,
            result: Some(result),
            error: None,
        }
    }

    pub fn failed(
        app_version: impl Into<String>,
        call_id: Uuid,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            schema: PROVIDER_CAPABILITY_IPC_SCHEMA_V1.into(),
            app_version: app_version.into(),
            compatible: true,
            status: CapabilityStatus::Failed,
            call_id,
            result: None,
            error: Some(CapabilityError {
                code: code.into(),
                message: sanitize_capability_summary(&message.into()),
            }),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityCallEvent {
    pub schema: String,
    pub kind: String,
    pub call_id: Uuid,
    pub capability_id: CapabilityId,
    pub status: CapabilityStatus,
    pub provider_id: String,
    pub policy_revision: u64,
    pub summary: String,
    pub resource: Option<CapabilityResourceRef>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilitySupport {
    pub provider_id: String,
    pub available: bool,
    pub capabilities: Vec<CapabilityId>,
    pub reason: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CapabilityDescriptor {
    pub id: CapabilityId,
    pub class: CapabilityClass,
    pub description: &'static str,
}

pub const CAPABILITY_DESCRIPTORS: &[CapabilityDescriptor] = &[
    CapabilityDescriptor {
        id: CapabilityId::WorkspaceContext,
        class: CapabilityClass::WorkspaceInspect,
        description: "Inspect the diagnostics, failing tests, and active output channel in Gyro Workspace. The user's open file, tab list, selection, and unsaved buffer are deliberately not reported here.",
    },
    CapabilityDescriptor {
        id: CapabilityId::WorkspaceList,
        class: CapabilityClass::WorkspaceInspect,
        description: "List bounded entries inside the current Gyro project.",
    },
    CapabilityDescriptor {
        id: CapabilityId::WorkspaceSearch,
        class: CapabilityClass::WorkspaceInspect,
        description: "Search text inside the current Gyro project.",
    },
    CapabilityDescriptor {
        id: CapabilityId::WorkspaceRead,
        class: CapabilityClass::WorkspaceInspect,
        description: "Read a bounded text file inside the current Gyro project.",
    },
    CapabilityDescriptor {
        id: CapabilityId::WorkspaceReadRange,
        class: CapabilityClass::WorkspaceInspect,
        description: "Read an exact bounded line range from a text file in the current Gyro project.",
    },
    CapabilityDescriptor {
        id: CapabilityId::WorkspaceDiagnostics,
        class: CapabilityClass::WorkspaceInspect,
        description: "Read current diagnostics for the Gyro project.",
    },
    CapabilityDescriptor {
        id: CapabilityId::WorkspaceGitStatus,
        class: CapabilityClass::WorkspaceInspect,
        description: "Inspect Git status for the Gyro project.",
    },
    CapabilityDescriptor {
        id: CapabilityId::WorkspaceDiff,
        class: CapabilityClass::WorkspaceInspect,
        description: "Inspect a bounded Git diff for the Gyro project.",
    },
    CapabilityDescriptor {
        id: CapabilityId::WorkspaceProposeEdit,
        class: CapabilityClass::WorkspaceInspect,
        description: "Create a hash-guarded file edit proposal for review in Gyro Workspace without writing it directly.",
    },
    CapabilityDescriptor {
        id: CapabilityId::WorkspaceRunTask,
        class: CapabilityClass::TerminalExecute,
        description: "Run one discovered Workspace task with visible, attributed output.",
    },
    CapabilityDescriptor {
        id: CapabilityId::WorkspaceRunTest,
        class: CapabilityClass::TerminalExecute,
        description: "Run one discovered Workspace test task with visible, attributed output.",
    },
    CapabilityDescriptor {
        id: CapabilityId::WorkspaceReadOutput,
        class: CapabilityClass::TerminalObserve,
        description: "Read bounded task, test, or terminal output currently recorded by Gyro Workspace.",
    },
    CapabilityDescriptor {
        id: CapabilityId::IdeReveal,
        class: CapabilityClass::IdeReveal,
        description: "Create a link that reveals a saved file and range in Gyro Workspace.",
    },
    CapabilityDescriptor {
        id: CapabilityId::IdeOpenPanel,
        class: CapabilityClass::IdeReveal,
        description: "Open a trusted Gyro Workspace panel such as Diff, Problems, Test Results, Terminal, Output, or Browser.",
    },
    CapabilityDescriptor {
        id: CapabilityId::TerminalOpen,
        class: CapabilityClass::TerminalExecute,
        description: "Open one visible, model-owned long-running process in Gyro Terminal.",
    },
    CapabilityDescriptor {
        id: CapabilityId::TerminalRead,
        class: CapabilityClass::TerminalObserve,
        description: "Read bounded output from this chat's model-owned terminal.",
    },
    CapabilityDescriptor {
        id: CapabilityId::TerminalStop,
        class: CapabilityClass::TerminalExecute,
        description: "Stop this chat's model-owned terminal process.",
    },
    CapabilityDescriptor {
        id: CapabilityId::BrowserOpen,
        class: CapabilityClass::BrowserNavigate,
        description: "Open an approved loopback preview in Gyro Browser.",
    },
    CapabilityDescriptor {
        id: CapabilityId::BrowserInspect,
        class: CapabilityClass::BrowserInspect,
        description: "Inspect status and redacted diagnostics for this chat's loopback preview.",
    },
    CapabilityDescriptor {
        id: CapabilityId::BrowserReload,
        class: CapabilityClass::BrowserNavigate,
        description: "Reload this chat's loopback preview.",
    },
    CapabilityDescriptor {
        id: CapabilityId::BrowserScreenshot,
        class: CapabilityClass::BrowserInspect,
        description: "Capture this chat's loopback preview.",
    },
    CapabilityDescriptor {
        id: CapabilityId::GithubStatus,
        class: CapabilityClass::GithubInspect,
        description: "Check whether GitHub is reachable for this project and which repository and account it resolves to.",
    },
    CapabilityDescriptor {
        id: CapabilityId::GithubPullRequests,
        class: CapabilityClass::GithubInspect,
        description: "List open pull requests for this project with their check status.",
    },
    CapabilityDescriptor {
        id: CapabilityId::GithubWorkflowRuns,
        class: CapabilityClass::GithubInspect,
        description: "List recent GitHub Actions workflow runs for this project, optionally filtered to one branch.",
    },
    CapabilityDescriptor {
        id: CapabilityId::GithubWorkflowLogs,
        class: CapabilityClass::GithubInspect,
        description: "Read bounded logs for one GitHub Actions run, defaulting to only the failed steps.",
    },
    CapabilityDescriptor {
        id: CapabilityId::GithubCreatePullRequest,
        class: CapabilityClass::GithubWrite,
        description: "Open a pull request for the current branch. Visible to collaborators once created.",
    },
    CapabilityDescriptor {
        id: CapabilityId::GithubRerunWorkflow,
        class: CapabilityClass::GithubWrite,
        description: "Re-run a GitHub Actions run, optionally only its failed jobs. Consumes Actions minutes.",
    },
    CapabilityDescriptor {
        id: CapabilityId::GithubPush,
        class: CapabilityClass::GithubWrite,
        description: "Push the current branch to its remote. Publishes local commits to GitHub.",
    },
];

pub const ALL_CAPABILITY_CLASSES: [CapabilityClass; 9] = [
    CapabilityClass::WorkspaceInspect,
    CapabilityClass::WorkspaceSensitiveRead,
    CapabilityClass::IdeReveal,
    CapabilityClass::TerminalExecute,
    CapabilityClass::TerminalObserve,
    CapabilityClass::BrowserInspect,
    CapabilityClass::BrowserNavigate,
    CapabilityClass::GithubInspect,
    CapabilityClass::GithubWrite,
];

pub fn capability_descriptor(id: CapabilityId) -> &'static CapabilityDescriptor {
    CAPABILITY_DESCRIPTORS
        .iter()
        .find(|descriptor| descriptor.id == id)
        .expect("every capability id has a descriptor")
}

/// Which Gyro capability tools a provider can be given.
///
/// Every provider that runs a real chat adapter receives the tools: the Codex
/// and Claude CLIs load the capability MCP server from their own config, and the
/// ACP providers get it through `session/new`. Readiness-only providers have no
/// chat runner at all, so there is nowhere to attach tools.
pub fn provider_capability_support(provider_id: &str) -> ProviderCapabilitySupport {
    let available = matches!(
        provider_id,
        "openai" | "anthropic" | "kimi" | "xai" | "gemini"
    );
    ProviderCapabilitySupport {
        provider_id: provider_id.into(),
        available,
        capabilities: if available {
            CAPABILITY_DESCRIPTORS.iter().map(|item| item.id).collect()
        } else {
            Vec::new()
        },
        reason: (!available)
            .then(|| "Gyro tools need a provider that runs a chat session on this device.".into()),
    }
}

pub fn normalize_capability_relative_path(path: &str) -> Result<String> {
    let path = path.trim().replace('\\', "/");
    if path.is_empty() {
        return Err(anyhow!("path is required"));
    }
    let candidate = Path::new(&path);
    if candidate.is_absolute()
        || candidate.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(anyhow!("path must stay inside the current workspace"));
    }
    let normalized = candidate
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/");
    if normalized.is_empty() {
        return Err(anyhow!("path is required"));
    }
    Ok(normalized)
}

pub fn capability_path_is_sensitive(path: &str) -> bool {
    let normalized = path.trim().replace('\\', "/").to_ascii_lowercase();
    let file_name = normalized.rsplit('/').next().unwrap_or(&normalized);
    file_name == ".env"
        || file_name.starts_with(".env.")
        || matches!(
            file_name,
            "id_rsa"
                | "id_ed25519"
                | "credentials"
                | "credentials.json"
                | "secrets.json"
                | ".npmrc"
                | ".pypirc"
                | ".netrc"
        )
        || file_name.ends_with(".pem")
        || file_name.ends_with(".key")
        || normalized.starts_with(".git/")
        || normalized.contains("/.git/")
}

pub fn sanitize_capability_summary(value: &str) -> String {
    redact_secrets(value)
        .chars()
        .take(MAX_CAPABILITY_SUMMARY_CHARS)
        .collect()
}

pub fn validate_capability_result_data(value: Value) -> Result<Value> {
    let encoded = serde_json::to_vec(&value)?;
    if encoded.len() > MAX_CAPABILITY_RESULT_BYTES {
        return Err(anyhow!(
            "capability result exceeded the {MAX_CAPABILITY_RESULT_BYTES} byte limit"
        ));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_tool_names_round_trip() {
        for descriptor in CAPABILITY_DESCRIPTORS {
            assert_eq!(
                CapabilityId::from_provider_tool_name(descriptor.id.provider_tool_name()),
                Some(descriptor.id)
            );
        }
    }

    #[test]
    fn workspace_context_is_versioned_and_bounded() {
        let mut context = WorkspaceContextSnapshot::empty("/tmp/project");
        context.active_path = Some("src/main.rs".into());
        context.visible_tabs = vec!["src/main.rs".into()];
        context.validate().unwrap();

        context.schema = "gyro.workspace-context.v0".into();
        assert!(context.validate().is_err());
    }

    #[test]
    fn project_policy_defaults_are_conservative() {
        let policy = ProjectCapabilityPolicy::defaults("/tmp/project");
        assert_eq!(
            policy.access_for(CapabilityClass::WorkspaceInspect),
            CapabilityAccess::Allow
        );
        assert_eq!(
            policy.access_for(CapabilityClass::WorkspaceSensitiveRead),
            CapabilityAccess::Ask
        );
        assert_eq!(
            policy.access_for(CapabilityClass::TerminalExecute),
            CapabilityAccess::Ask
        );
        policy.validate().unwrap();
    }

    #[test]
    fn plan_mode_is_a_hard_capability_ceiling() {
        let mut policy = ProjectCapabilityPolicy::defaults("/tmp/project");
        for value in policy.classes.values_mut() {
            *value = CapabilityAccess::Allow;
        }
        let snapshot = CapabilityPolicySnapshot::from_policy(&policy, CapabilityRunMode::Plan);
        assert_eq!(
            snapshot.access_for(CapabilityClass::WorkspaceInspect),
            CapabilityAccess::Allow
        );
        assert_eq!(
            snapshot.access_for(CapabilityClass::TerminalExecute),
            CapabilityAccess::Deny
        );
        assert_eq!(
            snapshot.access_for(CapabilityClass::BrowserNavigate),
            CapabilityAccess::Deny
        );
        // Reading CI and PR state changes nothing, so it survives Plan mode...
        assert_eq!(
            snapshot.access_for(CapabilityClass::GithubInspect),
            CapabilityAccess::Allow
        );
        // ...while pushing and opening pull requests never do.
        assert_eq!(
            snapshot.access_for(CapabilityClass::GithubWrite),
            CapabilityAccess::Deny
        );
    }

    #[test]
    fn council_mode_denies_every_capability_class() {
        let mut policy = ProjectCapabilityPolicy::defaults("/tmp/project");
        for value in policy.classes.values_mut() {
            *value = CapabilityAccess::Allow;
        }
        let snapshot = CapabilityPolicySnapshot::from_policy(&policy, CapabilityRunMode::Council);
        assert_eq!(
            snapshot.access_for(CapabilityClass::WorkspaceInspect),
            CapabilityAccess::Deny
        );
        assert_eq!(
            snapshot.access_for(CapabilityClass::WorkspaceSensitiveRead),
            CapabilityAccess::Deny
        );
        assert_eq!(
            snapshot.access_for(CapabilityClass::TerminalExecute),
            CapabilityAccess::Deny
        );
        assert_eq!(
            snapshot.access_for(CapabilityClass::GithubInspect),
            CapabilityAccess::Deny
        );
    }

    #[test]
    fn every_chat_capable_provider_can_receive_tools() {
        // Providers that run a chat adapter get the tools; readiness-only
        // providers have no runner to attach an MCP server to.
        for provider_id in ["openai", "anthropic", "kimi", "xai", "gemini"] {
            let support = provider_capability_support(provider_id);
            assert!(support.available, "{provider_id} should support Gyro tools");
            assert_eq!(support.capabilities.len(), CAPABILITY_DESCRIPTORS.len());
            assert!(support.reason.is_none());
        }
        for provider_id in ["cursor", "opencode", "unknown"] {
            let support = provider_capability_support(provider_id);
            assert!(
                !support.available,
                "{provider_id} has no chat runner and cannot host tools"
            );
            assert!(support.capabilities.is_empty());
            assert!(support.reason.is_some());
        }
    }

    #[test]
    fn github_write_capabilities_are_never_allowed_by_default() {
        let policy = ProjectCapabilityPolicy::defaults("/tmp/project");
        assert_eq!(
            policy.access_for(CapabilityClass::GithubInspect),
            CapabilityAccess::Allow
        );
        // Pushing, opening a PR, and re-running CI are visible outside this
        // machine, so they must require a decision.
        assert_eq!(
            policy.access_for(CapabilityClass::GithubWrite),
            CapabilityAccess::Ask
        );
        for descriptor in CAPABILITY_DESCRIPTORS {
            let outward = matches!(
                descriptor.id,
                CapabilityId::GithubCreatePullRequest
                    | CapabilityId::GithubRerunWorkflow
                    | CapabilityId::GithubPush
            );
            assert_eq!(
                descriptor.class == CapabilityClass::GithubWrite,
                outward,
                "{} is classified incorrectly",
                descriptor.id
            );
        }
    }

    #[test]
    fn capability_paths_reject_escape_and_classify_sensitive_files() {
        assert!(normalize_capability_relative_path("../secret").is_err());
        assert!(normalize_capability_relative_path("/tmp/secret").is_err());
        assert_eq!(
            normalize_capability_relative_path("src\\main.rs").unwrap(),
            "src/main.rs"
        );
        assert!(capability_path_is_sensitive(".env.local"));
        assert!(capability_path_is_sensitive("config/private.pem"));
        assert!(!capability_path_is_sensitive("src/main.rs"));
    }
}
