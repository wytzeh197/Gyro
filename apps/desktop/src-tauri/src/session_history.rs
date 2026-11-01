//! Complete display history and bounded refresh reads, including approval recovery.
use super::{
    mutation_approval_payload, open_store, parse_uuid, to_string, MAX_DESKTOP_SESSION_EVENTS_READ,
};
use gyro_core::{SessionEvent, SessionEventKind, SessionStore};
use serde::Serialize;
use std::collections::HashSet;
use uuid::Uuid;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionEventsReadResult {
    pub(super) events: Vec<SessionEvent>,
    /// Durable goal, plan, and submitted-mode events outside the recent window.
    pub(super) context_events: Vec<SessionEvent>,
    /// True when older events exist before the returned window.
    pub(super) has_more_before: bool,
    pub(super) revision: Option<String>,
    pub(super) unchanged: bool,
}

pub(super) fn read_session_events_blocking(
    session_id: String,
    before_event_id: Option<String>,
    limit: Option<usize>,
    full_history: bool,
    known_revision: Option<String>,
) -> Result<SessionEventsReadResult, String> {
    let store = open_store()?;
    let session_id = parse_uuid(&session_id)?;
    let page_limit = limit
        .unwrap_or(MAX_DESKTOP_SESSION_EVENTS_READ)
        .clamp(1, MAX_DESKTOP_SESSION_EVENTS_READ);
    if let Some(before_event_id) = before_event_id {
        let before = parse_uuid(&before_event_id)?;
        let page = store
            .read_events_before(session_id, before, page_limit)
            .map_err(to_string)?;
        return Ok(SessionEventsReadResult {
            events: page.events,
            context_events: Vec::new(),
            has_more_before: page.has_more_before,
            revision: None,
            unchanged: false,
        });
    }
    read_session_events_with_revision(
        &store,
        session_id,
        page_limit,
        full_history,
        known_revision.as_deref(),
    )
    .map_err(to_string)
}

fn read_session_events_with_revision(
    store: &SessionStore,
    session_id: Uuid,
    page_limit: usize,
    full_history: bool,
    known_revision: Option<&str>,
) -> anyhow::Result<SessionEventsReadResult> {
    let before = store.transcript_revision(session_id)?;
    if !full_history
        && known_revision == Some(before.as_str())
        && store
            .list_unsurfaced_pending_mutation_proposals(session_id)?
            .is_empty()
    {
        return Ok(SessionEventsReadResult {
            events: Vec::new(),
            context_events: Vec::new(),
            has_more_before: false,
            revision: Some(before),
            unchanged: true,
        });
    }
    let mut result = if full_history {
        read_complete_session_events_from_store(store, session_id)?
    } else {
        read_session_events_from_store(store, session_id, page_limit)?
    };
    // Never certify an append that arrived after our transcript snapshot.
    if store.transcript_revision(session_id)? == before {
        result.revision = Some(before);
    }
    Ok(result)
}

fn read_complete_session_events_from_store(
    store: &SessionStore,
    session_id: Uuid,
) -> anyhow::Result<SessionEventsReadResult> {
    let context_events = store.read_context_events(session_id)?;
    let mut events = store.read_transcript_events(session_id)?;
    recover_pending_approvals(store, session_id, &mut events)?;
    Ok(SessionEventsReadResult {
        events,
        context_events,
        has_more_before: false,
        revision: None,
        unchanged: false,
    })
}

fn read_session_events_from_store(
    store: &SessionStore,
    session_id: Uuid,
    max_recent_events: usize,
) -> anyhow::Result<SessionEventsReadResult> {
    // Read context first so a concurrent append can only land in the newer
    // transcript snapshot; context events then always precede its tail.
    let context_events = store.read_context_events(session_id)?;
    let mut events = store.read_recent_events(session_id, max_recent_events)?;
    // The tail path re-inserts session-created, so a full page of "content"
    // events still means older history may exist even when the returned length
    // equals the limit after that insert.
    let content_events = events
        .iter()
        .filter(|event| event.kind != SessionEventKind::SessionCreated)
        .count();
    let has_more_before = content_events >= max_recent_events;
    recover_pending_approvals(store, session_id, &mut events)?;
    Ok(SessionEventsReadResult {
        events,
        context_events,
        has_more_before,
        revision: None,
        unchanged: false,
    })
}

fn recover_pending_approvals(
    store: &SessionStore,
    session_id: Uuid,
    events: &mut Vec<SessionEvent>,
) -> anyhow::Result<()> {
    let pending = store.list_unsurfaced_pending_mutation_proposals(session_id)?;
    if pending.is_empty() {
        return Ok(());
    }
    let represented_proposals = events
        .iter()
        .filter_map(event_mutation_proposal_id)
        .collect::<HashSet<_>>();
    // Only surface proposals that have never been written into the event log.
    // Long sessions can age approval events out of the recent window; without
    // this gate every reopen would re-append the same pending approvals.
    for proposal in pending {
        if represented_proposals.contains(&proposal.id) {
            let _ = store.mark_mutation_proposal_surfaced(proposal.id);
            continue;
        }
        let recovered = store.append_event_with_turn_id(
            session_id,
            SessionEventKind::ApprovalRequested,
            format!("Review changes to {}", proposal.path),
            mutation_approval_payload(&proposal, None),
            proposal.turn_id,
        )?;
        let _ = store.mark_mutation_proposal_surfaced(proposal.id);
        events.push(recovered);
    }
    Ok(())
}

