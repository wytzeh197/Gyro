//! Read-only Git history for the model: `gyro_git_log`, `gyro_git_show`, and
//! `gyro_git_blame`.
//!
//! Every call builds an argv list and never a shell string, so a revision or a
//! path is data rather than syntax. Revisions are additionally refused when
//! they start with `-`, which is what would turn a ref into an option such as
//! `--output=`, and paths go through the same workspace-relative normalization
//! the read tools use. Output arrives bounded and secret-redacted from
//! `run_command_output_with_limits`, and is bounded again here per line and per
//! entry so one call cannot spend a whole turn's context.
use super::*;
use serde_json::{json, Value};
use std::time::Duration;

const GIT_HISTORY_SCHEMA: &str = "gyro.git-history.v1";
const GIT_HISTORY_TIMEOUT: Duration = Duration::from_secs(30);
const GIT_HISTORY_INACTIVITY: Duration = Duration::from_secs(10);
const MAX_REVISION_CHARS: usize = 200;
const MAX_GIT_OUTPUT_BYTES: usize = 96 * 1024;
const MAX_GIT_OUTPUT_LINES: usize = 400;
const DEFAULT_LOG_ENTRIES: usize = 20;
const MAX_LOG_ENTRIES: usize = 50;
const MAX_BLAME_LINES: u64 = 400;
const MAX_BLAME_LINE_CHARS: usize = 300;
/// Field and record separators git expands with `%x1f` / `%x1e`. A commit
/// subject can contain a tab, so the separators are control characters that a
/// subject cannot contain.
const UNIT: char = '\u{1f}';
const RECORD: char = '\u{1e}';

pub(super) fn execute(
    _app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    request: &CapabilityRequest,
) -> anyhow::Result<(String, Value, Option<CapabilityResourceRef>)> {
    let arguments = &request.arguments;
    let root = bound.workspace.clone();
    let (summary, data) = match request.capability_id {
        CapabilityId::WorkspaceGitLog => {
            let limit = capability_argument_usize(arguments, "limit")
                .unwrap_or(DEFAULT_LOG_ENTRIES)
                .clamp(1, MAX_LOG_ENTRIES);
            let revision = optional_revision(arguments)?;
            let path = optional_workspace_path(arguments)?;
            let mut command = git_command();
            command
                .arg("-C")
                .arg(&root)
                .arg("log")
                .arg(format!("--max-count={limit}"))
                .arg("--date=short")
                .arg(format!(
                    "--pretty=format:%H{UNIT}%ad{UNIT}%an{UNIT}%s{RECORD}"
                ))
                .arg("--no-color");
            if let Some(revision) = revision.as_deref() {
                command.arg(revision);
            }
            command.arg("--");
            if let Some(path) = path.as_deref() {
                command.arg(path);
            }
            let output = run_git_history(command)?;
            let commits = parse_log(&output.stdout);
            let label = revision.clone().unwrap_or_else(|| "HEAD".into());
            (
                format!("Read {} commit(s) from git log", commits.len()),
                json!({
                    "schema": GIT_HISTORY_SCHEMA,
                    "revision": label,
                    "path": path,
                    "commits": commits,
                }),
            )
        }
        CapabilityId::WorkspaceGitShow => {
            let revision = validated_revision(capability_argument_string(arguments, "revision")?)?;
            let path = optional_workspace_path(arguments)?;
            let stat_only = arguments
                .get("stat")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let mut command = git_command();
            command
                .arg("-C")
                .arg(&root)
                .arg("show")
                .arg("--no-color")
                .arg("--date=short");
            if stat_only {
                command.arg("--stat").arg("--oneline");
            } else {
                command.arg("--pretty=format:commit %H%nAuthor: %an <%ae>%nDate: %ad%n%n%s%n");
            }
            command.arg(&revision).arg("--");
            if let Some(path) = path.as_deref() {
                command.arg(path);
            }
            let output = run_git_history(command)?;
            let (text, truncated) = bounded_text(&output.stdout);
            (
                format!("Read git show {revision}"),
                json!({
                    "schema": GIT_HISTORY_SCHEMA,
                    "revision": revision,
                    "path": path,
                    "stat": stat_only,
                    "truncated": truncated,
                    "output": text,
                }),
            )
        }
        CapabilityId::WorkspaceGitBlame => {
            let path = required_workspace_path(arguments)?;
            let candidate = gyro_core::security::assert_path_inside_workspace(
                &bound.workspace,
                Path::new(&path),
            )?;
            let (start, end) = blame_range(arguments, file_line_count(&candidate, &path)?)?;
            let mut command = git_command();
            command
                .arg("-C")
                .arg(&root)
                .arg("blame")
                .arg("--line-porcelain")
                .arg(format!("-L{start},{end}"))
                .arg("--")
                .arg(&path);
            let output = run_git_history(command)?;
            let lines = parse_blame(&output.stdout);
            (
                format!("Read git blame for {path} lines {start}-{end}"),
                json!({
                    "schema": GIT_HISTORY_SCHEMA,
                    "path": path,
                    "lineStart": start,
                    "lineEnd": end,
                    "lines": lines,
                }),
            )
        }
        other => anyhow::bail!("git_history_capability does not handle {other}"),
    };
    let data = bound_git_result(data)?;
    Ok((summary, data, None))
}

