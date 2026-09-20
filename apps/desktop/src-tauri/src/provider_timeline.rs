//! One chronology for provider frames and broker calls, independent of the
//! contiguous provider-stream delivery counter.
use super::*;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TimelinePosition {
    pub(super) timeline_order: u64,
    pub(super) timeline_created_at: String,
}

impl TimelinePosition {
    pub(super) fn insert_into(&self, payload: &mut serde_json::Value) {
        payload["timelineOrder"] = serde_json::json!(self.timeline_order);
        payload["timelineCreatedAt"] = serde_json::json!(self.timeline_created_at);
    }
}

#[derive(Clone)]
struct CommentaryTimeline {
    label: String,
    segments: Vec<serde_json::Value>,
}

#[derive(Default)]
pub(super) struct ProviderTimeline {
    next_order: u64,
    first_seen: HashMap<String, TimelinePosition>,
    text: String,
    blocks: Vec<(usize, TimelinePosition)>,
    text_boundary: bool,
    last_item_key: Option<String>,
    commentary: HashMap<String, CommentaryTimeline>,
}

impl ProviderTimeline {
    fn next_position(&mut self) -> TimelinePosition {
        let position = TimelinePosition {
            timeline_order: self.next_order,
            timeline_created_at: chrono::Utc::now().to_rfc3339(),
        };
        self.next_order += 1;
        position
    }

    fn observe(&mut self, key: Option<&str>, delta: Option<&str>) -> TimelinePosition {
        if let Some(key) = key {
            if let Some(position) = self.first_seen.get(key) {
                // A command finishing (or being saved) updates the original
                // item. It did not insert fresh work into the current sentence.
                return position.clone();
            }
            let position = self.next_position();
            self.first_seen.insert(key.to_string(), position.clone());
            self.last_item_key = Some(key.to_string());
            self.text_boundary = true;
            return position;
        }
        if let Some(delta) = delta.filter(|delta| !delta.is_empty()) {
            self.last_item_key = None;
            let position = if self.blocks.is_empty() || self.text_boundary {
                let position = self.next_position();
                self.blocks.push((self.text.len(), position.clone()));
                position
            } else {
                // A stream flush is a transport boundary, not a new text
                // block. Every continuation keeps the first token's position.
                self.blocks.last().expect("text block exists").1.clone()
            };
            self.text_boundary = false;
            if self.text.len() < MAX_CHAT_RESPONSE_CHARS * 4 {
                // Match the response bound while keeping UTF-8 boundaries.
                let remaining = MAX_CHAT_RESPONSE_CHARS * 4 - self.text.len();
                let end = delta
                    .char_indices()
                    .map(|(index, _)| index)
                    .chain(std::iter::once(delta.len()))
                    .take_while(|index| *index <= remaining)
                    .last()
                    .unwrap_or(0);
                self.text.push_str(&delta[..end]);
            }
            return position;
        }
        // Heartbeats and status frames need an order but cannot break a text
        // block or cause a cumulative commentary snapshot to split.
        self.next_position()
    }

    fn activity(
        &mut self,
        activity: &ProviderActivity,
    ) -> (TimelinePosition, Option<serde_json::Value>) {
        let key = format!("activity:{}", activity.id);
        let intervened = self.last_item_key.as_deref() != Some(key.as_str());
        let previous = self.commentary.get(&key).cloned();
        let position = self.observe(Some(&key), None);
        if activity.kind != "commentary" {
            return (position, None);
        }
        let mut segments = previous
            .as_ref()
            .map(|value| value.segments.clone())
            .unwrap_or_default();
        if let Some(previous) = previous {
            if activity.label != previous.label
                && intervened
                && activity.label.starts_with(&previous.label)
            {
                let continuation = self.next_position();
                segments.push(serde_json::json!({
                    "start": previous.label.encode_utf16().count(),
                    "timelineOrder": continuation.timeline_order,
                    "createdAt": continuation.timeline_created_at,
                }));
                self.last_item_key = Some(key.clone());
                self.text_boundary = true;
            } else if !activity.label.starts_with(&previous.label) {
                // Replacements invalidate text offsets. Never reuse stale marks.
                segments.clear();
            }
        }
        if segments.is_empty() {
            segments.push(serde_json::json!({
                "start": 0,
                "timelineOrder": position.timeline_order,
                "createdAt": position.timeline_created_at,
            }));
        }
        self.commentary.insert(
            key,
            CommentaryTimeline {
                label: activity.label.clone(),
                segments: segments.clone(),
            },
        );
        (position, Some(serde_json::Value::Array(segments)))
    }

