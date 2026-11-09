//! Human-reviewed local checks. No provider/tool route can approve a plan.
use crate::{
    diagnostics::export::user_home_directory,
    session_browser,
    stores::{open_store, parse_uuid, to_string},
};
use anyhow::Context;
use gyro_core::local_check::{self as engine, CheckDraft, CheckPlan, CheckReport};
use gyro_core::{CancellationToken, GyroPaths};
use serde::Deserialize;
use std::time::Instant;
use std::{collections::HashMap, fs, path::PathBuf, sync::Mutex, time::Duration};
use tauri::Manager;
use uuid::Uuid;

// Freshness reads also persist the sticky stale flag. Serialize these with
// deletion so an in-flight refresh cannot recreate a deleted report.
static REPORT_IO: Mutex<()> = Mutex::new(());

#[derive(Default)]
pub(super) struct LocalCheckManager {
    state: Mutex<CheckState>,
}

#[derive(Default)]
struct CheckState {
    pending: HashMap<String, (CheckPlan, Instant)>,
    running: HashMap<String, (String, CancellationToken)>,
}

impl CheckState {
    fn cancel(&self, id: &str) -> anyhow::Result<()> {
        let (_, token) = self.running.get(id).context("Check is no longer running")?;
        token.cancel();
        Ok(())
    }

    fn finish(&mut self, id: &str) -> bool {
        self.running
            .remove(id)
            .is_some_and(|(_, token)| token.is_cancelled())
    }

    fn prepare(&mut self, plan: CheckPlan) -> anyhow::Result<()> {
        anyhow::ensure!(
            !self
                .running
                .values()
                .any(|(session, _)| *session == plan.draft.session_id),
            "A check is already running for this chat"
        );
        self.pending.retain(|_, (p, at)| {
            at.elapsed() < Duration::from_secs(600) && p.draft.session_id != plan.draft.session_id
        });
        anyhow::ensure!(self.pending.len() < 32, "Too many pending check plans");
        self.pending.insert(plan.id.clone(), (plan, Instant::now()));
        Ok(())
    }

    fn claim(&mut self, id: &str, run: bool) -> anyhow::Result<(CheckPlan, CancellationToken)> {
        let (plan, at) = self
            .pending
            .remove(id)
            .context("Plan is missing or already used; review a new plan")?;
        anyhow::ensure!(
            at.elapsed() < Duration::from_secs(600),
            "Plan expired; review a new plan"
        );
        let token = CancellationToken::default();
        if run {
            anyhow::ensure!(
                !self
                    .running
                    .values()
                    .any(|(session, _)| *session == plan.draft.session_id),
                "A check is already running for this chat"
            );
            self.running
                .insert(id.into(), (plan.draft.session_id.clone(), token.clone()));
        }
        Ok((plan, token))
    }
}

fn check_workspace(session_id: &str) -> Result<(PathBuf, u64), String> {
    let store = open_store()?;
    let session = store
        .get_session(parse_uuid(session_id)?)
        .map_err(to_string)?
        .ok_or("Chat no longer exists")?;
    if session.workspace_path.as_os_str().is_empty() {
        return Err("Choose a chat with a local project folder".into());
    }
    let root = session.workspace_path.canonicalize().map_err(to_string)?;
    Ok((root, session.workspace_identity.revision))
}

fn reports_dir() -> anyhow::Result<PathBuf> {
    Ok(GyroPaths::for_current_user()?
        .base_dir
        .join("check-reports"))
}

