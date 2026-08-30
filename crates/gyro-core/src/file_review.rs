//! The per-file review card that closes an "Ask first" turn.
//!
//! Ask first gates a file edit *before* it lands, so by the time a turn
//! settles the bytes are already on disk. This module is about the pass that
//! comes after: a plain-language line per changed file, and the user's record
//! of having read it. Neither is a gate. Keeping a file changes nothing on
//! disk, and declining to keep one changes nothing either — the review state
//! is a reading record, not an apply queue, and every string here has to stay
//! honest about that.
//!
//! The summary line is produced by one batched provider call per turn, cached
//! by content hash so a re-render, a reopened session, or a scrolled-back turn
//! never bills twice. When that call cannot run — offline, paused, budget
//! spent, provider error — the fallback is a count, never invented prose. A
//! plausible sentence about a change nobody summarized is exactly the fake
//! activity the product is meant not to produce.

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Payload tag for the session event that records a review decision.
pub const FILE_REVIEW_SCHEMA: &str = "gyro.file-review.v1";

/// Per-file diff text handed to the summarizer. Beyond this the tail is cut:
/// the opening hunks say what a change is, and a 4,000-line refactor costs the
/// same to describe as the first hundred lines of it.
const MAX_DIFF_BYTES_PER_FILE: usize = 6_000;

/// Ceiling for one batched request across every file in the turn.
const MAX_DIFF_BYTES_TOTAL: usize = 48_000;

/// Files described in one call. A turn that touched more than this gets
/// summaries for the first `MAX_SUMMARY_FILES` and counts for the rest, rather
/// than one enormous request.
pub const MAX_SUMMARY_FILES: usize = 24;

/// How a summary line was produced. The UI needs this to know whether it is
/// showing a description or a measurement.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SummarySource {
    /// The provider described the change in a sentence.
    Provider,
    /// Nothing described it, so the line is a line count.
    Fallback,
}

impl SummarySource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Provider => "provider",
            Self::Fallback => "fallback",
        }
    }

    pub fn from_str(value: &str) -> Self {
        match value {
            "provider" => Self::Provider,
            _ => Self::Fallback,
        }
    }
}

/// What the user did with a file on the review card.
///
/// Only one decision exists, and it is deliberately not called "approve":
/// nothing is waiting on it. A file with no decision is not rejected, blocked,
/// or pending application — it is simply unread.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FileReviewDecision {
    Kept,
}

impl FileReviewDecision {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Kept => "kept",
        }
    }
}

/// One changed file on the way in to the summarizer.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeInput {
    pub path: String,
    /// Unified diff for the file, as the workspace's source control reports it.
    pub diff: String,
    #[serde(default)]
    pub additions: u32,
    #[serde(default)]
    pub deletions: u32,
}

/// One changed file on the way out.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeSummary {
    pub path: String,
    /// Identity of the reviewed content. A later edit changes the hash, which
    /// is what retires a stale summary and a stale "Kept".
    pub content_hash: String,
    pub summary: String,
    pub source: SummarySource,
}

