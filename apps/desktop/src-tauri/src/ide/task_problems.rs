//! Bounded compiler output → navigable Problems. Unknown output stays in Output.
use std::{collections::HashSet, path::Path};

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskProblem {
    pub(crate) id: String,
    pub(crate) path: String,
    pub(crate) message: String,
    pub(crate) severity: String,
    pub(crate) source: String,
    pub(crate) start_line_number: u32,
    pub(crate) start_column: u32,
}

/// Only actual files inside the task's workspace can become navigation targets.
/// Canonicalization also excludes symlinks into other workspaces.
pub(crate) fn task_problems(
    root: &Path,
    cwd: &Path,
    source: &str,
    stdout: &str,
    stderr: &str,
) -> Vec<TaskProblem> {
    let Ok(root) = root.canonicalize() else {
        return Vec::new();
    };
    let mut problems = Vec::new();
    let mut seen = HashSet::new();
    for stream in [stdout, stderr] {
        let mut rust_message: Option<(String, String)> = None;
        for raw in stream.lines().take(50_000) {
            if problems.len() >= 500 {
                return problems;
            }
            let line = strip_ansi(raw);
            let line = line.trim();
            if line.len() > 16_384 {
                continue;
            }
            if line.starts_with("error[")
                || line.starts_with("error:")
                || line.starts_with("warning:")
                || line.starts_with("warning[")
            {
                rust_message = Some((line.to_string(), severity(line).into()));
            }
            let parsed = if let Some(location) = line.strip_prefix("-->") {
                rust_message.take().and_then(|(message, level)| {
                    colon_location(location.trim())
                        .map(|(path, row, col, _)| (path, row, col, message, level))
                })
            } else {
                let tsc = line.rsplit_once("):").and_then(|(location, message)| {
                    location.rsplit_once('(').and_then(|(path, position)| {
                        let (row, col) = position.split_once(',')?;
                        Some((
                            path,
                            positive(row)?,
                            positive(col)?,
                            message.trim().to_string(),
                            severity(message).into(),
                        ))
                    })
                });
                tsc.or_else(|| {
                    colon_location(line).map(|(path, row, col, message)| {
                        (
                            path,
                            row,
                            col,
                            message.to_string(),
                            severity(message).into(),
                        )
                    })
                })
            };
            let Some((path, row, col, message, level)) = parsed else {
                continue;
            };
            // A source location in an ordinary log is not a compiler failure.
            // Unrecognized formats remain in Output instead of inventing errors.
            let label = message.to_ascii_lowercase();
            if ![
                "error:",
                "error[",
                "error ",
                "fatal error:",
                "warning:",
                "warning[",
                "warning ",
            ]
            .iter()
            .any(|prefix| label.starts_with(prefix))
            {
                continue;
            }
            let path = path.trim().trim_matches(['"', '\'']);
            let candidate = cwd.join(path);
            let Ok(candidate) = candidate.canonicalize() else {
                continue;
            };
            if !candidate.starts_with(&root) || !candidate.is_file() {
                continue;
            }
            let path = candidate.to_string_lossy().to_string();
            let key = (path.clone(), row, col, message.clone());
            if !seen.insert(key) {
                continue;
            }
            problems.push(TaskProblem {
                id: format!("{source}:{}", problems.len()),
                path,
                message,
                severity: level,
                source: source.into(),
                start_line_number: row,
                start_column: col,
            });
        }
    }
    problems
}

fn positive(text: &str) -> Option<u32> {
    text.trim().parse::<u32>().ok().filter(|n| *n > 0)
}

fn severity(message: &str) -> &'static str {
    if message
        .trim_start()
        .to_ascii_lowercase()
        .starts_with("warning")
    {
        "warning"
    } else {
        "error"
    }
}

