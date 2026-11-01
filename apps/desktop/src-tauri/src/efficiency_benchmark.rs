//! Explicit v2 pilot. Serial runs preserve budgets and avoid cross-variant cache/config races.
use super::*;
use gyro_core::efficiency::pricing::PriceSnapshot;
use serde_json::{json, Value};
use std::collections::BTreeMap;
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
    tasks: Vec<Task>,
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
    files: BTreeMap<String, String>,
    turns: Vec<String>,
    allowed_changes: Vec<String>,
    verifier: String,
    #[serde(default)]
    reference_solution: BTreeMap<String, String>,
}
pub(super) fn start(app: &tauri::AppHandle, root: PathBuf, spec: Value) -> anyhow::Result<bool> {
    let spec: Spec = serde_json::from_value(spec)?;
    validate(&spec)?;
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
    for provider in &mut config.model_providers {
        provider.enabled = spec
            .providers
            .iter()
            .any(|selected| selected.id == provider.id);
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
    let mut ids = HashSet::new();
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
                    | "recoverable-evidence"
                    | "catalog-retention"
                    | "routine-profile"
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
fn verify(task: &Task, workspace: &Path, verifier: &Path) -> anyhow::Result<bool> {
    let result = run_bounded_command(
        &{
            let mut c = command_with_gui_path("node");
            c.arg("--test")
                .arg(verifier)
                .env("GYRO_VERIFY_WORKSPACE", workspace)
                .current_dir(workspace);
            c
        },
        Duration::from_secs(60),
        None,
        64 * 1024,
        64 * 1024,
    )?;
    let changes = Command::new("git")
        .args(["status", "--porcelain", "--untracked-files=all"])
        .current_dir(workspace)
        .output()?;
    let allowed = String::from_utf8_lossy(&changes.stdout).lines().all(|l| {
        l.get(3..)
            .is_some_and(|p| task.allowed_changes.iter().any(|a| a == p))
    });
    Ok(matches!(
        result.termination,
        ExecutionTermination::Exited { code: Some(0) }
    ) && allowed)
}
fn turn_receipt<'a>(
    events: &'a [SessionEvent],
    turn_id: Uuid,
    kind: &str,
) -> Option<&'a SessionEvent> {
    events
        .iter()
        .rev()
        .find(|event| event.turn_id == Some(turn_id) && event.payload["kind"] == kind)
}

// Simulate the review step only for the benchmark's disposable fixture and
// declared edit paths. Keep normal app approvals and Full access unchanged.
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

