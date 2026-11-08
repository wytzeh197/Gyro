#[cfg(test)]
use crate::provider_context::ClaudeUsageFrame;
use crate::{
    app::limits::{
        MAX_CHAT_RESPONSE_CHARS, MAX_CODEX_APP_SERVER_ACTIVITIES, MAX_LIVE_RESPONSE_CHARS,
        MAX_PROVIDER_STDOUT_FRAME_BYTES, PROVIDER_CHAT_HEARTBEAT_INTERVAL,
        PROVIDER_STREAM_FLUSH_INTERVAL, TEXT_TRUNCATION_SUFFIX,
    },
    provider_accounting,
    provider_context::ProviderContextUsage,
    provider_run_cleanup::ProviderHeartbeat,
    provider_timeline,
    providers::{
        chat_types::ProviderChatRequest,
        events::{
            emit_provider_chat_event_with_timeline, emit_provider_chat_frame,
            emit_provider_context_usage, peek_provider_event_sequence,
        },
        markers::{publish_stream_session_title, take_visible_stream_text},
        stdout::{handle_provider_stdout_line, separate_streamed_text_block},
        types::ProviderActivity,
    },
    reply_segments::StreamedTextBlock,
    state::{
        managers::{
            ProviderApprovalManager, ProviderCancellationManager, ProviderCapabilityApprovalManager,
        },
        provider_run::{
            stop_provider_run, ProviderStopReason, PROVIDER_STALL_MARKER, PROVIDER_STOP_MARKER,
        },
    },
    text::push_bounded,
    usage::{fetch::publish_settled_provider_usage, types::ProviderRateLimitWindow},
};
use gyro_core::{
    timing, CancellationToken, CredentialPolicy, ExecutionRequest, ExecutionStream,
    ExecutionTermination, HarnessRunStatus, UsageTokens,
};
use std::{
    collections::HashMap,
    path::Path,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager;
use uuid::Uuid;

pub(crate) struct StreamingCommandState {
    pub(crate) activities: Vec<ProviderActivity>,
    pub(crate) context_usage: Option<ProviderContextUsage>,
    /// Whether `context_usage` describes one request rather than a whole turn.
    ///
    /// A turn-wide total is a billing figure: it sums every request the run
    /// made, so it climbs past the context window on any turn that used tools.
    /// Once a per-request reading has landed, a turn-wide one must not replace
    /// it.
    pub(crate) context_usage_is_per_request: bool,
    /// The turn-wide total, kept for the usage ledger.
    ///
    /// Unlike `context_usage` this is never displaced by a per-request
    /// reading: spend is the sum of every request the run made, so a turn that
    /// used tools legitimately bills past the context window.
    pub(crate) billed_usage: Option<ProviderContextUsage>,
    #[cfg(test)]
    pub(crate) claude_request_usage: HashMap<String, ProviderContextUsage>,
    #[cfg(test)]
    pub(crate) claude_usage_final: bool,
    pub(crate) claude_accounting: provider_accounting::ClaudeTurnUsage,
    pub(crate) accounted_usage: Option<UsageTokens>,
    /// Newest reading per window id. A run can announce the same window more
    /// than once, and only the last reading describes where the plan stands.
    pub(crate) rate_limits: Vec<ProviderRateLimitWindow>,
    pub(crate) stdout_text: String,
    pub(crate) stdout_text_chars: usize,
    pub(crate) stdout_text_truncated: bool,
    /// The provider's own copy of the message, in its own coordinate system.
    ///
    /// `assistant_text` is what the transcript shows: decorated with paragraph
    /// breaks between blocks and bounded for the UI. Snapshot and completed
    /// frames describe the former, so reconciling them against the decorated
    /// buffer froze the message at the first break.
    pub(crate) text_stream: gyro_core::text_stream::TextStreamAssembler,
    pub(crate) assistant_text: String,
    pub(crate) assistant_text_chars: usize,
    pub(crate) assistant_text_truncated: bool,
    /// Insert a paragraph break before the next text delta.
    ///
    /// Set when a tool/activity runs (or a new text content block opens) after
    /// the assistant has already spoken. Without it, Claude's next block starts
    /// mid-stream with no leading newline and glues onto the previous sentence.
    pub(crate) text_block_separator_pending: bool,
    /// Where each text block began, in `assistant_text` byte offsets.
    pub(crate) text_blocks: Vec<StreamedTextBlock>,
    pub(crate) pending_delta_chunks: Vec<String>,
    pub(crate) pending_delta_chars: usize,
    pub(crate) pending_timeline: Option<provider_timeline::TimelinePosition>,
    pub(crate) provider_session_id: Option<String>,
    pub(crate) stdout_line_buffer: String,
    /// Set after an oversize frame was dropped: skip to the next newline.
    pub(crate) skipping_oversize_stdout_line: bool,
    /// Whether any stdout line parsed as JSON.
    ///
    /// Separates "this CLI streamed structured output Gyro could not read" from
    /// "this CLI printed plain text", which decide different fallbacks.
    pub(crate) parsed_stream_json: bool,
    pub(crate) last_emit_at: Option<Instant>,
    /// The tail of a `GYRO_SESSION_TITLE` line that is not finished yet.
    /// Nothing in here has been shown.
    pub(crate) session_title_hold: String,
    /// The title from that line, once it was long enough to keep. The visible
    /// transcript does not contain the marker.
    pub(crate) captured_session_title: Option<String>,
    /// Timeline item count when the last text boundary was handled. The
    /// boundary flag only clears once text reaches the timeline, and text held
    /// as a possible title marker never does, so the same boundary must not
    /// split the next chunk off that held prefix (`G` | `YRO_PLAN_UPDATE:`).
    pub(crate) text_boundary_handled_at: Option<u64>,
}

impl StreamingCommandState {
    pub(crate) fn new() -> Self {
        Self {
            activities: Vec::new(),
            context_usage: None,
            context_usage_is_per_request: false,
            billed_usage: None,
            #[cfg(test)]
            claude_request_usage: HashMap::new(),
            #[cfg(test)]
            claude_usage_final: false,
            claude_accounting: provider_accounting::ClaudeTurnUsage::default(),
            accounted_usage: None,
            rate_limits: Vec::new(),
            stdout_text: String::new(),
            stdout_text_chars: 0,
            stdout_text_truncated: false,
            assistant_text: String::new(),
            text_stream: gyro_core::text_stream::TextStreamAssembler::new(),
            assistant_text_chars: 0,
            assistant_text_truncated: false,
            text_block_separator_pending: false,
            text_blocks: Vec::new(),
            pending_delta_chunks: Vec::new(),
            pending_delta_chars: 0,
            pending_timeline: None,
            provider_session_id: None,
            stdout_line_buffer: String::new(),
            skipping_oversize_stdout_line: false,
            parsed_stream_json: false,
            last_emit_at: None,
            session_title_hold: String::new(),
            captured_session_title: None,
            text_boundary_handled_at: None,
        }
    }

    /// Whether a timeline boundary still needs to end the current text block.
    pub(crate) fn take_text_boundary(&mut self, has_boundary: bool, item_count: u64) -> bool {
        if !has_boundary || self.text_boundary_handled_at == Some(item_count) {
            return false;
        }
        self.text_boundary_handled_at = Some(item_count);
        true
    }

    pub(crate) fn note_intervening_work(&mut self) {
        if !self.assistant_text.is_empty() {
            self.text_block_separator_pending = true;
        }
        // A tool call ends the message the provider was writing: what follows
        // describes a new one, so snapshots for it must not be reconciled
        // against the previous block.
        self.text_stream.start_block();
    }

    pub(crate) fn note_new_text_content_block(&mut self) {
        if !self.assistant_text.is_empty() {
            self.text_block_separator_pending = true;
        }
        self.text_stream.start_block();
    }

    /// Fold a Claude Code usage reading into what the meter will report.
    ///
    /// The closing frame is the only one that names the model's context window,
    /// and the per-request frames are the only ones whose counts describe what
    /// the window actually holds, so each contributes what it alone knows.
    #[cfg(test)]
    pub(crate) fn apply_claude_context_usage(
        &mut self,
        frame: ClaudeUsageFrame,
        mut usage: ProviderContextUsage,
        message_id: Option<&str>,
    ) {
        // The ledger takes the turn-wide total when the run reports one, and
        // otherwise accumulates the per-request readings, so a tool-using turn
        // is billed for every request it made rather than only the last.
        match frame {
            ClaudeUsageFrame::Turn => {
                self.claude_usage_final = true;
                self.billed_usage = Some(usage.clone());
            }
            ClaudeUsageFrame::Request => {
                if self.claude_usage_final {
                    return;
                }
                if let Some(id) = message_id.filter(|id| !id.is_empty()) {
                    if let Some(previous) = self.claude_request_usage.get(id) {
                        // Repeated content blocks share one message ID. Their
                        // usage is a snapshot, never another billable request.
                        fn replace(
                            target: &mut Option<u64>,
                            old: Option<u64>,
                            new: &mut Option<u64>,
                        ) {
                            *new = match (*new, old) {
                                (Some(a), Some(b)) => Some(a.max(b)),
                                (a, b) => a.or(b),
                            };
                            if let Some(old) = old {
                                *target = target.map(|value| value.saturating_sub(old));
                            }
                        }
                        if let Some(current) = self.billed_usage.as_mut() {
                            replace(
                                &mut current.input_tokens,
                                previous.input_tokens,
                                &mut usage.input_tokens,
                            );
                            replace(
                                &mut current.output_tokens,
                                previous.output_tokens,
                                &mut usage.output_tokens,
                            );
                            replace(
                                &mut current.cached_input_tokens,
                                previous.cached_input_tokens,
                                &mut usage.cached_input_tokens,
                            );
                            replace(
                                &mut current.reasoning_output_tokens,
                                previous.reasoning_output_tokens,
                                &mut usage.reasoning_output_tokens,
                            );
                            replace(
                                &mut current.total_tokens,
                                previous.total_tokens,
                                &mut usage.total_tokens,
                            );
                        }
                    }
                    self.claude_request_usage
                        .insert(id.to_string(), usage.clone());
                }
                self.accumulate_billed_usage(&usage);
            }
        }
        if let Some(usage) = &self.billed_usage {
            gyro_core::provider_observation::native_usage(provider_accounting::usage_tokens(usage));
        }
        match frame {
            ClaudeUsageFrame::Request => {
                let carried_window = self
                    .context_usage
                    .as_ref()
                    .and_then(|current| current.model_context_window);
                self.context_usage = Some(ProviderContextUsage {
                    model_context_window: usage.model_context_window.or(carried_window),
                    ..usage
                });
                self.context_usage_is_per_request = true;
            }
            ClaudeUsageFrame::Turn => {
                // Aggregate turn spend cannot identify request occupancy.
                if let (Some(current), Some(window)) =
                    (self.context_usage.as_mut(), usage.model_context_window)
                {
                    current.model_context_window = Some(window);
                }
            }
        }
    }

    /// Add one request's usage to the run's billed total.
    ///
    /// Used only until a turn-wide total arrives, which replaces the sum
    /// outright because the provider counted it authoritatively.
    #[cfg(test)]
    pub(crate) fn accumulate_billed_usage(&mut self, usage: &ProviderContextUsage) {
        let Some(current) = self.billed_usage.as_mut() else {
            self.billed_usage = Some(usage.clone());
            return;
        };
        fn add(target: &mut Option<u64>, value: Option<u64>) {
            if let Some(value) = value {
                *target = Some(target.unwrap_or_default().saturating_add(value));
            }
        }
        add(&mut current.input_tokens, usage.input_tokens);
        add(&mut current.cached_input_tokens, usage.cached_input_tokens);
        add(&mut current.output_tokens, usage.output_tokens);
        add(
            &mut current.reasoning_output_tokens,
            usage.reasoning_output_tokens,
        );
        add(&mut current.total_tokens, usage.total_tokens);
        current.model_context_window = usage.model_context_window.or(current.model_context_window);
    }

    pub(crate) fn push_activity(
        &mut self,
        mut activity: ProviderActivity,
    ) -> Option<ProviderActivity> {
        if activity.kind == "commentary" {
            let root_id = activity.id.clone();
            let continuation_prefix = format!("{root_id}::continuation::");
            let segment_indices = self
                .activities
                .iter()
                .enumerate()
                .filter_map(|(index, existing)| {
                    (existing.id == root_id || existing.id.starts_with(&continuation_prefix))
                        .then_some(index)
                })
                .collect::<Vec<_>>();
            if let Some(last_index) = segment_indices.last().copied() {
                let previous_text = segment_indices
                    .iter()
                    .map(|index| self.activities[*index].label.as_str())
                    .collect::<String>();
                if let Some(suffix) = activity.label.strip_prefix(&previous_text) {
                    if suffix.is_empty() {
                        return None;
                    }
                    if last_index + 1 == self.activities.len() {
                        let existing = &mut self.activities[last_index];
                        existing.label.push_str(suffix);
                        existing.status = activity.status;
                        return Some(existing.clone());
                    }
                    activity.label = suffix.to_string();
                } else if last_index + 1 == self.activities.len() {
                    activity.id = self.activities[last_index].id.clone();
                    self.activities[last_index] = activity.clone();
                    return Some(activity);
                }
                activity.id = format!("{root_id}::continuation::{}", self.activities.len());
            }
        }
        if let Some(existing) = self
            .activities
            .iter_mut()
            .find(|existing| existing.id == activity.id)
        {
            if *existing == activity {
                return None;
            }
            *existing = activity.clone();
            return Some(activity);
        }
        if self.activities.len() >= MAX_CODEX_APP_SERVER_ACTIVITIES {
            return None;
        }
        self.activities.push(activity.clone());
        Some(activity)
    }

    pub(crate) fn activity_sequence(&self, activity: &ProviderActivity) -> u64 {
        self.activities
            .iter()
            .position(|candidate| candidate.id == activity.id)
            .unwrap_or(self.activities.len().saturating_sub(1)) as u64
    }

    pub(crate) fn push_stdout(&mut self, line: &str) {
        if self.stdout_text_truncated {
            return;
        }
        self.stdout_text_truncated = push_bounded(
            &mut self.stdout_text,
            &mut self.stdout_text_chars,
            line,
            MAX_CHAT_RESPONSE_CHARS * 4,
        )
        .truncated;
    }

    pub(crate) fn take_stdout_lines(&mut self, chunk: &str) -> Vec<String> {
        self.push_stdout(chunk);
        let mut chunk = chunk;
        if self.skipping_oversize_stdout_line {
            let Some(newline) = chunk.find('\n') else {
                return Vec::new();
            };
            chunk = &chunk[newline + 1..];
            self.skipping_oversize_stdout_line = false;
        }
        self.stdout_line_buffer.push_str(chunk);
        // Provider CLIs can flush thousands of JSON frames in one OS chunk.
        // Draining one line at a time repeatedly shifts the remaining string
        // and becomes quadratic under a busy stream. Separate every complete
        // line with one front-drain, leaving an unterminated tail intact for
        // the next chunk.
        let complete_bytes = self
            .stdout_line_buffer
            .rfind('\n')
            .map(|newline| newline + 1)
            .unwrap_or_default();
        let lines = if complete_bytes == 0 {
            Vec::new()
        } else {
            let complete = self
                .stdout_line_buffer
                .drain(..complete_bytes)
                .collect::<String>();
            complete.split_inclusive('\n').map(str::to_owned).collect()
        };
        // A frame can carry a whole capability result or browser capture, so
        // the bound is the largest bridge message, checked in O(1). A frame
        // past it is dropped whole; its tail is never parsed as a new line.
        if self.stdout_line_buffer.len() > MAX_PROVIDER_STDOUT_FRAME_BYTES {
            self.stdout_line_buffer = String::new();
            self.skipping_oversize_stdout_line = true;
        }
        lines
    }

    pub(crate) fn take_final_stdout_line(&mut self) -> Option<String> {
        (!self.stdout_line_buffer.is_empty()).then(|| std::mem::take(&mut self.stdout_line_buffer))
    }

    /// Show text the provider reported, in the display's own coordinate system.
    pub(crate) fn remember_session_title(&mut self, title: Option<String>) {
        if self.captured_session_title.is_none() {
            self.captured_session_title = title;
        }
    }

    /// A tool call, a new text block, or the end of the run finishes a title
    /// line that never received its newline. The marker stays off the screen.
    pub(crate) fn close_session_title_hold(&mut self) {
        if self.session_title_hold.is_empty() {
            return;
        }
        let filtered = take_visible_stream_text(&mut self.session_title_hold, "", true);
        self.remember_session_title(filtered.title);
        if filtered.visible.is_empty() {
            return;
        }
        self.append_visible_assistant_text(&filtered.visible, false);
    }

    pub(crate) fn push_assistant_text(
        &mut self,
        advance: gyro_core::text_stream::TextStreamAdvance,
    ) {
        if self.assistant_text_truncated {
            return;
        }
        let filtered = take_visible_stream_text(&mut self.session_title_hold, &advance.text, false);
        self.remember_session_title(filtered.title);
        if filtered.visible.is_empty() {
            return;
        }
        self.append_visible_assistant_text(&filtered.visible, advance.starts_block);
    }

    pub(crate) fn append_visible_assistant_text(&mut self, visible: &str, starts_block: bool) {
        if self.assistant_text_truncated {
            return;
        }
        if starts_block && !self.assistant_text.is_empty() {
            self.text_block_separator_pending = true;
        }
        // The title line sat where the paragraph break would have gone. Drop
        // the newlines it left so the break is added once, in front of the text.
        let delta = if self.text_block_separator_pending {
            visible.trim_start_matches(['\n', '\r'])
        } else {
            visible
        };
        if delta.is_empty() {
            return;
        }
        if self.assistant_text.is_empty() || self.text_block_separator_pending {
            self.text_blocks.push(StreamedTextBlock {
                start: self.assistant_text.len(),
                after_activity_id: self.activities.last().map(|activity| activity.id.clone()),
            });
        }
        let separated = if self.text_block_separator_pending {
            self.text_block_separator_pending = false;
            separate_streamed_text_block(&self.assistant_text, delta)
        } else {
            None
        };
        let delta = separated.as_deref().unwrap_or(delta);
        let result = push_bounded(
            &mut self.assistant_text,
            &mut self.assistant_text_chars,
            delta,
            MAX_LIVE_RESPONSE_CHARS,
        );
        self.assistant_text_truncated = result.truncated;
        if result.truncated {
            let mut accepted_delta = delta
                .chars()
                .take(result.accepted_chars)
                .collect::<String>();
            accepted_delta.push_str(TEXT_TRUNCATION_SUFFIX);
            self.push_pending_delta(&accepted_delta);
        } else {
            self.push_pending_delta(delta);
        }
    }

    /// Append an append-only text delta.
    pub(crate) fn push_assistant_delta(&mut self, delta: &str) {
        if let Some(advance) = self.text_stream.push_delta(delta) {
            self.push_assistant_text(advance);
        }
    }

    /// Reconcile a cumulative snapshot of the message being written.
    ///
    /// The comparison runs against the provider's own text, so a paragraph
    /// break the display inserted no longer stops every later snapshot from
    /// matching and freezing the message.
    pub(crate) fn push_assistant_snapshot(&mut self, snapshot: &str) {
        if let Some(advance) = self.text_stream.push_snapshot(snapshot) {
            self.push_assistant_text(advance);
        }
    }

    /// Apply the provider's completed message.
    ///
    /// This used to be discarded whenever any text had streamed, which threw
    /// away the one frame that carries the whole answer exactly when the live
    /// stream had stopped short.
    pub(crate) fn push_assistant_final(&mut self, message: &str) {
        if let Some(advance) = self.text_stream.finish(message) {
            self.push_assistant_text(advance);
        }
    }

    pub(crate) fn push_pending_delta(&mut self, delta: &str) {
        let max_pending_chars = MAX_LIVE_RESPONSE_CHARS + TEXT_TRUNCATION_SUFFIX.len();
        if delta.is_empty() || self.pending_delta_chars >= max_pending_chars {
            return;
        }
        let remaining_chars = max_pending_chars - self.pending_delta_chars;
        let delta_chars = delta.chars().count();
        if delta_chars <= remaining_chars {
            self.pending_delta_chunks.push(delta.to_string());
            self.pending_delta_chars += delta_chars;
            return;
        }
        let truncated_delta = delta.chars().take(remaining_chars).collect::<String>();
        self.pending_delta_chunks.push(truncated_delta);
        self.pending_delta_chars = max_pending_chars;
    }

    pub(crate) fn take_pending_delta(&mut self) -> String {
        self.pending_delta_chars = 0;
        std::mem::take(&mut self.pending_delta_chunks).join("")
    }

    /// Whether the latest state of any tool call is still in flight.
    pub(crate) fn has_running_tool(&self) -> bool {
        let mut latest = HashMap::new();
        for activity in &self.activities {
            latest.insert(activity.id.as_str(), activity.status.as_str());
        }
        latest
            .values()
            .any(|status| matches!(*status, "running" | "queued"))
    }

    pub(crate) fn has_pending_delta(&self) -> bool {
        !self.pending_delta_chunks.is_empty()
    }

    /// A broker call can arrive between checking the text boundary and
    /// recording this chunk. Keep text already buffered at its earlier place.
    pub(crate) fn set_pending_timeline(
        &mut self,
        position: provider_timeline::TimelinePosition,
        previous_chunk_count: usize,
    ) -> Option<(String, provider_timeline::TimelinePosition)> {
        let previous = self.pending_timeline.replace(position.clone())?;
        if previous.timeline_order == position.timeline_order {
            return None;
        }
        let new_chunks = self.pending_delta_chunks.split_off(previous_chunk_count);
        let previous_delta = self.take_pending_delta();
        self.pending_delta_chars = new_chunks.iter().map(|chunk| chunk.chars().count()).sum();
        self.pending_delta_chunks = new_chunks;
        (!previous_delta.is_empty()).then_some((previous_delta, previous))
    }

    pub(crate) fn flush_pending_delta(
        &mut self,
        app: &tauri::AppHandle,
        request: &ProviderChatRequest,
        force: bool,
    ) {
        if force {
            self.close_session_title_hold();
        }
        if !self.has_pending_delta() {
            return;
        }
        if !force
            && self
                .last_emit_at
                .is_some_and(|at| at.elapsed() < PROVIDER_STREAM_FLUSH_INTERVAL)
        {
            return;
        }
        let delta = self.take_pending_delta();
        let timeline = self.pending_timeline.take();
        self.last_emit_at = Some(Instant::now());
        emit_provider_chat_event_with_timeline(
            app,
            request,
            "delta",
            Some(HarnessRunStatus::Running),
            Some(delta),
            None,
            None,
            timeline,
        );
    }
}

/// How long a run may show nothing before its heartbeat says so.
pub(crate) const PROVIDER_CHAT_QUIET_NOTICE: Duration = Duration::from_secs(5 * 60);

/// How long a run has gone without showing the person anything.
///
/// [`ProviderStreamLiveness`] only exists for CLI runs, and it counts raw output,
/// so a chatty process that never surfaces anything reads as active. Every frame
/// a run emits takes a sequence number whichever runner sent it, so a gap in the
/// numbers beyond the heartbeat's own is proof that something else happened.
pub(crate) struct ProviderQuietClock {
    pub(crate) since: Instant,
    pub(crate) expected_sequence: Option<u64>,
}

impl ProviderQuietClock {
    pub(crate) fn new(now: Instant) -> Self {
        Self {
            since: now,
            expected_sequence: None,
        }
    }

    /// Read just before a heartbeat, which is assumed to take `next_sequence`.
    ///
    /// `paused` restarts the clock while the run is waiting on someone else. A
    /// tool that takes ten minutes, or an approval nobody has answered, is not
    /// the run going quiet.
    pub(crate) fn tick(&mut self, next_sequence: u64, paused: bool, now: Instant) -> Duration {
        if paused || self.expected_sequence != Some(next_sequence) {
            self.since = now;
        }
        self.expected_sequence = Some(next_sequence + 1);
        now.saturating_duration_since(self.since)
    }
}

/// What a heartbeat reports for a run that has been quiet this long.
pub(crate) fn provider_quiet_seconds(quiet_for: Duration) -> Option<u64> {
    (quiet_for >= PROVIDER_CHAT_QUIET_NOTICE).then(|| quiet_for.as_secs())
}

/// What the heartbeat reads to tell a quiet run from a stalled one.
pub(crate) struct ProviderStreamLiveness {
    pub(crate) last_output: Mutex<Instant>,
    /// A tool call is in flight, so silence is the tool working.
    pub(crate) tool_running: AtomicBool,
}

impl ProviderStreamLiveness {
    pub(crate) fn new() -> Self {
        Self {
            last_output: Mutex::new(Instant::now()),
            tool_running: AtomicBool::new(false),
        }
    }

    pub(crate) fn silent_for(&self) -> Duration {
        self.last_output
            .lock()
            .map(|last| last.elapsed())
            .unwrap_or_default()
    }
}

/// Whether a silent run has stalled rather than waiting on something real.
pub(crate) fn provider_run_stalled(silent_for: Duration, limit: Duration, waiting: bool) -> bool {
    !waiting && silent_for >= limit
}

/// Whether this chat has a tool approval waiting on the user.
pub(crate) fn provider_session_awaits_approval(app: &tauri::AppHandle, session_id: &str) -> bool {
    let Ok(session_id) = Uuid::parse_str(session_id) else {
        return false;
    };
    let provider = app
        .state::<ProviderApprovalManager>()
        .pending
        .lock()
        .is_ok_and(|pending| pending.values().any(|entry| entry.session_id == session_id));
    provider
        || app
            .state::<ProviderCapabilityApprovalManager>()
            .pending
            .lock()
            .is_ok_and(|pending| pending.values().any(|entry| entry.session_id == session_id))
}

/// Run a provider CLI, streaming its output into the live surfaces.
///
/// `observed_session_id` receives the provider's own session id as soon as the
/// stream reports one, and is written even when the run is stopped, times out,
/// or exits non-zero. That is what lets a turn which never produced an answer
/// still leave behind a cursor a retry can resume from. It stays `None` when
/// the CLI died before acknowledging the session — the case where no resumable
/// conversation exists yet.
///
/// A background heartbeat keeps the desktop turn marked live while the process
/// is still running but quiet (long tools, model thinking). Completion is never
/// inferred from silence — only from process exit after the stdout buffers have
/// been fully drained and the last text delta has been flushed.
///
/// Process inactivity is off at the process level: long tools can produce no
/// stdout for far longer than a half-hour quiet window. The heartbeat instead
/// says when a run has gone quiet, and ends it as stalled only once it has been
/// silent past `inactivity_timeout` with no tool running and no approval
/// waiting on the user.
pub(crate) fn run_streaming_command(
    command: Command,
    stdin_file: Option<&Path>,
    max_runtime: Duration,
    inactivity_timeout: Duration,
    app: &tauri::AppHandle,
    request: &ProviderChatRequest,
    observed_session_id: &mut Option<String>,
) -> anyhow::Result<StreamingCommandOutput> {
    let run_control = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .map_err(|_| anyhow::anyhow!("provider cancellation state is unavailable"))?
        .get(&request.session_id)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("provider turn reservation was lost"))?;
    let mut execution = ExecutionRequest::new(command.get_program().to_os_string());
    execution.args = command.get_args().map(|arg| arg.to_os_string()).collect();
    execution.current_dir = command.get_current_dir().map(Path::to_path_buf);
    execution.env = command
        .get_envs()
        .map(|(key, value)| (key.to_os_string(), value.map(|value| value.to_os_string())))
        .collect();
    execution.stdin_file = stdin_file.map(Path::to_path_buf);
    execution.timeout = max_runtime;
    // An agent run keeps only the provider's own auth: the CLI spawns the
    // agent's tool calls as its children, so anything left here is reachable
    // by everything the agent runs. See gyro_core::credentials.
    execution.credentials = CredentialPolicy::for_provider(&request.provider_id);
    // Silence is not completion for chat provider CLIs.
    execution.inactivity_timeout = None;
    execution.max_stdout_chars = MAX_CHAT_RESPONSE_CHARS * 4;
    execution.max_stderr_chars = MAX_CHAT_RESPONSE_CHARS;
    let mut stream_state = StreamingCommandState::new();
    // Heartbeats share the run's cancellation token and a stop flag so they end
    // the moment the process does — never after completed, and never as a
    // substitute for a real terminal status.
    let heartbeat_stop = Arc::new(AtomicBool::new(false));
    let liveness = Arc::new(ProviderStreamLiveness::new());
    let heartbeat = spawn_provider_chat_heartbeat(
        app.clone(),
        request.clone(),
        run_control.cancellation.clone(),
        heartbeat_stop.clone(),
        Some((liveness.clone(), inactivity_timeout)),
    );
    timing::cli_prompt_on_spawn();
    let outcome = gyro_core::run_command(execution, run_control.cancellation.clone(), |chunk| {
        if let Ok(mut last_output) = liveness.last_output.lock() {
            *last_output = Instant::now();
        }
        if chunk.stream == ExecutionStream::Stdout {
            for line in stream_state.take_stdout_lines(&chunk.text) {
                handle_provider_stdout_line(&line, app, request, &mut stream_state);
            }
            stream_state.flush_pending_delta(app, request, false);
            liveness
                .tool_running
                .store(stream_state.has_running_tool(), Ordering::Relaxed);
        }
    });
    drop(heartbeat);
    // Drain every remaining line and force-flush text before the termination
    // check. Completing with a half-applied buffer is what left the chat looking
    // finished while tokens were still sitting in memory.
    if let Some(line) = stream_state.take_final_stdout_line() {
        handle_provider_stdout_line(&line, app, request, &mut stream_state);
    }
    stream_state.flush_pending_delta(app, request, true);
    publish_stream_session_title(app, request, &stream_state, true);
    // Published before the termination checks below, so a stopped or timed-out
    // run reports the session it started rather than losing it to the bail.
    observed_session_id.clone_from(&stream_state.provider_session_id);
    if outcome.as_ref().is_err() || outcome.as_ref().is_ok_and(|outcome| !outcome.succeeded()) {
        if request.provider_id == "anthropic" {
            stream_state.claude_accounting.interrupt();
            stream_state.accounted_usage = stream_state.claude_accounting.tokens();
        } else {
            stream_state.accounted_usage = stream_state
                .accounted_usage
                .map(|tokens| tokens.partial(gyro_core::usage::UsageReason::Interrupted));
        }
        if let Some(tokens) = stream_state.accounted_usage {
            gyro_core::provider_observation::native_usage(tokens);
            provider_accounting::emit_turn_tokens(app, request, tokens);
        }
    }
    let outcome = outcome?;
    // The last occupancy frame is the one the meter keeps. Emit it again so a
    // frame the UI missed still lands with the turn, and ask the account for
    // the plan level this turn just spent. A stop, timeout, or output limit
    // spent the same window, so those endings ask too.
    if let Some(usage) = &stream_state.context_usage {
        emit_provider_context_usage(app, request, usage);
    }
    publish_settled_provider_usage(app, &request.provider_id);
    match outcome.termination {
        // Nothing else can read the reason back: the token is shared, but the
        // sentence describing why it was cancelled only exists here.
        ExecutionTermination::Cancelled => anyhow::bail!(
            "{}",
            run_control
                .stop_reason
                .lock()
                .ok()
                .and_then(|reason| *reason)
                .unwrap_or(ProviderStopReason::User)
                .message()
        ),
        ExecutionTermination::TimedOut => {
            anyhow::bail!(
                "provider reached the maximum runtime of {} seconds",
                max_runtime.as_secs()
            )
        }
        ExecutionTermination::Inactive => {
            // Chat disables process inactivity; if this fires it is a bug in
            // the request wiring rather than an expected quiet-tool path.
            anyhow::bail!("provider was marked inactive unexpectedly")
        }
        ExecutionTermination::OutputLimit => {
            anyhow::bail!("provider exceeded Gyro's output activity limit")
        }
        ExecutionTermination::Exited { .. } => {}
    }
    let status_label = outcome
        .exit_code()
        .map(|code| format!("exit status: {code}"))
        .unwrap_or_else(|| "terminated by signal".into());
    Ok(StreamingCommandOutput {
        activities: stream_state.activities,
        context_usage: stream_state.context_usage,
        billed_usage: stream_state.billed_usage,
        accounted_usage: stream_state.accounted_usage,
        rate_limits: stream_state.rate_limits,
        status_success: outcome.succeeded(),
        status_label,
        stdout: stream_state.stdout_text,
        stderr: outcome.stderr,
        assistant_text: (!stream_state.assistant_text.trim().is_empty())
            .then_some(stream_state.assistant_text),
        text_blocks: stream_state.text_blocks,
        parsed_stream_json: stream_state.parsed_stream_json,
        provider_session_id: stream_state.provider_session_id,
    })
}

