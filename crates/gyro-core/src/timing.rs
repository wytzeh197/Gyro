//! Opt-in local latency traces. The wire format deliberately has no free-text
//! fields: prompts, paths, tool arguments, model output and errors cannot enter it.
//! A scope follows a synchronous provider worker; background heartbeats do not
//! inherit it. Disabled tracing neither allocates a collector nor touches disk.
use crate::GyroPaths;
use serde::{Deserialize, Serialize};
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    fs::OpenOptions,
    io::Write,
    time::Instant,
};
use uuid::Uuid;

const MAX_POINTS: usize = 4096;
thread_local! { static ACTIVE: RefCell<Option<Trace>> = const { RefCell::new(None) }; }

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum Stage {
    BackendReceived,
    WorkspaceStart,
    WorkspaceReady,
    AttemptStart,
    ProcessStart,
    ProcessSpawned,
    ProtocolReady,
    PromptSent,
    FirstActivity,
    ToolStart,
    ToolEnd,
    ApprovalStart,
    ApprovalEnd,
    ProviderComplete,
    Complete,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Point {
    stage: Stage,
    elapsed_ms: f64,
    attempt: u32,
    tool_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<Outcome>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Trace {
    schema: &'static str,
    trace_id: Uuid,
    turn_id: Uuid,
    session_id: Uuid,
    points: Vec<Point>,
    outcome: Outcome,
    truncated: bool,
    #[serde(skip)]
    started: Option<Instant>,
    #[serde(skip)]
    attempt: u32,
    #[serde(skip)]
    tools: HashMap<String, (u32, bool)>,
    #[serde(skip)]
    milestones: HashSet<Stage>,
    #[serde(skip)]
    prompt_on_spawn: bool,
}
impl Trace {
    fn push(&mut self, stage: Stage, tool_index: Option<u32>) {
        if self.attempt == 0 && matches!(stage, Stage::ProcessStart | Stage::ProcessSpawned) {
            return;
        }
        if self.points.len() >= MAX_POINTS {
            self.truncated = true;
            return;
        }
        // Constant-time deduplication on the hot streaming path. Approval waits
        // may repeat; every start/end pair must remain visible.
        if tool_index.is_none()
            && !matches!(stage, Stage::ApprovalStart | Stage::ApprovalEnd)
            && !self.milestones.insert(stage)
        {
            return;
        }
        self.points.push(Point {
            stage,
            elapsed_ms: self
                .started
                .map_or(0., |s| s.elapsed().as_secs_f64() * 1000.),
            attempt: self.attempt,
            tool_index,
            outcome: None,
        });
    }
}
pub fn enabled() -> bool {
    std::env::var("GYRO_TIMING_DIAGNOSTICS").as_deref() == Ok("1")
}

pub struct Scope {
    previous: Option<Trace>,
    active: bool,
}
impl Scope {
    pub fn start(session_id: Uuid, turn_id: Uuid) -> Self {
        Self::with_enabled(session_id, turn_id, enabled())
    }
    fn with_enabled(session_id: Uuid, turn_id: Uuid, enabled: bool) -> Self {
        let previous = if enabled {
            ACTIVE.with(|slot| {
                slot.replace(Some(Trace {
                    schema: "gyro.timing.v1",
                    trace_id: Uuid::new_v4(),
                    session_id,
                    turn_id,
                    points: Vec::new(),
                    outcome: Outcome::Interrupted,
                    truncated: false,
                    started: Some(Instant::now()),
                    attempt: 0,
                    tools: HashMap::new(),
                    milestones: HashSet::new(),
                    prompt_on_spawn: false,
                }))
            })
        } else {
            None
        };
        if enabled {
            mark(Stage::BackendReceived);
        }
        Self {
            previous,
            active: enabled,
        }
    }
    pub fn finish(&self, outcome: Outcome) {
        if self.active {
            ACTIVE.with(|s| {
                if let Some(t) = s.borrow_mut().as_mut() {
                    t.outcome = outcome;
                    t.push(Stage::Complete, None);
                }
            });
        }
    }
}
impl Drop for Scope {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let trace = ACTIVE.with(|s| s.replace(self.previous.take()));
        if let Some(trace) = trace {
            // Diagnostics must never fail a provider run. Failure is visible on
            // stderr; recording success is never claimed when persistence fails.
            if let Err(error) = write_record(&format!("backend-{}", trace.trace_id), &trace) {
                eprintln!("Gyro timing trace could not be saved: {}", error.kind());
            }
        }
    }
}
pub fn mark(stage: Stage) {
    ACTIVE.with(|s| {
        if let Some(t) = s.borrow_mut().as_mut() {
            t.push(stage, None);
            if stage == Stage::ProcessSpawned && t.prompt_on_spawn {
                t.prompt_on_spawn = false;
                t.push(Stage::PromptSent, None);
            }
        }
    });
}
pub fn attempt() {
    ACTIVE.with(|s| {
        if let Some(t) = s.borrow_mut().as_mut() {
            t.attempt += 1;
            t.tools.clear();
            t.milestones.clear();
            t.prompt_on_spawn = false;
            t.push(Stage::AttemptStart, None);
        }
    });
}
/// A CLI receives its prompt in argv at spawn, rather than a later protocol send.
pub fn cli_prompt_on_spawn() {
    ACTIVE.with(|s| {
        if let Some(t) = s.borrow_mut().as_mut() {
            t.prompt_on_spawn = true;
        }
    });
}
pub fn tool(id: &str, status: &str) {
    ACTIVE.with(|s| {
        if let Some(t) = s.borrow_mut().as_mut() {
            if id.len() > 256 {
                t.truncated = true;
                return;
            }
            if status == "running"
                || status == "queued"
                || status == "in_progress"
                || status == "pending"
            {
                if !t.tools.contains_key(id) {
                    if t.tools.len() >= MAX_POINTS / 2 {
                        t.truncated = true;
                        return;
                    }
                    let index = t.tools.len() as u32;
                    t.tools.insert(id.to_owned(), (index, false));
                    t.push(Stage::ToolStart, Some(index));
                }
            } else if matches!(
                status,
                "done" | "completed" | "failed" | "cancelled" | "error"
            ) {
                if let Some((index, ended)) = t.tools.get_mut(id) {
                    if !*ended {
                        *ended = true;
                        let index = *index;
                        let position = t.points.len();
                        t.push(Stage::ToolEnd, Some(index));
                        if let Some(point) = t.points.get_mut(position) {
                            point.outcome = Some(match status {
                                "failed" | "error" => Outcome::Failed,
                                "cancelled" => Outcome::Cancelled,
                                _ => Outcome::Completed,
                            });
                        }
                    }
                }
            }
        }
    });
}

/// App-server MCP tools do not necessarily produce a chat activity row.
/// Record their protocol boundaries directly, without serializing the item.
pub fn protocol_item(id: &str, kind: &str, status: &str) {
    if matches!(
        kind,
        "commandExecution" | "fileChange" | "mcpToolCall" | "dynamicToolCall" | "webSearch"
    ) {
        mark(Stage::FirstActivity);
        tool(id, status);
    }
}

pub struct ApprovalScope;
impl ApprovalScope {
    pub fn start() -> Self {
        mark(Stage::ApprovalStart);
        Self
    }
}
impl Drop for ApprovalScope {
    fn drop(&mut self) {
        mark(Stage::ApprovalEnd);
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrontendTiming {
    pub turn_id: Uuid,
    pub send_to_invoke_ms: Option<f64>,
    pub send_to_received_ms: Option<f64>,
    pub received_to_paint_ms: Option<f64>,
    pub send_to_settled_ms: Option<f64>,
}
impl FrontendTiming {
    pub fn valid(&self) -> bool {
        [
            self.send_to_invoke_ms,
            self.send_to_received_ms,
            self.received_to_paint_ms,
            self.send_to_settled_ms,
        ]
        .into_iter()
        .flatten()
        .all(|n| n.is_finite() && (0.0..=86_400_000.).contains(&n))
    }
}
pub fn record_frontend(value: &FrontendTiming) -> std::io::Result<()> {
    if !enabled() || !value.valid() {
        return Ok(());
    }
    write_record(&format!("frontend-{}", Uuid::new_v4()), value)
}
fn write_record(name: &str, value: &impl Serialize) -> std::io::Result<()> {
    let paths = GyroPaths::for_current_user().map_err(std::io::Error::other)?;
    paths.ensure().map_err(std::io::Error::other)?;
    let root = paths.logs_dir.join("timings");
    std::fs::create_dir_all(&root)?;
    if std::fs::symlink_metadata(&root)?.file_type().is_symlink() {
        return Err(std::io::Error::other("unsafe trace directory"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))?;
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(root.join(format!("{name}.json")))?;
    serde_json::to_writer(&mut file, value)?;
    file.write_all(b"\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disabled_scope_has_no_collector() {
        let _scope = Scope::with_enabled(Uuid::new_v4(), Uuid::new_v4(), false);
        mark(Stage::FirstActivity);
        tool("secret file path", "running");
        ACTIVE.with(|s| assert!(s.borrow().is_none()));
    }
    #[test]
    fn trace_deduplicates_is_bounded_and_never_serializes_tool_text() {
        let mut scope = Scope::with_enabled(Uuid::new_v4(), Uuid::new_v4(), true);
        attempt();
        mark(Stage::FirstActivity);
        mark(Stage::FirstActivity);
        tool("sensitive command", "running");
        tool("sensitive command", "running");
        tool("sensitive command", "done");
        tool("sensitive command", "done");
        ACTIVE.with(|s| {
            let slot = s.borrow();
            let t = slot.as_ref().unwrap();
            assert_eq!(
                t.points
                    .iter()
                    .filter(|p| p.stage == Stage::FirstActivity)
                    .count(),
                1
            );
            assert_eq!(
                t.points.iter().filter(|p| p.tool_index.is_some()).count(),
                2
            );
            assert!(!serde_json::to_string(t).unwrap().contains("sensitive"));
        });
        protocol_item("sensitive MCP arguments", "mcpToolCall", "running");
        protocol_item("sensitive MCP arguments", "mcpToolCall", "failed");
        protocol_item("sensitive reasoning", "reasoning", "running");
        for _ in 0..2 {
            let _approval = ApprovalScope::start();
        }
        cli_prompt_on_spawn();
        mark(Stage::ProcessStart);
        mark(Stage::ProcessSpawned);
        ACTIVE.with(|s| {
            let slot = s.borrow();
            let t = slot.as_ref().unwrap();
            assert_eq!(
                t.points
                    .iter()
                    .filter(|p| p.stage == Stage::ToolStart)
                    .count(),
                2
            );
            assert_eq!(
                t.points
                    .iter()
                    .filter(|p| p.stage == Stage::ApprovalEnd)
                    .count(),
                2
            );
            assert!(t
                .points
                .windows(2)
                .all(|p| p[0].elapsed_ms <= p[1].elapsed_ms));
            assert!(!serde_json::to_string(t).unwrap().contains("sensitive"));
            assert!(t
                .points
                .iter()
                .any(|p| matches!(p.outcome, Some(Outcome::Failed))));
            let spawn = t
                .points
                .iter()
                .position(|p| p.stage == Stage::ProcessSpawned)
                .unwrap();
            let prompt = t
                .points
                .iter()
                .position(|p| p.stage == Stage::PromptSent)
                .unwrap();
            assert!(prompt > spawn);
        });
        for _ in 0..5000 {
            attempt();
        }
        ACTIVE.with(|s| {
            let mut slot = s.borrow_mut();
            let t = slot.take().unwrap();
            assert!(t.truncated);
            assert_eq!(t.points.len(), MAX_POINTS);
        });
        scope.active = false; // test collectors never write to the user's data directory
    }
    #[test]
    fn frontend_rejects_unbounded_values_and_unknown_fields() {
        let mut t = FrontendTiming {
            turn_id: Uuid::new_v4(),
            send_to_invoke_ms: None,
            send_to_received_ms: None,
            received_to_paint_ms: Some(-1.),
            send_to_settled_ms: None,
        };
        assert!(!t.valid());
        t.received_to_paint_ms = Some(f64::NAN);
        assert!(!t.valid());
        assert!(serde_json::from_value::<FrontendTiming>(
            serde_json::json!({"turnId": Uuid::new_v4(), "prompt":"private"})
        )
        .is_err());
    }
}
