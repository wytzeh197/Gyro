use crate::provider_context;
use gyro_core::provider_runtime::types::ProviderAdapterKind;
use gyro_core::{GyroConfig, GyroPaths, SessionEvent, SessionStore, UsageOrigin};
use uuid::Uuid;
/// Which action a provider call belongs to, for the usage ledger.
///
/// Carried as a parameter rather than read off the request so that every call
/// site has to name what it is spending on: one composer keypress can become a
/// chat turn, four Council seats, and a synthesis, and a ledger that cannot
/// tell them apart cannot answer where the quota went.
#[derive(Clone, Copy, Debug)]
pub(crate) struct UsageContext {
    pub(crate) origin: UsageOrigin,
    pub(crate) seat_id: Option<Uuid>,
}

impl UsageContext {
    pub(crate) fn new(origin: UsageOrigin) -> Self {
        Self {
            origin,
            seat_id: None,
        }
    }

    pub(crate) fn seat(seat_id: Uuid) -> Self {
        Self {
            origin: UsageOrigin::CouncilSeat,
            seat_id: Some(seat_id),
        }
    }
}

/// Refuse a call that the usage guards say must not start.
///
/// Checked here rather than at each caller so no provider path can be added
/// that skips it. The counts come from the ledger, so the guards cover the
/// providers that report no usage of their own.
/// Refuse a call the provider's budget cannot pay for.
///
/// Exhausting a budget also pauses Gyro with an expiry, so the block survives a
/// restart and lifts by itself once the rolling window frees up — the user is
/// told which provider ran out rather than meeting a silent failure.
pub(crate) fn usage_budget_block(
    store: &SessionStore,
    config: &gyro_core::UsageGuardConfig,
    origin: UsageOrigin,
    provider_id: &str,
) -> Option<String> {
    let budget = config
        .budgets
        .iter()
        .find(|budget| budget.provider_id == provider_id && budget.max_tokens > 0)?;
    let state = match store.budget_state(budget, chrono::Utc::now()) {
        Ok(state) => state,
        Err(error) => {
            eprintln!(
                "usage budgets could not be measured, allowing this run: {}",
                gyro_core::security::redact_secrets(&error.to_string())
            );
            return None;
        }
    };
    let gyro_core::GuardVerdict::Block(reason) = gyro_core::budget_decision(&state, origin) else {
        return None;
    };
    if state.level == gyro_core::BudgetLevel::Exhausted {
        if let Err(error) = pause_for_exhausted_budget(&state) {
            eprintln!(
                "budget was exhausted but the pause was not recorded: {}",
                gyro_core::security::redact_secrets(&error.to_string())
            );
        }
    }
    Some(reason)
}

pub(crate) fn pause_for_exhausted_budget(state: &gyro_core::BudgetState) -> anyhow::Result<()> {
    let paths = GyroPaths::for_current_user()?;
    GyroConfig::update(&paths, |persisted| {
        // A manual pause outranks an automatic one: it has no expiry, and
        // replacing it would resume work the user stopped on purpose.
        if matches!(
            persisted.usage_guard.pause.reason,
            Some(gyro_core::PauseReason::Manual)
        ) && persisted.usage_guard.pause.active
        {
            return Ok(());
        }
        persisted.usage_guard.pause =
            gyro_core::PauseState::budget_exhausted(&state.provider_id, state.window_resets_at);
        Ok(())
    })
}

