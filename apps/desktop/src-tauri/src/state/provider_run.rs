//! State provider_run.

use crate::{
    provider_spend_guard, provider_timeline, session_title_stream, ProviderCancellationManager,
    ProviderChatRequest,
};
use gyro_core::{
    timing, CancellationToken, CapabilityApprovalDecision, CapabilityPolicySnapshot,
    CapabilityResourceRef, PreparedProviderMutationTransaction, UsageTokens, WorkspaceCheckReport,
    WorkspaceContextSnapshot,
};
use serde::Serialize;
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64},
        mpsc, Mutex,
    },
};
use tauri::Manager;
use uuid::Uuid;
pub(crate) struct PendingProviderApproval {
    pub(crate) sender: mpsc::Sender<ProviderApprovalDecision>,
    pub(crate) approval_id: Uuid,
    pub(crate) session_id: Uuid,
    pub(crate) turn_id: Option<Uuid>,
    pub(crate) payload: serde_json::Value,
    pub(crate) file_transaction: Option<PreparedProviderMutationTransaction>,
}

pub(crate) struct PendingCapabilityApproval {
    pub(crate) sender: mpsc::Sender<CapabilityApprovalDecision>,
    pub(crate) session_id: Uuid,
    pub(crate) turn_id: Option<Uuid>,
}

#[derive(Clone)]
pub(crate) struct BoundProviderCapabilityContext {
    pub(crate) session_id: String,
    pub(crate) turn_id: Option<String>,
    pub(crate) provider_id: String,
    pub(crate) provider_kind: Option<String>,
    pub(crate) workspace: PathBuf,
    pub(crate) workspace_key: String,
    pub(crate) workspace_identity_revision: u64,
    pub(crate) allow_delegation: bool,
    pub(crate) policy: CapabilityPolicySnapshot,
    pub(crate) workspace_context: WorkspaceContextSnapshot,
    pub(crate) workspace_check: WorkspaceCheckReport,
}

#[derive(Clone)]
pub(crate) struct ModelTerminalResource {
    pub(crate) resource_id: String,
    pub(crate) pane_id: String,
    pub(crate) session_id: String,
    pub(crate) turn_id: Option<String>,
    pub(crate) call_id: Uuid,
    pub(crate) workspace_key: String,
}

#[derive(Clone)]
pub(crate) struct ModelBrowserResource {
    pub(crate) resource_id: String,
    pub(crate) session_id: String,
    pub(crate) turn_id: Option<String>,
    pub(crate) call_id: Uuid,
    pub(crate) workspace_key: String,
    pub(crate) url: String,
}

