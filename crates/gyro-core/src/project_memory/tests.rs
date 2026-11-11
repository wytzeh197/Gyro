use super::document::looks_like_date;
use super::write::{ensure_memory_is_small, normalize_entry_text};
use super::*;
use crate::mutations::content_hash;
use serde_json::{json, Value};

#[test]
fn lossless_parse_tracks_unicode_crlf_and_duplicate_occurrences() {
    let source =
        "# Décisions\r\n  \r\n\t- same  \r\n<!-- unknown:{\"v\":99} -->\r\n- same\r\n- 最後";
    let document = MemoryDocument::parse(source).unwrap();
    assert_eq!(document.source(), source);
    assert_eq!(document.entries.len(), 3);
    for (entry, raw) in document
        .entries
        .iter()
        .zip(["\t- same  \r\n", "- same\r\n", "- 最後"])
    {
        assert_eq!(&source[entry.source_span.clone()], raw);
    }
    assert_ne!(document.entries[0].id, document.entries[1].id);
    assert_eq!(
        document.entries,
        MemoryDocument::parse(source).unwrap().entries
    );
    let changed = format!("{source}\n");
    assert_ne!(
        document.entries[0].id,
        MemoryDocument::parse(&changed).unwrap().entries[0].id
    );
}

#[test]
fn mutations_preserve_all_bytes_outside_the_changed_span() {
    let whitespace = " \r\n\r\n";
    assert_eq!(
        append_entry(whitespace, "- 2026-11-10 — beta"),
        format!(
            "{whitespace}{}- 2026-11-10 — beta\r\n",
            MEMORY_HEADER.replace('\n', "\r\n")
        )
    );
    for newline in ["\n", "\r\n"] {
        let prefix = format!("# Mémoire  {newline}<!-- unknown -->{newline}{newline}");
        let bullet = format!("  - 2026-11-10 — alpha  {newline}");
        let suffix = format!("{newline}prose with trailing spaces  {newline}{newline}");
        let source = format!("{prefix}{bullet}{suffix}");
        assert_eq!(
            forget_entry(&source, "alpha").unwrap(),
            format!("{prefix}{suffix}")
        );
        assert_eq!(
            append_entry(&source, "- 2026-11-10 — beta"),
            format!("{source}- 2026-11-10 — beta{newline}")
        );
    }
    assert_eq!(forget_entry("- alpha", "alpha").unwrap(), "");
    assert_eq!(forget_entry("prose\n- alpha", "alpha").unwrap(), "prose\n");
    assert_eq!(
        append_entry("prose  ", "- 2026-11-10 — beta"),
        "prose  \n- 2026-11-10 — beta\n"
    );
    assert!(forget_entry("- duplicate\n- duplicate\n", "duplicate").is_err());
}

#[test]
fn write_plans_refuse_stale_hashes_and_distinguish_missing_from_empty() {
    let operation = || MemoryWrite::Append {
        date: "2026-11-10",
        text: "new",
    };
    let empty_hash = content_hash(b"");
    assert!(plan_write(Some("external edit"), Some(&empty_hash), operation()).is_err());
    assert!(plan_write(Some(""), None, operation()).is_err());
    assert!(plan_write(None, Some(&empty_hash), operation()).is_err());
    let missing = plan_write(None, None, operation()).unwrap();
    let empty = plan_write(Some(""), Some(&empty_hash), operation()).unwrap();
    assert_eq!(missing.content, empty.content);
    assert!(missing.expected_hash.is_none());
    assert_eq!(empty.expected_hash, Some(empty_hash));
}

#[test]
fn parser_and_writer_enforce_existing_file_entry_and_unicode_limits() {
    assert!(MemoryDocument::parse(&"x".repeat(MAX_MEMORY_FILE_BYTES)).is_ok());
    assert!(MemoryDocument::parse(&"x".repeat(MAX_MEMORY_FILE_BYTES + 1)).is_err());
    assert!(MemoryDocument::parse("- binary\0").is_err());
    assert!(normalize_entry_text(&"é".repeat(MAX_MEMORY_ENTRY_CHARS)).is_ok());
    assert!(normalize_entry_text(&"é".repeat(MAX_MEMORY_ENTRY_CHARS + 1)).is_err());
    let full = (0..MAX_MEMORY_ENTRIES)
        .map(|i| format!("- entry {i}\n"))
        .collect::<String>();
    assert!(plan_write(
        Some(&full),
        Some(&content_hash(full.as_bytes())),
        MemoryWrite::Append {
            date: "2026-11-10",
            text: "overflow"
        }
    )
    .is_err());
    let source = "x".repeat(MAX_MEMORY_FILE_BYTES);
    assert!(plan_write(
        Some(&source),
        Some(&content_hash(source.as_bytes())),
        MemoryWrite::Append {
            date: "2026-11-10",
            text: "overflow"
        }
    )
    .is_err());
    assert!(plan_write(
        None,
        None,
        MemoryWrite::Append {
            date: "2026-1-1\ninjected",
            text: "entry"
        }
    )
    .is_err());
}

