//! Durable project memory: notes that survive a chat.
//!
//! Memory is a workspace file (`.gyro/memory.md`), not a private database, so
//! every entry is visible, editable, diffable, and deletable by the person who
//! owns the project, and it travels with the workspace. Writes go through the
//! same proposal store as `gyro_workspace_edit`: Full Access in a normal run
//! applies the change immediately, and every other posture produces a
//! reviewable diff.
//!
//! The `.gyro` directory itself is app-owned state, created eagerly the way
//! session events are; the memory file never bypasses review. Plan mode is
//! refused, because writing memory is writing.
use super::*;
use crate::workspace_edit_capability::{assert_no_unsaved_editor_changes, emit_proposal_events};
use serde_json::{json, Value};

const MEMORY_SCHEMA: &str = "gyro.memory.v1";
const MEMORY_PATH: &str = ".gyro/memory.md";
const MEMORY_DIRECTORY: &str = ".gyro";
const MEMORY_HEADER: &str =
    "# Project memory\n\nDurable notes this project carries between chats. One entry per line.\n\n";
const MAX_MEMORY_FILE_BYTES: usize = 256 * 1024;
const MAX_MEMORY_ENTRIES: usize = 200;
const MAX_MEMORY_ENTRY_CHARS: usize = 500;
const MAX_MEMORY_RAW_CHARS: usize = 32 * 1024;

pub(super) fn execute(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    request: &CapabilityRequest,
) -> anyhow::Result<(String, Value, Option<CapabilityResourceRef>)> {
    let arguments = &request.arguments;
    let candidate = gyro_core::security::assert_path_inside_workspace(
        &bound.workspace,
        Path::new(MEMORY_PATH),
    )?;
    let content = read_memory(&candidate)?;
    match request.capability_id {
        CapabilityId::MemoryRead => {
            let entries = memory_entries(&content);
            let raw = arguments
                .get("raw")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let mut data = json!({
                "schema": MEMORY_SCHEMA,
                "path": MEMORY_PATH,
                "exists": candidate.exists(),
                "entries": entries,
                "total": entries.len(),
            });
            if raw {
                data["raw"] = json!(content
                    .chars()
                    .take(MAX_MEMORY_RAW_CHARS)
                    .collect::<String>());
            }
            let summary = if entries.is_empty() {
                format!("Project memory is empty at {MEMORY_PATH}")
            } else {
                format!("Read {} project memory entr(ies)", entries.len())
            };
            Ok((summary, data, None))
        }
        CapabilityId::MemoryWrite => {
            let action = capability_argument_string(arguments, "action")?.to_ascii_lowercase();
            let updated = match action.as_str() {
                "append" => {
                    let entry =
                        normalize_entry_text(capability_argument_string(arguments, "text")?)?;
                    append_entry(&content, &format!("- {} — {entry}", today()))
                }
                "forget" => {
                    let needle = capability_argument_string(arguments, "match")?;
                    forget_entry(&content, needle)?
                }
                other => anyhow::bail!(
                    "capability argument `action` must be `append` or `forget`, not `{other}`"
                ),
            };
            ensure_memory_is_small(&updated)?;
            assert_no_unsaved_editor_changes(app, bound, MEMORY_PATH)?;
            ensure_memory_directory(&bound.workspace, &candidate)?;
            let expected_hash = candidate
                .exists()
                .then(|| -> anyhow::Result<String> {
                    let (bytes, _) = read_bounded_regular_file(
                        &candidate,
                        MAX_MEMORY_FILE_BYTES,
                        "project memory",
                    )?;
                    Ok(content_hash(&bytes))
                })
                .transpose()?;
            let config = load_config_blocking().map_err(anyhow::Error::msg)?;
            let apply_immediately = bound.policy.mode == CapabilityRunMode::Normal
                && capability_full_access_enabled(&config);
            let store = open_store().map_err(anyhow::Error::msg)?;
            let root_id = workspace_mutations::bound_workspace_root_id(&store, bound)?;
            let proposal = workspace_mutations::create_file_mutation_proposal_at_root(
                &store,
                FileMutationProposalRequest {
                    session_id: bound.session_id.clone(),
                    turn_id: bound.turn_id.clone(),
                    path: MEMORY_PATH.to_string(),
                    content: updated,
                    expected_hash,
                },
                apply_immediately,
                Some(&root_id),
            )?;
            emit_proposal_events(app, bound, &proposal);
            let entries = memory_entries(&proposal.content);
            let summary = if apply_immediately {
                format!("Updated project memory ({action})")
            } else {
                format!("Proposed a project memory {action} for review")
            };
            let resource = CapabilityResourceRef {
                id: proposal.id.to_string(),
                kind: "proposal".into(),
                label: MEMORY_PATH.to_string(),
            };
            Ok((
                summary,
                json!({
                    "schema": MEMORY_SCHEMA,
                    "path": MEMORY_PATH,
                    "action": action,
                    "status": proposal.status.as_str(),
                    "proposalId": proposal.id,
                    "total": entries.len(),
                }),
                Some(resource),
            ))
        }
        other => anyhow::bail!("memory_capability does not handle {other}"),
    }
}

