use crate::{
    delegated_agents, goal_runner,
    providers::{
        chat_types::ProviderChatRequest, streaming::StreamingCommandState, types::ProviderActivity,
    },
    sessions::titles::is_generic_session_title,
    state::managers::ProviderCancellationManager,
    stores::{open_store, parse_uuid},
    task_suggestions,
};
use tauri::{Emitter, Manager};
pub(crate) struct SessionTitleExtraction {
    pub(crate) title: Option<String>,
    #[cfg(test)]
    pub(crate) message: String,
}

#[cfg(test)]
pub(crate) struct PlanUpdateExtraction {
    pub(crate) payload: Option<serde_json::Value>,
    #[cfg(test)]
    pub(crate) message: String,
}

pub(crate) struct ChatArtifactExtraction {
    pub(crate) items: Vec<serde_json::Value>,
    pub(crate) message: String,
}

#[cfg(test)]
pub(crate) fn extract_plan_update_marker(response: &str) -> PlanUpdateExtraction {
    let stripped = strip_hidden_control_markers(response);
    PlanUpdateExtraction {
        payload: stripped.plan_updates.into_iter().next(),
        message: stripped.message,
    }
}

pub(crate) fn extract_chat_artifact_marker(response: &str) -> ChatArtifactExtraction {
    let stripped = strip_hidden_control_markers(response);
    ChatArtifactExtraction {
        items: stripped.artifacts,
        message: stripped.message,
    }
}

/// Apply every model-authored progress report in order; the closing reply wins.
/// Tool output is untrusted and cannot update the plan.
pub(crate) fn completed_plan_updates(
    activities: &[ProviderActivity],
    final_updates: Vec<serde_json::Value>,
) -> Vec<serde_json::Value> {
    activities
        .iter()
        .filter(|activity| activity.kind == "commentary")
        .flat_map(|activity| strip_hidden_control_markers(&activity.label).plan_updates)
        .chain(final_updates)
        .collect()
}

/// Retain intermediate artifacts and their latest revision without promoting
/// their commentary to the closing reply. Final-message revisions win.
pub(crate) fn completed_chat_artifacts(
    activities: &[ProviderActivity],
    final_artifacts: Vec<serde_json::Value>,
) -> Vec<serde_json::Value> {
    let mut artifacts: Vec<serde_json::Value> = Vec::new();
    for candidate in activities
        .iter()
        .filter(|activity| activity.kind == "commentary")
        .flat_map(|activity| extract_chat_artifact_marker(&activity.label).items)
        .chain(final_artifacts)
    {
        if let Some(index) = artifacts
            .iter()
            .position(|item| item.get("id") == candidate.get("id"))
        {
            artifacts[index] = candidate;
        } else if artifacts.len() < MAX_CHAT_ARTIFACTS {
            artifacts.push(candidate);
        }
    }
    artifacts
}

pub(crate) fn valid_chat_artifact(value: &serde_json::Value) -> bool {
    const ALLOWED_KINDS: &[&str] = &[
        "canvas",
        "decision",
        "command",
        "completion",
        "workspace",
        "preview",
        "table",
        "diagram",
        "memory",
    ];
    let Some(object) = value.as_object() else {
        return false;
    };
    let bounded_string = |key: &str, max: usize| {
        object
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty() && text.chars().count() <= max)
    };
    let Some(kind) = bounded_string("kind", 24) else {
        return false;
    };
    if !ALLOWED_KINDS.contains(&kind)
        || bounded_string("id", 120).is_none()
        || bounded_string("title", 200).is_none()
    {
        return false;
    }
    if serde_json::to_vec(value).map_or(true, |encoded| encoded.len() > 16 * 1024) {
        return false;
    }
    match kind {
        "canvas" => {
            bounded_string("content", 12_000).is_some()
                && matches!(bounded_string("format", 12), Some("text" | "code" | "html"))
        }
        "decision" => value
            .get("options")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|options| !options.is_empty() && options.len() <= 5),
        "command" => bounded_string("command", 4_000).is_some(),
        "completion" => bounded_string("summary", 4_000).is_some(),
        "workspace" => value
            .get("files")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|files| !files.is_empty() && files.len() <= 30),
        "preview" => object.contains_key("url") || object.contains_key("description"),
        "table" => {
            value
                .get("columns")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|columns| !columns.is_empty() && columns.len() <= 12)
                && value
                    .get("rows")
                    .and_then(serde_json::Value::as_array)
                    .is_some_and(|rows| rows.len() <= 100)
        }
        "diagram" => value
            .get("nodes")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|nodes| !nodes.is_empty() && nodes.len() <= 40),
        "memory" => {
            bounded_string("content", 4_000).is_some()
                && matches!(
                    bounded_string("operation", 12),
                    Some("save" | "edit" | "forget")
                )
        }
        _ => false,
    }
}

