//! Session-scoped embedded browser (child WKWebView) for the chat rail.
//!
//! One child webview per chat session, positioned over the React rail host.
//! The injected agent captures console/network and exposes DOM read/interaction
//! tools via native evaluation callbacks. The custom URI scheme carries only
//! best-effort console/network events; tool results do not depend on page fetch.

use crate::browser_viewport::{self, BrowserViewportRequest, BrowserViewportState};
use gyro_core::security::redact_secrets;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, WebviewUrl};
use uuid::Uuid;

#[cfg(target_os = "macos")]
#[path = "browser_navigation_observer.rs"]
mod navigation_observer;
#[path = "browser_operation.rs"]
mod operation;
pub(crate) use operation::PendingCall;
pub(crate) use operation::{begin_model_operation, bind_model_resource, operation_was_cancelled};

const MAX_CONSOLE_ENTRIES: usize = 100;
const MAX_NETWORK_ENTRIES: usize = 100;
const MAX_ENTRY_CHARS: usize = 2_000;
const MAX_TREE_CHARS: usize = 48_000;
const MAX_FIND_RESULTS: usize = 40;
const AGENT_CALL_TIMEOUT: Duration = Duration::from_secs(8);
const MAIN_WINDOW_LABEL: &str = "main";
const BRIDGE_SCHEME: &str = "gyro-bridge";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBrowserBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The viewport a browser gets when nobody is looking at it.
///
/// An ordinary desktop size, so a background page lays out the way the site
/// intends and the model reads the same document a person would. It is never
/// shown at these bounds: the UI host overwrites them the moment it mounts.
pub const BACKGROUND_BROWSER_BOUNDS: SessionBrowserBounds = SessionBrowserBounds {
    x: 0.0,
    y: 0.0,
    width: 1280.0,
    height: 800.0,
};

