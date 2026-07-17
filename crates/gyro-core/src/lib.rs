pub mod account;
pub mod automations;
pub mod config;
pub mod diff;
pub mod doctor;
pub mod execution;
pub mod harness;
pub mod ipc;
pub mod keychain;
pub mod kimi_acp;
pub mod mutations;
pub mod paths;
pub mod policy;
pub mod provider_health;
pub mod provider_registry;
pub mod provider_stream;
pub mod security;
pub mod sessions;
pub mod worktrees;

pub use account::{
    generate_pkce_flow, logout_account, refresh_account_session, start_account_login,
    stored_account_session, token_storage_key, PkceFlow,
};
pub use automations::{
    Automation, AutomationExecutionContext, AutomationRun, AutomationRunStatus, AutomationSchedule,
    AutomationStatus, AutomationStore, AutomationTriageState, CreateAutomationRequest,
};
pub use config::{
    AccountOidcConfig, AccountSessionState, CommandProfile, CommandProfileReadiness, GyroConfig,
    ModelProviderConfig,
};
pub use doctor::{DoctorCheck, DoctorReport, DoctorStatus};
pub use execution::{
    run_command, CancellationToken, ExecutionChunk, ExecutionOutcome, ExecutionRequest,
    ExecutionStream, ExecutionTermination,
};
pub use harness::{
    decode_provider_resume_cursor, harness_payload_value, sanitize_harness_text,
    validate_harness_payload_value, validate_mutation_approval_policy,
    validate_provider_resume_cursor_value, ApprovalRequestPayload, DiffProposalPayload,
    FileEditProposalPayload, HarnessRunStatus, ProviderDiagnosticsPayload,
    ProviderResumeCursorPayload, ProviderRunPayload, TerminalRequestPayload, HARNESS_SCHEMA_V1,
};
pub use ipc::{
    AppNotification, AppNotificationKind, DesktopProviderApprovalBehavior,
    DesktopProviderApprovalRequest, DesktopProviderApprovalResponse,
    DESKTOP_PROVIDER_APPROVAL_IPC_SCHEMA_V1,
};
pub use kimi_acp::{
    check_kimi_acp_health, run_kimi_acp, KimiAcpActivity, KimiAcpApprovalDecision,
    KimiAcpApprovalKind, KimiAcpApprovalRequest, KimiAcpHealth, KimiAcpHealthStatus, KimiAcpMode,
    KimiAcpOutput, KimiAcpRequest,
};
pub use mutations::{
    apply_provider_mutation_transaction, apply_provider_mutation_transaction_with_cancellation,
    begin_provider_mutation_transaction, begin_provider_mutation_transaction_with_cancellation,
    decide_mutation_proposal, decide_mutation_proposal_with_cancellation,
    mutation_approval_payload, mutation_decision_was_cancelled,
    prepare_claude_provider_mutation_transaction, prepare_provider_mutation_transaction,
    prepare_provider_text_replacement_transaction, recover_provider_mutation_transactions,
    review_mutation_proposal, MutationDecision, MutationDecisionResult, MutationReview,
    PendingProviderMutationCommit, PreparedProviderMutationTransaction, ProviderFileChange,
    ProviderFileChangeKind, ProviderMutationJournalContext, ProviderMutationRecoveryReport,
    ProviderMutationResult,
};
pub use paths::GyroPaths;
pub use policy::{CommandDecision, PermissionPolicy};
pub use provider_health::{
    provider_account_label, provider_mode_label, provider_runtime_status_from_output,
    provider_subscription_label, should_skip_codex_login_for_external_env, ProviderHealthCheck,
    ProviderHealthRequest, ProviderHealthService,
};
pub use provider_registry::{
    provider_descriptor, provider_is_executable, provider_registry, ProviderDescriptor,
    ProviderExecutionKind, ProviderHealthKind,
};
pub use provider_stream::{
    extract_codex_agent_message_text, extract_provider_session_id, extract_provider_text_chunk,
    extract_provider_text_value, ProviderTextChunk,
};
pub use sessions::{
    CreateSessionContext, MutationProposal, MutationProposalOperation, MutationProposalStatus,
    ProviderSessionBinding, Session, SessionEvent, SessionEventKind, SessionOrigin, SessionStore,
    SessionWorkspaceMode,
};
pub use worktrees::{
    create_worktree, git_top_level, slugify as slugify_worktree_name, validate_branch_name,
    validate_worktree_name, WorktreeSessionPlan,
};
