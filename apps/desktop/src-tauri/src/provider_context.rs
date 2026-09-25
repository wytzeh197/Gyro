//! Provider-reported context accounting and catalog-window normalization.

use serde::Serialize;
use serde_json::Value;

/// What a turn consumed of the model's context window.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProviderContextUsage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) cached_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reasoning_output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) total_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) model_context_window: Option<u64>,
}

#[derive(Default)]
pub(super) struct OllamaTurnUsage {
    requests: usize,
    incomplete: bool,
    input: u64,
    output: u64,
}

impl OllamaTurnUsage {
    pub(super) fn observe(&mut self, input: Option<u64>, output: Option<u64>) {
        self.requests += 1;
        if let (Some(input), Some(output)) = (input, output) {
            self.input = self.input.saturating_add(input);
            self.output = self.output.saturating_add(output);
        } else {
            self.incomplete = true;
        }
    }

    pub(super) fn measured(&self) -> Option<ProviderContextUsage> {
        (self.requests > 0 && !self.incomplete).then(|| ProviderContextUsage {
            input_tokens: Some(self.input),
            output_tokens: Some(self.output),
            total_tokens: Some(self.input.saturating_add(self.output)),
            ..ProviderContextUsage::default()
        })
    }
}

/// Marker that opens the live context note, so a runner can recognize the
/// note it wrote earlier in its own message list and rewrite that entry
/// instead of appending a fresh copy every round.
pub(super) const CONTEXT_CHECKPOINT_MARKER: &str = "[gyro.ctx]";

/// One line telling the model how full its context window is, from counts the
/// provider itself reported.
///
/// The runner's own tool loop writes this between requests, because that is
/// the only place a request's real occupancy is known: a model that can see
/// how much of its window the previous request held can size its own reads,
/// which is its one lever over how fast a turn fills up. `None` without a
/// prompt count, because a percentage derived from nothing is a guess the
/// model cannot tell apart from a measurement.
pub(super) fn context_checkpoint_note(
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    model_context_window: Option<u64>,
) -> Option<String> {
    let input_tokens = input_tokens?;
    let occupancy = input_tokens.saturating_add(output_tokens.unwrap_or_default());
    let reading = match output_tokens {
        Some(output_tokens) => format!("{input_tokens} prompt + {output_tokens} output tokens"),
        None => format!("{input_tokens} prompt tokens"),
    };
    let window = match model_context_window.filter(|window| *window > 0) {
        Some(window) => format!(
            "of its {window}-token window ({}% free)",
            window.saturating_sub(occupancy).saturating_mul(100) / window
        ),
        None => "with no window size known for this model".to_string(),
    };
    Some(format!(
        "{CONTEXT_CHECKPOINT_MARKER} Live context checkpoint: the previous request measured {reading} {window}. Gyro rewrites this note before each request; size your own reads to the space left."
    ))
}

/// Rewrite -- never stack -- the live context note in a runner's message list.
///
/// Replacing the previous note is the whole economy of the feature: a note
/// appended every round would be re-read by every later request, so a note
/// meant to save context would itself grow with the loop. Removing first also
/// handles a round the provider left unmeasured, where the stale reading no
/// longer describes the previous request and is dropped rather than repeated.
pub(super) fn refresh_context_checkpoint(
    messages: &mut Vec<Value>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    model_context_window: Option<u64>,
) {
    messages.retain(|message| !is_context_checkpoint(message));
    if let Some(note) = context_checkpoint_note(input_tokens, output_tokens, model_context_window) {
        messages.push(serde_json::json!({ "role": "user", "content": note }));
    }
}

fn is_context_checkpoint(message: &Value) -> bool {
    message
        .get("content")
        .and_then(Value::as_str)
        .is_some_and(|content| content.starts_with(CONTEXT_CHECKPOINT_MARKER))
}

/// Marker that opens the auto-compaction note, so a loop can find the history
/// it already replaced instead of compacting it twice.
///
/// Kept apart from [`CONTEXT_CHECKPOINT_MARKER`] on purpose: the live context
/// note is rewritten every round, and this one has to survive that rewrite.
pub(super) const CONTEXT_COMPACTION_MARKER: &str = "[gyro.compact]";

/// What one automatic compaction removed, for the activity that reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct ContextCompaction {
    /// Tool exchanges dropped from the in-flight list.
    pub(super) exchanges: usize,
    /// Serialized characters removed, reported as an estimated token count.
    pub(super) characters: u64,
    /// Measured fill of the window when the compaction fired.
    pub(super) percent: u64,
}