// Create agent webviews outside the window before hiding them, so creation
// cannot briefly cover the frontend. They retain a full desktop viewport.
const AGENT_BROWSER_BOUNDS: SessionBrowserBounds = SessionBrowserBounds {
    x: -1281.0,
    ..BACKGROUND_BROWSER_BOUNDS
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBrowserOpenRequest {
    pub session_id: String,
    pub workspace_key: String,
    pub url: String,
    #[serde(default)]
    pub bounds: Option<SessionBrowserBounds>,
    #[serde(default)]
    pub visible: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBrowserSnapshot {
    pub session_id: String,
    pub workspace_key: String,
    pub resource_id: String,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub navigation_id: u64,
    pub document_committed: bool,
    #[serde(default)]
    pub navigation_error: Option<BrowserNavigationError>,
    pub visible: bool,
    pub background_only: bool,
    pub label: String,
    pub viewport: BrowserViewportState,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNavigationError {
    pub kind: String,
    pub message: String,
    pub code: isize,
}

#[derive(Clone, Debug)]
pub struct SessionBrowserCapture {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug)]
pub struct BrowserPointerReference {
    pub capture_id: String,
    pub url: String,
    pub viewport: Value,
    pub created_at: Instant,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserConsoleEntry {
    pub kind: String,
    pub message: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub line: Option<i64>,
    #[serde(default)]
    pub column: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNetworkEntry {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub status: Option<i64>,
    #[serde(default)]
    pub ok: Option<bool>,
    #[serde(default, alias = "resourceType")]
    pub resource_type: Option<String>,
}

struct SessionBrowserSlot {
    session_id: String,
    workspace_key: String,
    resource_id: String,
    webview_label: String,
    bridge_nonce: String,
    url: String,
    title: String,
    loading: bool,
    navigation_id: u64,
    document_committed: bool,
    navigation_error: Option<BrowserNavigationError>,
    native_navigation_token: Option<usize>,
    committed_url: Option<String>,
    failed_provisional: bool,
    visible: bool,
    background_only: bool,
    host_bounds: SessionBrowserBounds,
    viewport_request: BrowserViewportRequest,
    viewport: BrowserViewportState,
    approved_origins: HashSet<String>,
    pointer_reference: Option<BrowserPointerReference>,
    console: VecDeque<BrowserConsoleEntry>,
    network: VecDeque<BrowserNetworkEntry>,
}

#[derive(Default)]
pub struct SessionBrowserManager {
    inner: Mutex<HashMap<String, SessionBrowserSlot>>,
    layout: Mutex<()>,
}

#[derive(Clone)]
pub(crate) struct BrowserLease {
    session_id: String,
    resource_id: String,
}
impl BrowserLease {
    fn from_snapshot(snapshot: &SessionBrowserSnapshot) -> Self {
        Self {
            session_id: snapshot.session_id.clone(),
            resource_id: snapshot.resource_id.clone(),
        }
    }
    pub(crate) fn validate(&self, manager: &SessionBrowserManager) -> Result<(), String> {
        manager.with_resource_mut(self, |_| ())
    }
    #[cfg(target_os = "macos")]
    pub(crate) fn emit_user_interaction<R: Runtime>(&self, app: &AppHandle<R>) {
        if app
            .state::<SessionBrowserManager>()
            .get_snapshot(&self.session_id)
            .ok()
            .flatten()
            .is_some_and(|snapshot| {
                snapshot.resource_id == self.resource_id
                    && snapshot.visible
                    && !snapshot.background_only
            })
        {
            let _ = app.emit(
                "session-browser-interaction",
                serde_json::json!({
                    "sessionId": self.session_id, "resourceId": self.resource_id,
                }),
            );
        }
    }
}

struct BrowserNavigationRequest {
    resource: BrowserLease,
    navigation_id: u64,
    previous: SessionBrowserSnapshot,
    previous_token: Option<usize>,
}

#[derive(Clone)]
struct BrowserDocumentLease {
    resource: BrowserLease,
    navigation_id: u64,
}
impl BrowserDocumentLease {
    fn validate(&self, manager: &SessionBrowserManager) -> Result<(), String> {
        manager.with_document_mut(self, |_| ())
    }
}

impl SessionBrowserManager {
    #[cfg(all(debug_assertions, feature = "native-browser-events-smoke"))]
    pub(crate) fn fixture_layout_is_busy(&self) -> bool {
        self.layout.try_lock().is_err()
    }
    #[cfg(target_os = "macos")]
    fn native_navigation_event(
        &self,
        lease: &BrowserLease,
        token: usize,
        event: &navigation_observer::NavigationEvent,
        url: Option<&str>,
    ) -> Result<Option<(&'static str, u64)>, String> {
        use navigation_observer::NavigationEvent;
        self.with_resource_mut(lease, |slot| {
            if matches!(event, NavigationEvent::Started) {
                if slot.document_committed || slot.navigation_error.is_some() {
                    slot.navigation_id += 1;
                }
                slot.native_navigation_token = Some(token);
                slot.document_committed = false;
                slot.loading = true;
                slot.navigation_error = None;
                slot.title.clear();
                slot.pointer_reference = None;
                if let Some(url) = url.filter(|url| parse_navigable_url(url).is_ok()) {
                    slot.url = url.to_string();
                }
                return Some(("loading", slot.navigation_id));
            }
            // Explicit requests clear this token before dispatch. An old
            // cancellation, commit or finish cannot settle their replacement.
            // Initial creation may attach after didStart but before commit.
            if slot.native_navigation_token != Some(token) {
                if slot.navigation_id != 1 || slot.native_navigation_token.is_some()
                    || slot.navigation_error.is_some() {
                    return None;
                }
                slot.native_navigation_token = Some(token);
            }
            match event {
                NavigationEvent::Committed | NavigationEvent::Finished => {
                    let Some(url) = url.filter(|url| parse_navigable_url(url).is_ok()) else {return None;};
                    slot.url = url.to_string();
                    slot.committed_url = Some(url.to_string());
                    slot.document_committed = true;
                    slot.loading = matches!(event, NavigationEvent::Committed);
                    if slot.loading {
                        slot.title.clear();
                        slot.pointer_reference = None;
                    }
                    Some((if slot.loading {"loading"} else {"loaded"}, slot.navigation_id))
                }
                NavigationEvent::Failed {cancelled,code,provisional} => {
                    slot.loading = false;
                    slot.document_committed = false;
                    slot.native_navigation_token = None;
                    slot.pointer_reference = None;
                    slot.failed_provisional = *provisional;
                    slot.navigation_error = Some(BrowserNavigationError {
                        kind:if *cancelled {"cancelled"} else {"failed"}.into(),
                        message:if *cancelled {"Navigation was cancelled. Try again or go back."} else {"The page could not load. Check the address or connection, then try again."}.into(),
                        code:*code,
                    });
                    Some(("failed",slot.navigation_id))
                }
                NavigationEvent::Started => unreachable!(),
            }
        })
    }

    fn recover_provisional_document(
        &self,
        lease: &BrowserLease,
        expected: u64,
    ) -> Result<bool, String> {
        self.with_resource_mut(lease, |slot| {
            if slot.navigation_id != expected {
                return Err("browser navigation changed before recovery".into());
            }
            if slot.document_committed
                || (slot.navigation_error.is_some() && !slot.failed_provisional)
            {
                return Ok(false);
            }
            let Some(url) = slot.committed_url.clone() else {
                return Ok(false);
            };
            slot.navigation_id += 1;
            slot.loading = false;
            slot.document_committed = true;
            slot.navigation_error = None;
            slot.native_navigation_token = None;
            slot.url = url;
            slot.title.clear();
            slot.pointer_reference = None;
            Ok(true)
        })?
    }
    #[cfg(test)]
    fn start_native_navigation(
        &self,
        lease: &BrowserLease,
        url: Option<&str>,
    ) -> Result<(), String> {
        self.with_resource_mut(lease, |slot| {
            // Explicit requests already invalidated their document. A link,
            // form or page script reaches this point through WebKit instead.
            if slot.document_committed {
                slot.navigation_id += 1;
            }
            slot.document_committed = false;
            slot.loading = true;
            slot.navigation_error = None;
            slot.title.clear();
            slot.pointer_reference = None;
            if let Some(url) = url.filter(|url| parse_navigable_url(url).is_ok()) {
                slot.url = url.to_string();
            }
        })
    }
    fn reserve_navigation(
        &self,
        lease: &BrowserLease,
        url: Option<&str>,
    ) -> Result<BrowserNavigationRequest, String> {
        self.with_resource_mut(lease, |slot| {
            let previous = Self::snapshot_locked(slot);
            let previous_token = slot.native_navigation_token;
            slot.navigation_id += 1;
            slot.loading = true;
            slot.document_committed = false;
            slot.navigation_error = None;
            slot.native_navigation_token = None;
            slot.title.clear();
            slot.pointer_reference = None;
            if let Some(url) = url {
                slot.url = url.to_string();
            }
            BrowserNavigationRequest {
                resource: lease.clone(),
                navigation_id: slot.navigation_id,
                previous,
                previous_token,
            }
        })
    }

    fn start_navigation(&self, lease: &BrowserLease, url: Option<&str>) -> Result<u64, String> {
        self.reserve_navigation(lease, url)
            .map(|request| request.navigation_id)
    }

    fn restore_undispatched_navigation(&self, request: &BrowserNavigationRequest, cancelled: bool) {
        let _ = self.with_resource_mut(&request.resource, |slot| {
            if slot.navigation_id != request.navigation_id {
                return;
            }
            if request.previous.document_committed
                || request.previous_token.is_some()
                || request.previous.navigation_error.is_some()
            {
                slot.loading = request.previous.loading;
                slot.document_committed = request.previous.document_committed;
                slot.navigation_error = request.previous.navigation_error.clone();
                slot.native_navigation_token = request.previous_token;
                slot.title = request.previous.title.clone();
                slot.url = request.previous.url.clone();
            } else {
                // An earlier queued request may also have been superseded.
                // Do not restore an unbound pending state as if it will run.
                slot.loading = false;
                slot.document_committed = false;
                slot.native_navigation_token = None;
                slot.failed_provisional = true;
                slot.navigation_error = Some(BrowserNavigationError {
                    kind: if cancelled { "cancelled" } else { "failed" }.into(),
                    message: "Navigation did not start. Try again or go back.".into(),
                    code: 0,
                });
            }
        });
    }
    #[cfg(any(test, not(target_os = "macos")))]
    fn commit_navigation(&self, lease: &BrowserLease, url: &str) -> Result<u64, String> {
        self.with_resource_mut(lease, |slot| {
            // Wry's macOS Started event is WKWebView didCommitNavigation.
            // A page/link navigation may have no earlier explicit request.
            if slot.document_committed {
                slot.navigation_id += 1;
            }
            slot.document_committed = true;
            slot.navigation_error = None;
            slot.committed_url = Some(url.to_string());
            slot.loading = true;
            slot.url = url.to_string();
            slot.title.clear();
            slot.pointer_reference = None;
            slot.navigation_id
        })
    }

    #[cfg(any(test, not(target_os = "macos")))]
    fn finish_navigation(&self, lease: &BrowserLease, url: &str) -> Result<u64, String> {
        self.with_resource_mut(lease, |slot| {
            slot.url = url.to_string();
            slot.loading = false;
            slot.document_committed = true;
            slot.committed_url = Some(url.to_string());
            slot.navigation_id
        })
    }

    fn navigation_is_finished(&self, lease: &BrowserLease, navigation_id: u64) -> bool {
        self.with_resource_mut(lease, |slot| {
            slot.navigation_id == navigation_id && !slot.loading
        })
        .unwrap_or(false)
    }

    fn restore_navigation(
        &self,
        lease: &BrowserLease,
        navigation_id: u64,
        previous: &SessionBrowserSnapshot,
    ) {
        let _ = self.with_resource_mut(lease, |slot| {
            // A failed request must not undo a native callback/newer request.
            if slot.navigation_id == navigation_id {
                slot.loading = previous.loading;
                slot.document_committed = previous.document_committed;
                slot.navigation_error = previous.navigation_error.clone();
                slot.title = previous.title.clone();
                slot.url = previous.url.clone();
            }
        });
    }

    fn with_document_mut<R>(
        &self,
        lease: &BrowserDocumentLease,
        f: impl FnOnce(&mut SessionBrowserSlot) -> R,
    ) -> Result<R, String> {
        self.with_resource_mut(&lease.resource, |slot| {
            if slot.navigation_id != lease.navigation_id || !slot.document_committed || slot.navigation_error.is_some() {
                return Err("browser document changed while the action was waiting; an already dispatched action may have run, so observe the current page before retrying".into());
            }
            Ok(f(slot))
        })?
    }

    fn capture_document(
        &self,
        session_id: &str,
    ) -> Result<(BrowserDocumentLease, SessionBrowserSnapshot), String> {
        let (resource, snapshot) = self.capture_resource(session_id)?;
        if let Some(error) = &snapshot.navigation_error {
            return Err(format!(
                "browser navigation {}: {}",
                error.kind, error.message
            ));
        }
        if !snapshot.document_committed {
            return Err("browser navigation is waiting for the new document; wait and observe the current page before interacting".into());
        }
        Ok((
            BrowserDocumentLease {
                resource,
                navigation_id: snapshot.navigation_id,
            },
            snapshot,
        ))
    }

    fn wait_for_document(&self, session_id: &str) -> Result<SessionBrowserSnapshot, String> {
        let (resource, initial) = self.capture_resource(session_id)?;
        let pending = PendingCall::new(
            AGENT_CALL_TIMEOUT,
            "browser navigation did not commit before the screenshot deadline",
        )?;
        let guard = pending.guard();
        loop {
            guard.check()?;
            resource.validate(self)?;
            let current = self
                .get_snapshot(session_id)?
                .ok_or("browser closed while waiting for its document")?;
            if current.navigation_id != initial.navigation_id {
                return Err(
                    "browser navigation changed while waiting for the screenshot document".into(),
                );
            }
            if let Some(error) = &current.navigation_error {
                return Err(format!(
                    "browser navigation {}: {}",
                    error.kind, error.message
                ));
            }
            if current.document_committed {
                return Ok(current);
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    fn reconcile_initial_document(
        &self,
        lease: &BrowserDocumentLease,
        observed: &Value,
    ) -> Result<bool, String> {
        self.with_resource_mut(&lease.resource, |slot| {
            if slot.document_committed
                || slot.navigation_error.is_some()
                || slot.navigation_id != lease.navigation_id
            {
                return false;
            }
            let Some(url) = observed.get("url").and_then(Value::as_str) else {
                return false;
            };
            if observed.get("installed") != Some(&Value::Bool(true))
                || !parse_navigable_url(url)
                    .is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
            {
                return false;
            }
            slot.document_committed = true;
            slot.committed_url = Some(sanitize_text(url));
            slot.loading = observed.get("readyState").and_then(Value::as_str) != Some("complete");
            slot.url = sanitize_text(url);
            slot.title = observed
                .get("title")
                .and_then(Value::as_str)
                .map(sanitize_text)
                .unwrap_or_default();
            true
        })
    }

    fn with_resource_mut<R>(
        &self,
        lease: &BrowserLease,
        f: impl FnOnce(&mut SessionBrowserSlot) -> R,
    ) -> Result<R, String> {
        self.with_slot_mut(&lease.session_id, |slot| {
            if slot.resource_id != lease.resource_id {
                return Err("browser resource changed while the action was waiting; observe the current browser again".into());
            }
            Ok(f(slot))
        })?
    }

    fn update_resource_state(
        &self,
        lease: &BrowserLease,
        url: Option<&str>,
        title: Option<&str>,
    ) -> Result<(), String> {
        self.with_resource_mut(lease, |slot| {
            if !slot.document_committed {
                return Err("browser document has not committed".to_string());
            }
            if let Some(url) = url {
                if slot.url != url {
                    slot.pointer_reference = None;
                }
                slot.url = url.to_string();
                slot.committed_url = Some(url.to_string());
            }
            if let Some(title) = title {
                slot.title = sanitize_text(title);
            }
            Ok(())
        })?
    }

    fn capture_resource(
        &self,
        session_id: &str,
    ) -> Result<(BrowserLease, SessionBrowserSnapshot), String> {
        let snapshot = self
            .get_snapshot(session_id)?
            .ok_or("this chat has no open browser")?;
        bind_model_resource(&snapshot.resource_id)?;
        Ok((BrowserLease::from_snapshot(&snapshot), snapshot))
    }
    fn with_slot_mut<R>(
        &self,
        session_id: &str,
        f: impl FnOnce(&mut SessionBrowserSlot) -> R,
    ) -> Result<R, String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "session browser state is unavailable".to_string())?;
        let slot = guard
            .get_mut(session_id)
            .ok_or_else(|| "this chat has no open browser".to_string())?;
        bind_model_resource(&slot.resource_id)?;
        Ok(f(slot))
    }

    fn snapshot_locked(slot: &SessionBrowserSlot) -> SessionBrowserSnapshot {
        SessionBrowserSnapshot {
            session_id: slot.session_id.clone(),
            workspace_key: slot.workspace_key.clone(),
            resource_id: slot.resource_id.clone(),
            url: slot.url.clone(),
            title: slot.title.clone(),
            loading: slot.loading,
            navigation_id: slot.navigation_id,
            document_committed: slot.document_committed,
            navigation_error: slot.navigation_error.clone(),
            visible: slot.visible,
            background_only: slot.background_only,
            label: slot.webview_label.clone(),
            viewport: slot.viewport,
        }
    }

    pub fn get_snapshot(&self, session_id: &str) -> Result<Option<SessionBrowserSnapshot>, String> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| "session browser state is unavailable".to_string())?;
        Ok(guard.get(session_id).map(Self::snapshot_locked))
    }

    pub fn require_owned(
        &self,
        session_id: &str,
        workspace_key: &str,
    ) -> Result<SessionBrowserSnapshot, String> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| "session browser state is unavailable".to_string())?;
        let slot = guard
            .get(session_id)
            .ok_or_else(|| "this chat has no open browser".to_string())?;
        if slot.workspace_key != workspace_key || slot.session_id != session_id {
            return Err("browser resource ownership changed".into());
        }
        Ok(Self::snapshot_locked(slot))
    }

    pub fn is_origin_approved(&self, session_id: &str, origin: &str) -> Result<bool, String> {
        self.with_slot_mut(session_id, |slot| slot.approved_origins.contains(origin))
    }

    pub fn approve_origin(&self, session_id: &str, origin: &str) -> Result<(), String> {
        self.with_slot_mut(session_id, |slot| {
            slot.approved_origins.insert(origin.to_string());
        })
    }

    pub fn remember_pointer_capture(
        &self,
        session_id: &str,
        capture_id: String,
        url: String,
        viewport: Value,
    ) -> Result<(), String> {
        self.with_slot_mut(session_id, |slot| {
            slot.pointer_reference = Some(BrowserPointerReference {
                capture_id,
                url,
                viewport,
                created_at: Instant::now(),
            });
        })
    }

    pub fn remember_pointer_capture_at_navigation(
        &self,
        session_id: &str,
        navigation_id: u64,
        capture_id: String,
        url: String,
        viewport: Value,
    ) -> Result<(), String> {
        let (lease, _) = self.capture_document(session_id)?;
        if lease.navigation_id != navigation_id {
            return Err("browser changed during capture; take a new screenshot".into());
        }
        self.with_document_mut(&lease, |slot| {
            slot.pointer_reference = Some(BrowserPointerReference {
                capture_id,
                url,
                viewport,
                created_at: Instant::now(),
            });
        })
    }

    pub fn pointer_reference(
        &self,
        session_id: &str,
        capture_id: &str,
    ) -> Result<BrowserPointerReference, String> {
        self.with_slot_mut(session_id, |slot| slot.pointer_reference.clone())?
            .filter(|reference| reference.capture_id == capture_id)
            .filter(|reference| reference.created_at.elapsed() <= Duration::from_secs(60))
            .ok_or_else(|| "browser screenshot is stale; capture the page again".to_string())
    }

    pub fn console_entries(
        &self,
        session_id: &str,
        limit: usize,
    ) -> Result<Vec<BrowserConsoleEntry>, String> {
        self.with_slot_mut(session_id, |slot| {
            slot.console
                .iter()
                .rev()
                .take(limit.clamp(1, MAX_CONSOLE_ENTRIES))
                .cloned()
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect()
        })
    }

    fn push_console(&self, lease: &BrowserLease, entry: BrowserConsoleEntry) -> Result<(), String> {
        self.with_resource_mut(lease, |slot| {
            if slot.console.len() >= MAX_CONSOLE_ENTRIES {
                slot.console.pop_front();
            }
            slot.console.push_back(entry);
        })
    }

    fn push_network(&self, lease: &BrowserLease, entry: BrowserNetworkEntry) -> Result<(), String> {
        self.with_resource_mut(lease, |slot| {
            if slot.network.len() >= MAX_NETWORK_ENTRIES {
                slot.network.pop_front();
            }
            slot.network.push_back(entry);
        })
    }

    fn webview_label_for(&self, session_id: &str) -> Result<String, String> {
        self.with_slot_mut(session_id, |slot| slot.webview_label.clone())
    }

    fn background_only(&self, session_id: &str) -> Result<bool, String> {
        self.with_slot_mut(session_id, |slot| slot.background_only)
    }

    fn set_url(&self, session_id: &str, url: &str) -> Result<(), String> {
        self.with_slot_mut(session_id, |slot| {
            if slot.url != url {
                slot.pointer_reference = None;
            }
            slot.url = url.to_string();
        })
    }

    fn set_title(&self, session_id: &str, title: &str) -> Result<(), String> {
        self.with_slot_mut(session_id, |slot| {
            slot.title = title.to_string();
        })
    }

    fn set_visible_flag(&self, session_id: &str, visible: bool) -> Result<(), String> {
        self.with_slot_mut(session_id, |slot| {
            slot.visible = browser_visibility(slot.background_only, visible);
        })
    }

    fn visible_flag(&self, session_id: &str) -> Result<bool, String> {
        self.with_slot_mut(session_id, |slot| slot.visible)
    }

    fn remove_slot(&self, session_id: &str) -> Result<Option<SessionBrowserSlot>, String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "session browser state is unavailable".to_string())?;
        Ok(guard.remove(session_id))
    }
}

/// A child webview shares the window with the chat UI, so the browser steals
/// the keyboard while it is being driven: AppKit makes a newly shown webview
/// first responder and leaves first responder on a view that is hidden. The
/// user keeps typing in a chat the model is not working in, so those keystrokes
/// disappear into a native view nobody is looking at. Give the keyboard back to
/// the app webview whenever a browser visibility change moved it.
fn restore_main_webview_focus<R: Runtime>(app: &AppHandle<R>) {
    if let Some(main) = app.get_webview(MAIN_WINDOW_LABEL) {
        let _ = main.set_focus();
    }
}