// Partial marker lines must never rename a session to a truncated title.
pub(crate) fn completed_stream_title(text: &str, message_complete: bool) -> Option<String> {
    let marker = text.find(GYRO_SESSION_TITLE_MARKER)?;
    let line = &text[marker + GYRO_SESSION_TITLE_MARKER.len()..];
    let end = line.find('\n');
    if end.is_none() && !message_complete {
        return None;
    }
    sanitize_session_title_candidate(&line[..end.unwrap_or(line.len())])
}

pub(crate) struct VisibleStreamText {
    pub(crate) visible: String,
    pub(crate) title: Option<String>,
}

/// Split one streamed chunk into text the chat may show and a session title.
///
/// The title line is a backend instruction. It is removed before anything is
/// stored or emitted, including when it is glued onto the narration in front
/// of it. A chunk that ends in the middle of the marker, or in the middle of
/// the title line, stays in `hold` until the line finishes or the text block
/// closes.
pub(crate) fn take_visible_stream_text(
    hold: &mut String,
    delta: &str,
    close_line: bool,
) -> VisibleStreamText {
    let mut buffer = String::with_capacity(hold.len() + delta.len());
    buffer.push_str(hold);
    buffer.push_str(delta);
    hold.clear();
    let mut visible = String::new();
    let mut title = None;
    loop {
        if let Some(at) = buffer.find(GYRO_SESSION_TITLE_MARKER) {
            visible.push_str(&buffer[..at]);
            let after_start = at + GYRO_SESSION_TITLE_MARKER.len();
            let after = &buffer[after_start..];
            if let Some(end) = after.find('\n') {
                if title.is_none() {
                    title = sanitize_session_title_candidate(&after[..end]);
                }
                buffer = buffer[after_start + end + 1..].to_string();
                continue;
            }
            if close_line {
                if title.is_none() {
                    title = sanitize_session_title_candidate(after);
                }
                break;
            }
            *hold = buffer[at..].to_string();
            break;
        }
        let keep = if close_line {
            0
        } else {
            trailing_session_title_prefix_len(&buffer)
        };
        let split = buffer.len() - keep;
        visible.push_str(&buffer[..split]);
        *hold = buffer[split..].to_string();
        break;
    }
    if title.is_some() && visible.trim().is_empty() {
        visible.clear();
    }
    VisibleStreamText { visible, title }
}

pub(crate) fn trailing_session_title_prefix_len(text: &str) -> usize {
    let marker = GYRO_SESSION_TITLE_MARKER.as_bytes();
    let bytes = text.as_bytes();
    let max = marker.len().saturating_sub(1).min(bytes.len());
    for len in (1..=max).rev() {
        if marker.starts_with(&bytes[bytes.len() - len..]) {
            return len;
        }
    }
    0
}

pub(crate) fn publish_stream_session_title(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    stream_state: &StreamingCommandState,
    message_complete: bool,
) {
    if let Some(title) = stream_state.captured_session_title.as_deref() {
        let line = format!("{GYRO_SESSION_TITLE_MARKER} {title}\n");
        publish_streamed_session_title(app, request, &line, true);
    }
    publish_streamed_session_title(app, request, &stream_state.assistant_text, message_complete);
}