/// Rough tokens for text this crate must not pretend to have tokenized.
///
/// Four characters per token is the usual English/markdown average and the only
/// honest bridge between a character budget and a token window without a
/// tokenizer the provider may not share. Every use of it is reported as an
/// estimate, never as a measurement.
const CHARS_PER_TOKEN: u64 = 4;

/// Smallest tail of recent messages a compaction always leaves behind.
///
/// A rewrite that kept nothing would drop the conversation the model is
/// continuing from, which is worse than a full window, so the newest exchange
/// and the head are never elided no matter how tight the budget is.
const MIN_COMPACTED_TAIL_CHARS: u64 = 8_000;

/// Share of the trigger the retained tail is budgeted to, as a divisor.
///
/// Compacting back to the same share that triggered it would free nothing: the
/// next tool round crosses the line again. Halving it leaves real room to keep
/// working, which is the whole point of compacting before the window is full.
const COMPACT_TARGET_DIVISOR: u64 = 2;

/// How full the previous request left the window, when that is enough to
/// compact. `None` without a window, a measurement, or an enabled threshold.
fn auto_compaction_fill(
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    model_context_window: Option<u64>,
    percent: u32,
) -> Option<u64> {
    if percent == 0 {
        return None;
    }
    let window = model_context_window.filter(|window| *window > 0)?;
    let input_tokens = input_tokens?;
    let occupancy = input_tokens.saturating_add(output_tokens.unwrap_or_default());
    let fill = occupancy.saturating_mul(100) / window;
    (fill >= u64::from(percent.min(100))).then_some(fill)
}

/// Compact a tool loop's in-flight messages once the previous request has
/// filled the configured share of the model's window.
///
/// The in-flight list is what actually holds the window: the transcript behind
/// a turn is bounded before the turn starts, and then every tool round appends
/// its results to a list the next request re-sends in full. A turn that reads a
/// few large files can reach a window no single request asked for, and on a
/// metered API it pays for those results again on every later round.
///
/// This is the local half of what `/compact` does for a chat: the oldest tool
/// exchanges are replaced by one note that says what was removed and that the
/// work already done stands. The newest exchange and the head are never
/// touched, a tool result is never kept without the call it answers, and the
/// note replaces the previous note rather than stacking -- so a fifty-round
/// turn pays for exactly one note per request, the same economy the live
/// context note uses.
pub(super) fn auto_compact_messages(
    messages: &mut Vec<Value>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    model_context_window: Option<u64>,
    percent: u32,
) -> Option<ContextCompaction> {
    let window = model_context_window.filter(|window| *window > 0)?;
    let fill = auto_compaction_fill(input_tokens, output_tokens, Some(window), percent)?;
    let percent = percent.clamp(1, 100);
    if messages.len() < 3 {
        return None;
    }
    let previous_note = messages
        .iter()
        .position(is_context_compaction)
        .map(|index| messages.remove(index));
    // The head is the system prompt plus this turn's context message: identity,
    // the workspace briefing and the standing instructions. It is what the turn
    // is, so it is budgeted for but never elided.
    let head_characters = messages
        .iter()
        .take(2)
        .filter_map(message_characters)
        .sum::<u64>();
    let target_percent = u64::from(percent) / COMPACT_TARGET_DIVISOR;
    let budget = (window.saturating_mul(target_percent) / 100)
        .saturating_mul(CHARS_PER_TOKEN)
        .saturating_sub(head_characters)
        .max(MIN_COMPACTED_TAIL_CHARS);
    // Walk backwards from the newest message: it always stays, and everything
    // recent that fits the budget stays with it.
    let mut split = messages.len() - 1;
    let mut used = message_characters(&messages[split]).unwrap_or_default();
    for index in (2..split).rev() {
        let characters = message_characters(&messages[index]).unwrap_or_default();
        if used.saturating_add(characters) > budget {
            break;
        }
        used += characters;
        split = index;
    }
    // A tool result answers the call before it, so the kept region cannot open
    // on one: step back to the assistant message carrying those calls.
    while split > 2 && message_role(&messages[split]) == Some("tool") {
        split -= 1;
    }
    if split <= 2 || message_role(&messages[split]) == Some("tool") {
        if let Some(previous_note) = previous_note {
            messages.insert(2, previous_note);
        }
        return None;
    }
    let elided: Vec<Value> = messages.drain(2..split).collect();
    let compaction = ContextCompaction {
        exchanges: elided
            .iter()
            .filter(|message| carries_tool_calls(message))
            .count(),
        characters: elided.iter().filter_map(message_characters).sum(),
        percent: fill,
    };
    messages.insert(
        2,
        serde_json::json!({
            "role": "user",
            "content": auto_compaction_note(&compaction, window, percent),
        }),
    );
    Some(compaction)
}