/// A hidden chat's browser can still end up holding the keyboard: WebKit moves
/// first responder while the model types into a field, takes a snapshot, or
/// loads a page with autofocus, and a child created hidden never handed it
/// back. The person is meanwhile typing in another chat, and every keystroke
/// lands in a view nobody can see. Unlike `restore_main_webview_focus`, this
/// only acts when the keyboard is stranded — on a hidden view, on the window
/// itself, or nowhere — so it never takes focus from a browser on screen.
fn reclaim_stranded_keyboard<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "macos")]
    if let Some(main) = app.get_webview(MAIN_WINDOW_LABEL) {
        let _ = main.with_webview(|platform| unsafe {
            use objc2_app_kit::NSView;
            let main_view: &NSView = &*platform.inner().cast();
            let Some(window) = main_view.window() else {
                return;
            };
            let stranded = match window.firstResponder() {
                None => true,
                // The window itself, the one non-view responder here, takes no
                // typing either.
                Some(responder) => responder
                    .downcast_ref::<NSView>()
                    .is_none_or(|view| view.isHiddenOrHasHiddenAncestor()),
            };
            if stranded {
                window.makeFirstResponder(Some(main_view));
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Only a visibility change can move the window's keyboard focus; repeated
/// requests for the state the browser is already in must leave the user alone.
fn visibility_moves_keyboard_focus(was_visible: bool, visible: bool) -> bool {
    was_visible != visible
}

fn browser_visibility(background_only: bool, requested_visible: bool) -> bool {
    !background_only && requested_visible
}

fn session_browser_is_background_only(
    store: &gyro_core::SessionStore,
    session_id: &str,
) -> Result<bool, String> {
    let session = store
        .get_session(crate::stores::parse_uuid(session_id)?)
        .map_err(crate::stores::to_string)?
        .ok_or_else(|| "browser chat no longer exists".to_string())?;
    Ok(session.parent_session_id.is_some())
}

/// Only the desktop IPC command accepts pre-chat workbench owners. Model tools
/// still enter through open_session_browser and require a durable chat UUID.
fn is_workbench_browser_request(request: &SessionBrowserOpenRequest) -> Result<bool, String> {
    if request.session_id == "workbench" {
        return request
            .workspace_key
            .is_empty()
            .then_some(true)
            .ok_or_else(|| "folderless browser ownership does not match its workspace".into());
    }
    let Some(workspace) = request.session_id.strip_prefix("workbench:") else {
        return Ok(false);
    };
    if workspace.is_empty()
        || workspace.len() > 4096
        || workspace != request.workspace_key
        || !std::path::Path::new(workspace).is_absolute()
    {
        return Err("workbench browser ownership does not match its workspace".into());
    }
    Ok(true)
}

fn browser_webview_label(owner: &str) -> String {
    if owner == "workbench" || owner.starts_with("workbench:") {
        // Paths can contain spaces, punctuation and Unicode. Native labels
        // must remain bounded and must not merge paths that differ by '-'.
        format!(
            "session-browser-workbench-{:x}",
            Sha256::digest(owner.as_bytes())
        )
    } else {
        format!("session-browser-{}", owner.replace('-', ""))
    }
}

pub fn is_background_browser<R: Runtime>(app: &AppHandle<R>, session_id: &str) -> bool {
    app.state::<SessionBrowserManager>()
        .get_snapshot(session_id)
        .ok()
        .flatten()
        .is_some_and(|snapshot| snapshot.background_only)
}

pub fn browser_url_is_navigable(url: &url::Url) -> bool {
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host().is_none()
    {
        return false;
    }
    true
}

fn resource_navigation_allowed(url: &url::Url, fixed_origin: Option<&str>) -> bool {
    browser_url_is_navigable(url)
        && fixed_origin.is_none_or(|origin| url.origin().ascii_serialization() == origin)
}

pub fn browser_url_is_loopback(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

pub fn parse_navigable_url(raw: &str) -> Result<url::Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("url is required".into());
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let url = url::Url::parse(&candidate).map_err(|_| "invalid browser URL".to_string())?;
    if !browser_url_is_navigable(&url) {
        return Err("browser URLs must be credential-free http or https with a host".into());
    }
    Ok(url)
}

fn truncate_chars(value: &str, max: usize) -> String {
    let mut out = String::new();
    for (index, ch) in value.chars().enumerate() {
        if index >= max {
            break;
        }
        out.push(ch);
    }
    out
}

fn sanitize_text(value: &str) -> String {
    truncate_chars(&redact_secrets(value.trim()), MAX_ENTRY_CHARS)
}

fn agent_initialization_script(bridge_nonce: &str) -> String {
    let nonce = serde_json::to_string(bridge_nonce).unwrap_or_else(|_| "\"\"".into());
    let background_pointer = include_str!("browser_background_pointer.js")
        .trim()
        .trim_end_matches(';');
    let pointer_feedback = include_str!("browser_pointer_feedback.js")
        .trim()
        .trim_end_matches(';');
    format!(
        r#"(function() {{
  if (window.__gyroBrowserAgentInstalled) return;
  window.__gyroBrowserAgentInstalled = true;
  const BRIDGE_NONCE = {nonce};
  const MAX_CONSOLE = {MAX_CONSOLE_ENTRIES};
  const MAX_NETWORK = {MAX_NETWORK_ENTRIES};
  const MAX_MSG = {MAX_ENTRY_CHARS};
  const consoleBuf = [];
  const networkBuf = [];
  let refCounter = 0;
  const refPrefix = "ref_" + Math.random().toString(36).slice(2) + "_";
  const refMap = new Map();

  const textOf = (value) => {{
    try {{
      if (value instanceof Error) return value.message || value.name || "Error";
      if (typeof value === "string") return value;
      const encoded = JSON.stringify(value);
      return encoded === undefined ? String(value) : encoded;
    }} catch (_) {{
      return String(value);
    }}
  }};

  const originalFetch = window.fetch.bind(window);
  const postBridge = (payload) => {{
    try {{
      const body = JSON.stringify(Object.assign({{ nonce: BRIDGE_NONCE }}, payload));
      originalFetch("gyro-bridge://call", {{
        method: "POST",
        headers: {{ "content-type": "application/json" }},
        body,
        mode: "cors",
        credentials: "omit",
        keepalive: true,
      }}).catch(() => {{}});
    }} catch (_) {{}}
  }};

  const pushConsole = (kind, values, source, line, column) => {{
    const message = values.map(textOf).join(" ").slice(0, MAX_MSG);
    if (!message) return;
    const entry = {{
      kind,
      message,
      source: typeof source === "string" ? source : null,
      line: Number.isFinite(line) ? line : null,
      column: Number.isFinite(column) ? column : null,
    }};
    if (consoleBuf.length >= MAX_CONSOLE) consoleBuf.shift();
    consoleBuf.push(entry);
    postBridge({{ kind: "console", entry }});
  }};

  const original = {{
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  }};
  console.log = (...v) => {{ pushConsole("log", v); original.log(...v); }};
  console.info = (...v) => {{ pushConsole("info", v); original.info(...v); }};
  console.warn = (...v) => {{ pushConsole("warn", v); original.warn(...v); }};
  console.error = (...v) => {{ pushConsole("console-error", v); original.error(...v); }};
  console.debug = (...v) => {{ pushConsole("debug", v); original.debug(...v); }};
  addEventListener("error", (event) => {{
    pushConsole("page-error", [event.message || "Page error"], event.filename, event.lineno, event.colno);
  }}, true);
  addEventListener("unhandledrejection", (event) => {{
    pushConsole("unhandled-rejection", [event.reason || "Unhandled promise rejection"]);
  }}, true);

  const recordNetwork = (entry) => {{
    if (networkBuf.length >= MAX_NETWORK) networkBuf.shift();
    networkBuf.push(entry);
    postBridge({{ kind: "network", entry }});
  }};

  window.fetch = async function(input, init) {{
    const method = (init && init.method) || (input && input.method) || "GET";
    let url = "";
    try {{
      url = typeof input === "string" ? input : (input && input.url) || String(input);
    }} catch (_) {{
      url = "unknown";
    }}
    try {{
      const response = await originalFetch(input, init);
      recordNetwork({{
        method: String(method).toUpperCase(),
        url: String(url).slice(0, MAX_MSG),
        status: response.status,
        ok: response.ok,
        resourceType: "fetch",
      }});
      return response;
    }} catch (error) {{
      recordNetwork({{
        method: String(method).toUpperCase(),
        url: String(url).slice(0, MAX_MSG),
        status: null,
        ok: false,
        resourceType: "fetch",
      }});
      throw error;
    }}
  }};

  const XO = window.XMLHttpRequest;
  if (XO) {{
    const open = XO.prototype.open;
    const send = XO.prototype.send;
    XO.prototype.open = function(method, url) {{
      this.__gyroMethod = method;
      this.__gyroUrl = url;
      return open.apply(this, arguments);
    }};
    XO.prototype.send = function() {{
      this.addEventListener("loadend", () => {{
        recordNetwork({{
          method: String(this.__gyroMethod || "GET").toUpperCase(),
          url: String(this.__gyroUrl || "").slice(0, MAX_MSG),
          status: this.status || null,
          ok: this.status >= 200 && this.status < 400,
          resourceType: "xhr",
        }});
      }});
      return send.apply(this, arguments);
    }};
  }}

  const isVisible = (el) => {{
    if (!el || el.nodeType !== 1) return false;
    const style = window.getComputedStyle(el);
    if (!style || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {{
      return false;
    }}
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }};

  const roleOf = (el) => {{
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "input") {{
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button") return "button";
      return "textbox";
    }}
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "img") return "img";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "nav") return "navigation";
    if (tag === "main") return "main";
    if (tag === "header") return "banner";
    if (tag === "footer") return "contentinfo";
    return tag;
  }};

  const nameOf = (el, includeContents = true) => {{
    const labelledBy = (el.getAttribute("aria-labelledby") || "").trim().split(/\s+/)
      .map(id => document.getElementById(id))
      .filter(Boolean)
      .map(label => label.textContent || "").join(" ").trim();
    const labelled = labelledBy || el.getAttribute("aria-label")
      || (el.labels ? Array.from(el.labels, label => label.textContent || "").join(" ") : "")
      || el.getAttribute("alt")
      || el.getAttribute("title")
      || el.getAttribute("placeholder")
      || "";
    if (labelled) return labelled.replace(/\s+/g, " ").trim().slice(0, 120);
    if (!includeContents) return "";
    const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    return text.slice(0, 120);
  }};

  const targetName = (el) => {{
    return (nameOf(el) || el.getAttribute("name") || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
  }};

  const isCredentialField = (el) => {{
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName.toLowerCase();
    if (tag !== "input") return false;
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "password") return true;
    const name = ((el.getAttribute("name") || "") + " " + (el.getAttribute("autocomplete") || "") + " " + (el.getAttribute("id") || "")).toLowerCase();
    return /password|passwd|pwd|one-time|otp|totp|2fa|credit.?card|cc-number|cvc|cvv|ssn/.test(name);
  }};

  const assignRef = (el) => {{
    if (!el) return null;
    if (!el.__gyroRef || !el.__gyroRef.startsWith(refPrefix)) {{
      refCounter += 1;
      el.__gyroRef = refPrefix + refCounter;
    }}
    const ref = el.__gyroRef;
    refMap.delete(ref);
    refMap.set(ref, el);
    // Bound retained DOM nodes on long-lived pages; recently observed refs survive.
    if (refMap.size > 4096) refMap.delete(refMap.keys().next().value);
    return ref;
  }};

  const pruneRefs = () => {{
    for (const [ref, el] of refMap) if (!el.isConnected) refMap.delete(ref);
  }};

  const resolveRef = (ref) => {{
    if (!ref || typeof ref !== "string") return null;
    const el = refMap.get(ref);
    if (el && el.isConnected) return el;
    refMap.delete(ref);
    return null;
  }};

  const pageState = () => ({{
    url: location.href,
    title: (document.title || "").slice(0, 400),
    titleTruncated: (document.title || "").length > 400,
    readyState: document.readyState,
    viewport: {{
      width: Math.max(0, Math.round(window.innerWidth || 0)),
      height: Math.max(0, Math.round(window.innerHeight || 0)),
      deviceScaleFactor: Number(window.devicePixelRatio || 1),
      scrollX: Math.round(window.scrollX || 0),
      scrollY: Math.round(window.scrollY || 0),
    }},
    history: {{ length: Math.max(0, Number(window.history.length || 0)) }},
  }});

  const serializeTree = (root, depth, maxDepth, budget) => {{
    if (!root || depth > maxDepth || budget.left <= 0) return null;
    budget.visited = (budget.visited || 0) + 1;
    if (budget.visited > 5000) {{ budget.truncated = true; budget.exhausted = true; return null; }}
    if (root.nodeType === 3) {{
      const text = (root.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) return null;
      budget.left -= text.length;
      if (text.length > 200) budget.truncated = true;
      return {{ type: "text", text: text.slice(0, 200) }};
    }}
    if (root.nodeType !== 1) return null;
    const el = root;
    if (!isVisible(el) && depth > 0) return null;
    const tag = el.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "noscript" || tag === "svg") return null;
    const ref = assignRef(el);
    const expandedWrapper = depth < maxDepth && el.childNodes.length > 0
      && ["body", "div", "section", "main", "article", "nav", "header", "footer", "aside"].includes(tag);
    const node = {{
      ref,
      role: roleOf(el),
      // Do not traverse a whole subtree for a wrapper name we would then discard.
      name: nameOf(el, !expandedWrapper),
      tag,
      children: [],
    }};
    if (el.getAttribute("href")) node.href = String(el.getAttribute("href")).slice(0, 200);
    if (el.getAttribute("type")) node.inputType = el.getAttribute("type");
    if (tag === "input" || tag === "textarea" || tag === "select") {{
      node.value = isCredentialField(el) ? "[redacted-credential]" : String(el.value || "").slice(0, 120);
    }}
    // Retain the existing traversal budget: deduplication must not hide more of the page.
    budget.left -= 64;
    if (depth >= maxDepth) {{
      if (el.childNodes.length) budget.truncated = true;
      return node;
    }}
    const children = el.childNodes;
    let i = 0;
    for (; i < children.length && budget.left > 0 && !budget.exhausted && node.children.length < 40; i++) {{
      const child = serializeTree(children[i], depth + 1, maxDepth, budget);
      if (child) node.children.push(child);
    }}
    if (i < children.length) budget.truncated = true;
    if (node.children.length === 0) delete node.children;
    // Expanded layout wrappers repeat all descendant text as their name.
    // Keep labels and leaf summaries, but send that prose only once.
    if (node.children && expandedWrapper
        && !el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby") && !el.getAttribute("title")) delete node.name;
    if (node.children && node.children.length === 1 && node.children[0].type === "text"
        && node.children[0].text === node.name) delete node.children;
    if (!node.name) delete node.name;
    return node;
  }};

  const dispatch = (el, type, init) => {{
    const EventClass = type.startsWith("key") ? KeyboardEvent : Event;
    const event = new EventClass(type, Object.assign({{ bubbles: true, cancelable: true }}, init || {{}}));
    el.dispatchEvent(event);
  }};

  const clickEl = (el, options) => {{
    el.scrollIntoView({{ block: "center", inline: "nearest", behavior: "instant" }});
    flashTarget(el, Object.assign({{}}, options, {{ action: "click" }}));
    ["pointerdown", "mousedown", "pointerup", "mouseup"].forEach((type) => {{
      const EventClass = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      el.dispatchEvent(new EventClass(type, {{ bubbles: true, cancelable: true, view: window }}));
    }});
    if (typeof el.click === "function") el.click();
    else el.dispatchEvent(new MouseEvent("click", {{ bubbles: true, cancelable: true, view: window }}));
  }};

  const typeInto = (el, text, submit) => {{
    if (isCredentialField(el)) {{
      return {{ ok: false, error: "credential fields are not writable by the model" }};
    }}
    if (el.matches(":disabled") || el.readOnly || el.getAttribute("aria-disabled") === "true" ||
        !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) {{
      return {{ ok: false, error: "target is not an editable text field" }};
    }}
    el.focus();
    const value = String(text ?? "");
    if ("value" in el) {{
      const proto = el.tagName.toLowerCase() === "textarea"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      if (descriptor && descriptor.set) descriptor.set.call(el, value);
      else el.value = value;
    }} else if (el.isContentEditable) {{
      el.textContent = value;
    }}
    dispatch(el, "input");
    dispatch(el, "change");
    if (submit) {{
      dispatch(el, "keydown", {{ key: "Enter", code: "Enter", keyCode: 13 }});
      const form = el.form || el.closest("form");
      if (form && typeof form.requestSubmit === "function") form.requestSubmit();
    }}
    return {{ ok: true }};
  }};

  const pointerFeedback = {pointer_feedback}(window, document);
  const clearHighlight = () => pointerFeedback.clear();
  const flashTarget = (el, options = {{}}) => pointerFeedback.show(el, options);

  window.__gyroBrowserAgent = {{
    clearHighlight() {{
      clearHighlight();
      return {{ ok: true }};
    }},
    hidePointer() {{
      pointerFeedback.setHidden(true);
      return {{ ok: true }};
    }},
    restorePointer() {{
      pointerFeedback.setHidden(false);
      return {{ ok: true }};
    }},
    showPointer(options) {{
      // A click may already have navigated. Never paint old coordinates on a new page.
      if (options.url !== location.href) return {{ ok: true }};
      const dragging = options.action === "drag" && options.phase !== "move";
      const el = document.elementFromPoint(dragging ? options.toX : options.x, dragging ? options.toY : options.y);
      if (el) flashTarget(el, options);
      return {{ ok: true }};
    }},
    readPage(options) {{
      const root = options && options.ref ? resolveRef(options.ref) : (document.body || document.documentElement);
      if (!root) return {{ ok: false, error: "element ref is stale; use find to locate it again" }};
      pruneRefs();
      const maxDepth = Math.min(8, Math.max(1, (options && options.maxDepth) || 4));
      const maxChars = Math.min({MAX_TREE_CHARS}, Math.max(1024, (options && options.maxChars) || 6000));
      const budget = {{ left: maxChars }};
      const tree = serializeTree(root, 0, maxDepth, budget);
      return Object.assign({{
        ok: true,
        framing: "OBSERVED_PAGE_CONTENT_UNTRUSTED",
        tree,
        truncated: budget.left <= 0 || !!budget.truncated,
      }}, pageState());
    }},
    // Local Check reads only the explicitly reviewed visible text/count/height.
    // There is no user-supplied JavaScript and no input value/HTML reader.
    checkRead(options) {{
      const reads = options && options.reads;
      if (!Array.isArray(reads) || reads.length < 1 || reads.length > 4) return {{ ok:false, error:"invalid Check reads" }};
      const values = Object.create(null);
      let roots;
      try {{ roots = Array.from(document.querySelectorAll(options.readySelector)).filter(isVisible); }}
      catch (_) {{ return {{ok:false,error:"invalid Check ready selector"}}; }}
      if (roots.length !== 1) return {{ok:false,error:"expected Check page is unavailable"}};
      for (const read of reads) {{
        let matches;
        try {{ matches = Array.from(document.querySelectorAll(read.selector)).filter(isVisible); }}
        catch (_) {{ return {{ ok:false, error:"invalid Check selector" }}; }}
        if (matches.length > 1000 || matches.some(isCredentialField)) return {{ ok:false, error:"Check read is protected or too large" }};
        if (read.kind === "count") values[read.key] = matches.length;
        else if (read.kind === "texts") {{
          if (matches.length > 20) return {{ok:false,error:"too many Check text elements"}};
          const texts = matches.map(el => (el.innerText || "").trim());
          if (JSON.stringify(texts).length > 2000) return {{ok:false,error:"Check text is too large"}};
          values[read.key] = texts;
        }}
        else if (read.kind === "height" && matches.length === 1) {{
          const height = matches[0].getBoundingClientRect().height;
          if (!Number.isFinite(height) || height <= 0 || height > 100000) return {{ok:false,error:"invalid Check height"}};
          values[read.key] = height;
        }}
        else if (read.kind === "text" && matches.length === 1) {{
          const text = (matches[0].innerText || "").trim();
          if (text.length > 2000) return {{ ok:false, error:"Check text is too large" }};
          values[read.key] = text;
        }} else return {{ ok:false, error:"Check text/height read needs exactly one visible element and a supported kind" }};
      }}
      return Object.assign({{ok:true, values}},pageState());
    }},
    find(options) {{
      pruneRefs();
      const query = ((options && options.query) || "").trim();
      const selector = ((options && options.selector) || "").trim();
      const results = [];
      const limit = Math.min({MAX_FIND_RESULTS}, Math.max(1, (options && options.limit) || 20));
      const offset = Math.max(0, (options && options.offset) || 0);
      let matched = 0;
      let candidates = [];
      if (selector) {{
        try {{ candidates = Array.from(document.querySelectorAll(selector)); }}
        catch (error) {{ return {{ ok: false, error: "invalid selector" }}; }}
      }} else {{
        candidates = Array.from(document.querySelectorAll("a,button,input,textarea,select,[role],[onclick],h1,h2,h3,h4,h5,h6,label,summary"));
      }}
      const needle = query.toLowerCase();
      for (const el of candidates) {{
        if (!isVisible(el)) continue;
        const name = nameOf(el);
        if (needle && !name.toLowerCase().includes(needle) && !(el.innerText || "").toLowerCase().includes(needle)) {{
          continue;
        }}
        if (matched++ < offset) continue;
        const rect = el.getBoundingClientRect();
        results.push({{
          ref: assignRef(el),
          role: roleOf(el),
          name,
          tag: el.tagName.toLowerCase(),
          rect: {{
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          }},
        }});
        if (results.length > limit) break;
      }}
      const hasMore = results.length > limit;
      if (hasMore) results.pop();
      return {{ ok: true, framing: "OBSERVED_PAGE_CONTENT_UNTRUSTED", results, offset, hasMore, nextOffset: hasMore ? offset + results.length : null }};
    }},
    pointerTarget(options) {{
      const x = Number(options && options.x);
      const y = Number(options && options.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)
          || x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {{
        return {{ ok: false, error: "pointer coordinates are outside the browser viewport" }};
      }}
      const hit = document.elementFromPoint(x, y);
      if (!hit) return {{ ok: false, error: "no page target at pointer coordinates" }};
      const el = hit.closest("a,button,input,textarea,select,[role],[onclick],form") || hit;
      const name = targetName(el);
      const form = el.closest("form");
      const formName = form ? targetName(form) : "";
      const sensitive = /\b(buy|checkout|purchase|pay|send|submit|publish|delete|remove|transfer|book|confirm)\b/i.test(name + " " + formName);
      return {{
        ok: true,
        name,
        role: roleOf(el),
        tag: el.tagName.toLowerCase(),
        blocked: isCredentialField(el) || el.tagName.toLowerCase() === "iframe",
        blockedReason: el.tagName.toLowerCase() === "iframe"
          ? "embedded frames need user takeover in the Browser"
          : "credential fields cannot be targeted by the model",
        sensitive,
        url: location.href,
        viewport: pageState().viewport,
      }};
    }},
        click(options) {{
      const el = resolveRef(options && options.ref);
      if (!el) return {{ ok: false, error: "unknown or stale ref" }};
      if (!isVisible(el) || el.matches(":disabled") || el.getAttribute("aria-disabled") === "true") {{
        return {{ ok: false, error: "target is hidden or disabled" }};
      }}
      clickEl(el, options);
      return {{ ok: true, ref: options.ref, name: targetName(el) }};
    }},
    type(options) {{
      const el = options && options.ref ? resolveRef(options.ref) : document.activeElement;
      if (!el) return {{ ok: false, error: "no target element" }};
      const typed = Object.assign({{ ref: el.__gyroRef || null, name: targetName(el) }}, typeInto(el, options && options.text, !!(options && options.submit)));
      if (typed.ok) flashTarget(el, options);
      return typed;
    }},
    formInput(options) {{
      const el = resolveRef(options && options.ref);
      if (!el) return {{ ok: false, error: "unknown or stale ref" }};
      if (el.matches(":disabled") || el.readOnly || el.getAttribute("aria-disabled") === "true") {{
        return {{ ok: false, error: "target is disabled or read-only" }};
      }}
      if (isCredentialField(el)) {{
        return {{ ok: false, error: "credential fields are not writable by the model" }};
      }}
      const name = targetName(el);
      flashTarget(el, options);
      const value = String((options && options.value) ?? "");
      if (el.tagName.toLowerCase() === "select") {{
        const option = Array.from(el.options).find(option => option.value === value);
        if (!option || option.disabled || (option.parentElement.tagName === "OPTGROUP" && option.parentElement.disabled)) {{
          return {{ ok: false, error: "select option is unavailable" }};
        }}
        el.value = value;
        dispatch(el, "input");
        dispatch(el, "change");
        return {{ ok: true, ref: options.ref, name }};
      }}
      if (el.tagName.toLowerCase() === "input") {{
        const type = (el.getAttribute("type") || "text").toLowerCase();
        if (type === "checkbox" || type === "radio") {{
          el.checked = value === "true" || value === "1" || value === "on" || value === "checked";
          dispatch(el, "input");
          dispatch(el, "change");
          return {{ ok: true, ref: options.ref, name }};
        }}
      }}
      return Object.assign({{ ref: options.ref, name }}, typeInto(el, value, false));
    }},
    scroll(options) {{
      const dx = Number((options && options.dx) || 0);
      const dy = Number((options && options.dy) || 0);
      const el = options && options.ref ? resolveRef(options.ref) : null;
      if (options && options.ref && !el) return {{ ok: false, error: "unknown or stale ref" }};
      if (el) {{
        el.scrollBy({{ left: dx, top: dy, behavior: "instant" }});
      }} else {{
        window.scrollBy({{ left: dx, top: dy, behavior: "instant" }});
      }}
      return {{ ok: true, dx, dy }};
    }},
    console(options) {{
      const limit = Math.min(MAX_CONSOLE, Math.max(1, (options && options.limit) || 20));
      const offset = Math.max(0, (options && options.offset) || 0);
      const entries = consoleBuf.slice().reverse().slice(offset, offset + limit);
      return {{ ok: true, framing: "OBSERVED_PAGE_CONTENT_UNTRUSTED", entries, offset, total: consoleBuf.length, order: "newest-first" }};
    }},
    network(options) {{
      const limit = Math.min(MAX_NETWORK, Math.max(1, (options && options.limit) || 20));
      const offset = Math.max(0, (options && options.offset) || 0);
      const entries = networkBuf.slice().reverse().slice(offset, offset + limit);
      return {{ ok: true, framing: "OBSERVED_PAGE_CONTENT_UNTRUSTED", entries, offset, total: networkBuf.length, order: "newest-first" }};
    }},
    status() {{
      return Object.assign({{ ok: true }}, pageState());
    }},
  }};
  window.__gyroBrowserAgent.backgroundPointer = {background_pointer}(window.__gyroBrowserAgent, window, document);
}})();"#
    )
}

