use super::{
    types::MAX_METADATA_BYTES, MemoryDiagnostic, MemoryMetadata, MemoryStatus,
    MAX_MEMORY_FILE_BYTES,
};
use crate::mutations::content_hash;
use anyhow::Result;
use std::ops::Range;

/// A legacy bullet, with its complete byte span including the line ending.
/// Provisional IDs identify an occurrence in this exact document revision.
/// They must not be persisted as managed IDs or interpreted as provenance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryEntry<'a> {
    pub id: String,
    pub date: &'a str,
    pub text: &'a str,
    pub source_span: Range<usize>,
    pub metadata: Option<MemoryMetadata>,
    pub status: MemoryStatus,
    pub entry_hash: String,
    pub source_changed: bool,
}

/// Lossless view over the authoritative UTF-8 file. Parsing never rewrites it.
#[derive(Debug)]
pub struct MemoryDocument<'a> {
    source: &'a str,
    pub document_hash: String,
    pub entries: Vec<MemoryEntry<'a>>,
    pub diagnostics: Vec<MemoryDiagnostic>,
}

impl<'a> MemoryDocument<'a> {
    pub fn parse(source: &'a str) -> Result<Self> {
        if source.len() > MAX_MEMORY_FILE_BYTES {
            anyhow::bail!("project memory is too large to read in Gyro");
        }
        if source.contains('\0') {
            anyhow::bail!("project memory is not a text file");
        }
        let document_hash = content_hash(source.as_bytes());
        let mut entries = Vec::new();
        let mut diagnostics = Vec::new();
        let lines: Vec<_> = source.split_inclusive('\n').collect();
        let mut start = 0;
        let mut index = 0;
        while index < lines.len() {
            let line = lines[index];
            let end = start + line.len();
            if let Some((date, text)) = split_entry(line) {
                let mut entry = MemoryEntry {
                    id: format!("legacy:{document_hash}:{start}:{end}"),
                    date,
                    text,
                    source_span: start..end,
                    metadata: None,
                    status: MemoryStatus::Active,
                    entry_hash: content_hash(text.as_bytes()),
                    source_changed: false,
                };
                if let Some(metadata_line) = lines
                    .get(index + 1)
                    .filter(|line| line.trim_start().starts_with("<!-- gyro-memory:"))
                {
                    entry.source_span.end += metadata_line.len();
                    let parsed = parse_metadata(metadata_line);
                    match parsed {
                        Ok(metadata) => {
                            entry.id = metadata.id.clone();
                            entry.source_changed = metadata
                                .text_hash
                                .as_ref()
                                .is_some_and(|hash| hash != &entry.entry_hash);
                            entry.metadata = Some(metadata);
                        }
                        Err(error) => {
                            entry.status = MemoryStatus::Invalid;
                            diagnostics.push(MemoryDiagnostic {
                                entry_id: Some(entry.id.clone()),
                                line: index + 2,
                                message: error.to_string(),
                            });
                        }
                    }
                    index += 1;
                }
                start = entry.source_span.end;
                entries.push(entry);
            } else {
                if line.trim_start().starts_with("<!-- gyro-memory:") {
                    diagnostics.push(MemoryDiagnostic {
                        entry_id: None,
                        line: index + 1,
                        message: "Memory metadata has no preceding entry".into(),
                    });
                }
                start = end;
            }
            index += 1;
        }
        validate_graph(&mut entries, &mut diagnostics, source);
        diagnostics.sort_by(|a, b| (a.line, &a.message).cmp(&(b.line, &b.message)));
        Ok(Self {
            source,
            document_hash,
            entries,
            diagnostics,
        })
    }

    pub fn source(&self) -> &'a str {
        self.source
    }
}

fn parse_metadata(line: &str) -> Result<MemoryMetadata> {
    anyhow::ensure!(
        line.len() <= MAX_METADATA_BYTES + 32,
        "memory metadata exceeds its size limit"
    );
    let json = line
        .trim()
        .strip_prefix("<!-- gyro-memory:")
        .and_then(|value| value.strip_suffix("-->"))
        .ok_or_else(|| anyhow::anyhow!("malformed memory metadata comment"))?;
    let metadata: MemoryMetadata = serde_json::from_str(json)?;
    metadata.validate()?;
    Ok(metadata)
}