fn run(app: &tauri::AppHandle, root: &Path, spec: Spec) -> anyhow::Result<()> {
    let paths = GyroPaths::for_current_user()?;
    let store = SessionStore::open(paths.clone())?;
    let mut records = Vec::<Value>::new();
    let mut spent = 0u64;
    let mut cost = 0u64;
    let mut calls = 0u32;
    let mut unknown = false;
    for task in &spec.tasks {
        let verifier = root.join(format!("verifier-{}.mjs", task.id));
        fs::write(&verifier, &task.verifier)?;
        for provider in &spec.providers {
            for condition in &spec.cache_conditions {
                for trial in 1..=spec.trials {
                    // Alternating order reduces systematic first-run bias without claiming cold cache control.
                    let mut variants = spec.variants.clone();
                    if trial % 2 == 0 {
                        variants.reverse();
                    }
                    for variant in variants {
                        let mut record = json!({"task":task.id,"category":task.category,"repositorySnapshot":task.repository_snapshot,"provider":provider.id,"model":provider.model,"modelVersionCoverage":"requested-model-id","effort":provider.effort,"variant":variant,"trial":trial,"sessionCondition":condition,"cacheCondition":"unverified","comparison":"gyro","verified":false});
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
                        GyroConfig::update(&paths, |cfg| {
                            let e = &mut cfg.efficiency;
                            e.experimental = variant != "baseline";
                            e.structured_evidence =
                                variant == "combined" || variant == "structured-evidence";
                            e.cache_assembly = variant == "combined" || variant == "cache-assembly";
                            e.task_state = variant == "combined" || variant == "task-state";
                            e.repository_retrieval =
                                variant == "combined" || variant == "retrieval";
                            e.progress_detection =
                                variant == "combined" || variant == "progress-detection";
                            e.compact_tool_catalog =
                                variant == "combined" || variant == "compact-tool-catalog";
                            e.recoverable_evidence =
                                variant == "combined" || variant == "recoverable-evidence";
                            e.retain_tool_catalog =
                                variant == "combined" || variant == "catalog-retention";
                            e.profile = if variant == "routine-profile" {
                                gyro_core::efficiency::Profile::Routine
                            } else {
                                gyro_core::efficiency::Profile::Standard
                            };
                            Ok(())
                        })?;
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
                        record["sessionId"] = json!(session.id);
                        let legacy = super::performance_benchmark::Provider {
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
                        record["approvalSimulation"] =
                            json!("allowlisted-fixture-review-during-turn");
                        let prompts = if condition == "resumed-session" {
                            std::iter::once("Inspect the repository overview. Do not edit files. Preserve subsequent task constraints.".to_string()).chain(task.turns.clone()).collect::<Vec<_>>()
                        } else {
                            task.turns.clone()
                        };
                        for prompt in prompts {
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
                            let (response, reviewed_turn) = with_fixture_review(
                                &store,
                                root,
                                &workspace,
                                session.id,
                                turn_id,
                                &task.allowed_changes,
                                || {
                                    super::performance_benchmark::turn_with_id(
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
                            let events = store.read_events(session.id)?;
                            let receipt = turn_receipt(&events, turn_id, "efficiency-receipt");
                            let requested_effort = receipt
                                .and_then(|e| e.payload.get("requestedReasoningEffort"))
                                .filter(|v| v.is_null() || v.is_string())
                                .cloned();
                            requested_efforts = requested_efforts.zip(requested_effort).map(
                                |(mut efforts, effort)| {
                                    efforts.push(effort);
                                    efforts
                                },
                            );
                            let overhead = receipt
                                .map(|e| e.payload["optimizationOverheadMicros"].clone())
                                .unwrap_or(json!({}));
                            record["optimizationOverheadMicros"] = overhead;
                            // Task totals include setup turns, failures and all continuations.
                            if let Some(receipt) = receipt {
                                record["efficiencyEvents"] =
                                    receipt.payload["taskTotals"]["efficiencyEvents"].clone();
                                record["efficiencyEventCoverage"] = receipt.payload["taskTotals"]
                                    ["efficiencyEventCoverage"]
                                    .clone();
                            }
                            let observed =
                                receipt.and_then(|e| e.payload["generationRequests"].as_u64());
                            generation_requests = generation_requests
                                .zip(observed)
                                .and_then(|(a, b)| a.checked_add(b));
                            let observed_retries =
                                receipt.and_then(|e| e.payload["retryCount"].as_u64());
                            retries = retries
                                .zip(observed_retries)
                                .and_then(|(a, b)| a.checked_add(b));
                            // A missing receipt makes call/retry accounting unknown; stop further spending.
                            if observed.is_none() || observed_retries.is_none() {
                                unknown = true;
                            }
                            let observed_calls = observed.unwrap_or(1).max(1);
                            calls = calls.saturating_add(
                                observed_calls.saturating_sub(1).min(u64::from(u32::MAX)) as u32,
                            );

                            let latest = turn_receipt(&events, turn_id, "provider-turn-tokens");
                            let tokens = latest.and_then(|e| {
                                serde_json::from_value::<UsageTokens>(
                                    e.payload["turnTokens"].clone(),
                                )
                                .ok()
                            });
                            if let Some(tokens) = tokens {
                                spent = spent.saturating_add(tokens.total_tokens);
                                usage = Some(usage.map_or(tokens, |u| u.combine(tokens)));
                                if !tokens.measured {
                                    unknown = true;
                                }
                            } else {
                                unknown = true;
                            }
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
                                if let Some(c) = tokens.and_then(|t| price.price(t)) {
                                    cost = cost.saturating_add(c.micros);
                                } else if spec.execution_budget.max_cost_micros.is_some() {
                                    unknown = true;
                                }
                            }
                            match response {
                                Ok(_) => match reviewed_turn {
                                    Ok(_) => {}
                                    Err(error) => {
                                        outcome = "failed";
                                        record["failureClass"] = json!("fixture-review-failed");
                                        record["failureDetail"] = json!(
                                            gyro_core::security::redact_secrets(&error.to_string())
                                                .chars()
                                                .take(500)
                                                .collect::<String>()
                                        );
                                        break;
                                    }
                                },
                                Err(error) => {
                                    outcome = "failed";
                                    record["failureClass"] =
                                        json!(super::performance_benchmark::failure_class(&error));
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
                        record["generationRequests"] = json!(generation_requests);
                        let consistent_effort = requested_efforts.as_ref().and_then(|efforts| {
                            let first = efforts.first()?;
                            efforts
                                .iter()
                                .all(|effort| effort == first)
                                .then_some(first)
                        });
                        record["requestedReasoningEffort"] =
                            consistent_effort.cloned().unwrap_or(Value::Null);
                        record["requestedEffortCoverage"] = json!(if consistent_effort.is_some() {
                            "observed"
                        } else if requested_efforts
                            .as_ref()
                            .is_some_and(|efforts| !efforts.is_empty())
                        {
                            "mixed"
                        } else {
                            "unavailable"
                        });
                        record["verified"] =
                            json!(outcome == "done" && verify(task, &workspace, &verifier)?);
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
                            record["verified"] = json!(verify(task, &workspace, &verifier)?);
                            unknown = true;
                        }
                        records.push(record);
                        persist(root, &records)?;
                    }
                }
            }
        }
    }
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

    #[test]
    fn missing_turn_receipt_never_reuses_setup_turn_usage() {
        let session = Uuid::new_v4();
        let setup = Uuid::new_v4();
        let task = Uuid::new_v4();
        let mut old = SessionEvent::new(
            session,
            SessionEventKind::SystemEvent,
            "",
            json!({
                "kind": "provider-turn-tokens", "turnTokens": {"totalTokens": 5000}
            }),
        );
        old.turn_id = Some(setup);
        assert!(turn_receipt(&[old.clone()], task, "provider-turn-tokens").is_none());
        let mut own = SessionEvent::new(
            session,
            SessionEventKind::SystemEvent,
            "",
            json!({
                "kind": "provider-turn-tokens", "turnTokens": {"totalTokens": 300}
            }),
        );
        own.turn_id = Some(task);
        let events = [own, old];
        assert_eq!(
            turn_receipt(&events, task, "provider-turn-tokens")
                .unwrap()
                .payload["turnTokens"]["totalTokens"],
            300
        );
    }
}
