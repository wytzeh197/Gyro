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
    /// True when the count was inferred from text, not reported by the provider.
    /// That count is dropped before it is published as occupancy.
    #[serde(default, skip_serializing_if = "skip_false")]
    pub(super) estimated: bool,
}

fn skip_false(value: &bool) -> bool {
    !*value
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
        "{CONTEXT_CHECKPOINT_MARKER} Previous request measured: {reading} {window}. Size reads to the remaining space; this checkpoint is replaced each request."
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
    /// Estimated text characters removed; encoded image bytes are excluded.
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
        .map(|index| (index, messages.remove(index)));
    // The head is the system prompt plus this turn's context message: identity,
    // the workspace briefing and the standing instructions. It is what the turn
    // is, so it is budgeted for but never elided.
    let sizes = messages.iter().map(message_size).collect::<Vec<_>>();
    let head_characters = sizes
        .iter()
        .take(2)
        .map(|(characters, _)| *characters)
        .sum::<u64>();
    let target_percent = u64::from(percent) / COMPACT_TARGET_DIVISOR;
    let budget = (window.saturating_mul(target_percent) / 100)
        .saturating_mul(CHARS_PER_TOKEN)
        .saturating_sub(head_characters)
        .max(MIN_COMPACTED_TAIL_CHARS);
    // An exchange starts at the assistant request and includes all its tool
    // results and image observations. A screenshot can follow a result or sit
    // between results, so contiguous `tool` roles do not describe its boundary.
    // The newest complete exchange must survive even if its result is large.
    let exchanges = messages
        .iter()
        .enumerate()
        .skip(2)
        .filter_map(|(index, message)| {
            (message_role(message) == Some("assistant")).then_some(index)
        })
        .collect::<Vec<_>>();
    let Some(mut split) = exchanges.last().copied() else {
        if let Some((index, note)) = previous_note {
            messages.insert(index, note);
        }
        return None;
    };
    let mut used = sizes[split..]
        .iter()
        .map(|(characters, _)| *characters)
        .sum::<u64>();
    let mut retained_image = sizes[split..].iter().any(|(_, image)| *image);
    for index in exchanges.iter().rev().skip(1).copied() {
        let has_image = sizes[index..split].iter().any(|(_, image)| *image);
        // Measured occupancy includes visual tokens, but their cost cannot be
        // inferred from encoded bytes. When the window is full, keep the latest
        // image exchange and stop before an older one rather than allowing a
        // text-only estimate to retain every screenshot indefinitely.
        if has_image && retained_image {
            break;
        }
        let characters = sizes[index..split]
            .iter()
            .map(|(characters, _)| *characters)
            .sum::<u64>();
        if used.saturating_add(characters) > budget {
            break;
        }
        used = used.saturating_add(characters);
        retained_image |= has_image;
        split = index;
    }
    // A preceding checkpoint alone is not work worth replacing with a note.
    if !exchanges.iter().any(|index| *index < split) {
        if let Some((index, note)) = previous_note {
            messages.insert(index, note);
        }
        return None;
    }
    let elided: Vec<Value> = messages.drain(2..split).collect();
    let compaction = ContextCompaction {
        exchanges: elided
            .iter()
            .filter(|message| {
                carries_tool_calls(message) || carries_compatibility_tool_call(message)
            })
            .count(),
        characters: sizes[2..split]
            .iter()
            .map(|(characters, _)| *characters)
            .sum(),
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
        "{CONTEXT_COMPACTION_MARKER} At {}% of the {window}-token window (trigger {percent}%), the {exchanges} oldest tool exchanges were replaced: about {tokens} estimated text tokens. Completed actions still stand. Re-read missing data; inspect current state before retrying an action whose result was removed.",
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

/// One provider reading of how full the window is.
///
/// Counts are the prompt the provider measured. The window is the one that
/// reading named. A catalog window is filled in by the caller when this one
/// did not name one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct AutoCompactReading {
    pub(super) input_tokens: Option<u64>,
    pub(super) output_tokens: Option<u64>,
    pub(super) model_context_window: Option<u64>,
}

/// One persisted chat event, reduced to what the auto-compact decision needs.
#[derive(Clone, Debug)]
pub(super) struct SessionContextSignal {
    pub(super) provider_id: Option<String>,
    pub(super) model_id: Option<String>,
    pub(super) reading: Option<AutoCompactReading>,
    /// A session rewrite, the same kind `/compact` records. An in-loop note
    /// does not set this: that rewrite never replaces the resumed session.
    pub(super) session_compaction: bool,
}

/// Whether the next turn should compact before it sends, for any provider.
///
/// The tool-loop rewrite only sees messages Gyro owns. Codex, Claude, Grok,
/// Kimi, Antigravity, and any other resumed session keep their own transcript,
/// so the decision lives here and the caller runs the same compaction `/compact`
/// runs. A reported window is enough. The catalog fills in when the reading
/// named tokens but not a size. No window, an estimate, a switched-off
/// setting, another provider's reading, or a compaction that already followed
/// this reading all decline.
pub(super) fn should_auto_compact_session(
    percent: u32,
    provider_id: &str,
    model_id: Option<&str>,
    catalog_window: Option<u64>,
    signals: &[SessionContextSignal],
) -> bool {
    if percent == 0 {
        return false;
    }
    let mut reading: Option<AutoCompactReading> = None;
    let mut compacted_after = false;
    for signal in signals {
        if signal_is_for_other_model(signal, provider_id, model_id) {
            if signal.reading.is_some() || signal.session_compaction {
                reading = None;
                compacted_after = false;
            }
            continue;
        }
        if signal.session_compaction && reading.is_some() {
            compacted_after = true;
        }
        if let Some(next) = signal.reading.clone() {
            reading = Some(next);
            compacted_after = false;
        }
    }
    if compacted_after {
        return false;
    }
    let Some(mut reading) = reading else {
        return false;
    };
    if reading
        .model_context_window
        .filter(|window| *window > 0)
        .is_none()
    {
        reading.model_context_window = catalog_window.filter(|window| *window > 0);
    }
    auto_compaction_fill(
        reading.input_tokens,
        reading.output_tokens,
        reading.model_context_window,
        percent,
    )
    .is_some()
}

fn signal_is_for_other_model(
    signal: &SessionContextSignal,
    provider_id: &str,
    model_id: Option<&str>,
) -> bool {
    if signal
        .provider_id
        .as_deref()
        .is_some_and(|id| !id.is_empty() && id != provider_id)
    {
        return true;
    }
    match (signal.model_id.as_deref(), model_id) {
        (Some(signal_model), Some(current))
            if !signal_model.is_empty() && signal_model != current =>
        {
            true
        }
        _ => false,
    }
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

fn carries_compatibility_tool_call(message: &Value) -> bool {
    message_role(message) == Some("assistant")
        && message
            .get("content")
            .and_then(Value::as_str)
            .and_then(|content| serde_json::from_str::<Value>(content).ok())
            .is_some_and(|action| action.get("type").and_then(Value::as_str) == Some("tool"))
}

/// Text and schema characters of a message, excluding encoded image bytes.
/// Image token costs are provider-owned and cannot be inferred from base64.
fn message_size(message: &Value) -> (u64, bool) {
    let (characters, image) = gyro_core::provider_observation::text_size(message);
    (characters as u64, image)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ClaudeUsageFrame {
    Request,
    Turn,
}

/// Occupancy of one completed model request.
///
/// The prompt count is what that request held, and output is what it added.
/// Cache and reasoning are copied only when the provider reported those
/// buckets. A missing prompt count is not occupancy. Pass one request, never
/// a turn's summed bill.
pub(super) fn occupancy_from_request(
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    accounted: &gyro_core::usage::UsageTokens,
    model_context_window: Option<u64>,
) -> Option<ProviderContextUsage> {
    let input_tokens = input_tokens?;
    let known = accounted
        .accounting
        .map(|metadata| metadata.known)
        .unwrap_or_default();
    Some(ProviderContextUsage {
        input_tokens: Some(input_tokens),
        output_tokens,
        cached_input_tokens: known.cache_read.then_some(accounted.cached_input_tokens),
        reasoning_output_tokens: known.reasoning.then_some(accounted.reasoning_output_tokens),
        total_tokens: output_tokens.map(|output| input_tokens.saturating_add(output)),
        model_context_window: model_context_window.filter(|window| *window > 0),
        ..ProviderContextUsage::default()
    })
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
        ..ProviderContextUsage::default()
    })
}

/// Compatibility parser for the Grok PromptUsage contract only. Live ACP
/// adapters use the provider-specific normalizer, retaining cache writes and
/// coverage in UsageTokens rather than collapsing them into cached reads.
#[cfg(test)]
pub(super) fn provider_billed_usage_from_acp(usage: &Value) -> Option<ProviderContextUsage> {
    let observation = gyro_core::acp_usage::normalize_prompt_usage(
        gyro_core::acp_usage::AcpProvider::Grok,
        &serde_json::json!({"usage": usage}),
        gyro_core::acp_usage::AcpRuntimeInfo::default(),
    );
    provider_billed_usage_from_acp_tokens(observation.tokens)
}

pub(super) fn provider_billed_usage_from_acp_tokens(
    tokens: gyro_core::usage::UsageTokens,
) -> Option<ProviderContextUsage> {
    let accounting = tokens.effective_accounting();
    if !accounting.known.input {
        return None;
    }
    Some(ProviderContextUsage {
        input_tokens: Some(tokens.input_tokens),
        cached_input_tokens: accounting
            .known
            .cache_read
            .then_some(tokens.cached_input_tokens),
        output_tokens: accounting.known.output.then_some(tokens.output_tokens),
        reasoning_output_tokens: accounting
            .known
            .reasoning
            .then_some(tokens.reasoning_output_tokens),
        total_tokens: Some(tokens.total_tokens),
        model_context_window: None,
        ..ProviderContextUsage::default()
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
        ..ProviderContextUsage::default()
    })
}

pub(super) fn provider_context_usage_from_claude_stream(
    value: &Value,
) -> Option<(ClaudeUsageFrame, ProviderContextUsage)> {
    // Child messages are already represented by whole-tree accounting when
    // verified. They never describe the main conversation's context window.
    if value
        .get("parent_tool_use_id")
        .is_some_and(|id| !id.is_null())
    {
        return None;
    }
    let frame_type = value.get("type").and_then(Value::as_str)?;
    let (frame, usage) = match frame_type {
        "result" => (ClaudeUsageFrame::Turn, value.get("usage")?),
        "assistant" => (
            ClaudeUsageFrame::Request,
            value.get("message")?.get("usage")?,
        ),
        "stream_event" => {
            let event = value.get("event")?;
            if event.get("type").and_then(Value::as_str) != Some("message_start") {
                return None;
            }
            (
                ClaudeUsageFrame::Request,
                event.get("message")?.get("usage")?,
            )
        }
        _ => return None,
    };
    let field = |key: &str| usage.get(key).and_then(Value::as_u64);
    // Anthropic reports disjoint input buckets, unlike Codex's subsets.
    // Missing optional buckets stay unknown; observed counts remain a lower bound.
    let fresh_input = field("input_tokens");
    let cache_creation = field("cache_creation_input_tokens");
    let cache_read = field("cache_read_input_tokens");
    let input_tokens = fresh_input.map(|fresh| {
        fresh
            .saturating_add(cache_creation.unwrap_or_default())
            .saturating_add(cache_read.unwrap_or_default())
    });
    let output_tokens = field("output_tokens");
    Some((
        frame,
        ProviderContextUsage {
            input_tokens,
            // Legacy context display treats both cache buckets as reused context.
            // The billing parser retains separate read and write buckets.
            cached_input_tokens: match (cache_creation, cache_read) {
                (None, None) => None,
                (write, read) => Some(
                    write
                        .unwrap_or_default()
                        .saturating_add(read.unwrap_or_default()),
                ),
            },
            output_tokens,
            reasoning_output_tokens: None,
            total_tokens: input_tokens
                .zip(output_tokens)
                .map(|(input, output)| input.saturating_add(output)),
            model_context_window: claude_stream_context_window(value),
            ..ProviderContextUsage::default()
        },
    ))
}

pub(super) fn claude_stream_context_window(value: &Value) -> Option<u64> {
    let entries = value.get("modelUsage")?.as_object()?;
    let mut windows = entries
        .values()
        .filter_map(|entry| entry.get("contextWindow").and_then(Value::as_u64));
    let window = windows.next()?;
    // A mixed-model result cannot identify which window the last request used.
    windows.all(|other| other == window).then_some(window)
}

pub(super) fn provider_model_context_window(
    provider_id: &str,
    model_id: Option<&str>,
) -> Option<u64> {
    if let Some(window) =
        model_id.and_then(|model| crate::live_model_context::known_window(provider_id, model))
    {
        return Some(window);
    }
    catalog_context_window(provider_id, model_id)
}

pub(super) fn catalog_context_window(provider_id: &str, model_id: Option<&str>) -> Option<u64> {
    if let Some(window) = crate::model_catalog::catalog_model_profile(provider_id, model_id)
        .and_then(|profile| profile.context_window_tokens)
    {
        return Some(window);
    }
    let model_id = model_id.map(str::trim).unwrap_or_default();
    let window = match provider_id {
        // Codex defaults differ from the API maxima. Runtime reports win.
        // Signed-in catalogs serve 500K for GPT-6.1 Sol. The logged-out
        // bundled catalog still lists 272K for that slug.
        "openai" => match model_id {
            "gpt-6.1-sol" => 500_000,
            "gpt-5.4-mini" => 400_000,
            "" | "gpt-6-astra" | "gpt-6-sol" | "gpt-6-luna" | "gpt-5.6-sol" | "gpt-5.6-terra"
            | "gpt-5.6-luna" | "gpt-5.5" | "gpt-5.4" => 272_000,
            _ => return None,
        },
        "anthropic" => match model_id {
            "claude-haiku-4-5" => 200_000,
            "" | "claude-fable-5-1" | "claude-fable-5" | "claude-opus-5-5" | "claude-opus-5"
            | "claude-opus-4-8" | "claude-sonnet-5-5" | "claude-sonnet-5" | "claude-haiku-5-5" => {
                1_000_000
            }
            _ => return None,
        },
        // K3 and K3.1 Pro entitlements depend on the plan; retain the Plus
        // baseline until the runtime reports the session's provisioned window.
        // Highspeed is offered only on Pro and Allegretto, at 1,048,576.
        "kimi" => match model_id {
            "" | "k3" | "k3.1-pro" => 262_144,
            "k3.1-pro-highspeed" => 1_048_576,
            _ => return None,
        },
        "gemini" if matches!(model_id, "" | "gemini-default" | "gemini-3.8-flash") => 1_048_576,
        // Grok Build's served context_window is 256K. 500K is the optional
        // larger window on that CLI, not this baseline. The public API is a
        // different connection and is not this table.
        "xai" => match model_id {
            "" | "grok-4.7" | "grok-4.7-build-fast" | "grok-4.6" | "grok-4.5" => 256_000,
            _ => return None,
        },
        "deepseek" => match model_id {
            "deepseek-flash" | "deepseek-v4-pro" => 1_000_000,
            _ => return None,
        },
        "mistral" => match model_id {
            "mistral-medium-latest" | "mistral-large-latest" | "mistral-small-latest" => 256_000,
            "codestral-latest" => 128_000,
            _ => return None,
        },
        "openrouter" => match model_id {
            "anthropic/claude-sonnet-5" | "anthropic/claude-opus-5" | "qwen/qwen3.8-max-0902" => {
                1_000_000
            }
            "openai/gpt-6-astra" => 1_050_000,
            "google/gemini-3.8-flash"
            | "deepseek/deepseek-v4.1-flash"
            | "moonshotai/kimi-k3"
            | "moonshotai/kimi-k3.1-pro"
            | "z-ai/glm-5.3" => 1_048_576,
            "x-ai/grok-4.7" | "x-ai/grok-4.6" => 500_000,
            "meta-llama/llama-3.3-70b-instruct" => 131_072,
            _ => return None,
        },
        _ => return None,
    };
    Some(window)
}

fn exceeds_context_window(usage: &ProviderContextUsage) -> bool {
    let Some(window) = usage.model_context_window.filter(|window| *window > 0) else {
        return false;
    };
    let occupied = usage.total_tokens.unwrap_or_default().max(
        usage
            .input_tokens
            .unwrap_or_default()
            .saturating_add(usage.output_tokens.unwrap_or_default()),
    );
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
            if usage.estimated || exceeds_context_window(&usage) {
                // A character estimate, a traffic sum, and a multi-call bill
                // are not occupancy. Keep the window and drop the count
                // instead of painting the meter from a number the provider
                // did not report as the window fill.
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
    fn api_models_supply_windows_for_usage_and_compaction() {
        for (provider, model, window) in [
            ("deepseek", "deepseek-flash", 1_000_000),
            ("deepseek", "deepseek-v4-pro", 1_000_000),
            ("mistral", "mistral-medium-latest", 256_000),
            ("mistral", "mistral-large-latest", 256_000),
            ("mistral", "mistral-small-latest", 256_000),
            ("mistral", "codestral-latest", 128_000),
            ("openrouter", "anthropic/claude-sonnet-5", 1_000_000),
            ("openrouter", "anthropic/claude-opus-5", 1_000_000),
            ("openrouter", "openai/gpt-6-astra", 1_050_000),
            ("openrouter", "google/gemini-3.8-flash", 1_048_576),
            ("openrouter", "x-ai/grok-4.7", 500_000),
            ("openrouter", "x-ai/grok-4.6", 500_000),
            ("openrouter", "deepseek/deepseek-v4.1-flash", 1_048_576),
            ("openrouter", "moonshotai/kimi-k3", 1_048_576),
            ("openrouter", "moonshotai/kimi-k3.1-pro", 1_048_576),
            ("kimi", "k3.1-pro", 262_144),
            ("kimi", "k3.1-pro-highspeed", 1_048_576),
            ("openrouter", "z-ai/glm-5.3", 1_048_576),
            ("openrouter", "qwen/qwen3.8-max-0902", 1_000_000),
            ("openrouter", "meta-llama/llama-3.3-70b-instruct", 131_072),
        ] {
            let usage = provider_context_usage_with_window(None, provider, Some(model)).unwrap();
            assert_eq!(
                usage.model_context_window,
                Some(window),
                "{provider}/{model}"
            );
            assert_eq!(
                auto_compaction_fill(
                    Some((window * 9).div_ceil(10)),
                    None,
                    usage.model_context_window,
                    90
                ),
                Some(90)
            );
        }
        assert_eq!(
            provider_model_context_window("openrouter", Some("unknown")),
            None
        );
    }

    #[test]
    fn provisioned_runtime_windows_override_offline_baselines() {
        for (provider, model, window) in [
            ("kimi", "k3", 1_048_576),
            ("openai", "gpt-6.1-sol", 475_000),
            ("xai", "grok-4.3", 131_072),
        ] {
            let usage = provider_context_usage_with_window(
                Some(ProviderContextUsage {
                    input_tokens: Some(1_024),
                    model_context_window: Some(window),
                    ..ProviderContextUsage::default()
                }),
                provider,
                Some(model),
            )
            .unwrap();
            assert_eq!(usage.model_context_window, Some(window));
            assert_eq!(usage.input_tokens, Some(1_024));
        }
    }

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
                // Image observations can appear between tool results.
                _ => {}
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
    fn compaction_keeps_the_newest_exchange_with_its_trailing_image_and_checkpoint() {
        let mut messages = loop_with_exchanges(2, 100);
        messages.extend(tool_exchange(9, 400_000));
        messages.push(serde_json::json!({
            "role": "user", "content": "screenshot observation", "images": ["image-data"]
        }));
        refresh_context_checkpoint(&mut messages, Some(99_000), Some(0), Some(8_000));
        auto_compact_messages(&mut messages, Some(99_000), Some(0), Some(8_000), 80)
            .expect("older exchanges can be compacted");
        assert_eq!(messages[3]["tool_calls"][0]["id"], "call-9");
        assert_eq!(messages[4]["tool_call_id"], "call-9");
        assert_eq!(messages[5]["images"][0], "image-data");
        assert_calls_and_results_stay_paired(&messages);
    }

    #[test]
    fn compaction_keeps_all_results_when_images_separate_a_multi_tool_exchange() {
        let mut messages = loop_with_exchanges(2, 100);
        let mut newest = tool_exchange(9, 400_000);
        newest[0]["tool_calls"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "id": "call-10", "type": "function",
                "function": { "name": "gyro_workspace_read", "arguments": "{}" }
            }));
        messages.extend(newest);
        messages.push(serde_json::json!({
            "role": "user", "content": "screenshot observation", "images": ["image-data"]
        }));
        messages.push(serde_json::json!({
            "role": "tool", "tool_call_id": "call-10", "content": "second result"
        }));
        auto_compact_messages(&mut messages, Some(99_000), Some(0), Some(8_000), 80)
            .expect("older exchanges can be compacted");
        assert_eq!(messages[3]["tool_calls"].as_array().unwrap().len(), 2);
        assert_eq!(messages[4]["tool_call_id"], "call-9");
        assert_eq!(messages[6]["tool_call_id"], "call-10");
        assert_calls_and_results_stay_paired(&messages);
    }

    #[test]
    fn a_checkpoint_before_the_only_exchange_does_not_trigger_compaction() {
        let mut messages = loop_with_exchanges(0, 0);
        refresh_context_checkpoint(&mut messages, Some(7_000), Some(0), Some(8_000));
        messages.extend(tool_exchange(1, 400_000));
        let unchanged = messages.clone();
        assert!(
            auto_compact_messages(&mut messages, Some(7_000), Some(0), Some(8_000), 80).is_none()
        );
        assert_eq!(messages, unchanged);
    }

    #[test]
    fn compaction_counts_compatibility_tools_and_keeps_the_newest_result() {
        let mut messages = loop_with_exchanges(0, 0);
        for round in 0..6 {
            messages.push(serde_json::json!({
                "role": "assistant",
                "content": format!(r#"{{"type":"tool","name":"gyro_workspace_read","arguments":{{"path":"file-{round}"}}}}"#)
            }));
            messages.push(serde_json::json!({"role": "user", "content": "x".repeat(4_000)}));
        }
        let compaction =
            auto_compact_messages(&mut messages, Some(7_000), Some(0), Some(8_000), 80)
                .expect("compatibility tool results can be compacted");
        assert!(compaction.exchanges > 0);
        assert!(messages[messages.len() - 2]["content"]
            .as_str()
            .unwrap()
            .contains("file-5"));
        assert_eq!(
            messages.last().unwrap()["content"].as_str().unwrap().len(),
            4_000
        );
    }

    #[test]
    fn encoded_images_are_not_reported_as_estimated_text_tokens() {
        let text = serde_json::json!({"role": "user", "content": "observation"});
        let ollama = serde_json::json!({"role": "user", "content": "observation", "images": ["x".repeat(1_000_000)]});
        let openai = serde_json::json!({"role": "user", "content": [
            {"type": "text", "text": "observation"},
            {"type": "image_url", "image_url": {"url": format!("data:image/png;base64,{}", "x".repeat(1_000_000))}}
        ]});
        assert!(message_size(&ollama).0 - message_size(&text).0 < 100);
        assert!(message_size(&openai).0 < 200);
    }

    #[test]
    fn measured_visual_occupancy_still_prunes_older_image_exchanges() {
        let mut messages = loop_with_exchanges(0, 0);
        for round in 0..3 {
            messages.extend(tool_exchange(round, 10));
            messages.push(serde_json::json!({
                "role": "user", "content": format!("screenshot {round}"), "images": ["x".repeat(100_000)]
            }));
        }
        let compaction =
            auto_compact_messages(&mut messages, Some(7_000), Some(0), Some(8_000), 80)
                .expect("visual occupancy triggers pruning despite small text");
        assert_eq!(compaction.exchanges, 2);
        assert!(
            compaction.characters < 1_000,
            "image bytes are not text token savings"
        );
        assert_eq!(messages[3]["tool_calls"][0]["id"], "call-2");
        assert_eq!(messages.last().unwrap()["content"], "screenshot 2");
        assert_calls_and_results_stay_paired(&messages);
    }

    #[test]
    fn serialized_tool_arguments_and_results_remain_in_the_text_budget() {
        let messages = tool_exchange(0, 4_000);
        assert!(message_size(&messages[0]).0 > 100);
        assert!(message_size(&messages[1]).0 >= 4_000);
    }

    #[test]
    fn one_request_occupancy_uses_that_prompt_and_ignores_a_missing_one() {
        let accounted = gyro_core::usage::UsageTokens::measured(
            Some(1_000),
            Some(40),
            Some(20),
            Some(5),
            Some(1_020),
        );
        let usage = occupancy_from_request(Some(1_000), Some(20), &accounted, Some(0)).unwrap();
        assert_eq!(usage.input_tokens, Some(1_000));
        assert_eq!(usage.output_tokens, Some(20));
        assert_eq!(usage.cached_input_tokens, Some(40));
        assert_eq!(usage.reasoning_output_tokens, Some(5));
        assert_eq!(usage.total_tokens, Some(1_020));
        assert_eq!(usage.model_context_window, None);
        assert!(!usage.estimated);
        assert!(occupancy_from_request(None, Some(20), &accounted, Some(128_000)).is_none());
    }

    #[test]
    fn estimated_traffic_past_the_window_is_not_occupancy() {
        let usage = provider_context_usage_with_window(
            Some(ProviderContextUsage {
                input_tokens: Some(7_515_785),
                total_tokens: Some(7_515_785),
                estimated: true,
                ..ProviderContextUsage::default()
            }),
            "xai",
            Some("grok-4.7"),
        )
        .unwrap();
        assert_eq!(usage.input_tokens, None);
        assert_eq!(usage.output_tokens, None);
        assert_eq!(usage.total_tokens, None);
        assert!(!usage.estimated);
        assert_eq!(usage.model_context_window, Some(256_000));

        let within = provider_context_usage_with_window(
            Some(ProviderContextUsage {
                input_tokens: Some(180_000),
                total_tokens: Some(180_000),
                estimated: true,
                ..ProviderContextUsage::default()
            }),
            "xai",
            Some("grok-4.7"),
        )
        .unwrap();
        assert_eq!(within.input_tokens, None);
        assert_eq!(within.total_tokens, None);
        assert!(!within.estimated);
        assert_eq!(within.model_context_window, Some(256_000));

        let billed = provider_context_usage_with_window(
            Some(ProviderContextUsage {
                input_tokens: Some(7_515_785),
                total_tokens: Some(7_515_785),
                ..ProviderContextUsage::default()
            }),
            "xai",
            Some("grok-4.7"),
        )
        .unwrap();
        assert_eq!(billed.input_tokens, None);
        assert!(!billed.estimated);
        assert_eq!(billed.model_context_window, Some(256_000));
    }

    #[test]
    fn oversized_usage_counters_do_not_overflow_window_validation() {
        assert!(exceeds_context_window(&ProviderContextUsage {
            input_tokens: Some(u64::MAX),
            output_tokens: Some(1),
            model_context_window: Some(8_000),
            ..ProviderContextUsage::default()
        }));
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

    fn reading(input: u64, window: u64) -> SessionContextSignal {
        SessionContextSignal {
            provider_id: Some("xai".into()),
            model_id: Some("grok-4.7".into()),
            reading: Some(AutoCompactReading {
                input_tokens: Some(input),
                output_tokens: Some(0),
                model_context_window: Some(window),
            }),
            session_compaction: false,
        }
    }

    #[test]
    fn session_auto_compact_uses_a_reported_window_for_any_provider() {
        let full = reading(205_000, 256_000);
        assert!(
            should_auto_compact_session(80, "xai", Some("grok-4.7"), None, &[full.clone()]),
            "205K of a reported 256K window is the default threshold"
        );
        assert!(
            !should_auto_compact_session(
                80,
                "xai",
                Some("grok-4.7"),
                None,
                &[reading(200_000, 256_000)]
            ),
            "just under the share stays"
        );
        assert!(!should_auto_compact_session(
            0,
            "xai",
            Some("grok-4.7"),
            None,
            &[full.clone()]
        ));
        let mut other = full.clone();
        other.provider_id = Some("anthropic".into());
        other.model_id = Some("claude-sonnet-5".into());
        assert!(!should_auto_compact_session(
            80,
            "xai",
            Some("grok-4.7"),
            None,
            &[other]
        ));
    }

    #[test]
    fn session_auto_compact_waits_for_a_new_reading_after_it_already_ran() {
        let full = reading(205_000, 256_000);
        let compacted = SessionContextSignal {
            provider_id: Some("xai".into()),
            model_id: Some("grok-4.7".into()),
            reading: None,
            session_compaction: true,
        };
        assert!(!should_auto_compact_session(
            80,
            "xai",
            Some("grok-4.7"),
            None,
            &[full.clone(), compacted.clone()]
        ));
        let still_full = reading(210_000, 256_000);
        assert!(should_auto_compact_session(
            80,
            "xai",
            Some("grok-4.7"),
            None,
            &[full, compacted, still_full]
        ));
    }

    #[test]
    fn session_auto_compact_borrows_the_catalog_when_the_reading_has_no_window() {
        let mut tokens_only = reading(90_000, 1);
        if let Some(reading) = tokens_only.reading.as_mut() {
            reading.model_context_window = None;
        }
        tokens_only.provider_id = Some("custom".into());
        tokens_only.model_id = Some("local-model".into());
        assert!(!should_auto_compact_session(
            80,
            "custom",
            Some("local-model"),
            None,
            &[tokens_only.clone()]
        ));
        assert!(should_auto_compact_session(
            80,
            "custom",
            Some("local-model"),
            Some(100_000),
            &[tokens_only]
        ));
    }
}