/// A revision is data for git, never syntax: the argv list already removes
/// shell interpretation, and this removes option interpretation.
fn validated_revision(value: &str) -> anyhow::Result<String> {
    let value = value.trim();
    if value.is_empty() {
        anyhow::bail!("capability argument `revision` is required");
    }
    if value.len() > MAX_REVISION_CHARS {
        anyhow::bail!("capability argument `revision` is too long");
    }
    if value.starts_with('-') {
        anyhow::bail!("capability argument `revision` must not start with `-`");
    }
    if value.chars().any(|c| c.is_control()) {
        anyhow::bail!("capability argument `revision` must not contain control characters");
    }
    Ok(value.to_string())
}

fn optional_revision(arguments: &Value) -> anyhow::Result<Option<String>> {
    arguments
        .get("revision")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(validated_revision)
        .transpose()
}

fn optional_workspace_path(arguments: &Value) -> anyhow::Result<Option<String>> {
    arguments
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(gyro_core::normalize_capability_relative_path)
        .transpose()
}

fn required_workspace_path(arguments: &Value) -> anyhow::Result<String> {
    gyro_core::normalize_capability_relative_path(capability_argument_string(arguments, "path")?)
}

/// Git refuses a `-L` range past the end of the file, so the range is resolved
/// against the real line count before the command is built.
fn blame_range(arguments: &Value, file_lines: u64) -> anyhow::Result<(u64, u64)> {
    if file_lines == 0 {
        anyhow::bail!("file is empty, so there is nothing to blame");
    }
    let requested_start = capability_argument_u64(arguments, "lineStart").ok();
    let requested_end = capability_argument_u64(arguments, "lineEnd").ok();
    let start = requested_start.unwrap_or(1).max(1);
    let default_end = start.saturating_add(MAX_BLAME_LINES - 1).min(file_lines);
    let end = requested_end.unwrap_or(default_end).min(file_lines);
    // Check the start against the file before comparing the two ends: a start
    // past EOF would otherwise be reported as an end that precedes it, which
    // does not tell the caller what to change.
    if start > file_lines {
        anyhow::bail!("capability argument `lineStart` is past the end of {file_lines}-line file");
    }
    if end < start {
        anyhow::bail!("capability argument `lineEnd` must not be before `lineStart`");
    }
    if end - start + 1 > MAX_BLAME_LINES {
        anyhow::bail!("a blame range is limited to {MAX_BLAME_LINES} lines per call");
    }
    Ok((start, end))
}

