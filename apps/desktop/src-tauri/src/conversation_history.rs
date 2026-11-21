use crate::stores::{open_store, parse_uuid};
use gyro_core::{SessionEvent, SessionEventKind, SessionStore};
use std::{borrow::Cow, collections::VecDeque};
use uuid::Uuid;

type HistoryLine<'a> = (&'static str, Cow<'a, str>);

/// Turns kept at full length before the transcript starts clipping harder.
///
/// Recent turns are what the model is actually continuing from, so they stay
/// whole. Older ones only have to carry what was decided, and at the previous
/// flat cap forty of them could put ~20K tokens in front of every prompt.
const HISTORY_RECENT_TURNS: usize = 6;
const HISTORY_RECENT_CHARS: usize = 2_000;
const HISTORY_OLDER_CHARS: usize = 400;

/// A turn's bounded history and the revision read during its compaction check.
/// Prompt assembly verifies the revision before reusing the history.
pub(super) struct PrefetchedHistory {
    session_id: Uuid,
    revision: String,
    text: Option<String>,
}

impl PrefetchedHistory {
    pub(super) fn new(
        session_id: Uuid,
        revision: String,
        events: Vec<SessionEvent>,
    ) -> Option<Self> {
        if model_switch_awaits_first_reply(&events) {
            return None;
        }
        Some(Self {
            session_id,
            revision,
            text: conversation_history_from_events(events),
        })
    }

    fn is_current(&self, store: &SessionStore, session_id: Uuid) -> bool {
        self.session_id == session_id
            && store.transcript_revision(session_id).as_deref().ok() == Some(self.revision.as_str())
    }
}

/// Load the local Gyro transcript for any model handoff or failed resume.
///
/// A failed resume and the first turn after a model switch both use the tapered
/// window: six recent turns stay at 2,000 characters and older turns clip to
/// 400. The current user request is not repeated here.
pub(super) fn conversation_history_text_for_session(
    session_id: &str,
    prefetched_history: Option<PrefetchedHistory>,
) -> Option<String> {
    let session_uuid = parse_uuid(session_id).ok()?;
    let store = open_store().ok()?;
    history_from_store(
        &store,
        session_uuid,
        super::efficiency::config(),
        prefetched_history,
    )
}

fn history_from_store(
    store: &SessionStore,
    session_uuid: Uuid,
    config: gyro_core::efficiency::Config,
    prefetched_history: Option<PrefetchedHistory>,
) -> Option<String> {
    let uses_task_state = config.policies() && config.task_state;
    if let Some(history) = prefetched_history
        .filter(|history| !uses_task_state && history.is_current(store, session_uuid))
    {
        return history.text;
    }
    // Scan the existing bounded event window before selecting conversation.
    // Tool activity must not consume the 40-message history allowance.
    let events = store.read_events(session_uuid).ok()?;
    if model_switch_awaits_first_reply(&events) {
        let transcript = store.read_transcript_events(session_uuid).unwrap_or(events);
        // Model switches use task state independently of experimental prompt
        // compaction. Respect the user's explicit efficiency/task-state opt-outs.
        let checkpoint = if config.enabled && config.task_state {
            store
                .get_session(session_uuid)
                .ok()
                .flatten()
                .and_then(|session| {
                    super::efficiency::checkpoint(
                        store,
                        session_uuid,
                        &session.workspace_path.to_string_lossy(),
                        session.workspace_identity.revision,
                    )
                    .ok()
                })
        } else {
            None
        };
        return model_handoff_history(checkpoint, transcript);
    }
    if uses_task_state {
        let context = store.read_efficiency_context_events(session_uuid).ok()?;
        if let Some(record) = context
            .iter()
            .rev()
            .filter(|e| e.kind == SessionEventKind::TaskCheckpoint)
            .find_map(|e| {
                serde_json::from_value::<gyro_core::efficiency::checkpoint::TaskCheckpoint>(
                    e.payload.clone(),
                )
                .ok()
            })
        {
            let recent = events
                .into_iter()
                .filter(|e| {
                    e.created_at
                        > context
                            .iter()
                            .rev()
                            .find(|e| e.kind == SessionEventKind::TaskCheckpoint)
                            .map(|e| e.created_at)
                            .unwrap_or_default()
                })
                .collect();
            return Some(format!(
                "{}\n{}",
                record.handoff(),
                conversation_history_from_events(recent).unwrap_or_default()
            ));
        }
    }
    conversation_history_from_events(events)
}

/// A model switch needs structured task state as well as the tapered transcript.
/// Checkpoints are context, never proof that old files/checks are still current.
fn model_handoff_history(
    checkpoint: Option<gyro_core::efficiency::checkpoint::TaskCheckpoint>,
    transcript: Vec<SessionEvent>,
) -> Option<String> {
    let history = conversation_history_from_events(transcript).unwrap_or_default();
    let context = checkpoint.and_then(|mut checkpoint| {
        checkpoint.verified = false;
        for file in &mut checkpoint.files {
            file.availability = "revalidate".into();
        }
        for evidence in &mut checkpoint.verification {
            evidence.availability = "revalidate".into();
        }
        checkpoint.validate().ok().map(|_| checkpoint.handoff())
    });
    match context {
        Some(context) => Some(format!(
            "{context}\nRecent conversation (older messages may be clipped; inspect source events for omitted details):\n{history}"
        )),
        None if !history.is_empty() => Some(format!(
            "Structured task context is unavailable or disabled. This bounded transcript may omit earlier constraints, attempts, attachments and evidence. Retrieve required details before continuing; do not assume an interrupted action failed.\n{history}"
        )),
        None => None,
    }
}