/// The title control a turn starts with: open, expecting the title Gyro just
/// stored, so the model's own `GYRO_SESSION_TITLE` line may replace it once.
pub(crate) fn suggested_title_for_turn(title: &str) -> (Option<String>, bool) {
    (Some(title.to_string()), false)
}

/// Whether the model's title may replace the stored title right now.
///
/// Closed control, no opening turn, and a title that changed under the model
/// all refuse. A rename the user made by hand wins and closes the control for
/// the rest of the run, so a later stream tick cannot overwrite it either.
pub(crate) fn streamed_title_replacement(
    state: &mut (Option<String>, bool),
    stored_title: &str,
    text: &str,
    message_complete: bool,
) -> Option<String> {
    if state.1 {
        return None;
    }
    let Some(expected_title) = state.0.as_deref() else {
        return None;
    };
    let Some(title) = completed_stream_title(text, message_complete) else {
        return None;
    };
    if stored_title != expected_title {
        // The window writes its own provisional title from the message while
        // the turn starts, so the stored title can differ from the baseline
        // this turn captured. A placeholder is still Gyro's, not a rename the
        // user made by hand, so the model may replace it.
        if is_generic_session_title(stored_title) {
            state.0 = Some(stored_title.to_string());
        } else {
            state.1 = true;
            return None;
        }
    }
    Some(title)
}

pub(crate) fn publish_streamed_session_title(
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    text: &str,
    message_complete: bool,
) {
    if !request.suggest_title {
        return;
    }
    let Some(control) = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .and_then(|flags| flags.get(&request.session_id).cloned())
    else {
        return;
    };
    let Ok(mut state) = control.suggested_title.lock() else {
        return;
    };
    if state.1 || state.0.is_none() {
        return;
    }
    let Ok(store) = open_store() else {
        return;
    };
    let Ok(session_id) = parse_uuid(&request.session_id) else {
        return;
    };
    let Ok(Some(session)) = store.get_session(session_id) else {
        return;
    };
    let Some(title) =
        streamed_title_replacement(&mut state, &session.title, text, message_complete)
    else {
        return;
    };
    if let Ok(Some(session)) =
        store.apply_session_title(session_id, state.0.as_deref().unwrap_or_default(), &title)
    {
        state.1 = true;
        let _ = app.emit("gyro://session-title-updated", session);
    }
}

#[cfg(test)]
pub(crate) fn extract_session_title_marker(
    response: &str,
    allow_title: bool,
) -> SessionTitleExtraction {
    // Always strip the marker from the visible reply. Title application is
    // optional; leaving the protocol token in the bubble is never correct.
    let stripped = strip_hidden_control_markers(response);
    SessionTitleExtraction {
        title: if allow_title {
            stripped.session_title
        } else {
            None
        },
        message: stripped.message,
    }
}

/// Control markers Claude may emit for Gyro-only side channels.
///
/// They are meant to sit on their own line before the visible answer. When a
/// turn streams several text blocks and those blocks are concatenated without a
/// separator, the marker lands mid-line (`callback:GYRO_SESSION_TITLE: …`) and
/// a line-prefix stripper misses it. This walks the whole response and removes
/// every occurrence, even mid-line, so the protocol never reaches the bubble.
pub(crate) struct StrippedControlMarkers {
    pub(crate) message: String,
    pub(crate) session_title: Option<String>,
    pub(crate) plan_updates: Vec<serde_json::Value>,
    pub(crate) goal_update: Option<serde_json::Value>,
    pub(crate) agent_update: Option<serde_json::Value>,
    pub(crate) questions: Option<serde_json::Value>,
    pub(crate) tasks: Option<serde_json::Value>,
    pub(crate) artifacts: Vec<serde_json::Value>,
}