/// Hash the exact content a summary and a decision refer to.
pub fn content_hash(path: &str, diff: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.as_bytes());
    hasher.update([0u8]);
    hasher.update(diff.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The honest line for a file nothing described.
///
/// Reads as a measurement so it cannot be mistaken for a description. Hunks
/// are counted rather than guessed at: "in 3 places" is a fact about the diff.
pub fn fallback_summary(diff: &str, additions: u32, deletions: u32) -> String {
    let hunks = diff
        .lines()
        .filter(|line| line.starts_with("@@"))
        .count()
        .max(1);
    let mut parts: Vec<String> = Vec::new();
    if additions > 0 {
        parts.push(format!(
            "{additions} line{} added",
            if additions == 1 { "" } else { "s" }
        ));
    }
    if deletions > 0 {
        parts.push(format!(
            "{deletions} line{} removed",
            if deletions == 1 { "" } else { "s" }
        ));
    }
    if parts.is_empty() {
        return "Changed, with no line difference to show.".to_string();
    }
    format!(
        "{} in {hunks} place{}.",
        parts.join(", "),
        if hunks == 1 { "" } else { "s" }
    )
}

pub const CHANGE_SUMMARY_SYSTEM_PROMPT: &str = r#"You describe code changes to the person who asked for them, who may not read code.

For each file you are given, write ONE sentence saying what changed, in plain words, from the user's point of view.

Rules:
- Plain language. No jargon, no type names, no function names, no file paths, no line numbers.
- Say what it does now or what is different, not which syntax moved. "Sign-ins now last 30 days instead of 7" — not "updated the SESSION_TTL constant".
- One sentence, under 90 characters where you can manage it. End with a period.
- Never guess. If the diff does not tell you what the change is for, describe only what you can see.
- Reply with a JSON object and nothing else: keys are the exact file paths you were given, values are the sentences. No markdown, no code fence, no commentary."#;

/// Build the batched user prompt, and report which files it actually covers.
///
/// Returns the prompt together with the paths included, because the byte
/// ceilings can drop trailing files — the caller has to know which ones need a
/// fallback line rather than assuming every file was described.
pub fn build_summary_prompt(files: &[FileChangeInput]) -> (String, Vec<String>) {
    let mut prompt =
        String::from("Describe each of these changed files in one plain sentence.\n\n");
    let mut included: Vec<String> = Vec::new();
    let mut budget = MAX_DIFF_BYTES_TOTAL;

    for file in files.iter().take(MAX_SUMMARY_FILES) {
        if budget == 0 {
            break;
        }
        let (diff, truncated) = truncate_diff(&file.diff, MAX_DIFF_BYTES_PER_FILE.min(budget));
        if diff.trim().is_empty() {
            continue;
        }
        budget = budget.saturating_sub(diff.len());
        prompt.push_str("=== FILE: ");
        prompt.push_str(&file.path);
        prompt.push_str(" ===\n");
        prompt.push_str(&diff);
        if truncated {
            prompt.push_str("\n… (diff truncated)\n");
        }
        prompt.push_str("\n\n");
        included.push(file.path.clone());
    }

    prompt.push_str(
        "Reply with only a JSON object mapping each file path above to its one-sentence description.",
    );
    (prompt, included)
}

/// Cut a diff to a byte ceiling on a line boundary.
fn truncate_diff(diff: &str, limit: usize) -> (String, bool) {
    if diff.len() <= limit {
        return (diff.to_string(), false);
    }
    let mut out = String::new();
    for line in diff.lines() {
        if out.len() + line.len() + 1 > limit {
            break;
        }
        out.push_str(line);
        out.push('\n');
    }
    (out, true)
}

/// Read the model's reply back into one line per file.
///
/// Only paths that were actually asked about are accepted, so a model that
/// invents a file cannot put a sentence next to something the turn never
/// touched. Anything missing or unusable is left to the caller's fallback.
pub fn parse_summary_response(raw: &str, requested: &[String]) -> Vec<(String, String)> {
    let Some(object) = extract_json_object(raw) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(object) else {
        return Vec::new();
    };
    let Some(map) = value.as_object() else {
        return Vec::new();
    };

    let mut out: Vec<(String, String)> = Vec::new();
    for path in requested {
        let Some(sentence) = map.get(path).and_then(|entry| entry.as_str()) else {
            continue;
        };
        let cleaned = clean_sentence(sentence);
        if !cleaned.is_empty() {
            out.push((path.clone(), cleaned));
        }
    }
    out
}

/// Keep one sentence's worth of a reply, punctuated, within a readable width.
fn clean_sentence(value: &str) -> String {
    let mut text = value.trim().replace(['\n', '\r'], " ");
    while text.contains("  ") {
        text = text.replace("  ", " ");
    }
    let text = text.trim_matches(|c: char| c == '"' || c == '`').trim();
    if text.is_empty() {
        return String::new();
    }
    // A model that ignores "one sentence" gets trimmed rather than trusted:
    // the card has room for one line.
    let mut sentence = match text.find(". ") {
        Some(end) => text[..=end].trim().to_string(),
        None => text.to_string(),
    };
    if sentence.chars().count() > 160 {
        sentence = sentence.chars().take(157).collect::<String>() + "…";
    }
    if !sentence.ends_with(['.', '!', '?', '…']) {
        sentence.push('.');
    }
    sentence
}

/// Find the outermost JSON object in a reply that may be fenced or prefaced.
fn extract_json_object(raw: &str) -> Option<&str> {
    let start = raw.find('{')?;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, character) in raw[start..].char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }
        match character {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&raw[start..start + offset + character.len_utf8()]);
                }
            }
            _ => {}
        }
    }
    None
}

/// Cache table for summaries.
///
/// Separate from the session log on purpose: a summary is a derived, re-buyable
/// artifact keyed by content, not part of what happened in the conversation.
/// Review decisions go the other way — those are session events.
pub fn ensure_file_review_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "create table if not exists file_change_summaries (
           workspace_key text not null,
           path text not null,
           content_hash text not null,
           summary text not null,
           source text not null,
           created_at text not null,
           primary key (workspace_key, path, content_hash)
         );

         create index if not exists idx_file_change_summaries_created_at
         on file_change_summaries(created_at desc);",
    )
    .context("create file review schema")?;
    Ok(())
}

