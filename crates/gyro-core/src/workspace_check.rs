//! Fast, bounded workspace readiness used at turn start.
//!
//! This is not a full Workspace catalog. It answers whether the model can work
//! here, what kind of project it is, and a Git branch/dirtiness brief — within
//! a few hundred milliseconds. A missing folder fails closed. Slow Git degrades
//! the report instead of stalling the first provider token.

use crate::execution::{run_command, CancellationToken, ExecutionRequest, ExecutionTermination};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
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
        lines.push(format!(
            "Workspace check: {status} ({} ms).",
            self.duration_ms
        ));
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

pub fn check_workspace(path: impl AsRef<Path>) -> WorkspaceCheckReport {
    check_workspace_with_timeout(path, WORKSPACE_CHECK_TIMEOUT)
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
    let readable = fs::read_dir(raw).is_ok();
    if !readable {
        return unavailable_report(display_key(raw), started, true, true, false);
    }

    let canonical = raw.canonicalize().unwrap_or_else(|_| raw.to_path_buf());
    let workspace_key = canonical.display().to_string();
    let home_workspace = dirs::home_dir().is_some_and(|home| {
        home.canonicalize()
            .ok()
            .is_some_and(|home| home == canonical)
    });
    let (project_kind, markers) = detect_project(&canonical);

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

fn detect_project(root: &Path) -> (Option<String>, Vec<String>) {
    let mut markers = Vec::new();
    let mut kind = None;
    for (file_name, project_kind) in PROJECT_MARKERS {
        if markers.len() >= MAX_MARKERS {
            break;
        }
        if root.join(file_name).is_file() {
            markers.push((*file_name).to_string());
            if kind.is_none() {
                kind = Some((*project_kind).to_string());
            }
        }
    }
    (kind, markers)
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
}