fn local_context_checkpoint(event: &SessionEvent) -> Option<&str> {
    (event.kind == SessionEventKind::SystemEvent)
        .then(|| event.payload.get("contextSummary"))
        .flatten()
        .and_then(serde_json::Value::as_str)
}

/// What a manual `/compact` did to the handoff history without a model call.
///
/// Every provider without a resumable compacted session (everything except a
/// Codex session) rewrites the transcript here. The rewrite is local, so the
/// two honest outcomes are `kept` (the history already fit) and `condensed`
/// (full turns were replaced by a digest). Neither is a summary, and callers
/// must not describe it as one.
pub(super) struct LocalCompaction {
    /// The text stored as the checkpoint and sent as the next turn's context.
    pub(super) text: String,
    /// Turns whose full text was replaced by the digest. Zero when the history
    /// already fit the window.
    pub(super) condensed_turns: usize,
    /// A provider wrote this text from the transcript. The local rewrite leaves
    /// it false, so nothing but a real model call is ever called a summary.
    pub(super) summarized: bool,
}

impl LocalCompaction {
    /// A checkpoint a provider wrote, rather than a rewrite of the transcript.
    pub(super) fn summarized(text: String) -> Self {
        Self {
            text,
            condensed_turns: 0,
            summarized: true,
        }
    }

    /// The word the activity row and the transcript card may use.
    pub(super) fn mode(&self) -> &'static str {
        if self.summarized {
            "summarized"
        } else if self.condensed_turns == 0 {
            "kept"
        } else {
            "condensed"
        }
    }
}

pub(super) fn has_reply_since_checkpoint(events: &[SessionEvent]) -> bool {
    let since = events
        .iter()
        .rposition(|event| local_context_checkpoint(event).is_some())
        .map_or(0, |index| index + 1);
    events[since..].iter().any(|event| {
        event.kind == SessionEventKind::AssistantMessage && !event.message.trim().is_empty()
    })
}

pub(super) fn local_compaction_summary(events: &[SessionEvent]) -> Option<LocalCompaction> {
    if !has_reply_since_checkpoint(events) {
        return None;
    }
    let lines = history_lines(events);
    let history = join_history(&lines)?;
    const MAX_CHARS: usize = 8_000;
    if history.chars().count() <= MAX_CHARS {
        return Some(LocalCompaction {
            text: history,
            condensed_turns: 0,
            summarized: false,
        });
    }
    let (prefix, condensed, tail) = split_compacted_history(lines);
    let digest = condensed_turns_digest(&condensed);
    Some(LocalCompaction {
        text: format!(
            "{prefix}\n\n[Earlier turns condensed — full text no longer sent]\n{digest}\n\n{tail}"
        ),
        condensed_turns: condensed.len(),
        summarized: false,
    })
}

/// Split a tapered history into the head, the middle, and the tail.
///
/// The head is background, the tail is the thread being continued, and the
/// middle is what a character cap cannot carry whole. It is returned rather
/// than dropped so the checkpoint can describe it turn by turn instead of
/// leaving a hole where the conversation used to be.
fn split_compacted_history(lines: Vec<HistoryLine<'_>>) -> (String, Vec<HistoryLine<'_>>, String) {
    const PREFIX_CHARS: usize = 1_500;
    const TAIL_CHARS: usize = 4_800;

    let mut prefix = String::new();
    let mut head = 0;
    while head < lines.len() {
        let line = history_line(&lines[head]);
        if prefix.chars().count() + line.chars().count() + 2 > PREFIX_CHARS {
            break;
        }
        if !prefix.is_empty() {
            prefix.push_str("\n\n");
        }
        prefix.push_str(&line);
        head += 1;
    }

    let mut tail_parts: Vec<String> = Vec::new();
    let mut tail_chars = 0;
    let mut end = lines.len();
    while end > head {
        let line = history_line(&lines[end - 1]);
        if tail_chars + line.chars().count() + 2 > TAIL_CHARS {
            break;
        }
        tail_chars += line.chars().count() + 2;
        tail_parts.push(line);
        end -= 1;
    }
    tail_parts.reverse();

    // Keep at least one turn in the middle when there is more history than the
    // head and tail budgets can hold, so a checkpoint always describes what it
    // took out instead of cutting silently.
    if end <= head && head < lines.len() {
        end = head + 1;
    }

    (prefix, lines[head..end].to_vec(), tail_parts.join("\n\n"))
}

