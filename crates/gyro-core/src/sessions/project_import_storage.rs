//! Durable, replayable publication of imported transcripts. Provider transcripts
//! stay read-only; a private JSONL snapshot is committed before its SQLite index.
use super::*;
use crate::project_import::{NormalizedProjectImport, SourceKind};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionImportSource {
    pub source_kind: SourceKind,
    pub source_session_id: String,
    pub data_home: String,
    pub transcript_path: String,
    pub imported_at: DateTime<Utc>,
    #[serde(default)]
    pub fresh_session_requested: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectImportCommit {
    pub session: Session,
    pub existing: bool,
}

#[derive(Deserialize, Serialize)]
struct PendingImportMetadata {
    log_offset: u64,
    event: SessionEvent,
}

impl SessionStore {
    pub(super) fn ensure_project_import_schema(&self) -> Result<()> {
        self.conn.execute_batch(
            "create table if not exists project_imports (
               provider_id text not null,
               source_session_id text not null,
               session_id text not null,
               imported_at text not null,
               primary key (provider_id, source_session_id)
             );
             create index if not exists idx_project_imports_session_id
             on project_imports(session_id);
             create table if not exists project_import_metadata_commits (
               operation_id text primary key,
               session_id text not null
             );",
        )?;
        Ok(())
    }

    /// Match both import provenance and sessions Gyro already ran through a
    /// provider. Native IDs are provider-scoped, never workspace-scoped.
    pub fn find_project_import_session(
        &self,
        source_kind: SourceKind,
        source_session_id: &str,
    ) -> Result<Option<Session>> {
        let provider = source_kind.provider_id();
        let existing: Option<String> = self
            .conn
            .query_row(
                "select i.session_id from project_imports i join sessions s on s.id = i.session_id
             where i.provider_id = ?1 and i.source_session_id = ?2",
                params![provider, source_session_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(id) = existing {
            return self.get_session(Uuid::parse_str(&id)?);
        }
        // Provenance survives an explicit detach from the original provider.
        // If the rebuildable mapping was lost, do not duplicate that chat.
        let mut statement = self.conn.prepare(
            "select id, import_source_json from sessions where import_source_json is not null",
        )?;
        let imports = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for imported in imports {
            let (id, source) = imported?;
            if serde_json::from_str::<SessionImportSource>(&source)
                .ok()
                .is_some_and(|source| {
                    source.source_kind == source_kind
                        && source.source_session_id == source_session_id
                })
            {
                return self.get_session(Uuid::parse_str(&id)?);
            }
        }
        // Bindings are small; parse cursors rather than require SQLite JSON1.
        let mut statement = self.conn.prepare(
            "select b.session_id, b.resume_cursor_json from provider_session_bindings b
             join sessions s on s.id = b.session_id where b.provider_id = ?1",
        )?;
        let bindings = statement.query_map(params![provider], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for binding in bindings {
            let (id, cursor) = binding?;
            if serde_json::from_str::<Value>(&cursor)
                .ok()
                .is_some_and(|value| {
                    value.get("sessionId").and_then(Value::as_str) == Some(source_session_id)
                        && value.get("kind").and_then(Value::as_str)
                            == Some(source_kind.cursor_kind())
                })
            {
                return self.get_session(Uuid::parse_str(&id)?);
            }
        }
        Ok(None)
    }

    pub fn import_project_session(
        &self,
        import: NormalizedProjectImport,
    ) -> Result<ProjectImportCommit> {
        let candidate = &import.candidate;
        if let Some(session) =
            self.find_project_import_session(candidate.source_kind, &candidate.source_session_id)?
        {
            return Ok(ProjectImportCommit {
                session,
                existing: true,
            });
        }
        anyhow::ensure!(
            !import.events.is_empty(),
            "conversation contains no supported history"
        );
        let workspace_path = PathBuf::from(&candidate.workspace_path);
        anyhow::ensure!(
            workspace_path.is_absolute(),
            "imported project path must be absolute"
        );
        anyhow::ensure!(
            !candidate.source_session_id.trim().is_empty(),
            "native conversation ID is missing"
        );
        let id = Uuid::new_v4();
        let events_path = self.paths.sessions_dir.join(format!("import-{id}.jsonl"));
        let stage = self.paths.sessions_dir.join(format!(".import-{id}.tmp"));
        let session = Session {
            id,
            title: normalize_session_title(candidate.title.clone())?,
            workspace_identity: WorkspaceIdentity::for_session(
                &workspace_path,
                SessionWorkspaceMode::Local,
            ),
            workspace_path,
            origin: SessionOrigin::Desktop,
            parent_session_id: None,
            workspace_mode: SessionWorkspaceMode::Local,
            branch: "main".into(),
            worktree_name: None,
            provider_id: Some(candidate.source_kind.provider_id().into()),
            provider_label: Some(
                match candidate.source_kind {
                    SourceKind::ClaudeCode => "Claude",
                    SourceKind::Codex => "OpenAI",
                }
                .into(),
            ),
            model_id: candidate.model_id.clone(),
            model_label: candidate.model_id.clone(),
            reasoning_effort: None,
            summary: None,
            summary_updated_at: None,
            created_at: candidate.created_at,
            updated_at: candidate.updated_at,
            events_path,
            import_source: Some(SessionImportSource {
                source_kind: candidate.source_kind,
                source_session_id: candidate.source_session_id.clone(),
                data_home: candidate.data_home.clone(),
                transcript_path: candidate.transcript_path.clone(),
                imported_at: Utc::now(),
                fresh_session_requested: false,
            }),
        };
        let mut first = SessionEvent::new(
            id,
            SessionEventKind::SessionCreated,
            "Conversation imported",
            serde_json::json!({
                "projectImportVersion": 1, "importedSession": session, "historical": true,
            }),
        );
        first.created_at = session.created_at;
        let stage_result = (|| -> Result<()> {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
            }
            let mut file = options
                .open(&stage)
                .context("create private import staging file")?;
            write_import_event(&mut file, &first)?;
            for mut event in import.events {
                anyhow::ensure!(
                    matches!(
                        event.kind,
                        SessionEventKind::UserMessage
                            | SessionEventKind::AssistantMessage
                            | SessionEventKind::SystemEvent
                    ),
                    "unsupported historical event kind"
                );
                event.session_id = id;
                event.message = normalize_session_event_message(event.message)?;
                if !event.payload.is_object() {
                    event.payload = serde_json::json!({});
                }
                event.payload["historical"] = Value::Bool(true);
                event.payload["imported"] = Value::Bool(true);
                event.payload = validate_session_event_payload(event.payload)?;
                write_import_event(&mut file, &event)?;
            }
            file.flush()?;
            file.sync_all().context("sync imported conversation")?;
            Ok(())
        })();
        if let Err(error) = stage_result {
            let _ = std::fs::remove_file(&stage);
            return Err(error);
        }
        let commit = (|| -> Result<ProjectImportCommit> {
            // Serialize publication across desktop processes. The second dedup
            // check runs after acquiring the SQLite writer lock.
            let transaction = rusqlite::Transaction::new_unchecked(
                &self.conn,
                rusqlite::TransactionBehavior::Immediate,
            )?;
            if let Some(existing) = self
                .find_project_import_session(candidate.source_kind, &candidate.source_session_id)?
            {
                let _ = std::fs::remove_file(&stage);
                transaction.commit()?;
                return Ok(ProjectImportCommit {
                    session: existing,
                    existing: true,
                });
            }
            std::fs::rename(&stage, &session.events_path)
                .context("commit imported conversation log")?;
            File::open(&self.paths.sessions_dir)?
                .sync_all()
                .context("sync imported conversation directory")?;
            publish_import_index(&transaction, &session)?;
            transaction.commit()?;
            Ok(ProjectImportCommit {
                session: session.clone(),
                existing: false,
            })
        })();
        if commit.is_err() {
            let _ = std::fs::remove_file(&stage);
        }
        // Once renamed, keep the durable file on failure; reopen recovers its
        // index instead of throwing away a successfully copied conversation.
        commit
    }

    pub fn relocate_imported_project(
        &self,
        session_id: Uuid,
        workspace_path: impl AsRef<Path>,
    ) -> Result<Session> {
        let requested = self
            .get_session(session_id)?
            .ok_or_else(|| anyhow!("session not found"))?;
        anyhow::ensure!(requested.import_source.is_some(), "session is not imported");
        let path = workspace_path
            .as_ref()
            .canonicalize()
            .context("locate project folder")?;
        anyhow::ensure!(path.is_dir(), "project folder must be a directory");
        let mut siblings = self
            .list_sessions()?
            .into_iter()
            .filter(|session| {
                session.import_source.is_some()
                    && session.workspace_path == requested.workspace_path
            })
            .collect::<Vec<_>>();
        let mut pending = Vec::with_capacity(siblings.len());
        for session in &mut siblings {
            session.workspace_path = path.clone();
            session.workspace_identity =
                WorkspaceIdentity::for_session(&session.workspace_path, session.workspace_mode);
            pending.push(self.queue_import_metadata(session.id, "Imported project folder located", serde_json::json!({
                "kind": "project-import-metadata", "importSource": session.import_source,
                "workspacePath": session.workspace_path, "workspaceIdentity": session.workspace_identity,
                "preservedUpdatedAt": session.updated_at,
            }))?);
        }
        // Every choice is durable before publishing the whole project's
        // assignment. Never hold SQLite's writer lock while locking JSONL.
        self.publish_pending_import_metadata(&pending)?;
        for choice in pending {
            self.finish_pending_import_metadata(choice.event.id)?;
        }
        self.get_session(session_id)?
            .ok_or_else(|| anyhow!("session disappeared"))
    }

    pub fn continue_import_in_new_session(&self, session_id: Uuid) -> Result<Session> {
        let mut session = self
            .get_session(session_id)?
            .ok_or_else(|| anyhow!("session not found"))?;
        let source = session
            .import_source
            .as_mut()
            .ok_or_else(|| anyhow!("session is not imported"))?;
        if source.fresh_session_requested {
            return Ok(session);
        }
        source.fresh_session_requested = true;
        let pending = self.queue_import_metadata(
            session_id,
            "Continue imported history in a new provider session",
            serde_json::json!({
                "kind": "project-import-metadata", "importSource": source,
                "preservedUpdatedAt": session.updated_at,
            }),
        )?;
        self.publish_pending_import_metadata(std::slice::from_ref(&pending))?;
        self.finish_pending_import_metadata(pending.event.id)?;
        self.get_session(session_id)?
            .ok_or_else(|| anyhow!("session disappeared"))
    }

    fn import_metadata_path(&self, operation_id: Uuid) -> PathBuf {
        self.paths
            .sessions_dir
            .join(format!("import-choice-{operation_id}.json"))
    }

    fn persist_pending_import_metadata(&self, pending: &PendingImportMetadata) -> Result<()> {
        let encoded = serde_json::to_vec(pending)?;
        anyhow::ensure!(
            encoded.len() <= MAX_SESSION_EVENT_LINE_BYTES,
            "import choice exceeds the size limit"
        );
        let stage_path = self
            .paths
            .sessions_dir
            .join(format!(".import-choice-{}.tmp", Uuid::new_v4()));
        let persist = (|| -> Result<()> {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
            }
            let mut stage = options.open(&stage_path)?;
            stage.write_all(&encoded)?;
            stage.flush()?;
            stage.sync_all()?;
            std::fs::rename(&stage_path, self.import_metadata_path(pending.event.id))?;
            File::open(&self.paths.sessions_dir)?.sync_all()?;
            Ok(())
        })();
        if persist.is_err() {
            let _ = std::fs::remove_file(stage_path);
        }
        persist
    }

    fn queue_import_metadata(
        &self,
        session_id: Uuid,
        message: &str,
        payload: Value,
    ) -> Result<PendingImportMetadata> {
        let event = SessionEvent::new(
            session_id,
            SessionEventKind::SystemEvent,
            normalize_session_event_message(message)?,
            validate_session_event_payload(payload)?,
        );
        let path = self.session_events_path(session_id)?;
        let mut file = open_session_event_log_for_append(&path)?;
        let _lock = lock_session_event_file(&file, SessionEventFileLockKind::Exclusive)?;
        repair_partial_session_event_tail(&mut file, &path)?;
        anyhow::ensure!(
            self.get_session(session_id)?.is_some(),
            "imported chat was deleted"
        );
        let pending = PendingImportMetadata {
            log_offset: file.seek(SeekFrom::End(0))?,
            event,
        };
        // The journal precedes the event so a partial append is recoverable.
        self.persist_pending_import_metadata(&pending)?;
        write_import_event(&mut file, &pending.event)?;
        file.flush()?;
        file.sync_all()?;
        Ok(pending)
    }

    fn publish_pending_import_metadata(&self, pending: &[PendingImportMetadata]) -> Result<()> {
        let transaction = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        for choice in pending {
            // Another store may already have replayed and cleaned this journal.
            // Checking under the writer lock makes cleanup idempotent too.
            if !self.import_metadata_path(choice.event.id).exists() {
                continue;
            }
            let committed: bool = transaction.query_row("select exists(select 1 from project_import_metadata_commits where operation_id = ?1)", params![choice.event.id.to_string()], |row| row.get(0))?;
            if committed {
                continue;
            }
            let Some(session) = self.get_session(choice.event.session_id)? else {
                continue;
            };
            let mut source = session
                .import_source
                .ok_or_else(|| anyhow!("import choice belongs to a non-imported chat"))?;
            let requested: SessionImportSource =
                serde_json::from_value(choice.event.payload["importSource"].clone())?;
            anyhow::ensure!(
                source.source_kind == requested.source_kind
                    && source.source_session_id == requested.source_session_id,
                "import choice provenance changed"
            );
            if let Some(path) = choice
                .event
                .payload
                .get("workspacePath")
                .and_then(Value::as_str)
            {
                anyhow::ensure!(
                    Path::new(path).is_absolute(),
                    "import workspace must be absolute"
                );
                let identity: WorkspaceIdentity =
                    serde_json::from_value(choice.event.payload["workspaceIdentity"].clone())?;
                transaction.execute("update sessions set workspace_path = ?1, workspace_identity_json = ?2 where id = ?3", params![path,serde_json::to_string(&identity)?,session.id.to_string()])?;
            }
            // Locate only changes the folder. An old folder snapshot must never
            // overwrite a concurrent explicit fresh-session choice.
            if requested.fresh_session_requested && !source.fresh_session_requested {
                source.fresh_session_requested = true;
                transaction.execute(
                    "update sessions set import_source_json = ?1 where id = ?2",
                    params![serde_json::to_string(&source)?, session.id.to_string()],
                )?;
                transaction.execute(
                    "delete from provider_session_bindings where session_id = ?1",
                    params![session.id.to_string()],
                )?;
            }
            transaction.execute("insert into project_import_metadata_commits (operation_id,session_id) values (?1,?2)", params![choice.event.id.to_string(),session.id.to_string()])?;
        }
        transaction.commit()?;
        Ok(())
    }

    fn finish_pending_import_metadata(&self, operation_id: Uuid) -> Result<()> {
        match std::fs::remove_file(self.import_metadata_path(operation_id)) {
            Ok(()) => File::open(&self.paths.sessions_dir)?.sync_all()?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        // Remove the idempotency marker only after durable journal removal.
        self.conn.execute(
            "delete from project_import_metadata_commits where operation_id = ?1",
            params![operation_id.to_string()],
        )?;
        Ok(())
    }

    fn recover_pending_import_metadata(&self) -> Result<()> {
        let mut pending = Vec::new();
        for entry in std::fs::read_dir(&self.paths.sessions_dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(operation_id) = name
                .to_str()
                .and_then(|name| name.strip_prefix("import-choice-"))
                .and_then(|name| name.strip_suffix(".json"))
                .and_then(|id| Uuid::parse_str(id).ok())
            else {
                continue;
            };
            anyhow::ensure!(
                pending.len() < 10_000,
                "too many interrupted import choices"
            );
            let file = open_session_event_log_for_read(&entry.path())?;
            anyhow::ensure!(
                file.metadata()?.len() <= MAX_SESSION_EVENT_LINE_BYTES as u64,
                "import choice exceeds the size limit"
            );
            let choice: PendingImportMetadata =
                serde_json::from_reader(file.take(MAX_SESSION_EVENT_LINE_BYTES as u64 + 1))?;
            anyhow::ensure!(
                choice.event.id == operation_id
                    && choice.event.kind == SessionEventKind::SystemEvent
                    && choice.event.payload.get("kind").and_then(Value::as_str)
                        == Some("project-import-metadata"),
                "invalid import choice journal"
            );
            pending.push(choice);
        }
        pending.sort_by_key(|choice| choice.event.created_at);
        for mut choice in pending {
            let Some(session) = self.get_session(choice.event.session_id)? else {
                self.finish_pending_import_metadata(choice.event.id)?;
                continue;
            };
            let source = session
                .import_source
                .as_ref()
                .ok_or_else(|| anyhow!("import choice belongs to a non-imported chat"))?;
            let requested: SessionImportSource =
                serde_json::from_value(choice.event.payload["importSource"].clone())?;
            anyhow::ensure!(
                source.source_kind == requested.source_kind
                    && source.source_session_id == requested.source_session_id,
                "import choice provenance changed"
            );
            let path = self.session_events_path(choice.event.session_id)?;
            {
                let mut file = open_session_event_log_for_append(&path)?;
                let _lock = lock_session_event_file(&file, SessionEventFileLockKind::Exclusive)?;
                repair_partial_session_event_tail(&mut file, &path)?;
                file.seek(SeekFrom::Start(choice.log_offset))?;
                let existing = read_bounded_session_event_line(&mut BufReader::new(&mut file))?
                    .and_then(|line| serde_json::from_str::<SessionEvent>(&line).ok());
                if existing.as_ref().map(|event| event.id) != Some(choice.event.id) {
                    choice.log_offset = file.seek(SeekFrom::End(0))?;
                    self.persist_pending_import_metadata(&choice)?;
                    write_import_event(&mut file, &choice.event)?;
                    file.flush()?;
                    file.sync_all()?;
                }
            }
            self.publish_pending_import_metadata(std::slice::from_ref(&choice))?;
            self.finish_pending_import_metadata(choice.event.id)?;
        }
        // A crash after journal removal can leave one harmless commit marker.
        let mut statement = self
            .conn
            .prepare("select operation_id from project_import_metadata_commits")?;
        let leftovers = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        for id in leftovers {
            if let Ok(id) = Uuid::parse_str(&id) {
                if !self.import_metadata_path(id).exists() {
                    self.finish_pending_import_metadata(id)?;
                }
            }
        }
        Ok(())
    }

    pub(super) fn recover_project_imports(&self) -> Result<()> {
        for entry in std::fs::read_dir(&self.paths.sessions_dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let Some(id) = name
                .strip_prefix("import-")
                .and_then(|name| name.strip_suffix(".jsonl"))
                .and_then(|id| Uuid::parse_str(id).ok())
            else {
                continue;
            };
            if let Some(session) = self.get_session(id)? {
                if let Some(source) = session.import_source.as_ref() {
                    let indexed: bool = self.conn.query_row("select exists(select 1 from project_imports where provider_id = ?1 and source_session_id = ?2)", params![source.source_kind.provider_id(), source.source_session_id], |row| row.get(0))?;
                    if !indexed {
                        self.conn.execute("insert or ignore into project_imports (provider_id,source_session_id,session_id,imported_at) values (?1,?2,?3,?4)", params![source.source_kind.provider_id(),source.source_session_id,id.to_string(),source.imported_at.to_rfc3339()])?;
                    }
                }
                continue;
            }
            if !entry.file_type()?.is_file() {
                continue;
            }
            let recover = (|| -> Result<()> {
                let path = entry.path();
                let mut reader = BufReader::new(open_session_event_log_for_read(&path)?);
                let line = read_bounded_session_event_line(&mut reader)?
                    .ok_or_else(|| anyhow!("empty import snapshot"))?;
                let first: SessionEvent = serde_json::from_str(&line)?;
                anyhow::ensure!(
                    first.payload.get("projectImportVersion") == Some(&Value::from(1)),
                    "unsupported import snapshot"
                );
                let mut session: Session =
                    serde_json::from_value(first.payload["importedSession"].clone())?;
                anyhow::ensure!(
                    session.id == id && session.import_source.is_some(),
                    "invalid import snapshot identity"
                );
                session.events_path = path;
                // Metadata choices are durable events. Recovery must not bring
                // back the old folder or resume a native session the user detached.
                while let Some(line) = read_bounded_session_event_line(&mut reader)? {
                    let Ok(event) = serde_json::from_str::<SessionEvent>(&line) else {
                        continue;
                    };
                    if event.payload.get("kind").and_then(Value::as_str)
                        != Some("project-import-metadata")
                    {
                        session.updated_at = session.updated_at.max(event.created_at);
                        continue;
                    }
                    if let Some(source) = event.payload.get("importSource") {
                        let choice: SessionImportSource = serde_json::from_value(source.clone())?;
                        let original = session.import_source.as_mut().unwrap();
                        anyhow::ensure!(
                            original.source_kind == choice.source_kind
                                && original.source_session_id == choice.source_session_id,
                            "import choice provenance changed"
                        );
                        original.fresh_session_requested |= choice.fresh_session_requested;
                    }
                    if let Some(path) = event.payload.get("workspacePath").and_then(Value::as_str) {
                        session.workspace_path = path.into();
                    }
                    if let Some(identity) = event.payload.get("workspaceIdentity") {
                        session.workspace_identity = serde_json::from_value(identity.clone())?;
                    }
                }
                let source = session.import_source.as_ref().unwrap();
                let transaction = rusqlite::Transaction::new_unchecked(
                    &self.conn,
                    rusqlite::TransactionBehavior::Immediate,
                )?;
                if self
                    .find_project_import_session(source.source_kind, &source.source_session_id)?
                    .is_none()
                {
                    publish_import_index(&transaction, &session)?;
                }
                transaction.commit()?;
                Ok(())
            })();
            if let Err(error) = recover {
                eprintln!("could not recover imported conversation {id}: {error}");
            }
        }
        self.recover_pending_import_metadata()
    }
}

fn write_import_event(file: &mut File, event: &SessionEvent) -> Result<()> {
    let mut bytes = serde_json::to_vec(event)?;
    bytes.push(b'\n');
    anyhow::ensure!(
        bytes.len() <= MAX_SESSION_EVENT_LINE_BYTES,
        "imported event exceeds the session line limit"
    );
    file.write_all(&bytes)?;
    Ok(())
}

fn publish_import_index(conn: &Connection, session: &Session) -> Result<()> {
    let source = session
        .import_source
        .as_ref()
        .ok_or_else(|| anyhow!("import provenance missing"))?;
    conn.execute(
        "insert into sessions (id,title,workspace_path,origin,workspace_mode,branch,worktree_name,provider_id,provider_label,model_id,model_label,reasoning_effort,created_at,updated_at,events_path,workspace_identity_json,parent_session_id,import_source_json)
         values (?1,?2,?3,'desktop','local',?4,null,?5,?6,?7,?8,null,?9,?10,?11,?12,null,?13)",
        params![session.id.to_string(),session.title,session.workspace_path.to_string_lossy(),session.branch,session.provider_id,session.provider_label,session.model_id,session.model_label,session.created_at.to_rfc3339(),session.updated_at.to_rfc3339(),session.events_path.to_string_lossy(),serde_json::to_string(&session.workspace_identity)?,serde_json::to_string(source)?],
    )?;
    conn.execute("insert into project_imports (provider_id,source_session_id,session_id,imported_at) values (?1,?2,?3,?4)",params![source.source_kind.provider_id(),source.source_session_id,session.id.to_string(),source.imported_at.to_rfc3339()])?;
    if !source.fresh_session_requested {
        conn.execute("insert into provider_session_bindings (session_id,provider_id,model_id,model_label,reasoning_effort,resume_cursor_json,status,last_error,updated_at) values (?1,?2,?3,?4,null,?5,'ready',null,?6)",params![session.id.to_string(),source.source_kind.provider_id(),session.model_id,session.model_label,serde_json::to_string(&serde_json::json!({"kind":source.source_kind.cursor_kind(),"sessionId":source.source_session_id}))?,source.imported_at.to_rfc3339()])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_import::ProjectImportCandidate;

    fn import(workspace: &Path, kind: SourceKind) -> NormalizedProjectImport {
        let original = DateTime::parse_from_rfc3339("2025-03-01T10:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut event = SessionEvent::new(
            Uuid::nil(),
            SessionEventKind::UserMessage,
            "A sanitized original message",
            serde_json::json!({}),
        );
        event.created_at = original;
        NormalizedProjectImport {
            candidate: ProjectImportCandidate {
                id: Uuid::new_v4().to_string(),
                source_kind: kind,
                source_session_id: "original-native-conversation".into(),
                data_home: workspace.join("provider-data").to_string_lossy().into(),
                transcript_path: workspace
                    .join("provider-data/transcript.jsonl")
                    .to_string_lossy()
                    .into(),
                workspace_path: workspace.to_string_lossy().into(),
                title: "An imported conversation".into(),
                created_at: original,
                updated_at: original,
                model_id: Some("original-model".into()),
                archived: false,
                workspace_available: true,
                event_count: 1,
                diagnostics: Vec::new(),
                existing_session_id: None,
            },
            events: vec![event],
            diagnostics: Vec::new(),
        }
    }

    #[test]
    fn commits_original_dates_provenance_and_native_binding_without_replaying_actions() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("gyro"))).unwrap();
        for kind in [SourceKind::ClaudeCode, SourceKind::Codex] {
            let original = import(temp.path(), kind);
            let commit = store.import_project_session(original.clone()).unwrap();
            assert!(!commit.existing);
            assert_eq!(commit.session.created_at, original.candidate.created_at);
            assert_eq!(commit.session.updated_at, original.candidate.updated_at);
            assert_eq!(commit.session.origin, SessionOrigin::Desktop);
            let source = commit.session.import_source.as_ref().unwrap();
            assert_eq!(
                source.source_session_id,
                original.candidate.source_session_id
            );
            let binding = store
                .get_provider_session_binding(commit.session.id, kind.provider_id())
                .unwrap()
                .unwrap();
            assert_eq!(binding.status, "ready");
            assert_eq!(
                binding.resume_cursor_json["sessionId"],
                "original-native-conversation"
            );
            assert_eq!(binding.resume_cursor_json["kind"], kind.cursor_kind());
            let events = store.read_events(commit.session.id).unwrap();
            assert_eq!(events.len(), 2);
            assert_eq!(events[1].created_at, original.candidate.created_at);
            assert_eq!(events[1].payload["historical"], true);
            assert!(store.import_project_session(original).unwrap().existing);
        }
        assert_eq!(store.list_sessions().unwrap().len(), 2);
    }

    #[test]
    fn pending_choices_recover_existing_index_without_duplicate_events_even_after_partial_write() {
        for partial in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let paths = GyroPaths::from_base_dir(temp.path().join("gyro"));
            let store = SessionStore::open(paths.clone()).unwrap();
            let session = store
                .import_project_session(import(temp.path(), SourceKind::Codex))
                .unwrap()
                .session;
            let destination = temp.path().join("recovered-location");
            std::fs::create_dir(&destination).unwrap();
            let mut source = session.import_source.clone().unwrap();
            source.fresh_session_requested = true;
            let pending = store.queue_import_metadata(session.id, "Recover explicit choice", serde_json::json!({
                "kind":"project-import-metadata", "importSource":source,
                "workspacePath":destination, "workspaceIdentity":WorkspaceIdentity::for_session(&destination, session.workspace_mode),
                "preservedUpdatedAt":session.updated_at,
            })).unwrap();
            if partial {
                // Crash in the append: keep one incomplete byte past the old tail.
                OpenOptions::new()
                    .write(true)
                    .open(&session.events_path)
                    .unwrap()
                    .set_len(pending.log_offset + 1)
                    .unwrap();
            }
            assert!(
                !store
                    .get_session(session.id)
                    .unwrap()
                    .unwrap()
                    .import_source
                    .unwrap()
                    .fresh_session_requested
            );
            drop(store);
            let recovered = SessionStore::open(paths).unwrap();
            let changed = recovered.get_session(session.id).unwrap().unwrap();
            assert_eq!(changed.workspace_path, destination);
            assert_eq!(changed.updated_at, session.updated_at);
            assert!(changed.import_source.unwrap().fresh_session_requested);
            assert!(recovered
                .get_provider_session_binding(session.id, "openai")
                .unwrap()
                .is_none());
            assert_eq!(
                recovered
                    .read_events(session.id)
                    .unwrap()
                    .iter()
                    .filter(|event| event.id == pending.event.id)
                    .count(),
                1
            );
            assert!(!recovered.import_metadata_path(pending.event.id).exists());
        }
    }

    #[test]
    fn committed_pending_choice_never_detaches_a_later_fresh_provider_session() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("gyro"));
        let store = SessionStore::open(paths.clone()).unwrap();
        let session = store
            .import_project_session(import(temp.path(), SourceKind::Codex))
            .unwrap()
            .session;
        let mut source = session.import_source.clone().unwrap();
        source.fresh_session_requested = true;
        let pending = store.queue_import_metadata(session.id,"Choose fresh",serde_json::json!({"kind":"project-import-metadata","importSource":source,"preservedUpdatedAt":session.updated_at})).unwrap();
        store
            .publish_pending_import_metadata(std::slice::from_ref(&pending))
            .unwrap();
        // SQL committed, but the process closed before deleting its journal.
        store
            .upsert_provider_session_binding(
                session.id,
                "openai",
                None,
                None,
                None,
                serde_json::json!({"kind":"codex-session","sessionId":"later-fresh-session"}),
                "ready",
                None,
            )
            .unwrap();
        drop(store);
        let recovered = SessionStore::open(paths).unwrap();
        assert_eq!(
            recovered
                .get_provider_session_binding(session.id, "openai")
                .unwrap()
                .unwrap()
                .resume_cursor_json["sessionId"],
            "later-fresh-session"
        );
        assert_eq!(
            recovered
                .read_events(session.id)
                .unwrap()
                .iter()
                .filter(|event| event.id == pending.event.id)
                .count(),
            1
        );
        assert_eq!(
            recovered
                .conn
                .query_row(
                    "select count(*) from project_import_metadata_commits",
                    [],
                    |row| row.get::<_, usize>(0)
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn pending_locate_never_overwrites_an_explicit_fresh_choice() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("gyro"));
        let store = SessionStore::open(paths.clone()).unwrap();
        let session = store
            .import_project_session(import(temp.path(), SourceKind::ClaudeCode))
            .unwrap()
            .session;
        let destination = temp.path().join("moved-project");
        std::fs::create_dir(&destination).unwrap();
        store.continue_import_in_new_session(session.id).unwrap();
        let live = store
            .append_event(
                session.id,
                SessionEventKind::AssistantMessage,
                "New live conversation activity",
                serde_json::json!({}),
            )
            .unwrap();
        let pending = store.queue_import_metadata(session.id,"Locate",serde_json::json!({"kind":"project-import-metadata","importSource":session.import_source,"workspacePath":destination,"workspaceIdentity":WorkspaceIdentity::for_session(&destination,session.workspace_mode),"preservedUpdatedAt":session.updated_at})).unwrap();
        drop(store);
        let recovered = SessionStore::open(paths.clone()).unwrap();
        let changed = recovered.get_session(session.id).unwrap().unwrap();
        assert_eq!(changed.workspace_path, destination);
        assert!(changed.import_source.unwrap().fresh_session_requested);
        assert!(!recovered.import_metadata_path(pending.event.id).exists());
        assert_eq!(changed.updated_at, live.created_at);
        // A stale Locate event follows the fresh choice in durable history.
        // Rebuilding the entire index must preserve both detachment and live dates.
        recovered.conn.execute("delete from sessions", []).unwrap();
        recovered
            .conn
            .execute("delete from project_imports", [])
            .unwrap();
        recovered
            .conn
            .execute("delete from provider_session_bindings", [])
            .unwrap();
        drop(recovered);
        let rebuilt = SessionStore::open(paths).unwrap();
        let changed = rebuilt.get_session(session.id).unwrap().unwrap();
        assert_eq!(changed.workspace_path, destination);
        assert!(changed.import_source.unwrap().fresh_session_requested);
        assert_eq!(changed.updated_at, live.created_at);
        assert!(rebuilt
            .get_provider_session_binding(session.id, "anthropic")
            .unwrap()
            .is_none());
    }

    #[test]
    fn failed_choice_projection_is_recovered_with_the_existing_session_row() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("gyro"));
        let store = SessionStore::open(paths.clone()).unwrap();
        let session = store
            .import_project_session(import(temp.path(), SourceKind::Codex))
            .unwrap()
            .session;
        let destination = temp.path().join("located-after-disk-failure");
        std::fs::create_dir(&destination).unwrap();
        store.conn.execute_batch("create trigger fail_import_choice before update of workspace_path on sessions begin select raise(fail,'simulated choice publication failure'); end;").unwrap();
        assert!(store
            .relocate_imported_project(session.id, &destination)
            .is_err());
        assert_eq!(
            store
                .get_session(session.id)
                .unwrap()
                .unwrap()
                .workspace_path,
            session.workspace_path
        );
        store
            .conn
            .execute_batch("drop trigger fail_import_choice")
            .unwrap();
        drop(store);
        let recovered = SessionStore::open(paths).unwrap();
        let changed = recovered.get_session(session.id).unwrap().unwrap();
        assert_eq!(changed.workspace_path, destination.canonicalize().unwrap());
        assert_eq!(changed.updated_at, session.updated_at);
        assert_eq!(
            recovered
                .read_events(session.id)
                .unwrap()
                .iter()
                .filter(|event| event.payload.get("kind").and_then(Value::as_str)
                    == Some("project-import-metadata"))
                .count(),
            1
        );
    }

    #[test]
    fn existing_native_provider_binding_prevents_duplicate_import() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("gyro"))).unwrap();
        let existing = store
            .create_session(temp.path(), SessionOrigin::Desktop, "Existing conversation")
            .unwrap();
        store.upsert_provider_session_binding(existing.id, "openai", None, None, None, serde_json::json!({"kind":"codex-session","sessionId":"original-native-conversation"}), "ready", None).unwrap();
        let commit = store
            .import_project_session(import(temp.path(), SourceKind::Codex))
            .unwrap();
        assert!(commit.existing);
        assert_eq!(commit.session.id, existing.id);
        assert_eq!(store.list_sessions().unwrap().len(), 1);
    }

    #[test]
    fn rejects_action_events_without_publishing_partial_history() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("gyro"))).unwrap();
        let mut original = import(temp.path(), SourceKind::Codex);
        original.events[0].kind = SessionEventKind::CommandRequested;
        assert!(store.import_project_session(original).is_err());
        assert!(store.list_sessions().unwrap().is_empty());
        assert_eq!(
            std::fs::read_dir(&store.paths.sessions_dir)
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn recovers_committed_jsonl_and_later_folder_and_fresh_session_choices() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("gyro"));
        let relocated = temp.path().join("new-project-location");
        std::fs::create_dir(&relocated).unwrap();
        let id;
        {
            let store = SessionStore::open(paths.clone()).unwrap();
            id = store
                .import_project_session(import(temp.path(), SourceKind::ClaudeCode))
                .unwrap()
                .session
                .id;
            store.relocate_imported_project(id, &relocated).unwrap();
            store.continue_import_in_new_session(id).unwrap();
            // Simulate loss of SQLite publication. JSONL remains the durable
            // source of both history and the user's explicit recovery choices.
            store.conn.execute("delete from sessions", []).unwrap();
            store
                .conn
                .execute("delete from project_imports", [])
                .unwrap();
            store
                .conn
                .execute("delete from provider_session_bindings", [])
                .unwrap();
        }
        let recovered = SessionStore::open(paths.clone()).unwrap();
        let session = recovered.get_session(id).unwrap().unwrap();
        assert_eq!(session.workspace_path, relocated.canonicalize().unwrap());
        assert!(session.import_source.unwrap().fresh_session_requested);
        assert!(recovered
            .get_provider_session_binding(id, "anthropic")
            .unwrap()
            .is_none());
        assert_eq!(recovered.read_events(id).unwrap().len(), 4);
        assert!(
            recovered
                .import_project_session(import(temp.path(), SourceKind::ClaudeCode))
                .unwrap()
                .existing
        );
    }

    #[test]
    fn locating_an_imported_project_moves_all_its_imported_chats_and_preserves_dates() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("gyro"));
        let store = SessionStore::open(paths.clone()).unwrap();
        let first = store
            .import_project_session(import(temp.path(), SourceKind::Codex))
            .unwrap()
            .session;
        let second = store
            .import_project_session(import(temp.path(), SourceKind::ClaudeCode))
            .unwrap()
            .session;
        let unrelated = store
            .create_session(temp.path(), SessionOrigin::Desktop, "Existing Gyro chat")
            .unwrap();
        let destination = temp.path().join("located-project");
        std::fs::create_dir(&destination).unwrap();
        let located = store
            .relocate_imported_project(first.id, &destination)
            .unwrap();
        for original in [&first, &second] {
            let changed = store.get_session(original.id).unwrap().unwrap();
            assert_eq!(changed.workspace_path, destination.canonicalize().unwrap());
            assert_eq!(changed.created_at, original.created_at);
            assert_eq!(changed.updated_at, original.updated_at);
            assert_eq!(
                store
                    .read_events(original.id)
                    .unwrap()
                    .last()
                    .unwrap()
                    .payload["kind"],
                "project-import-metadata"
            );
        }
        assert_eq!(located.id, first.id);
        assert_eq!(
            store
                .get_session(unrelated.id)
                .unwrap()
                .unwrap()
                .workspace_path,
            unrelated.workspace_path
        );
        store
            .conn
            .execute("delete from project_imports", [])
            .unwrap();
        store
            .conn
            .execute(
                "delete from provider_session_bindings where session_id != ?1",
                params![unrelated.id.to_string()],
            )
            .unwrap();
        store
            .conn
            .execute(
                "delete from sessions where id != ?1",
                params![unrelated.id.to_string()],
            )
            .unwrap();
        drop(store);
        let recovered = SessionStore::open(paths).unwrap();
        assert_eq!(
            recovered
                .get_session(second.id)
                .unwrap()
                .unwrap()
                .updated_at,
            second.updated_at
        );
        assert_eq!(
            recovered
                .get_session(second.id)
                .unwrap()
                .unwrap()
                .workspace_path,
            destination.canonicalize().unwrap()
        );
    }

    #[test]
    fn imported_original_binding_survives_model_switch_until_explicit_fresh_choice() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("gyro"))).unwrap();
        let session = store
            .import_project_session(import(temp.path(), SourceKind::Codex))
            .unwrap()
            .session;
        for model in ["different-model", "original-model"] {
            store
                .update_session_model(
                    session.id,
                    Some("openai".into()),
                    Some("OpenAI".into()),
                    Some(model.into()),
                    Some(model.into()),
                    None,
                )
                .unwrap();
            let binding = store
                .get_provider_session_binding(session.id, "openai")
                .unwrap()
                .unwrap();
            assert_eq!(binding.model_id.as_deref(), Some("original-model"));
            assert_eq!(
                binding.resume_cursor_json["sessionId"],
                "original-native-conversation"
            );
        }
        store.continue_import_in_new_session(session.id).unwrap();
        store
            .upsert_provider_session_binding(
                session.id,
                "openai",
                Some("original-model".into()),
                None,
                None,
                serde_json::json!({"kind":"codex-session","sessionId":"new-native-session"}),
                "ready",
                None,
            )
            .unwrap();
        store
            .update_session_model(
                session.id,
                Some("openai".into()),
                Some("OpenAI".into()),
                Some("different-model".into()),
                None,
                None,
            )
            .unwrap();
        assert!(store
            .get_provider_session_binding(session.id, "openai")
            .unwrap()
            .is_none());
    }

    #[test]
    fn detached_import_deduplicates_and_recovers_its_lost_mapping() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("gyro"));
        let id;
        {
            let store = SessionStore::open(paths.clone()).unwrap();
            id = store
                .import_project_session(import(temp.path(), SourceKind::Codex))
                .unwrap()
                .session
                .id;
            store.continue_import_in_new_session(id).unwrap();
            store
                .conn
                .execute("delete from project_imports", [])
                .unwrap();
            assert_eq!(
                store
                    .find_project_import_session(SourceKind::Codex, "original-native-conversation")
                    .unwrap()
                    .unwrap()
                    .id,
                id
            );
            assert!(
                store
                    .import_project_session(import(temp.path(), SourceKind::Codex))
                    .unwrap()
                    .existing
            );
        }
        let reopened = SessionStore::open(paths).unwrap();
        let mapped: String = reopened
            .conn
            .query_row("select session_id from project_imports", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(mapped, id.to_string());
        assert!(reopened
            .get_provider_session_binding(id, "openai")
            .unwrap()
            .is_none());
    }

    #[test]
    fn recovers_durable_snapshot_when_index_publication_fails() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("gyro"));
        {
            let store = SessionStore::open(paths.clone()).unwrap();
            store.conn.execute_batch("create trigger fail_import_publication before insert on project_imports begin select raise(abort, 'simulated publication failure'); end;").unwrap();
            assert!(store
                .import_project_session(import(temp.path(), SourceKind::Codex))
                .is_err());
            assert!(store.list_sessions().unwrap().is_empty());
            assert_eq!(std::fs::read_dir(&paths.sessions_dir).unwrap().count(), 1);
            store
                .conn
                .execute_batch("drop trigger fail_import_publication;")
                .unwrap();
        }
        let recovered = SessionStore::open(paths).unwrap();
        let sessions = recovered.list_sessions().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(recovered.read_events(sessions[0].id).unwrap().len(), 2);
        assert!(recovered
            .get_provider_session_binding(sessions[0].id, "openai")
            .unwrap()
            .is_some());
    }

    #[test]
    fn disk_write_failure_never_publishes_a_chat() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("gyro"));
        let store = SessionStore::open(paths.clone()).unwrap();
        std::fs::remove_dir(&paths.sessions_dir).unwrap();
        assert!(store
            .import_project_session(import(temp.path(), SourceKind::Codex))
            .is_err());
        assert!(store.list_sessions().unwrap().is_empty());
    }

    #[test]
    fn deletion_does_not_restore_imported_chat_on_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("gyro"));
        let id;
        {
            let store = SessionStore::open(paths.clone()).unwrap();
            id = store
                .import_project_session(import(temp.path(), SourceKind::Codex))
                .unwrap()
                .session
                .id;
            store.delete_session(id).unwrap();
        }
        let reopened = SessionStore::open(paths).unwrap();
        assert!(reopened.get_session(id).unwrap().is_none());
        assert!(reopened
            .find_project_import_session(SourceKind::Codex, "original-native-conversation")
            .unwrap()
            .is_none());
    }
}
