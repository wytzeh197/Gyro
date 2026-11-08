//! State managers.

use crate::{
    app::limits::{MAX_CONCURRENT_BROWSER_PREVIEWS, MAX_CONCURRENT_IDE_COMMANDS},
    capabilities::execute::handle_desktop_provider_capability_request,
    ide_evidence,
    state::provider_run::{
        BoundProviderCapabilityContext, ModelBrowserResource, ModelTerminalResource,
        PendingCapabilityApproval, PendingProviderApproval, ProviderRunControl,
    },
    terminal_capability,
};
use gyro_core::{
    CancellationToken, CapabilityRequest, CapabilityResponse, WorkspaceContextSnapshot,
};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex, OnceLock, Weak,
    },
};
use tauri::Manager;
#[derive(Default)]
pub(crate) struct ProviderCancellationManager {
    pub(crate) flags: Mutex<HashMap<String, Arc<ProviderRunControl>>>,
}

#[derive(Default)]
pub(crate) struct ProviderApprovalManager {
    pub(crate) pending: Mutex<HashMap<String, PendingProviderApproval>>,
}

#[derive(Default)]
pub(crate) struct ProviderCapabilityApprovalManager {
    pub(crate) pending: Mutex<HashMap<String, PendingCapabilityApproval>>,
}

#[derive(Default)]
pub(crate) struct ProviderCapabilityBroker;

impl ProviderCapabilityBroker {
    pub(crate) fn invoke(
        &self,
        app: &tauri::AppHandle,
        request: CapabilityRequest,
    ) -> CapabilityResponse {
        handle_desktop_provider_capability_request(app, request)
    }
}

#[derive(Default)]
pub(crate) struct ProviderCapabilityResourceManager {
    pub(crate) terminals: Mutex<HashMap<String, ModelTerminalResource>>,
    pub(crate) browsers: Mutex<HashMap<String, ModelBrowserResource>>,
}

#[derive(Default)]
pub(crate) struct CapabilityIdeEvidenceManager {
    /// One live snapshot per recently used project; see `ide_evidence`.
    pub(crate) evidence: Mutex<ide_evidence::IdeEvidenceCache>,
    pub(crate) task_outputs: terminal_capability::RetainedTaskOutputs,
}

/// Runs `reader` over the live IDE evidence for this turn's workspace.
///
/// A snapshot can carry unsaved text for every open buffer that fits, so
/// capability paths that only need to look something up borrow it under the
/// cache lock instead of cloning the whole workspace's editor text first.
pub(crate) fn with_ide_evidence<T>(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    reader: impl FnOnce(&WorkspaceContextSnapshot) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    let manager = app.state::<CapabilityIdeEvidenceManager>();
    let evidence = manager
        .evidence
        .lock()
        .map_err(|_| anyhow::anyhow!("IDE evidence state is unavailable"))?;
    match evidence.get(&bound.workspace_key) {
        // The shell has pushed newer evidence than the turn started with.
        Some(snapshot) => reader(snapshot),
        None => reader(&bound.workspace_context),
    }
}

pub(crate) static ATTACHMENT_SESSION_LOCKS: OnceLock<Mutex<HashMap<String, Weak<Mutex<()>>>>> =
    OnceLock::new();
pub(crate) static ACTIVE_IDE_COMMANDS: AtomicUsize = AtomicUsize::new(0);
pub(crate) static ACTIVE_BROWSER_PREVIEWS: AtomicUsize = AtomicUsize::new(0);
pub(crate) static ACTIVE_TASK_RUNS: OnceLock<Mutex<HashMap<String, CancellationToken>>> =
    OnceLock::new();

pub(crate) fn active_task_runs() -> &'static Mutex<HashMap<String, CancellationToken>> {
    ACTIVE_TASK_RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn task_run_key(root: &Path, task_id: &str) -> String {
    format!("{}\u{1e}{task_id}", root.display())
}

/// Keeps a running task cancellable for as long as the command is alive.
pub(crate) struct TaskRunHandle {
    pub(crate) key: String,
    pub(crate) cancellation: CancellationToken,
}

impl TaskRunHandle {
    pub(crate) fn register(root: &Path, task_id: &str) -> Self {
        let key = task_run_key(root, task_id);
        let cancellation = CancellationToken::default();
        if let Ok(mut runs) = active_task_runs().lock() {
            runs.insert(key.clone(), cancellation.clone());
        }
        Self { key, cancellation }
    }

    pub(crate) fn token(&self) -> CancellationToken {
        self.cancellation.clone()
    }
}

impl Drop for TaskRunHandle {
    fn drop(&mut self) {
        if let Ok(mut runs) = active_task_runs().lock() {
            runs.remove(&self.key);
        }
    }
}

pub(crate) fn cancel_task_run(root: &Path, task_id: &str) -> bool {
    let key = task_run_key(root, task_id);
    let Ok(runs) = active_task_runs().lock() else {
        return false;
    };
    match runs.get(&key) {
        Some(cancellation) => {
            cancellation.cancel();
            true
        }
        None => false,
    }
}

pub(crate) struct IdeCommandAdmission;

impl IdeCommandAdmission {
    pub(crate) fn acquire() -> Result<Self, String> {
        ACTIVE_IDE_COMMANDS
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                (active < MAX_CONCURRENT_IDE_COMMANDS).then_some(active + 1)
            })
            .map_err(|_| "too many task or test commands are already running".to_string())?;
        Ok(Self)
    }
}

impl Drop for IdeCommandAdmission {
    fn drop(&mut self) {
        ACTIVE_IDE_COMMANDS.fetch_sub(1, Ordering::AcqRel);
    }
}

pub(crate) struct BrowserPreviewAdmission;

impl BrowserPreviewAdmission {
    pub(crate) fn acquire() -> Result<Self, String> {
        ACTIVE_BROWSER_PREVIEWS
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                (active < MAX_CONCURRENT_BROWSER_PREVIEWS).then_some(active + 1)
            })
            .map_err(|_| "too many browser previews are already being captured".to_string())?;
        Ok(Self)
    }
}

impl Drop for BrowserPreviewAdmission {
    fn drop(&mut self) {
        ACTIVE_BROWSER_PREVIEWS.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Deletes a temporary file when dropped.
pub(crate) struct TempFileGuard(pub(crate) PathBuf);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub(crate) struct HiddenWebviewGuard(pub(crate) tauri::WebviewWindow);

impl std::ops::Deref for HiddenWebviewGuard {
    type Target = tauri::WebviewWindow;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl Drop for HiddenWebviewGuard {
    fn drop(&mut self) {
        let _ = self.0.close();
    }
}
