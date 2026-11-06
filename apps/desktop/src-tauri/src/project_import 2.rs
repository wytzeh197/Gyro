//! Desktop IPC for bounded, explicitly selected local transcript imports.
use gyro_core::project_import::{
    discover_project_imports, get_project_import_sources as resolve_sources,
    normalize_project_import, ProjectImportCandidate, ProjectImportScan, ProjectImportScanRequest,
    ProjectImportSource,
};
use gyro_core::{GyroPaths, Session, SessionStore};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use uuid::Uuid;

const MAX_STORED_JOBS: usize = 20;
const MAX_CACHED_SCANS: usize = 5;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectImportResult {
    pub candidate_id: String,
    pub title: String,
    pub workspace_path: String,
    pub session_id: Option<String>,
    pub status: String,
    pub detail: Option<String>,
    pub diagnostics: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectImportJob {
    pub id: String,
    pub status: String,
    pub total: usize,
    pub completed: usize,
    pub results: Vec<ProjectImportResult>,
    pub error: Option<String>,
}

#[derive(Default)]
struct ImportManagerState {
    initialized: bool,
    scans: BTreeMap<String, Vec<ProjectImportCandidate>>,
    jobs: Vec<ProjectImportJob>,
    cancelled: BTreeSet<String>,
}

#[derive(Clone, Default)]
pub struct ProjectImportManager {
    state: Arc<Mutex<ImportManagerState>>,
}

impl ProjectImportManager {
    fn initialize(&self) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Import manager is unavailable")?;
        if state.initialized {
            return Ok(());
        }
        let paths = GyroPaths::for_current_user().map_err(error_string)?;
        paths.ensure().map_err(error_string)?;
        let path = paths.base_dir.join("project-import-jobs.json");
        reject_unsafe_private_file(&path).map_err(error_string)?;
        if path.is_file() {
            match read_saved_jobs(&path) {
                Ok(jobs) => state.jobs = recover_saved_jobs(jobs),
                Err(error) => {
                    let preserved = paths.base_dir.join(format!(
                        "project-import-jobs-unreadable-{}.json",
                        Uuid::new_v4()
                    ));
                    std::fs::rename(&path, preserved).map_err(error_string)?;
                    state.jobs = vec![ProjectImportJob { id: Uuid::new_v4().to_string(), status: "failed".into(), total: 0, completed: 0, results: Vec::new(), error: Some(format!("Saved import progress could not be read: {error}. Imported chats are preserved. Scan projects again to continue.")) }];
                }
            }
        }
        persist_jobs(&state.jobs)?;
        state.initialized = true;
        Ok(())
    }

    fn update_job(&self, job: ProjectImportJob) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Import manager is unavailable")?;
        if let Some(existing) = state.jobs.iter_mut().find(|existing| existing.id == job.id) {
            *existing = job;
        } else {
            state.jobs.push(job);
        }
        if state.jobs.len() > MAX_STORED_JOBS {
            let excess = state.jobs.len() - MAX_STORED_JOBS;
            state.jobs.drain(..excess);
        }
        persist_jobs(&state.jobs)
    }

    fn is_cancelled(&self, id: &str) -> bool {
        self.state
            .lock()
            .map_or(true, |state| state.cancelled.contains(id))
    }
}

fn read_saved_jobs(path: &std::path::Path) -> Result<Vec<ProjectImportJob>, String> {
    reject_unsafe_private_file(path)?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(error_string)?;
    if file.metadata().map_err(error_string)?.len() > 64 * 1024 * 1024 {
        return Err("Saved import progress exceeds the size limit".into());
    }
    serde_json::from_reader(file).map_err(error_string)
}

fn recover_saved_jobs(mut jobs: Vec<ProjectImportJob>) -> Vec<ProjectImportJob> {
    if jobs.len() > MAX_STORED_JOBS {
        let excess = jobs.len() - MAX_STORED_JOBS;
        jobs.drain(..excess);
    }
    for job in &mut jobs {
        if job.status == "running" {
            job.status = "interrupted".into();
            job.error = Some("Import stopped when Gyro closed. Scan again to import remaining chats; completed chats are preserved.".into());
        }
    }
    jobs
}

