use super::pricing::{Cost, PriceSnapshot};
use crate::usage::{UsageScope, UsageTokens};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::BTreeMap;
use uuid::Uuid;
pub fn ensure_schema(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch("create table if not exists efficiency_task_turns(task_id text not null,session_id text not null,turn_id text not null,primary key(session_id,turn_id)); create index if not exists efficiency_task_members on efficiency_task_turns(task_id); create table if not exists efficiency_call_metadata(usage_id text primary key,price_json text,attribution_json text not null); create table if not exists efficiency_task_verifications(task_id text primary key,verifier text not null,passed integer not null);")?;
    Ok(())
}
pub fn link(conn: &Connection, task: Uuid, session: Uuid, turn: Uuid) -> anyhow::Result<()> {
    conn.execute(
        "insert or ignore into efficiency_task_turns values(?1,?2,?3)",
        params![task.to_string(), session.to_string(), turn.to_string()],
    )?;
    Ok(())
}
pub fn metadata(
    conn: &Connection,
    usage: Uuid,
    price: Option<&PriceSnapshot>,
    attribution: &super::context::Attribution,
) -> anyhow::Result<()> {
    conn.execute(
        "insert or ignore into efficiency_call_metadata values(?1,?2,?3)",
        params![
            usage.to_string(),
            price.map(serde_json::to_string).transpose()?,
            serde_json::to_string(attribution)?
        ],
    )?;
    Ok(())
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskTotals {
    pub calls: u64,
    pub failed_calls: u64,
    pub retries: u64,
    pub wall_ms: u64,
    pub tokens: Option<UsageTokens>,
    pub costs: Vec<Cost>,
    pub unpriced_calls: u64,
    pub verified: bool,
    /// Known bytes newly removed by retirement, counted once per rewrite.
    pub retired_bytes: u64,
    /// Whether every linked receipt has the current retirement accounting.
    pub retirement_coverage: RetirementCoverage,
    /// Aggregate observed tool classes; partial/unavailable must not imply zero.
    pub tool_class_counts: BTreeMap<String, u64>,
    pub tool_class_coverage: RetirementCoverage,
    pub generation_attempts: super::context::GenerationAttempts,
    pub generation_coverage: RetirementCoverage,
    pub efficiency_events: super::context::EfficiencyEvents,
    pub efficiency_event_coverage: RetirementCoverage,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RetirementCoverage {
    Complete,
    Partial,
    #[default]
    Unavailable,
}
pub fn totals(conn: &Connection, task: Uuid) -> anyhow::Result<TaskTotals> {
    // UNION deduplicates reused child turns and multiple paths through the delegation graph.
    let mut statement=conn.prepare("with recursive owned(session_id,turn_id) as (select session_id,turn_id from efficiency_task_turns where task_id=?1 union select child_session_id,child_turn_id from usage_turn_links l join owned o on l.parent_session_id=o.session_id and l.parent_turn_id=o.turn_id) select l.outcome,l.retry_count,l.wall_ms,(select tokens_json from usage_receipt_revisions r where r.usage_id=l.id order by id desc limit 1),m.price_json,m.attribution_json from usage_ledger l left join efficiency_call_metadata m on m.usage_id=l.id where exists(select 1 from owned o where o.session_id=l.session_id and o.turn_id=l.turn_id)")?;
    let rows = statement.query_map([task.to_string()], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, u64>(1)?,
            r.get::<_, u64>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, Option<String>>(5)?,
        ))
    })?;
    let mut out = TaskTotals::default();
    let mut retirement_known = 0u64;
    let mut tool_classes_known = 0u64;
    let mut generations_known = 0u64;
    let mut events_known = 0u64;
    for row in rows {
        let (outcome, retries, wall, tokens, price, attribution) = row?;
        out.calls += 1;
        out.failed_calls += u64::from(outcome != "done");
        out.retries += retries;
        out.wall_ms += wall;
        if let Some(attribution) = attribution.as_deref().and_then(|json| {
            serde_json::from_str::<crate::efficiency::context::Attribution>(json).ok()
        }) {
            if attribution.retirement_accounting_version == Some(2) {
                retirement_known += 1;
                out.retired_bytes = out.retired_bytes.saturating_add(attribution.retired_bytes);
            }
            if let Some(classes) = attribution.tool_class_counts {
                tool_classes_known += 1;
                for (class, count) in classes {
                    let class = crate::provider_observation::normalize_tool_class(&class);
                    let total = out.tool_class_counts.entry(class.to_owned()).or_default();
                    *total = total.saturating_add(count);
                }
            }
            if let Some(events) = attribution.efficiency_events {
                events_known += 1;
                out.efficiency_events.combine(&events);
            }
            if let Some(generations) = attribution.generation_attempts {
                generations_known += 1;
                out.generation_attempts.combine(&generations);
            }
        }
        let tokens = tokens
            .as_deref()
            .and_then(|s| serde_json::from_str::<UsageTokens>(s).ok())
            .filter(|t| {
                !matches!(
                    t.effective_accounting().scope,
                    UsageScope::Context | UsageScope::Session
                )
            });
        let observed = tokens
            .unwrap_or_else(|| UsageTokens::unavailable(crate::usage::UsageReason::MissingUsage));
        out.tokens = Some(out.tokens.map_or(observed, |a| a.combine(observed)));
        let cost = price
            .as_deref()
            .and_then(|s| serde_json::from_str::<PriceSnapshot>(s).ok())
            .and_then(|p| tokens.and_then(|t| p.price(t)));
        if let Some(cost) = cost {
            out.costs.push(cost);
        } else {
            out.unpriced_calls += 1;
        }
    }
    out.retirement_coverage = match (retirement_known, out.calls) {
        (0, _) => RetirementCoverage::Unavailable,
        (known, all) if known == all => RetirementCoverage::Complete,
        _ => RetirementCoverage::Partial,
    };
    out.tool_class_coverage = match (tool_classes_known, out.calls) {
        (0, _) => RetirementCoverage::Unavailable,
        (known, all) if known == all => RetirementCoverage::Complete,
        _ => RetirementCoverage::Partial,
    };
    out.generation_coverage = match (generations_known, out.calls) {
        (0, _) => RetirementCoverage::Unavailable,
        (known, all) if known == all => RetirementCoverage::Complete,
        _ => RetirementCoverage::Partial,
    };
    out.efficiency_event_coverage = match (events_known, out.calls) {
        (0, _) => RetirementCoverage::Unavailable,
        (known, all) if known == all => RetirementCoverage::Complete,
        _ => RetirementCoverage::Partial,
    };
    out.verified = conn.query_row(
        "select coalesce((select passed from efficiency_task_verifications where task_id=?1),0)",
        [task.to_string()],
        |r| r.get::<_, bool>(0),
    )?;
    Ok(out)
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{UsageEntry, UsageOrigin, UsageOutcome};
    #[test]
    fn multi_turn_and_children_count_once() {
        let c = Connection::open_in_memory().unwrap();
        crate::usage::ensure_usage_schema(&c).unwrap();
        let task = Uuid::new_v4();
        let session = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let child = Uuid::new_v4();
        for (s, t) in [(session, a), (session, b), (child, b)] {
            let entry = UsageEntry {
                session_id: s,
                turn_id: Some(t),
                seat_id: None,
                provider_id: "custom:a".into(),
                model_id: Some("m".into()),
                reasoning_effort: None,
                origin: UsageOrigin::Chat,
                outcome: UsageOutcome::Done,
                tokens: UsageTokens::measured(Some(10), Some(0), Some(2), Some(0), Some(12)),
                wall_ms: 1,
                retry_count: 0,
            };
            crate::usage::insert_usage_entry(&c, &entry).unwrap();
        }
        link(&c, task, session, a).unwrap();
        link(&c, task, session, b).unwrap();
        crate::usage_receipts::link_turn(&c, child, b, session, a).unwrap();
        crate::usage_receipts::link_turn(&c, child, b, session, b).unwrap();
        let total = totals(&c, task).unwrap();
        assert_eq!(total.calls, 3);
        assert_eq!(total.tokens.unwrap().total_tokens, 36);
        assert!(!total.verified);
    }
    #[test]
    fn retired_bytes_survive_the_call_metadata_round_trip() {
        let attribution = crate::efficiency::context::Attribution {
            retired_bytes: 2_048,
            ..Default::default()
        };
        let json = serde_json::to_string(&attribution).unwrap();
        assert!(json.contains("\"retiredBytes\":2048"));
        let parsed: crate::efficiency::context::Attribution = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.retired_bytes, 2_048);
        // Rows written before the field existed must still parse and sum as zero.
        let mut legacy: serde_json::Value = serde_json::from_str(&json).unwrap();
        legacy.as_object_mut().unwrap().remove("retiredBytes");
        let legacy: crate::efficiency::context::Attribution =
            serde_json::from_value(legacy).unwrap();
        assert_eq!(legacy.retired_bytes, 0);
        assert_eq!(legacy.retirement_accounting_version, None);
    }

    #[test]
    fn retirement_observer_receipts_and_legacy_coverage_are_truthful() {
        use crate::provider_observation::{self as observer, Request, Scope};
        use serde_json::json;
        let conn = Connection::open_in_memory().unwrap();
        crate::usage::ensure_usage_schema(&conn).unwrap();
        let task = Uuid::new_v4();
        let session = Uuid::new_v4();
        let turn = Uuid::new_v4();
        let child = Uuid::new_v4();
        let child_turn = Uuid::new_v4();
        let _scope = Scope::start();
        observer::retired_context(2_048);
        drop(Request::start(&json!({"messages": []})));
        observer::retry();
        drop(Request::start(&json!({"messages": []})));
        observer::retired_context(512);
        observer::observe_tool_class("workspace-read");
        observer::observe_tool_class("workspace-read");
        observer::observe_tool_class("terminal");
        drop(Request::start(&json!({"messages": []})));
        observer::efficiency_event(|e| {
            e.spill_recoveries = 2;
            e.catalog_discoveries = 1;
        });
        let summary = observer::snapshot().unwrap();
        let mut observed = summary.context_attribution;
        observed.tool_class_counts = Some(summary.tool_class_counts);
        observed.generation_attempts = Some(super::super::context::GenerationAttempts {
            started: u64::from(summary.requests),
            completed: u64::from(summary.completed),
            rejected: u64::from(summary.rejected),
            retries: u64::from(summary.retries),
        });
        let entry = |session_id, turn_id| UsageEntry {
            session_id,
            turn_id: Some(turn_id),
            seat_id: None,
            provider_id: "custom:test".into(),
            model_id: None,
            reasoning_effort: None,
            origin: UsageOrigin::Chat,
            outcome: UsageOutcome::Cancelled,
            tokens: UsageTokens::unavailable(crate::usage::UsageReason::MissingUsage),
            wall_ms: 0,
            retry_count: 1,
        };
        let id = crate::usage::insert_usage_entry(&conn, &entry(session, turn)).unwrap();
        metadata(&conn, id, None, &observed).unwrap();
        link(&conn, task, session, turn).unwrap();
        let complete = totals(&conn, task).unwrap();
        assert_eq!(complete.retired_bytes, 2_560);
        assert_eq!(complete.retirement_coverage, RetirementCoverage::Complete);
        assert_eq!(complete.tool_class_counts.get("workspace-read"), Some(&2));
        assert_eq!(complete.tool_class_counts.get("terminal"), Some(&1));
        assert_eq!(complete.tool_class_coverage, RetirementCoverage::Complete);
        assert_eq!(complete.generation_attempts.started, 3);
        assert_eq!(complete.generation_attempts.retries, 1);
        assert_eq!(complete.generation_coverage, RetirementCoverage::Complete);
        assert_eq!(complete.efficiency_events.spill_recoveries, 2);
        assert_eq!(
            complete.efficiency_event_coverage,
            RetirementCoverage::Complete
        );

        // A legacy row is unknown even if it contains a numeric value.
        let old_id = crate::usage::insert_usage_entry(&conn, &entry(child, child_turn)).unwrap();
        metadata(
            &conn,
            old_id,
            None,
            &super::super::context::Attribution {
                retired_bytes: 99,
                ..Default::default()
            },
        )
        .unwrap();
        crate::usage_receipts::link_turn(&conn, child, child_turn, session, turn).unwrap();
        // A second path to the same child must not duplicate its receipt.
        link(&conn, task, child, child_turn).unwrap();
        let partial = totals(&conn, task).unwrap();
        assert_eq!(partial.calls, 2);
        assert_eq!(partial.retired_bytes, 2_560);
        assert_eq!(partial.retirement_coverage, RetirementCoverage::Partial);
        assert_eq!(partial.tool_class_counts.get("workspace-read"), Some(&2));
        assert_eq!(partial.tool_class_coverage, RetirementCoverage::Partial);
        assert_eq!(partial.generation_attempts.started, 3);
        assert_eq!(partial.generation_coverage, RetirementCoverage::Partial);
        assert_eq!(partial.efficiency_events.spill_recoveries, 2);
        assert_eq!(
            partial.efficiency_event_coverage,
            RetirementCoverage::Partial
        );

        let old_task = Uuid::new_v4();
        link(&conn, old_task, child, child_turn).unwrap();
        let unavailable = totals(&conn, old_task).unwrap();
        assert_eq!(
            unavailable.retirement_coverage,
            RetirementCoverage::Unavailable
        );
        assert_eq!(unavailable.retired_bytes, 0);
        assert_eq!(
            unavailable.efficiency_event_coverage,
            RetirementCoverage::Unavailable
        );
        assert_eq!(
            unavailable.tool_class_coverage,
            RetirementCoverage::Unavailable
        );
        assert_eq!(
            unavailable.generation_coverage,
            RetirementCoverage::Unavailable
        );
    }
}