fn cors_response(status: u16, body: impl Into<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("access-control-allow-origin", "*")
        .header("access-control-allow-methods", "POST, OPTIONS")
        .header("access-control-allow-headers", "content-type")
        .header("content-type", "application/json")
        .body(body.into())
        .unwrap_or_else(|_| {
            tauri::http::Response::builder()
                .status(500)
                .body(b"{}".to_vec())
                .expect("fallback response")
        })
}

pub fn register_bridge_protocol<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol(BRIDGE_SCHEME, |ctx, request, responder| {
        if request.method() == tauri::http::Method::OPTIONS {
            responder.respond(cors_response(204, Vec::new()));
            return;
        }
        if request.method() != tauri::http::Method::POST {
            responder.respond(cors_response(
                405,
                br#"{"ok":false,"error":"method"}"#.to_vec(),
            ));
            return;
        }
        let app = ctx.app_handle().clone();
        let body = request.into_body();
        // Chatty pages post a message per log line and request; the shared
        // blocking pool reuses threads instead of spawning one per message.
        tauri::async_runtime::spawn_blocking(move || {
            let result = handle_bridge_body(&app, &body);
            match result {
                Ok(()) => responder.respond(cors_response(200, br#"{"ok":true}"#.to_vec())),
                Err(error) => {
                    let payload = serde_json::json!({ "ok": false, "error": error });
                    responder.respond(cors_response(
                        400,
                        serde_json::to_vec(&payload).unwrap_or_else(|_| b"{}".to_vec()),
                    ));
                }
            }
        });
    })
}

fn handle_bridge_body<R: Runtime>(app: &AppHandle<R>, body: &[u8]) -> Result<(), String> {
    let value: Value =
        serde_json::from_slice(body).map_err(|_| "invalid bridge payload".to_string())?;
    let nonce = value
        .get("nonce")
        .and_then(Value::as_str)
        .ok_or_else(|| "bridge nonce missing".to_string())?;
    let manager = app.state::<SessionBrowserManager>();
    let lease = {
        let guard = manager
            .inner
            .lock()
            .map_err(|_| "session browser state is unavailable".to_string())?;
        guard
            .values()
            .find(|slot| slot.bridge_nonce == nonce)
            .map(|slot| BrowserLease {
                session_id: slot.session_id.clone(),
                resource_id: slot.resource_id.clone(),
            })
            .ok_or_else(|| "unknown bridge nonce".to_string())?
    };
    let session_id = lease.session_id.clone();

    let kind = value.get("kind").and_then(Value::as_str).unwrap_or("");
    match kind {
        "console" => {
            if let Some(entry) = value.get("entry") {
                let message = entry
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                manager.push_console(
                    &lease,
                    BrowserConsoleEntry {
                        kind: entry
                            .get("kind")
                            .and_then(Value::as_str)
                            .unwrap_or("log")
                            .to_string(),
                        message: sanitize_text(&message),
                        source: entry
                            .get("source")
                            .and_then(Value::as_str)
                            .map(sanitize_text),
                        line: entry.get("line").and_then(Value::as_i64),
                        column: entry.get("column").and_then(Value::as_i64),
                    },
                )?;
            }
        }
        "network" => {
            if let Some(entry) = value.get("entry") {
                manager.push_network(
                    &lease,
                    BrowserNetworkEntry {
                        method: entry
                            .get("method")
                            .and_then(Value::as_str)
                            .unwrap_or("GET")
                            .to_string(),
                        url: sanitize_text(entry.get("url").and_then(Value::as_str).unwrap_or("")),
                        status: entry.get("status").and_then(Value::as_i64),
                        ok: entry.get("ok").and_then(Value::as_bool),
                        resource_type: entry
                            .get("resourceType")
                            .and_then(Value::as_str)
                            .map(|value| value.to_string()),
                    },
                )?;
            }
        }
        "title" => {
            manager.update_resource_state(
                &lease,
                value.get("url").and_then(Value::as_str),
                value.get("title").and_then(Value::as_str),
            )?;
        }
        _ => {}
    }
    // Console and network entries are read on demand from the buffers above;
    // broadcasting each one only wakes every window for nothing.
    if !matches!(kind, "console" | "network")
        && lease.validate(&manager).is_ok()
        && !is_background_browser(app, &session_id)
    {
        let _ = app.emit(
            "session-browser-event",
            serde_json::json!({ "sessionId": session_id, "resourceId":lease.resource_id, "kind": kind }),
        );
    }
    Ok(())
}

fn get_main_window<R: Runtime>(app: &AppHandle<R>) -> Result<tauri::Window<R>, String> {
    app.get_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "main window is not available".to_string())
}