fn publish_started_job(
    jobs: &mut Vec<ProjectImportJob>,
    job: ProjectImportJob,
    persist: impl FnOnce(&[ProjectImportJob]) -> Result<(), String>,
) -> Result<(), String> {
    let mut next = jobs.clone();
    next.push(job);
    if next.len() > MAX_STORED_JOBS {
        let excess = next.len() - MAX_STORED_JOBS;
        next.drain(..excess);
    }
    persist(&next)?;
    *jobs = next;
    Ok(())
}

fn persist_jobs(jobs: &[ProjectImportJob]) -> Result<(), String> {
    let paths = GyroPaths::for_current_user().map_err(error_string)?;
    paths.ensure().map_err(error_string)?;
    let path = paths.base_dir.join("project-import-jobs.json");
    reject_unsafe_private_file(&path).map_err(error_string)?;
    let mut stage = tempfile::NamedTempFile::new_in(&paths.base_dir).map_err(error_string)?;
    serde_json::to_writer(stage.as_file_mut(), jobs).map_err(error_string)?;
    stage.flush().map_err(error_string)?;
    stage.as_file().sync_all().map_err(error_string)?;
    stage.persist(&path).map_err(error_string)?;
    std::fs::File::open(&paths.base_dir)
        .and_then(|directory| directory.sync_all())
        .map_err(error_string)?;
    Ok(())
}

fn reject_unsafe_private_file(path: &std::path::Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err("Saved import progress must be a regular file".into())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error_string(error)),
    }
}

fn error_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[tauri::command]
pub async fn get_project_import_sources(
    request: ProjectImportScanRequest,
) -> Result<Vec<ProjectImportSource>, String> {
    tauri::async_runtime::spawn_blocking(move || resolve_sources(&request).map_err(error_string))
        .await
        .map_err(error_string)?
}

#[tauri::command]
pub async fn scan_project_imports(
    request: ProjectImportScanRequest,
    manager: tauri::State<'_, ProjectImportManager>,
) -> Result<ProjectImportScan, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.initialize()?;
        let mut scan = discover_project_imports(request).map_err(error_string)?;
        let store = SessionStore::open(GyroPaths::for_current_user().map_err(error_string)?)
            .map_err(error_string)?;
        for candidate in &mut scan.candidates {
            enrich_existing_candidate(&store, candidate)?;
        }
        let mut state = manager
            .state
            .lock()
            .map_err(|_| "Import manager is unavailable")?;
        if state.scans.len() >= MAX_CACHED_SCANS {
            if let Some(key) = state.scans.keys().next().cloned() {
                state.scans.remove(&key);
            }
        }
        state
            .scans
            .insert(scan.scan_id.clone(), scan.candidates.clone());
        Ok(scan)
    })
    .await
    .map_err(error_string)?
}

fn enrich_existing_candidate(
    store: &SessionStore,
    candidate: &mut ProjectImportCandidate,
) -> Result<(), String> {
    if let Some(session) = store
        .find_project_import_session(candidate.source_kind, &candidate.source_session_id)
        .map_err(error_string)?
    {
        candidate.existing_session_id = Some(session.id.to_string());
        candidate.title = session.title;
        candidate.workspace_path = session.workspace_path.to_string_lossy().into_owned();
        candidate.workspace_available = session.workspace_path.is_dir();
    }
    Ok(())
}

#[tauri::command]
pub async fn start_project_import(
    scan_id: String,
    candidate_ids: Vec<String>,
    app: tauri::AppHandle,
    manager: tauri::State<'_, ProjectImportManager>,
) -> Result<ProjectImportJob, String> {
    let manager = manager.inner().clone();
    let worker_manager = manager.clone();
    let (job, candidates) = tauri::async_runtime::spawn_blocking(
        move || -> Result<(ProjectImportJob, Vec<ProjectImportCandidate>), String> {
            manager.initialize()?;
            let selected = candidate_ids.into_iter().collect::<BTreeSet<_>>();
            if selected.is_empty() {
                return Err("Select at least one chat to import".into());
            }
            let mut state = manager
                .state
                .lock()
                .map_err(|_| "Import manager is unavailable")?;
            if state.jobs.iter().any(|job| job.status == "running") {
                return Err("An import is already running".into());
            }
            let scan = state
                .scans
                .get(&scan_id)
                .ok_or_else(|| "This scan has expired. Scan projects again.".to_string())?;
            let candidates = scan
                .iter()
                .filter(|candidate| selected.contains(&candidate.id))
                .cloned()
                .collect::<Vec<_>>();
            if candidates.len() != selected.len() {
                return Err(
                    "Some selected chats are not in this scan. Scan projects again.".into(),
                );
            }
            let job = ProjectImportJob {
                id: Uuid::new_v4().to_string(),
                status: "running".into(),
                total: candidates.len(),
                completed: 0,
                results: Vec::new(),
                error: None,
            };
            // Do not publish a running job until its initial report is durable;
            // a failed save must leave the manager ready for a retry.
            publish_started_job(&mut state.jobs, job.clone(), persist_jobs)?;
            Ok((job, candidates))
        },
    )
    .await
    .map_err(error_string)??;
    let initial = job.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_import_job(job, candidates, worker_manager, app)
    });
    Ok(initial)
}

