//! Shared provider execution limits.
use std::time::Duration;
pub const MAX_CHAT_MESSAGE_CHARS: usize = 24_000;

pub const MAX_CHAT_RESPONSE_CHARS: usize = 64_000;

pub const TEXT_TRUNCATION_SUFFIX: &str = "...";
pub const PROVIDER_CHAT_MAX_RUNTIME_SECS: u64 = 24 * 60 * 60;

pub const PROVIDER_CHAT_INACTIVITY_TIMEOUT_SECS: u64 = 30 * 60;

/// The phrase every stop message opens with.
///
/// A stop travels the rest of the way as an error string, and several places
/// have to tell one from a genuine failure. They match this rather than the
/// whole sentence so the sentence stays free to say what actually happened.
pub const PROVIDER_STOP_MARKER: &str = "chat cancelled by";

/// The stable phrase of a turn Gyro ended because the provider went silent.
pub const PROVIDER_STALL_MARKER: &str = "the provider sent nothing for";

pub const MAX_CHAT_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

pub const MAX_CHAT_RESPONSE_BYTES: usize = MAX_CHAT_RESPONSE_CHARS * 4 + 4;

// Codex app-server can legitimately return a multi-megabyte JSONL frame (for
// example, a completed item with rich tool output). Keep this aligned with the
// bounded queue budget: the aggregate protocol budget below still bounds a
// noisy or malicious child process.
pub const MAX_CODEX_APP_SERVER_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

// Preserve the former 64 MiB maximum of queued protocol frames even though an
// individual frame can now hold a large resumed thread or tool result.
pub const CODEX_APP_SERVER_CHANNEL_CAPACITY: usize = 4;

pub const MAX_CODEX_APP_SERVER_ACTIVITIES: usize = 256;

pub const MAX_CODEX_APP_SERVER_PATCHES: usize = 64;

pub const MAX_CODEX_APP_SERVER_PATCH_BYTES: usize = 256 * 1024;

pub const MAX_CODEX_APP_SERVER_PROTOCOL_MESSAGES: usize = 50_000;

pub const MAX_CODEX_APP_SERVER_PROTOCOL_BYTES: usize = 128 * 1024 * 1024;

pub const PROVIDER_STREAM_FLUSH_INTERVAL: Duration = Duration::from_millis(80);

/// The sentence a turn is closed with when Gyro exited while it was running.
///
/// Written by startup reconciliation rather than by the run itself, which by
/// definition never got to report anything. It doubles as the classifier for
/// the matching recovery hint, so it is matched exactly instead of by keyword:
/// the words in it ("running", "closed") are ordinary enough to appear in a
/// provider's own failure text.
pub const PROVIDER_INTERRUPTED_MARKER: &str =
    "Gyro closed while this turn was running, so it never finished.";
