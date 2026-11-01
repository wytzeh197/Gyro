//! Select owned rows through indexes rather than visiting the entire ledger.
//! UNION preserves one count per call and terminates cyclic turn links.
pub(crate) const SESSION_LEDGER_IDS: &str = "with recursive owned(session_id, turn_id) as (
    select child_session_id, child_turn_id from usage_turn_links
    where parent_session_id = ?1
    union
    select links.child_session_id, links.child_turn_id from usage_turn_links links
    join owned on links.parent_session_id = owned.session_id
        and links.parent_turn_id = owned.turn_id
)
select id from usage_ledger where session_id = ?1
union
select id from usage_ledger
where (session_id, turn_id) in (select session_id, turn_id from owned)";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::ensure_usage_schema;
    use rusqlite::{params, Connection};

    #[test]
    fn ownership_lookup_does_not_scan_unrelated_history_after_schema_upgrade() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("usage.sqlite");
        {
            let conn = Connection::open(&path).unwrap();
            ensure_usage_schema(&conn).unwrap();
            conn.execute_batch("drop index idx_usage_ledger_session_turn;
                with recursive n(x) as (select 1 union all select x+1 from n where x < 2000)
                insert into usage_ledger (id, occurred_at, session_id, turn_id, provider_id, origin, outcome)
                select cast(x as text), 'same-time', 'child', cast(x as text), 'fixture', 'chat', 'done' from n;
                insert into usage_turn_links values ('child', '2', 'root', '1');").unwrap();
        }
        let conn = Connection::open(&path).unwrap();
        ensure_usage_schema(&conn).unwrap();
        ensure_usage_schema(&conn).unwrap(); // Migration is idempotent.
        let sql = format!("select id from usage_ledger where id in ({SESSION_LEDGER_IDS})");
        let mut stmt = conn.prepare(&sql).unwrap();
        let ids: Vec<String> = stmt
            .query_map(["root"], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(ids, ["2"]);
        // An operation-count check, not a flaky wall-clock assertion.
        assert!(stmt.get_status(rusqlite::StatementStatus::FullscanStep) < 20);
        assert_eq!(
            conn.query_row("select count(*) from usage_ledger", [], |row| row
                .get::<_, u64>(0))
                .unwrap(),
            2000
        );
    }

    #[test]
    fn indexed_ownership_matches_original_for_cycles_null_turns_and_reused_children() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        for (child, turn, parent, parent_turn) in [
            ("child", "owned", "root", "a"),
            ("grandchild", "nested", "child", "owned"),
            ("root", "a", "grandchild", "nested"),
            ("other", "other-turn", "child", "unrelated"),
        ] {
            conn.execute(
                "insert into usage_turn_links values (?1, ?2, ?3, ?4)",
                params![child, turn, parent, parent_turn],
            )
            .unwrap();
        }
        for (index, (session, turn)) in [
            ("root", Some("a")),
            ("root", None),
            ("root", Some("unlinked")),
            ("child", Some("owned")),
            ("child", Some("owned")),
            ("child", Some("unrelated")),
            ("child", None),
            ("grandchild", Some("nested")),
            ("grandchild", Some("old")),
            ("other", Some("other-turn")),
        ]
        .iter()
        .enumerate()
        {
            conn.execute("insert into usage_ledger (id, occurred_at, session_id, turn_id, provider_id, origin, outcome)
                values (?1, 'same-time', ?2, ?3, 'fixture', 'chat', 'done')",
                params![index.to_string(), session, turn]).unwrap();
        }
        let original = "with recursive owned(session_id, turn_id) as (
            select child_session_id, child_turn_id from usage_turn_links where parent_session_id = ?1
            union select links.child_session_id, links.child_turn_id from usage_turn_links links
            join owned on links.parent_session_id = owned.session_id and links.parent_turn_id = owned.turn_id
        ) select id from usage_ledger l where session_id = ?1 or exists (
            select 1 from owned where owned.session_id = l.session_id and owned.turn_id = l.turn_id)
            order by id";
        let updated =
            format!("select id from usage_ledger where id in ({SESSION_LEDGER_IDS}) order by id");
        let read = |sql: &str, session: &str| -> Vec<String> {
            conn.prepare(sql)
                .unwrap()
                .query_map([session], |row| row.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap()
        };
        for session in ["root", "child", "grandchild", "other", "empty"] {
            assert_eq!(
                read(&updated, session),
                read(original, session),
                "{session}"
            );
        }
        assert_eq!(read(&updated, "root"), ["0", "1", "2", "3", "4", "7"]);
    }
}
