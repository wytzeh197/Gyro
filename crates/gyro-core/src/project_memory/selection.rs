//! Deterministic, local selection. No embeddings, historical transcript scan,
//! provider calls, text truncation, or cross-project lookup.
use super::{MemoryDocument, MemoryKind, MemoryStatus, MAX_MEMORY_ENTRY_CHARS};
use crate::mutations::content_hash;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};

pub const SELECTION_VERSION: u32 = 2;
pub const MAX_CONTEXT_BYTES: usize = 6 * 1024;
pub const DEFAULT_CONTEXT_BYTES: usize = 768;
pub const MAX_CONTEXT_ENTRIES: usize = 8;
pub const MEMORY_CONTEXT_HEADER: &str =
    "Project memory (may be stale; current request/permissions prevail):\n";

#[derive(Clone, Copy, Debug)]
pub struct MemoryBudget {
    pub max_bytes: usize,
    pub max_entries: usize,
}
impl Default for MemoryBudget {
    fn default() -> Self {
        Self {
            max_bytes: DEFAULT_CONTEXT_BYTES,
            max_entries: 4,
        }
    }
}
impl MemoryBudget {
    pub fn bounded(self, context_window: Option<u64>) -> Self {
        // At most one percent of a known model window, estimated at 3 bytes
        // per token. Estimates are not tokenizer measurements.
        let window_bytes = context_window
            .map(|window| window.saturating_mul(3) / 100)
            .unwrap_or(MAX_CONTEXT_BYTES as u64);
        Self {
            max_bytes: self
                .max_bytes
                .min(MAX_CONTEXT_BYTES)
                .min(window_bytes.min(usize::MAX as u64) as usize),
            max_entries: self.max_entries.min(MAX_CONTEXT_ENTRIES),
        }
    }
}

pub struct MemoryQuery<'a> {
    pub root_id: &'a str,
    pub root_label: &'a str,
    pub request: &'a str,
    pub paths: &'a [String],
    pub requested_ids: &'a [String],
    pub budget: MemoryBudget,
}

#[derive(Clone, Debug)]
pub struct SelectedMemoryEntry {
    pub id: String,
    pub key: String,
    pub entry_hash: String,
    pub text: String,
    pub reason: &'static str,
}
#[derive(Clone, Debug)]
pub struct MemorySelection {
    pub root_id: String,
    pub root_label: String,
    pub document_hash: String,
    pub entries: Vec<SelectedMemoryEntry>,
    pub eligible_count: usize,
    pub omitted_count: usize,
    pub invalid_count: usize,
}

fn terms(text: &str) -> BTreeSet<String> {
    const STOP: &[&str] = &[
        "the",
        "and",
        "that",
        "this",
        "with",
        "from",
        "for",
        "are",
        "was",
        "were",
        "have",
        "has",
        "had",
        "can",
        "could",
        "would",
        "should",
        "will",
        "how",
        "what",
        "when",
        "where",
        "which",
        "please",
        "use",
        "using",
        "our",
        "you",
        "your",
        "into",
        "then",
        "than",
        "want",
        "need",
        "make",
        "get",
        "its",
        "some",
        "about",
        "also",
        "project",
        "work",
        "help",
        // Task verbs and conversational filler should not retrieve unrelated facts.
        // Domain terms such as "memory" remain searchable.
        "fix",
        "change",
        "add",
        "remove",
        "show",
        "find",
        "check",
        "look",
        "read",
        "run",
        "implement",
        "update",
        "optimize",
        "improve",
        "explain",
        "tell",
        "does",
        "why",
        "now",
        "one",
        "just",
        "little",
        "more",
        "less",
        "still",
        "again",
        "continue",
    ];
    text.chars()
        .take(4096)
        .collect::<String>()
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|s| s.chars().count() >= 3)
        .map(str::to_lowercase)
        .filter(|word| !STOP.contains(&word.as_str()))
        .take(128)
        .collect()
}

/// Exact snake_case or mixedCase symbols are strong anchors even in a longer
/// question. Keep the same bounded tokenization as lexical retrieval.
fn identifiers(text: &str) -> BTreeSet<String> {
    text.chars()
        .take(4096)
        .collect::<String>()
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|token| {
            token.contains('_')
                || (token.chars().any(char::is_lowercase)
                    && token.chars().skip(1).any(char::is_uppercase))
        })
        .map(str::to_lowercase)
        .take(128)
        .collect()
}

fn path_matches(scope: &str, path: &str) -> bool {
    path == scope
        || path
            .strip_prefix(scope)
            .is_some_and(|tail| tail.starts_with('/'))
        || scope
            .strip_prefix(path)
            .is_some_and(|tail| tail.starts_with('/'))
}