#[tauri::command]
pub(super) async fn prepare_local_check(
    app: tauri::AppHandle,
    draft: CheckDraft,
) -> Result<CheckPlan, String> {
    tauri::async_runtime::spawn_blocking(move || {
        draft.validate().map_err(to_string)?;
        let (root, revision) = check_workspace(&draft.session_id)?;
        let snapshot = engine::snapshot(&root, &draft.files).map_err(to_string)?;
        let plan = CheckPlan {
            id: Uuid::new_v4().to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
            workspace_revision: revision,
            draft,
            snapshot,
        };
        app.state::<LocalCheckManager>()
            .state
            .lock()
            .map_err(to_string)?
            .prepare(plan.clone())
            .map_err(to_string)?;
        Ok(plan)
    })
    .await
    .map_err(to_string)?
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum CheckDecision {
    Approve,
    Deny,
    Cancel,
}

fn execute_plan(
    app: &tauri::AppHandle,
    plan: &CheckPlan,
    cancellation: CancellationToken,
) -> anyhow::Result<gyro_core::ExecutionOutcome> {
    let (root, revision) = check_workspace(&plan.draft.session_id).map_err(anyhow::Error::msg)?;
    anyhow::ensure!(
        root == plan.snapshot.workspace && revision == plan.workspace_revision,
        "Chat workspace changed; review a new plan"
    );
    anyhow::ensure!(
        engine::snapshot(&root, &plan.draft.files)? == plan.snapshot,
        "Files changed after review; review a new plan"
    );
    if plan.draft.browser.is_some() {
        anyhow::ensure!(
            !cancellation.is_cancelled(),
            "Check was cancelled before opening a browser"
        );
        struct Driver<'a> {
            app: &'a tauri::AppHandle,
            resource: String,
        }
        impl engine::browser::BrowserDriver for Driver<'_> {
            fn call(
                &mut self,
                method: &str,
                args: serde_json::Value,
            ) -> anyhow::Result<serde_json::Value> {
                session_browser::call_agent(self.app, &self.resource, method, args)
                    .map_err(anyhow::Error::msg)
            }
        }
        let resource =
            session_browser::open_check_browser(app, plan).map_err(anyhow::Error::msg)?;
        let mut driver = Driver { app, resource };
        // A page/agent may still be loading. Only reads are polled; never
        // replay a click or fill after an error or uncertain completion.
        let ready_until = Instant::now() + Duration::from_secs(10);
        let ready = (|| -> anyhow::Result<()> {
            use engine::browser::BrowserDriver;
            let expected = url::Url::parse(&plan.draft.preview_url)?
                .origin()
                .ascii_serialization();
            loop {
                anyhow::ensure!(
                    !cancellation.is_cancelled(),
                    "Browser check was cancelled before it was ready"
                );
                if let Ok(status) = driver.call("status", serde_json::json!({})) {
                    if status["readyState"] == "complete"
                        && status["url"]
                            .as_str()
                            .and_then(|s| url::Url::parse(s).ok())
                            .is_some_and(|u| u.origin().ascii_serialization() == expected)
                    {
                        let selector = &plan.draft.browser.as_ref().unwrap().ready_selector;
                        if let Ok(found) =
                            driver.call("find", serde_json::json!({"selector":selector,"limit":2}))
                        {
                            if found["results"].as_array().is_some_and(|r| r.len() == 1)
                                && found["hasMore"] == false
                            {
                                return Ok(());
                            }
                        }
                    }
                }
                anyhow::ensure!(
                    Instant::now() < ready_until,
                    "Browser did not become ready; no actions ran"
                );
                std::thread::sleep(Duration::from_millis(100));
            }
        })();
        let result = ready.and_then(|()| engine::browser::run(plan, &mut driver, cancellation));
        let closed =
            session_browser::close_check_browser(app, &driver.resource).map_err(anyhow::Error::msg);
        // Do not report success if resource cleanup failed.
        closed?;
        return result;
    }
    let private = GyroPaths::for_current_user()?.base_dir;
    engine::run_check(plan, &user_home_directory()?, &private, cancellation)
}

