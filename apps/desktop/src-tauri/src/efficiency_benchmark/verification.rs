//! Benchmark-only evidence for a requested foreground test on the final fixture files.
use crate::{app::limits::MAX_WORKSPACE_FILE_EDIT_BYTES, workspace::files::read_workspace_bytes};
use gyro_core::{
    execution::{foreground_test_identity, is_foreground_test_command},
    security::assert_path_inside_workspace,
    SessionStore,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashMap},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RequiredCommand {
    program: String,
    args: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
}

pub(super) fn contract(commands: &[RequiredCommand]) -> Option<String> {
    if commands.is_empty() {
        return None;
    }
    let requirements: Vec<_> = commands
        .iter()
        .map(|command| json!([command.program, command.args, command.cwd()]))
        .collect();
    let versioned = json!(["foreground-test/final-fixture-v1", requirements]);
    Some(format!(
        "sha256:{:x}",
        Sha256::digest(versioned.to_string().as_bytes())
    ))
}

impl RequiredCommand {
    fn cwd(&self) -> &str {
        self.cwd.as_deref().unwrap_or(".")
    }

    pub(super) fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            !self.program.contains('\0')
                && self.args.iter().all(|arg| !arg.contains('\0'))
                && is_foreground_test_command(&self.program, self.args.iter().map(String::as_str)),
            "Required verification must be a recognized foreground test command"
        );
        if self.cwd() != "." {
            gyro_core::normalize_capability_relative_path(self.cwd())?;
        }
        Ok(())
    }
}

struct Fixture {
    session: Uuid,
    session_key: String,
    workspace: PathBuf,
    paths: BTreeSet<String>,
    commands: Vec<String>,
    snapshots: Mutex<HashMap<Uuid, [u8; 32]>>,
}

static BENCHMARK_TEST_ACTIVE: AtomicBool = AtomicBool::new(false);
static ACTIVE_FIXTURE: Mutex<Option<Arc<Fixture>>> = Mutex::new(None);

pub(super) struct Trial(Arc<Fixture>);

impl Trial {
    pub(super) fn start(
        session: Uuid,
        workspace: &Path,
        task: &super::Task,
    ) -> anyhow::Result<Option<Self>> {
        if task.required_verification_commands.is_empty() {
            return Ok(None);
        }
        let workspace = workspace.canonicalize()?;
        let mut commands = Vec::new();
        for required in &task.required_verification_commands {
            let cwd = assert_path_inside_workspace(&workspace, Path::new(required.cwd()))?;
            anyhow::ensure!(
                cwd.is_dir(),
                "Required verification cwd must be a fixture directory"
            );
            let id = foreground_test_identity(&required.program, &required.args, &cwd);
            anyhow::ensure!(
                !commands.contains(&id),
                "Duplicate required verification command"
            );
            commands.push(id);
        }
        let fixture = Arc::new(Fixture {
            session,
            session_key: session.to_string(),
            workspace,
            paths: task
                .files
                .keys()
                .chain(&task.allowed_changes)
                .cloned()
                .collect(),
            commands,
            snapshots: Mutex::new(HashMap::new()),
        });
        let mut active = ACTIVE_FIXTURE
            .lock()
            .map_err(|_| anyhow::anyhow!("benchmark verification state unavailable"))?;
        anyhow::ensure!(active.is_none(), "Verification trials must run serially");
        *active = Some(fixture.clone());
        BENCHMARK_TEST_ACTIVE.store(true, Ordering::Release);
        Ok(Some(Self(fixture)))
    }

    pub(super) fn evaluate(&self, store: &SessionStore, turns: &[Uuid]) -> anyhow::Result<Value> {
        let fixture = &self.0;
        let final_snapshot = fixture.snapshot().ok();
        let events = store.read_workspace_test_outcomes_for_turns(fixture.session, turns)?;
        let snapshots = fixture
            .snapshots
            .lock()
            .map_err(|_| anyhow::anyhow!("benchmark snapshots unavailable"))?;
        let workspace = fixture.workspace.to_string_lossy();
        let commands: Vec<Value> = fixture.commands.iter().map(|id| {
            let matching = events.iter().rev().find_map(|event| {
                let record = &event.payload["workspaceTaskOutcome"];
                let receipt = &record["receipt"];
                (record["workspaceKey"] == workspace.as_ref()
                    && receipt["outcome"]["taskId"] == id.as_str()
                    && receipt["outcome"]["capabilityId"] == "workspace-run-command")
                    .then_some((event, receipt))
            });
            let Some((event, receipt)) = matching else {
                return json!({"commandId":id,"status":"not-observed"});
            };
            let call_id = receipt["eventId"].as_str().and_then(|id| Uuid::parse_str(id).ok());
            let outcome = &receipt["outcome"];
            let status = if outcome["status"] != "done" || outcome["exitCode"].as_i64() != Some(0) {
                "test-did-not-pass"
            } else if final_snapshot.as_ref().is_some_and(|final_state| call_id.and_then(|call| snapshots.get(&call)) == Some(final_state)) {
                "verified"
            } else {
                "final-workspace-not-verified"
            };
            json!({"commandId":id,"status":status,"exitCode":outcome["exitCode"],"callId":call_id,"receiptEventId":event.id})
        }).collect();
        Ok(
            json!({"verified":commands.iter().all(|command| command["status"] == "verified"),"commands":commands}),
        )
    }
}