pub fn select_memory(document: &MemoryDocument<'_>, query: MemoryQuery<'_>) -> MemorySelection {
    let request_terms = terms(query.request);
    let request_identifiers = identifiers(query.request);
    let entry_terms: Vec<_> = document
        .entries
        .iter()
        .map(|entry| terms(entry.text))
        .collect();
    let mut frequencies: HashMap<&String, usize> = HashMap::new();
    for terms in &entry_terms {
        for term in terms {
            *frequencies.entry(term).or_default() += 1;
        }
    }
    let mut ranked = Vec::new();
    for (index, entry) in document.entries.iter().enumerate() {
        if entry.status != MemoryStatus::Active
            || entry.source_changed
            || crate::security::redact_secrets(entry.text) != entry.text
            || entry.text.chars().count() > MAX_MEMORY_ENTRY_CHARS
            || entry.text.trim().is_empty()
        {
            continue;
        }
        let metadata = entry.metadata.as_ref();
        let explicit = query.requested_ids.iter().any(|id| id == &entry.id);
        let path = metadata.is_some_and(|meta| {
            meta.paths
                .iter()
                .any(|scope| query.paths.iter().any(|path| path_matches(scope, path)))
        });
        let relevance: usize = request_terms
            .intersection(&entry_terms[index])
            .map(|term| 1000 / frequencies.get(term).copied().unwrap_or(1))
            .sum();
        let matched_terms = request_terms.intersection(&entry_terms[index]).count();
        let exact_identifier = !request_identifiers.is_disjoint(&entry_terms[index]);
        // A single shared word ("chat", "tokens") in a longer request is weak
        // evidence. Require corroboration, except for focused one-topic queries
        // and exact code symbols. Explicit IDs and scoped paths always qualify.
        let relevant = matched_terms >= 2
            || (matched_terms == 1 && (request_terms.len() == 1 || exact_identifier));
        if !explicit && !path && !relevant {
            continue;
        }
        let unresolved =
            metadata.is_some_and(|meta| meta.kind == MemoryKind::OpenProblem) && relevance > 0;
        let tier = if explicit {
            3
        } else if path {
            2
        } else {
            1
        };
        ranked.push((tier, relevance, unresolved, index));
    }
    ranked.sort_by(|a, b| {
        (b.0, b.1, b.2)
            .cmp(&(a.0, a.1, a.2))
            .then_with(|| document.entries[b.3].date.cmp(document.entries[a.3].date))
            .then_with(|| document.entries[a.3].id.cmp(&document.entries[b.3].id))
    });
    let eligible_count = ranked.len();
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    let root_label = query
        .root_label
        .chars()
        .filter(|c| !c.is_control())
        .take(80)
        .collect::<String>();
    let mut bytes = MEMORY_CONTEXT_HEADER.len() + root_label.len() + 2;
    for (tier, _, _, index) in ranked {
        let entry = &document.entries[index];
        let normalized = entry.text.split_whitespace().collect::<Vec<_>>().join(" ");
        if !seen.insert(normalized.to_lowercase()) {
            continue;
        }
        let key =
            content_hash(format!("{}\0{}", query.root_id, entry.id).as_bytes())[..16].to_string();
        let line = format!("- [{key}] {normalized}\n");
        if entries.len() >= query.budget.max_entries || bytes + line.len() > query.budget.max_bytes
        {
            continue;
        }
        bytes += line.len();
        entries.push(SelectedMemoryEntry {
            id: entry.id.clone(),
            key,
            entry_hash: entry.entry_hash.clone(),
            text: normalized,
            reason: match tier {
                3 => "explicit",
                2 => "path",
                _ => "request-terms",
            },
        });
    }
    MemorySelection {
        root_id: query.root_id.into(),
        root_label,
        document_hash: document.document_hash.clone(),
        omitted_count: eligible_count.saturating_sub(entries.len()),
        entries,
        eligible_count,
        invalid_count: document
            .entries
            .iter()
            .filter(|entry| entry.status == MemoryStatus::Invalid || entry.source_changed)
            .count(),
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntryReceipt {
    pub id: String,
    pub key: String,
    pub entry_hash: String,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRootReceipt {
    pub root_id: String,
    pub document_hash: String,
    pub entries: Vec<MemoryEntryReceipt>,
    pub omitted_count: usize,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryReceipt {
    pub selection_version: u32,
    pub roots: Vec<MemoryRootReceipt>,
    pub supplied_bytes: usize,
    pub estimated_tokens: usize,
    pub reused_count: usize,
    pub removed_keys: Vec<String>,
    pub delta: bool,
}

#[derive(Clone, Debug, Default)]
pub struct PreparedMemoryContext {
    pub suggest_candidates: bool,
    pub selections: Vec<MemorySelection>,
    pub previous: Option<MemoryReceipt>,
    pub max_bytes: usize,
}

impl PreparedMemoryContext {
    pub fn render(&self, resumed: bool) -> (String, MemoryReceipt) {
        if resumed
            && self
                .previous
                .as_ref()
                .is_none_or(|receipt| receipt.selection_version != SELECTION_VERSION)
        {
            let reset = "Project memory update: disregard all earlier project memory.\n";
            let mut fresh = self.clone();
            fresh.max_bytes = fresh.max_bytes.saturating_sub(reset.len());
            let (text, mut receipt) = fresh.render(false);
            let text = format!("{reset}{text}");
            receipt.delta = true;
            receipt.supplied_bytes = text.len();
            receipt.estimated_tokens = text.len().div_ceil(3);
            return (text, receipt);
        }
        let previous = self
            .previous
            .as_ref()
            .filter(|receipt| resumed && receipt.selection_version == SELECTION_VERSION);
        let old: HashMap<_, _> = previous
            .into_iter()
            .flat_map(|r| &r.roots)
            .flat_map(|root| &root.entries)
            .map(|entry| (entry.key.as_str(), entry.entry_hash.as_str()))
            .collect();
        let mut receipt = MemoryReceipt {
            selection_version: SELECTION_VERSION,
            delta: previous.is_some(),
            ..Default::default()
        };
        let mut body = String::new();
        let mut included_keys = HashSet::new();
        // Budget for removal messages before admitting new text. Old entries
        // are always explicitly invalidated when leaving this turn's selection.
        let new_keys: HashSet<_> = self
            .selections
            .iter()
            .flat_map(|root| &root.entries)
            .map(|entry| entry.key.as_str())
            .collect();
        receipt.removed_keys = old
            .keys()
            .filter(|key| !new_keys.contains(**key))
            .map(|key| key.to_string())
            .collect();
        receipt.removed_keys.sort();
        if !receipt.removed_keys.is_empty() {
            body.push_str(&format!(
                "Ignore earlier memory refs: {}.\n",
                receipt.removed_keys.join(",")
            ));
        }
        let mut seen_text = HashSet::new();
        for root in &self.selections {
            let mut root_receipt = MemoryRootReceipt {
                root_id: root.root_id.clone(),
                document_hash: root.document_hash.clone(),
                omitted_count: root.omitted_count,
                entries: Vec::new(),
            };
            let mut root_body = String::new();
            for entry in &root.entries {
                if entry.reason == "retained" && previous.is_none() {
                    continue;
                }
                if !seen_text.insert(entry.text.to_lowercase()) {
                    root_receipt.omitted_count += 1;
                    continue;
                }
                let unchanged = old.get(entry.key.as_str()) == Some(&entry.entry_hash.as_str());
                let line = format!("- [{}] {}\n", entry.key, entry.text);
                if !unchanged
                    && MEMORY_CONTEXT_HEADER.len()
                        + body.len()
                        + root_body.len()
                        + root.root_label.len()
                        + 2
                        + line.len()
                        > self.max_bytes
                {
                    root_receipt.omitted_count += 1;
                    continue;
                }
                if unchanged {
                    receipt.reused_count += 1;
                } else {
                    root_body.push_str(&line);
                }
                included_keys.insert(entry.key.as_str());
                root_receipt.entries.push(MemoryEntryReceipt {
                    id: entry.id.clone(),
                    key: entry.key.clone(),
                    entry_hash: entry.entry_hash.clone(),
                });
            }
            if !root_body.is_empty() {
                body.push_str(&format!("{}:\n{root_body}", root.root_label));
            }
            receipt.roots.push(root_receipt);
        }
        // If a budget change omits previously selected text, it also needs an
        // invalidation. The maximum previous set is eight, so this is bounded.
        let mut extra: Vec<_> = old
            .keys()
            .filter(|key| {
                !included_keys.contains(**key)
                    && !receipt.removed_keys.iter().any(|removed| removed == **key)
            })
            .map(|key| key.to_string())
            .collect();
        extra.sort();
        if !extra.is_empty() {
            body.push_str(&format!(
                "Ignore earlier memory refs: {}.\n",
                extra.join(",")
            ));
            receipt.removed_keys.extend(extra);
        }
        let mut text = if body.is_empty() {
            String::new()
        } else {
            format!("{MEMORY_CONTEXT_HEADER}{body}")
        };
        if previous.is_some() && !old.is_empty() && !text.is_empty() {
            let reset = "Project memory update: disregard all earlier project memory.\n";
            let full = Self {
                suggest_candidates: false,
                selections: self.selections.clone(),
                previous: None,
                max_bytes: self.max_bytes.saturating_sub(reset.len()),
            };
            let (replacement, mut full_receipt) = full.render(false);
            if text.len() > self.max_bytes || reset.len() + replacement.len() < text.len() {
                text = format!("{reset}{replacement}");
                full_receipt.delta = true;
                full_receipt.removed_keys = old.keys().map(|key| key.to_string()).collect();
                full_receipt.removed_keys.sort();
                receipt = full_receipt;
            }
        }
        receipt.supplied_bytes = text.len();
        receipt.estimated_tokens = text.len().div_ceil(3);
        (text, receipt)
    }
}