#[derive(Clone, Debug)]
pub(crate) struct ProviderApprovalContext {
    pub(crate) session_id: String,
    pub(crate) turn_id: Option<String>,
    pub(crate) provider_id: String,
    pub(crate) provider_label: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderApprovalNotificationOpen {
    pub(crate) session_id: String,
    pub(crate) approval_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderCapabilityResourceEvent {
    pub(crate) session_id: String,
    pub(crate) turn_id: Option<String>,
    pub(crate) call_id: Uuid,
    pub(crate) resource: CapabilityResourceRef,
    pub(crate) data: serde_json::Value,
}

impl From<&ProviderChatRequest> for ProviderApprovalContext {
    fn from(request: &ProviderChatRequest) -> Self {
        Self {
            session_id: request.session_id.clone(),
            turn_id: request.turn_id.clone(),
            provider_id: request.provider_id.clone(),
            provider_label: request.provider_label.clone(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProviderApprovalDecision {
    Approve,
    Reject,
    AppliedByGyro,
}

pub(crate) struct ProviderRunControl {
    pub(crate) cancellation: CancellationToken,
    /// Why this run was stopped, recorded beside the token that stopped it.
    ///
    /// The token only carries "stopped". Without the reason next to it, a
    /// ceiling Gyro enforced and a person pressing stop reach the chat as the
    /// same bare "was cancelled", and the advice offered is a retry -- which is
    /// the one thing that cannot work against a ceiling the retry will hit
    /// again.
    pub(crate) stop_reason: Mutex<Option<ProviderStopReason>>,
    pub(crate) next_event_sequence: AtomicU64,
    pub(crate) timeline: Mutex<provider_timeline::ProviderTimeline>,
    pub(crate) suggested_title: Mutex<(Option<String>, bool)>,
    pub(crate) title_stream: Mutex<session_title_stream::SessionTitleStream>,
    pub(crate) approval_nonce: String,
    pub(crate) capability_context: Mutex<Option<BoundProviderCapabilityContext>>,
    pub(crate) capability_calls: Mutex<HashSet<Uuid>>,
    pub(crate) completed_mutations: AtomicBool,
    pub(crate) timing: Mutex<timing::Handle>,
    pub(crate) process_owner: Mutex<Option<gyro_core::process_guard::ProcessOwner>>,
    pub(crate) request: Mutex<Option<ProviderChatRequest>>,
    pub(crate) usage_offset: Mutex<Option<UsageTokens>>,
    pub(crate) spend_guard: Mutex<Option<provider_spend_guard::TurnSpendGuard>>,
    pub(crate) goal_token_budget: Mutex<Option<(u64, u64)>>,
    pub(crate) efficiency_progress: Mutex<gyro_core::efficiency::progress::Detector>,
    pub(crate) efficiency_checkpoint:
        Mutex<Option<gyro_core::efficiency::checkpoint::TaskCheckpoint>>,
}

impl Default for ProviderRunControl {
    fn default() -> Self {
        Self {
            cancellation: CancellationToken::default(),
            stop_reason: Mutex::new(None),
            next_event_sequence: AtomicU64::new(0),
            timeline: Mutex::new(provider_timeline::ProviderTimeline::default()),
            suggested_title: Mutex::new((None, false)),
            title_stream: Mutex::new(Default::default()),
            approval_nonce: Uuid::new_v4().to_string(),
            capability_context: Mutex::new(None),
            capability_calls: Mutex::new(HashSet::new()),
            completed_mutations: AtomicBool::new(false),
            timing: Mutex::new(timing::Handle::default()),
            process_owner: Mutex::new(None),
            request: Mutex::new(None),
            usage_offset: Mutex::new(None),
            spend_guard: Mutex::new(None),
            goal_token_budget: Mutex::new(None),
            efficiency_progress: Mutex::new(Default::default()),
            efficiency_checkpoint: Mutex::new(None),
        }
    }
}

/// The phrase every stop message opens with.
///
/// A stop travels the rest of the way as an error string, and several places
/// have to tell one from a genuine failure. They match this rather than the
/// whole sentence so the sentence stays free to say what actually happened.
pub(crate) const PROVIDER_STOP_MARKER: &str = "chat cancelled by";
/// The stable phrase of a turn Gyro ended because the provider went silent.
pub(crate) const PROVIDER_STALL_MARKER: &str = "the provider sent nothing for";

/// The sentence a turn is closed with when Gyro exited while it was running.
///
/// Written by startup reconciliation rather than by the run itself, which by
/// definition never got to report anything. It doubles as the classifier for
/// the matching recovery hint, so it is matched exactly instead of by keyword:
/// the words in it ("running", "closed") are ordinary enough to appear in a
/// provider's own failure text.
pub(crate) const PROVIDER_INTERRUPTED_MARKER: &str =
    "Gyro closed while this turn was running, so it never finished.";

/// The notice attached to a turn that stopped at its tool-round budget.
///
/// The turn itself succeeded -- the model's checkpoint is the reply -- so this
/// rides the completion status's recovery kind, which the transcript renders
/// next to that checkpoint. It is persisted, so it survives a reload.
pub(crate) const PROVIDER_TOOL_BUDGET_NOTICE: &str =
    "Gyro stopped offering tools at this turn's round budget.";

/// The notice attached to a turn whose answer was kept even though the provider
/// did not get to finish it: it exited early, or it ran out of room at the
/// model's own output limit. Matched by its stable phrase.
pub(crate) const PROVIDER_CUT_OFF_NOTICE: &str =
    "The provider stopped before it finished, so this answer may be cut off.";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProviderStopReason {
    User,
    NoProgress,
    /// Gyro cut the call short against the per-call token ceiling.
    CallTokenCeiling {
        spent: u64,
        ceiling: u64,
    },
    ProviderTokenBudget {
        used: u64,
        limit: u64,
    },
    GoalDeadline,
    GoalTokenBudget {
        used: u64,
        limit: u64,
    },
    /// Gyro ended a run that went silent with no tool or approval pending.
    Stalled {
        silent_minutes: u64,
    },
}

impl ProviderStopReason {
    pub(crate) fn message(&self) -> String {
        match self {
            Self::User => format!("{PROVIDER_STOP_MARKER} user"),
            Self::NoProgress => format!("{PROVIDER_STOP_MARKER} Gyro: repeated unchanged tool results; review the task checkpoint and resume with a changed approach."),
            Self::CallTokenCeiling { spent, ceiling } => format!(
                "{PROVIDER_STOP_MARKER} Gyro: this turn spent {spent} tokens of new input and output, \
                 past the {ceiling} token per-call ceiling."
            ),
            Self::GoalDeadline => format!("{PROVIDER_STOP_MARKER} Gyro: the goal reached its time limit; review the checkpoint before resuming."),
            Self::GoalTokenBudget { used, limit } => format!("{PROVIDER_STOP_MARKER} Gyro: the goal reached its new-token limit ({used} of {limit}); review the checkpoint before resuming."),
            Self::ProviderTokenBudget { used, limit } => format!(
                "{PROVIDER_STOP_MARKER} Gyro: this provider's rolling token budget is spent ({used} of {limit} tokens)."
            ),
            // Deliberately without the stop marker: nobody chose to stop this
            // turn, so it is reported as a failure the user can send again.
            Self::Stalled { silent_minutes } => format!(
                "Gyro ended this turn: {PROVIDER_STALL_MARKER} {silent_minutes} \
                 minutes with no tool or approval pending."
            ),
        }
    }
}

/// Note why a run is being stopped, then stop it.
///
/// The reason is written before the token is cancelled so the run thread, which
/// can observe the cancellation on its very next poll, never finds a stopped
/// run with nothing to say about it.
pub(crate) fn stop_provider_run(
    app: &tauri::AppHandle,
    session_id: &str,
    reason: ProviderStopReason,
) -> bool {
    let manager = app.state::<ProviderCancellationManager>();
    let Ok(flags) = manager.flags.lock() else {
        return false;
    };
    let Some(control) = flags.get(session_id) else {
        return false;
    };
    if let Ok(mut stop_reason) = control.stop_reason.lock() {
        stop_reason.get_or_insert(reason);
    }
    control.cancellation.cancel();
    true
}
