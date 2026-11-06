//! Where a saved reply's streamed text blocks belong on the turn timeline.
use super::*;

/// Where one streamed text block began and the tool it followed, if any.
#[derive(Clone, Debug)]
pub(super) struct StreamedTextBlock {
    /// Byte offset into the raw streamed text.
    pub(super) start: usize,
    pub(super) after_activity_id: Option<String>,
}

/// A runner's raw streamed text and its block starts, kept so the saved reply
/// can record where each block belongs on the timeline.
#[derive(Clone, Debug)]
pub(super) struct StreamedText {
    pub(super) text: String,
    pub(super) blocks: Vec<StreamedTextBlock>,
}

/// Where each streamed text block sits in the saved reply, and which tool it
/// followed.
///
/// A turn's text blocks are saved as one reply. Without these marks, a preamble
/// spoken before the first tool reads as the opening of the answer once the
/// chat is reopened. Offsets are found by text rather than reused, because the
/// saved reply is the stream after control markers and glued blocks were
/// cleaned, and they count UTF-16 units so the renderer can slice with them.
/// `sequence` places a block after the saved tools that preceded it;
/// `afterActivityId` lets a live timeline, which numbers tools differently,
/// place it the same way.
pub(super) fn persisted_text_segments(
    message: &str,
    streamed: &StreamedText,
    activities: &[ProviderActivity],
) -> Option<serde_json::Value> {
    let mut marks: Vec<(usize, Option<&str>)> = Vec::new();
    let mut cursor = 0usize;
    for (index, block) in streamed.blocks.iter().enumerate() {
        let end = streamed
            .blocks
            .get(index + 1)
            .map_or(streamed.text.len(), |next| next.start);
        let Some(raw) = streamed.text.get(block.start..end) else {
            continue;
        };
        let cleaned = strip_hidden_control_markers(raw).message;
        let probe: String = cleaned.trim().chars().take(40).collect();
        if probe.is_empty() {
            continue;
        }
        let Some(found) = message.get(cursor..).and_then(|rest| rest.find(&probe)) else {
            continue;
        };
        let start = cursor + found;
        cursor = start + probe.len();
        let after = block.after_activity_id.as_deref();
        // Consecutive blocks with no tool between them share one place.
        if marks.last().is_some_and(|(_, previous)| *previous == after) {
            continue;
        }
        marks.push((start, after));
    }
    if marks.len() < 2 {
        return None;
    }
    marks[0].0 = 0;
    let mut sequence = 0usize;
    let segments = marks
        .into_iter()
        .map(|(start, after)| {
            if let Some(position) =
                after.and_then(|id| activities.iter().position(|activity| activity.id == id))
            {
                sequence = sequence.max(position + 1);
            }
            serde_json::json!({
                "start": message[..start].encode_utf16().count(),
                "sequence": sequence,
                "afterActivityId": after,
            })
        })
        .collect();
    Some(serde_json::Value::Array(segments))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_replies_record_where_each_streamed_block_began() {
        let activity = |id: &str| ProviderActivity {
            id: id.into(),
            kind: "command".into(),
            label: "Ran command".into(),
            detail: None,
            file_counts: None,
            note: None,
            status: "done".into(),
        };
        let text = "GYRO_SESSION_TITLE: Verify browser\nI'll check the dev server — first.\n\nStill looking.\n\nVerified: the café page works.";
        let at = |needle: &str| text.find(needle).unwrap();
        let streamed = StreamedText {
            text: text.into(),
            blocks: vec![
                StreamedTextBlock {
                    start: 0,
                    after_activity_id: None,
                },
                StreamedTextBlock {
                    start: at("\n\nStill"),
                    after_activity_id: Some("a1".into()),
                },
                StreamedTextBlock {
                    start: at("\n\nVerified"),
                    after_activity_id: Some("a2".into()),
                },
            ],
        };
        let message = strip_hidden_control_markers(text).message;
        let utf16 = |needle: &str| {
            message[..message.find(needle).unwrap()]
                .encode_utf16()
                .count()
        };
        assert!(
            utf16("Still") < message.find("Still").unwrap(),
            "the fixture must cross a multi-byte character so offsets differ",
        );
        assert_eq!(
            persisted_text_segments(&message, &streamed, &[activity("a1"), activity("a2")]),
            Some(serde_json::json!([
                { "start": 0, "sequence": 0, "afterActivityId": null },
                { "start": utf16("Still"), "sequence": 1, "afterActivityId": "a1" },
                { "start": utf16("Verified"), "sequence": 2, "afterActivityId": "a2" },
            ])),
        );
        let single = StreamedText {
            text: "Just an answer.".into(),
            blocks: vec![StreamedTextBlock {
                start: 0,
                after_activity_id: None,
            }],
        };
        assert_eq!(
            persisted_text_segments("Just an answer.", &single, &[]),
            None,
            "a reply with one block needs no marks",
        );
    }
}
