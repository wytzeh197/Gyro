//! Debug-only, explicit benchmark entry. Calls the desktop's real chat command
//! with disposable workspaces and a separate store. Never included in releases.
use crate::{
    ipc::cli::start_cli_ipc_listener,
    provider_reliability::is_transient_provider_error,
    providers::{
        chat_types::{ProviderChatRequest, ProviderChatResponse},
        commands::{compact_provider_chat, run_provider_chat},
        retry::is_provider_cancellation,
        session_lifecycle::reconcile_interrupted_provider_turns,
    },
    session_browser,
    state::{
        managers::ProviderCancellationManager,
        provider_run::{stop_provider_run, ProviderRunControl, ProviderStopReason},
    },
    stores::{open_store, to_string},
};
use gyro_core::{
    timing, CapabilityAccess, CapabilityClass, GyroConfig, GyroPaths, ProjectCapabilityPolicy,
    SessionOrigin, SessionStore,
};
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::{Duration, Instant},
};
use tauri::Manager;
use uuid::Uuid;
#[path = "benchmark_fixture_review.rs"]
mod fixture_review;
use fixture_review::FixtureReviewer;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Spec {
    providers: Vec<Provider>,
    trials: usize,
    timeout_seconds: u64,
    #[serde(default)]
    tasks: Option<Vec<String>>,
    #[serde(default)]
    review_fixture_edits: bool,
    #[serde(default)]
    require_file_edit_approval: bool,
    #[serde(default)]
    compact_before_resume: bool,
    #[serde(default)]
    local_fixture_endpoint: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Provider {
    pub(super) id: String,
    pub(super) model: String,
    pub(super) effort: String,
}

pub fn start(app: &tauri::AppHandle) -> Result<bool, Box<dyn std::error::Error>> {
    let Ok(spec_path) = std::env::var("GYRO_PERFORMANCE_BENCHMARK") else {
        return Ok(false);
    };
    let requested_root = PathBuf::from(std::env::var("GYRO_TEST_DATA_DIR")?);
    let data_root = requested_root.canonicalize()?;
    let root = benchmark_root(
        &data_root,
        std::env::var_os("GYRO_BENCHMARK_ROOT").map(PathBuf::from),
    )?;
    let temporary_root = std::env::temp_dir().canonicalize()?;
    if !requested_root.is_absolute()
        || root == temporary_root
        || root == Path::new("/private/tmp")
        || !(root.starts_with(&temporary_root) || root.starts_with("/private/tmp"))
    {
        return Err("benchmark data must be in an absolute temporary directory".into());
    }
    let raw: serde_json::Value = serde_json::from_slice(&fs::read(&spec_path)?)?;
    if raw["schema"] == "gyro.efficiency-benchmark.v2" {
        if std::env::var("GYRO_LOCAL_PROVIDER_FIXTURE").as_deref() == Ok("1") {
            return Err("local provider fixture refuses alternate benchmark schemas".into());
        }
        return super::efficiency_benchmark::start(app, root, raw).map_err(Into::into);
    }
    let spec: Spec = serde_json::from_value(raw)?;
    if std::env::var("GYRO_LOCAL_PROVIDER_FIXTURE").as_deref() == Ok("1")
        && spec.local_fixture_endpoint.is_none()
    {
        return Err("local provider fixture refuses a non-fixture benchmark spec".into());
    }
    if let Some(endpoint) = &spec.local_fixture_endpoint {
        let endpoint = url::Url::parse(endpoint)?;
        if std::env::var("GYRO_LOCAL_PROVIDER_FIXTURE").as_deref() != Ok("1")
            || endpoint.scheme() != "http"
            || endpoint.host_str() != Some("127.0.0.1")
            || endpoint.port().is_none()
            || endpoint.path() != "/v1"
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || spec.providers.len() != 1
            || spec.providers[0].id != "local-runtime-fixture"
        {
            return Err("local provider fixture requires its explicit loopback-only runner".into());
        }
    }
    if spec.compact_before_resume && (spec.providers.len() != 1 || spec.providers[0].id != "openai")
    {
        return Err("native compaction acceptance requires the isolated Codex cohort".into());
    }
    if spec.require_file_edit_approval && !spec.review_fixture_edits {
        return Err("edit approval acceptance requires the scoped fixture reviewer".into());
    }
    if spec.review_fixture_edits && data_root != root.join("data") {
        return Err("fixture review requires the isolated data/workspaces layout".into());
    }
    if !(1..=5).contains(&spec.trials)
        || !(10..=300).contains(&spec.timeout_seconds)
        || spec.providers.is_empty()
        || spec.providers.len() > 3
    {
        return Err("invalid benchmark bounds".into());
    }
    if let Some(tasks) = &spec.tasks {
        if tasks.is_empty()
            || tasks.len() > 4
            || tasks.iter().any(|task| {
                !matches!(
                    task.as_str(),
                    "readme" | "code" | "follow-up" | "no-tool" | "browser"
                )
            })
            || tasks.iter().collect::<HashSet<_>>().len() != tasks.len()
        {
            return Err("invalid benchmark task selection".into());
        }
    }
    if spec
        .tasks
        .as_ref()
        .is_some_and(|tasks| tasks.iter().any(|task| task == "browser"))
        && spec.local_fixture_endpoint.is_none()
    {
        return Err("browser sequence benchmark requires the local fixture".into());
    }
    for provider in &spec.providers {
        if spec.local_fixture_endpoint.is_some() && provider.id == "local-runtime-fixture" {
            continue;
        }
        if !GyroConfig::default()
            .model_providers
            .iter()
            .any(|configured| configured.id == provider.id)
            || gyro_core::provider_descriptor(&provider.id).is_none_or(|descriptor| {
                descriptor.execution_kind == gyro_core::ProviderExecutionKind::ReadinessOnly
            })
        {
            return Err("unsupported benchmark provider".into());
        }
    }
    let ids = spec.providers.iter().map(|p| &p.id).collect::<HashSet<_>>();
    if ids.len() != spec.providers.len() {
        return Err("duplicate benchmark providers".into());
    }
    if !timing::enabled() {
        return Err("benchmark requires opt-in timing diagnostics".into());
    }
    let paths = GyroPaths::for_current_user()?;
    paths.ensure()?;
    let store = SessionStore::open(paths.clone())?;
    reconcile_interrupted_provider_turns(&store)
        .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
    let mut config = GyroConfig::default();
    // The explicit matrix includes bootstrap turns and bounded recovery attempts.
    // Keep a finite ceiling in this disposable store; never alter the user's store.
    config.usage_guard.max_calls_per_window = 200;
    config.require_command_approval = false;
    config.require_file_edit_approval = spec.require_file_edit_approval;
    for provider in &mut config.model_providers {
        provider.enabled = spec.providers.iter().any(|p| p.id == provider.id);
    }
    if let Some(endpoint) = &spec.local_fixture_endpoint {
        // A declared kind without a catalog/custom id has no credential-store
        // account. This fixture can exercise the real HTTP runner keylessly.
        config.model_providers.push(gyro_core::ModelProviderConfig {
            id: "local-runtime-fixture".into(),
            display_name: "Local scripted runtime fixture".into(),
            base_url: Some(endpoint.clone()),
            api_key_ref: String::new(),
            enabled: true,
            default_model_id: Some(spec.providers[0].model.clone()),
            kind: Some(gyro_core::OPENAI_COMPATIBLE_KIND.into()),
            model_ids: vec![spec.providers[0].model.clone()],
        });
    }
    config.save(&paths)?;
    start_cli_ipc_listener(app.clone());
    let app = app.clone();
    std::thread::spawn(move || {
        let result: anyhow::Result<()> = std::thread::scope(|scope| {
            let workers = spec
                .providers
                .into_iter()
                .map(|provider| {
                    let app = &app;
                    let root = &root;
                    let tasks = spec.tasks.clone();
                    let local_fixture_endpoint = spec.local_fixture_endpoint.clone();
                    scope.spawn(move || {
                        run(
                            app,
                            root,
                            Spec {
                                providers: vec![provider],
                                trials: spec.trials,
                                timeout_seconds: spec.timeout_seconds,
                                tasks,
                                review_fixture_edits: spec.review_fixture_edits,
                                require_file_edit_approval: spec.require_file_edit_approval,
                                compact_before_resume: spec.compact_before_resume,
                                local_fixture_endpoint,
                            },
                        )
                    })
                })
                .collect::<Vec<_>>();
            for worker in workers {
                worker
                    .join()
                    .map_err(|_| anyhow::anyhow!("benchmark worker panicked"))??;
            }
            Ok(())
        });
        if let Err(error) = &result {
            eprintln!(
                "benchmark infrastructure failed: {}",
                gyro_core::security::redact_secrets(&error.to_string())
            );
        }
        app.exit(if result.is_ok() { 0 } else { 1 });
    });
    Ok(true)
}

fn benchmark_root(data_root: &Path, requested_root: Option<PathBuf>) -> anyhow::Result<PathBuf> {
    let Some(requested_root) = requested_root.filter(|root| !root.as_os_str().is_empty()) else {
        return Ok(data_root.to_path_buf());
    };
    anyhow::ensure!(
        requested_root.is_absolute(),
        "benchmark root must be absolute"
    );
    let root = requested_root.canonicalize()?;
    anyhow::ensure!(
        data_root == root.join("data"),
        "isolated benchmark store must be the data directory inside its benchmark root"
    );
    Ok(root)
}

fn fixture(path: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(path.join("src"))?;
    fs::create_dir_all(path.join("docs"))?;
    let mut readme = String::from("# Meridian Tools\n\nSmall local utility functions.\n\n## Install\n\nRequires Node 22 or newer. No dependencies.\n\n## Usage\n\nImport clamp from src/clamp.mjs.\n\n## Development\n\nRun node --test.\n\nMore details: [Guide](docs/guide.md).\n\n");
    while readme.lines().count() < 267 {
        readme.push_str("The clamp helper keeps a number within its lower and upper bounds.\n");
    }
    fs::write(path.join("README.md"), readme)?;
    fs::write(
        path.join("docs/guide.md"),
        "# Guide\nclamp(value, minimum, maximum) limits a number to the inclusive range.\n",
    )?;
    fs::write(
        path.join("src/clamp.mjs"),
        "export function clamp(value, minimum, maximum) {\n  return Math.max(value, minimum);\n}\n",
    )?;
    fs::write(path.join("clamp.test.mjs"), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { clamp } from './src/clamp.mjs';\ntest('lower bound', () => assert.equal(clamp(-1, 0, 10), 0));\n")?;
    fs::write(path.join("AGENTS.md"), "Work only in this workspace. Complete the requested change with minimal tools. Preserve unrelated files. Do not use network access, install dependencies, commit, push, or delegate. Verify code edits with node --test. Keep your final response brief.\n")?;
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
                .current_dir(path)
                .output()?
                .status
                .success(),
            "fixture git initialization failed"
        );
    }
    Ok(())
}
fn run(app: &tauri::AppHandle, root: &Path, spec: Spec) -> anyhow::Result<()> {
    let store = open_store().map_err(anyhow::Error::msg)?;
    let started = Instant::now();
    let tasks = spec
        .tasks
        .unwrap_or_else(|| vec!["readme".into(), "code".into(), "follow-up".into()]);
    let report_path = root.join(format!("benchmark-{}.json", spec.providers[0].id));
    let mut records: Vec<serde_json::Value> = fs::read(&report_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| {
            value
                .get("records")
                .and_then(|records| serde_json::from_value(records.clone()).ok())
        })
        .unwrap_or_default();
    let review_mode = if spec.review_fixture_edits {
        "task-paths"
    } else {
        "none"
    };
    anyhow::ensure!(
        records
            .iter()
            .all(|record| record["fixtureReviewMode"].as_str().unwrap_or("none") == review_mode),
        "cannot resume a checkpoint with a different fixture review mode"
    );
    anyhow::ensure!(
        records.iter().all(|record| {
            record["requireFileEditApproval"].as_bool().unwrap_or(false)
                == spec.require_file_edit_approval
        }),
        "cannot resume a checkpoint with a different edit approval posture"
    );
    anyhow::ensure!(
        records.iter().all(
            |record| record["compactBeforeResume"].as_bool().unwrap_or(false)
                == spec.compact_before_resume
        ),
        "cannot resume a checkpoint with a different compaction posture"
    );
    for provider in spec.providers {
        let mut unavailable: Option<String> = None;
        for task in &tasks {
            for resumed in [false, true] {
                for trial in 1..=spec.trials {
                    if records.iter().any(|record| {
                        record["provider"] == provider.id
                            && record["model"] == provider.model
                            && record["effort"] == provider.effort
                            && record["task"] == task.as_str()
                            && record["resumedRequested"] == resumed
                            && record["trial"] == trial
                    }) {
                        continue;
                    }
                    let workspace = root.join("workspaces").join(format!(
                        "{}-{task}-{}-{trial}",
                        provider.id,
                        if resumed { "resumed" } else { "fresh" }
                    ));
                    let workspace = if workspace.exists() {
                        workspace.with_file_name(format!(
                            "{}-{}",
                            workspace.file_name().unwrap().to_string_lossy(),
                            Uuid::new_v4()
                        ))
                    } else {
                        workspace
                    };
                    let mut record = json!({"provider":provider.id,"model":provider.model,"effort":provider.effort,"task":task,"resumedRequested":resumed,"trial":trial,"fixtureReviewMode":if spec.review_fixture_edits {"task-paths"} else {"none"}, "requireFileEditApproval":spec.require_file_edit_approval,"compactBeforeResume":spec.compact_before_resume});
                    if let Some(reason) = &unavailable {
                        record["outcome"] = "unavailable".into();
                        record["failureClass"] = reason.clone().into();
                    } else {
                        fixture(&workspace)?;
                        let mut policy =
                            ProjectCapabilityPolicy::defaults(workspace.display().to_string());
                        policy
                            .classes
                            .insert(CapabilityClass::TerminalExecute, CapabilityAccess::Allow);
                        policy
                            .classes
                            .insert(CapabilityClass::GithubInspect, CapabilityAccess::Deny);
                        policy
                            .classes
                            .insert(CapabilityClass::GithubWrite, CapabilityAccess::Deny);
                        policy.classes.insert(
                            CapabilityClass::BrowserNavigate,
                            if task == "browser" && spec.local_fixture_endpoint.is_some() {
                                CapabilityAccess::Allow
                            } else {
                                CapabilityAccess::Deny
                            },
                        );
                        store.save_project_capability_policy(policy, None)?;
                        let session = store.create_session(
                            &workspace,
                            SessionOrigin::Desktop,
                            "Performance benchmark",
                        )?;
                        store.update_session_model(
                            session.id,
                            Some(provider.id.clone()),
                            None,
                            Some(provider.model.clone()),
                            None,
                            selected_effort(&provider).map(str::to_owned),
                        )?;
                        let mut bootstrap = if resumed {
                            let prompt = if task == "no-tool" {
                                "Remember the exact test keyword GYRO_OK for my next request. Reply exactly MEMORIZED. Do not use any tools."
                            } else {
                                "Read README.md and src/clamp.mjs. Remember that the project mascot is heron for my next request. Do not modify files. Reply in one sentence."
                            };
                            Some(turn(
                                app,
                                &store,
                                session.id,
                                &workspace,
                                &provider,
                                prompt,
                                spec.timeout_seconds,
                            ))
                        } else {
                            None
                        };
                        if spec.compact_before_resume
                            && bootstrap.as_ref().is_some_and(Result::is_ok)
                        {
                            let compaction_turn = Uuid::new_v4();
                            match compact_fixture(
                                app,
                                session.id,
                                compaction_turn,
                                spec.timeout_seconds,
                            ) {
                                Ok(events) => {
                                    record["compactionOutcome"] = "completed".into();
                                    record["compactionTurnId"] = compaction_turn.to_string().into();
                                    record["compactionActivityEvents"] = events.into();
                                }
                                Err(error) => {
                                    record["compactionOutcome"] = "failed".into();
                                    bootstrap = Some(Err(error));
                                }
                            }
                        }
                        if let Some(Err(error)) = bootstrap.as_ref() {
                            let class = failure_class(error);
                            record["outcome"] = "setup-failed".into();
                            record["failureClass"] = class.into();
                            record["failureDetail"] = gyro_core::security::redact_secrets(error)
                                .chars()
                                .take(1200)
                                .collect::<String>()
                                .into();
                            if matches!(
                                class,
                                "authentication" | "model-unavailable" | "executable-unavailable"
                            ) {
                                unavailable = Some(class.into());
                            }
                        } else {
                            let prompt = match task.as_str() {
                                "browser" => "BROWSER_SEQUENCE: Open the local browser fixture with reveal false, set responsive viewport width 1440 and height 960, then immediately capture a screenshot. Reply exactly BROWSER_OK after checking its image.",
                                "no-tool" if resumed => "Reply with the exact test keyword I asked you to remember. Do not use any tools or change any files. Reply with only that keyword.",
                                "no-tool" => "Reply exactly GYRO_OK. Do not use any tools or change any files.",
                                "readme" => "Shorten README.md from 267 lines to at most 85 lines. Preserve the project name, install requirements, usage, development command, and docs/guide.md link. Edit only README.md.",
                                "code" => "Fix clamp in src/clamp.mjs so it enforces both inclusive bounds. Add exactly one upper-bound regression test in clamp.test.mjs. Run node --test. Edit only these two files.",
                                _ if resumed => "Append exactly one line to README.md using the mascot I asked you to remember. Use the form `Mascot: name` with no trailing punctuation. Edit only README.md.",
                                _ => "Context: the project mascot is heron. Append exactly the line `Mascot: heron` to README.md, with no trailing punctuation. Edit only README.md.",
                            };
                            let turn_id = Uuid::new_v4();
                            let reviewer = if spec.review_fixture_edits {
                                let mut reviewer = FixtureReviewer::new(
                                    &store, root, &workspace, session.id, turn_id, task,
                                )?;
                                reviewer.require_file_edit_approval =
                                    spec.require_file_edit_approval;
                                Some(reviewer)
                            } else {
                                None
                            };
                            let at = Instant::now();
                            let (result, review_audit) = turn_with_reviewer(
                                app,
                                &store,
                                session.id,
                                &workspace,
                                &provider,
                                prompt,
                                spec.timeout_seconds,
                                turn_id,
                                reviewer,
                            );
                            record["turnId"] = turn_id.to_string().into();
                            record["fixtureReviews"] = review_audit.into();
                            record["wallMs"] = (at.elapsed().as_secs_f64() * 1000.).into();
                            record["sessionId"] = session.id.to_string().into();
                            match result {
                                Ok((turn_id, response)) => {
                                    record["turnId"] = turn_id.to_string().into();
                                    record["resumedActual"] = response
                                        .assistant_event
                                        .payload
                                        .get("resumed")
                                        .cloned()
                                        .unwrap_or(serde_json::Value::Null);
                                    record["retryCount"] = response
                                        .assistant_event
                                        .payload
                                        .get("retryCount")
                                        .cloned()
                                        .unwrap_or(serde_json::Value::Null);
                                    record["outcome"] = "completed".into();
                                    record["correct"] = if task == "no-tool" {
                                        let calls = store
                                            .read_events(session.id)?
                                            .iter()
                                            .filter(|event| event.turn_id == Some(turn_id))
                                            .filter(|event| {
                                                event.payload.get("capabilityId").is_some()
                                                    || matches!(
                                                        event.payload["activityKind"].as_str(),
                                                        Some(
                                                            "tool"
                                                                | "command"
                                                                | "file"
                                                                | "browser"
                                                                | "agent"
                                                        )
                                                    )
                                            })
                                            .count();
                                        record["toolActivityRecords"] = calls.into();
                                        (response.assistant_event.message.trim() == "GYRO_OK"
                                            && calls == 0
                                            && verify(&workspace, &task))
                                        .into()
                                    } else if task == "browser" {
                                        let snapshot = app
                                            .state::<session_browser::SessionBrowserManager>()
                                            .get_snapshot(&session.id.to_string())
                                            .map_err(anyhow::Error::msg)?;
                                        (response.assistant_event.message.trim() == "BROWSER_OK"
                                            && snapshot.is_some_and(|s| {
                                                s.document_committed
                                                    && s.viewport.width == 1440.0
                                                    && s.viewport.height == 960.0
                                            })
                                            && verify(&workspace, "no-tool"))
                                        .into()
                                    } else {
                                        verify(&workspace, &task).into()
                                    };
                                    record["responsePresent"] =
                                        (!response.assistant_event.message.trim().is_empty())
                                            .into();
                                }
                                Err(error) => {
                                    let class = failure_class(&error);
                                    record["outcome"] = "failed".into();
                                    record["failureClass"] = class.into();
                                    record["failureDetail"] =
                                        gyro_core::security::redact_secrets(&error)
                                            .chars()
                                            .take(1200)
                                            .collect::<String>()
                                            .into();
                                    record["correct"] =
                                        (task != "no-tool" && verify(&workspace, &task)).into();
                                    if matches!(
                                        class,
                                        "authentication"
                                            | "model-unavailable"
                                            | "executable-unavailable"
                                    ) {
                                        unavailable = Some(class.into());
                                    }
                                }
                            }
                        }
                    }
                    eprintln!(
                        "benchmark {} {} {} trial {}: {}",
                        provider.id,
                        task,
                        if resumed { "resumed" } else { "fresh" },
                        trial,
                        record["outcome"]
                    );
                    records.push(record);
                    fs::write(
                        &report_path,
                        serde_json::to_vec_pretty(
                            &json!({"schema":"gyro.benchmark.v1","fixture":"meridian-v1","build":"debug","frontendMeasured":false,"elapsedMs":started.elapsed().as_millis(),"records":records}),
                        )?,
                    )?;
                }
            }
        }
    }
    Ok(())
}
pub(super) fn turn(
    app: &tauri::AppHandle,
    store: &SessionStore,
    session: Uuid,
    workspace: &Path,
    provider: &Provider,
    prompt: &str,
    timeout_seconds: u64,
) -> Result<(Uuid, ProviderChatResponse), String> {
    turn_with_id(
        app,
        store,
        session,
        workspace,
        provider,
        prompt,
        timeout_seconds,
        Uuid::new_v4(),
    )
}

