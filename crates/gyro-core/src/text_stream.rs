//! Reconcile the three shapes of provider assistant text into one message.
//!
//! Providers report assistant text in three shapes: append-only deltas,
//! cumulative snapshots of the message being written, and one completed
//! message frame at the end. A turn that uses tools also emits several messages
//! in sequence, and the desktop separates those blocks with a paragraph break
//! so the transcript stays readable.
//!
//! The desktop used to reconcile snapshots against the buffer it had already
//! decorated (`snapshot.strip_prefix(&assistant_text)`). That comparison mixes
//! two coordinate systems: the provider's pristine message and the display's
//! decorated one. The first inserted paragraph break made every later snapshot
//! fail to match, so the message froze at the first text block written after a
//! tool call — exactly where a plan document starts — and the completed message
//! that would have repaired it was thrown away instead.
//!
//! `TextStreamAssembler` keeps the pristine provider text, tracks where the
//! current message begins, and answers one question for every frame: which text
//! has the display not shown yet? It never freezes and never shrinks.

use std::fmt;

/// Longest overlap considered when resynchronising text already streamed.
///
/// A real resync overlaps by the tail of the frame that is still in flight; a
/// rewrite of an earlier paragraph is not something a provider does. Bounding
/// the search keeps resync linear in practice.
const MAX_RESYNC_OVERLAP_CHARS: usize = 4_096;

/// One advance of the visible message.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TextStreamAdvance {
    /// Text the provider has reported that the message does not show yet.
    pub text: String,
    /// Whether `text` opens a new streamed block rather than continuing one.
    pub starts_block: bool,
}

/// Pristine provider text with snapshot and completed-message reconciliation.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TextStreamAssembler {
    /// Everything the provider has reported, in display order but undecorated.
    text: String,
    /// The same text with the paragraph breaks this assembler inserted.
    decorated: String,
    /// Byte offset in `text` where the current message begins.
    block_start: usize,
}

impl TextStreamAssembler {
    pub fn new() -> Self {
        Self::default()
    }

    /// Everything reported so far, without the display's paragraph breaks.
    pub fn text(&self) -> &str {
        &self.text
    }

    /// Whether any text has been reported.
    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }

    /// Close the current message so the next text starts a new block.
    ///
    /// A tool call ends the assistant message that was being written, so the
    /// frame that follows describes a fresh message rather than a continuation.
    pub fn start_block(&mut self) {
        self.block_start = self.text.len();
    }

    /// Append an append-only delta.
    pub fn push_delta(&mut self, delta: &str) -> Option<TextStreamAdvance> {
        if delta.is_empty() {
            return None;
        }
        self.append(delta)
    }

    /// Reconcile a cumulative snapshot of the message being written.
    pub fn push_snapshot(&mut self, snapshot: &str) -> Option<TextStreamAdvance> {
        self.reconcile(snapshot)
    }

    /// Reconcile the completed message.
    ///
    /// The completed frame is authoritative for the text it adds. It never
    /// truncates or rewrites what the display already emitted, because the
    /// visible message was appended in place; a shorter frame is a per-block
    /// repeat, not a correction.
    pub fn finish(&mut self, message: &str) -> Option<TextStreamAdvance> {
        self.reconcile(message)
    }

    fn append(&mut self, segment: &str) -> Option<TextStreamAdvance> {
        if segment.is_empty() {
            return None;
        }
        self.text.push_str(segment);
        self.decorated.push_str(segment);
        Some(TextStreamAdvance {
            text: segment.to_string(),
            starts_block: false,
        })
    }

    /// Append text that belongs to a new message, paragraph-separated.
    fn append_block(&mut self, segment: &str) -> Option<TextStreamAdvance> {
        if segment.is_empty() {
            return None;
        }
        let mut displayed = String::new();
        let starts_block = !self.text.trim().is_empty();
        if starts_block {
            if !self.decorated.ends_with('\n') {
                displayed.push('\n');
            }
            if !self.decorated.ends_with("\n\n") {
                displayed.push('\n');
            }
        }
        displayed.push_str(segment);
        // The text being appended *is* the current message, so the block starts
        // where it begins rather than after it. Marking the end would make the
        // block look empty and treat every later snapshot as a new message.
        self.block_start = self.text.len();
        self.text.push_str(segment);
        self.decorated.push_str(&displayed);
        Some(TextStreamAdvance {
            text: displayed,
            starts_block,
        })
    }

    fn reconcile(&mut self, incoming: &str) -> Option<TextStreamAdvance> {
        if incoming.is_empty() {
            return None;
        }
        if incoming == self.text || incoming == self.decorated {
            return None;
        }
        // A frame that repeats the whole turn, with or without the paragraph
        // breaks the display added between messages. Checked before the current
        // block: the completed message of an earlier block arrives after the
        // tool call that ended it, so it must be recognised rather than
        // appended a second time.
        if let Some(tail) = incoming.strip_prefix(self.text.as_str()) {
            return self.append(tail);
        }
        if let Some(tail) = incoming.strip_prefix(self.decorated.as_str()) {
            return self.append(tail);
        }
        if self.decorated.starts_with(incoming) || self.text.starts_with(incoming) {
            // A stale or partial frame: never shrink what was already shown.
            return None;
        }
        let block = &self.text[self.block_start..];
        if block.is_empty() {
            return self.append_block(incoming);
        }
        // A frame that continues the message being written. This is the case
        // the old prefix check missed once the display had inserted a break.
        if let Some(tail) = incoming.strip_prefix(block) {
            return self.append(tail);
        }
        if block.starts_with(incoming) {
            // A snapshot of a shorter prefix of this block.
            return None;
        }
        // The frame disagrees with the message we hold. Prefer the provider's
        // copy of the tail over dropping the completion entirely.
        if let Some(tail) = tail_after_overlap(block, incoming) {
            return if tail.is_empty() {
                None
            } else {
                self.append(&tail)
            };
        }
        if let Some(tail) = tail_after_overlap(&self.text, incoming) {
            return if tail.is_empty() {
                None
            } else {
                self.append(&tail)
            };
        }
        // Nothing in common: the provider opened a different message.
        self.append_block(incoming)
    }
}

