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
    sync::{Arc, Mutex},
    time::Instant,
};
use uuid::Uuid;

const MAX_POINTS: usize = 4096;
thread_local! { static ACTIVE: RefCell<Option<Arc<Mutex<Trace>>>> = const { RefCell::new(None) }; }

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
    FirstToken,
    RequestStart,
    RequestEnd,
    ToolStart,
    ToolEnd,
    BrokerToolStart,
    BrokerToolEnd,
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
    request_index: Option<u32>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_requests: Option<crate::provider_observation::Summary>,
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
            request_index: None,
            outcome: None,
        });
    }
}
pub fn enabled() -> bool {
    std::env::var("GYRO_TIMING_DIAGNOSTICS").as_deref() == Ok("1")
}

/// Attach the same bounded trace to broker/parallel-read workers. Attaching
/// never writes a second trace and carries no provider content.
#[derive(Clone, Default)]
pub struct Handle(Option<Arc<Mutex<Trace>>>);
pub fn capture() -> Handle {
    Handle(ACTIVE.with(|slot| slot.borrow().clone()))
}
pub struct Attachment(Option<Arc<Mutex<Trace>>>);
pub fn attach(handle: Handle) -> Attachment {
    Attachment(ACTIVE.with(|slot| slot.replace(handle.0)))
}
impl Drop for Attachment {
    fn drop(&mut self) {
        ACTIVE.with(|slot| slot.replace(self.0.take()));
    }
}
pub struct Scope {
    previous: Option<Arc<Mutex<Trace>>>,
    active: bool,
}
impl Scope {
    pub fn start(session_id: Uuid, turn_id: Uuid) -> Self {
        Self::with_enabled(session_id, turn_id, enabled())
    }
    fn with_enabled(session_id: Uuid, turn_id: Uuid, enabled: bool) -> Self {
        let previous = if enabled {
            ACTIVE.with(|slot| {
                slot.replace(Some(Arc::new(Mutex::new(Trace {
                    schema: "gyro.timing.v1",
                    trace_id: Uuid::new_v4(),
                    session_id,
                    turn_id,
                    points: Vec::new(),
                    outcome: Outcome::Interrupted,
                    truncated: false,
                    provider_requests: None,
                    started: Some(Instant::now()),
                    attempt: 0,
                    tools: HashMap::new(),
                    milestones: HashSet::new(),
                    prompt_on_spawn: false,
                }))))
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
                if let Some(mut t) = s.borrow().as_ref().and_then(|trace| trace.lock().ok()) {
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
            let Ok(trace) = trace.lock() else { return };
            // Diagnostics must never fail a provider run. Failure is visible on
            // stderr; recording success is never claimed when persistence fails.
            if let Err(error) = write_record(&format!("backend-{}", trace.trace_id), &*trace) {
                eprintln!("Gyro timing trace could not be saved: {}", error.kind());
            }
        }
    }
}
pub fn mark(stage: Stage) {
    ACTIVE.with(|s| {
        if let Some(mut t) = s.borrow().as_ref().and_then(|trace| trace.lock().ok()) {
            t.push(stage, None);
            if stage == Stage::ProcessSpawned && t.prompt_on_spawn {
                t.prompt_on_spawn = false;
                t.push(Stage::PromptSent, None);
            }
        }
    });
}
/// Request boundaries may repeat inside one model tool loop.
pub fn request(stage: Stage, index: u32) {
    ACTIVE.with(|slot| {
        if let Some(mut trace) = slot.borrow().as_ref().and_then(|trace| trace.lock().ok()) {
            trace.milestones.remove(&stage);
            let position = trace.points.len();
            trace.push(stage, None);
            if let Some(point) = trace.points.get_mut(position) {
                point.request_index = Some(index);
            }
        }
    });
}
pub fn provider_requests(summary: crate::provider_observation::Summary) {
    ACTIVE.with(|slot| {
        if let Some(mut trace) = slot.borrow().as_ref().and_then(|trace| trace.lock().ok()) {
            trace.provider_requests = Some(summary);
        }
    });
}
pub fn attempt() {
    ACTIVE.with(|s| {
        if let Some(mut t) = s.borrow().as_ref().and_then(|trace| trace.lock().ok()) {
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
        if let Some(mut t) = s.borrow().as_ref().and_then(|trace| trace.lock().ok()) {
            t.prompt_on_spawn = true;
        }
    });
}
pub fn tool(id: &str, status: &str) {
    tool_with_source(id, status, false);
}
pub fn broker_tool(id: &str, status: &str) {
    tool_with_source(id, status, true);
}
fn tool_with_source(id: &str, status: &str, broker: bool) {
    ACTIVE.with(|s| {
        if let Some(mut t) = s.borrow().as_ref().and_then(|trace| trace.lock().ok()) {
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
                    t.push(
                        if broker {
                            Stage::BrokerToolStart
                        } else {
                            Stage::ToolStart
                        },
                        Some(index),
                    );
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
                        t.push(
                            if broker {
                                Stage::BrokerToolEnd
                            } else {
                                Stage::ToolEnd
                            },
                            Some(index),
                        );
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

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UiSurface {
    Chat,
    Terminal,
    Explorer,
    Search,
    SourceControl,
    RunTest,
    Ai,
    Tools,
    Settings,
    Automations,
    Providers,
    Onboarding,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UiTimingKind {
    Startup,
    Navigation,
}

/// Startup begins at the webview time origin; navigation begins at dispatch.
/// Two frame callbacks after a commit are a paint opportunity, not a paint timestamp.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiTiming {
    pub kind: UiTimingKind,
    pub from: Option<UiSurface>,
    pub surface: UiSurface,
    pub started_to_commit_ms: f64,
    pub started_to_frame_opportunity_ms: f64,
}
impl UiTiming {
    pub fn valid(&self) -> bool {
        let times_valid = [
            self.started_to_commit_ms,
            self.started_to_frame_opportunity_ms,
        ]
        .into_iter()
        .all(|n| n.is_finite() && (0.0..=86_400_000.).contains(&n));
        times_valid
            && self.started_to_frame_opportunity_ms >= self.started_to_commit_ms
            && match self.kind {
                UiTimingKind::Startup => self.from.is_none(),
                UiTimingKind::Navigation => self.from.is_some_and(|from| from != self.surface),
            }
    }
}
pub fn record_surface(value: &UiTiming) -> std::io::Result<()> {
    if !enabled() || !value.valid() {
        return Ok(());
    }
    write_record(&format!("surface-{}", Uuid::new_v4()), value)
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
    fn broker_workers_share_the_parent_trace_without_leaking_content() {
        let mut scope = Scope::with_enabled(Uuid::new_v4(), Uuid::new_v4(), true);
        attempt();
        let handle = capture();
        std::thread::spawn(move || {
            let _attached = attach(handle);
            tool("private-path", "running");
            let approval = ApprovalScope::start();
            drop(approval);
            tool("private-path", "done");
        })
        .join()
        .unwrap();
        ACTIVE.with(|slot| {
            let handle = slot.borrow_mut().take().unwrap();
            let trace = handle.lock().unwrap();
            assert!(trace
                .points
                .iter()
                .any(|point| point.stage == Stage::ApprovalEnd));
            assert!(trace
                .points
                .iter()
                .any(|point| point.stage == Stage::ToolEnd));
            assert!(!serde_json::to_string(&*trace)
                .unwrap()
                .contains("private-path"));
        });
        scope.active = false;
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
            let t = slot.as_ref().unwrap().lock().unwrap();
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
            assert!(!serde_json::to_string(&*t).unwrap().contains("sensitive"));
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
            let t = slot.as_ref().unwrap().lock().unwrap();
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
            assert!(!serde_json::to_string(&*t).unwrap().contains("sensitive"));
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
            let trace = slot.take().unwrap();
            let t = trace.lock().unwrap();
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

    #[test]
    fn surface_timing_rejects_content_and_unbounded_or_impossible_measurements() {
        let input = serde_json::json!({"kind":"navigation", "from":"chat", "surface":"source-control", "startedToCommitMs":12., "startedToFrameOpportunityMs":40.});
        let mut value: UiTiming = serde_json::from_value(input.clone()).unwrap();
        assert!(value.valid());
        for invalid in [-1., f64::NAN, f64::INFINITY, 86_400_001.] {
            value.started_to_frame_opportunity_ms = invalid;
            assert!(!value.valid());
        }
        value.started_to_frame_opportunity_ms = 10.;
        assert!(!value.valid(), "frame cannot precede commit");
        value.started_to_frame_opportunity_ms = 40.;
        value.from = Some(UiSurface::SourceControl);
        assert!(!value.valid(), "no-op navigation is unmeasured");
        value.from = None;
        assert!(!value.valid(), "navigation needs a source");
        value.kind = UiTimingKind::Startup;
        assert!(value.valid());
        value.from = Some(UiSurface::Chat);
        assert!(!value.valid());
        let mut private = input.clone();
        private["prompt"] = "private content".into();
        assert!(serde_json::from_value::<UiTiming>(private).is_err());
        let mut path = input;
        path["surface"] = "/private/workspace".into();
        assert!(serde_json::from_value::<UiTiming>(path).is_err());
    }
}
