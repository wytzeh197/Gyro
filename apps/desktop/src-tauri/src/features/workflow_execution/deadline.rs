//! A suspended approval must not hold an unattended provider slot indefinitely.
use super::notify;
use crate::{
    state::provider_run::{stop_provider_run, ProviderStopReason},
    stores::open_store,
};
use gyro_core::workflows::WorkflowRunStatus;
use std::{sync::mpsc, time::Duration};
use uuid::Uuid;
pub(super) struct RunDeadline(mpsc::Sender<()>);
impl RunDeadline {
    pub(super) fn start(app: tauri::AppHandle, id: Uuid) -> Self {
        let (send, receive) = mpsc::channel();
        std::thread::spawn(move || {
            if receive.recv_timeout(Duration::from_secs(30 * 60)).is_ok() {
                return;
            }
            let Ok(store) = open_store() else { return };
            for _ in 0..3 {
                let Ok(Some(run)) = store.workflow_run(id) else {
                    return;
                };
                if run.status.terminal() {
                    return;
                }
                for step in &run.steps {
                    if let Some(session) = step.session_id {
                        stop_provider_run(&app, &session.to_string(), ProviderStopReason::User);
                    }
                }
                if let Ok(reviews) = store.code_reviews(None) {
                    for review in reviews.into_iter().filter(|review| {
                        review.workflow_run_id == Some(id) && !review.status.terminal()
                    }) {
                        if let Some(session) = review.review_session_id {
                            stop_provider_run(&app, &session.to_string(), ProviderStopReason::User);
                        }
                    }
                }
                if let Ok(waiting)=store.stop_workflow_run(id,run.revision,WorkflowRunStatus::Waiting,"The 30 minute run deadline expired. Inspect recorded actions before an explicit continuation."){notify(&app,&waiting);return}
            }
        });
        Self(send)
    }
}
impl Drop for RunDeadline {
    fn drop(&mut self) {
        let _ = self.0.send(());
    }
}
