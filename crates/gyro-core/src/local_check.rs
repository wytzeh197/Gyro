//! Local Check evidence. Commands provide observations, never verdicts.
//! A report proves only the reviewed assertions and explicitly selected files.
use crate::execution::{ExecutionOutcome, ExecutionRequest, ExecutionTermination};
use crate::{CancellationToken, CredentialPolicy};
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
pub mod browser;
pub const MAX_CHECK_REQUIREMENTS: usize = 8;
use std::{
    collections::BTreeSet,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    time::Duration,
};

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CheckScope {
    Api,
    Browser,
    Command,
    #[default]
    Unspecified,
}

impl CheckScope {
    fn label(self) -> &'static str {
        match self {
            Self::Api => "API",
            Self::Browser => "browser interaction",
            Self::Command => "command assertions",
            Self::Unspecified => "unspecified",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckCriterion {
    pub id: String,
    pub requirement: String,
    pub expected: Value,
    // Missing only in older reports. New approvals must choose a scope.
    #[serde(default)]
    pub scope: CheckScope,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckDraft {
    pub session_id: String,
    /// The originating turn and previous reviewed plan are context, never authority.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<CheckTaskReference>,
    pub preview_url: String,
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser: Option<browser::BrowserCheck>,
    pub data_changes: String,
    pub files: Vec<String>,
    pub criteria: Vec<CheckCriterion>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckTaskReference {
    pub source_turn_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_plan_id: Option<String>,
}

impl CheckDraft {
    pub fn validate(&self) -> Result<()> {
        uuid::Uuid::parse_str(&self.session_id)?;
        if let Some(task) = &self.task {
            uuid::Uuid::parse_str(&task.source_turn_id)?;
            if let Some(id) = &task.previous_plan_id {
                uuid::Uuid::parse_str(id)?;
            }
        }
        ensure!(
            self.preview_url.len() <= 2048,
            "Use a bounded local test URL"
        );
        let url = url::Url::parse(&self.preview_url)?;
        ensure!(
            url.scheme() == "http"
                && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none(),
            "Use a loopback HTTP test URL without credentials, query or fragment"
        );
        if let Some(browser) = &self.browser {
            ensure!(
                self.command.is_empty(),
                "Choose browser steps or a command, not both"
            );
            browser.validate(&self.criteria)?;
        } else {
            ensure!(
                !self.command.trim().is_empty() && self.command.len() <= 8192,
                "Provide a bounded test command"
            );
        }
        ensure!(
            !self.data_changes.trim().is_empty() && self.data_changes.len() <= 2000,
            "Describe the expected data changes"
        );
        ensure!(
            !self.files.is_empty() && self.files.len() <= 64,
            "Select 1–64 relevant files to fingerprint"
        );
        ensure!(
            !self.criteria.is_empty() && self.criteria.len() <= MAX_CHECK_REQUIREMENTS,
            "Provide 1–8 requirements"
        );
        let mut ids = BTreeSet::new();
        for criterion in &self.criteria {
            ensure!(
                criterion.scope != CheckScope::Unspecified,
                "Choose what each requirement must cover"
            );
            ensure!(
                !criterion.id.is_empty()
                    && criterion.id.len() <= 80
                    && criterion
                        .id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
                "Invalid observation key"
            );
            ensure!(ids.insert(&criterion.id), "Duplicate requirement key");
            ensure!(
                !criterion.requirement.trim().is_empty() && criterion.requirement.len() <= 2000,
                "Provide a requirement"
            );
            ensure!(
                serde_json::to_vec(&criterion.expected)?.len() <= 4096,
                "Expected observation is too large"
            );
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFingerprint {
    pub path: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckSnapshot {
    pub workspace: PathBuf,
    pub git_head: Option<String>,
    pub files: Vec<FileFingerprint>,
}

pub fn snapshot(workspace: &Path, files: &[String]) -> Result<CheckSnapshot> {
    let workspace = workspace.canonicalize()?;
    ensure!(workspace.is_dir(), "Workspace is unavailable");
    let mut fingerprints = Vec::new();
    let mut seen = BTreeSet::new();
    for name in files {
        let relative = Path::new(name);
        ensure!(
            !name.is_empty()
                && relative
                    .components()
                    .all(|c| matches!(c, Component::Normal(_))),
            "Fingerprint paths must be relative files without traversal"
        );
        let mut path = workspace.clone();
        for component in relative.components() {
            path.push(component);
            ensure!(
                !fs::symlink_metadata(&path)?.file_type().is_symlink(),
                "Fingerprint paths cannot contain symlinks"
            );
        }
        ensure!(
            path.is_file() && path.starts_with(&workspace),
            "Fingerprint file is unavailable"
        );
        ensure!(
            seen.insert(relative.to_path_buf()),
            "Duplicate fingerprint file"
        );
        let mut bytes = Vec::new();
        fs::File::open(&path)?
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= 1024 * 1024,
            "Fingerprint files must be at most 1 MiB"
        );
        fingerprints.push(FileFingerprint {
            path: name.clone(),
            sha256: format!("{:x}", Sha256::digest(bytes)),
        });
    }
    let mut git = ExecutionRequest::new("git");
    git.args = vec![
        "-c".into(),
        "core.fsmonitor=false".into(),
        "rev-parse".into(),
        "HEAD".into(),
    ];
    git.current_dir = Some(workspace.clone());
    git.credentials = CredentialPolicy::scrubbed();
    git.timeout = Duration::from_secs(3);
    git.max_stdout_chars = 128;
    git.max_stderr_chars = 128;
    let git_head = crate::run_command(git, CancellationToken::default(), |_| {})
        .ok()
        .filter(|o| o.succeeded())
        .map(|o| o.stdout.trim().to_string())
        .filter(|s| (s.len() == 40 || s.len() == 64) && s.bytes().all(|b| b.is_ascii_hexdigit()));
    Ok(CheckSnapshot {
        workspace,
        git_head,
        files: fingerprints,
    })
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckPlan {
    pub id: String,
    pub created_at: String,
    pub workspace_revision: u64,
    pub draft: CheckDraft,
    pub snapshot: CheckSnapshot,
}

/// Run exactly the reviewed action, always within the existing macOS boundary.
/// Callers own explicit approval; this function cannot widen or retry a policy.
pub fn run_check(
    plan: &CheckPlan,
    home: &Path,
    private: &Path,
    cancellation: CancellationToken,
) -> Result<ExecutionOutcome> {
    ensure!(
        plan.draft.browser.is_none(),
        "Browser actions must use the native browser driver; no command ran"
    );
    ensure!(
        snapshot(&plan.snapshot.workspace, &plan.draft.files)? == plan.snapshot,
        "Files changed after review; review a new plan"
    );
    let root = &plan.snapshot.workspace;
    let sandbox = crate::workspace_sandbox::PreparedWorkspaceSandbox::prepare(
        root,
        root,
        home,
        Some(private),
    )?;
    let shell_args = vec!["-c".into(), plan.draft.command.clone().into()];
    let (program, args) = sandbox.wrap_command(std::ffi::OsStr::new("/bin/sh"), &shell_args);
    let mut request = ExecutionRequest::new(program);
    request.args = args;
    request.current_dir = Some(root.clone());
    request.credentials = CredentialPolicy::scrubbed();
    // Test commands should retain the app's inherited toolchain ordering.
    // Provider discovery prepends user CLI shims; use those only as fallback.
    let path = format!(
        "{}:{}",
        std::env::var("PATH").unwrap_or_default(),
        crate::augmented_gui_path()
    );
    request.env = vec![
        ("PATH".into(), Some(path.into())),
        (
            "GYRO_CHECK_URL".into(),
            Some(plan.draft.preview_url.clone().into()),
        ),
    ];
    request
        .env
        .extend(sandbox.environment().into_iter().map(|(k, v)| (k, Some(v))));
    request.timeout = Duration::from_secs(60);
    request.max_stdout_chars = 32_768;
    request.max_stderr_chars = 16_384;
    request.max_total_output_bytes = 256 * 1024;
    request.max_output_chunks = 4096;
    crate::run_command(request, cancellation, |_| {})
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CheckStatus {
    Passed,
    Failed,
    NotChecked,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CriterionResult {
    pub criterion_id: String,
    pub status: CheckStatus,
    pub actual: Option<Value>,
    pub evidence: Option<String>,
    pub reason: String,
    #[serde(default)]
    pub observed_scope: Option<CheckScope>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckReport {
    pub plan: CheckPlan,
    pub finished_at: String,
    pub results: Vec<CriterionResult>,
    pub output: Option<ExecutionOutcome>,
    pub stale: bool,
    pub freshness_note: String,
    pub omission: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Observations {
    version: u32,
    preview_url: String,
    observations: Vec<Observation>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Observation {
    criterion_id: String,
    actual: Value,
    evidence: String,
    #[serde(default)]
    scope: Option<CheckScope>,
}

pub fn not_checked(plan: CheckPlan, reason: &str) -> CheckReport {
    let native_browser = plan.draft.browser.is_some();
    let results = plan
        .draft
        .criteria
        .iter()
        .map(|c| CriterionResult {
            criterion_id: c.id.clone(),
            status: CheckStatus::NotChecked,
            actual: None,
            evidence: None,
            reason: reason.to_string(),
            observed_scope: None,
        })
        .collect();
    let mut report = CheckReport {
        plan, finished_at: chrono::Utc::now().to_rfc3339(), results, output: None,
        stale: false, freshness_note: "Freshness has not been rechecked.".into(),
        omission: "Only the approved assertion scope is checked. API evidence does not establish browser behavior. Browser interactions do not establish visual, accessibility, installed-app or live-provider acceptance. Only the listed files and Git HEAD are fingerprinted; runtime data and other files are outside this snapshot. Output and scope are supplied by the approved test command, not an independent oracle.".into(),
    };
    if native_browser {
        report.omission="Only the reviewed DOM text/count/height assertions are checked. Height is an exact CSS bounding-box measurement at the reviewed viewport, not a screenshot or proof of visual quality, visibility without occlusion, accessibility, installed-app or live-provider acceptance. Page content is untrusted. Only the listed files and Git HEAD are fingerprinted; runtime state and other files are outside this snapshot. The browser action does not run a shell command or use the command filesystem sandbox.".into();
    }
    report
}

pub fn report_from_output(plan: CheckPlan, output: ExecutionOutcome) -> CheckReport {
    let mut report = not_checked(plan, "No matching observation was returned.");
    let observations: Result<Observations> = (|| {
        ensure!(
            output.termination == (ExecutionTermination::Exited { code: Some(0) }),
            "Check action did not finish successfully: {:?}",
            output.termination
        );
        ensure!(
            !output.stdout_truncated && !output.stderr_truncated,
            "Command output was truncated"
        );
        let parsed: Observations = serde_json::from_str(&output.stdout)
            .context("Command did not return the observation JSON contract")?;
        ensure!(
            parsed.version == 2,
            "Observation contract version 2 is required, including an explicit evidence scope"
        );
        ensure!(
            parsed.preview_url == report.plan.draft.preview_url,
            "Observation preview URL does not match the approved plan"
        );
        ensure!(
            parsed.observations.len() <= MAX_CHECK_REQUIREMENTS,
            "Too many observations"
        );
        let mut ids = BTreeSet::new();
        for observation in &parsed.observations {
            ensure!(
                ids.insert(&observation.criterion_id),
                "Ambiguous duplicate observations"
            );
            ensure!(
                report
                    .plan
                    .draft
                    .criteria
                    .iter()
                    .any(|c| c.id == observation.criterion_id),
                "Unknown observation key"
            );
            ensure!(
                !observation.evidence.trim().is_empty() && observation.evidence.len() <= 8192,
                "Observation needs bounded supporting evidence"
            );
        }
        Ok(parsed)
    })();
    match observations {
        Err(error) => report
            .results
            .iter_mut()
            .for_each(|r| r.reason = error.to_string()),
        Ok(observations) => {
            for result in &mut report.results {
                if let Some(observed) = observations
                    .observations
                    .iter()
                    .find(|o| o.criterion_id == result.criterion_id)
                {
                    let criterion = report
                        .plan
                        .draft
                        .criteria
                        .iter()
                        .find(|c| c.id == result.criterion_id)
                        .unwrap();
                    result.observed_scope = observed.scope;
                    if criterion.scope == CheckScope::Unspecified
                        || observed.scope != Some(criterion.scope)
                    {
                        result.reason = format!("Returned {} evidence does not cover the approved {} requirement. Review the assertion and run a new check.", observed.scope.unwrap_or_default().label(), criterion.scope.label());
                        continue;
                    }
                    result.status = if observed.actual == criterion.expected {
                        CheckStatus::Passed
                    } else {
                        CheckStatus::Failed
                    };
                    result.actual = Some(observed.actual.clone());
                    result.evidence = Some(observed.evidence.clone());
                    result.reason = "Observed value compared with the expected value approved for this requirement.".into();
                }
            }
        }
    }
    if report.plan.draft.browser.is_some() && !output.stderr.is_empty() {
        for result in &mut report.results {
            if result.status == CheckStatus::NotChecked && result.observed_scope.is_none() {
                result.reason = output.stderr.clone();
            }
        }
    }
    report.output = Some(output);
    report
}

/// Do not reinterpret earlier unscoped verdicts as scoped evidence. Preserve
/// raw process output for inspection; no new execution is implied by this read.
pub fn refresh_evidence_scope(report: &mut CheckReport) {
    for result in &mut report.results {
        if result.status == CheckStatus::NotChecked {
            continue;
        }
        let valid = report
            .plan
            .draft
            .criteria
            .iter()
            .find(|c| c.id == result.criterion_id)
            .is_some_and(|c| {
                c.scope != CheckScope::Unspecified && result.observed_scope == Some(c.scope)
            });
        if !valid {
            result.status = CheckStatus::NotChecked;
            result.actual = None;
            result.evidence = None;
            result.reason = "Earlier report lacks matching reviewed evidence scope. Inspect the raw output, then review and run a new check.".into();
        }
    }
}

pub fn refresh_freshness(report: &mut CheckReport) {
    refresh_evidence_scope(report);
    match snapshot(&report.plan.snapshot.workspace, &report.plan.draft.files) {
        Ok(current) if current == report.plan.snapshot => {
            // Once a change was observed, do not resurrect old evidence.
            if !report.stale {
                report.freshness_note = "Listed files and Git HEAD match the approved snapshot. Runtime state is not covered.".into();
            }
        }
        Ok(_) => {
            report.stale = true;
            report.freshness_note =
                "Files or Git HEAD changed after this plan was prepared. Run a new check.".into();
        }
        Err(error) => {
            report.stale = true;
            report.freshness_note = format!("Snapshot cannot be verified: {error}");
        }
    }
}

pub fn save_report(base: &Path, report: &CheckReport) -> Result<()> {
    crate::paths::ensure_private_directory(base)?;
    let id = uuid::Uuid::parse_str(&report.plan.id)?;
    let path = base.join(format!("{id}.json"));
    let bytes = serde_json::to_vec_pretty(report)?;
    let mut temp = tempfile::NamedTempFile::new_in(base)?;
    use std::io::Write;
    temp.write_all(&bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|e| e.error)?;
    Ok(())
}

#[cfg(test)]
mod tests;
