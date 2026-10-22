//! Fast, bounded workspace readiness used at turn start.
//!
//! This is not a full Workspace catalog. It answers whether the model can work
//! here, what kind of project it is, and a Git branch/dirtiness brief — within
//! a few hundred milliseconds. A missing folder fails closed. Slow Git degrades
//! the report instead of stalling the first provider token.

use crate::execution::{run_command, CancellationToken, ExecutionRequest, ExecutionTermination};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const WORKSPACE_CHECK_SCHEMA_V1: &str = "gyro.workspace-check.v1";
pub const WORKSPACE_UNAVAILABLE_MESSAGE: &str =
    "The selected project folder is no longer available. Choose a project and send again.";
pub const WORKSPACE_CHECK_TIMEOUT: Duration = Duration::from_millis(400);

const GIT_CHECK_TIMEOUT: Duration = Duration::from_millis(280);
const GIT_MAX_STDOUT_CHARS: usize = 64 * 1024;
const GIT_MAX_STDERR_CHARS: usize = 8 * 1024;
const MAX_MARKERS: usize = 12;
const MIN_GIT_BUDGET: Duration = Duration::from_millis(50);
const WORKSPACE_CHECK_CACHE_TTL: Duration = Duration::from_secs(2);
const MAX_WORKSPACE_CHECK_CACHES: usize = 8;

const PROJECT_MARKERS: &[(&str, &str)] = &[
    ("Cargo.toml", "rust"),
    ("package.json", "node"),
    ("pnpm-workspace.yaml", "node"),
    ("pyproject.toml", "python"),
    ("requirements.txt", "python"),
    ("go.mod", "go"),
    ("Gemfile", "ruby"),
    ("composer.json", "php"),
    ("pom.xml", "java"),
    ("build.gradle", "java"),
    ("build.gradle.kts", "java"),
    ("CMakeLists.txt", "c"),
    ("mix.exs", "elixir"),
    ("pubspec.yaml", "dart"),
];

/// Marker slots, so one listing can settle every marker without a per-file
/// stat and without allocating.
const MARKER_SLOTS: usize = PROJECT_MARKERS.len();