#[derive(Clone, Copy)]
enum ChainStatus {
    Unchecked,
    Visiting,
    Valid,
    Cycle,
    AmbiguousTarget,
    DuplicateId,
}

fn validate_graph(
    entries: &mut [MemoryEntry<'_>],
    diagnostics: &mut Vec<MemoryDiagnostic>,
    source: &str,
) {
    use std::collections::{HashMap, HashSet};
    let mut ids = HashMap::new();
    let mut has_duplicate_ids = false;
    for (index, entry) in entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| entry.metadata.is_some())
    {
        ids.entry(entry.id.as_str())
            .and_modify(|target| {
                *target = None;
                has_duplicate_ids = true;
            })
            .or_insert(Some(index));
    }
    if ids.is_empty() {
        return;
    }

    let mut statuses = vec![ChainStatus::Unchecked; entries.len()];
    let mut path = Vec::new();
    for (start, entry) in entries.iter().enumerate() {
        if entry.metadata.is_none() {
            continue;
        }
        let mut cursor = start;
        let status = loop {
            match statuses[cursor] {
                ChainStatus::Unchecked => {}
                ChainStatus::Visiting => break ChainStatus::Cycle,
                status => break status,
            }
            let next = entries[cursor]
                .metadata
                .as_ref()
                .and_then(|meta| meta.supersedes.as_deref());
            let status = match next.and_then(|id| ids.get(id)) {
                Some(Some(index)) => {
                    statuses[cursor] = ChainStatus::Visiting;
                    path.push(cursor);
                    cursor = *index;
                    continue;
                }
                Some(None) => ChainStatus::AmbiguousTarget,
                None => ChainStatus::Valid,
            };
            statuses[cursor] = status;
            break status;
        };
        // Every entry on this path reaches the same terminal condition.
        for index in path.drain(..) {
            statuses[index] = status;
        }
    }
    if has_duplicate_ids {
        // A chain error takes precedence over a duplicate ID on the starting entry.
        for (entry, status) in entries.iter().zip(&mut statuses) {
            if matches!(status, ChainStatus::Valid)
                && ids.get(entry.id.as_str()).is_some_and(Option::is_none)
            {
                *status = ChainStatus::DuplicateId;
            }
        }
    }

    let mut line = 1;
    let mut previous_start = 0;
    for (entry, status) in entries.iter_mut().zip(statuses) {
        let message = match status {
            ChainStatus::Cycle => "Memory supersession cycle",
            ChainStatus::AmbiguousTarget => "Supersession target is ambiguous",
            ChainStatus::DuplicateId => "Duplicate managed memory ID",
            _ => continue,
        };
        let start = entry.source_span.start;
        line += source[previous_start..start]
            .bytes()
            .filter(|byte| *byte == b'\n')
            .count();
        previous_start = start;
        entry.status = MemoryStatus::Invalid;
        diagnostics.push(MemoryDiagnostic {
            entry_id: Some(entry.id.clone()),
            line,
            message: message.into(),
        });
    }
    let superseded: HashSet<_> = entries
        .iter()
        .filter(|entry| entry.status != MemoryStatus::Invalid)
        .filter_map(|entry| entry.metadata.as_ref()?.supersedes.clone())
        .collect();
    for entry in entries
        .iter_mut()
        .filter(|entry| entry.status == MemoryStatus::Active)
    {
        if superseded.contains(&entry.id) {
            entry.status = MemoryStatus::Superseded;
        }
    }
}

fn split_entry(line: &str) -> Option<(&str, &str)> {
    let entry = line.trim().strip_prefix("- ")?;
    Some(match entry.split_once(" — ") {
        Some((date, text)) if looks_like_date(date) => (date, text.trim()),
        _ => ("", entry.trim()),
    })
}

pub(super) fn looks_like_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
}
