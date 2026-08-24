pub mod account;
pub mod automations;
pub mod capabilities;
pub mod cli_path;
pub mod cli_updates;
pub mod config;
pub mod council;
pub mod diff;
pub mod doctor;
pub mod execution;
pub mod github;
pub mod harness;
pub mod ipc;
pub mod keychain;
pub mod kimi_acp;
pub mod mutations;
pub mod paths;
pub mod policy;
pub mod provider_contract;
pub mod provider_health;
pub mod provider_registry;
pub mod provider_stream;
pub mod security;
pub mod sessions;
pub mod sqlite;
pub mod usage;
pub mod worktrees;

pub use account::{
    generate_pkce_flow, logout_account, refresh_account_session, start_account_login,
    stored_account_session, token_storage_key, PkceFlow,
};
pub use automations::{
    Automation, AutomationExecutionContext, AutomationRun, AutomationRunStatus, AutomationSchedule,
    AutomationStatus, AutomationStore, AutomationTriageState, CreateAutomationRequest,
};
pub use capabilities::{
    capability_descriptor, capability_path_is_sensitive, normalize_capability_relative_path,
    provider_capability_support, sanitize_capability_summary, validate_capability_result_data,
    CapabilityAccess, CapabilityApprovalDecision, CapabilityCallEvent, CapabilityClass,
    CapabilityDescriptor, CapabilityError, CapabilityId, CapabilityInvocationContext,
    CapabilityPolicySnapshot, CapabilityRequest, CapabilityResourceRef, CapabilityResponse,
    CapabilityResult, CapabilityRunMode, CapabilityStatus, ProjectCapabilityGrant,
    ProjectCapabilityPolicy, ProviderCapabilitySupport, WorkspaceContextSnapshot,
    CAPABILITY_DESCRIPTORS, CAPABILITY_SCHEMA_V1, MAX_CAPABILITY_RESULT_BYTES,
    PROVIDER_CAPABILITY_IPC_SCHEMA_V1,
};
pub use cli_path::{augmented_gui_path, user_cli_paths};
pub use cli_updates::{
    apply_cli_updates, check_cli_updates, CliUpdateApplyResult, CliUpdateCheckReport,
    CliUpdateOffer,
};
pub use config::{
    AccountOidcConfig, AccountSessionState, CommandProfile, CommandProfileReadiness, GyroConfig,
    ModelProviderConfig,
};
pub use council::{
    barrier_decision, build_synthesizer_user_prompt, built_in_council_presets,
    council_capability_allowed, council_run_dir, ensure_council_run_dir, final_run_status,
    parse_council_synthesis, read_council_run_manifest, read_seat_artifact, resolve_ready_seats,
    seat_label_map, successful_seat_answers, validate_seat_count, write_council_run_manifest,
    write_council_snapshot, write_seat_artifact, write_synthesis_artifact, CouncilAttachmentRef,
    CouncilBarrierDecision, CouncilConfig, CouncilContextSnapshot, CouncilDisagreement,
    CouncilDisagreementPosition, CouncilPreset, CouncilRun, CouncilRunStatus, CouncilRunTotals,
    CouncilSeat, CouncilSeatAnswer, CouncilSeatStatus, CouncilSynthesis, CouncilToolPolicy,
    CouncilUniqueInsight, COUNCIL_MAX_SEATS, COUNCIL_MIN_SEATS, COUNCIL_SCHEMA_V1,
    DEFAULT_SEAT_TIMEOUT_SECONDS, DEFAULT_SYNTHESIZER_TIMEOUT_SECONDS, SYNTHESIZER_SYSTEM_PROMPT,
};
pub use doctor::{DoctorCheck, DoctorReport, DoctorStatus};
pub use execution::{
    run_command, CancellationToken, ExecutionChunk, ExecutionOutcome, ExecutionRequest,
    ExecutionStream, ExecutionTermination,
};
pub use github::{
    create_pull_request, github_availability, list_pull_requests, list_workflow_runs,
    pull_request_for_branch, rerun_workflow, workflow_run_detail, workflow_run_logs,
    CreatePullRequestRequest, GithubAvailability, GithubPullRequest, GithubRunState,
    GithubWorkflowJob, GithubWorkflowRun, GithubWorkflowRunDetail, GithubWorkflowStep,
    GITHUB_SCHEMA_V1, MAX_PULL_REQUESTS, MAX_WORKFLOW_RUNS,
};
pub use harness::{
    decode_provider_resume_cursor, harness_payload_value, sanitize_harness_text,
    validate_harness_payload_value, validate_mutation_approval_policy,
    validate_provider_resume_cursor_value, ApprovalRequestPayload, DiffProposalPayload,
    FileEditProposalPayload, HarnessRunStatus, ProviderDiagnosticsPayload,
    ProviderResumeCursorPayload, ProviderRunPayload, TerminalRequestPayload, HARNESS_SCHEMA_V1,
};
pub use ipc::{
    request_desktop_provider_capability, AppNotification, AppNotificationKind,
    DesktopProviderApprovalBehavior, DesktopProviderApprovalRequest,
    DesktopProviderApprovalResponse, DESKTOP_PROVIDER_APPROVAL_IPC_SCHEMA_V1,
};
pub use kimi_acp::{
    check_acp_health, check_kimi_acp_health, run_kimi_acp, KimiAcpActivity,
    KimiAcpApprovalDecision, KimiAcpApprovalKind, KimiAcpApprovalRequest, KimiAcpHealth,
    KimiAcpHealthStatus, KimiAcpMode, KimiAcpOutput, KimiAcpRequest,
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
pub use provider_contract::{
    audit_provider_args, executable_provider_contracts, is_cli_argument_error, probe_provider_args,
    provider_cli_contract, provider_cli_contracts, stream_contract_failure, ArgAcceptance,
    ArgContractViolation, PromptDelivery, ProviderCliContract, ARG_CONTRACT_MARKER, ARG_TERMINATOR,
    PROVIDER_ARG_PROBE_TIMEOUT, STREAM_CONTRACT_MARKER,
};
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
    ProviderSessionBinding, Session, SessionEvent, SessionEventKind, SessionEventPage,
    SessionOrigin, SessionStore, SessionWorkspaceMode,
};
pub use sqlite::{
    checkpoint_wal_passive, configure_connection, is_busy_error, open_private_database,
    optimize_connection, quick_check, with_busy_retry, with_busy_retry_n, DEFAULT_BUSY_RETRIES,
    DEFAULT_BUSY_TIMEOUT,
};
pub use usage::{
    budget_decision, budget_state, call_ceiling_tokens, estimate_tokens, exceeds_call_ceiling,
    guard_decision, provider_rate_limits, provider_usage_totals_since, recent_usage,
    record_provider_rate_limits, replace_provider_rate_limits, session_usage_totals,
    set_provider_budget, usage_totals_since, BudgetLevel, BudgetState, GuardVerdict, PauseReason,
    PauseScope, PauseState, ProviderRateLimitRecord, RecentUsage, UsageBudget, UsageEntry,
    UsageGuardConfig, UsageOrigin, UsageOriginTotals, UsageOutcome, UsageTokens, UsageTotals,
};
pub use worktrees::{
    create_worktree, git_top_level, slugify as slugify_worktree_name, validate_branch_name,
    validate_worktree_name, WorktreeSessionPlan,
};