fn run_import_job(
    mut job: ProjectImportJob,
    candidates: Vec<ProjectImportCandidate>,
    manager: ProjectImportManager,
    app: tauri::AppHandle,
) {
    let store = GyroPaths::for_current_user().and_then(SessionStore::open);
    let store = match store {
        Ok(store) => store,
        Err(error) => {
            job.status = "failed".into();
            job.error = Some(error_string(error));
            let _ = manager.update_job(job.clone());
            let _ = app.emit("project-import-progress", &job);
            return;
        }
    };
    let job_id = job.id.clone();
    process_import_candidates(
        &mut job,
        candidates,
        &store,
        || manager.is_cancelled(&job_id),
        |progress| {
            manager.update_job(progress.clone())?;
            let _ = app.emit("project-import-progress", progress);
            Ok(())
        },
    );
    let _ = manager.update_job(job.clone());
    if let Ok(mut state) = manager.state.lock() {
        state.cancelled.remove(&job.id);
    }
    let _ = app.emit("project-import-progress", &job);
}

fn process_import_candidates(
    job: &mut ProjectImportJob,
    candidates: Vec<ProjectImportCandidate>,
    store: &SessionStore,
    mut is_cancelled: impl FnMut() -> bool,
    mut publish: impl FnMut(&ProjectImportJob) -> Result<(), String>,
) {
    for candidate in candidates {
        if is_cancelled() {
            job.status = "cancelled".into();
            break;
        }
        let outcome = (|| {
            // Dedup before parsing history, including transcripts that have
            // since become unsupported or unavailable.
            if let Some(session) = store
                .find_project_import_session(candidate.source_kind, &candidate.source_session_id)?
            {
                return Ok((
                    gyro_core::sessions::ProjectImportCommit {
                        session,
                        existing: true,
                    },
                    Vec::new(),
                ));
            }
            let normalized = normalize_project_import(&candidate)?;
            let diagnostics = normalized.diagnostics.clone();
            store
                .import_project_session(normalized)
                .map(|commit| (commit, diagnostics))
        })();
        let mut result = ProjectImportResult {
            candidate_id: candidate.id,
            title: candidate.title,
            workspace_path: candidate.workspace_path,
            session_id: None,
            status: "failed".into(),
            detail: None,
            diagnostics: candidate.diagnostics,
        };
        match outcome {
            Ok((commit, diagnostics)) => {
                result.title = commit.session.title.clone();
                result.workspace_path =
                    commit.session.workspace_path.to_string_lossy().into_owned();
                result.diagnostics.extend(diagnostics);
                result.diagnostics.sort();
                result.diagnostics.dedup();
                result.session_id = Some(commit.session.id.to_string());
                result.status = if commit.existing {
                    "existing"
                } else {
                    "imported"
                }
                .into();
            }
            Err(error) => {
                result.detail = Some(error_string(error));
            }
        }
        job.completed += 1;
        job.results.push(result);
        if let Err(error) = publish(job) {
            job.status = "failed".into();
            job.error = Some(format!(
                "Imported chats are preserved, but progress could not be saved: {error}"
            ));
            break;
        }
    }
    if job.status == "running" {
        job.status = if is_cancelled() {
            "cancelled"
        } else {
            "completed"
        }
        .into();
    }
}