fn read_memory(candidate: &Path) -> anyhow::Result<String> {
    if !candidate.exists() {
        return Ok(String::new());
    }
    let (bytes, _) = read_bounded_regular_file(candidate, MAX_MEMORY_FILE_BYTES, "project memory")?;
    if bytes.len() > MAX_MEMORY_FILE_BYTES {
        anyhow::bail!("project memory is too large to read in Gyro");
    }
    if bytes.contains(&0) {
        anyhow::bail!("project memory is not a text file");
    }
    Ok(
        String::from_utf8(bytes)
            .map_err(|_| anyhow::anyhow!("project memory is not UTF-8 text"))?,
    )
}

/// The `.gyro` directory is app state, so it is created before the file is
/// proposed; the file itself still goes through the proposal lane.
fn ensure_memory_directory(workspace: &Path, candidate: &Path) -> anyhow::Result<()> {
    if candidate.parent().is_some_and(|parent| parent.is_dir()) {
        return Ok(());
    }
    create_workspace_path_impl(&WorkspacePathCreateRequest {
        workspace_path: workspace.to_string_lossy().to_string(),
        path: MEMORY_DIRECTORY.to_string(),
        kind: "directory".to_string(),
    })?;
    Ok(())
}

fn ensure_memory_is_small(content: &str) -> anyhow::Result<()> {
    if content.len() > MAX_MEMORY_FILE_BYTES {
        anyhow::bail!("project memory would exceed its size limit");
    }
    if memory_entries(content).len() > MAX_MEMORY_ENTRIES {
        anyhow::bail!(
            "project memory would hold more than {MAX_MEMORY_ENTRIES} entries; forget some first"
        );
    }
    Ok(())
}

/// Entries are the `- DATE — text` lines; anything else in the file is left
/// alone, so a person can keep their own prose above or below.
fn memory_entries(content: &str) -> Vec<Value> {
    content
        .lines()
        .filter_map(split_entry)
        .map(|(date, text)| json!({ "date": date, "text": text }))
        .collect()
}

/// One `- DATE — text` line, as `(date, text)`. A plain `- text` line keeps an
/// empty date, and anything that is not a bullet is not an entry at all.
fn split_entry(line: &str) -> Option<(&str, &str)> {
    let entry = line.trim().strip_prefix("- ")?;
    Some(match entry.split_once(" — ") {
        Some((date, text)) if looks_like_date(date) => (date, text.trim()),
        _ => ("", entry.trim()),
    })
}

fn looks_like_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
}

fn append_entry(content: &str, line: &str) -> String {
    if content.trim().is_empty() {
        return format!("{MEMORY_HEADER}{line}\n");
    }
    format!("{}\n{line}\n", content.trim_end())
}

/// Forgetting is refused unless exactly one entry matches, so a vague word
/// cannot quietly delete several memories.
fn forget_entry(content: &str, needle: &str) -> anyhow::Result<String> {
    let needle = needle.trim();
    if needle.is_empty() {
        anyhow::bail!("capability argument `match` is required");
    }
    let matches = |line: &str| split_entry(line).is_some_and(|(_, text)| text.contains(needle));
    let matched = content.lines().filter(|line| matches(line)).count();
    match matched {
        0 => anyhow::bail!("no project memory entry matches `{needle}`"),
        1 => {}
        count => anyhow::bail!(
            "{count} project memory entries match `{needle}`; use a longer, more specific match"
        ),
    }
    let mut removed = false;
    let kept = content
        .lines()
        .filter(|line| {
            if removed || !matches(line) {
                return true;
            }
            removed = true;
            false
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(format!("{kept}\n"))
}

/// One entry is one line, so newlines and runs of whitespace collapse into a
/// single space instead of splitting the entry in two.
fn normalize_entry_text(value: &str) -> anyhow::Result<String> {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        anyhow::bail!("capability argument `text` is required");
    }
    if collapsed.chars().count() > MAX_MEMORY_ENTRY_CHARS {
        anyhow::bail!("a memory entry is limited to {MAX_MEMORY_ENTRY_CHARS} characters");
    }
    Ok(collapsed)
}

fn today() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

/// Tool schemas live here so `lib.rs` keeps a single delegation guard instead
/// of one arm per capability.
pub(super) fn schema(id: CapabilityId) -> Option<(Value, Vec<&'static str>)> {
    let (properties, required) = match id {
        CapabilityId::MemoryRead => (
            json!({
                "raw": { "type": "boolean", "description": "Also return the memory file as written." }
            }),
            vec![],
        ),
        CapabilityId::MemoryWrite => (
            json!({
                "action": {
                    "type": "string",
                    "enum": ["append", "forget"],
                    "description": "append adds one entry; forget removes the single entry matching `match`."
                },
                "text": { "type": "string", "description": "The entry to remember, as one line. Required for append." },
                "match": { "type": "string", "description": "Text that identifies exactly one existing entry. Required for forget." }
            }),
            vec!["action"],
        ),
        _ => return None,
    };
    Some((properties, required))
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn schemas_require_the_arguments_each_tool_needs() {
        let (properties, required) = schema(CapabilityId::MemoryWrite).unwrap();
        assert!(properties["action"].is_object());
        assert_eq!(required, vec!["action"]);
        let (_, required) = schema(CapabilityId::MemoryRead).unwrap();
        assert!(required.is_empty());
        assert!(schema(CapabilityId::WorkspaceRead).is_none());
    }
}