pub(crate) const GYRO_SESSION_TITLE_MARKER: &str = "GYRO_SESSION_TITLE:";
pub(crate) const GYRO_PLAN_UPDATE_MARKER: &str = "GYRO_PLAN_UPDATE:";
pub(crate) const GYRO_GOAL_UPDATE_MARKER: &str = "GYRO_GOAL_UPDATE:";
pub(crate) const GYRO_AGENT_UPDATE_MARKER: &str = "GYRO_AGENT_UPDATE:";
pub(crate) const GYRO_ARTIFACTS_MARKER: &str = "GYRO_ARTIFACTS:";
pub(crate) const GYRO_QUESTIONS_MARKER: &str = "GYRO_QUESTIONS:";
pub(crate) const MAX_CHAT_ARTIFACTS: usize = 8;
pub(crate) const MAX_CHAT_ARTIFACT_MARKER_BYTES: usize = 64 * 1024;

pub(crate) fn strip_hidden_control_markers(response: &str) -> StrippedControlMarkers {
    // Repair glued blocks first so a marker that opens a block after
    // `edits.Now…GYRO_…` is more likely to sit where a line scanner can see it;
    // mid-line stripping below still catches markers that remain embedded.
    let normalized = repair_glued_assistant_blocks(&response.replace("\r\n", "\n"));
    let mut session_title = None;
    let mut plan_updates = Vec::new();
    let mut goal_update = None;
    let mut agent_update = None;
    let mut questions = None;
    let mut tasks = None;
    let mut artifacts = Vec::new();
    let mut kept_lines = Vec::new();

    for line in normalized.lines() {
        let cleaned = strip_control_markers_from_line(
            line,
            &mut session_title,
            &mut plan_updates,
            &mut goal_update,
            &mut agent_update,
            &mut questions,
            &mut tasks,
            &mut artifacts,
        );
        if cleaned.trim().is_empty() {
            if line.is_empty() {
                // Preserve intentional paragraph breaks between text blocks.
                kept_lines.push(String::new());
            }
            // Pure marker lines, or lines that only held a glued marker, drop.
            continue;
        }
        kept_lines.push(cleaned);
    }

    // Dropping a pure marker line that sat between paragraph breaks can leave
    // three newlines in a row; collapse those so the bubble does not grow
    // extra empty space where the protocol line used to be.
    let message = collapse_extra_blank_lines(&kept_lines.join("\n"))
        .trim()
        .to_string();

    StrippedControlMarkers {
        message,
        session_title,
        plan_updates,
        goal_update,
        agent_update,
        questions,
        tasks,
        artifacts,
    }
}

pub(crate) fn collapse_extra_blank_lines(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut newline_run = 0usize;
    for ch in text.chars() {
        if ch == '\n' {
            newline_run += 1;
            if newline_run <= 2 {
                out.push(ch);
            }
        } else {
            newline_run = 0;
            out.push(ch);
        }
    }
    out
}