fn memory_entries(source: &str) -> Vec<Value> {
    MemoryDocument::parse(source)
        .unwrap()
        .entries
        .into_iter()
        .map(|entry| json!({"date": entry.date, "text": entry.text}))
        .collect()
}
fn append_entry(source: &str, line: &str) -> String {
    let (date, text) = line.strip_prefix("- ").unwrap().split_once(" — ").unwrap();
    plan_write(
        Some(source),
        Some(&content_hash(source.as_bytes())),
        MemoryWrite::Append { date, text },
    )
    .unwrap()
    .content
}
fn forget_entry(source: &str, needle: &str) -> anyhow::Result<String> {
    Ok(plan_write(
        Some(source),
        Some(&content_hash(source.as_bytes())),
        MemoryWrite::Forget { needle },
    )?
    .content)
}

#[test]
fn entries_parse_dates_and_tolerate_plain_lines() {
    let content = "# Project memory\n\n- 2026-09-19 — Ship 48.8 first\n- no date here\n\nprose the user added\n";
    let entries = memory_entries(content);
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["date"], "2026-09-19");
    assert_eq!(entries[0]["text"], "Ship 48.8 first");
    assert_eq!(entries[1]["date"], "");
    assert_eq!(entries[1]["text"], "no date here");
}

#[test]
fn appending_keeps_the_header_and_existing_prose() {
    let content = format!("{MEMORY_HEADER}- 2026-09-18 — first\n\nnotes\n");
    let updated = append_entry(&content, "- 2026-09-19 — second");
    assert!(updated.contains("# Project memory"));
    assert!(updated.contains("- 2026-09-18 — first"));
    assert!(updated.contains("- 2026-09-19 — second"));
    assert!(updated.contains("\nnotes"), "{updated}");
    assert_eq!(memory_entries(&updated).len(), 2);
}

#[test]
fn appending_to_an_empty_or_absent_file_writes_the_header() {
    let updated = append_entry("", "- 2026-09-19 — first");
    assert!(updated.starts_with("# Project memory"));
    assert!(updated.ends_with("- 2026-09-19 — first\n"));
}

#[test]
fn forgetting_removes_exactly_one_matching_entry() {
    let content = "- 2026-09-19 — alpha\n- 2026-09-19 — beta\n";
    let updated = forget_entry(content, "alpha").unwrap();
    assert!(!updated.contains("alpha"));
    assert!(updated.contains("beta"));
    assert_eq!(memory_entries(&updated).len(), 1);

    let missing = forget_entry(content, "gamma").unwrap_err().to_string();
    assert!(
        missing.contains("no project memory entry matches"),
        "{missing}"
    );

    let shared = "- 2026-09-19 — ship the release\n- 2026-09-20 — tag the release\n";
    let ambiguous = forget_entry(shared, "release").unwrap_err().to_string();
    assert!(
        ambiguous.contains("2 project memory entries match"),
        "{ambiguous}"
    );
    // A date is metadata rather than entry text, so matching on one forgets
    // nothing instead of quietly removing the line it belongs to.
    let date_only = forget_entry(content, "2026-09-19").unwrap_err().to_string();
    assert!(
        date_only.contains("no project memory entry matches"),
        "{date_only}"
    );
}

#[test]
fn entry_text_collapses_whitespace_and_is_bounded() {
    assert_eq!(
        normalize_entry_text("  two\nlines   here ").unwrap(),
        "two lines here"
    );
    assert!(normalize_entry_text("   ").is_err());
    assert!(normalize_entry_text(&"x".repeat(MAX_MEMORY_ENTRY_CHARS + 1)).is_err());
}

#[test]
fn memory_size_and_entry_count_are_bounded() {
    let many = (0..MAX_MEMORY_ENTRIES + 1)
        .map(|index| format!("- 2026-09-19 — entry {index}"))
        .collect::<Vec<_>>()
        .join("\n");
    let error = ensure_memory_is_small(&many).unwrap_err().to_string();
    assert!(error.contains("more than"), "{error}");
    assert!(ensure_memory_is_small("- 2026-09-19 — one\n").is_ok());
}

#[test]
fn dates_are_recognised_strictly() {
    assert!(looks_like_date("2026-09-19"));
    assert!(!looks_like_date("2026-9-19"));
    assert!(!looks_like_date("19-09-2026"));
    assert!(!looks_like_date("not-a-date"));
}