pub(crate) fn usage_guard_block(
    store: &SessionStore,
    origin: UsageOrigin,
    provider_id: &str,
) -> Option<String> {
    let config = GyroPaths::for_current_user()
        .ok()
        .and_then(|paths| GyroConfig::load(&paths).ok())
        .map(|config| config.usage_guard)
        .unwrap_or_default();
    if config.pause.is_active_at(chrono::Utc::now()) {
        // A pause must hold even if the ledger cannot be read.
        if let gyro_core::GuardVerdict::Block(reason) =
            gyro_core::guard_decision(&config, origin, gyro_core::RecentUsage::default())
        {
            return Some(reason);
        }
    }
    if !config.enabled {
        return None;
    }
    if let Some(reason) = usage_budget_block(store, &config, origin, provider_id) {
        return Some(reason);
    }
    let since =
        chrono::Utc::now() - chrono::Duration::minutes(i64::from(config.window_minutes.max(1)));
    // A ledger the guard cannot read is not evidence of safety, but blocking on
    // a read failure would strand the user with no way to work. The call runs
    // and the failure is logged.
    let recent = match store.recent_usage(since) {
        Ok(recent) => recent,
        Err(error) => {
            eprintln!(
                "usage guards could not read the ledger, allowing this run: {}",
                gyro_core::security::redact_secrets(&error.to_string())
            );
            return None;
        }
    };
    match gyro_core::guard_decision(&config, origin, recent) {
        gyro_core::GuardVerdict::Block(reason) => Some(reason),
        gyro_core::GuardVerdict::Allow => None,
    }
}

pub(crate) fn should_compact_before_turn(
    percent: u32,
    adapter: ProviderAdapterKind,
    provider_id: &str,
    model_id: Option<&str>,
    catalog_window: Option<u64>,
    events: &[SessionEvent],
) -> bool {
    if percent == 0 {
        return false;
    }
    let owned_transcript = matches!(
        adapter,
        ProviderAdapterKind::OpenAiCompatible | ProviderAdapterKind::Ollama
    );
    if owned_transcript && !crate::conversation_history::has_reply_since_checkpoint(events) {
        return false;
    }
    let transcript_characters =
        owned_transcript.then(|| crate::conversation_history::carried_history_characters(events));
    let signals = events
        .iter()
        .map(|event| session_context_signal(event, transcript_characters.is_none()))
        .collect::<Vec<_>>();
    gyro_core::provider_runtime::context::should_auto_compact_session_with_transcript(
        percent,
        provider_id,
        model_id,
        catalog_window,
        &signals,
        transcript_characters,
    )
}

fn session_context_signal(
    event: &SessionEvent,
    count_payload: bool,
) -> provider_context::SessionContextSignal {
    let object = event.payload.as_object();
    let text = |key: &str| {
        object
            .and_then(|payload| payload.get(key))
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    let session_compaction = object.is_some_and(|payload| {
        payload.get("kind").and_then(serde_json::Value::as_str) == Some("provider-activity")
            && payload
                .get("activityKind")
                .and_then(serde_json::Value::as_str)
                == Some("context")
            && payload
                .get("activityId")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|id| id.starts_with("context-compaction-"))
            // Only a durable, successful compaction releases the old context.
            && matches!(
                payload.get("status").and_then(serde_json::Value::as_str),
                Some("done" | "completed")
            )
    });
    // Usage written onto the compaction itself is the summary call, not the
    // thread the next turn will resume. Treating it as a fresh reading would
    // compact again on every message.
    let reading = if session_compaction {
        None
    } else {
        object
            .and_then(|payload| payload.get("contextUsage"))
            .and_then(serde_json::Value::as_object)
            .filter(|usage| {
                usage.get("estimated").and_then(serde_json::Value::as_bool) != Some(true)
            })
            .map(|usage| provider_context::AutoCompactReading {
                input_tokens: usage.get("inputTokens").and_then(serde_json::Value::as_u64),
                output_tokens: usage
                    .get("outputTokens")
                    .and_then(serde_json::Value::as_u64),
                model_context_window: usage
                    .get("modelContextWindow")
                    .and_then(serde_json::Value::as_u64),
            })
    };
    provider_context::SessionContextSignal {
        provider_id: text("providerId"),
        model_id: text("modelId"),
        reading,
        characters: if count_payload {
            event_text_characters(event)
        } else {
            0
        },
        session_compaction,
    }
}

/// Text characters one stored event adds to the prompt that resumes from it.
///
/// The auto-compact decision needs a size for the sessions whose provider never
/// reports one, and the stored events are the only source every adapter feeds.
/// Counting the strings a payload carries is adapter-agnostic; image bytes are
/// provider-owned, so encoded fields are skipped the way a message's image
/// payload is skipped when the note measures text.
pub(crate) fn event_text_characters(event: &SessionEvent) -> u64 {
    let mut characters = 0u64;
    collect_text_characters(&event.payload, None, &mut characters);
    characters
}