fn auto_compaction_note(compaction: &ContextCompaction, window: u64, percent: u32) -> String {
    format!(
        "{CONTEXT_COMPACTION_MARKER} Auto-compaction: the previous request filled {}% of this model's {window}-token window, past the {percent}% Gyro compacts at, so the {exchanges} oldest tool exchanges -- about {tokens} estimated tokens of earlier results -- were replaced by this note. Nothing is undone: re-read or re-run anything whose result you no longer see.",
        compaction.percent,
        exchanges = compaction.exchanges,
        tokens = estimated_tokens(compaction.characters),
    )
}

/// The token estimate for a character count, for the surfaces that name one.
pub(super) fn estimated_tokens(characters: u64) -> u64 {
    characters.div_ceil(CHARS_PER_TOKEN)
}

fn is_context_compaction(message: &Value) -> bool {
    message
        .get("content")
        .and_then(Value::as_str)
        .is_some_and(|content| content.starts_with(CONTEXT_COMPACTION_MARKER))
}

fn message_role(message: &Value) -> Option<&str> {
    message.get("role").and_then(Value::as_str)
}

fn carries_tool_calls(message: &Value) -> bool {
    message
        .get("tool_calls")
        .and_then(Value::as_array)
        .is_some_and(|calls| !calls.is_empty())
}

/// Serialized characters of one message: what the request actually carries.
fn message_characters(message: &Value) -> Option<u64> {
    serde_json::to_string(message)
        .ok()
        .map(|serialized| serialized.chars().count() as u64)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ClaudeUsageFrame {
    Request,
    Turn,
}

pub(super) fn provider_context_usage_from_app_server(
    params: &Value,
) -> Option<ProviderContextUsage> {
    let token_usage = params.get("tokenUsage")?;
    let last = token_usage.get("last")?;
    Some(ProviderContextUsage {
        input_tokens: Some(last.get("inputTokens")?.as_u64()?),
        cached_input_tokens: last.get("cachedInputTokens").and_then(Value::as_u64),
        output_tokens: last.get("outputTokens").and_then(Value::as_u64),
        reasoning_output_tokens: last.get("reasoningOutputTokens").and_then(Value::as_u64),
        total_tokens: last.get("totalTokens").and_then(Value::as_u64),
        model_context_window: token_usage
            .get("modelContextWindow")
            .and_then(Value::as_u64),
    })
}

/// What an ACP prompt billed, from the `usage` object on its response.
///
/// Grok reports camelCase counts with cached reads inside `inputTokens`, the
/// same convention the ledger uses. The counts cover every model call in the
/// turn, so they are billing, never the context window's occupancy.
pub(super) fn provider_billed_usage_from_acp(usage: &Value) -> Option<ProviderContextUsage> {
    let field = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| usage.get(*key).and_then(Value::as_u64))
    };
    let input_tokens = field(&["inputTokens", "input_tokens"])?;
    let cached = field(&[
        "cachedReadTokens",
        "cached_read_tokens",
        "cachedInputTokens",
    ])
    .unwrap_or_default()
        + field(&[
            "cacheCreationTokens",
            "cachedWriteTokens",
            "cached_write_tokens",
        ])
        .unwrap_or_default();
    let output_tokens = field(&["outputTokens", "output_tokens"]).unwrap_or_default();
    Some(ProviderContextUsage {
        input_tokens: Some(input_tokens),
        cached_input_tokens: (cached > 0).then_some(cached.min(input_tokens)),
        output_tokens: Some(output_tokens),
        reasoning_output_tokens: field(&["reasoningTokens", "thoughtTokens", "reasoning_tokens"]),
        total_tokens: Some(
            field(&["totalTokens", "total_tokens"]).unwrap_or(input_tokens + output_tokens),
        ),
        model_context_window: None,
    })
}

