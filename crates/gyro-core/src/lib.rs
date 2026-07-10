pub mod account;
pub mod automations;
pub mod config;
pub mod diff;
pub mod doctor;
pub mod harness;
pub mod ipc;
pub mod keychain;
pub mod paths;
pub mod policy;
pub mod security;
pub mod sessions;
pub mod worktrees;

pub use account::{
    generate_pkce_flow, logout_account, refresh_account_session, start_account_login,
    stored_account_session, token_storage_key, PkceFlow,
};
pub use automations::{
    Automation, AutomationRun, AutomationRunStatus, AutomationSchedule, AutomationStatus,
    AutomationStore, AutomationTriageState, CreateAutomationRequest,
};
pub use config::{
    AccountOidcConfig, AccountSessionState, CommandProfile, CommandProfileReadiness, GyroConfig,
    ModelProviderConfig, UpdateChannel,
};
pub use doctor::{DoctorCheck, DoctorReport, DoctorStatus};
pub use harness::{
    decode_provider_resume_cursor, harness_payload_value, sanitize_harness_text,
    validate_harness_payload_value, validate_mutation_approval_policy,
    validate_provider_resume_cursor_value, ApprovalRequestPayload, DiffProposalPayload,
    FileEditProposalPayload, HarnessRunStatus, ProviderDiagnosticsPayload,
    ProviderResumeCursorPayload, ProviderRunPayload, TerminalRequestPayload, HARNESS_SCHEMA_V1,
};
pub use ipc::{AppNotification, AppNotificationKind};
pub use paths::GyroPaths;
pub use policy::{CommandDecision, PermissionPolicy};
pub use sessions::{
    CreateSessionContext, ProviderSessionBinding, Session, SessionEvent, SessionEventKind,
    SessionOrigin, SessionStore, SessionWorkspaceMode,
};
pub use worktrees::{
    create_worktree, git_top_level, slugify as slugify_worktree_name, validate_branch_name,
    validate_worktree_name, WorktreeSessionPlan,
};