/// A root this large costs more to list than to stat marker by marker, so the
/// scan stops and the markers a listing did not reach fall back to stats.
const MAX_SCAN_ENTRIES: usize = 512;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceCheckStatus {
    Ready,
    Degraded,
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitBrief {
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub dirty_count: u32,
    pub conflicted: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCheckReport {
    pub schema: String,
    pub workspace_key: String,
    pub status: WorkspaceCheckStatus,
    pub duration_ms: u64,
    pub path_exists: bool,
    pub is_directory: bool,
    pub readable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git: Option<WorkspaceGitBrief>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_kind: Option<String>,
    #[serde(default)]
    pub markers: Vec<String>,
    pub home_workspace: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl WorkspaceCheckReport {
    pub fn placeholder(workspace_key: impl Into<String>) -> Self {
        Self {
            schema: WORKSPACE_CHECK_SCHEMA_V1.into(),
            workspace_key: workspace_key.into(),
            status: WorkspaceCheckStatus::Ready,
            duration_ms: 0,
            path_exists: true,
            is_directory: true,
            readable: true,
            git: None,
            project_kind: None,
            markers: Vec::new(),
            home_workspace: false,
            error: None,
        }
    }

    pub fn is_unavailable(&self) -> bool {
        self.status == WorkspaceCheckStatus::Unavailable
    }

    /// The canonical root this report describes.
    ///
    /// The check resolves the root once and keys its report by that path, so a
    /// caller that needs a canonical root — binding a turn's capability
    /// context, for one — takes it from here instead of resolving it again.
    pub fn canonical_workspace(&self) -> Option<PathBuf> {
        let path = Path::new(&self.workspace_key);
        path.is_absolute().then(|| path.to_path_buf())
    }

    pub fn briefing(&self) -> String {
        self.briefing_with_signals(0, 0)
    }

    pub fn briefing_with_signals(&self, diagnostics: usize, test_failures: usize) -> String {
        let mut lines = Vec::new();
        let status = match self.status {
            WorkspaceCheckStatus::Ready => "ready",
            WorkspaceCheckStatus::Degraded => "ready with warnings",
            WorkspaceCheckStatus::Unavailable => "unavailable",
        };
        lines.push(format!("Workspace check: {status}."));
        if let Some(kind) = self.project_kind.as_deref() {
            let markers = if self.markers.is_empty() {
                String::new()
            } else {
                format!(" ({})", self.markers.join(", "))
            };
            lines.push(format!("Project: {kind}{markers}."));
        } else if !self.markers.is_empty() {
            lines.push(format!("Project files: {}.", self.markers.join(", ")));
        }
        match self.git.as_ref() {
            Some(git) if git.available => {
                let mut git_line = match git.branch.as_deref() {
                    Some(branch) => format!("Git: branch {branch}"),
                    None => "Git: repository".to_string(),
                };
                if git.dirty_count > 0 {
                    git_line.push_str(&format!(", {} dirty", git.dirty_count));
                } else {
                    git_line.push_str(", clean");
                }
                if git.ahead > 0 {
                    git_line.push_str(&format!(", {} ahead", git.ahead));
                }
                if git.behind > 0 {
                    git_line.push_str(&format!(", {} behind", git.behind));
                }
                if git.conflicted {
                    git_line.push_str(", conflicts present");
                }
                git_line.push('.');
                lines.push(git_line);
            }
            Some(_) => lines.push("Git: not a repository.".into()),
            None if self.status != WorkspaceCheckStatus::Unavailable => {
                lines.push("Git: not inspected in time.".into());
            }
            None => {}
        }
        if diagnostics > 0 || test_failures > 0 {
            lines.push(format!(
                "Project signals: {}, {}.",
                counted(diagnostics, "diagnostic", "diagnostics"),
                counted(test_failures, "failing test", "failing tests")
            ));
        }
        if self.home_workspace {
            lines.push(
                "This workspace is the home folder. Stay inside the requested project paths and treat credential files as sensitive."
                    .into(),
            );
        }
        if let Some(error) = self.error.as_deref() {
            lines.push(format!("Check note: {error}"));
        }
        if self.status != WorkspaceCheckStatus::Unavailable {
            lines.push(
                "Use gyro_workspace_check to refresh this snapshot, gyro_workspace_get_context for live diagnostics and tests, and the other Workspace tools for file contents, search, and diffs. Do not guess missing files."
                    .into(),
            );
        }
        lines.join("\n")
    }
}

pub fn is_workspace_unavailable_error(error: &str) -> bool {
    error.contains(WORKSPACE_UNAVAILABLE_MESSAGE)
}

fn workspace_check_cache() -> &'static Mutex<HashMap<String, (Instant, WorkspaceCheckReport)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, WorkspaceCheckReport)>>> =
        OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached_workspace_check(key: &str) -> Option<WorkspaceCheckReport> {
    let cache = workspace_check_cache().lock().ok()?;
    let (cached_at, report) = cache.get(key)?;
    if cached_at.elapsed() < WORKSPACE_CHECK_CACHE_TTL && !report.is_unavailable() {
        Some(report.clone())
    } else {
        None
    }
}

/// One probe per workspace at a time.
///
/// A session chat, its side chats, delegated agents, and the Workspace panel
/// can all ask about the same workspace within a few milliseconds. The first
/// caller probes the folder and Git; the rest wait here and then read the
/// report it cached instead of starting a probe of their own.
fn workspace_probe_gates() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static GATES: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    GATES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn workspace_probe_gate(key: &str) -> Arc<Mutex<()>> {
    let mut gates = match workspace_probe_gates().lock() {
        Ok(gates) => gates,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some(gate) = gates.get(key) {
        return gate.clone();
    }
    if gates.len() >= MAX_WORKSPACE_CHECK_CACHES {
        // Only a gate nobody is probing or waiting on can be dropped.
        if let Some(idle) = gates
            .iter()
            .find(|(_, gate)| Arc::strong_count(gate) == 1)
            .map(|(key, _)| key.clone())
        {
            gates.remove(&idle);
        }
    }
    let gate = Arc::new(Mutex::new(()));
    gates.insert(key.to_string(), gate.clone());
    gate
}

/// The home directory, resolved once per process.
///
/// Every probe compared the root against a canonical home, which cost a full
/// path resolution per probe and per Source Control refresh. Home does not move
/// while the app runs, so resolve it once.
fn canonical_home() -> Option<&'static Path> {
    static HOME: OnceLock<Option<PathBuf>> = OnceLock::new();
    HOME.get_or_init(|| dirs::home_dir().and_then(|home| home.canonicalize().ok()))
        .as_deref()
}

pub fn check_workspace(path: impl AsRef<Path>) -> WorkspaceCheckReport {
    let raw = path.as_ref();
    let handed_key = raw.display().to_string();
    if let Some(report) = cached_workspace_check(&handed_key) {
        return report;
    }
    // The same workspace can arrive under another spelling: a trailing slash,
    // a `~` path, a symlinked root. Resolving costs one call on a miss and
    // nothing on the fast path above, and keeps every spelling on one entry
    // and one probe.
    let key = match raw.canonicalize() {
        Ok(canonical) => canonical.display().to_string(),
        Err(_) => handed_key,
    };
    if let Some(report) = cached_workspace_check(&key) {
        return report;
    }
    let gate = workspace_probe_gate(&key);
    let _probe = match gate.lock() {
        Ok(probe) => probe,
        Err(poisoned) => poisoned.into_inner(),
    };
    // A caller that queued behind the probe that just finished reads its report.
    if let Some(report) = cached_workspace_check(&key) {
        return report;
    }
    let report = check_workspace_with_timeout(path, WORKSPACE_CHECK_TIMEOUT);
    if !report.is_unavailable() {
        if let Ok(mut cache) = workspace_check_cache().lock() {
            cache.insert(key.clone(), (Instant::now(), report.clone()));
            while cache.len() > MAX_WORKSPACE_CHECK_CACHES {
                let oldest = cache
                    .iter()
                    .filter(|(cached_key, _)| *cached_key != &key)
                    .min_by_key(|(_, (cached_at, _))| *cached_at)
                    .map(|(cached_key, _)| cached_key.clone());
                let Some(oldest) = oldest else {
                    break;
                };
                cache.remove(&oldest);
            }
        }
    }
    report
}

/// Seeds the check cache with the Source Control view the Workspace pane just
/// prepared.
///
/// Opening a workspace and sending its first chat used to probe the folder and
/// Git twice: once to prepare the pane and once at turn start. The pane now
/// hands its fresh Git view to the check cache, so the first turn reuses it and
/// both surfaces describe the same branch and dirty state.
pub fn record_prepared_workspace(path: impl AsRef<Path>, git: WorkspaceGitBrief) -> bool {
    let raw = path.as_ref();
    let Ok(canonical) = raw.canonicalize() else {
        return false;
    };
    let home_workspace = canonical_home().is_some_and(|home| home == canonical);
    let (project_kind, markers) = detect_project(&canonical);
    let report = WorkspaceCheckReport {
        schema: WORKSPACE_CHECK_SCHEMA_V1.into(),
        workspace_key: canonical.display().to_string(),
        status: WorkspaceCheckStatus::Ready,
        duration_ms: 0,
        path_exists: true,
        is_directory: true,
        readable: true,
        git: Some(git),
        project_kind,
        markers,
        home_workspace,
        error: home_workspace.then(|| {
            "Workspace is the home folder; treat it as a broad, sensitive root.".to_string()
        }),
    };
    let Ok(mut cache) = workspace_check_cache().lock() else {
        return false;
    };
    let cached_at = Instant::now();
    // One entry under the canonical key. `check_workspace` resolves whatever
    // spelling it is handed to this key, so the pane's prepared view reaches
    // the chat without a duplicate cache row.
    cache.insert(report.workspace_key.clone(), (cached_at, report));
    while cache.len() > MAX_WORKSPACE_CHECK_CACHES {
        let oldest = cache
            .iter()
            .min_by_key(|(_, (cached_at, _))| *cached_at)
            .map(|(key, _)| key.clone());
        let Some(oldest) = oldest else {
            break;
        };
        cache.remove(&oldest);
    }
    true
}

pub fn check_workspace_with_timeout(
    path: impl AsRef<Path>,
    timeout: Duration,
) -> WorkspaceCheckReport {
    let started = Instant::now();
    let raw = path.as_ref();
    let trimmed = raw.to_string_lossy();
    if trimmed.trim().is_empty() {
        return unavailable_report(String::new(), started, false, false, false);
    }

    let metadata = match fs::metadata(raw) {
        Ok(metadata) => metadata,
        Err(_) => {
            return unavailable_report(display_key(raw), started, false, false, false);
        }
    };
    let is_directory = metadata.is_dir();
    if !is_directory {
        return unavailable_report(display_key(raw), started, true, false, false);
    }
    // One listing answers readability and the project markers together, so a
    // turn start no longer opens the root and then stats fourteen markers.
    let project = match scan_project_root(raw) {
        Ok(project) => project,
        Err(_) => return unavailable_report(display_key(raw), started, true, true, false),
    };

    let canonical = raw.canonicalize().unwrap_or_else(|_| raw.to_path_buf());
    let workspace_key = canonical.display().to_string();
    let home_workspace = canonical_home().is_some_and(|home| home == canonical);
    let (project_kind, markers) = (project.project_kind, project.markers);

    let remaining = timeout.saturating_sub(started.elapsed());
    let git = if remaining >= MIN_GIT_BUDGET {
        inspect_git(&canonical, remaining.min(GIT_CHECK_TIMEOUT))
    } else {
        GitInspection::Skipped
    };

    let mut status = if home_workspace {
        WorkspaceCheckStatus::Degraded
    } else {
        WorkspaceCheckStatus::Ready
    };
    let mut error = None;
    let git_brief = match git {
        GitInspection::Present(brief) => Some(brief),
        GitInspection::Missing => Some(WorkspaceGitBrief {
            available: false,
            branch: None,
            ahead: 0,
            behind: 0,
            dirty_count: 0,
            conflicted: false,
        }),
        GitInspection::Failed(message) => {
            status = WorkspaceCheckStatus::Degraded;
            error = Some(message);
            None
        }
        GitInspection::Skipped => {
            status = WorkspaceCheckStatus::Degraded;
            error = Some("Git was not inspected before the workspace check budget.".into());
            None
        }
    };
    if home_workspace && error.is_none() {
        error = Some("Workspace is the home folder; treat it as a broad, sensitive root.".into());
    }

    WorkspaceCheckReport {
        schema: WORKSPACE_CHECK_SCHEMA_V1.into(),
        workspace_key,
        status,
        duration_ms: elapsed_ms(started),
        path_exists: true,
        is_directory: true,
        readable: true,
        git: git_brief,
        project_kind,
        markers,
        home_workspace,
        error,
    }
}

fn unavailable_report(
    workspace_key: String,
    started: Instant,
    path_exists: bool,
    is_directory: bool,
    readable: bool,
) -> WorkspaceCheckReport {
    WorkspaceCheckReport {
        schema: WORKSPACE_CHECK_SCHEMA_V1.into(),
        workspace_key,
        status: WorkspaceCheckStatus::Unavailable,
        duration_ms: elapsed_ms(started),
        path_exists,
        is_directory,
        readable,
        git: None,
        project_kind: None,
        markers: Vec::new(),
        home_workspace: false,
        error: Some(WORKSPACE_UNAVAILABLE_MESSAGE.into()),
    }
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

fn display_key(path: &Path) -> String {
    path.display().to_string()
}

fn counted(count: usize, singular: &str, plural: &str) -> String {
    if count == 1 {
        format!("1 {singular}")
    } else {
        format!("{count} {plural}")
    }
}

/// What one pass over a project root learned.
struct ProjectScan {
    project_kind: Option<String>,
    markers: Vec<String>,
}

/// One pass over a project root answers both questions the check asks of it:
/// can it be listed at all, and which project markers it carries. A listing is
/// one directory read instead of one stat per marker; a root too large to list
/// cheaply falls back to those stats, which stay bounded either way.
fn scan_project_root(root: &Path) -> std::io::Result<ProjectScan> {
    let mut found = [false; MARKER_SLOTS];
    let mut outstanding = MARKER_SLOTS;
    let mut entries = 0usize;
    let mut settled = false;
    let mut listing = fs::read_dir(root)?;
    while let Some(Ok(entry)) = listing.next() {
        entries += 1;
        if let Some(index) = marker_index(&entry.file_name()) {
            if !found[index] && entry_is_file(&entry) {
                found[index] = true;
                outstanding -= 1;
                if outstanding == 0 {
                    settled = true;
                    break;
                }
            }
        }
        if entries >= MAX_SCAN_ENTRIES {
            break;
        }
    }
    if !settled {
        mark_markers_by_stat(root, &mut found);
    }
    Ok(project_scan(&found))
}

fn marker_index(name: &std::ffi::OsStr) -> Option<usize> {
    let name = name.to_str()?;
    PROJECT_MARKERS
        .iter()
        .position(|(file_name, _)| *file_name == name)
}

fn entry_is_file(entry: &fs::DirEntry) -> bool {
    match entry.file_type() {
        // A marker reached through a symlink still counts, exactly as it did
        // when the check stat-ed `root/<marker>` directly.
        Ok(file_type) if file_type.is_symlink() => entry.path().is_file(),
        Ok(file_type) => file_type.is_file(),
        Err(_) => false,
    }
}

fn mark_markers_by_stat(root: &Path, found: &mut [bool; MARKER_SLOTS]) {
    for (index, (file_name, _)) in PROJECT_MARKERS.iter().enumerate() {
        if !found[index] && root.join(file_name).is_file() {
            found[index] = true;
        }
    }
}

fn project_scan(found: &[bool; MARKER_SLOTS]) -> ProjectScan {
    let mut markers = Vec::new();
    let mut kind = None;
    for (index, (file_name, project_kind)) in PROJECT_MARKERS.iter().enumerate() {
        if !found[index] {
            continue;
        }
        if markers.len() >= MAX_MARKERS {
            break;
        }
        markers.push((*file_name).to_string());
        if kind.is_none() {
            kind = Some((*project_kind).to_string());
        }
    }
    ProjectScan {
        project_kind: kind,
        markers,
    }
}

fn detect_project(root: &Path) -> (Option<String>, Vec<String>) {
    let scan = scan_project_root(root).unwrap_or_else(|_| {
        // Not listable from here; a plain stat still knows what is there.
        let mut found = [false; MARKER_SLOTS];
        mark_markers_by_stat(root, &mut found);
        project_scan(&found)
    });
    (scan.project_kind, scan.markers)
}

enum GitInspection {
    Present(WorkspaceGitBrief),
    Missing,
    Failed(String),
    Skipped,
}

fn inspect_git(root: &Path, timeout: Duration) -> GitInspection {
    let mut request = ExecutionRequest::new("git");
    request.args = [
        "-C",
        &root.display().to_string(),
        "status",
        "--porcelain=v2",
        "--branch",
        "--untracked-files=no",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    // Runs on every turn while the agent may be committing in the same
    // repository: `GIT_OPTIONAL_LOCKS=0` keeps this read from refreshing the
    // index under `index.lock`, and the GUI PATH finds Git from a Dock launch.
    request.env = vec![
        (
            OsString::from("PATH"),
            Some(OsString::from(crate::cli_path::augmented_gui_path())),
        ),
        (
            OsString::from("GIT_OPTIONAL_LOCKS"),
            Some(OsString::from("0")),
        ),
        (
            OsString::from("GIT_TERMINAL_PROMPT"),
            Some(OsString::from("0")),
        ),
    ];
    request.timeout = timeout;
    request.max_stdout_chars = GIT_MAX_STDOUT_CHARS;
    request.max_stderr_chars = GIT_MAX_STDERR_CHARS;
    request.current_dir = Some(PathBuf::from(root));
    match run_command(request, CancellationToken::default(), |_| {}) {
        Ok(output) if output.succeeded() => GitInspection::Present(parse_git_brief(&output.stdout)),
        Ok(output) => {
            let combined = format!("{}\n{}", output.stderr, output.stdout).to_ascii_lowercase();
            if combined.contains("not a git repository") {
                GitInspection::Missing
            } else if matches!(
                output.termination,
                ExecutionTermination::TimedOut | ExecutionTermination::Inactive
            ) {
                GitInspection::Failed("Git status exceeded the workspace check budget.".into())
            } else {
                GitInspection::Failed(
                    "Git status was unavailable during the workspace check.".into(),
                )
            }
        }
        Err(_) => GitInspection::Failed("Git was unavailable during the workspace check.".into()),
    }
}

fn parse_git_brief(output: &str) -> WorkspaceGitBrief {
    let mut brief = WorkspaceGitBrief {
        available: true,
        branch: None,
        ahead: 0,
        behind: 0,
        dirty_count: 0,
        conflicted: false,
    };
    for line in output.lines() {
        if let Some(branch) = line.strip_prefix("# branch.head ") {
            if branch != "(detached)" {
                brief.branch = Some(branch.to_string());
            }
        } else if let Some(ab) = line.strip_prefix("# branch.ab ") {
            for part in ab.split_whitespace() {
                if let Some(value) = part.strip_prefix('+') {
                    brief.ahead = value.parse().unwrap_or(0);
                } else if let Some(value) = part.strip_prefix('-') {
                    brief.behind = value.parse().unwrap_or(0);
                }
            }
        } else if line.starts_with("u ") {
            brief.dirty_count = brief.dirty_count.saturating_add(1);
            brief.conflicted = true;
        } else if line.starts_with("1 ") || line.starts_with("2 ") {
            brief.dirty_count = brief.dirty_count.saturating_add(1);
        }
    }
    brief
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn missing_folder_is_unavailable_and_not_a_retry() {
        let report = check_workspace("/tmp/gyro-missing-workspace-check-folder");
        assert_eq!(report.status, WorkspaceCheckStatus::Unavailable);
        assert!(!report.path_exists);
        assert!(report.is_unavailable());
        assert!(is_workspace_unavailable_error(
            report.error.as_deref().unwrap()
        ));
        assert!(report.briefing().contains("unavailable"));
    }

    #[test]
    fn file_path_is_unavailable() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("README.md");
        fs::write(&file, "hello").unwrap();
        let report = check_workspace(&file);
        assert_eq!(report.status, WorkspaceCheckStatus::Unavailable);
        assert!(report.path_exists);
        assert!(!report.is_directory);
    }

    #[test]
    fn one_probe_gate_is_shared_per_workspace() {
        let first = workspace_probe_gate("/tmp/gyro-probe-gate-shared");
        let second = workspace_probe_gate("/tmp/gyro-probe-gate-shared");
        assert!(Arc::ptr_eq(&first, &second));
        let other = workspace_probe_gate("/tmp/gyro-probe-gate-other");
        assert!(!Arc::ptr_eq(&first, &other));
    }

    #[test]
    fn prepared_workspace_status_is_reused_by_the_next_check() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        assert!(record_prepared_workspace(
            root,
            WorkspaceGitBrief {
                available: true,
                branch: Some("prepared".into()),
                ahead: 1,
                behind: 2,
                dirty_count: 3,
                conflicted: false,
            },
        ));
        let report = check_workspace(root);
        assert_eq!(report.status, WorkspaceCheckStatus::Ready);
        let git = report.git.expect("prepared Git brief");
        assert_eq!(git.branch.as_deref(), Some("prepared"));
        assert_eq!(git.ahead, 1);
        assert_eq!(git.behind, 2);
        assert_eq!(git.dirty_count, 3);
        assert_eq!(report.duration_ms, 0);
    }

    #[test]
    fn queued_checks_reuse_the_report_published_by_the_running_probe() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_path_buf();
        // `check_workspace` queues on the canonical root, so every spelling of
        // one workspace waits behind the same probe.
        let key = root.canonicalize().unwrap().display().to_string();
        let gate = workspace_probe_gate(&key);
        let held = gate.lock().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            for _ in 0..4 {
                let root = root.clone();
                let tx = tx.clone();
                scope.spawn(move || {
                    let report = check_workspace(&root);
                    tx.send(report.duration_ms).unwrap();
                });
            }
            drop(tx);
            // Workers are blocked on the gate. Publish what the running probe
            // would have written; every queued caller must read that report.
            std::thread::sleep(Duration::from_millis(50));
            let seeded = check_workspace_with_timeout(&root, WORKSPACE_CHECK_TIMEOUT);
            let seeded_duration = seeded.duration_ms;
            workspace_check_cache()
                .lock()
                .unwrap()
                .insert(key.clone(), (Instant::now(), seeded));
            drop(held);
            for _ in 0..4 {
                assert_eq!(rx.recv().unwrap(), seeded_duration);
            }
        });
    }

    #[test]
    fn ready_workspace_check_is_reused_within_the_ttl() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("package.json"), "{}\n").unwrap();
        let first = check_workspace(temp.path());
        let second = check_workspace(temp.path());
        assert_eq!(first, second);
        assert_eq!(first.duration_ms, second.duration_ms);
        assert_eq!(first.project_kind.as_deref(), Some("node"));
    }

    #[test]
    fn rust_project_reports_kind_without_requiring_git() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("Cargo.toml"),
            "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n",
        )
        .unwrap();
        let report = check_workspace(temp.path());
        assert_ne!(report.status, WorkspaceCheckStatus::Unavailable);
        assert_eq!(report.project_kind.as_deref(), Some("rust"));
        assert!(report.markers.iter().any(|marker| marker == "Cargo.toml"));
        let briefing = report.briefing();
        assert!(briefing.contains("Project: rust"));
        assert!(briefing.contains("gyro_workspace_check"));
    }

    #[test]
    fn git_repository_brief_includes_branch_and_dirty_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        assert!(Command::new("git")
            .args(["init", "-b", "main"])
            .current_dir(root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["config", "user.email", "gyro@example.test"])
            .current_dir(root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["config", "user.name", "Gyro"])
            .current_dir(root)
            .status()
            .unwrap()
            .success());
        fs::write(root.join("README.md"), "hello").unwrap();
        assert!(Command::new("git")
            .args(["add", "README.md"])
            .current_dir(root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(root)
            .status()
            .unwrap()
            .success());
        fs::write(root.join("README.md"), "changed").unwrap();

        let report = check_workspace(root);
        let git = report.git.as_ref().expect("git brief");
        assert!(git.available);
        assert_eq!(git.branch.as_deref(), Some("main"));
        assert!(git.dirty_count >= 1);
        assert!(report.briefing().contains("branch main"));
    }

    #[test]
    fn git_brief_never_rewrites_the_index() {
        // A stat-dirty but unchanged file makes a plain `git status` refresh
        // and rewrite the index under index.lock, which can fail the agent's
        // concurrent `git commit`. The per-turn check must only read.
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let git = |args: &[&str]| {
            assert!(Command::new("git")
                .args(args)
                .current_dir(root)
                .status()
                .unwrap()
                .success());
        };
        git(&["init", "-b", "main"]);
        git(&["config", "user.email", "gyro@example.test"]);
        git(&["config", "user.name", "Gyro"]);
        fs::write(root.join("README.md"), "hello").unwrap();
        git(&["add", "README.md"]);
        git(&["commit", "-m", "init"]);
        fs::File::options()
            .write(true)
            .open(root.join("README.md"))
            .unwrap()
            .set_modified(std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_600_000_000))
            .unwrap();
        let index = fs::read(root.join(".git/index")).unwrap();

        let report = check_workspace(root);
        assert!(report.git.as_ref().expect("git brief").available);
        assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
    }

    #[test]
    fn parse_git_brief_reads_ahead_behind_and_conflicts() {
        let brief = parse_git_brief(
            "# branch.head feature\n# branch.ab +2 -1\n1 .M N... README.md\nu UU N... conflict.rs\n",
        );
        assert_eq!(brief.branch.as_deref(), Some("feature"));
        assert_eq!(brief.ahead, 2);
        assert_eq!(brief.behind, 1);
        assert_eq!(brief.dirty_count, 2);
        assert!(brief.conflicted);
    }

    #[test]
    fn briefing_includes_live_project_signals() {
        let mut report = check_workspace(tempfile::tempdir().unwrap().path());
        report.project_kind = Some("node".into());
        report.markers = vec!["package.json".into()];
        let briefing = report.briefing_with_signals(3, 1);
        assert!(briefing.contains("3 diagnostics, 1 failing test"));
    }

    #[test]
    fn one_listing_finds_the_project_markers() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::write(root.join("Cargo.toml"), "[package]\n").unwrap();
        fs::write(root.join("package.json"), "{}\n").unwrap();
        // A directory that shares a marker's name is not a marker.
        fs::create_dir(root.join("go.mod")).unwrap();
        let (kind, markers) = detect_project(root);
        assert_eq!(kind.as_deref(), Some("rust"));
        assert_eq!(
            markers,
            vec!["Cargo.toml".to_string(), "package.json".to_string()]
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_marker_still_counts() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("real-package.json");
        fs::write(&target, "{}\n").unwrap();
        std::os::unix::fs::symlink(&target, temp.path().join("package.json")).unwrap();
        let (kind, markers) = detect_project(temp.path());
        assert_eq!(kind.as_deref(), Some("node"));
        assert_eq!(markers, vec!["package.json".to_string()]);
    }

    #[test]
    fn another_spelling_reuses_the_prepared_status() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        assert!(record_prepared_workspace(
            root,
            WorkspaceGitBrief {
                available: true,
                branch: Some("prepared".into()),
                ahead: 0,
                behind: 0,
                dirty_count: 0,
                conflicted: false,
            },
        ));
        let report = check_workspace(root.join("."));
        assert_eq!(report.duration_ms, 0, "the prepared report is reused");
        assert_eq!(
            report.git.and_then(|git| git.branch).as_deref(),
            Some("prepared")
        );
        assert_eq!(
            report.workspace_key,
            root.canonicalize().unwrap().display().to_string()
        );
    }

    #[test]
    fn a_report_carries_the_canonical_root_it_probed() {
        let temp = tempfile::tempdir().unwrap();
        let report = check_workspace(temp.path());
        assert_eq!(
            report.canonical_workspace(),
            Some(temp.path().canonicalize().unwrap())
        );
        assert_eq!(
            WorkspaceCheckReport::placeholder("relative/root").canonical_workspace(),
            None
        );
    }
}