/// One line per condensed turn: who spoke and what the turn was about.
///
/// The full text is gone either way; this keeps the decisions and the subject
/// so the next prompt is not starting from a blank where forty turns used to
/// be. No paraphrase is attempted, because that would need a model call and
/// this path deliberately does not make one.
fn condensed_turns_digest(condensed: &[HistoryLine<'_>]) -> String {
    const DIGEST_TURN_CHARS: usize = 200;
    const DIGEST_CHARS: usize = 1_600;

    let mut digest = Vec::new();
    let mut used = 0;
    for (role, text) in condensed {
        let first = text
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or(text.as_ref());
        let clipped: String = first.chars().take(DIGEST_TURN_CHARS).collect();
        let elided = first.chars().count() > DIGEST_TURN_CHARS;
        let line = format!("- {role}: {clipped}{}", if elided { "…" } else { "" });
        // The digest rides in front of the tail inside the same 8,000-character
        // checkpoint budget, so it stops before it can refill the window it is
        // meant to shrink.
        if used + line.chars().count() + 1 > DIGEST_CHARS && !digest.is_empty() {
            break;
        }
        used += line.chars().count() + 1;
        digest.push(line);
    }
    let hidden = condensed.len().saturating_sub(digest.len());
    if hidden > 0 {
        digest.push(format!("- …and {hidden} more turns"));
    }
    digest.join("\n")
}

fn is_model_switch(event: &SessionEvent) -> bool {
    event.kind == SessionEventKind::SystemEvent
        && event
            .payload
            .get("kind")
            .and_then(serde_json::Value::as_str)
            == Some("model-switch")
}

/// True when the latest model switch has not yet received an assistant reply.
///
/// That turn opens a fresh provider session, so the prompt has to carry the
/// chat the previous model already had.
fn model_switch_awaits_first_reply(events: &[SessionEvent]) -> bool {
    let Some(switch_at) = events.iter().rposition(is_model_switch) else {
        return false;
    };
    !events[switch_at + 1..].iter().any(|event| {
        event.kind == SessionEventKind::AssistantMessage && !event.message.trim().is_empty()
    })
}

/// The handoff history as message lines: role plus text, already tapered.
fn history_lines(events: &[SessionEvent]) -> Vec<HistoryLine<'_>> {
    taper_history_lines(conversation_before_current_request(events))
}

fn conversation_before_current_request(events: &[SessionEvent]) -> Vec<HistoryLine<'_>> {
    let mut lines = conversation_lines(events);
    // Drop the trailing user line — it is the message currently being sent and
    // already lives in the main prompt. Dropped before the taper so it does not
    // spend one of the full-length slots on text the prompt already carries.
    if lines.last().is_some_and(|(role, _)| *role == "User") {
        lines.pop();
    }
    lines
}

/// Every spoken turn since the last checkpoint, whole and in order.
fn conversation_lines(events: &[SessionEvent]) -> Vec<HistoryLine<'_>> {
    let mut lines = Vec::new();
    for event in events {
        if let Some(summary) = local_context_checkpoint(event) {
            lines.clear();
            lines.push(("Context summary", Cow::Borrowed(summary)));
            continue;
        }
        if let Some((role, text)) = spoken_line(event) {
            lines.push((role, Cow::Borrowed(text)));
        }
    }
    lines
}

fn spoken_line(event: &SessionEvent) -> Option<(&'static str, &str)> {
    let role = match event.kind {
        SessionEventKind::UserMessage => "User",
        SessionEventKind::AssistantMessage => "Assistant",
        _ => return None,
    };
    let text = event.message.trim();
    (!text.is_empty() && (role != "User" || text != "/compact")).then_some((role, text))
}