fn apply_session_browser_layout<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    host: Option<SessionBrowserBounds>,
    request: Option<BrowserViewportRequest>,
) -> Result<SessionBrowserSnapshot, String> {
    apply_session_browser_layout_for(app, session_id, host, request, None)
}

fn apply_session_browser_layout_for<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    host: Option<SessionBrowserBounds>,
    request: Option<BrowserViewportRequest>,
    expected: Option<&BrowserLease>,
) -> Result<SessionBrowserSnapshot, String> {
    let manager = app.state::<SessionBrowserManager>();
    // Serialize load events, model choices, and UI resize reports so an older
    // layout cannot overwrite a newer request after its native apply completes.
    let _layout = manager
        .layout
        .lock()
        .map_err(|_| "browser layout is unavailable")?;
    let (lease, label, host, request, url, previous) =
        manager.with_slot_mut(session_id, |slot| {
            if expected.is_some_and(|lease| lease.resource_id != slot.resource_id) {
                return Err("browser resource changed before layout".to_string());
            }
            Ok((
                BrowserLease {
                    session_id: session_id.into(),
                    resource_id: slot.resource_id.clone(),
                },
                slot.webview_label.clone(),
                host.unwrap_or_else(|| slot.host_bounds.clone()),
                request.unwrap_or(slot.viewport_request),
                slot.url.clone(),
                slot.viewport,
            ))
        })??;
    let geometry = browser_viewport::geometry(request, &url, &host)?;
    let webview = app
        .get_webview(&label)
        .ok_or("browser webview is not available")?;
    browser_viewport::apply(&webview, &geometry, Some(previous), Some(lease.clone()))?;
    let changed = manager.with_resource_mut(&lease, |slot| {
        let changed = slot.viewport != geometry.state;
        if slot.viewport.width != geometry.state.width
            || slot.viewport.height != geometry.state.height
        {
            slot.pointer_reference = None;
        }
        slot.host_bounds = host;
        slot.viewport_request = request;
        slot.viewport = geometry.state;
        changed
    })?;
    let snapshot = manager
        .get_snapshot(session_id)?
        .ok_or("browser disappeared during resize")?;
    if snapshot.resource_id != lease.resource_id {
        return Err("browser resource changed during layout".into());
    }
    if changed && !snapshot.background_only {
        let _ = app.emit(
            "session-browser-event",
            serde_json::json!({
                "sessionId":session_id,"resourceId":snapshot.resource_id,"kind":"viewport","viewport":snapshot.viewport,
            }),
        );
    }
    Ok(snapshot)
}

pub fn set_session_browser_viewport<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    request: BrowserViewportRequest,
) -> Result<SessionBrowserSnapshot, String> {
    let request = request.normalized();
    request.validate()?;
    apply_session_browser_layout(app, session_id, None, Some(request))
}

pub fn open_session_browser<R: Runtime>(
    app: &AppHandle<R>,
    mut request: SessionBrowserOpenRequest,
) -> Result<SessionBrowserSnapshot, String> {
    // Ownership comes from the durable chat relationship, never a tool/UI
    // argument. A restored agent gets the same private browser on follow-up.
    let store = crate::stores::open_store()?;
    let background_only = session_browser_is_background_only(&store, &request.session_id)?;
    drop(store);
    if background_only {
        request.bounds = None;
        request.visible = Some(false);
    }
    open_browser_resource(app, request, background_only, None)
}

/// Only the human Check resolver calls this, after consuming approval and
/// revalidating workspace/files. It cannot reuse or replace a chat browser.
pub(crate) fn open_check_browser<R: Runtime>(
    app: &AppHandle<R>,
    plan: &gyro_core::local_check::CheckPlan,
) -> Result<String, String> {
    plan.draft.validate().map_err(|error| error.to_string())?;
    let id = format!("check-{}", plan.id);
    let url = parse_navigable_url(&plan.draft.preview_url)?;
    if !browser_url_is_loopback(&url) {
        return Err("Check requires a loopback page".into());
    }
    let opened = open_browser_resource(
        app,
        SessionBrowserOpenRequest {
            session_id: id.clone(),
            workspace_key: plan.snapshot.workspace.display().to_string(),
            url: plan.draft.preview_url.clone(),
            bounds: plan
                .draft
                .browser
                .as_ref()
                .and_then(|browser| browser.viewport.as_ref())
                .map(|viewport| SessionBrowserBounds {
                    x: -(viewport.width as f64) - 1.0,
                    y: AGENT_BROWSER_BOUNDS.y,
                    width: viewport.width as f64,
                    height: viewport.height as f64,
                }),
            visible: Some(false),
        },
        true,
        Some(url.origin().ascii_serialization()),
    );
    if let Err(error) = opened {
        if let Some(view) = app.get_webview(&browser_webview_label(&id)) {
            let _ = close_browser_webview(&view);
        }
        return Err(error);
    }
    Ok(id)
}

pub(crate) fn close_check_browser<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
    let manager = app.state::<SessionBrowserManager>();
    let label = manager.webview_label_for(id)?;
    if let Some(view) = app.get_webview(&label) {
        close_browser_webview(&view).map_err(|e| format!("could not close Check browser: {e}"))?;
    }
    manager.remove_slot(id)?;
    Ok(())
}

fn resource_viewport_request(
    check_only: bool,
    bounds: &SessionBrowserBounds,
) -> BrowserViewportRequest {
    if check_only {
        // Auto resolves loopback pages to 1280x800 even in a larger host.
        // Preserve reviewed Check dimensions explicitly, including on reload.
        BrowserViewportRequest {
            mode: browser_viewport::BrowserViewportMode::Desktop,
            width: Some(bounds.width as u32),
            height: Some(bounds.height as u32),
        }
    } else {
        BrowserViewportRequest::default()
    }
}

