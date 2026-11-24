//! Select the same durable context without a history scan for every old row.
pub(super) const ALL_CONTEXT: &str = "
    select event_json from session_context_events
    where session_id = ?1 order by log_offset asc";

pub(super) const GOAL_CONTEXT: &str = "
    select event_json from session_context_events
    where session_id = ?1 and json_extract(event_json, '$.kind') = 'goal-updated'
    order by log_offset asc";

pub(super) const WORKSPACE_TEST_OUTCOMES_FOR_TURNS: &str = "
    select event_json from session_context_events
    where session_id = ?1 and json_extract(event_json, '$.turnId') in (select value from json_each(?2))
        and json_extract(event_json, '$.payload.kind') = 'capability-call'
        and json_extract(event_json, '$.payload.status') = 'completed'
        and json_extract(event_json, '$.payload.workspaceTaskOutcome.receipt.outcome.capabilityId') in ('workspace-run-test', 'workspace-run-command')
    order by log_offset asc";

pub(super) const WORKSPACE_OUTPUT_RECEIPT: &str = "
    select event_json from session_context_events
    where session_id = ?1
        and json_extract(event_json, '$.payload.kind') = 'capability-call'
        and json_extract(event_json, '$.payload.status') = 'completed'
        and json_extract(event_json, '$.payload.workspaceTaskOutcome.workspaceKey') = ?2
        and json_extract(event_json, '$.payload.workspaceTaskOutcome.receipt.outputId') = ?3
    order by log_offset desc limit 1";

pub(super) const EFFICIENCY_CONTEXT: &str = "
    with latest as (
        select json_extract(event_json, '$.kind') as kind, max(log_offset) as log_offset
        from session_context_events where session_id = ?1
        group by json_extract(event_json, '$.kind')
    ), recent_task_outcomes as (
        select log_offset from session_context_events
        where session_id = ?1
          and json_type(event_json, '$.payload.workspaceTaskOutcome') = 'object'
          and json_extract(event_json, '$.payload.workspaceTaskOutcome.receipt.outcome.capabilityId') is not 'workspace-run-command'
        order by log_offset desc limit 16
    ), recent_command_tests as (
        select max(log_offset) as log_offset from session_context_events
        where session_id = ?1
          and json_extract(event_json, '$.payload.workspaceTaskOutcome.receipt.outcome.capabilityId') = 'workspace-run-command'
        group by json_extract(event_json, '$.payload.workspaceTaskOutcome.workspaceKey'),
                 json_extract(event_json, '$.payload.workspaceTaskOutcome.receipt.outcome.taskId')
        order by max(log_offset) desc limit 4
    )
    select e.event_json from session_context_events e
    left join latest l on l.kind = json_extract(e.event_json, '$.kind')
        and l.log_offset = e.log_offset
    where e.session_id = ?1 and (
        json_extract(e.event_json, '$.payload.kind') = 'efficiency-phase-route'
        or json_extract(e.event_json, '$.kind') = 'goal-updated'
        or e.log_offset in (select log_offset from recent_task_outcomes)
        or e.log_offset in (select log_offset from recent_command_tests)
        or l.log_offset is not null
    ) order by e.log_offset asc";

#[cfg(test)]
mod tests {
    use super::super::*;
    use super::*;

    // The prior query is the semantic oracle, including offset ties and NULLs.
    const PRIOR: &str = "select event_json from session_context_events e where session_id=?1 and (json_extract(event_json,'$.payload.kind')='efficiency-phase-route' or json_extract(event_json,'$.kind')='goal-updated' or log_offset=(select max(log_offset) from session_context_events n where n.session_id=e.session_id and json_extract(n.event_json,'$.kind')=json_extract(e.event_json,'$.kind'))) order by log_offset asc";

