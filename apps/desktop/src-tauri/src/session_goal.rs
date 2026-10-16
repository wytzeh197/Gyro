//! A chat's goal as the store records it: one outcome per chat, set by the
//! user, completed by the user or by the model's hidden marker.
//!
//! The store is the source of truth. The composer asks for a change; this
//! module checks it, words the transcript line, and answers what the goal is
//! when a turn runs, so a stale window cannot send a goal that was cleared.
use crate::SessionGoalContext;
use gyro_core::{SessionEvent, SessionEventKind};

/// Long enough for a request typed straight into the goal composer, short
/// enough to resend on every turn without crowding the context.
pub(crate) const MAX_GOAL_CHARS: usize = 1_000;

/// The goal the latest goal event leaves in place, if any.
pub(crate) fn stored_session_goal(events: &[SessionEvent]) -> Option<SessionGoalContext> {
    let mut goal: Option<SessionGoalContext> = None;
    let mut revision: Option<uuid::Uuid> = None;
    for event in events
        .iter()
        .filter(|event| event.kind == SessionEventKind::GoalUpdated)
    {
        let payload = &event.payload;
        if payload["source"] == "goal-runner" {
            if goal.is_none()
                || payload["goalVersion"]
                    .as_str()
                    .and_then(|id| uuid::Uuid::parse_str(id).ok())
                    != revision
            {
                continue;
            }
            // Runner status never reopens a completed outcome.
            if goal.as_ref().is_some_and(|goal| goal.status == "complete")
                && payload["status"] != "complete"
            {
                continue;
            }
        } else if payload["source"] == "model" {
            if !goal
                .as_ref()
                .is_some_and(|goal| payload["text"].as_str() == Some(goal.text.as_str()))
                || payload.get("goalVersion").is_some_and(|value| {
                    value.as_str().and_then(|id| uuid::Uuid::parse_str(id).ok()) != revision
                })
            {
                continue;
            }
        } else {
            revision = Some(event.id);
        }
        if payload.get("action").and_then(serde_json::Value::as_str) == Some("clear") {
            goal = None;
            continue;
        }
        let Some(text) = payload
            .get("text")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
            .or_else(|| goal.as_ref().map(|goal| goal.text.clone()))
        else {
            continue;
        };
        let status = match payload.get("status").and_then(serde_json::Value::as_str) {
            Some("complete") => "complete",
            _ => "active",
        };
        goal = Some(SessionGoalContext {
            text,
            status: status.into(),
        });
    }
    goal
}

pub(crate) fn goal_revision(events: &[SessionEvent]) -> Option<uuid::Uuid> {
    events
        .iter()
        .rev()
        .find(|event| {
            event.kind == SessionEventKind::GoalUpdated
                && event.payload["source"] != "goal-runner"
                && event.payload["source"] != "model"
        })
        .map(|event| event.id)
}

pub(crate) fn stored_or_unsaved_goal(
    events: &[SessionEvent],
    unsaved: Option<SessionGoalContext>,
) -> Option<SessionGoalContext> {
    if events
        .iter()
        .any(|event| event.kind == SessionEventKind::GoalUpdated)
    {
        stored_session_goal(events)
    } else {
        unsaved
    }
}