/// Tick the live stream while the provider process is still running.
///
/// Silence is not completion: long tools and thinking produce no frames for
/// minutes. Without these beats the desktop idle watchdog treated the turn as
/// finished and the rail stopped, even though the CLI was still alive.
pub(crate) fn spawn_provider_chat_heartbeat(
    app: tauri::AppHandle,
    request: ProviderChatRequest,
    cancellation: CancellationToken,
    stop: Arc<AtomicBool>,
    liveness: Option<(Arc<ProviderStreamLiveness>, Duration)>,
) -> ProviderHeartbeat {
    let worker_stop = stop.clone();
    let worker = std::thread::spawn(move || {
        let stop = worker_stop;
        let mut quiet_clock = ProviderQuietClock::new(Instant::now());
        loop {
            // Sleep in short slices so stop/cancel is noticed promptly at the
            // end of a run instead of waiting out a full heartbeat interval.
            let deadline = Instant::now() + PROVIDER_CHAT_HEARTBEAT_INTERVAL;
            while Instant::now() < deadline {
                if stop.load(Ordering::Relaxed) || cancellation.is_cancelled() {
                    return;
                }
                std::thread::park_timeout(Duration::from_millis(250));
            }
            if stop.load(Ordering::Relaxed) || cancellation.is_cancelled() {
                return;
            }
            let label = request.provider_label.as_deref().unwrap_or("Provider");
            let awaits_approval = provider_session_awaits_approval(&app, &request.session_id);
            let tool_running = liveness
                .as_ref()
                .is_some_and(|(liveness, _)| liveness.tool_running.load(Ordering::Relaxed));
            if let Some((liveness, limit)) = &liveness {
                let silent_for = liveness.silent_for();
                if provider_run_stalled(silent_for, *limit, tool_running || awaits_approval) {
                    stop_provider_run(
                        &app,
                        &request.session_id,
                        ProviderStopReason::Stalled {
                            silent_minutes: silent_for.as_secs() / 60,
                        },
                    );
                    return;
                }
            }
            let quiet_seconds = peek_provider_event_sequence(&app, &request.session_id)
                .map(|next_sequence| {
                    quiet_clock.tick(
                        next_sequence,
                        tool_running || awaits_approval,
                        Instant::now(),
                    )
                })
                .and_then(provider_quiet_seconds);
            let message = match quiet_seconds {
                Some(seconds) => format!(
                    "{label} is still working, with no activity for {} min",
                    seconds / 60
                ),
                None => format!("{label} is still working"),
            };
            emit_provider_chat_frame(
                &app,
                &request,
                "heartbeat",
                Some(HarnessRunStatus::Running),
                None,
                Some(message),
                None,
                None,
                quiet_seconds,
            );
        }
    });
    ProviderHeartbeat::new(stop, worker)
}