/// Summaries already bought for these exact contents.
pub fn cached_summaries(
    conn: &Connection,
    workspace_key: &str,
    wanted: &[(String, String)],
) -> Result<Vec<FileChangeSummary>> {
    let mut statement = conn.prepare(
        "select summary, source from file_change_summaries
         where workspace_key = ?1 and path = ?2 and content_hash = ?3",
    )?;
    let mut out: Vec<FileChangeSummary> = Vec::new();
    for (path, hash) in wanted {
        let found = statement
            .query_row(params![workspace_key, path, hash], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .ok();
        if let Some((summary, source)) = found {
            out.push(FileChangeSummary {
                path: path.clone(),
                content_hash: hash.clone(),
                summary,
                source: SummarySource::from_str(&source),
            });
        }
    }
    Ok(out)
}

/// Remember what a call produced. Fallback lines are not stored: they cost
/// nothing to rebuild, and caching one would keep a count on screen after the
/// provider became reachable again.
pub fn store_summaries(
    conn: &Connection,
    workspace_key: &str,
    summaries: &[FileChangeSummary],
) -> Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    let mut statement = conn.prepare(
        "insert or replace into file_change_summaries
           (workspace_key, path, content_hash, summary, source, created_at)
         values (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;
    for summary in summaries
        .iter()
        .filter(|entry| entry.source == SummarySource::Provider)
    {
        statement.execute(params![
            workspace_key,
            summary.path,
            summary.content_hash,
            summary.summary,
            summary.source.as_str(),
            now,
        ])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(path: &str, diff: &str) -> FileChangeInput {
        FileChangeInput {
            path: path.into(),
            diff: diff.into(),
            additions: 2,
            deletions: 1,
        }
    }

    #[test]
    fn fallback_counts_hunks_rather_than_describing() {
        let diff = "@@ -1,2 +1,3 @@\n+a\n@@ -20,2 +21,3 @@\n+b\n";
        assert_eq!(
            fallback_summary(diff, 12, 3),
            "12 lines added, 3 lines removed in 2 places."
        );
        assert_eq!(fallback_summary("", 1, 0), "1 line added in 1 place.");
    }

    #[test]
    fn prompt_reports_the_files_it_could_fit() {
        let files = vec![input("a.ts", "@@\n+one\n"), input("b.ts", "@@\n+two\n")];
        let (prompt, included) = build_summary_prompt(&files);
        assert!(prompt.contains("=== FILE: a.ts ==="));
        assert!(prompt.contains("=== FILE: b.ts ==="));
        assert_eq!(included, vec!["a.ts".to_string(), "b.ts".to_string()]);
    }

    #[test]
    fn prompt_skips_a_file_with_no_diff_text() {
        let files = vec![input("a.ts", "   "), input("b.ts", "@@\n+two\n")];
        let (_, included) = build_summary_prompt(&files);
        assert_eq!(included, vec!["b.ts".to_string()]);
    }

    #[test]
    fn parses_a_fenced_reply_and_ignores_unrequested_paths() {
        let raw = "```json\n{\"a.ts\": \"Sign-ins now last longer\", \"ghost.ts\": \"Nope\"}\n```";
        let parsed = parse_summary_response(raw, &["a.ts".to_string()]);
        assert_eq!(
            parsed,
            vec![("a.ts".to_string(), "Sign-ins now last longer.".to_string())]
        );
    }

    #[test]
    fn keeps_only_the_first_sentence() {
        let raw = "{\"a.ts\": \"Adds a retry. It also refactors the client.\"}";
        let parsed = parse_summary_response(raw, &["a.ts".to_string()]);
        assert_eq!(parsed[0].1, "Adds a retry.");
    }

    #[test]
    fn unusable_replies_produce_nothing() {
        assert!(parse_summary_response("sorry, I can't", &["a.ts".into()]).is_empty());
        assert!(parse_summary_response("{\"a.ts\": 4}", &["a.ts".into()]).is_empty());
    }

    #[test]
    fn hash_changes_with_content_and_with_path() {
        let first = content_hash("a.ts", "@@\n+one\n");
        assert_eq!(first, content_hash("a.ts", "@@\n+one\n"));
        assert_ne!(first, content_hash("a.ts", "@@\n+two\n"));
        assert_ne!(first, content_hash("b.ts", "@@\n+one\n"));
    }
}