fn open_browser_resource<R: Runtime>(
    app: &AppHandle<R>,
    request: SessionBrowserOpenRequest,
    background_only: bool,
    fixed_origin: Option<String>,
) -> Result<SessionBrowserSnapshot, String> {
    let url = parse_navigable_url(&request.url)?;
    let origin = url.origin().ascii_serialization();
    let manager = app.state::<SessionBrowserManager>();

    if let Ok(Some(existing)) = manager.get_snapshot(&request.session_id) {
        if existing.workspace_key != request.workspace_key {
            return Err("browser resource ownership changed".into());
        }
        let label = manager.webview_label_for(&request.session_id)?;
        if let Some(webview) = app.get_webview(&label) {
            let lease = BrowserLease::from_snapshot(&existing);
            let navigation = manager.reserve_navigation(&lease, Some(url.as_str()))?;
            dispatch_browser_navigation(
                app,
                &webview,
                &navigation,
                BrowserNavigationCommand::Navigate(url.clone()),
            )?;
            apply_session_browser_layout_for(
                app,
                &request.session_id,
                request.bounds.clone(),
                None,
                Some(&lease),
            )?;
            let visible =
                browser_visibility(background_only, request.visible.unwrap_or(existing.visible));
            let was_visible = existing.visible;
            if visible {
                let _ = webview.show();
            } else {
                let _ = webview.hide();
            }
            manager.set_visible_flag(&request.session_id, visible)?;
            if visibility_moves_keyboard_focus(was_visible, visible) {
                restore_main_webview_focus(app);
            }
            let _ = manager.approve_origin(&request.session_id, &origin);
            return manager
                .get_snapshot(&request.session_id)?
                .ok_or_else(|| "browser disappeared during open".to_string());
        }
    }

    let session_id = request.session_id.clone();
    let resource_id = Uuid::new_v4().to_string();
    let bridge_nonce = Uuid::new_v4().to_string();
    let webview_label = browser_webview_label(&session_id);
    let script = agent_initialization_script(&bridge_nonce);

    // Close any stale webview with the same label.
    if let Some(existing) = app.get_webview(&webview_label) {
        let _ = close_browser_webview(&existing);
    }

    let window = get_main_window(app)?;
    let session_for_title = session_id.clone();
    let app_for_title = app.clone();
    #[cfg(not(target_os = "macos"))]
    let session_for_load = session_id.clone();
    #[cfg(not(target_os = "macos"))]
    let app_for_load = app.clone();
    let resource_for_load = BrowserLease {
        session_id: session_id.clone(),
        resource_id: resource_id.clone(),
    };
    let resource_for_title = resource_for_load.clone();
    #[cfg(target_os = "macos")]
    let resource_for_observer = resource_for_load.clone();
    // A model opens the browser with no bounds, because nothing is on screen
    // for it. It still needs a real viewport: the page runs at the child's
    // size, so a 1x1 child reported window.innerWidth 1, collapsed every
    // layout the model then read, put every element outside the viewport, and
    // captured a 1x1 screenshot. Size it like a desktop window and leave it
    // hidden — the mounted UI host replaces these bounds if it ever opens.
    let requested_bounds = request.bounds.clone();
    let bounds = requested_bounds
        .clone()
        .unwrap_or(BACKGROUND_BROWSER_BOUNDS);
    let bounds = if background_only {
        if fixed_origin.is_some() {
            requested_bounds.clone().unwrap_or(AGENT_BROWSER_BOUNDS)
        } else {
            AGENT_BROWSER_BOUNDS
        }
    } else {
        bounds
    };
    let visible = request.visible.unwrap_or(
        requested_bounds.is_some_and(|bounds| bounds.width >= 2.0 && bounds.height >= 2.0),
    );
    let check_only = fixed_origin.is_some();
    let viewport_request = resource_viewport_request(check_only, &bounds);
    let geometry = browser_viewport::geometry(viewport_request, url.as_str(), &bounds)?;

    let mut builder = tauri::WebviewBuilder::new(&webview_label, WebviewUrl::External(url.clone()))
        .initialization_script(script)
        .incognito(true)
        .devtools(false)
        .on_navigation(move |candidate| {
            resource_navigation_allowed(candidate, fixed_origin.as_deref())
        })
        .on_page_load(move |_webview, _payload| {
            #[cfg(not(target_os = "macos"))]
            let payload = _payload;
            #[cfg(not(target_os = "macos"))]
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                let manager = app_for_load.state::<SessionBrowserManager>();
                if manager
                    .commit_navigation(&resource_for_load, payload.url().as_str())
                    .is_ok()
                    && !background_only
                {
                    let _ = app_for_load.emit("session-browser-event", serde_json::json!({
                        "sessionId": session_for_load, "resourceId": resource_for_load.resource_id,
                        "kind": "loading",
                    }));
                }
            } else if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let app = app_for_load.clone();
                let session_id = session_for_load.clone();
                let url = payload.url().as_str().to_string();
                let Ok(navigation_id) = app
                    .state::<SessionBrowserManager>()
                    .finish_navigation(&resource_for_load, &url)
                else {
                    return;
                };
                // Native layout work waits for the main thread; never block the
                // WebKit load callback itself. Redirects re-resolve Auto mode.
                let lease = resource_for_load.clone();
                std::thread::spawn(move || {
                    let Ok(snapshot) = apply_session_browser_layout_for(
                        &app,
                        &session_id,
                        None,
                        None,
                        Some(&lease),
                    ) else {
                        return;
                    };
                    if !background_only
                        && app
                            .state::<SessionBrowserManager>()
                            .navigation_is_finished(&lease, navigation_id)
                    {
                        let _ = app.emit(
                            "session-browser-event",
                            serde_json::json!({
                                "sessionId": session_id, "kind": "loaded", "url": url,
                                "resourceId": lease.resource_id, "viewport": snapshot.viewport,
                            }),
                        );
                    }
                });
            }
        })
        .on_document_title_changed(move |_webview, title| {
            let manager = app_for_title.state::<SessionBrowserManager>();
            if manager
                .update_resource_state(&resource_for_title, None, Some(&title))
                .is_err()
            {
                return;
            }
            if !background_only {
                let _ = app_for_title.emit(
                    "session-browser-event",
                    serde_json::json!({
                        "sessionId": session_for_title,
                        "kind": "title",
                        "resourceId": resource_for_title.resource_id,
                        "title": sanitize_text(&title),
                    }),
                );
            }
        });
    if check_only {
        builder = builder
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .on_download(|_, _| false);
    }
    if background_only {
        // A hidden agent page must keep running during a long task.
        builder = builder
            .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled);
    }

    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(geometry.frame.x, geometry.frame.y),
            LogicalSize::new(geometry.frame.width, geometry.frame.height),
        )
        .map_err(|error| format!("could not create session browser webview: {error}"))?;

    #[cfg(target_os = "macos")]
    {
        let app = app.clone();
        let lease = resource_for_observer;
        let pending = PendingCall::new(
            AGENT_CALL_TIMEOUT,
            "browser navigation observer installation timed out",
        )?;
        let dispatch = pending.guard();
        let (sender, receiver) = mpsc::channel();
        webview.with_webview(move |platform| unsafe {
            use objc2_web_kit::WKWebView;
            let result = dispatch.check().and_then(|_| navigation_observer::attach(
                &*platform.inner().cast::<WKWebView>(),
                Box::new(move |view, token, event| {
                    let url=view.URL().and_then(|url|url.absoluteString()).map(|url|url.to_string());
                    let manager=app.state::<SessionBrowserManager>();
                    let Ok(Some((kind,navigation_id)))=manager.native_navigation_event(&lease,token,&event,url.as_deref()) else {return false;};
                    if kind=="loaded" {
                        let app=app.clone();
                        let lease=lease.clone();
                        std::thread::spawn(move || {
                            let Ok(snapshot)=apply_session_browser_layout_for(&app,&lease.session_id,None,None,Some(&lease)) else {return;};
                            if !background_only && app.state::<SessionBrowserManager>().navigation_is_finished(&lease,navigation_id) {
                                let _=app.emit("session-browser-event",serde_json::json!({"sessionId":lease.session_id,"resourceId":lease.resource_id,"kind":"loaded","viewport":snapshot.viewport}));
                            }
                        });
                    } else if !background_only {
                        let _=app.emit("session-browser-event",serde_json::json!({"sessionId":lease.session_id,"resourceId":lease.resource_id,"kind":kind}));
                    }
                    true
                }),
            ));
            let _=sender.send(result);
        }).map_err(|error|format!("could not queue browser navigation observer: {error}"))?;
        if let Err(error) = pending.wait(receiver).and_then(|result| result) {
            let _ = close_browser_webview(&webview);
            return Err(error);
        }
    }

    if let Err(error) = browser_viewport::apply(&webview, &geometry, None, None) {
        let _ = close_browser_webview(&webview);
        return Err(error);
    }

    // Child webviews are the unstable-path trigger that leaves native window
    // controls at (0, 0). Re-apply the overlay inset on the parent window.
    #[cfg(target_os = "macos")]
    if let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        crate::window_controls::apply_macos_traffic_light_position(&main);
    }

    if !visible {
        webview
            .hide()
            .map_err(|error| format!("could not hide browser: {error}"))?;
        reclaim_stranded_keyboard(app);
    } else if !background_only {
        // A child webview created visible becomes first responder, so a model
        // opening a page must not pull the keyboard out of the user's chat.
        restore_main_webview_focus(app);
    }

    let mut approved = HashSet::new();
    approved.insert(origin);

    let mut guard = manager
        .inner
        .lock()
        .map_err(|_| "session browser state is unavailable".to_string())?;
    guard.insert(
        session_id.clone(),
        SessionBrowserSlot {
            session_id: session_id.clone(),
            workspace_key: request.workspace_key.clone(),
            resource_id,
            webview_label: webview_label.clone(),
            bridge_nonce,
            url: url.to_string(),
            title: String::new(),
            loading: true,
            navigation_id: 1,
            document_committed: false,
            navigation_error: None,
            native_navigation_token: None,
            committed_url: None,
            failed_provisional: false,
            visible,
            background_only,
            host_bounds: bounds,
            viewport_request,
            viewport: geometry.state,
            approved_origins: approved,
            pointer_reference: None,
            console: VecDeque::new(),
            network: VecDeque::new(),
        },
    );
    let snapshot = guard
        .get(&session_id)
        .map(SessionBrowserManager::snapshot_locked)
        .expect("just inserted");
    drop(guard);
    // A very fast first page may commit before add_child/layout return and the
    // slot exists. Reconcile once without delaying Open or trusting about:blank.
    let probe_lease = BrowserDocumentLease {
        resource: BrowserLease::from_snapshot(&snapshot),
        navigation_id: snapshot.navigation_id,
    };
    let probe_app = app.clone();
    let _ = webview.eval_with_callback("({installed:!!window.__gyroBrowserAgent,url:location.href,title:document.title,readyState:document.readyState})",move|encoded| {
        let Ok(observed) = serde_json::from_str::<Value>(&encoded) else {return;};
        let manager = probe_app.state::<SessionBrowserManager>();
        if manager.reconcile_initial_document(&probe_lease,&observed) != Ok(true) {return;}
        let app = probe_app.clone();
        let lease = probe_lease.clone();
        std::thread::spawn(move|| {
            if lease.validate(&app.state::<SessionBrowserManager>()).is_err() {return;}
            let session = &lease.resource.session_id;
            let Ok(snapshot) = apply_session_browser_layout_for(&app,session,None,None,Some(&lease.resource)) else {return;};
            if lease.validate(&app.state::<SessionBrowserManager>()).is_ok() && !snapshot.background_only {
                let _ = app.emit("session-browser-event",serde_json::json!({"sessionId":session,"resourceId":snapshot.resource_id,"kind":if snapshot.loading {"loading"} else {"loaded"}}));
            }
        });
    });
    Ok(snapshot)
}

pub fn set_session_browser_bounds<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    bounds: SessionBrowserBounds,
) -> Result<(), String> {
    let manager = app.state::<SessionBrowserManager>();
    if manager.background_only(session_id)? {
        // No frontend host can resize or move an agent's independent viewport.
        return Ok(());
    }
    apply_session_browser_layout(app, session_id, Some(bounds), None)?;
    // Positioning is independent of visibility: only the mounted UI host may
    // reveal the child, after confirming its bounds report is still current.
    Ok(())
}

pub fn set_session_browser_visible<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    visible: bool,
) -> Result<(), String> {
    let manager = app.state::<SessionBrowserManager>();
    let visible = browser_visibility(manager.background_only(session_id)?, visible);
    let label = manager.webview_label_for(session_id)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser webview is not available".to_string())?;
    let was_visible = manager.visible_flag(session_id)?;
    if visible {
        webview
            .show()
            .map_err(|error| format!("could not show browser: {error}"))?;
    } else {
        webview
            .hide()
            .map_err(|error| format!("could not hide browser: {error}"))?;
    }
    manager.set_visible_flag(session_id, visible)?;
    if visibility_moves_keyboard_focus(was_visible, visible) {
        restore_main_webview_focus(app);
    }
    Ok(())
}

enum BrowserNavigationCommand {
    Navigate(url::Url),
    Reload,
}

fn dispatch_browser_navigation<R: Runtime>(
    app: &AppHandle<R>,
    webview: &tauri::Webview<R>,
    request: &BrowserNavigationRequest,
    command: BrowserNavigationCommand,
) -> Result<(), String> {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    let dispatched = Arc::new(AtomicBool::new(false));
    let did_dispatch = dispatched.clone();
    let result = (|| {
        let pending =
            PendingCall::new(AGENT_CALL_TIMEOUT, "browser navigation dispatch timed out")?;
        let dispatch = pending.guard();
        let action_view = webview.clone();
        let action_app = app.clone();
        let lease = request.resource.clone();
        let navigation_id = request.navigation_id;
        let (send, receive) = mpsc::channel();
        webview
            .with_webview(move |_| {
                let result = (|| {
                    dispatch.check()?;
                    action_app.state::<SessionBrowserManager>().with_resource_mut(&lease, |slot| {
                        if slot.navigation_id == navigation_id {
                            Ok(())
                        } else {
                            Err("browser navigation changed before dispatch; observe the current page before retrying".to_string())
                        }
                    })??;
                    dispatch.check()?;
                    did_dispatch.store(true, Ordering::Release);
                    // Tauri executes these synchronously on its main thread.
                    match command {
                        BrowserNavigationCommand::Navigate(url) => action_view.navigate(url),
                        BrowserNavigationCommand::Reload => action_view.reload(),
                    }
                    .map_err(|error| format!("could not dispatch browser navigation: {error}"))
                })();
                let _ = send.send(result);
            })
            .map_err(|error| format!("could not queue browser navigation: {error}"))?;
        pending.wait(receive)?
    })();
    if let Err(error) = &result {
        if !dispatched.load(Ordering::Acquire) {
            app.state::<SessionBrowserManager>()
                .restore_undispatched_navigation(request, operation_was_cancelled(error));
        }
    }
    result
}