fn colon_location(line: &str) -> Option<(&str, u32, u32, &str)> {
    // Search numeric location fields rather than splitting the message, which
    // may itself contain colons. Paths with spaces remain intact.
    for (offset, _) in line.match_indices(':') {
        let rest = &line[offset + 1..];
        let Some((row, tail)) = rest.split_once(':') else {
            continue;
        };
        let Some(row) = positive(row) else { continue };
        if let Some((col, message)) = tail.split_once(':') {
            if let Some(col) = positive(col) {
                return Some((&line[..offset], row, col, message.trim()));
            }
            if col
                .trim()
                .trim_start_matches(['-', '+'])
                .chars()
                .all(|c| c.is_ascii_digit())
            {
                return None;
            }
        }
        if let Some((col, message)) = tail.split_once(" - ") {
            if let Some(col) = positive(col) {
                return Some((&line[..offset], row, col, message.trim()));
            }
        }
        // Rust arrow locations end after the column; other diagnostics may omit it.
        if let Some(col) = positive(tail) {
            return Some((&line[..offset], row, col, ""));
        }
        return Some((&line[..offset], row, 1, tail.trim()));
    }
    None
}

fn strip_ansi(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for control in chars.by_ref() {
                if ('@'..='~').contains(&control) {
                    break;
                }
            }
        } else {
            result.push(c);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compiler_locations_keep_scope_severity_cwd_and_deduplicate() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir(root.join("member")).unwrap();
        std::fs::write(root.join("member/a file.ts"), "x").unwrap();
        let cwd = root.join("member");
        let tsc = "\x1b[31ma file.ts(2,7): error TS2322: Wrong: value\x1b[0m";
        let results = task_problems(root, &cwd, "task:check", tsc, tsc);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].start_column, 7);
        assert_eq!(results[0].message, "error TS2322: Wrong: value");
        assert!(results[0].path.ends_with("member/a file.ts"));
        let results = task_problems(
            root,
            &cwd,
            "task:build",
            "warning: unused value\n --> a file.ts:3:9",
            "a file.ts:4:2: error: broken\na file.ts:5: error: failure",
        );
        assert_eq!(results.len(), 3);
        assert_eq!(results[0].severity, "warning");
        assert_eq!(results[0].start_line_number, 3);
        assert_eq!(results[2].start_column, 1);
        std::fs::create_dir(cwd.join("(group)")).unwrap();
        std::fs::write(cwd.join("(group)/page.ts"), "x").unwrap();
        let results = task_problems(
            root, &cwd, "task:check",
            "(group)/page.ts(2,7): error TS2322: Wrong (value)\na file.ts:3:9 - error TS2322: Wrong",
            "",
        );
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].start_column, 7);
        assert_eq!(results[1].start_column, 9);
    }
    #[test]
    fn rejects_outside_symlink_missing_and_invalid_locations() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("escape.rs")).unwrap();
        std::fs::write(dir.path().join("ok.rs"), "x").unwrap();
        let output = format!("{}:1:1: error: outside\nescape.rs:1:1: error: bad\nmissing.rs:1:1: error: bad\nok.rs:0:1: error: bad\nok.rs:1:0: error: bad\nok.rs:1:-2: error: bad\nok.rs:1:99999999999999: error: bad\nok.rs:99999999999999:1: error: bad\nordinary log", outside.path().display());
        assert!(task_problems(dir.path(), dir.path(), "task:x", &output, "").is_empty());
    }
    #[test]
    fn bounds_diagnostics_and_oversized_lines() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("ok.rs"), "x").unwrap();
        assert!(task_problems(
            dir.path(),
            dir.path(),
            "task:x",
            "ok.rs:1:1: just an ordinary log",
            ""
        )
        .is_empty());
        let warnings = task_problems(
            dir.path(),
            dir.path(),
            "task:x",
            "ok.rs:1:1: WARNING: unused value",
            "",
        );
        assert_eq!(warnings[0].severity, "warning");
        let output = (1..1000)
            .map(|n| format!("ok.rs:{n}:1: error: broken\n"))
            .collect::<String>();
        assert_eq!(
            task_problems(dir.path(), dir.path(), "task:x", &output, "").len(),
            500
        );
        assert!(task_problems(
            dir.path(),
            dir.path(),
            "task:x",
            &format!("ok.rs:1:1: {}", "x".repeat(20_000)),
            ""
        )
        .is_empty());
    }
}
