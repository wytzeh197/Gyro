use crate::{
    extract_provider_activities, extract_provider_commentary_activity, provider_accounting,
    provider_context, provider_context_usage_from_codex_exec, provider_file_result_counts,
    provider_timeline,
    providers::{
        chat_types::ProviderChatRequest,
        events::{
            emit_provider_activity_event, emit_provider_chat_event_with_timeline,
            emit_provider_context_usage,
        },
        markers::publish_stream_session_title,
        streaming::{StreamingCommandOutput, StreamingCommandState},
        types::ProviderActivity,
    },
    text::{sanitize_provider_chat_response, sanitize_provider_text_delta, truncate_chars},
    usage::{fetch::publish_live_provider_usage, types::ProviderRateLimitWindow},
    ProviderContextUsage,
};
use gyro_core::{timing, timing::Stage as TimingStage, HarnessRunStatus};
use std::{collections::HashMap, path::Path, time::Instant};
pub(crate) fn handle_provider_stdout_line(
    line: &str,
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    stream_state: &mut StreamingCommandState,
) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
        return;
    };
    let previous_usage = stream_state.context_usage.clone();
    let previous_billed_usage = stream_state.billed_usage.clone();
    let previous_accounted_usage = stream_state.accounted_usage;
    handle_provider_stdout_value(&value, app, request, stream_state);
    if stream_state.accounted_usage != previous_accounted_usage {
        if let Some(tokens) = stream_state.accounted_usage {
            provider_accounting::emit_turn_tokens(app, request, tokens);
        }
    } else if stream_state.accounted_usage.is_none()
        && stream_state.billed_usage != previous_billed_usage
    {
        if let Some(usage) = &stream_state.billed_usage {
            provider_accounting::emit_turn_tokens(
                app,
                request,
                provider_accounting::usage_tokens(usage),
            );
        }
    }
    // Publish after the frame's text/tools so the UI checkpoint includes them.
    if stream_state.context_usage != previous_usage {
        if let Some(usage) = &stream_state.context_usage {
            emit_provider_context_usage(app, request, usage);
        }
    }
}