/// The part of `incoming` that follows the longest suffix of `existing` it
/// starts with.
fn tail_after_overlap(existing: &str, incoming: &str) -> Option<String> {
    if existing.is_empty() || incoming.is_empty() {
        return None;
    }
    let max_chars = existing
        .chars()
        .count()
        .min(incoming.chars().count())
        .min(MAX_RESYNC_OVERLAP_CHARS);
    for length in (1..=max_chars).rev() {
        let Some(offset) = incoming.char_indices().nth(length).map(|(index, _)| index) else {
            continue;
        };
        if existing.ends_with(&incoming[..offset]) {
            return Some(incoming[offset..].to_string());
        }
    }
    None
}

impl fmt::Display for TextStreamAssembler {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.text)
    }
}

#[cfg(test)]
mod tests {
    use super::{TextStreamAdvance, TextStreamAssembler};

    fn advance(text: &str, starts_block: bool) -> Option<TextStreamAdvance> {
        Some(TextStreamAdvance {
            text: text.to_string(),
            starts_block,
        })
    }

    #[test]
    fn deltas_append_verbatim() {
        let mut assembler = TextStreamAssembler::new();
        assert_eq!(assembler.push_delta("Hel"), advance("Hel", false));
        assert_eq!(assembler.push_delta("lo"), advance("lo", false));
        assert_eq!(assembler.text(), "Hello");
    }

    #[test]
    fn snapshot_continues_the_message_after_a_block_break() {
        let mut assembler = TextStreamAssembler::new();
        assembler.push_delta("Let me look.");
        // A tool call closes the message; the next text is a new block.
        assembler.start_block();
        assembler.push_delta("# Plan\n\nStep one");
        // The provider's snapshot describes only the message being written.
        assert_eq!(
            assembler.push_snapshot("# Plan\n\nStep one\n\nStep two"),
            advance("\n\nStep two", false)
        );
        assert_eq!(
            assembler.text(),
            "Let me look.# Plan\n\nStep one\n\nStep two"
        );
    }

    #[test]
    fn completed_message_repairs_a_short_stream() {
        let mut assembler = TextStreamAssembler::new();
        assembler.push_delta("Intro paragraph.\n\n");
        assembler.push_delta("The document stops here");
        let complete = "Intro paragraph.\n\nThe document stops here and now carries \
                        every step the user asked for.";
        assert_eq!(
            assembler.push_snapshot(complete),
            advance(" and now carries every step the user asked for.", false)
        );
    }

    #[test]
    fn stale_snapshot_never_shrinks_the_message() {
        let mut assembler = TextStreamAssembler::new();
        assembler.push_delta("The full answer");
        assert_eq!(assembler.push_snapshot("The full"), None);
        assert_eq!(assembler.text(), "The full answer");
    }

    #[test]
    fn completed_message_of_an_earlier_block_is_not_appended_twice() {
        let mut assembler = TextStreamAssembler::new();
        assembler.push_delta("Let me look at the code.");
        // The tool call that followed the message closes its block, and the
        // provider then reports the message it just finished.
        assembler.start_block();
        assert_eq!(assembler.finish("Let me look at the code."), None);
        assert_eq!(assembler.text(), "Let me look at the code.");
    }

    #[test]
    fn whole_turn_final_without_our_breaks_is_not_duplicated() {
        let mut assembler = TextStreamAssembler::new();
        assembler.push_delta("First message.");
        assembler.start_block();
        assembler.push_delta("Second message.");
        // The turn's completed message repeats both blocks without the break
        // the display inserts between them.
        assert_eq!(assembler.finish("First message.Second message."), None);
        assert_eq!(assembler.text(), "First message.Second message.");
    }

    #[test]
    fn diverging_snapshot_appends_only_what_is_missing() {
        let mut assembler = TextStreamAssembler::new();
        assembler.push_delta("Step one and step two");
        assert_eq!(
            assembler.push_snapshot("Step one and step two, step three"),
            advance(", step three", false)
        );
    }

    #[test]
    fn unrelated_frame_opens_a_separated_block() {
        let mut assembler = TextStreamAssembler::new();
        assembler.push_delta("Intro.");
        assembler.start_block();
        assert_eq!(assembler.push_snapshot("Zebra"), advance("\n\nZebra", true));
        assert_eq!(assembler.text(), "Intro.Zebra");
        assert_eq!(assembler.decorated, "Intro.\n\nZebra");
    }

    #[test]
    fn empty_frames_are_ignored() {
        let mut assembler = TextStreamAssembler::new();
        assert_eq!(assembler.push_delta(""), None);
        assert_eq!(assembler.push_snapshot(""), None);
        assert_eq!(assembler.finish(""), None);
        assert!(assembler.is_empty());
    }
}