    /// Match recorded stream blocks against the cleaned saved reply. Byte
    /// offsets from the stream cannot be reused after hidden-marker removal.
    fn response_segments(&self, message: &str) -> Option<serde_json::Value> {
        let mut segments = Vec::new();
        let mut cursor = 0;
        for (index, (start, position)) in self.blocks.iter().enumerate() {
            let end = self
                .blocks
                .get(index + 1)
                .map_or(self.text.len(), |next| next.0);
            let cleaned = strip_hidden_control_markers(self.text.get(*start..end)?).message;
            let block = cleaned.trim();
            if block.is_empty() {
                continue;
            }
            let remaining = message.get(cursor..)?;
            let found = remaining.find(block)?;
            // Only separators may sit between recorded blocks. Partial text
            // matches could otherwise pull an edited final answer back before
            // the tool whose result it describes.
            if !remaining[..found].trim().is_empty() {
                return None;
            }
            let start = cursor + found;
            cursor = start + block.len();
            segments.push(serde_json::json!({
                "start": message[..start].encode_utf16().count(),
                "timelineOrder": position.timeline_order,
                "createdAt": position.timeline_created_at,
            }));
        }
        if segments.len() < 2 || !message.get(cursor..)?.trim().is_empty() {
            return None;
        }
        segments[0]["start"] = serde_json::json!(0);
        Some(serde_json::Value::Array(segments))
    }
}

pub(super) fn observe(
    app: &tauri::AppHandle,
    session_id: &str,
    key: Option<&str>,
    delta: Option<&str>,
) -> TimelinePosition {
    let control = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .and_then(|flags| flags.get(session_id).cloned());
    if let Some(control) = control {
        if let Ok(mut timeline) = control.timeline.lock() {
            return timeline.observe(key, delta);
        }
    }
    // Teardown events still receive unique ordering without consuming stream
    // frame numbers (whose continuity is enforced by the frontend).
    static FALLBACK_ORDER: AtomicU64 = AtomicU64::new(1 << 48);
    TimelinePosition {
        timeline_order: FALLBACK_ORDER.fetch_add(1, Ordering::Relaxed),
        timeline_created_at: chrono::Utc::now().to_rfc3339(),
    }
}

pub(super) fn activity(
    app: &tauri::AppHandle,
    session_id: &str,
    activity: &ProviderActivity,
) -> (TimelinePosition, Option<serde_json::Value>) {
    let control = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .and_then(|flags| flags.get(session_id).cloned());
    if let Some(control) = control {
        if let Ok(mut timeline) = control.timeline.lock() {
            return timeline.activity(activity);
        }
    }
    (
        observe(
            app,
            session_id,
            Some(&format!("activity:{}", activity.id)),
            None,
        ),
        None,
    )
}

pub(super) fn text_has_boundary(app: &tauri::AppHandle, session_id: &str) -> bool {
    let control = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()
        .and_then(|flags| flags.get(session_id).cloned());
    control
        .and_then(|control| {
            control
                .timeline
                .lock()
                .ok()
                .map(|timeline| timeline.text_boundary)
        })
        .unwrap_or(false)
}