pub(crate) fn handle_provider_stdout_value(
    value: &serde_json::Value,
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    stream_state: &mut StreamingCommandState,
) {
    stream_state.parsed_stream_json = true;
    if value.get("type").and_then(serde_json::Value::as_str) == Some("system")
        && value.get("subtype").and_then(serde_json::Value::as_str) == Some("init")
    {
        timing::mark(TimingStage::ProtocolReady);
    }
    if stream_state.provider_session_id.is_none() {
        stream_state.provider_session_id = extract_provider_session_id(value);
    }
    if request.provider_id == "openai" {
        if let Some(billed) = provider_context_usage_from_codex_exec(value) {
            let tokens = provider_accounting::usage_tokens(&billed)
                .with_scope(gyro_core::usage::UsageScope::Turn);
            stream_state.billed_usage = Some(billed);
            stream_state.accounted_usage = Some(tokens);
            gyro_core::provider_observation::native_usage(tokens);
            // turn.completed is aggregate spend, not context occupancy.
        }
    } else if request.provider_id == "anthropic" {
        stream_state.claude_accounting.observe(value);
        stream_state.accounted_usage = stream_state.claude_accounting.tokens();
        if let Some(tokens) = stream_state.accounted_usage {
            gyro_core::provider_observation::native_usage(tokens);
            let known = tokens
                .accounting
                .map(|metadata| metadata.known)
                .unwrap_or_default();
            // The ceiling consumes numeric lower bounds, while exact bucket
            // coverage travels separately in accounted_usage.
            stream_state.billed_usage = Some(ProviderContextUsage {
                input_tokens: Some(tokens.input_tokens),
                cached_input_tokens: Some(
                    tokens
                        .cached_input_tokens
                        .saturating_add(tokens.cache_write_tokens),
                ),
                output_tokens: known.output.then_some(tokens.output_tokens),
                total_tokens: Some(tokens.total_tokens),
                ..ProviderContextUsage::default()
            });
        }
        if let Some(mut usage) = stream_state.claude_accounting.context_usage() {
            usage.model_context_window = provider_context::claude_stream_context_window(value)
                .or_else(|| {
                    stream_state
                        .context_usage
                        .as_ref()
                        .and_then(|current| current.model_context_window)
                });
            stream_state.context_usage = Some(usage);
            stream_state.context_usage_is_per_request = true;
        }
    } else if request.provider_id == "antigravity" {
        if let Some(usage) = provider_context::antigravity_step_occupancy(value) {
            stream_state.context_usage = Some(usage);
            stream_state.context_usage_is_per_request = true;
        }
    }
    if let Some(rate_limit) = provider_rate_limit_from_claude_stream(value) {
        // Once per window per turn: later announcements repeat the same news.
        let first_mention = !stream_state
            .rate_limits
            .iter()
            .any(|window| window.id == rate_limit.id);
        merge_provider_rate_limit(&mut stream_state.rate_limits, rate_limit);
        if first_mention {
            publish_live_provider_usage(app, &request.provider_id);
        }
    }
    if provider_stream_opens_text_content_block(value) {
        // A new block means the previous one closed, so a title marker that
        // ended it without a newline is complete.
        stream_state.close_session_title_hold();
        publish_stream_session_title(app, request, &stream_state, true);
        stream_state.note_new_text_content_block();
    }
    if let Some(commentary) = extract_provider_commentary_activity(value) {
        stream_state.flush_pending_delta(app, request, true);
        publish_stream_session_title(app, request, &stream_state, true);
        if let Some(activity) = stream_state.push_activity(commentary) {
            let activity_sequence = stream_state.activity_sequence(&activity);
            emit_provider_activity_event(app, request, &activity, Some(activity_sequence));
        }
        // Commentary is narration, not a tool, but it still sits between text
        // blocks when it appears as its own stream item.
        stream_state.note_intervening_work();
        return;
    }
    let activities = extract_provider_activities(value);
    // Only provider-reported edits belong to this chat. A shared file changing
    // while a command runs is not evidence that this command wrote it.
    if !activities.is_empty() {
        stream_state.flush_pending_delta(app, request, true);
        // Tools only start after the text block before them closed. Without
        // this, a marker line followed straight by a tool call left the
        // session untitled until the next text arrived, often minutes later.
        publish_stream_session_title(app, request, &stream_state, true);
        for activity in activities {
            if let Some(activity) = stream_state.push_activity(activity) {
                let activity_sequence = stream_state.activity_sequence(&activity);
                emit_provider_activity_event(app, request, &activity, Some(activity_sequence));
            }
        }
        stream_state.note_intervening_work();
    }
    for (id, counts) in provider_file_result_counts(value) {
        let Some(mut activity) = stream_state
            .activities
            .iter()
            .find(|activity| activity.id == id && activity.kind == "file")
            .cloned()
        else {
            continue;
        };
        activity.file_counts = Some(counts);
        if let Some(activity) = stream_state.push_activity(activity) {
            let activity_sequence = stream_state.activity_sequence(&activity);
            emit_provider_activity_event(app, request, &activity, Some(activity_sequence));
        }
    }
    if let Some(chunk) = extract_provider_text_chunk(value) {
        if stream_state.take_text_boundary(
            provider_timeline::text_has_boundary(app, &request.session_id),
            provider_timeline::item_count(app, &request.session_id),
        ) {
            // Broker calls can arrive while provider text awaits its flush.
            // Preserve the earlier block before buffering text after that call.
            stream_state.flush_pending_delta(app, request, true);
            stream_state.note_intervening_work();
        }
        let previous_text_len = stream_state.assistant_text.len();
        let previous_chunk_count = stream_state.pending_delta_chunks.len();
        match chunk {
            ProviderTextChunk::Delta(delta) => {
                let delta = sanitize_provider_text_delta(&delta);
                if delta.is_empty() {
                    return;
                }
                stream_state.push_assistant_delta(&delta);
            }
            ProviderTextChunk::Snapshot(snapshot) => {
                let snapshot = sanitize_provider_text_delta(&snapshot);
                stream_state.push_assistant_snapshot(&snapshot);
            }
            ProviderTextChunk::Final(text) => {
                // The completed message is the answer of record: apply it even
                // when text has already streamed, so a short stream is repaired
                // rather than persisted as the whole reply.
                let text = sanitize_provider_text_delta(&text);
                if text.is_empty() {
                    return;
                }
                stream_state.push_assistant_final(&text);
            }
        }
        if let Some(delta) = stream_state
            .assistant_text
            .get(previous_text_len..)
            .filter(|delta| !delta.is_empty())
        {
            let position = provider_timeline::observe(app, &request.session_id, None, Some(delta));
            if let Some((earlier_delta, earlier_position)) =
                stream_state.set_pending_timeline(position, previous_chunk_count)
            {
                stream_state.last_emit_at = Some(Instant::now());
                emit_provider_chat_event_with_timeline(
                    app,
                    request,
                    "delta",
                    Some(HarnessRunStatus::Running),
                    Some(earlier_delta),
                    None,
                    None,
                    Some(earlier_position),
                );
            }
        }
        publish_stream_session_title(app, request, &stream_state, false);
        stream_state.flush_pending_delta(app, request, false);
    }
}

