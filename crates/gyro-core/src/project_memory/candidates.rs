use super::{MemoryDraft, MemoryKind, MemorySource};
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};

pub const MEMORY_CANDIDATE_MARKER: &str = "GYRO_MEMORY:";
pub const CANDIDATE_INSTRUCTION:&str="For a durable decision the user explicitly states this turn, optionally end with one hidden line GYRO_MEMORY: {\"v\":1,\"entries\":[{\"text\":\"one fact\",\"kind\":\"decision\",\"evidenceQuote\":\"exact quote from this user message\"}]}. At most 3 suggestions, 500 characters each. No secrets, guesses, or separate model call; never claim a suggestion was saved.";

pub fn candidate_worthy_request(message: &str) -> bool {
    let message = message.to_lowercase();
    [
        "remember",
        "decided",
        "always ",
        "prefer ",
        "convention",
        "from now on",
        "we agreed",
    ]
    .iter()
    .any(|cue| message.contains(cue))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CandidatePayload {
    v: u8,
    entries: Vec<CandidateInput>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CandidateInput {
    text: String,
    #[serde(default)]
    kind: MemoryKind,
    #[serde(default)]
    paths: Vec<String>,
    evidence_quote: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCandidate {
    pub id: String,
    pub root_key: String,
    pub source_session_id: String,
    pub source_turn_id: String,
    pub source_event_id: String,
    pub revision: u64,
    pub status: String,
    pub draft: Option<MemoryDraft>,
    pub evidence_quote: Option<String>,
}

/// Only exact quotations from the active user's message are admitted in v1.
/// The host supplies source identities, never the model or repository.
pub fn parse_memory_candidates(
    response: &str,
    user_message: &str,
) -> Result<Vec<(MemoryDraft, String)>> {
    let mut result = Vec::new();
    for line in response
        .lines()
        .filter_map(|line| line.trim().strip_prefix(MEMORY_CANDIDATE_MARKER))
        .take(1)
    {
        ensure!(line.len() <= 8192, "memory candidate payload is too large");
        let payload: CandidatePayload = serde_json::from_str(line)?;
        ensure!(
            payload.v == 1 && payload.entries.len() <= 3,
            "unsupported or oversized memory candidate payload"
        );
        let mut seen = std::collections::HashSet::new();
        for input in payload.entries {
            let text = super::write::normalize_entry_text(&input.text)?;
            let quote = input.evidence_quote.trim().to_string();
            ensure!(
                (8..=300).contains(&quote.chars().count()) && user_message.contains(&quote),
                "memory evidence must quote the active user's message"
            );
            ensure!(
                crate::security::redact_secrets(&text) == text
                    && crate::security::redact_secrets(&quote) == quote,
                "memory candidate contains sensitive content"
            );
            ensure!(input.paths.len() <= 16, "too many memory candidate paths");
            for path in &input.paths {
                super::types::validate_relative_path(path)?;
            }
            if !seen.insert(text.to_lowercase()) {
                continue;
            }
            result.push((
                MemoryDraft {
                    text,
                    kind: input.kind,
                    paths: input.paths,
                    sources: vec![MemorySource::UserEntered],
                    supersedes: None,
                },
                quote,
            ));
        }
    }
    Ok(result)
}