impl Drop for Trial {
    fn drop(&mut self) {
        BENCHMARK_TEST_ACTIVE.store(false, Ordering::Release);
        if let Ok(mut active) = ACTIVE_FIXTURE.lock() {
            *active = None;
        }
    }
}

impl Fixture {
    fn snapshot(&self) -> anyhow::Result<[u8; 32]> {
        let mut hash = Sha256::new();
        for path in &self.paths {
            let target = self.workspace.join(path);
            hash.update((path.len() as u64).to_le_bytes());
            hash.update(path.as_bytes());
            match fs::symlink_metadata(&target) {
                Ok(metadata) => {
                    anyhow::ensure!(
                        metadata.is_file(),
                        "Verification snapshot requires a regular fixture file"
                    );
                    let (bytes, _) = read_workspace_bytes(
                        &self.workspace,
                        &target,
                        MAX_WORKSPACE_FILE_EDIT_BYTES,
                        "benchmark fixture",
                    )?;
                    anyhow::ensure!(
                        bytes.len() <= MAX_WORKSPACE_FILE_EDIT_BYTES,
                        "Verification fixture is too large"
                    );
                    hash.update([1]);
                    hash.update(Sha256::digest(&bytes));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => hash.update([0]),
                Err(error) => return Err(error.into()),
            }
        }
        Ok(hash.finalize().into())
    }
}

pub(crate) struct VerificationStart {
    fixture: Arc<Fixture>,
    snapshot: [u8; 32],
}

impl VerificationStart {
    pub(crate) fn finish(self, call_id: Uuid) {
        if self.fixture.snapshot().ok() == Some(self.snapshot) {
            if let Ok(mut snapshots) = self.fixture.snapshots.lock() {
                snapshots.insert(call_id, self.snapshot);
            }
        }
    }
}

pub(crate) fn capture_verification_start(
    session: &str,
    workspace: &Path,
    command: &str,
) -> Option<VerificationStart> {
    if !BENCHMARK_TEST_ACTIVE.load(Ordering::Acquire) {
        return None;
    }
    let fixture = ACTIVE_FIXTURE.lock().ok()?.as_ref()?.clone();
    if fixture.session_key != session
        || fixture.workspace != workspace
        || !fixture.commands.iter().any(|id| id == command)
    {
        return None;
    }
    let snapshot = fixture.snapshot().ok()?;
    Some(VerificationStart { fixture, snapshot })
}

#[test]
fn verification_requires_the_latest_passing_receipt_for_the_final_fixture() {
    use gyro_core::{GyroPaths, SessionEventKind, SessionOrigin};

    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let workspace = root.join("fixture");
    fs::create_dir(&workspace).unwrap();
    let source = workspace.join("app.mjs");
    fs::write(&source, "initial").unwrap();
    let store = SessionStore::open(GyroPaths::from_base_dir(root.join("store"))).unwrap();
    let session = store
        .create_session(&workspace, SessionOrigin::Desktop, "verification fixture")
        .unwrap();
    let task: super::Task = serde_json::from_value(json!({
        "id":"receipt", "category":"small-edit", "repositorySnapshot":"fixture",
        "files":{"app.mjs":"initial"}, "allowedChanges":["app.mjs"], "turns":["Run the test"], "verifier":"fixture",
        "requiredVerificationCommands":[{"program":"node","args":["--test"]}]
    })).unwrap();
    let trial = Trial::start(session.id, &workspace, &task)
        .unwrap()
        .unwrap();
    let command = &trial.0.commands[0];
    let turn = Uuid::new_v4();
    let capture =
        || capture_verification_start(&session.id.to_string(), &workspace, command).unwrap();
    let receipt = |call, turn, code| {
        store.append_event_with_turn_id(session.id, SessionEventKind::SystemEvent, "Observed test", json!({
            "kind":"capability-call", "status":"completed", "callId":call,
            "workspaceTaskOutcome":{"workspaceKey":workspace,"receipt":{"eventId":call,
                 "outcome":{"capabilityId":"workspace-run-command","taskId":command,"status":if code==0 {"done"} else {"failed"},"exitCode":code}}}
        }), Some(turn)).unwrap();
    };
    let evaluate = || trial.evaluate(&store, &[turn]).unwrap();
    assert_eq!(evaluate()["commands"][0]["status"], "not-observed");
    let initial = Uuid::new_v4();
    capture().finish(initial);
    receipt(initial, Uuid::new_v4(), 0);
    assert_eq!(evaluate()["commands"][0]["status"], "not-observed");
    receipt(initial, turn, 0);
    assert_eq!(evaluate()["verified"], true);
    fs::write(&source, "patched").unwrap();
    assert_eq!(
        evaluate()["commands"][0]["status"],
        "final-workspace-not-verified"
    );
    let ran_while_changing = Uuid::new_v4();
    let before = capture();
    fs::write(&source, "final").unwrap();
    before.finish(ran_while_changing);
    receipt(ran_while_changing, turn, 0);
    assert_eq!(evaluate()["verified"], false);
    let final_run = Uuid::new_v4();
    capture().finish(final_run);
    receipt(final_run, turn, 0);
    assert_eq!(evaluate()["verified"], true);
    receipt(Uuid::new_v4(), turn, 1);
    assert_eq!(evaluate()["commands"][0]["status"], "test-did-not-pass");
}
