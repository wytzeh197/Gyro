pub mod automations;
pub mod config;
pub mod diff;
pub mod doctor;
pub mod ipc;
pub mod keychain;
pub mod paths;
pub mod policy;
pub mod security;
pub mod sessions;
pub mod worktrees;

pub use automations::{
    Automation, AutomationRun, AutomationRunStatus, AutomationSchedule, AutomationStatus,
    AutomationStore, AutomationTriageState, CreateAutomationRequest,
};
pub use config::{CommandProfile, GyroConfig, ModelProviderConfig, UpdateChannel};
pub use doctor::{DoctorCheck, DoctorReport, DoctorStatus};
pub use ipc::{AppNotification, AppNotificationKind};
pub use paths::GyroPaths;
pub use policy::{CommandDecision, PermissionPolicy};
pub use sessions::{
    CreateSessionContext, Session, SessionEvent, SessionEventKind, SessionOrigin, SessionStore,
    SessionWorkspaceMode,
};
pub use worktrees::{
    create_worktree, git_top_level, slugify as slugify_worktree_name, validate_branch_name,
    validate_worktree_name, WorktreeSessionPlan,
};