#[tauri::command]
pub async fn get_project_import_job(
    job_id: Option<String>,
    manager: tauri::State<'_, ProjectImportManager>,
) -> Result<Option<ProjectImportJob>, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.initialize()?;
        let state = manager
            .state
            .lock()
            .map_err(|_| "Import manager is unavailable")?;
        Ok(match job_id {
            Some(id) => state.jobs.iter().find(|job| job.id == id).cloned(),
            None => state.jobs.last().cloned(),
        })
    })
    .await
    .map_err(error_string)?
}

#[tauri::command]
pub async fn cancel_project_import(
    job_id: String,
    manager: tauri::State<'_, ProjectImportManager>,
) -> Result<(), String> {
    let mut state = manager
        .state
        .lock()
        .map_err(|_| "Import manager is unavailable")?;
    if !state
        .jobs
        .iter()
        .any(|job| job.id == job_id && job.status == "running")
    {
        return Err("No running import was found".into());
    }
    state.cancelled.insert(job_id);
    Ok(())
}

#[tauri::command]
pub async fn relocate_imported_project(
    session_id: String,
    workspace_path: String,
) -> Result<Session, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let id = Uuid::parse_str(&session_id).map_err(error_string)?;
        let store = SessionStore::open(GyroPaths::for_current_user().map_err(error_string)?)
            .map_err(error_string)?;
        store
            .relocate_imported_project(id, workspace_path)
            .map_err(error_string)
    })
    .await
    .map_err(error_string)?
}

