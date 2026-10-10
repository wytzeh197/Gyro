//! Append-only accounting receipts and attribution. Numeric observations only.
use anyhow::Result;
use rusqlite::{params, Connection};
use uuid::Uuid;
use crate::usage::{UsageTokens, UsageScope};

pub fn ensure_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "create table if not exists usage_receipt_revisions (
            id integer primary key autoincrement,
            usage_id text not null,
            schema_version integer not null default 1,
            tokens_json text not null,
            observed_at text not null
         );
         create index if not exists idx_usage_receipt_latest
         on usage_receipt_revisions(usage_id, id desc);
         create table if not exists usage_turn_links (
            child_session_id text not null, child_turn_id text not null,
            parent_session_id text not null, parent_turn_id text not null,
            primary key(child_session_id, child_turn_id)
         );
         create index if not exists idx_usage_turn_parent
         on usage_turn_links(parent_session_id, parent_turn_id);
         create table if not exists usage_call_expectations (
            session_id text not null, turn_id text not null, calls integer not null,
            primary key(session_id, turn_id)
         );"
    )?;
    Ok(())
}

/// A correction replaces a reading when folded; it is never additional spend.
pub fn append_revision(conn: &Connection, usage_id: Uuid, mut tokens: UsageTokens) -> Result<()> {
    tokens.accounting = Some(tokens.effective_accounting());
    conn.execute(
        "insert into usage_receipt_revisions(usage_id, tokens_json, observed_at)
         select id, ?2, ?3 from usage_ledger where id = ?1",
        params![usage_id.to_string(), serde_json::to_string(&tokens)?, chrono::Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

pub fn link_turn(conn: &Connection, child_session: Uuid, child_turn: Uuid,
    parent_session: Uuid, parent_turn: Uuid) -> Result<()> {
    if child_session == parent_session && child_turn == parent_turn { return Ok(()); }
    conn.execute(
        "insert or ignore into usage_turn_links
         (child_session_id, child_turn_id, parent_session_id, parent_turn_id)
         values (?1, ?2, ?3, ?4)",
        params![child_session.to_string(), child_turn.to_string(),
            parent_session.to_string(), parent_turn.to_string()],
    )?;
    Ok(())
}

pub fn note_call(conn: &Connection, session: Uuid, turn: Uuid) -> Result<()> {
    conn.execute(
        "insert into usage_call_expectations(session_id, turn_id, calls) values (?1, ?2, 1)
         on conflict(session_id, turn_id) do update set calls = calls + 1",
        params![session.to_string(), turn.to_string()],
    )?;
    Ok(())
}

fn fold_rows(conn: &Connection, sql: &str, parameters: &[&dyn rusqlite::ToSql]) -> Result<Option<UsageTokens>> {
    let mut statement = conn.prepare(sql)?;
    let rows = statement.query_map(parameters, |row| {
        Ok((row.get::<_, Option<String>>(0)?, row.get::<_, u64>(1)?,
            row.get::<_, u64>(2)?, row.get::<_, u64>(3)?,
            row.get::<_, u64>(4)?, row.get::<_, u64>(5)?, row.get::<_, bool>(6)?))
    })?;
    let mut total: Option<UsageTokens> = None;
    for row in rows {
        let (receipt, input, cached, output, reasoning, count, measured) = row?;
        let mut tokens = receipt.as_deref().and_then(|json| serde_json::from_str::<UsageTokens>(json).ok())
            .unwrap_or(UsageTokens {
                input_tokens: input, cached_input_tokens: cached,
                output_tokens: output, reasoning_output_tokens: reasoning,
                total_tokens: count, measured, ..UsageTokens::default()
            });
        // Occupancy and historical session counters cannot represent consumed work.
        if matches!(tokens.effective_accounting().scope, UsageScope::Context | UsageScope::Session) {
            tokens = UsageTokens::unavailable(crate::usage::UsageReason::UnknownScope);
        }
        if tokens.effective_accounting().coverage == crate::usage::UsageCoverage::Unavailable {
            let accounting = tokens.effective_accounting();
            tokens = UsageTokens { accounting: Some(accounting), ..UsageTokens::default() };
        }
        total = Some(match total { Some(previous) => previous.combine(tokens), None => tokens });
    }
    Ok(total)
}

const COLUMNS: &str = "(select tokens_json from usage_receipt_revisions r
    where r.usage_id = l.id order by r.id desc limit 1),
    l.input_tokens, l.cached_input_tokens, l.output_tokens,
    l.reasoning_output_tokens, l.total_tokens, l.measured";

pub fn session_tokens(conn: &Connection, session: Uuid) -> Result<Option<UsageTokens>> {
    let sql = format!("select {COLUMNS} from usage_ledger l where l.session_id = ?1 order by l.occurred_at, l.id");
    Ok(fold_rows(conn, &sql, &[&session.to_string()])?.map(|t| t.with_scope(UsageScope::Session)))
}

/// Traverse exact turn identities, not all historical turns in a reused child session.
pub fn task_tokens(conn: &Connection, session: Uuid, turn: Uuid) -> Result<Option<UsageTokens>> {
    let sql = format!(
        "with recursive owned(session_id, turn_id) as (
            select ?1, ?2 union
            select links.child_session_id, links.child_turn_id from usage_turn_links links
            join owned on links.parent_session_id = owned.session_id and links.parent_turn_id = owned.turn_id
         )
         select {COLUMNS} from usage_ledger l
         where exists(select 1 from owned where owned.session_id = l.session_id and owned.turn_id = l.turn_id)
         order by l.occurred_at, l.id");
    let parameters: [&dyn rusqlite::ToSql; 2] = [&session.to_string(), &turn.to_string()];
    let mut total = fold_rows(conn, &sql, &parameters)?;
    let missing: u64 = conn.query_row(
        "with recursive owned(session_id, turn_id) as (
            select ?1, ?2 union
            select links.child_session_id, links.child_turn_id from usage_turn_links links
            join owned on links.parent_session_id = owned.session_id and links.parent_turn_id = owned.turn_id
         ) select count(*) from owned where
            coalesce((select calls from usage_call_expectations e
                      where e.session_id = owned.session_id and e.turn_id = owned.turn_id),
                     case when owned.session_id = ?1 and owned.turn_id = ?2 then 0 else 1 end)
            > (select count(*) from usage_ledger l
               where l.session_id = owned.session_id and l.turn_id = owned.turn_id)
         ", &parameters[..], |row| row.get(0))?;
    if missing > 0 {
        total = Some(total.map(|t| t.partial(crate::usage::UsageReason::MissingUsage))
            .unwrap_or_else(|| UsageTokens::unavailable(crate::usage::UsageReason::MissingUsage)));
    }
    Ok(total.map(|t| t.with_scope(UsageScope::Task)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::{ensure_usage_schema, insert_usage_entry, UsageEntry, UsageOrigin, UsageOutcome, UsageCoverage, UsageReason};

    fn entry(session: Uuid, turn: Uuid, tokens: UsageTokens) -> UsageEntry {
        UsageEntry { session_id: session, turn_id: Some(turn), seat_id: None,
            provider_id: "fixture".into(), model_id: Some("fixture-model".into()),
            reasoning_effort: None, origin: UsageOrigin::Chat,
            outcome: UsageOutcome::Done, tokens, wall_ms: 0, retry_count: 0 }
    }
    fn count(n: u64) -> UsageTokens { UsageTokens::measured(Some(n), None, Some(0), None, Some(n)) }

    #[test]
    fn task_attribution_counts_continuations_and_children_once() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        let parent = Uuid::new_v4(); let turn = Uuid::new_v4();
        let child = Uuid::new_v4(); let child_turn = Uuid::new_v4();
        insert_usage_entry(&conn, &entry(parent, turn, count(100))).unwrap();
        insert_usage_entry(&conn, &entry(parent, turn, count(20))).unwrap();
        insert_usage_entry(&conn, &entry(child, child_turn, count(50))).unwrap();
        insert_usage_entry(&conn, &entry(child, Uuid::new_v4(), count(9000))).unwrap();
        link_turn(&conn, child, child_turn, parent, turn).unwrap();
        link_turn(&conn, child, child_turn, parent, turn).unwrap();
        // A malformed cycle must not repeat entries or hang the traversal.
        link_turn(&conn, parent, turn, child, child_turn).unwrap();
        let result = task_tokens(&conn, parent, turn).unwrap().unwrap();
        assert_eq!(result.total_tokens, 170);
        assert_eq!(result.effective_accounting().scope, UsageScope::Task);
        assert!(result.measured);
    }

    #[test]
    fn revisions_replace_without_double_counting_and_survive_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("usage.sqlite");
        let session = Uuid::new_v4(); let turn = Uuid::new_v4();
        { let conn = Connection::open(&path).unwrap();
          ensure_usage_schema(&conn).unwrap();
          let id = insert_usage_entry(&conn, &entry(session, turn, count(10).partial(UsageReason::MissingUsage))).unwrap();
          append_revision(&conn, id, count(40).with_cache_write(Some(5))).unwrap();
          append_revision(&conn, id, count(40).with_cache_write(Some(5))).unwrap(); }
        let conn = Connection::open(&path).unwrap();
        ensure_usage_schema(&conn).unwrap();
        let result = task_tokens(&conn, session, turn).unwrap().unwrap();
        assert_eq!((result.total_tokens, result.cache_write_tokens), (40, 5));
        assert_eq!(result.effective_accounting().coverage, UsageCoverage::Complete);
        assert_eq!(crate::usage::session_usage_totals(&conn, session).unwrap().total_tokens, 40);
    }

    #[test]
    fn missing_retry_receipt_downgrades_the_turn_and_empty_turn_is_unavailable() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        let session = Uuid::new_v4(); let turn = Uuid::new_v4();
        note_call(&conn, session, turn).unwrap();
        let empty = task_tokens(&conn, session, turn).unwrap().unwrap();
        assert_eq!(empty.effective_accounting().coverage, UsageCoverage::Unavailable);
        insert_usage_entry(&conn, &entry(session, turn, count(100))).unwrap();
        note_call(&conn, session, turn).unwrap();
        let partial = task_tokens(&conn, session, turn).unwrap().unwrap();
        assert_eq!(partial.total_tokens, 100);
        assert_eq!(partial.effective_accounting().coverage, UsageCoverage::Partial);
        insert_usage_entry(&conn, &entry(session, turn, count(20))).unwrap();
        let complete = task_tokens(&conn, session, turn).unwrap().unwrap();
        assert_eq!(complete.total_tokens, 120);
        assert_eq!(complete.effective_accounting().coverage, UsageCoverage::Complete);
    }

    #[test]
    fn council_container_counts_seats_without_requiring_an_unbilled_root_call() {
        let conn = Connection::open_in_memory().unwrap(); ensure_usage_schema(&conn).unwrap();
        let session = Uuid::new_v4(); let root = Uuid::new_v4();
        for amount in [100, 50, 20] {
            let seat = Uuid::new_v4();
            link_turn(&conn, session, seat, session, root).unwrap();
            note_call(&conn, session, seat).unwrap();
            insert_usage_entry(&conn, &entry(session, seat, count(amount))).unwrap();
        }
        let result = task_tokens(&conn, session, root).unwrap().unwrap();
        assert_eq!(result.total_tokens, 170);
        assert_eq!(result.effective_accounting().coverage, UsageCoverage::Complete);
    }

    #[test]
    fn occupancy_cannot_be_counted_as_consumption() {
        let conn = Connection::open_in_memory().unwrap(); ensure_usage_schema(&conn).unwrap();
        let session = Uuid::new_v4(); let turn = Uuid::new_v4();
        insert_usage_entry(&conn, &entry(session, turn, count(9000).with_scope(UsageScope::Context))).unwrap();
        let result = task_tokens(&conn, session, turn).unwrap().unwrap();
        assert_eq!(result.total_tokens, 0);
        assert_eq!(result.effective_accounting().coverage, UsageCoverage::Unavailable);
        assert_eq!(crate::usage::session_usage_totals(&conn, session).unwrap().total_tokens, 0);
    }

    #[test]
    fn legacy_values_are_preserved_as_records_but_never_become_verified_task_spend() {
        let conn = Connection::open_in_memory().unwrap(); ensure_usage_schema(&conn).unwrap();
        let session = Uuid::new_v4(); let turn = Uuid::new_v4();
        let legacy = UsageTokens { input_tokens: 90, output_tokens: 10, total_tokens: 100,
            measured: true, ..UsageTokens::default() };
        insert_usage_entry(&conn, &entry(session, turn, legacy)).unwrap();
        assert_eq!(task_tokens(&conn, session, turn).unwrap().unwrap().total_tokens, 0);
        insert_usage_entry(&conn, &entry(session, turn, legacy)).unwrap();
        let result = task_tokens(&conn, session, turn).unwrap().unwrap();
        assert_eq!(result.total_tokens, 0);
        assert_eq!(result.effective_accounting().coverage, UsageCoverage::Unavailable);
        assert_eq!(crate::usage::session_usage_totals(&conn, session).unwrap().total_tokens, 200);
    }

    #[test]
    fn unavailable_child_downgrades_whole_task_without_fabricating_zero() {
        let conn = Connection::open_in_memory().unwrap(); ensure_usage_schema(&conn).unwrap();
        let parent = Uuid::new_v4(); let turn = Uuid::new_v4();
        let child = Uuid::new_v4(); let child_turn = Uuid::new_v4();
        insert_usage_entry(&conn, &entry(parent, turn, count(100))).unwrap();
        insert_usage_entry(&conn, &entry(child, child_turn, UsageTokens::unavailable(UsageReason::UnsupportedRuntime))).unwrap();
        link_turn(&conn, child, child_turn, parent, turn).unwrap();
        let result = task_tokens(&conn, parent, turn).unwrap().unwrap();
        assert_eq!(result.total_tokens, 100);
        assert_eq!(result.effective_accounting().coverage, UsageCoverage::Partial);
    }
}