fn event_mutation_proposal_id(event: &SessionEvent) -> Option<Uuid> {
    let payload = event.payload.as_object()?;
    if payload.get("kind")?.as_str()? != "mutation-approval" {
        return None;
    }
    Uuid::parse_str(payload.get("proposalId")?.as_str()?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use gyro_core::{GyroPaths, SessionOrigin};

    #[test]
    fn complete_chat_history_exceeds_display_and_provider_windows() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "complete history")
            .unwrap();
        let entries = (0..3_100)
            .map(|index| {
                (
                    format!("history message {index}"),
                    serde_json::json!({"index":index}),
                    None,
                )
            })
            .collect::<Vec<_>>();
        store
            .append_system_events_with_turn_id(session.id, entries)
            .unwrap();
        let recent =
            read_session_events_from_store(&store, session.id, MAX_DESKTOP_SESSION_EVENTS_READ)
                .unwrap();
        assert!(recent.has_more_before);
        assert!(recent.events.len() <= MAX_DESKTOP_SESSION_EVENTS_READ + 1);
        let complete = read_complete_session_events_from_store(&store, session.id).unwrap();
        assert!(!complete.has_more_before);
        assert_eq!(complete.events.len(), 3_101);
        assert_eq!(complete.events[1].message, "history message 0");
        assert_eq!(
            complete.events.last().unwrap().message,
            "history message 3099"
        );
        // UI history must not change the separately bounded provider read.
        assert!(store.read_events(session.id).unwrap().len() <= 1_001);
    }

    #[test]
    fn unchanged_history_omits_payload_but_observes_appends_and_approvals() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "efficient history")
            .unwrap();
        store
            .append_system_events_with_turn_id(
                session.id,
                (0..450)
                    .map(|i| {
                        (
                            format!("message {i}: {}", "x".repeat(1000)),
                            serde_json::json!({}),
                            None,
                        )
                    })
                    .collect(),
            )
            .unwrap();
        let first = read_session_events_with_revision(&store, session.id, 400, true, None).unwrap();
        let revision = first.revision.clone().unwrap();
        let unchanged =
            read_session_events_with_revision(&store, session.id, 400, false, Some(&revision))
                .unwrap();
        assert!(unchanged.unchanged);
        assert!(unchanged.events.is_empty() && unchanged.context_events.is_empty());
        let full_bytes = serde_json::to_vec(&first).unwrap().len();
        let unchanged_bytes = serde_json::to_vec(&unchanged).unwrap().len();
        assert!(unchanged_bytes * 100 < full_bytes);
        println!("History transport fixture: {full_bytes} -> {unchanged_bytes} bytes on an unchanged refresh");
        let forced =
            read_session_events_with_revision(&store, session.id, 400, true, Some(&revision))
                .unwrap();
        assert!(!forced.unchanged);
        assert_eq!(forced.events.len(), first.events.len());
        store
            .append_event(
                session.id,
                SessionEventKind::UserMessage,
                "new reply",
                serde_json::json!({}),
            )
            .unwrap();
        let changed =
            read_session_events_with_revision(&store, session.id, 400, false, Some(&revision))
                .unwrap();
        assert!(!changed.unchanged);
        assert_eq!(changed.events.last().unwrap().message, "new reply");
        let latest = changed.revision.unwrap();
        let proposal = store
            .create_mutation_proposal(session.id, None, "pending.txt", "pending", None, false)
            .unwrap();
        let approval =
            read_session_events_with_revision(&store, session.id, 400, false, Some(&latest))
                .unwrap();
        assert!(!approval.unchanged);
        assert!(approval
            .events
            .iter()
            .any(|event| event_mutation_proposal_id(event) == Some(proposal.id)));
        // Approval recovery writes after the revision snapshot. Never return a
        // revision that would incorrectly certify those newly appended bytes.
        assert!(approval.revision.is_none());
    }

    #[test]
    fn revision_detects_same_size_log_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "replacement")
            .unwrap();
        let original = store.transcript_revision(session.id).unwrap();
        let replacement = session.events_path.with_extension("replacement");
        std::fs::copy(&session.events_path, &replacement).unwrap();
        std::fs::rename(replacement, &session.events_path).unwrap();
        assert_ne!(store.transcript_revision(session.id).unwrap(), original);
    }

    #[test]
    fn pending_approval_is_restored_into_the_timeline_once() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "approval restore")
            .unwrap();
        let proposal = store
            .create_mutation_proposal(
                session.id,
                Some(Uuid::new_v4()),
                "restored.txt",
                "pending\n",
                None,
                false,
            )
            .unwrap();

        let first =
            read_session_events_from_store(&store, session.id, MAX_DESKTOP_SESSION_EVENTS_READ)
                .unwrap();
        let second =
            read_session_events_from_store(&store, session.id, MAX_DESKTOP_SESSION_EVENTS_READ)
                .unwrap();
        let matching = |events: &[SessionEvent]| {
            events
                .iter()
                .filter(|event| event_mutation_proposal_id(event) == Some(proposal.id))
                .count()
        };
        assert_eq!(matching(&first.events), 1);
        assert_eq!(matching(&second.events), 1);
        assert_eq!(
            second
                .events
                .iter()
                .find(|event| event_mutation_proposal_id(event) == Some(proposal.id))
                .unwrap()
                .kind,
            SessionEventKind::ApprovalRequested
        );
    }
}
