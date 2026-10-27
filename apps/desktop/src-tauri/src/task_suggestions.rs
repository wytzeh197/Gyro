//! Separate work a reply offers to start in a chat of its own.
//!
//! The model ends a reply with one hidden `GYRO_TASKS:` line; the control
//! marker pass cuts it out and this module keeps only well-formed tasks, so
//! the renderer never sees a card it cannot start.
use gyro_core::{SessionEventKind, SessionStore};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;

pub(crate) const GYRO_TASKS_MARKER: &str = "GYRO_TASKS:";

/// Matches the renderer: more than two cards under a reply reads as clutter.
const MAX_TASKS: usize = 2;
const MAX_TITLE_CHARS: usize = 120;
const MAX_WHY_CHARS: usize = 240;
const MAX_PROMPT_CHARS: usize = 4_000;

pub(crate) const TASK_SUGGESTION_INSTRUCTION: &str = "When your work surfaces a separate piece of work that clearly does not belong in this chat, such as a different bug or a follow-up worth its own investigation, you may offer it as a new chat with one hidden line at the end of the reply: GYRO_TASKS: {\"tasks\":[{\"title\":\"Short imperative title\",\"why\":\"One line on why it is separate\",\"prompt\":\"Self-contained first message for the new chat\"}]}. At most 2 tasks, only for clearly separate work, never for what the user asked you to do now and never instead of finishing it. Keep the JSON on one line.";

/// The tasks worth a card, or `None` when the marker held nothing usable.
pub(crate) fn normalize_tasks(value: &Value) -> Option<Value> {
    let items = value
        .get("tasks")
        .and_then(Value::as_array)
        .or_else(|| value.as_array())?;
    let tasks: Vec<Value> = items
        .iter()
        .filter_map(|item| {
            let title = text_field(item, "title", MAX_TITLE_CHARS)?;
            let prompt = text_field(item, "prompt", MAX_PROMPT_CHARS)?;
            let mut task = json!({ "title": title, "prompt": prompt });
            if let Some(why) = text_field(item, "why", MAX_WHY_CHARS) {
                task["why"] = Value::String(why);
            }
            Some(task)
        })
        .take(MAX_TASKS)
        .collect();
    (!tasks.is_empty()).then_some(Value::Array(tasks))
}

fn text_field(item: &Value, key: &str, max_chars: usize) -> Option<String> {
    let text = item.get(key)?.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    Some(if text.chars().count() > max_chars {
        let cut: String = text.chars().take(max_chars - 1).collect();
        format!("{}…", cut.trim_end())
    } else {
        text.to_string()
    })
}

/// How many recent chats the new-chat screen looks through.
pub(crate) const START_SCAN_CHATS: usize = 8;
/// Recent events kept from each of those chats.
pub(crate) const START_SCAN_EVENTS: usize = 60;
/// Suggestions older than this are not offered again.
pub(crate) const START_MAX_AGE_MS: i64 = 14 * 24 * 60 * 60 * 1000;
/// Rows the new-chat screen shows.
pub(crate) const START_SUGGESTION_LIMIT: usize = 3;
const START_REPLY_CHARS: usize = 2_000;

/// One pending task for the new-chat screen, newest suggestion first.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartTaskSuggestion {
    pub id: String,
    pub title: String,
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
    pub source_session_id: String,
    pub source_title: String,
    /// The suggesting reply, capped, so the new chat can quote it.
    pub reply: String,
    #[serde(skip)]
    created_at_ms: i64,
}

/// A reply that may carry `payload.tasks`, already loaded by the caller.
pub(crate) struct StartTaskSource {
    pub event_id: String,
    pub created_at_ms: i64,
    pub message: String,
    pub tasks: Value,
    pub source_session_id: String,
    pub source_title: String,
}

