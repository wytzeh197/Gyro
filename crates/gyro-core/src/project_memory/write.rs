use super::{
    document::looks_like_date, MemoryDocument, MemoryDraft, MemoryMetadata, MemoryStatus,
    MAX_MEMORY_ENTRIES, MAX_MEMORY_ENTRY_CHARS, MAX_MEMORY_FILE_BYTES, MEMORY_HEADER,
};
use anyhow::Result;

pub enum MemoryWrite<'a> {
    Append {
        date: &'a str,
        text: &'a str,
    },
    Forget {
        needle: &'a str,
    },
    Add {
        date: &'a str,
        draft: &'a MemoryDraft,
    },
    AddWithId {
        id: &'a str,
        date: &'a str,
        draft: &'a MemoryDraft,
    },
    Edit {
        id: &'a str,
        date: &'a str,
        draft: &'a MemoryDraft,
    },
    ForgetId {
        id: &'a str,
    },
}

/// Replacement bytes bound to an exact base. `None` means the file was absent,
/// distinct from an existing empty file. The host must enforce both existence
/// and hash again when proposing/applying, including after queued approval.
#[derive(Debug)]
pub struct MemoryWritePlan {
    pub content: String,
    pub expected_hash: Option<String>,
}

pub fn plan_write(
    current: Option<&str>,
    expected_hash: Option<&str>,
    operation: MemoryWrite<'_>,
) -> Result<MemoryWritePlan> {
    let document = MemoryDocument::parse(current.unwrap_or_default())?;
    let actual_hash = current.map(|_| document.document_hash.as_str());
    if actual_hash != expected_hash {
        anyhow::bail!("project memory changed on disk; reload before proposing an edit");
    }
    let content = match operation {
        MemoryWrite::Append { date, text } => {
            if !looks_like_date(date) {
                anyhow::bail!("memory date must use YYYY-MM-DD");
            }
            let text = normalize_entry_text(text)?;
            let source = document.source();
            let mut updated = source.to_string();
            // Preserve every existing byte, including blank lines and trailing
            // spaces. Follow CRLF when the document uses it exclusively.
            let newline = if source.contains("\r\n") && !source.replace("\r\n", "").contains('\n') {
                "\r\n"
            } else {
                "\n"
            };
            if !updated.is_empty() && !updated.ends_with('\n') {
                updated.push_str(newline);
            }
            if source.trim().is_empty() {
                updated.push_str(&MEMORY_HEADER.replace('\n', newline));
            }
            updated.push_str(&format!("- {date} — {text}{newline}"));
            updated
        }
        MemoryWrite::Forget { needle } => {
            let needle = needle.trim();
            if needle.is_empty() {
                anyhow::bail!("capability argument `match` is required");
            }
            let matches: Vec<_> = document
                .entries
                .iter()
                .filter(|entry| entry.text.contains(needle))
                .collect();
            let entry = match matches.as_slice() {
                [] => anyhow::bail!("no project memory entry matches `{needle}`"),
                [entry] => entry,
                _ => anyhow::bail!(
                    "{} project memory entries match `{needle}`; use a longer, more specific match",
                    matches.len()
                ),
            };
            anyhow::ensure!(
                entry.status != MemoryStatus::Invalid,
                "resolve invalid memory metadata in the source file before editing this entry"
            );
            let mut updated = document.source().to_string();
            updated.replace_range(entry.source_span.clone(), "");
            updated
        }
        MemoryWrite::Add { date, draft } => {
            let line = managed_entry(&document, date, draft, None, false)?;
            let mut updated = document.source().to_string();
            if !updated.is_empty() && !updated.ends_with('\n') {
                updated.push_str(newline(document.source()));
            }
            if updated.trim().is_empty() {
                updated.push_str(&MEMORY_HEADER.replace('\n', newline(document.source())));
            }
            updated.push_str(&line);
            updated
        }
        MemoryWrite::AddWithId { id, date, draft } => {
            anyhow::ensure!(
                !document.entries.iter().any(|entry| entry.id == id),
                "memory entry already exists; reconcile the saved suggestion"
            );
            let line = managed_entry(&document, date, draft, Some(id), false)?;
            let mut updated = document.source().to_string();
            if !updated.is_empty() && !updated.ends_with('\n') {
                updated.push_str(newline(document.source()));
            }
            if updated.trim().is_empty() {
                updated.push_str(&MEMORY_HEADER.replace('\n', newline(document.source())));
            }
            updated.push_str(&line);
            updated
        }
        MemoryWrite::Edit { id, date, draft } => {
            let entry = editable_entry(&document, id)?;
            let id = entry.metadata.as_ref().map(|meta| meta.id.as_str());
            let replacement = managed_entry(&document, date, draft, id, true)?;
            let mut updated = document.source().to_string();
            // An unterminated final entry stays unterminated.
            let replacement = if document.source()[entry.source_span.clone()].ends_with('\n') {
                replacement.as_str()
            } else {
                replacement.trim_end_matches(['\r', '\n'])
            };
            updated.replace_range(entry.source_span.clone(), replacement);
            updated
        }
        MemoryWrite::ForgetId { id } => {
            let entry = editable_entry(&document, id)?;
            let mut updated = document.source().to_string();
            updated.replace_range(entry.source_span.clone(), "");
            updated
        }
    };
    ensure_memory_is_small(&content)?;
    Ok(MemoryWritePlan {
        content,
        expected_hash: actual_hash.map(str::to_string),
    })
}