fn taper_history_lines(mut lines: Vec<HistoryLine<'_>>) -> Vec<HistoryLine<'_>> {
    if lines.len() > 40 {
        let summary = lines
            .first()
            .filter(|(role, _)| *role == "Context summary")
            .cloned();
        lines.drain(..lines.len() - if summary.is_some() { 39 } else { 40 });
        if let Some(summary) = summary {
            lines.insert(0, summary);
        }
    }
    // Clip from the far end: the tail is the thread being continued, the head
    // is background.
    let recent_from = lines.len().saturating_sub(HISTORY_RECENT_TURNS);
    lines
        .into_iter()
        .enumerate()
        .map(|(index, (role, text))| {
            let budget = if role == "Context summary" {
                8_000
            } else if index >= recent_from {
                HISTORY_RECENT_CHARS
            } else {
                HISTORY_OLDER_CHARS
            };
            let text = match text.char_indices().nth(budget) {
                Some((end, _)) => Cow::Owned(format!("{} […]", &text[..end])),
                None => text,
            };
            (role, text)
        })
        .collect()
}

/// The handoff history as one string: what the model is given when Gyro has to
/// reconstruct the conversation instead of resuming a provider session.
fn conversation_history_from_events(events: Vec<SessionEvent>) -> Option<String> {
    join_history(&history_lines(&events))
}

/// Count the same bounded transcript the owned runners replay. The pending
/// user message travels in the new request and is not history to summarize.
pub(super) fn carried_history_characters(events: &[SessionEvent]) -> u64 {
    let lines = history_lines(events);
    let characters = lines
        .iter()
        .map(|(role, text)| role.len() + 2 + text.chars().count())
        .sum::<usize>();
    (characters + 2 * lines.len().saturating_sub(1)) as u64
}

fn history_line((role, text): &HistoryLine<'_>) -> String {
    format!("{role}: {text}")
}

fn join_history(lines: &[HistoryLine<'_>]) -> Option<String> {
    let joined = lines
        .iter()
        .map(history_line)
        .collect::<Vec<_>>()
        .join("\n\n");
    (!joined.trim().is_empty()).then_some(joined)
}

/// How much transcript one compaction call reads.
///
/// The summary replaces the turns it describes, so the call has to see more
/// than the handoff window does -- but not the whole chat a second time. An
/// over-budget transcript keeps its opening and its newest lines: background
/// plus the thread being continued.
const COMPACTION_TRANSCRIPT_CHARS: usize = 24_000;
const OMITTED_TRANSCRIPT_MIDDLE: &str = "\n\n[middle of this conversation omitted]\n\n";

/// The longest checkpoint a summary may become.
///
/// The checkpoint rides in front of every following prompt, so a model that
/// answers with an essay is cut here instead of refilling the window it was
/// asked to make room in.
const COMPACTION_SUMMARY_CHARS: usize = 8_000;

/// What the summarizer is asked for when `/compact` has no provider-side
/// compaction to call.
pub(super) const COMPACTION_PROMPT: &str = "You are compacting a chat so it \
can continue with less context. Rewrite the conversation below as the \
checkpoint the next turn starts from. Keep: what the user asked for, decisions \
and their reasons, files and symbols touched, commands and their outcomes, and \
the next step that is still open. Drop greetings, repeated tool output, and \
anything the next turn can read from the workspace again. Do not use tools. \
Reply with the checkpoint only: Markdown bullets, at most 400 words, no \
preamble.";

/// The transcript a compaction call reads, from the saved events.
///
/// This is the untapered history: the summarizer is the one reader that has to
/// see whole turns, because its reply is what later prompts get instead of
/// them.
pub(super) fn compaction_transcript_for_session(
    store: &SessionStore,
    session_id: Uuid,
) -> Option<String> {
    let mut transcript = CompactionTranscript::default();
    store
        .visit_transcript_events(session_id, |event| {
            transcript.record(event);
            true
        })
        .ok()?;
    transcript.finish()
}

#[derive(Default)]
struct CompactionTranscript {
    first: String,
    first_chars: usize,
    last: VecDeque<char>,
    omitted_middle: bool,
    pending_user: Option<String>,
}

impl CompactionTranscript {
    fn record(&mut self, event: &SessionEvent) {
        if let Some(summary) = local_context_checkpoint(event) {
            *self = Self::default();
            self.line("Context summary", summary);
            return;
        }
        let Some((role, text)) = spoken_line(event) else {
            return;
        };
        // A trailing user message belongs to the next request. Only include
        // it here if another spoken message follows it.
        if let Some(previous) = self.pending_user.take() {
            self.line("User", &previous);
        }
        if role == "User" {
            self.pending_user = Some(text.to_owned());
        } else {
            self.line(role, text);
        }
    }

    fn line(&mut self, role: &str, text: &str) {
        if !self.first.is_empty() {
            self.append("\n\n");
        }
        self.append(role);
        self.append(": ");
        self.append(text);
    }

    fn append(&mut self, text: &str) {
        const FIRST: usize = COMPACTION_TRANSCRIPT_CHARS / 3;
        const LAST: usize = COMPACTION_TRANSCRIPT_CHARS - FIRST;

        let split = text
            .char_indices()
            .nth(FIRST - self.first_chars)
            .map_or(text.len(), |(index, _)| index);
        let (first, rest) = text.split_at(split);
        self.first.push_str(first);
        self.first_chars += first.chars().count();

        // Keep the end of an oversized message without copying its middle.
        let skip = rest
            .char_indices()
            .rev()
            .nth(LAST)
            .map_or(0, |(index, ch)| index + ch.len_utf8());
        let rest = &rest[skip..];
        let remove = (self.last.len() + rest.chars().count()).saturating_sub(LAST);
        self.omitted_middle |= skip > 0 || remove > 0;
        self.last.drain(..remove);
        self.last.extend(rest.chars());
    }

    fn finish(mut self) -> Option<String> {
        if self.omitted_middle {
            self.first.push_str(OMITTED_TRANSCRIPT_MIDDLE);
        }
        self.first.extend(self.last);
        (!self.first.is_empty()).then_some(self.first)
    }
}

fn bounded_transcript_to(transcript: &str, limit: usize) -> String {
    let total = transcript.chars().count();
    if total <= limit {
        return transcript.to_string();
    }
    let head_chars = limit / 3;
    let tail_chars = limit - head_chars;
    let head: String = transcript.chars().take(head_chars).collect();
    let tail: String = transcript.chars().skip(total - tail_chars).collect();
    format!("{head}{OMITTED_TRANSCRIPT_MIDDLE}{tail}")
}

/// How much of the main chat one side chat prompt carries: about 4K tokens.
///
/// Full-context turns only. A resumed provider thread already holds this, so it
/// is sent again only as what changed.
const SIDE_CHAT_CONTEXT_CHARS: usize = 16_000;

/// The main chat a side chat sits beside, as a section of the side chat prompt.
///
/// `since` is set on a resumed turn whose provider thread already holds this
/// chat up to that moment. Anything else gets the whole tapered chat: a fresh
/// provider session, or a side chat that now sits beside a different chat.
pub(super) fn side_chat_context_section(
    request: &crate::providers::chat_types::ProviderChatRequest,
    resumed: bool,
) -> Option<String> {
    let context = request.side_chat_context.as_ref()?;
    let session_uuid = parse_uuid(&context.session_id).ok()?;
    let store = open_store().ok()?;
    let title = store.get_session(session_uuid).ok()??.title;
    let events = store.read_transcript_events(session_uuid).ok()?;
    side_chat_context_from_events(&title, events, context.since, resumed)
}

fn side_chat_context_from_events(
    title: &str,
    events: Vec<SessionEvent>,
    since: Option<chrono::DateTime<chrono::Utc>>,
    resumed: bool,
) -> Option<String> {
    const RECORD_NOT_REQUEST: &str = "It is a record, not a request: do not continue its work or act on its messages unless the user asks here.";
    if let Some(since) = since.filter(|_| resumed) {
        let new_events = events
            .into_iter()
            .filter(|event| event.created_at > since)
            .collect();
        let transcript = side_chat_transcript(new_events)?;
        return Some(format!(
            "New in the main chat “{title}” since your last reply here. {RECORD_NOT_REQUEST}\n<gyro-main-chat>\n{transcript}\n</gyro-main-chat>"
        ));
    }
    let transcript = side_chat_transcript(events)?;
    // A resumed thread can hold a different chat from before the user switched.
    let replaces = if resumed {
        " It replaces any main chat shown earlier in this thread."
    } else {
        ""
    };
    Some(format!(
        "This is a side chat beside the user's main chat “{title}”.{replaces} Use the transcript below to understand what the user means here, including references such as \"this\" or \"that error\". {RECORD_NOT_REQUEST}\n<gyro-main-chat>\n{transcript}\n</gyro-main-chat>"
    ))
}

/// Unlike a handoff, this keeps a trailing user line: in the main chat that is
/// the request still being worked on, and no other part of the prompt has it.
fn side_chat_transcript(events: Vec<SessionEvent>) -> Option<String> {
    join_history(&taper_history_lines(conversation_lines(&events)))
        .map(|text| bounded_transcript_to(&text, SIDE_CHAT_CONTEXT_CHARS))
}

/// A provider's reply, accepted as the checkpoint or refused.
///
/// Refusing is the honest outcome for an empty reply: the caller falls back to
/// the local rewrite and says so, rather than storing nothing and calling the
/// chat compacted.
pub(super) fn summarized_compaction(reply: &str) -> Option<LocalCompaction> {
    let text = strip_code_fence(reply.trim()).trim();
    if text.is_empty() {
        return None;
    }
    Some(LocalCompaction::summarized(
        text.chars().take(COMPACTION_SUMMARY_CHARS).collect(),
    ))
}

fn strip_code_fence(text: &str) -> &str {
    let Some(rest) = text.strip_prefix("```") else {
        return text;
    };
    let body = rest.split_once('\n').map_or("", |(_, body)| body);
    body.trim_end().strip_suffix("```").unwrap_or(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn interrupted_response_commentary_is_not_replayed_as_a_completed_answer() {
        let session = Uuid::new_v4();
        let mut events = vec![
            SessionEvent::new(
                session,
                SessionEventKind::UserMessage,
                "Explain the file",
                serde_json::json!({}),
            ),
            SessionEvent::new(
                session,
                SessionEventKind::SystemEvent,
                "Partial response (interrupted):\n\nAn unfinished assertion",
                serde_json::json!({"kind":"provider-activity", "activityKind":"commentary", "partialResponse":true}),
            ),
        ];
        assert!(conversation_history_from_events(events.clone()).is_none());
        assert!(local_compaction_summary(&events).is_none());
        events.push(SessionEvent::new(
            session,
            SessionEventKind::AssistantMessage,
            "The verified final answer",
            serde_json::json!({"kind":"provider-response"}),
        ));
        let history = conversation_history_from_events(events).unwrap();
        assert!(history.contains("The verified final answer"));
        assert!(!history.contains("unfinished assertion"));
        assert!(!history.contains("Partial response"));
    }

    #[test]
    fn model_handoff_preserves_structured_constraints_beyond_tapered_history() {
        let session = Uuid::new_v4();
        let mut checkpoint =
            gyro_core::efficiency::checkpoint::TaskCheckpoint::derive(session, &[], "/project", 7);
        checkpoint.objective = "Fix the form".into();
        checkpoint
            .agent_assertions
            .constraints
            .push("Preserve offline support".into());
        checkpoint
            .agent_assertions
            .attempted_approaches
            .push("Do not repeat the failed API-only fix".into());
        checkpoint.verified = true;
        let transcript = (0..50)
            .map(|i| {
                SessionEvent::new(
                    session,
                    SessionEventKind::AssistantMessage,
                    format!("Message {i}"),
                    serde_json::json!({}),
                )
            })
            .collect();
        let history = model_handoff_history(Some(checkpoint), transcript).unwrap();
        assert!(history.contains("Preserve offline support"));
        assert!(history.contains("failed API-only fix"));
        assert!(history.contains(r#""verified":false"#));
        assert!(history.contains("Revalidate file hashes"));
        assert!(history.contains("older messages may be clipped"));
    }

    #[test]
    fn model_handoff_discloses_unavailable_structured_context() {
        let transcript = vec![SessionEvent::new(
            Uuid::new_v4(),
            SessionEventKind::AssistantMessage,
            "Partial work",
            serde_json::json!({}),
        )];
        let history = model_handoff_history(None, transcript).unwrap();
        assert!(history.contains("unavailable or disabled"));
        assert!(history.contains("interrupted action"));
    }

    #[test]
    fn handoff_history_keeps_messages_despite_tool_activity() {
        let session = Uuid::new_v4();
        let event =
            |kind, text: &str| SessionEvent::new(session, kind, text, serde_json::json!({}));
        let mut events = vec![
            event(SessionEventKind::UserMessage, "Keep all tools available"),
            event(SessionEventKind::AssistantMessage, "Understood"),
        ];
        for _ in 0..100 {
            events.push(event(SessionEventKind::SystemEvent, "tool activity"));
        }
        events.push(event(SessionEventKind::UserMessage, "Current request"));
        let history = conversation_history_from_events(events).unwrap();
        assert!(history.contains("Keep all tools available"));
        assert!(history.contains("Understood"));
        assert!(!history.contains("tool activity"));
        assert!(!history.contains("Current request"));
    }

    #[test]
    fn local_compaction_checkpoint_replaces_older_handoff_history() {
        let session = Uuid::new_v4();
        let event =
            |kind, text: &str| SessionEvent::new(session, kind, text, serde_json::json!({}));
        let mut events = vec![
            event(SessionEventKind::UserMessage, "Keep the design blue"),
            event(SessionEventKind::AssistantMessage, "Blue is selected"),
            event(SessionEventKind::UserMessage, "/compact"),
        ];
        let summary = local_compaction_summary(&events).unwrap();
        assert!(summary.text.contains("Keep the design blue"));
        assert!(!summary.text.contains("/compact"));
        // A short chat is kept whole; calling that a summary is the bug this
        // mode exists to prevent.
        assert_eq!(summary.condensed_turns, 0);
        assert_eq!(summary.mode(), "kept");
        let checkpoint = SessionEvent::new(
            session,
            SessionEventKind::SystemEvent,
            "Compacted context",
            serde_json::json!({ "contextSummary": summary.text }),
        );
        events.push(checkpoint);
        events.push(event(SessionEventKind::UserMessage, "Use green instead"));
        events.push(event(
            SessionEventKind::AssistantMessage,
            "Green is selected",
        ));
        let history = conversation_history_from_events(events.clone()).unwrap();
        assert!(history.contains("Context summary:"));
        assert!(history.contains("Use green instead"));
        assert_eq!(history.matches("Keep the design blue").count(), 1);
        assert!(local_compaction_summary(&events).is_some());
    }

    #[test]
    fn local_checkpoint_survives_later_history_taper() {
        let session = Uuid::new_v4();
        let checkpoint = SessionEvent::new(
            session,
            SessionEventKind::SystemEvent,
            "Compacted context",
            serde_json::json!({ "contextSummary": "Important decision ".repeat(180) }),
        );
        let mut events = vec![checkpoint];
        for index in 0..45 {
            events.push(SessionEvent::new(
                session,
                SessionEventKind::AssistantMessage,
                format!("Later reply {index}"),
                serde_json::json!({}),
            ));
        }
        let history = conversation_history_from_events(events).unwrap();
        assert!(history.contains(&"Important decision ".repeat(180)));
        assert!(history.contains("Later reply 44"));
    }

    #[test]
    fn local_compaction_requires_new_reply_and_bounds_checkpoint() {
        let session = Uuid::new_v4();
        let mut events = vec![
            SessionEvent::new(
                session,
                SessionEventKind::UserMessage,
                "Long task",
                serde_json::json!({}),
            ),
            SessionEvent::new(
                session,
                SessionEventKind::AssistantMessage,
                "a".repeat(20_000),
                serde_json::json!({}),
            ),
        ];
        for index in 0..30 {
            events.push(SessionEvent::new(
                session,
                SessionEventKind::AssistantMessage,
                format!("message-{index} {}", "b".repeat(3_000)),
                serde_json::json!({}),
            ));
        }
        let summary = local_compaction_summary(&events).unwrap();
        assert!(summary.text.chars().count() <= 8_000);
        assert!(summary.text.contains("[Earlier turns condensed"));
        assert!(summary.condensed_turns > 0);
        assert_eq!(summary.mode(), "condensed");
        events.push(SessionEvent::new(
            session,
            SessionEventKind::SystemEvent,
            "Compacted context",
            serde_json::json!({ "contextSummary": summary.text }),
        ));
        assert!(local_compaction_summary(&events).is_none());
    }

    #[test]
    fn handoff_history_keeps_its_message_and_character_limits() {
        let session = Uuid::new_v4();
        let events = (0..45)
            .map(|index| {
                SessionEvent::new(
                    session,
                    SessionEventKind::AssistantMessage,
                    format!("message-{index:02} {}", "x".repeat(3_000)),
                    serde_json::json!({}),
                )
            })
            .collect();
        let history = conversation_history_from_events(events).unwrap();
        let messages: Vec<_> = history.split("\n\n").collect();
        assert_eq!(messages.len(), 40);
        assert!(messages[0].starts_with("Assistant: message-05"));
        assert!(messages[39].starts_with("Assistant: message-44"));
        assert!(messages[0].chars().count() < 450);
        assert!(messages[39].chars().count() > 2_000);
        assert!(messages[39].chars().count() < 2_050);
    }

    #[test]
    fn model_switch_handoff_keeps_the_latest_turn_and_clips_older_ones() {
        let session = Uuid::new_v4();
        let mut events: Vec<_> = (0..45)
            .map(|index| {
                SessionEvent::new(
                    session,
                    SessionEventKind::AssistantMessage,
                    format!("message-{index:02} {}", "x".repeat(3_000)),
                    serde_json::json!({}),
                )
            })
            .collect();
        events.push(SessionEvent::new(
            session,
            SessionEventKind::SystemEvent,
            "Switched to Grok 4.7",
            serde_json::json!({"kind": "model-switch", "modelId": "grok-4"}),
        ));
        events.push(SessionEvent::new(
            session,
            SessionEventKind::UserMessage,
            "Current request",
            serde_json::json!({}),
        ));
        assert!(model_switch_awaits_first_reply(&events));
        let history = conversation_history_from_events(events).unwrap();
        let messages: Vec<_> = history.split("\n\n").collect();
        assert_eq!(messages.len(), 40);
        assert!(messages[0].starts_with("Assistant: message-05"));
        assert!(messages[0].contains("[…]"));
        assert!(messages[0].chars().count() < 450);
        assert!(messages[39].starts_with("Assistant: message-44"));
        assert!(messages[39].chars().count() > 2_000);
        assert!(messages[39].chars().count() < 2_050);
        assert!(!history.contains("Current request"));
        assert!(!history.contains("Switched to Grok"));
    }

    #[test]
    fn model_switch_after_a_reply_is_no_longer_the_handoff_turn() {
        let session = Uuid::new_v4();
        let events = vec![
            SessionEvent::new(
                session,
                SessionEventKind::SystemEvent,
                "Switched to Grok 4.7",
                serde_json::json!({"kind": "model-switch"}),
            ),
            SessionEvent::new(
                session,
                SessionEventKind::AssistantMessage,
                "Picked up the thread",
                serde_json::json!({}),
            ),
            SessionEvent::new(
                session,
                SessionEventKind::UserMessage,
                "Next request",
                serde_json::json!({}),
            ),
        ];
        assert!(!model_switch_awaits_first_reply(&events));
    }

    #[test]
    fn prefetched_history_matches_fresh_history_and_expires_after_an_append() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(gyro_core::GyroPaths::from_base_dir(
            temp.path().join("data"),
        ))
        .unwrap();
        let session = store
            .create_session(
                temp.path(),
                gyro_core::SessionOrigin::Desktop,
                "Continue work",
            )
            .unwrap();
        let append = |kind, message, payload| {
            store
                .append_event(session.id, kind, message, payload)
                .unwrap();
        };
        append(
            SessionEventKind::UserMessage,
            "Review the retry loop",
            Value::Null,
        );
        append(
            SessionEventKind::AssistantMessage,
            "The retry limit is three",
            Value::Null,
        );
        append(SessionEventKind::UserMessage, "Proceed", Value::Null);
        let prefetch = || {
            let (events, revision) = store.read_events_with_revision(session.id).unwrap();
            PrefetchedHistory::new(session.id, revision.unwrap(), events)
        };
        let render = |history| history_from_store(&store, session.id, Default::default(), history);
        let snapshot = prefetch().unwrap();
        assert!(snapshot.is_current(&store, session.id));
        assert!(!snapshot.is_current(&store, Uuid::new_v4()));
        assert_eq!(render(Some(snapshot)), render(None));

        let stale = prefetch().unwrap();
        append(
            SessionEventKind::AssistantMessage,
            "The tests passed",
            Value::Null,
        );
        assert!(!stale.is_current(&store, session.id));
        let fresh = render(None).unwrap();
        assert!(fresh.ends_with("Assistant: The tests passed"));
        assert_eq!(render(Some(stale)).as_deref(), Some(fresh.as_str()));

        append(
            SessionEventKind::SystemEvent,
            "Switched model",
            serde_json::json!({"kind":"model-switch"}),
        );
        assert!(prefetch().is_none());
    }

    #[test]
    fn side_chat_opening_turn_carries_the_main_chat_and_its_running_request() {
        let session = Uuid::new_v4();
        let event =
            |kind, text: &str| SessionEvent::new(session, kind, text, serde_json::json!({}));
        let events = vec![
            event(SessionEventKind::UserMessage, "Fix the retry loop"),
            event(SessionEventKind::AssistantMessage, "Fixed in retry.rs"),
            event(SessionEventKind::SystemEvent, "tool activity"),
            event(SessionEventKind::UserMessage, "Now add a test"),
        ];
        let section = side_chat_context_from_events("Retry bug", events, None, false).unwrap();
        assert!(section.contains("main chat “Retry bug”"));
        assert!(section.contains("User: Fix the retry loop"));
        assert!(section.contains("Assistant: Fixed in retry.rs"));
        // The main chat's in-flight request is the part a side question is
        // most likely to be about, so it must survive.
        assert!(section.contains("User: Now add a test"));
        assert!(!section.contains("tool activity"));
        assert!(section.contains("It is a record, not a request"));
        assert!(!section.contains("It replaces any main chat"));
    }

    #[test]
    fn resumed_side_chat_receives_only_what_changed_in_the_main_chat() {
        let session = Uuid::new_v4();
        let at = |seconds, text: &str| {
            let mut event = SessionEvent::new(
                session,
                SessionEventKind::AssistantMessage,
                text,
                serde_json::json!({}),
            );
            event.created_at = chrono::DateTime::from_timestamp(seconds, 0).unwrap();
            event
        };
        let events = vec![at(100, "Old reply"), at(200, "New reply")];
        let since = chrono::DateTime::from_timestamp(150, 0);

        let delta = side_chat_context_from_events("Chat", events.clone(), since, true).unwrap();
        assert!(delta.contains("New reply"));
        assert!(!delta.contains("Old reply"));

        let quiet = chrono::DateTime::from_timestamp(300, 0);
        assert!(side_chat_context_from_events("Chat", events.clone(), quiet, true).is_none());

        // A provider session that did not resume holds nothing, whatever an
        // earlier turn sent.
        let fresh = side_chat_context_from_events("Chat", events.clone(), since, false).unwrap();
        assert!(fresh.contains("Old reply"));
        assert!(fresh.contains("New reply"));

        // No mark on a resumed thread means the side chat moved to another chat.
        let switched = side_chat_context_from_events("Chat", events, None, true).unwrap();
        assert!(switched.contains("Old reply"));
        assert!(switched.contains("It replaces any main chat"));
    }

    #[test]
    fn side_chat_request_accepts_what_the_desktop_sends() {
        let parent = Uuid::new_v4().to_string();
        let parse = |context: serde_json::Value| {
            serde_json::from_value::<crate::providers::chat_types::ProviderChatRequest>(
                serde_json::json!({
                    "sessionId": Uuid::new_v4().to_string(),
                    "providerId": "anthropic",
                    "message": "What does this mean?",
                    "sideChatContext": context,
                }),
            )
            .unwrap()
            .side_chat_context
            .unwrap()
        };
        let opening = parse(serde_json::json!({ "sessionId": parent }));
        assert_eq!(opening.session_id, parent);
        assert!(opening.since.is_none());
        let later = parse(serde_json::json!({
            "sessionId": parent,
            "since": "2026-11-02T10:15:30.123Z",
        }));
        assert_eq!(
            later.since.unwrap().to_rfc3339(),
            "2026-11-02T10:15:30.123+00:00"
        );
    }

    #[test]
    fn side_chat_context_is_bounded_and_empty_chats_add_nothing() {
        let session = Uuid::new_v4();
        let events: Vec<_> = (0..45)
            .map(|index| {
                SessionEvent::new(
                    session,
                    SessionEventKind::AssistantMessage,
                    format!("message-{index:02} {}", "x".repeat(3_000)),
                    serde_json::json!({}),
                )
            })
            .collect();
        let transcript = side_chat_transcript(events).unwrap();
        assert!(transcript.contains("[middle of this conversation omitted]"));
        assert!(transcript.chars().count() < SIDE_CHAT_CONTEXT_CHARS + 60);
        assert!(transcript.contains("message-44"));
        assert!(side_chat_context_from_events("Empty", Vec::new(), None, false).is_none());
    }

    #[test]
    fn summarized_compaction_accepts_a_reply_and_names_itself_summarized() {
        let compaction =
            summarized_compaction("  - Fixed the retry loop\n- Tests green  ").unwrap();
        assert_eq!(compaction.text, "- Fixed the retry loop\n- Tests green");
        assert_eq!(compaction.mode(), "summarized");
        assert_eq!(compaction.condensed_turns, 0);
    }

    #[test]
    fn summarized_compaction_strips_one_code_fence_and_refuses_empty_replies() {
        let fenced = summarized_compaction("```markdown\n- Kept the API stable\n```").unwrap();
        assert_eq!(fenced.text, "- Kept the API stable");
        assert!(summarized_compaction("   \n  ").is_none());
        assert!(summarized_compaction("```\n\n```").is_none());
    }

    #[test]
    fn summarized_compaction_is_cut_to_the_checkpoint_budget() {
        let long = "x".repeat(COMPACTION_SUMMARY_CHARS + 500);
        let compaction = summarized_compaction(&long).unwrap();
        assert_eq!(compaction.text.chars().count(), COMPACTION_SUMMARY_CHARS);
    }

    #[test]
    fn streamed_compaction_matches_the_full_transcript_window() {
        let dir = tempfile::tempdir().unwrap();
        let store =
            SessionStore::open(gyro_core::GyroPaths::from_base_dir(dir.path().join("data")))
                .unwrap();
        let session = store
            .create_session(dir.path(), gyro_core::SessionOrigin::Desktop, "Long chat")
            .unwrap();
        let append = |kind, text: String, payload| {
            store.append_event(session.id, kind, text, payload).unwrap();
        };
        let verify = || {
            let events = store.read_transcript_events(session.id).unwrap();
            let expected = join_history(&conversation_before_current_request(&events))
                .map(|text| bounded_transcript_to(&text, COMPACTION_TRANSCRIPT_CHARS));
            let actual = compaction_transcript_for_session(&store, session.id);
            assert_eq!(actual, expected);
            actual
        };

        append(
            SessionEventKind::UserMessage,
            "Current request".into(),
            Value::Null,
        );
        assert!(verify().is_none());
        // A new checkpoint resets everything, including the pending request.
        append(
            SessionEventKind::SystemEvent,
            "Compacted".into(),
            serde_json::json!({"contextSummary":"Prior state 🦀"}),
        );
        let checkpoint = verify().unwrap();
        assert_eq!(checkpoint, "Context summary: Prior state 🦀");
        append(
            SessionEventKind::UserMessage,
            "  Follow up  ".into(),
            Value::Null,
        );
        let spoken_prefix = format!("{checkpoint}\n\nUser: Follow up\n\nAssistant: ");
        append(
            SessionEventKind::AssistantMessage,
            "水".repeat(COMPACTION_TRANSCRIPT_CHARS - spoken_prefix.chars().count()),
            Value::Null,
        );
        assert!(!verify().unwrap().contains(OMITTED_TRANSCRIPT_MIDDLE));
        append(
            SessionEventKind::AssistantMessage,
            format!("{}latest reply", "あ🚀".repeat(29_000)),
            Value::Null,
        );
        append(
            SessionEventKind::UserMessage,
            "Pending request".into(),
            Value::Null,
        );
        append(
            SessionEventKind::SystemEvent,
            "Tool output".into(),
            serde_json::json!({"output":"build log\n".repeat(10_000)}),
        );
        let bounded = verify().unwrap();
        assert!(bounded.starts_with(&spoken_prefix));
        assert!(bounded.ends_with("latest reply"));
        assert!(bounded.contains(OMITTED_TRANSCRIPT_MIDDLE));
    }
}
