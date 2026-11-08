//! Durable ownership of automatic titles. The fallback is pending until a
//! model names the chat; retries and restarts must not turn it into a manual name.
use super::*;

impl SessionStore {
    /// Start automatic naming only if the caller still owns the observed title.
    /// An existing manual/model decision is never reopened.
    pub fn begin_session_title(
        &self,
        session_id: Uuid,
        expected_title: &str,
        fallback: &str,
        task: &str,
    ) -> Result<Option<Session>> {
        let fallback = normalize_session_title(fallback.to_string())?;
        let transaction = self.conn.unchecked_transaction()?;
        let inserted = transaction.execute(
            "insert or ignore into session_titles(session_id, source, expected_title, task)
             select id, 'pending', ?3, ?4 from sessions where id = ?1 and title = ?2",
            params![
                session_id.to_string(),
                expected_title,
                fallback,
                task.chars().take(4096).collect::<String>()
            ],
        )?;
        if inserted == 0 {
            return Ok(None);
        }
        transaction.execute(
            "update sessions set title = ?2 where id = ?1 and title = ?3",
            params![session_id.to_string(), fallback, expected_title],
        )?;
        transaction.commit()?;
        self.get_session(session_id)
    }

    /// The original task is retained so a retry saying "continue" cannot name
    /// the chat after the continuation instead of its actual subject.
    pub fn pending_session_title(&self, session_id: Uuid) -> Result<Option<(String, String)>> {
        Ok(self
            .conn
            .query_row(
                "select t.expected_title, t.task from session_titles t
             join sessions s on s.id = t.session_id
             where t.session_id = ?1 and t.source = 'pending' and s.title = t.expected_title",
                params![session_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?)
    }

    /// Apply once, atomically against the current title and ownership. A manual
    /// rename on another connection always wins, even if its text is unchanged.
    pub fn apply_session_title(
        &self,
        session_id: Uuid,
        expected_title: &str,
        title: &str,
    ) -> Result<Option<Session>> {
        let title = normalize_session_title(title.to_string())?;
        let transaction = self.conn.unchecked_transaction()?;
        let changed = transaction.execute(
            "update sessions set title = ?3 where id = ?1 and title = ?2 and exists (
               select 1 from session_titles where session_id = ?1
               and source = 'pending' and expected_title = ?2
             )",
            params![session_id.to_string(), expected_title, title],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        transaction.execute(
            "update session_titles set source = 'model', expected_title = ?2, task = '' where session_id = ?1",
            params![session_id.to_string(), title],
        )?;
        transaction.commit()?;
        self.get_session(session_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_title_pending_survives_reopen_and_original_task_survives_retry() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let store = SessionStore::open(paths.clone()).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "New chat")
            .unwrap();
        store
            .begin_session_title(
                session.id,
                "New chat",
                "I Find The Entire Run And",
                "The Run and Test panel is too tall",
            )
            .unwrap()
            .unwrap();
        drop(store);
        let store = SessionStore::open(paths).unwrap();
        assert_eq!(
            store.pending_session_title(session.id).unwrap(),
            Some((
                "I Find The Entire Run And".into(),
                "The Run and Test panel is too tall".into()
            ))
        );
        assert!(store
            .begin_session_title(
                session.id,
                "I Find The Entire Run And",
                "Continue",
                "continue"
            )
            .unwrap()
            .is_none());
        let renamed = store
            .apply_session_title(
                session.id,
                "I Find The Entire Run And",
                "Compact Run and Test",
            )
            .unwrap()
            .unwrap();
        assert_eq!(renamed.title, "Compact Run and Test");
        assert!(store.pending_session_title(session.id).unwrap().is_none());
        assert!(store
            .begin_session_title(session.id, &renamed.title, "Continue", "continue")
            .unwrap()
            .is_none());
    }

    #[test]
    fn session_title_manual_rename_on_another_connection_wins_even_with_same_text() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let store = SessionStore::open(paths.clone()).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "New chat")
            .unwrap();
        store
            .begin_session_title(session.id, "New chat", "Fix Layout", "fix layout")
            .unwrap()
            .unwrap();
        let other = SessionStore::open(paths).unwrap();
        other.rename_session(session.id, "Fix Layout").unwrap();
        assert!(store
            .apply_session_title(session.id, "Fix Layout", "Model title")
            .unwrap()
            .is_none());
        assert!(store.pending_session_title(session.id).unwrap().is_none());
        assert!(store
            .begin_session_title(session.id, "Fix Layout", "Continue", "continue")
            .unwrap()
            .is_none());
        assert_eq!(
            store.get_session(session.id).unwrap().unwrap().title,
            "Fix Layout"
        );
    }

    #[test]
    fn session_title_compare_and_swap_rejects_stale_candidates() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
        let session = store
            .create_session(temp.path(), SessionOrigin::Desktop, "My name")
            .unwrap();
        assert!(store
            .begin_session_title(session.id, "New chat", "Fallback", "task")
            .unwrap()
            .is_none());
        assert_eq!(
            store.get_session(session.id).unwrap().unwrap().title,
            "My name"
        );
        store
            .begin_session_title(session.id, "My name", "Fallback", "task")
            .unwrap()
            .unwrap();
        assert!(store
            .apply_session_title(session.id, "Stale fallback", "Wrong")
            .unwrap()
            .is_none());
        store
            .apply_session_title(session.id, "Fallback", "Same title")
            .unwrap()
            .unwrap();
        assert!(store
            .apply_session_title(session.id, "Fallback", "Second title")
            .unwrap()
            .is_none());
    }
}