pub(crate) fn strip_control_markers_from_line(
    line: &str,
    session_title: &mut Option<String>,
    plan_updates: &mut Vec<serde_json::Value>,
    goal_update: &mut Option<serde_json::Value>,
    agent_update: &mut Option<serde_json::Value>,
    questions: &mut Option<serde_json::Value>,
    tasks: &mut Option<serde_json::Value>,
    artifacts: &mut Vec<serde_json::Value>,
) -> String {
    let mut rest = line;
    let mut kept = String::new();
    let mut removed_marker = false;
    while let Some((marker, at)) = next_control_marker(rest) {
        removed_marker = true;
        kept.push_str(&rest[..at]);
        let after_marker = &rest[at + marker.len()..];
        match marker {
            GYRO_SESSION_TITLE_MARKER => {
                // Title is free text to the end of the line.
                if session_title.is_none() {
                    *session_title = sanitize_session_title_candidate(after_marker);
                }
                rest = "";
            }
            GYRO_PLAN_UPDATE_MARKER => {
                match take_leading_json_value(after_marker.trim_start()) {
                    Some((value, remainder)) if value.is_object() => {
                        plan_updates.push(value);
                        rest = remainder;
                    }
                    _ => {
                        // Unparseable payload: drop the rest of the line so a
                        // broken marker never shows in the bubble.
                        rest = "";
                    }
                }
            }
            GYRO_GOAL_UPDATE_MARKER => match take_leading_json_value(after_marker.trim_start()) {
                Some((value, remainder)) if value.is_object() => {
                    if let Some(update) = goal_runner::normalize_update(&value) {
                        // The final checkpoint supersedes earlier narration.
                        *goal_update = Some(update);
                    }
                    rest = remainder;
                }
                _ => {
                    rest = "";
                }
            },
            GYRO_AGENT_UPDATE_MARKER => match take_leading_json_value(after_marker.trim_start()) {
                Some((value, remainder)) => {
                    if agent_update.is_none() {
                        *agent_update = delegated_agents::completion_update(&value);
                    }
                    rest = remainder;
                }
                None => rest = "",
            },
            GYRO_QUESTIONS_MARKER => match take_leading_json_value(after_marker.trim_start()) {
                Some((value, remainder)) if value.is_object() => {
                    if questions.is_none() {
                        *questions = Some(value);
                    }
                    rest = remainder;
                }
                _ => {
                    rest = "";
                }
            },
            task_suggestions::GYRO_TASKS_MARKER => {
                match take_leading_json_value(after_marker.trim_start()) {
                    Some((value, remainder)) => {
                        if tasks.is_none() {
                            *tasks = task_suggestions::normalize_tasks(&value);
                        }
                        rest = remainder;
                    }
                    None => rest = "",
                }
            }
            GYRO_ARTIFACTS_MARKER => match take_leading_json_value(after_marker.trim_start()) {
                Some((value, remainder)) => {
                    collect_chat_artifacts_from_value(value, artifacts);
                    rest = remainder;
                }
                None => {
                    rest = "";
                }
            },
            _ => unreachable!("unknown control marker"),
        }
    }
    kept.push_str(rest);
    if removed_marker {
        // Mid-line markers leave a hanging word boundary (`callback:`); trim
        // only when a marker was actually cut out of this line.
        trim_dangling_marker_prefix(&kept)
    } else {
        kept
    }
}

pub(crate) fn next_control_marker(text: &str) -> Option<(&'static str, usize)> {
    let candidates = [
        GYRO_SESSION_TITLE_MARKER,
        GYRO_PLAN_UPDATE_MARKER,
        GYRO_GOAL_UPDATE_MARKER,
        GYRO_AGENT_UPDATE_MARKER,
        GYRO_QUESTIONS_MARKER,
        task_suggestions::GYRO_TASKS_MARKER,
        GYRO_ARTIFACTS_MARKER,
    ];
    candidates
        .into_iter()
        .filter_map(|marker| text.find(marker).map(|at| (marker, at)))
        .min_by_key(|(_, at)| *at)
}

/// Read one JSON value from the start of `text`, returning it and the unparsed tail.
pub(crate) fn take_leading_json_value(text: &str) -> Option<(serde_json::Value, &str)> {
    if text.is_empty() || text.len() > MAX_CHAT_ARTIFACT_MARKER_BYTES {
        return None;
    }
    // StreamDeserializer exposes the consumed byte offset; a plain
    // Deserializer does not on the serde_json version Gyro pins.
    let mut stream = serde_json::Deserializer::from_str(text).into_iter::<serde_json::Value>();
    let value = stream.next()?.ok()?;
    let consumed = stream.byte_offset();
    // JSON tokens are ASCII-framed, so the byte offset is a char-safe split.
    Some((value, text.get(consumed..).unwrap_or("")))
}