fn file_line_count(candidate: &Path, path: &str) -> anyhow::Result<u64> {
    let (bytes, _) =
        read_bounded_regular_file(candidate, MAX_WORKSPACE_FILE_EDIT_BYTES, "workspace file")?;
    if bytes.len() > MAX_WORKSPACE_FILE_EDIT_BYTES {
        anyhow::bail!("{path} is too large to blame in Gyro");
    }
    if bytes.contains(&0) {
        anyhow::bail!("{path} is binary, so there is nothing to blame");
    }
    let newlines = bytes.iter().filter(|byte| **byte == b'\n').count() as u64;
    Ok(if bytes.last() == Some(&b'\n') || newlines == 0 {
        newlines
    } else {
        newlines + 1
    })
}

fn run_git_history(command: Command) -> anyhow::Result<IdeCommandOutput> {
    let output = run_command_output_with_limits(
        command,
        CancellationToken::default(),
        GIT_HISTORY_TIMEOUT,
        Some(GIT_HISTORY_INACTIVITY),
    )?;
    if output.status != "done" {
        let detail = [output.stderr.trim(), output.stdout.trim()]
            .into_iter()
            .find(|text| !text.is_empty())
            .unwrap_or("git produced no output");
        anyhow::bail!(
            "git history command did not succeed: {}",
            detail.lines().next().unwrap_or(detail)
        );
    }
    Ok(output)
}

fn parse_log(stdout: &str) -> Vec<Value> {
    stdout
        .split(RECORD)
        .map(str::trim_start)
        .filter(|record| !record.is_empty())
        .filter_map(|record| {
            let mut fields = record.split(UNIT);
            let sha = fields.next()?.trim();
            if sha.is_empty() {
                return None;
            }
            Some(json!({
                "sha": sha,
                "date": fields.next().unwrap_or("").trim(),
                "author": fields.next().unwrap_or("").trim(),
                "subject": fields.next().unwrap_or("").trim(),
            }))
        })
        .collect()
}

/// `--line-porcelain` prints the headers for every line, so each block is
/// self-contained and a repeated commit never loses its author.
fn parse_blame(stdout: &str) -> Vec<Value> {
    let mut entries = Vec::new();
    let mut sha = String::new();
    let mut author = String::new();
    let mut line_number: Option<u64> = None;
    for raw in stdout.lines() {
        if let Some(content) = raw.strip_prefix('\t') {
            if let Some(line) = line_number {
                entries.push(json!({
                    "sha": sha.chars().take(9).collect::<String>(),
                    "author": author,
                    "line": line,
                    "content": truncate_chars(content, MAX_BLAME_LINE_CHARS),
                }));
            }
            continue;
        }
        if let Some(value) = raw.strip_prefix("author ") {
            author = value.trim().to_string();
            continue;
        }
        let fields = raw.split(' ').collect::<Vec<_>>();
        let head = fields.first().copied().unwrap_or_default();
        if head.len() >= 7 && head.chars().all(|c| c.is_ascii_hexdigit()) {
            sha = head.to_string();
            // `<sha> <original-line> <final-line> [<line-count>]`
            line_number = fields.get(2).and_then(|value| value.parse().ok());
        }
    }
    entries
}

fn truncate_chars(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    value.chars().take(limit).collect::<String>() + "…"
}

/// Keep patches and blame inside both a line and a byte budget, and say so
/// rather than silently dropping the tail.
fn bounded_text(value: &str) -> (String, bool) {
    let redacted = gyro_core::security::redact_secrets(value);
    let mut text = String::new();
    let mut truncated = false;
    for (index, line) in redacted.lines().enumerate() {
        if index >= MAX_GIT_OUTPUT_LINES || text.len() + line.len() + 1 > MAX_GIT_OUTPUT_BYTES {
            truncated = true;
            break;
        }
        text.push_str(line);
        text.push('\n');
    }
    (text, truncated)
}