/// Wrap a run failure with the provider's sign-in hint, unless it was a stop.
///
/// The hint earns its place on a run that died on its own, where a lapsed CLI
/// login is the usual cause. On a stop it is noise: being told to sign in again
/// because the turn was stopped buries the one line that says what happened.
pub(crate) fn provider_run_failure(error: anyhow::Error, hint: &str) -> anyhow::Error {
    let message = error.to_string();
    if message.contains(PROVIDER_STOP_MARKER) || message.contains(PROVIDER_STALL_MARKER) {
        return error;
    }
    anyhow::anyhow!("{hint} {error}")
}

/// The sentence describing why this session's run was stopped.
///
/// For the callers that notice a cancelled token themselves rather than through
/// `run_command`. They have to report the same reason the run thread would, or
/// a ceiling Gyro enforced reaches the chat as something the person did.
pub(crate) fn provider_stop_message(app: &tauri::AppHandle, session_id: &str) -> String {
    let manager = app.state::<ProviderCancellationManager>();
    manager
        .flags
        .lock()
        .ok()
        .and_then(|flags| flags.get(session_id).cloned())
        .and_then(|control| control.stop_reason.lock().ok().and_then(|reason| *reason))
        .unwrap_or(ProviderStopReason::User)
        .message()
}

pub(crate) fn provider_chat_cancelled(app: &tauri::AppHandle, session_id: &str) -> bool {
    app.state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .and_then(|flags| flags.get(session_id).cloned())
        .is_some_and(|control| control.cancellation.is_cancelled())
}

pub(crate) use gyro_core::provider_runtime::types::StreamingCommandOutput;

pub(crate) use gyro_core::provider_runtime::limits::{
    PROVIDER_CHAT_INACTIVITY_TIMEOUT_SECS, PROVIDER_CHAT_MAX_RUNTIME_SECS,
};