/// A known ID lets an evaluator correlate even a failed turn with its own receipts.
pub(super) fn turn_with_id(
    app: &tauri::AppHandle,
    store: &SessionStore,
    session: Uuid,
    workspace: &Path,
    provider: &Provider,
    prompt: &str,
    timeout_seconds: u64,
    turn_id: Uuid,
) -> Result<(Uuid, ProviderChatResponse), String> {
    turn_with_reviewer(
        app,
        store,
        session,
        workspace,
        provider,
        prompt,
        timeout_seconds,
        turn_id,
        None,
    )
    .0
}

fn turn_with_reviewer(
    app: &tauri::AppHandle,
    store: &SessionStore,
    session: Uuid,
    workspace: &Path,
    provider: &Provider,
    prompt: &str,
    timeout_seconds: u64,
    turn_id: Uuid,
    mut reviewer: Option<FixtureReviewer>,
) -> (
    Result<(Uuid, ProviderChatResponse), String>,
    Vec<serde_json::Value>,
) {
    let request = (|| -> Result<ProviderChatRequest, String> {
        store
            .append_user_turn_message_with_turn_id(session, prompt, json!({}), turn_id)
            .map_err(to_string)?;
        serde_json::from_value(json!({
        "sessionId":session,"turnId":turn_id,"workspacePath":workspace,"providerId":provider.id,
        "modelId":provider.model,"reasoningEffort":selected_effort(provider),"message":prompt,
        "requireCommandApproval":false,"requireFileEditApproval":reviewer.as_ref().is_some_and(|reviewer| reviewer.require_file_edit_approval),"fullAccess":false,"mode":"normal"
    })).map_err(to_string)
    })();
    let request = match request {
        Ok(request) => request,
        Err(error) => return (Err(error), Vec::new()),
    };
    let watcher_app = app.clone();
    let review_paths = store.paths().clone();
    let finished = Arc::new(AtomicBool::new(false));
    let watcher_finished = finished.clone();
    let (done, completion) = mpsc::channel();
    let watchdog = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(timeout_seconds);
        let review_store = if reviewer.is_some() {
            match SessionStore::open(review_paths) {
                Ok(store) => Some(store),
                Err(_) => {
                    reviewer
                        .as_mut()
                        .unwrap()
                        .audit
                        .push(json!({"decision":"review-error", "status":"store-unavailable"}));
                    None
                }
            }
        } else {
            None
        };
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            let wait = if reviewer.is_some() {
                remaining.min(Duration::from_millis(50))
            } else {
                remaining
            };
            match completion.recv_timeout(wait) {
                Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return reviewer.map_or_else(Vec::new, |reviewer| reviewer.audit)
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if let (Some(reviewer), Some(store)) = (&mut reviewer, &review_store) {
                let stopped = || {
                    watcher_finished.load(Ordering::Acquire)
                        || Instant::now() >= deadline
                        || !fixture_turn_active(&watcher_app, session, turn_id)
                };
                if reviewer
                    .poll(store, stopped)
                    .and_then(|_| reviewer.poll_approvals(&watcher_app, store, stopped))
                    .is_err()
                {
                    reviewer
                        .audit
                        .push(json!({"decision":"review-error", "status":"poll-failed"}));
                    break;
                }
            }
        }
        if !watcher_finished.load(Ordering::Acquire) {
            stop_provider_run(&watcher_app, &session.to_string(), ProviderStopReason::User);
        }
        reviewer.map_or_else(Vec::new, |reviewer| reviewer.audit)
    });
    let result = tauri::async_runtime::block_on(run_provider_chat(app.clone(), request));
    finished.store(true, Ordering::Release);
    let _ = done.send(());
    let audit = watchdog
        .join()
        .unwrap_or_else(|_| vec![json!({"decision":"review-error", "status":"watcher-panicked"})]);
    (result.map(|response| (turn_id, response)), audit)
}