pub(super) fn provider_context_usage_from_codex_exec(
    value: &Value,
) -> Option<ProviderContextUsage> {
    if value.get("type").and_then(Value::as_str) != Some("turn.completed") {
        return None;
    }
    let usage = value.get("usage")?;
    Some(ProviderContextUsage {
        input_tokens: Some(usage.get("input_tokens")?.as_u64()?),
        cached_input_tokens: usage.get("cached_input_tokens").and_then(Value::as_u64),
        output_tokens: usage.get("output_tokens").and_then(Value::as_u64),
        reasoning_output_tokens: usage.get("reasoning_output_tokens").and_then(Value::as_u64),
        total_tokens: usage.get("total_tokens").and_then(Value::as_u64),
        model_context_window: usage
            .get("model_context_window")
            .or_else(|| value.get("model_context_window"))
            .and_then(Value::as_u64),
    })
}

pub(super) fn provider_context_usage_from_claude_stream(
    value: &Value,
) -> Option<(ClaudeUsageFrame, ProviderContextUsage)> {
    let frame_type = value.get("type").and_then(Value::as_str)?;
    let (frame, usage) = match frame_type {
        "result" => (ClaudeUsageFrame::Turn, value.get("usage")?),
        "assistant" => (
            ClaudeUsageFrame::Request,
            value.get("message")?.get("usage")?,
        ),
        _ => return None,
    };
    let field = |key: &str| usage.get(key).and_then(Value::as_u64);
    let fresh_input = field("input_tokens")?;
    let cache_creation = field("cache_creation_input_tokens").unwrap_or_default();
    let cache_read = field("cache_read_input_tokens").unwrap_or_default();
    let input_tokens = fresh_input + cache_creation + cache_read;
    let output_tokens = field("output_tokens").unwrap_or_default();
    Some((
        frame,
        ProviderContextUsage {
            input_tokens: Some(input_tokens),
            cached_input_tokens: Some(cache_creation + cache_read),
            output_tokens: Some(output_tokens),
            reasoning_output_tokens: None,
            total_tokens: Some(input_tokens + output_tokens),
            model_context_window: claude_stream_context_window(value),
        },
    ))
}

fn claude_stream_context_window(value: &Value) -> Option<u64> {
    value
        .get("modelUsage")?
        .as_object()?
        .values()
        .find_map(|entry| entry.get("contextWindow").and_then(Value::as_u64))
}

pub(super) fn provider_model_context_window(
    provider_id: &str,
    model_id: Option<&str>,
) -> Option<u64> {
    if let Some(window) = crate::model_catalog::catalog_model_profile(provider_id, model_id)
        .and_then(|profile| profile.context_window_tokens)
    {
        return Some(window);
    }
    let model_id = model_id.map(str::trim).unwrap_or_default();
    let window = match provider_id {
        // Codex serves every current model with a 272K window, whatever the
        // API allows; the CLI's own report still wins when it sends one.
        "openai" => match model_id {
            "gpt-5.4-mini" => 400_000,
            _ => 272_000,
        },
        "anthropic" => match model_id {
            "claude-haiku-4-5" => 200_000,
            _ => 1_000_000,
        },
        "kimi" => 262_144,
        "gemini" => 1_000_000,
        "xai" => match model_id {
            "grok-4.3" => 131_072,
            _ => 500_000,
        },
        _ => return None,
    };
    Some(window)
}

fn exceeds_context_window(usage: &ProviderContextUsage) -> bool {
    let Some(window) = usage.model_context_window.filter(|window| *window > 0) else {
        return false;
    };
    let occupied = usage
        .total_tokens
        .unwrap_or_default()
        .max(usage.input_tokens.unwrap_or_default() + usage.output_tokens.unwrap_or_default());
    occupied > window
}

