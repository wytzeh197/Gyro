//! Debug-only, explicit benchmark entry. Calls the desktop's real chat command
//! with disposable workspaces and a separate store. Never included in releases.
use super::*;
use serde_json::json;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Spec {
    providers: Vec<Provider>,
    trials: usize,
    timeout_seconds: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Provider {
    id: String,
    model: String,
    effort: String,
}

pub fn start(app: &tauri::AppHandle) -> Result<bool, Box<dyn std::error::Error>> {
    let Ok(spec_path) = std::env::var("GYRO_PERFORMANCE_BENCHMARK") else {
        return Ok(false);
    };
    let requested_root = PathBuf::from(std::env::var("GYRO_TEST_DATA_DIR")?);
    let root = requested_root.canonicalize()?;
    let temporary_root = std::env::temp_dir().canonicalize()?;
    if !requested_root.is_absolute()
        || root == temporary_root
        || root == Path::new("/private/tmp")
        || !(root.starts_with(&temporary_root) || root.starts_with("/private/tmp"))
    {
        return Err("benchmark data must be in an absolute temporary directory".into());
    }
    let spec: Spec = serde_json::from_slice(&fs::read(spec_path)?)?;
    if !(1..=5).contains(&spec.trials)
        || !(10..=300).contains(&spec.timeout_seconds)
        || spec.providers.is_empty()
        || spec.providers.len() > 3
    {
        return Err("invalid benchmark bounds".into());
    }
    for provider in &spec.providers {
        if !matches!(provider.id.as_str(), "xai" | "openai" | "anthropic") {
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
    config.require_file_edit_approval = false;
    for provider in &mut config.model_providers {
        provider.enabled = spec.providers.iter().any(|p| p.id == provider.id);
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
                    scope.spawn(move || {
                        run(
                            app,
                            root,
                            Spec {
                                providers: vec![provider],
                                trials: spec.trials,
                                timeout_seconds: spec.timeout_seconds,
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
    let tasks = ["readme", "code", "follow-up"];
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
    for provider in spec.providers {
        let mut unavailable: Option<String> = None;
        for task in tasks {
            for resumed in [false, true] {
                for trial in 1..=spec.trials {
                    if records.iter().any(|record| {
                        record["provider"] == provider.id
                            && record["model"] == provider.model
                            && record["effort"] == provider.effort
                            && record["task"] == task
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
                    let mut record = json!({"provider":provider.id,"model":provider.model,"effort":provider.effort,"task":task,"resumedRequested":resumed,"trial":trial});
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
                        policy
                            .classes
                            .insert(CapabilityClass::BrowserNavigate, CapabilityAccess::Deny);
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
                            Some(provider.effort.clone()),
                        )?;
                        let bootstrap = if resumed {
                            Some(turn(app, &store, session.id, &workspace, &provider, "Read README.md and src/clamp.mjs. Remember that the project mascot is heron for my next request. Do not modify files. Reply in one sentence.", spec.timeout_seconds))
                        } else {
                            None
                        };
                        if let Some(Err(error)) = bootstrap.as_ref() {
                            let class = failure_class(error);
                            record["outcome"] = "setup-failed".into();
                            record["failureClass"] = class.into();
                            record["failureDetail"] = gyro_core::security::redact_secrets(&error)
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
                            let prompt = match task {
                                "readme" => "Shorten README.md from 267 lines to at most 85 lines. Preserve the project name, install requirements, usage, development command, and docs/guide.md link. Edit only README.md.",
                                "code" => "Fix clamp in src/clamp.mjs so it enforces both inclusive bounds. Add exactly one upper-bound regression test in clamp.test.mjs. Run node --test. Edit only these two files.",
                                _ if resumed => "Append exactly one line to README.md with the mascot I asked you to remember, in the form Mascot: name. Edit only README.md.",
                                _ => "Context: the project mascot is heron. Append exactly one line to README.md: Mascot: heron. Edit only README.md.",
                            };
                            let at = Instant::now();
                            let result = turn(
                                app,
                                &store,
                                session.id,
                                &workspace,
                                &provider,
                                prompt,
                                spec.timeout_seconds,
                            );
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
                                    record["correct"] = verify(&workspace, task).into();
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
                                    record["correct"] = verify(&workspace, task).into();
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
fn turn(
    app: &tauri::AppHandle,
    store: &SessionStore,
    session: Uuid,
    workspace: &Path,
    provider: &Provider,
    prompt: &str,
    timeout_seconds: u64,
) -> Result<(Uuid, ProviderChatResponse), String> {
    let turn_id = Uuid::new_v4();
    store
        .append_user_turn_message_with_turn_id(session, prompt, json!({}), turn_id)
        .map_err(to_string)?;
    let request: ProviderChatRequest = serde_json::from_value(json!({
        "sessionId":session,"turnId":turn_id,"workspacePath":workspace,"providerId":provider.id,
        "modelId":provider.model,"reasoningEffort":provider.effort,"message":prompt,
        "requireCommandApproval":false,"requireFileEditApproval":false,"fullAccess":false,"mode":"normal"
    })).map_err(to_string)?;
    let watcher_app = app.clone();
    let (done, completion) = mpsc::channel();
    let watchdog = std::thread::spawn(move || {
        if completion
            .recv_timeout(Duration::from_secs(timeout_seconds))
            .is_err()
        {
            stop_provider_run(&watcher_app, &session.to_string(), ProviderStopReason::User);
        }
    });
    let result = tauri::async_runtime::block_on(run_provider_chat(app.clone(), request));
    let _ = done.send(());
    let _ = watchdog.join();
    result.map(|response| (turn_id, response))
}
fn failure_class(error: &str) -> &'static str {
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
            let output =
                run_provider_chat_with_retry_using(&store, &request, None, |cursor, attempt| {
                    received_cursors.push(cursor.map(|value| value.session_id.clone()));
                    attempts += 1;
                    if after_edit || attempts > 1 {
                        let mut file = fs::OpenOptions::new().append(true).open(&effect_path)?;
                        use std::io::Write;
                        writeln!(file, "edit")?;
                    }
                    attempt.resume_cursor = Some(ProviderResumeCursor {
                        kind: "codex-session".into(),
                        session_id: "observed-first-attempt".into(),
                    });
                    if attempts <= failures {
                        anyhow::bail!("connection reset by peer");
                    }
                    Ok(ProviderRunnerOutput {
                        activities: Vec::new(),
                        context_usage: None,
                        billed_usage: None,
                        rate_limits: Vec::new(),
                        response: "done".into(),
                        resume_cursor: None,
                        retry_count: 0,
                        resumed: false,
                        output_summary: None,
                    })
                })
                .unwrap();
            let effects = fs::read_to_string(&effect_path).unwrap().lines().count();
            assert_eq!(attempts, failures + 1);
            assert_eq!(output.retry_count, failures as u32);
            assert_eq!(effects, if after_edit { failures + 1 } else { 1 });
            assert_eq!(received_cursors, vec![None; failures + 1]);
            results.push(json!({"scenario":if !after_edit {"disconnect-before-edit"} else if failures == 1 {"disconnect-after-edit"} else {"repeated-disconnect-after-edit"},"attempts":attempts,"mutationCount":effects,"duplicateMutation":effects>1,"retries":output.retry_count,"observedCursorReused":false}));
        }
        // Verify the evidence collection, not the correctness of unsafe behavior.
        assert_eq!(results.len(), 3);
        println!(
            "GYRO_RETRY_FAULT_EVIDENCE={}",
            serde_json::to_string(&results).unwrap()
        );
    }
}