pub fn navigate_session_browser<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    raw_url: &str,
) -> Result<SessionBrowserSnapshot, String> {
    let url = parse_navigable_url(raw_url)?;
    let manager = app.state::<SessionBrowserManager>();
    let label = manager.webview_label_for(session_id)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser webview is not available".to_string())?;
    let previous = manager
        .get_snapshot(session_id)?
        .ok_or("this chat has no open browser")?;
    let lease = BrowserLease::from_snapshot(&previous);
    let request = manager.reserve_navigation(&lease, Some(url.as_str()))?;
    dispatch_browser_navigation(
        app,
        &webview,
        &request,
        BrowserNavigationCommand::Navigate(url.clone()),
    )?;
    apply_session_browser_layout_for(app, session_id, None, None, Some(&lease))?;
    let _ = manager.approve_origin(session_id, &url.origin().ascii_serialization());
    manager
        .get_snapshot(session_id)?
        .ok_or_else(|| "browser disappeared during navigate".to_string())
}

pub fn reload_session_browser<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
) -> Result<SessionBrowserSnapshot, String> {
    let manager = app.state::<SessionBrowserManager>();
    let label = manager.webview_label_for(session_id)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser webview is not available".to_string())?;
    let previous = manager
        .get_snapshot(session_id)?
        .ok_or("this chat has no open browser")?;
    // A provisional failure leaves WKWebView on the previous document.
    // Reloading that view would silently reload the wrong URL.
    if previous.navigation_error.is_some() {
        return navigate_session_browser(app, session_id, &previous.url);
    }
    let lease = BrowserLease::from_snapshot(&previous);
    let request = manager.reserve_navigation(&lease, None)?;
    dispatch_browser_navigation(app, &webview, &request, BrowserNavigationCommand::Reload)?;
    manager
        .get_snapshot(session_id)?
        .ok_or_else(|| "browser disappeared during reload".to_string())
}

pub fn history_session_browser<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    direction: &str,
) -> Result<SessionBrowserSnapshot, String> {
    let delta = match direction {
        "back" => -1,
        "forward" => 1,
        _ => return Err("direction must be back or forward".into()),
    };
    let manager = app.state::<SessionBrowserManager>();
    let label = manager.webview_label_for(session_id)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser webview is not available".to_string())?;
    let (resource, previous) = manager.capture_resource(session_id)?;
    let lease = BrowserDocumentLease {
        resource,
        navigation_id: previous.navigation_id,
    };
    #[cfg(target_os = "macos")]
    {
        let pending = PendingCall::new(AGENT_CALL_TIMEOUT, "browser history action timed out")?;
        let dispatch = pending.guard();
        let history_app = app.clone();
        let (sender, receiver) = mpsc::channel();
        webview
            .with_webview(move |platform| unsafe {
                use objc2_web_kit::WKWebView;
                let manager = history_app.state::<SessionBrowserManager>();
                let result = (|| {
                    dispatch.check()?;
                    manager.with_resource_mut(&lease.resource, |slot| {
                        if slot.navigation_id==lease.navigation_id {Ok(())} else {Err("browser navigation changed before history action".to_string())}
                    })??;
                    let view: &WKWebView = &*platform.inner().cast();
                    if delta < 0 && manager.recover_provisional_document(&lease.resource,lease.navigation_id)? {
                        // Invalidate the failed/pending callback token first.
                        // Stopping WebKit can synchronously emit cancellation.
                        view.stopLoading();
                        let _=history_app.emit("session-browser-event",serde_json::json!({"sessionId":lease.resource.session_id,"resourceId":lease.resource.resource_id,"kind":"loaded"}));
                        return Ok(());
                    }
                    if !(if delta < 0 {
                        view.canGoBack()
                    } else {
                        view.canGoForward()
                    }) {
                        return Err("browser has no page in that history direction".to_string());
                    }
                    let navigation_id = manager.start_navigation(&lease.resource, None)?;
                    let navigation = if delta < 0 {
                        view.goBack()
                    } else {
                        view.goForward()
                    };
                    if navigation.is_none() {
                        manager.restore_navigation(&lease.resource, navigation_id, &previous);
                        return Err("browser did not start the history navigation".to_string());
                    }
                    Ok(())
                })();
                let _ = sender.send(result);
            })
            .map_err(|error| format!("could not queue browser history: {error}"))?;
        pending.wait(receiver)??;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let navigation_id = manager.start_navigation(&lease.resource, None)?;
        if let Err(error) = webview.eval(format!("window.history.go({delta});")) {
            manager.restore_navigation(&lease.resource, navigation_id, &previous);
            return Err(format!("could not move browser history: {error}"));
        }
    }
    manager
        .get_snapshot(session_id)?
        .ok_or_else(|| "browser disappeared during history navigation".to_string())
}

pub fn close_session_browser<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
) -> Result<(), String> {
    let manager = app.state::<SessionBrowserManager>();
    if let Some(slot) = manager.remove_slot(session_id)? {
        if let Some(webview) = app.get_webview(&slot.webview_label) {
            let _ = close_browser_webview(&webview);
        }
    }
    Ok(())
}

fn close_browser_webview<R: Runtime>(webview: &tauri::Webview<R>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let detached = webview
        .with_webview(|platform| unsafe {
            let view = &*platform.inner().cast::<objc2_web_kit::WKWebView>();
            navigation_observer::detach(view);
            browser_viewport::detach_native_container(view);
        })
        .map_err(|error| format!("could not detach native browser resources: {error}"));
    let closed = webview.close().map_err(|error| error.to_string());
    #[cfg(target_os = "macos")]
    detached?;
    closed
}

#[cfg(all(
    target_os = "macos",
    debug_assertions,
    feature = "native-browser-events-smoke"
))]
pub(crate) fn navigation_observer_counts() -> Value {
    navigation_observer::counts()
}

pub fn call_agent<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    method: &str,
    args: Value,
) -> Result<Value, String> {
    let manager = app.state::<SessionBrowserManager>();
    let (lease, snapshot) = manager.capture_document(session_id)?;
    call_agent_for(app, lease, snapshot, method, args)
}

fn call_agent_for<R: Runtime>(
    app: &AppHandle<R>,
    lease: BrowserDocumentLease,
    snapshot: SessionBrowserSnapshot,
    method: &str,
    args: Value,
) -> Result<Value, String> {
    let manager = app.state::<SessionBrowserManager>();
    let label = snapshot.label.clone();
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser webview is not available".to_string())?;

    // DOM tools are synchronous. Return their result through the native evaluator,
    // independent of the page's CSP, CORS, custom-scheme fetch, or patched fetch.
    let method_json = serde_json::to_string(method).map_err(|error| error.to_string())?;
    let args_json = serde_json::to_string(&args).map_err(|error| error.to_string())?;
    let script = format!(
        r#"(function() {{
  try {{
    const agent = window.__gyroBrowserAgent;
    if (!agent || typeof agent[{method_json}] !== "function") {{
      return {{ error: "browser agent is not ready" }};
    }}
    return {{ result: agent[{method_json}]({args_json}) }};
  }} catch (error) {{
    return {{ error: String(error && error.message || error) }};
  }}
}})();"#
    );
    let pending = PendingCall::new(AGENT_CALL_TIMEOUT, "browser agent call timed out")?;
    let dispatch = pending.guard();
    let (sender, receiver) = mpsc::channel();
    let evaluator = webview.clone();
    let dispatch_app = app.clone();
    let dispatch_lease = lease.clone();
    webview
        .run_on_main_thread(move || {
            if let Err(error) = dispatch.check().and_then(|_| {
                dispatch_lease.validate(&dispatch_app.state::<SessionBrowserManager>())
            }) {
                let _ = sender.send(Err(error));
                return;
            }
            let callback_sender = sender.clone();
            if let Err(error) = evaluator.eval_with_callback(script, move |result| {
                let _ = callback_sender.send(Ok(result));
            }) {
                let _ = sender.send(Err(format!("could not run browser agent: {error}")));
            }
        })
        .map_err(|error| format!("could not queue browser agent: {error}"))?;
    let encoded = pending.wait(receiver).and_then(|result| result);
    reclaim_stranded_keyboard(app);
    let encoded = encoded?;
    let response: Value = serde_json::from_str(&encoded)
        .map_err(|error| format!("invalid browser agent result: {error}"))?;
    if let Some(error) = response.get("error").and_then(Value::as_str) {
        return Err(sanitize_text(error));
    }
    let value = response
        .get("result")
        .cloned()
        .ok_or_else(|| "browser agent returned no result".to_string())?;
    if value.get("ok") == Some(&Value::Bool(false)) {
        return Err(sanitize_text(
            value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("browser action failed"),
        ));
    }
    let mut value = sanitize_agent_result(method, value)?;
    let navigation = manager.with_document_mut(&lease, |slot| {
        if let Some(url) = value.get("url").and_then(Value::as_str) {
            if slot.url != url {
                slot.pointer_reference = None;
            }
            slot.url = url.to_string();
            slot.committed_url = Some(url.to_string());
        }
        if let Some(title) = value.get("title").and_then(Value::as_str) {
            slot.title = title.to_string();
        }
        serde_json::json!({"id":slot.navigation_id,"loading":slot.loading,"documentCommitted":true})
    })?;
    if let Some(object) = value.as_object_mut() {
        object.insert("navigation".into(), navigation);
    }
    Ok(value)
}

