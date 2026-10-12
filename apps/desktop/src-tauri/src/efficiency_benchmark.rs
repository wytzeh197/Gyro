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
    let mut config = GyroConfig::default();
    config.require_command_approval = false;
    config.require_file_edit_approval = false;
    config.efficiency.prices = spec.prices.clone();
    config.usage_guard.max_calls_per_window = spec.execution_budget.max_calls;
    config.usage_guard.max_tokens_per_call = spec.execution_budget.max_observed_tokens;
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
                            Ok(())
                        })?;
                        let workspace = root.join("workspaces").join(Uuid::new_v4().to_string());
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
                        let session = store.create_session(
                            &workspace,
                            SessionOrigin::Desktop,
                            "Efficiency pilot",
                        )?;
                        record["sessionId"] = json!(session.id);
                        let legacy = super::performance_benchmark::Provider {
                            id: provider.id.clone(),
                            model: provider.model.clone(),
                            effort: provider.effort.clone(),
                        };
                        let started = Instant::now();
                        let mut usage = None::<UsageTokens>;
                        let mut outcome = "done";
                        let mut retries = 0u32;
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
                            let response = super::performance_benchmark::turn(
                                app,
                                &store,
                                session.id,
                                &workspace,
                                &legacy,
                                &prompt,
                                spec.timeout_seconds,
                            );
                            let events = store.read_events(session.id)?;
                            let overhead = events
                                .iter()
                                .rev()
                                .find(|e| e.payload["kind"] == "efficiency-receipt")
                                .map(|e| e.payload["optimizationOverheadMicros"].clone())
                                .unwrap_or(json!({}));
                            record["optimizationOverheadMicros"] = overhead;
                            let observed_calls = events
                                .iter()
                                .rev()
                                .find(|e| e.payload["kind"] == "efficiency-receipt")
                                .and_then(|e| e.payload["generationRequests"].as_u64())
                                .unwrap_or(1)
                                .max(1);
                            calls = calls.saturating_add(
                                observed_calls.saturating_sub(1).min(u64::from(u32::MAX)) as u32,
                            );

                            let latest = events
                                .iter()
                                .rev()
                                .find(|e| e.payload["kind"] == "provider-turn-tokens");
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
                                Ok((_, r)) => {
                                    retries += r.assistant_event.payload["retryCount"]
                                        .as_u64()
                                        .unwrap_or(0)
                                        as u32;
                                }
                                Err(error) => {
                                    outcome = "failed";
                                    record["failureClass"] =
                                        json!(super::performance_benchmark::failure_class(&error));
                                    break;
                                }
                            }
                        }
                        record["outcome"] = json!(outcome);
                        record["elapsedMs"] = json!(started.elapsed().as_millis());
                        record["tokens"] = json!(usage);
                        record["retries"] = json!(retries);
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
                            let workspace =
                                root.join("workspaces").join(Uuid::new_v4().to_string());
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
    fn no_budget_is_rejected() {
        let spec:Spec=serde_json::from_value(json!({"schema":"gyro.efficiency-benchmark.v2","providers":[],"trials":3,"timeoutSeconds":180,"variants":["baseline"],"cacheConditions":["fresh-session"],"executionBudget":{"maxCalls":0,"maxObservedTokens":0,"maxCostMicros":null,"currency":"USD"},"tasks":[]})).unwrap();
        assert!(validate(&spec).is_err());
    }
}