fn editable_entry<'a, 'b>(
    document: &'b MemoryDocument<'a>,
    id: &str,
) -> Result<&'b super::MemoryEntry<'a>> {
    let entry = document
        .entries
        .iter()
        .find(|entry| entry.id == id)
        .ok_or_else(|| anyhow::anyhow!("memory entry no longer exists; reload"))?;
    anyhow::ensure!(
        entry.status != MemoryStatus::Invalid,
        "resolve invalid memory metadata in the source file before editing this entry"
    );
    Ok(entry)
}

fn newline(source: &str) -> &'static str {
    if source.contains("\r\n") && !source.replace("\r\n", "").contains('\n') {
        "\r\n"
    } else {
        "\n"
    }
}

fn managed_entry(
    document: &MemoryDocument<'_>,
    date: &str,
    draft: &MemoryDraft,
    id: Option<&str>,
    editing: bool,
) -> Result<String> {
    anyhow::ensure!(looks_like_date(date), "memory date must use YYYY-MM-DD");
    let text = normalize_entry_text(&draft.text)?;
    if let Some(target) = &draft.supersedes {
        anyhow::ensure!(
            document.entries.iter().any(|entry| &entry.id == target
                && entry.metadata.is_some()
                && entry.status != MemoryStatus::Invalid),
            "supersession requires an existing valid managed entry"
        );
    }
    let metadata = MemoryMetadata {
        v: 2,
        id: id
            .map(str::to_string)
            .unwrap_or_else(|| format!("mem_{}", uuid::Uuid::new_v4().simple())),
        kind: draft.kind,
        paths: draft.paths.clone(),
        sources: draft.sources.clone(),
        supersedes: draft.supersedes.clone(),
        text_hash: Some(crate::mutations::content_hash(text.as_bytes())),
    };
    metadata.validate()?;
    let nl = newline(document.source());
    let result = format!(
        "- {date} — {text}{nl}  <!-- gyro-memory:{} -->{nl}",
        serde_json::to_string(&metadata)?
    );
    // Refuse cycles introduced by editing an older managed entry.
    if id.is_some() && editing {
        let target = editable_entry(document, id.unwrap())?;
        let mut proposed = document.source().to_string();
        proposed.replace_range(target.source_span.clone(), &result);
        let parsed = MemoryDocument::parse(&proposed)?;
        anyhow::ensure!(
            parsed
                .entries
                .iter()
                .find(|entry| Some(entry.id.as_str()) == id)
                .is_some_and(|entry| entry.status != MemoryStatus::Invalid),
            "edit would create invalid memory metadata or a supersession cycle"
        );
    }
    Ok(result)
}

pub(super) fn ensure_memory_is_small(content: &str) -> Result<()> {
    if content.len() > MAX_MEMORY_FILE_BYTES {
        anyhow::bail!("project memory would exceed its size limit");
    }
    if MemoryDocument::parse(&content)?.entries.len() > MAX_MEMORY_ENTRIES {
        anyhow::bail!(
            "project memory would hold more than {MAX_MEMORY_ENTRIES} entries; forget some first"
        );
    }
    Ok(())
}

pub(super) fn normalize_entry_text(value: &str) -> Result<String> {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        anyhow::bail!("capability argument `text` is required");
    }
    if collapsed.chars().count() > MAX_MEMORY_ENTRY_CHARS {
        anyhow::bail!("a memory entry is limited to {MAX_MEMORY_ENTRY_CHARS} characters");
    }
    Ok(collapsed)
}