pub fn mouse_session_browser<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    action: &str,
    x: f64,
    y: f64,
    to_x: f64,
    to_y: f64,
) -> Result<(), String> {
    if ![x, y, to_x, to_y].iter().all(|value| value.is_finite()) {
        return Err("browser pointer coordinates must be finite".into());
    }
    if !matches!(action, "hover" | "click" | "secondary-click" | "drag") {
        return Err("unsupported browser pointer action".into());
    }
    let manager = app.state::<SessionBrowserManager>();
    let (lease, snapshot) = manager.capture_document(session_id)?;
    if snapshot.background_only || !snapshot.visible {
        return call_agent_for(
            app,
            lease,
            snapshot,
            "backgroundPointer",
            serde_json::json!({
                "action": action, "x": x, "y": y, "toX": to_x, "toY": to_y,
            }),
        )
        .map(|_| ());
    }
    let label = manager.webview_label_for(session_id)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser webview is not available".to_string())?;

    #[cfg(target_os = "macos")]
    {
        // Mouse moves posted in one main-thread turn can be coalesced by
        // AppKit. Let the departure reach WebKit before entering the target,
        // including when the system cursor already rests over that target.
        let phases = if action == "hover" { 2 } else { 1 };
        for phase in 0..phases {
            let action = action.to_string();
            let lease = lease.clone();
            let pending = PendingCall::new(AGENT_CALL_TIMEOUT, "browser mouse action timed out")?;
            let dispatch = pending.guard();
            let dispatch_app = app.clone();
            let (sender, receiver) = mpsc::channel();
            webview
            .with_webview(move |platform| unsafe {
                use objc2_app_kit::{NSApplication, NSScreen, NSView};
                use objc2_core_graphics::{
                    CGEvent, CGEventTapLocation, CGEventType, CGMouseButton,
                };
                use objc2_foundation::NSPoint;
                use objc2_web_kit::WKWebView;

                let result = (|| -> Result<(), String> {
                    dispatch.check()?;
                    lease.validate(&dispatch_app.state::<SessionBrowserManager>())?;
                    let webview: &WKWebView = &*platform.inner().cast();
                    let view: &NSView = webview;
                    let window = view
                        .window()
                        .ok_or_else(|| "browser window is not available".to_string())?;
                    // System mouse input must never pull focus from another app.
                    let mtm = objc2::MainThreadMarker::new()
                        .ok_or_else(|| "browser mouse action left the main thread".to_string())?;
                    let native_app = NSApplication::sharedApplication(mtm);
                    if !native_app.isActive() || !window.isKeyWindow() {
                        return Err("Bring Gyro and this chat's Browser to the foreground before using the mouse".into());
                    }
                    window.setAcceptsMouseMovedEvents(true);
                    let bounds = view.bounds();
                    let width = bounds.size.width;
                    let height = bounds.size.height;
                    let point = |px: f64, py: f64| -> Result<NSPoint, String> {
                        let px = px * webview.pageZoom();
                        let py = py * webview.pageZoom();
                        if px < 0.0 || py < 0.0 || px >= width || py >= height {
                            return Err(
                                "pointer coordinates are outside the browser viewport".into()
                            );
                        }
                        let local_y = if view.isFlipped() {
                            bounds.origin.y + py
                        } else {
                            bounds.origin.y + height - py
                        };
                        Ok(view
                            .convertPoint_toView(NSPoint::new(bounds.origin.x + px, local_y), None))
                    };
                    let start = point(x, y)?;
                    let end = point(to_x, to_y)?;
                    if !objc2_core_graphics::CGPreflightPostEventAccess() {
                        return Err("Gyro needs macOS Accessibility permission to send browser mouse input".into());
                    }
                    let mtm = objc2::MainThreadMarker::new()
                        .ok_or_else(|| "browser mouse action left the main thread".to_string())?;
                    let main_screen = NSScreen::mainScreen(mtm)
                        .ok_or_else(|| "main display is unavailable".to_string())?;
                    let screen_height =
                        main_screen.frame().origin.y + main_screen.frame().size.height;
                    #[cfg(debug_assertions)]
                    if std::env::var_os("GYRO_BROWSER_SMOKE_URL").is_some() {
                        eprintln!(
                            "Native browser mouse: action={action}, phase={phase}, css=({x},{y}), zoom={}, view={bounds:?}, window={:?}, start={start:?}, screen={:?}, screen_height={screen_height}",
                            webview.pageZoom(), window.frame(), window.convertPointToScreen(start),
                        );
                    }
                    let send = |kind: CGEventType,
                                location: NSPoint,
                                button: CGMouseButton|
                     -> Result<(), String> {
                        let screen = window.convertPointToScreen(location);
                        let position = NSPoint::new(screen.x, screen_height - screen.y);
                        let event = CGEvent::new_mouse_event(None, kind, position, button)
                            .ok_or_else(|| "could not create browser mouse event".to_string())?;
                        CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
                        Ok(())
                    };
                    if action == "hover" && phase == 0 {
                        let outside = point(1.0, 1.0)?;
                        send(CGEventType::MouseMoved, outside, CGMouseButton::Left)?;
                        return Ok(());
                    }
                    send(CGEventType::MouseMoved, start, CGMouseButton::Left)?;
                    match action.as_str() {
                        "hover" => {}
                        "click" => {
                            send(CGEventType::LeftMouseDown, start, CGMouseButton::Left)?;
                            send(CGEventType::LeftMouseUp, start, CGMouseButton::Left)?;
                        }
                        "secondary-click" => {
                            send(CGEventType::RightMouseDown, start, CGMouseButton::Right)?;
                            send(CGEventType::RightMouseUp, start, CGMouseButton::Right)?;
                        }
                        "drag" => {
                            send(CGEventType::LeftMouseDown, start, CGMouseButton::Left)?;
                            for step in 1..=12 {
                                let progress = step as f64 / 12.0;
                                let location = NSPoint::new(
                                    start.x + (end.x - start.x) * progress,
                                    start.y + (end.y - start.y) * progress,
                                );
                                send(CGEventType::LeftMouseDragged, location, CGMouseButton::Left)?;
                            }
                            send(CGEventType::LeftMouseUp, end, CGMouseButton::Left)?;
                        }
                        _ => unreachable!(),
                    }
                    Ok(())
                })();
                let _ = sender.send(result);
            })
            .map_err(|error| format!("could not send browser mouse event: {error}"))?;
            pending.wait(receiver)??;
            if phase + 1 < phases {
                std::thread::sleep(Duration::from_millis(30));
            }
        }
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (webview, action, x, y, to_x, to_y);
        Err("browser mouse actions are currently available on macOS only".into())
    }
}

/// Decoration cleanup must remain possible after Stop without extending the
/// cancelled model's wait or dispatching another page action.
pub(crate) fn restore_pointer_feedback<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
) -> Result<(), String> {
    let label = app
        .state::<SessionBrowserManager>()
        .webview_label_for(session_id)?;
    let webview = app
        .get_webview(&label)
        .ok_or("browser webview is not available")?;
    webview
        .eval("window.__gyroBrowserAgent?.restorePointer();")
        .map_err(|error| format!("could not restore browser pointer feedback: {error}"))
}

fn sanitize_agent_result(method: &str, value: Value) -> Result<Value, String> {
    fn walk(value: Value) -> Value {
        match value {
            Value::String(text) => Value::String(sanitize_text(&text)),
            Value::Array(items) => Value::Array(items.into_iter().map(walk).collect()),
            Value::Object(map) => {
                let mut out = serde_json::Map::new();
                for (key, child) in map {
                    out.insert(key, walk(child));
                }
                Value::Object(out)
            }
            other => other,
        }
    }
    let check_values = if method == "checkRead" {
        value.get("values").cloned()
    } else {
        None
    };
    let sanitized = walk(value);
    // Filtering protects privacy, but its replacement text is not observed
    // evidence. Never let a redaction/truncation collision create a verdict.
    if method == "checkRead" && check_values.as_ref() != sanitized.get("values") {
        return Err("Browser evidence changed during privacy filtering; the original observed values cannot be verified".into());
    }
    let encoded = serde_json::to_vec(&sanitized).map_err(|error| error.to_string())?;
    if encoded.len() > gyro_core::MAX_CAPABILITY_RESULT_BYTES {
        return Err("browser agent result exceeded the capability size limit".into());
    }
    Ok(sanitized)
}

pub(crate) fn wait_for_screenshot_document<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
) -> Result<SessionBrowserSnapshot, String> {
    app.state::<SessionBrowserManager>()
        .wait_for_document(session_id)
}

pub fn capture_session_browser_png<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
) -> Result<SessionBrowserCapture, String> {
    let manager = app.state::<SessionBrowserManager>();
    let (lease, snapshot) = manager.capture_document(session_id)?;
    let label = snapshot.label.clone();
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser webview is not available".to_string())?;

    #[cfg(target_os = "macos")]
    {
        let pending = PendingCall::new(AGENT_CALL_TIMEOUT, "native browser screenshot timed out")?;
        let dispatch = pending.guard();
        let dispatch_app = app.clone();
        let (sender, receiver) = mpsc::channel();
        webview
            .with_webview(move |platform| unsafe {
                if let Err(error) = dispatch
                    .check()
                    .and_then(|_| lease.validate(&dispatch_app.state::<SessionBrowserManager>()))
                {
                    let _ = sender.send(Err(error));
                    return;
                }
                use block2::RcBlock;
                use objc2::runtime::AnyObject;
                use objc2_app_kit::{
                    NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSImage,
                };
                use objc2_foundation::{NSDictionary, NSError, NSNumber};
                use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

                let view: &WKWebView = &*platform.inner().cast();
                let completion = RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
                    let snapshot = (|| {
                        dispatch.check()?;
                        lease.validate(&dispatch_app.state::<SessionBrowserManager>())?;
                        let image = image.as_ref().ok_or_else(|| {
                            "native browser snapshot returned no image".to_string()
                        })?;
                        let tiff = image.TIFFRepresentation().ok_or_else(|| {
                            "native browser snapshot could not be encoded".to_string()
                        })?;
                        let bitmap =
                            NSBitmapImageRep::imageRepWithData(&tiff).ok_or_else(|| {
                                "native browser snapshot could not create a bitmap".to_string()
                            })?;
                        let properties =
                            NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::new();
                        let png = bitmap
                            .representationUsingType_properties(
                                NSBitmapImageFileType::PNG,
                                &properties,
                            )
                            .ok_or_else(|| {
                                "native browser snapshot could not create PNG data".to_string()
                            })?;
                        Ok::<SessionBrowserCapture, String>(SessionBrowserCapture {
                            png: png.to_vec(),
                            width: bitmap.pixelsWide().max(0) as u32,
                            height: bitmap.pixelsHigh().max(0) as u32,
                        })
                    })();
                    let _ = sender.send(snapshot);
                });
                // Request the unscaled CSS width, preserving desktop evidence
                // even while the person sees a fitted page in a narrow panel.
                let configuration = WKSnapshotConfiguration::new(
                    objc2::MainThreadMarker::new().expect("snapshot runs on the main thread"),
                );
                let width = view.bounds().size.width / view.pageZoom();
                configuration.setSnapshotWidth(Some(&NSNumber::new_f64(width)));
                view.takeSnapshotWithConfiguration_completionHandler(
                    Some(&configuration),
                    &completion,
                );
            })
            .map_err(|error| format!("could not request native browser snapshot: {error}"))?;

        let capture = pending.wait(receiver).and_then(|capture| capture);
        reclaim_stranded_keyboard(app);
        // The callback checks ownership before encoding; check once more before
        // handing image evidence to the caller.
        if capture.is_ok() {
            manager.with_document_mut(
                &BrowserDocumentLease {
                    resource: BrowserLease::from_snapshot(&snapshot),
                    navigation_id: snapshot.navigation_id,
                },
                |_| (),
            )?;
        }
        capture
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, session_id, webview);
        Err("browser screenshots are currently available on macOS only".into())
    }
}

// --- Tauri commands -------------------------------------------------------

#[tauri::command]
pub async fn session_browser_open(
    app: AppHandle,
    mut request: SessionBrowserOpenRequest,
) -> Result<SessionBrowserSnapshot, String> {
    let workbench_owner = is_workbench_browser_request(&request)?;
    if request.workspace_key.is_empty() && !workbench_owner {
        // Resolve the chat's workspace on a blocking worker: this is a SQLite
        // open plus a read, and it used to hold an async-runtime thread while
        // every other IPC call queued. Creating the webview stays on this task
        // so Tauri keeps its own main-thread hop.
        let session_id = request.session_id.clone();
        request.workspace_key = tauri::async_runtime::spawn_blocking(move || {
            let store = crate::stores::open_store()?;
            let session = store
                .get_session(crate::stores::parse_uuid(&session_id)?)
                .map_err(crate::stores::to_string)?
                .ok_or_else(|| "browser chat no longer exists".to_string())?;
            Ok::<String, String>(
                crate::providers::binding::session_execution_workspace(&session, store.paths())?
                    .display()
                    .to_string(),
            )
        })
        .await
        .map_err(|error| format!("browser workspace worker failed: {error}"))??;
    }
    if workbench_owner {
        open_browser_resource(&app, request, false, None)
    } else {
        open_session_browser(&app, request)
    }
}

#[tauri::command]
pub async fn session_browser_set_bounds(
    app: AppHandle,
    session_id: String,
    bounds: SessionBrowserBounds,
) -> Result<(), String> {
    set_session_browser_bounds(&app, &session_id, bounds)
}

#[tauri::command]
pub async fn session_browser_set_viewport(
    app: AppHandle,
    session_id: String,
    request: BrowserViewportRequest,
) -> Result<SessionBrowserSnapshot, String> {
    set_session_browser_viewport(&app, &session_id, request)
}

#[tauri::command]
pub async fn session_browser_set_visible(
    app: AppHandle,
    session_id: String,
    visible: bool,
) -> Result<(), String> {
    set_session_browser_visible(&app, &session_id, visible)
}

#[tauri::command]
pub async fn session_browser_navigate(
    app: AppHandle,
    session_id: String,
    url: String,
) -> Result<SessionBrowserSnapshot, String> {
    navigate_session_browser(&app, &session_id, &url)
}

#[tauri::command]
pub async fn session_browser_reload(
    app: AppHandle,
    session_id: String,
) -> Result<SessionBrowserSnapshot, String> {
    reload_session_browser(&app, &session_id)
}

#[tauri::command]
pub async fn session_browser_history(
    app: AppHandle,
    session_id: String,
    direction: String,
) -> Result<SessionBrowserSnapshot, String> {
    history_session_browser(&app, &session_id, &direction)
}

#[tauri::command]
pub async fn session_browser_close(app: AppHandle, session_id: String) -> Result<(), String> {
    close_session_browser(&app, &session_id)
}

#[tauri::command]
pub async fn session_browser_snapshot(
    app: AppHandle,
    session_id: String,
) -> Result<Option<SessionBrowserSnapshot>, String> {
    app.state::<SessionBrowserManager>()
        .get_snapshot(&session_id)
}

/// The element a browser interaction touched, as the page names it.
pub(crate) fn browser_action_target(result: &gyro_core::CapabilityResult) -> Option<String> {
    if !matches!(
        result.capability_id,
        gyro_core::CapabilityId::BrowserClick
            | gyro_core::CapabilityId::BrowserMouse
            | gyro_core::CapabilityId::BrowserType
            | gyro_core::CapabilityId::BrowserFormInput
    ) {
        return None;
    }
    let name = if result.capability_id == gyro_core::CapabilityId::BrowserMouse {
        result.data.pointer("/target/name")
    } else {
        result.data.pointer("/data/name")
    }?
    .as_str()?
    .trim();
    (!name.is_empty()).then(|| name.chars().take(80).collect())
}

#[cfg(test)]
#[path = "browser/session_tests.rs"]
mod tests;