pub(super) fn response_segments(
    app: &tauri::AppHandle,
    session_id: &str,
    message: &str,
) -> Option<serde_json::Value> {
    let control = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .ok()?
        .get(session_id)
        .cloned()?;
    let timeline = control.timeline.lock().ok()?;
    timeline.response_segments(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commentary(label: &str) -> ProviderActivity {
        ProviderActivity {
            id: "commentary".into(),
            kind: "commentary".into(),
            label: label.into(),
            detail: None,
            file_counts: None,
            note: None,
            status: "done".into(),
        }
    }

    #[test]
    fn token_deltas_and_heartbeats_keep_one_text_block_position() {
        let mut timeline = ProviderTimeline::default();
        let first = timeline.observe(None, Some("Checking"));
        timeline.observe(None, None); // heartbeat
        assert_eq!(first, timeline.observe(None, Some(" the")));
        assert_eq!(first, timeline.observe(None, Some(" file.")));
        assert_eq!(timeline.blocks.len(), 1);
        assert_eq!(timeline.text, "Checking the file.");

        let tool = timeline.observe(Some("capability:read"), None);
        let next = timeline.observe(None, Some("It is"));
        assert!(first.timeline_order < tool.timeline_order);
        assert!(tool.timeline_order < next.timeline_order);
        assert_eq!(next, timeline.observe(None, Some(" ready.")));
        assert_eq!(timeline.blocks.len(), 2);
    }

    #[test]
    fn old_tool_updates_and_persistence_replay_do_not_split_a_sentence() {
        let mut timeline = ProviderTimeline::default();
        let tool = timeline.observe(Some("capability:read"), None);
        let text = timeline.observe(None, Some("The file"));
        assert_eq!(tool, timeline.observe(Some("capability:read"), None));
        assert!(!timeline.text_boundary);
        assert_eq!(text, timeline.observe(None, Some(" is ready.")));
        assert_eq!(timeline.blocks.len(), 1);
    }

    #[test]
    fn cumulative_commentary_splits_only_after_new_work_and_uses_utf16_offsets() {
        let mut timeline = ProviderTimeline::default();
        let opening = "I'll inspect café 🦀.";
        let (first, _) = timeline.activity(&commentary(opening));
        let tool = timeline.observe(Some("capability:read"), None);
        let progress = format!("{opening}\n\nThe file");
        let (same, marks) = timeline.activity(&commentary(&progress));
        let marks = marks.unwrap();
        assert_eq!(first, same);
        assert_eq!(marks.as_array().unwrap().len(), 2);
        assert_eq!(marks[1]["start"], opening.encode_utf16().count());
        assert!(marks[1]["timelineOrder"].as_u64().unwrap() > tool.timeline_order);

        timeline.observe(Some("capability:read"), None); // completed
        timeline.observe(None, None); // heartbeat
        let progress = format!("{progress} is ready.");
        let (_, extended_marks) = timeline.activity(&commentary(&progress));
        assert_eq!(extended_marks, Some(marks.clone()));
        timeline.observe(Some("response"), None);
        let (_, persisted_marks) = timeline.activity(&commentary(&progress));
        assert_eq!(persisted_marks, Some(marks));
    }

    #[test]
    fn a_broker_call_between_buffer_checks_preserves_both_chunk_positions() {
        let mut timeline = ProviderTimeline::default();
        let mut stream = StreamingCommandState::new();
        let first = timeline.observe(None, Some("Before."));
        stream.push_pending_delta("Before.");
        assert!(stream.set_pending_timeline(first.clone(), 0).is_none());
        let buffered_chunks = stream.pending_delta_chunks.len();
        timeline.observe(Some("capability:read"), None);
        let second = timeline.observe(None, Some("After 🦀."));
        stream.push_pending_delta("After 🦀.");
        let (earlier, position) = stream
            .set_pending_timeline(second.clone(), buffered_chunks)
            .unwrap();
        assert_eq!(earlier, "Before.");
        assert_eq!(position, first);
        assert_eq!(stream.pending_timeline, Some(second));
        assert_eq!(stream.pending_delta_chars, "After 🦀.".chars().count());
        assert_eq!(stream.take_pending_delta(), "After 🦀.");
    }

    #[test]
    fn a_new_run_has_its_own_chronology_and_stream_frame_counter() {
        let first = ProviderRunControl::default();
        let mut timeline = first.timeline.lock().unwrap();
        timeline.observe(Some("capability:read"), None);
        timeline.observe(Some("activity:command"), None);
        assert_eq!(first.next_event_sequence.load(Ordering::Relaxed), 0);
        let second = ProviderRunControl::default();
        assert_eq!(
            second
                .timeline
                .lock()
                .unwrap()
                .observe(None, Some("New turn"))
                .timeline_order,
            0,
        );
    }

    #[test]
    fn a_changed_reply_cannot_reuse_matching_prefixes_as_timeline_anchors() {
        let mut timeline = ProviderTimeline::default();
        let common = "This opening prefix is deliberately longer than forty characters";
        let opening = format!("{common}; the streamed version.");
        timeline.observe(None, Some(&opening));
        timeline.observe(Some("capability:read"), None);
        timeline.observe(None, Some("\n\nThe file is ready."));
        let changed = format!("{common}; the rewritten version.\n\nThe file is ready.");
        assert!(timeline.response_segments(&changed).is_none());
        assert!(timeline.response_segments("The file is ready.").is_none());
        assert!(timeline
            .response_segments(&format!("New preamble. {opening}\n\nThe file is ready."))
            .is_none());
        assert!(timeline
            .response_segments(&format!(
                "{opening}\n\nThe file is ready. Extra final text."
            ))
            .is_none());
        assert!(timeline
            .response_segments(&format!("{opening}\n\nThe file is ready."))
            .is_some());
    }

    #[test]
    fn broker_calls_and_provider_activity_share_durable_first_seen_order() {
        let mut timeline = ProviderTimeline::default();
        let opening = timeline.observe(Some("activity:opening"), None);
        let command = timeline.observe(Some("capability:command"), None);
        let progress = timeline.observe(Some("activity:progress"), None);
        let command_done = timeline.observe(Some("capability:command"), None);
        let closing = timeline.observe(Some("response"), None);
        assert!(opening.timeline_order < command.timeline_order);
        assert!(command.timeline_order < progress.timeline_order);
        assert!(progress.timeline_order < closing.timeline_order);
        assert_eq!(command.timeline_order, command_done.timeline_order);
        assert_eq!(
            command.timeline_created_at,
            command_done.timeline_created_at
        );
        let mut persisted = serde_json::json!({ "kind": "capability-call" });
        command_done.insert_into(&mut persisted);
        assert_eq!(persisted["timelineOrder"], command.timeline_order);
        assert_eq!(persisted["timelineCreatedAt"], command.timeline_created_at);
    }

    #[test]
    fn broker_only_calls_split_saved_text_even_without_provider_tool_frames() {
        let mut timeline = ProviderTimeline::default();
        let opening = timeline.observe(
            None,
            Some("GYRO_SESSION_TITLE: Test\nI'll inspect café 🦀."),
        );
        timeline.observe(None, Some("\n"));
        let call = timeline.observe(Some("capability:read"), None);
        let progress = timeline.observe(None, Some("\nThe file is ready."));
        timeline.observe(Some("capability:read"), None);
        timeline.observe(Some("capability:test"), None);
        let answer = timeline.observe(None, Some("\n\nAll checks pass."));
        let message = "I'll inspect café 🦀.\n\nThe file is ready.\n\nAll checks pass.";
        let segments = timeline.response_segments(message).unwrap();
        let segments = segments.as_array().unwrap();
        assert_eq!(segments.len(), 3);
        assert_eq!(segments[0]["start"], 0);
        assert_eq!(segments[0]["timelineOrder"], opening.timeline_order);
        assert_eq!(segments[1]["timelineOrder"], progress.timeline_order);
        assert_eq!(segments[2]["timelineOrder"], answer.timeline_order);
        assert!(opening.timeline_order < call.timeline_order);
        assert!(call.timeline_order < progress.timeline_order);
        assert_eq!(
            segments[1]["start"],
            message[..message.find("The file").unwrap()]
                .encode_utf16()
                .count(),
        );
        assert!(timeline
            .response_segments("A different final answer.")
            .is_none());
    }
}
