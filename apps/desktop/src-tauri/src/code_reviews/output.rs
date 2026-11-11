//! A bounded private stream artifact survives cancellation and host exit.
use anyhow::Result;
use gyro_core::{
    code_reviews::{open_review_partial, remove_review_partial},
    GyroPaths,
};
use std::{
    collections::HashMap,
    fs::File,
    io::Write,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use uuid::Uuid;
struct Capture {
    file: File,
    bytes: usize,
    truncated: bool,
    last_sync: Instant,
}
fn captures() -> &'static Mutex<HashMap<String, Capture>> {
    static CAPTURES: OnceLock<Mutex<HashMap<String, Capture>>> = OnceLock::new();
    CAPTURES.get_or_init(Default::default)
}
pub(crate) struct OutputCapture {
    session: String,
    review: Uuid,
    paths: GyroPaths,
    complete: bool,
    workflow: bool,
}
impl OutputCapture {
    pub(crate) fn begin(paths: &GyroPaths, review: Uuid, session: String) -> Result<Self> {
        Self::begin_kind(paths, review, session, false)
    }
    pub(crate) fn begin_workflow(paths: &GyroPaths, id: Uuid, session: String) -> Result<Self> {
        Self::begin_kind(paths, id, session, true)
    }
    fn begin_kind(
        paths: &GyroPaths,
        review: Uuid,
        session: String,
        workflow: bool,
    ) -> Result<Self> {
        let capture = Capture {
            file: if workflow {
                gyro_core::workflows::open_draft_partial(paths, review)?
            } else {
                open_review_partial(paths, review)?
            },
            bytes: 0,
            truncated: false,
            last_sync: Instant::now(),
        };
        captures()
            .lock()
            .map_err(|_| anyhow::anyhow!("review output capture is unavailable"))?
            .insert(session.clone(), capture);
        Ok(Self {
            session,
            review,
            paths: paths.clone(),
            complete: false,
            workflow,
        })
    }
    pub(crate) fn completed(&mut self) {
        self.complete = true;
    }
}
impl Drop for OutputCapture {
    fn drop(&mut self) {
        if let Ok(mut captures) = captures().lock() {
            if let Some(capture) = captures.remove(&self.session) {
                let _ = capture.file.sync_all();
            }
        }
        if self.complete {
            if self.workflow {
                let _ = gyro_core::workflows::remove_draft_partial(&self.paths, self.review);
            } else {
                let _ = remove_review_partial(&self.paths, self.review);
            }
        }
    }
}
pub(crate) fn append(session: &str, text: &str) {
    let Ok(mut captures) = captures().lock() else {
        return;
    };
    let Some(capture) = captures.get_mut(session) else {
        return;
    };
    if capture.truncated {
        return;
    }
    let remaining = (2 * 1024 * 1024usize).saturating_sub(capture.bytes);
    let mut end = text.len().min(remaining);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    if capture.file.write_all(text[..end].as_bytes()).is_err() {
        return;
    }
    capture.bytes += end;
    if end < text.len() {
        let _ = capture
            .file
            .write_all(b"\n[Partial output exceeded its 2 MiB capture limit]");
        capture.truncated = true;
    }
    if capture.last_sync.elapsed() >= Duration::from_secs(1) {
        let _ = capture.file.sync_data();
        capture.last_sync = Instant::now();
    }
}
