//! Shared desktop resource limits and event names.

use std::time::Duration;
pub(crate) const MAX_WORKSPACE_FILE_PREVIEW_BYTES: usize = 256 * 1024;
pub(crate) const MAX_WORKSPACE_FILE_EDIT_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const MAX_TERMINAL_OUTPUT_BYTES: usize = 512 * 1024;
pub(crate) const MAX_TERMINAL_PROCESSES: usize = 32;
pub(crate) const MAX_DEBUG_ADAPTER_PROCESSES: usize = 8;
pub(crate) const MAX_CONCURRENT_IDE_COMMANDS: usize = 4;
pub(crate) const MAX_CONCURRENT_PROVIDER_RUNS: usize = 4;
pub(crate) const MAX_CONCURRENT_SCHEDULED_RUNS: usize = 2;
// The live transcript is not the stored message: it grows while the model
// writes, and only the finished message is persisted. Bounding it separately
// keeps a long answer from being cut mid-word while it streams, without
// widening what a session row holds.
pub(crate) const MAX_LIVE_RESPONSE_CHARS: usize = 256_000;
pub(crate) const MAX_PROVIDER_STDOUT_FRAME_BYTES: usize = 48 * 1024 * 1024;
pub(crate) const MAX_CHAT_IMAGES: usize = 10;
// Screen recordings routinely exceed 50 MB; videos reach providers as file
// references, so the cap only bounds local copies.
pub(crate) const MAX_CHAT_VIDEO_BYTES: u64 = 200 * 1024 * 1024;
pub(crate) const MAX_CHAT_VIDEOS: usize = 2;
pub(crate) const MAX_CHAT_ATTACHMENTS: usize = 16;
pub(crate) const MAX_CHAT_WORKSPACE_ATTACHMENT_BYTES: u64 = 32 * 1024 * 1024;
pub(crate) const MAX_CHAT_IDE_SNAPSHOT_BYTES: u64 = 128 * 1024;
pub(crate) const MAX_CHAT_ATTACHMENT_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
// A chat keeps its files for as long as its transcript points at them, so these
// limits last its whole life. Bytes are the budget. The file count only guards
// against runaway storage: it meets the byte budget at 256 KiB per file, about
// what stored attachments average, and full-size images hit the bytes long before.
pub(crate) const MAX_STORED_CHAT_ATTACHMENTS_PER_SESSION: usize = 4096;
pub(crate) const MAX_STORED_CHAT_ATTACHMENT_BYTES_PER_SESSION: u64 = 1024 * 1024 * 1024;
// Every unsent draft shares one folder, which gives up its least recently used
// files when full. This leaves room for four full messages across open drafts.
pub(crate) const MAX_STORED_DRAFT_ATTACHMENTS: usize = 64;
pub(crate) const MAX_BROWSER_PREVIEW_DIAGNOSTICS: usize = 8;
pub(crate) const MAX_BROWSER_PREVIEW_DIAGNOSTIC_CHARS: usize = 400;
pub(crate) const MAX_BROWSER_PREVIEW_DIAGNOSTIC_PAYLOAD_CHARS: usize = 8_000;
pub(crate) const BROWSER_PREVIEW_DIAGNOSTIC_TIMEOUT: Duration = Duration::from_secs(4);
pub(crate) const BROWSER_PREVIEW_CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) const MAX_BROWSER_PREVIEW_CAPTURE_BYTES: usize = 25 * 1024 * 1024;
pub(crate) const MAX_BROWSER_PREVIEW_CAPTURES: usize = 20;
pub(crate) const MAX_CONCURRENT_BROWSER_PREVIEWS: usize = 2;
pub(crate) const MAX_IDE_PROTOCOL_MESSAGES_PER_RESPONSE: usize = 32;
pub(crate) const MAX_IDE_PROTOCOL_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
/// Program output a DAP request keeps while it waits for its response. Events
/// never count toward MAX_IDE_PROTOCOL_MESSAGES_PER_RESPONSE; time bounds the rest.
pub(crate) const MAX_DAP_OUTPUT_EVENT_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_DESKTOP_IPC_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_PERMISSION_MCP_MESSAGE_BYTES: usize = 1024 * 1024;
pub(crate) const DESKTOP_IPC_WORKER_COUNT: usize = 16;
pub(crate) const DESKTOP_IPC_QUEUE_CAPACITY: usize = 64;
pub(crate) const DESKTOP_IPC_IO_TIMEOUT: Duration = Duration::from_secs(5);
pub(crate) const WORKSPACE_TREE_MAX_CACHE_AGE: Duration = Duration::from_secs(30);
pub(crate) const WORKSPACE_CHANGE_DEBOUNCE: Duration = Duration::from_millis(250);
pub(crate) const WORKSPACE_PREPARATION_CACHE_AGE: Duration = Duration::from_secs(2);
pub(crate) const WORKSPACE_PREPARATION_WAIT_TIMEOUT: Duration = Duration::from_secs(20);
pub(crate) const WORKSPACE_PREPARATION_GIT_TIMEOUT: Duration = Duration::from_secs(8);
/// `git status` prints nothing until it has walked the whole worktree, so a
/// large or iCloud-evicted checkout stays silent for minutes while it works.
/// The read is budgeted by wall clock alone; an inactivity timeout would only
/// ever cut a healthy read short.
pub(crate) const GIT_STATUS_TIMEOUT: Duration = Duration::from_secs(60);
pub(crate) const GIT_STATUS_PREPARATION_TIMEOUT: Duration = Duration::from_secs(6);
pub(crate) const MAX_GIT_STATUS_CACHES: usize = 32;
pub(crate) const MAX_WORKSPACE_WATCH_CACHES: usize = 8;
pub(crate) const MAX_WORKSPACE_PREPARATION_CACHES: usize = MAX_WORKSPACE_WATCH_CACHES;
pub(crate) const WORKSPACE_SEARCH_FALLBACK_TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) const MAX_WORKSPACE_SEARCH_FALLBACK_FILES: usize = 5_000;
pub(crate) const MAX_WORKSPACE_SEARCH_FALLBACK_BYTES: u64 = 64 * 1024 * 1024;
pub(crate) const MAX_DESKTOP_SESSION_EVENTS_READ: usize = 400;
/// Recent sessions read during shell warm-up, mirroring the page the sidebar
/// opens with so the warm read covers the rows the first list reuses.
pub(crate) const DESKTOP_SHELL_SESSION_PAGE: usize = 200;
pub(crate) const CODEX_USAGE_TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) const PROVIDER_CHAT_EVENT: &str = "gyro://provider-chat-event";
pub(crate) const PROVIDER_APPROVAL_EVENT: &str = "gyro://provider-approval-event";
pub(crate) const PROVIDER_CAPABILITY_EVENT: &str = "gyro://provider-capability-event";
pub(crate) const PROVIDER_CAPABILITY_RESOURCE_EVENT: &str = "gyro://provider-capability-resource";
pub(crate) const PROVIDER_APPROVAL_NOTIFICATION_OPEN_EVENT: &str =
    "gyro://provider-approval-notification-open";