pub(crate) fn collect_text_characters(
    value: &serde_json::Value,
    field: Option<&str>,
    characters: &mut u64,
) {
    match value {
        serde_json::Value::String(text) => {
            if !is_encoded_text(field, text) {
                *characters = characters.saturating_add(text.chars().count() as u64);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_text_characters(item, field, characters);
            }
        }
        serde_json::Value::Object(fields) => {
            for (name, value) in fields {
                collect_text_characters(value, Some(name), characters);
            }
        }
        _ => {}
    }
}

pub(crate) fn is_encoded_text(field: Option<&str>, text: &str) -> bool {
    const ENCODED_FIELDS: [&str; 4] = ["image", "images", "data", "base64"];
    field.is_some_and(|field| {
        ENCODED_FIELDS
            .iter()
            .any(|encoded| field.eq_ignore_ascii_case(encoded))
    }) || (text.len() > 4_096 && text.starts_with("data:"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use gyro_core::SessionEventKind;
    use serde_json::json;

    #[test]
    fn owned_auto_compaction_uses_replayed_history_and_measured_usage() {
        let session = Uuid::new_v4();
        let mut events = vec![
            SessionEvent::new(
                session,
                SessionEventKind::UserMessage,
                "Check the build",
                json!({}),
            ),
            SessionEvent::new(
                session,
                SessionEventKind::SystemEvent,
                "Build log",
                json!({
                    "kind": "provider-activity", "detail": "Build diagnostic 🦀\n".repeat(4_000),
                }),
            ),
            SessionEvent::new(
                session,
                SessionEventKind::AssistantMessage,
                "The build passed.",
                json!({}),
            ),
            SessionEvent::new(
                session,
                SessionEventKind::UserMessage,
                "Continue",
                json!({}),
            ),
        ];
        let needs_compaction = |adapter, events: &[SessionEvent]| {
            should_compact_before_turn(85, adapter, "fixture", Some("model"), Some(512), events)
        };
        for adapter in [
            ProviderAdapterKind::OpenAiCompatible,
            ProviderAdapterKind::Ollama,
        ] {
            assert!(!needs_compaction(adapter, &events));
        }
        assert!(needs_compaction(ProviderAdapterKind::KimiAcp, &events));

        events[2].payload["contextUsage"] = json!({"inputTokens": 450, "modelContextWindow": 512});
        for adapter in [
            ProviderAdapterKind::OpenAiCompatible,
            ProviderAdapterKind::Ollama,
        ] {
            assert!(needs_compaction(adapter, &events));
        }

        events[2].payload = json!({});
        events[2].message = "🦀".repeat(1_800);
        for adapter in [
            ProviderAdapterKind::OpenAiCompatible,
            ProviderAdapterKind::Ollama,
        ] {
            assert!(needs_compaction(adapter, &events));
        }

        events.insert(3, SessionEvent::new(session, SessionEventKind::SystemEvent, "Checkpoint", json!({
            "kind": "provider-activity", "activityKind": "context", "activityId": "context-compaction-fixture",
            "status": "done", "contextSummary": "🦀".repeat(1_800),
        })));
        for adapter in [
            ProviderAdapterKind::OpenAiCompatible,
            ProviderAdapterKind::Ollama,
        ] {
            assert!(!needs_compaction(adapter, &events));
        }
    }

    #[test]
    fn only_successful_compaction_resets_context_occupancy() {
        for status in ["running", "failed", "cancelled", "done", "completed"] {
            let event = SessionEvent::new(
                Uuid::new_v4(),
                gyro_core::SessionEventKind::CommandOutput,
                "Context compaction",
                serde_json::json!({
                    "kind": "provider-activity",
                    "activityKind": "context",
                    "activityId": "context-compaction-test",
                    "status": status,
                }),
            );
            assert_eq!(
                session_context_signal(&event, true).session_compaction,
                matches!(status, "done" | "completed"),
                "{status}"
            );
        }
    }
}