pub(super) fn provider_context_usage_with_window(
    reported: Option<ProviderContextUsage>,
    provider_id: &str,
    model_id: Option<&str>,
) -> Option<ProviderContextUsage> {
    let catalog_window = provider_model_context_window(provider_id, model_id);
    match reported {
        Some(mut usage) => {
            if usage.model_context_window.is_none() {
                usage.model_context_window = catalog_window;
            }
            if exceeds_context_window(&usage) {
                usage = ProviderContextUsage {
                    model_context_window: usage.model_context_window,
                    ..ProviderContextUsage::default()
                };
            }
            Some(usage)
        }
        None => catalog_window.map(|window| ProviderContextUsage {
            model_context_window: Some(window),
            ..ProviderContextUsage::default()
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grok_prompt_usage_is_billed_with_cached_reads_inside_input() {
        let usage = provider_billed_usage_from_acp(&serde_json::json!({
            "inputTokens": 18_177_618u64,
            "cachedReadTokens": 18_036_352u64,
            "cacheCreationTokens": 0,
            "outputTokens": 35_877,
            "reasoningTokens": 33_992,
            "totalTokens": 18_213_495u64
        }))
        .unwrap();
        assert_eq!(usage.input_tokens, Some(18_177_618));
        assert_eq!(usage.cached_input_tokens, Some(18_036_352));
        assert_eq!(usage.output_tokens, Some(35_877));
        assert_eq!(usage.reasoning_output_tokens, Some(33_992));
        assert_eq!(usage.total_tokens, Some(18_213_495));
        assert_eq!(usage.model_context_window, None);
        assert!(provider_billed_usage_from_acp(&serde_json::json!({"outputTokens": 3})).is_none());
    }

    #[test]
    fn live_context_note_replaces_itself_instead_of_stacking() {
        let mut messages = vec![serde_json::json!({"role": "user", "content": "do the task"})];
        refresh_context_checkpoint(&mut messages, Some(54_321), Some(1_200), Some(272_000));
        assert_eq!(messages.len(), 2);
        let note = messages[1]["content"].as_str().unwrap();
        assert!(note.starts_with(CONTEXT_CHECKPOINT_MARKER));
        assert!(note.contains("54321 prompt + 1200 output tokens"));
        assert!(note.contains("272000-token window (79% free)"));
        assert_eq!(messages[0]["content"], "do the task");

        refresh_context_checkpoint(&mut messages, Some(60_000), Some(900), Some(272_000));
        assert_eq!(messages.len(), 2, "the earlier note is rewritten in place");
        let note = messages[1]["content"].as_str().unwrap();
        assert!(note.contains("60000 prompt + 900 output tokens"));
    }

    #[test]
    fn live_context_note_needs_a_measurement_and_names_an_unknown_window() {
        let mut messages = Vec::new();
        refresh_context_checkpoint(&mut messages, None, Some(12), Some(272_000));
        assert!(messages.is_empty(), "an unmeasured request writes no note");

        refresh_context_checkpoint(&mut messages, Some(1_000), None, None);
        let note = messages[0]["content"].as_str().unwrap();
        assert!(note.contains("1000 prompt tokens"));
        assert!(note.contains("no window size known"));

        // A round the provider left unmeasured clears the stale reading
        // instead of leaving a number the model would read as current.
        refresh_context_checkpoint(&mut messages, None, None, None);
        assert!(messages.is_empty());
    }

    fn tool_exchange(round: usize, result_characters: usize) -> Vec<Value> {
        vec![
            serde_json::json!({
                "role": "assistant",
                "content": format!("round {round}"),
                "tool_calls": [{
                    "id": format!("call-{round}"),
                    "type": "function",
                    "function": { "name": "gyro_workspace_read", "arguments": "{}" }
                }]
            }),
            serde_json::json!({
                "role": "tool",
                "tool_call_id": format!("call-{round}"),
                "content": "x".repeat(result_characters)
            }),
        ]
    }

    fn loop_with_exchanges(count: usize, result_characters: usize) -> Vec<Value> {
        let mut messages = vec![
            serde_json::json!({ "role": "system", "content": "identity" }),
            serde_json::json!({ "role": "user", "content": "context" }),
        ];
        for round in 0..count {
            messages.extend(tool_exchange(round, result_characters));
        }
        messages
    }

    /// Every kept tool result still has the assistant call it answers.
    fn assert_calls_and_results_stay_paired(messages: &[Value]) {
        let mut open = std::collections::HashSet::new();
        for message in messages {
            match message_role(message) {
                Some("assistant") => {
                    open.clear();
                    for call in message
                        .get("tool_calls")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                    {
                        if let Some(id) = call.get("id").and_then(Value::as_str) {
                            open.insert(id.to_string());
                        }
                    }
                }
                Some("tool") => {
                    let id = message
                        .get("tool_call_id")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    assert!(
                        open.contains(id),
                        "tool result {id} lost the assistant call it answers"
                    );
                }
                _ => open.clear(),
            }
        }
    }

    #[test]
    fn auto_compaction_replaces_the_oldest_exchanges_and_keeps_pairs_intact() {
        let mut messages = loop_with_exchanges(6, 4_000);
        let compaction =
            auto_compact_messages(&mut messages, Some(7_000), Some(100), Some(8_000), 80)
                .expect("a request past the configured share compacts");
        assert_eq!(compaction.percent, 88, "7100 of 8000 is the measured fill");
        assert!(compaction.exchanges >= 1);
        assert_eq!(message_role(&messages[0]), Some("system"));
        assert_eq!(messages[1]["content"], "context");
        let note = messages[2]["content"].as_str().unwrap();
        assert!(note.starts_with(CONTEXT_COMPACTION_MARKER));
        assert!(note.contains("88%"));
        assert!(note.contains(&format!(
            "the {} oldest tool exchanges",
            compaction.exchanges
        )));
        // The newest exchange always survives, and nothing is orphaned.
        assert_eq!(messages.last().unwrap()["tool_call_id"], "call-5");
        assert_calls_and_results_stay_paired(&messages);
        let kept = messages
            .iter()
            .filter(|message| message_role(message) == Some("assistant"))
            .count();
        assert!(
            kept >= 1 && kept < 6,
            "compaction keeps recent work and drops old work, not both or neither"
        );
    }

    #[test]
    fn a_compaction_with_nothing_new_to_drop_reports_nothing_and_keeps_its_note() {
        let mut messages = loop_with_exchanges(6, 4_000);
        auto_compact_messages(&mut messages, Some(7_000), Some(0), Some(8_000), 80)
            .expect("first compaction");
        let compacted = messages.clone();
        assert!(
            auto_compact_messages(&mut messages, Some(7_000), Some(0), Some(8_000), 80).is_none()
        );
        assert_eq!(
            messages, compacted,
            "an already-compacted list is left exactly as it was"
        );
        assert_eq!(
            messages
                .iter()
                .filter(|message| is_context_compaction(message))
                .count(),
            1,
            "the note is rewritten, never stacked"
        );
    }

    #[test]
    fn a_later_compaction_rewrites_the_note_rather_than_stacking_one() {
        let mut messages = loop_with_exchanges(6, 4_000);
        auto_compact_messages(&mut messages, Some(7_000), Some(0), Some(8_000), 80)
            .expect("first compaction");
        messages.extend(tool_exchange(6, 4_000));
        messages.extend(tool_exchange(7, 4_000));
        let compaction =
            auto_compact_messages(&mut messages, Some(7_000), Some(0), Some(8_000), 80)
                .expect("the new rounds cross the share again");
        assert!(compaction.exchanges >= 1);
        assert_eq!(
            messages
                .iter()
                .filter(|message| is_context_compaction(message))
                .count(),
            1
        );
        assert!(is_context_compaction(&messages[2]));
        assert_calls_and_results_stay_paired(&messages);
    }

    #[test]
    fn the_newest_exchange_survives_however_large_it_is() {
        let mut messages = loop_with_exchanges(2, 100);
        messages.extend(tool_exchange(9, 400_000));
        let compaction =
            auto_compact_messages(&mut messages, Some(99_000), Some(0), Some(8_000), 80)
                .expect("an oversized tool result still compacts the rounds before it");
        assert!(compaction.exchanges >= 1);
        assert_eq!(messages.len(), 5);
        assert!(messages[2]["content"]
            .as_str()
            .unwrap()
            .starts_with(CONTEXT_COMPACTION_MARKER));
        assert_eq!(messages[3]["tool_calls"][0]["id"], "call-9");
        assert_eq!(messages[4]["tool_call_id"], "call-9");
        assert_calls_and_results_stay_paired(&messages);
    }

    #[test]
    fn auto_compaction_leaves_a_small_or_unmeasured_request_alone() {
        let mut messages = loop_with_exchanges(6, 4_000);
        let snapshot = messages.clone();
        // Measured below the share.
        assert!(
            auto_compact_messages(&mut messages, Some(5_000), Some(0), Some(8_000), 80).is_none()
        );
        // Switched off in settings.
        assert!(
            auto_compact_messages(&mut messages, Some(7_900), Some(0), Some(8_000), 0).is_none()
        );
        // No window to measure against, which is how a custom endpoint arrives.
        assert!(auto_compact_messages(&mut messages, Some(7_900), Some(0), None, 80).is_none());
        // No measurement yet: the first round of a turn has nothing to report.
        assert!(auto_compact_messages(&mut messages, None, None, Some(8_000), 80).is_none());
        assert_eq!(messages, snapshot);
    }
}