/// Check a requested goal change against the current goal and word it.
///
/// Returns the transcript line and the payload to store. The text is trimmed
/// and its whitespace collapsed; the status is `active` or `complete`, never
/// whatever else a caller sent.
pub(crate) fn goal_change(
    payload: &serde_json::Value,
    current: Option<&SessionGoalContext>,
) -> Result<(String, serde_json::Value), String> {
    if payload.get("action").and_then(serde_json::Value::as_str) == Some("clear") {
        return if current.is_some() {
            Ok((
                "Goal cleared".into(),
                serde_json::json!({ "action": "clear" }),
            ))
        } else {
            Err("this chat has no goal to clear".into())
        };
    }
    let text = payload
        .get("text")
        .and_then(serde_json::Value::as_str)
        .map(|text| text.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|text| !text.is_empty())
        .or_else(|| current.map(|goal| goal.text.clone()))
        .ok_or_else(|| "describe the outcome before saving the goal".to_string())?;
    if text.chars().count() > MAX_GOAL_CHARS {
        return Err(format!("keep the goal under {MAX_GOAL_CHARS} characters"));
    }
    let status = match payload.get("status").and_then(serde_json::Value::as_str) {
        Some("complete") => "complete",
        _ => "active",
    };
    let message = match current {
        None => format!("Goal set: {text}"),
        Some(goal) if goal.status != "complete" && status == "complete" => {
            format!("Goal completed: {text}")
        }
        Some(goal) if goal.status == "complete" && status == "active" && goal.text == text => {
            format!("Goal reopened: {text}")
        }
        Some(goal)
            if goal.text == text && goal.status == status && payload.get("runLimits").is_none() =>
        {
            return Err("the goal is already set to that".into())
        }
        Some(_) => format!("Goal updated: {text}"),
    };
    let mut stored = serde_json::json!({ "action": "set", "text": text, "status": status });
    if let Some(value) = payload.get("runLimits") {
        let limits: crate::goal_runner::Limits = serde_json::from_value(value.clone())
            .map_err(|_| "invalid goal run limits".to_string())?;
        limits.validate()?;
        stored["runLimits"] = serde_json::to_value(limits).map_err(|error| error.to_string())?;
    }
    if let Some(turn) = payload.get("sourceTurnId").filter(|turn| turn.is_string()) {
        stored["sourceTurnId"] = turn.clone();
    }
    Ok((message, stored))
}