#[tauri::command]
pub(super) async fn resolve_local_check(
    app: tauri::AppHandle,
    plan_id: String,
    decision: CheckDecision,
    test_environment_confirmed: bool,
) -> Result<CheckReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let run = matches!(decision, CheckDecision::Approve);
        if run && !test_environment_confirmed {
            return Err("Confirm the reviewed test environment before approving".into());
        }
        let manager = app.state::<LocalCheckManager>();
        let (plan, token) = manager
            .state
            .lock()
            .map_err(to_string)?
            .claim(&plan_id, run)
            .map_err(to_string)?;
        let mut report = if run {
            match execute_plan(&app, &plan, token.clone()) {
                Ok(output) => engine::report_from_output(plan, output),
                Err(error) => {
                    let reason=if plan.draft.browser.is_some() {
                        format!("Browser check did not complete reliably: {error}. Some reviewed actions may already have run; nothing was retried automatically.")
                    } else {format!("Check could not run: {error}")};
                    engine::not_checked(plan,&reason)
                },
            }
        } else {
            engine::not_checked(
                plan,
                if matches!(decision, CheckDecision::Deny) {
                    "User denied the action. No check action ran."
                } else {
                    "User cancelled before execution. No check action ran."
                },
            )
        };
        engine::refresh_freshness(&mut report);
        // Order completion against cancel_local_check under the same lock.
        // After removal a cancellation is rejected as already complete; a
        // cancellation accepted before removal must invalidate the verdicts.
        let cancelled = {
            let mut state = manager.state.lock().map_err(to_string)?;
            state.finish(&plan_id)
        };
        if cancelled {
            // Late cancellation also invalidates otherwise complete evidence.
            for result in &mut report.results {
                result.status = engine::CheckStatus::NotChecked;
                result.reason = "Check was cancelled; evidence is incomplete.".into();
            }
        }
        let saved = (|| {
            let _io = REPORT_IO.lock().map_err(to_string)?;
            reports_dir()
                .and_then(|path| engine::save_report(&path, &report))
                .map_err(to_string)
        })();
        saved?;
        Ok(report)
    })
    .await
    .map_err(to_string)?
}

#[tauri::command]
pub(super) fn cancel_local_check(app: tauri::AppHandle, plan_id: String) -> Result<(), String> {
    let manager = app.state::<LocalCheckManager>();
    let state = manager.state.lock().map_err(to_string)?;
    state.cancel(&plan_id).map_err(to_string)
}

#[tauri::command]
pub(super) async fn list_local_checks(session_id: String) -> Result<Vec<CheckReport>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _io = REPORT_IO.lock().map_err(to_string)?;
        parse_uuid(&session_id)?;
        let base = reports_dir().map_err(to_string)?;
        if !base.exists() {
            return Ok(Vec::new());
        }
        if fs::symlink_metadata(&base)
            .map_err(to_string)?
            .file_type()
            .is_symlink()
        {
            return Err("Unsafe report directory".into());
        }
        let mut reports = Vec::new();
        for entry in fs::read_dir(&base).map_err(to_string)? {
            let entry = entry.map_err(to_string)?;
            let meta = entry.path().symlink_metadata().map_err(to_string)?;
            if !meta.is_file()
                || meta.len() > 512 * 1024
                || entry.path().extension().and_then(|s| s.to_str()) != Some("json")
            {
                continue;
            }
            let mut report: CheckReport =
                serde_json::from_slice(&fs::read(entry.path()).map_err(to_string)?)
                    .map_err(to_string)?;
            if report.plan.draft.session_id != session_id {
                continue;
            }
            engine::refresh_evidence_scope(&mut report);
            // Only re-evaluate a persisted plan's own original files/root.
            if check_workspace(&session_id).ok().as_ref()
                != Some(&(
                    report.plan.snapshot.workspace.clone(),
                    report.plan.workspace_revision,
                ))
            {
                report.stale = true;
                report.freshness_note = "Chat workspace changed or is unavailable.".into();
            } else {
                engine::refresh_freshness(&mut report);
            }
            engine::save_report(&base, &report).map_err(to_string)?;
            reports.push(report);
        }
        reports.sort_by(|a, b| b.finished_at.cmp(&a.finished_at));
        reports.truncate(20);
        Ok(reports)
    })
    .await
    .map_err(to_string)?
}

