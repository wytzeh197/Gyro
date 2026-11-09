//! Shared provider usage normalization, context checkpoints and compaction policy.
use super::types::ProviderContextUsage;
use serde_json::Value;
#[derive(Default)]
pub struct OllamaTurnUsage {
    requests: usize,
    incomplete: bool,
    input: u64,
    output: u64,
}

/// Marker that opens the live context note, so a runner can recognize the
/// note it wrote earlier in its own message list and rewrite that entry
/// instead of appending a fresh copy every round.
pub const CONTEXT_CHECKPOINT_MARKER: &str = "[gyro.ctx]";

/// One line telling the model how full its context window is, from counts the
/// provider itself reported.
///
/// The runner's own tool loop writes this between requests, because that is
/// the only place a request's real occupancy is known: a model that can see
/// how much of its window the previous request held can size its own reads,
/// which is its one lever over how fast a turn fills up. `None` without a
/// prompt count, because a percentage derived from nothing is a guess the
/// model cannot tell apart from a measurement.
pub fn context_checkpoint_note(
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
pub fn refresh_context_checkpoint(
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

pub fn is_context_checkpoint(message: &Value) -> bool {
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
pub const CONTEXT_COMPACTION_MARKER: &str = "[gyro.compact]";

/// What one automatic compaction removed, for the activity that reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ContextCompaction {
    /// Tool exchanges dropped from the in-flight list.
    pub exchanges: usize,
    /// Estimated text characters removed; encoded image bytes are excluded.
    pub characters: u64,
    /// Measured fill of the window when the compaction fired.
    pub percent: u64,
}

/// Rough tokens for text this crate must not pretend to have tokenized.
///
/// Four characters per token is the usual English/markdown average and the only
/// honest bridge between a character budget and a token window without a
/// tokenizer the provider may not share. Every use of it is reported as an
/// estimate, never as a measurement.
pub const CHARS_PER_TOKEN: u64 = 4;

/// Smallest tail of recent messages a compaction always leaves behind.
///
/// A rewrite that kept nothing would drop the conversation the model is
/// continuing from, which is worse than a full window, so the newest exchange
/// and the head are never elided no matter how tight the budget is.
pub const MIN_COMPACTED_TAIL_CHARS: u64 = 8_000;

/// Share of the trigger the retained tail is budgeted to, as a divisor.
///
/// Compacting back to the same share that triggered it would free nothing: the
/// next tool round crosses the line again. Halving it leaves real room to keep
/// working, which is the whole point of compacting before the window is full.
pub const COMPACT_TARGET_DIVISOR: u64 = 2;

/// How full the previous request left the window, when that is enough to
/// compact. `None` without a window, a measurement, or an enabled threshold.
pub fn auto_compaction_fill(
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
/// A provider that reports no usage of its own is measured from the list it is
/// about to resend, so the rewrite is not limited to adapters that count their
/// own tokens.
///
/// This is the local half of what `/compact` does for a chat: the oldest tool
/// exchanges are replaced by one note that says what was removed and that the
/// work already done stands. The newest exchange and the head are never
/// touched, a tool result is never kept without the call it answers, and the
/// note replaces the previous note rather than stacking -- so a fifty-round
/// turn pays for exactly one note per request, the same economy the live
/// context note uses.
pub fn auto_compact_messages(
    messages: &mut Vec<Value>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    model_context_window: Option<u64>,
    percent: u32,
) -> Option<ContextCompaction> {
    let window = model_context_window.filter(|window| *window > 0)?;
    // A provider that reports no counts still resends this list on every
    // round, so the text it carries is the size to watch. Without it, the
    // rewrite silently covered only adapters that measure themselves.
    let input_tokens = match input_tokens {
        Some(measured) => Some(measured),
        None => {
            let characters = messages
                .iter()
                .map(|message| message_size(message).0)
                .sum::<u64>();
            Some(estimated_tokens(characters)).filter(|tokens| *tokens > 0)
        }
    };
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

pub fn auto_compaction_note(compaction: &ContextCompaction, window: u64, percent: u32) -> String {
    format!(
        "{CONTEXT_COMPACTION_MARKER} At {}% of the {window}-token window (trigger {percent}%), the {exchanges} oldest tool exchanges were replaced: about {tokens} estimated text tokens. Completed actions still stand. Re-read missing data; inspect current state before retrying an action whose result was removed.",
        compaction.percent,
        exchanges = compaction.exchanges,
        tokens = estimated_tokens(compaction.characters),
    )
}

/// The token estimate for a character count, for the surfaces that name one.
pub fn estimated_tokens(characters: u64) -> u64 {
    characters.div_ceil(CHARS_PER_TOKEN)
}

pub fn is_context_compaction(message: &Value) -> bool {
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
pub struct AutoCompactReading {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub model_context_window: Option<u64>,
}

/// One persisted chat event, reduced to what the auto-compact decision needs.
#[derive(Clone, Debug)]
pub struct SessionContextSignal {
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub reading: Option<AutoCompactReading>,
    /// A session rewrite, the same kind `/compact` records. An in-loop note
    /// does not set this: that rewrite never replaces the resumed session.
    pub session_compaction: bool,
    /// Text this event would carry into the next prompt, excluding encoded
    /// image bytes. The provider's own count is preferred when it exists; this
    /// is what a silent adapter leaves to watch.
    pub characters: u64,
}

/// Whether the next turn should compact before it sends, for any provider.
///
/// The tool-loop rewrite only sees messages Gyro owns. Codex, Claude, Grok,
/// Kimi, Antigravity, and any other resumed session keep their own transcript,
/// so the decision lives here and the caller runs the same compaction `/compact`
/// runs. Two fills are weighed and the larger one decides: the provider's own
/// prompt count when it reported one, and the text this session would carry,
/// estimated from the stored events. A silent adapter -- a local server, a
/// gateway, a CLI that never says how full its window is -- reports no count,
/// and on the reported number alone those sessions grew until the provider
/// truncated them. The estimate is a lower bound, so it can only bring
/// compaction forward to where the transcript itself already reached the
/// share. A switched-off setting, an unknown window (a share of an unknown
/// window is not a measurement), or a compaction that already rewrote the
/// transcript since the last reading still decline. The catalog fills in when
/// the reading named tokens but not a size.
pub fn should_auto_compact_session(
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
    let mut carried = 0u64;
    for signal in signals {
        if signal.session_compaction {
            // The next prompt resumes from this summary, so what came before it
            // is no longer sent and the measurement that described it is spent.
            carried = signal.characters;
            reading = None;
            continue;
        }
        if signal_is_for_other_model(signal, provider_id, model_id) {
            continue;
        }
        carried = carried.saturating_add(signal.characters);
        if let Some(next) = signal.reading.clone() {
            reading = Some(next);
        }
    }
    let measured = reading.as_ref().and_then(|reading| reading.input_tokens);
    let window = reading
        .as_ref()
        .and_then(|reading| reading.model_context_window)
        .filter(|window| *window > 0)
        .or(catalog_window.filter(|window| *window > 0));
    // The transcript is a lower bound of the next prompt: it leaves out the
    // system prompt and the provider's own tools. Taking the larger of the two
    // fills therefore never compacts earlier than the session itself has
    // reached the share, and it keeps a silent adapter from never compacting.
    let estimated = (carried > 0).then(|| estimated_tokens(carried));
    let input_tokens = match (measured, estimated) {
        (Some(measured), Some(estimated)) => Some(measured.max(estimated)),
        (measured, estimated) => measured.or(estimated),
    };
    auto_compaction_fill(
        input_tokens,
        reading.as_ref().and_then(|reading| reading.output_tokens),
        window,
        percent,
    )
    .is_some()
}

pub fn signal_is_for_other_model(
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

pub fn message_role(message: &Value) -> Option<&str> {
    message.get("role").and_then(Value::as_str)
}

pub fn carries_tool_calls(message: &Value) -> bool {
    message
        .get("tool_calls")
        .and_then(Value::as_array)
        .is_some_and(|calls| !calls.is_empty())
}

pub fn carries_compatibility_tool_call(message: &Value) -> bool {
    message_role(message) == Some("assistant")
        && message
            .get("content")
            .and_then(Value::as_str)
            .and_then(|content| serde_json::from_str::<Value>(content).ok())
            .is_some_and(|action| action.get("type").and_then(Value::as_str) == Some("tool"))
}

/// Text and schema characters of a message, excluding encoded image bytes.
/// Image token costs are provider-owned and cannot be inferred from base64.
pub fn message_size(message: &Value) -> (u64, bool) {
    let (characters, image) = crate::provider_observation::text_size(message);
    (characters as u64, image)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaudeUsageFrame {
    Request,
    Turn,
}

/// What one Antigravity step sent the model: its own prompt and reply.
///
/// `step_update` usage is per step (the `result` frame's is cumulative, and on
/// a resumed conversation spans earlier turns), and its `input_tokens` already
/// counts the cache-read share, so the latest step's prompt is the occupancy.
/// The window comes from the catalog; the CLI does not report one.
pub fn antigravity_step_occupancy(value: &Value) -> Option<ProviderContextUsage> {
    let (event, _) = crate::antigravity_cli::frame(value)?;
    if event != "step_update" {
        return None;
    }
    let usage = crate::antigravity_cli::usage(value)?;
    if usage.input_tokens == 0 {
        return None;
    }
    Some(ProviderContextUsage {
        input_tokens: Some(usage.input_tokens),
        cached_input_tokens: Some(usage.cache_read_tokens),
        output_tokens: Some(usage.output_tokens),
        reasoning_output_tokens: Some(usage.thinking_tokens),
        total_tokens: Some(usage.input_tokens.saturating_add(usage.output_tokens)),
        model_context_window: None,
        ..ProviderContextUsage::default()
    })
}

/// Occupancy of one completed model request.
///
/// The prompt count is what that request held, and output is what it added.
/// Cache and reasoning are copied only when the provider reported those
/// buckets. A missing prompt count is not occupancy. Pass one request, never
/// a turn's summed bill.
pub fn occupancy_from_request(
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    accounted: &crate::usage::UsageTokens,
    model_context_window: Option<u64>,
) -> Option<ProviderContextUsage> {
    let accounting = accounted.effective_accounting();
    if !accounting.known.input
        || matches!(
            accounting.coverage,
            crate::usage::UsageCoverage::Estimated | crate::usage::UsageCoverage::Unavailable
        )
    {
        return None;
    }
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

pub fn provider_context_usage_from_codex_exec(value: &Value) -> Option<ProviderContextUsage> {
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

pub fn provider_context_usage_from_claude_stream(
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

pub fn claude_stream_context_window(value: &Value) -> Option<u64> {
    let entries = value.get("modelUsage")?.as_object()?;
    let mut windows = entries
        .values()
        .filter_map(|entry| entry.get("contextWindow").and_then(Value::as_u64));
    let window = windows.next()?;
    // A mixed-model result cannot identify which window the last request used.
    windows.all(|other| other == window).then_some(window)
}

pub fn exceeds_context_window(usage: &ProviderContextUsage) -> bool {
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

impl OllamaTurnUsage {
    pub fn observe(&mut self, input: Option<u64>, output: Option<u64>) {
        self.requests += 1;
        if let (Some(input), Some(output)) = (input, output) {
            self.input = self.input.saturating_add(input);
            self.output = self.output.saturating_add(output);
        } else {
            self.incomplete = true;
        }
    }

    pub fn measured(&self) -> Option<ProviderContextUsage> {
        (self.requests > 0 && !self.incomplete).then(|| ProviderContextUsage {
            input_tokens: Some(self.input),
            output_tokens: Some(self.output),
            total_tokens: Some(self.input.saturating_add(self.output)),
            ..ProviderContextUsage::default()
        })
    }
}

/// The activity row for one automatic compaction inside a tool loop.
///
/// Its id deliberately does not start with `context-compaction-`: that prefix
/// marks the manual `/compact`, and the composer meter starts its estimate over
/// on one, which an in-flight rewrite must not do -- the chat's stored history
/// is untouched, so every earlier reading still measures it.
pub fn activity(index: usize, compaction: &ContextCompaction) -> super::types::ProviderActivity {
    super::types::ProviderActivity {
        id: format!("context-auto-compaction-{index}"),
        kind: "context".into(),
        label: "Auto-compacted context".into(),
        detail: Some(format!(
            "The last request filled {}% of the window, so {} older tool exchanges, about {} tokens, were replaced for the rest of this turn.",
            compaction.percent,
            compaction.exchanges,
            estimated_tokens(compaction.characters)
        )),
        file_counts: None,
        note: None,
        status: "done".into(),
    }
}