pub(crate) fn collect_chat_artifacts_from_value(
    value: serde_json::Value,
    artifacts: &mut Vec<serde_json::Value>,
) {
    if artifacts.len() >= MAX_CHAT_ARTIFACTS {
        return;
    }
    let candidates = value
        .get("items")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .or_else(|| value.as_array().cloned())
        .unwrap_or_default();
    for candidate in candidates {
        if artifacts.len() >= MAX_CHAT_ARTIFACTS {
            break;
        }
        if valid_chat_artifact(&candidate) {
            artifacts.push(candidate);
        }
    }
}

/// Drop trailing `:` / punctuation left when a mid-line marker is removed.
pub(crate) fn trim_dangling_marker_prefix(text: &str) -> String {
    text.trim_end_matches(|ch: char| {
        matches!(ch, ':' | ';' | ',' | '—' | '-' | '–') || ch.is_whitespace()
    })
    .trim_end()
    .to_string()
}

/// Insert paragraph breaks where successive streamed blocks were glued.
///
/// Claude often opens a new text block after tools with a capital letter and
/// no leading newline. Concatenating deltas then yields `edits.Now the…`.
/// Matches the commentary repair: a sentence end hard against a new sentence
/// (`[.!?](?=[A-Z][a-z]|I['’])`), leaving versions and paths alone.
///
/// Optional markdown emphasis between the punctuation and the capital covers
/// providers that bold the next block (`is.**Gyro is…**`).
pub(crate) fn repair_glued_assistant_blocks(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len().saturating_add(8));
    for index in 0..chars.len() {
        out.push(chars[index]);
        if !matches!(chars[index], '.' | '!' | '?') {
            continue;
        }
        let mut look = index + 1;
        // Skip one run of * or _ so `is.**Gyro` still counts as glued.
        while matches!(chars.get(look), Some('*' | '_')) {
            look += 1;
        }
        let should_break = match (chars.get(look), chars.get(look + 1)) {
            (Some('I'), Some('\'' | '’')) => true,
            (Some(first), Some(second)) if first.is_uppercase() && second.is_lowercase() => true,
            _ => false,
        };
        if should_break {
            out.push_str("\n\n");
        }
    }
    out
}

pub(crate) fn sanitize_session_title_candidate(title: &str) -> Option<String> {
    let title = title
        .replace('\0', "")
        .chars()
        .map(|ch| {
            if matches!(
                ch,
                '`' | '*' | '_' | '#' | '[' | ']' | '(' | ')' | '{' | '}' | '<' | '>' | '|' | '\\'
            ) {
                ' '
            } else {
                ch
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|char: char| char.is_ascii_punctuation() || char.is_whitespace())
        .to_string();
    if title.is_empty() {
        return None;
    }
    let chars = title.chars().collect::<Vec<_>>();
    if chars.len() > 80 {
        return Some(chars.into_iter().take(77).collect::<String>() + "...");
    }
    Some(title)
}

pub(crate) fn derive_session_summary(response: &str) -> Option<String> {
    const MAX_SUMMARY_CHARS: usize = 420;
    let plain = response
        .lines()
        .map(str::trim)
        .filter(|line| {
            !line.is_empty()
                && !line.starts_with("GYRO_SESSION_TITLE:")
                && !line.starts_with("GYRO_PLAN_UPDATE:")
                && !line.starts_with("GYRO_GOAL_UPDATE:")
                && !line.starts_with("GYRO_QUESTIONS:")
                && !line.starts_with(task_suggestions::GYRO_TASKS_MARKER)
        })
        .map(|line| {
            line.trim_start_matches(['#', '-', '*', '>'])
                .trim()
                .replace('`', "")
        })
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if plain.is_empty() {
        return None;
    }
    let mut summary = plain.chars().take(MAX_SUMMARY_CHARS).collect::<String>();
    if plain.chars().count() > MAX_SUMMARY_CHARS {
        if let Some(boundary) = summary.rfind(char::is_whitespace) {
            summary.truncate(boundary);
        }
        summary.push_str("...");
    }
    Some(summary)
}