#[tauri::command]
pub async fn continue_import_in_new_session(session_id: String) -> Result<Session, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let id = Uuid::parse_str(&session_id).map_err(error_string)?;
        let store = SessionStore::open(GyroPaths::for_current_user().map_err(error_string)?)
            .map_err(error_string)?;
        store
            .continue_import_in_new_session(id)
            .map_err(error_string)
    })
    .await
    .map_err(error_string)?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(id: &str, status: &str) -> ProjectImportJob {
        ProjectImportJob {
            id: id.into(),
            status: status.into(),
            total: 2,
            completed: 1,
            results: vec![ProjectImportResult {
                candidate_id: "candidate".into(),
                title: "Sanitized history".into(),
                workspace_path: "/sanitized/project".into(),
                session_id: Some("persisted-session".into()),
                status: "imported".into(),
                detail: None,
                diagnostics: vec![],
            }],
            error: None,
        }
    }

    #[test]
    fn project_import_restart_marks_unfinished_job_interrupted_and_keeps_completed_chats() {
        let jobs = recover_saved_jobs(vec![
            job("finished", "completed"),
            job("unfinished", "running"),
        ]);
        assert_eq!(jobs[0].status, "completed");
        assert_eq!(jobs[1].status, "interrupted");
        assert_eq!(jobs[1].completed, 1);
        assert_eq!(
            jobs[1].results[0].session_id.as_deref(),
            Some("persisted-session")
        );
        assert!(jobs[1]
            .error
            .as_deref()
            .unwrap()
            .contains("completed chats are preserved"));
    }

    #[test]
    fn project_import_rescan_uses_the_existing_gyro_folder_and_title_after_relocation() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("codex");
        let sessions = home.join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(
            sessions.join("source.jsonl"),
            include_str!(
                "../../../../crates/gyro-core/src/project_import/fixtures/codex-modern.jsonl"
            ),
        )
        .unwrap();
        let request = ProjectImportScanRequest {
            codex_data_home: Some(home.to_string_lossy().into()),
            claude_data_home: Some(temp.path().join("empty-claude").to_string_lossy().into()),
            include_archived: false,
        };
        let original = discover_project_imports(request.clone())
            .unwrap()
            .candidates
            .remove(0);
        let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("gyro"))).unwrap();
        let session = store
            .import_project_session(normalize_project_import(&original).unwrap())
            .unwrap()
            .session;
        let destination = temp.path().join("located-project");
        std::fs::create_dir(&destination).unwrap();
        store
            .relocate_imported_project(session.id, &destination)
            .unwrap();
        store
            .rename_session(session.id, "My current Gyro title")
            .unwrap();
        let mut rescan = discover_project_imports(request)
            .unwrap()
            .candidates
            .remove(0);
        assert_eq!(rescan.workspace_path, original.workspace_path);
        enrich_existing_candidate(&store, &mut rescan).unwrap();
        assert_eq!(
            rescan.existing_session_id.as_deref(),
            Some(session.id.to_string().as_str())
        );
        assert_eq!(rescan.title, "My current Gyro title");
        assert_eq!(
            rescan.workspace_path,
            destination.canonicalize().unwrap().to_string_lossy()
        );
        assert!(rescan.workspace_available);
    }

    #[test]
    fn project_import_worker_cancellation_keeps_committed_chat_and_skips_remaining_candidate() {
        use std::cell::Cell;
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("codex");
        let sessions = home.join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let original = include_str!(
            "../../../../crates/gyro-core/src/project_import/fixtures/codex-modern.jsonl"
        );
        std::fs::write(sessions.join("source.jsonl"), original).unwrap();
        let scan = discover_project_imports(ProjectImportScanRequest {
            codex_data_home: Some(home.to_string_lossy().into()),
            claude_data_home: Some(temp.path().join("empty-claude").to_string_lossy().into()),
            include_archived: false,
        })
        .unwrap();
        let first = scan.candidates[0].clone();
        let mut remaining = first.clone();
        remaining.id = "remaining-candidate".into();
        remaining.source_session_id = "never-import-this".into();
        remaining.transcript_path = temp.path().join("missing.jsonl").to_string_lossy().into();
        let paths = GyroPaths::from_base_dir(temp.path().join("gyro"));
        let store = SessionStore::open(paths.clone()).unwrap();
        let mut job = ProjectImportJob {
            id: "cancel-test".into(),
            status: "running".into(),
            total: 2,
            completed: 0,
            results: Vec::new(),
            error: None,
        };
        let cancelled = Cell::new(false);
        process_import_candidates(
            &mut job,
            vec![first, remaining],
            &store,
            || cancelled.get(),
            |_| {
                cancelled.set(true);
                Ok(())
            },
        );
        assert_eq!(job.status, "cancelled");
        assert_eq!(job.completed, 1);
        assert_eq!(job.results.len(), 1);
        assert_eq!(job.results[0].status, "imported");
        let committed = Uuid::parse_str(job.results[0].session_id.as_ref().unwrap()).unwrap();
        drop(store);
        let reopened = SessionStore::open(paths).unwrap();
        assert_eq!(reopened.list_sessions().unwrap().len(), 1);
        assert!(reopened.get_session(committed).unwrap().is_some());
        assert!(reopened.read_events(committed).unwrap().len() > 1);
        assert_eq!(
            std::fs::read_to_string(sessions.join("source.jsonl")).unwrap(),
            original
        );
    }

    #[test]
    fn project_import_initial_disk_failure_does_not_leave_a_running_job() {
        let mut jobs = vec![job("previous", "completed")];
        assert!(publish_started_job(
            &mut jobs,
            job("new", "running"),
            |_| Err("disk full".into())
        )
        .is_err());
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].id, "previous");
        assert!(!jobs.iter().any(|job| job.status == "running"));
        publish_started_job(&mut jobs, job("retry", "running"), |_| Ok(())).unwrap();
        assert_eq!(jobs.last().unwrap().id, "retry");
    }

    #[test]
    fn project_import_saved_reports_keep_the_latest_jobs() {
        let jobs = (0..25)
            .map(|index| job(&index.to_string(), "completed"))
            .collect();
        let jobs = recover_saved_jobs(jobs);
        assert_eq!(jobs.len(), MAX_STORED_JOBS);
        assert_eq!(jobs[0].id, "5");
        assert_eq!(jobs.last().unwrap().id, "24");
    }

    #[test]
    fn project_import_reads_saved_progress_and_rejects_corrupt_reports() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("jobs.json");
        std::fs::write(
            &path,
            serde_json::to_vec(&vec![job("unfinished", "running")]).unwrap(),
        )
        .unwrap();
        assert_eq!(read_saved_jobs(&path).unwrap()[0].id, "unfinished");
        std::fs::write(&path, b"{incomplete").unwrap();
        assert!(read_saved_jobs(&path).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn project_import_never_reads_progress_through_a_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target.json");
        let link = temp.path().join("linked.json");
        std::fs::write(&target, b"[]").unwrap();
        std::os::unix::fs::symlink(target, &link).unwrap();
        assert!(read_saved_jobs(&link).is_err());
    }
}