/// What the model is told about the goal on each turn.
pub(crate) fn goal_context_lines(goal: &SessionGoalContext) -> Vec<String> {
    let text = goal.text.trim();
    if text.is_empty() {
        return Vec::new();
    }
    if goal.status == "active" {
        vec![
            format!("Active Gyro session goal: {text}"),
            "Work toward this goal within the latest user request and existing permissions. Before the final answer, report a checkpoint on one hidden line: GYRO_GOAL_UPDATE: {\"status\":\"continue\",\"progress\":\"Verified work completed this turn\",\"nextAction\":\"Concrete remaining action\"}. Gyro automatically schedules the next turn for actionable unfinished work. Use status complete only when the goal is fully achieved. Use blocked with a reason when user input, approval, prohibited work, unavailable capabilities, or external acceptance is required. Use paused with a reason when the user asks to stop, only discuss ideas, avoid coding, or defer implementation. Preserve all restrictions; an active goal never broadens authorization. Include progress evidence and avoid repeating completed work.".into(),
        ]
    } else {
        // A met goal used to vanish from context entirely, so follow-up turns
        // lost all knowledge of what the chat was for.
        vec![format!(
            "Gyro session goal (already met — do not redo that work): {text}"
        )]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use uuid::Uuid;

    fn goal_event(payload: serde_json::Value) -> SessionEvent {
        SessionEvent {
            id: Uuid::new_v4(),
            session_id: Uuid::nil(),
            turn_id: None,
            created_at: Utc::now(),
            kind: SessionEventKind::GoalUpdated,
            message: String::new(),
            payload,
        }
    }

    fn goal(text: &str, status: &str) -> SessionGoalContext {
        SessionGoalContext {
            text: text.into(),
            status: status.into(),
        }
    }

    #[test]
    fn the_latest_goal_event_wins_and_a_clear_removes_it() {
        let events = vec![
            goal_event(
                serde_json::json!({"action": "set", "text": "Ship alpha", "status": "active"}),
            ),
            goal_event(serde_json::json!({"action": "set", "status": "complete"})),
        ];
        let stored = stored_session_goal(&events).unwrap();
        assert_eq!(
            (stored.text.as_str(), stored.status.as_str()),
            ("Ship alpha", "complete")
        );
        let mut cleared = events;
        cleared.push(goal_event(serde_json::json!({"action": "clear"})));
        assert!(stored_session_goal(&cleared).is_none());
    }

    #[test]
    fn a_clear_does_not_revive_a_stale_window_goal() {
        let stale = goal("Ship", "active");
        assert_eq!(
            stored_or_unsaved_goal(&[], Some(stale.clone()))
                .unwrap()
                .text,
            "Ship"
        );
        assert!(stored_or_unsaved_goal(
            &[goal_event(serde_json::json!({"action":"clear"}))],
            Some(stale)
        )
        .is_none());
    }

    #[test]
    fn a_change_is_normalized_and_worded_by_the_backend() {
        let (message, payload) = goal_change(
            &serde_json::json!({"action": "set", "text": "  Fix   the\nbuild ", "status": "weird"}),
            None,
        )
        .unwrap();
        assert_eq!(message, "Goal set: Fix the build");
        assert_eq!(payload["status"], "active");

        let active = goal("Fix the build", "active");
        let (message, _) = goal_change(
            &serde_json::json!({"action": "set", "status": "complete"}),
            Some(&active),
        )
        .unwrap();
        assert_eq!(message, "Goal completed: Fix the build");

        let done = goal("Fix the build", "complete");
        let (message, _) = goal_change(
            &serde_json::json!({"action": "set", "text": "Fix the build", "status": "active"}),
            Some(&done),
        )
        .unwrap();
        assert_eq!(message, "Goal reopened: Fix the build");
    }

    #[test]
    fn late_runner_and_model_events_cannot_revive_or_reopen_a_changed_goal() {
        let initial =
            goal_event(serde_json::json!({"action":"set","text":"Original","status":"active"}));
        let stale_run = goal_event(
            serde_json::json!({"action":"set","text":"Original","status":"active",
            "source":"goal-runner","goalVersion":initial.id}),
        );
        let stale_done = goal_event(
            serde_json::json!({"action":"set","text":"Original","status":"complete",
            "source":"model","goalVersion":initial.id}),
        );
        let cleared = goal_event(serde_json::json!({"action":"clear"}));
        assert!(stored_session_goal(&[
            initial.clone(),
            cleared,
            stale_run.clone(),
            stale_done.clone()
        ])
        .is_none());
        let reopened =
            goal_event(serde_json::json!({"action":"set","text":"Original","status":"active"}));
        assert_eq!(
            stored_session_goal(&[initial.clone(), reopened, stale_done])
                .unwrap()
                .status,
            "active"
        );
        let done =
            goal_event(serde_json::json!({"action":"set","text":"Original","status":"complete"}));
        assert_eq!(
            stored_session_goal(&[initial, done, stale_run])
                .unwrap()
                .status,
            "complete"
        );
    }
    #[test]
    fn goal_limits_are_configurable_and_validated() {
        let active = goal("Finish", "active");
        let (_, stored) = goal_change(
            &serde_json::json!({"action":"set","runLimits":{
                "maxAutomaticTurns":4,"maxMinutes":30,"maxNewTokens":50_000
            }}),
            Some(&active),
        )
        .unwrap();
        assert_eq!(stored["runLimits"]["maxAutomaticTurns"], 4);
        assert!(goal_change(
            &serde_json::json!({"action":"set","runLimits":{"maxMinutes":0}}),
            Some(&active)
        )
        .is_err());
    }
    #[test]
    fn empty_oversized_repeated_and_orphan_changes_are_refused() {
        assert!(goal_change(&serde_json::json!({"action": "set", "text": "  "}), None).is_err());
        let long = "x".repeat(MAX_GOAL_CHARS + 1);
        assert!(goal_change(&serde_json::json!({"action": "set", "text": long}), None).is_err());
        let active = goal("Ship", "active");
        assert!(goal_change(
            &serde_json::json!({"action": "set", "text": "Ship", "status": "active"}),
            Some(&active)
        )
        .is_err());
        assert!(goal_change(&serde_json::json!({"action": "clear"}), None).is_err());
    }
}