/// True when Claude (or another Anthropic-shaped stream) opens a fresh text block.
pub(crate) fn provider_stream_opens_text_content_block(value: &serde_json::Value) -> bool {
    let event = value
        .get("type")
        .and_then(serde_json::Value::as_str)
        .and_then(|frame_type| {
            if frame_type == "stream_event" {
                value.get("event")
            } else {
                Some(value)
            }
        })
        .unwrap_or(value);
    event.get("type").and_then(serde_json::Value::as_str) == Some("content_block_start")
        && event
            .pointer("/content_block/type")
            .and_then(serde_json::Value::as_str)
            == Some("text")
}

/// Paragraph-separate a new streamed text block from the previous one when the
/// provider omitted a leading newline.
pub(crate) fn separate_streamed_text_block(existing: &str, delta: &str) -> Option<String> {
    if existing.is_empty() || delta.is_empty() {
        return None;
    }
    let existing_ends_break = existing.ends_with("\n\n")
        || existing.ends_with("\n")
        || existing.ends_with(char::is_whitespace);
    let delta_starts_break = delta.starts_with('\n') || delta.starts_with(char::is_whitespace);
    if existing_ends_break || delta_starts_break {
        return None;
    }
    Some(format!("\n\n{delta}"))
}

/// Read a plan limit out of Claude Code's `rate_limit_event` frame.
///
/// The frame names the window (`five_hour`, `weekly`, …), says whether the
/// account is inside it, and gives the reset time. It carries no used
/// percentage, so only an exhausted window resolves to a number — that one is
/// measured, not guessed. Overage counts as exhausted: the plan limit is spent
/// even though the request went through.
pub(crate) fn provider_rate_limit_from_claude_stream(
    value: &serde_json::Value,
) -> Option<ProviderRateLimitWindow> {
    if value.get("type").and_then(serde_json::Value::as_str) != Some("rate_limit_event") {
        return None;
    }
    let info = value.get("rate_limit_info")?;
    let raw_type = info
        .get("rateLimitType")
        .and_then(serde_json::Value::as_str)?;
    let (id, label) = provider_rate_limit_window_label(raw_type);
    let raw_status = info
        .get("status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("allowed");
    let using_overage = info
        .get("isUsingOverage")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or_default();
    let status = match raw_status {
        "rejected" | "blocked" => "exhausted",
        "warning" | "approaching_limit" => "warning",
        _ if using_overage => "exhausted",
        _ => "ok",
    };
    // Prefer an explicit utilization when Claude sends one; otherwise only an
    // exhausted window is a known number (100%). Unmeasured windows stay open
    // so the ledger fill can supply a local spend percentage without inventing
    // a plan reading.
    let used_percent =
        claude_rate_limit_used_percent(info).or_else(|| (status == "exhausted").then_some(100));
    Some(ProviderRateLimitWindow {
        id,
        label,
        status: status.into(),
        used_percent,
        resets_at: info
            .get("resetsAt")
            .and_then(serde_json::Value::as_i64)
            .and_then(|timestamp| chrono::DateTime::from_timestamp(timestamp, 0))
            .map(|timestamp| timestamp.to_rfc3339()),
    })
}

/// Read a 0–100 used % out of Claude's rate_limit_info when present.
pub(crate) fn claude_rate_limit_used_percent(info: &serde_json::Value) -> Option<i32> {
    for key in [
        "utilization",
        "usedPercent",
        "used_percent",
        "percentUsed",
        "percent_used",
    ] {
        let Some(value) = info.get(key) else { continue };
        if let Some(number) = value.as_f64() {
            // Claude has sent both 0–1 fractions and 0–100 percentages.
            let percent = if key == "utilization" && (0.0..=1.0).contains(&number) {
                (number * 100.0).round()
            } else {
                number.round()
            };
            return Some(percent.clamp(0.0, 100.0) as i32);
        }
        if let Some(number) = value.as_i64() {
            return Some(number.clamp(0, 100) as i32);
        }
    }
    None
}

/// Gyro's id and display label for a provider's window name.
///
/// Falls through to a humanised form of whatever the provider sent so a window
/// Gyro has not seen before still reaches the composer with a readable name
/// rather than being dropped.
pub(crate) fn provider_rate_limit_window_label(raw_type: &str) -> (String, String) {
    match raw_type {
        "five_hour" | "5_hour" | "session" => ("five-hour".into(), "5-hour limit".into()),
        // Same ids and labels as the account poll, so a streamed window and a
        // polled one merge into one row instead of listing the week twice.
        "weekly" | "seven_day" => ("weekly".into(), "Weekly limit".into()),
        "weekly_opus" | "seven_day_opus" => ("weekly-opus".into(), "Weekly · Opus".into()),
        "weekly_sonnet" | "seven_day_sonnet" => ("weekly-sonnet".into(), "Weekly · Sonnet".into()),
        other => {
            // Provider-controlled text: split on a char, never a byte index.
            let mut chars = other.chars();
            let first = chars.next().map(|c| c.to_uppercase().to_string());
            let label = format!("{}{} limit", first.unwrap_or_default(), chars.as_str());
            (other.replace('_', "-"), label.replace('_', " "))
        }
    }
}

/// Keep the newest reading for each window.
pub(crate) fn merge_provider_rate_limit(
    windows: &mut Vec<ProviderRateLimitWindow>,
    window: ProviderRateLimitWindow,
) {
    match windows.iter_mut().find(|existing| existing.id == window.id) {
        Some(existing) => *existing = window,
        None => windows.push(window),
    }
    // The shorter window is the one a run hits first, so it leads the list.
    windows.sort_by_key(|window| match window.id.as_str() {
        "five-hour" => 0,
        "weekly" => 1,
        _ => 2,
    });
}

/// Cap for the muted side of a rail row — long shell lines stay scannable.
pub(crate) const PROVIDER_ACTIVITY_NOTE_CHARS: usize = 240;

/// The muted half of a tool row: command, path, skill name, query — whatever
/// the provider put in `input` that is not the tool's own identity.
pub(crate) fn provider_tool_activity_note(name: &str, input: &serde_json::Value) -> Option<String> {
    if !input.is_object() {
        return None;
    }
    let preferred: &[&str] = match name {
        "Skill" | "skill" => &["skill", "skill_name", "skillName", "name"],
        "Bash" | "KillShell" => &["command", "description"],
        "Read" | "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => &[
            "file_path",
            "filePath",
            "path",
            "notebook_path",
            "notebookPath",
        ],
        "Grep" | "Glob" => &["pattern", "glob", "glob_pattern", "query"],
        "WebSearch" | "WebFetch" => &["query", "url"],
        // MCP / generic tools often put the target in one of these.
        _ => &[
            "command",
            "query",
            "path",
            "file_path",
            "filePath",
            "pattern",
            "url",
            "description",
            "skill",
            "skill_name",
            "skillName",
            "name",
            "title",
            "prompt",
            "message",
        ],
    };
    if let Some(value) = json_object_string(input, preferred) {
        // Don't echo the tool's own machine name as the note.
        if value.eq_ignore_ascii_case(name) {
            return None;
        }
        return Some(truncate_chars(&value, PROVIDER_ACTIVITY_NOTE_CHARS));
    }
    None
}