/// A plan-usage reading every open window should adopt, whoever asked for it.
pub(crate) const PROVIDER_USAGE_UPDATED_EVENT: &str = "gyro://provider-usage-updated";
pub(crate) const WORKSPACE_PREPARATION_EVENT: &str = "gyro://workspace-preparation";
pub(crate) const WORKSPACE_CHANGED_EVENT: &str = "gyro://workspace-changed";
/// One create, rename/move or delete, with the path it moved to. The watcher
/// event above carries the resulting tree; this one tells open editors which
/// path became which, which a tree snapshot cannot reconstruct.
pub(crate) const WORKSPACE_PATHS_CHANGED_EVENT: &str = "gyro://workspace-paths-changed";
/// How often a live run reminds the desktop it is still working when the CLI is
/// quiet (long tools, thinking). The chat idle watchdog is five minutes; this
/// stays well under that so a silent but healthy process never looks finished.
pub(crate) const PROVIDER_CHAT_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);
pub(crate) const PROVIDER_APPROVAL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
pub(crate) const MAX_MODEL_TERMINAL_PROCESSES: usize = 4;

pub(crate) use gyro_core::provider_runtime::limits::{
    MAX_CHAT_RESPONSE_CHARS, TEXT_TRUNCATION_SUFFIX,
};

#[cfg(test)]
pub(crate) use gyro_core::provider_runtime::limits::MAX_CHAT_MESSAGE_CHARS;

pub(crate) use gyro_core::provider_runtime::limits::MAX_CHAT_IMAGE_BYTES;

pub(crate) use gyro_core::provider_runtime::limits::{
    MAX_CHAT_RESPONSE_BYTES, MAX_CODEX_APP_SERVER_ACTIVITIES, MAX_CODEX_APP_SERVER_PATCHES,
    MAX_CODEX_APP_SERVER_PATCH_BYTES, MAX_CODEX_APP_SERVER_PROTOCOL_BYTES,
    MAX_CODEX_APP_SERVER_PROTOCOL_MESSAGES, PROVIDER_STREAM_FLUSH_INTERVAL,
};

#[cfg(test)]
pub(crate) use gyro_core::provider_runtime::limits::MAX_CODEX_APP_SERVER_MESSAGE_BYTES;