/// Pending tasks across recent replies.
///
/// Newest suggestion wins, including over an older one in a chat that was
/// touched more recently. The same title is offered once. `exclude` holds
/// tasks this window already started or dismissed. Ids stay
/// `{event id}:{index}` so they match the cards under the reply.
pub(crate) fn select_start_tasks(
    sources: &[StartTaskSource],
    exclude: &HashSet<String>,
    now_ms: i64,
    limit: usize,
) -> Vec<StartTaskSuggestion> {
    let oldest = now_ms.saturating_sub(START_MAX_AGE_MS);
    let mut best: Vec<StartTaskSuggestion> = Vec::new();
    let mut keys: Vec<String> = Vec::new();
    for source in sources {
        if source.created_at_ms < oldest {
            continue;
        }
        let Some(items) = source.tasks.as_array() else {
            continue;
        };
        for (index, item) in items.iter().enumerate() {
            let Some(title) = item.get("title").and_then(Value::as_str) else {
                continue;
            };
            let Some(prompt) = item.get("prompt").and_then(Value::as_str) else {
                continue;
            };
            let title = title.trim();
            let prompt = prompt.trim();
            if title.is_empty() || prompt.is_empty() {
                continue;
            }
            let id = format!("{}:{index}", source.event_id);
            if exclude.contains(&id) {
                continue;
            }
            let key = suggestion_key(title);
            let why = item
                .get("why")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string);
            let suggestion = StartTaskSuggestion {
                id,
                title: title.to_string(),
                prompt: prompt.to_string(),
                why,
                source_session_id: source.source_session_id.clone(),
                source_title: source.source_title.clone(),
                reply: cap_reply(&source.message),
                created_at_ms: source.created_at_ms,
            };
            if let Some(slot) = keys.iter().position(|existing| existing == &key) {
                if suggestion.created_at_ms > best[slot].created_at_ms {
                    best[slot] = suggestion;
                }
                continue;
            }
            keys.push(key);
            best.push(suggestion);
        }
    }
    best.sort_by(|left, right| {
        right
            .created_at_ms
            .cmp(&left.created_at_ms)
            .then_with(|| left.id.cmp(&right.id))
    });
    best.truncate(limit);
    best
}