fn fixture_turn_active(app: &tauri::AppHandle, session: Uuid, turn: Uuid) -> bool {
    let manager = app.state::<ProviderCancellationManager>();
    let control = manager
        .flags
        .lock()
        .ok()
        .and_then(|flags| flags.get(&session.to_string()).cloned());
    control
        .as_ref()
        .is_some_and(|control| fixture_control_active(control, turn))
}

fn fixture_control_active(control: &ProviderRunControl, turn: Uuid) -> bool {
    !control.cancellation.is_cancelled()
        && control.request.lock().ok().is_some_and(|request| {
            request.as_ref().is_some_and(|request| {
                request.turn_id.as_deref() == Some(turn.to_string().as_str())
            })
        })
}

fn selected_effort(provider: &Provider) -> Option<&str> {
    let effort = provider.effort.trim();
    (!effort.is_empty()).then_some(effort)
}

pub(super) fn failure_class(error: &str) -> &'static str {
    let e = error.to_lowercase();
    if [
        "not logged in",
        "not authenticated",
        "authentication failed",
        "authentication_failed",
        "unauthorized",
        "login required",
        "please run /login",
    ]
    .iter()
    .any(|text| e.contains(text))
    {
        "authentication"
    } else if e.contains("model")
        && (e.contains("not found")
            || e.contains("not available")
            || e.contains("not supported")
            || e.contains("does not exist"))
    {
        "model-unavailable"
    } else if e.contains("no such file") || e.contains("could not start") {
        "executable-unavailable"
    } else if is_provider_cancellation(error)
        || e.contains("timed out")
        || e.contains("run cancelled")
    {
        "timeout-or-cancelled"
    } else if is_transient_provider_error(error) {
        "transport"
    } else {
        "provider-failed"
    }
}
fn verify(workspace: &Path, task: &str) -> bool {
    // A provider deleting or corrupting a required file is an incorrect output,
    // not a reason to lose the trial checkpoint or stop the remaining matrix.
    verify_files(workspace, task).unwrap_or(false)
}
fn verify_files(workspace: &Path, task: &str) -> anyhow::Result<bool> {
    let changed = Command::new("git")
        .args(["diff", "--name-only", "HEAD"])
        .current_dir(workspace)
        .output()?;
    let changed = String::from_utf8_lossy(&changed.stdout);
    if task == "no-tool" {
        let output = Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(workspace)
            .output()?;
        return Ok(output.status.success() && output.stdout.is_empty());
    }
    let allowed = if task == "code" {
        vec!["src/clamp.mjs", "clamp.test.mjs"]
    } else {
        vec!["README.md"]
    };
    if changed.lines().any(|p| !allowed.contains(&p)) {
        return Ok(false);
    }
    let untracked = Command::new("git")
        .args(["ls-files", "--others", "--exclude-standard"])
        .current_dir(workspace)
        .output()?;
    if !untracked.stdout.is_empty() {
        return Ok(false);
    }
    let readme = fs::read_to_string(workspace.join("README.md"))?;
    Ok(match task {
        "readme" => readme.lines().count() <= 85 && ["Meridian", "Node", "clamp", "node --test", "docs/guide.md"].iter().all(|s| readme.contains(s)),
        "code" => Command::new("node").args(["--input-type=module", "-e", "import assert from 'node:assert/strict'; import {clamp} from './src/clamp.mjs'; for (const [v,a,b,r] of [[20,0,10,10],[-1,0,10,0],[5,0,10,5],[0,0,10,0],[10,0,10,10]]) assert.equal(clamp(v,a,b),r);"]).current_dir(workspace).output()?.status.success()
            && Command::new("node").arg("--test").current_dir(workspace).output()?.status.success()
            && fs::read_to_string(workspace.join("clamp.test.mjs"))?.matches("test(").count() == 2,
        _ => {
            // The prompt's sentence punctuation may be interpreted as part of
            // the requested line. Require an exact append, accepting either.
            let original = Command::new("git").args(["show", "HEAD:README.md"]).current_dir(workspace).output()?;
            let original = String::from_utf8_lossy(&original.stdout);
            ["Mascot: heron\n", "Mascot: heron.\n"].iter().any(|line| readme == format!("{original}{line}"))
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::{
        retry_recovery::run_provider_chat_with_retry_using,
        types::{ProviderResumeCursor, ProviderRunnerOutput},
    };
    #[test]
    fn fixture_review_stops_with_its_own_turn_and_never_follows_a_new_turn() {
        let control = ProviderRunControl::default();
        let turn = Uuid::new_v4();
        assert!(!fixture_control_active(&control, turn));
        *control.request.lock().unwrap() = Some(serde_json::from_value(json!({"sessionId":Uuid::new_v4(),"turnId":turn,"providerId":"openai","message":"fixture"})).unwrap());
        assert!(fixture_control_active(&control, turn));
        assert!(!fixture_control_active(&control, Uuid::new_v4()));
        control.cancellation.cancel();
        assert!(!fixture_control_active(&control, turn));
    }
    #[test]
    fn benchmark_layout_preserves_legacy_and_rejects_unrelated_stores() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let data = root.join("data");
        fs::create_dir(&data).unwrap();
        assert_eq!(benchmark_root(&root, None).unwrap(), root);
        assert_eq!(benchmark_root(&data, Some(root.clone())).unwrap(), root);
        assert!(benchmark_root(&root, Some(root.clone())).is_err());
        assert!(benchmark_root(&data, Some(PathBuf::from("relative"))).is_err());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn benchmark_fixture_commands_run_outside_the_private_store() {
        use gyro_core::workspace_sandbox::PreparedWorkspaceSandbox;
        use std::ffi::OsStr;
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let home = root.join("home");
        let data = root.join("data");
        let old_workspace = data.join("workspaces/legacy");
        for directory in [&home, &old_workspace] {
            fs::create_dir_all(directory).unwrap();
        }
        let error =
            PreparedWorkspaceSandbox::prepare(&old_workspace, &old_workspace, &home, Some(&data))
                .unwrap_err();
        assert!(error.to_string().contains("individual managed workspace"));
        let workspace = benchmark_root(&data, Some(root))
            .unwrap()
            .join("workspaces/fixed");
        fixture(&workspace).unwrap();
        let sandbox =
            PreparedWorkspaceSandbox::prepare(&workspace, &workspace, &home, Some(&data)).unwrap();
        let (program, args) = sandbox.wrap_command(OsStr::new("node"), &["--test".into()]);
        let output = Command::new(program)
            .args(args)
            .envs(sandbox.environment())
            .current_dir(&workspace)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("pass 1"));
    }

    #[test]
    fn absent_benchmark_effort_uses_the_provider_default() {
        let mut provider = Provider {
            id: "openai".into(),
            model: "fixture".into(),
            effort: "".into(),
        };
        assert_eq!(selected_effort(&provider), None);
        provider.effort = "high".into();
        assert_eq!(selected_effort(&provider), Some("high"));
    }
    #[test]
    fn a_no_tool_trial_rejects_any_workspace_mutation() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path()).unwrap();
        assert!(verify(root.path(), "no-tool"));
        fs::write(root.path().join("unexpected.txt"), "mutation").unwrap();
        assert!(!verify(root.path(), "no-tool"));
    }
    #[test]
    fn missing_output_is_incorrect_and_does_not_abort_the_matrix() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path()).unwrap();
        assert!(!verify(root.path(), "readme"));
        fs::write(
            root.path().join("README.md"),
            "# Meridian\nNode 22 required.\nUse clamp.\nRun node --test.\n[Guide](docs/guide.md)\n",
        )
        .unwrap();
        assert!(verify(root.path(), "readme"));
        fs::remove_file(root.path().join("README.md")).unwrap();
        assert!(!verify(root.path(), "readme"));
    }
    #[test]
    fn follow_up_accepts_prompt_punctuation_but_requires_only_an_append() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path()).unwrap();
        let path = root.path().join("README.md");
        let original = fs::read_to_string(&path).unwrap();
        for line in ["Mascot: heron\n", "Mascot: heron.\n"] {
            fs::write(&path, format!("{original}{line}")).unwrap();
            assert!(verify(root.path(), "follow-up"));
        }
        fs::write(&path, format!("{original}Mascot: heron\nMascot: heron\n")).unwrap();
        assert!(!verify(root.path(), "follow-up"));
        fs::write(
            &path,
            format!("{}Mascot: heron\n", original.replace("Meridian", "Changed")),
        )
        .unwrap();
        assert!(!verify(root.path(), "follow-up"));
    }
    #[test]
    fn unavailable_and_deadline_failures_are_not_successes() {
        assert_eq!(
            failure_class("Claude rejected: 401 authentication_failed"),
            "authentication"
        );
        assert_eq!(
            failure_class("xAI ACP run cancelled"),
            "timeout-or-cancelled"
        );
        assert_eq!(failure_class("model does not exist"), "model-unavailable");
        assert_eq!(failure_class("connection reset by peer"), "transport");
    }
    /// Characterization probe, not a claim that replay after mutation is safe.
    /// Emits machine-readable evidence for the performance/reliability report.
    #[test]
    fn retry_fault_evidence() {
        let root = tempfile::tempdir().unwrap();
        let store =
            SessionStore::open(GyroPaths::from_base_dir(root.path().join("store"))).unwrap();
        let session = store
            .create_session(root.path(), SessionOrigin::Desktop, "fault probe")
            .unwrap();
        let request: ProviderChatRequest = serde_json::from_value(json!({"sessionId":session.id,"turnId":Uuid::new_v4(),"providerId":"openai","message":"synthetic probe"})).unwrap();
        let mut results = Vec::new();
        for (after_edit, failures) in [(false, 1), (true, 1), (true, 2)] {
            let mut attempts = 0;
            let effect_path = root.path().join(format!("effects-{after_edit}.txt"));
            fs::write(&effect_path, "").unwrap();
            let mut received_cursors = Vec::new();
            let output = run_provider_chat_with_retry_using(
                &store,
                &request,
                None,
                |cursor, attempt| {
                    received_cursors.push(cursor.map(|value| value.session_id.clone()));
                    attempts += 1;
                    if after_edit || attempts > 1 {
                        let mut file = fs::OpenOptions::new().append(true).open(&effect_path)?;
                        use std::io::Write;
                        writeln!(file, "edit")?;
                        // The edit reached the chat as an activity.
                        attempt.published_output = true;
                    }
                    attempt.resume_cursor = Some(ProviderResumeCursor {
                        kind: "codex-session".into(),
                        session_id: "observed-first-attempt".into(),
                    });
                    if attempts <= failures {
                        anyhow::bail!("connection reset by peer");
                    }
                    Ok(ProviderRunnerOutput {
                        accounted_usage: None,
                        activities: Vec::new(),
                        context_usage: None,
                        billed_usage: None,
                        rate_limits: Vec::new(),
                        paused_at_tool_budget: false,
                        answer_cut_off: false,
                        response: "done".into(),
                        resume_cursor: None,
                        retry_count: 0,
                        resumed: false,
                        streamed_text: None,
                        output_summary: None,
                    })
                },
                || None,
            );
            let effects = fs::read_to_string(&effect_path).unwrap().lines().count();
            // A disconnect before any output retries once; after an edit the
            // failure is reported instead, so the edit is never repeated.
            let retries = output.as_ref().map_or(0, |output| output.retry_count);
            assert_eq!(output.is_ok(), !after_edit);
            assert_eq!(attempts, if after_edit { 1 } else { failures + 1 });
            assert_eq!(effects, 1);
            let mut expected_cursors = vec![None];
            if !after_edit {
                expected_cursors
                    .extend((0..failures).map(|_| Some("observed-first-attempt".to_string())));
            }
            assert_eq!(received_cursors, expected_cursors);
            results.push(json!({"scenario":if !after_edit {"disconnect-before-edit"} else if failures == 1 {"disconnect-after-edit"} else {"repeated-disconnect-after-edit"},"attempts":attempts,"mutationCount":effects,"duplicateMutation":effects>1,"retries":retries,"observedCursorReused":true}));
        }
        assert_eq!(results.len(), 3);
        println!(
            "GYRO_RETRY_FAULT_EVIDENCE={}",
            serde_json::to_string(&results).unwrap()
        );
    }
}

/// Call the real manual command between fixture turns, with the same bounded
/// cancellation route as chat acceptance. It operates only in the debug harness.
fn compact_fixture(
    app: &tauri::AppHandle,
    session: Uuid,
    turn: Uuid,
    timeout: u64,
) -> Result<usize, String> {
    let watcher = app.clone();
    let (done, completion) = mpsc::channel();
    let watchdog = std::thread::spawn(move || {
        if matches!(
            completion.recv_timeout(Duration::from_secs(timeout)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ) {
            stop_provider_run(&watcher, &session.to_string(), ProviderStopReason::User);
        }
    });
    let result = tauri::async_runtime::block_on(compact_provider_chat(
        app.clone(),
        session.to_string(),
        Some(turn.to_string()),
    ));
    let _ = done.send(());
    let _ = watchdog.join();
    result.map(|response| response.activity_events.len())
}