/// The capability result has its own hard limit, so halve the entry list until
/// the payload fits instead of failing the call.
fn bound_git_result(mut data: Value) -> anyhow::Result<Value> {
    let key = if data.get("commits").is_some() {
        "commits"
    } else if data.get("lines").is_some() {
        "lines"
    } else {
        return Ok(data);
    };
    while serde_json::to_vec(&data)?.len() > gyro_core::capabilities::MAX_CAPABILITY_RESULT_BYTES {
        let length = data[key].as_array().map(Vec::len).unwrap_or(0);
        if length <= 1 {
            break;
        }
        if let Some(items) = data[key].as_array_mut() {
            items.truncate(length / 2);
        }
        data["truncated"] = json!(true);
    }
    Ok(data)
}

/// Tool schemas live here so `lib.rs` keeps a single delegation guard instead
/// of one arm per capability.
pub(super) fn schema(id: CapabilityId) -> Option<(Value, Vec<&'static str>)> {
    let (properties, required) = match id {
        CapabilityId::WorkspaceGitLog => (
            json!({
                "revision": {
                    "type": "string",
                    "description": "Revision or range to walk back from, such as HEAD, main, v0.1.0-alpha.48.7, or HEAD~5..HEAD. Defaults to HEAD. Must not start with a dash."
                },
                "limit": { "type": "integer", "minimum": 1, "maximum": MAX_LOG_ENTRIES },
                "path": { "type": "string", "description": "Optional workspace-relative path to limit history to." }
            }),
            vec![],
        ),
        CapabilityId::WorkspaceGitShow => (
            json!({
                "revision": {
                    "type": "string",
                    "description": "Revision to show, such as HEAD, a commit sha, or a tag. Must not start with a dash."
                },
                "path": { "type": "string", "description": "Optional workspace-relative path to limit the diff to." },
                "stat": { "type": "boolean", "description": "Return only the changed-file summary instead of the full patch." }
            }),
            vec!["revision"],
        ),
        CapabilityId::WorkspaceGitBlame => (
            json!({
                "path": { "type": "string", "description": "Workspace-relative file to blame." },
                "lineStart": { "type": "integer", "minimum": 1, "description": "First line to blame. Defaults to 1." },
                "lineEnd": { "type": "integer", "minimum": 1, "description": "Last line to blame. Defaults to a bounded window from lineStart." }
            }),
            vec!["path"],
        ),
        _ => return None,
    };
    Some((properties, required))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revisions_are_refused_when_they_could_be_read_as_options() {
        for value in ["-n1", "--output=/tmp/x", "-"] {
            let error = validated_revision(value).unwrap_err().to_string();
            assert!(error.contains("must not start with"), "{value}: {error}");
        }
        assert!(validated_revision("").is_err());
        assert!(validated_revision(&"a".repeat(MAX_REVISION_CHARS + 1)).is_err());
        assert!(validated_revision("HEAD~2\nrm -rf /").is_err());
        assert_eq!(validated_revision(" HEAD~2 ").unwrap(), "HEAD~2");
        assert_eq!(
            validated_revision("v0.1.0-alpha.48.7").unwrap(),
            "v0.1.0-alpha.48.7"
        );
        assert_eq!(validated_revision("HEAD~5..HEAD").unwrap(), "HEAD~5..HEAD");
    }

    #[test]
    fn log_records_split_on_control_separators() {
        let stdout = format!(
            "abc123{UNIT}2026-09-19{UNIT}Wytze{UNIT}Ship the thing{UNIT}subject with a tab\
             {RECORD}def456{UNIT}2026-09-18{UNIT}Someone{UNIT}Fix the other thing{RECORD}"
        );
        let commits = parse_log(&stdout);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0]["sha"], "abc123");
        assert_eq!(commits[0]["date"], "2026-09-19");
        assert_eq!(commits[0]["author"], "Wytze");
        assert_eq!(commits[1]["subject"], "Fix the other thing");
    }

    #[test]
    fn blame_blocks_keep_author_and_line_number() {
        let stdout = "\
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 1\n\
author Wytze\n\
author-mail <w@example.com>\n\
summary The subject\n\
filename src/lib.rs\n\
\tlet x = 1;\n\
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 2 2 1\n\
author Someone Else\n\
\tlet y = 2;\n";
        let lines = parse_blame(stdout);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["sha"], "aaaaaaaaa");
        assert_eq!(lines[0]["author"], "Wytze");
        assert_eq!(lines[0]["line"], 1);
        assert_eq!(lines[0]["content"], "let x = 1;");
        assert_eq!(lines[1]["author"], "Someone Else");
        assert_eq!(lines[1]["line"], 2);
    }

    #[test]
    fn blame_range_is_clamped_to_the_file_and_a_bounded_window() {
        assert_eq!(blame_range(&json!({}), 10).unwrap(), (1, 10));
        assert_eq!(
            blame_range(&json!({ "lineStart": 3 }), 10).unwrap(),
            (3, 10)
        );
        assert_eq!(
            blame_range(&json!({ "lineStart": 2, "lineEnd": 4 }), 10).unwrap(),
            (2, 4)
        );
        // A start past EOF names that as the problem rather than blaming the
        // end, and an end past EOF is clamped to the file rather than handed to
        // git, which refuses an out-of-range -L outright.
        let past_end = blame_range(&json!({ "lineStart": 900, "lineEnd": 1000 }), 10)
            .unwrap_err()
            .to_string();
        assert!(past_end.contains("past the end"), "{past_end}");
        assert_eq!(
            blame_range(&json!({ "lineStart": 5, "lineEnd": 1000 }), 10).unwrap(),
            (5, 10)
        );
        let too_wide = blame_range(&json!({ "lineStart": 1, "lineEnd": 5000 }), 9000)
            .unwrap_err()
            .to_string();
        assert!(too_wide.contains("limited to"), "{too_wide}");
        assert!(blame_range(&json!({}), 0).is_err());
    }

    #[test]
    fn bounded_text_reports_truncation_instead_of_dropping_silently() {
        let short = (1..=10)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let (text, truncated) = bounded_text(&short);
        assert!(!truncated);
        assert_eq!(text.lines().count(), 10);

        let long = (1..=MAX_GIT_OUTPUT_LINES + 50)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let (text, truncated) = bounded_text(&long);
        assert!(truncated);
        assert_eq!(text.lines().count(), MAX_GIT_OUTPUT_LINES);
    }

    #[test]
    fn paths_and_revisions_stay_workspace_relative() {
        assert!(optional_workspace_path(&json!({ "path": "../outside" })).is_err());
        assert_eq!(
            optional_workspace_path(&json!({ "path": "src/lib.rs" }))
                .unwrap()
                .as_deref(),
            Some("src/lib.rs")
        );
        assert!(optional_workspace_path(&json!({})).unwrap().is_none());
        assert!(optional_revision(&json!({ "revision": "-n1" })).is_err());
        assert!(optional_revision(&json!({})).unwrap().is_none());
    }

    #[test]
    fn schemas_require_the_arguments_each_tool_needs() {
        let (properties, required) = schema(CapabilityId::WorkspaceGitLog).unwrap();
        assert!(properties["revision"].is_object());
        assert!(required.is_empty());
        let (_, required) = schema(CapabilityId::WorkspaceGitShow).unwrap();
        assert_eq!(required, vec!["revision"]);
        let (_, required) = schema(CapabilityId::WorkspaceGitBlame).unwrap();
        assert_eq!(required, vec!["path"]);
        assert!(schema(CapabilityId::WorkspaceGitStatus).is_none());
    }
}