fn suggestion_key(title: &str) -> String {
    title.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

fn cap_reply(message: &str) -> String {
    if message.chars().count() <= START_REPLY_CHARS {
        return message.to_string();
    }
    message.chars().take(START_REPLY_CHARS).collect()
}

/// Tasks the project's recent chats suggested and nobody has cleared.
pub(crate) fn list_start_task_suggestions_blocking(
    workspace_path: &str,
    exclude_ids: &[String],
) -> Result<Vec<StartTaskSuggestion>, String> {
    if workspace_path.is_empty() {
        return Ok(Vec::new());
    }
    let store = super::open_store()?;
    collect_start_tasks(&store, workspace_path, exclude_ids)
}

fn collect_start_tasks(
    store: &SessionStore,
    workspace_path: &str,
    exclude_ids: &[String],
) -> Result<Vec<StartTaskSuggestion>, String> {
    let requested = std::path::Path::new(workspace_path);
    let now_ms = chrono::Utc::now().timestamp_millis();
    let oldest = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(
        now_ms.saturating_sub(START_MAX_AGE_MS),
    );
    let mut sessions = store.list_sessions().map_err(super::to_string)?;
    sessions.retain(|session| {
        session.parent_session_id.is_none()
            && session.workspace_path == requested
            && oldest.is_some_and(|cutoff| session.updated_at >= cutoff)
    });
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    sessions.truncate(START_SCAN_CHATS);

    let mut sources = Vec::new();
    for session in sessions {
        let events = match store.read_recent_events(session.id, START_SCAN_EVENTS) {
            Ok(events) => events,
            Err(_) => continue,
        };
        for event in events {
            if event.kind != SessionEventKind::AssistantMessage {
                continue;
            }
            let Some(tasks) = event.payload.get("tasks").cloned() else {
                continue;
            };
            if tasks.is_null() {
                continue;
            }
            sources.push(StartTaskSource {
                event_id: event.id.to_string(),
                created_at_ms: event.created_at.timestamp_millis(),
                message: event.message,
                tasks,
                source_session_id: session.id.to_string(),
                source_title: session.title.clone(),
            });
        }
    }
    let exclude = exclude_ids.iter().cloned().collect();
    Ok(select_start_tasks(
        &sources,
        &exclude,
        now_ms,
        START_SUGGESTION_LIMIT,
    ))
}

#[tauri::command]
pub(crate) async fn list_start_task_suggestions(
    workspace_path: String,
    exclude_ids: Option<Vec<String>>,
) -> Result<Vec<StartTaskSuggestion>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        list_start_task_suggestions_blocking(
            &workspace_path,
            &exclude_ids.unwrap_or_default(),
        )
    })
    .await
    .map_err(|error| format!("start task suggestion worker failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_at_most_two_complete_tasks() {
        let tasks = normalize_tasks(&json!({
            "tasks": [
                { "title": "No prompt" },
                { "title": " Sample the hang ", "prompt": "Find why.", "why": "Separate." },
                { "title": "Second", "prompt": "Do it." },
                { "title": "Third", "prompt": "Too many." }
            ]
        }))
        .expect("tasks");
        let tasks = tasks.as_array().expect("array");
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0]["title"], "Sample the hang");
        assert_eq!(tasks[0]["why"], "Separate.");
        assert!(tasks[1].get("why").is_none());
    }

    #[test]
    fn rejects_markers_without_usable_tasks() {
        assert!(normalize_tasks(&json!({ "tasks": [] })).is_none());
        assert!(normalize_tasks(&json!({ "tasks": [{ "title": "", "prompt": "x" }] })).is_none());
        assert!(normalize_tasks(&json!("not tasks")).is_none());
    }

    #[test]
    fn marker_leaves_the_reply_and_lands_in_tasks() {
        let raw = "Fixed the fade.\nGYRO_TASKS: {\"tasks\":[{\"title\":\"Sample the hang\",\"prompt\":\"Find why.\"}]}";
        let stripped = crate::strip_hidden_control_markers(raw);
        assert_eq!(stripped.message, "Fixed the fade.");
        assert_eq!(
            stripped.tasks.expect("tasks")[0]["title"],
            "Sample the hang"
        );

        let broken = crate::strip_hidden_control_markers("Done.\nGYRO_TASKS: {not json");
        assert_eq!(broken.message, "Done.");
        assert!(broken.tasks.is_none());
    }

    #[test]
    fn caps_long_titles() {
        let tasks =
            normalize_tasks(&json!([{ "title": "x".repeat(400), "prompt": "p" }])).expect("tasks");
        assert_eq!(
            tasks[0]["title"].as_str().unwrap().chars().count(),
            MAX_TITLE_CHARS
        );
    }

    fn source(event_id: &str, at: i64, title: &str, chat: &str) -> StartTaskSource {
        StartTaskSource {
            event_id: event_id.into(),
            created_at_ms: at,
            message: format!("reply {event_id}"),
            tasks: json!([{ "title": title, "prompt": format!("Do {title}"), "why": "Separate." }]),
            source_session_id: chat.into(),
            source_title: chat.into(),
        }
    }

    #[test]
    fn prefers_the_newer_suggestion_over_the_busier_chat() {
        let now = 1_000_000_i64;
        let rows = select_start_tasks(
            &[
                source("busy", now - 10_000, "Old follow-up", "busy chat"),
                source("quiet", now - 1_000, "Fresh follow-up", "quiet chat"),
            ],
            &HashSet::new(),
            now,
            3,
        );
        assert_eq!(rows[0].title, "Fresh follow-up");
        assert_eq!(rows[1].title, "Old follow-up");
        assert_eq!(rows[0].id, "quiet:0");
    }

    #[test]
    fn keeps_one_row_for_a_repeated_title_and_skips_cleared_ids() {
        let now = 1_000_000_i64;
        let mut older = source("old", now - 5_000, "Fix the fade", "chat a");
        older.tasks = json!([
            { "title": "Fix the fade", "prompt": "Old prompt" },
            { "title": "Sample the hang", "prompt": "Find why." },
        ]);
        let newer = source("new", now - 100, "fix   the fade", "chat b");
        let rows = select_start_tasks(
            &[older, newer, source("gone", now - 50, "Sample the hang", "chat c")],
            &HashSet::from(["gone:0".into()]),
            now,
            3,
        );
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "new:0");
        assert_eq!(rows[0].prompt, "Do fix   the fade");
        assert_eq!(rows[1].title, "Sample the hang");
        assert_eq!(rows[1].id, "old:1");
    }

    #[test]
    fn drops_suggestions_older_than_the_window() {
        let now = 10_000_000_i64;
        let rows = select_start_tasks(
            &[source("stale", now - START_MAX_AGE_MS - 1, "Too old", "chat")],
            &HashSet::new(),
            now,
            3,
        );
        assert!(rows.is_empty());
    }
}