#[tauri::command]
pub(super) async fn delete_local_check(
    session_id: String,
    report_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _io = REPORT_IO.lock().map_err(to_string)?;
        parse_uuid(&session_id)?;
        let id = parse_uuid(&report_id)?;
        let base = reports_dir().map_err(to_string)?;
        if fs::symlink_metadata(&base)
            .map_err(to_string)?
            .file_type()
            .is_symlink()
        {
            return Err("Unsafe report directory".into());
        }
        let path = base.join(format!("{id}.json"));
        let meta = fs::symlink_metadata(&path).map_err(to_string)?;
        if !meta.is_file() || meta.len() > 512 * 1024 {
            return Err("Unsafe report file".into());
        }
        let report: CheckReport =
            serde_json::from_slice(&fs::read(&path).map_err(to_string)?).map_err(to_string)?;
        if report.plan.draft.session_id != session_id {
            return Err("Report belongs to another chat".into());
        }
        fs::remove_file(path).map_err(to_string)
    })
    .await
    .map_err(to_string)?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn plan() -> CheckPlan {
        serde_json::from_value(serde_json::json!({
            "id":Uuid::new_v4(),"createdAt":chrono::Utc::now().to_rfc3339(),"workspaceRevision":1,
            "draft":{"sessionId":Uuid::new_v4(),"previewUrl":"http://127.0.0.1:4317","command":"touch should-not-exist","dataChanges":"test","files":["todo.mjs"],"criteria":[{"id":"add-item","requirement":"Add","expected":true}]},
            "snapshot":{"workspace":"/tmp","gitHead":null,"files":[]}
        })).unwrap()
    }
    #[test]
    fn deny_and_cancel_never_register_execution_and_cannot_be_replayed() {
        for reason in ["denied", "cancelled"] {
            let mut state = CheckState::default();
            let p = plan();
            let id = p.id.clone();
            state.prepare(p).unwrap();
            let (p, _) = state.claim(&id, false).unwrap();
            assert!(state.running.is_empty());
            assert!(engine::not_checked(p, reason).output.is_none());
            assert!(state.claim(&id, true).is_err());
        }
    }
    #[test]
    fn approval_is_single_use_and_cancellation_reaches_the_same_token() {
        let mut state = CheckState::default();
        let p = plan();
        let id = p.id.clone();
        state.prepare(p).unwrap();
        let (_, token) = state.claim(&id, true).unwrap();
        state.running.get(&id).unwrap().1.cancel();
        assert!(token.is_cancelled());
        assert!(state.claim(&id, true).is_err());
    }
    #[test]
    fn editing_replaces_pending_plan_and_expired_plan_cannot_run() {
        let mut state = CheckState::default();
        let p = plan();
        let old = p.id.clone();
        let mut edited = p.clone();
        edited.id = Uuid::new_v4().to_string();
        state.prepare(p).unwrap();
        state.prepare(edited.clone()).unwrap();
        assert!(state.claim(&old, true).is_err());
        state.pending.get_mut(&edited.id).unwrap().1 = Instant::now() - Duration::from_secs(601);
        assert!(state.claim(&edited.id, true).is_err());
        assert!(state.running.is_empty());
    }

    #[test]
    fn completion_and_accepted_cancellation_have_one_order() {
        let mut state = CheckState::default();
        let p = plan();
        let id = p.id.clone();
        state.prepare(p).unwrap();
        state.claim(&id, true).unwrap();
        state.cancel(&id).unwrap();
        assert!(state.finish(&id));
        let p = plan();
        let id = p.id.clone();
        state.prepare(p).unwrap();
        let (_, token) = state.claim(&id, true).unwrap();
        assert!(!state.finish(&id));
        assert!(state.cancel(&id).is_err());
        assert!(!token.is_cancelled());
    }
}