    #[test]
    fn grouped_context_preserves_goals_routes_latest_kinds_and_ties_per_session() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("create table session_context_events (session_id text, event_json text, log_offset integer);").unwrap();
        for session in ["a", "b"] {
            for offset in 0..240 {
                let kind = match offset % 6 {
                    0 => "goal-updated",
                    1 => "task-checkpoint",
                    2 => "plan-updated",
                    3 => "assistant-message",
                    4 => "chat-mode-changed",
                    _ => "system-event",
                };
                let payload = serde_json::json!({"kind":kind,"message":format!("{session}/{offset}"),"payload":{"kind":if offset % 11 == 0 {"efficiency-phase-route"} else {"fixture"}}});
                conn.execute(
                    "insert into session_context_events values (?1,?2,?3)",
                    params![session, payload.to_string(), offset / 2],
                )
                .unwrap();
            }
            // Unknown/missing kinds must have the original SQL NULL semantics.
            for payload in [
                serde_json::json!({"payload":{}}),
                serde_json::json!({"kind":null,"payload":{"kind":"efficiency-phase-route"}}),
            ] {
                conn.execute(
                    "insert into session_context_events values (?1,?2,500)",
                    params![session, payload.to_string()],
                )
                .unwrap();
            }
        }
        for session in ["a", "b", "empty"] {
            let read = |sql| {
                conn.prepare(sql)
                    .unwrap()
                    .query_map([session], |row| row.get::<_, String>(0))
                    .unwrap()
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .unwrap()
            };
            assert_eq!(read(EFFICIENCY_CONTEXT), read(PRIOR), "session {session}");
        }
    }

    #[test]
    fn context_selection_observes_appends_and_reopen_without_losing_history() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let store = SessionStore::open(paths.clone()).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "context")
            .unwrap();
        let mut goals = Vec::new();
        for index in 0..12 {
            goals.push(
                store
                    .append_event(
                        session.id,
                        SessionEventKind::GoalUpdated,
                        "goal",
                        serde_json::json!({"action":"set","text":format!("goal {index}")}),
                    )
                    .unwrap(),
            );
            store
                .append_event(
                    session.id,
                    SessionEventKind::TaskCheckpoint,
                    "checkpoint",
                    serde_json::json!({"index":index}),
                )
                .unwrap();
        }
        let before = store.read_efficiency_context_events(session.id).unwrap();
        assert_eq!(before.len(), goals.len() + 1);
        assert_eq!(store.read_context_events(session.id).unwrap().len(), 24);
        drop(store);
        let store = SessionStore::open(paths).unwrap();
        let newest = store
            .append_event(
                session.id,
                SessionEventKind::TaskCheckpoint,
                "new checkpoint",
                serde_json::json!({"index":12}),
            )
            .unwrap();
        let after = store.read_efficiency_context_events(session.id).unwrap();
        assert_eq!(
            after
                .iter()
                .filter(|e| e.kind == SessionEventKind::GoalUpdated)
                .map(|e| e.id)
                .collect::<Vec<_>>(),
            goals.iter().map(|e| e.id).collect::<Vec<_>>()
        );
        assert_eq!(after.last().unwrap().id, newest.id);
        assert_eq!(after.len(), before.len());
        assert_eq!(store.read_context_events(session.id).unwrap().len(), 25);
    }

    #[test]
    fn goal_selection_keeps_revisions_across_the_first_read_and_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let store = SessionStore::open(paths.clone()).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "goal history")
            .unwrap();
        let goal = store
            .append_event(
                session.id,
                SessionEventKind::GoalUpdated,
                "Goal set",
                serde_json::json!({"action":"set","text":"Review the plan"}),
            )
            .unwrap();
        let plan = store
            .append_event(
                session.id,
                SessionEventKind::PlanUpdated,
                "Plan updated",
                serde_json::json!({"content":"Review the plan","kind":"goal-updated"}),
            )
            .unwrap();
        let ids = |events: Vec<SessionEvent>| events.into_iter().map(|e| e.id).collect::<Vec<_>>();
        assert_eq!(ids(store.read_goal_events(session.id).unwrap()), [goal.id]);
        assert_eq!(
            ids(store.read_context_events(session.id).unwrap()),
            [goal.id, plan.id]
        );

        drop(store);
        let store = SessionStore::open(paths).unwrap();
        let clear = store
            .append_event(
                session.id,
                SessionEventKind::GoalUpdated,
                "Goal cleared",
                serde_json::json!({"action":"clear"}),
            )
            .unwrap();
        let events = store.read_goal_events(session.id).unwrap();
        assert_eq!(events[1].payload, clear.payload);
        assert_eq!(ids(events), [goal.id, clear.id]);
        assert_eq!(
            ids(store.read_context_events(session.id).unwrap()),
            [goal.id, plan.id, clear.id]
        );
    }

    #[test]
    fn incremental_index_counts_crlf_and_unicode_bytes_and_leaves_partial_tail_unindexed() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "offsets")
            .unwrap();
        let mut file = OpenOptions::new()
            .append(true)
            .open(&session.events_path)
            .unwrap();
        for newline in ["\r\n", "\n", "\r\n"] {
            let event = SessionEvent::new(
                session.id,
                SessionEventKind::GoalUpdated,
                "日本語 🦀",
                serde_json::json!({"text":"café"}),
            );
            file.write_all(serde_json::to_string(&event).unwrap().as_bytes())
                .unwrap();
            file.write_all(newline.as_bytes()).unwrap();
        }
        file.flush().unwrap();
        let complete_bytes = file.metadata().unwrap().len();
        file.write_all(&[0xf0, 0x9f]).unwrap();
        file.flush().unwrap();
        let context = store.read_context_events(session.id).unwrap();
        assert_eq!(context.len(), 3);
        let indexed: u64 = store
            .conn
            .query_row(
                "select indexed_bytes from session_context_index where session_id=?1",
                [session.id.to_string()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(indexed, complete_bytes);
        drop(file);
        let appended = store
            .append_event(
                session.id,
                SessionEventKind::GoalUpdated,
                "next",
                serde_json::json!({"text":"continue"}),
            )
            .unwrap();
        let context = store.read_context_events(session.id).unwrap();
        assert_eq!(context.len(), 4);
        assert_eq!(context.last().unwrap().id, appended.id);
        let indexed: u64 = store
            .conn
            .query_row(
                "select indexed_bytes from session_context_index where session_id=?1",
                [session.id.to_string()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            indexed,
            std::fs::metadata(&session.events_path).unwrap().len()
        );
    }
}
