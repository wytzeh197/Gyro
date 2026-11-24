//! Explicit v2 pilot. Serial runs preserve budgets and avoid cross-variant cache/config races.
use crate::{
    command_execution::run_bounded_command, ipc::cli::start_cli_ipc_listener,
    providers::process::command_with_gui_path,
};
use gyro_core::efficiency::pricing::PriceSnapshot;
use gyro_core::{
    decide_mutation_proposal, CapabilityAccess, CapabilityClass, ExecutionTermination, GyroConfig,
    GyroPaths, MutationDecision, ProjectCapabilityPolicy, Session, SessionOrigin, SessionStore,
    UsageTokens,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};
use uuid::Uuid;

#[path = "efficiency_benchmark/verification.rs"]
mod verification;
pub(crate) use verification::capture_verification_start;

// The isolated benchmark process executes one fixture at a time. A smaller
// harness window gives the long-session cases a reproducible compaction stress.
static CONTEXT_WINDOW: AtomicU64 = AtomicU64::new(0);
const STRESS_CONTEXT_WINDOW: u64 = 6_144;

pub(crate) fn context_window_override() -> Option<u64> {
    let window = CONTEXT_WINDOW.load(Ordering::Relaxed);
    (window > 0).then_some(window)
}

struct ContextWindowGuard;
impl Drop for ContextWindowGuard {
    fn drop(&mut self) {
        CONTEXT_WINDOW.store(0, Ordering::Relaxed);
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Spec {
    schema: String,
    providers: Vec<Provider>,
    trials: usize,
    timeout_seconds: u64,
    variants: Vec<String>,
    cache_conditions: Vec<String>,
    execution_budget: Budget,
    #[serde(default)]
    prices: Vec<PriceSnapshot>,
    #[serde(default)]
    native_cli_version: Option<String>,
    #[serde(default)]
    ollama_endpoint: Option<String>,
    #[serde(default)]
    held_out: bool,
    #[serde(default)]
    candidate_policies: Option<CandidatePolicies>,
    tasks: Vec<Task>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CandidatePolicies {
    tool_recovery_feedback: bool,
    checkpoint_recovery: bool,
    stable_api_prefix: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Provider {
    id: String,
    model: String,
    effort: String,
    #[serde(default)]
    native_comparison: Option<NativeComparison>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeComparison {
    argv: Vec<String>,
    equivalence_description: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Budget {
    max_observed_tokens: u64,
    #[serde(default)]
    max_tokens_per_turn: Option<u64>,
    #[serde(default)]
    max_tool_rounds_per_turn: Option<usize>,
    max_calls: u32,
    max_cost_micros: Option<u64>,
    currency: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Task {
    id: String,
    category: String,
    repository_snapshot: String,
    #[serde(default)]
    source_revisions: Vec<String>,
    files: BTreeMap<String, String>,
    turns: Vec<String>,
    allowed_changes: Vec<String>,
    verifier: String,
    #[serde(default)]
    required_verification_commands: Vec<verification::RequiredCommand>,
    #[serde(default)]
    reference_solution: BTreeMap<String, String>,
    #[serde(default)]
    critical: bool,
    #[serde(default)]
    reopen_before_turn: Option<usize>,
}
pub(crate) fn start(app: &tauri::AppHandle, root: PathBuf, spec: Value) -> anyhow::Result<bool> {
    let spec: Spec = serde_json::from_value(spec)?;
    validate(&spec)?;
    check_native_cli_version(&spec)?;
    if spec.native_cli_version.is_some() {
        let provider = &spec.providers[0].id;
        anyhow::ensure!(
            gyro_core::try_provider_api_key_value(provider)?.is_none()
                && !gyro_core::credentials::provider_credential_env_vars(provider).iter().any(|key|
                    std::env::var(key).is_ok_and(|value| !value.trim().is_empty())),
            "Native subscription comparisons require a CLI account without API credential overrides"
        );
    }
    let paths = GyroPaths::for_current_user()?;
    paths.ensure()?;
    let store = SessionStore::open(paths.clone())?;
    let config = benchmark_config(&spec);
    config.save(&paths)?;
    start_cli_ipc_listener(app.clone());
    let app = app.clone();
    std::thread::spawn(move || {
        let result = run(&app, &root, spec);
        if let Err(error) = &result {
            eprintln!(
                "Efficiency benchmark: {}",
                gyro_core::sanitize_capability_summary(&error.to_string())
            );
        }
        app.exit(if result.is_ok() { 0 } else { 1 });
    });
    drop(store);
    Ok(true)
}
fn benchmark_config(spec: &Spec) -> GyroConfig {
    let mut config = GyroConfig::default();
    config.require_command_approval = false;
    config.require_file_edit_approval = false;
    config.efficiency.prices = spec.prices.clone();
    config.usage_guard.max_calls_per_window = spec.execution_budget.max_calls;
    config.usage_guard.max_tokens_per_call = spec.execution_budget.max_observed_tokens;
    if let Some(rounds) = spec.execution_budget.max_tool_rounds_per_turn {
        config.usage_guard.max_tool_rounds = rounds;
    }
    for provider in &mut config.model_providers {
        provider.enabled = spec
            .providers
            .iter()
            .any(|selected| selected.id == provider.id);
        if provider.id == "ollama" {
            if let Some(endpoint) = &spec.ollama_endpoint {
                provider.base_url = Some(endpoint.clone());
            }
        }
    }
    config
}
fn routine_effort_allowed(variants: &[String], effort: &str) -> bool {
    !variants.iter().any(|variant| variant == "routine-profile") || effort.trim().is_empty()
}

fn benchmark_session(
    store: &SessionStore,
    workspace: &Path,
    provider: &Provider,
) -> anyhow::Result<Session> {
    let session = store.create_session(workspace, SessionOrigin::Desktop, "Efficiency pilot")?;
    // Chat identity comes from persisted state, not the request payload.
    store
        .update_session_model(
            session.id,
            Some(provider.id.clone()),
            None,
            Some(provider.model.clone()),
            None,
            (!provider.effort.trim().is_empty()).then(|| provider.effort.trim().to_owned()),
        )?
        .ok_or_else(|| anyhow::anyhow!("Benchmark session disappeared while binding its model"))
}

fn validate(spec: &Spec) -> anyhow::Result<()> {
    anyhow::ensure!(
        spec.schema == "gyro.efficiency-benchmark.v2"
            && (1..=3).contains(&spec.providers.len())
            && (1..=5).contains(&spec.trials)
            && (10..=1800).contains(&spec.timeout_seconds),
        "Invalid benchmark settings"
    );
    anyhow::ensure!(
        (1..=40).contains(&spec.tasks.len())
            && !spec.variants.is_empty()
            && !spec.cache_conditions.is_empty(),
        "Benchmark needs bounded tasks, variants and cache conditions"
    );
    anyhow::ensure!(
        spec.execution_budget.max_calls > 0 && spec.execution_budget.max_observed_tokens > 0,
        "Explicit finite maxCalls and maxObservedTokens are required"
    );
    if let Some(rounds) = spec.execution_budget.max_tool_rounds_per_turn {
        anyhow::ensure!(
            rounds > 0
                && spec.native_cli_version.is_none()
                && spec.providers.iter().all(|provider| {
                    gyro_core::efficiency::controls(&provider.id).owns_requests
                        && provider.native_comparison.is_none()
                }),
            "A positive maxToolRoundsPerTurn requires Gyro-owned provider requests"
        );
    }
    if let Some(endpoint) = &spec.ollama_endpoint {
        anyhow::ensure!(
            spec.providers.len() == 1
                && spec.providers[0].id == "ollama"
                && !endpoint.trim().is_empty(),
            "An Ollama endpoint override requires a single Ollama provider"
        );
        gyro_core::ollama_endpoint(Some(endpoint))?;
    }
    let mut ids = HashSet::new();
    anyhow::ensure!(
        !spec
            .providers
            .iter()
            .any(|provider| provider.native_comparison.is_some())
            || spec
                .tasks
                .iter()
                .all(|task| task.required_verification_commands.is_empty()),
        "Required verification commands need Gyro-owned workspace command receipts"
    );
    if let Some(version) = &spec.native_cli_version {
        anyhow::ensure!(
            spec.providers.len() == 1
                && matches!(spec.providers[0].id.as_str(), "openai" | "anthropic")
                && spec.providers[0].native_comparison.is_none()
                && spec.execution_budget.max_cost_micros.is_none()
                && !version.trim().is_empty(),
            "Native paired runs need one Gyro CLI route, a pinned CLI version, and a separate usage budget"
        );
    }
    if spec.held_out {
        let source_revisions: HashSet<_> = spec
            .tasks
            .iter()
            .flat_map(|task| &task.source_revisions)
            .collect();
        anyhow::ensure!(
            source_revisions.len() >= 2
                && spec
                    .tasks
                    .iter()
                    .all(|task| !task.source_revisions.is_empty())
                && source_revisions.iter().all(|revision| {
                    revision.len() == 40
                        && revision
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                }),
            "Held-out tasks require their frozen source revisions. Prepare a fresh benchmark spec."
        );
        anyhow::ensure!(
            spec.providers.len() == 1
                && spec.trials == 1
                && spec.variants == ["baseline", "harness-candidate"]
                && spec.cache_conditions == ["fresh-session", "resumed-session"]
                && spec.tasks.len() == 24
                && [
                    "small-edit",
                    "multi-file-fix",
                    "read-only-diagnosis",
                    "long-session"
                ]
                .into_iter()
                .all(|category| spec
                    .tasks
                    .iter()
                    .filter(|task| task.category == category)
                    .count()
                    == 6)
                && spec.tasks.iter().any(|task| task.critical)
                && (spec.native_cli_version.is_some()
                    || gyro_core::efficiency::controls(&spec.providers[0].id).owns_requests
                        && spec.providers[0].id != "ollama"),
            "Held-out runs require the frozen 24-task matrix, a candidate and an eligible route"
        );
    }
    if spec
        .variants
        .iter()
        .any(|variant| variant == "harness-candidate")
    {
        anyhow::ensure!(
            spec.candidate_policies
                .as_ref()
                .is_some_and(|policies| (policies.tool_recovery_feedback
                    || policies.checkpoint_recovery
                    || policies.stable_api_prefix)
                    && (!policies.stable_api_prefix
                        || spec
                            .providers
                            .iter()
                            .all(|provider| gyro_core::efficiency::controls(&provider.id)
                                .owns_requests
                                && provider.id != "ollama"))),
            "Select the evaluated candidate policies explicitly"
        );
    }
    for p in &spec.providers {
        anyhow::ensure!(
            ids.insert(&p.id) && gyro_core::provider_descriptor(&p.id).is_some(),
            "Unknown or duplicate provider"
        );
        anyhow::ensure!(
            routine_effort_allowed(&spec.variants, &p.effort),
            "A routine-profile comparison needs no explicit effort; it never overrides the user's choice"
        );
        if gyro_core::efficiency::controls(&p.id).owns_requests && p.id != "ollama" {
            anyhow::ensure!(
                spec.execution_budget.max_cost_micros.is_some_and(|n| n > 0)
                    && gyro_core::efficiency::pricing::snapshot(
                        &spec.prices,
                        &p.id,
                        &p.model,
                        &chrono::Utc::now().format("%Y-%m-%d").to_string()
                    )
                    .is_some(),
                "API runs require a price snapshot and finite maxCostMicros"
            );
        }
        if let Some(native) = &p.native_comparison {
            let contract = gyro_core::provider_cli_contract(&p.id)
                .ok_or_else(|| anyhow::anyhow!("Native comparison requires a CLI provider"))?;
            anyhow::ensure!(
                native.argv.first().is_some_and(|a| a == contract.program)
                    && !native.equivalence_description.trim().is_empty(),
                "Native comparator needs the provider CLI and a reviewed equivalence description"
            );
        }
    }
    anyhow::ensure!(
        spec.variants.contains(&"baseline".to_string())
            && spec.variants.iter().collect::<HashSet<_>>().len() == spec.variants.len()
            && spec.cache_conditions.iter().collect::<HashSet<_>>().len()
                == spec.cache_conditions.len(),
        "Require a baseline and unique variants/conditions"
    );
    gyro_core::efficiency::pricing::validate_append(&[], &spec.prices)?;
    for variant in &spec.variants {
        anyhow::ensure!(
            matches!(
                variant.as_str(),
                "baseline"
                    | "structured-evidence"
                    | "cache-assembly"
                    | "task-state"
                    | "retrieval"
                    | "progress-detection"
                    | "compact-tool-catalog"
                    | "focused-workspace-catalog"
                    | "recoverable-evidence"
                    | "tight-evidence"
                    | "batch-reads"
                    | "compact-cli-catalog"
                    | "catalog-retention"
                    | "routine-profile"
                    | "fresh-read-4k"
                    | "fresh-read-8k"
                    | "fresh-read-16k"
                    | "repeated-work"
                    | "stable-api-prefix"
                    | "tool-recovery-feedback"
                    | "checkpoint-recovery"
                    | "harness-candidate"
                    | "combined"
            ),
            "Unknown optimization variant"
        );
    }
    for condition in &spec.cache_conditions {
        anyhow::ensure!(
            matches!(condition.as_str(), "fresh-session" | "resumed-session"),
            "Cache state must be observed, never inferred from session reuse"
        );
    }
    ids.clear();
    for task in &spec.tasks {
        anyhow::ensure!(
            !task.id.is_empty()
                && task.id.len() <= 64
                && task
                    .id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')),
            "Task identity must be a safe filename"
        );
        anyhow::ensure!(
            ids.insert(&task.id)
                && task.turns.len() <= 8
                && !task.turns.is_empty()
                && task.files.len() <= 100
                && !task.verifier.is_empty(),
            "Invalid task"
        );
        anyhow::ensure!(
            task.reopen_before_turn
                .is_none_or(|index| index > 0 && index < task.turns.len()),
            "A reopen must follow a fixture turn and precede another"
        );
        for command in &task.required_verification_commands {
            command.validate()?;
        }
        for path in task
            .files
            .keys()
            .chain(task.allowed_changes.iter())
            .chain(task.reference_solution.keys())
        {
            let p = gyro_core::normalize_capability_relative_path(path)?;
            anyhow::ensure!(
                !gyro_core::capability_path_is_sensitive(&p),
                "Sensitive fixture path"
            );
        }
        let hash = format!(
            "sha256:{:x}",
            Sha256::digest(serde_json::to_vec(&task.files)?)
        );
        anyhow::ensure!(
            hash == task.repository_snapshot,
            "Fixture snapshot mismatch: {}",
            task.id
        );
    }
    for p in &spec.prices {
        p.validate()?;
        anyhow::ensure!(
            p.currency == spec.execution_budget.currency,
            "Price currency differs from budget"
        );
    }
    Ok(())
}

fn check_native_cli_version(spec: &Spec) -> anyhow::Result<()> {
    let Some(expected) = &spec.native_cli_version else {
        return Ok(());
    };
    let provider = &spec.providers[0];
    let program = if provider.id == "openai" {
        "codex"
    } else {
        "claude"
    };
    let model = Some(provider.model.as_str());
    let effort = Some(provider.effort.as_str());
    let catalog = crate::model_catalog::catalog_reasoning_efforts(&provider.id, model);
    let applied_effort = if provider.id == "openai" {
        gyro_core::provider_runtime::native_args::codex_reasoning_effort_arg(
            model,
            effort,
            catalog.as_deref(),
        )
    } else {
        gyro_core::provider_runtime::native_args::claude_reasoning_effort_arg(
            model,
            effort,
            catalog.as_deref(),
        )
    };
    anyhow::ensure!(
        applied_effort.as_deref() == effort,
        "Native launcher would change or omit the configured effort"
    );
    let mut command = command_with_gui_path(program);
    command.arg("--version");
    let result = run_bounded_command(&command, Duration::from_secs(10), None, 4096, 4096)?;
    anyhow::ensure!(
        matches!(
            result.termination,
            ExecutionTermination::Exited { code: Some(0) }
        ) && result.stdout.trim() == expected.trim(),
        "The installed {program} CLI does not match the pinned benchmark version"
    );
    Ok(())
}
fn fixture(task: &Task, workspace: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(workspace)?;
    for (path, text) in &task.files {
        let target = workspace.join(path);
        fs::create_dir_all(target.parent().unwrap())?;
        fs::write(target, text)?;
    }
    for args in [
        vec!["init", "-q"],
        vec!["add", "."],
        vec![
            "-c",
            "user.name=Gyro Benchmark",
            "-c",
            "user.email=benchmark@localhost",
            "commit",
            "-qm",
            "fixture",
        ],
    ] {
        anyhow::ensure!(
            Command::new("git")
                .args(args)
                .current_dir(workspace)
                .status()?
                .success(),
            "Fixture Git initialization failed"
        );
    }
    Ok(())
}
fn verify(task: &Task, workspace: &Path, verifier: &Path, response: &str) -> anyhow::Result<bool> {
    let result = run_bounded_command(
        &{
            let mut c = command_with_gui_path("node");
            c.arg("--test")
                .arg(verifier)
                .env("GYRO_VERIFY_WORKSPACE", workspace)
                .env(
                    "GYRO_VERIFY_FINAL_RESPONSE",
                    response
                        .chars()
                        .filter(|character| *character != '\0')
                        .take(16_384)
                        .collect::<String>(),
                )
                .current_dir(workspace);
            c
        },
        Duration::from_secs(60),
        None,
        64 * 1024,
        64 * 1024,
    )?;
    Ok(matches!(
        result.termination,
        ExecutionTermination::Exited { code: Some(0) }
    ) && scope_verified(task, workspace)?)
}
fn scope_verified(task: &Task, workspace: &Path) -> anyhow::Result<bool> {
    let changes = Command::new("git")
        .args([
            "status",
            "--porcelain=v1",
            "-z",
            "--no-renames",
            "--untracked-files=all",
        ])
        .current_dir(workspace)
        .output()?;
    Ok(changes.status.success()
        && std::str::from_utf8(&changes.stdout)?
            .split_terminator('\0')
            .all(|row| {
                row.get(3..)
                    .is_some_and(|path| task.allowed_changes.iter().any(|allowed| allowed == path))
            }))
}
struct TurnEvidence {
    receipts: Option<Vec<Value>>,
    tool_requests: usize,
    tokens: Option<UsageTokens>,
}

fn turn_evidence(
    store: &SessionStore,
    session_id: Uuid,
    turn_id: Uuid,
) -> anyhow::Result<TurnEvidence> {
    let mut receipts = Vec::new();
    let mut tool_requests = 0;
    // A long tool loop can push earlier receipts outside the normal chat tail.
    store.visit_transcript_events(session_id, |event| {
        if event.turn_id == Some(turn_id) {
            match event.payload["kind"].as_str() {
                Some("efficiency-receipt") => receipts.push(event.payload.clone()),
                Some("capability-call") if event.payload["status"] == "requested" => {
                    tool_requests += 1;
                }
                _ => {}
            }
        }
        true
    })?;
    // The ledger can have a call even when appending its diagnostics failed.
    let receipts =
        (receipts.len() == store.turn_usage_call_count(session_id, turn_id)?).then_some(receipts);
    Ok(TurnEvidence {
        receipts,
        tool_requests,
        tokens: store.task_usage_tokens(session_id, turn_id)?,
    })
}

fn receipt_count(receipts: &[Value], field: &str) -> Option<u64> {
    if receipts.is_empty() {
        return None;
    }
    receipts.iter().try_fold(0u64, |sum, receipt| {
        sum.checked_add(receipt[field].as_u64()?)
    })
}

fn schema_valid_tool_requests(receipts: &[Value]) -> Option<u64> {
    if receipts.is_empty() {
        return None;
    }
    receipts.iter().try_fold(0u64, |total, receipt| {
        let classes = receipt["contextAttribution"]["toolClassCounts"].as_object()?;
        classes
            .values()
            .try_fold(total, |sum, count| sum.checked_add(count.as_u64()?))
    })
}

// Simulate the review step only for the benchmark's disposable fixture and
// declared edit paths. Keep normal app approvals and Full Access unchanged.
#[derive(Clone, Copy, Debug, Default)]
struct FixtureReviews {
    applied: usize,
    failed: usize,
}
impl std::ops::AddAssign for FixtureReviews {
    fn add_assign(&mut self, other: Self) {
        self.applied += other.applied;
        self.failed += other.failed;
    }
}

fn review_fixture_proposals(
    store: &SessionStore,
    root: &Path,
    workspace: &Path,
    session: Uuid,
    turn: Uuid,
    allowed: &[String],
) -> anyhow::Result<FixtureReviews> {
    let workspace = workspace.canonicalize()?;
    anyhow::ensure!(
        workspace.parent() == Some(root.join("sessions/workspaces").canonicalize()?.as_path()),
        "Proposal review requires a disposable benchmark workspace"
    );
    let proposals = store.list_pending_mutation_proposals(session)?;
    // Validate the complete batch before applying any of it.
    for proposal in &proposals {
        anyhow::ensure!(
            proposal.turn_id == Some(turn)
                && proposal.workspace_path.canonicalize()? == workspace
                && allowed.contains(&proposal.path),
            "Proposal falls outside this benchmark turn's allowed changes"
        );
    }
    let mut reviews = FixtureReviews::default();
    for proposal in &proposals {
        let result = match decide_mutation_proposal(store, proposal.id, MutationDecision::Approve) {
            Ok(result) => result,
            Err(error) => {
                // A stale proposal is a failed action, not permission to overwrite
                // newer content or stop reviewing a later corrected proposal.
                if store
                    .get_mutation_proposal(proposal.id)?
                    .is_some_and(|p| p.status == gyro_core::MutationProposalStatus::Failed)
                {
                    reviews.failed += 1;
                    continue;
                }
                return Err(error);
            }
        };
        anyhow::ensure!(
            result.proposal.status == gyro_core::MutationProposalStatus::Applied,
            "Benchmark fixture proposal did not apply"
        );
        reviews.applied += 1;
    }
    Ok(reviews)
}

fn with_fixture_review<T>(
    store: &SessionStore,
    root: &Path,
    workspace: &Path,
    session: Uuid,
    turn: Uuid,
    allowed: &[String],
    run: impl FnOnce() -> T,
) -> (T, anyhow::Result<FixtureReviews>) {
    let paths = store.paths().clone();
    let root = root.to_path_buf();
    let workspace = workspace.to_path_buf();
    let allowed = allowed.to_vec();
    let (done, completion) = std::sync::mpsc::channel();
    let reviewer = std::thread::spawn(move || -> anyhow::Result<FixtureReviews> {
        let store = SessionStore::open(paths)?;
        let mut count = FixtureReviews::default();
        loop {
            count += review_fixture_proposals(&store, &root, &workspace, session, turn, &allowed)?;
            if completion.recv_timeout(Duration::from_millis(100))
                != Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            {
                count +=
                    review_fixture_proposals(&store, &root, &workspace, session, turn, &allowed)?;
                return Ok(count);
            }
        }
    });
    let result = run();
    let _ = done.send(());
    let reviewed = reviewer
        .join()
        .unwrap_or_else(|_| Err(anyhow::anyhow!("Fixture reviewer panicked")));
    (result, reviewed)
}

fn apply_efficiency_variant(e: &mut gyro_core::efficiency::Config, variant: &str) {
    let standalone = variant.starts_with("fresh-read-")
        || matches!(
            variant,
            "repeated-work"
                | "stable-api-prefix"
                | "tool-recovery-feedback"
                | "checkpoint-recovery"
                | "harness-candidate"
        );
    e.experimental = variant != "baseline" && !standalone;
    e.structured_evidence = variant == "combined" || variant == "structured-evidence";
    e.cache_assembly = variant == "combined" || variant == "cache-assembly";
    e.task_state = variant == "combined" || variant == "task-state";
    e.repository_retrieval = variant == "combined" || variant == "retrieval";
    e.progress_detection = variant == "combined" || variant == "progress-detection";
    e.compact_tool_catalog = variant == "combined" || variant == "compact-tool-catalog";
    e.focused_workspace_catalog = variant == "focused-workspace-catalog";
    e.recoverable_evidence = variant == "combined" || variant == "recoverable-evidence";
    // Keep mutually exclusive evidence policies separate from the combined candidate.
    e.tight_evidence = variant == "tight-evidence";
    e.batch_reads = variant == "batch-reads";
    e.compact_cli_catalog = variant == "compact-cli-catalog";
    e.retain_tool_catalog = variant == "combined" || variant == "catalog-retention";
    e.fresh_read_inline_bytes = match variant {
        "fresh-read-4k" => 4 * 1024,
        "fresh-read-8k" => 8 * 1024,
        "fresh-read-16k" => 16 * 1024,
        _ => 0,
    };
    e.repeated_work_detection = variant == "repeated-work";
    e.stable_api_prefix = variant == "stable-api-prefix";
    e.tool_recovery_feedback = variant == "tool-recovery-feedback";
    e.checkpoint_recovery = variant == "checkpoint-recovery";
    // Keep summary behavior identical: these fixtures do not invoke background summaries.
    e.full_context_internal_requests = false;
    e.profile = if variant == "routine-profile" {
        gyro_core::efficiency::Profile::Routine
    } else {
        gyro_core::efficiency::Profile::Standard
    };
}

fn run(app: &tauri::AppHandle, root: &Path, spec: Spec) -> anyhow::Result<()> {
    let paths = GyroPaths::for_current_user()?;
    let store = SessionStore::open(paths.clone())?;
    let mut records = Vec::<Value>::new();
    let mut spent = 0u64;
    let mut cost = 0u64;
    let mut calls = 0u32;
    let mut unknown = false;
    let native = spec.native_cli_version.is_some();
    for (task_index, task) in spec.tasks.iter().enumerate() {
        let verification_contract = verification::contract(&task.required_verification_commands);
        let verifier = root.join(format!("verifier-{}.mjs", task.id));
        fs::write(&verifier, &task.verifier)?;
        for provider in &spec.providers {
            for (condition_index, condition) in spec.cache_conditions.iter().enumerate() {
                for trial in 1..=spec.trials {
                    // Alternating order reduces systematic first-run bias without claiming cold cache control.
                    let mut variants = spec.variants.clone();
                    if (task_index + condition_index + trial) % 2 == 0 {
                        variants.reverse();
                    }
                    for variant in variants {
                        let mut record = json!({"task":task.id,"category":task.category,"repositorySnapshot":task.repository_snapshot,"provider":provider.id,"model":provider.model,"modelVersionCoverage":"requested-model-id","effort":provider.effort,"variant":variant,"trial":trial,"sessionCondition":condition,"cacheCondition":"unverified","comparison":"gyro","verified":false});
                        if let Some(contract) = &verification_contract {
                            record["verificationContract"] = json!(contract);
                        }
                        if unknown
                            || spent >= spec.execution_budget.max_observed_tokens
                            || calls >= spec.execution_budget.max_calls
                            || spec
                                .execution_budget
                                .max_cost_micros
                                .is_some_and(|limit| cost >= limit)
                        {
                            record["outcome"] = json!("budget-stop");
                            records.push(record);
                            persist(root, &records)?;
                            continue;
                        }
                        let applied_efficiency = GyroConfig::update(&paths, |cfg| {
                            apply_efficiency_variant(&mut cfg.efficiency, &variant);
                            if variant == "harness-candidate" {
                                let policies = spec
                                    .candidate_policies
                                    .as_ref()
                                    .expect("validated candidate");
                                cfg.efficiency.tool_recovery_feedback =
                                    policies.tool_recovery_feedback;
                                cfg.efficiency.checkpoint_recovery = policies.checkpoint_recovery;
                                cfg.efficiency.stable_api_prefix = policies.stable_api_prefix;
                            }
                            Ok(cfg.efficiency.clone())
                        })?;
                        record["efficiencyConfig"] = json!(applied_efficiency);
                        let workspace = root
                            .join("sessions/workspaces")
                            .join(Uuid::new_v4().to_string());
                        fixture(task, &workspace)?;
                        let mut policy =
                            ProjectCapabilityPolicy::defaults(workspace.display().to_string());
                        policy
                            .classes
                            .insert(CapabilityClass::TerminalExecute, CapabilityAccess::Allow);
                        for class in [
                            CapabilityClass::GithubWrite,
                            CapabilityClass::BrowserNavigate,
                            CapabilityClass::AgentRun,
                        ] {
                            policy.classes.insert(class, CapabilityAccess::Deny);
                        }
                        store.save_project_capability_policy(policy, None)?;
                        let session = benchmark_session(&store, &workspace, provider)?;
                        let verification =
                            verification::Trial::start(session.id, &workspace, task)?;
                        let mut verification_turns = Vec::new();
                        record["sessionId"] = json!(session.id);
                        let legacy = crate::performance_benchmark::Provider {
                            id: provider.id.clone(),
                            model: provider.model.clone(),
                            effort: provider.effort.clone(),
                        };
                        let started = Instant::now();
                        let mut usage = None::<UsageTokens>;
                        let mut outcome = "done";
                        let mut retries = Some(0u64);
                        let mut generation_requests = Some(0u64);
                        let mut requested_efforts = Some(Vec::<Value>::new());
                        let mut reviewed_proposals = FixtureReviews::default();
                        let mut gyro_tool_requests = 0usize;
                        let mut schema_valid_requests = (!native).then_some(0u64);
                        let mut checkpoint_recoveries = 0u64;
                        let mut final_response = String::new();
                        record["approvalSimulation"] =
                            json!("allowlisted-fixture-review-during-turn");
                        let prompts = if condition == "resumed-session" {
                            std::iter::once("Inspect the repository overview. Do not edit files. Preserve subsequent task constraints.".to_string()).chain(task.turns.clone()).collect::<Vec<_>>()
                        } else {
                            task.turns.clone()
                        };
                        let setup_turns = usize::from(condition == "resumed-session");
                        let stress = spec.held_out && !native && task.reopen_before_turn.is_some();
                        let _window = stress.then(|| {
                            CONTEXT_WINDOW.store(STRESS_CONTEXT_WINDOW, Ordering::Relaxed);
                            ContextWindowGuard
                        });
                        record["benchmarkContextWindow"] = json!(context_window_override());
                        for (prompt_index, prompt) in prompts.into_iter().enumerate() {
                            if calls >= spec.execution_budget.max_calls
                                || spent >= spec.execution_budget.max_observed_tokens
                                || unknown
                                || spec
                                    .execution_budget
                                    .max_cost_micros
                                    .is_some_and(|n| cost >= n)
                            {
                                outcome = "budget-stop";
                                break;
                            }
                            if native
                                && task
                                    .reopen_before_turn
                                    .is_some_and(|index| prompt_index == index + setup_turns)
                            {
                                store.clear_provider_session_binding(session.id, &provider.id)?;
                            }
                            let remaining = spec
                                .execution_budget
                                .max_observed_tokens
                                .saturating_sub(spent);
                            let conservative_cost_tokens =
                                spec.execution_budget.max_cost_micros.and_then(|cap| {
                                    let snapshot = gyro_core::efficiency::pricing::snapshot(
                                        &spec.prices,
                                        &provider.id,
                                        &provider.model,
                                        &chrono::Utc::now().format("%Y-%m-%d").to_string(),
                                    )?;
                                    let rate = [
                                        snapshot.input_micros_per_million,
                                        snapshot.output_micros_per_million,
                                        snapshot.cached_micros_per_million.unwrap_or(0),
                                        snapshot.cache_write_micros_per_million.unwrap_or(0),
                                    ]
                                    .into_iter()
                                    .max()?;
                                    if rate == 0 {
                                        return None;
                                    }
                                    u64::try_from(
                                        u128::from(cap.saturating_sub(cost)) * 1_000_000
                                            / u128::from(rate),
                                    )
                                    .ok()
                                });
                            let fixed_ceiling = spec
                                .execution_budget
                                .max_tokens_per_turn
                                .unwrap_or(20_000)
                                .min(spec.execution_budget.max_observed_tokens);
                            let affordable =
                                conservative_cost_tokens.map_or(remaining, |n| n.min(remaining));
                            if affordable < fixed_ceiling {
                                outcome = "budget-stop";
                                break;
                            }
                            let ceiling = fixed_ceiling;
                            if ceiling == 0 {
                                outcome = "budget-stop";
                                break;
                            }
                            GyroConfig::update(&paths, |c| {
                                c.usage_guard.max_tokens_per_call = ceiling;
                                Ok(())
                            })?;
                            calls += 1;
                            let turn_id = Uuid::new_v4();
                            if verification.is_some() && prompt_index >= setup_turns {
                                verification_turns.push(turn_id);
                            }
                            let (response, reviewed_turn) = with_fixture_review(
                                &store,
                                root,
                                &workspace,
                                session.id,
                                turn_id,
                                &task.allowed_changes,
                                || {
                                    crate::performance_benchmark::turn_with_id(
                                        app,
                                        &store,
                                        session.id,
                                        &workspace,
                                        &legacy,
                                        &prompt,
                                        spec.timeout_seconds,
                                        turn_id,
                                    )
                                },
                            );
                            if let Ok(count) = &reviewed_turn {
                                reviewed_proposals += *count;
                            }
                            let evidence = turn_evidence(&store, session.id, turn_id)?;
                            let receipts = evidence.receipts.as_deref().unwrap_or_default();
                            let receipt = receipts.last();
                            requested_efforts = requested_efforts.filter(|_| {
                                !receipts.is_empty()
                                    && receipts.iter().all(|receipt| {
                                        receipt.get("requestedReasoningEffort").is_some_and(
                                            |value| value.is_null() || value.is_string(),
                                        )
                                    })
                            });
                            if let Some(efforts) = &mut requested_efforts {
                                efforts.extend(
                                    receipts
                                        .iter()
                                        .map(|r| r["requestedReasoningEffort"].clone()),
                                );
                            }
                            let overhead = receipt
                                .map(|e| e["optimizationOverheadMicros"].clone())
                                .unwrap_or(json!({}));
                            record["optimizationOverheadMicros"] = overhead;
                            // Task totals include setup turns, failures and all continuations.
                            if let Some(receipt) = receipt {
                                record["efficiencyEvents"] =
                                    receipt["taskTotals"]["efficiencyEvents"].clone();
                                record["efficiencyEventCoverage"] =
                                    receipt["taskTotals"]["efficiencyEventCoverage"].clone();
                            }
                            let observed = receipt_count(receipts, "generationRequests");
                            generation_requests = generation_requests
                                .zip(observed)
                                .and_then(|(a, b)| a.checked_add(b));
                            let observed_retries = receipt_count(receipts, "retryCount");
                            retries = retries
                                .zip(observed_retries)
                                .and_then(|(a, b)| a.checked_add(b));
                            // A missing receipt makes call/retry accounting unknown; stop further spending.
                            if !native && (generation_requests.is_none() || retries.is_none()) {
                                unknown = true;
                            }
                            let observed_calls = if native {
                                1
                            } else {
                                observed.unwrap_or(1).max(1)
                            };
                            calls = calls.saturating_add(
                                observed_calls.saturating_sub(1).min(u64::from(u32::MAX)) as u32,
                            );

                            if let Some(tokens) = evidence.tokens {
                                spent = spent.saturating_add(tokens.total_tokens);
                                usage = Some(usage.map_or(tokens, |u| u.combine(tokens)));
                                if !tokens.measured && !native {
                                    unknown = true;
                                }
                            } else if !native {
                                unknown = true;
                            }
                            gyro_tool_requests += evidence.tool_requests;
                            schema_valid_requests = schema_valid_requests
                                .zip(schema_valid_tool_requests(receipts))
                                .and_then(|(total, observed)| total.checked_add(observed));
                            checkpoint_recoveries += receipts
                                .iter()
                                .filter_map(|receipt| receipt["checkpointRecoveries"].as_u64())
                                .sum::<u64>();
                            if let Some(price) = gyro_core::efficiency::pricing::snapshot(
                                &spec.prices,
                                &provider.id,
                                &provider.model,
                                &chrono::Utc::now().format("%Y-%m-%d").to_string(),
                            )
                            .filter(|_| {
                                gyro_core::efficiency::controls(&provider.id).owns_requests
                                    && provider.id != "ollama"
                            }) {
                                if let Some(c) = evidence.tokens.and_then(|t| price.price(t)) {
                                    cost = cost.saturating_add(c.micros);
                                } else if spec.execution_budget.max_cost_micros.is_some() {
                                    unknown = true;
                                }
                            }
                            match response {
                                Ok((_, reply)) => {
                                    final_response = reply.assistant_event.message;
                                    match reviewed_turn {
                                        Ok(_) => {}
                                        Err(error) => {
                                            outcome = "failed";
                                            record["failureClass"] = json!("fixture-review-failed");
                                            record["failureDetail"] =
                                                json!(gyro_core::security::redact_secrets(
                                                    &error.to_string()
                                                )
                                                .chars()
                                                .take(500)
                                                .collect::<String>());
                                            break;
                                        }
                                    }
                                }
                                Err(error) => {
                                    outcome = "failed";
                                    record["failureClass"] =
                                        json!(crate::performance_benchmark::failure_class(&error));
                                    record["failureDetail"] =
                                        json!(gyro_core::security::redact_secrets(&error)
                                            .chars()
                                            .take(500)
                                            .collect::<String>());
                                    break;
                                }
                            }
                        }
                        record["outcome"] = json!(outcome);
                        record["reviewedFixtureProposals"] = json!(reviewed_proposals.applied);
                        record["failedFixtureReviews"] = json!(reviewed_proposals.failed);
                        record["elapsedMs"] = json!(started.elapsed().as_millis());
                        record["tokens"] = json!(usage);
                        record["retries"] = json!(retries);
                        record["generationRequests"] =
                            json!(if native { None } else { generation_requests });
                        record["gyroToolRequests"] = json!(gyro_tool_requests);
                        record["schemaValidToolRequests"] = json!(schema_valid_requests);
                        record["checkpointRecoveries"] = json!(checkpoint_recoveries);
                        record["nativeCliVersion"] = json!(spec.native_cli_version);
                        record["scopeVerified"] = json!(
                            reviewed_proposals.failed == 0 && scope_verified(task, &workspace)?
                        );
                        let consistent_effort = requested_efforts.as_ref().and_then(|efforts| {
                            let first = efforts.first()?;
                            efforts
                                .iter()
                                .all(|effort| effort == first)
                                .then_some(first)
                        });
                        record["requestedReasoningEffort"] =
                            consistent_effort.cloned().unwrap_or_else(|| {
                                if native && requested_efforts.is_none() {
                                    json!(provider.effort)
                                } else {
                                    Value::Null
                                }
                            });
                        record["requestedEffortCoverage"] = json!(if consistent_effort.is_some() {
                            "observed"
                        } else if requested_efforts
                            .as_ref()
                            .is_some_and(|efforts| !efforts.is_empty())
                        {
                            "mixed"
                        } else if native && requested_efforts.is_none() {
                            "native-launch-configured"
                        } else {
                            "unavailable"
                        });
                        let required_verified = if let Some(verification) = &verification {
                            let evidence = verification.evaluate(&store, &verification_turns)?;
                            let passed = evidence["verified"] == true;
                            record["requiredVerification"] = evidence;
                            passed
                        } else {
                            true
                        };
                        let independently_verified = outcome == "done"
                            && verify(task, &workspace, &verifier, &final_response)?;
                        if verification.is_some() {
                            record["independentVerifierPassed"] = json!(independently_verified);
                            if independently_verified && !required_verified {
                                record["failureClass"] = json!("required-verification-incomplete");
                            }
                        }
                        record["verified"] = json!(independently_verified && required_verified);
                        if let Some(u) = usage {
                            record["cacheCondition"] =
                                json!(if u.effective_accounting().known.cache_read {
                                    if u.cached_input_tokens > 0 {
                                        "observed-cache-read"
                                    } else {
                                        "observed-zero-cache-read"
                                    }
                                } else {
                                    "unverified"
                                });
                        }
                        record["estimatedCost"] = json!(gyro_core::efficiency::pricing::snapshot(
                            &spec.prices,
                            &provider.id,
                            &provider.model,
                            &chrono::Utc::now().format("%Y-%m-%d").to_string()
                        )
                        .filter(
                            |_| gyro_core::efficiency::controls(&provider.id).owns_requests
                                && provider.id != "ollama"
                        )
                        .and_then(|p| usage.and_then(|u| p.price(u))));
                        record["observedBudget"] = json!({"tokens":spent,"calls":calls,"costMicros":cost,"coverageUncertain":unknown});
                        records.push(record);
                        persist(root, &records)?;
                    }
                    // Comparators are explicit, reviewed argv using the same fixture and independent verifier.
                    if let Some(native) = &provider.native_comparison {
                        let mut record = json!({"task":task.id,"provider":provider.id,"model":provider.model,"effort":provider.effort,"variant":"native","trial":trial,"sessionCondition":condition,"comparison":"native","equivalenceDescription":native.equivalence_description,"tokens":null,"estimatedCost":null,"cacheCondition":"unverified","verified":false});
                        if unknown
                            || calls >= spec.execution_budget.max_calls
                            || spent >= spec.execution_budget.max_observed_tokens
                            || task.turns.len() != 1
                            || condition != "fresh-session"
                        {
                            record["outcome"] = json!("unsupported-or-budget-stop");
                        } else {
                            let workspace = root
                                .join("sessions/workspaces")
                                .join(Uuid::new_v4().to_string());
                            fixture(task, &workspace)?;
                            let mut command = command_with_gui_path(&native.argv[0]);
                            command.current_dir(&workspace);
                            for arg in native.argv.iter().skip(1) {
                                command.arg(
                                    arg.replace("{model}", &provider.model)
                                        .replace("{effort}", &provider.effort)
                                        .replace("{prompt}", &task.turns[0]),
                                );
                            }
                            let started = Instant::now();
                            calls += 1;
                            let result = run_bounded_command(
                                &command,
                                Duration::from_secs(spec.timeout_seconds),
                                None,
                                256 * 1024,
                                64 * 1024,
                            );
                            record["outcome"] = json!(if result.as_ref().is_ok_and(|r| matches!(
                                r.termination,
                                ExecutionTermination::Exited { code: Some(0) }
                            )) {
                                "done"
                            } else {
                                "failed"
                            });
                            record["elapsedMs"] = json!(started.elapsed().as_millis());
                            record["verified"] = json!(verify(task, &workspace, &verifier, "")?);
                            unknown = true;
                        }
                        records.push(record);
                        persist(root, &records)?;
                    }
                }
            }
        }
    }
    check_native_cli_version(&spec)?;
    Ok(())
}
fn persist(root: &Path, records: &[Value]) -> anyhow::Result<()> {
    fs::write(
        root.join("efficiency-results.json"),
        serde_json::to_vec_pretty(
            &json!({"schema":"gyro.efficiency-results.v2","records":records,"limitations":["Observed limits can be exceeded by an in-flight request; configure provider-side caps for hard monetary limits.","Unknown consumption stops further generations.","Resumed sessions do not establish warm-cache conditions.","Native command comparisons require reviewed equivalence and currently have unknown usage coverage."]}),
        )?,
    )?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::ide::task_discovery::content_hash;
    use gyro_core::{UsageEntry, UsageOrigin, UsageOutcome};

    #[test]
    fn turn_evidence_counts_supporting_calls_beyond_the_recent_chat_tail() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("data"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "Benchmark accounting")
            .unwrap();
        let turn = Uuid::new_v4();
        let setup_turn = Uuid::new_v4();
        let receipt = |kind: &str, requests: u64, retries: u64| {
            json!({"kind":"efficiency-receipt", "purpose":kind,
                "generationRequests":requests, "retryCount":retries})
        };
        let compact = receipt("compaction", 2, 1);
        let mut entries = vec![(String::new(), compact.clone(), Some(turn))];
        entries.extend((0..1_005).map(|_| {
            (
                "Tool request".into(),
                json!({"kind":"capability-call", "status":"requested"}),
                Some(turn),
            )
        }));
        let answer = receipt("answer", 1, 0);
        entries.push((String::new(), answer.clone(), Some(turn)));
        entries.push((String::new(), receipt("other-turn", 5, 4), Some(setup_turn)));
        store
            .append_system_events_with_turn_id(session.id, entries)
            .unwrap();
        assert!(!store
            .read_events(session.id)
            .unwrap()
            .iter()
            .any(|e| e.payload == compact));

        let record_call = |turn, origin, outcome, input| {
            store.note_usage_call(session.id, turn).unwrap();
            store
                .record_usage(&UsageEntry {
                    session_id: session.id,
                    turn_id: Some(turn),
                    seat_id: None,
                    provider_id: "openrouter".into(),
                    model_id: Some("fixture-model".into()),
                    reasoning_effort: None,
                    origin,
                    outcome,
                    tokens: UsageTokens::measured(Some(input), Some(0), Some(40), None, None),
                    wall_ms: 1,
                    retry_count: u32::from(outcome == UsageOutcome::Failed),
                })
                .unwrap();
        };
        record_call(setup_turn, UsageOrigin::Chat, UsageOutcome::Done, 4_960);
        assert!(turn_evidence(&store, session.id, turn)
            .unwrap()
            .tokens
            .is_none());
        record_call(
            turn,
            UsageOrigin::ContextCompaction,
            UsageOutcome::Failed,
            210,
        );
        record_call(turn, UsageOrigin::Chat, UsageOutcome::Done, 300);

        let evidence = turn_evidence(&store, session.id, turn).unwrap();
        let receipts = evidence.receipts.unwrap();
        assert_eq!(receipts, vec![compact, answer]);
        assert_eq!(evidence.tool_requests, 1_005);
        assert_eq!(receipt_count(&receipts, "generationRequests"), Some(3));
        assert_eq!(receipt_count(&receipts, "retryCount"), Some(1));
        assert_eq!(receipt_count(&receipts, "missing"), None);
        assert_eq!(receipt_count(&[], "generationRequests"), None);
        let tokens = evidence.tokens.unwrap();
        assert_eq!(tokens.total_tokens, 590);
        assert!(tokens.measured);

        record_call(
            turn,
            UsageOrigin::ContextCompaction,
            UsageOutcome::Failed,
            100,
        );
        let evidence = turn_evidence(&store, session.id, turn).unwrap();
        assert!(evidence.receipts.is_none());
        let tokens = evidence.tokens.unwrap();
        assert_eq!(tokens.total_tokens, 730);
        assert!(tokens.measured);

        store.note_usage_call(session.id, turn).unwrap();
        let tokens = turn_evidence(&store, session.id, turn)
            .unwrap()
            .tokens
            .unwrap();
        assert_eq!(tokens.total_tokens, 730);
        assert!(!tokens.measured);
    }

    #[test]
    fn schema_valid_requests_preserve_zero_and_unknown_coverage() {
        let counted = json!({"contextAttribution": {"toolClassCounts": {
            "workspace-read": 4, "terminal": 1
        }}});
        let zero = json!({"contextAttribution": {"toolClassCounts": {}}});
        assert_eq!(schema_valid_tool_requests(&[zero.clone()]), Some(0));
        assert_eq!(
            schema_valid_tool_requests(&[counted.clone(), zero]),
            Some(5)
        );
        assert_eq!(schema_valid_tool_requests(&[counted, json!({})]), None);
        assert_eq!(schema_valid_tool_requests(&[]), None);
    }

    #[test]
    fn frozen_native_pair_is_valid_and_requires_its_baseline() {
        let file = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../docs/performance/efficiency-repo-pilot.json");
        let mut spec: Spec = serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
        spec.providers = vec![Provider {
            id: "xai".into(),
            model: "grok-4.6".into(),
            effort: "high".into(),
            native_comparison: None,
        }];
        spec.trials = 1;
        spec.timeout_seconds = 420;
        spec.variants = vec!["baseline".into(), "progress-detection".into()];
        spec.cache_conditions = vec!["fresh-session".into()];
        spec.execution_budget = Budget {
            max_observed_tokens: 4_000_000,
            max_tokens_per_turn: Some(300_000),
            max_tool_rounds_per_turn: None,
            max_calls: 40,
            max_cost_micros: None,
            currency: "USD".into(),
        };
        spec.tasks.truncate(1);
        validate(&spec).unwrap();
        spec.variants = vec!["progress-detection".into()];
        assert!(validate(&spec).is_err());
    }

    #[test]
    fn fixture_review_applies_while_the_provider_turn_is_still_running() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("sessions/workspaces/run");
        fs::create_dir_all(&workspace).unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("data"))).unwrap();
        let session = store
            .create_session(&workspace, SessionOrigin::Desktop, "test")
            .unwrap();
        let turn = Uuid::new_v4();
        let (observed, reviewed) = with_fixture_review(
            &store,
            temp.path(),
            &workspace,
            session.id,
            turn,
            &["answer.txt".into()],
            || {
                store
                    .create_mutation_proposal(
                        session.id,
                        Some(turn),
                        "answer.txt",
                        "approved\n",
                        None,
                        false,
                    )
                    .unwrap();
                let deadline = Instant::now() + Duration::from_secs(3);
                while !workspace.join("answer.txt").exists() && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(10));
                }
                fs::read_to_string(workspace.join("answer.txt")).ok()
            },
        );
        assert_eq!(observed.as_deref(), Some("approved\n"));
        assert_eq!(reviewed.unwrap().applied, 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn managed_fixture_can_run_checks_without_exposing_private_state() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("data");
        let workspace = root.join("sessions/workspaces/run");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(root.join("config.json"), "private-state").unwrap();
        let sandbox = gyro_core::workspace_sandbox::PreparedWorkspaceSandbox::prepare(
            &workspace,
            &workspace,
            &std::env::var_os("HOME").map(PathBuf::from).unwrap(),
            Some(&root),
        )
        .unwrap();
        let (program, arguments) = sandbox.wrap_command(
            std::ffi::OsStr::new("/bin/sh"),
            &["-c".into(), "printf verified > result.txt; test -f result.txt && ! cat ../../../config.json 2>/dev/null".into()],
        );
        let result = Command::new(program)
            .args(arguments)
            .envs(sandbox.environment())
            .current_dir(&workspace)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(
            fs::read_to_string(workspace.join("result.txt")).unwrap(),
            "verified"
        );
    }

    #[test]
    fn fixture_review_applies_only_the_current_turns_declared_paths() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("sessions/workspaces/run");
        fs::create_dir_all(&workspace).unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("data"))).unwrap();
        let session = store
            .create_session(&workspace, SessionOrigin::Desktop, "test")
            .unwrap();
        let turn = Uuid::new_v4();
        let proposal = store
            .create_mutation_proposal(
                session.id,
                Some(turn),
                "answer.txt",
                "answer\n",
                None,
                false,
            )
            .unwrap();
        assert_eq!(
            review_fixture_proposals(
                &store,
                temp.path(),
                &workspace,
                session.id,
                turn,
                &["answer.txt".into()]
            )
            .unwrap()
            .applied,
            1
        );
        assert_eq!(
            fs::read_to_string(workspace.join("answer.txt")).unwrap(),
            "answer\n"
        );
        assert_eq!(
            store
                .get_mutation_proposal(proposal.id)
                .unwrap()
                .unwrap()
                .status,
            gyro_core::MutationProposalStatus::Applied
        );
    }

    #[test]
    fn fixture_review_rejects_out_of_scope_batch_before_writing() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("sessions/workspaces/run");
        fs::create_dir_all(&workspace).unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("data"))).unwrap();
        let session = store
            .create_session(&workspace, SessionOrigin::Desktop, "test")
            .unwrap();
        let turn = Uuid::new_v4();
        for path in ["allowed.txt", "other.txt"] {
            store
                .create_mutation_proposal(session.id, Some(turn), path, "changed\n", None, false)
                .unwrap();
        }
        assert!(review_fixture_proposals(
            &store,
            temp.path(),
            &workspace,
            session.id,
            turn,
            &["allowed.txt".into()]
        )
        .is_err());
        assert!(!workspace.join("allowed.txt").exists());
        assert!(!workspace.join("other.txt").exists());
        assert!(review_fixture_proposals(
            &store,
            temp.path(),
            &workspace,
            session.id,
            Uuid::new_v4(),
            &["allowed.txt".into(), "other.txt".into()]
        )
        .is_err());
        assert!(review_fixture_proposals(
            &store,
            &workspace,
            &workspace,
            session.id,
            turn,
            &["allowed.txt".into(), "other.txt".into()]
        )
        .is_err());
    }

    #[test]
    fn fixture_review_preserves_the_normal_stale_content_guard() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("sessions/workspaces/run");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(workspace.join("answer.txt"), "before\n").unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("data"))).unwrap();
        let session = store
            .create_session(&workspace, SessionOrigin::Desktop, "test")
            .unwrap();
        let turn = Uuid::new_v4();
        store
            .create_mutation_proposal(
                session.id,
                Some(turn),
                "answer.txt",
                "model\n",
                Some(content_hash(b"before\n")),
                true,
            )
            .unwrap();
        fs::write(workspace.join("answer.txt"), "changed elsewhere\n").unwrap();
        let reviews = review_fixture_proposals(
            &store,
            temp.path(),
            &workspace,
            session.id,
            turn,
            &["answer.txt".into()],
        )
        .unwrap();
        assert_eq!((reviews.applied, reviews.failed), (0, 1));
        assert_eq!(
            fs::read_to_string(workspace.join("answer.txt")).unwrap(),
            "changed elsewhere\n"
        );
    }

    #[test]
    fn isolated_configuration_enables_only_explicitly_selected_providers() {
        let spec: Spec = serde_json::from_value(json!({
            "schema":"gyro.efficiency-benchmark.v2",
            "providers":[{"id":"openai","model":"selected-model","effort":"high"},{"id":"ollama","model":"local-model","effort":""}],
            "trials":1,"timeoutSeconds":180,"variants":["baseline"],"cacheConditions":["fresh-session"],
            "executionBudget":{"maxCalls":12,"maxObservedTokens":50_000,"maxCostMicros":null,"currency":"USD"},"tasks":[]
        })).unwrap();
        let config = benchmark_config(&spec);
        for provider in config.model_providers {
            assert_eq!(
                provider.enabled,
                matches!(provider.id.as_str(), "openai" | "ollama")
            );
        }
        assert!(!config.require_command_approval);
        assert!(!config.require_file_edit_approval);
        assert_eq!(config.usage_guard.max_calls_per_window, 12);
        assert_eq!(config.usage_guard.max_tokens_per_call, 50_000);
    }

    #[test]
    fn benchmark_ollama_override_requires_an_explicit_local_endpoint() {
        let file = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../docs/performance/efficiency-pilot.json");
        let mut spec: Spec = serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
        spec.providers = vec![Provider {
            id: "ollama".into(),
            model: "local-fixture".into(),
            effort: String::new(),
            native_comparison: None,
        }];
        spec.tasks.truncate(1);
        spec.execution_budget.max_calls = 8;
        spec.execution_budget.max_observed_tokens = 30_000;
        spec.execution_budget.max_tool_rounds_per_turn = Some(4);
        spec.ollama_endpoint = Some("http://127.0.0.1:19401/api".into());
        validate(&spec).unwrap();
        let config = benchmark_config(&spec);
        assert_eq!(config.usage_guard.max_tool_rounds, 4);
        spec.execution_budget.max_tool_rounds_per_turn = Some(0);
        assert!(validate(&spec).is_err());
        spec.execution_budget.max_tool_rounds_per_turn = Some(4);
        let selected = config
            .model_providers
            .into_iter()
            .find(|provider| provider.enabled)
            .unwrap();
        assert_eq!(selected.id, "ollama");
        assert_eq!(selected.base_url, spec.ollama_endpoint);

        for endpoint in [" ", "https://127.0.0.1:19401/api", "http://example.com/api"] {
            spec.ollama_endpoint = Some(endpoint.into());
            assert!(validate(&spec).is_err(), "{endpoint}");
        }
        spec.ollama_endpoint = selected.base_url;
        spec.providers[0].id = "openai".into();
        assert!(validate(&spec).is_err());
    }

    #[test]
    fn fixture_reviewer_continues_after_a_failed_stale_proposal() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("sessions/workspaces/run");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(workspace.join("answer.txt"), "current\n").unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("data"))).unwrap();
        let session = store
            .create_session(&workspace, SessionOrigin::Desktop, "test")
            .unwrap();
        let turn = Uuid::new_v4();
        let stale = store
            .create_mutation_proposal(
                session.id,
                Some(turn),
                "answer.txt",
                "stale\n",
                Some(content_hash(b"old\n")),
                true,
            )
            .unwrap();
        let (_, reviews) = with_fixture_review(
            &store,
            temp.path(),
            &workspace,
            session.id,
            turn,
            &["answer.txt".into()],
            || {
                let deadline = Instant::now() + Duration::from_secs(3);
                while store
                    .get_mutation_proposal(stale.id)
                    .unwrap()
                    .unwrap()
                    .status
                    == gyro_core::MutationProposalStatus::Pending
                    && Instant::now() < deadline
                {
                    std::thread::sleep(Duration::from_millis(10));
                }
                store
                    .create_mutation_proposal(
                        session.id,
                        Some(turn),
                        "answer.txt",
                        "corrected\n",
                        Some(content_hash(b"current\n")),
                        true,
                    )
                    .unwrap();
                while fs::read_to_string(workspace.join("answer.txt")).unwrap() != "corrected\n"
                    && Instant::now() < deadline
                {
                    std::thread::sleep(Duration::from_millis(10));
                }
                assert_eq!(
                    fs::read_to_string(workspace.join("answer.txt")).unwrap(),
                    "corrected\n"
                );
            },
        );
        let reviews = reviews.unwrap();
        assert_eq!((reviews.applied, reviews.failed), (1, 1));
    }

    #[test]
    fn benchmark_session_persists_exact_model_and_explicit_effort_before_chat() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("data"))).unwrap();
        for effort in [" high ", ""] {
            let provider = Provider {
                id: "openai".into(),
                model: "selected-model".into(),
                effort: effort.into(),
                native_comparison: None,
            };
            let session = benchmark_session(&store, temp.path(), &provider).unwrap();
            let saved = store.get_session(session.id).unwrap().unwrap();
            assert_eq!(saved.provider_id.as_deref(), Some("openai"));
            assert_eq!(saved.model_id.as_deref(), Some("selected-model"));
            assert_eq!(
                saved.reasoning_effort.as_deref(),
                (!effort.is_empty()).then_some("high")
            );
        }
    }
    #[test]
    fn standalone_variants_change_only_their_named_policy() {
        let mut baseline = gyro_core::efficiency::Config::default();
        apply_efficiency_variant(&mut baseline, "baseline");
        assert!(!baseline.full_context_internal_requests);
        let mut actual = baseline.clone();
        for variant in [
            "fresh-read-4k",
            "fresh-read-8k",
            "fresh-read-16k",
            "repeated-work",
            "stable-api-prefix",
            "baseline",
        ] {
            let mut expected = baseline.clone();
            match variant {
                "fresh-read-4k" => expected.fresh_read_inline_bytes = 4 * 1024,
                "fresh-read-8k" => expected.fresh_read_inline_bytes = 8 * 1024,
                "fresh-read-16k" => expected.fresh_read_inline_bytes = 16 * 1024,
                "repeated-work" => expected.repeated_work_detection = true,
                "stable-api-prefix" => expected.stable_api_prefix = true,
                _ => {}
            }
            apply_efficiency_variant(&mut actual, variant);
            assert_eq!(actual, expected, "{variant} changed an unrelated policy");
            assert!(!actual.policies());
        }
    }

    #[test]
    fn no_budget_is_rejected() {
        let spec:Spec=serde_json::from_value(json!({"schema":"gyro.efficiency-benchmark.v2","providers":[],"trials":3,"timeoutSeconds":180,"variants":["baseline"],"cacheConditions":["fresh-session"],"executionBudget":{"maxCalls":0,"maxObservedTokens":0,"maxCostMicros":null,"currency":"USD"},"tasks":[]})).unwrap();
        assert!(validate(&spec).is_err());
    }

    #[test]
    fn routine_profile_never_overrides_explicit_effort() {
        let routine = vec!["baseline".to_string(), "routine-profile".to_string()];
        assert!(routine_effort_allowed(&routine, ""));
        assert!(!routine_effort_allowed(&routine, "high"));
        assert!(routine_effort_allowed(&["baseline".into()], "high"));
    }
}