pub(crate) fn json_object_string(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    let object = value.as_object()?;
    for key in keys {
        if let Some(found) = object.get(*key).and_then(|entry| match entry {
            serde_json::Value::String(text) => {
                let trimmed = text.trim();
                (!trimmed.is_empty()).then(|| trimmed.to_string())
            }
            serde_json::Value::Number(number) => Some(number.to_string()),
            serde_json::Value::Bool(flag) => Some(flag.to_string()),
            _ => None,
        }) {
            return Some(found);
        }
    }
    None
}

pub(crate) fn json_string_or_joined(value: Option<&serde_json::Value>) -> Option<String> {
    match value? {
        serde_json::Value::String(value) => Some(value.clone()),
        serde_json::Value::Array(values) => {
            let joined = values
                .iter()
                .filter_map(|value| value.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            (!joined.is_empty()).then_some(joined)
        }
        _ => None,
    }
}

pub(crate) fn command_activity_label(command: &str) -> String {
    let normalized = command.to_ascii_lowercase();
    if normalized.contains("rg --files")
        || normalized.contains("find ")
        || normalized.contains(" ls ")
        || normalized.starts_with("ls ")
    {
        return "Listed files".into();
    }
    if normalized.contains(" rg ") || normalized.contains("rg -") || normalized.starts_with("rg ") {
        return "Searched project".into();
    }
    if normalized.contains("cat ")
        || normalized.contains("sed -n")
        || normalized.contains("head ")
        || normalized.contains("tail ")
    {
        if let Some(path) = command
            .split_whitespace()
            .rev()
            .map(|part| part.trim_matches(|ch: char| "'\";,()".contains(ch)))
            .find(|part| {
                part.contains('.') && !part.starts_with('-') && !part.chars().all(char::is_numeric)
            })
        {
            let file_name = Path::new(path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(path);
            return format!("Read {file_name}");
        }
        return "Read project files".into();
    }
    "Ran command".into()
}

pub(crate) fn provider_activity_path(item: &serde_json::Value) -> Option<String> {
    item.get("path")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .or_else(|| {
            item.get("changes")
                .and_then(|value| value.as_array())
                .and_then(|changes| changes.first())
                .and_then(|change| change.get("path"))
                .and_then(|value| value.as_str())
                .map(str::to_string)
        })
}

pub(crate) fn humanize_activity_name(value: &str) -> String {
    value
        .split(['_', '-'])
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) fn provider_activities_for_response(
    activities: Vec<ProviderActivity>,
    response: &str,
) -> Vec<ProviderActivity> {
    let response = response.trim();
    // Providers stream many intermediate statuses for the same activity id
    // (ACP tool_call → tool_call_update, Claude stream progress, …). Keeping
    // every frame left the durable rail full of "running" ghosts after a turn
    // settled — across Grok, Claude, and Codex. Collapse to the latest state
    // per id in arrival order, then force any still-open work closed: once the
    // provider has answered, nothing is still running.
    let mut order = Vec::<String>::new();
    let mut by_id = HashMap::<String, ProviderActivity>::new();
    for activity in activities {
        if activity.kind == "commentary" && activity.label.trim() == response {
            continue;
        }
        if !by_id.contains_key(&activity.id) {
            order.push(activity.id.clone());
        }
        by_id.insert(activity.id.clone(), activity);
    }
    order
        .into_iter()
        .filter_map(|id| by_id.remove(&id))
        .map(|mut activity| {
            if activity.status == "running" || activity.status == "queued" {
                activity.status = "done".into();
            }
            activity
        })
        .collect()
}

/// A non-zero CLI exit that still produced a real streamed answer.
///
/// Several provider CLIs exit non-zero after tool errors the model already
/// recovered from, or after writing a full answer. Treating those as total
/// failure tore down a finished chat and left the desktop in "failed" while the
/// user already had the reply. Cancel, timeout, and empty streams still fail.
pub(crate) fn recover_streamed_provider_answer(
    output: &StreamingCommandOutput,
    last_message: &str,
) -> Option<String> {
    if output.status_success {
        return None;
    }
    let candidates = [
        output.assistant_text.as_deref().unwrap_or(""),
        last_message,
        // Raw stdout only when the CLI did not speak stream-json; a JSON dump is
        // not an answer the user should see as a completed chat.
        if output.parsed_stream_json {
            ""
        } else {
            output.stdout.as_str()
        },
    ];
    candidates.into_iter().find_map(|candidate| {
        let response = sanitize_provider_chat_response(candidate.trim());
        (!response.is_empty()).then_some(response)
    })
}

pub(crate) fn extract_provider_session_id(value: &serde_json::Value) -> Option<String> {
    gyro_core::extract_provider_session_id(value)
}

pub(crate) type ProviderTextChunk = gyro_core::ProviderTextChunk;

#[cfg(test)]
pub(crate) fn extract_provider_text_delta(value: &serde_json::Value) -> Option<String> {
    extract_provider_text_chunk(value).map(|chunk| match chunk {
        ProviderTextChunk::Delta(text)
        | ProviderTextChunk::Snapshot(text)
        | ProviderTextChunk::Final(text) => text,
    })
}

pub(crate) fn extract_provider_text_chunk(value: &serde_json::Value) -> Option<ProviderTextChunk> {
    gyro_core::extract_provider_text_chunk(value)
}

pub(crate) fn extract_codex_agent_message_text(value: &serde_json::Value) -> Option<String> {
    gyro_core::extract_codex_agent_message_text(value)
}
