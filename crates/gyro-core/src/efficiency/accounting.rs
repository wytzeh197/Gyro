use super::pricing::{Cost, PriceSnapshot};
use crate::usage::{UsageScope, UsageTokens};
use rusqlite::{params, Connection};
use serde::Serialize;
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
    /// Bytes withheld from provider requests by context retirement across this task's calls.
    pub retired_bytes: u64,
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
    for row in rows {
        let (outcome, retries, wall, tokens, price, attribution) = row?;
        out.calls += 1;
        out.failed_calls += u64::from(outcome != "done");
        out.retries += retries;
        out.wall_ms += wall;
        out.retired_bytes += attribution.as_deref().map_or(0, |json| {
            serde_json::from_str::<crate::efficiency::context::Attribution>(json)
                .map_or(0, |attribution| attribution.retired_bytes)
        });
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
    }
}
